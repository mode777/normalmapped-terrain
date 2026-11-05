# Proposal

## Why

The material system is proven on one alpine window with a fixed four-material
palette. The next question is whether the same runtime contract covers several
biomes in one continuous world without a larger stack format, per-tile assets,
or a live texture service. A compact synthetic world is the cheapest way to
prove that before investing in a larger pre-calculated or infinite world.

## What Changes

- Add a checked-in synthetic world, deliberately only as large as needed:
  **15.36 km × 15.36 km**, 15 m L0 mesh, 1,024² height grid, 5 LODs, 2× normal
  tiles. Six climate-ordered biome bands (arctic, tundra, boreal, temperate,
  arid, tropical) run roughly north to south with warped boundaries and an
  altitude/moisture influence. Estimated dataset: ~25 MB, versus ~107 MB for
  Jotunheimen.
- Generate the world from a seeded, pure `(x,z)` height field plus temperature
  and moisture fields. Bake height, normal, coarse-height, preview and seam
  report tiles with the existing offline helpers and conventions; no runtime
  procedural work and no terrain edits after bake.
- Extend the baked material stack from one fixed palette to **six authored
  four-material palettes** plus **five authored four-material transition
  palettes**. Per-texel IDs already vary in the stack format, so the shader and
  texture layout stay unchanged. Every material reaches zero weight before its
  ID leaves the set; the transition bands carry only their four fixed IDs.
- Add a checked-in `biome-map.png` (climate + biome/transition index) and a
  `biome-report.json` (per-biome coverage and weight ranges) for QA and the
  page legend. These are data artifacts, not runtime shading inputs.
- Add `biome.html`, a pre-baked scene page that reuses the shared
  `ClipmapRenderer`/`TileCache`/material shader and adds biome legend, jump-to-
  biome, and material on/off/debug controls. Refactor the pre-baked page shell
  so `dem.html` and `biome.html` share the boot/render loop rather than
  duplicating it.
- Add `npm run bake:biome` and `npm run test:biome`, a synthetic-world
  generator/baker under `tools/biome/`, and dataset validation for palettes,
  transition continuity, biome coverage, hashes and manifest agreement.
- Add biome-specific headless QA: captures in each biome, a north→south
  traversal, transition close-ups, material-on/off and debug views, plus pixel
  assertions that biomes are visually distinct and transitions do not flash.
- **Poly Haven traffic:** reuse the already checked-in 20-material packed
  library in `public/materials/`; the page never calls the live API. If the
  palette needs an entry that is not packed yet, fetch it through the existing
  cache-backed `npm run bake:materials` flow and commit the packed output, not
  the source downloads. No new runtime dependency.
- Keep `dem.html` (single-palette Jotunheimen) and `infinite.html` (no
  materials) behavior unchanged. The new manifest fields are optional and
  older manifests remain loadable.

**Non-goals:** more than 24 materials, per-LOD or tiled material stacks,
virtual texturing, real landcover, water/sea rendering, a world larger than the
15.36 km demonstration window, porting materials to `infinite.html`, real-GPU
performance sign-off, or new Poly Haven downloads at runtime.

## Capabilities

### New Capabilities

- `terrain-biomes`: a deterministic synthetic world with climate/biome fields,
  multiple authored material palettes, stable four-ID transition bands, a
  checked-in baked dataset, and a pre-baked biome traversal page.

### Modified Capabilities

None. The existing material and detail behavior is still an unarchived change
with no main spec yet; this change consumes that contract rather than changing
it. `terrain-biomes` owns the new biome-specific requirements.

## Impact

- **World generation/bake:** new `tools/biome/` modules and
  `tools/bake-biome.ts`; reuse `tools/dem/grid.ts` tile/normal/coarse helpers.
  New `public/data/biomes/` checked-in dataset and `tools/biome/config.json`.
- **Manifest/runtime:** optional `biomes`, `palettes` and `transitions` in the
  material block; optional biome metadata in the pre-baked manifest;
  `src/dem/prebaked-source.ts` continues to load version 2 manifests. New
  `src/biome/` page entry; shared pre-baked boot extracted from
  `src/dem/main.ts`.
- **Shader:** no stack/format change. Optional per-material debug colors replace
  the hardcoded four-role debug colors so six biomes remain distinguishable.
- **Tests/QA:** `tools/test-biome.ts`, `tools/biome/validate.ts`,
  `tools/screenshot-biome.ts`, `tools/analyze-biome.ts`; CI adds
  `test:biome`. Existing Jotunheimen and infinite checks must still pass.
- **Pages/build:** `biome.html`, `vite.config.ts` input, README/AGENTS/docs
  updates, and a biome page link from `dem.html` and `materials.html`.
- **Size:** ~25 MB dataset plus the existing ~34 MB packed material library;
  no new material assets expected.
- **Dependencies:** none new. `pngjs` remains a devDependency for the bake and
  analyzer; the runtime still uses only `three`.
