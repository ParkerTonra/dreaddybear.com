// Ant Arena visual effects: derives juice (hit sparks, attack lunges, death puffs, nest dust)
// purely client-side by diffing consecutive server snapshots. No protocol changes.
// Works in the browser (global FX) and in Node (module.exports) for tests.
(function (root) {
  const MAX_PARTICLES = 500;
  const HIT_MS = 180, LUNGE_MS = 160, NEST_SHAKE_MS = 260;
  const STRIKE_KIND = ['worker', 'soldier', 'spitter', 'major', 'nurse', 'alate']; // unit type id -> Sound.strike kind
  const CORPSE_MS = 1500, MAX_CORPSES = 120; // ant18 feel-anim: pop 60, fall and curl 300, lie to 1200, fade to 1500
  // ant18 feel-anim timings (ms). All render-side: the snapshot and the sim are untouched.
  const T = {
    HITSTOP: 30, CATCH: 80, // hit-stop on attacker and victim, then the rendered position catches up
    WIND: 120, WIND_HOLD: 60, WIND_OUT: 120, // predicted wind-up before the next strike, held, then released if it never lands
    STRIKE: 40, RECOVER: 120, SETTLE: 120, // strike lunge, return with one overshoot, settle
    HIT_SQUASH: 100, EDGE: 120, EDGE_RM: 60, KNOCK_OUT: 80, KNOCK_BACK: 120,
    SPAWN: 220, SPAWN_RM: 120, GLOW: 150, PUMP: 160, RIM: 220,
    POP: 60, FALL: 300, LIE_END: 1200,
  };
  const PUDDLE_R = 0.6; // tiles: research.js PERK.puddle.r
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const ease = u => 1 - (1 - u) * (1 - u); // ease-out
  const hash01 = (a, b) => { const r = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453; return r - Math.floor(r); };

  function createFx() {
    const fx = {
      particles: [], // { kind, x, y (world), vx, vy, vz, z, born, life, color, size, fill }
      corpses: [], // { x, y, colony, type, dir, born }: fallen ants, drawn curled up and fading by render.js
      ants: new Map(), // id -> { hitAt, lungeAt, moving, walk, + ant18: period, wound, stopMs, holdAt, holdUntil, hx, hy, spawnAt, pumpAt, healAt }
      hooks: { mark: null, impact: null }, // ant18: the decals lane (Decals.mark) and audio lane (Sound.impact) plug in here, or via window.Decals / window.Sound
      reducedFn: null, // tests: () => bool. In a browser it reads Settings.reduced()
      nests: [], // per colony: { hitAt, lastHp }
      lastSnap: null,
    };

    function antState(id) {
      let s = fx.ants.get(id);
      if (!s) {
        s = { hitAt: -1e9, lungeAt: -1e9, moving: false, walk: Math.random() * 6, period: 0, wound: 0, stopMs: 0, holdAt: -1e9, holdUntil: -1e9, hx: 0, hy: 0, spawnAt: -1e9, pumpAt: -1e9, healAt: -1e9 };
        fx.ants.set(id, s);
      }
      return s;
    }

    function emit(p) {
      if (typeof p.color === 'string' && p.color.endsWith(',')) p.fill = p.color + '1)'; // 'rgba(r,g,b,' prefix; alpha goes in globalAlpha
      if (fx.particles.length >= MAX_PARTICLES) fx.particles.shift();
      fx.particles.push(p);
    }

    function sparks(x, y, now, color, n) {
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2, sp = 1.5 + Math.random() * 2.5;
        emit({ kind: 'spark', x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, z: 6, vz: 20 + Math.random() * 30, born: now, life: 220 + Math.random() * 160, color, size: 1.6 });
      }
    }

    function puff(x, y, now, color, n, big) {
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2, sp = (big ? 0.6 : 0.35) * Math.random();
        emit({ kind: 'puff', x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, z: 2, vz: 8 + Math.random() * 10, born: now, life: 420 + Math.random() * 300, color, size: (big ? 9 : 4.5) * (0.7 + Math.random() * 0.6) });
      }
    }

    fx.reduced = () => (fx.reducedFn ? !!fx.reducedFn() : !!(root.Settings && root.Settings.reduced && root.Settings.reduced()));

    // Chitin chips: square bits in the victim's colour and pale yellow, with gravity (RM: fewer).
    function chips(x, y, now, colony, n) {
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2, sp = 1.2 + Math.random() * 2.2;
        emit({ kind: 'chip', x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, z: 5, vz: 18 + Math.random() * 26, born: now, life: 220 + Math.random() * 160, color: i % 2 ? '#fff3b0' : colony, size: 2.2 });
      }
    }

    function hook(name, family, x, y, extra) {
      let h = fx.hooks[name];
      if (!h) {
        const D = root.Decals, S = root.Sound;
        if (name === 'mark' && D && typeof D.mark === 'function') h = (k, a, b, e) => D.mark(k, a, b, e);
        else if (name === 'impact' && S && typeof S.strike === 'function') h = (k, a, b, e) => S.strike(STRIKE_KIND[e && e.attacker] || 'worker', a, b); // ant18/audio: attacker caste picks the bite sample
        else if (name === 'impact' && S && typeof S.impact === 'function') h = (k, a, b, e) => S.impact(k, a, b, e);
      }
      if (typeof h === 'function') h(family, x, y, extra);
    }

    // Hit-stop: attacker and victim hold their rendered position for a moment (render.js freezes their draw position).
    function holdPair(id, now, ms) { const s = antState(id); s.holdAt = now; s.holdUntil = now + ms; }

    // Compare the new snapshot against the previous one and spawn effects.
    fx.onSnapshot = function (prev, curr, now) {
      fx.lastSnap = curr;
      if (!prev || !curr || prev.seed !== curr.seed) { fx.particles.length = 0; fx.corpses.length = 0; fx.ants.clear(); fx.nests = []; return; }
      const old = new Map(prev.ants.map(a => [a[0], a]));
      const seen = new Set();
      const hits = [];
      for (const a of curr.ants) {
        seen.add(a[0]);
        const s = antState(a[0]);
        const o = old.get(a[0]);
        if (!o) { // ant18: a new id near its own nest crawls out of the hole
          const pl = curr.players && curr.players[a[1]];
          if (pl && pl.nest && Math.hypot(a[3] - pl.nest.x, a[4] - pl.nest.y) < 3.2) {
            s.spawnAt = now;
            const n = fx.nests[a[1]] || (fx.nests[a[1]] = { hitAt: -1e9, lastHp: pl.nest.hp, smokeAt: 0 });
            n.spawnAt = now;
            puff(pl.nest.x, pl.nest.y - 0.3, now, 'rgba(150,118,80,', 3, false);
          }
          continue;
        }
        const moved = Math.hypot(a[3] - o[3], a[4] - o[4]);
        s.moving = moved > 0.01;
        s.walk += moved * 9;
        if (a[7] < o[7]) { s.hitAt = now; hits.push(a); }
      }
      for (const h of curr.heals || []) { const t = fx.ants.get(h[1]); if (t) t.healAt = now; } // patient's plasma rim
      for (const sh of curr.shots || []) { // a spitter that just fired pumps its abdomen
        let best = null, bd = 0.9;
        for (const a of curr.ants) { if (a[2] !== 2) continue; const d = Math.hypot(a[3] - sh[0], a[4] - sh[1]); if (d < bd) { bd = d; best = a; } }
        if (best) antState(best[0]).pumpAt = now;
      }
      // Each victim's nearest enemy within reach gets the credit (lunge).
      if (hits.length) {
        const rm = fx.reduced(), stop = rm ? 0 : fx.hitStopMs;
        for (const v of hits) {
          sparks(v[3], v[4], now, '#fff3b0', 2);
          chips(v[3], v[4], now, v[1], rm ? 3 : 4 + (Math.random() * 4 | 0));
          fx.mark_('chips', v[3], v[4], { colony: v[1] });
          let best = null, bd = 1.1;
          for (const a of curr.ants) {
            if (a[1] % 2 === v[1] % 2) continue;
            const d = Math.hypot(a[3] - v[3], a[4] - v[4]);
            if (d < bd) { bd = d; best = a; }
          }
          const vs = antState(v[0]);
          if (best) {
            const bs = antState(best[0]);
            const gap = now - bs.lungeAt;
            if (gap > 250 && gap < 1600) bs.period = bs.period ? bs.period * 0.5 + gap * 0.5 : gap; // strike rhythm, so the next wind-up can be predicted
            else if (gap >= 1600) bs.period = 0;
            if (gap > 40) { bs.wound = windup(bs, now); bs.lungeAt = now; bs.stopMs = stop; } // several victims in one snapshot are one strike
            const dx = v[3] - best[3], dy = v[4] - best[4], dl = Math.hypot(dx, dy) || 1;
            vs.hx = dx / dl; vs.hy = dy / dl;
            if (stop) { holdPair(best[0], now, stop); holdPair(v[0], now, stop); }
            fx.impact_(best[2] === 3 ? 'plate' : best[2] === 1 ? 'punch' : 'soft', v[3], v[4], { attacker: best[2], victim: v[2] });
          } else {
            vs.hx = 0; vs.hy = 0;
            if (stop) holdPair(v[0], now, stop);
          }
        }
      }
      // Ants that vanished died: dust puff plus a few colored bits.
      const dead = curr.fog ? new Set(curr.fog.dead) : null; // ant16 fog: an ant that walked into the fog is not dead
      for (const o of prev.ants) {
        if (seen.has(o[0])) continue;
        fx.ants.delete(o[0]);
        if (dead && !dead.has(o[0])) continue;
        if (fx.corpses.length >= MAX_CORPSES) fx.corpses.shift();
        fx.corpses.push({ id: o[0], x: o[3], y: o[4], colony: o[1], type: o[2], dir: o[5], born: now });
        fx.mark_('chitin', o[3], o[4], { colony: o[1], type: o[2] });
        puff(o[3], o[4], now, 'rgba(120,96,70,', o[2] ? 7 : 5, false);
        sparks(o[3], o[4], now, o[1], o[2] ? 6 : 4); // color index resolved at draw time
        // ant17: an expanding ring in the colony colour, so one death still reads inside a brawl
        emit({ kind: 'ring', x: o[3], y: o[4], vx: 0, vy: 0, z: 0, vz: 0, born: now, life: 420, color: o[1], size: o[2] ? 1.5 : 1.1 });
      }
      curr.players.forEach((p, i) => {
        const n = fx.nests[i] || (fx.nests[i] = { hitAt: -1e9, lastHp: p.nest.hp, smokeAt: 0 });
        const was = prev.players[i] ? prev.players[i].nest.hp : n.lastHp;
        if (p.nest.hp < was) {
          n.hitAt = now;
          puff(p.nest.x + (Math.random() - .5) * 1.2, p.nest.y + (Math.random() - .5) * 1.2, now, 'rgba(150,118,80,', 2, false);
        }
        if (prev.players[i] && prev.players[i].alive && !p.alive) puff(p.nest.x, p.nest.y, now, 'rgba(110,90,66,', 18, true);
        n.lastHp = p.nest.hp;
      });
    };

    // ant16 abilities: a splash of sparks (and a puff when puffColor, an 'rgba(r,g,b,' prefix, is given).
    fx.burst = function (x, y, now, color, puffColor, n) {
      sparks(x, y, now, color, n);
      if (puffColor) puff(x, y, now, puffColor, Math.ceil(n / 2), true);
    };

    fx.hitStopMs = T.HITSTOP; // taste call: 30 ms by default (set 50 for the crunchier mock)
    fx.T = T;
    fx.mark_ = (kind, x, y, e) => hook('mark', kind, x, y, e);
    fx.impact_ = (family, x, y, e) => hook('impact', family, x, y, e);
    fx.ant = id => fx.ants.get(id);
    fx.hitT = (id, now) => { const s = fx.ants.get(id); return s ? Math.max(0, 1 - (now - s.hitAt) / HIT_MS) : 0; };
    fx.lungeT = (id, now) => { const s = fx.ants.get(id); if (!s) return 0; const t = (now - s.lungeAt) / LUNGE_MS; return t >= 0 && t < 1 ? Math.sin(t * Math.PI) : 0; };
    fx.nestShake = (i, now) => { const n = fx.nests[i]; if (!n) return 0; const t = 1 - (now - n.hitAt) / NEST_SHAKE_MS; return t > 0 ? t : 0; };

    fx.nestGlow = (i, now) => { const n = fx.nests[i]; if (!n || n.spawnAt === undefined) return 0; const t = 1 - (now - n.spawnAt) / T.GLOW; return t > 0 ? t : 0; };

    // Wind-up before the next strike: the server only tells us a strike landed, so the pull-back is predicted from this
    // ant's own strike rhythm (EMA of the gap between strikes). 0..1, eased in over WIND, held, then released.
    function windup(s, now) {
      if (!s.period) return 0;
      const wt = now - (s.lungeAt + s.period - T.WIND);
      if (wt < 0 || wt > T.WIND + T.WIND_HOLD + T.WIND_OUT) return 0;
      return wt < T.WIND ? ease(wt / T.WIND) : wt < T.WIND + T.WIND_HOLD ? 1 : 1 - (wt - T.WIND - T.WIND_HOLD) / T.WIND_OUT;
    }

    // Weight (0..1) of the frozen position while hit-stop holds an ant, easing back to the live one over CATCH ms.
    fx.holdW = (id, now) => {
      const s = fx.ants.get(id); if (!s) return 0;
      if (now < s.holdUntil) return now >= s.holdAt ? 1 : 0;
      const u = (now - s.holdUntil) / T.CATCH;
      return u >= 0 && u < 1 ? (1 - u) * (1 - u) : 0;
    };

    // The pose of one live ant at `now`, as stamp-time numbers (render.js applies them; fx.js never paints).
    // m = { spd, idle (ms), walk (rad), lean (-1..1) } from render.js's smoothed motion. Reused output object `out`.
    //   sx, sy  squash/stretch along / across the heading (never beyond 18%; halved under Reduced motion)
    //   fwd, side  offset in ant units along / across the heading;  lift, kb  px (up / away from the attacker, world dir hx,hy)
    //   jx, jy  hit jitter (units);  edge, edgeRim  outline alpha (white / plasma);  grow, alpha, emerge  spawn;  open  jaws open
    // Reduced motion: no translation of any kind, no hit-stop, no spawn glide: squash halved, outlines shorter, fades instead.
    fx.pose = function (id, type, now, rm, m, carry, out) {
      out.sx = out.sy = 1; out.fwd = out.side = out.lift = out.kb = out.jx = out.jy = 0;
      out.edge = out.edgeRim = 0; out.grow = out.alpha = 1; out.emerge = 0; out.open = false; out.hx = out.hy = 0;
      const s = fx.ants.get(id), sq = rm ? 0.5 : 1;
      let sx = 1, sy = 1;
      const moving = m && m.spd > 0.25;
      if (!moving && m && m.idle > 300 && !rm) { // idle: breathe 2%, and every 4 to 9 s a grooming twitch
        sy *= 1 + 0.02 * Math.sin(now * 0.00523599 + id);
        const per = 4000 + (id * 977) % 5000, ph = (now + id * 1311) % per;
        if (ph < 200) { const t = Math.sin(ph / 200 * Math.PI); out.fwd += 0.5 * t; sy *= 1 - 0.03 * t; }
      }
      if (moving && !rm) { // walk: two bobs per gait cycle, a touch more with a crumb, charging jawed types lean in
        out.lift += (carry ? 0.8 : 0.5) * Math.abs(Math.sin(m.walk));
        if (m.spd > 1.2) sx *= 1.03;
        out.side += (m.lean || 0) * 0.6; // turn: lean into it
      }
      if (type === 5) out.lift += 4 + (rm ? 0 : Math.sin(now * 0.025133 + id)); // alate hovers (~4 Hz bob)
      if (s) {
        // strike
        const tt = now - s.lungeAt, H = s.stopMs, tl = T.STRIKE + H + T.RECOVER + T.SETTLE, w = windup(s, now);
        let struck = false;
        if (tt >= 0 && tt < tl) {
          struck = true;
          const te = tt <= T.STRIKE ? tt : tt <= T.STRIKE + H ? T.STRIKE : tt - H; // hit-stop freezes the pose too
          let f, qx, qy;
          if (te < T.STRIKE) { // lunge forward (from the wind-up pose if there was one) with the jaws open
            const e = ease(te / T.STRIKE), w = s.wound;
            f = -3.5 * w + (4 + 3.5 * w) * e; qx = 1 - 0.14 * w + (0.18 + 0.14 * w) * e; qy = 1 + 0.14 * w - (0.26 + 0.14 * w) * e;
            out.open = true;
          } else if (te < T.STRIKE + T.RECOVER) { // return with one overshoot, jaws snapped shut
            const u = (te - T.STRIKE) / T.RECOVER, e = u * u * (3 - 2 * u);
            f = 4 - 4.8 * e; qx = 1.18 - 0.22 * e; qy = 0.88 + 0.16 * e;
          } else { // settle
            const u = (te - T.STRIKE - T.RECOVER) / T.SETTLE, e = ease(u);
            f = -0.8 + 0.8 * e; qx = 0.96 + 0.04 * e; qy = 1.04 - 0.04 * e;
          }
          if (w > 0) { f = Math.min(f, -3.5 * w); qx = Math.min(qx, 1 - 0.14 * w); qy = Math.max(qy, 1 + 0.14 * w); if (w > 0.3) out.open = true; } // a short rhythm: the next wind-up starts while this one settles
          if (!rm) out.fwd += f;
          sx *= 1 + (qx - 1) * sq; sy *= 1 + (qy - 1) * sq;
          if (type === 5 && !rm) out.lift -= 2 * Math.sin(Math.PI * clamp(te / 200, 0, 1)); // alate dives 2 px, then rises
        }
        if (!struck) {
          if (w > 0) {
            if (!rm) out.fwd -= 3.5 * w;
            sx *= 1 - 0.14 * w * sq; sy *= 1 + 0.14 * w * sq;
            out.open = w > 0.3;
          }
        }
        // spitter pumps its abdomen as the glob leaves: squash, then a small overshoot
        const tp = now - s.pumpAt;
        if (tp >= 0 && tp < T.PUMP) {
          const u = tp / T.PUMP, v = (u - 0.45) / 0.55;
          const k = u < 0.45 ? -0.14 * (u / 0.45) : v < 0.5 ? -0.14 + 0.2 * (v / 0.5) : 0.06 * (1 - (v - 0.5) / 0.5);
          sx *= 1 + k * sq; sy *= 1 - k * sq;
        }
        // hit reaction: squash, jitter, knockback, edge flash
        const th = now - s.hitAt;
        if (th >= 0 && th < HIT_MS) {
          if (th < T.HIT_SQUASH) { const q = 1 - th / T.HIT_SQUASH; sx *= 1 - 0.12 * q * sq; sy *= 1 + 0.12 * q * sq; }
          if (!rm) {
            const amp = 1.5 * (1 - th / HIT_MS), fr = Math.floor(now / 16);
            out.jx = (hash01(id, fr) - 0.5) * amp; out.jy = (hash01(fr, id) - 0.5) * amp;
            out.kb = th < T.KNOCK_OUT ? 2 * th / T.KNOCK_OUT : th < T.KNOCK_OUT + T.KNOCK_BACK ? 2 * (1 - (th - T.KNOCK_OUT) / T.KNOCK_BACK) : 0;
            out.hx = s.hx; out.hy = s.hy;
          }
        }
        const eMs = rm ? T.EDGE_RM : T.EDGE;
        if (th >= 0 && th < eMs) out.edge = (rm ? 0.4 : 1) * (1 - th / eMs);
        const tr = now - s.healAt;
        if (tr >= 0 && tr < T.RIM) out.edgeRim = (rm ? 0.5 : 1) * (1 - tr / T.RIM);
        // spawn: crawl out of the hole (RM: a 120 ms fade in place)
        const ts = now - s.spawnAt;
        if (ts >= 0 && ts < (rm ? T.SPAWN_RM : T.SPAWN)) {
          if (rm) { const u = ts / T.SPAWN_RM; out.alpha = u; out.grow = 0.8 + 0.2 * u; }
          else {
            const u = ts / T.SPAWN, g = u < 0.6 ? 0.4 + 0.65 * ease(u / 0.6) : 1.05 - 0.05 * ((u - 0.6) / 0.4);
            out.grow = g; out.alpha = Math.min(1, ts / 90); out.emerge = 1 - ease(u); out.lift += 6 * Math.sin(Math.PI * u);
          }
        }
      }
      const lim = rm ? 0.09 : 0.18; // never more than 18% on an axis (9% under Reduced motion)
      out.sx = clamp(sx, 1 - lim, 1 + lim); out.sy = clamp(sy, 1 - lim, 1 + lim);
      return out;
    };

    // A fallen ant's death sequence: pop (60 ms, 1-frame stretch), fall and curl with a half turn (300 ms), lie, fade, shrinking
    // as it decays. Reduced motion: curled where it fell, no pop or turn, just the lie and the fade.
    fx.corpsePose = function (d, now, rm, out) {
      const t = now - d.born, dirn = (d.id & 1) ? 1 : -1;
      out.lift = 0; out.rot = 0; out.curled = true; out.sx = out.sy = 1; out.scale = 1; out.alpha = 0.85;
      if (!rm) {
        if (t < T.POP) { out.curled = false; out.lift = 2 * Math.sin(Math.PI * t / T.POP); out.sx = 0.92; out.sy = 1.12; }
        else if (t < T.POP + T.FALL) {
          const u = (t - T.POP) / T.FALL;
          out.lift = 2 * (1 - u * u); out.rot = dirn * Math.PI * ease(u); out.curled = u > 0.35;
        } else {
          out.rot = dirn * Math.PI;
          const q = 1 - (t - T.POP - T.FALL) / 80; // landing squash
          if (q > 0) { out.sx = 1 + 0.08 * q; out.sy = 1 - 0.1 * q; }
        }
      }
      if (t > T.LIE_END) { const u = clamp((t - T.LIE_END) / (CORPSE_MS - T.LIE_END), 0, 1); out.alpha = 0.85 * (1 - u * u); out.scale = 1 - 0.15 * u; }
      return out;
    };

    // Damaged nests smoke; called once per frame per living nest.
    fx.nestSmoke = function (i, p, now) {
      const n = fx.nests[i]; if (!n || !p.alive) return;
      const frac = p.nest.hp / p.nest.max;
      if (frac > 0.5) return;
      const every = 90 + frac * 500;
      if (now - n.smokeAt < every) return;
      n.smokeAt = now;
      emit({ kind: 'smoke', x: p.nest.x + (Math.random() - .5) * .5, y: p.nest.y + (Math.random() - .5) * .5, vx: 0.15, vy: -0.15, z: 18, vz: 14, born: now, life: 1400, color: frac < 0.25 ? 'rgba(40,36,34,' : 'rgba(90,84,78,', size: 6 + Math.random() * 4 });
    };

    // Fallen ants still on the ground at `now` (expired ones are dropped).
    fx.CORPSE_MS = CORPSE_MS;
    fx.corpsesAt = function (now) {
      const cs = fx.corpses;
      let w = 0;
      for (let i = 0; i < cs.length; i++) if (now - cs[i].born < CORPSE_MS) cs[w++] = cs[i];
      cs.length = w;
      return cs;
    };

    // Lingering acid (research.js mastery): snapshot `puddles` [[x, y, seconds left, colony]], drawn flat on the ground
    // before the ants. Radius matches the server's PERK.puddle.r; fades over the last 0.8 s.
    fx.drawPuddles = function (ctx, toScreen, list) {
      if (!list || !list.length) return;
      for (const q of list) {
        const a = Math.min(1, q[2] / 0.8) * 0.4;
        ctx.beginPath();
        for (let i = 0; i < 12; i++) {
          const t = i / 12 * Math.PI * 2, c = toScreen(q[0] + Math.cos(t) * PUDDLE_R, q[1] + Math.sin(t) * PUDDLE_R);
          if (i) ctx.lineTo(c.x, c.y); else ctx.moveTo(c.x, c.y);
        }
        ctx.closePath();
        ctx.fillStyle = `rgba(150,215,60,${a.toFixed(3)})`; ctx.fill();
        ctx.strokeStyle = `rgba(70,130,30,${(a + 0.2).toFixed(3)})`; ctx.lineWidth = 1; ctx.stroke();
      }
    };

    // Veterancy chevrons (snapshot ant tuple index 12 = rank 1 or 2) above the hp bar at screen point (cx, cy), unit scale k.
    // Each (rank, size) is drawn once onto a tiny canvas and stamped with one drawImage, so a veteran army costs one call per ant.
    const chev = new Map();
    function strokeChevrons(g, cx, y0, k, rank) {
      const w = Math.max(2.5, 3 * k), step = Math.max(2.2, 2.6 * k);
      for (const [color, lw] of [['rgba(30,24,12,.85)', Math.max(2.6, 3 * k)], [rank > 1 ? '#fff0a0' : '#ffd23f', Math.max(1.2, 1.4 * k)]]) {
        g.strokeStyle = color; g.lineWidth = lw; g.lineJoin = 'miter';
        g.beginPath();
        for (let i = 0; i < rank; i++) { const y = y0 - i * step; g.moveTo(cx - w, y + w * 0.6); g.lineTo(cx, y); g.lineTo(cx + w, y + w * 0.6); }
        g.stroke();
      }
      g.lineWidth = 1;
    }
    fx.chevrons = function (ctx, cx, cy, k, rank) {
      const kq = Math.max(0.5, Math.round(k * 4) / 4), key = rank * 1000 + Math.round(kq * 4);
      let sp = chev.get(key);
      if (sp === undefined) {
        const doc = root.document;
        sp = null;
        if (doc && doc.createElement) {
          const w = Math.max(2.5, 3 * kq), step = Math.max(2.2, 2.6 * kq), W = Math.ceil(2 * w + 6), H = Math.ceil((rank - 1) * step + w * 0.6 + 6);
          const c = doc.createElement('canvas');
          c.width = W; c.height = H;
          const g = c.getContext && c.getContext('2d');
          if (g) { strokeChevrons(g, W / 2, H - 3 - w * 0.6, kq, rank); sp = { c, W, H, below: 3 + w * 0.6 }; }
        }
        chev.set(key, sp);
        if (chev.size > 40) chev.delete(chev.keys().next().value);
      }
      const y0 = cy - 14 * k - 3 * k;
      if (sp) ctx.drawImage(sp.c, Math.round(cx - sp.W / 2), Math.round(y0 - sp.H + sp.below), sp.W, sp.H);
      else strokeChevrons(ctx, cx, y0, k, rank);
    };

    // Advance and draw particles. toScreen maps world -> screen, colors resolves colony index colors.
    fx.draw = function (ctx, now, toScreen, scale, colors) {
      const ps = fx.particles;
      let w = 0;
      for (let i = 0; i < ps.length; i++) {
        const p = ps[i];
        const age = Math.max(0, now - p.born); // born later in this frame than `now` (nest smoke): start at 0
        if (age >= p.life) continue;
        ps[w++] = p;
        const t = age / 1000, f = 1 - age / p.life;
        const x = p.x + p.vx * t, y = p.y + p.vy * t;
        const c = toScreen(x, y);
        if (p.kind === 'ring') { // death ring: grows and fades, isometric ellipse
          const r = (4 + 14 * (1 - f)) * p.size * scale;
          ctx.strokeStyle = typeof p.color === 'number' ? colors[p.color] : p.color;
          ctx.globalAlpha = f * 0.9; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.ellipse(c.x, c.y, r, r * 0.5, 0, 0, Math.PI * 2); ctx.stroke();
        } else if (p.kind === 'spark' || p.kind === 'chip') {
          const z = Math.max(0, p.z + p.vz * t - 120 * t * t);
          ctx.fillStyle = typeof p.color === 'number' ? colors[p.color] : p.color;
          ctx.globalAlpha = f;
          const s = p.size * scale * (p.kind === 'chip' ? 0.6 + 0.4 * f : 1);
          ctx.fillRect(c.x - s / 2, c.y - z * scale - s / 2, s, s);
        } else {
          const z = p.z + p.vz * t;
          const grow = p.kind === 'smoke' ? 1 + t * 1.4 : 1 + t * 2;
          ctx.fillStyle = p.fill || p.color;
          ctx.globalAlpha = f * (p.kind === 'smoke' ? 0.45 : 0.55);
          ctx.beginPath(); ctx.arc(c.x, c.y - z * scale, p.size * grow * scale, 0, Math.PI * 2); ctx.fill();
        }
      }
      ps.length = w;
      ctx.globalAlpha = 1; ctx.lineWidth = 1;
    };

    return fx;
  }

  const api = { createFx, MAX_PARTICLES, CORPSE_MS, T };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FX = createFx();
})(typeof window !== 'undefined' ? window : this);
