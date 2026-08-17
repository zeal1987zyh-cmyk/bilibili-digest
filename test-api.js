#!/usr/bin/env node
/**
 * DeepSeek API 独立诊断脚本（与扩展使用完全相同的请求格式）
 * 用途：隔离判断「扩展卡死」到底是 Key/网络问题，还是扩展代码问题。
 *
 * 用法：
 *   node test-api.js YOUR_API_KEY
 *   或
 *   DEEPSEEK_KEY=YOUR_API_KEY node test-api.js
 *
 * 不依赖任何 npm 包，Node 18+ 自带 fetch 即可运行。
 */

const API_KEY = process.argv[2] || process.env.DEEPSEEK_KEY;
const BASE_URL = process.env.DEEPSEEK_BASE || 'https://api.deepseek.com';
const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash';

if (!API_KEY) {
  console.error('❌ 请提供 API Key：');
  console.error('   node test-api.js sk-xxxxx');
  console.error('   或设置环境变量 DEEPSEEK_KEY=sk-xxxxx 后运行 node test-api.js');
  process.exit(1);
}

const SAMPLE_TRANSCRIPT = `[00:00] 大家好，今天我们来聊聊大语言模型的基本原理。
[00:30] 大语言模型本质上是一个概率模型，它根据前面的词预测下一个词。
[01:15] Transformer 架构是现在所有主流模型的基础，核心是自注意力机制。
[02:00] 训练分为预训练和微调两个阶段，预训练学习通用知识，微调适配具体任务。
[03:20] 推理时的 temperature 参数控制输出的随机性，越高越发散。
[04:10] 总结一下，理解 LLM 的关键是：概率预测、Transformer、两阶段训练。`;

async function testSimple() {
  console.log('\n=== 测试 1：基础连通性（极简请求）===');
  const t0 = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    const res = await fetch(BASE_URL + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + API_KEY },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'user', content: '请用一句话回复：连通性测试成功' }],
        max_tokens: 50
      }),
      signal: controller.signal
    });
    const text = await res.text();
    clearTimeout(timer);
    const dt = Date.now() - t0;
    console.log('HTTP 状态:', res.status, '| 耗时:', dt + 'ms');
    if (!res.ok) {
      console.error('❌ 请求失败，响应体：', text.slice(0, 500));
      return false;
    }
    const j = JSON.parse(text);
    const content = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    console.log('✅ 模型回复:', content);
    return true;
  } catch (e) {
    console.error('❌ 网络异常:', e.message);
    return false;
  }
}

async function testSummary() {
  console.log('\n=== 测试 2：概览生成（与扩展相同格式）===');
  const t0 = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  const systemPrompt = `你是一个视频内容分析助手。请基于用户提供的视频字幕逐字稿，生成结构化概览，返回严格 JSON 格式：
{
  "summary": "200字以内的视频整体摘要",
  "keyPoints": ["核心要点1", "核心要点2", "核心要点3"],
  "chapters": [{"start": 0, "end": 100, "title": "章节标题", "points": ["要点"]}],
  "quotes": [{"time": 30, "text": "金句内容"}]
}`;

  try {
    const res = await fetch(BASE_URL + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + API_KEY },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: '以下是视频的字幕逐字稿，请基于内容生成结构化概览：\n\n' + SAMPLE_TRANSCRIPT + '\n\n请严格按系统提示的格式返回 JSON。' }
        ],
        temperature: 0.4,
        max_tokens: 8000,
        response_format: { type: 'json_object' }
      }),
      signal: controller.signal
    });
    const text = await res.text();
    clearTimeout(timer);
    const dt = Date.now() - t0;
    console.log('HTTP 状态:', res.status, '| 耗时:', (dt / 1000).toFixed(1) + 's');
    if (!res.ok) {
      console.error('❌ 请求失败，响应体：', text.slice(0, 500));
      return false;
    }
    const j = JSON.parse(text);
    const content = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    console.log('✅ 概览 JSON 长度:', (content || '').length, '字');
    console.log('--- 概览预览（前 400 字）---');
    console.log((content || '').slice(0, 400));
    return true;
  } catch (e) {
    console.error('❌ 网络异常:', e.message);
    return false;
  }
}

async function testLongTranscript() {
  console.log('\n=== 测试 3：长文稿压力测试（模拟长视频，约 45000 字）===');
  const t0 = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 300000);
  const systemPrompt = `你是一个视频内容分析助手。请基于用户提供的视频字幕逐字稿，生成结构化概览，返回严格 JSON 格式：
{
  "summary": "200字以内的视频整体摘要",
  "keyPoints": ["核心要点1", "核心要点2", "核心要点3"],
  "chapters": [{"start": 0, "end": 100, "title": "章节标题", "points": ["要点"]}],
  "quotes": [{"time": 30, "text": "金句内容"}]
}`;

  // 构造一段约 45000 字的中文"伪逐字稿"（模拟 30~40 分钟视频）
  const base = '在这个章节中我们深入讨论了相关技术原理，结合实际案例说明其应用场景与边界条件，并对比了不同方案的优劣。';
  let longText = '';
  let i = 0;
  while (longText.length < 45000) {
    longText += '[' + String(Math.floor(i / 3) * 5).padStart(2, '0') + ':' + String((i % 3) * 20).padStart(2, '0') + '] ' + base + ' ';
    i++;
  }
  console.log('   构造文稿长度:', longText.length, '字符（估算 token 约', Math.ceil(longText.length * 1.5), '个）');

  try {
    const res = await fetch(BASE_URL + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + API_KEY },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: '以下是视频的字幕逐字稿，请基于内容生成结构化概览：\n\n' + longText + '\n\n请严格按系统提示的格式返回 JSON。' }
        ],
        temperature: 0.4,
        max_tokens: 8000,
        response_format: { type: 'json_object' }
      }),
      signal: controller.signal
    });
    const text = await res.text();
    clearTimeout(timer);
    const dt = Date.now() - t0;
    console.log('HTTP 状态:', res.status, '| 耗时:', (dt / 1000).toFixed(1) + 's');
    if (!res.ok) {
      console.error('❌ 请求失败，响应体：', text.slice(0, 500));
      if (res.status === 400 && text.includes('context')) {
        console.error('   → 确认是 context 窗口溢出！说明你的推测正确。');
      }
      return false;
    }
    console.log('✅ 长文稿也能正常生成，耗时', (dt / 1000).toFixed(1) + 's（未超时）');
    return true;
  } catch (e) {
    clearTimeout(timer);
    const dt = Date.now() - t0;
    if (e.name === 'AbortError') {
      console.error('❌ 超时（' + (dt / 1000).toFixed(1) + 's）！长文稿生成太慢，超过 300s 上限。');
      console.error('   → 这印证了"生成时间太长"的推测，需增大超时或缩减输入。');
    } else {
      console.error('❌ 网络异常:', e.message);
    }
    return false;
  }
}

async function testStream() {
  console.log('\n=== 测试 4：流式响应（stream:true + JSON 模式）===');
  const t0 = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    const res = await fetch(BASE_URL + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + API_KEY },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: '你是助手。请返回严格 JSON：{"ok": true, "msg": "流式测试"}' },
          { role: 'user', content: '返回 JSON' }
        ],
        temperature: 0.3,
        max_tokens: 200,
        stream: true,
        response_format: { type: 'json_object' }
      }),
      signal: controller.signal
    });
    if (!res.ok) {
      const t = await res.text();
      clearTimeout(timer);
      console.error('❌ 流式请求失败 HTTP', res.status, '：', t.slice(0, 300));
      return false;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '', full = '', chunks = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const s = line.trim();
        if (!s.startsWith('data:')) continue;
        const data = s.slice(5).trim();
        if (data === '[DONE]') continue;
        try {
          const j = JSON.parse(data);
          const d = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
          if (d) { full += d; chunks++; }
        } catch (_) {}
      }
    }
    clearTimeout(timer);
    const dt = (Date.now() - t0) / 1000;
    console.log('✅ 流式成功：', chunks, '个数据块，拼接后', full.length, '字，耗时', dt.toFixed(1) + 's');
    console.log('   拼接预览：', full.slice(0, 200));
    return chunks > 0;
  } catch (e) {
    clearTimeout(timer);
    console.error('❌ 流式异常:', e.message);
    return false;
  }
}

(async () => {
  console.log('DeepSeek API 诊断');
  console.log('Base URL:', BASE_URL);
  console.log('Model:', MODEL);
  console.log('Key 前缀:', API_KEY.slice(0, 7) + '…');

  const ok1 = await testSimple();
  if (!ok1) {
    console.error('\n❌ 基础连通性失败，无需继续。请检查：');
    console.error('   1. API Key 是否正确（以 sk- 开头）');
    console.error('   2. 账户是否有余额（DeepSeek 平台查看）');
    console.error('   3. 网络是否能访问 api.deepseek.com（代理/防火墙）');
    process.exit(1);
  }

  const ok2 = await testSummary();
  if (!ok2) {
    console.error('\n❌ 概览生成失败，但基础连通正常。可能是请求体过大或模型限制。');
    process.exit(1);
  }

  const ok3 = await testLongTranscript();
  const ok4 = await testStream();

  console.log('\n=== 诊断结论 ===');
  if (ok3 && ok4) {
    console.log('✅ 短/长文稿、流式均通过。你的 Key、账户、网络、context 窗口都正常。');
    console.log('   若扩展内仍卡死，问题在扩展代码层，请把控制台日志或诊断面板截图发我。');
  } else {
    if (!ok3) console.log('⚠️  长文稿测试失败（见上方说明）。');
    if (!ok4) console.log('⚠️  流式测试失败 → 扩展将改用非流式请求（仍能工作，只是无逐字进度）。');
  }
})();

