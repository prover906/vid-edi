// Captions: SRT/WebVTT import & export, caption editing helpers.

import { app } from './app.js';
import { uid, h, downloadBlob, pickFiles } from './util.js';
import { seqDuration } from './model.js';
import { modal } from '../ui/dialogs.js';

function parseTime(s) {
  const m = s.trim().match(/(?:(\d+):)?(\d+):(\d+)[,.](\d+)/);
  if (!m) return null;
  return (parseInt(m[1] || '0', 10) * 3600) + parseInt(m[2], 10) * 60 + parseInt(m[3], 10) + parseInt(m[4].padEnd(3, '0').slice(0, 3), 10) / 1000;
}

export function parseSubtitles(text) {
  const out = [];
  const blocks = text.replace(/\r/g, '').split(/\n\s*\n/);
  for (const b of blocks) {
    const lines = b.split('\n').filter((l) => l.trim() !== '' && !/^WEBVTT/.test(l) && !/^NOTE/.test(l));
    const ti = lines.findIndex((l) => l.includes('-->'));
    if (ti < 0) continue;
    const [a, z] = lines[ti].split('-->');
    const start = parseTime(a), end = parseTime(z.split(' ').filter(Boolean)[0] || z);
    if (start == null || end == null) continue;
    const txt = lines.slice(ti + 1).join('\n').replace(/<[^>]+>/g, '');
    out.push({ start, end, text: txt });
  }
  return out;
}

function fmt(sec, sep = ',') {
  const ms = Math.round(sec * 1000);
  const hh = Math.floor(ms / 3600000), mm = Math.floor(ms / 60000) % 60, ss = Math.floor(ms / 1000) % 60, mmm = ms % 1000;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}${sep}${String(mmm).padStart(3, '0')}`;
}

export const captions = {
  async importFile(file) {
    const seq = app.seq;
    if (!seq) return app.toast('Open a sequence before importing captions', 'warn');
    const text = await file.text();
    const list = parseSubtitles(text);
    if (!list.length) return app.toast('No captions found in ' + file.name, 'warn');
    const fps = seq.settings.fps;
    app.edit('Import Captions', () => {
      for (const c of list) seq.captions.push({ id: uid('cap_'), start: Math.round(c.start * fps), end: Math.max(Math.round(c.start * fps) + 1, Math.round(c.end * fps)), text: c.text });
      seq.captions.sort((a, b) => a.start - b.start);
    });
    app.prefs.showCaptionTrack = true;
    app.savePrefs();
    app.toast(`Imported ${list.length} captions`, 'ok');
  },
  async importDialog() {
    const files = await pickFiles({ accept: '.srt,.vtt', multiple: false });
    if (files[0]) await this.importFile(files[0]);
  },
  exportSrt(vtt = false) {
    const seq = app.seq;
    if (!seq || !seq.captions.length) return app.toast('No captions to export', 'warn');
    const fps = seq.settings.fps;
    const caps = [...seq.captions].sort((a, b) => a.start - b.start);
    let out = vtt ? 'WEBVTT\n\n' : '';
    caps.forEach((c, i) => {
      out += (vtt ? '' : i + 1 + '\n') + fmt(c.start / fps, vtt ? '.' : ',') + ' --> ' + fmt(c.end / fps, vtt ? '.' : ',') + '\n' + c.text + '\n\n';
    });
    downloadBlob(new Blob([out], { type: 'text/plain' }), seq.name + (vtt ? '.vtt' : '.srt'));
  },
  addAtPlayhead(text = 'New caption') {
    const seq = app.seq;
    if (!seq) return;
    const fps = seq.settings.fps;
    const start = seq.playhead;
    const next = seq.captions.filter((c) => c.start > start).sort((a, b) => a.start - b.start)[0];
    const end = Math.min(start + Math.round(fps * 3), next ? next.start : Infinity);
    if (end <= start) return app.toast('A caption already starts here', 'warn');
    const cap = { id: uid('cap_'), start, end, text };
    app.edit('Add Caption', () => {
      seq.captions.push(cap);
      seq.captions.sort((a, b) => a.start - b.start);
    });
    app.prefs.showCaptionTrack = true;
    app.savePrefs();
    app.sel.caption = cap.id;
    app.bus.emit('selection:changed');
    return cap;
  },
  editCaption(cap) {
    const seq = app.seq;
    const ta = h('textarea', { rows: 3, style: { width: '360px' } }, cap.text);
    modal({
      title: 'Edit Caption',
      body: h('div', ta),
      buttons: [{ label: 'Cancel' }, { label: 'OK', cta: true, action: () => app.edit('Edit Caption', () => { const c = seq.captions.find((x) => x.id === cap.id); if (c) c.text = ta.value; }) }],
    });
  },
  duration() {
    return seqDuration(app.seq);
  },
};
