// Sequence compositor (WebGL2). Renders a sequence frame into a canvas.

import { app } from '../core/app.js';
import { GLContext } from './gl.js';
import { EFFECT_HEADER, gaussianBlur, COPY_FS } from './effectKit.js';
import { getEffectDef, getTransitionDef } from '../core/registry.js';
import {
  findItem, clipKfTime, clipSourceTime, evalEffectParams, clipAtFrame, transitionRange, itemSourceDuration, timeRemapParam,
} from '../core/model.js';
import { evalParam } from '../core/keyframes.js';
import { framesToTC } from '../core/timecode.js';
import { sources } from './sources.js';
import { renderGraphic, graphicKey } from './graphics.js';
import { transitionUniforms } from './transitions.js';
import { hexToRgb, clamp } from '../core/util.js';
import './videoEffects.js';
import './lumetri.js';

const PLACE_FS = `uniform sampler2D u_src; uniform vec2 u_origin; uniform vec2 u_size; uniform int u_flipY;
void main(){ vec2 px = uv * u_res; vec2 q = (px - u_origin) / u_size;
  if (q.x < 0.0 || q.y < 0.0 || q.x > 1.0 || q.y > 1.0) { o = vec4(0.0); return; }
  if (u_flipY == 1) q.y = 1.0 - q.y; o = texture(u_src, q); }`;

const FILL_FS = `uniform vec4 u_col; uniform vec2 u_origin; uniform vec2 u_size;
void main(){ vec2 px = uv * u_res; vec2 q = (px - u_origin) / u_size; if (q.x < 0.0 || q.y < 0.0 || q.x > 1.0 || q.y > 1.0) { o = vec4(0.0); return; } o = u_col; }`;

const MOTION_FS = `uniform sampler2D u_src; uniform mat3 u_m; uniform vec2 u_buf; uniform float u_op;
void main(){ vec2 q = uv * u_res; vec2 b = (u_m * vec3(q, 1.0)).xy;
  vec2 fw = fwidth(b); float px = max(max(fw.x, fw.y), 1e-4);
  float d = min(min(b.x, b.y), min(u_buf.x - b.x, u_buf.y - b.y));
  float cov = clamp(d / px + 0.5, 0.0, 1.0);
  if (cov <= 0.0) { o = vec4(0.0); return; }
  o = texture(u_src, b / u_buf) * cov * u_op; }`;

const MASKMIX_FS = `uniform sampler2D u_a, u_b, u_m; uniform int u_mode;
void main(){ float m = texture(u_m, uv).r; vec4 a = texture(u_a, uv), b = texture(u_b, uv);
  if (u_mode == 1) { o = a * m; return; } o = mix(a, b, m); }`;

const MASKCOMB_FS = `uniform sampler2D u_acc, u_new; uniform int u_mode; uniform int u_inv; uniform int u_first;
void main(){ float a = u_first == 1 ? 0.0 : texture(u_acc, uv).r; float n = texture(u_new, uv).a; if (u_inv == 1) n = 1.0 - n;
  float r;
  if (u_mode == 0) r = min(1.0, a + n);
  else if (u_mode == 1) r = a * (1.0 - n);
  else if (u_mode == 2) r = u_first == 1 ? n : a * n;
  else if (u_mode == 3) r = max(a, n);
  else if (u_mode == 4) r = u_first == 1 ? n : min(a, n);
  else if (u_mode == 5) r = abs(a - n);
  else r = n;
  o = vec4(r, r, r, 1.0); }`;

const OVER_FS = `uniform sampler2D u_dst, u_src; void main(){ vec4 d = texture(u_dst, uv), s = texture(u_src, uv); o = s + d * (1.0 - s.a); }`;

const BLEND_FS = `uniform sampler2D u_dst, u_src; uniform int u_mode; uniform float u_seed;
float lm(vec3 c){ return dot(c, vec3(0.3, 0.59, 0.11)); }
vec3 clipColor(vec3 c){ float l = lm(c); float n = min(c.r, min(c.g, c.b)); float x = max(c.r, max(c.g, c.b));
  if (n < 0.0) c = l + (c - l) * l / max(l - n, 1e-5); if (x > 1.0) c = l + (c - l) * (1.0 - l) / max(x - l, 1e-5); return c; }
vec3 setLum(vec3 c, float l){ return clipColor(c + (l - lm(c))); }
float sat(vec3 c){ return max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b)); }
vec3 setSat(vec3 c, float s){ float mx = max(c.r, max(c.g, c.b)), mn = min(c.r, min(c.g, c.b)); return mx > mn ? (c - mn) * s / (mx - mn) : vec3(0.0); }
float burn(float b, float s){ if (b >= 1.0) return 1.0; if (s <= 0.0) return 0.0; return 1.0 - min(1.0, (1.0 - b) / s); }
float dodge(float b, float s){ if (b <= 0.0) return 0.0; if (s >= 1.0) return 1.0; return min(1.0, b / (1.0 - s)); }
float softl(float b, float s){ if (s <= 0.5) return b - (1.0 - 2.0 * s) * b * (1.0 - b); float d = b <= 0.25 ? ((16.0 * b - 12.0) * b + 4.0) * b : sqrt(b); return b + (2.0 * s - 1.0) * (d - b); }
float hardl(float b, float s){ return s <= 0.5 ? b * 2.0 * s : 1.0 - (1.0 - b) * (1.0 - (2.0 * s - 1.0)); }
float vivid(float b, float s){ return s <= 0.5 ? burn(b, 2.0 * s) : dodge(b, 2.0 * (s - 0.5)); }
vec3 blendF(vec3 b, vec3 s, int m){
  if (m <= 1) return s;
  if (m == 2) return min(b, s);
  if (m == 3) return b * s;
  if (m == 4) return vec3(burn(b.r, s.r), burn(b.g, s.g), burn(b.b, s.b));
  if (m == 5) return max(b + s - 1.0, 0.0);
  if (m == 6) return lm(s) < lm(b) ? s : b;
  if (m == 7) return max(b, s);
  if (m == 8) return b + s - b * s;
  if (m == 9) return vec3(dodge(b.r, s.r), dodge(b.g, s.g), dodge(b.b, s.b));
  if (m == 10) return min(b + s, 1.0);
  if (m == 11) return lm(s) > lm(b) ? s : b;
  if (m == 12) return vec3(hardl(s.r, b.r), hardl(s.g, b.g), hardl(s.b, b.b));
  if (m == 13) return vec3(softl(b.r, s.r), softl(b.g, s.g), softl(b.b, s.b));
  if (m == 14) return vec3(hardl(b.r, s.r), hardl(b.g, s.g), hardl(b.b, s.b));
  if (m == 15) return vec3(vivid(b.r, s.r), vivid(b.g, s.g), vivid(b.b, s.b));
  if (m == 16) return clamp(b + 2.0 * s - 1.0, 0.0, 1.0);
  if (m == 17) return mix(min(b, 2.0 * s), max(b, 2.0 * (s - 0.5)), step(0.5, s));
  if (m == 18) return step(1.0, b + s);
  if (m == 19) return abs(b - s);
  if (m == 20) return b + s - 2.0 * b * s;
  if (m == 21) return max(b - s, 0.0);
  if (m == 22) return vec3(s.r > 0.0 ? min(b.r / s.r, 1.0) : 1.0, s.g > 0.0 ? min(b.g / s.g, 1.0) : 1.0, s.b > 0.0 ? min(b.b / s.b, 1.0) : 1.0);
  if (m == 23) return setLum(setSat(s, sat(b)), lm(b));
  if (m == 24) return setLum(setSat(b, sat(s)), lm(b));
  if (m == 25) return setLum(s, lm(b));
  if (m == 26) return setLum(b, lm(s));
  return s;
}
void main(){ vec4 D = texture(u_dst, uv), S = texture(u_src, uv);
  if (u_mode == 1) { float r = hash12(uv * u_res + u_seed); S = (S.a > 0.0 && r < S.a) ? vec4(S.rgb / S.a, 1.0) : vec4(0.0); }
  vec3 cs = S.a > 0.0 ? S.rgb / S.a : vec3(0.0), cb = D.a > 0.0 ? D.rgb / D.a : vec3(0.0);
  vec3 B = blendF(cb, cs, u_mode);
  vec3 co = S.rgb * (1.0 - D.a) + D.rgb * (1.0 - S.a) + S.a * D.a * B;
  o = vec4(co, S.a + D.a * (1.0 - S.a)); }`;

const PRESENT_FS = `uniform sampler2D u_src; uniform int u_bg; uniform float u_check;
void main(){ vec2 q = vec2(uv.x, 1.0 - uv.y); vec4 c = texture(u_src, q);
  if (u_bg == 2) { o = c; return; }
  vec3 bg = vec3(0.0);
  if (u_bg == 1) { vec2 p = floor(gl_FragCoord.xy / u_check); bg = mod(p.x + p.y, 2.0) < 1.0 ? vec3(0.42) : vec3(0.32); }
  o = vec4(c.rgb + bg * (1.0 - c.a), 1.0); }`;

const DOWN_FS = `uniform sampler2D u_src; void main(){ vec4 c = texture(u_src, uv); o = vec4(c.rgb + vec3(0.0) * (1.0 - c.a), 1.0); }`;

function affineMul(A, B) {
  // [a,b,c,d,e,f] compose: A∘B
  return [A[0] * B[0] + A[1] * B[3], A[0] * B[1] + A[1] * B[4], A[0] * B[2] + A[1] * B[5] + A[2], A[3] * B[0] + A[4] * B[3], A[3] * B[1] + A[4] * B[4], A[3] * B[2] + A[4] * B[5] + A[5]];
}
const mat3 = (m) => [m[0], m[3], 0, m[1], m[4], 0, m[2], m[5], 1];

export function motionParams(clip, kfT) {
  const mfx = clip.effects.find((e) => e.type === 'motion');
  if (!mfx) return null;
  return evalEffectParams(mfx, kfT);
}

// Forward affine: clip px -> sequence px.
export function motionMatrix(m, fit = 1) {
  const sy = (m.scale / 100) * fit;
  const sx = ((m.uniformScale ? m.scale : m.scaleWidth) / 100) * fit;
  const r = (m.rotation * Math.PI) / 180;
  const cs = Math.cos(r), sn = Math.sin(r);
  const a = cs * sx, b = -sn * sy, d = sn * sx, e = cs * sy;
  const ax = m.anchor[0], ay = m.anchor[1];
  return [a, b, m.position[0] - (a * ax + b * ay), d, e, m.position[1] - (d * ax + e * ay)];
}

export function invertAffine(m) {
  const [a, b, c, d, e, f] = m;
  const det = a * e - b * d || 1e-9;
  const ia = e / det, ib = -b / det, id = -d / det, ie = a / det;
  return [ia, ib, -(ia * c + ib * f), id, ie, -(id * c + ie * f)];
}

// Source time with time effects (Posterize Time) applied.
export function effectiveSourceTime(project, clip, frame, fps) {
  const item = clip.itemId ? findItem(project, clip.itemId) : null;
  let f = frame;
  for (const fx of clip.effects) {
    if (fx.enabled === false) continue;
    const def = getEffectDef(fx.type);
    if (def && def.timeMap) {
      const p = evalEffectParams(fx, clipKfTime(clip, frame, fps));
      const local = (f - clip.start) / fps;
      f = clip.start + def.timeMap(local, p) * fps;
    }
  }
  return clipSourceTime(clip, f, fps, item ? itemSourceDuration(project, item) : 0);
}

export function clipSourceDims(project, clip, seq) {
  if (clip.graphic) return [seq.settings.width, seq.settings.height];
  const item = findItem(project, clip.itemId);
  if (!item) return [seq.settings.width, seq.settings.height];
  if (item.type === 'sequence') return [item.settings.width, item.settings.height];
  if (item.type === 'synthetic') return [item.width || seq.settings.width, item.height || seq.settings.height];
  return [item.width || seq.settings.width, item.height || seq.settings.height];
}

export function clipFit(project, clip, seq) {
  const [w, h] = clipSourceDims(project, clip, seq);
  if (!clip.scaleToFrame) return 1;
  return Math.min(seq.settings.width / w, seq.settings.height / h);
}

// Clips active on a track at a frame (including transition partners).
export function activeTrackClips(track, frame) {
  for (const tr of track.transitions) {
    const r = transitionRange(track, tr);
    if (frame >= r.start && frame < r.end) return { transition: tr, range: r, clips: [r.a, r.b].filter(Boolean) };
  }
  const c = clipAtFrame(track, frame);
  return c ? { clips: [c] } : null;
}

export class Compositor {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 16;
    this.canvas.height = 16;
    this.gl = new GLContext(this.canvas);
    this.srcTex = new Map(); // key -> {tex, stamp}
    this.dataTex = new Map();
    this.lutTex = new Map();
    this.maskCache = new Map();
    this.canvasCache = new Map(); // key -> {canvas, tex, stamp}
    this.wantScopes = false;
    this.scopeData = null;
    this.lastError = null;
  }

  // ---- cached helpers ----
  detach(t) {
    this.gl.live.delete(t);
    return t;
  }
  reattach(t) {
    if (t) this.gl.pool.push(t);
  }

  dataTexture(key, builder) {
    let e = this.dataTex.get(key);
    if (!e) {
      const { data, W, H } = builder();
      const tex = this.gl.createTexture();
      this.gl.uploadData(tex, W, H, data, { filter: 'linear' });
      e = { tex };
      this.dataTex.set(key, e);
      if (this.dataTex.size > 32) {
        const [k0, v0] = this.dataTex.entries().next().value;
        this.gl.gl.deleteTexture(v0.tex);
        this.dataTex.delete(k0);
      }
    }
    return e.tex;
  }

  lutTexture(id) {
    if (this.lutTex.has(id)) return this.lutTex.get(id);
    const L = app.project.luts?.[id];
    if (!L) return null;
    const bin = atob(L.data);
    const data = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
    const tex = this.gl.create3DTexture(L.size, data);
    const e = { tex, size: L.size };
    this.lutTex.set(id, e);
    return e;
  }

  canvasTexture(key, stamp, draw) {
    let e = this.canvasCache.get(key);
    if (!e) {
      e = { canvas: document.createElement('canvas'), tex: this.gl.createTexture(), stamp: null };
      this.canvasCache.set(key, e);
      if (this.canvasCache.size > 64) {
        const [k0, v0] = this.canvasCache.entries().next().value;
        this.gl.gl.deleteTexture(v0.tex);
        this.canvasCache.delete(k0);
      }
    }
    if (e.stamp !== stamp) {
      draw(e.canvas);
      this.gl.upload(e.tex, e.canvas);
      e.stamp = stamp;
    }
    return e;
  }

  uploadSource(key, source, stamp) {
    let e = this.srcTex.get(key);
    if (!e) {
      e = { tex: this.gl.createTexture(), stamp: null };
      this.srcTex.set(key, e);
    }
    if (stamp == null || e.stamp !== stamp) {
      if (this.gl.upload(e.tex, source)) e.stamp = stamp;
    }
    return e.tex;
  }

  // ---- seeking / preparation ----
  collectNeeds(seq, frame, prefix = '', out = [], depth = 0) {
    if (depth > 6) return out;
    const project = app.project;
    const fps = seq.settings.fps;
    for (const track of seq.videoTracks) {
      const act = activeTrackClips(track, frame);
      if (!act) continue;
      for (const clip of act.clips) {
        if (!clip.enabled || !clip.itemId) continue;
        const item = findItem(project, clip.itemId);
        if (!item) continue;
        if (item.type === 'media' && item.kind === 'video' && !item.offline) {
          const rp = timeRemapParam(clip);
          const speed = rp ? Math.max(0.0625, evalParam(rp, clipKfTime(clip, frame, fps)) / 100) : clip.speed;
          out.push({ key: prefix + clip.id, item, t: effectiveSourceTime(project, clip, frame, fps), clip, speed, reverse: clip.reverse || clip.frameHold != null || (rp && evalParam(rp, clipKfTime(clip, frame, fps)) <= 0) });
        } else if (item.type === 'sequence') {
          const t = effectiveSourceTime(project, clip, frame, fps);
          this.collectNeeds(item, Math.floor(t * item.settings.fps + 1e-6), prefix + clip.id + '/', out, depth + 1);
        }
      }
    }
    return out;
  }

  async prepare(seq, frame) {
    if (!seq) return;
    const needs = this.collectNeeds(seq, frame);
    const ps = [];
    for (const n of needs) {
      const e = sources.videoEntry(n.key, n.item);
      if (!e) continue;
      if (!e.el.paused) e.el.pause();
      ps.push(sources.seek(e, n.t + 0.0001));
    }
    // Images
    this.collectImages(seq, frame);
    await Promise.all(ps);
  }

  collectImages(seq, frame) {
    for (const track of seq.videoTracks) {
      const act = activeTrackClips(track, frame);
      if (!act) continue;
      for (const clip of act.clips) {
        const item = clip.itemId ? findItem(app.project, clip.itemId) : null;
        if (item && item.type === 'media' && item.kind === 'image') sources.image(item);
      }
    }
  }

  // Keep video elements running during playback.
  syncPlayback(seq, frame, rate) {
    const fps = seq.settings.fps;
    const needs = this.collectNeeds(seq, frame);
    const keep = new Set();
    for (const n of needs) {
      const e = sources.videoEntry(n.key, n.item);
      if (!e) continue;
      keep.add(n.key);
      const el = e.el;
      const canPlay = rate > 0 && rate <= 8 && !n.reverse;
      if (canPlay) {
        const pr = clamp(n.speed * rate, 0.0625, 16);
        if (Math.abs(el.playbackRate - pr) > 1e-3) el.playbackRate = pr;
        const drift = el.currentTime - n.t;
        if (el.paused) {
          if (Math.abs(drift) > 0.04) el.currentTime = n.t;
          const p = el.play();
          if (p) p.catch(() => {});
        } else if (Math.abs(drift) > 0.3 * Math.max(1, rate) && !el.seeking) {
          el.currentTime = n.t + 0.05 * rate;
        }
      } else {
        if (!el.paused) el.pause();
        if (!el.seeking && Math.abs(el.currentTime - n.t) > 0.5 / fps) el.currentTime = n.t;
      }
    }
    // Preroll upcoming clips
    if (rate > 0) {
      const ahead = this.collectNeeds(seq, frame + Math.round(fps * 0.75 * Math.max(1, rate)));
      for (const n of ahead) {
        if (keep.has(n.key)) continue;
        const e = sources.videoEntry(n.key, n.item);
        if (!e) continue;
        keep.add(n.key);
        if (!e.el.paused) e.el.pause();
        const startT = effectiveSourceTime(app.project, n.clip, Math.max(frame, n.clip.start), fps);
        if (!e.el.seeking && Math.abs(e.el.currentTime - startT) > 0.05) e.el.currentTime = startT;
      }
    }
    sources.pauseAll(keep);
  }

  stopPlayback() {
    sources.pauseAll();
  }

  // ---- rendering ----
  renderSequence(seq, frame, scale, depth = 0) {
    const gl = this.gl;
    const W = Math.max(1, Math.round(seq.settings.width * scale));
    const H = Math.max(1, Math.round(seq.settings.height * scale));
    let accum = gl.target(W, H);
    gl.clear(accum);
    if (depth > 6) return accum;
    const state = { seq, frame, scale, W, H, depth, trackCache: new Map(), prefix: this._prefix || '' };
    for (let ti = 0; ti < seq.videoTracks.length; ti++) {
      const track = seq.videoTracks[ti];
      if (track.hidden) continue;
      const items = this.renderTrack(state, ti, accum);
      if (!items) continue;
      const blended = this.blend(accum, items.layer, items.blend);
      gl.release(accum);
      gl.release(items.layer);
      accum = blended;
    }
    return accum;
  }

  blend(dst, src, mode = 0) {
    const gl = this.gl;
    const out = gl.target(dst.w, dst.h);
    if (!mode) gl.pass(gl.program('over', OVER_FS), { u_dst: dst, u_src: src }, out);
    else gl.pass(gl.program('blend', BLEND_FS), { u_dst: dst, u_src: src, u_mode: mode, u_seed: Math.random() * 100 }, out);
    return out;
  }

  renderTrack(state, ti, accum) {
    const { seq, frame } = state;
    const track = seq.videoTracks[ti];
    const act = activeTrackClips(track, frame);
    if (!act) return null;
    const gl = this.gl;
    if (act.transition) {
      const tr = act.transition;
      const def = getTransitionDef(tr.type);
      const a = act.range.a && act.range.a.enabled ? this.renderClip(state, track, act.range.a, accum) : null;
      const b = act.range.b && act.range.b.enabled ? this.renderClip(state, track, act.range.b, accum) : null;
      if (!def || !def.fs) {
        if (a) gl.release(a.layer);
        return b || null;
      }
      const p = {};
      for (const pd of def.params || []) p[pd.id] = tr.params[pd.id] ? tr.params[pd.id].v : pd.default;
      let t = (frame - act.range.start + 0.5) / tr.dur;
      t = clamp(t, 0, 1);
      let prog = (p.start ?? 0) / 100 + ((p.end ?? 100) / 100 - (p.start ?? 0) / 100) * t;
      let ta = a ? a.layer : null, tb = b ? b.layer : null;
      if (p.reverse) {
        [ta, tb] = [tb, ta];
        prog = 1 - prog;
      }
      const out = gl.target(state.W, state.H);
      try {
        gl.pass(gl.program('tr:' + def.id, def.fs), Object.assign({ u_a: ta, u_b: tb, u_p: prog }, transitionUniforms(def, p)), out);
      } catch (err) {
        this.lastError = err;
        console.error(err);
      }
      if (a) gl.release(a.layer);
      if (b) gl.release(b.layer);
      return { layer: out, blend: b ? b.blend : 0 };
    }
    const clip = act.clips[0];
    if (!clip.enabled) return null;
    return this.renderClip(state, track, clip, accum);
  }

  trackLayer(state, trackNumber) {
    const ti = trackNumber - 1;
    if (ti < 0 || ti >= state.seq.videoTracks.length) return null;
    if (state.trackCache.has(ti)) return state.trackCache.get(ti);
    if (state.matteDepth > 2) return null;
    state.matteDepth = (state.matteDepth || 0) + 1;
    state.trackCache.set(ti, null);
    const r = this.renderTrack(state, ti, null);
    state.matteDepth--;
    const layer = r ? r.layer : null;
    state.trackCache.set(ti, layer);
    return layer;
  }

  renderClip(state, track, clip, accum) {
    const gl = this.gl;
    const project = app.project;
    const { seq, frame, scale, W, H } = state;
    const fps = seq.settings.fps;
    const item = clip.itemId ? findItem(project, clip.itemId) : null;
    const kfT = clipKfTime(clip, frame, fps);
    const localSec = (frame - clip.start) / fps;
    const isAdjustment = item && item.type === 'synthetic' && item.kind === 'adjustment';
    if (isAdjustment && !accum) return null;
    const m = motionParams(clip, kfT) || { position: [seq.settings.width / 2, seq.settings.height / 2], scale: 100, scaleWidth: 100, uniformScale: true, rotation: 0, anchor: [0, 0] };
    const opFx = clip.effects.find((e) => e.type === 'opacity');
    const op = opFx ? evalEffectParams(opFx, kfT) : { opacity: 100, blendMode: 0 };
    if (op.opacity <= 0) return null;

    let [clipW, clipH] = isAdjustment ? [seq.settings.width, seq.settings.height] : clipSourceDims(project, clip, seq);
    const fit = isAdjustment ? 1 : clipFit(project, clip, seq);
    const sx = Math.abs(((m.uniformScale ? m.scale : m.scaleWidth) / 100) * fit), sy = Math.abs((m.scale / 100) * fit);
    if (sx < 1e-4 || sy < 1e-4) return null;
    let k = scale * clamp(Math.max(sx, sy), 0.05, 1);
    if (isAdjustment) k = scale;

    const fxList = clip.effects.filter((e) => e.enabled !== false && !getEffectDef(e.type)?.intrinsic && getEffectDef(e.type));
    const evaluated = fxList.map((fx) => ({ fx, def: getEffectDef(fx.type), p: evalEffectParams(fx, kfT) }));
    let pad = 0;
    for (const e of evaluated) if (e.def.expand) pad += Math.max(0, e.def.expand(e.p, { w: clipW, h: clipH }) || 0);
    pad = Math.min(Math.ceil(pad), 2500);
    if (isAdjustment) pad = 0;
    let bw = Math.ceil((clipW + pad * 2) * k), bh = Math.ceil((clipH + pad * 2) * k);
    const maxDim = 4096;
    if (bw > maxDim || bh > maxDim) {
      const f = maxDim / Math.max(bw, bh);
      k *= f;
      bw = Math.ceil((clipW + pad * 2) * k);
      bh = Math.ceil((clipH + pad * 2) * k);
    }
    const origin = [pad * k, pad * k];
    const size = [clipW * k, clipH * k];

    // 1. Source into clip buffer
    let buf = gl.target(bw, bh);
    const srcT = effectiveSourceTime(project, clip, frame, fps);
    const placed = this.placeSource(state, clip, item, buf, origin, size, k, srcT, accum, isAdjustment);
    if (!placed) gl.clear(buf);

    // 2. Effects
    const fwd = motionMatrix(m, fit);
    const ctxBase = {
      gl, k, origin, clipW, clipH, time: localSec, frame, fps, seqW: seq.settings.width, seqH: seq.settings.height,
      seqTime: frame / fps, sourceTime: srcT, fwd,
      names: [clip.name, item ? item.name : clip.name, item ? item.name : clip.name],
      tc: (f) => framesToTC(f, fps),
      dataTexture: (key, b) => this.dataTexture(key, b),
      lut: (id) => this.lutTexture(id),
      trackLayer: (n) => this.trackLayer(state, n),
    };
    for (const { fx, def, p } of evaluated) {
      const input = buf;
      const ctx = Object.assign({}, ctxBase, {
        input, w: bw, h: bh, p, effect: fx, clip,
        run: (key, fs, uniforms = {}, inp = input) => {
          const out = gl.target(bw, bh);
          gl.pass(gl.program('fx:' + key, EFFECT_HEADER + fs), Object.assign({ u_tex: inp, u_origin: origin, u_k: k, u_clip: [clipW, clipH], u_time: localSec }, uniforms), out);
          return out;
        },
      });
      ctx.textOverlay = (opts) => this.textOverlay(ctx, opts);
      let out;
      try {
        out = def.render(ctx) || input;
      } catch (err) {
        if (this.lastError?.message !== err.message) console.error('Effect error', def.id, err);
        this.lastError = err;
        out = input;
      }
      if (out !== input && fx.masks && fx.masks.length) {
        const mask = this.maskTexture(fx, kfT, bw, bh, k, origin);
        if (mask) {
          const mixed = gl.target(bw, bh);
          gl.pass(gl.program('maskmix', MASKMIX_FS), { u_a: input, u_b: out, u_m: mask, u_mode: 0 }, mixed);
          gl.release(out);
          out = mixed;
        }
      }
      if (out !== input) gl.release(input);
      buf = out;
    }

    // 3. Opacity masks
    if (opFx && opFx.masks && opFx.masks.length) {
      const mask = this.maskTexture(opFx, kfT, bw, bh, k, origin);
      if (mask) {
        const out = gl.target(bw, bh);
        gl.pass(gl.program('maskmix', MASKMIX_FS), { u_a: buf, u_b: buf, u_m: mask, u_mode: 1 }, out);
        gl.release(buf);
        buf = out;
      }
    }

    // 4. Motion into sequence space
    // q (scaled seq px) -> P = q/scale -> clip px c = inv(fwd) P -> buffer b = c*k + origin
    const inv = invertAffine(fwd);
    const toBuf = [k, 0, origin[0], 0, k, origin[1]];
    const M = affineMul(toBuf, affineMul(inv, [1 / scale, 0, 0, 0, 1 / scale, 0]));
    const layer = gl.target(W, H);
    const shrink = (scale * Math.max(sx, sy)) / k;
    if (shrink < 0.55) gl.mipmap(buf);
    gl.pass(gl.program('motion', MOTION_FS), { u_src: buf, u_m: mat3(M), u_buf: [bw, bh], u_op: op.opacity / 100 }, layer);
    gl.release(buf);
    return { layer, blend: op.blendMode || 0 };
  }

  placeSource(state, clip, item, buf, origin, size, k, srcT, accum, isAdjustment) {
    const gl = this.gl;
    const place = (tex, flipY = 0) => {
      gl.pass(gl.program('place', PLACE_FS), { u_src: tex, u_origin: origin, u_size: size, u_flipY: flipY }, buf);
      return true;
    };
    const fill = (rgba) => {
      gl.pass(gl.program('fill', FILL_FS), { u_col: rgba, u_origin: origin, u_size: size }, buf);
      return true;
    };
    const seq = state.seq;
    if (isAdjustment) return place(accum);
    if (clip.graphic) {
      const key = 'g:' + state.prefix + clip.id;
      const kfT = clipKfTime(clip, state.frame, seq.settings.fps);
      const w = Math.max(1, Math.round(size[0])), h = Math.max(1, Math.round(size[1]));
      const stamp = graphicKey(clip.graphic, kfT) + '|' + w + 'x' + h + '|' + (app.fontStamp || 0);
      const e = this.canvasTexture(key, stamp, (cv) => renderGraphic(cv, clip.graphic, kfT, w, h, k));
      return place(e.tex);
    }
    if (!item) return false;
    if (item.type === 'media') {
      if (item.offline || !app.rt(item.id).url) return place(this.offlineTexture());
      if (item.kind === 'image') {
        const img = sources.image(item);
        if (!img) return false;
        return place(this.uploadSource('img:' + item.id, img, app.rt(item.id).url));
      }
      if (item.kind === 'video') {
        const key = state.prefix + clip.id;
        const e = sources.videoEntry(key, item);
        if (!e || e.el.readyState < 2) {
          const last = this.srcTex.get('v:' + key);
          return last && last.stamp != null ? place(last.tex) : false;
        }
        const tex = this.uploadSource('v:' + key, e.el, null);
        this.srcTex.get('v:' + key).stamp = 1;
        return place(tex);
      }
      return false;
    }
    if (item.type === 'sequence') {
      const nf = Math.floor(srcT * item.settings.fps + 1e-6);
      const prevPrefix = this._prefix;
      this._prefix = state.prefix + clip.id + '/';
      const nested = this.renderSequence(item, nf, k, state.depth + 1);
      this._prefix = prevPrefix;
      place(nested);
      gl.release(nested);
      return true;
    }
    if (item.type === 'synthetic') {
      switch (item.kind) {
        case 'colormatte': {
          const c = hexToRgb(item.color);
          return fill([c[0], c[1], c[2], 1]);
        }
        case 'black':
          return fill([0, 0, 0, 1]);
        case 'transparent':
          return false;
        case 'bars': {
          const e = this.canvasTexture('bars:' + item.id, 'v1', (cv) => drawBars(cv, item.width, item.height));
          return place(e.tex);
        }
        case 'leader': {
          const fr = Math.floor(srcT * 24);
          const e = this.canvasTexture('leader:' + item.id, fr, (cv) => drawLeader(cv, item, srcT));
          return place(e.tex);
        }
        default:
          return false;
      }
    }
    return false;
  }

  offlineTexture() {
    const e = this.canvasTexture('offline', 'v1', (cv) => {
      cv.width = 640;
      cv.height = 360;
      const c = cv.getContext('2d');
      c.fillStyle = '#c4141a';
      c.fillRect(0, 0, 640, 360);
      c.fillStyle = '#fff';
      c.font = 'bold 34px Arial';
      c.textAlign = 'center';
      c.fillText('Media offline', 320, 170);
      c.font = '18px Arial';
      c.fillText('File > Link Media to relink', 320, 205);
    });
    return e.tex;
  }

  textOverlay(ctx, opts) {
    const gl = this.gl;
    const w = ctx.w, h = ctx.h;
    const stamp = JSON.stringify([opts, w, h]);
    const e = this.canvasTexture('txt:' + ctx.effect.id, stamp, (cv) => {
      cv.width = w;
      cv.height = h;
      const c = cv.getContext('2d');
      c.clearRect(0, 0, w, h);
      const fs = Math.max(6, (opts.size / 100) * ctx.clipH * 0.45 * ctx.k);
      c.font = `${opts.mono ? '' : 'bold '}${fs}px ${opts.mono ? '"Roboto Mono", "Courier New", monospace' : 'Arial, sans-serif'}`;
      const tw = c.measureText(opts.text).width;
      const x = opts.pos[0] * ctx.k + ctx.origin[0];
      const y = opts.pos[1] * ctx.k + ctx.origin[1];
      const left = opts.align === 0 ? x : opts.align === 2 ? x - tw : x - tw / 2;
      if (opts.box > 0) {
        c.fillStyle = `rgba(0,0,0,${opts.box})`;
        c.fillRect(left - fs * 0.3, y - fs * 0.85, tw + fs * 0.6, fs * 1.2);
      }
      c.fillStyle = '#fff';
      c.textBaseline = 'alphabetic';
      c.fillText(opts.text, left, y);
    });
    return ctx.run('textover', `uniform sampler2D u_ov; void main(){ vec4 d = tex(uv*u_res); vec4 s = texture(u_ov, uv); o = s + d * (1.0 - s.a); }`, { u_ov: e.tex });
  }

  maskTexture(fx, kfT, bw, bh, k, origin) {
    const gl = this.gl;
    const masks = fx.masks;
    const evals = masks.map((mk) => ({
      shape: mk.shape,
      path: evalParam(mk.path, kfT),
      feather: evalParam(mk.feather, kfT),
      opacity: evalParam(mk.opacity, kfT),
      expansion: evalParam(mk.expansion, kfT),
      inverted: mk.inverted,
      mode: mk.mode,
      closed: mk.closed,
      smooth: mk.smooth,
    }));
    const key = JSON.stringify([evals, bw, bh, k, origin]);
    const cached = this.maskCache.get(fx.id);
    if (cached && cached.key === key) return cached.target;
    if (cached) this.reattach(cached.target);
    const modeIdx = { add: 0, subtract: 1, intersect: 2, lighten: 3, darken: 4, difference: 5, none: 6 };
    let acc = gl.target(bw, bh, { format: 'rgba8' });
    gl.clear(acc, [0, 0, 0, 1]);
    let first = true;
    const cv = this._maskCanvas || (this._maskCanvas = document.createElement('canvas'));
    const tex = this._maskTex || (this._maskTex = gl.createTexture());
    for (const mk of evals) {
      if (mk.mode === 'none') continue;
      cv.width = bw;
      cv.height = bh;
      const c = cv.getContext('2d');
      c.clearRect(0, 0, bw, bh);
      c.setTransform(k, 0, 0, k, origin[0], origin[1]);
      tracePath(c, mk);
      c.fillStyle = `rgba(255,255,255,${clamp(mk.opacity / 100, 0, 1)})`;
      if (mk.closed !== false) c.fill();
      if (mk.expansion) {
        c.lineJoin = 'round';
        c.lineWidth = Math.abs(mk.expansion) * 2;
        if (mk.expansion > 0) {
          c.strokeStyle = c.fillStyle;
          c.stroke();
        } else {
          c.globalCompositeOperation = 'destination-out';
          c.strokeStyle = '#fff';
          c.stroke();
          c.globalCompositeOperation = 'source-over';
        }
      }
      gl.upload(tex, cv);
      let src = { tex, w: bw, h: bh };
      let blurred = null;
      if (mk.feather > 0.01) {
        blurred = gaussianBlur(gl, src, mk.feather * k * 0.5, mk.feather * k * 0.5);
        src = blurred;
      }
      const next = gl.target(bw, bh, { format: 'rgba8' });
      gl.pass(gl.program('maskcomb', MASKCOMB_FS), { u_acc: acc, u_new: src, u_mode: modeIdx[mk.mode] ?? 0, u_inv: mk.inverted ? 1 : 0, u_first: first ? 1 : 0 }, next);
      first = false;
      gl.release(acc);
      if (blurred) gl.release(blurred);
      acc = next;
    }
    if (first) {
      gl.release(acc);
      return null;
    }
    this.detach(acc);
    this.maskCache.set(fx.id, { key, target: acc });
    return acc;
  }

  // Render a full frame of `seq` into this.canvas. Returns the canvas.
  renderFrame(seq, frame, opts = {}) {
    const gl = this.gl;
    if (gl.lost) return this.canvas;
    const scale = opts.scale ?? 1;
    const W = Math.max(1, Math.round(seq.settings.width * scale));
    const H = Math.max(1, Math.round(seq.settings.height * scale));
    if (this.canvas.width !== W || this.canvas.height !== H) {
      this.canvas.width = W;
      this.canvas.height = H;
    }
    this._prefix = '';
    let out;
    try {
      out = this.renderSequence(seq, frame, scale, 0);
      if (opts.captions !== false && seq.captions && seq.captions.length && opts.captionTrack !== false) {
        const cap = seq.captions.find((c) => frame >= c.start && frame < c.end);
        if (cap) {
          const e = this.canvasTexture('caption', JSON.stringify([cap.text, seq.captionStyle, W, H]), (cv) => drawCaption(cv, cap.text, seq.captionStyle, W, H, scale));
          const o2 = gl.target(W, H);
          gl.pass(gl.program('over', OVER_FS), { u_dst: out, u_src: e.tex }, o2);
          gl.release(out);
          out = o2;
        }
      }
      gl.pass(gl.program('present', PRESENT_FS), { u_src: out, u_bg: opts.background ?? 0, u_check: Math.max(4, 10 * scale) }, null);
      if (this.wantScopes && opts.scopes !== false) {
        const sw = Math.min(W, 256), sh = Math.max(1, Math.round((sw * H) / W));
        const small = gl.target(sw, sh, { format: 'rgba8' });
        gl.pass(gl.program('down', DOWN_FS), { u_src: out }, small);
        this.scopeData = { w: sw, h: sh, data: gl.readPixels(small, sw, sh) };
        gl.release(small);
      }
    } catch (err) {
      console.error(err);
      this.lastError = err;
    }
    gl.releaseAll();
    return this.canvas;
  }

  // Render a single clip's source frame (for thumbnails/source monitor of sequences).
  invalidate(itemOrClipId) {
    for (const k of [...this.canvasCache.keys()]) if (k.includes(itemOrClipId)) this.canvasCache.delete(k);
  }
}

export function tracePath(c, mk) {
  const pts = mk.path || [];
  c.beginPath();
  if (!pts.length) return;
  if (mk.shape === 'ellipse' && pts.length === 4) {
    const cx = (pts[0][0] + pts[1][0] + pts[2][0] + pts[3][0]) / 4;
    const cy = (pts[0][1] + pts[1][1] + pts[2][1] + pts[3][1]) / 4;
    const K = 0.5523;
    c.moveTo(pts[0][0], pts[0][1]);
    for (let i = 0; i < 4; i++) {
      const p0 = pts[i], p1 = pts[(i + 1) % 4];
      c.bezierCurveTo(p0[0] + (p1[0] - cx) * K, p0[1] + (p1[1] - cy) * K, p1[0] + (p0[0] - cx) * K, p1[1] + (p0[1] - cy) * K, p1[0], p1[1]);
    }
    c.closePath();
    return;
  }
  if (mk.smooth && pts.length > 2) {
    const n = pts.length;
    const closed = mk.closed !== false;
    c.moveTo(pts[0][0], pts[0][1]);
    const segs = closed ? n : n - 1;
    for (let i = 0; i < segs; i++) {
      const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
      const a = !closed && i === 0 ? p1 : p0, d = !closed && i === n - 2 ? p2 : p3;
      c.bezierCurveTo(p1[0] + (p2[0] - a[0]) / 6, p1[1] + (p2[1] - a[1]) / 6, p2[0] - (d[0] - p1[0]) / 6, p2[1] - (d[1] - p1[1]) / 6, p2[0], p2[1]);
    }
    if (closed) c.closePath();
    return;
  }
  c.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) c.lineTo(pts[i][0], pts[i][1]);
  if (mk.closed !== false) c.closePath();
}

function drawBars(cv, W, H) {
  cv.width = W;
  cv.height = H;
  const c = cv.getContext('2d');
  const top = ['#c0c0c0', '#c0c000', '#00c0c0', '#00c000', '#c000c0', '#c00000', '#0000c0'];
  const mid = ['#0000c0', '#131313', '#c000c0', '#131313', '#00c0c0', '#131313', '#c0c0c0'];
  const bw = W / 7;
  top.forEach((col, i) => {
    c.fillStyle = col;
    c.fillRect(Math.floor(i * bw), 0, Math.ceil(bw) + 1, H * 0.67);
  });
  mid.forEach((col, i) => {
    c.fillStyle = col;
    c.fillRect(Math.floor(i * bw), H * 0.67, Math.ceil(bw) + 1, H * 0.08);
  });
  const low = [['#00214c', 1.25], ['#ffffff', 1.25], ['#32006a', 1.25], ['#131313', 1.25], ['#090909', bw / bw / 3], ['#131313', 1 / 3], ['#1d1d1d', 1 / 3], ['#131313', 1]];
  let x = 0;
  for (const [col, wmul] of low) {
    c.fillStyle = col;
    c.fillRect(Math.floor(x), H * 0.75, Math.ceil(bw * wmul) + 1, H * 0.25);
    x += bw * wmul;
  }
}

function drawLeader(cv, item, t) {
  const W = item.width, H = item.height;
  if (cv.width !== W) cv.width = W;
  if (cv.height !== H) cv.height = H;
  const c = cv.getContext('2d');
  const sec = Math.floor(t);
  const frac = t - sec;
  const num = 8 - sec + 1;
  if (num < 2) {
    c.fillStyle = '#000';
    c.fillRect(0, 0, W, H);
    return;
  }
  c.fillStyle = '#7a7a7a';
  c.fillRect(0, 0, W, H);
  const cx = W / 2, cy = H / 2, R = H * 0.42;
  c.fillStyle = '#9a9a9a';
  c.beginPath();
  c.moveTo(cx, cy);
  c.arc(cx, cy, R * 1.6, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
  c.closePath();
  c.fill();
  c.strokeStyle = '#e8e8e8';
  c.lineWidth = H * 0.008;
  c.beginPath();
  c.arc(cx, cy, R, 0, Math.PI * 2);
  c.stroke();
  c.beginPath();
  c.arc(cx, cy, R * 0.85, 0, Math.PI * 2);
  c.stroke();
  c.beginPath();
  c.moveTo(0, cy);
  c.lineTo(W, cy);
  c.moveTo(cx, 0);
  c.lineTo(cx, H);
  c.stroke();
  c.fillStyle = '#111';
  c.font = `bold ${H * 0.55}px Arial`;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText(String(num), cx, cy + H * 0.03);
}

export function drawCaption(cv, text, style, W, H, scale) {
  cv.width = W;
  cv.height = H;
  const c = cv.getContext('2d');
  c.clearRect(0, 0, W, H);
  const fs = (style.size || 46) * scale;
  c.font = `${fs}px "${style.font || 'Arial'}", Arial, sans-serif`;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  const lines = String(text).split('\n');
  const lh = fs * 1.25;
  const total = lh * lines.length;
  const cy = style.position === 'top' ? H * 0.1 + total / 2 : style.position === 'middle' ? H / 2 : H * 0.9 - total / 2;
  lines.forEach((line, i) => {
    const y = cy - total / 2 + lh * (i + 0.5);
    const w = c.measureText(line).width;
    const [r, g, b] = hexToRgb(style.bg || '#000000');
    c.fillStyle = `rgba(${r * 255},${g * 255},${b * 255},${(style.bgOpacity ?? 70) / 100})`;
    if ((style.bgOpacity ?? 70) > 0 && line) c.fillRect(W / 2 - w / 2 - fs * 0.35, y - lh / 2, w + fs * 0.7, lh);
    c.fillStyle = style.color || '#fff';
    c.fillText(line, W / 2, y);
  });
}

export { COPY_FS };
