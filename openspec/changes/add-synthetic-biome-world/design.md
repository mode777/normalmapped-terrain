# Design

## Context

See `proposal.md` for motivation and `specs/terrain-biomes/spec.md` for the
behavior contract. The existing pipeline already provides the pieces this
change needs:

- `tools/dem/grid.ts` bakes height tiles, 2× normal tiles and the coarse grid
  from one global `DemGrid`.
- `tools/dem/material-stack.ts` writes a four-ID/four-weight stack and a macro
  albedo, but assumes one fixed palette.
- `src/terrain/material-stack.ts` and the fragment shader already read
  per-texel IDs, so a multi-palette stack does not need a new texture layout or
  shader loop.
- `src/dem/main.ts` boots the pre-baked page from a manifest, loads the
  checked-in material library and exposes QA hooks.

The main constraints are dataset size, the 4-slot stack contract, the
`flipY=false` row order, and the visual QA requirement in
`docs/VERIFICATION.md`.

## Goals / Non-Goals

**Goals:**

- A 15.36 km square synthetic world with six biome bands, enough to traverse
  arctic → tropical and measure each palette.
- A deterministic, network-free bake and dataset check that runs in CI.
- Stable palette transitions with the existing four-slot stack and shader.
- A page that makes the biome coverage obvious without duplicating the
  pre-baked renderer.
- Reuse the packed Poly Haven library already in `public/materials/`.

**Non-Goals:**

- Real-world climate/landcover, water, erosion simulation, or a world larger
  than 15.36 km.
- More than four simultaneous materials, eight-slot stacks, per-LOD stacks or
  virtual texturing.
- Changing `dem.html` to multi-palette or loading materials on
  `infinite.html`.
- New Poly Haven downloads or new runtime dependencies.

## Decisions

### 1. World size and resolution

Use **15.36 km × 15.36 km**, **15 m L0 spacing**, a **1,024² global height
grid**, **5 LODs**, 64² height tiles and 2× (128²) normal tiles. With
`centerCells = 24`, the last ring reaches 11.52 km, which covers the square's
10.86 km half-diagonal from the centre. The bake produces about 344 tiles and
roughly 25 MB including normals, stack and macro.

Why not Jotunheimen's 30.72 km / 10 m: it doubles the area and triples the
check-in size for a demonstration. Why not 10 m at 10.24 km: six bands would
be only ~1.7 km wide and the dataset still ~25 MB. Why not 20 m: the near-field
silhouette is visibly faceted; material normals carry high-frequency detail but
not the mesh silhouette. The chosen 15/7.5 m meshes are a deliberate middle
ground.

The stack stays 2048² over 15.36 km (~7.5 m/texel) and the macro 1024²
(~15 m/texel). That is finer than Jotunheimen's stack and keeps the same GPU
texture budget.

### 2. Seeded world and climate fields

`tools/biome/world.ts` exposes a pure `heightAt(x,z)` and `climateAt(x,z,h)`.
Height uses the existing `makeTerrainComposer` with shorter wavelengths tuned
for a compact world (warp ~4 km, continent ~12 km, mountains ~3.5 km, hills
~1.8 km) plus a latitude/altitude bias that keeps the high peaks in the north
and the southern half lower. The final constants live in
`tools/biome/config.json`, not in the page.

Climate is a continuous axis derived from the north–south coordinate and
low-frequency noise, warped so boundaries are not straight:

```text
lat     = (z + size/2) / size          // 0 north, 1 south
climate = clamp(lat + 0.035 * noise(x/6000, z/6000), 0, 1)
```

Six ordered regions share equal climate bands, with band boundaries at
`1/6 … 5/6`: **arctic, tundra, boreal, temperate, arid, tropical**. Arid sits
between temperate and tropical as a dry interior, so the final transition is
arid → tropical. Temperature and moisture are separate fields used by the
material rules:

```text
temperature = 1 - climate - 0.55 * h + 0.06 * noise(...)
moisture    = 0.45 + 0.35 * noise(...) - rainShadow(x, z)
```

The biome map stores region/transition indices and band progress for QA; it is
not a runtime shading input. The world is generated once and checked in, so
runtime never evaluates the climate or height function.

### 3. Six palettes plus five transition palettes

Each region owns exactly four library IDs. The authored palettes are:

| Region | Materials |
|---|---|
| arctic | `snow_02`, `snow_field_aerial`, `rock_face_03`, `rocky_terrain_02` |
| tundra | `rock_pitted_mossy`, `lichen_rock`, `sparse_grass`, `rock_face_03` |
| boreal | `forest_ground_04`, `brown_mud_leaves_01`, `mossy_rock`, `rock_face_03` |
| temperate | `leafy_grass`, `forest_ground_04`, `brown_mud_03`, `rock_face_03` |
| arid | `sand_01`, `dry_ground_rocks`, `sandstone_cracks`, `rock_face_03` |
| tropical | `forest_leaves_02`, `red_laterite_soil_stones`, `leafy_grass`, `rock_face_03` |

The six palettes use 17 of the 20 packed materials; `gravelly_sand`,
`aerial_grass_rock` and `aerial_beach_01` remain available for tuning without
changing the manifest contract. Each adjacent pair gets a fixed four-ID
transition palette:

| Band | Materials |
|---|---|
| arctic–tundra | `rock_face_03`, `snow_02`, `rock_pitted_mossy`, `rocky_terrain_02` |
| tundra–boreal | `rock_face_03`, `rock_pitted_mossy`, `forest_ground_04`, `mossy_rock` |
| boreal–temperate | `rock_face_03`, `forest_ground_04`, `leafy_grass`, `brown_mud_03` |
| temperate–arid | `rock_face_03`, `leafy_grass`, `sand_01`, `dry_ground_rocks` |
| arid–tropical | `rock_face_03`, `sand_01`, `red_laterite_soil_stones`, `forest_leaves_02` |

`rock_face_03` is in every palette and band, so cliffs remain rock across the
whole world. Each region's primary material survives both adjacent bands; its
secondary materials fade out before the band edge.

### 4. Transition-band algorithm

The bake works in climate space and writes only four IDs and four weights per
texel. For a boundary at `b` with half-width `w`:

1. In a region, `d` is the distance to the nearest boundary. Materials not in
   that boundary's transition palette are multiplied by
   `smoothstep(w, w + fade, d)`. At the band edge (`d = w`) they are zero;
   inside the region they reach full weight. Materials in the transition
   palette keep full weight.
2. At the band edge, the region palette is replaced by the transition palette.
   Because non-band materials are zero, the ID change is invisible. The band's
   weights at its left edge are the left region's weights restricted to the
   band IDs, and at its right edge the right region's restricted weights.
3. Inside the band, progress `p ∈ [0,1]` is smoothed and the two restricted
   weight vectors are linearly blended. IDs stay equal to the authored band
   palette for the whole band.
4. The result is normalized and quantized to four bytes summing to 255, as in
   the existing stack bake.

This satisfies the spec's stable-band requirement without an eight-slot stack,
a second texture pair or TAA. The authored palettes make it work: the primary
material of each region is in both adjacent bands, and the secondary materials
are the ones that fade.

The macro albedo is sampled from the same function at 1024² and uses the
weighted average colors of the final four IDs. It therefore changes color at
biome scale, not just at material scale.

`biome-report.json` records region coverage, per-slot weight means/ranges and
per-band edge continuity. The bake and validator share the same pure functions,
so `--check-materials` can rebake into a temporary directory and compare hashes.

### 5. Manifest and runtime compatibility

The material block gains optional `palettes` and `transitions` arrays. The
existing `slots` field stays for Jotunheimen and older manifests; if
`palettes` is absent, validation keeps the current fixed-slot behavior. The
runtime loader only needs `slots` for its legacy `slotIndices` value; the
shader reads IDs per texel and does not care which palette produced them.

The pre-baked manifest gains an optional `biomes` block:

```json
"biomes": {
  "map": "biome-map.png",
  "mapSize": 1024,
  "encoding": "rgba8-region-transition-progress-climate",
  "regions": [
    { "id": "arctic", "label": "Arctic", "center": [0, -6400], "color": [0.86, 0.9, 0.94] }
  ],
  "transitions": [
    { "from": "arctic", "to": "tundra", "width": 512 }
  ]
}
```

The page uses `regions` for the legend and jump buttons; the map/report are for
QA. `source.type` gains `"synthetic"` with the generator seed/version. Existing
version-2 manifests without these fields remain valid.

### 6. Shared pre-baked page

Move the boot/render loop, QA hooks and material loading from
`src/dem/main.ts` into `src/prebaked/app.ts`. `src/dem/main.ts` and the new
`src/biome/main.ts` become thin entry points that pass a manifest path, QA
global name and initial flight pose. `biome.html` reuses the same panel markup
and `src/dem/dem.css`, with a small `src/biome/biome.css` for the legend.

This keeps one code path for tile streaming, floating origin, material load
failure, auto-cruise and QA. `window.__dem` and `window.__biome` stay separate
so the existing Jotunheimen driver is unaffected.

### 7. Per-material debug view

Add a `uMaterialDebugColors[24]` uniform filled from the packed library's
`averageColor`. In debug mode, sample the stack IDs/weights and output
`Σ weight * debugColor[id]` instead of the hardcoded four-role colors. This
requires no extra material texture fetch and keeps the debug path read-only.
The Jotunheimen debug view changes from four role colors to material colors;
its existing `std > 12` assertion still applies.

### 8. Verification

Dataset checks extend `tools/dem/validate.ts` with optional palette support and
add `tools/biome/validate.ts` for biome coverage and transition continuity.
`npm run test:biome` runs synthetic climate/transition checks and validates the
checked-in dataset without network access. CI adds it next to `test:dem` and
`test:materials`.

The headless driver `tools/screenshot-biome.ts` warps to each manifest region,
captures the north→south traversal, transition close-ups and the material
on/off/debug set, then `tools/analyze-biome.ts` asserts no errors, non-flat
terrain, pairwise-distinct biome means, transition variation, material A/B
difference, debug variation and zero magenta in the crack shot. SwiftShader is
still a pipeline check, not a performance measurement.

### 9. Local material assets

The bake reads `public/materials/manifest.json` and the packed PNGs only. It
does not call Poly Haven. If a palette references a missing material, the bake
fails with instructions to run `npm run bake:materials`; that flow uses the
existing `.cache/materials/` source cache and checks the packed output in.
The page's only material request is to the checked-in library.

## Risks / Trade-offs

- **Four-slot transitions drop secondary materials near boundaries.**
  Mitigation: author palettes so the primary material survives both adjacent
  bands, fade secondary materials over 400–700 m, and verify transition
  close-ups. An eight-slot stack was rejected because it doubles texture
  fetches and changes the proven stack format.
- **A banded world can look artificially striped.** Mitigation: warp the
  climate coordinate, vary moisture/altitude inside each band, and keep the
  boundary noise wavelength large compared with a band.
- **The 15 m mesh is coarser than Jotunheimen.** Mitigation: 7.5 m normal
  texels and the material normal maps carry the close detail; the page is
  tuned for landscape-scale traversal, not survey comparison.
- **Refactoring the pre-baked page can regress `dem.html`.** Mitigation: keep
  the manifest/QA contract identical, run the existing DEM checks and a
  Jotunheimen smoke capture after the move.
- **The check-in grows by ~25 MB.** Mitigation: stop at 15.36 km, 5 LODs and
  2× normals; no per-LOD stack tiles. The existing ~34 MB material library is
  reused.
- **Software WebGL is slow with the material shader.** Mitigation: the visual
  loop is manual, not CI; use the verification host and treat SwiftShader as a
  pipeline check only.

## Migration Plan

No data migration. Existing manifests remain loadable because every new field
is optional. The new dataset lives beside `public/data/jotunheimen/`; the new
page is additive. Rollback is deleting the biome page, dataset, scripts and
manifest extensions; `dem.html` and `infinite.html` do not depend on them.

The `terrain-materials` delta from `add-multi-material-terrain` is still
unarchived. Sync/archive that change before archiving this one so the main
spec history has the material contract this capability builds on.
