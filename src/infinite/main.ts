/**
 * Infinite Terrain — procedural page orchestration.
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
 * subtracted before touching the GPU. The renderer and cache are shared with
 * the pre-baked DEM page.
 */

import * as THREE from 'three';
import { DEFAULT_SEED, DEFAULT_HEIGHT_SCALE } from './heightfield.ts';
import { ProceduralTileSource } from './procedural-source.ts';
import { TileCache } from '../terrain/tile-cache.ts';
import { ClipmapRenderer } from '../terrain/renderer.ts';
import { deriveTerrainMetrics } from '../terrain/config.ts';
import { computeSun } from '../terrain/sun.ts';
import { skyVertexShader, skyFragmentShader } from '../sky-shaders.ts';
import { FlightController } from './flight.ts';
import { initUI } from '../terrain/ui.ts';
import type { UIApi } from '../terrain/ui.ts';

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

const METRICS = deriveTerrainMetrics(CONFIG);

interface AppState {
  sunAz: number;
  sunEl: number;
  normalStrength: number;
  wireframe: boolean;
  lodDebug: boolean;
  autoCruise: boolean;
}

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
  streamer: TileCache;
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

let renderer!: THREE.WebGLRenderer;
let scene!: THREE.Scene;
let camera!: THREE.PerspectiveCamera;
let sky!: THREE.Mesh;
let skyMat!: THREE.ShaderMaterial;
let terrainRenderer!: ClipmapRenderer;
let flight!: FlightController;
let streamer!: TileCache;
let ui!: UIApi;
let skyUniforms!: SkyUniforms;

let lastFrame = performance.now();
let frames = 0;
let lastStats = performance.now();

const nextFrame = (): Promise<void> => new Promise((resolve) => {
  requestAnimationFrame(() => { setTimeout(resolve, 0); });
});
const formatCount = (n: number): string =>
  (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

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
      terrainRenderer?.setNormalStrength(s);
    },
    onWireframe: (on) => { state.wireframe = on; terrainRenderer?.setWireframe(on); },
    onLodDebug: (on) => {
      state.lodDebug = on;
      terrainRenderer?.setLodDebug(on);
    },
    onTileDebug: (on) => {
      terrainRenderer?.setTileDebug(on);
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

  ui.setLoading(0.06, 'Building clipmap…');
  await nextFrame();
  terrainRenderer = new ClipmapRenderer({ renderer, scene, config: CONFIG });
  terrainRenderer.setNormalStrength(state.normalStrength);

  const source = new ProceduralTileSource({ seed: CONFIG.seed, config: CONFIG });
  flight = new FlightController({
    camera,
    canvas: renderer.domElement,
    heightAt: (x, z) => source.heightAt(x, z),
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

  ui.setLoading(0.10, 'Starting terrain worker…');
  streamer = new TileCache({
    renderer,
    source,
    config: CONFIG,
    heightTexture: terrainRenderer.heightTexture,
    normalTexture: terrainRenderer.normalTexture,
    heightType: terrainRenderer.heightType,
    onProgress: (ratio, p) => {
      ui.setLoading(0.12 + ratio * 0.72, `Generating terrain tiles… ${p.done}/${p.total}`);
    },
    onError: (error, job) => {
      console.error(`terrain tile ${job.key} failed:`, error);
      ui.setTileStatus(`tile error: ${job.key}`);
    },
  });

  ui.setLoading(0.12, 'Generating terrain tiles…');
  await streamer.prime(flight.x, flight.z);

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
  camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 2, METRICS.outerExtent * 1.5);
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
  sky.scale.setScalar(METRICS.outerExtent * 1.3);
  sky.frustumCulled = false;
  scene.add(sky);

  window.addEventListener('resize', onResize);
}

function updateSun(): void {
  if (!terrainRenderer || !skyMat) return;
  const sun = computeSun(state.sunAz, state.sunEl);
  terrainRenderer.setSun(sun);

  skyUniforms.uSunDirection.value.copy(sun.direction);
  skyUniforms.uSunColor.value.copy(sun.sunColor);
  skyUniforms.uZenith.value.copy(sun.zenith);
  skyUniforms.uHorizon.value.copy(sun.horizon);
}

function rebaseOrigin(): void {
  const limit = 15000;
  if (Math.abs(flight.x - renderOrigin.x) > limit || Math.abs(flight.z - renderOrigin.y) > limit) {
    snapRenderOrigin();
  }
}

function snapRenderOrigin(): void {
  renderOrigin.set(
    Math.round(flight.x / METRICS.renderOriginStep) * METRICS.renderOriginStep,
    Math.round(flight.z / METRICS.renderOriginStep) * METRICS.renderOriginStep,
  );
}

function updateCamera(): void {
  flight.applyCamera(camera, renderOrigin);
  terrainRenderer.update(camera, flight.x, flight.z, renderOrigin);
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
      terrainRenderer.setLodDebug(on);
      setCheckbox('lod-debug', on);
    },
    setTileDebug: (on) => {
      terrainRenderer.setTileDebug(on);
      setCheckbox('tile-debug', on);
    },
    setWireframe: (on) => {
      state.wireframe = on;
      terrainRenderer.setWireframe(on);
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
      origins: terrainRenderer.getLevelOrigins(),
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
