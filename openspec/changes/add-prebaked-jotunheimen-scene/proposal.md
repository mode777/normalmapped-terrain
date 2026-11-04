# Proposal

## Why

The renderer is already texture-driven—its shaders contain no procedural terrain code—but the application is wired only to the procedural worker pipeline. There is no supported way to feed it pre-baked height/normal tiles, so the same clipmap cannot be used for real DEM data. A checked-in, real-world dataset would prove the renderer is source-agnostic, exercise the tile cache with assets produced offline, and give the project a second showcase that is visually distinct from the procedural infinite world.

## What Changes

- Split the current procedural streamer into a reusable **tile cache** and a **tile source** boundary. The procedural worker becomes one source implementation; a pre-baked source becomes another.
- Extract the clipmap rendering core (geometry, material, uniforms, per-level origins, debug views) from the page orchestration so `infinite.html` and the new DEM page share it.
- Add a Node/TypeScript **DEM bake tool** that downloads Kartverket terrain data, mosaics it into one metric grid, bakes height and normal tiles at every LOD, validates edge continuity, and writes a manifest plus tile files.
- Check in the **Jotunheimen, Norway** dataset (option A): 30.72 km × 30.72 km at 10 m spacing, 6 LODs, 2× normal resolution, roughly 100 MB of derived tiles (the 2× normal PNGs dominate the size). Source: Kartverket Nasjonal høydemodell DTM 10, CC BY 4.0.
- Add a new **`dem.html`** scene with free-fly movement plus an optional auto-cruise orbit, a coarse CPU height grid for flight clearance, dataset attribution, and the existing visual/debug controls. Link it with `infinite.html`.
- Add data-integrity and seam tests, a headless screenshot driver for the DEM page, and documentation for the data source, bake parameters, regeneration, and verification.
- Add `geotiff` and `proj4` as dev dependencies; no GDAL or system raster tooling is required.

The procedural page's visual behavior and render invariants remain unchanged.

## Capabilities

### New Capabilities

- `terrain-rendering`: source-agnostic clipmap rendering, the tile-source/cache contract, texture layout, LOD/origin behavior, and procedural/pre-baked source selection.
- `prebaked-terrain`: the DEM bake tool, checked-in dataset format and manifest, normal-seam guarantees, finite-world edge policy, and the pre-baked showcase scene.

### Modified Capabilities

- None. No existing capability specs are present in this repository.

## Impact

- **Code:** `src/infinite/main.ts`, `src/infinite/tiles.ts`, `src/infinite/worker-protocol.ts`, `src/infinite/terrain-worker.ts`, and `src/infinite/shaders.ts` will be reorganized around shared renderer/cache/source modules. New `src/terrain/` and `src/dem/` modules, `tools/bake-dem.ts`, `tools/test-dem.ts`, and DEM QA tools.
- **Pages/build:** new `dem.html`, Vite input entry, `public/data/jotunheimen/` (~100 MB checked in), and cross-links between the two showcases.
- **Dependencies:** `geotiff` and `proj4` as devDependencies; `pngjs` is already present.
- **Tests/CI:** `test:dem` data validation joins `test:infinite` in CI; headless DEM screenshots remain a manual visual check.
- **License/attribution:** derived tiles and page UI must credit Kartverket and CC BY 4.0.
- **Compatibility:** `infinite.html` keeps its current visuals and QA hooks; the refactor is internal to the page and its existing tests.
