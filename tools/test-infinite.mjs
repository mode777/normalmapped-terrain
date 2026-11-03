#!/usr/bin/env node
/**
 * Unit checks for the infinite-terrain tile math.
 *
 * These are deliberately Node-only: no WebGL, no browser. They catch the
 * coordinate/LOD mistakes that would otherwise show up as cracks or century-
 * scale terrain in the headless screenshots.
 */

import assert from 'node:assert/strict';
import { makeHeightField, generateTile, bakeTileNormals } from '../src/infinite/heightfield.js';

const hf = makeHeightField(12345);
const near = (a, b, eps, msg) => {
  assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b}`);
};

// ---- determinism ----------------------------------------------------------
{
  const a = hf.heightAt(1234.5, -987.25);
  const b = hf.heightAt(1234.5, -987.25);
  assert.equal(a, b, 'heightAt is deterministic');
  const other = makeHeightField(54321).heightAt(1234.5, -987.25);
  assert.notEqual(a, other, 'different seeds give different fields');
  assert.ok(a >= 0 && a <= 1, 'height is normalised');
}

// ---- flat normal encoding -------------------------------------------------
{
  const tileSize = 5;
  const halo = new Float32Array((tileSize + 2) ** 2).fill(0.5);
  const normals = bakeTileNormals(halo, tileSize, 8, 1500);
  for (let i = 0; i < tileSize * tileSize; i++) {
    near(normals[i * 4], 128, 1, 'flat R');
    near(normals[i * 4 + 1], 128, 1, 'flat G');
    assert.equal(normals[i * 4 + 2], 255, 'flat B');
    assert.equal(normals[i * 4 + 3], 255, 'alpha');
  }
}

// ---- gradient sign --------------------------------------------------------
{
  const tileSize = 5;
  const halo = new Float32Array((tileSize + 2) ** 2);
  const stride = tileSize + 2;
  for (let j = 0; j < stride; j++) {
    for (let i = 0; i < stride; i++) halo[j * stride + i] = 0.5 + i * 0.01;
  }
  const normals = bakeTileNormals(halo, tileSize, 8, 1500);
  const r = normals[(2 * tileSize + 2) * 4];
  const g = normals[(2 * tileSize + 2) * 4 + 1];
  const b = normals[(2 * tileSize + 2) * 4 + 2];
  assert.ok(r < 128, 'positive dh/dx gives negative N.x');
  near(g, 128, 1, 'no z gradient -> G=128');
  assert.ok(b > 128, 'up component is positive');
}

// ---- height extraction matches the height function ------------------------
{
  const tileSize = 8;
  const baseSpacing = 8;
  const level = 1;
  const spacing = baseSpacing * 2 ** level;
  const tile = generateTile(hf, { level, tx: 3, ty: -2, tileSize, baseSpacing, heightScale: 1500, normalScale: 2 });
  for (let j = 0; j < tileSize; j++) {
    for (let i = 0; i < tileSize; i++) {
      const expected = hf.heightAt((3 * tileSize + i) * spacing, (-2 * tileSize + j) * spacing);
      near(tile.heights[j * tileSize + i], expected, 1e-6, `height ${i},${j}`);
    }
  }
}

// ---- adjacent tiles agree at shared sample positions ----------------------
{
  const tileSize = 8;
  const baseSpacing = 8;
  const normalScale = 2;
  const opts = { level: 0, baseSpacing, heightScale: 1500, normalScale };

  const a = generateTile(hf, { ...opts, tx: 0, ty: 0, tileSize });
  const b = generateTile(hf, { ...opts, tx: 1, ty: 0, tileSize });
  const big = generateTile(hf, { ...opts, tx: 0, ty: 0, tileSize: tileSize * 2 });

  for (let j = 0; j < tileSize; j++) {
    for (let i = 0; i < tileSize; i++) {
      near(a.heights[j * tileSize + i], big.heights[j * tileSize * 2 + i], 1e-6, `tile A height ${i},${j}`);
      near(b.heights[j * tileSize + i], big.heights[j * tileSize * 2 + tileSize + i], 1e-6, `tile B height ${i},${j}`);
    }
  }

  // Normals at the shared edge must be baked from the same halo. Compare
  // the last normal column of A with the same column of the big tile.
  const normalRes = tileSize * normalScale;
  const bigNormalRes = tileSize * 2 * normalScale;
  for (let j = 0; j < normalRes; j++) {
    const ai = (j * normalRes + normalRes - 1) * 4;
    const bi = (j * bigNormalRes + normalRes - 1) * 4;
    for (let c = 0; c < 4; c++) {
      assert.equal(a.normals[ai + c], big.normals[bi + c], `edge normal ${j},${c}`);
    }
  }
}

// ---- 4x normal tile shape -------------------------------------------------
{
  const tileSize = 8;
  const normalScale = 4;
  const tile = generateTile(hf, {
    level: 0,
    tx: 0,
    ty: 0,
    tileSize,
    baseSpacing: 16,
    heightScale: 1500,
    normalScale,
  });
  assert.equal(tile.heights.length, tileSize * tileSize, 'height tile size');
  assert.equal(tile.normals.length, (tileSize * normalScale) ** 2 * 4, '4x normal tile size');
  for (const v of tile.normals) assert.ok(Number.isFinite(v), 'normal byte is finite');
}

// ---- LOD samples agree where they share a world position ------------------
{
  const tileSize = 8;
  const baseSpacing = 8;
  const normalScale = 2;
  const l0 = generateTile(hf, { level: 0, tx: 0, ty: 0, tileSize, baseSpacing, heightScale: 1500, normalScale });
  const l1 = generateTile(hf, { level: 1, tx: 0, ty: 0, tileSize, baseSpacing, heightScale: 1500, normalScale });

  // L1 spacing is twice L0 spacing, so every L1 sample coincides with an
  // even L0 sample.
  for (let j = 0; j < tileSize / 2; j++) {
    for (let i = 0; i < tileSize / 2; i++) {
      near(
        l1.heights[j * tileSize + i],
        l0.heights[(j * 2) * tileSize + i * 2],
        1e-6,
        `LOD height ${i},${j}`
      );
    }
  }
}

console.log('infinite-terrain unit checks: OK');
