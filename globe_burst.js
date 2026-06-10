// =============================================================================
// globe_burst.js -- VERBATIM WebGL2 port of the PS3 globe SUN-GLARE/BURST pass.
// SOURCES: vp 0xc868fd6aeb6c98fd + fp 0xac07b20f74b9959b (RPCS3 decompiles, mechanically
// extracted+transformed by /work/ps3 generator; transforms: TEX2D->texture, fma->xfma,
// chained-swizzle flatten, paren-swizzle vec4() wrap [ESSL], LUT 1/128 UN-scale +
// 0x0000aae4 channel remap exactly as the validated surface port).
// Consts per draw from flare_scene_NN_cap2.json (fp fc[0..16]) + c[0..16] vp consts
// (globecap5 widened dumper). Geometry (tri-fan in_pos) from the VERTS capture.
// tex1 = the LDR scene (F_disp), tex0 = burst shape, tex14/15 = per-scene tone LUTs.
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
vec4 xfma(vec4 a, vec4 b, vec4 c){ return a*b+c; }
void main(){
  vec4 dst_reg0=vec4(0.,0.,0.,1.), dst_reg7=vec4(0.), dst_reg8=vec4(0.), dst_reg9=vec4(0.);

	vec4 r1 = vec4(0.);
	vec4 r3 = vec4(0.);
	vec4 r2 = vec4(0.);
	vec4 r0 = vec4(0.);
	vec4 in_pos= aPos;
	r1 = (in_pos.xyxy * FC(8).yxwz);
	r3.xy = vec4(FC(7).xxxx + in_pos.xyxx).xy;
	dst_reg0.w = vec4(dot(vec4(in_pos.xyz, 1.0), FC(6))).w;
	dst_reg0.z = vec4(dot(vec4(in_pos.xyz, 1.0), FC(5))).z;
	dst_reg0.y = vec4(dot(vec4(in_pos.xyz, 1.0), FC(4))).y;
	dst_reg0.x = vec4(dot(vec4(in_pos.xyz, 1.0), FC(3))).x;
	r2.z = FC(8).x;
	r2.w = -FC(8).y;
	r2.x = FC(8).z;
	r2.y = -FC(8).w;
	r0.z = vec4(dot(vec4(in_pos.xyz, 1.0), FC(2))).z;
	r0.y = vec4(dot(vec4(in_pos.xyz, 1.0), FC(1))).y;
	r0.x = vec4(dot(vec4(in_pos.xyz, 1.0), FC(0))).x;
	r1.xy = vec4(r1.zxzz + r1.wyww).xy;
	dst_reg8.xyz = vec4(-FC(9).xyzx + r0.xyzx).xyz;
	r0.xy = vec4(in_pos.xyxx * r2.xyxx).xy;
	r0.zw = vec4(in_pos.xxxy * r2.zzzw).zw;
	r2.x = vec4(r0.zzzz + r0.wwww).x;
	r0.x = vec4(r0.xxxx + r0.yyyy).x;
	r2.y = r1.y;
	r0.y = r1.x;
	r2.zw = r0.xy;
	r0 = (FC(7).xxxx + r2);
	dst_reg7.xy = vec4(r3.xyxx * FC(7).yyyy).xy;
	dst_reg9 = (r0 * FC(7).yyyy);

  tc0 = dst_reg7; tc1 = dst_reg8;
  gl_Position = vec4(dst_reg0.x, dst_reg0.y*uFlipY, dst_reg0.z, dst_reg0.w);
}`;
  const FS = `#version 300 es
precision highp float;
uniform sampler2D tex0;
uniform sampler2D tex1;
uniform sampler2D tex14;
uniform sampler2D tex15;
uniform vec4 uFc[17];
uniform vec2 uWH;
uniform float uLutScale;
in vec4 tc0; in vec4 tc1;
out vec4 ocol0;
#define FC(i) uFc[i]
#define _select mix
vec4 xfma(vec4 a, vec4 b, vec4 c){ return a*b+c; }
vec2 clamp16v2(vec2 v){ return unpackHalf2x16(packHalf2x16(v)); }
vec4 clamp16(vec4 v){ return vec4(clamp16v2(v.xy), clamp16v2(v.zw)); }
#define _builtin_sqrt(x) sqrt(abs(x))
#define _builtin_rcp(x) (1. / x)
#define _builtin_div(x, y) (x / y)
vec4 _builtin_divsq(vec4 a, float b){ vec4 t=a/_builtin_sqrt(b); return _select(a,t,greaterThan(abs(a),vec4(0.))); }
vec4 precision_clamp(vec4 x, float mn, float mx){ x=_select(x,vec4(0.),isnan(x)); return clamp(x,mn,mx); }
vec4 get_wpos(){ return vec4(gl_FragCoord.x, gl_FragCoord.y, gl_FragCoord.zw); }   // VERIFIED vs the real present (numpy reference, corr 0.892): wpos is y-up = WebGL gl_FragCoord directly
vec4 r0=vec4(0.), r2=vec4(0.);
void fs_main(){

	vec4 r1 = vec4(0.);
	vec4 h2 = vec4(0.);
	vec4 wpos = get_wpos();
	r0.z = vec4(dot(vec4(tc1).xyz, vec4(tc1).xyz)).z;
	r0.x = (1.0/(FC(0).x));
	r1.w = FC(1).x;
	r1.xyz = _builtin_divsq((tc1), r0.z).xyz;
	r1.w = vec4(r1 + FC(2).xxxx).w;
	r0.z = vec4(dot(r1.xyz, -FC(3).xyz)).z;
	r0.y = (1.0/(FC(4).y));
	r1.xyz = xfma(r1, r0.zzzz, FC(5)).xyz;
	r0.xy = vec4(wpos * r0).xy;
	r1.w = (1.0/(r1.w));
	r0.w = vec4(dot(r1.xyz, r1.xyz)).w;
	r0.xy = xfma(-r0, FC(6).xyxx, abs(FC(6).zxzw)).xy;
	r0.xyz = texture(tex1, r0.xy).xyz;
	r1.xyz = vec4(-r0 + FC(7).xxxx).xyz;
	r1.xyz = vec4(xfma(-r0, r1, r1) / 4.).xyz;
	r2.w = vec4(xfma(r0.yyyy, FC(8).yyyy, r1.yyyy) * 4.).w;
	r1.z = vec4(xfma(r0, FC(9).yyyy, r1) * 4.).z;
	r2.x = _builtin_divsq(abs(r0.wwww), r0.w).x;
	r0.w = vec4(xfma(r0.xxxx, FC(10).yyyy, r1.xxxx) * 4.).w;
	r1.x = _builtin_divsq(abs(r0.wwww), r0.w).x;
	r0.w = precision_clamp((xfma(r2.xxxx, r1, -r1) * 2.), 0., 1.).w;
	r1.y = _builtin_divsq(abs(r2.wwww), r2.w).y;
	r1.w = FC(11).y;
	r1.w = vec4(r1 * FC(12)).w;
	r2.xyz = xfma(r0.wwww, -FC(13), r0.wwww).xyz;
	r1.z = _builtin_divsq(abs(r1), r1.z).z;
	r0.xyz = vec4(r0 + r1).xyz;
	r0.w = (1.0/(r1.w));
	r0.xyz = xfma(r0, r0.wwww, -r0.wwww).xyz;
	r0.w = FC(14).x;
	r0.xyz = _builtin_div(r0, FC(15).x).xyz;
	r2.xyz = vec4(r2 + FC(16)).xyz;
	r1.xyz = texture(tex0, tc0.xy).xyz;
	r0.xyz = vec4(xfma(r1, r2, r0) * 8.).xyz;
	h2.z = clamp16(r0).z;
	h2.w = max(r0.xxxx, r0.yyyy).w;
	r0.xy = texture(tex15, r0.xy*uLutScale).yx;   // UN-scale 1/128 + remap 0x0000aae4 (R=ch1,G=ch0)
	r0.xy = r0.xy;
	r0.z = texture(tex14, h2.zw*uLutScale).y;   // B = tex14.ch1
	r0.z = r0.z;

}
uniform float uDbg;
  void main(){
    if(uDbg>0.5 && uDbg<1.5){ ocol0=vec4(texture(tex0, tc0.xy).xyz, 1.0); return; }          // 1: shape sample
    if(uDbg>1.5 && uDbg<2.5){ vec4 wp=get_wpos(); vec2 uv=vec2(wp.x/uWH.x, wp.y/uWH.y); ocol0=vec4(texture(tex1, uv).xyz,1.0); return; }  // 2: occlusion sample
    fs_main();
    if(uDbg>2.5 && uDbg<3.5){ ocol0=vec4(abs(r2.xyz),1.0); return; }                          // 3: color factor
    if(uDbg>3.5){ ocol0=vec4(clamp(abs(r0.xyz)/8.0,0.,1.),1.0); return; }                     // 4: pre/post-LUT magnitude
    ocol0 = vec4(r0.xyz, 1.0);
  }`;
  let prog=null, vbo=null;
  function init(gl){
    function sh(t,s){ const o=gl.createShader(t); gl.shaderSource(o,s); gl.compileShader(o);
      if(!gl.getShaderParameter(o,gl.COMPILE_STATUS)) throw new Error('burst shader: '+gl.getShaderInfoLog(o)); return o; }
    prog=gl.createProgram(); gl.attachShader(prog,sh(gl.VERTEX_SHADER,VS)); gl.attachShader(prog,sh(gl.FRAGMENT_SHADER,FS));
    gl.linkProgram(prog);
    if(!gl.getProgramParameter(prog,gl.LINK_STATUS)) throw new Error('burst link: '+gl.getProgramInfoLog(prog));
    vbo=gl.createBuffer();
    return true;
  }
  function draw(gl, o){
    if(!prog) return;
    gl.useProgram(prog); const U=n=>gl.getUniformLocation(prog,n);
    gl.bindBuffer(gl.ARRAY_BUFFER,vbo); gl.bufferData(gl.ARRAY_BUFFER,o.verts,gl.STREAM_DRAW);
    const loc=gl.getAttribLocation(prog,'aPos'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc,4,gl.FLOAT,false,0,0);
    const flat=a=>{ const f=new Float32Array(17*4); for(let i=0;i<17&&i<a.length;i++) for(let j=0;j<4;j++) f[i*4+j]=a[i][j]; return f; };
    gl.uniform4fv(U('uVc'),flat(o.vc)); gl.uniform4fv(U('uFc'),flat(o.fc));
    gl.uniform1f(U('uFlipY'),o.flipY!==undefined?o.flipY:1.0);
    gl.uniform2f(U('uWH'),o.w||1920,o.h||1080);
    gl.uniform1f(U('uLutScale'),o.lutScale||0.0078125);
    gl.uniform1f(U('uDbg'),o.dbg||0.0);
    const bind=(u,n,t)=>{ gl.activeTexture(gl.TEXTURE0+u); gl.bindTexture(gl.TEXTURE_2D,t); gl.uniform1i(U(n),u); };
    bind(0,'tex0',o.shapeTex); bind(1,'tex1',o.sceneTex); bind(2,'tex14',o.lut14); bind(3,'tex15',o.lut15);
    gl.enable(gl.BLEND); gl.blendFuncSeparate(gl.ONE,gl.ONE,gl.ZERO,gl.ONE);   // additive color; alpha keeps the display exponent channel
    gl.drawArrays(gl.TRIANGLE_FAN,0,o.verts.length/4);
    gl.disable(gl.BLEND); gl.blendFunc(gl.ONE,gl.ONE);
  }
  global.GlobeBurst = { init, draw, VER: 5 };
})(typeof window!=='undefined'?window:globalThis);
