/**
 * Jotunheimen pre-baked DEM entry point.
 *
 * The shared pre-baked page owns the renderer, tile streaming, materials and
 * QA hooks; this file only supplies the dataset and initial flight pose.
 */

import { bootPrebakedPage, reportBootError } from '../prebaked/app.ts';
import type { PrebakedQA } from '../prebaked/app.ts';

declare global {
  interface Window {
    __dem: PrebakedQA;
  }
}

bootPrebakedPage({
  manifestPath: 'data/jotunheimen/manifest.json',
  qaGlobal: '__dem',
  orbitRadius: 2500,
  cruiseAltitude: 900,
  initialSpeed: 60,
  defaultView: {
    x: 2500,
    z: 0,
    yaw: Math.PI / 2,
    pitch: -0.18,
    altitude: 900,
  },
}).catch(reportBootError);
