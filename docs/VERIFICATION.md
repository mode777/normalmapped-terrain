# Verification recipe

The infinite-terrain page was developed "blind" — the author could not look
at the running page directly — so the repo ships a repeatable headless QA
loop. Use it after any visual change; a green `vite build` says nothing about
whether the scene actually renders.

## Default CI vs visual debugging

On every push to `main`, `.github/workflows/deploy.yml` runs
`npm run test:infinite`, `npm run test:dem` and `npm run build`, then deploys
the built site to GitHub Pages. That is the default test suite: Node-only math
and dataset checks plus a production build.

The headless screenshot loop below is deliberately **not** part of the
deployment workflow. Run it locally, or on the SSH verification host, when you
need to debug rendering or compare screenshots before/after a visual change.

## Infinite page loop

```bash
npm run test:infinite                        # Node-only tile/LOD/normal math
npm run typecheck                            # strict TypeScript check
npm run build && npx vite preview &          # serve dist/ on :4173
npm install --no-save puppeteer-core         # once, next to the repo

node tools/screenshot-infinite.ts \
  --url http://127.0.0.1:4173/infinite.html --out shots-infinite
node tools/analyze-infinite.ts shots-infinite
```

`screenshot-infinite.ts` drives chrome-headless-shell with **SwiftShader**
(software WebGL) via flags `--use-angle=swiftshader
--enable-unsafe-swiftshader`. It waits for the worker-generated tile cache,
then captures the default view, a same-pose flat-normal view, auto-cruise
movement, a 25 km warp, a 500 km warp, the LOD/wire debug view, the tile-grid
view and a crack-hunt view. It also writes `console.json`; any console error,
page error or failed request fails the run.

`analyze-infinite.ts` asserts:

| Check | Meaning |
|---|---|
| no console/page errors | shaders and workers compiled and ran |
| terrain `std > 8` on every shot | not blank / blown out |
| black-pixel fraction `< 8%` | no large holes or unlit massifs |
| normal-map `hf > 1.05 ×` flat-normal `hf` | the map is actually contributing detail |
| LOD debug `std > 20` | the ring-colour view is varied |
| `< 0.2 %` magenta in the crack shot | no gaps between clipmap rings |

The mesh uses 2 m near-field vertices and the normal map is 8× finer
(**0.25 m texels**). The normal-vs-flat `hf` ratio is therefore much larger
than early builds; if it collapses toward ~1×, the normal layer/UV mapping or
`normalScale` is wrong.

Reference values from the verified multi-noise terrain build (Nov 2026):
160 resident tiles after streaming settles, 165k triangles, 4 draw calls,
2 workers, normal-map `hf=9.16` vs flat `hf=0.23`, zero upload errors,
160 resident tiles after both 25 km and 500 km warps. The normal cache is
2048 texels per side / ~160 MiB — the WebGL2 ceiling.

## Pre-baked DEM page

The Jotunheimen page uses the same renderer and tile cache with a checked-in
dataset. Validate the data first; the screenshot loop only proves the scene
renders.

```bash
npm run test:dem                              # synthetic + checked-in dataset checks
npm run build && npx vite preview &           # serve dist/ on :4173
npm install --no-save puppeteer-core          # once, next to the repo

node tools/screenshot-dem.ts \
  --url http://127.0.0.1:4173/dem.html --out shots-dem
node tools/analyze-dem.ts shots-dem
```

`test:dem` is network-free. It checks the manifest and all 3,080 tile files,
reconstructs the L0 height grid, verifies every LOD against it, checks the
seam report, checks the coarse height grid, and rebakes a deterministic sample
of normal tiles from the reconstructed heights. It is the gate for changes to
the bake tool or dataset.

`screenshot-dem.ts` waits for `window.__dem`, then captures the default view,
flat normals, orbit movement, a warp, LOD/wireframe, tile grid, the magenta
crack test, and a boundary view. `analyze-dem.ts` asserts:

| Check | Meaning |
|---|---|
| no console/page errors | manifest, PNG decode, shaders and uploads succeeded |
| terrain `std > 8` on every shot | not blank / blown out |
| black-pixel fraction `< 8%` | no large holes or unlit massifs |
| normal-map `hf > 1.05 ×` flat-normal `hf` | the 2× normal tiles contribute detail |
| LOD debug `std > 20` | the ring-colour view is varied |
| tile-grid `std > 20` | the checkerboard is visible |
| `< 0.2 %` magenta in the crack shot | no gaps between clipmap rings |

Reference values from the checked-in 2× dataset (Nov 2026): 3,080 tiles,
~101 MB checked in, 58 resident after priming, 96 resident after a warp,
102k triangles, 4 draw calls, zero upload errors, normal-map `hf=1.69` vs
flat `hf=0.36`, and zero crack-test magenta. The 2× normal PNGs are ~24 KB
each; see [DEM_DATASET.md](DEM_DATASET.md) for the source and bake details.

The boundary shot (`08-boundary.png`) places the camera at the soft flight
bound. The pre-baked source clamps out-of-range tile requests to the nearest
edge tile, and the fog/last-ring skirt hide the finite world edge.

## Where to run the screenshot loop

Any Linux box with Node ≥ 24 (for native `.ts` execution) and a
chrome-headless-shell binary (set `--chrome` or `CHROME_SHELL_PATH`). GitHub
Actions does not run this loop; it is for manual visual debugging and
screenshot comparison. On an older Node, compile or bundle the two QA scripts
first; they have no app runtime dependency.

The dev environment used for this repo had a dedicated verification host
reachable via SSH; credentials live in `SSH_HOST` / `SSH_USER` /
`SSH_PASSWORD` environment variables there — never in files, never in this
repo. Sketch, for that setup:

```bash
ssh "$SSH_USER@$SSH_HOST" 'mkdir -p ~/verify/shots'
scp -r dist verify/shot.js …        # or rsync
ssh "$SSH_USER@$SSH_HOST" \
  'cd ~/verify && (python3 -m http.server 8123 --directory dist &) && \
   sleep 1 && node shot.js; pkill -f "http.server 8123"'
scp "$SSH_USER@$SSH_HOST:verify/shots/*.png" .
```

Notes for that host: 3 vCPU, software WebGL → expect 0–3 fps in headless
shots; that is the *renderer* being slow, not the site (a real GPU runs the
default scene at 60 fps with ~1% frame time).

## Regression notes

These are the class of bug the loop catches and the unit checks do not:

1. `copyTextureToTexture` produced `GL_INVALID_OPERATION` for `R16F` array
   layers on SwiftShader. Height tiles must be uploaded with
   `texSubImage3D`.
2. A single shared finest-level clipmap origin made coarse rings re-sample
   their tiles between texel centres as the camera moved — the terrain
   "swims". Every LOD now snaps to its own spacing.
3. Morphing to the next-coarse height with a bilinear fetch instead of the
   coarse mesh's triangulation opened slivers at grazing angles. The morph
   must go through `coarseMeshHeight()`.

## Manual pass on a real GPU

1. **Auto-cruise** — the camera should advance smoothly at ~70 m/s while
   following the terrain, with no tile-crossing pops.
2. **WASD + mouse** — pointer lock takes control; `Q/E` changes altitude;
   `Shift` boosts. Fly low over a ridge; the terrain guard must keep you out
   of the ground.
3. **Warp / long flight** — let auto-cruise run for a minute; the tile stats
   should settle back to 160 resident, and the terrain should not swim.
4. **Normal strength 0 → 2.5** — at 0 the near field goes smooth; at 1 it is
   honest; above ~2 it gets crunchy.
5. **Show LOD levels / Show tile grid** — ring colours should change at the
   square LOD boundaries; tile colours should form a world-space checkerboard
   with no holes at the seams.

### Seam/crack test

There is no stitch mesh: ring boundaries are a shader-side clip of each ring
to its parent's outer square, with a one-cell pad absorbing the per-level
origin offset. A regression shows up as a thin magenta hairline.

`__infinite.setCrackDebug(true)` hides the sky and clears to magenta;
`08-cracks` is taken at the 500 km warp. `analyze-infinite.ts` counts pink
pixels in the lower half of the frame (guaranteed terrain) and fails above
0.2 %, which is far below what the eye picks up. For a manual check, look at
the shot directly: magenta is only allowed above the horizon.
