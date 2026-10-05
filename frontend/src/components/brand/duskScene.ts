/*
 * The living scene, "Alignment".
 * Two monoliths are the range bounds. The setting sun is the price.
 * A graduated scale runs across the plaza like the axis of an instrument.
 * When the sun leaves the gap, the monoliths slide to re-centre on it: a rebalance.
 * It is an illustration of how the product behaves, not a reading of any vault, so it shows no figures.
 *
 * This module pulls in three.js, so it is loaded on demand (see SkyScene.tsx).
 */
import {
  ACESFilmicToneMapping, AdditiveBlending, BackSide, BoxGeometry, CanvasTexture, CircleGeometry, Color, CylinderGeometry,
  DirectionalLight, Fog, Group, HemisphereLight, InstancedMesh, MathUtils, Matrix4, Mesh, MeshBasicMaterial,
  MeshStandardMaterial, PCFShadowMap, PerspectiveCamera, PlaneGeometry, Quaternion, LinearSRGBColorSpace, RepeatWrapping, SRGBColorSpace, Scene,
  ShaderMaterial, SphereGeometry, Sprite, SpriteMaterial, Vector3, WebGLRenderer,
} from 'three';

const RANGE_R = 2.6; // half-width of the gap between the stones (frame-plane units)
const POST_W = 1.5;
const POST_D = 1.1;
const POST_H = 11.5;
const BASE = 0.4; // plaza top
const SCALE_Z = 4.2; // where the graduated scale runs
const SUN_FRAME_Y = 3.45; // where the sun sits, seen through the frame plane
const SUN_FRAME_R = 1.12; // apparent radius on the frame plane
const SUN_FAR = 260; // real distance of the sun disc
// three.js lights are physically based; these keep the look the scene was tuned for
const LIGHT = Math.PI;

export interface DuskScene {
  dispose(): void;
}

function glowTexture(): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  grd.addColorStop(0, 'rgba(255,226,170,0.9)');
  grd.addColorStop(0.2, 'rgba(255,180,100,0.45)');
  grd.addColorStop(0.5, 'rgba(255,140,80,0.12)');
  grd.addColorStop(1, 'rgba(255,120,70,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 256, 256);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}

/** Cut limestone: stable mineral grain, faint bedding and occasional shallow pores. */
function limestoneTextures(anisotropy: number): { color: CanvasTexture; bump: CanvasTexture } {
  // Dense, contrasting grains match the stippled limestone in the flat range drawing.
  const width = 256, height = 512;
  const colorCanvas = document.createElement('canvas');
  const bumpCanvas = document.createElement('canvas');
  colorCanvas.width = bumpCanvas.width = width;
  colorCanvas.height = bumpCanvas.height = height;
  const colorContext = colorCanvas.getContext('2d')!;
  const bumpContext = bumpCanvas.getContext('2d')!;
  const colorPixels = colorContext.createImageData(width, height);
  const bumpPixels = bumpContext.createImageData(width, height);
  let seed = 21;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  // Periodic fields keep the bedding continuous around the four vertical faces.
  const cols = 16, rows = 96;
  const field = Float32Array.from({ length: cols * rows }, () => random());
  const bedding = Float32Array.from({ length: rows }, () => random());
  const smooth = (t: number) => t * t * (3 - 2 * t);
  for (let y = 0; y < height; y++) {
    const fy = y / height * rows, iy = Math.floor(fy), ty = smooth(fy - iy);
    const nextY = (iy + 1) % rows;
    const bed = MathUtils.lerp(bedding[iy], bedding[nextY], ty) - 0.5;
    for (let x = 0; x < width; x++) {
      const fx = x / width * cols, ix = Math.floor(fx), tx = smooth(fx - ix);
      const nextX = (ix + 1) % cols;
      const cloud = MathUtils.lerp(
        MathUtils.lerp(field[iy * cols + ix], field[iy * cols + nextX], tx),
        MathUtils.lerp(field[nextY * cols + ix], field[nextY * cols + nextX], tx), ty,
      ) - 0.5;
      const fine = (random() + random()) / 2 - 0.5;
      const pore = random() > 0.987 ? random() : 0;
      const tone = 200 + fine * 150 + cloud * 20 + bed * 7 - pore * 45;
      const relief = 128 + fine * 55 + cloud * 14 + bed * 10 - pore * 75;
      const i = (y * width + x) * 4;
      for (let channel = 0; channel < 3; channel++) {
        colorPixels.data[i + channel] = tone;
        bumpPixels.data[i + channel] = relief;
      }
      colorPixels.data[i + 3] = bumpPixels.data[i + 3] = 255;
    }
  }
  colorContext.putImageData(colorPixels, 0, 0);
  bumpContext.putImageData(bumpPixels, 0, 0);
  const color = new CanvasTexture(colorCanvas), bump = new CanvasTexture(bumpCanvas);
  // Albedo is authored as linear reflectance; bump is non-color height data.
  color.colorSpace = LinearSRGBColorSpace;
  for (const texture of [color, bump]) {
    texture.wrapS = texture.wrapT = RepeatWrapping;
    texture.anisotropy = anisotropy;
  }
  return { color, bump };
}

/** Unwrap the vertical faces around one perimeter, keeping grain at physical scale. */
function monolithGeometry(): BoxGeometry {
  const geometry = new BoxGeometry(POST_W, POST_H, POST_D);
  const position = geometry.attributes.position, normal = geometry.attributes.normal, uv = geometry.attributes.uv;
  const perimeter = 2 * (POST_W + POST_D);
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i), y = position.getY(i), z = position.getZ(i);
    let u: number;
    if (Math.abs(normal.getY(i)) > 0.5) {
      uv.setXY(i, (x + POST_W / 2) / perimeter, (z + POST_D / 2) / POST_H);
      continue;
    }
    if (normal.getZ(i) > 0.5) u = x + POST_W / 2;
    else if (normal.getX(i) > 0.5) u = POST_W + POST_D / 2 - z;
    else if (normal.getZ(i) < -0.5) u = POST_W + POST_D + POST_W / 2 - x;
    else u = 2 * POST_W + POST_D + POST_D / 2 + z;
    uv.setXY(i, u / perimeter, (y + POST_H / 2) / POST_H);
  }
  return geometry;
}

function ease(x: number): number {
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

/** The price walk: slow swings that now and then carry the sun out of the gap. */
function wander(t: number): number {
  const s = t * 0.55;
  return 2.6 * Math.sin(s * 0.16) + 1.8 * Math.sin(s * 0.061 + 1.7) + 0.8 * Math.sin(s * 0.37 + 0.4);
}

/**
 * Build the scene in `host` and start it. Returns null when WebGL cannot start.
 * `offset` shifts the stones sideways on wide frames so copy beside them stays clear.
 */
export function createDuskScene(host: HTMLElement, opts: { offset?: number } = {}): DuskScene | null {
  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  } catch {
    return null;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFShadowMap;

  const scene = new Scene();
  const horizon = new Color('#94574f');
  scene.fog = new Fog(horizon, 40, 230);

  const camera = new PerspectiveCamera(32, 16 / 9, 0.1, 900);
  const camBase = new Vector3(0, 3.1, 24);
  const look = new Vector3(0, 4.6, 0);
  camera.position.copy(camBase);

  // ---------- Sky ----------
  const skyUniforms = {
    cTop: { value: new Color('#120a0e') },
    cMid: { value: new Color('#3f2430') },
    cLow: { value: horizon.clone() },
    cGlow: { value: new Color('#f59a5e') },
    glowDir: { value: new Vector3(0, 0.02, -1).normalize() },
  };
  scene.add(new Mesh(
    new SphereGeometry(700, 48, 24),
    new ShaderMaterial({
      side: BackSide,
      depthWrite: false,
      fog: false,
      uniforms: skyUniforms,
      vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: [
        'uniform vec3 cTop; uniform vec3 cMid; uniform vec3 cLow; uniform vec3 cGlow; uniform vec3 glowDir;',
        'varying vec3 vDir;',
        'void main(){',
        '  float h = vDir.y;',
        '  vec3 col = mix(cLow, cMid, smoothstep(-0.01, 0.12, h));',
        '  col = mix(col, cTop, smoothstep(0.12, 0.46, h));',
        '  float g = max(dot(normalize(vDir), glowDir), 0.0);',
        '  col += cGlow * (pow(g, 7.0) * 0.42 + pow(g, 70.0) * 0.5) * (1.0 - smoothstep(0.0, 0.35, h));',
        '  gl_FragColor = vec4(col, 1.0);',
        '  #include <tonemapping_fragment>',
        '  #include <colorspace_fragment>',
        '}',
      ].join('\n'),
    }),
  ));

  // ---------- Ground: flat near, dunes far ----------
  const groundGeo = new PlaneGeometry(1200, 1200, 200, 200);
  groundGeo.rotateX(-Math.PI / 2);
  const gp = groundGeo.attributes.position;
  for (let i = 0; i < gp.count; i++) {
    const x = gp.getX(i), z = gp.getZ(i);
    const d = Math.sqrt(x * x + (z + 10) * (z + 10));
    const far = MathUtils.smoothstep(d, 30, 140);
    gp.setY(i, far * (3.2 * Math.sin(x * 0.032 + z * 0.015) + 1.6 * Math.sin(x * 0.081 - z * 0.052) + 0.6 * Math.sin(x * 0.19 + z * 0.13)) - 0.02);
  }
  groundGeo.computeVertexNormals();
  const ground = new Mesh(groundGeo, new MeshStandardMaterial({ color: '#86544a', roughness: 1 }));
  ground.receiveShadow = true;
  scene.add(ground);

  // ---------- Plaza and graduated scale ----------
  const stone = new MeshStandardMaterial({ color: '#b99a88', roughness: 0.95 });
  const limestone = limestoneTextures(Math.min(4, renderer.capabilities.getMaxAnisotropy()));
  const postGeometry = monolithGeometry();
  const monolith = new MeshStandardMaterial({
    // Restore the mean reflectance absorbed by the color map, preserving the dusk palette.
    color: new Color('#e4cdb8').multiplyScalar(255 / 200),
    map: limestone.color, bumpMap: limestone.bump, bumpScale: 0.018, roughness: 0.95,
  });
  const engraving = new MeshStandardMaterial({ color: '#4a2f2b', roughness: 1 });

  const plaza = new Mesh(new BoxGeometry(120, BASE, 90), stone);
  plaza.position.set(0, BASE / 2, -20);
  plaza.receiveShadow = true;
  scene.add(plaza);

  const m4 = new Matrix4(), q = new Quaternion(), sc = new Vector3(), ps = new Vector3();

  // Slab joints: a faint coordinate grid, the floor of the instrument
  const jx: number[] = [], jz: number[] = [];
  for (let z = -60; z <= 22; z += 3.5) jx.push(z);
  for (let x = -56; x <= 56; x += 3.5) jz.push(x);
  const joints = new InstancedMesh(new BoxGeometry(1, 0.01, 1), new MeshStandardMaterial({ color: '#a3836f', roughness: 1 }), jx.length + jz.length);
  let ji = 0;
  for (const z of jx) { sc.set(112, 1, 0.03); ps.set(0, BASE + 0.003, z); joints.setMatrixAt(ji++, m4.compose(ps, q, sc)); }
  for (const x of jz) { sc.set(0.03, 1, 82); ps.set(x, BASE + 0.003, -19); joints.setMatrixAt(ji++, m4.compose(ps, q, sc)); }
  joints.receiveShadow = true;
  scene.add(joints);

  // Ticks every 0.5 units, a long tick every 2.5 (one tick = 25 in price)
  const span = 36, minor = 0.5, count = Math.floor((span * 2) / minor) + 1;
  const ticks = new InstancedMesh(new BoxGeometry(1, 0.02, 1), engraving, count + 1);
  for (let t = 0; t < count; t++) {
    const tx = -span + t * minor;
    const major = Math.abs(tx / 2.5 - Math.round(tx / 2.5)) < 1e-6;
    sc.set(major ? 0.06 : 0.035, 1, major ? 0.9 : 0.4);
    ps.set(tx, BASE + 0.005, SCALE_Z + (major ? 0 : -0.25));
    ticks.setMatrixAt(t, m4.compose(ps, q, sc));
  }
  sc.set(span * 2, 1, 0.03);
  ps.set(0, BASE + 0.005, SCALE_Z + 0.45);
  ticks.setMatrixAt(count, m4.compose(ps, q, sc));
  ticks.receiveShadow = true;
  scene.add(ticks);

  // The band of the scale that is inside the range
  const band = new Mesh(
    new PlaneGeometry(RANGE_R * 2, 1.1),
    new MeshBasicMaterial({ color: new Color('#ffb14f'), transparent: true, opacity: 0.3, depthWrite: false, toneMapped: false }),
  );
  band.rotation.x = -Math.PI / 2;
  band.position.set(0, BASE + 0.012, SCALE_Z);
  scene.add(band);

  // Price needle on the scale: the only round-headed thing on the ground
  const needle = new Group();
  const needleHead = new Mesh(new CylinderGeometry(0.26, 0.26, 0.03, 40), new MeshBasicMaterial({ color: new Color('#ffe3a3'), toneMapped: false }));
  needleHead.position.z = 1.1;
  needle.add(new Mesh(new BoxGeometry(0.08, 0.02, 1.9), new MeshBasicMaterial({ color: new Color('#ffd28a'), toneMapped: false })), needleHead);
  needle.position.set(0, BASE + 0.02, SCALE_Z);
  scene.add(needle);

  // ---------- The range: two monoliths ----------
  const makePost = () => {
    const mesh = new Mesh(postGeometry, monolith);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.position.y = BASE + POST_H / 2;
    scene.add(mesh);
    return mesh;
  };
  const postL = makePost(), postR = makePost();

  // Other ranges far away in the haze
  const farPair = (x: number, z: number, s: number, ry: number) => {
    const g = new Group();
    const a = new Mesh(postGeometry, monolith);
    a.position.set(-(RANGE_R + POST_W / 2), POST_H / 2, 0);
    const b = a.clone();
    b.position.x = RANGE_R + POST_W / 2;
    g.add(a, b);
    g.position.set(x, 0, z);
    g.scale.setScalar(s);
    g.rotation.y = ry;
    scene.add(g);
  };
  farPair(-34, -60, 0.8, 0.3);
  farPair(40, -85, 0.65, -0.35);
  farPair(-70, -130, 0.7, 0.2);

  // ---------- The sun = the price ----------
  const sun = new Mesh(new CircleGeometry(1, 96), new ShaderMaterial({
    toneMapped: false,
    fog: false,
    uniforms: { core: { value: new Color('#fff0cc') }, rim: { value: new Color('#ff9a4a') } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: [
      'uniform vec3 core; uniform vec3 rim; varying vec2 vUv;',
      'void main(){ float d = length(vUv - 0.5) * 2.0; vec3 c = mix(core, rim, smoothstep(0.1, 1.0, d)); gl_FragColor = vec4(c, 1.0);',
      '  #include <colorspace_fragment>',
      '}',
    ].join('\n'),
  }));
  scene.add(sun);
  const glowTex = glowTexture();
  const glowSprite = (opacity: number) => {
    const s = new Sprite(new SpriteMaterial({
      map: glowTex, color: new Color('#ffb070'), transparent: true, opacity,
      blending: AdditiveBlending, depthWrite: false, toneMapped: false, fog: false,
    }));
    scene.add(s);
    return s;
  };
  const glowNear = glowSprite(0.75), glowFar = glowSprite(0.3);

  // Low sun: long shadows of the stones across the plaza
  const sunLight = new DirectionalLight('#ffb07a', 1.7 * LIGHT);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(2048, 2048);
  sunLight.shadow.bias = -0.0008;
  const shadowCam = sunLight.shadow.camera;
  shadowCam.left = -34; shadowCam.right = 34; shadowCam.top = 34; shadowCam.bottom = -34; shadowCam.near = 1; shadowCam.far = 140;
  scene.add(sunLight, sunLight.target);
  scene.add(new HemisphereLight('#b98a92', '#2a161a', 0.85 * LIGHT));
  const fill = new DirectionalLight('#f0cdbd', 0.55 * LIGHT);
  fill.position.set(-12, 10, 22);
  scene.add(fill);

  // ---------- Motion ----------
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  const sim = { t: 16, u: 0, rangeX: 0, mode: 'in' as 'in' | 'out' | 'rebalancing', modeT: 0, from: 0, to: 0, last: -99 };
  const pointer = { x: 0, y: 0, cx: 0, cy: 0 };
  const follow = { k: 0.35, x: 0 };
  const frame = { offset: opts.offset ?? 0, on: true };
  const v3 = new Vector3(), dir = new Vector3();
  let raf = 0, visible = true, lastTime = 0, disposed = false;

  function step(dt: number) {
    sim.t += dt;
    sim.u = wander(sim.t);
    const off = sim.u - sim.rangeX;
    if (sim.mode === 'in') {
      if (Math.abs(off) > RANGE_R && sim.t - sim.last > 6) { sim.mode = 'out'; sim.modeT = 0; }
    } else if (sim.mode === 'out') {
      // the price has to stay outside for a moment before the range moves
      sim.modeT += dt;
      if (sim.modeT > 1.6) { sim.mode = 'rebalancing'; sim.modeT = 0; sim.from = sim.rangeX; sim.to = wander(sim.t + 1.4); }
    } else {
      sim.modeT += dt;
      const k = Math.min(sim.modeT / 2.8, 1);
      sim.rangeX = sim.from + (sim.to - sim.from) * ease(k);
      if (k >= 1) { sim.mode = 'in'; sim.last = sim.t; }
    }
  }

  function applyScene() {
    pointer.cx += (pointer.x - pointer.cx) * 0.04;
    pointer.cy += (pointer.y - pointer.cy) * 0.04;
    follow.x += (sim.rangeX * follow.k - follow.x) * 0.03;
    const shift = frame.on ? frame.offset : 0;
    camera.position.set(camBase.x + follow.x + shift + pointer.cx * 0.8, camBase.y + pointer.cy * 0.3, camBase.z);
    look.x = follow.x + shift;
    camera.lookAt(look);

    postL.position.x = sim.rangeX - (RANGE_R + POST_W / 2);
    postR.position.x = sim.rangeX + (RANGE_R + POST_W / 2);
    band.position.x = sim.rangeX;
    needle.position.x = sim.u;

    // Put the far sun on the ray that passes through (u, SUN_FRAME_Y) on the frame plane,
    // so it always sits exactly where the price is, whatever the camera does.
    v3.set(sim.u, SUN_FRAME_Y, 0);
    dir.copy(v3).sub(camera.position);
    const k = (SUN_FAR + camera.position.z) / camera.position.z;
    sun.position.copy(camera.position).addScaledVector(dir, k);
    const r = SUN_FRAME_R * k;
    sun.scale.set(r, r, 1);
    sun.lookAt(camera.position);
    glowNear.position.copy(camera.position).addScaledVector(dir, k * 1.03);
    glowNear.scale.set(r * 4.6, r * 4.6, 1);
    glowFar.position.copy(glowNear.position);
    glowFar.scale.set(r * 13, r * 13, 1);

    skyUniforms.glowDir.value.copy(dir.normalize());
    sunLight.position.set(sim.u * 6, 7.5, -48);
    sunLight.target.position.set(sim.rangeX * 0.4, 0, 6);
  }

  function render() {
    renderer.render(scene, camera);
  }

  function loop(now: number) {
    raf = requestAnimationFrame(loop);
    const dt = lastTime ? Math.min((now - lastTime) / 1000, 0.05) : 0.016;
    lastTime = now;
    step(dt);
    applyScene();
    render();
  }
  function start() {
    if (raf || reduced || disposed || !visible || document.hidden) return;
    lastTime = 0;
    raf = requestAnimationFrame(loop);
  }
  function stop() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  function resize() {
    const w = host.clientWidth || 1, h = host.clientHeight || 1, a = w / h;
    renderer.setSize(w, h, false);
    camera.aspect = a;
    camera.fov = a < 0.8 ? 56 : a < 1.3 ? 40 : 32;
    camBase.z = a < 0.8 ? 29 : 24;
    follow.k = a < 0.8 ? 1 : a < 1.3 ? 0.7 : 0.55;
    // Wide frames: move the stones aside so the copy beside them stays clear
    frame.on = a >= 1.3;
    camera.updateProjectionMatrix();
    if (!raf) { applyScene(); render(); }
  }

  const onPointer = (e: PointerEvent) => {
    pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
    pointer.y = -((e.clientY / window.innerHeight) * 2 - 1);
  };
  const onVisibility = () => (document.hidden ? stop() : start());
  const ro = new ResizeObserver(resize);
  // Only animate while the scene is on screen
  const io = new IntersectionObserver((entries) => {
    visible = entries[0].isIntersecting;
    if (visible) start(); else stop();
  });

  host.appendChild(renderer.domElement);
  ro.observe(host);
  io.observe(host);
  window.addEventListener('pointermove', onPointer, { passive: true });
  document.addEventListener('visibilitychange', onVisibility);
  resize();
  applyScene();
  render();
  start();

  return {
    dispose() {
      disposed = true;
      stop();
      ro.disconnect();
      io.disconnect();
      window.removeEventListener('pointermove', onPointer);
      document.removeEventListener('visibilitychange', onVisibility);
      scene.traverse((o) => {
        const mesh = o as Mesh;
        mesh.geometry?.dispose();
        const mat = mesh.material;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose()); else mat?.dispose();
      });
      limestone.color.dispose();
      limestone.bump.dispose();
      glowTex.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
