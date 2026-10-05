// Modal dialogs, prompts, confirmations, toasts.

import { h } from '../core/util.js';
import { app } from '../core/app.js';
import { icon } from './icons.js';

let modalDepth = 0;
export const isModalOpen = () => modalDepth > 0;

export function modal({ title, body, buttons = [{ label: 'OK', cta: true }], width, onClose, footLeft }) {
  const back = h('div.modal-back');
  const bodyEl = h('div.modal-body');
  if (typeof body === 'string') bodyEl.innerHTML = body;
  else if (body) bodyEl.appendChild(body);
  const foot = h('div.modal-foot');
  if (footLeft) foot.appendChild(h('div.left', footLeft));
  const box = h('div.modal', { role: 'dialog', 'aria-label': title }, h('div.modal-title', title, h('button.ibtn.x', { title: 'Close', onclick: () => close(null) }, icon('close'))), bodyEl, foot);
  if (width) box.style.width = width + 'px';
  back.appendChild(box);
  let closed = false;
  modalDepth++;
  const close = (result) => {
    if (closed) return;
    closed = true;
    modalDepth--;
    back.remove();
    window.removeEventListener('keydown', onKey, true);
    onClose && onClose(result);
  };
  const btnEls = [];
  for (const b of buttons) {
    const el = h('button.btn' + (b.cta ? '.cta' : '') + (b.warn ? '.warn' : ''), b.label);
    el.addEventListener('click', async () => {
      if (b.action) {
        const r = await b.action(close);
        if (r === false) return;
      }
      close(b.value ?? b.label);
    });
    foot.appendChild(el);
    btnEls.push(el);
  }
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      e.preventDefault();
      close(null);
    } else if (e.key === 'Enter' && !(e.target && e.target.tagName === 'TEXTAREA')) {
      const i = buttons.findIndex((b) => b.cta);
      if (i >= 0) {
        e.preventDefault();
        e.stopPropagation();
        btnEls[i].click();
      }
    } else e.stopPropagation();
  };
  window.addEventListener('keydown', onKey, true);
  back.addEventListener('pointerdown', (e) => {
    if (e.target === back) e.stopPropagation();
  });
  document.getElementById('overlay-root').appendChild(back);
  setTimeout(() => {
    const f = bodyEl.querySelector('input, select, textarea');
    if (f) {
      f.focus();
      if (f.select) f.select();
    }
  }, 30);
  return { close, el: box, body: bodyEl, buttons: btnEls };
}

export function confirmDialog(message, { title = 'Vid-Edi', ok = 'OK', cancel = 'Cancel', warn = false } = {}) {
  return new Promise((resolve) => {
    modal({
      title,
      body: h('div', { style: { maxWidth: '420px', whiteSpace: 'pre-wrap' } }, message),
      buttons: [{ label: cancel, value: false }, { label: ok, cta: !warn, warn, value: true }],
      onClose: (r) => resolve(r === true),
    });
  });
}

export function promptDialog(title, label, value = '') {
  return new Promise((resolve) => {
    const inp = h('input', { type: 'text', value, style: { width: '100%' } });
    modal({
      title,
      body: h('div', h('div.muted', { style: { marginBottom: '6px' } }, label), inp),
      buttons: [{ label: 'Cancel', value: null }, { label: 'OK', cta: true, action: () => resolve(inp.value) }],
      onClose: (r) => {
        if (r === null) resolve(null);
      },
    });
  });
}

export function alertDialog(message, title = 'Vid-Edi') {
  return new Promise((resolve) => {
    modal({ title, body: h('div', { style: { maxWidth: '460px', whiteSpace: 'pre-wrap' } }, message), buttons: [{ label: 'OK', cta: true }], onClose: () => resolve() });
  });
}

export function initToasts() {
  const host = h('div.toasts');
  document.body.appendChild(host);
  app.bus.on('toast', ({ msg, kind, ms }) => {
    const t = h('div.toast.' + kind, msg);
    host.appendChild(t);
    setTimeout(() => {
      t.style.transition = 'opacity .3s';
      t.style.opacity = '0';
      setTimeout(() => t.remove(), 320);
    }, ms);
  });
}

// Form helpers
export function row(label, control, cls = '') {
  return h('div.form-row' + cls, h('label', label), control);
}
