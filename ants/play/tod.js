// Time of day (ant19/tod, docs/art-overhaul.md section 8 phase 2). The match seed picks a start (dawn, noon or dusk) and the
// clock (state.t, seconds) drifts half a keyframe over a 15 minute match. ONE tint, applied once per frame as a source-atop
// wash over everything the world pass drew (ground, rocks, nests, food, structures, ants, creatures, decals), so nothing is
// baked per tint: the cached ground layer, rock sprites and atlases never re-bake when the clock moves (terrain-draw.js
// applyTint defers to this module). Night stays behind the existing `?tod=night` URL option (taste call 1). `?tod=dawn|noon|dusk`
// pins a phase (screenshots, tests).
//   TimeOfDay.overlay(ctx, w, h, state)   render.js drawWorld(), after the depth-sorted pass, before fog
//   TimeOfDay.startIndex(seed) / phase(seed, t) / tintAt(p) / tintFor(seed, t) / nameAt(p)   pure
//   TimeOfDay.washRgb(rgb, tint) / deltaE(rgbA, rgbB) / luminance(rgb)                       pure helpers for the readability tests
(function (root) {
  const DAY = 900;               // seconds of match the drift is spread over (the 15 minute match)
  const DRIFT = 0.5;             // keyframe steps travelled over DAY
  // p: keyframe index (dawn 0, noon 1, dusk 2); late dusk is where a dusk start ends after DAY. [r, g, b] wash colour, a its strength.
  const KEYS = [
    { p: 0, name: 'dawn', r: 255, g: 150, b: 92, a: 0.16 },
    { p: 1, name: 'noon', r: 255, g: 244, b: 214, a: 0.04 },
    { p: 2, name: 'dusk', r: 214, g: 96, b: 112, a: 0.15 },
    { p: 2.5, name: 'dusk', r: 150, g: 70, b: 130, a: 0.2 },
  ];
  const NIGHT = { p: 3, name: 'night', r: 14, g: 26, b: 72, a: 0.4 }; // URL only
  const MAX_P = KEYS[KEYS.length - 1].p;
  const lerp = (a, b, t) => a + (b - a) * t;

  function startIndex(seed) { // 0 dawn, 1 noon, 2 dusk, stable per seed
    let h = (Math.imul((seed | 0) ^ 0x9e3779b9, 2654435761) ^ 0x85ebca6b) | 0;
    h = Math.imul(h ^ (h >>> 15), 2246822519); h ^= h >>> 13;
    return (h >>> 0) % 3;
  }
  function phase(seed, t) { return Math.min(MAX_P, startIndex(seed) + DRIFT * Math.max(0, t || 0) / DAY); }
  function tintAt(p) {
    p = Math.max(0, Math.min(MAX_P, p));
    let i = 0;
    while (i < KEYS.length - 2 && p > KEYS[i + 1].p) i++;
    const A = KEYS[i], B = KEYS[i + 1], k = Math.max(0, Math.min(1, (p - A.p) / (B.p - A.p)));
    return { r: lerp(A.r, B.r, k), g: lerp(A.g, B.g, k), b: lerp(A.b, B.b, k), a: lerp(A.a, B.a, k), name: k < 0.5 ? A.name : B.name };
  }
  function nameAt(p) { return tintAt(p).name; }

  // URL option: ?tod=dawn|noon|dusk|night pins the phase.
  let forced = null;
  try {
    const q = root.location && /[?&]tod=(dawn|noon|dusk|night)\b/.exec(root.location.search || '');
    if (q) forced = q[1];
  } catch (e) { /* no location */ }
  const PIN = { dawn: 0, noon: 1, dusk: 2 };
  function setForce(name) { forced = name || null; }

  function tintFor(seed, t) {
    const night = forced === 'night' || (!forced && root.TerrainDraw && root.TerrainDraw.tod && root.TerrainDraw.tod().name === 'night');
    if (night) return Object.assign({}, NIGHT);
    if (forced) return tintAt(PIN[forced]);
    return tintAt(phase(seed, t));
  }

  // The same wash the canvas applies, on one colour: lerp toward the wash colour by its alpha.
  function washRgb(c, T) { return [lerp(c[0], T.r, T.a), lerp(c[1], T.g, T.a), lerp(c[2], T.b, T.a)]; }
  const lin = v => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  function lab(c) {
    const r = lin(c[0]), g = lin(c[1]), b = lin(c[2]);
    const X = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047, Y = r * 0.2126 + g * 0.7152 + b * 0.0722, Z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
    const f = v => (v > 216 / 24389 ? Math.cbrt(v) : (24389 / 27 * v + 16) / 116);
    return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
  }
  function deltaE(a, b) { const p = lab(a), q = lab(b); return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]); } // CIE76
  function luminance(c) { return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]); }

  // Per-frame wash. The fill style string is rebuilt only when the quantised tint changes (a few hundred times per match at most).
  let styleKey = '', style = '';
  function overlay(ctx, w, h, state) {
    if (!state) return false;
    const T = tintFor(state.seed, state.t);
    const key = `${Math.round(T.r)},${Math.round(T.g)},${Math.round(T.b)},${Math.round(T.a * 200)}`;
    if (key !== styleKey) { styleKey = key; style = `rgba(${Math.round(T.r)},${Math.round(T.g)},${Math.round(T.b)},${(Math.round(T.a * 200) / 200).toFixed(3)})`; }
    ctx.save();
    ctx.globalCompositeOperation = 'source-atop'; // only where the world drew: the empty space round the board stays transparent
    ctx.fillStyle = style;
    ctx.fillRect(0, 0, w || root.innerWidth || 0, h || root.innerHeight || 0);
    ctx.restore();
    return true;
  }

  const api = { DAY, DRIFT, KEYS, NIGHT, startIndex, phase, tintAt, nameAt, tintFor, setForce, overlay, washRgb, deltaE, luminance, forced: () => forced };
  root.TimeOfDay = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);