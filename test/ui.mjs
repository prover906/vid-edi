// UI interaction test: drives real mouse/keyboard events against the editor.
// Usage: node test/ui.mjs [--shots dir]
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
  if ((m.type() === 'error' || m.type() === 'warning') && !/ERR_CERT|fonts\.g|Failed to load resource|willReadFrequently|GPU stall/.test(m.text())) errors.push(m.type() + ': ' + m.text());
});
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message + '\n' + e.stack));
let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
  if (!ok) failures++;
};
const shot = async (name) => SHOTS && page.screenshot({ path: path.join(SHOTS, name + '.png') });
const ev = (fn, arg) => page.evaluate(fn, arg);

await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForFunction(() => window.__ve && window.__ve.app);
await page.waitForTimeout(600);
await page.getByText('Open Sample Project').click();
await page.waitForTimeout(800);
await ev(async () => {
  const { importFiles } = await import('/src/core/media.js');
  const get = async (n, t) => new File([await (await fetch('/test/fixtures/' + n)).blob()], n, { type: t });
  await importFiles([await get('clip1.webm', 'video/webm')]);
});
await page.waitForTimeout(500);

// geometry helpers from the timeline panel
const tl = async () =>
  ev(() => {
    const t = window.__ve.timeline;
    const r = t.canvas.getBoundingClientRect();
    const rows = t.trackRows().filter((x) => !x.mix).map((x) => ({ kind: x.kind, index: x.index, y: x.y, h: x.h }));
    return { left: r.left, top: r.top, zoom: t.view.zoom, scroll: t.view.scroll, rows };
  });
const fx = (g, f) => g.left + (f - g.scroll) * g.zoom;
const rowY = (g, kind, index) => {
  const r = g.rows.find((x) => x.kind === kind && x.index === index);
  return g.top + r.y + r.h / 2;
};

// 1. Drag project item into timeline at frame 400 on V1 (empty area after sample clips)
let g = await tl();
await ev(() => {
  const t = window.__ve.timeline;
  t.view.zoom = 1.5;
  t.view.scroll = 0;
  t.requestDraw();
});
g = await tl();
const row = page.locator('.proj-row', { hasText: 'clip1.webm' });
await row.dragTo(page.locator('.tl-canvas'), { targetPosition: { x: Math.round((420 - g.scroll) * g.zoom), y: Math.round(rowY(g, 'video', 0) - g.top) } });
await page.waitForTimeout(400);
const placed = await ev(() => {
  const s = window.__ve.app.seq;
  const c = s.videoTracks[0].clips.find((x) => x.name === 'clip1.webm');
  const a = s.audioTracks[0].clips.find((x) => x.name === 'clip1.webm');
  return c ? { start: c.start, dur: c.dur, audio: !!a, linked: a && a.linkId === c.linkId } : null;
});
check('drag from Project to Timeline places linked clip', placed && Math.abs(placed.start - 420) <= 12 && placed.audio && placed.linked, JSON.stringify(placed));
await shot('ui-01-dropped');
await ev(() => {
  const t = window.__ve.timeline;
  t.view.scroll = 300;
  t.requestDraw();
});
await page.waitForTimeout(100);

// 2. Move the clip by dragging its body 30 frames right
g = await tl();
const c0 = await ev(() => window.__ve.app.seq.videoTracks[0].clips.find((x) => x.name === 'clip1.webm'));
let x0 = fx(g, c0.start + c0.dur / 2), y0 = rowY(g, 'video', 0);
await page.mouse.move(x0, y0);
await page.mouse.down();
await page.mouse.move(x0 + 20, y0, { steps: 4 });
await page.mouse.move(x0 + 60, y0, { steps: 4 });
await page.mouse.up();
const moved = await ev(() => window.__ve.app.seq.videoTracks[0].clips.find((x) => x.name === 'clip1.webm').start);
check('drag clip moves it', moved === c0.start + Math.round(60 / g.zoom), `from ${c0.start} to ${moved}`);

// 3. Trim the out edge 20 frames left
g = await tl();
const c1 = await ev(() => window.__ve.app.seq.videoTracks[0].clips.find((x) => x.name === 'clip1.webm'));
x0 = fx(g, c1.start + c1.dur) - 2;
await page.mouse.move(x0, y0);
await page.mouse.down();
await page.mouse.move(x0 - 20, y0, { steps: 3 });
await page.mouse.move(x0 - 40, y0, { steps: 3 });
await page.mouse.up();
const trimmed = await ev(() => {
  const s = window.__ve.app.seq;
  const v = s.videoTracks[0].clips.find((x) => x.name === 'clip1.webm');
  const a = s.audioTracks[0].clips.find((x) => x.linkId === v.linkId);
  return { v: v.dur, a: a.dur };
});
check('trim out edge (linked audio follows)', trimmed.v < c1.dur && trimmed.v === trimmed.a, JSON.stringify({ before: c1.dur, ...trimmed }));

// 4. Razor tool click
await page.keyboard.press('KeyC');
g = await tl();
const c2 = await ev(() => window.__ve.app.seq.videoTracks[0].clips.find((x) => x.name === 'clip1.webm'));
await page.mouse.click(fx(g, c2.start + 40), y0);
const nAfter = await ev(() => window.__ve.app.seq.videoTracks[0].clips.filter((x) => x.name === 'clip1.webm').length);
check('razor tool splits clip', nAfter === 2);
await page.keyboard.press('KeyV');
// undo via keyboard
await page.keyboard.press('Control+KeyZ');
const nUndo = await ev(() => window.__ve.app.seq.videoTracks[0].clips.filter((x) => x.name === 'clip1.webm').length);
check('Ctrl+Z undoes razor', nUndo === 1);

// 5. Source monitor: open, mark in/out, insert with ','
await page.locator('.proj-row', { hasText: 'clip1.webm' }).dblclick();
await page.waitForTimeout(700);
await ev(() => {
  const sm = window.__ve.sourceMonitor;
  sm.seekFrame(30);
});
await page.keyboard.press('KeyI');
await ev(() => window.__ve.sourceMonitor.seekFrame(89));
await page.keyboard.press('KeyO');
const marks = await ev(() => {
  const it = window.__ve.app.project.items.find((i) => i.name === 'clip1.webm');
  return [it.inPoint, it.outPoint];
});
check('source monitor In/Out marks', Math.abs(marks[0] - 1) < 0.01 && Math.abs(marks[1] - 3) < 0.01, JSON.stringify(marks));
await ev(() => window.__ve.app.setPlayhead(0));
const before = await ev(() => window.__ve.app.seq.videoTracks[0].clips.length);
await page.keyboard.press('Comma');
const ins = await ev(() => {
  const s = window.__ve.app.seq;
  return { n: s.videoTracks[0].clips.length, first: s.videoTracks[0].clips[0].name, dur: s.videoTracks[0].clips[0].dur, ph: s.playhead };
});
check('insert edit from source (,)', ins.n === before + 1 && ins.first === 'clip1.webm' && ins.dur === 60 && ins.ph === 60, JSON.stringify(ins));
await shot('ui-02-insert');

// 6. Effect Controls: select clip, scrub Scale hot text
await ev(() => {
  const s = window.__ve.app.seq;
  window.__ve.app.selectClips([s.videoTracks[0].clips[0].id]);
  window.__ve.app.services.layout.activate('effectControls');
  window.__ve.app.setPlayhead(10);
});
await page.waitForTimeout(300);
await page.locator('.ec-fxname', { hasText: 'Motion' }).locator('.ec-tw').click();
await page.waitForTimeout(200);
const scaleHot = page.locator('.ec-row', { hasText: 'Scale' }).first().locator('.hot').first();
const bb = await scaleHot.boundingBox();
await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
await page.mouse.down();
await page.mouse.move(bb.x + bb.width / 2 - 30, bb.y + bb.height / 2, { steps: 5 });
await page.mouse.up();
const scale = await ev(() => window.__ve.app.seq.videoTracks[0].clips[0].effects.find((e) => e.type === 'motion').params.scale.v);
check('Effect Controls hot-text scrub changes Scale', scale < 100 && scale > 50, 'scale=' + scale);
await shot('ui-03-ec');

// 7. Stopwatch: enable animation, move playhead, change value → 2 keyframes
await page.locator('.ec-row', { hasText: 'Scale' }).first().locator('.ec-sw').click();
await ev(() => window.__ve.app.setPlayhead(40));
await page.waitForTimeout(150);
const hot2 = page.locator('.ec-row', { hasText: 'Scale' }).first().locator('.hot').first();
await hot2.click();
await page.keyboard.press('Control+A');
await page.keyboard.type('120');
await page.keyboard.press('Enter');
const kfs = await ev(() => window.__ve.app.seq.videoTracks[0].clips[0].effects.find((e) => e.type === 'motion').params.scale.kf);
check('stopwatch keyframing', kfs && kfs.length === 2 && kfs[1].v === 120, JSON.stringify(kfs));

// 8. Program monitor: drag inside selected clip box moves Position
await ev(() => window.__ve.app.services.layout.load('Editing'));
await page.waitForTimeout(400);
const pos0 = await ev(() => window.__ve.app.seq.videoTracks[0].clips[0].effects.find((e) => e.type === 'motion').params.position.v.slice());
const ov = await page.locator('.mon-root.program .mon-overlay').boundingBox();
await page.mouse.move(ov.x + ov.width / 2, ov.y + ov.height / 2);
await page.mouse.down();
await page.mouse.move(ov.x + ov.width / 2 + 40, ov.y + ov.height / 2 + 20, { steps: 5 });
await page.mouse.up();
const pos1 = await ev(() => window.__ve.app.seq.videoTracks[0].clips[0].effects.find((e) => e.type === 'motion').params.position.v.slice());
check('program monitor direct manipulation moves clip', pos1[0] > pos0[0] && pos1[1] > pos0[1], JSON.stringify([pos0, pos1]));
await shot('ui-04-direct');

// 9. Apply transition with Ctrl+D at an edit point
await ev(() => {
  const s = window.__ve.app.seq;
  s.videoTracks.forEach((t, i) => (t.target = i === 0));
  window.__ve.app.setPlayhead(s.videoTracks[0].clips[0].start + s.videoTracks[0].clips[0].dur);
});
await page.locator('.tl-canvas').click({ position: { x: 5, y: 5 } });
await page.keyboard.press('Control+KeyD');
const trs = await ev(() => window.__ve.app.seq.videoTracks[0].transitions.length);
check('Ctrl+D applies default transition', trs >= 3, 'transitions=' + trs);

// 10. Menus: open File menu and click New Sequence dialog then cancel
await page.locator('.mb-item', { hasText: 'Sequence' }).click();
await page.waitForTimeout(150);
const menuOk = await page.locator('.ctx-menu .ctx-item', { hasText: 'Add Edit' }).count();
check('menubar opens', menuOk > 0);
await page.keyboard.press('Escape');
await page.keyboard.press('Control+KeyN');
await page.waitForTimeout(200);
const dlg = await page.locator('.modal-title', { hasText: 'New Sequence' }).count();
check('Ctrl+N opens New Sequence dialog', dlg === 1);
await shot('ui-05-newseq');
await page.keyboard.press('Escape');

// 11. Keyboard shortcuts dialog
await page.keyboard.press('Control+Alt+KeyK');
await page.waitForTimeout(250);
check('keyboard shortcuts dialog', (await page.locator('.kb-keyboard').count()) === 1);
await shot('ui-06-keyboard');
await page.keyboard.press('Escape');

// 12. Export dialog opens
await page.keyboard.press('Control+KeyM');
await page.waitForTimeout(600);
check('export dialog', (await page.locator('.modal-title', { hasText: 'Export Settings' }).count()) === 1);
await shot('ui-07-export');
await page.keyboard.press('Escape');

// 13. Lumetri panel adds effect when a slider moves
await ev(() => {
  window.__ve.app.services.layout.load('Color');
  const s = window.__ve.app.seq;
  window.__ve.app.selectClips([s.videoTracks[0].clips[0].id]);
});
await page.waitForTimeout(400);
const rng = page.locator('.lu-row', { hasText: 'Exposure' }).locator('input[type=range]');
const rb = await rng.boundingBox();
await page.mouse.click(rb.x + rb.width * 0.8, rb.y + rb.height / 2);
const lum = await ev(() => window.__ve.app.seq.videoTracks[0].clips[0].effects.find((e) => e.type === 'lumetri'));
check('Lumetri slider adds Lumetri Color effect', !!lum && lum.params.exposure.v > 0, lum ? 'exposure=' + lum.params.exposure.v : 'none');
await shot('ui-08-lumetri');
await ev(() => window.__ve.app.services.layout.load('Editing'));


// 14. Type tool: click program monitor creates text graphic + inline editor
await ev(() => window.__ve.app.setPlayhead(30));
await page.keyboard.press('KeyT');
const pv = await page.locator('.mon-root.program .mon-overlay').boundingBox();
await page.mouse.click(pv.x + pv.width * 0.5, pv.y + pv.height * 0.3);
await page.waitForTimeout(300);
const editor = await page.locator('.mon-textedit').count();
check('Type tool opens inline text editor', editor === 1);
if (editor) {
  await page.keyboard.type('Hello Premiere');
  await page.locator('.tl-canvas').click({ position: { x: 3, y: 3 } });
}
await page.waitForTimeout(200);
const txt = await ev(() => {
  const s = window.__ve.app.seq;
  for (const t of s.videoTracks) for (const c of t.clips) if (c.graphic) for (const l of c.graphic.layers) if (l.text === 'Hello Premiere') return true;
  return false;
});
check('typed text stored in graphic layer', txt);
await page.keyboard.press('KeyV');
await shot('ui-09-text');

// 15. Drag effect from Effects panel onto a timeline clip
await ev(() => {
  const app = window.__ve.app;
  app.services.layout.activate('effects');
  const t = window.__ve.timeline;
  t.view.zoom = 1.5;
  t.view.scroll = 0;
  t.requestDraw();
});
await page.locator('.fx-tree .fx-folder.top', { hasText: 'Video Effects' }).first().click().catch(() => {});
await page.waitForTimeout(150);
await ev(() => {
  // open all folders for test
  document.querySelectorAll('.fx-folder.sub').forEach(() => {});
});
await page.locator('.fx-top input[type=search]').fill('Gaussian');
await page.waitForTimeout(150);
g = await tl();
const firstV = await ev(() => window.__ve.app.seq.videoTracks[0].clips[0]);
await page.locator('.fx-item', { hasText: 'Gaussian Blur' }).dragTo(page.locator('.tl-canvas'), { targetPosition: { x: Math.round((firstV.start + firstV.dur / 2 - g.scroll) * g.zoom), y: Math.round(rowY(g, 'video', 0) - g.top) } });
await page.waitForTimeout(200);
const hasBlur = await ev(() => window.__ve.app.seq.videoTracks[0].clips[0].effects.some((e) => e.type === 'gaussianBlur'));
check('drag effect from Effects panel onto clip', hasBlur);

// 16. Drag transition onto an edit point
await page.locator('.fx-top input[type=search]').fill('Iris Round');
await page.waitForTimeout(150);
g = await tl();
const edit = await ev(() => {
  const v = window.__ve.app.seq.videoTracks[0].clips;
  return v[1].start;
});
const before16 = await ev(() => window.__ve.app.seq.videoTracks[0].transitions.length);
await page.locator('.fx-item', { hasText: 'Iris Round' }).dragTo(page.locator('.tl-canvas'), { targetPosition: { x: Math.round((edit - g.scroll) * g.zoom) + 3, y: Math.round(rowY(g, 'video', 0) - g.top) } });
await page.waitForTimeout(200);
const tr16 = await ev(() => window.__ve.app.seq.videoTracks[0].transitions.map((t) => t.type));
check('drag transition onto edit point', tr16.includes('irisRound'), JSON.stringify(tr16) + ' before=' + before16);
await page.locator('.fx-top input[type=search]').fill('');

// 17. Gap selection + ripple delete with Delete key
const gap = await ev(() => {
  const s = window.__ve.app.seq;
  const v = s.videoTracks[0].clips.slice().sort((a, b) => a.start - b.start);
  for (let i = 1; i < v.length; i++) if (v[i].start > v[i - 1].start + v[i - 1].dur) return { a: v[i - 1].start + v[i - 1].dur, b: v[i].start, id: v[i].id };
  return null;
});
if (gap) {
  await ev(() => {
    const t = window.__ve.timeline;
    t.view.zoom = 1;
    t.view.scroll = 0;
    t.requestDraw();
  });
  g = await tl();
  await page.mouse.click(fx(g, (gap.a + gap.b) / 2), rowY(g, 'video', 0));
  await page.keyboard.press('Delete');
  const after17 = await ev((id) => {
    const s = window.__ve.app.seq;
    return s.videoTracks[0].clips.find((c) => c.id === id).start;
  }, gap.id);
  check('select gap + Delete ripples', after17 === gap.a, `${gap.b} -> ${after17} (expected ${gap.a})`);
} else check('gap present for ripple test', false);

// 18. Captions: add caption and render
await ev(() => window.__ve.app.setPlayhead(20));
const capOk = await ev(async () => {
  const { captions } = await import('/src/core/captions.js');
  captions.addAtPlayhead('Subtitle test');
  const comp = window.__ve.app.services.compositor;
  comp.lastError = null;
  comp.renderFrame(window.__ve.app.seq, 25, { scale: 0.5 });
  return window.__ve.app.seq.captions.length >= 2 && !comp.lastError;
});
check('captions add + render', capOk);
await ev(() => window.__ve.app.services.layout.load('Captions'));
await page.waitForTimeout(400);
await shot('ui-10-captions');
await ev(() => window.__ve.app.services.layout.load('Editing'));

console.log('\nConsole errors:', errors.length ? '\n' + errors.join('\n') : 'none');
if (errors.length) failures++;
await browser.close();
server.close();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
