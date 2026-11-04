# Terrain composition research

Why plain Perlin-fBM terrain looks bland, what the literature and shipped
games do about it, and what this repo adopted (and rejected). Written
November 2026 while replacing the plain fBM composition with the current
multi-noise/spline/warp pipeline in `src/terrain-compose.js`.

## The diagnosis: why plain fBM terrain is boring

Three independent diagnoses from the sources, all pointing the same way:

1. **fBM is statistically identical everywhere.** Summed octaves produce the
   same character at every point of the map — "once you've seen one patch of
   land, you've basically seen it all" ([dandrino,
   terrain-erosion-3-ways](https://github.com/dandrino/terrain-erosion-3-ways)).
   There are no regions, no plains-vs-peaks contrast, no narrative of
   "somewhere else is different".
2. **The amplitude profile is wrong.** A sum of Perlin octaves is roughly
   Gaussian-distributed, which reads as rounded rolling hills. Real elevation
   is strongly non-Gaussian: flat depositional valleys, plateau shelves,
   dramatic crests. Mojang's rewrite of Minecraft worldgen was motivated by
   exactly this ("the smoothness of Perlin Noise can make it difficult to add
   dramatic terrain" — [Dawnosaur's
   writeup](https://dawnosaur.substack.com/p/how-minecraft-generates-worlds-you)).
3. **No structure.** Real ridgelines are linear, curving, hierarchical
   (drainage basins), while Perlin blobs are isotropic and grid-aligned.
   The fractal character of real terrain comes from *water moving downhill*,
   not from summed octaves (dandrino, again).

A fourth, subtler point we hit directly: **fBM loses contrast**. Because
summing octaves averages them out, `0.5·fbm+0.5` concentrates in roughly
[0.3, 0.7]. Any response curve designed for [0, 1] input only ever sees its
linear middle. Channels must be contrast-expanded before they drive anything
(see `expand01` in `src/terrain-compose.js`).

## Technique survey

### 1. Multi-noise channels + spline response curves (Minecraft) — ADOPTED

Minecraft 1.18+ generates terrain from several independent low-frequency
noise channels — **continentalness** (base elevation / how inland),
**erosion** (how flat), **peaks & valleys** (drama), plus
temperature/humidity/weirdness for biomes — and converts each to height
through **hand-authored spline curves** ([Minecraft
wiki](https://minecraft.wiki/w/World_generation), [Dawnosaur's
writeup](https://dawnosaur.substack.com/p/how-minecraft-generates-worlds-you),
Henrik Kniberg's talk ["Minecraft terrain generation in a
nutshell"](https://www.youtube.com/watch?v=CSa5O6knuwI), [Alan
Zucconi](https://www.alanzucconi.com/2022/06/05/minecraft-world-generation/)).

Why it works:

- *Variety emerges from combinations*: high continent + low erosion + high
  PV → jagged peaks; high erosion → plains. Two players find different
  terrain within a short walk, which is a stated Mojang design goal.
- *Splines give drama*: steep but controlled elevation steps (coastal shelf,
  plateau edge) that smooth noise cannot produce, without discontinuities.
- *Streaming-friendly*: each channel is a pure function of position, so it
  works for chunked/infinite worlds with no global passes.

Implementation notes for us: monotone cubic (Fritsch–Carlson) Hermite splines
— no overshoot, C1-continuous, ~50 lines (`createSpline`). This replaced the
old linear `smoothstep` mask. Minecraft's own impl (decompiled) literally is
a spline table per channel; ours is the same idea in code.

### 2. Domain warping, iterated (Inigo Quilez / No Man's Sky) — ADOPTED

Warp the input coordinates with noise before evaluating the terrain noise.
Inigo Quilez's canonical form is recursive —
[iquilezles.org/articles/warp](https://iquilezles.org/articles/warp/):

```
q = fbm(p + 0.0)
r = fbm(p + 4·q + offset)
f = fbm(p + 4·r)
```

The talk remembered from the No Man's Sky era is Sean Murray's
["Building Worlds in No Man's Sky Using Math(s)"](https://www.youtube.com/watch?v=C9RyEiEzMiU)
(NVIDIA, 2017). Its terrain point, as summarised by the community and the
dandrino README (which links the relevant segment): NMS's "uber noise" is
domain-warped noise, and Murray's stated problem was precisely that "plain
Perlin looks unrealistic as terrain". The talk also advocates combining
noise layers with *multiplication* (not just addition) — multiplication
creates anisotropic, structured features where two fields reinforce.

We adopted both: a two-level warp (level 1 single-octave, level 2 2-octave
fBM — level 1 alone shows lattice artifacts, two full fBM levels buy little
more), and crest *multiplication*: `ridge^1.25 × spineMask × continentGate`,
where the spine is low-frequency noise stretched along a slowly rotating
direction so crests organise into curving chains rather than blobs.
The old code had a single warp level and an isotropic mask — the classic
"blobby ranges" look.

### 3. Hydraulic erosion simulation — NOT ADOPTED (documented for later)

The single biggest realism jump available for a whole-map heightfield:
droplets flow downhill, erode with a bell brush, carry sediment
up to a capacity ∝ slope·speed·water, deposit when capacity drops. Dendritic
gullies, carved valleys and depositional fans *emerge* — no authoring.

References, in the order you want to read them:

- [Sebastian Lague — "Coding Adventure: Hydraulic
  Erosion"](https://www.youtube.com/watch?v=eaXk97ujbPQ): the approachable
  version; his repo implements Hans Theobald Beyer's droplet method.
- [ranmantaru — "Water erosion on heightmap terrain"](https://ranmantaru.com/blog/2011/10/08/water-erosion-on-heightmap-terrain/):
  the complete, compact droplet algorithm with free-use code. Key equations
  and default parameters:
  - capacity `q = max(slope, minSlope) · v · w · Kq`
  - deposit `ds = Kd·(s − q)` when `s > q`; erode `ds = min(Kr·(q − s), 0.99·dh)`
    — **never erode below the next cell's height** (that rule is what keeps
    it stable; digging pits makes spikes)
  - erode through a 4×4 bell brush centred on the droplet, deposit with
    bilinear weights at the *previous* position (deposit behind, not under)
  - direction inertia `d = (d − ∇h)·Ki + ∇h`, gravity `v = √(v² + g·dh)`,
    evaporation `w *= 1 − Kw`
  - defaults `Kq=10, Kw=0.001, Kr=0.9, Kd=0.02, Ki=0.1, minSlope=0.05, g=20`
- [jobtalle.com — "Simulating hydraulic erosion"](https://jobtalle.com/simulating_hydraulic_erosion.html):
  a simpler "snowball" variant, fast enough for 100k droplets in <0.5 s in
  browser JS; good minimal baseline.
- [dandrino, terrain-erosion-3-ways](https://github.com/dandrino/terrain-erosion-3-ways):
  a vectorised grid ("virtual pipes") simulation after Mei et al. 2007 /
  Šťava et al., plus two non-simulation alternatives (see below).
- Thermal erosion (talus angle): move material from cells whose slope exceeds
  a threshold to their lowest neighbour; cheap complement that rounds
  cliff-base scree.

Why not adopted: it is a whole-map, non-local pass. The infinite page
*cannot* have it — the height function must stay pure per (x, z) or streamed
tiles disagree at their seams (ranmantaru notes this explicitly: "not
suitable for 'infinite' generated worlds"). Terrain variety therefore comes
from composition alone.

### 4. River networks, inverse generation — NOT ADOPTED

Generate the river graph first (upstream-growing trees over a Poisson-disc /
Delaunay node set), then derive terrain so rivers flow downhill with volume-
dependent gradients (dandrino's third way, after Génevaux et al. 2016).
Produces the most erosion-like ridge/valley structure of any non-simulation
method, but needs global graph algorithms and careful authoring; overkill for
this PoC. Worth revisiting if we ever want actual rivers.

### 5. Learned generation (GANs) — NOT ADOPTED

Progressive-GAN training on USGS samples yields heightmaps indistinguishable
from real DEMs (dandrino, ~8 GPU-days of training, weak control). Absurd
cost/benefit for a browser PoC; noted only for completeness.

### 6. 3D density noise — NOT APPLICABLE

Minecraft carves overhangs/arches by thresholding full 3D noise
(`terrain_density(x,y,z) - y`). Our contract is a heightfield
(`h(x,z)`); overhangs are structurally impossible. Noted because every
Minecraft explainer mentions it.

## What we shipped (`src/terrain-compose.js`)

```
height(p) = baseSpline(continent(p))                    // elevation tiers
          + reliefSpline(erosion(p)) ·                  // regional relief
            ( 0.78 · spineMask · ridge^1.25             // chains of crests
            + 0.14 · hills )                            // rolling ground
          + Σ detailLayers · (relief·roughness)         // normal-map octaves
```

- `continent` evaluated on unwarped coords (keeps coastline structure),
  everything structural on twice-warped coords (IQ-style `q` then `r`).
- `spineMask = smoothstep(spine) · smoothstep(continentGate)` — elongated
  bands along a noise-rotated direction (NMS-style multiplication).
- Spline curves: monotone cubic, `createSpline`; channels contrast-expanded
  by 1.6–2.8× before mapping (see diagnosis #4).
- Detail octaves scaled by relief×roughness: flats read as depositional
  ground (clean), crests read as young rock (rough) — a cheap stand-in for
  the erosion contrast we did not simulate.
- Same composition at a 45 km continent wavelength plus four sub-vertex
  detail layers (714/154/40/17 m) that live almost entirely in the 8× normal
  map. Seed 20260217 was picked by scoring the spawn view corridor for
  height variance (std 0.110, peaks 0.82 in the first frames).

Cost: ~36 noise evaluations per sample; tile generation stays worker-bound,
and the 8× normal bake dominates the streaming budget.
