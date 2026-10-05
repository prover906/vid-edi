// Web Audio engine: schedules sequence audio (realtime & offline), meters, scrubbing.

import { app } from '../core/app.js';
import { findItem, clipKfTime, itemSourceDuration } from '../core/model.js';
import { getEffectDef, getTransitionDef } from '../core/registry.js';
import { evalParam, isAnimated } from '../core/keyframes.js';
import { dbToGain, clamp } from '../core/util.js';
import './audioEffects.js';

const ENV_RATE = 100; // envelope samples per second

function meterFrom(an, buf) {
  an.getFloatTimeDomainData(buf);
  let peak = 0, sum = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = Math.abs(buf[i]);
    if (v > peak) peak = v;
    sum += buf[i] * buf[i];
  }
  return { peak, rms: Math.sqrt(sum / buf.length) };
}

class Meter {
  constructor(ctx, input) {
    this.split = ctx.createChannelSplitter(2);
    this.l = ctx.createAnalyser();
    this.r = ctx.createAnalyser();
    this.l.fftSize = this.r.fftSize = 1024;
    input.connect(this.split);
    this.split.connect(this.l, 0);
    this.split.connect(this.r, 1);
    this.buf = new Float32Array(1024);
  }
  read() {
    const a = meterFrom(this.l, this.buf), b = meterFrom(this.r, this.buf);
    return [a.peak, b.peak, a.rms, b.rms];
  }
  disconnect() {
    try {
      this.split.disconnect();
    } catch (e) {
      /* ignore */
    }
  }
}

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.session = null;
    this.trackMeters = new Map();
    this.scrubAt = 0;
  }

  ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC({ latencyHint: 'interactive', sampleRate: 48000 });
      this.master = this.ctx.createGain();
      this.master.channelCountMode = 'explicit';
      this.master.channelCount = 2;
      this.master.connect(this.ctx.destination);
      this.meter = new Meter(this.ctx, this.master);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    return this.ctx;
  }

  // Decoding context (works before a user gesture).
  // Decoding contexts (work before a user gesture), one per sample rate.
  decodeCtx(rate = 48000) {
    this._dctx = this._dctx || new Map();
    if (!this._dctx.has(rate)) this._dctx.set(rate, new OfflineAudioContext(2, 1, rate));
    return this._dctx.get(rate);
  }

  // Long media is decoded at a lower rate to keep memory reasonable.
  async decode(arrayBuffer, durationHint = 0) {
    const rate = durationHint > 3600 ? 16000 : durationHint > 1800 ? 24000 : 48000;
    return await this.decodeCtx(rate).decodeAudioData(arrayBuffer);
  }

  // AudioBuffer for an item (null if none).
  bufferFor(ctx, item, reverse = false, minDur = 10) {
    const rt = app.rt(item.id);
    if (item.type === 'synthetic') {
      if (item.kind === 'bars') return this.toneBuffer(ctx, Math.max(minDur, 10));
      if (item.kind === 'leader') return this.leaderBuffer(ctx, item.duration);
      return null;
    }
    const buf = rt.audioBuffer;
    if (!buf) return null;
    if (!reverse) return buf;
    if (!rt.reversedBuffer) {
      const r = new AudioBuffer({ length: buf.length, numberOfChannels: buf.numberOfChannels, sampleRate: buf.sampleRate });
      for (let c = 0; c < buf.numberOfChannels; c++) {
        const src = buf.getChannelData(c), dst = r.getChannelData(c);
        for (let i = 0, n = src.length; i < n; i++) dst[i] = src[n - 1 - i];
      }
      rt.reversedBuffer = r;
    }
    return rt.reversedBuffer;
  }

  toneBuffer(ctx, dur) {
    const key = 'tone' + ctx.sampleRate + ':' + Math.ceil(dur);
    this._synth = this._synth || new Map();
    if (this._synth.has(key)) return this._synth.get(key);
    const n = Math.ceil(dur * ctx.sampleRate);
    const b = new AudioBuffer({ length: n, numberOfChannels: 2, sampleRate: ctx.sampleRate });
    const a = dbToGain(-12);
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c);
      for (let i = 0; i < n; i++) d[i] = Math.sin((2 * Math.PI * 1000 * i) / ctx.sampleRate) * a;
    }
    this._synth.set(key, b);
    return b;
  }

  leaderBuffer(ctx, dur) {
    const key = 'leader' + ctx.sampleRate + ':' + dur;
    this._synth = this._synth || new Map();
    if (this._synth.has(key)) return this._synth.get(key);
    const sr = ctx.sampleRate, n = Math.ceil(dur * sr);
    const b = new AudioBuffer({ length: n, numberOfChannels: 2, sampleRate: sr });
    const a = dbToGain(-12);
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c);
      for (let s = 0; s <= 7; s++) {
        const st = s * sr, len = Math.floor(sr / 24);
        for (let i = 0; i < len && st + i < n; i++) d[st + i] = Math.sin((2 * Math.PI * 1000 * i) / sr) * a;
      }
    }
    this._synth.set(key, b);
    return b;
  }

  // ---- graph construction (shared by realtime & offline) ----
  scheduleSequence(ctx, seq, t0, T0, rate, dest, endSec, depth = 0, meterTracks = false) {
    if (depth > 6) return;
    const nodes = [];
    const anySolo = seq.audioTracks.some((t) => t.solo);
    for (const track of seq.audioTracks) {
      const silent = track.muted || (anySolo && !track.solo);
      if (silent && !meterTracks) continue;
      const bus = ctx.createGain();
      bus.channelCountMode = 'explicit';
      bus.channelCount = 2;
      const pan = ctx.createStereoPanner();
      pan.pan.value = track.pan || 0;
      const vol = ctx.createGain();
      vol.gain.value = silent ? 0 : dbToGain(track.volume || 0);
      bus.connect(pan).connect(vol).connect(dest);
      if (meterTracks && depth === 0) {
        const m = new Meter(ctx, vol);
        this.trackMeters.set(track.id, m);
      }
      nodes.push({ track, vol, pan });
      if (silent) continue;
      for (const clip of track.clips) {
        if (!clip.enabled) continue;
        try {
          this.scheduleClip(ctx, seq, track, clip, t0, T0, rate, bus, endSec, depth);
        } catch (err) {
          console.warn('audio schedule failed', err);
        }
      }
    }
    return nodes;
  }

  clipExtents(track, clip) {
    let pre = 0, post = 0;
    const fades = [];
    for (const tr of track.transitions) {
      const def = getTransitionDef(tr.type);
      if (tr.clipB === clip.id) {
        if (tr.clipA) pre = Math.max(pre, tr.offset);
        fades.push({ start: clip.start - tr.offset, dur: tr.dur, dir: 'in', curve: def?.curve || ((t) => t) });
      }
      if (tr.clipA === clip.id) {
        if (tr.clipB) post = Math.max(post, tr.dur - tr.offset);
        fades.push({ start: clip.start + clip.dur - tr.offset, dur: tr.dur, dir: 'out', curve: def?.curve || ((t) => t) });
      }
    }
    return { pre, post, fades };
  }

  scheduleClip(ctx, seq, track, clip, t0, T0, rate, bus, endSec, depth) {
    const project = app.project;
    const fps = seq.settings.fps;
    const item = clip.itemId ? findItem(project, clip.itemId) : null;
    if (!item) return;
    const ext = this.clipExtents(track, clip);
    const s0 = (clip.start - ext.pre) / fps;
    const s1 = (clip.start + clip.dur + ext.post) / fps;
    if (s1 <= t0 || s0 >= endSec) return;
    const playStart = Math.max(s0, t0);
    const playEnd = Math.min(s1, endSec);
    if (playEnd - playStart < 0.002) return;
    const when = T0 + (playStart - t0) / rate;
    const span = (playEnd - playStart) / rate;

    // clip chain: env -> effects -> output -> bus
    const env = ctx.createGain();
    let tail = env;
    const autos = [];
    for (const fx of clip.effects) {
      if (fx.enabled === false) continue;
      const def = getEffectDef(fx.type);
      if (!def || !def.build) continue;
      const kfT0 = clipKfTime(clip, playStart * fps, fps);
      const p = {};
      for (const pd of def.params) if (fx.params[pd.id]) p[pd.id] = evalParam(fx.params[pd.id], kfT0, pd);
      if (def.isDefault && def.isDefault(p) && !Object.values(fx.params).some(isAnimated)) continue;
      const n = def.build(ctx, p);
      tail.connect(n.input);
      tail = n.output;
      if (n.auto) for (const [pid, [param, map]] of Object.entries(n.auto)) if (isAnimated(fx.params[pid])) autos.push({ fx, pid, param, map, pd: def.params.find((x) => x.id === pid) });
    }
    tail.connect(bus);

    // envelope (clip gain * volume keyframes * fades)
    const volFx = clip.effects.find((e) => e.type === 'volume' && e.enabled !== false);
    const bypass = volFx ? evalParam(volFx.params.bypass, 0) : true;
    const baseGain = dbToGain(clip.gain || 0);
    const volAnimated = volFx && !bypass && isAnimated(volFx.params.level);
    const gainAt = (s) => {
      let g = baseGain;
      if (volFx && !bypass) g *= dbToGain(evalParam(volFx.params.level, clipKfTime(clip, s * fps, fps)));
      for (const f of ext.fades) {
        const fs = f.start / fps, fe = (f.start + f.dur) / fps;
        if (s < fs) {
          if (f.dir === 'in') g *= 0;
          continue;
        }
        if (s > fe) {
          if (f.dir === 'out') g *= 0;
          continue;
        }
        const u = (s - fs) / Math.max(1e-6, fe - fs);
        g *= f.curve(f.dir === 'in' ? u : 1 - u);
      }
      return g;
    };
    if (volAnimated || ext.fades.length) {
      const n = Math.max(2, Math.min(20000, Math.ceil((playEnd - playStart) * ENV_RATE) + 1));
      const curve = new Float32Array(n);
      for (let i = 0; i < n; i++) curve[i] = gainAt(playStart + ((playEnd - playStart) * i) / (n - 1));
      env.gain.setValueCurveAtTime(curve, Math.max(when, ctx.currentTime), Math.max(0.005, span - Math.max(0, ctx.currentTime - when)));
    } else env.gain.value = gainAt(playStart);
    for (const a of autos) {
      const n = Math.max(2, Math.min(10000, Math.ceil((playEnd - playStart) * 50) + 1));
      const curve = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const s = playStart + ((playEnd - playStart) * i) / (n - 1);
        curve[i] = a.map(evalParam(a.fx.params[a.pid], clipKfTime(clip, s * fps, fps), a.pd));
      }
      try {
        a.param.setValueCurveAtTime(curve, Math.max(when, ctx.currentTime), Math.max(0.005, span));
      } catch (e) {
        /* ignore */
      }
    }

    if (item.type === 'sequence') {
      const nestT0 = clip.in + (playStart - clip.start / fps) * clip.speed;
      const nestEnd = clip.in + (playEnd - clip.start / fps) * clip.speed;
      this.scheduleSequence(ctx, item, nestT0, when, rate * clip.speed, env, nestEnd, depth + 1);
      return;
    }
    if (item.type === 'media' && !item.hasAudio) return;
    const buffer = this.bufferFor(ctx, item, clip.reverse, (playEnd - playStart) * clip.speed + 1);
    if (!buffer) return;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const pr = clip.speed * rate;
    src.playbackRate.value = pr;
    if (item.type === 'synthetic' && item.kind === 'bars') {
      src.loop = true;
      src.loopStart = 0;
      src.loopEnd = 1;
    }
    if (clip.frameHold != null) return;
    const durSrc = (clip.dur / fps) * clip.speed;
    let offset;
    if (clip.reverse) offset = buffer.duration - (clip.in + durSrc) + (playStart - clip.start / fps) * clip.speed;
    else offset = clip.in + (playStart - clip.start / fps) * clip.speed;
    let startAt = when;
    if (offset < 0) {
      startAt += -offset / pr;
      offset = 0;
    }
    const bufDur = (playEnd - playStart) * clip.speed - Math.max(0, (startAt - when) * pr);
    if (bufDur <= 0 || offset >= buffer.duration) return;
    src.connect(env);
    const now = ctx.currentTime;
    if (startAt < now) {
      const lag = now - startAt;
      offset += lag * pr;
      startAt = now;
    }
    if (src.loop) src.start(startAt, offset % 1, bufDur / clip.speed);
    else src.start(startAt, offset, bufDur);
    this.session?.sources.push(src);
  }

  // ---- realtime playback ----
  start(seq, fromSec, rate = 1, endSec = Infinity) {
    this.stop();
    if (!seq) return;
    const ctx = this.ensure();
    const out = ctx.createGain();
    out.connect(this.master);
    this.session = { out, sources: [], seq, fromSec, rate, T0: ctx.currentTime + 0.05 };
    this.trackMeters.clear();
    out.gain.value = dbToGain(seq.masterVolume || 0);
    const end = Math.min(endSec, fromSec + 3600);
    this.session.tracks = this.scheduleSequence(ctx, seq, fromSec, this.session.T0, rate, out, end, 0, true);
    return this.session.T0;
  }

  // Seconds elapsed in sequence time since start (audio clock).
  clock() {
    if (!this.session) return null;
    const ctx = this.ctx;
    return this.session.fromSec + Math.max(0, ctx.currentTime - this.session.T0) * this.session.rate;
  }

  stop() {
    if (!this.session) return;
    const s = this.session;
    this.session = null;
    for (const src of s.sources) {
      try {
        src.stop();
      } catch (e) {
        /* ignore */
      }
    }
    const out = s.out;
    try {
      out.gain.setTargetAtTime(0, this.ctx.currentTime, 0.01);
    } catch (e) {
      /* ignore */
    }
    setTimeout(() => {
      try {
        out.disconnect();
      } catch (e) {
        /* ignore */
      }
    }, 120);
    for (const m of this.trackMeters.values()) m.disconnect();
    this.trackMeters.clear();
  }

  // Live updates for mixer controls while playing.
  updateTrackLive(track) {
    if (!this.session || !this.session.tracks) return;
    const n = this.session.tracks.find((x) => x.track.id === track.id);
    const seq = this.session.seq;
    const anySolo = seq.audioTracks.some((t) => t.solo);
    if (n) {
      const silent = track.muted || (anySolo && !track.solo);
      n.vol.gain.setTargetAtTime(silent ? 0 : dbToGain(track.volume || 0), this.ctx.currentTime, 0.02);
      n.pan.pan.setTargetAtTime(track.pan || 0, this.ctx.currentTime, 0.02);
    }
    this.session.out.gain.setTargetAtTime(dbToGain(seq.masterVolume || 0), this.ctx.currentTime, 0.02);
  }

  levels() {
    if (!this.ctx) return null;
    const res = { master: this.meter.read(), tracks: {} };
    for (const [id, m] of this.trackMeters) res.tracks[id] = m.read();
    return res;
  }

  // Short audio snippet while scrubbing.
  scrub(seq, sec) {
    if (!app.prefs.audioScrubbing || !seq) return;
    const now = performance.now();
    if (now - this.scrubAt < 55) return;
    this.scrubAt = now;
    const ctx = this.ensure();
    if (ctx.state !== 'running') return;
    const g = ctx.createGain();
    g.connect(this.master);
    const T0 = ctx.currentTime + 0.01;
    g.gain.setValueAtTime(0, T0);
    g.gain.linearRampToValueAtTime(dbToGain(seq.masterVolume || 0), T0 + 0.008);
    g.gain.setValueAtTime(dbToGain(seq.masterVolume || 0), T0 + 0.07);
    g.gain.linearRampToValueAtTime(0, T0 + 0.085);
    const saved = this.session;
    this.session = { sources: [] };
    this.scheduleSequence(ctx, seq, sec, T0, 1, g, sec + 0.09, 0, false);
    const srcs = this.session.sources;
    this.session = saved;
    setTimeout(() => {
      srcs.forEach((s) => {
        try {
          s.stop();
        } catch (e) {
          /* ignore */
        }
      });
      g.disconnect();
    }, 200);
  }

  // Offline mixdown for export. Returns AudioBuffer.
  async renderOffline(seq, fromSec, toSec, sampleRate = 48000, onProgress) {
    const dur = Math.max(0.05, toSec - fromSec);
    const ctx = new OfflineAudioContext(2, Math.ceil(dur * sampleRate), sampleRate);
    const out = ctx.createGain();
    out.gain.value = dbToGain(seq.masterVolume || 0);
    out.connect(ctx.destination);
    const saved = this.session;
    this.session = { sources: [] };
    this.scheduleSequence(ctx, seq, fromSec, 0, 1, out, toSec, 0, false);
    this.session = saved;
    onProgress && onProgress(0.5);
    return await ctx.startRendering();
  }
}

// Peak data for waveform drawing (per channel max abs at `rate` buckets/sec).
export function computePeaks(buffer, rate = 200) {
  const sr = buffer.sampleRate;
  const step = Math.max(1, Math.floor(sr / rate));
  const n = Math.ceil(buffer.length / step);
  const ch = Math.min(2, buffer.numberOfChannels);
  const peaks = [];
  for (let c = 0; c < ch; c++) {
    const d = buffer.getChannelData(c);
    const p = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let m = 0;
      const end = Math.min(d.length, (i + 1) * step);
      for (let j = i * step; j < end; j += 2) {
        const v = d[j] < 0 ? -d[j] : d[j];
        if (v > m) m = v;
      }
      p[i] = m;
    }
    peaks.push(p);
  }
  let max = 0;
  for (const p of peaks) for (let i = 0; i < p.length; i++) if (p[i] > max) max = p[i];
  return { rate: sr / step, peaks, max };
}

export const audio = new AudioEngine();
export { clamp, itemSourceDuration };
