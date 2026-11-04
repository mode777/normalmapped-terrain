# AGENTS.md

Guidance for AI coding agents (and humans in a hurry) working in this repo.

## What this repo is

One proof-of-concept renderer:

- **`infinite.html`** — camera-centred clipmap rings over an effectively
  infinite procedural world. Heights are displaced in the vertex shader;
  normals come from a toroidal per-LOD tile cache in `DataArrayTexture`s; the
  camera free-flies over the terrain.

Ship anything visual only after verifying it renders — see
[docs/VERIFICATION.md](docs/VERIFICATION.md).

## Commands

```bash
npm install
npm run dev                     # vite dev server; open /infinite.html
npm run typecheck               # strict tsc for app + Node tools/config
npm run build                   # typecheck + production build -> dist/

npm run test:infinite           # Node-only math checks; one script, no per-test filter
npm run preview                 # serve dist/ on :4173 (build first)

# headless QA (optional; see docs/VERIFICATION.md)
npm install --no-save puppeteer-core
node tools/screenshot-infinite.ts --url http://127.0.0.1:4173/infinite.html --out shots-infinite
node tools/analyze-infinite.ts shots-infinite

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
Commit and merge when apply finishes; archive on main and commit after archive
or sync. Validate with `openspec validate --all`. In this container `openspec`
may not be on `PATH`; the binary is at `~/.local/bin/openspec`.

## Repo map

| Path | Purpose |
|---|---|
| `.github/workflows/deploy.yml` | Push-to-`main` CI: unit checks, build, GitHub Pages deployment |
| `openspec/` | OpenSpec specs, active changes, archive, and `config.yaml` |
| `.opencode/` | Generated OpenSpec skills + `/opsx-*` commands; do not hand-edit |
| `tsconfig.json` | Strict TypeScript config for browser source (`src/`) |
| `tsconfig.node.json` | Strict config for Node QA tools + `vite.config.ts` |
| `src/perlin.ts` | Seeded improved Perlin, fBM, ridged multifractal |
| `src/terrain-compose.ts` | Multi-noise channels, spline response curves, iterated domain warp, anisotropic ridge spines |
| `src/sky-shaders.ts` | Sky gradient + sun disc/halo shaders |
| `src/styles.css` | Shared UI chrome (panels, stats, sliders, loading overlay) |
| `src/infinite/heightfield.ts` | Infinite seeded height function + per-tile float-Sobel normal baking |
| `src/infinite/origins.ts` | Per-LOD clipmap origins: each level snaps to its own spacing |
| `src/infinite/worker-protocol.ts` | Typed messages shared by the main thread and tile worker |
| `src/infinite/terrain-worker.ts` | Worker wrapper around `generateTile` (transfers buffers) |
| `src/infinite/tiles.ts` | Toroidal per-LOD tile cache, worker queue, `texSubImage3D` uploads |
| `src/infinite/clipmap.ts` | Centre block, padded ring grids, parent-square trim, skirts |
| `src/infinite/shaders.ts` | Clipmap vertex/fragment shaders + LOD/tile debug views |
| `src/infinite/flight.ts` | Free-fly / auto-cruise camera in absolute world doubles |
| `src/infinite/main.ts` | Infinite scene, floating origin, texture arrays, UI, stats |
| `src/infinite/ui.ts` | DOM control wiring; `initUI(callbacks)` returns a setter API |
| `src/infinite/infinite.css` | Page-specific additions to `src/styles.css` |
| `infinite.html` | The PoC entry page |
| `tools/test-infinite.ts` | Node-only tile/LOD/normal math checks |
| `tools/screenshot-infinite.ts` | Headless QA driver for `infinite.html` |
| `tools/analyze-infinite.ts` | Pixel/console assertions for the screenshots |
| `docs/` | INFINITE_TERRAIN_CONCEPT.md, TERRAIN_RESEARCH.md, VERIFICATION.md |

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
16. **Clipmap constants:** `S0=2 m`, `C=24` cells, `LEVELS=10`, outer radius
    ≈49 km, height tile 64², normal tile 512², cache 4×4, `morphCells=3`.
    Ring `L` covers `[C·S_L, 2C·S_L]` = `[48·2^L, 96·2^L] m`; the last ring
    gets the only real skirt. Do not reduce `normalScale` without re-checking
    the detail-vs-mesh ratio. The normal cache is 2048² per layer (10 layers,
    ~160 MiB) — exactly the WebGL2 guaranteed minimum `MAX_TEXTURE_SIZE`, so
    `main.ts` throws rather than growing it.

## Conventions & practices

- TypeScript everywhere (strict mode, ES modules), no linter/formatter config
  yet — match the existing style (small typed modules, JSDoc-ish comments on
  tricky math). Relative imports keep the `.ts` extension and type-only
  imports use `import type` (`allowImportingTsExtensions`,
  `verbatimModuleSyntax`); Node runs the QA tools directly, so extensionless
  imports break them. `tsconfig.json` type-checks `src/` with browser libs
  only, so Node globals cannot leak into app code. `tsconfig.node.json`
  type-checks the Node QA tools and `vite.config.ts`;
  `tools/screenshot-infinite.ts` is excluded because `puppeteer-core` is an
  optional install.
- Runtime dependencies: `three` only. `typescript`, `@types/three`,
  `@types/node`, `vite`/`pngjs` are devDependencies (`pngjs` is Node-only,
  used by `tools/analyze-infinite.ts`). `puppeteer-core` stays an optional
  `npm install --no-save` for the screenshot driver. Keep it that way unless
  there's a strong reason.
- Node ≥24 runs the `.ts` QA tools directly via native type stripping. Vite
  transpiles the app and worker; it does not type-check, so `npm run
  typecheck` (or `npm run build`) is the type gate.
- Perf-relevant constants (noise-evaluation count per height sample in
  `terrain-compose.ts` — ~36, and the infinite-page `S0`/`LEVELS`/`normalScale`)
  were chosen to keep tile streaming hitch-free. Adding channels costs every
  tile bake; profile before loosening them.
- The tile generation **must stay in workers**; generating 64² height /
  512² normal tiles on the main thread causes visible hitches at tile
  crossings. The streamer uses up to 2 workers because the 8× normal bake is
  ~7× the work of a 2× build. The 4×4 cache covers the visible 3×3 ring plus a
  prefetch row/column; the normal cache costs ~160 MiB.
- The height function must stay a pure function of `(x, z)`; global passes
  (e.g. erosion simulation) would make streamed tiles disagree at their seams.
- Commits: concise imperative subject lines, e.g. `Fix Sobel z-gradient sign`.
- Deploy = push to `main`. GitHub Actions runs the unit checks, builds the
  site and publishes `dist/` with the Pages Actions flow. Pages is configured
  with source **GitHub Actions**, not a `gh-pages` branch. `vite.config.ts`
  sets `base: './'` for project-page paths — don't remove that.
- Default CI runs `npm run test:infinite` and `npm run build` only; the build
  script includes `tsc --noEmit`. The headless screenshot loop is a manual
  visual-debugging tool; set `--chrome` or `CHROME_SHELL_PATH` (the built-in
  default is from the original dev box) and use the SSH verification host in
  `docs/VERIFICATION.md` when screenshots need to be compared.
- Never commit secrets. The verification recipe in `docs/VERIFICATION.md`
  intentionally references credentials only via environment variables.

## Where the tricky math lives

- Sobel → world-space normal derivation: `src/infinite/heightfield.ts`.
- Terrain composition (multi-noise channels, monotone-cubic spline response
  curves, contrast expansion, iterated domain warp, anisotropic ridge
  spines): `src/terrain-compose.ts` + `docs/TERRAIN_RESEARCH.md`.
- Per-LOD snapping, padded rings, parent-square clip and morphs:
  `src/infinite/origins.ts`, `src/infinite/clipmap.ts`,
  `src/infinite/shaders.ts` + `docs/INFINITE_TERRAIN_CONCEPT.md`.
- Toroidal cache and texture uploads: `src/infinite/tiles.ts`.
- Floating origin and tile phase: `src/infinite/main.ts`,
  `src/infinite/flight.ts`.
