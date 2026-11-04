# Infinite Terrain — a Three.js Clipmap PoC

**Claim:** a small set of camera-centred clipmap rings can render an
effectively infinite landscape if heights are displaced in the vertex shader
from a toroidal tile cache and the lighting normals come from per-pixel normal
maps baked from the same float heightfield.

[![Infinite terrain, clipmap rings and normal-mapped detail](docs/screenshots/infinite-default.png)](https://mode777.github.io/normalmapped-terrain/infinite.html)

## What it demonstrates

- **Small mesh, huge world** — one centre block plus nested square rings,
  spacing `2 m · 2^L` for 10 LODs. About 165k triangles and 4 draw calls
  cover roughly 49 km to the fogged horizon.
- **Detail beyond the mesh** — normal maps are baked at **8×** the height-tile
  resolution: 0.25 m normal texels against 2 m near-field vertices. On the
  same view the normal map adds an order of magnitude more high-frequency
  shading detail than flat normals.
- **Streaming without a hitch** — two Web Workers generate 64×64 height tiles
  and 512×512 normal tiles on demand; a 4×4 toroidal cache per LOD covers the
  visible ring plus prefetch margin.

![LOD debug view](docs/screenshots/infinite-lod.png)

## How it works

- **Geometry** — one centre block plus nested rings. Heights are displaced in
  the vertex shader; the CPU never builds a full terrain mesh.
- **LOD snapping** — every ring's origin snaps to **its own** spacing, so a
  coarse ring is rigid between snaps instead of re-sampling its height tile
  every frame (the "swimming" a shared origin causes). Rings are padded by one
  cell and clipped to the parent's outer square, so boundaries stay watertight
  without stitch geometry; the outer few cells morph into the next-coarse
  mesh. A final skirt and fog hide the horizon.
- **Texture buffer** — a `DataArrayTexture` per map, one layer per LOD.
  Height is `R16F`; normals are `RGBA8` baked from float heights at 8× the
  height-tile resolution (2048² cache per layer — the WebGL2 ceiling).
- **Tiles** — a toroidal `4×4` cache per LOD. Until a tile is replaced, world
  tile `(tx,ty)` always lives in slot `(tx mod 4, ty mod 4)`; the shader
  reproduces the mapping. Uploads use direct `texSubImage3D`.
- **Shading** — object-space normals (`R = east`, `G = south/+z`, `B = up`)
  decoded without a TBN matrix; the terrain is an unrotated heightfield, so
  local frame equals world frame.
- **Flight** — pointer-lock free-fly (`WASD`, `Q/E`, `Shift`, wheel) plus an
  optional auto-cruise. A floating origin keeps the shader's tile phase stable
  after long flights.
- **Debug views** — LOD colours, wireframe, and a world-space tile-grid
  checkerboard.

## Controls

| Input | Action |
|---|---|
| Click the scene | capture the mouse |
| `WASD` | fly horizontally |
| `Q` / `E` | descend / climb |
| `Shift` | boost |
| Mouse wheel | change flight speed |
| Panel | auto-cruise, speed, reset, sun, normal strength, wireframe, LOD/tile debug |

## Verification

```bash
npm run test:infinite               # Node-only tile/LOD/normal math checks
npm run build && npx vite preview   # serve dist/ on :4173

npm install --no-save puppeteer-core
node tools/screenshot-infinite.mjs \
  --url http://127.0.0.1:4173/infinite.html --out shots-infinite
node tools/analyze-infinite.mjs shots-infinite
```

The headless QA verifies 160 resident tiles after streaming settles, no
console/page errors, warps to 25 km and 500 km, a magenta-background crack
test, and measures the normal-map contribution against flat normals with an
8× normal-to-mesh resolution ratio. See
[docs/VERIFICATION.md](docs/VERIFICATION.md) for the full recipe and reference
values.

Default CI runs `npm run test:infinite` (the Node-only checks) before building.
The screenshot comparison loop is intentionally **not** part of the Actions
deployment; use the SSH verification host when debugging a visual regression
or comparing screenshots.

## Honest limitations

- The far rings are coarse (up to 1024 m vertex spacing at LOD 9), so
  silhouettes are smooth even though shading detail is not.
- The world ends at 49 km behind fog; that is the configured view distance,
  not a truly infinite mesh.
- Normal maps are RGB8, so extreme grazing-angle lighting can still show
  quantisation/aliasing.
- Tile generation is CPU-bound in workers; a cold boot on a slow phone can
  take several seconds. The 8× normal cache costs ~128 MiB of GPU texture
  memory (the CPU-side buffer is freed after allocation).
- The cache is exactly 2048 texels — the WebGL2 ceiling — which is why the
  spacing was reduced instead of growing it.

## Documentation

| Doc | What's inside |
|---|---|
| [AGENTS.md](AGENTS.md) | Orientation for AI coding agents: repo map, commands, critical invariants, practices |
| [docs/INFINITE_TERRAIN_CONCEPT.md](docs/INFINITE_TERRAIN_CONCEPT.md) | Per-LOD snapping, padded rings with parent-square trim and morphs, toroidal tile cache, floating origin, decisions and measured results |
| [docs/TERRAIN_RESEARCH.md](docs/TERRAIN_RESEARCH.md) | Why plain fBM is bland and the composition this repo adopted: multi-noise channels, spline curves, domain warp, ridge spines |
| [docs/VERIFICATION.md](docs/VERIFICATION.md) | Repeatable headless QA, acceptance metrics, manual test pass |

## Develop / build / deploy

```bash
npm install
npm run dev             # local dev server; open /infinite.html
npm run build           # static site in dist/
npm run test:infinite   # Node-only tile/LOD/normal math checks
```

Deployment is automatic: pushing to `main` runs
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml), which installs
dependencies, runs the unit checks, builds the site and publishes `dist/` to
GitHub Pages via the Pages Actions flow. Deployments are serialized by the
`pages` concurrency group, so the newest push deploys last.

Live at:
**https://mode777.github.io/normalmapped-terrain/infinite.html**

## Repo map

```
.github/workflows/deploy.yml  CI: unit checks, build, Pages deployment
AGENTS.md            orientation for AI coding agents (repo map + invariants)
infinite.html        the PoC entry page
docs/INFINITE_TERRAIN_CONCEPT.md  clipmap/tile-cache concept + results
docs/TERRAIN_RESEARCH.md          terrain-composition research + sources
docs/VERIFICATION.md              headless QA recipe + acceptance metrics
src/perlin.js        seeded improved Perlin + fBM + ridged multifractal
src/terrain-compose.js  multi-noise/spline/warp terrain composition
src/sky-shaders.js   sky gradient + sun disc/halo shaders
src/styles.css       shared UI chrome
src/infinite/        heightfield worker, toroidal tiles, clipmaps, flight
                     controller, infinite shaders/UI
tools/               unit checks + headless QA drivers
```

## License

MIT — see [LICENSE](LICENSE).
