// Minimap: the whole board in the bottom-right corner. Loaded after input.js.
// Shows nests, food, ants, aphid farms and spiders (objectives.js), team pings, event danger zones and the camera's view box.
// Click or drag on it to move the camera there (from the overview it also zooms in).
// Right-click gives the selection a smart order there (Shift queues); right-drag gives it a formation line.
// Uses client.js globals at draw time (curr, mySide, ox, oy, scale, toScreen, COLORS) and camera.js.
(function (root) {
  const TW = 64, TH = 32, PING_MS = 4000;

  // View space (see camera.js) -> minimap pixels. The board diamond fills the width.
  function minimapMath(map, w, pad = 4) {
    const ms = (w - 2 * pad) / (map * TW);
    return {
      ms, w, h: Math.ceil(map * TH * ms + 2 * pad),
      toMini: (u, v) => ({ x: w / 2 + u * ms, y: pad + v * ms }),
      fromMini: (x, y) => ({ u: (x - w / 2) / ms, v: (y - pad) / ms }),
    };
  }
  if (typeof module !== 'undefined' && module.exports) { module.exports = { minimapMath }; return; }

  const doc = root.document;
  const box = doc.getElementById('minimap'), cv = doc.getElementById('mm');
  if (!box || !cv) return;
  const g = cv.getContext('2d');
  const pings = []; // { from, kind, x, y, at }
  let rdrag = null; // right-drag on the minimap: { a, b: world points, start: first event, sx, sy, ex, ey: minimap px }

  // Record team pings for the minimap and Camera.jumpPing. pings.js keeps drawing them on the board.
  if (root.Pings && Pings.onMessage) {
    const orig = Pings.onMessage;
    Pings.onMessage = m => {
      if (m.type === 'start') pings.length = 0;
      if (m.type === 'ping' && typeof m.x === 'number') {
        const p = { from: m.from, kind: m.kind, x: m.x, y: m.y, at: performance.now() };
        pings.push(p); if (pings.length > 12) pings.shift();
        if (root.Camera) Camera.lastPing = p;
      }
      return orig(m);
    };
  }

  let mm = null, sizedFor = '';
  function size() {
    const w = innerWidth < 720 ? 132 : 196, dpr = devicePixelRatio || 1, key = `${curr.map}|${w}|${dpr}`;
    if (key === sizedFor) return;
    sizedFor = key;
    mm = minimapMath(curr.map, w);
    cv.width = w * dpr; cv.height = mm.h * dpr;
    cv.style.width = w + 'px'; cv.style.height = mm.h + 'px';
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  // World tile -> minimap pixel, through the main transform so the board flip always matches.
  const view = (x, y) => { const p = toScreen(x, y); return { u: (p.x - ox) / scale, v: (p.y - oy) / scale }; };
  const at = (x, y) => { const q = view(x, y); return mm.toMini(q.u, q.v); };
  const poly = pts => { g.beginPath(); pts.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y))); g.closePath(); };
  const dot = (p, r, fill, stroke) => { g.beginPath(); g.arc(p.x, p.y, r, 0, Math.PI * 2); g.fillStyle = fill; g.fill(); if (stroke) { g.strokeStyle = stroke; g.lineWidth = 1; g.stroke(); } };

  function draw(now) {
    const m = curr.map, pulse = .5 + .5 * (globalThis.motionSin || Math.sin)(now / 120);
    g.clearRect(0, 0, mm.w, mm.h);
    if (root.UIWorld) UIWorld.miniBase(g, mm, at, m); // ant19/ui-world: cached field, grid and rim
    else {
    poly([at(0, 0), at(m, 0), at(m, m), at(0, m)]);
    g.fillStyle = '#4a382c'; g.fill(); g.strokeStyle = '#a86a3a'; g.lineWidth = 1.5; g.stroke(); // ant18/ground: scorched dusk field, ember rim
    }

    // Danger zones: flood river (or its warning), anteater lane, beetle target.
    const w = curr.warn;
    if (curr.flood || (w && w.id === 'flood')) {
      const half = curr.flood || 1.3, d = half * Math.SQRT2, k1 = m - d, k2 = m + d;
      poly([[0, k1], [0, m], [k2 - m, m], [m, k2 - m], [m, 0], [k1, 0]].map(([x, y]) => at(x, y)));
      if (curr.flood) { g.fillStyle = 'rgba(60,130,230,.75)'; g.fill(); }
      else { g.strokeStyle = `rgba(90,160,255,${.5 + .5 * pulse})`; g.lineWidth = 2; g.stroke(); }
    }
    if (w && w.line) {
      const a = at(w.line[0][0], w.line[0][1]), b = at(w.line[1][0], w.line[1][1]);
      g.strokeStyle = `rgba(240,50,40,${.45 + .5 * pulse})`; g.lineWidth = 5; g.lineCap = 'round';
      g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke(); g.lineCap = 'butt';
    }
    if (w && w.id === 'beetle' && w.target != null && curr.players[w.target]) {
      const n = curr.players[w.target].nest, c = at(n.x, n.y);
      g.strokeStyle = `rgba(240,50,40,${.5 + .5 * pulse})`; g.lineWidth = 2;
      g.beginPath(); g.ellipse(c.x, c.y, 11, 6, 0, 0, Math.PI * 2); g.stroke();
    }

    for (const f of curr.food) { // f: [id, x, y, amount, kind] kind 1 pellets, 2 rich centre pile, 3 crumb (not shown)
      if (f[4] === 3) continue;
      if (f[4] === 1) { // ant76: pellet piles are big, bright blue rings with a white core so they show on a Huge map
        const c = at(f[1], f[2]);
        g.beginPath(); g.arc(c.x, c.y, 6, 0, Math.PI * 2);
        g.fillStyle = '#1e7bff'; g.fill(); g.lineWidth = 2; g.strokeStyle = '#ffffff'; g.stroke();
        g.beginPath(); g.arc(c.x, c.y, 2, 0, Math.PI * 2); g.fillStyle = '#bfe0ff'; g.fill();
        continue;
      }
      const r = Math.min(3.5, 1 + Math.sqrt(f[3]) / 4);
      dot(at(f[1], f[2]), r, f[4] === 2 ? '#f0d86a' : '#a8e05e');
    }
    if (root.Objectives) Objectives.drawMini(g, at, pulse); // ant16: aphid farms, spiders
    curr.players.forEach((p, i) => {
      const c = at(p.nest.x, p.nest.y);
      if (root.UIWorld) UIWorld.miniNest(g, c, COLORS[i], p.alive);
      else {
      g.fillStyle = p.alive ? COLORS[i] : '#5c4630'; g.strokeStyle = '#1b1610'; g.lineWidth = 1.5;
      g.fillRect(c.x - 5, c.y - 4, 10, 8); g.strokeRect(c.x - 5, c.y - 4, 10, 8);
      }
      if (p.alive && p.nest.hp < p.nest.max) { g.fillStyle = 'rgba(0,0,0,.6)'; g.fillRect(c.x - 5, c.y - 8, 10, 2); g.fillStyle = COLORS[i]; g.fillRect(c.x - 5, c.y - 8, 10 * p.nest.hp / p.nest.max, 2); }
    });
    if (root.Fog) Fog.drawOn(g, at, typeof view === 'function' ? view(now).to : curr); // ant16 fog: same picture as the board
    const picked = typeof sel !== 'undefined' && sel && typeof sel.has === 'function' ? sel : null;
    if (root.UIWorld) UIWorld.miniAnts(g, curr.ants, at, COLORS, picked);
    else for (const a of curr.ants) {
      const c = at(a[3], a[4]), r = a[2] ? 1.9 : 1.3;
      g.fillStyle = picked && picked.has(a[0]) ? '#ffffff' : COLORS[a[1]];
      g.fillRect(c.x - r, c.y - r, r * 2, r * 2);
    }
    if (curr.anteater) dot(at(curr.anteater.x, curr.anteater.y), 4, '#3a2f26', '#ff5a4a');
    if (curr.beetle) dot(at(curr.beetle.x, curr.beetle.y), 3.5, '#2b5a3a', '#ff5a4a');

    while (pings.length && now - pings[0].at > PING_MS) pings.shift();
    for (const p of pings) {
      const c = at(p.x, p.y), t = ((now - p.at) / 900) % 1;
      if (root.UIWorld) { UIWorld.miniPing(g, c, COLORS[p.from], t); continue; }
      g.strokeStyle = COLORS[p.from]; g.lineWidth = 2; g.globalAlpha = 1 - t;
      g.beginPath(); g.arc(c.x, c.y, 3 + 9 * t, 0, Math.PI * 2); g.stroke();
      g.globalAlpha = 1; dot(c, 2.5, COLORS[p.from]);
    }

    if (rdrag && Math.hypot(rdrag.ex - rdrag.sx, rdrag.ey - rdrag.sy) > 4) { // formation line being dragged
      g.strokeStyle = '#ff9a4a'; g.lineWidth = 2; g.setLineDash([4, 3]);
      g.beginPath(); g.moveTo(rdrag.sx, rdrag.sy); g.lineTo(rdrag.ex, rdrag.ey); g.stroke(); g.setLineDash([]);
    }

    // The camera's view box (only interesting once zoomed in).
    if (root.Camera && !Camera.isOverview()) {
      const a = mm.toMini((0 - ox) / scale, (0 - oy) / scale), b = mm.toMini((innerWidth - ox) / scale, (innerHeight - oy) / scale);
      if (root.UIWorld) UIWorld.miniView(g, a.x, a.y, b.x - a.x, b.y - a.y);
      else { g.strokeStyle = 'rgba(255,255,255,.9)'; g.lineWidth = 1.5;
      g.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y); }
    }
  }

  function loop(now) {
    requestAnimationFrame(loop);
    const show = typeof curr !== 'undefined' && !!curr;
    box.classList.toggle('hidden', !show);
    if (!show) return;
    size();
    const pf0 = root.Perf && Perf.t0(); // ant68: overlay timing
    draw(now);
    if (pf0) Perf.add('minimap', pf0);
  }
  requestAnimationFrame(loop);

  // Click / drag on the minimap moves the camera there.
  let dragging = false;
  const jump = (e, first) => {
    if (!root.Camera || !mm) return;
    const r = cv.getBoundingClientRect(), q = mm.fromMini(e.clientX - r.left, e.clientY - r.top);
    Camera.focusView(q.u, q.v, first && Camera.targetZoom() < 2 ? 2.2 : undefined);
  };
  // Right-click = what a right-click on the board there would do (Shift queues); the camera stays put.
  // Right-DRAG = a formation line between the two points (Orders.line), like a right-drag on the board.
  const LINE_MIN = 0.6; // tiles; a shorter drag is a plain click (input.js uses the same)
  const worldAt = e => { // minimap pointer -> world tile (unclamped)
    const r = cv.getBoundingClientRect(), q = mm.fromMini(e.clientX - r.left, e.clientY - r.top);
    return screenToWorld(ox + q.u * scale, oy + q.v * scale);
  };
  const order = e => {
    if (!mm || !root.Orders || !Orders.smart) return;
    const w = worldAt(e);
    if (w.x < 0 || w.y < 0 || w.x > curr.map || w.y > curr.map) return;
    Orders.smart(w, e.shiftKey);
  };
  const lineOrder = (d, e) => {
    const cl = v => Math.max(0, Math.min(curr.map, v));
    const line = [cl(d.a.x), cl(d.a.y), cl(d.b.x), cl(d.b.y)];
    if (Math.hypot(line[2] - line[0], line[3] - line[1]) < LINE_MIN) { order(d.start); return; }
    Orders.line(line, e.shiftKey, e.ctrlKey || e.metaKey);
  };
  cv.addEventListener('pointerdown', e => {
    e.preventDefault(); e.stopPropagation();
    if (e.button === 2) {
      if (!mm || !root.Orders || !Orders.line) { order(e); return; }
      const r = cv.getBoundingClientRect(), w = worldAt(e);
      rdrag = { a: w, b: w, start: e, sx: e.clientX - r.left, sy: e.clientY - r.top, ex: e.clientX - r.left, ey: e.clientY - r.top };
      try { cv.setPointerCapture(e.pointerId); } catch (_) {}
      return;
    }
    if (e.button !== 0) return; dragging = true; try { cv.setPointerCapture(e.pointerId); } catch (_) {} jump(e, true);
  });
  cv.addEventListener('pointermove', e => {
    if (dragging) jump(e, false);
    if (rdrag) { const r = cv.getBoundingClientRect(); rdrag.b = worldAt(e); rdrag.ex = e.clientX - r.left; rdrag.ey = e.clientY - r.top; }
  });
  cv.addEventListener('pointerup', e => {
    dragging = false;
    const d = rdrag; rdrag = null;
    if (d && e.button === 2) lineOrder(d, e);
  });
  cv.addEventListener('pointercancel', () => { dragging = false; rdrag = null; });
  cv.addEventListener('contextmenu', e => e.preventDefault());
  cv.addEventListener('wheel', e => { e.preventDefault(); if (root.Camera) Camera.zoomAt(Math.exp(-Math.sign(e.deltaY) * 0.25), innerWidth / 2, innerHeight / 2); }, { passive: false });

  root.Minimap = { minimapMath, pings };
})(typeof window !== 'undefined' ? window : globalThis);
