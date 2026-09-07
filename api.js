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

  // 首帧超时（TTFB）：服务端若迟迟不吐首 token，多数网关会在 60s 切断连接导致拿到空响应。
  // 这里主动在 firstTokenTimeout 秒时中断，交给上层重试/降级，避免白等一场。
  const firstTokenTimeout = Number(opts.firstTokenTimeout) || 0;

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
        if (firstTokenTimeout) onLog('首帧保护：若 ' + firstTokenTimeout + 's 内无内容将自动中断重试');
        return await readSSE(resp, onChunk, onLog, {
          firstTokenTimeout: firstTokenTimeout,
          controller: controller
        });
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
    if (r.rescuedFromReasoning) {
      onLog('ℹ️ 正文为空但检测到思维链，已从思考过程中抢救出答案（' + r.text.length + ' 字）', 'warn');
    } else if (!r.text && r.usage && Number(r.usage.completion_tokens) > 0) {
      // 0 字但服务端的确产生了 token：内容在流里但没落到 content 字段
      onLog('⚠️ 服务端已产生 ' + r.usage.completion_tokens + ' 个输出 token，正文却为 0 字' +
        (r.reasoningLen ? ('（思维链 ' + r.reasoningLen + ' 字，输出额度被思考过程占满）') : ''), 'warn');
    }
    return {
      text: r.text, httpStatus: 200, model: effectiveModel, elapsedMs: Date.now() - t0,
      usage: r.usage || null, rawSample: r.rawSample || '',
      reasoningLen: r.reasoningLen || 0, reasoningSample: r.reasoningSample || '',
      rescuedFromReasoning: !!r.rescuedFromReasoning
    };
  } catch (e) {
    if (e.name === 'AbortError') {
      throw new Error('请求超时（' + timeoutSec + '秒），DeepSeek 未在限定时间内返回，请缩短视频或检查网络');
    }
    // 首帧超时：服务端迟迟不输出内容，中继（非流式）大概率同样卡住，
    // 直接上抛交由上层重试/降级，避免再白等一轮。
    if (e && e.isFirstTokenTimeout) throw e;
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

/* ---- 从一帧 JSON 里取正文 ----------------------------------------
 * 不同模型/网关的字段命名差异很大，这里做最大兼容：
 *   - OpenAI/DeepSeek 标准： choices[].delta.content / choices[].message.content
 *   - 推理类模型：          choices[].delta.reasoning_content（思维链，不算正文）
 *   - 部分中转/兼容层：      choices[].text、顶层 content/text/response/output_text/answer
 * 返回 { content, reasoning }
 * ---------------------------------------------------------------- */
function pickContent(j) {
  if (!j || typeof j !== 'object') return { content: '', reasoning: '' };
  const cArr = Array.isArray(j.choices) ? j.choices : null;
  const c0 = cArr && cArr[0];
  if (c0) {
    const d = c0.delta || {};
    const m = c0.message || {};
    const content = d.content || m.content || c0.text || d.text || c0.content || '';
    const reason = d.reasoning_content || m.reasoning_content || c0.reasoning_content || '';
    if (content || reason) return { content: String(content || ''), reasoning: String(reason || '') };
  }
  // 没有 choices 结构的兼容层
  const flat = j.content || j.text || j.response || j.output_text || j.answer || j.data || '';
  if (flat && typeof flat === 'string') return { content: flat, reasoning: '' };
  return { content: '', reasoning: '' };
}

/* ---- 从思维链里抢救正文 ------------------------------------------
 * 适用场景：带 reasoning_content 的模型，输出额度被思考过程占满，
 *   导致 delta.content 始终为 null、正文 0 字（finish_reason=length）。
 *   此时思维链末尾往往已经写出了接近成形的答案，这里尝试捞出最后一个完整 JSON。
 * 返回提取到的 JSON 字符串，找不到则返回 ''。
 * ---------------------------------------------------------------- */
function extractLastJson(text) {
  if (!text || typeof text !== 'string') return '';
  let best = '';
  let bestEnd = -1;
  // 逐个 '{' 起点做括号配对，凡是能 JSON.parse 成功的都算候选；
  // 取「结束位置最靠后」的那个——既能跳过残缺片段，也不会被嵌套的内层小对象抢先。
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    let depth = 0;
    let end = -1;
    for (let k = i; k < text.length; k++) {
      const ch = text[k];
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) { end = k; break; }
      }
    }
    if (end <= i) continue;
    const cand = text.slice(i, end + 1);
    try {
      const j = JSON.parse(cand);
      if (j && typeof j === 'object' && !Array.isArray(j) && end > bestEnd) {
        best = cand;
        bestEnd = end;
      }
    } catch (e) { /* 不是合法 JSON，跳过 */ }
  }
  return best;
}

/* ---- 解析 SSE 流，逐块回调 onChunk(fullText, chunkCount)，并捕获 usage ----
 * opts.firstTokenTimeout: 秒。若这么久还没收到第一个内容帧，主动中断（抛错），
 *   交由上层重试或降级。用于规避网关 60s 无数据切断导致的"HTTP 200 但 0 字"。
 * opts.controller: AbortController，供首帧超时时中断底层连接。
 */
async function readSSE(resp, onChunk, onLog, opts = {}) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  const firstTokenTimeout = Number(opts.firstTokenTimeout) || 0;
  const controller = opts.controller || null;
  let buffer = '';
  let full = '';
  let chunkCount = 0;
  let usage = null;
  let raw = '';        // 原始响应采样（用于 0 字时定位真实格式）
  let reasoning = '';  // 推理模型的思维链（不作为正文）

  // 带首帧超时的 read：仅在还没收到任何内容时启用
  async function readOnce() {
    if (!firstTokenTimeout || full.length > 0) return reader.read();
    let timer = null;
    const guard = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error('首帧超时：' + firstTokenTimeout + 's 内未收到任何内容');
        err.isFirstTokenTimeout = true;
        if (controller) { try { controller.abort(err); } catch (e) {} }
        reject(err);
      }, firstTokenTimeout * 1000);
    });
    try {
      return await Promise.race([reader.read(), guard]);
    } finally {
      clearTimeout(timer);
    }
  }

  while (true) {
    const { done, value } = await readOnce();
    if (done) break;
    const decoded = decoder.decode(value, { stream: true });
    if (raw.length < 4000) raw += decoded; // 只留前 4000 字符，避免占内存
    buffer += decoded;
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
        const picked = pickContent(j);
        if (picked.content) {
          full += picked.content;
          chunkCount++;
          onChunk(full, chunkCount);
        }
        if (picked.reasoning) reasoning += picked.reasoning;
      } catch (_) { /* 忽略心跳帧 / 不完整的 JSON 帧 */ }
    }
  }
  // 兜底：某些网关/中转忽略 stream 参数，直接返回完整 JSON（无 data: 前缀）。
  // 此时上面的 SSE 解析拿不到任何 content，full 为空，这里尝试整块解析以兼容。
  if (!full && buffer.trim()) {
    try {
      const j = JSON.parse(buffer.trim());
      const picked = pickContent(j);
      full = picked.content || '';
      if (!reasoning) reasoning = picked.reasoning || '';
      if (j && j.usage) usage = j.usage;
    } catch (_) { /* 保持原样，交由上层报错 */ }
  }
  // 兜底：正文为空但思维链很长 → 说明输出额度被思考过程占满，
  // 尝试从思维链末尾抢救出已经成形的 JSON 答案，避免整轮白跑。
  let rescued = false;
  if (!full && reasoning.length > 100) {
    const ex = extractLastJson(reasoning);
    if (ex) { full = ex; rescued = true; }
  }

  // 0 字时把原始响应采样带出去，便于定位是"模型没输出"还是"我们没解析对"
  return {
    text: full,
    usage: usage,
    rawSample: full ? '' : (raw || buffer || '').slice(0, 1200),
    reasoningLen: reasoning.length,
    reasoningSample: rescued ? '' : reasoning.slice(-400), // 抢救失败时留尾部便于排查
    rescuedFromReasoning: rescued
  };
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
