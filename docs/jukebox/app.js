/* JukeBox – image sonification (browser port of jukebox_test.py).
 * X = time, Y = pitch, brightness = loudness, notes snapped to a musical scale. */
(() => {
  "use strict";

  const SR = 44100;
  const MAX_SOURCE_SIDE = 1024; // sources are downscaled on load (the score is at most 192x48)

  const SCALES = {
    major:            [0, 2, 4, 5, 7, 9, 11],
    minor:            [0, 2, 3, 5, 7, 8, 10],
    major_pentatonic: [0, 2, 4, 7, 9],
    minor_pentatonic: [0, 3, 5, 7, 10],
    dorian:           [0, 2, 3, 5, 7, 9, 10],
    lydian:           [0, 2, 4, 6, 7, 9, 11],
    whole_tone:       [0, 2, 4, 6, 8, 10],
    chromatic:        [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  };

  // harmonic amplitudes (1st, 2nd, 3rd…); "classic" = the original notebook sound
  const TIMBRES = {
    classic: [1.0, 0.45, 0.25, 0.12],
    sine:    [1.0],
    soft:    [1.0, 0.2, 0.05],
    hollow:  [1.0, 0, 0.33, 0, 0.2, 0, 0.14],
    bright:  [1.0, 0.7, 0.5, 0.35, 0.25, 0.18, 0.12],
  };

  const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const midiName = (m) => NOTE_NAMES[m % 12] + (Math.floor(m / 12) - 1);
  const label = (s) => s.replace(/_/g, " ");

  const PARAMS = [
    { group: "Melody", id: "scale", label: "Scale", type: "select", options: Object.keys(SCALES), value: "lydian" },
    { group: "Melody", id: "rootMidi", label: "Lowest note", min: 24, max: 72, step: 1, value: 45, fmt: (v) => `${midiName(v)} (${v})` },
    { group: "Melody", id: "rows", label: "Pitch rows", min: 8, max: 48, step: 2, value: 46 },
    { group: "Rhythm", id: "columns", label: "Time steps per image", min: 16, max: 192, step: 8, value: 128 },
    { group: "Rhythm", id: "noteLen", label: "Step length", min: 0.05, max: 0.5, step: 0.01, value: 0.18, fmt: (v) => `${v.toFixed(2)} s` },
    { group: "Rhythm", id: "tail", label: "Note ring-out", min: 1, max: 6, step: 0.5, value: 3, fmt: (v) => `${v}× step` },
    { group: "Dynamics", id: "maxVoices", label: "Max notes at once", min: 1, max: 10, step: 1, value: 8 },
    { group: "Dynamics", id: "threshold", label: "Brightness threshold", min: 0, max: 0.9, step: 0.05, value: 0.25 },
    { group: "Dynamics", id: "gamma", label: "Loudness contrast (gamma)", min: 0.5, max: 3, step: 0.1, value: 1.5 },
    { group: "Dynamics", id: "lowPct", label: "Black point (percentile)", min: 0, max: 20, step: 0.5, value: 1 },
    { group: "Dynamics", id: "highPct", label: "White point (percentile)", min: 80, max: 100, step: 0.5, value: 100 },
    { group: "Sound", id: "timbre", label: "Timbre", type: "select", options: Object.keys(TIMBRES), value: "classic" },
    { group: "Sound", id: "attack", label: "Attack", min: 2, max: 120, step: 1, value: 10, fmt: (v) => `${v} ms` },
    { group: "Sound", id: "reverb", label: "Reverb", min: 0, max: 0.7, step: 0.05, value: 0.35, fmt: (v) => (v ? v.toFixed(2) : "off") },
    { group: "Sound", id: "width", label: "Stereo width", min: 0, max: 1, step: 0.05, value: 0.6 },
  ];
  // shown in the Help popup (Advanced settings)
  const HELP = {
    scale: "Which notes are allowed. Every pitch row is snapped to this scale, so the music always stays in key. Pentatonic scales never clash, lydian and dorian sound bright or jazzy, minor sounds sad, whole tone sounds dreamy and sci-fi, chromatic uses all 12 notes and is the most dissonant.",
    rootMidi: "The pitch of the bottom row of the image. Lower values give a deeper sound. The rows above climb up the scale from this note.",
    rows: "How many different pitches the image height is split into. More rows means a wider range and finer detail; fewer rows gives a simpler melody.",
    columns: "How many slices each image is cut into from left to right. Each slice is one beat. More steps make the piece longer and more detailed.",
    noteLen: "How long one time step lasts. Together with Time steps it sets the tempo and length: total time ≈ time steps × step length × number of images.",
    tail: "How long each note keeps ringing after its step, as a multiple of the step length. Higher values let notes overlap and blend into chords and pads.",
    maxVoices: "In every time step only the N brightest cells of that column are played. 1 gives a single melody line; higher values give fuller chords (and a busier sound).",
    threshold: "Cells darker than this stay silent (they are dimmed in the Score). Raise it to play only the brightest features of the image, lower it to hear more of it.",
    gamma: "How brightness turns into loudness. Above 1, bright areas stand out and dim ones get much quieter; below 1, everything plays at a more equal volume.",
    lowPct: "Before playing, the image contrast is stretched. Pixels darker than this percentile count as pure black. Raise it if the image looks greyish or washed out.",
    highPct: "Pixels brighter than this percentile count as full white. Lower it if a few very bright spots make the rest of the image too quiet.",
    timbre: "The tone colour of each note (which overtones are added). Classic is the original notebook sound, sine is pure and soft, soft is mellow, hollow is clarinet-like, bright is rich and buzzy.",
    attack: "How quickly each note fades in. Short values sound plucky and percussive; long values give soft swells.",
    reverb: "Adds echoes, so it sounds like a large hall or open space. Off gives a dry, close sound.",
    width: "Stereo spread. Low notes are placed to the left and high notes to the right; 0 keeps everything in the centre (mono), 1 is the widest.",
  };
  const DEFAULTS = Object.fromEntries(PARAMS.map((p) => [p.id, p.value]));

  const PRESETS = [
    { name: "Classic", desc: "The original notebook settings: lydian scale, wide range, gentle reverb.", values: {} },
    { name: "Ambient", desc: "Slow, soft and spacious – long notes in a pentatonic scale.",
      values: { scale: "major_pentatonic", rootMidi: 40, rows: 30, columns: 64, noteLen: 0.4, tail: 4, maxVoices: 6, threshold: 0.3, gamma: 2, timbre: "soft", attack: 80, reverb: 0.55, width: 0.9 } },
    { name: "Music box", desc: "High, sparse and plucky, like a wind-up music box.",
      values: { scale: "major", rootMidi: 64, rows: 22, columns: 96, noteLen: 0.14, tail: 4, maxVoices: 3, threshold: 0.4, gamma: 1.2, timbre: "sine", attack: 3, reverb: 0.3, width: 0.5 } },
    { name: "Dreamy", desc: "Floating lydian chords with a hollow, clarinet-like tone.",
      values: { scale: "lydian", rootMidi: 48, rows: 36, columns: 80, noteLen: 0.28, tail: 3.5, maxVoices: 5, threshold: 0.3, gamma: 1.8, timbre: "hollow", attack: 40, reverb: 0.5, width: 0.8 } },
    { name: "Dark", desc: "Low and brooding natural minor with a bright edge.",
      values: { scale: "minor", rootMidi: 33, rows: 40, columns: 128, noteLen: 0.2, tail: 3, maxVoices: 8, threshold: 0.2, gamma: 1.5, timbre: "bright", attack: 15, reverb: 0.4, width: 0.6 } },
    { name: "Arpeggio", desc: "Fast single-note runs in dorian – the image as a melody line.",
      values: { scale: "dorian", rootMidi: 52, rows: 24, columns: 192, noteLen: 0.07, tail: 2, maxVoices: 1, threshold: 0.35, gamma: 1, timbre: "classic", attack: 4, reverb: 0.25, width: 0.7 } },
    { name: "Mystery", desc: "Whole-tone harmony – no home key, pure sci-fi.",
      values: { scale: "whole_tone", rootMidi: 45, rows: 30, columns: 96, noteLen: 0.22, tail: 3, maxVoices: 4, threshold: 0.3, gamma: 1.6, timbre: "hollow", attack: 25, reverb: 0.5, width: 0.8 } },
  ];
  const presetValues = (p) => ({ ...DEFAULTS, ...p.values });

  // ------------------------------------------------------------------------ //
  // DOM
  // ------------------------------------------------------------------------ //
  const $ = (id) => document.getElementById(id);
  const setStatus = (msg, isError = false) => {
    $("status").textContent = msg;
    $("status").classList.toggle("error", isError);
  };

  const state = {
    sources: [],   // { name, gray: Float32Array, w, h, thumb, on } – the images that play
    all: [],       // every loaded image (the thumbnails)
    result: null,  // { L, R, matrices, midi, p }
    ctx: null, analyser: null, node: null, startedAt: 0,
    dirty: true,
    preset: 0,     // index into PRESETS, -1 = custom
  };

  const inputs = {};
  const shows = {};
  function buildParams() {
    const root = $("params");
    const groups = {};
    for (const p of PARAMS) {
      if (!groups[p.group]) {
        const fs = document.createElement("fieldset");
        const lg = document.createElement("legend");
        lg.textContent = p.group;
        const grid = document.createElement("div");
        grid.className = "grid";
        fs.append(lg, grid);
        root.append(fs);
        groups[p.group] = grid;
      }
      const lab = document.createElement("label");
      let input;
      if (p.type === "select") {
        lab.textContent = p.label;
        input = document.createElement("select");
        for (const o of p.options) input.add(new Option(label(o), o));
        lab.append(input);
        shows[p.id] = () => {};
      } else {
        const head = document.createElement("span");
        head.className = "row";
        const val = document.createElement("span");
        val.className = "val";
        head.append(p.label, val);
        input = document.createElement("input");
        Object.assign(input, { type: "range", min: p.min, max: p.max, step: p.step });
        shows[p.id] = () => (val.textContent = p.fmt ? p.fmt(+input.value) : input.value);
        input.addEventListener("input", shows[p.id]);
        lab.append(head, input);
      }
      const info = document.createElement("button");
      info.type = "button";
      info.className = "info";
      info.textContent = "?";
      info.setAttribute("aria-label", `What does “${p.label}” do?`);
      info.addEventListener("click", (e) => { e.preventDefault(); openHelp(p.id); });
      lab.prepend(info);
      input.id = "p-" + p.id;
      input.addEventListener("input", () => { markCustom(); paramsChanged(); });
      inputs[p.id] = input;
      groups[p.group].append(lab);
    }
  }

  function buildHelp() {
    const body = $("help-body");
    let group = null, list = null;
    for (const p of PARAMS) {
      if (p.group !== group) {
        group = p.group;
        const h = document.createElement("h4");
        h.textContent = group;
        list = document.createElement("dl");
        body.append(h, list);
      }
      const dt = document.createElement("dt");
      dt.id = "help-" + p.id;
      dt.textContent = p.label;
      const dd = document.createElement("dd");
      dd.textContent = HELP[p.id] || "";
      list.append(dt, dd);
    }
    const dlg = $("help");
    $("help-close").addEventListener("click", () => dlg.close());
    dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); }); // click on the backdrop
    $("btn-help").addEventListener("click", () => openHelp());
  }

  function openHelp(id) {
    const dlg = $("help");
    dlg.querySelectorAll(".hl").forEach((el) => el.classList.remove("hl"));
    if (!dlg.open) dlg.showModal();
    const dt = id && $("help-" + id);
    if (dt) {
      dt.classList.add("hl");
      dt.nextElementSibling.classList.add("hl");
      dt.scrollIntoView({ block: "center" });
    } else {
      $("help-body").scrollTop = 0;
    }
  }

  function readParams() {
    const out = {};
    for (const p of PARAMS) out[p.id] = p.type === "select" ? inputs[p.id].value : +inputs[p.id].value;
    return out;
  }

  function writeParams(values) {
    for (const p of PARAMS) {
      inputs[p.id].value = values[p.id];
      shows[p.id]();
    }
  }

  function buildPresets() {
    const root = $("presets");
    PRESETS.forEach((pr, i) => {
      const b = document.createElement("button");
      b.textContent = pr.name;
      b.setAttribute("role", "radio");
      b.addEventListener("click", () => applyPreset(i));
      root.append(b);
    });
    const c = document.createElement("button");
    c.textContent = "Custom";
    c.className = "custom";
    c.setAttribute("role", "radio");
    c.addEventListener("click", () => ($("advanced").open = true));
    root.append(c);
  }

  function renderPresetState() {
    [...$("presets").children].forEach((b, i) =>
      b.setAttribute("aria-checked", String(i === state.preset || (state.preset < 0 && i === PRESETS.length))));
    $("preset-desc").textContent = state.preset >= 0
      ? PRESETS[state.preset].desc
      : "Custom settings – tweak them under Advanced settings.";
    $("btn-reset").hidden = state.preset >= 0;
  }

  let lastPreset = 0;
  function applyPreset(i) {
    state.preset = lastPreset = i;
    writeParams(presetValues(PRESETS[i]));
    renderPresetState();
    paramsChanged();
  }

  function markCustom() {
    if (state.preset >= 0) { state.preset = -1; renderPresetState(); }
  }

  function paramsChanged() {
    state.dirty = true;
    updateButtons();
    drawViz();
    if (state.node) restartTimer();
  }

  // playing + params changed → re-render shortly after the user stops dragging
  let restartT = 0;
  function restartTimer() {
    clearTimeout(restartT);
    restartT = setTimeout(() => state.node && play(currentTime()), 500);
  }

  // ------------------------------------------------------------------------ //
  // Image -> grayscale (alpha composited on black, like the Python version)
  // ------------------------------------------------------------------------ //
  async function blobToSource(blob, name) {
    const bmp = await createImageBitmap(blob);
    const s = Math.min(1, MAX_SOURCE_SIDE / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * s));
    const h = Math.max(1, Math.round(bmp.height * s));
    const cv = document.createElement("canvas");
    cv.width = w; cv.height = h;
    const g = cv.getContext("2d", { willReadFrequently: true });
    g.fillStyle = "#000";
    g.fillRect(0, 0, w, h);
    g.drawImage(bmp, 0, 0, w, h);
    bmp.close?.();
    const px = g.getImageData(0, 0, w, h).data;
    const gray = new Float32Array(w * h);
    for (let i = 0, j = 0; i < gray.length; i++, j += 4) {
      gray[i] = 0.299 * px[j] + 0.587 * px[j + 1] + 0.114 * px[j + 2]; // ITU-R 601 (PIL "L")
    }
    // square, centre-cropped thumbnail – also used as the record label
    const side = Math.min(w, h);
    const tc = document.createElement("canvas");
    tc.width = tc.height = 400;
    tc.getContext("2d").drawImage(cv, (w - side) / 2, (h - side) / 2, side, side, 0, 0, 400, 400);
    return { name, gray, w, h, thumb: tc.toDataURL("image/jpeg", 0.85) };
  }

  // block averaging (equivalent of PIL resize BOX) with fractional coverage
  function axisWeights(src, dst) {
    const list = [];
    const r = src / dst;
    for (let o = 0; o < dst; o++) {
      const a = o * r, b = (o + 1) * r;
      const idx = [], wts = [];
      for (let i = Math.floor(a); i < Math.min(src, Math.ceil(b)); i++) {
        const wgt = Math.min(i + 1, b) - Math.max(i, a);
        if (wgt > 0) { idx.push(i); wts.push(wgt / r); }
      }
      list.push([idx, wts]);
    }
    return list;
  }

  function boxResize(gray, w, h, cols, rows) {
    const wx = axisWeights(w, cols);
    const tmp = new Float64Array(cols * h);
    for (let y = 0; y < h; y++) {
      const off = y * w;
      for (let c = 0; c < cols; c++) {
        const [idx, wts] = wx[c];
        let s = 0;
        for (let k = 0; k < idx.length; k++) s += gray[off + idx[k]] * wts[k];
        tmp[y * cols + c] = s;
      }
    }
    const wy = axisWeights(h, rows);
    const out = new Float64Array(cols * rows);
    for (let r = 0; r < rows; r++) {
      const [idx, wts] = wy[r];
      for (let c = 0; c < cols; c++) {
        let s = 0;
        for (let k = 0; k < idx.length; k++) s += tmp[idx[k] * cols + c] * wts[k];
        out[r * cols + c] = s;
      }
    }
    return out;
  }

  function percentile(sorted, p) { // like np.percentile (linear interpolation)
    const pos = (p / 100) * (sorted.length - 1);
    const lo = Math.floor(pos), hi = Math.ceil(pos);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }

  function toMatrix(src, cols, rows, lowPct, highPct) {
    const m = boxResize(src.gray, src.w, src.h, cols, rows);
    const sorted = Float64Array.from(m).sort();
    const lo = percentile(sorted, lowPct), hi = percentile(sorted, highPct);
    if (hi - lo < 1e-9) return m.fill(0);
    for (let i = 0; i < m.length; i++) m[i] = Math.min(1, Math.max(0, (m[i] - lo) / (hi - lo)));
    return m;
  }

  // ------------------------------------------------------------------------ //
  // Pitches
  // ------------------------------------------------------------------------ //
  function rowToMidi(rows, scale, root) { // row 0 = top of the image = highest note
    const notes = [];
    for (let i = 0; i < rows; i++) {
      const oct = Math.floor(i / scale.length), deg = i % scale.length;
      notes.push(root + 12 * oct + scale[deg]);
    }
    return notes.reverse();
  }
  const midiToFreq = (m) => 440 * 2 ** ((m - 69) / 12);

  // ------------------------------------------------------------------------ //
  // Synthesis
  // ------------------------------------------------------------------------ //
  function synthNote(freq, duration, harmonics, attack) {
    const n = Math.floor(duration * SR);
    const out = new Float32Array(n);
    const tau = duration * 0.35;
    const fade = Math.min(Math.floor(0.01 * SR), n);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      let v = 0;
      for (let k = 0; k < harmonics.length; k++) {
        const f = freq * (k + 1);
        if (harmonics[k] && f < SR / 2) v += harmonics[k] * Math.sin(2 * Math.PI * f * t);
      }
      let env = Math.min(t / attack, 1) * Math.exp(-t / tau);
      const fi = i - (n - fade);
      if (fi >= 0) env *= fade > 1 ? 1 - fi / (fade - 1) : 0;
      out[i] = v * env;
    }
    return out;
  }

  const topVoices = (mat, cols, rows, c, maxVoices, threshold) => {
    const idx = [];
    for (let r = 0; r < rows; r++) idx.push(r);
    idx.sort((a, b) => mat[b * cols + c] - mat[a * cols + c]);
    return idx.slice(0, maxVoices).filter((r) => mat[r * cols + c] >= threshold);
  };

  function renderFrames(matrices, midi, p) {
    const { rows, columns: cols, noteLen, maxVoices, threshold, gamma, tail: tailFactor } = p;
    const totalCols = cols * matrices.length;
    const step = Math.floor(noteLen * SR);
    const tail = Math.floor(noteLen * tailFactor * SR);
    const len = totalCols * step + tail + SR;
    const L = new Float32Array(len), R = new Float32Array(len);

    // every note has the same length, so each row is synthesised only once
    const harm = TIMBRES[p.timbre] || TIMBRES.classic;
    const notes = midi.map((m) => synthNote(midiToFreq(m), noteLen * tailFactor, harm, p.attack / 1000));
    const gl = [], gr = [];
    for (let r = 0; r < rows; r++) {
      const pan = 0.5 + p.width * (0.5 - r / Math.max(1, rows - 1)); // low notes left, high notes right
      gl.push(Math.cos((pan * Math.PI) / 2));
      gr.push(Math.sin((pan * Math.PI) / 2));
    }

    let col = 0;
    for (const mat of matrices) {
      for (let c = 0; c < cols; c++, col++) {
        const start = col * step;
        for (const r of topVoices(mat, cols, rows, c, maxVoices, threshold)) {
          const amp = mat[r * cols + c] ** gamma / maxVoices;
          const note = notes[r], al = amp * gl[r], ar = amp * gr[r];
          for (let i = 0; i < note.length; i++) {
            L[start + i] += note[i] * al;
            R[start + i] += note[i] * ar;
          }
        }
      }
    }
    return [L, R];
  }

  function addReverb(ch, decay, delaysMs = [37, 53, 79, 113]) {
    const out = Float32Array.from(ch);
    delaysMs.forEach((d, i) => {
      const shift = Math.max(1, Math.floor((d / 1000) * SR));
      if (shift >= ch.length) return;
      const g = decay ** (i + 1);
      for (let j = shift; j < ch.length; j++) out[j] += g * ch[j - shift];
    });
    return out;
  }

  function normalize(L, R) {
    let peak = 0;
    for (let i = 0; i < L.length; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
    if (peak > 0) {
      const g = 0.9 / peak;
      for (let i = 0; i < L.length; i++) { L[i] *= g; R[i] *= g; }
    }
  }

  // ------------------------------------------------------------------------ //
  // WAV / MIDI export
  // ------------------------------------------------------------------------ //
  function wavBlob(L, R) {
    const n = L.length, buf = new ArrayBuffer(44 + n * 4), v = new DataView(buf);
    const str = (o, s) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
    str(0, "RIFF"); v.setUint32(4, 36 + n * 4, true); str(8, "WAVE");
    str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true);
    v.setUint32(24, SR, true); v.setUint32(28, SR * 4, true); v.setUint16(32, 4, true); v.setUint16(34, 16, true);
    str(36, "data"); v.setUint32(40, n * 4, true);
    for (let i = 0, o = 44; i < n; i++, o += 4) {
      v.setInt16(o, Math.trunc(L[i] * 32767), true);
      v.setInt16(o + 2, Math.trunc(R[i] * 32767), true);
    }
    return new Blob([buf], { type: "audio/wav" });
  }

  function midiBlob(matrices, midi, p) {
    const { rows, columns: cols, noteLen, maxVoices, threshold } = p;
    const tpb = 480;
    const ev = [];
    const vlq = (n) => {
      const bytes = [n & 0x7f];
      while ((n >>= 7)) bytes.unshift((n & 0x7f) | 0x80);
      return bytes;
    };
    const tempo = Math.round(noteLen * 1e6); // one column = one beat
    ev.push(...vlq(0), 0xff, 0x51, 0x03, (tempo >> 16) & 0xff, (tempo >> 8) & 0xff, tempo & 0xff);
    for (const mat of matrices) {
      for (let c = 0; c < cols; c++) {
        const chosen = topVoices(mat, cols, rows, c, maxVoices, threshold);
        for (const r of chosen) ev.push(...vlq(0), 0x90, midi[r], Math.floor(30 + 97 * mat[r * cols + c]));
        chosen.forEach((r, i) => ev.push(...vlq(i === 0 ? tpb : 0), 0x80, midi[r], 0));
        if (!chosen.length) ev.push(...vlq(tpb), 0x80, 0, 0); // rest
      }
    }
    ev.push(...vlq(0), 0xff, 0x2f, 0x00);
    const head = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, (tpb >> 8) & 0xff, tpb & 0xff];
    const n = ev.length;
    const trk = [0x4d, 0x54, 0x72, 0x6b, (n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
    return new Blob([new Uint8Array([...head, ...trk, ...ev])], { type: "audio/midi" });
  }

  function download(blob, name) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  // ------------------------------------------------------------------------ //
  // Score visualisation ("magma" palette)
  // ------------------------------------------------------------------------ //
  const MAGMA = [[0, 0, 4], [28, 16, 68], [79, 18, 123], [129, 37, 129], [181, 54, 122],
                 [229, 80, 100], [251, 135, 97], [254, 194, 135], [252, 253, 191]];
  function magma(v) {
    const x = Math.min(1, Math.max(0, v)) * (MAGMA.length - 1);
    const i = Math.min(MAGMA.length - 2, Math.floor(x)), f = x - i;
    return MAGMA[i].map((a, k) => a + (MAGMA[i + 1][k] - a) * f);
  }

  let vizImage = null;
  function currentMatrices() {
    const p = readParams();
    return { p, matrices: state.sources.map((s) => toMatrix(s, p.columns, p.rows, p.lowPct, p.highPct)) };
  }

  function buildVizImage(matrices, p) {
    if (!matrices.length) { vizImage = null; return; }
    const cols = p.columns, rows = p.rows, W = cols * matrices.length;
    const cv = document.createElement("canvas");
    cv.width = W; cv.height = rows;
    const g = cv.getContext("2d");
    const img = g.createImageData(W, rows);
    matrices.forEach((m, f) => {
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        const v = m[r * cols + c];
        // cells below the threshold stay silent – draw them dimmer
        const [R, G, B] = magma(v).map((x) => (v < p.threshold ? x * 0.35 : x));
        const o = (r * W + f * cols + c) * 4;
        img.data[o] = R; img.data[o + 1] = G; img.data[o + 2] = B; img.data[o + 3] = 255;
      }
    });
    g.putImageData(img, 0, 0);
    vizImage = { cv, frames: matrices.length, cols };
  }

  let vizTimer = 0;
  function drawViz() {
    clearTimeout(vizTimer);
    vizTimer = setTimeout(() => {
      if (!state.sources.length) return;
      const { p, matrices } = currentMatrices();
      buildVizImage(matrices, p);
      if (!state.node) paintViz(-1);
    }, 60);
  }

  function fitCanvas(cv) {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(cv.clientWidth * dpr), h = Math.round(cv.clientHeight * dpr);
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    return [w, h, dpr];
  }

  function paintViz(playCol) {
    const cv = $("viz");
    const [w, h, dpr] = fitCanvas(cv);
    const g = cv.getContext("2d");
    g.fillStyle = "#000004";
    g.fillRect(0, 0, w, h);
    if (!vizImage) return;
    g.imageSmoothingEnabled = false;
    g.drawImage(vizImage.cv, 0, 0, w, h);
    const total = vizImage.cols * vizImage.frames;
    g.fillStyle = "rgba(255,255,255,0.35)";
    for (let f = 1; f < vizImage.frames; f++) g.fillRect(Math.round((f * vizImage.cols * w) / total), 0, Math.max(1, dpr), h);
    if (playCol >= 0) {
      const x = (playCol / total) * w;
      g.fillStyle = "rgba(0,0,0,0.45)";
      g.fillRect(0, 0, x, h);
      g.fillStyle = "#fff";
      g.fillRect(x, 0, 2 * dpr, h);
    }
  }

  // ------------------------------------------------------------------------ //
  // Jukebox: record label, glow and audio features for the particle background
  // ------------------------------------------------------------------------ //
  let labelIdx = -1;
  function setLabel(i) {
    if (i === labelIdx || !state.sources[i]) return;
    labelIdx = i;
    $("label").style.backgroundImage = `url("${state.sources[i].thumb}")`;
  }

  const NB = 32;                       // log-spaced bands, ~40 Hz … 6 kHz
  const freqBuf = new Uint8Array(512);
  const timeBuf = new Float32Array(1024);
  const audio = { bands: new Float32Array(NB), bass: 0, mid: 0, high: 0, level: 0, kick: 0, playing: false };
  let bassAvg = 0;

  function updateAudio() {
    const on = !!state.node;
    audio.playing = on;
    let rms = 0;
    if (on) {
      state.analyser.getFloatTimeDomainData(timeBuf);
      for (let i = 0; i < timeBuf.length; i++) rms += timeBuf[i] * timeBuf[i];
      rms = Math.min(1, Math.sqrt(rms / timeBuf.length) * 3);
      state.analyser.getByteFrequencyData(freqBuf);
    } else {
      freqBuf.fill(0);
    }
    const binHz = state.ctx ? state.ctx.sampleRate / 2 / freqBuf.length : SR / 2 / freqBuf.length;
    for (let i = 0; i < NB; i++) {
      const f0 = 40 * (6000 / 40) ** (i / NB), f1 = 40 * (6000 / 40) ** ((i + 1) / NB);
      const b0 = Math.floor(f0 / binHz), b1 = Math.max(b0 + 1, Math.ceil(f1 / binHz));
      let m = 0;
      for (let b = b0; b < b1 && b < freqBuf.length; b++) m = Math.max(m, freqBuf[b]);
      const v = (m / 255) ** 1.5;
      audio.bands[i] = v > audio.bands[i] ? v : audio.bands[i] * 0.88; // fast attack, slow release
    }
    const avg = (a, b) => { let s = 0; for (let i = a; i < b; i++) s += audio.bands[i]; return s / (b - a); };
    audio.bass = avg(0, 8);
    audio.mid = avg(8, 20);
    audio.high = avg(20, NB);
    audio.level += (rms - audio.level) * 0.2;
    // "kick": bass jumps above its running average
    if (audio.bass - bassAvg > 0.08 && audio.kick < 0.4) audio.kick = 1;
    bassAvg += (audio.bass - bassAvg) * 0.05;
    audio.kick *= 0.9;
    $("glow").style.opacity = Math.min(1, audio.level * 1.3 + audio.kick * 0.25).toFixed(3);
  }

  // ------------------------------------------------------------------------ //
  // Playback (play / pause / seek / stop)
  // ------------------------------------------------------------------------ //
  const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  state.offset = 0;   // seconds into the track (used for pause / seek)
  state.paused = false;

  function ensureCtx() { // must run inside a click handler (autoplay rules)
    if (!state.ctx) {
      state.ctx = new (window.AudioContext || window.webkitAudioContext)();
      state.analyser = state.ctx.createAnalyser();
      state.analyser.fftSize = 1024;
      state.analyser.smoothingTimeConstant = 0.55;
      state.analyser.connect(state.ctx.destination);
    }
    state.ctx.resume();
  }

  function compose() {
    const { p, matrices } = currentMatrices();
    const midi = rowToMidi(p.rows, SCALES[p.scale], p.rootMidi);
    let [L, R] = renderFrames(matrices, midi, p);
    if (p.reverb > 0) { L = addReverb(L, p.reverb); R = addReverb(R, p.reverb); }
    normalize(L, R);
    const buffer = state.ctx.createBuffer(2, L.length, SR);
    buffer.copyToChannel(L, 0);
    buffer.copyToChannel(R, 1);
    state.result = { L, R, matrices, midi, p, buffer, duration: L.length / SR };
    state.dirty = false;
    buildVizImage(matrices, p);
  }

  function killNode() {
    if (!state.node) return;
    const n = state.node;
    state.node = null;
    n.onended = null;
    try { n.stop(); } catch {}
    n.disconnect();
  }

  async function play(offset = state.offset) {
    if (!state.sources.length) return;
    ensureCtx();
    killNode();
    if (state.dirty || !state.result) {
      setStatus("Composing…");
      await new Promise((r) => setTimeout(r, 30));
      compose();
      offset = Math.min(offset, state.result.duration);
    }
    const { buffer, duration } = state.result;
    if (offset >= duration - 0.05) offset = 0;
    const node = state.ctx.createBufferSource();
    node.buffer = buffer;
    node.connect(state.analyser);
    node.onended = () => { if (state.node === node) finish(); };
    state.node = node;
    state.paused = false;
    state.startedAt = state.ctx.currentTime + 0.03 - offset;
    node.start(state.ctx.currentTime + 0.03, offset);
    const vinyl = $("vinyl");
    vinyl.classList.add("spinning");
    vinyl.classList.remove("paused");
    setStatus(`${PRESETS[state.preset]?.name ?? "Custom"} · ${state.sources.length} image(s) · ${fmt(duration)}`);
    updateButtons();
  }

  function pause() {
    if (!state.node) return;
    state.offset = Math.max(0, state.ctx.currentTime - state.startedAt);
    killNode();
    state.paused = true;
    $("vinyl").classList.add("paused");
    updateButtons();
  }

  function stop() {
    killNode();
    state.paused = false;
    state.offset = 0;
    $("vinyl").classList.add("paused");
    setActiveThumb(-1);
    updateButtons();
    paintViz(-1);
    updateDeck(0);
  }

  function finish() { stop(); setStatus("Finished – press play to hear it again."); }

  function togglePlay() {
    if (state.node) { pause(); return; }
    ensureCtx();
    if (!state.sources.length) { pickRecord(Math.max(0, state.record)); return; }
    play();
  }

  function seek(frac) {
    if (!state.result || state.dirty) return;
    const t = frac * state.result.duration;
    if (state.node) play(t);
    else { state.offset = t; updateDeck(t); }
  }

  function currentTime() {
    if (state.node) return Math.max(0, state.ctx.currentTime - state.startedAt);
    return state.offset;
  }

  function updateDeck(t) {
    const r = state.result && !state.dirty ? state.result : null;
    const dur = r ? r.duration : 0;
    $("np-time").textContent = `${fmt(t)} / ${fmt(dur)}`;
    const frac = dur ? Math.min(1, t / dur) : 0;
    $("progress-fill").style.width = `${(frac * 100).toFixed(2)}%`;
    $("progress").setAttribute("aria-valuenow", Math.round(frac * 100));
    if (r && state.sources.length) {
      const col = t / r.p.noteLen, total = r.p.columns * r.matrices.length;
      const frame = Math.min(r.matrices.length - 1, Math.floor(col / r.p.columns));
      $("np-title").textContent = state.sources[frame]?.name ?? "";
      if (state.node) {
        paintViz(Math.min(col, total));
        setActiveThumb(col < total ? frame : -1);
        setLabel(frame);
      }
    } else if (state.sources.length) {
      $("np-title").textContent = state.sources[0].name;
    }
  }

  function updateButtons() {
    const playing = !!state.node;
    const play = $("btn-play");
    play.textContent = playing ? "❚❚" : "▶";
    play.setAttribute("aria-label", playing ? "Pause" : "Play");
    play.classList.toggle("on", playing);
    $("btn-stop").disabled = !(playing || state.paused);
    $("btn-wav").disabled = $("btn-mid").disabled = !(state.result && !state.dirty);
    $("pp-name").textContent = state.preset >= 0 ? PRESETS[state.preset].name : "Custom";
  }

  // ------------------------------------------------------------------------ //
  // Sources
  // ------------------------------------------------------------------------ //
  // state.all = everything loaded; state.sources = the images that are switched on (they play in order)
  function setSources(list, fromRecord = false) {
    if (!fromRecord) { // EPIC / own files: put the demo record back into the magazine
      state.record = -1;
      carousel?.drop();
      renderRecords();
    }
    list.forEach((src) => (src.on = true));
    state.all = list;
    const vinyl = $("vinyl");
    vinyl.classList.remove("spinning", "paused", "loaded");
    void vinyl.offsetWidth; // restart the "record drops in" transition
    vinyl.classList.toggle("loaded", list.length > 0);
    applySelection();
  }

  function applySelection() {
    stop();
    state.sources = state.all.filter((src) => src.on);
    state.result = null;
    state.dirty = true;
    labelIdx = -1;
    setLabel(0);
    renderThumbs();
    updateButtons();
    updateDeck(0);
    drawViz();
  }

  function renderThumbs() {
    const multi = state.all.length > 1;
    $("thumbs-bar").hidden = !multi;
    if (multi) $("thumbs-count").textContent = `${state.sources.length} of ${state.all.length} selected · click a picture to play it`;
    $("thumbs").replaceChildren(...state.all.map((src) => {
      const fig = document.createElement("figure");
      fig.classList.toggle("off", !src.on);
      const img = new Image();
      img.src = src.thumb; img.alt = src.name;
      img.title = "Play this image";
      img.addEventListener("click", () => playImage(src));
      fig.append(img);
      if (multi) {
        const t = document.createElement("button");
        t.type = "button";
        t.className = "pick";
        t.textContent = src.on ? "✓" : "+";
        t.title = src.on ? "Leave this image out" : "Add this image";
        t.setAttribute("aria-pressed", String(src.on));
        t.setAttribute("aria-label", `${src.on ? "Leave out" : "Add"} ${src.name}`);
        t.addEventListener("click", () => {
          if (src.on && state.sources.length === 1) { setStatus("At least one image has to stay selected.", true); return; }
          src.on = !src.on;
          applySelection();
        });
        fig.append(t);
      }
      const cap = document.createElement("figcaption");
      cap.textContent = src.name.split(" · ").pop(); // album frames: just the time/date
      cap.title = src.name;
      fig.append(cap);
      return fig;
    }));
  }

  function selectAll(on) {
    state.all.forEach((src, i) => (src.on = on || i === 0));
    applySelection();
  }

  // play one particular image: switch it on if needed, then start from its first beat
  function playImage(src) {
    ensureCtx();
    if (!src.on) { src.on = true; applySelection(); }
    const idx = state.sources.indexOf(src);
    const p = readParams();
    setLabel(idx);
    play(idx * p.columns * p.noteLen);
  }

  function setActiveThumb(i) {
    const cur = state.sources[i];
    [...$("thumbs").children].forEach((f, k) => f.classList.toggle("active", !!cur && state.all[k] === cur));
  }

  async function loadFiles(fileList) {
    const files = [...fileList].filter((f) => f.type.startsWith("image/") || /\.(png|jpe?g|webp|gif|bmp|avif|ico)$/i.test(f.name))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (!files.length) { setStatus("No supported image files.", true); return; }
    setStatus(`Loading ${files.length} file(s)…`);
    const out = [], bad = [];
    for (const f of files) {
      try { out.push(await blobToSource(f, f.name)); } catch { bad.push(f.name); }
    }
    setSources(out);
    setStatus(out.length
      ? `Loaded ${out.length} image(s). Press play.` + (bad.length ? ` Skipped (unsupported format): ${bad.join(", ")}` : "")
      : "Your browser can't read these files.", !out.length);
  }

  // epic.gsfc.nasa.gov does not send CORS headers for images, so pixels can't be read from it directly.
  // 1) api.nasa.gov (CORS, needs a key; DEMO_KEY is ~10 requests/hour per IP)
  // 2) fallback: wsrv.nl image proxy (CORS) pulling the same file from the EPIC archive
  let useProxy = false;
  async function fetchEpicImage(coll, y, m, d, name, key) {
    const path = `${coll}/${y}/${m}/${d}/jpg/${name}.jpg`;
    if (!useProxy) {
      try {
        const r = await fetch(`https://api.nasa.gov/EPIC/archive/${path}?api_key=${encodeURIComponent(key)}`);
        if (r.ok) return await r.blob();
        if (r.status === 403 && key !== "DEMO_KEY") throw new Error("Invalid NASA API key (403).");
      } catch (e) {
        if (/Invalid NASA API key/.test(e.message)) throw e;
      }
      useProxy = true; // rate-limited or unreachable – stay on the proxy for this session
    }
    const r = await fetch(`https://wsrv.nl/?url=${encodeURIComponent(`epic.gsfc.nasa.gov/archive/${path}`)}&w=${MAX_SOURCE_SIDE}`);
    if (!r.ok) throw new Error(`Image download failed (HTTP ${r.status}). Try again later or use your own API key.`);
    return await r.blob();
  }

  let loading = false;
  async function loadEpic() {
    if (loading) return false;
    const date = $("epic-date").value;
    const coll = $("epic-coll").value;
    const n = +$("epic-n").value;
    const key = $("epic-key").value.trim() || "DEMO_KEY";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { setStatus("Enter a valid date.", true); return false; }
    loading = true;
    $("btn-epic").disabled = $("btn-earth").disabled = true;
    try {
      setStatus("Contacting DSCOVR… fetching the EPIC image list");
      const res = await fetch(`https://epic.gsfc.nasa.gov/api/${coll}/date/${date}`);
      if (!res.ok) throw new Error(`EPIC API: HTTP ${res.status}`);
      const meta = await res.json();
      if (!meta.length) { setStatus("No images for this date – try another one.", true); return false; }
      const k = Math.min(n, meta.length);
      const idx = Array.from({ length: k }, (_, i) => (k === 1 ? 0 : Math.floor((i * (meta.length - 1)) / (k - 1))));
      const [y, m, d] = date.split("-");
      const out = [];
      for (const [i, j] of idx.entries()) {
        const name = meta[j].image;
        setStatus(`Downloading Earth ${i + 1}/${k}…`);
        const time = (meta[j].date || "").split(" ")[1] || name;
        out.push(await blobToSource(await fetchEpicImage(coll, y, m, d, name, key), `Earth · ${date} ${time.slice(0, 5)} UTC`));
      }
      setSources(out);
      setStatus(`Fetched ${out.length} photo(s) of Earth from ${date}.`);
      return true;
    } catch (e) {
      const msg = e.message || String(e);
      setStatus(/Failed to fetch|NetworkError|Load failed/i.test(msg)
        ? "Couldn't reach NASA – check your internet connection or turn off an ad/privacy blocker for this page, then try again."
        : msg, true);
      return false;
    } finally {
      loading = false;
      $("btn-epic").disabled = $("btn-earth").disabled = false;
    }
  }

  // random date with EPIC data (archive starts mid-2015; a few days of lag)
  function randomEpicDate() {
    const start = Date.UTC(2015, 6, 1), end = Date.now() - 7 * 864e5;
    return new Date(start + Math.random() * (end - start)).toISOString().slice(0, 10);
  }

  // ------------------------------------------------------------------------ //
  // Demo records (NASA GMAO / GPM global maps) and the record magazine
  // ------------------------------------------------------------------------ //
  // Every record is an album of 5 frames (records/<id>/1.webp … 5.webp) that play one after another.
  const GMAO_HOURS = ["05:00", "06:00", "07:00", "08:00", "09:00"].map((h) => `${h} EDT`); // 29 Oct 2026
  const RECORDS = [
    { id: "clouds", title: "Clouds & Rain", sub: "NASA GMAO · precipitation and clouds · 29 Oct 2026", preset: "Classic", frames: GMAO_HOURS },
    { id: "winds", title: "Surface Winds", sub: "NASA GMAO · near-surface wind speed · 29 Oct 2026", preset: "Ambient", frames: GMAO_HOURS },
    { id: "co", title: "Carbon Monoxide", sub: "NASA GMAO · carbon monoxide in the air · 29 Oct 2026", preset: "Dark", frames: GMAO_HOURS },
    { id: "rain", title: "Rain Anomaly", sub: "NASA GPM IMERG · precipitation anomaly · 1–5 Jul 2024", preset: "Music box",
      frames: ["01", "02", "03", "04", "05"].map((d) => `${+d} Jul 2024`) },
    { id: "temp", title: "Surface Temperature", sub: "NASA GMAO · near-surface air temperature · 29 Oct 2026", preset: "Dreamy", frames: GMAO_HOURS },
    { id: "ozone", title: "Surface Ozone", sub: "NASA GMAO · near-surface ozone · 29 Oct 2026", preset: "Mystery", frames: GMAO_HOURS },
  ];
  const SLOTS = [0, 4, 8, 12, 16, 20]; // where the labelled records sit in the 24-slot magazine
  state.record = -1;

  // Opened straight from disk (file://)? Browsers block fetch() of local files there,
  // so the demo images come from a script with data URIs instead.
  let embedded = null;
  function recordUrl(path) {
    if (location.protocol !== "file:") return Promise.resolve(`records/${path}.webp`);
    embedded ||= new Promise((res, rej) => {
      const s = Object.assign(document.createElement("script"), { src: "records/embedded.js" });
      s.onload = () => res(window.JUKEBOX_RECORDS || {});
      s.onerror = () => rej(new Error("Couldn't load the demo records from disk."));
      document.head.append(s);
    });
    return embedded.then((m) => m[path]);
  }

  const recCache = new Map();
  function loadRecord(r) {
    if (!recCache.has(r.id)) {
      const p = Promise.all(r.frames.map((when, k) => recordUrl(`${r.id}/${k + 1}`)
        .then((url) => fetch(url))
        .then((res) => { if (!res.ok) throw new Error(`Couldn't load record (HTTP ${res.status}).`); return res.blob(); })
        .then((b) => blobToSource(b, `${r.title} · ${when}`))));
      p.catch(() => recCache.delete(r.id));
      recCache.set(r.id, p);
    }
    return recCache.get(r.id);
  }

  const labelImgs = RECORDS.map((r) => Object.assign(new Image(), { src: `records/${r.id}-label.webp` }));
  const carousel = window.Carousel
    ? new window.Carousel($("carousel"), {
        slots: RECORDS.map((r, i) => ({ slot: SLOTS[i], label: labelImgs[i], title: r.title })),
        onPick: (i) => pickRecord(i),
      })
    : null;

  function renderRecords() {
    const root = $("records");
    if (!root.children.length) {
      RECORDS.forEach((r, i) => {
        const b = document.createElement("button");
        b.className = "rec";
        b.title = r.sub;
        b.innerHTML = `<span class="disc"><span style="background-image:url('records/${r.id}-label.webp')"></span></span>
          <span>${r.title}<small>${r.sub.split(" · ")[0]}</small></span>`;
        b.addEventListener("click", () => pickRecord(i));
        root.append(b);
      });
    }
    [...root.children].forEach((b, i) => b.setAttribute("aria-pressed", String(i === state.record)));
  }

  let pickToken = 0;
  async function pickRecord(i, autoplay = true) {
    const token = ++pickToken;
    if (autoplay) ensureCtx(); // inside the click → audio is allowed to start later
    stop();
    state.record = i;
    renderRecords();
    const r = RECORDS[i];
    const pi = PRESETS.findIndex((p) => p.name === r.preset);
    if (pi >= 0) applyPreset(pi);
    $("vinyl").classList.remove("loaded", "spinning"); // the old record goes back
    setStatus(`Picking “${r.title}”…`);
    try {
      const [album] = await Promise.all([loadRecord(r), carousel ? carousel.select(i) : null]);
      if (token !== pickToken) return;
      setSources(album, true);
      setStatus(`${r.title} – ${r.sub}`);
      if (autoplay) play(0);
    } catch (e) {
      if (token === pickToken) setStatus(e.message || String(e), true);
    }
  }

  // ------------------------------------------------------------------------ //
  // Start
  // ------------------------------------------------------------------------ //
  buildParams();
  buildHelp();
  $("sel-all").addEventListener("click", () => selectAll(true));
  $("sel-one").addEventListener("click", () => selectAll(false));
  buildPresets();
  applyPreset(0);
  $("btn-reset").addEventListener("click", () => applyPreset(lastPreset));
  $("epic-date").max = new Date().toISOString().slice(0, 10);
  $("epic-n").addEventListener("input", (e) => ($("epic-n-val").textContent = e.target.value));
  $("btn-epic").addEventListener("click", () => { ensureCtx(); loadEpic(); });
  $("file-input").addEventListener("change", (e) => loadFiles(e.target.files));
  const drop = $("drop");
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); loadFiles(e.dataTransfer.files); });
  document.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => {
    document.querySelectorAll("[data-tab]").forEach((x) => x.setAttribute("aria-selected", x === b));
    $("tab-epic").hidden = b.dataset.tab !== "epic";
    $("tab-files").hidden = b.dataset.tab !== "files";
  }));

  // deck (gold panel)
  $("btn-play").addEventListener("click", togglePlay);
  $("vinyl").addEventListener("click", togglePlay);
  $("btn-stop").addEventListener("click", stop);
  $("btn-earth").addEventListener("click", () => {
    ensureCtx();
    if (state.sources.length) $("epic-date").value = randomEpicDate(); // new random day each press
    loadEpic().then((ok) => ok && play(0));
  });
  const step = (d) => applyPreset((Math.max(0, state.preset < 0 ? lastPreset : state.preset) + d + PRESETS.length) % PRESETS.length);
  $("pp-prev").addEventListener("click", () => step(-1));
  $("pp-next").addEventListener("click", () => step(1));
  const prog = $("progress");
  prog.addEventListener("click", (e) => {
    const r = prog.getBoundingClientRect();
    seek(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)));
  });
  prog.addEventListener("keydown", (e) => {
    if (!state.result) return;
    const d = state.result.duration, t = currentTime();
    if (e.key === "ArrowRight") seek(Math.min(1, (t + 5) / d));
    if (e.key === "ArrowLeft") seek(Math.max(0, (t - 5) / d));
  });
  document.addEventListener("keydown", (e) => {
    if (e.code === "Space" && !/INPUT|SELECT|TEXTAREA|BUTTON/.test(document.activeElement.tagName)) {
      e.preventDefault();
      togglePlay();
    }
  });
  $("btn-wav").addEventListener("click", () => state.result && download(wavBlob(state.result.L, state.result.R), "jukebox.wav"));
  $("btn-mid").addEventListener("click", () => state.result && download(midiBlob(state.result.matrices, state.result.midi, state.result.p), "jukebox.mid"));
  window.addEventListener("resize", () => paintViz(-1));
  paintViz(-1);
  updateButtons();
  renderRecords();
  pickRecord(0, false); // first record comes up on load, ready to play

  (function loop() {
    updateAudio();
    if (carousel) carousel.playing = !!state.node;
    if (state.node) updateDeck(currentTime());
    requestAnimationFrame(loop);
  })();

  window.jukebox = {
    audio: () => audio, // read by space.js (particle background)
    playing: () => !!state.node,
    _internals: { blobToSource, toMatrix, rowToMidi, renderFrames, addReverb, normalize, midiBlob, SCALES, DEFAULTS },
  };
})();
