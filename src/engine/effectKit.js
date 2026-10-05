// Shared helpers for writing GPU effects: param builders, standard header, blur.

export const EFFECT_HEADER = `
uniform sampler2D u_tex;
uniform vec2 u_origin;
uniform float u_k;
uniform vec2 u_clip;
uniform float u_time;
vec2 toClip(vec2 px){ return (px - u_origin) / u_k; }
vec2 toBuf(vec2 c){ return c * u_k + u_origin; }
vec4 tex(vec2 px){ return texture(u_tex, px / u_res); }
vec4 texc(vec2 c){ return texture(u_tex, toBuf(c) / u_res); }
bool inClip(vec2 c){ return c.x >= 0.0 && c.y >= 0.0 && c.x <= u_clip.x && c.y <= u_clip.y; }
`;

// ---- param builders ----
export const P = {
  num: (id, name, def, min, max, o = {}) => ({ id, name, type: 'number', default: def, min, max, step: 0.1, ...o }),
  int: (id, name, def, min, max, o = {}) => ({ id, name, type: 'number', default: def, min, max, step: 1, precision: 0, ...o }),
  pct: (id, name, def, min = 0, max = 100, o = {}) => ({ id, name, type: 'number', default: def, min, max, unit: '%', step: 0.1, ...o }),
  ang: (id, name, def = 0, o = {}) => ({ id, name, type: 'angle', default: def, ...o }),
  pt: (id, name, def, o = {}) => ({
    id,
    name,
    type: 'point',
    default: def || ((c) => [c.w / 2, c.h / 2]),
    ...o,
  }),
  col: (id, name, def = '#ffffff', o = {}) => ({ id, name, type: 'color', default: def, ...o }),
  bool: (id, name, def = false, o = {}) => ({ id, name, type: 'bool', default: def, animatable: false, ...o }),
  en: (id, name, options, def = 0, o = {}) => ({ id, name, type: 'enum', options, default: def, animatable: false, ...o }),
  track: (id, name, def = 1, o = {}) => ({ id, name, type: 'track', default: def, animatable: false, ...o }),
  text: (id, name, def = '', o = {}) => ({ id, name, type: 'text', default: def, animatable: false, ...o }),
};

export const relPt = (fx, fy) => (c) => [c.w * fx, c.h * fy];

// Gaussian blur on a render target; returns a new target. Sigmas in buffer px.
const BLUR_FS = `
uniform sampler2D u_tex; uniform vec2 u_dir; uniform float u_sigma; uniform int u_clampEdge; uniform vec4 u_rect;
vec4 S(vec2 px){ if (u_clampEdge == 1) px = clamp(px, u_rect.xy + 0.5, u_rect.zw - 0.5); return texture(u_tex, px / u_res); }
void main(){
  vec2 px = uv * u_res;
  if (u_sigma < 0.05) { o = S(px); return; }
  int n = int(ceil(u_sigma * 3.0));
  float stp = 1.0;
  if (n > 48) { stp = float(n) / 48.0; n = 48; }
  vec4 acc = S(px); float ws = 1.0;
  for (int i = 1; i <= 48; i++) {
    if (i > n) break;
    float x = float(i) * stp;
    float w = exp(-x * x / (2.0 * u_sigma * u_sigma));
    acc += (S(px + u_dir * x) + S(px - u_dir * x)) * w; ws += 2.0 * w;
  }
  o = acc / ws;
}`;
const COPY_FS = `uniform sampler2D u_tex; void main(){ o = texture(u_tex, uv); }`;

export function copyTarget(gl, input, w, h) {
  const out = gl.target(w ?? input.w, h ?? input.h);
  gl.pass(gl.program('copy', COPY_FS), { u_tex: input }, out);
  return out;
}

export function gaussianBlur(gl, input, sx, sy, opts = {}) {
  sx = Math.max(0, sx);
  sy = Math.max(0, sy);
  const prog = gl.program('gblur', BLUR_FS);
  let factor = 1;
  const big = Math.max(sx, sy);
  while (big / factor > 12 && factor < 16 && input.w / (factor * 2) > 8 && input.h / (factor * 2) > 8) factor *= 2;
  let src = input;
  const temps = [];
  if (factor > 1) {
    let f = 1;
    while (f < factor) {
      f *= 2;
      const t = gl.target(Math.ceil(input.w / f), Math.ceil(input.h / f));
      gl.pass(gl.program('copy', COPY_FS), { u_tex: src }, t);
      temps.push(t);
      src = t;
    }
  }
  const rect = opts.rect ? opts.rect.map((v) => v / factor) : [0, 0, src.w, src.h];
  const clampEdge = opts.repeatEdge ? 1 : 0;
  const a = gl.target(src.w, src.h);
  gl.pass(prog, { u_tex: src, u_dir: [1, 0], u_sigma: sx / factor, u_clampEdge: clampEdge, u_rect: rect }, a);
  const b = gl.target(src.w, src.h);
  gl.pass(prog, { u_tex: a, u_dir: [0, 1], u_sigma: sy / factor, u_clampEdge: clampEdge, u_rect: rect }, b);
  gl.release(a);
  for (const t of temps) gl.release(t);
  if (factor === 1) return b;
  const out = gl.target(input.w, input.h);
  gl.pass(gl.program('copy', COPY_FS), { u_tex: b }, out);
  gl.release(b);
  return out;
}

export { COPY_FS };
