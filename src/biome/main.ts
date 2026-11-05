/**
 * Synthetic biome world entry point.
 *
 * The shared pre-baked page owns the renderer, tile streaming, materials and
 * QA hooks. This file binds the manifest-driven biome legend and jump buttons.
 */

import { bootPrebakedPage, reportBootError } from '../prebaked/app.ts';
import type { PrebakedQA } from '../prebaked/app.ts';

declare global {
  interface Window {
    __biome: PrebakedQA;
  }
}

const boot = bootPrebakedPage({
  manifestPath: 'data/biomes/manifest.json',
  qaGlobal: '__biome',
  orbitRadius: 3000,
  cruiseAltitude: 1100,
  initialSpeed: 80,
  biomeAltitude: 900,
  defaultView: {
    x: 0,
    z: -1280,
    yaw: 0,
    pitch: -0.18,
    altitude: 1200,
  },
});

boot.then(({ qa }) => {
  const legend = document.getElementById('biome-legend');
  const current = document.getElementById('biome-current');
  const regions = qa.manifest.biomes?.regions ?? [];
  if (legend) {
    legend.replaceChildren();
    for (const region of regions) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset['biome'] = region.id;
      const [r, g, b] = region.color;
      button.title = `Jump to ${region.label}`;
      const swatch = document.createElement('span');
      swatch.className = 'swatch';
      swatch.style.background = `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;
      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = region.label;
      button.append(swatch, label);
      button.addEventListener('click', () => {
        void qa.warpToBiome(region.id).then(updateCurrent);
      });
      legend.append(button);
    }
  }
  const updateCurrent = (): void => {
    if (!current) return;
    const stats = qa.getBiomeStats();
    current.textContent = `region: ${stats.current ?? 'transition'}`;
  };
  updateCurrent();
  window.setInterval(updateCurrent, 750);
}).catch(reportBootError);
