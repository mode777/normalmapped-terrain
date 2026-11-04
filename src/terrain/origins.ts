/**
 * Per-level clipmap origins.
 *
 * Every LOD is snapped to *its own* vertex spacing. Snapping only the finest
 * spacing and letting every ring ride that one origin (the previous scheme)
 * makes coarse vertices re-sample their height tile at sub-texel positions
 * each time the fine origin steps: the surface deforms continuously and the
 * terrain "swims".
 *
 * Snapping per level keeps every vertex on an exact height-texel centre
 * between snaps, so each ring is rigid and the terrain only re-triangulates
 * once per S_L of camera travel.
 *
 * Rounding each level directly from the camera (rather than cascading from
 * the previous origin) keeps it centred within half its own spacing and
 * bounds the offset between neighbours: both origins are multiples of
 * S_L / 2, and each is within S_L/2 of the camera, so the difference is
 * 0 or +/- S_L/2. clipmap.ts and the shaders rely on that bound.
 */

/**
 * @param x           absolute world x of the camera (double)
 * @param z           absolute world z of the camera (double)
 * @param baseSpacing finest vertex spacing S0, metres
 * @param levels      number of LOD levels
 * @param out         optional levels*2 values, x/z interleaved
 * @returns snapped world origins
 */
export function snapLevelOrigins(
  x: number,
  z: number,
  baseSpacing: number,
  levels: number,
  out?: Float64Array,
): Float64Array {
  const result = out ?? new Float64Array(levels * 2);

  for (let level = 0; level < levels; level++) {
    const spacing = baseSpacing * 2 ** level;
    result[level * 2] = Math.round(x / spacing) * spacing;
    result[level * 2 + 1] = Math.round(z / spacing) * spacing;
  }

  return result;
}
