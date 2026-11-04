# Infinite Terrain PoC — Concept & Locked Decisions

Status: **implemented and verified** (see [Implementation notes](#13-implementation-notes)).

This document describes the repo's clipmap terrain PoC: a fly-over of a
practically infinite terrain built from clipmap meshes, with height and
normal maps sampled from a dynamically updated GPU texture buffer. It uses
the heightfield → Sobel → object-space normal-map workflow described here.

## 1. Goal

Render a terrain that never runs out, at a stable frame rate, without ever
building a full terrain mesh on the CPU.

The claim to demonstrate:

> A small set of camera-centred clipmap rings (about 165k triangles total)
> can render an effectively infinite landscape if heights are displaced in
> the vertex shader from a tile cache and the lighting normals come from
> per-pixel normal maps baked from the same float heightfield.

Non-goals:

- A production GIS viewer or a real-Earth streaming service.
- Water, vegetation, physics, collision, or shadow maps.
- An A/B vertex-normal comparison. This page always lights from the normal
  map; there is no vertex-normal fallback mode.

## 2. Locked decisions

| Area | Decision |
|---|---|
| Page location | Root `infinite.html` in this repo/site |
| Height source | Procedural infinite only (seeded multi-noise composition), no network |
| Tile generation | Web Worker, CPU float heights + Sobel normals, sub-texture uploads |
| LOD seams | Per-LOD origin snapping + one-cell pad, shader clip to the parent square, coarse-mesh morph band, skirt at the final horizon edge |
| Flight UX | Free-fly (pointer lock + WASD) with an optional auto-cruise toggle |
| Normal maps | Always on; no vertex-normal A/B mode on this page |
| Quality target | Fine maps, 2048-safe cache: `S0 = 2 m`, 10 LODs, 8× normals (0.25 m texels), ~165k triangles, ~49 km view |

The constants are configurable; the mobile-friendly values are the defaults.

## 3. Architecture at a glance

```
  procedural height function (CPU worker)
            │
            ├── 64×64 height tiles ──┐
            └── 512×512 normal tiles ┤
                                     ▼
                    toroidal tile cache per LOD
            (height 256², normal 2048² texels/LOD)
                                     │  texSubImage3D
                                     ▼
              DataArrayTexture  [height R16F | normal RGBA8 @ 8x]
                                     │
             ┌───────────────────────┴───────────────────────┐
             │ vertex shader                                 │ fragment shader
             │ height = texture(array, uv, level)             │ normal = texture(array, uv, level)
             │ displace clipmap vertex                        │ shade with world-space normal
             └───────────────────────┬───────────────────────┘
                                     ▼
                10 camera-centred clipmap rings + centre block
```

## 4. Clipmap geometry

### 4.1 Constants

| Symbol | Value | Meaning |
|---|---|---|
| `S0` | 2 m | finest vertex spacing |
| `C` | 24 cells | centre-block half-size and ring width |
| `LEVELS` | 10 | rings at LOD 0 … 9 |
| `T` | 64 cells | height tile size in samples/cells |
| `K` | 4 | tile-cache side in tiles (visible ring + prefetch margin) |

The centre block is `2C × 2C = 48 × 48` cells, i.e. 96 m across at
`S0 = 2 m`. Its half-extent is `C·S0 = 48 m`.

Ring `L` has:

- vertex spacing `S_L = S0 · 2^L`
- inner half-extent `C · S_L`
- outer half-extent `2C · S_L`
- outer half-extent in metres `2C · S0 · 2^L`

With the values above the last ring reaches `2·24·2·2^9 = 49,152 m`
(49 km). Fog is tuned so the last ring is already fully faded before its
outer edge, which hides the end of the world.

Triangle budget (`C = 24`, `LEVELS = 10`):

| Part | Triangles |
|---|---:|
| centre block (`2C` cells square) | ≈ 4.6k |
| level-0 ring (`24² … 48²` cells) | ≈ 13.8k |
| 9 padded rings (`46² … 96²` cells) | ≈ 127.8k |
| 10 skirts (collapsed except the last) | ≈ 15.4k |
| **terrain total** | **≈ 162k** |
| + sky | ≈ 165k rendered |

That is still modest: the detail comes from the normal map, not from the
triangle count. The near field uses 2 m vertices, while the normal map
supplies **0.25 m** texels — an 8× resolution ratio.

### 4.2 Why nested rings with 2:1 steps

Ring `L` covers `[C·S_L, 2C·S_L]` with vertex spacing `S_L = S0·2^L`; the
next ring's spacing is `2·S_L`, so the ring widths and the LOD steps line
up. Since every level has its own snapped origin it cannot share vertex
positions with its neighbour, which is what sections 4.3 and 4.4 solve.

### 4.3 Per-level snapping (the anti-swimming fix)

A single shared origin snapped to the *finest* spacing — the obvious
approach, and the one this PoC shipped first — makes the coarse rings
swim. A 2 m camera step is a whole cell for LOD 0 but `1/2^L` of a cell for
ring `L`: every coarse vertex re-samples its height tile between texel
centres and the surface visibly deforms as the camera moves.

Instead each level snaps to **its own** spacing (`src/infinite/origins.js`):

```
origin_L = round(camera.xz / S_L) * S_L
```

Between snaps a ring is rigid: same vertex positions, same texels, no
deformation. Coarse rings now move `2^L` times less often than the finest
one (LOD 9 snaps once per kilometre of travel). Two origins are multiples of
`S_L/2` and each is within `S_L/2` of the camera, so the offset between
neighbours is always **0 or ±half a coarse cell** — the bound the next
section relies on.

`RENDER_ORIGIN_STEP` (the floating-origin granularity) is a multiple of
every `S_L`, which keeps every vertex on an exact texel centre instead of a
static sub-texel bias.

### 4.4 Watertight boundaries without stitches

Per-level snapping gives up the shared boundary, so the old zero-width 2:1
stitch strips no longer apply. Three pieces replace them:

1. **Pad.** Rings above level 0 are built one cell wider than their nominal
   hole (`C-1` instead of `C`), guaranteeing coverage even when the inner
   ring sits half a coarse cell off-centre. The level-0 ring is the
   exception: it shares the centre block's lattice and origin, so it abuts
   it exactly (`C`).
2. **Clip.** The fragment shader discards each ring inside its parent's
   outer square, so exactly one level covers any point and the coarse ring
   cannot draw over the fine one. The cut is pulled inward by a slack that
   grows with the pixel footprint so MSAA samples on the shared edge are
   always covered.
3. **Morph.** The outer `morphCells` cells of each ring blend into the next
   coarse level, reaching 100 % exactly at the boundary. The coarse height
   is reconstructed through the coarse *mesh's* triangulation, not a
   bilinear fetch: with the half-cell origin offset a bilinear fetch
   disagrees with the coarse triangles by up to the LOD error, which at a
   grazing angle opens a sliver of background at the boundary.

The vertical skirt remains only on the last ring, to hide the horizon edge.

## 5. Texture buffer / tile cache

### 5.1 Storage layout

For each LOD `L`:

- height layer: `R16F`, normalized height in `[0,1]` (core-filterable in
  WebGL2; the half-float step is well below the 2 m vertex spacing)
- normal layer: `RGBA8`, object-space normal encoded
  `R=N.x`, `G=N.z`, `B=N.y` (object-space, no TBN)

Both are WebGL2 `DataArrayTexture`s with `LEVELS` layers:

- height: `256 × 256` texels per layer (`4 × 4` tiles of `64 × 64`) ≈ 1 MiB
- normal: `2048 × 2048` texels per layer (`4 × 4` tiles of `512 × 512`) ≈ 128 MiB

The normal map is baked at **8× the height-tile resolution**, so it carries
0.25 m detail against the 2 m near-field vertex spacing. Sampling uses
`sampler2DArray` in both the vertex and fragment shaders. `RepeatWrapping` +
linear filtering gives free bilinear interpolation across tile and cache
boundaries.

The texture buffer is updated with direct `texSubImage3D` calls rather than
`copyTextureToTexture`: the latter proved unreliable for `R16F` array layers
on the software WebGL QA renderer.

### 5.2 Toroidal addressing

At LOD `L` the tile world size is `T·S_L`. A world position maps to:

```
tile      = floor(world / (T·S_L))
slot      = tile mod K
tileUV    = fract(world / (T·S_L))
textureUV = (slot + tileUV + 0.5/T) / K
```

The `+0.5/T` is the half-texel offset that makes a vertex exactly on a
height sample read the texel centre rather than its edge.

The cache holds the `4×4` tiles at `camTile − 2 … camTile + 1`, where
`camTile = floor(cameraWorld / (T·S_L))`. The visible ring needs `3×3`; the
fourth row/column is prefetch margin for fast flight. Two workers make the
tile-crossing latency comfortable at the demo's flight speeds.

The shader does not use absolute world coordinates directly. A floating
origin (`uRenderOrigin`) plus a per-level tile phase keeps precision stable:

```
phase = mod(uRenderOrigin, K·T·S_L) / (T·S_L)
t     = phase + localWorld / (T·S_L)
uv    = (mod(floor(t), K) + fract(t) + 0.5/T) / K
```

This is equivalent to the formula above but avoids large float values.

### 5.3 Tile contents

A tile at LOD `L` contains:

- 64×64 height samples at `S_L` spacing;
- 512×512 normals at `S_L/8` spacing, baked from a **514×514** float height
  patch (one-sample halo), so Sobel normals at tile edges agree with the
  neighbouring tile;
- height in normalized `[0,1]`, normals quantised to RGB8 only after
  computing the unit normal from float heights.

At LOD `L` the Sobel scale is `heightScale / (8·(S_L/8))`. Fine levels
recover fine shading detail; coarse levels are naturally band-limited, which
is desirable for distance.

### 5.4 Upload path

1. Worker returns `Float32Array` heights and `Uint8Array` normals.
2. Main thread converts heights to half-floats.
3. Direct `gl.texSubImage3D` writes the height tile at
   `(slotX·64, slotY·64, level)` and the normal tile at
   `(slotX·512, slotY·512, level)`.
4. Slot bookkeeping records which world tile currently occupies each slot.

No GPU render-to-texture is required. CPU generation uses the float Sobel
bake and keeps the pipeline deterministic.

### 5.5 On-demand generation

A pool of up to two Web Workers owns the procedural height function and tile
generation (the 8× normal bake is ~7× the work of the original 2× version).
The main thread requests missing tiles with a priority:

1. tiles visible in the current rings;
2. the prefetch row/column;
3. everything else.

Results for tiles that are no longer wanted are discarded. Requests are
deduplicated. The worker returns transferable buffers, so there is no
structured-clone copy of the tile data.

At boot, the visible tiles are generated behind the loading overlay. Runtime
generation happens only when the camera crosses a tile boundary; at typical
flight speeds the near LOD updates every few seconds and far LODs almost
never.

## 6. Shaders and normal maps

### 6.1 Vertex shader

Per vertex:

```
spacing = S0 * exp2(level)
local   = levelOrigin + aCell * spacing          // render space
tile    = mod(phase + local / tileWorld, K)
uv      = (tile + fract(...) + 0.5/T) / K
hN      = texture(uHeightArray, vec3(uv, level)).r

morph   = smoothstep(2C - morphCells, 2C, max(|cell.x|, |cell.z|))
if morph > 0:
    hN  = mix(hN, coarseMeshHeight(local, coarseOrigin, level + 1), morph)
```

`coarseMeshHeight()` fetches the four corners of the coarser cell and
interpolates along the same diagonal `buildRingGeometry` uses, so the
morphed fine edge coincides with the coarse mesh instead of merely the
bilinear field. One or five height fetches per vertex, all from the same
array texture, and the page still lights entirely from the normal map.

The fragment shader also clips each ring to its parent's square (section
4.4) and cross-fades the normal layers over the same morph band.

### 6.2 Fragment shader

```
nm    = texture(uNormalArray, vec3(uv, level)).xyz * 2 - 1
mapN  = normalize(vec3(nm.x * strength, nm.z, nm.y * strength))
```

Lighting, albedo bands, specular, fog and sky follow the shared terrain
palette. Slope-based rock/grass/snow assignment uses the normal-map normal,
so normal-map detail also drives material boundaries.

LOD normal seam: the normal map's resolution changes at ring boundaries. A
narrow cross-fade band in the fragment shader samples both layer `L` and
`L+1` and blends by distance to the ring edge. All levels live in the same
array texture, so this is cheap. The blend is tuned or removed after visual
tests.

### 6.3 Height/normal encoding invariants

The encoding invariants are:

- heightfield row `j` maps to `+z`, column `i` to `+x`;
- normal map is object-space, `R=N.x`, `G=N.z`, `B=N.y`, no TBN;
- normals are baked from float heights, never from an 8-bit heightmap;
- `uNormalStrength` scales decoded tangent components and renormalises;
- custom shaders must not re-include `*_pars_fragment` chunks.

## 7. Flight, world coordinates and precision

- **Free-fly**: pointer lock mouse look, `WASD` horizontal movement, `Q/E`
  vertical, `Shift` boost, mouse wheel speed/altitude.
- **Terrain guard**: keep the camera at least ~25 m above the CPU-evaluated
  height at its position.
- **Auto-cruise**: optional toggle that flies a slow, scenic path while the
  user can still look around; click/press to take control.
- **Floating origin**: camera position is stored in doubles; the scene is
  rebased every ~15 km. The shader receives the render origin **modulo the
  largest tile-cache world size** (`PHASE_WRAP`), which preserves the
  toroidal slot phase for every LOD (all lower cache sizes divide it) while
  keeping the uniform small even after a 500 km flight.
- **Depth**: near ~2 m, far ~70 km; enable logarithmic depth if testing
  shows z-fighting.

## 8. UI and debug views

Controls panel:

- sun azimuth/elevation;
- normal strength;
- wireframe;
- "show LOD levels" (colour each ring);
- "show tile grid" (colour the world-space tile checkerboard);
- auto-cruise on/off;
- flight speed / reset;
- tile-cache debug: resident/prefetch tiles, queue depth.

Stats chip:

- fps, triangles, draw calls;
- camera altitude / speed / world coordinates;
- resident tiles, generated tiles, queued tiles;
- current LOD extents.

## 9. Verification plan

Before shipping, the page must pass a headless loop:

1. **Unit checks** (Node, no browser):
   - same world point sampled from adjacent tiles at the same LOD gives the
     same height;
   - same world point sampled from a fine and a coarse LOD gives the same
     height at the shared boundary vertices;
   - normal tiles at shared edges agree;
   - ring/centre boundary loops have identical positions;
   - transition-band triangle count and edge-manifold checks.
2. **Browser QA** (`chrome-headless-shell` + SwiftShader):
   - no console errors / page errors / failed requests;
   - boot completes and tiles are resident;
   - screenshots: default view, after `warpTo()` a new area, LOD debug,
     wireframe;
   - image statistics: terrain not blank, horizon present, no large black
     holes;
   - a "seam sweep": place the camera exactly over a LOD boundary and take
     screenshots with LOD colours on.
3. **Long-flight / precision test**: warp the camera to 25 km and 500 km
   from the origin; check tile phase, geometry stability and no visible
   swimming. The 500 km test exercises the `PHASE_WRAP` modulo path.

Headless SwiftShader is only a correctness check, not a performance
benchmark. Performance acceptance is measured on a real GPU (or reported as
draw calls/triangles/tile counts if no GPU is available).

## 10. Risks and mitigations

| Risk | Mitigation |
|---|---|
| `copyTextureToTexture` format/type mismatch on R16F array layers | Direct `texSubImage3D` uploads; verified zero upload errors on SwiftShader |
| Ring boundary shows a crack, or the coarse ring draws over the fine one | One-cell pad + fragment clip to the parent square + coarse-mesh morph; verified with a magenta-background crack test (`08-cracks`) |
| Visible LOD normal seam | Cross-fade band; test at ring boundaries |
| Tile generation hitch on tile crossings | Worker + prefetch margin + priority queue |
| Floating-origin / tile-phase drift after long flights | `PHASE_WRAP` modulo + warp tests at 25/500 km |
| Vite paths on GitHub Pages | Root `infinite.html`, relative `base: './'`, test the built site |
| Scope creep | Ship the flyover + normal-map proof first; defer water/vegetation/shadows |

## 11. Proposed milestones

1. **Spike**: prove array textures, float vertex fetch, and sub-texture
   uploads in headless WebGL2 with a tiny test scene.
2. **Terrain source**: infinite height function, tile generator, worker,
   unit tests.
3. **GPU cache**: array textures, toroidal slots, upload path, stats.
4. **Clipmap geometry**: centre block, padded rings, parent-square clip,
   morph band, outer skirt, LOD debug view.
5. **Shading and flight**: normal-map shading, fog/sky, free-fly controls,
   auto-cruise, floating origin.
6. **Polish and QA**: UI, loading, headless screenshots, docs, GitHub Pages
   build, deploy.

## 12. Implementation order

Start with the risky part, not the pretty part:

1. A minimal `infinite.html` that creates a `DataArrayTexture`, updates one
   tile via `texSubImage3D`, and displays it with a vertex texture fetch.
   Verify in headless WebGL2 and on the verification host.
2. Add the infinite height function and worker tile generation.
3. Add the tile cache and toroidal addressing.
4. Add the clipmap meshes, per-level snapping and the boundary clip/morph.
5. Add flight controls, UI, fog/sky.
6. Verify, document, build, deploy.

## 13. Implementation notes

The shipped defaults are:

| Setting | Value |
|---|---|
| base spacing | 2 m |
| centre/ring width | 24 cells |
| LODs | 10 (0…9), outer radius 49.152 km |
| tile size | 64 height samples; 512 normal texels (8×) |
| cache | 4×4 tiles per LOD (160 tiles when settled) |
| morph band | outer 3 cells of every ring |
| triangles | ≈ 165k including skirts and sky |
| draw calls | 4 (sky, centre, level-0 ring, rings 1…9) |
| height format | R16F |
| normal format | RGBA8, 8× resolution (0.25 m texels at LOD 0) |
| workers | up to 2 tile workers |

Verified on the headless SwiftShader host:

- boot: tiles stream in to 160 resident, zero upload errors, no console/page
  errors;
- 25 km and 500 km warps: 160 resident tiles after regeneration;
- 500 km: `PHASE_WRAP` keeps the shader origin bounded while the camera stays
  in small render-space coordinates;
- normal-map QA: high-frequency `hf = 4.29` vs `0.23` with flat normals
  (≈18.6× more shading detail) at 0.25 m normal texels against a 2 m mesh;
- per-level snap cadence: over 163 m of auto-cruise, LOD 0 snapped 46 times,
  LOD 1 41, LOD 2 22 … LOD 8/9 zero, and every origin stayed within
  `0.5 · S_L` of the camera — coarse rings are rigid, not swimming;
- crack test: sky hidden and clear colour set to magenta, zero magenta inside
  the terrain silhouette at 25 km and 500 km; a handful of sub-pixel blends
  remain at the extreme grazing horizon, below the 0.2 % analyzer budget.

Remaining honest limitations:

- The far rings are coarse (up to 1024 m vertex spacing at LOD 9);
  silhouettes and large-scale geometry are therefore smooth, even though the
  normal map adds detail.
- The last ring's edge is hidden by fog and a skirt, not by an actually
  infinite mesh; 49 km is the configured view distance.
- Normal maps are RGB8, so extreme grazing-angle lighting can still show
  quantisation/aliasing.
- Tile generation is CPU-bound in workers; a cold boot on a slow phone can
  take several seconds (the 8× normal bake is ~7× the original per-tile work,
  plus two extra LOD layers). The normal cache is ~128 MiB of GPU texture
  memory; the CPU-side allocation is freed after the initial upload.
