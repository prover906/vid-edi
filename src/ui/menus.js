// Context menus, popup menus and the application menubar.

import { h } from '../core/util.js';
import { LABEL_COLORS } from '../core/model.js';

let openRoot = null;

export function closeMenus() {
  if (openRoot) {
    openRoot.close();
    openRoot = null;
  }
}

function buildMenuEl(items, onPick, depth = 0) {
  const el = h('div.ctx-menu');
  let subOpen = null;
  const closeSub = () => {
    if (subOpen) {
      subOpen.el.remove();
      subOpen.item.classList.remove('open');
      subOpen = null;
    }
  };
  for (const it of items) {
    if (!it) continue;
    if (it.sep) {
      el.appendChild(h('div.ctx-sep'));
      continue;
    }
    if (it.header) {
      el.appendChild(h('div.ctx-head', it.header));
      continue;
    }
    const row = h('div.ctx-item' + (it.disabled ? '.disabled' : '') + (it.submenu ? '.has-sub' : ''));
    if (it.checked) row.appendChild(h('span.check', '✓'));
    if (it.color) row.appendChild(h('span.swatch-sm', { style: { background: it.color } }));
    row.appendChild(h('span', it.label));
    if (it.kbd) row.appendChild(h('span.kbd', it.kbd));
    row.addEventListener('mouseenter', () => {
      closeSub();
      if (it.submenu && !it.disabled) {
        const subItems = typeof it.submenu === 'function' ? it.submenu() : it.submenu;
        const sub = buildMenuEl(subItems, onPick, depth + 1);
        document.body.appendChild(sub.el);
        const r = row.getBoundingClientRect();
        placeEl(sub.el, r.right - 2, r.top - 4, r.left + 2);
        row.classList.add('open');
        subOpen = { el: sub.el, item: row, sub };
      }
    });
    row.addEventListener('mouseup', (e) => {
      if (it.disabled || it.submenu) return;
      e.stopPropagation();
      onPick(it);
    });
    el.appendChild(row);
  }
  return { el, closeSub: () => closeSub() };
}

function placeEl(el, x, y, altX = null) {
  el.style.left = '0px';
  el.style.top = '0px';
  const r = el.getBoundingClientRect();
  let nx = x, ny = y;
  if (nx + r.width > window.innerWidth - 4) nx = altX != null ? altX - r.width : window.innerWidth - r.width - 4;
  if (ny + r.height > window.innerHeight - 4) ny = Math.max(4, window.innerHeight - r.height - 4);
  el.style.left = Math.max(4, nx) + 'px';
  el.style.top = ny + 'px';
}

export function showMenu(x, y, items, opts = {}) {
  closeMenus();
  const all = [];
  const pick = (it) => {
    closeMenus();
    try {
      it.action && it.action();
    } catch (err) {
      console.error(err);
    }
  };
  const root = buildMenuEl(items, pick);
  all.push(root.el);
  document.body.appendChild(root.el);
  placeEl(root.el, x, y);
  if (opts.minWidth) root.el.style.minWidth = opts.minWidth + 'px';
  const onDown = (e) => {
    if (e.target.closest && e.target.closest('.ctx-menu')) return;
    if (opts.anchor && opts.anchor.contains(e.target)) return;
    closeMenus();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeMenus();
    }
  };
  setTimeout(() => {
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
  }, 0);
  openRoot = {
    close() {
      document.querySelectorAll('.ctx-menu').forEach((m) => m.remove());
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
      opts.onClose && opts.onClose();
    },
  };
  return openRoot;
}

export function showMenuAt(anchor, items, opts = {}) {
  const r = anchor.getBoundingClientRect();
  return showMenu(r.left, r.bottom + 2, items, { ...opts, anchor });
}

export function labelMenu(current, onPick) {
  return Object.entries(LABEL_COLORS).map(([name, color]) => ({ label: name, color, checked: current === name, action: () => onPick(name) }));
}

// ---- Menubar ----
export function buildMenubar(container, menus, extras) {
  container.innerHTML = '';
  container.appendChild(h('div.logo', h('span', 'Ve')));
  let active = null;
  const open = (item, m) => {
    closeMenus();
    item.classList.add('open');
    active = item;
    const r = item.getBoundingClientRect();
    showMenu(r.left, r.bottom, m.items(), {
      anchor: container,
      onClose: () => {
        item.classList.remove('open');
        if (active === item) active = null;
      },
    });
  };
  for (const m of menus) {
    const item = h('div.mb-item', m.label);
    item.addEventListener('mousedown', (e) => {
      e.preventDefault();
      if (active === item) closeMenus();
      else open(item, m);
    });
    item.addEventListener('mouseenter', () => {
      if (active && active !== item) open(item, m);
    });
    container.appendChild(item);
  }
  container.appendChild(h('div.spacer'));
  if (extras) container.appendChild(extras);
}
