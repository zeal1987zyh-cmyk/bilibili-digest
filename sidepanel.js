// sidepanel.js — 侧边栏主逻辑
// 功能：视频信息展示 / 字幕文稿 / AI 概览 / 时间戳笔记 / 双语对照 / 选中解释

(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);

  const EXT_VERSION = (chrome.runtime.getManifest && chrome.runtime.getManifest().version) || '?';
  (function showVersion() {
    const fill = () => {
      const vEl = document.getElementById('ext-version');
      if (vEl) vEl.textContent = 'v' + EXT_VERSION;
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fill);
    else fill();
  })();

  const state = {
    tab: null,            // 当前浏览器标签
    video: null,          // 视频信息
    subtitle: null,       // 字幕信息 {lan, lanDoc, ai, body[]}
    segments: [],         // 文稿分段 [{start, text}]
    translations: {},     // 分段译文缓存 {index: text}
    viewMode: 'original', // original | bilingual | zh
    overview: null,       // AI 概览结果
    translating: false,
    translateAbort: false,
    notes: [],            // [{id, time, text, raw, createdAt}]
    isZh: false           // 字幕本身是否为中文
  };

  /* ---------- 工具 ---------- */

  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const mm = String(m).padStart(2, '0');
    const ss = String(s).padStart(2, '0');
    return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  }

  let toastTimer = null;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 2600);
  }

  function setStatus(text, kind) {
    const bar = $('#status-bar');
    if (!text) { bar.classList.add('hidden'); return; }
    bar.classList.remove('hidden', 'busy', 'done', 'err');
    if (kind) bar.classList.add(kind);
    bar.querySelector('.status-text').textContent = text;
  }

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  /* ---------- 与内容脚本通信 ---------- */

  function sendToPage(type, payload) {
    return chrome.tabs.sendMessage(state.tab.id, Object.assign({ type: type }, payload || {}));
  }

  /* ---------- 数据加载 ---------- */

  async function loadData() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    state.tab = tab;
    const url = tab && tab.url ? tab.url : '';
    if (!/^https?:\/\/(www\.)?bilibili\.com\/video\//.test(url)) {
      showState('empty');
      return;
    }
    showState('loading');
    $('#loading-text').textContent = '正在读取视频信息…';
    try {
      const res = await sendToPage('digest:get-data');
      if (!res || !res.ok) throw new Error((res && res.error) || '获取视频数据失败');
      state.video = res.video;
      state.subtitle = res.subtitle || null;
      state.diag = res.diag || null;
      state.isZh = !!(state.subtitle && state.subtitle.lan && (state.subtitle.lan.startsWith('zh') || state.subtitle.lan === 'ai-zh'));
      buildSegments();
      renderVideoCard();
      renderTranscript();
      renderNotes();
      showState('view');
      await loadCachedOverview();
      updateNoteBadge();
      if (state.subtitle && state.subtitle.error) {
        toast('字幕获取失败：' + state.subtitle.error);
      }
    } catch (e) {
      showError(e.message);
    }
  }

  function showState(name) {
    $('#empty-state').classList.toggle('hidden', name !== 'empty');
    $('#loading-state').classList.toggle('hidden', name !== 'loading');
    $('#error-state').classList.toggle('hidden', name !== 'error');
    $('#video-view').classList.toggle('hidden', name !== 'view');
  }

  function showError(msg) {
    $('#error-text').textContent = msg || '加载失败';
    showState('error');
  }

  function buildSegments() {
    state.segments = [];
    if (!state.subtitle || !state.subtitle.body || !state.subtitle.body.length) return;
    const body = state.subtitle.body;
    for (let i = 0; i < body.length; i += 3) {
      const chunk = body.slice(i, i + 3);
      state.segments.push({ start: chunk[0].from, text: chunk.map((c) => c.content).join(' ') });
    }
  }

  function renderVideoCard() {
    $('#video-title').textContent = state.video.title || '';
    $('#video-up').textContent = state.video.up ? ('UP 主：' + state.video.up) : '';
    const thumb = $('#video-thumb');
    if (state.video.pic) thumb.src = state.video.pic.replace(/^\/\//, 'https://');
    const lang = $('#video-lang');
    if (state.subtitle) {
      if (state.subtitle.error) {
        lang.textContent = '字幕获取失败';
      } else {
        lang.textContent = (state.subtitle.ai ? 'AI 字幕' : '字幕') + ' · ' + (state.subtitle.lanDoc || state.subtitle.lan || '未知语言');
      }
      lang.classList.remove('hidden');
    } else {
      lang.classList.add('hidden');
    }
  }

  /* ---------- 标签页切换 ---------- */

  function bindTabs() {
    document.querySelectorAll('.tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b === btn));
        document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + btn.dataset.tab));
      });
    });
  }

  /* ---------- 文稿 ---------- */

  function renderTranscript() {
    const body = $('#transcript-body');
    body.innerHTML = '';
    if (!state.subtitle) {
      const empty = el('div', 'transcript-empty',
        '该视频没有可获取的字幕（UP 主未开启字幕，或 B 站未生成 AI 字幕）。\n没关系——你可以用「本地语音转写」把视频声音转成文字，全程在本地完成、不上传音频。');
      const btn = el('button', 'btn primary', '🎙 本地语音转写（无需字幕）');
      btn.addEventListener('click', startTranscribe);
      empty.appendChild(btn);
      body.appendChild(empty);
      $('#btn-translate').disabled = true;
      $('#btn-export-transcript').disabled = true;
      return;
    }
    if (state.subtitle.error) {
      const wrap = el('div', 'transcript-empty');
      const title = el('p', '', '字幕获取失败');
      const detail = el('p', 'sub-error', state.subtitle.error);
      detail.style.marginTop = '8px';
      detail.style.fontSize = '13px';
      detail.style.lineHeight = '1.6';
      detail.style.opacity = '0.85';
      wrap.appendChild(title);
      wrap.appendChild(detail);

      // 诊断信息（便于排查）
      if (state.diag) {
        const diagText = [
          '页面内嵌字幕数: ' + state.diag.pageSubtitles,
          '播放器实时抓取数: ' + state.diag.captured,
          'CC 触发结果: ' + state.diag.ccAction,
          (state.diag.ccBtnClass ? ('CC 按钮类名: ' + state.diag.ccBtnClass) : 'CC 按钮类名: (未找到)'),
          'API 直连: ' + (state.diag.apiTry
            ? (state.diag.apiTry.ok
                ? ('成功 ' + (state.diag.apiTry.got || 0) + ' 条')
                : ('失败(' + (state.diag.apiTry.stage || ('code ' + state.diag.apiTry.code)) +
                    (state.diag.apiTry.count ? (' / 列表' + state.diag.apiTry.count + '条') : '') +
                    (state.diag.apiTry.dlError ? (' / ' + state.diag.apiTry.dlError) : '') + ')'))
            : '未执行'),
          (state.diag.viewApi ? ('videoInfo 兜底(view接口): ' + state.diag.viewApi) : null),
          (state.diag.extractError ? ('⚠️ 提取异常: ' + state.diag.extractError) : null)
        ].filter(Boolean).join('\n');
        const pre = el('pre', 'diag-box', diagText);
        pre.style.marginTop = '12px';
        pre.style.whiteSpace = 'pre-wrap';
        pre.style.fontSize = '12px';
        pre.style.background = 'rgba(0,0,0,0.04)';
        pre.style.padding = '8px 10px';
        pre.style.borderRadius = '6px';
        wrap.appendChild(pre);

        const copyBtn = el('button', 'btn', '📋 复制诊断信息');
        copyBtn.style.marginTop = '10px';
        copyBtn.addEventListener('click', () => {
          navigator.clipboard.writeText(diagText).then(() => {
            copyBtn.textContent = '✅ 已复制';
            setTimeout(() => { copyBtn.textContent = '📋 复制诊断信息'; }, 1500);
          });
        });
        wrap.appendChild(copyBtn);
      }

      const btn = el('button', 'btn primary', '🎙 本地语音转写（无需字幕）');
      btn.style.marginTop = '14px';
      btn.addEventListener('click', startTranscribe);
      wrap.appendChild(btn);
      body.appendChild(wrap);
      $('#btn-translate').disabled = true;
      $('#btn-export-transcript').disabled = true;
      return;
    }
    if (!state.segments.length) {
      body.appendChild(el('div', 'transcript-empty', '字幕内容为空，无法生成文稿。'));
      $('#btn-translate').disabled = true;
      $('#btn-export-transcript').disabled = true;
      return;
    }
    $('#btn-translate').disabled = false;
    $('#btn-export-transcript').disabled = false;

    state.segments.forEach((seg, i) => {
      const item = el('div', 'seg-item');
      item.dataset.index = i;
      const meta = el('div', 'seg-meta');
      const chip = el('button', 'time-chip', fmtTime(seg.start));
      chip.title = '跳转到该时间点';
      chip.addEventListener('click', (e) => { e.stopPropagation(); seekTo(seg.start); });
      meta.appendChild(chip);
      if (state.isZh && i === 0) {
        const lg = el('span', 'seg-lang', '中文字幕');
        meta.appendChild(lg);
      }
      item.appendChild(meta);

      const orig = el('div', 'seg-orig', seg.text);
      item.appendChild(orig);

      if (state.viewMode === 'bilingual' || state.viewMode === 'zh') {
        const tr = el('div', 'seg-tr pending', '');
        if (state.isZh) {
          tr.textContent = seg.text;
          tr.classList.remove('pending');
        } else if (state.translations[i]) {
          tr.textContent = state.translations[i];
          tr.classList.remove('pending');
        } else {
          tr.textContent = state.translating ? '翻译中…' : '（点击「翻译全文」生成译文）';
        }
        item.appendChild(tr);
      }
      item.addEventListener('click', () => seekTo(seg.start));
      body.appendChild(item);
    });
  }

  function setViewMode(mode) {
    state.viewMode = mode;
    document.querySelectorAll('.seg').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
    if ((mode === 'bilingual' || mode === 'zh') && !state.isZh && !state.translating) {
      startTranslate();
    }
    renderTranscript();
  }

  // 全文翻译（分段渐进，可中断，结果缓存）
  async function startTranslate() {
    if (!state.segments.length || state.translating) return;
    if (state.isZh) { toast('该视频本身就是中文字幕，无需翻译'); return; }
    state.translating = true;
    state.translateAbort = false;
    $('#btn-translate').textContent = '停止翻译';
    setStatus('正在翻译文稿…', 'busy');
    try {
      for (let i = 0; i < state.segments.length; i++) {
        if (state.translateAbort) break;
        if (state.translations[i]) continue;
        try {
          console.log('[B站深度阅读] 翻译分段', i + 1 + '/' + state.segments.length);
          const res = await callDeepSeek(
            [
              { role: 'system', content: DIGEST_PROMPTS.translateSystem },
              { role: 'user', content: DIGEST_PROMPTS.translateUser(state.segments[i].text) }
            ],
            { temperature: 0.3, maxTokens: 1500, timeout: 60 }
          );
          state.translations[i] = res.text;
        } catch (e) {
          state.translations[i] = '（翻译失败：' + e.message + '）';
        }
        if (state.translating) renderTranscript();
      }
      toast('翻译完成');
      renderTranscript();
    } finally {
      state.translating = false;
      $('#btn-translate').textContent = '翻译全文';
      setStatus('', null);
    }
  }

  function stopTranslate() {
    state.translateAbort = true;
    toast('已停止翻译');
  }

  /* ---------- AI 解释选中 ---------- */

  async function explainSelection() {
    const sel = window.getSelection ? window.getSelection().toString().trim() : '';
    if (!sel || sel.length < 2) { toast('请先在文稿中选中一段文字'); return; }
    const panel = $('#explain-panel');
    const content = $('#explain-content');
    panel.classList.remove('hidden');
    content.textContent = '正在请求 AI 解释…';
    setStatus('正在生成解释…', 'busy');

    // 找到选中的文字所属分段，取其前后文
    let idx = -1;
    state.segments.forEach((s, i) => { if (s.text.includes(sel.slice(0, 12))) idx = i; });
    const ctx = [];
    if (idx >= 0) {
      for (let j = Math.max(0, idx - 1); j <= Math.min(state.segments.length - 1, idx + 1); j++) {
        ctx.push('[' + fmtTime(state.segments[j].start) + '] ' + state.segments[j].text);
      }
    }
    try {
      const res = await callDeepSeek(
        [
          { role: 'system', content: DIGEST_PROMPTS.explainSystem },
          { role: 'user', content: DIGEST_PROMPTS.explainUser(sel, ctx.join('\n')) }
        ],
        { temperature: 0.4, maxTokens: 800, timeout: 60 }
      );
      content.textContent = res.text;
    } catch (e) {
      content.textContent = '解释失败：' + e.message;
    }
    setStatus('', null);
  }

  /* ---------- AI 概览 ---------- */

  function buildTranscriptText() {
    return state.segments
      .map((s) => '[' + fmtTime(s.start) + '] ' + s.text)
      .join('\n');
  }

  async function generateOverview(force) {
    if (!state.segments.length) { toast('没有可用的文稿，无法生成概览'); return; }
    if (state.overview && !force) return;
    const status = $('#overview-status');
    const genBtn = $('#btn-generate');
    const regenBtn = $('#btn-regenerate');
    genBtn.disabled = true;
    regenBtn.classList.add('hidden');
    status.textContent = '正在准备文稿…';

    // ---- 诊断面板 ----
    const diag = $('#diag-panel');
    const diagLog = $('#diag-log');
    const diagTimer = $('#diag-timer');
    const diagPreview = $('#diag-preview');
    const diagCost = $('#diag-cost');
    diagLog.innerHTML = '';
    diagPreview.textContent = '（等待响应）';
    if (diagCost) diagCost.classList.add('hidden');
    diag.open = true;

    const t0 = Date.now();
    const tick = setInterval(() => {
      diagTimer.textContent = ((Date.now() - t0) / 1000).toFixed(1) + 's';
    }, 100);

    const addLog = (msg, cls) => {
      const line = document.createElement('div');
      line.className = 'diag-line' + (cls ? ' ' + cls : '');
      line.textContent = '[' + ((Date.now() - t0) / 1000).toFixed(1) + 's] ' + msg;
      diagLog.appendChild(line);
      diagLog.scrollTop = diagLog.scrollHeight;
    };
    addLog('开始：共 ' + state.segments.length + ' 段字幕，' + buildTranscriptText().length + ' 字');

    try {
      let text = buildTranscriptText();

      // 按 token 估算截断（中文 1 字符约 1~1.5 token，用 1.5 做保守上限）
      const MAX_INPUT_TOKENS = 50000;
      const estTokens = Math.ceil(text.length * 1.5);
      if (estTokens > MAX_INPUT_TOKENS) {
        const keepChars = Math.floor(MAX_INPUT_TOKENS / 1.5);
        text = text.slice(0, keepChars) + '\n（文稿过长，已智能截取前约 ' + keepChars + ' 字以保证生成质量）';
        console.log('[B站深度阅读] 文稿过长，按 token 估算截断：原', estTokens, 'token → 截取', MAX_INPUT_TOKENS, 'token');
        addLog('文稿超长，已按 token 估算截取至约 ' + keepChars + ' 字', 'warn');
      }
      console.log('[B站深度阅读] 概览请求：文稿', text.length, '字，估算 token 约', Math.ceil(text.length * 1.5));

      // 长文稿放宽超时：每 1 万 token 输入多给 40s（生成更慢）
      const dynTimeout = Math.min(300, 120 + Math.ceil(text.length / 10000) * 40);

      const res = await callDeepSeek(
        [
          { role: 'system', content: DIGEST_PROMPTS.overviewSystem },
          { role: 'user', content: DIGEST_PROMPTS.overviewUser(text) }
        ],
        {
          temperature: 0.4,
          maxTokens: 8000,
          timeout: dynTimeout,
          response_format: { type: 'json_object' },
          onLog: addLog,
          onChunk: (full) => {
            diagPreview.textContent = full.length > 600 ? full.slice(0, 600) + '…（共 ' + full.length + ' 字）' : full;
          },
          onHttp: (code) => addLog('DeepSeek HTTP 状态码：' + code + (code === 200 ? '（成功）' : '（异常）'), code === 200 ? 'ok' : 'err')
        }
      );
      console.log('[B站深度阅读] 概览响应：', res.text.length, '字');
      addLog('请求成功，DeepSeek 返回 ' + res.text.length + ' 字', 'ok');

      const obj = parseOverviewJson(res.text);
      state.overview = obj;
      await chrome.storage.local.set({ ['digest:overview:' + state.video.bvid]: obj });
      renderOverview();
      status.textContent = '生成完成';
      addLog('解析成功，已渲染概览', 'ok');
      // ---- 费用估算：展示输入/输出 token 与花费（按 DeepSeek V4 峰谷定价）----
      const cost = DigestCost.compute(res.usage, res.model);
      if (cost) {
        addLog('Token 用量：输入 ' + cost.promptTokens + ' / 输出 ' + cost.completionTokens +
          (cost.cachedTokens ? (' · 缓存命中 ' + cost.cachedTokens) : '') + ' · ' + cost.period + '时段', 'ok');
        showCostPanel(cost);
      } else {
        addLog('（未获取到 Token 用量，无法估算费用）', 'warn');
      }
      toast('AI 概览已生成');
    } catch (e) {
      console.error('[B站深度阅读] 概览失败:', e);
      addLog('❌ 失败：' + e.message, 'err');
      status.textContent = '生成失败：' + e.message;
      status.style.color = '#e74c3c';
      toast('生成失败：' + e.message);
    } finally {
      clearInterval(tick);
      genBtn.disabled = false;
      regenBtn.classList.remove('hidden');
      setTimeout(() => {
        status.textContent = '';
        status.style.color = '';
      }, 10000);
    }
  }

  function parseOverviewJson(raw, res) {
    try {
      return JSON.parse(raw);
    } catch (e) {
      // 宽松提取第一个 { } 块
      const start = raw.indexOf('{');
      const end = raw.lastIndexOf('}');
      if (start >= 0 && end > start) {
        try { return JSON.parse(raw.slice(start, end + 1)); } catch (e2) { /* fallthrough */ }
      }
      console.error('[B站深度阅读] JSON 解析失败，原始响应前500字:', raw.slice(0, 500));
      // 常见原因：max_tokens 截断 / 接口返回错误体 / 余额不足
      if (raw.length < 200) {
        const meta = res ? ('HTTP ' + (res.httpStatus || '?') + (res.viaRelay ? ' · 经后台中继' : '') + ' · 模型 ' + (res.model || '?')) : '';
        const preview = raw ? (' · 原始响应: ' + raw.slice(0, 220)) : ' · 原始响应为空';
        throw new Error('AI 返回内容过短（' + meta + '），可能是 API Key 额度不足或网络异常，请检查设置。' + preview);
      }
      throw new Error('AI 返回的 JSON 不完整（可能因内容过长被截断），请尝试对较短的视频生成概览');
    }
  }

  async function loadCachedOverview() {
    const key = 'digest:overview:' + state.video.bvid;
    const data = await chrome.storage.local.get(key);
    if (data[key]) {
      state.overview = data[key];
      renderOverview();
      $('#btn-regenerate').classList.remove('hidden');
    }
  }

  function renderOverview() {
    const box = $('#overview-content');
    box.innerHTML = '';
    if (!state.overview) {
      box.appendChild(el('div', 'ov-empty', '生成视频的 AI 概览：摘要、核心要点、章节划分与金句。\n一次点击，快速掌握视频全貌。'));
      return;
    }
    const o = state.overview;

    if (o.summary) {
      const card = el('div', 'ov-card');
      card.appendChild(el('h3', '', '视频摘要'));
      card.appendChild(el('p', 'ov-summary', o.summary));
      box.appendChild(card);
    }

    if (Array.isArray(o.keyPoints) && o.keyPoints.length) {
      const card = el('div', 'ov-card');
      card.appendChild(el('h3', '', '核心要点'));
      const ul = el('ul', 'ov-points');
      o.keyPoints.filter(Boolean).forEach((p) => ul.appendChild(el('li', '', String(p))));
      card.appendChild(ul);
      box.appendChild(card);
    }

    if (Array.isArray(o.chapters) && o.chapters.length) {
      const card = el('div', 'ov-card');
      card.appendChild(el('h3', '', '章节划分'));
      o.chapters.filter(Boolean).forEach((ch) => {
        const item = el('div', 'chapter-item');
        const head = el('div', 'chapter-head');
        const range = el('button', 'time-chip', fmtTime(ch.start) + ' – ' + fmtTime(ch.end));
        range.title = '跳转到章节开始';
        range.addEventListener('click', () => seekTo(ch.start));
        head.appendChild(el('span', 'chapter-title', String(ch.title || '章节')));
        head.appendChild(range);
        item.appendChild(head);
        if (Array.isArray(ch.points) && ch.points.length) {
          const ul = el('ul', 'chapter-points');
          ch.points.filter(Boolean).forEach((p) => ul.appendChild(el('li', '', String(p))));
          item.appendChild(ul);
        }
        card.appendChild(item);
      });
      box.appendChild(card);
    }

    if (Array.isArray(o.quotes) && o.quotes.length) {
      const card = el('div', 'ov-card');
      card.appendChild(el('h3', '', '值得记住的金句'));
      o.quotes.filter(Boolean).forEach((q) => {
        const item = el('div', 'quote-item');
        const chip = el('button', 'time-chip', fmtTime(q.time));
        chip.title = '跳转到该时间点';
        chip.addEventListener('click', () => seekTo(q.time));
        item.appendChild(chip);
        item.appendChild(el('span', 'quote-text', String(q.text || '')));
        card.appendChild(item);
      });
      box.appendChild(card);
    }
    const expOv = $('#btn-export-overview');
    if (expOv) expOv.disabled = !state.overview;
  }

  /* ---------- 视频跳转 ---------- */

  async function seekTo(time) {
    if (!state.tab) return;
    try {
      await sendToPage('digest:seek', { time: time });
    } catch (e) { /* 忽略 */ }
  }

  async function getCurrentVideoTime() {
    try {
      const res = await sendToPage('digest:get-time');
      return res && res.ok ? res.time : 0;
    } catch (e) {
      return 0;
    }
  }

  /* ---------- 笔记 ---------- */

  const notesKey = () => 'digest:notes:' + (state.video ? state.video.bvid : 'none');

  async function loadNotes() {
    const data = await chrome.storage.local.get(notesKey());
    state.notes = (data[notesKey()] || []).sort((a, b) => a.time - b.time);
    renderNotes();
    updateNoteBadge();
  }

  async function saveNotes() {
    await chrome.storage.local.set({ [notesKey()]: state.notes });
  }

  function updateNoteBadge() {
    const badge = $('#note-count');
    const n = state.notes.length;
    if (n > 0) {
      badge.textContent = String(n);
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  }

  function renderNotes() {
    const body = $('#notes-body');
    body.innerHTML = '';
    if (!state.notes.length) {
      body.appendChild(el('div', 'note-empty',
        '还没有笔记。\n播放视频时点击「记录当前时刻笔记」，\n自动带上时间戳，方便复习跳转。'));
      return;
    }
    state.notes.forEach((note) => {
      const item = el('div', 'note-item');
      item.dataset.id = note.id;

      const head = el('div', 'note-head');
      const chip = el('button', 'time-chip', fmtTime(note.time));
      chip.title = '跳转到该时间点';
      chip.addEventListener('click', () => seekTo(note.time));
      head.appendChild(chip);

      const actions = el('div', 'note-actions');
      const polishBtn = el('button', 'note-act', 'AI 润色');
      polishBtn.addEventListener('click', () => polishNote(note.id));
      const delBtn = el('button', 'note-act danger', '删除');
      delBtn.addEventListener('click', () => deleteNote(note.id));
      actions.appendChild(polishBtn);
      actions.appendChild(delBtn);
      head.appendChild(actions);

      const ta = el('textarea', 'note-text');
      ta.placeholder = '写下你的思考…';
      ta.value = note.text;
      let timer = null;
      ta.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          const n = state.notes.find((x) => x.id === note.id);
          if (n) { n.text = ta.value; saveNotes(); }
        }, 400);
      });

      item.appendChild(head);
      item.appendChild(ta);
      body.appendChild(item);
    });
  }

  async function addNote() {
    const time = await getCurrentVideoTime();
    const note = { id: Date.now(), time: time, text: '', raw: '', createdAt: Date.now() };
    state.notes.push(note);
    state.notes.sort((a, b) => a.time - b.time);
    await saveNotes();
    renderNotes();
    updateNoteBadge();
    toast('已记录笔记（' + fmtTime(time) + '），请填写内容');
    // 聚焦新笔记
    const items = document.querySelectorAll('#notes-body .note-item');
    const last = items[items.length - 1];
    if (last) { const ta = last.querySelector('textarea'); if (ta) ta.focus(); }
  }

  async function deleteNote(id) {
    state.notes = state.notes.filter((n) => n.id !== id);
    await saveNotes();
    renderNotes();
    updateNoteBadge();
  }

  async function polishNote(id) {
    const note = state.notes.find((n) => n.id === id);
    if (!note) return;
    if (!note.text.trim()) { toast('笔记内容为空，无法润色'); return; }
    const btn = document.querySelector(`#notes-body .note-item[data-id="${id}"] .note-act`);
    if (btn) btn.textContent = '润色中…';
    try {
      const res = await callDeepSeek(
        [
          { role: 'system', content: DIGEST_PROMPTS.polishSystem },
          { role: 'user', content: DIGEST_PROMPTS.polishUser(note.text) }
        ],
        { temperature: 0.4, maxTokens: 600, timeout: 120 }
      );
      note.raw = note.text;
      note.text = res.text;
      await saveNotes();
      renderNotes();
      toast('润色完成');
    } catch (e) {
      toast('润色失败：' + e.message);
      if (btn) btn.textContent = 'AI 润色';
    }
  }

  async function exportNotes() {
    if (!state.notes.length) { toast('暂无笔记可导出'); return; }
    const lines = [];
    lines.push('# ' + (state.video.title || 'B站视频') + ' 学习笔记');
    lines.push('');
    lines.push('- 视频：https://www.bilibili.com/video/' + state.video.bvid);
    lines.push('- UP 主：' + (state.video.up || '未知'));
    lines.push('- 导出时间：' + new Date().toLocaleString('zh-CN'));
    lines.push('');
    state.notes.forEach((n) => {
      lines.push('## [' + fmtTime(n.time) + ']');
      lines.push('');
      lines.push(n.text || '（空笔记）');
      lines.push('');
    });
    const blob = new Blob(['\ufeff' + lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = '笔记-' + state.video.bvid + '.md';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast('已导出 Markdown');
  }

  /* ---------- 费用估算面板 ---------- */

  // 把 DigestCost 计算出的费用详情渲染到「请求诊断」模块内的 #diag-cost
  function showCostPanel(cost) {
    const box = $('#diag-cost');
    if (!box) return;
    const r = cost.rates;
    const periodNote = cost.period === '高峰' ? '9:00-12:00、14:00-18:00（价格翻倍）' : '其余时段（价格为高峰一半）';
    const rows = [
      ['模型', cost.modelLabel],
      ['计费时段', cost.period + '时段 · ' + periodNote],
      ['输入 tokens', String(cost.promptTokens) + (cost.cachedTokens ? ('（其中缓存命中 ' + cost.cachedTokens + '）') : '')],
      ['输出 tokens', String(cost.completionTokens)],
      ['输入单价（命中/未命中）', '¥' + r.cacheHitInput.toFixed(2) + ' / ¥' + r.cacheMissInput.toFixed(2) + ' 每百万'],
      ['输出单价', '¥' + r.output.toFixed(2) + ' 每百万'],
      ['💰 估算费用', DigestCost.money(cost.total) + '（输入 ' + DigestCost.money(cost.inputCost) + ' + 输出 ' + DigestCost.money(cost.outputCost) + '）']
    ];
    box.innerHTML =
      '<div class="diag-cost-title">💰 费用估算 · DeepSeek V4 峰谷定价（2026-08-17 起）</div>' +
      '<table class="diag-cost-table">' +
      rows.map((row) => '<tr><td class="k">' + row[0] + '</td><td class="v">' + row[1] + '</td></tr>').join('') +
      '</table>';
    box.classList.remove('hidden');
  }

  /* ---------- 导出：概览 / 文稿 ---------- */

  function downloadFile(content, filename) {
    const blob = new Blob(['\ufeff' + content], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast('已导出 ' + filename);
  }

  function exportOverview() {
    if (!state.overview) { toast('尚未生成概览，无法导出'); return; }
    const o = state.overview;
    const L = [];
    L.push('# ' + (state.video.title || 'B站视频') + ' · AI 概览');
    L.push('');
    L.push('- 视频：https://www.bilibili.com/video/' + state.video.bvid);
    if (state.video.up) L.push('- UP 主：' + state.video.up);
    L.push('- 导出时间：' + new Date().toLocaleString('zh-CN'));
    L.push('');
    if (o.summary) {
      L.push('## 视频摘要');
      L.push('');
      L.push(o.summary);
      L.push('');
    }
    if (Array.isArray(o.keyPoints) && o.keyPoints.length) {
      L.push('## 核心要点');
      L.push('');
      o.keyPoints.filter(Boolean).forEach((p) => L.push('- ' + String(p)));
      L.push('');
    }
    if (Array.isArray(o.chapters) && o.chapters.length) {
      L.push('## 章节划分');
      L.push('');
      o.chapters.filter(Boolean).forEach((ch) => {
        L.push('### [' + fmtTime(ch.start) + ' – ' + fmtTime(ch.end) + '] ' + String(ch.title || '章节'));
        if (Array.isArray(ch.points) && ch.points.length) {
          ch.points.filter(Boolean).forEach((p) => L.push('- ' + String(p)));
        }
        L.push('');
      });
    }
    if (Array.isArray(o.quotes) && o.quotes.length) {
      L.push('## 值得记住的金句');
      L.push('');
      o.quotes.filter(Boolean).forEach((q) => {
        L.push('> [' + fmtTime(q.time) + '] “' + String(q.text || '') + '”');
        L.push('');
      });
    }
    downloadFile(L.join('\n'), '概览-' + state.video.bvid + '.md');
  }

  function exportTranscript() {
    if (!state.segments.length) { toast('暂无文稿可导出'); return; }
    const L = [];
    L.push('# ' + (state.video.title || 'B站视频') + ' · 字幕文稿');
    L.push('');
    L.push('- 视频：https://www.bilibili.com/video/' + state.video.bvid);
    if (state.video.up) L.push('- UP 主：' + state.video.up);
    L.push('- 语言：' + (state.subtitle && state.subtitle.lanDoc ? state.subtitle.lanDoc : ((state.subtitle && state.subtitle.lan) || '未知')));
    L.push('- 导出时间：' + new Date().toLocaleString('zh-CN'));
    L.push('');
    state.segments.forEach((seg, i) => {
      L.push('[' + fmtTime(seg.start) + '] ' + seg.text);
      // 非中文且已有译文时，附上译文（缩进一行以示区分）
      if (!state.isZh && state.translations[i]) {
        L.push('    ' + state.translations[i]);
      }
      L.push('');
    });
    downloadFile(L.join('\n'), '文稿-' + state.video.bvid + '.md');
  }

  /* ---------- 无字幕视频：本地语音转写（Whisper） ---------- */

  let _whisperWorker = null;
  let _transcribing = false;

  function getWhisperWorker() {
    if (!_whisperWorker) {
      _whisperWorker = new Worker(chrome.runtime.getURL('whisper-worker.js'));
    }
    return _whisperWorker;
  }

  function setTranscribeStatus(t) {
    const elx = $('#transcribe-status');
    if (elx) elx.textContent = t;
  }

  function showTranscribeProgress() {
    const p = $('#transcribe-progress');
    if (p) p.classList.remove('hidden');
    updateTranscribeProgress(0, 0);
  }
  function hideTranscribeProgress() {
    const p = $('#transcribe-progress');
    if (p) p.classList.add('hidden');
  }
  function updateTranscribeProgress(cur, dur) {
    const fill = $('#tp-fill');
    const txt = $('#tp-text');
    if (!fill || !txt) return;
    let pct = 0;
    if (dur && dur > 0) pct = Math.min(100, (cur / dur) * 100);
    fill.style.width = pct.toFixed(1) + '%';
    txt.textContent = fmtTime(cur) + (dur ? (' / ' + fmtTime(dur) + '（' + pct.toFixed(0) + '%）') : '');
  }

  function resetTranscribeUI() {
    const btn = $('#btn-transcribe');
    if (btn) btn.disabled = false;
    const stop = $('#btn-transcribe-stop');
    if (stop) stop.classList.add('hidden');
    _transcribing = false;
  }

  async function startTranscribe() {
    if (_transcribing) return;
    if (!state.tab) { toast('请先打开 B 站视频'); return; }
    _transcribing = true;
    $('#transcribe-box').classList.remove('hidden');
    const btn = $('#btn-transcribe'); if (btn) btn.disabled = true;
    const stop = $('#btn-transcribe-stop'); if (stop) stop.classList.remove('hidden');
    setTranscribeStatus('正在准备录音…（视频将自动从头播放，请保持页面在前台，不要静音）');

    try {
      const res = await sendToPage('digest:transcribe-start');
      if (!res || !res.ok) {
        setTranscribeStatus('无法开始录音：' + ((res && res.error) || '未知错误'));
        resetTranscribeUI();
        return;
      }
      setTranscribeStatus('🎙 录音中（随播放实时进行，长视频耗时≈视频时长，可随时点「停止并转写」）…');
      showTranscribeProgress();
    } catch (e) {
      setTranscribeStatus('录音启动失败：' + e.message);
      resetTranscribeUI();
    }
  }

  async function stopTranscribe() {
    const stop = $('#btn-transcribe-stop');
    if (stop) stop.classList.add('hidden');
    setTranscribeStatus('已停止录音，正在处理音频…');
    try {
      await sendToPage('digest:transcribe-stop');
    } catch (e) {
      setTranscribeStatus('停止录音失败：' + e.message);
      resetTranscribeUI();
    }
  }

  // 将录音 Blob 解码为 16kHz 单声道 Float32Array（Whisper 所需）
  async function decodeAudioToMono16k(blob) {
    const arrBuf = await blob.arrayBuffer();
    const AC = window.AudioContext || window.webkitAudioContext;
    const ac = new AC();
    const audioBuf = await ac.decodeAudioData(arrBuf);
    const channels = audioBuf.numberOfChannels;
    const len = audioBuf.length;
    const mono = new Float32Array(len);
    for (let c = 0; c < channels; c++) {
      const d = audioBuf.getChannelData(c);
      for (let i = 0; i < len; i++) mono[i] += d[i];
    }
    if (channels > 1) for (let i = 0; i < len; i++) mono[i] /= channels;

    const ratio = audioBuf.sampleRate / 16000;
    const newLen = Math.max(1, Math.round(len / ratio));
    const out = new Float32Array(newLen);
    for (let i = 0; i < newLen; i++) {
      const idx = i * ratio;
      const i0 = Math.floor(idx);
      const i1 = Math.min(len - 1, i0 + 1);
      const frac = idx - i0;
      out[i] = mono[i0] * (1 - frac) + mono[i1] * frac;
    }
    try { ac.close(); } catch (e) { /* ignore */ }
    return out;
  }

  async function onTranscribeAudioReady(msg) {
    if (!msg || !msg.ok || !msg.blob) {
      setTranscribeStatus('录音失败：' + ((msg && msg.error) || '无音频数据'));
      resetTranscribeUI();
      return;
    }
    hideTranscribeProgress();
    setTranscribeStatus('音频已就绪，正在解码为 16kHz 单声道…');
    let audio;
    try {
      audio = await decodeAudioToMono16k(msg.blob);
    } catch (e) {
      setTranscribeStatus('音频解码失败：' + e.message);
      resetTranscribeUI();
      return;
    }
    setTranscribeStatus('正在本地转写（首次需下载模型约 40MB，请保持网络畅通；之后会缓存）…');

    const worker = getWhisperWorker();
    worker.onmessage = (e) => {
      const d = e.data || {};
      if (d.type === 'status') {
        setTranscribeStatus(d.msg);
      } else if (d.type === 'progress') {
        setTranscribeStatus('📝 转写中：' + (d.text ? d.text.slice(-140) : ''));
      } else if (d.type === 'error') {
        setTranscribeStatus('转写失败：' + d.error);
        resetTranscribeUI();
      } else if (d.type === 'done') {
        applyWhisperTranscript(d.text, d.chunks);
      }
    };
    worker.postMessage({ type: 'transcribe', audio: audio }, [audio.buffer]);
  }

  function applyWhisperTranscript(fullText, chunks) {
    let body = [];
    if (chunks && chunks.length) {
      body = chunks
        .map((ch) => {
          const ts = ch.timestamp || [0, 0];
          return { from: ts[0] || 0, to: (ts[1] != null ? ts[1] : (ts[0] || 0)), content: String(ch.text || '').trim() };
        })
        .filter((l) => l.content);
    }
    if (!body.length && fullText) {
      body = [{ from: 0, to: 0, content: fullText.trim() }];
    }
    if (!body.length) {
      setTranscribeStatus('转写结果为空，可能音频质量较差或无人声。');
      resetTranscribeUI();
      return;
    }
    state.subtitle = { lan: 'zh', lanDoc: '本地语音转写 (Whisper)', ai: false, body: body };
    state.isZh = true;
    buildSegments();
    renderVideoCard();
    renderTranscript();
    setTranscribeStatus('✅ 本地转写完成，共 ' + body.length + ' 段。现在可以点「生成 AI 概览」了。');
    toast('语音转写完成，可生成概览');
    const tabBtn = document.querySelector('.tab[data-tab="transcript"]');
    if (tabBtn) tabBtn.click();
    setTimeout(resetTranscribeUI, 5000);
  }

  // 接收 content script 主动发来的录音进度 / 完成消息
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || !msg.type) return;
    if (msg.type === 'transcribe-progress') {
      updateTranscribeProgress(msg.current || 0, msg.duration || 0);
    } else if (msg.type === 'transcribe-done') {
      onTranscribeAudioReady(msg);
    }
  });

  /* ---------- 事件绑定 ---------- */

  function bindEvents() {
    $('#btn-settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
    bindTabs();

    $('#btn-generate').addEventListener('click', () => generateOverview(false));
    $('#btn-regenerate').addEventListener('click', () => { state.overview = null; renderOverview(); generateOverview(true); });

    document.querySelectorAll('.seg').forEach((b) => {
      b.addEventListener('click', () => setViewMode(b.dataset.mode));
    });
    $('#btn-translate').addEventListener('click', () => {
      if (state.translating) stopTranslate(); else startTranslate();
    });
    $('#btn-explain').addEventListener('click', explainSelection);
    $('#btn-explain-close').addEventListener('click', () => $('#explain-panel').classList.add('hidden'));

    $('#btn-add-note').addEventListener('click', addNote);
    $('#btn-export-notes').addEventListener('click', exportNotes);
    $('#btn-export-overview').addEventListener('click', exportOverview);
    $('#btn-export-transcript').addEventListener('click', exportTranscript);
    $('#btn-transcribe').addEventListener('click', startTranscribe);
    $('#btn-transcribe-stop').addEventListener('click', stopTranscribe);
  }

  /* ---------- 启动 ---------- */

  async function init() {
    bindEvents();
    await loadData();
    if (state.video) await loadNotes();
  }

  // 页面 URL 变化（SPA 跳转）时自动刷新
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (state.tab && tabId === state.tab.id && changeInfo.url) {
      setTimeout(loadData, 400);
    }
  });

  init();
})();
