// OneLobby integration, page side (the host side is onelobby-host.js; ONELOBBY.md walks through both).
// dial() joins a OneLobby direct host and returns its WebSocket-shaped socket (lobby.asWebSocket()), so client.js
// talks to it exactly like to server.js's WebSocket. Close codes: 1000 we left, 1001 the host left, 4000 kicked,
// 1006 timeout or no route to the host; e.reason is the lobby's reason ("host_left", "timeout", ...).

export const GAME_ID = 'dev.parkwow.antarena';
// Bump when snapshots or commands change shape; OneLobby won't mix clients with different netVersions.
export const NET_VERSION = '1';
// Both ends drop a peer they haven't heard from in this long (OneLobby pings every 2 s).
export const PEER_TIMEOUT_MS = 12000;

// address: location.host when the page came from the host's OneLobby port, or a join code (?dc=CODE).
// OneLobby defaults to the browser bundle the host serves; Node tests pass the package's class and a linkFactory.
export async function dial(address, { OneLobby, kitOptions = {} } = {}) {
  if (!OneLobby) ({ OneLobby } = await loadKit());
  const kit = new OneLobby({ gameId: GAME_ID, netVersion: NET_VERSION, mode: 'raw', lobbyServer: '', peerTimeoutMs: PEER_TIMEOUT_MS, ...kitOptions });
  const lobby = await kit.joinDirect(address);
  await lobby.ready; // the link to the host is open (a failure rejects, so the caller retries)
  return lobby.asWebSocket();
}

// OneLobby's browser bundle: served at the site root by server.js; a static copy of the game keeps it beside the page.
export async function loadKit() {
  try { return await import('../onelobby.bundle.js'); }
  catch { return await import(new URL('onelobby.bundle.js', document.baseURI).href); }
}

// Browser host (host.js): hosts a Nostr-signaled lobby from this tab, no Node server and no open port. Resolves to the
// host Lobby (joinCode = the Nostr code to share; lobby.hostHidden / 'hostHiddenChanged' when the tab is throttled).
// Rejects with direct_unreachable when no Nostr relay answers in 10 s. Same budget as the Node host's rateLimit (net.js).
export async function hostGame({ OneLobby, kitOptions = {}, hostOptions = {} } = {}) {
  if (!OneLobby) ({ OneLobby } = await loadKit());
  const kit = new OneLobby({ gameId: GAME_ID, netVersion: NET_VERSION, mode: 'raw', lobbyServer: '', displayName: 'Ant Arena', peerTimeoutMs: PEER_TIMEOUT_MS, ...kitOptions });
  return kit.hostNostr({ maxPlayers: 64, name: 'Ant Arena', rateLimit: { messages: 40, perMs: 2000 }, ...hostOptions });
}
