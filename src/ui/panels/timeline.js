// Timeline panel: canvas-rendered tracks with full Premiere-style tool interactions.

import { app } from '../../core/app.js';
import { h, clamp, dragPointer, dbToGain, hexToRgb, rgbToHex, MOD } from '../../core/util.js';
import { framesToTC } from '../../core/timecode.js';
import {
  LABEL_COLORS, findItem, findClip, allTracks, clipEnd, seqDuration, transitionRange, clipSourceTime, clipKfTime, kfTimeToFrame,
  linkedClips, groupedClips, trackDisplayName, itemSourceDuration, getClipEffect,
} from '../../core/model.js';
import { evalParam, addKeyframe, isAnimated, setParamValue } from '../../core/keyframes.js';
import { getEffectDef, getTransitionDef } from '../../core/registry.js';
import * as E from '../../core/edit.js';
import { thumbAt } from '../../core/media.js';
import { registerPanel } from '../layout.js';
import { icon } from '../icons.js';
import { showMenu, labelMenu } from '../menus.js';
import { timecodeField, iconButton } from '../widgets.js';
import { playback } from '../../engine/playback.js';
import { audio } from '../../engine/audioEngine.js';
import { actions } from '../../core/actions.js';

const HEADER_W = 190;
const RULER_H = 34;
const DIVIDER_H = 5;
const CAPTION_H = 24;
const MIX_H = 28;
const EDGE_PX = 6;
const SNAP_PX = 9;
const MIN_ZOOM = 0.004, MAX_ZOOM = 60;

function mix(a, b, t) {
  const A = hexToRgb(a), B = hexToRgb(b);
  return rgbToHex([A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t]);
}
const labelColor = (name) => LABEL_COLORS[name] || '#7f8fe8';

class TimelinePanel {
  constructor() {
    this.def = registerPanel({
      id: 'timeline',
      title: 'Timeline',
      tabTitle: () => 'Timeline',
      onResize: () => this.resize(),
      onShow: () => this.resize(),
      menu: () => this.panelMenu(),
    });
    this.root = this.def.el;
    this.root.classList.add('tl-root');
    this.dirty = true;
    this.drag = null;
    this.hover = null;
    this.ghost = null;
    this.snapLine = null;
    this.marquee = null;
    this.dropGhost = null;
    this.razorX = null;
    this.build();
    app.bus.on('project:changed sequence:activated selection:changed media:updated prefs:changed', () => {
      this.refreshHeaders();
      this.updateSeqTabs();
      this.requestDraw();
    });
    app.bus.on('time:changed', (e) => this.onTime(e));
    app.bus.on('tool:changed', () => this.updateCursor());
    app.bus.on('playback:state', () => this.requestDraw());
  }

  get seq() {
    return app.seq;
  }
  get view() {
    return this.seq.view;
  }

  // ---------------- DOM ----------------
  build() {
    this.seqTabs = h('div.tl-seqtabs');
    this.tc = timecodeField({ frames: 0, fps: 30, cls: 'tl-tc', onCommit: (f) => app.setPlayhead(f) });
    const tb = h('div.tl-toolbar');
    this.btnNest = iconButton('nest', 'Insert and overwrite sequences as nests or individual clips', () => {
      app.prefs.insertAsNest = !app.prefs.insertAsNest;
      app.savePrefs();
      this.btnNest.classList.toggle('on', app.prefs.insertAsNest !== false);
    });
    this.btnSnap = iconButton('magnet', 'Snap in Timeline (S)', () => actions.toggleSnap());
    this.btnLink = iconButton('link', 'Linked Selection', () => actions.toggleLinked());
    this.btnMarker = iconButton('marker', 'Add Marker (M)', () => actions.addMarker());
    this.btnSettings = iconButton('wrench', 'Timeline Display Settings', (e) => this.settingsMenu(e.currentTarget));
    this.btnCaptions = iconButton('captions', 'Show captions track', () => {
      app.prefs.showCaptionTrack = !app.prefs.showCaptionTrack;
      app.savePrefs();
      this.layoutRegions();
      this.refreshHeaders();
      this.requestDraw();
    });
    tb.append(this.btnNest, this.btnSnap, this.btnLink, this.btnMarker, this.btnSettings, this.btnCaptions);
    this.topLeft = h('div.tl-topleft', this.tc.el, tb);
    this.rulerCanvas = h('canvas.tl-ruler');
    this.top = h('div.tl-top', this.topLeft, h('div.tl-ruler-wrap', this.rulerCanvas));
    this.headers = h('div.tl-headers');
    this.canvas = h('canvas.tl-canvas', { tabIndex: 0 });
    this.canvasWrap = h('div.tl-canvas-wrap', this.canvas);
    this.main = h('div.tl-main', this.headers, this.canvasWrap);
    this.hscroll = h('div.tl-hscroll', h('div.tl-hthumb', h('div.tl-hgrip.l'), h('div.tl-hgrip.r')));
    this.bottom = h('div.tl-bottom', h('div.tl-bottom-left'), this.hscroll);
    this.empty = h('div.tl-empty', h('div', 'Drop media here to create a sequence.'), h('div.muted.tiny', 'Or use File › New › Sequence (' + MOD + '+N)'));
    this.root.append(this.seqTabs, this.top, this.main, this.bottom, this.empty);
    this.ctx = this.canvas.getContext('2d');
    this.rctx = this.rulerCanvas.getContext('2d');
    this.bindEvents();
    this.updateButtons();
    app.bus.on('prefs:changed', () => this.updateButtons());
    app.bus.on('snap:changed', () => this.updateButtons());
  }

  updateButtons() {
    this.btnSnap.classList.toggle('on', app.snapping);
    this.btnLink.classList.toggle('on', app.linkedSelection);
    this.btnNest.classList.toggle('on', app.prefs.insertAsNest !== false);
    this.btnCaptions.classList.toggle('on', !!app.prefs.showCaptionTrack);
  }

  updateSeqTabs() {
    const p = app.project;
    this.seqTabs.innerHTML = '';
    for (const id of p.openSequenceIds) {
      const s = findItem(p, id);
      if (!s) continue;
      const tab = h('div.tl-seqtab' + (id === p.activeSequenceId ? '.active' : ''), h('span', s.name));
      const x = h('span.x', { title: 'Close sequence' }, '×');
      x.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        app.closeSequence(id);
      });
      tab.appendChild(x);
      tab.addEventListener('pointerdown', () => app.openSequence(id));
      this.seqTabs.appendChild(tab);
    }
    const has = !!this.seq;
    this.empty.style.display = has ? 'none' : 'flex';
    this.top.style.visibility = has ? '' : 'hidden';
    this.main.style.visibility = has ? '' : 'hidden';
    this.bottom.style.visibility = has ? '' : 'hidden';
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const r = this.canvasWrap.getBoundingClientRect();
    this.W = Math.max(10, Math.floor(r.width));
    this.H = Math.max(10, Math.floor(r.height));
    this.canvas.width = this.W * dpr;
    this.canvas.height = this.H * dpr;
    this.canvas.style.width = this.W + 'px';
    this.canvas.style.height = this.H + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const rr = this.rulerCanvas.parentElement.getBoundingClientRect();
    this.RW = Math.max(10, Math.floor(rr.width));
    this.rulerCanvas.width = this.RW * dpr;
    this.rulerCanvas.height = RULER_H * dpr;
    this.rulerCanvas.style.width = this.RW + 'px';
    this.rulerCanvas.style.height = RULER_H + 'px';
    this.rctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.layoutRegions();
    this.refreshHeaders();
    this.updateSeqTabs();
    this.draw();
  }

  // ---------------- geometry ----------------
  layoutRegions() {
    const H = this.H || 300;
    const capH = app.prefs.showCaptionTrack ? CAPTION_H : 0;
    const split = this.seq ? clamp(this.view.split ?? 0.5, 0.1, 0.9) : 0.5;
    const avail = H - DIVIDER_H - capH;
    this.capTop = 0;
    this.capH = capH;
    this.vTop = capH;
    this.vH = Math.round(avail * split);
    this.divY = this.vTop + this.vH;
    this.aTop = this.divY + DIVIDER_H;
    this.aH = H - this.aTop;
  }

  get zoom() {
    return this.view.zoom;
  }
  f2x(f) {
    return (f - this.view.scroll) * this.view.zoom;
  }
  x2f(x) {
    return x / this.view.zoom + this.view.scroll;
  }

  trackRows() {
    const seq = this.seq;
    const rows = [];
    // video: bottom-aligned, V1 at bottom
    const vt = seq.videoTracks;
    const vContent = vt.reduce((s, t) => s + t.height, 0);
    const vMax = Math.max(0, vContent - this.vH);
    this.view.vScroll = clamp(this.view.vScroll || 0, 0, vMax);
    let y = this.vTop + this.vH - vContent + this.view.vScroll;
    for (let i = vt.length - 1; i >= 0; i--) {
      rows.push({ track: vt[i], kind: 'video', index: i, y, h: vt[i].height });
      y += vt[i].height;
    }
    const at = seq.audioTracks;
    const aContent = at.reduce((s, t) => s + t.height, 0) + MIX_H;
    const aMax = Math.max(0, aContent - this.aH);
    this.view.aScroll = clamp(this.view.aScroll || 0, 0, aMax);
    y = this.aTop - this.view.aScroll;
    for (let i = 0; i < at.length; i++) {
      rows.push({ track: at[i], kind: 'audio', index: i, y, h: at[i].height });
      y += at[i].height;
    }
    rows.push({ mix: true, kind: 'mix', y, h: MIX_H });
    return rows;
  }

  rowAt(y) {
    if (y < this.vTop) return this.capH && y >= 0 ? { caption: true } : null;
    const rows = this.trackRows();
    for (const r of rows) {
      const inRegion = r.kind === 'video' ? y >= this.vTop && y < this.divY : y >= this.aTop;
      if (inRegion && y >= r.y && y < r.y + r.h) return r;
    }
    return null;
  }

  rowOf(track) {
    return this.trackRows().find((r) => r.track === track) || null;
  }

  clipSel(c) {
    return app.sel.clips.has(c.id);
  }

  // ---------------- headers (DOM) ----------------
  refreshHeaders() {
    const seq = this.seq;
    this.headers.innerHTML = '';
    if (!seq || !this.H) return;
    this.layoutRegions();
    const vRegion = h('div.tl-hregion', { style: { top: this.vTop + 'px', height: this.vH + 'px' } });
    const aRegion = h('div.tl-hregion', { style: { top: this.aTop + 'px', height: this.aH + 'px' } });
    const divider = h('div.tl-divider', { style: { top: this.divY + 'px', height: DIVIDER_H + 'px' } });
    divider.addEventListener('pointerdown', (e) => this.startDividerDrag(e));
    this.headers.append(vRegion, aRegion, divider);
    if (this.capH) {
      const cap = h('div.tl-th.caption', { style: { top: '0px', height: this.capH + 'px' } }, h('div.tl-th-target.on', 'C1'), h('div.tl-th-name', 'Subtitle'));
      cap.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showMenu(e.clientX, e.clientY, [
          { label: 'Add Caption at Playhead', action: () => app.services.captions.addAtPlayhead() },
          { label: 'Import Captions…', action: () => app.services.captions.importDialog() },
          { label: 'Export Captions (.srt)…', action: () => app.services.captions.exportSrt() },
        ]);
      });
      this.headers.appendChild(cap);
    }
    const rows = this.trackRows();
    for (const r of rows) {
      const region = r.kind === 'video' ? vRegion : aRegion;
      const top = r.y - (r.kind === 'video' ? this.vTop : this.aTop);
      if (r.mix) {
        const vol = timecodeless(seq);
        region.appendChild(h('div.tl-th.mix', { style: { top: top + 'px', height: r.h + 'px' } }, h('div.tl-th-name', 'Mix'), vol));
        continue;
      }
      region.appendChild(this.buildHeader(r, top));
    }
    function timecodeless(s) {
      const span = h('span.tl-mixvol.muted', (s.masterVolume || 0).toFixed(1) + ' dB');
      return span;
    }
  }

  buildHeader(r, top) {
    const seq = this.seq;
    const t = r.track;
    const isV = r.kind === 'video';
    const el = h('div.tl-th' + (isV ? '.video' : '.audio') + (t.locked ? '.locked' : ''), { style: { top: top + 'px', height: r.h + 'px' } });
    const patched = isV ? seq.patch.video === r.index : seq.patch.audio === r.index;
    const patch = h('div.tl-th-patch' + (patched ? '.on' : ''), { title: 'Source patching: click to patch source ' + (isV ? 'video' : 'audio') + ' here' }, patched ? (isV ? 'V1' : 'A1') : '');
    patch.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      app.edit('Source Patch', () => {
        if (isV) seq.patch.video = seq.patch.video === r.index ? null : r.index;
        else seq.patch.audio = seq.patch.audio === r.index ? null : r.index;
      });
    });
    const lock = iconButton(t.locked ? 'lock' : 'unlock', 'Toggle Track Lock', () => app.edit('Lock Track', () => (t.locked = !t.locked)), t.locked ? 'on' : '');
    const target = h('div.tl-th-target' + (t.target ? '.on' : ''), { title: 'Toggle track targeting' }, t.name);
    target.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      if (e.shiftKey) {
        const arr = isV ? seq.videoTracks : seq.audioTracks;
        const all = !arr.every((x) => x.target);
        app.edit('Target Tracks', () => arr.forEach((x) => (x.target = all)));
      } else app.edit('Target Track', () => (t.target = !t.target));
    });
    const sync = iconButton('syncLock', 'Toggle Sync Lock', () => app.edit('Sync Lock', () => (t.syncLock = !t.syncLock)), t.syncLock ? 'on' : '');
    el.append(patch, lock, target, sync);
    if (isV) {
      el.append(iconButton(t.hidden ? 'eyeOff' : 'eye', 'Toggle Track Output', () => app.edit('Toggle Track Output', () => (t.hidden = !t.hidden)), t.hidden ? '' : 'on'));
    } else {
      const m = h('button.tl-ms' + (t.muted ? '.on.mute' : ''), { title: 'Mute Track' }, 'M');
      m.addEventListener('click', (e) => {
        e.stopPropagation();
        app.edit('Mute Track', () => (t.muted = !t.muted));
        audio.updateTrackLive(t);
      });
      const s = h('button.tl-ms' + (t.solo ? '.on.solo' : ''), { title: 'Solo Track' }, 'S');
      s.addEventListener('click', (e) => {
        e.stopPropagation();
        app.edit('Solo Track', () => (t.solo = !t.solo));
        for (const x of seq.audioTracks) audio.updateTrackLive(x);
      });
      const mic = iconButton('mic', 'Voice-over record', () => actions.recordVoiceover(t));
      el.append(m, s, mic);
    }
    const nm = h('div.tl-th-name', r.h >= 46 ? trackDisplayName(t) : t.customName || '');
    el.appendChild(nm);
    if (!isV && r.h >= 52) {
      const vol = h('div.tl-th-vol', h('span.muted', 'Vol'), h('span.hot', (t.volume || 0).toFixed(1) + ' dB'));
      el.appendChild(vol);
    }
    el.addEventListener('dblclick', (e) => {
      if (e.target.closest('button') || e.target.classList.contains('tl-th-target') || e.target.classList.contains('tl-th-patch')) return;
      t.height = t.height > 40 ? 34 : 76;
      app.changed();
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.trackMenu(e, r);
    });
    // resize handle
    const grip = h('div.tl-th-grip');
    grip.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      const h0 = t.height;
      dragPointer(e, {
        cursor: 'row-resize',
        move: (dx, dy) => {
          t.height = clamp(Math.round(h0 + (isV ? -dy : dy)), 24, 240);
          this.refreshHeaders();
          this.requestDraw();
        },
        up: () => app.markDirty(),
      });
    });
    if (isV) grip.classList.add('top');
    el.appendChild(grip);
    return el;
  }

  trackMenu(e, r) {
    const seq = this.seq;
    const t = r.track;
    showMenu(e.clientX, e.clientY, [
      { label: 'Rename', action: () => actions.renameTrack(t) },
      { sep: true },
      { label: 'Add Track', action: () => app.edit('Add Track', () => E.addTracks(seq, r.kind, 1, r.index + 1)) },
      { label: 'Add Tracks…', action: () => actions.addTracksDialog() },
      { label: 'Delete Track', action: () => app.edit('Delete Track', () => E.deleteTrack(seq, t.id)) },
      { label: 'Delete Empty Tracks', action: () => app.edit('Delete Empty Tracks', () => E.deleteEmptyTracks(seq)) },
      { sep: true },
      { label: t.height > 40 ? 'Collapse Track' : 'Expand Track', action: () => { t.height = t.height > 40 ? 34 : 76; app.changed(); } },
      { label: 'Expand All Tracks', action: () => { allTracks(seq).forEach((x) => (x.height = 76)); app.changed(); } },
      { label: 'Minimize All Tracks', action: () => { allTracks(seq).forEach((x) => (x.height = 26)); app.changed(); } },
    ]);
  }

  startDividerDrag(e) {
    e.preventDefault();
    const s0 = this.view.split;
    const avail = this.H - DIVIDER_H - this.capH;
    dragPointer(e, {
      cursor: 'row-resize',
      move: (dx, dy) => {
        this.view.split = clamp(s0 + dy / avail, 0.08, 0.92);
        this.layoutRegions();
        this.refreshHeaders();
        this.draw();
      },
    });
  }

  // ---------------- drawing ----------------
  requestDraw() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.draw();
    });
  }

  onTime(e) {
    const seq = this.seq;
    if (!seq || (e && e.seq && e.seq !== seq)) return;
    this.tc.set(seq.playhead, seq.settings.fps);
    // auto scroll during playback
    if (playback.playing && app.prefs.autoScroll !== 'none') {
      const x = this.f2x(seq.playhead);
      if (app.prefs.autoScroll === 'smooth') {
        if (x > this.W * 0.5 || x < 0) this.view.scroll = seq.playhead - (this.W * 0.5) / this.zoom;
      } else if (x > this.W - 4 || x < 0) this.view.scroll = seq.playhead - 4 / this.zoom;
    }
    this.requestDraw();
  }

  draw() {
    const seq = this.seq;
    const ctx = this.ctx;
    if (!this.W) return;
    ctx.fillStyle = '#1b1b1b';
    ctx.fillRect(0, 0, this.W, this.H);
    this.drawRuler();
    if (!seq) return;
    this.layoutRegions();
    const rows = this.trackRows();
    const fps = seq.settings.fps;
    const f0 = this.x2f(0), f1 = this.x2f(this.W);

    // regions backgrounds
    ctx.fillStyle = '#202020';
    ctx.fillRect(0, this.vTop, this.W, this.vH);
    ctx.fillRect(0, this.aTop, this.W, this.aH);

    // in/out shading
    const io = this.inOutRange();
    const drawIO = (top, hgt) => {
      if (!io) return;
      ctx.fillStyle = 'rgba(255,255,255,0.055)';
      const xa = this.f2x(io[0]), xb = this.f2x(io[1]);
      ctx.fillRect(xa, top, xb - xa, hgt);
    };

    // video region
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, this.vTop, this.W, this.vH);
    ctx.clip();
    drawIO(this.vTop, this.vH);
    for (const r of rows) if (r.kind === 'video') this.drawTrack(r, f0, f1);
    ctx.restore();

    // audio region
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, this.aTop, this.W, this.aH);
    ctx.clip();
    drawIO(this.aTop, this.aH);
    for (const r of rows) if (r.kind === 'audio') this.drawTrack(r, f0, f1);
    const mix = rows.find((r) => r.mix);
    if (mix) {
      ctx.fillStyle = '#262626';
      ctx.fillRect(0, mix.y, this.W, mix.h);
      ctx.strokeStyle = '#151515';
      ctx.beginPath();
      ctx.moveTo(0, mix.y + 0.5);
      ctx.lineTo(this.W, mix.y + 0.5);
      ctx.stroke();
    }
    ctx.restore();

    // captions
    if (this.capH) this.drawCaptions();

    // divider
    ctx.fillStyle = '#121212';
    ctx.fillRect(0, this.divY, this.W, DIVIDER_H);

    // drop ghost / move ghost
    if (this.ghost) this.drawGhost(this.ghost);
    if (this.dropGhost) this.drawGhost(this.dropGhost);

    // marquee
    if (this.marquee) {
      const m = this.marquee;
      ctx.strokeStyle = 'rgba(255,255,255,0.8)';
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(Math.min(m.x0, m.x1) + 0.5, Math.min(m.y0, m.y1) + 0.5, Math.abs(m.x1 - m.x0), Math.abs(m.y1 - m.y0));
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(80,140,255,0.08)';
      ctx.fillRect(Math.min(m.x0, m.x1), Math.min(m.y0, m.y1), Math.abs(m.x1 - m.x0), Math.abs(m.y1 - m.y0));
    }

    // razor preview
    if (this.razorX != null) {
      ctx.strokeStyle = '#ff5050';
      ctx.lineWidth = 1;
      ctx.beginPath();
      const ry = this.razorRow;
      if (ry) {
        ctx.moveTo(this.razorX + 0.5, ry.y);
        ctx.lineTo(this.razorX + 0.5, ry.y + ry.h);
      }
      ctx.stroke();
    }

    // snap indicator
    if (this.snapLine != null) {
      const x = Math.round(this.f2x(this.snapLine)) + 0.5;
      ctx.strokeStyle = '#ffffff';
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, this.H);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.moveTo(x - 5, 0);
      ctx.lineTo(x + 5, 0);
      ctx.lineTo(x, 6);
      ctx.fill();
    }

    // playhead
    const px = Math.round(this.f2x(seq.playhead)) + 0.5;
    if (px >= -2 && px <= this.W + 2) {
      ctx.strokeStyle = '#3b93ff';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, this.H);
      ctx.stroke();
    }

    // drag tooltip
    if (this.tip) {
      ctx.font = '11px ' + getComputedStyle(document.body).fontFamily;
      const w = ctx.measureText(this.tip.text).width + 12;
      const x = clamp(this.tip.x + 12, 2, this.W - w - 2), y = clamp(this.tip.y - 26, 2, this.H - 20);
      ctx.fillStyle = 'rgba(25,25,25,0.95)';
      ctx.strokeStyle = '#555';
      ctx.fillRect(x, y, w, 18);
      ctx.strokeRect(x + 0.5, y + 0.5, w - 1, 17);
      ctx.fillStyle = '#eee';
      ctx.fillText(this.tip.text, x + 6, y + 13);
    }
    this.updateHScroll();
  }

  inOutRange() {
    const s = this.seq;
    if (s.inPoint == null && s.outPoint == null) return null;
    const a = s.inPoint ?? 0;
    const b = s.outPoint != null ? s.outPoint + 1 : seqDuration(s);
    return [a, b];
  }

  drawTrack(r, f0, f1) {
    const ctx = this.ctx;
    const t = r.track;
    // track bg + separator
    ctx.fillStyle = t.target ? '#242424' : '#212121';
    ctx.fillRect(0, r.y, this.W, r.h);
    ctx.fillStyle = '#161616';
    ctx.fillRect(0, r.y + r.h - 1, this.W, 1);
    if (t.locked) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, r.y, this.W, r.h - 1);
      ctx.clip();
      ctx.strokeStyle = 'rgba(255,255,255,0.05)';
      for (let x = -r.h; x < this.W; x += 10) {
        ctx.beginPath();
        ctx.moveTo(x, r.y + r.h);
        ctx.lineTo(x + r.h, r.y);
        ctx.stroke();
      }
      ctx.restore();
    }
    // gap selection
    const gap = app.sel.gap;
    if (gap && gap.trackId === t.id) {
      ctx.fillStyle = 'rgba(70,130,220,0.35)';
      ctx.fillRect(this.f2x(gap.start), r.y + 1, (gap.end - gap.start) * this.zoom, r.h - 2);
    }
    const moving = this.ghost && !this.ghost.duplicate ? this.ghost.ids : null;
    for (const c of t.clips) {
      if (clipEnd(c) < f0 || c.start > f1) continue;
      this.drawClip(c, r, moving && moving.has(c.id));
    }
    for (const tr of t.transitions) this.drawTransition(t, tr, r);
  }

  drawClip(c, r, isMoving) {
    const ctx = this.ctx;
    const seq = this.seq;
    const fps = seq.settings.fps;
    const item = c.itemId ? findItem(app.project, c.itemId) : null;
    const x0 = this.f2x(c.start), x1 = this.f2x(clipEnd(c));
    const y = r.y + 1, hh = r.h - 3;
    const w = Math.max(1, x1 - x0);
    const sel = this.clipSel(c);
    const offline = item && item.type === 'media' && (item.offline || !app.rt(item.id).url);
    const missing = c.itemId && !item;
    let base = offline || missing ? '#c4141a' : labelColor(c.label);
    let fill = c.kind === 'audio' ? mix(base, '#141414', 0.42) : mix(base, '#161616', 0.35);
    if (sel) fill = mix(base, '#ffffff', 0.12);
    if (!c.enabled) fill = mix(fill, '#2a2a2a', 0.7);
    ctx.save();
    if (isMoving) ctx.globalAlpha = 0.45;
    ctx.beginPath();
    ctx.rect(Math.max(x0, -2), y, Math.min(x1, this.W + 2) - Math.max(x0, -2), hh);
    ctx.clip();
    ctx.fillStyle = fill;
    ctx.fillRect(x0, y, w, hh);
    const nameH = 14;
    // content: thumbnails / waveform
    if (hh > 22) {
      if (c.kind === 'video' && app.prefs.showThumbnails && item && item.type === 'media' && hh >= 30) this.drawThumbs(c, item, x0, x1, y + nameH, hh - nameH);
      if (c.kind === 'audio' && app.prefs.showWaveforms) this.drawWaveform(c, item, x0, x1, y + (hh > 34 ? nameH : 2), hh - (hh > 34 ? nameH : 2) - 1, base);
      if (c.kind === 'video' && c.graphic && hh >= 30) {
        ctx.fillStyle = 'rgba(0,0,0,0.25)';
        ctx.fillRect(x0, y + nameH, w, hh - nameH);
      }
    }
    // name bar
    ctx.fillStyle = sel ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.18)';
    ctx.fillRect(x0, y, w, Math.min(nameH, hh));
    let tx = Math.max(x0, 0) + 4;
    if (app.prefs.showFxBadges && w > 24) {
      const hasFx = c.effects.some((e) => !getEffectDef(e.type)?.intrinsic) || c.effects.some((e) => getEffectDef(e.type)?.intrinsic && Object.values(e.params).some((p) => p.kf && p.kf.length));
      ctx.fillStyle = hasFx ? '#e8c33d' : 'rgba(0,0,0,0.35)';
      ctx.fillRect(tx, y + 2, 14, 10);
      ctx.fillStyle = hasFx ? '#2a2000' : '#bbb';
      ctx.font = 'italic bold 9px Georgia, serif';
      ctx.fillText('fx', tx + 2.5, y + 10);
      tx += 18;
    }
    if (app.prefs.showNames && w > 30) {
      ctx.font = '11px "Source Sans 3", "Segoe UI", sans-serif';
      ctx.fillStyle = c.enabled ? '#f4f4f4' : '#8a8a8a';
      let name = c.name || (c.graphic ? 'Graphic' : 'Clip');
      if (c.speed !== 1 || c.reverse) name += ` [${c.reverse ? '-' : ''}${Math.round(c.speed * 10000) / 100}%]`;
      if (c.frameHold != null) name += ' [Frame Hold]';
      if (offline) name = 'Media Offline — ' + name;
      ctx.fillText(name, tx, y + 11);
      if (c.linkId == null && item && (item.type === 'media' && item.kind === 'video' && item.hasAudio)) {
        const tw = ctx.measureText(name).width;
        ctx.fillText(c.kind === 'video' ? ' [V]' : ' [A]', tx + tw, y + 11);
      }
    }
    // rubber band
    if (app.prefs.showKeyframes && hh > 18) this.drawRubberBand(c, x0, x1, y, hh);
    ctx.restore();
    // outline
    ctx.strokeStyle = sel ? '#ffffff' : 'rgba(0,0,0,0.55)';
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(x0) + 0.5, y + 0.5, Math.max(0, Math.round(w) - 1), hh - 1);
    // hover edge indicator
    if (this.hover && this.hover.clip === c && this.hover.edge) {
      const ex = this.hover.edge === 'in' ? x0 : x1;
      ctx.fillStyle = '#e94f4f';
      ctx.fillRect(this.hover.edge === 'in' ? ex : ex - 3, y, 3, hh);
    }
  }

  drawThumbs(c, item, x0, x1, y, hh) {
    const ctx = this.ctx;
    const fps = this.seq.settings.fps;
    const aspect = (item.width || 16) / (item.height || 9);
    const tw = Math.max(8, hh * aspect);
    const xs = Math.max(x0, Math.floor((0 - x0) / tw) * tw + x0);
    const xe = Math.min(x1, this.W);
    let n = 0;
    const dur = itemSourceDuration(app.project, item);
    for (let x = xs; x < xe && n < 120; x += tw, n++) {
      const f = this.x2f(x + 1);
      const t = clipSourceTime(c, f, fps, dur);
      const img = thumbAt(item, t);
      if (!img) continue;
      const dw = Math.min(tw, x1 - x);
      ctx.drawImage(img, 0, 0, img.width * (dw / tw), img.height, x, y, dw, hh);
    }
  }

  drawWaveform(c, item, x0, x1, y, hh, base) {
    if (!item) return;
    const ctx = this.ctx;
    const fps = this.seq.settings.fps;
    let peaks = null;
    if (item.type === 'media') peaks = app.rt(item.id).peaks;
    ctx.fillStyle = mix(base, '#ffffff', 0.45);
    const mid = y + hh / 2;
    if (!peaks) {
      if (item.type === 'synthetic' && (item.kind === 'bars' || item.kind === 'leader')) {
        ctx.fillRect(Math.max(x0, 0), mid - hh * 0.12, Math.min(x1, this.W) - Math.max(x0, 0), hh * 0.24);
      }
      return;
    }
    const vfx = c.effects.find((e) => e.type === 'volume');
    const lvl = vfx && !vfx.params.bypass?.v ? dbToGain(vfx.params.level.v) : 1;
    const gain = dbToGain(c.gain || 0) * lvl;
    const p = peaks.peaks;
    const rate = peaks.rate;
    const norm = 1 / Math.max(0.05, Math.min(1, peaks.max || 1));
    const xa = Math.max(Math.floor(x0), 0), xb = Math.min(Math.ceil(x1), this.W);
    const dur = item.duration || 0;
    for (let x = xa; x < xb; x++) {
      const fa = this.x2f(x), fb = this.x2f(x + 1);
      let ta = clipSourceTime(c, fa, fps, dur), tb = clipSourceTime(c, fb, fps, dur);
      if (ta > tb) [ta, tb] = [tb, ta];
      let i0 = Math.floor(ta * rate), i1 = Math.max(i0 + 1, Math.ceil(tb * rate));
      let m = 0;
      const step = Math.max(1, Math.floor((i1 - i0) / 24));
      for (let ch = 0; ch < p.length; ch++) {
        const arr = p[ch];
        for (let i = i0; i < i1 && i < arr.length; i += step) if (arr[i] > m) m = arr[i];
      }
      const v = Math.min(1, m * gain * norm * 0.9) * (hh / 2);
      if (v > 0.3) ctx.fillRect(x, mid - v, 1, v * 2);
    }
  }

  bandInfo(c) {
    if (c.kind === 'audio') {
      const fx = c.effects.find((e) => e.type === 'volume');
      return fx ? { fx, pid: 'level', toN: (db) => clamp((db + 60) / 66, 0, 1), fromN: (n) => n * 66 - 60, def: getEffectDef('volume').params[1] } : null;
    }
    const fx = c.effects.find((e) => e.type === 'opacity');
    return fx ? { fx, pid: 'opacity', toN: (v) => v / 100, fromN: (n) => n * 100, def: getEffectDef('opacity').params[1] } : null;
  }

  drawRubberBand(c, x0, x1, y, hh) {
    const b = this.bandInfo(c);
    if (!b) return;
    const ctx = this.ctx;
    const fps = this.seq.settings.fps;
    const p = b.fx.params[b.pid];
    const top = y + 3, bh = hh - 6;
    const yOf = (v) => top + (1 - b.toN(v)) * bh;
    ctx.strokeStyle = c.kind === 'audio' ? 'rgba(255,240,160,0.9)' : 'rgba(255,255,255,0.75)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (!isAnimated(p)) {
      const yy = Math.round(yOf(p.v)) + 0.5;
      ctx.moveTo(x0, yy);
      ctx.lineTo(x1, yy);
      ctx.stroke();
      return;
    }
    const step = 3;
    for (let x = Math.max(x0, 0); x <= Math.min(x1, this.W); x += step) {
      const v = evalParam(p, clipKfTime(c, this.x2f(x), fps), b.def);
      if (x === Math.max(x0, 0)) ctx.moveTo(x, yOf(v));
      else ctx.lineTo(x, yOf(v));
    }
    ctx.stroke();
    for (const k of p.kf) {
      const kx = this.f2x(kfTimeToFrame(c, k.t, fps));
      if (kx < x0 - 1 || kx > x1 + 1) continue;
      ctx.fillStyle = '#ffe58a';
      ctx.beginPath();
      ctx.arc(kx, yOf(k.v), 2.6, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  drawTransition(track, tr, r) {
    const ctx = this.ctx;
    const rg = transitionRange(track, tr);
    const x0 = this.f2x(rg.start), x1 = this.f2x(rg.end);
    if (x1 < 0 || x0 > this.W) return;
    const y = r.y + 1 + (r.h > 40 ? 0 : 0), hh = Math.max(10, r.h - 3);
    const sel = app.sel.transition === tr.id;
    ctx.fillStyle = sel ? 'rgba(170,190,255,0.85)' : 'rgba(150,150,180,0.78)';
    ctx.fillRect(x0, y, x1 - x0, hh);
    ctx.strokeStyle = sel ? '#fff' : 'rgba(0,0,0,0.6)';
    ctx.strokeRect(Math.round(x0) + 0.5, y + 0.5, Math.round(x1 - x0) - 1, hh - 1);
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath();
    if (rg.a && rg.b) {
      ctx.moveTo(x0, y + hh);
      ctx.lineTo(x1, y);
    } else if (rg.b) {
      ctx.moveTo(x0, y + hh);
      ctx.lineTo(x1, y);
    } else {
      ctx.moveTo(x0, y);
      ctx.lineTo(x1, y + hh);
    }
    ctx.stroke();
    if (x1 - x0 > 40) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0, y, x1 - x0, hh);
      ctx.clip();
      ctx.fillStyle = '#111';
      ctx.font = '10.5px "Source Sans 3", sans-serif';
      ctx.fillText(getTransitionDef(tr.type)?.name || tr.type, x0 + 4, y + Math.min(hh - 3, 12));
      ctx.restore();
    }
  }

  drawCaptions() {
    const ctx = this.ctx;
    const seq = this.seq;
    ctx.fillStyle = '#1e1e1e';
    ctx.fillRect(0, 0, this.W, this.capH);
    ctx.fillStyle = '#141414';
    ctx.fillRect(0, this.capH - 1, this.W, 1);
    for (const cap of seq.captions || []) {
      const x0 = this.f2x(cap.start), x1 = this.f2x(cap.end);
      if (x1 < 0 || x0 > this.W) continue;
      const sel = app.sel.caption === cap.id;
      ctx.fillStyle = sel ? '#f2c66b' : '#c98f2c';
      ctx.fillRect(x0, 2, x1 - x0, this.capH - 4);
      ctx.strokeStyle = sel ? '#fff' : 'rgba(0,0,0,0.5)';
      ctx.strokeRect(Math.round(x0) + 0.5, 2.5, Math.round(x1 - x0) - 1, this.capH - 5);
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0, 2, x1 - x0, this.capH - 4);
      ctx.clip();
      ctx.fillStyle = '#1b1300';
      ctx.font = '11px "Source Sans 3", sans-serif';
      ctx.fillText(cap.text.replace(/\n/g, ' '), x0 + 4, 16);
      ctx.restore();
    }
  }

  drawGhost(g) {
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 2]);
    for (const b of g.boxes) {
      const r = b.row;
      if (!r) continue;
      const x0 = this.f2x(b.start), x1 = this.f2x(b.start + b.dur);
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.fillRect(x0, r.y + 1, x1 - x0, r.h - 3);
      ctx.strokeRect(Math.round(x0) + 0.5, r.y + 1.5, Math.round(x1 - x0) - 1, r.h - 4);
      if (b.label && x1 - x0 > 30) {
        ctx.fillStyle = '#fff';
        ctx.font = '11px "Source Sans 3", sans-serif';
        ctx.fillText(b.label, x0 + 4, r.y + 13);
      }
    }
    ctx.restore();
  }

  drawRuler() {
    const ctx = this.rctx;
    const W = this.RW;
    ctx.fillStyle = '#232323';
    ctx.fillRect(0, 0, W, RULER_H);
    const seq = this.seq;
    if (!seq) return;
    const fps = seq.settings.fps;
    const zoom = this.zoom;
    // choose tick spacing
    const nom = Math.round(fps);
    const candidates = [1, 2, 5, 10, nom / 2, nom, nom * 2, nom * 5, nom * 10, nom * 15, nom * 30, nom * 60, nom * 120, nom * 300, nom * 600, nom * 1800, nom * 3600].filter((x) => x >= 1);
    let major = candidates.find((c) => c * zoom >= 90) || candidates[candidates.length - 1];
    let minor = candidates.slice().reverse().find((c) => c < major && c * zoom >= 8 && major % c === 0) || major;
    const f0 = Math.floor(this.x2f(0) / minor) * minor;
    const f1 = this.x2f(W);
    // in/out
    const io = this.inOutRange();
    if (io) {
      const xa = this.f2x(io[0]), xb = this.f2x(io[1]);
      ctx.fillStyle = 'rgba(255,255,255,0.13)';
      ctx.fillRect(xa, 0, xb - xa, RULER_H);
      ctx.fillStyle = '#9c9c9c';
      ctx.fillRect(xa, RULER_H - 5, xb - xa, 4);
    }
    // render bar
    this.drawRenderBar(ctx, W);
    ctx.strokeStyle = '#6a6a6a';
    ctx.fillStyle = '#9a9a9a';
    ctx.font = '10.5px "Source Sans 3", sans-serif';
    ctx.beginPath();
    for (let f = Math.max(0, f0); f <= f1; f += minor) {
      const x = Math.round(this.f2x(f)) + 0.5;
      const isMajor = Math.abs(f / major - Math.round(f / major)) < 1e-6;
      ctx.moveTo(x, isMajor ? 10 : RULER_H - 13);
      ctx.lineTo(x, RULER_H - 8);
      if (isMajor) ctx.fillText(framesToTC(Math.round(f), fps), x + 3, 12);
    }
    ctx.stroke();
    // markers
    for (const m of seq.markers) {
      const x = this.f2x(m.frame);
      if (x < -10 || x > W + 10) continue;
      const col = LABEL_COLORS[m.color] || m.color || '#5bbf5b';
      ctx.fillStyle = col;
      if (m.duration > 0) ctx.fillRect(x, 18, m.duration * zoom, 5);
      ctx.beginPath();
      ctx.moveTo(x - 5, 14);
      ctx.lineTo(x + 5, 14);
      ctx.lineTo(x + 5, 20);
      ctx.lineTo(x, 25);
      ctx.lineTo(x - 5, 20);
      ctx.closePath();
      ctx.fill();
      if (app.sel.marker === m.id) {
        ctx.strokeStyle = '#fff';
        ctx.stroke();
        ctx.strokeStyle = '#6a6a6a';
      }
    }
    // playhead head
    const px = Math.round(this.f2x(seq.playhead)) + 0.5;
    ctx.fillStyle = '#3b93ff';
    ctx.beginPath();
    ctx.moveTo(px - 6, RULER_H - 14);
    ctx.lineTo(px + 6, RULER_H - 14);
    ctx.lineTo(px + 6, RULER_H - 6);
    ctx.lineTo(px, RULER_H);
    ctx.lineTo(px - 6, RULER_H - 6);
    ctx.closePath();
    ctx.fill();
    ctx.fillRect(px - 0.5, 0, 1, RULER_H - 14);
  }

  drawRenderBar(ctx, W) {
    const seq = this.seq;
    const segs = [];
    for (const t of seq.videoTracks) {
      for (const c of t.clips) {
        const heavy = c.effects.some((e) => !getEffectDef(e.type)?.intrinsic) || c.speed !== 1;
        segs.push([c.start, clipEnd(c), heavy ? '#d8b52c' : null]);
      }
      for (const tr of t.transitions) {
        const r = transitionRange(t, tr);
        segs.push([r.start, r.end, '#d8b52c']);
      }
    }
    for (const [a, b, col] of segs) {
      if (!col) continue;
      ctx.fillStyle = col;
      ctx.fillRect(this.f2x(a), RULER_H - 3, (b - a) * this.zoom, 3);
    }
  }

  updateHScroll() {
    const seq = this.seq;
    if (!seq) return;
    const total = Math.max(seqDuration(seq) + seq.settings.fps * 10, this.x2f(this.W) + 1);
    const visible = this.W / this.zoom;
    const thumb = this.hscroll.firstChild;
    const W = this.hscroll.clientWidth;
    const w = Math.max(24, (visible / total) * W);
    const l = (this.view.scroll / total) * W;
    thumb.style.width = w + 'px';
    thumb.style.left = clamp(l, 0, W - w) + 'px';
  }

  // ---------------- zoom / scroll ----------------
  setZoom(z, anchorFrame = null) {
    const seq = this.seq;
    if (!seq) return;
    z = clamp(z, MIN_ZOOM, MAX_ZOOM);
    const af = anchorFrame ?? seq.playhead;
    const ax = this.f2x(af);
    this.view.zoom = z;
    this.view.scroll = Math.max(0, af - ax / z);
    if (ax < 0 || ax > this.W) this.view.scroll = Math.max(0, af - this.W / (2 * z));
    this.requestDraw();
  }
  zoomIn() {
    this.setZoom(this.zoom * 1.6);
  }
  zoomOut() {
    this.setZoom(this.zoom / 1.6);
  }
  zoomToFit() {
    const seq = this.seq;
    if (!seq) return;
    const dur = Math.max(seqDuration(seq), seq.settings.fps * 5);
    this.view.zoom = clamp((this.W - 40) / dur, MIN_ZOOM, MAX_ZOOM);
    this.view.scroll = 0;
    this.requestDraw();
  }
  scrollBy(px) {
    this.view.scroll = Math.max(0, this.view.scroll + px / this.zoom);
    this.requestDraw();
  }
  ensureVisible(frame) {
    const x = this.f2x(frame);
    if (x < 0 || x > this.W) {
      this.view.scroll = Math.max(0, frame - this.W / (3 * this.zoom));
      this.requestDraw();
    }
  }

  // ---------------- hit testing ----------------
  hitTest(x, y) {
    const seq = this.seq;
    const res = { x, y, frame: this.x2f(x) };
    const row = this.rowAt(y);
    if (!row) return res;
    if (row.caption) {
      res.caption = true;
      const f = res.frame;
      const cap = (seq.captions || []).find((c) => f >= c.start && f < c.end);
      if (cap) {
        res.cap = cap;
        const xa = this.f2x(cap.start), xb = this.f2x(cap.end);
        if (x - xa < EDGE_PX) res.capEdge = 'in';
        else if (xb - x < EDGE_PX) res.capEdge = 'out';
      }
      return res;
    }
    res.row = row;
    if (row.mix) return res;
    const t = row.track;
    res.track = t;
    // transitions first
    for (const tr of t.transitions) {
      const rg = transitionRange(t, tr);
      const xa = this.f2x(rg.start), xb = this.f2x(rg.end);
      if (x >= xa - 2 && x <= xb + 2) {
        res.transition = tr;
        res.trRange = rg;
        if (x - xa < 5) res.trEdge = 'in';
        else if (xb - x < 5) res.trEdge = 'out';
        else res.trEdge = 'body';
        return res;
      }
    }
    // clips: edges
    let best = null;
    for (const c of t.clips) {
      const xa = this.f2x(c.start), xb = this.f2x(clipEnd(c));
      const w = xb - xa;
      const edgePx = Math.min(EDGE_PX, w / 3);
      if (x >= xa - 1 && x <= xa + edgePx) best = best && best.edge === 'out' && x <= xa ? best : { clip: c, edge: 'in' };
      else if (x <= xb + 1 && x >= xb - edgePx) best = { clip: c, edge: 'out' };
      else if (x > xa && x < xb && !best) best = { clip: c, edge: null };
    }
    if (best) {
      res.clip = best.clip;
      res.edge = best.edge;
      // rubber band
      if (app.prefs.showKeyframes && !best.edge) {
        const b = this.bandInfo(best.clip);
        if (b) {
          const fps = seq.settings.fps;
          const p = b.fx.params[b.pid];
          const top = row.y + 4, bh = row.h - 9;
          const v = evalParam(p, clipKfTime(best.clip, res.frame, fps), b.def);
          const by = top + (1 - b.toN(v)) * bh;
          if (Math.abs(by - y) < 4 && row.h > 18) {
            res.band = b;
            if (p.kf) {
              const ki = p.kf.findIndex((k) => Math.abs(this.f2x(kfTimeToFrame(best.clip, k.t, fps)) - x) < 5);
              if (ki >= 0) res.kfIndex = ki;
            }
          }
        }
      }
    } else {
      const g = E.gapAt(t, Math.floor(res.frame));
      if (g) res.gap = g;
    }
    return res;
  }

  // ---------------- snapping ----------------
  snapTargets(exclude = new Set()) {
    const seq = this.seq;
    const pts = [0, seq.playhead];
    for (const t of allTracks(seq))
      for (const c of t.clips) {
        if (exclude.has(c.id)) continue;
        pts.push(c.start, clipEnd(c));
      }
    for (const m of seq.markers) pts.push(m.frame);
    if (seq.inPoint != null) pts.push(seq.inPoint);
    if (seq.outPoint != null) pts.push(seq.outPoint + 1);
    return pts;
  }
  snap(frames, targets) {
    // frames: candidate frame positions; returns delta adjustment
    if (!app.snapping) return { delta: 0, at: null };
    const thr = SNAP_PX / this.zoom;
    let best = null;
    for (const f of frames)
      for (const t of targets) {
        const d = t - f;
        if (Math.abs(d) <= thr && (!best || Math.abs(d) < Math.abs(best.delta))) best = { delta: d, at: t };
      }
    return best || { delta: 0, at: null };
  }

  // ---------------- events ----------------
  bindEvents() {
    const cv = this.canvas;
    cv.addEventListener('pointerdown', (e) => this.onDown(e));
    cv.addEventListener('pointermove', (e) => this.onHover(e));
    cv.addEventListener('pointerleave', () => {
      this.hover = null;
      this.razorX = null;
      this.requestDraw();
    });
    cv.addEventListener('dblclick', (e) => this.onDblClick(e));
    cv.addEventListener('contextmenu', (e) => this.onContext(e));
    cv.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.headers.addEventListener('wheel', (e) => this.onWheel(e, true), { passive: false });
    this.rulerCanvas.addEventListener('pointerdown', (e) => this.onRulerDown(e));
    this.rulerCanvas.addEventListener('dblclick', (e) => this.onRulerDbl(e));
    this.rulerCanvas.addEventListener('contextmenu', (e) => this.onRulerContext(e));
    this.rulerCanvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    // h scroll bar
    const thumb = this.hscroll.firstChild;
    thumb.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const grip = e.target.classList.contains('tl-hgrip') ? (e.target.classList.contains('l') ? 'l' : 'r') : null;
      const s0 = this.view.scroll, z0 = this.zoom;
      const W = this.hscroll.clientWidth;
      const seq = this.seq;
      const total = Math.max(seqDuration(seq) + seq.settings.fps * 10, this.x2f(this.W) + 1);
      const endF0 = s0 + this.W / z0;
      dragPointer(e, {
        move: (dx) => {
          const df = (dx / W) * total;
          if (!grip) this.view.scroll = Math.max(0, s0 + df);
          else if (grip === 'r') {
            const end = Math.max(s0 + 10, endF0 + df);
            this.view.zoom = clamp(this.W / (end - s0), MIN_ZOOM, MAX_ZOOM);
          } else {
            const start = clamp(s0 + df, 0, endF0 - 10);
            this.view.scroll = start;
            this.view.zoom = clamp(this.W / (endF0 - start), MIN_ZOOM, MAX_ZOOM);
          }
          this.requestDraw();
        },
      });
    });
    this.hscroll.addEventListener('pointerdown', (e) => {
      if (e.target !== this.hscroll) return;
      const r = this.hscroll.getBoundingClientRect();
      const seq = this.seq;
      const total = Math.max(seqDuration(seq) + seq.settings.fps * 10, this.x2f(this.W) + 1);
      this.view.scroll = Math.max(0, ((e.clientX - r.left) / r.width) * total - this.W / this.zoom / 2);
      this.requestDraw();
    });
    // drag & drop (project items, effects, OS files)
    const dz = this.canvasWrap;
    dz.addEventListener('dragover', (e) => this.onDragOver(e));
    dz.addEventListener('dragleave', () => {
      this.dropGhost = null;
      this.dropTarget = null;
      this.requestDraw();
    });
    dz.addEventListener('drop', (e) => this.onDrop(e));
    this.empty.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    this.empty.addEventListener('drop', (e) => this.onDropEmpty(e));
    this.root.addEventListener('dragover', (e) => {
      if (!this.seq) e.preventDefault();
    });
  }

  localXY(e) {
    const r = this.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  updateCursor(hit) {
    const tool = app.tool;
    let cur = 'default';
    const map = { razor: 'crosshair', hand: 'grab', zoom: 'zoom-in', slip: 'ew-resize', slide: 'ew-resize', pen: 'crosshair', trackFwd: 'e-resize', trackBack: 'w-resize' };
    if (map[tool]) cur = map[tool];
    if (hit) {
      if (hit.edge && ['select', 'ripple', 'rolling', 'rateStretch'].includes(tool)) cur = tool === 'rateStretch' ? 'ew-resize' : 'col-resize';
      if (hit.trEdge && hit.trEdge !== 'body' && tool === 'select') cur = 'col-resize';
      if (hit.band && (tool === 'select' || tool === 'pen')) cur = hit.kfIndex != null ? 'move' : 'ns-resize';
      if (hit.capEdge) cur = 'col-resize';
    }
    this.canvas.style.cursor = cur;
  }

  onHover(e) {
    if (this.drag || !this.seq) return;
    const [x, y] = this.localXY(e);
    const hit = this.hitTest(x, y);
    const prev = this.hover;
    this.hover = hit;
    this.updateCursor(hit);
    if (app.tool === 'razor' && hit.clip) {
      let f = Math.round(hit.frame);
      const s = this.snap([f], [this.seq.playhead, ...this.snapTargets()]);
      f += s.delta;
      this.razorX = this.f2x(f);
      this.razorRow = hit.row;
      this.requestDraw();
    } else if (this.razorX != null) {
      this.razorX = null;
      this.requestDraw();
    }
    if ((prev && prev.edge) !== hit.edge || (prev && prev.clip) !== hit.clip) this.requestDraw();
  }

  onWheel(e, fromHeaders = false) {
    if (!this.seq) return;
    e.preventDefault();
    const [x, y] = this.localXY(e);
    if (e.altKey || (e.ctrlKey && !fromHeaders)) {
      const f = this.x2f(x);
      const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.004));
      const z = clamp(this.zoom * factor, MIN_ZOOM, MAX_ZOOM);
      this.view.zoom = z;
      this.view.scroll = Math.max(0, f - x / z);
      this.requestDraw();
      return;
    }
    const horiz = Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey;
    if (horiz) {
      this.scrollBy(e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX);
      return;
    }
    // vertical scroll in hovered region if it overflows, else horizontal
    const inVideo = y < this.divY;
    const rows = this.trackRows();
    if (inVideo) {
      const content = this.seq.videoTracks.reduce((s, t) => s + t.height, 0);
      if (content > this.vH) {
        this.view.vScroll = clamp(this.view.vScroll - e.deltaY, 0, content - this.vH);
        this.refreshHeaders();
        this.requestDraw();
        return;
      }
    } else {
      const content = this.seq.audioTracks.reduce((s, t) => s + t.height, 0) + MIX_H;
      if (content > this.aH) {
        this.view.aScroll = clamp(this.view.aScroll + e.deltaY, 0, content - this.aH);
        this.refreshHeaders();
        this.requestDraw();
        return;
      }
    }
    void rows;
    this.scrollBy(e.deltaY);
  }

  // ---- ruler ----
  onRulerDown(e) {
    if (!this.seq || e.button !== 0) return;
    app.focusPanel('timeline');
    const r = this.rulerCanvas.getBoundingClientRect();
    const seq = this.seq;
    const x = e.clientX - r.left;
    // marker hit?
    const mk = seq.markers.find((m) => Math.abs(this.f2x(m.frame) - x) < 6 && e.clientY - r.top > 10 && e.clientY - r.top < 28);
    if (mk) {
      app.sel.marker = mk.id;
      const f0 = mk.frame;
      let moved = false;
      dragPointer(e, {
        move: (dx) => {
          if (!moved && Math.abs(dx) < 3) return;
          if (!moved) app.history.begin('Move Marker');
          moved = true;
          mk.frame = Math.max(0, Math.round(f0 + dx / this.zoom));
          this.requestDraw();
        },
        up: () => {
          if (moved) {
            app.history.commit();
            app.changed();
          } else app.setPlayhead(mk.frame);
        },
      });
      this.requestDraw();
      return;
    }
    playback.playing && playback.stop();
    const scrubTo = (cx, ev) => {
      let f = Math.round(this.x2f(cx - r.left));
      if (ev.shiftKey || app.snapping) {
        const s = this.snap([f], this.snapTargets());
        if (ev.shiftKey || Math.abs(s.delta) * this.zoom < 5) f += s.delta;
      }
      app.setPlayhead(Math.max(0, f), { source: 'scrub' });
      audio.scrub(seq, Math.max(0, f) / seq.settings.fps);
    };
    scrubTo(e.clientX, e);
    dragPointer(e, { move: (dx, dy, ev) => scrubTo(ev.clientX, ev) });
  }

  onRulerDbl(e) {
    const r = this.rulerCanvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const mk = this.seq?.markers.find((m) => Math.abs(this.f2x(m.frame) - x) < 6);
    if (mk) actions.editMarker(mk);
  }

  onRulerContext(e) {
    e.preventDefault();
    const seq = this.seq;
    if (!seq) return;
    const r = this.rulerCanvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const mk = seq.markers.find((m) => Math.abs(this.f2x(m.frame) - x) < 6);
    showMenu(e.clientX, e.clientY, [
      { label: 'Add Marker', kbd: 'M', action: () => actions.addMarker() },
      { label: 'Edit Marker…', disabled: !mk, action: () => actions.editMarker(mk) },
      { label: 'Clear Selected Marker', disabled: !mk, action: () => app.edit('Clear Marker', () => (seq.markers = seq.markers.filter((m) => m !== mk))) },
      { label: 'Clear All Markers', disabled: !seq.markers.length, action: () => app.edit('Clear All Markers', () => (seq.markers = [])) },
      { sep: true },
      { label: 'Mark In', kbd: 'I', action: () => actions.markIn() },
      { label: 'Mark Out', kbd: 'O', action: () => actions.markOut() },
      { label: 'Clear In and Out', action: () => actions.clearInOut() },
    ]);
  }

  // ---- canvas pointer ----
  onDown(e) {
    const seq = this.seq;
    if (!seq) return;
    app.focusPanel('timeline');
    this.canvas.focus({ preventScroll: true });
    const [x, y] = this.localXY(e);
    const hit = this.hitTest(x, y);
    if (e.button === 1 || app.tool === 'hand') return this.startHand(e);
    if (e.button !== 0) return;
    const tool = app.tool;
    if (tool === 'zoom') {
      const f = this.x2f(x);
      this.setZoom(e.altKey ? this.zoom / 2 : this.zoom * 2, f);
      return;
    }
    if (hit.caption) return this.captionDown(e, hit);
    if (!hit.row || hit.row.mix) {
      if (!e.shiftKey) app.clearSelection();
      return this.startMarquee(e, x, y);
    }
    const locked = hit.track && hit.track.locked;
    if (tool === 'razor') {
      if (!hit.clip || locked) return;
      let f = Math.round(hit.frame);
      const s = this.snap([f], [seq.playhead, ...this.snapTargets()]);
      f += s.delta;
      app.edit('Razor', () => E.razorAt(seq, hit.clip.id, f, { allTracks: e.shiftKey, linked: !e.altKey }));
      return;
    }
    if (tool === 'trackFwd' || tool === 'trackBack') {
      const f = hit.frame;
      const onlyTrack = e.shiftKey;
      const ids = [];
      for (const t of onlyTrack ? [hit.track] : allTracks(seq))
        for (const c of t.clips) if (tool === 'trackFwd' ? clipEnd(c) > f : c.start < f) ids.push(c.id);
      app.selectClips(ids);
      if (ids.length) return this.startMove(e, hit, ids);
      return;
    }
    if (hit.transition && tool === 'select') {
      app.clearSelection(true);
      app.sel.transition = hit.transition.id;
      app.bus.emit('selection:changed');
      if (!locked) this.startTransitionDrag(e, hit);
      return;
    }
    if ((hit.band && (tool === 'select' || tool === 'pen')) || (tool === 'pen' && hit.clip)) {
      if (!locked) return this.startBand(e, hit);
    }
    if (hit.clip) {
      const c = hit.clip;
      if (hit.edge && !locked && ['select', 'ripple', 'rolling', 'rateStretch'].includes(tool)) {
        let mode = tool === 'ripple' ? 'ripple' : tool === 'rolling' ? 'roll' : tool === 'rateStretch' ? 'rate' : 'trim';
        if (tool === 'select' && (e.ctrlKey || e.metaKey)) mode = e.shiftKey ? 'roll' : 'ripple';
        return this.startTrim(e, hit, mode);
      }
      // selection
      const linked = app.linkedSelection && !e.altKey;
      const group = groupedClips(seq, c);
      let ids = [];
      for (const g of group) ids.push(...(linked ? linkedClips(seq, g) : [g]).map((x) => x.id));
      ids = [...new Set(ids)];
      if (e.shiftKey) app.selectClips(ids, { toggle: true });
      else if (!app.sel.clips.has(c.id)) app.selectClips(ids);
      else if (e.altKey) app.selectClips([c.id]);
      if (locked) return;
      if (tool === 'slip') return this.startSlip(e, hit);
      if (tool === 'slide') return this.startSlide(e, hit);
      if (tool === 'select') return this.startMove(e, hit, [...app.sel.clips], e.altKey);
      return;
    }
    if (hit.gap) {
      app.clearSelection(true);
      app.sel.gap = { trackId: hit.track.id, start: hit.gap.start, end: hit.gap.end };
      app.bus.emit('selection:changed');
      this.requestDraw();
      return;
    }
    if (!e.shiftKey) app.clearSelection();
    this.startMarquee(e, x, y);
  }

  startHand(e) {
    e.preventDefault();
    const s0 = this.view.scroll;
    const v0 = this.view.vScroll, a0 = this.view.aScroll;
    const [, y] = this.localXY(e);
    const inV = y < this.divY;
    this.canvas.style.cursor = 'grabbing';
    dragPointer(e, {
      move: (dx, dy) => {
        this.view.scroll = Math.max(0, s0 - dx / this.zoom);
        if (inV) this.view.vScroll = v0 + dy;
        else this.view.aScroll = a0 - dy;
        this.refreshHeaders();
        this.requestDraw();
      },
      up: () => this.updateCursor(),
    });
  }

  startMarquee(e, x, y) {
    this.marquee = { x0: x, y0: y, x1: x, y1: y };
    const base = new Set(e.shiftKey ? app.sel.clips : []);
    dragPointer(e, {
      move: (dx, dy) => {
        this.marquee.x1 = x + dx;
        this.marquee.y1 = y + dy;
        const xa = Math.min(x, x + dx), xb = Math.max(x, x + dx), ya = Math.min(y, y + dy), yb = Math.max(y, y + dy);
        const fa = this.x2f(xa), fb = this.x2f(xb);
        const ids = new Set(base);
        for (const r of this.trackRows()) {
          if (r.mix || r.y + r.h < ya || r.y > yb) continue;
          for (const c of r.track.clips) if (clipEnd(c) > fa && c.start < fb) {
            for (const l of app.linkedSelection ? linkedClips(this.seq, c) : [c]) ids.add(l.id);
          }
        }
        app.sel.clips = ids;
        app.bus.emit('selection:changed');
        this.requestDraw();
      },
      up: () => {
        this.marquee = null;
        this.requestDraw();
      },
    });
  }

  rowForTrack(kind, index) {
    return this.trackRows().find((r) => r.kind === kind && r.index === index) || null;
  }

  startMove(e, hit, ids, duplicate = false) {
    const seq = this.seq;
    const fps = seq.settings.fps;
    const entries = ids.map((id) => findClip(seq, id)).filter(Boolean);
    if (!entries.length) return;
    const exclude = new Set(ids);
    const targets = this.snapTargets(duplicate ? new Set() : exclude);
    const grabbedKind = hit.row.kind;
    const grabbedIndex = hit.row.index;
    const f0 = hit.frame;
    let started = false;
    let dF = 0, dV = 0, dA = 0;
    const altDup = duplicate;
    dragPointer(e, {
      move: (dx, dy, ev) => {
        if (!started && Math.hypot(dx, dy) < 4) return;
        started = true;
        const [x, y] = this.localXY(ev);
        dF = Math.round(this.x2f(x) - f0);
        const minStart = Math.min(...entries.map((en) => en.clip.start));
        dF = Math.max(dF, -minStart);
        const edges = [];
        for (const en of entries) edges.push(en.clip.start + dF, clipEnd(en.clip) + dF);
        const s = this.snap(edges, targets);
        dF += s.delta;
        this.snapLine = s.at;
        // vertical
        const row = this.rowAt(y);
        let away = 0;
        if (row && !row.mix && !row.caption && row.kind === grabbedKind) away = row.index - grabbedIndex;
        else if (y < this.vTop + 4 && grabbedKind === 'video') away = seq.videoTracks.length - grabbedIndex;
        else if (row && row.mix && grabbedKind === 'audio') away = seq.audioTracks.length - grabbedIndex;
        else away = this._lastAway || 0;
        this._lastAway = away;
        dV = away;
        dA = away;
        const vIdx = entries.filter((en) => en.kind === 'video').map((en) => en.index);
        const aIdx = entries.filter((en) => en.kind === 'audio').map((en) => en.index);
        if (vIdx.length) dV = Math.max(dV, -Math.min(...vIdx));
        if (aIdx.length) dA = Math.max(dA, -Math.min(...aIdx));
        const insert = ev.ctrlKey || ev.metaKey;
        this.ghost = {
          ids: exclude,
          duplicate: altDup,
          boxes: entries.map((en) => ({
            start: en.clip.start + dF,
            dur: en.clip.dur,
            row: this.rowForTrack(en.kind, en.index + (en.kind === 'video' ? dV : dA)) || (en.kind === 'video' ? { y: this.vTop, h: 30 } : { y: this.aTop + this.aH - 30, h: 30 }),
            label: en.clip.name,
          })),
        };
        this.tip = { x, y, text: (dF >= 0 ? '+' : '-') + framesToTC(Math.abs(dF), fps) + (insert ? '  Insert' : '') + (altDup ? '  Duplicate' : '') };
        this.requestDraw();
      },
      up: (ev) => {
        this.ghost = null;
        this.snapLine = null;
        this.tip = null;
        this._lastAway = 0;
        if (started && (dF !== 0 || dV !== 0 || dA !== 0 || altDup)) {
          const mode = ev.ctrlKey || ev.metaKey ? 'insert' : 'overwrite';
          const moved = app.edit(altDup ? 'Duplicate' : 'Move', () => E.moveClips(seq, ids, dF, dV, dA, { mode, duplicate: altDup }));
          if (moved && moved.length) app.selectClips(moved.map((c) => c.id));
        }
        this.requestDraw();
      },
    });
  }

  // Live-edit helper: restore the sequence from a snapshot then re-apply op.
  liveEdit(label, apply) {
    const seq = this.seq;
    const snap = JSON.stringify(seq);
    let begun = false;
    return {
      update: (...args) => {
        if (!begun) {
          app.history.begin(label);
          begun = true;
        }
        const fresh = JSON.parse(snap);
        for (const k of Object.keys(seq)) if (k !== 'view' && k !== 'playhead') seq[k] = fresh[k];
        const r = apply(...args);
        app.bus.emit('project:changed', { live: true });
        return r;
      },
      end: () => {
        if (begun) {
          app.history.commit();
          app.bus.emit('project:changed', { label });
        }
      },
    };
  }

  startTrim(e, hit, mode) {
    const seq = this.seq;
    const fps = seq.settings.fps;
    const c = hit.clip;
    const edge = hit.edge;
    const linked = app.linkedSelection && !e.altKey;
    let ids = linked ? linkedClips(seq, c).map((x) => x.id) : [c.id];
    if (app.sel.clips.has(c.id) && app.sel.clips.size > ids.length && mode === 'trim') {
      // trim all selected clips sharing this edge position
      const pos = edge === 'in' ? c.start : clipEnd(c);
      ids = [...app.sel.clips].filter((id) => {
        const f = findClip(seq, id);
        return f && (edge === 'in' ? f.clip.start : clipEnd(f.clip)) === pos;
      });
    }
    // rolling partner
    let partner = null;
    if (mode === 'roll') {
      const nb = E.neighbors(hit.track, c);
      partner = edge === 'out' ? (nb.next && nb.next.start === clipEnd(c) ? nb.next : null) : nb.prev && clipEnd(nb.prev) === c.start ? nb.prev : null;
      if (!partner) mode = 'trim';
    }
    const edgeFrame = edge === 'in' ? c.start : clipEnd(c);
    const targets = this.snapTargets(new Set(ids));
    const live = this.liveEdit(
      mode === 'ripple' ? 'Ripple Trim' : mode === 'roll' ? 'Rolling Edit' : mode === 'rate' ? 'Rate Stretch' : 'Trim',
      (delta) => {
        if (mode === 'roll') {
          const L = edge === 'out' ? c.id : partner.id, R = edge === 'out' ? partner.id : c.id;
          const ids2 = [[L, R]];
          if (linked) {
            // roll linked partners at the same edit point too
            const lc = linkedClips(seq, findClip(seq, L).clip).filter((x) => x.id !== L);
            for (const l of lc) {
              const tr = findClip(seq, l.id).track;
              const nb = E.neighbors(tr, l);
              if (nb.next && nb.next.start === clipEnd(l)) ids2.push([l.id, nb.next.id]);
            }
          }
          let d = delta;
          for (const [a, b] of ids2) d = E.rollEdit(seq, a, b, d) || 0;
          return d;
        }
        if (mode === 'rate') return E.rateStretch(seq, ids, edge, delta);
        return E.trimEdge(seq, ids, edge, delta, { ripple: mode === 'ripple' });
      },
    );
    let lastDelta = 0;
    dragPointer(e, {
      cursor: 'col-resize',
      move: (dx, dy, ev) => {
        const [x, y] = this.localXY(ev);
        let f = Math.round(this.x2f(x));
        const s = this.snap([f], targets);
        f += s.delta;
        this.snapLine = s.at;
        const delta = f - edgeFrame;
        lastDelta = live.update(delta) || 0;
        const fc = findClip(seq, c.id)?.clip;
        if (fc) {
          const pf = edge === 'in' ? fc.start : clipEnd(fc) - 1;
          app.bus.emit('monitor:preview', { frame: pf });
        }
        this.tip = { x, y, text: (lastDelta >= 0 ? '+' : '-') + framesToTC(Math.abs(lastDelta), fps) + (fc ? '   Duration: ' + framesToTC(fc.dur, fps) : '') };
        this.requestDraw();
      },
      up: () => {
        live.end();
        this.snapLine = null;
        this.tip = null;
        app.bus.emit('monitor:preview', null);
        this.requestDraw();
      },
    });
  }

  startSlip(e, hit) {
    const seq = this.seq;
    const ids = app.linkedSelection ? linkedClips(seq, hit.clip).map((x) => x.id) : [hit.clip.id];
    const live = this.liveEdit('Slip', (d) => E.slip(seq, ids, d));
    dragPointer(e, {
      move: (dx, dy, ev) => {
        const d = Math.round(dx / this.zoom);
        live.update(d);
        const c = findClip(seq, hit.clip.id)?.clip;
        if (c) app.bus.emit('monitor:preview', { frame: c.start, slipClip: c.id });
        const [x, y] = this.localXY(ev);
        this.tip = { x, y, text: 'Slip ' + (d >= 0 ? '+' : '-') + framesToTC(Math.abs(d), seq.settings.fps) };
        this.requestDraw();
      },
      up: () => {
        live.end();
        this.tip = null;
        app.bus.emit('monitor:preview', null);
      },
    });
  }

  startSlide(e, hit) {
    const seq = this.seq;
    const live = this.liveEdit('Slide', (d) => E.slide(seq, hit.clip.id, d));
    dragPointer(e, {
      move: (dx, dy, ev) => {
        const d = Math.round(dx / this.zoom);
        const r = live.update(d);
        const [x, y] = this.localXY(ev);
        this.tip = { x, y, text: 'Slide ' + (r >= 0 ? '+' : '-') + framesToTC(Math.abs(r || 0), seq.settings.fps) };
        this.requestDraw();
      },
      up: () => {
        live.end();
        this.tip = null;
      },
    });
  }

  startTransitionDrag(e, hit) {
    const seq = this.seq;
    const tr0 = hit.transition;
    const trackId = hit.track.id;
    const trId = tr0.id;
    const mode = hit.trEdge;
    const live = this.liveEdit(mode === 'body' ? 'Move Transition' : 'Transition Duration', (d) => {
      const t = allTracks(seq).find((x) => x.id === trackId);
      const tr = t.transitions.find((x) => x.id === trId);
      const rg = transitionRange(t, tr);
      const aDur = rg.a ? rg.a.dur : 0, bDur = rg.b ? rg.b.dur : 0;
      if (mode === 'body') {
        if (!(rg.a && rg.b)) return;
        tr.offset = clamp(tr.offset - d, Math.max(0, tr.dur - bDur), Math.min(tr.dur, aDur));
      } else if (mode === 'in') {
        let off = tr.offset - d;
        off = clamp(off, rg.a ? 0 : 0, rg.a ? aDur : 0);
        const dur = tr.dur + (off - tr.offset);
        if (dur >= 1 && (rg.b ? dur - off <= bDur : true)) {
          tr.dur = dur;
          tr.offset = off;
        }
      } else {
        let dur = Math.max(1, tr.dur + d);
        if (rg.b) dur = Math.min(dur, tr.offset + bDur);
        else dur = Math.min(dur, tr.offset);
        if (!rg.b) {
          // single-sided at clip end: grow to the left
          tr.offset = clamp(tr.offset, 1, aDur);
        }
        tr.dur = Math.max(1, dur);
        if (!rg.b) tr.offset = tr.dur;
      }
    });
    let moved = false;
    dragPointer(e, {
      cursor: mode === 'body' ? 'grabbing' : 'col-resize',
      move: (dx) => {
        if (!moved && Math.abs(dx) < 3) return;
        moved = true;
        live.update(Math.round(dx / this.zoom));
        this.requestDraw();
      },
      up: () => live.end(),
    });
  }

  startBand(e, hit) {
    const seq = this.seq;
    const fps = seq.settings.fps;
    const c = hit.clip;
    const b = hit.band || this.bandInfo(c);
    if (!b) return;
    const row = hit.row;
    const top = row.y + 4, bh = row.h - 9;
    const p0 = b.fx.params[b.pid];
    const addKf = e.ctrlKey || e.metaKey || app.tool === 'pen';
    if (addKf && hit.kfIndex == null) {
      app.edit('Add Keyframe', () => {
        const v = evalParam(p0, clipKfTime(c, hit.frame, fps), b.def);
        addKeyframe(p0, clipKfTime(c, Math.round(hit.frame), fps), v);
      });
      return;
    }
    const clipId = c.id, fxId = b.fx.id, pid = b.pid;
    const getP = () => findClip(seq, clipId).clip.effects.find((f) => f.id === fxId).params[pid];
    const v0 = evalParam(p0, clipKfTime(c, hit.frame, fps), b.def);
    const n0 = b.toN(v0);
    const ki = hit.kfIndex;
    const kf0 = p0.kf ? JSON.parse(JSON.stringify(p0.kf)) : null;
    const live = this.liveEdit(ki != null ? 'Move Keyframe' : b.pid === 'level' ? 'Volume Level' : 'Opacity', (dx, dy) => {
      const p = getP();
      const nv = clamp(n0 - dy / bh, 0, 1);
      const val = Math.round(b.fromN(nv) * 10) / 10;
      if (ki != null) {
        const k = p.kf[ki];
        k.v = val;
        const cc = findClip(seq, clipId).clip;
        const f = clamp(kfTimeToFrame(cc, kf0[ki].t, fps) + Math.round(dx / this.zoom), cc.start, clipEnd(cc));
        k.t = clipKfTime(cc, f, fps);
        p.kf.sort((a, b2) => a.t - b2.t);
      } else if (!isAnimated(p)) p.v = val;
      else {
        // shift segment keyframes
        const dv = val - v0;
        for (const k of p.kf) k.v = b.fromN(clamp(b.toN(k.v + dv), 0, 1));
      }
      return val;
    });
    dragPointer(e, {
      cursor: ki != null ? 'move' : 'ns-resize',
      move: (dx, dy, ev) => {
        const v = live.update(dx, dy);
        const [x, y] = this.localXY(ev);
        this.tip = { x, y, text: b.pid === 'level' ? (v <= -60 ? '-∞' : v.toFixed(1)) + ' dB' : v.toFixed(1) + ' %' };
        this.requestDraw();
      },
      up: () => {
        live.end();
        this.tip = null;
        this.requestDraw();
      },
    });
  }

  captionDown(e, hit) {
    const seq = this.seq;
    if (!hit.cap) {
      app.sel.caption = null;
      this.requestDraw();
      return;
    }
    app.clearSelection(true);
    app.sel.caption = hit.cap.id;
    app.bus.emit('selection:changed');
    const capId = hit.cap.id;
    const s0 = hit.cap.start, e0 = hit.cap.end;
    const mode = hit.capEdge || 'body';
    const live = this.liveEdit('Edit Caption', (d) => {
      const cap = seq.captions.find((c) => c.id === capId);
      if (mode === 'body') {
        const nd = Math.max(-s0, d);
        cap.start = s0 + nd;
        cap.end = e0 + nd;
      } else if (mode === 'in') cap.start = clamp(s0 + d, 0, e0 - 1);
      else cap.end = Math.max(s0 + 1, e0 + d);
    });
    let moved = false;
    dragPointer(e, {
      move: (dx) => {
        if (!moved && Math.abs(dx) < 3) return;
        moved = true;
        live.update(Math.round(dx / this.zoom));
        this.requestDraw();
      },
      up: () => live.end(),
    });
  }

  onDblClick(e) {
    const [x, y] = this.localXY(e);
    const hit = this.hitTest(x, y);
    if (hit.cap) return app.services.captions?.editCaption(hit.cap);
    if (hit.transition) {
      app.panels.effectControls && app.services.layout.activate('effectControls');
      return;
    }
    if (hit.clip) {
      const item = hit.clip.itemId ? findItem(app.project, hit.clip.itemId) : null;
      if (item && item.type === 'sequence') return app.openSequence(item.id);
      if (hit.clip.graphic) return app.services.layout.activate('essentialGraphics');
      if (item) actions.openInSource(item, clipSourceTime(hit.clip, Math.floor(hit.frame), this.seq.settings.fps, item.duration));
    }
  }

  onContext(e) {
    e.preventDefault();
    const seq = this.seq;
    if (!seq) return;
    const [x, y] = this.localXY(e);
    const hit = this.hitTest(x, y);
    if (hit.cap) {
      app.sel.caption = hit.cap.id;
      return showMenu(e.clientX, e.clientY, [
        { label: 'Edit Caption Text…', action: () => app.services.captions.editCaption(hit.cap) },
        { label: 'Delete Caption', action: () => app.edit('Delete Caption', () => (seq.captions = seq.captions.filter((c) => c.id !== hit.cap.id))) },
      ]);
    }
    if (hit.transition) {
      app.clearSelection(true);
      app.sel.transition = hit.transition.id;
      app.bus.emit('selection:changed');
      return showMenu(e.clientX, e.clientY, [
        { label: 'Set Selected as Default Transition', action: () => actions.setDefaultTransition(hit.transition.type) },
        { sep: true },
        { label: 'Clear', action: () => app.edit('Clear Transition', () => E.removeTransition(seq, hit.transition.id)) },
      ]);
    }
    if (hit.clip) {
      if (!app.sel.clips.has(hit.clip.id)) {
        const ids = app.linkedSelection ? linkedClips(seq, hit.clip).map((c) => c.id) : [hit.clip.id];
        app.selectClips(ids);
      }
      return showMenu(e.clientX, e.clientY, actions.clipContextMenu(hit.clip, Math.floor(hit.frame)));
    }
    if (hit.gap) {
      app.clearSelection(true);
      app.sel.gap = { trackId: hit.track.id, start: hit.gap.start, end: hit.gap.end };
      app.bus.emit('selection:changed');
      this.requestDraw();
      return showMenu(e.clientX, e.clientY, [{ label: 'Ripple Delete', action: () => actions.rippleDeleteGap() }]);
    }
    showMenu(e.clientX, e.clientY, [
      { label: 'Paste', kbd: MOD + '+V', disabled: !app.clipboard, action: () => actions.paste(false) },
      { label: 'Paste Insert', kbd: MOD + '+Shift+V', disabled: !app.clipboard, action: () => actions.paste(true) },
      { sep: true },
      { label: 'Add Marker', action: () => actions.addMarker() },
      { label: 'Close All Gaps', action: () => app.edit('Close Gaps', () => E.closeAllGaps(seq)) },
    ]);
  }

  // ---- DnD ----
  dragPayload(e) {
    const types = [...(e.dataTransfer?.types || [])];
    if (types.includes('application/x-videdi-items')) return { kind: 'items' };
    if (types.includes('application/x-videdi-effect')) return { kind: 'effect' };
    if (types.includes('Files')) return { kind: 'files' };
    return null;
  }

  onDragOver(e) {
    const p = this.dragPayload(e);
    if (!p || !this.seq) return;
    e.preventDefault();
    const [x, y] = this.localXY(e);
    if (p.kind === 'effect') {
      e.dataTransfer.dropEffect = 'copy';
      const hit = this.hitTest(x, y);
      this.dropTarget = hit;
      this.hover = hit.clip ? { clip: hit.clip, edge: null } : null;
      this.requestDraw();
      return;
    }
    e.dropEffect = 'copy';
    e.dataTransfer.dropEffect = 'copy';
    const drag = app.dragItems;
    if (p.kind === 'items' && drag) {
      const seq = this.seq;
      let f = Math.max(0, Math.round(this.x2f(x)));
      const durs = drag.items.map((it) => E.defaultItemRange(it, seq.settings.fps).dur);
      const total = durs.reduce((a, b) => a + b, 0);
      const s = this.snap([f, f + total], this.snapTargets());
      f += s.delta;
      this.snapLine = s.at;
      const row = this.rowAt(y);
      let vIdx = seq.patch.video ?? 0, aIdx = seq.patch.audio ?? 0;
      if (row && row.kind === 'video') vIdx = row.index;
      else if (row && row.kind === 'audio') aIdx = row.index;
      else if (y < this.vTop + 10) vIdx = seq.videoTracks.length;
      else if (row && row.mix) aIdx = seq.audioTracks.length;
      const boxes = [];
      let pos = f;
      drag.items.forEach((it, i) => {
        if (E.itemHasVideo(it) && drag.video !== false) boxes.push({ start: pos, dur: durs[i], row: this.rowForTrack('video', vIdx) || { y: this.vTop + 2, h: 30 }, label: it.name });
        if (E.itemHasAudio(it) && drag.audio !== false) boxes.push({ start: pos, dur: durs[i], row: this.rowForTrack('audio', aIdx) || { y: this.aTop + this.aH - 32, h: 30 }, label: it.name });
        pos += durs[i];
      });
      this.dropGhost = { boxes };
      this.dropTarget = { f, vIdx, aIdx };
      this.tip = { x, y, text: framesToTC(f, seq.settings.fps) + (e.ctrlKey || e.metaKey ? '  Insert' : '  Overwrite') };
      this.requestDraw();
    }
  }

  async onDrop(e) {
    e.preventDefault();
    const p = this.dragPayload(e);
    const seq = this.seq;
    const [x, y] = this.localXY(e);
    this.dropGhost = null;
    this.snapLine = null;
    this.tip = null;
    if (!p || !seq) return;
    if (p.kind === 'effect') {
      const data = JSON.parse(e.dataTransfer.getData('application/x-videdi-effect'));
      const hit = this.hitTest(x, y);
      this.hover = null;
      actions.dropEffectOnTimeline(data, hit);
      return;
    }
    if (p.kind === 'files') {
      const { importFiles } = await import('../../core/media.js');
      const items = await importFiles([...e.dataTransfer.files]);
      if (!items.length) return;
      const f = Math.max(0, Math.round(this.x2f(x)));
      const row = this.rowAt(y);
      actions.placeItems(items, f, {
        vTrack: row && row.kind === 'video' ? row.index : seq.patch.video ?? 0,
        aTrack: row && row.kind === 'audio' ? row.index : seq.patch.audio ?? 0,
        insert: e.ctrlKey || e.metaKey,
      });
      return;
    }
    if (p.kind === 'items' && app.dragItems && this.dropTarget) {
      const t = this.dropTarget;
      actions.placeItems(app.dragItems.items, t.f, { vTrack: t.vIdx, aTrack: t.aIdx, insert: e.ctrlKey || e.metaKey, video: app.dragItems.video, audio: app.dragItems.audio, srcRange: app.dragItems.srcRange });
      app.dragItems = null;
    }
    this.requestDraw();
  }

  async onDropEmpty(e) {
    e.preventDefault();
    if (this.seq) return;
    let items = app.dragItems?.items;
    if (!items && e.dataTransfer.files.length) {
      const { importFiles } = await import('../../core/media.js');
      items = await importFiles([...e.dataTransfer.files]);
    }
    if (items && items.length) actions.newSequenceFromItems(items);
  }

  // ---- menus ----
  settingsMenu(anchor) {
    const r = anchor.getBoundingClientRect();
    const tog = (k, label) => ({ label, checked: !!app.prefs[k], action: () => { app.prefs[k] = !app.prefs[k]; app.savePrefs(); } });
    showMenu(r.left, r.bottom, [
      tog('showThumbnails', 'Show Video Thumbnails'),
      tog('showWaveforms', 'Show Audio Waveform'),
      tog('showKeyframes', 'Show Clip Keyframes'),
      tog('showNames', 'Show Clip Names'),
      tog('showFxBadges', 'Show Fx Badges'),
      tog('showCaptionTrack', 'Show Captions Track'),
      { sep: true },
      { label: 'Expand All Tracks', action: () => { allTracks(this.seq).forEach((t) => (t.height = 76)); app.changed(); } },
      { label: 'Minimize All Tracks', action: () => { allTracks(this.seq).forEach((t) => (t.height = 26)); app.changed(); } },
    ]);
  }

  panelMenu() {
    const seq = this.seq;
    return [
      { label: 'Close Sequence', disabled: !seq, action: () => app.closeSequence(seq.id) },
      { label: 'Sequence Settings…', disabled: !seq, action: () => actions.sequenceSettings() },
      { sep: true },
      { label: 'Snap in Timeline', checked: app.snapping, action: () => actions.toggleSnap() },
      { label: 'Linked Selection', checked: app.linkedSelection, action: () => actions.toggleLinked() },
      { sep: true },
      { label: 'Zoom to Sequence', kbd: '\\', action: () => this.zoomToFit() },
    ];
  }
}

export const timeline = new TimelinePanel();
