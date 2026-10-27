// Under-attack alert for ants (control B5): own ants lose health while their spot is off-screen -> a toast, one sound,
// a minimap pulse, and Camera.lastPing so the view.ping key (`) jumps there. Client-only, from consecutive snapshots.
// Loaded after minimap.js (shares its ping list). Pure detection is exported for tests.
(function (root) {
  const IDX_HP = 7, IDX_FLASH = 8;
  const MIN_DROP = 10, CLUSTER = 4, GAP_MS = 15000; // hp points per cluster, tiles, one alert per 15 s

  // prev, curr: snapshots. offscreen(x, y) -> true when that world point is outside the view (never in overview mode).
  // Returns { x, y, drop } for the worst cluster of hurt ants, or null.
  function detect(prev, curr, side, offscreen) {
    if (!prev || !curr || side < 0 || !curr.ants || !prev.ants) return null;
    const was = new Map();
    for (const a of prev.ants) if (a[1] === side) was.set(a[0], a);
    const hurt = [];
    for (const a of curr.ants) {
      if (a[1] !== side) continue;
      const p = was.get(a[0]);
      let drop = p ? p[IDX_HP] - a[IDX_HP] : 0;
      if (!(drop > 0) && a[IDX_FLASH] > 0) drop = 2; // flashing from a hit but health unchanged at this resolution
      if (drop > 0 && offscreen(a[3], a[4])) hurt.push({ x: a[3], y: a[4], drop });
    }
    const clusters = [];
    for (const h of hurt) {
      const c = clusters.find(k => Math.hypot(k.x - h.x, k.y - h.y) < CLUSTER);
      if (c) { c.x = (c.x * c.n + h.x) / (c.n + 1); c.y = (c.y * c.n + h.y) / (c.n + 1); c.n++; c.drop += h.drop; }
      else clusters.push({ x: h.x, y: h.y, n: 1, drop: h.drop });
    }
    let best = null;
    for (const c of clusters) if (c.drop >= MIN_DROP && (!best || c.drop > best.drop)) best = c;
    return best && { x: best.x, y: best.y, drop: best.drop };
  }

  let lastAt = -1e9;
  // Throttle shared by tests: true (and arms the timer) when an alert may fire at `now`.
  function allow(now) { if (now - lastAt < GAP_MS) return false; lastAt = now; return true; }
  function reset() { lastAt = -1e9; }

  const api = { detect, allow, reset, MIN_DROP, CLUSTER, GAP_MS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (!root.document || typeof root.toScreen !== 'function') return;

  const offscreen = (x, y) => {
    if (root.Camera && Camera.isOverview && Camera.isOverview()) return false;
    const c = toScreen(x, y), m = 12;
    return c.x < -m || c.y < -m || c.x > innerWidth + m || c.y > innerHeight + m;
  };
  api.onState = (prev, curr, side) => {
    const hit = detect(prev, curr, side, offscreen);
    const now = performance.now();
    if (!hit || !allow(now)) return;
    if (root.hudToast) hudToast(`⚔ Your ants are under attack <small>[${root.Keys ? Keys.label('view.ping') : '`'}] jump there</small>`, 3500, '#ff5a4a');
    if (root.Sound) Sound.play('underAttack');
    const p = { from: side, kind: 'alert', x: hit.x, y: hit.y, at: now };
    if (root.Minimap && Minimap.pings) { Minimap.pings.push(p); if (Minimap.pings.length > 12) Minimap.pings.shift(); }
    if (root.Camera) Camera.lastPing = p; // newest of {alert, team ping}: a later ping simply replaces it
  };
  root.Alerts = api;
})(typeof window !== 'undefined' ? window : globalThis);
