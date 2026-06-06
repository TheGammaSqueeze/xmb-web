// ============================================================================
// PS3 XMB Music "Globe" visualizer -- VERBATIM firmware port (self-contained module).
// Ported 1:1 from the verified globe_animated_full.html: real RSX surface vp+fp microcode,
// real captured 24-patch firmware DXT1 tiles + float HDR LUTs, real firmware camera.path
// animation (Catmull-Rom, measured) + firmware HDR.mnu tonemap. NO approximations.
//   surface match vs real RT: 0.65/255 over the disc (see project_globe_renderer_build).
// Runs on its OWN WebGL2 canvas (the Time Zone globe stays on its WebGL1 context untouched).
// Usage:  MPGlobe.start(canvasEl);  MPGlobe.stop();
// ============================================================================
(function(global){
'use strict';
const BASE = 'globe_assets/';
// main scenes in numeric order. Per-scene camera motion is EXACT (firmware camera.path +
// Catmull-Rom); only the cross-scene ORDER is a documented approximation (the real top-level
// sequencer lives in the un-dumped vsh music module). Each preset plays once then advances.
const PRESETS = ['preset_0','preset_1','preset_2','preset_3','preset_4',
                 'preset_5','preset_6','preset_7','preset_8','preset_9'];

let gl=null, canvas=null, prog=null, raf=0, running=false;
let D=null, eMesh=null, want=0, got=0, sharedTex={}, patchTex=[], black=null;
let PATHS=null, animT=0, preset=null, presetIdx=7, errlog='';

const _sub=(a,b)=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]];
const _cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const _norm=(a)=>{const l=Math.hypot(a[0],a[1],a[2])||1;return[a[0]/l,a[1]/l,a[2]/l];};
const _dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];

const VS=`#version 300 es
precision highp float;
in vec4 in_pos; uniform vec4 vc[26]; uniform float uFlipY;
out vec4 tc0,tc3,tc4,tc5,tc6,tc8,tc9; out vec3 vN; out vec3 vL;
float fma1(float a,float b,float c){return a*b+c;}
vec3 fma3(vec3 a,vec3 b,vec3 c){return a*b+c;}
vec2 fma2(vec2 a,vec2 b,vec2 c){return a*b+c;}
void main(){
vec4 ip = in_pos;
  vec4 r0=vec4(0.), r1=vec4(0.), r2=vec4(0.), r3=vec4(0.), r4=vec4(0.), r5=vec4(0.), r6=vec4(0.), r7=vec4(0.), cc0=vec4(0.);
  vec4 d12=vec4(0,0,0,1), d10=vec4(0,0,0,1), d7=vec4(0,0,0,1), d15=vec4(0,0,0,1),
       d11=vec4(0,0,0,1), d8=vec4(0,0,0,1), d9=vec4(0,0,0,1), d0=vec4(0,0,0,1),
       d14=vec4(0,0,0,1), d6=vec4(0,0,0,1), d13=vec4(0,0,0,1);
  d12.y = vc[12].x; d12.z = vc[12].y;
  r7.xy = (ip.zw + -ip.xy);
  d10.z = vc[14].y;
  r0.w = (-vc[21].x + vc[21].y);
  r2.w = (vc[12].z + ip.x);
  r1.w = vc[15].w;
  r3.x = vc[0].z; r3.y = vc[1].z; r3.z = vc[2].z;
  r1.x = vc[0].w; r1.y = vc[1].w; r1.z = vc[2].w;
  r2.x = vc[0].y; r2.y = vc[1].y; r2.z = vc[2].y;
  r0.x = vc[0].x; r0.y = vc[1].x; r0.z = vc[2].x;
  r2.xyz = (r2.xyz + -r0.xyz);
  r4.xyz = (r3.xyz + -r1.xyz);
  r1.w = (-vc[16].y + r1.w);
  r5.xyz = fma3(r4.xyz, r2.www, r1.xyz);
  r3.xyz = fma3(ip.zzz, r4.xyz, r1.xyz);
  r1.xyz = fma3(ip.xxx, r4.xyz, r1.xyz);
  r6.xyz = fma3(r2.xyz, r2.www, r0.xyz);
  r4.xyz = fma3(ip.zzz, r2.xyz, r0.xyz);
  r0.xyz = fma3(ip.xxx, r2.xyz, r0.xyz);
  r2.xyz = (r5.xyz + -r6.xyz);
  r1.xyz = (r1.xyz + -r0.xyz);
  r3.xyz = (r3.xyz + -r4.xyz);
  r0.xyz = fma3(ip.yyy, r1.xyz, r0.xyz);
  r1.xyz = fma3(ip.yyy, r2.xyz, r6.xyz);
  r2.w = dot(r0.xyz, r0.xyz);
  r2.xyz = fma3(ip.www, r3.xyz, r4.xyz);
  r3.x = dot(r1.xyz, r1.xyz);
  r2.w = inversesqrt(max(r2.w, 1e-10));
  r4.xyz = (-r0.xyz + r2.xyz);
  r2.xyz = (r2.www * r0.xyz);
  r3.w = inversesqrt(max(r3.x, 1e-10));
  r3.xyz = (-vc[18].xyz + r2.xyz);
  r1.xyz = fma3(r3.www, r1.xyz, -r2.xyz);
  r3.y = dot(r3.xyz, r3.xyz);
  r2.y = (1.0 / vc[22].w);
  r3.x = dot(r1.xyz, r1.xyz);
  r2.x = (1.0 / r0.w);
  d10.x = vc[14].y;
  r0.w = inversesqrt(max(r3.y, 1e-10));
  r2.w = vc[14].w;
  r3.x = inversesqrt(max(r3.x, 1e-10));
  r3.w = (r2.y * vc[12].w);
  r0.w = (1.0 / r0.w);
  r0.w = (-vc[21].x + r0.w);
  r1.xyz = (r3.x * r1.xyz);
  r0.w = clamp((r0.w * r2.x), 0.0, 1.0);
  r2.x = fma1(-r0.w, vc[15].x, vc[15].y);
  r0.w = (r0.w * r0.w);
  r0.w = (r0.w * r2.x);
  r0.xyz = fma3(r0.www, r4.xyz, r0.xyz);
  r2.xy = fma2(r0.ww, r7.xy, ip.xy);
  r2.z = dot(r0.xyz, r0.xyz);
  d7.zw = fma2(vec2(r2.x, r2.y), vc[24].zz, vc[24].xy);
  d7.xy = fma2(vec2(r2.x, r2.y), vc[25].zz, vc[25].xy);
  d15.zw = fma2(vec2(r2.x, r2.y), vc[22].zz, vc[22].xy);
  d11.x = r0.w;
  r2.z = inversesqrt(max(r2.z, 1e-10));
  d15.xy = fma2(vec2(r2.x, r2.y), vc[23].zz, vc[23].xy);
  r2.xyz = (r2.z * r0.xyz);
  r4.xyz = (r2.yzx * r1.zxy);
  d8.xyz = r2.xyz;
  r5.y = dot(vec4(r2.xyz,1.0), vc[10]);
  r5.x = dot(vec4(r2.xyz,1.0), vc[9]);
  r6.x = dot(r2.xyz, vc[17].xyz);
  r0.w = dot(vec4(r2.xyz,1.0), vc[6]);
  r0.z = dot(vec4(r2.xyz,1.0), vc[5]);
  r4.w = dot(vec4(r2.xyz,1.0), vc[11]);
  r0.y = dot(vec4(r2.xyz,1.0), vc[4]);
  r0.x = dot(vec4(r2.xyz,1.0), vc[3]);
  r5.w = dot(vec4(r2.xyz,1.0), vc[8]);
  r5.z = dot(vec4(r2.xyz,1.0), vc[7]);
  r3.xyz = (vc[18].xyz + -r2.xyz);
  d9.xy = (r0.xy + -r5.zw);
  r4.xyz = fma3(r2.zxy, r1.yzx, -r4.xyz);
  r5.w = (-vc[16].y + r4.w);
  d0 = r0;
  r0.xyz = fma3(-r2.xyz, r6.xxx, vc[17].xyz);
  r5.z = r4.w;
  r0.w = (1.0 / r1.w);
  r4.w = dot(r3.xyz, r3.xyz);
  d12.x = (r5.w * r0.w);
  r1.w = dot(r4.xyz, r4.xyz);
  r0.w = dot(r5.xyz, vc[19].xyz);
  r6.x = dot(r1.xyz, r0.xyz);
  r4.w = inversesqrt(max(r4.w, 1e-10));
  r5.xyz = fma3(-r0.www, vc[19].xyz, r5.xyz);
  r0.w = min(r0.w, vc[15].w);
  r1.w = inversesqrt(max(r1.w, 1e-10));
  r3.xyz = (r4.www * r3.xyz);
  r0.w = max(r0.w, vc[14].x);
  r4.xyz = (r1.www * r4.xyz);
  r1.w = dot(r5.xyz, r5.xyz);
  r6.w = dot(r2.xyz, r3.xyz);
  r4.w = (r0.w < vc[14].y) ? 1.0 : 0.0;
  r6.z = (vc[15].w + -abs(r0.w));
  r5.w = fma1(r2.w, abs(r0.w), vc[13].x);
  d14.xyz = r3.xyz;
  r6.y = dot(r4.xyz, r0.xyz);
  r0.xyz = fma3(-r2.xyz, r6.www, r3.xyz);
  r2.x = fma1(abs(r0.w), r5.w, -vc[13].y);
  d6.xy = (r3.w * r6.xy);
  r2.y = inversesqrt(max(r1.w, 1e-10));
  r1.w = dot(r0.xyz, r4.xyz);
  r2.z = inversesqrt(max(r6.z, 1e-10));
  r1.z = dot(r0.xyz, r1.xyz);
  r0.w = fma1(abs(r0.w), r2.x, vc[13].z);
  r0.xyz = (r2.yyy * r5.xyz);
  r1.x = (1.0 / r2.z);
  r0.x = dot(r0.xyz, vc[20].xyz);
  r0.y = (r0.w * r1.x);
  r0.x = min(r0.x, vc[15].w);
  r0.z = (r4.w * r0.y);
  r0.y = fma1(-r0.z, vc[15].x, r0.y);
  r0.x = max(r0.x, vc[14].x);
  r1.x = (1.0 / r2.y);
  r0.y = fma1(r4.w, vc[14].z, r0.y);
  r0.z = fma1(abs(r0.x), r2.w, vc[13].x);
  r0.w = (vc[15].w + -abs(r0.x));
  r0.z = fma1(abs(r0.x), r0.z, -vc[13].y);
  d13.xy = (r1.zw * r3.w);
  r0.w = inversesqrt(max(r0.w, 1e-10));
  r0.z = fma1(abs(r0.x), r0.z, vc[13].z);
  cc0.x = (r1.x < vc[15].z) ? 1.0 : 0.0;
  r0.w = (1.0 / r0.w);
  r0.x = (r0.x < vc[14].y) ? 1.0 : 0.0;
  r0.z = (r0.z * r0.w);
  r1.x = (1.0 / vc[16].x);
  r0.w = (r0.x * r0.z);
  r0.z = fma1(-r0.w, vc[15].x, r0.z);
  r0.x = fma1(r0.x, vc[14].z, r0.z);
  d10.y = (r0.y * r1.x);
  d10.x = (cc0.x == 0.0) ? (r0.x * vc[13].w) : d10.x;
  tc0=d7; vN=d14.xyz; vL=d8.xyz; tc3=d10; tc4=d11; tc5=d12; tc6=d13; tc8=d15; tc9=d6;
  vec4 clip=d0;
  vec2 ndc=clip.xy/clip.w; vec2 win=ndc*vec2(960.0,-540.0)+vec2(960.0,540.0);
  clip.xy=((win/vec2(960.0,540.0))-1.0)*clip.w;
  clip.z=clip.z*2.0-clip.w; clip.y*=uFlipY; gl_Position=clip;
}`;
const FS=`#version 300 es
precision highp float;
in vec4 tc0,tc3,tc4,tc5,tc6,tc8,tc9; in vec3 vN; in vec3 vL;
uniform sampler2D tex0,tex1,tex2,tex3,tex4,tex5,tex6,tex13,tex14,tex15;
uniform vec4 fc[23];
out vec4 ocol0;
vec3 nrm(vec3 v){return length(v)>0.0?normalize(v):v;}
vec3 fma3(vec3 a,vec3 b,vec3 c){return a*b+c;}
vec2 fma2(vec2 a,vec2 b,vec2 c){return a*b+c;}
float fma1(float a,float b,float c){return a*b+c;}
vec3 pc3(vec3 x,float a,float b){return clamp(x,a,b);}
void main(){
  vec4 tc1=vec4(vL,1.0), tc7=vec4(vN,1.0);
  vec4 r0=vec4(0.),r1=vec4(0.),r2=vec4(0.),r3=vec4(0.),r4=vec4(0.);
  vec4 h0=vec4(0.),h1=vec4(0.),h2=vec4(0.),h3=vec4(0.),h4=vec4(0.),h5=vec4(0.),h6=vec4(0.),h7=vec4(0.);
  r2.xyz = texture(tex0, tc0.xy).xyz;
  h2.xyz = nrm(tc7.xyz);
  r3.xyz = texture(tex1, tc0.zw).xyz;
  r3.xyz = (r3.xyz + -r2.xyz);
  r4.xyz = fma3(tc4.xxx, r3.xyz, r2.xyz);
  h0.xyz = nrm(tc1.xyz);
  h3.z = (dot(h2.xyz,h0.xyz)/2.0);
  r0.z = (dot(-h2.xyz,h0.xyz)*2.0);
  r1.w = (h3.z + fc[0].x);
  r0.xyz = fma3(-h0.xyz, r0.zzz, -h2.xyz);
  h1.zw = tc8.zw;
  r3.xyz = (-r4.xyz + fc[1].xyz);
  r2.x = texture(tex2, tc8.zw).x;
  h7.w = fma1(r2.x, fc[2].x, fc[2].y);
  r2.x = texture(tex3, tc8.xy).x;
  r1.xyz = fma3(r2.xxx, r3.xyz, r4.xyz);
  r4.zw = tc9.xy;
  r4.y = fc[3].y;
  h5.xyz = (r1.xyz * fc[4].x);
  r3.xy = tc6.xy;
  r4.x = fc[5].y;
  r1.xy = fma2(r3.xy, h7.ww, h1.zw);
  r1.xyz = texture(tex2, r1.xy).xyz;
  h7.xyz = (r1.xyz * fc[6].z);
  h7.w = r2.x;
  h6.xyz = (-h5.xyz + fc[7].w);
  h5.xyz = fma3(h7.xyz, h6.xyz, h5.xyz);
  h7.z = dot(r0.xyz, fc[8].xyz);
  r0.xy = fma2(r4.zw, fc[9].xx, h1.zw);
  r0.xyz = texture(tex2, r0.xy).xyz;
  h0.xyz = pc3(fma3(-r1.xyz, fc[10].xxx, r0.xyz), 0.,1.);
  h0.w = fc[11].y;
  r0.zw = fc[12].xy;
  r2.x = texture(tex6, h7.zw).x;
  h1.xyz = fma3(r1.www, fc[13].xyz, vec3(r0.z,r0.w,r0.w));
  r3.x = fc[14].x;
  r4.z = fc[15].y;
  r3.y = fc[16].x;
  r3.z = fc[17].x;
  r1 = texture(tex4, tc3.xy);
  h6.xyz = fma3(-r1.www, r3.xyz, r4.xyz);
  r4.xyz = texture(tex5, tc5.xy).xyz;
  h6.xyz = (r4.xyz * h6.xyz);
  h2.xyz = (r1.xyz * fc[18].y);
  h4.xyz = fma3(h1.xyz, r2.xxx, h5.xyz);
  h3.xyz = fma3(-h0.xyz, h0.www, fc[19].xxx);
  r3.xyz = max(h6.xyz, fc[20].xxx);
  r2.xyz = (h4.xyz * r3.xyz);
  r2.xyz = (fma3(r2.xyz, h3.xyz, h2.xyz) * 8.0);
  // firmware globe HDR.mnu tonemap of the HDR scene r2: EXPOSURE 0.789, WHITE LEVEL 3.40918,
  // extended Reinhard, GAMMA 1. Real .mnu params, verified vs the real surface RT (0.65/255).
  vec3 tc = r2.xyz * 0.789;
  float W = 3.40918;
  tc = (tc*(1.0 + tc/(W*W)))/(1.0 + tc);
  ocol0 = vec4(clamp(tc,0.0,1.0), 1.0);
}`;

function sh(t,s){const o=gl.createShader(t);gl.shaderSource(o,s);gl.compileShader(o);if(!gl.getShaderParameter(o,gl.COMPILE_STATUS))errlog+=gl.getShaderInfoLog(o);return o;}
function texPNG(src){const t=gl.createTexture();gl.bindTexture(3553,t);gl.texImage2D(3553,0,6408,1,1,0,6408,5121,new Uint8Array([0,0,0,255]));want++;
 const im=new Image();im.onload=function(){if(!gl)return;gl.bindTexture(3553,t);gl.texImage2D(3553,0,6408,6408,5121,im);gl.texParameteri(3553,10241,9729);gl.texParameteri(3553,10240,9729);gl.texParameteri(3553,10242,33071);gl.texParameteri(3553,10243,33071);got++;};im.src=src;return t;}
function texF32(src,w,h){const t=gl.createTexture();gl.bindTexture(3553,t);gl.texImage2D(3553,0,34836,1,1,0,6408,5126,new Float32Array([0,0,0,1]));want++;
 fetch(src).then(r=>r.arrayBuffer()).then(ab=>{if(!gl)return;gl.bindTexture(3553,t);gl.texImage2D(3553,0,34836,w,h,0,6408,5126,new Float32Array(ab));gl.texParameteri(3553,10241,9729);gl.texParameteri(3553,10240,9729);gl.texParameteri(3553,10242,33071);gl.texParameteri(3553,10243,33071);got++;});return t;}
function blackTex(){const t=gl.createTexture();gl.bindTexture(3553,t);gl.texImage2D(3553,0,6408,1,1,0,6408,5121,new Uint8Array([0,0,0,255]));return t;}

function buildVC(corners){const s=D.shared;const vc=new Float32Array(104);const set=(i,a)=>{vc[i*4]=a[0];vc[i*4+1]=a[1];vc[i*4+2]=a[2];vc[i*4+3]=a[3];};
 set(0,corners[0]);set(1,corners[1]);set(2,corners[2]);
 const map={3:260,4:261,5:262,6:263,7:264,8:265,9:268,10:269,11:270,12:454,13:455,14:456,15:457,16:458,17:459,18:460,19:461,20:462,21:463,22:464,23:465,24:466,25:467};
 for(const k in map){const v=s[map[k]];if(v)set(+k,v);}return vc;}
function bindT(unit,name,tex){gl.activeTexture(33984+unit);gl.bindTexture(3553,tex);gl.uniform1i(gl.getUniformLocation(prog,name),unit);}
function windSign(c){const A=[c[0][0],c[1][0],c[2][0]],B=[c[0][1],c[1][1],c[2][1]],
  C=[c[0][2],c[1][2],c[2][2]],D2=[c[0][3],c[1][3],c[2][3]];
  const u=[B[0]-A[0],B[1]-A[1],B[2]-A[2]],v=[D2[0]-A[0],D2[1]-A[1],D2[2]-A[2]];
  const n=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]];
  const cen=[(A[0]+B[0]+C[0]+D2[0])/4,(A[1]+B[1]+C[1]+D2[1])/4,(A[2]+B[2]+C[2]+D2[2])/4];
  return n[0]*cen[0]+n[1]*cen[1]+n[2]*cen[2];}

function draw(){
 if(!gl||!D||!eMesh||got<want)return;
 const W=canvas.width,H=canvas.height;
 gl.viewport(0,0,W,H);gl.clearColor(0,0,0,1);gl.clear(16640);gl.enable(2929);gl.depthFunc(515);
 gl.enable(2884);gl.cullFace(1029);   // back-face cull (per-patch frontFace, degenerate depth)
 gl.useProgram(prog);const U=n=>gl.getUniformLocation(prog,n);
 gl.uniform1f(U('uFlipY'),1.0);
 const fcsrc=curFC||D.fc;  // per-scene captured fragment constants when cycling, else baked
 const fc=new Float32Array(23*4); for(let i=0;i<23;i++){const v=fcsrc[i];fc[i*4]=v[0];fc[i*4+1]=v[1];fc[i*4+2]=v[2];fc[i*4+3]=v[3];}
 gl.uniform4fv(U('fc'),fc);
 bindT(4,'tex4',sharedTex.tex4);bindT(5,'tex5',sharedTex.tex5);bindT(6,'tex6',sharedTex.tex6);
 bindT(7,'tex14',sharedTex.tex14);bindT(8,'tex15',sharedTex.tex15);bindT(9,'tex13',black);
 const pl=gl.getAttribLocation(prog,'in_pos');gl.bindBuffer(34962,eMesh.pb);gl.enableVertexAttribArray(pl);gl.vertexAttribPointer(pl,4,5126,false,0,0);
 gl.bindBuffer(34963,eMesh.ib);
 for(let i=0;i<D.patches.length;i++){const pt=patchTex[i];
   bindT(0,'tex0',pt.t0);bindT(1,'tex1',pt.t1);bindT(2,'tex2',pt.t2);bindT(3,'tex3',pt.t3);
   gl.frontFace(windSign(D.patches[i].corners)<0?2304:2305);
   gl.uniform4fv(U('vc'),buildVC(D.patches[i].corners));gl.drawElements(4,eMesh.n,5123,0);}
 gl.disable(2884);
}

function lookAtMVP(eye,center,up,fovy,asp){
  const fwd=_norm(_sub(center,eye)), right=_norm(_cross(fwd,up)), u=_cross(right,fwd);
  const fy=1/Math.tan(fovy*Math.PI/360);
  return {c260:[(fy/asp)*right[0],(fy/asp)*right[1],(fy/asp)*right[2],-(fy/asp)*_dot(right,eye)],
          c261:[fy*u[0],fy*u[1],fy*u[2],-fy*_dot(u,eye)],
          cw:[fwd[0],fwd[1],fwd[2],-_dot(fwd,eye)], eye:[eye[0],eye[1],eye[2],1]};
}
function interp(kfs,t){ // Catmull-Rom (clamped) -- the firmware's camera-path interpolation (measured)
  if(t<=kfs[0].t)return kfs[0]; const last=kfs[kfs.length-1]; if(t>=last.t)return last;
  for(let i=0;i<kfs.length-1;i++){const a=kfs[i],b=kfs[i+1]; if(t>=a.t&&t<=b.t){
    const w=(t-a.t)/(b.t-a.t), w2=w*w, w3=w2*w;
    const p0=kfs[Math.max(0,i-1)], p1=a, p2=b, p3=kfs[Math.min(kfs.length-1,i+2)];
    const cr=(c0,c1,c2,c3)=>0.5*((2*c1)+(-c0+c2)*w+(2*c0-5*c1+4*c2-c3)*w2+(-c0+3*c1-3*c2+c3)*w3);
    const V=k=>p1[k].map((_,j)=>cr(p0[k][j],p1[k][j],p2[k][j],p3[k][j]));
    return {eye:V('eye'),center:V('center'),up:V('up'),fovy:cr(p0.fovy,p1.fovy,p2.fovy,p3.fovy)};}}
  return last;
}
function pickPreset(i){ // resolve a PRESETS entry to a loaded camera path (fall back across the dict)
  const names=[PRESETS[i], PRESETS[i]+'a', PRESETS[i]+'b'];
  for(const n of names){ if(PATHS[n]&&PATHS[n].kf&&PATHS[n].kf.length){ return PATHS[n]; } }
  return PATHS['preset_7']||Object.values(PATHS)[0];
}
// advance one frame + draw. Called by the music player's own render loop (tick), so we don't run a
// second requestAnimationFrame -- the result canvas is then drawImage()'d onto the 2D music canvas.
// SCENE replay: captured per-frame consts (camera c260-263 + firmware lighting basis c461-467) ->
// exact per-scene camera AND lighting (no clipping). Cycles all captured scenes like the real XMB.
let SCENES=null, sceneIdx=0, SCENES_IDX=null, SCENE_FC=null, curFC=null;
let SCENE_SECS=18;   // wall-seconds per scene before advancing (tunable via MPGlobe.sceneSecs)
function setFC(){ curFC = (SCENE_FC && SCENES_IDX && SCENES_IDX[sceneIdx] && SCENE_FC[String(SCENES_IDX[sceneIdx].scene)]) || null; }
const SCENE_KEYS=['260','261','262','263','264','265','268','269','270','454','455','456','457','458','459','460','461','462','463','464','465','466','467'];
function sceneAt(F,t){
  if(t<=F[0].t)return F[0]; if(t>=F[F.length-1].t)return F[F.length-1];
  for(let i=0;i<F.length-1;i++){const a=F[i],b=F[i+1]; if(t>=a.t&&t<=b.t){const w=(t-a.t)/((b.t-a.t)||1);
    const o={}; for(const k of SCENE_KEYS){const va=a[k],vb=b[k]; o[k]=va&&vb?va.map((x,j)=>x+(vb[j]-x)*w):va;} return o;}}
  return F[F.length-1];
}
function tick(){
  if(!running||!D||!eMesh||got<want) return false;
  if(SCENES&&SCENES.length){            // replay captured scenes (camera + lighting), cycling
    // Each scene plays its captured camera path (t 0..1) over SCENE_SECS wall-seconds, then advances.
    // The real per-scene durations (the un-dumped top-level sequencer) range 80..236s; that is too slow
    // to perceive cycling, so we play each scene over a uniform, visible duration. SCENE_SECS is tunable
    // (MPGlobe.sceneSecs); the WITHIN-scene camera motion is the exact captured path, only its playback
    // speed is normalized.
    const F=SCENES[sceneIdx]; const span=SCENE_SECS*60;
    const s=sceneAt(F,animT); for(const k of SCENE_KEYS){ if(s[k]) D.shared[k]=s[k]; }
    draw();
    animT += 1/span; if(animT>1){ animT=0; sceneIdx=(sceneIdx+1)%SCENES.length; setFC(); }
    return true;
  }
  if(!PATHS||!preset) return false;     // fallback: firmware camera.path (camera only)
  const kfs=preset.kf, tmax=kfs[kfs.length-1].t;
  const cf=interp(kfs,animT), asp=(canvas.width/canvas.height)||(16/9);
  const m=lookAtMVP(cf.eye,cf.center,cf.up,cf.fovy,asp);
  D.shared['260']=m.c260; D.shared['261']=m.c261; D.shared['262']=m.cw; D.shared['263']=m.cw; D.shared['460']=m.eye;
  draw();
  animT += 0.242;
  if(animT>tmax){ animT=0; presetIdx=(presetIdx+1)%PRESETS.length; preset=pickPreset(presetIdx); }
  return true;
}

async function load(){
 D=await fetch(BASE+'full_surface.json').then(r=>r.json());
 black=blackTex();
 sharedTex.tex4=texF32(BASE+'full_tex/t04_f32.bin',256,128);
 sharedTex.tex5=texF32(BASE+'full_tex/t05_f32.bin',256,1);
 sharedTex.tex6=texF32(BASE+'full_tex/t06_f32.bin',64,64);
 sharedTex.tex14=texPNG(BASE+'full_tex/t14.png');
 sharedTex.tex15=texPNG(BASE+'full_tex/t15.png');
 for(let i=0;i<D.patches.length;i++){const d=String(D.patches[i].idx).padStart(3,'0'); patchTex.push({
   t0:texPNG(BASE+'full_tex/p'+d+'_t00.png'),t1:texPNG(BASE+'full_tex/p'+d+'_t01.png'),
   t2:texPNG(BASE+'full_tex/p'+d+'_t02.png'),t3:texPNG(BASE+'full_tex/p'+d+'_t03.png')});}
 const pos=new Float32Array(await fetch(BASE+'mesh/live_surf0_pos.bin').then(r=>r.arrayBuffer()));
 const xyz=[];for(let i=0;i<289;i++)xyz.push(pos[i*4],pos[i*4+1],pos[i*4+2],pos[i*4+3]);
 const idx=[];const N=17;for(let i=0;i<N-1;i++)for(let j=0;j<N-1;j++){const a=i*N+j,b=a+N;idx.push(a,b,a+1,b,b+1,a+1);}
 const pb=gl.createBuffer();gl.bindBuffer(34962,pb);gl.bufferData(34962,new Float32Array(xyz),35044);
 const ib=gl.createBuffer();gl.bindBuffer(34963,ib);gl.bufferData(34963,new Uint16Array(idx),35044);
 eMesh={pb,ib,n:idx.length};
 PATHS=await fetch(BASE+'camera_paths.json').then(r=>r.json());
 presetIdx=7; preset=pickPreset(presetIdx); animT=0;
 // load captured per-scene replays (camera + lighting) -> cycle them; fall back to camera.path if absent
 try{ const idx=(await fetch(BASE+'scenes_index.json').then(r=>r.json())).filter(s=>!s.skip);  // skip scenes without correct per-scene fc; clears once scene_fc.json covers them
   SCENES_IDX=idx;
   SCENES=await Promise.all(idx.map(s=>fetch(BASE+s.file).then(r=>r.json()))); sceneIdx=0; animT=0;
   try{ SCENE_FC=await fetch(BASE+'scene_fc.json').then(r=>r.json()); }catch(e){ SCENE_FC=null; }
   setFC();
 }catch(e){ SCENES=null; }
}

const MPGlobe={
 start(cv){
   running=true;
   if(gl && canvas===cv) return;        // already initialised on this canvas -> just resume
   canvas=cv;
   gl=canvas.getContext('webgl2',{alpha:false,antialias:true,preserveDrawingBuffer:true});
   if(!gl){ console.warn('MPGlobe: WebGL2 unavailable'); return; }
   gl.getExtension('OES_element_index_uint'); gl.getExtension('EXT_color_buffer_float'); gl.getExtension('OES_texture_float_linear');
   prog=gl.createProgram();gl.attachShader(prog,sh(35633,VS));gl.attachShader(prog,sh(35632,FS));gl.linkProgram(prog);
   if(!gl.getProgramParameter(prog,gl.LINK_STATUS)){errlog+=gl.getProgramInfoLog(prog);console.warn('MPGlobe link:',errlog);}
   if(!D) load().catch(e=>console.warn('MPGlobe load:',e));   // fetch assets once
 },
 tick,                                   // music loop calls this each frame, then drawImage(canvas)
 ready(){ return !!(running && D && eMesh && got>=want); },
 stop(){ running=false; },
 set sceneSecs(v){ SCENE_SECS=v; },
 get sceneSecs(){ return SCENE_SECS; },
 _setScene(i){ if(SCENES){ sceneIdx=((i%SCENES.length)+SCENES.length)%SCENES.length; animT=0; setFC(); } },  // diagnostic: force a scene
 get _info(){ return {scene:sceneIdx, nScenes:SCENES?SCENES.length:0, animT:animT.toFixed(3)}; },
 get error(){ return errlog; }
};
global.MPGlobe=MPGlobe;
})(window);
