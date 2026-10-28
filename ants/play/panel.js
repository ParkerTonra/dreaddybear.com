// Selection panel + controls help overlay. Loaded after input.js.
// The panel shows what you have selected (count and health by type) with buttons for its orders.
// Every button presses the same hotkey a player would, so buttons and keys can never disagree,
// and the orders lane can add buttons with Panel.addOrder({ id, label, key, title, when, run }).
// Reads client.js / input.js globals at runtime: curr, mySide, COLORS, sel (Set of selected ant ids), setSel.
(function (root) {
  const doc = root.document;
  const panel = doc.getElementById('sel-panel'), help = doc.getElementById('help'), helpBtn = doc.getElementById('help-btn');
  if (!panel) return;

  // Press a hotkey as if the player had (input.js, client.js and pings.js all listen on window).
  function press(key, code) {
    const ev = new root.KeyboardEvent('keydown', { key, code: code || (key.length === 1 ? 'Key' + key.toUpperCase() : key), bubbles: true });
    root.dispatchEvent(ev);
  }

  // when(sel) -> show the button; sel = { ids, workers, soldiers } (null when nothing is selected).
  const orders = [];
  let built = false; // action buttons are rebuilt after addOrder / removeOrder
  const Panel = root.Panel = {
    press,
    addOrder(o) {
      const i = orders.findIndex(x => x.id === o.id);
      if (i >= 0) orders.splice(i, 1, o); else orders.push(o);
      built = false;
      return Panel;
    },
    removeOrder(id) { const i = orders.findIndex(x => x.id === id); if (i >= 0) orders.splice(i, 1); built = false; },
    orders,
  };
  const some = s => !!s, none = s => !s;
  // The orders lane exposes window.Orders (home, auto, deselect, stop, hold, ...). Prefer it when present,
  // otherwise fall back to pressing the hotkey. Guarded because the branches merge separately.
  const viaOrders = (fn, action) => () => { const O = root.Orders; if (O && typeof O[fn] === 'function') O[fn](); else Keys.press(action); };
  const has = fn => () => !!(root.Orders && typeof root.Orders[fn] === 'function');
  Panel.addOrder({ id: 'home', label: '⌂ Home', action: 'order.home', run: viaOrders('home', 'order.home'), title: 'Selected ants go home [H]', when: () => true })
    .addOrder({ id: 'stop', label: '■ Stop', action: 'order.stop', run: viaOrders('stop', 'order.stop'), title: 'Stop where they are [S]', when: s => !!s && has('stop')() })
    .addOrder({ id: 'hold', label: '⛨ Hold', action: 'order.hold', run: viaOrders('hold', 'order.hold'), title: 'Hold position: never move, strike what is in reach [D]', when: s => !!s && has('hold')() })
    .addOrder({ id: 'auto', label: '↺ Auto', action: 'order.auto', run: viaOrders('auto', 'order.auto'), title: 'Back to automatic behaviour [E]', when: some })
    .addOrder({ id: 'deselect', label: '✕', action: 'cancel', run: viaOrders('deselect', 'cancel'), title: 'Deselect [Esc]', when: some })
    .addOrder({ id: 'all', label: 'All', action: 'select.all', title: 'Select all your ants [A]', when: none })
    .addOrder({ id: 'workers', label: 'Workers', action: 'select.workers', title: 'Select your workers [W]', when: none })
    .addOrder({ id: 'soldiers', label: 'Fighters', action: 'select.fighters', title: 'Select your fighters [Q]', when: none })
    .addOrder({ id: 'hurt', label: '✚ Hurt', action: 'select.hurt', title: 'Select fighters under 50% health, to pull them back [;]', when: () => true })
    .addOrder({ id: 'spawn-w', label: '+🐜', action: 'spawn.worker', title: 'Spawn a worker (10 food) [Z]', when: () => true, bld: 'producer' })
    .addOrder({ id: 'spawn-s', label: '+⚔', action: 'spawn.soldier', title: 'Spawn a soldier (25 food) [X]', when: () => true, bld: 'producer' })
    .addOrder({ id: 'clear-forage', label: '✕ Worker flag', title: 'Clear this building\'s worker forage flag: its new workers just work as usual', run: () => root.Orders && root.Orders.clearForage && root.Orders.clearForage(), when: () => false, bld: 'forage' });
  // Orders with `bld` show while a building is selected (the ant orders hide): true = always, 'producer' = nest / finished outpost,
  // 'forage' = a producer that has a worker flag set.
  Panel.addOrder({ ...orders.find(o => o.id === 'deselect'), bld: true });

  Keys.onChange(() => { built = false; }); // rebuilt with the new key labels on the next tick
  const counts = doc.createElement('div'); counts.id = 'sp-counts';
  const actions = doc.createElement('div'); actions.id = 'sp-actions';
  // ant17: unit states of the selection (fire / move, BAR-style), each button cycles its state.
  const states = doc.createElement('div'); states.id = 'sp-states';
  states.innerHTML = '<button data-st="fire" data-tip="Fire state [Ctrl+F]: Click to cycle: hold fire, return fire, fire at will."></button><button data-st="move" data-tip="Move state [Ctrl+D]: Click to cycle: hold position, maneuver (chase 4 tiles, then come back), roam."></button>';
  states.addEventListener('click', e => { const b = e.target.closest && e.target.closest('button'); if (b && root.Orders && root.Orders.cycleState) { root.Orders.cycleState(b.dataset.st); b.blur(); tick(); } });
  // Group bar: one chip per non-empty control group (digit + caste counts), plus an "idle" chip for fighters with no order.
  const bar = doc.createElement('div'); bar.id = 'sp-groups';
  bar.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;margin-top:6px';
  panel.append(counts, actions, states, bar); // actions stay children[1] (camera.test.js); the states row sits under them
  const STATE_ICON = { fire: ['🚫', '🛡', '🔥'], move: ['⛨', '↩', '🏃'] };
  // Target priority (ant25): a dropdown under the state buttons; soldiers and spitters of the selection pick that caste first when several are in range.
  const PREF_NAMES = ['Any target', 'Prefer workers', 'Prefer soldiers', 'Prefer spitters', 'Prefer majors', 'Prefer nurses', 'Prefer hawkers'];
  const pref = doc.createElement('select'); pref.id = 'sp-pref'; pref.setAttribute && pref.setAttribute('aria-label', 'Target priority');
  (pref.dataset || (pref.dataset = {})).tip = 'Target priority: Selected soldiers and spitters pick this kind of ant first when several are in range. Does not change their orders.';
  pref.innerHTML = PREF_NAMES.map((n, i) => `<option value="${i}">${n}</option>`).join('');
  pref.addEventListener('change', () => { if (root.Orders && root.Orders.setPref) root.Orders.setPref(+pref.value); pref.blur(); tick(); });
  states.appendChild(pref);
  const FIGHT_PICK = new Set([1, 2]);
  function build() {
    actions.innerHTML = '';
    for (const o of orders) {
      const b = doc.createElement('button');
      b.dataset.order = o.id;
      const shown = o.action ? Keys.label(o.action) : (o.key || '');
      b.innerHTML = o.label + (shown.length === 1 ? ` <small>[${shown.toUpperCase()}]</small>` : '');
      const tt = o.action ? (o.title || o.label).replace(/\[[^\]]*\]\s*$/, `[${shown}]`) : (o.title || o.label); // the key in the tip follows rebinding
      b.dataset.tip = tt; b.setAttribute && b.setAttribute('aria-label', tt);
      b.onclick = e => {
        e.stopPropagation(); b.blur(); // a focused button would also catch Space
        if (o.run) o.run(current()); else if (o.action) Keys.press(o.action); else if (o.key) press(o.key, o.code);
        tick();
      };
      actions.appendChild(b);
    }
    built = true;
  }

  const playing = () => typeof curr !== 'undefined' && curr && typeof mySide !== 'undefined' && mySide >= 0 && curr.players[mySide] && curr.players[mySide].alive;
  function current() {
    const picked = typeof sel !== 'undefined' && sel && typeof sel.has === 'function' ? sel : null;
    if (!picked || !picked.size) return null;
    const ants = curr.ants.filter(a => a[1] === mySide && picked.has(a[0]));
    if (!ants.length) return null;
    return { ids: ants.map(a => a[0]), ants, workers: ants.filter(a => !a[2]), soldiers: ants.filter(a => a[2]) };
  }
  const avg = list => Math.round(list.reduce((t, a) => t + a[7], 0) / list.length);
  // One row per caste (unit-art.js type ids), so "3 spitters · 2 majors" never reads as "5 soldiers".
  const CASTE_ICON = ['🐜', '⚔', '☄', '🛡', '✚', '🪽'];
  const casteName = t => { const U = root.UnitArt && root.UnitArt.UNITS; return (U && U[t] && U[t].name.toLowerCase()) || (t ? 'soldier' : 'worker'); };
  const row = (type, list) => {
    if (!list.length) return '';
    const hp = avg(list), col = hp > 60 ? '#7ad04a' : hp > 30 ? '#f0c040' : '#ff5a4a', name = casteName(type);
    return `<div class="sp-row" data-type="${type}" data-tip="Selection: Click keep only these · Ctrl+click all of them on the map · Right-click drop them · Middle-click centre on them."><span>${CASTE_ICON[type] || '⚔'} <b>${list.length}</b> ${name}${list.length === 1 ? '' : 's'}</span>` +
      `<span class="sp-hp"><i style="width:${hp}%;background:${col}"></i></span><small>${hp}%</small></div>`;
  };
  const byType = ants => { const m = new Map(); for (const a of ants) (m.get(a[2]) || m.set(a[2], []).get(a[2])).push(a); return [...m.entries()].sort((a, b) => a[0] - b[0]); };
  // Caste row: click keeps only that caste · Ctrl+click selects all of it on the map · right-click drops it · middle-click centres on it.
  const rowOf = e => e.target.closest && e.target.closest('.sp-row');
  counts.addEventListener('click', e => {
    const r = rowOf(e), s = current();
    if (!r || !s || typeof setSel !== 'function') return;
    const t = +r.dataset.type;
    if (e.ctrlKey || e.metaKey) setSel(curr.ants.filter(a => a[1] === mySide && a[2] === t).map(a => a[0]), false);
    else setSel(s.ants.filter(a => a[2] === t).map(a => a[0]), false);
    tick();
  });
  counts.addEventListener('contextmenu', e => {
    const r = rowOf(e), s = current();
    if (!r || !s || typeof setSel !== 'function') return;
    e.preventDefault();
    setSel(s.ants.filter(a => a[2] !== +r.dataset.type).map(a => a[0]), false);
    tick();
  });
  counts.addEventListener('auxclick', e => {
    const r = rowOf(e), s = current();
    if (e.button !== 1 || !r || !s) return;
    e.preventDefault();
    const ps = s.ants.filter(a => a[2] === +r.dataset.type);
    if (ps.length && root.Camera && Camera.focusWorld) Camera.focusWorld(ps.reduce((t, a) => t + a[3], 0) / ps.length, ps.reduce((t, a) => t + a[4], 0) / ps.length);
  });

  let last = '';
  function tick() {
    // input.js's readout line stays: it now only shows pending-click prompts (orders, abilities, build mode).
    if (!playing()) { panel.classList.add('hidden'); return; }
    panel.classList.remove('hidden');
    if (!built) build();
    const s = current();
    const O0 = root.Orders, B = !s && O0 && typeof O0.building === 'function' ? O0.building() : null; // a selected building (ants and buildings are never selected together)
    panel.classList.toggle('sp-empty', !s && !B); // phones hide the idle panel (index.html), it covered the board
    const mine = curr.ants.filter(a => a[1] === mySide);
    const html = B ? buildingHtml(B) : s
      ? `<div class="sp-title">Selected</div>${byType(s.ants).map(([t, list]) => row(t, list)).join('')}`
      : `<div class="sp-title">Colony · nothing selected</div><div class="sp-sub">${byType(mine).map(([t, list]) => `${CASTE_ICON[t] || '⚔'} ${list.length}`).join(' · ') || '🐜 0'}</div>`;
    if (html !== last) { counts.innerHTML = html; last = html; }
    const O = root.Orders;
    states.classList.toggle('hidden', !s || !O || typeof O.state !== 'function');
    if (s && O && typeof O.state === 'function') {
      if (pref.classList) pref.classList.toggle('hidden', !s.ants.some(a => FIGHT_PICK.has(a[2]))); // only soldiers (1) and spitters (2) go through pickTarget; majors, workers, nurses, alates ignore priority
      if (O.pref && doc.activeElement !== pref) pref.value = String(Math.max(0, O.pref()));
      for (const b of states.children) {
        if (b === pref) continue;
        const which = b.dataset.st, v = O.state(which), names = which === 'fire' ? O.FIRE_NAMES : O.MOVE_NAMES;
        const label = v >= 0 ? `${STATE_ICON[which][v]} ${names[v]}` : '';
        if (b.textContent !== label) b.textContent = label;
      }
    }
    groupBar();
    for (const b of actions.children) {
      const o = orders.find(x => x.id === b.dataset.order);
      b.classList.toggle('hidden', !!o && !orderShown(o, s, B));
    }
  }
  // With a building selected only its own orders show (bld); otherwise the usual when(sel) rule.
  function orderShown(o, s, B) {
    if (B) return o.bld === true || (o.bld === 'producer' && B.producer) || (o.bld === 'forage' && B.producer && !!B.forage);
    if (o.bld === 'forage') return false;
    return !o.when || !!o.when(s);
  }
  // Pure: the panel body for a selected building (name, health or build progress, and what a click does).
  function buildingHtml(B) {
    const col = B.hp > 60 ? '#7ad04a' : B.hp > 30 ? '#f0c040' : '#ff5a4a';
    const bar = `<div class="sp-row" data-tip="${B.name}: health"><span>❤ <b>${B.hp}</b>%</span><span class="sp-hp"><i style="width:${B.hp}%;background:${col}"></i></span></div>`;
    const build = B.done ? '' : `<div class="sp-row" data-tip="Under construction"><span>🔨 <b>${B.built}</b>%</span><span class="sp-hp"><i style="width:${B.built}%;background:#e8c070"></i></span></div>`;
    const hint = B.producer
      ? `Hatches ants from here: spawn buttons and keys use this ${B.name.toLowerCase()}. Right-click ground: its fighters gather there · right-click food: its new workers forage there${B.forage ? ' · right-click the building: clear that' : ''}.`
      : !B.done ? 'Workers are still building it.'
      : B.type === 0 ? 'Workers drop food here instead of walking home.'
      : B.type === 1 ? 'Spits acid at enemy ants in range that it can see (rocks block it).' : '';
    return `<div class="sp-title">${B.icon} ${B.name}</div>${bar}${build}<div class="sp-sub">${hint}</div>`;
  }
  const idleFighters = () => (root.Orders && root.Orders.idle ? root.Orders.idle() : []); // input.js: order flag 0 or guard, no foe
  function groupBar() {
    const O = root.Orders;
    if (!O || !O.groups) return;
    const g = O.groups(), parts = [];
    for (const d of Object.keys(g).sort()) {
      const by = {};
      for (const a of curr.ants) if (g[d].includes(a[0])) by[a[2]] = (by[a[2]] || 0) + 1;
      const icons = Object.keys(by).sort().map(t => `${CASTE_ICON[t] || '⚔'}${by[t]}`).join(' ');
      parts.push(`<button data-g="${d}" data-tip="Group ${d}: Click select · Shift add · Ctrl remove · Right-click select and centre.">${d} <small>${icons}</small></button>`);
    }
    const idle = idleFighters().length;
    if (idle) parts.push(`<button data-idle="1" data-tip="Idle fighters (no order): Click to select and centre the next one · Shift+click select them all · Tab does the same.">💤 <small>${idle}</small></button>`);
    const html = parts.join('');
    if (bar.innerHTML !== html) bar.innerHTML = html;
  }
  bar.addEventListener('click', e => {
    const b = e.target.closest && e.target.closest('button'), O = root.Orders;
    if (!b || !O) return;
    e.stopPropagation(); b.blur();
    if (b.dataset.idle) O.cycleIdle(e.shiftKey);
    else if (e.ctrlKey || e.metaKey) { const gone = new Set(O.groups()[b.dataset.g] || []); O.select(O.selected().filter(id => !gone.has(id)), false); } // Ctrl: take the group out of the selection
    else O.select(O.groups()[b.dataset.g] || [], e.shiftKey);
    tick();
  });
  bar.addEventListener('contextmenu', e => {
    const b = e.target.closest && e.target.closest('button[data-g]'), O = root.Orders;
    if (!b || !O) return;
    e.preventDefault();
    const ids = O.groups()[b.dataset.g] || [];
    O.select(ids, false);
    const ps = curr.ants.filter(a => ids.includes(a[0]));
    if (ps.length && root.Camera && Camera.focusWorld) Camera.focusWorld(ps.reduce((t, a) => t + a[3], 0) / ps.length, ps.reduce((t, a) => t + a[4], 0) / ps.length);
    tick();
  });
  setInterval(tick, 150);
  root.addEventListener('keyup', () => setTimeout(tick, 0));
  root.addEventListener('pointerup', () => setTimeout(tick, 0));

  // ---------- Help overlay: ? toggles, Esc closes ----------
  const showHelp = on => { if (help) help.classList.toggle('hidden', !on); };
  if (helpBtn) helpBtn.onclick = e => { e.stopPropagation(); helpBtn.blur(); showHelp(help.classList.contains('hidden')); };
  if (help) help.addEventListener('pointerdown', e => { if (e.target === help || (e.target.closest && e.target.closest('.help-close'))) showHelp(false); });
  root.addEventListener('keydown', e => {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) return;
    if (Keys.is(e, 'help.toggle')) { e.preventDefault(); showHelp(help.classList.contains('hidden')); }
    else if (Keys.is(e, 'cancel')) showHelp(false);
  });
})(typeof window !== 'undefined' ? window : globalThis);
