// Global application state, event bus and undo history.

import { Emitter, clamp } from './util.js';
import { createProject, findItem, allClips, seqDuration, validateTransitions } from './model.js';

const DEFAULT_PREFS = {
  stillDuration: 5,
  videoTransitionDuration: 1,
  audioTransitionDuration: 1,
  defaultVideoTransition: 'crossDissolve',
  defaultAudioTransition: 'constantPower',
  mediaScaling: 'none', // none | set | scale
  autoScroll: 'page', // page | smooth | none
  playbackRes: 'full', // full | half | quarter
  sourceRes: 'full',
  preroll: 2,
  postroll: 2,
  audioScrubbing: true,
  showThumbnails: true,
  showWaveforms: true,
  showKeyframes: true,
  showFxBadges: true,
  showNames: true,
  showTransparencyGrid: false,
  safeMargins: false,
  loopPlayback: false,
  uiBrightness: 0,
  timelineHeaderWidth: 190,
  labelDefaults: null,
};

class History {
  constructor(app) {
    this.app = app;
    this.entries = [];
    this.index = -1;
    this.pending = null;
    this.limit = 120;
  }
  snapshot() {
    return JSON.stringify(this.app.project);
  }
  reset(label = 'New/Open') {
    this.entries = [{ label, json: this.snapshot(), time: Date.now() }];
    this.index = 0;
    this.pending = null;
    this.app.bus.emit('history:changed');
  }
  get busy() {
    return !!this.pending;
  }
  begin(label) {
    if (this.pending) {
      this.pending.depth++;
      return false;
    }
    this.pending = { label, depth: 0 };
    return true;
  }
  commit(label) {
    if (!this.pending) return;
    if (this.pending.depth > 0) {
      this.pending.depth--;
      return;
    }
    const lbl = label || this.pending.label;
    this.pending = null;
    const json = this.snapshot();
    const cur = this.entries[this.index];
    if (cur && cur.json === json) return;
    this.entries.splice(this.index + 1);
    this.entries.push({ label: lbl, json, time: Date.now() });
    if (this.entries.length > this.limit) this.entries.splice(1, this.entries.length - this.limit);
    this.index = this.entries.length - 1;
    this.app.bus.emit('history:changed');
    this.app.markDirty();
  }
  cancel() {
    if (!this.pending) return;
    this.pending = null;
    this.restore(this.entries[this.index].json);
  }
  canUndo() {
    return this.index > 0;
  }
  canRedo() {
    return this.index < this.entries.length - 1;
  }
  undo() {
    if (this.pending || !this.canUndo()) return null;
    const label = this.entries[this.index].label;
    this.index--;
    this.restore(this.entries[this.index].json);
    return label;
  }
  redo() {
    if (this.pending || !this.canRedo()) return null;
    this.index++;
    this.restore(this.entries[this.index].json);
    return this.entries[this.index].label;
  }
  goto(i) {
    if (this.pending || i < 0 || i >= this.entries.length) return;
    this.index = i;
    this.restore(this.entries[i].json);
  }
  restore(json) {
    const app = this.app;
    const old = app.project;
    const next = JSON.parse(json);
    // Preserve view-only state (playheads, zoom) across undo.
    for (const it of next.items) {
      if (it.type !== 'sequence') continue;
      const prev = findItem(old, it.id);
      if (prev) {
        it.playhead = prev.playhead;
        it.view = prev.view;
      }
    }
    next.activeSequenceId = findItem(next, old.activeSequenceId) ? old.activeSequenceId : next.activeSequenceId;
    next.openSequenceIds = (old.openSequenceIds || []).filter((id) => findItem(next, id));
    app.project = next;
    app.pruneSelection();
    app.bus.emit('history:changed');
    app.bus.emit('project:changed', { restore: true });
    app.bus.emit('selection:changed');
    app.bus.emit('time:changed');
    app.markDirty();
  }
}

export const app = {
  project: createProject(),
  bus: new Emitter(),
  runtime: new Map(),
  sel: {
    clips: new Set(),
    transition: null,
    gap: null,
    items: new Set(),
    keyframes: new Set(),
    effectId: null,
    maskId: null,
    layerId: null,
    caption: null,
  },
  tool: 'select',
  snapping: true,
  linkedSelection: true,
  focusedPanel: 'timeline',
  sourceItemId: null,
  clipboard: null,
  dirty: false,
  prefs: { ...DEFAULT_PREFS },
  history: null,
  panels: {},
  services: {},

  get seq() {
    return findItem(this.project, this.project.activeSequenceId);
  },
  get fps() {
    return this.seq?.settings.fps || 30;
  },

  rt(itemId) {
    if (!this.runtime.has(itemId)) this.runtime.set(itemId, {});
    return this.runtime.get(itemId);
  },

  markDirty() {
    this.dirty = true;
    this.bus.emit('dirty');
  },

  // Run a mutation as one undoable step.
  edit(label, fn) {
    const top = this.history.begin(label);
    let res;
    try {
      res = fn();
    } catch (err) {
      console.error(err);
      if (top) this.history.cancel();
      else this.history.commit();
      this.toast('Error: ' + err.message, 'error');
      return undefined;
    }
    for (const s of this.project.items) if (s.type === 'sequence') validateTransitions(s);
    this.history.commit();
    if (top) this.bus.emit('project:changed', { label });
    return res;
  },

  changed(info = {}) {
    this.bus.emit('project:changed', info);
    this.markDirty();
  },

  setPlayhead(frame, opts = {}) {
    const seq = opts.seq || this.seq;
    if (!seq) return;
    const max = Math.max(seqDuration(seq) + seq.settings.fps * 600, 1);
    frame = clamp(Math.round(frame), 0, max);
    if (frame === seq.playhead && !opts.force) return;
    seq.playhead = frame;
    this.bus.emit('time:changed', { seq, frame, source: opts.source });
  },

  openSequence(id) {
    const seq = findItem(this.project, id);
    if (!seq || seq.type !== 'sequence') return;
    this.project.activeSequenceId = id;
    if (!this.project.openSequenceIds.includes(id)) this.project.openSequenceIds.push(id);
    this.clearSelection();
    this.bus.emit('sequence:activated', seq);
    this.bus.emit('time:changed', { seq, frame: seq.playhead });
    this.markDirty();
  },

  closeSequence(id) {
    const p = this.project;
    p.openSequenceIds = p.openSequenceIds.filter((x) => x !== id);
    if (p.activeSequenceId === id) {
      p.activeSequenceId = p.openSequenceIds[p.openSequenceIds.length - 1] || null;
      this.clearSelection();
      this.bus.emit('sequence:activated', this.seq);
    } else this.bus.emit('sequence:activated', this.seq);
  },

  clearSelection(silent) {
    this.sel.clips.clear();
    this.sel.transition = null;
    this.sel.gap = null;
    this.sel.keyframes.clear();
    this.sel.maskId = null;
    this.sel.effectId = null;
    this.sel.layerId = null;
    this.sel.caption = null;
    if (!silent) this.bus.emit('selection:changed');
  },

  selectClips(ids, { add = false, toggle = false } = {}) {
    if (!add && !toggle) {
      this.sel.clips.clear();
      this.sel.transition = null;
      this.sel.gap = null;
      this.sel.caption = null;
    }
    for (const id of ids) {
      if (toggle && this.sel.clips.has(id)) this.sel.clips.delete(id);
      else this.sel.clips.add(id);
    }
    this.sel.keyframes.clear();
    this.sel.maskId = null;
    this.sel.layerId = null;
    this.bus.emit('selection:changed');
  },

  pruneSelection() {
    const seq = this.seq;
    if (!seq) {
      this.sel.clips.clear();
      return;
    }
    const ids = new Set(allClips(seq).map((c) => c.id));
    for (const id of [...this.sel.clips]) if (!ids.has(id)) this.sel.clips.delete(id);
    if (this.sel.transition) {
      const exists = [...seq.videoTracks, ...seq.audioTracks].some((t) => t.transitions.some((tr) => tr.id === this.sel.transition));
      if (!exists) this.sel.transition = null;
    }
    for (const id of [...this.sel.items]) if (!findItem(this.project, id)) this.sel.items.delete(id);
  },

  setTool(tool) {
    this.tool = tool;
    this.bus.emit('tool:changed', tool);
  },

  focusPanel(id) {
    if (this.focusedPanel === id) return;
    this.focusedPanel = id;
    this.bus.emit('panel:focus', id);
  },

  toast(msg, kind = 'info', ms = 2600) {
    this.bus.emit('toast', { msg, kind, ms });
  },

  status(msg) {
    this.bus.emit('status', msg);
  },

  loadPrefs() {
    try {
      const p = JSON.parse(localStorage.getItem('videdi.prefs') || '{}');
      Object.assign(this.prefs, p);
    } catch (e) {
      /* ignore */
    }
  },
  savePrefs() {
    try {
      localStorage.setItem('videdi.prefs', JSON.stringify(this.prefs));
    } catch (e) {
      /* ignore */
    }
    this.bus.emit('prefs:changed');
  },

  setProject(project, label = 'Open Project') {
    this.project = project;
    this.clearSelection(true);
    this.sel.items.clear();
    this.sourceItemId = null;
    this.history.reset(label);
    this.bus.emit('project:loaded');
    this.bus.emit('project:changed', { loaded: true });
    this.bus.emit('sequence:activated', this.seq);
    this.bus.emit('selection:changed');
    this.bus.emit('source:changed');
    this.bus.emit('time:changed', { seq: this.seq });
  },
};

app.history = new History(app);
app.loadPrefs();
app.history.reset();

// Expose for debugging/tests
window.__app = app;
