// Model 3D szafy grającej (jukebox.glb wyeksportowany z Blendera), reagujący na muzykę.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { MeshSurfaceSampler } from "three/addons/math/MeshSurfaceSampler.js";

// Materiały proceduralne z Blendera (noise/voronoi/color ramp) nie przechodzą do glTF –
// tu ustawiamy ich uśredniony wygląd (kolory liniowe, wzięte z color rampów w .blend).
const MATERIAL_FIX = {
  "Material.013": { color: [0.035, 0.002, 0.03], emissive: [0, 0, 0], roughness: 0.75 }, // rama
  "Material.006": { color: [0.4, 0.0, 0.008], roughness: 0.3, metalness: 0.0 },        // czerwona podłoga
};
const LIGHT_SCALE = 0.0008; // eksporter zamienia waty z Blendera na kandele – tu skalujemy je do sceny three.js

const host = document.getElementById("viewer");
const msg = document.getElementById("viewer-msg");

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
host.append(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x07073a); // jak "World" w Blenderze
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.5;

let camera = new THREE.PerspectiveCamera(40, 1, 0.1, 5000);
let controls = null;

scene.add(new THREE.HemisphereLight(0xc8ccff, 0x301020, 0.5));
const key = new THREE.DirectionalLight(0xfff2e0, 1.0);
scene.add(key);
const glow = new THREE.PointLight(0xffb060, 0, 0, 2); // pulsuje z muzyką
scene.add(glow);

const emissive = []; // materiały świecące – rozjaśniane w rytm muzyki
const lights = [];   // światła z Blendera – pulsują w rytm muzyki
let model = null, mixer = null, actions = [], vinyl = null, vinylAxis = null;
let sparkles = null;

// gwiazdki na ramie (w Blenderze robione proceduralną emisją)
function addSparkles(mesh, radius) {
  const N = 1100;
  const sampler = new MeshSurfaceSampler(mesh).build();
  const pos = new Float32Array(N * 3), phase = new Float32Array(N);
  const p = new THREE.Vector3();
  mesh.updateMatrixWorld(true);
  for (let i = 0; i < N; i++) {
    sampler.sample(p);
    p.applyMatrix4(mesh.matrixWorld);
    p.toArray(pos, i * 3);
    phase[i] = Math.random() * Math.PI * 2;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("phase", new THREE.BufferAttribute(phase, 1));

  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d");
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, "rgba(255,255,255,1)");
  grd.addColorStop(0.15, "rgba(255,240,250,0.9)");
  grd.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  g.fillStyle = "#fff";
  g.fillRect(31, 2, 2, 60);
  g.fillRect(2, 31, 60, 2);

  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { map: { value: new THREE.CanvasTexture(c) }, time: { value: 0 }, level: { value: 0 },
                size: { value: radius * 0.045 } },
    vertexShader: `
      attribute float phase; uniform float time, level, size; varying float vA;
      void main() {
        vA = 0.45 + 0.9 * pow(0.5 + 0.5 * sin(time * (1.5 + level * 6.0) + phase * 7.0), 3.0);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = size * (0.6 + vA + level) * (300.0 / -mv.z);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform sampler2D map; varying float vA;
      void main() { gl_FragColor = texture2D(map, gl_PointCoord) * vA; }`,
  });
  sparkles = new THREE.Points(geo, mat);
  scene.add(sparkles);
}
let wasPlaying = false;
let userOrbited = false, swayBase = 0, swayT = 0;
const clock = new THREE.Clock();

function resize() {
  const w = host.clientWidth, h = host.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  // na wąskich (pionowych) ekranach zachowujemy kąt w poziomie, żeby szafa mieściła się na szerokość
  const base = THREE.MathUtils.degToRad(baseFov / 2);
  camera.fov = camera.aspect < 1
    ? THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(base) / camera.aspect))
    : baseFov;
  camera.updateProjectionMatrix();
}
let baseFov = 40;
new ResizeObserver(resize).observe(host);

function setup(gltf) {
  model = gltf.scene;
  scene.add(model);
  model.updateMatrixWorld(true);

  const box = new THREE.Box3().setFromObject(model);
  const center = box.getCenter(new THREE.Vector3());
  const radius = box.getSize(new THREE.Vector3()).length() / 2;

  // kamera z Blendera (kadr autora), a jeśli jej brak – kadr z bounding boxa
  const cam = gltf.cameras && gltf.cameras[0];
  if (cam) {
    cam.updateMatrixWorld(true);
    baseFov = cam.fov;
    camera.position.setFromMatrixPosition(cam.matrixWorld);
    camera.position.sub(center).multiplyScalar(1.3).add(center); // kadr z Blendera był kwadratowy
  } else {
    camera.position.copy(center).add(new THREE.Vector3(0.5, 0.25, 1).normalize().multiplyScalar(radius * 3));
  }
  camera.near = radius / 50;
  camera.far = radius * 100;
  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(center);
  controls.enableDamping = true;
  controls.enablePan = false;
  controls.minDistance = radius * 1.2;
  controls.maxDistance = radius * 6;
  controls.addEventListener("start", () => (userOrbited = true));
  controls.update();
  resize();

  key.position.copy(camera.position).add(new THREE.Vector3(radius, radius * 2, 0));
  key.target.position.copy(center);
  scene.add(key.target);
  glow.position.copy(center).lerp(camera.position, 0.25);
  glow.userData.base = radius;

  let frameMesh = null;
  model.traverse((o) => {
    if (o.isLight) {
      o.intensity *= LIGHT_SCALE;
      lights.push({ l: o, base: o.intensity });
    }
    if (o.isMesh) {
      for (const m of [].concat(o.material)) {
        const fix = MATERIAL_FIX[m.name];
        if (fix) {
          if (fix.color) m.color.setRGB(...fix.color);
          if (fix.emissive) m.emissive.setRGB(...fix.emissive);
          if (fix.roughness != null) m.roughness = fix.roughness;
          if (fix.metalness != null) m.metalness = fix.metalness;
          if (m.name === "Material.013" && !frameMesh) frameMesh = o;
        }
        if (m.emissive && m.emissive.getHex() !== 0) emissive.push({ m, base: m.emissiveIntensity ?? 1 });
      }
    }
    if (o.name === "Vinyl" || o.parent?.name === "Vinyl") vinyl = vinyl || (o.name === "Vinyl" ? o : o.parent);
  });
  if (frameMesh) addSparkles(frameMesh, radius);

  // płyta kręci się wokół osi prostopadłej do krążka (najmniejszy wymiar geometrii)
  if (vinyl) {
    const local = new THREE.Box3();
    vinyl.traverse((o) => {
      if (!o.isMesh) return;
      o.geometry.computeBoundingBox();
      local.union(o.geometry.boundingBox);
    });
    const s = local.getSize(new THREE.Vector3());
    vinylAxis = s.x <= s.y && s.x <= s.z ? new THREE.Vector3(1, 0, 0)
              : s.y <= s.z ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
  }

  // animacje z Blendera (karuzela płyt + płyta wjeżdżająca na miejsce): grane po naciśnięciu „graj”
  if (gltf.animations.length) {
    mixer = new THREE.AnimationMixer(model);
    actions = gltf.animations.map((clip) => {
      const a = mixer.clipAction(clip);
      a.setLoop(THREE.LoopOnce, 1);
      a.clampWhenFinished = true;
      return a;
    });
    mixer.update(0);
  }
  msg.remove();
}

new GLTFLoader().load("jukebox.glb", setup, undefined, () => {
  msg.textContent = "Nie udało się wczytać modelu 3D (jukebox.glb) – muzyka działa normalnie.";
});

// kliknięcie w model = graj / stop
let downAt = null;
renderer.domElement.addEventListener("pointerdown", (e) => (downAt = [e.clientX, e.clientY]));
renderer.domElement.addEventListener("pointerup", (e) => {
  if (!downAt || !model || !window.jukebox) return;
  const moved = Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]);
  downAt = null;
  if (moved > 5) return;
  const p = new THREE.Vector2((e.offsetX / host.clientWidth) * 2 - 1, -(e.offsetY / host.clientHeight) * 2 + 1);
  const ray = new THREE.Raycaster();
  ray.setFromCamera(p, camera);
  if (!ray.intersectObject(model, true).length) return;
  if (window.jukebox.playing()) window.jukebox.stop();
  else if (!document.getElementById("btn-play").disabled) window.jukebox.play();
});

let smooth = 0;
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.1);
  const playing = !!(window.jukebox && window.jukebox.playing());
  const level = playing ? window.jukebox.level() : 0;
  smooth += (level - smooth) * 0.25;

  if (playing && !wasPlaying && controls) {
    swayBase = controls.getAzimuthalAngle();
    swayT = 0;
  }
  if (playing !== wasPlaying && mixer) {
    for (const a of actions) {
      a.reset();
      a.timeScale = playing ? 1 : -1.5; // start: płyta wjeżdża, stop: wraca
      if (!playing) a.time = a.getClip().duration;
      a.play();
    }
  }
  wasPlaying = playing;
  if (mixer) mixer.update(dt);
  if (playing && vinyl && vinylAxis) vinyl.rotateOnAxis(vinylAxis, dt * 3.5); // ~33 obr/min

  glow.intensity = smooth * 30 * (glow.userData.base || 1) ** 2;
  for (const e of emissive) e.m.emissiveIntensity = e.base * (1 + smooth * 3);
  for (const l of lights) l.l.intensity = l.base * (1 + smooth * 2.5);
  if (sparkles) {
    sparkles.material.uniforms.time.value += dt;
    sparkles.material.uniforms.level.value = smooth;
  }
  if (controls) {
    // podczas grania kamera delikatnie się kołysze (dopóki użytkownik sam jej nie obróci)
    if (playing && !userOrbited) {
      swayT += dt;
      const target = swayBase + Math.sin(swayT * 0.5) * 0.35;
      const off = camera.position.clone().sub(controls.target);
      const sph = new THREE.Spherical().setFromVector3(off);
      sph.theta = target;
      camera.position.copy(controls.target).add(new THREE.Vector3().setFromSpherical(sph));
    }
    controls.update();
  }
  renderer.render(scene, camera);
});
