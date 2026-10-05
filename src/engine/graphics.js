// Graphics (Essential Graphics) renderer: text & shape layers drawn to a 2D canvas.

import { uid, hexToRgb } from '../core/util.js';
import { evalParam } from '../core/keyframes.js';

export const SYSTEM_FONTS = ['Arial', 'Helvetica', 'Verdana', 'Tahoma', 'Trebuchet MS', 'Georgia', 'Times New Roman', 'Courier New', 'Impact', 'Comic Sans MS'];
export const WEB_FONTS = ['Montserrat', 'Roboto', 'Open Sans', 'Lato', 'Oswald', 'Bebas Neue', 'Poppins', 'Raleway', 'Playfair Display', 'Merriweather', 'Anton', 'Source Sans 3', 'Lobster', 'Pacifico', 'Dancing Script', 'Permanent Marker', 'Roboto Mono'];
export const ALL_FONTS = [...SYSTEM_FONTS, ...WEB_FONTS];

const loadedFonts = new Set();
const fontListeners = new Set();
export function onFontLoaded(fn) {
  fontListeners.add(fn);
  return () => fontListeners.delete(fn);
}
export function ensureFont(family, weight = 'normal', italic = false) {
  if (!WEB_FONTS.includes(family)) return;
  const key = family;
  if (!loadedFonts.has(key)) {
    loadedFonts.add(key);
    const fam = family.replace(/ /g, '+');
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = `https://fonts.googleapis.com/css2?family=${fam}:ital,wght@0,400;0,700;1,400;1,700&display=swap`;
    if (family === 'Bebas Neue' || family === 'Anton' || family === 'Lobster' || family === 'Pacifico' || family === 'Permanent Marker') link.href = `https://fonts.googleapis.com/css2?family=${fam}&display=swap`;
    document.head.appendChild(link);
  }
  const spec = `${italic ? 'italic ' : ''}${weight} 40px "${family}"`;
  if (document.fonts && !document.fonts.check(spec)) {
    document.fonts.load(spec).then(() => fontListeners.forEach((f) => f(family))).catch(() => {});
  }
}

const P = (v) => ({ v, kf: null });

export function createTextLayer(seqW, seqH, opts = {}) {
  return Object.assign(
    {
      id: uid('lyr_'),
      type: 'text',
      name: opts.text ? opts.text.slice(0, 24) : 'New Text Layer',
      text: 'New Text Layer',
      font: 'Arial',
      weight: 'bold',
      italic: false,
      size: Math.round(seqH * 0.09),
      align: 'center',
      tracking: 0,
      leading: 0,
      allCaps: false,
      underline: false,
      fill: { on: true, color: '#ffffff' },
      stroke: { on: false, color: '#000000', width: 4 },
      bg: { on: false, color: '#000000', opacity: 75, pad: 20 },
      shadow: { on: false, color: '#000000', opacity: 75, angle: 135, distance: 7, blur: 10 },
      position: P([seqW / 2, seqH / 2]),
      scale: P(100),
      rotation: P(0),
      opacity: P(100),
      anchor: P([0, 0]),
      hidden: false,
      locked: false,
    },
    opts,
    {
      position: opts.position ? (opts.position.v ? opts.position : P(opts.position)) : P([seqW / 2, seqH / 2]),
    },
  );
}

export function createShapeLayer(seqW, seqH, shape = 'rect', opts = {}) {
  return Object.assign(
    {
      id: uid('lyr_'),
      type: 'shape',
      name: shape === 'ellipse' ? 'Ellipse' : 'Shape',
      shape,
      w: Math.round(seqW * 0.25),
      h: Math.round(seqH * 0.2),
      radius: 0,
      fill: { on: true, color: '#e8443a' },
      stroke: { on: false, color: '#ffffff', width: 4 },
      bg: { on: false, color: '#000000', opacity: 75, pad: 0 },
      shadow: { on: false, color: '#000000', opacity: 75, angle: 135, distance: 7, blur: 10 },
      scale: P(100),
      rotation: P(0),
      opacity: P(100),
      anchor: P([0, 0]),
      hidden: false,
      locked: false,
    },
    opts,
    { position: opts.position ? (opts.position.v ? opts.position : P(opts.position)) : P([seqW / 2, seqH / 2]) },
  );
}

export function fontString(layer, scale = 1) {
  return `${layer.italic ? 'italic ' : ''}${layer.weight === 'bold' ? 'bold' : 'normal'} ${Math.max(1, layer.size * scale)}px "${layer.font}", Arial, sans-serif`;
}

const measureCanvas = document.createElement('canvas').getContext('2d');
const supportsLetterSpacing = 'letterSpacing' in measureCanvas;

function textLines(layer) {
  const t = layer.allCaps ? String(layer.text).toUpperCase() : String(layer.text);
  return t.split('\n');
}

function measureLine(ctx, line, tracking) {
  if (supportsLetterSpacing || !tracking) return ctx.measureText(line).width;
  let w = 0;
  for (const ch of line) w += ctx.measureText(ch).width + tracking;
  return Math.max(0, w - tracking);
}

// Layout returns local bounds (centered at 0,0 before anchor offset) in px at given scale.
export function layoutLayer(layer, scale = 1) {
  if (layer.type === 'shape') {
    const w = layer.w * scale, h = layer.h * scale;
    return { w, h, x: -w / 2, y: -h / 2 };
  }
  ensureFont(layer.font, layer.weight === 'bold' ? 'bold' : 'normal', layer.italic);
  const ctx = measureCanvas;
  ctx.font = fontString(layer, scale);
  const tracking = (layer.tracking / 1000) * layer.size * scale;
  if (supportsLetterSpacing) ctx.letterSpacing = tracking + 'px';
  const lines = textLines(layer);
  const lineH = layer.size * scale * 1.2 + layer.leading * scale;
  const widths = lines.map((l) => measureLine(ctx, l, tracking));
  if (supportsLetterSpacing) ctx.letterSpacing = '0px';
  const w = Math.max(1, ...widths);
  const h = lineH * lines.length;
  return { w, h, x: -w / 2, y: -h / 2, lines, widths, lineH, tracking };
}

function roundRect(ctx, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function rgba(hex, a) {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},${a})`;
}

// Evaluate transform params for a layer at keyframe time t.
export function layerTransform(layer, t) {
  return {
    position: evalParam(layer.position, t) || [0, 0],
    scale: evalParam(layer.scale, t) ?? 100,
    rotation: evalParam(layer.rotation, t) ?? 0,
    opacity: evalParam(layer.opacity, t) ?? 100,
    anchor: evalParam(layer.anchor, t) || [0, 0],
  };
}

// Returns the 4 corners of a layer in sequence px (for hit testing / handles).
export function layerQuad(layer, t) {
  const L = layoutLayer(layer, 1);
  const tr = layerTransform(layer, t);
  const s = tr.scale / 100, r = (tr.rotation * Math.PI) / 180;
  const cs = Math.cos(r), sn = Math.sin(r);
  const pad = layer.type === 'text' && layer.bg.on ? layer.bg.pad : 0;
  const pts = [
    [L.x - pad, L.y - pad],
    [L.x + L.w + pad, L.y - pad],
    [L.x + L.w + pad, L.y + L.h + pad],
    [L.x - pad, L.y + L.h + pad],
  ];
  return pts.map(([x, y]) => {
    x = (x - tr.anchor[0]) * s;
    y = (y - tr.anchor[1]) * s;
    return [tr.position[0] + x * cs - y * sn, tr.position[1] + x * sn + y * cs];
  });
}

export function drawLayer(ctx, layer, t, scale) {
  if (layer.hidden) return;
  const tr = layerTransform(layer, t);
  const L = layoutLayer(layer, scale);
  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, tr.opacity / 100));
  ctx.translate(tr.position[0] * scale, tr.position[1] * scale);
  ctx.rotate((tr.rotation * Math.PI) / 180);
  ctx.scale(tr.scale / 100, tr.scale / 100);
  ctx.translate(-tr.anchor[0] * scale, -tr.anchor[1] * scale);
  const sh = layer.shadow;
  const setShadow = () => {
    if (sh && sh.on) {
      const a = (sh.angle * Math.PI) / 180;
      ctx.shadowColor = rgba(sh.color, sh.opacity / 100);
      ctx.shadowBlur = sh.blur * scale;
      ctx.shadowOffsetX = Math.sin(a) * sh.distance * scale;
      ctx.shadowOffsetY = -Math.cos(a) * sh.distance * scale;
    }
  };
  const clearShadow = () => {
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = ctx.shadowOffsetY = 0;
  };
  if (layer.type === 'shape') {
    const path = () => {
      if (layer.shape === 'ellipse') {
        ctx.beginPath();
        ctx.ellipse(0, 0, L.w / 2, L.h / 2, 0, 0, Math.PI * 2);
      } else roundRect(ctx, L.x, L.y, L.w, L.h, layer.radius * scale);
    };
    setShadow();
    if (layer.fill.on) {
      path();
      ctx.fillStyle = layer.fill.color;
      ctx.fill();
      clearShadow();
    }
    if (layer.stroke.on && layer.stroke.width > 0) {
      path();
      ctx.lineWidth = layer.stroke.width * scale;
      ctx.strokeStyle = layer.stroke.color;
      ctx.stroke();
    }
    ctx.restore();
    return;
  }
  // text
  ctx.font = fontString(layer, scale);
  if (supportsLetterSpacing) ctx.letterSpacing = L.tracking + 'px';
  ctx.textBaseline = 'alphabetic';
  if (layer.bg.on) {
    const pad = layer.bg.pad * scale;
    ctx.fillStyle = rgba(layer.bg.color, layer.bg.opacity / 100);
    roundRect(ctx, L.x - pad, L.y - pad, L.w + pad * 2, L.h + pad * 2, (layer.bg.radius || 0) * scale);
    ctx.fill();
  }
  const ascent = layer.size * scale * 0.95;
  const drawText = (fn) => {
    L.lines.forEach((line, i) => {
      const lw = L.widths[i];
      let x = layer.align === 'left' ? L.x : layer.align === 'right' ? L.x + L.w - lw : -lw / 2;
      const y = L.y + i * L.lineH + ascent * 0.92 + (L.lineH - layer.size * scale * 1.2) / 2;
      if (supportsLetterSpacing || !L.tracking) fn(line, x, y);
      else
        for (const ch of line) {
          fn(ch, x, y);
          x += ctx.measureText(ch).width + L.tracking;
        }
      if (layer.underline && fn === fillFn) {
        ctx.fillRect(x, y + layer.size * scale * 0.1, lw, Math.max(1, layer.size * scale * 0.06));
      }
    });
  };
  const fillFn = (s, x, y) => ctx.fillText(s, x, y);
  const strokeFn = (s, x, y) => ctx.strokeText(s, x, y);
  setShadow();
  if (layer.stroke.on && layer.stroke.width > 0) {
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;
    ctx.lineWidth = layer.stroke.width * 2 * scale;
    ctx.strokeStyle = layer.stroke.color;
    drawText(strokeFn);
    clearShadow();
  }
  if (layer.fill.on) {
    ctx.fillStyle = layer.fill.color;
    drawText(fillFn);
  }
  if (supportsLetterSpacing) ctx.letterSpacing = '0px';
  ctx.restore();
}

export function graphicKey(graphic, t) {
  // cache key: layer JSON + evaluated transforms at t
  return JSON.stringify(graphic.layers.map((l) => [l, layerTransform(l, t)]));
}

export function renderGraphic(canvas, graphic, t, w, h, scale) {
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  for (const layer of graphic.layers) drawLayer(ctx, layer, t, scale);
  return canvas;
}

// ---- Essential Graphics templates ----
export const GRAPHIC_TEMPLATES = [
  {
    name: 'Basic Title',
    category: 'Titles',
    make: (W, H) => [createTextLayer(W, H, { text: 'Basic Title', size: Math.round(H * 0.11), font: 'Montserrat' })],
  },
  {
    name: 'Bold Title',
    category: 'Titles',
    make: (W, H) => [
      createTextLayer(W, H, { text: 'BOLD TITLE', size: Math.round(H * 0.16), font: 'Anton', weight: 'normal', tracking: 40, shadow: { on: true, color: '#000000', opacity: 60, angle: 135, distance: 6, blur: 14 } }),
    ],
  },
  {
    name: 'Title with Subtitle',
    category: 'Titles',
    make: (W, H) => [
      createTextLayer(W, H, { text: 'MAIN TITLE', size: Math.round(H * 0.1), font: 'Montserrat', tracking: 80, position: [W / 2, H * 0.46] }),
      createTextLayer(W, H, { text: 'Subtitle goes here', size: Math.round(H * 0.04), font: 'Montserrat', weight: 'normal', position: [W / 2, H * 0.57], fill: { on: true, color: '#d8d8d8' } }),
    ],
  },
  {
    name: 'Lower Third',
    category: 'Lower Thirds',
    make: (W, H) => [
      createShapeLayer(W, H, 'rect', { name: 'Bar', w: Math.round(W * 0.34), h: Math.round(H * 0.11), position: [W * 0.25, H * 0.82], fill: { on: true, color: '#1b74e4' } }),
      createShapeLayer(W, H, 'rect', { name: 'Accent', w: Math.round(W * 0.008), h: Math.round(H * 0.11), position: [W * 0.08 - W * 0.004, H * 0.82], fill: { on: true, color: '#ffffff' } }),
      createTextLayer(W, H, { text: 'Speaker Name', align: 'left', size: Math.round(H * 0.045), font: 'Montserrat', position: [W * 0.18, H * 0.805], name: 'Name' }),
      createTextLayer(W, H, { text: 'Title / Role', align: 'left', size: Math.round(H * 0.028), font: 'Montserrat', weight: 'normal', position: [W * 0.155, H * 0.85], name: 'Role' }),
    ],
  },
  {
    name: 'Minimal Lower Third',
    category: 'Lower Thirds',
    make: (W, H) => [
      createTextLayer(W, H, { text: 'Jordan Rivera', align: 'left', size: Math.round(H * 0.05), font: 'Roboto', position: [W * 0.17, H * 0.8], shadow: { on: true, color: '#000000', opacity: 70, angle: 135, distance: 3, blur: 8 } }),
      createShapeLayer(W, H, 'rect', { name: 'Line', w: Math.round(W * 0.2), h: 4, position: [W * 0.17, H * 0.84], fill: { on: true, color: '#ffcc00' } }),
    ],
  },
  {
    name: 'Subscribe Button',
    category: 'Social',
    make: (W, H) => [
      createShapeLayer(W, H, 'rect', { name: 'Button', w: Math.round(W * 0.18), h: Math.round(H * 0.08), radius: 12, position: [W * 0.84, H * 0.86], fill: { on: true, color: '#e62117' } }),
      createTextLayer(W, H, { text: 'SUBSCRIBE', size: Math.round(H * 0.035), font: 'Roboto', position: [W * 0.84, H * 0.86] }),
    ],
  },
  {
    name: 'Caption Box',
    category: 'Social',
    make: (W, H) => [createTextLayer(W, H, { text: 'Your caption here', size: Math.round(H * 0.045), font: 'Poppins', position: [W / 2, H * 0.8], bg: { on: true, color: '#000000', opacity: 70, pad: 18, radius: 10 } })],
  },
  {
    name: 'Rolling Credits',
    category: 'Titles',
    make: (W, H) => {
      const l = createTextLayer(W, H, { text: 'DIRECTED BY\nAlex Morgan\n\nPRODUCED BY\nSam Lee\n\nEDITED WITH\nVid-Edi', size: Math.round(H * 0.045), font: 'Montserrat', weight: 'normal', leading: 6 });
      l.position = { v: [W / 2, H * 1.4], kf: [{ t: 0, v: [W / 2, H * 1.4], interp: 'linear' }, { t: 8, v: [W / 2, -H * 0.4], interp: 'linear' }] };
      return [l];
    },
  },
  {
    name: 'Neon Title',
    category: 'Titles',
    make: (W, H) => [createTextLayer(W, H, { text: 'NEON NIGHTS', size: Math.round(H * 0.12), font: 'Bebas Neue', weight: 'normal', tracking: 60, fill: { on: true, color: '#ffe8ff' }, shadow: { on: true, color: '#ff2bd6', opacity: 100, angle: 0, distance: 0, blur: 30 } })],
  },
];
