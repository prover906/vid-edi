// Media source management: pooled <video> elements per clip, decoded images.

import { app } from '../core/app.js';

const MAX_VIDEOS = 20;

export class SourcePool {
  constructor() {
    this.videos = new Map(); // key -> entry
    this.images = new Map(); // itemId -> {bitmap, loading}
  }

  videoEntry(key, item) {
    let e = this.videos.get(key);
    const rt = app.rt(item.id);
    if (e && e.url !== rt.url) {
      this.dispose(key);
      e = null;
    }
    if (!e) {
      if (!rt.url) return null;
      const el = document.createElement('video');
      el.muted = true;
      el.playsInline = true;
      el.preload = 'auto';
      el.crossOrigin = 'anonymous';
      el.src = rt.url;
      e = { key, el, itemId: item.id, url: rt.url, lastUsed: performance.now(), seekPromise: null, target: -1, ready: false };
      el.addEventListener('loadeddata', () => {
        e.ready = true;
        app.bus.emit('media:frame');
      });
      el.addEventListener('seeked', () => app.bus.emit('media:frame'));
      el.addEventListener('error', () => {
        e.error = true;
      });
      this.videos.set(key, e);
      this.evict();
    }
    e.lastUsed = performance.now();
    return e;
  }

  dispose(key) {
    const e = this.videos.get(key);
    if (!e) return;
    try {
      e.el.pause();
      e.el.removeAttribute('src');
      e.el.load();
    } catch (err) {
      /* ignore */
    }
    this.videos.delete(key);
  }

  evict() {
    if (this.videos.size <= MAX_VIDEOS) return;
    const arr = [...this.videos.values()].filter((e) => e.el.paused).sort((a, b) => a.lastUsed - b.lastUsed);
    while (this.videos.size > MAX_VIDEOS && arr.length) this.dispose(arr.shift().key);
  }

  disposeItem(itemId) {
    for (const [k, e] of [...this.videos]) if (e.itemId === itemId) this.dispose(k);
    this.images.delete(itemId);
  }

  // Seek so the displayed frame matches time t. Resolves when ready.
  seek(e, t, tolerance = 0.002) {
    const el = e.el;
    if (e.error) return Promise.resolve();
    const dur = isFinite(el.duration) ? el.duration : Infinity;
    t = Math.max(0, Math.min(t, dur - 0.0005));
    if (el.readyState >= 2 && Math.abs(el.currentTime - t) <= tolerance && !el.seeking) return Promise.resolve();
    e.target = t;
    if (e.seekPromise && Math.abs(e.seekTarget - t) <= tolerance) return e.seekPromise;
    e.seekTarget = t;
    e.seekPromise = new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        el.removeEventListener('seeked', onSeeked);
        el.removeEventListener('loadeddata', onLoaded);
        clearTimeout(timer);
        if (e.seekTarget === t) e.seekPromise = null;
        resolve();
      };
      const onSeeked = () => {
        if (el.readyState >= 2) finish();
        else el.addEventListener('loadeddata', finish, { once: true });
      };
      const onLoaded = () => {
        if (Math.abs(el.currentTime - t) > tolerance) el.currentTime = t;
        else finish();
      };
      const timer = setTimeout(finish, 2500);
      el.addEventListener('seeked', onSeeked);
      if (el.readyState < 1) {
        el.addEventListener('loadedmetadata', () => (el.currentTime = t), { once: true });
        el.addEventListener('loadeddata', onLoaded);
      } else el.currentTime = t;
    });
    return e.seekPromise;
  }

  image(item) {
    let e = this.images.get(item.id);
    const rt = app.rt(item.id);
    if (e && e.url === rt.url) return e.ready ? e.img : null;
    if (!rt.url) return null;
    const img = new Image();
    e = { img, url: rt.url, ready: false };
    this.images.set(item.id, e);
    img.onload = () => {
      e.ready = true;
      app.bus.emit('media:frame');
    };
    img.src = rt.url;
    return null;
  }

  pauseAll(exceptKeys) {
    for (const e of this.videos.values()) {
      if (exceptKeys && exceptKeys.has(e.key)) continue;
      if (!e.el.paused) e.el.pause();
    }
  }
}

export const sources = new SourcePool();
