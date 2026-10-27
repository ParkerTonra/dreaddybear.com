// Ant Arena snapshot jitter buffer: keeps the last few server snapshots and renders the world a little
// in the past (one tick plus measured jitter), interpolating between the two snapshots that bracket the
// render time. A late snapshot is covered by a short, clamped extrapolation, then the picture holds.
// The render clock only moves forward and changes speed gently, so ants never jump backward or teleport
// when packets bunch up (WebSocket over a bad link, OneLobby WebRTC).
// Snapshots carry the server's game time `t` (seconds, +1/15 per tick). No protocol changes.
// Works in the browser (global NetBuf) and in Node (module.exports) for tests.
(function (root) {
  const TICK_MS = 1000 / 15;
  const KEEP = 12; // snapshots kept (~0.8 s)
  const MIN_DELAY = TICK_MS * 1.1, MAX_DELAY = TICK_MS * 4; // render delay bounds
  const EXTRAP_MS = 100; // how far past the newest snapshot we extrapolate before holding still
  const SNAP_DIST = 2.5; // tiles moved between snapshots that count as a teleport, not motion
  const RESYNC_MS = 600; // render clock this far behind target: jump forward instead of easing
  const RATE = 0.12; // max clock speed-up / slow-down while easing toward the target

  function createNetBuf() {
    const nb = {
      snaps: [], // { s, t (ms server time), at (ms arrival) } oldest first
      offset: null, // estimated arrival - server time for an on-time packet (ms)
      jitter: 0, // smoothed lateness beyond `offset` (ms)
      renderT: null, // current render time in server ms
      lastNow: null,
      delay: MIN_DELAY,
    };

    nb.reset = function () {
      nb.snaps.length = 0; nb.offset = null; nb.jitter = 0; nb.renderT = null; nb.lastNow = null; nb.delay = MIN_DELAY;
    };

    // Feed one snapshot as it arrives. `now` is the local clock (performance.now()).
    nb.push = function (s, now) {
      const t = (s.t || 0) * 1000;
      const last = nb.snaps[nb.snaps.length - 1];
      if (last && (s.seed !== last.s.seed || t < last.t - 3000)) nb.reset(); // new match / rematch (client also resets on start)
      const newest = nb.snaps[nb.snaps.length - 1];
      if (newest && t <= newest.t) { // same game time (match over) or out of order: keep the latest data
        if (t === newest.t) newest.s = s;
        return;
      }
      nb.snaps.push({ s, t, at: now });
      if (nb.snaps.length > KEEP) nb.snaps.shift();
      const sample = now - t;
      if (nb.offset === null) nb.offset = sample;
      else if (sample < nb.offset) nb.offset = sample; // an earlier packet: the link is at least this fast
      else nb.offset += (sample - nb.offset) * 0.01; // drift up slowly (server clock slower, latency grew)
      const late = sample - nb.offset;
      nb.jitter += (late - nb.jitter) * (late > nb.jitter ? 0.25 : 0.05); // rise fast, decay slowly
      nb.delay = Math.min(MAX_DELAY, Math.max(MIN_DELAY, TICK_MS + 2 * nb.jitter));
    };

    // Advance the render clock to local time `now` and return the server time to draw.
    nb.clock = function (now) {
      if (!nb.snaps.length) return null;
      const target = now - nb.offset - nb.delay;
      if (nb.renderT === null || target - nb.renderT > RESYNC_MS) {
        nb.renderT = target; // first frame, or far behind (tab was hidden): jump forward
      } else { // ease toward the target; the clock never runs backward, at worst it runs slower
        const dt = Math.max(0, now - nb.lastNow);
        const err = (target - nb.renderT) / 200; // close a 200 ms gap at full rate change
        nb.renderT += dt * (1 + Math.max(-RATE, Math.min(RATE, err)));
      }
      nb.lastNow = now;
      const newest = nb.snaps[nb.snaps.length - 1].t;
      const ahead = nb.snaps.length > 1 ? EXTRAP_MS : 0; // one snapshot has no motion to extrapolate
      if (nb.renderT > newest + ahead) nb.renderT = newest + ahead; // starved: hold, don't run away
      return nb.renderT;
    };

    const lerp = (a, b, k) => a + (b - a) * k;
    const lerpAngle = (a, b, k) => {
      let d = (b - a) % (Math.PI * 2);
      if (d > Math.PI) d -= Math.PI * 2; else if (d < -Math.PI) d += Math.PI * 2;
      return a + d * k;
    };
    const far = (a, b) => Math.abs(b.x - a.x) + Math.abs(b.y - a.y) > SNAP_DIST;

    // { x, y, dir, ... } objects (anteater, beetle): blend position and heading, keep the rest from `to`.
    function blendObj(o, n, k) {
      if (!n) return null;
      if (!o || far(o, n)) return n;
      return { ...n, x: lerp(o.x, n.x, k), y: lerp(o.y, n.y, k), dir: lerpAngle(o.dir, n.dir, Math.min(1, k)) };
    }

    // Ant tuples [id, colony, type, x, y, dir, ...]; ants missing from `from` appear where `to` has them.
    function blendAnts(from, to, k) {
      const old = new Map(from.ants.map(a => [a[0], a]));
      return to.ants.map(a => {
        const o = old.get(a[0]);
        if (!o || Math.abs(a[3] - o[3]) + Math.abs(a[4] - o[4]) > SNAP_DIST) return a;
        const b = a.slice();
        b[3] = lerp(o[3], a[3], k);
        b[4] = lerp(o[4], a[4], k);
        b[5] = lerpAngle(o[5], a[5], Math.min(1, k));
        return b;
      });
    }

    // Nest hp bars ease down instead of stepping each tick.
    function blendPlayers(from, to, k) {
      return to.players.map((p, i) => {
        const o = from.players[i];
        if (!o || !p.alive) return p;
        return { ...p, nest: { ...p.nest, hp: lerp(o.nest.hp, p.nest.hp, Math.min(1, k)) } };
      });
    }

    // The world as of render time: { ants, anteater, beetle, players, from, to, t, k }.
    // `to` is the snapshot the picture is built from (the newer one of the bracketing pair).
    nb.sample = function (now) {
      const rt = nb.clock(now);
      if (rt === null) return null;
      const S = nb.snaps;
      let i = S.length - 1;
      while (i > 0 && S[i - 1].t > rt) i--;
      let from, to;
      if (i === 0 || S.length === 1) { from = to = S[i]; } // render time before the buffer (or one snapshot)
      else if (rt <= S[i].t) { from = S[i - 1]; to = S[i]; }
      else { from = S[S.length - 2]; to = S[S.length - 1]; } // past the newest: extrapolate
      const span = to.t - from.t;
      // k > 1 extrapolates along the last motion; the clock already caps it at EXTRAP_MS.
      const k = span > 0 ? Math.max(0, (rt - from.t) / span) : 1;
      const view = { t: rt, k, from: from.s, to: to.s };
      if (from === to) {
        view.ants = to.s.ants; view.anteater = to.s.anteater || null; view.beetle = to.s.beetle || null; view.players = to.s.players;
      } else {
        view.ants = blendAnts(from.s, to.s, k);
        view.anteater = blendObj(from.s.anteater, to.s.anteater, k);
        view.beetle = blendObj(from.s.beetle, to.s.beetle, k);
        view.players = blendPlayers(from.s, to.s, k);
      }
      return view;
    };

    return nb;
  }

  // Eases a point toward its target (rally flag) so it glides instead of popping. Returns {x, y}.
  function glide(cur, target, dtMs) {
    if (!target) return null;
    if (!cur || Math.abs(target.x - cur.x) + Math.abs(target.y - cur.y) > 30) return { x: target.x, y: target.y };
    const k = 1 - Math.exp(-dtMs / 60);
    return { x: cur.x + (target.x - cur.x) * k, y: cur.y + (target.y - cur.y) * k };
  }

  const api = { createNetBuf, glide, TICK_MS, EXTRAP_MS, MIN_DELAY, MAX_DELAY };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.NetBuf = Object.assign(createNetBuf(), api);
})(typeof window !== 'undefined' ? window : this);
