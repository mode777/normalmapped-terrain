# Terrain materials

The DEM terrain uses a checked-in library of 20 Poly Haven textures and a baked
four-slot material distribution. This is the first slice of the multi-biome
material plan: the synthetic biome world and the infinite adapter are follow-up
changes.

## Library

- **Source:** [Poly Haven](https://polyhaven.com/textures), CC0. The fetch tool
  sends the required unique User-Agent; the runtime never calls the live API.
- **Cap:** 24 materials. The checked-in set is 20; the loader rejects anything
  larger before allocating textures.
- **Pack:** `512 × 512` RGBA8 PNGs, two files per material:
  - `albedo-height.png`: RGB sRGB albedo, A normalized height (0.5 neutral).
  - `slope-rough.png`: RG normal-map slope (object-space, V = +z), B roughness,
    A ambient occlusion.
- **Layers:** two `DataArrayTexture`s, one layer per material, with mips and
  anisotropy. Albedo is sampled as sRGB; slope/rough/ao is linear.
- **Physical scale:** `tileMeters` is Poly Haven's `dimensions / 1000`.
  Each material also has a packed `textureScale` factor; the shader divides
  by `tileMeters * materialTextureScale * globalTextureScale`. The global
  texture scale is **32×** by default (panel slider 1–64×). Aerial materials
  use smaller per-material factors so they stay at a sensible macro scale
  while the close-up materials get the full 32×.

| Material | tileMeters | textureScale | effective at 32× |
|---|---:|---:|---:|
| `rocky_terrain_02` | 90 | 0.25 | 720 m |
| `aerial_grass_rock` | 15 | 0.5 | 240 m |
| `rock_face_03` | 2.7 | 1.0 | 86.4 m |
| `snow_02` | 2.0 | 1.0 | 64 m |
| `snow_field_aerial` | 80 | 0.25 | 640 m |
| `aerial_beach_01` | 30 | 0.25 | 240 m |

The other library materials default to `textureScale = 1`. Edit the values in
`tools/materials/polyhaven.json` and run `npm run bake:materials` to refresh
the packed manifest. The global panel slider still multiplies all materials.
- **Slope encoding:** the shader decodes `s = (rg * 2 - 1) * slopeScale`; the
  per-material `slopeScale` prevents clipping steep gradients. Poly Haven's
  `nor_dx` (green-down) is converted to the repo's V = +z frame during packing.
- **Size:** about 33.5 MiB packed. Source downloads live in the gitignored
  `.cache/materials/`.

The 20 materials cover arctic/alpine, tundra, boreal/temperate, tropical and
arid roles. The first Jotunheimen stack uses four of them: `rocky_terrain_02`
(low-steepness base), `rock_face_03` (steep cliff, triplanar), `snow_02`
(snow) and `aerial_grass_rock` (seeded random patches).

## Distribution stack

`public/data/jotunheimen/`:

```
stack-ids.png      2048^2 RGBA8   four library indices per texel
stack-weights.png  2048^2 RGBA8   four normalized weights (sum 255)
macro-albedo.png   1024^2 RGBA8   low-frequency far-field albedo
```

- **Extent:** 30,720 m, centred on the DEM local frame (15 m/texel for the
  stack, 30 m/texel for the macro).
- **IDs:** constant for this slice: library indices `3, 2, 0, 7` for
  rocky/cliff/snow/aerial-grass. A future multi-palette bake can vary them.
- **Weights:** the four bytes sum to 255. The shader normalizes after linear
  filtering and uses only slots above a small threshold.
- **Row order:** row 0 is north, +z is south; load with `flipY = false`, matching
  the height tiles.
- **Macro:** the weighted average of the palette's average colors with a
  low-frequency noise term. Beyond the material fade the shader uses it as the
  far-field albedo.

The bake derives weights from the 10 m L0 height grid:

- **Snow:** high normalized height (start 0.85, ~2125 m), with a sharp
  ~100 m elevation band, reduced on steep slopes, boosted on north-facing
  slopes (`-N.z`).
- **Grass / Aerial Grass Rock:** low, gentle, concave ground plus seeded
  ~4.2 km random patches over the low-steepness rocky areas.
- **Rocky Terrain 02:** the low/moderate-steepness base.
- **Rock Face 03:** the steep-face fraction of the rock remainder
  (`smoothstep(0.30, 0.60, slope)`). It deliberately no longer covers the
  broad low-slope terrain.

Convexity/concavity from the height-grid Laplacian and seeded low-frequency
value noise are secondary inputs. The current window's mean weights are
`0.794 / 0.010 / 0.008 / 0.189` (rocky/cliff/snow/grass); the stack has
non-degenerate ranges for all four.

## Shader composition

The stack is sampled in world space:

```text
uv = vWorldPos.xz / uStackExtent + 0.5 + uStackUvOffset
uStackUvOffset = absoluteRenderOrigin.xz / uStackExtent
```

`vWorldPos` is render-space; adding the absolute render-origin offset keeps the
distribution world-locked across floating-origin rebases. The stack is clamped,
not repeated.

For each active slot:

1. Sample the packed albedo/height and slope/rough/ao.
2. Bias the stack weight by the material height:
   `w' = max(w + (h - 0.5) * uMaterialHeightBlend, w * 0.05)`; renormalize.
3. Sample the material normal as an RG slope. Planar materials use the top
   frame; the rock material is triplanar (top, z-side, x-side) with weights
   from `pow(abs(Nbase), 4)`.
4. Convert the blended material normal to a horizontal slope contribution and
   add it to the base slope:
   `sTotal = sBase * uNormalStrength + Σ w' * slope_i * normalStrength_i + detail`.
5. Near-field albedo is the weighted material albedo times a macro-luma tint and
   AO; beyond `uMaterialFadeEnd` it is the macro albedo.

Material normal strength and detail strength are independent uniforms. Changing
either does not move the baked distribution. The material path is bypassed
when `uMaterialMode == 0` or no library/stack is configured; the old height/
slope palette is the fallback.

## Poly Haven pipeline

```bash
npm run bake:materials            # fetch/cache/pack all 20
npm run test:materials            # 24 cap, 512², hashes, metadata
node tools/fetch-materials.ts --check-manifest
node tools/fetch-materials.ts --only rock_face_03   # single-material iteration
```

`tools/materials/polyhaven.json` is the curated source list: id, role, biome,
tile metres, projection, shading parameters and map choices.
`tools/fetch-materials.ts` calls `https://api.polyhaven.com/files/{id}` with
`User-Agent: normalmapped-terrain/0.1`, verifies size/MD5, resizes to 512²,
converts `nor_dx` to RG slopes, packs the two PNGs and writes
`public/materials/manifest.json`. `sharp` is a devDependency only; the packed
assets are checked in, so the runtime and CI build do not need it.

The packed PNGs are what `materials.html` shows. That page is the asset-level
QA view: all 20 albedo/slope pairs are shaded from the packed slope map.

## Dataset bake

The full DEM bake writes the stack/macro after the height/normal tiles:

```bash
npm run bake:dem -- --config tools/dem/jotunheimen.json
```

When only the palette, snowline or noise changes, rebake from the checked-in L0
height tiles without the source GeoTIFF:

```bash
node tools/bake-dem.ts --config tools/dem/jotunheimen.json --materials-only
node tools/bake-dem.ts --config tools/dem/jotunheimen.json --check-materials
```

`--materials-only` reads the checked-in L0 tiles, rewrites the stack/macro and
updates the manifest's material block and hashes. `--check-materials` rebakes
into a temporary directory and compares hashes. `npm run test:dem` validates
the checked-in files (IDs, weight sums, ranges, dimensions and hashes) without
network access.

## Biome palettes

The synthetic biome world (`biome.html`, `public/data/biomes/`) reuses the same
20-material library and 24-layer texture arrays. Its stack is still four IDs +
four weights per texel, but the IDs now vary by region:

- six authored region palettes (arctic, tundra, boreal, temperate, arid,
  tropical), each four materials;
- five fixed four-material transition palettes, one per adjacent pair;
- `rock_face_03` in every region and band so cliffs stay rock everywhere.

The bake fades a region material that is not in the adjacent band to zero before
the band edge, then switches to the fixed band IDs and blends the two regions'
restricted weights. `npm run test:biome` checks every stack ID quartet against
the authored sets, re-samples the transition edges and verifies the stack,
macro, biome map and report hashes. See
[BIOME_WORLD.md](BIOME_WORLD.md) for the tables and algorithm.

The biome dataset is ~18.5 MB including height/normal tiles, a 2048² stack, a
1024² macro and a 1024² biome map. The runtime texture budget is the same order
as Jotunheimen (~90 MiB including the 20-layer arrays) because the stack/macro
dimensions did not change.

## Measured results and limitations

From the Nov 2026 headless pass after the per-material scale and
rocky/aerial-grass rebalance (SwiftShader, 1600×900):

- Material library: 20 layers, 512², two arrays; ~90.7 MiB of GPU texture
  including the 2048² stack and 1024² macro.
- Shader texture units: 8 of the device's 32; 4 draw calls; ~102k triangles at
  the default DEM pose.
- Jotunheimen material on/off: `hf 1.21 → 3.37`, mean `154.6 → 56.8`; the layer
  contributes both texture detail and color. Cliff `std=15.6`; distance
  `std=20.6`; per-material debug `std=17.1`; all 20 swatches load.
- Biome page material on/off: `hf 1.41 → 13.12`, mean `95.5 → 68.4`; distance
  `std=41.0`; debug `std=20.1`; 81 analyzer checks pass with no errors.
- The biome dataset is ~18.5 MB, 344 tiles, with a 2048² stack, 1024² macro and
  1024² biome map.
- SwiftShader runs the material shader at roughly **1 fps**. That is a
  software-rasterizer measurement, not a real-GPU frame time.

Limitations:

- Jotunheimen uses a fixed four-material palette; the synthetic biome page uses
  six palettes and five transition bands from the same library (17 of the 20
  materials are used). The infinite page still has no material adapter.
- The stacks are whole-window 2048² maps (Jotunheimen ~15 m/texel, biome
  ~7.5 m/texel); per-LOD stack tiles are deferred until the world grows past
  ~50 km.
- Only Rock Face 03 is triplanar. Rocky Terrain 02, snow and the Aerial Grass
  Rock mix stay planar; their stretch is acceptable at the current art scale.
- The macro albedo is a baked palette average, not an aerial-texture layer.
- No real landcover (AR50/N50) is used.
- Material textures are 512²; the packed library is ~33.5 MiB. A larger library
  or higher resolution needs a streaming/virtual-texture follow-up.
- The 20-material set is curated by eye; Poly Haven has no tundra/scree tags and
  its tropical ground coverage is the weakest part of the set.

## Follow-ups

1. `add-synthetic-biome-world` — implemented: six palettes, five transition
   bands, macro/aerial layer and the `biome.html` traversal page.
2. `add-infinite-material-adapter` — the infinite page generates the same stack.
3. `add-material-streaming` — per-LOD tiles or virtual texturing for larger
   worlds/libraries.
4. `add-real-landcover-materials` — optional AR50/N50 weights.
