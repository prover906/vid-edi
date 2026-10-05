// Source & Program monitors.

import { app } from '../../core/app.js';
import { h, clamp, dragPointer, MOD, downloadBlob } from '../../core/util.js';
import { framesToTC, tcToFrames } from '../../core/timecode.js';
import { findItem, findClip, clipEnd, seqDuration, clipKfTime, itemSourceDuration, evalEffectParams, kfTimeToFrame } from '../../core/model.js';
import { evalParam, setParamValue } from '../../core/keyframes.js';
import { registerPanel } from '../layout.js';
import { icon } from '../icons.js';
import { iconButton, dropdown, timecodeField } from '../widgets.js';
import { showMenu } from '../menus.js';
import { playback } from '../../engine/playback.js';
import { audio } from '../../engine/audioEngine.js';
import { motionMatrix, motionParams, clipFit, clipSourceDims, activeTrackClips, invertAffine, tracePath } from '../../engine/compositor.js';
import { layerQuad, layerTransform, fontString } from '../../engine/graphics.js';
import { actions } from '../../core/actions.js';
import { thumbAt } from '../../core/media.js';
import { getEffectDef } from '../../core/registry.js';

const ZOOMS = ['Fit', '10%', '25%', '50%', '75%', '100%', '150%', '200%', '400%'];
const RES = [{ label: 'Full', value: 'full', f: 1 }, { label: '1/2', value: 'half', f: 0.5 }, { label: '1/4', value: 'quarter', f: 0.25 }, { label: '1/8', value: 'eighth', f: 0.125 }];

function applyAff(m, x, y) {
  return [m[0] * x + m[1] * y + m[2], m[3] * x + m[4] * y + m[5]];
}

class MonitorBase {
  constructor(id, title) {
    this.id = id;
    this.def = registerPanel({ id, title, tabTitle: () => this.tabTitle(), onResize: () => this.resize(), onShow: () => this.resize(), menu: () => this.panelMenu() });
    this.root = this.def.el;
    this.root.classList.add('mon-root');
    this.zoom = 'Fit';
    this.pan = [0, 0];
    this.view = h('div.mon-view');
    this.canvas = h('canvas.mon-canvas');
    this.overlay = h('canvas.mon-overlay');
    this.view.append(this.canvas, this.overlay);
    this.scrub = h('canvas.mon-scrub');
    this.tcLeft = timecodeField({ frames: 0, fps: 30, cls: 'mon-tc', onCommit: (f) => this.seekFrame(f) });
    this.durEl = h('span.mon-dur');
    this.zoomDd = dropdown({ options: ZOOMS.map((z) => ({ label: z, value: z })), value: 'Fit', onChange: (v) => { this.zoom = v; this.pan = [0, 0]; this.resize(); } });
    this.resDd = dropdown({ options: RES.map((r) => ({ label: r.label, value: r.value })), value: 'full', onChange: (v) => this.setRes(v), title: 'Select Playback Resolution' });
    this.bar = h('div.mon-bar', this.tcLeft.el, h('div.mon-bar-mid', this.zoomDd.el), h('div.mon-bar-mid2', this.resDd.el, iconButton('wrench', 'Settings', (e) => this.settingsMenu(e.currentTarget))), this.durEl);
    this.buttons = h('div.mon-buttons');
    this.root.append(this.view, this.bar, this.scrub, this.buttons);
    this.ctx = this.canvas.getContext('2d');
    this.octx = this.overlay.getContext('2d');
    this.sctx = this.scrub.getContext('2d');
    this.scrub.addEventListener('pointerdown', (e) => this.onScrubDown(e));
    this.view.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.seekFrame(this.currentFrame() + (e.deltaY > 0 ? 1 : -1) * (e.shiftKey ? 5 : 1));
    }, { passive: false });
  }

  btn(name, title, fn, cls) {
    const b = iconButton(name, title, fn, cls);
    this.buttons.appendChild(b);
    return b;
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const r = this.view.getBoundingClientRect();
    this.VW = Math.max(10, Math.floor(r.width));
    this.VH = Math.max(10, Math.floor(r.height));
    for (const c of [this.canvas, this.overlay]) {
      c.width = this.VW * dpr;
      c.height = this.VH * dpr;
      c.style.width = this.VW + 'px';
      c.style.height = this.VH + 'px';
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.octx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const sr = this.scrub.getBoundingClientRect();
    this.SW = Math.max(10, Math.floor(sr.width));
    this.scrub.width = this.SW * dpr;
    this.scrub.height = 22 * dpr;
    this.sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.refresh();
  }

  // frame rectangle inside the view for a WxH frame
  frameRect(W, H) {
    let s;
    if (this.zoom === 'Fit') s = Math.min((this.VW - 8) / W, (this.VH - 8) / H);
    else s = parseFloat(this.zoom) / 100;
    const dw = W * s, dh = H * s;
    return { x: (this.VW - dw) / 2 + this.pan[0], y: (this.VH - dh) / 2 + this.pan[1], w: dw, h: dh, s };
  }

  drawScrubBar(frame, total, fps, inP, outP, markers = []) {
    const c = this.sctx, W = this.SW, H = 22;
    c.fillStyle = '#1c1c1c';
    c.fillRect(0, 0, W, H);
    total = Math.max(1, total);
    const x = (f) => 6 + (f / total) * (W - 12);
    if (inP != null || outP != null) {
      const a = x(inP ?? 0), b = x((outP ?? total - 1) + 1);
      c.fillStyle = '#4a4a4a';
      c.fillRect(a, 4, b - a, H - 8);
    }
    c.strokeStyle = '#4b4b4b';
    c.beginPath();
    for (let i = 0; i <= 10; i++) {
      const xx = Math.round(6 + (i / 10) * (W - 12)) + 0.5;
      c.moveTo(xx, H - 6);
      c.lineTo(xx, H - 2);
    }
    c.stroke();
    for (const m of markers) {
      c.fillStyle = '#5bbf5b';
      const xx = x(m);
      c.fillRect(xx - 2, 2, 4, 6);
    }
    const px = Math.round(x(frame)) + 0.5;
    c.fillStyle = '#3b93ff';
    c.beginPath();
    c.moveTo(px - 5, 0);
    c.lineTo(px + 5, 0);
    c.lineTo(px, 7);
    c.closePath();
    c.fill();
    c.fillRect(px - 0.5, 0, 1, H);
  }

  onScrubDown(e) {
    const r = this.scrub.getBoundingClientRect();
    const total = Math.max(1, this.totalFrames());
    const go = (cx) => this.seekFrame(Math.round(clamp((cx - r.left - 6) / (r.width - 12), 0, 1) * total), true);
    go(e.clientX);
    dragPointer(e, { move: (dx, dy, ev) => go(ev.clientX) });
  }

  settingsMenu(anchor) {
    const r = anchor.getBoundingClientRect();
    const tog = (k, label) => ({ label, checked: !!app.prefs[k], action: () => { app.prefs[k] = !app.prefs[k]; app.savePrefs(); this.refresh(); } });
    showMenu(r.left, r.bottom, [tog('safeMargins', 'Safe Margins'), tog('showTransparencyGrid', 'Transparency Grid'), tog('loopPlayback', 'Loop'), { sep: true }, ...this.extraSettings()]);
  }
  extraSettings() {
    return [];
  }
  panelMenu() {
    return [];
  }
  setRes(v) {
    app.prefs[this.id === 'program' ? 'playbackRes' : 'sourceRes'] = v;
    app.savePrefs();
    this.refresh();
  }
  drawSafe(fr) {
    if (!app.prefs.safeMargins) return;
    const c = this.octx;
    c.strokeStyle = 'rgba(255,255,255,0.55)';
    c.lineWidth = 1;
    for (const k of [0.9, 0.8]) {
      const w = fr.w * k, hh = fr.h * k;
      c.strokeRect(Math.round(fr.x + (fr.w - w) / 2) + 0.5, Math.round(fr.y + (fr.h - hh) / 2) + 0.5, Math.round(w), Math.round(hh));
    }
    c.beginPath();
    c.moveTo(fr.x + fr.w / 2 - 10, fr.y + fr.h / 2);
    c.lineTo(fr.x + fr.w / 2 + 10, fr.y + fr.h / 2);
    c.moveTo(fr.x + fr.w / 2, fr.y + fr.h / 2 - 10);
    c.lineTo(fr.x + fr.w / 2, fr.y + fr.h / 2 + 10);
    c.stroke();
  }
}

// ============================ PROGRAM MONITOR ============================
class ProgramMonitor extends MonitorBase {
  constructor() {
    super('program', 'Program');
    this.root.classList.add('program');
    this.btn('marker', 'Add Marker (M)', () => actions.addMarker());
    this.btn('markIn', 'Mark In (I)', () => actions.markIn());
    this.btn('markOut', 'Mark Out (O)', () => actions.markOut());
    this.btn('gotoIn', 'Go to In (Shift+I)', () => actions.gotoIn());
    this.btn('stepBack', 'Step Back 1 Frame (Left)', () => actions.step(-1));
    this.playBtn = this.btn('play', 'Play-Stop Toggle (Space)', () => playback.toggle(), 'play');
    this.btn('stepFwd', 'Step Forward 1 Frame (Right)', () => actions.step(1));
    this.btn('gotoOut', 'Go to Out (Shift+O)', () => actions.gotoOut());
    this.btn('lift', 'Lift (;)', () => actions.lift());
    this.btn('extract', "Extract (')", () => actions.extract());
    this.btn('camera', 'Export Frame (' + MOD + '+Shift+E)', () => this.exportFrame());
    this.loopBtn = this.btn('loop', 'Loop', () => { app.prefs.loopPlayback = !app.prefs.loopPlayback; app.savePrefs(); });
    this.btn('safe', 'Safe Margins', () => { app.prefs.safeMargins = !app.prefs.safeMargins; app.savePrefs(); this.refresh(); });
    this.btn('playInOut', 'Play In to Out (' + MOD + '+Shift+Space)', () => playback.play(1, { inOut: true }));
    this.resDd.set(app.prefs.playbackRes || 'full');
    this.token = 0;
    this.preview = null;
    this.drag = null;
    this.textEditor = null;
    app.bus.on('time:changed', () => this.refresh());
    app.bus.on('project:changed', () => this.refresh());
    app.bus.on('sequence:activated', () => { this.def.tabEl && app.services.layout.refreshTitles(); this.refresh(); });
    app.bus.on('selection:changed', () => this.drawOverlay());
    app.bus.on('media:frame media:updated', () => { if (!playback.playing) this.refreshSoon(); });
    app.bus.on('playback:state', (s) => { this.playBtn.innerHTML = ''; this.playBtn.appendChild(icon(s.playing ? 'pause' : 'play')); this.refresh(); });
    app.bus.on('prefs:changed', () => { this.loopBtn.classList.toggle('on', !!app.prefs.loopPlayback); this.refresh(); });
    app.bus.on('monitor:preview', (p) => { this.preview = p; this.refresh(); });
    app.bus.on('fonts:loaded', () => this.refresh());
    this.overlay.addEventListener('pointerdown', (e) => this.onDown(e));
    this.overlay.addEventListener('pointermove', (e) => this.onHover(e));
    this.overlay.addEventListener('dblclick', (e) => this.onDbl(e));
    this.overlay.addEventListener('contextmenu', (e) => this.onContext(e));
    this.view.addEventListener('dragover', (e) => {
      if ([...e.dataTransfer.types].includes('application/x-videdi-items') && app.seq) {
        e.preventDefault();
        this.view.classList.add('drop');
      }
    });
    this.view.addEventListener('dragleave', () => this.view.classList.remove('drop'));
    this.view.addEventListener('drop', (e) => {
      this.view.classList.remove('drop');
      if (!app.dragItems || !app.seq) return;
      e.preventDefault();
      const s = app.seq;
      actions.placeItems(app.dragItems.items, s.playhead, { vTrack: s.patch.video ?? 0, aTrack: s.patch.audio ?? 0, insert: e.ctrlKey || e.metaKey });
      app.dragItems = null;
    });
  }

  tabTitle() {
    return app.seq ? 'Program: ' + app.seq.name : 'Program: (no sequences)';
  }
  currentFrame() {
    return app.seq ? app.seq.playhead : 0;
  }
  totalFrames() {
    return app.seq ? Math.max(seqDuration(app.seq), 1) : 1;
  }
  seekFrame(f, scrub = false) {
    if (!app.seq) return;
    if (playback.playing) playback.stop();
    app.setPlayhead(f, { source: scrub ? 'scrub' : 'monitor' });
    if (scrub) audio.scrub(app.seq, f / app.seq.settings.fps);
  }

  refreshSoon() {
    clearTimeout(this._soon);
    this._soon = setTimeout(() => this.refresh(), 30);
  }

  resScale(seq, fr) {
    const res = RES.find((r) => r.value === (app.prefs.playbackRes || 'full')) || RES[0];
    const dpr = window.devicePixelRatio || 1;
    const disp = fr.w * dpr / seq.settings.width;
    return clamp(Math.min(res.f, Math.max(disp, 0.1)), 0.05, 1);
  }

  refresh() {
    const seq = app.seq;
    app.services.layout?.refreshTitles();
    if (!this.VW || app.exporting) return;
    const fps = seq ? seq.settings.fps : 30;
    if (!seq) {
      this.ctx.fillStyle = '#0f0f0f';
      this.ctx.fillRect(0, 0, this.VW, this.VH);
      this.octx.clearRect(0, 0, this.VW, this.VH);
      this.tcLeft.set(0, 30);
      this.durEl.textContent = '';
      this.drawScrubBar(0, 1, 30);
      return;
    }
    const frame = this.preview ? this.preview.frame : seq.playhead;
    this.tcLeft.set(seq.playhead, fps);
    const dur = seq.inPoint != null || seq.outPoint != null ? (seq.outPoint ?? seqDuration(seq) - 1) - (seq.inPoint ?? 0) + 1 : seqDuration(seq);
    this.durEl.textContent = framesToTC(Math.max(0, dur), fps);
    this.drawScrubBar(seq.playhead, seqDuration(seq), fps, seq.inPoint, seq.outPoint, seq.markers.map((m) => m.frame));
    const comp = app.services.compositor;
    if (!comp) return;
    if (playback.playing) {
      comp.syncPlayback(seq, frame, playback.rate);
      this.draw(seq, frame);
      return;
    }
    const tok = ++this.token;
    // draw immediately with whatever is available, then again when sources are ready
    comp.prepare(seq, frame).then(() => {
      if (tok !== this.token) return;
      this.draw(seq, frame);
    });
  }

  draw(seq, frame) {
    const comp = app.services.compositor;
    const fr = this.frameRect(seq.settings.width, seq.settings.height);
    const scale = this.resScale(seq, fr);
    const cv = comp.renderFrame(seq, frame, { scale, background: app.prefs.showTransparencyGrid ? 1 : 0 });
    const c = this.ctx;
    c.fillStyle = '#0f0f0f';
    c.fillRect(0, 0, this.VW, this.VH);
    c.imageSmoothingEnabled = true;
    c.imageSmoothingQuality = 'high';
    c.drawImage(cv, fr.x, fr.y, fr.w, fr.h);
    this.fr = fr;
    this.drawOverlay();
    app.bus.emit('program:rendered', { seq, frame });
  }

  // ---------- overlay / direct manipulation ----------
  s2d(p) {
    const seq = app.seq;
    const fr = this.fr;
    return [fr.x + (p[0] / seq.settings.width) * fr.w, fr.y + (p[1] / seq.settings.height) * fr.h];
  }
  d2s(x, y) {
    const seq = app.seq;
    const fr = this.fr;
    return [((x - fr.x) / fr.w) * seq.settings.width, ((y - fr.y) / fr.h) * seq.settings.height];
  }

  // Topmost visible clip under the playhead that is selected (or any if pick=true at point)
  activeClip() {
    const seq = app.seq;
    if (!seq) return null;
    const f = seq.playhead;
    for (let i = seq.videoTracks.length - 1; i >= 0; i--) {
      const t = seq.videoTracks[i];
      const act = activeTrackClips(t, f);
      if (!act) continue;
      for (const c of act.clips) if (app.sel.clips.has(c.id) && c.start <= f && clipEnd(c) > f) return { clip: c, track: t };
    }
    return null;
  }

  clipGeometry(clip) {
    const seq = app.seq;
    const fps = seq.settings.fps;
    const kfT = clipKfTime(clip, seq.playhead, fps);
    const m = motionParams(clip, kfT);
    if (!m) return null;
    const fit = clipFit(app.project, clip, seq);
    const [w, hh] = clipSourceDims(app.project, clip, seq);
    const M = motionMatrix(m, fit);
    const corners = [[0, 0], [w, 0], [w, hh], [0, hh]].map(([x, y]) => applyAff(M, x, y));
    return { m, M, w, h: hh, corners, kfT, fit };
  }

  pickClipAt(sx, sy) {
    const seq = app.seq;
    const f = seq.playhead;
    for (let i = seq.videoTracks.length - 1; i >= 0; i--) {
      const t = seq.videoTracks[i];
      if (t.hidden) continue;
      const act = activeTrackClips(t, f);
      if (!act) continue;
      const c = act.clips.find((x) => x.start <= f && clipEnd(x) > f) || act.clips[0];
      if (!c || !c.enabled) continue;
      const g = this.clipGeometry(c);
      if (!g) continue;
      if (c.graphic) {
        const L = this.layerAt(c, g, sx, sy);
        if (L) return { clip: c, track: t, layer: L };
        continue;
      }
      const inv = invertAffine(g.M);
      const [lx, ly] = applyAff(inv, sx, sy);
      if (lx >= 0 && ly >= 0 && lx <= g.w && ly <= g.h) return { clip: c, track: t };
    }
    return null;
  }

  layerQuads(clip, g) {
    return clip.graphic.layers.map((L) => ({ layer: L, quad: layerQuad(L, g.kfT).map(([x, y]) => applyAff(g.M, x, y)) }));
  }
  layerAt(clip, g, sx, sy) {
    const qs = this.layerQuads(clip, g).reverse();
    for (const { layer, quad } of qs) if (!layer.hidden && pointInQuad(sx, sy, quad)) return layer;
    return null;
  }

  selectedMask() {
    const seq = app.seq;
    if (!seq || !app.sel.maskId) return null;
    for (const id of app.sel.clips) {
      const f = findClip(seq, id);
      if (!f) continue;
      for (const fx of f.clip.effects) {
        const m = (fx.masks || []).find((x) => x.id === app.sel.maskId);
        if (m) return { clip: f.clip, fx, mask: m };
      }
    }
    return null;
  }

  drawOverlay() {
    const c = this.octx;
    if (!this.VW) return;
    c.clearRect(0, 0, this.VW, this.VH);
    const seq = app.seq;
    if (!seq || !this.fr) return;
    this.drawSafe(this.fr);
    if (playback.playing) return;
    const mk = this.selectedMask();
    if (mk && mk.clip.start <= seq.playhead && clipEnd(mk.clip) > seq.playhead) return this.drawMask(mk);
    const act = this.activeClip();
    if (!act) return;
    const g = this.clipGeometry(act.clip);
    if (!g) return;
    if (act.clip.graphic) {
      for (const { layer, quad } of this.layerQuads(act.clip, g)) {
        const sel = app.sel.layerId === layer.id;
        this.drawQuad(quad.map((p) => this.s2d(p)), sel ? '#2d8ceb' : 'rgba(255,255,255,0.35)', sel);
      }
      return;
    }
    const pts = g.corners.map((p) => this.s2d(p));
    this.drawQuad(pts, '#2d8ceb', true);
    // anchor
    const a = this.s2d(g.m.position);
    c.strokeStyle = '#fff';
    c.beginPath();
    c.arc(a[0], a[1], 5, 0, Math.PI * 2);
    c.moveTo(a[0] - 9, a[1]);
    c.lineTo(a[0] + 9, a[1]);
    c.moveTo(a[0], a[1] - 9);
    c.lineTo(a[0], a[1] + 9);
    c.stroke();
  }

  drawQuad(pts, color, handles) {
    const c = this.octx;
    c.strokeStyle = color;
    c.lineWidth = 1;
    c.beginPath();
    pts.forEach((p, i) => (i ? c.lineTo(p[0], p[1]) : c.moveTo(p[0], p[1])));
    c.closePath();
    c.stroke();
    if (!handles) return;
    const hs = this.handlePoints(pts);
    for (const p of hs) {
      c.fillStyle = '#fff';
      c.fillRect(p[0] - 3.5, p[1] - 3.5, 7, 7);
      c.strokeStyle = color;
      c.strokeRect(p[0] - 3.5, p[1] - 3.5, 7, 7);
    }
  }
  handlePoints(pts) {
    const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    return [pts[0], mid(pts[0], pts[1]), pts[1], mid(pts[1], pts[2]), pts[2], mid(pts[2], pts[3]), pts[3], mid(pts[3], pts[0])];
  }

  maskGeometry(mk) {
    const seq = app.seq;
    const fps = seq.settings.fps;
    const kfT = clipKfTime(mk.clip, seq.playhead, fps);
    const g = this.clipGeometry(mk.clip);
    const path = evalParam(mk.mask.path, kfT) || [];
    return { g, kfT, path, disp: path.map(([x, y]) => this.s2d(applyAff(g.M, x, y))) };
  }

  drawMask(mk) {
    const c = this.octx;
    const { disp } = this.maskGeometry(mk);
    if (!disp.length) {
      c.fillStyle = 'rgba(255,255,255,0.8)';
      c.font = '12px sans-serif';
      c.fillText('Pen tool (P): click to add mask points', 12, 22);
      return;
    }
    c.save();
    c.strokeStyle = '#ffd83a';
    c.lineWidth = 1.2;
    tracePath(c, { shape: mk.mask.shape, path: disp, closed: mk.mask.closed, smooth: mk.mask.smooth });
    c.stroke();
    c.restore();
    disp.forEach((p, i) => {
      c.fillStyle = i === 0 ? '#ffd83a' : '#fff';
      c.fillRect(p[0] - 3.5, p[1] - 3.5, 7, 7);
      c.strokeStyle = '#000';
      c.strokeRect(p[0] - 3.5, p[1] - 3.5, 7, 7);
    });
  }

  onHover(e) {
    if (this.drag || !app.seq || !this.fr) return;
    const r = this.overlay.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const hit = this.hitHandles(x, y);
    const map = { move: 'move', scale: 'nwse-resize', rotate: 'alias', vertex: 'pointer', maskMove: 'move' };
    let cur = hit ? map[hit.type] || 'default' : 'default';
    if (app.tool === 'type') cur = 'text';
    if (app.tool === 'pen' || app.tool === 'rect' || app.tool === 'ellipse') cur = 'crosshair';
    if (app.tool === 'hand') cur = 'grab';
    if (app.tool === 'zoom') cur = 'zoom-in';
    this.overlay.style.cursor = cur;
  }

  hitHandles(x, y) {
    const seq = app.seq;
    const mk = this.selectedMask();
    if (mk) {
      const { disp } = this.maskGeometry(mk);
      const vi = disp.findIndex((p) => Math.hypot(p[0] - x, p[1] - y) < 7);
      if (vi >= 0) return { type: 'vertex', mk, index: vi };
      if (disp.length > 2 && pointInPoly(x, y, disp)) return { type: 'maskMove', mk };
      return null;
    }
    const act = this.activeClip();
    if (!act) return null;
    const g = this.clipGeometry(act.clip);
    if (!g) return null;
    if (act.clip.graphic) {
      const s = this.d2s(x, y);
      const L = this.layerAt(act.clip, g, s[0], s[1]);
      return L ? { type: 'move', act, g, layer: L } : null;
    }
    const pts = g.corners.map((p) => this.s2d(p));
    const hs = this.handlePoints(pts);
    const hi = hs.findIndex((p) => Math.abs(p[0] - x) < 6 && Math.abs(p[1] - y) < 6);
    if (hi >= 0) return { type: 'scale', act, g, index: hi };
    if (pointInPoly(x, y, pts)) return { type: 'move', act, g };
    const near = pts.some((p) => Math.hypot(p[0] - x, p[1] - y) < 22);
    if (near) return { type: 'rotate', act, g };
    return null;
  }

  onDown(e) {
    const seq = app.seq;
    if (!seq || !this.fr || e.button !== 0) return;
    app.focusPanel('program');
    if (playback.playing) playback.stop();
    const r = this.overlay.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const s = this.d2s(x, y);
    const tool = app.tool;
    if (tool === 'hand') {
      const p0 = [...this.pan];
      return dragPointer(e, { move: (dx, dy) => { this.pan = [p0[0] + dx, p0[1] + dy]; this.draw(seq, seq.playhead); } });
    }
    if (tool === 'zoom') {
      const cur = this.zoom === 'Fit' ? this.fr.s : parseFloat(this.zoom) / 100;
      const opts = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 4];
      const next = e.altKey ? [...opts].reverse().find((o) => o < cur - 1e-3) : opts.find((o) => o > cur + 1e-3);
      if (next) {
        this.zoom = Math.round(next * 100) + '%';
        this.zoomDd.set(this.zoom);
        this.resize();
      }
      return;
    }
    if (tool === 'type') {
      const c = actions.newTextLayer([s[0], s[1]]);
      if (c) setTimeout(() => this.editText(c.id, c.graphic.layers[c.graphic.layers.length - 1].id), 50);
      return;
    }
    if (tool === 'rect' || tool === 'ellipse') return this.drawShapeDrag(e, s, tool);
    const mk = this.selectedMask();
    if (tool === 'pen' && mk && mk.mask.shape === 'bezier') return this.penAddPoint(mk, s);
    const hit = this.hitHandles(x, y);
    if (hit) return this.startHandleDrag(e, hit, s);
    // pick a clip
    const pick = this.pickClipAt(s[0], s[1]);
    if (pick) {
      const ids = app.linkedSelection ? [pick.clip.id] : [pick.clip.id];
      app.selectClips(ids);
      if (pick.layer) {
        app.sel.layerId = pick.layer.id;
        app.bus.emit('selection:changed');
      }
      const hit2 = this.hitHandles(x, y);
      if (hit2) this.startHandleDrag(e, hit2, s);
    } else {
      app.clearSelection();
    }
  }

  liveParam(label) {
    let begun = false;
    return {
      set: (fn) => {
        if (!begun) {
          app.history.begin(label);
          begun = true;
        }
        fn();
        app.bus.emit('project:changed', { live: true });
      },
      end: () => {
        if (begun) {
          app.history.commit();
          app.bus.emit('project:changed', { label });
        }
      },
    };
  }

  startHandleDrag(e, hit, s0) {
    const seq = app.seq;
    const fps = seq.settings.fps;
    if (hit.type === 'vertex' || hit.type === 'maskMove') return this.dragMask(e, hit);
    const clip = hit.act.clip;
    const clipId = clip.id;
    const g = hit.g;
    const kfT = g.kfT;
    const getClip = () => findClip(seq, clipId)?.clip;
    if (hit.layer) {
      const lid = hit.layer.id;
      app.sel.layerId = lid;
      app.bus.emit('selection:changed');
      const tr0 = layerTransform(hit.layer, kfT);
      const inv = invertAffine(g.M);
      const live = this.liveParam('Move Layer');
      return dragPointer(e, {
        cursor: 'move',
        move: (dx, dy, ev) => {
          const r = this.overlay.getBoundingClientRect();
          const s = this.d2s(ev.clientX - r.left, ev.clientY - r.top);
          const a = applyAff(inv, s0[0], s0[1]), b = applyAff(inv, s[0], s[1]);
          live.set(() => {
            const L = getClip().graphic.layers.find((l) => l.id === lid);
            let nx = tr0.position[0] + b[0] - a[0], ny = tr0.position[1] + b[1] - a[1];
            if (ev.shiftKey) {
              if (Math.abs(b[0] - a[0]) > Math.abs(b[1] - a[1])) ny = tr0.position[1];
              else nx = tr0.position[0];
            }
            setParamValue(L.position, kfT, [Math.round(nx * 10) / 10, Math.round(ny * 10) / 10]);
          });
        },
        up: () => live.end(),
      });
    }
    const m0 = g.m;
    const live = this.liveParam(hit.type === 'move' ? 'Position' : hit.type === 'scale' ? 'Scale' : 'Rotation');
    const motionFx = () => getClip().effects.find((f) => f.type === 'motion');
    const center = m0.position;
    dragPointer(e, {
      cursor: hit.type === 'move' ? 'move' : hit.type === 'rotate' ? 'alias' : 'nwse-resize',
      move: (dx, dy, ev) => {
        const r = this.overlay.getBoundingClientRect();
        const s = this.d2s(ev.clientX - r.left, ev.clientY - r.top);
        live.set(() => {
          const fx = motionFx();
          if (hit.type === 'move') {
            let nx = m0.position[0] + s[0] - s0[0], ny = m0.position[1] + s[1] - s0[1];
            if (ev.shiftKey) {
              if (Math.abs(s[0] - s0[0]) > Math.abs(s[1] - s0[1])) ny = m0.position[1];
              else nx = m0.position[0];
            }
            setParamValue(fx.params.position, kfT, [Math.round(nx * 10) / 10, Math.round(ny * 10) / 10]);
          } else if (hit.type === 'rotate') {
            const a0 = Math.atan2(s0[1] - center[1], s0[0] - center[0]);
            const a1 = Math.atan2(s[1] - center[1], s[0] - center[0]);
            let deg = m0.rotation + ((a1 - a0) * 180) / Math.PI;
            if (ev.shiftKey) deg = Math.round(deg / 15) * 15;
            setParamValue(fx.params.rotation, kfT, Math.round(deg * 10) / 10);
          } else {
            const d0 = Math.hypot(s0[0] - center[0], s0[1] - center[1]) || 1;
            const d1 = Math.hypot(s[0] - center[0], s[1] - center[1]);
            const k = d1 / d0;
            const isMid = hit.index % 2 === 1;
            if (m0.uniformScale || !isMid) setParamValue(fx.params.scale, kfT, Math.max(0, Math.round(m0.scale * k * 10) / 10));
            else {
              const horizontal = hit.index === 3 || hit.index === 7;
              if (horizontal) setParamValue(fx.params.scaleWidth, kfT, Math.max(0, Math.round(m0.scaleWidth * k * 10) / 10));
              else setParamValue(fx.params.scale, kfT, Math.max(0, Math.round(m0.scale * k * 10) / 10));
            }
          }
        });
      },
      up: () => live.end(),
    });
  }

  dragMask(e, hit) {
    const seq = app.seq;
    const mk = hit.mk;
    const { g, kfT, path } = this.maskGeometry(mk);
    const inv = invertAffine(g.M);
    const r = this.overlay.getBoundingClientRect();
    const s0 = applyAff(inv, ...this.d2s(e.clientX - r.left, e.clientY - r.top));
    const p0 = JSON.parse(JSON.stringify(path));
    const clipId = mk.clip.id, maskId = mk.mask.id;
    const live = this.liveParam('Mask Path');
    dragPointer(e, {
      move: (dx, dy, ev) => {
        const s = applyAff(inv, ...this.d2s(ev.clientX - r.left, ev.clientY - r.top));
        const ddx = s[0] - s0[0], ddy = s[1] - s0[1];
        live.set(() => {
          const c = findClip(seq, clipId).clip;
          const m = c.effects.flatMap((f) => f.masks || []).find((x) => x.id === maskId);
          const np = p0.map((p, i) => (hit.type === 'maskMove' || i === hit.index ? [p[0] + ddx, p[1] + ddy] : p.slice()));
          if (hit.type === 'vertex' && m.shape === 'rect' && p0.length === 4) {
            // keep rectangle: move adjacent corners
            const i = hit.index;
            const prev = (i + 3) % 4, next = (i + 1) % 4;
            if (i % 2 === 0) {
              np[prev] = [i === 0 ? np[i][0] : p0[prev][0], i === 0 ? p0[prev][1] : np[i][1]];
              np[next] = [i === 0 ? p0[next][0] : np[i][0], i === 0 ? np[i][1] : p0[next][1]];
            } else {
              np[prev] = [i === 1 ? p0[prev][0] : np[i][0], i === 1 ? np[i][1] : p0[prev][1]];
              np[next] = [i === 1 ? np[i][0] : p0[next][0], i === 1 ? p0[next][1] : np[i][1]];
            }
          }
          setParamValue(m.path, kfT, np);
        });
      },
      up: () => live.end(),
    });
  }

  penAddPoint(mk, s) {
    const seq = app.seq;
    const { g, kfT, path } = this.maskGeometry(mk);
    const inv = invertAffine(g.M);
    const p = applyAff(inv, s[0], s[1]);
    const disp0 = path.length ? this.s2d(applyAff(g.M, path[0][0], path[0][1])) : null;
    const dispNew = this.s2d(s);
    app.edit('Mask Point', () => {
      const c = findClip(seq, mk.clip.id).clip;
      const m = c.effects.flatMap((f) => f.masks || []).find((x) => x.id === mk.mask.id);
      if (disp0 && path.length > 2 && Math.hypot(disp0[0] - dispNew[0], disp0[1] - dispNew[1]) < 8) {
        m.closed = true;
        return;
      }
      setParamValue(m.path, kfT, [...path, [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10]]);
      m.closed = false;
    });
  }

  drawShapeDrag(e, s0, tool) {
    const r = this.overlay.getBoundingClientRect();
    let s1 = s0;
    dragPointer(e, {
      move: (dx, dy, ev) => {
        s1 = this.d2s(ev.clientX - r.left, ev.clientY - r.top);
        this.drawOverlay();
        const a = this.s2d(s0), b = this.s2d(s1);
        const c = this.octx;
        c.strokeStyle = '#2d8ceb';
        c.beginPath();
        if (tool === 'ellipse') c.ellipse((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, Math.abs(b[0] - a[0]) / 2, Math.abs(b[1] - a[1]) / 2, 0, 0, Math.PI * 2);
        else c.rect(a[0], a[1], b[0] - a[0], b[1] - a[1]);
        c.stroke();
      },
      up: () => {
        const w = Math.abs(s1[0] - s0[0]), hh = Math.abs(s1[1] - s0[1]);
        if (w < 4 || hh < 4) return this.drawOverlay();
        actions.newShapeLayer(tool, { x: Math.min(s0[0], s1[0]), y: Math.min(s0[1], s1[1]), w, h: hh });
      },
    });
  }

  onDbl(e) {
    const seq = app.seq;
    if (!seq || !this.fr) return;
    const r = this.overlay.getBoundingClientRect();
    const s = this.d2s(e.clientX - r.left, e.clientY - r.top);
    const pick = this.pickClipAt(s[0], s[1]);
    if (pick && pick.layer && pick.layer.type === 'text') this.editText(pick.clip.id, pick.layer.id);
  }

  editText(clipId, layerId) {
    const seq = app.seq;
    const f = findClip(seq, clipId);
    if (!f || !this.fr) return;
    const clip = f.clip;
    const layer = clip.graphic.layers.find((l) => l.id === layerId);
    if (!layer || layer.type !== 'text') return;
    if (this.textEditor) this.textEditor.remove();
    const g = this.clipGeometry(clip);
    const quad = layerQuad(layer, g.kfT).map(([x, y]) => this.s2d(applyAff(g.M, x, y)));
    const xs = quad.map((p) => p[0]), ys = quad.map((p) => p[1]);
    const scale = this.fr.w / seq.settings.width;
    const tr = layerTransform(layer, g.kfT);
    const ta = h('textarea.mon-textedit', { spellcheck: false });
    ta.value = layer.text;
    Object.assign(ta.style, {
      left: Math.min(...xs) - 4 + 'px',
      top: Math.min(...ys) - 4 + 'px',
      minWidth: Math.max(80, Math.max(...xs) - Math.min(...xs) + 40) + 'px',
      minHeight: Math.max(...ys) - Math.min(...ys) + 8 + 'px',
      font: fontString(layer, scale * (tr.scale / 100) * (g.m.scale / 100)),
      textAlign: layer.align,
      color: layer.fill.color,
    });
    this.view.appendChild(ta);
    this.textEditor = ta;
    ta.focus();
    ta.select();
    let begun = false;
    ta.addEventListener('input', () => {
      if (!begun) {
        app.history.begin('Edit Text');
        begun = true;
      }
      const L = findClip(seq, clipId)?.clip.graphic.layers.find((l) => l.id === layerId);
      if (L) {
        L.text = ta.value;
        L.name = ta.value.split('\n')[0].slice(0, 24) || 'Text';
      }
      const c2 = findClip(seq, clipId)?.clip;
      if (c2 && c2.graphic.layers.length === 1) c2.name = ta.value.split('\n')[0].slice(0, 30) || 'Graphic';
      app.bus.emit('project:changed', { live: true });
    });
    const finish = () => {
      if (begun) {
        app.history.commit();
        app.changed();
      }
      ta.remove();
      this.textEditor = null;
    };
    ta.addEventListener('blur', finish);
    ta.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Escape') ta.blur();
    });
  }

  onContext(e) {
    e.preventDefault();
    const seq = app.seq;
    showMenu(e.clientX, e.clientY, [
      { label: 'Playback Resolution', submenu: RES.map((r) => ({ label: r.label, checked: app.prefs.playbackRes === r.value, action: () => { this.resDd.set(r.value); this.setRes(r.value); } })) },
      { label: 'Zoom', submenu: ZOOMS.map((z) => ({ label: z, checked: this.zoom === z, action: () => { this.zoom = z; this.pan = [0, 0]; this.zoomDd.set(z); this.resize(); } })) },
      { sep: true },
      { label: 'Safe Margins', checked: !!app.prefs.safeMargins, action: () => { app.prefs.safeMargins = !app.prefs.safeMargins; app.savePrefs(); } },
      { label: 'Transparency Grid', checked: !!app.prefs.showTransparencyGrid, action: () => { app.prefs.showTransparencyGrid = !app.prefs.showTransparencyGrid; app.savePrefs(); } },
      { sep: true },
      { label: 'Export Frame…', disabled: !seq, action: () => this.exportFrame() },
    ]);
  }

  extraSettings() {
    return [{ label: 'Export Frame…', action: () => this.exportFrame() }];
  }
  panelMenu() {
    return [{ label: 'Export Frame…', action: () => this.exportFrame() }, { label: 'Safe Margins', checked: !!app.prefs.safeMargins, action: () => { app.prefs.safeMargins = !app.prefs.safeMargins; app.savePrefs(); } }];
  }

  async exportFrame() {
    const seq = app.seq;
    if (!seq) return;
    const comp = app.services.compositor;
    await comp.prepare(seq, seq.playhead);
    const cv = comp.renderFrame(seq, seq.playhead, { scale: 1, background: 0, scopes: false });
    const blob = await new Promise((r) => cv.toBlob(r, 'image/png'));
    downloadBlob(blob, `${seq.name} ${framesToTC(seq.playhead, seq.settings.fps).replace(/[:;]/g, '-')}.png`);
    this.refresh();
    app.toast('Frame exported', 'ok');
  }
}

function pointInPoly(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const pointInQuad = (x, y, q) => pointInPoly(x, y, q);

// ============================ SOURCE MONITOR ============================
class SourceMonitor extends MonitorBase {
  constructor() {
    super('source', 'Source');
    this.root.classList.add('source');
    this.media = null;
    this.mediaWrap = h('div.src-media');
    this.view.insertBefore(this.mediaWrap, this.canvas);
    this.empty = h('div.mon-empty', 'Double-click a clip in the Project panel to open it here.');
    this.view.appendChild(this.empty);
    this.btn('marker', 'Add Marker (M)', () => this.addMarker());
    this.btn('markIn', 'Mark In (I)', () => this.markIn());
    this.btn('markOut', 'Mark Out (O)', () => this.markOut());
    this.btn('gotoIn', 'Go to In (Shift+I)', () => this.gotoIn());
    this.btn('stepBack', 'Step Back 1 Frame (Left)', () => this.step(-1));
    this.playBtn = this.btn('play', 'Play-Stop Toggle (Space)', () => this.toggle(), 'play');
    this.btn('stepFwd', 'Step Forward 1 Frame (Right)', () => this.step(1));
    this.btn('gotoOut', 'Go to Out (Shift+O)', () => this.gotoOut());
    this.btn('insert', 'Insert (,)', () => actions.sourceEdit('insert'));
    this.btn('overwrite', 'Overwrite (.)', () => actions.sourceEdit('overwrite'));
    this.btn('camera', 'Export Frame', () => this.exportFrame());
    // drag icons
    this.dragV = h('span.src-drag', { draggable: true, title: 'Drag Video Only' }, icon('film'));
    this.dragA = h('span.src-drag', { draggable: true, title: 'Drag Audio Only' }, icon('audioFile'));
    this.bar.insertBefore(h('div.src-drags', this.dragV, this.dragA), this.durEl);
    for (const [el, v, a] of [[this.dragV, true, false], [this.dragA, false, true], [this.view, true, true]]) {
      el.setAttribute('draggable', 'true');
      el.addEventListener('dragstart', (e) => {
        const item = this.item;
        if (!item) return e.preventDefault();
        const fps = app.seq ? app.seq.settings.fps : item.fps || 30;
        const range = this.markRange(fps);
        app.dragItems = { items: [item], video: v, audio: a, srcRange: range };
        e.dataTransfer.setData('application/x-videdi-items', JSON.stringify([item.id]));
        e.dataTransfer.effectAllowed = 'copy';
      });
    }
    this.resDd.set(app.prefs.sourceRes || 'full');
    app.bus.on('source:changed', (opts) => this.load(opts && opts.time));
    app.bus.on('project:changed', () => this.refresh());
    app.bus.on('media:updated', () => this.refresh());
  }

  get item() {
    return app.sourceItemId ? findItem(app.project, app.sourceItemId) : null;
  }
  get fps() {
    const it = this.item;
    if (!it) return 30;
    if (it.type === 'sequence') return it.settings.fps;
    return it.fps || (app.seq ? app.seq.settings.fps : 30);
  }
  tabTitle() {
    const it = this.item;
    return it ? 'Source: ' + it.name : 'Source: (no clips)';
  }
  get time() {
    return this.item ? app.rt(this.item.id).srcTime || 0 : 0;
  }
  set time(t) {
    if (this.item) app.rt(this.item.id).srcTime = t;
  }
  duration() {
    const it = this.item;
    if (!it) return 0;
    const d = itemSourceDuration(app.project, it);
    return isFinite(d) ? d : app.prefs.stillDuration;
  }
  currentFrame() {
    return Math.round(this.time * this.fps);
  }
  totalFrames() {
    return Math.max(1, Math.round(this.duration() * this.fps));
  }

  load(time) {
    this.stop();
    const it = this.item;
    this.mediaWrap.innerHTML = '';
    this.media = null;
    app.services.layout?.refreshTitles();
    this.empty.style.display = it ? 'none' : 'flex';
    if (!it) return this.refresh();
    const rt = app.rt(it.id);
    if (it.type === 'media' && rt.url) {
      if (it.kind === 'video') {
        const v = h('video', { playsInline: true, preload: 'auto' });
        v.src = rt.url;
        v.addEventListener('loadeddata', () => this.refresh());
        v.addEventListener('seeked', () => this.refresh());
        v.addEventListener('timeupdate', () => {
          if (!v.paused) {
            this.time = v.currentTime;
            this.refreshBar();
          }
        });
        v.addEventListener('ended', () => this.stop());
        this.media = v;
      } else if (it.kind === 'audio') {
        const a = h('audio', { preload: 'auto' });
        a.src = rt.url;
        a.addEventListener('timeupdate', () => {
          if (!a.paused) {
            this.time = a.currentTime;
            this.refreshBar();
          }
        });
        a.addEventListener('ended', () => this.stop());
        this.media = a;
      } else if (it.kind === 'image') {
        this.media = h('img', { src: rt.url });
      }
      if (this.media) {
        this.mediaWrap.appendChild(this.media);
        if (this.media.tagName !== 'IMG') {
          try {
            if (!this.media._routed && audio.ensure()) {
              const src = audio.ctx.createMediaElementSource(this.media);
              src.connect(audio.master);
              this.media._routed = true;
            }
          } catch (e) {
            /* already routed */
          }
        }
      }
    }
    if (time != null) this.time = time;
    else if (rt.srcTime == null) this.time = it.inPoint ?? 0;
    this.seekMedia();
    this.resize();
  }

  seekMedia() {
    const m = this.media;
    if (m && (m.tagName === 'VIDEO' || m.tagName === 'AUDIO')) {
      const t = this.time + 0.0001;
      if (Math.abs(m.currentTime - t) > 0.001) m.currentTime = t;
    }
  }

  seekFrame(f, scrub = false) {
    if (!this.item) return;
    this.pause();
    const fps = this.fps;
    this.time = clamp(f / fps, 0, Math.max(0, this.duration() - 1 / fps));
    this.seekMedia();
    this.refresh();
  }
  step(n) {
    this.seekFrame(this.currentFrame() + n);
  }

  playing() {
    return this.media && (this.media.tagName === 'VIDEO' || this.media.tagName === 'AUDIO') && !this.media.paused;
  }
  toggle() {
    if (this.playing()) this.pause();
    else this.play(1);
  }
  play(rate = 1) {
    const m = this.media;
    if (!m || m.tagName === 'IMG') return;
    if (rate < 0) {
      // reverse playback via timer
      this.pause();
      const fps = this.fps;
      this._rev = setInterval(() => {
        const f = this.currentFrame() - Math.max(1, Math.round(-rate));
        if (f <= 0) return this.pause();
        this.time = f / fps;
        this.seekMedia();
        this.refreshBar();
      }, 1000 / fps);
      return;
    }
    audio.ensure();
    if (this.time >= this.duration() - 0.05) {
      this.time = 0;
      this.seekMedia();
    }
    m.playbackRate = rate;
    m.play().catch(() => {});
    this.playBtn.innerHTML = '';
    this.playBtn.appendChild(icon('pause'));
    const tick = () => {
      if (!this.playing()) return;
      this.time = m.currentTime;
      const outP = this.item?.outPoint;
      if (outP != null && this._playInOut && this.time >= outP) return this.pause();
      this.refreshBar();
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }
  shuttle(dir) {
    if (dir > 0) {
      const r = this.playing() && this.media.playbackRate >= 1 ? Math.min(8, this.media.playbackRate * 2) : 1;
      this.play(r);
    } else this.play(-1);
  }
  pause() {
    clearInterval(this._rev);
    this._rev = null;
    if (this.media && this.media.pause) this.media.pause();
    cancelAnimationFrame(this.raf);
    this.playBtn.innerHTML = '';
    this.playBtn.appendChild(icon('play'));
    this.refresh();
  }
  stop() {
    this.pause();
  }

  markRange(fps) {
    const it = this.item;
    if (!it) return null;
    const range = { in: it.inPoint ?? 0 };
    const end = it.outPoint ?? (isFinite(itemSourceDuration(app.project, it)) ? itemSourceDuration(app.project, it) : range.in + app.prefs.stillDuration);
    range.dur = Math.max(1, Math.round((end - range.in) * fps));
    return range;
  }
  markIn() {
    const it = this.item;
    if (!it) return;
    const t = this.time;
    app.edit('Mark In', () => {
      it.inPoint = t;
      if (it.outPoint != null && it.outPoint <= t) it.outPoint = null;
    });
  }
  markOut() {
    const it = this.item;
    if (!it) return;
    const t = Math.min(this.duration(), this.time + 1 / this.fps);
    app.edit('Mark Out', () => {
      it.outPoint = t;
      if (it.inPoint != null && it.inPoint >= t) it.inPoint = null;
    });
  }
  clearInOut() {
    const it = this.item;
    if (it) app.edit('Clear In and Out', () => { it.inPoint = null; it.outPoint = null; });
  }
  gotoIn() {
    const it = this.item;
    if (it && it.inPoint != null) this.seekFrame(Math.round(it.inPoint * this.fps));
  }
  gotoOut() {
    const it = this.item;
    if (it && it.outPoint != null) this.seekFrame(Math.round(it.outPoint * this.fps) - 1);
  }
  addMarker() {
    const it = this.item;
    if (!it) return;
    app.edit('Add Marker', () => (it.markers = [...(it.markers || []), { id: 'mk' + Date.now(), time: this.time, name: '', comment: '', color: 'Green' }]));
  }

  refreshBar() {
    const it = this.item;
    const fps = this.fps;
    this.tcLeft.set(this.currentFrame(), fps);
    if (!it) {
      this.durEl.textContent = '';
      this.drawScrubBar(0, 1, fps);
      return;
    }
    const total = this.totalFrames();
    const inF = it.inPoint != null ? Math.round(it.inPoint * fps) : null;
    const outF = it.outPoint != null ? Math.round(it.outPoint * fps) - 1 : null;
    const dur = (outF ?? total - 1) - (inF ?? 0) + 1;
    this.durEl.textContent = framesToTC(dur, fps);
    this.drawScrubBar(this.currentFrame(), total, fps, inF, outF, (it.markers || []).map((m) => Math.round(m.time * fps)));
    this.drawSourceView(true);
  }

  refresh() {
    if (!this.VW) return;
    this.refreshBar();
    this.drawSourceView();
  }

  drawSourceView(light = false) {
    const it = this.item;
    const c = this.ctx;
    c.clearRect(0, 0, this.VW, this.VH);
    this.octx.clearRect(0, 0, this.VW, this.VH);
    if (!it) return;
    let W = 1920, H = 1080;
    if (it.type === 'media' && it.kind !== 'audio') {
      W = it.width;
      H = it.height;
    } else if (it.type === 'sequence') {
      W = it.settings.width;
      H = it.settings.height;
    } else if (it.type === 'synthetic') {
      W = it.width;
      H = it.height;
    }
    const fr = this.frameRect(W, H);
    if (this.media && this.media.tagName !== 'AUDIO') {
      Object.assign(this.media.style, { position: 'absolute', left: fr.x + 'px', top: fr.y + 'px', width: fr.w + 'px', height: fr.h + 'px' });
      this.media.style.display = '';
    }
    if (it.type === 'media' && it.kind === 'audio') this.drawAudioWave(it);
    else if (it.type === 'synthetic' || it.type === 'sequence') {
      if (!light) this.drawSynthetic(it, fr);
    } else if (it.offline || (it.type === 'media' && !app.rt(it.id).url)) {
      c.fillStyle = '#c4141a';
      c.fillRect(fr.x, fr.y, fr.w, fr.h);
      c.fillStyle = '#fff';
      c.font = 'bold 16px sans-serif';
      c.textAlign = 'center';
      c.fillText('Media offline', fr.x + fr.w / 2, fr.y + fr.h / 2);
      c.textAlign = 'left';
    }
    this.drawSafe(fr);
  }

  drawSynthetic(it, fr) {
    const c = this.ctx;
    if (it.type === 'sequence') {
      const comp = app.services.compositor;
      const f = Math.round(this.time * it.settings.fps);
      comp.prepare(it, f).then(() => {
        const cv = comp.renderFrame(it, f, { scale: Math.min(1, fr.w / it.settings.width), scopes: false });
        this.ctx.drawImage(cv, fr.x, fr.y, fr.w, fr.h);
      });
      return;
    }
    if (it.kind === 'colormatte') c.fillStyle = it.color;
    else if (it.kind === 'black') c.fillStyle = '#000';
    else if (it.kind === 'transparent' || it.kind === 'adjustment') {
      c.fillStyle = '#555';
      c.fillRect(fr.x, fr.y, fr.w, fr.h);
      c.fillStyle = '#777';
      const cs = 12;
      for (let y = 0; y < fr.h; y += cs) for (let x = (Math.floor(y / cs) % 2) * cs; x < fr.w; x += cs * 2) c.fillRect(fr.x + x, fr.y + y, cs, cs);
      return;
    } else {
      // bars / leader
      const comp = app.services.compositor;
      const tmp = { settings: { width: it.width, height: it.height, fps: it.fps || 30 }, videoTracks: [{ clips: [{ id: 'src_' + it.id, itemId: it.id, kind: 'video', start: 0, dur: 1e7, in: 0, speed: 1, enabled: true, effects: [] }], transitions: [], hidden: false }], audioTracks: [], captions: [] };
      const f = Math.round(this.time * (it.fps || 30));
      const cv = comp.renderFrame(tmp, f, { scale: Math.min(1, fr.w / it.width), scopes: false, captions: false });
      c.drawImage(cv, fr.x, fr.y, fr.w, fr.h);
      return;
    }
    c.fillRect(fr.x, fr.y, fr.w, fr.h);
  }

  drawAudioWave(it) {
    const c = this.ctx;
    const pk = app.rt(it.id).peaks;
    const W = this.VW, H = this.VH;
    c.fillStyle = '#151515';
    c.fillRect(0, 0, W, H);
    if (!pk) return;
    const chs = pk.peaks.length;
    const dur = it.duration || 1;
    const laneH = H / chs;
    c.fillStyle = '#2fb67a';
    for (let ch = 0; ch < chs; ch++) {
      const arr = pk.peaks[ch];
      const mid = laneH * ch + laneH / 2;
      for (let x = 0; x < W; x++) {
        const i0 = Math.floor((x / W) * dur * pk.rate), i1 = Math.ceil(((x + 1) / W) * dur * pk.rate);
        let m = 0;
        for (let i = i0; i < i1 && i < arr.length; i++) if (arr[i] > m) m = arr[i];
        const v = m * (laneH / 2) * 0.9;
        c.fillRect(x, mid - v, 1, v * 2);
      }
      c.fillStyle = '#2a2a2a';
      c.fillRect(0, laneH * (ch + 1) - 1, W, 1);
      c.fillStyle = '#2fb67a';
    }
    const it2 = this.item;
    if (it2.inPoint != null || it2.outPoint != null) {
      c.fillStyle = 'rgba(255,255,255,0.08)';
      const a = ((it2.inPoint ?? 0) / dur) * W, b = ((it2.outPoint ?? dur) / dur) * W;
      c.fillRect(a, 0, b - a, H);
    }
    const px = (this.time / dur) * W;
    c.fillStyle = '#3b93ff';
    c.fillRect(px, 0, 1, H);
  }

  async exportFrame() {
    const it = this.item;
    if (!it || !this.media || this.media.tagName !== 'VIDEO') return;
    const cv = document.createElement('canvas');
    cv.width = it.width;
    cv.height = it.height;
    cv.getContext('2d').drawImage(this.media, 0, 0);
    const blob = await new Promise((r) => cv.toBlob(r, 'image/png'));
    downloadBlob(blob, it.name.replace(/\.[^.]+$/, '') + ' frame.png');
  }

  panelMenu() {
    return [
      { label: 'Clear In and Out', action: () => this.clearInOut() },
      { label: 'Close', action: () => { app.sourceItemId = null; this.load(); } },
    ];
  }
}

export const programMonitor = new ProgramMonitor();
export const sourceMonitor = new SourceMonitor();
