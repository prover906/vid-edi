// Lumetri Color: one-pass grading shader with curves LUT texture and optional 3D LUT.

import { registerVideoEffect } from '../core/registry.js';
import { hexToRgb, hslToRgb, clamp } from '../core/util.js';
import { P } from './effectKit.js';

export const LOOKS = [
  { name: 'None' },
  { name: 'SL BIG', contrast: 0.25, sat: 1.15, shadow: [-0.02, 0.0, 0.03], high: [0.03, 0.01, -0.03] },
  { name: 'SL BLUE ICE', temp: -0.35, sat: 0.85, contrast: 0.1, shadow: [-0.03, 0.0, 0.06], high: [-0.02, 0.02, 0.05] },
  { name: 'SL CLEAN', contrast: 0.08, sat: 1.05, high: [0.01, 0.01, 0.0] },
  { name: 'SL GOLD HEAT', temp: 0.45, sat: 1.1, contrast: 0.15, shadow: [0.04, 0.01, -0.04], high: [0.06, 0.03, -0.05] },
  { name: 'SL MATRIX GREEN', tint: -0.4, sat: 0.8, contrast: 0.25, shadow: [-0.02, 0.05, -0.02], high: [0.0, 0.04, -0.02] },
  { name: 'SL NOIR', mono: 1, contrast: 0.45, fade: 0.05 },
  { name: 'SL BLEACH BYPASS', sat: 0.45, contrast: 0.45 },
  { name: 'Teal & Orange', sat: 1.1, contrast: 0.18, shadow: [-0.05, 0.02, 0.06], high: [0.07, 0.02, -0.06] },
  { name: 'Cinematic Warm', temp: 0.25, contrast: 0.15, fade: 0.06, shadow: [0.02, 0.0, -0.02], high: [0.04, 0.02, -0.02] },
  { name: 'Cinematic Cool', temp: -0.2, contrast: 0.15, fade: 0.05, shadow: [-0.03, 0.0, 0.05] },
  { name: 'Fuji ETERNA 250D', sat: 0.85, contrast: 0.08, fade: 0.08, shadow: [-0.01, 0.02, 0.02], high: [0.02, 0.02, -0.01] },
  { name: 'Kodak 5218 Kodak 2383', sat: 1.08, contrast: 0.22, shadow: [-0.02, 0.01, 0.03], high: [0.05, 0.02, -0.03] },
  { name: 'Monochrome Kodak 5222', mono: 1, contrast: 0.25, fade: 0.03 },
  { name: 'Vintage Fade', sat: 0.75, fade: 0.2, temp: 0.15, shadow: [0.02, 0.0, 0.04], high: [0.04, 0.03, -0.02] },
  { name: 'Sepia', mono: 1, temp: 0.0, high: [0.1, 0.05, -0.04], shadow: [0.06, 0.02, -0.03] },
];

const defCurves = () => ({ master: [[0, 0], [1, 1]], r: [[0, 0], [1, 1]], g: [[0, 0], [1, 1]], b: [[0, 0], [1, 1]] });
const defHueCurves = () => ({ hueSat: [], hueHue: [], hueLuma: [], lumaSat: [], satSat: [] });

const G = (g) => (o) => ({ ...o, group: g });

export const LUMETRI_PARAMS = [
  // Basic Correction
  P.bool('basicOn', 'Basic Correction', true, { section: 'basic' }),
  { id: 'lut', name: 'Input LUT', type: 'lut', default: null, animatable: false, group: 'Basic Correction' },
  P.num('temp', 'Temperature', 0, -100, 100, G('Basic Correction')({ gradient: 'temp' })),
  P.num('tint', 'Tint', 0, -100, 100, G('Basic Correction')({ gradient: 'tint' })),
  P.num('exposure', 'Exposure', 0, -5, 5, G('Basic Correction')({ step: 0.01, precision: 1 })),
  P.num('contrast', 'Contrast', 0, -100, 100, G('Basic Correction')({})),
  P.num('highlights', 'Highlights', 0, -100, 100, G('Basic Correction')({})),
  P.num('shadows', 'Shadows', 0, -100, 100, G('Basic Correction')({})),
  P.num('whites', 'Whites', 0, -100, 100, G('Basic Correction')({})),
  P.num('blacks', 'Blacks', 0, -100, 100, G('Basic Correction')({})),
  P.num('saturation', 'Saturation', 100, 0, 200, G('Basic Correction')({})),
  // Creative
  P.bool('creativeOn', 'Creative', true, { section: 'creative' }),
  P.en('look', 'Look', LOOKS.map((l) => l.name), 0, { group: 'Creative' }),
  P.num('intensity', 'Intensity', 100, 0, 200, G('Creative')({})),
  P.num('fade', 'Faded Film', 0, 0, 100, G('Creative')({})),
  P.num('sharpen', 'Sharpen', 0, -100, 100, G('Creative')({})),
  P.num('vibrance', 'Vibrance', 0, -100, 100, G('Creative')({})),
  P.num('cSat', 'Saturation', 100, 0, 200, G('Creative')({})),
  { id: 'shadowTint', name: 'Shadow Tint', type: 'wheel', default: [0, 0], group: 'Creative' },
  { id: 'highlightTint', name: 'Highlight Tint', type: 'wheel', default: [0, 0], group: 'Creative' },
  P.num('tintBalance', 'Tint Balance', 0, -100, 100, G('Creative')({})),
  // Curves
  P.bool('curvesOn', 'Curves', true, { section: 'curves' }),
  { id: 'curves', name: 'RGB Curves', type: 'curve', default: defCurves, animatable: false, group: 'Curves' },
  { id: 'hueCurves', name: 'Hue Saturation Curves', type: 'huecurve', default: defHueCurves, animatable: false, group: 'Curves' },
  // Color Wheels
  P.bool('wheelsOn', 'Color Wheels & Match', true, { section: 'wheels' }),
  { id: 'wShadows', name: 'Shadows', type: 'wheel', default: [0, 0], group: 'Color Wheels & Match' },
  P.num('lShadows', 'Shadows Level', 0, -100, 100, G('Color Wheels & Match')({})),
  { id: 'wMid', name: 'Midtones', type: 'wheel', default: [0, 0], group: 'Color Wheels & Match' },
  P.num('lMid', 'Midtones Level', 0, -100, 100, G('Color Wheels & Match')({})),
  { id: 'wHigh', name: 'Highlights', type: 'wheel', default: [0, 0], group: 'Color Wheels & Match' },
  P.num('lHigh', 'Highlights Level', 0, -100, 100, G('Color Wheels & Match')({})),
  // HSL Secondary
  P.bool('hslOn', 'HSL Secondary', false, { section: 'hsl' }),
  P.num('hslHue', 'Hue Center', 0, 0, 360, G('HSL Secondary')({})),
  P.num('hslHueRange', 'Hue Range', 30, 0, 180, G('HSL Secondary')({})),
  P.num('hslSatLo', 'Saturation Min', 15, 0, 100, G('HSL Secondary')({})),
  P.num('hslSatHi', 'Saturation Max', 100, 0, 100, G('HSL Secondary')({})),
  P.num('hslLumLo', 'Lightness Min', 5, 0, 100, G('HSL Secondary')({})),
  P.num('hslLumHi', 'Lightness Max', 95, 0, 100, G('HSL Secondary')({})),
  P.num('hslSoft', 'Softness', 20, 0, 100, G('HSL Secondary')({})),
  P.bool('hslMask', 'Show Mask', false, { group: 'HSL Secondary' }),
  P.bool('hslInvert', 'Invert Mask', false, { group: 'HSL Secondary' }),
  P.num('hslTemp', 'Temperature', 0, -100, 100, G('HSL Secondary')({ gradient: 'temp' })),
  P.num('hslTint', 'Tint', 0, -100, 100, G('HSL Secondary')({ gradient: 'tint' })),
  P.num('hslContrast', 'Contrast', 0, -100, 100, G('HSL Secondary')({})),
  P.num('hslSat', 'Saturation', 100, 0, 200, G('HSL Secondary')({})),
  P.num('hslHueShift', 'Hue Shift', 0, -180, 180, G('HSL Secondary')({})),
  // Vignette
  P.bool('vigOn', 'Vignette', true, { section: 'vignette' }),
  P.num('vigAmount', 'Amount', 0, -5, 5, G('Vignette')({ step: 0.01, precision: 1 })),
  P.num('vigMid', 'Midpoint', 50, 0, 100, G('Vignette')({})),
  P.num('vigRound', 'Roundness', 0, -100, 100, G('Vignette')({})),
  P.num('vigFeather', 'Feather', 50, 0, 100, G('Vignette')({})),
];

// ---- Curve evaluation (monotone cubic) ----
export function evalCurve(points, x, periodic = false, neutral = null) {
  let pts = (points || []).slice().sort((a, b) => a[0] - b[0]);
  if (!pts.length) return neutral != null ? neutral : x;
  if (periodic) {
    pts = [...pts.map((p) => [p[0] - 1, p[1]]), ...pts, ...pts.map((p) => [p[0] + 1, p[1]])];
  }
  if (pts.length === 1) return pts[0][1];
  if (x <= pts[0][0]) return pts[0][1];
  if (x >= pts[pts.length - 1][0]) return pts[pts.length - 1][1];
  const n = pts.length;
  const dx = [], dy = [], m = [];
  for (let i = 0; i < n - 1; i++) {
    dx.push(pts[i + 1][0] - pts[i][0] || 1e-6);
    dy.push(pts[i + 1][1] - pts[i][1]);
    m.push(dy[i] / dx[i]);
  }
  const t = [m[0]];
  for (let i = 1; i < n - 1; i++) t.push(m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2);
  t.push(m[n - 2]);
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) { t[i] = 0; t[i + 1] = 0; continue; }
    const a = t[i] / m[i], b = t[i + 1] / m[i], s = a * a + b * b;
    if (s > 9) { const k = 3 / Math.sqrt(s); t[i] = k * a * m[i]; t[i + 1] = k * b * m[i]; }
  }
  let i = 0;
  while (i < n - 2 && x > pts[i + 1][0]) i++;
  const h = dx[i], u = (x - pts[i][0]) / h, u2 = u * u, u3 = u2 * u;
  return (2 * u3 - 3 * u2 + 1) * pts[i][1] + (u3 - 2 * u2 + u) * h * t[i] + (-2 * u3 + 3 * u2) * pts[i + 1][1] + (u3 - u2) * h * t[i + 1];
}

export function buildCurveLUT(curves, hueCurves) {
  // 256 x 9 RGBA rows: 0 master,1 r,2 g,3 b,4 hueSat,5 hueHue,6 hueLuma,7 lumaSat,8 satSat
  const W = 256, H = 9, data = new Uint8Array(W * H * 4);
  const rows = [
    (x) => evalCurve(curves.master, x),
    (x) => evalCurve(curves.r, x),
    (x) => evalCurve(curves.g, x),
    (x) => evalCurve(curves.b, x),
    (x) => evalCurve(hueCurves.hueSat, x, true, 0.5),
    (x) => evalCurve(hueCurves.hueHue, x, true, 0.5),
    (x) => evalCurve(hueCurves.hueLuma, x, true, 0.5),
    (x) => evalCurve(hueCurves.lumaSat, x, false, 0.5),
    (x) => evalCurve(hueCurves.satSat, x, false, 0.5),
  ];
  rows.forEach((fn, r) => {
    for (let i = 0; i < W; i++) {
      const v = clamp(fn(i / 255), 0, 1) * 255;
      const o = (r * W + i) * 4;
      data[o] = data[o + 1] = data[o + 2] = Math.round(v);
      data[o + 3] = 255;
    }
  });
  return { data, W, H };
}

export function wheelToRgb(w, strength = 1) {
  const [x, y] = w || [0, 0];
  const mag = Math.min(1, Math.hypot(x, y));
  if (mag < 1e-4) return [0, 0, 0];
  const hue = ((Math.atan2(-y, x) / (2 * Math.PI)) + 1) % 1;
  const c = hslToRgb(hue, 1, 0.5);
  const mean = (c[0] + c[1] + c[2]) / 3;
  return c.map((v) => (v - mean) * mag * strength);
}

// Parse .cube LUT text -> {size, data Uint8Array RGB}
export function parseCube(text) {
  let size = 0;
  const vals = [];
  let dmin = [0, 0, 0], dmax = [1, 1, 1];
  for (const line of text.split(/\r?\n/)) {
    const l = line.trim();
    if (!l || l[0] === '#') continue;
    if (/^LUT_3D_SIZE/i.test(l)) size = parseInt(l.split(/\s+/)[1], 10);
    else if (/^DOMAIN_MIN/i.test(l)) dmin = l.split(/\s+/).slice(1).map(Number);
    else if (/^DOMAIN_MAX/i.test(l)) dmax = l.split(/\s+/).slice(1).map(Number);
    else if (/^[-\d.]/.test(l)) {
      const p = l.split(/\s+/).map(Number);
      if (p.length >= 3) vals.push(p[0], p[1], p[2]);
    }
  }
  if (!size || vals.length < size * size * size * 3) throw new Error('Unsupported or invalid .cube file (3D LUT required)');
  const data = new Uint8Array(size * size * size * 3);
  for (let i = 0; i < size * size * size * 3; i++) {
    const c = i % 3;
    data[i] = Math.round(clamp((vals[i] - dmin[c]) / (dmax[c] - dmin[c] || 1), 0, 1) * 255);
  }
  return { size, data };
}

const FS = `
uniform sampler2D u_curves; uniform highp sampler3D u_lut; uniform int u_hasLut; uniform float u_lutSize;
uniform int u_basic, u_creative, u_curvesOn, u_wheels, u_hsl, u_vig;
uniform vec3 u_wb; uniform float u_exp, u_con, u_hi, u_sh, u_wh, u_bl, u_sat;
uniform float u_lookAmt, u_lookCon, u_lookSat, u_lookFade, u_lookMono; uniform vec3 u_lookWb, u_lookSh, u_lookHi;
uniform float u_fade, u_sharp, u_vib, u_csat, u_tbal; uniform vec3 u_shTint, u_hiTint;
uniform vec3 u_wS, u_wM, u_wH; uniform vec3 u_lvl;
uniform vec3 u_hslH; uniform vec4 u_hslSL; uniform float u_hslSoft; uniform int u_hslMask, u_hslInv; uniform vec3 u_hslWb; uniform float u_hslCon, u_hslSat, u_hslHue;
uniform vec4 u_vigP;
float crv(float x, float row){ return texture(u_curves, vec2(x * 255.0 / 256.0 + 0.5 / 256.0, (row + 0.5) / 9.0)).r; }
vec3 applyContrast(vec3 c, float k){ float l = luma(c); float nl = clamp((l - 0.45) * (1.0 + k) + 0.45, 0.0, 1.0); nl = mix(nl, smoothstep(0.0, 1.0, nl), clamp(k, 0.0, 1.0) * 0.3); return c + (nl - l); }
void main(){
  vec2 px = uv * u_res; vec4 src = unpre(tex(px)); vec3 c = src.rgb;
  if (u_basic == 1) {
    if (u_hasLut == 1) { vec3 lc = clamp(c, 0.0, 1.0) * (u_lutSize - 1.0) / u_lutSize + 0.5 / u_lutSize; c = texture(u_lut, lc).rgb; }
    c *= u_wb;
    vec3 lin = pow(max(c, 0.0), vec3(2.2)) * exp2(u_exp); c = pow(lin, vec3(1.0 / 2.2));
    c = applyContrast(c, u_con);
    float l = luma(c);
    float hw = smoothstep(0.35, 1.0, l), sw = 1.0 - smoothstep(0.0, 0.65, l);
    c += u_hi * 0.35 * hw * (u_hi > 0.0 ? (1.0 - l) : l);
    c += u_sh * 0.35 * sw * (u_sh > 0.0 ? (1.0 - l) : l) ;
    c = c * (1.0 + u_wh * 0.3 * smoothstep(0.5, 1.0, l));
    c = c + u_bl * 0.12 * (1.0 - smoothstep(0.0, 0.5, l));
    c = max(c, 0.0);
    c = mix(vec3(luma(c)), c, u_sat);
  }
  if (u_creative == 1) {
    vec3 base = c;
    vec3 lk = c * u_lookWb; lk = applyContrast(lk, u_lookCon);
    if (u_lookMono > 0.5) lk = vec3(luma(lk));
    float ll = luma(lk);
    lk += u_lookSh * (1.0 - smoothstep(0.0, 0.55, ll)) + u_lookHi * smoothstep(0.45, 1.0, ll);
    lk = mix(vec3(luma(lk)), lk, u_lookSat);
    lk = mix(lk, lk * 0.82 + 0.09, clamp(u_lookFade * 2.0, 0.0, 1.0));
    c = mix(base, lk, u_lookAmt);
    c = c * (1.0 - u_fade * 0.25) + u_fade * 0.15;
    if (abs(u_sharp) > 0.0) {
      vec3 n = unpre(tex(px + vec2(1.0, 0.0))).rgb + unpre(tex(px - vec2(1.0, 0.0))).rgb + unpre(tex(px + vec2(0.0, 1.0))).rgb + unpre(tex(px - vec2(0.0, 1.0))).rgb;
      c += (src.rgb * 4.0 - n) * u_sharp * 0.5;
    }
    float mx = max(c.r, max(c.g, c.b)), mn = min(c.r, min(c.g, c.b)); float s = mx - mn;
    float vib = u_vib * (1.0 - s); c = mix(vec3(luma(c)), c, 1.0 + vib);
    c = mix(vec3(luma(c)), c, u_csat);
    float l2 = luma(c); float bal = u_tbal;
    c += u_shTint * (1.0 - smoothstep(0.0, 0.5 + bal * 0.4, l2)) + u_hiTint * smoothstep(0.5 + bal * 0.4, 1.0, l2);
  }
  if (u_curvesOn == 1) {
    c = clamp(c, 0.0, 1.0);
    c = vec3(crv(c.r, 0.0), crv(c.g, 0.0), crv(c.b, 0.0));
    c = vec3(crv(c.r, 1.0), crv(c.g, 2.0), crv(c.b, 3.0));
    vec3 hsl = rgb2hsl(c);
    float hs = crv(hsl.x, 4.0) * 2.0, hh = crv(hsl.x, 5.0) - 0.5, hl = crv(hsl.x, 6.0) - 0.5, ls = crv(hsl.z, 7.0) * 2.0, ss = crv(hsl.y, 8.0) * 2.0;
    hsl.x = fract(hsl.x + hh * 0.5); hsl.y = clamp(hsl.y * hs * ls * ss, 0.0, 1.0); vec3 rc = hsl2rgb(hsl); rc += hl * 0.5 * hsl.y;
    c = rc;
  }
  if (u_wheels == 1) {
    float l = luma(c);
    float ws = 1.0 - smoothstep(0.0, 0.5, l), wh = smoothstep(0.5, 1.0, l), wm = 1.0 - ws - wh;
    c += u_wS * ws * 0.6 + u_wM * wm * 0.5 + u_wH * wh * 0.6;
    c += u_lvl.x * ws * 0.3 + u_lvl.y * wm * 0.3 + u_lvl.z * wh * 0.3;
  }
  if (u_hsl == 1) {
    vec3 hsl = rgb2hsl(clamp(c, 0.0, 1.0));
    float dh = abs(hsl.x - u_hslH.x); dh = min(dh, 1.0 - dh); float soft = u_hslSoft + 1e-3;
    float m = 1.0 - smoothstep(u_hslH.y, u_hslH.y + soft * 0.3, dh);
    m *= smoothstep(u_hslSL.x - soft, u_hslSL.x, hsl.y) * (1.0 - smoothstep(u_hslSL.y, u_hslSL.y + soft, hsl.y));
    m *= smoothstep(u_hslSL.z - soft, u_hslSL.z, hsl.z) * (1.0 - smoothstep(u_hslSL.w, u_hslSL.w + soft, hsl.z));
    if (u_hslInv == 1) m = 1.0 - m;
    if (u_hslMask == 1) { o = vec4(mix(vec3(0.5), c, m) * src.a, src.a); return; }
    vec3 k = c * u_hslWb; k = applyContrast(k, u_hslCon); vec3 kh = rgb2hsl(clamp(k, 0.0, 1.0)); kh.x = fract(kh.x + u_hslHue); kh.y = clamp(kh.y * u_hslSat, 0.0, 1.0); k = hsl2rgb(kh);
    c = mix(c, k, m);
  }
  if (u_vig == 1 && abs(u_vigP.x) > 0.0) {
    vec2 q = (toClip(px) / u_clip - 0.5) * 2.0; float asp = u_clip.x / u_clip.y; float rnd = u_vigP.z;
    vec2 qr = mix(q, vec2(q.x, q.y / asp), max(rnd, 0.0));
    float pw = 2.0 + max(-rnd, 0.0) * 6.0;
    float d = pow(pow(abs(qr.x), pw) + pow(abs(qr.y), pw), 1.0 / pw);
    float mid = mix(0.3, 1.3, u_vigP.y); float f = smoothstep(mid - u_vigP.w * 0.8 - 0.02, mid + u_vigP.w * 0.3, d);
    if (u_vigP.x < 0.0) c *= 1.0 - f * min(1.0, -u_vigP.x * 0.35); else c = mix(c, vec3(1.0), f * min(1.0, u_vigP.x * 0.3));
  }
  o = pre(vec4(clamp(c, 0.0, 1.0), src.a));
}`;

function wbVec(temp, tint) {
  const t = temp / 100, ti = tint / 100;
  return [1 + t * 0.18 + ti * 0.05, 1 - ti * 0.15, 1 - t * 0.22 + ti * 0.05];
}

registerVideoEffect({
  id: 'lumetri',
  name: 'Lumetri Color',
  category: 'Color Correction',
  params: LUMETRI_PARAMS,
  render(ctx) {
    const p = ctx.p;
    const curves = p.curves || defCurves();
    const hue = p.hueCurves || defHueCurves();
    const key = 'curves:' + JSON.stringify([curves, hue]);
    const curveTex = ctx.dataTexture(key, () => buildCurveLUT(curves, hue));
    const look = LOOKS[p.look] || LOOKS[0];
    const amt = (p.intensity / 100) * (p.look ? 1 : 0);
    let lut = null, lutSize = 0;
    if (p.lut) {
      const L = ctx.lut(p.lut);
      if (L) {
        lut = L.tex;
        lutSize = L.size;
      }
    }
    return ctx.run('lumetri', FS, {
      u_curves: curveTex,
      u_lut: lut,
      u_hasLut: lut ? 1 : 0,
      u_lutSize: lutSize || 2,
      u_basic: p.basicOn, u_creative: p.creativeOn, u_curvesOn: p.curvesOn, u_wheels: p.wheelsOn, u_hsl: p.hslOn, u_vig: p.vigOn,
      u_wb: wbVec(p.temp, p.tint), u_exp: p.exposure, u_con: p.contrast / 100, u_hi: p.highlights / 100, u_sh: p.shadows / 100, u_wh: p.whites / 100, u_bl: p.blacks / 100, u_sat: p.saturation / 100,
      u_lookAmt: amt, u_lookCon: look.contrast || 0, u_lookSat: look.sat ?? 1, u_lookFade: look.fade || 0, u_lookMono: look.mono || 0,
      u_lookWb: wbVec((look.temp || 0) * 100, (look.tint || 0) * 100), u_lookSh: look.shadow || [0, 0, 0], u_lookHi: look.high || [0, 0, 0],
      u_fade: p.fade / 100, u_sharp: p.sharpen / 100, u_vib: p.vibrance / 100, u_csat: p.cSat / 100, u_tbal: p.tintBalance / 100,
      u_shTint: wheelToRgb(p.shadowTint, 0.25), u_hiTint: wheelToRgb(p.highlightTint, 0.25),
      u_wS: wheelToRgb(p.wShadows, 0.5), u_wM: wheelToRgb(p.wMid, 0.5), u_wH: wheelToRgb(p.wHigh, 0.5), u_lvl: [p.lShadows / 100, p.lMid / 100, p.lHigh / 100],
      u_hslH: [p.hslHue / 360, p.hslHueRange / 360, 0], u_hslSL: [p.hslSatLo / 100, p.hslSatHi / 100, p.hslLumLo / 100, p.hslLumHi / 100], u_hslSoft: p.hslSoft / 100,
      u_hslMask: p.hslMask, u_hslInv: p.hslInvert, u_hslWb: wbVec(p.hslTemp, p.hslTint), u_hslCon: p.hslContrast / 100, u_hslSat: p.hslSat / 100, u_hslHue: p.hslHueShift / 360,
      u_vigP: [p.vigAmount, p.vigMid / 100, p.vigRound / 100, p.vigFeather / 100],
    });
  },
});

export const LUMETRI_PRESETS = [
  { folder: 'Cinematic', name: 'Cinematic Warm', params: { look: 9 } },
  { folder: 'Cinematic', name: 'Cinematic Cool', params: { look: 10 } },
  { folder: 'Cinematic', name: 'Teal & Orange', params: { look: 8 } },
  { folder: 'Cinematic', name: 'SL BIG', params: { look: 1 } },
  { folder: 'Cinematic', name: 'SL GOLD HEAT', params: { look: 4 } },
  { folder: 'Cinematic', name: 'SL BLUE ICE', params: { look: 2 } },
  { folder: 'Cinematic', name: 'SL MATRIX GREEN', params: { look: 5 } },
  { folder: 'Filmstock', name: 'Fuji ETERNA 250D', params: { look: 11 } },
  { folder: 'Filmstock', name: 'Kodak 5218 Kodak 2383', params: { look: 12 } },
  { folder: 'Monochrome', name: 'Monochrome Kodak 5222', params: { look: 13 } },
  { folder: 'Monochrome', name: 'SL NOIR', params: { look: 6 } },
  { folder: 'Monochrome', name: 'Black & White Punch', params: { saturation: 0, contrast: 40 } },
  { folder: 'SpeedLooks', name: 'SL CLEAN', params: { look: 3 } },
  { folder: 'SpeedLooks', name: 'SL BLEACH BYPASS', params: { look: 7 } },
  { folder: 'SpeedLooks', name: 'Vintage Fade', params: { look: 14 } },
  { folder: 'SpeedLooks', name: 'Sepia', params: { look: 15 } },
  { folder: 'Technical', name: 'Brighten +1 Stop', params: { exposure: 1 } },
  { folder: 'Technical', name: 'Darken -1 Stop', params: { exposure: -1 } },
  { folder: 'Technical', name: 'Legal Range Vignette', params: { vigAmount: -1.5 } },
];

export { hexToRgb };
