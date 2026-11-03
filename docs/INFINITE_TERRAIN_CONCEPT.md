# Infinite Terrain PoC — Concept & Locked Decisions

Status: **implemented and verified** (see [Implementation notes](#13-implementation-notes)).

This document proposes a second PoC for this repo: a fly-over of a
practically infinite terrain built from clipmap meshes, with height and
normal maps sampled from a dynamically updated GPU texture buffer. It keeps
the previous PoC intact and reuses its heightfield → Sobel → object-space
normal-map workflow.

## 1. Goal

Render a terrain that never runs out, at a stable frame rate, without ever
building a full terrain mesh on the CPU.

The claim to demonstrate:

> A small set of camera-centred clipmap rings (about 114k triangles total)
> can render an effectively infinite landscape if heights are displaced in
> the vertex shader from a tile cache and the lighting normals come from
> per-pixel normal maps baked from the same float heightfield.

Non-goals:

- A production GIS viewer or a real-Earth streaming service.
- Water, vegetation, physics, collision, or shadow maps.
- Replacing the existing normal-map PoC. The new page is additive.
- An A/B vertex-normal comparison on the new page. The first PoC already
  proves that; this page always lights from the normal map.

## 2. Locked decisions

| Area | Decision |
|---|---|
| Page location | New `infinite.html` in this repo/site; existing `index.html` untouched |
| Height source | Procedural infinite only (seeded fBM/ridged), no network |
| Tile generation | Web Worker, CPU float heights + Sobel normals, sub-texture uploads |
| LOD seams | Explicit 2:1 stitch strips (fine edge + coarse-layer chord) + a skirt at the final horizon edge |
| Flight UX | Free-fly (pointer lock + WASD) with an optional auto-cruise toggle |
| Normal maps | Always on; no vertex-normal A/B mode on this page |
| Quality target | Coarser mesh + finer maps: `S0 = 16 m`, 7 LODs, 8× normals (2 m texels), ~122k triangles, ~49 km view |

The constants are configurable; the mobile-friendly values are the defaults.

## 3. Architecture at a glance

```
  procedural height function (CPU worker)
            │
            ├── 64×64 height tiles ──┐
            └── 512×512 normal tiles ┤
                                     ▼
                    toroidal tile cache per LOD
            (height 192², normal 1536² texels/LOD)
                                     │  texSubImage3D
                                     ▼
              DataArrayTexture  [height R16F | normal RGBA8 @ 4x]
                                     │
             ┌───────────────────────┴───────────────────────┐
             │ vertex shader                                 │ fragment shader
             │ height = texture(array, uv, level)             │ normal = texture(array, uv, level)
             │ displace clipmap vertex                        │ shade with world-space normal
             └───────────────────────┬───────────────────────┘
                                     ▼
                  7 camera-centred clipmap rings + centre block
```

## 4. Clipmap geometry

### 4.1 Constants

| Symbol | Value | Meaning |
|---|---|---|
| `S0` | 16 m | finest vertex spacing |
| `C` | 24 cells | centre-block half-size and ring width |
| `LEVELS` | 7 | rings at LOD 0 … 6 |
| `T` | 64 cells | height tile size in samples/cells |
| `K` | 3 | tile-cache side in tiles (exactly the visible ring) |

The centre block is `2C × 2C = 48 × 48` cells, i.e. 768 m across at
`S0 = 16 m`. Its half-extent is `C·S0 = 384 m`.

Ring `L` has:

- vertex spacing `S_L = S0 · 2^L`
- inner half-extent `C · S_L`
- outer half-extent `2C · S_L`
- outer half-extent in metres `2C · S0 · 2^L`

With the values above the last ring reaches `2·24·16·2^6 = 49,152 m`
(49 km). Fog is tuned so the last ring is already fully faded before its
outer edge, which hides the end of the world.

Triangle budget (`C = 24`, `LEVELS = 7`):

| Part | Triangles |
|---|---:|
| centre block (`2C` cells square) | ≈ 4.6k |
| each ring interior (`16C² − 4C² = 12C²` cells) | ≈ 13.8k |
| 7 rings | ≈ 96.8k |
| 6 stitch strips + 7 skirts | ≈ 17.7k |
| **terrain total** | **≈ 119k** |
| + sky | ≈ 122k rendered |

That is intentionally modest: the detail comes from the normal map, not from
the triangle count. The near field is deliberately coarse (16 m vertices),
while the normal map supplies **2 m** detail — an 8× resolution ratio, now
finer in absolute terms than the first PoC's 4.4 m normal map.

### 4.2 Why nested rings with 2:1 steps

Each ring's inner boundary coincides with the previous ring's outer
boundary. A ring's inner edge uses the ring's own spacing `S_L`; its outer
edge is sampled at `2·S_L`, which is exactly the next ring's spacing
`S_{L+1}`. This makes every LOD boundary share vertex positions and height
samples.

### 4.3 Stitching, not just skirts

A naive ring pair leaves T-junctions: the fine edge has twice as many
vertices as the coarse edge. The implementation builds an explicit
**zero-width stitch strip** around each ring's outer edge:

- fine edge `F0–F1–F2` at radius `2C`, vertices every cell, sampled from
  LOD `L`'s height layer;
- coarse chord `C0–C2` at the same radius, vertices every two cells,
  sampled from LOD `L+1`'s height layer;
- three triangles per coarse segment:
  `(F0,C0,F1)`, `(F1,C0,C2)`, `(F1,C2,F2)`, plus their reverse windings.

Using **both layers** is important. At a world position that is not exactly
on a coarse height texel, the fine and coarse bilinearly filtered heights
differ; a stitch built only from the fine layer leaves a visible hairline
gap. The coarse chord samples the exact same coarse layer and UV mapping as
the next ring's inner edge, so the two meshes meet exactly. The fine edge
samples the same fine layer as the current ring's outer edge.

A small vertical skirt is still added at the very outer edge of the last
ring as cheap insurance against any floating-point or texture-filtering
mismatch. The skirt is dropped far enough to hide the horizon edge but is
fully fogged out in normal flight.

### 4.4 Centring and vertex swimming

All rings share one **clipmap origin** snapped to `S0`:

```
clipOrigin = floor(camera.xz / S0) * S0
```

Every level's vertices are `clipOrigin + cell · S_L`, so LOD boundaries never
drift relative to each other. The origin snaps in 16 m steps; the terrain
itself is sampled in world coordinates, so the height field appears
stationary while the mesh grid snaps. Level 0 lands exactly on its grid;
coarser levels shift by at most half a cell, which is negligible at their
screen size.

## 5. Texture buffer / tile cache

### 5.1 Storage layout

For each LOD `L`:

- height layer: `R16F`, normalized height in `[0,1]` (core-filterable in
  WebGL2; the half-float step is well below the 16 m vertex spacing)
- normal layer: `RGBA8`, object-space normal encoded
  `R=N.x`, `G=N.z`, `B=N.y` (same convention as the existing PoC)

Both are WebGL2 `DataArrayTexture`s with `LEVELS` layers:

- height: `192 × 192` texels per layer (`3 × 3` tiles of `64 × 64`) ≈ 0.5 MB
- normal: `1536 × 1536` texels per layer (`3 × 3` tiles of `512 × 512`) ≈ 66 MB

The normal map is baked at **8× the height-tile resolution**, so it can carry
detail well below the clipmap's 16 m near-field vertex spacing. Sampling uses
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

The cache holds the `3×3` tiles at `camTile − 1 … camTile + 1`, where
`camTile = floor(cameraWorld / (T·S_L))`. This is exactly the set the visible
ring can sample: its outer radius is only 0.75 tile. There is no extra
prefetch row/column; when the camera crosses a tile boundary, the incoming
row/column is generated while the ring is still a quarter-tile away. Two
workers make that latency comfortable at the demo's flight speeds.

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
  computing the unit normal from float heights (the existing PoC's rule).

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

No GPU render-to-texture is required. CPU generation reuses the existing
float Sobel code and keeps the pipeline deterministic.

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
spacing       = S0 * exp2(instanceLevel)
sampleLevel   = instanceLevel + aCoarse          // 0 for terrain, 1 for stitch chord
sampleSpacing = S0 * exp2(sampleLevel)
local         = clipOrigin + aCell * spacing
tile          = mod(phase + local / sampleTileWorld, K)
uv            = (tile + fract(...) + 0.5/T) / K
hN            = texture(uHeightArray, vec3(uv, sampleLevel)).r
height        = hN * uHeightScale
worldPos      = vec3(local.x, height, local.y)
```

One height fetch per vertex is enough because the page always lights from
the normal map. The normal map supplies the high-frequency detail that the
coarse geometry and the 16 m near-field grid cannot. The `aCoarse` flag is
only set on the stitch strip's coarse chord, which must sample the next
LOD's layer to meet the next ring exactly.

### 6.2 Fragment shader

```
nm    = texture(uNormalArray, vec3(uv, level)).xyz * 2 - 1
mapN  = normalize(vec3(nm.x * strength, nm.z, nm.y * strength))
```

Lighting, albedo bands, specular, fog and sky reuse the existing PoC's
palette and style. Slope-based rock/grass/snow assignment uses the normal
map normal, so normal-map detail also drives material boundaries.

LOD normal seam: the normal map's resolution changes at ring boundaries. A
narrow cross-fade band in the fragment shader samples both layer `L` and
`L+1` and blends by distance to the ring edge. All levels live in the same
array texture, so this is cheap. The blend is tuned or removed after visual
tests.

### 6.3 Height/normal encoding invariants

Keep the first PoC's conventions:

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

The page links back to the original normal-map PoC. The original page gets a
link to the new page.

## 9. Verification plan

Before shipping, the page must pass a headless loop like the existing PoC:

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
| Stitch chord does not meet the next ring | Coarse chord samples layer `L+1` with the same UV mapping; verified with a magenta-background crack test |
| Visible LOD normal seam | Cross-fade band; test at ring boundaries |
| Tile generation hitch on tile crossings | Worker + prefetch margin + priority queue |
| Floating-origin / tile-phase drift after long flights | `PHASE_WRAP` modulo + warp tests at 25/500 km |
| Vite multi-page paths on GitHub Pages | Root `infinite.html`, relative `base: './'`, test the built site |
| Scope creep | Ship the flyover + normal-map proof first; defer water/vegetation/shadows |

## 11. Proposed milestones

1. **Spike**: prove array textures, float vertex fetch, and sub-texture
   uploads in headless WebGL2 with a tiny test scene.
2. **Terrain source**: infinite height function, tile generator, worker,
   unit tests.
3. **GPU cache**: array textures, toroidal slots, upload path, stats.
4. **Clipmap geometry**: centre block, rings, stitch strips, outer skirt,
   LOD debug view.
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
4. Add the clipmap meshes and stitching.
5. Add flight controls, UI, fog/sky.
6. Verify, document, build, deploy.

## 13. Implementation notes

The shipped defaults are:

| Setting | Value |
|---|---|
| base spacing | 16 m |
| centre/ring width | 24 cells |
| LODs | 7 (0…6), outer radius 49.152 km |
| tile size | 64 height samples; 512 normal texels (8×) |
| cache | 3×3 tiles per LOD (63 tiles visible at boot) |
| triangles | ≈ 122k including stitch strips and sky |
| draw calls | 4 (sky, centre, rings, stitch) |
| height format | R16F |
| normal format | RGBA8, 8× resolution (2 m texels at LOD 0) |
| workers | up to 2 tile workers |

Verified on the headless SwiftShader host:

- boot: 63/63 tiles resident, zero upload errors, no console/page errors;
- 25 km and 500 km warps: 63/63 resident tiles after regeneration;
- 500 km: `PHASE_WRAP` keeps the shader origin at `(237856, 37856)` while
  the camera stays in small render-space coordinates;
- normal-map QA: high-frequency `hf = 4.10` vs `0.23` with flat normals
  (≈18× more shading detail) — the absolute normal resolution is now 2 m,
  twice the previous build's 4 m;
- all rings + stitch: no background cracks at 25 km with the sky hidden and
  the clear colour set to magenta; hiding the stitch reveals the expected
  LOD-boundary cracks, confirming the seam test is sensitive.

Remaining honest limitations:

- The far rings are coarse (up to 1024 m vertex spacing at LOD 6);
  silhouettes and large-scale geometry are therefore smooth, even though the
  normal map adds detail.
- The last ring's edge is hidden by fog and a skirt, not by an actually
  infinite mesh; 49 km is the configured view distance.
- Normal maps are RGB8, so extreme grazing-angle lighting can still show
  quantisation/aliasing.
- Tile generation is CPU-bound in workers; a cold boot on a slow phone can
  take several seconds (the 8× normal bake is ~7× the original work). The
  normal cache is ~66 MB of GPU texture memory; the CPU-side allocation is
  freed after the initial upload.
