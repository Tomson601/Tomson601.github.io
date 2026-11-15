/* Video export for JukeBox.
 * The page itself is HTML and can't be filmed, so every frame is composed on a hidden canvas
 * from the same layers: starfield, music-reactive nebula, glow, jukebox artwork, record magazine,
 * spinning vinyl with its label and the "now playing" text on the gold panel.
 *
 * Fast mode (WebCodecs + vendor/mp4-muxer.min.js): the frames are rendered offline, as fast as the
 * computer can, from the finished audio – the music is analysed the same way as the live analyser –
 * then encoded to H.264 + AAC (or Opus) and written to an MP4 file. Nothing has to play.
 * Fallback (older browsers): the canvas stream + the audio output are recorded in real time with
 * MediaRecorder. */
(() => {
  "use strict";

  const FORMATS = {
    wide: { w: 1920, h: 1080 },
    square: { w: 1080, h: 1080 },
    tall: { w: 1080, h: 1920 },
  };
  const TYPES = [
    "video/mp4;codecs=avc1.640028,mp4a.40.2",
    "video/mp4;codecs=avc1.4d0028,mp4a.40.2",
    "video/mp4;codecs=avc1,mp4a",
    "video/mp4",
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ];
  const IMG_W = 1440, IMG_H = 1030;
  const FPS = 30;

  function pickType() {
    if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) return null;
    return TYPES.find((t) => MediaRecorder.isTypeSupported(t)) || null;
  }
  const canFast = () => !!(window.VideoEncoder && window.AudioEncoder && window.VideoFrame && window.AudioData && window.Mp4Muxer);

  // ---- drawing helpers ----
  function cover(g, src, W, H) { // draw a canvas like CSS background-size: cover
    if (!src || !src.width || !src.height) return;
    const s = Math.max(W / src.width, H / src.height);
    const w = src.width * s, h = src.height * s;
    g.drawImage(src, (W - w) / 2, (H - h) / 2, w, h);
  }

  function background(g, W, H) {
    g.fillStyle = "#04030c";
    g.fillRect(0, 0, W, H);
    const blob = (x, y, r, col) => {
      const grd = g.createRadialGradient(x, y, 0, x, y, r);
      grd.addColorStop(0, col); grd.addColorStop(1, "rgba(0,0,0,0)");
      g.fillStyle = grd; g.fillRect(0, 0, W, H);
    };
    const m = Math.max(W, H);
    blob(W * 0.15, H * 0.2, m * 0.55, "rgba(98, 46, 190, 0.32)");
    blob(W * 0.85, H * 0.3, m * 0.5, "rgba(20, 110, 170, 0.28)");
    blob(W * 0.5, H * 1.1, m * 0.5, "rgba(170, 40, 120, 0.25)");
  }

  function logo(g, x, y, size, align = "center") {
    g.save();
    g.font = `${size}px Audiowide, "Russo One", sans-serif`;
    g.textAlign = align; g.textBaseline = "middle";
    const w = g.measureText("JukeBox").width;
    const x0 = align === "center" ? x - w / 2 : x;
    const grd = g.createLinearGradient(x0, 0, x0 + w, 0);
    grd.addColorStop(0, "#ffd38a"); grd.addColorStop(0.5, "#ff8fd0"); grd.addColorStop(1, "#8fe6ff");
    g.shadowColor = "rgba(255, 140, 210, 0.45)"; g.shadowBlur = size * 0.4;
    g.fillStyle = grd;
    g.fillText("JukeBox", x, y);
    g.restore();
  }

  function fitText(g, text, maxW, size, font) {
    let s = size;
    g.font = `${s}px ${font}`;
    while (s > 8 && g.measureText(text).width > maxW) { s -= 1; g.font = `${s}px ${font}`; }
    return s;
  }

  function vinyl(g, cx, cy, R, angle, label) {
    g.save();
    g.translate(cx, cy);
    g.beginPath(); g.arc(0, 0, R, 0, Math.PI * 2); g.fillStyle = "#111"; g.fill();
    g.lineWidth = Math.max(1, R / 90);
    for (let r = R * 0.98; r > R * 0.58; r -= R / 45) { // grooves
      g.beginPath(); g.arc(0, 0, r, 0, Math.PI * 2);
      g.strokeStyle = (Math.round(r) & 1) ? "#1e1a20" : "#141116"; g.stroke();
    }
    g.rotate(angle);
    for (const [a0, a1, al] of [[0.35, 1.2, 0.16], [3.75, 4.35, 0.12]]) { // sheen sweeping with the spin
      const grd = g.createRadialGradient(0, 0, R * 0.55, 0, 0, R);
      grd.addColorStop(0, `rgba(255,255,255,${al * 0.4})`); grd.addColorStop(1, `rgba(255,255,255,${al})`);
      g.beginPath(); g.moveTo(0, 0); g.arc(0, 0, R * 0.99, a0, a1); g.closePath(); g.fillStyle = grd; g.fill();
    }
    g.lineWidth = Math.max(1.5, R / 50); g.strokeStyle = "#2a2328";
    g.beginPath(); g.arc(0, 0, R - g.lineWidth / 2, 0, Math.PI * 2); g.stroke();
    const LR = R * 0.56; // label (inset 22 %)
    g.save();
    g.beginPath(); g.arc(0, 0, LR, 0, Math.PI * 2); g.clip();
    g.fillStyle = "#b3141b"; g.fillRect(-LR, -LR, LR * 2, LR * 2);
    if (label && label.complete && label.naturalWidth) g.drawImage(label, -LR, -LR, LR * 2, LR * 2);
    const sh = g.createRadialGradient(0, 0, LR * 0.75, 0, 0, LR);
    sh.addColorStop(0, "rgba(0,0,0,0)"); sh.addColorStop(1, "rgba(0,0,0,0.45)");
    g.fillStyle = sh; g.fillRect(-LR, -LR, LR * 2, LR * 2);
    g.restore();
    g.beginPath(); g.arc(0, 0, R * 0.05, 0, Math.PI * 2); g.fillStyle = "#0b0a0c"; g.fill();
    g.strokeStyle = "rgba(255,255,255,0.25)"; g.lineWidth = 1; g.stroke();
    g.restore();
  }

  const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

  function layout(W, H, fmtKey) {
    if (fmtKey === "wide") {
      const jh = H * 0.9, jw = jh * (IMG_W / IMG_H);
      return { x: (W - jw) / 2, y: H * 0.02, w: jw, h: jh, logo: { x: W * 0.035, y: H * 0.07, s: H * 0.05, align: "left" }, caption: null };
    }
    const jw = W * 0.98, jh = jw * (IMG_H / IMG_W);
    const y = fmtKey === "square" ? H * 0.15 : (H - jh) / 2 - H * 0.02;
    return {
      x: (W - jw) / 2, y, w: jw, h: jh,
      logo: { x: W / 2, y: fmtKey === "square" ? H * 0.075 : y - H * 0.08, s: W * (fmtKey === "square" ? 0.07 : 0.09), align: "center" },
      caption: { y: y + jh + H * (fmtKey === "square" ? 0.045 : 0.05) },
    };
  }

  /** scene: { stars, space, spaceAlpha, glowA, carousel, info, angle } */
  function drawFrame(g, W, H, L, scene) {
    const { info } = scene;
    background(g, W, H);
    cover(g, scene.stars, W, H);
    if (scene.space) {
      g.globalAlpha = scene.spaceAlpha;
      cover(g, scene.space, W, H);
      g.globalAlpha = 1;
    }
    const P = (fx, fy) => [L.x + L.w * fx, L.y + L.h * fy];

    // glow behind the arch
    if (scene.glowA > 0.01) {
      const [gx, gy] = P(0.2785 + 0.22, 0.0437 + 0.367);
      const rad = Math.min(L.w * 0.22, L.h * 0.367);
      const grd = g.createRadialGradient(gx, gy, 0, gx, gy, rad);
      grd.addColorStop(0, "rgba(255, 200, 120, .7)"); grd.addColorStop(0.55, "rgba(255, 110, 180, .25)"); grd.addColorStop(1, "rgba(0,0,0,0)");
      g.save(); g.globalCompositeOperation = "screen"; g.globalAlpha = scene.glowA;
      g.fillStyle = grd; g.fillRect(gx - rad, gy - rad, rad * 2, rad * 2);
      g.restore();
    }

    const art = scene.art || document.querySelector(".stage img");
    if (art.complete && art.naturalWidth) g.drawImage(art, L.x, L.y, L.w, L.h);
    const car = scene.carousel;
    if (car && car.width) { const [cx, cy] = P(0.25, 0.29126); g.drawImage(car, cx, cy, L.w * 0.50694, L.h * 0.32039); }

    // spinning record
    if (info.loaded) {
      const R = (L.w * 0.2083) / 2;
      const [vx, vy] = P(0.3924, 0.233);
      vinyl(g, vx + R, vy + R, R, scene.angle, info.label);
    }

    // "now playing" on the gold panel
    const [dx, dy] = P(0.0667, 0.6184);
    const dw = L.w * 0.868, dh = L.h * 0.3117;
    const ink = "#5a2a0e";
    g.save();
    g.textBaseline = "middle";
    const font = 'Audiowide, "Russo One", sans-serif';
    const ts = fitText(g, info.title, dw * 0.56, dh * 0.17, font);
    g.font = `${ts}px ${font}`;
    g.fillStyle = ink; g.textAlign = "left";
    g.shadowColor = "rgba(255, 236, 190, .55)"; g.shadowOffsetY = 1;
    g.fillText(info.title, dx + dw * 0.08, dy + dh * 0.3);
    g.font = `${dh * 0.12}px ${font}`; g.textAlign = "right";
    g.fillText(`${fmt(info.time)} / ${fmt(info.duration)}`, dx + dw * 0.92, dy + dh * 0.3);
    g.shadowColor = "transparent";
    // progress bar
    const bx = dx + dw * 0.08, by = dy + dh * 0.52, bw = dw * 0.84, bh = dh * 0.065;
    const round = (x, y, w, h) => { g.beginPath(); g.roundRect ? g.roundRect(x, y, w, h, h / 2) : g.rect(x, y, w, h); };
    round(bx, by, bw, bh); g.fillStyle = "rgba(90, 42, 14, 0.35)"; g.fill();
    const frac = info.duration ? Math.min(1, info.time / info.duration) : 0;
    if (frac > 0) {
      const grd = g.createLinearGradient(bx, 0, bx + bw, 0);
      grd.addColorStop(0, "#c8281e"); grd.addColorStop(1, "#ffb35c");
      round(bx, by, Math.max(bh, bw * frac), bh); g.fillStyle = grd; g.fill();
    }
    // preset · beat line under the progress bar
    if (info.line) {
      g.font = `${fitText(g, info.line, dw * 0.8, dh * 0.1, "Inter, sans-serif")}px Inter, sans-serif`;
      g.textAlign = "center"; g.fillStyle = "rgba(90, 42, 14, 0.85)";
      g.fillText(info.line, dx + dw / 2, dy + dh * 0.76);
    }
    g.restore();

    logo(g, L.logo.x, L.logo.y, L.logo.s, L.logo.align);
    if (L.caption && info.sub) {
      g.save();
      g.textAlign = "center"; g.textBaseline = "middle"; g.fillStyle = "rgba(236, 235, 255, 0.85)";
      const s = fitText(g, info.sub, W * 0.9, W * 0.032, "Inter, sans-serif");
      g.font = `${s}px Inter, sans-serif`;
      g.fillText(info.sub, W / 2, L.caption.y);
      g.restore();
    }
  }

  // ------------------------------------------------------------------------ //
  // Offline audio analysis – mirrors the AnalyserNode (fftSize 1024, smoothing 0.55,
  // Blackman window, −100…−30 dB) and updateAudio() in app.js, stepped at 60 Hz.
  // ------------------------------------------------------------------------ //
  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const a = i + k, b = a + len / 2;
          const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
          const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
        }
      }
    }
  }

  function makeAnalyser(mono, sr) {
    const N = 1024, HALF = N / 2, NB = 32;
    const win = new Float32Array(N);
    for (let i = 0; i < N; i++) win[i] = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / N) + 0.08 * Math.cos((4 * Math.PI * i) / N);
    const re = new Float32Array(N), im = new Float32Array(N), smooth = new Float32Array(HALF), bytes = new Float32Array(HALF);
    const binHz = sr / 2 / HALF;
    const ranges = [];
    for (let i = 0; i < NB; i++) {
      const f0 = 40 * (6000 / 40) ** (i / NB), f1 = 40 * (6000 / 40) ** ((i + 1) / NB);
      const b0 = Math.floor(f0 / binHz);
      ranges.push([b0, Math.max(b0 + 1, Math.ceil(f1 / binHz))]);
    }
    const a = { bands: new Float32Array(NB), level: 0, kick: 0 };
    let bassAvg = 0;
    a.step = (t) => {
      const end = Math.round(t * sr), start = end - N;
      let rms = 0;
      for (let i = 0; i < N; i++) {
        const k = start + i;
        const v = k >= 0 && k < mono.length ? mono[k] : 0;
        rms += v * v;
        re[i] = v * win[i]; im[i] = 0;
      }
      rms = Math.min(1, Math.sqrt(rms / N) * 3);
      fft(re, im);
      for (let k = 0; k < HALF; k++) {
        const mag = Math.hypot(re[k], im[k]) / N;
        smooth[k] = 0.55 * smooth[k] + 0.45 * mag;
        const db = 20 * Math.log10(smooth[k] + 1e-12);
        bytes[k] = Math.max(0, Math.min(255, Math.floor((255 * (db + 100)) / 70)));
      }
      for (let i = 0; i < NB; i++) {
        let m = 0;
        for (let b = ranges[i][0]; b < ranges[i][1] && b < HALF; b++) m = Math.max(m, bytes[b]);
        const v = (m / 255) ** 1.5;
        a.bands[i] = v > a.bands[i] ? v : a.bands[i] * 0.88;
      }
      const avg = (x, y) => { let s = 0; for (let i = x; i < y; i++) s += a.bands[i]; return s / (y - x); };
      const bass = avg(0, 8);
      a.level += (rms - a.level) * 0.2;
      if (bass - bassAvg > 0.08 && a.kick < 0.4) a.kick = 1;
      bassAvg += (bass - bassAvg) * 0.05;
      a.kick *= 0.9;
    };
    return a;
  }

  // a yield that background tabs don't throttle (unlike setTimeout)
  const tick = () => new Promise((r) => { const c = new MessageChannel(); c.port1.onmessage = () => r(); c.port2.postMessage(0); });

  async function pickVideoConfig(W, H) {
    for (const codec of ["avc1.640028", "avc1.4d0028", "avc1.42e028", "avc1.640032"]) {
      for (const hardwareAcceleration of ["no-preference", "prefer-software"]) {
        const cfg = { codec, width: W, height: H, bitrate: W * H > 1.5e6 ? 6_000_000 : 5_000_000, framerate: FPS, hardwareAcceleration, avc: { format: "avc" } };
        try { if ((await VideoEncoder.isConfigSupported(cfg)).supported) return cfg; } catch {}
      }
    }
    return null;
  }

  async function pickAudioConfig(sr) {
    const tries = [
      { codec: "mp4a.40.2", mux: "aac", sampleRate: sr },
      { codec: "mp4a.40.2", mux: "aac", sampleRate: 48000 },
      { codec: "opus", mux: "opus", sampleRate: 48000 },
    ];
    for (const t of tries) {
      const cfg = { codec: t.codec, sampleRate: t.sampleRate, numberOfChannels: 2, bitrate: 192_000 };
      try { if ((await AudioEncoder.isConfigSupported(cfg)).supported) return { cfg, mux: t.mux }; } catch {}
    }
    return null;
  }

  async function resample(L, R, from, to) {
    if (from === to) return [L, R];
    const len = Math.ceil((L.length * to) / from);
    const oc = new OfflineAudioContext(2, len, to);
    const b = oc.createBuffer(2, L.length, from);
    b.copyToChannel(L, 0); b.copyToChannel(R, 1);
    const s = oc.createBufferSource(); s.buffer = b; s.connect(oc.destination); s.start();
    const out = await oc.startRendering();
    return [out.getChannelData(0), out.getChannelData(1)];
  }

  /**
   * @param api {
   *   T(key, vars), ctx(), tap(), prepare(), playFromStart(),
   *   info(): live { time, duration, title, sub, line, label, playing, loaded },
   *   offline(): Promise<{ L, R, sr, duration, at(t) → { title, label }, sub, line }>,
   *   carouselAt(phi): canvas, carouselPhi(): number
   * }
   */
  function create(api) {
    const type = pickType();
    const fast = canFast();
    let rec = null; // current job

    // ---------------- fast, offline render ----------------
    async function renderFast(fmtKey, onProgress) {
      const { w: W, h: H } = FORMATS[fmtKey] || FORMATS.wide;
      const [vcfg, job] = await Promise.all([pickVideoConfig(W, H), api.offline()]);
      if (!vcfg) return false; // no H.264 encoder → real-time fallback
      const acfg = await pickAudioConfig(job.sr);
      if (!acfg) return false;
      const r = rec;
      if (!r || r.cancelled) return null;

      const cv = document.createElement("canvas");
      cv.width = W; cv.height = H;
      const g = cv.getContext("2d");
      const L = layout(W, H, fmtKey);
      const bg = window.A11Y?.get("bg") || "full";
      const calm = matchMedia("(prefers-reduced-motion: reduce)").matches || !!window.A11Y?.get("calm");
      const react = bg === "soft" || calm ? 0.35 : 1;

      // nebula on its own WebGL canvas at half the video size, centred on the jukebox like on the page
      let neb = null, nebCv = null;
      if (bg !== "off" && window.JukeboxNebula) {
        nebCv = document.createElement("canvas");
        nebCv.width = Math.round(W / 2); nebCv.height = Math.round(H / 2);
        neb = window.JukeboxNebula.create(nebCv);
      }
      const nebScale = 0.5, cssScale = L.h / 700; // the live page shows the jukebox ~700 px tall
      const energy = new Float32Array(window.JukeboxNebula?.NR || 6);

      const muxer = new Mp4Muxer.Muxer({
        target: new Mp4Muxer.ArrayBufferTarget(),
        video: { codec: "avc", width: W, height: H, frameRate: FPS },
        audio: { codec: acfg.mux, numberOfChannels: 2, sampleRate: acfg.cfg.sampleRate },
        fastStart: "in-memory",
        firstTimestampBehavior: "offset",
      });
      let encErr = null;
      // several video encoders in parallel, each on its own part of the film (software H.264 is the
      // slow step; every part starts with a key frame, so the parts simply follow each other in the file)
      const K = Math.max(1, Math.min(6, Math.floor((navigator.hardwareConcurrency || 4) / 2)));
      const parts = Array.from({ length: K }, () => []);
      const vencs = parts.map((out) => {
        const e = new VideoEncoder({ output: (c, m) => out.push([c, m]), error: (x) => (encErr = x) });
        e.configure(vcfg);
        return e;
      });
      const aenc = new AudioEncoder({ output: (c, m) => muxer.addAudioChunk(c, m), error: (e) => (encErr = e) });
      aenc.configure(acfg.cfg);
      const closeAll = () => {
        for (const e of [...vencs, aenc]) { try { if (e.state !== "closed") e.close(); } catch {} }
        neb?.gl.getExtension("WEBGL_lose_context")?.loseContext();
      };

      try {
        // audio: the finished mix, in 1-second chunks
        const [AL, AR] = await resample(job.L, job.R, job.sr, acfg.cfg.sampleRate);
        const asr = acfg.cfg.sampleRate;
        for (let i = 0; i < AL.length; i += asr) {
          const n = Math.min(asr, AL.length - i);
          const data = new Float32Array(n * 2);
          data.set(AL.subarray(i, i + n), 0);
          data.set(AR.subarray(i, i + n), n);
          const ad = new AudioData({ format: "f32-planar", sampleRate: asr, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round((i * 1e6) / asr), data });
          aenc.encode(ad);
          ad.close();
        }

        // video, step 1: how the music "looks" in every frame. The analyser and the smoothing run
        // at 60 Hz like on the page, so this pass is sequential – but it is cheap.
        const mono = new Float32Array(job.L.length);
        for (let i = 0; i < mono.length; i++) mono[i] = (job.L[i] + job.R[i]) / 2;
        const an = makeAnalyser(mono, job.sr);
        const total = Math.ceil(job.duration * FPS);
        const looks = [];
        let simT = 0;
        for (let f = 0; f < total; f++) {
          const t = f / FPS;
          while (simT <= t + 1e-9) {
            an.step(simT);
            window.JukeboxNebula?.stepEnergy(energy, an.bands, 1 / 60, react);
            simT += 1 / 60;
          }
          const glowA = bg === "off" ? 0 : bg === "soft" ? Math.min(0.45, an.level * 0.6) : Math.min(1, an.level * 1.3 + an.kick * 0.25);
          looks.push({ energy: Float32Array.from(energy), glowA });
          if (f % 600 === 599) await tick();
        }

        // step 2: draw the frames, handing them round-robin to the encoders (each gets its own part)
        const stars = document.getElementById("stars");
        const phi0 = api.carouselPhi();
        const seg = Math.ceil(total / K);
        let done = 0, lastYield = performance.now();
        for (let j = 0; j < seg; j++) for (let k = 0; k < K; k++) {
          const f = k * seg + j;
          if (f >= total) continue;
          if (r.cancelled) { closeAll(); return null; }
          if (encErr) throw encErr;
          const t = f / FPS;
          const { energy: en, glowA } = looks[f];
          if (neb) {
            neb.draw({
              t: t * (calm ? 0.25 : 1), energy: en,
              cx: nebCv.width / 2, cy: (L.y + L.h * 0.48) * nebScale,
              sx: nebCv.width / 2, sy: Math.max(L.h, H * 0.6) * nebScale,
              dpr: nebScale * cssScale,
            });
          }
          const at = job.at(t);
          drawFrame(g, W, H, L, {
            art: api.jukeboxImage?.(), stars, space: neb ? nebCv : null, spaceAlpha: bg === "soft" ? 0.45 : 1, glowA,
            carousel: api.carouselAt(phi0 + (calm ? 0 : t * 0.05)),
            angle: calm ? 0 : (t * Math.PI * 2) / 1.8,
            info: { time: Math.min(t, job.duration), duration: job.duration, title: at.title, sub: job.sub, line: job.line, label: at.label, loaded: true },
          });
          const vf = new VideoFrame(cv, { timestamp: Math.round((f * 1e6) / FPS), duration: Math.round(1e6 / FPS) });
          vencs[k].encode(vf, { keyFrame: j % (FPS * 2) === 0 });
          vf.close();
          done++;
          while (vencs[k].encodeQueueSize > 4) await tick();
          if (performance.now() - lastYield > 40) {
            r.onProgress?.((done / total) * job.duration, job.duration);
            await tick();
            lastYield = performance.now();
          }
        }
        await Promise.all([...vencs.map((e) => e.flush()), aenc.flush()]);
        if (encErr) throw encErr;
        r.onProgress?.(job.duration, job.duration);
        // the parts in order; the decoder setup comes with the very first chunk
        let first = true;
        for (const part of parts) for (const [c, m] of part) {
          muxer.addVideoChunk(c, first ? m : undefined);
          first = false;
        }
        muxer.finalize();
        closeAll();
        return { blob: new Blob([muxer.target.buffer], { type: "video/mp4" }), ext: "mp4" };
      } catch (e) {
        closeAll();
        if (e && e.name === "SecurityError") throw new Error(api.T("st_vid_tainted"));
        throw e;
      }
    }

    // ---------------- real-time fallback ----------------
    async function recordLive(fmtKey) {
      if (!type) throw new Error(api.T("st_vid_unsupported"));
      const { w: W, h: H } = FORMATS[fmtKey] || FORMATS.wide;
      const cv = document.createElement("canvas");
      cv.width = W; cv.height = H;
      const g = cv.getContext("2d");
      await api.prepare(); // compose melody + beat before the camera rolls
      const r = rec;
      if (!r || r.cancelled) return null;

      const ac = api.ctx();
      const dest = ac.createMediaStreamDestination();
      api.tap().connect(dest);
      const vStream = cv.captureStream(30);
      const stream = new MediaStream([...vStream.getVideoTracks(), ...dest.stream.getAudioTracks()]);
      const mr = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 8_000_000, audioBitsPerSecond: 192_000 });
      const chunks = [];
      mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      Object.assign(r, { live: true, mr, chunks, dest, stream, angle: 0, last: performance.now() });
      const L = layout(W, H, fmtKey);

      const draw = (dt) => {
        const info = api.info();
        const bg = window.A11Y?.get("bg") || "full";
        if (info.playing && !window.A11Y?.get("calm")) r.angle += dt * (Math.PI * 2 / 1.8);
        drawFrame(g, W, H, L, {
          art: api.jukeboxImage?.(),
          stars: document.getElementById("stars"),
          space: bg !== "off" ? document.getElementById("space") : null,
          spaceAlpha: bg === "soft" ? 0.45 : 1,
          glowA: bg === "off" ? 0 : parseFloat(document.getElementById("glow").style.opacity) || 0,
          carousel: document.getElementById("carousel"),
          angle: r.angle, info,
        });
      };
      draw(0);
      mr.start(1000);
      api.playFromStart();
      const loop = (now) => {
        if (rec !== r) return;
        const dt = Math.min(0.1, (now - r.last) / 1000);
        r.last = now;
        draw(dt);
        const i = api.info();
        r.onProgress?.(i.time, i.duration);
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
      return new Promise((resolve) => { r.resolve = resolve; });
    }

    async function start(fmtKey, onProgress) {
      if (rec) return null;
      rec = { cancelled: false, onProgress };
      const r = rec;
      try {
        await document.fonts?.load?.(`40px Audiowide`).catch(() => {});
        if (fast) {
          const res = await renderFast(fmtKey, onProgress);
          if (res !== false) return res; // false = this browser can't encode MP4 → record live
        }
        return await recordLive(fmtKey);
      } finally {
        if (rec === r && !r.live) rec = null;
      }
    }

    // live: called when the music has finished (or the user cancels). fast: only cancel matters.
    function finish(cancel = false) {
      const r = rec;
      if (!r || r.stopping) return;
      if (!r.live) { if (cancel) r.cancelled = true; return; }
      r.stopping = true;
      r.cancelled = cancel;
      setTimeout(() => { // keep the last frame + reverb tail for a moment
        r.mr.onstop = () => {
          try { api.tap().disconnect(r.dest); } catch {}
          r.stream.getTracks().forEach((t) => t.stop());
          rec = null;
          if (r.cancelled) { r.resolve(null); return; }
          const ext = type.startsWith("video/mp4") ? "mp4" : "webm";
          r.resolve({ blob: new Blob(r.chunks, { type: type.split(";")[0] }), ext });
        };
        r.mr.stop();
      }, cancel ? 0 : 700);
    }

    return {
      type: fast ? "video/mp4" : type,
      ext: fast ? "mp4" : type ? (type.startsWith("video/mp4") ? "mp4" : "webm") : null,
      fast,
      start,
      finish,
      get active() { return !!rec; },
      get live() { return !!rec?.live; },
    };
  }

  window.JukeboxRecorder = { create, FORMATS };
})();
