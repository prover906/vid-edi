// Export: WebCodecs (H.264/VP9/VP8/AV1) muxed to MP4/WebM, WAV audio, MediaRecorder fallback.

import { app } from '../core/app.js';
import { h, clamp, downloadBlob, fmtBytes, sleep } from '../core/util.js';
import { framesToTC, fpsLabel } from '../core/timecode.js';
import { seqDuration } from '../core/model.js';
import { modal, row } from '../ui/dialogs.js';
import { dropdown, checkbox } from '../ui/widgets.js';
import { audio } from './audioEngine.js';
import { playback } from './playback.js';

export const FORMATS = [
  { id: 'h264', label: 'H.264 (MP4)', container: 'mp4', vcodec: 'avc', codecStrings: ['avc1.640033', 'avc1.640028', 'avc1.4d0028', 'avc1.42e01f'], acodec: ['aac', 'opus'], ext: 'mp4', mime: 'video/mp4' },
  { id: 'hevc', label: 'HEVC (H.265, MP4)', container: 'mp4', vcodec: 'hevc', codecStrings: ['hev1.1.6.L120.B0', 'hvc1.1.6.L120.90'], acodec: ['aac', 'opus'], ext: 'mp4', mime: 'video/mp4' },
  { id: 'av1', label: 'AV1 (MP4)', container: 'mp4', vcodec: 'av1', codecStrings: ['av01.0.08M.08', 'av01.0.04M.08'], acodec: ['opus', 'aac'], ext: 'mp4', mime: 'video/mp4' },
  { id: 'vp9', label: 'VP9 (WebM)', container: 'webm', vcodec: 'V_VP9', codecStrings: ['vp09.00.40.08', 'vp09.00.10.08'], acodec: ['opus'], ext: 'webm', mime: 'video/webm' },
  { id: 'vp8', label: 'VP8 (WebM)', container: 'webm', vcodec: 'V_VP8', codecStrings: ['vp8'], acodec: ['opus'], ext: 'webm', mime: 'video/webm' },
  { id: 'wav', label: 'Waveform Audio (WAV)', audioOnly: true, ext: 'wav', mime: 'audio/wav' },
  { id: 'png', label: 'PNG (current frame)', still: true, ext: 'png', mime: 'image/png' },
  { id: 'rec', label: 'WebM (real-time MediaRecorder)', realtime: true, ext: 'webm', mime: 'video/webm' },
];

export const PRESETS = [
  { name: 'Match Source - High bitrate', w: null, h: null, mbps: null },
  { name: 'YouTube 1080p Full HD', w: 1920, h: 1080, mbps: 16 },
  { name: 'YouTube 2160p 4K Ultra HD', w: 3840, h: 2160, mbps: 45 },
  { name: 'YouTube 720p HD', w: 1280, h: 720, mbps: 8 },
  { name: 'Vimeo 1080p Full HD', w: 1920, h: 1080, mbps: 20 },
  { name: 'Twitter / X 720p', w: 1280, h: 720, mbps: 6 },
  { name: 'Social Vertical 1080x1920', w: 1080, h: 1920, mbps: 12 },
  { name: 'Social Square 1080x1080', w: 1080, h: 1080, mbps: 10 },
  { name: 'Low Bitrate Preview 540p', w: 960, h: 540, mbps: 2.5 },
];

async function pickCodec(fmt, w, hgt, fps, bitrate) {
  if (!('VideoEncoder' in window)) return null;
  for (const codec of fmt.codecStrings) {
    const cfg = { codec, width: w, height: hgt, bitrate, framerate: fps };
    if (fmt.vcodec === 'avc') cfg.avc = { format: 'avc' };
    try {
      const r = await VideoEncoder.isConfigSupported(cfg);
      if (r.supported) return r.config;
    } catch (e) {
      /* next */
    }
  }
  return null;
}
async function pickAudio(fmt, sampleRate) {
  if (!('AudioEncoder' in window)) return null;
  for (const a of fmt.acodec) {
    const cfg = { codec: a === 'aac' ? 'mp4a.40.2' : 'opus', sampleRate, numberOfChannels: 2, bitrate: 192000 };
    try {
      const r = await AudioEncoder.isConfigSupported(cfg);
      if (r.supported) return { cfg: r.config, name: a };
    } catch (e) {
      /* next */
    }
  }
  return null;
}

export function encodeWav(buffer) {
  const ch = buffer.numberOfChannels, sr = buffer.sampleRate, n = buffer.length;
  const out = new ArrayBuffer(44 + n * ch * 2);
  const v = new DataView(out);
  const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF');
  v.setUint32(4, 36 + n * ch * 2, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, ch, true);
  v.setUint32(24, sr, true);
  v.setUint32(28, sr * ch * 2, true);
  v.setUint16(32, ch * 2, true);
  v.setUint16(34, 16, true);
  w(36, 'data');
  v.setUint32(40, n * ch * 2, true);
  const data = [];
  for (let c = 0; c < ch; c++) data.push(buffer.getChannelData(c));
  let o = 44;
  for (let i = 0; i < n; i++)
    for (let c = 0; c < ch; c++) {
      const s = clamp(data[c][i], -1, 1);
      v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      o += 2;
    }
  return new Blob([out], { type: 'audio/wav' });
}

function even(n) {
  n = Math.max(2, Math.round(n));
  return n % 2 ? n + 1 : n;
}

export const exporter = {
  busy: false,

  open(defaults = {}) {
    const seq = app.seq;
    if (!seq) return app.toast('Open a sequence to export', 'warn');
    playback.stop();
    const fps = seq.settings.fps;
    const st = {
      name: seq.name,
      format: defaults.format || 'h264',
      preset: 0,
      width: seq.settings.width,
      height: seq.settings.height,
      mbps: Math.round((seq.settings.width * seq.settings.height * fps * 0.18) / 1e6 * 10) / 10 || 10,
      range: seq.inPoint != null || seq.outPoint != null ? 'inout' : 'all',
      captions: false,
      audio: true,
      audioKbps: 192,
    };
    const nameIn = h('input', { type: 'text', value: st.name, style: { width: '100%' } });
    const wIn = h('input', { type: 'number', value: st.width, style: { width: '66px' } });
    const hIn = h('input', { type: 'number', value: st.height, style: { width: '66px' } });
    const brIn = h('input', { type: 'number', value: st.mbps, step: 0.5, min: 0.5, style: { width: '74px' } });
    const summary = h('div.exp-summary');
    const preview = h('canvas', { width: 640, height: 360 });
    const scrub = h('input', { type: 'range', min: 0, max: Math.max(1, seqDuration(seq) - 1), value: seq.playhead, style: { width: '100%' } });
    const status = h('div.muted.tiny', '');
    const progress = h('div.progress', h('div'));
    progress.style.visibility = 'hidden';
    const rangeOf = () => {
      const dur = seqDuration(seq);
      if (st.range === 'inout') return [seq.inPoint ?? 0, seq.outPoint != null ? seq.outPoint + 1 : dur];
      return [0, dur];
    };
    const updateSummary = async () => {
      const fmt = FORMATS.find((f) => f.id === st.format);
      const [a, b] = rangeOf();
      const secs = (b - a) / fps;
      const sizeEst = fmt.audioOnly ? secs * 48000 * 4 : (st.mbps * 1e6 * secs) / 8 + (st.audio ? (st.audioKbps * 1000 * secs) / 8 : 0);
      let codecNote = '';
      if (!fmt.audioOnly && !fmt.still && !fmt.realtime) {
        const ok = await pickCodec(fmt, even(st.width), even(st.height), fps, st.mbps * 1e6);
        codecNote = ok ? ' ✓ supported by this browser' : ' ✗ not supported by this browser — choose another format';
      }
      summary.innerHTML = '';
      summary.append(
        h('div', h('b', 'Output: '), `${st.name}.${fmt.ext}`),
        fmt.audioOnly ? h('div', '48000 Hz, Stereo, 16 bit') : h('div', `${even(st.width)}x${even(st.height)} (1.0), ${fpsLabel(fps)}, ${fmt.still ? 'PNG' : st.mbps + ' Mbps'}`),
        h('div', fmt.label + codecNote),
        !fmt.audioOnly && !fmt.still ? h('div', st.audio ? `Audio: ${fmt.container === 'webm' ? 'Opus' : 'AAC'} ${st.audioKbps} kbps, 48 kHz Stereo` : 'Audio: none') : '',
        h('div', h('b', 'Source: '), `${seq.name}, ${seq.settings.width}x${seq.settings.height}, ${fpsLabel(fps)}`),
        h('div', h('b', 'Range: '), `${framesToTC(a, fps)} – ${framesToTC(b, fps)} (${framesToTC(b - a, fps)})`),
        h('div', h('b', 'Estimated file size: '), fmtBytes(sizeEst)),
      );
    };
    const drawPreview = async (f) => {
      const comp = app.services.compositor;
      await comp.prepare(seq, f);
      const cv = comp.renderFrame(seq, f, { scale: Math.min(1, 640 / seq.settings.width), scopes: false, captions: st.captions ? true : false });
      const c = preview.getContext('2d');
      const s = Math.min(640 / cv.width, 360 / cv.height);
      c.fillStyle = '#000';
      c.fillRect(0, 0, 640, 360);
      c.drawImage(cv, (640 - cv.width * s) / 2, (360 - cv.height * s) / 2, cv.width * s, cv.height * s);
    };
    scrub.addEventListener('input', () => drawPreview(+scrub.value));
    const fmtDd = dropdown({ options: FORMATS.map((f) => ({ label: f.label, value: f.id })), value: st.format, onChange: (v) => { st.format = v; updateSummary(); } });
    const presetDd = dropdown({
      options: PRESETS.map((p, i) => ({ label: p.name, value: i })),
      value: 0,
      onChange: (i) => {
        const p = PRESETS[i];
        st.preset = i;
        st.width = p.w || seq.settings.width;
        st.height = p.h || seq.settings.height;
        if (p.mbps) st.mbps = p.mbps;
        wIn.value = st.width;
        hIn.value = st.height;
        brIn.value = st.mbps;
        updateSummary();
      },
    });
    const rangeDd = dropdown({ options: [{ label: 'Entire Source', value: 'all' }, { label: 'Source In/Out', value: 'inout' }], value: st.range, onChange: (v) => { st.range = v; updateSummary(); } });
    for (const [el, k] of [[wIn, 'width'], [hIn, 'height'], [brIn, 'mbps']]) el.addEventListener('change', () => { st[k] = parseFloat(el.value) || st[k]; updateSummary(); });
    nameIn.addEventListener('input', () => { st.name = nameIn.value; updateSummary(); });
    const settings = h('div.exp-settings',
      row('File Name', nameIn),
      row('Preset', presetDd.el),
      row('Format', fmtDd.el),
      h('div.fieldset', h('div.legend', 'Video'), row('Frame Size', h('span', { style: { whiteSpace: 'nowrap' } }, wIn, ' × ', hIn)), row('Frame Rate', h('span', fpsLabel(fps))), row('Target Bitrate (Mbps)', brIn)),
      h('div.fieldset', h('div.legend', 'Audio'), h('div', checkbox({ checked: st.audio, label: 'Export Audio', onChange: (v) => { st.audio = v; updateSummary(); } }).el), row('Sample Rate', h('span', '48000 Hz'))),
      h('div.fieldset', h('div.legend', 'Captions'), checkbox({ checked: st.captions, label: 'Burn Captions Into Video', onChange: (v) => { st.captions = v; drawPreview(+scrub.value); } }).el),
      row('Range', rangeDd.el),
      summary,
    );
    const body = h('div.exp-grid', h('div.exp-preview', preview, h('div', { style: { padding: '6px 8px' } }, scrub)), h('div', settings, h('div', { style: { marginTop: '10px' } }, progress, status)));
    let cancel = null;
    const dlg = modal({
      title: 'Export Settings',
      width: 1040,
      body,
      footLeft: 'Encoding happens locally in your browser.',
      buttons: [
        { label: 'Cancel', action: () => { if (cancel) { cancel(); return false; } } },
        {
          label: 'Export',
          cta: true,
          action: async () => {
            if (this.busy) return false;
            const btn = dlg.buttons[1];
            btn.disabled = true;
            progress.style.visibility = 'visible';
            let cancelled = false;
            cancel = () => (cancelled = true);
            const t0 = performance.now();
            try {
              const blob = await this.run(seq, { ...st, range: rangeOf() }, (p, msg) => {
                progress.firstChild.style.width = Math.round(p * 100) + '%';
                const el = (performance.now() - t0) / 1000;
                const eta = p > 0.02 ? (el / p) * (1 - p) : 0;
                status.textContent = (msg || 'Encoding…') + `  ${Math.round(p * 100)}%  ·  elapsed ${el.toFixed(0)}s` + (eta ? `  ·  remaining ~${eta.toFixed(0)}s` : '');
              }, () => cancelled);
              if (blob) {
                const fmt = FORMATS.find((f) => f.id === st.format);
                downloadBlob(blob, `${st.name || 'export'}.${fmt.ext}`);
                app.toast(`Export complete: ${fmtBytes(blob.size)}`, 'ok', 4000);
                dlg.close();
                return;
              }
              status.textContent = 'Export cancelled.';
            } catch (e) {
              console.error(e);
              status.textContent = 'Export failed: ' + e.message;
              app.toast('Export failed: ' + e.message, 'error', 6000);
            } finally {
              cancel = null;
              btn.disabled = false;
            }
            return false;
          },
        },
      ],
    });
    updateSummary();
    drawPreview(seq.playhead);
    // Pick the first format the browser can actually encode.
    if (!defaults.format) {
      (async () => {
        for (const id of ['h264', 'vp9', 'av1', 'vp8']) {
          const f = FORMATS.find((x) => x.id === id);
          if (await pickCodec(f, even(st.width), even(st.height), fps, st.mbps * 1e6)) {
            if (st.format !== id) {
              st.format = id;
              fmtDd.set(id);
              updateSummary();
            }
            return;
          }
        }
        st.format = 'rec';
        fmtDd.set('rec');
        updateSummary();
      })();
    }
  },

  async run(seq, st, onProgress, isCancelled) {
    const fmt = FORMATS.find((f) => f.id === st.format);
    const fps = seq.settings.fps;
    const [f0, f1] = st.range;
    if (f1 <= f0) throw new Error('Nothing to export (empty range)');
    this.busy = true;
    app.exporting = true;
    try {
      if (fmt.audioOnly) {
        onProgress(0.1, 'Mixing audio…');
        const buf = await audio.renderOffline(seq, f0 / fps, f1 / fps, 48000);
        onProgress(1, 'Done');
        return encodeWav(buf);
      }
      if (fmt.still) {
        const comp = app.services.compositor;
        await comp.prepare(seq, seq.playhead);
        const cv = this.outputCanvas(comp.renderFrame(seq, seq.playhead, { scale: Math.min(1, st.width / seq.settings.width), captions: st.captions, scopes: false }), st);
        return await new Promise((r) => cv.toBlob(r, 'image/png'));
      }
      if (fmt.realtime) return await this.runRealtime(seq, st, onProgress, isCancelled);
      return await this.runWebCodecs(seq, fmt, st, onProgress, isCancelled);
    } finally {
      this.busy = false;
      app.exporting = false;
      app.bus.emit('time:changed', { seq });
    }
  },

  outputCanvas(src, st) {
    const W = even(st.width), H = even(st.height);
    if (!this._out) this._out = document.createElement('canvas');
    const cv = this._out;
    if (cv.width !== W) cv.width = W;
    if (cv.height !== H) cv.height = H;
    const c = cv.getContext('2d');
    c.fillStyle = '#000';
    c.fillRect(0, 0, W, H);
    const s = Math.min(W / src.width, H / src.height);
    c.imageSmoothingQuality = 'high';
    c.drawImage(src, (W - src.width * s) / 2, (H - src.height * s) / 2, src.width * s, src.height * s);
    return cv;
  },

  async runWebCodecs(seq, fmt, st, onProgress, isCancelled) {
    if (!('VideoEncoder' in window)) throw new Error('WebCodecs is not available in this browser. Choose "WebM (real-time MediaRecorder)".');
    const fps = seq.settings.fps;
    const [f0, f1] = st.range;
    const W = even(st.width), H = even(st.height);
    const bitrate = Math.round(st.mbps * 1e6);
    const vcfg = await pickCodec(fmt, W, H, fps, bitrate);
    if (!vcfg) throw new Error(fmt.label + ' encoding is not supported by this browser at ' + W + 'x' + H + '. Try VP9 (WebM) or a smaller frame size.');
    const acfg = st.audio ? await pickAudio(fmt, 48000) : null;
    const lib = fmt.container === 'mp4' ? await import('../../vendor/mp4-muxer.mjs') : await import('../../vendor/webm-muxer.mjs');
    const target = new lib.ArrayBufferTarget();
    const muxOpts = { target, video: { codec: fmt.vcodec, width: W, height: H, frameRate: fps } };
    if (fmt.container === 'mp4') muxOpts.fastStart = 'in-memory';
    if (acfg) muxOpts.audio = { codec: fmt.container === 'mp4' ? acfg.name : 'A_OPUS', sampleRate: 48000, numberOfChannels: 2 };
    const muxer = new lib.Muxer(muxOpts);
    let encErr = null;
    const venc = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => (encErr = e) });
    venc.configure({ ...vcfg, latencyMode: 'quality' });
    // audio
    if (acfg) {
      onProgress(0.01, 'Mixing audio…');
      const buf = await audio.renderOffline(seq, f0 / fps, f1 / fps, 48000);
      const aenc = new AudioEncoder({ output: (chunk, meta) => muxer.addAudioChunk(chunk, meta), error: (e) => (encErr = e) });
      aenc.configure(acfg.cfg);
      const L = buf.getChannelData(0), R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
      const block = 4800;
      for (let i = 0; i < buf.length; i += block) {
        const n = Math.min(block, buf.length - i);
        const data = new Float32Array(n * 2);
        data.set(L.subarray(i, i + n), 0);
        data.set(R.subarray(i, i + n), n);
        const ad = new AudioData({ format: 'f32-planar', sampleRate: 48000, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round((i / 48000) * 1e6), data });
        aenc.encode(ad);
        ad.close();
      }
      await aenc.flush();
      aenc.close();
    }
    const comp = app.services.compositor;
    const scale = Math.min(1, Math.max(W / seq.settings.width, H / seq.settings.height));
    const total = f1 - f0;
    const gop = Math.max(1, Math.round(fps * 2));
    for (let f = f0; f < f1; f++) {
      if (isCancelled()) {
        venc.close();
        return null;
      }
      if (encErr) throw encErr;
      await comp.prepare(seq, f);
      const cv = comp.renderFrame(seq, f, { scale, captions: st.captions, scopes: false });
      const out = this.outputCanvas(cv, st);
      const vf = new VideoFrame(out, { timestamp: Math.round(((f - f0) / fps) * 1e6), duration: Math.round(1e6 / fps) });
      venc.encode(vf, { keyFrame: (f - f0) % gop === 0 });
      vf.close();
      while (venc.encodeQueueSize > 6) await sleep(2);
      if ((f - f0) % 5 === 0) {
        onProgress(0.03 + 0.95 * ((f - f0) / total), `Encoding frame ${f - f0 + 1} / ${total}`);
        await sleep(0);
      }
    }
    await venc.flush();
    venc.close();
    if (encErr) throw encErr;
    muxer.finalize();
    onProgress(1, 'Done');
    return new Blob([target.buffer], { type: fmt.mime });
  },

  async runRealtime(seq, st, onProgress, isCancelled) {
    const fps = seq.settings.fps;
    const [f0, f1] = st.range;
    const comp = app.services.compositor;
    const ctx = audio.ensure();
    const W = even(st.width), H = even(st.height);
    const cv = document.createElement('canvas');
    cv.width = W;
    cv.height = H;
    const stream = cv.captureStream(fps);
    const dest = ctx.createMediaStreamDestination();
    if (st.audio) {
      const buf = await audio.renderOffline(seq, f0 / fps, f1 / fps, ctx.sampleRate);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(dest);
      this._rtSrc = src;
      dest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
    }
    const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m));
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: st.mbps * 1e6 });
    const chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const done = new Promise((r) => (rec.onstop = r));
    await comp.prepare(seq, f0);
    rec.start(250);
    const startT = ctx.currentTime + 0.1;
    if (this._rtSrc) this._rtSrc.start(startT);
    const c2 = cv.getContext('2d');
    await new Promise((resolve) => {
      const tick = () => {
        if (isCancelled()) return resolve();
        const t = Math.max(0, ctx.currentTime - startT);
        const f = f0 + Math.floor(t * fps);
        if (f >= f1) return resolve();
        comp.syncPlayback(seq, f, 1);
        const frame = comp.renderFrame(seq, f, { scale: Math.min(1, W / seq.settings.width), captions: st.captions, scopes: false });
        const s = Math.min(W / frame.width, H / frame.height);
        c2.fillStyle = '#000';
        c2.fillRect(0, 0, W, H);
        c2.drawImage(frame, (W - frame.width * s) / 2, (H - frame.height * s) / 2, frame.width * s, frame.height * s);
        onProgress((f - f0) / (f1 - f0), 'Recording in real time…');
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    comp.stopPlayback();
    try {
      this._rtSrc && this._rtSrc.stop();
    } catch (e) {
      /* ignore */
    }
    this._rtSrc = null;
    rec.stop();
    await done;
    if (isCancelled()) return null;
    onProgress(1, 'Done');
    return new Blob(chunks, { type: 'video/webm' });
  },
};
