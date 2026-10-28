// Solo (ant59): "Play vs bots" starts a match at once with every other seat a bot. It plays on the in-tab game server
// (host.js's AntInTab, the same one Learn to play can use), so there is no Nostr hosting, no join code, no host banner
// and no share link: nothing leaves the tab. The choice (1v1 or 2v2, bot difficulty) is remembered per viewer.
// While the tab is hidden the match is paused (room-core 'pause'), so a throttled timer never lags it.
// Load order: after client.js and flow.js. Pure helpers are exported for tests/solo.test.js.
(function (root) {
  const KEY = 'ant-solo';
  const MODES = ['1v1', '2v2'], DIFFS = ['easy', 'normal', 'hard'];
  const DEFAULTS = { mode: '1v1', diff: 'normal' };
  const clean = o => ({ mode: MODES.includes(o && o.mode) ? o.mode : DEFAULTS.mode, diff: DIFFS.includes(o && o.diff) ? o.diff : DEFAULTS.diff });

  function load(storage) {
    try { return clean(JSON.parse(storage.getItem(KEY))); } catch (e) { return { ...DEFAULTS }; } // private mode, or nothing stored yet
  }
  function save(storage, choice) {
    try { storage.setItem(KEY, JSON.stringify(clean(choice))); } catch (e) { /* private mode */ }
  }

  // active: this tab is in a solo match (until it reloads to the menu). pending: the next lobby message gets the bot fill.
  const solo = { active: false, pending: false, manual: false, ...DEFAULTS };
  let deps = null; // { join, useInTab, send }, from wire()

  function start(choice) {
    Object.assign(solo, clean(choice), { active: true, pending: true });
    if (root.localStorage) save(root.localStorage, solo);
    deps.useInTab(); // client.js connect() now dials the in-tab server instead of a WebSocket or OneLobby
    const room = root.document.getElementById('room');
    room.value = 'S' + Math.random().toString(36).slice(2, 6).toUpperCase();
    deps.join(solo.mode);
  }

  // Hook from client.js onMessage: the first lobby card of a (re)start fills every empty seat, which starts the match.
  function onMessage(m, mySide) {
    if (m.type === 'start') {
      clearPause();
      const b = root.document.getElementById('pause-btn');
      if (b) b.classList.toggle('hidden', !canPause());
    }
    if (!solo.active) return;
    if (m.type === 'lobby' && solo.pending && mySide >= 0 && m.host === mySide) {
      solo.pending = false;
      deps.send({ type: 'fill-bots', difficulty: solo.diff });
    }
    if (m.type === 'start') syncPause();
  }

  // A hidden tab pauses with why 'hidden' and resumes only that reason, so a manual pause stays until the player resumes.
  const syncPause = () => { if (solo.active && root.document.hidden) deps.send({ type: 'pause', on: true, why: 'hidden' }); };

  // Manual pause (Pause / F10 / the HUD button): solo and Learn to play only. The server stops the sim and drops orders;
  // the camera is client-side, so pan and zoom keep working. The card is a strip, not a blocker.
  const canPause = () => solo.active || !!(root.Flow && root.Flow.tutorial && root.Flow.tutorial.active);
  function showPause() {
    const $ = id => root.document.getElementById(id);
    $('pause-card').classList.toggle('hidden', !solo.manual);
    $('pause-btn').textContent = solo.manual ? '▶' : '⏸';
  }
  function togglePause() {
    if (!canPause()) return;
    solo.manual = !solo.manual;
    deps.send({ type: 'pause', on: solo.manual, why: 'manual' });
    showPause();
  }
  // A new match or the end screen clears a manual pause (the server does the same on start).
  function clearPause() { if (solo.manual) { solo.manual = false; showPause(); } }

  // Hook from client.js showEnd: swap the lobby button for Play again / Main menu.
  function onEnd() {
    clearPause();
    root.document.getElementById('pause-btn').classList.add('hidden');
    if (!solo.active) return;
    const $ = id => root.document.getElementById(id);
    $('leave').classList.add('hidden');
    $('solo-again').classList.remove('hidden');
    $('solo-menu').classList.remove('hidden');
  }

  // Same settings, new match: back to the (empty) lobby, whose card then gets the bot fill like a first start.
  function again() {
    solo.pending = true;
    deps.send({ type: 'to-lobby' });
    for (const id of ['solo-again', 'solo-menu']) root.document.getElementById(id).classList.add('hidden');
    root.document.getElementById('leave').classList.remove('hidden');
  }

  function wire(d) {
    deps = d;
    const $ = id => root.document.getElementById(id);
    const c = load(root.localStorage);
    $('solo-mode').value = c.mode; $('solo-diff').value = c.diff;
    $('solo-btn').onclick = () => start({ mode: $('solo-mode').value, diff: $('solo-diff').value });
    $('solo-again').onclick = again;
    $('solo-menu').onclick = () => { root.location.href = root.location.pathname; }; // a fresh page: in-tab server, bots and sockets all go
    $('pause-btn').onclick = togglePause;
    $('pause-resume').onclick = togglePause;
    root.addEventListener('keydown', e => {
      if (root.Keys && Keys.is(e, 'game.pause') && canPause()) { e.preventDefault(); if (!e.repeat) togglePause(); }
    });
    root.document.addEventListener('visibilitychange', () => { if (solo.active) deps.send({ type: 'pause', on: root.document.hidden, why: 'hidden' }); });
  }

  root.Solo = { wire, onMessage, onEnd, start, again, togglePause, load, save, clean, state: solo, MODES, DIFFS, DEFAULTS, KEY };
  if (typeof module !== 'undefined') module.exports = root.Solo;
})(typeof window !== 'undefined' ? window : globalThis);
