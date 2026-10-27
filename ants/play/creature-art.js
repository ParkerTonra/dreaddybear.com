// Creature art (ant19/creatures): the beetle boss, the anteater and the lair spiders in the "baked vector" language of the ants
// (ink outline, three-tone radial light from the top-left, soft shadow down-right, acid/amber accents, theme palette).
// Every creature is painted ONCE into a cached canvas per (kind, facing, pose, zoom bucket) and then stamped with one drawImage;
// no gradient or path work happens per frame. Creatures are team-neutral: no faction colour anywhere.
//   CreatureArt.draw(ctx, kind, c, z, { face, pose })   stamp a creature; c = screen point of its feet, z = px per world unit,
//                                                      face = +1 (looks right) or -1, pose = 'walk0'..'walk3' | 'attack' | 'idle'
//   CreatureArt.poseFor(kind, now, { moving, attack })  the pose for a clock time (Reduced motion: still frame, no cycling)
//   CreatureArt.bar(ctx, c, k, up, w, frac, color)      the hp bar (ink border, dark backing)
// Loaded after world-art.js, before client.js. Pure canvas, no DOM except document.createElement('canvas').
(function (root) {
  const TAU = Math.PI * 2;
  const INK = '#120c08';
  const TD = () => root.TerrainDraw;
  const doc = root.document;
  const mk = (w, h) => { const c = doc.createElement('canvas'); c.width = w; c.height = h; return c; };
  const reduced = () => !!(root.Settings && root.Settings.reduced && root.Settings.reduced());

  const KINDS = ['beetle', 'anteater', 'spider'];
  const POSES = ['walk0', 'walk1', 'walk2', 'walk3', 'attack', 'idle'];
  // Half-width, height above the feet and depth below them, in world units (the sprite box; mirrored faces share it).
  const BOX = { beetle: { W: 54, T: 50, B: 18 }, anteater: { W: 104, T: 66, B: 20 }, spider: { W: 36, T: 36, B: 14 } };

  // ---------- painting helpers (local units: origin = feet, +x toward where it looks, y up is negative) ----------
  // The painter runs inside translate(origin) scale(q * face, q), so a 1 device-pixel line is px = 1 / q local units.
  // LX: which way is "toward the light" in local x (the sun is screen top-left, the local x axis is mirrored by face).
  const lightOf = sg => ({ sg, LX: -sg });
  function ell(g, x, y, rx, ry, rot) { g.beginPath(); g.ellipse(x, y, Math.max(0.01, rx), Math.max(0.01, ry), rot || 0, 0, TAU); }

  // A lit blob: radial gradient aimed at the light, ink outline, short rim highlight on the lit edge.
  function blob(g, L, px, x, y, rx, ry, rot, c0, c1, c2, rim) {
    const r = Math.max(rx, ry);
    const gr = g.createRadialGradient(x + L.LX * rx * 0.42, y - ry * 0.5, r * 0.05, x, y, r * 1.2);
    gr.addColorStop(0, c0); gr.addColorStop(0.5, c1); gr.addColorStop(1, c2);
    ell(g, x, y, rx, ry, rot); g.fillStyle = gr; g.fill();
    g.strokeStyle = INK; g.lineWidth = 1.25 * px; g.stroke();
    if (rim !== false) {
      const a0 = Math.atan2(-1, L.LX * 1.1);
      g.beginPath(); g.ellipse(x, y, Math.max(0.01, rx - 0.9 * px), Math.max(0.01, ry - 0.9 * px), rot || 0, a0 - 0.62, a0 + 0.62);
      g.strokeStyle = 'rgba(255,255,255,0.5)'; g.lineWidth = 1.1 * px; g.stroke();
    }
  }
  // A jointed leg: hip -> knee -> foot, ink under-stroke then the coloured stroke and an optional lit line.
  function leg(g, px, pts, w, col, hi) {
    g.lineCap = 'round'; g.lineJoin = 'round';
    g.beginPath(); g.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
    g.strokeStyle = INK; g.lineWidth = w + 2.2 * px; g.stroke();
    g.strokeStyle = col; g.lineWidth = w; g.stroke();
    if (hi) { g.strokeStyle = hi; g.lineWidth = Math.max(0.5 * px, w * 0.3); g.beginPath(); g.moveTo(pts[0][0], pts[0][1] - w * 0.25); for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1] - w * 0.25); g.stroke(); }
    g.lineCap = 'butt'; g.lineJoin = 'miter';
  }
  // Soft shadow down-right on screen (local x is mirrored by the face sign), three stacked ellipses.
  function shadow(g, L, rx, ry, len) {
    for (const [k, a] of [[1, 0.11], [0.66, 0.13], [0.33, 0.15]]) {
      g.fillStyle = `rgba(6,3,6,${a})`;
      ell(g, L.sg * len * 0.35 * k, 2 + len * 0.1 * k, rx + len * 0.35 * k, ry + len * 0.1 * k); g.fill();
    }
  }
  // Gait: alternating legs. { lift 0..1, swing -1..1 } for leg i at walk frame f (f < 0: planted).
  function gait(f, i) {
    if (f < 0) return { lift: 0, swing: 0 };
    const ph = f * Math.PI / 2 + (i % 2) * Math.PI;
    return { lift: Math.max(0, Math.sin(ph)), swing: Math.cos(ph) };
  }
  const frameOf = pose => (pose && pose.startsWith('walk') ? +pose.slice(4) : -1);

  // ---------- beetle boss: glossy green-black rhino beetle, amber horn, acid seam ----------
  function paintBeetle(g, L, px, pose) {
    const f = frameOf(pose), atk = pose === 'attack';
    const legs = [[-15, -7, -9], [-3, -7, 0], [9, -7, 7]]; // hip x, hip y, foot dx
    const drawLegs = (dx, dy, col, hi, w) => legs.forEach(([hx, hy, fx], i) => {
      const t = gait(f, i), raised = i === 2 && atk;
      const foot = [hx + fx * 1.2 + t.swing * 5 + dx, -t.lift * 5 + (raised ? -14 : 0) + dy];
      const knee = [hx + (fx > 0 ? 6 : -6) + t.swing * 2.5 + dx, hy - 11 - t.lift * 3 + dy];
      leg(g, px, [[hx + dx, hy + dy], knee, foot], w, col, hi);
    });
    shadow(g, L, 30, 8, 14);
    drawLegs(-2, -3, '#16241b', null, 2.6); // far side, darker and a little higher
    const sx = -4, sy = -18; // shell (elytra): ridges, a specular streak, seam
    blob(g, L, px, sx, sy, 25, 15.5, 0, '#a6f0b8', '#2f7c52', '#0d2a1c');
    g.save(); ell(g, sx, sy, 25, 15.5, 0); g.clip();
    g.strokeStyle = 'rgba(8,24,16,0.55)'; g.lineWidth = Math.max(0.9 * px, 0.8);
    for (const o of [-9, 9]) for (const t of [0.45, 0.75]) { g.beginPath(); g.moveTo(sx - 24, sy + o * t * 1.2); g.quadraticCurveTo(sx, sy + o * t * 1.5 - 2, sx + 24, sy + o * t * 1.2); g.stroke(); }
    g.strokeStyle = 'rgba(255,255,255,0.28)'; g.lineWidth = 2.4 * px;
    g.beginPath(); g.moveTo(sx + L.LX * 3, sy - 12); g.quadraticCurveTo(sx + L.LX * 15, sy - 7, sx + L.LX * 20, sy + 1); g.stroke();
    g.restore();
    g.strokeStyle = INK; g.lineWidth = 1.3 * px; g.beginPath(); g.moveTo(sx, sy - 15.4); g.lineTo(sx, sy + 15); g.stroke();
    g.strokeStyle = 'rgba(166,255,60,0.7)'; g.lineWidth = 0.9 * px; g.beginPath(); g.moveTo(sx + 0.9 * px, sy - 13); g.lineTo(sx + 0.9 * px, sy + 13); g.stroke(); // acid seam light
    const hx = atk ? 4 : 0; // pronotum: a chamfered plate in front of the shell
    g.beginPath(); g.moveTo(15 + hx, -29); g.lineTo(26 + hx, -26); g.lineTo(29 + hx, -17); g.lineTo(26 + hx, -8); g.lineTo(15 + hx, -6); g.lineTo(12 + hx, -14); g.closePath();
    const pg = g.createLinearGradient(20 + hx + 10 * L.LX, -30, 20 + hx - 10 * L.LX, -6);
    pg.addColorStop(0, '#6fc88a'); pg.addColorStop(0.5, '#25664a'); pg.addColorStop(1, '#0d2a1c');
    g.fillStyle = pg; g.fill(); g.strokeStyle = INK; g.lineWidth = 1.25 * px; g.stroke();
    blob(g, L, px, 33 + hx, -14, 7.2, 6, 0, '#7fd89a', '#27704c', '#0d2a1c', false); // head
    const tipX = (atk ? 52 : 44) + hx * 0.4, tipY = atk ? -26 : -39;
    g.lineCap = 'round';
    g.beginPath(); g.moveTo(32 + hx, -19); g.quadraticCurveTo(40 + hx, -26, tipX, tipY);
    g.strokeStyle = INK; g.lineWidth = 6.4; g.stroke(); g.strokeStyle = '#e0a53a'; g.lineWidth = 4; g.stroke(); // amber horn
    g.strokeStyle = 'rgba(255,240,190,0.7)'; g.lineWidth = 1.1 * px; g.beginPath(); g.moveTo(33 + hx, -21); g.quadraticCurveTo(40 + hx, -27.5, tipX - 0.6, tipY - 0.6); g.stroke();
    g.beginPath(); g.moveTo(38 + hx, -9); g.quadraticCurveTo(44 + hx, -7, (atk ? 49 : 45) + hx, atk ? -13 : -11); // lower mandible
    g.strokeStyle = INK; g.lineWidth = 3.6; g.stroke(); g.strokeStyle = '#a97a2a'; g.lineWidth = 1.8; g.stroke();
    g.lineCap = 'butt';
    g.fillStyle = '#ffd25a'; ell(g, 35.5 + hx, -15.5, 1.5, 1.5); g.fill();
    g.fillStyle = 'rgba(255,255,255,0.9)'; ell(g, 35 + hx, -16, 0.5, 0.5); g.fill();
    drawLegs(1, 2, '#2a5a3e', 'rgba(150,230,170,0.5)', 3); // near side
  }

  // ---------- anteater: shaggy brown, striped shoulder, long snout, bushy tail, claws ----------
  function paintAnteater(g, L, px, pose) {
    const f = frameOf(pose), atk = pose === 'attack';
    shadow(g, L, 46, 10, 20);
    const legs = [[-28, -14, -2], [-18, -13, 2], [14, -13, 4], [22, -14, 8]]; // hip x, hip y, foot dx
    const drawLegs = (idx, dx, dy, col, hi) => idx.forEach(i => {
      const [hx, hy, fx] = legs[i], t = gait(f, i);
      const foot = [hx + fx + t.swing * 7 + dx, -t.lift * 6 + dy];
      leg(g, px, [[hx + dx, hy + dy], [hx + fx * 0.5 + t.swing * 3 + dx, -7 - t.lift * 3 + dy], foot], 5.6, col, hi);
      if (i >= 2) { g.strokeStyle = '#efe6cf'; g.lineWidth = 1.2 * px + 0.3; g.lineCap = 'round'; for (const o of [-1.6, 0.4, 2.4]) { g.beginPath(); g.moveTo(foot[0] + o, foot[1]); g.lineTo(foot[0] + o + 3, foot[1] + 1.8); g.stroke(); } g.lineCap = 'butt'; }
    });
    drawLegs([0, 2], -3, -2, '#2a211a', null); // far legs
    g.beginPath(); g.moveTo(-34, -30); g.bezierCurveTo(-52, -62, -90, -62, -88, -30); g.bezierCurveTo(-84, -18, -66, -22, -52, -20); g.bezierCurveTo(-44, -18, -38, -18, -34, -18); g.closePath(); // tail plume
    const tg = g.createRadialGradient(-62 + L.LX * 10, -50, 4, -62, -38, 34);
    tg.addColorStop(0, '#7d6a54'); tg.addColorStop(0.6, '#4a3b2f'); tg.addColorStop(1, '#3b2f26');
    g.fillStyle = tg; g.fill(); g.strokeStyle = INK; g.lineWidth = 1.3 * px; g.stroke();
    g.strokeStyle = 'rgba(20,12,8,0.5)'; g.lineWidth = Math.max(0.9 * px, 0.8);
    for (let i = 0; i < 6; i++) { g.beginPath(); g.moveTo(-40 - i * 2, -26 - i * 1.6); g.quadraticCurveTo(-62, -48 - i * 2.5, -84 + (i % 3), -34); g.stroke(); }
    const bx = -6, by = -26; // body with a striped shoulder band clipped to it
    blob(g, L, px, bx, by, 32, 18, 0, '#b49b7c', '#7d6a54', '#2f251d', false);
    g.save(); ell(g, bx, by, 32, 18, 0); g.clip();
    g.beginPath(); g.moveTo(14, -48); g.quadraticCurveTo(4, -28, -14, -8); g.strokeStyle = '#e9e0cc'; g.lineWidth = 11; g.stroke();
    g.beginPath(); g.moveTo(14, -48); g.quadraticCurveTo(4, -28, -14, -8); g.strokeStyle = '#171210'; g.lineWidth = 6.5; g.stroke();
    g.strokeStyle = 'rgba(20,12,8,0.35)'; g.lineWidth = Math.max(0.9 * px, 0.8);
    for (let i = 0; i < 12; i++) { const x = -36 + i * 5.6; g.beginPath(); g.moveTo(x, -42); g.quadraticCurveTo(x - 3, -30, x - 6, -14); g.stroke(); }
    g.restore();
    ell(g, bx, by, 32, 18, 0); g.strokeStyle = INK; g.lineWidth = 1.3 * px; g.stroke();
    const a0 = Math.atan2(-1, L.LX * 1.1); // rim light on the lit shoulder
    g.beginPath(); g.ellipse(bx, by, 31, 17, 0, a0 - 0.7, a0 + 0.7); g.strokeStyle = 'rgba(255,240,210,0.5)'; g.lineWidth = 1.2 * px; g.stroke();
    g.strokeStyle = INK; g.lineWidth = 1.25 * px; g.lineCap = 'round'; // shaggy tufts along the back
    for (let i = 0; i < 8; i++) { const a = Math.PI * (1.12 + i * 0.1), x = bx + Math.cos(a) * 31, y = by + Math.sin(a) * 17; g.beginPath(); g.moveTo(x, y + 1.5); g.lineTo(x + Math.cos(a - 0.3) * 4, y + Math.sin(a - 0.3) * 4); g.stroke(); }
    g.lineCap = 'butt';
    const hy = atk ? 2 : 0; // neck and head with the long snout
    g.beginPath(); g.moveTo(20, -40); g.quadraticCurveTo(42, -42 + hy, 70, -23 + hy); g.lineTo(71, -18 + hy); g.quadraticCurveTo(44, -22 + hy, 22, -10); g.closePath();
    const sg2 = g.createLinearGradient(40, -44, 52, -14);
    sg2.addColorStop(0, '#c4ad8d'); sg2.addColorStop(0.55, '#8a7660'); sg2.addColorStop(1, '#4b3b2e');
    g.fillStyle = sg2; g.fill(); g.strokeStyle = INK; g.lineWidth = 1.3 * px; g.stroke();
    g.fillStyle = '#1a1210'; ell(g, 70, -21 + hy, 2.1, 2.7); g.fill();
    g.fillStyle = 'rgba(255,255,255,0.7)'; ell(g, 69.4, -22.2 + hy, 0.7, 0.7); g.fill();
    blob(g, L, px, 31, -34, 3.4, 4.2, 0, '#9a8468', '#6b5a48', '#3b2f26', false); // ear
    g.fillStyle = '#0c0805'; ell(g, 42, -31 + hy * 0.6, 1.7, 1.7); g.fill();
    g.fillStyle = '#ffd7a0'; ell(g, 41.5, -31.6 + hy * 0.6, 0.55, 0.55); g.fill();
    if (atk) { // tongue flick
      g.beginPath(); g.moveTo(71, -20 + hy); g.quadraticCurveTo(86, -24, 98, -17); g.quadraticCurveTo(86, -18, 71, -18 + hy);
      g.fillStyle = '#e46b86'; g.fill(); g.strokeStyle = INK; g.lineWidth = 1.1 * px; g.stroke();
    }
    drawLegs([1, 3], 2, 2, '#4d3d30', 'rgba(220,200,170,0.45)'); // near legs
  }

  // ---------- spider: glossy widow, red hourglass, red eyes, angled legs ----------
  function paintSpider(g, L, px, pose) {
    const f = frameOf(pose), atk = pose === 'attack';
    shadow(g, L, 22, 6, 10);
    const spec = [[6, 9, 21], [4, 3, 12], [1, -8, -10], [-2, -14, -22]]; // hip x, knee dx, foot dx
    const side = (dx, dy, col, hi) => spec.forEach(([hx, kx, fx], i) => {
      const t = gait(f, i), up = atk && i === 0;
      const foot = [hx + fx + dx + t.swing * 3 + (up ? 3 : 0), up ? -29 : -t.lift * 4 + dy];
      const knee = [hx + kx + dx + t.swing * 1.5, -27 - t.lift * 3 - (up ? 6 : 0)];
      leg(g, px, [[hx + dx * 0.5, -13], knee, foot], 1.9, col, hi);
    });
    side(-3, -1, '#1b1114', null);
    blob(g, L, px, -9, -14, 12.5, 10.5, -0.12, '#8a6a74', '#32232a', '#0c0709');
    g.fillStyle = '#d6271c'; g.beginPath(); g.moveTo(-9, -21); g.lineTo(-5.4, -14.5); g.lineTo(-9, -8); g.lineTo(-12.6, -14.5); g.closePath(); // hourglass mark
    g.fill(); g.strokeStyle = INK; g.lineWidth = 0.9 * px; g.stroke();
    g.fillStyle = 'rgba(255,170,150,0.7)'; g.beginPath(); g.moveTo(-9, -19.5); g.lineTo(-7.6, -15.4); g.lineTo(-9, -14.6); g.closePath(); g.fill();
    const hx = atk ? 2 : 0;
    blob(g, L, px, 6 + hx, -13, 7.6, 6.4, 0, '#8d6f78', '#3c2a31', '#120b0e');
    g.fillStyle = '#ff5a4a'; for (const [ex, ey] of [[10, -15.2], [11.6, -13.4], [9.2, -12.4]]) { ell(g, ex + hx, ey, 1.05, 1.05); g.fill(); }
    g.fillStyle = 'rgba(255,230,210,0.9)'; for (const [ex, ey] of [[9.7, -15.6], [12.1, -13.8]]) { ell(g, ex + hx, ey, 0.38, 0.38); g.fill(); }
    g.lineCap = 'round'; g.beginPath(); g.moveTo(11.5 + hx, -9.4); g.quadraticCurveTo(15 + hx, -7, (atk ? 16.5 : 14) + hx, atk ? -3 : -4.4); // fangs
    g.strokeStyle = INK; g.lineWidth = 3.2; g.stroke(); g.strokeStyle = '#e8dcc0'; g.lineWidth = 1.5; g.stroke(); g.lineCap = 'butt';
    side(2, 1, '#2d1d22', 'rgba(210,170,180,0.4)');
  }

  const PAINT = { beetle: paintBeetle, anteater: paintAnteater, spider: paintSpider };

  // ---------- sprite cache ----------
  let cacheQ = 0, cacheVer = -1;
  const cache = new Map();
  const stats = { bakes: 0, draws: 0, flushes: 0 };
  const MAX_SPRITES = 40;

  function sprite(kind, face, pose, q) {
    const ver = TD() && TD().version ? TD().version() : 0;
    if (q !== cacheQ || ver !== cacheVer) { cacheQ = q; cacheVer = ver; cache.clear(); stats.flushes++; }
    const sg = face < 0 ? -1 : 1, id = `${kind}|${sg}|${pose}`;
    let S = cache.get(id);
    if (!S) {
      const B = BOX[kind], Wp = Math.ceil(B.W * q) + 2, Tp = Math.ceil(B.T * q) + 2, w = Wp * 2, h = Tp + Math.ceil(B.B * q) + 2;
      const cv = mk(w, h), g = cv.getContext('2d');
      g.save(); g.translate(Wp, Tp); g.scale(q * sg, q);
      PAINT[kind](g, lightOf(sg), 1 / q, pose);
      g.restore();
      if (TD() && TD().applyTint) TD().applyTint(g, 0, 0, w, h);
      S = { cv, ox: Wp / q, oy: Tp / q, w: w / q, h: h / q };
      if (cache.size >= MAX_SPRITES) cache.delete(cache.keys().next().value);
      cache.set(id, S); stats.bakes++;
    }
    return S;
  }
  const qOf = z => 2 ** (Math.round(Math.log2(Math.max(0.05, z) * Math.min(2, root.devicePixelRatio || 1)) * 8) / 8);

  function draw(ctx, kind, c, z, o) {
    o = o || {};
    const S = sprite(kind, o.face, o.pose || 'walk0', qOf(z));
    ctx.drawImage(S.cv, c.x - S.ox * z, c.y - S.oy * z, S.w * z, S.h * z);
    stats.draws++;
  }

  // Walk frame from the clock; Reduced motion holds a still frame. `attack` wins over walking.
  function poseFor(kind, now, st) {
    st = st || {};
    if (st.attack) return 'attack';
    if (!st.moving) return 'idle';
    if (reduced()) return 'walk0';
    const ms = kind === 'anteater' ? 85 : kind === 'spider' ? 70 : 150;
    return 'walk' + (Math.floor(now / ms) & 3);
  }

  // hp bar: ui-world style when UIWorld is loaded, else ink border, dark backing, lit fill. c = feet, up = world units above, w = width in units
  function bar(ctx, c, k, up, w, frac, color) {
    const W = w * k, H = Math.max(4, 5 * k), x = c.x - W / 2, y = c.y - up * k, f = Math.max(0, Math.min(1, frac));
    // ant26: in-world UI style (ui-world.js: ink edge, panel backing, chamfer, quarter ticks, amber at a third) when it is loaded
    if (root.UIWorld && root.UIWorld.hpBar) { root.UIWorld.hpBar(ctx, x, y, W, H, f, color, { chamfer: true, quarters: true }); return; }
    ctx.fillStyle = INK; ctx.fillRect(x - 1, y - 1, W + 2, H + 2);
    ctx.fillStyle = 'rgba(20,16,12,.9)'; ctx.fillRect(x, y, W, H);
    ctx.fillStyle = color; ctx.fillRect(x, y, f * W, H);
    ctx.fillStyle = 'rgba(255,255,255,.28)'; ctx.fillRect(x, y, f * W, Math.max(1, H * 0.3));
  }

  const api = { draw, poseFor, bar, sprite, KINDS, POSES, BOX, stats };
  root.CreatureArt = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
