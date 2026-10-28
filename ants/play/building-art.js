// Building sprites rendered from Quaternius CC0 models (tools/blender/render-building.py): the seam world-art.js uses to paint a structure
// from one PNG sheet instead of the code-drawn painter. A missing, loading or broken sheet leaves the painter in charge (same promise as
// atlas-loader.js), so a building can never go invisible.
//   assets/buildings/buildings.json   { src, k, cw, ch, ox, oy, cells: { garden, depot, mound, site -> column }, rows: { base, mask } }
//   buildings.png                     row 0 = full-colour cells (team cue mid grey), row 1 = masks (alpha = team cue only); k px per game px
//   BuildingArt.paint(g, c, s, name, color)  draw cell `name` onto g with the ground centre at c, s sprite px per game px, the team cue
//                                            multiplied with `color`; returns false (nothing drawn) until the sheet is ready.
(function (root) {
  'use strict';
  let m = null, img = null, state = 'none';
  const api = {
    ver: 0, // bumps when the sheet becomes ready or is cleared: world-art.js drops its cached sprites
    imageFactory: () => new root.Image(),
    makeCanvas: (w, h) => { const c = root.document.createElement('canvas'); c.width = w; c.height = h; return c; },
    state: () => state,
    ready: () => state === 'ready',
    has: name => state === 'ready' && m.cells && Number.isInteger(m.cells[name]),
    register(man, base = '') {
      const pos = f => Number.isFinite(man[f]) && man[f] > 0;
      if (!man || typeof man.src !== 'string' || !['k', 'cw', 'ch'].every(pos) || !Number.isFinite(man.ox) || !Number.isFinite(man.oy) || !man.cells || !man.rows) return false;
      m = man; state = 'loading';
      const mine = img = api.imageFactory();
      mine.onload = () => {
        if (img !== mine) return;
        const w = mine.naturalWidth || mine.width, h = mine.naturalHeight || mine.height, n = Object.keys(m.cells).length;
        if (w !== n * m.cw * m.k || h !== 2 * m.ch * m.k) { state = 'failed'; return; } // the PNG does not match its manifest
        state = 'ready'; api.ver++;
        // one decoded copy: the page draws from an ImageBitmap and lets the <img> go
        if (typeof root.createImageBitmap === 'function') root.createImageBitmap(mine).then(b => { if (img === mine) img = b; else if (b.close) b.close(); }, () => {});
      };
      mine.onerror = () => { if (img === mine) { state = 'failed'; if (root.console) console.warn('building-art: could not load ' + man.src + '; the painter stays in charge'); } };
      mine.crossOrigin = 'anonymous';
      mine.src = base + man.src;
      return true;
    },
    clear() { const was = state === 'ready'; m = null; img = null; state = 'none'; if (was) api.ver++; },
    async load(url, fetchFn = root.fetch && root.fetch.bind(root)) {
      try {
        const res = await fetchFn(url, { cache: 'no-cache' });
        if (!res.ok) return false;
        return api.register(await res.json(), url.slice(0, url.lastIndexOf('/') + 1));
      } catch (_) { return false; }
    },
    paint(g, c, s, name, color) {
      if (!api.has(name)) return false;
      const col = m.cells[name], w = m.cw * m.k, h = m.ch * m.k, dw = m.cw * s, dh = m.ch * s, dx = c.x - m.ox * s, dy = c.y - m.oy * s;
      g.drawImage(img, col * w, 0, w, h, dx, dy, dw, dh);
      if (color) { // team cue: the mask silhouette in the colony colour, multiplied into the grey flag
        const t = api.makeCanvas(Math.max(1, Math.ceil(dw)), Math.max(1, Math.ceil(dh))), tg = t.getContext('2d');
        tg.drawImage(img, col * w, h, w, h, 0, 0, t.width, t.height);
        tg.globalCompositeOperation = 'source-in'; tg.fillStyle = color; tg.fillRect(0, 0, t.width, t.height);
        const prev = g.globalCompositeOperation;
        g.globalCompositeOperation = 'multiply'; g.drawImage(t, dx, dy, dw, dh); g.globalCompositeOperation = prev;
      }
      return true;
    },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.BuildingArt = api;
  try { // assets/buildings/buildings.json loads by default; ?buildings=none keeps the painter (the compare tool uses it)
    const q = root.location && /[?&]buildings=([\w./-]+)/.exec(root.location.search || '');
    const url = q ? q[1] : 'assets/buildings/buildings.json';
    if (url !== 'none' && !url.includes('..') && !url.startsWith('/') && root.location && root.fetch) api.load(url);
  } catch (_) { /* no location (tests) */ }
})(typeof window !== 'undefined' ? window : globalThis);
