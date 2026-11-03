/**
 * Normal-Mapped Terrain — PoC orchestration.
 *
 * Pipeline: heightfield (float, high-res)  ──Sobel──▶  normal map (RGB)
 *              │
 *              └─bilinear─▶ low-res mesh (three.js vertex normals = mode A)
 *
 * The mesh is shaded by a custom ShaderMaterial whose pixel shader reads
 * the normal map (mode B). Mode C shows a dense reference mesh so you can
 * judge how much of the "real" detail mode B recovers at a fraction of
 * the triangle count.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { buildProceduralDataset, buildGrandCanyonDataset } from './terrain-data.js';
import { generateNormalMap, heightPreviewRGBA } from './normalmap.js';
import { buildTerrainGeometry } from './geometry.js';
import { terrainVertexShader, terrainFragmentShader, skyVertexShader, skyFragmentShader } from './shaders.js';
import { initUI } from './ui.js';

const REF_SEGMENTS_CAP = 1024;
// Canonical "generic" view direction for datasets without their own
// defaultView (restores the original framing behaviour where the boot
// camera's direction defined it).
const DEFAULT_VIEW_DIR = new THREE.Vector3(0.55, 0.38, 0.85).normalize();

const state = {
  mode: 'B',            // 'A' | 'split' | 'B' | 'C'
  split: 0.5,
  datasetId: 'procedural',
  meshSegs: 192,
  refSegs: REF_SEGMENTS_CAP,
  sunAz: 305,
  sunEl: 34,
  normalStrength: 1.0,
  wireframe: false,
};

const datasets = new Map();     // id -> dataset
const normalTextures = new Map(); // id -> { normal, height }
const lowGeoCache = new Map();  // `${id}:${segs}` -> geometry (LRU)
const refGeoCache = new Map();  // id -> geometry
let currentTriCount = 0;

let renderer, scene, camera, controls, terrainMesh, wireMesh, sky;
let terrainMat, skyMat;

const nextFrame = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
const fmtTris = (t) => (t >= 1e6 ? (t / 1e6).toFixed(1) + 'M' : Math.round(t / 1000) + 'k');

const PALETTES = {
  procedural: { snowStart: 0.58, grass: 1.0, sand: 0.55, spec: 0.10 },
  'grand-canyon': { snowStart: 2.5, grass: 0.15, sand: 1.0, spec: 0.16 },
};

// ---------------------------------------------------------------- UI hooks
const ui = initUI({
  onModeChange: (mode) => setMode(mode),
  onDatasetChange: async (id) => {
    ui.toast('Loading dataset…', true);
    await setDataset(id);
    ui.toast(state.datasetInfo?.name || 'Ready');
  },
  onSunChange: (az, el) => { state.sunAz = az; state.sunEl = el; updateSun(); },
  onMeshResChange: (segs) => { state.meshSegs = segs; rebuildLowMesh(); },
  onNormalStrength: (s) => { state.normalStrength = s; terrainMat.uniforms.uNormalStrength.value = s; },
  onWireframe: (on) => { state.wireframe = on; wireMesh.visible = on; },
  onSplitChange: (r) => { state.split = r; },
});

// ---------------------------------------------------------------- boot
async function boot() {
  ui.setLoading(0.02, 'Generating heightfield…');
  const procedural = await buildProceduralDataset((p) => ui.setLoading(0.02 + p * 0.55, `Generating heightfield… ${Math.round(p * 100)}%`));
  datasets.set('procedural', procedural);

  ui.setLoading(0.60, 'Baking normal map…');
  await nextFrame();
  const normalRGBA = generateNormalMap(procedural.heights, procedural.res, procedural.worldSizeX, procedural.worldSizeZ, procedural.heightScale);
  const heightRGBA = heightPreviewRGBA(procedural.heights, procedural.res);
  normalTextures.set('procedural', makeTextures(normalRGBA, heightRGBA, procedural.res));

  ui.setLoading(0.72, 'Building terrain mesh…');
  await nextFrame();
  initScene();
  await setDataset('procedural', { keepCamera: true });

  ui.setLoading(1.0, 'Ready');
  await nextFrame();
  ui.hideLoading();
  animate();

  // Preload the real-world dataset in the background so switching feels instant
  setTimeout(async () => {
    if (datasets.has('grand-canyon')) return;
    const gc = await buildGrandCanyonDataset();
    datasets.set('grand-canyon', gc);
    const nm = generateNormalMap(gc.heights, gc.res, gc.worldSizeX, gc.worldSizeZ, gc.heightScale);
    normalTextures.set('grand-canyon', makeTextures(nm, heightPreviewRGBA(gc.heights, gc.res), gc.res));
  }, 1500);
}

function makeTextures(normalRGBA, heightRGBA, res) {
  const maxAniso = renderer ? renderer.capabilities.getMaxAnisotropy() : 8;
  const mk = (data) => {
    const t = new THREE.DataTexture(data, res, res, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = maxAniso;
    t.needsUpdate = true;
    return t;
  };
  return { normal: mk(normalRGBA), height: mk(heightRGBA) };
}

// ---------------------------------------------------------------- scene
function initScene() {
  const canvas = document.getElementById('scene');
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 2, 200000);
  // Boot framing: an overlook of the composed ridge chain south of the tile
  // centre (seed 20260117 puts a 950 m range at (400, −3000) running SSW).
  // Deterministic — the seed is fixed in terrain-data.js. The sunlit face
  // points SSE (default sun az 305°), so the camera sits over the south
  // falloff ring looking back up the slope.
  camera.position.set(910, 1500, -4394);
  controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.maxPolarAngle = Math.PI * 0.495;
  controls.minDistance = 150;
  controls.target.set(400, 710, -3000);

  terrainMat = new THREE.ShaderMaterial({
    vertexShader: terrainVertexShader,
    fragmentShader: terrainFragmentShader,
    uniforms: {
      uNormalMap: { value: null },
      uHeightMap: { value: null },
      uNormalBlend: { value: 1.0 },
      uNormalStrength: { value: 1.0 },
      uSunDirection: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Color(1, 0.97, 0.9) },
      uSkyColor: { value: new THREE.Color(0.20, 0.42, 0.72) },
      uGroundColor: { value: new THREE.Color(0.24, 0.23, 0.21) },
      uFogColor: { value: new THREE.Color(0.68, 0.78, 0.88) },
      uFogDensity: { value: 4.0e-5 },
      uHeightScale: { value: 1450 },
      uSnowStart: { value: 0.58 },
      uGrassStrength: { value: 1.0 },
      uSandStrength: { value: 0.55 },
      uSpecular: { value: 0.10 },
    },
  });

  terrainMesh = new THREE.Mesh(new THREE.BufferGeometry(), terrainMat);
  scene.add(terrainMesh);

  wireMesh = new THREE.Mesh(
    terrainMesh.geometry,
    new THREE.MeshBasicMaterial({
      color: 0x7fdcff, wireframe: true, transparent: true, opacity: 0.16,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2,
    })
  );
  wireMesh.visible = false;
  scene.add(wireMesh);

  skyMat = new THREE.ShaderMaterial({
    vertexShader: skyVertexShader,
    fragmentShader: skyFragmentShader,
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      uZenith: { value: new THREE.Color(0.20, 0.42, 0.72) },
      uHorizon: { value: new THREE.Color(0.68, 0.78, 0.88) },
      uSunDirection: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Color(1, 0.97, 0.9) },
    },
  });
  sky = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 32), skyMat);
  sky.frustumCulled = false;
  scene.add(sky);

  window.addEventListener('resize', onResize);
  updateSun();
}

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight, false);
}

// ---------------------------------------------------------------- dataset / geometry
async function setDataset(id, { keepCamera = false } = {}) {
  if (!datasets.has(id)) {
    ui.toast('Downloading & baking dataset…', true);
    await nextFrame();
    const ds = id === 'grand-canyon' ? await buildGrandCanyonDataset() : await buildProceduralDataset();
    datasets.set(id, ds);
    const nm = generateNormalMap(ds.heights, ds.res, ds.worldSizeX, ds.worldSizeZ, ds.heightScale);
    normalTextures.set(id, makeTextures(nm, heightPreviewRGBA(ds.heights, ds.res), ds.res));
  }

  const ds = datasets.get(id);
  state.datasetId = id;
  state.datasetInfo = ds;

  const { normal, height } = normalTextures.get(id);
  const u = terrainMat.uniforms;
  u.uNormalMap.value = normal;
  u.uHeightMap.value = height;
  u.uHeightScale.value = ds.heightScale;

  const pal = PALETTES[id] ?? PALETTES.procedural;
  u.uSnowStart.value = pal.snowStart;
  u.uGrassStrength.value = pal.grass;
  u.uSandStrength.value = pal.sand;
  u.uSpecular.value = pal.spec;

  const maxDim = Math.max(ds.worldSizeX, ds.worldSizeZ);
  u.uFogDensity.value = 0.42 / (maxDim * 1.55);

  if (!keepCamera) {
    const dv = ds.defaultView;
    if (dv) {
      camera.position.set(dv.position[0], dv.position[1], dv.position[2]);
      controls.target.set(dv.target[0], dv.target[1], dv.target[2]);
    } else {
      // Generic framing (e.g. Grand Canyon): fixed high diagonal view.
      const maxDim0 = Math.max(ds.worldSizeX, ds.worldSizeZ);
      camera.position.copy(DEFAULT_VIEW_DIR).multiplyScalar(maxDim0 * 0.95);
      controls.target.set(0, ds.heightScale * 0.25, 0);
    }
  }
  controls.maxDistance = maxDim * 2.2;
  camera.far = maxDim * 8;
  camera.updateProjectionMatrix();
  sky.scale.setScalar(maxDim * 2.5);

  state.refSegs = Math.min(REF_SEGMENTS_CAP, ds.res >> 1);
  rebuildLowMesh();
  refGeoCache.delete(id); // force rebuild against new dataset

  ui.setPipelineRes(`${ds.res}²`);
  ui.setDatasetInfo(ds.info, ds.credit);
  ui.setTriLabels({
    low: `≈${fmtTris(state.meshSegs * state.meshSegs * 2)} tris`,
    ref: `≈${fmtTris(state.refSegs * state.refSegs * 2)} tris`,
  });
  ui.setPreviews(heightPreviewRGBA(ds.heights, ds.res), normalTextures.get(id).normal.image.data, ds.res);
  setMode(state.mode, { silent: true });
}

function lowGeoKey() { return `${state.datasetId}:${state.meshSegs}`; }

function rebuildLowMesh() {
  const ds = datasets.get(state.datasetId);
  const key = lowGeoKey();
  let entry = lowGeoCache.get(key);
  if (!entry) {
    const built = buildTerrainGeometry(ds, state.meshSegs);
    entry = built;
    lowGeoCache.set(key, built);
    // crude LRU: keep at most 10 cached geometries
    while (lowGeoCache.size > 10) {
      const first = lowGeoCache.keys().next().value;
      lowGeoCache.get(first).geometry.dispose();
      lowGeoCache.delete(first);
    }
  }
  // refresh LRU order
  lowGeoCache.delete(key); lowGeoCache.set(key, entry);

  if (state.mode !== 'C') {
    terrainMesh.geometry = entry.geometry;
    wireMesh.geometry = entry.geometry;
    currentTriCount = entry.triangles;
  }
  ui.setTriLabels({
    low: `≈${fmtTris(state.meshSegs * state.meshSegs * 2)} tris`,
    ref: `≈${fmtTris(state.refSegs * state.refSegs * 2)} tris`,
  });
}

async function ensureRefMesh() {
  const id = state.datasetId;
  if (!refGeoCache.has(id)) {
    ui.toast(`Building ${state.refSegs}² reference mesh…`, true);
    await nextFrame();
    const built = buildTerrainGeometry(datasets.get(id), state.refSegs);
    refGeoCache.set(id, built);
    ui.toast('Reference mesh ready');
  }
  return refGeoCache.get(id);
}

// ---------------------------------------------------------------- modes
async function setMode(mode, { silent = false } = {}) {
  state.mode = mode;
  ui.showSplit(mode === 'split');
  if (mode === 'C') {
    const ref = await ensureRefMesh();
    if (state.mode !== 'C') return; // user switched away meanwhile
    terrainMesh.geometry = ref.geometry;
    wireMesh.geometry = ref.geometry;
    currentTriCount = ref.triangles;
  } else {
    const entry = lowGeoCache.get(lowGeoKey());
    if (entry) {
      terrainMesh.geometry = entry.geometry;
      wireMesh.geometry = entry.geometry;
      currentTriCount = entry.triangles;
    }
  }
  if (!silent) updateStatsNow();
}

// ---------------------------------------------------------------- sun
function updateSun() {
  const az = THREE.MathUtils.degToRad(state.sunAz);
  const el = THREE.MathUtils.degToRad(state.sunEl);
  const dir = new THREE.Vector3(
    Math.sin(az) * Math.cos(el),
    Math.sin(el),
    -Math.cos(az) * Math.cos(el)
  ).normalize();

  const t = THREE.MathUtils.smoothstep(state.sunEl, 10, 42); // sunset -> daylight
  const sunColor = new THREE.Color(1.0, 0.50, 0.22).lerp(new THREE.Color(1.0, 0.98, 0.92), t);
  const zenith = new THREE.Color(0.060, 0.24, 0.70).lerp(new THREE.Color(0.085, 0.11, 0.24), 1 - t);
  const horizon = new THREE.Color(0.52, 0.72, 0.94).lerp(new THREE.Color(0.98, 0.50, 0.24), 1 - t);
  const ground = new THREE.Color(0.14, 0.10, 0.075).lerp(new THREE.Color(0.26, 0.25, 0.23), t);

  const u = terrainMat.uniforms;
  u.uSunDirection.value.copy(dir);
  u.uSunColor.value.copy(sunColor);
  u.uSkyColor.value.copy(zenith);
  u.uGroundColor.value.copy(ground);
  u.uFogColor.value.copy(horizon);

  skyMat.uniforms.uSunDirection.value.copy(dir);
  skyMat.uniforms.uSunColor.value.copy(sunColor);
  skyMat.uniforms.uZenith.value.copy(zenith);
  skyMat.uniforms.uHorizon.value.copy(horizon);
}

// ---------------------------------------------------------------- loop
let frames = 0;
let lastStats = performance.now();

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  sky.position.copy(camera.position);

  const w = window.innerWidth, h = window.innerHeight;
  if (state.mode === 'split') {
    const splitX = Math.floor(w * state.split);
    renderer.setScissorTest(true);
    terrainMat.uniforms.uNormalBlend.value = 0.0; // left: vertex normals
    renderer.setScissor(0, 0, splitX, h);
    renderer.setViewport(0, 0, w, h);
    renderer.render(scene, camera);
    terrainMat.uniforms.uNormalBlend.value = 1.0; // right: normal map
    renderer.setScissor(splitX, 0, w - splitX, h);
    renderer.render(scene, camera);
    renderer.setScissorTest(false);
  } else {
    terrainMat.uniforms.uNormalBlend.value = state.mode === 'B' ? 1.0 : 0.0;
    renderer.render(scene, camera);
  }

  frames++;
  const now = performance.now();
  if (now - lastStats > 500) {
    updateStatsNow(Math.round((frames * 1000) / (now - lastStats)));
    frames = 0;
    lastStats = now;
  }
}

function updateStatsNow(fps) {
  const ds = datasets.get(state.datasetId);
  const meshRes = state.mode === 'C' ? state.refSegs : state.meshSegs;
  ui.setStats({
    fps: fps ?? '–',
    tris: fmtTris(currentTriCount),
    mesh: `${meshRes}²`,
    map: `${ds ? ds.res : '–'}²`,
  });
}

boot().catch(err => {
  console.error(err);
  const status = document.getElementById('loading-status');
  status.textContent = `Failed to start: ${err.message}`;
  status.style.color = '#ff7d7d';
});
