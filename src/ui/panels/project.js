// Project panel: bins, list/icon views, import, drag to timeline.

import { app } from '../../core/app.js';
import { h, clamp, naturalCompare, MOD, pickFiles, fmtBytes, deepClone, uid } from '../../core/util.js';
import { framesToTC, fpsLabel } from '../../core/timecode.js';
import { findItem, itemSourceDuration, LABEL_COLORS, seqDuration, SYNTHETIC_KINDS } from '../../core/model.js';
import { registerPanel } from '../layout.js';
import { icon } from '../icons.js';
import { iconButton, slider } from '../widgets.js';
import { showMenu, labelMenu } from '../menus.js';
import { confirmDialog, modal, row } from '../dialogs.js';
import { actions } from '../../core/actions.js';
import { importFiles, thumbAt } from '../../core/media.js';
import * as E from '../../core/edit.js';
import { dropdown, checkbox } from '../widgets.js';

const COLS = [
  { id: 'name', label: 'Name', w: 230 },
  { id: 'fps', label: 'Frame Rate', w: 90 },
  { id: 'start', label: 'Media Start', w: 100 },
  { id: 'end', label: 'Media End', w: 100 },
  { id: 'dur', label: 'Media Duration', w: 110 },
  { id: 'video', label: 'Video Info', w: 110 },
  { id: 'audio', label: 'Audio Info', w: 110 },
  { id: 'size', label: 'Size', w: 80 },
];

function itemIcon(it) {
  if (it.type === 'bin') return it.expanded ? 'folderOpen' : 'folder';
  if (it.type === 'sequence') return 'sequence';
  if (it.type === 'synthetic') return it.kind === 'adjustment' || it.kind === 'transparent' ? 'adjustment' : 'solid';
  if (it.kind === 'audio') return 'audioFile';
  if (it.kind === 'image') return 'image';
  return 'film';
}

function itemDur(it) {
  const d = itemSourceDuration(app.project, it);
  return isFinite(d) ? d : null;
}

class ProjectPanel {
  constructor() {
    this.def = registerPanel({ id: 'project', title: 'Project', tabTitle: () => 'Project: ' + (app.project.name || 'Untitled'), menu: () => this.panelMenu(), onShow: () => this.render() });
    this.root = this.def.el;
    this.root.classList.add('proj-root');
    this.view = localStorage.getItem('videdi.projView') || 'list';
    this.bin = null; // current bin in icon view
    this.sort = { col: 'name', dir: 1 };
    this.filter = '';
    this.thumbSize = 140;
    this.lastClicked = null;
    this.def.currentBin = () => this.currentBin();
    this.def.deleteSelected = () => this.deleteSelected();
    this.def.copy = () => {};
    this.def.importDialog = () => this.importDialog();
    this.build();
    app.bus.on('project:changed project:loaded media:updated', () => this.render());
    app.bus.on('selection:changed', () => this.updateSelection());
    app.bus.on('project:rename', (id) => setTimeout(() => this.startRename(id), 30));
    app.bus.on('project:reveal', (id) => {
      const it = findItem(app.project, id);
      let p = it && it.parent;
      while (p) {
        const b = findItem(app.project, p);
        if (!b) break;
        b.expanded = true;
        p = b.parent;
      }
      this.render();
      const row = this.body.querySelector(`[data-id="${id}"]`);
      row && row.scrollIntoView({ block: 'nearest' });
    });
  }

  build() {
    this.search = h('input', { type: 'search', placeholder: 'Search' });
    this.search.addEventListener('input', () => {
      this.filter = this.search.value.toLowerCase();
      this.render();
    });
    this.search.addEventListener('keydown', (e) => e.stopPropagation());
    this.countEl = h('span.muted.tiny');
    this.crumb = h('div.proj-crumb');
    this.top = h('div.proj-top', h('div.proj-name'), h('div.search-box', icon('search'), this.search), this.countEl);
    this.body = h('div.proj-body', { tabIndex: 0 });
    this.listBtn = iconButton('listView', 'List View', () => this.setView('list'));
    this.iconBtn = iconButton('iconView', 'Icon View', () => this.setView('icon'));
    this.freeBtn = iconButton('freeform', 'Freeform View (not available)', () => {});
    this.freeBtn.disabled = true;
    this.zoomSl = slider({ value: this.thumbSize, min: 80, max: 260, step: 1, width: 80, onInput: (v) => { this.thumbSize = v; if (this.view === 'icon') this.render(); } });
    this.bottom = h(
      'div.proj-bottom',
      this.listBtn, this.iconBtn, this.freeBtn, this.zoomSl.el,
      h('div.spacer'),
      iconButton('automate', 'Automate to Sequence…', () => this.automateDialog()),
      iconButton('search', 'Find…', () => this.search.focus()),
      iconButton('newBin', 'New Bin', () => actions.newBin()),
      iconButton('newItem', 'New Item', (e) => this.newItemMenu(e.currentTarget)),
      iconButton('trash', 'Clear (Backspace)', () => this.deleteSelected()),
    );
    this.root.append(this.top, this.crumb, this.body, this.bottom);
    this.body.addEventListener('pointerdown', (e) => {
      if (e.target === this.body || e.target.classList.contains('proj-list') || e.target.classList.contains('proj-grid')) {
        app.sel.items.clear();
        this.updateSelection();
      }
    });
    this.body.addEventListener('dblclick', (e) => {
      if (e.target === this.body || e.target.classList.contains('proj-grid') || e.target.classList.contains('proj-list')) this.importDialog();
    });
    this.body.addEventListener('contextmenu', (e) => {
      if (e.target.closest('[data-id]')) return;
      e.preventDefault();
      showMenu(e.clientX, e.clientY, this.bgMenu());
    });
    this.body.addEventListener('dragover', (e) => {
      if ([...e.dataTransfer.types].includes('Files')) {
        e.preventDefault();
        this.body.classList.add('drop');
      }
    });
    this.body.addEventListener('dragleave', () => this.body.classList.remove('drop'));
    this.body.addEventListener('drop', async (e) => {
      this.body.classList.remove('drop');
      if (!e.dataTransfer.files.length) return;
      e.preventDefault();
      await importFiles([...e.dataTransfer.files], this.currentBin());
    });
    this.updateViewBtns();
  }

  currentBin() {
    if (this.view === 'icon') return this.bin;
    const sel = [...app.sel.items].map((id) => findItem(app.project, id)).find((i) => i && i.type === 'bin');
    return sel ? sel.id : null;
  }

  setView(v) {
    this.view = v;
    localStorage.setItem('videdi.projView', v);
    this.updateViewBtns();
    this.render();
  }
  updateViewBtns() {
    this.listBtn.classList.toggle('on', this.view === 'list');
    this.iconBtn.classList.toggle('on', this.view === 'icon');
  }

  items() {
    return app.project.items;
  }

  sorted(list) {
    const { col, dir } = this.sort;
    const key = (it) => {
      if (col === 'name') return it.name;
      if (col === 'dur') return itemDur(it) ?? -1;
      if (col === 'fps') return it.fps || it.settings?.fps || 0;
      if (col === 'size') return it.size || 0;
      return it.name;
    };
    return list.slice().sort((a, b) => {
      if ((a.type === 'bin') !== (b.type === 'bin')) return a.type === 'bin' ? -1 : 1;
      const ka = key(a), kb = key(b);
      return (typeof ka === 'number' ? ka - kb : naturalCompare(ka, kb)) * dir;
    });
  }

  matches(it) {
    return !this.filter || it.name.toLowerCase().includes(this.filter);
  }

  render() {
    if (!this.root.isConnected) return;
    app.services.layout?.refreshTitles();
    const items = this.items();
    this.countEl.textContent = items.filter((i) => i.type !== 'bin').length + ' items';
    this.top.querySelector('.proj-name').textContent = (app.project.name || 'Untitled') + '.vproj';
    this.body.innerHTML = '';
    if (this.view === 'list') this.renderList();
    else this.renderIcons();
  }

  renderList() {
    const table = h('div.proj-list');
    const head = h('div.proj-head');
    for (const c of COLS) {
      const cell = h('div.ph-cell', { style: { width: c.w + 'px' } }, c.label, this.sort.col === c.id ? (this.sort.dir > 0 ? ' ▲' : ' ▼') : '');
      cell.addEventListener('click', () => {
        this.sort = { col: c.id, dir: this.sort.col === c.id ? -this.sort.dir : 1 };
        this.render();
      });
      head.appendChild(cell);
    }
    table.appendChild(head);
    const addRows = (parent, depth) => {
      const children = this.sorted(this.items().filter((i) => (i.parent ?? null) === parent));
      for (const it of children) {
        const hasMatch = this.matches(it) || (it.type === 'bin' && this.binHasMatch(it.id));
        if (!hasMatch) continue;
        table.appendChild(this.listRow(it, depth));
        if (it.type === 'bin' && (it.expanded || this.filter)) addRows(it.id, depth + 1);
      }
    };
    addRows(null, 0);
    if (this.items().length === 0) table.appendChild(h('div.proj-hint', h('div', 'Import media to start'), h('div.muted.tiny', 'Double-click here, press ' + MOD + '+I, or drop files from your computer.')));
    this.body.appendChild(table);
  }

  binHasMatch(binId) {
    return this.items().some((i) => i.parent === binId && (this.matches(i) || (i.type === 'bin' && this.binHasMatch(i.id))));
  }

  info(it) {
    const d = itemDur(it);
    const fps = it.type === 'sequence' ? it.settings.fps : it.fps || 30;
    const tc = (s) => framesToTC(Math.round(s * fps), fps);
    const r = { fps: '', start: '', end: '', dur: '', video: '', audio: '', size: '' };
    if (it.type === 'bin') return r;
    if (it.type === 'sequence') {
      const df = seqDuration(it);
      r.fps = fpsLabel(fps);
      r.start = framesToTC(0, fps);
      r.end = framesToTC(Math.max(0, df - 1), fps);
      r.dur = framesToTC(df, fps);
      r.video = `${it.settings.width} x ${it.settings.height}`;
      r.audio = '48000 Hz - Stereo';
      return r;
    }
    if (it.type === 'media') {
      if (it.kind !== 'audio') {
        r.video = `${it.width} x ${it.height}`;
        r.fps = it.kind === 'video' ? fpsLabel(fps) + (it.fpsEstimated ? '*' : '') : '';
      }
      r.audio = it.hasAudio ? `48000 Hz - ${it.audioChannels === 1 ? 'Mono' : 'Stereo'}` : '';
      r.size = fmtBytes(it.size);
    }
    if (d != null) {
      r.start = tc(0);
      r.end = tc(d - 1 / fps);
      r.dur = tc((it.outPoint ?? d) - (it.inPoint ?? 0));
    } else if (it.type === 'synthetic' || it.kind === 'image') {
      r.dur = framesToTC(Math.round(app.prefs.stillDuration * 30), 30);
      r.video = `${it.width} x ${it.height}`;
    }
    return r;
  }

  listRow(it, depth) {
    const sel = app.sel.items.has(it.id);
    const r = h('div.proj-row' + (sel ? '.sel' : '') + (it.offline ? '.offline' : ''), { dataset: { id: it.id }, draggable: true });
    const inf = this.info(it);
    const label = h('span.proj-label', { style: { background: LABEL_COLORS[it.label] || '#888' } });
    const tw = it.type === 'bin' ? h('span.tw', { onclick: (e) => { e.stopPropagation(); it.expanded = !it.expanded; this.render(); } }, icon(it.expanded ? 'chevDown' : 'chevRight')) : h('span.tw');
    const nameCell = h('div.pc.name', { style: { width: COLS[0].w + 'px', paddingLeft: 4 + depth * 16 + 'px' } }, tw, label, icon(itemIcon(it), 'type-ico'), h('span.nm', it.name));
    r.appendChild(nameCell);
    for (const c of COLS.slice(1)) r.appendChild(h('div.pc', { style: { width: c.w + 'px' } }, inf[c.id] || ''));
    this.bindItemEvents(r, it);
    return r;
  }

  renderIcons() {
    const crumbs = [];
    let b = this.bin ? findItem(app.project, this.bin) : null;
    if (this.bin && !b) this.bin = null;
    while (b) {
      crumbs.unshift(b);
      b = b.parent ? findItem(app.project, b.parent) : null;
    }
    this.crumb.innerHTML = '';
    if (crumbs.length) {
      const root = h('span.crumb', app.project.name || 'Project');
      root.onclick = () => {
        this.bin = null;
        this.render();
      };
      this.crumb.appendChild(root);
      for (const c of crumbs) {
        const el = h('span.crumb', c.name);
        el.onclick = () => {
          this.bin = c.id;
          this.render();
        };
        this.crumb.append(' › ', el);
      }
    }
    this.crumb.style.display = crumbs.length ? '' : 'none';
    const grid = h('div.proj-grid', { style: { gridTemplateColumns: `repeat(auto-fill, minmax(${this.thumbSize}px, 1fr))` } });
    const list = this.sorted(this.items().filter((i) => (i.parent ?? null) === this.bin && this.matches(i)));
    for (const it of list) grid.appendChild(this.iconCard(it));
    if (!list.length && !this.items().length) grid.appendChild(h('div.proj-hint', h('div', 'Import media to start'), h('div.muted.tiny', 'Double-click here or press ' + MOD + '+I')));
    this.body.appendChild(grid);
  }

  iconCard(it) {
    const sel = app.sel.items.has(it.id);
    const thumbH = Math.round((this.thumbSize - 8) * 9 / 16);
    const cv = h('canvas.card-thumb', { width: this.thumbSize * 2, height: thumbH * 2, style: { height: thumbH + 'px' } });
    const card = h('div.proj-card' + (sel ? '.sel' : ''), { dataset: { id: it.id }, draggable: true }, cv);
    const inf = this.info(it);
    card.appendChild(h('div.card-meta', icon(itemIcon(it), 'type-ico'), h('span.nm', it.name), h('span.card-dur', inf.dur ? inf.dur.replace(/^00[:;]/, '') : '')));
    card.appendChild(h('span.proj-label.card-label', { style: { background: LABEL_COLORS[it.label] || '#888' } }));
    const draw = (t = null) => this.drawThumb(cv, it, t);
    draw();
    card.addEventListener('pointermove', (e) => {
      if (it.type !== 'media' || it.kind !== 'video') return;
      const r = card.getBoundingClientRect();
      const d = itemDur(it) || 0;
      draw(clamp((e.clientX - r.left) / r.width, 0, 1) * d);
    });
    card.addEventListener('pointerleave', () => draw());
    this.bindItemEvents(card, it);
    return card;
  }

  drawThumb(cv, it, t) {
    const c = cv.getContext('2d');
    c.fillStyle = '#151515';
    c.fillRect(0, 0, cv.width, cv.height);
    const fitDraw = (img) => {
      const s = Math.min(cv.width / img.width, cv.height / img.height);
      const w = img.width * s, hh = img.height * s;
      c.drawImage(img, (cv.width - w) / 2, (cv.height - hh) / 2, w, hh);
    };
    if (it.type === 'bin') {
      c.fillStyle = '#e8a33c';
      c.font = `${cv.height * 0.5}px sans-serif`;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText('📁', cv.width / 2, cv.height / 2);
      return;
    }
    if (it.type === 'media') {
      if (it.kind === 'audio') {
        const pk = app.rt(it.id).peaks;
        c.fillStyle = '#2fb67a';
        if (pk) {
          const arr = pk.peaks[0];
          for (let x = 0; x < cv.width; x++) {
            const i = Math.floor((x / cv.width) * arr.length);
            const v = arr[i] * cv.height * 0.45;
            c.fillRect(x, cv.height / 2 - v, 1, v * 2);
          }
        }
        return;
      }
      const img = t != null ? thumbAt(it, t) : app.rt(it.id).poster;
      if (img) fitDraw(img);
      if (t != null) {
        const d = itemDur(it) || 1;
        c.fillStyle = '#3b93ff';
        c.fillRect((t / d) * cv.width, cv.height - 6, 3, 6);
      }
      return;
    }
    if (it.type === 'synthetic') {
      if (it.kind === 'colormatte') {
        c.fillStyle = it.color;
        c.fillRect(0, 0, cv.width, cv.height);
      } else if (it.kind === 'bars') {
        const cols = ['#c0c0c0', '#c0c000', '#00c0c0', '#00c000', '#c000c0', '#c00000', '#0000c0'];
        cols.forEach((col, i) => {
          c.fillStyle = col;
          c.fillRect((i * cv.width) / 7, 0, cv.width / 7 + 1, cv.height * 0.7);
        });
      } else {
        c.fillStyle = it.kind === 'black' ? '#000' : '#444';
        c.fillRect(0, 0, cv.width, cv.height);
        c.fillStyle = '#bbb';
        c.font = `${Math.round(cv.height * 0.12)}px sans-serif`;
        c.textAlign = 'center';
        c.fillText(SYNTHETIC_KINDS[it.kind] || '', cv.width / 2, cv.height / 2);
      }
      return;
    }
    if (it.type === 'sequence') {
      c.fillStyle = '#2b3a22';
      c.fillRect(0, 0, cv.width, cv.height);
      c.fillStyle = '#79ac3c';
      for (let i = 0; i < 3; i++) c.fillRect(cv.width * 0.15 + i * 10, cv.height * (0.3 + i * 0.15), cv.width * 0.5, cv.height * 0.1);
    }
  }

  bindItemEvents(el, it) {
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.button !== 2) return;
      app.focusPanel('project');
      const sel = app.sel.items;
      if (e.button === 2 && sel.has(it.id)) return;
      if (e.shiftKey && this.lastClicked) {
        const ids = [...this.body.querySelectorAll('[data-id]')].map((x) => x.dataset.id);
        const a = ids.indexOf(this.lastClicked), b = ids.indexOf(it.id);
        if (a >= 0 && b >= 0) {
          if (!(e.ctrlKey || e.metaKey)) sel.clear();
          for (let i = Math.min(a, b); i <= Math.max(a, b); i++) sel.add(ids[i]);
        }
      } else if (e.ctrlKey || e.metaKey) {
        if (sel.has(it.id)) sel.delete(it.id);
        else sel.add(it.id);
        this.lastClicked = it.id;
      } else {
        if (sel.has(it.id) && sel.size === 1 && e.button === 0 && e.target.classList.contains('nm') && it.type !== 'sequence') {
          clearTimeout(this._renameT);
          this._renameT = setTimeout(() => this.startRename(it.id), 600);
        }
        if (!sel.has(it.id)) {
          sel.clear();
          sel.add(it.id);
        }
        this.lastClicked = it.id;
      }
      app.bus.emit('selection:changed');
    });
    el.addEventListener('dblclick', (e) => {
      clearTimeout(this._renameT);
      e.stopPropagation();
      this.openItem(it);
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showMenu(e.clientX, e.clientY, this.itemMenu(it));
    });
    el.addEventListener('dragstart', (e) => {
      clearTimeout(this._renameT);
      if (!app.sel.items.has(it.id)) {
        app.sel.items.clear();
        app.sel.items.add(it.id);
      }
      const items = [...app.sel.items].map((id) => findItem(app.project, id)).filter((x) => x && x.type !== 'bin');
      const ids = [...app.sel.items];
      app.dragItems = { items, ids };
      e.dataTransfer.setData('application/x-videdi-items', JSON.stringify(ids));
      e.dataTransfer.effectAllowed = 'copyMove';
    });
    el.addEventListener('dragend', () => setTimeout(() => (app.dragItems = null), 100));
    if (it.type === 'bin') {
      el.addEventListener('dragover', (e) => {
        if ([...e.dataTransfer.types].includes('application/x-videdi-items')) {
          e.preventDefault();
          el.classList.add('drop');
        }
      });
      el.addEventListener('dragleave', () => el.classList.remove('drop'));
      el.addEventListener('drop', (e) => {
        el.classList.remove('drop');
        const ids = app.dragItems?.ids;
        if (!ids) return;
        e.preventDefault();
        e.stopPropagation();
        app.edit('Move to Bin', () => {
          for (const id of ids) {
            const x = findItem(app.project, id);
            if (!x || x.id === it.id) continue;
            if (x.type === 'bin' && this.isAncestor(x.id, it.id)) continue;
            x.parent = it.id;
          }
          it.expanded = true;
        });
      });
    }
  }

  isAncestor(a, b) {
    let p = findItem(app.project, b);
    while (p) {
      if (p.id === a) return true;
      p = p.parent ? findItem(app.project, p.parent) : null;
    }
    return false;
  }

  openItem(it) {
    if (it.type === 'bin') {
      if (this.view === 'icon') {
        this.bin = it.id;
        this.render();
      } else {
        it.expanded = !it.expanded;
        this.render();
      }
      return;
    }
    if (it.type === 'sequence') return app.openSequence(it.id);
    if (it.offline) return app.services.persist?.relinkItem(it);
    actions.openInSource(it);
  }

  startRename(id) {
    const el = this.body.querySelector(`[data-id="${id}"] .nm`);
    const it = findItem(app.project, id);
    if (!el || !it) return;
    const inp = h('input.rename', { type: 'text', value: it.name });
    el.replaceWith(inp);
    inp.focus();
    inp.select();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      if (ok && inp.value.trim() && inp.value !== it.name) app.edit('Rename', () => (findItem(app.project, id).name = inp.value.trim()));
      else this.render();
    };
    inp.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
    });
    inp.addEventListener('blur', () => finish(true));
    inp.addEventListener('pointerdown', (e) => e.stopPropagation());
  }

  updateSelection() {
    for (const el of this.body.querySelectorAll('[data-id]')) el.classList.toggle('sel', app.sel.items.has(el.dataset.id));
  }

  selectedItems() {
    return [...app.sel.items].map((id) => findItem(app.project, id)).filter(Boolean);
  }

  async deleteSelected() {
    const items = this.selectedItems();
    if (!items.length) return;
    const ids = new Set();
    const collect = (it) => {
      ids.add(it.id);
      if (it.type === 'bin') app.project.items.filter((x) => x.parent === it.id).forEach(collect);
    };
    items.forEach(collect);
    // usage check
    const used = [];
    for (const s of app.project.items.filter((i) => i.type === 'sequence'))
      for (const t of [...s.videoTracks, ...s.audioTracks]) for (const c of t.clips) if (ids.has(c.itemId) && !ids.has(s.id)) used.push(c);
    if (used.length) {
      const ok = await confirmDialog(`${used.length} clip(s) in sequences use the selected item(s). Deleting will remove those clips from their sequences too.`, { title: 'Clear Items', ok: 'Yes', warn: true });
      if (!ok) return;
    }
    app.edit('Clear', () => {
      app.project.items = app.project.items.filter((i) => !ids.has(i.id));
      for (const s of app.project.items.filter((i) => i.type === 'sequence'))
        for (const t of [...s.videoTracks, ...s.audioTracks]) t.clips = t.clips.filter((c) => !ids.has(c.itemId));
      app.project.openSequenceIds = app.project.openSequenceIds.filter((x) => !ids.has(x));
      if (ids.has(app.project.activeSequenceId)) app.project.activeSequenceId = app.project.openSequenceIds[0] || null;
    });
    for (const id of ids) {
      app.services.sources?.disposeItem(id);
      app.services.persist?.deleteMedia(id);
    }
    if (ids.has(app.sourceItemId)) {
      app.sourceItemId = null;
      app.bus.emit('source:changed');
    }
    app.sel.items.clear();
    app.bus.emit('sequence:activated', app.seq);
  }

  duplicate() {
    const items = this.selectedItems().filter((i) => i.type !== 'bin');
    if (!items.length) return;
    app.edit('Duplicate', () => {
      for (const it of items) {
        const n = deepClone(it);
        n.id = uid(it.type === 'sequence' ? 'seq_' : it.type === 'media' ? 'med_' : 'syn_');
        n.name = it.name + ' Copy';
        if (it.type === 'sequence') {
          for (const t of [...n.videoTracks, ...n.audioTracks]) {
            t.id = uid('trk_');
            const map = new Map();
            for (const c of t.clips) {
              const nid = uid('clp_');
              map.set(c.id, nid);
              c.id = nid;
            }
            for (const tr of t.transitions) {
              tr.id = uid('tr_');
              tr.clipA = tr.clipA ? map.get(tr.clipA) : null;
              tr.clipB = tr.clipB ? map.get(tr.clipB) : null;
            }
          }
        }
        app.project.items.push(n);
        if (it.type === 'media') {
          const rt = app.rt(it.id);
          Object.assign(app.rt(n.id), { file: rt.file, url: rt.url, audioBuffer: rt.audioBuffer, peaks: rt.peaks, thumbs: rt.thumbs, poster: rt.poster });
          app.services.persist?.saveMedia(n.id, rt.file);
        }
      }
    });
  }

  copy() {
    /* project-level copy is handled by duplicate */
  }

  async importDialog() {
    const files = await pickFiles({ accept: 'video/*,audio/*,image/*,.srt,.vtt,.cube,.vproj,.mkv,.mov', multiple: true });
    if (files.length) await importFiles(files, this.currentBin());
  }

  newItemMenu(anchor) {
    const r = anchor.getBoundingClientRect();
    showMenu(r.left, r.top - 4, this.newItemItems());
  }
  newItemItems() {
    return [
      { label: 'Sequence…', kbd: MOD + '+N', action: () => actions.newSequenceDialog() },
      { label: 'Adjustment Layer…', action: () => actions.newSynthetic('adjustment') },
      { label: 'Bars and Tone…', action: () => actions.newSynthetic('bars') },
      { label: 'Black Video…', action: () => actions.newSynthetic('black') },
      { label: 'Color Matte…', action: () => actions.newSynthetic('colormatte') },
      { label: 'Universal Counting Leader…', action: () => actions.newSynthetic('leader') },
      { label: 'Transparent Video…', action: () => actions.newSynthetic('transparent') },
    ];
  }

  bgMenu() {
    return [
      { label: 'Paste', disabled: true },
      { sep: true },
      { label: 'New Bin', kbd: MOD + '+B', action: () => actions.newBin() },
      { label: 'New Item', submenu: this.newItemItems() },
      { label: 'Import…', kbd: MOD + '+I', action: () => this.importDialog() },
      { label: 'Find…', action: () => this.search.focus() },
      { sep: true },
      { label: 'View', submenu: [{ label: 'List', checked: this.view === 'list', action: () => this.setView('list') }, { label: 'Icon', checked: this.view === 'icon', action: () => this.setView('icon') }] },
    ];
  }

  itemMenu(it) {
    const multi = app.sel.items.size > 1;
    const items = this.selectedItems();
    return [
      { label: 'Cut', disabled: true },
      { label: 'Copy', disabled: true },
      { label: 'Clear', kbd: 'Backspace', action: () => this.deleteSelected() },
      { label: 'Duplicate', disabled: it.type === 'bin', action: () => this.duplicate() },
      { sep: true },
      { label: 'New Bin', action: () => actions.newBin() },
      { label: 'New Item', submenu: this.newItemItems() },
      { label: 'Import…', action: () => this.importDialog() },
      { sep: true },
      { label: 'Rename', disabled: multi, action: () => this.startRename(it.id) },
      { label: 'Label', submenu: () => labelMenu(it.label, (n) => actions.setLabel(n)) },
      { sep: true },
      { label: 'New Sequence From Clip', disabled: it.type === 'bin', action: () => actions.newSequenceFromItems(items.filter((x) => x.type !== 'bin')) },
      { label: 'Open in Source Monitor', disabled: it.type === 'bin' || it.type === 'sequence', action: () => actions.openInSource(it) },
      { label: 'Open in Timeline', disabled: it.type !== 'sequence', action: () => app.openSequence(it.id) },
      { label: 'Insert into Timeline at Playhead', disabled: !app.seq || it.type === 'bin', action: () => actions.placeItems(items.filter((x) => x.type !== 'bin'), app.seq.playhead, { vTrack: app.seq.patch.video ?? 0, aTrack: app.seq.patch.audio ?? 0, insert: true }) },
      { sep: true },
      { label: 'Link Media…', disabled: it.type !== 'media', action: () => app.services.persist?.relinkItem(it) },
      { label: 'Make Offline', disabled: it.type !== 'media', action: () => app.services.persist?.makeOffline(it) },
      { label: 'Sequence Settings…', disabled: it.type !== 'sequence', action: () => { app.openSequence(it.id); actions.sequenceSettings(); } },
      { label: 'Properties', disabled: it.type === 'bin', action: () => this.properties(it) },
    ];
  }

  properties(it) {
    const inf = this.info(it);
    const rows = [['Name', it.name], ['Type', it.type === 'media' ? it.kind : it.type], ['File size', it.size ? fmtBytes(it.size) : '—'], ['MIME', it.mime || '—'], ['Frame rate', inf.fps || '—'], ['Duration', inf.dur || '—'], ['Video', inf.video || '—'], ['Audio', inf.audio || '—'], ['In / Out', `${inf.start || '—'} / ${inf.end || '—'}`]];
    modal({ title: 'Properties', body: h('div.form-grid', rows.flatMap(([a, b]) => [h('label', a), h('div', String(b))])), buttons: [{ label: 'OK', cta: true }] });
  }

  automateDialog() {
    const items = this.selectedItems().filter((i) => i.type !== 'bin');
    if (!items.length) return app.toast('Select items in the Project panel first', 'warn');
    const s = app.seq;
    if (!s) return app.toast('Open a sequence first', 'warn');
    let order = 0, placement = 0, method = 0, overlap = 15, applyV = true, applyA = true, ignoreA = false, ignoreV = false;
    const ov = h('input', { type: 'number', value: overlap, style: { width: '70px' } });
    const body = h('div',
      row('Ordering', dropdown({ options: ['Sort Order', 'Selection Order'], value: 0, onChange: (v) => (order = v) }).el),
      row('Placement', dropdown({ options: ['Sequentially', 'At Unnumbered Markers'], value: 0, onChange: (v) => (placement = v) }).el),
      row('Method', dropdown({ options: ['Insert Edit', 'Overwrite Edit'], value: 0, onChange: (v) => (method = v) }).el),
      row('Clip Overlap (frames)', ov),
      h('div', { style: { margin: '6px 0' } }, checkbox({ checked: true, label: 'Apply Default Video Transition', onChange: (v) => (applyV = v) }).el),
      h('div', { style: { margin: '6px 0' } }, checkbox({ checked: true, label: 'Apply Default Audio Transition', onChange: (v) => (applyA = v) }).el),
      h('div', { style: { margin: '6px 0' } }, checkbox({ checked: false, label: 'Ignore Audio', onChange: (v) => (ignoreA = v) }).el),
      h('div', { style: { margin: '6px 0' } }, checkbox({ checked: false, label: 'Ignore Video', onChange: (v) => (ignoreV = v) }).el),
    );
    modal({
      title: 'Automate To Sequence',
      body,
      buttons: [
        { label: 'Cancel' },
        {
          label: 'OK',
          cta: true,
          action: () => {
            overlap = Math.max(0, parseInt(ov.value, 10) || 0);
            const list = order === 0 ? this.sorted(items) : items;
            const markers = s.markers.filter((m) => !m.name).map((m) => m.frame).sort((a, b) => a - b);
            app.edit('Automate to Sequence', () => {
              let pos = s.playhead;
              const placed = [];
              list.forEach((it, i) => {
                if (placement === 1 && markers[i] == null) return;
                const at = placement === 1 ? markers[i] : Math.max(0, pos - (i > 0 ? overlap : 0));
                const cs = E.placeItem(s, it, { at, mode: method === 0 ? 'insert' : 'overwrite', vTrack: ignoreV ? null : s.patch.video ?? 0, aTrack: ignoreA ? null : s.patch.audio ?? 0 });
                if (cs.length) pos = Math.max(...cs.map((c) => c.start + c.dur));
                placed.push(cs);
              });
              if (overlap > 0 || applyV || applyA) {
                for (let i = 1; i < placed.length; i++) {
                  for (const c of placed[i]) {
                    const f = s.videoTracks.concat(s.audioTracks).find((t) => t.clips.includes(c));
                    if (!f) continue;
                    const isV = c.kind === 'video';
                    if ((isV && !applyV) || (!isV && !applyA)) continue;
                    const type = isV ? app.prefs.defaultVideoTransition : app.prefs.defaultAudioTransition;
                    E.applyTransition(s, f, c, 'in', type, Math.max(2, overlap || Math.round(s.settings.fps)), 'center');
                  }
                }
              }
            });
          },
        },
      ],
    });
  }

  panelMenu() {
    return [
      { label: 'New Bin', action: () => actions.newBin() },
      { label: 'Import…', action: () => this.importDialog() },
      { sep: true },
      { label: 'List', checked: this.view === 'list', action: () => this.setView('list') },
      { label: 'Icon', checked: this.view === 'icon', action: () => this.setView('icon') },
      { sep: true },
      { label: 'Automate to Sequence…', action: () => this.automateDialog() },
    ];
  }
}

export const projectPanel = new ProjectPanel();
