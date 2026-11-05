# Spec Delta

## Purpose

Renders a compact, pre-calculated synthetic world whose climate fields select
several biome palettes from one bounded material library, with stable
four-material transition bands and a traversable pre-baked scene.

## ADDED Requirements

### Requirement: Compact synthetic world dataset

The project SHALL provide a deterministic synthetic world no larger than
15.36 km × 15.36 km, baked offline into checked-in height, normal, coarse
height, preview and seam artifacts. The world SHALL use the same local frame,
tile encoding and finite-edge policy as the existing pre-baked DEM scene.

#### Scenario: Reproducible bake

- **WHEN** the biome bake runs twice with the same configuration and seed
- **THEN** the height, normal, stack and macro hashes SHALL match
- **AND** re-baking into a temporary directory SHALL reproduce the checked-in
  manifest hashes

#### Scenario: Finite world edge

- **WHEN** the camera flies beyond the synthetic world bounds
- **THEN** tile requests SHALL clamp to the nearest edge tile
- **AND** the last ring and fog SHALL hide the dataset edge without a crash

#### Scenario: Dataset remains a compact demonstration

- **WHEN** the checked-in biome dataset is measured
- **THEN** it SHALL remain substantially smaller than the 30.72 km Jotunheimen
  dataset
- **AND** the world SHALL still cover at least six biome regions along the
  traversal axis

### Requirement: Climate-driven biome regions

The world SHALL derive temperature, moisture and altitude fields from the
seeded height function and climate noise, and SHALL classify them into six
biome regions: arctic, tundra, boreal, temperate, tropical and arid. Region
boundaries SHALL be warped rather than perfectly straight lines.

#### Scenario: Traverse the world north to south

- **WHEN** the camera traverses the world along its climate axis
- **THEN** it SHALL pass through all six biome regions in a stable order
- **AND** each region SHALL have a distinct palette-driven appearance

#### Scenario: Altitude affects the local palette

- **WHEN** the height or slope changes inside a biome region
- **THEN** snow, rock, vegetation or dry-ground weights SHALL respond to
  altitude, slope, aspect and moisture as configured
- **AND** the biome classification itself SHALL remain continuous

### Requirement: Multiple four-material palettes

The baked material distribution SHALL select each texel's four material IDs
from an authored four-material palette, and SHALL support at least six biome
palettes and five adjacent-pair transition palettes in one stack. Every ID
SHALL resolve to a material in the checked-in library; weights SHALL sum to one
within quantization tolerance.

#### Scenario: Biome palette is selected

- **WHEN** the stack is sampled inside a biome region
- **THEN** its four IDs SHALL be the IDs of that biome's authored palette
- **AND** the sampled weights SHALL select the materials appropriate to the
  local slope, altitude and moisture

#### Scenario: Palette material is missing

- **WHEN** a palette references a material that is not in the packed library
- **THEN** the bake SHALL fail with the palette and missing material named
- **AND** it SHALL NOT write a partial dataset

### Requirement: Stable transition bands between biomes

Every adjacent biome pair SHALL have a fixed four-material transition palette.
Within a band, the ID set SHALL remain constant. A material whose ID leaves the
set SHALL reach zero weight before the change, so nearest-sampled IDs and
linearly sampled weights do not pop. The renderer MUST NOT rely on TAA or
dithering.

#### Scenario: Cross a biome boundary

- **WHEN** the camera crosses from one biome palette to the next
- **THEN** the visible materials SHALL cross-fade without an abrupt ID swap
- **AND** the ID set SHALL remain constant while any of its weights are
  non-zero

#### Scenario: Band edge is continuous

- **WHEN** the baked stack is inspected at the two edges of a transition band
- **THEN** the weights restricted to the band palette SHALL match the adjacent
  biome's restricted weights
- **AND** every non-band material SHALL have zero weight at that edge

### Requirement: Biome-aware macro albedo

The far-field macro albedo SHALL be baked from the same biome palettes and
local weights as the near-field stack, so distant terrain keeps the biome
color variation instead of collapsing to one alpine tint.

#### Scenario: Distance view preserves biomes

- **WHEN** the camera views terrain beyond the material texture fade
- **THEN** the macro albedo SHALL retain distinct biome colors
- **AND** it SHALL NOT show a seam at biome boundaries

#### Scenario: Material-off fallback

- **WHEN** materials are disabled on the biome page
- **THEN** the existing height/slope palette SHALL render
- **AND** the scene SHALL NOT fail because a biome palette is unavailable

### Requirement: Biome traversal page

A pre-baked web page SHALL load the synthetic world through the shared
clipmap renderer and tile cache, display a biome legend with jump-to-biome
controls, and reuse the existing material on/off/debug, height-blend, material
normal, texture-scale, sun and flight controls. The Jotunheimen and infinite
pages SHALL keep their existing behavior.

#### Scenario: Jump to a biome

- **WHEN** the user selects a biome from the legend
- **THEN** the camera SHALL warp to that biome's configured viewpoint
- **AND** the correct material palette SHALL be visible after tiles settle

#### Scenario: Existing pages are unchanged

- **WHEN** the Jotunheimen and infinite pages load after this change
- **THEN** they SHALL use the same manifests, controls and fallback paths as
  before
- **AND** the Jotunheimen page SHALL remain a single-palette scene

### Requirement: Per-material debug view

The material debug view SHALL distinguish every material in the library rather
than mapping all biomes onto four fixed role colors. The view SHALL remain a
read-only shader mode and SHALL NOT alter the baked distribution.

#### Scenario: Debug view across biomes

- **WHEN** the material debug mode is enabled while traversing the world
- **THEN** different biome palettes SHALL be visually distinguishable
- **AND** disabling debug SHALL restore the normal material render without a
  reload

### Requirement: Network-free material assets

The biome page and its bake SHALL use only the packed material library checked
into the repository. The runtime MUST NOT call the Poly Haven API, and a bake
MUST NOT re-download materials that are already packed.

#### Scenario: Offline page load

- **WHEN** the biome page loads with no access to polyhaven.com
- **THEN** all material layers SHALL load from the checked-in library
- **AND** the page SHALL render without a material request failure

#### Scenario: Missing packed material

- **WHEN** a required material is absent from the packed library
- **THEN** the bake SHALL fail with instructions to run the cached material
  pack flow
- **AND** the checked-in dataset SHALL remain untouched

### Requirement: Biome dataset and visual verification

The project SHALL provide network-free dataset checks and a headless visual
loop for the synthetic world. The checks SHALL cover palette validity,
transition continuity, biome coverage, hashes and manifest agreement; the
visual loop SHALL cover every biome, a traversal and material A/B views.

#### Scenario: Dataset check catches a bad transition

- **WHEN** a transition-band weight or palette is corrupted
- **THEN** the dataset check SHALL fail and name the offending band or texel
- **AND** the existing Jotunheimen and material checks SHALL still pass

#### Scenario: Visual loop proves biome coverage

- **WHEN** the biome screenshot loop runs on the verification host
- **THEN** every expected biome capture SHALL exist with no console or page
  errors
- **AND** the analyzer SHALL confirm that biome captures are visually distinct
  and that transition captures do not flash or collapse to a flat color
