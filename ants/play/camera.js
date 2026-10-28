// Ant Arena camera: pan + zoom with easing and clamps. Loaded BEFORE client.js.
// The world<->screen transform stays in client.js (toScreen / screenToWorld). The camera only
// supplies its parameters (scale, ox, oy), so drawing and clicks always agree.
//
// It works in "view space": scale-free isometric coordinates where screen = o + view * scale.
// The board is a diamond centred on view (0, map*TH/2), whatever the flip.
//   Controls: wheel / pinch zoom at the cursor · middle-drag, right-drag or two-finger drag pans
//   Arrow keys or W/A/S/D pan (Shift+W/A/S/D are unit commands) · + / - zoom · 0 overview · Space your nest (again: overview) · C last ping
(function (root) {
  const TW = 64, TH = 32;

  function createCamera(opts = {}) {
    const minZoom = opts.minZoom || 1;
    // ant67: the old fixed 4x felt too far out once the 3D ants were worth a close look. Max is 8x on a small board; on a big one the
    // fit scale is tiny (Huge ~0.14), so the max grows until the tile scale (fit * zoom) can reach MAX_SCALE, the same close-up everywhere.
    const MAX_SCALE = 6, ZOOM_FLOOR = 8, ZOOM_CEIL = 48;
    let maxZoom = opts.maxZoom || ZOOM_FLOOR;
    let map = 24, fit = 1, ax = 0, ay = 0; // fit scale and the anchor (screen point the view centre sits on)
    let z = 1, tz = 1;                      // current / target zoom
    let cu = 0, cv = 0, tu = 0, tv = 0;    // current / target view centre
    let anchor = null;                      // { sx, sy, qu, qv } keeps a point under the cursor while zoom eases
    let keyU = 0, keyV = 0;                 // held-key (arrows / WASD) pan direction

    const homeV = () => map * TH / 2;
    const clampZ = v => Math.max(minZoom, Math.min(maxZoom, v));
    // The view centre may move away from the board centre by (1 - 1/zoom) of the half extent,
    // so the board edge can reach the screen edge but never leaves a gap past it.
    function clampC(u, v, zoom) {
      const k = 1 - 1 / zoom, hu = map * TW / 2 * k, hv = map * TH / 2 * k;
      return [Math.max(-hu, Math.min(hu, u)), Math.max(homeV() - hv, Math.min(homeV() + hv, v))];
    }
    const s = () => fit * z;

    const cam = {
      TW, TH,
      maxZoom: () => maxZoom,
      // Same fit as the original client.js resize(): whole board between the top HUD and bottom bar.
      layout(m, w, h, top = 90, bottom = 100) {
        if (m !== map) { map = m; cam.reset(true); }
        fit = Math.max(0.05, Math.min(w / (m * TW) * 0.96, (h - top - bottom) / (m * TH)));
        ax = w / 2; ay = top + (h - top - bottom) / 2;
        if (!opts.maxZoom) { maxZoom = Math.min(ZOOM_CEIL, Math.max(ZOOM_FLOOR, MAX_SCALE / fit)); tz = clampZ(tz); }
      },
      reset(instant) {
        tz = 1; tu = 0; tv = homeV(); anchor = null;
        if (instant) { z = tz; cu = tu; cv = tv; }
      },
      params() { return { scale: s(), ox: ax - cu * s(), oy: ay - cv * s() }; },
      zoom: () => z,
      targetZoom: () => tz,
      isOverview: () => tz <= minZoom + 1e-3,
      screenToView(sx, sy) { const p = cam.params(); return { u: (sx - p.ox) / p.scale, v: (sy - p.oy) / p.scale }; },
      viewToScreen(u, v) { const p = cam.params(); return { x: p.ox + u * p.scale, y: p.oy + v * p.scale }; },
      // Zoom by `factor` keeping the point under (sx, sy) fixed while the zoom eases in.
      zoomAt(factor, sx, sy) {
        const q = cam.screenToView(sx, sy);
        tz = clampZ(tz * factor);
        anchor = { sx, sy, qu: q.u, qv: q.v };
        if (tz <= minZoom + 1e-3) { anchor = null; tu = 0; tv = homeV(); }
      },
      // Immediate pan by a screen-pixel delta (drags feel 1:1).
      panBy(dx, dy) {
        anchor = null;
        [cu, cv] = clampC(cu - dx / s(), cv - dy / s(), z);
        [tu, tv] = clampC(cu, cv, tz);
      },
      // Eased: put view point (u, v) at the screen anchor, at `zoom` (defaults to the current target).
      focusView(u, v, zoom) {
        anchor = null;
        if (zoom) tz = clampZ(zoom);
        [tu, tv] = clampC(u, v, tz);
      },
      focusScreen(sx, sy, zoom) { const q = cam.screenToView(sx, sy); cam.focusView(q.u, q.v, zoom); },
      // Is screen point (sx, sy) already near the view centre at a close zoom?
      isFocusedOn(sx, sy) { const q = cam.screenToView(sx, sy); return tz > 1.5 && Math.hypot(q.u - tu, q.v - tv) < 40; },
      setKeyPan(u, v) { keyU = u; keyV = v; },
      // Advance easing by dt seconds. Returns true while anything is still moving.
      update(dt) {
        dt = Math.max(0, Math.min(0.1, dt || 0));
        if (keyU || keyV) { // ~ 900 screen px per second, whatever the zoom
          anchor = null;
          const len = Math.hypot(keyU, keyV), sp = 900 / (fit * tz) * dt / len;
          [tu, tv] = clampC(tu + keyU * sp, tv + keyV * sp, tz);
        }
        const k = 1 - Math.exp(-dt * 14);
        z += (tz - z) * k;
        if (Math.abs(tz - z) < 1e-4) z = tz;
        if (anchor) { // solve for the centre that keeps the anchored view point under the cursor
          const at = zoom => clampC(anchor.qu - (anchor.sx - ax) / (fit * zoom), anchor.qv - (anchor.sy - ay) / (fit * zoom), zoom);
          [cu, cv] = at(z); [tu, tv] = at(tz);
          if (z === tz) anchor = null;
        } else {
          cu += (tu - cu) * k; cv += (tv - cv) * k;
          if (Math.hypot(tu - cu, tv - cv) < 0.01) { cu = tu; cv = tv; }
        }
        [cu, cv] = clampC(cu, cv, z);
        return z !== tz || cu !== tu || cv !== tv || !!(keyU || keyV);
      },
      // Called once per frame from client.js: advances easing and returns { scale, ox, oy }.
      frame(now) {
        const dt = cam._last ? (now - cam._last) / 1000 : 0;
        cam._last = now;
        cam.update(dt);
        return cam.params();
      },
    };
    cam.reset(true);
    return cam;
  }

  const api = { createCamera, TW, TH };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; return; }
  const Camera = root.Camera = createCamera();
  root.createCamera = createCamera;

  // ---------- Browser controls (canvas #c; client.js globals like curr/mySide are read at event time) ----------
  const doc = root.document, canvas = doc && doc.getElementById('c');
  if (!canvas) return;
  const inMatch = () => typeof curr !== 'undefined' && curr;
  const typing = e => e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA');

  canvas.addEventListener('wheel', e => {
    if (!inMatch()) return;
    e.preventDefault();
    const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
    Camera.zoomAt(Math.exp(-Math.max(-300, Math.min(300, dy)) * 0.0018), e.clientX, e.clientY);
  }, { passive: false });

  // Mouse pans with the middle or right button. Window capture runs before input.js's canvas
  // listeners, so a right-DRAG is swallowed there and never becomes a right-click order. With ants selected a
  // right-drag belongs to input.js instead (a formation line, ant17), so only the middle button pans then.
  let mpan = null; // { id, x, y, moved }
  const selecting = () => !!(root.Orders && root.Orders.selected && root.Orders.selected().length);
  const touches = new Map(); // pointerId -> { x, y } for touch pointers on the canvas
  let pinch = null;          // { d, mx, my } last two-finger distance and midpoint
  let pinching = false;      // true from the second finger down until every finger is up
  const cancelInputDrag = () => { try { canvas.dispatchEvent(new root.PointerEvent('pointercancel')); } catch (_) { canvas.dispatchEvent(new root.Event('pointercancel')); } };
  const two = () => { const [a, b] = [...touches.values()]; return { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 }; };

  root.addEventListener('pointerdown', e => {
    if (e.target !== canvas || !inMatch()) return;
    if (e.pointerType === 'touch') {
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.size === 2) { pinch = two(); pinching = true; cancelInputDrag(); } // second finger: pan/pinch, not a tap
      if (pinching) e.stopPropagation();
      return;
    }
    if (e.button === 1 || (e.button === 2 && !selecting())) {
      mpan = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false, button: e.button };
      if (e.button === 1) e.preventDefault(); // no autoscroll
    }
  }, true);
  root.addEventListener('pointermove', e => {
    if (touches.has(e.pointerId)) {
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && touches.size >= 2) {
        const n = two();
        Camera.panBy(n.mx - pinch.mx, n.my - pinch.my);
        if (Math.abs(n.d / pinch.d - 1) > 0.002) Camera.zoomAt(n.d / pinch.d, n.mx, n.my);
        pinch = n;
        e.stopPropagation();
      } else if (pinching) e.stopPropagation(); // a finger left over from a pinch never draws a box
      return;
    }
    if (!mpan || e.pointerId !== mpan.id) return;
    const dx = e.clientX - mpan.x, dy = e.clientY - mpan.y;
    if (!mpan.moved && Math.hypot(dx, dy) < 6) return;
    if (!mpan.moved) { mpan.moved = true; canvas.style.cursor = 'grabbing'; }
    Camera.panBy(dx, dy);
    mpan.x = e.clientX; mpan.y = e.clientY;
  }, true);
  const endPointer = e => {
    if (touches.has(e.pointerId)) {
      touches.delete(e.pointerId);
      if (pinching) e.stopPropagation();
      if (touches.size < 2) pinch = null;
      if (!touches.size) pinching = false;
      return;
    }
    if (mpan && e.pointerId === mpan.id) {
      if (mpan.moved) { e.stopPropagation(); canvas.style.cursor = ''; }
      mpan = null;
    }
  };
  root.addEventListener('pointerup', endPointer, true);
  root.addEventListener('pointercancel', e => { if (e.isTrusted !== false) endPointer(e); }, true);

  // ---------- Keys: arrows and WASD pan, +/- zoom, 0 overview, Space nest, ` last ping (C spawns spitters) ----------
  const held = new Set();
  const PAN = { 'pan.left': [-1, 0], 'pan.right': [1, 0], 'pan.up': [0, -1], 'pan.down': [0, 1] };
  const syncKeys = () => { let u = 0, v = 0; for (const k of held) { u += PAN[k][0]; v += PAN[k][1]; } Camera.setKeyPan(u, v); };
  root.addEventListener('keydown', e => {
    if (typing(e) || !inMatch()) return;
    const pan = Object.keys(PAN).find(id => Keys.is(e, id));
    if (pan) { e.preventDefault(); held.add(pan); syncKeys(); return; }
    const cx = root.innerWidth / 2, cy = root.innerHeight / 2;
    if (Keys.is(e, 'zoom.in')) Camera.zoomAt(1.35, cx, cy);
    else if (Keys.is(e, 'zoom.out')) Camera.zoomAt(1 / 1.35, cx, cy);
    else if (Keys.is(e, 'view.all')) Camera.reset();
    else if (Keys.is(e, 'view.nest')) { // blur first, or a focused button would also click on Space
      e.preventDefault();
      const f = doc.activeElement; if (f && f.tagName === 'BUTTON') f.blur();
      Camera.jumpHome();
    }
    else if (Keys.is(e, 'view.ping')) Camera.jumpPing();
  });
  root.addEventListener('keyup', e => { let hit = false; for (const id of Object.keys(PAN)) if (Keys.codeIs(e, id) && held.delete(id)) hit = true; if (hit) syncKeys(); });
  root.addEventListener('blur', () => { held.clear(); syncKeys(); });

  // Jump helpers (also used by the minimap and the help overlay buttons).
  const focusWorld = (x, y, zoom) => { const p = toScreen(x, y); Camera.focusScreen(p.x, p.y, zoom); };
  Camera.focusWorld = (x, y, zoom) => focusWorld(x, y, Math.max(zoom || 0, Camera.targetZoom() < 2 ? 2.2 : Camera.targetZoom()));
  Camera.jumpHome = () => {
    if (!inMatch() || typeof mySide === 'undefined' || mySide < 0) { Camera.reset(); return; }
    const n = curr.players[mySide].nest, p = toScreen(n.x, n.y);
    if (Camera.isFocusedOn(p.x, p.y)) Camera.reset(); else Camera.focusWorld(n.x, n.y);
  };
  Camera.lastPing = null; // { from, kind, x, y, at } set by minimap.js from ping messages
  Camera.jumpPing = () => { const p = Camera.lastPing; if (p && inMatch()) Camera.focusWorld(p.x, p.y); };
})(typeof window !== 'undefined' ? window : globalThis);
