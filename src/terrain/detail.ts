/**
 * Detail-material UV helpers.
 *
 * The detail tile is locked to absolute world position. The shader receives
 * render-space positions, so the renderer passes the floating-origin offset
 * reduced modulo the tile size. A rebase then changes the UV by an integer
 * number of tile periods and the repeated texture samples identically.
 */

/** Positive modulo in [0, m). */
export function wrapDetailOffset(v: number, m: number): number {
  return ((v % m) + m) % m;
}

/** World-locked UV offset for a repeating detail tile. */
export function detailUvOffset(
  originX: number,
  originZ: number,
  tileWorldSize: number,
): { x: number; y: number } {
  const size = Math.max(1e-3, tileWorldSize);
  return {
    x: wrapDetailOffset(originX, size),
    y: wrapDetailOffset(originZ, size),
  };
}
