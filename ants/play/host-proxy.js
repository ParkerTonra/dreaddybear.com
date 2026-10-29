// The page side of the worker-hosted game server (ant72). Same shape as browser-host.js's create() (socket(), serve(lobby),
// close()), but the rooms, sim, bots, fog and state encoding run in a Web Worker (host.worker.js, from ants/host-worker.js),
// so rendering cannot slow the match. This script keeps the transport: the tab's own in-memory socket and the OneLobby/WebRTC
// peers (RTCPeerConnection does not exist in workers). Protocol comments are in host-worker.js.
// AntHostProxy.create({ onError, url }) resolves with the host once the worker reports ready, and rejects when it cannot start
// (no Worker, a blocked or missing script, a slow start): host.js then falls back to host.bundle.js on the main thread.
(function (root) {
  const bytes = d => (typeof d === 'string' || !ArrayBuffer.isView(d) ? d : d.slice()); // views can sit on a big shared buffer; clone only their own bytes
  const bufs = d => (typeof d === 'string' || !d || !d.buffer ? [] : [d.buffer]);

  function create({ onError, url = 'host.worker.js', WorkerCtor = root.Worker, timeoutMs = 10000 } = {}) {
    return new Promise((resolve, reject) => {
      let w;
      try { w = new WorkerCtor(url); } catch (e) { reject(e); return; }
      const links = new Map(); // id -> { send(data, fast), close(code, reason) }
      let nextId = 1, closed = false, settled = false, perfWas = false, perfPoll = 0, stopServing = null;
      const report = e => { if (onError) onError(e); else console.error('Browser host:', e); };
      const post = (m, x) => { if (!closed) w.postMessage(m, x || []); };
      // Deliveries to the page's own code are never re-entrant (same as the main-thread host): they land on a later microtask.
      const later = fn => Promise.resolve().then(fn).catch(report);

      const timer = setTimeout(() => fail(new Error('the host worker did not start')), timeoutMs);
      function fail(e) {
        const err = e instanceof Error ? e : new Error(String((e && e.message) || e));
        if (settled) { report(err); return; }
        settled = true; clearTimeout(timer); closed = true;
        try { w.terminate(); } catch (x) { /* already gone */ }
        reject(err);
      }
      w.onerror = ev => { if (ev && ev.preventDefault) ev.preventDefault(); fail(new Error((ev && ev.message) || 'host worker error')); };
      w.onmessageerror = () => fail(new Error('host worker message error'));
      w.onmessage = ev => {
        const m = ev.data;
        if (m.t === 'out') {
          for (const o of m.m) {
            const link = links.get(o.id);
            if (!link) continue;
            if (o.t === 'send') link.send(o.data, o.fast);
            else if (o.t === 'close') link.close(o.code, o.reason);
          }
        } else if (m.t === 'perf') {
          const pf = root.__antPerf;
          if (pf) for (let i = 0; i < m.evs.length; i += 2) pf.ev(m.evs[i], m.evs[i + 1]);
        } else if (m.t === 'error') report(new Error(m.message));
        else if (m.t === 'ready' && !settled) {
          settled = true; clearTimeout(timer);
          // The F3 overlay (public/perf.js) switches host timing reports by setting globalThis.__antPerf; mirror that into the worker.
          perfPoll = setInterval(() => { const on = !!root.__antPerf; if (on !== perfWas) { perfWas = on; post({ t: 'perf', on }); } }, 400);
          root.__antHostWorker = w; // debug hook (tools/perf-profile.js posts { t:'simSpeed' } here)
          resolve(host);
        }
      };

      // The hosting player's connection: a client-side socket (what OneLobby's asWebSocket() gives a joiner), in memory.
      function socket() {
        const id = nextId++;
        const client = { readyState: 1, onmessage: null, onclose: null, _onopen: null, bufferedAmount: 0 };
        const finish = (code, reason, fromWorker) => {
          if (client.readyState === 3) return;
          client.readyState = 3; links.delete(id);
          if (!fromWorker) post({ t: 'shut', id }); // free the seat
          later(() => { if (client.onclose) client.onclose({ code, reason, wasClean: code === 1000 }); });
        };
        links.set(id, {
          send: data => later(() => { if (client.readyState === 1 && client.onmessage) client.onmessage({ data }); }),
          close: (code, reason) => finish(code, reason, true),
        });
        post({ t: 'open', id });
        Object.defineProperty(client, 'onopen', { // like asWebSocket(): setting onopen runs it even though the link is already open
          get: () => client._onopen,
          set(fn) { client._onopen = fn; if (fn) later(() => { if (client.readyState === 1 && client._onopen === fn) fn({}); }); },
        });
        client.send = data => {
          if (client.readyState !== 1) return;
          const d = bytes(data);
          post({ t: 'msg', id, data: d }, bufs(d));
        };
        client.close = (code = 1000, reason = '') => finish(code, reason, false);
        return client;
      }

      function serve(lobby) {
        if (stopServing) stopServing();
        // The OneLobby side stays here: a peer's bytes go to the worker, and what the worker sends comes back out on the
        // peer's reliable socket, or the fast (unordered) channel for deltas, exactly as serve-rooms.js does.
        stopServing = lobby.onConnection(conn => {
          const id = nextId++;
          links.set(id, {
            send: (data, fast) => { if (fast && typeof lobby.send === 'function') lobby.send(conn.peerId, data, { channel: 'fast' }); else conn.send(data); },
            close: (code = 1000, reason = '') => { links.delete(id); lobby.disconnect(conn.peerId, code, reason).catch(() => {}); },
          });
          post({ t: 'open', id });
          // binary: true guarantees a Uint8Array (OneLobby >= 0.6.0); it can be a view, so slice before transferring .buffer
          conn.onmessage = e => { const d = e.data.slice(); post({ t: 'msg', id, data: d }, [d.buffer]); };
          conn.onclose = () => { if (links.delete(id)) post({ t: 'shut', id }); };
        }, { binary: true });
      }

      const host = {
        worker: w,
        socket,
        serve,
        close() {
          if (closed) return;
          if (stopServing) { try { stopServing(); } catch (x) { /* lobby already gone */ } stopServing = null; }
          clearInterval(perfPoll); closed = true; links.clear();
          if (root.__antHostWorker === w) root.__antHostWorker = null;
          try { w.terminate(); } catch (x) { /* already gone */ }
        },
      };
    });
  }

  root.AntHostProxy = { create };
  if (typeof module !== 'undefined') module.exports = root.AntHostProxy;
})(typeof window !== 'undefined' ? window : globalThis);
