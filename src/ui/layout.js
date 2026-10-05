// Docking workspace: panel groups with tabs, resizable splits, workspace presets,
// tab drag-to-dock and maximize (`).

import { h, dragPointer } from '../core/util.js';
import { app } from '../core/app.js';
import { icon } from './icons.js';
import { showMenu } from './menus.js';

export const panelDefs = new Map(); // id -> {id, title, el, menu?, onShow?, onResize?, minW?, minH?}

export function registerPanel(def) {
  def.el = def.el || h('div.panel-root');
  def.el.classList.add('panel-root');
  def.el.dataset.panel = def.id;
  def.el.addEventListener('pointerdown', () => app.focusPanel(def.id), true);
  panelDefs.set(def.id, def);
  app.panels[def.id] = def;
  return def;
}

// Layout presets. Node: {split:'row'|'col', sizes:[..], children:[..]} or {tabs:[ids], active}
const G = (tabs, active) => ({ tabs, active: active || tabs[0] });
export const WORKSPACES = {
  Assembly: {
    split: 'col', sizes: [0.6, 0.4], children: [
      { split: 'row', sizes: [0.55, 0.45], children: [G(['project', 'mediaBrowser', 'effects', 'markers', 'history']), G(['program'])] },
      { split: 'row', sizes: [0.025, 0.925, 0.05], fixed: [36, null, 64], children: [G(['tools']), G(['timeline']), G(['audioMeters'])] },
    ],
  },
  Editing: {
    split: 'col', sizes: [0.56, 0.44], children: [
      { split: 'row', sizes: [0.5, 0.5], children: [G(['source', 'effectControls', 'audioClipMixer', 'text'], 'source'), G(['program'])] },
      { split: 'row', sizes: [0.3, 0.025, 0.625, 0.05], fixed: [null, 36, null, 64], children: [G(['project', 'mediaBrowser', 'info', 'effects', 'markers', 'history']), G(['tools']), G(['timeline']), G(['audioMeters'])] },
    ],
  },
  Color: {
    split: 'col', sizes: [0.6, 0.4], children: [
      { split: 'row', sizes: [0.36, 0.42, 0.22], children: [G(['scopes', 'source', 'effectControls']), G(['program']), G(['lumetri'])] },
      { split: 'row', sizes: [0.025, 0.725, 0.2, 0.05], fixed: [36, null, null, 64], children: [G(['tools']), G(['timeline']), G(['project', 'effects', 'history']), G(['audioMeters'])] },
    ],
  },
  Effects: {
    split: 'col', sizes: [0.58, 0.42], children: [
      { split: 'row', sizes: [0.32, 0.45, 0.23], children: [G(['effectControls', 'source', 'audioClipMixer']), G(['program']), G(['effects', 'essentialGraphics', 'lumetri'])] },
      { split: 'row', sizes: [0.22, 0.025, 0.705, 0.05], fixed: [null, 36, null, 64], children: [G(['project', 'history', 'info']), G(['tools']), G(['timeline']), G(['audioMeters'])] },
    ],
  },
  Audio: {
    split: 'col', sizes: [0.58, 0.42], children: [
      { split: 'row', sizes: [0.35, 0.43, 0.22], children: [G(['audioMixer', 'source', 'effectControls', 'audioClipMixer']), G(['program']), G(['essentialSound', 'effects'])] },
      { split: 'row', sizes: [0.22, 0.025, 0.705, 0.05], fixed: [null, 36, null, 64], children: [G(['project', 'markers', 'history']), G(['tools']), G(['timeline']), G(['audioMeters'])] },
    ],
  },
  Graphics: {
    split: 'col', sizes: [0.6, 0.4], children: [
      { split: 'row', sizes: [0.3, 0.47, 0.23], children: [G(['effectControls', 'source', 'project']), G(['program']), G(['essentialGraphics', 'effects'])] },
      { split: 'row', sizes: [0.025, 0.925, 0.05], fixed: [36, null, 64], children: [G(['tools']), G(['timeline']), G(['audioMeters'])] },
    ],
  },
  Captions: {
    split: 'col', sizes: [0.58, 0.42], children: [
      { split: 'row', sizes: [0.3, 0.47, 0.23], children: [G(['text', 'project']), G(['program']), G(['essentialGraphics', 'effectControls'])] },
      { split: 'row', sizes: [0.025, 0.925, 0.05], fixed: [36, null, 64], children: [G(['tools']), G(['timeline']), G(['audioMeters'])] },
    ],
  },
};
export const WORKSPACE_ORDER = ['Assembly', 'Editing', 'Color', 'Effects', 'Audio', 'Graphics', 'Captions'];

export const layout = {
  root: null,
  container: null,
  name: 'Editing',
  groups: [],
  maximized: null,

  init(container) {
    this.container = container;
    window.addEventListener('resize', () => this.notifyResize());
    app.bus.on('panel:focus', (id) => this.updateFocus(id));
  },

  load(name, { reset = false } = {}) {
    this.name = name;
    let tree = null;
    if (!reset) {
      try {
        tree = JSON.parse(localStorage.getItem('videdi.ws.' + name) || 'null');
      } catch (e) {
        tree = null;
      }
    }
    if (!tree || !validTree(tree)) tree = JSON.parse(JSON.stringify(WORKSPACES[name] || WORKSPACES.Editing));
    this.tree = tree;
    localStorage.setItem('videdi.workspace', name);
    this.render();
    app.bus.emit('workspace:changed', name);
  },

  save() {
    try {
      localStorage.setItem('videdi.ws.' + this.name, JSON.stringify(this.tree));
    } catch (e) {
      /* ignore */
    }
  },

  render() {
    // detach panel roots
    for (const d of panelDefs.values()) d.el.remove();
    this.container.innerHTML = '';
    this.groups = [];
    this.maximized = null;
    const used = new Set();
    const el = this.renderNode(this.tree, used);
    this.container.appendChild(el);
    this.updateFocus(app.focusedPanel);
    requestAnimationFrame(() => this.notifyResize());
  },

  renderNode(node, used) {
    if (node.tabs) {
      node.tabs = node.tabs.filter((t) => panelDefs.has(t) && !used.has(t));
      node.tabs.forEach((t) => used.add(t));
      if (!node.tabs.includes(node.active)) node.active = node.tabs[0];
      return this.renderGroup(node);
    }
    const wrap = h('div.lay-split.' + node.split);
    node.children.forEach((child, i) => {
      const cel = h('div.lay-node');
      const fixed = node.fixed && node.fixed[i];
      if (fixed) cel.style.flex = `0 0 ${fixed}px`;
      else cel.style.flex = `${node.sizes[i]} 1 0px`;
      cel.appendChild(this.renderNode(child, used));
      wrap.appendChild(cel);
      if (i < node.children.length - 1) {
        const sp = h('div.lay-splitter');
        sp.addEventListener('pointerdown', (e) => this.startResize(e, node, i, wrap, sp));
        wrap.appendChild(sp);
      }
    });
    return wrap;
  },

  startResize(e, node, i, wrap, sp) {
    e.preventDefault();
    const nodes = [...wrap.children].filter((c) => c.classList.contains('lay-node'));
    const a = nodes[i], b = nodes[i + 1];
    const horiz = node.split === 'row';
    const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
    const sizeA = horiz ? ra.width : ra.height, sizeB = horiz ? rb.width : rb.height;
    const fixedA = node.fixed && node.fixed[i], fixedB = node.fixed && node.fixed[i + 1];
    const total = sizeA + sizeB;
    const flexTotal = node.sizes[i] + node.sizes[i + 1];
    sp.classList.add('drag');
    dragPointer(e, {
      cursor: horiz ? 'col-resize' : 'row-resize',
      move: (dx, dy) => {
        const d = horiz ? dx : dy;
        const na = Math.max(30, Math.min(total - 30, sizeA + d));
        const nb = total - na;
        if (fixedA) {
          node.fixed[i] = Math.round(na);
          a.style.flex = `0 0 ${na}px`;
        }
        if (fixedB) {
          node.fixed[i + 1] = Math.round(nb);
          b.style.flex = `0 0 ${nb}px`;
        }
        if (!fixedA && !fixedB) {
          node.sizes[i] = (flexTotal * na) / total;
          node.sizes[i + 1] = (flexTotal * nb) / total;
          a.style.flex = `${node.sizes[i]} 1 0px`;
          b.style.flex = `${node.sizes[i + 1]} 1 0px`;
        } else if (fixedA && !fixedB) {
          /* b flexes */
        }
        this.notifyResize();
      },
      up: () => {
        sp.classList.remove('drag');
        this.save();
      },
    });
  },

  renderGroup(node) {
    const g = h('div.pgroup');
    const tabs = h('div.ptabs');
    const body = h('div.pbody');
    g.append(tabs, body);
    const grp = { node, el: g, tabsEl: tabs, body };
    this.groups.push(grp);
    for (const id of node.tabs) {
      const def = panelDefs.get(id);
      const tab = h('div.ptab', { dataset: { id } }, h('span.tlabel', def.tabTitle ? def.tabTitle() : def.title));
      const menuBtn = h('span.pmenu', { title: 'Panel menu' }, icon('menu'));
      menuBtn.firstChild.querySelector('svg').setAttribute('width', '11');
      menuBtn.firstChild.querySelector('svg').setAttribute('height', '11');
      menuBtn.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        const r = menuBtn.getBoundingClientRect();
        const items = [
          ...(def.menu ? def.menu() : []),
          ...(def.menu ? [{ sep: true }] : []),
          { label: 'Maximize Frame', kbd: '`', action: () => this.toggleMaximize(id) },
          { label: 'Close Panel', action: () => this.closePanel(id) },
        ];
        showMenu(r.left, r.bottom, items);
      });
      tab.appendChild(menuBtn);
      tab.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        this.activate(id);
        app.focusPanel(id);
        this.startTabDrag(e, id, tab);
      });
      tab.addEventListener('dblclick', () => this.toggleMaximize(id));
      tabs.appendChild(tab);
      def.tabEl = tab;
    }
    for (const id of node.tabs) {
      const def = panelDefs.get(id);
      body.appendChild(def.el);
      def.group = grp;
    }
    this.showActive(grp);
    g.addEventListener('pointerdown', () => {
      if (node.active) app.focusPanel(node.active);
    });
    return g;
  },

  showActive(grp) {
    for (const id of grp.node.tabs) {
      const def = panelDefs.get(id);
      const on = id === grp.node.active;
      def.el.classList.toggle('shown', on);
      def.tabEl?.classList.toggle('active', on);
      if (on && def.onShow) requestAnimationFrame(() => def.onShow());
    }
  },

  activate(id) {
    const def = panelDefs.get(id);
    if (!def) return;
    if (!def.group || !def.el.isConnected) {
      // Panel not in layout: add as tab to the group of the program monitor's sibling or first group.
      const target = this.groups.find((g) => g.node.tabs.includes('project')) || this.groups[0];
      target.node.tabs.push(id);
      target.node.active = id;
      this.render();
      return;
    }
    def.group.node.active = id;
    this.showActive(def.group);
    this.save();
  },

  isVisible(id) {
    const def = panelDefs.get(id);
    return !!(def && def.group && def.group.node.active === id && def.el.isConnected);
  },

  closePanel(id) {
    const remove = (node) => {
      if (node.tabs) {
        node.tabs = node.tabs.filter((t) => t !== id);
        return;
      }
      node.children.forEach(remove);
    };
    remove(this.tree);
    this.prune(this.tree);
    this.render();
    this.save();
  },

  prune(node) {
    if (node.tabs) return node.tabs.length > 0;
    const keep = [];
    node.children.forEach((c, i) => {
      if (this.prune(c)) keep.push(i);
    });
    node.children = keep.map((i) => node.children[i]);
    node.sizes = keep.map((i) => node.sizes[i]);
    if (node.fixed) node.fixed = keep.map((i) => node.fixed[i]);
    return node.children.length > 0;
  },

  toggleMaximize(id) {
    const def = panelDefs.get(id || app.focusedPanel);
    if (!def || !def.group) return;
    const g = def.group.el;
    if (this.maximized === g) {
      g.classList.remove('maximized');
      this.maximized = null;
    } else {
      if (this.maximized) this.maximized.classList.remove('maximized');
      g.classList.add('maximized');
      this.maximized = g;
    }
    this.notifyResize();
  },

  startTabDrag(e, id, tab) {
    let started = false;
    let ghost = null;
    let over = null;
    dragPointer(e, {
      move: (dx, dy, ev) => {
        if (!started && Math.hypot(dx, dy) < 8) return;
        if (!started) {
          started = true;
          tab.classList.add('dragging');
          ghost = h('div.drag-ghost', panelDefs.get(id).title);
          document.body.appendChild(ghost);
        }
        ghost.style.left = ev.clientX + 12 + 'px';
        ghost.style.top = ev.clientY + 8 + 'px';
        const target = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.pgroup');
        if (over && over !== target) over.classList.remove('drop-target');
        over = target;
        if (over) over.classList.add('drop-target');
      },
      up: () => {
        tab.classList.remove('dragging');
        if (ghost) ghost.remove();
        if (over) over.classList.remove('drop-target');
        if (!started || !over) return;
        const grp = this.groups.find((g) => g.el === over);
        if (!grp || grp.node.tabs.includes(id)) return;
        // move tab
        const remove = (node) => {
          if (node.tabs) node.tabs = node.tabs.filter((t) => t !== id);
          else node.children.forEach(remove);
        };
        remove(this.tree);
        grp.node.tabs.push(id);
        grp.node.active = id;
        this.prune(this.tree);
        this.render();
        this.save();
      },
    });
  },

  updateFocus(id) {
    for (const g of this.groups) g.el.classList.toggle('focused', g.node.tabs.includes(id) && g.node.active === id);
  },

  notifyResize() {
    for (const d of panelDefs.values()) if (d.onResize && d.el.isConnected && d.el.classList.contains('shown')) d.onResize();
  },

  refreshTitles() {
    for (const d of panelDefs.values()) {
      const l = d.tabEl?.querySelector('.tlabel');
      if (l) l.textContent = d.tabTitle ? d.tabTitle() : d.title;
    }
  },
};

function validTree(t) {
  if (!t) return false;
  if (t.tabs) return Array.isArray(t.tabs);
  return Array.isArray(t.children) && t.children.every(validTree);
}
