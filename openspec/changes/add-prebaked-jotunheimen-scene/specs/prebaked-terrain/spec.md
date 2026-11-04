# Spec Delta

## Purpose

The pre-baked terrain capability turns real DEM data into checked-in height and normal tiles and renders them with the shared clipmap renderer, including finite-world edge handling and source attribution.

## ADDED Requirements

### Requirement: Reproducible DEM bake tool

The project SHALL provide a bake tool that accepts a dataset configuration containing the source, geographic bounds, output grid spacing, height scale, normal scale, LOD count, tile size, and output directory. Running the tool with the same configuration SHALL produce the same manifest and tile set.

#### Scenario: Bake from the configured source

- **WHEN** the bake tool runs with the checked-in Jotunheimen configuration
- **THEN** it SHALL download or read the configured source data
- **AND** it SHALL write the manifest, height tiles, normal tiles, and coarse height grid to the configured output directory

#### Scenario: Re-running a completed bake is deterministic

- **WHEN** the bake tool runs twice against the same source snapshot
- **THEN** the tile contents and manifest values SHALL match

### Requirement: Single source grid for all LODs

The bake tool SHALL derive every LOD from one source height grid so that shared world positions agree across levels. It SHALL sample height tiles at each LOD's spacing from that grid and SHALL NOT bake each LOD independently from a different source.

#### Scenario: Adjacent LODs agree at shared positions

- **WHEN** a world position lies on the sample grid of both a fine and a coarse LOD
- **THEN** both height tiles SHALL report the same height
- **AND** the clipmap morph band SHALL blend between matching surfaces

### Requirement: Seam-free normal tiles

Normal tiles SHALL be baked from float heights with a one-texel halo taken from the same global height grid used for the height tiles. Adjacent normal tiles SHALL use the same shared height samples for the normals adjacent to their common boundary, so the normal field is continuous across the boundary after RGB8 quantization.

#### Scenario: Shared normal boundary is continuous

- **WHEN** two horizontally or vertically adjacent normal tiles are inspected across their shared boundary
- **THEN** the boundary-adjacent normals SHALL match the normals derived from the shared global height grid
- **AND** no normal discontinuity beyond the expected one-texel gradient SHALL be visible at the tile boundary

#### Scenario: Heights are baked from float data

- **WHEN** normals are generated
- **THEN** they SHALL be derived from float height samples before normalization and quantization
- **AND** they SHALL NOT be derived from an 8-bit height image

### Requirement: Checked-in Jotunheimen dataset

The repository SHALL include the Jotunheimen dataset under `public/data/jotunheimen/` with a 30.72 km × 30.72 km extent, 10 m source spacing, 6 LODs, and 2× normal resolution. The manifest SHALL record the source, bounds, local frame, configuration, tile ranges, encodings, license, and attribution.

#### Scenario: Dataset is self-describing

- **WHEN** the pre-baked source reads the manifest
- **THEN** it SHALL find the LOD count, tile ranges, spacing, tile size, normal scale, height scale, and encoding needed to load the dataset
- **AND** it SHALL NOT require hardcoded dataset constants in application code

#### Scenario: Source data is not checked in

- **WHEN** the repository is inspected
- **THEN** only derived tiles, manifest, coarse height grid, and supporting documentation SHALL be committed
- **AND** downloaded source GeoTIFFs SHALL remain outside version control

### Requirement: Tile and manifest encoding

Height tiles SHALL be stored as 64×64 little-endian `uint16` normalized heights. Normal tiles SHALL be stored as `64 × normalScale` square RGBA8 PNGs in the object-space encoding `R = N.x`, `G = N.z`, `B = N.y`. The manifest SHALL describe the local frame and the per-LOD tile ranges.

#### Scenario: Runtime decodes the checked-in formats

- **WHEN** the pre-baked source loads a height tile and a normal tile
- **THEN** it SHALL convert the height samples to the renderer's float height payload
- **AND** it SHALL provide the normal texels in the renderer's RGBA8 payload
- **AND** the tile cache SHALL upload both without re-encoding the world layout

### Requirement: Finite-world edge policy

The pre-baked scene SHALL define what happens beyond the dataset bounds. Out-of-range tile requests SHALL be clamped to the nearest available tile or resolved to a defined edge tile, and the scene SHALL bound the camera or use fog so the dataset edge does not read as a hole or an abrupt cliff.

#### Scenario: Camera approaches the dataset edge

- **WHEN** the camera moves toward the outer part of the Jotunheimen dataset
- **THEN** the scene SHALL continue to render terrain using the defined edge policy
- **AND** no missing-texture or background-coloured hole SHALL appear inside the last ring

#### Scenario: Edge is hidden at the horizon

- **WHEN** the camera looks toward the last clipmap ring
- **THEN** fog and the last-ring skirt SHALL hide the finite dataset boundary
- **AND** the visible horizon SHALL not expose an abrupt world edge

### Requirement: Pre-baked showcase scene

The project SHALL provide a `dem.html` scene that uses the shared renderer and pre-baked source with the Jotunheimen configuration. The scene SHALL provide a bounded flight/cruise camera, the existing sun/normal/debug controls, loading and stats feedback, dataset attribution, and a link to the procedural showcase.

#### Scenario: Scene boots from checked-in assets

- **WHEN** `dem.html` loads
- **THEN** it SHALL load the manifest and visible tiles from `public/data/jotunheimen/`
- **AND** it SHALL reach a ready state without generating procedural tiles

#### Scenario: Scene exposes the data source

- **WHEN** the scene is ready
- **THEN** the UI SHALL identify the dataset and credit Kartverket and CC BY 4.0
- **AND** the page SHALL link to the procedural `infinite.html` showcase

### Requirement: Data integrity and seam validation

The project SHALL provide a data-validation command that checks manifest/tile counts, tile dimensions, encodings, height ranges, missing files, and shared-edge continuity for the checked-in dataset. The command SHALL run without network access and SHALL be part of the default test workflow.

#### Scenario: Checked-in dataset passes validation

- **WHEN** the data-validation command runs on a complete Jotunheimen dataset
- **THEN** every expected tile SHALL exist with the declared dimensions and encoding
- **AND** adjacent tile edges SHALL agree
- **AND** the command SHALL exit successfully

#### Scenario: Corrupt or missing tile is detected

- **WHEN** a tile is missing, truncated, or has the wrong dimensions
- **THEN** the validation command SHALL fail with the affected path and reason
- **AND** CI SHALL treat the failure as a build failure

### Requirement: Visual verification for the pre-baked scene

The project SHALL provide a headless screenshot and analysis path for `dem.html` covering the default view, flat normal strength, LOD debug, wireframe, tile grid, and a crack/edge check. The visual check SHALL be documented as a manual verification step, not a replacement for the data-integrity test.

#### Scenario: DEM screenshots are analyzable

- **WHEN** the DEM screenshot driver runs against the built site
- **THEN** it SHALL write screenshots and console diagnostics
- **AND** the analyzer SHALL verify that terrain is present, has variation, has no large holes, and has no ring gaps in the crack view

### Requirement: Source attribution and license

The checked-in dataset, manifest, documentation, and DEM page SHALL credit Kartverket's Nasjonal høydemodell DTM 10 and state the CC BY 4.0 license, including that the data was resampled, tiled, and used to derive normals.

#### Scenario: Attribution is visible

- **WHEN** a user views the DEM scene or reads the dataset documentation
- **THEN** the source, license, and modification statement SHALL be present
- **AND** the attribution SHALL match the manifest metadata
