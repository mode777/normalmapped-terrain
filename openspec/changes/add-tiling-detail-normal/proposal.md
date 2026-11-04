# Proposal

## Why

The terrain's normal detail is capped by the baked atlas. The infinite page's atlas is already at the WebGL2 2048²-per-layer ceiling (~160 MiB, ten layers) and its 0.25 m texels are the finest the 8× bake can afford; the DEM page's 5 m normal texels are far coarser than the 10 m source grid. Raising either means more memory, longer bakes, or regenerating the 101 MB dataset. A small repeating detail normal texture adds sub-atlas shading detail at a few MiB and no extra draw calls, and it is the first layer of the tiling material direction (albedo and roughness later).

The exploration found that the main perceived risk — needing tangents — does not apply: the terrain is an unrotated heightfield over world x/z, the frame is known, and the correct composition is slope addition, not a TBN. The spike should therefore validate the real risks: orientation convention, filtering and aliasing, tiling repetition, cliff stretching, and floating-origin stability.

## What Changes

- Add an optional tiling detail normal layer to the shared terrain fragment path. It is sampled in world x/z, composed with the base normal as an added slope, and renormalized. No vertex tangents, no TBN, and no geometry change.
- Add a seamless diagnostic detail-normal tile in the terrain's object-space encoding (`R=N.x`, `G=N.z`, `B=N.y`), plus the texture configuration for repeating use (mipmaps, anisotropy, no sRGB). A small generator/check keeps the tile reproducible.
- Use world-locked material UVs with a floating-origin-safe offset, and fade the detail by distance or pixel footprint so it does not alias or tile into the far field.
- Keep the existing base normal and albedo output unchanged when detail strength is zero. Keep a separate base normal for the grass/rock/snow masks so detail does not speckle the bands.
- Add a detail-strength control or QA hook and visual coverage: detail off/on, low-sun orientation, close-up, cliff, and floating-origin warp. Extend the analyzer to assert that detail adds high-frequency shading.
- Record the cliff-stretch finding and the planar-vs-triplanar recommendation in a short findings note, so the spike ends with a production decision rather than only a demo.
- Defer albedo/roughness, triplanar, multi-scale or stochastic tiling, parallax occlusion mapping, and mesh displacement.

## Capabilities

### New Capabilities

- `terrain-detail-material`: tiling detail material layers on the terrain, starting with a normal map — object-space/slope encoding and composition, world-locked projection, filtering and fading, strength control, failure handling, and visual verification.

### Modified Capabilities

- None. This adds a detail-material layer on top of the existing terrain-rendering path; it does not change the clipmap, tile-source, texture-layout, or LOD requirements.

## Impact

- **Code:** `src/terrain/shaders.ts` (detail sampling and slope composition), `src/terrain/renderer.ts` (texture, uniforms, setters, disposal), a small detail-material config (tile world size, strength, fade range), `src/terrain/ui.ts` and both page panels if the control is exposed, and the QA hooks in `src/infinite/main.ts` / `src/dem/main.ts`.
- **Assets/tooling:** one checked-in diagnostic detail-normal PNG under `public/materials/`, optionally a small Node generator using the existing `pngjs`; no new runtime or dev dependency.
- **QA/docs:** screenshot drivers and analyzers for both pages, `docs/VERIFICATION.md`, and a short findings note; `npm run typecheck`, `test:infinite`, `test:dem`, and `build`.
- **Performance:** one extra texture fetch and a few ALU ops per fragment; roughly 1–6 MiB of texture with mips; no extra draw calls. The normal atlas and DEM dataset are unchanged.
- **Compatibility:** detail defaults to off/zero strength during the spike, so the current pages render unchanged at the same pose and sun. The existing normal-map QA baseline must zero both normal strengths to remain meaningful.
