// Structures client (ant16): the build buttons, M-key build mode with a placement ghost, structure drawing,
// and notices for refuges. Loaded after input.js and economy.js; uses client.js globals (curr, mySide, myTeam,
// send, ctx, toScreen, screenToWorld, scale, COLORS, DARK, netNotice) and window.Orders (input.js).
// The server's rules live in structures.js; KINDS and RULES below mirror them (tests/structures.test.js checks).
//   M: build mode (press again for the next structure, a 4th time to cancel) · click: place · Shift: keep placing
//   right-click / Esc: cancel. Selected workers build it; with none selected the two nearest workers go.
// render.js draws structures in its depth sort through Structures.sortInto() / Structures.draw().
(function () {
  const tipSet = (el, t) => typeof Tip !== 'undefined' ? Tip.set(el, t) : (el.title = t); // tip.js
  const KINDS = [ // index = kind id in the snapshot
    { id: 'depot', icon: '🍯', name: 'Food cache', cost: 50, max: 2, desc: 'Workers drop food here instead of walking home' },
    { id: 'mound', icon: '🌋', name: 'Acid mound', cost: 45, max: 3, desc: 'Turret: spits acid at enemy ants in range (majors shrug it off)' },
    { id: 'outpost', icon: '⛺', name: 'Outpost', cost: 90, max: 1, desc: 'A second hatchery with its own rally flag: select it to hatch from it. If your nest falls, the colony moves in' },
    { id: 'garden', icon: '🍄', name: 'Fungus garden', cost: 60, max: 2, near: 5, desc: 'Grows food straight into the colony: 0.5/s alone, +0.4/s per worker tending it (2 max; its builders stay). Must be within 5 of your nest or outpost. Right-click it with workers selected to tend' },
  ];
  const GARDEN = 3, TEND_REACH = 0.9; // kind id; tender distance, as in structures.js
  const RULES = { REACH: 11, ENEMY_CLEAR: 8, SPACING: 1.6, FOOD_CLEAR: 2, EDGE: 1, RANGE: 3.2 };
  const WHY = { max: 'limit reached', food: 'not enough food', edge: 'too close to the edge', rock: 'blocked by rocks', crowded: 'too close to a nest or building', enemy: 'too close to an enemy nest', 'food-pile': 'on a food pile', far: 'too far from your nest / outpost (gardens: within 5)' };
  const $ = id => document.getElementById(id);
  let mode = -1; // kind index while placing
  let mouse = null; // last pointer position (screen)
  let terr = null; // { seed, map, str }

  const playing = () => curr && mySide >= 0 && curr.players[mySide] && curr.players[mySide].alive && curr.winner === null;
  const list = () => (curr && curr.structures) || [];

  // ---------- Placement rules (mirror of buildProblem in structures.js) ----------
  function rockAt(x, y) {
    if (!terr || terr.seed !== curr.seed) return false;
    const m = terr.map, fx = Math.floor(x), fy = Math.floor(y);
    const at = (cx, cy) => cx >= 0 && cy >= 0 && cx < m && cy < m && terr.str.charCodeAt(cy * m + cx) === 49;
    return at(fx, fy) || (x === fx && at(fx - 1, fy)) || (y === fy && at(fx, fy - 1));
  }
  function problem(k, w) {
    const K = KINDS[k], me = curr.players[mySide], d = (a, x, y) => Math.hypot(a.x - x, a.y - y);
    const mine = list().filter(s => s[1] === mySide);
    if (mine.filter(s => s[2] === k).length >= K.max) return 'max';
    if (me.food < K.cost) return 'food';
    const { x, y } = w, m = curr.map;
    if (x < RULES.EDGE || y < RULES.EDGE || x > m - RULES.EDGE || y > m - RULES.EDGE) return 'edge';
    if ([[0, 0], [0.4, 0], [-0.4, 0], [0, 0.4], [0, -0.4]].some(([dx, dy]) => rockAt(x + dx, y + dy))) return 'rock';
    for (const p of curr.players) {
      if (!p.alive) continue;
      if (d(p.nest, x, y) < RULES.SPACING) return 'crowded';
      if (p.team !== me.team && d(p.nest, x, y) < RULES.ENEMY_CLEAR) return 'enemy';
    }
    if (list().some(s => Math.hypot(s[3] - x, s[4] - y) < RULES.SPACING)) return 'crowded';
    if (curr.food.some(f => f[3] > 0 && f[4] !== 3 && Math.hypot(f[1] - x, f[2] - y) < RULES.FOOD_CLEAR)) return 'food-pile';
    const anchors = [me.nest, ...mine.filter(s => s[2] === 2 && s[6] >= 100).map(s => ({ x: s[3], y: s[4] }))];
    if (!anchors.some(a => d(a, x, y) <= (K.near || RULES.REACH))) return 'far';
    return null;
  }

  // ---------- Build bar: its own row, #hud-build (research.js rebuilds #hud-upgrades, so not in there) ----------
  function buildBar() {
    const bar = $('hud-build');
    if (!bar || $('st-bar')) return;
    const box = document.createElement('span');
    box.id = 'st-bar';
    box.style.cssText = 'display:inline-flex;gap:6px;align-items:center';
    const lbl = document.createElement('span');
    lbl.innerHTML = 'Build <kbd>M</kbd>';
    tipSet(lbl, 'Build mode [M]: Press again for the next structure, then click the ground to place it.');
    bar.appendChild(lbl);
    box.innerHTML = KINDS.map((K, i) => `<button id="st-${K.id}" class="upg" style="background:#b98a52" aria-label="${K.name}" data-tip="${K.name} [M]: ${K.cost} food. ${K.desc}">${K.icon} <span>${K.cost}</span></button>`).join('');
    bar.appendChild(box);
    KINDS.forEach((K, i) => { $(`st-${K.id}`).onclick = e => { e.currentTarget.blur(); setMode(mode === i ? -1 : i); }; });
  }
  function updateBar() {
    if (!$('st-bar')) buildBar();
    const bar = $('hud-build'), up = $('hud-upgrades');
    if (bar && up) bar.classList.toggle('hidden', up.classList.contains('hidden')); // shown with the research bar
    if (!curr || mySide < 0 || !curr.players[mySide]) return;
    const me = curr.players[mySide], mine = list().filter(s => s[1] === mySide);
    KINDS.forEach((K, i) => {
      const b = $(`st-${K.id}`);
      if (!b) return;
      const n = mine.filter(s => s[2] === i).length;
      b.disabled = !me.alive || me.food < K.cost || n >= K.max;
      b.style.outline = mode === i ? '2px solid #fff' : '';
      const t = n >= K.max ? `${n}/${K.max}` : String(K.cost);
      if (b.lastChild.textContent !== t) b.lastChild.textContent = t;
      tipSet(b, buildTip(K, n, me));
    });
    if (mode >= 0 && !playing()) setMode(-1);
  }
  // Pure: the build button tooltip, with the reason when it is grey. Exported for tests.
  function buildTip(K, built, me) {
    const why = !me.alive ? 'your nest has fallen' : built >= K.max ? `limit reached (${built}/${K.max} built)` : me.food < K.cost ? `need ${K.cost - me.food} more food` : '';
    return `${K.icon} ${K.name} [M]: ${K.cost} food, up to ${K.max}. ${K.desc}.${why ? ` Greyed: ${why}.` : ''}`;
  }

  function setMode(k) {
    mode = k;
    if (canvas.style) canvas.style.cursor = k >= 0 ? 'crosshair' : '';
    if (k >= 0 && window.Orders && Orders.mode()) Orders.cancelMode();
    if (k >= 0 && window.Abilities && Abilities.armed()) Abilities.arm(Abilities.armed()); // toggles the armed ability off
    if (window.Orders && Orders.setPrompt) { // input.js prompt line: what the next click does
      const K = KINDS[k];
      Orders.setPrompt(K ? `${K.icon} <b>Build ${K.name}</b> (${K.cost}): click the board to place it · <small>M next kind · Shift keeps placing · Esc cancels</small>` : null, () => setMode(-1));
    }
    updateBar();
  }

  function place(w, keep) {
    const k = mode, why = problem(k, w);
    if (why) { netNotice(`Can't build ${KINDS[k].name} here: ${WHY[why] || why}`, 2200); return; }
    const ids = window.Orders ? Orders.selected().filter(id => curr.ants.some(a => a[0] === id && a[2] === 0)) : [];
    send({ type: 'build', kind: KINDS[k].id, x: Math.round(w.x * 100) / 100, y: Math.round(w.y * 100) / 100, ids });
    if (!keep) setMode(-1);
  }

  // Capture phase on window, so build mode wins over input.js's canvas handlers.
  let down = null;
  addEventListener('pointerdown', e => {
    if (mode < 0 || e.target !== canvas || !e.isPrimary) return;
    down = { button: e.button, x: e.clientX, y: e.clientY };
    e.stopImmediatePropagation();
  }, true);
  addEventListener('pointerup', e => {
    if (mode < 0 || !down || !e.isPrimary) return;
    const d = down; down = null;
    e.stopImmediatePropagation();
    if (d.button === 2) { setMode(-1); return; }
    if (d.button === 0 && playing()) place(screenToWorld(e.clientX, e.clientY), e.shiftKey);
  }, true);
  addEventListener('pointermove', e => { mouse = { x: e.clientX, y: e.clientY }; }, true);
  addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT') return;
    if (Keys.is(e, 'cancel') && !e.ctrlKey && !e.metaKey && !e.altKey && mode >= 0) { setMode(-1); e.stopImmediatePropagation(); return; }
    if (Keys.is(e, 'build.cycle') && playing()) setMode(mode + 1 >= KINDS.length ? -1 : mode + 1);
  }, true);

  // ---------- Log: refuges and razed buildings ----------
  const baseOnMessage = onMessage;
  onMessage = function (m) { // eslint-disable-line no-global-assign
    baseOnMessage(m);
    if (m.type !== 'state' || !m.state) return;
    if (m.state.terrain) terr = { seed: m.state.seed, map: m.state.map, str: m.state.terrain };
    for (const l of m.state.log || []) {
      if (l.kind === 'refuge') netNotice(l.colony === mySide ? '⛺ Your nest fell! The colony fled to your outpost' : `⛺ ${NAMES[l.colony]}'s nest fell, but the colony fled to its outpost`, 5000);
      else if (l.kind === 'razed' && l.colony === mySide) netNotice(`💥 Your ${(KINDS.find(K => K.id === l.structure) || {}).name || 'building'} was razed`, 2500);
    }
  };

  // ---------- Tending: right-click an own finished garden with workers selected ----------
  const tenders = s => curr.ants.filter(a => a[1] === s[1] && a[2] === 0 && Math.hypot(a[3] - s[3], a[4] - s[4]) <= TEND_REACH).length; // estimate: any worker standing there
  const gardenAt = w => list().find(s => s[2] === GARDEN && s[1] === mySide && s[6] >= 100 && !s[7] && Math.hypot(s[3] - w.x, s[4] - w.y) < 1.0) || null;
  const pickedWorkers = () => (window.Orders ? Orders.selected().filter(id => curr.ants.some(a => a[0] === id && a[2] === 0 && a[1] === mySide)) : []);
  let tendDown = null;
  addEventListener('pointerdown', e => {
    if (mode >= 0 || e.button !== 2 || e.target !== canvas || !e.isPrimary || !playing() || !curr) return;
    const g = gardenAt(screenToWorld(e.clientX, e.clientY));
    if (!g || !pickedWorkers().length) return;
    tendDown = g;
    e.stopImmediatePropagation();
  }, true);
  addEventListener('pointerup', e => {
    if (!tendDown || e.button !== 2) return;
    const g = tendDown; tendDown = null;
    e.stopImmediatePropagation();
    const ids = pickedWorkers();
    if (ids.length) { send({ type: 'build', kind: 'tend', ids, x: g[3], y: g[4] }); netNotice('🍄 Workers tend the garden', 1500); }
  }, true);

  // ---------- Drawing ----------
  // The garden: a dark bed with a ring of glowing mushroom caps; brighter and swaying while workers tend it.
  function drawGarden(c, z, side, done, now, id, ghost, s) {
    const tend = done && !ghost ? Math.min(2, tenders(s)) : 0, sway = (globalThis.motionSin || Math.sin)(now / 600 + id);
    ctx.fillStyle = '#3b2a1c'; ctx.beginPath(); ctx.ellipse(c.x, c.y, 17 * z, 8 * z, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#5a4128'; ctx.beginPath(); ctx.ellipse(c.x - 2 * z, c.y - 1.5 * z, 12 * z, 5 * z, 0, 0, Math.PI * 2); ctx.fill();
    const n = done ? 6 : 3;
    for (let i = 0; i < n; i++) {
      const a = i * 2.1 + id, r = i === 0 ? 0 : 9 * z, px = c.x + Math.cos(a) * r, py = c.y + Math.sin(a) * r * 0.45 - 2 * z;
      const h = (7 + (i % 3) * 3 + (done ? tend * 1.5 : 0)) * z, w = (4.5 + (i % 2) * 1.5) * z, lean = sway * 1.2 * z * (tend ? 1 : 0.3);
      ctx.strokeStyle = '#e9dcc0'; ctx.lineWidth = 2 * z;
      ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px + lean, py - h); ctx.stroke();
      ctx.fillStyle = i % 2 ? '#c9a0ff' : '#e7c6ff'; ctx.strokeStyle = '#3a2350'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.ellipse(px + lean, py - h, w, w * 0.6, 0, Math.PI, 0); ctx.fill(); ctx.stroke();
    }
    if (done && window.WorldArt && WorldArt.stampGlow) WorldArt.stampGlow(ctx, '#c9a0ff', c.x, c.y - 8 * z, (14 + tend * 3) * z, 0.25 + 0.12 * tend);
    if (done && !ghost && s[1] === mySide) { // own garden: what it pays right now (0.5 + 0.4 per tender)
      ctx.globalAlpha = 1; ctx.fillStyle = '#e8d6ff'; ctx.font = `600 ${Math.max(9, 11 * z)}px system-ui, sans-serif`; ctx.textAlign = 'center';
      ctx.fillText(`+${(0.5 + 0.4 * tend).toFixed(1)}/s${tend < 2 ? ' · tend me' : ''}`, c.x, c.y + 18 * z); ctx.textAlign = 'start';
    }
  }
  function drawStructure(s, now) {
    const [, side, k, x, y, hp, built, ghost] = s, c = toScreen(x, y), z = scale, done = built >= 100; // ghost: fog.js last-seen
    ctx.save();
    ctx.globalAlpha = (done ? 1 : 0.55 + 0.25 * built / 100) * (ghost ? 0.5 : 1);
    ctx.lineWidth = 2 * z; ctx.strokeStyle = COLORS[side]; // colony ring on the ground: who owns it, at any zoom
    ctx.beginPath(); ctx.ellipse(c.x, c.y, 24 * z, 11 * z, 0, 0, Math.PI * 2); ctx.stroke();
    if (k === GARDEN) drawGarden(c, z, side, done, now, s[0], ghost, s);
    else if (window.WorldArt) WorldArt.drawStructure(ctx, k, c, z, side, done, now, s[0]); // ant18/ground: world-art.js (cached sprite + live glow)
    if (!done) { // scaffolding twigs
      ctx.globalAlpha = 1; ctx.strokeStyle = '#d8b878'; ctx.lineWidth = 1.5 * z;
      ctx.setLineDash && ctx.setLineDash([4 * z, 3 * z]);
      ctx.beginPath(); ctx.ellipse(c.x, c.y - 8 * z, 22 * z, 18 * z, 0, Math.PI, 0); ctx.stroke();
      ctx.setLineDash && ctx.setLineDash([]);
    }
    ctx.restore();
    if (!ghost && (!done || hp < 100)) { // build progress (gold) or health (colony colour)
      const w = 36 * z, top = c.y - 40 * z;
      ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillRect(c.x - w / 2, top, w, 5 * z);
      ctx.fillStyle = done ? COLORS[side] : '#e8c070'; ctx.fillRect(c.x - w / 2, top, w * (done ? hp : built) / 100, 5 * z);
    }
    ctx.lineWidth = 1;
  }

  function drawGhost(now) {
    if (mode < 0 || !mouse || !playing()) return;
    const w = screenToWorld(mouse.x, mouse.y), why = problem(mode, w), c = toScreen(w.x, w.y), z = scale;
    ctx.save();
    ctx.globalAlpha = 0.6 + 0.2 * (globalThis.motionSin || Math.sin)(now / 150);
    ctx.strokeStyle = why ? '#ff5a4a' : '#9dff8a'; ctx.fillStyle = why ? 'rgba(255,90,74,.18)' : 'rgba(157,255,138,.18)';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.ellipse(c.x, c.y, 24 * z, 11 * z, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    if (mode === GARDEN) { // the garden must stay within 5 of home
      ctx.setLineDash && ctx.setLineDash([6, 6]);
      for (const a of [curr.players[mySide].nest, ...list().filter(q => q[1] === mySide && q[2] === 2 && q[6] >= 100).map(q => ({ x: q[3], y: q[4] }))]) {
        const h = toScreen(a.x, a.y);
        ctx.beginPath(); ctx.ellipse(h.x, h.y, 5 * 32 * z * Math.SQRT2, 5 * 16 * z * Math.SQRT2, 0, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.setLineDash && ctx.setLineDash([]);
    }
    if (mode === 1) { // the mound's reach
      ctx.setLineDash && ctx.setLineDash([6, 6]);
      ctx.beginPath(); ctx.ellipse(c.x, c.y, RULES.RANGE * 32 * z * Math.SQRT2, RULES.RANGE * 16 * z * Math.SQRT2, 0, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash && ctx.setLineDash([]);
    }
    ctx.globalAlpha = 1; ctx.font = '600 12px system-ui, sans-serif'; ctx.textAlign = 'center';
    ctx.fillStyle = why ? '#ffb0a6' : '#e8ffe0';
    ctx.fillText(`${KINDS[mode].icon} ${KINDS[mode].name}${why ? ` · ${WHY[why] || why}` : ''}`, c.x, c.y - 30 * z);
    ctx.restore();
  }

  // Overlay for frame(): the ghost goes on top of everything.
  const baseOverlay = window.drawInputOverlay;
  window.drawInputOverlay = function (now) { if (baseOverlay) baseOverlay(now); drawGhost(now); };

  setInterval(updateBar, 150);

  window.Structures = {
    KINDS, RULES, problem, mode: () => mode, setMode, buildTip,
    // render.js depth sort: put(screenY, kind, index) for every structure, and draw(index, now).
    sortInto(put, kind) { list().forEach((s, i) => { if (i < 1024) put(toScreen(s[3], s[4]).y, kind, i); }); },
    count: () => list().length,
    draw(i, now) { const s = list()[i]; if (s) drawStructure(s, now); },
  };
})();
