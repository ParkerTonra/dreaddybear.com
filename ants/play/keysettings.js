// ant18/keymap: the "Keys" section of the Settings panel (click a key to rebind it) plus live key hints.
//
// Mount point: if the page already has the ant18/ui Settings popup (#settings, made by settings.js) the section is
// appended to it. Otherwise this file makes a minimal stand-in: a keyboard button (#keys-btn) and its own popup
// (#keys-pop). So this file works on its own and merges cleanly with settings.js later; load it AFTER settings.js.
// Rebinding rules live in keys.js (Keys.check): no duplicate chord, no browser-reserved chord, no chord reserved for
// a later lane, and the choice is stored in localStorage (try/catch) under Keys.STORE_KEY.
(function (root) {
  const doc = root.document;
  if (!doc || typeof Keys === 'undefined') return;

  // Hints that follow rebinding: <small data-key-hint="spawn.worker">[Z]</small>, <kbd data-key-hint="evo.dmg">T</kbd>
  function refreshHints() {
    for (const el of doc.querySelectorAll('[data-key-hint]')) {
      const l = Keys.label(el.getAttribute('data-key-hint'));
      el.textContent = el.tagName === 'SMALL' ? `[${l}]` : l;
    }
  }

  const css = doc.createElement('style');
  css.textContent = `
    #keys-btn { position: fixed; top: 10px; right: 100px; z-index: 20; padding: 6px 11px; font-size: 16px; line-height: 1; background: var(--panel); border: 1px solid #5a4a36; color: var(--ink); border-radius: 8px; }
    #keys-pop { position: fixed; top: 48px; right: 10px; z-index: 30; width: min(360px, calc(100vw - 20px)); max-height: 80vh; overflow: auto; background: var(--panel); border: 1px solid #5a4a36; border-radius: 10px; padding: 10px 12px; }
    #keys-pop.hidden { display: none; }
    #set-keys h3 { margin: 10px 0 4px; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; opacity: .7; }
    #set-keys .krow { display: grid; grid-template-columns: 1fr auto auto; gap: 6px; align-items: center; margin: 2px 0; font-size: 13px; }
    #set-keys .kbind { min-width: 84px; font: 600 12px system-ui, sans-serif; }
    #set-keys .kbind.listening { outline: 2px solid #5ab0ff; }
    #set-keys .kbind.custom { color: #ffd070; }
    #set-keys .kreset { padding: 2px 7px; }
    #set-keys .kmsg { min-height: 1.3em; font-size: 12px; color: #ff9a7a; margin: 6px 0 2px; }
    #set-keys small { display: block; opacity: .75; font-size: 11px; margin-top: 4px; }`;
  doc.head.appendChild(css);

  let section = null, msg = null, listening = null; // listening = { id, btn, stop }

  function setMsg(t) { if (msg) msg.textContent = t || ''; }

  function stopListening() {
    if (!listening) return;
    const l = listening; listening = null;
    Keys.setCapturing(false);
    root.removeEventListener('keydown', l.onKey, true);
    root.removeEventListener('blur', l.stop);
    l.btn.classList.remove('listening');
    render();
  }

  function listen(id, btn) {
    stopListening();
    setMsg('');
    const onKey = e => {
      e.preventDefault(); e.stopImmediatePropagation();
      if (e.repeat) return;
      const k = Keys.fromEvent(e);
      if (k.code === 'Escape' && !k.ctrl && !k.alt && !k.meta) { stopListening(); setMsg('Cancelled.'); return; }
      if (/^(Control|Shift|Alt|Meta|OS)/.test(e.code || '')) return; // wait for the real key
      Keys.setCapturing(false); // check() and set() must see the live table, not the listening state
      const r = Keys.set(id, k);
      Keys.setCapturing(true);
      if (!r.ok) { setMsg(r.reason); return; } // stay listening so a second try is one key press
      setMsg(`${Keys.byId[id].label}: ${Keys.label(id)}`);
      stopListening();
    };
    const stop = () => stopListening();
    listening = { id, btn, onKey, stop };
    Keys.setCapturing(true);
    btn.classList.add('listening');
    btn.textContent = 'Press a key…';
    setMsg('Press the new key (Esc cancels).');
    root.addEventListener('keydown', onKey, true);
    root.addEventListener('blur', stop);
  }

  function render() {
    if (!section) return;
    const groups = [];
    for (const a of Keys.ACTIONS) {
      if (!a.rebind && a.id !== 'group.recall' && a.id !== 'group.save') continue;
      let g = groups.find(x => x.name === a.group);
      if (!g) groups.push(g = { name: a.group, list: [] });
      g.list.push(a);
    }
    const rows = groups.map(g => `<h3>${g.name}</h3>` + g.list.map(a => {
      const fixed = !a.rebind;
      return `<div class="krow"><span>${a.label}</span>` +
        `<button class="kbind${Keys.isDefault(a.id) ? '' : ' custom'}" data-id="${a.id}"${fixed ? ' disabled aria-disabled="true"' : ''} aria-label="${a.label}: ${Keys.label(a.id)}${fixed ? ', fixed' : '. Click to rebind'}">${Keys.label(a.id)}</button>` +
        `<button class="kreset" data-reset="${a.id}" aria-label="Reset ${a.label} to default"${Keys.isDefault(a.id) ? ' disabled' : ''}>↺</button></div>`;
    }).join('')).join('');
    section.innerHTML = `<h3>Keys</h3>${rows}<div class="kmsg" role="status" aria-live="polite"></div>` +
      '<button class="kall">Reset all keys</button><small>Click a key, then press the new one. Keys are physical positions (QWERTY names). Browser chords and chords held back for future features are refused.</small>';
    msg = section.querySelector('.kmsg');
  }

  const mount = () => {
    section = doc.createElement('section');
    section.id = 'set-keys';
    section.addEventListener('click', e => {
      const t = e.target.closest && e.target.closest('button');
      if (!t) return;
      if (t.dataset.id) listen(t.dataset.id, t);
      else if (t.dataset.reset) { Keys.reset(t.dataset.reset); setMsg(''); }
      else if (t.classList.contains('kall')) { Keys.resetAll(); setMsg('All keys reset to default.'); }
    });
    let host = doc.getElementById('settings'); // the ant18/ui Settings popup, when that branch is merged
    if (host) host.appendChild(section);
    else {
      const btn = doc.createElement('button');
      btn.id = 'keys-btn'; btn.textContent = '⌨'; btn.setAttribute('aria-label', 'Key settings');
      btn.dataset.tip = 'Key settings: Rebind any hotkey.';
      host = doc.createElement('div'); host.id = 'keys-pop'; host.className = 'hidden';
      host.appendChild(section);
      doc.body.append(btn, host);
      btn.onclick = e => { e.stopPropagation(); btn.blur(); host.classList.toggle('hidden'); stopListening(); };
      host.addEventListener('pointerdown', e => e.stopPropagation());
      doc.addEventListener('pointerdown', e => { if (!host.contains(e.target) && e.target !== btn) host.classList.add('hidden'); });
      root.addEventListener('keydown', e => { if (Keys.is(e, 'cancel')) host.classList.add('hidden'); });
    }
    render();
    Keys.onChange(() => { render(); refreshHints(); });
    refreshHints();
  };
  if (doc.body) mount(); else root.addEventListener('DOMContentLoaded', mount);
})(typeof window !== 'undefined' ? window : globalThis);
