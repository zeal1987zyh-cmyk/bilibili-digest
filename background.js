// background.js — 扩展后台服务 (Manifest V3)
// 职责：
//   1. 点击扩展图标时打开侧边栏
//   2. 作为 API 中继：代替 content script / side panel 发起跨域请求（绕过 MV3 CORS / Side Panel 网络限制）

// ===== 全局错误捕获：任何未捕获异常都打印出来，便于在「Inspect views: service worker」里排查 =====
self.addEventListener('error', (e) => {
  console.error('[B站深度阅读] SW 运行时错误:', e.message, e.filename, e.lineno);
});
self.addEventListener('unhandledrejection', (e) => {
  console.error('[B站深度阅读] SW 未处理的 Promise 拒绝:', e.reason && (e.reason.message || e.reason));
});

console.log('[B站深度阅读] Service Worker 启动成功');

chrome.runtime.onInstalled.addListener(() => {
  initSidePanel();
});

chrome.runtime.onStartup.addListener(() => {
  initSidePanel();
});

function initSidePanel() {
  try {
    if (chrome.sidePanel && typeof chrome.sidePanel.setPanelBehavior === 'function') {
      const p = chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
      // 兜底：避免 promise 拒绝造成未处理异常
      if (p && typeof p.catch === 'function') {
        p.catch((err) => {
          console.warn('[B站深度阅读] 侧边栏行为设置失败（浏览器版本过低？需 Chrome/Edge 114+）：', err && err.message);
        });
      }
    } else {
      console.warn('[B站深度阅读] 当前浏览器不支持 sidePanel API（需 Chrome/Edge 114+）');
    }
  } catch (e) {
    console.warn('[B站深度阅读] 侧边栏初始化异常（浏览器版本过低？）：', e.message);
  }
}

/* =========================================================
 * 消息中继统一入口
 * background 拥有 host_permissions，不受 CORS 限制
 * ========================================================= */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return false;

  /* --- 页面主世界数据提取（替代 content script 注入 inline script） --- */
  if (msg.type === 'digest:extract-page-data') {
    if (!sender.tab || !sender.tab.id) {
      sendResponse({ ok: false, error: '无法确定当前标签页' });
      return false;
    }

    chrome.scripting.executeScript({
      target: { tabId: sender.tab.id },
      world: 'MAIN',
      func: () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));

        function pickFirst(obj, paths) {
          for (const p of paths) {
            try {
              let cur = obj;
              for (const k of p) {
                if (cur == null) break;
                cur = cur[k];
              }
              if (cur) return cur;
            } catch (e) {}
          }
          return null;
        }

        function cleanPic(url) {
          if (!url) return '';
          return String(url).replace(/^http:\/\//, 'https://').replace(/^\/\//, 'https://').split('@')[0];
        }

        // ===== 安装 fetch/XHR hook：捕获播放器自身发起的字幕请求 =====
        // 这是最可靠的来源——直接拦截播放器加载字幕时用的真实 URL 与正文，
        // 不需要 API 签名，也不依赖扩展读 cookie。
        function installHook() {
          if (window.__biliDigestHookInstalled) return;
          window.__biliDigestCaptured = window.__biliDigestCaptured || [];
          try {
            const origFetch = window.fetch.bind(window);
            window.fetch = function (input, init) {
              const url = (typeof input === 'string') ? input : (input && input.url) || '';
              const p = origFetch(input, init);
              if (url && /aisubtitle|\/bfs\/ai_subtitle\/|subtitle/i.test(url)) {
                Promise.resolve(p).then((r) => {
                  try {
                    r.clone().text().then((t) => {
                      try {
                        const j = JSON.parse(t);
                        if (j && Array.isArray(j.body) && j.body.length) {
                          window.__biliDigestCaptured.push({ url: url, body: j.body, raw: j });
                        }
                      } catch (e2) {}
                    }).catch(() => {});
                  } catch (e2) {}
                }).catch(() => {});
              }
              return p;
            };
          } catch (e) {}
          try {
            const origOpen = XMLHttpRequest.prototype.open;
            const origSend = XMLHttpRequest.prototype.send;
            XMLHttpRequest.prototype.open = function (m, u) { this.__biliUrl = u; return origOpen.apply(this, arguments); };
            XMLHttpRequest.prototype.send = function () {
              const url = this.__biliUrl || '';
              const self = this;
              if (url && /aisubtitle|\/bfs\/ai_subtitle\/|subtitle/i.test(url)) {
                this.addEventListener('load', () => {
                  try {
                    const j = JSON.parse(self.responseText);
                    if (j && Array.isArray(j.body) && j.body.length) {
                      window.__biliDigestCaptured.push({ url: url, body: j.body, raw: j });
                    }
                  } catch (e2) {}
                });
              }
              return origSend.apply(this, arguments);
            };
          } catch (e) {}
          window.__biliDigestHookInstalled = true;
        }

        // 尝试开启 CC 字幕按钮，触发播放器去请求字幕 JSON
        function tryEnableSubtitle() {
          const sels = ['.bpx-player-ctrl-subtitle-btn', '.bilibili-player-video-subtitle-btn', '.bpx-player-ctrl-subtitle'];
          for (const sel of sels) {
            const btn = document.querySelector(sel);
            if (btn) {
              const cls = ((btn.className || '') + ' ' + (btn.getAttribute ? (btn.getAttribute('data-state') || '') : '')).toLowerCase();
              const on = /active|on/.test(cls);
              if (!on) { try { btn.click(); } catch (e) {} return 'clicked'; }
              return 'already-on';
            }
          }
          return 'not-found';
        }

        return (async () => {
          installHook();
          window.__biliDigestCaptured = window.__biliDigestCaptured || [];
          window.__biliDigestCaptured.length = 0; // 清空上次的残留
          const payload = { source: 'bili-digest-extract', subtitles: null, videoInfo: null, playinfo: null, captured: null, diag: { hook: true, ccAction: 'pending' } };
          const deadline = Date.now() + 5000;
          let ccAction = 'pending';
          while (Date.now() < deadline) {
            // 1) window.__playinfo__ — 尝试多种字幕路径
            try {
              const pi = window.__playinfo__;
              if (pi) {
                payload.playinfo = pi;
                const subs = pickFirst(pi, [
                  ['data', 'subtitle', 'subtitles'],
                  ['subtitle', 'subtitles'],
                  ['data', 'video_subtitle'],
                  ['video_subtitle']
                ]);
                if (subs && subs.length) payload.subtitles = subs;
              }
            } catch (e) {}

            // 2) window.__INITIAL_STATE__
            try {
              const st = window.__INITIAL_STATE__;
              if (st) {
                const vi = st.videoInfo || st.videoData || {};
                if (vi.aid && vi.bvid && vi.cid) {
                  payload.videoInfo = {
                    aid: vi.aid,
                    bvid: vi.bvid,
                    cid: vi.cid,
                    title: vi.title || '',
                    pic: cleanPic(vi.pic || vi.cover),
                    up: (vi.up && vi.up.name) || (vi.owner && vi.owner.name) || '',
                    duration: vi.duration || 0,
                    pages: (vi.pages && vi.pages.length) || 1
                  };
                }
                if (!payload.subtitles) {
                  const subInfo = pickFirst(st, [
                    ['videoInfo', 'subtitle'],
                    ['videoData', 'subtitle'],
                    ['epInfo', 'subtitle']
                  ]);
                  if (subInfo && subInfo.subtitles && subInfo.subtitles.length) {
                    payload.subtitles = subInfo.subtitles;
                  }
                }
              }
            } catch (e) {}

            // 3) 页面 script 标签兜底（部分新版页面把 playinfo 放在 <script id="__playinfo__">）
            if (!payload.playinfo) {
              try {
                const el = document.getElementById('__playinfo__');
                if (el && el.textContent) {
                  const pi = JSON.parse(el.textContent);
                  if (pi) {
                    payload.playinfo = pi;
                    const subs = pickFirst(pi, [
                      ['data', 'subtitle', 'subtitles'],
                      ['subtitle', 'subtitles']
                    ]);
                    if (subs && subs.length) payload.subtitles = subs;
                  }
                }
              } catch (e) {}
            }

            // 4) 播放器 fetch/XHR hook 捕获到的字幕正文（最可靠来源）
            try {
              if (window.__biliDigestCaptured && window.__biliDigestCaptured.length) {
                payload.captured = window.__biliDigestCaptured;
              }
            } catch (e) {}

            // 还没拿到字幕时，尝试开启 CC 字幕，触发播放器请求字幕 JSON
            if ((!payload.subtitles || !payload.captured) && ccAction === 'pending') {
              ccAction = tryEnableSubtitle();
              payload.diag.ccAction = ccAction;
            }

            if ((payload.captured && payload.captured.length) || (payload.subtitles && payload.subtitles.length)) break;
            await wait(300);
          }

          // 若 playinfo 含循环引用/不可序列化对象，回退到只返回字幕列表
          try {
            JSON.stringify(payload.playinfo);
          } catch (_) {
            payload.playinfo = null;
          }
          return payload;
        })();
      }
    })
      .then((results) => {
        const result = results && results[0] && results[0].result;
        sendResponse({ ok: true, data: result });
      })
      .catch((err) => {
        console.error('[B站深度阅读] 页面数据提取失败:', err && err.message);
        sendResponse({ ok: false, error: err && (err.message || String(err)) });
      });

    return true; // 异步响应
  }

  /* --- GET 中继（content script 获取字幕等） --- */
  if (msg.type === 'digest:bg-fetch') {
    const url = msg.url;
    if (!url || typeof url !== 'string') {
      sendResponse({ ok: false, error: '无效的 URL' });
      return false;
    }

    const headers = {};
    if (msg.referer) headers['Referer'] = msg.referer;

    fetch(url, { credentials: 'include', headers: headers })
      .then(async (res) => {
        if (!res.ok) {
          sendResponse({ ok: false, error: 'HTTP ' + res.status });
          return;
        }
        const ct = res.headers.get('content-type') || '';
        if (ct.includes('application/json')) {
          const data = await res.json();
          sendResponse({ ok: true, data: data });
        } else {
          const text = await res.text();
          try {
            sendResponse({ ok: true, data: JSON.parse(text) });
          } catch (_) {
            sendResponse({ ok: false, error: '响应不是有效的 JSON' });
          }
        }
      })
      .catch((e) => {
        sendResponse({ ok: false, error: e.message || '网络请求失败' });
      });

    return true; // 异步响应
  }

  /* --- POST 中继（side panel 调用 DeepSeek API） --- */
  if (msg.type === 'digest:ai-request') {
    const { url, headers, body, timeout } = msg;
    if (!url || !body) {
      sendResponse({ ok: false, error: '参数不完整' });
      return false;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), (timeout || 120) * 1000);

    console.log('[B站深度阅读] background 代发 AI 请求 →', url);

    fetch(url, {
      method: 'POST',
      headers: headers || { 'Content-Type': 'application/json' },
      body: body,
      signal: controller.signal
    })
      .then(async (res) => {
        clearTimeout(timer);
        const raw = await res.text();
        // 解析 DeepSeek 非流式 JSON 响应：提取正文 content 与 token 用量 usage
        let text = raw;
        let usage = null;
        try {
          const data = JSON.parse(raw);
          if (data && data.choices && data.choices[0] && data.choices[0].message) {
            text = data.choices[0].message.content || '';
          }
          if (data && data.usage) usage = data.usage;
        } catch (_) { /* 非 JSON（极少见），原样返回以便上层报错 */ }
        console.log('[B站深度阅读] background AI 响应:', res.status, text.length + '字', usage ? ('· tokens ' + usage.prompt_tokens + '/' + usage.completion_tokens) : '');
        sendResponse({
          ok: res.ok,
          status: res.status,
          text: text,
          usage: usage
        });
      })
      .catch((e) => {
        clearTimeout(timer);
        console.error('[B站深度阅读] background AI 请求失败:', e.message);
        sendResponse({
          ok: false,
          status: 0,
          error: e.message || '网络请求失败',
          aborted: e.name === 'AbortError'
        });
      });

    return true; // 异步响应
  }

  return false; // 未处理的消息类型
});
