// Keyframe interpolation. A param is { v, kf: null | [{t, v, interp}] } where
// t is in "clip keyframe time" (source seconds, see model.clipKfTime).

import { clamp, hexToRgb, rgbToHex } from './util.js';

export const KF_EPS = 1e-4;

function cubicBezier(x1, y1, x2, y2) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sx = (t) => ((ax * t + bx) * t + cx) * t;
  const sy = (t) => ((ay * t + by) * t + cy) * t;
  const dsx = (t) => (3 * ax * t + 2 * bx) * t + cx;
  return (x) => {
    let t = x;
    for (let i = 0; i < 8; i++) {
      const e = sx(t) - x;
      if (Math.abs(e) < 1e-6) break;
      const d = dsx(t);
      if (Math.abs(d) < 1e-6) break;
      t -= e / d;
    }
    t = clamp(t, 0, 1);
    return sy(t);
  };
}
const easeCache = new Map();
function easeFn(easeOut, easeIn) {
  const k = (easeOut ? 1 : 0) | (easeIn ? 2 : 0);
  if (!easeCache.has(k)) {
    easeCache.set(k, cubicBezier(easeOut ? 0.42 : 0.33, easeOut ? 0 : 0.33, easeIn ? 0.58 : 0.67, easeIn ? 1 : 0.67));
  }
  return easeCache.get(k);
}

export function isHoldType(def, v) {
  if (def && (def.type === 'enum' || def.type === 'bool' || def.type === 'text' || def.type === 'track' || def.type === 'curve' || def.type === 'file')) return true;
  if (typeof v === 'boolean') return true;
  if (typeof v === 'string' && !/^#[0-9a-f]{6}$/i.test(v)) return true;
  if (v && typeof v === 'object' && !Array.isArray(v)) return true;
  return false;
}

function mix(a, b, u, def) {
  if (isHoldType(def, a)) return a;
  if (typeof a === 'number') return a + (b - a) * u;
  if (Array.isArray(a)) return a.map((x, i) => (Array.isArray(x) ? mix(x, (b && b[i]) || x, u, null) : x + ((b?.[i] ?? x) - x) * u));
  if (typeof a === 'string') {
    const A = hexToRgb(a), B = hexToRgb(b);
    return rgbToHex([A[0] + (B[0] - A[0]) * u, A[1] + (B[1] - A[1]) * u, A[2] + (B[2] - A[2]) * u]);
  }
  return a;
}

function hermite(p0, p1, m0, m1, u) {
  const u2 = u * u, u3 = u2 * u;
  return (2 * u3 - 3 * u2 + 1) * p0 + (u3 - 2 * u2 + u) * m0 + (-2 * u3 + 3 * u2) * p1 + (u3 - u2) * m1;
}

export function evalParam(p, t, def) {
  if (!p) return def ? def.default : undefined;
  const kf = p.kf;
  if (!kf || !kf.length) return p.v;
  if (t <= kf[0].t) return kf[0].v;
  const last = kf[kf.length - 1];
  if (t >= last.t) return last.v;
  let i = 0;
  while (i < kf.length - 1 && kf[i + 1].t <= t) i++;
  const k0 = kf[i], k1 = kf[i + 1];
  if (k0.interp === 'hold' || isHoldType(def, k0.v)) return k0.v;
  let u = (t - k0.t) / Math.max(1e-9, k1.t - k0.t);
  const eo = k0.interp === 'bezier' || k0.interp === 'easeOut';
  const ei = k1.interp === 'bezier' || k1.interp === 'easeIn';
  if (eo || ei) u = easeFn(eo, ei)(u);
  else if (k0.interp === 'auto' && (typeof k0.v === 'number' || (Array.isArray(k0.v) && typeof k0.v[0] === 'number'))) {
    const km = kf[i - 1] || k0, k2 = kf[i + 2] || k1;
    const dt = k1.t - k0.t;
    const tan = (a, b, c, ta, tc, idx) => {
      const va = idx == null ? a.v : a.v[idx], vc = idx == null ? c.v : c.v[idx];
      return tc - ta > 1e-9 ? ((vc - va) / (tc - ta)) * dt : 0;
    };
    if (typeof k0.v === 'number') {
      return hermite(k0.v, k1.v, tan(km, k0, k1, km.t, k1.t), tan(k0, k1, k2, k0.t, k2.t), u);
    }
    return k0.v.map((_, idx) =>
      hermite(k0.v[idx], k1.v[idx], tan(km, k0, k1, km.t, k1.t, idx), tan(k0, k1, k2, k0.t, k2.t, idx), u),
    );
  }
  return mix(k0.v, k1.v, u, def);
}

export function isAnimated(p) {
  return !!(p && p.kf && p.kf.length);
}

export function findKeyframe(p, t, eps = KF_EPS) {
  if (!p || !p.kf) return -1;
  return p.kf.findIndex((k) => Math.abs(k.t - t) < eps);
}

export function sortKeyframes(p) {
  if (p.kf) p.kf.sort((a, b) => a.t - b.t);
}

export function addKeyframe(p, t, v, interp) {
  if (!p.kf) p.kf = [];
  const i = findKeyframe(p, t);
  const val = v === undefined ? evalParam(p, t) : v;
  if (i >= 0) p.kf[i].v = clone(val);
  else {
    const prev = [...p.kf].reverse().find((k) => k.t < t);
    p.kf.push({ t, v: clone(val), interp: interp || prev?.interp || 'linear' });
    sortKeyframes(p);
  }
}

export function removeKeyframeAt(p, t, eps = KF_EPS) {
  if (!p.kf) return;
  const i = findKeyframe(p, t, eps);
  if (i >= 0) {
    const v = p.kf[i].v;
    p.kf.splice(i, 1);
    if (!p.kf.length) {
      p.kf = null;
      p.v = v;
    }
  }
}

// Set param value at time t; adds/updates a keyframe when animated.
export function setParamValue(p, t, v) {
  if (isAnimated(p)) addKeyframe(p, t, v);
  else p.v = clone(v);
}

export function toggleAnimation(p, t, def) {
  if (isAnimated(p)) {
    p.v = clone(evalParam(p, t, def));
    p.kf = null;
  } else {
    p.kf = [{ t, v: clone(p.v), interp: isHoldType(def, p.v) ? 'hold' : 'linear' }];
  }
}

export function clone(v) {
  return Array.isArray(v) ? v.slice() : v && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v;
}
