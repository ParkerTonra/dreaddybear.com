// Evolutions client (research lane): the research bar above the spawn buttons, hotkeys T Y U I O R,
// evolution icons on every colony's chip in the top bar, and a toast when another colony evolves.
// Loaded after client.js and hud.js; uses their globals ($, curr, mySide, myTeam, send, COLORS, NAMES, updateHud).
// Server side: research.js. Prices and times come from the snapshot (upgradeTable), so they stay in step.
(function () {
  const tipSet = (el, t) => typeof Tip !== 'undefined' ? Tip.set(el, t) : (el.title = t); // tip.js
  const EVOS = [
    { id: 'dmg', icon: '🦷', name: 'Mandibles', key: 'T', desc: '+15% army damage per tier',
      perk: 'Shearing bite: a soldier\'s bite also hits a second enemy next to its target for half damage' },
    { id: 'chitin', icon: '🛡️', name: 'Chitin', key: 'Y', desc: '+15% HP for every caste but workers, and 10% less nest damage, per tier',
      perk: 'Thick walls: your nest and finished buildings regrow 1.5 hp/s while no enemy fighter is within 4 tiles' },
    { id: 'acid', icon: '🧪', name: 'Acid glands', key: 'U', desc: '+0.25 spitter range and +0.12 splash per tier',
      perk: 'Lingering acid: every glob leaves a puddle for 2.5 s that slows enemies to 60% (hawkers fly over it)' },
    { id: 'legs', icon: '🦵', name: 'Long legs', key: 'I', desc: '+7% speed for every ant per tier',
      perk: 'Weatherproof: rain and flood do not slow your ants (the enemy\'s still crawl), and mud slows you less' },
    { id: 'forage', icon: '🌾', name: 'Big crops', key: 'O', desc: '+1 food carried per worker trip per tier',
      perk: 'Granary: workers carry 2 pellets a trip and food deliveries pay +10%' },
    { id: 'jelly', icon: '🍯', name: 'Royal jelly', key: 'R', desc: '+25% nurse healing per tier; nurses also tend workers',
      perk: 'Triage: each nurse also heals a second patient (the next most hurt) at half rate' },
  ];
  const TIER = ['', 'I', 'II', 'III'];
  const byId = Object.fromEntries(EVOS.map(e => [e.id, e]));

  const css = document.createElement('style');
  css.textContent = `
    #hud-upgrades .upg { position: relative; padding: 4px 8px; font-size: 12px; line-height: 1.15; background: linear-gradient(90deg, #8fcaff var(--fill, 0%), #5ab0ff var(--fill, 0%)); text-align: left; }
    #hud-upgrades .upg.busy { outline: 2px solid #f4efe6; }
    #hud-upgrades .upg.mastery { background: #3a4a5a; color: #f4efe6; }
    #hud-upgrades .upg .pips { letter-spacing: 1px; font-size: 10px; }
    #hud-upgrades .upg small { display: block; font-weight: 500; font-size: 10.5px; opacity: .85; }
    #hud-upgrades .upg kbd { margin-left: 3px; min-width: 0; padding: 0 3px; font-size: 10px; color: var(--ink); }
    @media (hover: none) { #hud-upgrades .upg kbd { display: none; } }
    @media (max-width: 620px) { #hud-upgrades { flex-wrap: wrap; justify-content: center; white-space: normal; max-width: calc(100vw - 16px); } }
    .chip .evo { font-size: .78em; font-weight: 600; opacity: .9; margin-left: 3px; letter-spacing: -1px; }
    .chip .evo b { font-size: .8em; letter-spacing: 0; margin-right: 2px; }
    #evo-toasts { position: fixed; top: 140px; left: 50%; transform: translateX(-50%); display: flex; flex-direction: column; gap: 4px; align-items: center; z-index: 6; pointer-events: none; }
    #evo-toasts div { background: var(--panel); padding: 5px 12px; border-radius: 8px; font-size: 13px; transition: opacity .6s; }
  `;
  document.head.appendChild(css);
  const toasts = document.createElement('div');
  toasts.id = 'evo-toasts';
  document.body.appendChild(toasts);

  function build() {
    const bar = $('hud-upgrades');
    bar.innerHTML = '<span id="u-pellets" data-tip="Pellets: Workers bring these home from the blue piles on the map. Evolutions from tier II on, and majors, cost pellets.">🔵 0</span>' +
      EVOS.map(e => `<button id="u-${e.id}" class="upg"><span>${e.icon} <span class="pips"></span><kbd data-key-hint="evo.${e.id}">${Keys.label(`evo.${e.id}`)}</kbd></span><small></small></button>`).join('');
    for (const e of EVOS) {
      const b = $(`u-${e.id}`);
      b.onclick = () => research(e.id);
      b.oncontextmenu = ev => { ev.preventDefault(); cancel(e.id); }; // right-click the running research cancels it
    }
  }
  const me = () => curr && mySide >= 0 && curr.players[mySide];
  function research(id) {
    const p = me();
    if (!p || !p.alive) return;
    send({ type: 'upgrade', id });
  }
  function cancel(id) {
    const p = me();
    if (p && p.research && p.research.id === id) send({ type: 'upgrade', cancel: true });
  }

  function update() {
    const bar = $('hud-upgrades');
    const p = me();
    const show = p && p.upgrades && curr.upgradeTable && !$('hud-bottom').classList.contains('hidden');
    bar.classList.toggle('hidden', !show);
    if (!show) return;
    $('u-pellets').textContent = `🔵 ${p.pellets}`;
    const mastered = EVOS.find(e => (p.upgrades[e.id] || 0) >= 3);
    for (const e of EVOS) {
      const b = $(`u-${e.id}`), t = curr.upgradeTable[e.id];
      if (!b || !t) continue;
      const lvl = p.upgrades[e.id] || 0, r = p.research && p.research.id === e.id ? p.research : null;
      const locked = !r && lvl === 2 && mastered;
      b.querySelector('.pips').textContent = '●'.repeat(lvl) + (r ? '◐' : '') + '○'.repeat(Math.max(0, 3 - lvl - (r ? 1 : 0)));
      const { line, tip } = evoLine(e, t, lvl, r, locked, mastered, p);
      b.querySelector('small').textContent = line;
      tipSet(b, `${e.icon} ${e.name} [${Keys.label(`evo.${e.id}`)}]: ${e.desc}. ${tip}${!r && lvl < 2 ? ' Only one evolution can reach tier III.' : ''}${lvl < 3 ? ` Tier III also gives ${e.perk}.` : ''}`);
      b.style.setProperty('--fill', r ? `${Math.round((1 - r.left / r.total) * 100)}%` : '0%');
      b.classList.toggle('busy', !!r);
      b.classList.toggle('mastery', !!locked);
      b.disabled = !r && (!p.alive || lvl >= 3 || locked || !!p.research || poor(t, lvl, p));
    }
  }
  const poor = (t, lvl, p) => lvl < 3 && (p.food < t.food[lvl] || (p.pellets || 0) < t.pellets[lvl]);
  // Pure: the button's second line and its tooltip, saying why it is grey (busy, short of food or pellets, mastery).
  // e: EVOS entry, t: upgradeTable row, lvl: finished tier, r: this evolution's running research or null. Exported for tests.
  function evoLine(e, t, lvl, r, locked, mastered, p) {
    const price = lvl < 3 ? `${t.food[lvl]}🍃${t.pellets[lvl] ? ` ${t.pellets[lvl]}🔵` : ''}` : '';
    if (r) return { line: `⏳ ${TIER[r.level]} · ${r.left}s`, tip: `Researching ${e.name} ${TIER[r.level]}: ${r.left}s left. Right-click (or Shift+${Keys.label(`evo.${e.id}`)}) to cancel, full refund.` };
    if (lvl >= 3) return { line: 'Mastered', tip: `${e.name} mastered (tier III). ${e.perk}.` };
    if (locked) return { line: 'II · max', tip: `Only one evolution can reach tier III, and you mastered ${mastered.name}.` };
    const tip = `${e.name} ${TIER[lvl + 1]} [${Keys.label(`evo.${e.id}`)}]: ${price.replace('🍃', ' food').replace('🔵', ' pellet' + (t.pellets[lvl] > 1 ? 's' : ''))}, ${t.time[lvl]}s.`;
    const need = [p.food < t.food[lvl] ? `${t.food[lvl] - p.food} more food` : '', (p.pellets || 0) < t.pellets[lvl] ? `${t.pellets[lvl] - (p.pellets || 0)} more pellet${t.pellets[lvl] - (p.pellets || 0) > 1 ? 's' : ''}` : ''].filter(Boolean).join(' and ');
    const why = !p.alive ? 'your nest has fallen' : p.research ? `research is busy (${byId[p.research.id].name} ${TIER[p.research.level]}, ${p.research.left}s left; one at a time)` : need ? `need ${need}` : '';
    return { line: `${TIER[lvl + 1]} · ${price}`, tip: why ? `${tip} Greyed: ${why}.` : tip };
  }

  // Top bar: evolution tiers next to every colony's chip, so players can see what the enemy evolved.
  // Teammates' running research shows too (🔬); enemy research stays hidden until it lands.
  function chipIcons(s) {
    for (const team of [0, 1]) {
      const chips = $(`team${team}`).children;
      s.players.forEach((p, i) => {
        if (p.team !== team || !p.upgrades) return;
        const el = chips[i >> 1];
        if (!el) return;
        const got = EVOS.filter(e => p.upgrades[e.id]).map(e => `${e.icon}${p.upgrades[e.id]}`);
        const mine = myTeam >= 0 && p.team === myTeam;
        const r = mine && p.research ? `<b data-tip="Researching: ${byId[p.research.id].name} ${TIER[p.research.level]}, ${p.research.left}s left.">🔬${p.research.left}s</b>` : '';
        if (!got.length && !r) return;
        const span = document.createElement('span');
        span.className = 'evo';
        span.dataset.tip = 'Evolutions: ' + (EVOS.filter(e => p.upgrades[e.id]).map(e => `${e.name} ${TIER[p.upgrades[e.id]]}`).join(', ') || 'none yet');
        span.innerHTML = r + got.join(' ');
        el.appendChild(span);
      });
    }
  }
  const baseHud = updateHud;
  updateHud = function () { baseHud.apply(this, arguments); if (curr && curr.players) chipIcons(curr); };

  // Toast when any colony finishes an evolution, and when yours starts one (diffed from snapshots, so a
  // merged state never loses one). Toasts go through hud.js's one column, so they stack with the others.
  let seen = null, running = null;
  function watch() {
    const s = curr;
    if (!s || !s.players) return;
    const now = s.players.map(p => ({ ...(p.upgrades || {}) }));
    if (seen && seen.length === now.length && s.t >= (watch.t || 0)) {
      now.forEach((u, i) => {
        for (const e of EVOS) if ((u[e.id] || 0) > (seen[i][e.id] || 0)) toast(i, e, u[e.id]);
      });
    }
    seen = now; watch.t = s.t;
    const p = me(), key = p && p.research ? `${p.research.id}:${p.research.level}` : null;
    if (key && key !== running && seen.length) { const e = byId[p.research.id]; if (e) show(`🔬 Researching ${e.icon} <b>${e.name} ${TIER[p.research.level]}</b> · ${p.research.total}s`, 3000, '#5ab0ff'); }
    running = key;
  }
  const show = (html, ms, border) => {
    if (typeof hudToast === 'function') return hudToast(html, ms, border);
    const t = document.createElement('div');
    t.innerHTML = html; toasts.appendChild(t);
    while (toasts.children.length > 4) toasts.firstChild.remove();
    setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 700); }, ms);
  };
  function toast(i, e, lvl) {
    const yours = i === mySide;
    show(`<b style="color:${COLORS[i]}">${yours ? 'You' : NAMES[i]}</b> evolved ${e.icon} ${e.name} ${TIER[lvl]}`, 3500, yours ? '#5ab0ff' : undefined);
  }

  addEventListener('keydown', ev => {
    if (ev.target.tagName === 'INPUT') return;
    const e = EVOS.find(x => Keys.is(ev, 'evo.' + x.id));
    if (!e) return;
    const p = me();
    if (ev.shiftKey) cancel(e.id); // Shift + key cancels that research
    else if (p && !(p.research && p.research.id === e.id)) research(e.id);
  });

  build();
  setInterval(() => { update(); watch(); }, 150);
  window.Research = { EVOS, update, evoLine };
})();
