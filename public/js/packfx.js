// Pack-ripping sound design — synthesized live (WebAudio), volume follows the SFX setting.
// tear → cards slide → per-card flips that scale with rarity → a riser/drumroll that builds
// before the last card → fanfares for hits. All original, nothing sampled.
(function () {
  const P = { ctx: null, master: null, noiseBuf: null };
  const vol = () => (window.Settings ? Settings.get('sfxVolume') / 100 : 0.55);
  function ensure() {
    if (P.ctx) { if (P.ctx.state === 'suspended') P.ctx.resume().catch(() => {}); return P.ctx.state !== 'closed'; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    P.ctx = new AC();
    P.master = P.ctx.createGain();
    P.master.gain.value = vol();
    const comp = P.ctx.createDynamicsCompressor(); comp.threshold.value = -14; comp.ratio.value = 5;
    P.master.connect(comp); comp.connect(P.ctx.destination);
    return true;
  }
  if (window.Settings) Settings.onChange((k, v) => { if (k === 'sfxVolume' && P.master) P.master.gain.value = v / 100; });
  const now = () => P.ctx.currentTime;
  const muted = () => (window.SFX && SFX.muted) || vol() <= 0;
  function noise() {
    if (P.noiseBuf) return P.noiseBuf;
    const b = P.ctx.createBuffer(1, P.ctx.sampleRate * 1.5, P.ctx.sampleRate), d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    P.noiseBuf = b; return b;
  }
  function tone({ f, type = 'sine', at = 0, dur = 0.3, peak = 0.15, a = 0.01, glide = null, det = 0 }) {
    const t = now() + at, o = P.ctx.createOscillator(), g = P.ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(f, t); if (glide) o.frequency.exponentialRampToValueAtTime(glide, t + dur); o.detune.value = det;
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + a); g.gain.exponentialRampToValueAtTime(0.0005, t + dur);
    o.connect(g); g.connect(P.master); o.start(t); o.stop(t + dur + 0.05);
  }
  function nz({ at = 0, dur = 0.2, peak = 0.12, type = 'bandpass', f = 1200, q = 1, sweep = null, a = 0.005 }) {
    const t = now() + at, s = P.ctx.createBufferSource(), fl = P.ctx.createBiquadFilter(), g = P.ctx.createGain();
    s.buffer = noise(); fl.type = type; fl.frequency.setValueAtTime(f, t); if (sweep) fl.frequency.exponentialRampToValueAtTime(sweep, t + dur); fl.Q.value = q;
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + a); g.gain.exponentialRampToValueAtTime(0.0005, t + dur);
    s.connect(fl); fl.connect(g); g.connect(P.master); s.start(t); s.stop(t + dur + 0.05);
  }
  const N = (m) => 440 * Math.pow(2, (m - 69) / 12);

  const FX = {
    // ripping the foil open: crinkle + tear sweep
    tear() { nz({ dur: 0.08, peak: 0.08, f: 3000, q: 0.6 }); nz({ at: 0.06, dur: 0.35, peak: 0.16, f: 700, sweep: 4200, q: 0.9 }); nz({ at: 0.32, dur: 0.12, peak: 0.07, f: 5000, type: 'highpass' }); },
    // pack shake before the rip
    shake() { nz({ dur: 0.06, peak: 0.05, f: 2500 }); nz({ at: 0.09, dur: 0.06, peak: 0.05, f: 2200 }); },
    // cards sliding out
    slide() { nz({ dur: 0.22, peak: 0.06, f: 900, sweep: 300, q: 0.7 }); },
    // flip by tier
    flip(tier) {
      nz({ dur: 0.05, peak: 0.05, f: 2600 }); // the flick of the card
      switch (tier) {
        case 'C': tone({ f: N(72), dur: 0.12, peak: 0.05 }); break;
        case 'UC': tone({ f: N(76), dur: 0.14, peak: 0.06 }); tone({ f: N(83), at: 0.07, dur: 0.18, peak: 0.06 }); break;
        case 'R': [79, 83, 86].forEach((m, i) => tone({ f: N(m), type: 'triangle', at: i * 0.06, dur: 0.35, peak: 0.07 })); break;
        case 'L': [67, 71, 74, 79].forEach((m, i) => tone({ f: N(m), type: 'triangle', at: i * 0.05, dur: 0.5, peak: 0.08 })); tone({ f: N(55), type: 'sine', dur: 0.4, peak: 0.1 }); break;
        case 'SR': FX.fanfare(1); break;
        case 'parallel': case 'sp': FX.fanfare(2); break;
        case 'tr': case 'SEC': FX.fanfare(3); break;
        case 'manga': FX.fanfare(4); break;
        default: tone({ f: N(72), dur: 0.12, peak: 0.05 });
      }
    },
    // the build-up before the last card: rising sweep + accelerating drum taps + shimmer
    riser(dur = 1.4) {
      const t0 = now();
      const o = P.ctx.createOscillator(), g = P.ctx.createGain(), fl = P.ctx.createBiquadFilter();
      o.type = 'sawtooth'; o.frequency.setValueAtTime(110, t0); o.frequency.exponentialRampToValueAtTime(660, t0 + dur);
      fl.type = 'lowpass'; fl.frequency.setValueAtTime(400, t0); fl.frequency.exponentialRampToValueAtTime(5000, t0 + dur);
      g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.09, t0 + dur * 0.8); g.gain.exponentialRampToValueAtTime(0.0005, t0 + dur + 0.05);
      o.connect(fl); fl.connect(g); g.connect(P.master); o.start(t0); o.stop(t0 + dur + 0.1);
      nz({ dur, peak: 0.07, f: 300, sweep: 6000, q: 0.5, a: dur * 0.7 });
      // drum roll: taps that speed up
      let t = 0, gap = 0.16;
      while (t < dur - 0.05) { tone({ f: 120, at: t, dur: 0.07, peak: 0.12, glide: 60 }); t += gap; gap = Math.max(0.045, gap * 0.86); }
    },
    // hit fanfares, bigger with level
    fanfare(level) {
      const base = level >= 3 ? 60 : 62; // C major-ish for the huge ones, D for the rest
      const chord = [0, 4, 7, 12];
      chord.forEach((iv, i) => tone({ f: N(base + iv), type: 'triangle', at: i * 0.03, dur: 0.9 + level * 0.25, peak: 0.09 + level * 0.015 }));
      tone({ f: N(base - 24), type: 'sine', dur: 0.8, peak: 0.16 }); // low boom
      // sparkle glissando
      const n = 6 + level * 3;
      for (let i = 0; i < n; i++) tone({ f: N(base + 24 + (i * 5) % 19), type: 'sine', at: 0.05 + i * 0.045, dur: 0.35, peak: 0.05 });
      if (level >= 2) { nz({ dur: 0.6, peak: 0.08, f: 6000, type: 'highpass' }); }
      if (level >= 3) { // fanfare motif
        [[0, 0], [5, 0.22], [7, 0.44], [12, 0.66]].forEach(([iv, at]) => [0, 4, 7].forEach((c) => tone({ f: N(base + iv + c), type: 'square', at: 0.5 + at, dur: 0.5, peak: 0.035 })));
        tone({ f: N(base - 12), type: 'sine', at: 1.16, dur: 1.4, peak: 0.14 });
      }
      if (level >= 4) { for (let i = 0; i < 12; i++) tone({ f: N(base + 36 + (i * 7) % 24), type: 'sine', at: 1.2 + i * 0.06, dur: 0.5, peak: 0.05 }); }
    },
    // small comedic "womp" when the build-up lands on a plain rare
    womp() { tone({ f: 220, type: 'triangle', dur: 0.35, peak: 0.08, glide: 150 }); tone({ f: 165, type: 'triangle', at: 0.2, dur: 0.5, peak: 0.08, glide: 110 }); },
    coin() { tone({ f: N(88), type: 'square', dur: 0.08, peak: 0.05 }); tone({ f: N(93), type: 'square', at: 0.08, dur: 0.3, peak: 0.05 }); },
  };

  function play(name, arg) {
    if (muted() || !ensure()) return;
    if (P.ctx.state !== 'running') return;
    try { FX[name](arg); } catch (e) { /* audio must never break the UI */ }
  }
  const unlock = () => { if (ensure() && P.ctx.state === 'suspended') P.ctx.resume().catch(() => {}); };
  ['pointerdown', 'keydown', 'touchstart'].forEach((ev) => document.addEventListener(ev, unlock, { passive: true }));
  window.PackFX = { play };
})();
