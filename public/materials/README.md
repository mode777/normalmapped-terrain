# Detail normal material

`detail-diagnostic-normal.png` is the first tiling detail normal tile for the
terrain. It is diagnostic content, not final material art: a broad fBm base, a
ridged layer, an anisotropic diagonal and high-frequency grain. The asymmetric
features make an inverted green channel or a swapped axis obvious under a low
sun.

## Regenerate

```bash
npm run bake:detail
```

The tile is deterministic. `npm run test:infinite` decodes the PNG, rebuilds the
sampled normals from the source height field, and checks the result
byte-for-byte, so a stale or hand-edited asset fails the unit checks.

## Convention

- 512 × 512 RGBA8; the alpha channel is opaque.
- Object-space normals in the terrain's encoding:
  `R = N.x`, `G = N.z`, `B = N.y`. This is the same channel order as the baked
  terrain normal tiles; there is no tangent-space/TBN conversion.
- PNG row 0 is `z = 0`; V increases with `+z`. Load with `flipY = false` so the
  texture's V axis matches the shader's `uv.y = z / tileWorldSize`.
- The height field is periodic in both axes and the normal bake wraps its halo,
  so the tile repeats without a seam.
- Reference generation values: 16 m tile world size, 4 m of relief for
  normalized height 1 (`DETAIL_HEIGHT_SCALE`). This sets the encoded slope
  range, not the final visual relief: the shader's detail strength scales the
  decoded slope. A normal map is scale-free, so changing the tile's world size
  or the strength changes the apparent bumpiness.

The shader computes:

```text
uv     = (vWorldPos.xz + mod(renderOrigin, tileWorldSize)) / tileWorldSize
dm     = texture(detailNormal, uv).xyz * 2 - 1
slope  = slope_base + (dm.xy / dm.z) * detailStrength * fade
N      = normalize(slope.x, 1, slope.y)
```

The offset is computed in JavaScript doubles, so a floating-origin rebase shifts
the UV by an integer number of tile periods and the repeated sample is
unchanged.
