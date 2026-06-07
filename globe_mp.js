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

let gl=null, canvas=null, prog=null, aprog=null, raf=0, running=false;
let cprog=null;                 // GLOW composite fullscreen program
let hdrExt=null;                // EXT_color_buffer_float (RGBA16F FBO) - required for the GLOW path; null = fall back to forward
let hdrFBO=null, glowVAO=null;  // lazy HDR scene FBO + composite VAO
let GLOW=1;                     // GLOW path flag (MPGlobe.glow) -- DEFAULT ON: the verbatim golden composite (EXT-guarded; falls back to forward if no RGBA16F FBO). ~20ms/frame w/ sync = real-time.
let _lastGlow=null;             // diagnostic handle to last buildGlow result
// ---- GLOW composite calibration (BLUE per-channel earth term) ---------------------------------
// REWRITTEN 2026-06-07: the composite is now additive-bloom-in-linear-HDR then the firmware HDR.mnu
// extended-Reinhard tonemap applied PER CHANNEL (preserves the blue earth albedo; measured real
// present lit-side B/G=1.11). The previous luminance+warm golden composite was wrong (see
// project_globe_ground_truth_2026-06-07). GLOW_SLUM = the firmware HDR.mnu EXPOSURE (0.789, same as
// the ENC0 surface path that measured B/G=1.10 == the real present). GLOW_GAIN = additive bloom
// strength (neutral; the sun glint/limb halo). Both verified via /tmp/render_compare.py vs the present.
let GLOW_GAIN=[0.02,0.02,0.02];  // subtle additive sun-glint/limb halo (measured: keeps the disk sharp, not hazy)
let GLOW_WARM=[1.0,1.0,1.0];   // retained for the MPGlobe.glowWarm setter API; no longer used by C_FS
// Exposure into the per-channel Reinhard. The real HDR.mnu EXPOSURE is 0.789, but the r2 HDR scene
// magnitude is ~2x (the DRAW18 HDR decode is still slightly off), so 0.789 overexposes (139k blown vs
// the present's 13.5k). 0.42 matches the present's blown count + lit-body brightness. FLAGGED: exposure
// is a calibration pending the r2 decode; the COLOR is faithful (real .mnu per-channel Reinhard, B/G=1.10).
let GLOW_SLUM=0.42;
let GLOW_CHROMA=0;             // retained for the MPGlobe.glowChroma setter API; no longer used by C_FS
let D=null, eMesh=null, want=0, got=0, sharedTex={}, patchTex=[], black=null;
let aMesh=null, scatterTex=null, fcAtmo=null;        // verbatim atmosphere shell pass
let ATMO_SCENES=null, ATMO_SCENE=null, ATMO=0;       // per-scene aligned atmosphere (coherent capture); MPGlobe.atmo toggles
const ATMO_KEYS=['256','257','258','259','460','461','462'];
let PATHS=null, animT=0, preset=null, presetIdx=7, errlog='';
let starProg=null, starBuf=null, starN=0;   // celestial star field (triangulated from real presents)
let STARS_ON=1;                              // MPGlobe.stars
let TILES=1;                                 // 1 = faithful per-patch tile sampling (firmware 24-patch x 4-tile); 0 = legacy cube map (MPGlobe.tiles)
// Patches whose extracted t02 DETAIL tile is corrupt (garbage grid, source dump xmb_dump3 was cleaned).
// For these, the cloud detail is sampled from the real clouds cube instead (clean cloud data, same source);
// albedo (t00/t01) is the clean per-patch tile. TODO: re-capture these 4 t02 tiles from live RPCS3.
const BADT2 = new Set([4,5,18,22]);
let STAR_BRI=4.0;                            // star HDR brightness into the scene (calibrated through the GLOW tonemap so stars read faint, like the present; MPGlobe.starBri)

const _sub=(a,b)=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]];
const _cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const _norm=(a)=>{const l=Math.hypot(a[0],a[1],a[2])||1;return[a[0]/l,a[1]/l,a[2]/l];};
const _dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];

const VS=`#version 300 es
precision highp float;
in vec4 in_pos; uniform vec4 vc[26]; uniform float uFlipY;
out vec4 tc0,tc3,tc4,tc5,tc6,tc8,tc9; out vec3 vN; out vec3 vL; out vec3 vSph;
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
  vSph = r2.xyz;                            // FINAL object-space unit sphere dir (matches rendered geometry) -> cube-map
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
in vec4 tc0,tc3,tc4,tc5,tc6,tc8,tc9; in vec3 vN; in vec3 vL; in vec3 vSph;
uniform sampler2D tex0,tex1,tex2,tex3,tex4,tex5,tex6,tex13,tex14,tex15;   // tex0-3 = THIS patch's 4 firmware tiles (t00-t03)
uniform samplerCube earthCube, cloudsCube, maskCube;   // legacy cube-map path (kept for DBG/fallback)
uniform vec4 fc[23];
uniform float uDbg, uMode, uSlum, uTiles, uT2bad;   // uTiles=1 -> per-patch tiles; uT2bad=1 -> this patch's t02 detail tile is corrupt, sample cloud from the cube instead
out vec4 ocol0;
vec3 nrm(vec3 v){return length(v)>0.0?normalize(v):v;}
vec3 fma3(vec3 a,vec3 b,vec3 c){return a*b+c;}
vec2 fma2(vec2 a,vec2 b,vec2 c){return a*b+c;}
float fma1(float a,float b,float c){return a*b+c;}
vec3 pc3(vec3 x,float a,float b){return clamp(x,a,b);}
void main(){
  vec4 tc1=vec4(vL,1.0), tc7=vec4(vN,1.0);
  vec3 sd = normalize(vSph);   // seamless cube-map sample direction (replaces per-patch tile UVs)
  vec4 r0=vec4(0.),r1=vec4(0.),r2=vec4(0.),r3=vec4(0.),r4=vec4(0.);
  vec4 h0=vec4(0.),h1=vec4(0.),h2=vec4(0.),h3=vec4(0.),h4=vec4(0.),h5=vec4(0.),h6=vec4(0.),h7=vec4(0.);
  r2.xyz = uTiles>0.5 ? texture(tex0, tc0.xy).xyz : texture(earthCube, sd).xyz;   // fp: TEX2D(0, tc0.xy)
  h2.xyz = nrm(tc7.xyz);
  r3.xyz = uTiles>0.5 ? texture(tex1, tc0.zw).xyz : texture(earthCube, sd).xyz;   // fp: TEX2D(1, tc0.zw)
  r3.xyz = (r3.xyz + -r2.xyz);
  r4.xyz = fma3(tc4.xxx, r3.xyz, r2.xyz);
  h0.xyz = nrm(tc1.xyz);
  h3.z = (dot(h2.xyz,h0.xyz)/2.0);
  r0.z = (dot(-h2.xyz,h0.xyz)*2.0);
  r1.w = (h3.z + fc[0].x);
  r0.xyz = fma3(-h0.xyz, r0.zzz, -h2.xyz);
  h1.zw = tc8.zw;
  r3.xyz = (-r4.xyz + fc[1].xyz);
  r2.x = ((uTiles>0.5 && uT2bad<0.5) ? texture(tex2, tc8.zw).x : texture(cloudsCube, sd).x);   // fp: TEX2D(2, tc8.zw)
  h7.w = fma1(r2.x, fc[2].x, fc[2].y);
  r2.x = (uTiles>0.5 ? texture(tex3, tc8.xy).x : texture(maskCube, sd).x);     // fp: TEX2D(3, tc8.xy)
  r1.xyz = fma3(r2.xxx, r3.xyz, r4.xyz);
  r4.zw = tc9.xy;
  r4.y = fc[3].y;
  h5.xyz = (r1.xyz * fc[4].x);
  r3.xy = tc6.xy;
  r4.x = fc[5].y;
  r1.xy = fma2(r3.xy, h7.ww, h1.zw);
  r1.xyz = ((uTiles>0.5 && uT2bad<0.5) ? texture(tex2, r1.xy).xyz : texture(cloudsCube, sd).xyz);   // fp: TEX2D(2, r1.xy)
  h7.xyz = (r1.xyz * fc[6].z);
  h7.w = r2.x;
  h6.xyz = (-h5.xyz + fc[7].w);
  h5.xyz = fma3(h7.xyz, h6.xyz, h5.xyz);
  h7.z = dot(r0.xyz, fc[8].xyz);
  r0.xy = fma2(r4.zw, fc[9].xx, h1.zw);
  r0.xyz = ((uTiles>0.5 && uT2bad<0.5) ? texture(tex2, r0.xy).xyz : texture(cloudsCube, sd).xyz);   // fp: TEX2D(2, r0.xy)
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
  // VERBATIM ramp encode = the firmware surface fp's actual output (its HDR tonemap LUT, tex14/tex15;
  // the UV clamp on r2 rolls off highlights -> bright close scenes stay dark, not blown white).
  float maxlum = max(r2.x, r2.y);
  vec4 r0d = texture(tex13, gl_FragCoord.xy/32.0);   // backbuffer/dither (black -> 0)
  vec2 e15 = texture(tex15, r2.xy).xy;
  vec2 e14 = texture(tex14, vec2(r2.z, maxlum)).zw;
  vec4 col0 = vec4(0.);
  col0.xy = fma2(r0d.xy, fc[21].xx, e15);
  col0.zw = fma2(r0d.zw, fc[22].xx, e14);
  if(uDbg>2.5){ ocol0=vec4(sd*0.5+0.5,1.0); return; }          // sd direction as color (should be smooth)
  if(uDbg>1.5){ ocol0=vec4(texture(cloudsCube,sd).xyz,1.0); return; }
  if(uDbg>0.5){ float d=clamp(dot(normalize(vN),normalize(vL))*0.8+0.4,0.0,1.0); ocol0=vec4(texture(earthCube,sd).xyz*d,1.0); return; }
  if(uMode>4.5){
    // GLOW path: emit the LINEAR HDR earth scene (the var r2.xyz, after *8.0) so the
    // bloom pyramid + composite curve run on real HDR. No tonemap here -- the composite
    // applies the same firmware CURVE (tex15) that ENC=3 uses. r2 is the colored HDR scene.
    ocol0 = vec4(r2.xyz, 1.0); return;
  }
  if(uMode>2.5){
    // VALIDATED firmware composite (agent MSE 0.0023 vs real present): per-channel real LUT tonemap CURVE
    // applied to the colored HDR earth r2. curve(uv) = real LUT15 row0 .y (separable exposure curve, ~7.86*uv).
    // uSlum calibrates r2 (colored HDR, x8) into the curve domain (= the firmware k*alpha encode scale).
    // firmware warm per-channel bias (agent's measured k ratio R>G>B = the golden lit-side cast)
    vec3 hc = r2.xyz * uSlum * vec3(1.0, 0.90, 0.85);
    vec3 disp = vec3(
      texture(tex15, vec2(clamp(hc.x,0.0,0.99),0.004)).y,
      texture(tex15, vec2(clamp(hc.y,0.0,0.99),0.004)).y,
      texture(tex15, vec2(clamp(hc.z,0.0,0.99),0.004)).y);
    ocol0 = vec4(clamp(disp,0.0,1.0),1.0); return;
  }
  if(uMode>1.5){ ocol0 = vec4(clamp(log2(max(r2.xyz,0.0)+1.0)/6.0,0.0,1.0), 1.0); return; }  // raw HDR r2 (log-encoded for readback): r2=2^(v*6)-1
  if(uMode>0.5){ ocol0 = vec4(col0.xyz, 1.0); return; }         // verbatim ramp-encoded output
  ocol0 = vec4(clamp(tc,0.0,1.0), 1.0);
}`;
// ---- VERBATIM ATMOSPHERE SHELL (vp 3f6eeb47 + fp 63d3246d), ported 1:1 from globe_atmo_real.html ----
const A_VS=`#version 300 es
precision highp float;
in vec4 in_pos; in vec4 in_tc0;
uniform vec4 mvp0,mvp1,mvp2,mvp3; uniform float uFlipY; uniform vec3 c5,c6,c7,c8;
out vec2 vTC;
void main(){
 float A=1.0/sqrt(max(dot(c8,c8),1e-10));float w=in_pos.w;float B=sqrt(max((1.0/A)*(1.0/A)-w*w,1e-10));
 float s=A*w*w,t=A*B*w; vec3 r0=s*c5+t*(in_tc0.z*c7+in_tc0.w*c6); vTC=in_tc0.xy;
 vec4 p=vec4(r0,1.0); vec4 clip=vec4(dot(p,mvp0),dot(p,mvp1),dot(p,mvp2),dot(p,mvp3));
 vec2 ndc=clip.xy/clip.w; vec2 win=ndc*vec2(960.0,-540.0)+vec2(960.0,540.0);
 clip.xy=((win/vec2(960.0,540.0))-1.0)*clip.w; clip.z=0.0; clip.y*=uFlipY; gl_Position=clip;
}`;
const A_FS=`#version 300 es
precision highp float;
in vec2 vTC; out vec4 ocol0; uniform sampler2D tex0; uniform vec4 fc[17]; uniform float uLinear;
float pc(float x,float a,float b){return (x!=x)?0.:clamp(x,a,b);} float fma1(float a,float b,float c){return a*b+c;}
void main(){
 vec4 tc0=vec4(vTC,0.,1.);vec4 r0=vec4(0.),r1=vec4(0.),r2=vec4(0.),r3=vec4(0.);
 r1.x=fc[0].x;r1.z=fc[0].z;r1.y=1.0/fc[1].z;r0.x=fc[2].w;r0.y=fc[2].z;r0.w=(-r0.y+fc[3].x);r1.xyz=tc0.xyz*r1.xyz;
 r3.y=pc(r0.w/-fc[4].z,0.,1.);r0.w=fc[5].w;r3.x=(-r0.w+fc[6].x);r3.w=r3.y*r3.y;r2.w=r3.y*2.;
 r2.y=pc(fc[7].x/r0.x,0.,1.);r2.x=r2.y*r2.y;r1.w=r2.y*2.;r0.xyz=texture(tex0,r1.xy).xyz;
 r1.x=(-r1.x*fc[8].x);r1.z=(r1.y+-fc[9].w);r3.x=pc(r1.z/r3.x,0.,1.);r3.z=(-r1.w+fc[10].x);r3.y=r2.x*r3.z;r0.w=r1.x*fc[11].x;
 r1.x=pc(r1.y/fc[12].y,0.,1.);r1.w=(-r2.x+fc[13].x);r2.x=fma1(r3.w,r1.w,-r3.y);r1.w=r1.x*2.;r1.w=(-r1.w+fc[14].x);r1.x=r1.x*r1.x;r1.x=r1.x*r1.w;
 r1.w=r3.x*2.;r1.w=(-r1.w+fc[15].x);r1.y=r3.x*r3.x;r1.y=r1.y*r1.w;r0.w=exp2(r0.w);r0.w=r2.x*r0.w;
 r0.xyz=r0.xyz*fc[16].x;r0.xyz=(-r1.y*r0.xyz+r0.xyz);r0.w=(-r1.x*r0.w+r0.w);r0.xyz=((r0.w*r0.xyz+r0.xyz)*8.0);
 if(uLinear>0.5){ ocol0=vec4(r0.xyz,1.0); return; }   // GLOW path: emit linear HDR atmo so it feeds the bloom
 vec3 tcol=r0.xyz*0.789; float Wl=3.40918; tcol=(tcol*(1.0+tcol/(Wl*Wl)))/(1.0+tcol);
 ocol0=vec4(clamp(tcol,0.0,1.0),1.0);
}`;

// ---- GLOW COMPOSITE (fullscreen) : combines linear-HDR earth + bloom glow, then the
//      VERBATIM firmware CURVE (tex15 fp16 LUT, same as ENC=3). VALIDATED composite model
//      (MSE 0.0023 vs the real present 822869): the firmware encodes the earth surface to a
//      single LUMINANCE intensity; the golden lit-side colour is produced ENTIRELY by the warm
//      per-channel k applied to that luminance, NOT by the (blue ocean) albedo. So:
//        LUM       = dot(earthHDR.xyz, vec3(0.27,0.67,0.06))     // firmware luminance weights
//        base      = mix(LUM, earthHDR.c, uChroma)               // lead with luminance; small chroma optional
//        display_c = CURVE( base*uSlum*warmbias_c + glow_c*uGlowGain_c )
//      warmbias = the golden R>G>B lit-side cast [1,0.90,0.85]. CURVE(uv)=texture(tex15,vec2(uv,0.004)).y.
//      uChroma=0 -> dominantly golden lit side (matches the present); a SMALL value (~0.15) adds back
//      the present's subtle ocean tint without going blue.
const C_VS=`#version 300 es
out vec2 vUV;
void main(){ vec2 p=vec2((gl_VertexID<<1)&2, gl_VertexID&2); vUV=p; gl_Position=vec4(p*2.0-1.0,0.0,1.0); }`;
const C_FS=`#version 300 es
precision highp float; precision highp sampler2D;
uniform sampler2D uEarth;   // linear-HDR earth+atmo scene (FS r2.xyz, blue)
uniform sampler2D uGlow;    // bloom pyramid result from GlobeGlow.buildGlow
uniform float uSlum;        // exposure into the tonemap (firmware HDR.mnu EXPOSURE 0.789)
uniform vec3  uGlowGain;    // per-channel additive bloom gain (sun glint / limb halo)
in vec2 vUV; out vec4 ocol0;
void main(){
  vec3 e = texture(uEarth, vUV).xyz;
  vec3 g = texture(uGlow,  vUV).xyz;
  // Additive bloom in LINEAR HDR, then the firmware globe HDR.mnu tonemap applied PER CHANNEL
  // (extended Reinhard, EXPOSURE 0.789, WHITE 3.40918 -- the same real .mnu params as the surface fp's
  // ENC0 path). Per-channel => the BLUE earth albedo is PRESERVED (measured real present lit-side
  // B/G=1.11). This replaces the wrong golden-luminance composite (which collapsed e to a single
  // intensity and re-cast it warm R>G>B -- not what the firmware does; see project_globe_ground_truth).
  vec3 hc = (e + g * uGlowGain) * uSlum;
  float W = 3.40918;
  vec3 toned = (hc*(1.0 + hc/(W*W)))/(1.0 + hc);
  ocol0 = vec4(clamp(toned,0.0,1.0), 1.0);
}`;

// ---- STAR FIELD (real-derived) : 1122 stars triangulated from the camera-sweep presents (back-projected
//      through each frame's captured VP). Rendered at infinity via the SAME RSX viewport remap as the
//      earth, at far depth so the earth/atmo occlude them. FLAGGED: positions carry ~sub-degree
//      uncertainty because the PRESENT and VPCONSTANTS captures are not frame-locked (see
//      project_globe_ground_truth_2026-06-07); they are REAL stars (not procedural), with that caveat.
const STAR_VS=`#version 300 es
in vec4 inStar;                              // xyz = celestial direction (unit), w = brightness 18..117
uniform vec4 c260,c261,c262,c263; uniform float uFlipY; uniform float uBri;
out float vI;
void main(){
  vec3 d=normalize(inStar.xyz);
  // star at infinity: clip = VP_3x3 * d (camera translation negligible at infinity)
  vec4 clip=vec4(dot(c260.xyz,d), dot(c261.xyz,d), dot(c262.xyz,d), dot(c263.xyz,d));
  if(clip.w<=0.0){ gl_Position=vec4(2.0,2.0,2.0,1.0); return; }   // behind camera -> cull offscreen
  vec2 ndc=clip.xy/clip.w; vec2 win=ndc*vec2(960.0,-540.0)+vec2(960.0,540.0);
  clip.xy=((win/vec2(960.0,540.0))-1.0)*clip.w;
  clip.z=clip.w*0.99995;                     // far depth: earth (nearer) occludes
  clip.y*=uFlipY; gl_Position=clip;
  gl_PointSize=1.5;
  vI=clamp((inStar.w-10.0)/110.0,0.0,1.0)*uBri;
}`;
const STAR_FS=`#version 300 es
precision highp float; in float vI; out vec4 ocol0;
void main(){
  vec2 q=gl_PointCoord-0.5; float f=clamp(1.0-length(q)*2.0,0.0,1.0);
  ocol0=vec4(vec3(vI)*f, 1.0);               // faint white star; slight blue handled by space ambient
}`;
function sh(t,s){const o=gl.createShader(t);gl.shaderSource(o,s);gl.compileShader(o);if(!gl.getShaderParameter(o,gl.COMPILE_STATUS))errlog+=gl.getShaderInfoLog(o);return o;}
function texPNG(src){const t=gl.createTexture();gl.bindTexture(3553,t);gl.texImage2D(3553,0,6408,1,1,0,6408,5121,new Uint8Array([0,0,0,255]));want++;
 const im=new Image();im.onload=function(){if(!gl)return;gl.bindTexture(3553,t);gl.texImage2D(3553,0,6408,6408,5121,im);gl.texParameteri(3553,10241,9729);gl.texParameteri(3553,10240,9729);gl.texParameteri(3553,10242,33071);gl.texParameteri(3553,10243,33071);got++;};im.src=src;return t;}
function texF32(src,w,h){const t=gl.createTexture();gl.bindTexture(3553,t);gl.texImage2D(3553,0,34836,1,1,0,6408,5126,new Float32Array([0,0,0,1]));want++;
 fetch(src).then(r=>r.arrayBuffer()).then(ab=>{if(!gl)return;gl.bindTexture(3553,t);gl.texImage2D(3553,0,34836,w,h,0,6408,5126,new Float32Array(ab));gl.texParameteri(3553,10241,9729);gl.texParameteri(3553,10240,9729);gl.texParameteri(3553,10242,33071);gl.texParameteri(3553,10243,33071);got++;});return t;}
// fp16 float texture (RGBA16F internalformat=34842, filterable in WebGL2) for the real HDR tonemap LUTs
function texF16(src,w,h){const t=gl.createTexture();gl.bindTexture(3553,t);gl.texImage2D(3553,0,34842,1,1,0,6408,5126,new Float32Array([0,0,0,1]));want++;
 fetch(src).then(r=>r.arrayBuffer()).then(ab=>{if(!gl)return;gl.bindTexture(3553,t);gl.texImage2D(3553,0,34842,w,h,0,6408,5126,new Float32Array(ab));gl.texParameteri(3553,10241,9729);gl.texParameteri(3553,10240,9729);gl.texParameteri(3553,10242,33071);gl.texParameteri(3553,10243,33071);got++;});return t;}
function blackTex(){const t=gl.createTexture();gl.bindTexture(3553,t);gl.texImage2D(3553,0,6408,1,1,0,6408,5121,new Uint8Array([0,0,0,255]));return t;}
// Build a WebGL cube-map from the firmware's 6 assembled cube faces (earth.qrc CUBEEARTH/clouds/mask).
// Calibrated arrangement (slots/flip) verified vs geography: continents seamless, poles centered.
const CUBE_SLOTS=[1,3,5,4,0,2];               // earth_faceN for WebGL [+X,-X,+Y,-Y,+Z,-Z]
const CUBE_FACE_ENUM=[34069,34070,34071,34072,34073,34074];
function cubeTex(prefix){const t=gl.createTexture();gl.bindTexture(34067,t);
 for(let s=0;s<6;s++){gl.texImage2D(CUBE_FACE_ENUM[s],0,6408,1,1,0,6408,5121,new Uint8Array([0,0,0,255]));}
 want+=6; let nface=0;
 for(let s=0;s<6;s++){const im=new Image();im.onload=(function(s,im){return function(){if(!gl)return;
   const cv=document.createElement('canvas');cv.width=im.width;cv.height=im.height;const cx=cv.getContext('2d');
   cx.translate(im.width,0);cx.scale(-1,1);cx.drawImage(im,0,0);            // horizontal flip (WebGL cube handedness)
   gl.bindTexture(34067,t);gl.texImage2D(CUBE_FACE_ENUM[s],0,6408,6408,5121,cv);
   got++; nface++;
   if(nface===6){ gl.bindTexture(34067,t); gl.generateMipmap(34067);       // mipmaps kill the high-freq cloud moire
     gl.texParameteri(34067,10241,9987);   // MIN_FILTER = LINEAR_MIPMAP_LINEAR (trilinear)
     gl.texParameteri(34067,10240,9729);gl.texParameteri(34067,10242,33071);gl.texParameteri(34067,10243,33071);gl.texParameteri(34067,32882,33071);
   }};})(s,im); im.src=BASE+prefix+'_face'+CUBE_SLOTS[s]+'.png';}
 return t;}

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

// Lazy RGBA16F HDR scene FBO (color tex + depth renderbuffer), recreated on resize.
function ensureHDR(W,H){
 if(hdrFBO && hdrFBO.w===W && hdrFBO.h===H) return hdrFBO;
 if(hdrFBO){ gl.deleteFramebuffer(hdrFBO.fbo); gl.deleteTexture(hdrFBO.tex); gl.deleteRenderbuffer(hdrFBO.depth); }
 const tex=gl.createTexture(); gl.bindTexture(3553,tex);
 gl.texImage2D(3553,0,gl.RGBA16F,W,H,0,6408,gl.HALF_FLOAT,null);
 gl.texParameteri(3553,10241,9729);gl.texParameteri(3553,10240,9729);
 gl.texParameteri(3553,10242,33071);gl.texParameteri(3553,10243,33071);
 const depth=gl.createRenderbuffer(); gl.bindRenderbuffer(36161,depth);
 gl.renderbufferStorage(36161,gl.DEPTH_COMPONENT16,W,H);
 const fbo=gl.createFramebuffer(); gl.bindFramebuffer(36160,fbo);
 gl.framebufferTexture2D(36160,36064,3553,tex,0);
 gl.framebufferRenderbuffer(36160,36096,36161,depth);
 const st=gl.checkFramebufferStatus(36160);
 if(st!==36053) errlog+=' HDR FBO incomplete 0x'+st.toString(16);
 gl.bindFramebuffer(36160,null);
 hdrFBO={fbo,tex,depth,w:W,h:H}; return hdrFBO;
}

// star field pass: render the real-derived celestial points at far depth, into whatever framebuffer is
// bound (HDR FBO for the GLOW path, canvas for the forward path). Depth write on so the earth occludes.
function drawStars(){
 if(!STARS_ON||!starProg||!starBuf||!starN||!D) return;
 const s=D.shared; if(!s['260']||!s['263']) return;
 gl.useProgram(starProg); const U=n=>gl.getUniformLocation(starProg,n);
 gl.uniform4fv(U('c260'),s['260']);gl.uniform4fv(U('c261'),s['261']||s['260']);
 gl.uniform4fv(U('c262'),s['262']||s['263']);gl.uniform4fv(U('c263'),s['263']);
 gl.uniform1f(U('uFlipY'),1.0); gl.uniform1f(U('uBri'),STAR_BRI);
 const pl=gl.getAttribLocation(starProg,'inStar');
 gl.bindBuffer(34962,starBuf);gl.enableVertexAttribArray(pl);gl.vertexAttribPointer(pl,4,5126,false,0,0);
 gl.disable(2884); gl.enable(2929); gl.depthFunc(515); gl.depthMask(true); gl.disable(3042);
 gl.drawArrays(0,0,starN);   // 0 = POINTS
}
// GLOW render path: earth+atmo -> linear-HDR FBO -> buildGlow -> composite CURVE((earthHDR+glow*g)*slum*warmbias) -> canvas.
function drawGlow(){
 const W=canvas.width,H=canvas.height;
 const F=ensureHDR(W,H);
 // 1) render earth patches + atmo into the HDR FBO with the LINEAR-HDR output mode (uMode=5 / uLinear=1).
 gl.bindFramebuffer(36160,F.fbo);
 gl.viewport(0,0,W,H);gl.clearColor(0,0,0,0);gl.clear(16640);gl.enable(2929);gl.depthFunc(515);
 drawStars();                            // stars into the HDR scene (tonemapped + may bloom faintly)
 gl.enable(2884);gl.cullFace(1029);
 gl.useProgram(prog);const U=n=>gl.getUniformLocation(prog,n);
 gl.uniform1f(U('uFlipY'),1.0);
 gl.uniform1f(U('uDbg'),0.0);
 gl.uniform1f(U('uMode'),5.0);          // linear HDR earth scene (r2.xyz)
 gl.uniform1f(U('uSlum'),SLUM);
 const fcsrc=curFC||D.fc;
 const fc=new Float32Array(23*4); for(let i=0;i<23;i++){const v=fcsrc[i];fc[i*4]=v[0];fc[i*4+1]=v[1];fc[i*4+2]=v[2];fc[i*4+3]=v[3];}
 gl.uniform4fv(U('fc'),fc);
 bindT(4,'tex4',sharedTex.tex4);bindT(5,'tex5',sharedTex.tex5);bindT(6,'tex6',sharedTex.tex6);
 bindT(7,'tex14',sharedTex.tex14);bindT(8,'tex15',sharedTex.tex15);bindT(9,'tex13',black);
 gl.uniform1f(U('uTiles'),TILES);
 const bindCube=(unit,name,tex)=>{gl.activeTexture(33984+unit);gl.bindTexture(34067,tex);gl.uniform1i(U(name),unit);};
 bindCube(10,'earthCube',sharedTex.earthCube);bindCube(11,'cloudsCube',sharedTex.cloudsCube);bindCube(12,'maskCube',sharedTex.maskCube);
 const pl=gl.getAttribLocation(prog,'in_pos');gl.bindBuffer(34962,eMesh.pb);gl.enableVertexAttribArray(pl);gl.vertexAttribPointer(pl,4,5126,false,0,0);
 gl.bindBuffer(34963,eMesh.ib);
 if(!ATMO_ONLY) for(let i=0;i<D.patches.length;i++){
   gl.frontFace(windSign(D.patches[i].corners)<0?2304:2305);
   const pt=patchTex[D.patches[i].idx];
   if(pt){ bindT(0,'tex0',pt[0]);bindT(1,'tex1',pt[1]);bindT(2,'tex2',pt[2]);bindT(3,'tex3',pt[3]); }
   gl.uniform1f(U('uT2bad'), BADT2.has(D.patches[i].idx)?1.0:0.0);
   gl.uniform4fv(U('vc'),buildVC(D.patches[i].corners));gl.drawElements(4,eMesh.n,5123,0);}
 gl.disable(2884);
 // 1b) atmosphere limb additively INTO the HDR FBO (linear HDR), so it both feeds the bloom and gets
 //     tonemapped together with the earth -- the faithful pipeline. The per-channel composite no longer
 //     warm-biases, so the limb's Rayleigh blue survives (no need for the old separate canvas pass).
 if((ATMO||ATMO_ONLY)&&aMesh&&scatterTex) drawAtmoLinear();
 // 2) build the bloom glow from the linear-HDR scene (GlobeGlow uses this same gl context).
 gl.bindFramebuffer(36160,null);
 const glow=GlobeGlow.buildGlow(gl, F.tex, W, H);
 _lastGlow=glow;
 // 3) composite earthHDR + glow through the firmware CURVE onto the canvas.
 gl.bindFramebuffer(36160,null);
 gl.viewport(0,0,W,H);gl.disable(2929);gl.disable(3042);gl.disable(2884);
 gl.useProgram(cprog);const C=n=>gl.getUniformLocation(cprog,n);
 gl.activeTexture(33984+0);gl.bindTexture(3553,F.tex);gl.uniform1i(C('uEarth'),0);
 gl.activeTexture(33984+1);gl.bindTexture(3553,glow.tex);gl.uniform1i(C('uGlow'),1);
 gl.uniform1f(C('uSlum'),GLOW_SLUM);     // exposure into the per-channel HDR.mnu tonemap (firmware EXPOSURE 0.789)
 gl.uniform3fv(C('uGlowGain'),new Float32Array(GLOW_GAIN));
 gl.bindVertexArray(glowVAO);
 gl.drawArrays(4,0,3);
 gl.bindVertexArray(null);
 // (atmosphere is now rendered additively into the HDR FBO above, step 1b, so it blooms + tonemaps
 //  with the earth and keeps its blue -- no separate post pass needed.)
}
// atmosphere shell with LINEAR-HDR output (uLinear=1), additive into the HDR FBO so it feeds the bloom.
function drawAtmoLinear(){
 if(!aMesh||!scatterTex||got<want)return; const s=D.shared; if(!s['460']||!s['461']||!s['462'])return;
 const a=(ATMO_SCENE?atmoAt(animT):null)||{};
 const e460=a['460']||s['460'], e461=a['461']||s['461'], e462=a['462']||s['462'];
 const c5=e461.slice(0,3), c7=e462.slice(0,3), c6=_cross(c5,c7), c8=e460.slice(0,3);
 const m0=a['256']||s['256']||s['260'],m1=a['257']||s['257']||s['261'],m2=a['258']||s['258']||s['262'],m3=a['259']||s['259']||s['263'];
 if(!m0||!m1||!m2||!m3)return;
 gl.useProgram(aprog); const U=n=>gl.getUniformLocation(aprog,n);
 gl.uniform4fv(U('mvp0'),m0);gl.uniform4fv(U('mvp1'),m1);gl.uniform4fv(U('mvp2'),m2);gl.uniform4fv(U('mvp3'),m3);
 gl.uniform1f(U('uFlipY'),1.0);
 gl.uniform1f(U('uLinear'),1.0);
 gl.uniform3fv(U('c5'),c5);gl.uniform3fv(U('c6'),c6);gl.uniform3fv(U('c7'),c7);gl.uniform3fv(U('c8'),c8);
 gl.uniform4fv(U('fc'),fcAtmo);
 gl.activeTexture(33984);gl.bindTexture(3553,scatterTex);gl.uniform1i(U('tex0'),0);
 gl.disable(2884); gl.depthMask(false); gl.enable(3042); gl.blendFunc(1,1);
 let pl=gl.getAttribLocation(aprog,'in_pos');gl.bindBuffer(34962,aMesh.pbuf);gl.enableVertexAttribArray(pl);gl.vertexAttribPointer(pl,4,5126,false,0,0);
 let tl=gl.getAttribLocation(aprog,'in_tc0');gl.bindBuffer(34962,aMesh.tbuf);gl.enableVertexAttribArray(tl);gl.vertexAttribPointer(tl,4,5126,false,0,0);
 gl.bindBuffer(34963,aMesh.ibuf);gl.drawElements(5,aMesh.n,5125,0);
 gl.disable(3042); gl.depthMask(true);
}

function draw(){
 if(!gl||!D||!eMesh||got<want)return;
 if(GLOW && hdrExt && cprog && glowVAO && typeof GlobeGlow!=='undefined'){ drawGlow(); return; }   // gated new path (needs RGBA16F FBO)
 const W=canvas.width,H=canvas.height;
 gl.viewport(0,0,W,H);gl.clearColor(0,0,0,1);gl.clear(16640);gl.enable(2929);gl.depthFunc(515);
 drawStars();                          // real-derived celestial star field, behind the earth
 gl.enable(2884);gl.cullFace(1029);   // back-face cull (per-patch frontFace, degenerate depth)
 gl.useProgram(prog);const U=n=>gl.getUniformLocation(prog,n);
 gl.uniform1f(U('uFlipY'),1.0);
 gl.uniform1f(U('uDbg'),DBG);
 gl.uniform1f(U('uMode'),ENC);
 gl.uniform1f(U('uSlum'),SLUM);
 const fcsrc=curFC||D.fc;  // per-scene captured fragment constants when cycling, else baked
 const fc=new Float32Array(23*4); for(let i=0;i<23;i++){const v=fcsrc[i];fc[i*4]=v[0];fc[i*4+1]=v[1];fc[i*4+2]=v[2];fc[i*4+3]=v[3];}
 gl.uniform4fv(U('fc'),fc);
 bindT(4,'tex4',sharedTex.tex4);bindT(5,'tex5',sharedTex.tex5);bindT(6,'tex6',sharedTex.tex6);
 bindT(7,'tex14',sharedTex.tex14);bindT(8,'tex15',sharedTex.tex15);bindT(9,'tex13',black);
 gl.uniform1f(U('uTiles'),TILES);
 const bindCube=(unit,name,tex)=>{gl.activeTexture(33984+unit);gl.bindTexture(34067,tex);gl.uniform1i(U(name),unit);};
 bindCube(10,'earthCube',sharedTex.earthCube);bindCube(11,'cloudsCube',sharedTex.cloudsCube);bindCube(12,'maskCube',sharedTex.maskCube);
 const pl=gl.getAttribLocation(prog,'in_pos');gl.bindBuffer(34962,eMesh.pb);gl.enableVertexAttribArray(pl);gl.vertexAttribPointer(pl,4,5126,false,0,0);
 gl.bindBuffer(34963,eMesh.ib);
 if(!ATMO_ONLY) for(let i=0;i<D.patches.length;i++){
   gl.frontFace(windSign(D.patches[i].corners)<0?2304:2305);
   const pt=patchTex[D.patches[i].idx];
   if(pt){ bindT(0,'tex0',pt[0]);bindT(1,'tex1',pt[1]);bindT(2,'tex2',pt[2]);bindT(3,'tex3',pt[3]); }
   gl.uniform1f(U('uT2bad'), BADT2.has(D.patches[i].idx)?1.0:0.0);
   gl.uniform4fv(U('vc'),buildVC(D.patches[i].corners));gl.drawElements(4,eMesh.n,5123,0);}
 gl.disable(2884);
 if((ATMO||ATMO_ONLY)&&aMesh&&scatterTex)drawAtmo();
}
// VERBATIM atmosphere limb shell (type-B 3f6eeb47 draw): basis c5=c461,c7=c462,c6=cross(c5,c7),c8=eye=c460;
// type-B MVP c256-259 + eye/basis replayed per-frame from the coherent capture (atmoAt). Additive over surface.
function drawAtmo(){
 if(!aMesh||!scatterTex||got<want)return; const s=D.shared; if(!s['460']||!s['461']||!s['462'])return;
 const a=(ATMO_SCENE?atmoAt(animT):null)||{};
 const e460=a['460']||s['460'], e461=a['461']||s['461'], e462=a['462']||s['462'];
 const c5=e461.slice(0,3), c7=e462.slice(0,3), c6=_cross(c5,c7), c8=e460.slice(0,3);
 const m0=a['256']||s['256']||s['260'],m1=a['257']||s['257']||s['261'],m2=a['258']||s['258']||s['262'],m3=a['259']||s['259']||s['263'];
 if(!m0||!m1||!m2||!m3)return;
 gl.useProgram(aprog); const U=n=>gl.getUniformLocation(aprog,n);
 gl.uniform4fv(U('mvp0'),m0);gl.uniform4fv(U('mvp1'),m1);gl.uniform4fv(U('mvp2'),m2);gl.uniform4fv(U('mvp3'),m3);
 gl.uniform1f(U('uFlipY'),1.0);
 gl.uniform1f(U('uLinear'),0.0);
 gl.uniform3fv(U('c5'),c5);gl.uniform3fv(U('c6'),c6);gl.uniform3fv(U('c7'),c7);gl.uniform3fv(U('c8'),c8);
 gl.uniform4fv(U('fc'),fcAtmo);
 gl.activeTexture(33984);gl.bindTexture(3553,scatterTex);gl.uniform1i(U('tex0'),0);
 gl.disable(2884); gl.depthMask(false); gl.enable(3042); gl.blendFunc(1,1);   // ONE,ONE additive
 let pl=gl.getAttribLocation(aprog,'in_pos');gl.bindBuffer(34962,aMesh.pbuf);gl.enableVertexAttribArray(pl);gl.vertexAttribPointer(pl,4,5126,false,0,0);
 let tl=gl.getAttribLocation(aprog,'in_tc0');gl.bindBuffer(34962,aMesh.tbuf);gl.enableVertexAttribArray(tl);gl.vertexAttribPointer(tl,4,5126,false,0,0);
 gl.bindBuffer(34963,aMesh.ibuf);gl.drawElements(5,aMesh.n,5125,0);
 gl.disable(3042); gl.depthMask(true);
}
function atmoAt(t){ const F=ATMO_SCENE; if(!F||!F.length)return null; if(t<=F[0].t)return F[0]; if(t>=F[F.length-1].t)return F[F.length-1];
  for(let i=0;i<F.length-1;i++){const a=F[i],b=F[i+1]; if(t>=a.t&&t<=b.t){const w=(t-a.t)/((b.t-a.t)||1);
    const o={}; for(const k of ATMO_KEYS){const va=a[k],vb=b[k]; o[k]=va&&vb?va.map((x,j)=>x+(vb[j]-x)*w):va;} return o;}}
  return F[F.length-1]; }

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
let DBG=0;           // debug output selector (MPGlobe.dbg): 1=earth 2=clouds 3=sd-direction
let ENC=3;           // DEFAULT 3=VALIDATED firmware curve composite (also the GLOW-off fallback). 0=interim Reinhard, 1=verbatim ramp-encoded (MPGlobe.enc)
let SLUM=0.30;       // calibration: colored HDR r2 -> tonemap-curve domain (MPGlobe.slum); tuned via CDP vs the real present
                     // NOTE: the GLOW composite path uses its own calibrated SLUM (~0.15) -- set by MPGlobe.glow defaults below.
let ATMO_ONLY=0;     // render only the atmosphere shell over black (MPGlobe.atmoOnly) -- for color validation
let USE_COH=true;    // DEFAULT = coherent set (9 scenes) + aligned atmosphere limb (verified cyan Rayleigh).
                     // QA confirmed BOTH sets overexpose equally at bright moments under the interim Reinhard
                     // tonemap (fc_cap5 scene0=0.21, coherent 0.16-0.27) -- the HDR decode (DRAW 18) is the
                     // shared fix. Since overexposure is identical either way, the coherent set is strictly closer
                     // to 1:1 (it ADDS the atmosphere limb the real globe has). Reverts to fc_cap5 via
                     // MPGlobe.coherent=false. Correct exposure ships when the decode lands (GLOBE_FINISH_PROCEDURE).
function setFC(){ curFC = (SCENE_FC && SCENES_IDX && SCENES_IDX[sceneIdx] && SCENE_FC[String(SCENES_IDX[sceneIdx].scene)]) || null;
 ATMO_SCENE = (ATMO_SCENES && ATMO_SCENES[sceneIdx]) || null; }
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
 // REAL fp16 HDR tonemap LUTs (RTDUMP'd ac2b90000/ac2b70000, Y16_X16_FLOAT, max ~7.86) -- replaces
 // the old 8-bit t14/t15.png which clipped the HDR. tex15 row0 .y = the validated tonemap CURVE.
 sharedTex.tex14=texF16(BASE+'lut14_rgba32f_128.bin',128,128);
 sharedTex.tex15=texF16(BASE+'lut15_rgba32f_128.bin',128,128);
 // seamless firmware cube-maps (replace the per-patch tile assembly)
 sharedTex.earthCube=cubeTex('earth');
 sharedTex.cloudsCube=cubeTex('clouds');
 sharedTex.maskCube=cubeTex('mask');
 // FAITHFUL per-patch tiles: each of the 24 patches has its own 4 firmware tiles (t00-t03 = fp tex0-3).
 // This is what the real surface fp samples (TEX2D(0,tc0.xy) etc); replaces the lossy single cube map.
 patchTex={};
 for(const p of D.patches){ const s3=String(p.idx).padStart(3,'0');
   patchTex[p.idx]=[texPNG(BASE+'full_tex/p'+s3+'_t00.png'),texPNG(BASE+'full_tex/p'+s3+'_t01.png'),
                    texPNG(BASE+'full_tex/p'+s3+'_t02.png'),texPNG(BASE+'full_tex/p'+s3+'_t03.png')]; }
 const pos=new Float32Array(await fetch(BASE+'mesh/live_surf0_pos.bin').then(r=>r.arrayBuffer()));
 const xyz=[];for(let i=0;i<289;i++)xyz.push(pos[i*4],pos[i*4+1],pos[i*4+2],pos[i*4+3]);
 // star catalog (real-derived celestial directions); build a POINTS vertex buffer
 try{ const sc=await fetch(BASE+'starcat.json').then(r=>r.ok?r.json():[]);
   if(sc&&sc.length){ const sa=new Float32Array(sc.length*4);
     for(let i=0;i<sc.length;i++){ sa[i*4]=sc[i].d[0];sa[i*4+1]=sc[i].d[1];sa[i*4+2]=sc[i].d[2];sa[i*4+3]=sc[i].b; }
     starBuf=gl.createBuffer();gl.bindBuffer(34962,starBuf);gl.bufferData(34962,sa,35044);starN=sc.length; }
 }catch(e){ starN=0; }
 const idx=[];const N=17;for(let i=0;i<N-1;i++)for(let j=0;j<N-1;j++){const a=i*N+j,b=a+N;idx.push(a,b,a+1,b,b+1,a+1);}
 const pb=gl.createBuffer();gl.bindBuffer(34962,pb);gl.bufferData(34962,new Float32Array(xyz),35044);
 const ib=gl.createBuffer();gl.bindBuffer(34963,ib);gl.bufferData(34963,new Uint16Array(idx),35044);
 eMesh={pb,ib,n:idx.length};
 // verbatim atmosphere shell: mesh c0 (pos.w + tc0.zw drive the shell), scatter LUT, captured fc_atmo
 try{
   const [apb,atb,aib]=await Promise.all([
     fetch(BASE+'mesh/c0_pos.bin').then(r=>r.arrayBuffer()),
     fetch(BASE+'mesh/c0_tc0.bin').then(r=>r.arrayBuffer()),
     fetch(BASE+'mesh/c0_idx.bin').then(r=>r.arrayBuffer())]);
   const apbuf=gl.createBuffer();gl.bindBuffer(34962,apbuf);gl.bufferData(34962,new Float32Array(apb),35044);
   const atbuf=gl.createBuffer();gl.bindBuffer(34962,atbuf);gl.bufferData(34962,new Float32Array(atb),35044);
   const aibuf=gl.createBuffer();gl.bindBuffer(34963,aibuf);gl.bufferData(34963,new Uint32Array(aib),35044);
   aMesh={pbuf:apbuf,tbuf:atbuf,ibuf:aibuf,n:new Uint32Array(aib).length};
   scatterTex=texF32(BASE+'win_tex/t04_f32.bin',256,128);
   const AC=await fetch(BASE+'c3000_consts.json').then(r=>r.json());
   fcAtmo=new Float32Array(17*4);for(let i=0;i<17;i++){const v=(AC.fc_atmo&&AC.fc_atmo[i])||[0,0,0,0];fcAtmo[i*4]=v[0];fcAtmo[i*4+1]=v[1];fcAtmo[i*4+2]=v[2];fcAtmo[i*4+3]=v[3];}
 }catch(e){ aMesh=null; }
 PATHS=await fetch(BASE+'camera_paths.json').then(r=>r.json());
 presetIdx=7; preset=pickPreset(presetIdx); animT=0;
 // Per-scene replays (camera + lighting). DEFAULT = fc_cap5 clean set (scene_NN), no overexposure.
 // USE_COH = coherent set (scene_NN_coh) + ALIGNED atmosphere (atmo_scene_NN_coh) -- the limb shell registers
 // to the earth, but the coherent set's brighter scenes overexpose under the interim tonemap (decode pending).
 const SUF = USE_COH ? '_coh' : '';
 try{ const idx=(await fetch(BASE+'scenes_index'+SUF+'.json').then(r=>r.json())).filter(s=>!s.skip);
   SCENES_IDX=idx;
   SCENES=await Promise.all(idx.map(s=>fetch(BASE+s.file).then(r=>r.json()))); sceneIdx=0; animT=0;
   try{ SCENE_FC=await fetch(BASE+'scene_fc'+SUF+'.json').then(r=>r.json()); }catch(e){ SCENE_FC=null; }
   if(USE_COH){ ATMO_SCENES=await Promise.all(idx.map(s=>fetch(BASE+'atmo_scene_'+String(s.scene).padStart(2,'0')+'_coh.json').then(r=>r.ok?r.json():null).catch(()=>null))); ATMO=1; }
   else { ATMO_SCENES=null; ATMO=0; }   // fc_cap5 has no aligned atmosphere -> keep the limb off (no misaligned shell)
   setFC(); ATMO_SCENE=ATMO_SCENES?ATMO_SCENES[0]:null;
 }catch(e){ SCENES=null; }
}

const MPGlobe={
 start(cv){
   running=true;
   if(gl && canvas===cv) return;        // already initialised on this canvas -> just resume
   canvas=cv;
   gl=canvas.getContext('webgl2',{alpha:false,antialias:true,preserveDrawingBuffer:true});
   if(!gl){ console.warn('MPGlobe: WebGL2 unavailable'); return; }
   gl.getExtension('OES_element_index_uint'); hdrExt=gl.getExtension('EXT_color_buffer_float'); gl.getExtension('OES_texture_float_linear');
   prog=gl.createProgram();gl.attachShader(prog,sh(35633,VS));gl.attachShader(prog,sh(35632,FS));gl.linkProgram(prog);
   if(!gl.getProgramParameter(prog,gl.LINK_STATUS)){errlog+=gl.getProgramInfoLog(prog);console.warn('MPGlobe link:',errlog);}
   aprog=gl.createProgram();gl.attachShader(aprog,sh(35633,A_VS));gl.attachShader(aprog,sh(35632,A_FS));gl.linkProgram(aprog);
   if(!gl.getProgramParameter(aprog,gl.LINK_STATUS)){errlog+=gl.getProgramInfoLog(aprog);}
   // GLOW composite program + fullscreen VAO (gated path; harmless if GLOW stays off)
   cprog=gl.createProgram();gl.attachShader(cprog,sh(35633,C_VS));gl.attachShader(cprog,sh(35632,C_FS));gl.linkProgram(cprog);
   if(!gl.getProgramParameter(cprog,gl.LINK_STATUS)){errlog+=' composite link: '+gl.getProgramInfoLog(cprog);}
   starProg=gl.createProgram();gl.attachShader(starProg,sh(35633,STAR_VS));gl.attachShader(starProg,sh(35632,STAR_FS));gl.linkProgram(starProg);
   if(!gl.getProgramParameter(starProg,gl.LINK_STATUS)){errlog+=' star link: '+gl.getProgramInfoLog(starProg);}
   glowVAO=gl.createVertexArray();
   if(!D) load().catch(e=>console.warn('MPGlobe load:',e));   // fetch assets once
 },
 tick,                                   // music loop calls this each frame, then drawImage(canvas)
 ready(){ return !!(running && D && eMesh && got>=want); },
 stop(){ running=false; },
 set sceneSecs(v){ SCENE_SECS=v; },
 get sceneSecs(){ return SCENE_SECS; },
 _setScene(i){ if(SCENES){ sceneIdx=((i%SCENES.length)+SCENES.length)%SCENES.length; animT=0; setFC(); } },  // diagnostic: force a scene
 _setT(t){ animT=t; },
 _render(obj){ if(!D)return; running=false;        // inject exact-frame consts + draw (decode/validation)
   for(const k in (obj.shared||{})) D.shared[k]=obj.shared[k];
   if(obj.fc) curFC=obj.fc;
   if(obj.atmo){ const a={t:0}; for(const k in obj.atmo) a[k]=obj.atmo[k]; ATMO_SCENE=[a,Object.assign({},a,{t:1})]; ATMO=1; } else { ATMO=0; }
   animT=0.0; draw(); },
 set stars(v){ STARS_ON=v?1:0; },
 get stars(){ return STARS_ON; },
 set tiles(v){ TILES=v?1:0; },                 // faithful per-patch tile earth (1) vs legacy cube map (0)
 get tiles(){ return TILES; },
 set starBri(v){ STAR_BRI=v; },
 get starBri(){ return STAR_BRI; },
 get starCount(){ return starN; },
 set dbg(v){ DBG=v; },
 set enc(v){ ENC=v; },
 set slum(v){ SLUM=v; },
 set atmoOnly(v){ ATMO_ONLY=v?1:0; },
 set atmo(v){ ATMO=v?1:0; },
 get atmo(){ return ATMO; },
 set glow(v){ GLOW=v?1:0; },                                   // GLOW render path (HDR FBO -> bloom -> CURVE composite)
 get glow(){ return GLOW; },
 set glowGain(v){ if(Array.isArray(v)&&v.length===3) GLOW_GAIN=v.slice(); else if(typeof v==='number') GLOW_GAIN=[v,v,v]; },
 get glowGain(){ return GLOW_GAIN.slice(); },
 set glowWarm(v){ if(Array.isArray(v)&&v.length===3) GLOW_WARM=v.slice(); },
 get glowWarm(){ return GLOW_WARM.slice(); },
 set glowSlum(v){ GLOW_SLUM=v; },                              // GLOW-path earth exposure (separate from ENC=3 SLUM)
 get glowSlum(){ return GLOW_SLUM; },
 set glowChroma(v){ GLOW_CHROMA=v; },                          // 0=pure luminance earth (golden); small=ocean tint back
 get glowChroma(){ return GLOW_CHROMA; },
 set coherent(v){ USE_COH=!!v; },   // switch to coherent surface set + aligned atmosphere (dev; overexposes until decode lands)
 get coherent(){ return USE_COH; },
 get _info(){ return {scene:sceneIdx, nScenes:SCENES?SCENES.length:0, animT:animT.toFixed(3)}; },
 _glowStats(){    // diagnostic: float magnitude of HDR FBO + glow tex (calibration only)
   if(!gl||!hdrFBO||!_lastGlow) return 'no glow yet';
   const readF=(fbo,tex,w,h)=>{ const f=gl.createFramebuffer(); gl.bindFramebuffer(36160,f);
     gl.framebufferTexture2D(36160,36064,3553,tex,0);
     const N=Math.min(w,512), M=Math.min(h,512); const buf=new Float32Array(N*M*4);
     gl.readPixels(0,0,N,M,6408,5126,buf); gl.deleteFramebuffer(f);
     let mx=[0,0,0], sm=[0,0,0], cnt=0;
     for(let p=0;p<N*M;p++){ for(let c=0;c<3;c++){ const v=buf[p*4+c]; if(v>mx[c])mx[c]=v; sm[c]+=v; } cnt++; }
     return {max:mx.map(x=>+x.toFixed(3)), mean:sm.map(x=>+(x/cnt).toFixed(3))}; };
   const e=readF(null,hdrFBO.tex,hdrFBO.w,hdrFBO.h);
   const g=readF(null,_lastGlow.tex,_lastGlow.w,_lastGlow.h);
   gl.bindFramebuffer(36160,null);
   return {earthHDR:e, glow:g, slum:SLUM, gain:GLOW_GAIN};
 },
 get error(){ return errlog; }
};
global.MPGlobe=MPGlobe;
})(window);
