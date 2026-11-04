# Material library

The terrain material textures are packed from [Poly Haven](https://polyhaven.com/)
CC0 assets. Only the packed 512² outputs are checked in; the original 1k
downloads live in the gitignored `.cache/materials/` directory.

## Source and license

- **Source:** [Poly Haven textures](https://polyhaven.com/textures), CC0.
- **Attribution:** Poly Haven (polyhaven.com), CC0. The assets do not require
  attribution; this credit is kept as good practice.
- **Source resolution:** 1k JPG/PNG, resized to 512².
- **Checked in:** `albedo-height.png` and `slope-rough.png` per material, plus
  `manifest.json`. No source JPEG/PNG is committed.

The Poly Haven API requires a unique `User-Agent`; `tools/fetch-materials.ts`
sends `normalmapped-terrain/0.1`. The live API is only used by the offline
fetch tool, never by the demo runtime.

## Packed formats

| File | Channels | Encoding |
|---|---|---|
| `albedo-height.png` | RGB + A | RGB is sRGB albedo; A is the normalized height for height blending (0.5 = neutral) |
| `slope-rough.png` | R + G + B + A | RG is object-space slope; B is roughness; A is ambient occlusion |

Both files are `512 × 512` RGBA8 PNGs. The manifest records a per-material
`slopeScale`; the shader decodes:

```text
s = (rg * 2 - 1) * slopeScale
```

The slope frame is the planar top frame used by the terrain:

```text
R = -dh/dx, G = -dh/dz (V increases with +z)
```

Poly Haven's `nor_dx` (DirectX, green-down) is converted to this frame during
packing. `nor_gl` is used only as a fallback with the green channel flipped.
Load the textures with `flipY = false`; the packed row order matches the
terrain's `V = +z` convention.

The albedo/height array is sampled as sRGB; the slope/rough/ao array is linear
(`NoColorSpace`). The shader composes material slopes with the base normal in
slope space, so there is no TBN.

## Manifest fields

Each entry in `manifest.json` contains:

```text
id, name, biome, role, tileMeters, projection
normalStrength, roughness, specular, slopeScale, averageColor
albedoHeight, slopeRough, hashes, source { id, resolution, maps, hashes }
```

- `tileMeters` is Poly Haven's physical texture size (`dimensions / 1000`), used
  as the default world UV scale.
- `projection` is `planar` for most materials and `triplanar` for cliff/mossy
  rock.
- `averageColor` is the sRGB mean of the albedo; the DEM macro map uses it.
- `hashes` pins the packed PNGs (SHA-256); `source.hashes` records the source
  file MD5s.

## Regenerate and validate

```bash
npm run bake:materials            # fetch/cache/pack all 20
npm run test:materials            # dimensions, hashes, metadata, 24 cap
node tools/fetch-materials.ts --check-manifest
node tools/fetch-materials.ts --only rock_face_03
```

The fetch tool is idempotent for a given source set. The packed library is
about 33.5 MiB; the source downloads are not part of the repository.

## Materials

| ID | Role | Biome | Tile |
|---|---|---|---|
| `snow_02` | snow | arctic | 2.00 m |
| `snow_field_aerial` | snow macro | arctic | 80 m |
| `rock_face_03` | cliff rock | alpine | 2.70 m |
| `rocky_terrain_02` | rock macro | alpine | 90 m |
| `rock_pitted_mossy` | lichen rock | tundra | 1.00 m |
| `lichen_rock` | lichen | tundra | 2.00 m |
| `gravelly_sand` | scree | alpine | 2.48 m |
| `aerial_grass_rock` | alpine grass macro | alpine | 15 m |
| `leafy_grass` | grass | temperate | 2.00 m |
| `sparse_grass` | alpine grass | alpine | 2.00 m |
| `forest_ground_04` | forest floor | boreal | 3.15 m |
| `brown_mud_leaves_01` | leaf litter | boreal | 1.30 m |
| `mossy_rock` | mossy rock | boreal | 3.00 m |
| `forest_leaves_02` | tropical litter | tropical | 3.00 m |
| `red_laterite_soil_stones` | laterite | tropical | 2.00 m |
| `brown_mud_03` | mud | wetland | 1.30 m |
| `sand_01` | sand | arid | 1.50 m |
| `aerial_beach_01` | sand macro | arid | 30 m |
| `dry_ground_rocks` | arid ground | arid | 4.00 m |
| `sandstone_cracks` | cracked earth | arid | 2.00 m |

The first Jotunheimen stack uses `rock_face_03`, `gravelly_sand`, `snow_02`
and `sparse_grass`; the rest are loaded and ready for the synthetic biome
world.
