/** Reads the synthetic biome bake configuration from disk. */

import { readFileSync } from 'node:fs';
import type { BiomeWorldConfig } from './types.ts';

export function loadBiomeWorldConfig(path: string): BiomeWorldConfig {
  return JSON.parse(readFileSync(path, 'utf8')) as BiomeWorldConfig;
}
