// Essential Graphics panel: Browse templates / Edit graphic layers.

import { app } from '../../core/app.js';
import { h, clamp, deepClone, uid } from '../../core/util.js';
import { findClip, clipKfTime, clipEnd } from '../../core/model.js';
import { evalParam, setParamValue } from '../../core/keyframes.js';
import { registerPanel } from '../layout.js';
import { icon } from '../icons.js';
import { hotText, dropdown, colorSwatch, checkbox, iconButton, angleFormat, angleParse } from '../widgets.js';
import { showMenu } from '../menus.js';
import { actions } from '../../core/actions.js';
import { GRAPHIC_TEMPLATES, ALL_FONTS, renderGraphic, createTextLayer, createShapeLayer, ensureFont, layoutLayer } from '../../engine/graphics.js';

class GraphicsPanel {
  constructor() {
    this.def = registerPanel({ id: 'essentialGraphics', title: 'Essential Graphics', onShow: () => this.render() });
    this.root = this.def.el;
    this.root.classList.add('eg-root');
    this.tab = 'edit';
    this.tabs = h('div.eg-tabs');
    this.body = h('div.eg-body');
    this.root.append(this.tabs, this.body);
    app.bus.on('selection:changed sequence:activated', () => this.render());
    app.bus.on('project:changed', (e) => {
      if (!(e && e.live)) this.render();
      else this.refreshValues();
    });
    app.bus.on('time:changed', () => this.refreshValues());
  }

  render() {
    if (!this.root.isConnected) return;
    this.tabs.innerHTML = '';
    for (const [id, label] of [['browse', 'Browse'], ['edit', 'Edit']]) {
      const t = h('div.eg-tab' + (this.tab === id ? '.on' : ''), label);
      t.onclick = () => {
        this.tab = id;
        this.render();
      };
      this.tabs.appendChild(t);
    }
    this.body.innerHTML = '';
    this.updaters = [];
    if (this.tab === 'browse') this.renderBrowse();
    else this.renderEdit();
  }

  renderBrowse() {
    const seq = app.seq;
    const W = seq ? seq.settings.width : 1920, H = seq ? seq.settings.height : 1080;
    const grid = h('div.eg-grid');
    let cat = null;
    for (const t of GRAPHIC_TEMPLATES) {
      if (t.category !== cat) {
        cat = t.category;
        grid.appendChild(h('div.eg-cat', cat));
      }
      const cv = h('canvas', { width: 320, height: Math.round((320 * H) / W) });
      const ctx = cv.getContext('2d');
      ctx.fillStyle = '#2a2a3a';
      ctx.fillRect(0, 0, cv.width, cv.height);
      const tmp = document.createElement('canvas');
      renderGraphic(tmp, { layers: t.make(W, H) }, 0, cv.width, cv.height, cv.width / W);
      ctx.drawImage(tmp, 0, 0);
      const card = h('div.eg-card', { title: 'Double-click to add at the playhead' }, cv, h('div.eg-cardname', t.name));
      card.addEventListener('dblclick', () => this.addTemplate(t));
      card.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showMenu(e.clientX, e.clientY, [{ label: 'Add to Sequence at Playhead', action: () => this.addTemplate(t) }]);
      });
      grid.appendChild(card);
    }
    this.body.appendChild(h('div.muted.tiny', { style: { padding: '6px 10px' } }, 'Motion Graphics templates — double-click to add to the timeline.'));
    this.body.appendChild(grid);
  }

  addTemplate(t) {
    const seq = app.seq;
    if (!seq) return app.toast('Open a sequence first', 'warn');
    const layers = t.make(seq.settings.width, seq.settings.height);
    const dur = t.name === 'Rolling Credits' ? Math.round(8 * seq.settings.fps) : null;
    actions.addGraphicLayers(layers, { forceNew: true, name: t.name, dur });
    this.tab = 'edit';
    this.render();
  }

  clip() {
    const seq = app.seq;
    if (!seq) return null;
    for (const id of app.sel.clips) {
      const f = findClip(seq, id);
      if (f && f.clip.graphic) return f.clip;
    }
    return null;
  }

  layer(clip) {
    if (!clip) return null;
    return clip.graphic.layers.find((l) => l.id === app.sel.layerId) || clip.graphic.layers[clip.graphic.layers.length - 1] || null;
  }

  kfT(clip) {
    const seq = app.seq;
    return clipKfTime(clip, clamp(seq.playhead, clip.start, clipEnd(clip) - 1), seq.settings.fps);
  }

  // live setter for a layer property path (e.g. 'fill.color', 'size', 'position')
  setter(clipId, layerId, path, label, keyframeable = false) {
    let begun = false;
    const seq = app.seq;
    const getL = () => findClip(seq, clipId)?.clip.graphic.layers.find((l) => l.id === layerId);
    const apply = (v) => {
      const L = getL();
      if (!L) return;
      if (keyframeable) setParamValue(L[path], this.kfT(findClip(seq, clipId).clip), v);
      else {
        const parts = path.split('.');
        let o = L;
        for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]];
        o[parts[parts.length - 1]] = v;
        if (path === 'text') {
          L.name = String(v).split('\n')[0].slice(0, 24) || 'Text';
          const c = findClip(seq, clipId).clip;
          if (c.graphic.layers.length === 1) c.name = String(v).split('\n')[0].slice(0, 30) || 'Graphic';
        }
      }
    };
    return {
      start: () => {
        if (!begun) {
          app.history.begin(label);
          begun = true;
        }
      },
      input: (v) => {
        if (!begun) {
          app.history.begin(label);
          begun = true;
        }
        apply(v);
        app.bus.emit('project:changed', { live: true });
      },
      end: () => {
        if (begun) {
          begun = false;
          app.history.commit();
          app.bus.emit('project:changed', { label });
        }
      },
      set: (v) => app.edit(label, () => apply(v)),
    };
  }

  renderEdit() {
    const clip = this.clip();
    if (!clip) {
      this.body.appendChild(
        h('div.eg-empty',
          h('div', 'Select a graphic in the timeline to edit it.'),
          h('div.muted.tiny', { style: { margin: '8px 0' } }, 'Create one with the Type tool (T) in the Program Monitor, or:'),
          h('button.btn.sm', { onclick: () => actions.newTextLayer() }, 'New Text Layer'), ' ',
          h('button.btn.sm', { onclick: () => actions.newShapeLayer('rect') }, 'New Rectangle'),
        ),
      );
      return;
    }
    const seq = app.seq;
    const W = seq.settings.width, H = seq.settings.height;
    // layer list
    const list = h('div.eg-layers');
    const layers = [...clip.graphic.layers].reverse();
    const cur = this.layer(clip);
    for (const L of layers) {
      const eye = h('span.eg-eye' + (L.hidden ? '.off' : ''), { title: 'Toggle visibility' }, icon(L.hidden ? 'eyeOff' : 'eye'));
      eye.onclick = (e) => {
        e.stopPropagation();
        app.edit('Toggle Layer', () => (findClip(seq, clip.id).clip.graphic.layers.find((x) => x.id === L.id).hidden = !L.hidden));
      };
      const row = h('div.eg-layer' + (cur && cur.id === L.id ? '.sel' : ''), eye, icon(L.type === 'text' ? 'text' : L.shape === 'ellipse' ? 'ellipse' : 'rect'), h('span', L.name));
      row.onclick = () => {
        app.sel.layerId = L.id;
        app.bus.emit('selection:changed');
      };
      list.appendChild(row);
    }
    const addMenu = (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      showMenu(r.left, r.bottom, [
        { label: 'Text', action: () => this.addLayer(clip, createTextLayer(W, H, { text: 'New Text Layer' })) },
        { label: 'Vertical Text', action: () => this.addLayer(clip, createTextLayer(W, H, { text: 'V\nE\nR\nT', leading: -10 })) },
        { label: 'Rectangle', action: () => this.addLayer(clip, createShapeLayer(W, H, 'rect')) },
        { label: 'Ellipse', action: () => this.addLayer(clip, createShapeLayer(W, H, 'ellipse')) },
      ]);
    };
    const tools = h('div.eg-layertools', iconButton('newItem', 'New Layer', addMenu), iconButton('kfPrev', 'Move layer up', () => this.moveLayer(clip, cur, 1)), iconButton('kfNext', 'Move layer down', () => this.moveLayer(clip, cur, -1)), iconButton('copy', 'Duplicate layer', () => cur && this.addLayer(clip, Object.assign(deepClone(cur), { id: uid('lyr_'), name: cur.name + ' copy' }))), iconButton('trash', 'Delete layer', () => this.deleteLayer(clip, cur)));
    this.body.append(h('div.eg-sec', h('div.eg-sechead', clip.name), list, tools));
    if (!cur) return;
    const S = (path, label, kf = false) => this.setter(clip.id, cur.id, path, label, kf);
    const kfT = this.kfT(clip);
    // Align & Transform
    const tr = h('div.eg-sec');
    tr.appendChild(h('div.eg-sechead', 'Align and Transform'));
    const align = (mode) =>
      app.edit('Align', () => {
        const L = findClip(seq, clip.id).clip.graphic.layers.find((x) => x.id === cur.id);
        const box = layoutLayer(L, 1);
        const p = evalParam(L.position, kfT).slice();
        const s = evalParam(L.scale, kfT) / 100;
        const hw = (box.w * s) / 2, hh = (box.h * s) / 2;
        if (mode === 'left') p[0] = hw + W * 0.05;
        if (mode === 'hcenter') p[0] = W / 2;
        if (mode === 'right') p[0] = W - hw - W * 0.05;
        if (mode === 'top') p[1] = hh + H * 0.05;
        if (mode === 'vcenter') p[1] = H / 2;
        if (mode === 'bottom') p[1] = H - hh - H * 0.05;
        setParamValue(L.position, kfT, p);
      });
    tr.appendChild(h('div.eg-row.btns', ...[['left', '⇤'], ['hcenter', '↔'], ['right', '⇥'], ['top', '⤒'], ['vcenter', '↕'], ['bottom', '⤓']].map(([m, t]) => h('button.eg-abtn', { title: 'Align ' + m, onclick: () => align(m) }, t))));
    const pos = evalParam(cur.position, kfT) || [0, 0];
    const ps = S('position', 'Position', true);
    let pcur = pos.slice();
    const px = hotText({ value: pos[0], precision: 1, onStart: ps.start, onInput: (v) => { pcur = (evalParam(this.layer(this.clip()).position, this.kfT(clip)) || pcur).slice(); pcur[0] = v; ps.input(pcur.slice()); }, onEnd: ps.end });
    const py = hotText({ value: pos[1], precision: 1, onStart: ps.start, onInput: (v) => { pcur = (evalParam(this.layer(this.clip()).position, this.kfT(clip)) || pcur).slice(); pcur[1] = v; ps.input(pcur.slice()); }, onEnd: ps.end });
    this.updaters.push(() => {
      const L = this.layer(this.clip());
      if (!L) return;
      const v = evalParam(L.position, this.kfT(clip));
      px.set(v[0]);
      py.set(v[1]);
    });
    tr.appendChild(h('div.eg-row', h('label', 'Position'), px.el, py.el));
    const num = (path, label, opts = {}) => {
      const st = S(path, label, true);
      const t = hotText({ value: evalParam(cur[path], kfT), precision: 1, min: opts.min ?? -1e6, max: opts.max ?? 1e6, unit: opts.unit || '', format: opts.format, parse: opts.parse, onStart: st.start, onInput: st.input, onEnd: st.end });
      this.updaters.push(() => {
        const L = this.layer(this.clip());
        if (L) t.set(evalParam(L[path], this.kfT(clip)));
      });
      return h('div.eg-row', h('label', label), t.el);
    };
    tr.appendChild(num('scale', 'Scale', { min: 0, unit: ' %' }));
    tr.appendChild(num('rotation', 'Rotation', { format: angleFormat, parse: angleParse }));
    tr.appendChild(num('opacity', 'Opacity', { min: 0, max: 100, unit: ' %' }));
    this.body.appendChild(tr);
    if (cur.type === 'text') this.body.appendChild(this.textSection(clip, cur, S));
    else this.body.appendChild(this.shapeSection(clip, cur, S));
    this.body.appendChild(this.appearanceSection(clip, cur, S));
  }

  textSection(clip, L, S) {
    const sec = h('div.eg-sec');
    sec.appendChild(h('div.eg-sechead', 'Text'));
    const ta = h('textarea.eg-text', { rows: 3 }, L.text);
    const st = S('text', 'Edit Text');
    ta.addEventListener('input', () => st.input(ta.value));
    ta.addEventListener('blur', () => st.end());
    ta.addEventListener('keydown', (e) => e.stopPropagation());
    sec.appendChild(ta);
    const font = dropdown({ options: ALL_FONTS.map((f) => ({ label: f, value: f })), value: L.font, onChange: (v) => { ensureFont(v); S('font', 'Font').set(v); } });
    const style = dropdown({
      options: ['Regular', 'Bold', 'Italic', 'Bold Italic'].map((x) => ({ label: x, value: x })),
      value: (L.weight === 'bold' ? 'Bold' : 'Regular').replace('Regular', L.italic ? 'Italic' : 'Regular').replace('Bold', L.italic ? 'Bold Italic' : 'Bold'),
      onChange: (v) => app.edit('Font Style', () => {
        const x = findClip(app.seq, clip.id).clip.graphic.layers.find((y) => y.id === L.id);
        x.weight = v.includes('Bold') ? 'bold' : 'normal';
        x.italic = v.includes('Italic');
      }),
    });
    sec.appendChild(h('div.eg-row', font.el));
    sec.appendChild(h('div.eg-row', style.el));
    const sz = S('size', 'Font Size');
    const range = h('input', { type: 'range', min: 4, max: 400, step: 1, value: L.size, style: { flex: 1 } });
    const szT = hotText({ value: L.size, precision: 0, min: 1, max: 2000, onStart: sz.start, onInput: (v) => { range.value = v; sz.input(v); }, onEnd: sz.end });
    range.addEventListener('input', () => {
      sz.input(+range.value);
      szT.set(+range.value);
    });
    range.addEventListener('change', () => sz.end());
    sec.appendChild(h('div.eg-row', h('label', 'Size'), range, szT.el));
    const alignBtns = h('div.eg-row.btns');
    for (const [a, t] of [['left', '≡◂'], ['center', '≡'], ['right', '▸≡']]) {
      const b = h('button.eg-abtn' + (L.align === a ? '.on' : ''), { title: 'Align text ' + a }, t);
      b.onclick = () => S('align', 'Text Alignment').set(a);
      alignBtns.appendChild(b);
    }
    const tog = (k, t, title) => {
      const b = h('button.eg-abtn' + (L[k] ? '.on' : ''), { title }, t);
      b.onclick = () => S(k, title).set(!L[k]);
      return b;
    };
    alignBtns.append(tog('allCaps', 'TT', 'All Caps'), tog('underline', 'U̲', 'Underline'));
    sec.appendChild(alignBtns);
    const n = (k, label, min, max) => {
      const st2 = S(k, label);
      return h('div.eg-row', h('label', label), hotText({ value: L[k], precision: 0, min, max, onStart: st2.start, onInput: st2.input, onEnd: st2.end }).el);
    };
    sec.appendChild(n('tracking', 'Tracking', -500, 2000));
    sec.appendChild(n('leading', 'Leading', -500, 1000));
    return sec;
  }

  shapeSection(clip, L, S) {
    const sec = h('div.eg-sec');
    sec.appendChild(h('div.eg-sechead', 'Shape'));
    const n = (k, label, min, max) => {
      const st = S(k, label);
      return h('div.eg-row', h('label', label), hotText({ value: L[k], precision: 0, min, max, onStart: st.start, onInput: st.input, onEnd: st.end }).el);
    };
    sec.appendChild(h('div.eg-row', dropdown({ options: [{ label: 'Rectangle', value: 'rect' }, { label: 'Ellipse', value: 'ellipse' }], value: L.shape, onChange: (v) => S('shape', 'Shape').set(v) }).el));
    sec.appendChild(n('w', 'Width', 1, 20000));
    sec.appendChild(n('h', 'Height', 1, 20000));
    if (L.shape === 'rect') sec.appendChild(n('radius', 'Corner Radius', 0, 5000));
    return sec;
  }

  appearanceSection(clip, L, S) {
    const sec = h('div.eg-sec');
    sec.appendChild(h('div.eg-sechead', 'Appearance'));
    const colorRow = (group, label, extras = []) => {
      const cb = checkbox({ checked: L[group].on, onChange: (v) => S(group + '.on', label).set(v) });
      const st = S(group + '.color', label + ' Color');
      const sw = colorSwatch({ value: L[group].color, onStart: st.start, onChange: st.input, onEnd: st.end });
      return h('div.eg-row', cb.el, h('label.grow', label), sw.el, ...extras);
    };
    sec.appendChild(colorRow('fill', 'Fill'));
    const sw = S('stroke.width', 'Stroke Width');
    sec.appendChild(colorRow('stroke', 'Stroke', [hotText({ value: L.stroke.width, precision: 1, min: 0, max: 200, onStart: sw.start, onInput: sw.input, onEnd: sw.end }).el]));
    if (L.bg) {
      const bo = S('bg.opacity', 'Background Opacity'), bp = S('bg.pad', 'Background Size');
      sec.appendChild(colorRow('bg', 'Background', [hotText({ value: L.bg.opacity, precision: 0, min: 0, max: 100, unit: '%', onStart: bo.start, onInput: bo.input, onEnd: bo.end }).el, hotText({ value: L.bg.pad, precision: 0, min: 0, max: 500, onStart: bp.start, onInput: bp.input, onEnd: bp.end }).el]));
    }
    const so = S('shadow.opacity', 'Shadow Opacity'), sa = S('shadow.angle', 'Shadow Angle'), sd = S('shadow.distance', 'Shadow Distance'), sb = S('shadow.blur', 'Shadow Blur');
    sec.appendChild(colorRow('shadow', 'Shadow'));
    if (L.shadow.on) {
      sec.appendChild(h('div.eg-row.sub', h('label', 'Opacity'), hotText({ value: L.shadow.opacity, precision: 0, min: 0, max: 100, unit: '%', onStart: so.start, onInput: so.input, onEnd: so.end }).el, h('label', 'Angle'), hotText({ value: L.shadow.angle, precision: 0, format: angleFormat, parse: angleParse, onStart: sa.start, onInput: sa.input, onEnd: sa.end }).el));
      sec.appendChild(h('div.eg-row.sub', h('label', 'Distance'), hotText({ value: L.shadow.distance, precision: 1, min: 0, max: 500, onStart: sd.start, onInput: sd.input, onEnd: sd.end }).el, h('label', 'Blur'), hotText({ value: L.shadow.blur, precision: 0, min: 0, max: 300, onStart: sb.start, onInput: sb.input, onEnd: sb.end }).el));
    }
    return sec;
  }

  refreshValues() {
    if (this.updaters) for (const u of this.updaters) u();
  }

  addLayer(clip, layer) {
    app.edit('New Layer', () => findClip(app.seq, clip.id).clip.graphic.layers.push(layer));
    app.sel.layerId = layer.id;
    app.bus.emit('selection:changed');
  }
  moveLayer(clip, L, dir) {
    if (!L) return;
    app.edit('Reorder Layers', () => {
      const arr = findClip(app.seq, clip.id).clip.graphic.layers;
      const i = arr.findIndex((x) => x.id === L.id);
      const j = i + dir;
      if (j < 0 || j >= arr.length) return;
      [arr[i], arr[j]] = [arr[j], arr[i]];
    });
  }
  deleteLayer(clip, L) {
    if (!L) return;
    app.edit('Delete Layer', () => {
      const c = findClip(app.seq, clip.id).clip;
      c.graphic.layers = c.graphic.layers.filter((x) => x.id !== L.id);
    });
  }
}

export const graphicsPanel = new GraphicsPanel();
