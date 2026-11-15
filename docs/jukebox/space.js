/* Audio-reactive nebula behind the jukebox (WebGL2).
 * Several soft ribbons of particles (like an aurora / nebula) drift slowly across the
 * screen behind the jukebox. Each ribbon listens to its own frequency range – low ribbons
 * to the bass, high ribbons to the treble – and swells, brightens and ripples with it.
 * Reads window.jukebox.audio(). */
(() => {
  "use strict";

  // --- static starfield (2D canvas, redrawn only on resize) ---
  const starCv = document.getElementById("stars");
  function drawStars() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = innerWidth, h = innerHeight;
    starCv.width = w * dpr; starCv.height = h * dpr;
    const g = starCv.getContext("2d");
    g.scale(dpr, dpr);
    const n = Math.round((w * h) / 2600);
    for (let i = 0; i < n; i++) {
      const x = Math.random() * w, y = Math.random() * h;
      const r = Math.random() ** 3 * 1.6 + 0.25;
      const hue = [210, 260, 40, 320][(Math.random() * 4) | 0];
      g.fillStyle = `hsla(${hue}, 80%, ${80 + Math.random() * 20}%, ${0.25 + Math.random() * 0.7})`;
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    }
  }

  drawStars();
  addEventListener("resize", drawStars);

  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const small = Math.min(innerWidth, innerHeight) < 700;
  const N = small ? 9000 : 16000;   // ~30 % big mist sprites, the rest fine sparkles
  const NR = 6; // ribbons

  // ribbon layout (y in units of the jukebox height, + is up), tilt, colour (linear-ish RGB)
  const RIBBONS = [
    { y:  0.42, tilt: -0.10, col: [0.62, 0.40, 1.00] }, // violet   – treble
    { y:  0.24, tilt:  0.08, col: [0.30, 0.82, 1.00] }, // cyan
    { y:  0.06, tilt: -0.05, col: [1.00, 0.40, 0.78] }, // magenta
    { y: -0.12, tilt:  0.10, col: [0.30, 0.95, 0.85] }, // teal
    { y: -0.30, tilt: -0.08, col: [0.45, 0.50, 1.00] }, // indigo
    { y: -0.46, tilt:  0.06, col: [1.00, 0.62, 0.55] }, // rose     – bass
  ];

  /** A nebula renderer on its own WebGL2 canvas – used live (#space) and by the video export. */
  function createNebula(canvas, N) {
  const gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: false, preserveDrawingBuffer: false });
  if (!gl) return null;
  const NOISE = `
    vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
    vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
    vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
    vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
    float snoise(vec3 v){
      const vec2 C=vec2(1.0/6.0,1.0/3.0); const vec4 D=vec4(0.0,0.5,1.0,2.0);
      vec3 i=floor(v+dot(v,C.yyy)); vec3 x0=v-i+dot(i,C.xxx);
      vec3 g=step(x0.yzx,x0.xyz); vec3 l=1.0-g; vec3 i1=min(g.xyz,l.zxy); vec3 i2=max(g.xyz,l.zxy);
      vec3 x1=x0-i1+C.xxx; vec3 x2=x0-i2+C.yyy; vec3 x3=x0-D.yyy;
      i=mod289(i);
      vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
      float n_=0.142857142857; vec3 ns=n_*D.wyz-D.xzx;
      vec4 j=p-49.0*floor(p*ns.z*ns.z); vec4 x_=floor(j*ns.z); vec4 y_=floor(j-7.0*x_);
      vec4 x=x_*ns.x+ns.yyyy; vec4 y=y_*ns.x+ns.yyyy; vec4 h=1.0-abs(x)-abs(y);
      vec4 b0=vec4(x.xy,y.xy); vec4 b1=vec4(x.zw,y.zw);
      vec4 s0=floor(b0)*2.0+1.0; vec4 s1=floor(b1)*2.0+1.0; vec4 sh=-step(h,vec4(0.0));
      vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy; vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
      vec3 p0=vec3(a0.xy,h.x); vec3 p1=vec3(a0.zw,h.y); vec3 p2=vec3(a1.xy,h.z); vec3 p3=vec3(a1.zw,h.w);
      vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
      p0*=norm.x; p1*=norm.y; p2*=norm.z; p3*=norm.w;
      vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0); m=m*m;
      return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
    }`;

  // aSeed: x = position along the ribbon (0..1), y = ribbon index, z = gaussian offset across, w = random
  const VS = `#version 300 es
    precision highp float;
    in vec4 aSeed;
    uniform float uTime, uDpr;
    uniform float uEnergy[${NR}], uBaseY[${NR}], uTilt[${NR}];
    uniform vec3 uCol[${NR}];
    uniform vec2 uCenter, uView, uScale; // centre (px), viewport (px), half-width / height unit (px)
    out vec3 vCol; out float vA; out float vSoft;
    ${NOISE}
    void main(){
      int r = int(aSeed.y);
      float fr = aSeed.y;
      float e = uEnergy[r];
      float t = uTime;
      float rnd = aSeed.w;
      bool mist = rnd < 0.3;                       // big soft particles form the haze

      // drift slowly sideways; neighbouring ribbons flow in opposite directions
      float dir = mod(fr, 2.0) < 1.0 ? 1.0 : -1.0;
      float u = fract(aSeed.x + dir * t * (0.006 + 0.004 * fr));
      float x = u * 2.6 - 1.3;                     // a bit wider than the screen

      // gentle waves, a slow noise wobble, and an audio ripple running along the ribbon
      float wave = 0.09 * sin(x * (1.6 + 0.3 * fr) + t * (0.18 + 0.03 * fr) + fr * 1.7)
                 + 0.05 * snoise(vec3(x * 0.9, fr * 3.1, t * 0.05));
      float ripple = e * 0.06 * sin(x * 4.0 - t * 0.9 + fr);
      float yc = uBaseY[r] + uTilt[r] * x + wave + ripple;

      // thickness swells with the ribbon's energy; mist is wider than the sparkles
      float thick = (mist ? 0.04 : 0.018) * (1.0 + 0.8 * e) * (0.8 + 0.4 * snoise(vec3(x * 1.3, fr, t * 0.04)));
      float y = yc + aSeed.z * thick;

      vec2 sp = uCenter + vec2(x * uScale.x, -y * uScale.y);
      gl_Position = vec4(sp / uView * 2.0 - 1.0, 0.0, 1.0);
      gl_Position.y = -gl_Position.y;

      float edge = exp(-aSeed.z * aSeed.z * 0.5);  // brighter in the ribbon's core
      float fadeX = smoothstep(1.3, 0.9, abs(x));  // fade at the screen edges
      if (mist) {
        gl_PointSize = uDpr * (44.0 + 50.0 * rnd) * (1.0 + 0.25 * e);
        vA = (0.03 + 0.055 * e) * edge * fadeX;
        vSoft = 1.0;
      } else {
        gl_PointSize = max(1.6, uDpr * (1.6 + 1.8 * fract(rnd * 7.3)) * (1.0 + 0.5 * e));
        float tw = 0.6 + 0.4 * sin(t * (1.0 + 3.0 * fract(rnd * 13.0)) + rnd * 40.0); // twinkle
        vA = (0.22 + 0.5 * e) * edge * fadeX * tw;
        vSoft = 0.0;
      }
      vCol = mix(uCol[r], vec3(1.0), (mist ? 0.0 : 0.35) + 0.2 * e);
    }`;

  const FS = `#version 300 es
    precision mediump float;
    in vec3 vCol; in float vA; in float vSoft; out vec4 o;
    void main(){
      vec2 c = gl_PointCoord * 2.0 - 1.0;
      float d = dot(c, c);
      if (d > 1.0) discard;
      float a = vA * (vSoft > 0.5 ? (1.0 - d) * (1.0 - d) : exp(-d * 4.0));
      o = vec4(vCol * a, a);
    }`;

  function program(vs, fs) {
    const p = gl.createProgram();
    for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      gl.attachShader(p, s);
    }
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    return p;
  }

  let prog;
  try { prog = program(VS, FS); } catch (e) { console.warn("Nebula shaders failed:", e); return null; }

  // particle seeds
  const gauss = () => { // Box–Muller
    const u = 1 - Math.random(), v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const data = new Float32Array(N * 4);
  for (let i = 0; i < N; i++) {
    data.set([Math.random(), i % NR, Math.max(-3, Math.min(3, gauss())), Math.random()], i * 4);
  }
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
  const aSeed = gl.getAttribLocation(prog, "aSeed");
  gl.enableVertexAttribArray(aSeed);
  gl.vertexAttribPointer(aSeed, 4, gl.FLOAT, false, 16, 0);
  gl.bindVertexArray(null);

  const U = {};
  for (const n of ["uTime", "uDpr", "uEnergy", "uBaseY", "uTilt", "uCol", "uCenter", "uView", "uScale"]) {
    U[n] = gl.getUniformLocation(prog, n);
  }
  gl.useProgram(prog);
  gl.uniform1fv(U.uBaseY, RIBBONS.map((r) => r.y));
  gl.uniform1fv(U.uTilt, RIBBONS.map((r) => r.tilt));
  gl.uniform3fv(U.uCol, RIBBONS.flatMap((r) => r.col));

  return {
    canvas, gl,
    clear() { gl.viewport(0, 0, canvas.width, canvas.height); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); },
    /** t: seconds, energy: Float32Array(NR), centre (cx, cy) and unit sizes (sx, sy) in canvas pixels */
    draw({ t, energy, cx, cy, sx, sy, dpr }) {
      const W = canvas.width, H = canvas.height;
      gl.viewport(0, 0, W, H);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE); // additive glow
      gl.useProgram(prog);
      gl.bindVertexArray(vao);
      gl.uniform1f(U.uTime, t);
      gl.uniform1f(U.uDpr, dpr);
      gl.uniform1fv(U.uEnergy, energy);
      gl.uniform2f(U.uCenter, cx, cy);
      gl.uniform2f(U.uView, W, H);
      gl.uniform2f(U.uScale, sx, sy);
      gl.drawArrays(gl.POINTS, 0, N);
    },
  };
  }

  // ribbon energy: ribbon 0 (top) = treble … ribbon NR-1 (bottom) = bass; smooth & soft
  function stepEnergy(energy, bands, dt, react) {
    for (let r = 0; r < NR; r++) {
      const lo = Math.floor(((NR - 1 - r) * 32) / NR), hi = Math.floor(((NR - r) * 32) / NR);
      let s = 0;
      for (let b = lo; b < hi; b++) s += bands[b];
      const target = Math.min(1, (s / (hi - lo)) * 1.8) * react;
      energy[r] += (target - energy[r]) * (1 - Math.exp(-dt * (target > energy[r] ? 5 : 1.4)));
    }
  }

  window.JukeboxNebula = { create: (canvas) => createNebula(canvas, 16000), stepEnergy, NR };

  const canvas = document.getElementById("space");
  const neb = createNebula(canvas, N);
  if (!neb) return; // no WebGL2 → stars + CSS nebula only
  const gl = neb.gl;

  let W = 0, H = 0, dpr = 1;
  function resize() {
    dpr = 0.6; // render at 60 % of CSS resolution – the haze is soft anyway, and it keeps it smooth
    W = Math.round(innerWidth * dpr); H = Math.round(innerHeight * dpr);
    canvas.width = W; canvas.height = H;
    gl.viewport(0, 0, W, H);
  }
  resize();
  addEventListener("resize", resize);

  const stage = document.getElementById("stage");
  const silent = { bands: new Float32Array(32), playing: false };
  const energy = new Float32Array(NR);
  const t0 = performance.now();
  let lastNow = t0, t = 0;
  const calm = () => reduced || !!window.A11Y?.get("calm");
  const bgMode = () => window.A11Y?.get("bg") || "full";
  let visible = true, drawn = false;
  document.addEventListener("visibilitychange", () => (visible = !document.hidden));

  function frame() {
    requestAnimationFrame(frame);
    if (!visible) return;
    const a = (window.jukebox && window.jukebox.audio()) || silent;
    const now = performance.now();
    const dt = Math.min(0.1, (now - lastNow) / 1000);
    lastNow = now;
    t += dt * (calm() ? 0.25 : 1); // accumulated, so switching "reduce motion" never jumps
    const mode = bgMode();
    if (mode === "off") { if (drawn) { gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); drawn = false; } return; }
    const react = mode === "soft" || calm() ? 0.35 : 1; // gentler reaction to the music

    stepEnergy(energy, a.bands, dt, react);

    const rect = stage.getBoundingClientRect();
    const cx = innerWidth / 2 * dpr, cy = (rect.top + rect.height * 0.48) * dpr;
    const unitY = Math.max(rect.height, innerHeight * 0.6);
    // the lowest ribbon never goes below ~0.8 units under the centre: once that is above the screen, skip
    if (rect.top + rect.height * 0.48 + unitY * 0.9 < 0) {
      if (drawn) { gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); drawn = false; }
      return;
    }
    drawn = true;
    neb.draw({ t, energy, cx, cy, sx: W / 2, sy: unitY * dpr, dpr });
  }
  requestAnimationFrame(frame);
})();
