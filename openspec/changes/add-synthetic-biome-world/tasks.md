# Tasks

## 1. Shared bake plumbing and manifest compatibility

- [x] 1.1 Extract the pre-baked file writers (`writeHeightTile`, `writeNormalPng`, `writeRgbaPng`, `sha256File`) from `tools/dem/bake.ts` into `tools/prebaked/io.ts` and update the DEM bake imports. Verify: `npm run test:dem` passes and `node tools/bake-dem.ts --config tools/dem/jotunheimen.json --check-materials` still reproduces the checked-in hashes.
- [x] 1.2 Extend `tools/dem/types.ts` and `src/dem/prebaked-source.ts` with `source.type = "synthetic"`, optional material `palettes`/`transitions`, and an optional `biomes` manifest block. Verify: `npm run typecheck` passes and `npm run test:dem` loads the existing version-2 Jotunheimen manifest unchanged.
- [x] 1.3 Make `src/terrain/material-stack.ts` accept optional palette metadata while preserving the legacy fixed-slot path and `slotIndices` fallback. Verify: `npm run build` succeeds and the Jotunheimen page still loads its stack without console errors.
- [x] 1.4 Extend `tools/dem/validate.ts` so a manifest with `palettes` validates every stack ID quartet against the authored region/transition sets, while a manifest without `palettes` keeps the current fixed-slot check. Verify: `npm run test:dem` passes; a temporary copy with an unknown palette ID fails and names the palette.

## 2. Synthetic world generation and tile bake

- [x] 2.1 Add `tools/biome/config.json` and `tools/biome/world.ts` with a seeded pure `heightAt(x,z)` and `climateAt(x,z,h)` over the 15.36 km frame, six ordered regions, warped climate boundaries and a north-high/south-low height bias. Verify: a Node check prints a plausible height range, all six regions have non-zero sample coverage, and the same seed reproduces identical samples.
- [x] 2.2 Add `tools/bake-biome.ts` writing height/normal tiles, coarse height, preview, seam report and a version-2 manifest for the synthetic source. Verify: `npm run bake:biome -- --out /tmp/biome-bake` writes the expected ~344 tiles, `node tools/bake-biome.ts --config tools/biome/config.json --check --out /tmp/biome-bake` passes, and every LOD samples agree with the L0 grid.
- [x] 2.3 Add `tools/test-biome.ts` and `npm run test:biome` with synthetic checks for the world generator, tile/LOD agreement, normal boundaries and climate continuity. Verify: `npm run test:biome -- --synthetic` passes before the checked-in dataset exists.
- [x] 2.4 Write `docs/BIOME_WORLD.md` with the world extent, resolution/LOD choices, seed, license, file layout, bake commands and validation commands. Verify: every command and path in the doc runs as written.

## 3. Multi-palette material stack

- [x] 3.1 Add `tools/biome/material-stack.ts` implementing the six region palettes, five transition palettes, region edge-fade, band progress and macro/map outputs from the design. Verify: a synthetic 1D sweep across every boundary reports restricted-weight jumps below 1/255 and zero non-band weights at each band edge.
- [x] 3.2 Wire the stack bake into `tools/bake-biome.ts`: write `stack-ids.png`, `stack-weights.png`, `macro-albedo.png`, `biome-map.png`, `biome-report.json`, and the manifest `palettes`, `transitions` and `biomes` blocks. Verify: `npm run bake:biome` produces 2048² stack, 1024² macro/map and a manifest whose region/transition order matches the config.
- [x] 3.3 Add `--materials-only` and `--check-materials` to `tools/bake-biome.ts`, reconstructing the L0 grid from checked-in height tiles like the DEM tool. Verify: a materials-only rebake matches the stack/macro/biome hashes, and `--check-materials` names the first mismatching artifact.
- [x] 3.4 Add `tools/biome/validate.ts` for region coverage, palette membership, transition edge continuity, report agreement and hashes; wire it into `tools/test-biome.ts`. Verify: `npm run test:biome` passes on the checked-in dataset and a deliberately corrupted transition weight fails with the band name and texel.
- [x] 3.5 Document the palette table, transition-band algorithm, macro/map/report encoding and regeneration flow in `docs/BIOME_WORLD.md`. Verify: the documented material IDs and hashes match `public/data/biomes/manifest.json`.

## 4. Runtime page and debug view

- [x] 4.1 Add `uMaterialDebugColors[24]` to the terrain uniforms, fill it from the packed library's average colors, and change the debug branch to output weighted material colors. Verify: `npm run typecheck` passes and a Jotunheimen debug capture still varies (`std > 12`).
- [x] 4.2 Extract the pre-baked boot/render loop and QA hooks from `src/dem/main.ts` into `src/prebaked/app.ts`, leaving `src/dem/main.ts` as a thin entry point. Verify: `npm run build` succeeds and the existing DEM headless smoke run reaches `window.__dem` with no new console errors.
- [x] 4.3 Add `biome.html`, `src/biome/main.ts` and `src/biome/biome.css`; load `data/biomes/manifest.json`, render the biome legend and jump-to-region controls, and reuse the shared pre-baked app. Add the page to `vite.config.ts`. Verify: `npm run build` includes `biome.html` and the page boots with all six legend entries.
- [x] 4.4 Add QA hooks `warpToBiome(id)`, `getBiomeStats()` and a current-region readout, driven by the manifest region centers. Verify: a browser evaluate can jump to every region and read the expected region id after tiles settle.
- [x] 4.5 Update `README.md` page/setup tables and link `biome.html` from `dem.html` and `materials.html`. Verify: the links resolve in a production build and the documented commands run as written.

## 5. Visual and dataset verification

- [x] 5.1 Add `tools/screenshot-biome.ts` capturing the default view, one pose per region, a north→south traversal, transition close-ups, material on/off, material debug, distance, normal-zero, LOD/tile debug, a magenta crack shot and the swatch page. Verify: every expected PNG and `biome-stats.json`/`console.json` exists with no page, console or request errors.
- [x] 5.2 Add `tools/analyze-biome.ts` asserting no errors, non-flat biome shots, pairwise-distinct biome means, transition variation without a flat band, material on/off difference, debug variation, far-field variation and `< 0.2%` magenta in the crack shot. Verify: the analyzer passes on the new shot set and a deliberately flattened transition shot fails.
- [x] 5.3 Update `docs/VERIFICATION.md` with the biome shot names, commands, reference values and the SwiftShader real-GPU caveat; add a checked-in preview screenshot under `docs/screenshots/`. Verify: the documented commands run as written and the screenshot matches the checked-in page.
- [x] 5.4 Add the biome dataset size, tile count, GPU texture estimate and material stats to `docs/BIOME_WORLD.md` and `docs/MATERIALS.md`. Verify: the numbers match `biome-report.json`, `material-stats.json` and the renderer stats.

## 6. Integration and release checks

- [x] 6.1 Run `npm run typecheck`, `npm run test:infinite`, `npm run test:dem`, `npm run test:materials`, `npm run test:biome`, `npm run build` and `openspec validate --all`. Verify: all commands pass.
- [x] 6.2 Run the headless DEM and infinite baseline loops plus the new biome loop on the verification host. Verify: no console/page errors, the Jotunheimen baseline is unchanged apart from the documented debug-color change, and the biome analyzer passes.
- [x] 6.3 Add `npm run test:biome` to `.github/workflows/deploy.yml`, update the `AGENTS.md` repo map/invariants and `README.md` limitations with the biome page, optional palette metadata and local-material rule. Verify: the workflow file parses and a push to `main` runs all four dataset checks before the build.

## Workflow follow-up

- Commit the completed change, merge it to `main`, and push so the Pages deploy runs.
- Sync/archive `add-multi-material-terrain` first so the `terrain-materials` main spec exists, then archive this change and commit/push the archive.
- Propose `add-infinite-material-adapter` next, reusing this change's palette and transition rules.
