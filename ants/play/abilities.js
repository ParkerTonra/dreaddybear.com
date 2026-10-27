// Active abilities (ant16), client side: hotkeys, targeting, the cooldown bar and the on-map effects.
// Server rules live in abilities.js; this file only sends { type: 'ability', ... } and draws the snapshot's `abil`.
//   G  Pheromone trail: drag (or click start, then end) a line; your ants on it run faster
//   J  Alarm pheromone: selected fighters (or all of them) bite harder, then tire
//   K  Acid volley: click a spot; your spitters in range lob one big glob there after a visible warning
//   L  Queen's call: every ant runs home and the fighters guard the nest
// Loaded after input.js and panel.js. Uses client.js / input.js globals at runtime: curr, mySide, send,
// toScreen, screenToWorld, scale, ctx, canvas, COLORS, lerpAnts, sel. client.js calls Abilities.onState,
// Abilities.drawGround and Abilities.drawOver.
(function (root) {
  const doc = root.document;
  const tipSet = (el, t) => root.Tip ? root.Tip.set(el, t) : (el.title = t); // tip.js
  const LIST = [ // order = snapshot abil.cd order (abilities.js ABILITY_IDS)
    { id: 'trail', key: 'G', icon: '〰', name: 'Trail', title: 'Pheromone trail [G]: drag a line (or click its start, then its end). Your ants on it move 40% faster for 20 s. Cooldown 35 s.' },
    { id: 'alarm', key: 'J', icon: '❗', name: 'Alarm', title: 'Alarm pheromone [J]: selected fighters (none selected: all of them) bite 50% harder for 5 s, then are tired (slow and weak) for 6 s. Cooldown 30 s.' },
    { id: 'volley', key: 'K', icon: '☄', name: 'Volley', title: 'Acid volley [K]: click a spot within 4.5 tiles of your spitters. Up to 5 of them lob one big glob that lands 1.6 s later; the enemy sees it coming. Cooldown 40 s.' },
    { id: 'call', key: 'L', icon: '👑', name: 'Call', title: "Queen's call [L]: every ant runs home 50% faster; fighters then guard the nest. Cooldown 90 s." },
  ];
  const TRAIL_MAX = 9, VOLLEY_R = 1.5, VOLLEY_RANGE = 4.5;
  const ACID = '#a6e23a';
  const COOLDOWN = { trail: 35, alarm: 30, volley: 40, call: 90 };
  const S2 = Math.SQRT2;

  let armed = null; // 'trail' | 'volley'
  let trailStart = null, downAt = null, mouse = null, rightDown = null;

  const playing = () => typeof curr !== 'undefined' && curr && mySide >= 0 && curr.players[mySide] && curr.players[mySide].alive && curr.winner === null;
  const cdLeft = id => { const c = curr && curr.abil && curr.abil.cd[mySide]; return c ? c[LIST.findIndex(a => a.id === id)] || 0 : 0; };
  const use = m => send({ type: 'ability', ...m });
  const onMap = w => w.x >= 0 && w.y >= 0 && w.x <= curr.map && w.y <= curr.map;
  const fighters = () => curr.ants.filter(a => a[1] === mySide && a[2] !== 0);

  const PROMPT = { trail: '〰 <b>Trail</b>: drag a line on the board (or click its start, then its end)', volley: '☄ <b>Volley</b>: click where the acid should land, within 4.5 tiles of your spitters' };
  const notice = (text, ms) => { if (typeof netNotice === 'function') netNotice(text, ms || 2200); };
  function arm(id) {
    armed = armed === id ? null : id;
    trailStart = null; downAt = null;
    if (armed && root.Orders) root.Orders.cancelMode(); // one pending map-click order at a time
    if (armed && root.Structures && root.Structures.mode() >= 0) root.Structures.setMode(-1); // ...and one armed layer: build mode goes
    if (root.Orders && root.Orders.setPrompt) root.Orders.setPrompt(armed ? `${PROMPT[armed]} · <small>Esc cancels</small>` : null, disarm); // input.js prompt line
    canvas.style.cursor = armed ? 'crosshair' : '';
    paint();
  }
  const disarm = () => { if (armed) arm(armed); };

  // Pure: why pressing this ability does nothing right now (null = it works). Exported for tests.
  function blocked(id, left, nFighters, nSpitters) {
    if (left > 0) return `${LIST.find(a => a.id === id).name} ready in ${Math.ceil(left)}s`;
    if (id === 'alarm' && !nFighters) return 'Alarm: you have no fighters to alarm';
    if (id === 'volley' && !nSpitters) return 'Acid volley: you have no spitters';
    return null;
  }

  // Press an ability (hotkey or bar button). A press that can't work says why instead of doing nothing.
  function trigger(id) {
    if (!playing()) return;
    const why = blocked(id, cdLeft(id), fighters().length, curr.ants.filter(a => a[1] === mySide && a[2] === 2).length);
    if (why) { notice(why); return; }
    if (id === 'trail' || id === 'volley') return arm(id);
    if (id === 'alarm') {
      const picked = typeof sel !== 'undefined' && sel.size ? fighters().filter(a => sel.has(a[0])) : [];
      const ids = (picked.length ? picked : fighters()).map(a => a[0]).slice(0, 60);
      if (ids.length) use({ id: 'alarm', ids });
    } else if (id === 'call') use({ id: 'call' });
  }

  function finishTrail(w) {
    const a = trailStart;
    trailStart = null; downAt = null;
    const L = Math.hypot(w.x - a.x, w.y - a.y);
    if (L < 1) return; // too short: keep waiting for an end point
    use({ id: 'trail', x: a.x, y: a.y, x2: w.x, y2: w.y });
    disarm();
  }

  // ---------- Input: window capture so targeting clicks never reach input.js (orders) ----------
  root.addEventListener('pointermove', e => { if (e.target === canvas) mouse = { sx: e.clientX, sy: e.clientY }; }, { passive: true });
  root.addEventListener('pointerdown', e => {
    if (!armed || e.target !== canvas || !e.isPrimary || !playing()) return;
    if (e.button === 2) { rightDown = { x: e.clientX, y: e.clientY }; return; } // camera.js may pan with it
    if (e.button !== 0) return;
    e.stopImmediatePropagation();
    const w = screenToWorld(e.clientX, e.clientY);
    mouse = { sx: e.clientX, sy: e.clientY };
    if (!onMap(w)) return;
    if (armed === 'volley') { use({ id: 'volley', x: w.x, y: w.y }); disarm(); return; }
    if (!trailStart) { trailStart = w; downAt = { x: e.clientX, y: e.clientY }; } else finishTrail(w);
  }, true);
  root.addEventListener('pointerup', e => {
    if (!armed || e.target !== canvas || !e.isPrimary) return;
    if (e.button === 2 && rightDown) { // a right-click (not a pan) cancels, StarCraft style
      const click = Math.hypot(e.clientX - rightDown.x, e.clientY - rightDown.y) < 6;
      rightDown = null;
      if (click) { e.stopImmediatePropagation(); disarm(); }
      return;
    }
    if (e.button !== 0) return;
    e.stopImmediatePropagation();
    if (armed === 'trail' && trailStart && downAt && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 12) {
      const w = screenToWorld(e.clientX, e.clientY);
      finishTrail({ x: Math.max(0, Math.min(curr.map, w.x)), y: Math.max(0, Math.min(curr.map, w.y)) });
    }
    downAt = null;
  }, true);
  root.addEventListener('keydown', e => {
    if (Keys.is(e, 'cancel') && armed) { e.stopImmediatePropagation(); disarm(); }
  }, true);
  root.addEventListener('keydown', e => {
    const t = e.target && e.target.tagName;
    if (t === 'INPUT' || t === 'SELECT' || !playing()) return;
    const ab = LIST.find(a => Keys.is(e, 'ability.' + a.id));
    if (ab) { e.preventDefault(); trigger(ab.id); }
    else if (armed && (Keys.is(e, 'order.attack') || Keys.is(e, 'order.patrol'))) disarm(); // input.js armed its own click order
  });

  // ---------- Cooldown bar ----------
  let bar = null, last = '';
  if (doc) {
    const css = doc.createElement('style');
    css.textContent = `
      #ab-bar { position: fixed; left: 12px; bottom: 12px; display: flex; flex-direction: column; gap: 5px; background: var(--panel); padding: 6px; border-radius: 12px; z-index: 5; user-select: none; }
      #ab-bar button { position: relative; overflow: hidden; padding: 5px 9px; font-size: 13px; min-width: 112px; text-align: left; }
      #ab-bar button > * { position: relative; z-index: 1; }
      #ab-bar button .cd { position: absolute; right: 0; top: 0; bottom: 0; z-index: 0; background: rgba(20,14,8,.55); width: 0; }
      #ab-bar button.wait { background: #8a7a58; color: #f4efe6; }
      #ab-bar button.wait .t { font-weight: 800; }
      #ab-bar button.armed { background: ${ACID}; box-shadow: 0 0 0 2px #f4efe6; }
      #ab-bar small { opacity: .7; }
      @media (max-width: 720px) { #ab-bar .nm { display: none; } #ab-bar button { min-width: 0; padding: 5px 7px; } }`;
    doc.head.appendChild(css);
    bar = doc.createElement('div');
    bar.id = 'ab-bar';
    bar.className = 'hidden';
    bar.innerHTML = LIST.map(a => `<button data-ab="${a.id}" data-tip="${a.title.replace(`[${a.key}]`, `[${Keys.label(`ability.${a.id}`)}]`)}" aria-label="${a.name}">${a.icon} <span class="nm">${a.name}</span> <small data-key-hint="ability.${a.id}">[${Keys.label(`ability.${a.id}`)}]</small><span class="t"></span><i class="cd"></i></button>`).join('');
    bar.addEventListener('animationend', e => { if (e.target.classList) e.target.classList.remove('ready'); }); // the ready pop (index.html css)
    bar.addEventListener('click', e => {
      const b = e.target.closest && e.target.closest('button');
      if (!b) return;
      e.stopPropagation(); b.blur();
      trigger(b.dataset.ab);
    });
    const mount = () => doc.body.appendChild(bar);
    if (doc.body) mount(); else root.addEventListener('DOMContentLoaded', mount);
  }
  // The pings bar (pings.js) also lives bottom-left: sit on top of it.
  function place() {
    const pg = doc.getElementById('pg-bar');
    const up = pg && !pg.classList.contains('hidden') && pg.offsetHeight ? parseFloat(pg.style.bottom || '12') + pg.offsetHeight + 6 : 12;
    bar.style.bottom = up + 'px';
  }
  function paint() {
    if (!bar) return;
    const on = playing();
    bar.classList.toggle('hidden', !on);
    if (!on) { if (armed) { armed = null; canvas.style.cursor = ''; } return; }
    const state = LIST.map(a => `${a.id}:${Math.ceil(cdLeft(a.id))}:${armed === a.id}`).join('|');
    if (state === last) return;
    last = state;
    for (const b of bar.children) {
      const a = LIST.find(x => x.id === b.dataset.ab), left = cdLeft(a.id);
      if (b.classList.contains('wait') && left <= 0) b.classList.add('ready'); // cooldown just ended: pop once
      b.classList.toggle('wait', left > 0);
      b.classList.toggle('armed', armed === a.id);
      b.querySelector('.t').textContent = left > 0 ? ` ${Math.ceil(left)}s` : '';
      // The dark cover retreats to the right as the ability recharges: the button fills up like a cost bar.
      b.querySelector('.cd').style.width = left > 0 ? `${Math.min(100, left / COOLDOWN[a.id] * 100)}%` : '0';
      tipSet(b, left > 0 ? a.title.replace(': ', `: Not ready: ${Math.ceil(left)}s left. `) : a.title);
    }
  }
  if (doc) setInterval(() => { place(); paint(); }, 200);

  // ---------- Snapshot hook: impact bursts ----------
  function onState(s) {
    if (!s || !s.log) return;
    const now = root.performance.now();
    for (const l of s.log) {
      if (l.kind === 'volley-hit' && root.FX && root.FX.burst) root.FX.burst(l.x, l.y, now, ACID, 'rgba(150,210,60,', 14);
      if (l.kind === 'ability' && l.id === 'alarm' && root.FX && root.FX.burst) root.FX.burst(l.x, l.y, now, '#ff6a4a', null, 8);
    }
    paint();
  }

  // ---------- Drawing ----------
  const ell = (c, r) => { ctx.beginPath(); ctx.ellipse(c.x, c.y, r * 32 * S2 * scale, r * 16 * S2 * scale, 0, 0, Math.PI * 2); };

  function drawTrail(c, x1, y1, x2, y2, left, now, preview) {
    const a = toScreen(x1, y1), b = toScreen(x2, y2), fade = preview ? 0.7 : Math.min(1, left / 3);
    ctx.save();
    ctx.lineCap = 'round';
    ctx.strokeStyle = COLORS[c]; ctx.globalAlpha = 0.3 * fade; ctx.lineWidth = 30 * scale;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    // Pheromone dots flowing from the start to the end.
    ctx.globalAlpha = 0.85 * fade; ctx.lineWidth = 3 * scale; ctx.strokeStyle = '#f4efe6';
    ctx.setLineDash([3 * scale, 9 * scale]); ctx.lineDashOffset = -now / 40;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    ctx.restore();
  }

  function drawVolley(v, now) {
    const [c, x, y, r, left] = v, p = toScreen(x, y), t = Math.max(0, Math.min(1, 1 - left / 1.6)), pulse = 0.5 + 0.5 * (globalThis.motionSin || Math.sin)(now / 70);
    ctx.save();
    ctx.fillStyle = ACID; ctx.globalAlpha = 0.12 + 0.25 * t; ell(p, r * t); ctx.fill();
    ctx.strokeStyle = COLORS[c]; ctx.globalAlpha = 0.6 + 0.4 * pulse; ctx.lineWidth = 3;
    ctx.setLineDash([8, 6]); ell(p, r); ctx.stroke(); ctx.setLineDash([]);
    ctx.strokeStyle = ACID; ctx.lineWidth = 2; ell(p, r); ctx.stroke();
    ctx.globalAlpha = 1; ctx.fillStyle = '#f4efe6'; ctx.font = `bold ${Math.max(11, Math.round(14 * scale))}px system-ui, sans-serif`; ctx.textAlign = 'center';
    ctx.fillText && ctx.fillText(`☄ ${left.toFixed(1)}`, p.x, p.y - r * 16 * S2 * scale - 6);
    ctx.restore();
  }

  // Under the ants: trails, volley warnings, alarm/tired/called markers, the targeting preview.
  function drawGround(now) {
    const ab = curr && curr.abil;
    if (!ab) return;
    for (const t of ab.trails) drawTrail(t[0], t[1], t[2], t[3], t[4], t[5], now);
    if (ab.alarm.length || ab.tired.length || ab.called.length) {
      const al = new Set(ab.alarm), ti = new Set(ab.tired), ca = new Set(ab.called), pulse = 0.5 + 0.5 * (globalThis.motionSin || Math.sin)(now / 90);
      ctx.save();
      for (const a of lerpAnts(now)) {
        const k = a[2] ? 1.4 : 1;
        if (al.has(a[0])) { const c = toScreen(a[3], a[4]); ctx.strokeStyle = '#ff4a2a'; ctx.globalAlpha = 0.5 + 0.5 * pulse; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.ellipse(c.x, c.y, 12 * k * scale, 6 * k * scale, 0, 0, Math.PI * 2); ctx.stroke(); }
        else if (ti.has(a[0])) { const c = toScreen(a[3], a[4]); ctx.fillStyle = '#9fb4c8'; ctx.globalAlpha = 0.9; ctx.font = `bold ${Math.max(9, Math.round(10 * scale))}px system-ui`; ctx.fillText && ctx.fillText('z', c.x + 6 * scale, c.y - 12 * scale); }
        if (ca.has(a[0])) { const c = toScreen(a[3], a[4]); ctx.strokeStyle = '#f0d86a'; ctx.globalAlpha = 0.55; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.ellipse(c.x, c.y, 8 * k * scale, 4 * k * scale, 0, 0, Math.PI * 2); ctx.stroke(); }
      }
      ctx.restore();
    }
    if (armed && mouse && playing()) drawPreview(now);
  }

  function drawPreview(now) {
    const w = screenToWorld(mouse.sx, mouse.sy);
    if (armed === 'trail') {
      if (!trailStart) { ctx.save(); ctx.strokeStyle = COLORS[mySide]; ctx.lineWidth = 2; ell(toScreen(w.x, w.y), 0.4); ctx.stroke(); ctx.restore(); return; }
      let { x, y } = w; const L = Math.hypot(x - trailStart.x, y - trailStart.y);
      if (L > TRAIL_MAX) { x = trailStart.x + (x - trailStart.x) / L * TRAIL_MAX; y = trailStart.y + (y - trailStart.y) / L * TRAIL_MAX; }
      drawTrail(mySide, trailStart.x, trailStart.y, x, y, 9, now, true);
    } else if (armed === 'volley') {
      const sp = curr.ants.filter(a => a[1] === mySide && a[2] === 2);
      const reach = sp.filter(a => Math.hypot(a[3] - w.x, a[4] - w.y) <= VOLLEY_RANGE).length;
      ctx.save();
      ctx.strokeStyle = 'rgba(166,226,58,.25)'; ctx.lineWidth = 1;
      for (const a of sp) { ell(toScreen(a[3], a[4]), VOLLEY_RANGE); ctx.stroke(); }
      ctx.strokeStyle = reach ? ACID : '#ff5a4a'; ctx.lineWidth = 2; ctx.setLineDash([6, 5]);
      ell(toScreen(w.x, w.y), VOLLEY_R); ctx.stroke();
      ctx.setLineDash([]); ctx.fillStyle = reach ? ACID : '#ff5a4a'; ctx.font = 'bold 12px system-ui'; ctx.textAlign = 'center';
      const p = toScreen(w.x, w.y);
      ctx.fillText && ctx.fillText(reach ? `${Math.min(5, reach)} spitter${reach === 1 ? '' : 's'}` : 'no spitter in range', p.x, p.y + VOLLEY_R * 16 * S2 * scale + 14);
      ctx.restore();
    }
  }

  // Over the ants: incoming volleys stay readable on top of a fight.
  function drawOver(now) {
    const ab = curr && curr.abil;
    if (ab) for (const v of ab.volleys) drawVolley(v, now);
  }

  root.Abilities = { LIST, trigger, arm, armed: () => armed, onState, drawGround, drawOver, blocked };
})(typeof window !== 'undefined' ? window : globalThis);
