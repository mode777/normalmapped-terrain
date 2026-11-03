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
