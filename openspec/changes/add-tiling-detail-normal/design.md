# Design

## Context

See `proposal.md` for motivation.

The shared renderer already has a clean seam for this work:

- `src/terrain/shaders.ts` samples the normal atlas in the fragment shader and reconstructs the normal directly from object-space RGB. There is no TBN and no UV or tangent attribute.
- `src/terrain/clipmap.ts` builds only positions, a skirt flag and per-instance origins; the terrain is a regular, unrotated heightfield parameterized by world `x/z`.
- `src/terrain/renderer.ts` owns the two `DataArrayTexture`s (height and normal) and the terrain uniforms. The normal atlas has `ClampToEdgeWrapping`, no mipmaps and `anisotropy = 4`, because mips would bleed across packed slots.
- The infinite page's normal atlas is 2048² per layer × 10 layers, about 160 MiB, at WebGL2's guaranteed `MAX_TEXTURE_SIZE`. The DEM page uses 10 m spacing with `normalScale = 2`, so its LOD 0 normal texels are 5 m.
- `src/terrain/normals.ts` bakes `R = N.x`, `G = N.z`, `B = N.y` from float heights. The shader's current decode is `nm = texture(...).xyz * 2 - 1`, then `N = normalize(nm.x * strength, nm.z, nm.y * strength)` (`src/terrain/shaders.ts:236-237`). The same normal drives the albedo `slope` mask (`src/terrain/shaders.ts:255,266`).
- The DEM page sets `uNormalLodBias = 1`; the normal cross-fade at clipmap boundaries happens before lighting and must stay intact.
- Floating origins rebase at about 15 km. `renderOriginStep` is `baseSpacing · 2^(levels+1)` — 4096 m on the infinite page, 1280 m on the DEM page — and the shader receives render-space positions (`src/infinite/main.ts:257-267`, `src/dem/main.ts:278-293`).
- The QA loop's `02-normal0` shot is produced by setting the normal-strength slider to 0; the analyzers compare high-frequency energy against it.
- A standalone repeating detail texture can use mipmaps, unlike the normal atlas. That is the main reason a detail layer can add finer shading without touching the atlas budget.

## Goals / Non-Goals

**Goals:**

- Add one optional tiling detail normal layer to the shared terrain shader, with the base look unchanged at detail strength 0.
- Prove the parts that could invalidate the material direction: object-space orientation, slope composition without tangents, world-locked UVs across rebases, mip/anisotropy/fade behaviour, and a bounded performance cost.
- Produce evidence for the planar-vs-triplanar decision, plus a recommended tile scale, strength and fade for production.
- Keep the change additive: no new vertex attributes, no atlas or dataset change, no new runtime dependency.

**Non-Goals:**

- Final material art (albedo, roughness, AO) or per-biome material blending.
- Triplanar projection, multi-scale or stochastic tiling, parallax occlusion mapping, mesh displacement.
- Changing the normal atlas resolution, the DEM dataset, the `TileSource` contract, or clipmap topology.
- A production material-authoring UI. The spike exposes a strength control or QA hook only.
- A general-purpose material system for arbitrary meshes.

## Decisions

### 1. Compose in slope space, not with a TBN

A heightfield normal is

```
N = normalize(-Hx, 1, -Hz)
```

so its slope is

```
s = (N.x / N.y, N.z / N.y) = (-Hx, -Hz)
```

For a detail height field `D(x,z)`, the combined height `H + D` has

```
s_total = s_base + s_detail
N_total = normalize(s_total.x, 1, s_total.y)
```

The detail map stores the same object-space encoding as the base, so its slope is read the same way:

```
nm = texture(baseNormal, uv).xyz * 2 - 1;      // (N.x, N.z, N.y)
dm = texture(detailNormal, uv).xyz * 2 - 1;    // (N.x, N.z, N.y)

vec2 sBase   = nm.xy / max(nm.z, 0.1);
vec2 sDetail = dm.xy / max(dm.z, 0.1);
vec2 s       = sBase * uNormalStrength + sDetail * uDetailStrength * fade;

vec3 N = normalize(vec3(s.x, 1.0, s.y));
```

This is exact for height fields (up to 8-bit quantization and the detail's height scale), and it needs no tangent frame. It also does not change the current base look: the existing strength behaviour is

```
normalize(s*N.x, N.y, s*N.z)
  == normalize(s*N.x/N.y, 1, s*N.z/N.y)
```

so moving the base decode to slope space is a no-op at any strength. The `max(nm.z, 0.1)` guard only affects near-vertical normals, where dividing by the 8-bit up component would amplify quantization.

Why not blend normals? `normalize(N_b + N_d)` is a vector average, not a slope sum. On a 45° base slope with a 0.2 detail slope in the same direction:

```
exact slope add        -1.20
whiteout blend         -1.30   (close approximation)
UDN normalize(a + b)   -0.54   (flatter than the base alone)
```

The whiteout blend is a reasonable fallback if the division is unwanted, but the division is cheap and the slope sum is exact. The slope-space refactor is the core of this change.

**Alternatives considered:** per-vertex TBN (unnecessary; the geometry has no UV/tangent attributes and the frame is the world axes), UDN/whiteout blending (UDN flattens steep terrain; whiteout is approximate), and raising the normal atlas resolution (blocked by the 2048² ceiling and bake/memory cost).

### 2. Planar world `x/z` projection for the spike; triplanar deferred

The detail tile is sampled as `uv = worldXZ / tileWorldSize`. For a heightfield perturbation this is the physically consistent projection: the detail is another height field over the same `x/z` domain, and the composition above is exact. The trade-off is cliff stretching: at 60° the detail stretches 2× along the slope, at 80° about 5.8×.

The spike deliberately tests that trade-off with a steep-cliff shot. If the intended production use is a *surface coating* (uniform texel density on cliffs) rather than a heightfield perturbation, the follow-up is triplanar. Triplanar is not free: three fetches, per-projection swizzles, blend weighting and 45° blend artefacts. It should be paid for only after the planar result is judged.

**Alternatives considered:** triplanar immediately (more cost and complexity before the evidence), slope-corrected planar UVs (singularities at vertical faces), and no detail layer (does not address the atlas ceiling).

### 3. Object-space diagnostic tile, generated from a seamless height field

The first tile is generated in the repo's object-space encoding (`R = N.x`, `G = N.z`, `B = N.y`) from a seamless height field. This avoids introducing a second normal convention and avoids the green-channel/handedness ambiguity of third-party tangent-space assets. It is also exactly the representation the slope composition expects.

The first tile is diagnostic, not beauty art: asymmetric bumps and ridges (to catch an inverted or green-flipped normal), a range of feature scales (to judge the band), and high-frequency content (to expose aliasing). A real rock/ground material replaces it only after the pipeline is trusted.

Texture configuration: `RepeatWrapping` on both axes, mipmaps with a trilinear min filter, `anisotropy = min(8, maxAnisotropy)`, `colorSpace = NoColorSpace`, and a `flipY`/V-direction choice that is documented with the tile. The texture is disposed with the rest of the renderer's textures.

A third-party tangent-space asset is still usable, but its green channel and V direction must be verified against the terrain's `+z` convention; do not assume a swizzle. If the material becomes a repo-owned production asset, an RG slope tile (two channels) is the better long-term format: mips average gradients correctly, it uses half the memory, and it is projection-agnostic. The spike can start with RGB object-space because it is simpler to inspect and matches the base atlas.

### 4. World-locked UVs with a double-precision offset

The detail pattern must be attached to world positions, not to the render origin. The renderer computes, in JavaScript doubles:

```
offset = mod(renderOrigin, tileWorldSize)   // wrapped to [0, tileWorldSize)
```

and the shader uses:

```
uv = (vWorldPos.xz + offset) / tileWorldSize
```

When the floating origin jumps by `Δ`, `vWorldPos` jumps by `-Δ`; the sum changes by an integer multiple of `tileWorldSize`, so the repeated texture samples the same value. The offset also keeps the shader UV small, avoiding float32 precision loss when the camera is 15 km from the origin and the far rings are tens of kilometres away.

The shader must use the interpolated `vWorldPos.xz` (continuous across clipmap rings), not the ring-local `position` or `aOrigin`. A power-of-two tile size that divides `renderOriginStep` would also avoid rebase shifts, but it constrains the art scale; the offset works for any tile size.

**Alternative considered:** sampling `vWorldPos.xz` directly (the pattern is locked to the render origin and pops on rebase), or adding the full `uRenderOrigin` modulo `PHASE_WRAP` to the UV (too large for float32 at a few-centimetre detail scale).

### 5. Fade and strength

The detail is a near-field layer. For the spike, fade it by camera distance:

```
fade = 1 - smoothstep(fadeStart, fadeEnd, distance)
```

Initial values to tune: infinite page 16 m tile, fade 80–250 m; DEM page 32 m tile, fade 150–500 m. The DEM values are larger because its base normals are 20× coarser and the intended feature band is wider. A footprint-based fade (`fwidth(uv)`) is a refinement; distance is enough to hide the repetition and the mip transition in the first pass.

Detail strength is a separate uniform/control from `uNormalStrength`, defaulting to 0 so the current pages are unchanged. The QA sets a visible value (for example 0.35 and 0.6) for the detail shots. A normal map is scale-free: the tile's world size and the strength together determine the apparent world slope, so the chosen pair must be recorded with the findings. The existing normal-strength slider remains the base control; the detail control is additional.

**Alternative considered:** a single combined strength. It would make the existing "normal strength 0 goes smooth" test ambiguous and makes it impossible to tune the detail independently.

### 6. Keep the base normal for material masks

The current albedo uses `slope = 1 - N.y` to drive the grass/rock/sand/snow bands. If the detail-perturbed normal feeds that mask, the bands speckle at the detail scale. Keep two normals:

- `Nbase` — the cross-faded base normal, used for the albedo and `steep`/`slopeShade` masks.
- `Nfull` — `Nbase` plus the detail slope, used for diffuse, hemi and specular lighting.

The detail is added after the base normal's LOD cross-fade, so the detail is continuous across clipmap boundaries and the cross-fade still matches the adjacent ring.

This also means changing the detail strength does not move the material boundaries, which is the behaviour the spec requires.

### 7. QA and findings

The existing `02-normal0` shot must zero **both** base and detail strength or it is no longer a flat baseline. The QA set adds:

- `detail off` and `detail on` at the same pose, with the base normal on;
- a low-sun orientation pair on the diagnostic tile (opposite azimuths);
- a close-up of the near ground;
- a steep-cliff close-up (the planar-vs-triplanar decision shot);
- a close-up before and after a 25 km and/or 500 km warp (rebase stability).

The analyzer compares detail-on vs detail-off high-frequency energy in a near-field region and keeps every existing check. The orientation and tiling checks are visual; the analyzer only proves the layer contributes.

A short findings note records: whether planar cliff stretch is acceptable for the intended material; the chosen tile scale, strength, fade and page values; the measured cost; any convention surprises; and the recommended production path (planar + multi-scale, or triplanar).

SwiftShader is not representative for anisotropic filtering or specular sparkle. The headless loop is the regression gate; a real-GPU manual pass is required before calling the detail production-ready.

## Risks / Trade-offs

- **Cliff stretching** → the cliff shot is an explicit decision point; if it fails for a surface coating, the follow-up is triplanar.
- **Tiling repetition** → near-field fade and a single scale for the spike; multi-scale/rotated or stochastic sampling later if the repetition is visible.
- **Aliasing and specular sparkle** → mipmaps, anisotropy, distance/footprint fade; verify on a real GPU because SwiftShader is not representative.
- **Orientation convention** → diagnostic tile plus opposing-sun screenshots; no assumed green-channel swizzle for third-party assets.
- **Albedo feedback** → keep `Nbase` for material masks; only lighting uses `Nfull`.
- **Texture load failure** → surface the error in the loading/status UI and console, disable detail, and keep the base normal rendering. The pages already have a failure-visibility pattern.
- **Performance** → one extra texture fetch and a few ALU ops; about 1–6 MiB with mips; no extra draw calls. Measure on a real GPU; the software renderer's absolute cost is not meaningful.
- **Shading-only detail** → normal maps do not change the silhouette or collision; POM/displacement is a separate, larger feature.
- **QA baseline drift** → update the flat shot to zero both strengths; otherwise the existing normal-map assertion becomes misleading.
- **Scale-free strength** → changing the tile's world size changes the apparent bumpiness unless the strength is compensated; record the pair.

## Migration Plan

The change is additive:

1. Detail strength defaults to 0, so both pages render the current base normal and albedo exactly.
2. The slope-space base decode is mathematically equivalent to the current strength path, so the existing look is preserved at any base strength.
3. The normal atlas, DEM dataset, `TileSource` contract and clipmap geometry are unchanged.
4. The QA tooling gains shots and an assertion; existing checks remain.
5. Rollback is setting the detail strength to 0 (or removing the texture/uniforms); the base path is untouched.

## Open Questions

- Which page should be the primary demo? Both share the shader; the DEM page should show the larger visual delta because its base normal texels are 5 m rather than 0.25 m. The spike can capture both and let the findings choose.
- What are the final tile scale, strength and fade per page? The screenshots and the cliff result decide; the design records starting values only.
- Should production ship the detail on by default, or opt-in? The findings recommend a default after the visual review.
