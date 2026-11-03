# AGENTS.md

Guidance for AI coding agents (and humans in a hurry) working in this repo.

## What this repo is

Two proof-of-concept renderers in one repo:

1. **`index.html`** — a finite terrain with a low-poly mesh whose lighting
   comes from a high-resolution normal map baked from a heightfield. Offers
   A/B/C (vertex normals / normal map / high-res reference), split-screen,
   and two datasets (procedural fBM + real Grand Canyon SRTM).
2. **`infinite.html`** — camera-centred clipmap rings over an effectively
   infinite procedural world. Heights are displaced in the vertex shader;
   normals come from a toroidal per-LOD tile cache in `DataArrayTexture`s;
   the camera free-flies over the terrain.

Ship anything visual only after verifying it renders — see
[docs/VERIFICATION.md](docs/VERIFICATION.md).

## Commands

```bash
npm install
npm run dev                     # vite dev server
npm run build                   # production build -> dist/
npm run deploy                  # build + force-push dist/ to gh-pages

npm run terrain:grand-canyon    # re-download & bake SRTM data -> public/data/
node tools/build-real-terrain.mjs --name matterhorn --lat 45.9763 --lon 7.6586

npm run test:infinite           # Node-only tile/LOD/normal math checks
npx vite preview                # serve dist/ locally on :4173

# headless QA (needs chrome-headless-shell + puppeteer-core, see docs/VERIFICATION.md)
node tools/screenshot.mjs --url http://127.0.0.1:4173/ --out shots
node tools/analyze-shots.mjs shots
node tools/screenshot-infinite.mjs --url http://127.0.0.1:4173/infinite.html --out shots-infinite
node tools/analyze-infinite.mjs shots-infinite
```

## Repo map

| Path | Purpose |
|---|---|
| `src/perlin.js` | Seeded improved Perlin, fBM, ridged multifractal |
| `src/terrain-data.js` | Dataset builders; **owns the dataset object shape** |
| `src/normalmap.js` | Sobel normal-map baking — core of the PoC |
| `src/geometry.js` | Displaced grid mesh + `computeVertexNormals` (the baseline) |
| `src/shaders.js` | Custom vertex/fragment shaders — core of the PoC |
| `src/main.js` | Scene, modes (A/split/B/C), split scissor rendering, sun, caches |
| `src/ui.js` | DOM control wiring; `initUI(callbacks)` returns a setter API |
| `src/infinite/heightfield.js` | Infinite seeded height function + per-tile float-Sobel normal baking |
| `src/infinite/terrain-worker.js` | Worker wrapper around `generateTile` (transfers buffers) |
| `src/infinite/tiles.js` | Toroidal per-LOD tile cache, worker queue, `texSubImage3D` uploads |
| `src/infinite/clipmap.js` | Centre block, ring grids, 2:1 stitch strips, skirts |
| `src/infinite/shaders.js` | Clipmap vertex/fragment shaders + LOD/tile debug views |
| `src/infinite/flight.js` | Free-fly / auto-cruise camera in absolute world doubles |
| `src/infinite/main.js` | Infinite scene, floating origin, texture arrays, UI, stats |
| `infinite.html` | Second PoC entry page |
| `tools/build-real-terrain.mjs` | Node script: Mapzen terrarium tiles → uint16 `.bin` + `.json` |
| `tools/test-infinite.mjs` | Node-only tile/LOD/normal math checks |
| `tools/screenshot.mjs` | Headless-browser QA screenshot driver (first PoC) |
| `tools/screenshot-infinite.mjs` | Headless QA driver for `infinite.html` |
| `tools/analyze-infinite.mjs` | Pixel/console assertions for the infinite-terrain shots |
| `tools/analyze-shots.mjs` | Pixel-statistics assertions on the first PoC's screenshots |
| `public/data/` | Committed Grand Canyon heightfield (uint16 LE) + metadata JSON |
| `docs/` | PIPELINE.md (the math), INFINITE_TERRAIN_CONCEPT.md, VERIFICATION.md |

## Dataset object shape (terrain-data.js)

Everything downstream (baking, meshing, shading) is agnostic; keep this shape:

```js
{
  id, name,
  res,               // samples per side
  worldSizeX,        // metres covered along x (columns)
  worldSizeZ,        // metres along z (rows)
  heightScale,       // metres for heights going 0 -> 1
  heights,           // Float32Array res*res, normalised 0..1
  credit,            // string shown in the UI
  info,              // string[] shown in the UI
}
```

## Critical invariants — breaking these silently ruins the render

1. **Coordinate/texture convention.** Heightfield row `j` maps to **+z**,
   column `i` maps to **+x**; geometry UV `(u, v)` maps to `(x, z)` the same
   way; normal-map `DataTexture`s use `flipY = false`. Generator, mesh builder
   and shader all assume this. Change one, change all three.
2. **Normal-map encoding is object-space, R=east, G=south(+z), B=up.** Decoded
   in the shader as `mapN = vec3(nm.x, nm.z, nm.y)` (→ x, up, z). There is
   deliberately **no TBN matrix** — the terrain is an unrotated heightfield,
   so local frame == world frame. Do not "fix" this by adding tangent space.
3. **Bake normals from float data, never from an 8-bit heightmap.** Quantised
   heights terrace the gradients. Only the unit-length normals themselves may
   be quantised to RGB8.
4. **Sobel gradient scaling** (`src/normalmap.js`): response must be divided
   by `8 * pixelSpacing` (Sobel sums weight ±spacing across 4 taps) and
   multiplied by `heightScale` before forming `N ∝ (-dh/dx, 1, -dh/dz)`.
   See docs/PIPELINE.md for the derivation.
5. **`uNormalStrength` is applied to the decoded tangent components**, then
   renormalised in the shader. That is mathematically equivalent to re-baking
   with a different strength — keep it that way; do not regenerate the map on
   slider input.
6. **No `*_pars_fragment` includes in custom shaders.** Three.js auto-injects
   tonemapping/colorspace helpers into every fragment shader; including the
   pars chunks again causes duplicate GLSL definitions. Only
   `#include <tonemapping_fragment>` / `<colorspace_fragment>` are safe.
7. **Modes share one `ShaderMaterial`.** Mode switching only touches
   `uNormalBlend` (and the geometry swap for mode C). Split-screen renders
   twice with scissor test — full viewport both passes so the projection is
   identical on both sides of the divider.
8. **Mesh ≥ mode-C reference is `min(1024, res >> 1)`** so the reference
   never exceeds half the data resolution (a mesh finer than its data adds
   nothing but triangles).

### Infinite-terrain invariants (`infinite.html`)

9. **Tile cache is toroidal.** World tile `(tx,ty)` always lives in slot
   `(tx mod 4, ty mod 4)`. The shader reproduces this with
   `slot = mod(floor(t), uCacheTiles)`, the half-texel offset, and
   `uRenderOrigin` passed **modulo `PHASE_WRAP`**. Do not pass absolute
   world coordinates or shift texture data on camera movement.
10. **Height and normal caches have different texel sizes but the same world
    tile.** Height is 64² at `S_L`; normal is 256² at `S_L/4` (`normalScale
    = 4`). The shader uses `uTileCells = 64` for the height UV and
    `uNormalTileCells = 256` for the normal UV. `T` in the UV formula is the
    *per-map* tile texel count, not always 64. This is the 4× resolution
    ratio that makes the normal detail visible on the coarser mesh.
11. **Stitch chords must sample the coarse layer.** `aCoarse = 1` on the
    stitch's coarse vertices adds 1 to `aLevel` for the height fetch only;
    geometry spacing stays at the fine LOD. A stitch built from only fine
    heights leaves visible hairline cracks because the coarse bilinear
    sample differs. See `src/infinite/clipmap.js` + the vertex shader.
12. **Upload height with `texSubImage3D`, not `copyTextureToTexture`.**
    `copyTextureToTexture` produced `GL_INVALID_OPERATION` for R16F array
    layers on SwiftShader. `_rawUpload` also explicitly sets
    `UNPACK_FLIP_Y_WEBGL=false`; keep it.
13. **Normal maps are always on.** The infinite page deliberately has **no
    vertex-normal A/B**; the first PoC already proves that comparison.
    `uNormalStrength` still scales decoded tangent components.
14. **Floating origin rebases at ~15 km.** `renderOrigin` is a 2D world
    origin; `uRenderOrigin` is `renderOrigin mod PHASE_WRAP` (largest cache
    world size). The camera stays in small render-space coordinates. Do not
    remove the modulo or long flights lose tile phase.
15. **Clipmap constants:** `S0=16 m`, `C=24` cells, `LEVELS=7`, outer radius
    ≈49 km, height tile 64², normal tile 256², cache 4×4. Ring `L` covers
    `[C·2^L, 2C·2^L]·S0`; the last ring gets the only real skirt. The mesh is
    deliberately coarse; do not reduce `normalScale` without re-checking the
    detail-vs-mesh ratio.

## Conventions & practices

- ES modules everywhere, no TypeScript, no linter config yet — match the
  existing style (small modules, JSDoc-ish comments on tricky math).
- Runtime dependencies: `three` only. `vite`/`pngjs` are devDependencies
  (pngjs is Node-only, used by tools/). Keep it that way unless there's a
  strong reason.
- Perf-relevant constants (fBM octaves, 2048² heightfield, LRU cache size of
  10 geometries, infinite-page `S0`/`LEVELS`/`normalScale`) were chosen to
  keep load < a few seconds and memory sane. Profile before loosening them.
- The infinite page's tile generation **must stay in workers**; generating
  64² height / 256² normal tiles on the main thread causes visible hitches at
  tile crossings. The streamer uses up to 2 workers because the 4× normal
  bake is ~3.5× the work of the old 2× version. The 4×4 cache already includes
  a prefetch row/column — don't shrink it to 3×3 without testing fast flight.
- The Grand Canyon heightfield is **committed** (`public/data/`) so the site
  needs no network beyond GitHub Pages. Regenerating requires internet access
  to `s3.amazonaws.com/elevation-tiles-prod`.
- Vertical exaggeration of the real dataset lives in the metadata
  (`exaggeration`, folded into `heightScale`); the UI credit string discloses
  it. If you change it, keep the disclosure honest.
- Commits: concise imperative subject lines, e.g. `Fix Sobel z-gradient sign`.
- Deploy = `npm run deploy` (orphan gh-pages branch from `dist/`). Pages is
  served from the `gh-pages` branch root; `vite.config.js` sets
  `base: './'` for project-page paths — don't remove that.
- Never commit secrets. The verification recipe in docs/VERIFICATION.md
  intentionally references credentials only via environment variables.

## Where the tricky math lives

- Sobel → world-space normal derivation: `src/normalmap.js` +
  docs/PIPELINE.md.
- Strength scaling equivalence: docs/PIPELINE.md.
- Terrain RGB encoding/decoding (terrarium tiles): `tools/build-real-terrain.mjs`.
- Web-mercator metres-per-pixel (why worldSizeX == worldSizeZ):
  docs/PIPELINE.md.
