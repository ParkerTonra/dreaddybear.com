// World props (ant18/ground): the nest mound with glowing vents, food as glowing pellets, and the three structures
// (food cache, acid mound, outpost) in the scorched alien dusk look. Loaded after terrain-draw.js, before client.js.
// Everything static is painted into cached sprites by render.js (nest, food) and by drawStructure() below; only the
// vent / pellet glow is drawn live, as one pre-rendered additive sprite each, and it holds still in Reduced motion.
//   WorldArt.nest(g, c, s, p, side, cracks)        paint a nest mound at sprite scale s (render.js paintNest)
//   WorldArt.nestGlow(ctx, c, scale, side, p, now) live vent glow over the cached sprite
//   WorldArt.food(g, c, s, f)                      paint a food pile (render.js paintFood)
//   WorldArt.pellets(ctx, c, scale, f, now)        a pellet pile (economy.js), drawn live
//   WorldArt.drawStructure(ctx, k, c, z, side, done, now, id)   a structure (structures.js), cached sprite + glow
// Light: one sun, top-left and low. Lit faces get a warm edge, shadows fall down and to the right, long and soft.
(function (root) {
  const TD = () => root.TerrainDraw;
  const GLOW = ['#ffd2c8', '#cfe6ff', '#ffe2bd', '#e8d6ff']; // faction glow tints (vents, tech marks)
  const LIGHT = ['#ff9a8a', '#8fc0ff', '#ffc07a', '#c9a0ff'];
  const COL = () => (typeof COLORS !== 'undefined' ? COLORS : ['#e0483e', '#3b7be0', '#f08a24', '#9a5ad8']);
  const DK = () => (typeof DARK !== 'undefined' ? DARK : ['#6e1c16', '#163a73', '#7a3f08', '#47236e']);
  const INK = '#120c08';
  const doc = root.document;
  const mk = (w, h) => { const c = doc.createElement('canvas'); c.width = w; c.height = h; return c; };
  const reduced = () => !!(root.Settings && root.Settings.reduced && root.Settings.reduced());
  const pulse = x => (root.motionSin ? root.motionSin(x) : reduced() ? 0 : Math.sin(x));
  const hash = (x, y, s) => { let h = (x * 374761393 + y * 668265263 + s * 2654435761) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
  const ell = (g, x, y, rx, ry, rot = 0) => { g.beginPath(); g.ellipse(x, y, Math.max(0, rx), Math.max(0, ry), rot, 0, Math.PI * 2); };

  // ---------- Glow sprites: a soft radial blob per colour, drawn with 'lighter' ----------
  const glows = new Map();
  function glow(color) {
    let c = glows.get(color);
    if (!c) {
      c = mk(64, 64);
      const g = c.getContext('2d');
      const g2 = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
      const [r, gg, b] = rgb(color);
      g2.addColorStop(0, `rgba(${r},${gg},${b},0.95)`); g2.addColorStop(0.3, `rgba(${r},${gg},${b},0.45)`); g2.addColorStop(1, `rgba(${r},${gg},${b},0)`);
      g.fillStyle = g2; g.fillRect(0, 0, 64, 64);
      glows.set(color, c);
    }
    return c;
  }
  // Additive glow of radius r (screen px) at (x, y), alpha a.
  function stampGlow(ctx, color, x, y, r, a) {
    if (a <= 0.01) return;
    const prev = ctx.globalCompositeOperation, pa = ctx.globalAlpha;
    ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = Math.min(1, a);
    ctx.drawImage(glow(color), x - r, y - r, r * 2, r * 2);
    ctx.globalCompositeOperation = prev; ctx.globalAlpha = pa;
  }
  const glowK = () => (TD() ? TD().glowScale() : 1);

  // A long soft shadow, down and to the right, as three stacked skewed ellipses.
  function shadow(g, c, s, rx, ry, len) {
    for (const [k, a] of [[1, 0.11], [0.66, 0.12], [0.33, 0.13]]) {
      g.fillStyle = `rgba(6,3,6,${a})`;
      ell(g, c.x + len * 0.55 * k * s, c.y + len * 0.25 * k * s + 2 * s, rx * s + len * 0.5 * k * s, ry * s + len * 0.14 * k * s);
      g.fill();
    }
  }
  const tint = (g, w, h) => { // end every cached sprite with the time-of-day tint (size from the sprite canvas unless given)
    if (w === undefined && g.canvas) { w = g.canvas.width; h = g.canvas.height; }
    if (TD() && w !== undefined) TD().applyTint(g, 0, 0, w, h);
  };

  // ---------- Nest ----------
  // Vent positions on the dome (unit offsets from the nest centre).
  const VENTS = [[-22, -9], [19, -11], [-9, -26], [8, -27]];
  const HOLE = [0, -17];

  function chamferPlate(g, x, y, w, h) { // a small notched plate, as the UI's chamfer
    g.beginPath(); g.moveTo(x - w, y - h * 0.3); g.lineTo(x - w * 0.7, y - h); g.lineTo(x + w, y - h); g.lineTo(x + w, y + h * 0.3); g.lineTo(x + w * 0.7, y + h); g.lineTo(x - w, y + h); g.closePath();
  }

  function nest(g, c, s, p, side, cracks) {
    const col = COL()[side], dark = DK()[side], gl = GLOW[side];
    // scorched ring and long shadow
    g.fillStyle = 'rgba(14,8,6,0.45)'; ell(g, c.x, c.y + 1 * s, 56 * s, 28 * s); g.fill();
    shadow(g, c, s, 46, 22, 40);
    if (!p.alive) { // collapsed: a blackened crater with a broken rim and dying embers
      g.fillStyle = '#35271d'; ell(g, c.x, c.y, 42 * s, 19 * s); g.fill();
      g.fillStyle = '#120a07'; ell(g, c.x, c.y + 1 * s, 30 * s, 12 * s); g.fill();
      g.strokeStyle = '#5e4630'; g.lineWidth = 2.2 * s; g.lineCap = 'round';
      for (let i = 0; i < 9; i++) { const a = i / 9 * Math.PI * 2 + 0.3, r = 38 + hash(i, side, 4) * 5; g.beginPath(); g.moveTo(c.x + Math.cos(a) * r * s, c.y + Math.sin(a) * r * s * 0.45); g.lineTo(c.x + Math.cos(a + 0.18) * (r - 3) * s, c.y + Math.sin(a + 0.18) * (r - 3) * s * 0.45); g.stroke(); }
      g.lineCap = 'butt';
      for (let i = 0; i < 6; i++) { g.fillStyle = `rgba(255,${90 + i * 14},40,0.6)`; ell(g, c.x + (hash(i, 1, side) - 0.5) * 40 * s, c.y + (hash(i, 2, side) - 0.5) * 14 * s, 1.5 * s, 0.8 * s); g.fill(); }
      tint(g);
      return;
    }
    // packed rim: dark ring under the dome, faction plates along the front arc
    g.fillStyle = '#4a3425'; ell(g, c.x, c.y, 48 * s, 25 * s); g.fill();
    g.fillStyle = '#6b4c32'; g.beginPath(); g.ellipse(c.x - 1 * s, c.y - 1 * s, 46 * s, 23 * s, 0, 0.1 * Math.PI, 0.9 * Math.PI); g.lineTo(c.x, c.y); g.fill();
    for (let i = 0; i < 9; i++) {
      const a = Math.PI * (0.08 + i * 0.105), x = c.x + Math.cos(a) * 44 * s, y = c.y + Math.sin(a) * 22.5 * s;
      g.fillStyle = i % 3 === 1 ? col : dark; chamferPlate(g, x, y, 2.6 * s, 1.6 * s); g.fill();
      g.strokeStyle = INK; g.lineWidth = Math.max(1, 0.6 * s); g.stroke();
    }
    // dome: lit from the top-left
    g.save();
    g.beginPath(); g.ellipse(c.x, c.y - 10 * s, 36 * s, 24 * s, 0, Math.PI, 0); g.ellipse(c.x, c.y - 10 * s, 36 * s, 11 * s, 0, 0, Math.PI); g.closePath();
    const dg = g.createRadialGradient(c.x - 14 * s, c.y - 28 * s, 2 * s, c.x, c.y - 10 * s, 44 * s);
    dg.addColorStop(0, '#c08a58'); dg.addColorStop(0.45, '#8a6038'); dg.addColorStop(1, '#3f2a1c');
    g.fillStyle = dg; g.fill(); g.clip();
    // chitin ridge lines: arcs from the hole, a dark line and a lit line beside it
    g.lineCap = 'round';
    for (let i = 0; i < 7; i++) {
      const a = Math.PI * (1.04 + i * 0.15), ex = Math.cos(a) * 38 * s, ey = Math.sin(a) * 20 * s;
      g.strokeStyle = 'rgba(30,18,10,0.55)'; g.lineWidth = 1.6 * s;
      g.beginPath(); g.moveTo(c.x + HOLE[0] * s * 0.4, c.y + HOLE[1] * s); g.quadraticCurveTo(c.x + ex * 0.55, c.y - 10 * s + ey * 0.4 - 4 * s, c.x + ex, c.y - 8 * s + ey * 0.55); g.stroke();
      g.strokeStyle = 'rgba(255,200,140,0.22)'; g.lineWidth = 0.9 * s;
      g.beginPath(); g.moveTo(c.x + HOLE[0] * s * 0.4 - 1 * s, c.y + HOLE[1] * s - 1 * s); g.quadraticCurveTo(c.x + ex * 0.55 - 1 * s, c.y - 10 * s + ey * 0.4 - 5 * s, c.x + ex - 1 * s, c.y - 8 * s + ey * 0.55 - 1 * s); g.stroke();
    }
    g.lineCap = 'butt';
    g.restore();
    g.strokeStyle = INK; g.lineWidth = Math.max(1, 0.7 * s);
    g.beginPath(); g.ellipse(c.x, c.y - 10 * s, 36 * s, 24 * s, 0, Math.PI, 0); g.stroke();
    // lit lip along the top-left of the dome
    g.strokeStyle = 'rgba(255,214,170,0.55)'; g.lineWidth = 1.2 * s;
    g.beginPath(); g.ellipse(c.x, c.y - 10.5 * s, 35 * s, 23 * s, 0, Math.PI * 1.05, Math.PI * 1.55); g.stroke();
    // entrance hole with a faint inner light
    g.fillStyle = '#0d0705'; ell(g, c.x + HOLE[0] * s, c.y + HOLE[1] * s, 9.5 * s, 5.2 * s); g.fill();
    g.strokeStyle = INK; g.lineWidth = Math.max(1, 0.8 * s); g.stroke();
    g.fillStyle = 'rgba(255,170,90,0.22)'; ell(g, c.x + HOLE[0] * s, c.y + (HOLE[1] + 1) * s, 6 * s, 2.6 * s); g.fill();
    // vents: dark rim, dim faction-tinted core (the live pass brightens them)
    for (const [vx, vy] of VENTS) {
      g.fillStyle = '#1a0f09'; ell(g, c.x + vx * s, c.y + vy * s, 3.7 * s, 2 * s); g.fill();
      g.strokeStyle = 'rgba(255,200,140,0.5)'; g.lineWidth = Math.max(1, 0.7 * s); g.beginPath(); g.ellipse(c.x + vx * s, c.y + (vy - 0.4) * s, 3.7 * s, 2 * s, 0, Math.PI * 1.1, Math.PI * 1.9); g.stroke();
      g.fillStyle = gl; g.globalAlpha = 0.45; ell(g, c.x + vx * s, c.y + (vy + 0.2) * s, 2.2 * s, 1 * s); g.fill(); g.globalAlpha = 1;
    }
    if (cracks) cracks(c, s, 1 - p.nest.hp / p.nest.max, side, g);
    // pennant: faction colour on a notched flag
    g.strokeStyle = INK; g.lineWidth = 2.2 * s;
    g.beginPath(); g.moveTo(c.x + 24 * s, c.y - 12 * s); g.lineTo(c.x + 24 * s, c.y - 55 * s); g.stroke();
    g.strokeStyle = '#7a5a3a'; g.lineWidth = 1 * s; g.beginPath(); g.moveTo(c.x + 23.4 * s, c.y - 12 * s); g.lineTo(c.x + 23.4 * s, c.y - 55 * s); g.stroke();
    g.fillStyle = col;
    g.beginPath(); g.moveTo(c.x + 24 * s, c.y - 55 * s); g.lineTo(c.x + 48 * s, c.y - 50 * s); g.lineTo(c.x + 43 * s, c.y - 45.5 * s); g.lineTo(c.x + 48 * s, c.y - 41 * s); g.lineTo(c.x + 24 * s, c.y - 36 * s); g.closePath(); g.fill();
    g.strokeStyle = INK; g.lineWidth = Math.max(1, 0.8 * s); g.stroke();
    g.fillStyle = LIGHT[side]; g.beginPath(); g.moveTo(c.x + 25 * s, c.y - 54 * s); g.lineTo(c.x + 46 * s, c.y - 49.5 * s); g.lineTo(c.x + 45 * s, c.y - 48 * s); g.lineTo(c.x + 25 * s, c.y - 52.5 * s); g.closePath(); g.fill();
    tint(g);
  }

  function nestGlow(ctx, c, scale, side, p, now) {
    if (!p.alive) return;
    const k = glowK(), amb = TD() ? TD().ambient() : !reduced();
    const base = 0.5 + 0.12 * (k - 1);
    const ph = amb ? 0.5 + 0.5 * pulse(now / 520 + side * 1.7) : 0.55;
    stampGlow(ctx, GLOW[side], c.x + HOLE[0] * scale, c.y + HOLE[1] * scale, 17 * scale, base * 0.55 * k * (0.7 + 0.5 * ph));
    VENTS.forEach(([vx, vy], i) => {
      const v = amb ? 0.5 + 0.5 * pulse(now / 330 + i * 1.9 + side) : 0.55;
      stampGlow(ctx, GLOW[side], c.x + vx * scale, c.y + (vy + 0.2) * scale, 9 * scale, base * k * (0.55 + 0.6 * v));
    });
    stampGlow(ctx, '#ffd9a0', c.x + HOLE[0] * scale, c.y + (HOLE[1] + 1) * scale, 5 * scale, 0.35 * k * ph);
  }

  // ---------- Food ----------
  function pellet(g, x, y, rx, ry, a, hue, hi, s) {
    g.fillStyle = 'rgba(6,3,6,0.4)'; ell(g, x + 1.4 * s, y + 1.2 * s, rx * 1.05, ry * 0.8, a); g.fill(); // contact shadow
    g.fillStyle = INK; ell(g, x, y, rx + 0.9 * s, ry + 0.9 * s, a); g.fill(); // ink ring keeps it separate from any ground
    const gr = g.createRadialGradient(x - rx * 0.35, y - ry * 0.4, 0, x, y, Math.max(rx, ry));
    gr.addColorStop(0, hi); gr.addColorStop(0.5, hue); gr.addColorStop(1, hue);
    g.fillStyle = gr; ell(g, x, y, rx, ry, a); g.fill();
    g.fillStyle = 'rgba(255,255,255,0.8)'; ell(g, x - rx * 0.3, y - ry * 0.4, rx * 0.28, ry * 0.2, a); g.fill();
  }

  function food(g, c, s, f) {
    const amt = f[3];
    const spread = (5 + Math.min(11, Math.sqrt(amt) * 1.1)) * s;
    const n = Math.min(16, Math.ceil(Math.sqrt(amt) * 1.4));
    const sz = 0.7 + Math.min(0.5, amt / 160);
    g.fillStyle = 'rgba(6,3,6,0.28)'; ell(g, c.x + 3 * s, c.y + 2 * s, spread + 7 * s, (spread + 6 * s) * 0.5); g.fill();
    // a warm pool of light under the pile (baked: the pile is the brightest thing on the ground)
    const hg = g.createRadialGradient(c.x, c.y - 2 * s, 0, c.x, c.y - 2 * s, spread + 14 * s);
    hg.addColorStop(0, 'rgba(190,255,90,0.38)'); hg.addColorStop(0.5, 'rgba(190,255,90,0.12)'); hg.addColorStop(1, 'rgba(190,255,90,0)');
    g.fillStyle = hg; ell(g, c.x, c.y - 2 * s, spread + 14 * s, (spread + 14 * s) * 0.62); g.fill();
    const order = [];
    for (let i = 0; i < n; i++) {
      const a = hash(f[0], i, 7) * Math.PI * 2, r = hash(i, f[0], 9) * spread;
      order.push([Math.sin(a) * r, i, a, r]);
    }
    order.sort((p, q) => p[0] - q[0]);
    for (const [, i, a, r] of order) {
      const lift = (1 - r / spread) * Math.min(6, amt / 15) * s;
      pellet(g, c.x + Math.cos(a) * r, c.y + Math.sin(a) * r * 0.5 - 2 * s - lift, 4.6 * s * sz, 3.5 * s * sz, a, i % 3 ? '#9be040' : '#f4cf52', i % 3 ? '#e9ffb0' : '#fff3b8', s);
    }
    // no tint: food is emissive, it keeps its colour at night
  }

  // Blue pellet piles (economy.js), live: halo, ring, then pellets that twinkle a little.
  function pellets(ctx, c, scale, f, now) {
    const amb = TD() ? TD().ambient() : !reduced(), k = glowK();
    ctx.strokeStyle = 'rgba(79,216,234,.45)'; ctx.lineWidth = 2 * scale;
    ctx.beginPath(); ctx.ellipse(c.x, c.y, 16 * scale, 8 * scale, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.lineWidth = 1;
    stampGlow(ctx, '#4fd8ea', c.x, c.y - 2 * scale, 22 * scale, (0.28 + (amb ? 0.07 * pulse(now / 600 + f[0]) : 0)) * k);
    for (let i = 0; i < f[3]; i++) {
      const a = hash(f[0], i, 7) * Math.PI * 2, r = hash(i, f[0], 9) * 9 * scale, x = c.x + Math.cos(a) * r, y = c.y + Math.sin(a) * r * 0.5 - 3 * scale;
      ctx.fillStyle = 'rgba(6,3,6,.4)'; ctx.beginPath(); ctx.ellipse(x + 1.2 * scale, y + 1.4 * scale, 4.2 * scale, 2.4 * scale, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = INK; ctx.beginPath(); ctx.arc(x, y, 4.8 * scale, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#48c8ee'; ctx.beginPath(); ctx.arc(x, y, 3.9 * scale, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#c8f6ff'; ctx.beginPath(); ctx.arc(x - 1.2 * scale, y - 1.3 * scale, 1.3 * scale, 0, Math.PI * 2); ctx.fill();
    }
  }

  // ---------- Structures ----------
  // Sprites (shadow + body) per kind / colony / built / density; glow is live. Box around the centre in units.
  const SBOX = { L: 52, R: 70, T: 58, B: 34 };
  const sprites = new Map();
  let spriteQ = 0, spriteVer = -1;
  function structSprite(k, side, done, q) {
    const BA = root.BuildingArt, ver = (TD() ? TD().version() : 0) + (BA ? BA.ver * 1000 : 0);
    if (q !== spriteQ || ver !== spriteVer) { spriteQ = q; spriteVer = ver; sprites.clear(); }
    const id = `${k}|${side}|${done ? 1 : 0}`;
    let S = sprites.get(id);
    if (!S) {
      const Lp = Math.ceil(SBOX.L * q) + 2, Tp = Math.ceil(SBOX.T * q) + 2, w = Lp + Math.ceil(SBOX.R * q) + 2, h = Tp + Math.ceil(SBOX.B * q) + 2;
      const cv = mk(w, h), g = cv.getContext('2d');
      paintStructure(g, { x: Lp, y: Tp }, q, k, side, done);
      tint(g, w, h);
      S = { cv, ox: Lp / q, oy: Tp / q, w: w / q, h: h / q };
      sprites.set(id, S);
    }
    return S;
  }

  function dome(g, c, s, rx, ry, hgt, c0, c1, c2) { // lit dome: a half-ellipse with a radial light from the top-left
    g.save();
    g.beginPath(); g.ellipse(c.x, c.y - hgt * s, rx * s, ry * s, 0, Math.PI, 0); g.ellipse(c.x, c.y - hgt * s, rx * s, ry * 0.46 * s, 0, 0, Math.PI); g.closePath();
    const gr = g.createRadialGradient(c.x - rx * 0.4 * s, c.y - (hgt + ry * 0.8) * s, 1 * s, c.x, c.y - hgt * s, rx * 1.3 * s);
    gr.addColorStop(0, c0); gr.addColorStop(0.5, c1); gr.addColorStop(1, c2);
    g.fillStyle = gr; g.fill(); g.restore();
    g.strokeStyle = INK; g.lineWidth = Math.max(1, 0.7 * s);
    g.beginPath(); g.ellipse(c.x, c.y - hgt * s, rx * s, ry * s, 0, Math.PI, 0); g.stroke();
    g.strokeStyle = 'rgba(255,214,170,0.5)'; g.lineWidth = 1.1 * s;
    g.beginPath(); g.ellipse(c.x, c.y - (hgt + 0.4) * s, (rx - 1) * s, (ry - 1) * s, 0, Math.PI * 1.05, Math.PI * 1.55); g.stroke();
  }

  // Quaternius sprites (building-art.js): kind -> cell; an unfinished site shows the shared construction site. Outposts stay code-drawn.
  const SHEET_CELL = { 0: 'depot', 1: 'mound', 3: 'garden' };
  const hasSheet = k => !!(root.BuildingArt && SHEET_CELL[k] && root.BuildingArt.has(SHEET_CELL[k]));
  function paintStructure(g, c, s, k, side, done) {
    if (hasSheet(k) && root.BuildingArt.paint(g, c, s, done ? SHEET_CELL[k] : 'site', COL()[side])) return;
    const col = COL()[side], dark = DK()[side], gl = GLOW[side];
    shadow(g, c, s, 22, 10, 22);
    if (k === 0) { // food cache: a scorched stone ring, a hex-plated lip, a core of glowing honey and pellets
      g.fillStyle = '#3b2a20'; ell(g, c.x, c.y - 2 * s, 21 * s, 10.5 * s); g.fill();
      g.strokeStyle = INK; g.lineWidth = Math.max(1, 0.7 * s); g.stroke();
      for (let i = 0; i < 10; i++) { // lip plates
        const a = i / 10 * Math.PI * 2, x = c.x + Math.cos(a) * 18 * s, y = c.y - 3 * s + Math.sin(a) * 8.6 * s;
        g.fillStyle = i % 2 ? '#7a5a3c' : '#5e432e'; chamferPlate(g, x, y, 3.2 * s, 2.4 * s); g.fill();
        g.strokeStyle = INK; g.lineWidth = Math.max(1, 0.5 * s); g.stroke();
      }
      g.fillStyle = '#1a0f09'; ell(g, c.x, c.y - 4 * s, 13 * s, 6 * s); g.fill();
      const hg = g.createRadialGradient(c.x - 2 * s, c.y - 5 * s, 0, c.x, c.y - 4 * s, 12 * s);
      hg.addColorStop(0, '#ffd978'); hg.addColorStop(0.6, '#d9962a'); hg.addColorStop(1, '#7a4a14');
      g.fillStyle = hg; ell(g, c.x, c.y - 4.5 * s, 11 * s, 5 * s); g.fill();
      if (done) for (let i = 0; i < 6; i++) pellet(g, c.x + (i - 2.5) * 3.2 * s, c.y - (7 + (i % 3) * 1.8) * s, 3.2 * s, 2.4 * s, i, i % 2 ? '#9be040' : '#f4cf52', i % 2 ? '#e9ffb0' : '#fff3b8', s);
    } else if (k === 1) { // acid mound: a basalt spire with chitin ridges and an acid vent
      g.fillStyle = '#2a1e1a'; ell(g, c.x, c.y - 1 * s, 19 * s, 9 * s); g.fill();
      g.beginPath(); g.moveTo(c.x - 17 * s, c.y - 1 * s); g.quadraticCurveTo(c.x - 8 * s, c.y - 26 * s, c.x - 2 * s, c.y - 34 * s); g.lineTo(c.x + 3 * s, c.y - 34 * s); g.quadraticCurveTo(c.x + 9 * s, c.y - 24 * s, c.x + 17 * s, c.y - 1 * s); g.closePath();
      const gr = g.createLinearGradient(c.x - 16 * s, c.y - 30 * s, c.x + 16 * s, c.y);
      gr.addColorStop(0, '#9b7650'); gr.addColorStop(0.5, '#5e432e'); gr.addColorStop(1, '#2b1d16');
      g.fillStyle = gr; g.fill(); g.strokeStyle = INK; g.lineWidth = Math.max(1, 0.8 * s); g.stroke();
      g.strokeStyle = 'rgba(20,12,8,0.6)'; g.lineWidth = 1.2 * s; // ridge lines
      for (let i = -1; i <= 1; i++) { g.beginPath(); g.moveTo(c.x + i * 2.4 * s, c.y - 33 * s); g.quadraticCurveTo(c.x + i * 8 * s, c.y - 16 * s, c.x + i * 12 * s, c.y - 3 * s); g.stroke(); }
      g.strokeStyle = 'rgba(255,200,140,0.35)'; g.lineWidth = 1 * s; g.beginPath(); g.moveTo(c.x - 3 * s, c.y - 33 * s); g.quadraticCurveTo(c.x - 11 * s, c.y - 19 * s, c.x - 15 * s, c.y - 4 * s); g.stroke();
      g.fillStyle = dark; g.fillRect(c.x - 13 * s, c.y - 9 * s, 26 * s, 2.6 * s); // faction band
      g.fillStyle = col; g.fillRect(c.x - 13 * s, c.y - 9 * s, 26 * s, 1 * s);
      g.fillStyle = '#17220a'; ell(g, c.x, c.y - 34 * s, 5.6 * s, 2.7 * s); g.fill(); g.strokeStyle = INK; g.stroke(); // vent mouth
      g.fillStyle = done ? 'rgba(150,230,60,0.85)' : 'rgba(150,230,60,0.25)'; ell(g, c.x, c.y - 34.2 * s, 3.6 * s, 1.6 * s); g.fill();
      if (done) { g.fillStyle = 'rgba(166,255,60,0.7)'; ell(g, c.x + 6.5 * s, c.y - 24 * s, 1 * s, 2 * s); g.fill(); ell(g, c.x - 7 * s, c.y - 16 * s, 0.9 * s, 1.8 * s); g.fill(); } // drips
    } else { // outpost: a small mound with a vent, a hatch and a pennant
      g.fillStyle = '#4a3425'; ell(g, c.x, c.y, 27 * s, 13.5 * s); g.fill();
      g.strokeStyle = INK; g.lineWidth = Math.max(1, 0.7 * s); g.stroke();
      for (let i = 0; i < 6; i++) { const a = Math.PI * (0.1 + i * 0.16); g.fillStyle = i % 2 ? col : dark; chamferPlate(g, c.x + Math.cos(a) * 24 * s, c.y + Math.sin(a) * 11.5 * s, 2.2 * s, 1.4 * s); g.fill(); g.strokeStyle = INK; g.lineWidth = Math.max(1, 0.5 * s); g.stroke(); }
      dome(g, c, s, 20, 14, 5, '#bd8a58', '#7e5836', '#3a281b');
      g.strokeStyle = 'rgba(30,18,10,0.5)'; g.lineWidth = 1.2 * s;
      for (let i = 0; i < 4; i++) { const a = Math.PI * (1.1 + i * 0.27); g.beginPath(); g.moveTo(c.x, c.y - 12 * s); g.lineTo(c.x + Math.cos(a) * 18 * s, c.y - 5 * s + Math.sin(a) * 10 * s); g.stroke(); }
      g.fillStyle = '#0d0705'; ell(g, c.x, c.y - 12 * s, 5.4 * s, 3 * s); g.fill(); g.strokeStyle = INK; g.stroke();
      for (const vx of [-12, 11]) { g.fillStyle = '#1a0f09'; ell(g, c.x + vx * s, c.y - 6 * s, 2.6 * s, 1.4 * s); g.fill(); g.fillStyle = gl; g.globalAlpha = 0.45; ell(g, c.x + vx * s, c.y - 6 * s, 1.6 * s, 0.7 * s); g.fill(); g.globalAlpha = 1; }
      g.strokeStyle = INK; g.lineWidth = 2 * s; g.beginPath(); g.moveTo(c.x + 14 * s, c.y - 8 * s); g.lineTo(c.x + 14 * s, c.y - 36 * s); g.stroke();
      g.strokeStyle = '#7a5a3a'; g.lineWidth = 0.9 * s; g.beginPath(); g.moveTo(c.x + 13.5 * s, c.y - 8 * s); g.lineTo(c.x + 13.5 * s, c.y - 36 * s); g.stroke();
      g.fillStyle = col; g.beginPath(); g.moveTo(c.x + 14 * s, c.y - 36 * s); g.lineTo(c.x + 32 * s, c.y - 32 * s); g.lineTo(c.x + 28 * s, c.y - 29 * s); g.lineTo(c.x + 32 * s, c.y - 26 * s); g.lineTo(c.x + 14 * s, c.y - 22 * s); g.closePath(); g.fill();
      g.strokeStyle = INK; g.lineWidth = Math.max(1, 0.7 * s); g.stroke();
    }
  }

  function structGlow(ctx, c, z, k, side, now, id, done) {
    const amb = TD() ? TD().ambient() : !reduced(), kk = glowK();
    const sheet = hasSheet(k);
    if (k === 1) { // the vent glow sits on the acid pool of the sprite, or on the painter's spire
      const gy = sheet ? c.y - 5 * z : c.y - 34 * z;
      const v = done ? 0.6 + 0.4 * (amb ? pulse(now / 260 + id) : 0.5) : 0.25;
      stampGlow(ctx, '#a6ff3c', c.x, gy, 14 * z, 0.55 * v * kk);
      stampGlow(ctx, '#eaffa0', c.x, gy, 5 * z, 0.5 * v);
    } else if (k === 2 && done) {
      const v = amb ? 0.5 + 0.5 * pulse(now / 400 + id) : 0.55;
      for (const vx of [-12, 11]) stampGlow(ctx, GLOW[side], c.x + vx * z, c.y - 6 * z, 6 * z, (0.4 + 0.4 * v) * kk);
      stampGlow(ctx, '#ffd9a0', c.x, c.y - 12 * z, 7 * z, 0.3 * kk);
    } else if (k === 0 && done && !sheet) {
      stampGlow(ctx, '#ffc24a', c.x, c.y - 5 * z, 15 * z, (0.35 + (amb ? 0.08 * pulse(now / 700 + id) : 0)) * kk);
    }
  }

  function drawStructure(ctx, k, c, z, side, done, now, id) {
    const q = Math.pow(2, Math.round(Math.log2(Math.max(0.05, z) * Math.min(2, root.devicePixelRatio || 1)) * 8) / 8);
    const S = structSprite(k, side, done, q);
    ctx.drawImage(S.cv, c.x - S.ox * z, c.y - S.oy * z, S.w * z, S.h * z);
    structGlow(ctx, c, z, k, side, now, id, done);
  }

  root.WorldArt = { nest, nestGlow, food, pellets, drawStructure, glow, stampGlow, GLOW, LIGHT, hasSheet, NEST_BOX: { L: 62, R: 74, T: 62, B: 40 }, shadow };
})(typeof window !== 'undefined' ? window : globalThis);
