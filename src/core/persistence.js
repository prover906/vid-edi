// Persistence: IndexedDB autosave (project JSON + media blobs), .vproj files and bundles.

import { app } from './app.js';
import { h, debounce, downloadBlob, pickFiles, fmtBytes, uid } from './util.js';
import { createProject, findItem } from './model.js';
import { restoreItem } from './media.js';
import { modal, confirmDialog, promptDialog } from '../ui/dialogs.js';
import { sources } from '../engine/sources.js';

const DB_NAME = 'videdi';
const MAGIC = 'VEPB';
let dbp = null;

function db() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('projects')) d.createObjectStore('projects', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('media')) d.createObjectStore('media', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}
async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const s = t.objectStore(store);
    let res;
    const r = fn(s);
    if (r && 'onsuccess' in r) r.onsuccess = () => (res = r.result);
    t.oncomplete = () => resolve(res);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

function projectJSON() {
  return JSON.stringify(app.project);
}

export const persist = {
  saving: false,
  lastSaved: 0,

  init() {
    const auto = debounce(() => this.saveNow(false), 1500);
    app.bus.on('dirty', () => auto());
    window.addEventListener('beforeunload', () => {
      if (app.dirty) this.saveNow(false);
    });
  },

  async saveNow(user = false) {
    try {
      const p = app.project;
      await tx('projects', 'readwrite', (s) => s.put({ id: p.id, name: p.name, json: projectJSON(), updated: Date.now() }));
      localStorage.setItem('videdi.currentProject', p.id);
      app.dirty = false;
      this.lastSaved = Date.now();
      app.bus.emit('saved');
      if (user) app.toast('Project saved to browser storage', 'ok', 1600);
    } catch (e) {
      console.error(e);
      if (user) app.toast('Could not save project: ' + e.message, 'error');
    }
  },

  async saveMedia(itemId, file) {
    if (!file) return;
    try {
      await tx('media', 'readwrite', (s) => s.put({ id: itemId, projectId: app.project.id, name: file.name, type: file.type, blob: file }));
    } catch (e) {
      console.warn('media store failed', e);
      app.toast('Browser storage is full: media will need relinking after reload.', 'warn', 5000);
    }
  },

  async deleteMedia(itemId) {
    try {
      // keep blob if another item references the same file object
      await tx('media', 'readwrite', (s) => s.delete(itemId));
    } catch (e) {
      /* ignore */
    }
  },

  async getMedia(itemId) {
    try {
      return await tx('media', 'readonly', (s) => s.get(itemId));
    } catch (e) {
      return null;
    }
  },

  async listProjects() {
    try {
      const all = await tx('projects', 'readonly', (s) => s.getAll());
      return (all || []).sort((a, b) => b.updated - a.updated);
    } catch (e) {
      return [];
    }
  },

  async loadProjectById(id) {
    const rec = await tx('projects', 'readonly', (s) => s.get(id));
    if (!rec) return false;
    const project = JSON.parse(rec.json);
    await this.applyProject(project, 'Open Project');
    return true;
  },

  async applyProject(project, label, mediaFiles = null) {
    // dispose old runtime
    for (const [id, rt] of app.runtime) {
      if (rt.url) URL.revokeObjectURL(rt.url);
      sources.disposeItem(id);
    }
    app.runtime.clear();
    project.luts = project.luts || {};
    project.openSequenceIds = project.openSequenceIds || [];
    project.counters = project.counters || { sequence: 0, bin: 0 };
    const medias = project.items.filter((i) => i.type === 'media');
    app.setProject(project, label);
    let n = 0;
    for (const it of medias) {
      n++;
      app.status(`Loading media ${n}/${medias.length}…`);
      let file = mediaFiles ? mediaFiles.get(it.id) : null;
      if (!file) {
        const rec = await this.getMedia(it.id);
        if (rec && rec.blob) file = rec.blob instanceof File ? rec.blob : new File([rec.blob], rec.name || it.name, { type: rec.type || it.mime });
      } else this.saveMedia(it.id, file);
      if (file) {
        const ok = await restoreItem(it, file);
        if (!ok) it.offline = true;
      } else it.offline = true;
    }
    app.history.reset(label);
    app.status(medias.some((m) => m.offline) ? 'Some media is offline — use File › Link Media' : '');
    app.bus.emit('project:changed', { loaded: true });
    app.bus.emit('time:changed', { seq: app.seq });
    localStorage.setItem('videdi.currentProject', project.id);
    this.saveNow(false);
  },

  async newProject() {
    const name = await promptDialog('New Project', 'Project name:', 'Untitled');
    if (name == null) return;
    await this.saveNow(false);
    const p = createProject(name || 'Untitled');
    await this.applyProject(p, 'New Project');
    app.services.start?.hide();
  },

  async openDialog() {
    const list = await this.listProjects();
    const body = h('div', { style: { width: '460px' } });
    const rows = h('div.recent-list', { style: { maxHeight: '320px', overflow: 'auto' } });
    let dlg;
    for (const r of list) {
      const row = h('div.recent-row', h('span', '🎬'), h('span', r.name || 'Untitled', r.id === app.project.id ? h('span.muted', ' (open)') : ''), h('span.meta', new Date(r.updated).toLocaleString()));
      row.onclick = async () => {
        dlg.close();
        await this.saveNow(false);
        await this.loadProjectById(r.id);
        app.services.start?.hide();
      };
      const del = h('button.ibtn', { title: 'Delete from browser', onclick: async (e) => { e.stopPropagation(); if (await confirmDialog('Delete project "' + r.name + '" from this browser?', { warn: true, ok: 'Delete' })) { await this.deleteProject(r.id); row.remove(); } } }, '✕');
      row.appendChild(del);
      rows.appendChild(row);
    }
    if (!list.length) rows.appendChild(h('div.muted', 'No projects saved in this browser yet.'));
    body.append(h('div.muted', { style: { marginBottom: '8px' } }, 'Projects stored in this browser:'), rows);
    dlg = modal({ title: 'Open Project', body, buttons: [{ label: 'Open File…', action: async () => { const f = await pickFiles({ accept: '.vproj,.json', multiple: false }); if (f[0]) await this.openProjectFile(f[0]); } }, { label: 'Cancel' }] });
  },

  async deleteProject(id) {
    const rec = await tx('projects', 'readonly', (s) => s.get(id));
    if (rec) {
      const p = JSON.parse(rec.json);
      for (const it of p.items) if (it.type === 'media') await this.deleteMedia(it.id);
    }
    await tx('projects', 'readwrite', (s) => s.delete(id));
  },

  async recentMenu() {
    return [];
  },

  saveAs() {
    const blob = new Blob([JSON.stringify({ ...app.project, savedAt: Date.now() }, null, 1)], { type: 'application/json' });
    downloadBlob(blob, (app.project.name || 'Untitled') + '.vproj');
    app.toast('Project file downloaded (media is referenced, not embedded)', 'ok');
  },

  async saveBundle() {
    const medias = app.project.items.filter((i) => i.type === 'media' && app.rt(i.id).file);
    const header = { project: app.project, media: [] };
    const parts = [];
    let offset = 0;
    for (const m of medias) {
      const f = app.rt(m.id).file;
      header.media.push({ id: m.id, name: f.name || m.name, type: f.type, offset, size: f.size });
      parts.push(f);
      offset += f.size;
    }
    const hjson = new TextEncoder().encode(JSON.stringify(header));
    const lenBuf = new Uint8Array(4);
    new DataView(lenBuf.buffer).setUint32(0, hjson.length, true);
    const blob = new Blob([MAGIC, lenBuf, hjson, ...parts], { type: 'application/octet-stream' });
    downloadBlob(blob, (app.project.name || 'Untitled') + ' (with media).vproj');
    app.toast(`Project bundle downloaded (${fmtBytes(blob.size)})`, 'ok');
  },

  async openProjectFile(file) {
    const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
    const magic = String.fromCharCode(...head.slice(0, 4));
    try {
      if (magic === MAGIC) {
        const len = new DataView(head.buffer).getUint32(4, true);
        const header = JSON.parse(await file.slice(8, 8 + len).text());
        const base = 8 + len;
        const files = new Map();
        for (const m of header.media) files.set(m.id, new File([file.slice(base + m.offset, base + m.offset + m.size)], m.name, { type: m.type }));
        await this.saveNow(false);
        await this.applyProject(header.project, 'Open Project', files);
      } else {
        const p = JSON.parse(await file.text());
        if (p.format !== 'vid-edi-project') throw new Error('Not a Vid-Edi project file');
        await this.saveNow(false);
        // Try to reuse stored media blobs for same item ids (re-opened exports)
        await this.applyProject(p, 'Open Project');
      }
      app.services.start?.hide();
      app.toast('Opened ' + file.name, 'ok');
    } catch (e) {
      console.error(e);
      app.toast('Could not open project: ' + e.message, 'error');
    }
  },

  async relinkItem(item) {
    const files = await pickFiles({ accept: item.kind === 'image' ? 'image/*' : item.kind === 'audio' ? 'audio/*' : 'video/*', multiple: false });
    if (!files[0]) return;
    const ok = await restoreItem(item, files[0]);
    if (ok) {
      item.name = item.name || files[0].name;
      this.saveMedia(item.id, files[0]);
      app.changed();
      app.bus.emit('media:updated', item.id);
      app.toast('Media linked', 'ok');
    } else app.toast('Could not read ' + files[0].name, 'error');
  },

  async linkOffline() {
    const offline = app.project.items.filter((i) => i.type === 'media' && i.offline);
    if (!offline.length) return app.toast('No offline media in this project', 'info');
    const files = await pickFiles({ multiple: true });
    let n = 0;
    for (const f of files) {
      const it = offline.find((o) => o.offline && o.name === f.name) || (files.length === 1 ? offline.find((o) => o.offline) : null);
      if (!it) continue;
      if (await restoreItem(it, f)) {
        this.saveMedia(it.id, f);
        n++;
      }
    }
    app.changed();
    app.toast(`Linked ${n} of ${offline.length} offline item(s)`, n ? 'ok' : 'warn');
  },

  makeOffline(item) {
    const rt = app.rt(item.id);
    if (rt.url) URL.revokeObjectURL(rt.url);
    sources.disposeItem(item.id);
    app.runtime.delete(item.id);
    app.edit('Make Offline', () => (findItem(app.project, item.id).offline = true));
  },

  async restoreLast() {
    const id = localStorage.getItem('videdi.currentProject');
    if (!id) return false;
    try {
      return await this.loadProjectById(id);
    } catch (e) {
      console.warn('restore failed', e);
      return false;
    }
  },
};

export { uid };
