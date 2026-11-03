#!/usr/bin/env node
/**
 * Builds a heightfield for the real-world dataset.
 *
 * Downloads public "terrarium" encoded elevation tiles (Mapzen / AWS
 * Terrain Tiles — SRTM, USGS and friends, no auth required) from
 * https://registry.opendata.aws/terrain-tiles/, stitches them, crops a
 * square window and writes:
 *
 *   public/data/grand-canyon.bin   uint16, res*res, normalised 0..65535
 *   public/data/grand-canyon.json  metadata (world size in metres, relief, credit)
 *
 * Usage:
 *   node tools/build-real-terrain.mjs
 *   node tools/build-real-terrain.mjs --lat 45.976 --lon 7.658 --name matterhorn --out public/data
 */

import { PNG } from 'pngjs';
import { writeFile, mkdir } from 'node:fs/promises';
import { parseArgs } from 'node:util';

const parsed = parseArgs({
  options: {
    name: { type: 'string', default: 'grand-canyon' },
    lat: { type: 'string', default: '36.0980' },
    lon: { type: 'string', default: '-112.0970' },
    size: { type: 'string', default: '1024' },
    zoom: { type: 'string', default: '12' },
    exaggeration: { type: 'string', default: '2.5' },
    out: { type: 'string', default: 'public/data' },
  },
}).values;
const args = {
  ...parsed,
  lat: parseFloat(parsed.lat),
  lon: parseFloat(parsed.lon),
  size: parseInt(parsed.size, 10),
  zoom: parseInt(parsed.zoom, 10),
  exaggeration: parseFloat(parsed.exaggeration),
};

const TILE = 256;
const EQUATOR_M_PER_PIXEL = 156543.03392;

const lonToPx = (lon, z) => ((lon + 180) / 360) * 2 ** z * TILE;
const latToPx = (lat, z) => {
  const rad = (lat * Math.PI) / 180;
  const y = (1 - Math.asinh(Math.tan(rad)) / Math.PI) / 2;
  return y * 2 ** z * TILE;
};

async function fetchTile(z, tx, ty) {
  const url = `https://s3.amazonaws.com/elevation-tiles-prod/v2/terrarium/${z}/${tx}/${ty}.png`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`tile ${url} -> HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const png = PNG.sync.read(buf);
  return png; // may be 256 or 258 px (some tiles carry a 1px skirt)
}

async function main() {
  const { name, lat, lon, size, zoom: z, exaggeration, out } = args;
  console.log(`ROI: ${name} @ (${lat}, ${lon})  ${size}px @ z${z}  vertical ×${exaggeration}`);

  const cx = lonToPx(lon, z);
  const cy = latToPx(lat, z);
  const px0 = Math.round(cx - size / 2);
  const py0 = Math.round(cy - size / 2);

  const tx0 = Math.floor(px0 / TILE), tx1 = Math.floor((px0 + size - 1) / TILE);
  const ty0 = Math.floor(py0 / TILE), ty1 = Math.floor((py0 + size - 1) / TILE);
  console.log(`tiles x:${tx0}..${tx1} y:${ty0}..${ty1}`);

  // stitch the needed tiles into one float elevation mosaic
  const mosaicW = (tx1 - tx0 + 1) * TILE;
  const mosaicH = (ty1 - ty0 + 1) * TILE;
  const mosaic = new Float64Array(mosaicW * mosaicH);

  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      process.stdout.write(`  fetching ${tx}/${ty}…\r`);
      const png = await fetchTile(z, tx, ty);
      const skirt = png.width > TILE ? 1 : 0; // drop overlap skirt if present
      for (let j = 0; j < TILE; j++) {
        const src = ((j + skirt) * png.width + skirt) * 4;
        const dst = ((ty - ty0) * TILE + j) * mosaicW + (tx - tx0) * TILE;
        for (let i = 0; i < TILE; i++) {
          const o = src + i * 4;
          // terrarium encoding: elevation = R*256 + G + B/256 - 32768
          mosaic[dst + i] = png.data[o] * 256 + png.data[o + 1] + png.data[o + 2] / 256 - 32768;
        }
      }
    }
  }
  console.log('\nstitched.');

  // crop + normalise
  const crop = new Float64Array(size * size);
  let min = Infinity, max = -Infinity;
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const v = mosaic[(py0 - ty0 * TILE + j) * mosaicW + (px0 - tx0 * TILE + i)];
      crop[j * size + i] = v;
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }

  const u16 = new Uint16Array(size * size);
  for (let i = 0; i < crop.length; i++) {
    u16[i] = Math.round(((crop[i] - min) / (max - min)) * 65535);
  }

  // true ground metres per pixel (Web Mercator, conformal: same both axes)
  const mPerPx = (EQUATOR_M_PER_PIXEL * Math.cos((lat * Math.PI) / 180)) / 2 ** z;
  const worldSizeX = Math.round(size * mPerPx);
  const worldSizeZ = Math.round(size * mPerPx);
  const heightScale = Math.round((max - min) * exaggeration);

  const south = +(lat - (size / 2) * mPerPx / 111320).toFixed(4);
  const north = +(lat + (size / 2) * mPerPx / 111320).toFixed(4);
  const west = +(lon - (size / 2) * mPerPx / (111320 * Math.cos((lat * Math.PI) / 180))).toFixed(4);
  const east = +(lon + (size / 2) * mPerPx / (111320 * Math.cos((lat * Math.PI) / 180))).toFixed(4);

  const meta = {
    name: 'Grand Canyon (SRTM)',
    source: 'Mapzen / AWS Terrain Tiles, terrarium encoding, zoom 12 (SRTM 1 arc-second + friends)',
    credit: `Elevation: real SRTM radar data via Mapzen/AWS Terrain Tiles (public domain, opendata.aws/terrain-tiles).
Real relief ${Math.round(max - min)} m over ${(worldSizeX / 1000).toFixed(1)} km; vertical scale exaggerated ×${exaggeration} for visualisation.`,
    res: size,
    metersPerPixel: Math.round(mPerPx),
    worldSizeX,
    worldSizeZ,
    heightScale,
    heightMin: Math.round(min),
    heightMax: Math.round(max),
    exaggeration,
    latLonBounds: { south, north, west, east },
  };

  await mkdir(out, { recursive: true });
  await writeFile(`${out}/${name}.bin`, Buffer.from(u16.buffer));
  await writeFile(`${out}/${name}.json`, JSON.stringify(meta, null, 2));

  console.log(`elevation ${Math.round(min)}..${Math.round(max)} m (relief ${Math.round(max - min)} m)`);
  console.log(`world ${worldSizeX} × ${worldSizeZ} m, heightScale ${heightScale} m (×${exaggeration})`);
  console.log(`bounds ${south}..${north}N  ${west}..${east}W`);
  console.log(`wrote ${out}/${name}.bin + ${name}.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
