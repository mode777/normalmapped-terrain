/**
 * The custom terrain shader.
 *
 * The whole point of this PoC lives in one line of the fragment shader:
 * the shading normal is SAMPLED FROM THE NORMAL MAP (uNormalMap), not
 * taken from the interpolated vertex normal. uNormalBlend lets us morph
 * between the two so the same scene can show both cases (and a split
 * screen renders it twice for an A/B comparison).
 *
 * Normal map encoding (see normalmap.js): object-space, terrain local
 * frame with +x east, +z south, +y up, stored as R=N.x, G=N.z, B=N.y.
 * The terrain is never rotated, so local == world.
 */

export const terrainVertexShader = /* glsl */ `
  uniform float uHeightScale;

  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vWorldPos;
  varying float vHeightN;

  void main() {
    vUv = uv;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    vHeightN = position.y / uHeightScale;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

export const terrainFragmentShader = /* glsl */ `
  // note: tonemapping_pars_fragment / colorspace_pars_fragment are
  // auto-injected into every fragment shader by the three.js renderer.

  uniform sampler2D uNormalMap;   // baked from the high-res heightfield
  uniform sampler2D uHeightMap;   // for albedo variation only
  uniform float uNormalBlend;     // 0 = vertex normals, 1 = normal map
  uniform float uNormalStrength;  // 1 = honest world-space gradient
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

  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vWorldPos;
  varying float vHeightN;

  void main() {
    // ---- normal: the entire PoC in a few lines ----------------------
    vec3 nm = texture2D(uNormalMap, vUv).xyz * 2.0 - 1.0; // (x, z, up)
    vec2 tangent = nm.xy * uNormalStrength;
    vec3 mapN = normalize(vec3(tangent.x, nm.z, tangent.y)); // -> (x, up, z)
    vec3 N = normalize(mix(vNormalW, mapN, uNormalBlend));

    // ---- lighting ----------------------------------------------------
    float ndl = max(dot(N, uSunDirection), 0.0);
    vec3 hemi = mix(uGroundColor, uSkyColor, N.y * 0.5 + 0.5);

    // ---- albedo: height + slope bands (slope follows the blended
    //      normal, so normal-map detail also steers rock/grass/snow) ---
    float hv = texture2D(uHeightMap, vUv).r;
    float slope = 1.0 - N.y;
    float hn = vHeightN;

    vec3 grass = mix(vec3(0.055, 0.095, 0.038), vec3(0.140, 0.190, 0.072), hv);
    vec3 rock  = mix(vec3(0.265, 0.225, 0.190), vec3(0.430, 0.370, 0.305), hv);
    vec3 sand  = vec3(0.560, 0.470, 0.330);
    vec3 snow  = vec3(0.870, 0.900, 0.960);

    float grassW = (1.0 - smoothstep(0.32, 0.52, hn)) * uGrassStrength;
    float sandW  = (1.0 - smoothstep(0.05, 0.17, hn)) * uSandStrength;
    float snowW  = smoothstep(uSnowStart, uSnowStart + 0.14, hn + hv * 0.08);
    float steep  = smoothstep(0.30, 0.58, slope);

    vec3 albedo = grass * grassW;
    albedo = mix(albedo, sand, sandW);
    albedo = mix(albedo, rock, steep * (1.0 - snowW * 0.6));
    albedo = mix(albedo, snow, snowW * (1.0 - steep));

    vec3 color = albedo * (uSunColor * ndl * 1.6 + hemi * 0.45);

    // ---- specular: Blinn-Phong, mostly on snow/wet sand ---------------
    vec3 V = normalize(cameraPosition - vWorldPos);
    vec3 H = normalize(uSunDirection + V);
    float specW = snowW * 0.9 + sandW * 0.35 + 0.02;
    color += uSunColor * pow(max(dot(N, H), 0.0), 46.0) * uSpecular * specW;

    // ---- distance fog --------------------------------------------------
    float dist = length(vWorldPos - cameraPosition);
    float fog = 1.0 - exp(-uFogDensity * uFogDensity * dist * dist);
    color = mix(color, uFogColor, fog);

    gl_FragColor = vec4(color, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export const skyVertexShader = /* glsl */ `
  varying vec3 vWorldPos;
  void main() {
    vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
    gl_Position = projectionMatrix * viewMatrix * vec4(vWorldPos, 1.0);
  }
`;

export const skyFragmentShader = /* glsl */ `
  uniform vec3 uZenith;
  uniform vec3 uHorizon;
  uniform vec3 uSunDirection;
  uniform vec3 uSunColor;

  varying vec3 vWorldPos;

  void main() {
    vec3 dir = normalize(vWorldPos - cameraPosition);
    float h = clamp(dir.y, -1.0, 1.0);

    vec3 sky = mix(uHorizon, uZenith, pow(clamp(h, 0.0, 1.0), 0.62));
    sky = mix(sky, uHorizon * 0.45, smoothstep(0.02, -0.28, h));

    float sunAmt = max(dot(dir, uSunDirection), 0.0);
    sky += uSunColor * (pow(sunAmt, 950.0) * 3.2 + pow(sunAmt, 14.0) * 0.14);

    gl_FragColor = vec4(sky, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;
