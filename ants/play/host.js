// Host a game from this tab (ant38). On a static copy of the game (no node server.js behind the page) the tab itself
// runs the game server: host.bundle.js (built from room-core by tools/build-host.js) holds the rooms, OneLobby's
// kit.hostNostr() hands friends a join code through public Nostr relays, and this tab plays over an in-memory socket
// (client.js's localHost). Pages served by server.js, and pages joining someone else's game (?dc=CODE), do nothing here.
// Load order: after client.js (uses $, join, localHost). host.bundle.js and OneLobby load only when needed.
(function () {
  const params = new URLSearchParams(location.search);
  const nodeServer = !!document.querySelector('meta[name="node-server"]')?.content;
  if (nodeServer || params.get('dc')) return;

  const SITE = 'https://dreaddybear.com/ants/play/';
  const local = /^(localhost|127\.|\[::1\])/.test(location.hostname);
  const bar = $('host-bar'), msg = $('host-msg');
  let lobby = null, starting = false, hostPromise = null;

  const loadScript = src => new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = () => rej(new Error(`Could not load ${src}`));
    document.head.appendChild(s);
  });
  // The in-tab game server, created on first use (Learn to play uses it too, with no join code).
  const ensureHost = () => hostPromise || (hostPromise = (window.AntHost ? Promise.resolve() : loadScript('host.bundle.js'))
    .then(() => AntHost.create({ onError: e => console.error('Browser host:', e) }))
    .catch(e => { hostPromise = null; throw e; }));

  localHost = {
    code: '',
    socket: async () => (await ensureHost()).socket(),
    // The page friends open: the game site, or this page's own address when the copy lives somewhere else.
    shareLink: (room, mode) => `${local ? SITE : location.origin + location.pathname}?dc=${encodeURIComponent(localHost.code)}&room=${encodeURIComponent(room)}&mode=${mode}`,
  };

  // No server to play on: the Play buttons would only dial the static site, so offer Host instead (Learn to play still works).
  $('join1').parentElement.classList.add('hidden');
  if (window.isSecureContext) $('host-form').classList.remove('hidden');
  else showMsg('Hosting needs https (or localhost).', true);

  function showMsg(text, err) {
    msg.textContent = text;
    msg.classList.toggle('err', !!err);
    msg.classList.toggle('hidden', !text);
  }

  // Keyed by OneLobby.ErrorCodes names (the string values are not repeated here); looked up with mod.is().
  const WHY = {
    DirectUnreachable: 'Could not reach any Nostr relay within 10 seconds. Check your connection (a firewall may block WebSockets), then try again.',
    NostrDisabled: 'Nostr signaling is turned off, and a browser host has no other way to be reached.',
  };
  let mod = null;

  async function startHosting(mode) {
    if (starting || lobby) return;
    starting = true;
    $('host1').disabled = $('host2').disabled = true;
    showMsg('Opening a game for friends… (up to 10 seconds)');
    try {
      const host = await ensureHost();
      mod = await import('./net/onelobby.js');
      lobby = await mod.hostGame();
      host.serve(lobby);
      localHost.code = lobby.joinCode;
      wireBar();
      showMsg('');
      join(mode); // client.js: connects this tab to its own rooms through localHost and shows the waiting card with the share link
    } catch (e) {
      console.warn('Host failed:', e);
      lobby = null;
      showMsg((mod && Object.keys(WHY).map(k => mod.is(e && e.code, k) && WHY[k]).find(Boolean)) || `Could not start hosting: ${e && e.message ? e.message : e}`, true);
      $('host1').disabled = $('host2').disabled = false;
    } finally { starting = false; }
  }

  // The always-visible host strip: the code, and a warning while the tab is hidden (browsers slow a hidden tab's timers,
  // which lags the match for everyone). Joiners whose networks cannot meet this tab's (strict NAT on both sides) see
  // ice_failed on their side; the Node host (`node server.js`, which opens a router port) is the way around that.
  function wireBar() {
    let lost = false;
    let note = '', noteTimer = 0;
    const render = () => {
      const hidden = lobby.hostHidden;
      bar.classList.toggle('warn', hidden || lost);
      bar.innerHTML = hidden ? '⚠ <b>This tab is hidden.</b> Players will lag until you switch back. Keep it open and visible.'
        : lost ? '⚠ <b>Lost the Nostr relays.</b> Friends already connected keep playing; new friends cannot join right now.'
        : `Hosting · join code <code></code> · keep this tab open and visible`;
      const c = bar.querySelector('code'); if (c) c.textContent = lobby.joinCode;
      if (note) { const d = document.createElement('div'); d.className = 'peer-note'; d.textContent = note; bar.append(d); bar.classList.add('warn'); }
    };
    lobby.on('hostHiddenChanged', render);
    lobby.on('serverLost', () => { lost = true; render(); });
    // A joiner that never connected (ice_failed, closed their tab, or no link within 15 s): tell the host, then fade the line.
    lobby.on('peerFailed', (peer, reason) => {
      note = mod.peerFailedNotice(peer, reason);
      clearTimeout(noteTimer); noteTimer = setTimeout(() => { note = ''; render(); }, 20000);
      render();
    });
    render();
    bar.classList.remove('hidden');
    addEventListener('pagehide', () => { try { lobby.leave(); } catch {} });
  }

  $('host1').onclick = () => startHosting('1v1');
  $('host2').onclick = () => startHosting('2v2');
  $('room').addEventListener('keydown', e => { if (e.key === 'Enter') { e.stopImmediatePropagation(); startHosting(params.get('mode') || '1v1'); } }, true);
})();
