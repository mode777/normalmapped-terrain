# Tasks

## 1. Shared renderer and source seam

- [x] 1.1 Add `src/terrain/tile-source.ts` with `TerrainConfig`, `GeneratedTile`, and `TileSource`, and `src/terrain/config.ts` with `outerExtent`, cache sizes, `phaseWrap`, and `renderOriginStep`; verify `npm run typecheck`.
- [x] 1.2 Move `bakeTileNormals` into `src/terrain/normals.ts`, update `heightfield.ts` and the unit tests to import it; verify `npm run test:infinite`.
- [x] 1.3 Move shared `clipmap.ts`, `origins.ts`, `shaders.ts`, and `ui.ts` under `src/terrain/` and update imports; verify `npm run typecheck` and `npm run test:infinite`.
- [x] 1.4 Extract `ClipmapRenderer` into `src/terrain/renderer.ts` with config-driven textures, material, meshes, debug group, origins, and sun/normal/debug setters; verify the procedural page boots and renders in the existing headless screenshot loop.
- [x] 1.5 Split `TileStreamer` into `src/terrain/tile-cache.ts` and `src/infinite/procedural-source.ts`; implement async tile promises, bounded in-flight requests, stale-result discard, upload error reporting, and the existing priority window; verify the procedural page reaches 160 resident tiles after priming.
- [x] 1.6 Simplify `worker-protocol.ts` so `init` carries the seed and generation config while tile requests carry only `id`, `level`, `tx`, `ty`; rewire `src/infinite/main.ts` to use the new source/cache/renderer; verify `npm run typecheck` and `npm run test:infinite`.
- [x] 1.7 Update `AGENTS.md` module map and any affected docs for the `src/terrain/` split; verify the documented module paths exist and `npm run build` succeeds.
- [x] 1.8 Rerun the infinite screenshot loop and compare default, LOD, tile-grid, and crack views against the pre-refactor shots; verify no console/page errors, no new visible seams, and no terrain regression.

## 2. Bake tool and data format

- [x] 2.1 Add `geotiff` and `proj4` as devDependencies and add `bake:dem` / `test:dem` scripts; verify `npm install` and `npm run typecheck`.
- [x] 2.2 Implement the Kartverket WCS source in `tools/dem/` with 1536² (or smaller) chunk requests, retries, GeoTIFF decoding, and float32 mosaic assembly; verify a 2 km test area produces the expected grid dimensions and a plausible elevation range.
- [x] 2.3 Implement the local frame and grid: centre at `(0,0)`, `+x` east, `+z` south, `elevation / 2500` normalization, and per-LOD height tile sampling; verify a synthetic grid test covers tile indices, edge tiles, and LOD subsampling.
- [x] 2.4 Implement normal-tile baking with the `(tileSize * normalScale + 2)²` halo from the shared global grid using the moved `bakeTileNormals`; verify a synthetic adjacent-tile test shows continuous boundary normals after RGB8 quantization.
- [x] 2.5 Implement the `.bin` height writer, RGBA8 PNG normal writer, manifest writer, 1024² coarse height grid, and hillshade preview; verify a small bake produces the declared files, dimensions, encodings, and manifest fields.
- [x] 2.6 Implement bake-time boundary validation and a `--check`/`test-dem` validator covering manifest/tile counts, ranges, dimensions, encodings, height bounds, and the seam report; verify on a small fixture and confirm a deliberately missing/wrong-sized tile fails with its path.
- [x] 2.7 Add `docs/DEM_DATASET.md` documenting the source URL, license, local frame, bake config, output layout, validation commands, and regeneration steps; verify every command in the document exists in `package.json` and runs as written.

## 3. Jotunheimen dataset

- [x] 3.1 Add `tools/dem/jotunheimen.json` with the 30.72 km centred bbox, 10 m spacing, 6 LODs, 2× normals, height scale 2500, and chunk size 1536; verify the config parses and its chunk plan covers the full bbox.
- [x] 3.2 Bake the full Jotunheimen dataset; verify `npm run test:dem` passes, the manifest reports 3,080 tiles, and the checked-in size is the accepted ~100 MB (2× normal PNGs).
- [x] 3.3 Inspect the generated hillshade preview and validate elevation coverage, no obvious voids, and the expected Jotunheimen massif; verify the manifest height range and source metadata match the bake config.
- [x] 3.4 Add a `.gitignore` entry for the bake cache and verify `git status` does not include downloaded GeoTIFFs or temporary mosaics.
- [x] 3.5 Add the dataset section and attribution to `README.md` or `docs/DEM_DATASET.md`; verify the source, CC BY 4.0 statement, modification note, and dataset size are present.

## 4. Pre-baked source and DEM scene

- [x] 4.1 Implement `src/dem/prebaked-source.ts` to load and validate the manifest, resolve tile URLs, fetch/decode uint16 heights and RGBA8 PNG normals, and expose coarse `heightAt` with a peak-safe filter; verify `dem.html` resolves all visible tiles and reports manifest/config mismatches clearly.
- [x] 4.2 Extend `FlightController` with optional `orbitRadius`, `cruiseMode: 'orbit'`, and `defaultView` while preserving procedural defaults; verify the infinite page behavior is unchanged and DEM free flight is not clamped to a dataset boundary.
- [x] 4.3 Add `dem.html`, `src/dem/main.ts`, and page styles; wire the shared `ClipmapRenderer`, `TileCache`, and `PrebakedTileSource` with the DEM config; verify the page boots from checked-in assets and reaches a ready state without procedural workers.
- [x] 4.4 Add the DEM controls, dataset attribution, stats/loading text, and cross-links with `infinite.html`; verify the attribution is visible, the links resolve, and the controls update sun/normal/debug/flight behavior.
- [x] 4.5 Expose `window.__dem` QA hooks for tile waiting, warping, LOD/tile debug, wireframe, and crack mode; verify each hook is callable from the browser console.
- [x] 4.6 Add `tools/screenshot-dem.ts` and `tools/analyze-dem.ts` for default, flat-normal, cruise/orbit, LOD, wireframe, tile-grid, crack, and boundary views; verify the analyzer passes on the built page with no console/page errors and no ring gaps.
- [x] 4.7 Add the DEM section to `docs/VERIFICATION.md`, update `README.md` and `AGENTS.md` with the new page and data paths; verify the documented commands and paths are current.

## 5. Integration and CI

- [x] 5.1 Add the `dem.html` Vite input and include `test:dem` in the Pages workflow; verify `npm run build` emits both pages and `public/data` in `dist`.
- [x] 5.2 Run `npm run test:infinite`, `npm run test:dem`, and `npm run typecheck` together; verify all pass from a clean checkout state.
- [x] 5.3 Run the full infinite and DEM screenshot loops against the built site; verify terrain variation, no large black holes, no crack-test magenta inside the silhouette, and no loading failures.
- [x] 5.4 Verify the checked-in dataset size, file dimensions, attribution, and absence of source GeoTIFFs; confirm the repository remains below the GitHub Pages/recommended repository limits.
- [x] 5.5 Review the final docs and commands for consistency with the implemented scripts and data paths; verify a reader can reproduce the bake and the visual checks from the documentation alone.

## Workflow follow-up

- Commit the completed change and merge it into `main` after apply verification, per the project's apply guidance.
- Archive the change on `main` after review, then commit the archive.
