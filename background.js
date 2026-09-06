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

        // ===== MD5（用于 WBI 签名的 w_rid；输入为 ASCII 字符串，等价于字节处理）=====
        function md5(string) {
  function RotateLeft(lValue, iShiftBits) {
    return (lValue << iShiftBits) | (lValue >>> (32 - iShiftBits));
  }

  function AddUnsigned(lX, lY) {
    const lX4 = lX & 0x40000000;
    const lY4 = lY & 0x40000000;
    const lX8 = lX & 0x80000000;
    const lY8 = lY & 0x80000000;
    const lResult = (lX & 0x3fffffff) + (lY & 0x3fffffff);
    if (lX4 & lY4) return lResult ^ 0x80000000 ^ lX8 ^ lY8;
    if (lX4 | lY4) {
      if (lResult & 0x40000000) return lResult ^ 0xc0000000 ^ lX8 ^ lY8;
      return lResult ^ 0x40000000 ^ lX8 ^ lY8;
    }
    return lResult ^ lX8 ^ lY8;
  }

  function F(x, y, z) { return (x & y) | (~x & z); }
  function G(x, y, z) { return (x & z) | (y & ~z); }
  function H(x, y, z) { return x ^ y ^ z; }
  function I(x, y, z) { return y ^ (x | ~z); }

  function FF(a, b, c, d, x, s, ac) {
    a = AddUnsigned(a, AddUnsigned(AddUnsigned(F(b, c, d), x), ac));
    return AddUnsigned(RotateLeft(a, s), b);
  }
  function GG(a, b, c, d, x, s, ac) {
    a = AddUnsigned(a, AddUnsigned(AddUnsigned(G(b, c, d), x), ac));
    return AddUnsigned(RotateLeft(a, s), b);
  }
  function HH(a, b, c, d, x, s, ac) {
    a = AddUnsigned(a, AddUnsigned(AddUnsigned(H(b, c, d), x), ac));
    return AddUnsigned(RotateLeft(a, s), b);
  }
  function II(a, b, c, d, x, s, ac) {
    a = AddUnsigned(a, AddUnsigned(AddUnsigned(I(b, c, d), x), ac));
    return AddUnsigned(RotateLeft(a, s), b);
  }

  // 字符串 → UTF-8 字节数组
  function utf8Bytes(str) {
    const bytes = [];
    for (let i = 0; i < str.length; i++) {
      let c = str.charCodeAt(i);
      if (c < 0x80) {
        bytes.push(c);
      } else if (c < 0x800) {
        bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      } else if (
        c >= 0xd800 && c <= 0xdbff && i + 1 < str.length &&
        str.charCodeAt(i + 1) >= 0xdc00 && str.charCodeAt(i + 1) <= 0xdfff
      ) {
        const v = 0x10000 + ((c - 0xd800) << 10) + (str.charCodeAt(i + 1) - 0xdc00);
        bytes.push(0xf0 | (v >> 18), 0x80 | ((v >> 12) & 0x3f), 0x80 | ((v >> 6) & 0x3f), 0x80 | (v & 0x3f));
        i++;
      } else {
        bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
      }
    }
    return bytes;
  }

  const bytes = utf8Bytes(string);
  const bitLen = bytes.length * 8;
  const bitLenLow = bitLen >>> 0;
  const bitLenHigh = Math.floor(bitLen / 4294967296);

  // 填充：0x80 + 0x00... 到 56 mod 64，再追加 64 位长度（小端）
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  bytes.push(
    bitLenLow & 0xff, (bitLenLow >>> 8) & 0xff, (bitLenLow >>> 16) & 0xff, (bitLenLow >>> 24) & 0xff,
    bitLenHigh & 0xff, (bitLenHigh >>> 8) & 0xff, (bitLenHigh >>> 16) & 0xff, (bitLenHigh >>> 24) & 0xff
  );

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;

  const S11 = 7, S12 = 12, S13 = 17, S14 = 22;
  const S21 = 5, S22 = 9, S23 = 14, S24 = 20;
  const S31 = 4, S32 = 11, S33 = 16, S34 = 23;
  const S41 = 6, S42 = 10, S43 = 15, S44 = 21;

  for (let off = 0; off < bytes.length; off += 64) {
    const M = [];
    for (let i = 0; i < 16; i++) {
      M[i] = bytes[off + i * 4] | (bytes[off + i * 4 + 1] << 8) | (bytes[off + i * 4 + 2] << 16) | (bytes[off + i * 4 + 3] << 24);
    }
    let A = a0, B = b0, C = c0, D = d0;

    // 第 1 轮
    A = FF(A, B, C, D, M[0], S11, 0xd76aa478);
    D = FF(D, A, B, C, M[1], S12, 0xe8c7b756);
    C = FF(C, D, A, B, M[2], S13, 0x242070db);
    B = FF(B, C, D, A, M[3], S14, 0xc1bdceee);
    A = FF(A, B, C, D, M[4], S11, 0xf57c0faf);
    D = FF(D, A, B, C, M[5], S12, 0x4787c62a);
    C = FF(C, D, A, B, M[6], S13, 0xa8304613);
    B = FF(B, C, D, A, M[7], S14, 0xfd469501);
    A = FF(A, B, C, D, M[8], S11, 0x698098d8);
    D = FF(D, A, B, C, M[9], S12, 0x8b44f7af);
    C = FF(C, D, A, B, M[10], S13, 0xffff5bb1);
    B = FF(B, C, D, A, M[11], S14, 0x895cd7be);
    A = FF(A, B, C, D, M[12], S11, 0x6b901122);
    D = FF(D, A, B, C, M[13], S12, 0xfd987193);
    C = FF(C, D, A, B, M[14], S13, 0xa679438e);
    B = FF(B, C, D, A, M[15], S14, 0x49b40821);

    // 第 2 轮
    A = GG(A, B, C, D, M[1], S21, 0xf61e2562);
    D = GG(D, A, B, C, M[6], S22, 0xc040b340);
    C = GG(C, D, A, B, M[11], S23, 0x265e5a51);
    B = GG(B, C, D, A, M[0], S24, 0xe9b6c7aa);
    A = GG(A, B, C, D, M[5], S21, 0xd62f105d);
    D = GG(D, A, B, C, M[10], S22, 0x02441453);
    C = GG(C, D, A, B, M[15], S23, 0xd8a1e681);
    B = GG(B, C, D, A, M[4], S24, 0xe7d3fbc8);
    A = GG(A, B, C, D, M[9], S21, 0x21e1cde6);
    D = GG(D, A, B, C, M[14], S22, 0xc33707d6);
    C = GG(C, D, A, B, M[3], S23, 0xf4d50d87);
    B = GG(B, C, D, A, M[8], S24, 0x455a14ed);
    A = GG(A, B, C, D, M[13], S21, 0xa9e3e905);
    D = GG(D, A, B, C, M[2], S22, 0xfcefa3f8);
    C = GG(C, D, A, B, M[7], S23, 0x676f02d9);
    B = GG(B, C, D, A, M[12], S24, 0x8d2a4c8a);

    // 第 3 轮
    A = HH(A, B, C, D, M[5], S31, 0xfffa3942);
    D = HH(D, A, B, C, M[8], S32, 0x8771f681);
    C = HH(C, D, A, B, M[11], S33, 0x6d9d6122);
    B = HH(B, C, D, A, M[14], S34, 0xfde5380c);
    A = HH(A, B, C, D, M[1], S31, 0xa4beea44);
    D = HH(D, A, B, C, M[4], S32, 0x4bdecfa9);
    C = HH(C, D, A, B, M[7], S33, 0xf6bb4b60);
    B = HH(B, C, D, A, M[10], S34, 0xbebfbc70);
    A = HH(A, B, C, D, M[13], S31, 0x289b7ec6);
    D = HH(D, A, B, C, M[0], S32, 0xeaa127fa);
    C = HH(C, D, A, B, M[3], S33, 0xd4ef3085);
    B = HH(B, C, D, A, M[6], S34, 0x04881d05);
    A = HH(A, B, C, D, M[9], S31, 0xd9d4d039);
    D = HH(D, A, B, C, M[12], S32, 0xe6db99e5);
    C = HH(C, D, A, B, M[15], S33, 0x1fa27cf8);
    B = HH(B, C, D, A, M[2], S34, 0xc4ac5665);

    // 第 4 轮
    A = II(A, B, C, D, M[0], S41, 0xf4292244);
    D = II(D, A, B, C, M[7], S42, 0x432aff97);
    C = II(C, D, A, B, M[14], S43, 0xab9423a7);
    B = II(B, C, D, A, M[5], S44, 0xfc93a039);
    A = II(A, B, C, D, M[12], S41, 0x655b59c3);
    D = II(D, A, B, C, M[3], S42, 0x8f0ccc92);
    C = II(C, D, A, B, M[10], S43, 0xffeff47d);
    B = II(B, C, D, A, M[1], S44, 0x85845dd1);
    A = II(A, B, C, D, M[8], S41, 0x6fa87e4f);
    D = II(D, A, B, C, M[15], S42, 0xfe2ce6e0);
    C = II(C, D, A, B, M[6], S43, 0xa3014314);
    B = II(B, C, D, A, M[13], S44, 0x4e0811a1);
    A = II(A, B, C, D, M[4], S41, 0xf7537e82);
    D = II(D, A, B, C, M[11], S42, 0xbd3af235);
    C = II(C, D, A, B, M[2], S43, 0x2ad7d2bb);
    B = II(B, C, D, A, M[9], S44, 0xeb86d391);

    a0 = AddUnsigned(a0, A);
    b0 = AddUnsigned(b0, B);
    c0 = AddUnsigned(c0, C);
    d0 = AddUnsigned(d0, D);
  }

  function toHexLE(x) {
    let s = '';
    for (let i = 0; i < 4; i++) {
      const b = (x >>> (i * 8)) & 0xff;
      s += (b < 16 ? '0' : '') + b.toString(16);
    }
    return s;
  }

  return toHexLE(a0) + toHexLE(b0) + toHexLE(c0) + toHexLE(d0);
}

        // ===== WBI 签名（页面主世界内联，不依赖扩展环境）=====
        const WBI_MIXIN_TAB = [
          46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
          33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
          61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
          36, 20, 34, 44, 52
        ];
        function wbiGetMixinKey(navData) {
          const imgUrl = navData.data.wbi_img.img_url;
          const subUrl = navData.data.wbi_img.sub_url;
          const imgKey = imgUrl.split('/').pop().split('.')[0];
          const subKey = subUrl.split('/').pop().split('.')[0];
          const raw = imgKey + subKey;
          return WBI_MIXIN_TAB.map((i) => raw[i]).join('').slice(0, 32);
        }
        function wbiSignParams(params, mixinKey) {
          params.wts = Math.round(Date.now() / 1000);
          const filterVal = (v) => String(v).replace(/[!'()*]/g, '');
          const sorted = Object.keys(params).sort();
          const q = sorted.map((k) => k + '=' + encodeURIComponent(filterVal(params[k]))).join('&');
          params.w_rid = md5(q + mixinKey);
          return Object.keys(params).sort().map((k) => k + '=' + encodeURIComponent(filterVal(params[k]))).join('&');
        }

        // ===== MAIN world 直连 B站 API 拿字幕（带登录 cookie + 正确 Referer，绕开 CC 按钮）=====
        async function tryApiSubtitles(bvid, cid, aid) {
          try {
            if (!bvid || !cid) return { ok: false, stage: 'no-video-info' };
            const navRes = await fetch('https://api.bilibili.com/x/web-interface/nav', { credentials: 'include' });
            const navJ = await navRes.json();
            if (!navJ || navJ.code !== 0) return { ok: false, code: navJ ? navJ.code : -1, stage: 'nav' };
            const mk = wbiGetMixinKey(navJ);
            const params = { bvid: bvid, cid: cid };
            if (aid) params.aid = aid;
            const qs = wbiSignParams(params, mk);
            let pJ = null;
            try {
              const pRes = await fetch('https://api.bilibili.com/x/player/wbi/v2?' + qs, { credentials: 'include' });
              pJ = await pRes.json();
            } catch (e) {
              const pRes2 = await fetch('https://api.bilibili.com/x/player/v2?bvid=' + encodeURIComponent(bvid) + '&cid=' + cid + (aid ? '&aid=' + aid : ''), { credentials: 'include' });
              pJ = await pRes2.json();
            }
            if (!pJ || pJ.code !== 0) return { ok: false, code: pJ ? pJ.code : -1, stage: 'player' };
            const subs = (pJ.data && pJ.data.subtitle && pJ.data.subtitle.subtitles) || [];
            if (!subs.length) return { ok: false, code: 0, stage: 'empty', subs: 0 };
            let got = 0;
            let dlErr = '';
            for (const sub of subs.slice(0, 6)) {
              try {
                let u = sub.subtitle_url;
                if (!u) { if (!dlErr) dlErr = 'no-url'; continue; }
                if (u.indexOf('//') === 0) u = 'https:' + u;
                else if (u.indexOf('http') !== 0) u = 'https://' + u;
                // 字幕 JSON 在 CDN 域（i0.hdslb.com / aisubtitle.hdslb.com）。
                // 带 credentials 的跨域请求会被 CORS 拒绝（Allow-Origin 带凭证时不能为 *），
                // 而字幕正文本身无需登录态 → 优先不带凭证请求，失败再退回带凭证。
                let r = null;
                try {
                  r = await fetch(u, { credentials: 'omit' });
                  if (!r.ok) throw new Error('HTTP ' + r.status);
                } catch (e1) {
                  r = await fetch(u, { credentials: 'include' });
                }
                const j = await r.json();
                if (j && Array.isArray(j.body) && j.body.length) {
                  window.__biliDigestCaptured.push({ url: u, body: j.body, raw: j, via: 'api' });
                  got++;
                }
              } catch (e2) {
                if (!dlErr) dlErr = String((e2 && e2.message) || e2);
              }
            }
            return {
              ok: got > 0,
              count: subs.length,
              got: got,
              stage: got > 0 ? undefined : (subs.length ? 'download-failed' : 'empty'),
              dlError: dlErr || undefined
            };
          } catch (e) {
            return { ok: false, stage: 'exception', error: String((e && e.message) || e) };
          }
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
        // 返回状态：not-found / clicked(原关闭→点击开启) / toggled(原开启→先关后开强制重新请求) / already-on
        function findSubtitleBtn() {
          const sels = [
            '.bpx-player-ctrl-subtitle-btn',
            '[class*="subtitle-btn"]',
            '.bpx-player-ctrl-subtitle',
            '.bilibili-player-video-subtitle-btn',
            '[class*="subtitleBtn"]',
            '.bpx-player-ctrl-subtitle-btn-text',
            '.bpx-player-subtitle-btn'
          ];
          for (const sel of sels) {
            const el = document.querySelector(sel);
            if (el) return el;
          }
          return null;
        }

        function isBtnOn(btn) {
          const cls = ((btn.className || '') + ' ' + (btn.getAttribute ? (btn.getAttribute('data-state') || '') : '')).toLowerCase();
          const html = (btn.innerHTML || '').toLowerCase();
          return /(active|on|open)/.test(cls) || /(active|on)/.test(html);
        }

        function ensureSubtitleOn() {
          const btn = findSubtitleBtn();
          if (!btn) return 'not-found';
          if (payload.diag) payload.diag.ccBtnClass = (btn.className || '').toString().slice(0, 90);
          const on = isBtnOn(btn);
          if (on) {
            // 已开启：先关再开，强制播放器用带 hook 后的上下文重新请求字幕
            try { btn.click(); } catch (e) {}
            setTimeout(() => { try { btn.click(); } catch (e) {} }, 450);
            return 'toggled';
          }
          try { btn.click(); } catch (e) {}
          return 'clicked';
        }

        // payload 必须定义在 func 作用域（而非下面的 async IIFE 内部）：
        // ensureSubtitleOn 等函数与 payload 同属 func 作用域，若 payload 定义在 IIFE 内，
        // 外层函数按词法作用域看不见它，调用时会抛 ReferenceError: payload is not defined。
        const payload = { source: 'bili-digest-extract', subtitles: null, videoInfo: null, playinfo: null, captured: null, diag: { hook: true, ccAction: 'pending', apiTry: null } };
        return (async () => {
          installHook();
          window.__biliDigestCaptured = window.__biliDigestCaptured || [];
          window.__biliDigestCaptured.length = 0; // 清空上次的残留
          const deadline = Date.now() + 6000;
          let ccAction = 'pending';
          let apiTried = false;

          // 页面 BV 号 / P 号（用于兜底拿 videoInfo）
          const bvidMatch = (location.pathname || '').match(/BV[0-9A-Za-z]+/);
          const pageBvid = bvidMatch ? bvidMatch[0] : '';
          const pMatch = (location.search || '').match(/[?&]p=(\d+)/);
          const pageP = pMatch ? Number(pMatch[1]) : 1;

          // 兜底：__INITIAL_STATE__ 缺失 videoInfo 时，直接调 view 接口（带登录 cookie）拿，
          // 否则后续 API 直连字幕无法触发，会全盘失败。
          if (!payload.videoInfo && pageBvid) {
            try {
              const vj = await fetch('https://api.bilibili.com/x/web-interface/view?bvid=' + encodeURIComponent(pageBvid), { credentials: 'include' }).then((r) => r.json());
              if (vj && vj.code === 0 && vj.data) {
                const d = vj.data;
                const pages = d.pages || [];
                const pg = pages[Math.min(pageP, pages.length) - 1] || pages[0] || {};
                payload.videoInfo = {
                  aid: d.aid, bvid: d.bvid, cid: pg.cid || 0, title: d.title || '',
                  pic: cleanPic(d.pic), up: (d.owner && d.owner.name) || '',
                  duration: d.duration || 0, pages: pages.length || 1
                };
                payload.diag.viewApi = 'ok';
              } else {
                payload.diag.viewApi = 'empty:' + (vj ? vj.code : -1);
              }
            } catch (e) {
              payload.diag.viewApi = 'err:' + (e && e.message || e);
            }
          }

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

            // 2.5) MAIN world 直连 API 拿字幕（绕开 CC 按钮；仅尝试一次）
            if (payload.videoInfo && !apiTried) {
              apiTried = true;
              try {
                payload.diag.apiTry = await tryApiSubtitles(payload.videoInfo.bvid, payload.videoInfo.cid, payload.videoInfo.aid);
                if (payload.diag.apiTry && payload.diag.apiTry.ok) {
                  try { console.log('[B站深度阅读] API 直连拿到字幕:', payload.diag.apiTry.got, '条'); } catch (e) {}
                }
              } catch (e) {
                payload.diag.apiTry = { ok: false, stage: 'exception', error: String(e && e.message || e) };
              }
            }

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
            // 未找到按钮则每轮重试（播放器 UI 可能晚加载）；已点击/已切换后不再重复点（避免误关）
            if ((!payload.subtitles || !payload.captured) && (ccAction === 'pending' || ccAction === 'not-found')) {
              ccAction = ensureSubtitleOn();
              payload.diag.ccAction = ccAction;
            }

            if ((payload.captured && payload.captured.length) || (payload.subtitles && payload.subtitles.length)) break;
            await wait(350);
          }

          // 若 playinfo 含循环引用/不可序列化对象，回退到只返回字幕列表
          try {
            JSON.stringify(payload.playinfo);
          } catch (_) {
            payload.playinfo = null;
          }
          return payload;
        })().catch((e) => ({
          source: 'bili-digest-extract',
          error: String((e && e.message) || e),
          videoInfo: null, subtitles: null, captured: null, playinfo: null,
          diag: { hook: true, ccAction: 'pending', apiTry: null, extractError: String((e && e.message) || e) }
        }));
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
