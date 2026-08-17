// options.js — 设置页逻辑

(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);

  async function loadForm() {
    const s = await DigestSettings.get();
    $('#apiKey').value = s.apiKey || '';
    $('#baseUrl').value = s.baseUrl || '';
    // 模型名迁移：deepseek-chat / deepseek-reasoner 已于 2026-07-24 退役
    let model = s.model || 'deepseek-v4-flash';
    if (model === 'deepseek-chat' || model === 'deepseek-reasoner') {
      model = 'deepseek-v4-flash';
      await DigestSettings.save({ model }); // 持久化迁移，避免下次再读旧值
    }
    $('#model').value = model;
    $('#temperature').value = s.temperature !== undefined ? s.temperature : 0.5;
  }

  function readForm() {
    return {
      apiKey: $('#apiKey').value.trim(),
      baseUrl: $('#baseUrl').value.trim() || 'https://api.deepseek.com',
      model: $('#model').value.trim() || 'deepseek-v4-flash',
      temperature: Math.min(1, Math.max(0, Number($('#temperature').value) || 0.5))
    };
  }

  function showTestResult(text, kind) {
    const el = $('#test-result');
    el.textContent = text;
    el.className = 'test-result' + (kind ? ' ' + kind : '');
  }

  $('#btn-save').addEventListener('click', async () => {
    await DigestSettings.save(readForm());
    const btn = $('#btn-save');
    btn.textContent = '已保存 ✓';
    setTimeout(() => { btn.textContent = '保存设置'; }, 1600);
  });

  $('#btn-test').addEventListener('click', async () => {
    await DigestSettings.save(readForm());
    const btn = $('#btn-test');
    btn.disabled = true;
    showTestResult('正在测试连接…');
    try {
      const res = await callDeepSeek(
        [{ role: 'user', content: DIGEST_PROMPTS.testUser }],
        { maxTokens: 50, timeout: 60 }
      );
      showTestResult('连接成功：模型回复「' + res + '」', 'ok');
    } catch (e) {
      showTestResult('连接失败：' + e.message, 'err');
    } finally {
      btn.disabled = false;
    }
  });

  $('#btn-reset').addEventListener('click', async () => {
    if (!confirm('确定恢复默认设置吗？已保存的笔记与概览缓存不会受影响。')) return;
    await DigestSettings.reset();
    await loadForm();
    showTestResult('已恢复默认设置', 'ok');
  });

  loadForm();
})();
