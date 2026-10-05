// Effect Controls panel.

import { app } from '../../core/app.js';
import { h, clamp, dragPointer, uid, deepClone, MOD, hexToRgb } from '../../core/util.js';
import { framesToTC, tcToFrames } from '../../core/timecode.js';
import { findItem, findClip, clipEnd, clipKfTime, kfTimeToFrame, linkedClips, createEffect, defaultParamValue, transitionRange } from '../../core/model.js';
import { evalParam, isAnimated, toggleAnimation, setParamValue, addKeyframe, removeKeyframeAt, findKeyframe, KF_EPS } from '../../core/keyframes.js';
import { getEffectDef, getTransitionDef } from '../../core/registry.js';
import { registerPanel } from '../layout.js';
import { icon } from '../icons.js';
import { hotText, angleFormat, angleParse, dropdown, colorSwatch, checkbox, iconButton, timecodeField } from '../widgets.js';
import { showMenu } from '../menus.js';
import { promptDialog } from '../dialogs.js';
import { actions } from '../../core/actions.js';
import * as E from '../../core/edit.js';

const INTERP = [['linear', 'Linear'], ['bezier', 'Bezier'], ['auto', 'Auto Bezier'], ['auto', 'Continuous Bezier'], ['hold', 'Hold'], ['easeIn', 'Ease In'], ['easeOut', 'Ease Out']];

class EffectControls {
  constructor() {
    this.def = registerPanel({ id: 'effectControls', title: 'Effect Controls', menu: () => this.panelMenu(), onResize: () => this.drawLanes(), onShow: () => this.render() });
    this.def.deleteSelected = () => this.deleteSelected();
    this.root = this.def.el;
    this.root.classList.add('ec-root');
    this.expanded = new Map();
    this.showLanes = localStorage.getItem('videdi.ecLanes') !== '0';
    this.leftW = parseInt(localStorage.getItem('videdi.ecLeftW') || '330', 10);
    this.rows = [];
    this.selKf = new Set();
    this.head = h('div.ec-head');
    this.scroll = h('div.ec-scroll');
    this.tcEl = h('div.ec-foot');
    this.root.append(this.head, this.scroll, this.tcEl);
    this.empty = h('div.ec-empty', '(no clip selected)');
    app.bus.on('selection:changed sequence:activated', () => this.render());
    app.bus.on('project:changed', (e) => (e && e.live ? this.updateValues() : this.render()));
    app.bus.on('time:changed', () => this.onTime());
    this.scroll.addEventListener('dragover', (e) => {
      if ([...e.dataTransfer.types].includes('application/x-videdi-effect')) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }
    });
    this.scroll.addEventListener('drop', (e) => {
      const raw = e.dataTransfer.getData('application/x-videdi-effect');
      if (!raw) return;
      e.preventDefault();
      const data = JSON.parse(raw);
      if (data.transition) return;
      if (data.preset) {
        const p = app.services.presets?.find(data.preset);
        if (p) actions.applyPreset(p);
        return;
      }
      actions.applyEffect(data.id);
    });
  }

  get seq() {
    return app.seq;
  }

  // Selected video/audio clips to show
  targets() {
    const seq = this.seq;
    if (!seq) return [];
    const ids = [...app.sel.clips];
    if (!ids.length) return [];
    const first = findClip(seq, ids[0]);
    if (!first) return [];
    const list = [first.clip];
    if (app.sel.clips.size <= 2) for (const l of linkedClips(seq, first.clip)) if (l !== first.clip && app.sel.clips.has(l.id)) list.push(l);
    list.sort((a, b) => (a.kind === 'video' ? -1 : 1));
    return list;
  }

  kfTime(clip) {
    const seq = this.seq;
    const f = clamp(seq.playhead, clip.start, clipEnd(clip) - 1);
    return clipKfTime(clip, f, seq.settings.fps);
  }

  render() {
    if (!this.root.isConnected) return;
    const seq = this.seq;
    this.rows = [];
    this.scroll.innerHTML = '';
    this.head.innerHTML = '';
    this.tcEl.innerHTML = '';
    if (!seq) return this.scroll.appendChild(this.empty);
    if (app.sel.transition) return this.renderTransition();
    const clips = this.targets();
    if (!clips.length) return this.scroll.appendChild(this.empty);
    const main = clips[0];
    const item = main.itemId ? findItem(app.project, main.itemId) : null;
    this.head.append(h('span.muted', 'Source · '), h('b', item ? item.name : main.graphic ? 'Graphic' : main.name), h('span.muted', '  ›  '), h('span', seq.name + ' · ' + main.name));
    this.range = [Math.min(...clips.map((c) => c.start)), Math.max(...clips.map((c) => clipEnd(c)))];
    this.lanesW = 0;
    const wrap = h('div.ec-wrap');
    // header row with mini ruler
    const ruler = h('canvas.ec-ruler');
    const headRow = this.makeRow('ec-rulerrow', h('div.ec-left-pad'), ruler);
    this.rulerCanvas = ruler;
    ruler.addEventListener('pointerdown', (e) => this.onRulerDown(e));
    wrap.appendChild(headRow);
    for (const clip of clips) {
      wrap.appendChild(this.sectionRow(clip.kind === 'video' ? 'Video' : 'Audio'));
      if (clip.graphic) this.renderGraphic(wrap, clip);
      for (const fx of clip.effects) this.renderEffect(wrap, clip, fx);
    }
    this.scroll.appendChild(wrap);
    this.playheadEl = h('div.ec-playhead');
    this.scroll.appendChild(this.playheadEl);
    this.tc = timecodeField({ frames: seq.playhead, fps: seq.settings.fps, onCommit: (f) => app.setPlayhead(f) });
    this.tcEl.append(this.tc.el);
    this.root.classList.toggle('no-lanes', !this.showLanes);
    this.root.style.setProperty('--ec-left', this.leftW + 'px');
    requestAnimationFrame(() => this.drawLanes());
  }

  makeRow(cls, left, right) {
    const r = h('div.ec-row.' + cls, h('div.ec-l', left), h('div.ec-r', right || ''));
    return r;
  }

  sectionRow(title) {
    return this.makeRow('ec-section', h('span', title));
  }

  isExpanded(key, def = true) {
    return this.expanded.has(key) ? this.expanded.get(key) : def;
  }

  renderEffect(wrap, clip, fx) {
    const def = getEffectDef(fx.type);
    if (!def) return;
    if (fx.type === 'timeRemap') {
      const key = clip.id + fx.id;
      const exp = this.isExpanded(key, false);
      const tw = h('span.ec-tw', icon(exp ? 'chevDown' : 'chevRight'));
      const hdr = this.makeRow('ec-fx', h('div.ec-fxname', tw, h('span.ec-fxbadge.off', ''), h('span', def.name)));
      hdr.querySelector('.ec-fxname').onclick = () => {
        this.expanded.set(key, !exp);
        this.render();
      };
      wrap.appendChild(hdr);
      if (exp) {
        const sp = hotText({ value: clip.speed * 100, precision: 2, unit: '%', min: 0.01, max: 10000, onCommit: (v) => app.edit('Speed', () => E.setSpeed(this.seq, clip.id, v)) });
        wrap.appendChild(this.makeRow('ec-param', h('div.ec-pname', h('span.ec-sw-pad'), h('span', 'Speed')), null));
        wrap.lastChild.querySelector('.ec-l').appendChild(h('div.ec-val', sp.el));
      }
      return;
    }
    const key = clip.id + fx.id;
    const exp = this.isExpanded(key, fx.expanded !== false);
    const tw = h('span.ec-tw', icon(exp ? 'chevDown' : 'chevRight'));
    const fxBtn = h('span.ec-fxbadge' + (fx.enabled === false ? '.off' : ''), { title: 'Toggle the effect on or off' }, 'fx');
    fxBtn.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      app.edit('Toggle Effect', () => (this.fxOf(clip.id, fx.id).enabled = fx.enabled === false));
    });
    const name = h('span.ec-fxtitle', def.name + (fx.label ? ' (' + fx.label + ')' : ''));
    const reset = iconButton('reset', 'Reset Effect', () => this.resetEffect(clip, fx));
    const left = h('div.ec-fxname', tw, fxBtn, name, h('span.spacer'), reset);
    const hdr = this.makeRow('ec-fx' + (app.sel.effectId === fx.id ? '.sel' : ''), left, null);
    hdr.querySelector('.ec-r').appendChild(h('div.ec-clipbar'));
    left.addEventListener('click', (e) => {
      if (e.target.closest('button') || e.target === fxBtn) return;
      if (e.target.closest('.ec-tw')) {
        this.expanded.set(key, !exp);
        return this.render();
      }
      app.sel.effectId = fx.id;
      app.sel.maskId = null;
      this.scroll.querySelectorAll('.ec-fx.sel').forEach((x) => x.classList.remove('sel'));
      hdr.classList.add('sel');
      app.bus.emit('effect:selected');
    });
    left.addEventListener('dblclick', () => {
      this.expanded.set(key, !exp);
      this.render();
    });
    left.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      app.sel.effectId = fx.id;
      showMenu(e.clientX, e.clientY, this.effectMenu(clip, fx, def));
    });
    if (!def.intrinsic) {
      hdr.draggable = true;
      hdr.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('application/x-videdi-fxorder', JSON.stringify({ clipId: clip.id, fxId: fx.id }));
      });
      hdr.addEventListener('dragover', (e) => {
        if ([...e.dataTransfer.types].includes('application/x-videdi-fxorder')) {
          e.preventDefault();
          hdr.classList.add('drop');
        }
      });
      hdr.addEventListener('dragleave', () => hdr.classList.remove('drop'));
      hdr.addEventListener('drop', (e) => {
        hdr.classList.remove('drop');
        const d = e.dataTransfer.getData('application/x-videdi-fxorder');
        if (!d) return;
        e.preventDefault();
        e.stopPropagation();
        const { clipId, fxId } = JSON.parse(d);
        if (clipId !== clip.id || fxId === fx.id) return;
        app.edit('Reorder Effects', () => {
          const c = findClip(this.seq, clip.id).clip;
          const from = c.effects.findIndex((x) => x.id === fxId);
          const moving = c.effects.splice(from, 1)[0];
          const to = c.effects.findIndex((x) => x.id === fx.id);
          c.effects.splice(to, 0, moving);
        });
      });
    }
    wrap.appendChild(hdr);
    if (!exp) return;
    // masks
    if (def.masks || (!def.intrinsic && def.kind === 'video')) {
      const tools = h('div.ec-masktools', iconButton('maskEllipse', 'Create ellipse mask', () => actions.addMask(clip.id, fx.id, 'ellipse')), iconButton('maskRect', 'Create 4-point polygon mask', () => actions.addMask(clip.id, fx.id, 'rect')), iconButton('maskPen', 'Create free draw bezier', () => { actions.addMask(clip.id, fx.id, 'bezier'); app.setTool('pen'); }));
      wrap.appendChild(this.makeRow('ec-param', h('div.ec-pname.indent', h('span.ec-sw-pad'), tools)));
      for (const m of fx.masks || []) this.renderMask(wrap, clip, fx, m);
    }
    let group = null, groupOpen = true;
    for (const pd of def.params) {
      if (pd.type === 'mask-tools' || pd.hidden) continue;
      if (pd.section) {
        // Lumetri section toggles
        group = pd.name;
        const gk = key + ':' + group;
        groupOpen = this.isExpanded(gk, false);
        const gtw = h('span.ec-tw', icon(groupOpen ? 'chevDown' : 'chevRight'));
        const cb = checkbox({ checked: !!fx.params[pd.id]?.v, onChange: (v) => app.edit(pd.name, () => (this.fxOf(clip.id, fx.id).params[pd.id].v = v)) });
        const gl = h('div.ec-pname.group', gtw, cb.el, h('span', pd.name));
        gtw.onclick = () => {
          this.expanded.set(gk, !groupOpen);
          this.render();
        };
        wrap.appendChild(this.makeRow('ec-param', gl));
        continue;
      }
      if (pd.group && pd.group !== group) {
        group = pd.group;
        if (!def.params.some((x) => x.section && x.name === group)) {
          const gk = key + ':' + group;
          groupOpen = this.isExpanded(gk, false);
          const gtw = h('span.ec-tw', icon(groupOpen ? 'chevDown' : 'chevRight'));
          const gl = h('div.ec-pname.group', gtw, h('span', group));
          gl.onclick = () => {
            this.expanded.set(gk, !groupOpen);
            this.render();
          };
          wrap.appendChild(this.makeRow('ec-param', gl));
        }
      } else if (!pd.group && group) {
        group = null;
        groupOpen = true;
      }
      if (group && !groupOpen) continue;
      this.paramRow(wrap, clip, pd, {
        get: () => this.fxOf(clip.id, fx.id)?.params[pd.id],
        key: fx.id + '|' + pd.id,
        label: pd.name,
        fx,
        indent: !!group,
        enabled: () => (pd.enabledIf ? pd.enabledIf(this.fxOf(clip.id, fx.id).params) : true),
        reset: () => defaultParamValue(pd, this.defCtx(clip)),
      });
    }
  }

  defCtx(clip) {
    const seq = this.seq;
    const item = clip.itemId ? findItem(app.project, clip.itemId) : null;
    const w = item?.type === 'sequence' ? item.settings.width : item?.width || seq.settings.width;
    const hh = item?.type === 'sequence' ? item.settings.height : item?.height || seq.settings.height;
    return { w, h: hh, seqW: seq.settings.width, seqH: seq.settings.height };
  }

  fxOf(clipId, fxId) {
    const f = findClip(this.seq, clipId);
    return f ? f.clip.effects.find((e) => e.id === fxId) : null;
  }

  renderMask(wrap, clip, fx, m) {
    const key = clip.id + m.id;
    const exp = this.isExpanded(key, true);
    const sel = app.sel.maskId === m.id;
    const tw = h('span.ec-tw', icon(exp ? 'chevDown' : 'chevRight'));
    const nm = h('span', m.name || 'Mask');
    const modeDd = dropdown({ options: ['None', 'Add', 'Subtract', 'Intersect', 'Lighten', 'Darken', 'Difference'].map((x) => ({ label: x, value: x.toLowerCase() })), value: m.mode || 'add', onChange: (v) => app.edit('Mask Mode', () => (this.maskOf(clip.id, m.id).mode = v)) });
    const inv = checkbox({ checked: m.inverted, label: 'Inverted', onChange: (v) => app.edit('Invert Mask', () => (this.maskOf(clip.id, m.id).inverted = v)) });
    const del = iconButton('trash', 'Delete mask', () => app.edit('Delete Mask', () => {
      const f = this.fxOf(clip.id, fx.id);
      f.masks = f.masks.filter((x) => x.id !== m.id);
    }));
    const left = h('div.ec-pname.indent.mask' + (sel ? '.sel' : ''), tw, icon(m.shape === 'ellipse' ? 'maskEllipse' : m.shape === 'rect' ? 'maskRect' : 'maskPen'), nm, h('span.spacer'), modeDd.el, inv.el, del);
    left.addEventListener('click', (e) => {
      if (e.target.closest('.ec-tw')) {
        this.expanded.set(key, !exp);
        return this.render();
      }
      if (e.target.closest('.dd') || e.target.closest('button') || e.target.tagName === 'INPUT') return;
      app.sel.maskId = sel ? null : m.id;
      app.bus.emit('selection:changed');
    });
    wrap.appendChild(this.makeRow('ec-param', left));
    if (!exp) return;
    const mk = (pid, label, pd) => this.paramRow(wrap, clip, pd, { get: () => this.maskOf(clip.id, m.id)?.[pid], key: m.id + '|' + pid, label, fx, indent: 2 });
    mk('path', 'Mask Path', { id: 'path', type: 'maskpath', default: [] });
    mk('feather', 'Mask Feather', { id: 'feather', type: 'number', min: 0, max: 1000, uiMax: 200, step: 0.5, precision: 1, default: 10 });
    mk('opacity', 'Mask Opacity', { id: 'opacity', type: 'number', min: 0, max: 100, unit: '%', step: 0.5, precision: 1, default: 100 });
    mk('expansion', 'Mask Expansion', { id: 'expansion', type: 'number', min: -1000, max: 1000, step: 0.5, precision: 1, default: 0 });
  }

  maskOf(clipId, maskId) {
    const f = findClip(this.seq, clipId);
    if (!f) return null;
    for (const fx of f.clip.effects) {
      const m = (fx.masks || []).find((x) => x.id === maskId);
      if (m) return m;
    }
    return null;
  }

  renderGraphic(wrap, clip) {
    const key = clip.id + ':graphic';
    const exp = this.isExpanded(key, true);
    const tw = h('span.ec-tw', icon(exp ? 'chevDown' : 'chevRight'));
    const left = h('div.ec-fxname', tw, h('span.ec-fxbadge', 'fx'), h('span.ec-fxtitle', 'Graphic'));
    left.onclick = () => {
      this.expanded.set(key, !exp);
      this.render();
    };
    wrap.appendChild(this.makeRow('ec-fx', left));
    if (!exp) return;
    for (const L of [...clip.graphic.layers].reverse()) {
      const lk = clip.id + L.id;
      const lexp = this.isExpanded(lk, app.sel.layerId === L.id);
      const ltw = h('span.ec-tw', icon(lexp ? 'chevDown' : 'chevRight'));
      const ll = h('div.ec-pname.group' + (app.sel.layerId === L.id ? '.sel' : ''), ltw, icon(L.type === 'text' ? 'text' : L.shape === 'ellipse' ? 'ellipse' : 'rect'), h('span', (L.type === 'text' ? 'Text (' + L.name + ')' : 'Shape (' + L.name + ')')));
      ll.onclick = (e) => {
        if (e.target.closest('.ec-tw')) {
          this.expanded.set(lk, !lexp);
          return this.render();
        }
        app.sel.layerId = L.id;
        app.bus.emit('selection:changed');
      };
      wrap.appendChild(this.makeRow('ec-param', ll));
      if (!lexp) continue;
      const getL = () => findClip(this.seq, clip.id)?.clip.graphic?.layers.find((x) => x.id === L.id);
      const P = (pid, label, pd) => this.paramRow(wrap, clip, pd, { get: () => getL()?.[pid], key: L.id + '|' + pid, label, indent: 2 });
      P('position', 'Position', { id: 'position', type: 'point', default: [this.seq.settings.width / 2, this.seq.settings.height / 2] });
      P('scale', 'Scale', { id: 'scale', type: 'number', min: 0, max: 10000, uiMax: 400, precision: 1, default: 100 });
      P('rotation', 'Rotation', { id: 'rotation', type: 'angle', default: 0 });
      P('opacity', 'Opacity', { id: 'opacity', type: 'number', min: 0, max: 100, unit: '%', precision: 1, default: 100 });
      P('anchor', 'Anchor Point', { id: 'anchor', type: 'point', default: [0, 0] });
    }
  }

  paramRow(wrap, clip, pd, o) {
    const p = o.get();
    if (!p) return;
    const seq = this.seq;
    const kfT = this.kfTime(clip);
    const animatable = pd.animatable !== false && !['bool', 'enum', 'track', 'text', 'curve', 'huecurve', 'lut', 'speed'].includes(pd.type);
    const enabled = o.enabled ? o.enabled() : true;
    const sw = animatable ? h('span.ec-sw' + (isAnimated(p) ? '.on' : ''), { title: 'Toggle animation' }, icon(isAnimated(p) ? 'stopwatchOn' : 'stopwatch')) : h('span.ec-sw-pad');
    if (animatable)
      sw.addEventListener('click', async () => {
        if (isAnimated(p) && p.kf.length > 1) {
          const { confirmDialog } = await import('../dialogs.js');
          const ok = await confirmDialog('This action will delete existing keyframes. Do you want to continue?', { title: 'Warning', ok: 'OK' });
          if (!ok) return;
        }
        app.edit('Toggle Animation', () => toggleAnimation(o.get(), this.kfTime(clip), pd));
      });
    const label = h('span.ec-plabel' + (enabled ? '' : '.disabled'), o.label);
    const val = this.valueWidget(clip, pd, o, enabled);
    const nav = h('span.ec-kfnav');
    if (animatable && isAnimated(p)) {
      const prev = h('span.kfn', { title: 'Go to Previous Keyframe' }, icon('kfPrev'));
      const has = findKeyframe(p, kfT, 1e-3) >= 0;
      const add = h('span.kfn.add' + (has ? '.on' : ''), { title: 'Add/Remove Keyframe' }, icon(has ? 'diamond' : 'diamondOutline'));
      const next = h('span.kfn', { title: 'Go to Next Keyframe' }, icon('kfNext'));
      prev.onclick = () => this.gotoKf(clip, o.get(), -1);
      next.onclick = () => this.gotoKf(clip, o.get(), 1);
      add.onclick = () =>
        app.edit(has ? 'Remove Keyframe' : 'Add Keyframe', () => {
          const pp = o.get();
          const t = this.kfTime(clip);
          if (findKeyframe(pp, t, 1e-3) >= 0) removeKeyframeAt(pp, t, 1e-3);
          else addKeyframe(pp, t);
        });
      nav.append(prev, add, next);
    }
    const reset = o.reset ? iconButton('reset', 'Reset Parameter', () => app.edit('Reset ' + o.label, () => setParamValue(o.get(), this.kfTime(clip), o.reset()))) : null;
    if (reset) reset.classList.add('ec-preset');
    const left = h('div.ec-pname' + (o.indent ? '.indent' + (o.indent === 2 ? '2' : '') : ''), sw, label, h('div.ec-val', val), nav, reset || '');
    const lane = h('div.ec-lane', { dataset: { key: o.key } });
    const row = this.makeRow('ec-param' + (pd.type === 'curve' || pd.type === 'huecurve' || pd.type === 'wheel' ? '.tall' : ''), left, lane);
    wrap.appendChild(row);
    this.rows.push({ clip, pd, o, lane, row, animatable, update: val._update });
  }

  valueWidget(clip, pd, o, enabled) {
    const p = o.get();
    const kfT = this.kfTime(clip);
    const v = evalParam(p, kfT, pd);
    const live = this.liveSetter(clip, o, pd);
    let el, update;
    switch (pd.type) {
      case 'number': {
        const t = hotText({ value: v, step: pd.step ?? (pd.max - pd.min > 1000 ? 1 : 0.1), precision: pd.precision ?? 1, min: pd.min, max: pd.max, unit: pd.unit ? (pd.unit === '%' ? ' %' : ' ' + pd.unit) : '', format: pd.unit === 'dB' ? (x) => (x <= -96 ? '-∞' : x.toFixed(1)) + ' dB' : null, onStart: live.start, onInput: live.input, onEnd: live.end });
        t.setDisabled(!enabled);
        el = t.el;
        update = (nv) => t.set(nv);
        break;
      }
      case 'angle': {
        const t = hotText({ value: v, step: 0.5, precision: 1, format: angleFormat, parse: angleParse, onStart: live.start, onInput: live.input, onEnd: live.end });
        el = t.el;
        update = (nv) => t.set(nv);
        break;
      }
      case 'point': {
        const pv = v || [0, 0];
        let cur = pv.slice();
        const mk = (i) =>
          hotText({ value: pv[i], step: 1, precision: 1, onStart: live.start, onInput: (x) => { cur = (evalParam(o.get(), this.kfTime(clip), pd) || cur).slice(); cur[i] = x; live.input(cur.slice()); }, onEnd: live.end });
        const tx = mk(0), ty = mk(1);
        el = h('span.ec-point', tx.el, ty.el);
        update = (nv) => {
          tx.set(nv[0]);
          ty.set(nv[1]);
        };
        break;
      }
      case 'color': {
        const s = colorSwatch({ value: v, onStart: live.start, onChange: live.input, onEnd: live.end });
        el = s.el;
        update = (nv) => s.set(nv);
        break;
      }
      case 'bool': {
        const c = checkbox({ checked: !!v, onChange: (x) => app.edit(o.label, () => setParamValue(o.get(), this.kfTime(clip), x)) });
        el = c.el;
        update = (nv) => c.set(!!nv);
        break;
      }
      case 'enum': {
        const opts = pd.options.map((label, i) => ({ label, value: i }));
        if (pd.separators) {
          const withSep = [];
          opts.forEach((op, i) => {
            if (pd.separators.includes(i)) withSep.push({ sep: true });
            withSep.push(op);
          });
          opts.length = 0;
          opts.push(...withSep);
        }
        const d = dropdown({ options: opts, value: v, onChange: (x) => app.edit(o.label, () => setParamValue(o.get(), this.kfTime(clip), x)) });
        el = d.el;
        update = (nv) => d.set(nv);
        break;
      }
      case 'track': {
        const seq = this.seq;
        const opts = [{ label: 'None', value: 0 }, ...seq.videoTracks.map((t, i) => ({ label: 'Video ' + (i + 1), value: i + 1 }))];
        const d = dropdown({ options: opts, value: v, onChange: (x) => app.edit(o.label, () => setParamValue(o.get(), 0, x)) });
        el = d.el;
        break;
      }
      case 'text': {
        const inp = h('input', { type: 'text', value: v || '', style: { width: '120px', height: '20px' } });
        inp.addEventListener('keydown', (e) => e.stopPropagation());
        inp.addEventListener('change', () => app.edit(o.label, () => setParamValue(o.get(), 0, inp.value)));
        el = inp;
        break;
      }
      case 'lut': {
        const luts = app.project.luts || {};
        const opts = [{ label: 'None', value: null }, ...Object.entries(luts).map(([id, L]) => ({ label: L.name, value: id })), { sep: true }, { label: 'Browse…', value: '__browse' }];
        const d = dropdown({
          options: opts,
          value: v,
          onChange: async (x) => {
            if (x === '__browse') {
              const id = await app.services.luts.browse();
              if (id) app.edit('Input LUT', () => setParamValue(o.get(), 0, id));
              else this.render();
              return;
            }
            app.edit('Input LUT', () => setParamValue(o.get(), 0, x));
          },
        });
        el = d.el;
        break;
      }
      case 'curve':
      case 'huecurve':
      case 'wheel': {
        const b = h('button.btn.sm', 'Edit in Lumetri Color');
        b.onclick = () => app.services.layout.activate('lumetri');
        el = b;
        break;
      }
      case 'maskpath': {
        el = h('span.muted.tiny', (v || []).length + ' points');
        update = (nv) => (el.textContent = (nv || []).length + ' points');
        break;
      }
      default:
        el = h('span.muted', String(v));
    }
    el._update = update;
    return el;
  }

  liveSetter(clip, o, pd) {
    let begun = false;
    return {
      start: () => {
        if (!begun) {
          app.history.begin(o.label);
          begun = true;
        }
      },
      input: (v) => {
        if (!begun) {
          app.history.begin(o.label);
          begun = true;
        }
        const p = o.get();
        if (!p) return;
        setParamValue(p, this.kfTime(clip), v);
        app.bus.emit('project:changed', { live: true });
      },
      end: () => {
        if (begun) {
          begun = false;
          app.history.commit();
          app.bus.emit('project:changed', { label: o.label });
        }
      },
    };
  }

  updateValues() {
    for (const r of this.rows) {
      if (!r.update) continue;
      const p = r.o.get();
      if (!p) continue;
      r.update(evalParam(p, this.kfTime(r.clip), r.pd));
    }
    this.drawLanes();
  }

  onTime() {
    if (!this.rows.length) return;
    if (this.tc && this.seq) this.tc.set(this.seq.playhead, this.seq.settings.fps);
    this.updateValues();
    // refresh keyframe nav diamonds state cheaply
    clearTimeout(this._navT);
    this._navT = setTimeout(() => {
      for (const r of this.rows) {
        if (!r.animatable) continue;
        const p = r.o.get();
        if (!p || !isAnimated(p)) continue;
        const add = r.row.querySelector('.kfn.add');
        if (!add) continue;
        const has = findKeyframe(p, this.kfTime(r.clip), 1e-3) >= 0;
        add.classList.toggle('on', has);
        add.innerHTML = '';
        add.appendChild(icon(has ? 'diamond' : 'diamondOutline'));
      }
    }, 60);
  }

  gotoKf(clip, p, dir) {
    if (!p || !p.kf) return;
    const seq = this.seq;
    const fps = seq.settings.fps;
    const frames = p.kf.map((k) => Math.round(kfTimeToFrame(clip, k.t, fps)));
    const ph = seq.playhead;
    const t = dir > 0 ? frames.find((f) => f > ph) : [...frames].reverse().find((f) => f < ph);
    if (t != null) app.setPlayhead(t);
  }

  // ---------- keyframe lanes ----------
  laneX(frame) {
    const [a, b] = this.range;
    return ((frame - a) / Math.max(1, b - a)) * this.lanesW;
  }
  laneF(x) {
    const [a, b] = this.range;
    return a + (x / Math.max(1, this.lanesW)) * (b - a);
  }

  drawLanes() {
    if (!this.showLanes || !this.rows || !this.rulerCanvas || !this.seq) return;
    const seq = this.seq;
    const fps = seq.settings.fps;
    const rr = this.rulerCanvas.parentElement.getBoundingClientRect();
    this.lanesW = Math.max(10, rr.width);
    const dpr = window.devicePixelRatio || 1;
    const rc = this.rulerCanvas;
    rc.width = this.lanesW * dpr;
    rc.height = 22 * dpr;
    rc.style.width = this.lanesW + 'px';
    const c = rc.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.fillStyle = '#202020';
    c.fillRect(0, 0, this.lanesW, 22);
    const clips = this.targets();
    for (const cl of clips) {
      const xa = this.laneX(cl.start), xb = this.laneX(clipEnd(cl));
      c.fillStyle = '#3a3a52';
      c.fillRect(xa, 13, xb - xa, 8);
      c.fillStyle = '#ddd';
      c.font = '10px sans-serif';
      c.save();
      c.beginPath();
      c.rect(xa, 0, xb - xa, 22);
      c.clip();
      c.fillText(cl.name, xa + 3, 20);
      c.restore();
    }
    c.fillStyle = '#888';
    c.font = '10px sans-serif';
    c.fillText(framesToTC(this.range[0], fps), 2, 10);
    // lanes
    for (const r of this.rows) {
      const lane = r.lane;
      lane.innerHTML = '';
      if (!r.animatable) continue;
      const p = r.o.get();
      if (!p || !p.kf) continue;
      p.kf.forEach((k, i) => {
        const f = kfTimeToFrame(r.clip, k.t, fps);
        const x = this.laneX(f);
        const skey = r.o.key + '@' + k.t.toFixed(5);
        const d = h('span.ec-kf' + (this.selKf.has(skey) ? '.sel' : '') + (k.interp === 'hold' ? '.hold' : k.interp === 'bezier' || k.interp === 'easeIn' || k.interp === 'easeOut' || k.interp === 'auto' ? '.bez' : ''), { style: { left: x + 'px' }, title: framesToTC(Math.round(f), fps) });
        d.addEventListener('pointerdown', (e) => this.kfDown(e, r, i, skey));
        d.addEventListener('contextmenu', (e) => this.kfMenu(e, r, i, skey));
        lane.appendChild(d);
      });
    }
    // playhead
    if (this.playheadEl) {
      const x = this.laneX(seq.playhead);
      const inRange = seq.playhead >= this.range[0] && seq.playhead <= this.range[1];
      const left = this.rulerCanvas.getBoundingClientRect().left - this.scroll.getBoundingClientRect().left + this.scroll.scrollLeft;
      this.playheadEl.style.left = left + x + 'px';
      this.playheadEl.style.display = inRange ? '' : 'none';
      this.playheadEl.style.height = this.scroll.scrollHeight + 'px';
    }
  }

  onRulerDown(e) {
    const r = this.rulerCanvas.getBoundingClientRect();
    const go = (cx) => app.setPlayhead(Math.round(clamp(this.laneF(cx - r.left), this.range[0], this.range[1] - 1)));
    go(e.clientX);
    dragPointer(e, { move: (dx, dy, ev) => go(ev.clientX) });
  }

  kfDown(e, r, i, skey) {
    e.stopPropagation();
    if (e.button !== 0) return;
    const seq = this.seq;
    const fps = seq.settings.fps;
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      if (this.selKf.has(skey)) this.selKf.delete(skey);
      else this.selKf.add(skey);
    } else if (!this.selKf.has(skey)) {
      this.selKf.clear();
      this.selKf.add(skey);
    }
    this.drawLanes();
    // drag selected keyframes horizontally
    const moving = [];
    for (const row of this.rows) {
      const p = row.o.get();
      if (!p || !p.kf) continue;
      p.kf.forEach((k, idx) => {
        const key = row.o.key + '@' + k.t.toFixed(5);
        if (this.selKf.has(key)) moving.push({ row, idx, t0: k.t });
      });
    }
    let begun = false;
    dragPointer(e, {
      cursor: 'ew-resize',
      move: (dx) => {
        if (!begun && Math.abs(dx) < 3) return;
        if (!begun) {
          app.history.begin('Move Keyframes');
          begun = true;
        }
        const df = Math.round((dx / this.lanesW) * (this.range[1] - this.range[0]));
        this.selKf.clear();
        for (const m of moving) {
          const p = m.row.o.get();
          const clip = m.row.clip;
          const f0 = Math.round(kfTimeToFrame(clip, m.t0, fps));
          let f = clamp(f0 + df, clip.start, clipEnd(clip));
          if (app.snapping && Math.abs(f - seq.playhead) <= 2) f = seq.playhead;
          const k = p.kf.find((x) => Math.abs(x.t - (m.cur ?? m.t0)) < 1e-6);
          if (!k) continue;
          k.t = clipKfTime(clip, f, fps);
          m.cur = k.t;
          this.selKf.add(m.row.o.key + '@' + k.t.toFixed(5));
        }
        for (const m of moving) m.row.o.get().kf.sort((a, b) => a.t - b.t);
        app.bus.emit('project:changed', { live: true });
      },
      up: () => {
        if (begun) {
          app.history.commit();
          app.bus.emit('project:changed', { label: 'Move Keyframes' });
        } else {
          const p = r.o.get();
          const k = p.kf[i];
          if (k) app.setPlayhead(Math.round(kfTimeToFrame(r.clip, k.t, fps)));
        }
      },
    });
  }

  kfMenu(e, r, i, skey) {
    e.preventDefault();
    if (!this.selKf.has(skey)) {
      this.selKf.clear();
      this.selKf.add(skey);
      this.drawLanes();
    }
    const apply = (interp) =>
      app.edit('Keyframe Interpolation', () => {
        for (const row of this.rows) {
          const p = row.o.get();
          if (!p || !p.kf) continue;
          for (const k of p.kf) if (this.selKf.has(row.o.key + '@' + k.t.toFixed(5))) k.interp = interp;
        }
      });
    const p = r.o.get();
    const cur = p.kf[i]?.interp || 'linear';
    showMenu(e.clientX, e.clientY, [
      { header: 'Temporal Interpolation' },
      ...INTERP.map(([v, l]) => ({ label: l, checked: cur === v && l !== 'Continuous Bezier', action: () => apply(v) })),
      { sep: true },
      { label: 'Delete', action: () => this.deleteSelected() },
    ]);
  }

  deleteSelected() {
    if (!this.selKf.size) {
      const seq = this.seq;
      const fxId = app.sel.effectId;
      if (!seq || !fxId) return false;
      for (const id of app.sel.clips) {
        const f = findClip(seq, id);
        const fx = f && f.clip.effects.find((e) => e.id === fxId);
        if (fx && !getEffectDef(fx.type)?.intrinsic) {
          app.edit('Remove ' + (getEffectDef(fx.type)?.name || 'Effect'), () => (findClip(seq, id).clip.effects = findClip(seq, id).clip.effects.filter((e) => e.id !== fxId)));
          app.sel.effectId = null;
          return true;
        }
      }
      return false;
    }
    app.edit('Delete Keyframes', () => {
      for (const row of this.rows) {
        const p = row.o.get();
        if (!p || !p.kf) continue;
        const keep = p.kf.filter((k) => !this.selKf.has(row.o.key + '@' + k.t.toFixed(5)));
        if (keep.length !== p.kf.length) {
          if (!keep.length) {
            p.v = p.kf[0].v;
            p.kf = null;
          } else p.kf = keep;
        }
      }
    });
    this.selKf.clear();
    return true;
  }

  // ---------- effect menus ----------
  effectMenu(clip, fx, def) {
    return [
      { label: 'Copy', kbd: MOD + '+C', action: () => (app.effectClipboard = [deepClone(fx)]) },
      { label: 'Paste', disabled: !app.effectClipboard, action: () => this.pasteEffects() },
      { label: 'Clear', disabled: !!def.intrinsic, action: () => app.edit('Remove Effect', () => (findClip(this.seq, clip.id).clip.effects = findClip(this.seq, clip.id).clip.effects.filter((x) => x.id !== fx.id))) },
      { sep: true },
      { label: 'Reset', action: () => this.resetEffect(clip, fx) },
      { label: 'Rename…', disabled: !!def.intrinsic, action: async () => { const n = await promptDialog('Rename Effect', 'Effect label:', fx.label || def.name); if (n != null) app.edit('Rename Effect', () => (this.fxOf(clip.id, fx.id).label = n === def.name ? '' : n)); } },
      { label: 'Save Preset…', action: () => app.services.presets?.saveDialog(clip, fx) },
      { sep: true },
      { label: 'Move Up', disabled: !!def.intrinsic, action: () => this.moveEffect(clip, fx, -1) },
      { label: 'Move Down', disabled: !!def.intrinsic, action: () => this.moveEffect(clip, fx, 1) },
    ];
  }

  moveEffect(clip, fx, dir) {
    app.edit('Reorder Effects', () => {
      const c = findClip(this.seq, clip.id).clip;
      const i = c.effects.findIndex((x) => x.id === fx.id);
      const j = i + dir;
      if (j < 0 || j >= c.effects.length || getEffectDef(c.effects[j].type)?.intrinsic) return;
      [c.effects[i], c.effects[j]] = [c.effects[j], c.effects[i]];
    });
  }

  pasteEffects() {
    if (!app.effectClipboard) return;
    app.edit('Paste Effects', () => {
      for (const id of app.sel.clips) {
        const f = findClip(this.seq, id);
        if (!f) continue;
        for (const fx of app.effectClipboard) {
          const def = getEffectDef(fx.type);
          if (!def || def.kind !== f.kind) continue;
          if (def.intrinsic) {
            const i = f.clip.effects.findIndex((x) => x.type === fx.type);
            if (i >= 0) f.clip.effects[i] = Object.assign(deepClone(fx), { id: f.clip.effects[i].id });
          } else f.clip.effects.push(Object.assign(deepClone(fx), { id: uid('fx_') }));
        }
      }
    });
  }

  resetEffect(clip, fx) {
    app.edit('Reset ' + (getEffectDef(fx.type)?.name || 'Effect'), () => {
      const f = this.fxOf(clip.id, fx.id);
      const fresh = createEffect(fx.type, this.defCtx(clip));
      f.params = fresh.params;
    });
  }

  // ---------- transition ----------
  renderTransition() {
    const seq = this.seq;
    const found = E.findTransition(seq, app.sel.transition);
    if (!found) return this.scroll.appendChild(this.empty);
    const { tr, track } = found;
    const def = getTransitionDef(tr.type);
    const fps = seq.settings.fps;
    const rg = transitionRange(track, tr);
    this.head.append(h('span.muted', 'Transition · '), h('b', def ? def.name : tr.type), h('span.muted', '  ›  ' + seq.name));
    const box = h('div.ec-trans');
    const preview = h('canvas.ec-trprev', { width: 160, height: 90 });
    this.drawTransitionPreview(preview, tr, def);
    const durField = timecodeField({ frames: tr.dur, fps, onCommit: (f) => app.edit('Transition Duration', () => {
      const t = E.findTransition(seq, tr.id);
      if (!t) return;
      const r2 = transitionRange(t.track, t.tr);
      let d = Math.max(1, f);
      if (r2.a && r2.b) d = Math.min(d, r2.a.dur + r2.b.dur);
      else d = Math.min(d, (r2.a || r2.b).dur);
      const ratio = t.tr.offset / Math.max(1, t.tr.dur);
      t.tr.dur = d;
      t.tr.offset = r2.a && r2.b ? Math.round(d * ratio) : r2.a ? d : 0;
    }) });
    const alignVal = !rg.a || !rg.b ? (rg.a ? 'end' : 'start') : tr.offset === 0 ? 'start' : tr.offset === tr.dur ? 'end' : Math.abs(tr.offset - tr.dur / 2) <= 1 ? 'center' : 'custom';
    const align = dropdown({
      options: [{ label: 'Center at Cut', value: 'center' }, { label: 'Start at Cut', value: 'start' }, { label: 'End at Cut', value: 'end' }, { label: 'Custom Start', value: 'custom' }],
      value: alignVal,
      onChange: (v) => app.edit('Transition Alignment', () => {
        const t = E.findTransition(seq, tr.id);
        if (!t) return;
        const r2 = transitionRange(t.track, t.tr);
        if (!(r2.a && r2.b)) return;
        if (v === 'center') t.tr.offset = Math.floor(t.tr.dur / 2);
        if (v === 'start') t.tr.offset = 0;
        if (v === 'end') t.tr.offset = t.tr.dur;
        t.tr.offset = clamp(t.tr.offset, Math.max(0, t.tr.dur - r2.b.dur), Math.min(t.tr.dur, r2.a.dur));
      }),
    });
    box.append(
      h('div.ec-trtop', preview, h('div.ec-trinfo', h('div', def?.name || tr.type), h('div.muted.tiny', (rg.a ? rg.a.name : '—') + '  →  ' + (rg.b ? rg.b.name : '—')))),
      h('div.form-row', h('label', 'Duration'), durField.el),
      h('div.form-row', h('label', 'Alignment'), align.el),
    );
    for (const pd of def?.params || []) {
      const p = tr.params[pd.id] || (tr.params[pd.id] = { v: defaultParamValue(pd), kf: null });
      let w;
      const set = (v) => app.edit(pd.name, () => (E.findTransition(seq, tr.id).tr.params[pd.id].v = v));
      if (pd.type === 'number') w = hotText({ value: p.v, precision: pd.precision ?? 1, min: pd.min, max: pd.max, unit: pd.unit === '%' ? ' %' : '', onCommit: set }).el;
      else if (pd.type === 'enum') w = dropdown({ options: pd.options, value: p.v, onChange: set }).el;
      else if (pd.type === 'bool') w = checkbox({ checked: p.v, onChange: set }).el;
      else if (pd.type === 'color') w = colorSwatch({ value: p.v, onChange: (v) => (this._pendingColor = v), onEnd: () => set(this._pendingColor) }).el;
      else if (pd.type === 'point') {
        const pv = p.v.slice();
        w = h('span.ec-point', hotText({ value: pv[0], precision: 1, onCommit: (x) => set([x, pv[1]]) }).el, hotText({ value: pv[1], precision: 1, onCommit: (y) => set([pv[0], y]) }).el);
      } else w = h('span', String(p.v));
      box.appendChild(h('div.form-row', h('label', pd.name), w));
    }
    box.appendChild(h('div', { style: { marginTop: '10px' } }, h('button.btn.sm', { onclick: () => actions.setDefaultTransition(tr.type) }, 'Set as Default Transition')));
    this.scroll.appendChild(box);
  }

  drawTransitionPreview(cv, tr, def) {
    const c = cv.getContext('2d');
    const g = c.createLinearGradient(0, 0, 160, 0);
    g.addColorStop(0, '#3a6fd8');
    g.addColorStop(0.5, '#7a4fd8');
    g.addColorStop(1, '#d84f8a');
    c.fillStyle = g;
    c.fillRect(0, 0, 160, 90);
    c.fillStyle = 'rgba(0,0,0,.5)';
    c.fillRect(0, 70, 160, 20);
    c.fillStyle = '#fff';
    c.font = 'bold 26px sans-serif';
    c.fillText('A', 22, 50);
    c.fillText('B', 120, 50);
    c.font = '11px sans-serif';
    c.fillText(def ? def.name : tr.type, 6, 84);
  }

  panelMenu() {
    return [
      { label: 'Show Timeline View', checked: this.showLanes, action: () => { this.showLanes = !this.showLanes; localStorage.setItem('videdi.ecLanes', this.showLanes ? '1' : '0'); this.render(); } },
      { label: 'Paste Effects', disabled: !app.effectClipboard, action: () => this.pasteEffects() },
      { label: 'Remove Effects…', action: () => actions.removeAttributesDialog() },
    ];
  }
}

export const effectControls = new EffectControls();
