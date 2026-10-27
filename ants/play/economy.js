// Economy client: drawing for pellet piles and the rich centre pile.
// Loaded after client.js and uses its globals (ctx, toScreen, hash, scale, drawFood).
// The evolution (upgrade) bar lives in research.js.

// Food tuples carry a 5th entry: 0 food, 1 pellet pile, 2 rich centre pile, 3 crumb (a dead ant's food; rots away).
const drawFoodBase = drawFood;
drawFood = function (f) {
  if (f[4] === 2) {
    const c = toScreen(f[1], f[2]);
    ctx.strokeStyle = 'rgba(240,216,106,.55)'; ctx.lineWidth = 2 * scale;
    ctx.beginPath(); ctx.ellipse(c.x, c.y, 24 * scale, 12 * scale, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.lineWidth = 1;
  }
  if (f[4] === 3) { // crumb: a few pale specks per couple of food, thinner as it rots; no pile sprite
    const c = toScreen(f[1], f[2]), n = Math.max(1, Math.min(7, Math.ceil(f[3] / 1.2)));
    ctx.save(); ctx.globalAlpha = Math.min(1, 0.35 + f[3] / 4);
    for (let i = 0; i < n; i++) {
      const a = hash(f[0], i, 11) * Math.PI * 2, r = hash(i, f[0], 13) * (3 + n) * scale;
      ctx.fillStyle = i % 2 ? '#d9c79a' : '#b79f6c'; ctx.strokeStyle = '#3a2d18'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.ellipse(c.x + Math.cos(a) * r, c.y + Math.sin(a) * r * .5, 2.6 * scale, 1.8 * scale, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
    ctx.restore();
    return;
  }
  if (f[4] !== 1) return drawFoodBase(f);
  const c = toScreen(f[1], f[2]);
  if (window.WorldArt) return WorldArt.pellets(ctx, c, scale, f, performance.now()); // ant18/ground: glowing pellets
  ctx.strokeStyle = 'rgba(90,170,255,.5)'; ctx.lineWidth = 2 * scale;
  ctx.beginPath(); ctx.ellipse(c.x, c.y, 16 * scale, 8 * scale, 0, 0, Math.PI * 2); ctx.stroke();
  ctx.lineWidth = 1;
  for (let i = 0; i < f[3]; i++) {
    const a = hash(f[0], i, 7) * Math.PI * 2, r = hash(i, f[0], 9) * 9 * scale;
    ctx.fillStyle = '#5ab0ff'; ctx.strokeStyle = '#123a6a';
    ctx.beginPath(); ctx.arc(c.x + Math.cos(a) * r, c.y + Math.sin(a) * r * .5 - 3 * scale, 4 * scale, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  }
};

