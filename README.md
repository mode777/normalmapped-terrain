# Normal-Mapped Terrain — a Three.js PoC

**Claim:** a *low-poly* terrain mesh can look dramatically more detailed if the
pixel shader takes its normals from a **normal map baked from a high-resolution
heightfield**, instead of using interpolated vertex normals.

This repo is the proof. Open the demo, switch to **Split compare**, and drag
the divider across the same mesh:

| Side | Normals from | Detail (measured) |
|---|---|---|
| Left — A | `computeVertexNormals()` on a 192² mesh | baseline |
| Right — B | Sobel-baked 2048² normal map, sampled per-pixel | **7–20× more high-frequency shading detail** |

Both halves render the *exact same triangles* (≈74k). No extra geometry, no
tessellation — just better normals in the fragment shader.

![Split-screen comparison](docs/screenshots/procedural-split.png)

## The pipeline

```
heightfield (float, 2048²)  ──Sobel──▶  normal map (RGB, object-space)
        │
        └─bilinear downsample─▶  mesh (192², vertex normals = baseline "A")
```

1. **Heightfield** — either seeded **fBM Perlin + ridged multifractal + domain
   warping** (generated in the browser at load time), or **real SRTM radar
   data** of the Grand Canyon (pre-processed from the public Mapzen/AWS
   terrain tiles, committed as uint16 + metadata).
2. **Normal map** — Sobel-filtered gradient of the float heightfield, in *real
   world units* (`dh/dx` in metres/metres), so the baked normals are an honest
   description of the terrain, not an artistic exaggeration (the *Normal
   strength* slider does the exaggerating, if you want it).
3. **Mesh** — a regular grid displaced by bilinear sampling of the same
   heightfield; `computeVertexNormals()` gives the classic smooth-but-blobby
   baseline.
4. **Shader** — a custom `ShaderMaterial`. The money line in the fragment
   shader:

   ```glsl
   vec3 nm = texture2D(uNormalMap, vUv).xyz * 2.0 - 1.0; // (x, z, up)
   vec3 mapN = normalize(vec3(nm.x * uNormalStrength, nm.z, nm.y * uNormalStrength));
   vec3 N    = normalize(mix(vNormalW, mapN, uNormalBlend)); // vertex ➜ map
   ```

   Because the terrain is an unrotated heightfield, the map is encoded in the
   terrain's local frame (R = east, G = south, B = up) and needs **no TBN
   matrix** — immune to tangent-space mismatch problems that plague normal
   mapping on arbitrary meshes.

## Modes

| Mode | What you see |
|---|---|
| **A — Vertex normals** | Low-res mesh, three.js vertex normals. The baseline. |
| **Split compare** | Same mesh twice via scissor rendering; left A, right B. Drag the divider. |
| **B — Normal map** | Same mesh, normals from the baked map. **The point of the PoC.** |
| **C — Reference mesh** | A 1024² (≈2.1M tris) mesh with true geometric detail — the ground truth B is judged against. |

Measured high-frequency shading detail on the default procedural scene:
`A = 1.8  <  B = 2.9  ≈  C = 3.1` — mode B recovers ≈92% of the reference
mesh's perceived detail with **3.5% of its triangles**.

![Grand Canyon, real SRTM data, split comparison](docs/screenshots/grand-canyon-split.png)
*(Grand Canyon dataset: real SRTM elevation, vertical scale ×2.5 for visualisation)*

## Honest limitations (why this isn't free lunch)

- **Silhouettes don't lie.** Normal maps fake shading, not geometry — the
  horizon and ridge crests at grazing angles still show the coarse mesh
  facets. Only displacement/tessellation fixes that.
- **No self-shadowing from fine detail.** Cast shadows would come from mesh
  geometry, so they'd look smoother than the direct lighting.
- **Aliasing under motion.** High-frequency normals can shimmer; standard
  mipmapping (which we use) softens but does not perfectly solve it —
  mip-filtered normal maps should technically be variance-corrected.
- **Precision matters.** Deriving the normal map from an 8-bit heightmap
  causes terracing; that's why this pipeline computes normals from the
  *float* field and only quantises the (unit-length) normals themselves.

## Data sources

- **Procedural:** seeded improved Perlin noise (in-house `src/perlin.js`),
  fBM 6 octaves + ridged multifractal 8 octaves + domain warp, 2048² samples,
  deterministic per seed.
- **Grand Canyon:** NASA/NGA SRTM 1-arc-second radar elevation via the
  public [Mapzen / AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/)
  (terrarium encoding, public domain). `tools/build-real-terrain.mjs`
  downloads, stitches, crops and normalises it:

  ```bash
  npm install
  npm run terrain:grand-canyon          # rebuild public/data/*
  # or another spot:
  node tools/build-real-terrain.mjs --name matterhorn --lat 45.9763 --lon 7.6586
  ```

## Develop / build / deploy

```bash
npm install
npm run dev        # local dev server
npm run build      # static site in dist/
npm run deploy     # build + push dist/ to the gh-pages branch
```

Live at: **https://mode777.github.io/normalmapped-terrain/**

## Repo map

```
src/perlin.js        seeded improved Perlin + fBM + ridged multifractal
src/terrain-data.js  dataset builders (procedural + SRTM loader), bilinear sampler
src/normalmap.js     Sobel normal-map baking in world units   ← the core
src/geometry.js      displaced grid mesh + computeVertexNormals (baseline)
src/shaders.js       the custom vertex/fragment shaders       ← the core
src/main.js          scene, modes, split rendering, sun, stats
src/ui.js            control panel wiring
tools/               real-data preprocessing (Node)
public/data/         committed Grand Canyon heightfield + metadata
```
