// Utilidades de audio: decodificación a 16 kHz mono, troceado en silencios y codificación WAV.

export const SAMPLE_RATE = 16000;

/**
 * Decodifica cualquier archivo de audio/vídeo soportado por el navegador
 * a un Float32Array mono a 16 kHz (la frecuencia nativa de Whisper).
 */
export async function decodeToMono16k(file) {
  const buffer = await file.arrayBuffer();
  const AC = window.AudioContext || window.webkitAudioContext;

  let decoded;
  try {
    // Decodificar directamente a 16 kHz ahorra mucha memoria en audios largos.
    const ctx = new AC({ sampleRate: SAMPLE_RATE });
    try {
      decoded = await ctx.decodeAudioData(buffer.slice(0));
    } finally {
      ctx.close?.();
    }
  } catch {
    const ctx = new AC();
    try {
      decoded = await ctx.decodeAudioData(buffer);
    } catch {
      throw new Error('El navegador no ha podido leer el audio de este archivo. Prueba a convertirlo a MP3 o WAV.');
    } finally {
      ctx.close?.();
    }
  }

  if (decoded.sampleRate === SAMPLE_RATE) return mixdown(decoded);

  const length = Math.ceil(decoded.duration * SAMPLE_RATE);
  const offline = new OfflineAudioContext(1, length, SAMPLE_RATE);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start();
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0).slice();
}

function mixdown(audioBuffer) {
  const n = audioBuffer.numberOfChannels;
  if (n === 1) return audioBuffer.getChannelData(0).slice();
  const out = new Float32Array(audioBuffer.length);
  for (let c = 0; c < n; c++) {
    const data = audioBuffer.getChannelData(c);
    for (let i = 0; i < data.length; i++) out[i] += data[i];
  }
  for (let i = 0; i < out.length; i++) out[i] /= n;
  return out;
}

/**
 * Divide el audio en trozos de como máximo `maxSec` segundos, cortando en el
 * punto más silencioso de los últimos `searchSec` segundos de cada trozo para
 * no partir palabras por la mitad.
 * @returns {{start:number,end:number}[]} índices de muestra
 */
export function splitAtSilences(samples, maxSec, searchSec = 30) {
  const max = Math.floor(maxSec * SAMPLE_RATE);
  const search = Math.floor(Math.min(searchSec, maxSec / 3) * SAMPLE_RATE);
  const frame = Math.floor(0.1 * SAMPLE_RATE);
  const ranges = [];
  let start = 0;

  while (samples.length - start > max) {
    const hardEnd = start + max;
    let bestPos = hardEnd;
    let bestEnergy = Infinity;
    for (let pos = hardEnd - search; pos + frame <= hardEnd; pos += frame) {
      let sum = 0;
      for (let i = pos; i < pos + frame; i++) sum += samples[i] * samples[i];
      if (sum < bestEnergy) {
        bestEnergy = sum;
        bestPos = pos + (frame >> 1);
      }
    }
    ranges.push({ start, end: bestPos });
    start = bestPos;
  }
  ranges.push({ start, end: samples.length });
  return ranges;
}

/** Codifica muestras float a un WAV PCM de 16 bits mono. */
export function encodeWav(samples, sampleRate = SAMPLE_RATE) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, samples.length * 2, true);

  let off = 44;
  for (let i = 0; i < samples.length; i++, off += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

/** Duración de un archivo leyendo sus metadatos con un elemento <audio>. */
export function probeDuration(url) {
  return new Promise((resolve) => {
    const el = document.createElement('audio');
    el.preload = 'metadata';
    const done = (v) => { el.removeAttribute('src'); resolve(v); };
    el.onloadedmetadata = () => {
      if (el.duration === Infinity) {
        // Las grabaciones WebM de MediaRecorder no traen duración: forzamos su cálculo.
        el.ontimeupdate = () => { el.ontimeupdate = null; done(el.duration); };
        el.currentTime = 1e9;
      } else {
        done(el.duration);
      }
    };
    el.onerror = () => done(NaN);
    el.src = url;
  });
}
