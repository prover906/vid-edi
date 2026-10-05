// Vid-Edi Pro bootstrap.

import { app } from './core/app.js';
import { h, MOD, fmtBytes } from './core/util.js';
import { LABEL_COLORS, createProject, createSequence, createSyntheticItem, createClip, intrinsicEffectsFor, createEffect } from './core/model.js';
import * as E from './core/edit.js';
import { actions } from './core/actions.js';
import { initKeyboard, menubarDef, run, kbdLabel } from './core/commands.js';
import { persist } from './core/persistence.js';
import { captions } from './core/captions.js';
import { luts } from './core/luts.js';
import { presets } from './core/presets.js';
import { importFiles } from './core/media.js';
import { Compositor } from './engine/compositor.js';
import { sources } from './engine/sources.js';
import { exporter } from './engine/exporter.js';
import { playback } from './engine/playback.js';
import { audio } from './engine/audioEngine.js';
import './engine/transitions.js';
import { onFontLoaded, createTextLayer, createShapeLayer, GRAPHIC_TEMPLATES } from './engine/graphics.js';
import { layout, WORKSPACE_ORDER } from './ui/layout.js';
import { buildMenubar } from './ui/menus.js';
import { initToasts, modal, row } from './ui/dialogs.js';
import { icon } from './ui/icons.js';
import { prefsUI, applyBrightness } from './ui/prefs.js';
// panels (self-registering)
import { timeline } from './ui/panels/timeline.js';
import { programMonitor, sourceMonitor } from './ui/panels/monitors.js';
import { projectPanel } from './ui/panels/project.js';
import './ui/panels/effectControls.js';
import './ui/panels/effects.js';
import './ui/panels/lumetriPanel.js';
import './ui/panels/graphicsPanel.js';
import './ui/panels/audioPanels.js';
import './ui/panels/misc.js';

function fatal(msg) {
  document.body.innerHTML = '';
  document.body.appendChild(h('div', { style: { padding: '40px', color: '#ddd', font: '15px sans-serif', maxWidth: '640px' } }, h('h2', 'Vid-Edi cannot start'), h('p', msg), h('p', { style: { color: '#999' } }, 'Use a recent version of Chrome, Edge, Firefox or Safari with hardware acceleration enabled.')));
}

function buildHeader() {
  const header = document.getElementById('header');
  header.innerHTML = '';
  const title = h('div.proj-title');
  const left = h('div.hd-left', h('button.hd-btn', { title: 'Home', onclick: () => start.show() }, icon('home')), h('button.hd-btn', { title: 'Import (' + MOD + '+I)', onclick: () => run('import') }, icon('importIcon'), 'Import'), title);
  const center = h('div.hd-center');
  const right = h('div.hd-right', h('button.hd-btn', { title: 'Undo', onclick: () => run('undo') }, icon('undo')), h('button.hd-btn', { title: 'Redo', onclick: () => run('redo') }, icon('redo')), h('button.hd-btn.primary', { title: 'Export Media (' + MOD + '+M)', onclick: () => run('exportMedia') }, icon('exportIcon'), 'Export'));
  header.append(left, center, right);
  const renderTabs = () => {
    center.innerHTML = '';
    for (const w of WORKSPACE_ORDER) {
      const t = h('div.ws-tab' + (layout.name === w ? '.active' : ''), w);
      t.onclick = () => layout.load(w);
      t.title = 'Alt+Shift+' + (WORKSPACE_ORDER.indexOf(w) + 1);
      center.appendChild(t);
    }
  };
  const renderTitle = () => {
    title.innerHTML = '';
    title.append(h('b', app.project.name || 'Untitled'), app.dirty ? ' ●' : '');
  };
  app.bus.on('workspace:changed', renderTabs);
  app.bus.on('project:loaded project:changed saved dirty', renderTitle);
  renderTabs();
  renderTitle();
}

function buildStatusBar() {
  const sb = document.getElementById('statusbar');
  const msg = h('div.sb-msg', 'Ready');
  const right = h('div.sb-right');
  sb.append(msg, right);
  let t = 0;
  app.bus.on('status', (m) => {
    msg.textContent = m || '';
    clearTimeout(t);
    if (m) t = setTimeout(() => (msg.textContent = ''), 6000);
  });
  const gl = app.services.compositor.gl.gl;
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'WebGL 2';
  const upd = () => {
    const s = app.seq;
    right.innerHTML = '';
    if (s) right.append(h('span', `${s.settings.width}×${s.settings.height} · ${(+s.settings.fps.toFixed(3))} fps`));
    right.append(h('span', { title: renderer }, 'GPU: ' + String(renderer).replace(/ANGLE \(|\)/g, '').slice(0, 40)));
    right.append(h('span', persist.lastSaved ? 'Saved ' + new Date(persist.lastSaved).toLocaleTimeString() : 'Not saved'));
  };
  app.bus.on('sequence:activated saved project:loaded', upd);
  upd();
}

// ---------------- Sample project ----------------
function makeSampleProject() {
  const p = createProject('Sample Project');
  app.setProject(p, 'New Project');
  const seq = createSequence(p, { name: 'Sample Sequence', width: 1920, height: 1080, fps: 30 });
  p.items.push(seq);
  const set = seq.settings;
  const leader = createSyntheticItem('leader', set);
  const bars = createSyntheticItem('bars', set);
  const blue = createSyntheticItem('colormatte', set, { color: '#1e4fa8', name: 'Blue Matte' });
  const orange = createSyntheticItem('colormatte', set, { color: '#d9662b', name: 'Orange Matte' });
  const adj = createSyntheticItem('adjustment', set);
  p.items.push(leader, bars, blue, orange, adj);
  app.project.activeSequenceId = seq.id;
  app.project.openSequenceIds = [seq.id];
  const fps = 30;
  E.placeItem(seq, bars, { at: 0, vTrack: 0, aTrack: 0, dur: 3 * fps });
  E.placeItem(seq, blue, { at: 3 * fps, vTrack: 0, aTrack: null, dur: 5 * fps });
  E.placeItem(seq, orange, { at: 8 * fps, vTrack: 0, aTrack: null, dur: 5 * fps });
  const t0 = seq.videoTracks[0];
  E.applyTransition(seq, t0, t0.clips[1], 'out', 'crossDissolve', fps);
  E.applyTransition(seq, t0, t0.clips[0], 'out', 'push', fps);
  // Title graphic
  const ctx = { w: 1920, h: 1080, seqW: 1920, seqH: 1080 };
  const title = createClip({ kind: 'video', name: 'Vid-Edi Pro', start: 3 * fps + 10, dur: 4 * fps, label: 'Rose', graphic: { layers: GRAPHIC_TEMPLATES[2].make(1920, 1080) }, effects: intrinsicEffectsFor('video', ctx) });
  title.graphic.layers[0].text = 'VID-EDI PRO';
  title.graphic.layers[1].text = 'Edit video in your browser';
  const op = title.effects.find((e) => e.type === 'opacity');
  op.params.opacity.kf = [{ t: 0, v: 0, interp: 'linear' }, { t: 0.6, v: 100, interp: 'linear' }, { t: 3.4, v: 100, interp: 'linear' }, { t: 4, v: 0, interp: 'linear' }];
  seq.videoTracks[1].clips.push(title);
  const lt = createClip({ kind: 'video', name: 'Lower Third', start: 8 * fps + 15, dur: 4 * fps, label: 'Rose', graphic: { layers: GRAPHIC_TEMPLATES[3].make(1920, 1080) }, effects: intrinsicEffectsFor('video', ctx) });
  seq.videoTracks[1].clips.push(lt);
  // adjustment layer with Lumetri look over the orange section
  const adjClip = E.placeItem(seq, adj, { at: 8 * fps, vTrack: 2, aTrack: null, dur: 5 * fps })[0];
  if (adjClip) {
    const fx = createEffect('lumetri', ctx);
    fx.params.look.v = 8;
    fx.params.intensity.v = 80;
    adjClip.effects.push(fx);
  }
  seq.markers.push({ id: 'mk1', frame: 3 * fps, duration: 0, name: 'Title', comment: 'Title starts', color: 'Green', type: 'Comment' });
  seq.captions.push({ id: 'cap1', start: 9 * fps, end: 12 * fps, text: 'Captions are supported too' });
  app.history.reset('Sample Project');
  app.bus.emit('project:changed', { loaded: true });
  app.bus.emit('sequence:activated', seq);
  app.setPlayhead(4 * fps, { force: true });
  setTimeout(() => timeline.zoomToFit(), 50);
  persist.saveNow(false);
}

// ---------------- Start screen ----------------
const start = {
  el: null,
  async show() {
    if (this.el) this.el.remove();
    const recent = await persist.listProjects();
    const list = h('div.recent-list');
    for (const r of recent.slice(0, 8)) {
      const rowEl = h('div.recent-row', h('span', '🎬'), h('span', r.name || 'Untitled'), h('span.meta', new Date(r.updated).toLocaleString()));
      rowEl.onclick = async () => {
        this.hide();
        if (r.id !== app.project.id) await persist.loadProjectById(r.id);
      };
      list.appendChild(rowEl);
    }
    if (!recent.length) list.appendChild(h('div', { style: { color: '#8a8ca4' } }, 'No recent projects. Create a new project or open the sample.'));
    const el = h('div.start-screen',
      h('div.start-card',
        h('div.start-brand', h('div.big-logo', 'Ve'), h('h1', 'Vid-Edi Pro'), h('p', 'Professional non-linear video editing in your browser.'),
          h('div.start-actions',
            h('button.btn.cta', { onclick: async () => { this.hide(); await persist.newProject(); } }, 'New Project…'),
            h('button.btn', { onclick: () => { this.hide(); persist.openDialog(); } }, 'Open Project…'),
            h('button.btn', { onclick: () => { this.hide(); makeSampleProject(); } }, 'Open Sample Project'),
            app.project.items.length ? h('button.btn', { onclick: () => this.hide() }, 'Continue: ' + (app.project.name || 'Untitled')) : null,
          ),
        ),
        h('div.start-recent', h('h3', 'Recent'), list, h('div.feature-grid', ...['Multi-track timeline', 'Ripple, roll, slip, slide, razor', '70+ GPU video effects', '50+ transitions', 'Lumetri Color + scopes', 'Keyframes & masks', 'Titles & captions', 'Audio mixer & effects', 'Nested sequences', 'MP4 / WebM export'].map((f) => h('div', f)))),
      ),
    );
    el.addEventListener('dragover', (e) => e.preventDefault());
    el.addEventListener('drop', async (e) => {
      e.preventDefault();
      this.hide();
      const items = await importFiles([...e.dataTransfer.files]);
      if (items.length && !app.seq) actions.newSequenceFromItems(items);
    });
    document.body.appendChild(el);
    this.el = el;
  },
  hide() {
    if (this.el) this.el.remove();
    this.el = null;
  },
};

async function boot() {
  let compositor;
  try {
    compositor = new Compositor();
  } catch (e) {
    console.error(e);
    return fatal('WebGL 2 is required for GPU rendering but is not available: ' + e.message);
  }
  Object.assign(app.services, {
    compositor, layout, timeline, timelineView: timeline, programMonitor, sourceMonitor, projectPanel, persist, exporter, captions, luts,
    prefs: prefsUI, presets, edit: E, labels: LABEL_COLORS, dialogs: { modal, row }, sources, start, playback, audio,
  });
  buildMenubar(document.getElementById('menubar'), menubarDef(), h('div.mb-right', h('span.tiny', 'Vid-Edi Pro')));
  buildHeader();
  layout.init(document.getElementById('workspace'));
  layout.load(localStorage.getItem('videdi.workspace') || 'Editing');
  buildStatusBar();
  initToasts();
  initKeyboard();
  persist.init();
  applyBrightness();
  onFontLoaded(() => {
    app.fontStamp = (app.fontStamp || 0) + 1;
    app.bus.emit('fonts:loaded');
    app.bus.emit('time:changed', { seq: app.seq });
  });
  app.bus.on('prefs:changed', applyBrightness);
  // global file drop
  window.addEventListener('dragover', (e) => {
    if ([...(e.dataTransfer?.types || [])].includes('Files')) e.preventDefault();
  });
  window.addEventListener('drop', async (e) => {
    if (e.defaultPrevented || !e.dataTransfer.files.length) return;
    e.preventDefault();
    await importFiles([...e.dataTransfer.files]);
  });
  // first user gesture resumes audio
  window.addEventListener('pointerdown', () => app.services.audio?.ensure?.(), { once: true });
  const restored = await persist.restoreLast();
  if (!restored) {
    app.setProject(createProject('Untitled'), 'New Project');
    start.show();
  } else if (!app.project.items.length) start.show();
  app.bus.emit('time:changed', { seq: app.seq });
  window.__ve = { app, actions, run, E, timeline, programMonitor, sourceMonitor, persist, exporter, makeSampleProject };
}

boot();
