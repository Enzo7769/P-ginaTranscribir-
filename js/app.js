import {
  detectWebGPU, transcribeLocal, transcribeOpenAICompat, transcribeElevenLabs,
  decodeToMono16k, CancelledError, speakerName,
} from './engines.js';
import { probeDuration } from './audio.js';
import { toSRT, toVTT, toTimestampedText, toDoc, download, fmtShort } from './export.js';

const $ = (id) => document.getElementById(id);

/* ------------------------------------------------------------------ */
/* Almacenamiento seguro                                               */
/* ------------------------------------------------------------------ */

const store = {
  get(key, fallback = null) {
    try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
  },
  remove(key) { try { localStorage.removeItem(key); } catch { /* sin almacenamiento */ } },
};

/* ------------------------------------------------------------------ */
/* Idiomas                                                             */
/* ------------------------------------------------------------------ */

const LANGUAGES = [
  ['', 'Detectar automáticamente'],
  ['es', 'Español'], ['en', 'Inglés'], ['pt', 'Portugués'], ['ca', 'Catalán'], ['gl', 'Gallego'], ['eu', 'Euskera'],
  ['fr', 'Francés'], ['it', 'Italiano'], ['de', 'Alemán'], ['nl', 'Neerlandés'], ['pl', 'Polaco'], ['ro', 'Rumano'],
  ['ru', 'Ruso'], ['uk', 'Ucraniano'], ['tr', 'Turco'], ['ar', 'Árabe'], ['he', 'Hebreo'], ['hi', 'Hindi'],
  ['zh', 'Chino'], ['ja', 'Japonés'], ['ko', 'Coreano'], ['vi', 'Vietnamita'], ['id', 'Indonesio'], ['th', 'Tailandés'],
  ['sv', 'Sueco'], ['da', 'Danés'], ['no', 'Noruego'], ['fi', 'Finés'], ['el', 'Griego'], ['cs', 'Checo'], ['hu', 'Húngaro'],
];
const langName = (code) => LANGUAGES.find(([c]) => c === code)?.[1] || code || '—';

/* ------------------------------------------------------------------ */
/* Estado                                                              */
/* ------------------------------------------------------------------ */

const state = {
  file: null,
  url: null,
  duration: NaN,
  samples: null,
  result: null,
  abort: null,
  gpu: { webgpu: false },
  busy: false,
};

const ENGINE_LABEL = { local: 'Local (Whisper)', openai: 'OpenAI', elevenlabs: 'ElevenLabs', groq: 'Groq' };
const SPEAKER_COLORS = ['#4f46e5', '#0f8a5f', '#c2410c', '#be185d', '#0369a1', '#7c3aed', '#a16207', '#0d9488'];

/* ------------------------------------------------------------------ */
/* Tema                                                                */
/* ------------------------------------------------------------------ */

function applyTheme(theme) {
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}
applyTheme(store.get('tx-theme'));
$('themeToggle').addEventListener('click', () => {
  const current = document.documentElement.dataset.theme ||
    (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const next = current === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  store.set('tx-theme', next);
});

/* ------------------------------------------------------------------ */
/* Ajustes                                                             */
/* ------------------------------------------------------------------ */

const settings = Object.assign(
  { engine: 'local', language: 'es', localModel: 'onnx-community/whisper-large-v3-turbo', openaiModel: 'gpt-4o-transcribe',
    elevenModel: 'scribe_v2', groqModel: 'whisper-large-v3', diarize: false, tagEvents: false, rememberKey: true, vocab: '' },
  store.get('tx-settings', {}),
);
const keys = store.get('tx-keys', {});

function saveSettings() { store.set('tx-settings', settings); }

const langSel = $('language');
for (const [code, name] of LANGUAGES) langSel.add(new Option(name, code));
langSel.value = settings.language;

$('localModel').value = settings.localModel;
$('openaiModel').value = settings.openaiModel;
$('elevenModel').value = settings.elevenModel;
$('groqModel').value = settings.groqModel;
$('diarize').checked = settings.diarize;
$('tagEvents').checked = settings.tagEvents;
$('rememberKey').checked = settings.rememberKey;
$('vocab').value = settings.vocab;
for (const p of ['openai', 'elevenlabs', 'groq']) $(`key-${p}`).value = keys[p] || '';
document.querySelector(`input[name="engine"][value="${settings.engine}"]`).checked = true;

const bind = (id, key, prop = 'value') => $(id).addEventListener('change', () => { settings[key] = $(id)[prop]; saveSettings(); updateUI(); });
bind('language', 'language');
bind('localModel', 'localModel');
bind('openaiModel', 'openaiModel');
bind('elevenModel', 'elevenModel');
bind('groqModel', 'groqModel');
bind('diarize', 'diarize', 'checked');
bind('tagEvents', 'tagEvents', 'checked');
bind('vocab', 'vocab');
$('rememberKey').addEventListener('change', () => {
  settings.rememberKey = $('rememberKey').checked;
  saveSettings();
  persistKeys();
});

function persistKeys() {
  if (!settings.rememberKey) { store.remove('tx-keys'); return; }
  const k = {};
  for (const p of ['openai', 'elevenlabs', 'groq']) { const v = $(`key-${p}`).value.trim(); if (v) k[p] = v; }
  store.set('tx-keys', k);
}
for (const p of ['openai', 'elevenlabs', 'groq']) $(`key-${p}`).addEventListener('input', () => { persistKeys(); updateUI(); });

document.querySelectorAll('input[name="engine"]').forEach((r) =>
  r.addEventListener('change', () => { settings.engine = r.value; saveSettings(); updateUI(); }));

function updateUI() {
  const engine = settings.engine;
  document.querySelectorAll('.engine-settings').forEach((el) => { el.hidden = el.dataset.for !== engine; });
  $('rememberWrap').hidden = engine === 'local';
  $('diarizeWrap').hidden = !(engine === 'elevenlabs' || engine === 'openai');

  const vocabHint = $('vocabHint');
  const vocab = $('vocab');
  if (engine === 'local') {
    vocab.disabled = true;
    vocabHint.textContent = 'El motor local no admite vocabulario. Úsalo con ElevenLabs, OpenAI o Groq.';
  } else if (engine === 'openai' && (settings.diarize || /diarize/.test(settings.openaiModel))) {
    vocab.disabled = true;
    vocabHint.textContent = 'El modelo con hablantes de OpenAI no admite vocabulario.';
  } else {
    vocab.disabled = false;
    vocabHint.textContent = engine === 'elevenlabs'
      ? 'Se envían como «términos clave» a Scribe (coste adicional según tu plan).'
      : 'Ayuda al modelo a escribir bien nombres y jerga.';
  }

  const needsKey = engine !== 'local' && !$(`key-${engine}`).value.trim();
  const btn = $('transcribeBtn');
  btn.disabled = state.busy || !state.file || needsKey;
  btn.title = !state.file ? 'Primero añade un audio' : needsKey ? 'Introduce tu API key' : '';
}

/* ------------------------------------------------------------------ */
/* GPU                                                                 */
/* ------------------------------------------------------------------ */

detectWebGPU().then((gpu) => {
  state.gpu = gpu;
  const note = $('deviceNote');
  if (gpu.webgpu) {
    note.textContent = `✓ Aceleración por GPU disponible (WebGPU${gpu.fp16 ? ', fp16' : ''}). Velocidad alta.`;
    note.className = 'note note--ok';
  } else {
    note.textContent = 'Sin WebGPU: se usará la CPU (más lento). Para audios largos usa Chrome/Edge actualizado, un modelo más pequeño o un motor en la nube.';
    note.className = 'note note--warn';
  }
});

/* ------------------------------------------------------------------ */
/* Carga de audio                                                      */
/* ------------------------------------------------------------------ */

const fmtSize = (b) => (b > 1e9 ? `${(b / 1e9).toFixed(2)} GB` : b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.ceil(b / 1e3)} KB`);

async function setFile(file) {
  if (!file) return;
  if (state.url) URL.revokeObjectURL(state.url);
  state.file = file;
  state.samples = null;
  state.url = URL.createObjectURL(file);
  state.duration = NaN;
  state.resultHasAudio = false;

  $('fileInfo').hidden = false;
  $('fileName').textContent = file.name;
  $('fileMeta').textContent = fmtSize(file.size);
  $('player').src = state.url;
  hideError();
  updateUI();

  const d = await probeDuration(state.url);
  if (state.file !== file) return;
  state.duration = d;
  $('fileMeta').textContent = `${fmtSize(file.size)}${Number.isFinite(d) ? ' · ' + fmtShort(d) : ''}`;
}

function clearFile() {
  if (state.url) URL.revokeObjectURL(state.url);
  Object.assign(state, { file: null, url: null, samples: null, duration: NaN });
  $('player').removeAttribute('src');
  $('player').load();
  $('fileInfo').hidden = true;
  $('fileInput').value = '';
  updateUI();
}

$('fileInput').addEventListener('change', (e) => setFile(e.target.files[0]));
$('clearFile').addEventListener('click', clearFile);

const dz = $('dropzone');
['dragenter', 'dragover'].forEach((t) => dz.addEventListener(t, (e) => { e.preventDefault(); dz.classList.add('is-over'); }));
['dragleave', 'drop'].forEach((t) => dz.addEventListener(t, (e) => { e.preventDefault(); dz.classList.remove('is-over'); }));
dz.addEventListener('drop', (e) => setFile(e.dataTransfer.files[0]));
// Permite soltar en cualquier sitio de la página sin que el navegador abra el archivo.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  if (!dz.contains(e.target) && e.dataTransfer?.files?.[0]) setFile(e.dataTransfer.files[0]);
});

/* ------------------------------------------------------------------ */
/* Grabación                                                           */
/* ------------------------------------------------------------------ */

const rec = { recorder: null, stream: null, chunks: [], start: 0, timer: null, raf: null, ctx: null };

$('recordBtn').addEventListener('click', () => (rec.recorder ? stopRecording() : startRecording()));

async function startRecording() {
  hideError();
  try {
    rec.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (err) {
    showError(err?.name === 'NotAllowedError'
      ? 'No hay permiso para usar el micrófono. Actívalo en la configuración del navegador.'
      : 'No se pudo acceder al micrófono: ' + (err?.message || err));
    return;
  }

  const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']
    .find((t) => window.MediaRecorder?.isTypeSupported?.(t)) || '';
  rec.recorder = new MediaRecorder(rec.stream, mime ? { mimeType: mime, audioBitsPerSecond: 128000 } : undefined);
  rec.chunks = [];
  rec.recorder.ondataavailable = (e) => e.data.size && rec.chunks.push(e.data);
  rec.recorder.onstop = () => {
    const type = rec.recorder.mimeType || mime || 'audio/webm';
    const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
    const stamp = new Date().toISOString().slice(0, 16).replace('T', '_').replace(':', '-');
    const file = new File(rec.chunks, `grabacion_${stamp}.${ext}`, { type });
    rec.recorder = null;
    setFile(file);
  };
  rec.recorder.start(1000);
  rec.start = Date.now();

  $('recordBtn').classList.add('is-recording');
  $('recordLabel').textContent = 'Detener grabación';
  $('recordTime').hidden = false;
  $('recordMeter').hidden = false;
  rec.timer = setInterval(() => { $('recordTime').textContent = fmtShort((Date.now() - rec.start) / 1000); }, 250);
  drawMeter();
}

function stopRecording() {
  rec.recorder?.stop();
  rec.stream?.getTracks().forEach((t) => t.stop());
  clearInterval(rec.timer);
  cancelAnimationFrame(rec.raf);
  rec.ctx?.close();
  rec.ctx = null;
  $('recordBtn').classList.remove('is-recording');
  $('recordLabel').textContent = 'Grabar con el micrófono';
  $('recordTime').hidden = true;
  $('recordMeter').hidden = true;
  $('recordTime').textContent = '00:00';
}

function drawMeter() {
  const canvas = $('recordMeter');
  const g = canvas.getContext('2d');
  rec.ctx = new (window.AudioContext || window.webkitAudioContext)();
  const analyser = rec.ctx.createAnalyser();
  analyser.fftSize = 256;
  rec.ctx.createMediaStreamSource(rec.stream).connect(analyser);
  const data = new Uint8Array(analyser.fftSize);
  const bars = 24;
  const color = getComputedStyle(document.documentElement).getPropertyValue('--record').trim() || '#e5484d';
  const levels = new Array(bars).fill(0);
  let frame = 0;
  const loop = () => {
    analyser.getByteTimeDomainData(data);
    let peak = 0;
    for (const v of data) peak = Math.max(peak, Math.abs(v - 128) / 128);
    if (frame++ % 3 === 0) { levels.shift(); levels.push(peak); }
    g.clearRect(0, 0, canvas.width, canvas.height);
    g.fillStyle = color;
    const w = canvas.width / bars;
    levels.forEach((l, i) => {
      const h = Math.max(2, Math.min(1, l * 2.2) * canvas.height);
      g.fillRect(i * w + 1, (canvas.height - h) / 2, w - 2, h);
    });
    rec.raf = requestAnimationFrame(loop);
  };
  loop();
}

/* ------------------------------------------------------------------ */
/* Progreso y errores                                                  */
/* ------------------------------------------------------------------ */

function setProgress(label, fraction, live) {
  $('progress').hidden = false;
  $('progressLabel').textContent = label;
  const fill = $('progressFill');
  if (fraction == null) {
    fill.classList.add('is-indeterminate');
    $('progressPct').textContent = '';
  } else {
    fill.classList.remove('is-indeterminate');
    fill.style.width = `${Math.round(fraction * 100)}%`;
    $('progressPct').textContent = `${Math.round(fraction * 100)} %`;
  }
  const liveEl = $('progressLive');
  if (live) { liveEl.hidden = false; liveEl.textContent = '…' + live.slice(-220); }
  else if (live === null) liveEl.hidden = true;
}

function showError(msg, warn = false) {
  const box = $('errorBox');
  box.textContent = msg;
  box.classList.toggle('alert--warn', warn);
  box.hidden = false;
}
function hideError() { $('errorBox').hidden = true; }

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 2200);
}

/* ------------------------------------------------------------------ */
/* Transcripción                                                       */
/* ------------------------------------------------------------------ */

async function getSamples() {
  if (!state.samples) {
    setProgress('Decodificando audio…', null, null);
    state.samples = await decodeToMono16k(state.file);
  }
  return state.samples;
}

$('transcribeBtn').addEventListener('click', run);
$('cancelBtn').addEventListener('click', () => state.abort?.abort());

async function run() {
  if (!state.file || state.busy) return;
  const engine = settings.engine;
  const language = settings.language || '';
  const vocab = $('vocab').disabled ? '' : $('vocab').value.trim();
  const file = state.file;

  state.busy = true;
  state.abort = new AbortController();
  const signal = state.abort.signal;
  hideError();
  updateUI();
  setProgress('Preparando…', null, null);
  const t0 = performance.now();
  let transcribeStart = 0;

  const onProgress = (p) => {
    if (p.phase === 'loading') setProgress('Cargando modelo…', null);
    else if (p.phase === 'download') setProgress(`Descargando modelo (${fmtSize(p.loaded)} de ${fmtSize(p.total)})…`, p.loaded / p.total);
    else if (p.phase === 'prepare') setProgress('Preparando audio en fragmentos…', null);
    else if (p.phase === 'upload') {
      const part = p.parts > 1 ? ` (parte ${p.part} de ${p.parts})` : '';
      if (p.fraction < 1) setProgress(`Subiendo audio${part}…`, ((p.part - 1) + p.fraction * 0.3) / p.parts);
      else setProgress(`Transcribiendo en la nube${part}…`, ((p.part - 1) + 0.3) / p.parts);
    } else if (p.phase === 'transcribe') {
      if (!transcribeStart) transcribeStart = performance.now();
      let label = `Transcribiendo fragmento ${Math.min(p.done + 1, p.total)} de ${p.total}`;
      if (p.done > 0 && p.done < p.total) {
        const per = (performance.now() - transcribeStart) / p.done;
        label += ` · quedan ~${fmtShort((per * (p.total - p.done)) / 1000)}`;
      }
      setProgress(label, p.done / p.total, p.live);
    }
  };

  try {
    let result;
    let model;
    if (engine === 'local') {
      model = settings.localModel;
      const samples = await getSamples();
      if (signal.aborted) throw new CancelledError();
      result = await transcribeLocal({ samples, model, language, gpu: state.gpu, onProgress, signal });
    } else if (engine === 'openai' || engine === 'groq') {
      model = (engine === 'openai' ? settings.openaiModel : settings.groqModel).trim();
      if (engine === 'openai' && settings.diarize) model = 'gpt-4o-transcribe-diarize';
      result = await transcribeOpenAICompat({
        provider: engine, apiKey: $(`key-${engine}`).value.trim(), model, file,
        duration: state.duration, getSamples, language, vocab,
        diarize: engine === 'openai' && settings.diarize, onProgress, signal,
      });
    } else {
      model = settings.elevenModel.trim() || 'scribe_v2';
      setProgress('Subiendo audio…', 0);
      result = await transcribeElevenLabs({
        apiKey: $('key-elevenlabs').value.trim(), model, file, language, vocab,
        diarize: settings.diarize, tagEvents: settings.tagEvents, onProgress, signal,
      });
    }

    if (!result.text && !result.segments.length) {
      showError('No se ha detectado voz en el audio. Comprueba que el archivo tenga sonido y que el idioma sea correcto.', true);
    }

    const entry = {
      id: Date.now().toString(36),
      name: file.name.replace(/\.[^.]+$/, ''),
      date: new Date().toISOString(),
      engine,
      model,
      language: language || result.language || '',
      duration: Number.isFinite(state.duration) ? state.duration : (result.segments.at(-1)?.end || 0),
      elapsed: (performance.now() - t0) / 1000,
      text: result.text,
      segments: result.segments,
      approxTimes: !!result.approxTimes,
    };
    showResult(entry, true);
    saveHistory(entry);
    if (result.warning) showError(result.warning, true);
    toast('Transcripción completada');
  } catch (err) {
    if (err instanceof CancelledError || err?.name === 'CancelledError') toast('Transcripción cancelada');
    else { console.error(err); showError(err?.message || String(err)); }
  } finally {
    state.busy = false;
    state.abort = null;
    $('progress').hidden = true;
    $('progressLive').hidden = true;
    updateUI();
  }
}

/* ------------------------------------------------------------------ */
/* Resultado                                                           */
/* ------------------------------------------------------------------ */

const transcriptEl = $('transcript');
transcriptEl.addEventListener('input', () => {
  if (!state.result) return;
  state.result.text = transcriptEl.value;
  saveHistory(state.result);
});

function showResult(entry, withAudio) {
  state.result = entry;
  state.resultHasAudio = withAudio;
  $('emptyState').hidden = true;
  transcriptEl.hidden = false;
  transcriptEl.value = entry.text;
  $('copyBtn').disabled = false;
  $('downloadBtn').disabled = false;

  const words = entry.text.trim() ? entry.text.trim().split(/\s+/).length : 0;
  const speakers = new Set(entry.segments.map((s) => s.speaker).filter((s) => s != null)).size;
  const stats = [
    `<span>Motor: <b>${ENGINE_LABEL[entry.engine] || entry.engine}</b></span>`,
    `<span>Modelo: <b>${escapeHtml(entry.model || '—')}</b></span>`,
    `<span>Idioma: <b>${escapeHtml(langName(entry.language))}</b></span>`,
    entry.duration ? `<span>Duración: <b>${fmtShort(entry.duration)}</b></span>` : '',
    `<span>Palabras: <b>${words.toLocaleString('es')}</b></span>`,
    speakers ? `<span>Hablantes: <b>${speakers}</b></span>` : '',
    entry.elapsed ? `<span>Tiempo: <b>${fmtShort(entry.elapsed)}</b></span>` : '',
  ];
  $('stats').innerHTML = stats.filter(Boolean).join('');
  $('stats').hidden = false;

  renderSegments(entry);
  selectTab('text');
}

function renderSegments(entry) {
  const list = $('segments');
  list.innerHTML = '';
  const speakerIdx = new Map();
  const frag = document.createDocumentFragment();
  entry.segments.forEach((s, i) => {
    const li = document.createElement('li');
    li.className = 'seg';
    li.dataset.i = i;
    const time = document.createElement('span');
    time.className = 'seg__time';
    time.textContent = (entry.approxTimes ? '≈' : '') + fmtShort(s.start);
    const text = document.createElement('span');
    text.className = 'seg__text';
    if (s.speaker != null) {
      if (!speakerIdx.has(s.speaker)) speakerIdx.set(s.speaker, speakerIdx.size);
      const tag = document.createElement('span');
      tag.className = 'seg__speaker';
      tag.style.background = SPEAKER_COLORS[speakerIdx.get(s.speaker) % SPEAKER_COLORS.length];
      tag.textContent = speakerName(s.speaker);
      text.appendChild(tag);
    }
    text.appendChild(document.createTextNode(s.text));
    li.append(time, text);
    frag.appendChild(li);
  });
  list.appendChild(frag);

  let hint = state.resultHasAudio ? 'Haz clic en un segmento para escucharlo desde ese punto.' : 'Carga el audio original para poder escuchar cada segmento.';
  if (entry.approxTimes) hint += ' Este modelo no devuelve marcas de tiempo: los tiempos (≈) son aproximados.';
  if (!entry.segments.length) hint = 'Este resultado no tiene segmentos.';
  $('segmentsHint').textContent = hint;
}

$('segments').addEventListener('click', (e) => {
  const li = e.target.closest('.seg');
  if (!li || !state.result || !state.resultHasAudio || !state.file) return;
  const s = state.result.segments[+li.dataset.i];
  const player = $('player');
  player.currentTime = s.start;
  player.play().catch(() => {});
});

let currentSeg = -1;
$('player').addEventListener('timeupdate', () => {
  if (!state.result || !state.resultHasAudio) return;
  const t = $('player').currentTime;
  const segs = state.result.segments;
  let idx = -1;
  for (let i = 0; i < segs.length; i++) { if (segs[i].start <= t + 0.05) idx = i; else break; }
  if (idx === currentSeg) return;
  const list = $('segments');
  list.querySelector('.is-current')?.classList.remove('is-current');
  currentSeg = idx;
  const li = list.children[idx];
  if (li) {
    li.classList.add('is-current');
    if (!$('player').paused && !list.closest('.panel').hidden) li.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* Pestañas */
function selectTab(name) {
  document.querySelectorAll('.tab').forEach((t) => {
    const on = t.dataset.tab === name;
    t.classList.toggle('is-active', on);
    t.setAttribute('aria-selected', on);
  });
  document.querySelectorAll('.panel').forEach((p) => { p.hidden = p.dataset.panel !== name; });
  if (name === 'history') renderHistory();
}
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => selectTab(t.dataset.tab)));

/* Copiar y descargar */
$('copyBtn').addEventListener('click', async () => {
  const text = transcriptEl.value;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    transcriptEl.select();
    document.execCommand('copy');
  }
  toast('Texto copiado');
});

const menu = $('downloadMenu');
$('downloadBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  menu.hidden = !menu.hidden;
  $('downloadBtn').setAttribute('aria-expanded', String(!menu.hidden));
});
document.addEventListener('click', () => { menu.hidden = true; $('downloadBtn').setAttribute('aria-expanded', 'false'); });
menu.addEventListener('click', (e) => {
  const fmt = e.target.closest('button')?.dataset.fmt;
  if (!fmt || !state.result) return;
  const r = state.result;
  const base = r.name || 'transcripcion';
  const segs = r.segments.length ? r.segments : [{ start: 0, end: r.duration || 0, text: r.text }];
  switch (fmt) {
    case 'txt': download(`${base}.txt`, transcriptEl.value, 'text/plain'); break;
    case 'txt-ts': download(`${base}_tiempos.txt`, toTimestampedText(segs), 'text/plain'); break;
    case 'srt': download(`${base}.srt`, toSRT(segs), 'application/x-subrip'); break;
    case 'vtt': download(`${base}.vtt`, toVTT(segs), 'text/vtt'); break;
    case 'doc': download(`${base}.doc`, toDoc(base, transcriptEl.value), 'application/msword'); break;
    case 'json': download(`${base}.json`, JSON.stringify(r, null, 2), 'application/json'); break;
  }
});

/* ------------------------------------------------------------------ */
/* Historial                                                           */
/* ------------------------------------------------------------------ */

const HISTORY_KEY = 'tx-history';
const HISTORY_MAX = 25;

function saveHistory(entry) {
  let list = store.get(HISTORY_KEY, []).filter((e) => e.id !== entry.id);
  list.unshift(entry);
  list = list.slice(0, HISTORY_MAX);
  // Si el almacenamiento se llena, descartamos los más antiguos.
  while (list.length && !store.set(HISTORY_KEY, list)) list.pop();
}

function renderHistory() {
  const list = store.get(HISTORY_KEY, []);
  const ul = $('history');
  ul.innerHTML = '';
  $('clearHistory').hidden = !list.length;
  if (!list.length) {
    ul.innerHTML = '<li class="muted" style="cursor:default;border-style:dashed">Aún no hay transcripciones guardadas. Se guardan solo en este navegador.</li>';
    return;
  }
  for (const e of list) {
    const li = document.createElement('li');
    li.innerHTML = `<div class="history__main">
        <div class="history__title"></div>
        <div class="history__meta"></div>
        <div class="history__preview"></div>
      </div>
      <button class="btn btn--icon" type="button" title="Eliminar" aria-label="Eliminar">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>
      </button>`;
    li.querySelector('.history__title').textContent = e.name;
    li.querySelector('.history__meta').textContent =
      `${new Date(e.date).toLocaleString('es')} · ${ENGINE_LABEL[e.engine] || e.engine}${e.duration ? ' · ' + fmtShort(e.duration) : ''}`;
    li.querySelector('.history__preview').textContent = e.text.slice(0, 140);
    li.addEventListener('click', (ev) => {
      if (ev.target.closest('button')) {
        store.set(HISTORY_KEY, store.get(HISTORY_KEY, []).filter((x) => x.id !== e.id));
        renderHistory();
        return;
      }
      showResult(e, false);
    });
    ul.appendChild(li);
  }
}

$('clearHistory').addEventListener('click', () => {
  if (!confirm('¿Borrar todas las transcripciones guardadas en este navegador?')) return;
  store.remove(HISTORY_KEY);
  renderHistory();
});

/* ------------------------------------------------------------------ */

window.addEventListener('beforeunload', (e) => {
  if (state.busy || rec.recorder) { e.preventDefault(); e.returnValue = ''; }
});

updateUI();
