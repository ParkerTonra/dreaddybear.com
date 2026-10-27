// Fog of war, page side (and the grid codec the server shares). The server sends each seat only what its
// team sees (fog.js at the top level) plus `fog: { v, dead }` in every snapshot: v is the team's vision grid
// (one bit per tile, encoded below), dead the ids of ants that died where this team could see them. A
// snapshot without `fog` (spectators, finished matches) shows everything.
// Drawing is one drawImage per frame: a tiny map x map canvas (one pixel per tile) is rebuilt when a new
// grid arrives and stretched over the board through the isometric transform, so smoothing gives soft edges.
// Tiles this page has seen before are dimmed, never-seen tiles are darker. Works in Node for the codec.
(function (root) {
  // 6 bits per character, URL-safe alphabet.
  const ABC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const REV = {}; for (let i = 0; i < 64; i++) REV[ABC[i]] = i;

  function encode(grid) {
    let s = '';
    for (let i = 0; i < grid.length; i += 6) {
      let c = 0;
      for (let b = 0; b < 6; b++) if (grid[i + b]) c |= 1 << b;
      s += ABC[c];
    }
    return s;
  }
  function decode(s, n, out = new Uint8Array(n)) {
    for (let i = 0; i < n; i++) out[i] = (REV[s[(i / 6) | 0]] >> (i % 6)) & 1;
    return out;
  }

  // ant17: SUB pixels per tile, each blended from the 4 nearest tile centres, so vision edges are rounded
  // instead of stair-stepped; seen-before and never-seen are further apart so the difference reads.
  const api = { encode, decode, ALPHA_SEEN: 0.4, ALPHA_DARK: 0.74, SUB: 3, TINT: [14, 9, 18] }; // ant18/ground: dusk violet-black (was cold navy 8,12,22); alphas unchanged so the fog reads the same
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; return; }

  const doc = root.document;
  const F = { key: '', seed: null, map: 0, grid: null, explored: null, canvas: null, img: null, rebuilds: 0 };

  // Rebuild the fog canvas from a snapshot's grid (cheap: (SUB*map)^2 pixels, at most once per snapshot).
  function sync(s) {
    if (!s || !s.fog) return false;
    const m = s.map, n = m * m, S = api.SUB, w = m * S;
    if (F.seed !== s.seed || F.map !== m) {
      F.seed = s.seed; F.map = m; F.key = '';
      F.grid = new Uint8Array(n); F.explored = new Uint8Array(n);
      F.canvas = doc.createElement('canvas'); F.canvas.width = w; F.canvas.height = w;
      F.img = F.canvas.getContext('2d').createImageData(w, w);
    }
    if (F.key === s.fog.v) return true;
    F.key = s.fog.v;
    decode(s.fog.v, n, F.grid);
    for (let i = 0; i < n; i++) if (F.grid[i]) F.explored[i] = 1;
    const d = F.img.data, seen = api.ALPHA_SEEN * 255, dark = api.ALPHA_DARK * 255, G = F.grid, E = F.explored;
    const at = (arr, x, y) => arr[Math.min(m - 1, Math.max(0, y)) * m + Math.min(m - 1, Math.max(0, x))];
    for (let py = 0; py < w; py++) {
      const fy = (py + 0.5) / S - 0.5, y0 = Math.floor(fy), ty = fy - y0;
      for (let px = 0; px < w; px++) {
        const fx = (px + 0.5) / S - 0.5, x0 = Math.floor(fx), tx = fx - x0;
        const lerp = arr => (at(arr, x0, y0) * (1 - tx) + at(arr, x0 + 1, y0) * tx) * (1 - ty) + (at(arr, x0, y0 + 1) * (1 - tx) + at(arr, x0 + 1, y0 + 1) * tx) * ty;
        const vis = lerp(G), exp = lerp(E);
        const j = (py * w + px) * 4;
        d[j] = api.TINT[0]; d[j + 1] = api.TINT[1]; d[j + 2] = api.TINT[2];
        d[j + 3] = Math.round((1 - vis) * (dark - (dark - seen) * exp));
      }
    }
    F.canvas.getContext('2d').putImageData(F.img, 0, 0);
    F.rebuilds++;
    return true;
  }

  // Stretch the fog canvas over the board. `at(x, y)` maps a world point to the target canvas (affine).
  function drawOn(g, at, s) {
    if (!sync(s)) return;
    const o = at(0, 0), ux = at(1, 0), uy = at(0, 1);
    g.save();
    g.transform(ux.x - o.x, ux.y - o.y, uy.x - o.x, uy.y - o.y, o.x, o.y);
    g.imageSmoothingEnabled = true;
    g.drawImage(F.canvas, 0, 0, F.map, F.map); // the SUB*map canvas stretches to map world units
    g.restore();
  }

  // Is world point (x, y) inside this team's current vision? (true when there is no fog)
  function visible(s, x, y) {
    if (!s || !s.fog || !F.grid || F.seed !== s.seed) return true;
    const m = F.map, cx = Math.min(m - 1, Math.max(0, Math.floor(x))), cy = Math.min(m - 1, Math.max(0, Math.floor(y)));
    return !!F.grid[cy * m + cx];
  }

  root.Fog = Object.assign(api, { state: F, sync, drawOn, visible });
})(typeof window !== 'undefined' ? window : globalThis);
