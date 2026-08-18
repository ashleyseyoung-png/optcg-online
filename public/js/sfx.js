// Sound effects — synthesized on the fly with WebAudio, so there are no audio files
// to load. Everything is deliberately quiet, short and rounded (soft sines, filtered
// noise, gentle envelopes) so it stays pleasant over a long session. Muted state is
// remembered in localStorage. Nothing plays until the user has interacted with the
// page (browser autoplay rules) — the first click/keypress unlocks the context.
(function () {
  const SFX = {
    ctx: null,
    master: null,
    muted: (function () { try { return localStorage.getItem('gl_sfx_muted') === '1'; } catch (e) { return false; } })(),
    volume: 0.5,
    _last: {},
    _noiseBuf: null,
  };

  function ensure() {
    if (SFX.ctx) { if (SFX.ctx.state === 'suspended') SFX.ctx.resume().catch(() => {}); return true; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    SFX.ctx = new AC();
    SFX.master = SFX.ctx.createGain();
    SFX.master.gain.value = SFX.muted ? 0 : SFX.volume;
    // a touch of gentle low-pass on everything keeps it soft
    const lp = SFX.ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 6500;
    SFX.master.connect(lp); lp.connect(SFX.ctx.destination);
    return true;
  }
  function now() { return SFX.ctx.currentTime; }
  function noiseBuffer() {
    if (SFX._noiseBuf) return SFX._noiseBuf;
    const len = SFX.ctx.sampleRate * 1.0;
    const buf = SFX.ctx.createBuffer(1, len, SFX.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    SFX._noiseBuf = buf;
    return buf;
  }
  // gain envelope helper: attack → peak → exponential decay to ~0 at t0+dur
  function env(node, t0, peak, attack, dur) {
    const g = node.gain;
    g.cancelScheduledValues(t0);
    g.setValueAtTime(0.0001, t0);
    g.linearRampToValueAtTime(peak, t0 + attack);
    g.exponentialRampToValueAtTime(0.0001, t0 + dur);
  }
  function tone({ freq, type = 'sine', dur = 0.15, peak = 0.2, attack = 0.005, at = 0, glide = null, detune = 0 }) {
    const t0 = now() + at;
    const o = SFX.ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(freq, t0); o.detune.value = detune;
    if (glide) o.frequency.exponentialRampToValueAtTime(glide, t0 + dur);
    const g = SFX.ctx.createGain(); env(g, t0, peak, attack, dur);
    o.connect(g); g.connect(SFX.master);
    o.start(t0); o.stop(t0 + dur + 0.05);
  }
  function noise({ dur = 0.08, peak = 0.12, attack = 0.003, at = 0, band = null, q = 1, sweepTo = null, hp = null }) {
    const t0 = now() + at;
    const src = SFX.ctx.createBufferSource(); src.buffer = noiseBuffer();
    let node = src;
    if (band) {
      const f = SFX.ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.setValueAtTime(band, t0); f.Q.value = q;
      if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t0 + dur);
      node.connect(f); node = f;
    }
    if (hp) { const f = SFX.ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = hp; node.connect(f); node = f; }
    const g = SFX.ctx.createGain(); env(g, t0, peak, attack, dur);
    node.connect(g); g.connect(SFX.master);
    src.start(t0); src.stop(t0 + dur + 0.05);
  }
  // marimba-ish note: sine + quiet 3rd harmonic, quick decay
  function pluck(freq, { dur = 0.35, peak = 0.16, at = 0 } = {}) {
    tone({ freq, dur, peak, at, attack: 0.004 });
    tone({ freq: freq * 3, dur: dur * 0.5, peak: peak * 0.18, at, attack: 0.002 });
  }

  // Throttle so rapid repeats (hover sweeps, log spam) don't stack.
  function throttled(name, ms) {
    const t = performance.now();
    if (SFX._last[name] && t - SFX._last[name] < ms) return false;
    SFX._last[name] = t;
    return true;
  }

  const LIB = {
    // UI
    click:   () => { noise({ dur: 0.045, peak: 0.08, band: 2400, q: 1.2 }); tone({ freq: 1500, dur: 0.05, peak: 0.05, type: 'sine' }); },
    tap:     () => { noise({ dur: 0.03, peak: 0.05, band: 3200, q: 1.5 }); },                       // hover over a card
    toggle:  () => { tone({ freq: 880, dur: 0.08, peak: 0.07 }); tone({ freq: 1320, dur: 0.1, peak: 0.05, at: 0.06 }); },
    error:   () => { tone({ freq: 220, type: 'triangle', dur: 0.14, peak: 0.08 }); tone({ freq: 196, type: 'triangle', dur: 0.16, peak: 0.07, at: 0.1 }); },
    open:    () => { noise({ dur: 0.18, peak: 0.06, band: 900, sweepTo: 2600, q: 0.8 }); },
    close:   () => { noise({ dur: 0.16, peak: 0.05, band: 2400, sweepTo: 700, q: 0.8 }); },
    // cards
    place:   () => { tone({ freq: 190, dur: 0.14, peak: 0.16, type: 'sine', glide: 120 }); noise({ dur: 0.05, peak: 0.07, band: 1800, q: 1 }); }, // card set on the table
    pick:    () => { noise({ dur: 0.07, peak: 0.07, band: 1600, sweepTo: 3200, q: 1 }); },      // card lifted / drag start
    draw:    () => { noise({ dur: 0.16, peak: 0.09, band: 1200, sweepTo: 3600, q: 0.9 }); },   // whoosh
    flip:    () => { noise({ dur: 0.05, peak: 0.07, band: 2600, q: 1.4 }); tone({ freq: 700, dur: 0.06, peak: 0.04 }); },
    shuffle: () => { for (let i = 0; i < 7; i++) noise({ dur: 0.045, peak: 0.06, band: 1500 + Math.random() * 1500, q: 1.3, at: i * 0.055 + Math.random() * 0.01 }); },
    trash:   () => { noise({ dur: 0.12, peak: 0.07, band: 900, sweepTo: 300, q: 0.9 }); },
    // game events
    don:     () => { pluck(660, { peak: 0.12 }); },                                              // DON!! attached
    donGain: () => { pluck(523, { peak: 0.1 }); pluck(659, { peak: 0.09, at: 0.09 }); },
    attack:  () => { noise({ dur: 0.2, peak: 0.12, band: 600, sweepTo: 2200, q: 0.8 }); tone({ freq: 90, dur: 0.16, peak: 0.16, at: 0.16, glide: 55 }); },
    hit:     () => { tone({ freq: 70, dur: 0.22, peak: 0.22, glide: 40 }); noise({ dur: 0.1, peak: 0.1, band: 400, q: 0.7 }); },
    block:   () => { tone({ freq: 330, type: 'triangle', dur: 0.12, peak: 0.1 }); noise({ dur: 0.06, peak: 0.06, band: 1200 }); },
    counter: () => { pluck(784, { peak: 0.1 }); pluck(988, { peak: 0.08, at: 0.07 }); },
    miss:    () => { noise({ dur: 0.14, peak: 0.06, band: 1400, sweepTo: 500, q: 1 }); },
    trigger: () => { pluck(880, { peak: 0.1 }); pluck(1175, { peak: 0.09, at: 0.08 }); pluck(1480, { peak: 0.08, at: 0.16 }); },
    turn:    () => { pluck(523, { peak: 0.11, dur: 0.4 }); pluck(659, { peak: 0.1, dur: 0.45, at: 0.12 }); },
    oppTurn: () => { pluck(440, { peak: 0.08, dur: 0.35 }); },
    prompt:  () => { pluck(740, { peak: 0.08, dur: 0.25 }); },
    win:     () => { [523, 659, 784, 1047].forEach((f, i) => pluck(f, { peak: 0.14, dur: 0.6, at: i * 0.12 })); },
    lose:    () => { pluck(392, { peak: 0.12, dur: 0.6 }); pluck(311, { peak: 0.11, dur: 0.8, at: 0.2 }); },
    chat:    () => { pluck(1047, { peak: 0.06, dur: 0.2 }); },
  };
  const THROTTLE = { tap: 70, click: 40, place: 60, draw: 90, don: 80, hit: 120, attack: 150 };

  function play(name) {
    if (SFX.muted) return;
    if (!ensure()) return;
    if (SFX.ctx.state !== 'running') return; // not unlocked yet
    if (THROTTLE[name] && !throttled(name, THROTTLE[name])) return;
    const fn = LIB[name];
    if (fn) { try { fn(); } catch (e) { /* never let audio break the UI */ } }
  }
  function setMuted(m) {
    SFX.muted = !!m;
    try { localStorage.setItem('gl_sfx_muted', SFX.muted ? '1' : '0'); } catch (e) {}
    if (SFX.master) SFX.master.gain.value = SFX.muted ? 0 : SFX.volume;
    document.querySelectorAll('[data-sfx-toggle]').forEach((b) => { b.textContent = SFX.muted ? '🔇' : '🔊'; b.title = SFX.muted ? 'Sounds off — click to unmute' : 'Sounds on — click to mute'; });
  }
  function toggle() { setMuted(!SFX.muted); if (!SFX.muted) play('toggle'); }

  // Unlock on the first user gesture (browsers block audio before that).
  const unlock = () => { if (ensure() && SFX.ctx.state === 'suspended') SFX.ctx.resume().catch(() => {}); };
  ['pointerdown', 'keydown', 'touchstart'].forEach((ev) => document.addEventListener(ev, unlock, { passive: true }));

  // Site-wide default hooks: buttons click, cards tap on hover, sound-toggle buttons.
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-sfx-toggle]');
    if (t) { toggle(); return; }
    if (e.target.closest('button, .btn, .pill, .icon-btn, a.btn, a.pill, .side-tab, .learn-toc a, .topnav nav a')) play('click');
  });
  let lastHoverEl = null;
  document.addEventListener('mouseover', (e) => {
    const el = e.target.closest('.mini-card, .hand-card, .card[data-card-id], .don.can-act');
    if (el && el !== lastHoverEl) play('tap');
    lastHoverEl = el;
  });
  document.addEventListener('DOMContentLoaded', () => setMuted(SFX.muted));

  window.SFX = { play, toggle, setMuted, get muted() { return SFX.muted; } };
})();
