// Tools, History, Info, Markers, Media Browser and Text (captions) panels.

import { app } from '../../core/app.js';
import { h, fmtBytes, MOD, clamp } from '../../core/util.js';
import { framesToTC, fpsLabel, tcToFrames } from '../../core/timecode.js';
import { findItem, findClip, clipEnd, seqDuration, LABEL_COLORS } from '../../core/model.js';
import { registerPanel } from '../layout.js';
import { icon } from '../icons.js';
import { iconButton, dropdown, colorSwatch, hotText } from '../widgets.js';
import { showMenu } from '../menus.js';
import { actions } from '../../core/actions.js';
import { importFiles, mediaKind } from '../../core/media.js';
import { captions } from '../../core/captions.js';

// ================= Tools =================
export const TOOL_GROUPS = [
  [['select', 'Selection Tool', 'V']],
  [['trackFwd', 'Track Select Forward Tool', 'A'], ['trackBack', 'Track Select Backward Tool', 'Shift+A']],
  [['ripple', 'Ripple Edit Tool', 'B'], ['rolling', 'Rolling Edit Tool', 'N'], ['rateStretch', 'Rate Stretch Tool', 'R']],
  [['razor', 'Razor Tool', 'C']],
  [['slip', 'Slip Tool', 'Y'], ['slide', 'Slide Tool', 'U']],
  [['pen', 'Pen Tool', 'P'], ['rect', 'Rectangle Tool', ''], ['ellipse', 'Ellipse Tool', '']],
  [['hand', 'Hand Tool', 'H'], ['zoom', 'Zoom Tool', 'Z']],
  [['type', 'Type Tool', 'T']],
];

class ToolsPanel {
  constructor() {
    this.def = registerPanel({ id: 'tools', title: 'Tools', tabTitle: () => '' });
    this.root = this.def.el;
    this.root.classList.add('tools-root');
    this.current = TOOL_GROUPS.map((g) => g[0][0]);
    this.render();
    app.bus.on('tool:changed', (t) => {
      const gi = TOOL_GROUPS.findIndex((g) => g.some((x) => x[0] === t));
      if (gi >= 0) this.current[gi] = t;
      this.render();
    });
  }
  render() {
    this.root.innerHTML = '';
    TOOL_GROUPS.forEach((g, gi) => {
      const id = this.current[gi];
      const t = g.find((x) => x[0] === id);
      const b = h('button.tool-btn' + (app.tool === id ? '.active' : '') + (g.length > 1 ? '.group' : ''), { title: `${t[1]}${t[2] ? ' (' + t[2] + ')' : ''}` }, icon(id === 'trackFwd' ? 'trackFwd' : id === 'rateStretch' ? 'rateStretch' : id));
      b.addEventListener('click', () => app.setTool(id));
      const flyout = (e) => {
        e.preventDefault();
        const r = b.getBoundingClientRect();
        showMenu(r.right + 2, r.top, g.map(([tid, name, key]) => ({ label: name, kbd: key, checked: app.tool === tid, action: () => app.setTool(tid) })));
      };
      if (g.length > 1) {
        b.addEventListener('contextmenu', flyout);
        let timer = 0;
        b.addEventListener('pointerdown', (e) => (timer = setTimeout(() => flyout(e), 450)));
        b.addEventListener('pointerup', () => clearTimeout(timer));
        b.addEventListener('pointerleave', () => clearTimeout(timer));
      }
      this.root.appendChild(b);
    });
  }
}

// ================= History =================
class HistoryPanel {
  constructor() {
    this.def = registerPanel({ id: 'history', title: 'History', onShow: () => this.render(), menu: () => [{ label: 'Clear History', action: () => app.history.reset('Cleared History') }] });
    this.root = this.def.el;
    this.root.classList.add('hist-root');
    app.bus.on('history:changed', () => this.render());
  }
  render() {
    if (!this.root.isConnected) return;
    this.root.innerHTML = '';
    const list = h('div.hist-list');
    const H = app.history;
    H.entries.forEach((e, i) => {
      const row = h('div.hist-row' + (i === H.index ? '.cur' : '') + (i > H.index ? '.future' : ''), icon(i === 0 ? 'film' : 'undo'), h('span', e.label));
      row.onclick = () => H.goto(i);
      list.appendChild(row);
    });
    this.root.append(list, h('div.hist-foot', h('span.muted.tiny', H.entries.length + ' states'), h('div.spacer'), iconButton('undo', 'Undo (' + MOD + '+Z)', () => H.undo()), iconButton('redo', 'Redo (' + MOD + '+Shift+Z)', () => H.redo()), iconButton('trash', 'Clear History', () => H.reset('Cleared History'))));
    const cur = list.querySelector('.cur');
    if (cur) cur.scrollIntoView({ block: 'nearest' });
  }
}

// ================= Info =================
class InfoPanel {
  constructor() {
    this.def = registerPanel({ id: 'info', title: 'Info', onShow: () => this.render() });
    this.root = this.def.el;
    this.root.classList.add('info-root');
    app.bus.on('selection:changed project:changed sequence:activated', () => this.render());
    app.bus.on('time:changed', () => {
      if (this.cursorEl && app.seq) this.cursorEl.textContent = framesToTC(app.seq.playhead, app.seq.settings.fps);
    });
  }
  render() {
    if (!this.root.isConnected) return;
    this.root.innerHTML = '';
    const seq = app.seq;
    const kv = (k, v) => h('div.info-row', h('span.k', k), h('span.v', v));
    const ids = [...app.sel.clips];
    if (seq && ids.length) {
      const c = findClip(seq, ids[0])?.clip;
      if (c) {
        const fps = seq.settings.fps;
        const item = c.itemId ? findItem(app.project, c.itemId) : null;
        this.root.append(h('div.info-title', c.name), kv('Type', c.graphic ? 'Graphic' : item ? (item.type === 'media' ? item.kind[0].toUpperCase() + item.kind.slice(1) : item.type === 'sequence' ? 'Sequence' : 'Synthetic') : 'Clip'));
        if (item && item.type === 'media' && item.kind !== 'audio') this.root.append(kv('Video', `${item.width} x ${item.height}`));
        if (item && item.hasAudio) this.root.append(kv('Audio', `48000 Hz - ${item.audioChannels === 1 ? 'Mono' : 'Stereo'}`));
        this.root.append(kv('Start', framesToTC(c.start, fps)), kv('End', framesToTC(clipEnd(c) - 1, fps)), kv('Duration', framesToTC(c.dur, fps)), kv('Speed', (c.speed * 100).toFixed(2) + '%' + (c.reverse ? ' (reversed)' : '')));
        if (ids.length > 1) this.root.append(kv('Selected', ids.length + ' clips'));
      }
    } else if (app.sel.items.size) {
      const it = findItem(app.project, [...app.sel.items][0]);
      if (it) {
        this.root.append(h('div.info-title', it.name), kv('Type', it.type === 'media' ? it.kind : it.type));
        if (it.size) this.root.append(kv('Size', fmtBytes(it.size)));
        if (it.width) this.root.append(kv('Video', `${it.width} x ${it.height}`));
        if (it.duration) this.root.append(kv('Duration', it.duration.toFixed(2) + ' s'));
      }
    }
    if (seq) {
      this.root.append(h('div.info-title', { style: { marginTop: '10px' } }, seq.name));
      this.cursorEl = h('span.v', framesToTC(seq.playhead, seq.settings.fps));
      this.root.append(h('div.info-row', h('span.k', 'Playhead'), this.cursorEl), kv('Frame size', `${seq.settings.width} x ${seq.settings.height}`), kv('Timebase', fpsLabel(seq.settings.fps)), kv('Duration', framesToTC(seqDuration(seq), seq.settings.fps)));
    }
  }
}

// ================= Markers =================
class MarkersPanel {
  constructor() {
    this.def = registerPanel({ id: 'markers', title: 'Markers', onShow: () => this.render() });
    this.root = this.def.el;
    this.root.classList.add('mk-root');
    this.filter = '';
    app.bus.on('project:changed sequence:activated', () => this.render());
  }
  render() {
    if (!this.root.isConnected) return;
    this.root.innerHTML = '';
    const seq = app.seq;
    const search = h('input', { type: 'search', placeholder: 'Search markers', value: this.filter });
    search.addEventListener('input', () => {
      this.filter = search.value.toLowerCase();
      this.render();
      this.root.querySelector('input').focus();
    });
    search.addEventListener('keydown', (e) => e.stopPropagation());
    this.root.appendChild(h('div.mk-top', h('div.search-box', icon('search'), search), iconButton('marker', 'Add Marker (M)', () => actions.addMarker())));
    if (!seq) return;
    const fps = seq.settings.fps;
    const list = h('div.mk-list');
    const ms = [...seq.markers].sort((a, b) => a.frame - b.frame).filter((m) => !this.filter || (m.name + ' ' + m.comment).toLowerCase().includes(this.filter));
    const MC = { Green: '#5bbf5b', Red: '#e04848', Rose: '#e6739f', Orange: '#f0882c', Yellow: '#e4d23e', White: '#e8e8e8', Blue: '#3b8ee6', Cyan: '#38c8d8' };
    for (const m of ms) {
      const row = h('div.mk-row' + (app.sel.marker === m.id ? '.sel' : ''), h('span.mk-chip', { style: { background: MC[m.color] || LABEL_COLORS[m.color] || '#5bbf5b' } }), h('div.mk-info', h('div', h('b', m.name || 'Marker'), h('span.muted', '  ' + framesToTC(m.frame, fps) + (m.duration ? ' → ' + framesToTC(m.frame + m.duration, fps) : ''))), m.comment ? h('div.muted.tiny', m.comment) : null));
      row.onclick = () => {
        app.sel.marker = m.id;
        list.querySelectorAll('.mk-row').forEach((x) => x.classList.remove('sel'));
        row.classList.add('sel');
        app.setPlayhead(m.frame);
      };
      row.ondblclick = () => actions.editMarker(m);
      row.oncontextmenu = (e) => {
        e.preventDefault();
        showMenu(e.clientX, e.clientY, [{ label: 'Edit Marker…', action: () => actions.editMarker(m) }, { label: 'Delete Marker', action: () => app.edit('Delete Marker', () => (seq.markers = seq.markers.filter((x) => x.id !== m.id))) }]);
      };
      list.appendChild(row);
    }
    if (!ms.length) list.appendChild(h('div.ec-empty', 'No markers. Press M to add one at the playhead.'));
    this.root.appendChild(list);
  }
}

// ================= Media Browser =================
class MediaBrowser {
  constructor() {
    this.def = registerPanel({ id: 'mediaBrowser', title: 'Media Browser', onShow: () => this.render() });
    this.root = this.def.el;
    this.root.classList.add('mb-root');
    this.files = [];
    this.dirName = '';
  }
  async browse() {
    if ('showDirectoryPicker' in window) {
      try {
        const dir = await window.showDirectoryPicker();
        this.dirName = dir.name;
        this.files = [];
        for await (const [name, handle] of dir.entries()) {
          if (handle.kind !== 'file') continue;
          const f = await handle.getFile();
          if (mediaKind(f)) this.files.push(f);
        }
      } catch (e) {
        return;
      }
    } else {
      const inp = h('input', { type: 'file' });
      inp.webkitdirectory = true;
      await new Promise((res) => {
        inp.onchange = res;
        inp.click();
      });
      this.files = [...inp.files].filter((f) => mediaKind(f));
      this.dirName = this.files[0]?.webkitRelativePath?.split('/')[0] || 'Folder';
    }
    this.files.sort((a, b) => a.name.localeCompare(b.name));
    this.render();
  }
  render() {
    if (!this.root.isConnected) return;
    this.root.innerHTML = '';
    this.sel = this.sel || new Set();
    const top = h('div.mb-top', h('button.btn.sm', { onclick: () => this.browse() }, 'Browse Folder…'), h('span.muted', this.dirName ? '  ' + this.dirName : '  Choose a local folder to browse media'), h('div.spacer'), h('button.btn.sm', { disabled: !this.sel.size, onclick: () => this.importSel() }, 'Import'));
    const list = h('div.mb-list');
    for (const f of this.files) {
      const row = h('div.mb-row' + (this.sel.has(f) ? '.sel' : ''), icon(mediaKind(f) === 'audio' ? 'audioFile' : mediaKind(f) === 'image' ? 'image' : 'film'), h('span.grow', f.name), h('span.muted.tiny', fmtBytes(f.size)));
      row.onclick = (e) => {
        if (!(e.ctrlKey || e.metaKey)) this.sel.clear();
        this.sel.add(f);
        this.render();
      };
      row.ondblclick = () => importFiles([f]);
      list.appendChild(row);
    }
    if (!this.files.length) list.appendChild(h('div.ec-empty', 'No folder selected.'));
    this.root.append(top, list);
  }
  async importSel() {
    await importFiles([...this.sel]);
    this.sel.clear();
    this.render();
  }
}

// ================= Text (Captions) =================
class TextPanel {
  constructor() {
    this.def = registerPanel({ id: 'text', title: 'Text', onShow: () => this.render() });
    this.root = this.def.el;
    this.root.classList.add('txt-root');
    app.bus.on('project:changed sequence:activated selection:changed', (e) => {
      if (!(e && e.live) && !this.editing) this.render();
    });
  }
  render() {
    if (!this.root.isConnected) return;
    this.root.innerHTML = '';
    const seq = app.seq;
    const tabs = h('div.eg-tabs', h('div.eg-tab', { title: 'Speech to Text requires a cloud transcription service and is not available offline.' }, 'Transcript'), h('div.eg-tab.on', 'Captions'), h('div.eg-tab', { onclick: () => this.styleDialog() }, 'Style'));
    this.root.appendChild(tabs);
    if (!seq) return this.root.appendChild(h('div.ec-empty', '(no sequence)'));
    const fps = seq.settings.fps;
    const bar = h('div.txt-bar', iconButton('plus', 'Add new caption segment at playhead', () => captions.addAtPlayhead()), iconButton('importIcon', 'Import captions (.srt/.vtt)', () => captions.importDialog()), iconButton('exportIcon', 'Export captions (.srt)', () => captions.exportSrt()), h('button.btn.sm', { onclick: () => captions.exportSrt(true) }, 'Export .vtt'), h('div.spacer'), h('span.muted.tiny', seq.captions.length + ' captions'));
    this.root.appendChild(bar);
    const list = h('div.txt-list');
    for (const c of [...seq.captions].sort((a, b) => a.start - b.start)) {
      const sel = app.sel.caption === c.id;
      const ta = h('textarea.txt-ta', { rows: 2 }, c.text);
      ta.addEventListener('focus', () => {
        this.editing = true;
        app.sel.caption = c.id;
        app.setPlayhead(c.start);
      });
      ta.addEventListener('keydown', (e) => e.stopPropagation());
      ta.addEventListener('blur', () => {
        this.editing = false;
        if (ta.value !== c.text) app.edit('Edit Caption', () => (seq.captions.find((x) => x.id === c.id).text = ta.value));
      });
      const tcIn = hotText({ value: c.start, precision: 0, min: 0, format: (v) => framesToTC(v, fps), parse: (s, p) => tcToFrames(s, fps, p), onCommit: (v) => app.edit('Caption In', () => { const x = seq.captions.find((y) => y.id === c.id); x.start = clamp(Math.round(v), 0, x.end - 1); }) });
      const tcOut = hotText({ value: c.end, precision: 0, min: 1, format: (v) => framesToTC(v, fps), parse: (s, p) => tcToFrames(s, fps, p), onCommit: (v) => app.edit('Caption Out', () => { const x = seq.captions.find((y) => y.id === c.id); x.end = Math.max(x.start + 1, Math.round(v)); }) });
      const del = iconButton('trash', 'Delete caption', () => app.edit('Delete Caption', () => (seq.captions = seq.captions.filter((x) => x.id !== c.id))));
      list.appendChild(h('div.txt-row' + (sel ? '.sel' : ''), h('div.txt-tc', tcIn.el, tcOut.el, del), ta));
    }
    if (!seq.captions.length) list.appendChild(h('div.ec-empty', 'No captions yet. Click + to add one at the playhead, or import an .srt file.'));
    this.root.appendChild(list);
  }
  styleDialog() {
    const seq = app.seq;
    if (!seq) return;
    const st = seq.captionStyle;
    const { modal, row } = app.services.dialogs;
    const size = hotText({ value: st.size, precision: 0, min: 8, max: 200, onCommit: (v) => app.edit('Caption Size', () => (seq.captionStyle.size = v)) });
    const col = colorSwatch({ value: st.color, onChange: (v) => (this._c = v), onEnd: () => app.edit('Caption Color', () => (seq.captionStyle.color = this._c)) });
    const bg = colorSwatch({ value: st.bg, onChange: (v) => (this._b = v), onEnd: () => app.edit('Caption Background', () => (seq.captionStyle.bg = this._b)) });
    const bgo = hotText({ value: st.bgOpacity, precision: 0, min: 0, max: 100, unit: ' %', onCommit: (v) => app.edit('Caption Background', () => (seq.captionStyle.bgOpacity = v)) });
    const pos = dropdown({ options: ['bottom', 'middle', 'top'].map((x) => ({ label: x[0].toUpperCase() + x.slice(1), value: x })), value: st.position, onChange: (v) => app.edit('Caption Position', () => (seq.captionStyle.position = v)) });
    const font = dropdown({ options: ['Arial', 'Helvetica', 'Verdana', 'Georgia', 'Roboto', 'Montserrat', 'Source Sans 3'].map((x) => ({ label: x, value: x })), value: st.font, onChange: (v) => app.edit('Caption Font', () => (seq.captionStyle.font = v)) });
    modal({ title: 'Caption Style', body: h('div', row('Font', font.el), row('Size', size.el), row('Text Color', col.el), row('Background', h('span', bg.el, ' ', bgo.el)), row('Position', pos.el)), buttons: [{ label: 'Close', cta: true }] });
  }
}

export const toolsPanel = new ToolsPanel();
export const historyPanel = new HistoryPanel();
export const infoPanel = new InfoPanel();
export const markersPanel = new MarkersPanel();
export const mediaBrowser = new MediaBrowser();
export const textPanel = new TextPanel();
