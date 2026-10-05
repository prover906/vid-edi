// Audio Meters, Audio Track Mixer, Audio Clip Mixer, Essential Sound.

import { app } from '../../core/app.js';
import { h, clamp, gainToDb, dbToGain, dragPointer, uid } from '../../core/util.js';
import { findClip, findItem, clipEnd, clipKfTime, kfTimeToFrame, createEffect, trackDisplayName } from '../../core/model.js';
import { evalParam, setParamValue, addKeyframe } from '../../core/keyframes.js';
import { registerPanel } from '../layout.js';
import { icon } from '../icons.js';
import { hotText, dropdown, checkbox, iconButton } from '../widgets.js';
import { audio } from '../../engine/audioEngine.js';
import { playback } from '../../engine/playback.js';

const dbFmt = (v) => (v <= -60 ? '-∞' : v.toFixed(1));
const meterY = (db, H) => {
  // -60..0 dB mapped with slight curve
  const n = clamp((db + 60) / 60, 0, 1);
  return H - Math.pow(n, 1.25) * H;
};

function drawMeter(c, x, y, w, H, peak, hold) {
  const db = gainToDb(peak);
  const top = meterY(db, H);
  const g = c.createLinearGradient(0, y + H, 0, y);
  g.addColorStop(0, '#17a34a');
  g.addColorStop(0.7, '#3ccf4e');
  g.addColorStop(0.86, '#e6d23a');
  g.addColorStop(1, '#ec3c3c');
  c.fillStyle = '#121212';
  c.fillRect(x, y, w, H);
  c.fillStyle = g;
  c.fillRect(x, y + top, w, H - top);
  if (hold != null) {
    const hy = meterY(gainToDb(hold), H);
    c.fillStyle = gainToDb(hold) > -0.1 ? '#ff4040' : '#e8e8e8';
    c.fillRect(x, y + hy, w, 1.5);
  }
}

class MeterState {
  constructor() {
    this.hold = new Map();
  }
  get(id, v) {
    const now = performance.now();
    let h0 = this.hold.get(id);
    if (!h0 || v >= h0.v || now - h0.t > 1600) {
      h0 = { v, t: now };
      this.hold.set(id, h0);
    }
    return h0.v;
  }
}

// ================= Audio Meters (narrow) =================
class AudioMeters {
  constructor() {
    this.def = registerPanel({ id: 'audioMeters', title: 'Audio Meters', tabTitle: () => '', onResize: () => this.resize() });
    this.root = this.def.el;
    this.root.classList.add('am-root');
    this.cv = h('canvas.am-canvas');
    this.root.append(this.cv, h('div.am-btns', h('button.am-sbtn', { title: 'Solo Left' }, 'S'), h('button.am-sbtn', { title: 'Solo Right' }, 'S')));
    this.state = new MeterState();
    this.decay = [0, 0];
    const loop = () => {
      this.draw();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }
  resize() {
    const r = this.cv.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.W = Math.max(10, r.width);
    this.H = Math.max(10, r.height);
    this.cv.width = this.W * dpr;
    this.cv.height = this.H * dpr;
    this.cv.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  draw() {
    if (!this.root.isConnected || !this.root.classList.contains('shown') || !this.W) return;
    const lv = audio.ctx ? audio.levels() : null;
    const raw = lv ? [lv.master[0], lv.master[1]] : [0, 0];
    for (let i = 0; i < 2; i++) this.decay[i] = Math.max(raw[i], this.decay[i] * 0.88);
    const c = this.cv.getContext('2d');
    const W = this.W, H = this.H;
    c.fillStyle = '#232323';
    c.fillRect(0, 0, W, H);
    const top = 6, mh = H - 12;
    const scaleW = 22;
    const mw = Math.max(4, Math.min(14, (W - scaleW - 10) / 2));
    const x0 = W - 6 - mw * 2 - 3;
    c.fillStyle = '#8a8a8a';
    c.font = '9px sans-serif';
    c.textAlign = 'right';
    for (const db of [0, -6, -12, -18, -24, -30, -36, -42, -48, -54]) {
      const y = top + meterY(db, mh);
      c.fillText(String(db), x0 - 4, y + 3);
      c.fillRect(x0 - 3, y, 2, 1);
    }
    c.fillText('dB', x0 - 4, H - 2);
    c.textAlign = 'left';
    drawMeter(c, x0, top, mw, mh, this.decay[0], this.state.get('L', this.decay[0]));
    drawMeter(c, x0 + mw + 3, top, mw, mh, this.decay[1], this.state.get('R', this.decay[1]));
  }
}

// ================= Audio Track Mixer =================
class TrackMixer {
  constructor() {
    this.def = registerPanel({ id: 'audioMixer', title: 'Audio Track Mixer', tabTitle: () => 'Audio Track Mixer' + (app.seq ? ': ' + app.seq.name : ''), onShow: () => this.render() });
    this.root = this.def.el;
    this.root.classList.add('mx-root');
    this.strips = h('div.mx-strips');
    this.root.append(this.strips);
    this.state = new MeterState();
    this.decay = new Map();
    app.bus.on('project:changed sequence:activated', (e) => {
      if (!(e && e.live)) this.render();
    });
    const loop = () => {
      this.drawMeters();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  render() {
    if (!this.root.isConnected) return;
    this.strips.innerHTML = '';
    this.meters = [];
    const seq = app.seq;
    if (!seq) return this.strips.appendChild(h('div.ec-empty', '(no sequence)'));
    for (const t of seq.audioTracks) this.strips.appendChild(this.strip(t, seq));
    this.strips.appendChild(this.strip(null, seq));
  }

  strip(t, seq) {
    const isMaster = !t;
    const name = isMaster ? 'Mix' : trackDisplayName(t) === t.name ? 'Audio ' + t.name.slice(1) : trackDisplayName(t);
    const vol = isMaster ? seq.masterVolume || 0 : t.volume || 0;
    const pan = isMaster ? 0 : t.pan || 0;
    const el = h('div.mx-strip' + (isMaster ? '.master' : ''));
    // pan knob
    const knob = h('canvas.mx-knob', { width: 64, height: 64 });
    const drawKnob = (p) => {
      const c = knob.getContext('2d');
      c.clearRect(0, 0, 64, 64);
      c.strokeStyle = '#555';
      c.lineWidth = 6;
      c.beginPath();
      c.arc(32, 34, 20, Math.PI * 0.75, Math.PI * 2.25);
      c.stroke();
      c.strokeStyle = '#4ca2ff';
      c.beginPath();
      const mid = Math.PI * 1.5;
      const ang = mid + p * Math.PI * 0.75;
      c.arc(32, 34, 20, Math.min(mid, ang), Math.max(mid, ang));
      c.stroke();
      c.fillStyle = '#ddd';
      c.beginPath();
      c.arc(32 + Math.cos(ang) * 12, 34 + Math.sin(ang) * 12, 3, 0, Math.PI * 2);
      c.fill();
    };
    if (!isMaster) {
      drawKnob(pan);
      const panTxt = hotText({ value: pan * 100, precision: 0, min: -100, max: 100, format: (v) => (Math.round(v) === 0 ? '0' : (v < 0 ? 'L' : 'R') + Math.abs(Math.round(v))), onStart: () => app.history.begin('Pan'), onInput: (v) => { t.pan = v / 100; drawKnob(t.pan); audio.updateTrackLive(t); }, onEnd: () => { app.history.commit(); app.markDirty(); } });
      knob.addEventListener('pointerdown', (e) => {
        const p0 = t.pan || 0;
        app.history.begin('Pan');
        dragPointer(e, { move: (dx, dy) => { t.pan = clamp(p0 + (dx - dy) / 100, -1, 1); drawKnob(t.pan); panTxt.set(t.pan * 100); audio.updateTrackLive(t); }, up: () => { app.history.commit(); app.markDirty(); } });
      });
      knob.addEventListener('dblclick', () => app.edit('Pan', () => (t.pan = 0)));
      el.append(knob, panTxt.el);
    } else el.append(h('div.mx-knob-pad'), h('div', ' '));
    // buttons
    if (!isMaster) {
      const m = h('button.tl-ms' + (t.muted ? '.on.mute' : ''), 'M');
      m.onclick = () => {
        app.edit('Mute Track', () => (t.muted = !t.muted));
        audio.updateTrackLive(t);
      };
      const s = h('button.tl-ms' + (t.solo ? '.on.solo' : ''), 'S');
      s.onclick = () => {
        app.edit('Solo Track', () => (t.solo = !t.solo));
        seq.audioTracks.forEach((x) => audio.updateTrackLive(x));
      };
      el.append(h('div.mx-btns', m, s));
    } else el.append(h('div.mx-btns'));
    // fader + meter
    const fader = h('input.mx-fader', { type: 'range', min: -60, max: 6, step: 0.1, value: vol, orient: 'vertical' });
    const meter = h('canvas.mx-meter', { width: 22, height: 200 });
    this.meters.push({ id: isMaster ? 'master' : t.id, cv: meter });
    const volTxt = hotText({ value: vol, precision: 1, min: -60, max: 6, format: dbFmt, onStart: () => app.history.begin('Volume'), onInput: (v) => { setVol(v); fader.value = v; }, onEnd: () => { app.history.commit(); app.markDirty(); } });
    const setVol = (v) => {
      if (isMaster) seq.masterVolume = v <= -60 ? -96 : v;
      else t.volume = v <= -60 ? -96 : v;
      audio.updateTrackLive(t || seq.audioTracks[0] || { id: '' });
    };
    let begun = false;
    fader.addEventListener('input', () => {
      if (!begun) {
        app.history.begin('Volume');
        begun = true;
      }
      setVol(+fader.value);
      volTxt.set(+fader.value);
    });
    fader.addEventListener('change', () => {
      begun = false;
      app.history.commit();
      app.markDirty();
    });
    fader.addEventListener('dblclick', () => {
      setVol(0);
      fader.value = 0;
      volTxt.set(0);
      app.markDirty();
    });
    el.append(h('div.mx-faderwrap', fader, meter), volTxt.el, h('div.mx-name', name));
    return el;
  }

  drawMeters() {
    if (!this.meters || !this.root.classList.contains('shown')) return;
    const lv = playback.playing && audio.ctx ? audio.levels() : null;
    for (const m of this.meters) {
      const src = lv ? (m.id === 'master' ? lv.master : lv.tracks[m.id]) : null;
      const prev = this.decay.get(m.id) || [0, 0];
      const cur = [Math.max(src ? src[0] : 0, prev[0] * 0.88), Math.max(src ? src[1] : 0, prev[1] * 0.88)];
      this.decay.set(m.id, cur);
      const c = m.cv.getContext('2d');
      const H = m.cv.height;
      drawMeter(c, 0, 0, 10, H, cur[0], this.state.get(m.id + 'L', cur[0]));
      drawMeter(c, 12, 0, 10, H, cur[1], this.state.get(m.id + 'R', cur[1]));
    }
  }
}

// ================= Audio Clip Mixer =================
class ClipMixer {
  constructor() {
    this.def = registerPanel({ id: 'audioClipMixer', title: 'Audio Clip Mixer', onShow: () => this.render() });
    this.root = this.def.el;
    this.root.classList.add('mx-root');
    this.strips = h('div.mx-strips');
    this.root.append(this.strips);
    app.bus.on('project:changed sequence:activated', (e) => {
      if (!(e && e.live)) this.render();
    });
    app.bus.on('time:changed', () => {
      clearTimeout(this._t);
      this._t = setTimeout(() => !playback.playing && this.render(), 120);
    });
  }
  render() {
    if (!this.root.isConnected || !this.root.classList.contains('shown')) return;
    const seq = app.seq;
    this.strips.innerHTML = '';
    if (!seq) return;
    const fps = seq.settings.fps;
    for (const t of seq.audioTracks) {
      const c = t.clips.find((x) => x.start <= seq.playhead && clipEnd(x) > seq.playhead);
      const el = h('div.mx-strip');
      if (!c) {
        el.append(h('div.mx-knob-pad'), h('div.muted.tiny', '—'), h('div.mx-faderwrap'), h('div.mx-name', 'Audio ' + t.name.slice(1)));
        this.strips.appendChild(el);
        continue;
      }
      const vfx = c.effects.find((e) => e.type === 'volume');
      const kfT = clipKfTime(c, seq.playhead, fps);
      const lvl = evalParam(vfx.params.level, kfT);
      const fader = h('input.mx-fader', { type: 'range', min: -60, max: 6, step: 0.1, value: lvl });
      const txt = h('span.hot', dbFmt(lvl));
      let begun = false;
      fader.addEventListener('input', () => {
        if (!begun) {
          app.history.begin('Clip Volume');
          begun = true;
        }
        const f = findClip(seq, c.id).clip.effects.find((e) => e.type === 'volume');
        setParamValue(f.params.level, kfT, +fader.value <= -60 ? -96 : +fader.value);
        txt.textContent = dbFmt(+fader.value);
        app.bus.emit('project:changed', { live: true });
      });
      fader.addEventListener('change', () => {
        begun = false;
        app.history.commit();
        app.changed();
      });
      const kfBtn = h('button.ibtn' + (vfx.params.level.kf ? '.on' : ''), { title: 'Write keyframes' }, icon('diamond'));
      kfBtn.onclick = () => app.edit('Add Keyframe', () => addKeyframe(findClip(seq, c.id).clip.effects.find((e) => e.type === 'volume').params.level, kfT));
      el.append(h('div.mx-knob-pad'), h('div.mx-btns', kfBtn), h('div.mx-faderwrap', fader), txt, h('div.mx-name', c.name));
      this.strips.appendChild(el);
    }
  }
}

// ================= Essential Sound =================
const TYPES = [['dialogue', 'Dialogue', '#3b8ee6'], ['music', 'Music', '#e6739f'], ['sfx', 'SFX', '#e8a33c'], ['ambience', 'Ambience', '#2ba7a7']];

class EssentialSound {
  constructor() {
    this.def = registerPanel({ id: 'essentialSound', title: 'Essential Sound', onShow: () => this.render() });
    this.root = this.def.el;
    this.root.classList.add('es-root');
    app.bus.on('selection:changed project:changed', (e) => {
      if (!(e && e.live)) this.render();
    });
  }

  clips() {
    const seq = app.seq;
    if (!seq) return [];
    return [...app.sel.clips].map((id) => findClip(seq, id)).filter((f) => f && f.kind === 'audio').map((f) => f.clip);
  }

  render() {
    if (!this.root.isConnected) return;
    this.root.innerHTML = '';
    const clips = this.clips();
    if (!clips.length) {
      this.root.appendChild(h('div.ec-empty', 'Select audio clips in the timeline, then assign an audio type.'));
      return;
    }
    const type = clips[0].audioType;
    if (!type) {
      const box = h('div.es-types', h('div.muted', { style: { marginBottom: '8px' } }, 'Edit a selection of clips as audio type:'));
      for (const [id, label, col] of TYPES) {
        const b = h('button.es-type', { style: { borderColor: col } }, label);
        b.onclick = () => app.edit('Assign Audio Type', () => this.clips().forEach((c) => (c.audioType = id)));
        box.appendChild(b);
      }
      this.root.appendChild(box);
      return;
    }
    const T = TYPES.find((t) => t[0] === type);
    const head = h('div.es-head', { style: { borderLeftColor: T[2] } }, h('b', T[1]), h('span.spacer'), h('button.btn.sm', { onclick: () => app.edit('Clear Audio Type', () => this.clips().forEach((c) => { c.audioType = null; c.effects = c.effects.filter((e) => !e.esTag); })) }, 'Clear Audio Type'));
    this.root.appendChild(head);
    const sec = (title, ...kids) => h('div.es-sec', h('div.es-sechead', title), ...kids);
    // Loudness
    this.root.appendChild(sec('Loudness', h('button.btn.sm', { onclick: () => this.autoMatch(type) }, 'Auto-Match'), h('span.muted.tiny', '  Target: ' + (type === 'dialogue' ? '-23' : type === 'music' ? '-25' : '-24') + ' LUFS (approx.)')));
    if (type === 'dialogue') {
      this.root.appendChild(sec('Repair', this.toggleFx('reduceRumble', 'Reduce Rumble', 'highpass', { cutoff: 90 }), this.toggleFx('deHum', 'DeHum', 'deHummer', { freq: 1, harmonics: 4 }), this.toggleFx('deEss', 'DeEss', 'simpleParamEQ', { center: 6800, q: 2.5, boost: -6 }), this.toggleFx('reduceNoise', 'Reduce Noise (gentle)', 'lowpass', { cutoff: 9000 })));
      this.root.appendChild(sec('Clarity', this.toggleFx('dynamics', 'Dynamics', 'compressor', { threshold: -24, ratio: 3, makeup: 4 }), this.toggleFx('eq', 'EQ: Podcast Voice', 'paramEQ', { lowF: 100, lowG: -4, m1F: 300, m1G: -2, m2F: 3000, m2G: 3, highF: 10000, highG: 2 }), this.toggleFx('enhance', 'Enhance Speech', 'vocalEnhancer', { mode: 0 })));
      this.root.appendChild(sec('Creative', this.toggleFx('reverb', 'Reverb: Warm Room', 'studioReverb', { preset: 1, decay: 1.2, mix: 18 })));
    }
    if (type === 'music' || type === 'ambience') {
      const amt = h('input', { type: 'number', value: -18, step: 1, style: { width: '60px' } });
      this.root.appendChild(sec('Ducking', h('div.muted.tiny', 'Lower this ' + type + ' under dialogue clips (generates volume keyframes).'), h('div.form-row', h('label', 'Duck Amount (dB)'), amt), h('button.btn.sm', { onclick: () => this.duck(+amt.value || -18) }, 'Generate Keyframes')));
    }
    if (type === 'sfx' || type === 'ambience') this.root.appendChild(sec('Creative', this.toggleFx('reverb', 'Reverb: Outside', 'studioReverb', { preset: 2, decay: 2.5, mix: 25 })));
    // clip volume
    const c0 = clips[0];
    const vfx = c0.effects.find((e) => e.type === 'volume');
    const lvl = vfx ? vfx.params.level.v : 0;
    const fader = h('input', { type: 'range', min: -60, max: 15, step: 0.1, value: lvl, style: { flex: 1 } });
    const txt = h('span.hot', dbFmt(lvl));
    fader.addEventListener('input', () => (txt.textContent = dbFmt(+fader.value)));
    fader.addEventListener('change', () => app.edit('Clip Volume', () => this.clips().forEach((c) => {
      const f = c.effects.find((e) => e.type === 'volume');
      if (f) f.params.level.v = +fader.value;
    })));
    const mute = checkbox({ checked: !!c0.esMute, label: 'Mute', onChange: (v) => app.edit('Mute Clip', () => this.clips().forEach((c) => { c.esMute = v; c.enabled = !v; })) });
    this.root.appendChild(sec('Clip Volume', h('div.form-row', fader, txt), mute.el));
  }

  toggleFx(tag, label, type, params) {
    const clips = this.clips();
    const on = clips.length && clips.every((c) => c.effects.some((e) => e.esTag === tag));
    return h('div.es-row', checkbox({
      checked: on,
      label,
      onChange: (v) => app.edit(label, () => {
        for (const c of this.clips()) {
          c.effects = c.effects.filter((e) => e.esTag !== tag);
          if (v) {
            const fx = createEffect(type, {});
            for (const [k, val] of Object.entries(params)) if (fx.params[k]) fx.params[k].v = val;
            fx.esTag = tag;
            fx.label = label;
            c.effects.push(fx);
          }
        }
      }),
    }).el);
  }

  autoMatch(type) {
    const target = type === 'dialogue' ? -23 : type === 'music' ? -25 : -24;
    app.edit('Auto-Match Loudness', () => {
      for (const c of this.clips()) {
        const it = findItem(app.project, c.itemId);
        const buf = it && app.rt(it.id).audioBuffer;
        if (!buf) continue;
        const fps = app.seq.settings.fps;
        const sr = buf.sampleRate;
        const a = Math.floor(c.in * sr), b = Math.min(buf.length, Math.floor((c.in + (c.dur / fps) * c.speed) * sr));
        let sum = 0, n = 0;
        for (let ch = 0; ch < buf.numberOfChannels; ch++) {
          const d = buf.getChannelData(ch);
          for (let i = a; i < b; i += 4) {
            sum += d[i] * d[i];
            n++;
          }
        }
        const rms = Math.sqrt(sum / Math.max(1, n));
        const lufs = gainToDb(rms) - 0.7;
        c.gain = clamp(target - lufs, -40, 40);
      }
    });
    app.toast('Loudness matched', 'ok');
  }

  duck(amount) {
    const seq = app.seq;
    const fps = seq.settings.fps;
    const dialog = [];
    for (const t of seq.audioTracks) for (const c of t.clips) if (c.audioType === 'dialogue') dialog.push([c.start, clipEnd(c)]);
    if (!dialog.length) return app.toast('No clips tagged as Dialogue found', 'warn');
    dialog.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const d of dialog) {
      const l = merged[merged.length - 1];
      if (l && d[0] <= l[1] + fps) l[1] = Math.max(l[1], d[1]);
      else merged.push([...d]);
    }
    const fade = Math.round(fps * 0.4);
    app.edit('Auto Ducking', () => {
      for (const c of this.clips()) {
        const f = c.effects.find((e) => e.type === 'volume');
        if (!f) continue;
        const base = evalParam(f.params.level, clipKfTime(c, c.start, fps));
        const kfs = [{ t: clipKfTime(c, c.start, fps), v: base, interp: 'linear' }];
        for (const [a, b] of merged) {
          if (b < c.start || a > clipEnd(c)) continue;
          const pts = [[a - fade, base], [a, base + amount], [b, base + amount], [b + fade, base]];
          for (const [fr, v] of pts) if (fr > c.start && fr < clipEnd(c)) kfs.push({ t: clipKfTime(c, fr, fps), v, interp: 'linear' });
        }
        kfs.sort((x, y) => x.t - y.t);
        f.params.level.kf = kfs;
      }
    });
    app.toast('Ducking keyframes generated', 'ok');
  }
}

export const audioMeters = new AudioMeters();
export const trackMixer = new TrackMixer();
export const clipMixer = new ClipMixer();
export const essentialSound = new EssentialSound();
export { kfTimeToFrame, uid };
