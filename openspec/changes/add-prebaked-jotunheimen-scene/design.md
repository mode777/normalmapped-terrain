# Design

## Context

See `proposal.md` for motivation. The relevant current state:

- The shaders are already texture-driven: heights are sampled in the vertex shader and normals in the fragment shader. There is no procedural code in GLSL.
- `src/infinite/main.ts` currently owns the renderer, textures, tile streamer, flight, UI, and render loop.
- `src/infinite/tiles.ts` owns both the procedural worker pool and the GPU tile cache. `src/infinite/heightfield.ts` and `src/terrain-compose.ts` are pure CPU generation.
- The render invariants in `AGENTS.md` are non-negotiable: toroidal slots, per-LOD snapping, the 64² height / `64 × normalScale`² normal split, object-space normals, `texSubImage3D` uploads, and the floating-origin phase.
- The container has no GDAL. The bake tool is validated around Node `geotiff`, `proj4`, and the existing `pngjs`.
- The Kartverket WCS accepted a 2000² 10 m request in ~3 s but timed out at 3000², so source reads must be chunked.
- The selected dataset (option A) is 30.72 km × 30.72 km at 10 m, six LODs, 2× normals, centered on Jotunheimen. The source elevations span roughly 480–2469 m.

## Goals / Non-Goals

**Goals:**

- Make the renderer consume a `TileSource` so procedural and pre-baked terrain share geometry, shaders, cache, and LOD behavior.
- Keep `infinite.html` visually and behaviorally unchanged.
- Produce a reproducible, checked-in Jotunheimen dataset with seam-free normals and a self-describing manifest.
- Add a `dem.html` scene with free-fly movement and an optional orbit, finite-world edge handling, attribution, and visual QA.
- Keep the bake tool dependency-light and runnable without system raster tooling.

**Non-Goals:**

- Runtime streaming from an external DEM service. The checked-in tiles are the runtime asset.
- Water rendering, georeferencing UI, scale bars, or coordinate readouts.
- A second DEM dataset or a generic multi-provider catalogue. The bake tool may grow adapters, but this change ships one.
- Changing the procedural page's terrain constants, visual character, or QA hooks.
- Re-baking in CI. The bake tool is a manual, documented command; CI validates the checked-in result.

## Decisions

### 1. One change, implemented in ordered phases

The refactor and the DEM scene are kept in one change because the scene is the proof that the abstraction works. The tasks are ordered so the procedural page is refactored and verified first, then the bake tool and dataset, then the new page. Alternative: two independent changes. That would make review smaller, but it creates a temporary abstraction with no second consumer and a second planning round. The design records the phase boundary so apply can stop and verify after the refactor.

### 2. New `dem.html` page, shared renderer core

The DEM scene uses a separate page rather than a runtime dataset switch on `infinite.html`.

- The infinite scene is tuned for 2 m spacing, 10 LODs, 8× normals, and a ~160 MiB normal cache.
- The DEM scene uses 10 m spacing, 6 LODs, 2× normals, and a much smaller cache.
- The infinite camera wanders over an unbounded world; the DEM camera free-flies over a finite dataset, with source edge clamping and fog hiding the boundary.

A runtime switch would require rebuilding textures, geometry, uniforms, and camera behavior. A second page demonstrates the shared core more cleanly. Alternative: a `?dataset=` parameter that rebuilds the scene. Rejected for the same reasons; it would also complicate the procedural page's QA.

### 3. Shared module boundaries

The target dependency direction is:

```
src/terrain/  (renderer, cache, shaders, clipmap, origins, normals, UI)
      ^                         ^
      |                         |
src/infinite/ (procedural)   src/dem/ (pre-baked)
```

Proposed layout:

| Module | Responsibility |
|---|---|
| `src/terrain/tile-source.ts` | `TerrainConfig`, `GeneratedTile`, `TileSource` contract |
| `src/terrain/config.ts` | Derived metrics: `outerExtent`, cache sizes, `phaseWrap`, `renderOriginStep` |
| `src/terrain/normals.ts` | Pure float-height Sobel bake, moved from `heightfield.ts` |
| `src/terrain/tile-cache.ts` | Desired window, priority queue, slot bookkeeping, texture uploads |
| `src/terrain/clipmap.ts` | Geometry builders, moved from `src/infinite/clipmap.ts` |
| `src/terrain/origins.ts` | Per-level snapping, moved from `src/infinite/origins.ts` |
| `src/terrain/shaders.ts` | Terrain/debug shaders, moved from `src/infinite/shaders.ts` |
| `src/terrain/renderer.ts` | `ClipmapRenderer`: textures, material, meshes, uniforms, debug, per-frame origins |
| `src/terrain/ui.ts` | Generic DOM control wiring, moved from `src/infinite/ui.ts` |
| `src/infinite/procedural-source.ts` | Worker-pool `TileSource` around `generateTile` |
| `src/infinite/heightfield.ts` | Procedural height function and tile generation |
| `src/infinite/terrain-worker.ts` / `worker-protocol.ts` | Procedural worker and typed messages |
| `src/infinite/main.ts` | Procedural page orchestration |
| `src/dem/prebaked-source.ts` | Manifest/tile `TileSource` and coarse `heightAt` |
| `src/dem/main.ts` | DEM page orchestration |

The renderer creates the two array textures from `TerrainConfig`; the cache uploads into them. The renderer does not know about workers, fetches, or manifests. The cache does not know how tiles are produced. The source does not know about Three.js textures or geometry.

Alternative: keep everything in `src/infinite/` and import sideways from the DEM page. Rejected because it hides the dependency direction and makes the refactor look optional.

### 4. `TileSource` contract and async cache

```ts
interface GeneratedTile {
  heights: Float32Array;  // tileSize^2, normalized [0,1]
  normals: Uint8Array;    // (tileSize*normalScale)^2 * 4, RGBA8 object-space
}

interface TileSource {
  readonly kind: 'procedural' | 'prebaked';
  init(): Promise<void>;
  getTile(level: number, tx: number, ty: number): Promise<GeneratedTile>;
  heightAt?(x: number, z: number): number;
  dispose(): void;
}
```

`TileCache` owns the desired `cacheTiles × cacheTiles` window (4×4 for the procedural page, 5×5 for the DEM page), priority sort, stale-request cancellation, slot state, upload errors, `prime()`, and `waitForDesired()`. It allows a small fixed number of in-flight source promises (4 is a reasonable default; the procedural source internally limits itself to its two workers). A stale result is discarded without upload; a failed result is reported once and recorded so it is not retried in a tight loop.

The procedural source moves the current worker-pool logic out of `TileStreamer`. The worker protocol is simplified: `init` carries the seed plus the `TerrainConfig` generation fields; tile requests carry only `id`, `level`, `tx`, `ty`. The worker keeps its height field and config for its lifetime. This removes the current per-tile repetition of `tileSize`, `baseSpacing`, `heightScale`, and `normalScale`.

The pre-baked source fetches the manifest and validates its `baseSpacing`, `tileSize`, `normalScale`, `levels`, and height encoding against `TerrainConfig`. Tile URLs are derived from the manifest. It fetches a `.bin` height tile and a `.png` normal tile, decodes the PNG through `createImageBitmap` and an offscreen canvas (with an `<canvas>` fallback), and returns the typed arrays. Network/decode failures reject the promise; the cache surfaces them through an `onError` callback and the page's loading/status UI.

Alternative: keep the worker protocol and add a separate pre-baked streamer. Rejected: that duplicates the toroidal cache and upload path, which is exactly what this change is meant to share.

### 5. Renderer extraction

`ClipmapRenderer` is constructed with `{ renderer, scene, config, heightType }`. It:

- creates the height and normal `DataArrayTexture`s and checks the 2048-texel limit;
- builds the centre block, level-0 ring, outer rings, and debug group;
- owns the terrain material, uniforms, instanced origin attributes, and `update(cameraX, cameraZ, renderOrigin)` logic;
- exposes the two textures for the cache, plus sun/normal-strength/debug setters and `dispose()`.

The app still owns the sky, camera, flight, UI, loading overlay, and animation loop. The floating origin stays in the app because it is tied to flight; the renderer receives the absolute origin and wraps it modulo `phaseWrap`.

Derived metrics move to `src/terrain/config.ts` so `outerExtent`, `phaseWrap`, and `renderOriginStep` are computed once and used by both the renderer and the app.

### 6. Bake pipeline

The bake tool is a manual Node/TypeScript command:

```bash
npm run bake:dem -- --config tools/dem/jotunheimen.json
```

Dependencies: `geotiff`, `proj4`, `pngjs` (already present). No GDAL.

Pipeline:

```
Kartverket WCS (EPSG:25833)
  -> 1536^2 GetCoverage chunks, retried
  -> float32 mosaic at 10 m
  -> local grid, center at (0,0), +x east, +z south
  -> normalize h = elevation / 2500
  -> per-LOD height tiles (64^2 uint16)
  -> per-tile normal halo (128+2)^2 at 5 m -> Sobel -> RGBA8 PNG
  -> coarse-height.bin + manifest + seam report + preview
```

**Local frame.** Row 0 is north. `x = -size/2 + i * spacing`; `z = -size/2 + j * spacing`. This makes `+z` south, matching the renderer's row convention and the sun azimuth convention (0° = north, 90° = east, 180° = south, 270° = west). It also keeps the camera's centre at local `(0,0)`, so `FlightController.reset()` needs no special origin.

**LOD sampling.** All LODs come from the one 10 m normalized grid. LOD `L` uses spacing `10 · 2^L`, so its samples are exact grid samples. This guarantees that the clipmap morph band blends matching surfaces. Partial edge tiles at coarse levels are included in the manifest ranges; samples outside the dataset are clamped to the edge.

**Normals.** For each tile at LOD `L`, sample a `(64·normalScale + 2)²` halo at `normalSpacing = S_L / normalScale` from the same global grid using bilinear interpolation. Call the shared `bakeTileNormals(halo, normalTileSize, normalSpacing, heightScale)`. The halo means the normals adjacent to a tile boundary are computed from the same world samples as the neighbour, so the normal field is continuous after RGB8 quantization. The bake tool compares boundary-adjacent normals against a reference recomputation from the global grid and writes a seam report; `test:dem` verifies the report and can rebake a deterministic sample of boundary tiles.

**Normal LOD bias.** The fragment shader samples normal layer `max(vLevel - uNormalLodBias, 0)`; the DEM page sets the bias to 1, so distant rings use the next-finer normal layer that is already resident in the symmetric 5×5 cache. The procedural page keeps 0. The boundary cross-fade target is `nLevel + 1` for `vLevel > 0`, matching the child ring's biased layer; level 0 has no finer layer and does not cross-fade. This is the tile-atlas-safe equivalent of a negative mipmap LOD bias: actual mipmaps would bleed across the packed tile slots and require a full-layer regenerate after every `texSubImage3D`.

**Heights.** Height tiles store `uint16 = round(normalizedHeight * 65535)`. The runtime converts to `Float32Array` and the cache converts to the renderer's `R16F` upload. The source's minimum is ~0.19 after normalization, which is fine for the existing material bands.

**Coarse height.** A 1024² uint16 grid at ~30 m spacing is checked in with the dataset. `PrebakedTileSource.heightAt` bilinearly samples it, applies a 3×3 max filter to avoid missing peaks, and adds a small safety margin. This keeps the flight guard independent of GPU readback and costs ~2 MB.

**Manifest.** The manifest records the source, license, attribution, CRS, local frame, bounds, config, height range, per-LOD tile ranges, encodings, coarse height metadata, bake version, and generated timestamp. Tile paths are derived from `level`, `tx`, `ty`; no per-file list is required. The manifest is the single source of truth for the runtime source and the validator.

**Measured dataset.** 3,080 tiles across six LODs; ~24.2 MB of height `.bin`, ~74.3 MB of normal PNG (2× RGBA8 normal tiles are ~24 KB each), ~2 MB coarse height, plus manifest/preview. Total ~101 MB. The source GeoTIFFs (~38 MB for the 2×2 WCS requests) stay in a gitignored cache.

Alternative: store normals as raw RGBA `.bin`. Rejected because the PNGs compress to roughly a tenth of raw size on this smooth 10 m terrain. Alternative: store 16-bit heights as PNG. Rejected because browser canvas decoding is not reliably 16-bit; raw little-endian uint16 is simple and exact.

### 7. Finite-world edge policy

The dataset radius is 15.36 km, exactly the outer radius of the six-level clipmap. The camera is free to fly beyond the dataset; the pre-baked source clamps out-of-range `(tx, ty)` to the nearest available tile. Fog and the last-ring skirt hide the repeated edge, and the crack test runs from a viewpoint beyond the boundary to ensure no missing-texture holes appear.

Alternative: add a generated clamped border ring around the dataset. Rejected for the first version because it increases the checked-in size and hides the same problem that the camera bound and fog already cover. The source clamp is the runtime equivalent.

### 8. Camera and flight

`FlightController` gains optional, backward-compatible settings:

- `cruiseMode: 'wander' | 'orbit'`: the DEM page uses `orbit`; the procedural page keeps `wander`.
- `orbitRadius`: radius for the optional auto-cruise orbit.
- `defaultView`: initial `x`, `z`, `yaw`, `pitch`, and optional altitude. The DEM page uses a scenic start east of the massif looking inward; the procedural default is unchanged.

The orbit path runs at a 2.5 km radius, looking slightly inward and down. The terrain guard uses the source's `heightAt`; the camera remains above the coarse surface plus the existing clearance. Free flight is not clamped to a dataset boundary; the user can fly past the edge, where the source repeats the nearest edge tiles under the fog.

### 9. Verification

- `npm run test:infinite` continues to cover the procedural tile math.
- New `npm run test:dem` validates the checked-in manifest and all tile files: presence, dimensions, encodings, height range, tile ranges, coarse height, and the seam report. It also reconstructs the height grid to check for gaps/overlaps and performs a deterministic boundary rebake sample.
- New `tools/screenshot-dem.ts` and `tools/analyze-dem.ts` mirror the infinite QA: boot, default, flat normal, cruise/orbit, LOD debug, wireframe, tile grid, crack test, and a boundary viewpoint. The analyzer checks terrain variation, no large holes, no ring gaps, and no console/page errors.
- The visual loop runs on the SSH verification host per `docs/VERIFICATION.md`; CI runs the Node tests and the build.
- `infinite.html` gets the existing screenshot loop rerun after the refactor; a visual diff against the pre-refactor shots is the regression gate.

### 10. Build and dependency changes

- Add `dem` to the Vite rollup inputs; `base: './'` stays.
- Add `geotiff` and `proj4` to devDependencies. They are not part of the browser bundle.
- Update `tsconfig.node.json` to include the bake/validation tools and `tools/dem/**/*.ts`; keep the puppeteer-based screenshot drivers excluded as before.
- Add `bake:dem` and `test:dem` scripts; add `test:dem` to the Pages workflow.
- `public/data/jotunheimen/` is copied to `dist/data` by Vite. Runtime URLs must resolve relative to the page, not absolute `/data`, because the site uses a project-page base.

## Risks / Trade-offs

| Risk | Mitigation |
|---|---|
| ~101 MB of binary data grows the repo and clone time | Commit only derived tiles; keep source GeoTIFFs out; manifest version; the size is a deliberate 2× normal-quality trade-off accepted during apply |
| Kartverket WCS is slow or times out for large requests | 1536² chunks, retries, local cache, `--input` local GeoTIFF support, documented snapshot date |
| Normal seams at tile edges | Single global height grid, one-texel halo, boundary reference check, `test:dem` sample rebake |
| LOD mismatch in the morph band | All LODs sampled from the same global grid; no independent per-level bakes |
| Finite edge looks like a hole or cliff | Source clamp, fog outside the last ring, last-ring skirt, boundary crack screenshot |
| PNG decode adds boot latency | 128² normal PNGs, limited fetch concurrency, `createImageBitmap`, HTTP cache; the visible 3×3 window is only ~27 tiles |
| Refactor regresses the procedural scene | Behavior-preserving extraction, existing QA hooks, rerun the infinite screenshot loop, compare visuals |
| Pre-baked source masks a configuration mismatch | Manifest validation against `TerrainConfig`; visible error; no silent fallback |
| Data re-bake changes 3,000 files | Bake version in the manifest; regenerate and commit as one change; avoid incidental re-bakes |
| Attribution/license missed | Manifest, dataset docs, and DEM page all carry the Kartverket/CC BY 4.0 statement |

## Migration Plan

1. **Renderer/source refactor:** create `src/terrain/`, move the pure modules, extract `ClipmapRenderer`, split `TileStreamer` into `TileCache` + `ProceduralTileSource`, rewire `infinite.html`. Verify typecheck, `test:infinite`, and the screenshot loop before touching DEM data.
2. **Bake tool:** implement the WCS source, grid mosaic, LOD tiling, normal halo, manifest, and validator. Test against a small local fixture and a 2 km real subset before the full bake.
3. **Dataset:** bake Jotunheimen, run `test:dem`, inspect the preview, and commit the manifest/tiles/coarse grid.
4. **DEM page:** add `dem.html`, `PrebakedTileSource`, free-fly/orbit flight, UI/attribution, and QA hooks. Verify with headless screenshots and the boundary crack test.
5. **Docs/CI:** update `README.md`, `AGENTS.md`, `docs/VERIFICATION.md`, add `docs/DEM_DATASET.md`, add `test:dem` to CI, and rerun the full build.

Rollback: the refactor is internal; reverting the change restores the monolithic infinite page. The new dataset and page are additive and can be removed without affecting the procedural scene. Landing the refactor as its own commit within the change keeps that rollback cheap.

## Open Questions

None at planning time. The dataset size/detail option is fixed at option A; the source, page choice, and finite-world policy are decided above.
