// prompts.js — 中文 AI 提示词模板

const DIGEST_PROMPTS = {
  overviewSystem:
    '你是一位资深知识提炼助手。用户会给你一段视频字幕文稿，请用简体中文提炼结构化内容，帮助用户快速掌握视频核心价值。',

  overviewUser: (text) =>
    '请分析下面的视频文稿，并输出严格的 JSON 对象（不要输出 JSON 以外的任何内容），字段如下：\n' +
    '{\n' +
    '  "summary": "一句话概括视频主旨，不超过 60 字",\n' +
    '  "keyPoints": ["核心要点1", "核心要点2", ...]（3~8 条，每条不超过 40 字）,\n' +
    '  "chapters": [{"title": "章节标题", "start": 起始秒数, "end": 结束秒数, "points": ["该章节要点"]}]（按时间顺序覆盖全文）,\n' +
    '  "quotes": [{"time": 秒数, "text": "值得记住的原话，不超过 60 字"}]\n' +
    '}\n' +
    '要求：chapters 的 start/end 必须是数字秒数；quotes 的 time 必须是数字秒数。\n\n' +
    '文稿如下：\n' +
    text,

  explainSystem:
    '你是一位耐心的学习助手，用简体中文解释用户从视频文稿中选中的内容，讲清楚含义、背景与关键信息。',

  explainUser: (selected, context) =>
    '以下是用户从视频文稿中选中的内容：\n「' + selected + '」\n\n' +
    '相关上下文：\n' + context + '\n\n' +
    '请用简体中文解释这段话（200 字以内，直接输出解释内容）。',

  polishSystem:
    '你是一位文字润色助手，只做润色，不改动原意，不添加原笔记中没有的信息。',

  polishUser: (text) =>
    '请将下面的学习笔记润色得更通顺、更精炼、更有条理（保留所有关键信息，不超过 120 字，直接输出结果）：\n\n' + text,

  translateSystem:
    '你是一位专业字幕翻译。把用户提供的视频字幕翻译成简体中文，口语自然、保留原意，只输出译文，不要加任何解释。',

  translateUser: (text) => '请将以下视频字幕翻译为简体中文：\n\n' + text,

  testUser: '请只回复两个字：成功'
};
