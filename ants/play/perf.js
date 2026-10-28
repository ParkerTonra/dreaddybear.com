// ant68/perf: the performance overlay. F3 (or ?perf=1) toggles it; it is off by default and costs one boolean test per hook while off.
// Shows fps and frame time (avg / p95 / max over the last 2 s), the render frame split by section, the in-tab host's
// costs (sim tick, bots, snapshot build, fog views, encode) and the client's decode/apply, long tasks, and the JS heap.
//
//   Perf.frame(now)        start of a main frame (client.js frame()): closes the previous frame's numbers
//   Perf.mark('ground')    attributes the time since the previous mark (or frame start) to a section
//   Perf.t0() / Perf.add(name, t0)   time a span that is not in the frame (minimap loop, HUD writes, decode/apply)
//   globalThis.__antPerf   { ev(name, ms) } exists only while the overlay is on; room-core.js reports host timings through it
// Load order: after keys.js, before client.js. Every call site guards on Perf.on, so nothing runs when off.
(function (root) {
  const WINDOW = 2000; // ms of history shown
  const N = 600;       // frame ring size (2 s at 240 Hz fits)
  const FRAME = ['ground', 'decals', 'ground2', 'prep', 'shadows', 'sort', 'ants', 'things', 'wash', 'fog', 'effects', 'overlay'];
  const LABEL = {
    ground: 'ground (cached board blit)', decals: 'decals (wear, marks, dust, air)', ground2: 'event/ability/objective/selection ground',
    prep: 'world prep (sprites, lerp, motion)', shadows: 'ant shadows + corpses', sort: 'depth sort + culling',
    ants: 'ants', things: 'buildings, rocks, food, hazards', wash: 'time-of-day + night wash (full-screen source-atop fill)', fog: 'fog blit', effects: 'effects, shots, pings, flags', overlay: 'weather, banner, input overlay',
    minimap: 'minimap (own rAF)', hud: 'HUD / DOM writes on snapshot', panel: 'panel + layout timers',
  };
  const ASYNC = ['minimap', 'hud', 'panel'];
  const HOST = ['bots', 'sim', 'snapshot', 'fog', 'encode'];
  const CLIENT = ['decode', 'apply'];
  const nowMs = () => performance.now();

  const P = { on: false, FRAME, ASYNC };
  let box = null, text = '', lastRender = 0, lastRaf = 0, startedAt = 0;
  let head = 0, count = 0;
  const ringT = new Float64Array(N), ringDt = new Float32Array(N), ringJs = new Float32Array(N);
  const names = FRAME.concat(ASYNC);
  const ring = {}, cur = {};
  for (const n of names) { ring[n] = new Float32Array(N); cur[n] = 0; }
  let lastMark = 0, frameStart = 0, haveFrame = false;
  const events = {}; // name -> [t, ms, t, ms ...] flat, pruned to WINDOW
  let longTasks = [], longTotal = 0, slowFrames = 0, observer = null;
  let bytesWin = [];

  P.t0 = () => (P.on ? nowMs() : 0);
  P.add = (name, t0) => { if (P.on) cur[name] = (cur[name] || 0) + (nowMs() - t0); };
  P.mark = name => { if (!P.on) return; const t = nowMs(); cur[name] += t - lastMark; lastMark = t; };
  P.ev = (name, ms) => {
    const a = events[name] || (events[name] = []);
    a.push(nowMs(), ms);
    if (a.length > 4000) a.splice(0, a.length - 4000);
  };
  P.bytes = n => { if (P.on) bytesWin.push(nowMs(), n); };

  P.frame = now => { // `now`: the rAF timestamp
    if (!P.on) return;
    const t = nowMs();
    if (haveFrame) { // close the previous frame: dt is rAF-to-rAF, js is that frame's own callback work
      ringT[head] = t; ringDt[head] = now - lastRaf; ringJs[head] = cur.js || 0;
      for (const n of names) { ring[n][head] = cur[n]; cur[n] = 0; }
      cur.js = 0;
      if (now - lastRaf > 50) slowFrames++;
      head = (head + 1) % N; if (count < N) count++;
    }
    haveFrame = true; lastRaf = now; frameStart = lastMark = t;
  };
  P.end = () => { if (P.on) cur.js = nowMs() - frameStart; };

  function pct(arr, p) { if (!arr.length) return 0; arr.sort((a, b) => a - b); return arr[Math.min(arr.length - 1, Math.floor(arr.length * p))]; }
  const f1 = x => x.toFixed(1).padStart(5);

  function frameStats(t) {
    const dts = [], js = [], idx = [];
    for (let k = 0; k < count; k++) {
      const i = (head - 1 - k + N * 2) % N;
      if (t - ringT[i] > WINDOW) break;
      idx.push(i); dts.push(ringDt[i]); js.push(ringJs[i]);
    }
    return { idx, dts, js };
  }
  function evStats(name, t) {
    const a = events[name]; if (!a || !a.length) return null;
    let n = 0, sum = 0, max = 0;
    for (let i = a.length - 2; i >= 0; i -= 2) { if (t - a[i] > WINDOW) break; n++; sum += a[i + 1]; if (a[i + 1] > max) max = a[i + 1]; }
    return n ? { n, avg: sum / n, max, perS: n * 1000 / WINDOW, total: sum * 1000 / WINDOW } : null;
  }

  // curr is client.js's top-level `let`: visible by name to other classic scripts, but not as window.curr.
  function match() {
    const c = typeof curr !== 'undefined' ? curr : null;
    if (!c) return 'no match';
    return `map ${c.map}  ants ${c.ants.length}  rocks ${root.TerrainDraw && TerrainDraw.rocks ? TerrainDraw.rocks(c).length : '?'}  food ${c.food.length}`;
  }

  // Game speed: sim seconds per wall second, from curr.t (the snapshot's game clock) sampled by tickBox. 1.00 = real time; below 1 the
  // match runs in slow motion (the in-tab host cannot keep up, or snapshots arrive late).
  const clock = [];
  function sampleClock() {
    const c = typeof curr !== 'undefined' ? curr : null, t = nowMs();
    if (!c || typeof c.t !== 'number') { clock.length = 0; return; }
    if (clock.length && c.t < clock[clock.length - 1][1]) clock.length = 0; // new match
    clock.push([t, c.t]);
    while (clock.length > 2 && t - clock[0][0] > WINDOW + 500) clock.shift();
  }
  function gameSpeed() {
    if (clock.length < 3) return null;
    const a = clock[0], b = clock[clock.length - 1];
    return b[0] - a[0] > 500 ? (b[1] - a[1]) * 1000 / (b[0] - a[0]) : null;
  }

  function build() {
    const t = nowMs(), { idx, dts, js } = frameStats(t), n = idx.length;
    if (!n) return 'PERF (collecting...)';
    const sum = a => a.reduce((x, y) => x + y, 0), avg = sum(dts) / n, mx = Math.max(...dts);
    const jsAvg = sum(js) / n, jsMax = Math.max(...js);
    const L = [];
    L.push(`PERF  F3 hides     ${innerWidth}x${innerHeight} @${(root.devicePixelRatio || 1)}x   ${match()}`);
    L.push(`render scale ${typeof renderScale !== 'undefined' ? renderScale : 1} (auto-lowered when frames run over 30 ms; ?rscale=1 pins full)   backing ${Math.round(innerWidth * (typeof pixelRatio === 'function' ? pixelRatio() : 1))}x${Math.round(innerHeight * (typeof pixelRatio === 'function' ? pixelRatio() : 1))}`);
    L.push(`fps ${(1000 / avg).toFixed(0).padStart(3)}   frame ms avg ${f1(avg)}  p95 ${f1(pct(dts.slice(), .95))}  max ${f1(mx)}   (>50 ms: ${slowFrames} total)`);
    const gs = gameSpeed();
    L.push(`game speed ${gs === null ? '?' : gs.toFixed(2) + 'x'} (sim seconds per real second; below 1.00 = slow motion)   snapshots ${evStats('apply', t) ? evStats('apply', t).perS.toFixed(0) : '?'}/s (15 expected)`);
    L.push(`js per frame ms avg ${f1(jsAvg)}  max ${f1(jsMax)}   (the rest of a frame is browser raster/compositor or idle)`);
    L.push('render frame (ms per frame: avg / max)');
    let tot = 0;
    for (const nm of FRAME.concat(ASYNC)) {
      let s = 0, m = 0;
      for (const i of idx) { const v = ring[nm][i]; s += v; if (v > m) m = v; }
      if (FRAME.includes(nm)) tot += s / n;
      const flag = s / n > 3 ? ' <<' : '';
      L.push(`  ${nm.padEnd(9)} ${f1(s / n)} / ${f1(m)}   ${LABEL[nm]}${flag}`);
      if (nm === 'overlay') L.push(`  ${'(sum)'.padEnd(9)} ${f1(tot)}`);
    }
    L.push('in-tab host (per 15 Hz tick; ms avg / max, count per s)');
    let any = false;
    for (const nm of HOST) { const e = evStats(nm, t); if (e) { any = true; L.push(`  ${nm.padEnd(9)} ${f1(e.avg)} / ${f1(e.max)}   ${e.perS.toFixed(0).padStart(3)}/s`); } }
    if (!any) L.push('  (no host timings: not an in-tab match)');
    L.push('client network');
    for (const nm of CLIENT) { const e = evStats(nm, t); if (e) L.push(`  ${nm.padEnd(9)} ${f1(e.avg)} / ${f1(e.max)}   ${e.perS.toFixed(0).padStart(3)}/s`); }
    let by = 0; for (let i = bytesWin.length - 2; i >= 0; i -= 2) { if (t - bytesWin[i] > WINDOW) break; by += bytesWin[i + 1]; }
    if (by) L.push(`  snapshots ${(by / 1024 / (WINDOW / 1000)).toFixed(1)} KB/s`);
    longTasks = longTasks.filter(x => t - x.at < 60000);
    L.push(`long tasks >50 ms: ${observer ? `${longTotal} total, ${longTasks.length} in the last 60 s, worst ${longTasks.length ? Math.round(Math.max(...longTasks.map(x => x.ms))) : 0} ms` : 'not supported by this browser (see slow frames above)'}`);
    const mem = root.performance && root.performance.memory;
    L.push(`js heap: ${mem ? `${(mem.usedJSHeapSize / 1048576).toFixed(0)} MB used / ${(mem.totalJSHeapSize / 1048576).toFixed(0)} MB` : 'not available in this browser'}`);
    return L.join('\n');
  }

  function show(on) {
    P.on = !!on;
    const doc = root.document;
    if (!doc) return;
    if (P.on) {
      if (!box) {
        box = doc.createElement('pre'); box.id = 'perf-overlay';
        box.style.cssText = 'position:fixed;left:8px;top:92px;z-index:99999;margin:0;padding:6px 8px;background:rgba(0,0,0,.78);color:#d8f3c0;font:11px/1.25 Consolas,monospace;pointer-events:none;border-radius:4px;white-space:pre;max-width:96vw';
        doc.body.appendChild(box);
      }
      box.style.display = '';
      clock.length = 0; head = count = 0; haveFrame = false; slowFrames = 0; longTotal = 0; longTasks = []; bytesWin = []; for (const k of Object.keys(events)) delete events[k];
      for (const nm of names) cur[nm] = 0; cur.js = 0;
      startedAt = nowMs();
      root.__antPerf = { ev: P.ev };
      if (root.PerformanceObserver && !observer) {
        try { observer = new PerformanceObserver(l => { for (const e of l.getEntries()) { longTotal++; longTasks.push({ at: nowMs(), ms: e.duration }); } }); observer.observe({ entryTypes: ['longtask'] }); } catch (e) { observer = null; }
      }
      tickBox();
    } else {
      if (box) box.style.display = 'none';
      root.__antPerf = null;
      if (observer) { try { observer.disconnect(); } catch (e) {} observer = null; }
    }
  }
  function tickBox() {
    if (!P.on) return;
    const t = nowMs();
    sampleClock();
    if (t - lastRender > 500) { lastRender = t; text = build(); box.textContent = text; }
    root.setTimeout(tickBox, 250);
  }
  // Numbers for tools/perf-profile.js: the same window the overlay shows, as an object.
  P.stats = () => {
    const t = nowMs(), { idx, dts, js } = frameStats(t), n = idx.length, out = { frames: n };
    if (!n) return out;
    const sum = x => x.reduce((p, q) => p + q, 0);
    Object.assign(out, { gameSpeed: gameSpeed(), fps: 1000 * n / sum(dts), avg: sum(dts) / n, p95: pct(dts.slice(), .95), max: Math.max(...dts), jsAvg: sum(js) / n, jsMax: Math.max(...js), sections: {}, host: {}, client: {}, slow: slowFrames, longTotal });
    for (const nm of names) { let s = 0, m = 0; for (const i of idx) { const v = ring[nm][i]; s += v; if (v > m) m = v; } out.sections[nm] = { avg: s / n, max: m }; }
    for (const nm of HOST) out.host[nm] = evStats(nm, t);
    for (const nm of CLIENT) out.client[nm] = evStats(nm, t);
    return out;
  };
  P.toggle = () => show(!P.on);
  P.text = () => build();
  P.show = show;

  root.Perf = P;
  if (root.document && root.addEventListener) {
    root.addEventListener('keydown', e => {
      if (e.target && e.target.tagName === 'INPUT') return;
      if (root.Keys && Keys.is(e, 'debug.perf')) { e.preventDefault(); P.toggle(); }
    });
    try { if (new URLSearchParams(root.location.search).get('perf') === '1') root.addEventListener('DOMContentLoaded', () => show(true)); } catch (e) { /* no location */ }
  }
})(typeof window !== 'undefined' ? window : globalThis);
