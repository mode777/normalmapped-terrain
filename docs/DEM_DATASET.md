# Jotunheimen pre-baked DEM

The `dem.html` scene renders a checked-in, offline-baked height and normal
tile set derived from Kartverket's national terrain model. It exists to prove
that the clipmap renderer is source-agnostic: the same geometry, shaders and
tile cache that render the procedural infinite world also render a finite,
real-world DEM.

## Dataset

| Field | Value |
|---|---|
| Subject | Jotunheimen, Norway |
| Source | Kartverket **Nasjonal høydemodell DTM 10** (WCS coverage `nhm_dtm_topo_25833`) |
| Source resolution | 10 m |
| Horizontal CRS | EPSG:25833 (ETRS89 / UTM 33N) |
| Vertical datum | NN2000 |
| Dataset extent | 30.72 km × 30.72 km, centred on Galdhøpiggen |
| Local grid | 3072 × 3072 samples at 10 m |
| Height scale | 2500 m for normalized height 1 |
| LODs | 6 (`S0 = 10 m`) |
| Tile size | 64 height samples |
| Normal scale | 2× (5 m normal texels) |
| Tile cache | 5 × 5 slots per LOD |
| Checked-in size | ~101 MB |

The source is a **DTM** (bare earth), not a DSM. The elevation range in this
window is roughly 480–2469 m.

The checked-in size is dominated by the 2× normal PNGs: 3,080 normal tiles at
128×128 RGBA8 compress to about 24 KB each, ~74 MB total. The height tiles are
~24 MB. Keeping 2× normal resolution was a deliberate quality choice for this
showcase; the source is 10 m, so the extra normal samples are interpolated
rather than new survey detail.

## License and attribution

The source is published by Kartverket under **CC BY 4.0**.

> © Kartverket, Nasjonal høydemodell DTM 10, CC BY 4.0, modified
> (resampled, tiled, normals derived).

The same attribution is stored in `public/data/jotunheimen/manifest.json` and
shown in the DEM page. The source GeoTIFFs are not redistributed in this
repository; only the derived tiles are checked in.

Source metadata:

- WCS capabilities: <https://wcs.geonorge.no/skwms1/wcs.hoyde-dtm-nhm-25833?service=WCS&request=GetCapabilities>
- Dataset catalogue: <https://kartkatalog.geonorge.no/metadata/nasjonal-hoeydemodell-digital-terrengmodell-25833-wcs/0f0a0f38-00c4-4213-a9e5-2d861dc4abb0>
- License: CC BY 4.0, <https://creativecommons.org/licenses/by/4.0/>

## Bake configuration

`tools/dem/jotunheimen.json`:

```json
{
  "dataset": "jotunheimen",
  "source": {
    "type": "kartverket-wcs",
    "url": "https://wcs.geonorge.no/skwms1/wcs.hoyde-dtm-nhm-25833",
    "coverage": "nhm_dtm_topo_25833",
    "crs": "EPSG:25833",
    "chunkPixels": 1536
  },
  "centerE": 145971,
  "centerN": 6851843,
  "sizeMeters": 30720,
  "spacing": 10,
  "heightScale": 2500,
  "normalScale": 2,
  "levels": 6,
  "tileSize": 64,
  "outputDir": "public/data/jotunheimen",
  "license": "CC BY 4.0",
  "attribution": "© Kartverket, Nasjonal høydemodell DTM 10, CC BY 4.0, modified (resampled, tiled, normals derived).",
  "materials": {
    "library": "public/materials/manifest.json",
    "slots": ["rock_face_03", "gravelly_sand", "snow_02", "sparse_grass"],
    "stackSize": 2048,
    "macroSize": 1024,
    "seed": 20260217
  }
}
```

The WCS is requested in 1536² chunks; a single 3000² request times out. The
tool retries failed chunks and caches the responses under
`.cache/dem/<dataset>/` (gitignored). Delete that directory to re-download
from the live service.

## Commands

```bash
# Install the bake tools (geotiff, proj4, pngjs)
npm install

# Bake the full dataset into public/data/jotunheimen
npm run bake:dem -- --config tools/dem/jotunheimen.json

# Rebake only the material stack/macro from the checked-in L0 height tiles
node tools/bake-dem.ts --config tools/dem/jotunheimen.json --materials-only

# Validate the checked-in dataset without network access
npm run test:dem
npm run test:materials

# Validate only, without rebuilding
node tools/bake-dem.ts --check --config tools/dem/jotunheimen.json

# Rebake the material stack into a temp dir and compare hashes
node tools/bake-dem.ts --config tools/dem/jotunheimen.json --check-materials
```

The bake tool can also read a local GeoTIFF for reproducible experiments:

```bash
node tools/bake-dem.ts \
  --config tools/dem/jotunheimen.json \
  --input /path/to/local/dem.tif \
  --out /tmp/jotunheimen-bake
```

## Local frame

The dataset is centred at local `(0,0)`:

```
+x = east
+z = south
row 0 = north
```

The source raster is north-up, so row `j` maps directly to increasing `+z`.
This matches the renderer's coordinate convention and the sun azimuth
convention (`0° = north`, `90° = east`, `180° = south`, `270° = west`).

`bakeHeightTile()` samples the global 10 m grid at each LOD's spacing. All
LODs therefore come from one field, which is required by the clipmap morph
band. Normal tiles sample a one-texel halo from the same grid, so adjacent
tiles use the same world samples at their shared boundary.

## Output layout

```
public/data/jotunheimen/
  manifest.json
  coarse-height.bin          # 1024^2 uint16 normalized heights
  seam-report.json
  preview.png
  stack-ids.png              # 2048^2 RGBA8: 4 material IDs per texel
  stack-weights.png          # 2048^2 RGBA8: 4 normalized weights per texel
  macro-albedo.png           # 1024^2 RGBA8: low-frequency far-field albedo
  h/<level>/<tx>_<ty>.bin     # 64^2 uint16 little-endian, normalized
  n/<level>/<tx>_<ty>.png     # 128^2 RGBA8 object-space normals
```

The manifest records the source, license, attribution, local frame, height
range, tile ranges, encodings, coarse-grid metadata, bake version and seam
report. Runtime tile paths are derived from `/h/` and `/n/` patterns; there is
no per-file list.

The normal encoding is object-space:

```
R = N.x (east)
G = N.z (south)
B = N.y (up)
```

No TBN matrix is used. Heights are stored normalized, then converted to
`Float32Array` at runtime and uploaded as `R16F`.

## Material stack

The material stack is a whole-window 2048² pair (~15 m/texel) plus a 1024²
macro map (~30 m/texel). It is not part of the per-LOD height/normal atlas; the
shader samples it in world space and clamps at the edges.

```
stack-ids.png      2048^2 RGBA8   four material library indices per texel
stack-weights.png  2048^2 RGBA8   four normalized weights (sum 255)
macro-albedo.png   1024^2 RGBA8   weighted palette average + low-frequency noise
```

The first slice uses a fixed four-material palette, in slot order:
`rock_face_03`, `gravelly_sand`, `snow_02`, `sparse_grass`. The IDs are the
library indices of those entries; they are constant across the window, so the
weights cross-fade without an ID-set change.

Weights come from the 10 m L0 grid:

- **Snow:** high normalized height, reduced on steep slopes, boosted on
  north-facing slopes (`-N.z`).
- **Scree:** moderate/steep slopes below the snow line, broken up by band
  noise.
- **Grass:** low, gentle, concave ground.
- **Rock:** the implicit remainder, so steep cliffs are rock-dominant.

The bake also uses convexity/concavity (the Laplacian of the height grid) and
seeded low-frequency value noise. The macro map is the same blend sampled at
30 m and multiplied by a large-scale noise term; the renderer blends to it
beyond the material texture fade.

Row 0 is north and `+z` is south, matching the height tiles and the renderer's
`flipY = false` convention. The stack extent equals the local frame size
(30,720 m). The manifest records the library path, slot IDs, stack/macro
paths, dimensions, extent, encoding, seed and SHA-256 hashes.

## Validation

`npm run test:dem` runs synthetic grid/tile/normal checks and then validates
the checked-in dataset:

1. manifest and per-LOD tile ranges match the configured extent;
2. every height `.bin` and normal PNG exists with the declared dimensions;
3. the L0 height tiles reconstruct the full 10 m grid with no gaps or overlaps;
4. every LOD sample agrees with the same world position in the L0 grid;
5. the seam report's maximum boundary error is within its threshold;
6. the coarse height grid has the right size;
7. a deterministic sample of normal tiles is rebaked from the reconstructed
   L0 grid and compared with the checked-in PNGs;
8. the material stack and macro PNGs exist with the declared dimensions;
9. every material ID is inside the library and the four slots match the
   manifest slot order;
10. every stack texel's four weights sum to 255 and every slot has a
    non-degenerate range;
11. the stack/macro SHA-256 hashes match the manifest.

Reference values for the checked-in 2× dataset: 3,080 tiles, 128×128 normal
tiles, max seam error 1, 18 normal tiles rebaked during validation, a 2048²
material stack and 1024² macro, stack weight means
`0.844 / 0.018 / 0.014 / 0.123` (rock/scree/snow/grass), and ~107.5 MB
including heights, normals, coarse grid, preview, stack and macro. The packed
material library is a separate ~33.5 MB under `public/materials/`.

`node tools/bake-dem.ts --check` runs the same validation without the
synthetic checks. `--check-materials` rebakes the stack/macro into a temporary
directory and compares hashes, which catches a stale dataset or changed seed.

The visual check is separate and manual. See
[VERIFICATION.md](VERIFICATION.md#pre-baked-dem-page).

## Re-bake checklist

1. Delete `.cache/dem/jotunheimen/` if you want a fresh source snapshot.
2. Run `npm run bake:dem -- --config tools/dem/jotunheimen.json`.
3. Run `npm run test:dem` and `npm run test:materials`.
4. Inspect `public/data/jotunheimen/preview.png` for elevation coverage and
   obvious voids. It is a 1024² hillshade (~30 m per preview pixel).
5. Inspect `macro-albedo.png` for the material distribution and `stack-weights.png`
   for the four-slot blend.
6. Run the DEM screenshot loop against the built site.
7. Commit the updated manifest, tiles, coarse grid, seam report, preview,
   material stack/macro and material library as one change.

If only the material palette or weights change, use
`node tools/bake-dem.ts --config tools/dem/jotunheimen.json --materials-only`
instead of a full source re-bake, then run
`node tools/bake-dem.ts --config tools/dem/jotunheimen.json --check-materials`.

The bake does not write a wall-clock timestamp, so re-running against the same
source snapshot produces the same tile contents, stack/macro hashes and
manifest values.
