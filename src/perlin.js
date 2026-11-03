/**
 * Seeded improved Perlin noise (Ken Perlin, 2002) with fBM,
 * ridged multifractal and domain warping helpers.
 *
 * All noise is evaluated in "world metres" so features keep their
 * physical size independent of the heightfield resolution.
 */

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Perlin {
  constructor(seed = 1337) {
    const rand = mulberry32(seed);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const t = p[i]; p[i] = p[j]; p[j] = t;
    }
    this.perm = new Uint8Array(512);
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
  }

  static fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }
  static lerp(a, b, t) { return a + t * (b - a); }

  static grad(hash, x, y) {
    // 8 gradient directions packed into the low 3 bits
    switch (hash & 7) {
      case 0: return x + y;
      case 1: return -x + y;
      case 2: return x - y;
      case 3: return -x - y;
      case 4: return x;
      case 5: return -x;
      case 6: return y;
      default: return -y;
    }
  }

  /** 2D noise in [-1, 1] */
  noise2(x, y) {
    const X = Math.floor(x) & 255;
    const Y = Math.floor(y) & 255;
    const xf = x - Math.floor(x);
    const yf = y - Math.floor(y);
    const u = Perlin.fade(xf);
    const v = Perlin.fade(yf);
    const p = this.perm;
    const aa = p[p[X] + Y];
    const ab = p[p[X] + Y + 1];
    const ba = p[p[X + 1] + Y];
    const bb = p[p[X + 1] + Y + 1];
    const x1 = Perlin.lerp(Perlin.grad(aa, xf, yf), Perlin.grad(ba, xf - 1, yf), u);
    const x2 = Perlin.lerp(Perlin.grad(ab, xf, yf - 1), Perlin.grad(bb, xf - 1, yf - 1), u);
    return Perlin.lerp(x1, x2, v); // roughly [-1.4, 1.4], usually within ±1
  }

  /** Classical fractional Brownian motion. Returns roughly [-1, 1]. */
  fbm(x, y, octaves = 6, lacunarity = 2.0, gain = 0.5) {
    let sum = 0;
    let amp = 1;
    let norm = 0;
    let fx = x, fy = y;
    for (let o = 0; o < octaves; o++) {
      sum += this.noise2(fx, fy) * amp;
      norm += amp;
      amp *= gain;
      fx *= lacunarity;
      fy *= lacunarity;
    }
    return sum / norm;
  }

  /** Ridged multifractal — sharp crests, good for mountain ranges. Returns [0, ~1.4]. */
  ridged(x, y, octaves = 7, lacunarity = 2.0, gain = 0.5) {
    let sum = 0;
    let amp = 0.55;
    let prev = 1;
    let fx = x, fy = y;
    for (let o = 0; o < octaves; o++) {
      let n = 1 - Math.abs(this.noise2(fx, fy));
      n *= n;
      n *= prev; // crest sharpening: feeds the previous octave back in
      prev = Math.min(n * 1.6, 1.0);
      sum += n * amp;
      amp *= gain;
      fx *= lacunarity;
      fy *= lacunarity;
    }
    return sum;
  }
}
