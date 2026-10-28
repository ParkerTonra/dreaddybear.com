// Ant Arena unit control (RTS-style): select ants, give orders, control groups, touch support.
// Loaded after client.js and uses its globals (curr, mySide, send, toScreen, screenToWorld, lerpAnts, scale, ctx).
//   Click ant: select · drag: box select (fighters only, unless the box holds just workers) · Shift: add · double-click: all of that type
//   Q soldiers · Shift+W workers · Shift+A all · Ctrl+1-9 save group · 1-9 recall · Shift+S stop · E back to auto · H home · Esc cancel/deselect
//   Right-click (or click with a selection): smart order. On an enemy: attack it. On your own ant: follow it.
//   On the ground: move (Ctrl: soldiers attack-move). On an enemy nest or structure: siege it, ignoring workers.
//   Click your nest or a structure: select the building (separate from ants). Producers (nest, finished outpost) have their own
//   rally flags: right-click ground sets where its fighters gather, right-click food sets where its new workers forage,
//   right-click the building itself clears the worker target. Spawn buttons and keys hatch from the selected producer (else the nest).
//   Right-DRAG with a selection: formation line (the group spreads along it, keeping its order)
//   The cursor shows what a click would do (attack / follow / forage / home / siege / move); a right-drag shows a dot per ant's slot
//   Shift+order: queue it after the current orders (waypoints, drawn as a line)
//   F then click: attack-move (F then drag: area attack) · P then click: patrol · D: hold position
//   Ctrl+F: fire state (hold fire / return fire / fire at will) · Ctrl+D: move state (hold position / maneuver / roam)
// Other scripts (selection panel, camera) can drive all of this through window.Orders (bottom of file).
const ORDER_IDX = 9; // ants tuple index of the order flag appended by the server (0 = automatic)
const FOE_IDX = 10, STATE_IDX = 11; // ant17: current target's id (0 none), fire + 3 * move state code
// Order flag -> kind, mirrors ORDER_KINDS in orders.js (flag = index + 1).
const ORDER_KINDS = ['move', 'attack', 'forage', 'home', 'hold', 'patrol', 'guard', 'follow', 'dig'];
const KIND_COLOR = { dig: '#ffb84a', move: '#7de07d', attack: '#ff5a4a', forage: '#a8e05e', home: '#f0d86a', hold: '#ffb84a', patrol: '#6ac8ff', guard: 'rgba(255,255,255,.9)', follow: '#c89cff', rally: '#e8c070' };
const FIRE_NAMES = ['Hold fire', 'Return fire', 'Fire at will'], MOVE_NAMES = ['Hold position', 'Maneuver', 'Roam'];
const MAX_IDS = 60;
const AREA_MIN = 0.5, AREA_MAX = 6, LINE_MIN = 0.6; // tiles; the server clamps areas too
const LINE_GAP = 0.45, LINE_MAX = 14; // mirror orders.js: spacing along a formation line, longest line
const MODE_TEXT = { attack: 'Attack-move: click a spot or an enemy · drag: area attack', patrol: 'Patrol: click the far end' };
const sel = new Set(); // selected ant ids (own colony only)
const groups = {}; // digit -> [ant ids]; an ant is in at most one group (BAR)
// Autogroups (BAR style, with a default preset so it works from the first match): caste type id -> group digit.
// New ants of a caste join its group the first time they are seen. Alt+digit re-maps a caste, Alt+` clears it.
const DEFAULT_AUTO = { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 0: 6 }; // soldiers, spitters, majors, nurses, alates, workers
const AUTO_KEY = 'antArenaAutogroups';
let autoGroup = { ...DEFAULT_AUTO };
try { const raw = typeof localStorage !== 'undefined' && localStorage.getItem(AUTO_KEY); if (raw) { const o = JSON.parse(raw); if (o && typeof o === 'object') autoGroup = o; } } catch (_) { /* private mode */ }
const saveAuto = () => { try { if (typeof localStorage !== 'undefined') localStorage.setItem(AUTO_KEY, JSON.stringify(autoGroup)); } catch (_) { /* private mode */ } };
const seenAnts = new Set();
let lastDigit = { d: null, t: 0 };
const plans = new Map(); // ant id -> [{ kind, x, y, target?, ax?, ay? }] what we told it to do, for the waypoint lines
let drag = null; // { sx, sy, ex, ey, button, moved, touch }
let lastClick = { t: 0, type: -1 };
let marks = []; // order feedback markers { x, y, color, at, cross?, r?, line? }
let mode = null; // pending click order: 'attack' | 'patrol'
let bsel = null; // selected building: { kind: 'nest' } | { kind: 'struct', id }. Exclusive with the ant selection `sel`

// Put ids in group d, taking them out of every other group.
function putInGroup(d, ids, replace) {
  const set = new Set(ids);
  for (const k of Object.keys(groups)) if (k !== d) groups[k] = groups[k].filter(id => !set.has(id));
  groups[d] = replace ? [...ids] : [...new Set([...(groups[d] || []), ...ids])];
}
// Newly seen own ants join their caste's group (first sight only, so a hand-made group is never overridden).
function syncAutogroups() {
  if (!curr || mySide < 0) return;
  const fresh = {};
  for (const a of curr.ants) {
    if (a[1] !== mySide || seenAnts.has(a[0])) continue;
    seenAnts.add(a[0]);
    const d = autoGroup[a[2]];
    if (d) (fresh[d] = fresh[d] || []).push(a[0]);
  }
  for (const d of Object.keys(fresh)) putInGroup(d, fresh[d], false);
}
// Idle fighters: no order (flag 0) or guarding (7), and no foe. Workers forage on their own, so they are never idle.
const idleFighters = (ants, side) => ants.filter(a => a[1] === side && a[2] && (!a[ORDER_IDX] || a[ORDER_IDX] === 7) && !a[FOE_IDX]).map(a => a[0]).sort((p, q) => p - q);
const nextIdle = (ids, last) => (ids.length ? (ids.find(id => id > last) || ids[0]) : 0); // the next id after `last`, wrapping
let idleLast = 0;
// Each call picks the next idle fighter and centres on it; `all` (Shift) selects every idle fighter instead.
function cycleIdle(all) {
  const ids = idleFighters(curr.ants, mySide);
  if (!ids.length) return;
  const id = nextIdle(ids, idleLast);
  idleLast = id;
  setSel(all ? ids : [id], false);
  const a = curr.ants.find(b => b[0] === id);
  if (!all && a && typeof Camera !== 'undefined' && Camera.focusWorld) Camera.focusWorld(a[3], a[4]);
}
const HURT_PCT = 50; // the Hurt button / key: fighters under this health
const hurtFighters = (ants, side) => ants.filter(a => a[1] === side && a[2] && a[7] < HURT_PCT).map(a => a[0]);
const liveGroup = d => (groups[d] || []).filter(id => curr.ants.some(a => a[0] === id));

const canCommand = () => curr && mySide >= 0 && curr.players[mySide] && curr.players[mySide].alive;
const myAnts = () => (curr ? lerpAnts(performance.now()).filter(a => a[1] === mySide) : []);
const antScreen = a => { const c = toScreen(a[3], a[4]); return { x: c.x, y: c.y - 3 * scale }; };
const kindOf = a => ORDER_KINDS[(a[ORDER_IDX] || 0) - 1] || null;
const unitSize = t => (typeof UnitArt !== 'undefined' && UnitArt.UNITS[t] ? UnitArt.UNITS[t].size : 1);

function pruneSel() {
  if (!curr) return; // between matches or while reconnecting: keep the selection until a real snapshot says otherwise
  const alive = new Set(curr.ants.filter(a => a[1] === mySide).map(a => a[0]));
  for (const id of sel) if (!alive.has(id)) sel.delete(id);
}
function setSel(ids, add) {
  if (!add || ids.length) bsel = null; // a new ant selection puts the building down
  if (!add) sel.clear();
  for (const id of ids) sel.add(id);
  pendingState.fire = pendingState.move = pendingState.pref = null; // another selection, its own states
  updateReadout();
}
function setMode(m) {
  mode = m;
  if (canvas.style) canvas.style.cursor = m ? 'crosshair' : '';
  updateReadout();
}
const mark = (w, color, cross, extra) => marks.push({ x: w.x, y: w.y, color, at: performance.now(), cross, ...extra });

// The ant under the cursor. Each ant's hit area is an ellipse the size of its sprite (ants are wider than tall on
// the iso board), never smaller than r px. With `enemyFirst` (order clicks) an enemy beats your own ants lying on
// top of it, so right-clicking into a brawl attacks instead of walking there.
function antAt(sx, sy, r, enemyFirst) {
  let best = null, bd = Infinity, bestEnemy = false;
  for (const a of lerpAnts(performance.now())) {
    const c = antScreen(a), k = scale * unitSize(a[2]);
    const d = Math.hypot((c.x - sx) / Math.max(r, 12 * k), (c.y - sy) / Math.max(r * 0.7, 7 * k)); // 1 = on the ellipse's edge
    if (d >= 1) continue;
    const enemy = curr.players[a[1]].team !== myTeam;
    const better = !best || (enemyFirst && enemy && !bestEnemy) || (!(enemyFirst && !enemy && bestEnemy) && d < bd);
    if (better) { best = a; bd = d; bestEnemy = enemy; }
  }
  return best;
}

// ---------- Building selection ----------
// Your nest and your structures are clickable. Producers (the nest, a finished outpost) own a fighter rally flag and
// a worker forage target; depots and mounds are selectable for info only. Structure tuples: [id, colony, kind, x, y, hp%, built%].
const STRUCT_NAMES = ['Food cache', 'Acid mound', 'Outpost', 'Fungus garden'], STRUCT_ICONS = ['🍯', '🌋', '⛺', '🍄'], OUTPOST = 2;
const BUILDING_HIT = 1.0, NEST_HIT = 1.3;
const myStruct = id => ((curr && curr.structures) || []).find(s => s[0] === id && s[1] === mySide && !s[7]) || null;
function buildingAt(w) {
  if (!curr || mySide < 0 || !curr.players[mySide]) return null;
  const me = curr.players[mySide];
  if (me.alive && Math.hypot(me.nest.x - w.x, me.nest.y - w.y) < NEST_HIT) return { kind: 'nest' };
  let best = null, bd = BUILDING_HIT;
  for (const s of (curr.structures || [])) {
    if (s[1] !== mySide || s[7]) continue;
    const d = Math.hypot(s[3] - w.x, s[4] - w.y);
    if (d < bd) { bd = d; best = s; }
  }
  return best ? { kind: 'struct', id: best[0] } : null;
}
// What the selected building is, for the panel and the flag drawing; null when none (a razed one drops the selection).
function buildingInfo() {
  if (!bsel || !curr || mySide < 0) return null;
  const me = curr.players[mySide];
  if (bsel.kind === 'nest') {
    if (!me || !me.alive) return null;
    const n = me.nest;
    return { kind: 'nest', id: null, name: 'Nest', icon: '🏰', x: n.x, y: n.y, hp: Math.round(100 * n.hp / (n.max || 100)), done: true, built: 100, producer: true,
      rally: me.rally || null, forage: (curr.wrally && curr.wrally[mySide]) || null };
  }
  const s = myStruct(bsel.id);
  if (!s) return null;
  const done = s[6] >= 100, row = (curr.srally || []).find(r => r[0] === s[0] && r[1] === mySide);
  return { kind: 'struct', id: s[0], type: s[2], name: STRUCT_NAMES[s[2]] || 'Building', icon: STRUCT_ICONS[s[2]] || '', x: s[3], y: s[4], hp: s[5], done, built: s[6],
    producer: s[2] === OUTPOST && done,
    rally: row ? { x: row[2], y: row[3] } : null, forage: row && row[4] != null ? { x: row[4], y: row[5] } : null };
}
function pruneB() { if (bsel && !buildingInfo()) bsel = null; }
function selectBuilding(b) {
  sel.clear(); pendingState.fire = pendingState.move = pendingState.pref = null;
  bsel = b ? { ...b } : null;
  updateReadout();
}
// Spawn / rally / forage messages name an outpost with `from`; the nest is the default and sends nothing.
const producerMsg = () => { const B = buildingInfo(); return B && B.producer && B.kind === 'struct' ? { from: B.id } : {}; };
// Right-click (or tap) with a producer selected: food -> its new workers forage there; the building itself -> clear that;
// ground -> its fighters gather there.
function buildingOrder(w) {
  const B = buildingInfo();
  if (!B || !B.producer || !w) return;
  const from = producerMsg();
  const pile = curr.food.find(f => Math.hypot(f[1] - w.x, f[2] - w.y) < 1.2);
  if (pile) { send({ type: 'forage', x: pile[1], y: pile[2], ...from }); mark({ x: pile[1], y: pile[2] }, KIND_COLOR.forage); }
  else if (Math.hypot(B.x - w.x, B.y - w.y) < (B.kind === 'nest' ? NEST_HIT : BUILDING_HIT)) { send({ type: 'forage', clear: true, ...from }); mark(B, KIND_COLOR.forage); }
  else { send({ type: 'rally', x: w.x, y: w.y, ...from }); mark(w, KIND_COLOR.rally); }
}
function clearForage() { const B = buildingInfo(); if (B && B.producer && B.forage) send({ type: 'forage', clear: true, ...producerMsg() }); }

// Mirror of the server's queue rule (orders.js): Shift appends to a busy ant's plan, but an idle,
// guarding or holding ant just starts the new order.
function remember(ids, step, queue) {
  if (step) step.r = step.r || 0.4 + 0.27 * Math.sqrt(ids.length); // about how far from the click the formation puts an ant
  for (const id of ids) {
    const a = curr && curr.ants.find(b => b[0] === id);
    const k = a && kindOf(a), busy = k && k !== 'guard' && k !== 'hold';
    if (!step) { plans.delete(id); continue; }
    if (queue && busy && plans.has(id)) { const p = plans.get(id); if (p.length < 9) p.push({ ...step }); }
    else plans.set(id, [{ ...step }]);
  }
}

function sendOrder(ids, kind, w, extra) {
  if (!ids.length) return;
  for (let i = 0; i < ids.length; i += MAX_IDS) {
    const m = { type: 'order', ids: ids.slice(i, i + MAX_IDS), kind, ...extra };
    if (w) { m.x = w.x; m.y = w.y; }
    send(m);
  }
  const q = !!(extra && extra.queue);
  if (kind === 'state') return;
  if (kind === 'auto' || kind === 'stop' || kind === 'hold') remember(ids, null, false);
  else if (kind === 'home') remember(ids, { kind, x: curr.players[mySide].nest.x, y: curr.players[mySide].nest.y }, q);
  else if (kind === 'follow') remember(ids, { kind, target: extra.target }, q);
  else if (kind === 'patrol') {
    for (const id of ids) { // patrol runs from where the ant is (or its last queued stop) to the click
      const a = curr.ants.find(b => b[0] === id), p = plans.get(id), last = q && p && p[p.length - 1];
      remember([id], { kind, x: w.x, y: w.y, ax: last ? last.x : a ? a[3] : w.x, ay: last ? last.y : a ? a[4] : w.y }, q);
    }
  } else remember(ids, { kind: kind === 'forage' ? 'forage' : kind, x: w.x, y: w.y, target: extra && extra.target, r: extra && (extra.area || (extra.line && Math.hypot(extra.line[2] - extra.line[0], extra.line[3] - extra.line[1]) / 2 + 0.5)) }, q);
}

function picked() {
  pruneSel();
  const ants = curr.ants.filter(a => sel.has(a[0]));
  return { all: ants.map(a => a[0]), workers: ants.filter(a => !a[2]).map(a => a[0]), soldiers: ants.filter(a => a[2]).map(a => a[0]) };
}
const enemyNestAt = w => curr.players.findIndex(p => p.alive && p.team !== myTeam && Math.hypot(p.nest.x - w.x, p.nest.y - w.y) < 1.3);
// An enemy structure under the point (snapshot tuple: [id, colony, kind, x, y, hp%, built%]), or null.
const enemyStructAt = w => ((curr && curr.structures) || []).find(s => curr.players[s[1]] && curr.players[s[1]].team !== myTeam && Math.hypot(s[3] - w.x, s[4] - w.y) < 0.9) || null;
// ant33 dig: is the point on a rock tile (terrain-draw.js knows the map), and is a major selected (ant type id 3)?
const rockUnder = w => typeof TerrainDraw !== 'undefined' && !!TerrainDraw.at && TerrainDraw.at(curr, w.x, w.y) === 1;
const majorsSelected = () => curr.ants.some(a => sel.has(a[0]) && a[2] === 3);
const allyNestAt = w => curr.players.findIndex((p, i) => i !== mySide && p.alive && p.team === myTeam && Math.hypot(p.nest.x - w.x, p.nest.y - w.y) < 1.3);

// What a smart click at world point w (over `target`, an ant tuple or null) would do, in smartOrder's priority order:
// attack | follow | siege | raze | home | guard | forage | move. `line` (a formation drag) is always a plain move.
// The cursor (hoverCursor) and smartOrder both read this, so the glyph can never promise another order.
function smartKind(w, target, line) {
  if (line) return { kind: 'move' };
  if (target) return { kind: curr.players[target[1]].team !== myTeam ? 'attack' : 'follow' };
  const nest = enemyNestAt(w);
  if (nest >= 0) return { kind: 'siege', nest };
  const strukt = enemyStructAt(w);
  if (strukt) return { kind: 'raze', strukt };
  if (Math.hypot(curr.players[mySide].nest.x - w.x, curr.players[mySide].nest.y - w.y) < 1.3) return { kind: 'home' };
  const ally = allyNestAt(w);
  if (ally >= 0) return { kind: 'guard', ally };
  const pile = curr.food.find(f => Math.hypot(f[1] - w.x, f[2] - w.y) < 1.2);
  if (pile) return { kind: 'forage', pile };
  if (rockUnder(w) && majorsSelected()) return { kind: 'dig' }; // ant33: majors chew a rock out
  return { kind: 'move' };
}
// One click, the right order for each kind of ant: enemy -> attack it, own/ally ant -> follow it, enemy nest ->
// siege it, enemy structure -> raze it, own nest -> go home, ally nest -> guard it, food -> workers forage it,
// ground -> everyone moves (soldiers bite what is in reach but never chase, as in BAR; Ctrl: soldiers attack-move). Shift queues it after the current orders. `line` (right-drag) spreads
// the group along that segment instead of around the point.
function smartOrder(w, target, ctrl, queue, line) {
  const { all, workers, soldiers } = picked();
  if (!all.length) return;
  const me = curr.players[mySide], q = queue ? { queue: true } : {};
  const { kind, nest, ally, strukt, pile } = smartKind(w, target, !!line);
  if (line) q.line = line;
  if (kind === 'attack') {
    w = { x: target[3], y: target[4] };
    sendOrder(all, 'attack', w, { ...q, target: target[0] }); mark(w, KIND_COLOR.attack, true);
  } else if (kind === 'follow') { // follow a friendly ant (the leader itself is left out)
    sendOrder(all.filter(id => id !== target[0]), 'follow', null, { ...q, target: target[0] }); mark({ x: target[3], y: target[4] }, KIND_COLOR.follow);
  } else if (kind === 'siege') {
    w = curr.players[nest].nest; // siege: hit the nest, ignore its workers (F + click still fights everything)
    sendOrder(all, 'attack', w, { ...q, nest }); mark(w, KIND_COLOR.attack, true);
  } else if (kind === 'raze') { // raze it, fight enemy fighters, ignore workers
    w = { x: strukt[3], y: strukt[4] };
    sendOrder(all, 'attack', w, { ...q, struct: strukt[0] }); mark(w, KIND_COLOR.attack, true);
  } else if (kind === 'home') {
    sendOrder(all, 'home', null, q); mark(me.nest, KIND_COLOR.home);
  } else if (kind === 'guard') { // guard a teammate's nest: attack-move there, then stand guard
    w = curr.players[ally].nest;
    sendOrder(all, 'attack', w, q); mark(w, KIND_COLOR.guard);
  } else if (kind === 'dig') { // majors dig the rock; everyone else walks to the nearest open ground
    const majors = curr.ants.filter(a => sel.has(a[0]) && a[2] === 3).map(a => a[0]);
    sendOrder(majors, 'dig', w, q);
    sendOrder(all.filter(id => !majors.includes(id)), 'move', w, q); mark(w, KIND_COLOR.dig);
  } else if (kind === 'forage') {
    sendOrder(workers, 'forage', { x: pile[1], y: pile[2] }, q);
    sendOrder(soldiers, ctrl ? 'attack' : 'move', w, q); mark(w, KIND_COLOR.forage);
  } else {
    sendOrder(workers, 'move', w, q);
    sendOrder(soldiers, ctrl ? 'attack' : 'move', w, q);
    mark(w, soldiers.length && ctrl ? '#ff9a4a' : KIND_COLOR.move, false, line ? { line } : null);
  }
}

// ---------- Order commands (also the API for buttons: window.Orders) ----------
function attackMove(w, queue, target, area) {
  const { all } = picked();
  if (!all.length) return;
  if (target) { w = { x: target[3], y: target[4] }; sendOrder(all, 'attack', w, { queue: !!queue || undefined, target: target[0] }); mark(w, KIND_COLOR.attack, true); }
  else if (area) { sendOrder(all, 'attack', w, { queue: !!queue || undefined, area }); mark(w, KIND_COLOR.attack, true, { r: area }); }
  else { sendOrder(all, 'attack', w, queue ? { queue: true } : undefined); mark(w, KIND_COLOR.attack, true); }
}
function patrol(w, queue) {
  const { all } = picked();
  if (!all.length) return;
  sendOrder(all, 'patrol', w, queue ? { queue: true } : undefined);
  mark(w, KIND_COLOR.patrol);
}
function simple(kind) { const { all } = picked(); if (all.length) sendOrder(all, kind); }
function goHome() { // the selection goes home (nothing selected: nothing happens; a selected producer's rally flag goes home)
  const nest = curr.players[mySide].nest, B = buildingInfo();
  if (sel.size) sendOrder([...sel], 'home');
  else if (B && B.producer) send({ type: 'rally', x: nest.x, y: nest.y, ...producerMsg() });
  else return;
  mark(nest, KIND_COLOR.home);
}
// Fire / move state of the selection: the most common value, or -1 when nothing is selected. A state just sent
// counts as current until the server echoes it, so two quick presses cycle twice instead of repeating one step.
const pendingState = {}; // which -> { v, until }
function stateOf(which) {
  const { all } = picked();
  if (!all.length) return -1;
  const p = pendingState[which];
  if (p && performance.now() < p.until) return p.v;
  const n = [0, 0, 0];
  for (const a of curr.ants) if (sel.has(a[0])) { const c = a[STATE_IDX] || 5; n[which === 'fire' ? c % 3 : Math.floor(c / 3) % 3]++; }
  return n.indexOf(Math.max(...n));
}
function setState(which, v) {
  const { all } = picked();
  if (!all.length || !(v >= 0 && v <= 2)) return;
  sendOrder(all, 'state', null, { [which]: v });
  pendingState[which] = { v, until: performance.now() + 600 };
  updateReadout();
}
// Target priority of the selection (ant25): 0 = any, 1..6 = prefer worker / soldier / spitter / major / nurse / alate
// (state code / 9, orders.js); the most common value, or -1 with nothing selected. Same echo grace as stateOf.
function prefOf() {
  const { all } = picked();
  if (!all.length) return -1;
  const p = pendingState.pref;
  if (p && performance.now() < p.until) return p.v;
  const n = [0, 0, 0, 0, 0, 0, 0];
  for (const a of curr.ants) if (sel.has(a[0])) n[Math.floor((a[STATE_IDX] || 5) / 9)]++;
  return n.indexOf(Math.max(...n));
}
function setPref(v) {
  const { all } = picked();
  if (!all.length || !(v >= 0 && v <= 6)) return;
  sendOrder(all, 'state', null, { pref: v - 1 }); // wire: -1 = any, else the caste id
  pendingState.pref = { v, until: performance.now() + 600 };
  updateReadout();
}
const cycleState = which => { const v = stateOf(which); if (v >= 0) setState(which, (v + 1) % 3); };

function click(sx, sy, button, shift, ctrl, touch) {
  const w = screenToWorld(sx, sy);
  const onMap = w.x >= 0 && w.y >= 0 && w.x <= curr.map && w.y <= curr.map;
  const ant = antAt(sx, sy, Math.max(touch ? 24 : 12, 10 * scale), button === 2 || mode === 'attack');
  if (mode) { // a pending F / P order: left-click (or tap) gives it, right-click cancels (StarCraft style)
    const m = mode;
    if (!shift || button === 2) setMode(null); // Shift keeps the mode for more waypoints
    if (button === 2 || (!onMap && !ant)) return;
    if (m === 'attack') attackMove(w, shift, ant && ant[1] !== mySide && curr.players[ant[1]].team !== myTeam ? ant : null);
    else if (m === 'patrol') patrol(w, shift);
    return;
  }
  if (button === 0 && ant && ant[1] === mySide) {
    const now = performance.now();
    if (now - lastClick.t < 350 && lastClick.type === ant[2]) { // double-click: every visible ant of this type (Ctrl: all of them, map-wide)
      setSel(myAnts().filter(a => a[2] === ant[2] && (ctrl || onScreen(antScreen(a)))).map(a => a[0]), shift);
    } else if (ctrl) { sel.delete(ant[0]); updateReadout(); } // Ctrl+click: take it out of the selection
    else if (shift && sel.has(ant[0])) { sel.delete(ant[0]); updateReadout(); }
    else setSel([ant[0]], shift);
    lastClick = { t: now, type: ant[2] };
    return;
  }
  if (button === 0 && !ant && onMap) { const b = buildingAt(w); if (b) { selectBuilding(b); return; } } // click your nest or a structure: select it
  pruneSel(); pruneB();
  if (!onMap && !ant) return;
  if (bsel) { // a building is selected: right-click (or a tap) is its smart rally; a left-click on empty ground puts it down
    if (button === 2 || touch) buildingOrder(w);
    else { bsel = null; updateReadout(); }
    return;
  }
  if (!sel.size) return;
  smartOrder(w, ant, ctrl, shift);
}
const onScreen = c => c.x >= 0 && c.y >= 0 && c.x <= innerWidth && c.y <= innerHeight;

// Right-drag with a selection: a formation line from where the button went down to where it came up.
function lineOrder(d, shift, ctrl) {
  const a = screenToWorld(d.sx, d.sy), b = screenToWorld(d.ex, d.ey);
  const cl = v => Math.max(0, Math.min(curr.map, v));
  const line = [cl(a.x), cl(a.y), cl(b.x), cl(b.y)];
  if (Math.hypot(line[2] - line[0], line[3] - line[1]) < LINE_MIN) { click(d.sx, d.sy, 2, shift, ctrl, d.touch); return; }
  pruneSel();
  if (bsel) { click(d.sx, d.sy, 2, shift, ctrl, d.touch); return; } // a building has no formation: the drag is a plain right-click
  if (!sel.size) return;
  smartOrder({ x: (line[0] + line[2]) / 2, y: (line[1] + line[3]) / 2 }, null, ctrl, shift, line);
}
// F then drag: attack everything inside the circle (centre where the button went down, radius to where it came up).
function areaOrder(d, shift) {
  const c = screenToWorld(d.sx, d.sy), e = screenToWorld(d.ex, d.ey);
  const r = Math.min(AREA_MAX, Math.hypot(e.x - c.x, e.y - c.y));
  if (!shift) setMode(null);
  if (r < AREA_MIN) { attackMove(c, shift); return; }
  attackMove({ x: Math.max(0, Math.min(curr.map, c.x)), y: Math.max(0, Math.min(curr.map, c.y)) }, shift, null, Math.round(r * 10) / 10);
}

function boxSelect(d, shift, ctrl) {
  const x0 = Math.min(d.sx, d.ex), x1 = Math.max(d.sx, d.ex), y0 = Math.min(d.sy, d.ey), y1 = Math.max(d.sy, d.ey);
  const inBox = myAnts().filter(a => { const c = antScreen(a); return c.x >= x0 && c.x <= x1 && c.y >= y0 && c.y <= y1; });
  if (ctrl) { for (const a of inBox) sel.delete(a[0]); updateReadout(); return; } // Ctrl+box: remove everything in it
  const fighters = inBox.filter(a => a[2]); // workers forage on their own, so a box skips them unless it holds nothing else
  setSel((fighters.length ? fighters : inBox).map(a => a[0]), shift);
}

// ---------- Smart cursor (B6): the glyph says what a click would do with the current selection ----------
// Small data-URI SVGs (hotspot 12,12) with a CSS keyword fallback. It only writes the cursor while nobody else has:
// modes, abilities, pings, build mode and the camera grab all set their own value, which we then leave alone.
const svgCursor = (color, body, fb) => `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' fill='none' stroke='${color}' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round'>${body}</svg>`)}") 12 12, ${fb}`;
const CURSORS = {
  attack: svgCursor('#ff5a4a', "<circle cx='12' cy='12' r='7'/><path d='M12 2v5M12 17v5M2 12h5M17 12h5'/>", 'crosshair'),
  siege: svgCursor('#ff5a4a', "<rect x='6' y='6' width='12' height='12'/><path d='M3 3l4 4M21 3l-4 4M3 21l4-4M21 21l-4-4'/>", 'crosshair'),
  raze: svgCursor('#ff5a4a', "<rect x='7' y='7' width='10' height='10'/><path d='M12 2v3M12 19v3M2 12h3M19 12h3'/>", 'crosshair'),
  follow: svgCursor('#c89cff', "<circle cx='12' cy='12' r='3'/><circle cx='12' cy='12' r='9' stroke-dasharray='3 3'/>", 'alias'),
  forage: svgCursor('#a8e05e', "<path d='M12 3l8 9-8 9-8-9z'/>", 'copy'),
  home: svgCursor('#f0d86a', "<path d='M3 12l9-8 9 8M6 10v10h12V10'/>", 'pointer'),
  guard: svgCursor('#ffffff', "<path d='M12 3l8 3v6c0 5-4 8-8 9-4-1-8-4-8-9V6z'/>", 'pointer'),
  move: svgCursor('#7de07d', "<path d='M5 12h14M13 6l6 6-6 6'/>", 'default'),
  dig: svgCursor('#ffb84a', "<path d='M4 20l9-9M13 11l-3-3 4-4 6 3-3 5z'/>", 'cell'), // a pick: majors will dig this rock
  rally: svgCursor('#e8c070', "<path d='M8 21V3M8 4h11l-3 4 3 4H8'/>", 'pointer'), // a building is selected: a click plants its rally flag
};
let ownCursor = '', lastHover = 0;
// The cursor name for a smartKind result and selection, or '' (no selection): forage only means something to workers.
const cursorKind = (k, hasWorkers) => (k.kind === 'forage' && !hasWorkers ? 'move' : k.kind);
function hoverCursor(e) {
  const st = canvas.style, cur = st.cursor || '';
  if (cur && cur !== ownCursor) return; // another layer owns it right now
  const now = performance.now();
  if (now - lastHover < 50) return;
  lastHover = now;
  let want = '';
  if (!mode && curr && canCommand() && !e.altKey) {
    pruneSel(); pruneB();
    const B = buildingInfo();
    if (sel.size || (B && B.producer)) {
      const w = screenToWorld(e.clientX, e.clientY);
      if (w.x >= 0 && w.y >= 0 && w.x <= curr.map && w.y <= curr.map) {
        if (B) want = CURSORS[curr.food.some(f => Math.hypot(f[1] - w.x, f[2] - w.y) < 1.2) ? 'forage' : 'rally'] || ''; // producer selected: food sets the worker target, ground the rally
        else {
          const ant = antAt(e.clientX, e.clientY, 12 * scale, true), k = smartKind(w, ant, false);
          want = CURSORS[cursorKind(k, curr.ants.some(a => sel.has(a[0]) && !a[2]))] || '';
        }
      }
    }
  }
  if (want !== cur) { st.cursor = want; ownCursor = want; }
}

// ---------- Formation dots (B6): where a right-drag line would put each selected ant ----------
// A client copy of orders.js lineFormation's slot math (same LINE_GAP / LINE_MAX; tests/control.test.js compares them).
function lineSlots(pts, line, map) {
  const n = pts.length, edge = v => Math.max(0.2, Math.min(map - 0.2, v));
  if (!n) return [];
  let [x1, y1, x2, y2] = line, ux = x2 - x1, uy = y2 - y1, L = Math.hypot(ux, uy);
  if (L < 1e-6) return pts.map(() => ({ x: edge(x1), y: edge(y1) }));
  if (L > LINE_MAX) { x2 = x1 + ux / L * LINE_MAX; y2 = y1 + uy / L * LINE_MAX; ux = x2 - x1; uy = y2 - y1; L = LINE_MAX; }
  ux /= L; uy /= L;
  const cx = pts.reduce((s, p) => s + p.x, 0) / n, cy = pts.reduce((s, p) => s + p.y, 0) / n;
  let px = -uy, py = ux;
  if ((cx - x1) * px + (cy - y1) * py < 0) { px = -px; py = -py; }
  const cols = Math.max(1, Math.min(n, Math.floor(L / LINE_GAP) + 1)), rows = Math.ceil(n / cols), slots = [];
  for (let r = 0; r < rows; r++) {
    const inRow = r === rows - 1 ? n - r * cols : cols;
    for (let c = 0; c < inRow; c++) {
      const t = inRow === 1 ? 0.5 : c / (inRow - 1);
      slots.push({ t, r, x: edge(x1 + ux * L * t + px * r * LINE_GAP), y: edge(y1 + uy * L * t + py * r * LINE_GAP) });
    }
  }
  slots.sort((a, b) => a.t - b.t || a.r - b.r);
  const along = pts.map((p, i) => ({ i, s: (p.x - x1) * ux + (p.y - y1) * uy })).sort((a, b) => a.s - b.s || a.i - b.i);
  const out = new Array(n);
  along.forEach((a, k) => { out[a.i] = { x: slots[k].x, y: slots[k].y }; });
  return out;
}

canvas.addEventListener('contextmenu', e => e.preventDefault());
// ant60: the browser's context menu never opens over the game, whatever the right button is released on (HUD, formation
// overlay, tooltip, body), and never during or just after a right-drag. Text fields keep it (copy / paste).
// Per-element right-click handlers (research cancel, panel rows, spawn buttons) still run: this only calls preventDefault.
let rightHeld = false, rightUpAt = -1e9;
const editableTarget = t => !!t && (t.tagName === 'TEXTAREA' || t.isContentEditable === true ||
  (t.tagName === 'INPUT' && !/^(button|checkbox|radio|range|submit|reset|color|file|image)$/i.test(t.type || 'text')));
addEventListener('pointerdown', e => { if (e.button === 2 && !editableTarget(e.target)) rightHeld = true; }, true);
addEventListener('pointerup', e => { if (e.button === 2) { rightHeld = false; rightUpAt = Date.now(); } }, true);
addEventListener('pointercancel', () => { rightHeld = false; }, true);
addEventListener('contextmenu', e => {
  if (!editableTarget(e.target) || rightHeld || Date.now() - rightUpAt < 600) e.preventDefault();
}, true);
canvas.addEventListener('selectstart', e => e.preventDefault());
canvas.addEventListener('pointerdown', e => {
  if (!e.isPrimary || e.altKey || (e.button !== 0 && e.button !== 2) || !canCommand()) return;
  drag = { sx: e.clientX, sy: e.clientY, ex: e.clientX, ey: e.clientY, button: e.button, moved: false, touch: e.pointerType === 'touch' };
  try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* pointer already gone */ }
});
canvas.addEventListener('pointermove', e => {
  if (!drag) { if (e.pointerType !== 'touch') hoverCursor(e); return; }
  if (!e.isPrimary) return;
  drag.ex = e.clientX; drag.ey = e.clientY;
  if (Math.hypot(drag.ex - drag.sx, drag.ey - drag.sy) > (drag.touch ? 12 : 6)) drag.moved = true;
});
canvas.addEventListener('pointerup', e => {
  const d = drag; drag = null;
  if (!d || !e.isPrimary || !canCommand()) return;
  const ctrl = e.ctrlKey || e.metaKey;
  if (d.button === 0 && d.moved && !mode) boxSelect(d, e.shiftKey, ctrl);
  else if (d.button === 0 && d.moved && mode === 'attack') areaOrder(d, e.shiftKey);
  else if (d.button === 2 && d.moved && !mode) lineOrder(d, e.shiftKey, ctrl);
  else click(d.sx, d.sy, d.button, e.shiftKey, ctrl, d.touch);
});
canvas.addEventListener('pointercancel', () => { drag = null; });

addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || !canCommand()) return;
  pruneSel();
  syncAutogroups();
  const digit = Keys.digit(e); // control groups: Keys.is() checks the modifiers (Ctrl saves, Ctrl+Shift adds, Shift adds on recall, Alt autogroups)
  if (digit && Keys.is(e, 'group.save')) { e.preventDefault(); putInGroup(digit, [...sel], true); return; }
  if (digit && Keys.is(e, 'group.add')) { e.preventDefault(); putInGroup(digit, [...sel], false); return; }
  if (digit && Keys.is(e, 'group.auto')) { // this selection's castes now autogroup to `digit`, and every such ant moves there now
    e.preventDefault();
    const types = new Set(curr.ants.filter(a => sel.has(a[0])).map(a => a[2]));
    for (const t of types) autoGroup[t] = +digit;
    saveAuto();
    for (const t of types) putInGroup(digit, curr.ants.filter(a => a[1] === mySide && a[2] === t).map(a => a[0]), false);
    return;
  }
  if (Keys.is(e, 'group.autoclear')) {
    e.preventDefault();
    for (const t of new Set(curr.ants.filter(a => sel.has(a[0])).map(a => a[2]))) delete autoGroup[t];
    saveAuto();
    return;
  }
  if (digit && Keys.is(e, 'group.recall')) {
    e.preventDefault();
    const now = performance.now(), twice = lastDigit.d === digit && now - lastDigit.t < 350 && !e.shiftKey;
    lastDigit = { d: digit, t: now };
    setSel(liveGroup(digit), e.shiftKey);
    if (twice && sel.size && typeof Camera !== 'undefined' && Camera.focusWorld) { // double-tap: centre the camera on the group
      const ps = curr.ants.filter(a => sel.has(a[0]));
      Camera.focusWorld(ps.reduce((t, a) => t + a[3], 0) / ps.length, ps.reduce((t, a) => t + a[4], 0) / ps.length);
    }
    return;
  }
  // unit states (BAR-style): Ctrl+F fire state, Ctrl+D move state
  if (Keys.is(e, 'state.fire')) { if (sel.size) { e.preventDefault(); cycleState('fire'); } return; }
  if (Keys.is(e, 'state.move')) { if (sel.size) { e.preventDefault(); cycleState('move'); } return; }
  const all = () => curr.ants.filter(a => a[1] === mySide);
  if (Keys.is(e, 'select.fighters')) setSel(all().filter(a => a[2]).map(a => a[0]), e.shiftKey);
  else if (Keys.is(e, 'select.workers')) setSel(all().filter(a => !a[2]).map(a => a[0]), false); // ant60: the chord is Shift+W now, so Shift can no longer mean add
  else if (Keys.is(e, 'select.all')) setSel(all().map(a => a[0]), false); // ant60: Shift+A, replaces the selection
  else if (Keys.is(e, 'select.idle')) { // Tab, only while nothing else (a focused button, say) wants it; Shift+Tab never matches
    const ae = document.activeElement;
    if (ae && ae !== document.body && ae !== canvas) return;
    if (idleFighters(curr.ants, mySide).length) { e.preventDefault(); cycleIdle(false); }
  }
  else if (Keys.is(e, 'select.hurt')) setSel(hurtFighters(curr.ants, mySide), e.shiftKey);
  else if (Keys.is(e, 'order.stop')) simple('stop');
  else if (Keys.is(e, 'order.auto')) simple('auto');
  else if (Keys.is(e, 'order.hold')) simple('hold');
  else if (Keys.is(e, 'order.attack')) { if (sel.size) setMode('attack'); }
  else if (Keys.is(e, 'order.patrol')) { if (sel.size) setMode('patrol'); }
  else if (Keys.is(e, 'order.home')) goHome();
  else if (Keys.is(e, 'cancel')) { if (e.altKey) return; if (mode) setMode(null); else { bsel = null; setSel([], false); } }
});

// Hold a spawn button to keep spawning (touch-friendly; the first spawn still comes from the click).
const SPAWN_UNITS = typeof UnitArt !== 'undefined' ? UnitArt.UNITS.map(u => u.id) : ['worker', 'soldier']; // unit-art.js
for (const [id, unit] of SPAWN_UNITS.map(u => [`b-${u}`, u])) {
  const b = $(id);
  b.style.touchAction = 'manipulation'; b.style.userSelect = 'none'; b.style.webkitUserSelect = 'none';
  let timer = null, held = false;
  const stop = () => { clearTimeout(timer); clearInterval(timer); timer = null; };
  b.addEventListener('pointerdown', () => {
    stop(); held = false;
    const spawn = () => send({ type: 'spawn', unit, ...producerMsg() }); // from the selected producer (else the nest)
    timer = setTimeout(() => { held = true; spawn(); timer = setInterval(spawn, 180); }, 400);
  });
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(ev, stop);
  b.addEventListener('contextmenu', e => e.preventDefault());
  // After a hold, swallow the click that follows so it doesn't spawn one extra.
  addEventListener('click', e => { if (held && e.target.closest && e.target.closest('#' + id)) { held = false; e.stopImmediatePropagation(); e.preventDefault(); } }, true);
}

// The prompt line above the spawn buttons: "N workers · M soldiers selected" (only when there is no selection
// panel, panel.js shows the counts by caste), plus what a pending click will do. Abilities and build mode
// put their own prompt here through Orders.setPrompt(), so every "click the board next" mode reads the same way.
const readout = document.createElement('div');
readout.id = 'sel-readout';
// Sits above the upgrade bar (#hud-upgrades, bottom 74px) so the two never overlap.
readout.style.cssText = 'position:fixed;bottom:122px;left:50%;transform:translateX(-50%);padding:5px 14px;font-size:13px;display:none;gap:10px;align-items:center;white-space:nowrap;user-select:none;z-index:5';
document.body.appendChild(readout);
let extPrompt = null; // { html, cancel } from abilities.js / structures.js
readout.addEventListener('click', () => { if (extPrompt) extPrompt.cancel(); else if (mode) setMode(null); else setSel([], false); }); // tap to cancel/deselect on touch screens
// Pure: what the line says. Exported for tests (promptText). hasPanel: panel.js shows the counts (and the fire/move
// states as buttons), so skip them; `states` is the "Fire at will · Maneuver" text shown when there is no panel.
function promptText(selCounts, mode, ext, hasPanel, states) {
  const parts = [];
  if (ext) parts.push(ext);
  else if (mode) parts.push(`<b style="color:${KIND_COLOR[mode]}">${MODE_TEXT[mode]}</b>`);
  if (!hasPanel && selCounts && selCounts.total) parts.push(`${selCounts.workers} worker${selCounts.workers === 1 ? '' : 's'} · ${selCounts.fighters} fighter${selCounts.fighters === 1 ? '' : 's'} selected`);
  if (!hasPanel && states) parts.push(states);
  return parts.join(' · ');
}
function updateReadout() {
  pruneSel();
  const hasPanel = typeof Panel !== 'undefined' && !!Panel;
  if ((!extPrompt && !mode && (!sel.size || hasPanel)) || !canCommand()) { readout.style.display = 'none'; return; }
  const p = curr.ants.filter(a => sel.has(a[0]));
  const w = p.filter(a => !a[2]).length;
  const states = sel.size && !hasPanel ? `${FIRE_NAMES[stateOf('fire')]} · ${MOVE_NAMES[stateOf('move')]}` : ''; // the panel shows them as buttons
  const text = promptText({ total: p.length, workers: w, fighters: p.length - w }, mode, extPrompt && extPrompt.html, hasPanel, states);
  if (!text) { readout.style.display = 'none'; return; }
  const html = `${text} <b data-tip="${extPrompt || mode ? 'Cancel [Esc]' : 'Deselect [Esc]'}" style="cursor:pointer;opacity:.7">✕</b>`;
  if (readout.innerHTML !== html) readout.innerHTML = html;
  readout.style.display = 'flex';
}
let lastT = 0;
setInterval(() => { // ants die and spawn between clicks; a new match reuses ant ids, so forget old picks
  if (curr && curr.t < lastT) { sel.clear(); bsel = null; plans.clear(); seenAnts.clear(); for (const k in groups) delete groups[k]; setMode(null); }
  if (curr) lastT = curr.t;
  syncAutogroups();
  updateReadout();
}, 250);

// ---------- Drawing hooks (called from client.js frame) ----------
// A world-space circle of radius r around screen point c, as the ellipse the iso projection makes of it.
function isoEllipse(c, r) { ctx.beginPath(); ctx.ellipse(c.x, c.y, r * 32 * Math.SQRT2 * scale, r * 16 * Math.SQRT2 * scale, 0, 0, Math.PI * 2); }

const groupDigits = () => { const m = new Map(); for (const d of Object.keys(groups)) for (const id of groups[d]) m.set(id, d); return m; }; // ant id -> group digit
function drawSelectionRings(now) {
  if (typeof UIWorld !== 'undefined' && curr) { // ant19/ui-world: batched rings in the bug-tech look, hover ring under the cursor
    const list = [], cur = UIWorld.cursor();
    if (sel.size) for (const a of lerpAnts(now)) {
      if (!sel.has(a[0])) continue;
      const c = toScreen(a[3], a[4]);
      list.push({ x: c.x, y: c.y, k: scale * (a[2] ? 1.45 : 1), tick: KIND_COLOR[kindOf(a)] });
    }
    UIWorld.rings(ctx, list, { now });
    const h = cur && !drag && typeof antAt === 'function' ? antAt(cur.x, cur.y, 10) : null;
    if (h && !sel.has(h[0])) { const c = toScreen(h[3], h[4]); UIWorld.rings(ctx, [{ x: c.x, y: c.y, k: scale * (h[2] ? 1.45 : 1) }], { color: UIWorld.INK_DIM, alpha: 0.8, noTicks: true, now }); }
    return;
  }
  if (!sel.size || !curr) return;
  const badge = groupDigits(), fs = Math.max(8, Math.round(9 * scale));
  for (const a of lerpAnts(now)) {
    if (!sel.has(a[0])) continue;
    const c = toScreen(a[3], a[4]), k = scale * (a[2] ? 1.45 : 1);
    ctx.strokeStyle = KIND_COLOR[kindOf(a)] || 'rgba(255,255,255,.9)';
    ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.ellipse(c.x, c.y, 10 * k, 5 * k, 0, 0, Math.PI * 2); ctx.stroke();
    const d = badge.get(a[0]); // digit of the control group this selected ant belongs to
    if (d && ctx.fillText) {
      ctx.font = `bold ${fs}px sans-serif`; ctx.textAlign = 'center'; ctx.lineWidth = 2.5; ctx.strokeStyle = 'rgba(20,14,8,.85)'; ctx.fillStyle = '#fff';
      ctx.strokeText(d, c.x, c.y - 17 * k); ctx.fillText(d, c.x, c.y - 17 * k); ctx.textAlign = 'start';
    }
  }
  ctx.lineWidth = 1;
}

// Forget plan steps the ant has finished, and whole plans for ants that went idle or died.
function prunePlans(ants) {
  const byId = new Map(ants.map(a => [a[0], a]));
  for (const [id, p] of plans) {
    const a = byId.get(id), k = a && kindOf(a);
    if (!a || !k || k === 'guard' || k === 'hold') { plans.delete(id); continue; }
    // The server moved on to the next stop: its kind changed, or the ant reached a same-kind waypoint.
    while (p.length > 1 && ((p[0].kind !== k && p[1].kind === k) ||
      (p[0].kind === k && (k === 'move' || k === 'attack') && !p[0].target && Math.hypot(a[3] - p[0].x, a[4] - p[0].y) < p[0].r))) p.shift();
  }
}

// Waypoint lines for the selected ants: ant -> each queued stop, dotted, coloured by order.
function drawPlans(ants) {
  ctx.setLineDash && ctx.setLineDash([4 * scale, 4 * scale]);
  ctx.lineWidth = 1.2;
  for (const a of ants) {
    const p = sel.has(a[0]) && plans.get(a[0]);
    if (!p) continue;
    let from = toScreen(a[3], a[4]);
    for (const st of p) {
      const tgt = st.target && ants.find(b => b[0] === st.target);
      if (!tgt && !Number.isFinite(st.x)) continue; // a follow whose leader is out of sight
      const to = tgt ? toScreen(tgt[3], tgt[4]) : toScreen(st.x, st.y);
      ctx.strokeStyle = KIND_COLOR[st.kind] || KIND_COLOR.move; ctx.globalAlpha = 0.55;
      ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y);
      if (st.kind === 'patrol') { const b = toScreen(st.ax, st.ay); ctx.moveTo(to.x, to.y); ctx.lineTo(b.x, b.y); }
      ctx.stroke();
      ctx.globalAlpha = 0.8; ctx.fillStyle = ctx.strokeStyle;
      ctx.beginPath(); ctx.arc(to.x, to.y, 2.2 * scale, 0, Math.PI * 2); ctx.fill();
      from = to;
    }
  }
  ctx.setLineDash && ctx.setLineDash([]);
  ctx.globalAlpha = 1; ctx.lineWidth = 1;
}

// Who is fighting whom: a thin line from each selected ant to its current target, and a pulsing ring under every
// ant the selection is attacking, so a focus-fire order (or a chase gone wrong) is visible at a glance.
function drawTargets(ants, now) {
  if (!sel.size) return;
  const byId = new Map(ants.map(a => [a[0], a]));
  const foes = new Map(); // foe id -> ant
  ctx.lineWidth = 1; ctx.strokeStyle = KIND_COLOR.attack; ctx.globalAlpha = 0.45;
  ctx.beginPath();
  for (const a of ants) {
    if (!sel.has(a[0]) || !a[FOE_IDX]) continue;
    const f = byId.get(a[FOE_IDX]);
    if (!f) continue;
    const from = antScreen(a), to = antScreen(f);
    ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y);
    foes.set(f[0], f);
  }
  ctx.stroke();
  const pulse = 0.85 + 0.15 * (globalThis.motionSin || Math.sin)(now / 90);
  ctx.globalAlpha = 0.9; ctx.lineWidth = 1.5;
  for (const f of foes.values()) {
    const c = toScreen(f[3], f[4]), k = scale * unitSize(f[2]) * pulse;
    ctx.beginPath(); ctx.ellipse(c.x, c.y, 9 * k, 4.5 * k, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); // four ticks around the ring
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { ctx.moveTo(c.x + dx * 9 * k, c.y + dy * 4.5 * k); ctx.lineTo(c.x + dx * 13 * k, c.y + dy * 7 * k); }
    ctx.stroke();
  }
  ctx.globalAlpha = 1; ctx.lineWidth = 1;
}

function drawInputOverlay(now) {
  if (curr && mySide >= 0) {
    const ants = lerpAnts(now);
    prunePlans(curr.ants);
    drawPlans(ants);
    drawTargets(ants, now);
  }
  marks = marks.filter(m => now - m.at < 650);
  for (const m of marks) { // click marker: a shrinking ring (plus an X for attack orders, a circle for areas, a line for formations)
    const c = toScreen(m.x, m.y), t = (now - m.at) / 650, r = 1 - t * 0.6;
    ctx.strokeStyle = m.color; ctx.globalAlpha = 1 - t * t; ctx.lineWidth = 2;
    if (m.r) { isoEllipse(c, m.r); ctx.stroke(); }
    else if (m.line) { const a = toScreen(m.line[0], m.line[1]), b = toScreen(m.line[2], m.line[3]); ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
    else { ctx.beginPath(); ctx.ellipse(c.x, c.y, 14 * r * scale, 7 * r * scale, 0, 0, Math.PI * 2); ctx.stroke(); }
    if (m.cross) {
      const d = 5 * r * scale;
      ctx.beginPath(); ctx.moveTo(c.x - d, c.y - d / 2); ctx.lineTo(c.x + d, c.y + d / 2); ctx.moveTo(c.x + d, c.y - d / 2); ctx.lineTo(c.x - d, c.y + d / 2); ctx.stroke();
    }
  }
  ctx.globalAlpha = 1; ctx.lineWidth = 1;
  if (drag && drag.moved && drag.button === 0 && !mode) {
    ctx.fillStyle = 'rgba(157,255,138,.1)'; ctx.strokeStyle = 'rgba(157,255,138,.8)';
    ctx.fillRect(drag.sx, drag.sy, drag.ex - drag.sx, drag.ey - drag.sy);
    ctx.strokeRect(drag.sx, drag.sy, drag.ex - drag.sx, drag.ey - drag.sy);
  } else if (drag && drag.moved && drag.button === 0 && mode === 'attack') { // area attack preview
    const c = screenToWorld(drag.sx, drag.sy), e = screenToWorld(drag.ex, drag.ey), r = Math.min(AREA_MAX, Math.hypot(e.x - c.x, e.y - c.y));
    ctx.strokeStyle = KIND_COLOR.attack; ctx.fillStyle = 'rgba(255,90,74,.12)'; ctx.lineWidth = 2;
    isoEllipse({ x: drag.sx, y: drag.sy }, r); ctx.fill(); ctx.stroke();
    ctx.lineWidth = 1;
  } else if (drag && drag.moved && drag.button === 2 && !mode && sel.size) { // formation line preview
    ctx.strokeStyle = '#ff9a4a'; ctx.lineWidth = 2; ctx.setLineDash && ctx.setLineDash([6, 4]);
    ctx.beginPath(); ctx.moveTo(drag.sx, drag.sy); ctx.lineTo(drag.ex, drag.ey); ctx.stroke();
    ctx.setLineDash && ctx.setLineDash([]); ctx.lineWidth = 1;
    if (curr && mySide >= 0) { // one dot per selected ant at the spot the server will give it
      const a = screenToWorld(drag.sx, drag.sy), b = screenToWorld(drag.ex, drag.ey), cl = v => Math.max(0, Math.min(curr.map, v));
      const pts = curr.ants.filter(t => sel.has(t[0])).map(t => ({ x: t[3], y: t[4] }));
      ctx.fillStyle = '#ff9a4a'; ctx.globalAlpha = 0.85;
      for (const s of lineSlots(pts, [cl(a.x), cl(a.y), cl(b.x), cl(b.y)], curr.map)) { const c = toScreen(s.x, s.y); ctx.beginPath(); ctx.arc(c.x, c.y, 2.4 * scale, 0, Math.PI * 2); ctx.fill(); }
      ctx.globalAlpha = 1;
    }
  }
}

// ---------- Public API for other UI (selection panel buttons, minimap clicks) ----------
// Points are world tiles { x, y }. Every call is a no-op when this player can't command right now.
const guard = f => (...args) => (canCommand() ? f(...args) : undefined);
globalThis.Orders = { // window.Orders in the browser
  selected: () => [...sel],
  groups: () => Object.fromEntries(Object.keys(groups).map(d => [d, liveGroup(d)]).filter(([, v]) => v.length)), // digit -> live ant ids
  autoGroups: () => ({ ...autoGroup }),
  select: guard((ids, add) => setSel(ids.filter(id => curr.ants.some(a => a[0] === id && a[1] === mySide)), add)),
  deselect: () => { bsel = null; setSel([], false); },
  building: () => buildingInfo(), // the selected building (nest / structure) or null: { kind, id, name, hp, done, producer, rally, forage, ... }
  selectBuilding: guard(b => { selectBuilding(b && (b.kind === 'nest' || (b.kind === 'struct' && myStruct(b.id))) ? b : null); }),
  buildingAt: w => buildingAt(w),
  buildingOrder: guard(w => buildingOrder(w)), // what a right-click at w does with a producer selected
  clearForage: guard(clearForage),
  spawnFrom: producerMsg, // {} (the nest) or { from: outpost id }: spread into a spawn message
  stop: guard(() => simple('stop')),
  hold: guard(() => simple('hold')),
  auto: guard(() => simple('auto')),
  home: guard(goHome),
  attackMove: guard((w, queue, area) => attackMove(w, queue, null, area)),
  patrol: guard((w, queue) => patrol(w, queue)),
  move: guard((w, queue) => { const { all } = picked(); sendOrder(all, 'move', w, queue ? { queue: true } : undefined); mark(w, KIND_COLOR.move); }),
  follow: guard((id, queue) => { const t = curr.ants.find(a => a[0] === id); if (t) smartOrder({ x: t[3], y: t[4] }, t, false, queue); }),
  smart: guard((w, queue) => smartOrder(w, null, false, queue)), // what a right-click at w would do
  line: guard((line, queue, ctrl) => smartOrder({ x: (line[0] + line[2]) / 2, y: (line[1] + line[3]) / 2 }, null, !!ctrl, queue, line)), // formation line [x1, y1, x2, y2]
  state: which => stateOf(which), // 'fire' | 'move' -> 0..2, or -1 with nothing selected
  setState: guard((which, v) => setState(which === 'fire' ? 'fire' : 'move', v)),
  cycleState: guard(which => cycleState(which === 'fire' ? 'fire' : 'move')),
  pref: () => prefOf(), setPref: guard(v => setPref(v)), // target priority dropdown (panel.js)
  FIRE_NAMES, MOVE_NAMES,
  mode: () => mode,
  setMode: guard(m => setMode(m === 'attack' || m === 'patrol' ? m : null)), // wait for a map click
  cancelMode: () => setMode(null),
  // Another layer's "click the board next" prompt (abilities, build mode): html and what its ✕ / Esc does. null clears it.
  setPrompt: (html, cancel) => { extPrompt = html ? { html, cancel: cancel || (() => {}) } : null; updateReadout(); },
  promptText,
  hurt: () => hurtFighters(curr.ants, mySide), // fighter ids under HURT_PCT
  idle: () => idleFighters(curr.ants, mySide), // idle fighter ids (no order or guard, no foe)
  cycleIdle: guard(all => cycleIdle(!!all)),
  smartKind: (w, target, line) => smartKind(w, target, !!line), lineSlots, // pure helpers, for tests and the panel
};
