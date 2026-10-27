// Ant Arena ground decals (ant18/decals): traffic wear, combat marks, dust, and a little ambient life.
// Client only, no protocol change: everything is derived from the snapshots the page already shows (hp drops, ants that
// vanished with fog.dead, nest hp, acid `shots`). Works in the browser (global Decals) and in Node (module.exports) for tests.
//
//   Decals.onFrame(snap, now)            once per frame with the snapshot being drawn; diffs against the last one
//   Decals.drawGround(g, now, toScreen, scale)   after the board, before the depth-sorted world: wear + marks + dust
//   Decals.drawAir(g, now, toScreen, scale)      after the world, before the fog: drifting spores/embers and critters
//   Decals.mark(kind, x, y, now, opts)   other lanes (feel-anim, ground) can drop a mark: acid chip crater scorch stain
//
// Budget: at most MAX_MARKS marks (oldest evicted, a crowded layer fades its old marks faster), MAX_DUST puffs, 14 spores,
// 3 critters; new marks are rate limited (MARK_PER_S) so a 200-ant brawl cannot churn the layer. Marks and wear are painted
// into one board-space canvas (PX px per tile) at most every 120-500 ms and blitted through the iso transform in one drawImage.
//
// FOG RULE (no info leaks): nothing here is created from, or drawn at, a place the player cannot currently see. Every event
// is dropped unless env.visible(snap, x, y) (fog.js) holds when it happens; the snapshot only carries what the server let
// this seat see anyway, so the ant lists need no extra filter. Ambient life is seeded by the match seed and the local clock
// only: it never reads game state, and it is drawn only on visible tiles.
// Reduced motion: no dust, no drift, no embers, no critters; spores sit still (fewer); marks and wear still appear.
(function (root) {
  const MAX_MARKS = 256, SOFT_MARKS = 192, MAX_PERM = 8;
  const MARK_PER_S = 30, CHIP_PER_S = 14; // new marks per second (token buckets): chips get their own so they cannot starve stains and splashes
  const MAX_DUST = 64, DUST_PER_S = 80;
  const SPORES = 10, EMBERS = 4, SPORES_STILL = 6, CRITTERS = 3;
  const CELL = 4; // heat cells per tile
  const HEAT_HALF_MS = 150000; // wear halves in 150 s without traffic
  const HEAT_BUMP = 0.012; // per cell crossed
  const HEAT_SHOW = 0.12; // below this the ground looks untouched
  const PX_MAX_SIDE = 1536; // board layer canvas side cap
  const FADE_IN_MS = 150, FADE_OUT_FROM = 0.6;
  const LIFE = { acid: 25000, chip: 10000, crater: 60000, scorch: 40000, stain: 45000 };
  const FAST = 1.9; // tiles/s: workers and alates; soldiers and up do not kick dust walking
  const SPLAT_DELAY = 260; // acid glob flight time in unit-art.js

  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  function mulberry(seed) { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  const hash2 = (a, b) => { const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return s - Math.floor(s); };
  const seedNum = s => { let h = 2166136261; const t = String(s); for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 16777619); return h >>> 0; };

  // Opacity of a mark at `now` given how crowded the layer is (pure: tests call it). 0 before it is born and after it dies.
  function alphaOf(m, now, count) {
    const age = now - m.born;
    if (age < 0) return 0;
    if (m.perm) return Math.min(1, age / FADE_IN_MS);
    const crowd = clamp(((count || 0) - SOFT_MARKS) / (MAX_MARKS - SOFT_MARKS), 0, 1);
    const t = age * (1 + 2 * crowd) / m.life; // a full layer ages its marks up to 3x faster
    if (t >= 1) return 0;
    return Math.min(1, age / FADE_IN_MS) * (t < FADE_OUT_FROM ? 1 : (1 - t) / (1 - FADE_OUT_FROM));
  }

  // Has a mark lived out its (crowd-shortened) life? Unlike alphaOf()==0 this is false for a mark born this very instant.
  function expired(m, now, count) {
    if (m.perm) return false;
    const crowd = clamp(((count || 0) - SOFT_MARKS) / (MAX_MARKS - SOFT_MARKS), 0, 1);
    return now - m.born >= m.life / (1 + 2 * crowd);
  }

  function createDecals(opts = {}) {
    const D = {
      marks: [], dust: [], spores: [], critters: [], fights: [],
      heat: null, map: 0, seed: null, snap: null, lastSnapAt: 0,
      walk: new Map(), // ant id -> tiles walked since the last dust puff
      tokens: MARK_PER_S, chipTokens: CHIP_PER_S, dustTokens: DUST_PER_S, tokenAt: 0,
      layer: null, layerAt: -1e9, dirty: false, heatDirty: false, heatAt: 0,
      stats: { marks: 0, dust: 0, repaints: 0, dropped: 0 },
      rng: mulberry(1), ambAt: 0,
    };
    const R = root;
    // Environment: browser globals by default, replaceable in tests.
    const env = Object.assign({
      visible: (s, x, y) => (R.Fog && R.Fog.visible ? R.Fog.visible(s, x, y) : true),
      terrain: (s, x, y) => (R.TerrainDraw && R.TerrainDraw.at ? R.TerrainDraw.at(s, x, y) : 0), // 0 open, 1 rock, 2 mud, -1 unknown
      reduced: () => !!(R.Settings && R.Settings.reduced && R.Settings.reduced()),
      colors: () => R.COLORS || ['#e0483e', '#3b7be0', '#f08a24', '#9a5ad8'],
      dark: () => R.DARK || ['#6e1c16', '#163a73', '#7a3f08', '#47236e'],
      makeCanvas: (w, h) => { const c = R.document.createElement('canvas'); c.width = w; c.height = h; return c; },
      hasDom: () => !!(R.document && R.document.createElement),
    }, opts);
    D.env = env;

    // ---------- bookkeeping ----------
    function refill(now) {
      const dt = clamp((now - D.tokenAt) / 1000, 0, 1); D.tokenAt = now;
      D.tokens = Math.min(MARK_PER_S, D.tokens + dt * MARK_PER_S);
      D.chipTokens = Math.min(CHIP_PER_S, D.chipTokens + dt * CHIP_PER_S);
      D.dustTokens = Math.min(DUST_PER_S, D.dustTokens + dt * DUST_PER_S);
    }

    function reset(snap) {
      D.marks.length = 0; D.dust.length = 0; D.fights.length = 0; D.walk.clear(); D.critters.length = 0; D.spores.length = 0;
      D.seed = snap ? snap.seed : null; D.map = snap ? snap.map : 0;
      D.heat = snap ? new Float32Array(D.map * CELL * D.map * CELL) : null;
      D.layer = null; D.dirty = D.heatDirty = false; D.snap = null;
      D.rng = mulberry(seedNum(D.seed));
      D.ambInit = false;
    }

    function addMark(kind, x, y, now, o = {}) {
      refill(now);
      const perm = !!o.perm;
      if (!perm) { const b = kind === 'chip' || (kind === 'crater' && !perm) ? 'chipTokens' : 'tokens'; if (D[b] < 1) { D.stats.dropped++; return null; } D[b]--; }
      if (x < 0.1 || y < 0.1 || x > D.map - 0.1 || y > D.map - 0.1) return null;
      if (D.snap && env.terrain(D.snap, x, y) === 1) return null; // no stains on rock tops
      const m = { kind, x, y, r: o.r || 0.25, rot: o.rot !== undefined ? o.rot : D.rng() * TAU, born: now + (o.delay || 0), life: o.life || LIFE[kind] || 20000, perm, c: o.c || 0, v: D.rng() };
      const ms = D.marks;
      if (ms.length >= MAX_MARKS) { // expired first, then the oldest non-permanent
        let w = 0; for (let i = 0; i < ms.length; i++) if (!expired(ms[i], now, ms.length)) ms[w++] = ms[i];
        ms.length = w;
        if (ms.length >= MAX_MARKS) { const i = ms.findIndex(q => !q.perm); ms.splice(i < 0 ? 0 : i, 1); }
      }
      if (perm) {
        let n = 0; for (const q of ms) if (q.perm) n++;
        if (n >= MAX_PERM) ms.splice(ms.findIndex(q => q.perm), 1);
      }
      ms.push(m); D.dirty = true; D.stats.marks++;
      return m;
    }

    function fight(x, y, now) {
      const f = D.fights;
      if (f.length >= 24) f.shift();
      f.push({ x, y, t: now });
    }
    const nearFight = (x, y, now, r = 3) => { for (const f of D.fights) if (now - f.t < 4000 && Math.hypot(f.x - x, f.y - y) < r) return true; return false; };

    function puff(x, y, now, size, a, tint) {
      if (env.reduced()) return;
      refill(now);
      if (D.dustTokens < 1 || D.dust.length >= MAX_DUST) return;
      D.dustTokens--;
      D.dust.push({ x, y, born: now, life: 520 + D.rng() * 380, size, a, vx: (D.rng() - 0.5) * 0.5, vy: (D.rng() - 0.5) * 0.5, tint: tint || 0 });
    }

    // Is this spot dry, trodden ground where feet kick dust? (a worn path, or the packed dirt around a nest)
    function dusty(x, y) {
      const s = D.snap; if (!s) return false;
      if (env.terrain(s, x, y) > 0) return false;
      for (const p of s.players) if (Math.hypot(x - p.nest.x, y - p.nest.y) < 2.6) return true;
      return heatAt(x, y) > 0.2;
    }
    function heatAt(x, y) {
      const n = D.map * CELL;
      const cx = clamp((x * CELL) | 0, 0, n - 1), cy = clamp((y * CELL) | 0, 0, n - 1);
      return D.heat ? D.heat[cy * n + cx] : 0;
    }

    // ---------- snapshot diff ----------
    function bumpHeat(x, y, moved) {
      const n = D.map * CELL;
      const cx = (x * CELL) | 0, cy = (y * CELL) | 0;
      if (cx < 0 || cy < 0 || cx >= n || cy >= n) return;
      const add = HEAT_BUMP * Math.min(2, moved * CELL);
      const H = D.heat;
      H[cy * n + cx] = Math.min(1, H[cy * n + cx] + add);
      // soften: a trodden path is wider than one cell
      if (cx > 0) H[cy * n + cx - 1] = Math.min(1, H[cy * n + cx - 1] + add * 0.3);
      if (cx < n - 1) H[cy * n + cx + 1] = Math.min(1, H[cy * n + cx + 1] + add * 0.3);
      if (cy > 0) H[(cy - 1) * n + cx] = Math.min(1, H[(cy - 1) * n + cx] + add * 0.3);
      if (cy < n - 1) H[(cy + 1) * n + cx] = Math.min(1, H[(cy + 1) * n + cx] + add * 0.3);
      D.heatDirty = true;
    }

    D.onFrame = function (curr, now) {
      if (!curr || curr === D.snap) return;
      if (!D.heat || curr.seed !== D.seed || curr.map !== D.map) reset(curr);
      const prev = D.snap; D.snap = curr;
      const dtMs = clamp(now - D.lastSnapAt, 30, 250); D.lastSnapAt = now;
      // wear fades slowly when nobody walks there
      const k = Math.pow(0.5, dtMs / HEAT_HALF_MS);
      const H = D.heat; for (let i = 0; i < H.length; i++) H[i] *= k;
      if (!prev) { // first snapshot of a match: nothing to diff
        D.walk.clear(); for (const a of curr.ants) D.walk.set(a[0], 0);
        return;
      }
      const vis = (x, y) => env.visible(curr, x, y);
      const old = new Map(prev.ants.map(a => [a[0], a]));
      const seen = new Set();
      const walk2 = new Map();
      const sec = dtMs / 1000;
      for (const a of curr.ants) {
        seen.add(a[0]);
        const o = old.get(a[0]);
        if (!o) { walk2.set(a[0], 0); continue; }
        const moved = Math.hypot(a[3] - o[3], a[4] - o[4]);
        const ax = a[3], ay = a[4];
        if (moved > 0.002 && moved < 1.5 && env.terrain(curr, ax, ay) <= 0 && vis(ax, ay)) bumpHeat(ax, ay, moved);
        // walking dust: fast ants on trodden ground, one puff per ~0.9 tile
        let w = (D.walk.get(a[0]) || 0) + (moved < 1.5 ? moved : 0);
        if (w >= 0.9) { w = 0; if (moved / sec > FAST && vis(ax, ay) && dusty(ax, ay)) puff(ax - Math.cos(a[5]) * 0.15, ay - Math.sin(a[5]) * 0.15, now, 0.16, 0.22); }
        walk2.set(a[0], w);
        const drop = o[7] - a[7];
        if (drop > 0 && vis(ax, ay)) { // hit: chitin chips, a heavy hit leaves a small crater
          fight(ax, ay, now);
          if (D.rng() < 0.55) addMark('chip', ax + (D.rng() - 0.5) * 0.3, ay + (D.rng() - 0.5) * 0.3, now, { c: a[1], r: 0.1 + 0.05 * (a[2] === 3 ? 2 : 1) });
          if (drop >= 30) { addMark('crater', ax, ay, now, { r: 0.12, life: 40000, c: a[1] }); puff(ax, ay, now, 0.22, 0.3); }
          else if (drop >= 10 && D.rng() < 0.4) puff(ax, ay, now, 0.14, 0.2);
        }
      }
      D.walk = walk2;
      // vanished ants: died if fog says so (or no fog at all); one that walked into the fog is not dead
      const dead = curr.fog ? new Set(curr.fog.dead) : null;
      for (const o of prev.ants) {
        if (seen.has(o[0])) continue;
        if (dead && !dead.has(o[0])) continue;
        if (!vis(o[3], o[4])) continue;
        const big = o[2] === 3 ? 1.6 : o[2] === 1 ? 1.2 : 1;
        fight(o[3], o[4], now);
        addMark('stain', o[3], o[4], now, { c: o[1], r: 0.14 * big });
        addMark('chip', o[3] + 0.1, o[4] - 0.05, now, { c: o[1], r: 0.12 * big });
        if (o[2] === 3) addMark('crater', o[3], o[4], now, { r: 0.22 });
        puff(o[3], o[4], now, 0.2 * big, 0.3);
      }
      // acid globs: a splash where each lands (and a scorch if it hit a nest)
      for (const t of curr.shots || []) {
        if (!vis(t[2], t[3])) continue;
        fight(t[2], t[3], now);
        const onNest = curr.players.some(p => Math.hypot(p.nest.x - t[2], p.nest.y - t[3]) < 1.3);
        addMark(onNest ? 'scorch' : 'acid', t[2] + (D.rng() - 0.5) * 0.2, t[3] + (D.rng() - 0.5) * 0.2, now, { delay: SPLAT_DELAY, r: onNest ? 0.3 : 0.2 + D.rng() * 0.12 });
      }
      // nests: scorch while attacked, a crater when one falls
      curr.players.forEach((p, i) => {
        const q = prev.players[i]; if (!q) return;
        const nx = p.nest.x, ny = p.nest.y;
        if (q.alive && !p.alive && vis(nx, ny)) {
          addMark('crater', nx, ny, now, { perm: true, r: 1.15, rot: 0 });
          for (let j = 0; j < 4; j++) puff(nx + (D.rng() - 0.5) * 1.5, ny + (D.rng() - 0.5) * 1.5, now, 0.5, 0.35);
        } else if (p.alive && p.nest.hp < q.nest.hp && vis(nx, ny)) {
          fight(nx, ny, now);
          const a = D.rng() * TAU, d = 0.6 + D.rng() * 0.7;
          let near = 0; for (const m of D.marks) if (m.kind === 'scorch' && Math.hypot(m.x - nx, m.y - ny) < 1.9) near++;
          if (near < 12) addMark('scorch', nx + Math.cos(a) * d, ny + Math.sin(a) * d * 0.8, now, { r: 0.28 + D.rng() * 0.2 });
          puff(nx + Math.cos(a) * d, ny + Math.sin(a) * d, now, 0.25, 0.25);
        }
      });
    };

    // Other lanes: Decals.mark('acid', x, y, now, { r, c }). Ignored under fog like everything else.
    D.mark = function (kind, x, y, now, o) {
      if (!D.snap || !env.visible(D.snap, x, y) || !LIFE[kind]) return null;
      return addMark(kind, x, y, now, o);
    };

    // ---------- painting ----------
    function pxFor(map) { return Math.max(4, Math.min(24, Math.floor(PX_MAX_SIDE / map))); }
    function ensureLayer() {
      if (!env.hasDom() || !D.map) return null;
      if (D.layer) return D.layer;
      const px = pxFor(D.map), side = D.map * px;
      const canvas = env.makeCanvas(side, side);
      const n = D.map * CELL, hc = env.makeCanvas(n, n);
      D.layer = { canvas, px, side, heatCanvas: hc, heatCtx: hc.getContext('2d'), img: null };
      return D.layer;
    }

    function paintHeat(L) {
      const n = D.map * CELL, g = L.heatCtx;
      if (!L.img) L.img = g.createImageData(n, n);
      const d = L.img.data, H = D.heat;
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
        const i = y * n + x, h = H[i], j = i * 4;
        const t = clamp((h - HEAT_SHOW) / 0.55, 0, 1);
        const a = t * t * (3 - 2 * t) * (0.78 + 0.22 * hash2(x, y)); // a little grain so a path reads as scuffed dirt
        // compacted ash-brown that darkens as it packs down; reads on grass and on scorched ground alike
        d[j] = 122 - 36 * t; d[j + 1] = 94 - 30 * t; d[j + 2] = 62 - 20 * t; d[j + 3] = Math.round(a * 0.5 * 255);
      }
      g.putImageData(L.img, 0, 0);
    }

    function blot(g, x, y, rx, ry, rot, fill) { g.fillStyle = fill; g.beginPath(); g.ellipse(x, y, rx, ry, rot, 0, TAU); g.fill(); }

    function paintMark(g, m, a, count) {
      const { x, y, r, rot, v } = m, S = g;
      const colors = env.colors(), dark = env.dark();
      switch (m.kind) {
        case 'acid': { // etched ring, green core, flecks
          blot(S, x, y, r * 1.25, r * 0.95, rot, `rgba(18,26,10,${(0.5 * a).toFixed(3)})`);
          blot(S, x, y, r * 0.85, r * 0.62, rot, `rgba(150,215,52,${(0.5 * a * a).toFixed(3)})`);
          blot(S, x - r * 0.15, y - r * 0.1, r * 0.4, r * 0.25, rot, `rgba(205,255,110,${(0.4 * a * a).toFixed(3)})`);
          for (let i = 0; i < 4; i++) { const q = hash2(v * 9 + i, i + 3) * TAU, d = r * (1.1 + hash2(i, v * 7) * 0.9); blot(S, x + Math.cos(q) * d, y + Math.sin(q) * d, r * 0.13, r * 0.1, 0, `rgba(160,225,60,${(0.45 * a * a).toFixed(3)})`); }
          break;
        }
        case 'chip': { // three angular shards in the colony's dark chitin
          S.globalAlpha = 0.85 * a; S.fillStyle = dark[m.c] || '#222';
          for (let i = 0; i < 3; i++) {
            const q = v * TAU + i * 2.1, d = r * (0.4 + hash2(i, v * 5) * 0.9), cx = x + Math.cos(q) * d, cy = y + Math.sin(q) * d * 0.8, s = r * (0.35 + hash2(v, i) * 0.3);
            S.beginPath(); S.moveTo(cx + s, cy); S.lineTo(cx - s * 0.4, cy + s * 0.7); S.lineTo(cx - s * 0.6, cy - s * 0.5); S.closePath(); S.fill();
          }
          S.globalAlpha = 1;
          break;
        }
        case 'crater': { // dark pit with a raised rim
          blot(S, x, y, r * 1.1, r * 0.82, rot, `rgba(120,92,64,${(0.35 * a).toFixed(3)})`);
          blot(S, x, y + r * 0.04, r * 0.88, r * 0.66, rot, `rgba(20,13,9,${(0.72 * a).toFixed(3)})`);
          blot(S, x - r * 0.12, y - r * 0.12, r * 0.55, r * 0.38, rot, `rgba(8,5,4,${(0.5 * a).toFixed(3)})`);
          if (m.perm) for (let i = 0; i < 7; i++) { const q = hash2(i, 5) * TAU, d = r * (0.9 + hash2(i, 9) * 0.5); blot(S, x + Math.cos(q) * d, y + Math.sin(q) * d * 0.8, r * 0.06, r * 0.045, q, `rgba(70,52,38,${(0.7 * a).toFixed(3)})`); }
          break;
        }
        case 'scorch': { // soot rings, with embers glinting while it is fresh
          blot(S, x, y, r * 1.35, r * 1.0, rot, `rgba(14,10,8,${(0.2 * a).toFixed(3)})`);
          blot(S, x, y, r * 0.95, r * 0.7, rot, `rgba(10,7,6,${(0.34 * a).toFixed(3)})`);
          blot(S, x, y, r * 0.5, r * 0.36, rot, `rgba(6,4,3,${(0.42 * a).toFixed(3)})`);
          const fresh = clamp(1 - (m.age || 0) / 9000, 0, 1);
          if (fresh > 0) for (let i = 0; i < 3; i++) { const q = hash2(i, v * 3) * TAU, d = r * 0.55; blot(S, x + Math.cos(q) * d, y + Math.sin(q) * d * 0.7, r * 0.07, r * 0.05, 0, `rgba(255,128,40,${(0.7 * fresh * a).toFixed(3)})`); }
          break;
        }
        case 'stain': { // ichor in the dead ant's colour over a dark smear
          blot(S, x, y, r * 1.2, r * 0.85, rot, `rgba(18,12,9,${(0.38 * a).toFixed(3)})`);
          S.globalAlpha = 0.34 * a; blot(S, x + r * 0.1, y, r * 0.8, r * 0.55, rot, colors[m.c] || '#844'); S.globalAlpha = 1;
          for (let i = 0; i < 3; i++) { const q = hash2(v * 11 + i, 2) * TAU, d = r * (1 + hash2(i, v) * 0.7); blot(S, x + Math.cos(q) * d, y + Math.sin(q) * d * 0.8, r * 0.12, r * 0.09, 0, `rgba(18,12,9,${(0.4 * a).toFixed(3)})`); }
          break;
        }
        default: break;
      }
    }

    function repaint(now) {
      const L = ensureLayer(); if (!L) return;
      const g = L.canvas.getContext('2d');
      g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, L.side, L.side);
      paintHeat(L);
      g.imageSmoothingEnabled = true;
      g.drawImage(L.heatCanvas, 0, 0, L.side, L.side);
      g.setTransform(L.px, 0, 0, L.px, 0, 0);
      const count = D.marks.length;
      for (const m of D.marks) {
        const a = alphaOf(m, now, count);
        if (a <= 0.01) continue;
        m.age = now - m.born;
        paintMark(g, m, a, count);
      }
      g.setTransform(1, 0, 0, 1, 0, 0);
      D.layerAt = now; D.dirty = false; D.heatDirty = false; D.stats.repaints++;
    }

    function sweep(now) {
      const ms = D.marks; let w = 0;
      for (let i = 0; i < ms.length; i++) { const m = ms[i]; if (!expired(m, now, ms.length)) ms[w++] = m; }
      if (w !== ms.length) { ms.length = w; D.dirty = true; }
    }

    // soft round sprite for dust and glows, made once
    function softSprite(rgb) {
      if (!env.hasDom()) return null;
      D.sprites = D.sprites || {};
      if (D.sprites[rgb]) return D.sprites[rgb];
      const c = env.makeCanvas(32, 32), g = c.getContext('2d');
      const gr = g.createRadialGradient(16, 16, 0, 16, 16, 16);
      gr.addColorStop(0, `rgba(${rgb},1)`); gr.addColorStop(0.5, `rgba(${rgb},0.45)`); gr.addColorStop(1, `rgba(${rgb},0)`);
      g.fillStyle = gr; g.fillRect(0, 0, 32, 32);
      return (D.sprites[rgb] = c);
    }

    D.drawGround = function (g, now, toScreen, scale) {
      if (!D.map || !D.heat) return;
      sweep(now);
      const L = ensureLayer();
      if (L) {
        const since = now - D.layerAt;
        if (since > 600 || (D.dirty && since > 250)) { if (D.heatDirty || D.dirty || D.marks.length || since > 2000) repaint(now); }
        const o = toScreen(0, 0), ux = toScreen(1, 0), uy = toScreen(0, 1);
        g.save();
        g.transform(ux.x - o.x, ux.y - o.y, uy.x - o.x, uy.y - o.y, o.x, o.y);
        g.imageSmoothingEnabled = true;
        g.drawImage(L.canvas, 0, 0, D.map, D.map);
        g.restore();
      }
      // dust puffs (live; none in Reduced motion)
      if (env.reduced()) { D.dust.length = 0; return; }
      const sp = softSprite('150,126,96');
      const ds = D.dust; let w = 0;
      for (let i = 0; i < ds.length; i++) {
        const p = ds[i], age = now - p.born;
        if (age >= p.life) continue;
        ds[w++] = p;
        if (!sp || !env.visible(D.snap, p.x, p.y)) continue;
        const t = age / p.life, c = toScreen(p.x + p.vx * age / 1000, p.y + p.vy * age / 1000);
        const r = p.size * (1 + t * 1.8) * scale * 40;
        g.globalAlpha = p.a * (1 - t) * (1 - t) * 1.4;
        g.drawImage(sp, c.x - r, c.y - r * 0.6 - t * 6 * scale, r * 2, r * 1.2);
      }
      ds.length = w; g.globalAlpha = 1;
    };

    // ---------- ambient life ----------
    function openSpot(r, minNest) {
      const s = D.snap, m = D.map;
      for (let k = 0; k < 40; k++) {
        const x = 1.5 + r() * (m - 3), y = 1.5 + r() * (m - 3);
        if (env.terrain(s, x, y) !== 0) continue;
        if (s.players.some(p => Math.hypot(p.nest.x - x, p.nest.y - y) < minNest)) continue;
        return { x, y };
      }
      return null;
    }
    function initAmbient(now) {
      D.ambInit = true;
      const r = mulberry(seedNum(D.seed) ^ 0x9e3779b9);
      D.spores.length = 0; D.critters.length = 0;
      const n = SPORES + EMBERS;
      for (let i = 0; i < n; i++) D.spores.push({ ember: i >= SPORES, x0: 0, y0: 0, born: now - r() * 8000, life: 0, vx: 0, vy: 0, ph: r() * TAU, seeded: false });
      for (let i = 0; i < CRITTERS; i++) {
        const p = openSpot(r, 7); if (!p) continue;
        D.critters.push({ kind: i === CRITTERS - 1 ? 'moth' : 'beetle', x: p.x, y: p.y, hx: r() * TAU, state: 'pause', until: now + 500 + r() * 3000, left: 0, fade: 1, ph: r() * TAU, r });
      }
      D.ambR = r;
    }
    function respawn(sp, now) {
      const r = D.ambR, s = D.snap, m = D.map;
      sp.x0 = 1 + r() * (m - 2); sp.y0 = 1 + r() * (m - 2);
      const a = r() * TAU, sped = 0.06 + r() * 0.08;
      sp.vx = Math.cos(a) * sped; sp.vy = Math.sin(a) * sped;
      sp.life = (sp.ember ? 5000 : 8000) + r() * (sp.ember ? 6000 : 12000);
      sp.born = now; sp.ph = r() * TAU;
      if (sp.ember) { // embers rise out of ground near a nest or rock: keep them around the board's middle bands, scorched feel
        const p = s.players[(r() * s.players.length) | 0];
        if (p) { sp.x0 = clamp(p.nest.x + (r() - 0.5) * 6, 1, m - 1); sp.y0 = clamp(p.nest.y + (r() - 0.5) * 6, 1, m - 1); }
      }
    }

    function stepCritter(c, dt, now) {
      const s = D.snap, r = c.r;
      if (c.state === 'pause') {
        if (now >= c.until) { c.hx += (r() - 0.5) * 2.6; c.left = 1.2 + r() * 1.3; c.state = 'walk'; }
        return;
      }
      const sp = c.kind === 'moth' ? 0.5 : 0.32, d = Math.min(c.left, sp * dt);
      const nx = c.x + Math.cos(c.hx) * d, ny = c.y + Math.sin(c.hx) * d;
      const ok = nx > 1.2 && ny > 1.2 && nx < D.map - 1.2 && ny < D.map - 1.2 && env.terrain(s, nx, ny) === 0 && !s.players.some(p => Math.hypot(p.nest.x - nx, p.nest.y - ny) < 5);
      if (!ok) { c.hx += 1.7 + r(); c.state = 'pause'; c.until = now + 800; return; }
      c.x = nx; c.y = ny; c.left -= d;
      if (c.left <= 0.001) { c.state = 'pause'; c.until = now + 1500 + r() * 3500; }
    }

    D.drawAir = function (g, now, toScreen, scale) {
      if (!D.map || !D.snap) return;
      const reduced = env.reduced(), s = D.snap;
      if (!D.ambInit) initAmbient(now);
      const dt = clamp((now - D.ambAt) / 1000, 0, 0.1); D.ambAt = now;
      // spores and embers
      const glow = softSprite('170,255,90'), emberGlow = softSprite('255,140,50');
      const lim = reduced ? SPORES_STILL : D.spores.length;
      g.globalCompositeOperation = 'lighter';
      for (let i = 0; i < lim; i++) {
        const p = D.spores[i];
        if (reduced && p.ember) continue;
        if (!p.seeded || (!reduced && now - p.born > p.life)) { respawn(p, now); p.seeded = true; }
        const t = reduced ? 0 : (now - p.born) / 1000, age = (now - p.born) / p.life;
        const x = p.x0 + p.vx * t + Math.sin(p.ph + t * 0.7) * 0.15 * (reduced ? 0 : 1), y = p.y0 + p.vy * t + Math.cos(p.ph + t * 0.6) * 0.15 * (reduced ? 0 : 1);
        if (x < 0.5 || y < 0.5 || x > D.map - 0.5 || y > D.map - 0.5) continue;
        if (!env.visible(s, x, y) || nearFight(x, y, now)) continue;
        const env_ = reduced ? 0.7 : Math.sin(clamp(age, 0, 1) * Math.PI);
        const c = toScreen(x, y), lift = (p.ember ? 8 + t * 5 : 10 + Math.sin(p.ph + t) * 3) * scale;
        const rad = (p.ember ? 3.2 : 3.6) * scale;
        const flick = p.ember && !reduced ? 0.7 + 0.3 * Math.sin(now / 90 + p.ph * 5) : 1;
        g.globalAlpha = (p.ember ? 0.5 : 0.34) * env_ * flick;
        const sp = p.ember ? emberGlow : glow;
        if (sp) g.drawImage(sp, c.x - rad * 2, c.y - lift - rad * 2, rad * 4, rad * 4);
      }
      g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1;
      // idle critters: hidden when reduced, near a fight, or when any shown ant is close
      if (reduced) return;
      for (const c of D.critters) {
        if (dt > 0) stepCritter(c, dt, now);
        let shy = nearFight(c.x, c.y, now, 5);
        if (!shy) for (const a of s.ants) if (Math.hypot(a[3] - c.x, a[4] - c.y) < 2.6) { shy = true; break; }
        c.fade = clamp(c.fade + (shy ? -dt * 2.5 : dt * 0.8), 0, 1);
        if (c.fade <= 0.02 || !env.visible(s, c.x, c.y)) continue;
        drawCritter(g, c, now, toScreen, scale);
      }
    };

    function drawCritter(g, c, now, toScreen, scale) {
      const p = toScreen(c.x, c.y), q = toScreen(c.x + Math.cos(c.hx), c.y + Math.sin(c.hx));
      const ang = Math.atan2((q.y - p.y) / 0.75, q.x - p.x), k = scale * 0.55;
      g.save(); g.globalAlpha = c.fade;
      g.translate(p.x, p.y - (c.kind === 'moth' ? 14 * scale + Math.sin(now / 130 + c.ph) * 3 * scale : 1 * scale));
      if (c.kind === 'moth') { // soft shadow below, two flapping wings
        g.save(); g.translate(0, 14 * scale); g.fillStyle = 'rgba(0,0,0,.18)'; g.beginPath(); g.ellipse(0, 0, 5 * k, 2 * k, 0, 0, TAU); g.fill(); g.restore();
        const flap = 0.45 + 0.55 * Math.abs(Math.sin(now / 55 + c.ph));
        g.fillStyle = 'rgba(206,190,160,.9)'; g.strokeStyle = 'rgba(70,56,40,.8)'; g.lineWidth = Math.max(0.6, k * 0.5);
        for (const sg of [-1, 1]) { g.beginPath(); g.ellipse(0, sg * 4 * k * flap, 3.5 * k, 5.5 * k * flap, sg * 0.5, 0, TAU); g.fill(); g.stroke(); }
        g.fillStyle = '#3a2d22'; g.beginPath(); g.ellipse(0, 0, 4.5 * k, 1.5 * k, 0, 0, TAU); g.fill();
      } else {
        g.rotate(ang); g.scale(1, 0.75);
        g.fillStyle = 'rgba(0,0,0,.25)'; g.beginPath(); g.ellipse(1 * k, 2 * k, 8 * k, 4 * k, 0, 0, TAU); g.fill();
        const stride = Math.sin(now / 110 + c.ph) * (c.state === 'walk' ? 1 : 0.15);
        g.strokeStyle = '#1a1410'; g.lineWidth = Math.max(0.6, k * 0.7); g.beginPath();
        for (const lx of [-3, 0, 3]) for (const sg of [-1, 1]) { g.moveTo(lx * k, 0); g.lineTo((lx + stride * sg * 1.6) * k, sg * 5.5 * k); }
        g.stroke();
        g.fillStyle = '#3b3326'; g.strokeStyle = '#14100b'; g.lineWidth = Math.max(0.6, k * 0.5);
        g.beginPath(); g.ellipse(-1 * k, 0, 6.4 * k, 4.4 * k, 0, 0, TAU); g.fill(); g.stroke();
        g.fillStyle = 'rgba(255,200,120,.25)'; g.beginPath(); g.ellipse(-2.4 * k, -1.2 * k, 3 * k, 1.4 * k, 0, 0, TAU); g.fill();
        g.fillStyle = '#241d14'; g.beginPath(); g.ellipse(6.2 * k, 0, 2.4 * k, 2.1 * k, 0, 0, TAU); g.fill();
      }
      g.restore();
    }

    D.reset = reset;
    D.heatAt = heatAt;
    D.nearFight = nearFight;
    D.constants = { MAX_MARKS, SOFT_MARKS, MAX_PERM, MARK_PER_S, CHIP_PER_S, MAX_DUST, SPORES, EMBERS, SPORES_STILL, CRITTERS, CELL, HEAT_SHOW };
    return D;
  }

  const api = { createDecals, alphaOf, expired, MAX_MARKS, SOFT_MARKS, MAX_DUST, LIFE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Decals = createDecals();
})(typeof window !== 'undefined' ? window : globalThis);
