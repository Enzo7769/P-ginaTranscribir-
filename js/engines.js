// Motores de transcripción. Todos devuelven { text, segments: [{start, end, text, speaker?}], language?, approxTimes? }
import { SAMPLE_RATE, decodeToMono16k, splitAtSilences, encodeWav } from './audio.js';

export class CancelledError extends Error {
  constructor() { super('Transcripción cancelada'); this.name = 'CancelledError'; }
}

/* ------------------------------------------------------------------ */
/* Local: Whisper en el navegador                                      */
/* ------------------------------------------------------------------ */

let worker = null;

export async function detectWebGPU() {
  try {
    if (!navigator.gpu) return { webgpu: false };
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return { webgpu: false };
    return { webgpu: true, fp16: adapter.features.has('shader-f16') };
  } catch {
    return { webgpu: false };
  }
}

function getWorker() {
  if (!worker) worker = new Worker(new URL('./whisper-worker.js', import.meta.url), { type: 'module' });
  return worker;
}

export async function transcribeLocal({ samples, model, language, gpu, onProgress, signal }) {
  const device = gpu.webgpu ? 'webgpu' : 'wasm';
  const dtype = gpu.webgpu
    ? { encoder_model: gpu.fp16 ? 'fp16' : 'fp32', decoder_model_merged: 'q4' }
    : { encoder_model: 'q8', decoder_model_merged: 'q8' };

  const w = getWorker();

  const output = await new Promise((resolve, reject) => {
    const onAbort = () => {
      w.terminate();
      worker = null;
      reject(new CancelledError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    w.onmessage = (e) => {
      const m = e.data;
      switch (m.type) {
        case 'download':
          onProgress({ phase: 'download', loaded: m.loaded, total: m.total });
          break;
        case 'ready':
          onProgress({ phase: 'transcribe', done: 0, total: 1 });
          w.postMessage({ type: 'transcribe', audio: samples, language });
          break;
        case 'partial':
          onProgress({ phase: 'transcribe', done: m.chunk, total: m.totalChunks, live: m.text });
          break;
        case 'chunk':
          onProgress({ phase: 'transcribe', done: m.chunk, total: m.totalChunks });
          break;
        case 'done':
          signal?.removeEventListener('abort', onAbort);
          resolve(m.output);
          break;
        case 'error':
          signal?.removeEventListener('abort', onAbort);
          w.terminate();
          worker = null;
          reject(new Error(friendlyLocalError(m.message, device)));
          break;
      }
    };
    w.onerror = (e) => {
      signal?.removeEventListener('abort', onAbort);
      w.terminate();
      worker = null;
      reject(new Error('No se pudo iniciar el motor local. Comprueba tu conexión a internet (la primera vez hay que descargar el motor y el modelo) y que usas un navegador moderno (Chrome, Edge, Firefox o Safari recientes).' + (e.message ? `\n\nDetalle: ${e.message}` : '')));
    };

    onProgress({ phase: 'loading' });
    w.postMessage({ type: 'load', model, device, dtype });
  });

  const duration = samples.length / SAMPLE_RATE;
  const segments = (output.chunks || [])
    .map((c) => ({
      start: c.timestamp?.[0] ?? 0,
      end: c.timestamp?.[1] ?? duration,
      text: c.text.trim(),
    }))
    .filter((s) => s.text);

  const cleaned = cleanHallucinations(segments);
  return {
    text: cleaned.length ? joinSegments(cleaned) : (output.text || '').trim(),
    segments: cleaned,
  };
}

function friendlyLocalError(msg, device) {
  if (/memory|allocation|OOM|out of range/i.test(msg)) {
    return `El equipo se ha quedado sin memoria ejecutando el modelo (${device}). Prueba con un modelo más pequeño o un motor en la nube.\n\nDetalle: ${msg}`;
  }
  if (/fetch|network|Failed to load|locate file/i.test(msg)) {
    return `No se pudo descargar el modelo. Comprueba tu conexión.\n\nDetalle: ${msg}`;
  }
  return msg;
}

// Whisper a veces "alucina" frases de los subtítulos con los que se entrenó o repite en bucle.
const HALLUCINATIONS = [
  /subt[ií]tulos (realizados )?por la comunidad de amara\.org/i,
  /^(subtitles|subtitulado) by .*amara\.org/i,
];

function cleanHallucinations(segments) {
  const out = [];
  for (const s of segments) {
    if (HALLUCINATIONS.some((re) => re.test(s.text))) continue;
    // Colapsa repeticiones idénticas consecutivas (3 o más) típicas de bucles de decodificación.
    const n = out.length;
    if (n >= 2 && out[n - 1].text === s.text && out[n - 2].text === s.text) {
      out[n - 1].end = s.end;
      continue;
    }
    out.push(s);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* HTTP con progreso de subida y cancelación                           */
/* ------------------------------------------------------------------ */

function postForm(url, headers, form, { onUpload, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new CancelledError());
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onUpload?.(e.loaded / e.total); };
    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch { data = xhr.responseText; }
      resolve({ status: xhr.status, data });
    };
    xhr.onerror = () => reject(new Error('No se pudo conectar con el servicio. Revisa tu conexión a internet (o un bloqueador de anuncios/extensión que impida la petición).'));
    xhr.ontimeout = () => reject(new Error('El servicio tardó demasiado en responder.'));
    const onAbort = () => { xhr.abort(); reject(new CancelledError()); };
    signal?.addEventListener('abort', onAbort, { once: true });
    xhr.onloadend = () => signal?.removeEventListener('abort', onAbort);
    xhr.send(form);
  });
}

function apiError(provider, status, data) {
  const detail =
    (typeof data === 'object' && data && (data.error?.message || data.detail?.message || data.detail?.status ||
      (typeof data.detail === 'string' ? data.detail : null) || data.message)) ||
    (typeof data === 'string' ? data.slice(0, 300) : '') ||
    '';
  let hint = '';
  if (status === 401 || status === 403) hint = 'La API key no es válida o no tiene permisos para transcribir.';
  else if (status === 413) hint = 'El archivo es demasiado grande para este servicio.';
  else if (status === 429) hint = 'Has superado el límite de uso o te has quedado sin saldo.';
  else if (status >= 500) hint = 'El servicio tiene problemas ahora mismo. Inténtalo de nuevo en unos minutos.';
  return new Error(`${provider} respondió con error ${status}. ${hint}${detail ? `\n\nDetalle: ${detail}` : ''}`);
}

/* ------------------------------------------------------------------ */
/* OpenAI y Groq (API compatible con OpenAI)                           */
/* ------------------------------------------------------------------ */

const OPENAI_FORMATS = ['flac', 'm4a', 'mp3', 'mp4', 'mpeg', 'mpga', 'oga', 'ogg', 'wav', 'webm'];
const MAX_UPLOAD = 24 * 1024 * 1024;

export async function transcribeOpenAICompat({
  provider, apiKey, model, file, duration, getSamples, language, vocab, diarize, onProgress, signal,
}) {
  const base = provider === 'groq' ? 'https://api.groq.com/openai/v1' : 'https://api.openai.com/v1';
  const name = provider === 'groq' ? 'Groq' : 'OpenAI';
  if (provider === 'groq' && !apiKey.startsWith('gsk_')) {
    throw new Error(
      apiKey.startsWith('xai-')
        ? 'Esa clave es de Grok (xAI), no de Groq. Son empresas distintas.\n\nConsigue una clave gratis de Groq (empieza por «gsk_») en console.groq.com/keys.'
        : 'Las claves de Groq empiezan por «gsk_». Consigue una gratis en console.groq.com/keys.',
    );
  }
  if (diarize && provider === 'openai') model = 'gpt-4o-transcribe-diarize';

  const isGpt = /^gpt-/.test(model);
  const isDiarize = /diarize/.test(model);
  // gpt-4o-transcribe limita la longitud de salida: trozos de 5 min evitan textos cortados.
  const maxChunk = isGpt && !isDiarize ? 300 : 600;

  const ext = (file.name.split('.').pop() || '').toLowerCase();
  const fits = file.size <= MAX_UPLOAD && OPENAI_FORMATS.includes(ext) && (!duration || duration <= maxChunk);

  let pieces;
  if (fits) {
    pieces = [{ blob: file, name: file.name, offset: 0, dur: duration || 0 }];
  } else {
    onProgress({ phase: 'prepare' });
    const samples = await getSamples();
    if (signal?.aborted) throw new CancelledError();
    pieces = splitAtSilences(samples, maxChunk).map((r, i) => ({
      blob: encodeWav(samples.subarray(r.start, r.end)),
      name: `parte-${i + 1}.wav`,
      offset: r.start / SAMPLE_RATE,
      dur: (r.end - r.start) / SAMPLE_RATE,
    }));
  }

  const allSegments = [];
  const texts = [];
  let detectedLang;
  let approx = false;

  for (let i = 0; i < pieces.length; i++) {
    const p = pieces[i];
    const form = new FormData();
    form.append('file', p.blob, p.name);
    form.append('model', model);
    if (language) form.append('language', language);

    if (isDiarize) {
      form.append('response_format', 'diarized_json');
      form.append('chunking_strategy', 'auto');
    } else if (isGpt) {
      form.append('response_format', 'json');
    } else {
      form.append('response_format', 'verbose_json');
      form.append('timestamp_granularities[]', 'segment');
    }

    if (!isDiarize) {
      const prompt = buildPrompt(vocab, texts.join(' '), provider === 'groq' || !isGpt ? 600 : 1500);
      if (prompt) form.append('prompt', prompt);
    }

    const { status, data } = await postForm(`${base}/audio/transcriptions`, { Authorization: `Bearer ${apiKey}` }, form, {
      signal,
      onUpload: (f) => onProgress({ phase: 'upload', part: i + 1, parts: pieces.length, fraction: f }),
    });
    if (status < 200 || status >= 300) throw apiError(name, status, data);

    const res = typeof data === 'string' ? { text: data } : data;
    if (res.language) detectedLang = res.language;
    const text = (res.text || '').trim();
    texts.push(text);

    if (Array.isArray(res.segments) && res.segments.length) {
      for (const s of res.segments) {
        const t = (s.text || '').trim();
        if (!t) continue;
        allSegments.push({
          start: p.offset + (s.start || 0),
          end: p.offset + (s.end || 0),
          text: t,
          ...(s.speaker != null ? { speaker: String(s.speaker) } : {}),
        });
      }
    } else if (text) {
      approx = true;
      allSegments.push(...estimateSentenceTimes(text, p.offset, p.dur || duration || 0));
    }
  }

  return {
    text: allSegments.some((s) => s.speaker != null) ? joinSegments(allSegments) : texts.filter(Boolean).join('\n\n'),
    segments: allSegments,
    language: detectedLang,
    approxTimes: approx,
  };
}

function buildPrompt(vocab, previous, maxLen) {
  const v = (vocab || '').trim();
  let prompt = v ? `${v}.` : '';
  if (previous) {
    const room = Math.max(0, maxLen - prompt.length - 1);
    let tail = previous.slice(-room);
    if (tail.length < previous.length) tail = tail.replace(/^\S*\s/, '');
    prompt = (prompt ? prompt + ' ' : '') + tail;
  }
  return prompt.slice(0, maxLen);
}

/** Cuando el modelo no da marcas de tiempo, las estima repartiendo la duración por frases. */
function estimateSentenceTimes(text, offset, dur) {
  const sentences = text.match(/[^.!?…\n]+[.!?…]+["»”')\]]*|[^.!?…\n]+$/g)?.map((s) => s.trim()).filter(Boolean) || [text];
  const total = sentences.reduce((a, s) => a + s.length, 0) || 1;
  let t = offset;
  return sentences.map((s) => {
    const d = (s.length / total) * dur;
    const seg = { start: t, end: t + d, text: s };
    t += d;
    return seg;
  });
}

/* ------------------------------------------------------------------ */
/* ElevenLabs Scribe                                                    */
/* ------------------------------------------------------------------ */

export async function transcribeElevenLabs({ apiKey, model, file, language, vocab, diarize, tagEvents, onProgress, signal }) {
  const keyterms = (vocab || '')
    .split(/[,;\n]/)
    .map((t) => t.trim())
    .filter((t) => t && t.length <= 50)
    .slice(0, 1000);

  const send = async (withKeyterms) => {
    const form = new FormData();
    form.append('file', file, file.name);
    form.append('model_id', model || 'scribe_v2');
    form.append('timestamps_granularity', 'word');
    form.append('diarize', diarize ? 'true' : 'false');
    form.append('tag_audio_events', tagEvents ? 'true' : 'false');
    if (language) form.append('language_code', language);
    if (withKeyterms) for (const k of keyterms) form.append('keyterms', k);
    return postForm('https://api.elevenlabs.io/v1/speech-to-text', { 'xi-api-key': apiKey }, form, {
      signal,
      onUpload: (f) => onProgress({ phase: 'upload', part: 1, parts: 1, fraction: f }),
    });
  };

  let { status, data } = await send(keyterms.length > 0);
  let keytermsDropped = false;
  if (keyterms.length && status >= 400 && status < 500 && /keyterm/i.test(JSON.stringify(data))) {
    ({ status, data } = await send(false));
    keytermsDropped = true;
  }
  if (status < 200 || status >= 300) throw apiError('ElevenLabs', status, data);

  const segments = groupWords(data.words || [], diarize);
  return {
    text: diarize ? joinSegments(segments) : (data.text || '').trim(),
    segments,
    language: data.language_code,
    warning: keytermsDropped ? 'Este modelo no admite términos clave; se ha transcrito sin vocabulario.' : undefined,
  };
}

/** Agrupa palabras con tiempos en segmentos legibles (por hablante, pausa o fin de frase). */
function groupWords(words, bySpeaker) {
  const segments = [];
  let cur = null;
  const flush = () => {
    if (cur) {
      cur.text = cur.text.replace(/\s+/g, ' ').trim();
      if (cur.text) segments.push(cur);
    }
    cur = null;
  };

  for (const w of words) {
    if (w.type === 'spacing') {
      if (cur) cur.text += w.text;
      continue;
    }
    const speaker = bySpeaker ? w.speaker_id : undefined;
    const gap = cur ? w.start - cur.end : 0;
    const dur = cur ? w.end - cur.start : 0;
    if (cur && (speaker !== cur.speaker || gap > 1.2 || (dur > 6 && /[.!?…]$/.test(cur.text.trim())) || dur > 20)) {
      flush();
    }
    if (!cur) cur = { start: w.start, end: w.end, text: '', ...(speaker != null ? { speaker } : {}) };
    if (w.type === 'audio_event') cur.text += ` ${/^\(.*\)$/.test(w.text) ? w.text : `(${w.text})`} `;
    else cur.text += w.text;
    cur.end = w.end;
  }
  flush();
  return segments;
}

/* ------------------------------------------------------------------ */

export function joinSegments(segments) {
  const hasSpeakers = segments.some((s) => s.speaker != null);
  if (!hasSpeakers) return segments.map((s) => s.text).join(' ').replace(/\s+/g, ' ').trim();
  const blocks = [];
  for (const s of segments) {
    const last = blocks[blocks.length - 1];
    if (last && last.speaker === s.speaker) last.text += ' ' + s.text;
    else blocks.push({ speaker: s.speaker, text: s.text });
  }
  return blocks.map((b) => `${speakerName(b.speaker)}: ${b.text}`).join('\n\n');
}

export function speakerName(id) {
  if (id == null) return '';
  const m = String(id).match(/(\d+)$/);
  if (m) return `Hablante ${Number(m[1]) + 1}`;
  return `Hablante ${id}`;
}

export { decodeToMono16k };
