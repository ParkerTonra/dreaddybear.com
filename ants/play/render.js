// Ant Arena renderer: the board, nests, food piles, ants and the depth-sorted world pass.
// Loaded right after client.js and uses its globals (ctx, curr, scale, toScreen, screenAngle, hash,
// lerpAnts, pixelRatio, COLORS, DARK, drawAnteater, drawBeetle). Everything goes through toScreen(),
// so a camera that pans or zooms there needs no changes here.
// What makes it cheap enough for 60 fps with 240 ants on a laptop or phone:
//   - the board is painted once into an offscreen layer and blitted each frame (repainted on zoom/flip),
//   - ants are stamped from per-colony sprite atlases (gait x antenna x pose cells) with one drawImage each,
//     and all their shadows go in one path,
//   - food piles and nests are cached per state (amount, damage) and only repainted when that changes,
//   - the depth sort packs (screen y, item) into one Float64Array: no closures or objects per frame.
// Ants also turn smoothly toward their heading and their legs advance with the distance they walk.

// A 1000-ant crowd zoomed in needs ~200 MB of cells at once (4 colonies x 6 castes x 8 headings, ~40 KB a cell at 4x): under a 48 MB cap
// every frame evicted pages it had to repaint. Phones and low-memory machines keep 48 MB; the rest get room for the working set.
function atlasCapBytes() {
  const dm = typeof navigator !== 'undefined' && navigator.deviceMemory ? navigator.deviceMemory : 4;
  return (dm >= 8 ? 192 : dm >= 4 ? 96 : 48) * 1024 * 1024;
}
const RenderCfg = {
  GAIT: 9, // leg poses across one stride
  ANTENNA: 3, // antenna wiggle poses
  TURN_RATE: 16, // 1/s: ants close ~65% of a heading change in 1/16 s, so 15 Hz direction steps never snap
  STRIDE: 14, // gait radians per tile walked
  MAX_LAYER_PX: 4096 * 4096, // bigger board layers (extreme zoom) are drawn directly instead
  HEADINGS: 8, // heading bins per ant atlas: each bakes the light for its heading (ant18 unit-look)
  ATLAS_CAP: atlasCapBytes(), // bytes of ant atlas canvases kept (tiered by device memory); the least recently stamped heading pages go first
  PAINT_BUDGET: 16, // sprite cells painted per frame while older-scale atlases can stand in (a zoom step)
  PREV_DEPTH: 3, // older atlas generations kept as stand-ins
  REBAKE_MS: 250, // nests and food piles keep their old-scale sprite until the scale has held this long
  ZOOM_HOLD_MS: 140, // no new-scale cells are painted while the scale moved within this long (older-scale cells stand in), then PAINT_BUDGET per frame
  STALE_MS: 1500, // free them this long after the last scale step
};
const Render = {
  makeCanvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; },
  ground: null, // { key, canvas, w, h, minX, minY } board layer
  q: 0, // device px per world unit the sprites were painted at (quantized, so zooming reuses them)
  atlases: new Map(), // colony * 16 + type -> ant atlas { pages[heading bin] }
  atlasBytes: 0, // sum of the live atlas page canvases (RGBA bytes)
  stale: new Map(), // id -> the previous scale's atlas (linked on through .prev) while zoom steps are still settling
  budget: 1e9, rebakes: 1, qAt: 0, zoomAt: -1e9, lastScale: 0, src: null, // cells left to paint this frame; time of the last scale step; atlas antSrc picked
  foods: new Map(), // food id -> { key, canvas, half }
  nests: new Map(), // `${colony}` -> { key, canvas, ... }
  ants: new Map(), // id -> { ang, walk, x, y, spd, f } smoothed per-ant motion
  seed: null, frameNo: 0, lastNow: 0,
  keys: new Float64Array(512),
  stats: { groundPaints: 0, spritePaints: 0, atlasEvicts: 0, ms: { nest: 0, food: 0, cell: 0 } }, // ms: time spent baking, by kind (ant78 zoom-lag attribution)
};

// Sprite resolution: steps of 2^(1/8) (~9%) so a zooming camera repaints sprites rarely, never every frame.
function renderSpriteQ() { return 2 ** (Math.round(Math.log2(Math.max(0.05, scale) * pixelRatio()) * 8) / 8); }

// After a q step the old atlases stay linked (A.prev, up to PREV_DEPTH generations) so ants are stamped from them, scaled by
// stampAnt, while the new atlas fills at PAINT_BUDGET cells per frame. A big crowd used to repaint 150-190 cells in the one frame
// after each step (20-40 ms of script, 50-100 ms gaps while zooming). The stale generations are freed once zooming settles.
function renderFreeAtlas(A) { let b = 0; for (const P of A.pages) if (P) { if (!P.shared) P.canvas.width = 0; b += P.bytes; } A.pages.fill(null); return b; } // returns the bytes freed
function renderSyncSprites() {
  const q = renderSpriteQ(), now = typeof performance !== 'undefined' ? performance.now() : 0;
  const moved = Render.lastScale > 0 && Math.abs(scale - Render.lastScale) > Render.lastScale * 5e-4; Render.lastScale = scale;
  if (moved) Render.zoomAt = now;
  Render.budget = now - Render.zoomAt < RenderCfg.ZOOM_HOLD_MS ? 0 : RenderCfg.PAINT_BUDGET; // while the zoom moves, painting a cell flushes the canvas pipeline mid-frame (25-50 ms frames): stand in, paint after
  Render.rebakes = now - Render.qAt > RenderCfg.REBAKE_MS ? 1 : 0; // nests and food piles re-bake for a new q once zooming pauses, one per frame; drawn scaled meanwhile
  if (q !== Render.q) {
    Render.q = q; Render.qAt = now;
    const old = Render.atlases; Render.atlases = new Map(); Render.atlasBytes = 0;
    for (let [id, A] of old) { // keep a short chain of older generations per atlas; free what falls off the end
      // A generation that never painted a cell (a q step during a fast zoom, painting held off) has nothing to stand in with: skip
      // it, or three such steps in a row would push every useful older generation off the chain and force a repaint burst.
      if (!A.n && A.prev) { const E = A; A = A.prev; renderFreeAtlas(E); }
      let d = 1, B = A; while (B.prev && d < RenderCfg.PREV_DEPTH) { B = B.prev; d++; }
      if (B.prev) { renderFreeAtlas(B.prev); B.prev = null; }
      Render.stale.set(id, A);
    }
    for (const [id, A] of Render.stale) if (!old.has(id)) { for (let B = A; B; B = B.prev) renderFreeAtlas(B); Render.stale.delete(id); } // nothing stamped it this generation
  } else if (Render.stale.size && now - Render.qAt > RenderCfg.STALE_MS) {
    for (const A of Render.stale.values()) for (let B = A; B; B = B.prev) renderFreeAtlas(B);
    Render.stale.clear();
    for (const A of Render.atlases.values()) A.prev = null;
  }
  if (Render.atlasBytes > RenderCfg.ATLAS_CAP) renderTrimAtlases();
  if (curr.seed !== Render.seed) { Render.seed = curr.seed; Render.ants.clear(); Render.foods.clear(); }
}

// ---------- Board layer ----------
function drawTile(x, y, seed, players, g = ctx) {
  const p0 = toScreen(x, y), p1 = toScreen(x + 1, y), p2 = toScreen(x + 1, y + 1), p3 = toScreen(x, y + 1);
  const n = hash(x, y, seed);
  let nearNest = Infinity;
  for (const q of players) nearNest = Math.min(nearNest, Math.hypot(x + .5 - q.nest.x, y + .5 - q.nest.y));
  let r, gr, b;
  if (nearNest < 2.4 + n) { r = 122 + n * 20; gr = 92 + n * 15; b = 58; } // packed dirt around nests
  else { r = 70 + n * 30; gr = 112 + n * 35; b = 52 + n * 15; }
  g.fillStyle = `rgb(${r|0},${gr|0},${b|0})`;
  g.beginPath(); g.moveTo(p0.x, p0.y); g.lineTo(p1.x, p1.y); g.lineTo(p2.x, p2.y); g.lineTo(p3.x, p3.y);
  g.closePath(); g.fill();
  g.strokeStyle = 'rgba(0,0,0,0.08)'; g.stroke();
  if (n > 0.86) { // tufts of grass
    const c = toScreen(x + .5, y + .5);
    g.strokeStyle = 'rgba(40,80,30,0.7)'; g.lineWidth = 1.5 * scale;
    for (let i = -1; i <= 1; i++) { g.beginPath(); g.moveTo(c.x + i * 4 * scale, c.y); g.lineTo(c.x + i * 6 * scale, c.y - 8 * scale); g.stroke(); }
    g.lineWidth = 1;
  }
}

function drawBoardEdge(map, g = ctx) {
  // Pick the two visible bottom edges after any flip.
  const all = [toScreen(0, 0), toScreen(map, 0), toScreen(map, map), toScreen(0, map)];
  const bottom = all.reduce((a, b) => (b.y > a.y ? b : a));
  const i = all.indexOf(bottom);
  const left = all[(i + 1) % 4].x < bottom.x ? all[(i + 1) % 4] : all[(i + 3) % 4];
  const right = left === all[(i + 1) % 4] ? all[(i + 3) % 4] : all[(i + 1) % 4];
  const d = 14 * scale;
  g.fillStyle = '#4a3522';
  g.beginPath(); g.moveTo(left.x, left.y); g.lineTo(bottom.x, bottom.y); g.lineTo(bottom.x, bottom.y + d); g.lineTo(left.x, left.y + d); g.fill();
  g.fillStyle = '#3a2819';
  g.beginPath(); g.moveTo(right.x, right.y); g.lineTo(bottom.x, bottom.y); g.lineTo(bottom.x, bottom.y + d); g.lineTo(right.x, right.y + d); g.fill();
}

function paintBoard(map, g) {
  drawBoardEdge(map, g);
  for (let x = 0; x < map; x++) for (let y = 0; y < map; y++) drawTile(x, y, curr.seed, curr.players, g);
  if (window.TerrainDraw) TerrainDraw.ground(g, toScreen, scale, curr); // mud (terrain-draw.js)
}

// The board only changes when the projection's scale/orientation, the map or the nests change. Its layer is
// cached relative to toScreen(0, 0), so a pure pan just blits it somewhere else.
function drawGround(map) {
  // ant18/ground: terrain-draw.js owns the board layer (texture, cliff edge, shadows, tint), cached per density.
  if (window.TerrainDraw && TerrainDraw.drawBoard && TerrainDraw.drawBoard(ctx, curr, { toScreen, scale, dpr: pixelRatio(), makeCanvas: Render.makeCanvas, stats: Render.stats, viewW: innerWidth, viewH: innerHeight })) return;
  const o = toScreen(0, 0), ux = toScreen(1, 0), uy = toScreen(0, 1);
  const ax = ux.x - o.x, ay = ux.y - o.y, bx = uy.x - o.x, by = uy.y - o.y;
  let minX = Math.min(0, ax, bx, ax + bx) * map, maxX = Math.max(0, ax, bx, ax + bx) * map;
  let minY = Math.min(0, ay, by, ay + by) * map, maxY = Math.max(0, ay, by, ay + by) * map;
  minX -= 2; maxX += 2; minY -= 10 * scale + 2; maxY += 14 * scale + 2; // grass tufts above, the dirt edge below
  const dpr = pixelRatio();
  const w = Math.ceil((maxX - minX) * dpr) + 2, h = Math.ceil((maxY - minY) * dpr) + 2;
  if (w * h > RenderCfg.MAX_LAYER_PX || !(w > 0 && h > 0)) { paintBoard(map, ctx); return; }
  const key = [curr.seed, map, dpr, ax.toFixed(4), ay.toFixed(4), bx.toFixed(4), by.toFixed(4), w, h, curr.players.map(p => `${p.nest.x},${p.nest.y}`).join(';'),
    window.TerrainDraw ? TerrainDraw.rocks(curr).length : 0].join('|'); // repaint once the terrain string arrives
  let L = Render.ground;
  // Snap the layer's corner to a device pixel so the blit is 1:1 (crisp tile edges).
  const left = Math.floor((o.x + minX) * dpr) / dpr, top = Math.floor((o.y + minY) * dpr) / dpr;
  if (!L || L.key !== key) {
    const reuse = L && L.canvas.width === w && L.canvas.height === h, canvas = reuse ? L.canvas : Render.makeCanvas(w, h);
    if (L && !reuse) L.canvas.width = 0; // ant75: free the replaced layer now (see TerrainDraw releaseCanvas)
    const g = canvas.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, w, h);
    g.setTransform(dpr, 0, 0, dpr, -left * dpr, -top * dpr);
    paintBoard(map, g);
    L = Render.ground = { key, canvas, w, h };
    Render.stats.groundPaints++;
  }
  ctx.drawImage(L.canvas, left, top, L.w / dpr, L.h / dpr);
}

// ---------- Nests ----------
// Cracks spread across the mound as the nest loses HP (deterministic per colony).
function drawNestCracks(c, s, dmg, side, g = ctx) {
  if (dmg < 0.1) return;
  g.strokeStyle = 'rgba(40,24,10,.85)'; g.lineWidth = 1.6 * s; g.lineCap = 'round';
  const n = Math.min(7, Math.ceil(dmg * 8));
  g.beginPath();
  for (let i = 0; i < n; i++) {
    const a = Math.PI * (1.05 + hash(side, i, 31) * 0.9); // upper half of the dome
    let x = c.x + Math.cos(a) * 12 * s, y = c.y - 14 * s + Math.sin(a) * 6 * s;
    g.moveTo(x, y);
    const len = 3 + Math.round(dmg * 3);
    for (let j = 0; j < len; j++) {
      const b = a + (hash(i, j, side + 40) - .5) * 1.4;
      x += Math.cos(b) * 5 * s; y += Math.sin(b) * 3 * s + 1.2 * s;
      g.lineTo(x, y);
    }
  }
  g.stroke();
  g.lineWidth = 1; g.lineCap = 'butt';
}

// Mound, hole, cracks and flag at sprite scale s, centred on c. The hp bar and hit flash are drawn live.
function paintNest(g, c, s, p, side) {
  if (window.WorldArt) return WorldArt.nest(g, c, s, p, side, drawNestCracks); // ant18/ground: mound with vents
  g.fillStyle = 'rgba(0,0,0,.22)'; // ground shadow
  g.beginPath(); g.ellipse(c.x + 4 * s, c.y + 4 * s, 50 * s, 24 * s, 0, 0, Math.PI * 2); g.fill();
  if (!p.alive) { // collapsed mound, no flag
    g.fillStyle = '#5c4630';
    g.beginPath(); g.ellipse(c.x, c.y, 40 * s, 18 * s, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#2a1d12';
    for (const [dx, dy] of [[-14, -2], [8, 3], [18, -5]]) { g.beginPath(); g.ellipse(c.x + dx * s, c.y + dy * s, 6 * s, 3 * s, 0, 0, Math.PI * 2); g.fill(); }
    return;
  }
  g.fillStyle = '#8a6438';
  g.beginPath(); g.ellipse(c.x, c.y, 46 * s, 24 * s, 0, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#a57a47';
  g.beginPath(); g.ellipse(c.x, c.y - 10 * s, 34 * s, 22 * s, 0, Math.PI, 0); g.ellipse(c.x, c.y - 10 * s, 34 * s, 10 * s, 0, 0, Math.PI); g.fill();
  g.fillStyle = '#1a120a';
  g.beginPath(); g.ellipse(c.x, c.y - 16 * s, 9 * s, 5 * s, 0, 0, Math.PI * 2); g.fill();
  drawNestCracks(c, s, 1 - p.nest.hp / p.nest.max, side, g);
  // banner
  g.strokeStyle = '#2b1d10'; g.lineWidth = 2 * s;
  g.beginPath(); g.moveTo(c.x + 22 * s, c.y - 12 * s); g.lineTo(c.x + 22 * s, c.y - 52 * s); g.stroke();
  g.fillStyle = COLORS[side];
  g.beginPath(); g.moveTo(c.x + 22 * s, c.y - 52 * s); g.lineTo(c.x + 44 * s, c.y - 45 * s); g.lineTo(c.x + 22 * s, c.y - 38 * s); g.fill();
  g.lineWidth = 1;
}

function nestSprite(p, side) {
  const q = Render.q, dmg = 1 - p.nest.hp / p.nest.max;
  const key = (window.BuildingArt ? BuildingArt.ver + '|' : '') + (p.alive ? (dmg < 0.1 ? 'ok' : `${Math.min(7, Math.ceil(dmg * 8))}:${Math.round(dmg * 3)}`) : 'dead');
  let S = Render.nests.get(side);
  if (S && S.key === key && (S.q === q || Render.rebakes <= 0)) return S;
  Render.rebakes--;
  const tb = performance.now();
  const nb = window.WorldArt ? WorldArt.NEST_BOX : { L: 54, R: 56, T: 56, B: 30 }; // ant18/ground: room for the long shadow
  const L = Math.ceil(nb.L * q) + 2, R = Math.ceil(nb.R * q) + 2, T = Math.ceil(nb.T * q) + 2, B = Math.ceil(nb.B * q) + 2;
  if (S) S.canvas.width = 0; // ant75: the old bake goes now, not at the next GC
  S = { key, q, canvas: Render.makeCanvas(L + R, T + B), ox: L / q, oy: T / q, w: (L + R) / q, h: (T + B) / q };
  paintNest(S.canvas.getContext('2d'), { x: L, y: T }, q, p, side);
  Render.nests.set(side, S);
  Render.stats.spritePaints++; Render.stats.ms.nest += performance.now() - tb;
  return S;
}

function drawNest(p, side, now = performance.now()) {
  const c = toScreen(p.nest.x, p.nest.y);
  const s = scale;
  const fx = window.FX;
  const shake = fx && !(window.Settings && Settings.reduced()) ? fx.nestShake(side, now) : 0; // ant18: Reduced motion
  if (shake) c.x += Math.sin(now / 18) * 3 * s * shake;
  if (fx) fx.nestSmoke(side, p, now);
  const S = nestSprite(p, side);
  ctx.drawImage(S.canvas, c.x - S.ox * s, c.y - S.oy * s, S.w * s, S.h * s);
  if (window.WorldArt) WorldArt.nestGlow(ctx, c, s, side, p, now); // ant18/ground: live vent glow
  if (!p.alive) return;
  const hole = window.WorldArt ? WorldArt.nestHole() : [0, -16];
  const glow = fx && fx.nestGlow && !(window.Settings && Settings.reduced()) ? fx.nestGlow(side, now) : 0; // ant18 feel-anim: the hole brightens as an ant crawls out
  if (glow) { ctx.fillStyle = `rgba(255,214,120,${(glow * .4).toFixed(3)})`; ctx.beginPath(); ctx.ellipse(c.x + hole[0] * s, c.y + hole[1] * s, 9 * s, 5 * s, 0, 0, Math.PI * 2); ctx.fill(); }
  if (shake) { ctx.fillStyle = `rgba(255,240,200,${(shake * .35).toFixed(3)})`; ctx.beginPath(); ctx.ellipse(c.x, c.y - 10 * s, 34 * s, 22 * s, 0, Math.PI, 0); ctx.fill(); }
  // hp bar
  const w = 70 * s, frac = p.nest.hp / p.nest.max;
  if (window.UIWorld) { UIWorld.hpBar(ctx, c.x - w / 2, c.y - 70 * s, w, 7 * s, frac, COLORS[side], { chamfer: true, quarters: true }); return; } // ant19/ui-world
  ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillRect(c.x - w / 2, c.y - 70 * s, w, 7 * s);
  ctx.fillStyle = COLORS[side]; ctx.fillRect(c.x - w / 2, c.y - 70 * s, w * frac, 7 * s);
}

// ---------- Food piles ----------
function paintFood(g, c, s, f) {
  if (window.WorldArt) return WorldArt.food(g, c, s, f); // ant18/ground: glowing pellets
  const amt = f[3];
  // Pile footprint and crumb count both shrink as ants haul food away.
  const spread = (5 + Math.min(11, Math.sqrt(amt) * 1.1)) * s;
  const n = Math.min(16, Math.ceil(Math.sqrt(amt) * 1.4));
  const sz = 0.7 + Math.min(0.5, amt / 160);
  g.fillStyle = 'rgba(0,0,0,.2)';
  g.beginPath(); g.ellipse(c.x + 2 * s, c.y + 2 * s, spread + 4 * s, (spread + 4 * s) * .45, 0, 0, Math.PI * 2); g.fill();
  g.strokeStyle = 'rgba(40,50,10,.6)'; g.lineWidth = s / scale;
  for (let i = 0; i < n; i++) {
    const a = hash(f[0], i, 7) * Math.PI * 2, r = hash(i, f[0], 9) * spread;
    const lift = (1 - r / spread) * Math.min(6, amt / 15) * s; // taller in the middle of a big pile
    g.fillStyle = i % 3 ? '#a8e05e' : '#f0d86a';
    g.beginPath(); g.ellipse(c.x + Math.cos(a) * r, c.y + Math.sin(a) * r * .5 - 2 * s - lift, 4.5 * s * sz, 3.4 * s * sz, a, 0, Math.PI * 2); g.fill(); g.stroke();
  }
}

function drawFood(f) {
  const c = toScreen(f[1], f[2]);
  const q = Render.q;
  let S = Render.foods.get(f[0]);
  if (!S || S.amt !== f[3] || (S.q !== q && Render.rebakes > 0)) {
    if (S && S.amt === f[3]) Render.rebakes--;
    const tb = performance.now();
    const half = Math.ceil((window.WorldArt ? 36 : 30) * q) + 2;
    const same = S && S.canvas.width === half * 2, canvas = same ? S.canvas : Render.makeCanvas(half * 2, half * 2);
    if (S && !same) S.canvas.width = 0; // ant75
    const g = canvas.getContext('2d');
    g.clearRect(0, 0, half * 2, half * 2);
    paintFood(g, { x: half, y: half }, q, f);
    S = { amt: f[3], q, canvas, half: half / q };
    Render.foods.set(f[0], S);
    Render.stats.spritePaints++; Render.stats.ms.food += performance.now() - tb;
  }
  const h = S.half * scale;
  ctx.drawImage(S.canvas, c.x - h, c.y - h, h * 2, h * 2);
}

// ---------- Ants ----------
// Per-type body shape (unit-art.js): size, abdomen/head ellipses, jaws. Unknown ids draw as soldiers.
const ANT_FALLBACK = [
  { size: 1, abd: [-6, 4.2, 3.2], head: [5, 2.6, 2.4], jaws: false },
  { size: 1.6, abd: [-6, 4.2, 3.2], head: [5.6, 3.3, 3.1], jaws: true },
];
function unitShape(type) {
  const U = window.UnitArt && UnitArt.UNITS;
  return (U && (U[type] || U[1])) || ANT_FALLBACK[type] || ANT_FALLBACK[1];
}

// One atlas per colony and type, split into HEADINGS pages (one per heading bin, allocated on first use). Each page is
// GAIT columns x (ANTENNA x 2 poses + 1 corpse) rows of lazily painted cells. A cell is painted in the ant's own frame
// with the light baked for its page's heading, so stamping at the real heading leaves at most half a bin (22.5 degrees)
// of light error. Pose 0/1 is carrying food for workers and mandibles open for jawed types (soldier, major).
// A cell index packs (bin, row, col): ((bin * ROWS) + row) * GAIT + col.
function antAtlas(side, type) {
  const id = side * 16 + type, L = window.AtlasLoader, ver = L ? L.ver : 0;
  let A = Render.atlases.get(id);
  if (A && A.ver === ver) return A;
  if (A) { Render.atlasBytes -= renderFreeAtlas(A); Render.atlases.delete(id); } // a PNG sheet arrived or went: rebuild this one from the new source
  // ant26 atlas-loader: a ready PNG sheet (atlas-loader.js) replaces the painter for this caste; its cell size and k are the sheet's,
  // so the atlas does not depend on the zoom. Anything else (none registered, loading, failed, wrong layout) keeps the painter.
  const S = L ? L.sheet(side, type, RenderCfg.GAIT, RenderCfg.ANTENNA * 2 + 1) : null;
  if (S) A = { cw: S.cw, ch: S.ch, ox: S.ox, oy: S.oy, k: S.k, png: S, pages: new Array(RenderCfg.HEADINGS).fill(null), side, type, prev: Render.stale.get(id) || null, ver };
  else {
    const k = Render.q * unitShape(type).size;
    const cw = Math.ceil(29 * k) + 4, ch = Math.ceil(14 * k) + 4; // spitter abdomen reaches 12.2 units back, alate wings 11
    A = { cw, ch, ox: Math.ceil(14 * k) + 2, oy: ch / 2, k, png: null, pages: new Array(RenderCfg.HEADINGS).fill(null), side, type, prev: Render.stale.get(id) || null, ver };
  }
  Render.atlases.set(id, A);
  return A;
}

function antBin(ang) {
  const H = RenderCfg.HEADINGS, T = Math.PI * 2;
  return Math.round((((ang % T) + T) % T) / T * H) % H;
}

function antPage(A, bin) {
  let P = A.pages[bin];
  if (!P) {
    const cols = RenderCfg.GAIT, rows = RenderCfg.ANTENNA * 2 + 1;
    if (A.png) { // PNG source (ant58 memory): no page copy. The page is a window onto the one decoded sheet (S.img: an ImageBitmap once decoded);
      // rows are the sheet's stored rows (rowMap folds the repeated antenna/pose rows), so a colony's sheet is the only copy of its pixels in memory.
      const S = A.png, j = Math.round(bin * S.bins / RenderCfg.HEADINGS) % S.bins; // sheet with fewer bins: nearest heading
      P = A.pages[bin] = { get canvas() { return S.img; }, shared: true, yoff: j * S.rows * A.ch, painted: new Uint8Array(cols * rows).fill(1), used: 0, bytes: 0 };
      A.n = (A.n || 0) + cols * rows;
      return P;
    }
    const canvas = Render.makeCanvas(A.cw * cols, A.ch * rows);
    P = A.pages[bin] = { canvas, g: canvas.getContext('2d'), painted: new Uint8Array(cols * rows), used: 0, bytes: canvas.width * canvas.height * 4 };
    Render.atlasBytes += P.bytes;
  }
  return P;
}

// Drop the least recently stamped pages (never ones used this or last frame) until the atlases fit the cap again.
function renderTrimAtlases() {
  const list = [];
  for (const A of Render.atlases.values()) A.pages.forEach((P, bin) => { if (P && !P.shared && P.used < Render.frameNo - 1) list.push([P.used, A, bin]); });
  list.sort((a, b) => a[0] - b[0]);
  for (const [, A, bin] of list) {
    if (Render.atlasBytes <= RenderCfg.ATLAS_CAP) break;
    const P = A.pages[bin];
    Render.atlasBytes -= P.bytes; A.pages[bin] = null; P.canvas.width = 0;
    Render.stats.atlasEvicts++;
  }
}

function antCell(A, col, row, bin = 0) {
  const G = RenderCfg.GAIT, rows = RenderCfg.ANTENNA * 2 + 1;
  const P = antPage(A, bin);
  P.used = Render.frameNo;
  const i = row * G + col;
  if (!P.painted[i]) {
    P.painted[i] = 1; A.n = (A.n || 0) + 1;
    const tb = performance.now();
    const g = P.g, dead = row === RenderCfg.ANTENNA * 2;
    g.setTransform(1, 0, 0, 1, col * A.cw + A.ox, row * A.ch + A.oy);
    g.save(); g.beginPath(); g.rect(-A.ox, -A.oy, A.cw, A.ch); g.clip(); // a cell never bleeds into its neighbour
    g.scale(1, 0.75); // squash for the isometric tilt
    const swing = dead ? 0 : col / (G - 1) * 2 - 1;
    const wig = dead ? 0 : (row % RenderCfg.ANTENNA) / (RenderCfg.ANTENNA - 1) * 2 - 1;
    paintAntBody(g, A.k, A.side, A.type, swing, wig, !dead && row >= RenderCfg.ANTENNA, dead, bin);
    g.restore();
    g.setTransform(1, 0, 0, 1, 0, 0);
    Render.stats.spritePaints++; Render.stats.ms.cell += performance.now() - tb;
  }
  return (bin * rows + row) * G + col;
}

// antCell, but over the frame's paint budget an unpainted cell is taken from the newest older-scale atlas that has it
// painted. Sets Render.src to the atlas to stamp from (A itself when painted here or nothing older can stand in).
function antSrc(A, col, row, bin = 0) {
  Render.src = A;
  {
    const P = A.pages[bin], i = row * RenderCfg.GAIT + col;
    if (!(P && P.painted[i])) {
      if (Render.budget <= 0) { // (ant26 crowd-perf: also for a cold atlas with no older generation: a crowd's first frames and pan-in spread over frames)
        // Exact cell first, then the nearest painted pose: another gait column or antenna wiggle of the same pose, or the
        // next heading bin over. A few frames of a slightly different leg position beat a 30 ms frame.
        const G = RenderCfg.GAIT, N = RenderCfg.ANTENNA, R = N * 2 + 1, H = RenderCfg.HEADINGS, grp = row === N * 2 ? 0 : row >= N ? N : 0;
        for (let db = 0; db <= 1; db++) for (let sgn = 1; sgn >= (db ? -1 : 1); sgn -= 2) {
          const b = (bin + db * sgn + H) % H;
          for (let dc = 0; dc < G; dc++) for (let cs = 1; cs >= (dc ? -1 : 1); cs -= 2) {
            const c = col + dc * cs;
            if (c < 0 || c >= G) continue;
            for (let B = A; B; B = B.prev) {
              const Q = B.pages[b];
              if (!Q) continue;
              if (Q.painted[row * G + c]) { Q.used = Render.frameNo; Render.src = B; return (b * R + row) * G + c; }
              if (row !== N * 2) for (let w = 0; w < N; w++) if (Q.painted[(grp + w) * G + c]) { Q.used = Render.frameNo; Render.src = B; return (b * R + grp + w) * G + c; }
            }
          }
        }
      } else Render.budget--;
    }
  }
  return antCell(A, col, row, bin);
}

// The ant in its own frame (facing +x), k device px per unit, lit for heading bin `bin`. unit-art.js paints it.
// `pose` = carrying (workers) / jaws open (jawed types).
function paintAntBody(g, k, side, type, swing, wig, pose, dead, bin = 0) {
  UnitArt.paintAnt(g, k, {
    type, side, swing, wig, pose, dead, bin,
    pal: { base: COLORS[side], dark: DARK[side], light: LIGHT[side], glow: GLOW[side] },
    px: Math.max(1, 0.85 * Render.q / scale), // ink outline: about one device pixel
  });
}

// Per-ant smoothed facing and gait, advanced once per frame from the interpolated positions.
function renderAntMotion(ants, now) {
  const R = Render, f = ++R.frameNo, TAU = Math.PI * 2;
  const dt = Math.min(0.25, Math.max(0, (now - R.lastNow) / 1000)); R.lastNow = now;
  const turn = 1 - Math.exp(-RenderCfg.TURN_RATE * dt), ease = 1 - Math.exp(-10 * dt), leanEase = 1 - Math.exp(-dt * 1000 / 120);
  for (const a of ants) {
    const target = screenAngle(a[5]);
    let s = R.ants.get(a[0]);
    if (!s) { R.ants.set(a[0], s = { ang: target, walk: (a[0] * 2.39996) % TAU, x: a[3], y: a[4], spd: 0, f, idle: 0, lean: 0, hAt: -1, hx: 0, hy: 0 }); continue; }
    let d = target - s.ang; d -= Math.round(d / TAU) * TAU; // shortest way round
    s.lean += ((Math.abs(d) > 1.05 ? Math.sign(d) : 0) - s.lean) * leanEase; // ant18 feel-anim: a turn over 60 degrees leans in (120 ms)
    s.ang += d * turn;
    if (s.ang > Math.PI || s.ang < -Math.PI) s.ang -= Math.round(s.ang / TAU) * TAU;
    let moved = Math.hypot(a[3] - s.x, a[4] - s.y);
    if (moved > 1.5) moved = 0; // teleported (respawn, id reuse)
    s.walk = (s.walk + moved * RenderCfg.STRIDE) % TAU;
    if (dt > 0) s.spd += (moved / dt - s.spd) * ease;
    s.idle = s.spd < 0.25 ? s.idle + dt * 1000 : 0; // ms standing still (idle breath starts after 300)
    s.x = a[3]; s.y = a[4]; s.f = f;
  }
  if (f % 60 === 0) for (const [id, s] of R.ants) if (f - s.f > 30) R.ants.delete(id);
}

// Draw one atlas cell at screen point (x, y), rotated by ang, under the frame's base transform B.
function stampAnt(A, cell, B, x, y, ang, k, dx, dy, sx = 1, sy = 1) {
  const cs = Math.cos(ang), sn = Math.sin(ang);
  ctx.setTransform(B.a * cs + B.c * sn, B.b * cs + B.d * sn, B.c * cs - B.a * sn, B.d * cs - B.b * sn, B.a * x + B.c * y + B.e, B.b * x + B.d * y + B.f);
  const G = RenderCfg.GAIT, rows = RenderCfg.ANTENNA * 2 + 1, col = cell % G, r2 = (cell - col) / G, row = r2 % rows, bin = (r2 - row) / rows;
  // ant71: close zoom stamps the lazily loaded 2x tier of the sheet (atlas-loader hi) when it is ready and carries this row; same cell, twice the pixels
  let H = null;
  if (A.png && A.png.screen && window.AtlasLoader && AtlasLoader.hi) {
    if (A.hiAt !== Render.frameNo) { A.hiAt = Render.frameNo; A.hiS = AtlasLoader.hi(A.side, A.type, k * pixelRatio() / A.k); }
    H = A.hiS && A.hiS.rowMap[row] >= 0 ? A.hiS : null;
  }
  const T = H || A, r = k / T.k;
  const P = H ? null : antPage(A, bin), srcY = H ? (Math.round(bin * H.bins / RenderCfg.HEADINGS) % H.bins * H.rows + H.rowMap[row]) * H.ch : (P.yoff || 0) + (A.png && A.png.rowMap ? A.png.rowMap[row] : row) * A.ch;
  let ddx = dx - T.ox * r * sx, ddy = dy - T.oy * r * sy, dw = T.cw * r * sx, dh = T.ch * r * sy;
  if (A.png && A.png.screen) { // ant64: the cell is a tilted-camera view already turned to its bin's screen heading: only the residual turn is applied
    const S = A.png, ja = Math.round(bin * S.bins / RenderCfg.HEADINGS) % S.bins; // the sheet row actually used (same pick as antPage)
    ctx.translate(dx, dy); ctx.scale(sx, sy); ctx.rotate(-ja * Math.PI * 2 / S.bins);
    ddx = -T.ox * r; ddy = -T.oy * r; dw = T.cw * r; dh = T.ch * r;
  }
  ctx.drawImage(H ? H.img : P.canvas, H ? Math.round(col * (H.gait - 1) / (G - 1)) * H.cw : col * A.cw, srcY, T.cw, T.ch, ddx, ddy, dw, dh); // ant18: squash/stretch about the ant's centre
}

const POSE = { sx: 1, sy: 1, fwd: 0, side: 0, lift: 0, kb: 0, jx: 0, jy: 0, edge: 0, edgeRim: 0, grow: 1, alpha: 1, emerge: 0, open: false, hx: 0, hy: 0 };
const CPOSE = { lift: 0, rot: 0, curled: true, sx: 1, sy: 1, scale: 1, alpha: 1 };

// Outline the body segments (edge flash / plasma rim): replaces the old white fill that hid the unit. Local frame is live.
function edgeOutline(U, k, dx, dy, sx, sy, color, alpha) {
  ctx.strokeStyle = `rgba(${color},${alpha.toFixed(3)})`; ctx.lineWidth = 1.5;
  const x0 = U.abd[0] - U.abd[1], x1 = U.head[0] + U.head[1]; // one ellipse round the whole body keeps the call count low
  ctx.beginPath();
  ctx.ellipse(dx + (x0 + x1) / 2 * k * sx, dy, ((x1 - x0) / 2 + 0.4) * k * sx, (Math.max(U.abd[2], U.head[2]) + 0.4) * k * 0.75 * sy, 0, 0, Math.PI * 2);
  ctx.stroke();
}

function drawAnt(a, now, B = ctx.getTransform()) {
  const id = a[0], side = a[1], type = a[2], hp = a[7];
  const U = unitShape(type), k = scale * U.size;
  const fx = window.FX, rm = !!(window.Settings && Settings.reduced());
  const st = Render.ants.get(id);
  const P = fx && fx.pose ? fx.pose(id, type, now, rm, st, a[6], POSE) : null;
  // Hit-stop (render-side only): attacker and victim hold the position they had when the strike landed, then catch up.
  let wx = a[3], wy = a[4];
  const hw = fx && st && fx.holdW ? fx.holdW(id, now) : 0;
  if (hw > 0) {
    const f = fx.ant(id);
    if (st.hAt !== f.holdAt) { st.hAt = f.holdAt; st.hx = wx; st.hy = wy; }
    wx += (st.hx - wx) * hw; wy += (st.hy - wy) * hw;
  }
  const c = toScreen(wx, wy);
  const moving = st && st.spd > 0.25;
  // Tripod gait: phase follows the distance walked; idle ants barely twitch.
  const swing = moving ? Math.sin(st.walk) : Math.sin(now / 400 + id) * 0.3;
  const G = RenderCfg.GAIT, N = RenderCfg.ANTENNA;
  const col = Math.round((swing + 1) / 2 * (G - 1));
  const wig = Math.round((Math.sin(now / 220 + id) + 1) / 2 * (N - 1));
  const pose = U.jaws ? (P ? P.open : false) : a[6];
  const A = antAtlas(side, type);
  const ang = st ? st.ang : screenAngle(a[5]); // heading: picks the atlas page whose baked light matches
  const cell = antSrc(A, col, wig + (pose ? N : 0), antBin(ang)), SA = Render.src;
  let dx = 0, dy = 0, sx = 1, sy = 1, y0 = c.y - (A.png && A.png.screen ? 0.5 : 3) * scale, alpha = 1, edge = 0, rim = 0;
  if (P) {
    dx = (P.fwd + P.jx) * k; dy = (P.side + P.jy) * k; sx = P.sx * P.grow; sy = P.sy * P.grow; alpha = P.alpha; edge = P.edge; rim = P.edgeRim;
    y0 -= P.lift;
    if (typeof sel !== 'undefined' && sel.has(id)) y0 -= 1; // selected ants sit "on" their ring
    if (P.emerge > 0) { const pl = curr.players[side], h = toScreen(pl.nest.x, pl.nest.y); c.x += (h.x - c.x) * P.emerge; y0 += (h.y - 16 * scale - c.y) * P.emerge; }
    if (P.kb > 0) { // knocked back away from the attacker (world direction -> screen)
      const q = toScreen(wx + P.hx, wy + P.hy), vx = q.x - c.x, vy = q.y - c.y, vl = Math.hypot(vx, vy) || 1;
      c.x += vx / vl * P.kb; y0 += vy / vl * P.kb;
    }
  }
  if (alpha < 1) ctx.globalAlpha = alpha;
  stampAnt(SA, cell, B, c.x, y0, ang, k, dx, dy, sx, sy);
  if (a[8]) edge = Math.max(edge, rm ? 0.4 : 0.6); // combat hit flag from the snapshot: an outline, not a fill, so the unit stays readable
  if (edge > 0) edgeOutline(U, k, dx, dy, sx, sy, '255,255,255', edge);
  if (rim > 0) edgeOutline(U, k, dx, dy, sx, sy, '79,216,234', rim);
  ctx.setTransform(B);
  if (alpha < 1) ctx.globalAlpha = 1;
  if (window.UIWorld) UIWorld.antBar(ctx, c.x, c.y, k, hp, COLORS[side], typeof sel !== 'undefined' && sel.has(id)); // ant19/ui-world: also on selected, unhurt ants
  if (a[12] && fx && fx.chevrons) fx.chevrons(ctx, c.x, c.y, k, a[12]); // ant34 veterancy rank
  else if (hp < 100) {
    ctx.fillStyle = 'rgba(0,0,0,.5)'; ctx.fillRect(c.x - 7 * k, c.y - 14 * k, 14 * k, 2 * k);
    ctx.fillStyle = COLORS[side]; ctx.fillRect(c.x - 7 * k, c.y - 14 * k, 14 * k * hp / 100, 2 * k);
  }
}

// All ant shadows as one path, filled once and stroked once: a darker core ellipse offset down-right (away from the
// top-left key light) with a wide faint stroke around it for the soft edge. Two calls per ant (moveTo + ellipse), none per
// frame beyond the fill and stroke. Flyers (alate) cast a smaller, further offset one.
function drawAntShadows(ants) {
  ctx.beginPath();
  for (const a of ants) {
    const fly = a[2] === 5, c = toScreen(a[3], a[4]), k = scale * unitShape(a[2]).size;
    const f = fly ? 0.7 : 1, w = 7.2 * f * k, h = 2.7 * f * k;
    const cx = c.x + (fly ? 4 : 2.2) * k, cy = c.y + (fly ? 4.5 : 0.8) * k;
    ctx.moveTo(cx + w, cy); ctx.ellipse(cx, cy, w, h, 0, 0, Math.PI * 2);
  }
  ctx.fillStyle = 'rgba(0,0,0,.3)'; ctx.fill(); // ant64: a tilted 3/4 sprite stands on this, so it is a little darker than the flat-decal era's .2
  ctx.strokeStyle = 'rgba(0,0,0,.14)'; ctx.lineWidth = 3.6 * scale; ctx.lineJoin = 'round'; ctx.stroke();
  ctx.lineWidth = 1; ctx.lineJoin = 'miter';
}

// Fallen ants tumble, curl, lie and decay (fx.js keeps the list and the timeline), so deaths read even in a big brawl.
function drawCorpses(now, B) {
  const fx = window.FX;
  if (!fx || !fx.corpsesAt) return;
  const list = fx.corpsesAt(now);
  if (!list.length) return;
  const rm = !!(window.Settings && Settings.reduced());
  for (const d of list) {
    const c = toScreen(d.x, d.y), k = scale * unitShape(d.type).size;
    const A = antAtlas(d.colony, d.type);
    const P = fx.corpsePose(d, now, rm, CPOSE);
    ctx.globalAlpha = P.alpha;
    const cell = P.curled ? antSrc(A, 0, RenderCfg.ANTENNA * 2) : antSrc(A, RenderCfg.GAIT >> 1, 1);
    stampAnt(Render.src, cell, B, c.x, c.y - 2 * scale - P.lift, screenAngle(d.dir) + P.rot, k * P.scale, 0, 0, P.sx, P.sy);
  }
  ctx.setTransform(B);
  ctx.globalAlpha = 1;
}

// ---------- The world pass ----------
// Depth-sort everything that stands on the board by screen y. Keys pack (y, kind, index) into one number so a
// native typed-array sort orders them with no per-frame objects: ties keep nests, food, ants, hazards order.
const RENDER_SLOT = 8 * 65536; // kind * 65536 + index (ant66: 16 bits of index; it was 10, so a 1025th rock or ant vanished)
function drawWorld(now) {
  renderSyncSprites();
  const ants = lerpAnts(now);
  const w = typeof view === 'function' ? view(now) : curr; // netbuf.js: nests and hazards drawn at the same moment as the ants
  renderAntMotion(ants, now);
  if (window.Perf) Perf.mark('prep');
  const B = ctx.getTransform();
  drawAntShadows(ants);
  drawCorpses(now, B);
  if (window.FX && FX.drawPuddles && curr.puddles) FX.drawPuddles(ctx, toScreen, curr.puddles); // ant34 Lingering acid
  if (window.Perf) Perf.mark('shadows');
  const rocks = window.TerrainDraw ? TerrainDraw.rocks(curr) : [];
  if (window.TerrainDraw && TerrainDraw.frame) TerrainDraw.frame(toScreen, scale); // ant68: per-frame rock sprite lookups, once
  const bakedRocks = window.TerrainDraw && TerrainDraw.bakeRocks ? TerrainDraw.bakeRocks(ctx, curr, { toScreen, scale, dpr: pixelRatio(), makeCanvas: Render.makeCanvas, viewW: innerWidth, viewH: innerHeight }) : null; // ant70: far rocks live in a cached layer
  const S = window.Structures; // ant16: structures.js, depth-sorted as kind 6
  const need = w.players.length + curr.food.length + ants.length + rocks.length + 2 + (S ? S.count() : 0);
  if (Render.keys.length < need) Render.keys = new Float64Array(need * 2);
  const K = Render.keys;
  let n = 0;
  const put = (y, kind, i) => { K[n++] = (Math.min(2e6, Math.max(0, Math.round(y * 8) + 1e6))) * RENDER_SLOT + kind * 65536 + i; };
  // ant66: rocks, food and nests off screen (plus a margin wider than any sprite) are neither sorted nor drawn: a Huge board has ~1000 rocks and ~400 piles.
  const cm = 4 * TW * scale, cx0 = -cm, cx1 = innerWidth + cm, cy0 = -cm, cy1 = innerHeight + cm;
  const onScreen = c => c.x >= cx0 && c.x <= cx1 && c.y >= cy0 && c.y <= cy1;
  w.players.forEach((p, i) => { const c = toScreen(p.nest.x, p.nest.y); if (onScreen(c)) put(c.y, 0, i); });
  curr.food.forEach((f, i) => { const c = toScreen(f[1], f[2]); if (onScreen(c)) put(c.y - 1, 1, i); });
  for (let i = 0; i < ants.length; i++) put(toScreen(ants[i][3], ants[i][4]).y, 2, i);
  if (w.anteater) put(toScreen(w.anteater.x, w.anteater.y).y, 3, 0);
  if (w.beetle) put(toScreen(w.beetle.x, w.beetle.y).y, 4, 0);
  for (let i = 0; i < rocks.length; i++) { const c = toScreen(rocks[i][0] + 0.5, rocks[i][1] + 0.5); if (onScreen(c) && !(bakedRocks && bakedRocks.has(rocks[i][1] * 4096 + rocks[i][0]))) put(c.y, 5, i); } // terrain-draw.js
  if (S) S.sortInto(put, 6); // ant16
  const sorted = K.subarray(0, n).sort();
  const PF = window.Perf && Perf.on ? Perf : null;
  if (PF) PF.mark('sort');
  for (let j = 0; j < n; j++) {
    const code = sorted[j] % RENDER_SLOT, kind = code >> 16, i = code & 65535;
    if (kind === 2) drawAnt(ants[i], now, B);
    else if (kind === 1) drawFood(curr.food[i]);
    else if (kind === 0) drawNest(w.players[i], i, now);
    else if (kind === 3) drawAnteater(w.anteater, now);
    else if (kind === 4) drawBeetle(w.beetle, now);
    else if (kind === 6) S.draw(i, now); // ant16: structures.js
    else TerrainDraw.rock(ctx, toScreen, scale, rocks[i]);
    if (PF) PF.mark(kind === 2 ? 'ants' : 'things'); // overlay: time per item kind
  }
  if (window.TerrainDraw && TerrainDraw.frame) TerrainDraw.frame(null);
  if (window.TerrainDraw && TerrainDraw.digRings) TerrainDraw.digRings(ctx, toScreen, scale, curr); // ant33: dig progress rings (terrain-draw.js)
  if (PF) PF.mark('things');
  if (window.TimeOfDay) TimeOfDay.overlay(ctx, innerWidth, innerHeight, curr); // ant19/tod: the one time-of-day wash (tod.js)
  if (window.TerrainDraw && TerrainDraw.overlay) TerrainDraw.overlay(ctx, innerWidth, innerHeight); // ant18/ground: night wash (dusk: none)
  if (PF) PF.mark('wash');
}

// Rain: all streaks in one path.
function drawWeather(now) {
  if (!curr.event || curr.event.id !== 'rain') return;
  ctx.strokeStyle = 'rgba(180,200,255,.35)'; ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i < 160; i++) {
    const x = (hash(i, 1, 3) * innerWidth + now * .15) % innerWidth;
    const y = (hash(i, 2, 3) * innerHeight + now * .9) % innerHeight;
    ctx.moveTo(x, y); ctx.lineTo(x - 3, y + 12);
  }
  ctx.stroke();
  ctx.fillStyle = 'rgba(40,60,90,.15)'; ctx.fillRect(0, 0, innerWidth, innerHeight);
}

if (typeof module !== 'undefined' && module.exports) module.exports = { Render, RenderCfg };
