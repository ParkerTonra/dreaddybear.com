// PNG ant atlases (art direction B, docs/art-overhaul.md section 3): the seam that lets a caste's sprite cells come from a pre-rendered
// PNG (offline 3D, hand art) instead of the procedural painter in unit-art.js. render.js asks sheet(side, type) when it builds an atlas;
// a ready sheet makes the atlas copy whole heading pages out of the PNG, anything else (nothing registered, still loading, failed to
// load, wrong layout) leaves the painter in charge, so a missing or broken PNG can never leave a caste invisible.
//
// Sheet layout (same as a painted atlas page, heading pages stacked top to bottom):
//   page `bin` = rows (y from bin * rows * ch)   cell (col, row) = (col * cw, bin * rows * ch + row * ch), size cw x ch
//   col = gait (0..gait-1), row = antenna wiggle x pose + corpse row: ANTENNA * 2 + 1 rows (see render.js antAtlas)
//   Compact sheets (ant58 memory): a manifest may list `rows` DISTINCT rows plus `rowMap` (7 entries: logical row -> stored row), e.g. a caste whose
//   antenna/pose rows are one picture stores 2 rows (normal, corpse) with rowMap [0,0,0,0,0,0,1]. Then page `bin` starts at y = bin * rows * ch.
//   Image size = (gait * cw) x (bins * rows * ch). Each cell is the ant facing +x (screen right) with the light baked for its bin.
// Manifest entry (JSON, or register() argument):
//   { type: 'worker' | 0, side?: 0..3 (omit = every colony), src: 'worker.png', k, cw, ch, ox, oy, gait, rows, bins }
//   k = device pixels per ant-unit in the sheet, size factor included (the painter's atlas k = q * UNITS[type].size); ox, oy = where the
//   ant's origin sits inside a cell. render.js stamps at the real zoom by scaling k down or up, so a sheet needs no repaint on zoom.
//   screenHeading: true (ant64 tilted camera): row i is the ant ALREADY turned to screen angle i * 360 / bins (a 3/4 view, not rotatable like a top-down
//   one), so the game turns the cell only by the residual heading - i * 360 / bins; without it every cell faces +x and is turned by the whole heading.
//   hi (ant71, optional): a 2x tier for close zoom, loaded lazily. { src, k, cw, ch, ox, oy, gait, rows, bins, rowMap } with the same fields as the sheet itself;
//   fewer gait columns (the game maps its 9 onto them) and rowMap entries of -1 for rows the tier does not carry (corpses: they keep the 1x cell).
//   hi(side, type, ratio) is asked per frame with ratio = device px per ant unit on screen / the 1x sheet's k: below HI_PREFETCH it does nothing, from there on
//   it starts the download and decode (into an ImageBitmap, so the switch never decodes mid-frame), above HI_USE it returns the ready tier. Decoded bytes of
//   loaded tiers stay under HI_CAP (least recently used goes first, never one used in the last second) and every tier is released HI_IDLE_MS after the zoom left it.
(function (root) {
  'use strict';
  const HI_PREFETCH = 0.8, HI_USE = 1.05, HI_CAP = 200e6, HI_IDLE_MS = 8000, HI_BUSY_MS = 1000;
  const nowMs = () => (root.performance && root.performance.now ? root.performance.now() : Date.now());
  const entries = new Map(); // 'side:type' or 'type' -> { m, img, state: 'loading' | 'ready' | 'failed' }
  const hiOk = h => !!h && typeof h.src === 'string' && ['k', 'cw', 'ch', 'gait', 'rows', 'bins'].every(f => Number.isFinite(h[f]) && h[f] > 0) && Number.isFinite(h.ox) && Number.isFinite(h.oy) && Array.isArray(h.rowMap) && h.rowMap.length === 7;
  const hiSize = m => m.gait * m.cw * m.bins * m.rows * m.ch * 4; // decoded bytes
  function dropHi(e) {
    const h = e.hi;
    if (!h || h.state === 'idle') return;
    if (h.img && h.img.close) h.img.close();
    h.img = null; h.S = null; h.state = 'idle'; h.gen = (h.gen || 0) + 1; // a decode still in flight sees the new generation and discards itself
  }
  function loadHi(e, base) {
    const h = e.hi, m = h.m, gen = h.gen = (h.gen || 0) + 1;
    h.state = 'loading';
    const img = api.imageFactory(), fail = () => { if (h.gen === gen) { h.state = 'failed'; if (root.console) console.warn('atlas-loader: could not load 2x tier ' + m.src); } };
    const done = pic => {
      if (h.gen !== gen) { if (pic && pic.close) pic.close(); return; }
      const w = pic.naturalWidth || pic.width, hh = pic.naturalHeight || pic.height;
      if (w !== m.gait * m.cw || hh !== m.bins * m.rows * m.ch) return fail(); // the PNG does not match its manifest
      h.img = pic; h.S = { img: pic, k: m.k, cw: m.cw, ch: m.ch, ox: m.ox, oy: m.oy, gait: m.gait, rows: m.rows, bins: m.bins, rowMap: m.rowMap };
      h.state = 'ready';
    };
    img.onload = () => {
      if (h.gen !== gen) return;
      if (root.createImageBitmap && typeof root.createImageBitmap === 'function') root.createImageBitmap(img).then(done, fail); else done(img);
    };
    img.onerror = fail;
    img.crossOrigin = 'anonymous';
    img.src = (base || '') + m.src;
  }
  const api = {
    ver: 0, // bumps whenever a sheet becomes ready or is removed: render.js rebuilds the affected atlases
    imageFactory: () => new root.Image(), // tests replace it
    typeIndex(type) {
      if (Number.isInteger(type) && type >= 0) return type;
      const U = root.UnitArt && root.UnitArt.UNITS;
      const i = U ? U.findIndex(u => u.id === type) : -1;
      return i;
    },
    key(side, type) { return side == null ? String(type) : side + ':' + type; },
    // Start loading one sheet. Returns the entry (state flips to 'ready' or 'failed'), or null for a manifest that cannot be used.
    register(m, base = '') {
      const t = api.typeIndex(m && m.type);
      const pos = f => Number.isFinite(m[f]) && m[f] > 0;
      const ok = m && t >= 0 && typeof m.src === 'string' && ['k', 'cw', 'ch', 'gait', 'rows', 'bins'].every(pos) && Number.isFinite(m.ox) && Number.isFinite(m.oy);
      if (!ok) return null;
      const e = { m: Object.assign({}, m, { type: t }), img: null, state: 'loading', base, hi: hiOk(m.hi) ? { m: m.hi, state: 'idle', used: 0, img: null, S: null } : null };
      const key = api.key(m.side, t);
      entries.set(key, e);
      const img = e.img = api.imageFactory();
      img.onload = () => {
        if (entries.get(key) !== e) return;
        e.state = 'ready'; api.ver++;
        // Decode once into an ImageBitmap and let the <img> go: the page draws from the bitmap (resident, no re-decode per frame), and the
        // browser holds one decoded copy per sheet. e.S.img swaps in place, so atlases that already hold the sheet pick the bitmap up.
        if (root.createImageBitmap && typeof root.createImageBitmap === 'function') root.createImageBitmap(img).then(b => { if (entries.get(key) === e) { e.img = b; if (e.S) e.S.img = b; } else if (b.close) b.close(); }, () => {});
      };
      img.onerror = () => { if (entries.get(key) === e) { e.state = 'failed'; if (root.console) console.warn('atlas-loader: could not load ' + m.src + '; the painter stays in charge'); } };
      img.crossOrigin = 'anonymous'; // before src: sheets from another origin (a CDN) stay readable by the canvas
      img.src = base + m.src;
      return e;
    },
    HI_CAP, HI_USE, HI_PREFETCH, HI_IDLE_MS,
    hiBytes() { let n = 0; for (const e of entries.values()) if (e.hi && e.hi.state !== 'idle' && e.hi.state !== 'failed') n += hiSize(e.hi.m); return n; },
    hiStats() { const o = {}; for (const [k, e] of entries) if (e.hi) o[k] = e.hi.state; return o; },
    // The 2x tier of (side, type) for the given on-screen ratio, or null (the caller stamps the 1x sheet).
    hi(side, type, ratio, now = nowMs()) {
      const t = api.typeIndex(type), e = entries.get(api.key(side, t)) || entries.get(api.key(null, t));
      if (!e || !e.hi || e.state !== 'ready' || ratio < HI_PREFETCH) return null;
      const h = e.hi;
      h.used = now;
      if (h.state === 'idle') {
        const need = hiSize(h.m);
        if (api.hiBytes() + need > HI_CAP) { // make room: oldest tiers not drawn in the last second
          const old = [...entries.values()].filter(x => x.hi && x.hi.state === 'ready' && now - x.hi.used > HI_BUSY_MS).sort((a, b) => a.hi.used - b.hi.used);
          for (const x of old) { if (api.hiBytes() + need <= HI_CAP) break; dropHi(x); }
          if (api.hiBytes() + need > HI_CAP) return null; // everything loaded is in use: stay on 1x
        }
        loadHi(e, e.base);
      }
      if (h.state !== 'ready' || ratio < HI_USE) return null;
      return h.S;
    },
    // Release tiers nobody has asked for lately (the zoom went back out). Called by the loader's own timer.
    trimHi(now = nowMs()) { for (const e of entries.values()) if (e.hi && e.hi.state === 'ready' && now - e.hi.used > HI_IDLE_MS) dropHi(e); },
    remove(side, type) { const k = api.key(side, api.typeIndex(type)); const e = entries.get(k); if (e) dropHi(e); if (entries.delete(k)) api.ver++; },
    clear() { if (entries.size) { for (const e of entries.values()) dropHi(e); entries.clear(); api.ver++; } },
    // The ready sheet for a colony and caste whose layout is `gait` x `rows`, or null (painter). A per-colony entry wins over an all-colony one.
    sheet(side, type, gait, rows) {
      const e = entries.get(api.key(side, type)) || entries.get(api.key(null, type));
      if (!e || e.state !== 'ready') return null;
      const m = e.m, img = e.img;
      const rm = Array.isArray(m.rowMap) && m.rowMap.length === rows && m.rowMap.every(r => Number.isInteger(r) && r >= 0 && r < m.rows) ? m.rowMap : null;
      if (m.gait !== gait || (rm ? false : m.rows !== rows)) return null;
      if (e.S) return e.S;
      const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
      if (w !== m.gait * m.cw || h !== m.bins * m.rows * m.ch) return null; // the PNG does not match its manifest
      return (e.S = { img, k: m.k, cw: m.cw, ch: m.ch, ox: m.ox, oy: m.oy, gait: m.gait, rows: m.rows, bins: m.bins, rowMap: rm, screen: !!m.screenHeading });
    },
    state(side, type) { const e = entries.get(api.key(side, api.typeIndex(type))) || entries.get(api.key(null, api.typeIndex(type))); return e ? e.state : 'none'; },
    // Fetch a manifest ({ sheets: [entry, ...] }) and register every sheet; src is resolved next to the manifest. Resolves to the number
    // of sheets registered, 0 on any failure (the painter carries on).
    async loadManifest(url, fetchFn = root.fetch && root.fetch.bind(root)) {
      try {
        const res = await fetchFn(url, { cache: 'no-cache' }); // always revalidate: sheet file names carry a content hash, so a new bake is picked up at once
        if (!res.ok) return 0;
        const j = await res.json(), base = url.slice(0, url.lastIndexOf('/') + 1);
        let n = 0;
        for (const m of (j && j.sheets) || []) if (api.register(m, base)) n++;
        return n;
      } catch (_) { return 0; }
    },
  };
  if (root.setInterval) { const t = root.setInterval(() => api.trimHi(), 2000); if (t && t.unref) t.unref(); }
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.AtlasLoader = api;
  // ant46 bake-tool: the baked atlases in assets/atlas/ (tools/bake-atlas.js) load by default; a missing manifest or PNG leaves the painter
  // in charge. ?atlas=<manifest url> loads another manifest instead, ?atlas=none turns baked sheets off (the bake tool itself uses it).
  try {
    const q = root.location && /[?&]atlas=([\w./-]+)/.exec(root.location.search || '');
    const url = q ? q[1] : 'assets/atlas/manifest.json';
    if (url !== 'none' && !url.includes('..') && !url.startsWith('/') && root.location && root.fetch) api.loadManifest(url);
  } catch (_) { /* no location (tests) */ }
})(typeof window !== 'undefined' ? window : globalThis);
