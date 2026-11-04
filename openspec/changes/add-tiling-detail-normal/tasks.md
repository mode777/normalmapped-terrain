# Tasks

## 1. Detail tile and shared checks

- [x] 1.1 Add `tools/bake-detail-normal.ts` (reusing `bakeTileNormals` and the existing `pngjs`) to generate a seamless 512² diagnostic detail-normal tile in the object-space encoding (`R=N.x`, `G=N.z`, `B=N.y`) at `public/materials/detail-diagnostic-normal.png`; add a `bake:detail` script. Verify `npm run bake:detail` writes a 512×512 RGBA PNG.
- [x] 1.2 Extend `tools/test-infinite.ts` with a tile check: decode the PNG, compare sampled normals against the wrapped source gradient (catches channel swaps), assert unit length within 8-bit tolerance, and assert wrap-edge continuity. Verify `npm run test:infinite` passes; a locally flipped channel or broken seam fails it.
- [x] 1.3 Document the tile convention in `public/materials/README.md`: encoding, V/`flipY` direction, intended world-size/feature band, and the regeneration command. Verify the documented command reproduces the checked-in tile.

## 2. Renderer texture, uniforms, and QA hook

- [x] 2.1 Add a typed `DetailMaterialOptions` config (texture URL, tile world size, strength, fade start/end) and pass per-page values from `src/infinite/main.ts` and `src/dem/main.ts`: infinite 16 m / 80–250 m, DEM 32 m / 150–500 m, strength default 0. Verify `npm run typecheck` and that both pages boot unchanged with detail off.
- [x] 2.2 Add the detail texture to `ClipmapRenderer`: load and configure `RepeatWrapping`, mipmaps, `anisotropy = min(8, max)`, `NoColorSpace`, and the documented `flipY`; keep a flat placeholder until it loads; surface a load failure and leave detail disabled; dispose it. Verify both pages boot with no console errors, and a missing URL reports the failure and falls back.
- [x] 2.3 Add `uDetailNormal`, `uDetailStrength`, `uDetailUvOffset`, `uDetailTileSize`, `uDetailFadeStart/End`, a pure `detailUvOffset(origin, tileSize)` helper, and `setDetailStrength`; compute the offset from `renderOrigin` in doubles in `ClipmapRenderer.update()`. Verify `npm run typecheck` and a `test:infinite` check that the offset is rebase-invariant (origins differing by `k · renderOriginStep` produce UVs differing by an integer).
- [x] 2.4 Expose `setDetailStrength` on the `__infinite` and `__dem` QA interfaces so the screenshot drivers can toggle it without the UI. Verify a console call updates the uniform and the reflected state value.

## 3. Shader composition

- [x] 3.1 Refactor the base normal decode in `src/terrain/shaders.ts` to slope space and reconstruct `Nbase`, keeping the existing strength behaviour mathematically identical. Verify by capturing `01-default` and `02-normal0` before and after the refactor at the same pose/sun (a temporary worktree or pre-change build) and confirming the images match apart from float noise.
- [x] 3.2 Add the detail sample, object-space decode, slope addition, strength and fade to produce `Nfull`; use `Nbase` for the albedo/`steep`/`slopeShade` masks and `Nfull` for diffuse, hemi and specular. Verify at a close pose that detail off/on changes shading while the grass/rock/snow boundaries stay fixed.
- [x] 3.3 Add the detail after the base normal's LOD cross-fade and derive the UV from `vWorldPos.xz`; verify a ring boundary and a rebase shot show no per-ring seam, shift, or swim.
- [x] 3.4 Add a short comment in `src/terrain/shaders.ts` documenting the slope composition and the no-tangent invariant so a future change does not "fix" it back to a TBN. Verify the comment matches the implemented math.

## 4. UI control and QA capture

- [x] 4.1 Add a detail-strength slider to `infinite.html` and `dem.html`, wire `UICallbacks.onDetailStrength` in `src/terrain/ui.ts`, and update both page states/setters; default 0. Verify both pages update the render and `npm run typecheck` passes.
- [x] 4.2 Update `tools/screenshot-infinite.ts` and `tools/screenshot-dem.ts`: zero both base and detail strengths for `02-normal0`; add detail-off/detail-on at the same pose, a low-sun orientation pair on the diagnostic tile (azimuth 90/270), a close-up, a steep-cliff view, and a close-up before/after a 25 km warp. Verify the scripts run and produce the named shots with no console/page errors.
- [x] 4.3 Update `docs/VERIFICATION.md` with the new shots, what each checks (orientation, close-up, cliff, rebase), and the updated flat-baseline rule. Verify the documented commands run as written.

## 5. Analyzer and findings

- [x] 5.1 Extend `tools/analyze-infinite.ts` and `tools/analyze-dem.ts` to compare detail-on vs detail-off high-frequency energy in a near-field region and keep every existing check; fail if the detail layer adds no energy. Verify the analyzers pass on a successful run and report the detail-off/on values.
- [x] 5.2 Update the normal/detail section of `docs/INFINITE_TERRAIN_CONCEPT.md` (object-space detail encoding, slope composition, world-locked UV, no tangent attributes, fade/strength) and any affected invariant text. Verify the document matches the shader and the spec.
- [x] 5.3 Run both QA loops (or the chosen primary page) and write `docs/TILING_DETAIL_FINDINGS.md`: planar cliff-stretch verdict, chosen tile size/strength/fade per page, orientation/convention notes, aliasing and tiling observations, performance, and the planar-vs-triplanar recommendation. Verify the note references the captured shots and states a concrete recommendation.

## 6. Integration verification

- [x] 6.1 Run `npm run typecheck`, `npm run test:infinite`, `npm run test:dem`, and `npm run build`; verify all pass. Then run the headless infinite and DEM QA loops against `vite preview` and verify every check passes with no console or page errors.

## Workflow follow-up

- Archive the change after review and sync/verify the `terrain-detail-material` spec.
- Commit, merge and push per the project's apply guidance; a push to `main` runs the Pages deploy.
- Consider archiving/syncing the completed `add-prebaked-jotunheimen-scene` change so the project's main specs are current.
- If the detail layer becomes permanent, add its encoding/composition/no-tangent rule to the `AGENTS.md` render invariants.
- When a real GPU is available, run the manual pass from `docs/VERIFICATION.md` (orientation, sparkle, tiling, auto-cruise, warp); SwiftShader/llvmpipe are not representative for anisotropy or specular sparkle.
