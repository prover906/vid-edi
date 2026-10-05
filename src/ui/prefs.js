// Preferences, Keyboard Shortcuts, Project Settings, Help and About dialogs.

import { app } from '../core/app.js';
import { h, isMac, MOD } from '../core/util.js';
import { modal, row } from './dialogs.js';
import { dropdown, checkbox } from './widgets.js';
import { commands, keysFor, setKeys, resetKeys, comboFromEvent, displayKey, commandForCombo } from '../core/commands.js';
import { registry } from '../core/registry.js';

const KB_ROWS = [
  [['`', 1], ['1', 1], ['2', 1], ['3', 1], ['4', 1], ['5', 1], ['6', 1], ['7', 1], ['8', 1], ['9', 1], ['0', 1], ['-', 1], ['=', 1], ['Backspace', 2]],
  [['Tab', 1.5], ['Q', 1], ['W', 1], ['E', 1], ['R', 1], ['T', 1], ['Y', 1], ['U', 1], ['I', 1], ['O', 1], ['P', 1], ['[', 1], [']', 1], ['\\', 1.5]],
  [['Caps', 1.8, true], ['A', 1], ['S', 1], ['D', 1], ['F', 1], ['G', 1], ['H', 1], ['J', 1], ['K', 1], ['L', 1], [';', 1], ["'", 1], ['Enter', 2.2]],
  [['Shift', 2.3, true], ['Z', 1], ['X', 1], ['C', 1], ['V', 1], ['B', 1], ['N', 1], ['M', 1], [',', 1], ['.', 1], ['/', 1], ['Shift', 2.7, true]],
  [['Ctrl', 1.5, true], ['Alt', 1.5, true], ['Space', 6.5], ['Left', 1], ['Up', 1], ['Down', 1], ['Right', 1], ['Home', 1.2], ['End', 1.2], ['Delete', 1.3]],
];

export const prefsUI = {
  preferencesDialog() {
    const p = app.prefs;
    const num = (k, step = 0.5, min = 0) => {
      const i = h('input', { type: 'number', value: p[k], step, min, style: { width: '80px' } });
      i.addEventListener('change', () => (p[k] = parseFloat(i.value) || p[k]));
      return i;
    };
    const vt = [...registry.videoTransitions.values()].map((d) => ({ label: d.name, value: d.id }));
    const at = [...registry.audioTransitions.values()].map((d) => ({ label: d.name, value: d.id }));
    const cb = (k, label) => h('div', { style: { margin: '6px 0' } }, checkbox({ checked: !!p[k], label, onChange: (v) => (p[k] = v) }).el);
    const body = h('div', { style: { width: '520px' } },
      h('div.fieldset', h('div.legend', 'General'),
        row('Still image default duration', h('span', num('stillDuration'), ' seconds')),
        row('Video transition duration', h('span', num('videoTransitionDuration', 0.1, 0.04), ' seconds')),
        row('Audio transition duration', h('span', num('audioTransitionDuration', 0.1, 0.04), ' seconds')),
        row('Default video transition', dropdown({ options: vt, value: p.defaultVideoTransition, onChange: (v) => (p.defaultVideoTransition = v) }).el),
        row('Default audio transition', dropdown({ options: at, value: p.defaultAudioTransition, onChange: (v) => (p.defaultAudioTransition = v) }).el),
        row('Default media scaling', dropdown({ options: [{ label: 'None', value: 'none' }, { label: 'Scale to frame size', value: 'scale' }, { label: 'Set to frame size', value: 'set' }], value: p.mediaScaling, onChange: (v) => (p.mediaScaling = v) }).el),
      ),
      h('div.fieldset', h('div.legend', 'Timeline'),
        row('Timeline playback auto-scrolling', dropdown({ options: [{ label: 'Page Scroll', value: 'page' }, { label: 'Smooth Scroll', value: 'smooth' }, { label: 'No Scroll', value: 'none' }], value: p.autoScroll, onChange: (v) => (p.autoScroll = v) }).el),
        cb('audioScrubbing', 'Play audio while scrubbing'),
        cb('showThumbnails', 'Show video thumbnails'),
        cb('showWaveforms', 'Show audio waveforms'),
        cb('showKeyframes', 'Show clip keyframes (rubber bands)'),
      ),
      h('div.fieldset', h('div.legend', 'Playback'),
        row('Preroll', h('span', num('preroll'), ' seconds')),
        row('Postroll', h('span', num('postroll'), ' seconds')),
      ),
      h('div.fieldset', h('div.legend', 'Appearance'),
        row('Brightness', (() => {
          const r = h('input', { type: 'range', min: -30, max: 30, step: 1, value: p.uiBrightness || 0 });
          r.addEventListener('input', () => {
            p.uiBrightness = +r.value;
            applyBrightness();
          });
          return r;
        })()),
      ),
    );
    modal({ title: 'Preferences', body, width: 600, buttons: [{ label: 'Cancel', action: () => app.loadPrefs() }, { label: 'OK', cta: true, action: () => app.savePrefs() }] });
  },

  keyboardDialog() {
    let mods = { Ctrl: false, Alt: false, Shift: false };
    let query = '';
    let recording = null;
    const kb = h('div.kb-keyboard');
    const list = h('div.kb-list');
    const info = h('div.muted.tiny', 'Purple: application shortcut · Click a key chip below to remove it · "+" records a new shortcut');
    const modBar = h('div', { style: { display: 'flex', gap: '12px', alignItems: 'center' } });
    const comboWithMods = (key) => [...['Ctrl', 'Alt', 'Shift'].filter((m) => mods[m]), key].join('+');
    const drawKb = () => {
      kb.innerHTML = '';
      for (const r of KB_ROWS) {
        const rowEl = h('div.kb-krow');
        for (const [k, w, isMod] of r) {
          const id = isMod ? null : commandForCombo(comboWithMods(k));
          const c = id ? commands.get(id) : null;
          const key = h('div.kb-key' + (isMod ? '.mod' : c ? '.app' : ''), { style: { flex: `${w} 1 0` }, title: c ? c.label : '' }, h('span.kc', k === 'Space' ? '' : k), h('span.kn', c ? c.label : ''));
          if (isMod && mods[k]) key.classList.add('hl');
          if (isMod) key.onclick = () => { mods[k] = !mods[k]; drawMods(); drawKb(); };
          rowEl.appendChild(key);
        }
        kb.appendChild(rowEl);
      }
    };
    const drawMods = () => {
      modBar.innerHTML = '';
      modBar.append(h('span.muted', 'Modifiers:'));
      for (const m of ['Ctrl', 'Alt', 'Shift']) modBar.appendChild(checkbox({ checked: mods[m], label: isMac && m === 'Ctrl' ? '⌘ Cmd' : m, onChange: (v) => { mods[m] = v; drawKb(); } }).el);
    };
    const drawList = () => {
      list.innerHTML = '';
      const groups = new Map();
      for (const c of commands.values()) {
        if (query && !c.label.toLowerCase().includes(query) && !keysFor(c.id).join(' ').toLowerCase().includes(query)) continue;
        if (!groups.has(c.group)) groups.set(c.group, []);
        groups.get(c.group).push(c);
      }
      for (const [g, cs] of groups) {
        list.appendChild(h('div.preset-group', g));
        for (const c of cs) {
          const keys = h('div.kb-keys');
          for (const k of keysFor(c.id)) {
            const chip = h('span.kb-chip', { title: 'Click to remove' }, displayKey(k));
            chip.onclick = () => {
              setKeys(c.id, keysFor(c.id).filter((x) => x !== k));
              drawList();
              drawKb();
            };
            keys.appendChild(chip);
          }
          const add = h('span.kb-chip.add' + (recording === c.id ? '.rec' : ''), recording === c.id ? 'Press keys…' : '+');
          add.onclick = () => {
            recording = c.id;
            drawList();
          };
          keys.appendChild(add);
          list.appendChild(h('div.kb-row', h('div.kb-cmd', c.label), keys));
        }
      }
    };
    const search = h('input', { type: 'search', placeholder: 'Search commands or keys', style: { width: '260px' } });
    search.addEventListener('input', () => {
      query = search.value.toLowerCase();
      drawList();
    });
    const onKey = (e) => {
      if (!recording) return;
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
      e.preventDefault();
      e.stopPropagation();
      const combo = comboFromEvent(e);
      if (combo && e.key !== 'Escape') {
        const existing = commandForCombo(combo);
        if (existing && existing !== recording) setKeys(existing, keysFor(existing).filter((k) => k !== combo));
        setKeys(recording, [...keysFor(recording), combo]);
        app.toast(`${displayKey(combo)} → ${commands.get(recording).label}` + (existing && existing !== recording ? ` (removed from ${commands.get(existing).label})` : ''), 'ok');
      }
      recording = null;
      drawList();
      drawKb();
    };
    window.addEventListener('keydown', onKey, true);
    drawMods();
    drawKb();
    drawList();
    modal({
      title: 'Keyboard Shortcuts',
      width: 980,
      body: h('div.kb-wrap', h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } }, h('span', 'Keyboard Layout Preset: ', h('b', 'Adobe Premiere Pro Default')), modBar), kb, h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } }, search, info), list),
      footLeft: 'Shortcuts are saved in this browser.',
      buttons: [{ label: 'Reset to Defaults', action: () => { resetKeys(); drawList(); drawKb(); return false; } }, { label: 'Close', cta: true }],
      onClose: () => window.removeEventListener('keydown', onKey, true),
    });
  },

  projectSettings() {
    const name = h('input', { type: 'text', value: app.project.name, style: { width: '240px' } });
    modal({
      title: 'Project Settings',
      body: h('div', row('Project name', name), row('Renderer', h('span', 'GPU Accelerated (WebGL 2)')), row('Video previews', h('span.muted', 'Real-time, no preview files')), row('Audio', h('span', '48000 Hz stereo, 32-bit float mix'))),
      buttons: [{ label: 'Cancel' }, { label: 'OK', cta: true, action: () => app.edit('Project Settings', () => (app.project.name = name.value || 'Untitled')) }],
    });
  },

  helpDialog() {
    const sec = (t, ...items) => h('div.fieldset', h('div.legend', t), ...items.map((i) => h('div', { style: { margin: '3px 0' } }, i)));
    modal({
      title: 'Vid-Edi Help',
      width: 640,
      body: h('div', { style: { lineHeight: 1.5 } },
        sec('Getting started', 'Import media with ' + MOD + '+I or drag files into the Project panel. Drag clips into the Timeline (dropping onto an empty timeline creates a sequence matching the clip).', 'Double-click a clip to open it in the Source Monitor, set In (I) and Out (O), then press , to insert or . to overwrite at the playhead.'),
        sec('Editing', 'Tools: V Selection, A Track Select, B Ripple, N Rolling, R Rate Stretch, C Razor, Y Slip, U Slide, P Pen, H Hand, Z Zoom, T Type.', MOD + '+K Add Edit · Q/W Ripple Trim · Shift+Delete Ripple Delete · ; Lift · \' Extract · ' + MOD + '+D Default transition.', 'Hold ' + MOD + ' while dropping clips to insert instead of overwrite. Alt-drag duplicates. Alt-click selects one side of a linked clip.'),
        sec('Effects', 'Drag effects from the Effects panel onto clips, or transitions onto edit points. Adjust in Effect Controls — click the stopwatch to animate, drag blue numbers to scrub.', 'Use the Lumetri Color panel for color grading and Lumetri Scopes to monitor levels. Opacity and effect masks are created from Effect Controls.'),
        sec('Playback', 'Space play/stop · J/K/L shuttle · Left/Right step · Up/Down jump between edits · Home/End.'),
        sec('Export', MOD + '+M opens Export. H.264 MP4 and VP9 WebM are encoded with WebCodecs when your browser supports it; WAV exports audio only.'),
        sec('Saving', 'Projects autosave to this browser (including imported media). Use Save As to download a .vproj file; "Save a Copy (with media)" bundles media into one file.'),
      ),
      buttons: [{ label: 'Keyboard Shortcuts…', action: () => setTimeout(() => this.keyboardDialog(), 0) }, { label: 'Close', cta: true }],
    });
  },

  aboutDialog() {
    modal({
      title: 'About Vid-Edi Pro',
      body: h('div', { style: { display: 'flex', gap: '16px', alignItems: 'center' } }, h('div.start-brand', h('div.big-logo', 'Ve')), h('div', h('div', { style: { fontSize: '16px', color: '#fff', fontWeight: 600 } }, 'Vid-Edi Pro'), h('div.muted', 'A non-linear video editor that runs entirely in your browser.'), h('div.muted.tiny', { style: { marginTop: '6px' } }, 'GPU compositing with WebGL 2 · Web Audio mixing · WebCodecs export'))),
      buttons: [{ label: 'OK', cta: true }],
    });
  },
};

export function applyBrightness() {
  const b = app.prefs.uiBrightness || 0;
  const r = document.documentElement.style;
  const lift = (base, amt) => {
    const n = parseInt(base.slice(1), 16);
    const c = (v) => Math.max(0, Math.min(255, v + amt));
    return '#' + [c((n >> 16) & 255), c((n >> 8) & 255), c(n & 255)].map((v) => v.toString(16).padStart(2, '0')).join('');
  };
  r.setProperty('--bg-panel', lift('#232323', b));
  r.setProperty('--bg-panel-2', lift('#1e1e1e', b));
  r.setProperty('--bg-app', lift('#101010', Math.round(b / 2)));
}
