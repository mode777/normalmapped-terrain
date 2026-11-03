# AGENTS.md

Guidance for AI coding agents (and humans in a hurry) working in this repo.

## What this repo is

A proof-of-concept web app that renders terrain in Three.js with a **low-poly
mesh whose lighting comes from a high-resolution normal map baked from a
heightfield** — normals are sampled per-pixel in a custom fragment shader
instead of using interpolated vertex normals. The site offers an A/B/C
comparison (vertex normals / normal map / high-res reference mesh) plus a
split-screen mode, two datasets (procedural fBM + real Grand Canyon SRTM),
and deploys to GitHub Pages.

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

npx vite preview                # serve dist/ locally on :4173

# headless QA (needs chrome-headless-shell + puppeteer-core, see docs/VERIFICATION.md)
node tools/screenshot.mjs --url http://127.0.0.1:4173/ --out shots
node tools/analyze-shots.mjs shots
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
| `tools/build-real-terrain.mjs` | Node script: Mapzen terrarium tiles → uint16 `.bin` + `.json` |
| `tools/screenshot.mjs` | Headless-browser QA screenshot driver |
| `tools/analyze-shots.mjs` | Pixel-statistics assertions on those screenshots |
| `public/data/` | Committed Grand Canyon heightfield (uint16 LE) + metadata JSON |
| `docs/` | PIPELINE.md (the math), VERIFICATION.md (QA recipe) |

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

## Conventions & practices

- ES modules everywhere, no TypeScript, no linter config yet — match the
  existing style (small modules, JSDoc-ish comments on tricky math).
- Runtime dependencies: `three` only. `vite`/`pngjs` are devDependencies
  (pngjs is Node-only, used by tools/). Keep it that way unless there's a
  strong reason.
- Perf-relevant constants (fBM octaves, 2048² heightfield, LRU cache size of
  10 geometries) were chosen to keep load < a few seconds and memory sane.
  Profile before loosening them.
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
