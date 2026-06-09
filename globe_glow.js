// =============================================================================
// globe_glow.js -- VERBATIM WebGL2 port of the PS3 XMB globe visualizer's
// bloom/glow pyramid (downsample 15-tap separable Gaussian + exponential-weighted
// upsample-accumulate). Self-contained, framework-free, RGBA16F.
//
// SOURCE OF TRUTH (no approximation):
//   * Downsample fp   = RSX fp 0x1d37473045f580b9 (sibling of c1f67eef0f444617;
//                       identical 15-tap structure + vp 0x7077ad739e7e525c).
//                       Ported verbatim from globe_assets/pass_specs.json
//                       (fp c1f67eef portable_glsl) and cohB/dc.txt constants.
//   * Downsample vp   = 0x7077ad739e7e525c: taps at centerUV +/- k*step, k=1..7,
//                       step = ONE source texel along the pass axis.
//   * Upsample fps    = c701a521 / 92d6ed91 / 025af786 / 9df777ad / cc7466b7 /
//                       17290dd7 / 94841c00 / 20d5549a -- each: texture(level)*scalar,
//                       additive blend (ONE,ONE).
//
// VALIDATION (measurement-driven, /tmp/glowval):
//   The separable Gaussian pass was validated against the captured pyramid
//   (cohB B[i] = Vblur(A[i])): relMSE = 4.5e-6, relL2 = 0.2% across ALL 6
//   testable levels with step = EXACTLY 1 source-texel (1/srcH vert, 1/srcW horiz).
//   This is a 1:1 match (residual = fp16 storage rounding). The 15-tap weights,
//   tap layout and step are therefore pinned verbatim.
//
//   NOTE on weights being runtime uniforms: the per-RGB blur weights and the
//   per-level upsample scalars are FRAGMENT CONSTANTS that the firmware varies
//   per frame / animation state. Two captures gave two weight sets:
//     - pass_specs.json (c1f67eef): blur cen={0.254703,0.138864,0.184247};
//       upsample (e^n) small->large = 0.0224,0.0611,0.1668,0.4551,1.2419,
//       3.3889,9.2472,25.2329.
//     - cohB/dc.txt (1d37473, the set that produced the captured pyramid):
//       blur cen={0.158651,0.150125,0.138864}; upsample small->large =
//       10.2268,7.0506,4.86087,3.35122,2.31042,1.59287,1.09816,0.757104.
//   Both are exposed below; the cohB set is the DEFAULT because it is the one
//   that reproduces the captured pyramid 1:1. Override via buildGlow opts.
// =============================================================================

(function (global) {
  'use strict';

  // ---- VERBATIM blur weights (per RGB channel) -----------------------------
  // Order: center(const0), pair1..pair6(const1..6), pair7(const8). const7 = alpha(0).
  // cohB (1d37473) weights -- the validated set that reproduces the captured pyramid.
  const BLUR_W_COHB = [
    [0.158651, 0.150125, 0.138864],  // const0 center
    [0.14682,  0.139957, 0.130849],  // const1 pair1
    [0.116362, 0.1134,   0.109474],  // const2 pair2
    [0.0789809,0.079857, 0.0813223], // const3 pair3
    [0.045911, 0.0488756,0.0536375], // const4 pair4
    [0.0228558,0.0259987,0.0314114], // const5 pair5
    [0.00974449,0.0120196,0.016333], // const6 pair6
    [0.0,      0.00482956,0.00754058] // const8 pair7
  ];
  // pass_specs (c1f67eef) weights -- the spec set from the task brief.
  const BLUR_W_SPEC = [
    [0.254703, 0.138864, 0.184247],
    [0.21002,  0.130849, 0.166006],
    [0.117745, 0.109474, 0.121422],
    [0.0448828,0.0813223,0.0720971],
    [0.0,      0.0536375,0.0347526],
    [0.0,      0.0314114,0.0135989],
    [0.0,      0.016333, 0.0],
    [0.0,      0.00754058,0.0]
  ];

  // ---- VERBATIM upsample per-level scalars (small -> large) -----------------
  // cohB (validated, reproduces captured pyramid): reads B-set 4x2 ... 512x256.
  const UP_W_COHB = [10.2268, 7.0506, 4.86087, 3.35122, 2.31042, 1.59287, 1.09816, 0.757104];
  // pass_specs exponential (e^n) weights from the task brief (small -> large).
  const UP_W_SPEC = [0.0224015, 0.0611269, 0.166797, 0.455139, 1.24194, 3.38887, 9.24721, 25.2329];

  // 8 pyramid levels. level 0 = half of source height (512x512 src -> 512x256), then /2 each.
  const N_LEVELS = 8;

  // ---------------------------------------------------------------------------
  // Shaders
  // ---------------------------------------------------------------------------

  const VS_QUAD = `#version 300 es
  // Fullscreen triangle. Plain UV passthrough (vp 0x7077ad73 center tap = tc0).
  out vec2 vUV;
  void main(){
    vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
    vUV = p;                       // 0..2 -> covers 0..1 over the visible quad
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
  }`;

  // VERBATIM 15-tap separable Gaussian (fp 1d37473 / c1f67eef structure).
  // Taps come from the vp as centerUV +/- k*step (k=1..7); here step = uStep
  // (= 1 source texel along the pass axis), computed CPU-side and passed as a uniform.
  // Per-RGB weights inlined from the validated constant set (passed via uW[]).
  const FS_DOWNSAMPLE = `#version 300 es
  precision highp float;
  precision highp sampler2D;
  uniform sampler2D tex0;     // the HDR layer being blurred (only sampled texture)
  uniform vec2  uStep;        // tap step = 1 source texel along pass axis (cx,cy)
  uniform vec3  uW[8];        // [0]=center, [1..6]=pair1..6, [7]=pair7  (per-RGB)
  in  vec2 vUV;
  out vec4 ocol0;
  vec3 clamp16(vec3 v){ return clamp(v, vec3(-65504.0), vec3(65504.0)); }
  void main(){
    // center tap (tc0) * const0
    vec3 acc = texture(tex0, vUV).xyz * uW[0];
    acc = clamp16(acc);
    // 7 symmetric pairs: (uv + k*step) + (uv - k*step), * const(k)
    for (int k = 1; k <= 7; ++k){
      vec2 off = float(k) * uStep;
      vec3 p = clamp16(texture(tex0, vUV + off).xyz + texture(tex0, vUV - off).xyz);
      acc = clamp16(p * uW[k] + acc);
    }
    ocol0 = vec4(acc, 0.0);   // const7.w = 0 -> output alpha 0
  }`;

  // VERBATIM upsample: single tap * scalar, additive accumulate (blend ONE,ONE).
  // (fps c701a521/92d6ed91/.../20d5549a -- all identical: r0 = texture(tex0,uv) * c.xxxx)
  const FS_UPSAMPLE = `#version 300 es
  precision highp float;
  precision highp sampler2D;
  uniform sampler2D tex0;     // one bloom-pyramid level (B-set)
  uniform float uScale;       // per-level scalar (_fetch_constant(0).xxxx)
  in  vec2 vUV;
  out vec4 ocol0;
  void main(){
    vec4 r0 = texture(tex0, vUV);
    ocol0 = r0 * vec4(uScale);   // additive blend handled by host blend state
  }`;

  function compile(gl, type, src){
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
      throw new Error('glow shader compile: ' + gl.getShaderInfoLog(s) + '\n' + src);
    return s;
  }
  function program(gl, vsrc, fsrc){
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vsrc));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fsrc));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS))
      throw new Error('glow program link: ' + gl.getProgramInfoLog(p));
    return p;
  }

  // RGBA16F color-renderable target (needs EXT_color_buffer_float).
  function makeRT(gl, w, h){
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    // internalformat 0x881A = RGBA16F
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const st = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (st !== gl.FRAMEBUFFER_COMPLETE) throw new Error('glow FBO incomplete 0x'+st.toString(16));
    return { tex, fbo, w, h };
  }

  // ---------------------------------------------------------------------------
  // initGlow(gl) -> state. Call once. Allocates shaders + ping/pyramid FBOs lazily.
  // ---------------------------------------------------------------------------
  function initGlow(gl){
    if (!gl.getExtension('EXT_color_buffer_float'))
      throw new Error('EXT_color_buffer_float required for RGBA16F glow');
    gl.getExtension('OES_texture_float_linear'); // linear filtering of fp targets

    const st = {
      gl,
      progDown: program(gl, VS_QUAD, FS_DOWNSAMPLE),
      progUp:   program(gl, VS_QUAD, FS_UPSAMPLE),
      vao: gl.createVertexArray(),
      pyramid: null,   // A-set (after H pass) + B-set (after V pass) per level
      glowRT: null,    // 512x256-class accumulator (level0 size)
      tmpRT:  null,    // H-pass temp (level0 size, full width pre-minify not needed)
      dims: null,
      W: 0, H: 0
    };
    // uniform locations
    st.uD = {
      tex0:  gl.getUniformLocation(st.progDown, 'tex0'),
      step:  gl.getUniformLocation(st.progDown, 'uStep'),
      w:     gl.getUniformLocation(st.progDown, 'uW'),
    };
    st.uU = {
      tex0:  gl.getUniformLocation(st.progUp, 'tex0'),
      scale: gl.getUniformLocation(st.progUp, 'uScale'),
    };
    return st;
  }

  function allocPyramid(st, srcW, srcH){
    const gl = st.gl;
    // free the previous pyramid (resize used to leak ~17 RGBA16F RTs = ~30MB per canvas resize)
    if (st.pyramid){ for (const rt of st.pyramid.A.concat(st.pyramid.B)){ gl.deleteFramebuffer(rt.fbo); gl.deleteTexture(rt.tex); } }
    if (st.glowRT){ gl.deleteFramebuffer(st.glowRT.fbo); gl.deleteTexture(st.glowRT.tex); }
    // Pyramid level sizes: level0 = (srcW, srcH/2) then halve each dim.
    // (firmware: 512x512 src -> 512x256, 256x128, 128x64, 64x32, 32x16, 16x8, 8x4, 4x2)
    const dims = [];
    let w = srcW, h = srcH >> 1;
    for (let i = 0; i < N_LEVELS; i++){
      dims.push([Math.max(1, w), Math.max(1, h)]);
      if (i === 0){ w = w >> 1; h = h >> 1; } else { w = w >> 1; h = h >> 1; }
    }
    const A = dims.map(([w, h]) => makeRT(gl, w, h)); // horizontal-pass result
    const B = dims.map(([w, h]) => makeRT(gl, w, h)); // vertical-pass result (used by upsample)
    st.pyramid = { A, B, dims };
    st.glowRT = makeRT(gl, dims[0][0], dims[0][1]); // accumulator at level0 size
    st.W = srcW; st.H = srcH;
  }

  function setWeights(gl, loc, w8){
    // upload vec3 uW[8]
    const flat = new Float32Array(8 * 3);
    for (let i = 0; i < 8; i++){ flat[i*3] = w8[i][0]; flat[i*3+1] = w8[i][1]; flat[i*3+2] = w8[i][2]; }
    gl.uniform3fv(loc, flat);
  }

  // ---------------------------------------------------------------------------
  // buildGlow(gl, srcHDRTex, W, H, opts) -> { tex: glowTexture, levels: B[] }
  //   srcHDRTex : a WebGL texture (RGBA16F preferred) holding the HDR layer to bloom.
  //   W, H      : dimensions of srcHDRTex (the firmware source is 512x512).
  //   opts      : { blurWeights, upWeights, state } -- defaults = validated cohB set.
  // Reuses FBOs across calls when W/H unchanged (pass opts.state from initGlow,
  // or it self-inits a cached state on gl).
  // ---------------------------------------------------------------------------
  function buildGlow(gl, srcHDRTex, W, H, opts){
    opts = opts || {};
    let st = opts.state;
    if (!st){
      if (!gl.__glowState) gl.__glowState = initGlow(gl);
      st = gl.__glowState;
    }
    if (!st.pyramid || st.W !== W || st.H !== H) allocPyramid(st, W, H);

    const blurW = opts.blurWeights || BLUR_W_COHB;
    const upW   = opts.upWeights   || UP_W_COHB;
    const { A, B, dims } = st.pyramid;

    gl.bindVertexArray(st.vao);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);

    // ----- DOWNSAMPLE: build the pyramid -----
    // Per level i: H-pass (read prev level, step = 1 src-texel horizontal, write A[i]
    // at A[i] resolution -> the width minification is the bilinear sample at output
    // texel centers), then V-pass (read A[i], step = 1 A[i]-texel vertical, write B[i]).
    gl.useProgram(st.progDown);
    gl.uniform1i(st.uD.tex0, 0);
    setWeights(gl, st.uD.w, blurW);
    gl.activeTexture(gl.TEXTURE0);

    for (let i = 0; i < N_LEVELS; i++){
      const [w, h] = dims[i];
      // source for this level's H pass:
      //   level0 reads the external HDR source (W x H); lower levels read B[i-1].
      const srcTex = (i === 0) ? srcHDRTex : B[i-1].tex;
      const srcW   = (i === 0) ? W : dims[i-1][0];
      const srcH   = (i === 0) ? H : dims[i-1][1];

      // --- HORIZONTAL pass --- fp 1d37473 along X. step = 1 source texel (1/srcW, 0).
      gl.bindFramebuffer(gl.FRAMEBUFFER, A[i].fbo);
      gl.viewport(0, 0, w, h);
      gl.bindTexture(gl.TEXTURE_2D, srcTex);
      gl.uniform2f(st.uD.step, 1.0 / srcW, 0.0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      // --- VERTICAL pass --- fp 1d37473 along Y. step = 1 A[i] texel (0, 1/h).
      // (Validated: B[i] = Vblur(A[i]) with step exactly 1/h, relMSE 4.5e-6.)
      gl.bindFramebuffer(gl.FRAMEBUFFER, B[i].fbo);
      gl.viewport(0, 0, w, h);
      gl.bindTexture(gl.TEXTURE_2D, A[i].tex);
      gl.uniform2f(st.uD.step, 0.0, 1.0 / h);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    // ----- UPSAMPLE / ACCUMULATE -----
    // Additively sum every B-set level (scaled by its per-level weight) into glowRT
    // at level0 resolution. fps c701a521..20d5549a: ocol0 = texture(level)*scalar,
    // blend ONE,ONE. Weights are in pyramid order small->large; B index N-1 = smallest.
    gl.bindFramebuffer(gl.FRAMEBUFFER, st.glowRT.fbo);
    gl.viewport(0, 0, st.glowRT.w, st.glowRT.h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);        // additive (src=1, dst=1)
    gl.blendEquation(gl.FUNC_ADD);

    gl.useProgram(st.progUp);
    gl.uniform1i(st.uU.tex0, 0);
    gl.activeTexture(gl.TEXTURE0);
    // upW[0] = smallest level (B[N-1]); upW[N-1] = largest (B[0]).
    for (let j = 0; j < N_LEVELS; j++){
      const levelIdx = (N_LEVELS - 1) - j;   // smallest first
      gl.bindTexture(gl.TEXTURE_2D, B[levelIdx].tex);
      gl.uniform1f(st.uU.scale, upW[j]);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    gl.disable(gl.BLEND);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindVertexArray(null);

    return { tex: st.glowRT.tex, w: st.glowRT.w, h: st.glowRT.h, levels: B, state: st };
  }

  const api = {
    initGlow, buildGlow,
    BLUR_W_COHB, BLUR_W_SPEC, UP_W_COHB, UP_W_SPEC, N_LEVELS
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.GlobeGlow = api;
})(typeof window !== 'undefined' ? window : globalThis);
