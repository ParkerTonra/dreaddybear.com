// Settings (ant18/ui): a gear button with a small panel. Today it holds one setting, Reduced motion.
//   Settings.reduced()        true when motion effects are off (no screen shake, no flashing / pulsing)
//   Settings.setReduced(v)    set + persist (localStorage, in try/catch); also sets <html data-motion="reduced|full">
//   Settings.resolve(stored, osPrefers)   pure: stored '1' / '0' wins, otherwise the OS prefers-reduced-motion value
// Also defines globalThis.motionSin(x): Math.sin normally, a steady 0 when reduced, so every pulse in the
// renderer/minimap calls it instead of Math.sin and goes still with one switch.
(function (root) {
  const KEY = 'antArenaReducedMotion';
  const resolve = (stored, osPrefers) => (stored === '1' ? true : stored === '0' ? false : !!osPrefers);
  const api = { resolve, KEY };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

  const doc = root.document;
  if (!doc) return; // node tests only need resolve()
  root.Settings = api;
  const read = () => { try { return root.localStorage ? root.localStorage.getItem(KEY) : null; } catch (e) { return null; } };
  const write = v => { try { root.localStorage && root.localStorage.setItem(KEY, v ? '1' : '0'); } catch (e) { /* private mode */ } };
  let os = false;
  try { os = !!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { /* no matchMedia */ }
  let reduced = resolve(read(), os);

  api.reduced = () => reduced;
  root.motionSin = x => (reduced ? 0 : Math.sin(x));
  const apply = () => { if (doc.documentElement) doc.documentElement.dataset.motion = reduced ? 'reduced' : 'full'; };
  api.setReduced = v => { reduced = !!v; write(reduced); apply(); const cb = doc.getElementById('set-motion'); if (cb) cb.checked = reduced; };
  apply();

  const mount = () => {
    const btn = doc.createElement('button');
    btn.id = 'settings-btn'; btn.textContent = '⚙'; btn.setAttribute('aria-label', 'Settings');
    btn.dataset.tip = 'Settings: Reduced motion (no screen shake, no flashing or pulsing).';
    const pop = doc.createElement('div');
    pop.id = 'settings'; pop.className = 'hidden';
    pop.innerHTML = '<h3>Settings</h3><label><input type="checkbox" id="set-motion"> <span>Reduced motion</span></label>' +
      '<small>No screen shake, no flashing or pulsing. Starts from your system setting.</small>' +
      '<h3 class="set-sub">Volume</h3>' + [['master', 'Master'], ['fx', 'Effects'], ['music', 'Music'], ['steps', 'Footsteps']].map(([k, n]) =>
        '<label class="vol"><span>' + n + '</span><input type="range" min="0" max="100" data-vol="' + k + '"></label>').join('');
    doc.body.append(btn, pop);
    const cb = pop.querySelector('#set-motion');
    cb.checked = reduced;
    cb.addEventListener('change', () => api.setReduced(cb.checked));
    pop.querySelectorAll('[data-vol]').forEach(r => {
      const k = r.dataset.vol;
      r.value = Math.round(((root.Sound && root.Sound.volume(k)) !== undefined ? root.Sound.volume(k) : 1) * 100);
      r.addEventListener('input', () => root.Sound && root.Sound.setVolume(k, r.value / 100));
    });
    btn.onclick = e => { e.stopPropagation(); btn.blur(); pop.classList.toggle('hidden'); };
    pop.addEventListener('pointerdown', e => e.stopPropagation());
    root.addEventListener('keydown', e => { if (root.Keys && root.Keys.is(e, 'cancel')) pop.classList.add('hidden'); });
    doc.addEventListener('pointerdown', e => { if (!pop.contains(e.target) && e.target !== btn) pop.classList.add('hidden'); });
  };
  if (doc.body) mount(); else root.addEventListener('DOMContentLoaded', mount);
})(typeof window !== 'undefined' ? window : globalThis);
