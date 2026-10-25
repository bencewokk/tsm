import * as THREE from 'three';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

/**
 * The output pass (tone mapping + sRGB) with a display-space grade folded in: saturation, contrast about mid grey, a split tone (cool
 * shadows, warm highlights) and a light vignette. It replaces `OutputPass`, it is not an extra pass, so it costs a few ALU ops in the
 * pass that already runs. With every uniform at its neutral value the output equals the stock pass.
 */
export class GradePass extends OutputPass {
  grade = {
    uSat: { value: 1 },
    uContrast: { value: 1 },
    uShadow: { value: new THREE.Vector3(1, 1, 1) },
    uHigh: { value: new THREE.Vector3(1, 1, 1) },
    uVig: { value: 0 },
  };
  constructor() {
    super();
    Object.assign(this.uniforms, this.grade);
    const m = this.material as THREE.RawShaderMaterial;
    m.fragmentShader = m.fragmentShader
      .replace('varying vec2 vUv;', `varying vec2 vUv;
        uniform float uSat; uniform float uContrast; uniform vec3 uShadow; uniform vec3 uHigh; uniform float uVig;`)
      .replace(/\}\s*$/, `
          {
            vec3 c = gl_FragColor.rgb;
            float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
            c = mix(vec3(l), c, uSat);
            c = (c - 0.5) * uContrast + 0.5;
            c *= mix(uShadow, uHigh, smoothstep(0.08, 0.85, l));
            vec2 q = vUv - 0.5;
            c *= 1.0 - uVig * smoothstep(0.06, 0.42, dot(q, q));
            gl_FragColor.rgb = max(c, vec3(0.0));
          }
        }`);
  }
}
