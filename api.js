// api.js — DeepSeek（及兼容 OpenAI 接口）调用封装
// 策略：
//   1. 优先从侧边栏页面「直连 + 流式(SSE)」DeepSeek（扩展页面有 host_permissions）
//   2. 直连网络异常时降级为 background service worker 中继（非流式）
// 全程通过 onLog / onChunk / onHttp 回调上报状态，供前端「请求诊断面板」实时展示。
// 返回结构：{ text, httpStatus, model, elapsedMs, usage?, viaRelay? }
//   usage = DeepSeek 响应里的 token 统计 { prompt_tokens, completion_tokens, total_tokens, prompt_tokens_details? }

async function callDeepSeek(messages, opts = {}) {
  const s = await DigestSettings.get();
  if (!s.apiKey) {
    throw new Error('尚未配置 API Key，请点击右上角齿轮进入设置完成配置');
  }
  const base = String(s.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '');
  const url = base + '/chat/completions';
  const timeoutSec = opts.timeout || 120;
  const maxTokens = opts.maxTokens || Number(s.maxTokens) || 4000;

  // 模型名兜底：deepseek-chat / deepseek-reasoner 已于 2026-07-24 退役
  const RETIRED = ['deepseek-chat', 'deepseek-reasoner'];
  const effectiveModel = RETIRED.includes(s.model) ? 'deepseek-v4-flash' : (s.model || 'deepseek-v4-flash');

  const onLog = typeof opts.onLog === 'function' ? opts.onLog : () => {};
  const onChunk = typeof opts.onChunk === 'function' ? opts.onChunk : () => {};
  const onHttp = typeof opts.onHttp === 'function' ? opts.onHttp : () => {};

  const useStream = opts.stream !== false; // 默认开启流式以展示进度

  const baseBody = {
    model: effectiveModel,
    messages: messages,
    temperature: (opts.temperature !== undefined) ? opts.temperature : Number(s.temperature || 0.5),
    max_tokens: maxTokens
  };
  if (opts.response_format) baseBody.response_format = opts.response_format;

  // 流式请求额外带上 include_usage，便于拿到真实 token 用量来估算费用
  const reqBodyStream = JSON.stringify(Object.assign({ stream: true, stream_options: { include_usage: true } }, baseBody));
  const reqBodyNoStream = JSON.stringify(Object.assign({ stream: false }, baseBody));

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer ' + s.apiKey
  };

  const t0 = Date.now();
  const elapsed = () => ((Date.now() - t0) / 1000).toFixed(1);

  onLog('准备请求 · 模型 ' + effectiveModel + ' · 超时 ' + timeoutSec + 's');

  /* ---- 直连（流式优先）---- */
  async function directFetch() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutSec * 1000);
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: headers,
        body: reqBodyStream,
        signal: controller.signal
      });
      onHttp(resp.status);
      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        throw new Error('DeepSeek 返回 HTTP ' + resp.status + (errText ? '：' + errText.slice(0, 200) : ''));
      }
      if (useStream && resp.body) {
        onLog('已收到响应（HTTP ' + resp.status + '），开始接收流式内容…');
        return await readSSE(resp, onChunk, onLog);
      }
      const text = await resp.text();
      onChunk(text, 1);
      return { text: text, usage: null };
    } finally {
      clearTimeout(timer);
    }
  }

  /* ---- 后台中继（兜底，非流式）---- */
  async function relayFetch() {
    onLog('直连失败，尝试后台 service worker 中继…');
    const r = await chrome.runtime.sendMessage({
      type: 'digest:ai-request',
      url: url,
      headers: headers,
      body: reqBodyNoStream,
      timeout: timeoutSec
    });
    if (!r || !r.ok) {
      throw new Error((r && r.error) || ('中继失败 HTTP ' + (r && r.status)));
    }
    onHttp(r.status);
    onChunk(r.text, 1);
    return { text: r.text, usage: r.usage || null };
  }

  try {
    onLog('正在发送请求到 DeepSeek（直连）…');
    const r = await directFetch();
    onLog('✅ DeepSeek 处理完成，返回 ' + r.text.length + ' 字，耗时 ' + elapsed() + 's');
    return { text: r.text, httpStatus: 200, model: effectiveModel, elapsedMs: Date.now() - t0, usage: r.usage || null };
  } catch (e) {
    if (e.name === 'AbortError') {
      throw new Error('请求超时（' + timeoutSec + '秒），DeepSeek 未在限定时间内返回，请缩短视频或检查网络');
    }
    onLog('⚠️ 直连异常：' + e.message);
    // 仅网络错误才降级中继；HTTP 错误（Key 无效/余额不足等）直接抛出
    if (e.message && e.message.indexOf('HTTP ') === 0) throw e;
    try {
      const r = await relayFetch();
      onLog('✅ 中继成功，返回 ' + r.text.length + ' 字，耗时 ' + elapsed() + 's');
      return { text: r.text, httpStatus: 200, model: effectiveModel, elapsedMs: Date.now() - t0, usage: r.usage || null, viaRelay: true };
    } catch (e2) {
      throw new Error('DeepSeek 请求失败：' + (e2 && e2.message ? e2.message : e2));
    }
  }
}

/* ---- 解析 SSE 流，逐块回调 onChunk(fullText, chunkCount)，并捕获 usage ---- */
async function readSSE(resp, onChunk, onLog) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  let chunkCount = 0;
  let usage = null;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      const sv = line.trim();
      if (!sv.startsWith('data:')) continue;
      const data = sv.slice(5).trim();
      if (data === '[DONE]') continue;
      try {
        const j = JSON.parse(data);
        if (j.usage) usage = j.usage; // 末帧带 usage（stream_options.include_usage=true）
        const delta = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
        if (delta) {
          full += delta;
          chunkCount++;
          onChunk(full, chunkCount);
        }
      } catch (_) { /* 忽略心跳帧 / 不完整的 JSON 帧 */ }
    }
  }
  return { text: full, usage: usage };
}

/* =========================================================
 * DigestCost — DeepSeek V4 峰谷定价费用估算
 * 单价单位：元 / 百万 tokens
 * 高峰时段：北京时间 9:00-12:00、14:00-18:00；其余为空闲时段（价格减半）
 * 生效时间：2026-08-17 00:00（北京时间）。价格若调整，改这里即可。
 * ========================================================= */
const DigestCost = (function () {
  const PRICES = {
    'deepseek-v4-flash': {
      peak:    { cacheHitInput: 0.10, cacheMissInput: 3.00, output: 9.00 },
      offpeak: { cacheHitInput: 0.05, cacheMissInput: 1.50, output: 4.50 }
    },
    'deepseek-v4-pro': {
      peak:    { cacheHitInput: 0.30, cacheMissInput: 9.00, output: 27.00 },
      offpeak: { cacheHitInput: 0.15, cacheMissInput: 4.50, output: 13.50 }
    }
  };

  // 是否处于高峰时段（按 Asia/Shanghai 时间判定，不受本机时区影响）
  function isPeak() {
    const parts = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false
    }).formatToParts(new Date());
    const h = Number((parts.find((p) => p.type === 'hour') || {}).value);
    const m = Number((parts.find((p) => p.type === 'minute') || {}).value);
    const mins = h * 60 + m;
    const morning = mins >= 540 && mins < 720;    // 9:00-12:00
    const afternoon = mins >= 840 && mins < 1080; // 14:00-18:00
    return morning || afternoon;
  }

  function modelKey(model) {
    return /pro/i.test(model || '') ? 'deepseek-v4-pro' : 'deepseek-v4-flash';
  }

  // usage：{ prompt_tokens, completion_tokens, total_tokens, prompt_tokens_details? }
  function compute(usage, model) {
    if (!usage) return null;
    const key = modelKey(model);
    const tier = isPeak() ? PRICES[key].peak : PRICES[key].offpeak;
    const prompt = Number(usage.prompt_tokens) || 0;
    const completion = Number(usage.completion_tokens) || 0;
    const cached = Number(usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens) || 0;
    const miss = Math.max(0, prompt - cached);

    const inputCost = (cached * tier.cacheHitInput + miss * tier.cacheMissInput) / 1e6;
    const outputCost = completion * tier.output / 1e6;
    return {
      model: key,
      modelLabel: key === 'deepseek-v4-pro' ? 'DeepSeek V4 Pro' : 'DeepSeek V4 Flash',
      period: isPeak() ? '高峰' : '空闲',
      rates: tier,
      promptTokens: prompt,
      completionTokens: completion,
      cachedTokens: cached,
      inputCost: inputCost,
      outputCost: outputCost,
      total: inputCost + outputCost
    };
  }

  // 金额格式化：最多 6 位小数，去掉末尾多余的 0，保证极小金额也看得清
  function money(n) {
    if (!n || n <= 0) return '¥0.0000';
    let s = n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '.0000');
    return '¥' + s;
  }

  return { PRICES: PRICES, isPeak: isPeak, modelKey: modelKey, compute: compute, money: money };
})();
