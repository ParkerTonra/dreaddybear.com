// ant18/flow: match size slider, seat/team swapping, the end-of-match summary, pacing toasts and the opt-in tutorial.
// Loaded after hud.js. client.js calls Flow.onMessage / onState / onSend / onEnd (all guarded by `window.Flow`), and every
// call passes the globals it needs (mySide, ...) so the logic below is pure and testable in a stub DOM (tests/flow.test.js).
(function (root) {
  const doc = root.document;
  const $ = id => (doc ? doc.getElementById(id) : null);

  // ---------- Pure helpers ----------
  const SIZES = ['quick', 'standard', 'large'];
  const SIZE_TEXT = {
    quick: 'Quick · the classic skirmish: small map, 60 food, farms decide at 12:00',
    standard: 'Standard · bigger map, 100 food each, more piles, farms decide at 15:00',
    large: 'Large · the biggest map, 150 food each, farms decide at 19:12',
  };
  const fmt = t => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

  // End screen numbers for the viewer: their own team's totals (a solo player's colony is their team in 1v1).
  // Spectators get both teams added together.
  function endSummary(s, mySide, myTeam) {
    const st = (s && s.stats) || [];
    const mine = st.filter((_, i) => myTeam < 0 || i % 2 === myTeam);
    const sum = k => mine.reduce((t, x) => t + (x[k] || 0), 0);
    return { time: fmt(s ? s.t : 0), spawned: sum('spawned'), lost: sum('lost'), food: sum('food'), nestDmg: sum('nestDmg'), who: myTeam < 0 ? 'Everyone' : s && s.mode === '1v1' ? 'Your colony' : 'Your team' };
  }

  // Early-game pacing hints from the match clock already in the snapshot (no new mechanics). `seen` is a Set of ids
  // already shown; returns the new hints due at this moment. s.obj.clock = [phase, secondsLeft].
  function paceHints(s, seen) {
    const out = [];
    if (!s || !s.obj || s.obj.clock[0] !== 0) return out;
    const decide = s.t + s.obj.clock[1];
    const due = (id, at, text) => { if (!seen.has(id) && s.t >= at) { seen.add(id); out.push({ id, text }); } };
    due('farms', 40, `🌿 Hold an aphid farm for +1 food/s. More farms at ${fmt(decide)} wins the match.`);
    due('half', decide / 2, `⏱ Halfway: ${fmt(decide - s.t)} until the farms decide the match.`);
    return out;
  }

  // ---------- Tutorial ----------
  const KEY = 'ant-tutorial-done';
  const flagGet = () => { try { return !!(root.localStorage && root.localStorage.getItem(KEY) === '1'); } catch (e) { return false; } };
  const flagSet = () => { try { root.localStorage && root.localStorage.setItem(KEY, '1'); } catch (e) { /* private mode */ } };

  // ctx: { sel: Set of selected ant type ids, soldiers, sent: Set of things the player did (spawn:worker, siege) }
  const STEPS = [
    { id: 'select', text: 'Select your workers: press <kbd>W</kbd>, or drag a box around them.', done: c => c.sel.has(0) },
    { id: 'gather', text: 'Workers gather food on their own. Hatch more with <kbd>Z</kbd> (10 food).', done: c => c.sent.has('spawn:worker') },
    { id: 'soldiers', text: 'Soldiers fight. Press <kbd>X</kbd> (25 food) until you have 3.', done: c => c.soldiers >= 3 },
    { id: 'army', text: 'Select your army: press <kbd>Q</kbd>.', done: c => c.sel.has(1) },
    { id: 'siege', text: 'Right-click the enemy nest (far corner; <kbd>0</kbd> shows the whole board) to siege it. Majors (<kbd>V</kbd>, costs a 🔵 pellet) hit nests 4x harder.', done: c => c.sent.has('siege') },
    { id: 'keys', text: 'Click your nest, then right-click the ground to set where its soldiers gather. Keys: <kbd>Z</kbd><kbd>X</kbd><kbd>C</kbd><kbd>V</kbd> spawn ·<kbd>Q</kbd><kbd>W</kbd><kbd>A</kbd> select · <kbd>T</kbd>-<kbd>O</kbd> evolve · <kbd>F</kbd> attack-move · <kbd>S</kbd> stop · <kbd>Space</kbd> home · <kbd>?</kbd> everything.', done: () => false },
  ];

  const tut = { pending: false, active: false, i: 0, sent: new Set() };
  const hasDone = () => flagGet();

  function stepContext(s, mySide, selIds) {
    const type = new Map((s.ants || []).filter(a => a[1] === mySide).map(a => [a[0], a[2]]));
    const sel = new Set();
    for (const id of selIds || []) if (type.has(id)) sel.add(type.get(id));
    let soldiers = 0;
    for (const t of type.values()) if (t === 1) soldiers++;
    return { sel, soldiers, sent: tut.sent };
  }

  // Advance past every step the player has already done. Returns the current step index.
  function advance(ctx) {
    while (tut.i < STEPS.length - 1 && STEPS[tut.i].done(ctx)) tut.i++;
    return tut.i;
  }

  function finish() {
    tut.active = false; tut.pending = false;
    flagSet();
    const el = $('flow-hint');
    if (el) el.classList.add('hidden');
    const b = $('learn-btn');
    if (b) b.textContent = 'Learn to play (again)';
  }

  function drawHint() {
    const el = $('flow-hint');
    if (!el) return;
    el.classList.toggle('hidden', !tut.active);
    if (!tut.active) return;
    const last = tut.i === STEPS.length - 1;
    el.innerHTML = `<div class="fl-step">Learn to play · ${tut.i + 1}/${STEPS.length}</div><div class="fl-text">${STEPS[tut.i].text}</div>` +
      `<div class="fl-btns">${last ? '' : '<button id="fl-skip">Skip step</button>'}<button id="fl-close">${last ? 'Done' : 'Close tutorial'}</button></div>`;
    const skip = $('fl-skip');
    if (skip) skip.onclick = () => { tut.i = Math.min(STEPS.length - 1, tut.i + 1); drawHint(); };
    $('fl-close').onclick = finish;
  }

  function startTutorial(join) {
    tut.pending = true; tut.active = true; tut.i = 0; tut.sent = new Set();
    join(); // client.js: joins a private room as 1v1; the bot fill happens when its lobby message arrives
  }

  // ---------- Hooks called by client.js ----------
  const seenHints = new Set();
  let lastT = 0;

  function onMessage(m, mySide) {
    if (m.type === 'lobby') renderLobby(m, mySide);
    if (m.type === 'lobby' && tut.pending && mySide >= 0 && m.host === mySide && root.send) {
      tut.pending = false;
      root.send({ type: 'fill-bots', difficulty: 'easy' });
    }
    if (m.type === 'start') {
      seenHints.clear(); lastT = 0;
      if (tut.active && !tut.pending) { tut.i = 0; tut.sent = new Set(); drawHint(); }
      else if (tut.active) drawHint();
    }
  }

  function onState(s, mySide) {
    if (s.t < lastT) seenHints.clear();
    lastT = s.t;
    if (tut.active && mySide >= 0) {
      const before = tut.i;
      advance(stepContext(s, mySide, root.Orders ? root.Orders.selected() : []));
      if (tut.i !== before) drawHint();
    } else if (!tut.active && mySide >= 0 && root.hudToast) {
      for (const h of paceHints(s, seenHints)) root.hudToast(h.text, 6000, '#7bc46a');
    }
  }

  function onSend(m) {
    if (!tut.active) return;
    if (m.type === 'spawn') tut.sent.add(`spawn:${m.unit}`);
    if (m.type === 'order' && m.kind === 'attack' && Number.isInteger(m.nest)) tut.sent.add('siege');
  }

  // The end screen: a short stat summary for the viewer, above the full per-colony table.
  function onEnd(s, mySide, myTeam) {
    if (tut.active) finish(); // the tutorial match is over
    const el = $('end-summary');
    if (!el || !s) return;
    const x = endSummary(s, mySide, myTeam);
    el.innerHTML = `<div class="fl-sum-title">${x.who}</div><div class="fl-tiles">` +
      [['⏱', x.time, 'match time'], ['🐜', x.spawned, 'ants hatched'], ['💀', x.lost, 'ants lost'], ['🍃', x.food, 'food gathered'], ['🏰', x.nestDmg, 'nest damage']]
        .map(([i, v, l]) => `<div class="fl-tile"><b>${i} ${v}</b><span>${l}</span></div>`).join('') + '</div>';
    el.classList.remove('hidden');
  }

  // ---------- Lobby: size slider + seat picking ----------
  function renderLobby(m, mySide) {
    const range = $('size-range');
    if (!range) return;
    const i = Math.max(0, SIZES.indexOf(m.size || 'quick'));
    range.value = String(i);
    range.disabled = !(mySide >= 0 && m.host === mySide);
    const txt = $('size-text');
    if (txt) txt.textContent = SIZE_TEXT[SIZES[i]] + (range.disabled ? ' (the host picks)' : '');
  }

  function wire(send, join) {
    const range = $('size-range');
    if (range) range.oninput = () => send({ type: 'set-size', size: SIZES[Number(range.value)] || 'quick' });
    const learn = $('learn-btn');
    if (learn) {
      if (flagGet()) learn.textContent = 'Learn to play (again)';
      learn.onclick = () => startTutorial(join);
    }
    const slots = $('slots');
    if (slots) slots.addEventListener('click', e => {
      const el = e.target && e.target.closest ? e.target.closest('.slot[data-seat]') : null;
      if (el && !el.classList.contains('you')) send({ type: 'seat', side: Number(el.dataset.seat) });
    });
  }

  root.Flow = { onMessage, onState, onSend, onEnd, wire, endSummary, paceHints, fmt, STEPS, SIZES, tutorial: tut, advance, stepContext, hasDone };
  if (typeof module !== 'undefined') module.exports = root.Flow;
})(typeof window !== 'undefined' ? window : globalThis);
