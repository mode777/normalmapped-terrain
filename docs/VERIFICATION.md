# Verification recipe

This PoC was developed "blind" — the author could not look at the running
page directly — so the repo ships a repeatable headless QA loop. Use it after
any visual change; a green `vite build` says nothing about whether the scene
actually renders.

## The loop

```bash
npm run build && npx vite preview &          # serve dist/ on :4173
npm install --no-save puppeteer-core         # once, next to the repo
node tools/screenshot.mjs --url http://127.0.0.1:4173/ --out shots
node tools/analyze-shots.mjs shots           # exits non-zero on failure
```

`screenshot.mjs` drives chrome-headless-shell with **SwiftShader**
(software WebGL) via flags `--use-angle=swiftshader
--enable-unsafe-swiftshader`, walks all comparison modes plus the Grand
Canyon dataset, captures 1600×900 PNGs and `console.json` (any console
error/page error/failed request fails the run).

`analyze-shots.mjs` asserts on pixels:

| Check | Meaning |
|---|---|
| terrain `std > 8` per shot | image is not blank/blown out |
| split: right `hf` ≥ 3× left `hf` | **the PoC's core claim**, pixel-verified |
| `hf(B) > 1.2 · hf(A)` | normal-map mode is visibly more detailed |
| `hf(B) ≥ 0.7 · hf(C)` | B recovers most of the reference mesh's detail |

`hf` is the mean absolute luminance delta between adjacent pixels inside a
region — a cheap proxy for high-frequency shading detail. Reference values
from the initial verified build: A=1.8, B=2.9, C=3.1; split differential
7× (procedural) and 20× (Grand Canyon). If your change makes B converge
toward A, you broke the thing this repo exists to demonstrate.

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
default scene at 60fps with ~1% frame time).

## Bugs this loop already caught

1. `new ImageData(uint8Array, w, h)` throws (`Uint8ClampedArray` required) —
   killed boot after heightfield generation; only visible as a boot-timeout
   in `screenshot.mjs`, invisible to `vite build`.
2. Sky rendered as flat warm gray: the sun-elevation palette lerped too much
   horizon color into the zenith. Caught via scanline RGB dumps; fixed by a
   more saturated zenith ramp (see `updateSun()` in `src/main.js`).
3. GLSL duplicate-definition errors from re-including
   `*_pars_fragment` chunks in a `ShaderMaterial` (three.js auto-injects
   them) — caught as `PAGEERROR` console events.

## Manual pass (machines with a real browser)

Open the site, then:

1. **Split compare** — drag the divider slowly across a mountain face; the
   right side should gain crisp crevice/crest shading while the left stays
   smooth. Pause at 50%: both halves must be pixel-consistent in
   perspective (the divider must not "jump").
2. **Normal strength 0 → 2.5** — at 0 the terrain flattens to uniformly lit
   bumps; around 1 it matches the reference mesh most closely; above ~2 it
   starts looking crunchy.
3. **Wireframe on, mesh resolution 48 → 512** — the geometry is deliberately
   coarse; the shading detail should barely change. That is the whole point.
4. **Reference mesh (C)** — should look like B with slightly crisper
   silhouettes; if B looks *sharper* than C, normals are being exaggerated
   (check the strength slider is 1.0).
5. **Grand Canyon dataset** — real SRTM; dramatic inner-gorge shadows at
   default sun position; credit line discloses the ×2.5 vertical
   exaggeration.

## Infinite-terrain page (`infinite.html`)

```bash
npm run test:infinite               # Node tile/LOD/normal math, no browser
npm run build && npx vite preview & # serve dist/ on :4173

node tools/screenshot-infinite.mjs \
  --url http://127.0.0.1:4173/infinite.html --out shots-infinite
node tools/analyze-infinite.mjs shots-infinite
```

`screenshot-infinite.mjs` waits for the worker-generated tile cache, captures
the default view plus a same-pose flat-normal view, auto-cruise movement, a
25 km warp, a 500 km warp, the LOD/wire debug view, and a no-stitch view. It
also writes `console.json`; any console/page error fails the run.

`analyze-infinite.mjs` asserts:

| Check | Meaning |
|---|---|
| no console/page errors | shaders and workers compiled/ran |
| terrain `std > 8` on every shot | not blank / blown out |
| black-pixel fraction `< 8%` | no large holes or unlit massifs |
| normal-map `hf > 1.05 ×` flat-normal `hf` | the map is actually contributing detail |
| LOD debug `std > 20` | the ring-colour view is varied |

The default mesh is deliberately coarse (16 m near-field vertices) and the
normal map is 4× finer (4 m texels). The normal-vs-flat `hf` ratio is therefore
much larger than the previous 2× build; if it collapses toward ~1×, the normal
layer/UV mapping or `normalScale` is wrong.

Reference values from the verified build: 112/112 tiles resident, 122k
triangles, 4 draw calls, 2 workers, normal-map `hf=2.79` vs flat `hf=0.23`,
zero upload errors, 112 resident tiles after both 25 km and 500 km warps.

### Seam/crack test

The stitch bug that produced thin background cracks is easy to reintroduce.
To make it visible, hide the sky, set the renderer clear colour to magenta,
and screenshot the terrain with the normal shading. The shipped build shows
magenta only in the sky; any magenta hairline on the terrain is a real
geometry gap. The QA driver's `07-no-stitch` shot intentionally hides the
stitch mesh so a regression is obvious.

Manual pass on a real GPU:

1. **Auto-cruise** — the camera should advance smoothly at ~70 m/s while
   following the terrain, with no tile-crossing pops.
2. **WASD + mouse** — pointer lock takes control; `Q/E` changes altitude;
   `Shift` boosts. Fly low over a ridge; the terrain guard must keep you out
   of the ground.
3. **Warp / long flight** — let auto-cruise run for a minute; the tile stats
   should settle back to 112 resident, and the terrain should not swim.
4. **Normal strength 0 → 2.5** — at 0 the near field goes smooth; at 1 it is
   honest; above ~2 it gets crunchy.
5. **Show LOD levels / Show tile grid** — ring colours should change at the
   square LOD boundaries; tile colours should form a world-space checkerboard
   with no holes at the seams.
