# Spec Delta

## Purpose

Adds a tiling detail material layer to the terrain, beginning with a normal map, so high-frequency shading detail can be added without growing the baked normal atlas or changing the clipmap geometry.

## ADDED Requirements

### Requirement: Detail layer is additive and opt-in

The terrain renderer SHALL support an optional tiling detail normal layer. When the layer is disabled or its strength is zero, the rendered terrain SHALL match the existing base-normal and albedo output.

#### Scenario: Disabled detail preserves the current render

- **WHEN** the detail layer is disabled or its strength is zero
- **THEN** the terrain SHALL use only the base normal map and existing albedo bands
- **AND** the rendered result SHALL match the pre-change baseline at the same camera pose and sun

#### Scenario: Detail can be enabled independently

- **WHEN** the detail strength is raised above zero
- **THEN** the detail SHALL affect shading without changing the base normal strength or the mesh

### Requirement: World-locked material projection

The detail layer SHALL sample a tiling material projection locked to absolute world position. Camera movement and floating-origin rebases SHALL NOT shift, swim, or pop the detail pattern.

#### Scenario: Camera crosses tile boundaries

- **WHEN** the camera moves across terrain tile boundaries
- **THEN** the detail pattern SHALL remain fixed to the terrain surface
- **AND** no visible pattern shift SHALL occur

#### Scenario: Floating origin rebases

- **WHEN** the scene rebases its floating origin after a long flight
- **THEN** the detail pattern at a fixed world position SHALL be unchanged modulo the tile period
- **AND** the pattern SHALL NOT jump or swim

### Requirement: Detail preserves the base normal

The detail layer SHALL perturb the base terrain normal without requiring per-vertex tangent or bitangent data, and SHALL NOT flatten or cancel the base slope on steep terrain.

#### Scenario: Detail on a steep slope

- **WHEN** the detail is applied to steep terrain
- **THEN** the detail SHALL add shading variation without making the surface flatter than the base normal
- **AND** the lighting SHALL remain consistent with the base normal on gentle terrain

#### Scenario: No new vertex attributes are required

- **WHEN** the detail layer is enabled
- **THEN** the renderer SHALL NOT require new per-vertex UV, tangent, or bitangent attributes
- **AND** the clipmap geometry SHALL remain unchanged

### Requirement: Band-limited detail and anti-aliasing

The detail layer SHALL be band-limited to a configured world-space feature scale and SHALL fade out with distance or pixel footprint so it does not alias in the far field.

#### Scenario: Close-up shows detail

- **WHEN** the camera is near the terrain
- **THEN** the configured detail scale SHALL be visible in the shading
- **AND** the detail SHALL remain attached to the terrain during motion

#### Scenario: Far view is smooth

- **WHEN** the camera views terrain beyond the configured detail range
- **THEN** the detail SHALL be faded out
- **AND** no repeating grid or high-frequency sparkle SHALL dominate the far field

### Requirement: Detail map encoding and orientation

The detail normal tile SHALL use the terrain's object-space normal convention (`R = N.x`, `G = N.z`, `B = N.y`). A diagnostic check SHALL confirm that detail highlights respond to the sun direction consistently with the base normals.

#### Scenario: Orientation check

- **WHEN** the diagnostic detail tile is lit from opposite sun azimuths
- **THEN** the highlights SHALL move to the side facing the sun
- **AND** the detail SHALL NOT read as inverted bumps or pits

#### Scenario: Encoding matches the base normal tiles

- **WHEN** a detail tile is sampled
- **THEN** it SHALL be decoded with the same channel convention as the base normal tiles
- **AND** it SHALL NOT introduce a second tangent-space convention

### Requirement: Material masks use the base normal

The procedural albedo and slope masks SHALL be derived from the base terrain normal, not the detail-perturbed normal. Changing the detail strength SHALL NOT change the grass, rock, sand, or snow band boundaries.

#### Scenario: Detail strength does not move material bands

- **WHEN** the detail strength is varied from zero to its maximum
- **THEN** the grass, rock, sand, and snow boundaries SHALL remain fixed
- **AND** only the shading detail SHALL change

### Requirement: Detail failure is visible

If the detail texture cannot be loaded or decoded, the page SHALL surface the failure in the loading or status UI and the console, and SHALL fall back to rendering without detail rather than rendering a broken material.

#### Scenario: Missing detail texture

- **WHEN** the detail texture fails to load
- **THEN** the page SHALL report the failure
- **AND** the terrain SHALL continue rendering with the base normal only

### Requirement: Visual verification covers the detail layer

The visual QA loop SHALL capture the detail layer off and on at the same pose, a low-sun orientation view, a close-up, a steep-cliff view, and a floating-origin warp, and SHALL assert that the detail adds high-frequency shading without breaking the existing checks.

#### Scenario: Detail QA set

- **WHEN** the detail QA screenshots are captured
- **THEN** the analyzer SHALL compare detail-on and detail-off high-frequency energy
- **AND** the existing blank, black-pixel, LOD, tile, and crack checks SHALL still pass
