// Exportación de transcripciones a distintos formatos.
import { speakerName } from './engines.js';

export function fmtClock(sec, { ms = false, sep = '.' } = {}) {
  sec = Math.max(0, sec || 0);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const pad = (n, l = 2) => String(n).padStart(l, '0');
  let out = `${pad(h)}:${pad(m)}:${pad(s)}`;
  if (ms) out += sep + pad(Math.floor((sec % 1) * 1000), 3);
  return out;
}

export function fmtShort(sec) {
  sec = Math.max(0, sec || 0);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

const label = (s) => (s.speaker != null ? `${speakerName(s.speaker)}: ` : '');

/** Parte segmentos largos para que los subtítulos sean legibles (máx. ~84 caracteres). */
function subtitleCues(segments) {
  const cues = [];
  for (const s of segments) {
    const prefix = s.speaker != null ? `[${speakerName(s.speaker)}] ` : '';
    const words = s.text.split(/\s+/);
    if (s.text.length <= 84) {
      cues.push({ start: s.start, end: s.end, text: prefix + wrap(s.text) });
      continue;
    }
    const parts = [];
    let cur = '';
    for (const w of words) {
      if ((cur + ' ' + w).trim().length > 84) { parts.push(cur.trim()); cur = w; }
      else cur += ' ' + w;
    }
    if (cur.trim()) parts.push(cur.trim());
    const total = parts.reduce((a, p) => a + p.length, 0);
    let t = s.start;
    parts.forEach((p, i) => {
      const d = ((s.end - s.start) * p.length) / total;
      cues.push({ start: t, end: t + d, text: (i === 0 ? prefix : '') + wrap(p) });
      t += d;
    });
  }
  return cues;
}

function wrap(text) {
  if (text.length <= 42) return text;
  const mid = Math.floor(text.length / 2);
  let i = text.lastIndexOf(' ', mid);
  if (i < 0) i = text.indexOf(' ', mid);
  return i < 0 ? text : text.slice(0, i) + '\n' + text.slice(i + 1);
}

export function toSRT(segments) {
  return subtitleCues(segments)
    .map((c, i) => `${i + 1}\n${fmtClock(c.start, { ms: true, sep: ',' })} --> ${fmtClock(c.end, { ms: true, sep: ',' })}\n${c.text}\n`)
    .join('\n');
}

export function toVTT(segments) {
  return 'WEBVTT\n\n' + subtitleCues(segments)
    .map((c) => `${fmtClock(c.start, { ms: true })} --> ${fmtClock(c.end, { ms: true })}\n${c.text}\n`)
    .join('\n');
}

export function toTimestampedText(segments) {
  return segments.map((s) => `[${fmtClock(s.start)}] ${label(s)}${s.text}`).join('\n');
}

export function toDoc(title, text) {
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const paras = text.split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('\n');
  return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{font-family:Calibri,Arial,sans-serif;font-size:12pt;line-height:1.5}h1{font-size:16pt}</style></head>
<body><h1>${esc(title)}</h1>\n${paras}</body></html>`;
}

export function download(filename, content, type) {
  const blob = content instanceof Blob ? content : new Blob([content], { type: `${type};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
