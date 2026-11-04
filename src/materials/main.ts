/**
 * Material swatch page.
 *
 * Loads the packed library and shades each material with its albedo, packed
 * slope and AO. This is a QA page, not the terrain renderer: it verifies that
 * every packed PNG decodes, that the normal convention is readable and that
 * the albedo/slope pair is visually distinct per material.
 */

export {};

interface SwatchMaterial {
  id: string;
  name: string;
  biome: string;
  role: string;
  tileMeters: number;
  textureScale?: number;
  slopeScale: number;
  albedoHeight: string;
  slopeRough: string;
}

interface SwatchManifest {
  materials: SwatchMaterial[];
}

interface MaterialsQA {
  count: number;
  ids: string[];
  ready: boolean;
  error?: string;
}

declare global {
  interface Window {
    __materials?: MaterialsQA;
  }
}

const TILE_PX = 192;
const manifestUrl = new URL('materials/manifest.json', document.baseURI).toString();

function readPixels(bitmap: ImageBitmap): ImageData {
  const canvas = document.createElement('canvas');
  canvas.width = TILE_PX;
  canvas.height = TILE_PX;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  ctx.drawImage(bitmap, 0, 0, TILE_PX, TILE_PX);
  return ctx.getImageData(0, 0, TILE_PX, TILE_PX);
}

async function loadImage(url: string): Promise<ImageBitmap> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
  return createImageBitmap(await response.blob());
}

function shade(
  albedo: ImageData,
  slope: ImageData,
  slopeScale: number,
): ImageData {
  const out = new ImageData(albedo.width, albedo.height);
  const light = { x: -0.48, y: 0.62, z: 0.62 };
  const lightLength = Math.hypot(light.x, light.y, light.z);
  light.x /= lightLength;
  light.y /= lightLength;
  light.z /= lightLength;

  for (let i = 0; i < albedo.data.length; i += 4) {
    const sx = (slope.data[i] / 255 * 2 - 1) * slopeScale;
    const sy = (slope.data[i + 1] / 255 * 2 - 1) * slopeScale;
    const nLength = Math.hypot(sx, sy, 1);
    const nx = sx / nLength;
    const ny = sy / nLength;
    const nz = 1 / nLength;
    const ndl = Math.max(0, nx * light.x + ny * light.y + nz * light.z);
    const ao = 0.65 + 0.35 * (slope.data[i + 3] / 255);
    const shadeValue = (0.32 + 0.95 * ndl) * ao;
    out.data[i] = Math.min(255, Math.round(albedo.data[i] * shadeValue));
    out.data[i + 1] = Math.min(255, Math.round(albedo.data[i + 1] * shadeValue));
    out.data[i + 2] = Math.min(255, Math.round(albedo.data[i + 2] * shadeValue));
    out.data[i + 3] = 255;
  }
  return out;
}

function addSwatch(container: HTMLElement, entry: SwatchMaterial, image: ImageData): void {
  const figure = document.createElement('figure');
  figure.className = 'swatch glass';
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  ctx.putImageData(image, 0, 0);
  const caption = document.createElement('figcaption');
  const name = document.createElement('b');
  name.textContent = entry.name;
  const meta = document.createElement('span');
  const scale = entry.textureScale ?? 1;
  meta.textContent = `${entry.role} · ${entry.tileMeters.toFixed(1)} m × ${scale.toFixed(2)}`;
  caption.append(name, meta);
  figure.append(canvas, caption);
  container.append(figure);
}

async function boot(): Promise<void> {
  const grid = document.getElementById('grid');
  const status = document.getElementById('swatch-status');
  if (!grid || !status) throw new Error('missing swatch page elements');

  window.__materials = { count: 0, ids: [], ready: false };
  const response = await fetch(manifestUrl);
  if (!response.ok) throw new Error(`material manifest: HTTP ${response.status}`);
  const manifest = await response.json() as SwatchManifest;
  status.textContent = `Loading ${manifest.materials.length} materials…`;

  const ids: string[] = [];
  for (const entry of manifest.materials) {
    const [albedoBitmap, slopeBitmap] = await Promise.all([
      loadImage(new URL(entry.albedoHeight, manifestUrl).toString()),
      loadImage(new URL(entry.slopeRough, manifestUrl).toString()),
    ]);
    const albedo = readPixels(albedoBitmap);
    const slope = readPixels(slopeBitmap);
    albedoBitmap.close();
    slopeBitmap.close();
    addSwatch(grid, entry, shade(albedo, slope, entry.slopeScale));
    ids.push(entry.id);
    status.textContent = `Loaded ${ids.length}/${manifest.materials.length}`;
  }

  window.__materials = { count: ids.length, ids, ready: true };
  status.textContent = `${ids.length} materials · packed albedo + slope`;
}

boot().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const status = document.getElementById('swatch-status');
  if (status) {
    status.textContent = `Material swatches failed: ${message}`;
    status.classList.add('error');
  }
  window.__materials = { count: 0, ids: [], ready: false, error: message };
  console.error(error);
});
