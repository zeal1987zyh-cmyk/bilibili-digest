// preview.js —— 界面预览页专用脚本（与扩展真实逻辑解耦，纯示例数据）
// 抽成外部文件以满足 MV3 的 Content Security Policy（禁止内联脚本）

// ---------- 示例数据 ----------
const demoOverview = {
  summary: "这期视频用 40 分钟讲清了传统 PM 转向 AI PM 的四个关键切换：从确定性功能到概率型体验、从流程画布到 Agent 编排、从埋点到观测、从 PRD 到提示词工程。",
  keyPoints: [
    "传统 PRD 描述的是‘确定发生什么’，AI 产品要定义‘在不确定性下如何优雅失败’。",
    "Agent 设计不是把大模型当搜索框，而是把它当作能调用工具、能回退、能自我纠错的协作者。",
    "提示词工程不是文案润色，而是产品逻辑在模型侧的映射。",
    "评估 AI 产品不能只看准确率，还要看置信度、可解释性与用户控制感。",
    "PM 要懂的不是 Transformer 实现细节，而是能力边界、延迟与成本的三角权衡。"
  ],
  chapters: [
    { title: "开场：为什么传统 PM 觉得 AI 产品‘不可控’", start: 0, end: 320, points: ["列举常见的确定性产品假设", "引出概率型体验的设计命题"] },
    { title: "核心模型：Agent 的感知-推理-行动环", start: 320, end: 1240, points: ["拆解 Agent 三要素：工具、记忆、规划", "对比单轮问答与多轮 Agent 的差异"] },
    { title: "实操：把需求文档翻译成提示词", start: 1240, end: 2100, points: ["Role / Context / Instruction / Output 四层结构", "少样本示例与边界约束的书写原则"] },
    { title: "落地：评估、上线与持续迭代", start: 2100, end: 2680, points: ["离线指标 vs 在线用户满意度", "如何利用日志做 Bad Case 复盘"] }
  ],
  quotes: [
    { time: 385, text: "不要把大模型当成一个更聪明的搜索框，它不是来回答问题的，它是来和你一起干活的。" },
    { time: 1560, text: "最好的提示词不是最长的提示词，而是最能约束模型不跑偏的提示词。" }
  ]
};

const demoSegments = [
  { start: 0, text: "大家好，欢迎来到产品圆桌派。今天我们要聊的话题，可能是最近半年被问到最多的：传统产品经理怎么转型做 AI 产品经理？" },
  { start: 45, text: "很多人第一次用大模型的时候，会觉得它很聪明，但用到产品上又觉得很不稳定。这其实不是技术问题，而是设计假设问题。" },
  { start: 125, text: "以前我们做功能，写完 PRD 之后，开发出来的结果应该是确定的。同一个输入，永远给出同一个输出。" },
  { start: 210, text: "但 AI 产品不是。同一个提示词，模型可能这次答得好，下次就答偏。我们要做的第一件事，就是接受这种不确定性。" },
  { start: 340, text: "Agent 的底层结构可以简单理解为三个环：感知、推理、行动。感知是读取环境，推理是决定下一步，行动是调用工具或输出内容。" },
  { start: 540, text: "一个好的 Agent 不是一次把活干完，而是会不断地和环境交互，错了能回退，卡住能求助。" },
  { start: 1320, text: "把需求翻译成提示词，我推荐用四层结构：Role、Context、Instruction、Output。先用角色框定能力范围，再用上下文给出背景。" },
  { start: 1580, text: "Instruction 是核心任务，Output 是你希望它输出的格式。如果有典型例子，一定要给少样本示例，这是提升稳定性的关键。" }
];

const demoNotes = [
  { id: 1, time: 385, text: "不要把大模型当搜索框，而是把它当作协作者。" },
  { id: 2, time: 1560, text: "提示词的关键是约束模型不跑偏，而不是写得越长越好。" }
];

// ---------- 渲染函数（独立预览用，与真实逻辑解耦） ----------
const $ = s => document.querySelector(s);
const fmt = s => { const m = Math.floor(s/60).toString().padStart(2,'0'), sec = (s%60).toString().padStart(2,'0'); return `${m}:${sec}`; };
const el = (tag, cls, text) => { const n=document.createElement(tag); if(cls)n.className=cls; if(text!==undefined)n.textContent=text; return n; };

function renderOverview() {
  const box = $('#tab-overview');
  box.innerHTML = '<div class="panel-toolbar"><button class="btn primary">生成 AI 概览</button><span class="inline-status">已生成示例概览</span></div>';
  const wrap = el('div','overview-content');
  const o = demoOverview;

  const c1 = el('div','ov-card'); c1.appendChild(el('h3','','视频摘要')); c1.appendChild(el('p','ov-summary',o.summary)); wrap.appendChild(c1);

  const c2 = el('div','ov-card'); c2.appendChild(el('h3','','核心要点')); const ul=el('ul','ov-points'); o.keyPoints.forEach(p=>ul.appendChild(el('li','',p))); c2.appendChild(ul); wrap.appendChild(c2);

  const c3 = el('div','ov-card'); c3.appendChild(el('h3','','章节划分')); o.chapters.forEach(ch=>{
    const item=el('div','chapter-item'); const head=el('div','chapter-head'); head.appendChild(el('span','chapter-title',ch.title)); head.appendChild(el('button','time-chip',fmt(ch.start)+' – '+fmt(ch.end))); item.appendChild(head);
    const upl=el('ul','chapter-points'); ch.points.forEach(p=>upl.appendChild(el('li','',p))); item.appendChild(upl); c3.appendChild(item);
  }); wrap.appendChild(c3);

  const c4 = el('div','ov-card'); c4.appendChild(el('h3','','值得记住的金句')); o.quotes.forEach(q=>{ const it=el('div','quote-item'); it.appendChild(el('button','time-chip',fmt(q.time))); it.appendChild(el('span','quote-text','“'+q.text+'”')); c4.appendChild(it); }); wrap.appendChild(c4);
  box.appendChild(wrap);
}

function renderTranscript() {
  const box = $('#tab-transcript');
  box.innerHTML = '<div class="panel-toolbar transcript-toolbar"><div class="seg-control"><button class="seg active">原文</button><button class="seg">双语</button><button class="seg">中文</button></div><div class="toolbar-actions"><button class="btn ghost small">翻译全文</button><button class="btn ghost small">解释选中</button></div></div>';
  const body = el('div','transcript-body');
  demoSegments.forEach(seg => {
    const item = el('div','seg-item');
    item.appendChild(el('div','seg-meta', '')).appendChild(el('button','time-chip',fmt(seg.start)));
    item.appendChild(el('div','seg-orig',seg.text));
    body.appendChild(item);
  });
  box.appendChild(body);
}

function renderNotes() {
  const box = $('#tab-notes');
  box.innerHTML = '<div class="panel-toolbar"><button class="btn primary small">记录当前时刻笔记</button><button class="btn ghost small">导出 Markdown</button></div>';
  const body = el('div','notes-body');
  demoNotes.forEach(n => {
    const item = el('div','note-item');
    const head = el('div','note-head'); head.appendChild(el('button','time-chip',fmt(n.time)));
    const acts = el('div','note-actions'); acts.appendChild(el('button','note-act','AI 润色')); acts.appendChild(el('button','note-act danger','删除')); head.appendChild(acts);
    item.appendChild(head);
    const ta = el('textarea','note-text'); ta.value = n.text; item.appendChild(ta);
    body.appendChild(item);
  });
  box.appendChild(body);
}

function switchTab(name) {
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + name));
}

document.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));

// 缩略图加载失败时回退底色（替代原先的 onerror 内联处理器）
const thumb = document.querySelector('.video-thumb');
if (thumb) thumb.addEventListener('error', () => { thumb.style.background = '#2c333d'; });

renderOverview();
renderTranscript();
renderNotes();
