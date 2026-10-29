// Terrain rendering (ant18/ground): the SCORCHED ALIEN DUSK board. Cracked ash and earth in three tones, seams, lit
// dry grass and dead scrub, basalt rocks with acid lichen, a ruined map edge, baked long shadows.
// Snapshots carry `terrain` (one char per tile, y * map + x: '0' open, '1' rock, '2' mud) about once a
// second (and right after a major dug a rock out, ant33); the parsed tile lists are cached per match seed, so frames
// without it keep drawing, and a changed string rebuilds the lists, the ground texture and the board layer (`ver`).
// `digs` ([[tileX, tileY, percent]]) is drawn by digRings(): a progress ring and cracks on the rock being chewed out.
//
// How it stays cheap:
//   - the ground texture (value noise, 3 tones, voronoi cracks, ash, mud, packed earth round nests) is built ONCE per
//     match as a small map-space bitmap (~600k texels, pure JS, tests build it in Node);
//   - drawBoard() composes the whole board (edge slab, texture through the isometric transform, seams, tufts, scrub,
//     pebbles, rock shadows, light gradient, time-of-day tint) into ONE cached layer at a quantised pixel density,
//     so a pan is a blit and a zoom only repaints when the density crosses a 19% step;
//   - rocks are cached sprites (one drawImage each), painted lazily and rebuilt on density / flip / time-of-day change.
// render.js blits the layer (drawBoard) and draws rocks()/rock() in its depth sort.
//
// Time of day: ONE parameter. TerrainDraw.setTod('dusk' | 'night') (default dusk; `?tod=night` in the URL picks night).
// Every cached layer and sprite ends with the same source-atop tint, and night adds a faint screen overlay (overlay()).
// Hooks for the decals / ambient lane: tod(), ambient(), palette, emitters(state) (world points of ember fissures),
// tileKind(state, x, y), onRebuild(cb) (the ground layer was repainted; layer geometry in layerInfo()).
(function (root) {
  const PAL = {
    shadow: [30, 25, 27], mid: [52, 43, 41], light: [84, 68, 58], ash: [116, 108, 102], crack: [14, 10, 9],
    packA: [72, 52, 40], packB: [102, 75, 52], mud: [30, 24, 29], mudHi: [54, 42, 46], ember: [255, 104, 36],
    ink: '#120c08', lichen: [150, 230, 70],
  };
  const TOD = {
    dusk: { name: 'dusk', tint: 'rgba(255,128,48,0.05)', glow: 1, sky: null },
    night: { name: 'night', tint: 'rgba(14,26,72,0.40)', glow: 1.7, sky: 'rgba(8,16,44,0.10)' },
  };
  let todName = 'dusk';
  try {
    const q = root.location && /[?&]tod=(night|dusk)\b/.exec(root.location.search || '');
    if (q) todName = q[1];
  } catch (e) { /* no location */ }
  let todVer = 0;
  const rebuildCbs = [];

  const doc = root.document;
  const makeCanvas = (w, h) => { if (!doc) return null; const c = doc.createElement('canvas'); c.width = w; c.height = h; return c; };
  // ant75: a replaced layer canvas is zeroed, not left to the garbage collector. A Huge board layer is up to 64 MB and the rock layer matches it;
  // every density step of a zoom made a pair, and Firefox kept the dropped ones (hundreds of MB) until a GC that never came in time: tab crash.
  const releaseCanvas = c => { if (c && c.width) c.width = 0; };
  const reduced = () => !!(root.Settings && root.Settings.reduced && root.Settings.reduced());

  function hash(x, y, seed) {
    let h = (x * 374761393 + y * 668265263 + seed * 2654435761) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  // ---------- Tile data ----------
  let cache = null; // { seed, map, str, ver, rocks: [[x, y, n]], mud: [[x, y, n]], cls: Uint8Array }
  let verCount = 0; // a new terrain string (a dug tile) is a new `ver`: cache keys use it, not the string length

  function sync(state) {
    if (!state) return null;
    if (state.terrain && (!cache || cache.seed !== state.seed || cache.str !== state.terrain)) {
      const m = state.map, rocks = [], mud = [], cls = new Uint8Array(m * m);
      for (let i = 0; i < state.terrain.length && i < m * m; i++) {
        const c = state.terrain.charCodeAt(i) - 48, x = i % m, y = (i / m) | 0;
        cls[i] = c === 1 || c === 2 ? c : 0;
        if (c === 1) rocks.push([x, y, hash(x, y, state.seed)]);
        else if (c === 2) mud.push([x, y, hash(x, y, state.seed)]);
      }
      cache = { seed: state.seed, map: m, str: state.terrain, ver: ++verCount, rocks, mud, cls, tex: null, texKey: '' };
    }
    return cache && cache.seed === state.seed && cache.map === state.map ? cache : null;
  }

  // ---------- Ground texture (pure: runs in Node) ----------
  const sm = (a, b, v) => { const t = Math.min(1, Math.max(0, (v - a) / (b - a))); return t * t * (3 - 2 * t); };
  function vnoise(x, y, s) {
    const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
    const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
    const a = hash(ix, iy, s), b = hash(ix + 1, iy, s), c = hash(ix, iy + 1, s), d = hash(ix + 1, iy + 1, s);
    return (a + (b - a) * u) + ((c + (d - c) * u) - (a + (b - a) * u)) * v;
  }
  const texelsPerTile = m => Math.max(m >= 96 ? 12 : 16, Math.min(32, Math.round(768 / m))); // ant62: Huge boards (96+) drop to 12 texels a tile: a 144-tile ground is 1728 px, not 2304, and rebuilds in about half the time

  // Returns { size, R, data (RGBA), emitters: [[x, y]] } for a map of tile classes (0 open, 1 rock, 2 mud) and nests.
  function buildTexture(m, seed, cls, nests, patch) {
    // ant66: patch = { data, x0, y0, x1, y1 } (inclusive tile rect) redraws only those tiles into an existing texture (a dug rock).
    const R = texelsPerTile(m), S = m * R, data = patch ? patch.data : new Uint8ClampedArray(S * S * 4);
    const J0 = patch ? patch.y0 * R : 0, J1 = patch ? (patch.y1 + 1) * R : S, I0 = patch ? patch.x0 * R : 0, I1 = patch ? (patch.x1 + 1) * R : S;
    const VK = 1.45, VN = Math.ceil(m * VK) + 3; // voronoi cells per tile side
    const vx = new Float32Array(VN * VN), vy = new Float32Array(VN * VN);
    for (let j = 0; j < VN; j++) for (let i = 0; i < VN; i++) { vx[j * VN + i] = i + hash(i, j, seed + 11); vy[j * VN + i] = j + hash(i, j, seed + 17); }
    const near = new Uint8Array(m * m); // tile within 1 of a rock or mud tile
    for (let y = 0; y < m; y++) for (let x = 0; x < m; x++) if (cls[y * m + x]) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < m && yy < m) near[yy * m + xx] = 1;
    }
    const tileAt = (x, y) => (x < 0 || y < 0 || x >= m || y >= m ? 0 : cls[y * m + x]);
    const bil = (wx, wy, kind) => {
      const fx = wx - 0.5, fy = wy - 0.5, ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy;
      const a = tileAt(ix, iy) === kind ? 1 : 0, b = tileAt(ix + 1, iy) === kind ? 1 : 0, c = tileAt(ix, iy + 1) === kind ? 1 : 0, d = tileAt(ix + 1, iy + 1) === kind ? 1 : 0;
      return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
    };
    const em = new Float32Array(m * m * 3); // per-tile ember weight, x and y sums (emitter positions)
    const P = PAL, s1 = seed * 7 + 1, s2 = seed * 7 + 2, s3 = seed * 7 + 3, s4 = seed * 7 + 4, s5 = seed * 7 + 5;
    let o = 0;
    for (let j = J0; j < J1; j++) {
      const wy = (j + 0.5) / R;
      o = (j * S + I0) * 4;
      for (let i = I0; i < I1; i++, o += 4) {
        const wx = (i + 0.5) / R;
        // three tones from layered noise, pixel dither on the thresholds
        const n = 0.55 * vnoise(wx * 1.1, wy * 1.1, s1) + 0.30 * vnoise(wx * 3.3, wy * 3.3, s2) + 0.15 * vnoise(wx * 9, wy * 9, s3);
        const gr = hash(i, j, seed + 99) - 0.5;
        const v = n + gr * 0.10;
        const t1 = sm(0.36, 0.50, v), t2 = sm(0.55, 0.70, v);
        let r = P.shadow[0] + (P.mid[0] - P.shadow[0]) * t1, g = P.shadow[1] + (P.mid[1] - P.shadow[1]) * t1, b = P.shadow[2] + (P.mid[2] - P.shadow[2]) * t1;
        r += (P.light[0] - r) * t2; g += (P.light[1] - g) * t2; b += (P.light[2] - b) * t2;
        // packed earth round the nests (a wobbly disc, warmer and flatter)
        let dn = 1e9;
        for (const q of nests) { const d = Math.hypot(wx - q.x, wy - q.y); if (d < dn) dn = d; }
        let ring = 0;
        if (dn < 5) {
          const wob = vnoise(wx * 1.7, wy * 1.7, s4) - 0.5;
          ring = 1 - sm(2.3 + wob * 1.6, 3.1 + wob * 1.6, dn);
          if (ring > 0) {
            const k = sm(0.40, 0.62, v), pr = P.packA[0] + (P.packB[0] - P.packA[0]) * k, pg = P.packA[1] + (P.packB[1] - P.packA[1]) * k, pb = P.packA[2] + (P.packB[2] - P.packA[2]) * k;
            r += (pr - r) * ring; g += (pg - g) * ring; b += (pb - b) * ring;
          }
        }
        // drifts of pale ash
        const ash = sm(0.64, 0.82, vnoise(wx * 0.6 + 50, wy * 0.6 + 50, s5)) * 0.34 * (1 - ring * 0.6);
        if (ash > 0) { r += (P.ash[0] - r) * ash; g += (P.ash[1] - g) * ash; b += (P.ash[2] - b) * ash; }
        // voronoi cracks: 1 - (F2 - F1) is the crack mask
        const cx = Math.floor(wx * VK), cy = Math.floor(wy * VK);
        let f1 = 9, f2 = 9;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const k = (cy + dy + 1) * VN + (cx + dx + 1), ddx = vx[k] - 1 - wx * VK, ddy = vy[k] - 1 - wy * VK, d = Math.sqrt(ddx * ddx + ddy * ddy);
          if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) f2 = d;
        }
        const gap = (f2 - f1) / VK; // in tiles
        if (gap < 0.12) {
          const w = 0.016 + 0.016 * vnoise(wx * 2.1, wy * 2.1, s2); // varying width
          const area = 0.12 + 0.88 * sm(0.50, 0.72, vnoise(wx * 0.45 + 11, wy * 0.45 + 7, s3)); // cracked patches vs smooth
          const crack = sm(w + 0.03, w, gap) * area * (1 - ring * 0.7);
          if (crack > 0) {
            r += (P.crack[0] - r) * crack * 0.88; g += (P.crack[1] - g) * crack * 0.88; b += (P.crack[2] - b) * crack * 0.88;
            // glowing ember in a few fissures, never close to a nest
            if (dn > 5 && gap < w * 0.7) {
              const e = sm(0.80, 0.92, vnoise(wx * 0.5 + 90, wy * 0.5 + 33, s4));
              const core = sm(w * 0.7, w * 0.15, gap) * e;
              if (core > 0.02) {
                r += P.ember[0] * 0.5 * core; g += P.ember[1] * 0.5 * core; b += P.ember[2] * 0.5 * core;
                const t = ((wy | 0) * m + (wx | 0)) * 3; em[t] += core; em[t + 1] += core * wx; em[t + 2] += core * wy;
              }
            }
          }
        }
        // mud and rock scorch from the tile classes, with noisy organic edges
        if (near[(wy | 0) * m + (wx | 0)]) {
          const mudA = sm(0.42, 0.56, bil(wx, wy, 2) + (vnoise(wx * 4, wy * 4, s1) - 0.5) * 0.5);
          if (mudA > 0) {
            const k = sm(0.35, 0.7, v), mr = P.mud[0] + (P.mudHi[0] - P.mud[0]) * k, mg = P.mud[1] + (P.mudHi[1] - P.mud[1]) * k, mb = P.mud[2] + (P.mudHi[2] - P.mud[2]) * k;
            r += (mr - r) * mudA * 0.96; g += (mg - g) * mudA * 0.96; b += (mb - b) * mudA * 0.96;
          }
          const rk = sm(0.15, 0.9, bil(wx, wy, 1) + (vnoise(wx * 3, wy * 3, s2) - 0.5) * 0.4);
          if (rk > 0) { const f = 1 - 0.5 * rk; r *= f; g *= f; b *= f; }
        }
        // the rim of the world is burnt darker
        const de = Math.min(wx, wy, m - wx, m - wy);
        if (de < 1.1) { const f = 0.62 + 0.38 * sm(0, 1.1, de); r *= f; g *= f; b *= f; }
        data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = 255;
      }
    }
    const emitters = [];
    for (let t = 0; t < m * m; t++) if (em[t * 3] > 3) emitters.push([em[t * 3 + 1] / em[t * 3], em[t * 3 + 2] / em[t * 3]]);
    return { size: S, R, data, emitters: patch ? null : emitters };
  }

  let prevGround = null; // the last ground texture built: { base key, tile classes, tex }
  function texture(t, state) { // cached per match + terrain + nests
    const nests = (state.players || []).map(p => ({ x: p.nest.x, y: p.nest.y }));
    const key = `${state.seed}|${state.map}|${t ? t.ver : 0}|${nests.map(n => n.x + ',' + n.y).join(';')}`;
    const holder = t || sync.noTerrain || (sync.noTerrain = {});
    if (holder.texKey === key && holder.tex) return holder.tex;
    const cls = t ? t.cls : new Uint8Array(state.map * state.map);
    // ant66: a rock dug out changes a few tiles; when the last ground (same match, map and nests) differs from this one by a few tiles,
    // repaint only those tiles plus the 2 around them (a texel looks at tiles within 2) instead of the whole ground (~800 ms on Huge).
    const base = state.seed + '|' + state.map + '|' + nests.map(n => n.x + ',' + n.y).join(';');
    if (prevGround && prevGround.base === base && prevGround.tex.canvas) {
      const old = prevGround.cls, m = state.map;
      let x0 = m, y0 = m, x1 = -1, y1 = -1, diffs = 0;
      for (let c = 0; c < m * m; c++) if (old[c] !== cls[c]) {
        diffs++; const x = c % m, y = (c / m) | 0;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
      if (diffs > 0 && diffs <= 12) {
        x0 = Math.max(0, x0 - 2); y0 = Math.max(0, y0 - 2); x1 = Math.min(m - 1, x1 + 2); y1 = Math.min(m - 1, y1 + 2);
        const pt = prevGround.tex, R = pt.R;
        buildTexture(m, state.seed, cls, nests, { data: pt.data, x0, y0, x1, y1 });
        pt.canvas.getContext('2d').putImageData(new ImageData(pt.data, pt.size, pt.size), 0, 0, x0 * R, y0 * R, (x1 - x0 + 1) * R, (y1 - y0 + 1) * R);
        prevGround.cls = cls.slice();
        holder.tex = pt; holder.texKey = key;
        return pt;
      }
    }
    const tex = buildTexture(state.map, state.seed, cls, nests);
    const cv = makeCanvas(tex.size, tex.size);
    if (cv) cv.getContext('2d').putImageData(new ImageData(tex.data, tex.size, tex.size), 0, 0);
    holder.tex = { canvas: cv, emitters: tex.emitters, size: tex.size, R: tex.R, data: tex.data };
    holder.texKey = key;
    prevGround = { base, cls: cls.slice(), tex: holder.tex };
    return holder.tex;
  }

  // ---------- Layer painting (unit space: 1 unit = 1 css px at zoom 1; any ctx; tests use a stub) ----------
  const rgba = (c, a) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;

  function projector(m, flip) {
    return (x, y) => { if (flip) { x = m - x; y = m - y; } return { x: (x - y) * 32, y: (x + y) * 16 }; };
  }

  function layerBounds(m) {
    return { minU: -m * 32 - 2, maxU: m * 32 + 2, minV: -14, maxV: m * 32 + 40 };
  }

  // The map's near edge as a cracked cliff: strata, jagged underside, ember seams, a lit lip.
  function paintEdge(g, P, m, seed, D) {
    const c = [P(0, 0), P(m, 0), P(m, m), P(0, m)];
    let bi = 0; for (let i = 1; i < 4; i++) if (c[i].y > c[bi].y) bi = i;
    const bot = c[bi], a = c[(bi + 1) % 4], b = c[(bi + 3) % 4];
    const [left, right] = a.x < b.x ? [a, b] : [b, a];
    const depth = 22;
    // soft ground shadow under the slab
    g.fillStyle = 'rgba(0,0,0,0.30)';
    g.beginPath(); g.moveTo(left.x, left.y + depth * 0.6); g.lineTo(bot.x, bot.y + depth + 12); g.lineTo(right.x, right.y + depth * 0.6);
    g.lineTo(right.x, right.y + 4); g.lineTo(bot.x, bot.y + 4); g.lineTo(left.x, left.y + 4); g.closePath(); g.fill();
    const face = (p, q, base, strata, lit) => {
      const N = Math.max(4, Math.round(Math.abs(q.x - p.x) / 5));
      g.beginPath(); g.moveTo(p.x, p.y);
      g.lineTo(q.x, q.y);
      for (let i = N; i >= 0; i--) {
        const t = i / N, x = p.x + (q.x - p.x) * t, y = p.y + (q.y - p.y) * t;
        g.lineTo(x, y + depth + hash(i, bi, seed + 3) * 9 - (i % 3 ? 0 : 2));
      }
      g.closePath(); g.fillStyle = base; g.fill();
      g.save(); g.clip();
      for (let k = 0; k < 4; k++) { // strata bands, each its own tone
        const f = (k + 1) / 5;
        g.fillStyle = strata[k % strata.length];
        g.beginPath(); g.moveTo(p.x, p.y + depth * f); g.lineTo(q.x, q.y + depth * f);
        g.lineTo(q.x, q.y + depth * (f + 0.16 + hash(k, 1, seed) * 0.08)); g.lineTo(p.x, p.y + depth * (f + 0.14)); g.closePath(); g.fill();
      }
      g.strokeStyle = 'rgba(8,5,4,0.55)'; g.lineWidth = 1 / D; // vertical cracks, a few glowing
      for (let i = 1; i < N; i++) {
        if (hash(i, bi, seed + 8) < 0.55) continue;
        const t = i / N, x = p.x + (q.x - p.x) * t, y = p.y + (q.y - p.y) * t;
        const ember = hash(i, bi, seed + 9) > 0.8;
        g.strokeStyle = ember ? 'rgba(255,110,40,0.55)' : 'rgba(8,5,4,0.55)';
        g.beginPath(); g.moveTo(x, y + 1); g.lineTo(x + 2, y + depth * 0.4); g.lineTo(x - 1.5, y + depth * 0.7); g.stroke();
      }
      g.restore();
      g.strokeStyle = lit; g.lineWidth = 1.4 / D; // lip
      g.beginPath(); g.moveTo(p.x, p.y + 0.5); g.lineTo(q.x, q.y + 0.5); g.stroke();
    };
    face(left, bot, '#3b2b24', ['rgba(0,0,0,0.12)', 'rgba(110,70,40,0.14)', 'rgba(0,0,0,0.18)', 'rgba(70,50,40,0.14)'], 'rgba(255,196,140,0.45)');
    face(bot, right, '#1f1613', ['rgba(0,0,0,0.14)', 'rgba(60,40,30,0.18)', 'rgba(0,0,0,0.2)', 'rgba(40,28,22,0.16)'], 'rgba(255,150,90,0.18)');
  }

  function tuft(g, p, n, lit, D) { // five blades of dry grass, lit from the top-left
    const base = 'rgb(54,46,26)', tipDry = 'rgb(196,152,84)', tipAcid = 'rgb(152,224,72)';
    const acid = n > 0.92;
    g.lineCap = 'round';
    for (let i = -2; i <= 2; i++) {
      const lean = i * 1.6 + (hash(i, Math.floor(n * 1000), 3) - 0.5) * 2, hgt = 6 + hash(Math.floor(n * 977), i, 5) * 5;
      g.strokeStyle = base; g.lineWidth = 1.5;
      g.beginPath(); g.moveTo(p.x + i * 1.9, p.y); g.lineTo(p.x + i * 1.9 + lean, p.y - hgt); g.stroke();
      g.strokeStyle = (acid && i % 2 === 0) ? tipAcid : tipDry; g.lineWidth = 0.9;
      g.beginPath(); g.moveTo(p.x + i * 1.9 + lean * 0.5, p.y - hgt * 0.55); g.lineTo(p.x + i * 1.9 + lean - (lit ? 0.4 : 0), p.y - hgt); g.stroke();
    }
    g.lineCap = 'butt';
  }

  function scrub(g, p, n) { // dead thorny twigs
    g.strokeStyle = '#120c08'; g.lineWidth = 2.1; g.lineCap = 'round';
    const br = [[0, -9, -4, -12], [0, -6, 4, -11], [0, -3, -6, -6], [-1, -9, 1, -15]];
    g.beginPath(); g.moveTo(p.x, p.y);
    g.lineTo(p.x - 0.5, p.y - 5);
    for (const [bx, by, ex, ey] of br) { g.moveTo(p.x + bx, p.y + by * 0.6); g.lineTo(p.x + ex, p.y + ey * (0.7 + n * 0.4)); }
    g.stroke();
    g.strokeStyle = 'rgb(112,80,52)'; g.lineWidth = 0.9;
    g.beginPath(); g.moveTo(p.x - 0.4, p.y); g.lineTo(p.x - 0.9, p.y - 5);
    for (const [bx, by, ex, ey] of br) { g.moveTo(p.x + bx - 0.3, p.y + by * 0.6); g.lineTo(p.x + ex - 0.3, p.y + ey * (0.7 + n * 0.4)); }
    g.stroke(); g.lineCap = 'butt';
  }

  function pebbles(g, p, n) {
    for (let i = 0; i < 3; i++) {
      const x = p.x + (hash(i, Math.floor(n * 999), 2) - 0.5) * 12, y = p.y + (hash(Math.floor(n * 999), i, 4) - 0.5) * 5, r = 1.4 + hash(i, 9, Math.floor(n * 99)) * 1.5;
      g.fillStyle = 'rgba(0,0,0,0.35)'; g.beginPath(); g.ellipse(x + 1.4, y + 1, r * 1.1, r * 0.55, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = 'rgb(88,78,72)'; g.beginPath(); g.ellipse(x, y - 0.4, r, r * 0.65, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = 'rgba(214,186,160,0.6)'; g.beginPath(); g.ellipse(x - r * 0.3, y - r * 0.35, r * 0.4, r * 0.22, 0, 0, Math.PI * 2); g.fill();
    }
  }

  function lichenMat(g, p, n) { // flat acid-green crust
    g.fillStyle = 'rgba(96,130,40,0.38)';
    for (let i = 0; i < 4; i++) {
      const x = p.x + (hash(i, Math.floor(n * 555), 6) - 0.5) * 12, y = p.y + (hash(Math.floor(n * 555), i, 7) - 0.5) * 5;
      g.beginPath(); g.ellipse(x, y, 3 + i % 2 * 1.5, 1.4 + i % 2 * 0.6, 0, 0, Math.PI * 2); g.fill();
    }
    g.fillStyle = 'rgba(166,255,60,0.5)';
    for (let i = 0; i < 3; i++) { g.beginPath(); g.arc(p.x + (i - 1) * 3.6, p.y + (i % 2) * 1.2, 0.8, 0, Math.PI * 2); g.fill(); }
  }

  // Footprint of one rock in world units, jittered per tile. Shared by the rock sprite and its baked shadow.
  function rockBase(x, y) {
    const j = k => (hash(x * 7 + k, y * 13 - k, 99) - 0.5) * 0.16, ins = 0.07;
    return [[x + ins + j(1), y + ins + j(2)], [x + 1 - ins + j(3), y + ins + j(4)], [x + 1 - ins + j(5), y + 1 - ins + j(6)], [x + ins + j(7), y + 1 - ins + j(8)]];
  }
  const rockHeight = n => 15 + n * 13;

  // strip (optional): { v0, v1 } view-space rows to paint, the caller has clipped the context to the same pixel rows. Everything that cannot touch the
  // strip is skipped, so a repaint can be spread over several frames (ant77) and the strips together equal one full paint.
  function paintLayer(g, P, state, t, tex, D, seed, strip) {
    const m = state.map, nests = state.players || [];
    const lo = strip ? strip.v0 - LAYER.CULL_PAD : -Infinity, hi = strip ? strip.v1 + LAYER.CULL_PAD : Infinity;
    const oy0 = P(0, 0).y, dyx = P(1, 0).y - oy0, dyy = P(0, 1).y - oy0; // view y of a tile corner is linear in (x, y)
    const tileOut = (x, y) => { const v = oy0 + dyx * x + dyy * y; return v < lo - 16 || v > hi + 16; };
    paintEdge(g, P, m, seed, D);
    // ground texture, drawn through the isometric affine
    const o = P(0, 0), ax = P(1, 0), ay = P(0, 1);
    if (tex && tex.canvas) {
      g.save();
      g.transform(ax.x - o.x, ax.y - o.y, ay.x - o.x, ay.y - o.y, o.x, o.y);
      g.imageSmoothingEnabled = true;
      g.drawImage(tex.canvas, 0, 0, m, m);
      g.restore();
    } else {
      g.fillStyle = rgba(PAL.mid, 1); g.beginPath();
      for (const [x, y] of [[0, 0], [m, 0], [m, m], [0, m]]) { const p = P(x, y); g.lineTo(p.x, p.y); }
      g.closePath(); g.fill();
    }
    // seams: the grid only suggested, broken here and there, with a faint lit line beside each
    const seg = (x0, y0, x1, y1, path) => { const a = P(x0, y0), b = P(x1, y1); path.moveTo(a.x, a.y); path.lineTo(b.x, b.y); };
    g.beginPath();
    for (let i = 1; i < m; i++) for (let k = 0; k < m; k++) {
      if (strip && tileOut(i, k) && tileOut(k, i)) continue;
      if (hash(i, k, seed + 21) > 0.2) seg(i, k, i, k + 1, g);
      if (hash(k, i, seed + 22) > 0.2) seg(k, i, k + 1, i, g);
    }
    g.strokeStyle = 'rgba(0,0,0,0.16)'; g.lineWidth = 1 / D; g.stroke();
    g.save(); g.translate(-1 / D, -1 / D); g.strokeStyle = 'rgba(255,190,130,0.045)'; g.stroke(); g.restore();
    // tufts, scrub, pebbles, lichen: skip rocks, mud and the packed earth round nests
    const cls = t ? t.cls : null;
    const nearNest = (x, y) => { for (const q of nests) if (Math.hypot(x + 0.5 - q.nest.x, y + 0.5 - q.nest.y) < 3.1) return true; return false; };
    const items = [];
    for (let y = 0; y < m; y++) for (let x = 0; x < m; x++) {
      if (cls && cls[y * m + x]) continue;
      if (strip && tileOut(x, y)) continue;
      if (nearNest(x, y)) continue;
      const n = hash(x, y, seed), n2 = hash(x * 3 + 1, y * 7 + 2, seed + 5);
      const jx = hash(x, y, seed + 31) * 0.5 + 0.25, jy = hash(x, y, seed + 32) * 0.5 + 0.25;
      let kind = 0;
      if (n > 0.84) kind = 1; else if (n > 0.70 && n < 0.76) kind = 2; else if (n2 > 0.93) kind = 3; else if (n2 < 0.045) kind = 4;
      if (kind) items.push([P(x + jx, y + jy), kind, n, n2]);
    }
    items.sort((a, b) => a[0].y - b[0].y); // back to front
    for (const [p, kind, n, n2] of items) {
      if (kind === 1) tuft(g, p, n, true, D); else if (kind === 2) scrub(g, p, n); else if (kind === 3) pebbles(g, p, n2); else lichenMat(g, p, n2);
    }
    // baked long shadows from the low sun: down and to the right, fading with distance
    if (t && t.rocks.length) {
      const dir = { x: 0.92, y: 0.38 };
      for (const pass of [[1, 0.10], [0.62, 0.11], [0.30, 0.12]]) {
        g.fillStyle = `rgba(6,3,6,${pass[1]})`;
        g.beginPath();
        for (const [x, y, n] of t.rocks) {
          if (strip && (oy0 + dyx * x + dyy * y > hi + 40 || oy0 + dyx * x + dyy * y < lo - 40 - rockHeight(n) * 1.7 * dir.y)) continue; // shadow tail runs down-right
          const h = rockHeight(n), len = h * 1.7 * pass[0], b = rockBase(x, y).map(([wx, wy]) => P(wx, wy));
          for (let s = 0; s <= 6; s++) {
            const k = len * s / 6;
            b.forEach((p, i) => (i ? g.lineTo(p.x + dir.x * k, p.y + dir.y * k) : g.moveTo(p.x + dir.x * k, p.y + dir.y * k)));
            g.closePath();
          }
        }
        g.fill();
      }
    }
    // rim light on the two far edges of the board (lit by the sun's side)
    // key light gradient: warm top-left, deepening to the bottom-right
    const B = layerBounds(m);
    g.save();
    g.globalCompositeOperation = 'source-atop';
    const gr = g.createLinearGradient(B.minU * 0.6, B.minV, B.maxU * 0.6, B.maxV);
    gr.addColorStop(0, 'rgba(255,170,96,0.15)'); gr.addColorStop(0.45, 'rgba(255,140,70,0)'); gr.addColorStop(1, 'rgba(0,0,0,0.24)');
    g.fillStyle = gr; g.fillRect(B.minU, B.minV, B.maxU - B.minU, B.maxV - B.minV);
    g.restore();
    applyTint(g, B.minU, B.minV, B.maxU - B.minU, B.maxV - B.minV);
  }

  function applyTint(g, x, y, w, h) {
    const tint = TOD[todName].tint;
    if (!tint || root.TimeOfDay) return; // ant19/tod: tod.js washes the whole world pass live, so nothing is baked per tint
    g.save(); g.globalCompositeOperation = 'source-atop'; g.fillStyle = tint; g.fillRect(x, y, w, h); g.restore();
  }

  // ---------- The board layer ----------
  const L = { key: '', base: '', canvas: null, w: 0, h: 0, D: 1, info: null, want: 0, wantAt: 0 };
  // Board layer knobs. SETTLE_MS / MAX_BLUR: see drawBoard. A density step that repaints the layer (ant77) paints into a second canvas a strip at a
  // time while the old layer keeps being blitted scaled: STRIP_PX pixels of layer per strip, at most STRIP_MS of painting per frame (always one strip),
  // CULL_PAD view units of slack around a strip for things that overhang their anchor (tufts, rock shadows).
  const LAYER = { MAX_PX: 4096 * 4096, SETTLE_MS: 250, MAX_BLUR: 1.7, STRIP_PX: 200000, STRIP_MS: 5, CULL_PAD: 40 };
  const MAX_LAYER_PX = LAYER.MAX_PX, SETTLE_MS = LAYER.SETTLE_MS, MAX_BLUR = LAYER.MAX_BLUR;
  let job = null; // a repaint in progress: { key, base, D, canvas, cw, ch, B, info, next (next layer row), rows (rows per strip), P, t, tex }
  const stripRows = cw => Math.max(16, Math.ceil(LAYER.STRIP_PX / cw));
  function paintStrip(g, j, state, y0, y1) {
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.save(); g.beginPath(); g.rect(0, y0, j.cw, y1 - y0); g.clip();
    g.setTransform(j.D, 0, 0, j.D, -j.B.minU * j.D, -j.B.minV * j.D);
    paintLayer(g, j.P, state, j.t, j.tex, j.D, state.seed, y0 === 0 && y1 >= j.ch ? null : { v0: j.B.minV + y0 / j.D, v1: j.B.minV + y1 / j.D });
    g.restore(); g.setTransform(1, 0, 0, 1, 0, 0);
  }
  function dropJob() { if (job) { releaseCanvas(job.canvas); job = null; } }
  function finishLayer(j, state, env) { // the new layer becomes the live one
    releaseCanvas(L.canvas);
    L.key = j.key; L.base = j.base; L.canvas = j.canvas; L.w = j.cw; L.h = j.ch; L.D = j.D;
    L.info = j.info;
    if (env.stats) env.stats.groundPaints++;
    for (const cb of rebuildCbs) { try { cb(L.info); } catch (e) { /* hooks never break the frame */ } }
  }

  // render.js drawGround(): blit the cached board. Returns false when this module cannot (no canvas): caller falls back.
  function drawBoard(ctx, state, env) {
    if (!doc || !state) return false;
    const m = state.map, toScreen = env.toScreen, scale = env.scale, dpr = env.dpr || 1;
    const flip = toScreen(1, 0).x - toScreen(0, 0).x < 0;
    const t = sync(state);
    const B = layerBounds(m), w1 = B.maxU - B.minU, h1 = B.maxV - B.minV;
    let D = 2 ** (Math.round(Math.log2(Math.max(0.05, scale * dpr)) * 4) / 4);
    D = Math.min(D, Math.sqrt(MAX_LAYER_PX / (w1 * h1)));
    const nestKey = (state.players || []).map(p => `${p.nest.x},${p.nest.y}`).join(';');
    const base = [state.seed, m, flip ? 1 : 0, t ? t.ver : 0, nestKey, todName, todVer].join('|');
    const key = base + '|' + D.toFixed(3);
    // While the zoom is still moving, a density step alone does not repaint: the old layer is blitted scaled (it is anyway) and the
    // repaint waits until the density has held for SETTLE_MS, or until the stale layer would be upscaled past MAX_BLUR.
    const now = typeof performance !== 'undefined' ? performance.now() : 0;
    if (D !== L.want) { L.want = D; L.wantAt = now; }
    const defer = L.key !== key && L.canvas && L.base === base && now - L.wantAt < SETTLE_MS && D / L.D < MAX_BLUR;
    if (job && job.key !== key) dropJob(); // the wanted layer changed again while one was painting
    if (L.key !== key && !defer) {
      const cw = Math.ceil(w1 * D), ch = Math.ceil(h1 * D);
      const info = { minU: B.minU, minV: B.minV, w: w1, h: h1, D, flip, map: m };
      if (L.canvas && L.base === base) { // same board, new density: paint a strip or two per frame, keep blitting the old layer meanwhile (ant77)
        const tj = performance.now(); if (!job) job = { key, base, D, canvas: (env.makeCanvas || makeCanvas)(cw, ch), cw, ch, B, info, next: 0, rows: stripRows(cw), P: projector(m, flip), t, tex: texture(t, state) };
        const g = job.canvas.getContext('2d'), t0 = performance.now();
        if (LAYER.trace) LAYER.trace.push(['setup', +(t0 - tj).toFixed(1)]);
        do {
          const y1 = Math.min(ch, job.next + job.rows), ts = performance.now();
          paintStrip(g, job, state, job.next, y1); job.next = y1;
          if (LAYER.trace) LAYER.trace.push(['strip', +(performance.now() - ts).toFixed(1), job.rows * job.cw]);
        } while (job.next < ch && performance.now() - t0 < LAYER.STRIP_MS);
        if (job.next >= ch) { const j = job; job = null; finishLayer(j, state, env); }
      } else { // nothing to show meanwhile (first paint, a new game, a changed terrain): all at once
        dropJob();
        const reuse = L.canvas && L.canvas.width === cw && L.canvas.height === ch, canvas = reuse ? L.canvas : (env.makeCanvas || makeCanvas)(cw, ch);
        if (!reuse) releaseCanvas(L.canvas);
        const g = canvas.getContext('2d');
        g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, cw, ch);
        g.setTransform(D, 0, 0, D, -B.minU * D, -B.minV * D);
        paintLayer(g, projector(m, flip), state, t, texture(t, state), D, state.seed);
        g.setTransform(1, 0, 0, 1, 0, 0);
        L.key = key; L.base = base; L.canvas = canvas; L.w = cw; L.h = ch; L.D = D; L.info = info;
        if (env.stats) env.stats.groundPaints++;
        for (const cb of rebuildCbs) { try { cb(L.info); } catch (e) { /* hooks never break the frame */ } }
      }
    }
    const o = toScreen(flip ? m : 0, flip ? m : 0); // world point whose unit-space coords are (0, 0)
    // ant68: blit only the part of the layer on screen. The layer is up to 4096x4096 px; handing a canvas that size to drawImage when a few
    // percent of it is visible costs Firefox milliseconds a frame (it samples, or uploads, far more than it shows).
    const dx = o.x + B.minU * scale, dy = o.y + B.minV * scale, dw = L.w / L.D * scale, dh = L.h / L.D * scale;
    const vw = env.viewW, vh = env.viewH, M = 12; // margin: earthquake shake, filter taps
    if (vw > 0 && vh > 0) {
      const sx0 = Math.max(0, Math.floor((-M - dx) / dw * L.w) - 2), sx1 = Math.min(L.w, Math.ceil((vw + M - dx) / dw * L.w) + 2);
      const sy0 = Math.max(0, Math.floor((-M - dy) / dh * L.h) - 2), sy1 = Math.min(L.h, Math.ceil((vh + M - dy) / dh * L.h) + 2);
      if (sx1 > sx0 && sy1 > sy0) ctx.drawImage(L.canvas, sx0, sy0, sx1 - sx0, sy1 - sy0, dx + sx0 / L.w * dw, dy + sy0 / L.h * dh, (sx1 - sx0) / L.w * dw, (sy1 - sy0) / L.h * dh);
      return true;
    }
    ctx.drawImage(L.canvas, dx, dy, dw, dh);
    return true;
  }

  // ---------- Rocks: cached sprites ----------
  const rockSprites = new Map();

  function paintRock(g, cx, cy, s, x, y, n, f, px) { // f: +1 normal board, -1 flipped; centre (cx, cy) = tile centre
    const P = (wx, wy) => ({ x: cx + f * (wx - x - 0.5 - (wy - y - 0.5)) * 32 * s, y: cy + f * ((wx - x - 0.5) + (wy - y - 0.5)) * 16 * s });
    const base = rockBase(x, y).map(([wx, wy]) => P(wx, wy));
    const h = rockHeight(n) * s;
    const top = base.map((p, i) => ({ x: p.x + (base[(i + 2) % 4].x - p.x) * 0.14, y: p.y - h + (base[(i + 2) % 4].y - p.y) * 0.14 }));
    let lo = 0;
    for (let i = 1; i < 4; i++) if (base[i].y > base[lo].y) lo = i;
    const l = (lo + 3) % 4, r = (lo + 1) % 4;
    const [left, right] = base[l].x < base[r].x ? [l, r] : [r, l];
    const poly = pts => { g.beginPath(); pts.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y))); g.closePath(); };
    const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    g.lineJoin = 'round';
    // faces: the sun-facing (left) side mid basalt, the right side dark; a talus band darkens the foot of each
    const tone = 0.85 + n * 0.3;
    const side = (a, b, ta, tb, col, foot, hi) => {
      poly([a, b, tb, ta]); g.fillStyle = col; g.fill();
      const fa = lerp(a, ta, 0.42), fb = lerp(b, tb, 0.42 + (hi ? 0.1 : -0.06)); // jagged ridge between face and talus
      poly([a, b, fb, fa]); g.fillStyle = foot; g.fill();
      g.strokeStyle = 'rgba(8,6,10,0.5)'; g.lineWidth = 0.9 * px;
      g.beginPath(); g.moveTo(fa.x, fa.y); g.lineTo(lerp(fa, fb, 0.5).x, lerp(fa, fb, 0.5).y - 1.2 * s); g.lineTo(fb.x, fb.y); g.stroke();
    };
    side(base[left], base[lo], top[left], top[lo], `rgb(${72 * tone | 0},${68 * tone | 0},${78 * tone | 0})`, 'rgba(10,8,14,0.34)', true);
    side(base[lo], base[right], top[lo], top[right], `rgb(${38 * tone | 0},${36 * tone | 0},${46 * tone | 0})`, 'rgba(6,4,10,0.4)', false);
    // lit top: basalt grey with a warm gradient from the sun's corner
    poly(top); g.fillStyle = `rgb(${128 * tone | 0},${122 * tone | 0},${134 * tone | 0})`; g.fill();
    g.save(); poly(top); g.clip();
    const tl = top.reduce((a, p) => (p.x + p.y < a.x + a.y ? p : a), top[0]), br = top.reduce((a, p) => (p.x + p.y > a.x + a.y ? p : a), top[0]);
    const shrink = (o, k) => top.map(p => ({ x: o.x + (p.x - o.x) * k, y: o.y + (p.y - o.y) * k }));
    poly(shrink(tl, 0.7)); g.fillStyle = 'rgba(255,190,130,0.16)'; g.fill(); // warm light stepping in from the sun's corner
    poly(shrink(tl, 0.42)); g.fillStyle = 'rgba(255,200,150,0.2)'; g.fill();
    poly(shrink(br, 0.45)); g.fillStyle = 'rgba(30,20,40,0.2)'; g.fill(); // the far corner falls into shade
    g.strokeStyle = 'rgba(28,22,30,0.5)'; g.lineWidth = 1.1 * px; // cracks
    g.beginPath();
    g.moveTo(top[0].x + (top[2].x - top[0].x) * (0.25 + n * 0.2), top[0].y + (top[2].y - top[0].y) * 0.25);
    g.lineTo(top[1].x + (top[3].x - top[1].x) * 0.55, top[1].y + (top[3].y - top[1].y) * (0.45 + n * 0.3));
    g.lineTo(top[2].x + (top[0].x - top[2].x) * 0.3, top[2].y + (top[0].y - top[2].y) * 0.5);
    g.stroke();
    g.restore();
    // ink outline and the lit lip on the sun side
    g.strokeStyle = PAL.ink; g.lineWidth = 1.1 * px;
    poly([base[left], base[lo], base[right], top[right], top[(lo + 2) % 4], top[left]]); g.stroke();
    poly(top); g.stroke();
    g.strokeStyle = 'rgba(255,214,170,0.7)'; g.lineWidth = 1.2 * px;
    const tlIdx = top.indexOf(tl);
    g.beginPath(); g.moveTo(top[(tlIdx + 3) % 4].x, top[(tlIdx + 3) % 4].y); g.lineTo(tl.x, tl.y); g.lineTo(top[(tlIdx + 1) % 4].x, top[(tlIdx + 1) % 4].y); g.stroke();
    // acid lichen on the shaded side, lit from within
    if (n > 0.3) {
      const a = lerp(base[lo], top[lo], 0.2), b2 = lerp(base[right], top[right], 0.22);
      const blobs = 2 + (n > 0.6 ? 1 : 0) + (n > 0.85 ? 1 : 0);
      for (let i = 0; i < blobs; i++) {
        const t = (i + 0.7) / (blobs + 0.4), p = lerp(a, b2, t), up = (0.15 + hash(i, x * 3 + y, 12) * 0.5) * h * 0.55;
        const rw = (3.4 + hash(i, y, x) * 2.6) * s;
        g.fillStyle = 'rgba(60,96,30,0.85)'; g.beginPath(); g.ellipse(p.x, p.y - up, rw, rw * 0.5, 0, 0, Math.PI * 2); g.fill();
        g.fillStyle = 'rgba(166,255,60,0.75)';
        for (let k = 0; k < 2; k++) { g.beginPath(); g.arc(p.x + (k - 0.5) * rw * 0.7, p.y - up + (k % 2 - 0.5) * rw * 0.2, 0.8 * s, 0, Math.PI * 2); g.fill(); }
        g.fillStyle = 'rgba(166,255,60,0.12)'; g.beginPath(); g.ellipse(p.x, p.y - up, rw * 1.8, rw, 0, 0, Math.PI * 2); g.fill();
      }
    }
    g.lineJoin = 'miter';
  }

  const ROCK_BOX = { L: 40, R: 40, T: 52, B: 24 };
  function spriteQ(scale) { const dpr = Math.min(2, root.devicePixelRatio || 1); return 2 ** (Math.round(Math.log2(Math.max(0.05, scale) * dpr) * 8) / 8); }
  // Rock sprites are painted at the sprite density q. A zoom step used to clear them all, so every rock in view was re-created
  // (a new canvas each) in the one frame after each step: the 25-50 ms hitch while scroll-zooming. Now an older-density sprite
  // is drawn scaled until the density has held ROCK_SETTLE_MS, then rocks re-bake ROCK_REBAKES per frame (rocks() resets it).
  const ROCK_SETTLE_MS = 200, ROCK_REBAKES = 4;
  let rockLook = '', rockQ = 0, rockQAt = 0, rockLeft = ROCK_REBAKES;
  // ant68: with ~1000 rocks in view the per-rock flip / density / look-key work (two toScreen calls, a log2, a template string, a clock read)
  // was a few percent of the frame. render.js drawWorld calls frame() once per frame and clears it after the rock loop.
  let FR = null;
  function frame(toScreen, scale) {
    if (!toScreen) { FR = null; return; }
    const flip = toScreen(1, 0).x - toScreen(0, 0).x < 0, q = spriteQ(scale);
    FR = { flip, q, base: `${flip ? 1 : 0}|${todName}|${todVer}`, now: typeof performance !== 'undefined' ? performance.now() : 0 };
  }
  function rockSprite(toScreen, scale, x, y, n) {
    const flip = FR ? FR.flip : toScreen(1, 0).x - toScreen(0, 0).x < 0, q = FR ? FR.q : spriteQ(scale);
    const base = FR ? FR.base : `${flip ? 1 : 0}|${todName}|${todVer}`;
    if (base !== rockLook) { rockLook = base; rockSprites.clear(); }
    const now = FR ? FR.now : typeof performance !== 'undefined' ? performance.now() : 0;
    if (q !== rockQ) { rockQ = q; rockQAt = now; }
    const id = y * 4096 + x;
    let S = rockSprites.get(id);
    if (S && (S.q === q || now - rockQAt < ROCK_SETTLE_MS || rockLeft <= 0)) return S; // current, or a stand-in at the old density
    if (S) rockLeft--;
    const Lp = Math.ceil(ROCK_BOX.L * q) + 2, Tp = Math.ceil(ROCK_BOX.T * q) + 2, w = Lp + Math.ceil(ROCK_BOX.R * q) + 2, h = Tp + Math.ceil(ROCK_BOX.B * q) + 2;
    const cv = makeCanvas(w, h), g = cv.getContext('2d');
    paintRock(g, Lp, Tp, q, x, y, n, flip ? -1 : 1, 1);
    applyTint(g, 0, 0, w, h);
    if (S) S.cv.width = 0;
    S = { cv, q, ox: Lp / q, oy: Tp / q, w: w / q, h: h / q };
    rockSprites.set(id, S);
    return S;
  }

  function drawRock(ctx, toScreen, scale, x, y, n) {
    if (!doc) { // no canvas to cache in (tests): paint straight onto the target
      const c = toScreen(x + 0.5, y + 0.5), flip = toScreen(1, 0).x - toScreen(0, 0).x < 0;
      paintRock(ctx, c.x, c.y, scale, x, y, n, flip ? -1 : 1, 1);
      return;
    }
    const S = rockSprite(toScreen, scale, x, y, n), c = toScreen(x + 0.5, y + 0.5);
    ctx.drawImage(S.cv, c.x - S.ox * scale, c.y - S.oy * scale, S.w * scale, S.h * scale);
  }

  // ---------- Baked rocks (ant70) ----------
  // Zoomed out, a Huge board has 1000-1500 rocks; one drawImage each cost 6-8 ms a frame in Firefox. Below ROCK_BAKE_ON (tile scale) the
  // rocks are painted once into a second cached layer (same bounds and density as the board layer, so it blits with the same crop) and
  // render.js skips their sprites. The layer fills ROCK_BAKE_PER_FRAME ms at a time, back to front; rocks not yet painted keep drawing as
  // sprites, so nothing pops. A dug rock repaints only its own box: clip, clear, repaint the rocks that touch it. Above ROCK_BAKE_OFF the
  // sprites return (ants walk behind rocks there, so rocks must be depth-sorted with them).
  const ROCK_BAKE_ON = 0.8, ROCK_BAKE_OFF = 0.9, ROCK_BAKE_MS = 4;
  const R = { canvas: null, w: 0, h: 0, key: '', ver: -1, on: false, order: null, next: 0, baked: new Set(), rocksRef: null, info: null };
  const rockId = r => r[1] * 4096 + r[0];
  function bakeCanBe() { return !!doc && !(TOD[todName].tint && !root.TimeOfDay); }
  function rockRect(info, c, pad) { // layer-pixel box of the rock whose tile centre is c (layer units)
    const D = info.D;
    return { x: Math.floor((c.x - info.minU - ROCK_BOX.L) * D) - pad, y: Math.floor((c.y - info.minV - ROCK_BOX.T) * D) - pad, w: Math.ceil((ROCK_BOX.L + ROCK_BOX.R) * D) + 2 * pad, h: Math.ceil((ROCK_BOX.T + ROCK_BOX.B) * D) + 2 * pad };
  }
  function bakeOne(g, info, P, r, flip) {
    const c = P(r[0] + 0.5, r[1] + 0.5);
    g.setTransform(info.D, 0, 0, info.D, -info.minU * info.D, -info.minV * info.D);
    paintRock(g, c.x, c.y, 1, r[0], r[1], r[2], flip ? -1 : 1, 1 / info.D);
  }
  // Returns the Set of baked rock ids to skip in the depth sort, or null when rocks draw as sprites. Call once per frame after drawBoard().
  function bakeRocks(ctx, state, env) {
    const info = L.info, t = sync(state);
    if (!info || !t || !L.canvas || !bakeCanBe()) { R.on = false; return null; }
    const scale = env.scale, dpr = env.dpr || 1;
    R.on = R.on ? scale < ROCK_BAKE_OFF : scale < ROCK_BAKE_ON;
    if (!R.on || L.D < scale * dpr * 0.7) return null; // layer capped well below the screen density (huge maps): sprites stay crisper
    const flip = info.flip, P = projector(info.map, flip);
    const key = [state.seed, info.map, flip ? 1 : 0, todName, todVer, info.D.toFixed(3), L.w, L.h].join('|');
    const first = R.key !== key || !R.canvas;
    if (first) {
      R.key = key; R.ver = t.ver; R.w = L.w; R.h = L.h; R.info = info; R.baked = new Set(); R.next = 0; R.rocksRef = t.rocks;
      if (R.canvas && R.canvas.width === R.w && R.canvas.height === R.h) { const g0 = R.canvas.getContext('2d'); g0.setTransform(1, 0, 0, 1, 0, 0); g0.clearRect(0, 0, R.w, R.h); }
      else { releaseCanvas(R.canvas); R.canvas = (env.makeCanvas || makeCanvas)(R.w, R.h); }
      const sgn = flip ? -1 : 1; // back to front: smaller screen y first
      R.order = t.rocks.slice().sort((a, b) => sgn * ((a[0] + a[1]) - (b[0] + b[1])));
    }
    const g = R.canvas.getContext('2d');
    if (!first && R.ver !== t.ver) { // terrain changed (a rock dug out): repaint just the boxes of rocks that left
      const cur = new Set(t.rocks.map(rockId)), gone = [];
      for (const id of R.baked) if (!cur.has(id)) gone.push(id);
      R.ver = t.ver; R.info = info;
      const sgn = flip ? -1 : 1;
      R.order = t.rocks.slice().sort((a, b) => sgn * ((a[0] + a[1]) - (b[0] + b[1])));
      R.next = 0; // the order list shifted; painted rocks are skipped by id
      for (const id of gone) {
        R.baked.delete(id);
        const x = id % 4096, y = (id / 4096) | 0, c = P(x + 0.5, y + 0.5), rc = rockRect(info, c, 2);
        g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.beginPath(); g.rect(rc.x, rc.y, rc.w, rc.h); g.clip(); g.clearRect(rc.x, rc.y, rc.w, rc.h);
        for (const r of R.order) {
          if (!R.baked.has(rockId(r))) continue;
          const c2 = P(r[0] + 0.5, r[1] + 0.5);
          if (Math.abs(c2.x - c.x) > ROCK_BOX.L + ROCK_BOX.R + 4 || Math.abs(c2.y - c.y) > ROCK_BOX.T + ROCK_BOX.B + 4) continue;
          bakeOne(g, info, P, r, flip);
        }
        g.restore();
      }
    }
    // progressive fill, in y order, within a time budget (the first frames still draw the rest as sprites)
    if (R.next < R.order.length) {
      const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
      g.save();
      let n = 0;
      while (R.next < R.order.length) {
        const r = R.order[R.next++];
        if (R.baked.has(rockId(r))) continue;
        bakeOne(g, info, P, r, flip); R.baked.add(rockId(r));
        if ((++n & 7) === 0 && typeof performance !== 'undefined' && performance.now() - t0 > ROCK_BAKE_MS) break;
      }
      g.restore();
    }
    // blit with the board layer's crop
    const m = info.map, toScreen = env.toScreen, o = toScreen(info.flip ? m : 0, info.flip ? m : 0);
    const dx = o.x + info.minU * scale, dy = o.y + info.minV * scale, dw = R.w / info.D * scale, dh = R.h / info.D * scale;
    const vw = env.viewW, vh = env.viewH, M = 12;
    if (vw > 0 && vh > 0) {
      const sx0 = Math.max(0, Math.floor((-M - dx) / dw * R.w) - 2), sx1 = Math.min(R.w, Math.ceil((vw + M - dx) / dw * R.w) + 2);
      const sy0 = Math.max(0, Math.floor((-M - dy) / dh * R.h) - 2), sy1 = Math.min(R.h, Math.ceil((vh + M - dy) / dh * R.h) + 2);
      if (sx1 > sx0 && sy1 > sy0) ctx.drawImage(R.canvas, sx0, sy0, sx1 - sx0, sy1 - sy0, dx + sx0 / R.w * dw, dy + sy0 / R.h * dh, (sx1 - sx0) / R.w * dw, (sy1 - sy0) / R.h * dh);
    } else ctx.drawImage(R.canvas, dx, dy, dw, dh);
    return R.baked;
  }

  // ---------- Legacy / fallback API (also what the node test exercises) ----------
  function ground(ctx, toScreen, scale, state) { // mud only; the real board is drawBoard()
    const t = sync(state);
    if (!t) return;
    for (const [x, y, n] of t.mud) {
      ctx.fillStyle = rgba([PAL.mud[0] + n * 8, PAL.mud[1] + n * 6, PAL.mud[2] + n * 6], 1);
      ctx.beginPath();
      [[x, y], [x + 1, y], [x + 1, y + 1], [x, y + 1]].forEach(([wx, wy], i) => { const p = toScreen(wx, wy); if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y); });
      ctx.closePath(); ctx.fill();
    }
  }

  function items(list, ctx, toScreen, scale, state) {
    const t = sync(state);
    if (!t) return;
    for (const [x, y, n] of t.rocks) list.push({ y: toScreen(x + 0.5, y + 0.5).y, draw: () => drawRock(ctx, toScreen, scale, x, y, n) });
  }

  // Map lookup for other client code (e.g. input previews): 0 open, 1 rock, 2 mud, or -1 when unknown.
  function at(state, x, y) {
    const t = sync(state);
    if (!t || x < 0 || y < 0 || x >= t.map || y >= t.map) return -1;
    return t.str.charCodeAt((y | 0) * t.map + (x | 0)) - 48;
  }

  // render.js: the rock list ([x, y, n] per rock tile) for its packed depth sort, and one rock's draw.
  function rocks(state) { rockLeft = ROCK_REBAKES; const t = sync(state); return t ? t.rocks : []; }
  function rock(ctx, toScreen, scale, r) { drawRock(ctx, toScreen, scale, r[0], r[1], r[2]); }

  // ant33: dig progress. A ring on the ground round each rock tile being chewed out (public: the enemy sees it and can come
  // and stop it) and cracks across the rock's top that spread with the percent. Drawn after the depth sort, over the rocks.
  function digRings(ctx, toScreen, scale, state) {
    const digs = state && state.digs;
    if (!digs || !digs.length) return;
    for (const [tx, ty, pct] of digs) {
      const c = toScreen(tx + 0.5, ty + 0.5), k = Math.max(0, Math.min(1, pct / 100));
      const rx = 22 * scale, ry = 11 * scale, top = c.y - 9 * scale; // the rock's top face sits a little above its tile centre
      ctx.save();
      ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(18,12,8,0.75)'; ctx.lineWidth = 5 * scale;
      ctx.beginPath(); ctx.ellipse(c.x, c.y, rx, ry, 0, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = '#ffb84a'; ctx.lineWidth = 3 * scale;
      ctx.beginPath(); ctx.ellipse(c.x, c.y, rx, ry, 0, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * k); ctx.stroke();
      ctx.strokeStyle = 'rgba(14,10,9,0.85)'; ctx.lineWidth = 1.6 * scale; // cracks: more of them as it nears open
      const cracks = 1 + Math.floor(k * 4);
      for (let i = 0; i < cracks; i++) {
        const a = hash(tx, ty, i + 5) * Math.PI * 2, r = (6 + 7 * hash(tx, ty, i + 9)) * scale;
        ctx.beginPath(); ctx.moveTo(c.x, top);
        ctx.lineTo(c.x + Math.cos(a) * r * 0.5, top + Math.sin(a) * r * 0.25);
        ctx.lineTo(c.x + Math.cos(a + 0.4) * r, top + Math.sin(a + 0.4) * r * 0.5);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  // ---------- Time of day, overlay, hooks ----------
  function setTod(name) { if (TOD[name] && name !== todName) { todName = name; todVer++; } return todName; }
  function overlay(ctx, w, h) { // night only: a faint cool wash over the world (before the fog)
    const sky = TOD[todName].sky;
    if (!sky) return;
    ctx.fillStyle = sky; ctx.fillRect(0, 0, w || root.innerWidth || 0, h || root.innerHeight || 0);
  }
  // World points of the baked ember fissures (for smoke / ember sparks from the ambient lane).
  function emitters(state) {
    const t = sync(state);
    if (!t) return [];
    const tex = texture(t, state);
    return tex.emitters.map(([x, y]) => ({ x, y, kind: 'fissure' }));
  }

  root.TerrainDraw = {
    ground, items, at, rocks, rock, rockId, bakeRocks, frame, digRings, drawBoard, layerCfg: LAYER, layerPending: () => !!job, buildTexture, layerBounds, paintLayer, projector, texelsPerTile, ROCK_BOX, paintRock, applyTint,
    palette: PAL, TOD,
    tod: () => TOD[todName], setTod, overlay, emitters,
    ambient: () => !reduced(), // false in Reduced motion: ambient motion must stand still
    tileKind: at, layerInfo: () => L.info, onRebuild: cb => rebuildCbs.push(cb),
    glowScale: () => TOD[todName].glow, version: () => todVer,
  };
})(typeof window !== 'undefined' ? window : globalThis);
