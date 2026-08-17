// whisper-worker.js — 本地 Whisper 语音转写（Transformers.js, WASM）
// 在独立线程运行，避免转写期间阻塞界面。
// 通过 importScripts 加载打包好的 transformers.min.js（位于扩展根目录 libs/）。

importScripts('libs/transformers.min.js');

const T = self.transformers || (self.module && self.module.exports);
let transcriber = null;
let loadedModel = null;

self.onmessage = async (e) => {
  const msg = e.data || {};
  if (msg.type !== 'transcribe') return;

  const model = msg.model || 'Xenova/whisper-tiny';
  const language = msg.language || 'chinese';
  const audio = msg.audio; // Float32Array, 16kHz 单声道 PCM

  try {
    if (!transcriber || loadedModel !== model) {
      self.postMessage({ type: 'status', phase: 'model', msg: '正在加载语音识别模型（首次约需下载 40MB，之后会缓存）…' });
      transcriber = await T.pipeline('automatic-speech-recognition', model, {
        device: 'wasm',
        dtype: 'q8'
      });
      loadedModel = model;
    }

    self.postMessage({ type: 'status', phase: 'transcribe', msg: '正在转写音频（本地运算，不会上传）…' });

    const output = await transcriber(audio, {
      language: language,
      chunk_length_s: 30,
      stride_length_s: 5,
      return_timestamps: true,
      // 流式回调：每处理完一个 chunk 即回传部分文本
      callback_function: (d) => {
        if (d && typeof d.text === 'string') {
          self.postMessage({ type: 'progress', text: d.text });
        }
      }
    });

    self.postMessage({
      type: 'done',
      text: output && output.text ? output.text : '',
      chunks: output && output.chunks ? output.chunks : null
    });
  } catch (err) {
    self.postMessage({ type: 'error', error: (err && err.message) || String(err) });
  }
};
