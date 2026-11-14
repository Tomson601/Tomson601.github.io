/* Backing beat for JukeBox: drums + bass synthesised with an OfflineAudioContext.
 * The beat is rendered to a buffer of exactly the same length as the image music, so both can be
 * started together (and seeked together) and mixed into the WAV export.
 *  - pattern: a 16-step grid per instrument, editable in the UI ("x" accent, "o" normal, "." off;
 *    in the bass row "R" = root note, "O" = an octave up);
 *  - tempo: one 16th note = step length × a simple ratio → the drums stay locked to the image's grid;
 *  - bass: plays the scale's root (the "Lowest note" folded into the bass range) → always in key. */
(() => {
  "use strict";

  const STEPS = 16;
  const ROWS = ["kick", "snare", "clap", "rim", "hat", "open", "shaker", "bass"];
  // loudness of each instrument at "accent"; a normal hit plays at NORMAL × this
  const LEVEL = { kick: 1, snare: 0.9, clap: 0.75, rim: 0.5, hat: 0.34, open: 0.32, shaker: 0.14, bass: 0.85 };
  const NORMAL = 0.6;
  // tempo choices: 16th note = step length × ratio
  const RATIOS = [0.5, 2 / 3, 1, 1.5, 2, 3, 4];

  const grid = (str) => [...str.padEnd(STEPS, ".")].slice(0, STEPS).map((c) => ({ x: 2, X: 2, R: 1, o: 1, O: 2 }[c] || 0));
  const style = (bpm, swing, tone, bassLen, rows) => ({
    bpm, ratio: null, swing, tone, bassLen,
    rows: Object.fromEntries(ROWS.map((r) => [r, grid(rows[r] || "")])),
  });

  // cell values: 0 off, 1 normal, 2 accent (bass: 1 root, 2 octave up)
  const STYLES = {
    lofi: style(82, 0.14, 0.55, 1, {
      kick:  "x......o..x.....",
      snare: "....x.......x...",
      hat:   "x.o.x.o.x.o.x.o.",
      bass:  "R.........R.....",
    }),
    house: style(122, 0, 1, 0.35, {
      kick:  "x...x...x...x...",
      clap:  "....o.......o...",
      hat:   "oo.o.o.o.o.o.o.o",
      open:  "..o...o...o...o.",
      bass:  "..R...O...R...O.",
    }),
    triphop: style(90, 0.06, 0.45, 1, {
      kick:   "x..o......x.....",
      snare:  "....x.......x...",
      hat:    "o.o.o.o.o.o.o.o.",
      shaker: "ooxoooxoooxoooxo",
      bass:   "R.........R.....",
    }),
    cosmic: style(68, 0, 0.35, 1, {
      kick:   "x.........o.....",
      rim:    "........o.......",
      shaker: "xoxoxoxoxoxoxoxo",
      bass:   "R...............",
    }),
  };

  const clone = (p) => JSON.parse(JSON.stringify(p));

  /** Ratio actually used: the pattern's own, or the one closest to its target BPM. */
  function ratioOf(noteLen, p) {
    if (p.ratio) return p.ratio;
    const target = 60 / p.bpm / 4;
    let best = 1, err = Infinity;
    for (const r of RATIOS) {
      const e = Math.abs(Math.log((noteLen * r) / target));
      if (e < err) { err = e; best = r; }
    }
    return best;
  }
  const sixteenth = (noteLen, p) => noteLen * ratioOf(noteLen, p);
  const bpmOf = (noteLen, p) => Math.round(60 / sixteenth(noteLen, p) / 4);
  /** Tempo choices that make musical sense for this step length: [{ ratio, bpm }]. */
  const tempos = (noteLen) => RATIOS.map((r) => ({ ratio: r, bpm: Math.round(60 / (noteLen * r) / 4) }))
    .filter((t) => t.bpm >= 40 && t.bpm <= 190);

  // One bar is rendered with an OfflineAudioContext (a long graph would be very slow, because every
  // scheduled node stays alive for the whole render) and then tiled across the track in plain JS.
  const TAIL = 4.5; // s – room for ringing bass / open hats after the bar
  const barCache = new Map();

  /**
   * Render the beat.
   * @param {object} p   pattern ({ rows, swing, tone, bassLen, bpm, ratio })
   * @param {object} o   { length (samples), sr, musicEnd (s, where the image music stops), noteLen, rootMidi }
   * @returns {Promise<AudioBuffer>}
   */
  async function render(p, o) {
    const d = sixteenth(o.noteLen, p);
    let root = o.rootMidi;
    while (root > 44) root -= 12;
    while (root < 33) root += 12;
    const key = [JSON.stringify([p.rows, p.swing, p.tone, p.bassLen]), d.toFixed(6), root, o.sr].join("|");
    if (!barCache.has(key)) {
      if (barCache.size > 24) barCache.clear();
      barCache.set(key, renderBar(p, d, root, o.sr));
    }
    const one = await barCache.get(key);

    const sr = o.sr, n = o.length;
    const barN = Math.round(d * STEPS * sr);
    const bars = Math.max(1, Math.ceil(o.musicEnd * sr / barN - 0.25)); // finish on a whole bar
    const fadeFrom = (bars - 1) * barN, fadeTo = bars * barN + Math.round(0.3 * sr);
    const out = new AudioBuffer({ length: n, numberOfChannels: 2, sampleRate: sr });
    for (let ch = 0; ch < 2; ch++) {
      const src = one.getChannelData(ch), dst = out.getChannelData(ch);
      for (let b = 0; b < bars; b++) {
        const off = b * barN;
        const m = Math.min(src.length, n - off);
        for (let i = 0; i < m; i++) dst[off + i] += src[i];
      }
      for (let i = fadeFrom; i < n; i++) { // fade the last bar out
        dst[i] *= i >= fadeTo ? 0 : 1 - (i - fadeFrom) / (fadeTo - fadeFrom);
      }
    }
    return out;
  }

  function renderBar(p, d, root, sr) {
    const oc = new OfflineAudioContext(2, Math.round((d * STEPS + TAIL) * sr), sr);

    // master: drums bus (+ tone lowpass) and bass → glue compressor
    const out = oc.createGain();
    const comp = oc.createDynamicsCompressor();
    comp.threshold.value = -14; comp.ratio.value = 3; comp.attack.value = 0.01; comp.release.value = 0.15;
    comp.connect(out);
    out.connect(oc.destination);
    const drums = oc.createBiquadFilter();
    drums.type = "lowpass";
    drums.frequency.value = 2500 + 15000 * p.tone;
    drums.connect(comp);

    // shared white noise (seeded → the same pattern always sounds the same)
    const nb = oc.createBuffer(1, sr, sr);
    const nd = nb.getChannelData(0);
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    for (let i = 0; i < nd.length; i++) nd[i] = rnd() * 2 - 1;

    const env = (g, t, peak, decay, attack = 0.002) => {
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(peak, t + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    };
    const noise = (t, dur, type, freq, q, peak, decay, pan = 0, dest = drums) => {
      const src = oc.createBufferSource();
      src.buffer = nb;
      const f = oc.createBiquadFilter();
      f.type = type; f.frequency.value = freq; f.Q.value = q;
      const g = oc.createGain();
      env(g, t, peak, decay);
      const pn = oc.createStereoPanner();
      pn.pan.value = pan;
      src.connect(f).connect(g).connect(pn).connect(dest);
      src.start(t, rnd() * 0.5);
      src.stop(t + dur);
    };

    const kick = (t, v) => {
      const o1 = oc.createOscillator();
      o1.type = "sine";
      o1.frequency.setValueAtTime(150, t);
      o1.frequency.exponentialRampToValueAtTime(48, t + 0.11);
      const g = oc.createGain();
      env(g, t, 0.95 * v, 0.42);
      o1.connect(g).connect(drums);
      o1.start(t); o1.stop(t + 0.5);
      noise(t, 0.02, "highpass", 3000, 0.7, 0.18 * v, 0.012); // click
    };
    const snare = (t, v) => {
      const o1 = oc.createOscillator();
      o1.type = "triangle";
      o1.frequency.setValueAtTime(220, t);
      o1.frequency.exponentialRampToValueAtTime(160, t + 0.08);
      const g = oc.createGain();
      env(g, t, 0.35 * v, 0.1);
      o1.connect(g).connect(drums);
      o1.start(t); o1.stop(t + 0.2);
      noise(t, 0.3, "bandpass", 1900, 0.7, 0.55 * v, 0.18);
    };
    const clap = (t, v) => {
      for (const k of [0, 0.011, 0.022]) noise(t + k, 0.05, "bandpass", 1300, 1.2, 0.45 * v, 0.03);
      noise(t + 0.03, 0.3, "bandpass", 1300, 1, 0.4 * v, 0.16);
    };
    const rim = (t, v) => noise(t, 0.08, "bandpass", 3200, 6, 0.6 * v, 0.045);
    const hat = (t, v) => noise(t, 0.08, "highpass", 7500, 0.8, 0.5 * v, 0.035, 0.15);
    const open = (t, v) => noise(t, 0.45, "highpass", 7500, 0.8, 0.5 * v, 0.28, 0.15);
    const shaker = (t, v) => noise(t, 0.1, "bandpass", 6000, 1.5, 0.6 * v, 0.06, -0.2);

    // bass: root of the scale folded into MIDI 33–44 (A1–G#2)
    const bassLp = oc.createBiquadFilter();
    bassLp.type = "lowpass"; bassLp.frequency.value = 420; bassLp.Q.value = 0.9;
    bassLp.connect(comp);
    const bass = (t, v, len, up) => {
      const f = 440 * 2 ** ((root + (up ? 12 : 0) - 69) / 12);
      const g = oc.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.5 * v, t + 0.012);
      g.gain.setTargetAtTime(0.32 * v, t + 0.03, 0.15);
      g.gain.setTargetAtTime(0.0001, t + Math.max(0.05, len * 0.92), 0.05);
      g.connect(bassLp);
      for (const [type, mul, amp] of [["sine", 1, 1], ["triangle", 2, 0.25]]) {
        const osc = oc.createOscillator();
        osc.type = type; osc.frequency.value = f * mul;
        const a = oc.createGain(); a.gain.value = amp;
        osc.connect(a).connect(g);
        osc.start(t); osc.stop(t + len + 0.4);
      }
    };

    const PLAY = { kick, snare, clap, rim, hat, open, shaker };
    const at = (step) => step * d + (step % 2 ? p.swing * d : 0);
    const vel = (row, c) => LEVEL[row] * (c === 2 ? 1 : NORMAL);
    for (const row of ROWS) {
      const cells = p.rows[row] || [];
      cells.forEach((c, s) => {
        if (!c) return;
        if (row !== "bass") { PLAY[row](at(s), vel(row, c)); return; }
        // a bass note lasts until the next bass hit (wrapping into the next bar) × "bass length"
        let gap = 1;
        while (gap < STEPS && !cells[(s + gap) % STEPS]) gap++;
        bass(at(s), LEVEL.bass, Math.min(4, gap * d * p.bassLen), c === 2);
      });
    }
    return oc.startRendering();
  }

  window.Beat = { STEPS, ROWS, STYLES, RATIOS, clone, render, sixteenth, bpmOf, ratioOf, tempos };
})();
