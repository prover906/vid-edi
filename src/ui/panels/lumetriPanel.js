// Lumetri Color panel and Lumetri Scopes panel.

import { app } from '../../core/app.js';
import { h, clamp, dragPointer, deepClone, hslToRgb, rgbToHex } from '../../core/util.js';
import { findClip, findItem, clipKfTime, clipEnd, createEffect, defaultParamValue } from '../../core/model.js';
import { evalParam, setParamValue } from '../../core/keyframes.js';
import { getEffectDef } from '../../core/registry.js';
import { registerPanel } from '../layout.js';
import { icon } from '../icons.js';
import { hotText, dropdown, checkbox, iconButton } from '../widgets.js';
import { LOOKS, evalCurve, wheelToRgb } from '../../engine/lumetri.js';

const SECTIONS = [
  ['basicOn', 'Basic Correction'],
  ['creativeOn', 'Creative'],
  ['curvesOn', 'Curves'],
  ['wheelsOn', 'Color Wheels & Match'],
  ['hslOn', 'HSL Secondary'],
  ['vigOn', 'Vignette'],
];

class LumetriPanel {
  constructor() {
    this.def = registerPanel({ id: 'lumetri', title: 'Lumetri Color', onShow: () => this.render() });
    this.root = this.def.el;
    this.root.classList.add('lu-root');
    this.open = new Set(['basicOn']);
    this.curveCh = 'master';
    this.hueCurve = 'hueSat';
    this.head = h('div.lu-head');
    this.body = h('div.lu-body');
    this.root.append(this.head, this.body);
    app.bus.on('selection:changed sequence:activated', () => this.render());
    app.bus.on('project:changed', (e) => (e && e.live ? this.refreshValues() : this.render()));
    app.bus.on('time:changed', () => {
      // With nothing selected the panel follows the playhead (Premiere behavior).
      const c = this.target();
      if ((c && c.id) !== this.lastTarget) this.render();
      else this.refreshValues();
    });
  }

  target() {
    const seq = app.seq;
    if (!seq) return null;
    for (const id of app.sel.clips) {
      const f = findClip(seq, id);
      if (f && f.kind === 'video') return f.clip;
    }
    // Fallback: the topmost enabled video clip under the playhead.
    const f = seq.playhead;
    for (let i = seq.videoTracks.length - 1; i >= 0; i--) {
      const t = seq.videoTracks[i];
      if (t.hidden) continue;
      const c = t.clips.find((c) => c.enabled !== false && f >= c.start && f < clipEnd(c));
      if (c) return c;
    }
    return null;
  }

  fx(clip) {
    if (!clip) return null;
    const sel = clip.effects.find((e) => e.id === app.sel.effectId && e.type === 'lumetri');
    return sel || clip.effects.find((e) => e.type === 'lumetri') || null;
  }

  kfT(clip) {
    const seq = app.seq;
    return clipKfTime(clip, clamp(seq.playhead, clip.start, clipEnd(clip) - 1), seq.settings.fps);
  }

  value(pid) {
    const clip = this.target();
    const fx = this.fx(clip);
    const pd = getEffectDef('lumetri').params.find((p) => p.id === pid);
    if (!fx) return typeof pd.default === 'function' ? pd.default({}) : deepClone(pd.default);
    return evalParam(fx.params[pid], this.kfT(clip), pd);
  }

  // Ensure the clip has a Lumetri effect (adds inside current history step)
  ensureFx() {
    const clip = this.target();
    if (!clip) return null;
    let fx = this.fx(clip);
    if (!fx) {
      const seq = app.seq;
      const item = clip.itemId ? findItem(app.project, clip.itemId) : null;
      fx = createEffect('lumetri', { w: item?.width || seq.settings.width, h: item?.height || seq.settings.height, seqW: seq.settings.width, seqH: seq.settings.height });
      clip.effects.push(fx);
    }
    return fx;
  }

  setter(pid, label) {
    let begun = false;
    return {
      start: () => {
        if (!begun) {
          app.history.begin('Lumetri ' + label);
          begun = true;
        }
      },
      input: (v) => {
        if (!begun) {
          app.history.begin('Lumetri ' + label);
          begun = true;
        }
        const clip = this.target();
        const fx = this.ensureFx();
        if (!fx) return;
        setParamValue(fx.params[pid], this.kfT(clip), v);
        app.bus.emit('project:changed', { live: true });
      },
      end: () => {
        if (begun) {
          begun = false;
          app.history.commit();
          app.bus.emit('project:changed', { label });
        }
      },
      set: (v) => {
        app.edit('Lumetri ' + label, () => {
          const clip = this.target();
          const fx = this.ensureFx();
          if (fx) setParamValue(fx.params[pid], this.kfT(clip), v);
        });
      },
    };
  }

  render() {
    if (!this.root.isConnected) return;
    this.head.innerHTML = '';
    this.body.innerHTML = '';
    this.updaters = [];
    const clip = this.target();
    this.lastTarget = clip && clip.id;
    if (!clip) {
      this.body.appendChild(h('div.ec-empty', 'Select a video clip in the Timeline, or move the playhead over one, to color correct it.'));
      return;
    }
    const fx = this.fx(clip);
    this.head.append(h('span.lu-clip', clip.name), h('span.muted.tiny', fx ? ' · ' + (fx.label || 'Lumetri Color') : ' · (adjusting a control adds Lumetri Color)'));
    for (const [pid, title] of SECTIONS) this.section(pid, title);
  }

  section(pid, title) {
    const open = this.open.has(pid);
    const on = !!this.value(pid);
    const cb = checkbox({ checked: on, onChange: (v) => this.setter(pid, title).set(v) });
    const hdr = h('div.lu-sec', h('span.tw', icon(open ? 'chevDown' : 'chevRight')), cb.el, h('span.lu-sectitle', title));
    hdr.addEventListener('click', (e) => {
      if (e.target.tagName === 'INPUT') return;
      if (open) this.open.delete(pid);
      else this.open.add(pid);
      this.render();
    });
    this.body.appendChild(hdr);
    if (!open) return;
    const box = h('div.lu-secbody');
    this.body.appendChild(box);
    const S = (id, label, min, max, opts = {}) => box.appendChild(this.slider(id, label, min, max, opts));
    switch (pid) {
      case 'basicOn': {
        box.appendChild(this.lutRow());
        box.appendChild(h('div.lu-sub', 'White Balance'));
        S('temp', 'Temperature', -100, 100, { grad: 'linear-gradient(90deg,#3a7bd5,#d8d8d8,#e8b33c)' });
        S('tint', 'Tint', -100, 100, { grad: 'linear-gradient(90deg,#3ab55a,#d8d8d8,#c93fc9)' });
        box.appendChild(h('div.lu-sub', 'Tone', h('span.spacer'), h('button.btn.sm', { onclick: () => this.autoTone() }, 'Auto'), h('button.btn.sm', { onclick: () => this.resetGroup(['temp', 'tint', 'exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks', 'saturation']) }, 'Reset')));
        S('exposure', 'Exposure', -5, 5, { step: 0.01, precision: 1 });
        S('contrast', 'Contrast', -100, 100);
        S('highlights', 'Highlights', -100, 100);
        S('shadows', 'Shadows', -100, 100);
        S('whites', 'Whites', -100, 100);
        S('blacks', 'Blacks', -100, 100);
        S('saturation', 'Saturation', 0, 200);
        break;
      }
      case 'creativeOn': {
        const look = this.value('look');
        const prev = h('canvas.lu-lookprev', { width: 220, height: 70 });
        this.drawLookPreview(prev, look);
        const dd = dropdown({ options: LOOKS.map((l, i) => ({ label: l.name, value: i })), value: look, onChange: (v) => this.setter('look', 'Look').set(v) });
        const nav = h('div.lu-looknav', iconButton('kfPrev', 'Previous look', () => this.setter('look', 'Look').set((look - 1 + LOOKS.length) % LOOKS.length)), prev, iconButton('kfNext', 'Next look', () => this.setter('look', 'Look').set((look + 1) % LOOKS.length)));
        box.appendChild(h('div.lu-row', h('label', 'Look'), dd.el));
        box.appendChild(nav);
        S('intensity', 'Intensity', 0, 200);
        box.appendChild(h('div.lu-sub', 'Adjustments'));
        S('fade', 'Faded Film', 0, 100);
        S('sharpen', 'Sharpen', -100, 100);
        S('vibrance', 'Vibrance', -100, 100);
        S('cSat', 'Saturation', 0, 200);
        const wheels = h('div.lu-wheels.small', this.wheel('shadowTint', 'Shadow Tint', 90), this.wheel('highlightTint', 'Highlight Tint', 90));
        box.appendChild(wheels);
        S('tintBalance', 'Tint Balance', -100, 100);
        break;
      }
      case 'curvesOn': {
        box.appendChild(h('div.lu-sub', 'RGB Curves'));
        box.appendChild(this.rgbCurveEditor());
        box.appendChild(h('div.lu-sub', 'Hue Saturation Curves'));
        box.appendChild(this.hueCurveEditor());
        break;
      }
      case 'wheelsOn': {
        const w = h('div.lu-wheels', this.wheel('wShadows', 'Shadows', 110, 'lShadows'), this.wheel('wMid', 'Midtones', 110, 'lMid'), this.wheel('wHigh', 'Highlights', 110, 'lHigh'));
        box.appendChild(w);
        break;
      }
      case 'hslOn': {
        box.appendChild(h('div.lu-sub', 'Key'));
        S('hslHue', 'Hue Center', 0, 360, { grad: 'linear-gradient(90deg,#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00)' });
        S('hslHueRange', 'Hue Range', 0, 180);
        S('hslSatLo', 'Saturation Min', 0, 100);
        S('hslSatHi', 'Saturation Max', 0, 100);
        S('hslLumLo', 'Lightness Min', 0, 100);
        S('hslLumHi', 'Lightness Max', 0, 100);
        box.appendChild(h('div.lu-row', checkbox({ checked: !!this.value('hslMask'), label: 'Show Mask', onChange: (v) => this.setter('hslMask', 'Show Mask').set(v) }).el, checkbox({ checked: !!this.value('hslInvert'), label: 'Invert Mask', onChange: (v) => this.setter('hslInvert', 'Invert Mask').set(v) }).el));
        box.appendChild(h('div.lu-sub', 'Refine'));
        S('hslSoft', 'Softness', 0, 100);
        box.appendChild(h('div.lu-sub', 'Correction'));
        S('hslTemp', 'Temperature', -100, 100, { grad: 'linear-gradient(90deg,#3a7bd5,#d8d8d8,#e8b33c)' });
        S('hslTint', 'Tint', -100, 100, { grad: 'linear-gradient(90deg,#3ab55a,#d8d8d8,#c93fc9)' });
        S('hslContrast', 'Contrast', -100, 100);
        S('hslSat', 'Saturation', 0, 200);
        S('hslHueShift', 'Hue Shift', -180, 180);
        break;
      }
      case 'vigOn': {
        S('vigAmount', 'Amount', -5, 5, { step: 0.01, precision: 1 });
        S('vigMid', 'Midpoint', 0, 100);
        S('vigRound', 'Roundness', -100, 100);
        S('vigFeather', 'Feather', 0, 100);
        break;
      }
    }
  }

  slider(pid, label, min, max, { step = 0.1, precision = 1, grad = null } = {}) {
    const v = this.value(pid);
    const st = this.setter(pid, label);
    const range = h('input.lu-range', { type: 'range', min, max, step, value: v });
    if (grad) range.style.background = grad;
    const ht = hotText({ value: v, min, max, step: (max - min) / 400, precision, onStart: st.start, onInput: (x) => { range.value = x; st.input(x); }, onEnd: st.end });
    range.addEventListener('pointerdown', (e) => e.stopPropagation());
    range.addEventListener('input', () => {
      st.input(parseFloat(range.value));
      ht.set(parseFloat(range.value));
    });
    range.addEventListener('change', () => st.end());
    const pd = getEffectDef('lumetri').params.find((p) => p.id === pid);
    const rowEl = h('div.lu-row', h('label', { title: 'Double-click to reset' }, label), range, ht.el);
    rowEl.querySelector('label').addEventListener('dblclick', () => st.set(pd.default));
    range.addEventListener('dblclick', () => st.set(pd.default));
    this.updaters.push(() => {
      const nv = this.value(pid);
      if (document.activeElement !== range) range.value = nv;
      ht.set(nv);
    });
    return rowEl;
  }

  refreshValues() {
    if (!this.updaters) return;
    for (const u of this.updaters) u();
  }

  lutRow() {
    const v = this.value('lut');
    const luts = app.project.luts || {};
    const dd = dropdown({
      options: [{ label: 'None', value: null }, ...Object.entries(luts).map(([id, L]) => ({ label: L.name, value: id })), { sep: true }, { label: 'Browse…', value: '__browse' }],
      value: v,
      onChange: async (x) => {
        if (x === '__browse') {
          const id = await app.services.luts.browse();
          if (id) this.setter('lut', 'Input LUT').set(id);
          else this.render();
          return;
        }
        this.setter('lut', 'Input LUT').set(x);
      },
    });
    return h('div.lu-row', h('label', 'Input LUT'), dd.el);
  }

  resetGroup(ids) {
    app.edit('Lumetri Reset', () => {
      const clip = this.target();
      const fx = this.fx(clip);
      if (!fx) return;
      const def = getEffectDef('lumetri');
      for (const id of ids) fx.params[id] = { v: defaultParamValue(def.params.find((p) => p.id === id)), kf: null };
    });
  }

  autoTone() {
    const comp = app.services.compositor;
    const prev = comp.wantScopes;
    comp.wantScopes = true;
    const seq = app.seq;
    comp.renderFrame(seq, seq.playhead, { scale: 0.25 });
    comp.wantScopes = prev;
    const d = comp.scopeData;
    if (!d) return;
    const lum = [];
    for (let i = 0; i < d.data.length; i += 4) lum.push(0.2126 * d.data[i] + 0.7152 * d.data[i + 1] + 0.0722 * d.data[i + 2]);
    lum.sort((a, b) => a - b);
    const p = (q) => lum[Math.floor(q * (lum.length - 1))] / 255;
    const lo = p(0.01), hi = p(0.99), mid = p(0.5);
    app.edit('Lumetri Auto', () => {
      const clip = this.target();
      const fx = this.ensureFx();
      const t = this.kfT(clip);
      setParamValue(fx.params.exposure, t, clamp(Math.log2(0.45 / Math.max(0.05, mid)) * 0.8, -2, 2));
      setParamValue(fx.params.whites, t, clamp((0.95 - hi) * 150, -60, 60));
      setParamValue(fx.params.blacks, t, clamp((0.03 - lo) * 300, -60, 60));
      setParamValue(fx.params.contrast, t, clamp((0.75 - (hi - lo)) * 60, -30, 40));
    });
  }

  drawLookPreview(cv, look) {
    const c = cv.getContext('2d');
    const L = LOOKS[look] || LOOKS[0];
    const g = c.createLinearGradient(0, 0, cv.width, 0);
    const tone = (x) => {
      let r = x, gg = x * 0.95 + 0.05, b = x * 0.9 + 0.1;
      const t = L.temp || 0;
      r *= 1 + t * 0.3;
      b *= 1 - t * 0.3;
      if (L.mono) r = gg = b = (r + gg + b) / 3;
      if (L.high) {
        r += L.high[0] * x * 2;
        gg += L.high[1] * x * 2;
        b += L.high[2] * x * 2;
      }
      if (L.shadow) {
        r += L.shadow[0] * (1 - x) * 2;
        gg += L.shadow[1] * (1 - x) * 2;
        b += L.shadow[2] * (1 - x) * 2;
      }
      return rgbToHex([clamp(r, 0, 1), clamp(gg, 0, 1), clamp(b, 0, 1)]);
    };
    for (let i = 0; i <= 10; i++) g.addColorStop(i / 10, tone(i / 10));
    c.fillStyle = g;
    c.fillRect(0, 0, cv.width, cv.height);
    c.fillStyle = 'rgba(0,0,0,.55)';
    c.fillRect(0, cv.height - 18, cv.width, 18);
    c.fillStyle = '#fff';
    c.font = '11px sans-serif';
    c.fillText(L.name, 6, cv.height - 5);
  }

  wheel(pid, label, size, levelPid = null) {
    const cv = h('canvas.lu-wheel', { width: size * 2, height: size * 2, style: { width: size + 'px', height: size + 'px' } });
    const st = this.setter(pid, label);
    const draw = () => {
      const c = cv.getContext('2d');
      const R = size;
      c.clearRect(0, 0, size * 2, size * 2);
      const img = c.createImageData(size * 2, size * 2);
      for (let y = 0; y < size * 2; y++)
        for (let x = 0; x < size * 2; x++) {
          const dx = (x - R) / R, dy = (y - R) / R;
          const r = Math.hypot(dx, dy);
          if (r > 1) continue;
          const hue = ((Math.atan2(-dy, dx) / (2 * Math.PI)) + 1) % 1;
          const [rr, gg, bb] = hslToRgb(hue, r * 0.85, 0.5 - 0.22 * (1 - r) + 0.18 * (1 - r));
          const i = (y * size * 2 + x) * 4;
          img.data[i] = rr * 160 + 40;
          img.data[i + 1] = gg * 160 + 40;
          img.data[i + 2] = bb * 160 + 40;
          img.data[i + 3] = r > 0.97 ? (1 - (r - 0.97) / 0.03) * 255 : 255;
        }
      c.putImageData(img, 0, 0);
      c.strokeStyle = 'rgba(0,0,0,.4)';
      c.beginPath();
      c.moveTo(R, R - 8);
      c.lineTo(R, R + 8);
      c.moveTo(R - 8, R);
      c.lineTo(R + 8, R);
      c.stroke();
      const v = this.value(pid) || [0, 0];
      const px = R + v[0] * R, py = R + v[1] * R;
      c.lineWidth = 3;
      c.strokeStyle = '#fff';
      c.beginPath();
      c.arc(px, py, 8, 0, Math.PI * 2);
      c.stroke();
    };
    draw();
    cv.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const r = cv.getBoundingClientRect();
      const set = (ev) => {
        let x = ((ev.clientX - r.left) / r.width) * 2 - 1, y = ((ev.clientY - r.top) / r.height) * 2 - 1;
        const m = Math.hypot(x, y);
        if (m > 1) {
          x /= m;
          y /= m;
        }
        st.input([Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000]);
        draw();
      };
      st.start();
      set(e);
      dragPointer(e, { move: (dx, dy, ev) => set(ev), up: () => st.end() });
    });
    cv.addEventListener('dblclick', () => {
      st.set([0, 0]);
    });
    this.updaters.push(draw);
    const col = h('div.lu-wheelcol', h('div.lu-wheellabel', label), cv);
    if (levelPid) {
      const lv = this.value(levelPid);
      const lst = this.setter(levelPid, label + ' Level');
      const range = h('input.lu-vrange', { type: 'range', min: -100, max: 100, step: 0.5, value: lv });
      range.addEventListener('input', () => lst.input(parseFloat(range.value)));
      range.addEventListener('change', () => lst.end());
      range.addEventListener('dblclick', () => lst.set(0));
      this.updaters.push(() => (range.value = this.value(levelPid)));
      return h('div.lu-wheelwrap', col, range);
    }
    return col;
  }

  rgbCurveEditor() {
    const S = 220;
    const cv = h('canvas.lu-curve', { width: S * 2, height: S * 2, style: { width: S + 'px', height: S + 'px' } });
    const chans = h('div.lu-curvech');
    const colors = { master: '#e6e6e6', r: '#ff5050', g: '#40d060', b: '#4f8cff' };
    for (const ch of ['master', 'r', 'g', 'b']) {
      const b = h('span.lu-chbtn' + (this.curveCh === ch ? '.on' : ''), { style: { background: colors[ch] } });
      b.onclick = () => {
        this.curveCh = ch;
        this.render();
      };
      chans.appendChild(b);
    }
    const st = this.setter('curves', 'RGB Curves');
    const draw = () => {
      const c = cv.getContext('2d');
      const W = S * 2;
      c.fillStyle = '#1a1a1a';
      c.fillRect(0, 0, W, W);
      c.strokeStyle = '#333';
      c.lineWidth = 1;
      for (let i = 1; i < 4; i++) {
        c.beginPath();
        c.moveTo((i * W) / 4, 0);
        c.lineTo((i * W) / 4, W);
        c.moveTo(0, (i * W) / 4);
        c.lineTo(W, (i * W) / 4);
        c.stroke();
      }
      c.strokeStyle = '#444';
      c.beginPath();
      c.moveTo(0, W);
      c.lineTo(W, 0);
      c.stroke();
      const curves = this.value('curves');
      for (const ch of ['master', 'r', 'g', 'b']) {
        if (ch !== this.curveCh && JSON.stringify(curves[ch]) === '[[0,0],[1,1]]') continue;
        c.strokeStyle = colors[ch];
        c.globalAlpha = ch === this.curveCh ? 1 : 0.35;
        c.lineWidth = 2.5;
        c.beginPath();
        for (let x = 0; x <= W; x += 2) {
          const y = evalCurve(curves[ch], x / W);
          if (x === 0) c.moveTo(x, W - y * W);
          else c.lineTo(x, W - clamp(y, 0, 1) * W);
        }
        c.stroke();
      }
      c.globalAlpha = 1;
      for (const [x, y] of curves[this.curveCh]) {
        c.fillStyle = colors[this.curveCh];
        c.beginPath();
        c.arc(x * W, W - y * W, 7, 0, Math.PI * 2);
        c.fill();
      }
    };
    draw();
    this.updaters.push(draw);
    cv.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const r = cv.getBoundingClientRect();
      const toN = (ev) => [clamp((ev.clientX - r.left) / r.width, 0, 1), clamp(1 - (ev.clientY - r.top) / r.height, 0, 1)];
      const curves = deepClone(this.value('curves'));
      let pts = curves[this.curveCh];
      const [nx, ny] = toN(e);
      let idx = pts.findIndex(([x, y]) => Math.hypot(x - nx, y - ny) < 0.04);
      if ((e.ctrlKey || e.metaKey || e.button === 2) && idx >= 0) {
        if (pts.length > 2) {
          pts.splice(idx, 1);
          st.set(curves);
        }
        return;
      }
      if (idx < 0) {
        pts.push([nx, evalCurve(pts, nx)]);
        pts.sort((a, b) => a[0] - b[0]);
        idx = pts.findIndex((p) => p[0] === nx);
      }
      st.start();
      const isEnd = idx === 0 || idx === pts.length - 1;
      const move = (ev) => {
        const [x, y] = toN(ev);
        const lo = idx > 0 ? pts[idx - 1][0] + 0.01 : 0, hi = idx < pts.length - 1 ? pts[idx + 1][0] - 0.01 : 1;
        pts[idx] = [isEnd && (idx === 0 || idx === pts.length - 1) ? clamp(x, lo, hi) : clamp(x, lo, hi), y];
        st.input(deepClone(curves));
        draw();
      };
      move(e);
      dragPointer(e, { move: (dx, dy, ev) => move(ev), up: () => st.end() });
    });
    cv.addEventListener('contextmenu', (e) => e.preventDefault());
    cv.addEventListener('dblclick', () => {
      const curves = deepClone(this.value('curves'));
      curves[this.curveCh] = [[0, 0], [1, 1]];
      st.set(curves);
    });
    return h('div.lu-curvewrap', chans, cv, h('div.muted.tiny', 'Click to add points · drag to adjust · ' + 'Ctrl+click to delete · double-click to reset channel'));
  }

  hueCurveEditor() {
    const W = 260, H = 130;
    const names = { hueSat: 'Hue vs Sat', hueHue: 'Hue vs Hue', hueLuma: 'Hue vs Luma', lumaSat: 'Luma vs Sat', satSat: 'Sat vs Sat' };
    const dd = dropdown({ options: Object.entries(names).map(([v, label]) => ({ label, value: v })), value: this.hueCurve, onChange: (v) => { this.hueCurve = v; this.render(); } });
    const cv = h('canvas.lu-huecurve', { width: W * 2, height: H * 2, style: { width: W + 'px', height: H + 'px' } });
    const st = this.setter('hueCurves', names[this.hueCurve]);
    const periodic = this.hueCurve.startsWith('hue');
    const draw = () => {
      const c = cv.getContext('2d');
      const w = W * 2, hh = H * 2;
      for (let x = 0; x < w; x++) {
        const t = x / w;
        let col;
        if (periodic) col = rgbToHex(hslToRgb(t, 0.7, 0.45));
        else col = this.hueCurve === 'lumaSat' ? rgbToHex([t, t, t]) : rgbToHex(hslToRgb(0.0, t, 0.45));
        c.fillStyle = col;
        c.fillRect(x, 0, 1, hh);
      }
      c.fillStyle = 'rgba(0,0,0,.35)';
      c.fillRect(0, 0, w, hh);
      c.strokeStyle = 'rgba(255,255,255,.25)';
      c.beginPath();
      c.moveTo(0, hh / 2);
      c.lineTo(w, hh / 2);
      c.stroke();
      const hc = this.value('hueCurves');
      const pts = hc[this.hueCurve] || [];
      c.strokeStyle = '#fff';
      c.lineWidth = 2.5;
      c.beginPath();
      for (let x = 0; x <= w; x += 2) {
        const y = evalCurve(pts, x / w, periodic, 0.5);
        if (x === 0) c.moveTo(x, hh - y * hh);
        else c.lineTo(x, hh - y * hh);
      }
      c.stroke();
      for (const [x, y] of pts) {
        c.fillStyle = '#fff';
        c.beginPath();
        c.arc(x * w, hh - y * hh, 7, 0, Math.PI * 2);
        c.fill();
      }
    };
    draw();
    this.updaters.push(draw);
    cv.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const r = cv.getBoundingClientRect();
      const toN = (ev) => [clamp((ev.clientX - r.left) / r.width, 0, 1), clamp(1 - (ev.clientY - r.top) / r.height, 0, 1)];
      const hc = deepClone(this.value('hueCurves'));
      const pts = hc[this.hueCurve] || (hc[this.hueCurve] = []);
      const [nx, ny] = toN(e);
      let idx = pts.findIndex(([x, y]) => Math.hypot(x - nx, y - ny) < 0.05);
      if ((e.ctrlKey || e.metaKey) && idx >= 0) {
        pts.splice(idx, 1);
        st.set(hc);
        return;
      }
      if (idx < 0) {
        if (!pts.length && periodic) {
          // seed with 3 anchor points like Premiere's eyedropper behaviour
          pts.push([clamp(nx - 0.12, 0, 1), 0.5], [nx, 0.5], [clamp(nx + 0.12, 0, 1), 0.5]);
          idx = 1;
        } else {
          pts.push([nx, evalCurve(pts, nx, periodic, 0.5)]);
          pts.sort((a, b) => a[0] - b[0]);
          idx = pts.findIndex((p) => p[0] === nx);
        }
      }
      st.start();
      const move = (ev) => {
        const [x, y] = toN(ev);
        pts[idx] = [x, y];
        st.input(deepClone(hc));
        draw();
      };
      move(e);
      dragPointer(e, { move: (dx, dy, ev) => move(ev), up: () => { pts.sort((a, b) => a[0] - b[0]); st.end(); } });
    });
    cv.addEventListener('dblclick', () => {
      const hc = deepClone(this.value('hueCurves'));
      hc[this.hueCurve] = [];
      st.set(hc);
    });
    return h('div.lu-curvewrap', dd.el, cv);
  }
}

// ================= Lumetri Scopes =================
class ScopesPanel {
  constructor() {
    this.def = registerPanel({ id: 'scopes', title: 'Lumetri Scopes', onShow: () => this.activate(true), onResize: () => this.draw() });
    this.root = this.def.el;
    this.root.classList.add('scope-root');
    this.mode = localStorage.getItem('videdi.scope') || 'waveform';
    this.cv = h('canvas.scope-canvas');
    const dd = dropdown({
      options: [{ label: 'Waveform (Luma)', value: 'waveform' }, { label: 'Waveform (RGB)', value: 'waveformRGB' }, { label: 'RGB Parade', value: 'parade' }, { label: 'Vectorscope YUV', value: 'vector' }, { label: 'Histogram', value: 'histogram' }],
      value: this.mode,
      onChange: (v) => {
        this.mode = v;
        localStorage.setItem('videdi.scope', v);
        this.draw();
      },
    });
    this.root.append(h('div.scope-top', dd.el, h('span.muted.tiny', '8 Bit')), h('div.scope-wrap', this.cv));
    app.bus.on('program:rendered', () => {
      if (app.services.layout?.isVisible('scopes')) this.draw();
    });
    app.bus.on('workspace:changed', () => this.activate(app.services.layout?.isVisible('scopes')));
    setInterval(() => this.activate(app.services.layout?.isVisible('scopes')), 1000);
  }

  activate(on) {
    const comp = app.services.compositor;
    if (!comp) return;
    if (comp.wantScopes !== !!on) {
      comp.wantScopes = !!on;
      if (on) app.bus.emit('time:changed', { seq: app.seq });
    }
  }

  draw() {
    const comp = app.services.compositor;
    const r = this.cv.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(10, Math.floor(r.width)), H = Math.max(10, Math.floor(r.height));
    this.cv.width = W * dpr;
    this.cv.height = H * dpr;
    this.cv.style.width = W + 'px';
    this.cv.style.height = H + 'px';
    const c = this.cv.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.fillStyle = '#0d0d0d';
    c.fillRect(0, 0, W, H);
    const d = comp?.scopeData;
    if (!d) {
      c.fillStyle = '#666';
      c.fillText('No video', 10, 20);
      return;
    }
    if (this.mode === 'vector') return this.drawVector(c, W, H, d);
    if (this.mode === 'histogram') return this.drawHistogram(c, W, H, d);
    return this.drawWaveform(c, W, H, d, this.mode);
  }

  drawWaveform(c, W, H, d, mode) {
    const pad = 28, top = 8, bottom = 8;
    const PW = W - pad - 6, PH = H - top - bottom;
    c.strokeStyle = '#2b2b2b';
    c.fillStyle = '#777';
    c.font = '10px sans-serif';
    for (let i = 0; i <= 10; i++) {
      const y = top + PH - (i / 10) * PH;
      c.beginPath();
      c.moveTo(pad, Math.round(y) + 0.5);
      c.lineTo(W - 6, Math.round(y) + 0.5);
      c.stroke();
      if (i % 2 === 0) c.fillText(String(i * 10), 4, y + 3);
    }
    const parts = mode === 'parade' ? 3 : 1;
    const buf = new Float32Array(PW * PH * 3);
    const { w, h: hh, data } = d;
    for (let y = 0; y < hh; y++)
      for (let x = 0; x < w; x++) {
        const i = ((hh - 1 - y) * w + x) * 4;
        const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
        const plot = (val, part, ch) => {
          // Spread each sample column over the display columns it covers so the trace has no gaps.
          const off = (part * PW) / parts, span = PW / parts;
          const px0 = Math.floor((x / w) * span + off);
          const px1 = Math.max(px0 + 1, Math.floor(((x + 1) / w) * span + off));
          const py = Math.floor((1 - clamp(val, 0, 1)) * (PH - 1));
          for (let px = px0; px < px1 && px < PW; px++) buf[(py * PW + px) * 3 + ch] += 1;
        };
        if (mode === 'waveform') {
          const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          plot(l, 0, 0);
          plot(l, 0, 1);
          plot(l, 0, 2);
        } else if (mode === 'waveformRGB') {
          plot(r, 0, 0);
          plot(g, 0, 1);
          plot(b, 0, 2);
        } else {
          plot(r, 0, 0);
          plot(g, 1, 1);
          plot(b, 2, 2);
        }
      }
    const out = c.createImageData(PW, PH);
    const gain = (PH / hh) * 0.9 + 0.6;
    for (let i = 0, j = 0; i < buf.length; i += 3, j += 4) {
      const a = buf[i], b2 = buf[i + 1], c2 = buf[i + 2];
      if (mode === 'waveform') {
        const v = Math.min(255, a * 40 * gain);
        out.data[j] = v * 0.55;
        out.data[j + 1] = v;
        out.data[j + 2] = v * 0.6;
      } else {
        out.data[j] = Math.min(255, a * 60 * gain);
        out.data[j + 1] = Math.min(255, b2 * 60 * gain);
        out.data[j + 2] = Math.min(255, c2 * 60 * gain);
      }
      out.data[j + 3] = 255;
    }
    const tmp = document.createElement('canvas');
    tmp.width = PW;
    tmp.height = PH;
    tmp.getContext('2d').putImageData(out, 0, 0);
    c.globalCompositeOperation = 'lighter';
    c.drawImage(tmp, pad, top);
    c.globalCompositeOperation = 'source-over';
  }

  drawVector(c, W, H, d) {
    const S = Math.min(W, H) - 16;
    const cx = W / 2, cy = H / 2, R = S / 2;
    c.strokeStyle = '#333';
    c.beginPath();
    c.arc(cx, cy, R, 0, Math.PI * 2);
    c.stroke();
    c.beginPath();
    c.moveTo(cx - R, cy);
    c.lineTo(cx + R, cy);
    c.moveTo(cx, cy - R);
    c.lineTo(cx, cy + R);
    c.stroke();
    const targets = { R: [1, 0, 0], Mg: [1, 0, 1], B: [0, 0, 1], Cy: [0, 1, 1], G: [0, 1, 0], Yl: [1, 1, 0] };
    const uvOf = (r, g, b) => {
      const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      return [(b - y) / 1.8556, (r - y) / 1.5748];
    };
    c.font = '10px sans-serif';
    for (const [n, [r, g, b]] of Object.entries(targets)) {
      const [u, v] = uvOf(r, g, b);
      const x = cx + u * R * 1.6, y = cy - v * R * 1.6;
      c.strokeStyle = '#555';
      c.strokeRect(x - 6, y - 6, 12, 12);
      c.fillStyle = '#888';
      c.fillText(n, x + 8, y + 3);
    }
    // skin tone line (~123 degrees)
    c.strokeStyle = 'rgba(255,190,120,0.35)';
    c.beginPath();
    c.moveTo(cx, cy);
    const a = (-123 * Math.PI) / 180;
    c.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
    c.stroke();
    c.fillStyle = 'rgba(120,255,140,0.35)';
    const { data } = d;
    for (let i = 0; i < data.length; i += 4) {
      const [u, v] = uvOf(data[i] / 255, data[i + 1] / 255, data[i + 2] / 255);
      c.fillRect(cx + u * R * 1.6, cy - v * R * 1.6, 1.2, 1.2);
    }
  }

  drawHistogram(c, W, H, d) {
    const bins = [new Float32Array(256), new Float32Array(256), new Float32Array(256)];
    const { data } = d;
    for (let i = 0; i < data.length; i += 4) {
      bins[0][data[i]]++;
      bins[1][data[i + 1]]++;
      bins[2][data[i + 2]]++;
    }
    let max = 1;
    for (const b of bins) for (let i = 1; i < 255; i++) max = Math.max(max, b[i]);
    const cols = ['rgba(255,70,70,0.7)', 'rgba(70,220,90,0.7)', 'rgba(80,140,255,0.7)'];
    c.globalCompositeOperation = 'lighter';
    bins.forEach((b, ci) => {
      c.fillStyle = cols[ci];
      c.beginPath();
      c.moveTo(8, H - 8);
      for (let i = 0; i < 256; i++) c.lineTo(8 + (i / 255) * (W - 16), H - 8 - Math.min(1, b[i] / max) * (H - 20));
      c.lineTo(W - 8, H - 8);
      c.closePath();
      c.fill();
    });
    c.globalCompositeOperation = 'source-over';
  }
}

export const lumetriPanel = new LumetriPanel();
export const scopesPanel = new ScopesPanel();
export { wheelToRgb };
