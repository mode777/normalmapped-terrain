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
| Tile cache | 4 × 4 slots per LOD |
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
  "attribution": "© Kartverket, Nasjonal høydemodell DTM 10, CC BY 4.0, modified (resampled, tiled, normals derived)."
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

# Validate the checked-in dataset without network access
npm run test:dem

# Validate only, without rebuilding
node tools/bake-dem.ts --check --config tools/dem/jotunheimen.json
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
   L0 grid and compared with the checked-in PNGs.

Reference values for the checked-in 2× dataset: 3,080 tiles, 128×128 normal
tiles, max seam error 1, 18 normal tiles rebaked during validation, ~101 MB
including heights, normals, coarse grid and preview.

`node tools/bake-dem.ts --check` runs the same validation without the
synthetic checks.

The visual check is separate and manual. See
[VERIFICATION.md](VERIFICATION.md#pre-baked-dem-page).

## Re-bake checklist

1. Delete `.cache/dem/jotunheimen/` if you want a fresh source snapshot.
2. Run `npm run bake:dem -- --config tools/dem/jotunheimen.json`.
3. Run `npm run test:dem`.
4. Inspect `public/data/jotunheimen/preview.png` for elevation coverage and
   obvious voids. It is a 1024² hillshade (~30 m per preview pixel).
5. Run the DEM screenshot loop against the built site.
6. Commit the updated manifest, tiles, coarse grid, seam report and preview as
   one change.

The bake does not write a wall-clock timestamp, so re-running against the same
source snapshot produces the same tile contents and manifest values.
