/**
 * Infinite-terrain shaders.
 *
 * Height is displaced in the vertex shader from a sampler2DArray whose layer
 * is the clipmap LOD. The fragment shader samples the matching normal-map
 * layer. The same object-space encoding as the first PoC is used:
 *   R = N.x (east), G = N.z (+z), B = N.y (up)
 * so no TBN matrix is needed.
 *
 * The tile cache is toroidal: a world tile (tx,ty) always lives in slot
 * (tx mod K, ty mod K). The shader reproduces that mapping from the render
 * origin, which keeps precision stable across floating-origin rebases.
 */

export const terrainVertexShader = /* glsl */ `
  uniform sampler2DArray uHeightArray;
  uniform float uHeightScale;
  uniform vec2 uRenderOrigin;
  uniform vec2 uClipOrigin;
  uniform float uBaseSpacing;
  uniform float uTileCells;
  uniform float uCacheTiles;
  uniform float uSkirtDepth;

  attribute float aLevel;
  attribute float aOuter;
  attribute float aStitch;
  attribute float aSkirt;
  attribute float aCoarse;

  varying vec3 vWorldPos;
  varying float vHeightN;
  flat varying float vLevel;
  varying float vStitch;
  varying float vSkirt;

  void main() {
    // Geometry spacing is always the instance LOD. Stitch coarse vertices
    // fetch the next LOD's height so their chord matches ring L+1 exactly.
    float sampleLevel = aLevel + aCoarse;
    float spacing = uBaseSpacing * exp2(aLevel);
    float sampleSpacing = uBaseSpacing * exp2(sampleLevel);
    float tileWorld = uTileCells * sampleSpacing;

    // Render-space position. Absolute world = uRenderOrigin + local.
    vec2 local = uClipOrigin + position.xz * spacing;

    // Toroidal tile-cache UV, including the half-texel offset so a vertex
    // exactly on a sample reads the texel centre.
    vec2 phase = mod(uRenderOrigin, uCacheTiles * tileWorld) / tileWorld;
    vec2 t = phase + local / tileWorld;
    vec2 slot = mod(floor(t), uCacheTiles);
    vec2 uv = (slot + fract(t) + 0.5 / uTileCells) / uCacheTiles;

    float hN = texture(uHeightArray, vec3(uv, sampleLevel)).r;
    float h = hN * uHeightScale;

    vec3 wp = vec3(local.x, h, local.y);
    // Collapsed for non-last rings (aOuter = 0).
    wp.y -= uSkirtDepth * aSkirt * aOuter;

    vWorldPos = wp;
    vHeightN = hN;
    vLevel = aLevel;
    vStitch = aStitch;
    vSkirt = aSkirt;

    gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  }
`;

export const terrainFragmentShader = /* glsl */ `
  // tonemapping_pars_fragment / colorspace_pars_fragment are auto-injected
  // by three.js; do not include the *_pars chunks again.

  uniform sampler2DArray uNormalArray;
  uniform vec2 uRenderOrigin;
  uniform vec2 uClipOrigin;
  uniform float uBaseSpacing;
  uniform float uTileCells;
  uniform float uNormalTileCells;
  uniform float uCacheTiles;
  uniform float uLevels;
  uniform float uCenterCells;

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
  flat varying float vLevel;
  varying float vStitch;
  varying float vSkirt;

  vec2 cacheUv(vec2 local, float spacing, float tileCells) {
    float tileWorld = uTileCells * spacing;
    vec2 phase = mod(uRenderOrigin, uCacheTiles * tileWorld) / tileWorld;
    vec2 t = phase + local / tileWorld;
    vec2 slot = mod(floor(t), uCacheTiles);
    return (slot + fract(t) + 0.5 / tileCells) / uCacheTiles;
  }

  void main() {
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

    // ---- normal map, with a narrow cross-fade to the next LOD near the
    //      outer edge of the ring ----------------------------------------
    vec3 nm = texture(uNormalArray, vec3(uvNormal, vLevel)).xyz * 2.0 - 1.0;

    float edge = max(abs(vWorldPos.x - uClipOrigin.x), abs(vWorldPos.z - uClipOrigin.y)) / spacing;
    float blend = smoothstep(uCenterCells * 2.0 - 4.0, uCenterCells * 2.0 - 1.0, edge);

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
      if (vStitch > 0.5) c = vec3(1.0, 0.12, 0.08);
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

    // Rock is the base material. The original PoC started from grass*grassW,
    // which goes black once the grass band fades out on high ground; with an
    // infinite world that would leave whole massifs unlit.
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
  varying float vStitch;
  flat varying float vLevel;

  void main() {
    float t = vLevel / max(uLevels - 1.0, 1.0);
    vec3 c = 0.5 + 0.5 * cos(6.2831853 * (t + vec3(0.0, 0.33, 0.67)));
    if (vStitch > 0.5) c = vec3(1.0, 0.12, 0.08);
    gl_FragColor = vec4(c, 0.9);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;
