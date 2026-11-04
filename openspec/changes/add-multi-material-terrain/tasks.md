# Tasks

## 1. Material library and Poly Haven pipeline

- [x] 1.1 Add `tools/materials/polyhaven.json` with the curated 20-material set: Poly Haven ID, biome/role, selected maps, 1k source resolution, physical tile metres from `dimensions / 1000`, projection, and license. Verify: a manifest check resolves every ID through `/assets` and confirms each has a diffuse, a normal (`nor_gl` or `nor_dx`), and a usable height source (`Displacement` or `Bump`).
- [x] 1.2 Add `sharp` as a devDependency and implement `tools/fetch-materials.ts`: unique User-Agent, `GET /files/{id}`, MD5/size verification, 512² resize, `albedo-height.png` (RGB sRGB + A height), `slope-rough.png` (RG slope + B roughness + A AO), per-material `slopeScale`, `averageColor`, and source hashes. Verify: `npm run bake:materials` writes 20 material directories plus `public/materials/manifest.json`, and every packed PNG is 512×512 RGBA.
- [x] 1.3 Add `tools/test-materials.ts` and `npm run test:materials`: cap 24, exactly 20 entries, 512² dimensions, RGBA8 channels, tile metres in a sane range, slope scale present, average colors present, manifest hashes match, no missing files. Verify: the command passes, and a deliberately corrupted manifest fails with the field name.
- [x] 1.4 Add `public/materials/README.md` and a README credit for Poly Haven: CC0 status, source asset links, pack format, normal convention and the fact that only packed outputs are checked in. Verify: links resolve, the license text is present, and no source JPEG/PNG or API key is committed.
- [x] 1.5 Add `materials.html` as a swatch page that renders all 20 packed materials with albedo and slope relief, plus a QA hook that reports the loaded layer count. Verify: the page loads 20 layers with no console errors and each material is visually distinguishable.

## 2. Jotunheimen material stack bake

- [x] 2.1 Add `tools/dem/material-stack.ts`: sample the 10 m DEM grid at the stack resolution (~15 m), compute slope, aspect and curvature, evaluate the fixed four-slot weights (rock, scree, snow, grass) with seeded low-frequency noise, normalize/quantize the weights, and bake the macro albedo (~30 m). Verify: a CLI/unit check reports weight sums within 1/255, IDs inside the slot range, and non-degenerate ranges for all four weights.
- [x] 2.2 Wire the stack bake into `tools/bake-dem.ts` and the manifest types: write `stack-ids.png`, `stack-weights.png`, `macro-albedo.png`, add the `materials` block (library path, slot IDs, stack/macro paths, size, extent, encoding, bake version, seed), and keep older manifests without the block loadable. Verify: `npm run bake:dem -- --config tools/dem/jotunheimen.json` produces 2048² stack images and a 1024² macro image, and the manifest contains the expected fields.
- [x] 2.3 Extend `tools/dem/validate.ts` for the material dataset: file presence, image dimensions, ID range, weight normalization, slot IDs existing in the library, manifest/stack agreement, and hashes. Verify: `npm run test:dem` passes; a deliberately corrupted copy fails with the offending file and field.
- [x] 2.4 Add a deterministic `--check` path for the stack and macro bake (seed and hashes) so a stale or hand-edited dataset is detectable. Verify: re-baking into a temporary output directory reproduces the checked-in hashes.
- [x] 2.5 Add the checked-in stack/macro size and regeneration notes to `docs/DEM_DATASET.md`, including the four-slot palette and the steepness/aspect/curvature rules. Verify: the documented commands run as written and the documented sizes match the manifest.

## 3. Material and stack loaders

- [x] 3.1 Add `src/terrain/materials.ts`: manifest types and validation, `loadMaterialLibrary` using `createImageBitmap`/`OffscreenCanvas` to build two 24-layer `DataArrayTexture`s with the correct sRGB/linear spaces, repeat wrapping, mips, anisotropy, material parameters and average colors. Verify: `npm run typecheck`, the swatch page loads all 20 layers, and the layer count is reported.
- [x] 3.2 Add `src/terrain/material-stack.ts`: load the IDs, weights and macro textures, validate size/extent/slots against the library, set nearest/linear filters and color spaces, and compute the absolute-render-origin UV offset. Verify: the DEM QA hook reports the stack size/extent, and no console or WebGL errors appear.
- [x] 3.3 Extend `ClipmapRendererOptions` and `ClipmapRenderer` with the material/stack options, uniforms, texture-unit allocation, disposal and failure fallback. Add `setMaterialMode`, `setHeightBlend` and `setMaterialNormalStrength`. Verify: `npm run typecheck`, the DEM page boots with materials enabled and disabled, and the infinite page still renders without loading materials.
- [x] 3.4 Add a texture-unit and budget guard (24-layer cap, stack/macro dimensions, available units) with a stats readout. Verify: the QA hook reports the layer/stack/macro sizes, and SwiftShader reports no texture-unit or upload errors.

## 4. Material shader composition

- [x] 4.1 Add the material uniforms and stack sampling: world-locked UV offset, nearest IDs, linear weights, and the active-slot loop with an early-out for zero weights. Verify: the material debug hook exposes the sampled IDs/weights, and `npm run build` succeeds.
- [x] 4.2 Implement height blending, weighted albedo, macro tint/far blend, and roughness/specular/AO contribution. Verify: a material-on shot differs from material-off, the swatch page matches the packed colors, and the distance shot uses the macro color.
- [x] 4.3 Implement RG slope decode, planar slope composition, triplanar rock (albedo, height and slope), and the weighted slope sum; keep the detail layer and use `Nbase` for masks. Verify: the cliff close-up shows rock without severe smearing, a low-sun pair lights the correct side, and changing material normal strength does not move the distribution.
- [x] 4.4 Implement the material debug view and the `uMaterialCount == 0` fallback path; make the `02-normal0` baseline zero material normals or use material-off. Verify: the debug shot distinguishes rock, snow and vegetation; material-off reproduces the old palette; the infinite baseline is unchanged.

## 5. DEM page and controls

- [x] 5.1 Wire the material library and stack into `src/dem/main.ts`, pass the options to `ClipmapRenderer`, and surface load failures through the toast/console. Verify: the DEM page boots with materials on and off and reports no errors.
- [x] 5.2 Add UI controls for material mode (on/off/debug), height blend and material normal strength in `dem.html` and `src/terrain/ui.ts`, and wire them to the renderer. Verify: each control changes the render and the QA hooks reflect the state.
- [x] 5.3 Add QA hooks `setMaterialMode`, `setHeightBlend`, `setMaterialNormalStrength` and `getMaterialStats`. Verify: the screenshot driver can invoke each hook and read the returned state.
- [x] 5.4 Keep `src/infinite/main.ts` on the fallback path: no material library/stack load, no new controls. Verify: the infinite page's baseline screenshots and analyzer values match the pre-change reference.

## 6. Verification, documentation and integration

- [x] 6.1 Extend `tools/screenshot-dem.ts` with material on/off, boundary, cliff, distance, debug and swatch captures. Verify: every expected shot file exists and the driver reports no page/console errors.
- [x] 6.2 Extend `tools/analyze-dem.ts` with material-on/off difference, cliff rock dominance, debug-color distinctness and the existing blank/black/LOD/tile/crack checks. Verify: the analyzer passes on the new shot set and fails if the material layer is disabled.
- [x] 6.3 Update `docs/VERIFICATION.md` with the new shots, reference values, and the real-GPU caveat for mips/anisotropy. Verify: the documented commands run as written.
- [x] 6.4 Write `docs/MATERIALS.md`: library contents, packed formats, stack encoding, bake rules, steepness/aspect/curvature, Poly Haven attribution, and the cliff/triplanar findings. Verify: the commands and asset paths in the doc are correct.
- [x] 6.5 Update `README.md` and `AGENTS.md` with the material invariants: RG slope encoding, sRGB/linear rules, stack UV offset, 24-material cap, fixed Jotunheimen palette and fallback behavior. Verify: no contradictions with the shader or manifest.
- [x] 6.6 Run `npm run typecheck`, `npm run test:infinite`, `npm run test:dem`, `npm run test:materials`, `npm run build` and `openspec validate --all`. Verify: all commands pass.
- [x] 6.7 Run the headless DEM QA loop and the infinite baseline loop on the verification host. Verify: no console/page errors, the analyzers pass, and the material-off/infinite baselines match.
- [x] 6.8 Record measured texture memory, draw calls and the software-renderer caveat in `docs/MATERIALS.md`. Verify: the numbers match the renderer stats and the documented budget.

## Workflow follow-up

- Commit the completed change, merge it to `main`, and push so the Pages deploy runs.
- Archive the change after review, sync the spec, and commit/push the archive.
- Propose `add-synthetic-biome-world` next, using the roadmap in `proposal.md`.
