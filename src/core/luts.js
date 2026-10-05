// .cube LUT import for Lumetri "Input LUT".

import { app } from './app.js';
import { uid, pickFiles } from './util.js';
import { parseCube } from '../engine/lumetri.js';

function toBase64(u8) {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) s += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
  return btoa(s);
}

export const luts = {
  async importCube(file) {
    try {
      const { size, data } = parseCube(await file.text());
      const id = uid('lut_');
      app.edit('Import LUT', () => {
        app.project.luts = app.project.luts || {};
        app.project.luts[id] = { name: file.name.replace(/\.cube$/i, ''), size, data: toBase64(data) };
      });
      app.toast('LUT imported: ' + file.name, 'ok');
      return id;
    } catch (e) {
      app.toast('LUT import failed: ' + e.message, 'error');
      return null;
    }
  },
  async browse() {
    const files = await pickFiles({ accept: '.cube', multiple: false });
    if (!files[0]) return null;
    return this.importCube(files[0]);
  },
};
