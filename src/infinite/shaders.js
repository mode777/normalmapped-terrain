/**
 * Infinite-terrain shaders.
 *
 * Height is displaced in the vertex shader from a sampler2DArray whose layer
 * is the clipmap LOD. The fragment shader samples the matching normal-map
 * layer. The object-space encoding is:
 *   R = N.x (east), G = N.z (+z), B = N.y (up)
 * so no TBN matrix is needed.
 *
 * Each ring has its own snapped origin (`aOrigin`), so between snaps every
 * vertex sits exactly on a height-texel centre and the mesh is rigid. The
 * prices of per-level snapping are paid here:
 *
 *   - the ring is clipped (fragment shader) to its parent level's outer
 *     square, so exactly one level covers any point on the terrain;
 *   - the outer `uMorphCells` cells of every ring morph to the next-coarse
 *     height, so the clipped boundary is invisible even though the two
 *     rings snap at different times.
 *
 * The tile cache is toroidal: a world tile (tx,ty) always lives in slot
 * (tx mod K, ty mod K). The shader reproduces that mapping from the render
 * origin, which keeps precision stable across floating-origin rebases.
 */

export const terrainVertexShader = /* glsl */ `
  uniform sampler2DArray uHeightArray;
  uniform float uHeightScale;
  uniform vec2 uRenderOrigin;
  uniform float uBaseSpacing;
  uniform float uTileCells;
  uniform float uCacheTiles;
  uniform float uSkirtDepth;
  uniform float uLevels;
  uniform float uCenterCells;
  uniform float uMorphCells;

  attribute float aLevel;
  attribute float aOuter;
  attribute float aTrim;
  attribute float aSkirt;
  attribute vec2 aOrigin;
  attribute vec2 aParentOrigin;
  attribute vec2 aCoarseOrigin;

  varying vec3 vWorldPos;
  varying float vHeightN;
  varying float vSkirt;
  varying float vEdge;
  flat varying float vLevel;
  flat varying float vTrim;
  flat varying vec2 vParentOrigin;

  // Toroidal tile-cache UV for a render-space position, including the
  // half-texel offset so a vertex exactly on a sample reads the texel centre.
  vec2 cacheUv(vec2 local, float spacing, float tileCells) {
    float tileWorld = uTileCells * spacing;
    vec2 phase = mod(uRenderOrigin, uCacheTiles * tileWorld) / tileWorld;
    vec2 t = phase + local / tileWorld;
    vec2 slot = mod(floor(t), uCacheTiles);
    return (slot + fract(t) + 0.5 / tileCells) / uCacheTiles;
  }

  // Height of the next-coarser *mesh* at a world position.
  //
  // A plain bilinear fetch of the coarse layer does not match the coarse
  // triangles: with per-level snapping the fine edge usually falls in the
  // middle of a coarse cell, where bilinear and the two-triangle
  // interpolation disagree by up to the LOD error. At a grazing angle that
  // mismatch opens a sliver at the ring boundary. Reproducing the coarse
  // triangulation here makes the morphed fine edge coincide with it exactly.
  float coarseMeshHeight(vec2 local, vec2 origin, float coarseSpacing, float coarseLevel) {
    vec2 g = (local - origin) / coarseSpacing;
    vec2 cell = floor(g);
    vec2 f = g - cell;

    float h00 = texture(uHeightArray, vec3(cacheUv(origin + cell * coarseSpacing, coarseSpacing, uTileCells), coarseLevel)).r;
    float h10 = texture(uHeightArray, vec3(cacheUv(origin + (cell + vec2(1.0, 0.0)) * coarseSpacing, coarseSpacing, uTileCells), coarseLevel)).r;
    float h01 = texture(uHeightArray, vec3(cacheUv(origin + (cell + vec2(0.0, 1.0)) * coarseSpacing, coarseSpacing, uTileCells), coarseLevel)).r;
    float h11 = texture(uHeightArray, vec3(cacheUv(origin + (cell + vec2(1.0, 1.0)) * coarseSpacing, coarseSpacing, uTileCells), coarseLevel)).r;

    // Same diagonal as buildRingGeometry: (i+1,j)-(i,j+1).
    if (f.x + f.y <= 1.0) {
      return h00 + f.x * (h10 - h00) + f.y * (h01 - h00);
    }
    return h11 + (1.0 - f.x) * (h01 - h11) + (1.0 - f.y) * (h10 - h11);
  }

  void main() {
    float spacing = uBaseSpacing * exp2(aLevel);

    // Render-space position. Absolute world = uRenderOrigin + local.
    vec2 local = aOrigin + position.xz * spacing;

    // Distance from the ring's origin in cells (0 at the centre, 2C at the
    // outer boundary).
    float edge = max(abs(position.x), abs(position.z));

    // Morph band: the outer cells of the ring blend into the next-coarser
    // level. The last ring has no coarser level.
    float morph = 0.0;
    if (aLevel < uLevels - 1.0) {
      morph = smoothstep(
        uCenterCells * 2.0 - max(uMorphCells, 1.0),
        uCenterCells * 2.0,
        edge
      );
    }

    float hN = texture(uHeightArray, vec3(cacheUv(local, spacing, uTileCells), aLevel)).r;
    if (morph > 0.0) {
      float hc = coarseMeshHeight(local, aCoarseOrigin, spacing * 2.0, aLevel + 1.0);
      hN = mix(hN, hc, morph);
    }

    float h = hN * uHeightScale;
    vec3 wp = vec3(local.x, h, local.y);
    // Collapsed for non-last rings (aOuter = 0).
    wp.y -= uSkirtDepth * aSkirt * aOuter;

    vWorldPos = wp;
    vHeightN = hN;
    vSkirt = aSkirt;
    vEdge = edge;
    vLevel = aLevel;
    vTrim = aTrim;
    vParentOrigin = aParentOrigin;

    gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  }
`;

export const terrainFragmentShader = /* glsl */ `
  // tonemapping_pars_fragment / colorspace_pars_fragment are auto-injected
  // by three.js; do not include the *_pars chunks again.

  uniform sampler2DArray uNormalArray;
  uniform vec2 uRenderOrigin;
  uniform float uBaseSpacing;
  uniform float uTileCells;
  uniform float uNormalTileCells;
  uniform float uCacheTiles;
  uniform float uLevels;
  uniform float uCenterCells;
  uniform float uMorphCells;
  uniform float uPixelScale;

  uniform float uNormalStrength;
  uniform vec3 uSunDirection;
  uniform vec3 uSunColor;
  uniform vec3 uSkyColor;
  uniform vec3 uGroundColor;
  uniform vec3 uFogColor;
  uniform float uFogDensity;
  uniform float uSnowStart;
  uniform float uGrassStrength;
  uniform float uSandStrength;
  uniform float uSpecular;
  uniform float uDebugLod;
  uniform float uDebugTiles;

  varying vec3 vWorldPos;
  varying float vHeightN;
  varying float vSkirt;
  varying float vEdge;
  flat varying float vLevel;
  flat varying float vTrim;
  flat varying vec2 vParentOrigin;

  vec2 cacheUv(vec2 local, float spacing, float tileCells) {
    float tileWorld = uTileCells * spacing;
    vec2 phase = mod(uRenderOrigin, uCacheTiles * tileWorld) / tileWorld;
    vec2 t = phase + local / tileWorld;
    vec2 slot = mod(floor(t), uCacheTiles);
    return (slot + fract(t) + 0.5 / tileCells) / uCacheTiles;
  }

  void main() {
    // Clip each ring to the outer square of the level inside it. Rings above
    // level 0 are built one cell wider than their nominal boundary, so the
    // clip turns that overlap into an exact boundary without stitch geometry.
    //
    // The cut is pulled inside by a slack: discard is per fragment while MSAA
    // coverage is per sample, so cutting exactly on the shared edge loses the
    // samples that fall outside the fine ring's triangles. The slack covers
    // sub-cell misalignment and grows with the pixel footprint, keeping the
    // sliver a few pixels wide where the boundary is nearly edge-on.
    if (vTrim > 0.5) {
      float spacing = uBaseSpacing * exp2(vLevel);
      float halfSize = uCenterCells * spacing;
      vec2 d = abs(vWorldPos.xz - vParentOrigin);

      float footprint = length(vWorldPos - cameraPosition) * uPixelScale;
      float slack = min(0.125 * spacing + 4.0 * footprint, 0.75 * spacing);
      if (max(d.x, d.y) < halfSize - slack) discard;
    }

    float spacing = uBaseSpacing * exp2(vLevel);
    vec2 uvNormal = cacheUv(vWorldPos.xz, spacing, uNormalTileCells);

    if (uDebugTiles > 0.5) {
      float tw = uTileCells * spacing;
      vec2 tt = floor(mod(uRenderOrigin, uCacheTiles * tw) / tw + vWorldPos.xz / tw);
      float checker = mod(tt.x + tt.y, 2.0);
      vec3 col = mix(vec3(0.08, 0.12, 0.22), vec3(0.85, 0.65, 0.18), checker);
      gl_FragColor = vec4(col, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
      return;
    }

    // ---- normal map, with a narrow cross-fade to the next LOD that matches
    //      the vertex morph band ------------------------------------------
    vec3 nm = texture(uNormalArray, vec3(uvNormal, vLevel)).xyz * 2.0 - 1.0;

    float blend = smoothstep(
      uCenterCells * 2.0 - max(uMorphCells, 1.0),
      uCenterCells * 2.0,
      vEdge
    );

    if (vLevel < uLevels - 1.0) {
      float spacing2 = spacing * 2.0;
      vec2 uv2 = cacheUv(vWorldPos.xz, spacing2, uNormalTileCells);
      vec3 nm2 = texture(uNormalArray, vec3(uv2, vLevel + 1.0)).xyz * 2.0 - 1.0;
      nm = mix(nm, nm2, blend);
    }

    vec2 tangent = nm.xy * uNormalStrength;
    vec3 N = normalize(vec3(tangent.x, nm.z, tangent.y));

    // ---- debug LOD view ------------------------------------------------
    if (uDebugLod > 0.5) {
      float t = vLevel / max(uLevels - 1.0, 1.0);
      vec3 c = 0.5 + 0.5 * cos(6.2831853 * (t + vec3(0.0, 0.33, 0.67)));
      gl_FragColor = vec4(c, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
      return;
    }

    // ---- lighting ------------------------------------------------------
    float ndl = max(dot(N, uSunDirection), 0.0);
    vec3 hemi = mix(uGroundColor, uSkyColor, N.y * 0.5 + 0.5);

    // ---- albedo: height + slope bands ----------------------------------
    float hv = vHeightN;
    float slope = 1.0 - N.y;
    float hn = hv;

    vec3 grass = mix(vec3(0.035, 0.075, 0.025), vec3(0.120, 0.200, 0.055), hv);
    vec3 rock  = mix(vec3(0.200, 0.160, 0.120), vec3(0.400, 0.320, 0.250), hv);
    vec3 sand  = vec3(0.520, 0.430, 0.300);
    vec3 snow  = vec3(0.870, 0.900, 0.960);

    float grassW = (1.0 - smoothstep(0.28, 0.50, hn)) * uGrassStrength;
    float sandW  = (1.0 - smoothstep(0.04, 0.16, hn)) * uSandStrength;
    float snowW  = smoothstep(uSnowStart, uSnowStart + 0.14, hn + hv * 0.08);
    float steep  = smoothstep(0.42, 0.72, slope);

    // Rock is the base material. Starting from grass*grassW instead would go
    // black once the grass band fades out on high ground, leaving whole
    // massifs unlit.
    vec3 albedo = rock;
    albedo = mix(albedo, grass, grassW * (1.0 - steep * 0.65));
    albedo = mix(albedo, sand, sandW * (1.0 - steep));
    albedo = mix(albedo, snow, snowW * (1.0 - steep));

    float slopeShade = mix(1.0, 0.86, smoothstep(0.55, 0.90, slope));
    vec3 color = albedo * (uSunColor * ndl * 1.9 + hemi * 0.34) * slopeShade;

    // ---- specular ------------------------------------------------------
    vec3 V = normalize(cameraPosition - vWorldPos);
    vec3 H = normalize(uSunDirection + V);
    float specW = snowW * 0.9 + sandW * 0.35 + 0.02;
    color += uSunColor * pow(max(dot(N, H), 0.0), 46.0) * uSpecular * specW;

    // ---- distance fog ---------------------------------------------------
    float dist = length(vWorldPos - cameraPosition);
    float fog = 1.0 - exp(-uFogDensity * uFogDensity * dist * dist);
    color = mix(color, uFogColor, fog);

    // The horizon skirt fades into the fog so the last ring has no hard edge.
    color = mix(color, uFogColor, clamp(vSkirt, 0.0, 1.0));

    gl_FragColor = vec4(color, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export const debugVertexShader = terrainVertexShader;

export const debugFragmentShader = /* glsl */ `
  uniform float uLevels;
  uniform float uBaseSpacing;
  uniform float uCenterCells;
  uniform float uPixelScale;

  varying vec3 vWorldPos;
  flat varying float vLevel;
  flat varying float vTrim;
  flat varying vec2 vParentOrigin;

  void main() {
    // Match the shaded pass: hide each ring's surplus inside the parent square.
    if (vTrim > 0.5) {
      float spacing = uBaseSpacing * exp2(vLevel);
      float halfSize = uCenterCells * spacing;
      vec2 d = abs(vWorldPos.xz - vParentOrigin);
      float footprint = length(vWorldPos - cameraPosition) * uPixelScale;
      float slack = min(0.125 * spacing + 4.0 * footprint, 0.75 * spacing);
      if (max(d.x, d.y) < halfSize - slack) discard;
    }

    float t = vLevel / max(uLevels - 1.0, 1.0);
    vec3 c = 0.5 + 0.5 * cos(6.2831853 * (t + vec3(0.0, 0.33, 0.67)));
    gl_FragColor = vec4(c, 0.9);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;
