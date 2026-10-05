// Video effect definitions (Premiere Pro-style list) with WebGL implementations.
// Effects operate in "clip space": a buffer holding the clip at scale k with padding.

import { registerVideoEffect } from '../core/registry.js';
import { hexToRgb } from '../core/util.js';
import { P, relPt, gaussianBlur } from './effectKit.js';

const rad = (d) => (d * Math.PI) / 180;
const rgb = hexToRgb;

export const BLEND_MODES = [
  'Normal', 'Dissolve', 'Darken', 'Multiply', 'Color Burn', 'Linear Burn', 'Darker Color',
  'Lighten', 'Screen', 'Color Dodge', 'Linear Dodge (Add)', 'Lighter Color',
  'Overlay', 'Soft Light', 'Hard Light', 'Vivid Light', 'Linear Light', 'Pin Light', 'Hard Mix',
  'Difference', 'Exclusion', 'Subtract', 'Divide', 'Hue', 'Saturation', 'Color', 'Luminosity',
];
export const BLEND_SEPARATORS = [2, 7, 12, 19, 23];

const GEN_MODES = ['None', 'Normal', 'Add', 'Multiply', 'Screen', 'Overlay', 'Soft Light', 'Color Dodge', 'Color Burn', 'Darken', 'Lighten', 'Difference'];

const GEN_BLEND = `
vec3 blendGen(int m, vec3 b, vec3 s){
  if (m == 1) return min(b + s, 1.0);
  if (m == 2) return b * s;
  if (m == 3) return 1.0 - (1.0 - b) * (1.0 - s);
  if (m == 4) return mix(2.0 * b * s, 1.0 - 2.0 * (1.0 - b) * (1.0 - s), step(0.5, b));
  if (m == 5) return mix(2.0*b*s + b*b*(1.0-2.0*s), sqrt(b)*(2.0*s-1.0) + 2.0*b*(1.0-s), step(0.5, s));
  if (m == 6) return min(b / (1.0 - s + 1e-4), 1.0);
  if (m == 7) return 1.0 - min((1.0 - b) / (s + 1e-4), 1.0);
  if (m == 8) return min(b, s);
  if (m == 9) return max(b, s);
  if (m == 10) return abs(b - s);
  return s;
}
vec4 genComposite(vec4 src, vec3 gc, float ga, int mode, float op){
  ga = clamp(ga * op, 0.0, 1.0);
  if (mode == 0) return vec4(gc * ga, ga);
  vec4 s = unpre(src);
  vec3 b = blendGen(mode - 1, s.rgb, gc);
  float a = s.a + ga * (1.0 - s.a);
  vec3 col = (mix(s.rgb, b, ga) * s.a + gc * ga * (1.0 - s.a)) / max(a, 1e-4);
  return vec4(col * a, a);
}`;

function clipRectBuf(ctx) {
  return [ctx.origin[0], ctx.origin[1], ctx.origin[0] + ctx.clipW * ctx.k, ctx.origin[1] + ctx.clipH * ctx.k];
}

function simple(def) {
  return Object.assign({}, def, {
    render(ctx) {
      return ctx.run(def.id, def.fs, def.uniforms ? def.uniforms(ctx.p, ctx) : {});
    },
  });
}
const reg = (d) => registerVideoEffect(d.render ? d : simple(d));

// ============================== Intrinsic ==============================

reg({
  id: 'motion',
  name: 'Motion',
  intrinsic: true,
  params: [
    P.pt('position', 'Position', (c) => [(c.seqW || c.w) / 2, (c.seqH || c.h) / 2], { space: 'sequence' }),
    P.num('scale', 'Scale', 100, 0, 10000, { uiMax: 600 }),
    P.num('scaleWidth', 'Scale Width', 100, 0, 10000, { uiMax: 600, enabledIf: (p) => !p.uniformScale.v }),
    P.bool('uniformScale', 'Uniform Scale', true),
    P.ang('rotation', 'Rotation', 0),
    P.pt('anchor', 'Anchor Point'),
    P.num('antiFlicker', 'Anti-flicker Filter', 0, 0, 1, { step: 0.01, precision: 2 }),
  ],
  render: (ctx) => ctx.input,
});

reg({
  id: 'opacity',
  name: 'Opacity',
  intrinsic: true,
  masks: true,
  params: [
    { id: 'maskTools', type: 'mask-tools' },
    P.pct('opacity', 'Opacity', 100),
    P.en('blendMode', 'Blend Mode', BLEND_MODES, 0, { separators: BLEND_SEPARATORS }),
  ],
  render: (ctx) => ctx.input,
});

reg({
  id: 'timeRemap',
  name: 'Time Remapping',
  intrinsic: true,
  params: [{ id: 'speed', name: 'Speed', type: 'number', default: 100, min: 0, max: 10000, uiMax: 1000, unit: '%', step: 0.5, precision: 2 }],
  render: (ctx) => ctx.input,
});

// ============================== Adjust ==============================

reg({
  id: 'extract', name: 'Extract', category: 'Adjust',
  params: [P.int('black', 'Black Input Level', 0, 0, 255), P.int('white', 'White Input Level', 255, 0, 255), P.int('soft', 'Softness', 0, 0, 100), P.bool('invert', 'Invert')],
  fs: `uniform float u_bl, u_wl, u_s; uniform int u_inv;
  void main(){ vec4 c = unpre(tex(uv*u_res)); float l = luma(c.rgb) * 255.0;
    float v = (u_s > 0.0) ? smoothstep(u_bl - u_s, u_bl, l) * (1.0 - smoothstep(u_wl, u_wl + u_s, l)) : step(u_bl, l) * step(l, u_wl);
    if (u_inv == 1) v = 1.0 - v; o = pre(vec4(vec3(v), c.a)); }`,
  uniforms: (p) => ({ u_bl: p.black, u_wl: p.white, u_s: p.soft, u_inv: p.invert }),
});

reg({
  id: 'levels', name: 'Levels', category: 'Adjust',
  params: [
    P.int('inBlack', '(RGB) Black Input Level', 0, 0, 255), P.int('inWhite', '(RGB) White Input Level', 255, 0, 255),
    P.int('outBlack', '(RGB) Black Output Level', 0, 0, 255), P.int('outWhite', '(RGB) White Output Level', 255, 0, 255),
    P.num('gamma', '(RGB) Gamma', 1, 0.1, 9.99, { step: 0.01, precision: 2 }),
  ],
  fs: `uniform float u_ib, u_iw, u_ob, u_ow, u_g;
  void main(){ vec4 c = unpre(tex(uv*u_res)); vec3 x = clamp((c.rgb - u_ib) / max(1e-4, u_iw - u_ib), 0.0, 1.0);
    x = pow(x, vec3(1.0 / max(u_g, 0.01))); o = pre(vec4(mix(vec3(u_ob), vec3(u_ow), x), c.a)); }`,
  uniforms: (p) => ({ u_ib: p.inBlack / 255, u_iw: p.inWhite / 255, u_ob: p.outBlack / 255, u_ow: p.outWhite / 255, u_g: p.gamma }),
});

reg({
  id: 'lighting', name: 'Lighting Effects', category: 'Adjust',
  params: [
    P.en('type', 'Light Type', ['None', 'Directional', 'Omni', 'Spotlight'], 3),
    P.col('color', 'Light Color', '#ffffff'),
    P.pt('center', 'Center'),
    P.num('major', 'Major Radius', 30, 0, 100), P.num('minor', 'Minor Radius', 20, 0, 100),
    P.ang('angle', 'Angle', 0), P.num('intensity', 'Intensity', 18, -100, 100), P.num('focus', 'Focus', 50, -100, 100),
    P.num('ambient', 'Ambience Intensity', 15, -100, 100, { group: 'Ambience' }), P.col('ambColor', 'Ambience Color', '#ffffff', { group: 'Ambience' }),
    P.num('exposure', 'Exposure', 0, -100, 100),
  ],
  fs: `uniform int u_type; uniform vec3 u_col, u_ambc; uniform vec2 u_ctr, u_rad; uniform float u_ang, u_int, u_focus, u_amb, u_exp;
  void main(){ vec4 c = unpre(tex(uv*u_res)); vec2 p = toClip(uv*u_res);
    float light = 0.0;
    if (u_type == 1) light = u_int;
    else if (u_type >= 2) { vec2 d = rot2(p - u_ctr, -u_ang) / max(u_rad, vec2(1.0)); float r = length(d);
      float f = u_type == 3 ? clamp(u_focus * 0.5 + 0.5, 0.0, 0.98) : 0.0; light = u_int * (1.0 - smoothstep(f, 1.0, r)); }
    vec3 l = u_ambc * u_amb + u_col * light * 2.0;
    o = pre(vec4(clamp(c.rgb * l * exp2(u_exp), 0.0, 1.0), c.a)); }`,
  uniforms: (p, ctx) => ({
    u_type: p.type, u_col: rgb(p.color), u_ambc: rgb(p.ambColor), u_ctr: p.center,
    u_rad: [(p.major / 100) * ctx.clipW, (p.minor / 100) * ctx.clipW], u_ang: rad(p.angle), u_int: p.intensity / 20, u_focus: p.focus / 100,
    u_amb: Math.max(0, (p.ambient + 15) / 100 + 0.35) * 0.9, u_exp: p.exposure / 50,
  }),
});

reg({
  id: 'procAmp', name: 'ProcAmp', category: 'Adjust',
  params: [P.num('brightness', 'Brightness', 0, -100, 100), P.num('contrast', 'Contrast', 100, 0, 200), P.ang('hue', 'Hue', 0), P.num('saturation', 'Saturation', 100, 0, 200), P.bool('split', 'Split Screen'), P.pct('splitPct', 'Split Percent', 50)],
  fs: `uniform float u_b, u_c, u_h, u_s, u_sp; uniform int u_split;
  void main(){ vec4 c = unpre(tex(uv*u_res)); vec2 p = toClip(uv*u_res);
    if (u_split == 1 && p.x / u_clip.x < u_sp) { o = pre(c); return; }
    vec3 r = (c.rgb - 0.5) * u_c + 0.5 + u_b; vec3 hsv = rgb2hsv(clamp(r, 0.0, 1.0)); hsv.x = fract(hsv.x + u_h);
    r = hsv2rgb(hsv); float l = luma(r); r = mix(vec3(l), r, u_s);
    o = pre(vec4(clamp(r, 0.0, 1.0), c.a)); }`,
  uniforms: (p) => ({ u_b: p.brightness / 100, u_c: p.contrast / 100, u_h: p.hue / 360, u_s: p.saturation / 100, u_split: p.split, u_sp: p.splitPct / 100 }),
});

reg({
  id: 'channelMixer', name: 'Channel Mixer', category: 'Adjust',
  params: [
    P.int('rr', 'Red-Red', 100, -200, 200), P.int('rg', 'Red-Green', 0, -200, 200), P.int('rb', 'Red-Blue', 0, -200, 200), P.int('rc', 'Red-Const', 0, -200, 200),
    P.int('gr', 'Green-Red', 0, -200, 200), P.int('gg', 'Green-Green', 100, -200, 200), P.int('gb', 'Green-Blue', 0, -200, 200), P.int('gc', 'Green-Const', 0, -200, 200),
    P.int('br', 'Blue-Red', 0, -200, 200), P.int('bg', 'Blue-Green', 0, -200, 200), P.int('bb', 'Blue-Blue', 100, -200, 200), P.int('bc', 'Blue-Const', 0, -200, 200),
    P.bool('mono', 'Monochrome'),
  ],
  fs: `uniform mat3 u_m; uniform vec3 u_kc; uniform int u_mono;
  void main(){ vec4 c = unpre(tex(uv*u_res)); vec3 r = u_m * c.rgb + u_kc; if (u_mono == 1) r = vec3(r.r);
    o = pre(vec4(clamp(r, 0.0, 1.0), c.a)); }`,
  uniforms: (p) => ({
    // column-major mat3
    u_m: [p.rr, p.gr, p.br, p.rg, p.gg, p.bg, p.rb, p.gb, p.bb].map((v) => v / 100),
    u_kc: [p.rc / 100, p.gc / 100, p.bc / 100], u_mono: p.mono,
  }),
});

// ============================== Blur & Sharpen ==============================

reg({
  id: 'gaussianBlur', name: 'Gaussian Blur', category: 'Blur & Sharpen',
  params: [P.num('blurriness', 'Blurriness', 0, 0, 500, { uiMax: 100 }), P.en('dims', 'Blur Dimensions', ['Horizontal and Vertical', 'Horizontal', 'Vertical'], 0), P.bool('repeat', 'Repeat Edge Pixels')],
  expand: (p) => (p.repeat ? 0 : p.blurriness * 1.3),
  render(ctx) {
    const s = ctx.p.blurriness * 0.42 * ctx.k;
    if (s < 0.05) return ctx.input;
    return gaussianBlur(ctx.gl, ctx.input, ctx.p.dims === 2 ? 0 : s, ctx.p.dims === 1 ? 0 : s, { repeatEdge: ctx.p.repeat, rect: clipRectBuf(ctx) });
  },
});

reg({
  id: 'cameraBlur', name: 'Camera Blur', category: 'Blur & Sharpen',
  params: [P.pct('amount', 'Percent Blur', 0)],
  expand: (p) => p.amount * 0.5,
  render(ctx) {
    const s = ctx.p.amount * 0.18 * ctx.k;
    if (s < 0.05) return ctx.input;
    return gaussianBlur(ctx.gl, ctx.input, s, s, { repeatEdge: true, rect: clipRectBuf(ctx) });
  },
});

reg({
  id: 'directionalBlur', name: 'Directional Blur', category: 'Blur & Sharpen',
  params: [P.ang('direction', 'Direction', 0), P.num('length', 'Blur Length', 0, 0, 1000, { uiMax: 100 })],
  expand: (p) => p.length,
  fs: `uniform vec2 u_d;
  void main(){ vec2 px = uv*u_res; vec4 acc = vec4(0.0); for (int i = 0; i < 40; i++){ float t = float(i) / 39.0 * 2.0 - 1.0; acc += tex(px + u_d * t); } o = acc / 40.0; }`,
  uniforms: (p, ctx) => ({ u_d: [Math.sin(rad(p.direction)) * p.length * 0.5 * ctx.k, -Math.cos(rad(p.direction)) * p.length * 0.5 * ctx.k] }),
});

reg({
  id: 'sharpen', name: 'Sharpen', category: 'Blur & Sharpen',
  params: [P.int('amount', 'Sharpen Amount', 0, 0, 4000, { uiMax: 100 })],
  fs: `uniform float u_a;
  void main(){ vec2 px = uv*u_res; vec4 c = tex(px);
    vec4 n = tex(px+vec2(1.0,0.0)) + tex(px-vec2(1.0,0.0)) + tex(px+vec2(0.0,1.0)) + tex(px-vec2(0.0,1.0));
    vec4 r = clamp(c + (c * 4.0 - n) * u_a, 0.0, 1.0); r.a = c.a; r.rgb = min(r.rgb, vec3(r.a)); o = r; }`,
  uniforms: (p) => ({ u_a: p.amount / 100 }),
});

reg({
  id: 'unsharpMask', name: 'Unsharp Mask', category: 'Blur & Sharpen',
  params: [P.num('amount', 'Amount', 50, 0, 500), P.num('radius', 'Radius', 1, 0.1, 250, { uiMax: 50 }), P.int('threshold', 'Threshold', 0, 0, 255)],
  render(ctx) {
    const p = ctx.p;
    const b = gaussianBlur(ctx.gl, ctx.input, p.radius * ctx.k, p.radius * ctx.k, { repeatEdge: true, rect: clipRectBuf(ctx) });
    const out = ctx.run('unsharp', `uniform sampler2D u_blur; uniform float u_a, u_t;
      void main(){ vec4 c = unpre(tex(uv*u_res)); vec4 b = unpre(texture(u_blur, uv)); vec3 d = c.rgb - b.rgb;
        vec3 m = step(vec3(u_t), abs(d)); o = pre(vec4(clamp(c.rgb + d * u_a * m, 0.0, 1.0), c.a)); }`,
    { u_blur: b, u_a: p.amount / 100, u_t: p.threshold / 255 });
    ctx.gl.release(b);
    return out;
  },
});

// ============================== Color Correction ==============================

reg({
  id: 'brightnessContrast', name: 'Brightness & Contrast', category: 'Color Correction',
  params: [P.num('brightness', 'Brightness', 0, -100, 100), P.num('contrast', 'Contrast', 0, -100, 100)],
  fs: `uniform float u_b, u_c;
  void main(){ vec4 c = unpre(tex(uv*u_res)); vec3 r = (c.rgb - 0.5) * u_c + 0.5 + u_b; o = pre(vec4(clamp(r, 0.0, 1.0), c.a)); }`,
  uniforms: (p) => ({ u_b: (p.brightness / 100) * 0.4, u_c: p.contrast >= 0 ? 1 + (p.contrast / 100) * 1.5 : 1 + p.contrast / 100 }),
});

reg({
  id: 'colorBalance', name: 'Color Balance', category: 'Color Correction',
  params: [
    P.num('sr', 'Shadow Red Balance', 0, -100, 100), P.num('sg', 'Shadow Green Balance', 0, -100, 100), P.num('sb', 'Shadow Blue Balance', 0, -100, 100),
    P.num('mr', 'Midtone Red Balance', 0, -100, 100), P.num('mg', 'Midtone Green Balance', 0, -100, 100), P.num('mb', 'Midtone Blue Balance', 0, -100, 100),
    P.num('hr', 'Highlight Red Balance', 0, -100, 100), P.num('hg', 'Highlight Green Balance', 0, -100, 100), P.num('hb', 'Highlight Blue Balance', 0, -100, 100),
    P.bool('preserve', 'Preserve Luminosity'),
  ],
  fs: `uniform vec3 u_s, u_m, u_h; uniform int u_pl;
  void main(){ vec4 c = unpre(tex(uv*u_res)); float l = luma(c.rgb);
    float ws = 1.0 - smoothstep(0.0, 0.5, l), wh = smoothstep(0.5, 1.0, l), wm = 1.0 - abs(l - 0.5) * 2.0;
    vec3 r = c.rgb + (u_s * ws + u_m * wm + u_h * wh) * 0.4;
    if (u_pl == 1) r += l - luma(r);
    o = pre(vec4(clamp(r, 0.0, 1.0), c.a)); }`,
  uniforms: (p) => ({ u_s: [p.sr / 100, p.sg / 100, p.sb / 100], u_m: [p.mr / 100, p.mg / 100, p.mb / 100], u_h: [p.hr / 100, p.hg / 100, p.hb / 100], u_pl: p.preserve }),
});

reg({
  id: 'changeColor', name: 'Change Color', category: 'Color Correction',
  params: [
    P.en('view', 'View', ['Corrected Layer', 'Color Correction Mask'], 0), P.ang('hue', 'Hue Transform', 0),
    P.num('light', 'Lightness Transform', 0, -100, 100), P.num('sat', 'Saturation Transform', 0, -100, 100),
    P.col('color', 'Color To Change', '#ff0000'), P.pct('tol', 'Matching Tolerance', 15), P.pct('soft', 'Matching Softness', 0),
    P.en('match', 'Match colors', ['Using RGB', 'Using Hue', 'Using Chroma'], 0), P.bool('invert', 'Invert Color Correction Mask'),
  ],
  fs: `uniform vec3 u_key; uniform float u_h, u_l, u_s, u_tol, u_soft; uniform int u_view, u_match, u_inv;
  float cdist(vec3 a, vec3 b){
    if (u_match == 1) { float d = abs(rgb2hsl(a).x - rgb2hsl(b).x); return min(d, 1.0 - d) * 2.0; }
    if (u_match == 2) { vec2 ca = vec2(a.b - luma(a), a.r - luma(a)), cb = vec2(b.b - luma(b), b.r - luma(b)); return distance(ca, cb); }
    return distance(a, b) / 1.732; }
  void main(){ vec4 c = unpre(tex(uv*u_res)); float d = cdist(c.rgb, u_key);
    float m = 1.0 - smoothstep(u_tol, u_tol + u_soft + 1e-4, d); if (u_inv == 1) m = 1.0 - m;
    if (u_view == 1) { o = vec4(vec3(m) * c.a, c.a); return; }
    vec3 hsl = rgb2hsl(c.rgb); hsl.x = fract(hsl.x + u_h * m); hsl.z = clamp(hsl.z + u_l * m * 0.5, 0.0, 1.0); hsl.y = clamp(hsl.y * (1.0 + u_s * m), 0.0, 1.0);
    o = pre(vec4(hsl2rgb(hsl), c.a)); }`,
  uniforms: (p) => ({ u_key: rgb(p.color), u_h: p.hue / 360, u_l: p.light / 100, u_s: p.sat / 100, u_tol: p.tol / 100, u_soft: p.soft / 100, u_view: p.view, u_match: p.match, u_inv: p.invert }),
});

reg({
  id: 'changeToColor', name: 'Change to Color', category: 'Color Correction',
  params: [
    P.col('from', 'From', '#ff0000'), P.col('to', 'To', '#0000ff'),
    P.en('change', 'Change', ['Hue', 'Hue & Lightness', 'Hue, Lightness & Saturation', 'Hue & Saturation'], 0),
    P.en('by', 'Change By', ['Setting To Color', 'Transforming To Color'], 0),
    P.pct('tolH', 'Hue', 5, 0, 100, { group: 'Tolerance' }), P.pct('tolL', 'Lightness', 50, 0, 100, { group: 'Tolerance' }), P.pct('tolS', 'Saturation', 50, 0, 100, { group: 'Tolerance' }),
    P.pct('soft', 'Softness', 50), P.bool('view', 'View Correction Matte'),
  ],
  fs: `uniform vec3 u_f, u_t; uniform vec3 u_tol; uniform float u_soft; uniform int u_change, u_by, u_view;
  void main(){ vec4 c = unpre(tex(uv*u_res)); vec3 a = rgb2hsl(c.rgb), f = rgb2hsl(u_f), t = rgb2hsl(u_t);
    float dh = abs(a.x - f.x); dh = min(dh, 1.0 - dh) * 2.0;
    float s = u_soft + 1e-3;
    float m = (1.0 - smoothstep(u_tol.x, u_tol.x + s * 0.2, dh)) * (1.0 - smoothstep(u_tol.y, u_tol.y + s, abs(a.z - f.z))) * (1.0 - smoothstep(u_tol.z, u_tol.z + s, abs(a.y - f.y)));
    if (u_view == 1) { o = vec4(vec3(m) * c.a, c.a); return; }
    vec3 r = a;
    if (u_by == 0) { r.x = t.x; if (u_change == 1 || u_change == 2) r.z = t.z; if (u_change >= 2) r.y = t.y; }
    else { r.x = fract(a.x + t.x - f.x); if (u_change == 1 || u_change == 2) r.z = clamp(a.z + t.z - f.z, 0.0, 1.0); if (u_change >= 2) r.y = clamp(a.y + t.y - f.y, 0.0, 1.0); }
    vec3 rr = hsl2rgb(r);
    o = pre(vec4(mix(c.rgb, rr, m), c.a)); }`,
  uniforms: (p) => ({ u_f: rgb(p.from), u_t: rgb(p.to), u_tol: [p.tolH / 100, p.tolL / 100, p.tolS / 100], u_soft: p.soft / 100, u_change: p.change, u_by: p.by, u_view: p.view }),
});

reg({
  id: 'leaveColor', name: 'Leave Color', category: 'Color Correction',
  params: [P.pct('amount', 'Amount to Decolor', 0), P.col('color', 'Color To Leave', '#ff0000'), P.pct('tol', 'Tolerance', 30), P.pct('soft', 'Edge Softness', 0), P.en('match', 'Match colors', ['Using RGB', 'Using Hue'], 0)],
  fs: `uniform vec3 u_key; uniform float u_a, u_tol, u_soft; uniform int u_match;
  void main(){ vec4 c = unpre(tex(uv*u_res)); float d;
    if (u_match == 1) { float dh = abs(rgb2hsl(c.rgb).x - rgb2hsl(u_key).x); d = min(dh, 1.0 - dh) * 2.0; } else d = distance(c.rgb, u_key) / 1.732;
    float m = smoothstep(u_tol, u_tol + u_soft + 1e-4, d);
    o = pre(vec4(mix(c.rgb, vec3(luma(c.rgb)), m * u_a), c.a)); }`,
  uniforms: (p) => ({ u_key: rgb(p.color), u_a: p.amount / 100, u_tol: p.tol / 100, u_soft: p.soft / 100, u_match: p.match }),
});

reg({
  id: 'tint', name: 'Tint', category: 'Color Correction',
  params: [P.col('black', 'Map Black To', '#000000'), P.col('white', 'Map White To', '#ffffff'), P.pct('amount', 'Amount to Tint', 100)],
  fs: `uniform vec3 u_b, u_w; uniform float u_a;
  void main(){ vec4 c = unpre(tex(uv*u_res)); vec3 t = mix(u_b, u_w, luma(c.rgb)); o = pre(vec4(mix(c.rgb, t, u_a), c.a)); }`,
  uniforms: (p) => ({ u_b: rgb(p.black), u_w: rgb(p.white), u_a: p.amount / 100 }),
});

reg({
  id: 'videoLimiter', name: 'Video Limiter', category: 'Color Correction',
  params: [P.pct('min', 'Signal Min', 0, 0, 100), P.pct('max', 'Signal Max', 100, 0, 100)],
  fs: `uniform float u_mn, u_mx; void main(){ vec4 c = unpre(tex(uv*u_res)); o = pre(vec4(clamp(c.rgb, u_mn, u_mx), c.a)); }`,
  uniforms: (p) => ({ u_mn: p.min / 100, u_mx: p.max / 100 }),
});

// ============================== Image Control ==============================

reg({
  id: 'blackWhite', name: 'Black & White', category: 'Image Control', params: [],
  fs: `void main(){ vec4 c = tex(uv*u_res); float l = luma(c.rgb); o = vec4(vec3(l), c.a); }`,
});

reg({
  id: 'colorPass', name: 'Color Pass', category: 'Image Control',
  params: [P.col('color', 'Color', '#ff0000'), P.pct('similarity', 'Similarity', 30), P.bool('reverse', 'Reverse')],
  fs: `uniform vec3 u_kc; uniform float u_s; uniform int u_rev;
  void main(){ vec4 c = unpre(tex(uv*u_res)); float d = distance(c.rgb, u_kc) / 1.732; float m = smoothstep(u_s * 0.9, u_s * 1.1 + 1e-3, d);
    if (u_rev == 1) m = 1.0 - m; o = pre(vec4(mix(c.rgb, vec3(luma(c.rgb)), m), c.a)); }`,
  uniforms: (p) => ({ u_kc: rgb(p.color), u_s: p.similarity / 100, u_rev: p.reverse }),
});

reg({
  id: 'colorReplace', name: 'Color Replace', category: 'Image Control',
  params: [P.col('target', 'Target Color', '#ff0000'), P.col('replace', 'Replace Color', '#00ff00'), P.pct('similarity', 'Similarity', 30), P.bool('solid', 'Solid Colors')],
  fs: `uniform vec3 u_t, u_r; uniform float u_s; uniform int u_solid;
  void main(){ vec4 c = unpre(tex(uv*u_res)); float d = distance(c.rgb, u_t) / 1.732; float m = 1.0 - smoothstep(u_s * 0.8, u_s + 1e-3, d);
    vec3 rep; if (u_solid == 1) rep = u_r; else { vec3 h = rgb2hsl(c.rgb), hr = rgb2hsl(u_r); rep = hsl2rgb(vec3(hr.x, hr.y, h.z)); }
    o = pre(vec4(mix(c.rgb, rep, m), c.a)); }`,
  uniforms: (p) => ({ u_t: rgb(p.target), u_r: rgb(p.replace), u_s: p.similarity / 100, u_solid: p.solid }),
});

reg({
  id: 'gammaCorrection', name: 'Gamma Correction', category: 'Image Control',
  params: [P.int('gamma', 'Gamma', 10, 1, 28)],
  fs: `uniform float u_g; void main(){ vec4 c = unpre(tex(uv*u_res)); o = pre(vec4(pow(c.rgb, vec3(u_g)), c.a)); }`,
  uniforms: (p) => ({ u_g: p.gamma / 10 }),
});

reg({
  id: 'colorBalanceRGB', name: 'Color Balance (RGB)', category: 'Image Control',
  params: [P.num('r', 'Red', 100, 0, 200), P.num('g', 'Green', 100, 0, 200), P.num('b', 'Blue', 100, 0, 200)],
  fs: `uniform vec3 u_m; void main(){ vec4 c = unpre(tex(uv*u_res)); o = pre(vec4(clamp(c.rgb * u_m, 0.0, 1.0), c.a)); }`,
  uniforms: (p) => ({ u_m: [p.r / 100, p.g / 100, p.b / 100] }),
});

// ============================== Channel ==============================

reg({
  id: 'invert', name: 'Invert', category: 'Channel',
  params: [P.en('channel', 'Channel', ['RGB', 'Red', 'Green', 'Blue', 'HLS', 'Hue', 'Lightness', 'Saturation', 'Alpha'], 0), P.pct('blend', 'Blend With Original', 0)],
  fs: `uniform int u_ch; uniform float u_b;
  void main(){ vec4 c = unpre(tex(uv*u_res)); vec4 r = c;
    if (u_ch == 0) r.rgb = 1.0 - c.rgb; else if (u_ch == 1) r.r = 1.0 - c.r; else if (u_ch == 2) r.g = 1.0 - c.g; else if (u_ch == 3) r.b = 1.0 - c.b;
    else if (u_ch >= 4 && u_ch <= 7) { vec3 h = rgb2hsl(c.rgb); if (u_ch == 4) h = vec3(fract(h.x + 0.5), 1.0 - h.y, 1.0 - h.z); if (u_ch == 5) h.x = fract(h.x + 0.5); if (u_ch == 6) h.z = 1.0 - h.z; if (u_ch == 7) h.y = 1.0 - h.y; r.rgb = hsl2rgb(h); }
    else if (u_ch == 8) r.a = 1.0 - c.a;
    o = pre(mix(r, c, u_b)); }`,
  uniforms: (p) => ({ u_ch: p.channel, u_b: p.blend / 100 }),
});

// ============================== Distort ==============================

function affineInverse(m) {
  // m = [a,b,c,d,e,f] for x' = a x + b y + c, y' = d x + e y + f
  const [a, b, c, d, e, f] = m;
  const det = a * e - b * d || 1e-9;
  const ia = e / det, ib = -b / det, id = -d / det, ie = a / det;
  return [ia, ib, -(ia * c + ib * f), id, ie, -(id * c + ie * f)];
}
const toMat3 = (m) => [m[0], m[3], 0, m[1], m[4], 0, m[2], m[5], 1]; // column-major

reg({
  id: 'transform', name: 'Transform', category: 'Distort',
  params: [
    P.pt('anchor', 'Anchor Point'), P.pt('position', 'Position'), P.bool('uniform', 'Uniform Scale', true),
    P.num('scaleH', 'Scale Height', 100, 0, 10000, { uiMax: 600 }), P.num('scaleW', 'Scale Width', 100, 0, 10000, { uiMax: 600, enabledIf: (p) => !p.uniform.v }),
    P.num('skew', 'Skew', 0, -70, 70), P.ang('skewAxis', 'Skew Axis', 0), P.ang('rotation', 'Rotation', 0), P.pct('opacity', 'Opacity', 100),
  ],
  expand(p, c) {
    const s = Math.max(p.scaleH, p.uniform ? p.scaleH : p.scaleW) / 100;
    const dx = Math.abs(p.position[0] - p.anchor[0]), dy = Math.abs(p.position[1] - p.anchor[1]);
    const diag = Math.hypot(c.w, c.h);
    return Math.min(2000, Math.max(0, diag * s - Math.min(c.w, c.h) * 0.5) + Math.max(dx, dy));
  },
  render(ctx) {
    const p = ctx.p;
    const sx = (p.uniform ? p.scaleH : p.scaleW) / 100, sy = p.scaleH / 100;
    const r = rad(p.rotation), sk = Math.tan(rad(p.skew)), sa = rad(p.skewAxis);
    // forward: c' = pos + R * Skew * S * (c - anchor)
    const cs = Math.cos(r), sn = Math.sin(r);
    // skew along axis: rotate by -sa, shear x by sk*y, rotate back by sa
    const ca = Math.cos(sa), sa2 = Math.sin(sa);
    const R1 = [ca, sa2, -sa2, ca]; // rot(-sa) as [a b; c d]
    const Sh = [1, sk, 0, 1];
    const R2 = [ca, -sa2, sa2, ca];
    const mul = (A, B) => [A[0] * B[0] + A[1] * B[2], A[0] * B[1] + A[1] * B[3], A[2] * B[0] + A[3] * B[2], A[2] * B[1] + A[3] * B[3]];
    let M = mul(R2, mul(Sh, R1));
    M = mul([cs, -sn, sn, cs], mul(M, [sx, 0, 0, sy]));
    const fwd = [M[0], M[1], p.position[0] - (M[0] * p.anchor[0] + M[1] * p.anchor[1]), M[2], M[3], p.position[1] - (M[2] * p.anchor[0] + M[3] * p.anchor[1])];
    const inv = affineInverse(fwd);
    return ctx.run('transform', `uniform mat3 u_inv; uniform float u_op;
      void main(){ vec2 c = toClip(uv*u_res); vec2 s = (u_inv * vec3(c, 1.0)).xy;
        if (!inClip(s)) { o = vec4(0.0); return; }
        vec2 e = min(s, u_clip - s) * u_k; float aa = clamp(min(e.x, e.y) + 0.5, 0.0, 1.0);
        o = texc(s) * u_op * aa; }`, { u_inv: toMat3(inv), u_op: p.opacity / 100 });
  },
});

reg({
  id: 'cornerPin', name: 'Corner Pin', category: 'Distort',
  params: [P.pt('ul', 'Upper Left', relPt(0, 0)), P.pt('ur', 'Upper Right', relPt(1, 0)), P.pt('ll', 'Lower Left', relPt(0, 1)), P.pt('lr', 'Lower Right', relPt(1, 1))],
  expand(p, c) {
    const xs = [p.ul[0], p.ur[0], p.ll[0], p.lr[0]], ys = [p.ul[1], p.ur[1], p.ll[1], p.lr[1]];
    return Math.min(3000, Math.max(0, -Math.min(...xs), -Math.min(...ys), Math.max(...xs) - c.w, Math.max(...ys) - c.h));
  },
  render(ctx) {
    const p = ctx.p;
    const [x0, y0] = p.ul, [x1, y1] = p.ur, [x2, y2] = p.lr, [x3, y3] = p.ll;
    const dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3;
    const dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3;
    let a, b, c, d, e, f, g, hh;
    const den = dx1 * dy2 - dx2 * dy1 || 1e-9;
    g = (dx3 * dy2 - dx2 * dy3) / den;
    hh = (dx1 * dy3 - dx3 * dy1) / den;
    a = x1 - x0 + g * x1; b = x3 - x0 + hh * x3; c = x0;
    d = y1 - y0 + g * y1; e = y3 - y0 + hh * y3; f = y0;
    // invert 3x3 [[a b c][d e f][g h 1]]
    const m = [a, b, c, d, e, f, g, hh, 1];
    const inv = invert3(m);
    return ctx.run('cornerPin', `uniform mat3 u_h;
      void main(){ vec2 c = toClip(uv*u_res); vec3 q = u_h * vec3(c, 1.0); vec2 st = q.xy / q.z;
        if (q.z <= 0.0 || st.x < 0.0 || st.y < 0.0 || st.x > 1.0 || st.y > 1.0) { o = vec4(0.0); return; }
        o = texc(st * u_clip); }`, { u_h: [inv[0], inv[3], inv[6], inv[1], inv[4], inv[7], inv[2], inv[5], inv[8]] });
  },
});

function invert3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C || 1e-12;
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
}

reg({
  id: 'lensDistortion', name: 'Lens Distortion', category: 'Distort',
  params: [P.num('curvature', 'Curvature', 0, -100, 100), P.num('vdec', 'Vertical Decentering', 0, -100, 100), P.num('hdec', 'Horizontal Decentering', 0, -100, 100), P.num('vprism', 'Vertical Prism FX', 0, -100, 100), P.num('hprism', 'Horizontal Prism FX', 0, -100, 100), P.bool('fillAlpha', 'Fill Alpha', true), P.col('fill', 'Fill Color', '#ffffff')],
  fs: `uniform float u_k2; uniform vec2 u_dec, u_prism; uniform int u_fa; uniform vec3 u_fill;
  void main(){ vec2 c = toClip(uv*u_res); if (!inClip(c)) { o = vec4(0.0); return; }
    vec2 n = (c / u_clip) * 2.0 - 1.0 - u_dec; float asp = u_clip.x / u_clip.y; vec2 q = vec2(n.x * asp, n.y);
    float r2 = dot(q, q); vec2 d = n * (1.0 + u_k2 * r2) + u_prism * n * n.yx; vec2 s = (d + 1.0 + u_dec) * 0.5 * u_clip;
    if (!inClip(s)) { o = u_fa == 1 ? vec4(0.0) : vec4(u_fill, 1.0); return; }
    o = texc(s); }`,
  uniforms: (p) => ({ u_k2: (-p.curvature / 100) * 0.45, u_dec: [p.hdec / 200, p.vdec / 200], u_prism: [p.hprism / 200, p.vprism / 200], u_fa: p.fillAlpha, u_fill: rgb(p.fill) }),
});

reg({
  id: 'magnify', name: 'Magnify', category: 'Distort',
  params: [P.en('shape', 'Shape', ['Circle', 'Square'], 0), P.pt('center', 'Center'), P.num('mag', 'Magnification', 200, 100, 600), P.num('size', 'Size', 120, 10, 2000, { uiMax: 600 }), P.num('feather', 'Feather', 0, 0, 500, { uiMax: 100 }), P.pct('opacity', 'Opacity', 100)],
  fs: `uniform int u_sh; uniform vec2 u_c; uniform float u_m, u_sz, u_f, u_op;
  void main(){ vec2 c = toClip(uv*u_res); vec4 base = texc(c); vec2 d = c - u_c;
    float dist = u_sh == 0 ? length(d) : max(abs(d.x), abs(d.y));
    float m = 1.0 - smoothstep(u_sz - u_f - 0.5, u_sz + 0.5, dist);
    vec4 mg = texc(u_c + d / u_m); o = mix(base, mg, m * u_op); }`,
  uniforms: (p) => ({ u_sh: p.shape, u_c: p.center, u_m: p.mag / 100, u_sz: p.size, u_f: p.feather, u_op: p.opacity / 100 }),
});

reg({
  id: 'mirror', name: 'Mirror', category: 'Distort',
  params: [P.pt('center', 'Reflection Center'), P.ang('angle', 'Reflection Angle', 0)],
  fs: `uniform vec2 u_c, u_n;
  void main(){ vec2 c = toClip(uv*u_res); float d = dot(c - u_c, u_n); if (d > 0.0) c -= 2.0 * d * u_n; o = inClip(c) ? texc(c) : vec4(0.0); }`,
  uniforms: (p) => ({ u_c: p.center, u_n: [Math.cos(rad(p.angle)), Math.sin(rad(p.angle))] }),
});

reg({
  id: 'offset', name: 'Offset', category: 'Distort',
  params: [P.pt('shift', 'Shift Center To'), P.pct('blend', 'Blend With Original', 0)],
  fs: `uniform vec2 u_d; uniform float u_b;
  void main(){ vec2 c = toClip(uv*u_res); if (!inClip(c)) { o = vec4(0.0); return; } vec2 s = mod(c - u_d, u_clip); o = mix(texc(s), texc(c), u_b); }`,
  uniforms: (p, ctx) => ({ u_d: [p.shift[0] - ctx.clipW / 2, p.shift[1] - ctx.clipH / 2], u_b: p.blend / 100 }),
});

reg({
  id: 'spherize', name: 'Spherize', category: 'Distort',
  params: [P.num('radius', 'Radius', 0, 0, 2500, { uiMax: 1000 }), P.pt('center', 'Center of Sphere')],
  fs: `uniform float u_r; uniform vec2 u_c;
  void main(){ vec2 c = toClip(uv*u_res); vec2 d = c - u_c; float r = length(d) / max(u_r, 1e-3);
    if (r < 1.0 && r > 0.0) { float f = (1.0 - sqrt(1.0 - r * r)) / r; c = u_c + normalize(d) * f * u_r; }
    o = texc(c); }`,
  uniforms: (p) => ({ u_r: p.radius, u_c: p.center }),
});

reg({
  id: 'twirl', name: 'Twirl', category: 'Distort',
  params: [P.ang('angle', 'Angle', 0), P.pct('radius', 'Twirl Radius', 50, 0, 100), P.pt('center', 'Twirl Center')],
  fs: `uniform float u_a, u_r; uniform vec2 u_c;
  void main(){ vec2 c = toClip(uv*u_res); vec2 d = c - u_c; float r = length(d) / max(u_r, 1e-3);
    if (r < 1.0) { float t = (1.0 - r); d = rot2(d, -u_a * t * t); c = u_c + d; }
    o = texc(c); }`,
  uniforms: (p, ctx) => ({ u_a: rad(p.angle), u_r: (p.radius / 100) * Math.max(ctx.clipW, ctx.clipH) * 0.5, u_c: p.center }),
});

reg({
  id: 'waveWarp', name: 'Wave Warp', category: 'Distort',
  params: [
    P.en('type', 'Wave Type', ['Sine', 'Square', 'Triangle', 'Sawtooth', 'Circle', 'Semicircle', 'Uncircle', 'Noise', 'Smooth Noise'], 0),
    P.num('height', 'Wave Height', 10, -1000, 1000, { uiMin: 0, uiMax: 100 }), P.num('width', 'Wave Width', 40, 1, 2000, { uiMax: 300 }),
    P.ang('direction', 'Direction', 90), P.num('speed', 'Wave Speed', 1, -10, 10, { step: 0.01, precision: 2 }),
    P.en('pinning', 'Pinning', ['None', 'All Edges', 'Center', 'Left Edge', 'Top Edge', 'Right Edge', 'Bottom Edge'], 0), P.ang('phase', 'Phase', 0),
  ],
  expand: (p) => Math.abs(p.height),
  fs: `uniform int u_type, u_pin; uniform float u_h, u_w, u_sp, u_ph; uniform vec2 u_dir;
  float wave(float x){ float f = fract(x);
    if (u_type == 0) return sin(x * 6.2831853);
    if (u_type == 1) return f < 0.5 ? 1.0 : -1.0;
    if (u_type == 2) return 1.0 - 4.0 * abs(f - 0.5);
    if (u_type == 3) return f * 2.0 - 1.0;
    if (u_type == 4) { float t = f * 2.0 - 1.0; return sqrt(max(0.0, 1.0 - t * t)) * (fract(x * 0.5) < 0.5 ? 1.0 : -1.0); }
    if (u_type == 5) { float t = f * 2.0 - 1.0; return sqrt(max(0.0, 1.0 - t * t)); }
    if (u_type == 6) { float t = f * 2.0 - 1.0; return 1.0 - sqrt(max(0.0, 1.0 - t * t)); }
    if (u_type == 7) return hash12(vec2(floor(x * 8.0), 3.1)) * 2.0 - 1.0;
    return vnoise(vec2(x * 3.0, 1.7)) * 2.0 - 1.0; }
  void main(){ vec2 c = toClip(uv*u_res); vec2 perp = vec2(-u_dir.y, u_dir.x);
    float x = dot(c, u_dir) / u_w - u_time * u_sp + u_ph; float pin = 1.0; vec2 n = c / u_clip;
    if (u_pin == 1) pin = clamp(min(min(n.x, 1.0 - n.x), min(n.y, 1.0 - n.y)) * 6.0, 0.0, 1.0);
    else if (u_pin == 2) pin = clamp(length(n - 0.5) * 3.0, 0.0, 1.0);
    else if (u_pin == 3) pin = clamp(n.x * 4.0, 0.0, 1.0); else if (u_pin == 4) pin = clamp(n.y * 4.0, 0.0, 1.0);
    else if (u_pin == 5) pin = clamp((1.0 - n.x) * 4.0, 0.0, 1.0); else if (u_pin == 6) pin = clamp((1.0 - n.y) * 4.0, 0.0, 1.0);
    vec2 s = c - perp * u_h * wave(x) * pin; o = inClip(s) ? texc(s) : vec4(0.0); }`,
  uniforms: (p, ctx) => ({ u_type: p.type, u_pin: p.pinning, u_h: p.height, u_w: p.width, u_sp: p.speed, u_ph: p.phase / 360, u_dir: [Math.sin(rad(p.direction)), -Math.cos(rad(p.direction))] }),
});

reg({
  id: 'turbulentDisplace', name: 'Turbulent Displace', category: 'Distort',
  params: [
    P.en('type', 'Displacement', ['Turbulent', 'Bulge', 'Twist', 'Horizontal Displacement', 'Vertical Displacement'], 0),
    P.num('amount', 'Amount', 50, -1000, 1000, { uiMin: -200, uiMax: 200 }), P.num('size', 'Size', 100, 2, 1000, { uiMax: 400 }),
    P.pt('offset', 'Offset (Turbulence)'), P.num('complexity', 'Complexity', 1, 1, 10), P.ang('evolution', 'Evolution', 0),
  ],
  expand: (p) => Math.abs(p.amount) * 0.6,
  fs: `uniform int u_type; uniform float u_amt, u_sz, u_ev, u_cx; uniform vec2 u_off;
  void main(){ vec2 c = toClip(uv*u_res); vec2 q = (c + u_off) / u_sz;
    float e = u_ev; vec2 d = vec2(fbm(q + vec2(e, 0.0)), fbm(q + vec2(5.2, 1.3 + e))) - 0.5;
    if (u_type == 1) d = normalize(c - u_clip * 0.5 + 1e-3) * (fbm(q + e) - 0.3);
    else if (u_type == 2) d = rot2(c - u_clip * 0.5, (fbm(q + e) - 0.5) * 0.6) - (c - u_clip * 0.5), d /= max(1.0, u_amt) * 0.01;
    else if (u_type == 3) d.y = 0.0; else if (u_type == 4) d.x = 0.0;
    vec2 s = c + d * u_amt * (0.8 + u_cx * 0.1); o = inClip(s) ? texc(s) : vec4(0.0); }`,
  uniforms: (p, ctx) => ({ u_type: p.type, u_amt: p.amount, u_sz: p.size, u_ev: rad(p.evolution), u_cx: p.complexity, u_off: [p.offset[0] - ctx.clipW / 2, p.offset[1] - ctx.clipH / 2] }),
});

// ============================== Generate ==============================

reg({
  id: 'fourColorGradient', name: '4-Color Gradient', category: 'Generate',
  params: [
    P.pt('p1', 'Point 1', relPt(0.1, 0.1), { group: 'Positions & Colors' }), P.col('c1', 'Color 1', '#ffff00', { group: 'Positions & Colors' }),
    P.pt('p2', 'Point 2', relPt(0.9, 0.1), { group: 'Positions & Colors' }), P.col('c2', 'Color 2', '#00ff00', { group: 'Positions & Colors' }),
    P.pt('p3', 'Point 3', relPt(0.1, 0.9), { group: 'Positions & Colors' }), P.col('c3', 'Color 3', '#ff00ff', { group: 'Positions & Colors' }),
    P.pt('p4', 'Point 4', relPt(0.9, 0.9), { group: 'Positions & Colors' }), P.col('c4', 'Color 4', '#0000ff', { group: 'Positions & Colors' }),
    P.num('blend', 'Blend', 100, 1, 1000, { uiMax: 400 }), P.num('jitter', 'Jitter', 0, 0, 100), P.pct('opacity', 'Opacity', 100), P.en('mode', 'Blending Mode', GEN_MODES, 0),
  ],
  fs: GEN_BLEND + `uniform vec2 u_p[4]; uniform vec3 u_c[4]; uniform float u_bl, u_j, u_op; uniform int u_mode;
  void main(){ vec2 c = toClip(uv*u_res); vec4 src = tex(uv*u_res); if (!inClip(c)) { o = src; return; }
    float pw = 2.0 + 300.0 / u_bl; vec3 acc = vec3(0.0); float ws = 0.0;
    for (int i = 0; i < 4; i++){ float d = distance(c, u_p[i]) / length(u_clip) + 1e-4; float w = 1.0 / pow(d, pw); acc += u_c[i] * w; ws += w; }
    vec3 g = acc / ws + (hash12(c) - 0.5) * u_j * 0.01;
    o = genComposite(src, g, 1.0, u_mode, u_op); }`,
  uniforms: (p) => ({ u_p: [...p.p1, ...p.p2, ...p.p3, ...p.p4], u_c: [...rgb(p.c1), ...rgb(p.c2), ...rgb(p.c3), ...rgb(p.c4)], u_bl: p.blend, u_j: p.jitter, u_op: p.opacity / 100, u_mode: p.mode }),
});

reg({
  id: 'ramp', name: 'Ramp', category: 'Generate',
  params: [P.pt('start', 'Start of Ramp', relPt(0.5, 0)), P.col('startColor', 'Start Color', '#000000'), P.pt('end', 'End of Ramp', relPt(0.5, 1)), P.col('endColor', 'End Color', '#ffffff'), P.en('shape', 'Ramp Shape', ['Linear Ramp', 'Radial Ramp'], 0), P.num('scatter', 'Ramp Scatter', 0, 0, 100), P.pct('blend', 'Blend With Original', 0)],
  fs: `uniform vec2 u_s, u_e; uniform vec3 u_sc, u_ec; uniform int u_shape; uniform float u_sca, u_bl;
  void main(){ vec2 c = toClip(uv*u_res); vec4 src = tex(uv*u_res); if (!inClip(c)) { o = src; return; }
    float t; vec2 d = u_e - u_s; if (u_shape == 0) t = dot(c - u_s, d) / max(dot(d, d), 1e-3); else t = distance(c, u_s) / max(length(d), 1e-3);
    t = clamp(t + (hash12(c) - 0.5) * u_sca * 0.02, 0.0, 1.0); vec3 g = mix(u_sc, u_ec, t);
    vec4 s = unpre(src); o = vec4(mix(g, s.rgb, u_bl * s.a), 1.0); }`,
  uniforms: (p) => ({ u_s: p.start, u_e: p.end, u_sc: rgb(p.startColor), u_ec: rgb(p.endColor), u_shape: p.shape, u_sca: p.scatter, u_bl: p.blend / 100 }),
});

reg({
  id: 'circle', name: 'Circle', category: 'Generate',
  params: [
    P.pt('center', 'Center'), P.num('radius', 'Radius', 100, 0, 5000, { uiMax: 1000 }),
    P.en('edge', 'Edge', ['None', 'Edge Radius', 'Thickness', 'Thickness * Radius', 'Thickness & Feather * Radius'], 0),
    P.num('thickness', 'Thickness', 10, 0, 1000, { uiMax: 200 }), P.num('featherOut', 'Feather Outer Edge', 0, 0, 1000, { uiMax: 200, group: 'Feather' }), P.num('featherIn', 'Feather Inner Edge', 0, 0, 1000, { uiMax: 200, group: 'Feather' }),
    P.bool('invert', 'Invert Circle'), P.col('color', 'Color', '#ffffff'), P.pct('opacity', 'Opacity', 100),
    P.en('mode', 'Blending Mode', ['None', 'Normal', 'Add', 'Multiply', 'Screen', 'Overlay', 'Soft Light', 'Color Dodge', 'Color Burn', 'Darken', 'Lighten', 'Difference', 'Stencil Alpha', 'Silhouette Alpha'], 0),
  ],
  fs: GEN_BLEND + `uniform vec2 u_c; uniform float u_r, u_th, u_fo, u_fi, u_op; uniform int u_edge, u_inv, u_mode; uniform vec3 u_col;
  void main(){ vec2 c = toClip(uv*u_res); vec4 src = tex(uv*u_res); float d = distance(c, u_c);
    float outer = u_r, inner = -1.0;
    if (u_edge == 1) inner = u_th; else if (u_edge == 2) inner = u_r - u_th; else if (u_edge == 3) inner = u_r - u_th * u_r * 0.01; else if (u_edge == 4) inner = u_r - u_th * u_r * 0.01;
    float a = 1.0 - smoothstep(outer - u_fo * 0.5 - 0.5, outer + u_fo * 0.5 + 0.5, d);
    if (inner >= 0.0) a *= smoothstep(inner - u_fi * 0.5 - 0.5, inner + u_fi * 0.5 + 0.5, d);
    if (u_inv == 1) a = 1.0 - a;
    if (!inClip(c) && u_mode != 0) a = 0.0;
    if (u_mode == 12) { o = src * a * u_op + src * (1.0 - u_op); return; }
    if (u_mode == 13) { o = src * (1.0 - a * u_op); return; }
    o = genComposite(src, u_col, a, u_mode, u_op); }`,
  uniforms: (p) => ({ u_c: p.center, u_r: p.radius, u_th: p.thickness, u_fo: p.featherOut, u_fi: p.featherIn, u_op: p.opacity / 100, u_edge: p.edge, u_inv: p.invert, u_mode: p.mode, u_col: rgb(p.color) }),
});

reg({
  id: 'ellipse', name: 'Ellipse', category: 'Generate',
  params: [P.pt('center', 'Center'), P.num('width', 'Width', 300, 0, 5000, { uiMax: 2000 }), P.num('height', 'Height', 200, 0, 5000, { uiMax: 2000 }), P.num('thickness', 'Thickness', 12, 0, 1000, { uiMax: 200 }), P.num('softness', 'Softness', 10, 0, 100), P.col('inside', 'Inside Color', '#ffffff'), P.col('outside', 'Outside Color', '#ff0000'), P.bool('composite', 'Composite On Original')],
  fs: `uniform vec2 u_c, u_sz; uniform float u_th, u_so; uniform vec3 u_in, u_out; uniform int u_comp;
  void main(){ vec2 c = toClip(uv*u_res); vec4 src = tex(uv*u_res); vec2 d = (c - u_c) / max(u_sz * 0.5, vec2(1.0)); float r = length(d) * min(u_sz.x, u_sz.y) * 0.5;
    float R = min(u_sz.x, u_sz.y) * 0.5; float dist = abs(r - R); float hw = u_th * 0.5; float s = max(1.0, u_so * 0.01 * hw + 0.5);
    float ring = 1.0 - smoothstep(hw - s, hw + s, dist);
    vec3 col = mix(u_out, u_in, 1.0 - smoothstep(0.0, hw + s, dist));
    if (u_comp == 1) o = vec4(col * ring, ring) + src * (1.0 - ring); else o = vec4(col * ring, ring); }`,
  uniforms: (p) => ({ u_c: p.center, u_sz: [p.width, p.height], u_th: p.thickness, u_so: p.softness, u_in: rgb(p.inside), u_out: rgb(p.outside), u_comp: p.composite }),
});

reg({
  id: 'checkerboard', name: 'Checkerboard', category: 'Generate',
  params: [P.pt('anchor', 'Anchor'), P.num('width', 'Width', 64, 1, 2000, { uiMax: 500 }), P.num('height', 'Height', 64, 1, 2000, { uiMax: 500 }), P.num('feather', 'Feather', 0, 0, 100), P.col('color', 'Color', '#ffffff'), P.pct('opacity', 'Opacity', 100), P.en('mode', 'Blending Mode', GEN_MODES, 0)],
  fs: GEN_BLEND + `uniform vec2 u_a, u_sz; uniform float u_f, u_op; uniform int u_mode; uniform vec3 u_col;
  void main(){ vec2 c = toClip(uv*u_res); vec4 src = tex(uv*u_res); if (!inClip(c)) { o = src; return; }
    vec2 q = (c - u_a) / u_sz; vec2 f = fract(q); vec2 e = min(f, 1.0 - f) * u_sz; float soft = max(u_f, 0.5);
    float chk = mod(floor(q.x) + floor(q.y), 2.0); float edge = smoothstep(0.0, soft, min(e.x, e.y));
    float a = chk * edge; o = genComposite(src, u_col, a, u_mode, u_op); }`,
  uniforms: (p) => ({ u_a: p.anchor, u_sz: [p.width, p.height], u_f: p.feather, u_op: p.opacity / 100, u_mode: p.mode, u_col: rgb(p.color) }),
});

reg({
  id: 'grid', name: 'Grid', category: 'Generate',
  params: [P.pt('anchor', 'Anchor'), P.num('width', 'Width', 100, 1, 3000, { uiMax: 600 }), P.num('height', 'Height', 100, 1, 3000, { uiMax: 600 }), P.num('border', 'Border', 3, 0, 500, { uiMax: 50 }), P.num('feather', 'Feather', 0, 0, 100), P.bool('invert', 'Invert Grid'), P.col('color', 'Color', '#ffffff'), P.pct('opacity', 'Opacity', 100), P.en('mode', 'Blending Mode', GEN_MODES, 1)],
  fs: GEN_BLEND + `uniform vec2 u_a, u_sz; uniform float u_b, u_f, u_op; uniform int u_mode, u_inv; uniform vec3 u_col;
  void main(){ vec2 c = toClip(uv*u_res); vec4 src = tex(uv*u_res); if (!inClip(c)) { o = src; return; }
    vec2 q = mod(c - u_a, u_sz); vec2 e = min(q, u_sz - q); float d = min(e.x, e.y);
    float a = 1.0 - smoothstep(u_b * 0.5 - 0.5, u_b * 0.5 + 0.5 + u_f, d); if (u_inv == 1) a = 1.0 - a;
    o = genComposite(src, u_col, a, u_mode, u_op); }`,
  uniforms: (p) => ({ u_a: p.anchor, u_sz: [p.width, p.height], u_b: p.border, u_f: p.feather, u_op: p.opacity / 100, u_mode: p.mode, u_inv: p.invert, u_col: rgb(p.color) }),
});

reg({
  id: 'lensFlare', name: 'Lens Flare', category: 'Generate',
  params: [P.pt('center', 'Flare Center', relPt(0.3, 0.3)), P.pct('brightness', 'Flare Brightness', 100, 0, 300), P.en('lens', 'Lens Type', ['50-300mm Zoom', '35mm Prime', '105mm Prime'], 0), P.pct('blend', 'Blend With Original', 0)],
  fs: `uniform vec2 u_c; uniform float u_b, u_bl; uniform int u_lens;
  vec3 flare(vec2 c){ vec2 ctr = u_clip * 0.5; float sc = length(u_clip); vec2 d = (c - u_c) / sc; float r = length(d);
    vec3 col = vec3(1.0, 0.95, 0.85) * (0.02 / (r + 0.02)) * 0.9;
    col += vec3(1.0, 0.7, 0.4) * exp(-r * 18.0) * 0.8;
    float ang = atan(d.y, d.x); col += vec3(0.9, 0.8, 1.0) * pow(abs(cos(ang * (u_lens == 1 ? 6.0 : 4.0))), 60.0) * exp(-r * 6.0) * 0.4;
    vec2 axis = (ctr - u_c);
    for (int i = 1; i <= 6; i++) { float f = float(i) * (u_lens == 2 ? 0.28 : 0.35); vec2 gp = u_c + axis * f * 1.6; float gr = sc * (0.01 + 0.02 * float(i % 3));
      float g = 1.0 - smoothstep(gr * 0.7, gr, distance(c, gp)); col += vec3(0.3 + 0.1 * float(i % 2), 0.5, 0.8 - 0.1 * float(i % 3)) * g * 0.12; }
    float ring = exp(-pow((r - 0.18) * 30.0, 2.0)) * 0.08; col += vec3(0.4, 0.6, 1.0) * ring;
    return col * u_b; }
  void main(){ vec2 c = toClip(uv*u_res); vec4 src = tex(uv*u_res); vec4 s = unpre(src);
    vec3 r = 1.0 - (1.0 - s.rgb) * (1.0 - clamp(flare(c), 0.0, 1.0));
    o = pre(vec4(mix(r, s.rgb, u_bl), s.a)); }`,
  uniforms: (p) => ({ u_c: p.center, u_b: p.brightness / 100, u_bl: p.blend / 100, u_lens: p.lens }),
});

// ============================== Keying ==============================

reg({
  id: 'ultraKey', name: 'Ultra Key', category: 'Keying',
  params: [
    P.en('output', 'Output', ['Composite', 'Alpha Channel', 'Color Channel'], 0),
    P.en('setting', 'Setting', ['Default', 'Relaxed', 'Aggressive', 'Custom'], 0),
    P.col('key', 'Key Color', '#22d34a'),
    P.num('transparency', 'Transparency', 45, 0, 100, { group: 'Matte Generation' }), P.num('highlight', 'Highlight', 10, 0, 100, { group: 'Matte Generation' }),
    P.num('shadow', 'Shadow', 50, 0, 100, { group: 'Matte Generation' }), P.num('tolerance', 'Tolerance', 50, 0, 100, { group: 'Matte Generation' }), P.num('pedestal', 'Pedestal', 10, 0, 100, { group: 'Matte Generation' }),
    P.num('choke', 'Choke', 0, 0, 100, { group: 'Matte Cleanup' }), P.num('soften', 'Soften', 0, 0, 100, { group: 'Matte Cleanup' }), P.num('contrast', 'Contrast', 0, 0, 100, { group: 'Matte Cleanup' }), P.num('midpoint', 'Mid Point', 50, 0, 100, { group: 'Matte Cleanup' }),
    P.num('desat', 'Desaturate', 25, 0, 100, { group: 'Spill Suppression' }), P.num('range', 'Range', 50, 0, 100, { group: 'Spill Suppression' }), P.num('spill', 'Spill', 50, 0, 100, { group: 'Spill Suppression' }), P.num('spillLuma', 'Luma', 50, 0, 100, { group: 'Spill Suppression' }),
    P.num('ccSat', 'Saturation', 100, 0, 200, { group: 'Color Correction' }), P.num('ccHue', 'Hue', 0, -180, 180, { group: 'Color Correction' }), P.num('ccLum', 'Luminance', 100, 0, 200, { group: 'Color Correction' }),
  ],
  render(ctx) {
    const p = ctx.p;
    const mult = p.setting === 1 ? 0.8 : p.setting === 2 ? 1.25 : 1;
    let out = ctx.run('ultraKey', `uniform vec3 u_key; uniform float u_tr, u_hi, u_sh, u_tol, u_ped, u_ch, u_con, u_mid, u_des, u_rng, u_sp, u_spl, u_cs, u_chue, u_cl; uniform int u_out;
      vec3 ycc(vec3 c){ float y = dot(c, vec3(0.299, 0.587, 0.114)); return vec3(y, (c.b - y) * 0.564, (c.r - y) * 0.713); }
      vec3 rgbOf(vec3 q){ float r = q.x + 1.403 * q.z; float b = q.x + 1.773 * q.y; float g = (q.x - 0.299 * r - 0.114 * b) / 0.587; return vec3(r, g, b); }
      void main(){ vec4 src = unpre(tex(uv*u_res)); vec3 k = ycc(u_key), p = ycc(src.rgb);
        vec2 kd = k.yz; float kc = max(length(kd), 0.02); vec2 kn = kd / kc;
        float pc = length(p.yz); float along = dot(p.yz, kn);
        float cosA = pc > 1e-4 ? along / pc : 0.0;
        float tolA = mix(0.97, 0.55, u_tol);
        float angM = smoothstep(tolA - 0.06 - u_ped * 0.1, tolA + 0.03, cosA);
        float lo = (0.12 + u_ped * 0.25) * (1.0 - u_sh * 0.6);
        float magM = smoothstep(lo, lo + 0.3, pc / kc);
        float keyed = angM * magM;
        keyed = pow(keyed, mix(2.5, 0.4, u_tr));
        float m = 1.0 - keyed;
        float lumaDiff = p.x - k.x;
        m = max(m, smoothstep(0.35, 0.8, lumaDiff) * u_hi);
        m = clamp((m - u_ch * 0.5) / max(1.0 - u_ch * 0.5, 1e-3), 0.0, 1.0);
        m = clamp((m - u_mid) * (1.0 + u_con * 4.0) + u_mid, 0.0, 1.0);
        // spill suppression
        float spillAmt = max(0.0, along) * u_sp * 1.6 * (1.0 - m * (1.0 - u_rng));
        vec3 q = p; q.yz -= kn * min(spillAmt, max(0.0, along)); q.yz *= 1.0 - u_des * clamp(spillAmt * 4.0, 0.0, 1.0);
        q.x += (k.x - 0.5) * spillAmt * (u_spl - 0.5) * 0.4;
        vec3 col = clamp(rgbOf(q), 0.0, 1.0);
        vec3 hsv = rgb2hsv(col); hsv.x = fract(hsv.x + u_chue); hsv.y = clamp(hsv.y * u_cs, 0.0, 1.0); hsv.z = clamp(hsv.z * u_cl, 0.0, 1.0); col = hsv2rgb(hsv);
        float a = m * src.a;
        if (u_out == 1) { o = vec4(vec3(a), 1.0); return; }
        if (u_out == 2) { o = vec4(col, 1.0); return; }
        o = pre(vec4(col, a)); }`,
    {
      u_key: rgb(p.key), u_tr: p.transparency / 100, u_hi: p.highlight / 100, u_sh: p.shadow / 100, u_tol: Math.min(1, (p.tolerance / 100) * mult), u_ped: p.pedestal / 100,
      u_ch: p.choke / 100, u_con: p.contrast / 100, u_mid: p.midpoint / 100, u_des: p.desat / 100, u_rng: p.range / 100, u_sp: p.spill / 100, u_spl: p.spillLuma / 100,
      u_cs: p.ccSat / 100, u_chue: p.ccHue / 360, u_cl: p.ccLum / 100, u_out: p.output,
    });
    if (p.soften > 0 && p.output === 0) {
      const b = gaussianBlur(ctx.gl, out, p.soften * 0.06 * ctx.k, p.soften * 0.06 * ctx.k);
      ctx.gl.release(out);
      out = b;
    }
    return out;
  },
});

reg({
  id: 'colorKey', name: 'Color Key', category: 'Keying',
  params: [P.col('key', 'Key Color', '#0000ff'), P.int('tolerance', 'Color Tolerance', 0, 0, 255), P.num('thin', 'Edge Thin', 0, -5, 5), P.num('feather', 'Edge Feather', 0, 0, 10), P.bool('maskOnly', 'Mask Only')],
  fs: `uniform vec3 u_kc; uniform float u_t, u_thin, u_f; uniform int u_mo;
  void main(){ vec4 c = unpre(tex(uv*u_res)); float d = distance(c.rgb, u_kc) * 255.0;
    float t = u_t + u_thin * 4.0; float f = max(u_f * 6.0, 0.5);
    float m = smoothstep(t - f, t + f, d); if (u_t <= 0.0 && u_thin <= 0.0) m = d > 0.5 ? 1.0 : 0.0;
    if (u_mo == 1) { o = vec4(vec3(m) * c.a, c.a); return; }
    o = pre(vec4(c.rgb, c.a * m)); }`,
  uniforms: (p) => ({ u_kc: rgb(p.key), u_t: p.tolerance, u_thin: p.thin, u_f: p.feather, u_mo: p.maskOnly }),
});

reg({
  id: 'lumaKey', name: 'Luma Key', category: 'Keying',
  params: [P.pct('threshold', 'Threshold', 100), P.pct('cutoff', 'Cutoff', 0)],
  fs: `uniform float u_t, u_c;
  void main(){ vec4 c = unpre(tex(uv*u_res)); float l = luma(c.rgb); float m = u_t <= u_c ? step(u_c, l) : smoothstep(u_c, u_t, l); o = pre(vec4(c.rgb, c.a * m)); }`,
  uniforms: (p) => ({ u_t: p.threshold / 100, u_c: p.cutoff / 100 }),
});

reg({
  id: 'alphaAdjust', name: 'Alpha Adjust', category: 'Keying',
  params: [P.pct('opacity', 'Opacity', 100), P.bool('ignore', 'Ignore Alpha'), P.bool('invert', 'Invert Alpha'), P.bool('maskOnly', 'Mask Only')],
  fs: `uniform float u_op; uniform int u_ig, u_inv, u_mo;
  void main(){ vec4 c = unpre(tex(uv*u_res)); float a = u_ig == 1 ? 1.0 : c.a; if (u_inv == 1) a = 1.0 - a; a *= u_op;
    if (u_mo == 1) { o = vec4(vec3(a), 1.0); return; } o = pre(vec4(c.rgb, a)); }`,
  uniforms: (p) => ({ u_op: p.opacity / 100, u_ig: p.ignore, u_inv: p.invert, u_mo: p.maskOnly }),
});

reg({
  id: 'trackMatte', name: 'Track Matte Key', category: 'Keying',
  params: [P.track('matte', 'Matte', 2), P.en('using', 'Composite using', ['Matte Alpha', 'Matte Luma'], 0), P.bool('reverse', 'Reverse')],
  render(ctx) {
    const p = ctx.p;
    const matte = ctx.trackLayer(p.matte);
    if (!matte) return ctx.input;
    const f = ctx.fwd;
    const out = ctx.run('trackMatte', `uniform sampler2D u_m; uniform mat3 u_fwd; uniform vec2 u_seq; uniform int u_using, u_rev;
      void main(){ vec2 c = toClip(uv*u_res); vec2 sp = (u_fwd * vec3(c, 1.0)).xy / u_seq; vec4 m = texture(u_m, sp);
        if (sp.x < 0.0 || sp.y < 0.0 || sp.x > 1.0 || sp.y > 1.0) m = vec4(0.0);
        float a = u_using == 0 ? m.a : luma(unpre(m).rgb) * m.a; if (u_rev == 1) a = 1.0 - a; o = tex(uv*u_res) * a; }`,
    { u_m: matte, u_fwd: toMat3(f), u_seq: [ctx.seqW, ctx.seqH], u_using: p.using, u_rev: p.reverse });
    return out;
  },
});

// ============================== Noise & Grain ==============================

reg({
  id: 'noise', name: 'Noise', category: 'Noise & Grain',
  params: [P.pct('amount', 'Amount of Noise', 0), P.bool('color', 'Use Color Noise', true), P.bool('clipping', 'Clip Result Values', true)],
  fs: `uniform float u_a, u_seed; uniform int u_col, u_clip2;
  void main(){ vec2 px = uv*u_res; vec4 c = unpre(tex(px)); vec2 s = floor(toClip(px)) + u_seed;
    vec3 n = u_col == 1 ? vec3(hash12(s), hash12(s + 17.3), hash12(s + 41.7)) : vec3(hash12(s));
    vec3 r = c.rgb + (n - 0.5) * u_a; if (u_clip2 == 1) r = clamp(r, 0.0, 1.0); o = pre(vec4(clamp(r, 0.0, 1.0), c.a)); }`,
  uniforms: (p, ctx) => ({ u_a: (p.amount / 100) * 1.2, u_col: p.color, u_clip2: p.clipping, u_seed: (ctx.frame % 97) * 13.7 }),
});

reg({
  id: 'median', name: 'Median', category: 'Noise & Grain',
  params: [P.num('radius', 'Radius', 0, 0, 30), P.bool('alpha', 'Operate on alpha channel')],
  fs: `uniform float u_r;
  void sw(inout vec4 a, inout vec4 b){ vec4 t = min(a, b); b = max(a, b); a = t; }
  void main(){ vec2 px = uv*u_res; if (u_r < 0.5) { o = tex(px); return; }
    vec4 v0=tex(px+vec2(-u_r,-u_r)),v1=tex(px+vec2(0.0,-u_r)),v2=tex(px+vec2(u_r,-u_r)),v3=tex(px+vec2(-u_r,0.0)),v4=tex(px),v5=tex(px+vec2(u_r,0.0)),v6=tex(px+vec2(-u_r,u_r)),v7=tex(px+vec2(0.0,u_r)),v8=tex(px+vec2(u_r,u_r));
    sw(v1,v2); sw(v4,v5); sw(v7,v8); sw(v0,v1); sw(v3,v4); sw(v6,v7); sw(v1,v2); sw(v4,v5); sw(v7,v8);
    sw(v0,v3); sw(v5,v8); sw(v4,v7); sw(v3,v6); sw(v1,v4); sw(v2,v5); sw(v4,v7); sw(v4,v2); sw(v6,v4); sw(v4,v2);
    o = v4; }`,
  uniforms: (p, ctx) => ({ u_r: p.radius * ctx.k }),
});

// ============================== Perspective ==============================

reg({
  id: 'basic3d', name: 'Basic 3D', category: 'Perspective',
  params: [P.ang('swivel', 'Swivel', 0), P.ang('tilt', 'Tilt', 0), P.num('distance', 'Distance to Image', 0, -100, 100), P.bool('specular', 'Specular Highlight'), P.bool('preview', 'Preview')],
  expand: (p, c) => (Math.abs(p.swivel) > 0 || Math.abs(p.tilt) > 0 || p.distance < 0 ? Math.max(c.w, c.h) * 0.35 : 0),
  render(ctx) {
    const p = ctx.p;
    const sy = rad(p.swivel), tx = rad(p.tilt);
    // R = Rx(tilt) * Ry(swivel)
    const cy = Math.cos(sy), syn = Math.sin(sy), cx = Math.cos(tx), sxn = Math.sin(tx);
    const R = [cy, 0, syn, sxn * syn, cx, -sxn * cy, -cx * syn, sxn, cx * cy];
    // columns for GLSL (column-major) of R^T = rows of R
    const RT = [R[0], R[1], R[2], R[3], R[4], R[5], R[6], R[7], R[8]];
    const n = [R[2], R[5], R[8]];
    return ctx.run('basic3d', `uniform mat3 u_rt; uniform vec3 u_n; uniform float u_f, u_dist; uniform int u_spec, u_prev;
      void main(){ vec2 c = toClip(uv*u_res); vec2 ctr = u_clip * 0.5; vec3 dir = vec3(c - ctr, u_f); vec3 orig = vec3(0.0, 0.0, -u_f);
        vec3 P0 = vec3(0.0, 0.0, u_dist); float dn = dot(dir, u_n); if (abs(dn) < 1e-5) { o = vec4(0.0); return; }
        float t = dot(P0 - orig, u_n) / dn; if (t <= 0.0) { o = vec4(0.0); return; }
        vec3 q = orig + dir * t - P0; vec2 l = (u_rt * q).xy + ctr;
        if (!inClip(l)) { o = vec4(0.0); return; }
        vec4 col = texc(l);
        if (u_prev == 1) { vec2 e = min(l, u_clip - l); if (min(e.x, e.y) < 2.0 / u_k) col = vec4(1.0); }
        if (u_spec == 1) { float s = pow(max(0.0, dot(normalize(u_n), normalize(vec3(-0.4, -0.5, -1.0)) * -1.0)), 40.0); col.rgb += vec3(s) * col.a; }
        o = col; }`, { u_rt: RT, u_n: n, u_f: Math.max(ctx.clipW, ctx.clipH) * 1.6, u_dist: (p.distance / 100) * Math.max(ctx.clipW, ctx.clipH) * 1.5, u_spec: p.specular, u_prev: p.preview });
  },
});

reg({
  id: 'dropShadow', name: 'Drop Shadow', category: 'Perspective',
  params: [P.col('color', 'Shadow Color', '#000000'), P.pct('opacity', 'Opacity', 50), P.ang('direction', 'Direction', 135), P.num('distance', 'Distance', 5, 0, 4000, { uiMax: 200 }), P.num('softness', 'Softness', 0, 0, 250, { uiMax: 100 }), P.bool('only', 'Shadow Only')],
  expand: (p) => p.distance + p.softness * 1.2 + 2,
  render(ctx) {
    const p = ctx.p;
    const s = p.softness * 0.4 * ctx.k;
    const blurred = s > 0.05 ? gaussianBlur(ctx.gl, ctx.input, s, s) : ctx.input;
    const off = [Math.sin(rad(p.direction)) * p.distance * ctx.k, -Math.cos(rad(p.direction)) * p.distance * ctx.k];
    const out = ctx.run('dropShadow', `uniform sampler2D u_b; uniform vec2 u_off; uniform vec3 u_col; uniform float u_op; uniform int u_only;
      void main(){ vec2 px = uv*u_res; vec4 s = tex(px); float a = texture(u_b, (px - u_off) / u_res).a * u_op; vec4 sh = vec4(u_col * a, a);
        o = u_only == 1 ? sh : s + sh * (1.0 - s.a); }`, { u_b: blurred, u_off: off, u_col: rgb(p.color), u_op: p.opacity / 100, u_only: p.only });
    if (blurred !== ctx.input) ctx.gl.release(blurred);
    return out;
  },
});

reg({
  id: 'bevelAlpha', name: 'Bevel Alpha', category: 'Perspective',
  params: [P.num('thickness', 'Edge Thickness', 2, 0, 200, { uiMax: 50 }), P.ang('angle', 'Light Angle', -60), P.col('color', 'Light Color', '#ffffff'), P.num('intensity', 'Light Intensity', 0.4, 0, 1, { step: 0.01, precision: 2 })],
  render(ctx) {
    const p = ctx.p;
    const b = gaussianBlur(ctx.gl, ctx.input, Math.max(0.5, p.thickness * ctx.k), Math.max(0.5, p.thickness * ctx.k));
    const out = ctx.run('bevelAlpha', `uniform sampler2D u_b; uniform vec2 u_l; uniform vec3 u_col; uniform float u_i;
      void main(){ vec2 px = uv*u_res; vec4 s = tex(px);
        float ax = texture(u_b, (px + vec2(1.0, 0.0)) / u_res).a - texture(u_b, (px - vec2(1.0, 0.0)) / u_res).a;
        float ay = texture(u_b, (px + vec2(0.0, 1.0)) / u_res).a - texture(u_b, (px - vec2(0.0, 1.0)) / u_res).a;
        vec2 g = vec2(ax, ay) * 8.0; float sh = dot(g, u_l); vec4 c = unpre(s);
        vec3 r = sh > 0.0 ? mix(c.rgb, u_col, clamp(sh * u_i, 0.0, 1.0)) : c.rgb * (1.0 - clamp(-sh * u_i, 0.0, 1.0));
        o = pre(vec4(r, c.a)); }`, { u_b: b, u_l: [Math.cos(rad(p.angle)), Math.sin(rad(p.angle))].map((v) => -v), u_col: rgb(p.color), u_i: p.intensity });
    ctx.gl.release(b);
    return out;
  },
});

reg({
  id: 'bevelEdges', name: 'Bevel Edges', category: 'Perspective',
  params: [P.num('thickness', 'Edge Thickness', 0.1, 0, 0.5, { step: 0.01, precision: 2 }), P.ang('angle', 'Light Angle', -60), P.col('color', 'Light Color', '#ffffff'), P.num('intensity', 'Light Intensity', 0.25, 0, 1, { step: 0.01, precision: 2 })],
  fs: `uniform float u_t, u_i; uniform vec2 u_l; uniform vec3 u_col;
  void main(){ vec2 c = toClip(uv*u_res); vec4 s = tex(uv*u_res); if (!inClip(c)) { o = s; return; } vec4 u = unpre(s);
    float bw = u_t * min(u_clip.x, u_clip.y); vec2 n = vec2(0.0);
    float dl = c.x, dr = u_clip.x - c.x, dt = c.y, db = u_clip.y - c.y; float m = min(min(dl, dr), min(dt, db));
    if (m < bw) { if (m == dl) n = vec2(-1.0, 0.0); else if (m == dr) n = vec2(1.0, 0.0); else if (m == dt) n = vec2(0.0, -1.0); else n = vec2(0.0, 1.0); }
    float sh = dot(n, -u_l); vec3 r = sh > 0.0 ? mix(u.rgb, u_col, sh * u_i * 2.0) : u.rgb * (1.0 + sh * u_i * 2.0);
    o = pre(vec4(clamp(r, 0.0, 1.0), u.a)); }`,
  uniforms: (p) => ({ u_t: p.thickness, u_i: p.intensity, u_l: [Math.cos(rad(p.angle)), Math.sin(rad(p.angle))], u_col: rgb(p.color) }),
});

// ============================== Stylize ==============================

reg({
  id: 'alphaGlow', name: 'Alpha Glow', category: 'Stylize',
  params: [P.num('glow', 'Glow', 10, 0, 200, { uiMax: 100 }), P.num('brightness', 'Brightness', 255, 0, 255), P.col('start', 'Start Color', '#ffffff'), P.col('end', 'End Color', '#ffffff'), P.bool('useEnd', 'Use End Color'), P.bool('fade', 'Fade Out', true)],
  expand: (p) => p.glow * 1.5,
  render(ctx) {
    const p = ctx.p;
    const s = p.glow * 0.5 * ctx.k;
    const b = s > 0.05 ? gaussianBlur(ctx.gl, ctx.input, s, s) : ctx.input;
    const out = ctx.run('alphaGlow', `uniform sampler2D u_b; uniform float u_br; uniform vec3 u_s, u_e; uniform int u_ue, u_fade;
      void main(){ vec2 px = uv*u_res; vec4 src = tex(px); float a = texture(u_b, uv).a; float g = u_fade == 1 ? a : step(0.02, a);
        vec3 col = u_ue == 1 ? mix(u_e, u_s, a) : u_s; float ga = clamp(g * u_br * 1.5, 0.0, 1.0);
        o = src + vec4(col * ga, ga) * (1.0 - src.a); }`, { u_b: b, u_br: p.brightness / 255, u_s: rgb(p.start), u_e: rgb(p.end), u_ue: p.useEnd, u_fade: p.fade });
    if (b !== ctx.input) ctx.gl.release(b);
    return out;
  },
});

reg({
  id: 'brushStrokes', name: 'Brush Strokes', category: 'Stylize',
  params: [P.num('size', 'Brush Size', 3, 1, 8), P.pct('blend', 'Blend With Original', 0)],
  fs: `uniform float u_r, u_b;
  void main(){ vec2 px = uv*u_res; int R = int(u_r); vec3 m[4]; vec3 s[4];
    for (int k = 0; k < 4; k++) { m[k] = vec3(0.0); s[k] = vec3(0.0); }
    float n = float((R + 1) * (R + 1));
    for (int j = -8; j <= 8; j++) for (int i = -8; i <= 8; i++) {
      if (abs(i) > R || abs(j) > R) continue;
      vec3 c = unpre(tex(px + vec2(float(i), float(j)) * 1.5)).rgb;
      if (i <= 0 && j <= 0) { m[0] += c; s[0] += c * c; }
      if (i >= 0 && j <= 0) { m[1] += c; s[1] += c * c; }
      if (i <= 0 && j >= 0) { m[2] += c; s[2] += c * c; }
      if (i >= 0 && j >= 0) { m[3] += c; s[3] += c * c; } }
    float best = 1e9; vec3 col = vec3(0.0);
    for (int k = 0; k < 4; k++) { vec3 mu = m[k] / n; vec3 v = abs(s[k] / n - mu * mu); float sig = v.r + v.g + v.b; if (sig < best) { best = sig; col = mu; } }
    vec4 src = unpre(tex(px)); o = pre(vec4(mix(col, src.rgb, u_b), src.a)); }`,
  uniforms: (p) => ({ u_r: Math.round(p.size), u_b: p.blend / 100 }),
});

reg({
  id: 'colorEmboss', name: 'Color Emboss', category: 'Stylize',
  params: [P.ang('direction', 'Direction', 45), P.num('relief', 'Relief', 1.7, 0, 10, { step: 0.01, precision: 2 }), P.num('contrast', 'Contrast', 100, 0, 500), P.pct('blend', 'Blend With Original', 0)],
  fs: `uniform vec2 u_d; uniform float u_c, u_b;
  void main(){ vec2 px = uv*u_res; vec4 s = unpre(tex(px)); vec3 a = unpre(tex(px + u_d)).rgb, b = unpre(tex(px - u_d)).rgb;
    vec3 r = s.rgb + (b - a) * u_c; o = pre(vec4(mix(clamp(r, 0.0, 1.0), s.rgb, u_b), s.a)); }`,
  uniforms: (p, ctx) => ({ u_d: [Math.cos(rad(p.direction)) * p.relief * ctx.k, -Math.sin(rad(p.direction)) * p.relief * ctx.k], u_c: p.contrast / 100, u_b: p.blend / 100 }),
});

reg({
  id: 'emboss', name: 'Emboss', category: 'Stylize',
  params: [P.ang('direction', 'Direction', 45), P.num('relief', 'Relief', 1.7, 0, 10, { step: 0.01, precision: 2 }), P.num('contrast', 'Contrast', 100, 0, 500), P.pct('blend', 'Blend With Original', 0)],
  fs: `uniform vec2 u_d; uniform float u_c, u_b;
  void main(){ vec2 px = uv*u_res; vec4 s = unpre(tex(px)); float a = luma(unpre(tex(px + u_d)).rgb), b = luma(unpre(tex(px - u_d)).rgb);
    vec3 r = vec3(0.5 + (b - a) * u_c); o = pre(vec4(mix(clamp(r, 0.0, 1.0), s.rgb, u_b), s.a)); }`,
  uniforms: (p, ctx) => ({ u_d: [Math.cos(rad(p.direction)) * p.relief * ctx.k, -Math.sin(rad(p.direction)) * p.relief * ctx.k], u_c: (p.contrast / 100) * 2, u_b: p.blend / 100 }),
});

reg({
  id: 'findEdges', name: 'Find Edges', category: 'Stylize',
  params: [P.bool('invert', 'Invert'), P.pct('blend', 'Blend With Original', 0)],
  fs: `uniform int u_inv; uniform float u_b;
  vec3 S(vec2 p){ return unpre(tex(p)).rgb; }
  void main(){ vec2 px = uv*u_res; vec4 s = unpre(tex(px));
    vec3 gx = -S(px+vec2(-1,-1)) - 2.0*S(px+vec2(-1,0)) - S(px+vec2(-1,1)) + S(px+vec2(1,-1)) + 2.0*S(px+vec2(1,0)) + S(px+vec2(1,1));
    vec3 gy = -S(px+vec2(-1,-1)) - 2.0*S(px+vec2(0,-1)) - S(px+vec2(1,-1)) + S(px+vec2(-1,1)) + 2.0*S(px+vec2(0,1)) + S(px+vec2(1,1));
    vec3 e = clamp(sqrt(gx*gx + gy*gy), 0.0, 1.0); vec3 r = u_inv == 1 ? e : 1.0 - e;
    o = pre(vec4(mix(r, s.rgb, u_b), s.a)); }`,
  uniforms: (p) => ({ u_inv: p.invert, u_b: p.blend / 100 }),
});

reg({
  id: 'mosaic', name: 'Mosaic', category: 'Stylize',
  params: [P.int('hBlocks', 'Horizontal Blocks', 10, 1, 4000, { uiMax: 200 }), P.int('vBlocks', 'Vertical Blocks', 10, 1, 4000, { uiMax: 200 }), P.bool('sharp', 'Sharp Colors')],
  fs: `uniform vec2 u_n; uniform int u_sharp;
  void main(){ vec2 c = toClip(uv*u_res); if (!inClip(c)) { o = vec4(0.0); return; } vec2 bs = u_clip / u_n; vec2 b = floor(c / bs);
    if (u_sharp == 1) { o = texc((b + 0.5) * bs); return; }
    vec4 acc = vec4(0.0); for (int j = 0; j < 4; j++) for (int i = 0; i < 4; i++) acc += texc((b + (vec2(float(i), float(j)) + 0.5) / 4.0) * bs);
    o = acc / 16.0; }`,
  uniforms: (p) => ({ u_n: [Math.max(1, p.hBlocks), Math.max(1, p.vBlocks)], u_sharp: p.sharp }),
});

reg({
  id: 'posterize', name: 'Posterize', category: 'Stylize',
  params: [P.int('level', 'Level', 6, 2, 255, { uiMax: 32 })],
  fs: `uniform float u_l; void main(){ vec4 c = unpre(tex(uv*u_res)); vec3 r = floor(c.rgb * u_l) / (u_l - 1.0); o = pre(vec4(clamp(r, 0.0, 1.0), c.a)); }`,
  uniforms: (p) => ({ u_l: Math.max(2, p.level) }),
});

reg({
  id: 'replicate', name: 'Replicate', category: 'Stylize',
  params: [P.int('count', 'Count', 2, 2, 16)],
  fs: `uniform float u_n; void main(){ vec2 c = toClip(uv*u_res); if (!inClip(c)) { o = vec4(0.0); return; } o = texc(fract(c / u_clip * u_n) * u_clip); }`,
  uniforms: (p) => ({ u_n: p.count }),
});

reg({
  id: 'roughenEdges', name: 'Roughen Edges', category: 'Stylize',
  params: [P.num('border', 'Border', 8, 0, 500, { uiMax: 100 }), P.num('sharpness', 'Edge Sharpness', 1, 0, 10, { step: 0.01, precision: 2 }), P.num('influence', 'Fractal Influence', 1, 0, 1, { step: 0.01, precision: 2 }), P.num('scale', 'Scale', 100, 10, 1000), P.ang('evolution', 'Evolution', 0)],
  render(ctx) {
    const p = ctx.p;
    const b = gaussianBlur(ctx.gl, ctx.input, Math.max(0.5, p.border * 0.5 * ctx.k), Math.max(0.5, p.border * 0.5 * ctx.k));
    const out = ctx.run('roughen', `uniform sampler2D u_b; uniform float u_sh, u_inf, u_sc, u_ev;
      void main(){ vec2 px = uv*u_res; vec4 s = tex(px); float ba = texture(u_b, uv).a; vec2 c = toClip(px);
        float n = fbm(c / u_sc * 8.0 + u_ev) - 0.5; float v = ba + n * u_inf * 0.9;
        float w = 0.25 / max(u_sh, 0.05); float m = smoothstep(0.5 - w, 0.5 + w, v); o = s * m; }`, { u_b: b, u_sh: p.sharpness, u_inf: p.influence, u_sc: p.scale, u_ev: rad(p.evolution) });
    ctx.gl.release(b);
    return out;
  },
});

reg({
  id: 'solarize', name: 'Solarize', category: 'Stylize',
  params: [P.pct('threshold', 'Threshold', 0)],
  fs: `uniform float u_t; void main(){ vec4 c = unpre(tex(uv*u_res)); vec3 r = mix(c.rgb, 1.0 - c.rgb, step(vec3(u_t), c.rgb)); o = pre(vec4(r, c.a)); }`,
  uniforms: (p) => ({ u_t: p.threshold > 0 ? 1 - p.threshold / 100 : 2 }),
});

reg({
  id: 'strobe', name: 'Strobe Light', category: 'Stylize',
  params: [P.col('color', 'Strobe Color', '#ffffff'), P.pct('blend', 'Blend With Original', 0), P.num('duration', 'Strobe Duration (secs)', 0.1, 0, 10, { step: 0.01, precision: 2 }), P.num('period', 'Strobe Period (secs)', 1, 0.01, 10, { step: 0.01, precision: 2 }), P.pct('random', 'Random Strobe Probability', 0), P.en('mode', 'Strobe', ['Operates On Color Only', 'Makes Layer Transparent'], 0)],
  fs: `uniform vec3 u_col; uniform float u_b, u_on; uniform int u_mode;
  void main(){ vec4 s = tex(uv*u_res); if (u_on < 0.5) { o = s; return; } if (u_mode == 1) { o = vec4(0.0); return; }
    vec4 c = unpre(s); o = pre(vec4(mix(u_col, c.rgb, u_b), c.a)); }`,
  uniforms: (p, ctx) => {
    const t = ctx.time;
    const idx = Math.floor(t / p.period);
    let on = t - idx * p.period < p.duration;
    if (p.random > 0) {
      const r = Math.abs(Math.sin(idx * 12.9898 + 78.233) * 43758.5453) % 1;
      on = on && r < p.random / 100;
    }
    return { u_col: rgb(p.color), u_b: p.blend / 100, u_on: on ? 1 : 0, u_mode: p.mode };
  },
});

reg({
  id: 'threshold', name: 'Threshold', category: 'Stylize',
  params: [P.int('level', 'Level', 128, 0, 255)],
  fs: `uniform float u_l; void main(){ vec4 c = unpre(tex(uv*u_res)); float v = step(u_l, luma(c.rgb)); o = pre(vec4(vec3(v), c.a)); }`,
  uniforms: (p) => ({ u_l: p.level / 255 }),
});

// ============================== Transform ==============================

reg({
  id: 'crop', name: 'Crop', category: 'Transform',
  params: [P.pct('left', 'Left', 0), P.pct('top', 'Top', 0), P.pct('right', 'Right', 0), P.pct('bottom', 'Bottom', 0), P.bool('zoom', 'Zoom'), P.num('feather', 'Edge Feather', 0, 0, 1000, { uiMax: 100 })],
  fs: `uniform vec4 u_c; uniform int u_zoom; uniform float u_f;
  void main(){ vec2 c = toClip(uv*u_res); if (!inClip(c)) { o = vec4(0.0); return; }
    vec2 lo = u_c.xy, hi = u_clip - u_c.zw; vec2 s = c;
    if (u_zoom == 1) { s = lo + c / u_clip * (hi - lo); vec2 e = min(c, u_clip - c); float m = u_f > 0.0 ? smoothstep(0.0, u_f, min(e.x, e.y)) : 1.0; o = texc(s) * m; return; }
    vec2 e = min(c - lo, hi - c); float d = min(e.x, e.y); float m = u_f > 0.0 ? smoothstep(0.0, u_f, d) : step(0.0, d);
    o = texc(c) * m; }`,
  uniforms: (p, ctx) => ({ u_c: [(p.left / 100) * ctx.clipW, (p.top / 100) * ctx.clipH, (p.right / 100) * ctx.clipW, (p.bottom / 100) * ctx.clipH], u_zoom: p.zoom, u_f: p.feather }),
});

reg({
  id: 'edgeFeather', name: 'Edge Feather', category: 'Transform',
  params: [P.num('amount', 'Amount', 10, 0, 100)],
  fs: `uniform float u_a; void main(){ vec2 c = toClip(uv*u_res); vec2 e = min(c, u_clip - c); float d = min(e.x, e.y); float m = u_a > 0.0 ? smoothstep(0.0, u_a * min(u_clip.x, u_clip.y) * 0.005, d) : 1.0; o = tex(uv*u_res) * m; }`,
  uniforms: (p) => ({ u_a: p.amount }),
});

reg({
  id: 'hflip', name: 'Horizontal Flip', category: 'Transform', params: [],
  fs: `void main(){ vec2 c = toClip(uv*u_res); o = texc(vec2(u_clip.x - c.x, c.y)); }`,
});
reg({
  id: 'vflip', name: 'Vertical Flip', category: 'Transform', params: [],
  fs: `void main(){ vec2 c = toClip(uv*u_res); o = texc(vec2(c.x, u_clip.y - c.y)); }`,
});

// ============================== Transition (effects) ==============================

reg({
  id: 'linearWipe', name: 'Linear Wipe', category: 'Transition',
  params: [P.pct('completion', 'Transition Completion', 0), P.ang('angle', 'Wipe Angle', 90), P.num('feather', 'Feather', 0, 0, 1000, { uiMax: 300 })],
  fs: `uniform float u_c, u_f; uniform vec2 u_d;
  void main(){ vec2 c = toClip(uv*u_res); vec2 cs[4]; cs[0] = vec2(0.0); cs[1] = vec2(u_clip.x, 0.0); cs[2] = u_clip; cs[3] = vec2(0.0, u_clip.y);
    float mn = 1e9, mx = -1e9; for (int i = 0; i < 4; i++) { float v = dot(cs[i], u_d); mn = min(mn, v); mx = max(mx, v); }
    float t = mix(mn - u_f, mx, u_c); float v = dot(c, u_d); float m = smoothstep(t, t + u_f + 0.5, v); if (u_c <= 0.0) m = 1.0; if (u_c >= 1.0) m = 0.0;
    o = tex(uv*u_res) * m; }`,
  uniforms: (p) => ({ u_c: p.completion / 100, u_f: p.feather, u_d: [Math.sin(rad(p.angle)), -Math.cos(rad(p.angle))] }),
});

reg({
  id: 'radialWipe', name: 'Radial Wipe', category: 'Transition',
  params: [P.pct('completion', 'Transition Completion', 0), P.ang('start', 'Start Angle', 0), P.pt('center', 'Wipe Center'), P.en('wipe', 'Wipe', ['Clockwise', 'Counterclockwise', 'Both'], 0), P.num('feather', 'Feather', 0, 0, 1000, { uiMax: 300 })],
  fs: `uniform float u_c, u_s, u_f; uniform vec2 u_ctr; uniform int u_w;
  void main(){ vec2 c = toClip(uv*u_res); vec2 d = c - u_ctr; float a = atan(d.x, -d.y) - u_s; a = mod(a, 2.0 * PI) / (2.0 * PI);
    if (u_w == 1) a = 1.0 - a; if (u_w == 2) a = min(a, 1.0 - a) * 2.0;
    float fe = u_f / max(1.0, length(d) * 2.0 * PI); float m = smoothstep(u_c, u_c + fe + 1e-4, a); if (u_c <= 0.0) m = 1.0;
    o = tex(uv*u_res) * m; }`,
  uniforms: (p) => ({ u_c: p.completion / 100, u_s: rad(p.start), u_ctr: p.center, u_w: p.wipe, u_f: p.feather }),
});

reg({
  id: 'blockDissolve', name: 'Block Dissolve', category: 'Transition',
  params: [P.pct('completion', 'Transition Completion', 0), P.num('bw', 'Block Width', 10, 1, 1000, { uiMax: 200 }), P.num('bh', 'Block Height', 10, 1, 1000, { uiMax: 200 }), P.num('feather', 'Feather', 0, 0, 100), P.bool('soft', 'Soft Edges (Best Quality)', true)],
  fs: `uniform float u_c, u_f; uniform vec2 u_b;
  void main(){ vec2 c = toClip(uv*u_res); vec2 b = floor(c / u_b); float r = hash12(b + 0.37); float m = step(u_c, r); if (u_c <= 0.0) m = 1.0;
    if (u_f > 0.0) { vec2 e = min(fract(c / u_b), 1.0 - fract(c / u_b)) * u_b; m = max(m * smoothstep(0.0, u_f, min(e.x, e.y)), m * 0.0); }
    o = tex(uv*u_res) * m; }`,
  uniforms: (p) => ({ u_c: p.completion / 100, u_f: p.feather, u_b: [Math.max(1, p.bw), Math.max(1, p.bh)] }),
});

reg({
  id: 'venetianBlinds', name: 'Venetian Blinds', category: 'Transition',
  params: [P.pct('completion', 'Transition Completion', 0), P.ang('direction', 'Direction', 0), P.num('width', 'Width', 10, 1, 1000, { uiMax: 300 }), P.num('feather', 'Feather', 0, 0, 100)],
  fs: `uniform float u_c, u_w, u_f; uniform vec2 u_d;
  void main(){ vec2 c = toClip(uv*u_res); float v = fract(dot(c, u_d) / u_w); float fe = u_f / u_w; float m = smoothstep(u_c, u_c + fe + 1e-4, v); if (u_c <= 0.0) m = 1.0; if (u_c >= 1.0) m = 0.0;
    o = tex(uv*u_res) * m; }`,
  uniforms: (p) => ({ u_c: p.completion / 100, u_w: p.width, u_f: p.feather, u_d: [Math.cos(rad(p.direction)), Math.sin(rad(p.direction))] }),
});

// ============================== Time ==============================

reg({
  id: 'posterizeTime', name: 'Posterize Time', category: 'Time',
  params: [P.num('fps', 'Frame Rate', 12, 0.5, 99, { step: 0.01, precision: 2 })],
  timeMap: (t, p) => Math.floor(t * p.fps + 1e-6) / p.fps,
  render: (ctx) => ctx.input,
});

// ============================== Video ==============================

reg({
  id: 'clipName', name: 'Clip Name', category: 'Video',
  params: [P.pt('position', 'Position', relPt(0.5, 0.85)), P.en('align', 'Alignment', ['Left', 'Center', 'Right'], 1), P.num('size', 'Size', 15, 0, 100), P.pct('boxOpacity', 'Opacity', 50), P.en('display', 'Display', ['Sequence Clip Name', 'Project Item Name', 'File Name'], 0)],
  render(ctx) {
    const p = ctx.p;
    return ctx.textOverlay({ text: ctx.names[p.display] || ctx.names[0], pos: p.position, align: p.align, size: p.size, box: p.boxOpacity / 100 });
  },
});

reg({
  id: 'timecode', name: 'Timecode', category: 'Video',
  params: [P.pt('position', 'Position', relPt(0.5, 0.88)), P.num('size', 'Size', 15, 0, 100), P.pct('boxOpacity', 'Opacity', 50), P.en('format', 'Format', ['SMPTE', 'Frames', 'Feet + Frames 35mm', 'Seconds'], 0), P.en('source', 'Time Source', ['Clip', 'Media', 'Sequence'], 2), P.int('offset', 'Offset', 0, -100000, 100000, { uiMin: -100, uiMax: 100 }), P.text('label', 'Label Text', '')],
  render(ctx) {
    const p = ctx.p;
    const sec = p.source === 0 ? ctx.time : p.source === 1 ? ctx.sourceTime : ctx.seqTime;
    const f = Math.round(sec * ctx.fps) + p.offset;
    let txt;
    if (p.format === 1) txt = String(f);
    else if (p.format === 2) txt = Math.floor(f / 16) + '+' + String(f % 16).padStart(2, '0');
    else if (p.format === 3) txt = (f / ctx.fps).toFixed(2) + 's';
    else txt = ctx.tc(f);
    if (p.label) txt = p.label + ' ' + txt;
    return ctx.textOverlay({ text: txt, pos: p.position, align: 1, size: p.size, box: p.boxOpacity / 100, mono: true });
  },
});

export { toMat3, affineInverse };
