// Effects panel: browsable tree of effects, transitions and presets.

import { app } from '../../core/app.js';
import { h } from '../../core/util.js';
import { registry } from '../../core/registry.js';
import { registerPanel } from '../layout.js';
import { icon } from '../icons.js';
import { iconButton } from '../widgets.js';
import { showMenu } from '../menus.js';
import { actions } from '../../core/actions.js';
import { presets } from '../../core/presets.js';
import { findClip } from '../../core/model.js';

const VIDEO_CAT_ORDER = ['Adjust', 'Blur & Sharpen', 'Channel', 'Color Correction', 'Distort', 'Generate', 'Image Control', 'Keying', 'Noise & Grain', 'Perspective', 'Stylize', 'Time', 'Transform', 'Transition', 'Video'];

class EffectsPanel {
  constructor() {
    this.def = registerPanel({ id: 'effects', title: 'Effects', onShow: () => this.render() });
    this.root = this.def.el;
    this.root.classList.add('fx-root');
    this.open = new Set(JSON.parse(localStorage.getItem('videdi.fxOpen') || '["Video Effects","Video Transitions"]'));
    this.query = '';
    this.filters = { accel: false, b32: false, yuv: false };
    this.search = h('input', { type: 'search', placeholder: 'Search effects' });
    this.search.addEventListener('input', () => {
      this.query = this.search.value.toLowerCase();
      this.render();
    });
    this.search.addEventListener('keydown', (e) => e.stopPropagation());
    const fbtn = (k, ic, title) => {
      const b = iconButton(ic, title, () => {
        this.filters[k] = !this.filters[k];
        b.classList.toggle('on', this.filters[k]);
        this.render();
      });
      return b;
    };
    this.top = h('div.fx-top', h('div.search-box', icon('search'), this.search), fbtn('accel', 'lightning', 'Accelerated Effects'), fbtn('b32', 'bit32', '32-bit Color Effects'), fbtn('yuv', 'yuv', 'YUV Effects'));
    this.tree = h('div.fx-tree');
    this.bottom = h('div.fx-bottom', h('span.muted.tiny', 'Drag onto clips or edit points · Double-click to apply'), h('div.spacer'), iconButton('newBin', 'New Custom Bin', () => app.toast('Custom bins: save presets from Effect Controls (right-click an effect › Save Preset)', 'info')));
    this.root.append(this.top, this.tree, this.bottom);
    app.bus.on('presets:changed prefs:changed', () => this.render());
  }

  saveOpen() {
    localStorage.setItem('videdi.fxOpen', JSON.stringify([...this.open]));
  }

  structure() {
    const groupBy = (arr, key = 'category') => {
      const m = new Map();
      for (const x of arr) {
        const k = x[key] || 'Other';
        if (!m.has(k)) m.set(k, []);
        m.get(k).push(x);
      }
      return m;
    };
    const ve = [...registry.videoEffects.values()].filter((d) => !d.intrinsic);
    const ae = [...registry.audioEffects.values()].filter((d) => !d.intrinsic);
    const vt = [...registry.videoTransitions.values()];
    const at = [...registry.audioTransitions.values()];
    const allPresets = presets.all();
    const vcats = groupBy(ve);
    const sortedV = new Map([...vcats.entries()].sort((a, b) => VIDEO_CAT_ORDER.indexOf(a[0]) - VIDEO_CAT_ORDER.indexOf(b[0])));
    return [
      { name: 'Presets', children: groupBy(allPresets.filter((p) => !p.lumetri), 'folder'), kind: 'preset' },
      { name: 'Lumetri Presets', children: groupBy(allPresets.filter((p) => p.lumetri), 'folder'), kind: 'preset' },
      { name: 'Audio Effects', children: groupBy(ae), kind: 'audio' },
      { name: 'Audio Transitions', children: groupBy(at), kind: 'atrans' },
      { name: 'Video Effects', children: sortedV, kind: 'video' },
      { name: 'Video Transitions', children: groupBy(vt), kind: 'vtrans' },
    ];
  }

  render() {
    if (!this.root.isConnected) return;
    this.tree.innerHTML = '';
    const q = this.query;
    for (const top of this.structure()) {
      const topKey = top.name;
      const topOpen = q ? true : this.open.has(topKey);
      const entries = [];
      for (const [cat, list] of top.children) {
        const items = list.filter((d) => !q || d.name.toLowerCase().includes(q) || cat.toLowerCase().includes(q));
        if (this.filters.b32 && top.kind === 'video') items.splice(0, items.length, ...items.filter((d) => d.id !== 'noise'));
        if (items.length) entries.push([cat, items]);
      }
      if (q && !entries.length) continue;
      const row = h('div.fx-folder.top', h('span.tw', icon(topOpen ? 'chevDown' : 'chevRight')), icon(topOpen ? 'folderOpen' : 'folder', 'fold-ico'), h('span', top.name));
      row.onclick = () => {
        if (this.open.has(topKey)) this.open.delete(topKey);
        else this.open.add(topKey);
        this.saveOpen();
        this.render();
      };
      this.tree.appendChild(row);
      if (!topOpen) continue;
      const flat = top.kind === 'atrans' && entries.length === 1 && false;
      for (const [cat, items] of entries) {
        const ck = topKey + '/' + cat;
        const cOpen = q ? true : this.open.has(ck);
        if (!flat) {
          const crow = h('div.fx-folder.sub', h('span.tw', icon(cOpen ? 'chevDown' : 'chevRight')), icon(cOpen ? 'folderOpen' : 'folder', 'fold-ico'), h('span', cat));
          crow.onclick = () => {
            if (this.open.has(ck)) this.open.delete(ck);
            else this.open.add(ck);
            this.saveOpen();
            this.render();
          };
          this.tree.appendChild(crow);
        }
        if (!cOpen) continue;
        for (const d of items.sort((a, b) => a.name.localeCompare(b.name))) this.tree.appendChild(this.itemRow(d, top.kind));
      }
    }
  }

  itemRow(d, kind) {
    const isTrans = kind === 'vtrans' || kind === 'atrans';
    const isPreset = kind === 'preset';
    const isDefault = isTrans && (d.id === app.prefs.defaultVideoTransition || d.id === app.prefs.defaultAudioTransition);
    const ic = isPreset ? 'star' : isTrans ? 'compare' : 'fx';
    const badges = h('span.fx-badges');
    if (kind === 'video' || kind === 'vtrans') {
      badges.appendChild(icon('lightning', 'badge'));
      badges.appendChild(icon('bit32', 'badge'));
    }
    const row = h('div.fx-item' + (isDefault ? '.default' : ''), { draggable: true, title: isTrans ? 'Drag onto an edit point' : 'Drag onto a clip' }, h('span.tw'), icon(ic, 'item-ico'), h('span.nm', d.name), badges);
    row.addEventListener('dragstart', (e) => {
      const data = isPreset ? { preset: d.id, kind: d.kind } : { id: d.id, kind: d.kind, transition: isTrans };
      e.dataTransfer.setData('application/x-videdi-effect', JSON.stringify(data));
      e.dataTransfer.effectAllowed = 'copy';
    });
    row.addEventListener('dblclick', () => {
      if (isPreset) return actions.applyPreset(d);
      if (isTrans) {
        actions.setDefaultTransition(d.id);
        return actions.applyDefaultTransition(d.kind);
      }
      actions.applyEffect(d.id);
    });
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const items = [];
      if (isTrans) items.push({ label: 'Set Selected as Default Transition', action: () => actions.setDefaultTransition(d.id) });
      if (!isTrans && !isPreset) items.push({ label: 'Apply to Selected Clips', action: () => actions.applyEffect(d.id) });
      if (isPreset) items.push({ label: 'Apply to Selected Clips', action: () => actions.applyPreset(d) });
      if (d.user) items.push({ label: 'Delete Preset', action: () => presets.remove(d.id) });
      showMenu(e.clientX, e.clientY, items);
    });
    row.addEventListener('pointerdown', () => {
      this.tree.querySelectorAll('.fx-item.sel').forEach((x) => x.classList.remove('sel'));
      row.classList.add('sel');
    });
    return row;
  }
}

export const effectsPanel = new EffectsPanel();
export { findClip };
