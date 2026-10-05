// Timeline editing operations (Premiere Pro semantics). All functions mutate the
// given sequence; callers wrap them in app.edit() for undo.

import { app } from './app.js';
import { uid, deepClone, clamp } from './util.js';
import {
  createClip, createEffect, createTrack, createSequence, createTransition, intrinsicEffectsFor, findItem, findClip, allTracks,
  clipEnd, sortClips, linkedClips, itemSourceDuration, clipSourceDuration, validateTransitions, transitionRange, renumberTracks,
  DEFAULT_LABEL, seqDuration, clipSourceTime, clipKfTime,
} from './model.js';
import { getTransitionDef } from './registry.js';

const EPS = 1e-6;

// ---------- basic clip helpers ----------
export function trimHead(c, d, fps) {
  c.start += d;
  c.dur -= d;
  if (!c.reverse) c.in += (d / fps) * c.speed;
}
export function trimTail(c, d, fps) {
  c.dur -= d;
  if (c.reverse) c.in += (d / fps) * c.speed;
}

export function cloneClip(c, overrides = {}) {
  const n = deepClone(c);
  n.id = uid('clp_');
  for (const fx of n.effects) {
    fx.id = uid('fx_');
    for (const m of fx.masks || []) m.id = uid('msk_');
  }
  if (n.graphic) for (const l of n.graphic.layers) l.id = uid('lyr_');
  return Object.assign(n, overrides);
}

function trackOf(seq, clip) {
  return findClip(seq, clip.id)?.track || null;
}

// Max frames the clip head can be extended (negative trim), or Infinity.
function headroom(project, c, fps) {
  const total = clipSourceDuration(project, c);
  if (!isFinite(total) || c.frameHold != null) return Infinity;
  if (c.reverse) return Math.floor(((total - (c.in + (c.dur / fps) * c.speed)) / c.speed) * fps + EPS);
  return Math.floor((c.in / c.speed) * fps + EPS);
}
function tailroom(project, c, fps) {
  const total = clipSourceDuration(project, c);
  if (!isFinite(total) || c.frameHold != null) return Infinity;
  if (c.reverse) return Math.floor((c.in / c.speed) * fps + EPS);
  return Math.floor(((total - (c.in + (c.dur / fps) * c.speed)) / c.speed) * fps + EPS);
}

export function neighbors(track, clip) {
  const arr = track.clips.filter((c) => c !== clip).sort((a, b) => a.start - b.start);
  let prev = null, next = null;
  for (const c of arr) {
    if (clipEnd(c) <= clip.start) prev = c;
    else if (c.start >= clipEnd(clip) && !next) next = c;
  }
  return { prev, next };
}

// ---------- range operations ----------
// Remove material in [a,b) from a track (overwrite semantics).
export function clearRange(seq, track, a, b, exclude = null) {
  const fps = seq.settings.fps;
  if (b <= a) return;
  const add = [];
  track.clips = track.clips.filter((c) => {
    if (exclude && exclude.has(c.id)) return true;
    const e = clipEnd(c);
    if (e <= a || c.start >= b) return true;
    if (c.start >= a && e <= b) return false;
    if (c.start < a && e > b) {
      const right = cloneClip(c, { linkId: c.linkId ? c.linkId + '_' + b : null });
      trimHead(right, b - c.start, fps);
      trimTail(c, e - a, fps);
      for (const tr of track.transitions) if (tr.clipA === c.id) tr.clipA = right.id;
      add.push(right);
      return true;
    }
    if (c.start < a) {
      trimTail(c, e - a, fps);
      return true;
    }
    trimHead(c, b - c.start, fps);
    return true;
  });
  track.clips.push(...add);
  sortClips(track);
}

export function splitClip(seq, track, clip, frame) {
  const fps = seq.settings.fps;
  if (frame <= clip.start || frame >= clipEnd(clip)) return null;
  const right = cloneClip(clip, { linkId: clip.linkId ? clip.linkId + '_' + frame : null });
  trimHead(right, frame - clip.start, fps);
  trimTail(clip, clipEnd(clip) - frame, fps);
  for (const tr of track.transitions) if (tr.clipA === clip.id) tr.clipA = right.id;
  track.clips.push(right);
  sortClips(track);
  return right;
}

// Shift clips starting at/after `at` by delta on a track. For negative deltas
// the shift is skipped when it would collide with material before `at`.
export function shiftTrack(track, at, delta, exclude = null) {
  if (!delta) return true;
  const movers = track.clips.filter((c) => c.start >= at && !(exclude && exclude.has(c.id)));
  if (delta < 0) {
    const limit = at + delta;
    const blocking = track.clips.some((c) => !movers.includes(c) && !(exclude && exclude.has(c.id)) && clipEnd(c) > limit && c.start < at);
    if (blocking) return false;
  }
  for (const c of movers) c.start += delta;
  sortClips(track);
  return true;
}

export function insertSpace(seq, track, at, dur) {
  const c = track.clips.find((x) => x.start < at && clipEnd(x) > at);
  if (c) splitClip(seq, track, c, at);
  for (const x of track.clips) if (x.start >= at) x.start += dur;
  sortClips(track);
}

export function syncTracks(seq, base = []) {
  const set = new Set(base.map((t) => t.id));
  for (const t of allTracks(seq)) if (t.syncLock && !t.locked) set.add(t.id);
  return allTracks(seq).filter((t) => set.has(t.id) && !t.locked);
}

export function targetedTracks(seq) {
  return allTracks(seq).filter((t) => t.target && !t.locked);
}

// ---------- placing project items ----------
export function itemHasVideo(item) {
  if (!item) return false;
  if (item.type === 'media') return item.kind !== 'audio';
  if (item.type === 'sequence') return item.videoTracks.some((t) => t.clips.length) || !item.audioTracks.some((t) => t.clips.length);
  if (item.type === 'synthetic') return true;
  return false;
}
export function itemHasAudio(item) {
  if (!item) return false;
  if (item.type === 'media') return !!item.hasAudio;
  if (item.type === 'sequence') return item.audioTracks.some((t) => t.clips.length);
  if (item.type === 'synthetic') return item.kind === 'bars' || item.kind === 'leader';
  return false;
}

export function defaultItemRange(item, fps) {
  // returns {in (sec), dur (frames)}
  const srcDur = itemSourceDuration(app.project, item);
  let inS = item.inPoint ?? 0;
  let outS = item.outPoint;
  if (!isFinite(srcDur)) {
    const d = item.type === 'synthetic' && item.kind === 'adjustment' ? app.prefs.stillDuration : app.prefs.stillDuration;
    const len = outS != null ? outS - inS : d;
    return { in: inS, dur: Math.max(1, Math.round(len * fps)) };
  }
  if (outS == null) outS = srcDur;
  return { in: inS, dur: Math.max(1, Math.round((outS - inS) * fps)) };
}

export function makeClipsForItem(seq, item, { start, srcIn, dur, video = true, audio = true }) {
  const fps = seq.settings.fps;
  const range = defaultItemRange(item, fps);
  const inS = srcIn ?? range.in;
  const d = dur ?? range.dur;
  const out = { video: null, audio: null };
  const hasV = video && itemHasVideo(item), hasA = audio && itemHasAudio(item);
  const linkId = hasV && hasA ? uid('lnk_') : null;
  const w = item.type === 'sequence' ? item.settings.width : item.width || seq.settings.width;
  const h = item.type === 'sequence' ? item.settings.height : item.height || seq.settings.height;
  const ctx = { w, h, seqW: seq.settings.width, seqH: seq.settings.height };
  const label = item.type === 'sequence' ? 'Forest' : item.label || DEFAULT_LABEL.video;
  if (hasV) {
    out.video = createClip({ itemId: item.id, kind: 'video', name: item.name, start, dur: d, in: inS, linkId, label, effects: intrinsicEffectsFor('video', ctx) });
    const scaling = app.prefs.mediaScaling;
    if (item.type !== 'sequence' && (w !== seq.settings.width || h !== seq.settings.height)) {
      if (scaling === 'scale') out.video.scaleToFrame = true;
      else if (scaling === 'set') {
        const fit = Math.min(seq.settings.width / w, seq.settings.height / h);
        out.video.effects[0].params.scale.v = Math.round(fit * 1000) / 10;
      }
    }
  }
  if (hasA) {
    const alabel = item.type === 'media' && item.kind === 'audio' ? item.label : item.type === 'sequence' ? 'Forest' : DEFAULT_LABEL.audio;
    out.audio = createClip({ itemId: item.id, kind: 'audio', name: item.name, start, dur: d, in: inS, linkId, label: alabel, effects: intrinsicEffectsFor('audio', ctx) });
  }
  return out;
}

function ensureTrack(seq, kind, index) {
  const arr = kind === 'video' ? seq.videoTracks : seq.audioTracks;
  while (arr.length <= index) arr.push(createTrack(kind, arr.length));
  renumberTracks(seq);
  return arr[index];
}

// Overwrite or insert an item at a frame. Returns created clips.
export function placeItem(seq, item, { at, mode = 'overwrite', vTrack = null, aTrack = null, srcIn, dur, video = true, audio = true }) {
  const clips = makeClipsForItem(seq, item, { start: at, srcIn, dur, video, audio });
  const placed = [];
  const vT = clips.video && vTrack != null && vTrack >= 0 ? ensureTrack(seq, 'video', vTrack) : null;
  const aT = clips.audio && aTrack != null && aTrack >= 0 ? ensureTrack(seq, 'audio', aTrack) : null;
  if (!vT) clips.video = null;
  if (!aT) clips.audio = null;
  if (clips.video && !clips.audio) clips.video.linkId = null;
  if (clips.audio && !clips.video) clips.audio.linkId = null;
  const d = (clips.video || clips.audio)?.dur || 0;
  if (!d) return [];
  if ((vT && vT.locked) || (aT && aT.locked)) {
    app.toast('Target track is locked', 'warn');
    return [];
  }
  if (mode === 'insert') {
    for (const t of syncTracks(seq, [vT, aT].filter(Boolean))) insertSpace(seq, t, at, d);
  } else {
    if (vT) clearRange(seq, vT, at, at + d);
    if (aT) clearRange(seq, aT, at, at + d);
  }
  if (clips.video) {
    vT.clips.push(clips.video);
    sortClips(vT);
    placed.push(clips.video);
  }
  if (clips.audio) {
    aT.clips.push(clips.audio);
    sortClips(aT);
    placed.push(clips.audio);
  }
  return placed;
}

// ---------- moving ----------
// dAway: tracks moved away from the video/audio divider (+ = up for video, down for audio).
export function moveClips(seq, ids, dFrames, dAwayV, dAwayA, { mode = 'overwrite', duplicate = false } = {}) {
  const entries = ids.map((id) => findClip(seq, id)).filter(Boolean);
  if (!entries.length) return [];
  if (entries.some((e) => e.track.locked)) {
    app.toast('Cannot move clips on a locked track', 'warn');
    return [];
  }
  const minStart = Math.min(...entries.map((e) => e.clip.start));
  dFrames = Math.max(dFrames, -minStart);
  const vIdx = entries.filter((e) => e.kind === 'video').map((e) => e.index);
  const aIdx = entries.filter((e) => e.kind === 'audio').map((e) => e.index);
  if (vIdx.length) dAwayV = Math.max(dAwayV, -Math.min(...vIdx));
  if (aIdx.length) dAwayA = Math.max(dAwayA, -Math.min(...aIdx));
  // destination tracks
  const plan = entries.map((e) => {
    const di = e.index + (e.kind === 'video' ? dAwayV : dAwayA);
    return { ...e, destIndex: di };
  });
  for (const p of plan) {
    const t = ensureTrack(seq, p.kind, p.destIndex);
    if (t.locked) {
      app.toast('Destination track is locked', 'warn');
      return [];
    }
    p.dest = t;
  }
  // transitions that move with their clips
  const idSet = new Set(ids);
  const movingTransitions = [];
  for (const p of plan) {
    for (const tr of p.track.transitions) {
      const ok = (!tr.clipA || idSet.has(tr.clipA)) && (!tr.clipB || idSet.has(tr.clipB));
      if (ok && (tr.clipA === p.clip.id || (!tr.clipA && tr.clipB === p.clip.id)) && !movingTransitions.some((m) => m.tr === tr)) {
        movingTransitions.push({ tr, from: p.track, to: p.dest });
      }
    }
  }
  // remove originals
  const moved = [];
  const linkMap = new Map();
  for (const p of plan) {
    let c = p.clip;
    if (duplicate) {
      let lk = null;
      if (c.linkId) {
        if (!linkMap.has(c.linkId)) linkMap.set(c.linkId, uid('lnk_'));
        lk = linkMap.get(c.linkId);
      }
      c = cloneClip(c, { linkId: lk });
    } else {
      p.track.clips = p.track.clips.filter((x) => x !== c);
    }
    c.start += dFrames;
    moved.push({ clip: c, dest: p.dest, origId: p.clip.id });
  }
  if (!duplicate)
    for (const m of movingTransitions) {
      m.from.transitions = m.from.transitions.filter((t) => t !== m.tr);
      m.to.transitions.push(m.tr);
    }
  else
    for (const m of movingTransitions) {
      const idMap = new Map(moved.map((x) => [x.origId, x.clip.id]));
      const n = deepClone(m.tr);
      n.id = uid('tr_');
      n.clipA = n.clipA ? idMap.get(n.clipA) : null;
      n.clipB = n.clipB ? idMap.get(n.clipB) : null;
      m.to.transitions.push(n);
    }
  const movedIds = new Set(moved.map((m) => m.clip.id));
  if (mode === 'insert') {
    const at = Math.min(...moved.map((m) => m.clip.start));
    const end = Math.max(...moved.map((m) => clipEnd(m.clip)));
    for (const t of syncTracks(seq, moved.map((m) => m.dest))) insertSpace(seq, t, at, end - at);
  } else {
    for (const m of moved) clearRange(seq, m.dest, m.clip.start, clipEnd(m.clip), movedIds);
  }
  for (const m of moved) {
    m.dest.clips.push(m.clip);
    sortClips(m.dest);
  }
  return moved.map((m) => m.clip);
}

// ---------- trimming ----------
export function trimEdge(seq, ids, edge, delta, { ripple = false } = {}) {
  const fps = seq.settings.fps;
  const project = app.project;
  const entries = ids.map((id) => findClip(seq, id)).filter(Boolean).filter((e) => !e.track.locked);
  if (!entries.length || !delta) return 0;
  // constrain
  for (const e of entries) {
    const c = e.clip;
    const nb = neighbors(e.track, c);
    if (edge === 'in') {
      delta = Math.min(delta, c.dur - 1);
      delta = Math.max(delta, -headroom(project, c, fps));
      if (!ripple) delta = Math.max(delta, -c.start);
      if (!ripple && nb.prev) delta = Math.max(delta, clipEnd(nb.prev) - c.start);
    } else {
      delta = Math.max(delta, -(c.dur - 1));
      delta = Math.min(delta, tailroom(project, c, fps));
      if (!ripple && nb.next) delta = Math.min(delta, nb.next.start - clipEnd(c));
    }
  }
  if (!delta) return 0;
  const tracks = [...new Set(entries.map((e) => e.track))];
  const exclude = new Set(entries.map((e) => e.clip.id));
  if (edge === 'in') {
    const at = Math.min(...entries.map((e) => e.clip.start));
    for (const e of entries) trimHead(e.clip, delta, fps);
    if (ripple) {
      for (const e of entries) e.clip.start -= delta;
      for (const t of syncTracks(seq, tracks)) shiftTrack(t, delta > 0 ? at + delta : at, -delta, exclude);
    }
  } else {
    const at = Math.min(...entries.map((e) => clipEnd(e.clip)));
    for (const e of entries) trimTail(e.clip, -delta, fps);
    if (ripple) for (const t of syncTracks(seq, tracks)) shiftTrack(t, at, delta, exclude);
  }
  return delta;
}

export function rollEdit(seq, leftId, rightId, delta) {
  const fps = seq.settings.fps;
  const project = app.project;
  const L = findClip(seq, leftId), R = findClip(seq, rightId);
  if (!L || !R || L.track.locked) return 0;
  delta = Math.min(delta, R.clip.dur - 1, tailroom(project, L.clip, fps));
  delta = Math.max(delta, -(L.clip.dur - 1), -headroom(project, R.clip, fps));
  if (!delta) return 0;
  trimTail(L.clip, -delta, fps);
  trimHead(R.clip, delta, fps);
  return delta;
}

export function rateStretch(seq, ids, edge, delta) {
  const fps = seq.settings.fps;
  const entries = ids.map((id) => findClip(seq, id)).filter(Boolean);
  for (const e of entries) {
    const c = e.clip;
    const nb = neighbors(e.track, c);
    if (edge === 'out') {
      delta = Math.max(delta, 1 - c.dur);
      if (nb.next) delta = Math.min(delta, nb.next.start - clipEnd(c));
    } else {
      delta = Math.min(delta, c.dur - 1);
      if (nb.prev) delta = Math.max(delta, clipEnd(nb.prev) - c.start);
      delta = Math.max(delta, -c.start);
    }
  }
  if (!delta) return 0;
  for (const e of entries) {
    const c = e.clip;
    const srcLen = (c.dur / fps) * c.speed;
    const newDur = edge === 'out' ? c.dur + delta : c.dur - delta;
    if (edge === 'in') c.start += delta;
    c.dur = newDur;
    c.speed = srcLen / (newDur / fps);
  }
  return delta;
}

export function slip(seq, ids, delta) {
  const fps = seq.settings.fps;
  const project = app.project;
  const entries = ids.map((id) => findClip(seq, id)).filter(Boolean);
  for (const e of entries) {
    const c = e.clip;
    const total = clipSourceDuration(project, c);
    if (!isFinite(total)) continue;
    const span = (c.dur / fps) * c.speed;
    const minIn = 0, maxIn = Math.max(0, total - span);
    const want = c.in - (delta / fps) * c.speed;
    const clampIn = clamp(want, minIn, maxIn);
    c.in = clampIn;
  }
}

export function slide(seq, id, delta) {
  const fps = seq.settings.fps;
  const project = app.project;
  const e = findClip(seq, id);
  if (!e) return 0;
  const c = e.clip;
  const nb = neighbors(e.track, c);
  const prev = nb.prev && clipEnd(nb.prev) === c.start ? nb.prev : null;
  const next = nb.next && nb.next.start === clipEnd(c) ? nb.next : null;
  if (prev) delta = Math.max(delta, -(prev.dur - 1));
  else delta = Math.max(delta, nb.prev ? clipEnd(nb.prev) - c.start : -c.start);
  if (next) delta = Math.min(delta, next.dur - 1);
  else if (nb.next) delta = Math.min(delta, nb.next.start - clipEnd(c));
  if (prev) delta = Math.min(delta, tailroom(project, prev, fps));
  if (next) delta = Math.max(delta, -headroom(project, next, fps));
  if (!delta) return 0;
  if (prev) trimTail(prev, -delta, fps);
  if (next) trimHead(next, delta, fps);
  c.start += delta;
  return delta;
}

// ---------- deleting ----------
export function deleteClips(seq, ids, ripple = false) {
  const intervals = [];
  const touched = new Set();
  for (const id of ids) {
    const e = findClip(seq, id);
    if (!e || e.track.locked) continue;
    e.track.clips = e.track.clips.filter((c) => c.id !== id);
    intervals.push([e.clip.start, clipEnd(e.clip)]);
    touched.add(e.track);
  }
  validateTransitions(seq);
  if (!ripple || !intervals.length) return;
  // merge intervals, process right-to-left
  intervals.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const iv of intervals) {
    const last = merged[merged.length - 1];
    if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
    else merged.push([...iv]);
  }
  merged.reverse();
  const tracks = syncTracks(seq, [...touched]);
  for (const [a, b] of merged) {
    for (const t of tracks) {
      const busy = t.clips.some((c) => c.start < b && clipEnd(c) > a);
      if (!busy) shiftTrack(t, b, a - b);
    }
  }
}

export function closeGapAt(seq, track, a, b) {
  const tracks = syncTracks(seq, [track]);
  for (const t of tracks) {
    const busy = t.clips.some((c) => c.start < b && clipEnd(c) > a);
    if (!busy) shiftTrack(t, b, a - b);
  }
}

export function gapAt(track, frame) {
  const sorted = track.clips.slice().sort((a, b) => a.start - b.start);
  let prevEnd = 0;
  for (const c of sorted) {
    if (frame >= prevEnd && frame < c.start) return { start: prevEnd, end: c.start };
    prevEnd = Math.max(prevEnd, clipEnd(c));
  }
  return null;
}

export function closeAllGaps(seq) {
  for (const t of allTracks(seq)) {
    if (t.locked) continue;
    let pos = 0;
    for (const c of t.clips.slice().sort((a, b) => a.start - b.start)) {
      if (c.start > pos) c.start = pos;
      pos = clipEnd(c);
    }
  }
}

export function lift(seq, a, b) {
  for (const t of targetedTracks(seq)) clearRange(seq, t, a, b);
}

export function extract(seq, a, b) {
  const targets = targetedTracks(seq);
  const tracks = syncTracks(seq, targets);
  for (const t of tracks) {
    clearRange(seq, t, a, b);
    shiftTrack(t, b, a - b);
  }
}

// ---------- add edit ----------
export function addEdit(seq, frame, { allTracks: all = false, ids = null } = {}) {
  let count = 0;
  if (ids && ids.length) {
    for (const id of ids) {
      const e = findClip(seq, id);
      if (e && !e.track.locked && splitClip(seq, e.track, e.clip, frame)) count++;
    }
    return count;
  }
  const tracks = all ? allTracks(seq).filter((t) => !t.locked) : targetedTracks(seq);
  for (const t of tracks) {
    const c = t.clips.find((x) => x.start < frame && clipEnd(x) > frame);
    if (c && splitClip(seq, t, c, frame)) count++;
  }
  return count;
}

export function razorAt(seq, clipId, frame, { linked = true, allTracks: all = false } = {}) {
  if (all) return addEdit(seq, frame, { allTracks: true });
  const e = findClip(seq, clipId);
  if (!e) return 0;
  const clips = linked && app.linkedSelection ? linkedClips(seq, e.clip) : [e.clip];
  let n = 0;
  for (const c of clips) {
    const t = trackOf(seq, c);
    if (t && !t.locked && splitClip(seq, t, c, frame)) n++;
  }
  return n;
}

// Q / W ripple trims
export function rippleTrimToPlayhead(seq, frame, which) {
  const fps = seq.settings.fps;
  const targets = targetedTracks(seq);
  const hits = [];
  for (const t of targets) {
    const c = t.clips.find((x) => x.start < frame && clipEnd(x) > frame);
    if (c) hits.push({ t, c });
  }
  if (!hits.length) return null;
  const clips = new Set();
  for (const h of hits) for (const c of app.linkedSelection ? linkedClips(seq, h.c) : [h.c]) clips.add(c);
  let arr = [...clips];
  const editPt = which === 'prev' ? Math.max(...arr.map((c) => c.start)) : Math.min(...arr.map((c) => clipEnd(c)));
  arr = arr.filter((c) => (which === 'prev' ? c.start === editPt : clipEnd(c) === editPt));
  const exclude = new Set(arr.map((c) => c.id));
  const tracks = syncTracks(seq, arr.map((c) => trackOf(seq, c)));
  if (which === 'prev') {
    const edit = Math.max(...arr.map((c) => c.start));
    const delta = frame - edit;
    for (const c of arr) trimHead(c, frame - c.start, fps);
    for (const c of arr) c.start -= delta;
    for (const t of tracks) shiftTrack(t, frame, -delta, exclude);
    return edit;
  }
  const edit = Math.min(...arr.map((c) => clipEnd(c)));
  const delta = edit - frame;
  for (const c of arr) trimTail(c, clipEnd(c) - frame, fps);
  for (const t of tracks) shiftTrack(t, edit, -delta, exclude);
  return frame;
}

// ---------- transitions ----------
export function applyTransition(seq, track, clip, edge, type, durFrames, align = 'center') {
  const def = getTransitionDef(type);
  if (!def || track.locked) return null;
  const nb = neighbors(track, clip);
  let A = null, B = null;
  if (edge === 'out') {
    A = clip;
    if (nb.next && nb.next.start === clipEnd(clip)) B = nb.next;
  } else {
    B = clip;
    if (nb.prev && clipEnd(nb.prev) === clip.start) A = nb.prev;
  }
  // remove existing at same edit point
  track.transitions = track.transitions.filter((t) => !((A && t.clipA === A.id && (B ? t.clipB === B.id : !t.clipB)) || (B && t.clipB === B.id && (A ? t.clipA === A.id : !t.clipA))));
  let dur = durFrames;
  let offset;
  if (A && B) {
    dur = Math.min(dur, A.dur + B.dur);
    offset = align === 'start' ? 0 : align === 'end' ? dur : Math.floor(dur / 2);
    offset = Math.min(offset, A.dur);
    if (dur - offset > B.dur) offset = dur - B.dur;
  } else if (A) {
    dur = Math.min(dur, A.dur);
    offset = dur;
  } else {
    dur = Math.min(dur, B.dur);
    offset = 0;
  }
  const tr = createTransition(type, { clipA: A ? A.id : null, clipB: B ? B.id : null, dur, offset });
  track.transitions.push(tr);
  return tr;
}

export function findTransition(seq, id) {
  for (const t of allTracks(seq)) {
    const tr = t.transitions.find((x) => x.id === id);
    if (tr) return { tr, track: t };
  }
  return null;
}

export function removeTransition(seq, id) {
  for (const t of allTracks(seq)) t.transitions = t.transitions.filter((x) => x.id !== id);
}

// Edit point closest to frame on a track: returns {clip, edge}
export function editPointNear(track, frame, maxDist = Infinity) {
  let best = null, bd = maxDist;
  for (const c of track.clips) {
    for (const [edge, f] of [['in', c.start], ['out', clipEnd(c)]]) {
      const d = Math.abs(f - frame);
      if (d < bd || (d === bd && edge === 'in')) {
        bd = d;
        best = { clip: c, edge, frame: f };
      }
    }
  }
  return best;
}

export function applyDefaultTransitions(seq, frame, kind) {
  const prefs = app.prefs;
  const n = [];
  for (const t of targetedTracks(seq)) {
    if (kind && t.kind !== kind) continue;
    const ep = editPointNear(t, frame, Math.round(seq.settings.fps));
    if (!ep) continue;
    const type = t.kind === 'video' ? prefs.defaultVideoTransition : prefs.defaultAudioTransition;
    const dur = Math.round((t.kind === 'video' ? prefs.videoTransitionDuration : prefs.audioTransitionDuration) * seq.settings.fps);
    const tr = applyTransition(seq, t, ep.clip, ep.edge, type, dur);
    if (tr) n.push(tr);
  }
  return n;
}

export function applyTransitionsToSelection(seq, ids, kind = null) {
  const prefs = app.prefs;
  const out = [];
  for (const id of ids) {
    const e = findClip(seq, id);
    if (!e || (kind && e.kind !== kind)) continue;
    const type = e.kind === 'video' ? prefs.defaultVideoTransition : prefs.defaultAudioTransition;
    const dur = Math.round((e.kind === 'video' ? prefs.videoTransitionDuration : prefs.audioTransitionDuration) * seq.settings.fps);
    const nb = neighbors(e.track, e.clip);
    const prevSel = nb.prev && ids.includes(nb.prev.id) && clipEnd(nb.prev) === e.clip.start;
    if (!prevSel) out.push(applyTransition(seq, e.track, e.clip, 'in', type, dur));
    out.push(applyTransition(seq, e.track, e.clip, 'out', type, dur));
  }
  return out.filter(Boolean);
}

// ---------- speed / frame hold ----------
export function setSpeed(seq, id, speedPct, { reverse = null, ripple = false } = {}) {
  const fps = seq.settings.fps;
  const e = findClip(seq, id);
  if (!e) return;
  const c = e.clip;
  const newSpeed = Math.max(0.0001, speedPct / 100);
  const srcLen = (c.dur / fps) * c.speed;
  let newDur = Math.max(1, Math.round((srcLen / newSpeed) * fps));
  const nb = neighbors(e.track, c);
  const oldEnd = clipEnd(c);
  if (!ripple && nb.next) newDur = Math.min(newDur, nb.next.start - c.start);
  c.speed = newSpeed;
  c.dur = newDur;
  if (reverse != null) c.reverse = reverse;
  if (ripple) shiftTrack(e.track, oldEnd, clipEnd(c) - oldEnd, new Set([c.id]));
}

export function setDuration(seq, id, durFrames, opts = {}) {
  const fps = seq.settings.fps;
  const e = findClip(seq, id);
  if (!e) return;
  const c = e.clip;
  const total = clipSourceDuration(app.project, c);
  if (!isFinite(total) && c.speed === 1) {
    const nb = neighbors(e.track, c);
    const oldEnd = clipEnd(c);
    let d = Math.max(1, durFrames);
    if (!opts.ripple && nb.next) d = Math.min(d, nb.next.start - c.start);
    c.dur = d;
    if (opts.ripple) shiftTrack(e.track, oldEnd, clipEnd(c) - oldEnd, new Set([c.id]));
    return;
  }
  const srcLen = (c.dur / fps) * c.speed;
  setSpeed(seq, id, (srcLen / (durFrames / fps)) * 100, opts);
}

export function addFrameHold(seq, id, frame, { insert = false, holdSec = 2 } = {}) {
  const e = findClip(seq, id);
  if (!e) return;
  const fps = seq.settings.fps;
  const t = clipSourceTime(e.clip, frame, fps, clipSourceDuration(app.project, e.clip));
  if (!insert) {
    const right = frame > e.clip.start ? splitClip(seq, e.track, e.clip, frame) : e.clip;
    if (right) right.frameHold = t;
    return right;
  }
  const d = Math.round(holdSec * fps);
  for (const tr of syncTracks(seq, [e.track])) insertSpace(seq, tr, frame, d);
  const hold = cloneClip(e.clip, { start: frame, dur: d, frameHold: t, linkId: null });
  e.track.clips.push(hold);
  sortClips(e.track);
  return hold;
}

// ---------- link / group / enable ----------
export function link(seq, ids) {
  const lk = uid('lnk_');
  for (const id of ids) {
    const e = findClip(seq, id);
    if (e) e.clip.linkId = lk;
  }
}
export function unlink(seq, ids) {
  for (const id of ids) {
    const e = findClip(seq, id);
    if (e) e.clip.linkId = null;
  }
}
export function group(seq, ids) {
  const g = uid('grp_');
  for (const id of ids) {
    const e = findClip(seq, id);
    if (e) e.clip.groupId = g;
  }
}
export function ungroup(seq, ids) {
  for (const id of ids) {
    const e = findClip(seq, id);
    if (e) e.clip.groupId = null;
  }
}

// ---------- tracks ----------
export function addTracks(seq, kind, count = 1, at = null) {
  const arr = kind === 'video' ? seq.videoTracks : seq.audioTracks;
  const pos = at == null ? arr.length : at;
  for (let i = 0; i < count; i++) {
    const t = createTrack(kind, arr.length);
    t.target = false;
    arr.splice(pos + i, 0, t);
  }
  renumberTracks(seq);
}

export function deleteTrack(seq, trackId) {
  const isV = seq.videoTracks.some((t) => t.id === trackId);
  const arr = isV ? seq.videoTracks : seq.audioTracks;
  if (arr.length <= 1) {
    app.toast('A sequence needs at least one ' + (isV ? 'video' : 'audio') + ' track', 'warn');
    return;
  }
  const idx = arr.findIndex((t) => t.id === trackId);
  arr.splice(idx, 1);
  renumberTracks(seq);
}

export function deleteEmptyTracks(seq) {
  seq.videoTracks = seq.videoTracks.filter((t, i) => t.clips.length || i === 0);
  seq.audioTracks = seq.audioTracks.filter((t, i) => t.clips.length || i === 0);
  renumberTracks(seq);
}

// ---------- nesting ----------
export function nestClips(seq, ids, name) {
  const project = app.project;
  const entries = ids.map((id) => findClip(seq, id)).filter(Boolean);
  if (!entries.length) return null;
  const minStart = Math.min(...entries.map((e) => e.clip.start));
  const maxEnd = Math.max(...entries.map((e) => clipEnd(e.clip)));
  const vIdx = entries.filter((e) => e.kind === 'video').map((e) => e.index);
  const aIdx = entries.filter((e) => e.kind === 'audio').map((e) => e.index);
  const vMin = vIdx.length ? Math.min(...vIdx) : 0, aMin = aIdx.length ? Math.min(...aIdx) : 0;
  const ns = createSequence(project, {
    name: name || 'Nested Sequence ' + (++project.counters.nest),
    width: seq.settings.width, height: seq.settings.height, fps: seq.settings.fps,
    videoTracks: Math.max(1, vIdx.length ? Math.max(...vIdx) - vMin + 1 : 1),
    audioTracks: Math.max(1, aIdx.length ? Math.max(...aIdx) - aMin + 1 : 1),
  });
  project.counters.sequence--; // nested sequences don't consume "Sequence NN" numbering
  const idSet = new Set(ids);
  for (const e of entries) {
    const destArr = e.kind === 'video' ? ns.videoTracks : ns.audioTracks;
    const di = e.index - (e.kind === 'video' ? vMin : aMin);
    const c = deepClone(e.clip);
    c.start -= minStart;
    destArr[di].clips.push(c);
    for (const tr of e.track.transitions) {
      if (tr.clipA === e.clip.id || (!tr.clipA && tr.clipB === e.clip.id)) {
        if ((!tr.clipA || idSet.has(tr.clipA)) && (!tr.clipB || idSet.has(tr.clipB))) destArr[di].transitions.push(deepClone(tr));
      }
    }
    e.track.clips = e.track.clips.filter((x) => x.id !== e.clip.id);
  }
  validateTransitions(seq);
  project.items.push(ns);
  const placed = placeItem(seq, ns, {
    at: minStart, mode: 'overwrite', vTrack: vIdx.length ? vMin : null, aTrack: aIdx.length ? aMin : null, srcIn: 0, dur: maxEnd - minStart,
  });
  return { seq: ns, clips: placed };
}

// ---------- clipboard ----------
export function copyClips(seq, ids) {
  const entries = ids.map((id) => findClip(seq, id)).filter(Boolean);
  if (!entries.length) return null;
  const minStart = Math.min(...entries.map((e) => e.clip.start));
  const vMin = Math.min(...entries.filter((e) => e.kind === 'video').map((e) => e.index), 99);
  const aMin = Math.min(...entries.filter((e) => e.kind === 'audio').map((e) => e.index), 99);
  return {
    type: 'clips',
    fps: seq.settings.fps,
    clips: entries.map((e) => ({ clip: deepClone(e.clip), kind: e.kind, rel: e.index - (e.kind === 'video' ? vMin : aMin), offset: e.clip.start - minStart })),
    transitions: entries.flatMap((e) => e.track.transitions.filter((t) => t.clipA === e.clip.id || (!t.clipA && t.clipB === e.clip.id)).map((t) => ({ tr: deepClone(t), kind: e.kind, rel: e.index - (e.kind === 'video' ? vMin : aMin) }))),
  };
}

export function pasteClips(seq, data, at, { insert = false } = {}) {
  if (!data || data.type !== 'clips') return [];
  const tgtV = seq.videoTracks.findIndex((t) => t.target && !t.locked);
  const tgtA = seq.audioTracks.findIndex((t) => t.target && !t.locked);
  const baseV = tgtV >= 0 ? tgtV : 0, baseA = tgtA >= 0 ? tgtA : 0;
  const linkMap = new Map(), idMap = new Map();
  const made = data.clips.map((d) => {
    let lk = null;
    if (d.clip.linkId) {
      if (!linkMap.has(d.clip.linkId)) linkMap.set(d.clip.linkId, uid('lnk_'));
      lk = linkMap.get(d.clip.linkId);
    }
    const c = cloneClip(d.clip, { start: at + d.offset, linkId: lk, groupId: d.clip.groupId ? d.clip.groupId + '_p' : null });
    idMap.set(d.clip.id, c.id);
    const track = ensureTrack(seq, d.kind, (d.kind === 'video' ? baseV : baseA) + d.rel);
    return { c, track };
  });
  const span = Math.max(...made.map((m) => clipEnd(m.c))) - at;
  if (insert) for (const t of syncTracks(seq, made.map((m) => m.track))) insertSpace(seq, t, at, span);
  else for (const m of made) clearRange(seq, m.track, m.c.start, clipEnd(m.c));
  for (const m of made) {
    m.track.clips.push(m.c);
    sortClips(m.track);
  }
  for (const t of data.transitions || []) {
    const track = ensureTrack(seq, t.kind, (t.kind === 'video' ? baseV : baseA) + t.rel);
    const n = deepClone(t.tr);
    n.id = uid('tr_');
    n.clipA = n.clipA ? idMap.get(n.clipA) || null : null;
    n.clipB = n.clipB ? idMap.get(n.clipB) || null : null;
    if (n.clipA || n.clipB) track.transitions.push(n);
  }
  return made.map((m) => m.c);
}

export function pasteAttributes(seq, srcClip, ids, what = { motion: true, opacity: true, timeRemap: false, volume: true, channelVolume: true, panner: true, effects: true }) {
  for (const id of ids) {
    const e = findClip(seq, id);
    if (!e || e.clip.id === srcClip.id) continue;
    const c = e.clip;
    if (c.kind !== srcClip.kind) continue;
    for (const type of ['motion', 'opacity', 'timeRemap', 'volume', 'channelVolume', 'panner']) {
      if (!what[type]) continue;
      const s = srcClip.effects.find((f) => f.type === type);
      const i = c.effects.findIndex((f) => f.type === type);
      if (s && i >= 0) c.effects[i] = Object.assign(deepClone(s), { id: c.effects[i].id });
    }
    if (what.effects) {
      for (const s of srcClip.effects) {
        if (['motion', 'opacity', 'timeRemap', 'volume', 'channelVolume', 'panner'].includes(s.type)) continue;
        const n = deepClone(s);
        n.id = uid('fx_');
        c.effects.push(n);
      }
    }
  }
}

export function removeAttributes(seq, ids, what = { motion: true, opacity: true, effects: true, volume: true }) {
  const fpsSeq = seq;
  for (const id of ids) {
    const e = findClip(fpsSeq, id);
    if (!e) continue;
    const c = e.clip;
    const item = findItem(app.project, c.itemId);
    const w = item?.type === 'sequence' ? item.settings.width : item?.width || seq.settings.width;
    const h = item?.type === 'sequence' ? item.settings.height : item?.height || seq.settings.height;
    const ctx = { w, h, seqW: seq.settings.width, seqH: seq.settings.height };
    c.effects = c.effects
      .map((f) => {
        if (['motion', 'opacity', 'volume'].includes(f.type) && what[f.type]) return Object.assign(createEffect(f.type, ctx), { id: f.id });
        return f;
      })
      .filter((f) => (what.effects ? ['motion', 'opacity', 'timeRemap', 'volume', 'channelVolume', 'panner'].includes(f.type) : true));
  }
}

export function setToFrameSize(seq, ids) {
  for (const id of ids) {
    const e = findClip(seq, id);
    if (!e || e.kind !== 'video') continue;
    const c = e.clip;
    const item = findItem(app.project, c.itemId);
    const w = item?.type === 'sequence' ? item.settings.width : item?.width || seq.settings.width;
    const h = item?.type === 'sequence' ? item.settings.height : item?.height || seq.settings.height;
    const fit = Math.min(seq.settings.width / w, seq.settings.height / h);
    const m = c.effects.find((f) => f.type === 'motion');
    if (m) {
      m.params.scale = { v: Math.round(fit * 1000) / 10, kf: null };
      m.params.scaleWidth = { v: Math.round(fit * 1000) / 10, kf: null };
    }
    c.scaleToFrame = false;
  }
}

// Navigation helpers
export function editPoints(seq, { targetedOnly = false } = {}) {
  const pts = new Set([0]);
  for (const t of allTracks(seq)) {
    if (targetedOnly && !t.target) continue;
    for (const c of t.clips) {
      pts.add(c.start);
      pts.add(clipEnd(c));
    }
  }
  return [...pts].sort((a, b) => a - b);
}

export { seqDuration, clipKfTime, transitionRange };
