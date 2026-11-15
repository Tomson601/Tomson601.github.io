/* Record carousel drawn into the jukebox (2D canvas over the jukebox image).
 * Records stand radially around a vertical axis (like a real jukebox magazine), so the
 * front ones are seen edge-on and the side ones almost face-on. The magazine slowly turns;
 * picking a record spins it to the front and lifts it up into the arch.
 * All coordinates are in jukebox-image pixels (image is 1440x1030). */
(() => {
  "use strict";

  // canvas box inside the image (must match .carousel in style.css)
  const BOX = { x: 360, y: 300, w: 730, h: 330 }; // tall enough for the lift animation
  // dark pit painted into jukebox.webp (superellipse) and the red base edge below it
  const PIT = { cx: 725, cy: 622, rx: 364, ry: 146, p: 4.5 };
  const baseY = (x) => 600 - 23 * ((x - 725) / 352) ** 2;
  // magazine geometry
  const AXIS_X = 725, RING = 250, DISC = 96, K = 24;

  const TAU = Math.PI * 2;
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

  class Carousel {
    constructor(canvas, { slots, onPick }) {
      this.cv = canvas;
      this.g = canvas.getContext("2d");
      this.slots = slots;            // [{ slot, label: HTMLImageElement|null, title }]
      this.onPick = onPick;
      this.phi = -0.6;               // current rotation
      this.spin = null;              // { from, to, t0, dur, resolve }
      this.lifted = -1;              // slot currently up in the arch (gap in the magazine)
      this.lift = null;              // { slot, t0, dur, dir: +1 up / -1 down, resolve }
      this.playing = false;
      this.hover = -1;
      this.last = performance.now();
      this.labelOf = new Map(slots.map((s, i) => [s.slot, i]));
      this.resize();
      addEventListener("resize", () => this.resize());
      canvas.addEventListener("pointermove", (e) => this.onMove(e));
      canvas.addEventListener("pointerleave", () => { this.hover = -1; canvas.style.cursor = ""; });
      canvas.addEventListener("click", (e) => {
        const i = this.hit(e);
        if (i >= 0) this.onPick(i);
      });
      this.onScreen = true;
      if ("IntersectionObserver" in window) {
        new IntersectionObserver(([e]) => (this.onScreen = e.isIntersecting)).observe(canvas);
      }
      requestAnimationFrame((t) => this.frame(t));
    }

    resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.round(this.cv.clientWidth * dpr));
      this.cv.width = w;
      this.cv.height = Math.round((w * BOX.h) / BOX.w);
      this.scale = w / BOX.w;
    }

    // angle of a slot, 0 = front
    angle(k) { return this.phi + (k * TAU) / K; }

    /** Spin record `i` (index into slots) to the front, then lift it. Resolves when it's up. */
    select(i) {
      const slot = this.slots[i].slot;
      return this.drop().then(() => new Promise((resolve) => {
        // nearest forward rotation that brings `slot` to the front (at least a quarter turn)
        let to = -(slot * TAU) / K;
        while (to < this.phi + 0.8) to += TAU;
        while (to > this.phi + 0.8 + TAU) to -= TAU;
        const dur = 900 + 500 * ((to - this.phi) / Math.PI);
        this.spin = { from: this.phi, to, t0: performance.now(), dur, resolve: () => {
          this.lift = { slot, t0: performance.now(), dur: 650, dir: 1, resolve };
        } };
      }));
    }

    /** Put the lifted record back into the magazine. */
    drop() {
      if (this.lifted < 0) return Promise.resolve();
      const slot = this.lifted;
      return new Promise((resolve) => {
        this.lift = { slot, t0: performance.now(), dur: 450, dir: -1, resolve };
      });
    }

    record(k) {
      const th = this.angle(k);
      const s = Math.sin(th), z = Math.cos(th);
      const r = DISC * (0.92 + 0.08 * z);
      return { k, s, z, x: AXIS_X + RING * s, y: 600 + 6 * z, r, w: Math.max(3.2, r * Math.abs(s)) };
    }

    hit(e) {
      const rect = this.cv.getBoundingClientRect();
      const px = BOX.x + ((e.clientX - rect.left) / rect.width) * BOX.w;
      const py = BOX.y + ((e.clientY - rect.top) / rect.height) * BOX.h;
      if (py > baseY(px)) return -1;
      const recs = [];
      for (let k = 0; k < K; k++) if (k !== this.lifted) recs.push(this.record(k));
      recs.sort((a, b) => b.z - a.z); // front first
      for (const rc of recs) {
        const dx = (px - rc.x) / (rc.w + 4), dy = (py - rc.y) / rc.r;
        if (dx * dx + dy * dy <= 1) return this.labelOf.has(rc.k) ? this.labelOf.get(rc.k) : -1;
      }
      return -1;
    }

    onMove(e) {
      const i = this.hit(e);
      this.hover = i >= 0 ? this.slots[i].slot : -1;
      this.cv.style.cursor = i >= 0 ? "pointer" : "";
      this.cv.title = i >= 0 ? this.slots[i].title : "";
    }

    clipPath(g) {
      g.beginPath();
      const { cx, cy, rx, ry, p } = PIT;
      for (let i = 0; i <= 80; i++) {          // upper edge of the pit
        const x = cx - rx + (2 * rx * i) / 80;
        const u = Math.min(1, Math.abs((x - cx) / rx));
        g.lineTo(x, cy - ry * Math.sqrt(Math.max(0, 1 - u ** p)));
      }
      for (let i = 80; i >= 0; i--) {          // back along the red base
        const x = cx - rx + (2 * rx * i) / 80;
        g.lineTo(x, baseY(x));
      }
      g.closePath();
    }

    drawRecord(g, rc, labelIdx, alpha = 1) {
      const { x, y, r, w, z, s } = rc;
      g.save();
      g.globalAlpha = alpha;
      // body
      const grd = g.createLinearGradient(x - w, y - r, x + w, y);
      grd.addColorStop(0, "#1d1714");
      grd.addColorStop(0.5, "#2c221c");
      grd.addColorStop(1, "#120d0b");
      g.fillStyle = grd;
      g.beginPath(); g.ellipse(x, y, w, r, 0, 0, TAU); g.fill();
      // grooves
      if (w > 14) {
        g.strokeStyle = "rgba(255, 220, 160, 0.07)";
        g.lineWidth = 1;
        for (const f of [0.82, 0.7, 0.58]) { g.beginPath(); g.ellipse(x, y, w * f, r * f, 0, 0, TAU); g.stroke(); }
      }
      // label
      if (w > 8) {
        const lw = w * 0.36, lh = r * 0.36;
        g.save();
        g.beginPath(); g.ellipse(x, y, lw, lh, 0, 0, TAU); g.clip();
        const img = labelIdx >= 0 ? this.slots[labelIdx].label : null;
        if (img && img.complete && img.naturalWidth) {
          g.drawImage(img, x - lw, y - lh, lw * 2, lh * 2);
        } else {
          g.fillStyle = rc.k % 3 === 0 ? "#e8d6a8" : "#a8141a";
          g.fillRect(x - lw, y - lh, lw * 2, lh * 2);
        }
        g.restore();
      }
      // golden rim (like the records in the render)
      const hot = this.hover === rc.k;
      g.strokeStyle = hot ? "rgba(255, 225, 150, 1)" : `rgba(214, 170, 82, ${0.55 + 0.35 * Math.max(0, z)})`;
      g.lineWidth = hot ? 2.6 : 1.5;
      g.beginPath(); g.ellipse(x, y, w, r, 0, 0, TAU); g.stroke();
      // specular glint
      if (w > 10) {
        g.fillStyle = "rgba(255, 255, 255, 0.35)";
        g.beginPath(); g.ellipse(x - Math.sign(s) * w * 0.35, y - r * 0.72, Math.max(1.5, w * 0.06), 3, 0, 0, TAU); g.fill();
      }
      // depth shading
      if (z < 0.98) {
        g.fillStyle = `rgba(8, 5, 3, ${0.55 * (1 - (z + 1) / 2)})`;
        g.beginPath(); g.ellipse(x, y, w + 1, r + 1, 0, 0, TAU); g.fill();
      }
      g.restore();
    }

    frame(now) {
      requestAnimationFrame((t) => this.frame(t));
      const dt = Math.min(0.05, (now - this.last) / 1000);
      this.last = now;
      if (!this.onScreen && !this.spin && !this.lift) return; // nothing to see, nothing pending

      if (this.spin) {
        const sp = this.spin, t = Math.min(1, (now - sp.t0) / sp.dur);
        this.phi = sp.from + (sp.to - sp.from) * ease(t);
        if (t >= 1) { this.spin = null; sp.resolve(); }
      } else if (!this.lift) {
        if (!window.A11Y?.get("calm")) this.phi += dt * (this.playing ? 0.05 : 0.14); // the magazine keeps slowly turning
      }

      let liftP = 0, liftSlot = -1;
      if (this.lift) {
        const L = this.lift, t = Math.min(1, (now - L.t0) / L.dur);
        liftSlot = L.slot;
        liftP = L.dir > 0 ? ease(t) : 1 - ease(t);
        if (t >= 1) {
          this.lift = null;
          this.lifted = L.dir > 0 ? L.slot : -1;
          L.resolve();
        }
      }

      this.draw(liftP, liftSlot);
    }

    /** Draw the magazine as it would look at rotation `phi` (record already up) – for the video export. */
    snapshot(phi) {
      const keep = this.phi;
      this.phi = phi;
      this.draw(0, -1);
      this.phi = keep;
      return this.cv;
    }

    get rotation() { return this.phi; }

    draw(liftP, liftSlot) {
      const g = this.g;
      g.setTransform(this.scale, 0, 0, this.scale, -BOX.x * this.scale, -BOX.y * this.scale);
      g.clearRect(BOX.x, BOX.y, BOX.w, BOX.h);

      g.save();
      this.clipPath(g);
      g.clip();
      const recs = [];
      for (let k = 0; k < K; k++) {
        if (k === this.lifted && !this.lift) continue;
        if (k === liftSlot) continue;
        recs.push(this.record(k));
      }
      recs.sort((a, b) => a.z - b.z); // back to front
      for (const rc of recs) this.drawRecord(g, rc, this.labelOf.has(rc.k) ? this.labelOf.get(rc.k) : -1);
      g.restore();

      // the record being lifted rises out of the magazine and fades into the arch
      if (liftSlot >= 0 && liftP < 1) {
        const rc = this.record(liftSlot);
        rc.y -= 150 * liftP;
        rc.w = Math.max(rc.w, rc.r * Math.min(1, liftP * 1.6)); // turns to face us while rising
        g.save();
        if (liftP < 0.35) { this.clipPath(g); g.rect(BOX.x, BOX.y, BOX.w, 60); g.clip(); }
        this.drawRecord(g, rc, this.labelOf.has(liftSlot) ? this.labelOf.get(liftSlot) : -1, 1 - liftP * 0.85);
        g.restore();
      }
    }
  }

  window.Carousel = Carousel;
})();
