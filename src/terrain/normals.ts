/**
 * Pure float-height normal baking.
 *
 * The input is a height patch in normalized units with a one-sample halo.
 * The output is RGBA8 object-space normals: R = N.x (east), G = N.z (+z),
 * B = N.y (up). This module has no Three.js or procedural dependencies so the
 * same bake can run in the browser worker and in the offline DEM tool.
 */

/**
 * Bakes a tile of object-space normals from a float height patch.
 *
 * @param heightsHalo (tileSize+2)^2, row-major, one-sample halo
 * @param tileSize    samples per side of the output tile
 * @param spacing     metres between samples
 * @param heightScale metres for heights going 0 -> 1
 * @returns tileSize^2 * 4, RGBA8 (R=N.x, G=N.z, B=N.y)
 */
export function bakeTileNormals(
  heightsHalo: Float32Array,
  tileSize: number,
  spacing: number,
  heightScale: number,
): Uint8Array {
  const out = new Uint8Array(tileSize * tileSize * 4);
  const stride = tileSize + 2;
  const gradScale = heightScale / (8 * spacing);

  for (let j = 0; j < tileSize; j++) {
    const row = (j + 1) * stride;
    const rowUp = j * stride;
    const rowDown = (j + 2) * stride;

    for (let i = 0; i < tileSize; i++) {
      const c = i + 1;

      const tl = heightsHalo[rowUp + c - 1], t = heightsHalo[rowUp + c], tr = heightsHalo[rowUp + c + 1];
      const l = heightsHalo[row + c - 1], r = heightsHalo[row + c + 1];
      const bl = heightsHalo[rowDown + c - 1], b = heightsHalo[rowDown + c], br = heightsHalo[rowDown + c + 1];

      // Sobel X (columns = world x) and Z (rows = world z). The response is
      // divided by 8 * pixelSpacing and multiplied by heightScale before
      // forming N ∝ (-dh/dx, 1, -dh/dz).
      const gx = (tr + 2 * r + br) - (tl + 2 * l + bl);
      const gz = (bl + 2 * b + br) - (tl + 2 * t + tr);

      let nx = -gx * gradScale;
      let ny = 1.0;
      let nz = -gz * gradScale;
      const inv = 1.0 / Math.sqrt(nx * nx + ny * ny + nz * nz);
      nx *= inv; ny *= inv; nz *= inv;

      const o = (j * tileSize + i) * 4;
      out[o] = Math.round((nx * 0.5 + 0.5) * 255);
      out[o + 1] = Math.round((nz * 0.5 + 0.5) * 255);
      out[o + 2] = Math.round((ny * 0.5 + 0.5) * 255);
      out[o + 3] = 255;
    }
  }

  return out;
}
