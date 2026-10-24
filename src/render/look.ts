import * as THREE from 'three';
import { VFX } from './vfx';

let nightV = 0;
/** called whenever the night factor changes (layers that exist only at night show / hide themselves) */
export const nightHooks: ((n: number) => void)[] = [];
export const lookUniforms = {
  uNight: { get value() { return nightV; }, set value(v: number) { if (v !== nightV) { nightV = v; for (const f of nightHooks) f(v); } } },
  /** seconds, for the slow on / off drift of lit windows (visual only) */
  uTime: { value: 0 },
  /** share of windows lit at this hour of the night (evening busy, small hours quiet, dawn waking) */
  uLitP: { value: 0.5 },
  /** pixels per metre at distance 1 in the scene target (point sprites are sized in world metres) */
  uPx: { value: 900 },
};

/** Colour and strength of the ambient + sun light as a tint (1 = full daylight); set by `Env.applyTime`, used to dim unlit layers (the map paper). */
export const skyLight = new THREE.Color(1, 1, 1);

/** every material patched below, so a switch can recompile them */
const patched: THREE.Material[] = [];
VFX.onChange((n) => { if (n === 'bld' || n === 'night') for (const m of patched) m.needsUpdate = true; });

/**
 * Architect's-model building shader: matte boxes, a cheap ambient-occlusion darkening near the base, window rows by day and warm lit
 * windows at night (emissive, per-window random).
 *
 * With the `bld` switch on, each building also gets its own window rhythm and proportions (hashed from its seed), a tint inside its
 * palette, floor slab lines and sills, a shopfront band on some ground floors, rooftop plant and gravel patches on flat roofs and tile
 * courses on pitched ones; at night the share of lit windows follows the hour and a few windows flip every now and then.
 */
export function patchBuildingMaterial(mat: THREE.MeshStandardMaterial, glass = false, poly = false) {
  patched.push(mat);
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = lookUniforms.uNight;
    shader.uniforms.uTime = lookUniforms.uTime;
    shader.uniforms.uLitP = lookUniforms.uLitP;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        varying vec3 vTsmPos;
        varying vec3 vTsmN;
        varying float vTsmY;
        varying float vTsmSeed;
        #ifdef TSM_POLY
          attribute float aH;
          attribute float aSeed;
        #endif`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        #ifdef TSM_POLY
          mat4 tsmM = modelMatrix;
          vTsmY = aH * length(modelMatrix[1].xyz);
          vTsmSeed = aSeed;
        #elif defined(USE_INSTANCING)
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
        uniform float uTime;
        uniform float uLitP;
        varying vec3 vTsmPos;
        varying vec3 vTsmN;
        varying float vTsmY;
        varying float vTsmSeed;
        float tsmHash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
        float tsmWin;
        float tsmLit;
        vec3 tsmLitCol = vec3(1.0, 0.76, 0.42);`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          vec3 n = normalize(vTsmN);
          float side = step(abs(n.y), 0.5);
          vec2 t = normalize(vec2(-n.z, n.x) + 1e-5);
          vec2 hv = vec2(dot(vTsmPos.xz, t), vTsmY);
          float above = step(4.0, vTsmY);
        #ifdef TSM_BLD
          float sd = vTsmSeed;
          float r1 = tsmHash(vec2(sd, 1.7)), r2 = tsmHash(vec2(sd, 5.3)), r3 = tsmHash(vec2(sd, 9.1)), r4 = tsmHash(vec2(sd, 13.9));
          // own tint inside the palette: a little lighter or darker, a little warmer or cooler
          diffuseColor.rgb *= (0.94 + 0.12 * r1) * mix(vec3(1.025, 1.0, 0.965), vec3(0.97, 1.0, 1.035), r2);
          float shop = step(0.62, r3);                       // some ground floors are shopfronts
          float floorH = 3.1 + 0.6 * r4;                     // storey height of this building
        #endif
        #ifdef TSM_GLASS
          // curtain wall: continuous ribbon windows, mullions every 1.6 m
          vec2 cellSize = vec2(1.6, 3.6);
          vec2 g = fract(hv / cellSize);
          vec2 id = floor(hv / vec2(9.0, 3.6));
          tsmWin = step(0.08, g.x) * step(0.3, g.y) * step(g.y, 0.92) * side * above;
          #ifdef TSM_BLD
            tsmLit = step(1.0 - uLitP * 0.9, tsmHash(id + vec2(vTsmSeed * 0.37, vTsmSeed * 1.13)));
            tsmLit = mix(tsmLit, 1.0 - tsmLit, step(0.95, tsmHash(id * 3.7 + floor(uTime * 0.05 + tsmHash(id) * 20.0))));
            diffuseColor.rgb *= 1.0 - 0.1 * step(g.y, 0.3) * side * above;   // spandrel band under each ribbon
          #else
            tsmLit = step(0.42, tsmHash(id + vec2(vTsmSeed * 0.37, vTsmSeed * 1.13)));
          #endif
          diffuseColor.rgb *= 1.0 - tsmWin * 0.24;
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.92, 0.97, 1.06), tsmWin);
        #elif defined(TSM_BLD)
          vec2 cellSize = vec2(3.0 + 1.6 * r2, floorH);
          vec2 g = fract(hv / cellSize);
          vec2 id = floor(hv / cellSize);
          float ww = 0.36 + 0.3 * r1;                        // window width as a share of the bay
          tsmWin = step(0.5 - ww * 0.5, g.x) * step(g.x, 0.5 + ww * 0.5) * step(0.32, g.y) * step(g.y, 0.82) * side * above;
          float wv = tsmHash(id + vec2(sd * 0.61, 3.3));    // this window's own character: a blind drawn, a light curtain, bare glass
          // the hour decides how many windows are lit; a window's hash decides which, so lights go out in a stable order
          tsmLit = step(1.0 - uLitP, tsmHash(id + vec2(sd * 0.37, sd * 1.13)));
          tsmLit = mix(tsmLit, 1.0 - tsmLit, step(0.94, tsmHash(id * 3.7 + vec2(sd) + floor(uTime * 0.05 + wv * 20.0))));
          tsmLitCol = mix(vec3(1.0, 0.76, 0.42), vec3(0.78, 0.86, 1.0), step(0.9, wv));
          float shade = mix(0.58, 0.92, wv * wv);
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * shade * vec3(0.96, 0.98, 1.03), tsmWin);
          // storey lines and sills
          float slab = step(g.y, 0.07) * side * step(3.0, vTsmY);
          float sill = step(0.27, g.y) * step(g.y, 0.32) * side * above * step(0.5 - ww * 0.5 - 0.05, g.x) * step(g.x, 0.5 + ww * 0.5 + 0.05);
          diffuseColor.rgb *= 1.0 - 0.085 * slab;
          diffuseColor.rgb *= 1.0 + 0.07 * sill;
          // shopfront band: continuous glazing under a fascia, glowing at night
          float sg = shop * side * step(0.5, vTsmY) * step(vTsmY, 3.3);
          float mull = step(0.07, fract(hv.x / 2.6)) ;
          tsmWin = max(tsmWin, sg * mull);
          tsmLit = mix(tsmLit, step(0.2, tsmHash(vec2(floor(hv.x / 2.6), sd))), sg * mull);
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.5, 0.55, 0.6), sg * mull);
          diffuseColor.rgb *= 1.0 - 0.12 * side * step(3.3, vTsmY) * step(vTsmY, 3.7) * shop;   // fascia
          // roofs: flat roofs get plant and gravel patches, pitched roofs get tile courses
          float isFlat = (1.0 - side) * step(0.85, n.y);
          vec2 rc = floor(vTsmPos.xz / 5.0), ru = fract(vTsmPos.xz / 5.0);
          float rh = tsmHash(rc + vec2(sd * 0.13, 4.1));
          float unit = step(0.84, rh) * step(0.18, ru.x) * step(ru.x, 0.72) * step(0.22, ru.y) * step(ru.y, 0.7);
          diffuseColor.rgb *= 1.0 + isFlat * (unit * 0.2 - 0.05 * step(0.5, rh) * (1.0 - unit) + 0.03 * (rh - 0.5));
          float pitched = (1.0 - side) * (1.0 - step(0.85, n.y));
          float tileW = fwidth(vTsmY * 0.9);
          diffuseColor.rgb *= 1.0 - pitched * 0.07 * step(fract(vTsmY * 0.9), 0.18) * (1.0 - smoothstep(0.25, 0.7, tileW));
        #else
          vec2 cellSize = vec2(3.8, 3.4);
          vec2 g = fract(hv / cellSize);
          vec2 id = floor(hv / cellSize);
          tsmWin = step(0.24, g.x) * step(g.x, 0.76) * step(0.32, g.y) * step(g.y, 0.82) * side * above;
          tsmLit = step(0.48, tsmHash(id + vec2(vTsmSeed * 0.37, vTsmSeed * 1.13)));
          diffuseColor.rgb *= 1.0 - tsmWin * 0.16;
        #endif
          // cheap AO: darken the bottom few metres of every wall
        #ifdef TSM_BLD
          diffuseColor.rgb *= mix(0.62, 1.0, smoothstep(0.5, 11.0, vTsmY) * side + (1.0 - side)) * (0.97 + 0.05 * smoothstep(8.0, 70.0, vTsmY));
        #else
          diffuseColor.rgb *= mix(0.74, 1.0, smoothstep(1.5, 9.0, vTsmY) * side + (1.0 - side));
        #endif
        }`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance += tsmLitCol * tsmWin * tsmLit * uNight * 1.5;`);
  };
  const key = () => (glass ? 'tsm-glass' : 'tsm-building') + (poly ? '-poly' : '') + VFX.key('bld', 'night');
  mat.customProgramCacheKey = key;
  const defs = () => {
    const d: Record<string, string> = {};
    if (glass) d.TSM_GLASS = '';
    if (poly) d.TSM_POLY = '';
    if (VFX.is('bld')) d.TSM_BLD = '';
    mat.defines = d;
  };
  defs();
  VFX.onChange((n) => { if (n === 'bld') defs(); });
}
