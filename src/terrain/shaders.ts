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

export const terrainVertexShader: string = /* glsl */ `
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

export const terrainFragmentShader: string = /* glsl */ `
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
  uniform float uNormalLodBias;
  uniform sampler2D uDetailNormal;
  uniform float uDetailStrength;
  uniform vec2 uDetailUvOffset;
  uniform float uDetailTileSize;
  uniform float uDetailFadeStart;
  uniform float uDetailFadeEnd;
  uniform float uMaterialCount;
  uniform sampler2DArray uMaterialAlbedo;
  uniform sampler2DArray uMaterialSlope;
  uniform sampler2D uMaterialStackIds;
  uniform sampler2D uMaterialStackWeights;
  uniform sampler2D uMacroAlbedo;
  uniform float uStackExtent;
  uniform vec2 uStackUvOffset;
  uniform vec4 uMaterialParamsA[24];
  uniform vec4 uMaterialParamsB[24];
  uniform vec2 uMaterialUvOffset[24];
  uniform float uMaterialNormalScale;
  uniform float uMaterialHeightBlend;
  uniform float uMaterialFadeStart;
  uniform float uMaterialFadeEnd;
  uniform float uMaterialMode;
  uniform float uMaterialAoStrength;
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

  float slotWeight(vec4 v, int s) {
    return s == 0 ? v.x : s == 1 ? v.y : s == 2 ? v.z : v.w;
  }

  float slotId(vec4 v, int s) {
    return s == 0 ? v.x : s == 1 ? v.y : s == 2 ? v.z : v.w;
  }

  // A world-space material normal becomes a horizontal slope in the terrain's
  // (x,z) slope frame. The guard keeps near-vertical side projections finite.
  vec2 normalToSlope(vec3 n) {
    return clamp(n.xz / max(n.y, 0.18), vec2(-4.0), vec2(4.0));
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

    // ---- debug LOD view ------------------------------------------------
    if (uDebugLod > 0.5) {
      float t = vLevel / max(uLevels - 1.0, 1.0);
      vec3 c = 0.5 + 0.5 * cos(6.2831853 * (t + vec3(0.0, 0.33, 0.67)));
      gl_FragColor = vec4(c, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
      return;
    }

    // ---- base normal, with an optional negative LOD bias ----------------
    // The DEM page sets uNormalLodBias to 1. The next-finer normal layer is
    // resident in the 5x5 cache and covers the whole coarse ring, so this
    // gives distant shading detail without mipmap bleeding across slots.
    float nLevel = max(vLevel - uNormalLodBias, 0.0);
    float nSpacing = uBaseSpacing * exp2(nLevel);
    vec2 uvNormalBiased = cacheUv(vWorldPos.xz, nSpacing, uNormalTileCells);
    vec3 nm = texture(uNormalArray, vec3(uvNormalBiased, nLevel)).xyz * 2.0 - 1.0;

    float blend = smoothstep(
      uCenterCells * 2.0 - max(uMorphCells, 1.0),
      uCenterCells * 2.0,
      vEdge
    );

    // Match the child ring's biased layer at the shared boundary. At level 0
    // the bias clamps to layer 0, so there is no coarser normal to blend to.
    float targetLevel = nLevel + (vLevel > 0.0 ? 1.0 : 0.0);
    if (targetLevel > nLevel && nLevel < uLevels - 1.0) {
      float nSpacing2 = nSpacing * 2.0;
      vec2 uv2 = cacheUv(vWorldPos.xz, nSpacing2, uNormalTileCells);
      vec3 nm2 = texture(uNormalArray, vec3(uv2, targetLevel)).xyz * 2.0 - 1.0;
      nm = mix(nm, nm2, blend);
    }

    vec2 sBase = nm.xy / max(nm.z, 1e-4);
    vec3 Nbase = normalize(vec3(sBase.x * uNormalStrength, 1.0, sBase.y * uNormalStrength));
    float viewDist = length(vWorldPos - cameraPosition);

    // ---- material stack and active materials ----------------------------
    // The stack is sampled in world space. The four active slots are blended
    // by weight, then biased by each material's packed height. Material
    // normals become a weighted slope addition; the base normal is never
    // replaced, so the terrain silhouette stays intact.
    bool useMaterials = uMaterialMode > 0.5 && uMaterialCount > 0.0;
    vec2 stackUv = vWorldPos.xz / uStackExtent + 0.5 + uStackUvOffset;
    vec4 stackIds = vec4(0.0);
    vec4 stackWeights = vec4(0.0);
    vec2 materialSlope = vec2(0.0);
    vec3 materialAlbedo = vec3(0.0);
    float materialSpec = 0.0;
    float materialAo = 1.0;
    float materialFade = 0.0;
    vec3 macroAlbedo = vec3(0.0);

    if (useMaterials) {
      stackIds = texture(uMaterialStackIds, stackUv);
      stackWeights = texture(uMaterialStackWeights, stackUv);

      if (uMaterialMode > 1.5) {
        // Weight debug view: rock gray, scree orange, snow white, grass green.
        // Blending the weights shows the distribution even where one material
        // dominates, unlike a single dominant-ID color.
        vec3 weightColor = stackWeights.x * vec3(0.52, 0.49, 0.45)
          + stackWeights.y * vec3(0.86, 0.55, 0.22)
          + stackWeights.z * vec3(0.95, 0.97, 1.0)
          + stackWeights.w * vec3(0.20, 0.55, 0.16);
        gl_FragColor = vec4(weightColor, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        return;
      }

      materialFade = 1.0 - smoothstep(uMaterialFadeStart, uMaterialFadeEnd, viewDist);
      macroAlbedo = texture(uMacroAlbedo, stackUv).rgb;
      if (materialFade > 0.0) {
        float sumH = 0.0;
        vec3 albedoAcc = vec3(0.0);
        vec2 slopeAcc = vec2(0.0);
        float specAcc = 0.0;
        float aoAcc = 0.0;

        for (int s = 0; s < 4; s++) {
          float w = slotWeight(stackWeights, s);
          if (w <= 0.002) continue;
          int id = int(clamp(slotId(stackIds, s) * 255.0 + 0.5, 0.0, 23.0));
          vec4 pa = uMaterialParamsA[id];
          vec4 pb = uMaterialParamsB[id];
          float tile = max(pa.x, 0.01);
          vec3 a;
          float h;
          float ao;
          vec3 nmat;

          if (pb.y > 0.5) {
            // Triplanar: top (x,z), side z (x,y), side x (z,y).
            vec3 bw = pow(abs(Nbase), vec3(4.0));
            bw /= max(bw.x + bw.y + bw.z, 1e-4);
            vec2 uvTop = (vWorldPos.xz + uMaterialUvOffset[id]) / tile;
            vec2 uvSideZ = (vWorldPos.xy + vec2(uMaterialUvOffset[id].x, 0.0)) / tile;
            vec2 uvSideX = (vWorldPos.zy + vec2(uMaterialUvOffset[id].y, 0.0)) / tile;
            vec4 ahTop = texture(uMaterialAlbedo, vec3(uvTop, float(id)));
            vec4 ahSideZ = texture(uMaterialAlbedo, vec3(uvSideZ, float(id)));
            vec4 ahSideX = texture(uMaterialAlbedo, vec3(uvSideX, float(id)));
            vec4 srTop = texture(uMaterialSlope, vec3(uvTop, float(id)));
            vec4 srSideZ = texture(uMaterialSlope, vec3(uvSideZ, float(id)));
            vec4 srSideX = texture(uMaterialSlope, vec3(uvSideX, float(id)));
            vec2 sTop = (srTop.rg * 2.0 - 1.0) * pa.y;
            vec2 sSideZ = (srSideZ.rg * 2.0 - 1.0) * pa.y;
            vec2 sSideX = (srSideX.rg * 2.0 - 1.0) * pa.y;
            vec3 nTop = normalize(vec3(sTop.x, 1.0, sTop.y));
            vec3 nSideZ = normalize(vec3(sSideZ.x, sSideZ.y, 1.0));
            vec3 nSideX = normalize(vec3(1.0, sSideX.y, sSideX.x));
            nmat = normalize(nTop * bw.y + nSideZ * bw.z + nSideX * bw.x);
            a = ahTop.rgb * bw.y + ahSideZ.rgb * bw.z + ahSideX.rgb * bw.x;
            h = ahTop.a * bw.y + ahSideZ.a * bw.z + ahSideX.a * bw.x;
            ao = srTop.a * bw.y + srSideZ.a * bw.z + srSideX.a * bw.x;
          } else {
            vec2 uv = (vWorldPos.xz + uMaterialUvOffset[id]) / tile;
            vec4 ah = texture(uMaterialAlbedo, vec3(uv, float(id)));
            vec4 sr = texture(uMaterialSlope, vec3(uv, float(id)));
            vec2 s = (sr.rg * 2.0 - 1.0) * pa.y;
            nmat = normalize(vec3(s.x, 1.0, s.y));
            a = ah.rgb;
            h = ah.a;
            ao = sr.a;
          }

          float wH = max(w + (h - 0.5) * uMaterialHeightBlend, w * 0.05);
          sumH += wH;
          albedoAcc += a * wH;
          slopeAcc += normalToSlope(nmat) * (pa.z * uMaterialNormalScale) * wH;
          specAcc += pb.x * (1.0 - pa.w) * wH;
          aoAcc += ao * pb.z * wH;
        }

        if (sumH < 1e-4) sumH = 1.0;
        materialAlbedo = albedoAcc / sumH;
        materialSlope = slopeAcc / sumH;
        materialSpec = specAcc / sumH;
        materialAo = aoAcc / sumH;

        float macroLuma = dot(macroAlbedo, vec3(0.2126, 0.7152, 0.0722));
        vec3 nearAlbedo = materialAlbedo * (0.85 + 0.30 * macroLuma);
        nearAlbedo *= mix(1.0, materialAo, uMaterialAoStrength);
        materialAlbedo = mix(macroAlbedo, nearAlbedo, materialFade);
      } else {
        materialAlbedo = macroAlbedo;
      }
    }

    // ---- detail normal --------------------------------------------------
    float detailFade = 1.0 - smoothstep(uDetailFadeStart, uDetailFadeEnd, viewDist);
    vec2 sDetail = vec2(0.0);
    if (uDetailStrength > 0.0 && detailFade > 0.0) {
      // vWorldPos is render-space; uDetailUvOffset is the floating origin
      // reduced modulo the tile size, so the pattern stays world-locked.
      vec2 uvDetail = (vWorldPos.xz + uDetailUvOffset) / uDetailTileSize;
      vec3 dm = texture(uDetailNormal, uvDetail).xyz * 2.0 - 1.0;
      sDetail = dm.xy / max(dm.z, 0.1);
    }

    vec2 sTotal = sBase * uNormalStrength;
    if (useMaterials) sTotal += materialSlope * materialFade;
    sTotal += sDetail * (uDetailStrength * detailFade);
    vec3 N = normalize(vec3(sTotal.x, 1.0, sTotal.y));

    // ---- lighting ------------------------------------------------------
    float ndl = max(dot(N, uSunDirection), 0.0);
    vec3 hemi = mix(uGroundColor, uSkyColor, N.y * 0.5 + 0.5);
    float slopeBase = 1.0 - Nbase.y;
    float slopeShade = mix(1.0, 0.86, smoothstep(0.55, 0.90, slopeBase));

    vec3 albedo;
    float specCoef;
    if (useMaterials) {
      albedo = materialAlbedo;
      specCoef = materialSpec;
    } else {
      // ---- albedo: height + slope bands (fallback) --------------------
      float hv = vHeightN;
      float slope = slopeBase;
      float hn = hv;

      vec3 grass = mix(vec3(0.035, 0.075, 0.025), vec3(0.120, 0.200, 0.055), hv);
      vec3 rock  = mix(vec3(0.200, 0.160, 0.120), vec3(0.400, 0.320, 0.250), hv);
      vec3 sand  = vec3(0.520, 0.430, 0.300);
      vec3 snow  = vec3(0.870, 0.900, 0.960);

      float grassW = (1.0 - smoothstep(0.28, 0.50, hn)) * uGrassStrength;
      float sandW  = (1.0 - smoothstep(0.04, 0.16, hn)) * uSandStrength;
      float snowW  = smoothstep(uSnowStart, uSnowStart + 0.14, hn + hv * 0.08);
      float steep  = smoothstep(0.42, 0.72, slope);

      albedo = rock;
      albedo = mix(albedo, grass, grassW * (1.0 - steep * 0.65));
      albedo = mix(albedo, sand, sandW * (1.0 - steep));
      albedo = mix(albedo, snow, snowW * (1.0 - steep));
      specCoef = uSpecular * (snowW * 0.9 + sandW * 0.35 + 0.02);
    }

    vec3 color = albedo * (uSunColor * ndl * 1.9 + hemi * 0.34) * slopeShade;

    // ---- specular ------------------------------------------------------
    vec3 V = normalize(cameraPosition - vWorldPos);
    vec3 H = normalize(uSunDirection + V);
    color += uSunColor * pow(max(dot(N, H), 0.0), 46.0) * specCoef;

    // ---- distance fog ---------------------------------------------------
    float fog = 1.0 - exp(-uFogDensity * uFogDensity * viewDist * viewDist);
    color = mix(color, uFogColor, fog);

    // The horizon skirt fades into the fog so the last ring has no hard edge.
    color = mix(color, uFogColor, clamp(vSkirt, 0.0, 1.0));

    gl_FragColor = vec4(color, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export const debugVertexShader: string = terrainVertexShader;

export const debugFragmentShader: string = /* glsl */ `
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
