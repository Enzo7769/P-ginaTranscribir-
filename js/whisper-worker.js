// Web Worker que ejecuta Whisper en el navegador con Transformers.js (WebGPU o WASM).
import { pipeline, WhisperTextStreamer, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1/dist/transformers.min.js';

env.allowLocalModels = false;

const CHUNK_S = 30;
const STRIDE_S = 5;

let transcriber = null;
let loadedKey = null;

async function load({ model, device, dtype }) {
  const key = `${model}|${device}|${JSON.stringify(dtype)}`;
  if (transcriber && loadedKey === key) return;
  if (transcriber) {
    await transcriber.dispose?.();
    transcriber = null;
  }

  const files = new Map();
  transcriber = await pipeline('automatic-speech-recognition', model, {
    device,
    dtype,
    progress_callback: (p) => {
      if (p.status === 'progress' && p.total) {
        files.set(p.file, { loaded: p.loaded, total: p.total });
        let loaded = 0, total = 0;
        for (const f of files.values()) { loaded += f.loaded; total += f.total; }
        self.postMessage({ type: 'download', loaded, total });
      }
    },
  });
  loadedKey = key;
}

async function transcribe({ audio, language }) {
  const sr = transcriber.processor.feature_extractor.config.sampling_rate;
  const window = CHUNK_S * sr;
  const jump = (CHUNK_S - 2 * STRIDE_S) * sr;
  const totalChunks = audio.length <= window ? 1 : Math.ceil((audio.length - window) / jump) + 1;

  const timePrecision =
    transcriber.processor.feature_extractor.config.chunk_length / transcriber.model.config.max_source_positions;

  let done = 0;
  let live = '';
  const streamer = new WhisperTextStreamer(transcriber.tokenizer, {
    time_precision: timePrecision,
    skip_prompt: true,
    callback_function: (text) => {
      live += text;
      self.postMessage({ type: 'partial', text: live, chunk: done, totalChunks });
    },
    on_finalize: () => {
      done++;
      live = '';
      self.postMessage({ type: 'chunk', chunk: done, totalChunks });
    },
  });

  const output = await transcriber(audio, {
    language: language || null,
    task: 'transcribe',
    chunk_length_s: CHUNK_S,
    stride_length_s: STRIDE_S,
    return_timestamps: true,
    streamer,
  });

  return output;
}

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'load') {
      await load(msg);
      self.postMessage({ type: 'ready' });
    } else if (msg.type === 'transcribe') {
      const output = await transcribe(msg);
      self.postMessage({ type: 'done', output });
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: err?.message || String(err) });
  }
};
