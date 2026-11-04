/**
 * Shared sun/atmosphere state for the terrain and sky materials.
 */

import * as THREE from 'three';

export interface SunState {
  direction: THREE.Vector3;
  sunColor: THREE.Color;
  zenith: THREE.Color;
  horizon: THREE.Color;
  ground: THREE.Color;
}

/**
 * Computes the sun direction and the palette used by both the terrain and the
 * sky. Azimuth 0 is north, 90 east, 180 south, 270 west (+z is south).
 */
export function computeSun(azimuthDeg: number, elevationDeg: number): SunState {
  const az = THREE.MathUtils.degToRad(azimuthDeg);
  const el = THREE.MathUtils.degToRad(elevationDeg);
  const direction = new THREE.Vector3(
    Math.sin(az) * Math.cos(el),
    Math.sin(el),
    -Math.cos(az) * Math.cos(el),
  ).normalize();

  const t = THREE.MathUtils.smoothstep(elevationDeg, 10, 42);
  const sunColor = new THREE.Color(1.0, 0.50, 0.22).lerp(new THREE.Color(1.0, 0.98, 0.92), t);
  const zenith = new THREE.Color(0.060, 0.24, 0.70).lerp(new THREE.Color(0.085, 0.11, 0.24), 1 - t);
  const horizon = new THREE.Color(0.52, 0.72, 0.94).lerp(new THREE.Color(0.98, 0.50, 0.24), 1 - t);
  const ground = new THREE.Color(0.14, 0.10, 0.075).lerp(new THREE.Color(0.26, 0.25, 0.23), t);

  return { direction, sunColor, zenith, horizon, ground };
}
