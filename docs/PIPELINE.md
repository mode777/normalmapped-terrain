# The pipeline in detail

This doc explains *why* the code in `src/` is written the way it is. The
README covers what the PoC claims; this covers the math and the engineering
decisions behind it.

- [1. Heightfields](#1-heightfields)
- [2. Baking the normal map](#2-baking-the-normal-map)
- [3. Encoding: object space, no TBN](#3-encoding-object-space-no-tbn)
- [4. The strength slider is a re-bake in disguise](#4-the-strength-slider-is-a-re-bake-in-disguise)
- [5. Mesh construction](#5-mesh-construction)
- [6. The shader](#6-the-shader)
- [7. Split-screen rendering](#7-split-screen-rendering)
- [8. Real-world data (SRTM)](#8-real-world-data-srtm)
- [9. Limitations, quantified](#9-limitations-quantified)

---

## 1. Heightfields

Everything starts as a `Float32Array` of `res²` samples normalised to
`[0, 1]`, plus three world-space numbers:

| Field | Meaning |
|---|---|
| `res` | samples per side |
| `worldSizeX` / `worldSizeZ` | metres covered along x (columns) and z (rows) |
| `heightScale` | metres of relief for heights going 0 → 1 |

Two producers:

- **Procedural** (`src/terrain-data.js`): seeded improved Perlin
  (`src/perlin.js`), combined as

  ```
  warp(p)     = p + 1500 · (noiseA(p·2.1e-4), noiseB(p·2.1e-4))   // domain warp
  mask        = smoothstep(0.38, 0.66, 0.5·fbm₃(warp(p)·1.05e-4) + 0.5)
  hills       = 0.5·fbm₆(warp(p)·3.4e-4) + 0.5
  ridge       = ridged₈(warp(p)·2.6e-4) / 1.25
  h           = pow(hills·0.30·(1 − 0.6·mask) + ridge·0.78·mask + 0.16·mask, 1.3)
  h          *= smoothstep(1.0, 0.86, max(|nx−0.5|, |nz−0.5|)·2)  // edge falloff
  ```

  Domain warping prevents axis-aligned looking ranges; the `pow` flattens
  valleys relative to crests; the edge falloff sinks tile borders below the
  fog line so the world reads as an endless plateau. Generation runs in
  128-row chunks with `setTimeout(0)` yields so the loading bar animates.

- **Real SRTM** (`tools/build-real-terrain.mjs`, run offline, output
  committed): terrarium-decoded elevations, see [§8](#8-real-world-data-srtm).

## 2. Baking the normal map

A heightfield is a surface `y = H(x, z)`. The unit normal of that surface is

```
N = normalize( −∂H/∂x , 1 , −∂H/∂z )
```

(standard result: the gradient of `F(x,y,z) = y − H(x,z)` is
`(−∂H/∂x, 1, −∂H/∂z)`). `src/normalmap.js` estimates the two partial
derivatives with a **3×3 Sobel operator** rather than central differences —
Sobel averages the derivative across three rows/columns, which suppresses
per-sample noise, and it is the de-facto standard for height→normal
conversion (it is also what Godot's "as normal map" and most DCC tools do).

### Sobel response → real-world gradient

The Sobel kernel in x is

```
[ -1  0  1 ]
[ -2  0  2 ]
[ -1  0  1 ]
```

For a *linear* ramp `H = k·x`, each ±column pair contributes `(2k·s)·w` where
`s` is the pixel spacing and `w ∈ {1, 2}` the row weight — total response
`Gx = 8·k·s`. Hence

```
∂H/∂x = Gx · heightScale / (8 · sx)      sx = worldSizeX / (res − 1)
∂H/∂z = Gz · heightScale / (8 · sz)      sz = worldSizeZ / (res − 1)
```

(`heightScale` converts the normalised stored heights into metres — the
heights array is unitless, the world is not.) Doing this in **float** before
any quantisation is important: deriving gradients from an 8-bit heightmap
produces visible terracing, because the quantisation step between adjacent
samples is a huge fraction of the local height difference on gentle slopes.
Only the final *unit-length* normals — which live on a sphere, well-behaved
in 8 bits per channel — are quantised to RGB.

Edges use clamped indices (no wrap: the terrain is a one-shot tile).

**Honesty note.** With `uNormalStrength = 1` the baked normals are the true
surface normals of the heightfield — the same normals a mesh with one vertex
per sample would carry (to within Sobel-vs-face-normal differences). The
PoC's comparison is therefore fair: mode B is *not* an artistic bump effect,
it is the actual fine geometry's shading relocated into a texture.

## 3. Encoding: object space, no TBN

Normal maps are conventionally **tangent-space** (mostly purple, expressing a
perturbation relative to the underlying surface) and require a per-fragment
TBN matrix. Tangent frames are a classic source of artifacts: they must be
computed identically at bake time and render time, or lighting bends visibly
(this is the "mikkTSpace vs whatever" family of bugs).

A heightfield terrain gets this for free. The surface is a graph over the
xz-plane, UVs map identity onto `(x, z)`, and the mesh is never rotated — so
the "tangent frame" is the constant world frame. We therefore bake
**object-space** normals in the terrain's local frame and store them as

```
R = N.x  (east)      G = N.z  (+z)      B = N.y  (up)
```

Keeping "up" in B preserves the familiar blue-dominated look. The shader
decodes with a channel swizzle — see `src/shaders.js`:

```glsl
vec3 nm   = texture2D(uNormalMap, vUv).xyz * 2.0 - 1.0;   // (x, z, up)
vec3 mapN = normalize(vec3(nm.x, nm.z, nm.y));            // -> (x, up, z)
```

No tangents, no bitangents, no per-fragment frame — nothing to disagree
between generator and renderer. (The trade-off: object-space maps only work
because the terrain is undeformed. A wave-displaced or animated surface would
need tangent space.)

## 4. The strength slider is a re-bake in disguise

Scaling the gradient by `k` before normalising is identical to scaling the
tangent components after decoding:

```
normalize(−k·∂H/∂x, 1, −k·∂H/∂z)  ≡  normalize(k·N.x, N.y, k·N.z)
```

So the shader applies `uNormalStrength` to the decoded tangent components and
renormalises — no texture regeneration, no CPU work, slider updates are free.
`k = 1` is the honest terrain; `k > 1` exaggerates relief (and `k = 0` is
flat, which is a nice sanity check: it must look uniformly lit from above).

## 5. Mesh construction

`src/geometry.js` builds a `(segments+1)²` grid; vertex heights come from
**bilinear sampling** of the heightfield, so a 192² mesh is a faithful
low-pass-filtered version of the same field the normal map was baked from.
Positions are `(u−0.5)·worldSizeX`, `h·heightScale`, `(v−0.5)·worldSizeZ`
with `uv = (u, v)` — matching the generator's row↔z convention exactly.

Vertex normals are `geometry.computeVertexNormals()` — precisely what a
default Three.js workflow would give you. That is deliberate: mode A is an
honest baseline, not a straw man.

The reference mesh (mode C) uses `min(1024, res >> 1)` segments: half data
resolution is the point beyond which a mesh is smoother than its source data
(anything beyond ~2 samples per mesh edge is interpolating, not adding).

## 6. The shader

One `ShaderMaterial` serves all modes; `uNormalBlend ∈ [0, 1]` mixes vertex
and map normals (`mix` + renormalise). Lighting is deliberately simple so the
normal comparison is legible:

- **Sun**: Lambert `max(dot(N, L), 0)` × warm/neutral colour keyed to
  elevation.
- **Ambient**: hemispheric `mix(groundColor, skyColor, N.y·0.5 + 0.5)` —
  this is where normal-map detail shows in shadowed areas too.
- **Albedo**: height/slope bands (grass → rock → snow, plus sand at the
  bottom). Slope is computed from the **blended** normal, so fine normal
  detail also steers rock-vs-snow assignment — detail beyond pure lighting.
- **Specular**: Blinn-Phong, mostly on snow/wet sand.
- **Fog**: `1 − exp(−(d·ρ)²)` toward the horizon colour; density scales with
  dataset extent (`0.42 / (maxDim·1.55)`).
- **Output**: `#include <tonemapping_fragment>` and
  `#include <colorspace_fragment>` (ACES filmic + sRGB). The corresponding
  `*_pars_fragment` chunks are auto-injected by the renderer into every
  fragment shader — including them again is a duplicate-definition compile
  error (learned the hard way; also documented in AGENTS.md).

The sky is a separate back-side sphere with a vertical gradient plus a sun
disc/halo (`pow(dot(dir, sun), 950)` and `pow(·, 14)`), re-centred on the
camera each frame.

## 7. Split-screen rendering

Both comparison sides must be *pixel-identical in projection*. The renderer
therefore:

1. sets the full viewport twice,
2. crops with the **scissor test** (left half, then right half),
3. flips `uNormalBlend` between passes (0 = vertex normals, 1 = map).

Because `autoClear` respects the scissor box, each pass clears only its own
half. The divider itself is a DOM overlay (drag handle + labels) — dragging
only moves the scissor boundary, so the comparison stays exact at any split
position.

## 8. Real-world data (SRTM)

`tools/build-real-terrain.mjs` downloads **terrarium**-encoded PNG tiles from
the public Mapzen/AWS terrain tiles bucket (S3, no auth). Terrarium packs
elevation into RGB as

```
elev_m = R·256 + G + B/256 − 32768
```

(stored centimetres-ish precision, ±~10 km range). Some tiles carry a 1-px
overlap skirt (258×258) — the script detects and crops it.

Window selection uses Web-Mercator pixel math
(`x = (lon+180)/360·2^z·256`, `y` from `asinh(tan φ)`). **Ground metres per
pixel** is `156543.03392·cos(lat)/2^z` — and because Mercator is conformal
the scale factor is identical in both directions, which is why the square
pixel window yields a square `worldSizeX == worldSizeZ` terrain (no aspect
correction needed; this surprises people, so it's spelled out here).

Heights are min-max normalised to uint16 (`public/data/*.bin`) with the real
range kept in the metadata JSON. **Vertical exaggeration** (×2.5 for the
Grand Canyon) is applied by inflating `heightScale` — the normal map is baked
from the same inflated scale, so lighting and geometry stay consistent, and
the UI credit string discloses the factor. Without it, 1933 m of relief over
31.6 km (1:16) reads as a flat pancake from orbit-style camera distances.

## 9. Limitations, quantified

- **Silhouette**: normals cannot bend the geometric outline. At grazing
  angles you see the 192² facets regardless of mode — switch to C to see what
  geometry alone buys.
- **No fine-detail self-shadowing**: shadow mapping would run off the mesh
  and stay coarse (the demo avoids real shadows entirely for this reason).
- **Mip filtering**: hardware mips average normals, which biases toward flat
  and dimples the response at distance; the shader renormalises, which
  recovers direction but not distribution (proper fix would be
  variance-corrected normal mipmaps — overkill for a PoC).
- **Detail/mesh ratio**: the baked map should stay ≥4× the mesh resolution
  per axis (lit recommendation is 8–16×). Defaults: 2048² map vs 192² mesh ≈
  10.7×; slider max 512² still leaves 4×.
