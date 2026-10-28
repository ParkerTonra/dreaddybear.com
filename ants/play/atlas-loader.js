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
(function (root) {
  'use strict';
  const entries = new Map(); // 'side:type' or 'type' -> { m, img, state: 'loading' | 'ready' | 'failed' }
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
      const e = { m: Object.assign({}, m, { type: t }), img: null, state: 'loading' };
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
    remove(side, type) { const k = api.key(side, api.typeIndex(type)); if (entries.delete(k)) api.ver++; },
    clear() { if (entries.size) { entries.clear(); api.ver++; } },
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
      return (e.S = { img, k: m.k, cw: m.cw, ch: m.ch, ox: m.ox, oy: m.oy, gait: m.gait, rows: m.rows, bins: m.bins, rowMap: rm });
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
