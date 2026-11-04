# AGENTS.md

Guidance for AI coding agents (and humans in a hurry) working in this repo.

## What this repo is

Two proof-of-concept pages share one renderer:

- **`infinite.html`** — camera-centred clipmap rings over an effectively
  infinite procedural world. Heights are displaced in the vertex shader;
  normals come from a toroidal per-LOD tile cache in `DataArrayTexture`s; the
  camera free-flies over the terrain.
- **`dem.html`** — a checked-in Kartverket DTM 10 window of Jotunheimen,
  rendered through the same `ClipmapRenderer` and `TileCache` with a
  pre-baked `TileSource`, free-fly movement plus an optional auto-cruise
  orbit, and a finite-world edge policy.

Ship anything visual only after verifying it renders — see
[docs/VERIFICATION.md](docs/VERIFICATION.md).

## Commands

```bash
npm install
npm run dev                     # vite dev server; open /infinite.html, /dem.html or /materials.html
npm run typecheck               # strict tsc for app + Node tools/config
npm run build                   # typecheck + production build -> dist/

npm run test:infinite           # Node-only math checks; one script, no per-test filter
npm run test:dem                # synthetic + checked-in DEM dataset checks
npm run test:materials          # packed Poly Haven library checks
npm run bake:materials          # fetch/pack the Poly Haven library
npm run bake:dem -- --config tools/dem/jotunheimen.json  # re-bake checked-in DEM
node tools/bake-dem.ts --config tools/dem/jotunheimen.json --materials-only
node tools/bake-dem.ts --config tools/dem/jotunheimen.json --check-materials
npm run preview                 # serve dist/ on :4173 (build first)

# headless QA (optional; see docs/VERIFICATION.md)
npm install --no-save puppeteer-core
node tools/screenshot-infinite.ts --url http://127.0.0.1:4173/infinite.html --out shots-infinite
node tools/analyze-infinite.ts shots-infinite
node tools/screenshot-dem.ts --url http://127.0.0.1:4173/dem.html --out shots-dem
node tools/analyze-dem.ts shots-dem

# OpenSpec
openspec list                   # active changes; add --specs for current specs
openspec validate --all
```

## OpenSpec

Planning lives in `openspec/`: `specs/` is current behavior, `changes/` holds
active proposals, and `changes/archive/` holds completed ones. `.opencode/`
holds the generated OpenSpec skills and `/opsx-*` commands — refresh them with
`openspec update`, don't hand-edit them.

Use `/opsx-propose <idea>` (or the `openspec-propose` skill) before a
non-trivial change, `/opsx-apply` to implement, and `/opsx-archive` when done.
Commit and merge when apply finishes, then **push to `origin/main`
immediately**. Every apply ends with a push; every push to `main` runs the
Pages deploy workflow. Do not hand off a successful apply with local-only
commits. Archive on main and commit/push after archive or sync. Validate with
`openspec validate --all`. In this container `openspec` may not be on `PATH`;
the binary is at `~/.local/bin/openspec`.

## Repo map

| Path | Purpose |
|---|---|
| `.github/workflows/deploy.yml` | Push-to-`main` CI: unit/dataset checks, build, GitHub Pages deployment |
| `openspec/` | OpenSpec specs, active changes, archive, and `config.yaml` |
| `.opencode/` | Generated OpenSpec skills + `/opsx-*` commands; do not hand-edit |
| `tsconfig.json` | Strict TypeScript config for browser source (`src/`) |
| `tsconfig.node.json` | Strict config for Node QA tools + `vite.config.ts` |
| `src/perlin.ts` | Seeded improved Perlin, fBM, ridged multifractal |
| `src/terrain-compose.ts` | Multi-noise channels, spline response curves, iterated domain warp, anisotropic ridge spines |
| `src/sky-shaders.ts` | Sky gradient + sun disc/halo shaders |
| `src/styles.css` | Shared UI chrome (panels, stats, sliders, loading overlay) |
| `src/infinite/heightfield.ts` | Infinite seeded height function + per-tile `generateTile` |
| `src/infinite/worker-protocol.ts` | Typed messages shared by the main thread and tile worker |
| `src/infinite/terrain-worker.ts` | Worker wrapper around `generateTile` (transfers buffers) |
| `src/infinite/procedural-source.ts` | Worker-pool `TileSource` around the procedural generator |
| `src/infinite/flight.ts` | Free-fly / auto-cruise camera in absolute world doubles |
| `src/infinite/main.ts` | Procedural page: floating origin, streamer, UI, stats |
| `src/infinite/infinite.css` | Page-specific additions to `src/styles.css` |
| `src/terrain/tile-source.ts` | Shared `TerrainConfig`, `GeneratedTile`, `TileSource` contract |
| `src/terrain/config.ts` | Derived cache, phase, origin-step and extent metrics |
| `src/terrain/normals.ts` | Pure float-height Sobel normal baking |
| `src/terrain/tile-cache.ts` | Toroidal per-LOD tile cache, async source queue, uploads |
| `src/terrain/clipmap.ts` | Centre block, padded ring grids, parent-square trim, skirts |
| `src/terrain/origins.ts` | Per-LOD clipmap origins: each level snaps to its own spacing |
| `src/terrain/shaders.ts` | Clipmap vertex/fragment shaders + material composition + LOD/tile debug views |
| `src/terrain/renderer.ts` | Shared texture-backed `ClipmapRenderer` with optional material library/stack |
| `src/terrain/materials.ts` | Packed material library loader and manifest validation |
| `src/terrain/material-stack.ts` | Whole-window material stack/macro loader and UV offset |
| `src/terrain/ui.ts` | DOM control wiring; `initUI(callbacks)` returns a setter API |
| `src/materials/main.ts` | Material swatch page logic (albedo + packed slope shading) |
| `src/materials/materials.css` | Swatch page layout |
| `src/dem/prebaked-source.ts` | Manifest/tile `TileSource`, coarse `heightAt`, edge clamp |
| `src/dem/main.ts` | DEM page: manifest-driven config, materials, free-fly/orbit, UI, stats |
| `src/dem/dem.css` | DEM page additions to `src/styles.css` |
| `infinite.html` | The procedural PoC entry page |
| `dem.html` | The pre-baked Jotunheimen DEM entry page |
| `materials.html` | Packed Poly Haven material swatch page |
| `public/data/jotunheimen/` | Checked-in manifest, height/normal tiles, coarse grid, stack/macro, preview |
| `public/materials/` | Packed material library: two 512² PNGs per material + manifest |
| `tools/test-infinite.ts` | Node-only tile/LOD/normal math checks |
| `tools/fetch-materials.ts` | Poly Haven API fetch/pack tool; writes `public/materials` |
| `tools/test-materials.ts` | Packed library validation (cap, dimensions, hashes) |
| `tools/materials/polyhaven.json` | Curated 20-material source list |
| `tools/bake-dem.ts` | Offline Kartverket WCS -> checked-in tile/stack baker |
| `tools/test-dem.ts` | Synthetic + checked-in DEM dataset validation |
| `tools/dem/` | Bake source, grid/tile/normal helpers, material stack bake, manifest validator |
| `docs/MATERIALS.md` | Material library, stack, bake rules, measurements and limitations |
| `tools/screenshot-infinite.ts` | Headless QA driver for `infinite.html` |
| `tools/analyze-infinite.ts` | Pixel/console assertions for the infinite screenshots |
| `tools/screenshot-dem.ts` | Headless QA driver for `dem.html` (includes material shots/swatches) |
| `tools/analyze-dem.ts` | Pixel/console assertions for the DEM screenshots |
| `docs/` | INFINITE_TERRAIN_CONCEPT.md, DEM_DATASET.md, MATERIALS.md, TERRAIN_RESEARCH.md, VERIFICATION.md |

## Critical invariants — breaking these silently ruins the render

1. **Coordinate/texture convention.** Heightfield row `j` maps to **+z**,
   column `i` maps to **+x**; the shaders use the same mapping. Array textures
   use `flipY = false`. Generator, mesh builder and shader all assume this.
   Change one, change all three.
2. **Normal-map encoding is object-space, R=east, G=south(+z), B=up.**
   Decoded in the shader as `mapN = vec3(nm.x, nm.z, nm.y)` (→ x, up, z).
   There is deliberately **no TBN matrix** — the terrain is an unrotated
   heightfield, so local frame == world frame. Do not "fix" this by adding
   tangent space.
3. **Bake normals from float data, never from an 8-bit heightmap.** Quantised
   heights terrace the gradients. Only the unit-length normals themselves may
   be quantised to RGB8.
4. **Sobel gradient scaling** (`src/infinite/heightfield.ts`): response must be
   divided by `8 * pixelSpacing` (Sobel sums weight ±spacing across 4 taps) and
   multiplied by `heightScale` before forming `N ∝ (-dh/dx, 1, -dh/dz)`.
5. **`uNormalStrength` is applied to the decoded tangent components**, then
   renormalised in the shader. That is mathematically equivalent to re-baking
   with a different strength — keep it that way; do not regenerate the map on
   slider input.
6. **No `*_pars_fragment` includes in custom shaders.** Three.js auto-injects
   tonemapping/colorspace helpers into every fragment shader; including the
   pars chunks again causes duplicate GLSL definitions. Only
   `#include <tonemapping_fragment>` / `<colorspace_fragment>` are safe.
7. **Tile cache is toroidal.** World tile `(tx,ty)` always lives in slot
   `(tx mod K, ty mod K)`. The shader reproduces this with
   `slot = mod(floor(t), uCacheTiles)`, the half-texel offset, and
   `uRenderOrigin` passed **modulo `PHASE_WRAP`**. Do not pass absolute
   world coordinates or shift texture data on camera movement.
8. **Height and normal caches have different texel sizes but the same world
   tile.** Height is 64² at `S_L`; normal is 512² at `S_L/8` (`normalScale
   = 8`). The shader uses `uTileCells = 64` for the height UV and
   `uNormalTileCells = 512` for the normal UV. `T` in the UV formula is the
   *per-map* tile texel count, not always 64. This is the 8× resolution
   ratio (0.25 m normal texels vs 2 m mesh) that makes the detail visible.
   The DEM page uses `normalScale = 2` (128² normal tiles, 640² atlas layers)
   with the same formula; do not hardcode 512/8 in shared code.
9. **Every LOD snaps to its own spacing.** `snapLevelOrigins()` rounds each
   origin to a multiple of **its own** `S_L` (`origin_L = round(cam / S_L) *
   S_L`). A shared finest-level origin makes coarse vertices re-sample their
   height tile at sub-texel positions as the camera moves: the surface
   "swims". The independent origins differ by 0 or ±`S_L/2` — the pad in
   (11) relies on that bound. Do not cascade or share them.
10. **`RENDER_ORIGIN_STEP` must be a multiple of every `S_L` and divide
    `PHASE_WRAP`** (it is `S0 · 2^(levels+1)`). Only then do level vertices
    land on exact height-texel centres; otherwise every level samples at a
    static half-texel bias.
11. **Rings are padded one cell and clipped to the parent square.** The
    level-0 ring uses hole `C` and abuts the centre block (same lattice, no
    clipping). Rings 1+ use hole `C-1` and discard fragments inside the
    parent's outer square, with a slack that grows with the pixel footprint.
    The pad guarantees coverage when the two origins are offset; the clip
    stops the coarse ring drawing over the fine one. There is **no stitch
    geometry** — it would need the exact alignment per-level snapping gives
    up.
12. **The outer `morphCells` cells morph into the next-coarse height, sampled
    through the coarse mesh's triangulation** (`coarseMeshHeight`), not
    bilinearly. Bilinear disagrees with the coarse triangles by up to the
    LOD error; with a half-cell origin offset that opens slivers at the ring
    boundary when seen at a grazing angle. If you change the diagonal in
    `buildRingGeometry`, change it here too.
13. **Upload height with `texSubImage3D`, not `copyTextureToTexture`.**
    `copyTextureToTexture` produced `GL_INVALID_OPERATION` for R16F array
    layers on SwiftShader. `_rawUpload` also explicitly sets
    `UNPACK_FLIP_Y_WEBGL=false`; keep it.
14. **Normal maps are always on.** The page deliberately has **no
    vertex-normal A/B**; `uNormalStrength` still scales decoded tangent
    components.
15. **Floating origin rebases at ~15 km.** `renderOrigin` is a 2D world
    origin; `uRenderOrigin` is `renderOrigin mod PHASE_WRAP` (largest cache
    world size). The camera stays in small render-space coordinates. Do not
    remove the modulo or long flights lose tile phase.
16. **Infinite clipmap constants:** `S0=2 m`, `C=24` cells, `LEVELS=10`, outer radius
    ≈49 km, height tile 64², normal tile 512², cache 4×4, `morphCells=3`.
    Ring `L` covers `[C·S_L, 2C·S_L]` = `[48·2^L, 96·2^L] m`; the last ring
    gets the only real skirt. Do not reduce `normalScale` without re-checking
    the detail-vs-mesh ratio. The normal cache is 2048² per layer (10 layers,
    ~160 MiB) — exactly the WebGL2 guaranteed minimum `MAX_TEXTURE_SIZE`, so
    `main.ts` throws rather than growing it.
17. **DEM clipmap constants:** `S0=10 m`, `C=24` cells, `LEVELS=6`,
    `normalScale=2`, 5×5 cache, outer radius 15.36 km over a 30.72 km
    checked-in window. The manifest is the source of truth for the page
    config; do not hardcode the dataset's spacing or normal scale in
    `dem.html` code.
18. **Normal shading supports a one-layer LOD bias.** The DEM page sets
    `uNormalLodBias = 1`, sampling normal layer `max(vLevel - 1, 0)`; the
    procedural page keeps 0. The 5×5 finer-layer cache covers the whole coarse
    ring, so this is safe. The boundary cross-fade target is `nLevel + 1` for
    `vLevel > 0`. Do not add GPU mipmaps to the tiled normal atlas: mips bleed
    across packed slots and would need a full-layer regenerate after every
    `texSubImage3D`.
19. **Material library is capped at 24 layers and packed as two 512²
    arrays.** Albedo RGB is sRGB, its alpha is the linear height, and the
    slope/rough/ao array is entirely linear. Arrays generate per-layer mips;
    do not move material textures into the normal atlas, which has no mips and
    is already at the 2048² ceiling. `public/materials/manifest.json` is the
    source of truth for layer order, tile metres, slope scale and packing.
20. **The material stack is a whole-window 2048² pair plus a 1024² macro.** It
    stores four material IDs (library indices) and four weights per texel;
    weights sum to 255. The Jotunheimen slots are fixed in the order
    `rocky_terrain_02, rock_face_03, snow_02, aerial_grass_rock` (library
    indices `3,2,0,7`). Row 0 is north, `+z` is south, and the PNGs load with
    `flipY=false`. IDs are nearest-sampled; weights are linear/mipmapped. Do
    not reorder slots without re-baking the stack and manifest.
21. **The material stack is world-locked with the absolute render origin.**
    The shader uses
    `uv = vWorldPos.xz / uStackExtent + 0.5 + renderOrigin.xz / uStackExtent`;
    it must not use the phase-wrapped `uRenderOrigin` (that is for the tiled
    height/normal atlases). The stack is clamped, not repeated. Material UVs
    use `mod(renderOrigin, tileMeters * uMaterialScale)` and divide by the
    same scaled tile (default 32×); do not modulo the unscaled physical size or
    the pattern jumps on rebase.
22. **Material normals are RG slopes, not RGB normals.** Decode
    `s = (rg * 2 - 1) * slopeScale`; Poly Haven's `nor_dx` is converted to the
    repo's V = +z frame at pack time. Compose as a slope sum with the base
    slope (no TBN, no per-vertex tangents). Rock is triplanar; other materials
    are planar. Material masks use the base normal, so changing material or
    detail strength must not move the baked distribution.
23. **Material height blend and far-field macro.** The shader biases stack
    weights by the packed height, then renormalizes; it blends to the macro
    albedo beyond the material fade. `uMaterialMode == 0` or no library/stack
    must reproduce the old height/slope palette exactly. The infinite page
    does not load materials in this change.
24. **Material data is generated, not hand-edited.** Change the library with
    `npm run bake:materials` / `npm run test:materials`; change the stack with
    `node tools/bake-dem.ts --config tools/dem/jotunheimen.json
    --materials-only`, then `--check-materials` and `npm run test:dem`. Source
    downloads stay in the gitignored `.cache/materials/`; `sharp` is a
    devDependency only.

## Conventions & practices

- TypeScript everywhere (strict mode, ES modules), no linter/formatter config
  yet — match the existing style (small typed modules, JSDoc-ish comments on
  tricky math). Relative imports keep the `.ts` extension and type-only
  imports use `import type` (`allowImportingTsExtensions`,
  `verbatimModuleSyntax`); Node runs the QA tools directly, so extensionless
  imports break them. `tsconfig.json` type-checks `src/` with browser libs
  only, so Node globals cannot leak into app code. `tsconfig.node.json`
  type-checks the Node QA tools and `vite.config.ts`;
  `tools/screenshot-infinite.ts` and `tools/screenshot-dem.ts` are excluded
  because `puppeteer-core` is an optional install.
- Runtime dependencies: `three` only. `typescript`, `@types/three`,
  `@types/node`, `vite`, `pngjs`, `geotiff`, `proj4` and `sharp` are
  devDependencies. `pngjs` is used by the analyzers and the bake tool;
  `geotiff`/`proj4` are only used by the offline DEM bake; `sharp` is only used
  by the offline Poly Haven fetch/pack tool. `puppeteer-core` stays an optional
  `npm install --no-save` for the screenshot drivers. Keep it that way unless
  there's a strong reason.
- Node ≥24 runs the `.ts` QA tools directly via native type stripping. Vite
  transpiles the app and worker; it does not type-check, so `npm run
  typecheck` (or `npm run build`) is the type gate.
- Perf-relevant constants (noise-evaluation count per height sample in
  `terrain-compose.ts` — ~36, the infinite-page `S0`/`LEVELS`/`normalScale`,
  and the DEM dataset's 10 m / 6 LOD / 2× normal configuration) were chosen to
  keep tile streaming hitch-free. Adding channels costs every tile bake;
  profile before loosening them. The checked-in DEM dataset is ~107.5 MB; the
  2× normal PNGs dominate. The packed Poly Haven library is a separate
  ~33.5 MB; the material shader is heavy on SwiftShader (~1 fps) and needs a
  real-GPU pass.
- Procedural tile generation **must stay in workers**; generating 64² height /
  512² normal tiles on the main thread causes visible hitches at tile
  crossings. The procedural source uses up to 2 workers because the 8× normal
  bake is ~7× the work of a 2× build. The pre-baked source fetches checked-in
  tiles with a bounded in-flight queue instead. The 4×4 cache covers the
  visible 3×3 ring plus a prefetch row/column; the infinite normal cache costs
  ~160 MiB, the DEM one is much smaller (640² per layer, 5×5 slots).
- The height function must stay a pure function of `(x, z)`; global passes
  (e.g. erosion simulation) would make streamed tiles disagree at their seams.
- The checked-in DEM tiles and material stack are generated artifacts; change
  them by re-running `npm run bake:dem -- --config tools/dem/jotunheimen.json`,
  or `--materials-only` for a stack-only refresh, not by hand. `npm run
  test:dem` is the dataset gate; `npm run test:materials` is the packed-library
  gate. Source GeoTIFFs and Poly Haven source downloads stay out of git.
- Commits: concise imperative subject lines, e.g. `Fix Sobel z-gradient sign`.
- Deploy = push to `main`. **Push after every successful apply**; the push
  itself runs the deploy workflow (unit/dataset checks, build, Pages publish),
  so there is no separate deploy command. Do not leave apply commits local.
  GitHub Actions publishes `dist/` with the Pages Actions flow. Pages is
  configured with source **GitHub Actions**, not a `gh-pages` branch.
  `vite.config.ts` sets `base: './'` for project-page paths — don't remove
  that.
- Default CI runs `npm run test:infinite`, `npm run test:dem`,
  `npm run test:materials` and `npm run build`; the build script includes
  `tsc --noEmit`. The headless screenshot loops are manual visual-debugging
  tools; set `--chrome` or `CHROME_SHELL_PATH` (the built-in default is from
  the original dev box) and use the SSH verification host in
  `docs/VERIFICATION.md` when screenshots need to be compared.
- Never commit secrets. The verification recipe in `docs/VERIFICATION.md`
  intentionally references credentials only via environment variables.

## Where the tricky math lives

- Sobel → world-space normal derivation: `src/terrain/normals.ts`.
- DEM bake local frame, per-LOD tile sampling and normal halos:
  `tools/dem/grid.ts` + `docs/DEM_DATASET.md`.
- Terrain composition (multi-noise channels, monotone-cubic spline response
  curves, contrast expansion, iterated domain warp, anisotropic ridge
  spines): `src/terrain-compose.ts` + `docs/TERRAIN_RESEARCH.md`.
- Per-LOD snapping, padded rings, parent-square clip and morphs:
  `src/terrain/origins.ts`, `src/terrain/clipmap.ts`,
  `src/terrain/shaders.ts` + `docs/INFINITE_TERRAIN_CONCEPT.md`.
- Toroidal cache and texture uploads: `src/terrain/tile-cache.ts`.
- Material stack bake, weight rules and macro albedo:
  `tools/dem/material-stack.ts` + `docs/MATERIALS.md`.
- Material packing, RG slope conversion and the swatch page:
  `tools/fetch-materials.ts`, `src/terrain/materials.ts`,
  `src/terrain/shaders.ts`.
- Floating origin and tile phase: `src/infinite/main.ts`,
  `src/infinite/flight.ts`.
