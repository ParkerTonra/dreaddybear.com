// State codec: the one place where a per-seat snapshot (the "view" fog.js builds) becomes bytes and bytes become a view
// again. room-core.js encodes with it, client.js (and the tests) decode with it; no other file calls JSON.stringify
// on state. Works in the browser (global StateCodec) and in Node (require). The schema table is in docs/netcode-schema.md.
//
// A state message is a Uint8Array, byte 0 = the message kind tag (TAG):
//   JSON   1  UTF-8 JSON of { type: 'state', state: view }       the format before the binary netcode (bench "before")
//   KEY    2  keyframe: the whole view. Sent on the reliable channel.
//   DELTA  3  the changes since a baseline tick the receiver holds. Sent on the fast channel (when it fits one packet).
//   ACK    4  receiver -> host: "I applied tick N" (fast, tiny). Not a state message; msg-guard.js hands it to room-core.
// Everything else on the wire (lobby, orders, chat, events) stays JSON text and starts with '{' (0x7b), so JSON text
// and these kinds can share a channel: parse() tells them apart by the first byte.
//
//   encodeState(view, sendCtx) -> Uint8Array       sendCtx = createSendCtx(): one per receiving connection
//   decodeState(bytes, recvCtx) -> view | null     recvCtx = createRecvCtx(): null = dropped (stale, or no baseline yet)
//                                                  throws CodecError for bytes that are not a valid message
//   channelOf(bytes) -> 'fast' | 'reliable'
//   parse(data, recvCtx) -> message object | null  any wire message (string, Uint8Array, ArrayBuffer, Buffer)
//   ackFor(recvCtx) -> Uint8Array | null           an ack to send back now (every 2nd applied tick, or "send a keyframe")
//   onAck(sendCtx, { epoch, tick })                the host applies an ack; decodeAck(bytes) reads one
//   resetSend(sendCtx)                             a new match: forget the baseline, next message is a keyframe
//
// Lossless: the decoder returns exactly what JSON.parse(JSON.stringify(view)) gives (numbers with at most 2 decimals,
// which is everything the sim sends, travel as integers x100; any other number travels as a float64). Fog culling has
// already happened by the time a view gets here; unseen entities are never written.
(function (root) {
  const TAG = { JSON: 1, KEY: 2, DELTA: 3, ACK: 4 };
  // The wire version of everything a game sends, state and orders alike. A joiner over OneLobby is refused by NET_VERSION
  // in public/net/onelobby.mjs (a string, tests/onelobby.test.js checks the two agree); a plain WebSocket joiner says it
  // in its join message (`nv`) and server.js refuses a mismatch. Bump both with any change a stale page cannot read.
  const NET_VERSION = 2;
  const FORMAT = 1; // bump when the byte layout changes mid-session compatibility (the netVersion handshake covers the rest)
  const KEY_EVERY = 15; // ticks between keyframes (1 s at 15 Hz)
  const RING = 32; // sent / received views kept as delta baselines
  const FAST_MAX = 1200; // a delta over this goes out on the reliable channel instead (never chunk a fast message)
  const ACK_EVERY = 2; // the receiver acks every 2nd applied state
  const STALE_DROPS = 8; // this many unusable deltas in a row: ask for a keyframe
  const DEFAULT_MODE = 'delta'; // 'json' (old wire), 'key' (binary, keyframes only), 'delta' (keyframes + deltas)

  class CodecError extends Error {
    constructor(message) { super(message); this.name = 'CodecError'; }
  }

  const enc = new TextEncoder(), dec = new TextDecoder();

  // ---------------------------------------------------------------- bytes
  class Writer {
    constructor(cap) { this.b = new Uint8Array(cap || 16384); this.n = 0; this.dv = new DataView(this.b.buffer); }
    ensure(k) {
      if (this.n + k <= this.b.length) return;
      let c = this.b.length * 2;
      while (c < this.n + k) c *= 2;
      const nb = new Uint8Array(c); nb.set(this.b.subarray(0, this.n));
      this.b = nb; this.dv = new DataView(nb.buffer);
    }
    u8(v) { this.ensure(1); this.b[this.n++] = v; }
    varint(v) { // LEB128, v a non-negative integer below 2^53
      this.ensure(8);
      while (v >= 128) { this.b[this.n++] = (v % 128) | 128; v = Math.floor(v / 128); }
      this.b[this.n++] = v;
    }
    zigzag(v) { this.varint(v < 0 ? -2 * v - 1 : 2 * v); }
    f64(v) { this.ensure(8); this.dv.setFloat64(this.n, v, true); this.n += 8; }
    bytes(a) { this.ensure(a.length); this.b.set(a, this.n); this.n += a.length; }
    take() { return this.b.slice(0, this.n); }
  }

  class Reader {
    constructor(b, p = 0) { this.b = b; this.p = p; this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength); }
    left() { return this.b.length - this.p; }
    u8() { if (this.p >= this.b.length) throw new CodecError('truncated'); return this.b[this.p++]; }
    varint() {
      let r = 0, m = 1;
      for (let i = 0; i < 8; i++) { const c = this.u8(); r += (c & 127) * m; if (c < 128) return r; m *= 128; }
      throw new CodecError('varint too long');
    }
    zigzag() { const v = this.varint(); return v % 2 ? -(v + 1) / 2 : v / 2; }
    f64() { if (this.left() < 8) throw new CodecError('truncated'); const v = this.dv.getFloat64(this.p, true); this.p += 8; return v; }
    bytes(n) { if (n > this.left()) throw new CodecError('truncated'); const a = this.b.subarray(this.p, this.p + n); this.p += n; return a; }
    count() { const n = this.varint(); if (n > this.left()) throw new CodecError('count past the end'); return n; } // every item takes >= 1 byte
  }

  // ---------------------------------------------------------------- strings: a frozen table of the names the sim uses
  // Additive only: appending is a compatible change inside one FORMAT, reordering or removing is not.
  const STATIC = ['t', 'seed', 'mode', 'size', 'map', 'nextEventIn', 'event', 'winner', 'players', 'team', 'alive', 'food', 'nest', 'x', 'y', 'hp', 'max', 'rally', 'pellets', 'idle', 'upgrades', 'dmg', 'chitin', 'acid', 'legs', 'forage', 'jelly', 'research', 'ants', 'anteater', 'warn', 'beetle', 'flood', 'wrally', 'shots', 'log', 'stats', 'spawned', 'lost', 'nestDmg', 'lostBy', 'obj', 'farms', 'lairs', 'dir', 'clock', 'terrain', 'puddles', 'upgradeTable', 'time', 'heals', 'srally', 'structures', 'abil', 'cd', 'trails', 'volleys', 'alarm', 'tired', 'called', 'kind', 'id', 'colony', 'fight', 'name', 'in', 'target', 'line', 'structure', 'roll', 'desc', 'dur', 'left', 'cause', 'n', 'types', 'worker', 'level', 'total', 'spider', 'hits', 'volley', 'spitter', 'soldier', 'quake', 'nurse', 'what', 'farm', 'mound', 'fog', 'v', 'dead', 'seen', 'digs', 'major', 'alate', 'depot', 'outpost', '1v1', '2v2', 'quick', 'standard', 'large', 'win', 'upgrade', 'build', 'built', 'razed', 'ability', 'event-loss', 'reason'];
  const STATIC_MAP = new Map();
  STATIC.forEach((s, i) => { if (!STATIC_MAP.has(s)) STATIC_MAP.set(s, i); });
  const S = STATIC.length;

  class Dict { constructor() { this.map = new Map(); this.list = []; } }

  function writeStr(w, D, s) {
    let i = STATIC_MAP.get(s);
    if (i !== undefined) { w.varint(i + 2); return; }
    i = D.map.get(s);
    if (i !== undefined) { w.varint(i + 2 + S); return; }
    if (s.length <= 24) { D.map.set(s, D.list.length); D.list.push(s); w.varint(1); } else w.varint(0);
    const b = enc.encode(s);
    w.varint(b.length); w.bytes(b);
  }

  function readStr(r, D) {
    const code = r.varint();
    if (code <= 1) {
      const s = dec.decode(r.bytes(r.varint()));
      if (code === 1) D.list.push(s);
      return s;
    }
    const i = code - 2;
    if (i < S) return STATIC[i];
    if (i - S < D.list.length) return D.list[i - S];
    throw new CodecError('bad string ref');
  }

  // ---------------------------------------------------------------- values (JSON-shaped)
  // 0 null, 1 false, 2 true, 3 uint, 4 negative int, 5 number x100 (zigzag), 6 float64, 7 string, 8 array, 9 object,
  // 0x10..0xff the integers 0..239.
  const MAX_DEPTH = 24;

  // The JSON data model: undefined and functions vanish from objects (null in arrays), non-finite numbers are null.
  function norm(v) {
    if (v === null || v === undefined) return null;
    const t = typeof v;
    if (t === 'number') return Number.isFinite(v) ? (v === 0 ? 0 : v) : null;
    if (t === 'boolean' || t === 'string') return v;
    if (Array.isArray(v)) { const o = new Array(v.length); for (let i = 0; i < v.length; i++) o[i] = norm(v[i]); return o; }
    if (t === 'object') {
      if (typeof v.toJSON === 'function') return norm(v.toJSON());
      const o = {};
      for (const k in v) { const x = v[k]; if (x !== undefined && typeof x !== 'function') o[k] = norm(x); }
      return o;
    }
    return null;
  }

  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

  function deepEqual(a, b) {
    if (a === b) return true;
    if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
    const aa = Array.isArray(a);
    if (aa !== Array.isArray(b)) return false;
    if (aa) {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
      return true;
    }
    let n = 0;
    for (const k in a) { n++; if (!has(b, k) || !deepEqual(a[k], b[k])) return false; }
    for (const k in b) n--;
    return n === 0;
  }

  const scaled = v => { const s = Math.round(v * 100); return s / 100 === v && Math.abs(s) < 2147483648 ? s : null; };

  // Long strings that are only digits 0-2 (the terrain map: open / rock / mud) or only URL-safe base64 characters (the
  // fog grid): 5 digits per byte, 6 bits per character.
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const B64_REV = new Int8Array(128).fill(-1);
  for (let i = 0; i < 64; i++) B64_REV[B64.charCodeAt(i)] = i;
  function writePacked(w, s) {
    const n = s.length;
    let tern = true, b64 = true;
    for (let i = 0; i < n && (tern || b64); i++) {
      const c = s.charCodeAt(i);
      if (c < 48 || c > 50) tern = false;
      if (c > 127 || B64_REV[c] < 0) b64 = false;
    }
    if (tern) {
      w.u8(10); w.varint(n);
      for (let i = 0; i < n; i += 5) {
        let b = 0;
        for (let j = 0; j < 5; j++) b = b * 3 + (i + j < n ? s.charCodeAt(i + j) - 48 : 0);
        w.u8(b);
      }
      return true;
    }
    if (b64) {
      w.u8(11); w.varint(n);
      let acc = 0, bits = 0;
      for (let i = 0; i < n; i++) {
        acc = (acc << 6) | B64_REV[s.charCodeAt(i)]; bits += 6;
        while (bits >= 8) { bits -= 8; w.u8((acc >> bits) & 255); }
        acc &= (1 << bits) - 1;
      }
      if (bits) w.u8((acc << (8 - bits)) & 255);
      return true;
    }
    return false;
  }
  function readPacked(r, kind) {
    const n = r.varint();
    if (kind === 10) {
      if (Math.ceil(n / 5) > r.left()) throw new CodecError('string past the end');
      const out = new Array(n);
      for (let i = 0; i < n; i += 5) {
        let b = r.u8();
        if (b > 242) throw new CodecError('bad digit group');
        for (let j = 4; j >= 0; j--) { const d = b % 3; b = (b - d) / 3; if (i + j < n) out[i + j] = d; }
      }
      return out.join('');
    }
    if (Math.ceil(n * 6 / 8) > r.left()) throw new CodecError('string past the end');
    const out = new Array(n);
    let acc = 0, bits = 0;
    for (let i = 0; i < n; i++) {
      while (bits < 6) { acc = (acc << 8) | r.u8(); bits += 8; }
      bits -= 6; out[i] = B64[(acc >> bits) & 63];
      acc &= (1 << bits) - 1;
    }
    return out.join('');
  }

  function writeValue(w, D, v) {
    if (v === null) { w.u8(0); return; }
    switch (typeof v) {
      case 'boolean': w.u8(v ? 2 : 1); return;
      case 'number': {
        if (Number.isInteger(v) && Math.abs(v) < 9007199254740992) {
          if (v >= 0) { if (v <= 239) w.u8(0x10 + v); else { w.u8(3); w.varint(v); } } else { w.u8(4); w.varint(-v); }
          return;
        }
        const s = scaled(v);
        if (s !== null) { w.u8(5); w.zigzag(s); } else { w.u8(6); w.f64(v); }
        return;
      }
      case 'string': if (v.length >= 16 && writePacked(w, v)) return; w.u8(7); writeStr(w, D, v); return;
      default:
        if (Array.isArray(v)) { w.u8(8); w.varint(v.length); for (let i = 0; i < v.length; i++) writeValue(w, D, v[i]); return; }
        { const keys = Object.keys(v); w.u8(9); w.varint(keys.length); for (const k of keys) { writeStr(w, D, k); writeValue(w, D, v[k]); } }
    }
  }

  function safeKey(k) { if (k === '__proto__') throw new CodecError('bad key'); return k; }

  function readValue(r, D, depth = 0) {
    if (depth > MAX_DEPTH) throw new CodecError('too deep');
    const t = r.u8();
    if (t >= 0x10) return t - 0x10;
    switch (t) {
      case 0: return null;
      case 1: return false;
      case 2: return true;
      case 3: return r.varint();
      case 4: return -r.varint();
      case 5: return r.zigzag() / 100;
      case 6: return r.f64();
      case 7: return readStr(r, D);
      case 8: { const n = r.count(), a = new Array(n); for (let i = 0; i < n; i++) a[i] = readValue(r, D, depth + 1); return a; }
      case 10: case 11: return readPacked(r, t);
      case 9: { const n = r.count(), o = {}; for (let i = 0; i < n; i++) { const k = safeKey(readStr(r, D)); o[k] = readValue(r, D, depth + 1); } return o; }
      default: throw new CodecError('bad value tag ' + t);
    }
  }

  // ---------------------------------------------------------------- patches (delta of a JSON value against its baseline)
  // 0 SET value | 1 ARR newLen, n, n x (index gap, patch) | 2 OBJ n, n x (key, patch), n, n x deleted key
  // 3 STR n, n x (index gap, char code) for a same-length string (fog grid, terrain) | 4 SAME
  const P_SET = 0, P_ARR = 1, P_OBJ = 2, P_STR = 3, P_SAME = 4;

  // mem (root only): the last value each top-level key had in this epoch. A key the baseline does not have (terrain,
  // which the sim includes every 15th state) is patched against its remembered value instead of being sent whole.
  function writePatch(w, D, o, n, mem) {
    if (deepEqual(o, n)) { w.u8(P_SAME); return; }
    if (Array.isArray(o) && Array.isArray(n)) {
      const changed = [];
      for (let i = 0; i < n.length; i++) if (i >= o.length || !deepEqual(o[i], n[i])) changed.push(i);
      if (changed.length * 2 <= n.length) {
        w.u8(P_ARR); w.varint(n.length); w.varint(changed.length);
        let prev = -1;
        for (const i of changed) { w.varint(i - prev); prev = i; if (i >= o.length) { w.u8(P_SET); writeValue(w, D, n[i]); } else writePatch(w, D, o[i], n[i]); }
        return;
      }
    } else if (o && n && typeof o === 'object' && typeof n === 'object' && !Array.isArray(o) && !Array.isArray(n)) {
      const sets = [], dels = [];
      let nk = 0;
      for (const k in n) { nk++; if (!has(o, k) || !deepEqual(o[k], n[k])) sets.push(k); }
      for (const k in o) if (!has(n, k)) dels.push(k);
      if (mem || sets.length < nk || dels.length) { // some key stays: patch it, else a plain SET is no bigger
        w.u8(P_OBJ); w.varint(sets.length);
        for (const k of sets) {
          writeStr(w, D, k);
          const old = has(o, k) ? o[k] : mem && has(mem, k) ? mem[k] : undefined;
          if (old !== undefined) writePatch(w, D, old, n[k]); else { w.u8(P_SET); writeValue(w, D, n[k]); }
        }
        w.varint(dels.length);
        for (const k of dels) writeStr(w, D, k);
        return;
      }
    } else if (typeof o === 'string' && typeof n === 'string' && o.length === n.length && n.length >= 16) {
      const at = [];
      for (let i = 0; i < n.length; i++) if (o.charCodeAt(i) !== n.charCodeAt(i)) { if (n.charCodeAt(i) > 255) { at.length = n.length; break; } at.push(i); }
      if (at.length * 2 + 3 < n.length) {
        w.u8(P_STR); w.varint(at.length);
        let prev = -1;
        for (const i of at) { w.varint(i - prev); prev = i; w.u8(n.charCodeAt(i)); }
        return;
      }
    }
    w.u8(P_SET); writeValue(w, D, n);
  }

  function applyPatch(r, D, o, depth = 0, mem) {
    if (depth > MAX_DEPTH) throw new CodecError('too deep');
    const op = r.u8();
    switch (op) {
      case P_SAME: if (o === undefined) throw new CodecError('same of nothing'); return o;
      case P_SET: return readValue(r, D, depth);
      case P_ARR: {
        if (!Array.isArray(o)) throw new CodecError('array patch of a non-array');
        const len = r.varint(), cnt = r.count();
        if (len > 1e6) throw new CodecError('array too long');
        const a = o.slice(0, len);
        let at = -1;
        for (let k = 0; k < cnt; k++) {
          at += r.varint();
          if (at >= len) throw new CodecError('index past the end');
          a[at] = applyPatch(r, D, o[at], depth + 1);
        }
        if (a.length !== len || a.includes(undefined)) throw new CodecError('array has holes');
        return a;
      }
      case P_OBJ: {
        if (!o || typeof o !== 'object' || Array.isArray(o)) throw new CodecError('object patch of a non-object');
        const out = { ...o };
        for (let k = r.count(); k > 0; k--) {
          const key = safeKey(readStr(r, D));
          out[key] = applyPatch(r, D, has(o, key) ? o[key] : mem && has(mem, key) ? mem[key] : undefined, depth + 1);
        }
        for (let k = r.count(); k > 0; k--) delete out[readStr(r, D)];
        return out;
      }
      case P_STR: {
        if (typeof o !== 'string') throw new CodecError('string patch of a non-string');
        const cnt = r.count(), chars = o.split('');
        let at = -1;
        for (let k = 0; k < cnt; k++) { at += r.varint(); if (at >= chars.length) throw new CodecError('index past the end'); chars[at] = String.fromCharCode(r.u8()); }
        return chars.join('');
      }
      default: throw new CodecError('bad patch op ' + op);
    }
  }

  // ---------------------------------------------------------------- ants: the one big list, written by id
  // Tuple: [id, colony, type, x, y, dir, carrying, hp%, hitFlash, orderFlag, foe, stateCode] + [12] vet rank when > 0.
  // Written specially when every tuple fits (and ids ascend); otherwise `ants` rides along as an ordinary value.
  const s100 = Math.round;
  const isU = (v, max) => Number.isInteger(v) && v >= 0 && v <= max;
  function packable(list) {
    let prev = -1;
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (!Array.isArray(a) || (a.length !== 12 && a.length !== 13)) return false;
      if (!isU(a[0], 2147483647) || a[0] <= prev) return false;
      prev = a[0];
      if (!isU(a[1], 3) || !isU(a[2], 7) || !isU(a[6], 1) || !isU(a[7], 65535) || !isU(a[8], 65535) || !isU(a[9], 65535) || !isU(a[10], 2147483647) || !isU(a[11], 65535)) return false;
      if (a.length === 13 && !isU(a[12], 255)) return false;
      if (a.length === 13 && a[12] === 0) return false;
      if (scaled(a[3]) === null || scaled(a[4]) === null || scaled(a[5]) === null) return false;
    }
    return true;
  }

  const vetOf = a => (a.length > 12 ? a[12] : 0);

  function writeAntFull(w, a) {
    const vet = vetOf(a);
    const m = (a[8] ? 1 : 0) | (a[9] ? 2 : 0) | (a[10] ? 4 : 0) | (vet ? 8 : 0);
    w.u8(a[1] | (a[2] << 2) | (a[6] << 5) | (m ? 64 : 0));
    if (m) w.u8(m);
    w.zigzag(s100(a[3] * 100)); w.zigzag(s100(a[4] * 100)); w.zigzag(s100(a[5] * 100));
    w.varint(a[7]); w.varint(a[11]);
    if (a[8]) w.varint(a[8]);
    if (a[9]) w.varint(a[9]);
    if (a[10]) w.varint(a[10]);
    if (vet) w.varint(vet);
  }

  function readAntFull(r, id) {
    const b1 = r.u8(), m = b1 & 64 ? r.u8() : 0;
    const x = r.zigzag() / 100, y = r.zigzag() / 100, dir = r.zigzag() / 100;
    const hp = r.varint(), state = r.varint();
    const flash = m & 1 ? r.varint() : 0, order = m & 2 ? r.varint() : 0, foe = m & 4 ? r.varint() : 0;
    const t = [id, b1 & 3, (b1 >> 2) & 7, x, y, dir, (b1 >> 5) & 1, hp, flash, order, foe, state];
    if (m & 8) t.push(r.varint());
    return t;
  }

  function writeAntsKey(w, list) {
    w.varint(list.length);
    let prev = -1;
    for (const a of list) { w.varint(a[0] - prev); prev = a[0]; writeAntFull(w, a); }
  }

  function readAntsKey(r) {
    const n = r.count(), out = new Array(n);
    let prev = -1;
    for (let i = 0; i < n; i++) { prev += r.varint(); out[i] = readAntFull(r, prev); }
    return out;
  }

  const sc = v => s100(v * 100);

  // Changes of the new list against the baseline list (Map id -> tuple, ascending). Part A walks the baseline ants in
  // order and names only the ones that were removed or changed, by how many baseline ants to skip (1 = the next one,
  // free in the control byte, so a crowd that all moves costs no id bytes at all); part B lists new ants by id.
  function writeAntsDelta(w, base, list) {
    const now = new Map();
    for (const a of list) now.set(a[0], a);
    const recs = [];
    let idx = 0;
    for (const [id, o] of base) {
      const a = now.get(id);
      if (!a || a[1] !== o[1] || a[2] !== o[2]) recs.push({ idx, rm: true });
      else {
        let c = 0, ext = 0;
        if (sc(a[3]) !== sc(o[3])) c |= 1;
        if (sc(a[4]) !== sc(o[4])) c |= 2;
        if (sc(a[5]) !== sc(o[5])) c |= 4;
        if (a[7] !== o[7]) c |= 8;
        if (a[6] !== o[6]) ext |= 1;
        if (a[8] !== o[8]) ext |= 2;
        if (a[9] !== o[9]) ext |= 4;
        if (a[10] !== o[10]) ext |= 8;
        if (a[11] !== o[11]) ext |= 16;
        if (vetOf(a) !== vetOf(o)) ext |= 32;
        if (ext) c |= 16;
        if (c) recs.push({ idx, a, o, c, ext });
      }
      idx++;
    }
    w.varint(recs.length);
    let prev = -1;
    for (const rec of recs) {
      const gap = rec.idx - prev; prev = rec.idx;
      const gm = gap === 1 ? 0 : gap <= 257 ? 1 : 2;
      w.u8((rec.rm ? 0x80 : rec.c) | (gm << 5));
      if (gm === 1) w.u8(gap - 2); else if (gm === 2) w.varint(gap);
      if (rec.rm) continue;
      const { a, o, c, ext } = rec;
      if (c & 1) w.zigzag(sc(a[3]) - sc(o[3]));
      if (c & 2) w.zigzag(sc(a[4]) - sc(o[4]));
      if (c & 4) w.zigzag(sc(a[5]) - sc(o[5]));
      if (c & 8) w.zigzag(a[7] - o[7]);
      if (c & 16) {
        w.u8(ext);
        if (ext & 1) w.u8(a[6]);
        if (ext & 2) w.varint(a[8]);
        if (ext & 4) w.varint(a[9]);
        if (ext & 8) w.varint(a[10]);
        if (ext & 16) w.varint(a[11]);
        if (ext & 32) w.varint(vetOf(a));
      }
    }
    const adds = [];
    for (const a of list) { const o = base.get(a[0]); if (!o || o[1] !== a[1] || o[2] !== a[2]) adds.push(a); }
    w.varint(adds.length);
    prev = -1;
    for (const a of adds) { w.varint(a[0] - prev); prev = a[0]; writeAntFull(w, a); }
  }

  function readAntsDelta(r, base) {
    const ids = [...base.keys()], map = new Map(base);
    let idx = -1;
    for (let k = r.count(); k > 0; k--) {
      const c = r.u8(), gm = (c >> 5) & 3;
      if (gm === 3) throw new CodecError('bad ant gap');
      idx += gm === 0 ? 1 : gm === 1 ? r.u8() + 2 : r.varint();
      if (idx >= ids.length) throw new CodecError('ant index past the end');
      const id = ids[idx];
      if (c & 0x80) { map.delete(id); continue; }
      const o = map.get(id), t = o.slice();
      if (c & 1) t[3] = (sc(o[3]) + r.zigzag()) / 100;
      if (c & 2) t[4] = (sc(o[4]) + r.zigzag()) / 100;
      if (c & 4) t[5] = (sc(o[5]) + r.zigzag()) / 100;
      if (c & 8) t[7] = o[7] + r.zigzag();
      if (c & 16) {
        const ext = r.u8();
        if (ext & 1) t[6] = r.u8();
        if (ext & 2) t[8] = r.varint();
        if (ext & 4) t[9] = r.varint();
        if (ext & 8) t[10] = r.varint();
        if (ext & 16) t[11] = r.varint();
        if (ext & 32) { const v = r.varint(); if (v) t[12] = v; else t.length = 12; }
      }
      map.set(id, t);
    }
    let prev = -1;
    for (let k = r.count(); k > 0; k--) { prev += r.varint(); map.set(prev, readAntFull(r, prev)); }
    const out = [...map.values()];
    out.sort((a, b) => a[0] - b[0]);
    return out;
  }

  // ---------------------------------------------------------------- send side
  // ctx: { mode, epoch (u8, changes with every new match / connection), tick, ring: Map tick -> { rest, ants },
  //        acked (newest tick the peer reported), lastKey, needKey }
  function createSendCtx(opts = {}) {
    return { mode: opts.mode || DEFAULT_MODE, epoch: Math.floor(Math.random() * 256), tick: 0, ring: new Map(), acked: 0, lastKey: 0, needKey: true };
  }

  function resetSend(ctx) {
    ctx.epoch = (ctx.epoch + 1) & 255; ctx.tick = 0; ctx.ring.clear(); ctx.acked = 0; ctx.lastKey = 0; ctx.needKey = true;
  }

  function onAck(ctx, ack) {
    if (!ack || ack.epoch !== ctx.epoch) return;
    if (ack.tick === 0) ctx.needKey = true; // the peer could not use what it got: keyframe next
    else if (ack.tick > ctx.acked && ack.tick <= ctx.tick) ctx.acked = ack.tick;
  }

  // JSON bytes are shared by every connection that gets the same view object (two teammates, all spectators).
  const jsonMemo = new WeakMap();
  function encodeJson(view) {
    let bytes = jsonMemo.get(view);
    if (!bytes) {
      const body = enc.encode(JSON.stringify({ type: 'state', state: view }));
      bytes = new Uint8Array(body.length + 1);
      bytes[0] = TAG.JSON;
      bytes.set(body, 1);
      jsonMemo.set(view, bytes);
    }
    return bytes;
  }

  const shared = new Writer(65536); // one scratch buffer: encoding is synchronous, take() copies out

  function encodeState(view, ctx) {
    if (ctx.mode === 'json') return encodeJson(view);
    const n = norm(view), tick = ++ctx.tick;
    let ants = null;
    if (Array.isArray(n.ants) && packable(n.ants)) { ants = n.ants; }
    const rest = ants ? Object.assign({}, n) : n;
    if (ants) delete rest.ants;
    const entry = { rest, ants: ants && new Map(ants.map(a => [a[0], a])) };
    const w = shared; w.n = 0;
    let base = null;
    if (ctx.mode === 'delta' && !ctx.needKey && tick - ctx.lastKey < KEY_EVERY) {
      const bt = Math.max(ctx.acked, ctx.lastKey); // a keyframe travels reliably: safe to delta against it before its ack
      base = bt > 0 && tick - bt < RING - 1 ? ctx.ring.get(bt) : null;
      if (base && ants && !base.ants) base = null;
      if (base) {
        w.u8(TAG.DELTA); w.u8(ctx.epoch); w.varint(tick); w.varint(tick - bt);
        w.u8(ants ? 1 : 0);
        if (ants) writeAntsDelta(w, base.ants, ants);
        writePatch(w, new Dict(), base.rest, rest, base.mem);
      }
    }
    if (!base) {
      w.n = 0;
      w.u8(TAG.KEY); w.u8(FORMAT); w.u8(ctx.epoch); w.varint(tick);
      w.u8(ants ? 1 : 0);
      if (ants) writeAntsKey(w, ants);
      writeValue(w, new Dict(), rest);
      ctx.lastKey = tick; ctx.needKey = false;
    }
    entry.mem = Object.assign({}, base ? base.mem : null, rest);
    ctx.ring.set(tick, entry);
    ctx.ring.delete(tick - RING);
    return w.take();
  }

  function channelOf(bytes) { return bytes[0] === TAG.DELTA && bytes.length <= FAST_MAX ? 'fast' : 'reliable'; }

  // ---------------------------------------------------------------- receive side
  // ctx: { epoch (-1 = none yet), last (newest applied tick), ring: Map tick -> { rest, ants }, sinceAck, wantKey, misses }
  function createRecvCtx() { return { epoch: -1, last: 0, ring: new Map(), sinceAck: 0, wantKey: false, misses: 0 }; }

  function toBytes(data) {
    if (data instanceof Uint8Array) return data;
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength); // also bytes made in another realm (vm, iframe)
    if (data instanceof ArrayBuffer || Object.prototype.toString.call(data) === '[object ArrayBuffer]') return new Uint8Array(data);
    throw new CodecError('not bytes');
  }

  function build(entry) { // a view the page may keep and mutate: nothing shared with the baseline ring
    const view = norm(entry.rest);
    if (entry.ants) view.ants = [...entry.ants.values()].map(t => t.slice());
    return view;
  }

  function decodeState(bytes, ctx) {
    bytes = toBytes(bytes);
    const tag = bytes[0];
    if (tag === TAG.JSON) {
      try { return JSON.parse(dec.decode(bytes.subarray(1))).state; } catch (e) { throw new CodecError('bad json state'); }
    }
    if (tag !== TAG.KEY && tag !== TAG.DELTA) throw new CodecError('unknown state tag ' + tag);
    const r = new Reader(bytes, 1);
    let epoch, tick, bt = 0;
    if (tag === TAG.KEY) {
      if (r.u8() !== FORMAT) throw new CodecError('state format ' + bytes[1] + ' not understood');
      epoch = r.u8(); tick = r.varint();
    } else { epoch = r.u8(); tick = r.varint(); bt = tick - r.varint(); }
    if (tag === TAG.KEY && epoch !== ctx.epoch) { ctx.epoch = epoch; ctx.last = 0; ctx.ring.clear(); ctx.sinceAck = 0; ctx.misses = 0; } // new match / connection
    if (epoch !== ctx.epoch || tick <= ctx.last) return null; // an old match, a reordered or duplicated message
    const D = new Dict();
    let entry;
    if (tag === TAG.KEY) {
      const hasAnts = r.u8() & 1;
      const list = hasAnts ? readAntsKey(r) : null;
      const rest = readValue(r, D);
      if (!rest || typeof rest !== 'object' || Array.isArray(rest)) throw new CodecError('state is not an object');
      entry = { rest, ants: list && new Map(list.map(a => [a[0], a])) };
    } else {
      const base = ctx.ring.get(bt);
      if (!base) { if (++ctx.misses >= STALE_DROPS) { ctx.wantKey = true; ctx.misses = 0; } return null; } // no baseline: wait for a keyframe
      const hasAnts = r.u8() & 1;
      if (hasAnts && !base.ants) throw new CodecError('ant delta without ants');
      const list = hasAnts ? readAntsDelta(r, base.ants) : null;
      const rest = applyPatch(r, D, base.rest, 0, base.mem);
      if (!rest || typeof rest !== 'object' || Array.isArray(rest)) throw new CodecError('state is not an object');
      entry = { rest, ants: list && new Map(list.map(a => [a[0], a])) };
    }
    if (r.left()) throw new CodecError('trailing bytes');
    ctx.misses = 0;
    ctx.last = tick; ctx.sinceAck++;
    entry.mem = Object.assign({}, tag === TAG.DELTA ? ctx.ring.get(bt).mem : null, entry.rest);
    ctx.ring.set(tick, entry);
    ctx.ring.delete(tick - RING);
    return build(entry);
  }

  // ---------------------------------------------------------------- acks (receiver -> host)
  function ackBytes(epoch, tick) { const w = new Writer(16); w.u8(TAG.ACK); w.u8(epoch); w.varint(tick); return w.take(); }

  function ackFor(ctx) {
    if (ctx.wantKey) { ctx.wantKey = false; return ackBytes(ctx.epoch < 0 ? 0 : ctx.epoch, 0); }
    if (ctx.sinceAck >= ACK_EVERY) { ctx.sinceAck = 0; return ackBytes(ctx.epoch, ctx.last); }
    return null;
  }

  function decodeAck(data) {
    try {
      const b = toBytes(data);
      if (b[0] !== TAG.ACK) return null;
      const r = new Reader(b, 1);
      const epoch = r.u8(), tick = r.varint();
      return { type: 'ack', epoch, tick };
    } catch (e) { return null; }
  }

  // Any message from the host. A state message comes back as { type: 'state', state: view }; one the page cannot use
  // (a stale or baseline-less delta, or garbled bytes, which also ask for a keyframe) comes back null. Throws only
  // for JSON text that does not parse (the caller's old behaviour).
  function parse(data, ctx) {
    if (typeof data === 'string') return JSON.parse(data);
    const bytes = toBytes(data);
    if (bytes[0] === 0x7b) return JSON.parse(dec.decode(bytes)); // '{': a JSON text message that arrived as bytes
    try {
      const state = decodeState(bytes, ctx);
      return state ? { type: 'state', state } : null;
    } catch (e) {
      if (!(e instanceof CodecError)) throw e;
      ctx.wantKey = true;
      return null;
    }
  }

  const api = { TAG, NET_VERSION, FORMAT, KEY_EVERY, RING, FAST_MAX, CodecError, createSendCtx, createRecvCtx, resetSend, encodeState, decodeState, channelOf, parse, ackFor, onAck, decodeAck, Writer, Reader };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.StateCodec = api;
})(typeof window !== 'undefined' ? window : this);
