// ant19/ui-world: the in-world UI in the bug-tech language (docs/art-overhaul.md section 5 "UI tie-in"):
// selection rings, hp bars, rally flag (shown only for the selected building, with a tether line and a green worker forage flag), pings, and the minimap pieces. Visual only; no input or game logic here.
// Every helper takes the 2D context as its first argument and draws flat fills and strokes: no gradients, no
// per-frame canvas creation (the minimap field is cached in one offscreen canvas). Reduced motion (motionSin is
// a steady 0 then) removes the pulses, the flag wave and the ping bob.
// Colours come from theme.css (--acid, --amber, --edge, --edge-hi, --panel, --ink-dim); shapes carry the meaning too,
// so nothing depends on hue alone (the order kind sits on four corner ticks; ping kinds have their own glyph).
(function (root) {
  const INK = '#120c08', ACID = '#a6ff3c', HOT = '#eaffa0', AMBER = '#ffb81c', DANGER = '#ff4a3a', INK_DIM = '#a9b99a';
  const PANEL = '#0d140b', EDGE = '#3d5a28', EDGE_HI = '#7cc22e';
  const wave = x => (root.motionSin ? root.motionSin(x) : Math.sin(x)); // 0 when Reduced motion is on
  const PI2 = Math.PI * 2;

  // ---------- selection / hover rings ----------
  // list: [{ x, y, k, tick }] screen centre, size factor (scale * unit size), tick colour (the order kind).
  // Few passes however many ants: ink halo, outer ring, inner ring, ticks grouped by colour.
  function rings(ctx, list, o = {}) {
    if (!list.length) return;
    const col = o.color || ACID, a = (o.alpha == null ? 1 : o.alpha) * (0.88 + 0.12 * wave((o.now || 0) / 260));
    const rx = e => Math.max(4.5, 10 * e.k), ry = e => rx(e) * 0.5;
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.globalAlpha = a * 0.6; ctx.strokeStyle = INK; ctx.lineWidth = 3.6;
    ctx.beginPath(); for (const e of list) { ctx.moveTo(e.x + rx(e), e.y); ctx.ellipse(e.x, e.y, rx(e), ry(e), 0, 0, PI2); } ctx.stroke();
    ctx.globalAlpha = a; ctx.strokeStyle = col; ctx.lineWidth = 1.6;
    ctx.beginPath(); for (const e of list) { ctx.moveTo(e.x + rx(e), e.y); ctx.ellipse(e.x, e.y, rx(e), ry(e), 0, 0, PI2); } ctx.stroke();
    ctx.globalAlpha = a * 0.5; ctx.lineWidth = 1;
    ctx.beginPath(); for (const e of list) { const r = rx(e) * 0.62; ctx.moveTo(e.x + r, e.y); ctx.ellipse(e.x, e.y, r, r * 0.5, 0, 0, PI2); } ctx.stroke();
    if (!o.noTicks) { // four corner ticks at the ellipse extremes, coloured by the ant's current order
      const by = new Map();
      for (const e of list) { const c = e.tick || col; if (!by.has(c)) by.set(c, []); by.get(c).push(e); }
      ctx.globalAlpha = a; ctx.lineWidth = 2.4; ctx.lineCap = 'butt';
      for (const [c, es] of by) {
        ctx.strokeStyle = c; ctx.beginPath();
        for (const e of es) {
          const X = rx(e), Y = ry(e);
          ctx.moveTo(e.x - X * 0.9, e.y); ctx.lineTo(e.x - X * 1.28, e.y); ctx.moveTo(e.x + X * 0.9, e.y); ctx.lineTo(e.x + X * 1.28, e.y);
          ctx.moveTo(e.x, e.y - Y * 0.9); ctx.lineTo(e.x, e.y - Y * 1.45); ctx.moveTo(e.x, e.y + Y * 0.9); ctx.lineTo(e.x, e.y + Y * 1.45);
        }
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  // ---------- hp bars ----------
  // Ink outline, --panel backing, faction fill; at a third or less the fill turns amber (plus a lit end cap, so it is
  // not a hue-only cue). opts.chamfer cuts two corners like the HUD panels (nests, boss), opts.quarters adds ticks.
  function hpBar(ctx, x, y, w, h, frac, color, o = {}) {
    frac = Math.max(0, Math.min(1, frac));
    const low = frac <= 1 / 3;
    if (o.chamfer && h >= 3) {
      const c = Math.min(h * 0.5, 4);
      ctx.fillStyle = INK; ctx.beginPath();
      ctx.moveTo(x - 1 + c, y - 1); ctx.lineTo(x + w + 1, y - 1); ctx.lineTo(x + w + 1, y + h + 1 - c); ctx.lineTo(x + w + 1 - c, y + h + 1); ctx.lineTo(x - 1, y + h + 1); ctx.lineTo(x - 1, y - 1 + c);
      ctx.closePath(); ctx.fill();
    } else { ctx.fillStyle = INK; ctx.fillRect(x - 1, y - 1, w + 2, h + 2); }
    ctx.fillStyle = PANEL; ctx.fillRect(x, y, w, h);
    ctx.fillStyle = low ? AMBER : color; ctx.fillRect(x, y, w * frac, h);
    if (low && frac > 0 && w * frac > 3) { ctx.fillStyle = HOT; ctx.fillRect(x + w * frac - 1, y, 1, h); }
    if (o.quarters && w >= 24) {
      ctx.fillStyle = INK; ctx.globalAlpha = 0.7;
      for (let i = 1; i < 4; i++) ctx.fillRect(x + w * i / 4 - 0.5, y, 1, h);
      ctx.globalAlpha = 1;
    }
  }
  // The small bar over an ant. Shown when hurt, or always when the ant is selected.
  function antBar(ctx, cx, cy, k, hp, color, selected) {
    if (hp >= 100 && !selected) return;
    const w = Math.max(8, 14 * k), h = Math.max(2, 2.2 * k);
    hpBar(ctx, cx - w / 2, cy - 14 * k, w, h, hp / 100, color);
  }

  // ---------- rally flag ----------
  // Ground ring, pole and a swallow-tailed pennant (the notch is the shared motif) with amber trim.
  function rally(ctx, c, k, color, now) {
    const t = now == null ? 0 : now, fl = wave(t / 240) * 1.6 * k, fl2 = wave(t / 240 + 1.3) * 1.6 * k;
    ctx.save();
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.strokeStyle = INK; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.ellipse(c.x, c.y, 14 * k, 7 * k, 0, 0, PI2); ctx.stroke();
    ctx.strokeStyle = color; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.ellipse(c.x, c.y, 14 * k, 7 * k, 0, 0, PI2); ctx.stroke();
    ctx.strokeStyle = INK; ctx.lineWidth = Math.max(3, 3.6 * k);
    ctx.beginPath(); ctx.moveTo(c.x, c.y); ctx.lineTo(c.x, c.y - 28 * k); ctx.stroke();
    ctx.strokeStyle = '#d8c9a8'; ctx.lineWidth = Math.max(1.4, 1.6 * k);
    ctx.beginPath(); ctx.moveTo(c.x, c.y); ctx.lineTo(c.x, c.y - 28 * k); ctx.stroke();
    const top = c.y - 27 * k;
    ctx.beginPath();
    ctx.moveTo(c.x, top); ctx.lineTo(c.x + 17 * k, top + 2 * k + fl); ctx.lineTo(c.x + 12 * k, top + 6.5 * k + (fl + fl2) / 2); ctx.lineTo(c.x + 17 * k, top + 11 * k + fl2); ctx.lineTo(c.x, top + 11 * k);
    ctx.closePath();
    ctx.fillStyle = color; ctx.fill();
    ctx.strokeStyle = INK; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.strokeStyle = AMBER; ctx.lineWidth = Math.max(1.2, 1.5 * k); // trim along the hoist edge
    ctx.beginPath(); ctx.moveTo(c.x + 1.5 * k, top + 1.5 * k); ctx.lineTo(c.x + 1.5 * k, top + 9.5 * k); ctx.stroke();
    ctx.fillStyle = AMBER; ctx.beginPath(); ctx.arc(c.x, top - 1.5 * k, Math.max(1.4, 2 * k), 0, PI2); ctx.fill();
    ctx.restore();
  }

  // The tether from a selected building to one of its flags: ink-backed dashes, so it reads on any ground and is not hue alone.
  function flagLine(ctx, a, b, k, color) {
    ctx.save();
    ctx.lineCap = 'round';
    const dash = [Math.max(4, 7 * k), Math.max(3, 5 * k)];
    ctx.setLineDash && ctx.setLineDash(dash);
    ctx.globalAlpha = 0.7; ctx.strokeStyle = INK; ctx.lineWidth = 3.4;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    ctx.globalAlpha = 0.9; ctx.strokeStyle = color; ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    ctx.restore();
  }

  // The worker forage target: a green ground diamond and a short pole with a square pennant and a leaf diamond,
  // so it is told from the fighter rally (swallow-tailed, colony colour) by shape as well as hue.
  const LEAF = '#a8e05e';
  function forage(ctx, c, k, now) {
    const t = now == null ? 0 : now, fl = wave(t / 260) * 1.2 * k;
    ctx.save();
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    const dia = (x, y, rx, ry) => { ctx.beginPath(); ctx.moveTo(x, y - ry); ctx.lineTo(x + rx, y); ctx.lineTo(x, y + ry); ctx.lineTo(x - rx, y); ctx.closePath(); };
    ctx.strokeStyle = INK; ctx.lineWidth = 4; dia(c.x, c.y, 13 * k, 6.5 * k); ctx.stroke();
    ctx.strokeStyle = LEAF; ctx.lineWidth = 2; dia(c.x, c.y, 13 * k, 6.5 * k); ctx.stroke();
    ctx.strokeStyle = INK; ctx.lineWidth = Math.max(3, 3.2 * k);
    ctx.beginPath(); ctx.moveTo(c.x, c.y); ctx.lineTo(c.x, c.y - 22 * k); ctx.stroke();
    ctx.strokeStyle = '#d8c9a8'; ctx.lineWidth = Math.max(1.3, 1.5 * k);
    ctx.beginPath(); ctx.moveTo(c.x, c.y); ctx.lineTo(c.x, c.y - 22 * k); ctx.stroke();
    const top = c.y - 21 * k;
    ctx.beginPath(); ctx.moveTo(c.x, top); ctx.lineTo(c.x + 13 * k, top + 1.5 * k + fl); ctx.lineTo(c.x + 13 * k, top + 8.5 * k + fl); ctx.lineTo(c.x, top + 9 * k); ctx.closePath();
    ctx.fillStyle = LEAF; ctx.fill(); ctx.strokeStyle = INK; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.fillStyle = INK; dia(c.x + 6.5 * k, top + 5 * k + fl * 0.8, 2.6 * k, 3.2 * k); ctx.fill();
    ctx.restore();
  }

  // ---------- pings ----------
  // Amber chamfered badge on a faction-coloured stem (who pinged) with a vector glyph per kind, so kind never rides on colour.
  const GLYPH = {
    attack(ctx, x, y, r) { ctx.beginPath(); ctx.moveTo(x - r, y - r); ctx.lineTo(x + r, y + r); ctx.moveTo(x + r, y - r); ctx.lineTo(x - r, y + r); ctx.stroke(); },
    defend(ctx, x, y, r) { ctx.beginPath(); ctx.moveTo(x - r, y - r); ctx.lineTo(x + r, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r * 1.3); ctx.lineTo(x - r, y); ctx.closePath(); ctx.stroke(); },
    help(ctx, x, y, r) { ctx.beginPath(); ctx.moveTo(x, y - r * 1.1); ctx.lineTo(x, y + r * 0.3); ctx.stroke(); ctx.beginPath(); ctx.arc(x, y + r * 0.95, Math.max(1, r * 0.22), 0, PI2); ctx.fillStyle = INK; ctx.fill(); },
  };
  function ping(ctx, c, k, age, life, color, kind) {
    const fade = Math.max(0, Math.min(1, (life - age) / 600)), moving = !!root.motionSin && wave(1) !== 0;
    ctx.save();
    ctx.lineJoin = 'round';
    for (let i = 0; i < 2; i++) { // two amber rings pulsing outward (one still ring in Reduced motion)
      const t = moving ? ((age / 1000) + i / 2) % 1 : 0.5, rx = (8 + 30 * t) * k;
      ctx.globalAlpha = (1 - t) * fade * (moving ? 1 : 0.8);
      ctx.strokeStyle = INK; ctx.lineWidth = 4.2; ctx.beginPath(); ctx.ellipse(c.x, c.y, rx, rx / 2, 0, 0, PI2); ctx.stroke();
      ctx.strokeStyle = AMBER; ctx.lineWidth = 2.2; ctx.beginPath(); ctx.ellipse(c.x, c.y, rx, rx / 2, 0, 0, PI2); ctx.stroke();
    }
    ctx.globalAlpha = fade;
    const by = c.y - 36 * k + wave(age / 150) * 3 * k, r = 12 * k, ch = r * 0.42;
    ctx.strokeStyle = INK; ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(c.x, c.y); ctx.lineTo(c.x, by + r); ctx.stroke();
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(c.x, c.y); ctx.lineTo(c.x, by + r); ctx.stroke();
    ctx.beginPath(); // chamfered badge
    ctx.moveTo(c.x - r + ch, by - r); ctx.lineTo(c.x + r - ch, by - r); ctx.lineTo(c.x + r, by - r + ch); ctx.lineTo(c.x + r, by + r - ch);
    ctx.lineTo(c.x + r - ch, by + r); ctx.lineTo(c.x - r + ch, by + r); ctx.lineTo(c.x - r, by + r - ch); ctx.lineTo(c.x - r, by - r + ch); ctx.closePath();
    ctx.fillStyle = AMBER; ctx.fill(); ctx.strokeStyle = INK; ctx.lineWidth = 2; ctx.stroke();
    ctx.strokeStyle = color; ctx.lineWidth = 1.2; // faction rim inside the badge
    ctx.beginPath(); ctx.moveTo(c.x - r + ch + 1, by - r + 2.2); ctx.lineTo(c.x + r - ch - 1, by - r + 2.2); ctx.stroke();
    ctx.strokeStyle = INK; ctx.lineWidth = Math.max(1.6, 2.2 * k); ctx.lineCap = 'round';
    (GLYPH[kind] || GLYPH.help)(ctx, c.x, by + 0.6 * k, r * 0.5);
    ctx.restore();
  }

  // ---------- minimap pieces (called from minimap.js draw) ----------
  let baseCv = null, baseKey = '';
  // Field + faint grid + rim, cached in one offscreen canvas and blitted. `at` maps world tiles to minimap px.
  function miniBase(g, mm, at, m) {
    const a = at(0, 0), b = at(m, 0);
    const dpr = root.devicePixelRatio || 1;
    const key = [mm.w, mm.h, m, dpr, a.x, a.y, b.x, b.y].map(v => Math.round(v * 10) / 10).join('|');
    const doc = root.document;
    if (key !== baseKey || !baseCv) {
      let cv = null, bg = g;
      if (doc && doc.createElement) { cv = doc.createElement('canvas'); cv.width = Math.max(1, Math.round(mm.w * dpr)); cv.height = Math.max(1, Math.round(mm.h * dpr)); bg = cv.getContext('2d'); if (bg && bg.setTransform) bg.setTransform(dpr, 0, 0, dpr, 0, 0); }
      paintBase(bg, at, m);
      baseCv = cv; baseKey = cv ? key : '';
      if (!cv) return; // no DOM (tests): painted directly this time
    }
    g.drawImage(baseCv, 0, 0, mm.w, mm.h);
  }
  function paintBase(g, at, m) {
    const quad = [at(0, 0), at(m, 0), at(m, m), at(0, m)];
    const path = () => { g.beginPath(); quad.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y))); g.closePath(); };
    path(); g.fillStyle = '#121b0d'; g.fill();
    const step = m > 40 ? 8 : 4;
    g.save(); path(); g.clip();
    g.strokeStyle = 'rgba(61,90,40,.55)'; g.lineWidth = 1; g.beginPath();
    for (let i = step; i < m; i += step) { const p = at(i, 0), q = at(i, m), r = at(0, i), s = at(m, i); g.moveTo(p.x, p.y); g.lineTo(q.x, q.y); g.moveTo(r.x, r.y); g.lineTo(s.x, s.y); }
    g.stroke(); g.restore();
    path(); g.strokeStyle = INK; g.lineWidth = 3; g.stroke();
    g.strokeStyle = EDGE_HI; g.lineWidth = 1.2; g.stroke();
  }
  function miniNest(g, c, color, alive) {
    const w = 11, h = 8, x = c.x - w / 2, y = c.y - h / 2, cut = 2.5;
    g.beginPath();
    g.moveTo(x + cut, y); g.lineTo(x + w, y); g.lineTo(x + w, y + h - cut); g.lineTo(x + w - cut, y + h); g.lineTo(x, y + h); g.lineTo(x, y + cut); g.closePath();
    g.fillStyle = alive ? color : '#5c4630'; g.fill(); g.strokeStyle = INK; g.lineWidth = 1.5; g.stroke();
    g.fillStyle = INK; g.fillRect(c.x - 1, c.y - 1, 2, 2); // the hole
  }
  // Every ant as a small square: one ink halo path, then one path per colour. picked (a Set of ids) gets a bright, larger square.
  function miniAnts(g, ants, at, colors, picked) {
    const by = new Map(); let n = 0;
    g.fillStyle = INK; g.beginPath();
    for (const a of ants) {
      const c = at(a[3], a[4]), r = a[2] ? 1.9 : 1.3, sel = picked && picked.has(a[0]), ck = sel ? '#' : colors[a[1]];
      let e = by.get(ck); if (!e) by.set(ck, e = []);
      const rr = sel ? r + 0.7 : r; e.push(c.x - rr, c.y - rr, rr * 2);
      g.rect(c.x - rr - 0.8, c.y - rr - 0.8, rr * 2 + 1.6, rr * 2 + 1.6); n++;
    }
    if (n) g.fill();
    for (const [ck, e] of by) {
      g.fillStyle = ck === '#' ? HOT : ck; g.beginPath();
      for (let i = 0; i < e.length; i += 3) g.rect(e[i], e[i + 1], e[i + 2], e[i + 2]);
      g.fill();
    }
  }
  function miniPing(g, c, color, t) {
    g.strokeStyle = INK; g.lineWidth = 3.4; g.globalAlpha = 1 - t; g.beginPath(); g.arc(c.x, c.y, 3 + 9 * t, 0, PI2); g.stroke();
    g.strokeStyle = AMBER; g.lineWidth = 1.8; g.beginPath(); g.arc(c.x, c.y, 3 + 9 * t, 0, PI2); g.stroke();
    g.globalAlpha = 1;
    g.fillStyle = color; g.strokeStyle = INK; g.lineWidth = 1.2; g.beginPath(); g.arc(c.x, c.y, 2.6, 0, PI2); g.fill(); g.stroke();
  }
  function miniView(g, x, y, w, h) {
    g.strokeStyle = INK; g.lineWidth = 3.4; g.strokeRect(x, y, w, h);
    g.strokeStyle = ACID; g.lineWidth = 1.4; g.strokeRect(x, y, w, h);
  }

  // Hover: the ant under the cursor gets a thin ally-coloured ring. The cursor is tracked here (passive listener).
  let mx = -1, my = -1, hov = null;
  if (root.addEventListener) root.addEventListener('pointermove', e => { mx = e.clientX; my = e.clientY; hov = e.target; }, { passive: true });
  const cursor = () => (hov && hov.id === 'c' && mx >= 0 ? { x: mx, y: my } : null);

  root.UIWorld = { rings, hpBar, antBar, rally, flagLine, forage, ping, miniBase, miniNest, miniAnts, miniPing, miniView, cursor, INK_DIM, ACID, AMBER, DANGER, EDGE, _resetBase() { baseCv = null; baseKey = ''; } };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.UIWorld;
})(typeof window !== 'undefined' ? window : globalThis);
