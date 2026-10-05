// End-to-end smoke test (headless Chromium via Playwright).
// Usage: node test/smoke.mjs [--shots dir]
import { startServer } from './server.mjs';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let pw;
try {
  pw = require('playwright');
} catch (e) {
  pw = require('/opt/node22/lib/node_modules/playwright');
}
const { chromium } = pw;

const shotsArg = process.argv.indexOf('--shots');
const SHOTS = shotsArg > 0 ? process.argv[shotsArg + 1] : null;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const server = await startServer(0);
const port = server.address().port;
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
const errors = [];
page.on('console', (m) => {
  if ((m.type() === 'error' || m.type() === 'warning') && !/ERR_CERT|fonts\.g|Failed to load resource/.test(m.text())) errors.push(m.type() + ': ' + m.text());
});
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message + '\n' + e.stack));

let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
  if (!ok) failures++;
};
const shot = async (name) => SHOTS && page.screenshot({ path: path.join(SHOTS, name + '.png') });

await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForFunction(() => window.__ve && window.__ve.app);
await page.waitForTimeout(800);
// dismiss start screen
await page.evaluate(() => document.querySelector('.start-screen')?.remove());

// ---------- registry counts ----------
const counts = await page.evaluate(async () => {
  const { registry } = await import('/src/core/registry.js');
  return { ve: [...registry.videoEffects.values()].filter((d) => !d.intrinsic).length, vt: registry.videoTransitions.size, ae: [...registry.audioEffects.values()].filter((d) => !d.intrinsic).length, at: registry.audioTransitions.size };
});
console.log('Registry:', JSON.stringify(counts));

// ---------- import ----------
const imported = await page.evaluate(async () => {
  const { importFiles } = await import('/src/core/media.js');
  const get = async (n, t) => new File([await (await fetch('/test/fixtures/' + n)).blob()], n, { type: t });
  const files = [await get('clip1.webm', 'video/webm'), await get('clip2.webm', 'video/webm'), await get('image.png', 'image/png'), await get('tone.wav', 'audio/wav')];
  const items = await importFiles(files);
  return items.map((i) => ({ name: i.name, kind: i.kind, dur: i.duration, w: i.width, h: i.height, audio: i.hasAudio, fps: i.fps }));
});
console.log('Imported:', JSON.stringify(imported));
check('import 4 media files', imported.length === 4);
check('video probed', imported[0].w === 640 && imported[0].h === 360 && Math.abs(imported[0].dur - 6) < 0.2 && imported[0].audio);
check('audio probed', imported[3].kind === 'audio' && Math.abs(imported[3].dur - 3) < 0.1);

// ---------- new sequence from clip, place items ----------
const seqInfo = await page.evaluate(async () => {
  const { app, actions } = window.__ve;
  const items = app.project.items.filter((i) => i.type === 'media');
  const s = actions.newSequenceFromItems([items[0]]);
  actions.placeItems([items[1]], 180, { vTrack: 0, aTrack: 0 });
  actions.placeItems([items[2]], 90, { vTrack: 1, aTrack: null });
  actions.placeItems([items[3]], 0, { vTrack: null, aTrack: 1 });
  return { w: s.settings.width, h: s.settings.height, fps: s.settings.fps, v: s.videoTracks.map((t) => t.clips.map((c) => [c.start, c.dur])), a: s.audioTracks.map((t) => t.clips.map((c) => [c.start, c.dur])) };
});
console.log('Sequence:', JSON.stringify(seqInfo));
check('sequence matches clip settings', seqInfo.w === 640 && seqInfo.h === 360 && Math.abs(seqInfo.fps - 30) < 0.1);
check('clips placed with linked audio', seqInfo.v[0].length === 2 && seqInfo.a[0].length === 2 && seqInfo.a[1].length === 1);

// ---------- render a frame & check pixels ----------
const pix = await page.evaluate(async () => {
  const { app } = window.__ve;
  const comp = app.services.compositor;
  await comp.prepare(app.seq, 30);
  const cv = comp.renderFrame(app.seq, 30, { scale: 0.5 });
  const c = document.createElement('canvas');
  c.width = cv.width;
  c.height = cv.height;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(cv, 0, 0);
  const d = x.getImageData(0, 0, c.width, c.height).data;
  let sum = 0;
  for (let i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] + d[i + 2];
  return { avg: sum / (d.length / 4) / 3, err: comp.lastError ? String(comp.lastError) : null };
});
check('compositor renders video frame', pix.avg > 20 && !pix.err, JSON.stringify(pix));
await shot('01-imported');

// ---------- edit operations ----------
const edits = await page.evaluate(() => {
  const { app, E } = window.__ve;
  const s = app.seq;
  const v1 = s.videoTracks[0];
  const out = {};
  const c0 = v1.clips[0];
  app.edit('Razor', () => E.razorAt(s, c0.id, 60, {}));
  out.afterRazor = v1.clips.length;
  out.audioAfterRazor = s.audioTracks[0].clips.length;
  const second = v1.clips[1];
  app.edit('Ripple Delete', () => E.deleteClips(s, [second.id, ...s.audioTracks[0].clips.filter((c) => c.linkId === second.linkId).map((c) => c.id)], true));
  out.afterRipple = v1.clips.map((c) => [c.start, c.dur]);
  app.edit('Trim', () => E.trimEdge(s, [v1.clips[0].id], 'out', -10, {}));
  out.afterTrim = v1.clips[0].dur;
  app.edit('Transition', () => E.applyTransition(s, v1, v1.clips[0], 'out', 'crossDissolve', 20));
  out.transitions = v1.transitions.length;
  out.undo1 = app.history.undo();
  out.transitionsAfterUndo = v1 === s.videoTracks[0] ? app.seq.videoTracks[0].transitions.length : -1;
  out.redo1 = app.history.redo();
  out.transitionsAfterRedo = app.seq.videoTracks[0].transitions.length;
  return out;
});
console.log('Edits:', JSON.stringify(edits));
check('razor splits linked clips', edits.afterRazor === 3 && edits.audioAfterRazor === 3);
check('ripple delete closes gap', edits.afterRipple.length === 2 && edits.afterRipple[1][0] === 60, JSON.stringify(edits.afterRipple));
check('undo/redo transition', edits.transitionsAfterUndo === 0 && edits.transitionsAfterRedo === 1);

// ---------- effects ----------
const fx = await page.evaluate(async () => {
  const { app, actions } = window.__ve;
  const { registry } = await import('/src/core/registry.js');
  const s = app.seq;
  const clip = s.videoTracks[0].clips[0];
  const comp = app.services.compositor;
  const failed = [];
  for (const def of registry.videoEffects.values()) {
    if (def.intrinsic) continue;
    app.selectClips([clip.id]);
    actions.applyEffect(def.id, [clip.id]);
    comp.lastError = null;
    await comp.prepare(s, 10);
    comp.renderFrame(s, 10, { scale: 0.25 });
    if (comp.lastError) failed.push(def.id + ': ' + comp.lastError.message);
    const c = app.seq.videoTracks[0].clips[0];
    c.effects = c.effects.filter((e) => e.type === 'motion' || e.type === 'opacity' || e.type === 'timeRemap');
  }
  // transitions
  const v1 = app.seq.videoTracks[0];
  const trFailed = [];
  const tr = v1.transitions[0];
  for (const def of registry.videoTransitions.values()) {
    tr.type = def.id;
    tr.params = {};
    for (const pd of def.params) tr.params[pd.id] = { v: typeof pd.default === 'function' ? pd.default({}) : pd.default, kf: null };
    comp.lastError = null;
    const f = v1.clips[0].start + v1.clips[0].dur - 5;
    await comp.prepare(app.seq, f);
    comp.renderFrame(app.seq, f, { scale: 0.25 });
    if (comp.lastError) trFailed.push(def.id + ': ' + comp.lastError.message);
  }
  tr.type = 'crossDissolve';
  return { failed, trFailed };
});
check('all video effects compile & render', fx.failed.length === 0, fx.failed.join(' | '));
check('all video transitions compile & render', fx.trFailed.length === 0, fx.trFailed.join(' | '));

// ---------- masks, blend modes, keyframes, nest, graphics ----------
const misc = await page.evaluate(async () => {
  const { app, actions, E } = window.__ve;
  const s = app.seq;
  const comp = app.services.compositor;
  const clip = s.videoTracks[0].clips[0];
  const op = clip.effects.find((e) => e.type === 'opacity');
  actions.addMask(clip.id, op.id, 'ellipse');
  op.params.blendMode.v = 3;
  const m = clip.effects.find((e) => e.type === 'motion');
  m.params.scale.kf = [{ t: clip.in, v: 50, interp: 'linear' }, { t: clip.in + 1, v: 100, interp: 'bezier' }];
  comp.lastError = null;
  await comp.prepare(s, 15);
  comp.renderFrame(s, 15, { scale: 0.5 });
  const err1 = comp.lastError ? String(comp.lastError) : null;
  // graphics
  app.setPlayhead(10);
  const g = actions.newTextLayer();
  comp.lastError = null;
  comp.renderFrame(s, 12, { scale: 0.5 });
  const err2 = comp.lastError ? String(comp.lastError) : null;
  // nest
  app.selectClips([s.videoTracks[0].clips[0].id]);
  const nested = app.edit('Nest', () => E.nestClips(s, [s.videoTracks[0].clips[0].id], 'Nest Test'));
  comp.lastError = null;
  await comp.prepare(s, 20);
  comp.renderFrame(s, 20, { scale: 0.5 });
  const err3 = comp.lastError ? String(comp.lastError) : null;
  // lumetri on adjustment layer
  const adj = actions.newSynthetic('adjustment');
  actions.placeItems([adj], 0, { vTrack: 3, aTrack: null });
  const adjClip = app.seq.videoTracks[3].clips[0];
  actions.applyEffect('lumetri', [adjClip.id]);
  const lfx = adjClip.effects.find((e) => e.type === 'lumetri');
  lfx.params.look.v = 8;
  lfx.params.curves.v.master = [[0, 0], [0.5, 0.6], [1, 1]];
  lfx.params.hslOn.v = true;
  lfx.params.vigAmount.v = -2;
  comp.lastError = null;
  comp.renderFrame(s, 20, { scale: 0.5 });
  const err4 = comp.lastError ? String(comp.lastError) : null;
  return { err1, err2, err3, err4, graphic: !!g, nested: !!nested };
});
check('mask + blend + keyframes render', !misc.err1, misc.err1);
check('text graphic renders', misc.graphic && !misc.err2, misc.err2);
check('nested sequence renders', misc.nested && !misc.err3, misc.err3);
check('adjustment layer lumetri renders', !misc.err4, misc.err4);
await page.evaluate(() => window.__ve.app.bus.emit('project:changed', {}));
await page.waitForTimeout(400);
await shot('02-effects');

// ---------- audio offline mix ----------
const mix = await page.evaluate(async () => {
  const { app } = window.__ve;
  const { audio } = await import('/src/engine/audioEngine.js');
  const buf = await audio.renderOffline(app.seq, 0, 3, 48000);
  let peak = 0;
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
  return { len: buf.length, peak };
});
check('offline audio mix has signal', mix.len === 144000 && mix.peak > 0.05, JSON.stringify(mix));

// ---------- playback ----------
const play = await page.evaluate(async () => {
  const { app } = window.__ve;
  const { playback } = await import('/src/engine/playback.js');
  app.setPlayhead(0);
  playback.play(1);
  await new Promise((r) => setTimeout(r, 1500));
  const f = app.seq.playhead;
  playback.stop();
  return { f };
});
check('playback advances playhead', play.f > 15, JSON.stringify(play));

// ---------- export ----------
const exp = await page.evaluate(async () => {
  const { app, exporter } = window.__ve;
  const s = app.seq;
  const blob = await exporter.run(s, { format: 'vp9', width: 320, height: 180, mbps: 1, audio: true, captions: false, range: [0, 30] }, () => {}, () => false);
  const wav = await exporter.run(s, { format: 'wav', range: [0, 30] }, () => {}, () => false);
  return { size: blob ? blob.size : 0, type: blob ? blob.type : null, wav: wav ? wav.size : 0 };
});
check('WebM/VP9 export produces file', exp.size > 1000, JSON.stringify(exp));
check('WAV export produces file', exp.wav > 1000);


// ---------- scene edit detection ----------
const scenes = await page.evaluate(async () => {
  const { app, actions } = window.__ve;
  const { importFiles } = await import('/src/core/media.js');
  const f = new File([await (await fetch('/test/fixtures/scenes.webm')).blob()], 'scenes.webm', { type: 'video/webm' });
  const [it] = await importFiles([f]);
  const s = actions.createSequence({ name: 'Scenes', width: 320, height: 180, fps: 30 });
  const placed = actions.placeItems([it], 0, { vTrack: 0, aTrack: null });
  app.selectClips([placed[0].id]);
  await actions.sceneEditDetection([placed[0].id], { cut: true, markers: true, sensitivity: 50 });
  return { cuts: s.videoTracks[0].clips.map((c) => c.start), markers: s.markers.map((m) => m.frame) };
});
check('scene edit detection finds 2 cuts', scenes.cuts.length === 3 && Math.abs(scenes.cuts[1] - 45) <= 1 && Math.abs(scenes.cuts[2] - 90) <= 1, JSON.stringify(scenes));

// ---------- persistence ----------
const saved = await page.evaluate(async () => {
  const { persist, app } = window.__ve;
  await persist.saveNow(false);
  const list = await persist.listProjects();
  return list.some((p) => p.id === app.project.id);
});
check('project saved to IndexedDB', saved);

// ---------- UI interactions ----------
await page.keyboard.press('Shift+3');
await page.keyboard.press('Home');
await page.keyboard.press('ArrowRight');
await page.keyboard.press('ArrowRight');
const ph = await page.evaluate(() => window.__ve.app.seq.playhead);
check('keyboard stepping', ph === 2, 'playhead=' + ph);
await page.keyboard.press('KeyC');
const tool = await page.evaluate(() => window.__ve.app.tool);
check('razor tool shortcut (C)', tool === 'razor');
await page.keyboard.press('KeyV');
for (const ws of ['Color', 'Effects', 'Audio', 'Graphics', 'Captions', 'Assembly', 'Editing']) {
  await page.evaluate((w) => window.__ve.app.services.layout.load(w), ws);
  await page.waitForTimeout(300);
  await shot('ws-' + ws);
}
await page.evaluate(() => window.__ve.app.services.layout.load('Editing'));
await page.waitForTimeout(300);
await shot('03-final');

const reload = await page.evaluate(() => window.__ve.app.project.id);
await page.reload();
await page.waitForFunction(() => window.__ve && window.__ve.app);
await page.waitForTimeout(2500);
const after = await page.evaluate(() => ({ id: window.__ve.app.project.id, media: window.__ve.app.project.items.filter((i) => i.type === 'media').map((i) => !i.offline) }));
check('project restored after reload with media', after.id === reload && after.media.length === 5 && after.media.every(Boolean), JSON.stringify(after));

console.log('\nConsole errors:', errors.length ? '\n' + errors.join('\n') : 'none');
if (errors.length) failures++;
await browser.close();
server.close();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
