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
        return (async () => {
          const payload = { source: 'bili-digest-extract', subtitles: null, videoInfo: null, playinfo: null };
          const deadline = Date.now() + 2000;
          while (Date.now() < deadline) {
            // 1) window.__playinfo__
            try {
              const pi = window.__playinfo__;
              if (pi) {
                payload.playinfo = pi;
                const subs = pi && pi.data && pi.data.subtitle && pi.data.subtitle.subtitles;
                if (subs && subs.length) payload.subtitles = subs;
              }
            } catch (e) {}

            // 2) window.__INITIAL_STATE__
            try {
              const st = window.__INITIAL_STATE__;
              if (st) {
                const vi = st.videoInfo || {};
                if (vi.aid && vi.bvid && vi.cid) {
                  payload.videoInfo = {
                    aid: vi.aid,
                    bvid: vi.bvid,
                    cid: vi.cid,
                    title: vi.title || '',
                    pic: vi.pic || (vi.cover && vi.cover.split('@')[0]) || '',
                    up: (vi.up && vi.up.name) || (vi.owner && vi.owner.name) || '',
                    duration: vi.duration || 0,
                    pages: (vi.pages && vi.pages.length) || 1
                  };
                }
                if (!payload.subtitles) {
                  const subInfo = st.videoInfo && st.videoInfo.subtitle;
                  if (subInfo && subInfo.subtitles && subInfo.subtitles.length) {
                    payload.subtitles = subInfo.subtitles;
                  }
                }
              }
            } catch (e) {}

            if (payload.playinfo || payload.videoInfo) break;
            await wait(200);
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

    fetch(url, { credentials: 'include' })
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
