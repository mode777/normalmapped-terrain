# Proposal

## Why

The terrain's albedo is still four hardcoded height/slope bands, even though
the detail-normal spike proved that standalone tiling textures can add
high-frequency relief without touching the 2048² normal atlas. The next visual
step is real albedo and normal maps driven by a material distribution, with a
library large enough to span arctic tundra to tropical rainforest while only a
few materials blend at any one texel.

The eventual target is a pre-calculated world with multiple biomes. This change
builds and proves the material pipeline on the existing pre-baked Jotunheimen
scene first: that dataset already has the height/normal tile pipeline, a real
30.72 km window and steep terrain, so it is the cheapest place to de-risk the
asset library, the material stack, cliff shading and QA before generating a
synthetic biome world.

## What Changes

- Add a checked-in material library of 20 Poly Haven textures (CC0), capped at
  24 materials. Each material packs into two RGBA8 arrays: albedo RGB + height
  A, and object-space slope RG + roughness B + AO A. The slope encoding is
  projection-friendly for cliff sampling and averages correctly in mips. 512²
  layers with mips and anisotropy; physical tile size comes from Poly Haven's
  `dimensions` field.
- Add a baked **material stack** for the Jotunheimen 30.72 km window: four
  material IDs and four normalized weights per texel in two 2048² maps
  (~16 m/texel), plus a low-resolution macro tint map. Weights are derived
  from normalized height, slope, aspect, curvature and noise, with rock and
  scree driven strongly by steepness.
- Add transition-band baking: adjacent material sets share a fixed ID set over
  a blend band, so IDs can be nearest-sampled and weights linearly sampled
  without dithering or TAA. The band edges reach zero weight before the ID set
  changes.
- Add material composition to the shared fragment shader: sample 1–4 active
  materials from the arrays, blend albedo and height, and compose normals as a
  weighted slope sum in the existing object-space frame (no TBN). Material
  masks continue to use the base normal; lighting uses the combined normal.
- Add per-material parameters for world scale, normal strength, roughness and
  specular; add a slope-aware projection for the rock/cliff material so steep
  faces do not show severe planar stretch. Other materials stay planar.
- Add a material debug view (dominant material / weights) and QA coverage:
  swatches, boundary close-ups, cliff close-up, distance view, and a
  material-off fallback that preserves the current palette.
- Add a Poly Haven fetch/pack tool with a curated manifest, source IDs, map
  choices, tile metres, normal convention, hashes, license and attribution;
  pack output stays small enough to check in.
- Add a material bake/validation stage for the Jotunheimen dataset and update
  the manifest, tests and documentation.
- Keep the infinite page on the existing shading in this change. The material
  shader falls back to the current palette when no stack is configured.

**Non-goals:** generating the synthetic multi-biome world, porting the
material stack to the infinite page, real landcover data (AR50/N50), virtual
texturing, per-LOD stack tiles, full PBR (metalness/AO maps), water, and
triplanar projection for every material.

## Capabilities

### New Capabilities

- `terrain-materials`: textured multi-material terrain with a capped texture
  library, a baked four-ID/four-weight distribution stack, height-blended
  albedo and slope-space normals, steepness-driven rock/cliff shading, and the
  pre-baked dataset contract that feeds it.

### Modified Capabilities

None. The existing detail-layer work is still an unarchived change and has no
main spec to modify.

## Impact

- **Shader/renderer:** `src/terrain/shaders.ts`, `src/terrain/renderer.ts`,
  `src/terrain/ui.ts`; new material loaders/types under `src/terrain/`.
- **Pages:** `src/dem/main.ts` (stack + macro map wiring, debug UI),
  `src/infinite/main.ts` (keep fallback path working), page HTML/CSS for the
  new controls.
- **Dataset/tools:** `tools/bake-dem.ts`, `tools/dem/*`, `src/dem/prebaked-source.ts`,
  a new Poly Haven fetch/pack tool and material manifest, `package.json`
  scripts, `public/data/jotunheimen/*`, `public/materials/*`.
- **Tests/QA:** `tools/test-dem.ts`, `tools/test-infinite.ts`,
  `tools/screenshot-dem.ts`, `tools/analyze-dem.ts`, new material checks.
- **Docs:** `README.md`, `docs/DEM_DATASET.md`, `docs/VERIFICATION.md`, a
  material/findings note, and Poly Haven attribution.
- **Dependencies:** `sharp` as a devDependency for the offline fetch/pack tool
  (JPEG decode, resize, channel packing). Runtime dependencies stay `three`.
- **Size:** the packed material library is expected around 10–15 MB; the
  Jotunheimen stack and macro maps add roughly 30–40 MB to the checked-in
  dataset. The existing dataset is ~101 MB.

## Assumptions

- The library is capped at 24 materials; the first set is the 20-material
  arctic→tropical candidate list from the exploration.
- Four IDs and four weights per texel are sufficient because most texels have
  one or two active materials; transition bands carry at most four.
- The Jotunheimen window is a single alpine/boreal biome; the synthetic world
  change exercises the full 20-material range.
- Poly Haven assets are CC0. The live API requires a unique User-Agent and a
  visible credit; checked-in, self-hosted assets do not, but the README will
  credit Poly Haven anyway.

## Roadmap

This change is the first vertical slice. Follow-up changes, in dependency
order:

1. **`add-synthetic-biome-world`** — generate a pre-calculated world of
   reasonable size (tens of kilometres) with height, temperature/moisture and
   biome fields; bake the same material stack with multi-biome palettes and
   transition bands; add the macro tint/aerial layer; demonstrate
   arctic→tropical traversal. Reuses this change's library, stack format and
   shader.
2. **`add-infinite-material-adapter`** — generate a repeating or per-tile
   material stack for `infinite.html` from the same palette rules; keep the
   pre-calculated format authoritative.
3. **`add-material-streaming`** — only if the world grows past ~50 km or the
   library past 24: per-LOD stack tiles or a virtual-texture/RVT path.
4. **`add-real-landcover-materials`** — optional: replace the procedural
   Jotunheimen weights with AR50/N50 (or similar) landcover where available.
