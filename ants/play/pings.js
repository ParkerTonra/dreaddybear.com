// Team pings & quick chat. Loaded after client.js and uses its globals
// (curr, mySide, send, toScreen, screenToWorld, COLORS, NAMES, ctx, canvas, scale).
(() => {
  const PING_MS = 4000, TOAST_MS = 4000;
  const KINDS = {
    attack: { icon: '⚔️', label: 'Attack here' },
    defend: { icon: '🛡️', label: 'Defend' },
    help: { icon: '❗', label: 'Help!' },
  };
  const CHAT = { attack: 'Attack!', defend: 'Defend!', food: 'Need food', help: 'Help!', nice: 'Nice!', gg: 'GG' };
  let pings = []; // { from, kind, x, y, at }
  let armed = false; // '.' pressed: next click on the board opens the ping menu

  const css = document.createElement('style');
  css.textContent = `
    #pg-bar { position: fixed; left: 12px; bottom: 12px; display: flex; flex-wrap: wrap; gap: 6px; max-width: 30vw; background: var(--panel); padding: 8px; border-radius: 12px; z-index: 5; }
    #pg-bar button, #pg-menu button { padding: 5px 9px; font-size: 13px; }
    #pg-bar .armed { background: #f4efe6; }
    #pg-toasts { position: fixed; left: 12px; top: 64px; display: flex; flex-direction: column; gap: 6px; z-index: 5; pointer-events: none; }
    #pg-toasts div { background: var(--panel); padding: 6px 12px; border-radius: 8px; font-size: 14px; animation: pg-in .2s; }
    @keyframes pg-in { from { opacity: 0; transform: translateX(-12px); } }
    #pg-menu { position: fixed; display: flex; gap: 4px; transform: translate(-50%, -130%); background: var(--panel); padding: 6px; border-radius: 10px; z-index: 6; }
    @media (max-width: 720px) { #pg-bar .chat { display: none; } }`;
  document.head.appendChild(css);
  const el = (tag, id, parent = document.body) => { const e = document.createElement(tag); if (id) e.id = id; parent.appendChild(e); return e; };
  const bar = el('div', 'pg-bar'); bar.classList.add('hidden');
  const toasts = el('div', 'pg-toasts');
  const menu = el('div', 'pg-menu'); menu.classList.add('hidden');

  const pingBtn = el('button', null, bar);
  pingBtn.textContent = '📍 Ping [.]';
  pingBtn.dataset.tip = 'Ping [.]: Mark a tile for your team. Or Alt+click the board.';
  pingBtn.onclick = () => arm(!armed);
  for (const [id, text] of Object.entries(CHAT)) {
    const b = el('button', null, bar);
    b.className = 'chat'; b.textContent = text;
    b.dataset.tip = id === 'gg' ? 'Good game: Everyone sees this.' : 'Quick chat: Sent to your team.';
    b.onclick = () => send({ type: 'chat', id });
  }
  let menuAt = null;
  for (const [kind, k] of Object.entries(KINDS)) {
    const b = el('button', null, menu);
    b.textContent = `${k.icon} ${k.label}`;
    b.onclick = () => { if (menuAt) send({ type: 'ping', kind, x: menuAt.x, y: menuAt.y }); closeMenu(); };
  }

  const playing = () => curr && mySide >= 0 && curr.players[mySide] && curr.players[mySide].alive;
  function arm(on) {
    armed = on && !!playing();
    pingBtn.classList.toggle('armed', armed);
    canvas.style.cursor = armed ? 'crosshair' : '';
  }
  function closeMenu() { menu.classList.add('hidden'); menuAt = null; }

  function toast(from, html) {
    const t = el('div', null, toasts);
    t.innerHTML = `<b style="color:${COLORS[from]}">${NAMES[from]}</b>: ${html}`;
    setTimeout(() => t.remove(), TOAST_MS);
    while (toasts.children.length > 5) toasts.firstChild.remove();
  }

  // Alt+click (or . then click) on the board opens the ping menu instead of selecting or ordering.
  addEventListener('pointerdown', e => {
    if (e.target !== canvas) return;
    if (menuAt) { closeMenu(); e.stopPropagation(); return; }
    if (!(e.altKey || armed) || !playing() || e.button !== 0) return;
    e.stopPropagation(); e.preventDefault();
    const w = screenToWorld(e.clientX, e.clientY);
    arm(false);
    if (!(w.x >= 0 && w.y >= 0 && w.x <= curr.map && w.y <= curr.map)) return;
    menuAt = w;
    menu.style.left = e.clientX + 'px'; menu.style.top = e.clientY + 'px';
    menu.classList.remove('hidden');
  }, true);
  addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT') return;
    if (Keys.is(e, 'ping.arm')) arm(!armed); // ant16: G went to the pheromone trail
    if (Keys.is(e, 'cancel')) { arm(false); closeMenu(); }
  });

  function drawPing(p, now) {
    const age = now - p.at, c = toScreen(p.x, p.y), k = scale, col = COLORS[p.from];
    if (window.UIWorld) { UIWorld.ping(ctx, c, k, age, PING_MS, col, p.kind); return; } // ant19/ui-world
    ctx.save();
    ctx.strokeStyle = col; ctx.lineWidth = 3;
    for (let i = 0; i < 3; i++) { // three rings pulsing outward
      const t = ((age / 900) + i / 3) % 1;
      ctx.globalAlpha = (1 - t) * Math.min(1, (PING_MS - age) / 600);
      ctx.beginPath(); ctx.ellipse(c.x, c.y, (8 + 34 * t) * k, (4 + 17 * t) * k, 0, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.globalAlpha = Math.min(1, (PING_MS - age) / 600);
    const bob = Math.sin(age / 150) * 3 * k;
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.arc(c.x, c.y - 34 * k + bob, 13 * k, 0, Math.PI * 2); ctx.fill();
    ctx.font = `${Math.round(15 * k)}px system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(KINDS[p.kind].icon, c.x, c.y - 34 * k + bob);
    ctx.restore();
  }

  window.Pings = {
    // Called first by client.js onMessage; returns true if the message was ours.
    onMessage(m) {
      if (m.type === 'start') { pings = []; arm(false); closeMenu(); }
      if (m.type === 'ping' && KINDS[m.kind]) {
        pings.push({ from: m.from, kind: m.kind, x: m.x, y: m.y, at: performance.now() });
        if (m.from !== mySide) toast(m.from, `${KINDS[m.kind].icon} ${KINDS[m.kind].label}`);
        return true;
      }
      if (m.type === 'chat' && CHAT[m.id]) { toast(m.from, CHAT[m.id]); return true; }
      return m.type === 'ping' || m.type === 'chat';
    },
    // Called from client.js frame() after the board is drawn.
    draw(now) {
      bar.classList.toggle('hidden', !(curr && mySide >= 0)); // dead players can still chat
      if (!playing()) { if (armed) arm(false); closeMenu(); }
      // (Rally flags show only for your selected building, client.js drawBuildingFlags: no teammate flags either.)
      pings = pings.filter(p => now - p.at < PING_MS);
      for (const p of pings) drawPing(p, now);
    },
  };
})();
