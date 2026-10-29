// Ant Arena client: lobby, input, the isometric projection and the frame loop (drawing lives in render.js).
const $ = id => document.getElementById(id);
const canvas = $('c');
const ctx = canvas.getContext('2d');
// Colony i plays for team i % 2: Red + Orange vs Blue + Purple.
const COLORS = ['#e0483e', '#3b7be0', '#f08a24', '#9a5ad8'];
const DARK = ['#6e1c16', '#163a73', '#7a3f08', '#47236e'];
// ant18 unit-look: rim/legs-cap tint and glow tint (eyes, tech-mark) per colony; see docs/art-overhaul.md section 5.
const LIGHT = ['#ff9a8a', '#8fc0ff', '#ffc07a', '#c9a0ff'];
const GLOW = ['#ffd2c8', '#cfe6ff', '#ffe2bd', '#e8d6ff'];
const NAMES = ['Red', 'Blue', 'Orange', 'Purple'];
const TEAM_NAMES = ['Red team', 'Blue team'];
const TICK_MS = 1000 / 15;

let ws, mySide = -1, myTeam = -1, roomCode = '', roomMode = '1v1';
let prev = null, curr = null, currAt = 0;
let banner = null; // { roll, name, desc, shownAt }
let bots = []; // per colony: null for humans, or the bot difficulty ('easy' | 'normal' | 'hard')

// ---------- Lobby ----------
const params = new URLSearchParams(location.search);
$('room').value = params.get('room') || Math.random().toString(36).slice(2, 6).toUpperCase();
$('join1').onclick = () => join('1v1');
$('join2').onclick = () => join('2v2');
$('room').onkeydown = e => { if (e.key === 'Enter') join(params.get('mode') || '1v1'); };
// navigator.clipboard only exists on https/localhost, so friends on a LAN link (http://192.168...) got
// "Copied!" with nothing copied, and a refused write was an unhandled rejection. Fall back to select + copy.
$('copy').onclick = () => {
  const box = $('share'), btn = $('copy');
  const done = ok => { btn.textContent = ok ? 'Copied!' : 'Press Ctrl+C'; clearTimeout(btn.t); btn.t = setTimeout(() => { btn.textContent = 'Copy'; }, 2000); };
  const fallback = () => { box.focus(); box.select(); let ok = false; try { ok = document.execCommand('copy'); } catch {} done(ok); };
  if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(box.value).then(() => done(true), fallback);
  else fallback();
};
// Auto-join from a share link runs at the end of this file, once everything it touches is declared.

// The room's creator picks the mode; anyone joining later gets the room's mode from the server.
function join(mode) {
  roomCode = $('room').value.trim().toUpperCase() || 'LOBBY';
  roomMode = mode;
  setUrl();
  $('join-form').classList.add('hidden');
  $('waiting').classList.remove('hidden');
  $('wait-msg').textContent = `Joining room ${roomCode}…`;
  connect(mode); // after the card swap: connect() may send a static copy straight back to the home screen
}

// ---------- Connection: auto-reconnect with backoff, rejoin our colony with a per-tab token ----------
let netTries = 0, netLastMsg = 0, netTimer = null, netGaveUp = false;
const tokenKey = () => `ant-token:${roomCode}`;
const getToken = () => { try { return sessionStorage.getItem(tokenKey()) || undefined; } catch { return undefined; } };

// OneLobby (net/onelobby.mjs): a page served from the host's OneLobby port (the link friends get) joins that
// host, location.host; ?dc=CODE joins a host by join code from any copy of the game. Otherwise the page talks
// to the server it came from over a WebSocket. Both hand attach() the same WebSocket-shaped socket.
const oneLobby = document.querySelector('meta[name="onelobby"]')?.content === 'here' ? location.host : params.get('dc');
let dialing = 0, netMod = null; // netMod: net/onelobby.mjs, for is(code, name) against OneLobby.ErrorCodes
// Browser host (host.js): this tab runs the game server itself, so the page plays over an in-memory socket instead of a
// WebSocket or a OneLobby join. { socket(): Promise of a WebSocket-shaped socket, code, shareLink(room, mode) }; null otherwise.
let localHost = null;
// A static copy of the game (server.js fills the node-server meta with 1; a static host leaves it empty) has no game
// server behind its own address, so it must never dial it: it joins by ?dc= code or hosts from the tab (host.js).
const staticCopy = !document.querySelector('meta[name="node-server"]')?.content;
const NO_CODE = 'This link has no join code. Ask the host for the full link, or host your own game.';

function connect(mode) {
  clearTimeout(netTimer);
  if (localHost) {
    const n = ++dialing;
    localHost.socket().then(
      sock => { if (n === dialing && !netGaveUp) attach(sock, mode); else sock.close(); },
      e => { if (n === dialing) { console.warn('Local host failed:', e); netRetry(mode); } });
    return;
  }
  if (!oneLobby && staticCopy) { // nothing to dial: back to the home screen with a plain message, no retry loop
    $('waiting').classList.add('hidden'); $('join-form').classList.remove('hidden');
    netNotice(NO_CODE, 10000);
    return;
  }
  if (!oneLobby) { attach(new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`), mode); return; }
  const n = ++dialing;
  import('./net/onelobby.js').then(m => { netMod = m; return m.dial(oneLobby); }).then(
    sock => { if (n === dialing && !netGaveUp) attach(sock, mode); else sock.close(); },
    err => { if (n === dialing) { console.warn('OneLobby join failed:', err);
      const stop = netMod && netMod.joinStopNotice(err && err.code); // full room, bad code: retrying cannot help
      if (stop) { $('waiting').classList.add('hidden'); $('join-form').classList.remove('hidden'); netNotice(stop, 12000); return; }
      netUnreachable(err); netRetry(mode); } });
}

let codec = null; // this connection's state decoder context (StateCodec.createRecvCtx)
const VERSION_NOTICE = 'You and the host are running different versions of the game. Reload the page and try again.'; // same words as onelobby.mjs's VersionMismatch

function attach(sock, mode) {
  ws = sock;
  codec = StateCodec.createRecvCtx();
  try { sock.binaryType = 'arraybuffer'; } catch {} // a real WebSocket delivers state as binary frames
  sock.onopen = () => { // OneLobby runs it even when the link opened before we got here
    netLastMsg = performance.now();
    sock.send(JSON.stringify({ type: 'join', room: roomCode, mode, token: getToken(), nv: StateCodec.NET_VERSION })); // nv: server.js refuses a page with another wire version
  };
  sock.onmessage = e => {
    if (sock !== ws) return;
    netLastMsg = performance.now();
    const pf0 = window.Perf && Perf.t0();
    const m = StateCodec.parse(e.data, codec); // public/codec.js: JSON text or a state message; null = a state we cannot use
    if (pf0) { Perf.ev('decode', performance.now() - pf0); Perf.bytes(e.data && (e.data.byteLength || e.data.length) || 0); }
    const ack = StateCodec.ackFor(codec); // every 2nd applied state, or "send me a keyframe" after one we could not use
    if (ack) { try { (sock.sendFast || sock.send).call(sock, ack); } catch {} }
    if (!m) return;
    const pf1 = window.Perf && Perf.t0();
    netOnMessage(m); onMessage(m);
    if (pf1) Perf.ev('apply', performance.now() - pf1);
  };
  sock.onclose = e => {
    if (sock !== ws) return;
    e.code === 4000 ? netStop('This colony was opened in another tab.') : e.code === 4001 ? netStop(VERSION_NOTICE) : netRetry(mode);
  };
}

// Why a join by code can fail, said plainly (netRetry would otherwise only show "reconnecting"). ice_failed: no WebRTC
// route to the host (a browser host cannot open a router port, so two strict NATs cannot meet).
let netWhy = '';
function netUnreachable(e) {
  const code = e && e.code;
  const is = n => !!netMod && netMod.is(code, n);
  netWhy = is('IceFailed') ? "Could not connect to the host's game: your networks block a direct link. Ask the host to run the downloadable Node host (it opens a router port)."
    : is('DirectUnreachable') ? 'Could not reach the Nostr relays. Check your connection.'
    : is('UnknownCode') || is('BadCode') ? "That join code doesn't match a running game. The host may have closed their tab." : '';
}

function netRetry(mode) {
  if (netGaveUp) return;
  const old = ws; ws = null;
  if (old) { old.onclose = old.onmessage = null; try { old.close(); } catch {} }
  const delay = Math.min(5000, 500 * 2 ** netTries++) * (0.75 + Math.random() * 0.5);
  netNotice(netWhy ? `${netWhy} · retrying… (try ${netTries})` : `Connection lost · reconnecting… (try ${netTries})`);
  netWhy = '';
  netTimer = setTimeout(() => connect(mode), delay);
}

function netStop(text) { netGaveUp = true; netNotice(text); }

function netNotice(text, fadeMs) {
  const el = $('net-notice');
  if (!el) return;
  clearTimeout(netNotice.t);
  el.textContent = text || '';
  el.classList.toggle('hidden', !text);
  if (text && fadeMs) netNotice.t = setTimeout(() => el.classList.add('hidden'), fadeMs);
}

function netOnMessage(m) {
  if (m.type === 'version-mismatch') { netStop(VERSION_NOTICE); return; } // server.js is about to close with 4001; no retry loop
  if (m.type === 'joined') {
    try { if (m.token) sessionStorage.setItem(`ant-token:${m.room}`, m.token); } catch {}
    if (netTries) netNotice(m.resumed ? 'Reconnected · back in control of your colony' : curr ? 'Reconnected · that match is gone, back in the room' : 'Reconnected', 4000);
    netTries = 0;
  } else if (m.type === 'start' && m.resume && m.winner !== null && m.winner !== undefined) {
    setTimeout(() => showEnd(m.winner), 300); // the match ended while we were away
  } else if (m.type === 'player-away') {
    const left = Math.round(m.graceMs / 1000);
    netNotice(`${m.side === mySide ? 'You' : NAMES[m.side]} disconnected · holding their colony for ${left}s…`);
  } else if (m.type === 'player-back') {
    if (m.side !== mySide) netNotice(`${NAMES[m.side]} reconnected`, 3000);
  } else if (m.type === 'opponent-left') netNotice('');
}

// Leaving the page ("New room", a link, closing the tab) must drop our seat. Without this the browser's
// back/forward cache kept the socket open, so after "New room" the old colony stayed connected and the
// other players never heard that we left (their Rematch waited forever). Coming back via Back restores
// a frozen page, so reload it; the reconnect token puts us back in our colony if the match is still on.
addEventListener('pagehide', () => {
  netGaveUp = true; clearTimeout(netTimer);
  if (ws) { try { ws.close(1000, 'left'); } catch {} }
});
addEventListener('pageshow', e => { if (e.persisted) location.reload(); });

// The WebSocket server sends a heartbeat every few seconds; silence means the tunnel died without closing.
// OneLobby does this itself (peerTimeoutMs in net/onelobby.mjs) and closes the socket with 1006.
setInterval(() => { if (!oneLobby && !localHost && ws && ws.readyState === 1 && performance.now() - netLastMsg > 12000) netRetry(roomMode); }, 2000);

function setUrl() {
  if (localHost) { $('share').value = localHost.code ? localHost.shareLink(roomCode, roomMode) : ''; return; } // reloading a host tab cannot rejoin: no ?room= in its URL
  const dc = params.get('dc');
  history.replaceState(null, '', `?room=${roomCode}&mode=${roomMode}${dc ? `&dc=${encodeURIComponent(dc)}` : ''}`);
  // A host's own tab is often http://localhost:3000 or a LAN address, which no friend can open; the server puts
  // the OneLobby link (the host's public or network address) in the share-base meta, so the link we hand out
  // works for them. With a Nostr join code (onelobby-code meta) the link goes through the game site instead: it
  // needs no open port at all. A ?dc= page joins someone else's host, so it keeps its own (already shared) address.
  const meta = n => !dc && document.querySelector(`meta[name="${n}"]`)?.content;
  const base = meta('share-base'), code = meta('onelobby-code'), q = `room=${roomCode}&mode=${roomMode}`;
  $('share').value = code ? `https://dreaddybear.com/ants/play/?dc=${encodeURIComponent(code)}&${q}` : base ? `${base.replace(/\/?$/, '/')}?${q}` : location.href;
}

function onMessage(m) {
  if (m.bots) bots = m.bots;
  if (window.Flow) Flow.onMessage(m, mySide); // ant18 flow.js: size slider, tutorial bot fill
  if (window.Solo) Solo.onMessage(m, mySide); // ant59 solo.js: bot fill on the first lobby card, pause while hidden
  if (window.Pings && Pings.onMessage(m)) return; // team pings & quick chat (pings.js)
  if (m.type === 'joined') {
    mySide = m.side; myTeam = m.side < 0 ? -1 : m.side % 2; roomCode = m.room; roomMode = m.mode;
    setUrl();
    if (m.seated) netNotice(`🪑 A seat opened · you are ${NAMES[mySide]}`, 6000);
    // We reconnected but the server no longer has our match (it restarted, or our seat's hold ran out).
    // Without this the last frame stayed up, frozen, with no way out. Back to the waiting card; if the
    // room is mid-match we join as a spectator and the 'start' that follows hides it again.
    // A seat swap on the end screen (m.moved) is not a lost match: the end card stays, or the host would land on
    // a lobby card while the server still holds the finished game (fill and Start refused).
    if (!m.resumed && !m.moved && curr) {
      prev = curr = null; banner = null;
      if (window.Sound) Sound.setScene('lobby');
      for (const id of ['hud-top', 'hud-bottom', 'spec-bar', 'end', 'banner', 'join-form', 'pg-bar']) $(id)?.classList.add('hidden'); // pg-bar: pings.js
      for (const id of ['lobby', 'waiting']) $(id).classList.remove('hidden');
      $('waiting').appendChild($('bot-fill')); // it may have moved to the 'A player left' card
    }
  }
  else if (m.type === 'start') {
    // A watcher taking a leaver's seat restarts the match at once: without a word the board just reset.
    if (curr && !m.resume && mySide >= 0) netNotice(onMessage.left ? '🔁 New match · a player left and someone watching took their seat' : '🔁 New match', 6000);
    onMessage.left = false;
    prev = curr = null; banner = null; NetBuf.reset(); fxSnap = null; rallyAt = null;
    if (window.Camera) Camera.reset(true); // every match starts on the whole-board view
    if (window.Sound) Sound.setScene('calm');
    for (const id of ['lobby', 'end']) $(id).classList.add('hidden');
    for (const id of ['hud-top', 'hud-bottom']) $(id).classList.toggle('hidden', id === 'hud-bottom' && mySide < 0);
    $('hud-top').classList.remove('hidden');
    // Someone opening a full room's link landed on a board with no buttons and no explanation, and a notice
    // that faded after 6 s left them guessing again. The bar stays where the buttons would be.
    $('spec-bar').classList.toggle('hidden', mySide >= 0);
    if (mySide < 0) $('spec-bar').innerHTML = `👀 <b>You're watching.</b> Room ${roomCode} (${roomMode}) is full.<small>You get the next free seat when this match stops.</small>`;
    $('waiting').appendChild($('bot-fill'));
  } else if (m.type === 'state') {
    prev = curr; curr = m.state; currAt = performance.now();
    NetBuf.push(curr, currAt); // netbuf.js: jitter buffer the renderer draws from
    if (window.UnitArt) UnitArt.onSnapshot(curr, currAt); // acid globs
    if (window.Objectives) Objectives.onState(curr); // ant16 objectives.js: farm/spider toasts, match clock
    for (const l of curr.log) {
      if (l.kind === 'event') banner = { ...l, shownAt: performance.now() };
      if (l.kind === 'win') showEnd(l.team, l.reason);
      if (l.kind === 'event-loss') hudEventLoss(l); // ant31 ledger: "Earthquake took 4 of your ants"
      if (l.kind === 'hatch') hatchPops.push({ x: l.x, y: l.y, at: performance.now(), colony: l.colony }); // ant62: "+1" over the outpost that hatched an ant
    }
    const pfh = window.Perf && Perf.t0();
    updateHud();
    if (pfh) Perf.add('hud', pfh);
    if (window.Flow) Flow.onState(curr, mySide); // ant18: pacing toasts, tutorial steps
    if (window.Sound) Sound.onState(prev, curr, mySide);
    if (window.Alerts) Alerts.onState(prev, curr, mySide); // alerts.js: own ants hurt off-screen
    if (window.Abilities) Abilities.onState(curr); // ant16: abilities.js
  } else if (m.type === 'opponent-left') {
    onMessage.left = true;
    $('end').classList.remove('hidden');
    $('end-title').textContent = 'A player left';
    $('end-sub').textContent = 'Waiting for someone new to join this room…';
    hudOpponentLeft();
    // The room creator can refill the empty seat with a bot instead of waiting (the next 'lobby'
    // message decides whether the row shows); 'start' puts the row back in the waiting card.
    $('end').querySelector('.end-actions').before($('bot-fill'));
  } else if (m.type === 'lobby') {
    hudSlots(m);
    const n = m.players.filter(Boolean).length;
    const who = mySide < 0 ? ' You are watching: you get the next free seat.' : m.mode === '1v1' ? ` You are ${NAMES[mySide]}.` : ` You are ${NAMES[mySide]} (${TEAM_NAMES[myTeam]}).`;
    $('watchers').textContent = `👀 ${m.spectators} watching`;
    $('watchers').classList.toggle('hidden', !m.spectators);
    $('wait-msg').textContent = `Room ${roomCode} · ${m.mode} · ${n}/${m.players.length} players joined.${who} Send friends the link:`;
    $('start-row').classList.toggle('hidden', !(m.hold && mySide >= 0 && mySide === (m.host ?? 0) && m.players.every(Boolean))); // after a match the host starts the next one
    $('bot-fill').classList.toggle('hidden', mySide < 0 || mySide !== (m.host ?? 0) || m.players.every(Boolean));
  } else if (m.type === 'lobby-return') {
    // Someone chose Back to lobby on the end screen: everyone returns to the waiting card with their seats, to swap
    // teams or change the rules before the host starts the next match.
    prev = curr = null; banner = null; NetBuf.reset(); fxSnap = null; rallyAt = null;
    if (window.Sound) Sound.setScene('lobby');
    for (const id of ['hud-top', 'hud-bottom', 'spec-bar', 'end', 'banner', 'join-form', 'pg-bar']) $(id)?.classList.add('hidden');
    for (const id of ['lobby', 'waiting']) $(id).classList.remove('hidden');
    $('end-summary')?.classList.add('hidden');
    $('waiting').appendChild($('bot-fill'));
  }
}

function showEnd(team, reason) {
  $('end').classList.remove('hidden');
  const solo = curr && curr.mode === '1v1';
  const winners = solo ? `${NAMES[team]} colony` : TEAM_NAMES[team];
  $('end-title').textContent = myTeam < 0 ? `${winners} wins!` : team === myTeam ? 'Victory! 🐜👑' : solo ? 'Your nest has fallen' : 'Your team has fallen';
  $('end-sub').textContent = `${winners} ${reason || 'destroyed every enemy nest'}.`; // reason: ant16 match clock
  hudEndStats();
  if (window.Flow) Flow.onEnd(curr, mySide, myTeam); // ant18: stat summary
  if (window.Solo) Solo.onEnd(); // ant59: Play again / Main menu
}
$('fill-bots').onclick = () => send({ type: 'fill-bots', difficulty: $('bot-diff').value });
$('start-match').onclick = () => send({ type: 'start' });

// ---------- Input ----------
function send(m) { if (window.Flow) Flow.onSend(m); if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); }
// One spawn button and hotkey per unit type (unit-art.js): Z worker, X soldier, C spitter, V major, N nurse, B alate.
const UNITS = window.UnitArt.UNITS;
// Hatch from the selected producer (the nest, or a finished outpost: input.js Orders.spawnFrom); no building selected = the nest.
const spawnMsg = unit => ({ type: 'spawn', unit, ...(window.Orders && Orders.spawnFrom ? Orders.spawnFrom() : null) });
for (const u of UNITS) $(`b-${u.id}`).onclick = () => send(spawnMsg(u.id));
addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') return;
  const u = UNITS.find(u => Keys.is(e, 'spawn.' + u.id)); // Keys: ctrl / alt / Cmd must be up
  if (u) send(spawnMsg(u.id));
});
// Canvas clicks (building and unit selection, rally flags and orders) are handled in input.js.

function updateHud() {
  const s = curr;
  // One food chip per colony, grouped by team; your own chip is underlined, dead nests struck out.
  for (const team of [0, 1]) {
    $(`team${team}`).innerHTML = s.players.map((p, i) => p.team !== team ? '' :
      `<span class="chip${i === mySide ? ' me' : ''}${p.alive ? '' : ' dead'}" style="color:${COLORS[i]}" data-tip="${NAMES[i]}${i === mySide ? ' (you)' : ''}: ${p.alive ? 'A colony. Food is spent on ants, evolutions and buildings; the nest must survive.' : 'Nest fallen. This colony is out.'}"><span class="nm">${NAMES[i]}</span> ${p.food === null ? '' : `<span data-tip="Food in the nest: Workers deliver it. Spend it on ants, evolutions and buildings.">🍃 ${p.food}</span>${hudIncome(s, i)} `}${hudArmy(s, i)}</span>`).join('');
  }
  // Mark bot colonies: team t's chips are colonies t, t+2, so colony i is chip i >> 1 of team i % 2.
  bots.forEach((b, i) => { const el = b && $(`team${i % 2}`).children[i >> 1]; if (el) { el.prepend('🤖'); el.dataset.tip = el.dataset.tip.replace(': ', ` (${b} bot): `); } });
  $('clock').textContent = s.warn ? `⚠ ${s.warn.name} in ${s.warn.in}s` : s.event ? `${s.event.name} · ${s.event.left}s` : `🎲 in ${s.nextEventIn}s`;
  if (mySide >= 0) {
    const me = s.players[mySide];
    const teched = Object.values(me.upgrades || {}).some(l => l > 0); // ant16: alates need a finished evolution tier (upgrades = finished tiers)
    for (const u of UNITS) $(`b-${u.id}`).disabled = !me.alive || me.food < u.cost || (me.pellets || 0) < (u.pellets || 0) || (u.tech && !teched);
    // Only claim a teammate fights on when one really does (never in 1v1, never after the match ended).
    const mateUp = s.winner === null && s.players.some((p, i) => i !== mySide && p.alive && p.team === me.team);
    $('hud-bottom').querySelector('.hint').textContent = me.alive ? 'Press E, then click ground (fighters) or food (workers) to plant the rally flag' : mateUp ? 'Your nest fell. Your teammate fights on!' : 'Your nest fell.';
  }
  hudButtons(s);
}

// ---------- Isometric projection ----------
const TW = 64, TH = 32;
let scale = 1, ox = 0, oy = 0, sizedFor = 0;
// Flip the board for team 0 so each player's own nests sit at the bottom of their screen.
const flip = () => myTeam === 0;

function toScreen(x, y) {
  if (flip() && curr) { x = curr.map - x; y = curr.map - y; }
  return { x: ox + (x - y) * TW / 2 * scale, y: oy + (x + y) * TH / 2 * scale };
}
function screenToWorld(sx, sy) {
  const a = (sx - ox) / (TW / 2 * scale), b = (sy - oy) / (TH / 2 * scale);
  let x = (a + b) / 2, y = (b - a) / 2;
  if (flip()) { x = curr.map - x; y = curr.map - y; }
  return { x, y };
}
// World heading -> screen-space angle.
function screenAngle(dir) {
  let c = Math.cos(dir), s = Math.sin(dir);
  if (flip()) { c = -c; s = -s; }
  return Math.atan2((c + s) * TH / 2, (c - s) * TW / 2);
}

// Backing-store pixels per CSS pixel, capped at 2: a 3x phone would pay 2.25x the fill for little visible gain.
// ant68: renderScale is the adaptive-quality factor (1 = full). A big screen with a slow raster path (4K-class backing store, Firefox without a
// fast canvas path) is fill-rate bound: every full-screen layer (ground, decals, fog, wash, sprites) costs per backing pixel. adaptScale() below
// steps the factor down when frames run long and never back up in the same match, so a slow machine trades sharpness for speed, not the sim.
let renderScale = 1;
const pixelRatio = () => Math.min(2, devicePixelRatio || 1) * renderScale;
// Rounded, so frame()'s size check matches what the canvas actually holds (at 125% zoom innerWidth * dpr is often
// fractional; canvas.width truncates it, and the old check then reallocated the canvas every single frame).
const canvasSize = () => [Math.round(innerWidth * pixelRatio()), Math.round(innerHeight * pixelRatio())];

function resize() {
  const dpr = pixelRatio();
  [canvas.width, canvas.height] = canvasSize();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const map = sizedFor = curr ? curr.map : 24;
  // Keep the board clear of the top HUD (~56px) and the bottom button bar (~80px), with room for nest flags.
  const top = 90, bottom = Math.max(100, (window.hudLayout && hudLayout.bottom) || 0); // hud.js: the real bottom stack height (ant16 bars)
  scale = Math.max(0.05, Math.min(innerWidth / (map * TW) * 0.96, (innerHeight - top - bottom) / (map * TH))); // never negative on tiny windows
  ox = innerWidth / 2;
  oy = top + (innerHeight - top - bottom - map * TH * scale) / 2;
  if (window.Camera) { Camera.layout(map, innerWidth, innerHeight, top, bottom); ({ scale, ox, oy } = Camera.params()); } // camera.js: pan/zoom
}
addEventListener('resize', resize);

// Deterministic per-tile noise so the ground looks the same for both players.
function hash(x, y, seed) {
  let h = (x * 374761393 + y * 668265263 + seed) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function drawAnteater(e, now) { // creature-art.js: cached sprite, always on the move
  const c = toScreen(e.x, e.y);
  CreatureArt.draw(ctx, 'anteater', c, scale, { face: Math.cos(screenAngle(e.dir)) < 0 ? -1 : 1, pose: CreatureArt.poseFor('anteater', now, { moving: true }) });
  // ant26: hp bar like the beetle's, in the ui-world style. Shown only when the snapshot carries `hp` (0..100); the sim does not
  // send one yet (the anteater cannot be hurt), so today this draws nothing and starts working the moment game.js adds the field.
  if (typeof e.hp === 'number') CreatureArt.bar(ctx, c, scale, 72, 56, e.hp / 100, '#d9a441');
}

// A rally flag at p.rally; `from` (a world point, the building it belongs to) adds the line to it.
function drawRally(p, side, from) {
  const c = toScreen(p.rally.x, p.rally.y), k = scale;
  if (from && window.UIWorld) UIWorld.flagLine(ctx, toScreen(from.x, from.y), c, k, COLORS[side]);
  if (window.UIWorld) { UIWorld.rally(ctx, c, k, COLORS[side], performance.now()); return; } // ant19/ui-world
  if (from) { const f = toScreen(from.x, from.y); ctx.strokeStyle = COLORS[side]; ctx.globalAlpha = 0.5; ctx.beginPath(); ctx.moveTo(f.x, f.y); ctx.lineTo(c.x, c.y); ctx.stroke(); ctx.globalAlpha = 1; }
  ctx.strokeStyle = COLORS[side]; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.ellipse(c.x, c.y, 14 * k, 7 * k, 0, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(c.x, c.y); ctx.lineTo(c.x, c.y - 26 * k); ctx.stroke();
  ctx.fillStyle = COLORS[side];
  ctx.beginPath(); ctx.moveTo(c.x, c.y - 26 * k); ctx.lineTo(c.x + 14 * k, c.y - 21 * k); ctx.lineTo(c.x, c.y - 16 * k); ctx.fill();
  ctx.lineWidth = 1;
}

// The interpolated world at local time `now` (netbuf.js): ants, anteater, beetle, nest hp, drawn a
// little in the past from a jitter buffer. Cached per frame; input.js reads it through lerpAnts().
let netView = null, netViewAt = -1, fxSnap = null, rallyAt = null, rallyNow = 0;
function view(now) {
  if (now !== netViewAt || !netView) { netView = NetBuf.sample(now); netViewAt = now; }
  return netView || { ants: curr.ants, anteater: curr.anteater, beetle: curr.beetle, players: curr.players, to: curr };
}
function lerpAnts(now) { return view(now).ants; }

// The nest's rally flag glides to a new spot instead of popping there (Flag Swap).
function rallyPoint(p, now) {
  rallyAt = NetBuf.glide(rallyAt, p.rally, now - rallyNow); rallyNow = now;
  return { ...p, rally: rallyAt };
}

// The selected producer's flags, and ONLY while it is selected: its fighter rally (colony-coloured pennant) and its worker
// forage target (green), each with a line back to the building. Nothing is drawn with no building selected.
function drawBuildingFlags(now) {
  const B = window.Orders && Orders.building ? Orders.building() : null;
  if (B && window.UIWorld) { const c = toScreen(B.x, B.y); UIWorld.rings(ctx, [{ x: c.x, y: c.y + 2 * scale, k: scale * (B.kind === 'nest' ? 3.4 : 2.5) }], { now, noTicks: true }); } // selection ring under any selected building
  const armed = window.Orders && Orders.mode && Orders.mode() === 'rally' && mySide >= 0 && curr.players[mySide].alive; // E armed the colony rally: show the flags with nothing selected
  if (!armed && (!B || !B.producer || mySide < 0 || !curr.players[mySide].alive)) { rallyAt = null; return; }
  const me = curr.players[mySide], W = (curr.wrally && curr.wrally[mySide]) || null;
  const bld = B && B.producer ? B : { kind: 'nest', x: me.nest.x, y: me.nest.y, rally: me.rally, forage: W };
  drawColonyFlags(bld, now);
}
function drawColonyFlags(B, now) {
  const from = { x: B.x, y: B.y };
  if (B.forage) {
    const c = toScreen(B.forage.x, B.forage.y);
    if (window.UIWorld) { UIWorld.flagLine(ctx, toScreen(from.x, from.y), c, scale, '#a8e05e'); UIWorld.forage(ctx, c, scale, now); }
  }
  if (B.rally) drawRally(B.kind === 'nest' ? rallyPoint({ rally: B.rally }, now) : { rally: B.rally }, mySide, from);
}

// Runs every frame, so it only touches the DOM when something changed (no per-frame style/layout work).
const setText = (id, v) => { const el = $(id); v = String(v); if (el.textContent !== v) el.textContent = v; };
function drawBanner(now) {
  if (banner && now - banner.shownAt > 4500) banner = null;
  if ($('banner').classList.contains('hidden') !== !banner) $('banner').classList.toggle('hidden', !banner);
  if (!banner) return;
  const rolling = now - banner.shownAt < 900;
  if (!rolling || !(now - drawBanner.at < 70)) { drawBanner.at = now; setText('die', rolling && !(window.Settings && Settings.reduced()) ? 1 + Math.floor(Math.random() * DIE_FACES) : banner.roll); } // tumbles ~14 faces/s
  setText('ev-name', rolling ? 'Rolling the die…' : banner.name);
  const incoming = curr.warn && curr.warn.id === banner.id ? ` ⚠ Hits in ${curr.warn.in}s!` : '';
  setText('ev-desc', rolling ? '' : banner.desc + incoming);
}

// ---------- Chaos event visuals (telegraphs, flood, beetle) ----------
const DIE_FACES = 10;

// Ground overlays drawn under ants: the flood river and the warning markers for incoming hazards.
function drawEventGround(now) {
  const w = curr.warn, pulse = .5 + .5 * (globalThis.motionSin || Math.sin)(now / 120);
  if (curr.flood || (w && w.id === 'flood')) drawFloodBand(curr.flood || 1.3, !curr.flood, pulse);
  if (!w) return;
  if (w.line) { // anteater charge lane
    const a = toScreen(w.line[0][0], w.line[0][1]), b = toScreen(w.line[1][0], w.line[1][1]);
    ctx.save();
    ctx.strokeStyle = `rgba(230,40,30,${.35 + .4 * pulse})`; ctx.lineWidth = 22 * scale; ctx.lineCap = 'round';
    ctx.setLineDash([18 * scale, 14 * scale]); ctx.lineDashOffset = -now / 20;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    ctx.restore();
  }
  if (w.id === 'beetle') { // cracking ground in the centre + a target ring on the doomed nest
    const c = toScreen(curr.map / 2, curr.map / 2);
    ctx.strokeStyle = `rgba(60,30,10,${.5 + .5 * pulse})`; ctx.lineWidth = 3 * scale;
    for (let i = 0; i < 6; i++) {
      const ang = i * Math.PI / 3 + .3, r = (16 + 10 * pulse) * scale;
      ctx.beginPath(); ctx.moveTo(c.x, c.y); ctx.lineTo(c.x + Math.cos(ang) * r, c.y + Math.sin(ang) * r * .5); ctx.stroke();
    }
    if (w.target !== null && curr.players[w.target]) {
      const n = curr.players[w.target].nest, t = toScreen(n.x, n.y);
      ctx.strokeStyle = `rgba(230,40,30,${.4 + .5 * pulse})`; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.ellipse(t.x, t.y, 56 * scale, 28 * scale, 0, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.lineWidth = 1;
  }
}

// River along x + y = map (the line between the teams). `preview` draws only a pulsing outline.
function drawFloodBand(half, preview, pulse) {
  const m = curr.map, d = half * Math.SQRT2, k1 = m - d, k2 = m + d;
  const pts = [[0, k1], [0, m], [k2 - m, m], [m, k2 - m], [m, 0], [k1, 0]].map(([x, y]) => toScreen(x, y));
  ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
  for (const p of pts.slice(1)) ctx.lineTo(p.x, p.y);
  ctx.closePath();
  if (preview) { ctx.strokeStyle = `rgba(80,150,255,${.4 + .5 * pulse})`; ctx.lineWidth = 3; ctx.setLineDash([10, 8]); ctx.stroke(); ctx.setLineDash([]); ctx.lineWidth = 1; }
  else { ctx.fillStyle = `rgba(50,120,220,${.45 + .08 * pulse})`; ctx.fill(); }
}

function drawBeetle(b, now) { // creature-art.js: cached sprite; attacks (head down, front leg up) once at its target nest
  const c = toScreen(b.x, b.y), k = scale, home = b.target != null && curr.players[b.target] && curr.players[b.target].nest;
  const atHome = !!home && Math.hypot(home.x - b.x, home.y - b.y) <= 1.6;
  CreatureArt.draw(ctx, 'beetle', c, k, { face: Math.cos(screenAngle(b.dir)) < 0 ? -1 : 1, pose: CreatureArt.poseFor('beetle', now, { moving: !atHome, attack: atHome }) });
  CreatureArt.bar(ctx, c, k, 58, 50, b.hp / 100, '#7ad04a');
}

// A draw call that throws mid-frame would leave ctx.save() unmatched and its alpha/transform leaking into every later frame
// (the screen goes blank or faint). Reset the context each frame and report the first error of each kind once.
const frameErrors = new Set();
// Auto render scale. Samples rAF intervals (long stalls clamped so a hidden tab or a rebake hitch does not count); every 2.5 s, if the average is
// over 30 ms (under ~33 fps), steps renderScale down one notch, as long as the backing store stays above ~1.2 million pixels. ?rscale=1 turns it off.
const RSCALE_STEPS = [1, 0.8, 0.65, 0.5], RSCALE_MIN_PX = 1.2e6, RSCALE_SLOW_MS = 30;
const rscaleFixed = params.get('rscale') !== null;
let rscaleIdx = 0, rscaleAt = 0, rscaleSum = 0, rscaleN = 0, rscaleLast = 0;
if (rscaleFixed) renderScale = Math.max(0.3, Math.min(1, Number(params.get('rscale')) || 1));
function adaptScale(now) {
  const dt = rscaleLast ? now - rscaleLast : 0; rscaleLast = now;
  if (rscaleFixed || !curr || document.hidden) { rscaleN = rscaleSum = 0; return; }
  if (dt > 0) { rscaleSum += Math.min(dt, 100); rscaleN++; }
  if (!rscaleAt) rscaleAt = now + 6000; // let the first seconds of a match (sprite and layer baking) pass
  if (now < rscaleAt || rscaleN < 30) return;
  const avg = rscaleSum / rscaleN; rscaleSum = rscaleN = 0; rscaleAt = now + 2500;
  if (avg <= RSCALE_SLOW_MS || rscaleIdx >= RSCALE_STEPS.length - 1) return;
  const next = RSCALE_STEPS[rscaleIdx + 1], dpr = Math.min(2, devicePixelRatio || 1);
  if (innerWidth * innerHeight * (dpr * next) ** 2 < RSCALE_MIN_PX) return;
  rscaleIdx++; renderScale = next; rscaleAt = now + 4000; rscaleLast = 0;
  resize();
}
function frame(now) {
  requestAnimationFrame(frame);
  adaptScale(now);
  if (window.Perf) Perf.frame(now); // ant68: overlay timing, a no-op while off
  const dpr = pixelRatio();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.globalAlpha = 1; ctx.setLineDash([]);
  ctx.clearRect(0, 0, innerWidth, innerHeight);
  if (!curr) return;
  try { drawFrame(now); if (window.Perf) Perf.end(); } catch (e) {
    ctx.restore(); // the try may have thrown between save and restore; an extra restore on an empty stack is a no-op
    const k = String(e && e.message);
    if (!frameErrors.has(k)) { frameErrors.add(k); console.error('frame error:', e); }
  }
}

function drawFrame(now) {
  const v = view(now);
  if (window.Perf) Perf.mark('prep');
  if (window.FX && FX.lastSnap !== v.to) { FX.onSnapshot(fxSnap, v.to, now); fxSnap = v.to; } // effects fire as the picture reaches them
  if (window.Perf) Perf.mark('effects');
  if (window.Decals) Decals.onFrame(v.to, now); // ant18/decals: wear + marks from the same snapshot
  if (window.Perf) Perf.mark('decals');
  const map = curr.map;
  const [cw, ch] = canvasSize();
  if (!scale || map !== sizedFor || canvas.width !== cw || canvas.height !== ch) resize();
  if (window.Camera) ({ scale, ox, oy } = Camera.frame(now)); // camera.js eases pan/zoom; toScreen reads these
  // Shake the camera during an earthquake roll.
  const qAt = banner ? (banner.warn || 0.9) * 1000 : 0; // shake when the telegraphed quake actually hits
  const quake = banner && banner.id === 'quake' && now - banner.shownAt > qAt && now - banner.shownAt < qAt + 1100;
  ctx.save();
  if (quake && !(window.Settings && Settings.reduced())) ctx.translate((Math.random() - .5) * 2.5, (Math.random() - .5) * 1.5); // ant18: was 10 x 6 (too much); off in Reduced motion

  if (window.Perf) Perf.mark('prep');
  drawGround(map); // render.js: the cached board layer
  if (window.Perf) Perf.mark('ground');
  if (window.Decals) Decals.drawGround(ctx, now, toScreen, scale); // ant18/decals: wear, marks, dust
  if (window.Perf) Perf.mark('decals');
  drawEventGround(now);
  if (window.Abilities) Abilities.drawGround(now); // ant16: trails, volley warnings, alarm marks
  if (window.Objectives) Objectives.drawGround(now); // ant16: aphid farms, spider lairs
  if (window.drawSelectionRings) drawSelectionRings(now); // input.js
  if (window.Perf) Perf.mark('ground2');

  drawWorld(now); // render.js: ant shadows, corpses, then nests/food/ants/hazards depth-sorted by screen y
  if (window.Decals) Decals.drawAir(ctx, now, toScreen, scale); // ant18/decals: spores, embers, critters (under the fog)
  if (window.Perf) Perf.mark('decals');
  if (window.Fog) Fog.drawOn(ctx, toScreen, v.to); // ant16 fog: one stretched blit over the world
  if (window.Perf) Perf.mark('fog');
  if (window.Objectives) Objectives.drawTop(now); // ant16: lair spiders
  if (window.FX) FX.draw(ctx, now, toScreen, scale, COLORS);
  if (window.UnitArt) UnitArt.drawShots(ctx, now, toScreen, scale); // spitter acid
  drawBuildingFlags(now); // only the selected building's flags
  drawHatchPops(now);
  if (window.Pings) Pings.draw(now); // teammates' rally flags + pings (pings.js)
  if (window.Perf) Perf.mark('effects');

  if (window.Abilities) Abilities.drawOver(now); // ant16: incoming acid volleys
  if (window.drawInputOverlay) drawInputOverlay(now); // input.js: drag box, order markers
  ctx.restore();
  drawWeather(now);
  drawNestAlarm(now);
  drawBanner(now);
  if (window.Perf) Perf.mark('overlay');
}

// ant62: a small "+1" that floats up over an outpost when it hatches an ant (log entry 'hatch'). Reduced motion: it stays put and fades.
const hatchPops = [], HATCH_POP_MS = 900;
function drawHatchPops(now) {
  if (!hatchPops.length) return;
  const still = window.Settings && Settings.reduced();
  while (hatchPops.length && now - hatchPops[0].at > HATCH_POP_MS) hatchPops.shift();
  if (hatchPops.length > 40) hatchPops.splice(0, hatchPops.length - 40);
  ctx.save();
  ctx.font = `bold ${Math.round(14 * scale)}px sans-serif`; ctx.textAlign = 'center'; ctx.lineWidth = 3 * scale; ctx.strokeStyle = 'rgba(0,0,0,.65)';
  for (const p of hatchPops) {
    const t = (now - p.at) / HATCH_POP_MS, c = toScreen(p.x, p.y);
    const y = c.y - (28 + (still ? 0 : 22 * t)) * scale;
    ctx.globalAlpha = Math.max(0, 1 - t * t);
    ctx.fillStyle = COLORS[p.colony] || '#fff';
    ctx.strokeText('+1', c.x, y); ctx.fillText('+1', c.x, y);
  }
  ctx.restore();
}

// A red edge flash while your own nest is being hit, so an attack reads even when you are looking elsewhere.
// Four thin rects, no gradient: cheap, and only drawn during the 260 ms shake.
function drawNestAlarm(now) {
  const k = mySide >= 0 && window.FX && curr.players[mySide].alive ? FX.nestShake(mySide, now) : 0;
  if (!k || (window.Settings && Settings.reduced())) return;
  const d = 10, W = innerWidth, H = innerHeight;
  ctx.fillStyle = `rgba(230,40,30,${(k * .45).toFixed(3)})`;
  ctx.fillRect(0, 0, W, d); ctx.fillRect(0, H - d, W, d); ctx.fillRect(0, d, d, H - 2 * d); ctx.fillRect(W - d, d, d, H - 2 * d);
}
resize();
requestAnimationFrame(frame);

// Share links (?room=X&mode=2v2) join straight away. Kept last so join() never hits an undeclared let.
// On a static copy a ?room= without ?dc= means nothing (no server to hold the room): stay home, clean the URL, say why.
if (params.get('room') && staticCopy && !oneLobby) { try { history.replaceState(null, '', location.pathname); } catch {} netNotice(NO_CODE, 10000); }
else if (params.get('room')) join(params.get('mode') || '1v1');
