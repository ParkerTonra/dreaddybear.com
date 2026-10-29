// Ant Arena sound: a procedural WebAudio synth (stings, UI, ambience, and the fallback for everything) plus a small
// sampled-impact player (ant18/audio: Kenney Impact + Sci-Fi packs, CC0, in public/assets/sfx/).
// Strike-frame hook for feel-anim: Sound.strike(kind, x, y) / Sound.impact(family, x, y); Sound.HIT_STOP_MS = 30.
// Client hook: Sound.onState(prev, curr, mySide) once per server snapshot.
// Triggers are derived from snapshot diffs + log entries, so the server needs no changes.
(function (root) {
  'use strict';
  const KEY = 'antArenaMuted';
  // Minimum ms between two plays of the same sound, so 60 fighting ants don't make noise soup.
  const MIN_GAP = { spawnWorker: 60, spawnSoldier: 60, death: 140, nestHit: 320, nestHitMine: 600, rally: 80, dice: 500, nestDestroyed: 400, spit: 150, abil_trail: 300, abil_alarm: 300, abil_volley: 300, abil_call: 600, volleyHit: 200, underAttack: 3000 };
  const MAX_VOICES = 10; // hard cap on overlapping synth sounds
  const SAMPLE_VOICES = 16; // hard cap on overlapping sampled sounds (separate pool)
  const STING_DELAY = 0.9; // seconds; matches the banner's die-roll animation in client.js

  // ---------- Pure trigger derivation (unit-tested in Node) ----------
  // Returns [{ name, delay? }] for what changed between two snapshots from mySide's point of view.
  function derive(prev, curr, mySide) {
    const out = [];
    if (!curr) return out;
    const myTeam = mySide >= 0 && curr.players[mySide] ? curr.players[mySide].team : -1;
    for (const l of curr.log || []) {
      if (l.kind === 'event') { out.push({ name: 'dice' }); out.push({ name: 'sting_' + l.id, delay: STING_DELAY }); }
      else if (l.kind === 'nest') out.push({ name: 'nestDestroyed' });
      else if (l.kind === 'ability') out.push({ name: 'abil_' + l.id }); // ant16 abilities, anyone's: the enemy hears them too
      else if (l.kind === 'volley-hit') out.push({ name: 'volleyHit' });
      else if (l.kind === 'win') out.push({ name: myTeam < 0 || l.team === myTeam ? 'victory' : 'defeat', delay: 0.6 });
    }
    if (!prev || prev.players.length !== curr.players.length) return out;
    // Spawns: only your own colony, so teammates/enemies don't spam you.
    if (mySide >= 0) {
      const had = new Set(prev.ants.map(a => a[0]));
      let w = 0, s = 0;
      for (const a of curr.ants) if (a[1] === mySide && !had.has(a[0])) a[2] ? s++ : w++;
      if (s) out.push({ name: 'spawnSoldier' });
      else if (w) out.push({ name: 'spawnWorker' });
      const pr = prev.players[mySide].rally, cr = curr.players[mySide].rally;
      if (pr && cr && (pr.x !== cr.x || pr.y !== cr.y)) out.push({ name: 'rally' });
    }
    // Deaths (any colony) collapse into one soft tick per snapshot; throttled further in play().
    const alive = new Set(curr.ants.map(a => a[0]));
    const dead = curr.fog ? new Set(curr.fog.dead) : null; // ant16 fog: vanishing into the fog is not a death
    if (prev.ants.some(a => !alive.has(a[0]) && (!dead || dead.has(a[0])))) out.push({ name: 'death' });
    // spitter acid (units.js). Not once the match is over: end-of-match snapshots repeat, and the end card owns the audio.
    if (curr.shots && curr.shots.length && (curr.winner === null || curr.winner === undefined)) out.push({ name: 'spit' });
    // Nest damage: one thud per snapshot; a sharper warning if it's your own nest.
    let hit = false, mine = false;
    curr.players.forEach((p, i) => {
      const q = prev.players[i];
      if (p.alive && q.alive && p.nest.hp < q.nest.hp) { hit = true; if (i === mySide) mine = true; }
    });
    if (mine) out.push({ name: 'nestHitMine' });
    else if (hit) out.push({ name: 'nestHit' });
    return out;
  }

  // ---------- Throttle (pure, unit-tested) ----------
  function makeThrottle(gaps) {
    const last = {};
    return function allow(name, nowMs) {
      const gap = gaps[name] || 0;
      if (last[name] !== undefined && nowMs - last[name] < gap) return false;
      last[name] = nowMs;
      return true;
    };
  }

  // ---------- Muted preference ----------
  function loadMuted() { try { return root.localStorage && root.localStorage.getItem(KEY) === '1'; } catch (e) { return false; } }
  function saveMuted(v) { try { root.localStorage && root.localStorage.setItem(KEY, v ? '1' : '0'); } catch (e) { /* private mode */ } }

  // ---------- Synth ----------
  let ac = null, master = null, fxBus = null, voices = 0, ambient = null, noiseBuf = null;
  let muted = loadMuted();
  // ---------- Volume sliders (Settings): master, effects, music, footsteps; each 0..1, saved in localStorage ----------
  const VOL_KEY = 'antArenaVolumes', VOL_DEFAULT = { master: 1, fx: 1, music: 0.5, steps: 1 };
  function loadVol() {
    const v = Object.assign({}, VOL_DEFAULT);
    try { const o = JSON.parse(root.localStorage.getItem(VOL_KEY)); for (const k in v) if (o && typeof o[k] === 'number') v[k] = Math.min(1, Math.max(0, o[k])); } catch (e) { /* default */ }
    return v;
  }
  const vol = loadVol();
  // ---------- Music: the game's own song, looped (ants.ogg), started on the first gesture ----------
  const MUSIC_VOL = 0.4;
  // assets/music/<name>.ogg. Lobby: the game's own song. A match opens calm on the game's song too (OPENS; it keeps playing,
  // no restart, when the lobby already has it on), then shuffles it with the Fontbard placeholders, cuts to Swarm when the
  // first fight starts, and drifts back to calm after FIGHT_QUIET_S without one.
  const TRACKS = { lobby: ['ants'], calm: ['ants', 'dusk_colony', 'ember_dusk'], fight: ['swarm'] };
  const OPENS = { calm: 'ants' }; // the track a scene starts on when the caller names none
  const FIGHT_QUIET_S = 30, FADE_MS = 700;
  let music = null, musicErr = '', trackNow = '', scene = 'lobby', fadeK = 1, fadeTimer = null, lastFight = -1e9;
  const musicVolume = () => MUSIC_VOL * vol.music * vol.master * fadeK;
  function nextTrack() { // shuffle, never the same track twice in a row
    const list = TRACKS[scene];
    let t; do { t = list[Math.floor(Math.random() * list.length)]; } while (t === trackNow && list.length > 1);
    return t;
  }
  // first: a track name to start with (default OPENS[next]). Fades the old track out, then swaps; if that track is already
  // playing it just carries on.
  function setScene(next, first = OPENS[next]) {
    if (next === scene || !TRACKS[next]) return;
    scene = next;
    if (!music) return;
    if (first && first === trackNow && !music.paused) return;
    clearInterval(fadeTimer);
    const t0 = Date.now();
    fadeTimer = setInterval(() => {
      if (!music) { clearInterval(fadeTimer); fadeK = 1; return; } // ant67: this used to throw every 50 ms forever once the element was dropped
      const k = Math.max(0, 1 - (Date.now() - t0) / FADE_MS);
      fadeK = k; music.volume = musicVolume();
      if (k <= 0) { clearInterval(fadeTimer); fadeK = 1; playNext(first); }
    }, 50);
  }
  // ant67: play() can be refused (autoplay policy: a gesture the browser does not count, e.g. a modifier key or a touchstart)
  // or aborted (a newer load replaced it). The element is KEPT either way and the next gesture just calls play() again
  // (resumeMusic). It used to be thrown away (music = null) with a fresh Audio built next time, which orphaned a playing old one.
  function tryPlay() {
    const m = music, p = m.play();
    if (p && p.catch) p.catch(e => { musicErr = (e && e.name) || String(e); });
  }
  function playNext(first) {
    if (!music) return;
    trackNow = first || nextTrack();
    music.volume = musicVolume();
    music.src = 'assets/music/' + trackNow + '.ogg';
    tryPlay();
  }
  // Every gesture: if the element exists but is not playing (refused earlier), ask again.
  function resumeMusic() {
    if (!music) return;
    if (!music.src) playNext(); else if (music.paused) tryPlay();
  }
  // Fight detection from snapshots: any ant flashing from a hit, or a nest losing hp, counts.
  function musicFromState(prev, curr) {
    const now = root.performance ? root.performance.now() : Date.now();
    let hot = false;
    for (const a of curr.ants) if (a[8] > 0) { hot = true; break; }
    if (!hot && prev && prev.players.length === curr.players.length) hot = curr.players.some((p, i) => p.nest.hp < prev.players[i].nest.hp);
    if (hot) { lastFight = now; if (scene === 'calm') setScene('fight'); }
    else if (scene === 'fight' && now - lastFight > FIGHT_QUIET_S * 1000) setScene('calm');
  }
  function startMusic() {
    if (music) { resumeMusic(); return; }
    if (!root.Audio) return;
    try {
      music = new root.Audio();
      music.muted = muted;
      music.volume = musicVolume();
      music.addEventListener('ended', () => playNext());
      playNext();
    } catch (e) { music = null; }
  }
  function applyVol() {
    if (master && ac) master.gain.setTargetAtTime(muted ? 0 : 0.5 * vol.master, ac.currentTime, 0.02);
    if (fxBus && ac) fxBus.gain.setTargetAtTime(vol.fx, ac.currentTime, 0.02);
    if (music) music.volume = musicVolume();
  }
  function setVolume(k, v) {
    if (!(k in VOL_DEFAULT)) return;
    vol[k] = Math.min(1, Math.max(0, +v || 0));
    try { root.localStorage.setItem(VOL_KEY, JSON.stringify(vol)); } catch (e) { /* private mode */ }
    applyVol();
  }
  const allow = makeThrottle(MIN_GAP);

  function ensureCtx() {
    if (ac) return ac;
    const AC = root.AudioContext || root.webkitAudioContext;
    if (!AC) return null;
    try { ac = new AC(); } catch (e) { return null; }
    master = ac.createGain();
    master.gain.value = muted ? 0 : 0.5 * vol.master;
    master.connect(ac.destination);
    fxBus = ac.createGain();
    fxBus.gain.value = vol.fx;
    fxBus.connect(master);
    noiseBuf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return ac;
  }

  function unlock() {
    if (!ensureCtx()) return;
    if (ac.state === 'suspended') ac.resume();
    startAmbient();
    startMusic();
    if (!pool) buildPool();
    loadSamples();
  }

  // One enveloped oscillator note. f1 = optional end frequency for a pitch sweep.
  function tone(t, f0, dur, opt) {
    opt = opt || {};
    const o = ac.createOscillator(), g = ac.createGain();
    o.type = opt.type || 'sine';
    o.frequency.setValueAtTime(f0, t);
    if (opt.f1) o.frequency.exponentialRampToValueAtTime(opt.f1, t + dur);
    const v = opt.vol || 0.3;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(v, t + Math.min(0.01, dur / 4));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(fxBus);
    o.start(t); o.stop(t + dur + 0.02);
  }

  // A burst of filtered noise.
  function noise(t, dur, opt) {
    opt = opt || {};
    const s = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain();
    s.buffer = noiseBuf;
    f.type = opt.filter || 'lowpass';
    f.frequency.setValueAtTime(opt.freq || 1200, t);
    if (opt.freq1) f.frequency.exponentialRampToValueAtTime(opt.freq1, t + dur);
    const v = opt.vol || 0.3;
    g.gain.setValueAtTime(v, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f); f.connect(g); g.connect(fxBus);
    s.start(t, Math.random() * 0.5); s.stop(t + dur + 0.02);
  }

  const notes = (t, list, step, opt) => list.forEach((f, i) => tone(t + i * step, f, step * 1.6, opt));

  const SFX = {
    spawnWorker: t => tone(t, 660, 0.08, { type: 'triangle', f1: 990, vol: 0.18 }),
    spawnSoldier: t => { tone(t, 220, 0.14, { type: 'square', f1: 330, vol: 0.1 }); tone(t + 0.05, 440, 0.1, { type: 'triangle', vol: 0.12 }); },
    rally: t => { tone(t, 1400, 0.03, { type: 'square', vol: 0.06 }); noise(t, 0.03, { filter: 'highpass', freq: 3000, vol: 0.1 }); },
    spit: t => { noise(t, 0.06, { filter: 'bandpass', freq: 2600, vol: 0.07 }); tone(t, 520, 0.07, { type: 'sine', f1: 880, vol: 0.05 }); },
    death: t => noise(t, 0.05, { filter: 'bandpass', freq: 1800 + Math.random() * 800, vol: 0.06 }),
    nestHit: t => { tone(t, 110, 0.18, { f1: 55, vol: 0.28 }); noise(t, 0.08, { freq: 500, vol: 0.12 }); },
    nestHitMine: t => { tone(t, 140, 0.2, { type: 'triangle', f1: 60, vol: 0.32 }); tone(t + 0.02, 520, 0.12, { type: 'square', f1: 380, vol: 0.06 }); },
    nestDestroyed: t => { tone(t, 90, 1.2, { f1: 28, vol: 0.5 }); noise(t, 1.3, { freq: 1600, freq1: 80, vol: 0.45 }); },
    dice: t => { for (let i = 0; i < 7; i++) noise(t + i * 0.09 + Math.random() * 0.03, 0.04, { filter: 'bandpass', freq: 2200 + Math.random() * 1500, vol: 0.22 }); tone(t + 0.68, 300, 0.06, { type: 'triangle', vol: 0.15 }); },
    sting_rain: t => { notes(t, [523, 440, 349], 0.12, { type: 'triangle', vol: 0.15 }); noise(t, 1.2, { freq: 3000, freq1: 1500, vol: 0.08 }); },
    sting_bloom: t => notes(t, [523, 659, 784, 1047], 0.08, { type: 'triangle', vol: 0.15 }),
    sting_anteater: t => { tone(t, 98, 0.5, { type: 'sawtooth', f1: 73, vol: 0.12 }); tone(t + 0.25, 92, 0.6, { type: 'sawtooth', f1: 65, vol: 0.12 }); },
    sting_crumb: t => notes(t, [784, 988, 1175], 0.07, { type: 'sine', vol: 0.18 }),
    sting_frenzy: t => notes(t, [330, 392, 330, 392, 494], 0.06, { type: 'square', vol: 0.07 }),
    sting_quake: t => { tone(t, 60, 1.0, { type: 'sawtooth', f1: 35, vol: 0.25 }); noise(t, 1.1, { freq: 300, vol: 0.35 }); },
    sting_beetle: t => { notes(t, [147, 139, 131], 0.18, { type: 'square', vol: 0.1 }); noise(t + 0.1, 0.5, { freq: 500, vol: 0.15 }); },
    sting_flood: t => { noise(t, 1.4, { freq: 900, freq1: 400, vol: 0.18 }); notes(t, [392, 330, 262], 0.14, { type: 'sine', vol: 0.1 }); },
    sting_harvest: t => notes(t, [392, 494, 587, 784], 0.09, { type: 'triangle', vol: 0.16 }),
    sting_swap: t => notes(t, [659, 523, 659, 523], 0.07, { type: 'square', vol: 0.07 }),
    // ant16 abilities
    abil_trail: t => notes(t, [880, 1175, 1568], 0.05, { type: 'sine', vol: 0.08 }),
    abil_alarm: t => { notes(t, [740, 988, 740, 988], 0.05, { type: 'square', vol: 0.07 }); noise(t, 0.12, { filter: 'highpass', freq: 2500, vol: 0.08 }); },
    abil_volley: t => { for (let i = 0; i < 4; i++) noise(t + i * 0.05, 0.08, { filter: 'bandpass', freq: 2000 + i * 300, vol: 0.09 }); tone(t, 300, 0.3, { f1: 900, vol: 0.06 }); },
    volleyHit: t => { noise(t, 0.35, { freq: 2400, freq1: 300, vol: 0.25 }); tone(t, 180, 0.25, { type: 'triangle', f1: 70, vol: 0.18 }); },
    abil_call: t => { tone(t, 392, 0.5, { type: 'triangle', vol: 0.14 }); tone(t + 0.18, 523, 0.7, { type: 'triangle', vol: 0.14 }); tone(t + 0.18, 659, 0.7, { type: 'sine', vol: 0.08 }); },
    underAttack: t => { notes(t, [660, 495, 660, 495], 0.09, { type: 'square', vol: 0.09 }); noise(t, 0.1, { filter: 'highpass', freq: 2800, vol: 0.08 }); }, // alerts.js (B5), not snapshot-derived
    victory: t => { notes(t, [523, 659, 784], 0.12, { type: 'triangle', vol: 0.2 }); tone(t + 0.36, 1047, 0.7, { type: 'triangle', vol: 0.2 }); tone(t + 0.36, 784, 0.7, { type: 'sine', vol: 0.12 }); },
    defeat: t => { notes(t, [392, 370, 349], 0.2, { type: 'triangle', vol: 0.18 }); tone(t + 0.6, 262, 0.9, { type: 'triangle', f1: 247, vol: 0.18 }); },
  };

  // ---------- Sampled impacts (ant18/audio) ----------
  const SFX_BASE = 'assets/sfx/';
  const HIT_STOP_MS = 30; // render-side hold on a strike (decided); feel-anim reads Sound.HIT_STOP_MS
  const FAMILY_GAP_MS = 60; // one impact per cue family per 60 ms
  const GROUP_GAP_MS = 40; // and never under 40 ms from the previous sample of the same group
  const PITCH_JITTER = 0.06; // +/- 6% playback rate
  const IMPACT = SFX_BASE + 'kenney-impact/', SCIFI = SFX_BASE + 'kenney-scifi/';
  const range = (dir, base, n) => Array.from({ length: n }, (_, i) => dir + base + '_00' + i + '.ogg');
  // files are the round-robin variants. tilt: 'bright' (acid), 'mid' (bites), 'low' (nests): a 3-band tilt via one biquad.
  const FAMILIES = {
    biteSoldier: { files: range(IMPACT, 'impactPunch_medium', 5), vol: 0.5, tilt: 'mid', group: 'bite' },
    biteWorker: { files: range(IMPACT, 'impactSoft_medium', 5), vol: 0.4, tilt: 'mid', group: 'bite' },
    biteMajor: { files: range(IMPACT, 'impactPlate_heavy', 3), vol: 0.55, tilt: 'mid', group: 'bite' },
    acid: { files: range(IMPACT, 'impactSoft_heavy', 3).concat([SCIFI + 'slime_000.ogg']), vol: 0.4, tilt: 'bright', group: 'acid' },
    chip: { files: range(IMPACT, 'impactGlass_light', 3), vol: 0.3, tilt: 'bright', group: 'chip' },
    structure: { files: range(IMPACT, 'impactMining', 3), vol: 0.45, tilt: 'mid', group: 'structure' },
    nestHit: { files: range(IMPACT, 'impactPlank_medium', 3), vol: 0.5, tilt: 'low', group: 'nest' },
    nestCollapse: { files: range(SCIFI, 'lowFrequency_explosion', 2), vol: 0.6, tilt: 'low', group: 'nest' },
    research: { files: range(IMPACT, 'impactBell_heavy', 2), vol: 0.14, tilt: 'mid', group: 'ui' },
    alarm: { files: range(SCIFI, 'forceField', 2), vol: 0.3, tilt: 'bright', group: 'ability' },
    volley: { files: range(SCIFI, 'laserRetro', 3), vol: 0.22, rate: 0.7, tilt: 'bright', group: 'ability' },
    step: { files: range(IMPACT, 'footstep_grass', 3), vol: 0.12, tilt: 'low', group: 'step', closeOnly: true, chance: 1 / 12 },
  };
  // Strike kinds feel-anim passes; each fires one or two families.
  const STRIKES = {
    soldier: ['biteSoldier'], worker: ['biteWorker'], major: ['biteMajor'], nurse: ['biteWorker'], alate: ['biteWorker'],
    spitter: ['acid'], acid: ['acid'], death: ['chip'], structure: ['structure'], nest: ['nestHit'], collapse: ['nestHit', 'nestCollapse'],
  };
  // Existing snapshot-derived cues that gain a sample. replace: the synth is skipped when the sample played (synth is the fallback).
  const CUE_SAMPLES = {
    death: { family: 'chip', replace: true }, nestHit: { family: 'nestHit', replace: true }, nestHitMine: { family: 'nestHit' },
    nestDestroyed: { family: 'nestCollapse' }, spit: { family: 'acid', vol: 0.5 }, abil_alarm: { family: 'alarm', replace: true },
    abil_volley: { family: 'volley', replace: true }, underAttack: { family: 'alarm', vol: 0.8 }, volleyHit: { family: 'nestCollapse', vol: 0.5 },
  };
  const FAMILY_NAMES = Object.keys(FAMILIES);
  const familyAllow = makeThrottle(Object.fromEntries(FAMILY_NAMES.map(f => [f, FAMILY_GAP_MS])));
  const groupAllow = makeThrottle({ bite: GROUP_GAP_MS, acid: GROUP_GAP_MS, chip: GROUP_GAP_MS, structure: GROUP_GAP_MS, nest: GROUP_GAP_MS, ability: GROUP_GAP_MS, step: 120, ui: 200 });

  // Pure helpers (unit-tested in Node). z = camera zoom (1 = default).
  // Far zoom is quieter, close zoom a touch louder.
  function zoomGain(z) { z = z > 0 ? z : 1; return Math.max(0.25, Math.min(1.15, 0.25 + 0.75 * Math.pow(z, 0.8))); }
  // Low-pass cutoff in Hz: wide open when close, muffled when zoomed out.
  function zoomCutoff(z) { z = z > 0 ? z : 1; return Math.max(1200, Math.min(18000, 1200 + 16800 * Math.max(0, (z - 0.45) / 0.9))); }
  function jitter(rng, rate) { return (rate || 1) * (1 + (rng() * 2 - 1) * PITCH_JITTER); }
  const rrIndex = {};
  function nextVariant(name, n) { const k = rrIndex[name] === undefined ? Math.floor(Math.random() * n) : (rrIndex[name] + 1) % n; rrIndex[name] = k; return k; }
  const TILT = { bright: ['highshelf', 3200, 4], mid: ['peaking', 1200, 3], low: ['lowshelf', 300, 5] };

  const buffers = {}; // url -> AudioBuffer
  let loading = false, ready = false, pool = null;
  // Pooled voices: SAMPLE_VOICES gain -> lowpass -> tilt chains built once and reused; only the BufferSource is per play.
  function buildPool() {
    pool = [];
    for (let i = 0; i < SAMPLE_VOICES; i++) {
      const g = ac.createGain(), lp = ac.createBiquadFilter(), tilt = ac.createBiquadFilter();
      lp.type = 'lowpass'; lp.connect(tilt); tilt.connect(g); g.connect(fxBus);
      pool.push({ g, lp, tilt, busy: false });
    }
  }
  // Preloaded after the first gesture (the context only exists then). A missing file just leaves that variant out.
  function loadSamples() {
    if (loading || !ac || !root.fetch) return;
    loading = true;
    const urls = [].concat(...FAMILY_NAMES.map(f => FAMILIES[f].files));
    let left = urls.length;
    const done = () => { if (--left <= 0) ready = true; };
    for (const u of urls) {
      root.fetch(u).then(r => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(u))))
        .then(b => new Promise((ok, no) => ac.decodeAudioData(b, ok, no)))
        .then(buf => { buffers[u] = buf; done(); }, done);
    }
  }
  const zoomNow = () => { try { return root.Camera && root.Camera.zoom ? root.Camera.zoom() : 1; } catch (e) { return 1; } };
  const reducedNow = () => { try { return !!(root.Settings && root.Settings.reduced && root.Settings.reduced()); } catch (e) { return false; } };

  // Play one sampled impact. family: a FAMILIES key. x, y (world) are part of the call contract (reserved for panning);
  // opts: { vol, delay, zoom }. Respects mute (and the master gain), Reduced motion for footsteps, and the voice pool.
  function impact(family, x, y, opts) {
    const F = FAMILIES[family];
    if (!F || muted || !ac || !pool || ac.state !== 'running' || !ready) return false;
    opts = opts || {};
    const z = opts.zoom !== undefined ? opts.zoom : zoomNow();
    if (F.closeOnly && (z < 1.5 || reducedNow() || Math.random() > (F.chance || 1))) return false;
    const have = F.files.filter(u => buffers[u]);
    if (!have.length) return false;
    const now = root.performance ? root.performance.now() : Date.now();
    if (!familyAllow(family, now) || !groupAllow(F.group, now)) return false;
    const v = pool.find(p => !p.busy);
    if (!v) return false;
    const src = ac.createBufferSource();
    src.buffer = buffers[have[nextVariant(family, have.length)]];
    src.playbackRate.value = jitter(Math.random, F.rate);
    const t = ac.currentTime + (opts.delay || 0);
    v.lp.frequency.setValueAtTime(zoomCutoff(z), t);
    const tl = TILT[F.tilt] || TILT.mid;
    v.tilt.type = tl[0]; v.tilt.frequency.setValueAtTime(tl[1], t); v.tilt.gain.setValueAtTime(tl[2], t);
    v.g.gain.setValueAtTime((F.vol || 0.4) * (opts.vol || 1) * zoomGain(z) * (family === 'step' ? vol.steps : 1), t);
    src.connect(v.lp);
    v.busy = true;
    src.onended = () => { v.busy = false; try { src.disconnect(); } catch (e) { /* gone */ } };
    try { src.start(t); } catch (e) { v.busy = false; return false; }
    return true;
  }

  // Strike-frame hook: feel-anim calls this on the strike frame, the same moment it starts the HIT_STOP_MS hold.
  // kind: 'soldier' | 'worker' | 'major' | 'nurse' | 'alate' | 'spitter' | 'acid' | 'death' | 'structure' | 'nest' | 'collapse'.
  function strike(kind, x, y, opts) {
    const fams = STRIKES[kind];
    let any = false;
    if (fams) for (const f of fams) any = impact(f, x, y, opts) || any;
    return any;
  }
  // For feel-anim to call per ant footstep: plays only at close zoom, 1 in 12, never under Reduced motion.
  const footstep = (x, y) => impact('step', x, y);

  function play(name, delay) {
    if (muted || !ac || ac.state !== 'running' || !SFX[name]) return false;
    if (!allow(name, root.performance ? root.performance.now() : Date.now())) return false;
    const cs = CUE_SAMPLES[name];
    if (cs && ready && impact(cs.family, 0, 0, { vol: cs.vol, delay }) && cs.replace) return true;
    if (voices >= MAX_VOICES) return false;
    voices++;
    setTimeout(() => { voices--; }, ((delay || 0) + 1.5) * 1000);
    try { SFX[name](ac.currentTime + (delay || 0)); } catch (e) { /* never break the game over audio */ }
    return true;
  }

  // Soft ambient: very quiet low-passed noise "wind" plus a slow two-note drone.
  function startAmbient() {
    if (ambient || !ac) return;
    const s = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain();
    s.buffer = noiseBuf; s.loop = true;
    f.type = 'lowpass'; f.frequency.value = 400;
    g.gain.value = 0.025;
    const lfo = ac.createOscillator(), lg = ac.createGain();
    lfo.frequency.value = 0.08; lg.gain.value = 0.015;
    lfo.connect(lg); lg.connect(g.gain);
    s.connect(f); f.connect(g); g.connect(fxBus);
    s.start(); lfo.start();
    ambient = s;
  }

  function onState(prev, curr, mySide) {
    if (!ac) return;
    for (const e of derive(prev, curr, mySide)) play(e.name, e.delay);
    if (curr && curr.ants && curr.winner === null) musicFromState(prev, curr);
  }

  function setMuted(v) {
    muted = !!v; saveMuted(muted);
    if (music) music.muted = muted;
    if (master) master.gain.setTargetAtTime(muted ? 0 : 0.5 * vol.master, ac.currentTime, 0.02);
    if (btn) { btn.textContent = muted ? '🔇' : '🔊'; btn.dataset.tip = (muted ? 'Unmute' : 'Mute') + ' sound [,]'; }
  }
  const toggle = () => { unlock(); setMuted(!muted); };

  // ---------- DOM: unlock on first gesture, ',' key (ant16: M went to Build), speaker button ----------
  let btn = null;
  if (root.document && root.addEventListener) {
    // ant67: click/pointerup/keyup/touchend too: those are the gestures browsers always count for autoplay (a touchstart or a lone Shift never is)
    for (const ev of ['pointerdown', 'pointerup', 'click', 'keydown', 'keyup', 'touchstart', 'touchend']) root.addEventListener(ev, unlock, { capture: true, passive: true });
    root.addEventListener('keydown', e => {
      if (e.target && e.target.tagName === 'INPUT') return;
      if (Keys.is(e, 'sound.mute')) toggle();
    });
    const mount = () => {
      btn = root.document.createElement('button');
      btn.id = 'mute';
      btn.style.cssText = 'position:fixed;top:10px;right:10px;z-index:20;cursor:pointer'; // look: theme.css
      btn.onclick = e => { e.stopPropagation(); toggle(); btn.blur(); };
      root.document.body.appendChild(btn);
      setMuted(muted);
    };
    if (root.document.body) mount(); else root.addEventListener('DOMContentLoaded', mount);
  }

  const api = { play, onState, derive, makeThrottle, toggle, setMuted, isMuted: () => muted, setScene, musicState: () => music ? { src: music.src, paused: music.paused, volume: music.volume, muted: music.muted, scene, track: trackNow, err: musicErr } : null, setVolume, volume: k => vol[k], unlock, impact, strike, footstep, samplesReady: () => ready, HIT_STOP_MS, FAMILIES, STRIKES, CUE_SAMPLES, zoomGain, zoomCutoff, jitter, SAMPLE_VOICES, SFX_NAMES: Object.keys(SFX), MIN_GAP };
  root.Sound = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
