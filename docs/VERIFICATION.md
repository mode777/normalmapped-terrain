# Verification recipe

The infinite-terrain page was developed "blind" — the author could not look
at the running page directly — so the repo ships a repeatable headless QA
loop. Use it after any visual change; a green `vite build` says nothing about
whether the scene actually renders.

## The loop

```bash
npm run test:infinite                        # Node-only tile/LOD/normal math
npm run build && npx vite preview &          # serve dist/ on :4173
npm install --no-save puppeteer-core         # once, next to the repo

node tools/screenshot-infinite.mjs \
  --url http://127.0.0.1:4173/infinite.html --out shots-infinite
node tools/analyze-infinite.mjs shots-infinite
```

`screenshot-infinite.mjs` drives chrome-headless-shell with **SwiftShader**
(software WebGL) via flags `--use-angle=swiftshader
--enable-unsafe-swiftshader`. It waits for the worker-generated tile cache,
then captures the default view, a same-pose flat-normal view, auto-cruise
movement, a 25 km warp, a 500 km warp, the LOD/wire debug view, the tile-grid
view and a crack-hunt view. It also writes `console.json`; any console error,
page error or failed request fails the run.

`analyze-infinite.mjs` asserts:

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
2048 texels / ~128 MiB — the WebGL2 ceiling.

## Where to run it

Any Linux box with Node ≥ 20 and a chrome-headless-shell binary (set
`--chrome` or `CHROME_SHELL_PATH`). The dev environment used for this repo
had a dedicated verification host reachable via SSH; credentials live in
`SSH_HOST` / `SSH_USER` / `SSH_PASSWORD` environment variables there —
never in files, never in this repo. Sketch, for that setup:

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
`08-cracks` is taken at the 500 km warp. `analyze-infinite.mjs` counts pink
pixels in the lower half of the frame (guaranteed terrain) and fails above
0.2 %, which is far below what the eye picks up. For a manual check, look at
the shot directly: magenta is only allowed above the horizon.
