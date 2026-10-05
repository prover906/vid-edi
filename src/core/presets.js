// Effect presets: built-in (Premiere-style) + user-saved presets.

import { app } from './app.js';
import { uid, deepClone, h } from './util.js';
import { createEffect, findItem, clipKfTime } from './model.js';
import { LUMETRI_PRESETS } from '../engine/lumetri.js';
import { modal, row } from '../ui/dialogs.js';
import { getEffectDef } from './registry.js';

function ctxFor(clip, seq) {
  const item = clip.itemId ? findItem(app.project, clip.itemId) : null;
  const w = item?.type === 'sequence' ? item.settings.width : item?.width || seq.settings.width;
  const hh = item?.type === 'sequence' ? item.settings.height : item?.height || seq.settings.height;
  return { w, h: hh, seqW: seq.settings.width, seqH: seq.settings.height };
}

// keyframe times relative to clip: 'in' = first second, 'out' = last second
function kfRange(clip, seq, where, sec = 1) {
  const fps = seq.settings.fps;
  const len = Math.min(clip.dur, Math.round(sec * fps));
  if (where === 'in') return [clipKfTime(clip, clip.start, fps), clipKfTime(clip, clip.start + len, fps)];
  return [clipKfTime(clip, clip.start + clip.dur - len, fps), clipKfTime(clip, clip.start + clip.dur, fps)];
}

function addFx(clip, seq, type, params = {}) {
  const fx = createEffect(type, ctxFor(clip, seq));
  for (const [k, v] of Object.entries(params)) if (fx.params[k]) fx.params[k].v = v;
  clip.effects.push(fx);
  return fx;
}

function animate(fx, pid, t0, t1, v0, v1) {
  fx.params[pid].kf = [{ t: t0, v: v0, interp: 'linear' }, { t: t1, v: v1, interp: 'linear' }];
}

function pip(corner, scaleAnim = null) {
  return (clip, seq) => {
    if (clip.kind !== 'video') return;
    const m = clip.effects.find((e) => e.type === 'motion');
    const W = seq.settings.width, H = seq.settings.height;
    const pos = { UL: [W * 0.25, H * 0.25], UR: [W * 0.75, H * 0.25], LL: [W * 0.25, H * 0.75], LR: [W * 0.75, H * 0.75] }[corner];
    const c = ctxFor(clip, seq);
    const fit = Math.min(W / c.w, H / c.h);
    m.params.position = { v: pos, kf: null };
    m.params.scale = { v: Math.round(fit * 25 * 10) / 10, kf: null };
    if (scaleAnim) {
      const [t0, t1] = kfRange(clip, seq, scaleAnim);
      animate(m, 'scale', t0, t1, scaleAnim === 'in' ? 0 : fit * 25, scaleAnim === 'in' ? fit * 25 : 0);
    }
  };
}

export const BUILTIN_PRESETS = [
  { folder: 'Bevel Edges', name: 'Bevel Edges Thick', kind: 'video', apply: (c, s) => addFx(c, s, 'bevelEdges', { thickness: 0.15 }) },
  { folder: 'Bevel Edges', name: 'Bevel Edges Thin', kind: 'video', apply: (c, s) => addFx(c, s, 'bevelEdges', { thickness: 0.04 }) },
  { folder: 'Blurs', name: 'Fast Blur In', kind: 'video', apply: (c, s) => { const f = addFx(c, s, 'gaussianBlur', { repeat: true }); const [a, b] = kfRange(c, s, 'in'); animate(f, 'blurriness', a, b, 60, 0); } },
  { folder: 'Blurs', name: 'Fast Blur Out', kind: 'video', apply: (c, s) => { const f = addFx(c, s, 'gaussianBlur', { repeat: true }); const [a, b] = kfRange(c, s, 'out'); animate(f, 'blurriness', a, b, 0, 60); } },
  { folder: 'Mosaics', name: 'Mosaic In', kind: 'video', apply: (c, s) => { const f = addFx(c, s, 'mosaic', { sharp: true }); const [a, b] = kfRange(c, s, 'in'); animate(f, 'hBlocks', a, b, 8, 1200); animate(f, 'vBlocks', a, b, 5, 700); } },
  { folder: 'Mosaics', name: 'Mosaic Out', kind: 'video', apply: (c, s) => { const f = addFx(c, s, 'mosaic', { sharp: true }); const [a, b] = kfRange(c, s, 'out'); animate(f, 'hBlocks', a, b, 1200, 8); animate(f, 'vBlocks', a, b, 700, 5); } },
  { folder: 'PiPs', name: 'PiP 25% UL', kind: 'video', apply: pip('UL') },
  { folder: 'PiPs', name: 'PiP 25% UR', kind: 'video', apply: pip('UR') },
  { folder: 'PiPs', name: 'PiP 25% LL', kind: 'video', apply: pip('LL') },
  { folder: 'PiPs', name: 'PiP 25% LR', kind: 'video', apply: pip('LR') },
  { folder: 'PiPs', name: 'PiP 25% UL Scale In', kind: 'video', apply: pip('UL', 'in') },
  { folder: 'PiPs', name: 'PiP 25% LR Scale Out', kind: 'video', apply: pip('LR', 'out') },
  { folder: 'Solarizes', name: 'Solarize In', kind: 'video', apply: (c, s) => { const f = addFx(c, s, 'solarize'); const [a, b] = kfRange(c, s, 'in'); animate(f, 'threshold', a, b, 100, 0); } },
  { folder: 'Solarizes', name: 'Solarize Out', kind: 'video', apply: (c, s) => { const f = addFx(c, s, 'solarize'); const [a, b] = kfRange(c, s, 'out'); animate(f, 'threshold', a, b, 0, 100); } },
  { folder: 'Twirls', name: 'Twirl In', kind: 'video', apply: (c, s) => { const f = addFx(c, s, 'twirl', { radius: 75 }); const [a, b] = kfRange(c, s, 'in'); animate(f, 'angle', a, b, 720, 0); } },
  { folder: 'Twirls', name: 'Twirl Out', kind: 'video', apply: (c, s) => { const f = addFx(c, s, 'twirl', { radius: 75 }); const [a, b] = kfRange(c, s, 'out'); animate(f, 'angle', a, b, 0, 720); } },
  { folder: 'Motion', name: 'Ken Burns Zoom In', kind: 'video', apply: (c, s) => { const m = c.effects.find((e) => e.type === 'motion'); const fps = s.settings.fps; const s0 = m.params.scale.v; animate(m, 'scale', clipKfTime(c, c.start, fps), clipKfTime(c, c.start + c.dur, fps), s0, s0 * 1.2); } },
  { folder: 'Motion', name: 'Ken Burns Zoom Out', kind: 'video', apply: (c, s) => { const m = c.effects.find((e) => e.type === 'motion'); const fps = s.settings.fps; const s0 = m.params.scale.v; animate(m, 'scale', clipKfTime(c, c.start, fps), clipKfTime(c, c.start + c.dur, fps), s0 * 1.2, s0); } },
  { folder: 'Motion', name: 'Fade In (Opacity)', kind: 'video', apply: (c, s) => { const o = c.effects.find((e) => e.type === 'opacity'); const [a, b] = kfRange(c, s, 'in'); animate(o, 'opacity', a, b, 0, 100); } },
  { folder: 'Motion', name: 'Fade Out (Opacity)', kind: 'video', apply: (c, s) => { const o = c.effects.find((e) => e.type === 'opacity'); const [a, b] = kfRange(c, s, 'out'); animate(o, 'opacity', a, b, 100, 0); } },
  { folder: 'Audio', name: 'Audio Fade In', kind: 'audio', apply: (c, s) => { const v = c.effects.find((e) => e.type === 'volume'); const [a, b] = kfRange(c, s, 'in'); animate(v, 'level', a, b, -60, 0); } },
  { folder: 'Audio', name: 'Audio Fade Out', kind: 'audio', apply: (c, s) => { const v = c.effects.find((e) => e.type === 'volume'); const [a, b] = kfRange(c, s, 'out'); animate(v, 'level', a, b, 0, -60); } },
  { folder: 'Audio', name: 'Telephone Voice', kind: 'audio', apply: (c, s) => { addFx(c, s, 'highpass', { cutoff: 400 }); addFx(c, s, 'lowpass', { cutoff: 3200 }); addFx(c, s, 'distortion', { amount: 8, mix: 60 }); } },
  { folder: 'Audio', name: 'Radio Voice', kind: 'audio', apply: (c, s) => { addFx(c, s, 'highpass', { cutoff: 250 }); addFx(c, s, 'lowpass', { cutoff: 5000 }); addFx(c, s, 'compressor', { threshold: -24, ratio: 6, makeup: 6 }); } },
].map((p) => ({ ...p, id: 'preset:' + p.folder + '/' + p.name }));

export const LUMETRI_BUILTIN = LUMETRI_PRESETS.map((p) => ({
  id: 'lumetri:' + p.folder + '/' + p.name,
  folder: p.folder,
  name: p.name,
  kind: 'video',
  lumetri: true,
  apply: (clip, seq) => {
    if (clip.kind !== 'video') return;
    const fx = createEffect('lumetri', ctxFor(clip, seq));
    for (const [k, v] of Object.entries(p.params)) if (fx.params[k]) fx.params[k].v = v;
    fx.label = p.name;
    clip.effects.push(fx);
  },
}));

function loadUser() {
  try {
    return JSON.parse(localStorage.getItem('videdi.presets') || '[]');
  } catch (e) {
    return [];
  }
}

export const presets = {
  user: loadUser(),
  all() {
    return [...BUILTIN_PRESETS, ...LUMETRI_BUILTIN, ...this.user.map((u) => this.wrapUser(u))];
  },
  wrapUser(u) {
    return {
      id: 'user:' + u.id,
      folder: 'Custom',
      name: u.name,
      kind: u.kind,
      user: true,
      apply: (clip) => {
        for (const fx of u.effects) {
          const def = getEffectDef(fx.type);
          if (!def || def.kind !== clip.kind) continue;
          const n = deepClone(fx);
          n.id = uid('fx_');
          if (def.intrinsic) {
            const i = clip.effects.findIndex((e) => e.type === fx.type);
            if (i >= 0) clip.effects[i] = Object.assign(n, { id: clip.effects[i].id });
          } else clip.effects.push(n);
        }
      },
    };
  },
  find(id) {
    return this.all().find((p) => p.id === id) || null;
  },
  save() {
    localStorage.setItem('videdi.presets', JSON.stringify(this.user));
    app.bus.emit('presets:changed');
  },
  remove(id) {
    this.user = this.user.filter((u) => 'user:' + u.id !== id);
    this.save();
  },
  saveDialog(clip, fx) {
    const def = getEffectDef(fx.type);
    const name = h('input', { type: 'text', value: (def ? def.name : 'Effect') + ' Preset', style: { width: '240px' } });
    const desc = h('textarea', { rows: 3, style: { width: '240px' } });
    modal({
      title: 'Save Preset',
      body: h('div', row('Name', name), row('Description', desc), h('div.muted.tiny', 'Presets are saved in this browser and appear in Effects › Presets › Custom.')),
      buttons: [
        { label: 'Cancel' },
        {
          label: 'OK',
          cta: true,
          action: () => {
            this.user.push({ id: uid('p'), name: name.value || 'Preset', desc: desc.value, kind: clip.kind, effects: [deepClone(fx)] });
            this.save();
            app.toast('Preset saved', 'ok');
          },
        },
      ],
    });
  },
};
