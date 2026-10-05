// Program playback clock (audio-driven when possible), shuttle (J/K/L), looping.

import { app } from '../core/app.js';
import { seqDuration } from '../core/model.js';
import { audio } from './audioEngine.js';

export const playback = {
  playing: false,
  rate: 0,
  raf: 0,
  startSec: 0,
  t0: 0,
  endFrame: 0,
  loopFrom: null,
  stopAt: null,
  returnTo: null,

  play(rate = 1, opts = {}) {
    const seq = app.seq;
    if (!seq) return;
    const fps = seq.settings.fps;
    const dur = seqDuration(seq);
    let from = opts.from ?? seq.playhead;
    let end = opts.to ?? dur;
    if (opts.inOut && seq.inPoint != null) {
      from = seq.inPoint;
      end = seq.outPoint != null ? seq.outPoint + 1 : dur;
    }
    if (!opts.inOut && rate > 0 && from >= dur - 1 && opts.from == null) from = 0;
    if (app.prefs.loopPlayback && seq.inPoint != null && seq.outPoint != null && !opts.to) {
      this.loopFrom = seq.inPoint;
      end = seq.outPoint + 1;
      if (from < seq.inPoint || from >= end) from = seq.inPoint;
    } else this.loopFrom = app.prefs.loopPlayback ? 0 : null;
    this.stop(true);
    this.playing = true;
    this.rate = rate;
    this.endFrame = Math.max(end, from + 1);
    this.stopAt = opts.to ?? null;
    this.returnTo = opts.returnTo ?? null;
    this.startPlayback(from);
    app.bus.emit('playback:state', { playing: true, rate });
  },

  startPlayback(fromFrame) {
    const seq = app.seq;
    const fps = seq.settings.fps;
    this.startSec = fromFrame / fps;
    this.t0 = performance.now();
    if (fromFrame !== seq.playhead) app.setPlayhead(fromFrame, { source: 'playback' });
    audio.stop();
    if (this.rate > 0 && this.rate <= 4) {
      audio.start(seq, this.startSec, this.rate, this.endFrame / fps + 0.5);
      this.useAudioClock = true;
    } else this.useAudioClock = false;
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(() => this.tick());
  },

  tick() {
    if (!this.playing) return;
    const seq = app.seq;
    if (!seq) return this.stop();
    const fps = seq.settings.fps;
    let sec;
    const ac = this.useAudioClock ? audio.clock() : null;
    if (ac != null) sec = ac;
    else sec = this.startSec + ((performance.now() - this.t0) / 1000) * this.rate;
    let frame = Math.floor(sec * fps + 1e-4);
    if (this.rate > 0 && frame >= this.endFrame) {
      if (this.loopFrom != null && this.stopAt == null) {
        this.startPlayback(this.loopFrom);
        return;
      }
      app.setPlayhead(this.returnTo ?? Math.max(0, this.endFrame - (this.stopAt != null ? 0 : 0)), { source: 'playback' });
      this.stop();
      return;
    }
    if (this.rate < 0 && frame <= 0) {
      app.setPlayhead(0, { source: 'playback' });
      this.stop();
      return;
    }
    app.setPlayhead(frame, { source: 'playback' });
    this.raf = requestAnimationFrame(() => this.tick());
  },

  stop(silent = false) {
    const was = this.playing;
    this.playing = false;
    this.rate = 0;
    cancelAnimationFrame(this.raf);
    audio.stop();
    app.services.compositor?.stopPlayback();
    if (was && !silent) {
      app.bus.emit('playback:state', { playing: false });
      app.bus.emit('time:changed', { seq: app.seq, frame: app.seq?.playhead, source: 'stop' });
    }
  },

  toggle() {
    if (this.playing) this.stop();
    else this.play(1);
  },

  shuttle(dir) {
    const rates = [1, 2, 4, 8];
    if (!this.playing || Math.sign(this.rate) !== dir) {
      this.play(dir);
      return;
    }
    const idx = rates.indexOf(Math.abs(this.rate));
    const next = rates[Math.min(rates.length - 1, idx + 1)] * dir;
    const seq = app.seq;
    this.rate = next;
    this.startPlayback(seq.playhead);
    app.bus.emit('playback:state', { playing: true, rate: next });
  },

  playAround() {
    const seq = app.seq;
    if (!seq) return;
    const fps = seq.settings.fps;
    const ph = seq.playhead;
    this.play(1, { from: Math.max(0, ph - Math.round(app.prefs.preroll * fps)), to: ph + Math.round(app.prefs.postroll * fps), returnTo: ph });
  },
};
