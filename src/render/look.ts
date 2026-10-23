import * as THREE from 'three';

export const lookUniforms = {
  uNight: { value: 0 },
};

/**
 * Architect's-model building shader: matte boxes, a cheap ambient-occlusion darkening near the base,
 * faint window rows by day and warm lit windows at night (emissive, per-window random).
 */
export function patchBuildingMaterial(mat: THREE.MeshStandardMaterial) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = lookUniforms.uNight;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        varying vec3 vTsmPos;
        varying vec3 vTsmN;
        varying float vTsmY;
        varying float vTsmSeed;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        #ifdef USE_INSTANCING
          mat4 tsmM = modelMatrix * instanceMatrix;
          vTsmY = transformed.y * length(instanceMatrix[1].xyz);
          vTsmSeed = float(gl_InstanceID);
        #else
          mat4 tsmM = modelMatrix;
          vTsmY = transformed.y;
          vTsmSeed = 0.0;
        #endif
        vTsmPos = (tsmM * vec4(transformed, 1.0)).xyz;
        vTsmN = normalize(mat3(tsmM) * objectNormal);`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uNight;
        varying vec3 vTsmPos;
        varying vec3 vTsmN;
        varying float vTsmY;
        varying float vTsmSeed;
        float tsmHash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
        float tsmWin;
        float tsmLit;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          vec3 n = normalize(vTsmN);
          float side = step(abs(n.y), 0.5);
          vec2 t = normalize(vec2(-n.z, n.x) + 1e-5);
          vec2 hv = vec2(dot(vTsmPos.xz, t), vTsmY);
          vec2 cellSize = vec2(3.8, 3.4);
          vec2 g = fract(hv / cellSize);
          vec2 id = floor(hv / cellSize);
          float above = step(4.0, vTsmY);
          tsmWin = step(0.24, g.x) * step(g.x, 0.76) * step(0.32, g.y) * step(g.y, 0.82) * side * above;
          tsmLit = step(0.48, tsmHash(id + vec2(vTsmSeed * 0.37, vTsmSeed * 1.13)));
          diffuseColor.rgb *= 1.0 - tsmWin * 0.09;
          // cheap AO: darken the bottom few metres of every wall
          diffuseColor.rgb *= mix(0.74, 1.0, smoothstep(1.5, 9.0, vTsmY) * side + (1.0 - side));
        }`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance += vec3(1.0, 0.76, 0.42) * tsmWin * tsmLit * uNight * 1.5;`);
  };
  mat.customProgramCacheKey = () => 'tsm-building';
}
