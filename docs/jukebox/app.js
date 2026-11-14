/* Kosmiczny Jukebox – sonifikacja obrazów (port jukebox_test.py do przeglądarki).
 * X = czas, Y = wysokość dźwięku, jasność = głośność, nuty dopasowane do skali. */
(() => {
  "use strict";

  const SR = 44100;
  const MAX_SOURCE_SIDE = 1024; // źródła są zmniejszane przy wczytaniu (macierz ma max 192x48)

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

  const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const midiName = (m) => NOTE_NAMES[m % 12] + (Math.floor(m / 12) - 1);

  const PARAMS = [
    { id: "scale", label: "Skala", type: "select", options: Object.keys(SCALES), value: "lydian" },
    { id: "columns", label: "Kolumny (czas)", min: 16, max: 192, step: 8, value: 128 },
    { id: "rows", label: "Wiersze (wysokości)", min: 8, max: 48, step: 2, value: 46 },
    { id: "noteLen", label: "Długość kroku [s]", min: 0.05, max: 0.5, step: 0.01, value: 0.18 },
    { id: "rootMidi", label: "Najniższa nuta", min: 24, max: 72, step: 1, value: 45, fmt: (v) => `${v} (${midiName(v)})` },
    { id: "maxVoices", label: "Maks. głosów naraz", min: 1, max: 10, step: 1, value: 8 },
    { id: "threshold", label: "Próg jasności", min: 0, max: 0.9, step: 0.05, value: 0.25 },
    { id: "gamma", label: "Gamma (kontrast głośności)", min: 0.5, max: 3, step: 0.1, value: 1.5 },
    { id: "lowPct", label: "Dolny percentyl", min: 0, max: 20, step: 0.5, value: 1 },
    { id: "highPct", label: "Górny percentyl", min: 80, max: 100, step: 0.5, value: 100 },
    { id: "reverb", label: "Pogłos", type: "check", value: true },
  ];

  // ------------------------------------------------------------------------ //
  // DOM
  // ------------------------------------------------------------------------ //
  const $ = (id) => document.getElementById(id);
  const statusEl = $("status");
  const setStatus = (msg, isError = false) => {
    statusEl.textContent = msg;
    statusEl.classList.toggle("error", isError);
  };

  const state = {
    sources: [],   // { name, gray: Float32Array, w, h, thumb }
    result: null,  // { left, right, matrices, midi, p }
    ctx: null,
    analyser: null,
    node: null,
    startedAt: 0,
    dirty: true,
  };

  function buildParams() {
    const root = $("params");
    for (const p of PARAMS) {
      const label = document.createElement("label");
      let input;
      if (p.type === "select") {
        label.textContent = p.label;
        input = document.createElement("select");
        for (const o of p.options) input.add(new Option(o.replace(/_/g, " "), o, false, o === p.value));
        label.append(input);
      } else if (p.type === "check") {
        label.className = "check";
        input = document.createElement("input");
        input.type = "checkbox";
        input.checked = p.value;
        label.append(input, p.label);
      } else {
        const head = document.createElement("span");
        head.className = "row";
        const val = document.createElement("span");
        val.className = "val";
        head.append(p.label, val);
        input = document.createElement("input");
        Object.assign(input, { type: "range", min: p.min, max: p.max, step: p.step, value: p.value });
        const show = () => (val.textContent = p.fmt ? p.fmt(+input.value) : input.value);
        input.addEventListener("input", show);
        show();
        label.append(head, input);
      }
      input.id = "p-" + p.id;
      input.addEventListener("input", () => { state.dirty = true; updateButtons(); drawViz(); });
      root.append(label);
    }
  }

  function readParams() {
    const out = {};
    for (const p of PARAMS) {
      const el = $("p-" + p.id);
      out[p.id] = p.type === "select" ? el.value : p.type === "check" ? el.checked : +el.value;
    }
    return out;
  }

  // ------------------------------------------------------------------------ //
  // Obraz -> szarość (alfa składana na czarnym tle, jak w wersji Python)
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
    const tc = document.createElement("canvas");
    const ts = 192 / Math.max(w, h);
    tc.width = Math.round(w * ts); tc.height = Math.round(h * ts);
    tc.getContext("2d").drawImage(cv, 0, 0, tc.width, tc.height);
    return { name, gray, w, h, thumb: tc.toDataURL("image/jpeg", 0.8) };
  }

  // Uśrednianie bloków pikseli (odpowiednik resize BOX), z ułamkowym pokryciem.
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

  function percentile(sorted, p) { // jak np.percentile (interpolacja liniowa)
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
  // Wysokości dźwięków
  // ------------------------------------------------------------------------ //
  function rowToMidi(rows, scale, root) { // 0 = góra obrazu = najwyższy dźwięk
    const notes = [];
    for (let i = 0; i < rows; i++) {
      const oct = Math.floor(i / scale.length), deg = i % scale.length;
      notes.push(root + 12 * oct + scale[deg]);
    }
    return notes.reverse();
  }
  const midiToFreq = (m) => 440 * 2 ** ((m - 69) / 12);

  // ------------------------------------------------------------------------ //
  // Synteza
  // ------------------------------------------------------------------------ //
  function synthNote(freq, duration, harmonics = [1.0, 0.45, 0.25, 0.12]) {
    const n = Math.floor(duration * SR);
    const out = new Float32Array(n);
    const tau = duration * 0.35;
    const fade = Math.min(Math.floor(0.01 * SR), n);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      let v = 0;
      for (let k = 0; k < harmonics.length; k++) {
        const f = freq * (k + 1);
        if (f < SR / 2) v += harmonics[k] * Math.sin(2 * Math.PI * f * t);
      }
      let env = Math.min(t / 0.01, 1) * Math.exp(-t / tau);
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

  function renderFrames(matrices, midi, p, tailFactor = 3.0) {
    const { rows, columns: cols, noteLen, maxVoices, threshold, gamma } = p;
    const totalCols = cols * matrices.length;
    const step = Math.floor(noteLen * SR);
    const tail = Math.floor(noteLen * tailFactor * SR);
    const len = totalCols * step + tail + SR;
    const L = new Float32Array(len), R = new Float32Array(len);

    // wszystkie nuty mają tę samą długość – każdy wiersz liczymy tylko raz
    const notes = midi.map((m) => synthNote(midiToFreq(m), noteLen * tailFactor));
    const gl = [], gr = [];
    for (let r = 0; r < rows; r++) {
      const pan = 0.8 - (0.6 * r) / Math.max(1, rows - 1); // niskie w lewo, wysokie w prawo
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

  function addReverb(ch, decay = 0.35, delaysMs = [37, 53, 79, 113]) {
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
  // Eksport WAV / MIDI
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
    const tempo = Math.round(noteLen * 1e6); // jedna kolumna = jedno uderzenie
    ev.push(...vlq(0), 0xff, 0x51, 0x03, (tempo >> 16) & 0xff, (tempo >> 8) & 0xff, tempo & 0xff);
    for (const mat of matrices) {
      for (let c = 0; c < cols; c++) {
        const chosen = topVoices(mat, cols, rows, c, maxVoices, threshold);
        for (const r of chosen) ev.push(...vlq(0), 0x90, midi[r], Math.floor(30 + 97 * mat[r * cols + c]));
        chosen.forEach((r, i) => ev.push(...vlq(i === 0 ? tpb : 0), 0x80, midi[r], 0));
        if (!chosen.length) ev.push(...vlq(tpb), 0x80, 0, 0); // pauza
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
  // Wizualizacja macierzy (paleta "magma")
  // ------------------------------------------------------------------------ //
  const MAGMA = [[0, 0, 4], [28, 16, 68], [79, 18, 123], [129, 37, 129], [181, 54, 122],
                 [229, 80, 100], [251, 135, 97], [254, 194, 135], [252, 253, 191]];
  function magma(v) {
    const x = Math.min(1, Math.max(0, v)) * (MAGMA.length - 1);
    const i = Math.min(MAGMA.length - 2, Math.floor(x)), f = x - i;
    return MAGMA[i].map((a, k) => a + (MAGMA[i + 1][k] - a) * f);
  }

  let vizImage = null; // offscreen canvas totalCols x rows
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
        const [R, G, B] = magma(m[r * cols + c]);
        const o = (r * W + f * cols + c) * 4;
        img.data[o] = R; img.data[o + 1] = G; img.data[o + 2] = B; img.data[o + 3] = 255;
      }
    });
    g.putImageData(img, 0, 0);
    vizImage = { cv, frames: matrices.length, cols };
  }

  let vizTimer = 0;
  function drawViz() { // przelicza podgląd z lekkim opóźnieniem (suwaki)
    clearTimeout(vizTimer);
    vizTimer = setTimeout(() => {
      if (!state.sources.length) return;
      const { p, matrices } = currentMatrices();
      buildVizImage(matrices, p);
      paintViz(-1);
    }, 60);
  }

  function paintViz(playCol) {
    const cv = $("viz");
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(cv.clientWidth * dpr), h = Math.round(cv.clientHeight * dpr);
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
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
  // Odtwarzanie
  // ------------------------------------------------------------------------ //
  function stop() {
    if (state.node) { try { state.node.stop(); } catch {} state.node.disconnect(); state.node = null; }
    updateButtons();
  }

  async function generateAndPlay() {
    if (!state.sources.length) return;
    stop();
    if (state.dirty || !state.result) {
      setStatus("Generowanie muzyki…");
      await new Promise((r) => setTimeout(r, 30));
      const t0 = performance.now();
      const { p, matrices } = currentMatrices();
      const midi = rowToMidi(p.rows, SCALES[p.scale], p.rootMidi);
      let [L, R] = renderFrames(matrices, midi, p);
      if (p.reverb) { L = addReverb(L); R = addReverb(R); }
      normalize(L, R);
      state.result = { L, R, matrices, midi, p };
      state.dirty = false;
      buildVizImage(matrices, p);
      console.debug(`render ${(performance.now() - t0).toFixed(0)} ms`);
    }
    const { L, R, matrices, p } = state.result;

    if (!state.ctx) {
      state.ctx = new (window.AudioContext || window.webkitAudioContext)();
      state.analyser = state.ctx.createAnalyser();
      state.analyser.fftSize = 1024;
      state.analyser.connect(state.ctx.destination);
    }
    await state.ctx.resume();
    const buf = state.ctx.createBuffer(2, L.length, SR);
    buf.copyToChannel(L, 0);
    buf.copyToChannel(R, 1);
    const node = state.ctx.createBufferSource();
    node.buffer = buf;
    node.connect(state.analyser);
    node.onended = () => { if (state.node === node) { state.node = null; updateButtons(); paintViz(-1); setActiveThumb(-1); } };
    state.node = node;
    state.startedAt = state.ctx.currentTime + 0.05;
    node.start(state.startedAt);
    setStatus(`Gra: ${state.sources.length} obraz(ów), ${matrices.length} klatek, ~${(L.length / SR).toFixed(1)} s`);
    updateButtons();
    requestAnimationFrame(function tick() {
      if (state.node !== node) return;
      const col = Math.max(0, (state.ctx.currentTime - state.startedAt) / p.noteLen);
      const total = p.columns * matrices.length;
      paintViz(Math.min(col, total));
      setActiveThumb(col < total ? Math.floor(col / p.columns) : -1);
      requestAnimationFrame(tick);
    });
  }

  // poziom głośności dla modelu 3D (0..1)
  const levelBuf = new Float32Array(1024);
  window.jukebox = {
    level() {
      if (!state.analyser || !state.node) return 0;
      state.analyser.getFloatTimeDomainData(levelBuf);
      let s = 0;
      for (let i = 0; i < levelBuf.length; i++) s += levelBuf[i] * levelBuf[i];
      return Math.min(1, Math.sqrt(s / levelBuf.length) * 3);
    },
    playing: () => !!state.node,
    play: () => generateAndPlay(),
    stop: () => stop(),  };

  function updateButtons() {
    const has = state.sources.length > 0;
    $("btn-play").disabled = !has;
    $("btn-play").textContent = state.node ? "↻ Od nowa" : "▶ Generuj i graj";
    $("btn-stop").disabled = !state.node;
    $("btn-wav").disabled = $("btn-mid").disabled = !(state.result && !state.dirty);
  }

  // ------------------------------------------------------------------------ //
  // Źródła
  // ------------------------------------------------------------------------ //
  function setSources(list) {
    stop();
    state.sources = list;
    state.result = null;
    state.dirty = true;
    const root = $("thumbs");
    root.replaceChildren(...list.map((s) => {
      const fig = document.createElement("figure");
      const img = new Image();
      img.src = s.thumb; img.alt = s.name;
      const cap = document.createElement("figcaption");
      cap.textContent = s.name;
      cap.title = s.name;
      fig.append(img, cap);
      return fig;
    }));
    updateButtons();
    drawViz();
  }

  function setActiveThumb(i) {
    [...$("thumbs").children].forEach((f, k) => f.classList.toggle("active", k === i));
  }

  async function loadFiles(fileList) {
    const files = [...fileList].filter((f) => f.type.startsWith("image/") || /\.(png|jpe?g|webp|gif|bmp|avif|ico)$/i.test(f.name))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (!files.length) { setStatus("Brak obsługiwanych plików graficznych.", true); return; }
    setStatus(`Wczytywanie ${files.length} plik(ów)…`);
    const out = [], bad = [];
    for (const f of files) {
      try { out.push(await blobToSource(f, f.name)); } catch { bad.push(f.name); }
    }
    setSources(out);
    setStatus(out.length
      ? `Wczytano ${out.length} obraz(ów).` + (bad.length ? ` Pominięto (nieobsługiwany format): ${bad.join(", ")}` : "")
      : "Przeglądarka nie potrafi odczytać tych plików.", !out.length);
  }

  async function loadEpic() {
    const date = $("epic-date").value;
    const coll = $("epic-coll").value;
    const n = +$("epic-n").value;
    const key = $("epic-key").value.trim() || "DEMO_KEY";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { setStatus("Podaj poprawną datę.", true); return; }
    const btn = $("btn-epic");
    btn.disabled = true;
    try {
      setStatus("Pobieranie listy zdjęć z EPIC…");
      const res = await fetch(`https://epic.gsfc.nasa.gov/api/${coll}/date/${date}`);
      if (!res.ok) throw new Error(`API EPIC: HTTP ${res.status}`);
      const meta = await res.json();
      if (!meta.length) { setStatus("Brak zdjęć dla tej daty – spróbuj innej.", true); return; }
      const k = Math.min(n, meta.length);
      const idx = Array.from({ length: k }, (_, i) => (k === 1 ? 0 : Math.floor((i * (meta.length - 1)) / (k - 1))));
      const [y, m, d] = date.split("-");
      const out = [];
      for (const [i, j] of idx.entries()) {
        const name = meta[j].image;
        setStatus(`Pobieranie klatki ${i + 1}/${k}: ${name}…`);
        const url = `https://api.nasa.gov/EPIC/archive/${coll}/${y}/${m}/${d}/jpg/${name}.jpg?api_key=${encodeURIComponent(key)}`;
        const r = await fetch(url);
        if (r.status === 429) throw new Error("Przekroczono limit zapytań klucza API (429). Użyj własnego klucza z api.nasa.gov albo spróbuj później.");
        if (r.status === 403) throw new Error("Nieprawidłowy klucz API (403).");
        if (!r.ok) throw new Error(`Pobieranie obrazu: HTTP ${r.status}`);
        const time = (meta[j].date || "").split(" ")[1] || name;
        out.push(await blobToSource(await r.blob(), `${String(i).padStart(2, "0")} · ${time}`));
      }
      setSources(out);
      setStatus(`Pobrano ${out.length} klatek z ${date}. Naciśnij „Generuj i graj”.`);
    } catch (e) {
      setStatus(e.message || String(e), true);
    } finally {
      btn.disabled = false;
    }
  }

  // ------------------------------------------------------------------------ //
  // Start
  // ------------------------------------------------------------------------ //
  buildParams();
  $("epic-date").max = new Date().toISOString().slice(0, 10);
  $("epic-n").addEventListener("input", (e) => ($("epic-n-val").textContent = e.target.value));
  $("btn-epic").addEventListener("click", loadEpic);
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
  $("btn-play").addEventListener("click", generateAndPlay);
  $("btn-stop").addEventListener("click", stop);
  $("btn-wav").addEventListener("click", () => state.result && download(wavBlob(state.result.L, state.result.R), "jukebox.wav"));
  $("btn-mid").addEventListener("click", () => state.result && download(midiBlob(state.result.matrices, state.result.midi, state.result.p), "jukebox.mid"));
  window.addEventListener("resize", () => paintViz(-1));
  paintViz(-1);
})();
