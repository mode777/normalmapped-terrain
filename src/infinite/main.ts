/**
 * Infinite Terrain — PoC orchestration.
 *
 * Pipeline:
 *   procedural height function (worker)
 *     ├─ 64x64 height tiles ─┐
 *     └─ 64x64 normal tiles ─┤
 *                            ▼
 *              toroidal tile cache per LOD (DataArrayTexture)
 *                            │
 *   clipmap rings (2 draw calls) ── vertex shader height fetch
 *                            └── fragment shader normal-map fetch
 *
 * The camera flies in absolute world doubles; a floating render origin is
 * subtracted before touching the GPU.
 */

import * as THREE from 'three';
import { makeHeightField, DEFAULT_SEED, DEFAULT_HEIGHT_SCALE } from './heightfield.ts';
import type { HeightField } from './heightfield.ts';
import { buildCenterInstances, buildRingInstances } from './clipmap.ts';
import { snapLevelOrigins } from './origins.ts';
import { TileStreamer } from './tiles.ts';
import {
  terrainVertexShader,
  terrainFragmentShader,
  debugVertexShader,
  debugFragmentShader,
} from './shaders.ts';
import { skyVertexShader, skyFragmentShader } from '../sky-shaders.ts';
import { FlightController } from './flight.ts';
import { initUI } from './ui.ts';
import type { UIApi } from './ui.ts';

const CONFIG = {
  seed: DEFAULT_SEED,
  baseSpacing: 2,       // metres between near-field vertices; 0.25m normal texels
  centerCells: 24,      // centre block half-size and ring width, in cells
  levels: 10,           // rings at LOD 0..9; 2m * 2^9 keeps the ~49km view
  tileSize: 64,         // height samples per tile side
  normalScale: 8,       // normal-map texels per height sample (8x mesh)
  cacheTiles: 4,        // 4x4 tiles per LOD layer; 4*64*8 = 2048 (ceiling)
  heightScale: DEFAULT_HEIGHT_SCALE,
  skirtDepth: 420,      // metres of horizon skirt
  morphCells: 3,        // outer cells of each ring blended into the next LOD
} as const;

const OUTER_EXTENT = 2 * CONFIG.centerCells * CONFIG.baseSpacing * Math.pow(2, CONFIG.levels - 1);
const CACHE_SIZE = CONFIG.cacheTiles * CONFIG.tileSize;
const NORMAL_CACHE_SIZE = CACHE_SIZE * CONFIG.normalScale;
// Keep the cache inside WebGL2's guaranteed minimum MAX_TEXTURE_SIZE (2048).
// Resolution is increased by reducing world spacing, not by growing the cache.
const MAX_CACHE_TEXELS = 2048;
if (CACHE_SIZE > MAX_CACHE_TEXELS || NORMAL_CACHE_SIZE > MAX_CACHE_TEXELS) {
  throw new Error(`tile cache ${CACHE_SIZE}/${NORMAL_CACHE_SIZE} exceeds ${MAX_CACHE_TEXELS} texels`);
}
const FOG_DENSITY = 2.4 / OUTER_EXTENT;
// Largest tile-cache world size. Every lower LOD's cache size divides it, so
// passing the render origin modulo this value is enough for every layer and
// keeps the uniform small after long flights.
const PHASE_WRAP = CONFIG.cacheTiles * CONFIG.tileSize * CONFIG.baseSpacing
  * Math.pow(2, CONFIG.levels - 1);
// Floating-origin granularity. A multiple of every level spacing so vertices
// land exactly on height-texel centres (no static half-texel bias), and a
// divisor of PHASE_WRAP so the toroidal phase survives a rebase.
const RENDER_ORIGIN_STEP = CONFIG.baseSpacing * Math.pow(2, CONFIG.levels + 1);

interface AppState {
  sunAz: number;
  sunEl: number;
  normalStrength: number;
  wireframe: boolean;
  lodDebug: boolean;
  autoCruise: boolean;
}

interface OriginTarget {
  geo: THREE.InstancedBufferGeometry;
  levels: number[];
}

type TerrainUniforms = {
  uHeightArray: THREE.IUniform<THREE.DataArrayTexture>;
  uNormalArray: THREE.IUniform<THREE.DataArrayTexture>;
  uHeightScale: THREE.IUniform<number>;
  uRenderOrigin: THREE.IUniform<THREE.Vector2>;
  uBaseSpacing: THREE.IUniform<number>;
  uTileCells: THREE.IUniform<number>;
  uNormalTileCells: THREE.IUniform<number>;
  uCacheTiles: THREE.IUniform<number>;
  uSkirtDepth: THREE.IUniform<number>;
  uLevels: THREE.IUniform<number>;
  uCenterCells: THREE.IUniform<number>;
  uMorphCells: THREE.IUniform<number>;
  uPixelScale: THREE.IUniform<number>;
  uNormalStrength: THREE.IUniform<number>;
  uSunDirection: THREE.IUniform<THREE.Vector3>;
  uSunColor: THREE.IUniform<THREE.Color>;
  uSkyColor: THREE.IUniform<THREE.Color>;
  uGroundColor: THREE.IUniform<THREE.Color>;
  uFogColor: THREE.IUniform<THREE.Color>;
  uFogDensity: THREE.IUniform<number>;
  uSnowStart: THREE.IUniform<number>;
  uGrassStrength: THREE.IUniform<number>;
  uSandStrength: THREE.IUniform<number>;
  uSpecular: THREE.IUniform<number>;
  uDebugLod: THREE.IUniform<number>;
  uDebugTiles: THREE.IUniform<number>;
};

type SkyUniforms = {
  uZenith: THREE.IUniform<THREE.Color>;
  uHorizon: THREE.IUniform<THREE.Color>;
  uSunDirection: THREE.IUniform<THREE.Vector3>;
  uSunColor: THREE.IUniform<THREE.Color>;
};

export interface InfiniteQA {
  config: typeof CONFIG;
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  flight: FlightController;
  streamer: TileStreamer;
  readonly state: AppState & { renderOrigin: number[] };
  setPaused(paused: boolean): void;
  setAutoCruise(on: boolean): void;
  setLodDebug(on: boolean): void;
  setTileDebug(on: boolean): void;
  setWireframe(on: boolean): void;
  setCrackDebug(on: boolean): void;
  waitForTiles(): Promise<void>;
  warpTo(x: number, z: number, y?: number | null): Promise<void>;
  groundHeight(): number;
  getLevelOrigins(): { x: number; z: number; origins: number[] };
}

declare global {
  interface Window {
    __infinite: InfiniteQA;
  }
}

const state: AppState = {
  sunAz: 305,
  sunEl: 34,
  normalStrength: 1,
  wireframe: false,
  lodDebug: false,
  autoCruise: true,
};

const renderOrigin = new THREE.Vector2(0, 0);
// Absolute world x/z per level, refreshed every frame from the camera.
const levelOrigins = new Float64Array(CONFIG.levels * 2);

let renderer!: THREE.WebGLRenderer;
let scene!: THREE.Scene;
let camera!: THREE.PerspectiveCamera;
let sky!: THREE.Mesh;
let skyMat!: THREE.ShaderMaterial;
let terrainMat!: THREE.ShaderMaterial;
let debugMat!: THREE.ShaderMaterial;
let debugGroup!: THREE.Group;
let centerMesh!: THREE.Mesh;
let innerRingMesh!: THREE.Mesh;
let outerRingMesh!: THREE.Mesh;
let originTargets: OriginTarget[] = [];
let heightField!: HeightField;
let flight!: FlightController;
let streamer!: TileStreamer;
let ui!: UIApi;
let heightTexture!: THREE.DataArrayTexture;
let normalTexture!: THREE.DataArrayTexture;
let heightType!: THREE.TextureDataType;
let terrainUniforms!: TerrainUniforms;
let skyUniforms!: SkyUniforms;

let lastFrame = performance.now();
let frames = 0;
let lastStats = performance.now();

const nextFrame = (): Promise<void> => new Promise((resolve) => {
  requestAnimationFrame(() => { setTimeout(resolve, 0); });
});
const formatCount = (n: number): string =>
  (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
const wrapPhase = (v: number, m: number): number => ((v % m) + m) % m;
const bufferSize = new THREE.Vector2();

/** Radians of view per fragment; drives the ring-boundary trim slack. */
function pixelScale(): number {
  renderer.getDrawingBufferSize(bufferSize);
  return (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / Math.max(1, bufferSize.y);
}

function setCheckbox(id: string, checked: boolean): void {
  const el = document.getElementById(id);
  if (el instanceof HTMLInputElement) el.checked = checked;
}

async function boot(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const startCruise = params.get('cruise') !== '0';

  ui = initUI({
    onSunChange: (az, el) => { state.sunAz = az; state.sunEl = el; updateSun(); },
    onNormalStrength: (s) => {
      state.normalStrength = s;
      if (terrainMat) terrainUniforms.uNormalStrength.value = s;
    },
    onWireframe: (on) => { state.wireframe = on; if (debugGroup) debugGroup.visible = on; },
    onLodDebug: (on) => {
      state.lodDebug = on;
      if (terrainMat) terrainUniforms.uDebugLod.value = on ? 1 : 0;
    },
    onTileDebug: (on) => {
      if (terrainMat) terrainUniforms.uDebugTiles.value = on ? 1 : 0;
    },
    onAutoCruise: (on) => {
      state.autoCruise = on;
      flight?.setAutoCruise(on);
    },
    onSpeedChange: (s) => { flight?.setSpeed(s); },
    onReset: () => resetView(),
  });

  ui.setLoading(0.02, 'Creating renderer…');
  await nextFrame();
  initRenderer();

  heightField = makeHeightField(CONFIG.seed);
  flight = new FlightController({
    camera,
    canvas: renderer.domElement,
    heightAt: heightField.heightAt,
    heightScale: CONFIG.heightScale,
    initialSpeed: 80,
  });
  flight.autoCruise = startCruise;
  flight.onAutoCruiseChange = (on) => {
    state.autoCruise = on;
    ui.setAutoCruise(on);
  };
  flight.onSpeedChange = (s) => ui.setSpeed(s);
  flight.onPointerLockChange = (locked) => ui.setPointerLock(locked);
  state.autoCruise = startCruise;
  ui.setAutoCruise(startCruise);
  ui.setSpeed(flight.speed);

  ui.setLoading(0.06, 'Creating texture arrays…');
  await nextFrame();
  createTextures();

  ui.setLoading(0.10, 'Starting terrain worker…');
  streamer = new TileStreamer({
    renderer,
    seed: CONFIG.seed,
    baseSpacing: CONFIG.baseSpacing,
    tileSize: CONFIG.tileSize,
    cacheTiles: CONFIG.cacheTiles,
    levels: CONFIG.levels,
    heightScale: CONFIG.heightScale,
    heightTexture,
    normalTexture,
    heightType,
    normalScale: CONFIG.normalScale,
    onProgress: (ratio, p) => {
      ui.setLoading(0.12 + ratio * 0.72, `Generating terrain tiles… ${p.done}/${p.total}`);
    },
  });

  ui.setLoading(0.12, 'Generating terrain tiles…');
  await streamer.prime(flight.x, flight.z);

  ui.setLoading(0.88, 'Building clipmap…');
  await nextFrame();
  buildScene();

  updateSun();
  ui.setLoading(1.0, 'Ready');
  await nextFrame();
  ui.hideLoading();
  ui.setPointerLock(false);

  setupQA();
  animate();
}

function initRenderer(): void {
  const canvas = document.getElementById('scene');
  if (!(canvas instanceof HTMLCanvasElement)) throw new Error('missing #scene canvas');
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.setClearColor(0x0b0f14, 1);

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 2, OUTER_EXTENT * 1.5);
  camera.rotation.order = 'YXZ';

  skyUniforms = {
    uZenith: { value: new THREE.Color(0.20, 0.42, 0.72) },
    uHorizon: { value: new THREE.Color(0.68, 0.78, 0.88) },
    uSunDirection: { value: new THREE.Vector3(0, 1, 0) },
    uSunColor: { value: new THREE.Color(1, 0.97, 0.9) },
  };
  skyMat = new THREE.ShaderMaterial({
    vertexShader: skyVertexShader,
    fragmentShader: skyFragmentShader,
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: skyUniforms,
  });

  sky = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 32), skyMat);
  sky.name = 'sky';
  sky.scale.setScalar(OUTER_EXTENT * 1.3);
  sky.frustumCulled = false;
  scene.add(sky);

  window.addEventListener('resize', onResize);
}

function createTextures(): void {
  // R16F is core-filterable in WebGL2. The half-float step is well below the
  // 16 m vertex spacing.
  heightType = THREE.HalfFloatType;

  const heightData = new Uint16Array(CACHE_SIZE * CACHE_SIZE * CONFIG.levels);
  heightTexture = new THREE.DataArrayTexture(heightData, CACHE_SIZE, CACHE_SIZE, CONFIG.levels);
  heightTexture.format = THREE.RedFormat;
  heightTexture.type = heightType;
  heightTexture.minFilter = THREE.LinearFilter;
  heightTexture.magFilter = THREE.LinearFilter;
  heightTexture.wrapS = THREE.RepeatWrapping;
  heightTexture.wrapT = THREE.RepeatWrapping;
  heightTexture.generateMipmaps = false;
  heightTexture.flipY = false;
  heightTexture.unpackAlignment = 1;
  heightTexture.needsUpdate = true;
  renderer.initTexture(heightTexture);

  const normalData = new Uint8Array(NORMAL_CACHE_SIZE * NORMAL_CACHE_SIZE * CONFIG.levels * 4);
  normalTexture = new THREE.DataArrayTexture(normalData, NORMAL_CACHE_SIZE, NORMAL_CACHE_SIZE, CONFIG.levels);
  normalTexture.format = THREE.RGBAFormat;
  normalTexture.type = THREE.UnsignedByteType;
  normalTexture.minFilter = THREE.LinearFilter;
  normalTexture.magFilter = THREE.LinearFilter;
  normalTexture.wrapS = THREE.RepeatWrapping;
  normalTexture.wrapT = THREE.RepeatWrapping;
  normalTexture.generateMipmaps = false;
  normalTexture.flipY = false;
  normalTexture.unpackAlignment = 1;
  normalTexture.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
  normalTexture.needsUpdate = true;
  renderer.initTexture(normalTexture);

  // The CPU-side buffers are only needed for the initial allocation; every
  // tile after this is uploaded straight to the GPU. Freeing them keeps the
  // 8x normal cache from costing another ~160 MiB on the JS heap.
  (heightTexture.image as { data: Uint16Array | null }).data = null;
  (normalTexture.image as { data: Uint8Array | null }).data = null;
}

function buildScene(): void {
  terrainUniforms = {
    uHeightArray: { value: heightTexture },
    uNormalArray: { value: normalTexture },
    uHeightScale: { value: CONFIG.heightScale },
    uRenderOrigin: { value: new THREE.Vector2(0, 0) },
    uBaseSpacing: { value: CONFIG.baseSpacing },
    uTileCells: { value: CONFIG.tileSize },
    uNormalTileCells: { value: CONFIG.tileSize * CONFIG.normalScale },
    uCacheTiles: { value: CONFIG.cacheTiles },
    uSkirtDepth: { value: CONFIG.skirtDepth },
    uLevels: { value: CONFIG.levels },
    uCenterCells: { value: CONFIG.centerCells },
    uMorphCells: { value: CONFIG.morphCells },
    uPixelScale: { value: pixelScale() },
    uNormalStrength: { value: state.normalStrength },
    uSunDirection: { value: new THREE.Vector3(0, 1, 0) },
    uSunColor: { value: new THREE.Color(1, 0.97, 0.9) },
    uSkyColor: { value: new THREE.Color(0.20, 0.42, 0.72) },
    uGroundColor: { value: new THREE.Color(0.24, 0.23, 0.21) },
    uFogColor: { value: new THREE.Color(0.68, 0.78, 0.88) },
    uFogDensity: { value: FOG_DENSITY },
    uSnowStart: { value: 0.62 },
    uGrassStrength: { value: 0.9 },
    uSandStrength: { value: 0.35 },
    uSpecular: { value: 0.08 },
    uDebugLod: { value: state.lodDebug ? 1 : 0 },
    uDebugTiles: { value: 0 },
  };

  terrainMat = new THREE.ShaderMaterial({
    vertexShader: terrainVertexShader,
    fragmentShader: terrainFragmentShader,
    uniforms: terrainUniforms,
    side: THREE.FrontSide,
  });

  debugMat = new THREE.ShaderMaterial({
    vertexShader: debugVertexShader,
    fragmentShader: debugFragmentShader,
    uniforms: terrainUniforms,
    wireframe: true,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -2,
  });

  const centerGeo = buildCenterInstances(CONFIG.centerCells);
  // Level 0 shares the centre block's lattice and abuts it exactly; every
  // coarser ring is padded by a cell and clipped back to the parent square.
  const innerGeo = buildRingInstances(CONFIG.centerCells, [0], {
    hole: CONFIG.centerCells,
    trim: 0,
  });
  const outerLevels = Array.from({ length: CONFIG.levels - 1 }, (_, i) => i + 1);
  const outerGeo = buildRingInstances(CONFIG.centerCells, outerLevels, {
    outerLevel: CONFIG.levels - 1,
  });

  centerMesh = new THREE.Mesh(centerGeo, terrainMat);
  innerRingMesh = new THREE.Mesh(innerGeo, terrainMat);
  outerRingMesh = new THREE.Mesh(outerGeo, terrainMat);
  centerMesh.name = 'terrain-center';
  innerRingMesh.name = 'terrain-ring-0';
  outerRingMesh.name = 'terrain-rings';
  for (const m of [centerMesh, innerRingMesh, outerRingMesh]) {
    m.frustumCulled = false;
    scene.add(m);
  }

  // Per-frame snapped origins live in instanced attributes.
  originTargets = [
    { geo: centerGeo, levels: [0] },
    { geo: innerGeo, levels: [0] },
    { geo: outerGeo, levels: outerLevels },
  ];

  debugGroup = new THREE.Group();
  debugGroup.name = 'debug-group';
  for (const [geo, name] of [[centerGeo, 'center'], [innerGeo, 'ring-0'], [outerGeo, 'rings']] as const) {
    const m = new THREE.Mesh(geo, debugMat);
    m.frustumCulled = false;
    m.name = `debug-${name}`;
    debugGroup.add(m);
  }
  debugGroup.visible = state.wireframe;
  scene.add(debugGroup);
}

function updateSun(): void {
  if (!terrainMat || !skyMat) return;

  const az = THREE.MathUtils.degToRad(state.sunAz);
  const el = THREE.MathUtils.degToRad(state.sunEl);
  const dir = new THREE.Vector3(
    Math.sin(az) * Math.cos(el),
    Math.sin(el),
    -Math.cos(az) * Math.cos(el),
  ).normalize();

  const t = THREE.MathUtils.smoothstep(state.sunEl, 10, 42);
  const sunColor = new THREE.Color(1.0, 0.50, 0.22).lerp(new THREE.Color(1.0, 0.98, 0.92), t);
  const zenith = new THREE.Color(0.060, 0.24, 0.70).lerp(new THREE.Color(0.085, 0.11, 0.24), 1 - t);
  const horizon = new THREE.Color(0.52, 0.72, 0.94).lerp(new THREE.Color(0.98, 0.50, 0.24), 1 - t);
  const ground = new THREE.Color(0.14, 0.10, 0.075).lerp(new THREE.Color(0.26, 0.25, 0.23), t);

  const u = terrainUniforms;
  u.uSunDirection.value.copy(dir);
  u.uSunColor.value.copy(sunColor);
  u.uSkyColor.value.copy(zenith);
  u.uGroundColor.value.copy(ground);
  u.uFogColor.value.copy(horizon);

  skyUniforms.uSunDirection.value.copy(dir);
  skyUniforms.uSunColor.value.copy(sunColor);
  skyUniforms.uZenith.value.copy(zenith);
  skyUniforms.uHorizon.value.copy(horizon);
}

function rebaseOrigin(): void {
  const limit = 15000;
  if (Math.abs(flight.x - renderOrigin.x) > limit || Math.abs(flight.z - renderOrigin.y) > limit) {
    snapRenderOrigin();
  }
}

function snapRenderOrigin(): void {
  renderOrigin.set(
    Math.round(flight.x / RENDER_ORIGIN_STEP) * RENDER_ORIGIN_STEP,
    Math.round(flight.z / RENDER_ORIGIN_STEP) * RENDER_ORIGIN_STEP,
  );
}

function instancedAttribute(
  geo: THREE.InstancedBufferGeometry,
  name: string,
): THREE.InstancedBufferAttribute {
  return geo.getAttribute(name) as THREE.InstancedBufferAttribute;
}

function updateCamera(): void {
  flight.applyCamera(camera, renderOrigin);

  // Each level snaps to its own spacing: a ring is rigid between its snaps.
  // Computed in absolute doubles, then expressed in render space.
  snapLevelOrigins(flight.x, flight.z, CONFIG.baseSpacing, CONFIG.levels, levelOrigins);

  if (!terrainMat) return;

  terrainUniforms.uRenderOrigin.value.set(
    wrapPhase(renderOrigin.x, PHASE_WRAP),
    wrapPhase(renderOrigin.y, PHASE_WRAP),
  );

  for (const { geo, levels } of originTargets) {
    const origins = instancedAttribute(geo, 'aOrigin');
    const parents = instancedAttribute(geo, 'aParentOrigin');
    const coarser = instancedAttribute(geo, 'aCoarseOrigin');

    for (let i = 0; i < levels.length; i++) {
      const level = levels[i];
      origins.setXY(
        i,
        levelOrigins[level * 2] - renderOrigin.x,
        levelOrigins[level * 2 + 1] - renderOrigin.y,
      );

      // Rings are clipped to the level inside them. Level 0's parent is the
      // centre block, which shares level 0's origin.
      const parent = Math.max(0, level - 1);
      parents.setXY(
        i,
        levelOrigins[parent * 2] - renderOrigin.x,
        levelOrigins[parent * 2 + 1] - renderOrigin.y,
      );

      // Morph target: the next-coarser level's own lattice.
      const coarseLevel = Math.min(level + 1, CONFIG.levels - 1);
      coarser.setXY(
        i,
        levelOrigins[coarseLevel * 2] - renderOrigin.x,
        levelOrigins[coarseLevel * 2 + 1] - renderOrigin.y,
      );
    }

    origins.needsUpdate = true;
    parents.needsUpdate = true;
    coarser.needsUpdate = true;
  }
}

function resetView(): void {
  flight.reset();
  snapRenderOrigin();
  flight.setAutoCruise(state.autoCruise);
  updateCamera();
  ui.toast('Position reset');
}

function onResize(): void {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  if (terrainMat) terrainUniforms.uPixelScale.value = pixelScale();
}

function animate(): void {
  requestAnimationFrame(animate);

  const now = performance.now();
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;

  flight.update(dt);
  rebaseOrigin();
  updateCamera();
  streamer.update(flight.x, flight.z);
  sky.position.copy(camera.position);

  renderer.render(scene, camera);

  frames++;
  if (now - lastStats > 500) {
    const fps = Math.round((frames * 1000) / (now - lastStats));
    frames = 0;
    lastStats = now;

    const info = renderer.info.render;
    const ts = streamer.getStats();
    const fi = flight.getInfo();
    ui.setStats({
      fps,
      tris: formatCount(info.triangles),
      calls: info.calls,
      alt: `${Math.round(fi.altitude)}m`,
      speed: Math.round(fi.speed),
      tiles: ts.resident,
      queue: ts.queued + ts.inFlight,
      pos: `${(fi.x / 1000).toFixed(1)},${(fi.z / 1000).toFixed(1)}km`,
    });
    ui.setTileStatus(
      `tiles: ${ts.resident} resident · ${ts.generated} generated · ${ts.queued + ts.inFlight} queued`,
    );
  }
}

function setupQA(): void {
  const qa: InfiniteQA = {
    config: CONFIG,
    renderer,
    scene,
    camera,
    flight,
    streamer,
    get state() { return { ...state, renderOrigin: renderOrigin.toArray() }; },
    setPaused: (paused) => flight.setPaused(paused),
    setAutoCruise: (on) => {
      state.autoCruise = on;
      flight.setAutoCruise(on);
      ui.setAutoCruise(on);
    },
    setLodDebug: (on) => {
      state.lodDebug = on;
      terrainUniforms.uDebugLod.value = on ? 1 : 0;
      setCheckbox('lod-debug', on);
    },
    setTileDebug: (on) => {
      terrainUniforms.uDebugTiles.value = on ? 1 : 0;
      setCheckbox('tile-debug', on);
    },
    setWireframe: (on) => {
      state.wireframe = on;
      debugGroup.visible = on;
      setCheckbox('wireframe', on);
    },
    // Hides the sky and clears to magenta: any magenta left *inside* the
    // terrain silhouette is a genuine geometry gap.
    setCrackDebug: (on) => {
      renderer.setClearColor(on ? 0xff00ff : 0x0b0f14, 1);
      sky.visible = !on;
    },
    waitForTiles: () => streamer.waitForDesired(flight.x, flight.z),
    warpTo: async (x, z, y = null) => {
      flight.setPaused(true);
      state.autoCruise = false;
      flight.setAutoCruise(false);
      ui.setAutoCruise(false);
      flight.warpTo(x, z, y);
      snapRenderOrigin();
      updateCamera();
      streamer.update(flight.x, flight.z, { force: true });
      await streamer.waitForDesired(flight.x, flight.z);
    },
    groundHeight: () => flight.groundHeight(),
    // Absolute world position and per-level snapped origins (diagnostics).
    getLevelOrigins: () => ({
      x: flight.x,
      z: flight.z,
      origins: Array.from(levelOrigins),
    }),
  };
  window.__infinite = qa;

  if (new URLSearchParams(location.search).get('debug') === '1') {
    qa.setLodDebug(true);
    qa.setWireframe(true);
  }
}

boot().catch((err: unknown) => {
  console.error(err);
  const status = document.getElementById('loading-status');
  if (status) {
    const message = err instanceof Error ? err.message : String(err);
    status.textContent = `Failed to start: ${message}`;
    status.style.color = '#ff7d7d';
  }
});
