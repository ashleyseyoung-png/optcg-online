// Background music.
//
// Default: an ORIGINAL nautical / adventure instrumental loop synthesized live in WebAudio
// (a jaunty 6/8 sea-shanty feel — accordion-ish lead, plucked chords, soft drum) so the app
// ships no copyrighted audio. Want a real track instead? Drop a file at
//     public/audio/bgm.mp3
// and it will be used automatically (looped) — same volume/toggle settings.
//
// Respects Settings: music on/off + musicVolume. Starts on the first click/keypress
// (browsers block audio before a user gesture). Load after settings.js.
(function () {
  const S = { ctx: null, master: null, playing: false, timer: null, nextTime: 0, step: 0, audioEl: null, useFile: null, unlocked: false, fadeTimer: null };
  const enabled = () => (window.Settings ? Settings.get('music') : true);
  const volume = () => (window.Settings ? Settings.get('musicVolume') / 100 : 0.35);

  // ---------- the tune (original) ----------
  // 6/8, eighth-note grid. Two 8-bar sections (A, B). Melody: [midi note or 0=rest, length in eighths]
  const EIGHTH = 0.172;                       // ≈ 116 dotted-quarter bpm
  const A = [
    [69,1],[74,1],[78,1],[81,3],  [79,1],[78,1],[76,1],[78,3],
    [69,1],[74,1],[78,1],[81,2],[83,1],  [81,2],[78,1],[74,3],
    [71,1],[74,1],[79,1],[83,3],  [81,1],[79,1],[78,1],[76,3],
    [78,1],[79,1],[81,1],[78,1],[76,1],[74,1],  [76,2],[73,1],[74,3],
  ];
  const B = [
    [86,2],[85,1],[83,2],[81,1],  [83,2],[81,1],[78,3],
    [79,1],[81,1],[83,1],[81,1],[79,1],[78,1],  [76,3],[81,3],
    [86,2],[85,1],[83,2],[81,1],  [83,1],[85,1],[86,1],[81,3],
    [79,1],[78,1],[76,1],[78,1],[79,1],[81,1],  [74,3],[0,3],
  ];
  // Chords per bar (root midi + intervals) for A then B — 16 bars
  const D = [62, 66, 69], G = [67, 71, 74], Am = [69, 72, 76], A7 = [69, 73, 76], Bm = [59, 62, 66], Fsm = [66, 69, 73];
  const CHORDS = [D, D, D, D, G, D, G, A7, D, Fsm, G, A7, D, Bm, G, D];
  const MELODY = [...A, ...B];
  const TOTAL_EIGHTHS = 16 * 6;
  // flatten melody to a per-eighth lookup {note, len} at note starts
  const NOTE_AT = new Array(TOTAL_EIGHTHS).fill(null);
  { let t = 0; for (const [n, l] of MELODY) { if (t >= TOTAL_EIGHTHS) break; NOTE_AT[t] = { n, l }; t += l; } }

  const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

  function ensure() {
    if (S.ctx) return true;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    S.ctx = new AC();
    S.master = S.ctx.createGain();
    S.master.gain.value = 0;
    const comp = S.ctx.createDynamicsCompressor();
    comp.threshold.value = -18; comp.ratio.value = 4;
    S.master.connect(comp); comp.connect(S.ctx.destination);
    return true;
  }

  // --- voices ---
  function lead(freq, t, len) {
    const c = S.ctx, dur = len * EIGHTH;
    const g = c.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.09, t + 0.03);
    g.gain.setValueAtTime(0.09, t + Math.max(0.05, dur - 0.08));
    g.gain.linearRampToValueAtTime(0, t + dur);
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2400;
    g.connect(lp); lp.connect(S.master);
    // accordion-ish: two slightly detuned reeds + gentle vibrato
    [0, 6].forEach((det, i) => {
      const o = c.createOscillator(); o.type = i ? 'sawtooth' : 'triangle'; o.frequency.value = freq; o.detune.value = det;
      const vib = c.createOscillator(); vib.frequency.value = 5.5; const vg = c.createGain(); vg.gain.value = 3.5;
      vib.connect(vg); vg.connect(o.detune);
      const og = c.createGain(); og.gain.value = i ? 0.35 : 1;
      o.connect(og); og.connect(g);
      o.start(t); o.stop(t + dur + 0.05); vib.start(t); vib.stop(t + dur + 0.05);
    });
  }
  function pluck(freq, t, peak = 0.06, dur = 0.5) {
    const c = S.ctx;
    const o = c.createOscillator(); o.type = 'triangle'; o.frequency.value = freq;
    const g = c.createGain(); g.gain.setValueAtTime(peak, t); g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.setValueAtTime(3000, t); lp.frequency.exponentialRampToValueAtTime(600, t + dur);
    o.connect(lp); lp.connect(g); g.connect(S.master); o.start(t); o.stop(t + dur + 0.02);
  }
  function bass(freq, t, dur) {
    const c = S.ctx;
    const o = c.createOscillator(); o.type = 'sine'; o.frequency.value = freq;
    const o2 = c.createOscillator(); o2.type = 'triangle'; o2.frequency.value = freq; const g2 = c.createGain(); g2.gain.value = 0.35;
    const g = c.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.16, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    o.connect(g); o2.connect(g2); g2.connect(g); g.connect(S.master); o.start(t); o.stop(t + dur + 0.02); o2.start(t); o2.stop(t + dur + 0.02);
  }
  let noiseBuf = null;
  function noise() {
    if (noiseBuf) return noiseBuf;
    const c = S.ctx, b = c.createBuffer(1, c.sampleRate * 0.4, c.sampleRate), d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    noiseBuf = b; return b;
  }
  function drum(t, kind) {
    const c = S.ctx;
    if (kind === 'kick') {
      const o = c.createOscillator(); o.frequency.setValueAtTime(140, t); o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
      const g = c.createGain(); g.gain.setValueAtTime(0.18, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
      o.connect(g); g.connect(S.master); o.start(t); o.stop(t + 0.2);
    } else {
      const src = c.createBufferSource(); src.buffer = noise();
      const bp = c.createBiquadFilter(); bp.type = kind === 'snare' ? 'bandpass' : 'highpass'; bp.frequency.value = kind === 'snare' ? 1800 : 7000; bp.Q.value = 0.8;
      const g = c.createGain(); const pk = kind === 'snare' ? 0.07 : 0.025; g.gain.setValueAtTime(pk, t); g.gain.exponentialRampToValueAtTime(0.0005, t + (kind === 'snare' ? 0.12 : 0.05));
      src.connect(bp); bp.connect(g); g.connect(S.master); src.start(t); src.stop(t + 0.15);
    }
  }

  // --- scheduler ---
  function scheduleStep(step, t) {
    const i = step % TOTAL_EIGHTHS;
    const bar = Math.floor(i / 6), beat = i % 6;
    const chord = CHORDS[bar];
    const n = NOTE_AT[i];
    if (n && n.n) lead(mtof(n.n), t, n.l);
    // bass on beats 1 and 4 (root, then fifth on the second half of B section bars for lift)
    if (beat === 0) bass(mtof(chord[0] - 12), t, EIGHTH * 2.6);
    if (beat === 3) bass(mtof(chord[0] - 12 + (bar >= 8 && bar % 2 ? 7 : 0)), t, EIGHTH * 2.4);
    // plucked chord tones on the off-eighths
    if (beat === 1 || beat === 2 || beat === 4 || beat === 5) pluck(mtof(chord[(beat * 7 + bar) % 3]), t, 0.045, 0.4);
    // drum: kick 1, snare 4, hats on 3 and 6 (soft)
    if (beat === 0) drum(t, 'kick');
    if (beat === 3) drum(t, 'snare');
    if (beat === 2 || beat === 5) drum(t, 'hat');
  }
  function tick() {
    if (!S.playing || !S.ctx) return;
    const ahead = S.ctx.currentTime + 0.35;
    while (S.nextTime < ahead) { scheduleStep(S.step, S.nextTime); S.step++; S.nextTime += EIGHTH; }
  }

  function fadeTo(v, secs = 0.8) {
    if (!S.master) return;
    const now = S.ctx.currentTime;
    S.master.gain.cancelScheduledValues(now);
    S.master.gain.setValueAtTime(S.master.gain.value, now);
    S.master.gain.linearRampToValueAtTime(v, now + secs);
  }

  // --- optional drop-in file ---
  async function checkFile() {
    if (S.useFile !== null) return S.useFile;
    try {
      const r = await fetch('/audio/bgm.mp3', { method: 'HEAD' });
      S.useFile = r.ok && /audio/.test(r.headers.get('content-type') || '');
    } catch (e) { S.useFile = false; }
    return S.useFile;
  }

  async function start() {
    if (S.playing || !enabled()) return;
    if (await checkFile()) {
      if (!S.audioEl) { S.audioEl = new Audio('/audio/bgm.mp3'); S.audioEl.loop = true; }
      S.audioEl.volume = volume();
      try { await S.audioEl.play(); S.playing = true; } catch (e) { /* not unlocked yet */ }
      return;
    }
    if (!ensure()) return;
    if (S.ctx.state === 'suspended') { try { await S.ctx.resume(); } catch (e) { return; } }
    if (S.ctx.state !== 'running') return;
    S.playing = true;
    S.nextTime = S.ctx.currentTime + 0.05;
    fadeTo(volume() * duckMul, 1.2);
    tick();
    S.timer = setInterval(tick, 120);
  }
  function stop() {
    if (!S.playing) return;
    S.playing = false;
    if (S.audioEl) { S.audioEl.pause(); }
    if (S.timer) { clearInterval(S.timer); S.timer = null; }
    if (S.master) fadeTo(0, 0.5);
  }
  let duckMul = 1;
  function applyVolume() {
    if (S.audioEl) S.audioEl.volume = volume() * duckMul;
    if (S.master && S.playing) fadeTo(volume() * duckMul, 0.2);
  }
  // Temporarily lower the music (e.g. while ripping packs so the reveal sounds carry)
  function duck(on, mul = 0.35) { duckMul = on ? mul : 1; applyVolume(); }

  // Unlock/start on the first user gesture; stop/start when the setting flips.
  const unlock = () => { S.unlocked = true; if (enabled() && !(window.SFX && SFX.muted)) start(); };
  ['pointerdown', 'keydown', 'touchstart'].forEach((ev) => document.addEventListener(ev, unlock, { passive: true }));
  if (window.Settings) Settings.onChange((k) => {
    if (k === 'music') { if (enabled()) { if (S.unlocked) start(); } else stop(); }
    if (k === 'musicVolume') applyVolume();
  });
  // The 🔊/🔇 button mutes everything, music included.
  document.addEventListener('click', (e) => {
    if (!e.target.closest('[data-sfx-toggle]')) return;
    setTimeout(() => { if (window.SFX && SFX.muted) stop(); else if (enabled()) start(); }, 0);
  });
  // Pause when the tab is hidden (be a good neighbour), resume when it's back.
  document.addEventListener('visibilitychange', () => { if (document.hidden) { if (S.master && S.playing) fadeTo(0, 0.3); } else if (S.playing && S.master) fadeTo(volume(), 0.6); });

  window.BGM = { start, stop, duck, get playing() { return S.playing; } };
})();
