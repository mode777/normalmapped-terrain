/**
 * Sky shader used by the infinite-terrain page.
 *
 * A back-side sphere with a vertical gradient plus a sun disc/halo
 * (`pow(dot(dir, sun), 950)` and `pow(·, 14)`), re-centred on the camera each
 * frame.
 */

export const skyVertexShader: string = /* glsl */ `
  varying vec3 vWorldPos;
  void main() {
    vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
    gl_Position = projectionMatrix * viewMatrix * vec4(vWorldPos, 1.0);
  }
`;

export const skyFragmentShader: string = /* glsl */ `
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
