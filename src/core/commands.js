// Command registry + Premiere Pro default keyboard shortcuts + menubar.

import { app } from './app.js';
import { isMac, MOD } from './util.js';
import { actions } from './actions.js';
import { playback } from '../engine/playback.js';
import { isModalOpen } from '../ui/dialogs.js';
import { closeMenus } from '../ui/menus.js';
import { allTracks, seqDuration } from './model.js';

export const commands = new Map();
let overrides = {};
try {
  overrides = JSON.parse(localStorage.getItem('videdi.keys') || '{}');
} catch (e) {
  overrides = {};
}

function cmd(id, label, keys, run, opts = {}) {
  commands.set(id, { id, label, defaultKeys: keys || [], run, group: opts.group || 'Application', enabled: opts.enabled, panel: opts.panel || null });
}
export function keysFor(id) {
  if (overrides[id]) return overrides[id];
  return commands.get(id)?.defaultKeys || [];
}
export function setKeys(id, keys) {
  overrides[id] = keys;
  localStorage.setItem('videdi.keys', JSON.stringify(overrides));
  rebuildKeymap();
}
export function resetKeys() {
  overrides = {};
  localStorage.removeItem('videdi.keys');
  rebuildKeymap();
}
export function displayKey(k) {
  if (!k) return '';
  if (!isMac) return k;
  return k.replace(/Ctrl\+/g, '⌘').replace(/Alt\+/g, '⌥').replace(/Shift\+/g, '⇧');
}
export function kbdLabel(id) {
  const k = keysFor(id)[0];
  return k ? displayKey(k) : '';
}

export function run(id, ...args) {
  const c = commands.get(id);
  if (!c) return console.warn('Unknown command', id);
  if (c.enabled && !c.enabled()) return;
  try {
    c.run(...args);
  } catch (err) {
    console.error('Command failed', id, err);
    app.toast('Error: ' + err.message, 'error');
  }
}

const S = () => app.seq;
const focus = () => app.focusedPanel;
const src = () => app.panels.source && app.focusedPanel === 'source' ? app.services.sourceMonitor : null;
const services = () => app.services;

// ----------------------------- definitions -----------------------------
// File
cmd('newProject', 'New Project', ['Ctrl+Alt+N'], () => services().persist.newProject(), { group: 'File' });
cmd('openProject', 'Open Project…', ['Ctrl+O'], () => services().persist.openDialog(), { group: 'File' });
cmd('saveProject', 'Save', ['Ctrl+S'], () => services().persist.saveNow(true), { group: 'File' });
cmd('saveAs', 'Save As…', ['Ctrl+Shift+S'], () => services().persist.saveAs(), { group: 'File' });
cmd('saveCopy', 'Save a Copy (with media)…', ['Ctrl+Alt+S'], () => services().persist.saveBundle(), { group: 'File' });
cmd('newSequence', 'New Sequence…', ['Ctrl+N'], () => actions.newSequenceDialog(), { group: 'File' });
cmd('newBin', 'New Bin', ['Ctrl+/'], () => actions.newBin(), { group: 'File' });
cmd('import', 'Import…', ['Ctrl+I'], () => app.panels.project.importDialog(), { group: 'File' });
cmd('importBrowser', 'Import from Media Browser', ['Ctrl+Alt+I'], () => app.services.layout.activate('mediaBrowser'), { group: 'File' });
cmd('exportMedia', 'Export Media…', ['Ctrl+M'], () => services().exporter.open(), { group: 'File' });
cmd('exportFrame', 'Export Frame', ['Ctrl+Shift+E'], () => services().programMonitor.exportFrame(), { group: 'File' });
cmd('exportCaptions', 'Export Captions (.srt)', [], () => services().captions.exportSrt(), { group: 'File' });
cmd('exportAudio', 'Export Audio (.wav)', [], () => services().exporter.open({ format: 'wav' }), { group: 'File' });
cmd('projectSettings', 'Project Settings…', [], () => services().prefs.projectSettings(), { group: 'File' });
cmd('linkMedia', 'Link Media…', [], () => services().persist.linkOffline(), { group: 'File' });

// Edit
cmd('undo', 'Undo', ['Ctrl+Z'], () => {
  const l = app.history.undo();
  if (l) app.status('Undo ' + l);
}, { group: 'Edit' });
cmd('redo', 'Redo', ['Ctrl+Shift+Z', 'Ctrl+Y'], () => {
  const l = app.history.redo();
  if (l) app.status('Redo ' + l);
}, { group: 'Edit' });
cmd('cut', 'Cut', ['Ctrl+X'], () => actions.cut(), { group: 'Edit' });
cmd('copy', 'Copy', ['Ctrl+C'], () => actions.copy(), { group: 'Edit' });
cmd('paste', 'Paste', ['Ctrl+V'], () => actions.paste(false), { group: 'Edit' });
cmd('pasteInsert', 'Paste Insert', ['Ctrl+Shift+V'], () => actions.paste(true), { group: 'Edit' });
cmd('pasteAttributes', 'Paste Attributes…', ['Ctrl+Alt+V'], () => actions.pasteAttributesDialog(), { group: 'Edit' });
cmd('removeAttributes', 'Remove Attributes…', [], () => actions.removeAttributesDialog(), { group: 'Edit' });
cmd('clear', 'Clear', ['Delete', 'Backspace'], () => actions.clear(), { group: 'Edit' });
cmd('rippleDelete', 'Ripple Delete', ['Shift+Delete', 'Shift+Backspace', 'Alt+Backspace'], () => actions.rippleDelete(), { group: 'Edit' });
cmd('duplicate', 'Duplicate', ['Ctrl+Shift+/'], () => app.panels.project && services().projectPanel.duplicate(), { group: 'Edit' });
cmd('selectAll', 'Select All', ['Ctrl+A'], () => actions.selectAll(), { group: 'Edit' });
cmd('deselectAll', 'Deselect All', ['Ctrl+Shift+A', 'Escape'], () => actions.deselectAll(), { group: 'Edit' });
cmd('keyboardShortcuts', 'Keyboard Shortcuts…', ['Ctrl+Alt+K'], () => services().prefs.keyboardDialog(), { group: 'Edit' });
cmd('preferences', 'Preferences…', ['Ctrl+,'], () => services().prefs.preferencesDialog(), { group: 'Edit' });

// Clip
cmd('speedDuration', 'Speed/Duration…', ['Ctrl+R'], () => actions.speedDuration(), { group: 'Clip' });
cmd('audioGain', 'Audio Gain…', ['G'], () => actions.audioGainDialog(), { group: 'Clip' });
cmd('insert', 'Insert', [','], () => actions.sourceEdit('insert'), { group: 'Clip' });
cmd('overwrite', 'Overwrite', ['.'], () => actions.sourceEdit('overwrite'), { group: 'Clip' });
cmd('enable', 'Enable', ['Shift+E'], () => actions.toggleEnable(), { group: 'Clip' });
cmd('link', 'Link / Unlink', ['Ctrl+L'], () => actions.linkUnlink(), { group: 'Clip' });
cmd('group', 'Group', ['Ctrl+G'], () => actions.group(), { group: 'Clip' });
cmd('ungroup', 'Ungroup', ['Ctrl+Shift+G'], () => actions.ungroup(), { group: 'Clip' });
cmd('nest', 'Nest…', [], () => actions.nestDialog(), { group: 'Clip' });
cmd('frameHold', 'Add Frame Hold', [], () => actions.addFrameHold(false), { group: 'Clip' });
cmd('frameHoldSegment', 'Insert Frame Hold Segment', [], () => actions.addFrameHold(true), { group: 'Clip' });
cmd('scaleToFrame', 'Scale to Frame Size', [], () => actions.scaleToFrame(), { group: 'Clip' });
cmd('setToFrame', 'Set to Frame Size', [], () => actions.setToFrameSize(), { group: 'Clip' });
cmd('renameClip', 'Rename…', [], () => actions.renameClip(), { group: 'Clip' });

// Sequence
cmd('sequenceSettings', 'Sequence Settings…', [], () => actions.sequenceSettings(), { group: 'Sequence' });
cmd('render', 'Render In to Out', ['Enter'], () => {
  app.status('Rendering is real-time on the GPU — no preview render needed.');
  playback.play(1, { inOut: true });
}, { group: 'Sequence' });
cmd('matchFrame', 'Match Frame', ['F'], () => actions.matchFrame(), { group: 'Sequence' });
cmd('addEdit', 'Add Edit', ['Ctrl+K'], () => actions.addEdit(false), { group: 'Sequence' });
cmd('addEditAll', 'Add Edit to All Tracks', ['Ctrl+Shift+K'], () => actions.addEdit(true), { group: 'Sequence' });
cmd('extendEdit', 'Extend Selected Edit to Playhead', ['E'], () => actions.extendEdit(), { group: 'Sequence' });
cmd('applyVideoTransition', 'Apply Video Transition', ['Ctrl+D'], () => actions.applyDefaultTransition('video'), { group: 'Sequence' });
cmd('applyAudioTransition', 'Apply Audio Transition', ['Ctrl+Shift+D'], () => actions.applyDefaultTransition('audio'), { group: 'Sequence' });
cmd('applyTransitionsSelection', 'Apply Default Transitions to Selection', ['Shift+D'], () => actions.applyTransitionsToSelection(), { group: 'Sequence' });
cmd('lift', 'Lift', [';'], () => actions.lift(), { group: 'Sequence' });
cmd('extract', 'Extract', ["'"], () => actions.extract(), { group: 'Sequence' });
cmd('zoomIn', 'Zoom In', ['='], () => services().timeline.zoomIn(), { group: 'Sequence' });
cmd('zoomOut', 'Zoom Out', ['-'], () => services().timeline.zoomOut(), { group: 'Sequence' });
cmd('zoomFit', 'Zoom to Sequence', ['\\'], () => services().timeline.zoomToFit(), { group: 'Sequence' });
cmd('snap', 'Snap in Timeline', ['S'], () => actions.toggleSnap(), { group: 'Sequence' });
cmd('linkedSelection', 'Linked Selection', [], () => actions.toggleLinked(), { group: 'Sequence' });
cmd('rippleTrimPrev', 'Ripple Trim Previous Edit to Playhead', ['Q'], () => actions.rippleTrim('prev'), { group: 'Sequence' });
cmd('rippleTrimNext', 'Ripple Trim Next Edit to Playhead', ['W'], () => actions.rippleTrim('next'), { group: 'Sequence' });
cmd('closeGaps', 'Close Gap', [], () => app.edit('Close Gaps', () => services().edit.closeAllGaps(S())), { group: 'Sequence' });
cmd('addTracks', 'Add Tracks…', [], () => actions.addTracksDialog(), { group: 'Sequence' });
cmd('deleteEmptyTracks', 'Delete Empty Tracks', [], () => app.edit('Delete Empty Tracks', () => services().edit.deleteEmptyTracks(S())), { group: 'Sequence' });
cmd('expandTracks', 'Increase Track Heights', ['Ctrl+='], () => { if (S()) { allTracks(S()).forEach((t) => (t.height = Math.min(240, t.height + 14))); app.changed(); } }, { group: 'Sequence' });
cmd('shrinkTracks', 'Decrease Track Heights', ['Ctrl+-'], () => { if (S()) { allTracks(S()).forEach((t) => (t.height = Math.max(24, t.height - 14))); app.changed(); } }, { group: 'Sequence' });
cmd('selectClipAtPlayhead', 'Select Clip at Playhead', ['D'], () => actions.selectClipAtPlayhead(), { group: 'Sequence' });
cmd('nudgeLeft', 'Nudge Clip Selection Left One Frame', ['Alt+Left'], () => actions.nudge(-1), { group: 'Sequence' });
cmd('nudgeRight', 'Nudge Clip Selection Right One Frame', ['Alt+Right'], () => actions.nudge(1), { group: 'Sequence' });
cmd('nudgeLeft5', 'Nudge Clip Selection Left Five Frames', ['Alt+Shift+Left'], () => actions.nudge(-5), { group: 'Sequence' });
cmd('nudgeRight5', 'Nudge Clip Selection Right Five Frames', ['Alt+Shift+Right'], () => actions.nudge(5), { group: 'Sequence' });

// Markers
const inOutTarget = () => (focus() === 'source' ? services().sourceMonitor : null);
cmd('markIn', 'Mark In', ['I'], () => (inOutTarget() ? inOutTarget().markIn() : actions.markIn()), { group: 'Markers' });
cmd('markOut', 'Mark Out', ['O'], () => (inOutTarget() ? inOutTarget().markOut() : actions.markOut()), { group: 'Markers' });
cmd('markClip', 'Mark Clip', ['X'], () => actions.markClip(), { group: 'Markers' });
cmd('markSelection', 'Mark Selection', ['/'], () => actions.markSelection(), { group: 'Markers' });
cmd('gotoIn', 'Go to In', ['Shift+I'], () => (inOutTarget() ? inOutTarget().gotoIn() : actions.gotoIn()), { group: 'Markers' });
cmd('gotoOut', 'Go to Out', ['Shift+O'], () => (inOutTarget() ? inOutTarget().gotoOut() : actions.gotoOut()), { group: 'Markers' });
cmd('clearIn', 'Clear In', ['Ctrl+Shift+I'], () => actions.clearIn(), { group: 'Markers' });
cmd('clearOut', 'Clear Out', ['Ctrl+Shift+O'], () => actions.clearOut(), { group: 'Markers' });
cmd('clearInOut', 'Clear In and Out', ['Ctrl+Shift+X'], () => (inOutTarget() ? inOutTarget().clearInOut() : actions.clearInOut()), { group: 'Markers' });
cmd('addMarker', 'Add Marker', ['M'], () => (inOutTarget() ? inOutTarget().addMarker() : actions.addMarker()), { group: 'Markers' });
cmd('nextMarker', 'Go to Next Marker', ['Shift+M'], () => actions.gotoMarker(1), { group: 'Markers' });
cmd('prevMarker', 'Go to Previous Marker', ['Ctrl+Shift+M'], () => actions.gotoMarker(-1), { group: 'Markers' });
cmd('clearMarker', 'Clear Selected Marker', ['Ctrl+Alt+M'], () => actions.clearCurrentMarker(), { group: 'Markers' });
cmd('clearAllMarkers', 'Clear All Markers', ['Ctrl+Alt+Shift+M'], () => actions.clearAllMarkers(), { group: 'Markers' });
cmd('editMarker', 'Edit Marker…', [], () => {
  const s = S();
  const m = s && s.markers.find((x) => x.frame === s.playhead);
  if (m) actions.editMarker(m);
}, { group: 'Markers' });

// Graphics
cmd('newText', 'New Layer › Text', ['Ctrl+T'], () => actions.newTextLayer(), { group: 'Graphics' });
cmd('newRect', 'New Layer › Rectangle', ['Ctrl+Alt+R'], () => actions.newShapeLayer('rect'), { group: 'Graphics' });
cmd('newEllipse', 'New Layer › Ellipse', ['Ctrl+Alt+E'], () => actions.newShapeLayer('ellipse'), { group: 'Graphics' });
cmd('addCaption', 'Add Caption at Playhead', [], () => services().captions.addAtPlayhead(), { group: 'Graphics' });
cmd('importCaptions', 'Import Captions…', [], () => services().captions.importDialog(), { group: 'Graphics' });

// Playback & navigation
const mon = () => (focus() === 'source' ? services().sourceMonitor : null);
cmd('playStop', 'Play-Stop Toggle', ['Space'], () => {
  if (actions._rec) return actions._rec.stop();
  const m = mon();
  if (m) return m.toggle();
  playback.toggle();
}, { group: 'Playback' });
cmd('shuttleLeft', 'Shuttle Left', ['J'], () => (mon() ? mon().shuttle(-1) : playback.shuttle(-1)), { group: 'Playback' });
cmd('shuttleStop', 'Shuttle Stop', ['K'], () => (mon() ? mon().pause() : playback.stop()), { group: 'Playback' });
cmd('shuttleRight', 'Shuttle Right', ['L'], () => (mon() ? mon().shuttle(1) : playback.shuttle(1)), { group: 'Playback' });
cmd('playAround', 'Play Around', ['Shift+K'], () => playback.playAround(), { group: 'Playback' });
cmd('playInOut', 'Play In to Out', ['Ctrl+Shift+Space', 'Shift+Space'], () => playback.play(1, { inOut: true }), { group: 'Playback' });
cmd('stepBack', 'Step Back 1 Frame', ['Left'], () => (mon() ? mon().step(-1) : actions.step(-1)), { group: 'Playback' });
cmd('stepFwd', 'Step Forward 1 Frame', ['Right'], () => (mon() ? mon().step(1) : actions.step(1)), { group: 'Playback' });
cmd('stepBack5', 'Step Back Five Frames', ['Shift+Left'], () => (mon() ? mon().step(-5) : actions.step(-5)), { group: 'Playback' });
cmd('stepFwd5', 'Step Forward Five Frames', ['Shift+Right'], () => (mon() ? mon().step(5) : actions.step(5)), { group: 'Playback' });
cmd('prevEdit', 'Go to Previous Edit Point', ['Up'], () => actions.gotoEdit(-1), { group: 'Playback' });
cmd('nextEdit', 'Go to Next Edit Point', ['Down'], () => actions.gotoEdit(1), { group: 'Playback' });
cmd('prevEditAny', 'Go to Previous Edit Point on Any Track', ['Shift+Up'], () => actions.gotoEdit(-1, true), { group: 'Playback' });
cmd('nextEditAny', 'Go to Next Edit Point on Any Track', ['Shift+Down'], () => actions.gotoEdit(1, true), { group: 'Playback' });
cmd('gotoStart', 'Go to Sequence-Clip Start', ['Home'], () => (mon() ? mon().seekFrame(0) : actions.gotoStart()), { group: 'Playback' });
cmd('gotoEnd', 'Go to Sequence-Clip End', ['End'], () => (mon() ? mon().seekFrame(mon().totalFrames() - 1) : actions.gotoEnd()), { group: 'Playback' });
cmd('loop', 'Loop Playback', [], () => {
  app.prefs.loopPlayback = !app.prefs.loopPlayback;
  app.savePrefs();
}, { group: 'Playback' });

// Tools
for (const [id, label, key] of [
  ['select', 'Selection Tool', 'V'], ['trackFwd', 'Track Select Forward Tool', 'A'], ['trackBack', 'Track Select Backward Tool', 'Shift+A'],
  ['ripple', 'Ripple Edit Tool', 'B'], ['rolling', 'Rolling Edit Tool', 'N'], ['rateStretch', 'Rate Stretch Tool', 'R'], ['razor', 'Razor Tool', 'C'],
  ['slip', 'Slip Tool', 'Y'], ['slide', 'Slide Tool', 'U'], ['pen', 'Pen Tool', 'P'], ['rect', 'Rectangle Tool', ''], ['ellipse', 'Ellipse Tool', ''],
  ['hand', 'Hand Tool', 'H'], ['zoom', 'Zoom Tool', 'Z'], ['type', 'Type Tool', 'T'],
]) cmd('tool.' + id, label, key ? [key] : [], () => app.setTool(id), { group: 'Tools' });

// Window
const PANEL_KEYS = [['project', 'Project', 'Shift+1'], ['source', 'Source Monitor', 'Shift+2'], ['timeline', 'Timelines', 'Shift+3'], ['program', 'Program Monitor', 'Shift+4'], ['effectControls', 'Effect Controls', 'Shift+5'], ['audioMixer', 'Audio Track Mixer', 'Shift+6'], ['effects', 'Effects', 'Shift+7'], ['mediaBrowser', 'Media Browser', 'Shift+8'], ['audioClipMixer', 'Audio Clip Mixer', 'Shift+9']];
for (const [id, label, key] of PANEL_KEYS)
  cmd('panel.' + id, label, [key], () => {
    services().layout.activate(id);
    app.focusPanel(id);
  }, { group: 'Window' });
for (const [id, label] of [['lumetri', 'Lumetri Color'], ['scopes', 'Lumetri Scopes'], ['essentialGraphics', 'Essential Graphics'], ['essentialSound', 'Essential Sound'], ['history', 'History'], ['info', 'Info'], ['markers', 'Markers'], ['text', 'Text'], ['tools', 'Tools'], ['audioMeters', 'Audio Meters']])
  cmd('panel.' + id, label, [], () => {
    services().layout.activate(id);
    app.focusPanel(id);
  }, { group: 'Window' });
cmd('maximizeFrame', 'Maximize or Restore Frame', ['`', 'Shift+`'], () => services().layout.toggleMaximize(), { group: 'Window' });
['Assembly', 'Editing', 'Color', 'Effects', 'Audio', 'Graphics', 'Captions'].forEach((w, i) => cmd('ws.' + w, w, ['Alt+Shift+' + (i + 1)], () => services().layout.load(w), { group: 'Window' }));
cmd('resetWorkspace', 'Reset to Saved Layout', ['Alt+Shift+0'], () => services().layout.load(services().layout.name, { reset: true }), { group: 'Window' });

// Help
cmd('help', 'Vid-Edi Help', ['F1'], () => services().prefs.helpDialog(), { group: 'Help' });

// ----------------------------- keyboard handling -----------------------------
const CODE_MAP = {
  Space: 'Space', Enter: 'Enter', NumpadEnter: 'Enter', Escape: 'Escape', Backspace: 'Backspace', Delete: 'Delete', Tab: 'Tab',
  ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
  Comma: ',', Period: '.', Semicolon: ';', Quote: "'", Equal: '=', Minus: '-', Backslash: '\\', Backquote: '`', Slash: '/', BracketLeft: '[', BracketRight: ']',
  NumpadAdd: '=', NumpadSubtract: '-',
};
export function comboFromEvent(e) {
  let key = null;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
  else if (/^Numpad\d$/.test(e.code)) key = e.code.slice(6);
  else if (/^F\d{1,2}$/.test(e.code)) key = e.code;
  else key = CODE_MAP[e.code] || null;
  if (!key) return null;
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  parts.push(key);
  return parts.join('+');
}

let keymap = new Map();
export function rebuildKeymap() {
  keymap = new Map();
  for (const c of commands.values()) for (const k of keysFor(c.id)) keymap.set(normalize(k), c.id);
}
function normalize(k) {
  const parts = k.split('+');
  const key = parts.pop();
  const mods = ['Ctrl', 'Alt', 'Shift'].filter((m) => parts.includes(m));
  return [...mods, key].join('+');
}
export function commandForCombo(combo) {
  return keymap.get(normalize(combo)) || null;
}

export function initKeyboard() {
  rebuildKeymap();
  window.addEventListener('keydown', (e) => {
    if (isModalOpen()) return;
    const t = e.target;
    const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
    if (typing && t.type !== 'checkbox' && t.type !== 'range' && t.type !== 'radio') return;
    const combo = comboFromEvent(e);
    if (!combo) return;
    const id = commandForCombo(combo);
    if (!id) return;
    e.preventDefault();
    e.stopPropagation();
    closeMenus();
    if (e.repeat && !['stepBack', 'stepFwd', 'stepBack5', 'stepFwd5', 'zoomIn', 'zoomOut', 'nudgeLeft', 'nudgeRight', 'prevEdit', 'nextEdit', 'undo', 'redo'].includes(id)) return;
    run(id);
  });
}

// ----------------------------- menubar -----------------------------
const M = (id, extra = {}) => {
  const c = commands.get(id);
  return { label: extra.label || c.label, kbd: kbdLabel(id), action: () => run(id), ...extra };
};

export function menubarDef() {
  const seq = () => app.seq;
  const hasSel = () => app.sel.clips.size > 0;
  return [
    {
      label: 'File',
      items: () => [
        { label: 'New', submenu: [M('newProject', { label: 'Project…' }), M('newSequence', { label: 'Sequence…' }), M('newBin', { label: 'Bin' }), { sep: true }, { label: 'Adjustment Layer…', action: () => actions.newSynthetic('adjustment') }, { label: 'Bars and Tone…', action: () => actions.newSynthetic('bars') }, { label: 'Black Video…', action: () => actions.newSynthetic('black') }, { label: 'Color Matte…', action: () => actions.newSynthetic('colormatte') }, { label: 'Universal Counting Leader…', action: () => actions.newSynthetic('leader') }, { label: 'Transparent Video…', action: () => actions.newSynthetic('transparent') }] },
        M('openProject', { label: 'Open Project…' }),
        { label: 'Open Recent', submenu: () => services().persist.recentMenu() },
        { sep: true },
        M('saveProject'),
        M('saveAs'),
        M('saveCopy'),
        { sep: true },
        M('import'),
        M('importBrowser'),
        M('linkMedia'),
        { sep: true },
        { label: 'Export', submenu: [M('exportMedia', { label: 'Media…' }), M('exportFrame', { label: 'Frame' }), M('exportAudio', { label: 'Audio (WAV)…' }), M('exportCaptions', { label: 'Captions (.srt)' }), { label: 'Captions (.vtt)', action: () => services().captions.exportSrt(true) }, { label: 'Project as JSON…', action: () => services().persist.saveAs() }] },
        { sep: true },
        M('projectSettings'),
        { label: 'Get Properties for Selection', action: () => app.services.layout.activate('info') },
      ],
    },
    {
      label: 'Edit',
      items: () => [
        M('undo', { label: 'Undo' + (app.history.canUndo() ? ' ' + app.history.entries[app.history.index].label : ''), disabled: !app.history.canUndo() }),
        M('redo', { label: 'Redo' + (app.history.canRedo() ? ' ' + app.history.entries[app.history.index + 1].label : ''), disabled: !app.history.canRedo() }),
        { sep: true },
        M('cut', { disabled: !hasSel() }),
        M('copy', { disabled: !hasSel() }),
        M('paste', { disabled: !app.clipboard }),
        M('pasteInsert', { disabled: !app.clipboard }),
        M('pasteAttributes', { disabled: !app.clipboard }),
        M('removeAttributes', { disabled: !hasSel() }),
        M('clear'),
        M('rippleDelete'),
        M('duplicate'),
        M('selectAll'),
        M('deselectAll'),
        { sep: true },
        { label: 'Label', submenu: () => Object.keys(services().labels).map((n) => ({ label: n, color: services().labels[n], action: () => actions.setLabel(n) })) },
        { sep: true },
        M('keyboardShortcuts'),
        M('preferences', { label: 'Preferences…' }),
      ],
    },
    {
      label: 'Clip',
      items: () => [
        M('renameClip', { disabled: !hasSel() }),
        M('insert'),
        M('overwrite'),
        { sep: true },
        M('speedDuration', { disabled: !hasSel() }),
        M('audioGain'),
        { sep: true },
        { label: 'Video Options', submenu: [M('frameHold'), M('frameHoldSegment'), M('scaleToFrame'), M('setToFrame')] },
        { sep: true },
        M('enable', { disabled: !hasSel() }),
        M('link', { disabled: !hasSel() }),
        M('group', { disabled: app.sel.clips.size < 2 }),
        M('ungroup', { disabled: !hasSel() }),
        M('nest', { disabled: !hasSel() }),
      ],
    },
    {
      label: 'Sequence',
      items: () => [
        M('sequenceSettings', { disabled: !seq() }),
        { sep: true },
        M('render', { label: 'Render In to Out' }),
        M('matchFrame'),
        M('addEdit'),
        M('addEditAll'),
        M('extendEdit'),
        M('applyVideoTransition'),
        M('applyAudioTransition'),
        M('applyTransitionsSelection'),
        M('lift'),
        M('extract'),
        M('rippleTrimPrev'),
        M('rippleTrimNext'),
        { sep: true },
        M('zoomIn'),
        M('zoomOut'),
        M('zoomFit'),
        M('closeGaps'),
        { sep: true },
        M('snap', { checked: app.snapping }),
        M('linkedSelection', { checked: app.linkedSelection }),
        { sep: true },
        M('addTracks'),
        M('deleteEmptyTracks', { label: 'Delete Tracks (empty)' }),
      ],
    },
    {
      label: 'Markers',
      items: () => [M('markIn'), M('markOut'), M('markClip'), M('markSelection'), { sep: true }, M('gotoIn'), M('gotoOut'), { sep: true }, M('clearIn'), M('clearOut'), M('clearInOut'), { sep: true }, M('addMarker'), M('nextMarker'), M('prevMarker'), M('clearMarker'), M('clearAllMarkers'), { sep: true }, M('editMarker')],
    },
    {
      label: 'Graphics and Titles',
      items: () => [{ label: 'New Layer', submenu: [M('newText', { label: 'Text' }), M('newRect', { label: 'Rectangle' }), M('newEllipse', { label: 'Ellipse' })] }, { sep: true }, M('addCaption'), M('importCaptions'), { label: 'Export Captions (.srt)', action: () => services().captions.exportSrt() }],
    },
    {
      label: 'View',
      items: () => [
        { label: 'Playback Resolution', submenu: [['full', 'Full'], ['half', '1/2'], ['quarter', '1/4'], ['eighth', '1/8']].map(([v, l]) => ({ label: l, checked: app.prefs.playbackRes === v, action: () => { app.prefs.playbackRes = v; app.savePrefs(); } })) },
        { sep: true },
        { label: 'Show Safe Margins', checked: !!app.prefs.safeMargins, action: () => { app.prefs.safeMargins = !app.prefs.safeMargins; app.savePrefs(); } },
        { label: 'Show Transparency Grid', checked: !!app.prefs.showTransparencyGrid, action: () => { app.prefs.showTransparencyGrid = !app.prefs.showTransparencyGrid; app.savePrefs(); } },
        M('loop', { label: 'Loop Playback', checked: !!app.prefs.loopPlayback }),
      ],
    },
    {
      label: 'Window',
      items: () => [
        { label: 'Workspaces', submenu: ['Assembly', 'Editing', 'Color', 'Effects', 'Audio', 'Graphics', 'Captions'].map((w) => M('ws.' + w, { checked: services().layout.name === w })) },
        M('resetWorkspace'),
        { sep: true },
        ...['audioClipMixer', 'audioMeters', 'audioMixer', 'effectControls', 'effects', 'essentialGraphics', 'essentialSound', 'history', 'info', 'lumetri', 'scopes', 'markers', 'mediaBrowser', 'program', 'project', 'source', 'text', 'timeline', 'tools'].map((id) => M('panel.' + id, { checked: services().layout.isVisible(id) })),
        { sep: true },
        M('maximizeFrame'),
      ],
    },
    { label: 'Help', items: () => [M('help'), M('keyboardShortcuts'), { label: 'About Vid-Edi', action: () => services().prefs.aboutDialog() }] },
  ];
}

export { seqDuration, MOD };
