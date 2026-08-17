// settings.js — 设置读写（侧边栏 / 设置页共用）
// 所有数据仅保存在浏览器本地 chrome.storage.local

const DigestSettings = {
  DEFAULTS: {
    apiKey: '',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-v4-flash',
    temperature: 0.5,
    maxTokens: 4000
  },
  STORAGE_KEY: 'digest:settings',

  async get() {
    const data = await chrome.storage.local.get(DigestSettings.STORAGE_KEY);
    return Object.assign({}, DigestSettings.DEFAULTS, data[DigestSettings.STORAGE_KEY] || {});
  },

  async save(settings) {
    const cur = await DigestSettings.get();
    await chrome.storage.local.set({
      [DigestSettings.STORAGE_KEY]: Object.assign({}, cur, settings)
    });
  },

  async reset() {
    await chrome.storage.local.remove(DigestSettings.STORAGE_KEY);
  }
};
