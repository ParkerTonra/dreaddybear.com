// ant18/keymap: the one keymap for the whole page. Every keyboard handler asks Keys.is(e, 'action.id') instead of
// looking at e.key itself; the ? help overlay and the Settings > Keys section are rendered from the same table.
//
// A binding is { code, ctrl, alt, shift, meta }:
//   code   e.code (the PHYSICAL key: KeyZ, Digit1, Backquote ...). 'Digit*' = any of Digit1-Digit9.
//   mods   true = must be held, false (default) = must NOT be held, 'any' = don't care.
//   Cmd (meta) is its own modifier. It is never treated as Ctrl.
// Events with no usable e.code (synthetic ones from the panel buttons, tests) fall back to the code their e.key
// would produce on a US keyboard, so Keys.is() works for both.
//
// Reserved for later lanes (documented, NOT implemented here; the rebinder refuses them, see RESERVED_FUTURE):
//   Alt+Digit1-9 (autogroup), Ctrl+Digit1-9 (group save: group.save owns it today), Ctrl+Shift+Digit1-9 (group add),
//   Alt+Backquote (clear autogroup), Tab (next idle ant). Browser/OS chords are refused too (BROWSER_RESERVED).
(function (root) {
  const ANY = 'any';
  const MODS = ['ctrl', 'alt', 'shift', 'meta'];
  const STORE_KEY = 'antArenaKeymap';

  const b = (code, mods) => Object.assign({ code, ctrl: false, alt: false, shift: false, meta: false }, mods || {});
  const ALLMODS = { ctrl: ANY, alt: ANY, shift: ANY, meta: ANY };
  // ant60: WASD pans like the arrows. Plain W/A/S/D are 'soft' defaults (see effective()): a player's own saved binding on the same chord wins.
  const SOFT = k => Object.assign(k, { soft: true });
  const SHIFT_ONLY = { shift: true }; // Shift+W/A/S/D: the unit commands that used to own the plain letters
  const SH = { shift: ANY }; // Shift is a free extra (it adds to a selection, cancels a research ...)

  // id, group (settings + help section), label, default bindings (first is shown), options.
  // ctx 'match' = needs a match on screen; 'global' = works anywhere. Two actions may not share a chord
  // when their contexts are equal or either is global.
  const rows = [];
  const def = (id, group, label, keys, o) => rows.push(Object.assign({ id, group, label, keys: [].concat(keys), ctx: 'match', help: true, rebind: true }, o));

  def('pan.left', 'Camera', 'Pan left', [b('ArrowLeft', ALLMODS), SOFT(b('KeyA'))]);
  def('pan.up', 'Camera', 'Pan up', [b('ArrowUp', ALLMODS), SOFT(b('KeyW'))]);
  def('pan.right', 'Camera', 'Pan right', [b('ArrowRight', ALLMODS), SOFT(b('KeyD'))]);
  def('pan.down', 'Camera', 'Pan down', [b('ArrowDown', ALLMODS), SOFT(b('KeyS'))]);
  def('zoom.in', 'Camera', 'Zoom in', [b('Equal', SH), b('NumpadAdd', SH)]);
  def('zoom.out', 'Camera', 'Zoom out', [b('Minus', SH), b('NumpadSubtract', SH)]);
  def('view.nest', 'Camera', 'Jump to your nest (again: whole board)', b('Space', SH));
  def('view.ping', 'Camera', 'Jump to the last ping or attack alert', b('Backquote', SH));
  def('view.all', 'Camera', 'Whole board', [b('Digit0'), b('Numpad0')]);

  def('spawn.worker', 'Colony', 'Spawn a worker', b('KeyZ', SH));
  def('spawn.soldier', 'Colony', 'Spawn a soldier', b('KeyX', SH));
  def('spawn.spitter', 'Colony', 'Spawn a spitter', b('KeyC', SH));
  def('spawn.major', 'Colony', 'Spawn a major', b('KeyV', SH));
  def('spawn.nurse', 'Colony', 'Spawn a nurse', b('KeyN', SH));
  def('spawn.alate', 'Colony', 'Spawn a hawker', b('KeyB', SH));

  def('ability.trail', 'Abilities', 'Pheromone trail', b('KeyG', SH));
  def('ability.alarm', 'Abilities', 'Alarm', b('KeyJ', SH));
  def('ability.volley', 'Abilities', 'Acid volley', b('KeyK', SH));
  def('ability.call', 'Abilities', "Queen's call", b('KeyL', SH));

  def('build.cycle', 'Build', 'Build mode (again: next structure)', b('KeyM', SH));

  def('select.fighters', 'Units', 'Select fighters', b('KeyQ', SH));
  def('select.workers', 'Units', 'Select workers', b('KeyW', SHIFT_ONLY));
  def('select.all', 'Units', 'Select all ants', b('KeyA', SHIFT_ONLY));
  // Tab only acts while focus is on the board (input.js checks document.activeElement); Shift+Tab stays browser focus navigation.
  def('select.idle', 'Units', 'Next idle fighter (select and centre)', b('Tab'), { rebind: false });
  def('select.hurt', 'Units', 'Select hurt fighters (under 50% health)', b('Semicolon', SH));
  def('order.attack', 'Units', 'Attack-move (then click)', b('KeyF', SH));
  def('order.patrol', 'Units', 'Patrol (then click)', b('KeyP', SH));
  def('order.stop', 'Units', 'Stop', b('KeyS', SHIFT_ONLY));
  def('order.hold', 'Units', 'Hold position', b('KeyD', SHIFT_ONLY));
  def('order.home', 'Units', 'Go home', b('KeyH', SH));
  def('order.auto', 'Units', 'Back to automatic', b('KeyE', SHIFT_ONLY));
  def('order.rally', 'Units', 'Rally flag: arm, then click ground (fighters) or food (workers)', b('KeyE'));
  def('state.fire', 'Units', 'Fire state: cycle', b('KeyF', { ctrl: true, shift: ANY }));
  def('state.move', 'Units', 'Move state: cycle', b('KeyD', { ctrl: true, shift: ANY }));
  // Digits: recall (Shift adds to the selection) and save. Fixed: later lanes build on this digit family.
  def('group.recall', 'Units', 'Recall control group', b('Digit*', SH), { rebind: false });
  def('group.save', 'Units', 'Save control group', b('Digit*', { ctrl: true }), { rebind: false });
  def('group.add', 'Units', 'Add selection to a control group', b('Digit*', { ctrl: true, shift: true }), { rebind: false });
  def('group.auto', 'Units', 'Autogroup: send this caste to group N', b('Digit*', { alt: true }), { rebind: false });
  def('group.autoclear', 'Units', 'Autogroup: clear this caste', b('Backquote', { alt: true }), { rebind: false });

  def('ping.arm', 'Team', 'Ping the map (then click)', b('Period'), { ctx: 'global' });
  def('sound.mute', 'Team', 'Mute sound', b('Comma'), { ctx: 'global' });
  def('help.toggle', 'Team', 'This help', b('Slash', { shift: true }), { ctx: 'global' });
  // Escape is one shared action on purpose: every layer (ability, build mode, ping, help, panel) cancels its own state.
  def('cancel', 'Team', 'Cancel / close / deselect', b('Escape', ALLMODS), { ctx: 'global', rebind: false, help: false });

  def('game.pause', 'Team', 'Pause / resume (solo and Learn to play only)', [b('Pause'), b('F10')], { ctx: 'global' });
  def('debug.perf', 'Team', 'Performance overlay (fps, frame and host timings)', b('F3'), { ctx: 'global', rebind: false }); // perf.js

  def('evo.dmg', 'Evolutions', 'Evolve Mandibles (Shift+key cancels)', b('KeyT', SH));
  def('evo.chitin', 'Evolutions', 'Evolve Chitin (Shift+key cancels)', b('KeyY', SH));
  def('evo.acid', 'Evolutions', 'Evolve Acid glands (Shift+key cancels)', b('KeyU', SH));
  def('evo.legs', 'Evolutions', 'Evolve Long legs (Shift+key cancels)', b('KeyI', SH));
  def('evo.forage', 'Evolutions', 'Evolve Big crops (Shift+key cancels)', b('KeyO', SH));
  def('evo.jelly', 'Evolutions', 'Evolve Royal jelly (Shift+key cancels)', b('KeyR', SH));

  const ACTIONS = rows;
  const byId = {};
  for (const a of ACTIONS) byId[a.id] = a;

  // ---------- chords nobody may rebind to ----------
  const MODIFIER_CODES = /^(Control|Shift|Alt|Meta|OS|Caps|NumLock|ScrollLock|Fn)/;
  const F = c => /^F([1-9]|1[0-2])$/.test(c);
  // Browser / OS chords the page cannot own (Chromium reserves close/new tab and window and quit; the rest are
  // chords where pressing them in a game would reload, find, quit or switch window). Cmd is checked as its own key.
  const BROWSER_RESERVED = [
    { why: 'closes or opens a tab or window, or quits the browser', test: k => (k.ctrl || k.meta) && /^Key[WTNQ]$/.test(k.code) },
    { why: 'switches or reopens tabs', test: k => (k.ctrl || k.meta) && (/^(Tab|PageUp|PageDown)$/.test(k.code)) },
    { why: 'is a window or system shortcut (Cmd+H/M hide, Cmd+Space search)', test: k => k.meta && /^(KeyH|KeyM|Space|Tab)$/.test(k.code) },
    { why: 'is the Windows input-language switch or a window shortcut (Alt+Shift, Alt+Tab, Alt+F4, Alt+Space)', test: k => (k.alt && k.shift) || (k.alt && /^(Tab|Space|F4)$/.test(k.code)) },
    { why: 'is a function key (browser help, reload, fullscreen, devtools, media keys)', test: k => F(k.code) },
    { why: 'reloads the page or focuses the address bar', test: k => (k.ctrl || k.meta) && /^(KeyR|KeyL)$/.test(k.code) },
  ];
  // Free for later lanes: documented here so nothing else grabs them.
  const RESERVED_FUTURE = [
    { id: 'Alt+Digit1-9', what: 'autogroup (assign caste to group)', test: k => k.alt && /^Digit[1-9]$/.test(k.code), owner: 'group.auto' },
    { id: 'Ctrl+Digit1-9', what: 'group save (owned today by group.save)', test: k => k.ctrl && !k.shift && /^Digit[1-9]$/.test(k.code), owner: 'group.save' },
    { id: 'Ctrl+Shift+Digit1-9', what: 'add selection to a group', test: k => k.ctrl && k.shift && /^Digit[1-9]$/.test(k.code), owner: 'group.add' },
    { id: 'Alt+Backquote', what: 'clear autogroup', test: k => k.alt && k.code === 'Backquote', owner: 'group.autoclear' },
    { id: 'Tab', what: 'next idle fighter (focus navigation otherwise)', test: k => k.code === 'Tab', owner: 'select.idle' },
  ];

  // ---------- event -> normalised chord ----------
  const KNOWN = /^(Key[A-Z]|Digit[0-9]|Numpad\w+|Arrow\w+|F([1-9]|1[0-2])|Space|Backquote|Period|Comma|Minus|Equal|Slash|Backslash|Semicolon|Quote|Bracket(Left|Right)|Escape|Tab|Enter|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Pause)$/;
  const KEY_TO_CODE = { ' ': 'Space', '`': 'Backquote', '~': 'Backquote', '.': 'Period', ',': 'Comma', '-': 'Minus', _: 'Minus', '=': 'Equal', '+': 'Equal', '/': 'Slash', '?': 'Slash', escape: 'Escape', tab: 'Tab', enter: 'Enter',
    arrowleft: 'ArrowLeft', arrowright: 'ArrowRight', arrowup: 'ArrowUp', arrowdown: 'ArrowDown' };
  function codeFromKey(key) {
    if (typeof key !== 'string' || !key) return '';
    const k = key.toLowerCase();
    if (KEY_TO_CODE[k]) return KEY_TO_CODE[k];
    if (/^[a-z]$/.test(k)) return 'Key' + k.toUpperCase();
    if (/^[0-9]$/.test(k)) return 'Digit' + k;
    return '';
  }
  function norm(e) {
    const code = e.code && KNOWN.test(e.code) ? e.code : codeFromKey(e.key);
    return { code, ctrl: !!e.ctrlKey, alt: !!e.altKey, shift: !!e.shiftKey || e.key === '?', meta: !!e.metaKey };
  }

  const codeOk = (want, got) => want === got || (want === 'Digit*' && /^Digit[1-9]$/.test(got));
  const modOk = (want, got) => want === ANY || !!want === !!got;
  const matches = (bd, k) => codeOk(bd.code, k.code) && MODS.every(m => modOk(bd[m], k[m]));
  // Can one key press satisfy both bindings? (used for conflict detection)
  const codesCollide = (x, y) => x === y || (x === 'Digit*' && /^Digit[1-9]$/.test(y)) || (y === 'Digit*' && /^Digit[1-9]$/.test(x)) || (x === 'Digit*' && y === 'Digit*');
  const overlap = (x, y) => codesCollide(x.code, y.code) && MODS.every(m => x[m] === ANY || y[m] === ANY || !!x[m] === !!y[m]);

  // ---------- user overrides ----------
  let overrides = {};
  let capturing = false;
  const listeners = [];
  // A soft default (plain WASD pan) steps aside when another action has a saved binding that the same press would trigger.
  const effective = id => {
    if (overrides[id]) return [overrides[id]];
    const ks = byId[id] ? byId[id].keys : [];
    if (!ks.some(k => k.soft)) return ks;
    return ks.filter(k => !k.soft || !Object.keys(overrides).some(o => o !== id && overlap(k, overrides[o])));
  };
  // The plain keys these actions had before WASD became pan. A saved copy of one is just the old default, not a choice.
  const OLD_PLAIN = { 'select.workers': 'KeyW', 'select.all': 'KeyA', 'order.stop': 'KeyS', 'order.hold': 'KeyD', 'order.auto': 'KeyE' };

  function conflictsFor(id, bd) {
    const me = byId[id];
    return ACTIONS.filter(a => a.id !== id && (a.ctx === me.ctx || a.ctx === 'global' || me.ctx === 'global') && effective(a.id).some(x => !x.soft && overlap(x, bd))); // a soft default (plain WASD pan) never blocks a player's own choice
  }
  // check(id, binding) -> { ok: true } | { ok: false, reason }
  function check(id, bd) {
    const a = byId[id];
    if (!a) return { ok: false, reason: 'Unknown action.' };
    if (!a.rebind) return { ok: false, reason: `${a.label} cannot be rebound.` };
    if (!bd || !bd.code || MODIFIER_CODES.test(bd.code)) return { ok: false, reason: 'Press a key, not just a modifier.' };
    const t = v => v === true;
    const k = { code: bd.code, ctrl: t(bd.ctrl), alt: t(bd.alt), shift: t(bd.shift), meta: t(bd.meta) };
    const anyShift = a.keys.some(x => x.shift === ANY);
    for (const r of BROWSER_RESERVED) if (r.test(k)) return { ok: false, reason: `${name(k)} ${r.why}; the browser keeps it.` };
    for (const r of RESERVED_FUTURE) if (r.test(k) && r.owner !== id) return { ok: false, reason: `${name(k)} is reserved for ${r.what}.` };
    if (anyShift && k.shift) return { ok: false, reason: `Shift is an extra modifier for "${a.label}"; pick a key without it.` };
    const stored = Object.assign({}, k, anyShift ? { shift: ANY } : {});
    const clash = conflictsFor(id, stored);
    if (clash.length) return { ok: false, reason: `${name(k)} is already ${clash[0].label}.` };
    return { ok: true, binding: stored };
  }

  const load = () => {
    overrides = {};
    let raw = null;
    try { raw = root.localStorage ? root.localStorage.getItem(STORE_KEY) : null; } catch (e) { raw = null; }
    if (!raw) return;
    let data = null;
    try { data = JSON.parse(raw); } catch (e) { return; }
    if (!data || typeof data !== 'object') return;
    for (const id of Object.keys(data)) { // re-validate in order; a stale or hand-edited entry is dropped, never trusted
      const v = data[id], a = byId[id];
      if (!a || !v || typeof v.code !== 'string') continue;
      if (OLD_PLAIN[id] === v.code && v.ctrl !== true && v.alt !== true && v.meta !== true && v.shift !== true) continue; // ant60: pre-WASD default
      const r = check(id, v);
      if (r.ok) overrides[id] = r.binding;
    }
  };
  const save = () => {
    try { if (root.localStorage) root.localStorage.setItem(STORE_KEY, JSON.stringify(overrides)); } catch (e) { /* private mode: keeps for this page load only */ }
  };
  const changed = () => { renderHelp(); for (const f of listeners.slice()) { try { f(); } catch (e) { /* a listener must not break the others */ } } };

  // ---------- names ----------
  const CODE_NAME = { Period: '.', Comma: ',', Backquote: '`', Slash: '/', Minus: '-', Equal: '+', Space: 'Space', Escape: 'Esc', Backslash: '\\', Semicolon: ';', Quote: "'",
    BracketLeft: '[', BracketRight: ']', ArrowLeft: '←', ArrowUp: '↑', ArrowRight: '→', ArrowDown: '↓', 'Digit*': '1-9', NumpadAdd: 'Num+', NumpadSubtract: 'Num-' };
  function codeName(code) {
    if (CODE_NAME[code]) return CODE_NAME[code];
    let m = /^Key([A-Z])$/.exec(code); if (m) return m[1];
    m = /^Digit(\d)$/.exec(code); if (m) return m[1];
    m = /^Numpad(\w+)$/.exec(code); if (m) return 'Num' + m[1];
    return code;
  }
  const parts = bd => {
    const p = [];
    if (bd.ctrl === true) p.push('Ctrl');
    if (bd.alt === true) p.push('Alt');
    if (bd.meta === true) p.push('Cmd');
    if (bd.shift === true) p.push('Shift');
    p.push(codeName(bd.code));
    return p;
  };
  function name(bd) { return parts(bd).join('+'); }
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  function kbdHtml(bd) {
    if (bd.code === 'Digit*') { const mods = parts(bd).slice(0, -1).map(x => `<kbd>${x}</kbd>`); return mods.join('+') + (mods.length ? '+' : '') + '<kbd>1</kbd>-<kbd>9</kbd>'; }
    return parts(bd).map(x => `<kbd>${esc(x)}</kbd>`).join('+');
  }

  // ---------- help overlay ----------
  // index.html marks every key slot as data-keys="action.id other.id"; this fills them from the table. Actions with
  // help: true that the page does not mention are appended under "Other keys", so the overlay cannot miss one.
  function helpKeys(ids) { return ids.split(/\s+/).filter(Boolean).map(id => (effective(id)[0] ? kbdHtml(effective(id)[0]) : '')).join(' '); }
  function renderHelp() {
    const doc = root.document;
    if (!doc || !doc.getElementById) return;
    const help = doc.getElementById('help');
    if (!help || !help.querySelectorAll) return;
    const seen = new Set();
    for (const el of help.querySelectorAll('[data-keys]')) {
      const ids = el.getAttribute('data-keys');
      ids.split(/\s+/).forEach(i => seen.add(i));
      el.innerHTML = helpKeys(ids);
    }
    const missing = ACTIONS.filter(a => a.help && !seen.has(a.id));
    let extra = help.querySelector('#help-other');
    if (!missing.length) { if (extra) extra.remove(); return; }
    if (!extra) {
      extra = doc.createElement('div'); extra.id = 'help-other';
      const cols = help.querySelector('.cols');
      (cols && cols.lastElementChild ? cols.lastElementChild : help).appendChild(extra);
    }
    extra.innerHTML = '<h3>Other keys</h3><dl>' + missing.map(a => `<dt>${helpKeys(a.id)}</dt><dd>${esc(a.label)}</dd>`).join('') + '</dl>';
  }

  // ---------- public API ----------
  const api = {
    ACTIONS, byId, BROWSER_RESERVED, RESERVED_FUTURE, STORE_KEY,
    is(e, id) { // does this key event trigger action `id`? (false while the rebinder is listening)
      if (capturing || !e) return false;
      const k = norm(e);
      return effective(id).some(bd => matches(bd, k));
    },
    codeIs(e, id) { // key-up helper: same physical key, modifiers ignored
      if (!e) return false;
      const k = norm(e);
      return effective(id).some(bd => codeOk(bd.code, k.code));
    },
    digit(e) { const m = /^Digit([1-9])$/.exec(norm(e).code); return m ? m[1] : null; }, // 1-9 for the group family
    norm, name, kbdHtml, binding: id => effective(id)[0] || null, bindings: effective,
    label: id => (effective(id)[0] ? name(effective(id)[0]) : ''),
    isDefault: id => !overrides[id],
    fromEvent(e) { const k = norm(e); return { code: k.code, ctrl: k.ctrl, alt: k.alt, shift: e.key === '?' ? true : !!e.shiftKey, meta: k.meta }; },
    check,
    set(id, bd) { const r = check(id, bd); if (r.ok) { overrides[id] = r.binding; save(); changed(); } return r; },
    reset(id) { if (overrides[id]) { delete overrides[id]; save(); changed(); } },
    resetAll() { overrides = {}; save(); changed(); },
    setCapturing(v) { capturing = !!v; },
    onChange(f) { listeners.push(f); },
    conflictsFor,
    // Press an action the way a player would (panel buttons): dispatches a keydown built from its binding.
    press(id) {
      const bd = effective(id)[0], KE = root.KeyboardEvent;
      if (!bd || !KE || !root.dispatchEvent) return;
      const code = bd.code === 'Digit*' ? 'Digit1' : bd.code;
      root.dispatchEvent(new KE('keydown', { key: id === 'cancel' ? 'Escape' : codeKey(code), code, ctrlKey: bd.ctrl === true, altKey: bd.alt === true, shiftKey: bd.shift === true, metaKey: bd.meta === true, bubbles: true }));
    },
    renderHelp,
    reload: load,
  };
  function codeKey(code) {
    let m = /^Key([A-Z])$/.exec(code); if (m) return m[1].toLowerCase();
    m = /^Digit(\d)$/.exec(code); if (m) return m[1];
    const rev = { Period: '.', Comma: ',', Backquote: '`', Slash: '/', Minus: '-', Equal: '=', Space: ' ', Escape: 'Escape', Semicolon: ';' };
    return rev[code] || code;
  }

  load();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.Keys = api;
  if (root.document) {
    if (root.document.getElementById && root.document.getElementById('help')) renderHelp();
    else if (root.addEventListener) root.addEventListener('DOMContentLoaded', renderHelp);
  }
})(typeof window !== 'undefined' ? window : globalThis);
