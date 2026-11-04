/**
 * Texture-backed clipmap renderer.
 *
 * The renderer owns the flat clipmap geometry, the two array textures, the
 * terrain material, per-level origins and the debug views. It never generates
 * or loads tiles; a TileCache fills the textures. This is the shared core for
 * the procedural and pre-baked pages.
 */

import * as THREE from 'three';
import { buildCenterInstances, buildRingInstances } from './clipmap.ts';
import { snapLevelOrigins } from './origins.ts';
import {
  terrainVertexShader,
  terrainFragmentShader,
  debugVertexShader,
  debugFragmentShader,
} from './shaders.ts';
import {
  deriveTerrainMetrics,
  assertTextureBudget,
} from './config.ts';
import type { TerrainConfig } from './tile-source.ts';
import type { SunState } from './sun.ts';

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
  uNormalLodBias: THREE.IUniform<number>;
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

interface OriginTarget {
  geo: THREE.InstancedBufferGeometry;
  levels: number[];
}

export interface ClipmapPalette {
  snowStart: number;
  grassStrength: number;
  sandStrength: number;
  specular: number;
}

export interface ClipmapRendererOptions {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  config: TerrainConfig;
  palette?: ClipmapPalette;
}

const wrapPhase = (v: number, m: number): number => ((v % m) + m) % m;

export class ClipmapRenderer {
  readonly config: TerrainConfig;
  readonly metrics: ReturnType<typeof deriveTerrainMetrics>;
  readonly heightType = THREE.HalfFloatType;
  readonly heightTexture: THREE.DataArrayTexture;
  readonly normalTexture: THREE.DataArrayTexture;

  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly terrainUniforms: TerrainUniforms;
  private readonly terrainMat: THREE.ShaderMaterial;
  private readonly debugMat: THREE.ShaderMaterial;
  private readonly centerMesh: THREE.Mesh;
  private readonly innerRingMesh: THREE.Mesh;
  private readonly outerRingMesh: THREE.Mesh;
  private readonly debugGroup: THREE.Group;
  private readonly originTargets: OriginTarget[];
  private readonly levelOrigins: Float64Array;
  private readonly bufferSize = new THREE.Vector2();

  constructor({ renderer, scene, config, palette }: ClipmapRendererOptions) {
    this.renderer = renderer;
    this.scene = scene;
    this.config = config;
    this.metrics = deriveTerrainMetrics(config);
    assertTextureBudget(config, this.metrics);

    this.heightTexture = this.createHeightTexture();
    this.normalTexture = this.createNormalTexture();
    this.levelOrigins = new Float64Array(config.levels * 2);

    this.terrainUniforms = {
      uHeightArray: { value: this.heightTexture },
      uNormalArray: { value: this.normalTexture },
      uHeightScale: { value: config.heightScale },
      uRenderOrigin: { value: new THREE.Vector2(0, 0) },
      uBaseSpacing: { value: config.baseSpacing },
      uTileCells: { value: config.tileSize },
      uNormalTileCells: { value: this.metrics.normalTileSize },
      uCacheTiles: { value: config.cacheTiles },
      uSkirtDepth: { value: config.skirtDepth },
      uLevels: { value: config.levels },
      uCenterCells: { value: config.centerCells },
      uMorphCells: { value: config.morphCells },
      uPixelScale: { value: 0.001 },
      uNormalStrength: { value: 1 },
      // Default to the geometric layer; the DEM scene opts into one finer
      // layer, where its 5x5 cache covers the whole coarse ring.
      uNormalLodBias: { value: 0 },
      uSunDirection: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Color(1, 0.97, 0.9) },
      uSkyColor: { value: new THREE.Color(0.20, 0.42, 0.72) },
      uGroundColor: { value: new THREE.Color(0.24, 0.23, 0.21) },
      uFogColor: { value: new THREE.Color(0.68, 0.78, 0.88) },
      uFogDensity: { value: this.metrics.fogDensity },
      uSnowStart: { value: palette?.snowStart ?? 0.62 },
      uGrassStrength: { value: palette?.grassStrength ?? 0.9 },
      uSandStrength: { value: palette?.sandStrength ?? 0.35 },
      uSpecular: { value: palette?.specular ?? 0.08 },
      uDebugLod: { value: 0 },
      uDebugTiles: { value: 0 },
    };

    this.terrainMat = new THREE.ShaderMaterial({
      vertexShader: terrainVertexShader,
      fragmentShader: terrainFragmentShader,
      uniforms: this.terrainUniforms,
      side: THREE.FrontSide,
    });

    this.debugMat = new THREE.ShaderMaterial({
      vertexShader: debugVertexShader,
      fragmentShader: debugFragmentShader,
      uniforms: this.terrainUniforms,
      wireframe: true,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -2,
    });

    const centerGeo = buildCenterInstances(config.centerCells);
    // Level 0 shares the centre block's lattice and abuts it exactly; every
    // coarser ring is padded by a cell and clipped back to the parent square.
    const innerGeo = buildRingInstances(config.centerCells, [0], {
      hole: config.centerCells,
      trim: 0,
    });
    const outerLevels = Array.from({ length: config.levels - 1 }, (_, i) => i + 1);
    const outerGeo = buildRingInstances(config.centerCells, outerLevels, {
      outerLevel: config.levels - 1,
    });

    this.centerMesh = new THREE.Mesh(centerGeo, this.terrainMat);
    this.innerRingMesh = new THREE.Mesh(innerGeo, this.terrainMat);
    this.outerRingMesh = new THREE.Mesh(outerGeo, this.terrainMat);
    this.centerMesh.name = 'terrain-center';
    this.innerRingMesh.name = 'terrain-ring-0';
    this.outerRingMesh.name = 'terrain-rings';
    for (const m of [this.centerMesh, this.innerRingMesh, this.outerRingMesh]) {
      m.frustumCulled = false;
      this.scene.add(m);
    }

    this.originTargets = [
      { geo: centerGeo, levels: [0] },
      { geo: innerGeo, levels: [0] },
      { geo: outerGeo, levels: outerLevels },
    ];

    this.debugGroup = new THREE.Group();
    this.debugGroup.name = 'debug-group';
    for (const [geo, name] of [[centerGeo, 'center'], [innerGeo, 'ring-0'], [outerGeo, 'rings']] as const) {
      const m = new THREE.Mesh(geo, this.debugMat);
      m.frustumCulled = false;
      m.name = `debug-${name}`;
      this.debugGroup.add(m);
    }
    this.debugGroup.visible = false;
    this.scene.add(this.debugGroup);
  }

  private createHeightTexture(): THREE.DataArrayTexture {
    const { cacheSize } = this.metrics;
    const data = new Uint16Array(cacheSize * cacheSize * this.config.levels);
    const texture = new THREE.DataArrayTexture(
      data,
      cacheSize,
      cacheSize,
      this.config.levels,
    );
    texture.format = THREE.RedFormat;
    texture.type = this.heightType;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.generateMipmaps = false;
    texture.flipY = false;
    texture.unpackAlignment = 1;
    texture.needsUpdate = true;
    this.renderer.initTexture(texture);
    // The CPU-side buffer is only needed for the initial allocation; tiles are
    // uploaded directly with texSubImage3D.
    (texture.image as { data: Uint16Array | null }).data = null;
    return texture;
  }

  private createNormalTexture(): THREE.DataArrayTexture {
    const { normalCacheSize } = this.metrics;
    const data = new Uint8Array(normalCacheSize * normalCacheSize * this.config.levels * 4);
    const texture = new THREE.DataArrayTexture(
      data,
      normalCacheSize,
      normalCacheSize,
      this.config.levels,
    );
    texture.format = THREE.RGBAFormat;
    texture.type = THREE.UnsignedByteType;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    // The normal cache is a toroidal 5x5 atlas. Clamp only the outer atlas
    // edge: internal slot boundaries are adjacent world tiles and should
    // interpolate, but the wrap from slot 4 back to slot 0 is not spatially
    // adjacent and must not blend.
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.generateMipmaps = false;
    texture.flipY = false;
    texture.unpackAlignment = 1;
    texture.anisotropy = Math.min(4, this.renderer.capabilities.getMaxAnisotropy());
    texture.needsUpdate = true;
    this.renderer.initTexture(texture);
    (texture.image as { data: Uint8Array | null }).data = null;
    return texture;
  }

  private pixelScale(camera: THREE.PerspectiveCamera): number {
    this.renderer.getDrawingBufferSize(this.bufferSize);
    return (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2))
      / Math.max(1, this.bufferSize.y);
  }

  /**
   * Updates per-level origins and the terrain uniforms. `absX`/`absZ` are the
   * camera's absolute world position; `renderOrigin` is the floating origin.
   */
  update(
    camera: THREE.PerspectiveCamera,
    absX: number,
    absZ: number,
    renderOrigin: THREE.Vector2,
  ): void {
    snapLevelOrigins(absX, absZ, this.config.baseSpacing, this.config.levels, this.levelOrigins);

    this.terrainUniforms.uRenderOrigin.value.set(
      wrapPhase(renderOrigin.x, this.metrics.phaseWrap),
      wrapPhase(renderOrigin.y, this.metrics.phaseWrap),
    );
    this.terrainUniforms.uPixelScale.value = this.pixelScale(camera);

    for (const { geo, levels } of this.originTargets) {
      const origins = geo.getAttribute('aOrigin') as THREE.InstancedBufferAttribute;
      const parents = geo.getAttribute('aParentOrigin') as THREE.InstancedBufferAttribute;
      const coarser = geo.getAttribute('aCoarseOrigin') as THREE.InstancedBufferAttribute;

      for (let i = 0; i < levels.length; i++) {
        const level = levels[i];
        origins.setXY(
          i,
          this.levelOrigins[level * 2] - renderOrigin.x,
          this.levelOrigins[level * 2 + 1] - renderOrigin.y,
        );

        // Rings are clipped to the level inside them. Level 0's parent is the
        // centre block, which shares level 0's origin.
        const parent = Math.max(0, level - 1);
        parents.setXY(
          i,
          this.levelOrigins[parent * 2] - renderOrigin.x,
          this.levelOrigins[parent * 2 + 1] - renderOrigin.y,
        );

        // Morph target: the next-coarser level's own lattice.
        const coarseLevel = Math.min(level + 1, this.config.levels - 1);
        coarser.setXY(
          i,
          this.levelOrigins[coarseLevel * 2] - renderOrigin.x,
          this.levelOrigins[coarseLevel * 2 + 1] - renderOrigin.y,
        );
      }

      origins.needsUpdate = true;
      parents.needsUpdate = true;
      coarser.needsUpdate = true;
    }
  }

  /** Absolute x/z per level, for diagnostics. */
  getLevelOrigins(): number[] {
    return Array.from(this.levelOrigins);
  }

  setSun(sun: SunState): void {
    this.terrainUniforms.uSunDirection.value.copy(sun.direction);
    this.terrainUniforms.uSunColor.value.copy(sun.sunColor);
    this.terrainUniforms.uSkyColor.value.copy(sun.zenith);
    this.terrainUniforms.uGroundColor.value.copy(sun.ground);
    this.terrainUniforms.uFogColor.value.copy(sun.horizon);
  }

  setNormalStrength(strength: number): void {
    this.terrainUniforms.uNormalStrength.value = strength;
  }

  /** Negative normal LOD bias; 1 samples the next-finer normal layer. */
  setNormalLodBias(bias: number): void {
    this.terrainUniforms.uNormalLodBias.value = Math.max(0, Math.min(3, bias));
  }

  setFogDensity(density: number): void {
    this.terrainUniforms.uFogDensity.value = density;
  }

  setPalette(palette: Partial<ClipmapPalette>): void {
    if (palette.snowStart !== undefined) this.terrainUniforms.uSnowStart.value = palette.snowStart;
    if (palette.grassStrength !== undefined) this.terrainUniforms.uGrassStrength.value = palette.grassStrength;
    if (palette.sandStrength !== undefined) this.terrainUniforms.uSandStrength.value = palette.sandStrength;
    if (palette.specular !== undefined) this.terrainUniforms.uSpecular.value = palette.specular;
  }

  setLodDebug(on: boolean): void {
    this.terrainUniforms.uDebugLod.value = on ? 1 : 0;
  }

  setTileDebug(on: boolean): void {
    this.terrainUniforms.uDebugTiles.value = on ? 1 : 0;
  }

  setWireframe(on: boolean): void {
    this.debugGroup.visible = on;
  }

  dispose(): void {
    for (const m of [this.centerMesh, this.innerRingMesh, this.outerRingMesh]) {
      this.scene.remove(m);
      m.geometry.dispose();
    }
    this.scene.remove(this.debugGroup);
    this.terrainMat.dispose();
    this.debugMat.dispose();
    this.heightTexture.dispose();
    this.normalTexture.dispose();
  }
}
