// Media import: probing, audio decoding, peaks, thumbnails.

import { app } from './app.js';
import { createMediaItem, findItem } from './model.js';
import { fileExt, sleep } from './util.js';
import { snapFps } from './timecode.js';
import { audio, computePeaks } from '../engine/audioEngine.js';

const VIDEO_EXT = ['mp4', 'm4v', 'mov', 'webm', 'mkv', 'ogv', 'avi', '3gp'];
const AUDIO_EXT = ['mp3', 'wav', 'aac', 'm4a', 'ogg', 'oga', 'flac', 'opus', 'aif', 'aiff', 'weba'];
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif'];

export function mediaKind(file) {
  const ext = fileExt(file.name);
  if (file.type.startsWith('image/') || IMAGE_EXT.includes(ext)) return 'image';
  if (AUDIO_EXT.includes(ext) || file.type.startsWith('audio/')) return 'audio';
  if (file.type.startsWith('video/') || VIDEO_EXT.includes(ext)) return 'video';
  return null;
}

function loadVideoMeta(url) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.muted = true;
    v.playsInline = true;
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      resolve(ok ? v : null);
    };
    v.onloadedmetadata = () => finish(true);
    v.onerror = () => finish(false);
    setTimeout(() => finish(v.readyState >= 1), 15000);
    v.src = url;
  });
}

async function estimateFps(url) {
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.src = url;
  if (!('requestVideoFrameCallback' in v)) return null;
  try {
    await new Promise((res, rej) => {
      v.oncanplay = res;
      v.onerror = rej;
      setTimeout(res, 3000);
    });
    const times = [];
    const p = new Promise((resolve) => {
      const cb = (now, meta) => {
        times.push(meta.mediaTime);
        if (times.length < 16) v.requestVideoFrameCallback(cb);
        else resolve();
      };
      v.requestVideoFrameCallback(cb);
      setTimeout(resolve, 2500);
    });
    // half speed gives slow decoders time to present every frame
    v.playbackRate = 0.5;
    await v.play().catch(() => {});
    await p;
    v.pause();
    v.removeAttribute('src');
    v.load();
    const d = [];
    for (let i = 1; i < times.length; i++) {
      const x = times[i] - times[i - 1];
      if (x > 0.004) d.push(x);
    }
    if (d.length < 2) return null;
    d.sort((a, b) => a - b);
    const near = d.filter((x) => x < d[0] * 1.5);
    const avg = near.reduce((a, b) => a + b, 0) / near.length;
    return snapFps(1 / avg);
  } catch (e) {
    return null;
  }
}

function loadImage(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

export async function probeItem(item, file) {
  const rt = app.rt(item.id);
  rt.file = file;
  if (rt.url) URL.revokeObjectURL(rt.url);
  rt.url = URL.createObjectURL(file);
  item.offline = false;
  item.size = file.size;
  item.mime = file.type;
  item.lastModified = file.lastModified || 0;
  if (item.kind === 'image') {
    const img = await loadImage(rt.url);
    if (!img) throw new Error('Unsupported image: ' + file.name);
    item.width = img.naturalWidth || 1920;
    item.height = img.naturalHeight || 1080;
    item.duration = 0;
    item.hasVideo = true;
    item.hasAudio = false;
    rt.poster = makeThumb(img, img.naturalWidth, img.naturalHeight);
    return item;
  }
  if (item.kind === 'video') {
    const v = await loadVideoMeta(rt.url);
    if (!v) throw new Error('Unsupported video format: ' + file.name);
    item.duration = isFinite(v.duration) ? v.duration : 0;
    item.width = v.videoWidth;
    item.height = v.videoHeight;
    if (!item.width) {
      item.kind = 'audio';
      item.hasVideo = false;
    }
    v.removeAttribute('src');
    v.load();
    if (item.kind === 'video' && item.duration === 0) {
      // Some WebM files report Infinity until fully scanned.
      item.duration = await fixInfiniteDuration(rt.url);
    }
  }
  // audio decode
  try {
    if (file.size > 1.9 * 1024 * 1024 * 1024) throw new Error('too large to decode audio in the browser');
    let hint = item.duration || 0;
    if (item.kind === 'audio' && !hint) {
      const a = await loadVideoMeta(rt.url);
      hint = a && isFinite(a.duration) ? a.duration : 0;
    }
    const ab = await file.arrayBuffer();
    const buf = await audio.decode(ab, hint);
    rt.audioBuffer = buf;
    rt.peaks = computePeaks(buf, 200);
    item.hasAudio = buf.length > 0;
    item.audioChannels = buf.numberOfChannels;
    if (item.kind === 'audio') {
      item.duration = buf.duration;
      item.hasVideo = false;
    }
  } catch (e) {
    item.hasAudio = false;
    if (item.kind === 'audio') throw new Error('Unsupported audio format: ' + file.name);
    if (/too large/.test(e.message)) app.toast(file.name + ': audio not imported (' + e.message + ')', 'warn', 5000);
  }
  if (item.kind === 'video') {
    const fps = await estimateFps(rt.url);
    item.fps = fps || 30;
    item.fpsEstimated = !fps;
  }
  return item;
}

async function fixInfiniteDuration(url) {
  const v = document.createElement('video');
  v.muted = true;
  v.src = url;
  await new Promise((r) => {
    v.onloadedmetadata = r;
    setTimeout(r, 5000);
  });
  if (isFinite(v.duration) && v.duration > 0) return v.duration;
  return new Promise((resolve) => {
    v.ondurationchange = () => {
      if (isFinite(v.duration)) {
        resolve(v.duration);
        v.ondurationchange = null;
      }
    };
    v.currentTime = 1e9;
    setTimeout(() => resolve(isFinite(v.duration) ? v.duration : 10), 5000);
  });
}

function makeThumb(src, w, h, maxW = 192) {
  const s = Math.min(1, maxW / w);
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * s));
  c.height = Math.max(1, Math.round(h * s));
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  return c;
}

// Generate filmstrip thumbnails in the background.
const thumbQueue = [];
let thumbBusy = false;
export function queueThumbnails(item) {
  if (item.kind !== 'video') return;
  thumbQueue.push(item.id);
  runThumbQueue();
}
async function runThumbQueue() {
  if (thumbBusy) return;
  thumbBusy = true;
  while (thumbQueue.length) {
    const id = thumbQueue.shift();
    const item = findItem(app.project, id);
    if (!item || item.kind !== 'video') continue;
    try {
      await generateThumbs(item);
    } catch (e) {
      console.warn('thumbs failed', e);
    }
  }
  thumbBusy = false;
}

async function generateThumbs(item) {
  const rt = app.rt(item.id);
  if (!rt.url) return;
  const v = document.createElement('video');
  v.muted = true;
  v.preload = 'auto';
  v.src = rt.url;
  await new Promise((r) => {
    v.onloadeddata = r;
    v.onerror = r;
    setTimeout(r, 8000);
  });
  if (v.readyState < 2) return;
  const dur = item.duration || v.duration || 1;
  const count = Math.max(2, Math.min(80, Math.ceil(dur / 1.0)));
  const interval = dur / count;
  const H = 72;
  const W = Math.round((H * item.width) / Math.max(1, item.height));
  rt.thumbs = { interval, list: new Array(count).fill(null), w: W, h: H };
  const seek = (t) =>
    new Promise((r) => {
      const done = () => {
        v.removeEventListener('seeked', done);
        r();
      };
      v.addEventListener('seeked', done);
      v.currentTime = t;
      setTimeout(done, 2000);
    });
  // poster first
  await seek(Math.min(dur * 0.1, 1));
  rt.poster = makeThumb(v, item.width, item.height, 240);
  app.bus.emit('media:updated', item.id);
  for (let i = 0; i < count; i++) {
    if (!findItem(app.project, item.id)) break;
    await seek(Math.min(dur - 0.01, i * interval + interval * 0.1));
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    c.getContext('2d').drawImage(v, 0, 0, W, H);
    rt.thumbs.list[i] = c;
    if (i % 6 === 5) {
      app.bus.emit('media:updated', item.id);
      await sleep(0);
    }
  }
  v.removeAttribute('src');
  v.load();
  app.bus.emit('media:updated', item.id);
}

export function thumbAt(item, t) {
  const rt = app.rt(item.id);
  if (item.kind === 'image') return rt.poster || null;
  const th = rt.thumbs;
  if (!th) return rt.poster || null;
  const i = Math.max(0, Math.min(th.list.length - 1, Math.floor(t / th.interval)));
  for (let d = 0; d < th.list.length; d++) {
    if (th.list[i - d]) return th.list[i - d];
    if (th.list[i + d]) return th.list[i + d];
  }
  return rt.poster || null;
}

// Import a list of File objects into the project.
export async function importFiles(files, parent = null, { silent = false } = {}) {
  const added = [];
  const errors = [];
  let i = 0;
  for (const file of files) {
    i++;
    const ext = fileExt(file.name);
    if (ext === 'srt' || ext === 'vtt') {
      await app.services.captions?.importFile(file);
      continue;
    }
    if (ext === 'cube') {
      await app.services.luts?.importCube(file);
      continue;
    }
    if (ext === 'vproj') {
      await app.services.persist?.openProjectFile(file);
      return [];
    }
    const kind = mediaKind(file);
    if (!kind) {
      errors.push(file.name + ': unsupported file type');
      continue;
    }
    app.status(`Importing ${file.name} (${i}/${files.length})…`);
    const item = createMediaItem({ name: file.name, kind, parent, hasVideo: kind !== 'audio' });
    try {
      await probeItem(item, file);
    } catch (e) {
      errors.push(e.message);
      URL.revokeObjectURL(app.rt(item.id).url);
      app.runtime.delete(item.id);
      continue;
    }
    app.edit('Import', () => app.project.items.push(item));
    added.push(item);
    app.services.persist?.saveMedia(item.id, file);
    queueThumbnails(item);
  }
  app.status(added.length ? `Imported ${added.length} item${added.length > 1 ? 's' : ''}` : '');
  if (errors.length && !silent) app.toast(errors.join('\n'), 'error', 5000);
  return added;
}

// Re-establish runtime data for an item from a stored blob (project reload / relink).
export async function restoreItem(item, file) {
  try {
    await probeItem(item, file);
    queueThumbnails(item);
    app.bus.emit('media:updated', item.id);
    return true;
  } catch (e) {
    item.offline = true;
    return false;
  }
}
