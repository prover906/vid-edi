// Generic helpers shared across the editor.

let _idCounter = 0;
export function uid(prefix = '') {
  _idCounter = (_idCounter + 1) % 1e6;
  return prefix + Date.now().toString(36).slice(-5) + Math.random().toString(36).slice(2, 7) + _idCounter.toString(36);
}

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const MOD = isMac ? '⌘' : 'Ctrl';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

export function deepClone(o) {
  return o == null ? o : JSON.parse(JSON.stringify(o));
}

export function dbToGain(db) {
  if (db <= -96) return 0;
  return Math.pow(10, db / 20);
}
export function gainToDb(g) {
  if (g <= 0.0000158) return -96;
  return 20 * Math.log10(g);
}

export function hexToRgb(hex) {
  if (Array.isArray(hex)) return hex;
  let h = String(hex || '#000000').replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h.slice(0, 6), 16) || 0;
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
export function rgbToHex(rgb) {
  const c = (v) => clamp(Math.round(v * 255), 0, 255).toString(16).padStart(2, '0');
  return '#' + c(rgb[0]) + c(rgb[1]) + c(rgb[2]);
}
export function rgbToHsl(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return [h, s, l];
}
export function hslToRgb(h, s, l) {
  if (s === 0) return [l, l, l];
  const hue2rgb = (p, q, t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue2rgb(p, q, h + 1 / 3), hue2rgb(p, q, h), hue2rgb(p, q, h - 1 / 3)];
}

export function fmtBytes(n) {
  if (!isFinite(n)) return '-';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(i ? 1 : 0) + ' ' + u[i];
}

export function debounce(fn, ms) {
  let t = 0;
  const d = (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
  d.cancel = () => clearTimeout(t);
  return d;
}

export function rafThrottle(fn) {
  let pending = false;
  return (...a) => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      fn(...a);
    });
  };
}

export class Emitter {
  constructor() { this._h = new Map(); }
  on(evt, fn) {
    for (const e of evt.split(' ')) {
      if (!this._h.has(e)) this._h.set(e, new Set());
      this._h.get(e).add(fn);
    }
    return () => this.off(evt, fn);
  }
  off(evt, fn) {
    for (const e of evt.split(' ')) this._h.get(e)?.delete(fn);
  }
  emit(evt, ...args) {
    const hs = this._h.get(evt);
    if (!hs) return;
    for (const fn of [...hs]) {
      try { fn(...args); } catch (err) { console.error(`[${evt}]`, err); }
    }
  }
}

// Tiny DOM builder: h('div.cls#id', {attrs/on*/style}, ...children)
export function h(tag, attrs, ...children) {
  let cls = [], id = null, name = tag;
  const m = tag.match(/^([a-z0-9-]*)((?:[.#][\w-]+)*)$/i);
  if (m) {
    name = m[1] || 'div';
    (m[2].match(/[.#][\w-]+/g) || []).forEach((p) => (p[0] === '.' ? cls.push(p.slice(1)) : (id = p.slice(1))));
  }
  const svgTags = ['svg', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'g', 'ellipse', 'text', 'defs', 'linearGradient', 'stop'];
  const e = svgTags.includes(name) ? document.createElementNS('http://www.w3.org/2000/svg', name) : document.createElement(name);
  if (cls.length) e.setAttribute('class', cls.join(' '));
  if (id) e.id = id;
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) {
    children.unshift(attrs);
    attrs = null;
  }
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
      else if (k === 'class') e.setAttribute('class', [e.getAttribute('class'), v].filter(Boolean).join(' '));
      else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'dataset') Object.assign(e.dataset, v);
      else if (k === 'html') e.innerHTML = v;
      else if (k === 'text') e.textContent = v;
      else if (k in e && !(e instanceof SVGElement) && typeof v !== 'string') e[k] = v;
      else e.setAttribute(k, v === true ? '' : v);
    }
  }
  appendChildren(e, children);
  return e;
}
function appendChildren(e, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) appendChildren(e, c);
    else e.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export function pickFiles({ accept = '', multiple = true, directory = false } = {}) {
  return new Promise((resolve) => {
    const inp = h('input', { type: 'file', accept, style: { display: 'none' } });
    inp.multiple = multiple;
    if (directory) inp.webkitdirectory = true;
    inp.onchange = () => {
      resolve([...inp.files]);
      inp.remove();
    };
    document.body.appendChild(inp);
    inp.click();
  });
}

// Drag helper: calls move(dx, dy, ev) and up(ev) with pointer capture semantics.
export function dragPointer(ev, { move, up, cursor } = {}) {
  const sx = ev.clientX, sy = ev.clientY;
  const prevCursor = document.body.style.cursor;
  if (cursor) document.body.style.cursor = cursor;
  const mm = (e) => move && move(e.clientX - sx, e.clientY - sy, e);
  const mu = (e) => {
    window.removeEventListener('pointermove', mm, true);
    window.removeEventListener('pointerup', mu, true);
    document.body.style.cursor = prevCursor;
    up && up(e, e.clientX - sx, e.clientY - sy);
  };
  window.addEventListener('pointermove', mm, true);
  window.addEventListener('pointerup', mu, true);
}

export function fmtNum(v, d = 1) {
  if (typeof v !== 'number' || !isFinite(v)) return String(v);
  return v.toFixed(d);
}

// Natural string compare for sorting names
export const naturalCompare = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });

export function fileExt(name) {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}
