# Spec Delta

## Purpose

Renders terrain with a bounded library of textured materials selected by a
baked four-slot distribution stack, blended by height and composed in slope
space so the same renderer covers a single-biome DEM and later multi-biome
worlds.

## ADDED Requirements

### Requirement: Bounded material library

The terrain SHALL render from a material library of at most 24 materials. Each
material SHALL provide packed albedo and height, packed object-space slope,
roughness and ambient occlusion, a physical world tile size, and per-material
shading parameters. Material textures SHALL be sampled from texture arrays
rather than from a shared atlas, so layer mips and wrapping remain valid.

#### Scenario: Library loads within the cap

- **WHEN** the scene configures a material library of 20 materials
- **THEN** all 20 layers SHALL be available in the albedo/height and
  normal/roughness arrays
- **AND** each material SHALL use its configured physical tile size

#### Scenario: Library exceeds the cap

- **WHEN** a material manifest declares more than 24 materials
- **THEN** the scene SHALL reject the manifest with a visible error
- **AND** it SHALL NOT render with a partially loaded library

### Requirement: Four-slot material distribution

The baked distribution SHALL store four material IDs and four weights per
texel. Weights SHALL be normalized to sum to one where any material is
present; absent slots SHALL carry zero weight. Every non-zero ID SHALL resolve
to a material in the loaded library.

#### Scenario: Stack sample resolves to materials

- **WHEN** the shader samples a stack texel
- **THEN** it SHALL fetch only the materials with non-zero weight
- **AND** the resulting weights SHALL sum to one within quantization tolerance

#### Scenario: Invalid material ID

- **WHEN** a stack texel references an ID outside the library
- **THEN** the renderer SHALL fall back to the base palette for that texel
- **AND** it SHALL report the invalid ID once rather than per fragment

### Requirement: Stable transition bands

Adjacent material regions SHALL be baked with a fixed four-ID set across a
transition band. A material's weight SHALL reach zero before its ID is removed
from the set, so nearest-sampled IDs and linearly sampled weights do not pop.
The renderer MUST NOT depend on TAA or dithering to hide ID changes.

#### Scenario: Traverse a material boundary

- **WHEN** the camera moves across a baked material transition
- **THEN** the visible materials SHALL cross-fade without an abrupt swap
- **AND** the ID set SHALL remain constant while any of its weights are
  non-zero

#### Scenario: Cross a clipmap ring boundary

- **WHEN** the camera crosses a clipmap ring boundary
- **THEN** the stack SHALL be sampled continuously in world space across rings
- **AND** no material seam or flash SHALL appear

### Requirement: Height-blended albedo

The renderer SHALL blend the active materials' albedo by their normalized
weights. It SHALL bias those weights using each material's height channel and
renormalize, so boundaries follow the material relief rather than a plain
linear cross-fade. A low-frequency macro tint SHALL modulate the blended
albedo.

#### Scenario: Boundary follows relief

- **WHEN** two materials meet over a transition band
- **THEN** the boundary SHALL be displaced by the per-material height sample
- **AND** the result SHALL NOT read as a uniform cross-fade

#### Scenario: Macro variation at distance

- **WHEN** the camera views the terrain beyond the material texture fade
- **THEN** the macro tint SHALL continue to provide large-scale color
- **AND** the far field SHALL NOT collapse to a single flat color

### Requirement: Slope-space normal composition

Material normals SHALL be composed with the base terrain normal as a weighted
slope sum in the existing object-space frame. The renderer MUST NOT require
per-vertex tangents or a TBN matrix. Material masks SHALL continue to use the
base normal so changing material or detail strength does not move the masks.

#### Scenario: Steep rock surface

- **WHEN** the rock material is applied to a steep face
- **THEN** its normal SHALL add relief without flattening the base slope
- **AND** the lighting SHALL remain consistent with the base terrain normal

#### Scenario: Material strength does not move masks

- **WHEN** the material normal strength is varied
- **THEN** the material distribution boundaries SHALL remain fixed
- **AND** only the shading SHALL change

### Requirement: Steepness-driven rock and cliff material

The baked distribution SHALL assign rock and cliff weights primarily from
terrain slope, with height, aspect, curvature and noise as secondary inputs.
Steep faces SHALL use a projection that avoids severe stretching of the rock
material; planar world-XZ projection remains acceptable for the other
materials.

#### Scenario: Cliff reads as rock

- **WHEN** the camera views a steep face at close range
- **THEN** the visible material SHALL be rock or cliff
- **AND** the texture SHALL NOT show severe directional smearing

#### Scenario: Gentle ground does not read as cliff

- **WHEN** the camera views gentle ground at the same altitude
- **THEN** the rock weight SHALL be low
- **AND** grass, heath, scree or snow SHALL dominate as configured

### Requirement: Pre-baked material dataset contract

The pre-baked scene SHALL load a checked-in material manifest that declares the
material library, stack and macro-map paths, stack resolution, encoding,
license and attribution. The bake SHALL generate the stack and macro map from
the source height and terrain derivatives. The dataset validator SHALL reject
missing files, wrong dimensions, out-of-range IDs and non-normalized weights.

#### Scenario: Valid dataset loads

- **WHEN** a scene loads a valid material manifest and stack
- **THEN** the renderer SHALL use the stack to select materials
- **AND** the manifest SHALL remain the source of truth for library and
  resolution values

#### Scenario: Invalid dataset is rejected

- **WHEN** the stack or macro map is missing, mis-sized or references an
  unknown ID
- **THEN** validation SHALL fail with the offending file and field
- **AND** the scene SHALL NOT silently render a corrupted distribution

### Requirement: Material failure and fallback

If a material texture, the stack or the macro map fails to load or decode, the
scene SHALL surface the failure in the status UI and console, and SHALL keep
rendering with the existing palette and base normal rather than rendering
black or corrupted terrain.

#### Scenario: Missing material texture

- **WHEN** one material texture cannot be loaded
- **THEN** the scene SHALL report the material ID
- **AND** it SHALL render the remaining materials and base palette

#### Scenario: Missing stack

- **WHEN** no material stack is configured
- **THEN** the scene SHALL use the existing height/slope palette
- **AND** the infinite page baseline SHALL remain unchanged

### Requirement: Material QA and debug views

The renderer SHALL expose a material debug view that identifies the dominant
material and its weights. The QA loop SHALL capture material swatches, a
boundary close-up, a cliff close-up, a distance view and a material-off
baseline, and the analyzer SHALL assert that the material layer contributes
without breaking the existing checks.

#### Scenario: Material QA set

- **WHEN** the material QA screenshots are captured
- **THEN** the analyzer SHALL verify that material-on differs from
  material-off in the expected regions
- **AND** the existing blank, black-pixel, LOD, tile and crack checks SHALL
  still pass

#### Scenario: Debug view identifies materials

- **WHEN** the material debug view is enabled
- **THEN** each pixel SHALL display a color derived from its dominant
  material or weight set
- **AND** the view SHALL distinguish at least rock, snow and vegetation
