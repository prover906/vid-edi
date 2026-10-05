// High-level editor actions shared by menus, keyboard shortcuts and panels.

import { app } from './app.js';
import { h, uid, clamp, deepClone, MOD, dbToGain, gainToDb, pickFiles } from './util.js';
import { framesToTC, tcToFrames, FRAME_RATES, fpsLabel } from './timecode.js';
import {
  findItem, findClip, allTracks, clipEnd, seqDuration, createSequence, createSyntheticItem, createEffect, createMask,
  linkedClips, getClipEffect, clipSourceTime, clipKfTime, SEQUENCE_PRESETS, LABEL_COLORS, createBin, DEFAULT_LABEL, itemSourceDuration,
  createClip, intrinsicEffectsFor,
} from './model.js';
import { getEffectDef, getTransitionDef, registry } from './registry.js';
import * as E from './edit.js';
import { modal, confirmDialog, promptDialog, row } from '../ui/dialogs.js';
import { labelMenu } from '../ui/menus.js';
import { dropdown, checkbox } from '../ui/widgets.js';
import { playback } from '../engine/playback.js';
import { createTextLayer, createShapeLayer } from '../engine/graphics.js';
import { evalParam, addKeyframe } from './keyframes.js';

const seq = () => app.seq;
const selIds = () => [...app.sel.clips];

function needSeq() {
  const s = app.seq;
  if (!s) app.toast('No active sequence. Create one with File › New › Sequence.', 'warn');
  return s;
}

export const actions = {
  // ---------- toggles ----------
  toggleSnap() {
    app.snapping = !app.snapping;
    app.bus.emit('snap:changed');
    app.status('Snap ' + (app.snapping ? 'on' : 'off'));
  },
  toggleLinked() {
    app.linkedSelection = !app.linkedSelection;
    app.bus.emit('snap:changed');
  },

  // ---------- playhead / navigation ----------
  step(n) {
    const s = needSeq();
    if (!s) return;
    playback.stop();
    app.setPlayhead(s.playhead + n);
  },
  gotoStart() {
    const s = needSeq();
    if (s) app.setPlayhead(0);
  },
  gotoEnd() {
    const s = needSeq();
    if (s) app.setPlayhead(seqDuration(s));
  },
  gotoEdit(dir, all = false) {
    const s = needSeq();
    if (!s) return;
    const pts = E.editPoints(s, { targetedOnly: !all });
    const ph = s.playhead;
    const next = dir > 0 ? pts.find((p) => p > ph) : [...pts].reverse().find((p) => p < ph);
    if (next != null) app.setPlayhead(next);
  },
  gotoIn() {
    const s = needSeq();
    if (s && s.inPoint != null) app.setPlayhead(s.inPoint);
  },
  gotoOut() {
    const s = needSeq();
    if (s && s.outPoint != null) app.setPlayhead(s.outPoint);
  },
  gotoMarker(dir) {
    const s = needSeq();
    if (!s) return;
    const ms = s.markers.map((m) => m.frame).sort((a, b) => a - b);
    const t = dir > 0 ? ms.find((f) => f > s.playhead) : ms.reverse().find((f) => f < s.playhead);
    if (t != null) app.setPlayhead(t);
  },

  // ---------- in / out ----------
  markIn() {
    const s = needSeq();
    if (!s) return;
    app.edit('Mark In', () => {
      s.inPoint = s.playhead;
      if (s.outPoint != null && s.outPoint < s.inPoint) s.outPoint = null;
    });
  },
  markOut() {
    const s = needSeq();
    if (!s) return;
    app.edit('Mark Out', () => {
      s.outPoint = Math.max(0, s.playhead - (s.playhead > 0 && s.playhead >= seqDuration(s) ? 1 : 0));
      if (s.inPoint != null && s.inPoint > s.outPoint) s.inPoint = null;
    });
  },
  markClip() {
    const s = needSeq();
    if (!s) return;
    const ph = s.playhead;
    let c = null;
    for (const t of E.targetedTracks(s)) {
      c = t.clips.find((x) => x.start <= ph && clipEnd(x) > ph);
      if (c) break;
    }
    if (!c) return;
    app.edit('Mark Clip', () => {
      s.inPoint = c.start;
      s.outPoint = clipEnd(c) - 1;
    });
  },
  markSelection() {
    const s = needSeq();
    const ids = selIds();
    if (!s || !ids.length) return;
    const cs = ids.map((id) => findClip(s, id)?.clip).filter(Boolean);
    app.edit('Mark Selection', () => {
      s.inPoint = Math.min(...cs.map((c) => c.start));
      s.outPoint = Math.max(...cs.map((c) => clipEnd(c))) - 1;
    });
  },
  clearIn() {
    const s = needSeq();
    if (s) app.edit('Clear In', () => (s.inPoint = null));
  },
  clearOut() {
    const s = needSeq();
    if (s) app.edit('Clear Out', () => (s.outPoint = null));
  },
  clearInOut() {
    const s = needSeq();
    if (s) app.edit('Clear In and Out', () => {
      s.inPoint = null;
      s.outPoint = null;
    });
  },

  // ---------- markers ----------
  addMarker(frame) {
    const s = needSeq();
    if (!s) return;
    const f = frame ?? s.playhead;
    if (s.markers.some((m) => m.frame === f)) return;
    app.edit('Add Marker', () => s.markers.push({ id: uid('mk_'), frame: f, duration: 0, name: '', comment: '', color: 'Green', type: 'Comment' }));
  },
  editMarker(mk) {
    const s = needSeq();
    if (!s || !mk) return;
    const fps = s.settings.fps;
    const name = h('input', { type: 'text', value: mk.name || '', style: { width: '260px' } });
    const comment = h('textarea', { rows: 4, style: { width: '260px' } }, mk.comment || '');
    const durIn = h('input', { type: 'text', value: framesToTC(mk.duration || 0, fps), style: { width: '120px' } });
    const inIn = h('input', { type: 'text', value: framesToTC(mk.frame, fps), style: { width: '120px' } });
    let color = mk.color || 'Green';
    const colors = h('div', { style: { display: 'flex', gap: '4px', flexWrap: 'wrap', maxWidth: '260px' } });
    const MC = { Green: '#5bbf5b', Red: '#e04848', Rose: '#e6739f', Orange: '#f0882c', Yellow: '#e4d23e', White: '#e8e8e8', Blue: '#3b8ee6', Cyan: '#38c8d8' };
    const drawColors = () => {
      colors.innerHTML = '';
      for (const [n, c] of Object.entries(MC)) {
        const sw = h('span', { title: n, style: { width: '18px', height: '18px', borderRadius: '3px', background: c, cursor: 'pointer', outline: n === color ? '2px solid #fff' : 'none' } });
        sw.onclick = () => {
          color = n;
          drawColors();
        };
        colors.appendChild(sw);
      }
    };
    drawColors();
    let type = mk.type || 'Comment';
    const typeDd = dropdown({ options: ['Comment', 'Chapter', 'Segmentation', 'Web Link'].map((x) => ({ label: x, value: x })), value: type, onChange: (v) => (type = v) });
    modal({
      title: 'Marker',
      body: h('div', row('Name', name), row('In', inIn), row('Duration', durIn), row('Comments', comment), row('Marker Color', colors), row('Type', typeDd.el)),
      buttons: [
        { label: 'Delete', warn: true, action: () => app.edit('Delete Marker', () => (s.markers = s.markers.filter((m) => m.id !== mk.id))) },
        { label: 'Cancel' },
        {
          label: 'OK',
          cta: true,
          action: () =>
            app.edit('Edit Marker', () => {
              const m = s.markers.find((x) => x.id === mk.id);
              if (!m) return;
              m.name = name.value;
              m.comment = comment.value;
              m.color = color;
              m.type = type;
              m.duration = Math.max(0, tcToFrames(durIn.value, fps) ?? 0);
              const f = tcToFrames(inIn.value, fps);
              if (f != null) m.frame = Math.max(0, f);
            }),
        },
      ],
    });
  },
  clearCurrentMarker() {
    const s = needSeq();
    if (!s) return;
    app.edit('Clear Marker', () => (s.markers = s.markers.filter((m) => m.frame !== s.playhead)));
  },
  clearAllMarkers() {
    const s = needSeq();
    if (s) app.edit('Clear All Markers', () => (s.markers = []));
  },

  // ---------- selection ----------
  selectAll() {
    const s = needSeq();
    if (!s) return;
    app.selectClips(allTracks(s).flatMap((t) => t.clips.map((c) => c.id)));
  },
  deselectAll() {
    app.clearSelection();
  },
  selectClipAtPlayhead() {
    const s = needSeq();
    if (!s) return;
    const ids = [];
    for (const t of E.targetedTracks(s)) {
      const c = t.clips.find((x) => x.start <= s.playhead && clipEnd(x) > s.playhead);
      if (c) ids.push(...(app.linkedSelection ? linkedClips(s, c) : [c]).map((x) => x.id));
    }
    app.selectClips([...new Set(ids)]);
  },

  // ---------- clipboard ----------
  copy() {
    const s = seq();
    if (app.focusedPanel === 'project') return app.panels.project?.copy?.();
    if (!s || !app.sel.clips.size) return;
    app.clipboard = E.copyClips(s, selIds());
    app.status('Copied ' + app.sel.clips.size + ' clip(s)');
  },
  cut() {
    const s = seq();
    if (!s || !app.sel.clips.size) return;
    app.clipboard = E.copyClips(s, selIds());
    app.edit('Cut', () => E.deleteClips(s, selIds(), false));
    app.clearSelection();
  },
  paste(insert = false) {
    const s = needSeq();
    if (!s || !app.clipboard) return;
    const pasted = app.edit(insert ? 'Paste Insert' : 'Paste', () => E.pasteClips(s, app.clipboard, s.playhead, { insert }));
    if (pasted && pasted.length) {
      app.selectClips(pasted.map((c) => c.id));
      app.setPlayhead(Math.max(...pasted.map((c) => clipEnd(c))));
    }
  },
  pasteAttributesDialog() {
    const s = needSeq();
    if (!s || !app.clipboard || app.clipboard.type !== 'clips') return;
    const src = app.clipboard.clips[0]?.clip;
    if (!src) return;
    const opts = { motion: true, opacity: true, timeRemap: false, volume: true, channelVolume: true, panner: true, effects: true };
    const box = h('div');
    const add = (k, label) => box.appendChild(h('div', { style: { margin: '6px 0' } }, checkbox({ checked: opts[k], label, onChange: (v) => (opts[k] = v) }).el));
    box.appendChild(h('div.muted', { style: { marginBottom: '8px' } }, 'Paste attributes from: ' + src.name));
    add('motion', 'Motion');
    add('opacity', 'Opacity');
    add('effects', 'Effects');
    add('volume', 'Volume');
    add('channelVolume', 'Channel Volume');
    add('panner', 'Panner');
    modal({ title: 'Paste Attributes', body: box, buttons: [{ label: 'Cancel' }, { label: 'OK', cta: true, action: () => app.edit('Paste Attributes', () => E.pasteAttributes(s, src, selIds(), opts)) }] });
  },
  removeAttributesDialog() {
    const s = needSeq();
    if (!s || !app.sel.clips.size) return;
    const opts = { motion: true, opacity: true, effects: true, volume: true };
    const box = h('div');
    for (const [k, l] of [['motion', 'Motion'], ['opacity', 'Opacity'], ['effects', 'Effects'], ['volume', 'Volume']]) box.appendChild(h('div', { style: { margin: '6px 0' } }, checkbox({ checked: true, label: l, onChange: (v) => (opts[k] = v) }).el));
    modal({ title: 'Remove Attributes', body: box, buttons: [{ label: 'Cancel' }, { label: 'OK', cta: true, action: () => app.edit('Remove Attributes', () => E.removeAttributes(s, selIds(), opts)) }] });
  },

  // ---------- deletion ----------
  clear() {
    const s = seq();
    if (app.focusedPanel === 'project') return app.panels.project?.deleteSelected?.();
    if (app.focusedPanel === 'effectControls' && app.panels.effectControls?.deleteSelected?.()) return;
    if (!s) return;
    if (app.sel.transition) return app.edit('Clear Transition', () => E.removeTransition(s, app.sel.transition));
    if (app.sel.gap) return this.rippleDeleteGap();
    if (app.sel.caption) return app.edit('Delete Caption', () => (s.captions = s.captions.filter((c) => c.id !== app.sel.caption)));
    if (app.sel.marker) {
      const id = app.sel.marker;
      app.sel.marker = null;
      return app.edit('Clear Marker', () => (s.markers = s.markers.filter((m) => m.id !== id)));
    }
    if (!app.sel.clips.size) return;
    app.edit('Clear', () => E.deleteClips(s, selIds(), false));
    app.clearSelection();
  },
  rippleDelete() {
    const s = needSeq();
    if (!s) return;
    if (app.sel.gap) return this.rippleDeleteGap();
    if (!app.sel.clips.size) return;
    app.edit('Ripple Delete', () => E.deleteClips(s, selIds(), true));
    app.clearSelection();
  },
  rippleDeleteGap() {
    const s = needSeq();
    const g = app.sel.gap;
    if (!s || !g) return;
    const t = allTracks(s).find((x) => x.id === g.trackId);
    if (!t) return;
    app.edit('Ripple Delete', () => E.closeGapAt(s, t, g.start, g.end));
    app.sel.gap = null;
  },
  lift() {
    const s = needSeq();
    if (!s) return;
    if (s.inPoint == null && s.outPoint == null) return app.toast('Set In and Out points to lift', 'warn');
    const a = s.inPoint ?? 0, b = (s.outPoint ?? seqDuration(s) - 1) + 1;
    app.edit('Lift', () => E.lift(s, a, b));
  },
  extract() {
    const s = needSeq();
    if (!s) return;
    if (s.inPoint == null && s.outPoint == null) return app.toast('Set In and Out points to extract', 'warn');
    const a = s.inPoint ?? 0, b = (s.outPoint ?? seqDuration(s) - 1) + 1;
    app.edit('Extract', () => {
      E.extract(s, a, b);
      s.inPoint = null;
      s.outPoint = null;
    });
    app.setPlayhead(a);
  },

  // ---------- edits ----------
  addEdit(all = false) {
    const s = needSeq();
    if (!s) return;
    const ids = selIds();
    app.edit('Add Edit', () => E.addEdit(s, s.playhead, { allTracks: all, ids: !all && ids.length ? ids : null }));
  },
  rippleTrim(which) {
    const s = needSeq();
    if (!s) return;
    const r = app.edit(which === 'prev' ? 'Ripple Trim Previous Edit to Playhead' : 'Ripple Trim Next Edit to Playhead', () => E.rippleTrimToPlayhead(s, s.playhead, which));
    if (r != null) app.setPlayhead(r);
  },
  extendEdit() {
    const s = needSeq();
    if (!s) return;
    const ph = s.playhead;
    app.edit('Extend Edit', () => {
      for (const t of E.targetedTracks(s)) {
        const ep = E.editPointNear(t, ph);
        if (!ep) continue;
        const ids = app.linkedSelection ? linkedClips(s, ep.clip).map((c) => c.id) : [ep.clip.id];
        E.trimEdge(s, ids, ep.edge, ph - ep.frame, {});
      }
    });
  },
  nudge(frames) {
    const s = needSeq();
    if (!s || !app.sel.clips.size) return;
    app.edit('Nudge', () => E.moveClips(s, selIds(), frames, 0, 0, {}));
  },
  toggleEnable() {
    const s = needSeq();
    if (!s || !app.sel.clips.size) return;
    app.edit('Enable', () => {
      const cs = selIds().map((id) => findClip(s, id)?.clip).filter(Boolean);
      const v = !cs.every((c) => c.enabled);
      cs.forEach((c) => (c.enabled = v));
    });
  },
  linkUnlink() {
    const s = needSeq();
    if (!s || !app.sel.clips.size) return;
    const cs = selIds().map((id) => findClip(s, id)?.clip).filter(Boolean);
    const linked = cs.some((c) => c.linkId);
    if (linked) app.edit('Unlink', () => E.unlink(s, selIds()));
    else app.edit('Link', () => E.link(s, selIds()));
  },
  group() {
    const s = needSeq();
    if (s && app.sel.clips.size > 1) app.edit('Group', () => E.group(s, selIds()));
  },
  ungroup() {
    const s = needSeq();
    if (s && app.sel.clips.size) app.edit('Ungroup', () => E.ungroup(s, selIds()));
  },
  async nestDialog() {
    const s = needSeq();
    if (!s || !app.sel.clips.size) return;
    const name = await promptDialog('Nested Sequence Name', 'Name:', 'Nested Sequence ' + ((app.project.counters.nest || 0) + 1));
    if (name == null) return;
    const r = app.edit('Nest', () => E.nestClips(s, selIds(), name));
    if (r) app.selectClips(r.clips.map((c) => c.id));
  },
  speedDuration() {
    const s = needSeq();
    if (!s) return;
    const ids = selIds();
    const c0 = ids.map((id) => findClip(s, id)?.clip).find(Boolean);
    if (!c0) return;
    const fps = s.settings.fps;
    let speed = c0.speed * 100, dur = c0.dur, reverse = c0.reverse, ripple = false, linkSD = true;
    const speedIn = h('input', { type: 'text', value: speed.toFixed(2), style: { width: '80px' } });
    const durIn = h('input', { type: 'text', value: framesToTC(dur, fps), style: { width: '110px' } });
    const srcLen = (c0.dur / fps) * c0.speed;
    speedIn.addEventListener('input', () => {
      const v = parseFloat(speedIn.value);
      if (v > 0 && linkSD) durIn.value = framesToTC(Math.round((srcLen / (v / 100)) * fps), fps);
    });
    durIn.addEventListener('change', () => {
      const f = tcToFrames(durIn.value, fps);
      if (f > 0 && linkSD) speedIn.value = (((srcLen / (f / fps)) * 100) || 100).toFixed(2);
    });
    const interp = dropdown({ options: ['Frame Sampling', 'Frame Blending', 'Optical Flow'], value: c0.timeInterp || 0, onChange: (v) => (c0._interp = v) });
    const body = h(
      'div',
      row('Speed (%)', speedIn),
      row('Duration', durIn),
      h('div', { style: { margin: '8px 0' } }, checkbox({ checked: linkSD, label: 'Link speed and duration', onChange: (v) => (linkSD = v) }).el),
      h('div', { style: { margin: '6px 0' } }, checkbox({ checked: reverse, label: 'Reverse Speed', onChange: (v) => (reverse = v) }).el),
      h('div', { style: { margin: '6px 0' } }, checkbox({ checked: false, label: 'Maintain Audio Pitch', onChange: () => {} }).el),
      h('div', { style: { margin: '6px 0' } }, checkbox({ checked: ripple, label: 'Ripple Edit, Shifting Trailing Clips', onChange: (v) => (ripple = v) }).el),
      row('Time Interpolation', interp.el),
    );
    modal({
      title: 'Clip Speed / Duration',
      body,
      buttons: [
        { label: 'Cancel' },
        {
          label: 'OK',
          cta: true,
          action: () => {
            const sp = parseFloat(speedIn.value);
            const df = tcToFrames(durIn.value, fps);
            app.edit('Speed/Duration', () => {
              for (const id of ids) {
                const e = findClip(s, id);
                if (!e) continue;
                if (linkSD && sp > 0) E.setSpeed(s, id, sp, { reverse, ripple });
                else if (df > 0) E.setDuration(s, id, df, { ripple });
                e.clip.reverse = reverse;
                e.clip.timeInterp = c0._interp ?? e.clip.timeInterp ?? 0;
              }
            });
          },
        },
      ],
    });
  },
  audioGainDialog() {
    const s = needSeq();
    const ids = selIds().filter((id) => findClip(s, id)?.kind === 'audio');
    if (!s || !ids.length) return app.toast('Select audio clips to adjust gain', 'warn');
    const c0 = findClip(s, ids[0]).clip;
    let mode = 'adjust';
    const setIn = h('input', { type: 'number', value: (c0.gain || 0).toFixed(1), step: 0.5, style: { width: '80px' } });
    const adjIn = h('input', { type: 'number', value: 0, step: 0.5, style: { width: '80px' } });
    const normIn = h('input', { type: 'number', value: 0, step: 0.5, style: { width: '80px' } });
    const peak = (() => {
      const item = findItem(app.project, c0.itemId);
      const pk = item && app.rt(item.id).peaks;
      return pk ? gainToDb(pk.max) : null;
    })();
    const radio = (v, label, inp) => {
      const r = h('input', { type: 'radio', name: 'gainmode', checked: v === mode });
      r.onchange = () => (mode = v);
      return h('div.form-row', h('label', { style: { width: '200px', display: 'flex', gap: '6px', alignItems: 'center' } }, r, label), inp, h('span.muted', 'dB'));
    };
    modal({
      title: 'Audio Gain',
      body: h('div', radio('set', 'Set Gain to:', setIn), radio('adjust', 'Adjust Gain by:', adjIn), radio('norm', 'Normalize Max Peak to:', normIn), h('div.muted', { style: { marginTop: '10px' } }, 'Peak Amplitude: ' + (peak != null ? peak.toFixed(1) + ' dB' : 'n/a'))),
      buttons: [
        { label: 'Cancel' },
        {
          label: 'OK',
          cta: true,
          action: () =>
            app.edit('Audio Gain', () => {
              for (const id of ids) {
                const c = findClip(s, id).clip;
                if (mode === 'set') c.gain = parseFloat(setIn.value) || 0;
                else if (mode === 'adjust') c.gain = (c.gain || 0) + (parseFloat(adjIn.value) || 0);
                else {
                  const it = findItem(app.project, c.itemId);
                  const pk = it && app.rt(it.id).peaks;
                  if (pk && pk.max > 0) c.gain = (parseFloat(normIn.value) || 0) - gainToDb(pk.max);
                }
                c.gain = clamp(c.gain, -96, 96);
              }
            }),
        },
      ],
    });
  },
  addFrameHold(insert = false) {
    const s = needSeq();
    if (!s) return;
    let id = selIds().find((x) => {
      const f = findClip(s, x);
      return f && f.kind === 'video' && f.clip.start <= s.playhead && clipEnd(f.clip) > s.playhead;
    });
    if (!id) {
      for (const t of [...s.videoTracks].reverse()) {
        const c = t.clips.find((x) => x.start <= s.playhead && clipEnd(x) > s.playhead);
        if (c && t.target) {
          id = c.id;
          break;
        }
      }
    }
    if (!id) return app.toast('Place the playhead over a video clip', 'warn');
    app.edit(insert ? 'Insert Frame Hold Segment' : 'Add Frame Hold', () => E.addFrameHold(s, id, s.playhead, { insert }));
  },
  scaleToFrame() {
    const s = needSeq();
    if (s && app.sel.clips.size)
      app.edit('Scale to Frame Size', () => selIds().forEach((id) => {
        const f = findClip(s, id);
        if (f && f.kind === 'video') f.clip.scaleToFrame = !f.clip.scaleToFrame;
      }));
  },
  setToFrameSize() {
    const s = needSeq();
    if (s && app.sel.clips.size) app.edit('Set to Frame Size', () => E.setToFrameSize(s, selIds()));
  },
  async renameClip() {
    const s = needSeq();
    const id = selIds()[0];
    if (!s || !id) return;
    const c = findClip(s, id).clip;
    const name = await promptDialog('Rename Clip', 'Clip Name:', c.name);
    if (name) app.edit('Rename', () => (findClip(s, id).clip.name = name));
  },
  setLabel(name) {
    const s = seq();
    if (app.focusedPanel === 'project' && app.sel.items.size) {
      app.edit('Label', () => [...app.sel.items].forEach((id) => {
        const it = findItem(app.project, id);
        if (it) it.label = name;
      }));
      return;
    }
    if (s && app.sel.clips.size) app.edit('Label', () => selIds().forEach((id) => (findClip(s, id).clip.label = name)));
  },
  revealInProject(clip) {
    if (!clip.itemId) return;
    app.sel.items = new Set([clip.itemId]);
    app.services.layout.activate('project');
    app.bus.emit('project:reveal', clip.itemId);
  },
  matchFrame() {
    const s = needSeq();
    if (!s) return;
    const ph = s.playhead;
    const tracks = [...s.videoTracks].reverse().filter((t) => t.target || true);
    for (const t of tracks) {
      if (t.hidden) continue;
      const c = t.clips.find((x) => x.start <= ph && clipEnd(x) > ph && x.itemId);
      if (!c) continue;
      const item = findItem(app.project, c.itemId);
      if (!item || item.type === 'synthetic') continue;
      if (item.type === 'sequence') return app.openSequence(item.id);
      this.openInSource(item, clipSourceTime(c, ph, s.settings.fps, item.duration));
      return;
    }
  },

  // ---------- transitions / effects ----------
  setDefaultTransition(type) {
    const def = getTransitionDef(type);
    if (!def) return;
    if (def.kind === 'video') app.prefs.defaultVideoTransition = type;
    else app.prefs.defaultAudioTransition = type;
    app.savePrefs();
    app.toast('Default ' + def.kind + ' transition: ' + def.name, 'ok');
  },
  applyDefaultTransition(kind) {
    const s = needSeq();
    if (!s) return;
    const n = app.edit('Apply Default Transition', () => E.applyDefaultTransitions(s, s.playhead, kind));
    if (!n || !n.length) app.status('No edit point near the playhead on targeted tracks');
  },
  applyTransitionsToSelection() {
    const s = needSeq();
    if (!s || !app.sel.clips.size) return;
    app.edit('Apply Default Transitions to Selection', () => E.applyTransitionsToSelection(s, selIds()));
  },
  applyEffect(effectId, ids = selIds()) {
    const s = needSeq();
    const def = getEffectDef(effectId);
    if (!s || !def) return;
    let n = 0;
    app.edit('Add ' + def.name, () => {
      for (const id of ids) {
        const f = findClip(s, id);
        if (!f || f.kind !== def.kind) continue;
        const item = findItem(app.project, f.clip.itemId);
        const w = item?.type === 'sequence' ? item.settings.width : item?.width || s.settings.width;
        const hh = item?.type === 'sequence' ? item.settings.height : item?.height || s.settings.height;
        f.clip.effects.push(createEffect(effectId, { w, h: hh, seqW: s.settings.width, seqH: s.settings.height }));
        n++;
      }
    });
    if (!n) app.toast('Select ' + def.kind + ' clips to apply ' + def.name, 'warn');
    return n;
  },
  applyPreset(preset, ids = selIds()) {
    const s = needSeq();
    if (!s) return;
    app.edit('Apply Preset', () => {
      for (const id of ids) {
        const f = findClip(s, id);
        if (!f) continue;
        preset.apply(f.clip, s);
      }
    });
  },
  dropEffectOnTimeline(data, hit) {
    const s = needSeq();
    if (!s) return;
    if (data.transition) {
      if (hit.transition && hit.track && hit.track.kind === data.kind) {
        const def = getTransitionDef(data.id);
        app.edit('Replace Transition', () => {
          const f = E.findTransition(s, hit.transition.id);
          if (!f) return;
          f.tr.type = data.id;
          f.tr.params = {};
          for (const pd of def.params || []) f.tr.params[pd.id] = { v: typeof pd.default === 'function' ? pd.default({}) : deepClone(pd.default), kf: null };
        });
        app.clearSelection(true);
        app.sel.transition = hit.transition.id;
        app.bus.emit('selection:changed');
        return;
      }
      if (!hit.clip || !hit.track || hit.track.kind !== data.kind) return app.toast('Drop transitions onto an edit point of a ' + data.kind + ' clip', 'warn');
      const x = hit.x;
      const xa = app.services.timelineView?.f2x(hit.clip.start) ?? 0;
      const xb = app.services.timelineView?.f2x(clipEnd(hit.clip)) ?? 0;
      const edge = Math.abs(x - xa) < Math.abs(x - xb) ? 'in' : 'out';
      const dur = Math.round((data.kind === 'video' ? app.prefs.videoTransitionDuration : app.prefs.audioTransitionDuration) * s.settings.fps);
      const tr = app.edit('Apply ' + (getTransitionDef(data.id)?.name || 'Transition'), () => E.applyTransition(s, hit.track, hit.clip, edge, data.id, dur));
      if (tr) {
        app.clearSelection(true);
        app.sel.transition = tr.id;
        app.bus.emit('selection:changed');
      }
      return;
    }
    if (data.preset) {
      const preset = app.services.presets?.find(data.preset);
      if (!hit.clip || !preset) return;
      const ids = app.sel.clips.has(hit.clip.id) ? selIds() : [hit.clip.id];
      return this.applyPreset(preset, ids);
    }
    if (!hit.clip) return;
    const ids = app.sel.clips.has(hit.clip.id) ? selIds() : [hit.clip.id];
    this.applyEffect(data.id, ids);
    if (!app.sel.clips.has(hit.clip.id)) app.selectClips([hit.clip.id]);
  },

  // ---------- placing ----------
  placeItems(items, frame, { vTrack = 0, aTrack = 0, insert = false, video = true, audio = true, srcRange = null } = {}) {
    const s = needSeq();
    if (!s) return;
    let pos = frame;
    const placed = [];
    app.edit(insert ? 'Insert' : 'Overwrite', () => {
      for (const it of items) {
        if (it.id === s.id) {
          app.toast('A sequence cannot be nested inside itself', 'warn');
          continue;
        }
        const opts = { at: pos, mode: insert ? 'insert' : 'overwrite', vTrack: video !== false ? vTrack : null, aTrack: audio !== false ? aTrack : null };
        if (srcRange && items.length === 1) {
          opts.srcIn = srcRange.in;
          opts.dur = srcRange.dur;
        }
        const cs = E.placeItem(s, it, opts);
        placed.push(...cs);
        if (cs.length) pos = Math.max(...cs.map((c) => clipEnd(c)));
      }
    });
    if (placed.length) app.selectClips(placed.map((c) => c.id));
    return placed;
  },
  sourceEdit(mode) {
    const s = needSeq();
    const item = findItem(app.project, app.sourceItemId);
    if (!s || !item) return app.toast('Load a clip into the Source Monitor first', 'warn');
    if (item.id === s.id) return app.toast('A sequence cannot be nested inside itself', 'warn');
    const fps = s.settings.fps;
    const range = E.defaultItemRange(item, fps);
    const at = s.inPoint != null ? s.inPoint : s.playhead;
    let dur = range.dur;
    if (s.inPoint != null && s.outPoint != null && item.outPoint == null) dur = s.outPoint - s.inPoint + 1;
    const vT = s.patch.video, aT = s.patch.audio;
    const placed = app.edit(mode === 'insert' ? 'Insert' : 'Overwrite', () => E.placeItem(s, item, { at, mode, vTrack: vT, aTrack: aT, srcIn: range.in, dur }));
    if (placed && placed.length) {
      app.setPlayhead(at + dur);
      if (s.inPoint != null) app.edit('Clear In', () => {
        s.inPoint = null;
        s.outPoint = null;
      });
    } else app.toast('No source tracks are patched', 'warn');
  },
  openInSource(item, time = null) {
    app.sourceItemId = item.id;
    app.bus.emit('source:changed', { time });
    app.services.layout?.activate('source');
    app.focusPanel('source');
  },

  // ---------- sequences / items ----------
  newSequenceDialog(fromItems = null) {
    let preset = SEQUENCE_PRESETS[3];
    const p = app.project;
    const name = h('input', { type: 'text', value: 'Sequence ' + String((p.counters.sequence || 0) + 1).padStart(2, '0'), style: { width: '100%' } });
    const list = h('div.preset-list');
    const desc = h('div.preset-desc');
    let custom = { width: 1920, height: 1080, fps: 30 };
    const wIn = h('input', { type: 'number', value: custom.width, style: { width: '80px' } });
    const hIn = h('input', { type: 'number', value: custom.height, style: { width: '80px' } });
    const fpsDd = dropdown({ options: FRAME_RATES.map((f) => ({ label: f.label, value: f.fps })), value: 30, onChange: (v) => (custom.fps = v) });
    const vtIn = h('input', { type: 'number', value: 3, min: 1, max: 99, style: { width: '60px' } });
    const atIn = h('input', { type: 'number', value: 3, min: 1, max: 99, style: { width: '60px' } });
    const renderDesc = () => {
      desc.innerHTML = '';
      desc.append(h('b', preset.name), h('div', `Frame size: ${preset.width} × ${preset.height}`), h('div', `Frame rate: ${fpsLabel(preset.fps)}`), h('div', 'Audio: 48000 Hz stereo'));
      wIn.value = preset.width;
      hIn.value = preset.height;
      fpsDd.set(preset.fps);
      custom = { width: preset.width, height: preset.height, fps: preset.fps };
    };
    let lastGroup = null;
    for (const pr of SEQUENCE_PRESETS) {
      if (pr.group !== lastGroup) {
        list.appendChild(h('div.preset-group', pr.group));
        lastGroup = pr.group;
      }
      const r = h('div.preset-row' + (pr === preset ? '.sel' : ''), pr.name);
      r.onclick = () => {
        preset = pr;
        list.querySelectorAll('.preset-row').forEach((x) => x.classList.remove('sel'));
        r.classList.add('sel');
        renderDesc();
      };
      list.appendChild(r);
    }
    renderDesc();
    const body = h('div.newseq',
      h('div.newseq-cols', list, h('div', desc, h('div.fieldset', h('div.legend', 'Settings'), row('Frame Size', h('span', wIn, ' × ', hIn)), row('Timebase', fpsDd.el), row('Video Tracks', vtIn), row('Audio Tracks', atIn)))),
      row('Sequence Name', name),
    );
    modal({
      title: 'New Sequence',
      width: 720,
      body,
      buttons: [
        { label: 'Cancel' },
        {
          label: 'OK',
          cta: true,
          action: () => {
            const opts = { name: name.value || undefined, width: parseInt(wIn.value, 10) || 1920, height: parseInt(hIn.value, 10) || 1080, fps: custom.fps, videoTracks: clamp(parseInt(vtIn.value, 10) || 3, 1, 99), audioTracks: clamp(parseInt(atIn.value, 10) || 3, 1, 99) };
            this.createSequence(opts, fromItems);
          },
        },
      ],
    });
  },
  createSequence(opts, items = null) {
    let s;
    app.edit('New Sequence', () => {
      s = createSequence(app.project, opts);
      s.parent = app.panels.project?.currentBin?.() ?? null;
      app.project.items.push(s);
    });
    app.openSequence(s.id);
    if (items && items.length) this.placeItems(items, 0, { vTrack: 0, aTrack: 0 });
    return s;
  },
  newSequenceFromItems(items) {
    const first = items.find((i) => i.type === 'media' && i.kind === 'video') || items.find((i) => i.type === 'media' && i.kind === 'image') || items[0];
    if (!first) return;
    const opts = { name: first.name.replace(/\.[^.]+$/, '') };
    if (first.type === 'media' && first.kind !== 'audio') {
      opts.width = first.width % 2 ? first.width + 1 : first.width;
      opts.height = first.height % 2 ? first.height + 1 : first.height;
      opts.fps = first.kind === 'video' ? first.fps || 30 : 30;
    } else if (first.type === 'sequence') Object.assign(opts, first.settings);
    return this.createSequence(opts, items);
  },
  sequenceSettings() {
    const s = needSeq();
    if (!s) return;
    const name = h('input', { type: 'text', value: s.name, style: { width: '220px' } });
    const wIn = h('input', { type: 'number', value: s.settings.width, style: { width: '80px' } });
    const hIn = h('input', { type: 'number', value: s.settings.height, style: { width: '80px' } });
    let fps = s.settings.fps;
    const fpsDd = dropdown({ options: FRAME_RATES.map((f) => ({ label: f.label, value: f.fps })), value: FRAME_RATES.find((f) => Math.abs(f.fps - fps) < 0.01)?.fps ?? fps, onChange: (v) => (fps = v) });
    modal({
      title: 'Sequence Settings',
      body: h('div', row('Sequence Name', name), row('Frame Size', h('span', wIn, ' × ', hIn)), row('Timebase', fpsDd.el), h('div.muted.tiny', { style: { marginTop: '8px' } }, 'Changing the timebase re-times clips to keep their position in seconds.')),
      buttons: [
        { label: 'Cancel' },
        {
          label: 'OK',
          cta: true,
          action: () =>
            app.edit('Sequence Settings', () => {
              s.name = name.value || s.name;
              s.settings.width = Math.max(16, parseInt(wIn.value, 10) || s.settings.width);
              s.settings.height = Math.max(16, parseInt(hIn.value, 10) || s.settings.height);
              if (Math.abs(fps - s.settings.fps) > 1e-6) {
                const k = fps / s.settings.fps;
                for (const t of allTracks(s)) {
                  for (const c of t.clips) {
                    const st = Math.round(c.start * k), en = Math.round((c.start + c.dur) * k);
                    c.start = st;
                    c.dur = Math.max(1, en - st);
                  }
                  for (const tr of t.transitions) {
                    tr.dur = Math.max(1, Math.round(tr.dur * k));
                    tr.offset = Math.round(tr.offset * k);
                  }
                }
                for (const m of s.markers) m.frame = Math.round(m.frame * k);
                for (const c of s.captions || []) {
                  c.start = Math.round(c.start * k);
                  c.end = Math.round(c.end * k);
                }
                if (s.inPoint != null) s.inPoint = Math.round(s.inPoint * k);
                if (s.outPoint != null) s.outPoint = Math.round(s.outPoint * k);
                s.playhead = Math.round(s.playhead * k);
                s.view.zoom /= k;
                s.settings.fps = fps;
              }
            }),
        },
      ],
    });
  },
  newSynthetic(kind) {
    const s = app.seq;
    const settings = s ? s.settings : { width: 1920, height: 1080, fps: 30 };
    const add = (item) => {
      app.edit('New ' + item.name, () => {
        item.parent = app.panels.project?.currentBin?.() ?? null;
        app.project.items.push(item);
      });
      app.sel.items = new Set([item.id]);
      app.bus.emit('selection:changed');
      return item;
    };
    if (kind === 'colormatte') {
      const inp = h('input', { type: 'color', value: '#1f6feb' });
      const nm = h('input', { type: 'text', value: 'Color Matte', style: { width: '200px' } });
      modal({ title: 'New Color Matte', body: h('div', row('Color', inp), row('Name', nm)), buttons: [{ label: 'Cancel' }, { label: 'OK', cta: true, action: () => add(createSyntheticItem('colormatte', settings, { color: inp.value, name: nm.value || 'Color Matte' })) }] });
      return;
    }
    return add(createSyntheticItem(kind, settings));
  },
  newBin() {
    let b;
    app.edit('New Bin', () => {
      b = createBin(app.project, null, app.panels.project?.currentBin?.() ?? null);
      app.project.items.push(b);
    });
    app.bus.emit('project:rename', b.id);
  },

  // ---------- graphics ----------
  newTextLayer(at = null) {
    const s = needSeq();
    if (!s) return;
    const W = s.settings.width, H = s.settings.height;
    const layer = createTextLayer(W, H, { text: 'Your text here', position: at || [W / 2, H / 2] });
    return this.addGraphicLayers([layer]);
  },
  newShapeLayer(shape, rect = null) {
    const s = needSeq();
    if (!s) return;
    const W = s.settings.width, H = s.settings.height;
    const opts = rect ? { w: Math.max(4, Math.round(rect.w)), h: Math.max(4, Math.round(rect.h)), position: [rect.x + rect.w / 2, rect.y + rect.h / 2] } : {};
    return this.addGraphicLayers([createShapeLayer(W, H, shape, opts)]);
  },
  // Adds layers to the selected graphic clip under the playhead, or creates a new graphic clip.
  addGraphicLayers(layers, { forceNew = false, name = null, dur = null } = {}) {
    const s = needSeq();
    if (!s) return;
    const ph = s.playhead;
    let target = null;
    if (!forceNew) {
      for (const id of selIds()) {
        const f = findClip(s, id);
        if (f && f.clip.graphic && f.clip.start <= ph && clipEnd(f.clip) > ph) target = f.clip;
      }
    }
    let result;
    app.edit('New Graphic', () => {
      if (target) {
        target.graphic.layers.push(...layers);
        result = target;
        return;
      }
      // find the first video track above content at the playhead that is free for the duration
      const d = dur || Math.round(app.prefs.stillDuration * s.settings.fps);
      let ti = s.videoTracks.findIndex((t, i) => i > 0 && !t.locked && !t.clips.some((c) => c.start < ph + d && clipEnd(c) > ph));
      if (ti < 0) {
        E.addTracks(s, 'video', 1);
        ti = s.videoTracks.length - 1;
      }
      const t = s.videoTracks[ti];
      app.project.counters.graphic = (app.project.counters.graphic || 0) + 1;
      const ctx = { w: s.settings.width, h: s.settings.height, seqW: s.settings.width, seqH: s.settings.height };
      const c = createClip({ kind: 'video', name: name || (layers[0]?.type === 'text' ? layers[0].text.split('\n')[0].slice(0, 30) : 'Graphic'), start: ph, dur: d, label: 'Rose', graphic: { layers }, effects: intrinsicEffectsFor('video', ctx) });
      E.clearRange(s, t, ph, ph + d);
      t.clips.push(c);
      t.clips.sort((a, b) => a.start - b.start);
      result = c;
    });
    if (result) {
      app.selectClips([result.id]);
      app.sel.layerId = layers[layers.length - 1]?.id || null;
      app.bus.emit('selection:changed');
    }
    return result;
  },

  // ---------- tracks ----------
  async renameTrack(t) {
    const n = await promptDialog('Rename Track', 'Track name:', t.customName || (t.kind === 'video' ? 'Video ' : 'Audio ') + t.name.slice(1));
    if (n != null) app.edit('Rename Track', () => (t.customName = n));
  },
  addTracksDialog() {
    const s = needSeq();
    if (!s) return;
    const v = h('input', { type: 'number', value: 1, min: 0, max: 99, style: { width: '60px' } });
    const a = h('input', { type: 'number', value: 0, min: 0, max: 99, style: { width: '60px' } });
    modal({
      title: 'Add Tracks',
      body: h('div', row('Add Video Tracks', v), row('Add Audio Tracks', a)),
      buttons: [{ label: 'Cancel' }, { label: 'OK', cta: true, action: () => app.edit('Add Tracks', () => { E.addTracks(s, 'video', clamp(+v.value || 0, 0, 99)); E.addTracks(s, 'audio', clamp(+a.value || 0, 0, 99)); }) }],
    });
  },

  // ---------- voice over ----------
  async recordVoiceover(track) {
    const s = needSeq();
    if (!s) return;
    if (this._rec) {
      this._rec.stop();
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      return app.toast('Microphone access denied or unavailable', 'error');
    }
    const startFrame = s.playhead;
    const chunks = [];
    const rec = new MediaRecorder(stream);
    this._rec = rec;
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = async () => {
      this._rec = null;
      stream.getTracks().forEach((t) => t.stop());
      playback.stop();
      const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
      const file = new File([blob], 'Voice-over ' + new Date().toLocaleTimeString().replace(/:/g, '-') + '.webm', { type: blob.type });
      const { importFiles } = await import('./media.js');
      const items = await importFiles([file]);
      if (items[0]) {
        const ti = s.audioTracks.indexOf(track);
        this.placeItems([items[0]], startFrame, { vTrack: null, aTrack: ti });
      }
      app.status('Voice-over recorded');
    };
    rec.start();
    playback.play(1);
    app.toast('Recording voice-over… click the mic button again (or press Space) to stop.', 'warn', 4000);
    const off = app.bus.on('playback:state', (st) => {
      if (!st.playing && this._rec) {
        off();
        this._rec.stop();
      }
    });
  },

  // ---------- context menu ----------
  clipContextMenu(clip, frame) {
    const s = seq();
    const multi = app.sel.clips.size > 1;
    const item = clip.itemId ? findItem(app.project, clip.itemId) : null;
    const isV = clip.kind === 'video';
    return [
      { label: 'Cut', kbd: MOD + '+X', action: () => this.cut() },
      { label: 'Copy', kbd: MOD + '+C', action: () => this.copy() },
      { label: 'Paste Attributes…', kbd: MOD + '+Alt+V', disabled: !app.clipboard, action: () => this.pasteAttributesDialog() },
      { label: 'Remove Attributes…', action: () => this.removeAttributesDialog() },
      { label: 'Clear', kbd: 'Delete', action: () => this.clear() },
      { label: 'Ripple Delete', kbd: 'Shift+Delete', action: () => this.rippleDelete() },
      { sep: true },
      { label: 'Replace With Clip', submenu: [{ label: 'From Source Monitor', disabled: !app.sourceItemId, action: () => this.replaceWithSource(clip) }, { label: 'From Bin', disabled: !app.sel.items.size, action: () => this.replaceWithBin(clip) }] },
      { sep: true },
      { label: 'Enable', checked: clip.enabled, kbd: 'Shift+E', action: () => this.toggleEnable() },
      { label: clip.linkId ? 'Unlink' : 'Link', kbd: MOD + '+L', action: () => this.linkUnlink() },
      { label: 'Group', kbd: MOD + '+G', disabled: !multi, action: () => this.group() },
      { label: 'Ungroup', kbd: MOD + '+Shift+G', disabled: !clip.groupId, action: () => this.ungroup() },
      { label: 'Nest…', action: () => this.nestDialog() },
      { sep: true },
      { label: 'Label', submenu: () => labelMenu(clip.label, (n) => this.setLabel(n)) },
      { sep: true },
      { label: 'Speed/Duration…', kbd: MOD + '+R', action: () => this.speedDuration() },
      { label: 'Audio Gain…', kbd: 'G', disabled: isV && !multi, action: () => this.audioGainDialog() },
      { sep: true },
      { label: 'Add Frame Hold', disabled: !isV, action: () => this.addFrameHold(false) },
      { label: 'Insert Frame Hold Segment', disabled: !isV, action: () => this.addFrameHold(true) },
      { label: 'Time Interpolation', disabled: !isV, submenu: ['Frame Sampling', 'Frame Blending', 'Optical Flow'].map((l, i) => ({ label: l, checked: (clip.timeInterp || 0) === i, action: () => app.edit('Time Interpolation', () => selIds().forEach((id) => (findClip(s, id).clip.timeInterp = i))) })) },
      { label: 'Scale to Frame Size', checked: !!clip.scaleToFrame, disabled: !isV, action: () => this.scaleToFrame() },
      { label: 'Set to Frame Size', disabled: !isV, action: () => this.setToFrameSize() },
      { sep: true },
      { label: 'Link Media…', disabled: !item || item.type !== 'media', action: () => app.services.persist?.relinkItem(item) },
      { label: 'Rename…', action: () => this.renameClip() },
      { label: 'Reveal in Project', disabled: !item, action: () => this.revealInProject(clip) },
      { label: 'Open in Source Monitor', disabled: !item || item.type === 'sequence', action: () => this.openInSource(item, clipSourceTime(clip, frame, s.settings.fps, item.duration)) },
      { label: 'Open Nested Sequence', disabled: !item || item.type !== 'sequence', action: () => app.openSequence(item.id) },
    ];
  },
  replaceWithSource(clip) {
    const s = needSeq();
    const item = findItem(app.project, app.sourceItemId);
    if (!s || !item) return;
    app.edit('Replace With Clip', () => {
      const f = findClip(s, clip.id);
      f.clip.itemId = item.id;
      f.clip.name = item.name;
      f.clip.in = item.inPoint ?? 0;
    });
  },
  replaceWithBin(clip) {
    const s = needSeq();
    const item = findItem(app.project, [...app.sel.items][0]);
    if (!s || !item) return;
    app.edit('Replace With Clip', () => {
      const f = findClip(s, clip.id);
      f.clip.itemId = item.id;
      f.clip.name = item.name;
      f.clip.in = item.inPoint ?? 0;
    });
  },

  // ---------- masks ----------
  addMask(clipId, fxId, shape) {
    const s = needSeq();
    const f = findClip(s, clipId);
    if (!f) return;
    const fx = f.clip.effects.find((e) => e.id === fxId);
    if (!fx) return;
    const item = findItem(app.project, f.clip.itemId);
    const w = item?.type === 'sequence' ? item.settings.width : item?.width || s.settings.width;
    const hh = item?.type === 'sequence' ? item.settings.height : item?.height || s.settings.height;
    let m;
    app.edit('Add Mask', () => {
      m = createMask(shape, w, hh);
      m.name = 'Mask (' + (fx.masks.length + 1) + ')';
      if (shape === 'bezier') m.closed = false;
      fx.masks.push(m);
    });
    app.sel.maskId = m.id;
    app.bus.emit('selection:changed');
    return m;
  },
};

export { selIds };
