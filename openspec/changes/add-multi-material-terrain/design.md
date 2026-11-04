# Design

## Context

See `proposal.md` for motivation and `specs/terrain-materials/spec.md` for the
behavior contract.

The shared renderer already has the seams this change needs:

- `src/terrain/shaders.ts` samples the height array in the vertex shader and
  the normal array in the fragment shader. Normals are object-space
  (`R = N.x`, `G = N.z`, `B = N.y`), decoded without a TBN, and the recent
  detail layer already composes a tiling normal in slope space:
  `s = sBase + sDetail * strength * fade`.
- `src/terrain/tile-cache.ts` streams height and normal tiles per LOD through
  a toroidal cache. The normal atlas is at the 2048² ceiling with no mips, so
  material textures must not live there.
- `src/dem/prebaked-source.ts` reads a manifest-driven dataset. The DEM page
  derives its config from the manifest and uses a 5×5 cache; the Jotunheimen
  window is 30.72 km at 10 m spacing, 6 LODs, 2× normal scale.
- The detail texture is a standalone, mipmapped `Texture`; that is the proven
  pattern for material textures.
- Floating origins change `vWorldPos` by a constant; world-locked UVs need an
  offset computed from the absolute render origin, not the phase-wrapped
  `uRenderOrigin` used by the tile cache.
- The QA loop compares screenshot pairs and existing baselines; a material
  change is only accepted after the headless pass.

This change deliberately uses a **whole-window material stack** rather than a
third streamed tile payload. The Jotunheimen window is finite and 2048² over
30.72 km is ~15 m/texel, which is enough for material boundaries because the
material textures carry the high-frequency detail. Per-LOD stack tiles are
deferred to the synthetic-world and streaming changes, where the world is
larger and the extra plumbing is justified.

## Goals / Non-Goals

**Goals:**

- Prove the 24-material cap, the packed two-array library, the four-ID/four-
  weight stack, height blending, slope-space normal composition and
  steepness-driven rock on a real pre-baked dataset.
- Keep the existing detail layer and the infinite-page fallback rendering
  unchanged when materials are not configured.
- Produce a checked-in material library and Jotunheimen stack that the
  synthetic-world change can reuse without changing the shader contract.
- Keep the visual result reviewable: swatches, material-off baseline,
  boundary, cliff, distance and debug shots.

**Non-Goals:**

- Generating a synthetic multi-biome world. This change uses Jotunheimen's
  single alpine/boreal biome and a fixed four-material palette.
- Per-LOD material stack tiles, material virtualization or a texture atlas.
- Real landcover data, water, full PBR (metalness/AO map pipeline), or
  triplanar projection for every material.
- Porting the material stack to `infinite.html`; it keeps the fallback.
- Changing the height/normal tile format, the clipmap topology or the
  floating-origin rebase step.

## Decisions

### 1. Whole-window stack map, not per-LOD stack tiles

The DEM stack is a global 2048² pair covering the 30.72 km window:

```text
stack-ids.png      2048^2 RGBA8   4 material IDs per texel, nearest, no mips
stack-weights.png  2048^2 RGBA8   4 normalized weights, linear, mips
macro-albedo.png   1024^2 RGB8    low-frequency far color, sRGB, mips
```

The shader samples it in world space:

```text
uv = vWorldPos.xz / stackExtent + 0.5 + uStackUvOffset
uStackUvOffset = absoluteRenderOrigin.xz / stackExtent
```

`vWorldPos` is render-space, so adding the absolute render-origin offset makes
the sample continuous across floating-origin rebases. The stack is clamped, not
repeated. The stack is not tied to the clipmap LOD, so there is no cross-LOD ID
blend and no third atlas/upload path.

**Alternatives considered:** per-LOD stack tiles (resolution-matched and
scalable, but a third atlas, a new `GeneratedTile` payload and cross-LOD ID
handling for a 15 m/texel boundary that the material textures already mask);
a 4096² stack (4× memory and dataset size for boundaries that are low-
frequency); procedural weights in the shader (not a pre-calculated world, and
the steepness/aspect/curvature rules belong in the bake).

### 2. Fixed four-material palette for Jotunheimen

The first change uses four slots for the whole window:

| Slot | Material | Role | Projection |
|---|---|---|---|
| 0 | `rock_face_03` | cliff rock | triplanar |
| 1 | `gravelly_sand` | scree / talus | planar |
| 2 | `snow_02` | snow | planar |
| 3 | `sparse_grass` | alpine grass / heath | planar |

The IDs are constant across the window; only the weights vary. This satisfies
the stable-transition requirement trivially (the ID set never changes while a
weight is non-zero) and keeps the first bake simple. The 20-material library is
still loaded and validated; the remaining materials are exercised by the
synthetic-world change.

The bake derives weights from normalized height, slope, aspect, curvature and
a seeded low-frequency noise:

```text
slope    = 1 - N.y
rockW    = smoothstep(0.45, 0.75, slope) * (0.75 + 0.25 * ridgeNoise)
screeW   = smoothstep(0.28, 0.50, slope) * (1 - rockW) * bandNoise
snowW    = smoothstep(snowStart, snowStart + 0.14, h + 0.08 * h)
           * (1 - steepSnowLoss) * northFacing
grassW   = max(0, 1 - rockW - screeW - snowW) * lowlandBand
normalize(rockW, screeW, snowW, grassW)
```

`northFacing` uses `-N.z` (the local frame is x=east, z=south); curvature
(Laplacian of the height grid) boosts rock on ridges and snow/grass in
concavities. The exact thresholds are tuned against the cliff and distance
shots and recorded in `docs/MATERIALS.md`.

**Alternatives considered:** a multi-palette bake immediately (more faithful
to the final world, but it needs the transition-band algorithm and a synthetic
biome map that this change deliberately excludes); two 4-slot stacks for eight
Jotunheimen materials (more samples and memory for a single-biome demo); an
ID-only map with two weights (pairwise, but loses the snow/scree/grass
transition quality).

### 3. RG slope material normals, not RGB object-space normals

The material normal array stores:

```text
RG = object-space slope in the planar top frame, encoded with a per-material
     slopeScale:  s = (rg * 2 - 1) * slopeScale
B  = roughness
A  = ambient occlusion
```

The base terrain atlas keeps its RGB object-space encoding. Material slopes
compose with the base slope:

```text
sTotal = sBase * uNormalStrength
       + sum(w_i * s_i * uMaterialNormalStrength[i])
       + sDetail * uDetailStrength * detailFade
N = normalize(sTotal.x, 1, sTotal.y)
```

Why not RGB normals: the rock material is triplanar, and an RGB normal map is
tied to one projection frame. RG slopes are projection-agnostic, mips average
gradients correctly, and the shader already thinks in slopes. The cost is a
per-material `slopeScale` to avoid clipping steep gradients, recorded in the
material manifest.

The pack tool converts Poly Haven's tangent-space `nor_gl`/`nor_dx` maps to
RG slopes once. The repo's `flipY = false`, `V = +z` convention is green-down
in image space, so the pack tool must choose the matching source convention
(likely `nor_dx`) or flip G; the low-sun orientation shot is the gate.

### 4. Material library packing and Poly Haven pipeline

`public/materials/manifest.json` is the checked-in library. Each entry holds:

```text
id, name, source (Poly Haven id/url/maps/resolution), license, hashes
albedoHeight  -> 512^2 RGBA8  (RGB sRGB albedo, A linear height)
slopeRough    -> 512^2 RGBA8  (RG slope, B roughness, A AO)
tileMeters    -> Poly Haven dimensions / 1000
slopeScale, normalStrength, roughness, specular, projection
averageColor  -> used by the macro bake
```

`tools/fetch-materials.ts` reads a curated 20-material manifest, calls
`https://api.polyhaven.com/files/{id}` with a unique `User-Agent`, downloads
the selected maps, verifies sizes/MD5, converts normals to RG slopes, resizes
to 512² and packs the two PNGs. `sharp` is a devDependency for the offline
tool; the runtime and CI build do not need it because the packed assets are
checked in. The tool is idempotent and records source hashes so stale packs are
detectable.

The library is loaded into two `DataArrayTexture`s (24 layers max), with
`RepeatWrapping`, `LinearMipmapLinearFilter`, `anisotropy = min(8, max)`,
`flipY = false`. Albedo is `SRGBColorSpace`; slope/rough is `NoColorSpace`.
`npm run test:materials` validates the cap, dimensions, channels, tile sizes,
hashes and average colors.

Poly Haven assets are CC0. The fetch tool's live API calls require a unique
User-Agent; the README gets a Poly Haven credit whether or not the live API is
used. No source JPEGs/PNGs are checked in, only the packed 512² outputs.

### 5. Triplanar projection for rock only

Planar world-XZ is exact for heightfield detail but stretches 2× at 60° and
5.8× at 80°. That is acceptable for grass, snow and scree; it is not acceptable
for a cliff rock coating. The rock material uses triplanar sampling of albedo,
height and slope:

```text
weights = pow(abs(Nbase), vec3(4)); weights /= sum(weights)
top   (x,z):  sWorld = vec2(s.x, s.y)        normal = (s.x, 1, s.y)
side  (x,y):  sWorld = vec2(s.x, s.y)        normal = (s.x, s.y, 1)
side  (z,y):  sWorld = vec2(s.y, s.x)        normal = (1, s.y, s.x)
```

The per-material `projection` flag selects this path. Because most fragments
have one or two active materials, the extra samples are paid only where rock
is actually present. The branch is inside the active-material loop and is
expected to be coherent over cliff regions.

**Alternatives considered:** planar for everything (cheapest, but the cliff
shot fails the visual goal); slope-blended two-way projection (two samples,
but the side-axis choice can pop at 45°); triplanar for every material (3×
samples on grass/snow for no visible gain).

### 6. Height blending and macro color

The albedo alpha is a per-material height. After the stack weights are
normalized:

```text
w_i' = max(w_i + (h_i - 0.5) * uHeightBlend, 0)
w_i' /= sum(w_i')
```

This makes boundaries follow the material relief instead of a linear fade.
`uHeightBlend` is a global control (default modest; QA exposes it).

The macro map is a 1024² world-locked albedo built from the material average
colors and a low-frequency noise/curvature term. Near field:

```text
albedo = blendedMaterialAlbedo * (0.85 + 0.30 * macroLuma)
```

Far field, beyond the material fade:

```text
albedo = macroAlbedo
```

The blend between them is distance-based. This hides texture tiling at range
and keeps the far rings cheap. The synthetic-world change can replace the baked
macro colors with aerial textures without changing the shader contract.

### 7. Shader composition and fallback

When a material library and stack are configured, the fragment shader:

1. Samples the base normal and the detail normal exactly as today.
2. Computes `Nbase` from the base slope; this is the normal for masks.
3. Samples the stack IDs/weights, loops the four slots, early-outs on zero
   weights, samples albedo/height and slope/rough/ao, and height-blends.
4. Builds `sTotal` from base + material slopes + detail slope; `N` is used for
   lighting and specular only.
5. Blends to the macro albedo with distance and applies fog/skirt as today.

When `uMaterialCount == 0` or the stack is absent, the shader runs the current
palette path. The infinite page therefore renders exactly as before. A missing
material texture or stack surfaces a toast and disables the material path
rather than rendering black.

Per-material parameters are uploaded as uniform arrays (24 max):

```text
vec4 A = (tileMeters, slopeScale, normalStrength, roughness)
vec4 B = (specular, projection, aoStrength, reserved)
```

The material count is bounded by 24; the shader loop is over `uMaterialCount`,
not a compile-time unroll. The stack slots are four; the library can hold 24.

### 8. Dataset manifest and validation

The DEM manifest version bumps to 2 and gains:

```json
"materials": {
  "library": "materials/manifest.json",
  "slots": ["rock_face_03", "gravelly_sand", "snow_02", "sparse_grass"],
  "stack": {
    "ids": "stack-ids.png",
    "weights": "stack-weights.png",
    "size": 2048,
    "extent": 30720,
    "encoding": "rgba8-ids-weights"
  },
  "macro": "macro-albedo.png",
  "macroSize": 1024,
  "bakeVersion": 1,
  "seed": 20260217
}
```

The bake samples the existing DEM grid at the stack resolution (15 m),
computes slope/aspect/curvature, evaluates the four-slot weights, quantizes the
IDs and weights, writes the PNGs, and updates the manifest. It is deterministic
for the recorded seed. The validator checks file presence, image dimensions,
ID range, weight normalization, slot IDs existing in the library, and the
manifest/stack agreement. `npm run test:dem` becomes the dataset gate.

The stack is baked from the existing 10 m grid, not from the 64² height tiles,
so it is independent of the clipmap tiling and can be inspected as a single
image. The normal tiles and height tiles are unchanged.

### 9. QA and debug

Add a material mode control with `on`, `off` and `debug`. The debug view colors
the dominant material or the four weights; the swatch page (`materials.html`)
shows every packed material on a quad for orientation and color review.

The DEM QA set adds:

- material on/off at the same pose (baseline deltas),
- a boundary close-up,
- a cliff close-up (triplanar and steepness check),
- a distance view (macro/fade check),
- a material debug view,
- a swatch capture.

The analyzer compares color variance/high-frequency energy in the near field
between on and off, checks the cliff region is rock-dominant, checks the debug
image has distinct rock/snow/vegetation colors, and keeps every existing check.
`02-normal0` must also zero material normals or use the material-off path, or
it is no longer a flat baseline.

## Risks / Trade-offs

- **15 m/texel stack boundaries look blocky** → smooth weights, macro color,
  and the material textures mask the boundary; if the boundary shot fails,
  move to 4096² (4× memory) or per-LOD tiles in the synthetic-world change.
- **Fixed four-material palette loses Jotunheimen variety** → the first change
  proves the pipeline with the dominant alpine materials; the synthetic world
  change adds multi-palette transitions and the full 20-material set.
- **Triplanar normal mapping is error-prone** → RG slopes make the frame
  mapping explicit; the cliff and low-sun shots gate orientation. Fall back to
  albedo-only triplanar if the normal path is unstable.
- **Poly Haven normal convention mismatch** → the pack tool records the source
  convention and the low-sun orientation shot verifies it; a green flip is a
  one-line pack change.
- **Repo size** → 512² packed PNGs (~10–15 MB) and a 2048² stack + 1024² macro
  (~30–40 MB) are checked in; source downloads are not. The existing dataset is
  ~101 MB, so this is a meaningful but bounded increase.
- **`sharp` native dependency** → devDependency only; packed assets are
  checked in, so `npm run build`, CI and the runtime never load it.
- **Texture repetition** → physical tile sizes, macro color, distance fade;
  rotated/stochastic scales are a follow-up.
- **Height blend over-sharpens** → `uHeightBlend` control and QA; default
  modest.
- **Memory** → 24 materials × 512² × two arrays ≈ 64 MiB, plus stack/macro
  ~45 MiB. The infinite page keeps its existing 160 MiB normal atlas but does
  not load materials in this change. The DEM page has headroom.
- **Shader complexity** → the material loop and triplanar branch add
  per-fragment cost; measure on a real GPU, not only SwiftShader. The fallback
  path is a single uniform check.
- **Dataset versioning** → the manifest version bump is additive; older
  manifests without `materials` load the fallback. Rollback is removing the
  material block and the page's material options.

## Migration Plan

1. Add the material library manifest, fetch/pack tool and checked-in 20-material
   pack; `test:materials` validates it.
2. Add the material stack bake + macro bake to the DEM pipeline; bump the
   manifest and validator; `test:dem` covers the dataset.
3. Add the renderer material library/stack loaders and the shader composition
   path; the DEM page opts in, the infinite page stays on the fallback.
4. Add the UI toggles, debug view and swatch page; run the headless QA loop and
   record reference values in `docs/VERIFICATION.md` and `docs/MATERIALS.md`.
5. Keep the material block optional. Rollback: remove `materials` from the DEM
   manifest and the page options; the shader returns to the existing palette.

## Open Questions

- Exact Jotunheimen palette weights and thresholds (rock/scree/snow/grass) are
  tuned against the cliff and distance shots; the slot set is fixed by the
  design.
- Whether the packed library should use 512² uniformly or 1024² for the four
  Jotunheimen hero materials. 512² is the default; the memory table leaves
  room for a later split.
- Whether triplanar rock normals are stable enough at 512²; the fallback is
  albedo-only triplanar with planar slopes.
- The final macro-map blend curve and material fade distances are visual
  tuning, not architectural choices.
