// Instant in-game tooltips (ant17/polish). Replaces the slow native `title=` popup.
// Any element with a data-tip attribute shows the tip on hover / keyboard focus / touch hold, with zero delay.
//   Tip.set(el, text)   sets data-tip + aria-label and removes the native title (cheap to call on every HUD refresh)
//   Tip.format(text)    pure: text -> { head, why, lines }  ("Name [K]: sentence. Sentence. Greyed: reason.")
// The text's first "Name [KEY]: " part is bold; a "Greyed: ..." / "Not ready: ..." sentence is pulled up to lead.
(function (root) {
  const doc = root.document;
  const WHY = /^(Greyed|Not ready|Locked|Busy)\b/;
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  function format(text) {
    let head = '', body = String(text == null ? '' : text);
    const nl = body.indexOf('\n');
    if (nl >= 0) { head = body.slice(0, nl); body = body.slice(nl + 1); }
    else {
      const i = body.indexOf(': ');
      if (i > 0 && i <= 48) { head = body.slice(0, i); body = body.slice(i + 2); }
    }
    const lines = body.split(/\n|(?<=[.!?])\s+(?=[A-Z0-9(])/).map(s => s.trim()).filter(Boolean);
    const why = lines.filter(l => WHY.test(l)), rest = lines.filter(l => !WHY.test(l));
    return { head, why, lines: rest };
  }
  const html = f => (f.head ? `<b class="tip-h">${esc(f.head)}</b>` : '') +
    f.why.map(l => `<div class="tip-why">${esc(l)}</div>`).join('') + f.lines.map(l => `<div>${esc(l)}</div>`).join('');

  // Sets (or clears, with a falsy text) the tip. Safe on any element; skips the DOM when nothing changed.
  function set(el, text) {
    if (!el) return;
    if (!text) { if (el.dataset && el.dataset.tip) delete el.dataset.tip; return; }
    if (el.dataset.tip !== text) el.dataset.tip = text;
    if (el.setAttribute && el.getAttribute && el.getAttribute('aria-label') !== text) el.setAttribute('aria-label', text);
    if (el.removeAttribute && el.hasAttribute && el.hasAttribute('title')) el.removeAttribute('title');
  }

  const api = { format, set, html };
  root.Tip = api;
  if (!doc || !doc.addEventListener) return;

  const css = doc.createElement('style');
  css.textContent = `#tip { position: fixed; left: 0; top: 0; z-index: 60; max-width: 280px; pointer-events: none; display: none;
      background: rgba(28, 22, 16, .96); color: #f4efe6; border: 1px solid #c9a24a; border-radius: 8px; padding: 6px 10px;
      font-size: 12.5px; line-height: 1.4; font-family: inherit; box-shadow: 0 4px 14px rgba(0,0,0,.5); text-align: left; white-space: normal; }
    #tip .tip-h { display: block; color: #ffcf5a; font-size: 13px; margin-bottom: 2px; }
    #tip .tip-why { color: #ff9a8a; font-weight: 700; margin-bottom: 2px; }
    #tip div { margin-top: 1px; }`;
  doc.head.appendChild(css);
  const box = doc.createElement('div');
  box.id = 'tip'; box.setAttribute('role', 'tooltip');
  let cur = null, px = -1, py = -1, mode = '', holdTimer = 0, hideTimer = 0, refreshTimer = 0, shownHtml = '';
  const mount = () => doc.body.appendChild(box);
  if (doc.body) mount(); else root.addEventListener('DOMContentLoaded', mount);

  const tipOf = t => (t && t.closest ? t.closest('[data-tip]') : null);
  const textOf = el => (el && el.dataset && el.dataset.tip) || '';

  function hide() {
    cur = null; mode = ''; shownHtml = '';
    root.clearTimeout(holdTimer); root.clearTimeout(hideTimer);
    box.style.display = 'none';
  }
  function place(el) {
    const r = el.getBoundingClientRect(), w = box.offsetWidth, h = box.offsetHeight, vw = root.innerWidth, vh = root.innerHeight;
    let x = r.left + r.width / 2 - w / 2;
    x = Math.max(6, Math.min(x, vw - w - 6));
    let y = r.top - h - 8; // above by default; flip below when it does not fit
    if (y < 6) y = Math.min(r.bottom + 8, vh - h - 6);
    box.style.left = Math.round(x) + 'px'; box.style.top = Math.round(Math.max(6, y)) + 'px';
  }
  // Show el's current text. A repeat call with the same text only repositions; nothing is rewritten, so a HUD
  // rebuild never makes the tip flicker.
  function show(el, m) {
    const txt = textOf(el);
    if (!txt) { hide(); return; }
    cur = el; mode = m;
    const h = html(format(txt));
    if (h !== shownHtml) { box.innerHTML = h; shownHtml = h; }
    box.style.display = 'block';
    place(el);
  }

  // After the HUD rebuilt: the hovered element may be a new node. Re-find it under the pointer (or by focus).
  function refresh() {
    refreshTimer = 0;
    if (!cur) return;
    let el = cur.isConnected !== false && textOf(cur) ? cur : null;
    if (!el && mode === 'hover' && doc.elementFromPoint) el = tipOf(doc.elementFromPoint(px, py));
    if (!el && mode === 'focus') el = tipOf(doc.activeElement);
    if (!el) { hide(); return; }
    show(el, mode);
  }
  const schedule = () => { if (cur && !refreshTimer) refreshTimer = root.setTimeout(refresh, 0); };
  if (root.MutationObserver) new root.MutationObserver(schedule).observe(doc.documentElement || doc.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-tip', 'class', 'disabled'] });

  doc.addEventListener('mousemove', e => { px = e.clientX; py = e.clientY; });
  doc.addEventListener('mouseover', e => {
    px = e.clientX; py = e.clientY;
    const el = tipOf(e.target);
    if (el) show(el, 'hover'); else if (mode === 'hover') hide();
  });
  doc.addEventListener('mouseout', e => {
    if (mode !== 'hover' || !cur) return;
    const to = e.relatedTarget;
    if (to && cur.contains && cur.contains(to)) return;
    if (tipOf(to)) return; // the mouseover of the next element shows its own tip
    hide();
  });
  doc.addEventListener('focusin', e => { const el = tipOf(e.target); if (el && mode !== 'hover') show(el, 'focus'); });
  doc.addEventListener('focusout', () => { if (mode === 'focus') hide(); });
  doc.addEventListener('scroll', hide, true);
  doc.addEventListener('mousedown', e => { if (cur && !(cur.contains && cur.contains(e.target))) hide(); });
  doc.addEventListener('keydown', e => { if (e.key === 'Escape' && cur) hide(); });
  // Touch: hold for ~0.35 s to read; it fades 2.5 s after letting go. A normal tap or a drag shows nothing.
  doc.addEventListener('touchstart', e => {
    root.clearTimeout(holdTimer);
    const el = tipOf(e.target);
    if (!el) { hide(); return; }
    holdTimer = root.setTimeout(() => show(el, 'touch'), 350);
  }, { passive: true });
  const touchEnd = () => { root.clearTimeout(holdTimer); if (mode === 'touch') { root.clearTimeout(hideTimer); hideTimer = root.setTimeout(hide, 2500); } };
  doc.addEventListener('touchend', touchEnd, { passive: true });
  doc.addEventListener('touchcancel', touchEnd, { passive: true });
  doc.addEventListener('touchmove', () => { if (mode !== 'touch') root.clearTimeout(holdTimer); }, { passive: true });
  api._state = () => ({ cur, mode, visible: box.style.display === 'block', html: shownHtml });
  api._refresh = refresh;
})(typeof window !== 'undefined' ? window : globalThis);
