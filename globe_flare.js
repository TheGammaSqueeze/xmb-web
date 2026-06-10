// =============================================================================
// globe_flare.js -- VERBATIM WebGL2 port of the PS3 globe SUN-FLARE billboards.
// SOURCES (live shader-dump harvest, music globe): vp 0x48ad6e9761419744 +
// fp 0x4a9b1f2f9d30797b (bloom_tools/). 15 unit-quad billboards drawn into the
// display post-composite, blend SRC_ALPHA,ONE.
// FP: intensity = e^-(FALLOFF_X*|u| + FALLOFF_Y*|v|)  (FC1.y/FC2.x = SUN.mnu 9.40005/10.1)
//     gated by the geometric sun-visibility test sqrt(|dot(n*proj+sundir)|) >= FC6,
//     * FC7 color * 8 -> the dual tone-LUT display encode (same channels as the surface).
//     PURE PROCEDURAL - no scene textures (the bound tex0/tex1 in captures are stale).
// VS: clip = FC(3..6) rows; tc0 = (in_pos.xy + FC7.x)*FC7.y; tc1 = FC(0..2)·p - FC(8).
// Per-draw consts = the c[254+N] window from the per-frame capture rows.
// =============================================================================
(function (global) {
  'use strict';
  const VS = `#version 300 es
precision highp float;
in vec4 aPos;
uniform vec4 uVc[17];
uniform float uFlipY;
out vec4 tc0; out vec4 tc1;
#define FC(i) uVc[i]
void main(){
  vec4 in_pos = aPos;
  vec2 r1 = FC(7).xx + in_pos.xy;
  vec4 p;
  p.w = dot(vec4(in_pos.xyz,1.0), FC(6));
  p.z = dot(vec4(in_pos.xyz,1.0), FC(5));
  p.y = dot(vec4(in_pos.xyz,1.0), FC(4));
  p.x = dot(vec4(in_pos.xyz,1.0), FC(3));
  vec3 r0;
  r0.z = dot(vec4(in_pos.xyz,1.0), FC(2));
  r0.y = dot(vec4(in_pos.xyz,1.0), FC(1));
  r0.x = dot(vec4(in_pos.xyz,1.0), FC(0));
  tc1 = vec4(r0 - FC(8).xyz, 0.0);
  tc0 = vec4(r1 * FC(7).yy, 0.0, 0.0);
  gl_Position = vec4(p.x, p.y*uFlipY, 0.0, p.w);   // z handled by RPCS3's 2z-w on hw; depth unused here (drawn last, no test)
}`;
  const FS = `#version 300 es
precision highp float;
uniform sampler2D tex14; uniform sampler2D tex15;   // per-scene tone LUTs (.x=ch0, .y=ch1)
uniform vec4 uFc[8]; uniform float uDbg;
in vec4 tc0; in vec4 tc1;
out vec4 ocol0;
#define FC(i) uFc[i]
void main(){
  vec2 r0xy = tc0.xy + FC(0).xx;                     // FC0 = -0.5 (centering)
  float fall = abs(r0xy.y)*FC(1).y;
  vec3 T = tc1.xyz;                                  // plain varying (perspective-equivalence proven for this family)
  float tlen2 = dot(T,T);
  fall = -abs(r0xy.x)*FC(2).x - fall;                // -(9.4|u| + 10.1|v|)
  vec3 n = (tlen2>0.0) ? T/sqrt(tlen2) : T;
  float proj = dot(n, -FC(3).xyz);
  vec3 q = n*proj + FC(4).xyz;
  float qd = dot(q,q);
  float ex = fall*FC(5).x;                           // *1.4427 (1/ln2)
  float vis = (sqrt(abs(qd)) >= FC(6).x) ? 1.0 : 0.0;   // VERBATIM gate (4a9b1f2f decompile; vindicated once the vp ucode gave the true FC registers - the earlier flip compensated a register-mapping error)
  if(uDbg>0.5&&uDbg<1.5){ ocol0=vec4(1.0,0.0,0.0,1.0); return; }   // 1: solid red where the quad rasterizes
  if(uDbg>1.5&&uDbg<2.5){ ocol0=vec4(vec3(exp2(ex)),1.0); return; }  // 2: falloff intensity only
  if(uDbg>2.5&&uDbg<3.5){ ocol0=vec4(0.0,vis,0.0,1.0); return; }     // 3: gate only
  if(uDbg>3.5&&uDbg<4.5){ vec4 c4=exp2(ex)*FC(7)*vis; ocol0=vec4(c4.xyz,1.0); return; }  // 4: pre-LUT color
  if(uDbg>4.5){ vec4 c5=exp2(ex)*FC(7)*vis; vec3 r85=c5.xyz*8.0;
    vec2 a15=texture(tex15, r85.xy*(1.0/128.0)).xy;
    vec2 a14=texture(tex14, vec2(r85.z,max(r85.x,r85.y))*(1.0/128.0)).xy;
    ocol0=vec4(a15.y,a15.x,a14.y,1.0); return; }   // 5: LUT output (opaque)
  vec4 col = exp2(ex) * FC(7) * vis;
  vec3 r8 = col.xyz*8.0;
  vec2 s15 = texture(tex15, r8.xy*(1.0/128.0)).xy;
  vec2 s14 = texture(tex14, vec2(r8.z, max(r8.x,r8.y))*(1.0/128.0)).xy;
  ocol0 = vec4(s15.y, s15.x, s14.y, col.w);          // alpha = the ungated intensity (the SRC_ALPHA,ONE blend weight)
}`;
  let prog=null, vbo=null;
  // the unit billboard quad (the captured u004 stream: +-1 with uv via FC7)
  const QUAD=new Float32Array([-1,-1,0,1,  1,-1,0,1,  -1,1,0,1,  1,1,0,1]);
  function init(gl){
    function sh(t,s){ const o=gl.createShader(t); gl.shaderSource(o,s); gl.compileShader(o);
      if(!gl.getShaderParameter(o,gl.COMPILE_STATUS)) throw new Error('flare shader: '+gl.getShaderInfoLog(o)); return o; }
    prog=gl.createProgram(); gl.attachShader(prog,sh(gl.VERTEX_SHADER,VS)); gl.attachShader(prog,sh(gl.FRAGMENT_SHADER,FS));
    gl.linkProgram(prog);
    if(!gl.getProgramParameter(prog,gl.LINK_STATUS)) throw new Error('flare link: '+gl.getProgramInfoLog(prog));
    vbo=gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER,vbo); gl.bufferData(gl.ARRAY_BUFFER,QUAD,gl.STATIC_DRAW);
    return true;
  }
  // draw one billboard. o = {vc:[17][4], fc:[8][4], lut14, lut15, flipY}
  function draw(gl,o){
    if(!prog) return;
    gl.useProgram(prog); const U=n=>gl.getUniformLocation(prog,n);
    gl.bindBuffer(gl.ARRAY_BUFFER,vbo);
    const loc=gl.getAttribLocation(prog,'aPos'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc,4,gl.FLOAT,false,0,0);
    const flat=(a,n)=>{ const f=new Float32Array(n*4); for(let i=0;i<n&&i<a.length;i++) for(let j=0;j<4;j++) f[i*4+j]=a[i][j]; return f; };
    gl.uniform4fv(U('uVc'),flat(o.vc,17)); gl.uniform4fv(U('uFc'),flat(o.fc,8));
    gl.uniform1f(U('uFlipY'),o.flipY!==undefined?o.flipY:1.0);
    gl.uniform1f(U('uDbg'),(typeof window!=='undefined'&&window.__flareDbg)?+window.__flareDbg:0.0);
    const bind=(u,n,t)=>{ gl.activeTexture(gl.TEXTURE0+u); gl.bindTexture(gl.TEXTURE_2D,t); gl.uniform1i(U(n),u); };
    bind(0,'tex14',o.lut14); bind(1,'tex15',o.lut15);
    gl.enable(gl.BLEND); gl.blendFuncSeparate(gl.SRC_ALPHA,gl.ONE,gl.ZERO,gl.ONE);   // the captured blend: src=770(SRC_ALPHA) dst=1(ONE)
    gl.drawArrays(gl.TRIANGLE_STRIP,0,4);
    gl.disable(gl.BLEND);
  }
  global.GlobeFlare = { init, draw, VER: 1 };
})(typeof window!=='undefined'?window:globalThis);
