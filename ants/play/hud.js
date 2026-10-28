// HUD extras: army counts, spawn-button cost bars, lobby team slots, end-of-match stats.
// Loaded after client.js and uses its globals ($, curr, mySide, myTeam, COLORS, NAMES, TEAM_NAMES).
// Unit costs and names come from unit-art.js (UnitArt.UNITS, index = snapshot type id).

// Ants per colony from the snapshot tuple [id, colony, type, ...]; cached on the snapshot.
function hudCounts(s) {
  if (s._hudCounts) return s._hudCounts;
  const c = s.players.map(() => ({ ants: 0, byType: [0, 0, 0, 0] }));
  for (const a of s.ants) if (c[a[1]]) { c[a[1]].ants++; c[a[1]].byType[a[2]] = (c[a[1]].byType[a[2]] || 0) + 1; }
  return (s._hudCounts = c);
}
// tip.js: instant tooltip (falls back to the native title where tip.js is not loaded, e.g. in stub tests).
function tipSet(el, t) { if (typeof Tip !== 'undefined') Tip.set(el, t); else el.title = t; }
function hudArmy(s, i) {
  if (s.fog && s.players[i] && s.players[i].food === null) return '<span class="army" data-tip="Fog of war: this colony&#39;s food and army are hidden. Scout to see them.">🌫 hidden</span>'; // ant16 fog
  const c = hudCounts(s)[i];
  const parts = UnitArt.UNITS.map((u, t) => c.byType[t] ? `${c.byType[t]} ${u.name.toLowerCase()}${c.byType[t] === 1 ? '' : 's'}` : '').filter(Boolean);
  const idle = i === mySide && s.players[i] ? s.players[i].idle || 0 : 0; // ant31 ledger: workers with nothing to do (server counts them)
  const idleTxt = idle >= 2 ? ` · <span class="idle" data-tip="Idle workers: ${idle} have no pile to gather and no order. Send them to food, or build with them.">${idle} idle</span>` : '';
  return `<span class="army" data-tip="Ants alive: ${c.ants} (${parts.join(', ') || 'none'}). Fighters win fights, workers carry food.">🐜 ${c.ants}${idleTxt}</span>`;
}

// ant31 ledger: food income for the own colony, the slope of the delivered-food total over the last INCOME_WINDOW seconds.
// hudRate is pure (history [[t, total]], newest last); hudIncome keeps the history and renders the chip text.
const INCOME_WINDOW = 10;
function hudRate(hist, t, total) {
  let old = null;
  for (const h of hist) if (t - h[0] <= INCOME_WINDOW) { old = h; break; }
  if (!old || t - old[0] < 2) return null; // not enough history yet
  return Math.max(0, (total - old[1]) / (t - old[0]));
}
function hudIncome(s, i) {
  if (i !== mySide || !s.stats || !s.stats[i]) return '';
  const h = hudIncome.hist || (hudIncome.hist = []), total = s.stats[i].food;
  if (h.length && s.t < h[h.length - 1][0]) h.length = 0; // a new match
  if (!h.length || s.t - h[h.length - 1][0] >= 0.5) h.push([s.t, total]);
  while (h.length > 2 && s.t - h[0][0] > INCOME_WINDOW + 2) h.shift();
  const r = hudRate(h, s.t, total);
  return r === null ? '' : ` <span class="inc" data-tip="Income: food delivered per second over the last ${INCOME_WINDOW} s, farms included.">▲${r.toFixed(1)}/s</span>`;
}

// ant31 ledger: what took my ants. Causes come from the sim (game.js hurt/noteLoss); 'fight' = no tagged source.
const LOSS_NAMES = { fight: 'fights', quake: 'earthquakes', anteater: 'the anteater', spider: 'spiders', mound: 'acid mounds', volley: 'acid volleys' };
function hudLostTip(st) {
  const by = st && st.lostBy ? Object.keys(st.lostBy).filter(k => st.lostBy[k] > 0) : [];
  if (!by.length) return 'Ants lost';
  return 'Ants lost: ' + by.map(k => `${st.lostBy[k]} to ${LOSS_NAMES[k] || k}`).join(', ');
}
// Toast text for an 'event-loss' log line (only the own colony's lines are shown), or '' for none.
function hudLossText(l) {
  if (!l || l.kind !== 'event-loss' || !l.n) return '';
  const what = Object.keys(l.types || {}).map(t => `${l.types[t]} ${t}${l.types[t] === 1 ? '' : 's'}`).join(', ');
  const who = l.cause === 'quake' ? `Earthquake took ${l.n} of your ants` : l.cause === 'anteater' ? `The anteater ate ${l.n} of your ants` : `${LOSS_NAMES[l.cause] || l.cause} took ${l.n} of your ants`;
  return `${who}${what && l.n > 1 ? ` (${what})` : ''}`;
}
function hudEventLoss(l) {
  if (mySide < 0 || l.colony !== mySide) return;
  const t = hudLossText(l);
  if (t) hudToast(`💀 ${t}`, 5000, '#ff5a4a');
}

// Spawn buttons fill up like a progress bar as food comes in, with a cost tooltip that says why a button is grey.
// Pure: the tooltip for one unit. teched: the colony finished an evolution tier (alates need one).
function hudSpawnTip(u, me, teched) {
  if (!me.alive) return 'Your nest has fallen';
  const pel = u.pellets || 0, have = me.pellets || 0;
  const price = `${u.cost} food${pel ? ` + ${pel} pellet` : ''}`;
  const need = [u.tech && !teched ? 'your first finished evolution (T Y U I O)' : '', me.food < u.cost ? `${u.cost - me.food} more food` : '', have < pel ? `${pel - have} more pellet` : ''].filter(Boolean).join(', ');
  return `${u.name} [${Keys.label(`spawn.${u.id}`)}]: ${price}${need ? `. Greyed: need ${need}` : ''}${u.tip ? `. ${u.tip}` : ''}`;
}
function hudButtons(s) {
  if (mySide < 0) return;
  const me = s.players[mySide];
  const teched = Object.values(me.upgrades || {}).some(l => l > 0);
  for (const u of UnitArt.UNITS) {
    const b = $(`b-${u.id}`), cost = u.cost, pel = u.pellets || 0, have = me.pellets || 0;
    const pct = me.alive ? Math.min(100, Math.round(me.food / cost * 100), pel ? Math.round(have / pel * 100) : 100) : 0;
    b.style.setProperty('--fill', pct + '%');
    b.classList.add('cost-btn');
    b.classList.toggle('locked', !!(u.tech && !teched)); // 🔒 on the label (index.html css)
    tipSet(b, hudSpawnTip(u, me, teched));
  }
}

// One toast column for every announcement (evolutions, farms, spiders, the clock, research), so they stack
// instead of covering each other. Research.js, objectives.js and client.js call hudToast(html, ms, borderColor).
function hudToast(html, ms = 4000, border) {
  let col = $('toasts');
  if (!col) {
    col = document.createElement('div'); col.id = 'toasts';
    col.style.cssText = 'position:fixed;top:136px;left:50%;transform:translateX(-50%);display:flex;flex-direction:column;gap:4px;align-items:center;z-index:6;pointer-events:none;max-width:calc(100vw - 32px)';
    document.body.appendChild(col);
  }
  const t = document.createElement('div');
  t.className = 'toast'; if (border) t.style.setProperty('--b', border); // look: theme.css
  t.style.cssText += ';padding:6px 14px;font-size:13px;transition:opacity .6s;text-align:center';
  t.innerHTML = html;
  col.appendChild(t);
  while (col.children.length > 4) col.firstChild.remove();
  setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 700); }, ms);
  return t;
}

// Lobby: one colored slot per colony, grouped by team, showing who has joined and which one is you.
function hudSlots(m) {
  const html = [0, 1].map(team => {
    // ant18/flow: an open or bot seat is a button for a seated player: click to move there (that is how you change team).
    const slots = m.players.map((joined, i) => i % 2 !== team ? '' :
      `<div class="slot${joined ? ' on' : ' open'}${m.bots && m.bots[i] ? ' bot' : ''}${i === mySide ? ' you' : ''}" style="--c:${COLORS[i]}"${mySide >= 0 && i !== mySide && (!joined || (m.bots && m.bots[i])) ? ` data-seat="${i}" data-tip="Move here: Take this seat. Seats alternate teams, so this is how you change teams."` : ''}>
        <span class="dot"></span>${NAMES[i]}<em>${i === mySide ? 'You' : m.bots && m.bots[i] ? '🤖 Bot' : joined ? 'Joined' : mySide >= 0 ? 'Sit here' : 'Open'}</em></div>`).join('');
    return `<div class="team"><div class="team-name" style="color:${COLORS[team]}">${TEAM_NAMES[team]}</div>${slots}</div>`;
  }).join('<div class="vs">vs</div>');
  const spec = m.spectators ? `<div class="spec">👀 ${m.spectators} watching</div>` : '';
  for (const id of ['slots', 'end-slots']) $(id).innerHTML = `<div class="slot-row">${html}</div>${spec}`;
}

// End screen: per-colony stats table.
function hudEndStats() {
  const s = curr;
  $('end-slots').classList.add('hidden');
  if (!s || !s.stats) { $('end-stats').classList.add('hidden'); return; }
  const min = Math.floor(s.t / 60), sec = String(Math.floor(s.t % 60)).padStart(2, '0');
  const rows = s.players.map((p, i) => {
    const st = s.stats[i] || {};
    return `<tr class="${p.alive ? '' : 'dead'}"><td style="color:${COLORS[i]}">${NAMES[i]}${i === mySide ? ' (you)' : ''}</td>
      <td>${st.spawned ?? 0}</td><td data-tip="${hudLostTip(st)}">${st.lost ?? 0}</td><td>${st.food ?? 0}</td><td>${st.nestDmg ?? 0}</td></tr>`;
  }).join('');
  $('end-stats').innerHTML = `<table><thead><tr><th>Colony</th><th data-tip="Ants spawned">Spawned</th><th data-tip="Ants lost">Lost</th>
    <th data-tip="Food gathered">Food</th><th data-tip="Damage dealt to enemy nests">Nest dmg</th></tr></thead><tbody>${rows}</tbody></table>
    <div class="match-time">Match length ${min}:${sec}</div>`;
  $('end-stats').classList.remove('hidden');
}

// Opponent left: show the stats so far plus the room's slots while waiting for a replacement.
function hudOpponentLeft() {
  hudEndStats();
  $('end-title').textContent = '🚪 A player left';
  $('end-sub').textContent = `The match was stopped. Share the room link: it starts again as soon as the room is full.`;
  $('end-slots').classList.remove('hidden');
}

$('leave').onclick = () => {
  if (typeof mySide !== 'undefined' && mySide < 0) { location.href = location.pathname; return; } // a watcher has no seat to bring back
  if (!$('leave').dataset.sent) { $('leave').dataset.sent = '1'; send({ type: 'to-lobby' }); setTimeout(() => { delete $('leave').dataset.sent; }, 1500); } };

// Bottom HUD stacking. The spawn bar, upgrade bar and selection readout used fixed bottom offsets that
// assumed a one-line spawn bar, and the pings bar sat bottom-left regardless of width, so on phones and
// small windows they covered each other. Stack them from their real heights, and lift the pings bar above
// the stack whenever it would overlap the centred bars.
function hudLayout() {
  const shown = e => e && !e.classList.contains('hidden') && getComputedStyle(e).display !== 'none';
  const bottom = $('hud-bottom'), upg = $('hud-upgrades'), bld = $('hud-build'), ro = $('sel-readout'), pg = $('pg-bar');
  let y = 12;
  if (shown(bottom)) y += bottom.offsetHeight + 8;
  // ant16: the evolution bar and the build bar share one row, centred as a pair, when the row fits beside
  // the side panels (abilities bottom-left, selection panel and minimap bottom-right); else they stack.
  const pair = shown(upg) && shown(bld) && upg.offsetWidth + bld.offsetWidth + 10 <= innerWidth - 2 * 300;
  if (upg) upg.style.left = pair ? `calc(50% - ${(bld.offsetWidth + 10) / 2}px)` : '50%';
  if (bld) bld.style.left = pair ? `calc(50% + ${(upg.offsetWidth + 10) / 2}px)` : '50%';
  if (upg) { upg.style.bottom = y + 'px'; if (shown(upg) && !pair) y += upg.offsetHeight + 8; }
  if (bld) { bld.style.bottom = y + 'px'; if (shown(bld)) y += bld.offsetHeight + 8; } // ant16 structures.js
  if (pair) y = Math.max(y, parseFloat(upg.style.bottom) + upg.offsetHeight + 8);
  if (ro) { ro.style.bottom = y + 'px'; if (shown(ro)) y += ro.offsetHeight + 8; }
  // Keep the board clear of the whole stack: client.js resize() reads hudLayout.bottom.
  const stack = Math.round(y - (shown(ro) ? ro.offsetHeight + 8 : 0)) + 8;
  if (Math.abs(stack - (hudLayout.bottom || 0)) > 6) { hudLayout.bottom = stack; if (typeof resize === 'function') resize(); }
  if (!pg) return;
  pg.style.bottom = '12px';
  if (!shown(pg)) return;
  const hits = () => {
    const r = pg.getBoundingClientRect();
    return [bottom, upg, bld].some(e => { if (!shown(e)) return false; const q = e.getBoundingClientRect(); return r.right > q.left && r.left < q.right && r.bottom > q.top && r.top < q.bottom; });
  };
  // First drop the quick-chat buttons (pings.js already hides them under 720px), then lift what's left.
  for (const b of pg.querySelectorAll('.chat')) b.style.display = '';
  if (!hits()) return;
  for (const b of pg.querySelectorAll('.chat')) b.style.display = 'none';
  if (hits()) pg.style.bottom = y + 'px';
}
addEventListener('resize', hudLayout);
setInterval(() => { const pf0 = window.Perf && Perf.t0(); hudLayout(); if (pf0) Perf.add('panel', pf0); }, 300);
