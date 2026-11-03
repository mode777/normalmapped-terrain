/**
 * Shared terrain composition: multi-noise channels mapped through spline
 * response curves, iterated domain warping and anisotropic mountain
 * "spines". Used by both the finite dataset (src/terrain-data.js) and the
 * infinite heightfield (src/infinite/heightfield.js).
 *
 * Why not plain fBM: summed octaves are statistically the same everywhere —
 * rounded hills, no plains-vs-peaks contrast, no directed structure. See
 * docs/TERRAIN_RESEARCH.md for the write-up and sources. The structure
 * follows the Minecraft school of terrain (separate low-frequency
 * "continentalness"/"erosion" channels shaped by hand-authored spline
 * curves) plus Inigo Quilez style iterated domain warp and a No Man's Sky
 * style *multiplication* of noises (ridge × spine) to organise crests into
 * chains instead of blobs:
 *
 *   height(p) = baseSpline(continent(p))                        // elevation tiers
 *             + reliefSpline(erosion(p)) ·                      // regional relief
 *               ( mountainAmp · spineMask(p) · ridged(p)^1.25   // ranges
 *               + hillsAmp · hills(p) )                         // rolling ground
 *             + Σ detailLayers · relief·roughness scaling       // normal-map octaves
 *
 * All noise is evaluated in "world metres" so features keep their physical
 * size; every wavelength below is in metres and becomes a frequency of
 * 1 / wavelength.
 */

import { Perlin } from './perlin.js';

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * fBM remapped to [0,1] concentrates hard around 0.5 (roughly Gaussian,
 * σ ≈ 0.15 of the range) because summing octaves averages them out. A
 * response curve designed for [0,1] would therefore only ever see its
 * linear middle. This expands the contrast around 0.5 so channel-driven
 * features actually reach their extremes; the clamp cost is a few percent
 * of saturated area, which reads as basins/plateaus rather than artifacts.
 */
const expand01 = (v, k) => clamp01(0.5 + (v - 0.5) * k);

/**
 * Monotone cubic Hermite spline (Fritsch–Carlson tangents) through the
 * given [x, y] control points. Monotone segments cannot overshoot, so a
 * response curve can safely place steep elevation steps (coastal shelves,
 * plateau edges) without ringing. Outside [x0, xn] the end values are held.
 *
 * This is the "splines" half of the Minecraft technique: it converts a
 * smooth noise channel into terrain height with drama that the raw noise
 * amplitude profile cannot produce.
 *
 * @param {number[][]} points [[x0,y0],[x1,y1],…] at least 2, any order
 * @returns {(x: number) => number}
 */
export function createSpline(points) {
  const pts = points.filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))
    .sort((a, b) => a[0] - b[0]);
  // drop duplicate-x control points (zero-width segments break the tangents)
  const clean = [];
  for (const p of pts) {
    if (!clean.length || p[0] > clean[clean.length - 1][0]) clean.push(p);
  }
  const n = clean.length;
  if (n < 2) throw new Error('createSpline needs ≥ 2 distinct control points');

  const xs = clean.map((p) => p[0]);
  const ys = clean.map((p) => p[1]);
  const dxs = new Array(n - 1);
  const ms = new Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    dxs[i] = xs[i + 1] - xs[i];
    ms[i] = (ys[i + 1] - ys[i]) / dxs[i];
  }

  const t = new Array(n);
  t[0] = ms[0];
  t[n - 1] = ms[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (ms[i - 1] * ms[i] <= 0) {
      t[i] = 0; // local extremum at the knot -> flat tangent
    } else {
      const w1 = 2 * dxs[i] + dxs[i - 1];
      const w2 = dxs[i] + 2 * dxs[i - 1];
      t[i] = (w1 + w2) / (w1 / ms[i - 1] + w2 / ms[i]);
    }
  }

  return function (x) {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (xs[mid] <= x) lo = mid; else hi = mid;
    }
    const h = xs[hi] - xs[lo];
    const s = (x - xs[lo]) / h;
    const s2 = s * s, s3 = s2 * s;
    const h00 = (1 + 2 * s) * (1 - s) * (1 - s);
    const h10 = s * (1 - s) * (1 - s);
    const h01 = s2 * (3 - 2 * s);
    const h11 = s3 - s2;
    return h00 * ys[lo] + h10 * h * t[lo] + h01 * ys[hi] + h11 * h * t[hi];
  };
}

/**
 * Base-elevation response: continentalness → absolute height. The wide
 * shelf around 0.35–0.65 makes broad lowland/plain belts; the steeper
 * ends give basin floors and alpine plateaus.
 */
export const BASE_CURVE_POINTS = [
  [0.00, 0.010],
  [0.20, 0.045],
  [0.35, 0.115],
  [0.50, 0.220],
  [0.65, 0.310],
  [0.85, 0.400],
  [1.00, 0.460],
];

/**
 * Relief response: erosion → how much vertical variance the region gets
 * (1 = rugged young mountains, 0 = eroded flats / depositional basins).
 * The slow lower tail keeps heavily "eroded" regions genuinely calm.
 */
export const RELIEF_CURVE_POINTS = [
  [0.00, 0.03],
  [0.15, 0.06],
  [0.35, 0.18],
  [0.55, 0.45],
  [0.75, 0.78],
  [1.00, 1.00],
];

/**
 * Builds the seeded height function shared by both PoCs.
 *
 * @param {object} cfg
 * seed                   PRNG seed; same seed ⇒ same world.
 * warpWavelength         base wavelength (m) of the warp fields.
 * warpAmplitude          total warp displacement (m); L1 gets 45% of it.
 * continentWavelength    base-elevation channel (m).
 * erosionWavelength      relief channel (m).
 * mountainWavelength     ridged crest noise (m).
 * mountainOctaves        ridged octaves.
 * spineWavelength        mountain-chain mask noise (m).
 * spineAnisotropy        chain elongation along the local range direction.
 * hillsWavelength / hillsOctaves   rolling-ground fBM.
 * roughnessWavelength    per-region detail-roughness modulation (m).
 * mountainAmp / hillsAmp amplitudes of the relief-scaled terms.
 * baseCurve / reliefCurve  spline fns (see createSpline).
 * detailLayers           [{ wavelength, amplitude, octaves }] sub-vertex
 *                        detail; amplitude is further scaled by relief and
 *                        roughness so flats stay clean like depositional
 *                        ground and crests stay rough.
 * @returns {{ heightAt(x: number, z: number): number }}
 */
export function makeTerrainComposer({
  seed,
  warpWavelength = 5200,
  warpAmplitude = 1500,
  continentWavelength = 45000,
  erosionWavelength = 14000,
  mountainWavelength = 5500,
  mountainOctaves = 7,
  spineWavelength = 6000,
  spineAnisotropy = 2.4,
  hillsWavelength = 3500,
  hillsOctaves = 4,
  roughnessWavelength = 2800,
  mountainAmp = 0.78,
  hillsAmp = 0.14,
  baseCurve = createSpline(BASE_CURVE_POINTS),
  reliefCurve = createSpline(RELIEF_CURVE_POINTS),
  detailLayers = [],
}) {
  // Per-channel contrast expansion (see expand01). Tuned so a channel's
  // realistic fbm range reaches its response curve's steep regions.
  const CONT_EXPAND = 1.8;
  const ERO_EXPAND = 2.8;
  const SPINE_EXPAND = 2.2;
  const HILLS_EXPAND = 1.6;
  const ROUGH_EXPAND = 1.5;
  // Where mountain chains are allowed to exist: inside the elongated spine
  // bands, and only on sufficiently high continental ground.
  const SPINE_LO = 0.20, SPINE_HI = 0.52;
  const CONT_GATE_LO = 0.35, CONT_GATE_HI = 0.55;
  const warpA = new Perlin(seed + 1001);
  const warpB = new Perlin(seed + 1009);
  const continent = new Perlin(seed + 2003);
  const erosion = new Perlin(seed + 3003);
  const mountain = new Perlin(seed + 4001);
  const spine = new Perlin(seed + 5001);
  const angle = new Perlin(seed + 6001);
  const hills = new Perlin(seed + 7001);
  const rough = new Perlin(seed + 8001);
  const details = detailLayers.map((_, i) => new Perlin(seed + 9001 + i * 10));

  const fw = 1 / warpWavelength;
  const fc = 1 / continentWavelength;
  const fe = 1 / erosionWavelength;
  const fm = 1 / mountainWavelength;
  const fs = 1 / spineWavelength;
  const fa = 1 / (warpWavelength * 4); // chain orientation turns over ~4× the warp scale
  const fh = 1 / hillsWavelength;
  const fr = 1 / roughnessWavelength;
  const ampL1 = warpAmplitude * 0.45;
  const ampL2 = warpAmplitude;

  function heightAt(x, z) {
    // ---- iterated domain warp (fbm of fbm, IQ style) --------------------
    // q warps the input of r, r warps the terrain's coordinates. The second
    // level is a 2-octave fBM, the first a single octave — enough to break
    // lattice alignment without paying for detail the warp does not need.
    // Offsets decorrelate the two axes of each field.
    const px = x * fw, pz = z * fw;
    const qx = warpA.noise2(px, pz);
    const qz = warpB.noise2(px + 5.2, pz + 1.3);
    const ax = px + 1.6 * qx, az = pz + 1.6 * qz;
    const rx = warpA.fbm(ax + 1.7, az + 9.2, 2);
    const rz = warpB.fbm(ax + 8.3, az + 2.8, 2);
    const wx = x + ampL1 * qx + ampL2 * rx;
    const wz = z + ampL1 * qz + ampL2 * rz;

    // ---- channels (contrast-expanded, see expand01) -----------------------
    const cont = expand01(continent.fbm(x * fc, z * fc, 2) * 0.5 + 0.5, CONT_EXPAND);
    const ero = expand01(erosion.fbm(wx * fe, wz * fe, 3) * 0.5 + 0.5, ERO_EXPAND);
    const ridge = Math.min(mountain.ridged(wx * fm, wz * fm, mountainOctaves), 1.25) / 1.25;

    // Spine mask: low-frequency noise stretched along a direction that
    // itself rotates slowly, so crests organise into curving chains.
    // Evaluated on the warped coords so the bands bend together with the
    // ridged content they organise.
    const ang = 1.4 * angle.noise2(x * fa + 3.1, z * fa);
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const su = (wx * ca + wz * sa) * fs / spineAnisotropy;
    const sv = (-wx * sa + wz * ca) * fs;
    const spine01 = expand01(spine.fbm(su, sv, 2) * 0.5 + 0.5, SPINE_EXPAND);
    const rangeMask = smoothstep(SPINE_LO, SPINE_HI, spine01)
      * smoothstep(CONT_GATE_LO, CONT_GATE_HI, cont);

    const hills01 = expand01(hills.fbm(wx * fh, wz * fh, hillsOctaves) * 0.5 + 0.5, HILLS_EXPAND);
    const rough01 = detailLayers.length
      ? expand01(rough.fbm(wx * fr, wz * fr, 2) * 0.5 + 0.5, ROUGH_EXPAND)
      : 1;

    // ---- spline response + composition ------------------------------------
    const base = baseCurve(cont);
    const relief = reliefCurve(ero);
    const mountains = rangeMask * Math.pow(ridge, 1.25);

    let h = base
      + relief * (mountainAmp * mountains + hillsAmp * hills01 * (1 - 0.5 * rangeMask));

    // ---- sub-vertex detail, gated like eroded ground ----------------------
    if (detailLayers.length) {
      const detailScale = (0.45 + 0.55 * relief) * (0.65 + 0.7 * rough01);
      for (let i = 0; i < detailLayers.length; i++) {
        const layer = detailLayers[i];
        const f = 1 / layer.wavelength;
        h += layer.amplitude * detailScale * details[i].fbm(wx * f, wz * f, layer.octaves ?? 3);
      }
    }

    return clamp01(h);
  }

  return { heightAt };
}
