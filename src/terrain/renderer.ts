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
import { detailUvOffset } from './detail.ts';
import type { MaterialLibrary } from './materials.ts';
import type { MaterialStack } from './material-stack.ts';
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
  uDetailNormal: THREE.IUniform<THREE.Texture>;
  uDetailStrength: THREE.IUniform<number>;
  uDetailUvOffset: THREE.IUniform<THREE.Vector2>;
  uDetailTileSize: THREE.IUniform<number>;
  uDetailFadeStart: THREE.IUniform<number>;
  uDetailFadeEnd: THREE.IUniform<number>;
  uMaterialCount: THREE.IUniform<number>;
  uMaterialAlbedo: THREE.IUniform<THREE.DataArrayTexture>;
  uMaterialSlope: THREE.IUniform<THREE.DataArrayTexture>;
  uMaterialStackIds: THREE.IUniform<THREE.Texture>;
  uMaterialStackWeights: THREE.IUniform<THREE.Texture>;
  uMacroAlbedo: THREE.IUniform<THREE.Texture>;
  uStackExtent: THREE.IUniform<number>;
  uStackUvOffset: THREE.IUniform<THREE.Vector2>;
  uMaterialParamsA: THREE.IUniform<THREE.Vector4[]>;
  uMaterialParamsB: THREE.IUniform<THREE.Vector4[]>;
  uMaterialUvOffset: THREE.IUniform<THREE.Vector2[]>;
  uMaterialNormalScale: THREE.IUniform<number>;
  uMaterialHeightBlend: THREE.IUniform<number>;
  uMaterialFadeStart: THREE.IUniform<number>;
  uMaterialFadeEnd: THREE.IUniform<number>;
  uMaterialMode: THREE.IUniform<number>;
  uMaterialAoStrength: THREE.IUniform<number>;
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

export interface DetailMaterialOptions {
  /** URL of the repeating object-space normal tile. */
  textureUrl: string;
  /** World size of one tile, metres. */
  tileWorldSize: number;
  /** Slope multiplier; 0 disables the layer. */
  strength?: number;
  /** Camera distance where the detail starts fading, metres. */
  fadeStart?: number;
  /** Camera distance where the detail is fully faded, metres. */
  fadeEnd?: number;
  /** Called when the tile cannot be loaded; the layer stays disabled. */
  onError?: (message: string) => void;
}

export type MaterialMode = 'off' | 'on' | 'debug';

export interface MaterialRenderOptions {
  library: MaterialLibrary;
  stack: MaterialStack;
  /** Camera distance where material textures start fading, metres. */
  fadeStart?: number;
  /** Camera distance where the far-field macro albedo takes over, metres. */
  fadeEnd?: number;
  /** Global height-blend bias, 0..1. */
  heightBlend?: number;
  /** Global multiplier on material normal slope. */
  normalScale?: number;
  /** How strongly the packed AO darkens albedo, 0..1. */
  aoStrength?: number;
}

export interface MaterialStats {
  libraryCount: number;
  packSize: number;
  stackSize: number;
  stackExtent: number;
  macroSize: number;
  textureUnits: number;
  maxTextureUnits: number;
  approxTextureMiB: number;
  mode: MaterialMode;
  fadeStart: number;
  fadeEnd: number;
  heightBlend: number;
  normalScale: number;
}

export interface ClipmapRendererOptions {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  config: TerrainConfig;
  palette?: ClipmapPalette;
  detail?: DetailMaterialOptions;
  materials?: MaterialRenderOptions;
}

const wrapPhase = (v: number, m: number): number => ((v % m) + m) % m;
const materialModeValue = (mode: MaterialMode): number => (
  mode === 'on' ? 1 : mode === 'debug' ? 2 : 0
);

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
  private readonly detailPlaceholder: THREE.Texture;
  private readonly detailTileWorldSize: number;
  private detailTexture: THREE.Texture | null = null;
  private detailDisposed = false;
  private readonly materialLibrary: MaterialLibrary | null;
  private readonly materialStack: MaterialStack | null;
  private readonly materialAlbedoPlaceholder: THREE.DataArrayTexture;
  private readonly materialSlopePlaceholder: THREE.DataArrayTexture;
  private readonly stackIdsPlaceholder: THREE.DataTexture;
  private readonly stackWeightsPlaceholder: THREE.DataTexture;
  private readonly macroPlaceholder: THREE.DataTexture;
  private readonly materialParamsA: THREE.Vector4[];
  private readonly materialParamsB: THREE.Vector4[];
  private readonly materialUvOffset: THREE.Vector2[];
  private materialMode: MaterialMode;

  constructor({ renderer, scene, config, palette, detail, materials }: ClipmapRendererOptions) {
    this.renderer = renderer;
    this.scene = scene;
    this.config = config;
    this.metrics = deriveTerrainMetrics(config);
    assertTextureBudget(config, this.metrics);

    this.heightTexture = this.createHeightTexture();
    this.normalTexture = this.createNormalTexture();
    this.levelOrigins = new Float64Array(config.levels * 2);
    this.detailPlaceholder = this.createDetailPlaceholder();
    this.detailTileWorldSize = Math.max(1e-3, detail?.tileWorldSize ?? 16);
    const detailFadeStart = detail?.fadeStart ?? 0;
    const detailFadeEnd = Math.max(detailFadeStart + 1, detail?.fadeEnd ?? 1);

    const textureUnits = 8;
    if (textureUnits > renderer.capabilities.maxTextures) {
      throw new Error(
        `material shader uses ${textureUnits} texture units, device exposes ${renderer.capabilities.maxTextures}`,
      );
    }
    this.materialLibrary = materials?.library ?? null;
    this.materialStack = materials?.stack ?? null;
    if (this.materialLibrary && this.materialLibrary.count > 24) {
      throw new Error(`material library has ${this.materialLibrary.count} layers, cap is 24`);
    }
    if (this.materialStack && (this.materialStack.size > 4096 || this.materialStack.macroSize > 4096)) {
      throw new Error('material stack exceeds the 4096 texel budget');
    }
    this.materialMode = this.materialLibrary ? 'on' : 'off';
    this.materialAlbedoPlaceholder = this.createMaterialAlbedoPlaceholder();
    this.materialSlopePlaceholder = this.createMaterialSlopePlaceholder();
    this.stackIdsPlaceholder = this.createStackIdsPlaceholder();
    this.stackWeightsPlaceholder = this.createStackWeightsPlaceholder();
    this.macroPlaceholder = this.createMacroPlaceholder();
    const materialFadeStart = materials?.fadeStart ?? 0;
    const materialFadeEnd = Math.max(materialFadeStart + 1, materials?.fadeEnd ?? 1);
    const materialHeightBlend = Math.max(0, Math.min(1, materials?.heightBlend ?? 0.25));
    const materialNormalScale = Math.max(0, Math.min(2, materials?.normalScale ?? 1));
    const materialAoStrength = Math.max(0, Math.min(1, materials?.aoStrength ?? 0.7));
    const entries = this.materialLibrary?.entries ?? [];
    this.materialParamsA = Array.from({ length: 24 }, (_, i) => {
      const entry = entries[i];
      return entry
        ? new THREE.Vector4(entry.tileMeters, entry.slopeScale, entry.normalStrength, entry.roughness)
        : new THREE.Vector4(1, 1, 0, 1);
    });
    this.materialParamsB = Array.from({ length: 24 }, (_, i) => {
      const entry = entries[i];
      return entry
        ? new THREE.Vector4(entry.specular, entry.projection === 'triplanar' ? 1 : 0, 1, 0)
        : new THREE.Vector4(0, 0, 1, 0);
    });
    this.materialUvOffset = Array.from({ length: 24 }, () => new THREE.Vector2(0, 0));

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
      uDetailNormal: { value: this.detailPlaceholder },
      uDetailStrength: { value: Math.max(0, Math.min(2, detail?.strength ?? 0)) },
      uDetailUvOffset: { value: new THREE.Vector2(0, 0) },
      uDetailTileSize: { value: this.detailTileWorldSize },
      uDetailFadeStart: { value: detailFadeStart },
      uDetailFadeEnd: { value: detailFadeEnd },
      uMaterialCount: { value: this.materialLibrary?.count ?? 0 },
      uMaterialAlbedo: { value: this.materialLibrary?.albedoHeight ?? this.materialAlbedoPlaceholder },
      uMaterialSlope: { value: this.materialLibrary?.slopeRough ?? this.materialSlopePlaceholder },
      uMaterialStackIds: { value: this.materialStack?.ids ?? this.stackIdsPlaceholder },
      uMaterialStackWeights: { value: this.materialStack?.weights ?? this.stackWeightsPlaceholder },
      uMacroAlbedo: { value: this.materialStack?.macro ?? this.macroPlaceholder },
      uStackExtent: { value: this.materialStack?.extent ?? 1 },
      uStackUvOffset: { value: new THREE.Vector2(0, 0) },
      uMaterialParamsA: { value: this.materialParamsA },
      uMaterialParamsB: { value: this.materialParamsB },
      uMaterialUvOffset: { value: this.materialUvOffset },
      uMaterialNormalScale: { value: materialNormalScale },
      uMaterialHeightBlend: { value: materialHeightBlend },
      uMaterialFadeStart: { value: materialFadeStart },
      uMaterialFadeEnd: { value: materialFadeEnd },
      uMaterialMode: { value: materialModeValue(this.materialMode) },
      uMaterialAoStrength: { value: materialAoStrength },
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

    if (detail) this.loadDetailTexture(detail);

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

  private createDetailPlaceholder(): THREE.Texture {
    const texture = new THREE.DataTexture(
      new Uint8Array([128, 128, 255, 255]),
      1,
      1,
      THREE.RGBAFormat,
    );
    texture.minFilter = THREE.NearestFilter;
    texture.magFilter = THREE.NearestFilter;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.generateMipmaps = false;
    texture.flipY = false;
    texture.colorSpace = THREE.NoColorSpace;
    texture.needsUpdate = true;
    return texture;
  }

  private createMaterialAlbedoPlaceholder(): THREE.DataArrayTexture {
    const texture = new THREE.DataArrayTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, 1);
    texture.format = THREE.RGBAFormat;
    texture.type = THREE.UnsignedByteType;
    texture.colorSpace = THREE.NoColorSpace;
    texture.minFilter = THREE.NearestFilter;
    texture.magFilter = THREE.NearestFilter;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.generateMipmaps = false;
    texture.flipY = false;
    texture.needsUpdate = true;
    return texture;
  }

  private createMaterialSlopePlaceholder(): THREE.DataArrayTexture {
    const texture = new THREE.DataArrayTexture(new Uint8Array([128, 128, 255, 255]), 1, 1, 1);
    texture.format = THREE.RGBAFormat;
    texture.type = THREE.UnsignedByteType;
    texture.colorSpace = THREE.NoColorSpace;
    texture.minFilter = THREE.NearestFilter;
    texture.magFilter = THREE.NearestFilter;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.generateMipmaps = false;
    texture.flipY = false;
    texture.needsUpdate = true;
    return texture;
  }

  private createStackIdsPlaceholder(): THREE.DataTexture {
    const texture = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1, THREE.RGBAFormat);
    texture.colorSpace = THREE.NoColorSpace;
    texture.minFilter = THREE.NearestFilter;
    texture.magFilter = THREE.NearestFilter;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.generateMipmaps = false;
    texture.flipY = false;
    texture.needsUpdate = true;
    return texture;
  }

  private createStackWeightsPlaceholder(): THREE.DataTexture {
    const texture = new THREE.DataTexture(new Uint8Array([255, 0, 0, 0]), 1, 1, THREE.RGBAFormat);
    texture.colorSpace = THREE.NoColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.generateMipmaps = false;
    texture.flipY = false;
    texture.needsUpdate = true;
    return texture;
  }

  private createMacroPlaceholder(): THREE.DataTexture {
    const texture = new THREE.DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1, THREE.RGBAFormat);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.generateMipmaps = false;
    texture.flipY = false;
    texture.needsUpdate = true;
    return texture;
  }

  private loadDetailTexture(detail: DetailMaterialOptions): void {
    new THREE.TextureLoader().load(
      detail.textureUrl,
      (texture) => {
        if (this.detailDisposed) {
          texture.dispose();
          return;
        }
        texture.wrapS = THREE.RepeatWrapping;
        texture.wrapT = THREE.RepeatWrapping;
        texture.magFilter = THREE.LinearFilter;
        texture.minFilter = THREE.LinearMipmapLinearFilter;
        texture.generateMipmaps = true;
        texture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
        texture.colorSpace = THREE.NoColorSpace;
        texture.flipY = false;
        texture.needsUpdate = true;
        this.detailTexture = texture;
        this.terrainUniforms.uDetailNormal.value = texture;
      },
      undefined,
      (error: unknown) => {
        const message = `detail normal texture failed to load: ${detail.textureUrl}`;
        console.error(message, error);
        this.terrainUniforms.uDetailStrength.value = 0;
        detail.onError?.(message);
      },
    );
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
    const detailOffset = detailUvOffset(renderOrigin.x, renderOrigin.y, this.detailTileWorldSize);
    this.terrainUniforms.uDetailUvOffset.value.set(detailOffset.x, detailOffset.y);
    if (this.materialStack) {
      const offset = this.materialStack.uvOffset(renderOrigin.x, renderOrigin.y);
      this.terrainUniforms.uStackUvOffset.value.set(offset.x, offset.y);
    }
    if (this.materialLibrary) {
      for (let i = 0; i < this.materialLibrary.count; i++) {
        const entry = this.materialLibrary.entries[i];
        this.materialUvOffset[i]?.set(
          wrapPhase(renderOrigin.x, entry.tileMeters),
          wrapPhase(renderOrigin.y, entry.tileMeters),
        );
      }
    }
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

  setDetailStrength(strength: number): void {
    this.terrainUniforms.uDetailStrength.value = Math.max(0, Math.min(2, strength));
  }

  setMaterialMode(mode: MaterialMode): void {
    this.materialMode = this.materialLibrary ? mode : 'off';
    this.terrainUniforms.uMaterialMode.value = materialModeValue(this.materialMode);
  }

  getMaterialMode(): MaterialMode {
    return this.materialMode;
  }

  setHeightBlend(value: number): void {
    this.terrainUniforms.uMaterialHeightBlend.value = Math.max(0, Math.min(1, value));
  }

  setMaterialNormalStrength(value: number): void {
    this.terrainUniforms.uMaterialNormalScale.value = Math.max(0, Math.min(2, value));
  }

  getMaterialStats(): MaterialStats {
    const library = this.materialLibrary;
    const stack = this.materialStack;
    const packSize = library?.manifest.packSize ?? 0;
    const count = library?.count ?? 0;
    const bytesPerLayer = packSize * packSize * 4;
    const arrayMiB = count * bytesPerLayer * 2 * (4 / 3) / (1024 * 1024);
    const stackMiB = stack
      ? (
        stack.size * stack.size * 4 * 2
        + stack.macroSize * stack.macroSize * 4 * (4 / 3)
      ) / (1024 * 1024)
      : 0;
    return {
      libraryCount: count,
      packSize,
      stackSize: stack?.size ?? 0,
      stackExtent: stack?.extent ?? 0,
      macroSize: stack?.macroSize ?? 0,
      textureUnits: 8,
      maxTextureUnits: this.renderer.capabilities.maxTextures,
      approxTextureMiB: arrayMiB + stackMiB,
      mode: this.materialMode,
      fadeStart: this.terrainUniforms.uMaterialFadeStart.value,
      fadeEnd: this.terrainUniforms.uMaterialFadeEnd.value,
      heightBlend: this.terrainUniforms.uMaterialHeightBlend.value,
      normalScale: this.terrainUniforms.uMaterialNormalScale.value,
    };
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
    this.detailDisposed = true;
    this.detailPlaceholder.dispose();
    this.detailTexture?.dispose();
    this.materialAlbedoPlaceholder.dispose();
    this.materialSlopePlaceholder.dispose();
    this.stackIdsPlaceholder.dispose();
    this.stackWeightsPlaceholder.dispose();
    this.macroPlaceholder.dispose();
    this.materialLibrary?.dispose();
    this.materialStack?.dispose();
  }
}
