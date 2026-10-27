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
  if (!OneLobby) ({ OneLobby } = await import('../onelobby.bundle.js'));
  const kit = new OneLobby({ gameId: GAME_ID, netVersion: NET_VERSION, mode: 'raw', lobbyServer: '', peerTimeoutMs: PEER_TIMEOUT_MS, ...kitOptions });
  const lobby = await kit.joinDirect(address);
  await lobby.ready; // the link to the host is open (a failure rejects, so the caller retries)
  return lobby.asWebSocket();
}
