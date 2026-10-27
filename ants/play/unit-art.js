// Per-unit-type art and UI metadata for the client, loaded before client.js.
// UNITS[i] describes snapshot type id i (game.js TYPE_IDS). render.js paints each type's sprite atlas from size/abdomen/head/jaws
// from here; paintAnt() (ant18 unit-look, lower in this file) is the lit chitin painter that render.js bakes into the atlases;
// drawExtra() is the older flat-colour details hook, kept for callers and tests. Acid globs (snapshot `shots`) are drawn by drawShots().
(function (root) {
  'use strict';
  // abd/head: [x offset, radius x, radius y] in ant units; size: draw scale; jaws: big mandibles.
  const UNITS = [
    { id: 'worker', name: 'Worker', key: 'Z', cost: 10, size: 1, abd: [-6, 4.2, 3.2], head: [5, 2.6, 2.4], jaws: false,
      tip: 'Gathers food and pellets and brings them home. No bite worth the name.' },
    { id: 'soldier', name: 'Soldier', key: 'X', cost: 25, size: 1.6, abd: [-6, 4.2, 3.2], head: [5.6, 3.3, 3.1], jaws: true,
      tip: 'The all-round fighter: strong bite, tough. Gathers at the rally flag of the building that hatched it.' },
    { id: 'spitter', name: 'Spitter', key: 'C', cost: 25, size: 1.3, abd: [-6.8, 5.4, 4.2], head: [4.8, 2.4, 2.2], jaws: false,
      tip: 'Spits acid at range; splash shreds clumped soldiers. Fragile; majors shrug it off.' },
    { id: 'major', name: 'Major', key: 'V', cost: 35, pellets: 1, size: 2, abd: [-6, 4.4, 3.4], head: [6, 3.8, 3.6], jaws: true,
      tip: 'Armored siege ant: wrecks nests, resists acid. Weak bite, so soldiers bring it down.' },
    // ant16 castes (castes.js). tech: shown on the button until the colony has finished its first evolution tier.
    { id: 'nurse', name: 'Nurse', key: 'N', cost: 30, size: 1.25, abd: [-6, 4.6, 3.6], head: [4.8, 2.4, 2.2], jaws: false,
      tip: 'Heals the most hurt fighter near her. No bite and fragile: spitter splash and focus fire (F) kill her first.' },
    { id: 'alate', name: 'Alate', key: 'B', cost: 25, tech: 'first evolution', size: 1.35, abd: [-6.4, 3.4, 2.4], head: [5, 2.2, 2], jaws: true,
      tip: 'Winged raider: flies over rocks, mud and floods and hunts workers. Weak; spitters knock it down (double acid). Needs an upgrade first.' },
  ];
  const byId = Object.fromEntries(UNITS.map((u, i) => [u.id, i]));
  const ACID = '#a6e23a';

  // Details drawn on top of the shared body, in the ant's local frame (x forward, k = scale * size).
  function drawExtra(ctx, type, k, now, dark) {
    if (type === 2) { // spitter: swollen acid-green abdomen with a glowing tip
      const [ax, rx, ry] = UNITS[2].abd;
      ctx.fillStyle = 'rgba(166,226,58,.55)';
      ctx.beginPath(); ctx.ellipse(ax * k, 0, rx * 0.72 * k, ry * 0.68 * k, 0, 0, Math.PI * 2); ctx.fill();
      const glow = 0.6 + (globalThis.motionSin || Math.sin)(now / 160) * 0.25;
      ctx.fillStyle = `rgba(214,255,120,${glow.toFixed(3)})`;
      ctx.beginPath(); ctx.arc((ax - rx + 0.8) * k, 0, 1.1 * k, 0, Math.PI * 2); ctx.fill();
    } else if (type === 3) { // major: armor plate ridges across head and thorax
      ctx.strokeStyle = dark; ctx.lineWidth = 0.9 * k; ctx.lineCap = 'round';
      ctx.beginPath();
      for (const x of [4.6, 6.2]) { ctx.moveTo(x * k, -2.8 * k); ctx.quadraticCurveTo((x + 0.8) * k, 0, x * k, 2.8 * k); }
      ctx.moveTo(-1.2 * k, -1.7 * k); ctx.lineTo(1.2 * k, -1.7 * k);
      ctx.moveTo(-1.2 * k, 1.7 * k); ctx.lineTo(1.2 * k, 1.7 * k);
      ctx.stroke(); ctx.lineCap = 'butt';
      ctx.fillStyle = 'rgba(255,255,255,.18)';
      ctx.beginPath(); ctx.ellipse(5.4 * k, -1.4 * k, 1.6 * k, 0.9 * k, 0, 0, Math.PI * 2); ctx.fill();
    } else if (type === 4) { // nurse: pale abdomen with a white cross, carrying a white larva in her jaws
      const [ax, rx, ry] = UNITS[4].abd;
      ctx.fillStyle = 'rgba(255,240,220,.45)';
      ctx.beginPath(); ctx.ellipse(ax * k, 0, rx * 0.8 * k, ry * 0.75 * k, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.strokeStyle = 'rgba(30,110,50,.9)'; ctx.lineWidth = 0.6 * k;
      ctx.beginPath(); // a plus, outlined so it reads on both colonies' colours
      for (const [x, y, w, h] of [[ax - 0.9, -2.9, 1.8, 5.8], [ax - 2.9, -0.9, 5.8, 1.8]]) ctx.rect(x * k, y * k, w * k, h * k);
      ctx.stroke(); ctx.fill();
      ctx.fillStyle = '#fbf6ea'; ctx.strokeStyle = 'rgba(90,70,40,.8)'; ctx.lineWidth = 0.5 * k;
      ctx.beginPath(); ctx.ellipse(9.6 * k, 0, 2.9 * k, 1.9 * k, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.beginPath(); for (const x of [8.5, 9.6, 10.7]) { ctx.moveTo(x * k, -1.6 * k); ctx.lineTo(x * k, 1.6 * k); } ctx.stroke();
    } else if (type === 5) { // alate: two pairs of veined, see-through wings swept back over the body
      ctx.strokeStyle = 'rgba(30,30,50,.7)'; ctx.lineWidth = 0.5 * k;
      for (const sy of [-1, 1]) {
        for (const [len, wide, tilt] of [[12.5, 4.6, 0.55], [9, 3.4, 0.95]]) {
          ctx.save(); ctx.translate(0.5 * k, sy * 0.8 * k); ctx.rotate(Math.PI + sy * -tilt);
          ctx.fillStyle = 'rgba(235,245,255,.72)';
          ctx.beginPath(); ctx.ellipse(len / 2 * k, 0, len / 2 * k, wide / 2 * k, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(0.5 * k, 0); ctx.lineTo((len - 1) * k, 0); ctx.stroke();
          ctx.restore();
        }
      }
    }
  }

  // ant16 nurse heal beams: snapshot `heals` [[nurseId, targetId]], drawn between the ants as rendered now.
  const HEAL_MS = 220;
  const heals = new Map(); // "nurse:target" -> { n, t, at }
  function healPos(id) {
    const R = typeof Render !== 'undefined' ? Render : root.Render;
    const s = R && R.ants && R.ants.get(id);
    return s ? s : null;
  }
  function drawHeals(ctx, now, toScreen, scale) {
    for (const [key, h] of heals) {
      if (now - h.at > HEAL_MS) { heals.delete(key); continue; }
      const a = healPos(h.n), b = healPos(h.t);
      if (!a || !b) continue;
      const p = toScreen(a.x, a.y), q = toScreen(b.x, b.y), pulse = 0.5 + 0.3 * (globalThis.motionSin || Math.sin)(now / 90);
      ctx.strokeStyle = `rgba(150,255,170,${pulse.toFixed(3)})`; ctx.lineWidth = 2 * scale; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(p.x, p.y - 4 * scale); ctx.lineTo(q.x, q.y - 4 * scale); ctx.stroke();
      ctx.fillStyle = `rgba(200,255,210,${pulse.toFixed(3)})`; // a little "+" over the patient
      const y = q.y - (14 + ((now / 12) % 8)) * scale, w = 1.2 * scale, l = 4 * scale;
      ctx.fillRect(q.x - w, y - l, 2 * w, 2 * l); ctx.fillRect(q.x - l, y - w, 2 * l, 2 * w);
      ctx.lineCap = 'butt';
    }
  }

  // Acid globs: a short arc from spitter to target, then a splat. Shots come from snapshots.
  const FLIGHT = 260, SPLAT = 380;
  const shots = [];
  function onSnapshot(s, now) {
    for (const t of (s && s.shots) || []) shots.push({ x0: t[0], y0: t[1], x1: t[2], y1: t[3], c: t[4], at: now });
    if (shots.length > 200) shots.splice(0, shots.length - 200);
    for (const h of (s && s.heals) || []) heals.set(h[0] + ':' + h[1], { n: h[0], t: h[1], at: now }); // ant16
    if (heals.size > 240) heals.clear();
  }
  function drawShots(ctx, now, toScreen, scale) {
    drawHeals(ctx, now, toScreen, scale); // ant16 nurse beams, under the acid
    for (let i = shots.length - 1; i >= 0; i--) {
      const s = shots[i], age = now - s.at;
      if (age > FLIGHT + SPLAT) { shots.splice(i, 1); continue; }
      const b = toScreen(s.x1, s.y1);
      if (age < FLIGHT) {
        const t = age / FLIGHT, a = toScreen(s.x0, s.y0);
        const x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t - Math.sin(t * Math.PI) * 18 * scale - 4 * scale;
        ctx.fillStyle = ACID;
        ctx.beginPath(); ctx.arc(x, y, 2.6 * scale, 0, Math.PI * 2); ctx.fill();
      } else {
        const t = (age - FLIGHT) / SPLAT;
        ctx.fillStyle = `rgba(166,226,58,${(0.45 * (1 - t)).toFixed(3)})`;
        ctx.beginPath(); ctx.ellipse(b.x, b.y - 2 * scale, (10 + 10 * t) * scale, (5 + 5 * t) * scale, 0, 0, Math.PI * 2); ctx.fill();
      }
    }
  }

  // ---------- ant18 unit-look: the lit chitin painter ----------
  // paintAnt() draws one ant in its own frame (facing +x, k device px per unit; the caller applies the isometric squash and
  // translation). render.js bakes it into an atlas cell, so the cost is paid once per (colony, caste, heading bin, gait, pose)
  // and every ant is still one drawImage per frame. The light is fixed in screen space (top-left); `lightAng` is that direction
  // expressed in the ant's frame for the cell's heading bin, so every heading row is lit from the same corner.
  const INK = '#120c08', JAW = '#1b1610';
  const MARKS = ['bars', 'dots', 'chevrons', 'spine']; // per-colony chitin marking: colour is never the only cue
  const LIGHT_SCREEN = -2.4; // screen angle (rad) towards the key light: up and left
  const HEADINGS = 8;
  // Level of detail from k (device px per unit): the same painter simplifies itself when ants are a few pixels long.
  const lodFor = k => (k < 1.1 ? 0 : k < 2.4 ? 1 : 2);
  const headingAngle = bin => (bin * Math.PI * 2) / HEADINGS;
  const lightFor = bin => LIGHT_SCREEN - headingAngle(bin);
  const hex = c => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
  const mix = (a, b, t) => { const x = hex(a), y = hex(b); return `rgb(${Math.round(x[0] + (y[0] - x[0]) * t)},${Math.round(x[1] + (y[1] - x[1]) * t)},${Math.round(x[2] + (y[2] - x[2]) * t)})`; };
  const binFor = ang => { const T = Math.PI * 2; return Math.round((((ang % T) + T) % T) / T * HEADINGS) % HEADINGS; };

  // Colony marking on the abdomen, clipped to it, over an ink underlay so it reads on any base colour.
  function paintMark(g, k, mark, U, fill, lod, region) {
    const [ex, rx, ry] = U.abd, x0 = region ? region[0] : ex - rx * 0.92, x1 = region ? region[1] : ex + rx * 0.92, span = x1 - x0;
    const at = f => x0 + span * f;
    g.save();
    g.beginPath(); g.ellipse(ex * k, 0, rx * k, ry * k, 0, 0, Math.PI * 2); g.clip();
    g.lineCap = 'butt'; g.lineJoin = 'round';
    const strokeTwice = (w, draw) => {
      g.strokeStyle = INK; g.lineWidth = (w + 0.75) * k; g.beginPath(); draw(); g.stroke();
      g.strokeStyle = fill; g.lineWidth = w * k; g.beginPath(); draw(); g.stroke();
    };
    if (mark === 'bars') {
      for (const f of (lod ? (span > 5 ? [0.28, 0.72] : [0.3, 0.8]) : [0.5])) strokeTwice(1.1, () => { g.moveTo(at(f) * k, -ry * 1.1 * k); g.lineTo(at(f) * k, ry * 1.1 * k); });
    } else if (mark === 'dots') {
      const r = Math.min(ry * 0.4, 1.15);
      for (const f of (lod ? (span > 5 ? [0.18, 0.5, 0.82] : [0.3, 0.75]) : [0.3, 0.72])) {
        g.fillStyle = INK; g.beginPath(); g.arc(at(f) * k, 0, (r + 0.4) * k, 0, Math.PI * 2); g.fill();
        g.fillStyle = fill; g.beginPath(); g.arc(at(f) * k, 0, r * k, 0, Math.PI * 2); g.fill();
      }
    } else if (mark === 'chevrons') {
      for (const f of (lod ? (span > 5 ? [0.3, 0.72] : [0.35, 0.8]) : [0.55])) strokeTwice(0.95, () => { g.moveTo((at(f) - 1) * k, -ry * 0.85 * k); g.lineTo((at(f) + 0.9) * k, 0); g.lineTo((at(f) - 1) * k, ry * 0.85 * k); });
    } else { // spine: a lengthwise stripe
      strokeTwice(1.15, () => { g.moveTo((x0 - 0.5) * k, 0); g.lineTo((x1 + 0.5) * k, 0); });
    }
    g.restore();
  }

  // Emissive pass: eyes, thorax tech-mark and the spitter's tip glow, added on top of the lit body with soft halos.
  function paintEmissive(g, k, type, U, pal, lod) {
    const ex = (U.head[0] + U.head[1] * 0.35) * k, ey = U.head[2] * 0.55 * k;
    if (lod) {
      g.save(); g.globalCompositeOperation = 'lighter';
      for (const s of [-1, 1]) {
        const h = g.createRadialGradient(ex, s * ey, 0, ex, s * ey, 1.4 * k);
        h.addColorStop(0, 'rgba(255,255,255,.26)'); h.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = h; g.beginPath(); g.arc(ex, s * ey, 1.4 * k, 0, Math.PI * 2); g.fill();
      }
      g.restore();
    }
    g.fillStyle = pal.glow;
    for (const s of [-1, 1]) { g.beginPath(); g.arc(ex, s * ey, (lod ? 0.62 : 0.95) * k, 0, Math.PI * 2); g.fill(); }
    // Thorax tech-mark: a bio-circuit line in the faction glow tint; soldiers and majors carry the strongest one.
    g.strokeStyle = pal.glow; g.lineCap = 'round'; g.lineJoin = 'round';
    g.lineWidth = (lod ? 0.6 : 0.95) * k;
    g.beginPath(); g.moveTo(-1.6 * k, 0); g.lineTo(1.4 * k, 0);
    if (lod) {
      if (type === 1 || type === 3) { g.moveTo(-0.7 * k, 0); g.lineTo(-0.7 * k, -1.3 * k); g.moveTo(0.5 * k, 0); g.lineTo(0.5 * k, 1.3 * k); g.moveTo(1.4 * k, 0); g.lineTo(1.4 * k, -0.9 * k); }
      else { g.moveTo(0.2 * k, 0); g.lineTo(0.2 * k, 1.1 * k); }
    }
    g.stroke();
    if (type === 2) { // spitter: hot acid tip
      const t = (U.abd[0] - U.abd[1] + 0.8) * k;
      if (lod) {
        g.save(); g.globalCompositeOperation = 'lighter';
        const h = g.createRadialGradient(t, 0, 0, t, 0, 2.4 * k); h.addColorStop(0, 'rgba(190,255,90,.5)'); h.addColorStop(1, 'rgba(190,255,90,0)');
        g.fillStyle = h; g.beginPath(); g.arc(t, 0, 2.4 * k, 0, Math.PI * 2); g.fill(); g.restore();
      }
      g.fillStyle = '#eaffa0'; g.beginPath(); g.arc(t, 0, k, 0, Math.PI * 2); g.fill();
    }
    g.lineCap = 'butt';
  }

  /** o: { type, side, pal:{base,dark,light,glow}, swing (-1..1), wig (-1..1), pose, dead, bin (0..7), px, lod (default from k) } */
  function paintAnt(g, k, o) {
    const type = UNITS[o.type] ? o.type : 1, U = UNITS[type], side = o.side | 0, dead = !!o.dead;
    const lod = o.lod === undefined ? lodFor(k) : o.lod, px = (o.px || 1) * (lod ? 1 : 1.35), swing = o.swing || 0, wig = o.wig || 0, pose = !!o.pose;
    const P = o.pal;
    const pal = dead ? { base: P.dark, dark: P.dark, light: P.base, glow: P.dark } : P;
    const la = o.lightAng === undefined ? lightFor(o.bin | 0) : o.lightAng, lx = Math.cos(la), ly = Math.sin(la);
    const reach = dead ? 0.55 : 1, legCol = dead ? pal.dark : mix(pal.dark, pal.base, 0.42); // a touch lighter than the shell's shade so legs read on a dark ground
    // Legs: dark tubes with a lighter cap on the lit side so they read as limbs, not hairlines.
    g.lineJoin = 'round'; g.lineCap = 'round';
    for (const pass of lod ? [0, 1] : [0]) {
      g.strokeStyle = pass ? pal.light : legCol; g.lineWidth = (pass ? 0.4 : lod ? 1.2 : 1.5) * k; g.globalAlpha = pass ? 0.4 : 1;
      g.beginPath();
      for (let i = 0; i < 3; i++) {
        const hx = (i - 1) * 2 * k, spread = (i - 1) * 3.2 * k * reach;
        for (const s of [-1, 1]) {
          if (pass && s * ly <= 0) continue;
          const sw = swing * ((i % 2 === 0) === (s < 0) ? 1 : -1) * 2.2 * k * (dead ? 0 : 1), lift = Math.max(0, sw) * 0.25;
          g.moveTo(hx, s * 1.5 * k); g.lineTo(hx + spread * 0.5 + sw * 0.5, s * (4.5 * k - lift) * reach); g.lineTo(hx + spread + sw, s * 7 * k * reach);
        }
      }
      g.stroke();
    }
    g.globalAlpha = 1;
    // Antennae with a bead at the tip.
    const an = wig * 0.6 * k;
    g.strokeStyle = pal.dark; g.lineWidth = (lod ? 0.7 : 1) * k; g.beginPath();
    g.moveTo(6 * k, -k); g.quadraticCurveTo(9 * k, -4 * k + an, 11.5 * k, -3 * k + an);
    g.moveTo(6 * k, k); g.quadraticCurveTo(9 * k, 4 * k - an, 11.5 * k, 3 * k - an);
    g.stroke();
    if (lod) { g.fillStyle = pal.dark; for (const s of [-1, 1]) { g.beginPath(); g.arc(11.5 * k, s * 3 * k - s * an, 0.55 * k, 0, Math.PI * 2); g.fill(); } }
    g.lineCap = 'butt';
    // Alate wings behind the body: veined, see-through, with a lit leading edge.
    if (type === 5 && !dead) {
      for (const s of [-1, 1]) for (const [len, wide, tilt] of [[12.5, 4.6, 0.55], [9, 3.4, 0.95]]) {
        g.save(); g.translate(0.5 * k, s * 0.8 * k); g.rotate(Math.PI + s * -tilt);
        const w = g.createLinearGradient(0, 0, len * k, 0); w.addColorStop(0, 'rgba(240,250,255,.82)'); w.addColorStop(1, 'rgba(200,225,255,.3)');
        g.fillStyle = w; g.strokeStyle = 'rgba(30,30,50,.7)'; g.lineWidth = Math.max(0.4 * k, px * 0.8);
        g.beginPath(); g.ellipse(len / 2 * k, 0, len / 2 * k, wide / 2 * k, 0, 0, Math.PI * 2); g.fill(); g.stroke();
        if (lod) {
          g.beginPath(); g.moveTo(0.5 * k, 0); g.lineTo((len - 1) * k, 0); g.moveTo(2 * k, 0); g.lineTo(len * 0.6 * k, -wide * 0.3 * k); g.moveTo(2 * k, 0); g.lineTo(len * 0.6 * k, wide * 0.3 * k); g.stroke();
          g.strokeStyle = 'rgba(255,255,255,.7)'; g.lineWidth = 0.4 * k; g.beginPath(); g.ellipse(len / 2 * k, 0, len / 2 * k * 0.97, wide / 2 * k * 0.97, 0, Math.PI * 1.1, Math.PI * 1.75); g.stroke();
        }
        g.restore();
      }
    }
    // Body segments back to front: abdomen, petiole, thorax, head. Radial shade aimed at the light, ink outline, rim arc.
    const segs = [U.abd, [-2.6, 1.1, 0.9], [0, 2.8, 2.1], U.head];
    const pale = type === 4 && !dead;
    segs.forEach(([ex, rx, ry], i) => {
      if (i === 1 && !lod) return;
      const abdPale = pale && i === 0;
      if (dead) g.fillStyle = pal.dark;
      else {
        const grad = g.createRadialGradient((ex + lx * rx * 0.45) * k, ly * ry * 0.45 * k, 0, ex * k, 0, Math.max(rx, ry) * 1.35 * k);
        grad.addColorStop(0, abdPale ? '#fff8ee' : pal.light); grad.addColorStop(0.45, abdPale ? '#f1e4d2' : pal.base); grad.addColorStop(1, abdPale ? '#8f6e52' : pal.dark);
        g.fillStyle = grad;
      }
      g.beginPath(); g.ellipse(ex * k, 0, rx * k, ry * k, 0, 0, Math.PI * 2); g.fill();
      g.strokeStyle = INK; g.lineWidth = px; g.stroke();
      if (lod && !dead) { // rim light on the lit edge
        g.strokeStyle = 'rgba(255,255,255,.5)'; g.lineWidth = 0.5 * k; g.beginPath();
        const a0 = Math.atan2(ly * ry, lx * rx);
        g.ellipse(ex * k, 0, rx * k * 0.9, ry * k * 0.9, 0, a0 - 0.7, a0 + 0.7); g.stroke();
      }
      if (i === 0 && lod && !dead) { // tergite lines: dark arcs across the abdomen
        g.strokeStyle = 'rgba(18,12,8,.45)'; g.lineWidth = 0.55 * k; g.beginPath();
        for (const f of [0.15, 0.55]) g.ellipse((ex + rx * (f - 0.5) * 0.9) * k, 0, rx * 0.35 * k, ry * 0.95 * k, 0, -1.3, 1.3);
        g.stroke();
      }
    });
    if (!dead) {
      let markRegion = null;
      if (type === 2) { // spitter: translucent acid sac across the swollen abdomen
        const [ax, rx, ry] = U.abd, s = g.createRadialGradient((ax - rx * 0.5) * k, 0, 0, ax * k, 0, rx * k);
        s.addColorStop(0, 'rgba(214,255,120,.9)'); s.addColorStop(0.5, 'rgba(166,226,58,.5)'); s.addColorStop(1, 'rgba(166,226,58,0)');
        g.fillStyle = s; g.beginPath(); g.ellipse(ax * k, 0, rx * 0.85 * k, ry * 0.8 * k, 0, 0, Math.PI * 2); g.fill();
      } else if (type === 3) { // major: chamfered plates over thorax and head, lit edges
        g.strokeStyle = INK; g.lineWidth = Math.max(0.7 * k, px); g.lineCap = 'round'; g.beginPath();
        for (const x of lod ? [4.2, 6.0, 7.6] : [4.6, 6.6]) { g.moveTo(x * k, -3.1 * k); g.quadraticCurveTo((x + 0.9) * k, 0, x * k, 3.1 * k); }
        g.moveTo(-1.6 * k, -1.9 * k); g.lineTo(1.6 * k, -1.9 * k); g.moveTo(-1.6 * k, 1.9 * k); g.lineTo(1.6 * k, 1.9 * k); g.stroke();
        if (lod) { g.strokeStyle = 'rgba(255,255,255,.5)'; g.lineWidth = 0.35 * k; g.beginPath(); for (const x of [4.2, 6.0, 7.6]) { g.moveTo((x - 0.3) * k, -2.6 * k); g.quadraticCurveTo((x + 0.5) * k, -1.2 * k, (x + 0.3) * k, 0); } g.stroke(); }
        g.lineCap = 'butt';
      } else if (type === 4) { // nurse: pale abdomen with a green cross, forward of the colony marking
        const [ax, rx] = U.abd, cx = ax + rx * 0.3;
        markRegion = [ax - rx * 0.92, ax - rx * 0.45];
        g.fillStyle = '#4fd86a'; g.strokeStyle = INK; g.lineWidth = Math.max(0.4 * k, px * 0.7);
        g.beginPath(); g.rect((cx - 0.7) * k, -2.4 * k, 1.4 * k, 4.8 * k); g.rect((cx - 2.4) * k, -0.7 * k, 4.8 * k, 1.4 * k);
        g.stroke(); g.fill();
      }
      paintMark(g, k, MARKS[side % MARKS.length], U, pale ? pal.dark : pal.glow, lod, markRegion);
      paintEmissive(g, k, type, U, pal, lod);
    }
    // Head gear: mandibles (a soldier's span wider than its head, a major's heavy, an alate's slender) or the carried load.
    if (U.jaws) {
      const open = pose ? 1.9 : 0.5, w = type === 1 ? 1.45 : type === 3 ? 1.3 : type === 5 ? 0.8 : 1;
      const y0 = 1.6 * w, y1 = (1.6 + open) * w + (w - 1);
      g.strokeStyle = JAW; g.lineWidth = (type === 5 ? 1.1 : type === 3 ? 1.9 : 1.55) * k; g.lineCap = 'round';
      g.beginPath();
      g.moveTo(8 * k, -y0 * k); g.quadraticCurveTo(10.5 * k, -y1 * k, 12 * k, -0.3 * k);
      g.moveTo(8 * k, y0 * k); g.quadraticCurveTo(10.5 * k, y1 * k, 12 * k, 0.3 * k);
      g.stroke();
      if (lod && !dead) { g.strokeStyle = 'rgba(255,255,255,.4)'; g.lineWidth = 0.4 * k; g.beginPath(); g.moveTo(8.3 * k, -(y0 + 0.3) * k); g.quadraticCurveTo(10.3 * k, -(y1 + 0.4) * k, 11.6 * k, -0.9 * k); g.stroke(); }
      g.lineCap = 'butt';
    } else if ((pose || type === 4) && !dead) { // worker carrying a crumb, nurse carrying a larva
      if (type === 4) {
        g.fillStyle = '#fbf6ea'; g.strokeStyle = INK; g.lineWidth = px;
        g.beginPath(); g.ellipse(9.6 * k, 0, 2.9 * k, 1.9 * k, 0, 0, Math.PI * 2); g.fill(); g.stroke();
        if (lod) { g.strokeStyle = 'rgba(90,70,40,.8)'; g.lineWidth = 0.5 * k; g.beginPath(); for (const x of [8.5, 9.6, 10.7]) { g.moveTo(x * k, -1.6 * k); g.lineTo(x * k, 1.6 * k); } g.stroke(); }
      } else {
        g.fillStyle = '#9fd65a'; g.strokeStyle = INK; g.lineWidth = px;
        g.beginPath(); g.arc(9.5 * k, 0, 2.4 * k, 0, Math.PI * 2); g.fill(); g.stroke();
        if (lod) { g.fillStyle = 'rgba(234,255,160,.7)'; g.beginPath(); g.arc(8.8 * k, -0.8 * k, 0.8 * k, 0, Math.PI * 2); g.fill(); }
      }
    }
  }


  const api = { UNITS, byId, drawExtra, onSnapshot, drawShots, paintAnt, MARKS, HEADINGS, binFor, headingAngle, lightFor, lodFor, INK };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.UnitArt = api;
})(typeof window !== 'undefined' ? window : globalThis);
