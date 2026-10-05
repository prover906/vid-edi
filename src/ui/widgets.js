// Reusable UI controls: hot text scrubbers, dropdowns, color swatches, timecode fields.

import { h, clamp, dragPointer } from '../core/util.js';
import { framesToTC, tcToFrames } from '../core/timecode.js';
import { showMenuAt } from './menus.js';
import { icon } from './icons.js';

// Scrubbable blue number ("hot text") like Premiere's Effect Controls.
export function hotText(opts) {
  const o = Object.assign({ value: 0, step: 1, precision: 1, min: -Infinity, max: Infinity, unit: '', format: null, parse: null, title: '' }, opts);
  let value = o.value;
  let disabled = false;
  const el = h('span.hot', { title: o.title || 'Drag to scrub, click to edit' });
  const fmt = (v) => (o.format ? o.format(v) : (typeof v === 'number' ? v.toFixed(o.precision) : String(v)) + o.unit);
  const render = () => (el.textContent = fmt(value));
  render();
  el.addEventListener('pointerdown', (e) => {
    if (disabled || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    let moved = false;
    const start = value;
    let startedHistory = false;
    dragPointer(e, {
      cursor: 'ew-resize',
      move(dx, dy, ev) {
        if (!moved && Math.abs(dx) < 3) return;
        if (!moved) {
          moved = true;
          o.onStart && o.onStart();
          startedHistory = true;
        }
        const mult = ev.shiftKey ? 10 : ev.ctrlKey || ev.metaKey ? 0.1 : 1;
        const v = clamp(start + dx * o.step * mult, o.min, o.max);
        value = o.precision === 0 ? Math.round(v) : +v.toFixed(Math.max(o.precision, 2));
        render();
        o.onInput && o.onInput(value);
      },
      up() {
        if (moved) {
          o.onCommit && o.onCommit(value, start);
          if (startedHistory) o.onEnd && o.onEnd();
        } else edit();
      },
    });
  });
  function edit() {
    const inp = h('input.hot-edit', { type: 'text', value: o.parse ? fmt(value) : typeof value === 'number' ? +value.toFixed(Math.max(o.precision, 2)) : value });
    el.replaceWith(inp);
    inp.focus();
    inp.select();
    let done = false;
    const finish = (commit) => {
      if (done) return;
      done = true;
      if (commit) {
        let v = o.parse ? o.parse(inp.value, value) : parseFloat(inp.value);
        if (v != null && !Number.isNaN(v)) {
          const prev = value;
          value = typeof v === 'number' ? clamp(v, o.min, o.max) : v;
          o.onStart && o.onStart();
          o.onInput && o.onInput(value);
          o.onCommit && o.onCommit(value, prev);
          o.onEnd && o.onEnd();
        }
      }
      inp.replaceWith(el);
      render();
    };
    inp.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
      if (e.key === 'Tab') {
        finish(true);
      }
    });
    inp.addEventListener('blur', () => finish(true));
  }
  return {
    el,
    get value() {
      return value;
    },
    set(v) {
      value = v;
      render();
    },
    setDisabled(d) {
      disabled = d;
      el.classList.toggle('disabled', d);
    },
  };
}

export function angleFormat(v) {
  const rev = Math.trunc(v / 360);
  const deg = v - rev * 360;
  if (rev === 0) return deg.toFixed(1) + '°';
  return rev + 'x' + (deg >= 0 ? '+' : '') + deg.toFixed(1) + '°';
}
export function angleParse(s) {
  const m = String(s).match(/^\s*(-?\d+)\s*x\s*([+-]?\d*\.?\d+)/i);
  if (m) return parseInt(m[1], 10) * 360 + parseFloat(m[2]);
  return parseFloat(String(s).replace('°', ''));
}

export function dropdown({ options, value, onChange, width, title }) {
  // options: array of strings or {label, value, sep}
  const norm = options.map((o, i) => (typeof o === 'string' ? { label: o, value: i } : o));
  const lbl = h('span.dd-label');
  const el = h('span.dd', { title: title || '' }, lbl, icon('chevDown'));
  if (width) el.style.width = width + 'px';
  let cur = value;
  const render = () => {
    const f = norm.find((o) => o.value === cur);
    lbl.textContent = f ? f.label : String(cur ?? '');
  };
  render();
  el.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    e.preventDefault();
    if (el.classList.contains('disabled')) return;
    showMenuAt(
      el,
      norm.map((o) => (o.sep ? { sep: true } : { label: o.label, checked: o.value === cur, action: () => { cur = o.value; render(); onChange && onChange(o.value); } })),
      { minWidth: el.getBoundingClientRect().width },
    );
  });
  return {
    el,
    set(v) {
      cur = v;
      render();
    },
  };
}

export function colorSwatch({ value, onChange, onStart, onEnd }) {
  const sw = h('span.swatch', { style: { background: value }, title: 'Click to choose color' });
  const inp = h('input', { type: 'color', value, style: { position: 'absolute', opacity: 0, width: 0, height: 0, pointerEvents: 'none' } });
  let started = false;
  sw.addEventListener('click', (e) => {
    e.stopPropagation();
    started = false;
    inp.click();
  });
  inp.addEventListener('input', () => {
    if (!started) {
      started = true;
      onStart && onStart();
    }
    sw.style.background = inp.value;
    onChange && onChange(inp.value);
  });
  inp.addEventListener('change', () => {
    if (started) onEnd && onEnd();
    started = false;
  });
  const wrap = h('span', { style: { position: 'relative', display: 'inline-flex', alignItems: 'center', gap: '4px' } }, sw, inp);
  if ('EyeDropper' in window) {
    const dropper = h('button.ibtn', { title: 'Eyedropper', style: { width: '20px', height: '18px' } }, icon('eyedropper'));
    dropper.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        const res = await new window.EyeDropper().open();
        onStart && onStart();
        sw.style.background = res.sRGBHex;
        inp.value = res.sRGBHex;
        onChange && onChange(res.sRGBHex);
        onEnd && onEnd();
      } catch (err) {
        /* cancelled */
      }
    });
    wrap.appendChild(dropper);
  }
  return {
    el: wrap,
    set(v) {
      sw.style.background = v;
      inp.value = v;
    },
  };
}

export function timecodeField({ frames, fps, onCommit, cls = '', title = 'Click to edit timecode, drag to scrub' }) {
  let f = frames;
  const t = hotText({
    value: f,
    step: 1,
    precision: 0,
    min: 0,
    format: (v) => framesToTC(v, fps),
    parse: (s, prev) => tcToFrames(s, fps, prev),
    onCommit: (v) => onCommit && onCommit(Math.round(v)),
    title,
  });
  t.el.classList.add('tc');
  if (cls) t.el.classList.add(cls);
  return {
    el: t.el,
    set(v, newFps) {
      if (newFps) fps = newFps;
      t.set(v);
    },
  };
}

export function checkbox({ checked, onChange, label, title }) {
  const inp = h('input', { type: 'checkbox' });
  inp.checked = !!checked;
  inp.addEventListener('change', () => onChange && onChange(inp.checked));
  inp.addEventListener('pointerdown', (e) => e.stopPropagation());
  if (!label) return { el: inp, set: (v) => (inp.checked = v) };
  const el = h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }, title: title || '' }, inp, label);
  return { el, set: (v) => (inp.checked = v) };
}

export function slider({ value, min = 0, max = 100, step = 0.1, onInput, onStart, onEnd, width = 120 }) {
  const inp = h('input', { type: 'range', min, max, step, value, style: { width: width + 'px' } });
  let started = false;
  inp.addEventListener('pointerdown', (e) => e.stopPropagation());
  inp.addEventListener('input', () => {
    if (!started) {
      started = true;
      onStart && onStart();
    }
    onInput && onInput(parseFloat(inp.value));
  });
  inp.addEventListener('change', () => {
    started = false;
    onEnd && onEnd();
  });
  return { el: inp, set: (v) => (inp.value = v) };
}

export function iconButton(name, title, onClick, cls = '') {
  const b = h('button.ibtn' + (cls ? '.' + cls : ''), { title }, icon(name));
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick && onClick(e);
  });
  b.addEventListener('pointerdown', (e) => e.preventDefault());
  return b;
}
