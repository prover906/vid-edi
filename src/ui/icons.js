// Inline SVG icon set (20x20 viewBox, currentColor).

const S = (d, extra = '') => `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" ${extra}>${d}</svg>`;
const F = (d) => `<svg viewBox="0 0 20 20" fill="currentColor">${d}</svg>`;

export const ICONS = {
  // tools
  select: F('<path d="M5 2.5l10.5 9.8-5 .5 3 5.4-2 1.1-3-5.5-3.5 3.6z"/>'),
  trackFwd: F('<path d="M3 3l7 6.5-3.4.4 2 3.8-1.4.8-2-3.9L3 13z"/><path d="M11 5h2v10h-2zM14 7l4 3-4 3z"/>'),
  trackBack: F('<path d="M17 3l-7 6.5 3.4.4-2 3.8 1.4.8 2-3.9L17 13z"/><path d="M7 5h2v10H7zM6 7l-4 3 4 3z"/>'),
  ripple: S('<path d="M7 3v14M7 3h4M7 17h4"/><path d="M12 10h6M15 7l3 3-3 3"/>'),
  rolling: S('<path d="M10 3v14M5 3h10M5 17h10"/><path d="M2 10h5M13 10h5"/>'),
  rateStretch: S('<path d="M3 3v14M17 3v14"/><path d="M5 10h10M8 7l-3 3 3 3M12 7l3 3-3 3"/>'),
  razor: F('<path d="M3 15.5L13.6 4.9a1.5 1.5 0 012.1 0l.4.4a1.5 1.5 0 010 2.1L5.5 18H3z"/><path d="M2 18h3v1H2z" opacity=".6"/>'),
  slip: S('<path d="M4 4v12M16 4v12"/><path d="M7 7h6v6H7z"/><path d="M8 10H2M12 10h6" stroke-dasharray="1.5 1.5"/>'),
  slide: S('<path d="M2 5v10M18 5v10"/><rect x="6" y="6" width="8" height="8" rx="1"/><path d="M6 10H2M14 10h4"/>'),
  pen: F('<path d="M3 17l1.4-4.6L13 3.8l3.2 3.2-8.6 8.6L3 17zm2-2.1l1.6-.5-1.1-1.1-.5 1.6z"/>'),
  rect: S('<rect x="3.5" y="5" width="13" height="10" rx="1"/>'),
  ellipse: S('<ellipse cx="10" cy="10" rx="7" ry="5.5"/>'),
  hand: F('<path d="M7 3.5c.6 0 1 .4 1 1V9h.5V3c0-.6.4-1 1-1s1 .4 1 1v6h.5V3.8c0-.6.4-1 1-1s1 .4 1 1V10h.4V6c0-.6.4-1 1-1s1 .4 1 1v6.5c0 3.2-2.4 5.5-5.4 5.5-2 0-3.3-.8-4.6-2.4L3 11.6c-.4-.5-.3-1.1.2-1.4.5-.3 1.1-.2 1.4.2L6 12V4.5c0-.6.4-1 1-1z"/>'),
  zoom: S('<circle cx="8.5" cy="8.5" r="5"/><path d="M12.3 12.3l4.7 4.7M6.5 8.5h4M8.5 6.5v4"/>'),
  type: F('<path d="M4 3h12v3.5h-1.6l-.4-1.8h-3.1V15l1.8.5V17H7.3v-1.5l1.8-.5V4.7H6l-.4 1.8H4z"/>'),
  // transport
  play: F('<path d="M6 3.5v13l11-6.5z"/>'),
  pause: F('<path d="M5 3.5h3.5v13H5zM11.5 3.5H15v13h-3.5z"/>'),
  stop: F('<rect x="5" y="5" width="10" height="10"/>'),
  stepBack: F('<path d="M4 4h2v12H4zM17 4v12L7 10z"/>'),
  stepFwd: F('<path d="M14 4h2v12h-2zM3 4v12l10-6z"/>'),
  gotoIn: F('<path d="M3 4h2v12H3zM17 4v12l-9-6z"/><path d="M5 4h3v1.4H6.4v9.2H8V16H5z" opacity=".001"/>'),
  gotoOut: F('<path d="M15 4h2v12h-2zM3 4v12l9-6z"/>'),
  markIn: S('<path d="M12 3H7v14h5"/>', 'stroke-width="2"'),
  markOut: S('<path d="M8 3h5v14H8"/>', 'stroke-width="2"'),
  marker: F('<path d="M5 2h10v11l-5 5-5-5z"/>'),
  insert: S('<path d="M2 15h6M12 15h6"/><path d="M10 3v9M7 9l3 3 3-3"/><path d="M8 13h4v4H8z"/>'),
  overwrite: S('<path d="M2 15h16"/><path d="M10 3v8M7 8l3 3 3-3"/><rect x="7" y="13" width="6" height="4" fill="currentColor"/>'),
  lift: S('<path d="M2 16h5M13 16h5"/><path d="M10 13V4M7 7l3-3 3 3"/>'),
  extract: S('<path d="M2 16h16"/><path d="M10 13V4M7 7l3-3 3 3"/><path d="M6 16l4-2 4 2"/>'),
  camera: S('<path d="M3 6.5h3l1.5-2h5L14 6.5h3v9.5H3z"/><circle cx="10" cy="11" r="3"/>'),
  wrench: S('<path d="M12.6 3.2a4 4 0 00-4.9 5.2L3 13.1V17h3.9l4.7-4.7a4 4 0 005.2-4.9l-2.4 2.4-2.6-.6-.6-2.6z"/>'),
  plus: S('<path d="M10 4v12M4 10h12"/>'),
  minus: S('<path d="M4 10h12"/>'),
  loop: S('<path d="M5 7h9a3 3 0 010 6H9"/><path d="M11 11l-2 2 2 2"/><path d="M6 13a3 3 0 01-1-6"/>'),
  safe: S('<rect x="2.5" y="4" width="15" height="12"/><rect x="5" y="6" width="10" height="8" stroke-dasharray="1.5 1.2"/>'),
  playInOut: F('<path d="M2 4h1.6v12H2zM16.4 4H18v12h-1.6zM6 5v10l8-5z"/>'),
  playAround: F('<path d="M2 5l5 5-5 5zM8 4h4v12H8zM18 5l-5 5 5 5z"/>'),
  fullscreen: S('<path d="M3 7V3h4M13 3h4v4M17 13v4h-4M7 17H3v-4"/>'),
  compare: S('<rect x="2.5" y="5" width="6.5" height="10"/><rect x="11" y="5" width="6.5" height="10"/>'),
  // timeline
  magnet: S('<path d="M5 3v7a5 5 0 0010 0V3h-3.4v7a1.6 1.6 0 01-3.2 0V3z"/><path d="M5 6.5h3.4M11.6 6.5H15"/>'),
  link: S('<path d="M8.5 11.5a3 3 0 004.2 0l2.8-2.8a3 3 0 00-4.2-4.2l-1 1"/><path d="M11.5 8.5a3 3 0 00-4.2 0l-2.8 2.8a3 3 0 004.2 4.2l1-1"/>'),
  captions: S('<rect x="2.5" y="4.5" width="15" height="11" rx="1.5"/><path d="M8.5 8.4a2 2 0 100 3.2M14 8.4a2 2 0 100 3.2"/>'),
  nest: S('<rect x="3" y="3" width="14" height="14" rx="1"/><rect x="6" y="7" width="8" height="6" rx=".5"/>'),
  // track headers
  eye: S('<path d="M2 10s3-5.5 8-5.5S18 10 18 10s-3 5.5-8 5.5S2 10 2 10z"/><circle cx="10" cy="10" r="2.4"/>'),
  eyeOff: S('<path d="M2 10s3-5.5 8-5.5S18 10 18 10s-3 5.5-8 5.5S2 10 2 10z" opacity=".5"/><path d="M3 17L17 3"/>'),
  lock: S('<rect x="4.5" y="9" width="11" height="8" rx="1"/><path d="M7 9V6.5a3 3 0 016 0V9"/>'),
  unlock: S('<rect x="4.5" y="9" width="11" height="8" rx="1"/><path d="M7 9V6.5a3 3 0 015.8-1"/>'),
  syncLock: S('<path d="M5 8a5 5 0 019-2M15 12a5 5 0 01-9 2"/><path d="M14 3v3h-3M6 17v-3h3"/>'),
  mic: S('<rect x="7.5" y="2.5" width="5" height="9" rx="2.5"/><path d="M4.5 9.5a5.5 5.5 0 0011 0M10 15v3"/>'),
  // project
  listView: S('<path d="M7 5h10M7 10h10M7 15h10"/><circle cx="3.5" cy="5" r=".8" fill="currentColor"/><circle cx="3.5" cy="10" r=".8" fill="currentColor"/><circle cx="3.5" cy="15" r=".8" fill="currentColor"/>'),
  iconView: S('<rect x="3" y="3" width="6" height="6"/><rect x="11" y="3" width="6" height="6"/><rect x="3" y="11" width="6" height="6"/><rect x="11" y="11" width="6" height="6"/>'),
  freeform: S('<rect x="2.5" y="3" width="7" height="5"/><rect x="11" y="6" width="6.5" height="5"/><rect x="5" y="12" width="7" height="5"/>'),
  folder: F('<path d="M2 5a1 1 0 011-1h5l2 2h7a1 1 0 011 1v8a1 1 0 01-1 1H3a1 1 0 01-1-1z"/>'),
  folderOpen: F('<path d="M2 5a1 1 0 011-1h5l2 2h6a1 1 0 011 1v1H6.2a1.5 1.5 0 00-1.4 1L2 16z"/><path d="M5.6 9.5h13l-3 7H2.6z"/>'),
  newBin: S('<path d="M2.5 5.5a1 1 0 011-1h4l2 2h7a1 1 0 011 1v8a1 1 0 01-1 1h-13a1 1 0 01-1-1z"/><path d="M10 9v5M7.5 11.5h5"/>'),
  newItem: S('<path d="M5 2.5h7l3.5 3.5v11.5H5z"/><path d="M10 8.5v6M7 11.5h6"/>'),
  trash: S('<path d="M4 5.5h12M8 5.5V3.5h4v2M5.5 5.5l.8 11h7.4l.8-11"/>'),
  search: S('<circle cx="8.5" cy="8.5" r="5"/><path d="M12.3 12.3L17 17"/>'),
  automate: S('<path d="M3 5h8M3 9h8M3 13h5"/><path d="M12 12h6M15 9l3 3-3 3"/>'),
  sort: S('<path d="M6 4v12M3 13l3 3 3-3M14 16V4M11 7l3-3 3 3"/>'),
  film: F('<path d="M3 3h14v14H3zm1.5 1.5v2h2v-2zm0 4.5v2h2V9zm0 4.5v2h2v-2zm9-9v2h2v-2zm0 4.5v2h2V9zm0 4.5v2h2v-2zM8 5v10h4V5z"/>'),
  audioFile: F('<path d="M2 9h1.5v2H2zM4.5 7H6v6H4.5zM7 4h1.5v12H7zM9.5 6.5H11v7H9.5zM12 3h1.5v14H12zM14.5 7H16v6h-1.5zM17 8.5h1.5v3H17z"/>'),
  image: S('<rect x="2.5" y="3.5" width="15" height="13" rx="1"/><circle cx="7" cy="8" r="1.5"/><path d="M3 15l4.5-4.5 3 3 2-2L17 16"/>'),
  sequence: F('<path d="M2 4h9v3H2zM6 8.5h12v3H6zM3 13h8v3H3z"/>'),
  solid: F('<rect x="3" y="3" width="14" height="14" rx="1.5"/>'),
  adjustment: S('<rect x="3" y="3" width="14" height="14" rx="1.5" stroke-dasharray="2 1.5"/>'),
  graphic: F('<path d="M3 3h14v14H3zm3 3v1.8h3.1V15h1.8V7.8H14V6z"/>'),
  // effects
  fx: F('<text x="2" y="15" font-size="13" font-style="italic" font-weight="bold" font-family="Georgia,serif">fx</text>'),
  lightning: F('<path d="M11 2L4 11h5l-1 7 7-9h-5z"/>'),
  bit32: F('<text x="1" y="14" font-size="9.5" font-weight="bold" font-family="Arial">32</text>'),
  yuv: F('<text x="0" y="14" font-size="8" font-weight="bold" font-family="Arial">YUV</text>'),
  star: F('<path d="M10 2l2.4 5 5.4.6-4 3.7 1.1 5.4L10 14l-4.9 2.7 1.1-5.4-4-3.7 5.4-.6z"/>'),
  // misc
  chevRight: F('<path d="M7 4l6 6-6 6z"/>'),
  chevDown: F('<path d="M4 7h12l-6 6z"/>'),
  caret: F('<path d="M3 7h14l-7 7z"/>'),
  close: S('<path d="M5 5l10 10M15 5L5 15"/>'),
  menu: S('<path d="M3 5.5h14M3 10h14M3 14.5h14"/>'),
  stopwatch: S('<circle cx="10" cy="11" r="6"/><path d="M10 11V7.5M8 2.5h4M15 5.5l1.2-1.2"/>'),
  stopwatchOn: F('<circle cx="10" cy="11" r="6.5"/><path d="M8 1.8h4v1.6H8z"/><path d="M10 7v4.4" stroke="#1b1b1b" stroke-width="1.6"/>'),
  diamond: F('<path d="M10 3l7 7-7 7-7-7z"/>'),
  diamondOutline: S('<path d="M10 3.5l6.5 6.5-6.5 6.5L3.5 10z"/>'),
  kfPrev: F('<path d="M13 4v12L5 10z"/>'),
  kfNext: F('<path d="M7 4v12l8-6z"/>'),
  reset: S('<path d="M4.5 9a5.5 5.5 0 111.6 4.6"/><path d="M4 4.5V9h4.5"/>'),
  maskEllipse: S('<ellipse cx="10" cy="10" rx="7" ry="5"/>'),
  maskRect: S('<path d="M3.5 4.5h13v11h-13z"/>'),
  maskPen: F('<path d="M10 2l2.2 7.5L10 18 7.8 9.5zM10 8.2a1.3 1.3 0 100 2.6 1.3 1.3 0 000-2.6z"/>'),
  eyedropper: S('<path d="M12.5 3.5l4 4-1.5 1.5-4-4z"/><path d="M11.8 6.2l-7.3 7.3-.9 2.9 2.9-.9 7.3-7.3"/>'),
  gear: S('<circle cx="10" cy="10" r="2.6"/><path d="M10 2.5v2.2M10 15.3v2.2M2.5 10h2.2M15.3 10h2.2M4.7 4.7l1.6 1.6M13.7 13.7l1.6 1.6M4.7 15.3l1.6-1.6M13.7 6.3l1.6-1.6"/>'),
  exportIcon: S('<path d="M10 13V3M6.5 6.5L10 3l3.5 3.5"/><path d="M4 11v6h12v-6"/>'),
  importIcon: S('<path d="M10 3v10M6.5 9.5L10 13l3.5-3.5"/><path d="M4 11v6h12v-6"/>'),
  home: S('<path d="M3 9.5L10 3l7 6.5"/><path d="M5 8v9h4v-5h2v5h4V8"/>'),
  undo: S('<path d="M5 8h7a4 4 0 010 8H8"/><path d="M8 4.5L4.5 8 8 11.5"/>'),
  redo: S('<path d="M15 8H8a4 4 0 000 8h4"/><path d="M12 4.5L15.5 8 12 11.5"/>'),
  check: S('<path d="M4 10.5l4 4 8-9"/>'),
  info: S('<circle cx="10" cy="10" r="7"/><path d="M10 9v5M10 6.2v.2"/>'),
  waveform: S('<path d="M2 10h2l2-5 3 10 3-12 3 9 1.5-2H18"/>'),
  speaker: S('<path d="M3 8h3l4-3.5v11L6 12H3z"/><path d="M13 7.5a3.5 3.5 0 010 5M15 5a7 7 0 010 10"/>'),
  scissors: S('<circle cx="5.5" cy="6" r="2.5"/><circle cx="5.5" cy="14" r="2.5"/><path d="M7.5 7.5L17 15M7.5 12.5L17 5"/>'),
  copy: S('<rect x="6.5" y="6.5" width="10" height="10" rx="1"/><path d="M3.5 13.5v-10h10"/>'),
  grid: S('<path d="M2.5 7h15M2.5 13h15M7 2.5v15M13 2.5v15"/>'),
  transparency: F('<path d="M3 3h4v4H3zM11 3h4v4h-4zM7 7h4v4H7zM15 7h2v4h-2zM3 11h4v4H3zM11 11h4v4h-4zM7 15h4v2H7zM15 15h2v2h-2z"/>'),
  palette: S('<path d="M10 2.5a7.5 7.5 0 000 15c1.2 0 1.6-.9 1.2-1.8-.5-1-.1-2.2 1.2-2.2h1.6A3.5 3.5 0 0017.5 10 7.5 7.5 0 0010 2.5z"/><circle cx="6.5" cy="9" r="1" fill="currentColor"/><circle cx="9" cy="6" r="1" fill="currentColor"/><circle cx="12.8" cy="6.8" r="1" fill="currentColor"/>'),
  text: F('<path d="M3 3h14v3h-1.5l-.5-1.5h-3.6V15.5l1.6.5V17H7v-1l1.6-.5V4.5H5L4.5 6H3z"/>'),
};

export function icon(name, cls = '') {
  const span = document.createElement('span');
  span.className = 'ico ' + cls;
  span.style.display = 'inline-flex';
  span.innerHTML = ICONS[name] || ICONS.info;
  const svg = span.firstChild;
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  return span;
}

export function iconHTML(name) {
  return ICONS[name] || '';
}
