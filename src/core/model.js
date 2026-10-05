// Project data model: plain JSON-serializable objects + factory/query helpers.

import { uid, clamp, deepClone } from './util.js';
import { getEffectDef, getTransitionDef } from './registry.js';
import { evalParam } from './keyframes.js';

export const LABEL_COLORS = {
  Violet: '#9a87e8',
  Iris: '#7f8fe8',
  Caribbean: '#22c29a',
  Lavender: '#d48ae6',
  Cerulean: '#22a0ef',
  Forest: '#79ac3c',
  Rose: '#e6739f',
  Mango: '#eaa53e',
  Purple: '#9a5ad2',
  Blue: '#4568e2',
  Teal: '#2ba7a7',
  Magenta: '#d541b0',
  Tan: '#c9a87e',
  Green: '#41b14b',
  Brown: '#94613f',
  Yellow: '#e4d23e',
};

export const DEFAULT_LABEL = {
  video: 'Iris',
  audio: 'Caribbean',
  image: 'Lavender',
  sequence: 'Forest',
  synthetic: 'Lavender',
  graphic: 'Rose',
  adjustment: 'Lavender',
  bin: 'Mango',
  caption: 'Mango',
};

export const SEQUENCE_PRESETS = [
  { group: 'Digital SLR / Web', name: 'HD 1080p 23.976', width: 1920, height: 1080, fps: 24000 / 1001 },
  { group: 'Digital SLR / Web', name: 'HD 1080p 25', width: 1920, height: 1080, fps: 25 },
  { group: 'Digital SLR / Web', name: 'HD 1080p 29.97', width: 1920, height: 1080, fps: 30000 / 1001 },
  { group: 'Digital SLR / Web', name: 'HD 1080p 30', width: 1920, height: 1080, fps: 30 },
  { group: 'Digital SLR / Web', name: 'HD 1080p 59.94', width: 1920, height: 1080, fps: 60000 / 1001 },
  { group: 'Digital SLR / Web', name: 'HD 1080p 60', width: 1920, height: 1080, fps: 60 },
  { group: 'Digital SLR / Web', name: 'HD 720p 29.97', width: 1280, height: 720, fps: 30000 / 1001 },
  { group: 'Digital SLR / Web', name: 'HD 720p 30', width: 1280, height: 720, fps: 30 },
  { group: 'UHD', name: 'UHD 4K 23.976', width: 3840, height: 2160, fps: 24000 / 1001 },
  { group: 'UHD', name: 'UHD 4K 25', width: 3840, height: 2160, fps: 25 },
  { group: 'UHD', name: 'UHD 4K 29.97', width: 3840, height: 2160, fps: 30000 / 1001 },
  { group: 'Social', name: 'Vertical 1080x1920 30', width: 1080, height: 1920, fps: 30 },
  { group: 'Social', name: 'Square 1080x1080 30', width: 1080, height: 1080, fps: 30 },
  { group: 'Social', name: 'Portrait 4:5 1080x1350 30', width: 1080, height: 1350, fps: 30 },
  { group: 'SD', name: 'NTSC 640x480 29.97', width: 640, height: 480, fps: 30000 / 1001 },
  { group: 'SD', name: 'Web 640x360 30', width: 640, height: 360, fps: 30 },
];

export function createProject(name = 'Untitled') {
  return {
    format: 'vid-edi-project',
    version: 1,
    id: uid('prj_'),
    name,
    created: Date.now(),
    items: [],
    activeSequenceId: null,
    openSequenceIds: [],
    counters: { sequence: 0, bin: 0, colorMatte: 0, adjustment: 0, graphic: 0, nest: 0 },
  };
}

export function createBin(project, name, parent = null) {
  project.counters.bin = (project.counters.bin || 0) + 1;
  return { id: uid('bin_'), type: 'bin', name: name || 'Bin ' + project.counters.bin, parent, label: 'Mango', expanded: true };
}

export function createMediaItem(props) {
  return Object.assign(
    {
      id: uid('med_'),
      type: 'media',
      kind: 'video', // video | audio | image
      name: 'Media',
      parent: null,
      label: DEFAULT_LABEL[props.kind || 'video'],
      mime: '',
      size: 0,
      duration: 0, // seconds; images -> 0 (unlimited)
      width: 0,
      height: 0,
      fps: 30,
      hasVideo: true,
      hasAudio: false,
      audioChannels: 2,
      inPoint: null,
      outPoint: null,
      markers: [],
      offline: false,
      lastModified: 0,
    },
    props,
  );
}

export const SYNTHETIC_KINDS = {
  colormatte: 'Color Matte',
  adjustment: 'Adjustment Layer',
  black: 'Black Video',
  transparent: 'Transparent Video',
  bars: 'Bars and Tone',
  leader: 'Universal Counting Leader',
};

export function createSyntheticItem(kind, seqSettings, opts = {}) {
  return Object.assign(
    {
      id: uid('syn_'),
      type: 'synthetic',
      kind,
      name: SYNTHETIC_KINDS[kind] || kind,
      parent: null,
      label: kind === 'adjustment' ? 'Lavender' : kind === 'bars' ? 'Iris' : 'Lavender',
      width: seqSettings?.width || 1920,
      height: seqSettings?.height || 1080,
      fps: seqSettings?.fps || 30,
      duration: kind === 'leader' ? 11 : 0,
      color: '#000000',
      hasVideo: true,
      hasAudio: kind === 'bars' || kind === 'leader',
      inPoint: null,
      outPoint: null,
      markers: [],
    },
    opts,
  );
}

export function createTrack(kind, index) {
  return {
    id: uid('trk_'),
    kind,
    name: (kind === 'video' ? 'V' : 'A') + (index + 1),
    customName: '',
    locked: false,
    syncLock: true,
    hidden: false, // video: toggle track output
    muted: false,
    solo: false,
    target: index === 0,
    height: kind === 'video' ? 34 : 34,
    volume: 0, // dB (audio track mixer)
    pan: 0, // -1..1
    clips: [],
    transitions: [],
  };
}

export function createSequence(project, opts = {}) {
  project.counters.sequence = (project.counters.sequence || 0) + 1;
  const seq = {
    id: uid('seq_'),
    type: 'sequence',
    name: opts.name || 'Sequence ' + String(project.counters.sequence).padStart(2, '0'),
    parent: opts.parent ?? null,
    label: 'Forest',
    settings: {
      width: opts.width || 1920,
      height: opts.height || 1080,
      fps: opts.fps || 30,
      sampleRate: 48000,
      par: 1,
    },
    videoTracks: [],
    audioTracks: [],
    captions: [], // {id, start, end (frames), text}
    captionStyle: { font: 'Arial', size: 46, color: '#ffffff', bg: '#000000', bgOpacity: 70, position: 'bottom' },
    markers: [],
    inPoint: null,
    outPoint: null,
    workArea: null,
    playhead: 0,
    masterVolume: 0,
    patch: { video: 0, audio: 0 }, // source patching (track index)
    view: { zoom: 2, scroll: 0, vScroll: 0, aScroll: 0, split: 0.5 },
    markers_seq: undefined,
  };
  delete seq.markers_seq;
  const nv = opts.videoTracks ?? 3, na = opts.audioTracks ?? 3;
  for (let i = 0; i < nv; i++) seq.videoTracks.push(createTrack('video', i));
  for (let i = 0; i < na; i++) seq.audioTracks.push(createTrack('audio', i));
  return seq;
}

// ---- Effects ----

export function defaultParamValue(pd, ctx = {}) {
  const d = typeof pd.default === 'function' ? pd.default(ctx) : pd.default;
  return deepClone(d);
}

export function createEffect(type, ctx = {}) {
  const def = getEffectDef(type);
  if (!def) throw new Error('Unknown effect ' + type);
  const params = {};
  for (const pd of def.params) {
    if (pd.type === 'group' || pd.type === 'button' || pd.type === 'mask-tools') continue;
    params[pd.id] = { v: defaultParamValue(pd, ctx), kf: null };
  }
  return { id: uid('fx_'), type, enabled: true, params, masks: [], expanded: !def.intrinsic };
}

export function createTransition(type, opts = {}) {
  const def = getTransitionDef(type);
  const params = {};
  if (def) for (const pd of def.params || []) params[pd.id] = { v: defaultParamValue(pd), kf: null };
  return Object.assign({ id: uid('tr_'), type, clipA: null, clipB: null, dur: 30, offset: 15, params }, opts);
}

export function createMask(shape, w, h) {
  const cx = w / 2, cy = h / 2;
  let pts;
  if (shape === 'ellipse') {
    const rx = w * 0.2, ry = h * 0.25;
    pts = [[cx, cy - ry], [cx + rx, cy], [cx, cy + ry], [cx - rx, cy]];
  } else if (shape === 'rect') {
    const rx = w * 0.2, ry = h * 0.25;
    pts = [[cx - rx, cy - ry], [cx + rx, cy - ry], [cx + rx, cy + ry], [cx - rx, cy + ry]];
  } else pts = [];
  return {
    id: uid('msk_'),
    name: 'Mask',
    shape, // ellipse | rect | bezier
    path: { v: pts, kf: null },
    closed: shape !== 'bezier' || pts.length > 2,
    feather: { v: 10, kf: null },
    opacity: { v: 100, kf: null },
    expansion: { v: 0, kf: null },
    inverted: false,
    mode: 'add',
  };
}

export function intrinsicEffectsFor(kind, ctx) {
  if (kind === 'video') return [createEffect('motion', ctx), createEffect('opacity', ctx), createEffect('timeRemap', ctx)];
  return [createEffect('volume', ctx), createEffect('channelVolume', ctx), createEffect('panner', ctx)];
}

// ---- Clips ----

export function sourceSize(project, clip) {
  if (clip.graphic || clip.itemId == null) return null;
  const item = findItem(project, clip.itemId);
  if (!item) return null;
  if (item.type === 'sequence') return { w: item.settings.width, h: item.settings.height };
  return { w: item.width || 1920, h: item.height || 1080 };
}

export function createClip(props) {
  return Object.assign(
    {
      id: uid('clp_'),
      itemId: null,
      kind: 'video', // video | audio
      name: 'Clip',
      start: 0,
      dur: 30,
      in: 0,
      speed: 1,
      reverse: false,
      linkId: null,
      groupId: null,
      enabled: true,
      label: 'Iris',
      gain: 0,
      frameHold: null,
      effects: [],
      markers: [],
      graphic: null,
      scaleToFrame: false,
    },
    props,
  );
}

export function clipEnd(c) {
  return c.start + c.dur;
}

export function findItem(project, id) {
  if (!project || id == null) return null;
  return project.items.find((i) => i.id === id) || null;
}

export function sequences(project) {
  return project.items.filter((i) => i.type === 'sequence');
}

export function allTracks(seq) {
  return [...seq.videoTracks, ...seq.audioTracks];
}

export function findTrack(seq, trackId) {
  return allTracks(seq).find((t) => t.id === trackId) || null;
}

export function findClip(seq, clipId) {
  for (const t of seq.videoTracks) {
    const c = t.clips.find((c) => c.id === clipId);
    if (c) return { clip: c, track: t, kind: 'video', index: seq.videoTracks.indexOf(t) };
  }
  for (const t of seq.audioTracks) {
    const c = t.clips.find((c) => c.id === clipId);
    if (c) return { clip: c, track: t, kind: 'audio', index: seq.audioTracks.indexOf(t) };
  }
  return null;
}

export function allClips(seq) {
  const out = [];
  for (const t of allTracks(seq)) for (const c of t.clips) out.push(c);
  return out;
}

export function seqDuration(seq) {
  let end = 0;
  for (const t of allTracks(seq)) for (const c of t.clips) end = Math.max(end, c.start + c.dur);
  for (const cap of seq.captions || []) end = Math.max(end, cap.end);
  return end;
}

export function clipAtFrame(track, frame) {
  for (const c of track.clips) if (frame >= c.start && frame < c.start + c.dur) return c;
  return null;
}

export function sortClips(track) {
  track.clips.sort((a, b) => a.start - b.start);
}

export function linkedClips(seq, clip) {
  if (!clip.linkId) return [clip];
  return allClips(seq).filter((c) => c.linkId === clip.linkId);
}

export function groupedClips(seq, clip) {
  if (!clip.groupId) return [clip];
  return allClips(seq).filter((c) => c.groupId === clip.groupId);
}

// Clip "keyframe time": seconds in source-time base so keyframes stay attached to content.
export function clipKfTime(clip, frame, fps) {
  return clip.in + ((frame - clip.start) / fps) * clip.speed;
}
export function kfTimeToFrame(clip, t, fps) {
  return clip.start + ((t - clip.in) / clip.speed) * fps;
}

// ---- Time Remapping (speed ramps) ----
const remapCache = new Map();
export function timeRemapParam(clip) {
  const fx = clip.effects && clip.effects.find((e) => e.type === 'timeRemap');
  if (!fx || fx.enabled === false) return null;
  const p = fx.params.speed;
  return p && p.kf && p.kf.length ? p : null;
}
// Source seconds advanced (before clip.speed) after `local` timeline seconds of a remapped clip.
export function remapIntegral(clip, p, local, fps) {
  const dt = 1 / 120;
  const key = clip.id + '|' + clip.in + '|' + clip.speed + '|' + JSON.stringify(p.kf);
  let e = remapCache.get(clip.id);
  const total = Math.max(0, local) + 1;
  if (!e || e.key !== key || e.len < total) {
    const len = Math.max(total, clip.dur / fps + 2);
    const n = Math.ceil(len / dt) + 2;
    const table = new Float64Array(n);
    let prev = Math.max(0, evalParam(p, clip.in) / 100);
    for (let i = 1; i < n; i++) {
      const sp = Math.max(0, evalParam(p, clip.in + i * dt * clip.speed) / 100);
      table[i] = table[i - 1] + ((prev + sp) / 2) * dt;
      prev = sp;
    }
    e = { key, table, len };
    remapCache.set(clip.id, e);
    if (remapCache.size > 200) remapCache.delete(remapCache.keys().next().value);
  }
  const x = local / dt;
  if (x <= 0) return (local * Math.max(0, evalParam(p, clip.in))) / 100;
  const i = Math.min(e.table.length - 2, Math.floor(x));
  const f = x - i;
  return e.table[i] + (e.table[i + 1] - e.table[i]) * f;
}

// Source media time for a timeline frame (may extend into handles for transitions).
export function clipSourceTime(clip, frame, fps, mediaDur) {
  if (clip.frameHold != null) return clip.frameHold;
  const rp = timeRemapParam(clip);
  if (rp) {
    const t = clip.in + remapIntegral(clip, rp, (frame - clip.start) / fps, fps);
    return mediaDur && mediaDur > 0 ? clamp(t, 0, Math.max(0, mediaDur - 0.001)) : Math.max(0, t);
  }
  const local = ((frame - clip.start) / fps) * clip.speed;
  let t;
  if (clip.reverse) t = clip.in + (clip.dur / fps) * clip.speed - local - (1 / fps) * clip.speed;
  else t = clip.in + local;
  if (mediaDur && mediaDur > 0) t = clamp(t, 0, Math.max(0, mediaDur - 0.001));
  else t = Math.max(0, t);
  return t;
}

export function getClipEffect(clip, type) {
  return clip.effects.find((e) => e.type === type) || null;
}

export function paramValue(effect, pid, kfTime) {
  const def = getEffectDef(effect.type);
  const pd = def?.params.find((p) => p.id === pid);
  return evalParam(effect.params[pid], kfTime, pd);
}

export function evalEffectParams(effect, kfTime) {
  const def = getEffectDef(effect.type);
  const out = {};
  if (!def) return out;
  for (const pd of def.params) {
    if (!(pd.id in effect.params)) continue;
    out[pd.id] = evalParam(effect.params[pd.id], kfTime, pd);
  }
  return out;
}

// Max source length in seconds for an item (Infinity for stills/synthetic/graphics).
export function itemSourceDuration(project, item) {
  if (!item) return Infinity;
  if (item.type === 'sequence') return Math.max(1, seqDuration(item)) / item.settings.fps;
  if (item.type === 'media') return item.kind === 'image' ? Infinity : item.duration || Infinity;
  if (item.type === 'synthetic') return item.kind === 'leader' ? item.duration : Infinity;
  return Infinity;
}

export function clipSourceDuration(project, clip) {
  if (clip.graphic) return Infinity;
  return itemSourceDuration(project, findItem(project, clip.itemId));
}

// Validate transitions after edits: remove ones whose clips moved apart.
export function validateTransitions(seq) {
  for (const t of allTracks(seq)) {
    t.transitions = t.transitions.filter((tr) => {
      const a = tr.clipA ? t.clips.find((c) => c.id === tr.clipA) : null;
      const b = tr.clipB ? t.clips.find((c) => c.id === tr.clipB) : null;
      if (tr.clipA && !a) return false;
      if (tr.clipB && !b) return false;
      if (!a && !b) return false;
      if (a && b && a.start + a.dur !== b.start) return false;
      const maxDur = Math.max(1, Math.min(a ? a.dur : Infinity, b ? b.dur : Infinity) * (a && b ? 2 : 1));
      tr.dur = clamp(tr.dur, 1, maxDur);
      tr.offset = clamp(tr.offset, 0, tr.dur);
      if (!a) tr.offset = 0;
      if (!b) tr.offset = tr.dur;
      return true;
    });
  }
}

export function transitionRange(track, tr) {
  const a = tr.clipA ? track.clips.find((c) => c.id === tr.clipA) : null;
  const b = tr.clipB ? track.clips.find((c) => c.id === tr.clipB) : null;
  const edit = a ? a.start + a.dur : b ? b.start : 0;
  const start = edit - tr.offset;
  return { start, end: start + tr.dur, edit, a, b };
}

export function trackDisplayName(t) {
  return t.customName || t.name;
}

export function renumberTracks(seq) {
  seq.videoTracks.forEach((t, i) => (t.name = 'V' + (i + 1)));
  seq.audioTracks.forEach((t, i) => (t.name = 'A' + (i + 1)));
}

export function isAdjustmentClip(project, clip) {
  if (!clip.itemId) return false;
  const it = findItem(project, clip.itemId);
  return it?.type === 'synthetic' && it.kind === 'adjustment';
}
