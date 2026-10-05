// Video & audio transitions. Video transitions combine two sequence-space layers
// (u_a outgoing, u_b incoming) with progress u_p.

import { registerVideoTransition, registerAudioTransition } from '../core/registry.js';
import { hexToRgb } from '../core/util.js';
import { P } from './effectKit.js';

export const DIRECTIONS = ['West to East', 'East to West', 'North to South', 'South to North', 'NW to SE', 'SE to NW', 'NE to SW', 'SW to NE'];
const DIR_VEC = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [-1, 1], [1, -1]];

const COMMON = [
  P.pct('start', 'Start', 0, 0, 100, { animatable: false }),
  P.pct('end', 'End', 100, 0, 100, { animatable: false }),
  P.num('borderWidth', 'Border Width', 0, 0, 100, { animatable: false }),
  P.col('borderColor', 'Border Color', '#000000', { animatable: false }),
  P.bool('reverse', 'Reverse'),
];
const dirParam = (def = 0, opts = DIRECTIONS) => P.en('dir', 'Direction', opts, def);

const HEADER = `
uniform sampler2D u_a, u_b; uniform float u_p; uniform vec2 u_dir; uniform float u_bw; uniform vec3 u_bc; uniform vec2 u_ctr; uniform float u_n; uniform float u_soft;
vec4 A(vec2 q){ return texture(u_a, q); }
vec4 B(vec2 q){ return texture(u_b, q); }
bool inside(vec2 q){ return q.x >= 0.0 && q.y >= 0.0 && q.x <= 1.0 && q.y <= 1.0; }
vec4 Ain(vec2 q){ return inside(q) ? A(q) : vec4(0.0); }
vec4 Bin(vec2 q){ return inside(q) ? B(q) : vec4(0.0); }
float dirField(vec2 q){ vec2 d = normalize(u_dir); vec2 px = (q - 0.5) * u_res; float ext = 0.5 * (abs(d.x) * u_res.x + abs(d.y) * u_res.y); return dot(px, d) / ext * 0.5 + 0.5; }
`;

// Field transition: B is revealed where field(q) < progress.
function fieldFS(fieldBody) {
  return `${HEADER}
float field(vec2 q){ ${fieldBody} }
void main(){
  float f = field(uv); float fw = max(fwidth(f), 1e-4);
  float soft = max(fw * 1.2, u_soft);
  float t = u_p * (1.0 + soft) - soft * 0.5;
  if (u_p <= 0.0) { o = A(uv); return; } if (u_p >= 1.0) { o = B(uv); return; }
  float m = smoothstep(t - soft * 0.5, t + soft * 0.5, f);
  vec4 col = mix(B(uv), A(uv), m);
  if (u_bw > 0.0) { float bwf = u_bw * fw; float band = 1.0 - smoothstep(bwf * 0.5, bwf * 0.5 + fw, abs(f - t)); col = mix(col, vec4(u_bc, 1.0), band * step(0.001, u_p) * step(u_p, 0.999)); }
  o = col;
}`;
}

function uniformsBase(p, extra = {}) {
  return Object.assign(
    {
      u_dir: DIR_VEC[p.dir ?? 0] || [1, 0],
      u_bw: p.borderWidth || 0,
      u_bc: hexToRgb(p.borderColor || '#000000'),
      u_ctr: p.center ? [p.center[0] / 100, p.center[1] / 100] : [0.5, 0.5],
      u_n: p.count ?? 8,
      u_soft: (p.feather || 0) / 100,
    },
    extra,
  );
}

function fieldTransition(id, name, category, body, extraParams = [], opts = {}) {
  registerVideoTransition({
    id,
    name,
    category,
    params: [...extraParams, ...COMMON],
    fs: fieldFS(body),
    uniforms: (p) => uniformsBase(p),
    ...opts,
  });
}

function shaderTransition(id, name, category, fs, extraParams = [], uniforms = null, opts = {}) {
  registerVideoTransition({
    id,
    name,
    category,
    params: [...extraParams, ...COMMON],
    fs: HEADER + fs,
    uniforms: (p) => uniformsBase(p, uniforms ? uniforms(p) : {}),
    ...opts,
  });
}

const centerParam = P.pt('center', 'Center', [50, 50], { unit: '%', animatable: false });
const countParam = (n = 8, name = 'Number of Bands') => P.int('count', name, n, 1, 64, { animatable: false });
const featherParam = P.num('feather', 'Feather', 0, 0, 100, { animatable: false });

// ---------------- Dissolve ----------------
shaderTransition('crossDissolve', 'Cross Dissolve', 'Dissolve', `void main(){ o = mix(A(uv), B(uv), u_p); }`);
shaderTransition('additiveDissolve', 'Additive Dissolve', 'Dissolve', `void main(){ o = clamp(A(uv) * min(1.0, 2.0 * (1.0 - u_p)) + B(uv) * min(1.0, 2.0 * u_p), 0.0, 1.0); }`);
shaderTransition('dipToBlack', 'Dip to Black', 'Dissolve', `void main(){ vec4 k = vec4(0.0, 0.0, 0.0, 1.0); o = u_p < 0.5 ? mix(A(uv), k, u_p * 2.0) : mix(k, B(uv), u_p * 2.0 - 1.0); }`);
shaderTransition('dipToWhite', 'Dip to White', 'Dissolve', `void main(){ vec4 k = vec4(1.0); o = u_p < 0.5 ? mix(A(uv), k, u_p * 2.0) : mix(k, B(uv), u_p * 2.0 - 1.0); }`);
shaderTransition('filmDissolve', 'Film Dissolve', 'Dissolve', `void main(){ vec4 a = A(uv), b = B(uv); vec4 l = mix(pow(a, vec4(2.2)), pow(b, vec4(2.2)), u_p); o = pow(l, vec4(1.0 / 2.2)); o.a = mix(a.a, b.a, u_p); }`);
shaderTransition('nonAdditiveDissolve', 'Non-Additive Dissolve', 'Dissolve', `void main(){ vec4 a = A(uv), b = B(uv); o = u_p < 0.5 ? max(a, b * u_p * 2.0) : max(a * (1.0 - u_p) * 2.0, b); }`);

// ---------------- Iris ----------------
const irisField = (expr) => `vec2 d = (q - u_ctr) * u_res / max(u_res.x, u_res.y); ${expr}`;
fieldTransition('irisBox', 'Iris Box', 'Iris', irisField('return max(abs(d.x), abs(d.y)) / 0.75;'), [centerParam, featherParam]);
fieldTransition('irisCross', 'Iris Cross', 'Iris', irisField('return min(abs(d.x), abs(d.y)) * 2.2 + max(abs(d.x), abs(d.y)) * 0.25;'), [centerParam, featherParam]);
fieldTransition('irisDiamond', 'Iris Diamond', 'Iris', irisField('return (abs(d.x) + abs(d.y)) / 1.1;'), [centerParam, featherParam]);
fieldTransition('irisRound', 'Iris Round', 'Iris', irisField('return length(d) / 0.8;'), [centerParam, featherParam]);

// ---------------- Wipe ----------------
fieldTransition('wipe', 'Wipe', 'Wipe', 'return dirField(q);', [dirParam(0), featherParam]);
fieldTransition('bandWipe', 'Band Wipe', 'Wipe', 'vec2 d = normalize(u_dir); vec2 pp = vec2(-d.y, d.x); float b = floor(dot(q - 0.5, pp) * u_n + u_n * 4.0); float f = dirField(q); return mod(b, 2.0) < 1.0 ? f : 1.0 - f;', [dirParam(0), countParam(7)]);
fieldTransition('barnDoors', 'Barn Doors', 'Wipe', 'return abs(dot(q - 0.5, abs(normalize(u_dir)))) * 2.0;', [P.en('dir', 'Direction', ['Vertical Doors', 'Horizontal Doors'], 0), featherParam], { dirMap: [[1, 0], [0, 1]] });
fieldTransition('checkerWipe', 'Checker Wipe', 'Wipe', 'vec2 g = vec2(u_n, u_n * u_res.y / u_res.x); vec2 c = floor(q * g); float par = mod(c.x + c.y, 2.0); vec2 fq = fract(q * g); float w = clamp(dot(fq - 0.5, normalize(u_dir)) + 0.5, 0.0, 1.0); return clamp(par * 0.5 + w * 0.5, 0.0, 1.0);', [dirParam(0), countParam(8, 'Number of Squares')]);
fieldTransition('checkerBoard', 'CheckerBoard', 'Wipe', 'vec2 g = vec2(u_n, u_n * u_res.y / u_res.x); vec2 c = floor(q * g); float par = mod(c.x + c.y, 2.0); vec2 fq = fract(q * g); return clamp(par * 0.5 + fq.y * 0.5, 0.0, 1.0);', [countParam(8, 'Number of Squares')]);
fieldTransition('clockWipe', 'Clock Wipe', 'Wipe', 'vec2 d = (q - u_ctr) * u_res; float a = atan(d.x, -d.y); return fract(a / (2.0 * PI) + 1.0);', [centerParam, featherParam]);
fieldTransition('gradientWipe', 'Gradient Wipe', 'Wipe', 'vec4 a = A(q); return clamp(luma(unpre(a).rgb) * 0.85 + fbm(q * 3.0) * 0.15, 0.0, 1.0);', [P.num('feather', 'Softness', 10, 0, 100, { animatable: false })]);
fieldTransition('inset', 'Inset', 'Wipe', 'vec2 d = normalize(u_dir); vec2 r = vec2(d.x >= 0.0 ? q.x : 1.0 - q.x, d.y >= 0.0 ? q.y : 1.0 - q.y); if (abs(d.y) < 0.01) r.y = 0.0; if (abs(d.x) < 0.01) r.x = 0.0; return max(r.x, r.y);', [dirParam(4), featherParam]);
fieldTransition('paintSplatter', 'Paint Splatter', 'Wipe', 'vec2 s = q * vec2(u_res.x / u_res.y, 1.0) * 4.0; return clamp(fbm(s) * 1.6 - 0.3 + vnoise(s * 3.0) * 0.2, 0.0, 1.0);', []);
fieldTransition('pinwheel', 'Pinwheel', 'Wipe', 'vec2 d = (q - u_ctr) * u_res; float a = atan(d.y, d.x) / (2.0 * PI) + 0.5; return fract(a * u_n);', [centerParam, countParam(8, 'Number of Wedges')]);
fieldTransition('radialWipe', 'Radial Wipe', 'Wipe', 'vec2 d = q * u_res; float a = atan(d.y, d.x); return clamp(a / (PI * 0.5), 0.0, 1.0);', [featherParam]);
fieldTransition('randomBlocks', 'Random Blocks', 'Wipe', 'vec2 g = vec2(u_n, max(1.0, floor(u_n * u_res.y / u_res.x))); vec2 c = floor(q * g); return hash12(c + 7.13);', [countParam(16, 'Blocks Wide')]);
fieldTransition('randomWipe', 'Random Wipe', 'Wipe', 'vec2 g = vec2(u_n, max(1.0, floor(u_n * u_res.y / u_res.x))); vec2 c = floor(q * g); return clamp(dirField((c + 0.5) / g) * 0.7 + hash12(c + 3.1) * 0.3, 0.0, 1.0);', [dirParam(2), countParam(16, 'Blocks Wide')]);
fieldTransition('spiralBoxes', 'Spiral Boxes', 'Wipe', `vec2 g = vec2(u_n, max(2.0, floor(u_n * u_res.y / u_res.x))); vec2 c = floor(q * g); float ring = min(min(c.x, c.y), min(g.x - 1.0 - c.x, g.y - 1.0 - c.y));
  float rings = ceil(min(g.x, g.y) * 0.5); float w = g.x - 2.0 * ring, h = g.y - 2.0 * ring; float per = max(1.0, 2.0 * (w + h) - 4.0);
  vec2 l = c - ring; float pos; if (l.y == 0.0) pos = l.x; else if (l.x == w - 1.0) pos = w - 1.0 + l.y; else if (l.y == h - 1.0) pos = 2.0 * (w - 1.0) + (h - 1.0) - l.x; else pos = 2.0 * (w - 1.0) + 2.0 * (h - 1.0) - l.y;
  return clamp((ring + pos / per) / rings, 0.0, 1.0);`, [countParam(8, 'Boxes Wide')]);
fieldTransition('venetianBlinds', 'Venetian Blinds', 'Wipe', 'vec2 d = abs(normalize(u_dir)); return fract(dot(q, d) * u_n);', [dirParam(2), countParam(8)]);
fieldTransition('wedgeWipe', 'Wedge Wipe', 'Wipe', 'vec2 d = (q - vec2(0.5, 0.5)) * u_res; float a = abs(atan(d.x, -d.y)); return a / PI;', [featherParam]);
fieldTransition('zigZagBlocks', 'Zig-Zag Blocks', 'Wipe', 'vec2 g = vec2(u_n, max(1.0, floor(u_n * u_res.y / u_res.x))); vec2 c = floor(q * g); float col = mod(c.y, 2.0) < 1.0 ? c.x : g.x - 1.0 - c.x; return (c.y * g.x + col) / (g.x * g.y);', [countParam(8, 'Blocks Wide')]);

// ---------------- Slide ----------------
shaderTransition('push', 'Push', 'Slide', `void main(){ vec2 d = normalize(u_dir) * vec2(1.0); d = vec2(sign(d.x), sign(d.y));
  vec2 qa = uv - d * u_p, qb = uv - d * (u_p - 1.0); o = inside(qb) ? B(qb) : Ain(qa); }`, [dirParam(0)]);
shaderTransition('slide', 'Slide', 'Slide', `void main(){ vec2 d = vec2(sign(u_dir.x), sign(u_dir.y)); vec2 qb = uv - d * (u_p - 1.0);
  vec4 b = Bin(qb); vec4 a = A(uv); o = b + a * (1.0 - b.a); if (u_bw > 0.0 && inside(qb)) { vec2 e = min(qb, 1.0 - qb) * u_res; if (min(e.x, e.y) < u_bw) o = vec4(u_bc, 1.0); } }`, [dirParam(0)]);
shaderTransition('split', 'Split', 'Slide', `void main(){ bool vert = abs(u_dir.y) > abs(u_dir.x); float c = vert ? uv.y : uv.x; float s = c < 0.5 ? -1.0 : 1.0;
  vec2 off = vert ? vec2(0.0, s * u_p * 0.5) : vec2(s * u_p * 0.5, 0.0); vec2 qa = uv - off; bool ok = vert ? ((qa.y < 0.5) == (s < 0.0)) : ((qa.x < 0.5) == (s < 0.0));
  vec4 a = ok ? Ain(qa) : vec4(0.0); o = a + B(uv) * (1.0 - a.a); }`, [P.en('dir', 'Direction', ['Horizontal', 'Vertical'], 0)], null, { dirMap: [[1, 0], [0, 1]] });
shaderTransition('centerSplit', 'Center Split', 'Slide', `void main(){ vec2 s = vec2(uv.x < 0.5 ? -1.0 : 1.0, uv.y < 0.5 ? -1.0 : 1.0); vec2 qa = uv - s * u_p * 0.5;
  bool ok = ((qa.x < 0.5) == (s.x < 0.0)) && ((qa.y < 0.5) == (s.y < 0.0)); vec4 a = ok ? Ain(qa) : vec4(0.0); o = a + B(uv) * (1.0 - a.a); }`);
shaderTransition('bandSlide', 'Band Slide', 'Slide', `void main(){ bool vert = abs(u_dir.y) > abs(u_dir.x); float band = floor((vert ? uv.x : uv.y) * u_n); float s = mod(band, 2.0) < 1.0 ? 1.0 : -1.0;
  vec2 off = vert ? vec2(0.0, s * (1.0 - u_p)) : vec2(s * (1.0 - u_p), 0.0); vec2 qb = uv - off; vec4 b = Bin(qb); o = b + A(uv) * (1.0 - b.a); }`, [P.en('dir', 'Direction', ['Horizontal', 'Vertical'], 0), countParam(7)], null, { dirMap: [[1, 0], [0, 1]] });
shaderTransition('whip', 'Whip', 'Slide', `void main(){ vec2 d = vec2(sign(u_dir.x), sign(u_dir.y)); float e = u_p * u_p * (3.0 - 2.0 * u_p); vec4 acc = vec4(0.0);
  float blur = sin(u_p * PI) * 0.12;
  for (int i = 0; i < 16; i++) { float t = (float(i) / 15.0 - 0.5) * blur; vec2 qa = uv - d * (e + t), qb = uv - d * (e + t - 1.0); acc += inside(qb) ? B(qb) : Ain(qa); }
  o = acc / 16.0; }`, [dirParam(0)]);

// ---------------- Zoom ----------------
shaderTransition('crossZoom', 'Cross Zoom', 'Zoom', `void main(){ vec2 c = u_ctr; float s = u_p < 0.5 ? u_p * 2.0 : (1.0 - u_p) * 2.0; float str = s * s * 0.5;
  vec4 za = vec4(0.0), zb = vec4(0.0);
  for (int i = 0; i < 20; i++) { float t = float(i) / 19.0; vec2 q = c + (uv - c) * (1.0 - str * t); za += A(q); zb += B(q); }
  o = mix(za / 20.0, zb / 20.0, smoothstep(0.4, 0.6, u_p)); }`, [centerParam]);

// ---------------- 3D Motion ----------------
shaderTransition('cubeSpin', 'Cube Spin', '3D Motion', `void main(){ bool vert = abs(u_dir.y) > abs(u_dir.x); float s = vert ? sign(u_dir.y) : sign(u_dir.x);
  float ang = u_p * PI * 0.5; float persp = 0.6;
  float x = vert ? uv.y : uv.x; float y = vert ? uv.x : uv.y; if (s < 0.0) x = 1.0 - x;
  float wa = cos(ang), wb = sin(ang); float lx, ly; bool useB;
  if (x < wb) { lx = x / max(wb, 1e-4); ly = (y - 0.5) * (1.0 + persp * (1.0 - lx) * wa) + 0.5; useB = true; }
  else { lx = (x - wb) / max(wa, 1e-4); ly = (y - 0.5) * (1.0 + persp * lx * wb) + 0.5; useB = false; }
  if (ly < 0.0 || ly > 1.0) { o = vec4(0.0); return; }
  float fx = s < 0.0 ? 1.0 - lx : lx; vec2 q = vert ? vec2(ly, fx) : vec2(fx, ly);
  vec4 c = useB ? B(q) : A(q); float shade = useB ? 0.6 + 0.4 * wb : 0.6 + 0.4 * wa; o = vec4(c.rgb * shade, c.a); }`, [dirParam(0, DIRECTIONS.slice(0, 4))]);
shaderTransition('flipOver', 'Flip Over', '3D Motion', `void main(){ bool vert = abs(u_dir.y) > abs(u_dir.x); float ang = u_p * PI; float w = abs(cos(ang)); bool front = u_p < 0.5;
  vec2 q = uv; float x = vert ? q.y : q.x; float y = vert ? q.x : q.y; float lx = (x - 0.5) / max(w, 1e-4) + 0.5;
  float side = front ? (1.0 - lx) : lx; float depth = 1.0 + 0.35 * sin(ang) * (side - 0.5) * 2.0; float ly = (y - 0.5) * depth + 0.5;
  vec4 bg = vec4(u_bc, 1.0) * step(0.5, u_bw);
  if (lx < 0.0 || lx > 1.0 || ly < 0.0 || ly > 1.0) { o = bg; return; }
  float fx = front ? lx : 1.0 - lx; vec2 s = vert ? vec2(ly, fx) : vec2(fx, ly); vec4 c = front ? A(s) : B(s); o = c * (0.7 + 0.3 * w) + bg * (1.0 - c.a); }`, [P.en('dir', 'Direction', ['Horizontal', 'Vertical'], 0)], null, { dirMap: [[1, 0], [0, 1]] });

// ---------------- Page Peel ----------------
const peel = (curl) => `void main(){ vec2 asp = vec2(u_res.x / u_res.y, 1.0); vec2 q = uv * asp; vec2 d = normalize(vec2(1.0, 1.0));
  float maxP = dot(asp, d); float line = mix(maxP, -0.15, u_p);
  float pr = dot(q, d);
  if (pr > line) { o = B(uv); return; }
  vec2 rq = q + 2.0 * (line - pr) * d; vec2 ruv = rq / asp;
  float shadow = 1.0 - 0.45 * exp(-(line - pr) * 18.0) * step(0.001, u_p);
  if (inside(ruv) && u_p > 0.0) { vec4 back = A(ruv); float sh = ${curl ? '0.75 + 0.25 * smoothstep(0.0, 0.3, line - pr)' : '0.85'}; o = vec4(mix(back.rgb, vec3(back.a), 0.35) * sh, back.a); return; }
  o = A(uv) * vec4(vec3(shadow), 1.0); }`;
shaderTransition('pagePeel', 'Page Peel', 'Page Peel', peel(true));
shaderTransition('pageTurn', 'Page Turn', 'Page Peel', peel(false));

// ---------------- Audio transitions ----------------
registerAudioTransition({ id: 'constantPower', name: 'Constant Power', category: 'Crossfade', params: [], curve: (t) => Math.sin((t * Math.PI) / 2) });
registerAudioTransition({ id: 'constantGain', name: 'Constant Gain', category: 'Crossfade', params: [], curve: (t) => t });
registerAudioTransition({ id: 'exponentialFade', name: 'Exponential Fade', category: 'Crossfade', params: [], curve: (t) => (t <= 0 ? 0 : Math.pow(t, 2.6)) });

export function transitionUniforms(def, p) {
  const u = def.uniforms ? def.uniforms(p) : {};
  if (def.dirMap) u.u_dir = def.dirMap[p.dir ?? 0] || [1, 0];
  return u;
}
