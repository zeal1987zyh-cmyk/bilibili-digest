// content.js — 注入 B 站页面的内容脚本
// 职责：提取视频信息、获取字幕（三层降级）、支持视频跳转与取当前播放时间
//
// 字幕获取优先级：
//   1. 页面内嵌 __playinfo__ / __INITIAL_STATE__（零网络请求，最可靠）
//   2. background 中继调 B 站 API（绕过 MV3 content script CORS 限制）
//   3. 直接 fetch B 站 API（兜底）

(() => {
  const BV_RE = /\/video\/(BV[0-9A-Za-z]+)/;

  const MIXIN_KEY_ENC_TAB = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
    33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
    61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
    36, 20, 34, 44, 52
  ];

  function log(...args) {
    console.log('[B站深度阅读]', ...args);
  }

  function apiErrorMsg(code, fallback) {
    const map = {
      '-400': '请求参数错误',
      '-403': '该接口需要登录，请先在浏览器中登录 B 站',
      '-404': '视频不存在或已被删除',
      '-412': '请求被风控拦截，请稍后重试',
      '62002': '稿件不可见（私密或已删除）'
    };
    return map[String(code)] || fallback + '（错误码 ' + code + '）';
  }

  function getBvid() {
    const m = location.pathname.match(BV_RE);
    return m ? m[1] : null;
  }

  function getP() {
    const p = parseInt(new URLSearchParams(location.search).get('p') || '1', 10);
    return Number.isFinite(p) && p >= 1 ? p : 1;
  }

  /* =========================================================
   * 方法 1：从页面内嵌数据提取（__playinfo__ + __INITIAL_STATE__）
   * 零网络请求，最可靠
   * ========================================================= */

  /**
   * 通过 background 的 scripting.executeScript 在页面主世界（MAIN world）读取
   * window.__playinfo__ / window.__INITIAL_STATE__。
   * 这比 DOM 注入 <script> 更干净，不会触发页面 CSP。
   */
  async function injectPageScript() {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { type: 'digest:extract-page-data' },
        (resp) => {
          if (chrome.runtime.lastError) {
            reject(new Error('页面数据提取失败: ' + chrome.runtime.lastError.message));
            return;
          }
          if (!resp || !resp.ok) {
            reject(new Error((resp && resp.error) || '页面数据提取失败'));
            return;
          }
          resolve(resp.data || null);
        }
      );
    });
  }

  /* =========================================================
   * 方法 2：通过 background 中继调 API（绕过 MV3 CORS 限制）
   * ========================================================= */

  function bgFetch(url) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { type: 'digest:bg-fetch', url: url },
        (resp) => {
          if (chrome.runtime.lastError) {
            reject(new Error('后台请求失败: ' + chrome.runtime.lastError.message));
            return;
          }
          if (!resp) {
            reject(new Error('后台请求无响应'));
            return;
          }
          if (!resp.ok) {
            reject(new Error(resp.error || '后台请求失败'));
            return;
          }
          resolve(resp.data);
        }
      );
    });
  }

  /* =========================================================
   * 方法 3：直接 fetch（兜底）
   * ========================================================= */

  async function directFetch(url) {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) throw new Error('网络请求失败 (HTTP ' + res.status + ')');
    return res.json();
  }

  /* =========================================================
   * 视频信息获取（优先 __INITIAL_STATE__，降级 API）
   * ========================================================= */

  async function getVideoInfo(bvid, p, pageData) {
    // 优先用页面内嵌数据
    if (pageData && pageData.videoInfo) {
      log('视频信息来源: 页面内嵌 __INITIAL_STATE__');
      const vi = pageData.videoInfo;
      // 如果是多 P，需要从 API 拿正确的 cid
      if (vi.pages > 1 && p > 1) {
        try {
          const j = await fetchViaBestMethod('https://api.bilibili.com/x/web-interface/view?bvid=' + encodeURIComponent(bvid));
          if (j && j.code === 0) {
            const pages = j.data.pages || [];
            const pg = pages[Math.min(p, pages.length) - 1] || {};
            return {
              bvid: j.data.bvid, aid: j.data.aid, title: j.data.title,
              pic: j.data.pic, up: (j.data.owner && j.data.owner.name) || '',
              desc: j.data.desc || '', cid: pg.cid, part: pg.part || '',
              duration: j.data.duration || 0, pages: pages.length,
              p: Math.min(p, pages.length)
            };
          }
        } catch (e) {
          log('多 P 信息获取降级失败，使用默认 cid:', e.message);
        }
      }
      return {
        bvid: vi.bvid, aid: vi.aid, title: vi.title,
        pic: vi.pic, up: vi.up, desc: '', cid: vi.cid,
        part: '', duration: vi.duration, pages: vi.pages, p: p
      };
    }

    // 降级到 API
    log('视频信息来源: API');
    const j = await fetchViaBestMethod('https://api.bilibili.com/x/web-interface/view?bvid=' + encodeURIComponent(bvid));
    if (!j || j.code !== 0) throw new Error(apiErrorMsg(j ? j.code : -1, '无法获取视频信息'));
    const d = j.data;
    const pages = d.pages || [];
    const pg = pages[Math.min(p, pages.length) - 1] || { cid: d.cid, part: '' };
    return {
      bvid: d.bvid, aid: d.aid, title: d.title, pic: d.pic,
      up: (d.owner && d.owner.name) || '', desc: d.desc || '',
      cid: pg.cid, part: pg.part || '', duration: d.duration || 0,
      pages: pages.length, p: Math.min(p, pages.length)
    };
  }

  /* =========================================================
   * 综合获取：尝试所有方法
   * ========================================================= */

  async function fetchViaBestMethod(url) {
    // 方法 2：background 中继
    try {
      const data = await bgFetch(url);
      log('API 请求成功 (background 中继):', url.slice(0, 80));
      return data;
    } catch (e1) {
      log('background 中继失败:', e1.message);
      // 方法 3：直接 fetch 兜底
      try {
        const data = await directFetch(url);
        log('API 请求成功 (直接 fetch):', url.slice(0, 80));
        return data;
      } catch (e2) {
        log('直接 fetch 也失败:', e2.message);
        throw new Error(e1.message + '；直接请求也失败: ' + e2.message);
      }
    }
  }

  // WBI 签名
  function getWbiMixinKey(navData) {
    const imgUrl = navData.data.wbi_img.img_url;
    const subUrl = navData.data.wbi_img.sub_url;
    const imgKey = imgUrl.split('/').pop().split('.')[0];
    const subKey = subUrl.split('/').pop().split('.')[0];
    const raw = imgKey + subKey;
    return MIXIN_KEY_ENC_TAB.map((i) => raw[i]).join('').slice(0, 32);
  }

  function wbiSign(params, mixinKey) {
    params.wts = Math.round(Date.now() / 1000);
    // 过滤特殊字符（B 站要求去掉 !'()*-._~ 以外的字符）
    const filterVal = (v) => String(v).replace(/[!'()*]/g, '');
    const sorted = Object.keys(params).sort();
    const q = sorted.map((k) => k + '=' + encodeURIComponent(filterVal(params[k]))).join('&');
    params.w_rid = md5(q + mixinKey);
    return Object.keys(params).sort().map((k) => k + '=' + encodeURIComponent(filterVal(params[k]))).join('&');
  }

  // 通过 API 获取字幕列表
  async function getSubtitleListViaApi(bvid, cid) {
    // 先获取 nav 数据（用于 WBI 签名）
    const navJ = await fetchViaBestMethod('https://api.bilibili.com/x/web-interface/nav');
    if (!navJ || navJ.code !== 0) {
      throw new Error('无法获取接口签名密钥（错误码 ' + (navJ ? navJ.code : -1) + '）');
    }

    const mixinKey = getWbiMixinKey(navJ);
    const qs = wbiSign({ bvid: bvid, cid: cid }, mixinKey);

    let j;
    try {
      j = await fetchViaBestMethod('https://api.bilibili.com/x/player/wbi/v2?' + qs);
    } catch (e) {
      log('WBI 接口失败，尝试旧接口:', e.message);
      j = await fetchViaBestMethod('https://api.bilibili.com/x/player/v2?bvid=' + encodeURIComponent(bvid) + '&cid=' + cid);
    }

    if (!j || j.code !== 0) {
      throw new Error(apiErrorMsg(j ? j.code : -1, '无法获取字幕列表'));
    }

    const subs = (j.data && j.data.subtitle && j.data.subtitle.subtitles) || [];
    return subs;
  }

  // 选字幕
  function pickSubtitle(list) {
    if (!list || !list.length) return null;
    const rank = (s) => {
      const lan = s.lan || '';
      let score = 0;
      if (lan === 'zh-CN' || lan === 'zh-Hans' || lan === 'zh-Hant') score += 100;
      else if (lan === 'zh' || lan.startsWith('zh')) score += 90;
      else if (lan === 'ai-zh') score += 80;
      else if (lan.startsWith('ai')) score += 60;
      else if (lan === 'en') score += 40;
      if (s.ai_status === 0) score += 10;
      return score;
    };
    return list.slice().sort((a, b) => rank(b) - rank(a))[0];
  }

  // 下载字幕 JSON 文件
  async function fetchSubtitleJson(sub) {
    const url = sub.subtitle_url.startsWith('//') ? 'https:' + sub.subtitle_url : sub.subtitle_url;
    // 字幕文件在 hdslb.com 上，需要通过 background 中继或直接 fetch
    try {
      return await bgFetch(url);
    } catch (e) {
      log('background 下载字幕失败，直接 fetch:', e.message);
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) throw new Error('字幕文件下载失败 (HTTP ' + res.status + ')');
      return res.json();
    }
  }

  /* =========================================================
   * 主流程
   * ========================================================= */

  async function collectData() {
    const bvid = getBvid();
    if (!bvid) throw new Error('当前页面不是 B 站视频页');
    const p = getP();
    log('开始收集数据, bvid:', bvid, 'p:', p);

    // 先尝试从页面内嵌数据提取
    let pageData = null;
    try {
      pageData = await injectPageScript();
      if (pageData) {
        log('页面内嵌数据提取成功:',
          'subtitles:', pageData.subtitles ? pageData.subtitles.length + '条' : '无',
          'videoInfo:', pageData.videoInfo ? '有' : '无');
      }
    } catch (e) {
      log('页面内嵌数据提取失败:', e.message);
    }

    // 获取视频信息
    const video = await getVideoInfo(bvid, p, pageData);
    log('视频信息:', video.title, 'cid:', video.cid);

    // 获取字幕
    let subtitle = null;
    const errors = [];

    // 方法 1：从页面内嵌数据获取字幕列表
    if (pageData && pageData.subtitles && pageData.subtitles.length) {
      log('字幕来源: 页面内嵌 __playinfo__');
      try {
        const sub = pickSubtitle(pageData.subtitles);
        if (sub) {
          const j = await fetchSubtitleJson(sub);
          const body = (j.body || [])
            .map((l) => ({ from: l.from, to: l.to, content: String(l.content || '').trim() }))
            .filter((l) => l.content);
          subtitle = { lan: sub.lan || '', lanDoc: sub.lan_doc || '', ai: !!sub.ai_status, body: body };
          log('字幕加载成功 (页面内嵌):', subtitle.lan, body.length, '段');
        }
      } catch (e) {
        errors.push('页面内嵌字幕: ' + e.message);
        log('页面内嵌字幕获取失败:', e.message);
      }
    }

    // 方法 2：通过 API 获取字幕列表
    if (!subtitle) {
      log('尝试通过 API 获取字幕...');
      try {
        const subs = await getSubtitleListViaApi(bvid, video.cid);
        log('API 返回字幕列表:', subs.length, '条');
        const sub = pickSubtitle(subs);
        if (sub) {
          const j = await fetchSubtitleJson(sub);
          const body = (j.body || [])
            .map((l) => ({ from: l.from, to: l.to, content: String(l.content || '').trim() }))
            .filter((l) => l.content);
          subtitle = { lan: sub.lan || '', lanDoc: sub.lan_doc || '', ai: !!sub.ai_status, body: body };
          log('字幕加载成功 (API):', subtitle.lan, body.length, '段');
        } else if (subs.length === 0) {
          errors.push('API 返回字幕列表为空（该视频可能没有 API 可见的字幕）');
        }
      } catch (e) {
        errors.push('API 字幕: ' + e.message);
        log('API 字幕获取失败:', e.message);
      }
    }

    // 方法 3：直接从 __playinfo__ 里找（如果前面没提取到字幕列表但有完整 playinfo）
    if (!subtitle && pageData && pageData.playinfo) {
      try {
        const pi = pageData.playinfo;
        // 有些 playinfo 结构不同，尝试多种路径
        const subPaths = [
          pi && pi.data && pi.data.subtitle && pi.data.subtitle.subtitles,
          pi && pi.subtitle && pi.subtitle.subtitles,
        ];
        for (const subs of subPaths) {
          if (subs && subs.length) {
            log('从 __playinfo__ 备用路径找到字幕:', subs.length, '条');
            const sub = pickSubtitle(subs);
            if (sub) {
              const j = await fetchSubtitleJson(sub);
              const body = (j.body || [])
                .map((l) => ({ from: l.from, to: l.to, content: String(l.content || '').trim() }))
                .filter((l) => l.content);
              subtitle = { lan: sub.lan || '', lanDoc: sub.lan_doc || '', ai: !!sub.ai_status, body: body };
              log('字幕加载成功 (playinfo 备用路径):', subtitle.lan, body.length, '段');
              break;
            }
          }
        }
      } catch (e) {
        errors.push('playinfo 备用: ' + e.message);
      }
    }

    if (!subtitle) {
      const errDetail = errors.length ? errors.join('；') : '该视频可能没有可获取的字幕（需要 UP 主开启 AI 字幕或上传 CC 字幕）';
      log('所有字幕获取方法均失败:', errDetail);
      subtitle = { error: errDetail, body: [] };
    }

    return { ok: true, video: video, subtitle: subtitle };
  }

  /* =========================================================
   * 视频控制
   * ========================================================= */

  function findVideoEl() {
    return document.querySelector('video.bilibili-player-video')
      || document.querySelector('#bilibili-player video')
      || document.querySelector('video');
  }

  function seekTo(time) {
    const v = findVideoEl();
    if (!v) return false;
    try {
      v.currentTime = Math.max(0, time);
      v.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return true;
    } catch (e) {
      return false;
    }
  }

  function getCurrentTime() {
    const v = findVideoEl();
    return v ? (v.currentTime || 0) : 0;
  }

  /* =========================================================
   * 本地语音转写：实时录制视频音轨
   * 说明：受 B 站跨域限制，无法瞬间抓取音频文件，只能用
   * captureStream + MediaRecorder 随播放实时录音，再交侧边栏本地转写。
   * ========================================================= */

  let _recorder = null;
  let _recChunks = null;
  let _recStream = null;
  let _recTimer = null;
  let _recVideo = null;

  async function startTranscribeRecording() {
    const v = findVideoEl();
    if (!v) return { ok: false, error: '未找到视频播放器' };
    if (_recorder) return { ok: false, error: '已在录音中' };

    let stream;
    try {
      stream = v.captureStream();
    } catch (e) {
      return { ok: false, error: '无法捕获视频音频流：' + e.message };
    }
    const audioTracks = stream.getAudioTracks();
    if (!audioTracks.length) return { ok: false, error: '该视频没有音轨（可能是纯画面或无声视频）' };

    const audioStream = new MediaStream(audioTracks);
    _recChunks = [];
    _recorder = new MediaRecorder(audioStream);
    _recStream = stream;
    _recVideo = v;

    _recorder.ondataavailable = (e) => { if (e.data && e.data.size) _recChunks.push(e.data); };

    // 视频播放结束自动停止
    const onEnded = () => { stopTranscribeRecording().then(postDone); };
    v.addEventListener('ended', onEnded, { once: true });
    _recVideo._digestEnded = onEnded;

    _recorder.start(1000); // 每 1s 产出一段，便于进度

    // 自动从头播放（取消静音以保证音轨被捕获）
    try {
      v.currentTime = 0;
      v.muted = false;
      await v.play();
    } catch (e) { /* 自动播放可能被拦截，提示用户手动播放 */ }

    // 进度回报
    _recTimer = setInterval(() => {
      const cur = v.currentTime || 0;
      const dur = v.duration || 0;
      chrome.runtime.sendMessage({
        type: 'transcribe-progress',
        current: cur,
        duration: dur
      });
    }, 1000);

    return { ok: true };
  }

  function postDone(blob) {
    if (!blob) { chrome.runtime.sendMessage({ type: 'transcribe-done', ok: false, error: '录音为空' }); return; }
    chrome.runtime.sendMessage({ type: 'transcribe-done', ok: true, blob: blob });
  }

  function stopTranscribeRecording() {
    return new Promise((resolve) => {
      if (!_recorder) { resolve(null); return; }
      const recorder = _recorder;
      recorder.onstop = () => {
        const blob = new Blob(_recChunks, { type: recorder.mimeType || 'audio/webm' });
        if (_recTimer) clearInterval(_recTimer);
        if (_recVideo && _recVideo._digestEnded) {
          _recVideo.removeEventListener('ended', _recVideo._digestEnded);
          delete _recVideo._digestEnded;
        }
        if (_recStream) _recStream.getTracks().forEach((t) => t.stop());
        _recorder = null; _recChunks = null; _recStream = null; _recVideo = null;
        resolve(blob);
      };
      try { recorder.stop(); } catch (e) { resolve(null); }
    });
  }

  /* =========================================================
   * 消息处理
   * ========================================================= */

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'digest:get-data') {
      collectData().then(sendResponse).catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;
    }
    if (msg.type === 'digest:seek') {
      sendResponse({ ok: seekTo(Number(msg.time) || 0) });
      return false;
    }
    if (msg.type === 'digest:get-time') {
      sendResponse({ ok: true, time: getCurrentTime() });
      return false;
    }
    if (msg.type === 'digest:transcribe-start') {
      startTranscribeRecording().then(sendResponse);
      return true;
    }
    if (msg.type === 'digest:transcribe-stop') {
      stopTranscribeRecording().then(postDone);
      sendResponse({ ok: true });
      return false;
    }
  });
})();
