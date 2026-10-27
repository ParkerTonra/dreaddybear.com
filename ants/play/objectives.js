// Map objectives on the client (ant16; server side in ../objectives.js): aphid farms with capture rings,
// spider lairs and their spiders, the match clock in the top bar, objective toasts, and minimap marks.
// Loaded after client.js and render.js (uses their globals: ctx, curr, toScreen, scale, COLORS, NAMES, TEAM_NAMES,
// myTeam, mySide, screenAngle). client.js calls Objectives.drawGround / drawTop in frame() and onState on each state;
// minimap.js calls Objectives.drawMini.
(function (root) {
  const TEAM_COLOR = ['#e0483e', '#3b7be0'];
  const FARM_R = 1.8; // capture radius, as in objectives.js
  const doc = root.document;

  // World circle radius r -> screen ellipse semi-axes (TW 64, TH 32 isometric tiles).
  const ex = r => r * 45.25 * scale, ey = r => r * 22.63 * scale;
  const teamName = t => (curr && curr.mode === '1v1' ? `${NAMES[t]} colony` : TEAM_NAMES[t]);
  const who = t => (t === myTeam ? (curr && curr.mode === '1v1' ? 'You' : 'Your team') : teamName(t));
  const fmt = s => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

  // ---------- top bar + toasts ----------
  let hud = null, toast = null;
  function ensureDom() {
    if (hud || !doc) return;
    const clock = doc.getElementById('clock');
    if (!clock) return;
    hud = doc.createElement('span');
    hud.id = 'obj-hud';
    hud.dataset.tip = 'Aphid farms: Farms held per team, and the time left until the farm count decides the match.';
    clock.after(hud);
    toast = doc.createElement('div');
    toast.id = 'obj-toast';
    toast.className = 'hidden';
    toast.style.cssText = 'position:fixed;top:136px;left:50%;transform:translateX(-50%);background:var(--panel);border:1px solid #7bc46a;padding:6px 14px;border-radius:10px;font-size:14px;z-index:5;pointer-events:none;max-width:calc(100vw - 32px);text-align:center';
    doc.body.appendChild(toast);
  }
  function say(text, ms = 4500) {
    if (root.hudToast) { root.hudToast(text, ms, '#7bc46a'); return; } // hud.js: the shared toast column
    ensureDom();
    if (!toast) return;
    toast.textContent = text;
    toast.classList.remove('hidden');
    clearTimeout(say.t);
    say.t = setTimeout(() => toast.classList.add('hidden'), ms);
  }

  // Pure: the clock label and whether it should pulse. phase 0 normal, 1 warned (under 2:00), 2 sudden death.
  // Exported for tests. Under 2:00 the label says what the clock decides, so 0:00 is never a surprise.
  function clockText(phase, left) {
    if (phase === 2) return { text: `☠ ${fmt(left)} sudden death`, urgent: true, tip: `Sudden death: farms are tied, every nest crumbles, and the first team to lead on aphid farms wins. At 0:00 a tiebreak (nest hp, then army) ends it.` };
    const text = phase === 1 || left <= 120 ? `⏱ ${fmt(left)} farms decide` : `⏱ ${fmt(left)}`;
    return { text, urgent: left <= 30, tip: `Match clock: at 0:00 the team holding more aphid farms wins (tied: sudden death). Farms held: Red–Blue.` };
  }

  function onState(s) {
    if (!s || !s.obj) return;
    ensureDom();
    const o = s.obj, held = [0, 0];
    for (const f of o.farms) if (f[2] >= 0) held[f[2]]++;
    const [phase, left] = o.clock;
    const c = clockText(phase, left);
    const html = `🌿 <b style="color:${TEAM_COLOR[0]}">${held[0]}</b>–<b style="color:${TEAM_COLOR[1]}">${held[1]}</b> <span style="opacity:${phase || left <= 120 ? 1 : .7}${phase || left <= 120 ? ';color:#ffcf5a' : ''}">${c.text}</span>`;
    if (hud && hud.innerHTML !== html) { hud.innerHTML = html; hud.dataset.tip = c.tip; }
    if (hud && hud.classList.contains('urgent') !== c.urgent) hud.classList.toggle('urgent', c.urgent);
    for (const l of s.log || []) {
      if (l.kind !== 'obj') continue;
      if (l.what === 'farm') say(`🌿 ${who(l.team)} took an aphid farm: +1 food/s for each colony while held (workers on Hold in the ring add +0.5 each)`);
      else if (l.what === 'herd') say(`🐜 ${l.n} worker${l.n > 1 ? 's' : ''} herding aphids for ${l.team === myTeam ? 'your team' : teamName(l.team)}: +0.5 food/s each, and they are exposed`, 3500);
      else if (l.what === 'lost') say(`🌿 ${who(l.team)} lost an aphid farm`);
      else if (l.what === 'spider') say('🕷 A spider is dead: its lair dropped food and 3 🔵 pellets. Grab them!');
      else if (l.what === 'spider-back') say('🕷 A new spider moved into an empty lair');
      else if (l.what === 'warn') say(`⏱ ${fmt(l.in)} left! When time runs out, the team holding more aphid farms wins`, 7000);
      else if (l.what === 'sudden') say('☠ Sudden death! Farms are tied, nests crumble: the first team to hold more aphid farms wins', 8000);
    }
  }

  // ---------- board ----------
  function ring(c, r) { ctx.beginPath(); ctx.ellipse(c.x, c.y, ex(r), ey(r), 0, 0, Math.PI * 2); }

  function drawFarm(f, now) {
    const [x, y, owner, cap, prog, herd] = f, c = toScreen(x, y);
    // Leafy patch with aphids grazing on it.
    ring(c, 0.75); ctx.fillStyle = 'rgba(70,140,50,.85)'; ctx.fill();
    ring(c, 0.45); ctx.fillStyle = 'rgba(120,190,70,.9)'; ctx.fill();
    for (let i = 0; i < 7; i++) {
      const a = i * 2.4 + now / 3000 * (i % 2 ? 1 : -1), r = 0.2 + (i % 3) * 0.16;
      const p = toScreen(x + Math.cos(a) * r, y + Math.sin(a) * r);
      ctx.fillStyle = '#d6f27a'; ctx.beginPath(); ctx.ellipse(p.x, p.y - 2 * scale, 3.2 * scale, 2.4 * scale, 0, 0, Math.PI * 2); ctx.fill();
    }
    // Capture zone, owner colour, and the progress arc of whoever is capturing.
    ring(c, FARM_R);
    ctx.setLineDash([8 * scale, 6 * scale]); ctx.lineWidth = 2;
    ctx.strokeStyle = owner >= 0 ? TEAM_COLOR[owner] : 'rgba(240,240,220,.45)'; ctx.stroke(); ctx.setLineDash([]);
    if (owner >= 0) { ring(c, FARM_R); ctx.fillStyle = owner === 0 ? 'rgba(224,72,62,.14)' : 'rgba(59,123,224,.14)'; ctx.fill(); }
    if (cap >= 0 && prog > 0 && prog < 100) { // capture arc, outlined so it reads on the leaves
      ctx.beginPath(); ctx.ellipse(c.x, c.y, ex(1.1), ey(1.1), 0, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * prog / 100);
      ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.lineWidth = 8 * scale; ctx.stroke();
      ctx.strokeStyle = TEAM_COLOR[cap]; ctx.lineWidth = 5 * scale; ctx.stroke();
    }
    // Herders: the held farm's workers on Hold, a little herd of ants drawn on the leaves with a count above the ring.
    if (herd > 0 && owner >= 0) {
      ctx.fillStyle = 'rgba(255,230,120,.9)'; ctx.font = `600 ${Math.max(10, 12 * scale)}px system-ui, sans-serif`; ctx.textAlign = 'center';
      ctx.fillText(`🐜 ${herd} herding +${(herd * 0.5).toFixed(1)}/s`, c.x, c.y + ey(FARM_R) + 12 * scale); ctx.textAlign = 'start';
    }
    // The holder's pennant on a pole, like a nest flag: who owns the farm reads from across the board.
    const flag = owner >= 0 ? owner : cap >= 0 && prog > 0 ? cap : -1;
    if (flag >= 0) {
      const k = scale, h = 30 * k;
      ctx.strokeStyle = '#2a2016'; ctx.lineWidth = 2 * k;
      ctx.beginPath(); ctx.moveTo(c.x, c.y - 2 * k); ctx.lineTo(c.x, c.y - h); ctx.stroke();
      ctx.fillStyle = TEAM_COLOR[flag]; ctx.globalAlpha = owner >= 0 ? 1 : 0.5;
      ctx.beginPath(); ctx.moveTo(c.x, c.y - h); ctx.lineTo(c.x + 14 * k, c.y - h + 5 * k); ctx.lineTo(c.x, c.y - h + 10 * k); ctx.fill();
      ctx.globalAlpha = 1;
    }
    ctx.lineWidth = 1;
  }

  function drawLairGround(L, now) {
    const [x, y, hp, , , respawn] = L, c = toScreen(x, y);
    ring(c, 0.6); ctx.fillStyle = 'rgba(25,18,12,.85)'; ctx.fill();
    ctx.strokeStyle = 'rgba(235,235,235,.35)'; ctx.lineWidth = 1;
    for (let i = 0; i < 8; i++) { // web
      const a = i * Math.PI / 4, p = toScreen(x + Math.cos(a) * 1.5, y + Math.sin(a) * 1.5);
      ctx.beginPath(); ctx.moveTo(c.x, c.y); ctx.lineTo(p.x, p.y); ctx.stroke();
    }
    for (const r of [0.8, 1.2]) { ring(c, r); ctx.stroke(); }
    if (!hp && respawn > 0) {
      ctx.fillStyle = 'rgba(255,255,255,.75)'; ctx.font = `${Math.max(10, 13 * scale)}px system-ui`; ctx.textAlign = 'center';
      ctx.fillText(`🕷 ${respawn}s`, c.x, c.y - 14 * scale); ctx.textAlign = 'start';
    }
  }

  // ant19/creatures: the spider is a cached sprite (creature-art.js); walks while its position changes, lunges when an ant is close.
  const spiderSeen = new Map(); // lair index -> { x, y, moved }
  function drawSpider(x, y, dir, hp, now, idx) {
    const c = toScreen(x, y), k = scale;
    let s = spiderSeen.get(idx);
    if (!s) spiderSeen.set(idx, s = { x, y, moved: -1e9 });
    if (Math.abs(s.x - x) + Math.abs(s.y - y) > 0.004) { s.x = x; s.y = y; s.moved = now; }
    let attack = false;
    for (const a of curr.ants) if (Math.abs(a[3] - x) < 1.8 && Math.abs(a[4] - y) < 1.8) { attack = true; break; }
    const face = typeof screenAngle === 'function' && Math.cos(screenAngle(dir)) < 0 ? -1 : 1;
    CreatureArt.draw(ctx, 'spider', c, k, { face, pose: CreatureArt.poseFor('spider', now, { moving: now - s.moved < 350, attack }) });
    CreatureArt.bar(ctx, c, k, 40, 40, hp / 100, '#e05a4a');
  }

  // Under the ants (after drawEventGround).
  function drawGround(now) {
    const o = curr && curr.obj;
    if (!o) return;
    for (const L of o.lairs) drawLairGround(L, now);
    for (const f of o.farms) drawFarm(f, now);
  }
  // Over the ants: the spiders.
  function drawTop(now) {
    const o = curr && curr.obj;
    if (!o) return;
    o.lairs.forEach((L, i) => { if (L[2]) drawSpider(L[3], L[4], (o.dir && o.dir[i]) || 0, L[2], now, i); });
  }

  // Minimap: farms as diamonds in the holder's colour (ring while being captured), spiders as dark dots.
  function drawMini(g, at, pulse) {
    const o = curr && curr.obj;
    if (!o) return;
    for (const f of o.farms) {
      const c = at(f[0], f[1]);
      g.beginPath(); g.moveTo(c.x, c.y - 4.5); g.lineTo(c.x + 4.5, c.y); g.lineTo(c.x, c.y + 4.5); g.lineTo(c.x - 4.5, c.y); g.closePath();
      g.fillStyle = f[2] >= 0 ? TEAM_COLOR[f[2]] : '#7bc46a'; g.fill(); g.strokeStyle = '#0f1a0a'; g.lineWidth = 1; g.stroke();
      if (f[3] >= 0 && f[4] > 0 && f[4] < 100) { g.strokeStyle = TEAM_COLOR[f[3]]; g.globalAlpha = .5 + .5 * pulse; g.lineWidth = 1.5; g.beginPath(); g.arc(c.x, c.y, 7, 0, Math.PI * 2); g.stroke(); g.globalAlpha = 1; }
    }
    for (const L of o.lairs) {
      const c = at(L[2] ? L[3] : L[0], L[2] ? L[4] : L[1]);
      g.beginPath(); g.arc(c.x, c.y, L[2] ? 3 : 2, 0, Math.PI * 2);
      g.fillStyle = L[2] ? '#2a1d14' : 'rgba(42,29,20,.4)'; g.fill();
      if (L[2]) { g.strokeStyle = '#c0281e'; g.lineWidth = 1; g.stroke(); }
    }
  }

  root.Objectives = { onState, drawGround, drawTop, drawMini, clockText };
})(typeof window !== 'undefined' ? window : globalThis);
