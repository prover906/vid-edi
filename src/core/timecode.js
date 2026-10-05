// SMPTE timecode helpers (supports drop-frame for 29.97 / 59.94).

export const FRAME_RATES = [
  { label: '23.976 fps', fps: 24000 / 1001 },
  { label: '24 fps', fps: 24 },
  { label: '25 fps', fps: 25 },
  { label: '29.97 fps', fps: 30000 / 1001 },
  { label: '30 fps', fps: 30 },
  { label: '50 fps', fps: 50 },
  { label: '59.94 fps', fps: 60000 / 1001 },
  { label: '60 fps', fps: 60 },
];

export function nominalFps(fps) {
  return Math.round(fps);
}
export function isDropFrame(fps) {
  return Math.abs(fps - 30000 / 1001) < 0.01 || Math.abs(fps - 60000 / 1001) < 0.01;
}
export function fpsLabel(fps) {
  const r = FRAME_RATES.find((f) => Math.abs(f.fps - fps) < 0.005);
  return r ? r.label : fps.toFixed(2) + ' fps';
}
export function snapFps(fps) {
  let best = FRAME_RATES[4].fps, bd = 1e9;
  for (const r of FRAME_RATES) {
    const d = Math.abs(r.fps - fps);
    if (d < bd) { bd = d; best = r.fps; }
  }
  return bd < 1.5 ? best : fps;
}

const pad = (n, l = 2) => String(Math.floor(Math.abs(n))).padStart(l, '0');

export function framesToTC(frames, fps, opts = {}) {
  const neg = frames < 0;
  frames = Math.round(Math.abs(frames));
  const nom = nominalFps(fps);
  const df = opts.dropFrame !== false && isDropFrame(fps);
  let f = frames;
  if (df) {
    const dropPer = nom === 60 ? 4 : 2;
    const framesPer10 = nom * 600 - dropPer * 9;
    const framesPerMin = nom * 60 - dropPer;
    const d = Math.floor(f / framesPer10);
    const m = f % framesPer10;
    if (m > dropPer) f += dropPer * 9 * d + dropPer * Math.floor((m - dropPer) / framesPerMin);
    else f += dropPer * 9 * d;
  }
  const ff = f % nom;
  const s = Math.floor(f / nom) % 60;
  const mm = Math.floor(f / (nom * 60)) % 60;
  const hh = Math.floor(f / (nom * 3600));
  const sep = df ? ';' : ':';
  return (neg ? '-' : '') + pad(hh) + ':' + pad(mm) + ':' + pad(s) + sep + pad(ff);
}

// Parse "HH:MM:SS:FF", "MM:SS:FF", "+10", "-5", or digit-packed "1000" (=00:00:10:00).
// Returns frames or null. If relativeTo is passed, "+x"/"-x" are relative frame offsets.
export function tcToFrames(str, fps, relativeTo = null) {
  if (str == null) return null;
  str = String(str).trim();
  if (!str) return null;
  const nom = nominalFps(fps);
  let rel = 0;
  if ((str[0] === '+' || str[0] === '-') && relativeTo != null) {
    rel = str[0] === '+' ? 1 : -1;
    str = str.slice(1);
  }
  let parts;
  if (/[:;.]/.test(str)) parts = str.split(/[:;.]/).map((p) => parseInt(p || '0', 10));
  else {
    if (!/^\d+$/.test(str)) return null;
    if (rel) return relativeTo + rel * parseInt(str, 10);
    const s = str.padStart(8, '0').slice(-8);
    parts = [s.slice(0, 2), s.slice(2, 4), s.slice(4, 6), s.slice(6, 8)].map((p) => parseInt(p, 10));
  }
  if (parts.some((p) => isNaN(p))) return null;
  while (parts.length < 4) parts.unshift(0);
  const [hh, mm, ss, ff] = parts.slice(-4);
  let frames = ((hh * 60 + mm) * 60 + ss) * nom + ff;
  if (isDropFrame(fps)) {
    const dropPer = nom === 60 ? 4 : 2;
    const totalMinutes = hh * 60 + mm;
    frames -= dropPer * (totalMinutes - Math.floor(totalMinutes / 10));
  }
  if (rel) return relativeTo + rel * frames;
  return frames;
}

export function secondsToTC(sec, fps) {
  return framesToTC(Math.round(sec * fps), fps);
}

export function fmtSeconds(sec) {
  if (!isFinite(sec)) return '--';
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return m + ':' + s.toFixed(2).padStart(5, '0');
}
