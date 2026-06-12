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
let BASE = 'globe_assets/';   // asset root; MPGlobe.assetBase overrides (validation: point at a rebuilt set without swapping the ship)
// The per-scene LUT bins under gaia_lut/captured2 are stored in Git LFS. GitHub Pages serves the LFS
// POINTER text (not the binary), so on *.github.io we fetch the real bytes from GitHub's LFS media
// endpoint (sends CORS *). Local/other hosts have the real bins on disk -> use BASE-relative. Repo/user
// are derived from the Pages URL (works for forks); branch assumed main.
function lfsURL(p){ const rel=BASE+p;
  try{ const m=location.hostname.match(/^([^.]+)\.github\.io$/);
    if(m){ const repo=location.pathname.split('/').filter(Boolean)[0]||(m[1]+'.github.io');
      return 'https://media.githubusercontent.com/media/'+m[1]+'/'+repo+'/main/'+rel; } }catch(e){}
  return rel; }
// main scenes in numeric order. Per-scene camera motion is EXACT (firmware camera.path +
// Catmull-Rom); only the cross-scene ORDER is a documented approximation (the real top-level
// sequencer lives in the un-dumped vsh music module). Each preset plays once then advances.
const PRESETS = ['preset_0','preset_1','preset_2','preset_3','preset_4',
                 'preset_5','preset_6','preset_7','preset_8','preset_9'];

let gl=null, canvas=null, prog=null, aprog=null, raf=0, running=false;
let cprog=null;                 // GLOW composite fullscreen program
let gsProg=null;                // GlareSource bright-pass (verbatim firmware post-proc)
let _gsRef={cur:null};          // bright-pass RT holder
let _postRef={cur:null};        // post-burst scene RT (the firmware encodes the DISPLAY incl. the burst into the bloom)
let hdrExt=null;                // EXT_color_buffer_float (RGBA16F FBO) - required for the GLOW path; null = fall back to forward
let hdrFBO=null, glowVAO=null;  // lazy HDR scene FBO + composite VAO
let GLOWFAITH=1;                // MPGlobe.glowfaith: FAITHFUL path (col0 earth + separate HDR limb/sun bloom); default off until validated
let GLOW=1;                     // GLOW path flag (MPGlobe.glow) -- DEFAULT ON: the verbatim golden composite (EXT-guarded; falls back to forward if no RGBA16F FBO). ~20ms/frame w/ sync = real-time.
let LUTWARM=0;                  // WIP (MPGlobe.lutwarm): use the real surface-fp LUT tonemap (gold) in the composite instead of the reinhard. Default OFF until validated.
let LUTSCALE=1.0;               // MPGlobe.lutscale
let FEEDBACK_PS=0;             // MPGlobe.feedback: apply the steady-state backbuffer feedback x1/(1-fc21) (default off): firmware tex14/15 COORD_SCALE2 (UNNORMALIZED LUT -> 1/128); default 1.0 (legacy, no change to shipped paths)
let LUTEXPO=0.1;               // exposure of the web earth into the firmware r2 range for the LUT (matched-scene calibrated ~0.1; MPGlobe.lutexpo)
let _lastGlow=null;             // diagnostic handle to last buildGlow result
// ---- GLOW composite calibration (BLUE per-channel earth term) ---------------------------------
// REWRITTEN 2026-06-07: the composite is now additive-bloom-in-linear-HDR then the firmware HDR.mnu
// extended-Reinhard tonemap applied PER CHANNEL (preserves the blue earth albedo; measured real
// present lit-side B/G=1.11). The previous luminance+warm golden composite was wrong (see
// project_globe_ground_truth_2026-06-07). GLOW_SLUM = the firmware HDR.mnu EXPOSURE (0.789, same as
// the ENC0 surface path that measured B/G=1.10 == the real present). GLOW_GAIN = additive bloom
// strength (neutral; the sun glint/limb halo). Both verified via /tmp/render_compare.py vs the present.
// Glare-add weight: the firmware composite (59b4612/316de80a) does display += glare_bloom at the
// per-scene GLARE LEVEL (HDR.mnu, default 5.59). The web bloom now blooms the GlareSource BRIGHT-PASS
// (gsRT), so its accumulator magnitude differs from the firmware glare RT -> this is a NORMALIZATION of
// the web bloom into the firmware glare proportion (a modest additive halo, not the dominant haze the
// old raw-HDR bloom produced). Set so the limb/sun halo is visible but the toned scene dominates.
let GLOW_GAIN=[0.012,0.012,0.012];
let GLOW2=0;  // sun-glare pass (verbatim fp 727d0242); gated default off until validated
let BURST=0;                           // verbatim sun-disc BURST pass (globe_burst.js, vp c868fd6a + fp ac07b20f); gated until the c[254..263] window recapture validates
let FLARE_SCENES=null, BURST_FAN=null; // per-scene burst consts rows + the captured 65-vert fan
let encProg=null;               // verbatim encode fp bd9c5fac/bc48008a: decode display (rgb*a*8) + sqrt-curve brightpass key -> bloom source
let _encRef={cur:null};         // 512x512 bloom-source RT (firmware encode size, f82800 d017 viewport)
let _dispFb={cur:null};         // persistent PREV-FRAME composited display (the bloom feedback loop input: the encode of frame N reads frame N-1's display = the eclipse-burst positive-feedback mechanism)
let BLOOM_SCENES=null;          // per-scene rows {t,fr,enc[8],blur[8x3],up[8],comp[2]} harvested per frame (harvest_bloom.py)
// ---- IN-SCATTER GENERATOR (the d017-d022 chain, VERBATIM; validated 63.7/65.4/68.0 dB vs live GPU
//      buffers by bloom_tools/inscat_ref.py). Inputs: per-scene seedA 40x40 + seedB 40x20 (CPU-written
//      in firmware) + the static BicubicTable 128x1. Outputs: bufA (limb scatter _AtmSpaceIv) + bufC (tex4).
let ipUpProg=null, ipCombineProg=null;
let _ipA={cur:null}, _ipB={cur:null}, _ipC={cur:null};
let texBicubic=null, texSeedA=null, texSeedB=null;
let INSCAT_GEN=0;               // MPGlobe.inscatgen: use the generated bufA/bufC instead of the streamed captured LUT bins
let SEED_MANIFEST=null, SEED_CACHE={}, _seedCur=null;   // cap3-aligned per-keyframe recovered seeds (seeds_cap3/)
let _ipValid=false;             // the generated buffers correspond to the CURRENT scene's seeds
let FLARE_ROWS=null, FLARES=0, FLARESPRE=0, DISPRETAIN=0;   // per-frame sun-flare billboard rows (vp 48ad6e97 windows + fp consts); MPGlobe.flares gate
let BIAS0=-8.0, BIAS2=-0.1562;   // REAL RSX LOD biases (DRAWCALLS); MPGlobe.bias0/bias2 for sampling A/B
let STARS2=0;                    // MPGlobe.stars2: verbatim per-frame star brightness (the harvested enc2 consts) instead of the .mnu curve
let GLARE_ROWS=null;
let TRANS_TABLE=null;             // measured per-boundary transition envelope (present-derived dips; transition_table.json)             // per-scene REAL sun-glare consts (vp c868fd6a, 17 fc rows in the GLOW_FC layout; [13]/[16]=color, denormal-zero when dormant)
let FAITH_POLICY=null;           // faithful_policy.json: per-scene winners from the all-scene fbf sweep (measured vs presents)
let FAITH_AUTO=0;                // MPGlobe.faithauto: auto-gate BLOOMDISP per scene from FAITH_POLICY
let BLOOMDISP=0;                // MPGlobe.bloomdisp: FAITHFUL bloom-of-display (encode bd9c5fac -> pyramid -> display+bloom*0.125, the burst corona). Gated until measured vs presents.
let BLOOMPREMUL=1;              // encode output rgb premultiplied by the brightpass key (wiring of out.w into the pyramid; measurement-decided)
let BLOOMALPHA=0;               // decode term: 0 = a*8=1 (display alpha 1/8 steady-state), 1 = sample the display texture alpha
// REAL pyramid constants for the bloom-of-display chain, captured at globecap3 frame 82800 (burst):
// blur (d027+ const[0..6].x, normalized 15-tap) + combine scalars (d044-d051 const[0].x, small->large).
// NOTE these combine scalars are PER-FRAME animated by the firmware (the known ~6.6x bloom swing);
// this set is the burst-frame ground truth. TODO: per-(scene,t) harvest like the camera rows.
const ENC_BLUR_W=[0.161606,0.149085,0.117048,0.0782073,0.0444719,0.0215217,0.00886383,0].map(w=>[w,w,w]);
const ENC_UP_W=[5.30487,3.22005,1.95457,1.18642,0.720155,0.437133,0.265339,0.161061];
let glowSprite=null;
let GLOW_FC=[[1920,1080,0,0],[1.00918,0,0,0],[-1,0,0,0],[0.249846,-0.956276,-5.25935,0],[1920,1080,0,0],[0.249846,-0.956276,-5.25935,0],[-1,1,0,0],[1,0,0,0],[1,1,1,1],[1,1,1,1],[1,1,1,1],[1,1,1,1],[0,0,0,2],[0.433875,0.0737772,0.0257549,0],[1,0,0,0],[1,1,1,1],[0.433875,0.0737772,0.0257549,0]];  // bloom gain = 1/450 (web bloom accumulator ~450x firmware) -> adds the firmware bloom at FULL weight per the verbatim composite fp 316de80a (scene*0.125 + bloom*1). NOT a tiny limb-halo: the bloom is the dominant haze.
let GLOW_WARM=[1.0,1.0,1.0];   // retained for the MPGlobe.glowWarm setter API; no longer used by C_FS
// Exposure into the per-channel extended-Reinhard. DERIVED (not eyeballed): the surface fp emits
// r2 = colored_earth * 8.0 (the HDR scale for the bloom path, globe_mp.js ~line 279). The real HDR.mnu
// display EXPOSURE is 0.789, applied to the PRE-x8 earth -> on the x8'd r2 the exposure is 0.789/8 =
// 0.0986. (Matches the agent's measured k=0.0965, MSE 0.0023 vs the real present.) The extended-Reinhard
// rolloff (W=3.40918) then handles the per-scene radiance range, so a single exposure is per-scene-correct
// (dark scenes stay dim, bright scenes roll off, NOT blown white). VALIDATED 2026-06-07: web earth midtone
// [77,86,95] vs real present [74,84,94] = ratio 1.03, B/G 1.11 (== the real present). The old 0.42 was
// eyeball-tuned and 4.3x too bright (overexposed every bright scene to white).
let GLOW_SLUM=0.789;  // decode exposure (HDR.mnu EXPOSURE) applied to the verbatim composite (scene*0.125 + bloom); scene*0.125*0.789=0.0986 keeps the surface match
let GLARE_THRESH=0.552855;  // HDR.mnu GLARE THRESH (default scene) -> the GlareSource bright-pass threshold (only > this blooms)
let GLOW_CHROMA=0;             // retained for the MPGlobe.glowChroma setter API; no longer used by C_FS
let D=null, eMesh=null, want=0, got=0, sharedTex={}, patchTex=[], black=null, black0=null;
let aMesh=null, aMesh2=null, scatterTex=null, fcAtmo=null;  // verbatim atmosphere: main shell + the 400-vert inner band (firmware draws 3f6eeb47 TWICE; the band's w=0.982..1.0 inner edge overlaps the disc = the seamless disc->glow bridge)
let ATMO_SCENES=null, ATMO_SCENE=null, ATMO=0;       // per-scene aligned atmosphere (coherent capture); MPGlobe.atmo toggles
const ATMO_KEYS=['256','257','258','259','460','461','462'];
let PATHS=null, animT=0, preset=null, presetIdx=7, errlog='';
let starProg=null, starBuf=null, starN=0;   // celestial star field (triangulated from real presents)
let starBoxBuf=null;                         // star skybox cube VBO (36 verts: pos.xyz + tc.xy)
let fadeProg=null;                           // scene-transition black-fade program
let FADE_SECS=1.2;                           // dip-to-black duration at each scene end/start (APPROX; MPGlobe.fadeSecs)
let starCube=null, starTexProg=null, star2D=null;  // FAITHFUL stars: real firmware star texture (face_neg_z_ul.dds)
let STARTEX=1;                              // 1 = use the real star-texture cube; 0 = legacy catalog points
let STARTEX_SKIP_SCENES=[0];                // scenes where the real shows NO visible stars (bright low-orbit earth; the dark sky tonemaps to pure black). The web's texture stars are additive in DISPLAY space (not exposure-bound), so they wrongly show in the dark sky; suppress them here. Real sc0 top-sky mean 1.10 (clean) vs web-with-stars 2.93.
let STAR_WHITE=0.217;                       // EARTH.mnu STARS WHITENESS (per-scene FACTOR folds in later)
let STAR_POW=2.1493;                        // EARTH.mnu STARS POWSCALE (sparsens the field: pow(tex,POWSCALE))
let STAR_TILE=6.0;                          // firmware tiles the texture on the cube -> MINIFICATION (crisp 1px stars).
                                            // 1-tile/face = magnification blobs+streaks (the "snow"). tile=6 matches the
                                            // real s15 present: size 1px, density 605 vs 598/MP, peak 14 vs 12 (score 0.12).
let STARSONLY=0;                            // debug: render only the star field (skip earth) for validation
// ECLIPSE SUN BURST (the "huge light burst from behind the globe"). SunDisc_FP (decompiled verbatim):
// uv=quadUV-0.5; w=|uv.x|*SCALE_X - |uv.y|*SCALE_Y; glow=exp(w); col=glow*Color; occluded by the earth (ray-sphere).
// Rendered bright into the HDR FBO so the bloom pyramid makes the corona (validated 3-Gaussian sigma 41/117/304 px).
let baseProg=null, baseMesh=null;            // continuous unit-sphere EARTH BASE layer (limb-notch backfill, drawn before patches)
let BASE_FILL=1;                              // MPGlobe.basefill: fill the grazing-angle limb notches with a continuous base sphere (ATMO_REAL/scene-0 path). Patches overdraw it; only notches reveal it.
let BASE_GAIN=1.0;                            // base-layer brightness scale (rough match to the patch display tone; MPGlobe.basegain)
let BASE_SCALE=1.0;                           // base-sphere radius scale = the true ideal limb (no ring past the patch limb). The dense base tessellation (256x128) makes its own silhouette solid, so it fills the patches' inward notches up to the ideal limb without overshoot. MPGlobe.basescale
let sunDiscProg=null;                        // procedural sun-disc program (no texture)
let SUNDISC=1;                               // MPGlobe.sundisc: render the burst
let SUN_BRI=3.4;                             // SUN.mnu BRIGHTNESS 3.4 (the disc's HDR intensity scale)
let SUN_SCX=3.0, SUN_SCY=6.0;                // SUN.mnu SCALE X/Y = _SpikeFalloff (the exp glow anisotropy, verbatim)
let SUN_SIZE=0.16;                           // NDC half-size of the disc quad (the geometry/UV-range is CPU-side in fw; calibrated to the real corona)
let SUN_NOOCC=0;                              // debug: skip earth occlusion (verify the disc renders when the sun is occluded)
// IN-SCATTER per-scene (eclipse). The surface fp + atmosphere shell both sample _AtmSpaceIv (tex4==scatterTex).
// The shipped web uses the DAYTIME _AtmSpaceIv (bright -> lit earth); the eclipse needs the ECLIPSE _AtmSpaceIv
// (dark, warm only at the back-lit limb -> dark earth + warm limb arc). The eclipse RT is decoded on disk.
let INSCAT_ECL=0;                             // MPGlobe.inscatecl: use the eclipse _AtmSpaceIv LUT (per-scene; manual eclipse override)
// ---- PER-SCENE IN-SCATTER (runtime nearest-LUT selection from the 32-scene dataset) ----
// The in-scatter LUT (surface fp tex4, RT ac6f80000) AND the atmosphere limb LUT (atmo fp tex0,
// RT ac6e80000) are PER-SCENE: they vary with the full sun direction + ATTN. The dataset
// globe_assets/gaia_lut/inscatter/manifest.json carries 32 captured scenes; each scene .bin is the
// REAL decoded RT (256x128 RGBA f32). Runtime picks the nearest captured scene by sun direction
// (dominant) + ATTN_ATM (secondary), lazy-loads + binds its EARTH lut as tex4 and its LIMB lut as the
// atmosphere scatter, and feeds its atmo_mvp/atmo_basis/atmo_fc to the limb shell. This generalizes the
// manual eclipse override to every scene. The eclipse scene (ecl2) reproduces the validated 1:1 path
// byte-for-byte (ecl2.bin == the shipped tex4ecl; ecl2_limb.bin == the shipped tex0atmEcl).
let INSCAT_PS=0;                              // MPGlobe.inscatps: runtime per-scene in-scatter selection
let CAP_LUT=null, CAP_LIMB=null;
let CAP_LUTB=null, CAP_MIX=0.0, CAP_LIMBB=null;   // crossfade partners             // captured per-frame in-scatter + limb LUT override (validation/wiring)
let CAP_T14=null, CAP_T15=null;              // per-scene surface-fp tonemap LUT (tex14/tex15) override; null=static lut14/lut15
let TONELUT_PS=1;                            // MPGlobe.tonelut: per-scene tonemap LUT + verbatim ramp-encode output (brightness fix); default OFF until per-scene LUTs captured+validated
let CAP_SCENE_TONE=null;                     // {sceneNum:[{fr,t14,t15}]} per-scene captured tonemap-LUT manifest (cap_scene_tonelut.json)
let CAP_TONE_CACHE={};                        // frame -> {t14:tex, t15:tex} preloaded per-scene tonemap LUT textures
let CAPLIB=null, CAPLIB_ON=0;                // captured LUT library {scenes:[{sun,c263,eye,name,limb}]} + nearest-pick
let CAP_SCENE_LUTS=null;                     // cap set: {sceneNum:[{fr,surf,limb}]} per-scene captured in-scatter+limb LUT manifest
let CAP_LUT_CACHE={};                        // frame -> {surf:tex, limb:tex} preloaded captured LUT textures (cap set)
let INSCAT_MANIFEST=null;                     // loaded manifest.json (scenes[])
let INSCAT_CACHE={};                          // name -> {lut:tex, limb:tex} lazy-loaded F32 textures
let INSCAT_PICK_W=1.2;                        // ATTN_ATM penalty weight in pickScene score (sun-dir dominant)
let _psName=null;                             // diagnostic: last picked scene name
let SURF_ECLFLIP=0;                           // DEPRECATED no-op: the surface earth now uses uFlipY=-1 for ALL scenes
                                              // (firmware-viewport identity, proven via TF gl_Position vs ecl2/warm2 presents).
                                              // The old per-eclipse flip experiment is gone; the setter is retained for harness compat.
let ATMO_VFLIP=0;                             // orientation probe for the atmo shell _AtmSpaceIv LUT
let ATMO_REAL=0;                              // EFFECTIVE per-frame value (set in drawGlowFaith from ATMO_REAL_MASTER & the per-scene whitelist). REAL atmosphere compositing (fp c47472608e740973 = 63d3246d math) + dst-alpha blend (src=773/dst=772, live D21) + sky-alpha=0 clear + camera-guard bypass + HDRC off. Replaces the legacy additive "huge white band".
let ATMO_REAL_MASTER=1;                       // MPGlobe.atmoreal: feature toggle for the real dst-alpha atmosphere.
let ATMO_REAL_SCENES=[0,1];                    // scenes validated for the real dst-alpha law + bloom-of-display glow. Scene 0 proven vs sc0_full presents; scene 1 (lit-earth closeup) proven vs cycle present f1203240 (camera-matched): the firmware bloom-of-display glow restores the soft limb halo (base limb-apex fell to ~2 by 30px up, real holds ~24->8; glow holds ~20->15 = near-field match). Other scenes keep their prior path until each is individually re-validated.
let SCENE0_LOOP=1;                             // MPGlobe.scene0loop: scene 0 PING-PONGS over its clean LIT range [S0_T0,S0_T1] instead of sweeping into the dark/grazing/notched night back-half (which is a cross-playthrough camera mismatch vs the all-daytime sc0_full ground truth). Removes the black patches, the slow-to-black, and the sudden band-on-loop. No fade dip (animT stays away from 0/1). Scene-0 only.
let S0_T0=0.10, S0_T1=0.50;                    // scene-0 clean lit animT range (mean ~42, no night, no grazing notches; validated zero interior dark-notches + smooth limb across [0.10,0.50]). MPGlobe.s0range([a,b]).
let s0dir=1;                                   // ping-pong direction
let SCENE0_DWELL=1080;                          // MPGlobe.scene0dwell: frames scene 0 ping-pongs (~18s @60fps) before it dips to black and advances to scene 1. Scene 0 then re-enters at the cycle wrap. <=0 = loop forever (legacy).
let s0frames=0;                                // frames spent in scene 0 this visit
let s0exit=0;                                  // 1 = scene 0 is fading out toward the scene-1 cut
let s0exitF=1.0;                               // scene-0 exit dip multiplier (1=lit, 0=black); drives drawFade, then advances
let COV_ALPHA=0;                               // MPGlobe.covalpha: surface writes a COVERAGE=1 dst-alpha mask over the disc. PROVEN NO-OP in the warm faith path (0 changed px): the 63d3246d atmo over the disc is already negligible, so masking it off the disc changes nothing. Kept as a toggle. The real limb-concentrated "whole-earth glow" is the SURFACE falloff (real B-R peaks 66@+40 -> 28; web flat 49->43), NOT the atmosphere - next gap, RE-able from sc0_full.
let FP16=1;                                    // MPGlobe.fp16: faithfully truncate the surface fp's half-register writes to fp16 (real RSX runs the fragment shader in half-float; FragmentProgram50 has clamp16() at exactly these sites). The web previously computed r2 in fp32, diverging slightly at the bright limb. Default ON = faithful port.
let ATMO_OVER=0;
let ATMO_DSTA=0;                              // MPGlobe.atmodsta: REAL dst-alpha atmo blend (src=ONE_MINUS_DST_ALPHA,dst=DST_ALPHA) captured live from DRAWCALLS                              // MPGlobe.atmoover: alpha-OVER atmo compositing (faithful music-globe REPLACE-with-coverage) vs legacy additive (white band)
let ATMO_HDRC=0;                              // MPGlobe.atmohdrc: FAITHFUL HDR-domain composite -- render surface+atmo as LINEAR HDR, then ONE real dual-LUT tonemap (the limb HDR rolls off smoothly, no additive-LDR white band)
let ATMO_SOLID=0;                             // debug: bind a solid-warm LUT to test shader math/coord
let ATMO_FLIPY=1.0;                           // shell uFlipY (orientation probe)
let ATMO_HDR=7.863;                           // firmware preexpose scale = TEX15/TEX14 LUT (lut15_rgba32f) max 7.863, = the atmo fp's r0 exposure before the scene RT (replaces the rounded 8.0 approximation)
let IEFULL=1;                                 // use the UNCLAMPED IE LUT (the clamped tex5 loses the night/negative term = proven bug; ieFull restores the dark side)
let FCATMO_OVR=0;
let BLOOMC1=1;                 // composite bloom gain = comp[1] (0.125): A/B vs presents picked FC1 decisively (sc23 flash 59->35 pd, sc24 wash at real magnitude, no regressions; FC0=1.0 overshot 2-3x everywhere)
let ATMOBAND=1;                // second (inner-band) atmosphere draw (MPGlobe.atmoband)
let ATMODEPTH=0;               // 1 = legacy: shell depth-tests against the earth (the thin black gap at the silhouette); 0 = shell draws regardless (MPGlobe.atmodepth)
let ATMOGUARD=1;               // atmo camera-sanity guard (MPGlobe.atmoguard; 0 = always draw the shell)
let ATMOFC=1;                   // real per-(scene,t) atmo fp consts from rows (MPGlobe.atmofc; 0 = legacy static+approx)                              // when set (MPGlobe.fcatmo used), use the REAL per-scene atmo fp consts (_AtmFactor from the atmo draw) instead of the curFC[4].y approximation
let STARS_ON=1;                              // MPGlobe.stars
let TILES=1;                                 // 1 = faithful per-patch tile sampling (firmware 24-patch x 4-tile); 0 = legacy cube map (MPGlobe.tiles)
let CULL=1;                                   // per-patch back-face cull (MPGlobe.cull); 0 = no cull (rely on depth) - test for grazing-patch triangular gaps
let PATCH_EXP=1.0;                             // MPGlobe.patchexp: grow patch quads to overlap-close the limb seam gaps (1.0 = off)
let DESPECKLE=1;                               // MPGlobe.despeckle: fill the thin patch-seam dark gaps at the limb (composite-pass coverage fill, 1..4px bracket). Validated: crest dark px 346->6, mean unchanged.
// All 24 patches' tiles (albedo t00/t01, cloud t02, mask t03) re-captured clean from live RPCS3
// via the TEXDUMP command (un-swizzled, DXT-decoded BGRA8, cropped to the real 512x128 strip).
// The old corrupt-t02 workaround is no longer needed - every patch uses its clean per-patch tile.
const BADT2 = new Set([]);
let T2ALL=0;   // test: 1 = sample ALL patches' cloud detail from the clouds cube (uniform/seamless cloud), albedo still per-patch tiles
let STAR_BRI=4.0;                            // star HDR brightness into the scene (calibrated through the GLOW tonemap so stars read faint, like the present; MPGlobe.starBri)

const _sub=(a,b)=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]];
const _cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const _norm=(a)=>{const l=Math.hypot(a[0],a[1],a[2])||1;return[a[0]/l,a[1]/l,a[2]/l];};
const _dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];

const VS=`#version 300 es
precision highp float;
in vec4 in_pos; uniform vec4 vc[26]; uniform float uFlipY; uniform float uPatchExp;
out vec4 tc0,tc3,tc4,tc5,tc6,tc8,tc9; out vec3 vN; out vec3 vL; out vec3 vSph; out vec4 vClip;
float fma1(float a,float b,float c){return a*b+c;}
vec3 fma3(vec3 a,vec3 b,vec3 c){return a*b+c;}
vec2 fma2(vec2 a,vec2 b,vec2 c){return a*b+c;}
void main(){
vec4 ip = (in_pos-0.5)*uPatchExp+0.5;   // uPatchExp>1: extrapolate the [0,1] patch grid so adjacent patches OVERLAP, closing the thin limb seam gaps (the real PS3 renders gap-free; the web's exact-quad mapping leaves sub-pixel holes where captured corners don't weld). 1.0 = exact.
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
  vClip=d0;
  vec4 clip=d0;
  vec2 ndc=clip.xy/clip.w; vec2 win=ndc*vec2(960.0,-540.0)+vec2(960.0,540.0);
  clip.xy=((win/vec2(960.0,540.0))-1.0)*clip.w;
  clip.z=clip.z*2.0-clip.w; clip.y*=uFlipY; gl_Position=clip;
}`;
const FS=`#version 300 es
precision highp float;
in vec4 tc0,tc3,tc4,tc5,tc6,tc8,tc9; in vec3 vN; in vec3 vL; in vec3 vSph; in vec4 vClip;
uniform sampler2D tex0,tex1,tex2,tex3,tex4,tex5,tex6,tex13,tex14,tex15;
uniform float uT3Flip;
uniform sampler2D tex4b; uniform float uT4Mix;   // bracketing in-scatter bin crossfade
uniform float uLimbGain2;   // surface horizon-band gain (the ring painter; per-scene ratio-calibrated vs presents)
uniform float uDiscGain;   // per-scene disc/face exposure lift
uniform float uLimbSoft;   // per-scene highlight compression (un-blows the saturated limb into a soft atmospheric band)   // tex0-3 = THIS patch's 4 firmware tiles (t00-t03)
uniform samplerCube earthCube, cloudsCube, maskCube;   // legacy cube-map path (kept for DBG/fallback)
uniform vec4 fc[23];
uniform float uDbg, uMode, uSlum, uTiles, uT2bad; uniform float uCovAlpha;
uniform float uBias0; uniform float uBias2;   // REAL RSX LOD biases (-8.0 / -0.1562), runtime-tunable for sampling A/B   // uTiles=1 -> per-patch tiles; uT2bad=1 -> this patch's t02 detail tile is corrupt, sample cloud from the cube instead
uniform float uLutScale, uFeedback;   // firmware LUT COORD_SCALE2 (tex14/15 are UNNORMALIZED: scale=1/128). default 1.0 (legacy). r2 is sampled at r2*uLutScale.
uniform float uFp16;   // 1 = faithfully truncate the half-register writes to fp16 (real RSX runs the fp in half-float; FragmentProgram50 has clamp16() at these exact sites). 0 = legacy fp32.
uniform float uExpFix; // SCENE-0 GLOW: compute col0.w (the bloom-encode key / display HDR-exponent) from a=1-HDR/(display*8) (the captured tone LUT lacks this channel)
out vec4 ocol0;
vec3 nrm(vec3 v){return length(v)>0.0?normalize(v):v;}
vec3 fma3(vec3 a,vec3 b,vec3 c){return a*b+c;}
vec2 fma2(vec2 a,vec2 b,vec2 c){return a*b+c;}
float fma1(float a,float b,float c){return a*b+c;}
vec3 pc3(vec3 x,float a,float b){return clamp(x,a,b);}
// fp16 half-register truncation (RSX runs the fragment shader in half-float; emulates FragmentProgram50's clamp16()).
float T1(float v){ return uFp16>0.5 ? unpackHalf2x16(packHalf2x16(vec2(v,0.0))).x : v; }
vec2  T2(vec2  v){ return uFp16>0.5 ? unpackHalf2x16(packHalf2x16(v)) : v; }
vec3  T3(vec3  v){ return uFp16>0.5 ? vec3(unpackHalf2x16(packHalf2x16(v.xy)), unpackHalf2x16(packHalf2x16(vec2(v.z,0.0))).x) : v; }
void main(){
  vec4 tc1=vec4(vL,1.0), tc7=vec4(vN,1.0);
  vec3 sd = normalize(vSph);   // seamless cube-map sample direction (replaces per-patch tile UVs)
  vec4 r0=vec4(0.),r1=vec4(0.),r2=vec4(0.),r3=vec4(0.),r4=vec4(0.);
  vec4 h0=vec4(0.),h1=vec4(0.),h2=vec4(0.),h3=vec4(0.),h4=vec4(0.),h5=vec4(0.),h6=vec4(0.),h7=vec4(0.);
  r2.xyz = uTiles>0.5 ? texture(tex0, tc0.xy, uBias0).xyz : texture(earthCube, sd).xyz;   // fp: TEX2D(0, tc0.xy); REAL RSX sampler: LOD bias -8.0 (mip0 pinned, live DRAWCALLS)
  h2.xyz = nrm(tc7.xyz);
  r3.xyz = uTiles>0.5 ? texture(tex1, tc0.zw, uBias0).xyz : texture(earthCube, sd).xyz;   // fp: TEX2D(1, tc0.zw); REAL RSX bias -8.0
  r3.xyz = (r3.xyz + -r2.xyz);
  r4.xyz = fma3(tc4.xxx, r3.xyz, r2.xyz);
  h0.xyz = nrm(tc1.xyz);
  h3.z = T1(dot(h2.xyz,h0.xyz)/2.0);   // fp 696: clamp16
  r0.z = (dot(-h2.xyz,h0.xyz)*2.0);
  r1.w = (h3.z + fc[0].x);
  r0.xyz = fma3(-h0.xyz, r0.zzz, -h2.xyz);
  h1.zw = T2(tc8.zw);   // fp 700: clamp16
  r3.xyz = (-r4.xyz + fc[1].xyz);
  r2.x = ((uTiles>0.5 && uT2bad<0.5) ? texture(tex2, tc8.zw, uBias2).x : texture(cloudsCube, sd).x);   // fp: TEX2D(2, tc8.zw); REAL RSX bias -0.1562
  h7.w = T1(fma1(r2.x, fc[2].x, fc[2].y));   // fp 703: clamp16
  r2.x = (uTiles>0.5 ? texture(tex3, tc8.xy).x : texture(maskCube, sd).x);     // fp: TEX2D(3, tc8.xy)
  r1.xyz = fma3(r2.xxx, r3.xyz, r4.xyz);
  r4.zw = tc9.xy;
  r4.y = fc[3].y;
  h5.xyz = (r1.xyz * fc[4].x);
  r3.xy = tc6.xy;
  r4.x = fc[5].y;
  r1.xy = fma2(r3.xy, h7.ww, h1.zw);
  r1.xyz = ((uTiles>0.5 && uT2bad<0.5) ? texture(tex2, r1.xy, uBias2).xyz : texture(cloudsCube, sd).xyz);   // fp: TEX2D(2, r1.xy); REAL RSX bias -0.1562
  h7.xyz = T3(r1.xyz * fc[6].z);   // fp 713: clamp16
  h7.w = T1(r2.x);   // fp 714: clamp16
  h6.xyz = T3(-h5.xyz + fc[7].w);   // fp 715: clamp16
  h5.xyz = T3(fma3(h7.xyz, h6.xyz, h5.xyz));   // fp 716: clamp16
  h7.z = dot(r0.xyz, fc[8].xyz);
  r0.xy = fma2(r4.zw, fc[9].xx, h1.zw);
  r0.xyz = ((uTiles>0.5 && uT2bad<0.5) ? texture(tex2, r0.xy, uBias2).xyz : texture(cloudsCube, sd).xyz);   // fp: TEX2D(2, r0.xy); REAL RSX bias -0.1562
  h0.xyz = pc3(fma3(-r1.xyz, fc[10].xxx, r0.xyz), 0.,1.);
  h0.w = T1(fc[11].y);   // fp 721: clamp16
  r0.zw = fc[12].xy;
  r2.x = texture(tex6, h7.zw).y;   // fp: TEX2D(6).x = env/specular BRDF LUT (ocean sun-glint). TEXDUMP of the 0xbf format stores its single channel in G (R/B all-zero, verified); the firmware's RSX remap reads it via .x -> sample .y here. Reading .x was all-zero => the glint never rendered.
  float gGlint=r2.x;   // DEBUG: the glint BRDF sample (uDbg>5.5 isolates it)
  h1.xyz = fma3(r1.www, fc[13].xyz, vec3(r0.z,r0.w,r0.w));
  r3.x = fc[14].x;
  r4.z = fc[15].y;
  r3.y = fc[16].x;
  r3.z = fc[17].x;
  vec2 _t3=tc3.xy; if(uT3Flip>0.5) _t3.y=1.0-_t3.y;   // per-scene illumination V-flip (lit-direction repair; present-A/B'd)
  r1 = mix(texture(tex4, _t3), texture(tex4b, _t3), uT4Mix);   // bin crossfade (smooth terminator)
  h6.xyz = fma3(-r1.www, r3.xyz, r4.xyz);
  r4.xyz = texture(tex5, tc5.xy).xyz;
  h6.xyz = T3(r4.xyz * h6.xyz);   // fp 733: clamp16
  h2.xyz = T3(r1.xyz * fc[18].y);   // fp 734: clamp16   (rim-painter isolation PROVED the bright rim is NOT the in-scatter: whole-h2 scaling moved the ring ratio the WRONG way; the rim lives in the IE/cloud/tone grazing terms - task #44)
  h4.xyz = T3(fma3(h1.xyz, r2.xxx, h5.xyz));   // fp 735: clamp16
  h3.xyz = T3(fma3(-h0.xyz, h0.www, fc[19].xxx));   // fp 736: clamp16
  r3.xyz = max(h6.xyz, fc[20].xxx);
  r2.xyz = (h4.xyz * r3.xyz);
  r2.xyz = (fma3(r2.xyz, h3.xyz, h2.xyz) * 8.0);   // VERBATIM: firmware surface fp 506ad546 has this *8 ("* 8.")
  r2.xyz *= uDiscGain;   // per-scene face lift (HDR domain, before BOTH glow-emit & tonemap; saturated rim rolls off) - 'ring too bright' = disc too dark (present-measured 0.6x)
  // firmware globe HDR.mnu tonemap of the HDR scene r2: EXPOSURE 0.789, WHITE LEVEL 3.40918,
  // extended Reinhard, GAMMA 1. Real .mnu params, verified vs the real surface RT (0.65/255).
  vec3 tc = r2.xyz * 0.789;
  float W = 3.40918;
  tc = (tc*(1.0 + tc/(W*W)))/(1.0 + tc);
  // VERBATIM ramp encode = the firmware surface fp's actual output (its HDR tonemap LUT, tex14/tex15;
  // the UV clamp on r2 rolls off highlights -> bright close scenes stay dark, not blown white).
  float maxlum = T1(max(r2.x, r2.y));   // fp 741: h3.w (half)
  vec4 r0d = texture(tex13, gl_FragCoord.xy/32.0);   // backbuffer/dither (black -> 0)
  // VERBATIM firmware: tex14/tex15 are Y16_X16_FLOAT which CANNOT be remapped on real hw -> RPCS3 forces
  // remap to YXXX (captured remap=0x0000aae4 -> low byte 0x66). So texture().rgb = X (all three), .a = Y.
  // fp reads tex15.xy=(X,X) -> R=G; tex14.zw=(X,Y) -> B,A. X = the LUT's ch1 (the .y channel as I store it;
  // the channel that carries the tonemap, measured 0.589 vs ch0~0). uLutScale=1/128 (UNNORMALIZED LUT).
  // remap 0x0000aae4 -> channel_map (2,1,2,1) with native (ch0=Y,ch1=X): fp reads tex15.xy=(R,G)=(ch1,ch0),
  // tex14.zw=(B,A)=(ch1,ch0). So R=tex15.ch1(.y), G=tex15.ch0(.x), B=tex14.ch1(.y). Validated R<G<B vs presents.
  vec2 e15 = texture(tex15, r2.xy*uLutScale).xy;                 // (.x=ch0, .y=ch1)
  vec2 e14 = texture(tex14, vec2(T1(r2.z), maxlum)*uLutScale).xy;    // fp 742/745: tex14 sampled at (clamp16(r2.z), h3.w); tex15 (above) uses full r2.xy   // (.x=ch0 -> A, .y=ch1 -> B)
  float X14 = e14.y;                                             // ch1 -> B
  // firmware: col0 = backbuffer(tex13)*fc21 + LUT. The web has no prev-frame feedback (tex13~0), so apply the
  // STEADY-STATE fixed point col0 = LUT/(1-fc21) (exact for a static frame; fc21=fc22=0.125 real). uFeedback toggles it.
  vec4 col0 = vec4(0.);
  float fb21 = (uFeedback>0.5) ? (1.0/(1.0-fc[21].x)) : 1.0;
  float fb22 = (uFeedback>0.5) ? (1.0/(1.0-fc[22].x)) : 1.0;
  col0.x = fma1(r0d.x, fc[21].x, e15.y) * fb21;   // R = tex15.ch1
  col0.y = fma1(r0d.y, fc[21].x, e15.x) * fb21;   // G = tex15.ch0
  col0.z = fma1(r0d.z, fc[22].x, X14) * fb22;     // B = tex14.ch1
  col0.w = fma1(r0d.w, fc[22].x, e14.x) * fb22;   // A = tex14.ch0 (the display HDR-exponent channel: ~1 dark -> ~0 bright; feeds the encode's rgb*a*8)
  if(uExpFix>0.5){ float dmag=max(max(col0.x,col0.y),col0.z); float hmag=max(maxlum, max(r2.x,max(r2.y,r2.z))); col0.w = clamp(1.0 - hmag/(dmag*8.0+1e-3), 0.0, 1.0); }  // a=1-HDR/(display*8); matches real acdc80000.A to <0.02
  if(uLimbSoft>0.0){   // display-space highlight knee: compress the part above 0.65 so the blown 255 limb wall becomes the real's soft ~0.88 band (atmospheric spread, idx 0); dark interior (<0.65) untouched
    vec3 ov=max(col0.xyz-0.65,0.0);
    col0.xyz=0.65 + ov/(1.0+uLimbSoft*ov);
  }
  if(uDbg>5.5){ ocol0=vec4(gGlint, clamp(h7.z*0.5+0.5,0.,1.), clamp(h7.w,0.,1.), 1.0); return; }  // DBG: glint BRDF sample (R), sun-reflect dot h7.z (G), land mask h7.w (B)
  if(uDbg>4.5){ ocol0=vec4(length(vSph), vClip.w/16.0, vClip.y/16.0+0.5, 1.0); return; }  // DBG: |vSph| (R, should be 1.0), d0.w (G), d0.y (B)
  if(uDbg>3.5){ float ny=vClip.y/vClip.w; ocol0=vec4((ny+8.0)/16.0, vClip.w/16.0, 0.0, 1.0); return; }  // DBG: raw d0 ndc.y (encoded) + w
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
  if(uMode>0.5){ ocol0 = vec4(col0.xyz, (uCovAlpha>0.5)?1.0:clamp(col0.w,0.0,1.0)); return; }      // uCovAlpha: write COVERAGE=1 over the earth (dst-alpha mask) instead of the HDR exponent; A exponent otherwise
  ocol0 = vec4(clamp(tc,0.0,1.0), 1.0);
}`;
// ---- VERBATIM ATMOSPHERE SHELL (vp 3f6eeb47 + fp 63d3246d), ported 1:1 from globe_atmo_real.html ----
// ---- BASE EARTH LAYER (limb-notch backfill) ----
// At a grazing camera (scene-0 late timeline) the outer ring of each per-patch spline mesh foreshortens to
// sub-pixel screen height and rasterizes no fragments, leaving ragged BLACK notches cut into the earth's
// silhouette (the patches only tile the near hemisphere; cull/depth/despeckle cannot fill a hole that opens
// to the sky). This draws ONE continuous unit sphere FIRST, using the IDENTICAL c260..c263 MVP the patches
// project with, so its silhouette aligns exactly (no halo). The patches draw on top and fully cover it on
// non-grazing frames (zero regression); only the notches reveal it. Color = earthCube albedo * sun day/night
// (fc8, object space) -> a smooth earth-toned fill instead of black. (Approximation allowed for this gap.)
const BASE_VS=`#version 300 es
precision highp float;
in vec3 in_dir;
uniform vec4 c260,c261,c262,c263; uniform float uFlipY; uniform float uDbgProj; uniform float uBaseScale;
out vec3 vDir;
void main(){
  vDir=in_dir;
  if(uDbgProj>0.5){ gl_Position=vec4(in_dir.xy*0.9, 0.0, 1.0); return; }   // DBG: raw sphere dirs as clip xy (disc at screen center)
  vec4 p=vec4(in_dir*uBaseScale,1.0);   // uBaseScale slightly >1 grows the base silhouette past the patch limb to catch edge notches
  vec4 clip=vec4(dot(p,c260),dot(p,c261),dot(p,c262),dot(p,c263));
  vec2 ndc=clip.xy/clip.w; vec2 win=ndc*vec2(960.0,-540.0)+vec2(960.0,540.0);
  clip.xy=((win/vec2(960.0,540.0))-1.0)*clip.w; clip.z=clip.z*2.0-clip.w; clip.y*=uFlipY;
  gl_Position=clip;
}`;
const BASE_FS=`#version 300 es
precision highp float;
in vec3 vDir; out vec4 ocol0;
uniform samplerCube uEarthCube; uniform vec3 uSun; uniform float uBaseGain;
void main(){
  vec3 alb=texture(uEarthCube, normalize(vDir)).xyz;
  float nl=clamp(dot(normalize(vDir), normalize(uSun))*0.85+0.30, 0.04, 1.0);  // day/night terminator (fc8 sun)
  ocol0=vec4(alb*nl*uBaseGain, 1.0);
}`;
const A_VS=`#version 300 es
precision highp float;
in vec4 in_pos; in vec4 in_tc0;
uniform vec4 mvp0,mvp1,mvp2,mvp3; uniform float uFlipY; uniform vec3 c5,c6,c7,c8;
out vec2 vTC; out vec4 vRay;
void main(){
 float A=1.0/sqrt(max(dot(c8,c8),1e-10));float w=in_pos.w;float B=sqrt(max((1.0/A)*(1.0/A)-w*w,1e-10));
 float s=A*w*w,t=A*B*w; vec3 r0=s*c5+t*(in_tc0.z*c7+in_tc0.w*c6); vTC=in_tc0.xy;
 vRay=vec4(r0-c8,1.0);   // eye-space view ray (shell point minus eye); the real fp's tc1*w
 vec4 p=vec4(r0,1.0); vec4 clip=vec4(dot(p,mvp0),dot(p,mvp1),dot(p,mvp2),dot(p,mvp3));
 vec2 ndc=clip.xy/clip.w; vec2 win=ndc*vec2(960.0,-540.0)+vec2(960.0,540.0);
 clip.xy=((win/vec2(960.0,540.0))-1.0)*clip.w; clip.z=0.0; clip.y*=uFlipY; gl_Position=clip;
}`;
const A_FS=`#version 300 es
precision highp float;
in vec2 vTC; in vec4 vRay; out vec4 ocol0; uniform sampler2D tex0; uniform vec4 fc[17]; uniform float uLinear; uniform float uAtmoHdr;
uniform sampler2D tex0b; uniform float uA0Mix;   // bracketing limb-LUT crossfade
uniform float uLimbGain;   // per-scene ring-ratio calibration vs the real presents
uniform sampler2D aTex14; uniform sampler2D aTex15; uniform float uALut;   // the per-scene tone LUTs for the VERBATIM display tail (fp 63d3246d)
uniform float uAtmoReal;   // 1 = REAL music-globe whole-earth scatter (f566cf05 verbatim); 0 = legacy timezone limb math
uniform vec2 uWposBias; uniform float uWposScale;   // screen-space optical-depth sample (real fp uses gl_FragCoord)
uniform sampler2D tex1;    // f566cf05 OD LUT (== tex0 RT, the dim in-scatter)
uniform float uWposH;      // framebuffer height for the get_wpos y-flip (H - fragY)
uniform float uRcpZero;    // RSX rcp(0) resolution: 1 -> 0 (OD term drops), 0 -> large-finite ramp
uniform float uF566;       // 1 = use the verbatim f566cf05 branch (TEST/iterating); 0 (default) = the shipped 63d3246d math (no thick band)
float pc(float x,float a,float b){return (x!=x)?0.:clamp(x,a,b);} float fma1(float a,float b,float c){return a*b+c;}
float bsqrt(float x){return sqrt(abs(x));}
vec3 bdivsq3(vec3 a,float b){vec3 t=a/bsqrt(b);return mix(a,t,vec3(greaterThan(abs(a),vec3(0.0))));}
float bdivsq1(float a,float b){float t=a/bsqrt(b);return (abs(a)>0.0)?t:a;}
vec4 clamp16f(vec4 v){return vec4(unpackHalf2x16(packHalf2x16(v.xy)),unpackHalf2x16(packHalf2x16(v.zw)));}
void main(){
 if(uF566>0.5){
   // VERBATIM f566cf05 (FragmentProgram52 = the REAL music-globe atmosphere; CONFIRMED via RPCS3 shaderlog:
   // every 4-sampler atmosphere shader uses get_wpos/screen-space scatter; the old 63d3246d/exp2 path is NOT
   // in the shaderlog = not what runs). Inputs (RE workflow): tex0==tex1==the DIM in-scatter (CAP_LIMB, ~0.55,
   // NOT the bright scatterTex), V=the view ray (vRay), wpos=(fragX, H-fragY), scene-0 consts c3=c7=275.837
   // (finite), c16=2.176. The OD term (tex1 @ screen) is UNIFORM for sc0 (fc6=[1,0,0,0] clamps the coord to a
   // corner); the whole-earth haze comes from tex0@vTC (dim in-scatter, densest at limb) * the view-ray
   // coverage R0.w. rcp(0) at the R1.w branch (fc11.y=0): RSX-resolve = 0 so the OD-derived line zeros out
   // (uRcpZero), leaving scatter*coverage (the sensible, non-blown result); uRcpZero=0 tests the large-finite.
   vec4 wpos = vec4(gl_FragCoord.x, uWposH - gl_FragCoord.y, gl_FragCoord.z, gl_FragCoord.w);
   vec3 V = vec3(0.0);   // RE workflow: the real vp 3f6eeb47 (=VP105) outputs tc1=vec4(0,0,0,1) -> V=tc1*w=0. RPCS3 renders correctly with this, so V=0 is faithful; the V-derived coverage terms collapse to constants and the limb-densest falloff comes from tex0(dim in-scatter)@vTC.
   vec4 R0=vec4(0.),R1=vec4(0.),R2=vec4(0.),H2=vec4(0.);
   R0.z=dot(V,V);
   R0.x=1.0/fc[0].x;
   R1.w=fc[1].w;
   R1.xyz=bdivsq3(V,R0.z);
   R1.w=R1.w+fc[2].w;
   R0.z=dot(R1.xyz,-fc[3].xyz);
   R0.y=1.0/fc[4].y;
   R1.xyz=R1.xyz*R0.z+fc[5].xyz;
   R0.xy=wpos.xy*R0.xy;
   R1.w=1.0/R1.w;
   R0.w=dot(R1.xyz,R1.xyz);
   R0.xy=-R0.xy*fc[6].xy+abs(fc[6].zx);
   R0.xyz=texture(tex1,R0.xy*vec2(1.0/1920.0,1.0/1080.0)).xyz;   // OD LUT (tex1) @ screen coord (clamp -> uniform corner for sc0)
   R1.xyz=-R0.xyz+fc[7].xxx;
   R1.xyz=(-R0.xyz*R1.xyz+R1.xyz)*0.25;
   R2.w=(R0.y*fc[8].y+R1.y)*4.0;
   R1.z=(R0.z*fc[9].y+R1.z)*4.0;
   R2.x=bdivsq1(abs(R0.w),R0.w);
   R0.w=(R0.x*fc[10].y+R1.x)*4.0;
   R1.x=bdivsq1(abs(R0.w),R0.w);
   R0.w=clamp((R2.x*R1.w-R1.w)*2.0,0.0,1.0);
   R1.y=bdivsq1(abs(R2.w),R2.w);
   R1.w=fc[11].y;
   R1.w=R1.w*fc[12].w;
   R2.xyz=R0.w*(vec3(1.0)-fc[13].xyz);
   R1.z=bdivsq1(abs(R1.z),R1.z);
   R0.xyz=R0.xyz+R1.xyz;
   R0.w=(R1.w!=0.0)?(1.0/R1.w):uRcpZero;   // RSX rcp(0) effective value (the OD-term scatter scale; fit to the real limb falloff)
   R0.xyz=clamp16f(vec4(R0.xyz*R0.w-R0.w,0.0)).xyz;
   R0.xyz=R0.xyz/fc[15].x;
   R2.xyz=R2.xyz+fc[16].x;
   R1.xyz=mix(texture(tex0,vTC),texture(tex0b,vTC),uA0Mix).xyz;   // scatter color (dim in-scatter) @ mesh tc
   R0.xyz=(R1.xyz*R2.xyz+R0.xyz)*8.0;
   R0.xyz=R0.xyz*uLimbGain;
   if(uLinear>0.5){ ocol0=vec4(R0.xyz,1.0); return; }
   H2.z=clamp16f(R0).z;
   H2.w=max(R0.x,R0.y);
   vec2 E15=texture(aTex15,R0.xy*(1.0/128.0)).xy;
   vec2 E14=texture(aTex14,vec2(H2.z,H2.w)*(1.0/128.0)).xy;
   ocol0=vec4(E15.y,E15.x,E14.y,clamp(fc[14].x,0.0,1.0));   // dual-LUT encode (R=t15.ch1,G=t15.ch0,B=t14.ch1); A=fc14.x
   return;
 }
 vec4 tc0=vec4(vTC,0.,1.);vec4 r0=vec4(0.),r1=vec4(0.),r2=vec4(0.),r3=vec4(0.);
 r1.x=fc[0].x;r1.z=fc[0].z;r1.y=1.0/fc[1].z;r0.x=fc[2].w;r0.y=fc[2].z;r0.w=(-r0.y+fc[3].x);r1.xyz=tc0.xyz*r1.xyz;
 r3.y=pc(r0.w/-fc[4].z,0.,1.);r0.w=fc[5].w;r3.x=(-r0.w+fc[6].x);r3.w=r3.y*r3.y;r2.w=r3.y*2.;
 r2.y=pc(fc[7].x/r0.x,0.,1.);r2.x=r2.y*r2.y;r1.w=r2.y*2.;r0.xyz=mix(texture(tex0,r1.xy),texture(tex0b,r1.xy),uA0Mix).xyz;
 r1.x=(-r1.x*fc[8].x);r1.z=(r1.y+-fc[9].w);r3.x=pc(r1.z/r3.x,0.,1.);r3.z=(-r1.w+fc[10].x);r3.y=r2.x*r3.z;r0.w=r1.x*fc[11].x;
 r1.x=pc(r1.y/fc[12].y,0.,1.);r1.w=(-r2.x+fc[13].x);r2.x=fma1(r3.w,r1.w,-r3.y);r1.w=r1.x*2.;r1.w=(-r1.w+fc[14].x);r1.x=r1.x*r1.x;r1.x=r1.x*r1.w;
 r1.w=r3.x*2.;r1.w=(-r1.w+fc[15].x);r1.y=r3.x*r3.x;r1.y=r1.y*r1.w;r0.w=exp2(r0.w);r0.w=r2.x*r0.w;
 r0.xyz=r0.xyz*fc[16].x;r0.xyz=(-r1.y*r0.xyz+r0.xyz);r0.w=(-r1.x*r0.w+r0.w);r0.xyz=((r0.w*r0.xyz+r0.xyz)*uAtmoHdr*uLimbGain);
 if(uLinear>0.5){ ocol0=vec4(r0.xyz,1.0); return; }   // GLOW path: emit linear HDR atmo so it feeds the bloom
 if(uALut>0.5){
   // VERBATIM display tail (fp 63d3246d): rgb = HDR*8 -> dual tone-LUT encode (R=t15.ch1(8R,8G),
   // G=t15.ch0, B=t14.ch1(8B,max(8R,8G))); alpha = the raw scatter factor r0.w. No feedback term.
   vec3 r8 = r0.xyz*8.0;
   vec2 s15 = texture(aTex15, r8.xy*(1.0/128.0)).xy;
   vec2 s14 = texture(aTex14, vec2(r8.z, max(r8.x,r8.y))*(1.0/128.0)).xy;
   ocol0 = vec4(s15.y, s15.x, s14.y, clamp(r0.w,0.0,1.0));
   return;
 }
 vec3 tcol=r0.xyz*0.789; float Wl=3.40918; tcol=(tcol*(1.0+tcol/(Wl*Wl)))/(1.0+tcol);
 ocol0=vec4(clamp(tcol,0.0,1.0),clamp(r0.w,0.0,1.0));   // fallback tonemap when no per-scene LUTs
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
uniform sampler2D uSprite; uniform float uGlow2; uniform vec2 uDims;
uniform vec4 c260,c261,c262,c263; uniform vec4 gfc[17];
uniform sampler2D uLut15,uLut14; uniform float uLutOn,uLutExpo,uLutFb;   // real surface-fp LUT tonemap (the gold warmth); uLutFb = backbuffer feedback 1/(1-fc21)
uniform float uPassthru;   // faithful path: uEarth is ALREADY the LDR display scene (col0 earth + tonemapped limb) -> just add the limb/sun bloom, NO re-tonemap
uniform float uDespeckle;  // 1 = fill the thin patch-seam dark gaps at the limb (sub-pixel coverage holes)
uniform float uEarthGain;  // display weight in the faithful composite: out = display*(1-FC1) + bloom*FC0 (fp 59b46122: fma(-disp,FC1,bloom*FC0) additive). 1.0 everywhere else.
float gdivsq(float a,float b){return a/sqrt(abs(b)+1e-12);}
vec3 computeGlare(){
  vec2 ndc=vUV*2.0-1.0;
  vec3 ray=cross(c260.xyz-ndc.x*c263.xyz, c261.xyz-ndc.y*c263.xyz);
  if(dot(c263.xyz,ray)<0.0) ray=-ray;
  vec4 r0=vec4(0.),r1=vec4(0.),r2=vec4(0.);
  r0.z=dot(ray,ray);
  r0.x=1.0/uDims.x; r1.w=gfc[1].x;
  r1.xyz=ray/sqrt(abs(r0.z)+1e-12);
  r1.w=r1.w+gfc[2].x;
  r0.z=dot(r1.xyz,-gfc[3].xyz);
  r0.y=1.0/uDims.y;
  r1.xyz=r1.xyz*r0.z+gfc[5].xyz;
  r0.xy=gl_FragCoord.xy*vec2(r0.x,r0.y);
  r1.w=1.0/r1.w;
  r0.w=dot(r1.xyz,r1.xyz);
  r0.xy=-r0.xy*gfc[6].xy+abs(vec2(gfc[6].z,gfc[6].x));
  r0.xyz=texture(uEarth,r0.xy).xyz;
  r1.xyz=(-r0.xyz+gfc[7].x);
  r1.xyz=(-r0.xyz*r1.xyz+r1.xyz)/4.0;
  r2.w=(r0.y*gfc[8].y+r1.y)*4.0;
  r1.z=(r0.z*gfc[9].y+r1.z)*4.0;
  r2.x=gdivsq(abs(r0.w),r0.w);
  r0.w=(r0.x*gfc[10].y+r1.x)*4.0;
  r1.x=gdivsq(abs(r0.w),r0.w);
  r0.w=clamp((r2.x*r1.x-r1.x)*2.0,0.0,1.0);
  r1.y=gdivsq(abs(r2.w),r2.w);
  r1.w=gfc[11].y*gfc[12].w;
  r2.xyz=r0.www*(-gfc[13].xyz)+r0.www;
  r1.z=gdivsq(abs(r1.z),r1.z);
  r0.xyz=r0.xyz+r1.xyz;
  r0.w=1.0/r1.w;
  r0.xyz=r0.xyz*r0.www-r0.www;
  r0.xyz=r0.xyz/gfc[15].x;
  r2.xyz=r2.xyz+gfc[16].xyz;
  vec3 spr=texture(uSprite,vUV).xyz;
  return max((spr*r2.xyz+r0.xyz)*8.0, 0.0);
}
void main(){
  vec4 e4 = texture(uEarth, vUV);
  vec3 e = e4.xyz;
  if(uDespeckle>0.5){
    // Fill the thin DARK SEAM/DASH gaps at the earth limb. The dense base sphere fills the BIG sky-opening
    // notches; what remains at the grazing limb is thin near-black DASHES sitting INSIDE the bright limb glow
    // (bright on BOTH sides). Bracket at STEPPED distance up to 12px; the moment a near-black center is
    // straddled by BRIGHT earth/limb on both sides of one axis, fill from that bracket. Bright-on-both-sides is
    // the dash signature: the black SKY above the limb is bright on only ONE side, so it is never filled; real
    // dark features (terminator) are L>0.05.
    vec2 px=vec2(1.0/uDims.x,1.0/uDims.y);
    int dd[8]=int[8](1,2,3,4,6,8,10,12);
    float L=dot(e,vec3(0.333)); bool filled=false;
    // Only NEAR-BLACK centers (the gap = the black FBO clear, L~0) - never dim clouds/terminator (L>0.05).
    if(L<0.05){
      for(int k=0;k<8;k++){
        if(filled) break; float d=float(dd[k]);
        vec3 eL=texture(uEarth,vUV-vec2(px.x*d,0.0)).xyz, eR=texture(uEarth,vUV+vec2(px.x*d,0.0)).xyz;
        float Lh=min(dot(eL,vec3(0.333)),dot(eR,vec3(0.333)));
        if(Lh>0.10){ e=(eL+eR)*0.5; filled=true; }
      }
      for(int k=0;k<8;k++){
        if(filled) break; float d=float(dd[k]);
        vec3 eU=texture(uEarth,vUV-vec2(0.0,px.y*d)).xyz, eD=texture(uEarth,vUV+vec2(0.0,px.y*d)).xyz;
        float Lv=min(dot(eU,vec3(0.333)),dot(eD,vec3(0.333)));
        if(Lv>0.10){ e=(eU+eD)*0.5; filled=true; }
      }
    }
  }
  vec3 g = texture(uGlow,  vUV).xyz;
  // Additive bloom in LINEAR HDR, then the firmware globe HDR.mnu tonemap applied PER CHANNEL
  // (extended Reinhard, EXPOSURE 0.789, WHITE 3.40918 -- the same real .mnu params as the surface fp's
  // ENC0 path). Per-channel => the BLUE earth albedo is PRESERVED (measured real present lit-side
  // B/G=1.11). This replaces the wrong golden-luminance composite (which collapsed e to a single
  // intensity and re-cast it warm R>G>B -- not what the firmware does; see project_globe_ground_truth).
  // VERBATIM firmware composite (RSX fp 316de80a): out = scene*0.125 + bloom(full weight),
  // then *0.789 decode exposure (HDR.mnu). scene*0.125*0.789 = scene*0.0986 -> surface stays at
  // the validated 0.65/255; bloom restored to FULL weight (the dominant haze the firmware adds).
  if(uPassthru>0.5){ float eg=(abs(uEarthGain)<1e-6)?1.0:uEarthGain; vec3 base=e*eg + g*uGlowGain;
    if(uGlow2>0.5){
      // verbatim sun-glare ADD (the real c868fd6a draw blends ONE,ONE into the display): the fp's
      // linear output goes through the same dual tone-LUT display encode as every display writer.
      vec3 r8=computeGlare();
      vec2 s15=texture(uLut15, r8.xy*(1.0/128.0)).xy;
      vec2 s14=texture(uLut14, vec2(r8.z,max(r8.x,r8.y))*(1.0/128.0)).xy;
      base += vec3(s15.y,s15.x,s14.y);
    }
    ocol0 = vec4(clamp(base, 0.0, 1.0), clamp(e4.w,0.0,1.0)); return; }   // faithful: LDR scene + limb/sun bloom; α carries the display exponent through to the encode. Unset (0) uEarthGain behaves as 1 so legacy sites need no change.
  if(uGlow2>0.5) e = e + computeGlare();   // legacy path: linear add pre-tonemap (fp 727d0242), gated
  if(uLutOn>0.5){
    // VERBATIM firmware surface-fp LUT tonemap = THE GOLD WARMTH (measured: LUT(real r2)=gold 1:0.90:0.17).
    // R,G = tex15(hc.xy); B = tex14(hc.z, max(hc.x,hc.y)).x. hc = earth exposed to the firmware r2 range
    // (~0..0.3) via uLutExpo (matched-scene calibration vs ac18c0000: web r2 p50 1.02 -> firmware 0.10 => ~0.1).
    vec3 hc = e * uLutExpo;   // per-scene faithful: uLutExpo=1/128 (UN-flag scale)
    float ml = max(hc.x, hc.y);
    vec2 e15 = texture(uLut15, clamp(hc.xy, 0.0, 0.999)).xy;   // .x=ch0, .y=ch1
    float bz = texture(uLut14, clamp(vec2(hc.z, ml), 0.0, 0.999)).y;   // ch1 -> B
    // firmware remap 0x0000aae4: R=tex15.ch1, G=tex15.ch0, B=tex14.ch1; uLutFb = backbuffer feedback 1/(1-fc21)
    vec3 disp = vec3(e15.y, e15.x, bz) * uLutFb;
    ocol0 = vec4(clamp(disp + g * uGlowGain, 0.0, 1.0), 1.0);   // + additive limb/sun bloom
    return;
  }
  // ---- VERBATIM firmware post-proc composite ----
  // The PS3 Gaia pipeline (earth.qrc draws 1-95, ecl2 capture) tonemaps the SCENE to display in the
  // surface/atmosphere shaders (8beeea83/2060b02 -> 0e500000), then ADDS the glare bloom ON TOP at full
  // weight (59b4612/316de80a, blend ONE,ONE: display += glare). It does NOT fold the bloom into the
  // tonemap. The glare is the bloom of a BRIGHT-PASS (GlareSource 56200844/fp_061fd0), so only the
  // over-display-range energy (the sun-rising point) blooms warm -- the cyan limb stays cyan, and the
  // dramatic warm sunrise glow is a localized additive, not a whole-arc white-blow.
  //   1) scene tonemap : extended Reinhard per channel, EXPOSURE=uSlum (HDR.mnu 0.789/8), WHITE 3.40918.
  //   2) glare add     : + bloom(brightpass) * uGlowGain  (uGlowGain = GLARE LEVEL / web-bloom-norm).
  vec3 L = e * uSlum;
  float W = 3.40918;
  vec3 toned = (L*(1.0 + L/(W*W)))/(1.0 + L);
  ocol0 = vec4(clamp(toned + g * uGlowGain, 0.0, 1.0), 1.0);
}`;
// ---- VERBATIM GlareSource bright-pass (RSX fp 0x0619a0 family = lib/glutils GlareSource, the canonical
//      threshold form). Extracts ONLY the over-display-range energy that the glare blooms:
//        glare = max( extReinhard(scene * _Exposure) - _Threshold , 0 )
//      with the SAME extended-Reinhard as the display tonemap (Exposure, WhiteSqrRcp) then -_Threshold,
//      clamp>=0 (decompiled fp_0619a0: MADH H0=H2*H0 - _Threshold; MAXR R0=H0,0). _Threshold = the
//      per-scene HDR.mnu GLARE THRESH (default 0.552855). This is what keeps the warm sunrise localized
//      (only the bright sun-point exceeds threshold and blooms) -- the cyan limb mid-tones do NOT bloom.
//      Operates on the LINEAR HDR scene (uEarth) with the same exposure as the composite tonemap.
const GS_FS=`#version 300 es
precision highp float; precision highp sampler2D;
uniform sampler2D uTone; uniform float uSlum; uniform float uThresh;
in vec2 vUV; out vec4 ocol0;
void main(){
  vec3 L = texture(uTone, vUV).xyz * uSlum;          // scene * Exposure (0.789/8)
  float W = 3.40918;                                  // WHITE LEVEL (HDR.mnu) ; _WhiteSqrRcp = 1/W^2
  vec3 toned = (L*(1.0 + L/(W*W)))/(1.0 + L);          // extended Reinhard (same as the display tonemap)
  vec3 glare = max(toned - uThresh, 0.0);             // GlareSource: subtract GLARE THRESH, clamp >=0
  ocol0 = vec4(glare, 1.0);                            // over-range energy only -> feeds the bloom pyramid
}`;
// ---- VERBATIM display-encode bright-pass (RSX fp 0xbd9c5fac654464cb = 0xbc48008a, frame 82800 d017:
//      the FIRST post pass each frame; reads THE DISPLAY (earth+limb+burst, LDR+exponent-alpha) and
//      emits the bloom-pyramid source: rgb = display.rgb*display.a*8 (HDR decode), w = the sqrt-curve
//      bright-pass key. Real consts (d017 const[0..7]): FC0=1 FC1..4=0.13828 FC5=2 FC6=0.881311
//      FC7=(0.27,0.67,0.06). Derived closed form per channel c:
//        key = dot( (c + sqrt(0.55312*c + (1-c)^2) - 1) / (FC4*FC5) / FC6 , FC7.rgb )
//      key(0)=0, key(1)~3.05 -- a soft knee that replaces the legacy threshold form for the
//      bloom-of-display path (this is what builds the eclipse BURST corona: the white wash =
//      pyramid(encode(display)) * 0.125 added back, d053 const[1]=0.125).
// VERBATIM bloom encode (the bd9c5fac/bc48008a/dacc11b7 family, 8 consts, 512x540 viewport):
// PROVEN by the live write-graph (d026 reads the PRE-BLOOM display 0xdc80000 -> 0x18c0000 ->
// plain-copy downsample into the mip atlas -> blur -> 8 additive combines smallest-first into
// the accumulator 0x2560000 -> composite). out.rgb = display.rgb * display.a * 8 -- the display
// ALPHA (tone-LUT ch0: 0.005 mid-tones, 0.59 extremes; atmo scatter term at the limb; 1 in sky)
// IS the bright-pass key. out.w = the sqrt-curve key (UNUSED downstream: copy/blur/combine
// consume rgb only).
const ENC_FS=`#version 300 es
precision highp float; precision highp sampler2D;
uniform sampler2D uDisp;            // the PRE-BLOOM display (earth+limb composite, alpha = exponent channel)
uniform vec4 uEFC[8];               // the encode draw's REAL per-frame const[0..7]
in vec2 vUV; out vec4 ocol0;
void main(){
  vec4 r1 = texture(uDisp, vUV);
  r1 = clamp(mix(vec4(0.0), r1, equal(r1,r1)), 0.0, 64.0);   // NaN-scrub (NaN!=NaN -> pick 0) + clamp Inf: a stray NaN in the HALF_FLOAT display (f566 atmo rcp(0) / surface div) would bilinearly spread through the bloom pyramid to a full-frame white-out. The real RSX fp16 emits finite values; sanitize to match.
  vec3 c  = r1.rgb;
  vec3 q  = (vec3(uEFC[0].x) - c);                      // FC0 - r1
  q = (q - c*q) / 4.0;                                  // (FC0-c)*(1-c)/4
  vec3 t = vec3(c.r*uEFC[1].x, c.g*uEFC[2].x, c.b*uEFC[3].x) + q;
  vec3 r2v = sqrt(max(t*4.0, 0.0));                     // divsq = sqrt
  vec3 dec = c * (r1.a*8.0);                            // rgb * alpha * 8 (the real key)
  float rcp45 = 1.0/(uEFC[4].x*uEFC[5].x);
  vec3 u = (c + r2v) * rcp45 - rcp45;
  u /= uEFC[6].x;
  float key = dot(u, uEFC[7].xyz);
  ocol0 = vec4(dec, key);
}`;
// ---- VERBATIM in-scatter upsample (fps 69a20e74 seedA / 48b46d4c seedB, identical dataflow):
//      LUT-weighted 4-tap bicubic upsample via the captured BicubicTable (x=minus-off, y=plus-off,
//      z=minus-w, w=plus-w; 128 texels per phase period, REPEAT), then the gain h0*(1+sat(h0*4/3)/3).
//      Both quads span tc 0..1; By = tc.y*fc1.z (A: 0.2 -> the seed's top band; B: 1.0). u-taps have
//      no y-offset and v-taps no x-offset (fc5.x=0) - literal decompile asymmetries. PSNR 63.7/65.4 dB.
const IPUP_FS=`#version 300 es
precision highp float; precision highp sampler2D;
uniform sampler2D uSeed; uniform sampler2D uTable;
uniform vec2 uFc0; uniform float uFc1z; uniform float uFc4y;
in vec2 vUV; out vec4 ocol0;
void main(){
  float Bx = vUV.x;
  float By = vUV.y * uFc1z;
  vec4 r2 = texture(uTable, vec2(Bx*uFc0.x - 0.5, 0.5));
  vec4 r3 = texture(uTable, vec2(By*uFc0.y - 0.5, 0.5));
  float um = Bx - r2.x*0.025, up = Bx + r2.y*0.025;
  float vm = By - r3.x*uFc4y, vp = By + r3.y*uFc4y;
  vec4 h1 = r3.w*texture(uSeed, vec2(um,vp)) + r3.z*texture(uSeed, vec2(um,vm));
  vec4 h4 = texture(uSeed, vec2(up,vp))*r3.w + r3.z*texture(uSeed, vec2(up,vm));
  vec4 h0 = h4*r2.w + r2.z*h1;
  vec4 r1 = clamp(h0*1.33333, 0.0, 1.0);
  ocol0 = r1*0.33333*h0 + h0;
}`;
// ---- VERBATIM horizon combine (fp 4dd03757 = lib_atm_atm_horiz.fpo): blend bufB toward bufA's
//      CONSTANT ROW V=0 with a smoothstep band at v in [0.86, 1.0] (fc0=0.14 HORIZ BLEED, fc4=3).
//      Alpha = bufB passthrough. PSNR 68.0 dB vs the live GPU bufC.
const IPCOMB_FS=`#version 300 es
precision highp float; precision highp sampler2D;
uniform sampler2D uB; uniform sampler2D uA;
in vec2 vUV; out vec4 ocol0;
void main(){
  float t = clamp((vUV.y - 0.86)/0.14, 0.0, 1.0);
  float w = t*t*(3.0 - 2.0*t);
  vec4 c = texture(uB, vUV);
  vec3 arow = texture(uA, vec2(vUV.x, 0.5/128.0)).xyz;
  ocol0 = vec4(c.rgb + w*(arow - c.rgb), c.a);
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
 const im=new Image();im.onload=function(){if(!gl)return;gl.bindTexture(3553,t);gl.texImage2D(3553,0,6408,6408,5121,im);gl.texParameteri(3553,10241,9729);gl.texParameteri(3553,10240,9729);gl.texParameteri(3553,10242,33071);gl.texParameteri(3553,10243,33071);got++;};im.onerror=function(){got++;};im.src=src;return t;}
// mipmapped variant for the per-patch earth tiles: trilinear min filter kills the minification
// shimmer/aliasing at patch boundaries (the firmware tiles are mipmapped). 512x512 = power of two.
function texPNGmip(src,aniso){const t=gl.createTexture();gl.bindTexture(3553,t);gl.texImage2D(3553,0,6408,1,1,0,6408,5121,new Uint8Array([0,0,0,255]));want++;
 const im=new Image();im.onload=function(){if(!gl)return;gl.bindTexture(3553,t);gl.texImage2D(3553,0,6408,6408,5121,im);gl.generateMipmap(3553);gl.texParameteri(3553,10241,9987);gl.texParameteri(3553,10240,9729);gl.texParameteri(3553,10242,33071);gl.texParameteri(3553,10243,33071);
  // REAL RSX per-slot max-anisotropy (live DRAWCALLS, timezone+music globe both): t00/t01=8x, t02=2x, t03=1x
  if(aniso&&aniso>1){const ext=gl.getExtension('EXT_texture_filter_anisotropic');
   if(ext){const mx=gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT);gl.texParameterf(3553,ext.TEXTURE_MAX_ANISOTROPY_EXT,Math.min(aniso,mx));}}
  got++;};im.onerror=function(){got++;};im.src=src;return t;}
function texF32(src,w,h,opt){const t=gl.createTexture();gl.bindTexture(3553,t);gl.texImage2D(3553,0,34836,1,1,0,6408,5126,new Float32Array([0,0,0,1]));if(!opt)want++;
 fetch(src).then(r=>{if(!r.ok)throw 0;return r.arrayBuffer();}).then(ab=>{if(!gl)return;gl.bindTexture(3553,t);gl.texImage2D(3553,0,34836,w,h,0,6408,5126,new Float32Array(ab));gl.texParameteri(3553,10241,9729);gl.texParameteri(3553,10240,9729);gl.texParameteri(3553,10242,33071);gl.texParameteri(3553,10243,33071);t.loaded=true;if(!opt)got++;}).catch(()=>{if(!opt)got++;});return t;}
// fp16 float texture (RGBA16F internalformat=34842, filterable in WebGL2) for the real HDR tonemap LUTs
function texF16(src,w,h,opt){const t=gl.createTexture();gl.bindTexture(3553,t);gl.texImage2D(3553,0,34842,1,1,0,6408,5126,new Float32Array([0,0,0,1]));if(!opt)want++;
 fetch(src).then(r=>{if(!r.ok)throw 0;return r.arrayBuffer();}).then(ab=>{if(!gl)return;gl.bindTexture(3553,t);gl.texImage2D(3553,0,34842,w,h,0,6408,5126,new Float32Array(ab));gl.texParameteri(3553,10241,9729);gl.texParameteri(3553,10240,9729);gl.texParameteri(3553,10242,33071);gl.texParameteri(3553,10243,33071);t.loaded=true;if(!opt)got++;}).catch(()=>{if(!opt)got++;});return t;}
function blackTex(){const t=gl.createTexture();gl.bindTexture(3553,t);gl.texImage2D(3553,0,6408,1,1,0,6408,5121,new Uint8Array([0,0,0,255]));return t;}
function black0Tex(){const t=gl.createTexture();gl.bindTexture(3553,t);gl.texImage2D(3553,0,6408,1,1,0,6408,5121,new Uint8Array([0,0,0,0]));return t;}
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
   }};})(s,im); im.onerror=function(){got++;};   // count failed faces so a lost request can never freeze ready() (cube stays placeholder; nface untouched so mipmap only builds when all 6 truly load)
   im.src=BASE+prefix+'_face'+CUBE_SLOTS[s]+'.png';}
 return t;}

function buildVC(corners){const s=D.shared;const vc=new Float32Array(104);const set=(i,a)=>{vc[i*4]=a[0];vc[i*4+1]=a[1];vc[i*4+2]=a[2];vc[i*4+3]=a[3];};
 set(0,corners[0]);set(1,corners[1]);set(2,corners[2]);
 const map={3:260,4:261,5:262,6:263,7:264,8:265,9:268,10:269,11:270,12:454,13:455,14:456,15:457,16:458,17:459,18:460,19:461,20:462,21:463,22:464,23:465,24:466,25:467};
 for(const k in map){const v=s[map[k]];if(v)set(+k,v);}return vc;}
function bindT(unit,name,tex){gl.activeTexture(33984+unit);gl.bindTexture(3553,tex);gl.uniform1i(gl.getUniformLocation(prog,name),unit);}
// ---- PER-SCENE in-scatter: nearest captured scene + lazy-load of its EARTH + LIMB LUTs ----
// Score = dot(sun, s.sun) [-1..1, dominant] - W*|attn_A - s.attn_A| [secondary]. sun-direction match
// dominates (the scattering geometry is set by the sun azimuth/elevation); ATTN_ATM (the atmosphere
// density multiplier) breaks ties between same-direction captures (e.g. eclipse vs daytime same sun).
function pickScene(sun,attn){
 if(!INSCAT_MANIFEST||!INSCAT_MANIFEST.scenes) return null;
 const sl=Math.hypot(sun[0],sun[1],sun[2])||1; const sx=sun[0]/sl,sy=sun[1]/sl,sz=sun[2]/sl;
 const aA=(attn&&attn.length>1)?attn[1]:0;
 let best=null,bestScore=-1e9;
 for(const s of INSCAT_MANIFEST.scenes){
   const d=sx*s.sun[0]+sy*s.sun[1]+sz*s.sun[2];
   const score=d - INSCAT_PICK_W*Math.abs(aA - (s.attn?s.attn[1]:0));
   if(score>bestScore){ bestScore=score; best=s; }
 }
 return best;
}
// lazy-load (and cache) a scene's EARTH lut (ac6f80000, surface tex4) + LIMB lut (ac6e80000, atmo tex0).
function loadSceneTex(s){
 if(!s) return null;
 let c=INSCAT_CACHE[s.name];
 if(!c){ c={lut:s.lut?texF32(BASE+s.lut,INSCAT_MANIFEST.w,INSCAT_MANIFEST.h):null,
            limb:s.limb_lut?texF32(BASE+s.limb_lut,INSCAT_MANIFEST.w,INSCAT_MANIFEST.h):null};
   INSCAT_CACHE[s.name]=c; }
 return c;
}
// resolve the per-scene atmosphere injection (atmo_mvp -> 256-259, atmo_basis -> 460/461/462) for the limb.
function sceneAtmoFrame(s){
 if(!s||!s.atmo_mvp||!s.atmo_basis) return null;
 const f={t:0.0};
 f['256']=s.atmo_mvp[0]; f['257']=s.atmo_mvp[1]; f['258']=s.atmo_mvp[2]; f['259']=s.atmo_mvp[3];
 f['460']=s.atmo_basis['460']; f['461']=s.atmo_basis['461']; f['462']=s.atmo_basis['462'];
 return f;
}
// load the per-scene atmo fp consts into fcAtmo (atmo_fc{0..16}) when per-scene mode picks this scene.
function applySceneFcAtmo(s){
 if(!s||!s.atmo_fc||!fcAtmo) return;
 for(const k in s.atmo_fc){ const i=+k,a=s.atmo_fc[k]; fcAtmo[i*4]=a[0];fcAtmo[i*4+1]=a[1];fcAtmo[i*4+2]=a[2];fcAtmo[i*4+3]=a[3]; }
 FCATMO_OVR=1;
}
// Decide the in-scatter binding for THIS draw: returns {tex4, scat, frame, name} where tex4 = the surface
// in-scatter LUT, scat = the atmosphere limb LUT, frame = the per-scene atmo injection (or null). When
// per-scene mode is on, picks the nearest captured scene from the current sun (fc[8]) + attn (fc[4]).
let _psFrame=null, _psScat=null, _psSurfTex=null;
// cap set: select the captured in-scatter+limb LUT textures for the current scene at the nearest
// captured frame to the current playback position (real per-scene LUTs; null for scenes not yet captured).
// STICKY per-scene LUT selection + lookahead prefetch. The plain lazy load returned null until the
// nearest bin arrived, silently swapping in the STATIC fallback assets (captured from a DIFFERENT
// scene) and toggling the limb on/off -> flicker / objects popping / cross-scene asset mismatch,
// worst on the slow LFS media endpoint. Now: prefetch the playhead bin + LUT_LOOKAHEAD upcoming
// bins, and while the exact-nearest bin is still in flight HOLD the last LOADED bin of the same
// scene (else the last loaded of any scene; the dip-to-black scene fade covers that brief hold).
const LUT_LOOKAHEAD=8;
let LUT_XFADE=0;   // 0 = use the NEAREST in-scatter bin (no within-scene crossfade). The crossfade BLENDS two
                   // spatially-offset LUT bins, which SMEARS the bright limb/lighting at mix~0.5 -> a 38% bright<->dim
                   // OSCILLATION at the bin rate (~6s) = the "day<->night-red flicker" (user 2026-06-11). The bins
                   // themselves are only ~3% apart within a scene, so nearest is stable AND faithful (a real bin, not
                   // an interpolation). MPGlobe.lutxfade=1 restores the crossfade.
let _lutStick={}, _toneStick={};   // SAME-SCENE sticky only: never show another scene's lighting (a cross-scene hold made scene boundaries render a mismatched limb glow). Until the scene's own first bin arrives the in-path static fallback is used (and no limb).
let SCENE_HAS_TONE=true;           // per-scene faithful-path gate (set in setFC)
let SCENE_SKIP=new Set();          // degenerate (static-artifact) scene indices, skipped in the cycle
function _nearestIdx(list,fr){ let bi=0; for(let i=1;i<list.length;i++){ if(Math.abs(list[i].fr-fr)<Math.abs(list[bi].fr-fr)) bi=i; } return bi; }
// CONTINUOUS bin bracket: find ia = the LAST bin with fr<=playhead, ib=ia+1, mix=frac.
// Guarantees C0 continuity across bin boundaries (at a bin: mix=1 of [ia,ib] == mix=0 of
// [ib,ib+1] == bin[ib]). The old _nearestIdx+conditional had an off-by-one that left a
// residual STEP at row boundaries (sc0 t=0.25 brightness/color pop, user 'keeps changing').
function _bracket(list,fr){
 let ia=0;
 for(let i=0;i<list.length;i++){ if(list[i].fr<=fr) ia=i; else break; }
 const ib=Math.min(ia+1,list.length-1);
 const span=(list[ib].fr-list[ia].fr)||1;
 const mix=(ib>ia)?Math.min(1,Math.max(0,(fr-list[ia].fr)/span)):0;
 return {ia,ib,mix};
}
function capSceneLut(si, t, frOpt){
 if(!CAP_SCENE_LUTS||!SCENES_IDX||!SCENES_IDX[si]) return null;
 const s=SCENES_IDX[si]; const list=CAP_SCENE_LUTS[String(s.scene)];
 if(!list||!list.length) return null;
 const fr=(frOpt!==undefined)?frOpt:(s.frame0 + t*((s.frame1-s.frame0)||1));
 const br=_bracket(list,fr);
 // NEAREST bin (no crossfade) by default: blending two spatially-offset bins smears the limb -> bright/dim flicker.
 const ia=LUT_XFADE?br.ia:_nearestIdx(list,fr), ib=LUT_XFADE?br.ib:ia, mix=LUT_XFADE?br.mix:0;
 for(let k=0;k<=LUT_LOOKAHEAD && ia+k<list.length;k++){ const e=list[ia+k];
   if(!CAP_LUT_CACHE[e.fr]) CAP_LUT_CACHE[e.fr]={surf:texF32(lfsURL(e.surf),256,128,true), limb:texF32(lfsURL(e.limb),256,128,true)}; }
 const A=CAP_LUT_CACHE[list[ia].fr], B=CAP_LUT_CACHE[list[ib].fr];
 if(A&&A.surf.loaded&&A.limb.loaded){
   const r={surf:A.surf,limb:A.limb,surfB:null,limbB:null,mix:0};
   if(LUT_XFADE&&ib>ia&&B&&B.surf.loaded&&B.limb.loaded){ r.surfB=B.surf; r.limbB=B.limb; r.mix=mix; }
   _lutStick[String(s.scene)]=r; return r;
 }
 return _lutStick[String(s.scene)]||null;
}
// cap set: select this scene's REAL surface-fp tonemap LUT (tex14/tex15) at the nearest captured frame.
function capSceneTone(si, t, frOpt){
 if(!CAP_SCENE_TONE||!SCENES_IDX||!SCENES_IDX[si]) return null;
 const s=SCENES_IDX[si]; const list=CAP_SCENE_TONE[String(s.scene)];
 if(!list||!list.length) return null;
 // PER-SCENE-STABLE tone: the captured tone bins alternate between two states (double-buffer
 // sampling artifact), so mid-scene swaps POP the display brightness (user report idx 4).
 // Hold the scene's first loaded tone pair for the whole scene.
 const stick=_toneStick[String(s.scene)];
 if(stick) return stick;
 const fr=(frOpt!==undefined)?frOpt:(s.frame0 + t*((s.frame1-s.frame0)||1));
 const bi=_nearestIdx(list,fr);
 for(let k=0;k<=LUT_LOOKAHEAD && bi+k<list.length;k++){ const e=list[bi+k];
   if(!CAP_TONE_CACHE[e.fr]) CAP_TONE_CACHE[e.fr]={t14:texF16(lfsURL(e.t14),128,128,true), t15:texF16(lfsURL(e.t15),128,128,true)}; }
 const c=CAP_TONE_CACHE[list[bi].fr];
 if(c.t14.loaded&&c.t15.loaded){ _toneStick[String(s.scene)]=c; return c; }
 return _toneStick[String(s.scene)]||null;
}
// pick + lazy-load the nearest recovered seed pair for (scene, fr); swaps texSeedA/B when it changes.
function seedCap3(si, t, frOpt){
 if(!SEED_MANIFEST||!SCENES_IDX||!SCENES_IDX[si]) return false;
 const s=SCENES_IDX[si]; const list=SEED_MANIFEST[String(s.scene)];
 if(!list||!list.length) return false;
 const fr=(frOpt!==undefined)?frOpt:(s.frame0 + t*((s.frame1-s.frame0)||1));
 let best=list[0]; for(const e of list){ if(Math.abs(e.fr-fr)<Math.abs(best.fr-fr)) best=e; }
 if(!SEED_CACHE[best.fr]) SEED_CACHE[best.fr]={scene:s.scene,
   A:texF32(lfsURL('gaia_lut/seeds_cap3/seedA_f'+String(best.fr).padStart(6,'0')+'.bin'),40,40,1),
   B:texF32(lfsURL('gaia_lut/seeds_cap3/seedB_f'+String(best.fr).padStart(6,'0')+'.bin'),40,20,1)};
 const c=SEED_CACHE[best.fr];
 if(c.A.loaded&&c.B.loaded){ if(_seedCur!==c){ texSeedA=c.A; texSeedB=c.B; _seedCur=c; } return true; }
 return !!(_seedCur && _seedCur.scene===s.scene);   // hold ONLY within the same scene; never leak across scenes
}
function resolveInscat(){
 _psFrame=null; _psScat=null; _psName=null;
 if(!INSCAT_PS||!INSCAT_MANIFEST){ return; }
 const fcsrc=curFC||(D&&D.fc); if(!fcsrc||!fcsrc[8]||!fcsrc[4]) return;
 const sun=fcsrc[8], attn=fcsrc[4];
 const s=pickScene(sun,attn); if(!s) return;
 _psName=s.name;
 const c=loadSceneTex(s);
 if(c&&c.lut) _psSurfTex=c.lut; else _psSurfTex=null;
 if(c&&c.limb){ _psScat=c.limb; }
 _psFrame=sceneAtmoFrame(s);
 applySceneFcAtmo(s);
 // per-scene mode drives the limb from the picked scene (unless an eclipse override is active). Mark the
 // ATMO_SCENE as auto-managed so it is refreshed every frame when the picked scene changes.
 if(_psFrame&&!INSCAT_ECL){ ATMO_SCENE=[_psFrame,Object.assign({},_psFrame,{t:1})]; ATMO_SCENE._auto=true; ATMO=1; }
}
// ECLIPSE-ORIENTATION discriminator (firmware RT viewport-Y). The eclipse RT renders the earth disc at the
// BOTTOM of the frame with the warm limb arc at the top (measured vs the ecl2 present: earth NDC center y
// =+1.78, radius 2.0). The verbatim VS's hardcoded win-remap (960,-540) y-flip + uFlipY=+1 places it at the
// TOP instead -> the eclipse needs the INVERTED viewport-Y (uFlipY=-1) on BOTH the surface earth AND the
// atmosphere limb so they stay registered (the prior agent flipped only the limb -> earth ended up on the
// wrong side, the arc floating in empty space). Daytime (front-lit) keeps uFlipY=+1. The discriminator is
// geometric (camera-frame-locked, no scene names): an eclipse is back-lit -- the sun is roughly behind the
// earth from the camera, dot(viewDir, sunDir) > 0.5. ecl2=+1.00 (eclipse), warm2=-0.92 (daytime).
function isEclipseView(){
 if(INSCAT_ECL) return true;                 // manual eclipse override always eclipse-oriented
 if(!D||!D.shared||!D.shared['263']) return false;
 const fcsrc=curFC||D.fc; const sun=fcsrc&&fcsrc[8]; if(!sun) return false;
 const v=D.shared['263']; const vl=Math.hypot(v[0],v[1],v[2])||1, sl=Math.hypot(sun[0],sun[1],sun[2])||1;
 const d=(v[0]*sun[0]+v[1]*sun[1]+v[2]*sun[2])/(vl*sl);
 return d>0.5;
}
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
let hdrFBO2=null;   // 2nd depth-HDR FBO: the limb/sun HDR bloom SOURCE (faithful path keeps it separate from the LDR display)
function ensureHDR2(W,H){
 if(hdrFBO2 && hdrFBO2.w===W && hdrFBO2.h===H) return hdrFBO2;
 if(hdrFBO2){ gl.deleteFramebuffer(hdrFBO2.fbo); gl.deleteTexture(hdrFBO2.tex); gl.deleteRenderbuffer(hdrFBO2.depth); }
 const tex=gl.createTexture(); gl.bindTexture(3553,tex);
 gl.texImage2D(3553,0,gl.RGBA16F,W,H,0,6408,gl.HALF_FLOAT,null);
 gl.texParameteri(3553,10241,9729);gl.texParameteri(3553,10240,9729);
 gl.texParameteri(3553,10242,33071);gl.texParameteri(3553,10243,33071);
 const depth=gl.createRenderbuffer(); gl.bindRenderbuffer(36161,depth);
 gl.renderbufferStorage(36161,gl.DEPTH_COMPONENT16,W,H);
 const fbo=gl.createFramebuffer(); gl.bindFramebuffer(36160,fbo);
 gl.framebufferTexture2D(36160,36064,3553,tex,0);
 gl.framebufferRenderbuffer(36160,36096,36161,depth);
 gl.bindFramebuffer(36160,null);
 hdrFBO2={fbo,tex,depth,w:W,h:H}; return hdrFBO2;
}
// color-only RGBA16F RT (no depth) for the post-proc passes (tonemap / bright-pass)
function ensureColorRT(ref,W,H){
 if(ref.cur && ref.cur.w===W && ref.cur.h===H) return ref.cur;
 if(ref.cur){ gl.deleteFramebuffer(ref.cur.fbo); gl.deleteTexture(ref.cur.tex); }
 const tex=gl.createTexture(); gl.bindTexture(3553,tex);
 gl.texImage2D(3553,0,gl.RGBA16F,W,H,0,6408,gl.HALF_FLOAT,null);
 gl.texParameteri(3553,10241,9729);gl.texParameteri(3553,10240,9729);
 gl.texParameteri(3553,10242,33071);gl.texParameteri(3553,10243,33071);
 const fbo=gl.createFramebuffer(); gl.bindFramebuffer(36160,fbo);
 gl.framebufferTexture2D(36160,36064,3553,tex,0);
 gl.bindFramebuffer(36160,null);
 ref.cur={fbo,tex,w:W,h:H}; return ref.cur;
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
// ===== FAITHFUL STARS (firmware) =====
// The firmware (qgl_gaia_app vaddr 0x31fa0) tiles the real star texture earth/flashrom/face_neg_z_ul.dds
// (1024x1024 BC1, ~30k dots) onto a 6-face star CUBE and samples it by VIEW DIRECTION (rotation-only
// parallax). NOT a catalog of positions. We replicate: a cube (all faces = the real star texture) sampled
// per-pixel by the camera-rotated view ray = the inverse of the proven STAR_VS projection. Brightness =
// EARTH.mnu STARS WHITENESS (0.217) * STARS FACTOR (per-scene). Replaces the (wrong) catalog point sprites.
// STAR CUBE SKYBOX (firmware method): a unit cube around the camera, each face textured with the real star
// tile (texcoord 0..uTile, REPEAT) -> minified+mipmapped so most of the gray band averages away, leaving
// sparse crisp ~1px stars. Per-face interpolated texcoords have smooth derivatives -> NO fan/LOD streaks.
// Projection = the validated direction->NDC map (ndcx=c260.d/c263.d, ndcy=-c261.d/c263.d), same as the sun disc.
const STARTEX_VS=`#version 300 es
in vec3 inPos; in vec2 inTC;
uniform vec4 c260,c261,c263; uniform float uTile;
out vec2 vTC; out vec3 vDir;
void main(){ vec3 d=normalize(inPos); float w=dot(c263.xyz,d);
 gl_Position=vec4(dot(c260.xyz,d), -dot(c261.xyz,d), w*0.999999, w);   // far depth; w<0 (behind) -> clipped
 vDir=d; vTC=inTC*uTile; }`;
const STARTEX_FS=`#version 300 es
precision highp float; in vec2 vTC; in vec3 vDir; out vec4 ocol0;
uniform sampler2D starTex; uniform float uWhite; uniform float uPow;
uniform vec3 uEye;             // camera eye in scene space (the c460 row) for the earth occlusion
uniform vec4 c260,c261,c263;   // the SURFACE camera rows (shared with the VS): per-pixel ray reconstruction
uniform vec2 uVP; uniform float uDbg;
uniform vec4 uE2[8]; uniform float uE2On;   // the VERBATIM star-brightness fp (775efaf5/ae34439d family) per-frame consts
void main(){
 vec3 tx=texture(starTex, vTC).rgb;   // REPEAT + mipmaps; smooth per-face UV -> hardware LOD, no streaks
 vec3 st;
 if(uE2On>0.5){
   // VERBATIM star brightness (the harvested per-frame enc2 consts): desat toward the channel
   // average (FC0=1/3, FC1) -> *FC2.y -> per-channel exp2(*8.64386) -> *(FC5.x*FC7.x ~5e-6) *8.
   float lum=tx.r+tx.g+tx.b;
   vec3 c=(lum*uE2[0].x-tx)*uE2[1].x+tx;
   c*=uE2[2].y;
   vec3 e=exp2(vec3(c.r*uE2[3].x, c.g*uE2[4].x, c.b*uE2[6].x));
   st=(uE2[5].x*uE2[7].x)*e*8.0;
 } else {
   // EARTH.mnu star curve fallback: pow(tex, STARS POWSCALE) * STARS WHITENESS.
   st=pow(max(tx,0.0), vec3(uPow))*uWhite;
 }
 // OCCLUDE by the earth GEOMETRICALLY, in the SURFACE camera's own space (the skybox vertex
 // direction lives in a flipped basis - unusable for this test). The pixel's world ray direction
 // = the intersection line of its two camera planes: ndc.x=(c260.P)/(c263.P) and
 // ndc.y=-(c261.P)/(c263.P) (the surface renders with uFlipY=-1), so
 // d = cross(c260.xyz - ndc.x*c263.xyz, -c261.xyz - ndc.y*c263.xyz), sign-fixed to point in
 // front of the camera (dot(c263.xyz,d)>0). Occluded iff the ray from the eye (c460) hits the
 // unit earth sphere: b=dot(E,d)<0 and b^2-(|E|^2-1)>=0. Exact; replaces the display-alpha mask
 // (the surface writes the REAL firmware display alpha, not coverage - and night-side earth
 // alpha clamps to 0, so thresholding cannot work either).
 vec2 ndc=vec2(2.0*gl_FragCoord.x/uVP.x-1.0, 1.0-2.0*gl_FragCoord.y/uVP.y);   // y mirrored: the earth reaches the canvas through the FBO+composite flip; stars draw direct
 vec3 d=cross(c260.xyz-ndc.x*c263.xyz, -c261.xyz-ndc.y*c263.xyz);
 if(dot(c263.xyz,d)<0.0) d=-d;
 d=normalize(d);
 float b=dot(uEye,d), cc=dot(uEye,uEye)-1.0;
 if(cc<0.1){ ocol0=vec4(st,1.0); return; }   // eye inside/at the unit sphere = degenerate occlusion row (sc11-class artifact guard)
 if(uDbg>0.5){ ocol0=vec4((b<0.0&&b*b-cc>=0.0)?vec3(1.0,0.0,0.0):vec3(0.0,0.3,0.0),1.0); return; }
 if(b<0.0 && b*b-cc>=0.0) st=vec3(0.0);
 ocol0=vec4(st, 1.0);
}`;
function starCubeTex(src){ const t=gl.createTexture(); gl.bindTexture(34067,t);
 for(let s=0;s<6;s++) gl.texImage2D(CUBE_FACE_ENUM[s],0,6408,1,1,0,6408,5121,new Uint8Array([0,0,0,255]));
 want++; const im=new Image(); im.onload=function(){ if(!gl)return;
   gl.bindTexture(34067,t);
   for(let s=0;s<6;s++) gl.texImage2D(CUBE_FACE_ENUM[s],0,6408,6408,5121,im);   // same real star tile on all 6 faces (firmware tiles it)
   gl.texParameteri(34067,10241,9729);gl.texParameteri(34067,10240,9729);
   gl.texParameteri(34067,10242,33071);gl.texParameteri(34067,10243,33071);gl.texParameteri(34067,32882,33071);
   got++; }; im.onerror=function(){got++;}; im.src=src; return t; }
// 2D star texture, REPEAT-wrapped + mipmapped: the firmware tiles this on the cube; tiling -> minification ->
// the mipmap averages most of the gray band down, leaving sparse crisp ~1px stars (see STARTEX_FS uTile).
function star2DTex(src){ const t=gl.createTexture(); gl.bindTexture(3553,t);
 gl.texImage2D(3553,0,6408,1,1,0,6408,5121,new Uint8Array([0,0,0,255]));
 want++; const im=new Image(); im.onload=function(){ if(!gl)return;
   gl.bindTexture(3553,t); gl.texImage2D(3553,0,6408,6408,5121,im);
   gl.texParameteri(3553,10242,10497);gl.texParameteri(3553,10243,10497);   // GL_REPEAT (tiling)
   gl.texParameteri(3553,10240,9729);                                       // mag LINEAR
   gl.texParameteri(3553,10241,9987);                                       // min LINEAR_MIPMAP_LINEAR
   gl.generateMipmap(3553);
   got++; }; im.onerror=function(){got++;}; im.src=src; return t; }
function drawStarsTex(){
 if(!STARTEX||!starTexProg||!starBoxBuf||!star2D||!D) return;
 { const sc=(SCENES_IDX&&SCENES_IDX[sceneIdx])?SCENES_IDX[sceneIdx].scene:sceneIdx; if(STARTEX_SKIP_SCENES.indexOf(sc)>=0) return; }   // bright scenes where the real sky is star-free
 const s=D.shared; if(!s['260']||!s['263']) return;
 if(gl.bindVertexArray)gl.bindVertexArray(null);   // use the default VAO (don't corrupt glowVAO state)
 gl.useProgram(starTexProg); const U=n=>gl.getUniformLocation(starTexProg,n);
 gl.uniform4fv(U('c260'),s['260']);gl.uniform4fv(U('c261'),s['261']||s['260']);gl.uniform4fv(U('c263'),s['263']);
 gl.uniform1f(U('uWhite'),STAR_WHITE); gl.uniform1f(U('uPow'),STAR_POW); gl.uniform1f(U('uTile'),STAR_TILE);
 { let row=null;   // per-frame star-brightness consts (the harvested enc2 rows); STARS2 gate
   if(STARS2 && BLOOM_SCENES && SCENES_IDX && SCENES_IDX[sceneIdx]){
     const rows=BLOOM_SCENES[String(SCENES_IDX[sceneIdx].scene)];
     if(rows&&rows.length){ const sc=SCENES_IDX[sceneIdx]; const fr=sc.frame0+animT*((sc.frame1-sc.frame0)||1);
       row=rows[0]; for(const e of rows){ if(Math.abs(e.fr-fr)<Math.abs(row.fr-fr)) row=e; } } }
   const e2on=(STARS2&&row&&row.enc2)?1:0;
   gl.uniform1f(U('uE2On'),e2on);
   if(e2on){ const f=new Float32Array(32); for(let i=0;i<8;i++) for(let j=0;j<4;j++) f[i*4+j]=row.enc2[i][j];
     gl.uniform4fv(U('uE2'),f); } }
 gl.activeTexture(33984+0); gl.bindTexture(3553,star2D); gl.uniform1i(U('starTex'),0);
 { // EXACT camera eye from the surface rows: the center C solves c260.(C,1)=c261.(C,1)=c263.(C,1)=0
   // (the projective null point), guaranteeing the occlusion disc matches the drawn earth to subpixel.
   const r0=s['260'],r1=s['261'],r3=s['263']; let e=s['460']||[0,0,3,0];
   if(r0&&r1&&r3){
     const a=r0[0],b=r0[1],c=r0[2], d=r1[0],f=r1[1],g=r1[2], h=r3[0],i=r3[1],j=r3[2];
     const det=a*(f*j-g*i)-b*(d*j-g*h)+c*(d*i-f*h);
     if(Math.abs(det)>1e-12){
       const x=-r0[3],y=-r1[3],z=-r3[3];
       e=[ (x*(f*j-g*i)-b*(y*j-g*z)+c*(y*i-f*z))/det,
           (a*(y*j-g*z)-x*(d*j-g*h)+c*(d*z-y*h))/det,
           (a*(f*z-y*i)-b*(d*z-y*h)+x*(d*i-f*h))/det ];
     } }
   gl.uniform3f(U('uEye'),e[0],e[1],e[2]); gl.uniform1f(U('uDbg'),(typeof window!=='undefined'&&window.__starDbg)?1:0);
   gl.uniform2f(U('uVP'),canvas.width,canvas.height); }   // exact eye + viewport for the per-pixel earth occlusion
 gl.bindBuffer(34962,starBoxBuf);
 const pl=gl.getAttribLocation(starTexProg,'inPos'); const tl=gl.getAttribLocation(starTexProg,'inTC');
 gl.enableVertexAttribArray(pl); gl.vertexAttribPointer(pl,3,5126,false,20,0);
 gl.enableVertexAttribArray(tl); gl.vertexAttribPointer(tl,2,5126,false,20,12);
 // EARTH.mnu STARS IN HDR=0 -> add in DISPLAY space (additive, post-tonemap), drowned where the earth is bright.
 gl.disable(2884); gl.disable(2929); gl.depthMask(false); gl.enable(3042); gl.blendFunc(1,1);
 gl.drawArrays(4,0,36);   // star skybox cube (6 faces x 2 tris)
 gl.disable(3042);
 gl.disableVertexAttribArray(pl); gl.disableVertexAttribArray(tl);
}
// ===== ECLIPSE SUN BURST (SunDisc_FP, decompiled verbatim) =====
// A small bright disc at the projected sun, rendered INTO the HDR FBO (after the earth) so the bloom pyramid
// makes the corona (firmware: 24 additive glare passes; validated radial = 3-Gaussian sigma 41/117/304 px).
// glow=exp(|uv.x|*SCALE_X - |uv.y|*SCALE_Y) (the verbatim FP). The earth occludes via the depth buffer
// (geometrically identical to the FP's ray-sphere occlusion: the view ray that hits the unit earth is blocked).
// Color is white -> the composite LUT tonemaps it to warm-white, same as the surface (firmware const8-11={1,1,1,1}).
const SUNDISC_VS=`#version 300 es
uniform vec2 uSunNdc; uniform float uSize; uniform float uAspect; out vec2 vUV;
const vec2 Q[6]=vec2[6](vec2(0.,0.),vec2(1.,0.),vec2(0.,1.),vec2(0.,1.),vec2(1.,0.),vec2(1.,1.));
void main(){ vec2 c=Q[gl_VertexID]; vUV=c;
 vec2 off=(c*2.0-1.0)*uSize; off.x/=uAspect;                 // square in pixels
 gl_Position=vec4(uSunNdc+off, 0.9999, 1.0); }`;             // far depth -> earth occludes
const SUNDISC_FS=`#version 300 es
precision highp float; in vec2 vUV; out vec4 ocol0;
uniform vec2 uScale; uniform float uBri;
void main(){ vec2 uv=vUV-0.5;
 float w=abs(uv.x)*uScale.x - abs(uv.y)*uScale.y;           // SunDisc_FP: |uv.x|*SCALE_X - |uv.y|*SCALE_Y
 float glow=exp(w);                                          // (*1.4427 then EX2) == exp(w)
 ocol0=vec4(vec3(glow*uBri), 1.0); }`;                       // white HDR -> bloom=corona, composite LUT=warm-white
function drawSunDisc(){
 if(!SUNDISC||!sunDiscProg||!D) return;
 const s=D.shared; if(!s['260']||!s['263']) return;
 const fcsrc=curFC||D.fc; const sun=fcsrc&&fcsrc[8]; if(!sun) return;
 const c260=s['260'],c261=s['261']||s['260'],c263=s['263'];
 const d3=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
 const d263=d3(c263,sun); if(d263<=1e-6) return;             // sun behind camera -> no burst
 const ndcx=d3(c260,sun)/d263, ndcy=-d3(c261,sun)/d263;     // proven STAR_VS forward projection of the sun dir
 gl.useProgram(sunDiscProg); const U=n=>gl.getUniformLocation(sunDiscProg,n);
 gl.uniform2f(U('uSunNdc'),ndcx,ndcy);
 gl.uniform2f(U('uScale'),SUN_SCX,SUN_SCY); gl.uniform1f(U('uBri'),SUN_BRI);
 gl.uniform1f(U('uSize'),SUN_SIZE); gl.uniform1f(U('uAspect'),canvas.width/canvas.height);
 gl.disable(2884); if(SUN_NOOCC){gl.disable(2929);}else{gl.enable(2929); gl.depthFunc(515);} gl.depthMask(false);  // earth (closer) occludes; don't write depth
 gl.enable(3042); gl.blendFunc(1,1);                                          // additive into the HDR scene
 gl.drawArrays(4,0,6); gl.disable(3042);
}
// SCENE-TRANSITION fade-to-black. The real globe dips through black between scenes (the user observed it;
// firmware has a BLACK FADE param in atm ATM.mnu). The exact per-scene sequencer timing is NOT dumped, so
// the duration FADE_SECS is an APPROXIMATION (tunable via MPGlobe.fadeSecs) -- flagged, not firmware-exact.
const FADE_VS=`#version 300 es
void main(){ vec2 p=vec2(float((gl_VertexID<<1)&2), float(gl_VertexID&2)); gl_Position=vec4(p*2.0-1.0,0.0,1.0); }`;
const FADE_FS=`#version 300 es
precision highp float; out vec4 ocol0; uniform float uA;
void main(){ ocol0=vec4(0.0,0.0,0.0,uA); }`;   // black with opacity uA (=1-fade) over the rendered frame
function drawFade(fade){
 if(fade>=0.999||!fadeProg) return;
 if(gl.bindVertexArray)gl.bindVertexArray(null);
 gl.useProgram(fadeProg); gl.uniform1f(gl.getUniformLocation(fadeProg,'uA'),Math.min(1,Math.max(0,1.0-fade)));
 gl.disable(2884); gl.disable(2929); gl.depthMask(false);
 gl.enable(3042); gl.blendFunc(770,771);   // SRC_ALPHA, ONE_MINUS_SRC_ALPHA -> black over scene
 gl.drawArrays(4,0,3); gl.disable(3042);
}
function boundaryDip(prevScene){   // the MEASURED dip depth after scene N (present-derived; 1=black, 0=continuous)
 if(!TRANS_TABLE) return 1.0;
 const e=TRANS_TABLE[String(prevScene)];
 return e?Math.min(1,Math.max(0,e.dip)):1.0;
}
function fadeFactor(t,durSecs){   // 1.0 = full scene; 0.0 = black-dip floor per the MEASURED boundary envelope.
 const f=FADE_SECS/Math.max(1,durSecs||SCENE_SECS);   // fade fraction of THIS scene (real duration) at each end
 let raw=1.0;
 let dip=1.0;
 if(t<f){ raw=t/f;
   const prev=SCENES_IDX?((sceneIdx-1+SCENES_IDX.length)%SCENES_IDX.length):null;   // fading IN from the PREVIOUS scene's boundary
   if(prev!==null&&SCENES_IDX[prev]) dip=boundaryDip(SCENES_IDX[prev].scene); }
 else if(t>1.0-f){ raw=(1.0-t)/f;
   if(SCENES_IDX&&SCENES_IDX[sceneIdx]) dip=boundaryDip(SCENES_IDX[sceneIdx].scene); }   // fading OUT toward THIS scene's boundary
 else return 1.0;
 // measured-depth dip: full dip (1.0) = the old behavior; continuous (0) = no fade at all.
 return 1.0-dip*(1.0-Math.min(1,Math.max(0,raw)));
}
// GLOW render path: earth+atmo -> linear-HDR FBO -> buildGlow -> composite CURVE((earthHDR+glow*g)*slum*warmbias) -> canvas.
function drawGlow(){
 const W=canvas.width,H=canvas.height;
 const F=ensureHDR(W,H);
 // 1) render earth patches + atmo into the HDR FBO with the LINEAR-HDR output mode (uMode=5 / uLinear=1).
 gl.bindFramebuffer(36160,F.fbo);
 gl.viewport(0,0,W,H);gl.clearColor(0,0,0,0);gl.clear(16640);gl.enable(2929);gl.depthFunc(515);
 if(!STARTEX)drawStars();               // catalog stars (legacy) into HDR; texture stars are added post-composite (display space)
 if(CULL){gl.enable(2884);gl.cullFace(1029);}else{gl.disable(2884);}
 gl.useProgram(prog);const U=n=>gl.getUniformLocation(prog,n);
 const fcsrc=curFC||D.fc;
 const fc=new Float32Array(23*4); for(let i=0;i<23;i++){const v=fcsrc[i];fc[i*4]=v[0];fc[i*4+1]=v[1];fc[i*4+2]=v[2];fc[i*4+3]=v[3];}
 resolveInscat();   // per-scene: pick nearest scene -> _psSurfTex (earth lut), _psScat (limb lut), _psFrame (atmo inj), fcAtmo
 const eclView=isEclipseView();
 // VIEWPORT-Y: the firmware RSX viewport (scale.y=-540) + WebGL's bottom-left framebuffer origin make the
 // NET firmware->WebGL y-map the IDENTITY (proven: gl_Position.y/w must equal the raw MVP clip.y/w; the
 // win-remap in the VS already negates clip.y, so uFlipY=-1 cancels it -> correct, scene-independent). The
 // old default +1 mirrored the disc vertically (only invisible for near-centred daytime discs; glaring for
 // the eclipse, where the earth sits far below the frame). Verified vs TF gl_Position + ecl2/warm2 presents.
 gl.uniform1f(U('uFlipY'),-1.0);gl.uniform1f(U('uPatchExp'),PATCH_EXP);gl.uniform1f(U('uCovAlpha'),covAlphaOn());
 gl.uniform1f(U('uDbg'),0.0);
 gl.uniform1f(U('uMode'),5.0);          // linear HDR earth scene (r2.xyz)
 gl.uniform1f(U('uSlum'),SLUM);
 gl.uniform1f(U('uLutScale'),LUTSCALE); gl.uniform1f(U('uFeedback'),FEEDBACK_PS);
 gl.uniform4fv(U('fc'),fc);
 const surfTex4 = ((INSCAT_GEN&&_ipValid&&_ipC.cur)?_ipC.cur.tex:null) || CAP_LUT || ((INSCAT_PS&&_psSurfTex) ? _psSurfTex : ((INSCAT_ECL&&sharedTex.tex4ecl)?sharedTex.tex4ecl:sharedTex.tex4));
 const surfTex4B=(surfTex4===CAP_LUT&&CAP_LUTB)?CAP_LUTB:surfTex4; const t4mix=(surfTex4===CAP_LUT&&CAP_LUTB)?CAP_MIX:0.0;
 bindT(4,'tex4',surfTex4);bindT(9,'tex4b',surfTex4B);gl.uniform1f(U('uT4Mix'),t4mix);gl.uniform1f(U('uLimbGain2'),limbGainAt());bindT(5,'tex5',(IEFULL&&sharedTex.ieFull)?sharedTex.ieFull:sharedTex.tex5);bindT(6,'tex6',sharedTex.tex6);
 bindT(7,'tex14',CAP_T14||sharedTex.tex14);bindT(8,'tex15',CAP_T15||sharedTex.tex15);bindT(9,'tex13',black0||black);
 gl.uniform1f(U('uTiles'),TILES);
 const bindCube=(unit,name,tex)=>{gl.activeTexture(33984+unit);gl.bindTexture(34067,tex);gl.uniform1i(U(name),unit);};
 bindCube(10,'earthCube',sharedTex.earthCube);bindCube(11,'cloudsCube',sharedTex.cloudsCube);bindCube(12,'maskCube',sharedTex.maskCube);
 const pl=gl.getAttribLocation(prog,'in_pos');gl.bindBuffer(34962,eMesh.pb);gl.enableVertexAttribArray(pl);gl.vertexAttribPointer(pl,4,5126,false,0,0);
 gl.bindBuffer(34963,eMesh.ib);
 // uFlipY=-1 inverts the screen-space winding -> invert the per-patch frontFace so back-face cull still
 // removes the FAR hemisphere (else it shows the fully-lit back side = the bright-earth bug). This is now
 // unconditional (matches the unconditional uFlipY=-1 viewport fix above).
 const wflip = -1;
 if(!ATMO_ONLY&&!STARSONLY) for(let i=0;i<D.patches.length;i++){
   gl.frontFace(windSign(D.patches[i].corners)*wflip<0?2304:2305);
   const pt=patchTex[D.patches[i].idx];
   if(pt){ bindT(0,'tex0',pt[0]);bindT(1,'tex1',pt[1]);bindT(2,'tex2',pt[2]);bindT(3,'tex3',pt[3]); }
   gl.uniform1f(U('uT2bad'), (T2ALL||BADT2.has(D.patches[i].idx))?1.0:0.0);
   gl.uniform1f(U('uBias0'),BIAS0);gl.uniform1f(U('uBias2'),BIAS2);gl.uniform1f(U('uT3Flip'),(FAITH_POLICY&&FAITH_POLICY.t3flip&&SCENES_IDX&&SCENES_IDX[sceneIdx]&&FAITH_POLICY.t3flip.indexOf(SCENES_IDX[sceneIdx].scene)>=0)?1.0:(window.__t3f||0));gl.uniform1f(U('uDiscGain'),discGainAt());gl.uniform1f(U('uLimbSoft'),limbSoftAt());gl.uniform1f(U('uFp16'),FP16);gl.uniform1f(U('uExpFix'),(ATMO_REAL||(typeof window!=='undefined'&&window.__expfix))?1.0:0.0);
   gl.uniform4fv(U('vc'),buildVC(D.patches[i].corners));gl.drawElements(4,eMesh.n,5123,0);}
 gl.disable(2884);
 // (per-scene limb atmo frame is set in resolveInscat -> ATMO_SCENE auto-managed)
 // 1b) atmosphere limb additively INTO the HDR FBO (linear HDR), so it both feeds the bloom and gets
 //     tonemapped together with the earth -- the faithful pipeline. The per-channel composite no longer
 //     warm-biases, so the limb's Rayleigh blue survives (no need for the old separate canvas pass).
 if((ATMO||ATMO_ONLY)&&aMesh&&scatterTex&&!STARSONLY) drawAtmoLinear();
 // 1c) eclipse sun-disc burst into the HDR FBO (bright, occluded by the earth) so the bloom builds the corona.
 if(!STARSONLY) drawSunDisc();
 // 2) VERBATIM firmware glare pipeline: GlareSource bright-pass (fp_0619a0 = extReinhard(scene*Exp) -
 //    GLARE THRESH, clamp>=0) so only over-display-range energy (the sun-rising point) blooms, then bloom
 //    the BRIGHT-PASS (not the raw HDR scene). This keeps the warm sunrise localized (no whole-arc
 //    white-blow) and the cyan limb mid-tones out of the bloom. The display scene tonemap stays in C_FS.
 gl.disable(2929);gl.disable(3042);gl.disable(2884);
 gl.bindVertexArray(glowVAO);
 const GR=ensureColorRT(_gsRef,W,H);
 gl.bindFramebuffer(36160,GR.fbo);gl.viewport(0,0,W,H);
 gl.useProgram(gsProg);
 gl.activeTexture(33984+0);gl.bindTexture(3553,F.tex);gl.uniform1i(gl.getUniformLocation(gsProg,'uTone'),0);
 gl.uniform1f(gl.getUniformLocation(gsProg,'uSlum'),GLOW_SLUM*0.125);     // EXPOSURE 0.789/8
 gl.uniform1f(gl.getUniformLocation(gsProg,'uThresh'),GLARE_THRESH);      // HDR.mnu GLARE THRESH
 gl.drawArrays(4,0,3);
 gl.bindVertexArray(null);
 // 2b) bloom the BRIGHT-PASS (the verbatim downsample/upsample pyramid, globe_glow.js)
 gl.bindFramebuffer(36160,null);
 const glow=GlobeGlow.buildGlow(gl, GR.tex, W, H);
 _lastGlow=glow;
 // 3) composite earthHDR + glow through the firmware CURVE onto the canvas.
 gl.bindFramebuffer(36160,null);
 gl.viewport(0,0,W,H);gl.disable(2929);gl.disable(3042);gl.disable(2884);
 gl.useProgram(cprog);const C=n=>gl.getUniformLocation(cprog,n);
 gl.activeTexture(33984+0);gl.bindTexture(3553,F.tex);gl.uniform1i(C('uEarth'),0);
 gl.activeTexture(33984+1);gl.bindTexture(3553,glow.tex);gl.uniform1i(C('uGlow'),1);
 gl.uniform1f(C('uSlum'),GLOW_SLUM*0.125);  // EXPOSURE 0.789 / 8 (undo the surface fp's r2 *8) into the per-channel ext-Reinhard
 gl.uniform3fv(C('uGlowGain'),new Float32Array(GLOW_GAIN));
 gl.activeTexture(33984+2);gl.bindTexture(3553,glowSprite||black);gl.uniform1i(C('uSprite'),2);
 gl.uniform1f(C('uGlow2'),GLOW2); gl.uniform2f(C('uDims'),W,H); gl.uniform1f(C('uPassthru'),0.0);
 // per-scene FAITHFUL tonemap in the composite (TONELUT_PS): bind the scene's real tex14/15 + the firmware
 // scale (1/128, UN-flag) + backbuffer feedback 1/(1-fc21=0.125). Falls back to the static LUTWARM otherwise.
 const psTone = TONELUT_PS && CAP_T15 && CAP_T14;
 gl.activeTexture(33984+3);gl.bindTexture(3553,(psTone?CAP_T15:sharedTex.tex15));gl.uniform1i(C('uLut15'),3);
 gl.activeTexture(33984+4);gl.bindTexture(3553,(psTone?CAP_T14:sharedTex.tex14));gl.uniform1i(C('uLut14'),4);
 gl.uniform1f(C('uLutOn'), psTone?1.0:LUTWARM);
 gl.uniform1f(C('uLutExpo'), psTone?(1.0/128.0):LUTEXPO);
 gl.uniform1f(C('uLutFb'), psTone?(1.0/(1.0-0.125)):1.0);
 {const sh=D.shared||{};const gv=k=>{const v=sh[k]||[0,0,0,0];return [v[0],v[1],v[2],v[3]];};
  gl.uniform4f(C('c260'),...gv('260'));gl.uniform4f(C('c261'),...gv('261'));gl.uniform4f(C('c262'),...gv('262'));gl.uniform4f(C('c263'),...gv('263'));
  gl.uniform4fv(C('gfc'),glareGfc());}
 gl.bindVertexArray(glowVAO);
 gl.drawArrays(4,0,3);
 gl.bindVertexArray(null);
 if(STARTEX)drawStarsTex();   // real star field, additive in DISPLAY space (STARS IN HDR=0), drowned where the earth is bright
 // (atmosphere is now rendered additively into the HDR FBO above, step 1b, so it blooms + tonemaps
 //  with the earth and keeps its blue -- no separate post pass needed.)
}
// Run the verbatim in-scatter generator chain: seeds -> bufA (limb scatter) + bufB -> bufC (tex4).
// Mirrors the firmware d017-d022 sequence (clear 0.2-grey then write; blend OFF; 256x128 fp16 RTs).
function genInscatter(){
 if(!ipUpProg||!ipCombineProg||!texSeedA||!texSeedA.loaded||!texSeedB||!texSeedB.loaded||!texBicubic||!texBicubic.loaded) return false;
 const A=ensureColorRT(_ipA,256,128), B=ensureColorRT(_ipB,256,128), Cc=ensureColorRT(_ipC,256,128);
 gl.disable(2929);gl.disable(3042);gl.disable(2884);
 gl.bindTexture(3553,texBicubic);gl.texParameteri(3553,10242,10497);   // REPEAT wrap_s for the phase coordinate
 gl.bindVertexArray(glowVAO);
 gl.useProgram(ipUpProg);
 const U=n=>gl.getUniformLocation(ipUpProg,n);
 const run=(rt,seed,fc0x,fc0y,fc1z,fc4y)=>{
   gl.bindFramebuffer(36160,rt.fbo);gl.viewport(0,0,256,128);
   gl.clearColor(0.2,0.2,0.2,1);gl.clear(16384);                        // verbatim clear fp 6db9195a fc0
   gl.activeTexture(33984);gl.bindTexture(3553,seed);gl.uniform1i(U('uSeed'),0);
   gl.activeTexture(33985);gl.bindTexture(3553,texBicubic);gl.uniform1i(U('uTable'),1);
   gl.uniform2f(U('uFc0'),fc0x,fc0y);gl.uniform1f(U('uFc1z'),fc1z);gl.uniform1f(U('uFc4y'),fc4y);
   gl.drawArrays(4,0,3);
 };
 run(A,texSeedA,40,40,0.2,0.025);
 run(B,texSeedB,40,20,1.0,0.05);
 gl.bindFramebuffer(36160,Cc.fbo);gl.viewport(0,0,256,128);
 gl.clearColor(0.2,0.2,0.2,1);gl.clear(16384);
 gl.useProgram(ipCombineProg);
 const V=n=>gl.getUniformLocation(ipCombineProg,n);
 gl.activeTexture(33984);gl.bindTexture(3553,B.tex);gl.uniform1i(V('uB'),0);
 gl.activeTexture(33985);gl.bindTexture(3553,A.tex);gl.uniform1i(V('uA'),1);
 gl.drawArrays(4,0,3);
 gl.bindVertexArray(null);gl.bindFramebuffer(36160,null);
 return true;
}
// draw the per-frame sun-flare billboards (verbatim globe_flare.js) from the harvested rows.
function drawFlares(){
 if(!FLARES||!FLARE_ROWS||typeof GlobeFlare==='undefined'||!SCENES_IDX||!SCENES_IDX[sceneIdx]) return;
 const s=SCENES_IDX[sceneIdx]; const fr=s.frame0+animT*((s.frame1-s.frame0)||1);
 const keys=Object.keys(FLARE_ROWS); if(!keys.length) return;
 let bk=keys[0]; for(const k of keys){ if(Math.abs(+k-fr)<Math.abs(+bk-fr)) bk=k; }
 if(Math.abs(+bk-fr)>180) return;   // only when the capture has flares near this playback frame
 if(!GlobeFlare._inited){ try{ GlobeFlare.init(gl); GlobeFlare._inited=true; }catch(e){ errlog+=' flare:'+e.message; FLARES=0; return; } }
 const t14=CAP_T14||sharedTex.tex14, t15=CAP_T15||sharedTex.tex15;
 let n=0; let di=0;
 const only=(typeof window!=='undefined'&&window.__flareOnly!==undefined&&window.__flareOnly!==null)?+window.__flareOnly:-1;
 for(const d of FLARE_ROWS[bk]){
   const idx=di++;
   if(only>=0 && idx!==only) continue;
   const vc=[]; for(let i=0;i<17;i++) vc.push((d.c&&d.c[String(254+i)])||[0,0,0,0]);
   const fc=[]; for(let i=0;i<8;i++) fc.push((d.fc&&d.fc[String(i)])||[0,0,0,0]);
   GlobeFlare.draw(gl,{vc,fc,lut14:t14,lut15:t15,flipY:1.0}); n++;
 }
 if(typeof window!=='undefined') window.__flareDrawn={n:n, fr:bk};
}
// FAITHFUL render (GLOWFAITH): the firmware pipeline = earth -> col0 per-scene LUT -> DISPLAY (LDR), and the
// LIMB/SUN -> their OWN tonemap + a SEPARATE HDR bloom -> additive composite. So we render TWO targets:
//   F_disp (LDR): col0 earth (uMode=1, per-scene tex14/15, 1/128 scale, feedback) + drawAtmo (tonemapped limb)
//   F_bloom (HDR): the earth DEPTH (blitted) occludes drawAtmoLinear (HDR limb) + drawSunDisc -> bright-pass -> bloom
// composite (uPassthru): canvas = F_disp + bloom (NO re-tonemap; F_disp is already LDR).
function glareRow(){   // nearest-t REAL per-scene glare row (vp c868fd6a captures)
 if(GLARE_ROWS && SCENES_IDX && SCENES_IDX[sceneIdx]){
   const rows=GLARE_ROWS[String(SCENES_IDX[sceneIdx].scene)];
   if(rows&&rows.length){ let g=rows[0]; for(const e of rows){ if(Math.abs(e.t-animT)<Math.abs(g.t-animT)) g=e; } return g; } }
 return null;
}
function glareGfc(){   // nearest-t REAL per-scene glare consts (vp c868fd6a rows); GLOW_FC fallback
 const grow=glareRow();
 const gsrc=grow?grow.gfc:GLOW_FC;
 const gf=new Float32Array(17*4);for(let i=0;i<17;i++){const v=gsrc[i]||[0,0,0,0];gf[i*4]=v[0];gf[i*4+1]=v[1];gf[i*4+2]=v[2];gf[i*4+3]=v[3];}
 return gf;
}
// BASE EARTH LAYER: continuous unit sphere drawn BEFORE the per-patch tiles, using the IDENTICAL c260..c263
// MVP, so its silhouette aligns exactly. Patches overdraw it everywhere they rasterize (zero regression on
// non-grazing frames); only the grazing-angle silhouette notches reveal it as smooth earth instead of black.
// Self-gates to the ATMO_REAL scene set (scene 0). Caller must have the target FBO bound; restores depth/cull.
// COVERAGE dst-alpha mask: 1 over the disc for the ATMO_REAL scene set (so the dst-alpha atmosphere is
// masked off the lit disc and concentrates at the limb/sky). window.__covAlpha forces it for testing.
function covAlphaOn(){
 if(typeof window!=='undefined'&&window.__covAlpha) return 1.0;
 const sc=(SCENES_IDX&&SCENES_IDX[sceneIdx])?SCENES_IDX[sceneIdx].scene:sceneIdx;
 return (COV_ALPHA && ATMO_REAL_MASTER && ATMO_REAL_SCENES.indexOf(sc)>=0) ? 1.0 : 0.0;
}
function drawBaseEarth(){
 const sc=(SCENES_IDX&&SCENES_IDX[sceneIdx])?SCENES_IDX[sceneIdx].scene:sceneIdx;
 const areal=(ATMO_REAL_MASTER && ATMO_REAL_SCENES.indexOf(sc)>=0);
 if(!(BASE_FILL && areal && baseProg && baseMesh && D && D.shared && D.shared['260'] && D.shared['263'])) return;
 const sb=D.shared; const fcb=curFC||D.fc; const sun=(fcb&&fcb[8])?fcb[8]:[0,0,1];
 gl.useProgram(baseProg); const Ub=n=>gl.getUniformLocation(baseProg,n);
 gl.uniform4fv(Ub('c260'),sb['260']);gl.uniform4fv(Ub('c261'),sb['261']);gl.uniform4fv(Ub('c262'),sb['262']);gl.uniform4fv(Ub('c263'),sb['263']);
 gl.uniform1f(Ub('uFlipY'),-1.0); gl.uniform3f(Ub('uSun'),sun[0],sun[1],sun[2]); gl.uniform1f(Ub('uBaseGain'),BASE_GAIN);
 gl.uniform1f(Ub('uDbgProj'),(typeof window!=='undefined'&&window.__baseDbgProj)?1.0:0.0);
 gl.uniform1f(Ub('uBaseScale'),(typeof window!=='undefined'&&window.__baseScale)?window.__baseScale:BASE_SCALE);
 gl.activeTexture(33984+10);gl.bindTexture(34067,sharedTex.earthCube);gl.uniform1i(Ub('uEarthCube'),10);
 gl.bindVertexArray(null);   // clean default-VAO attribute setup (a stale glowVAO would mis-route the attribs)
 gl.disable(2929); gl.depthMask(false);
 if(typeof window!=='undefined'&&window.__baseNoCull){ gl.disable(2884); } else { gl.enable(2884); gl.cullFace(1029); gl.frontFace((typeof window!=='undefined'&&window.__baseWind)?2304:2305); }
 const bl=gl.getAttribLocation(baseProg,'in_dir');
 gl.bindBuffer(34962,baseMesh.pb); gl.enableVertexAttribArray(bl); gl.vertexAttribPointer(bl,3,5126,false,0,0);
 gl.bindBuffer(34963,baseMesh.ib); gl.drawElements(4,baseMesh.n,5123,0);
 gl.disableVertexAttribArray(bl);
 gl.depthMask(true); gl.enable(2929); gl.depthFunc(515);   // restore for the patch pass
 if(CULL){gl.enable(2884);gl.cullFace(1029);}else{gl.disable(2884);}
}
function drawGlowFaith(){
 const W=canvas.width,H=canvas.height;
 // Resolve the EFFECTIVE real-atmosphere flag for THIS scene: master toggle AND the validated whitelist.
 // (Forcing the dst-alpha law + HDRC-off on every scene regressed dark scenes like 5/14 to near-black.)
 { const sc = (SCENES_IDX&&SCENES_IDX[sceneIdx]) ? SCENES_IDX[sceneIdx].scene : sceneIdx;
   ATMO_REAL = (ATMO_REAL_MASTER && ATMO_REAL_SCENES.indexOf(sc)>=0) ? 1 : 0; }
 // FAITHFUL HDR-domain composite gate: global toggle OR per-scene policy (the close-up band family).
 // Surface+atmo render as LINEAR HDR -> one real dual-LUT tonemap (no additive-LDR white limb band).
 // ATMO_REAL forces HDRC off: the real firmware composites the surface (LDR display) and the atmosphere
 // (dst-alpha) in the SAME LDR/display domain. The HDRC deferred-tonemap path renders the surface as
 // linear HDR (uMode=5) which does NOT compose with the LDR dst-alpha atmosphere (2nd-half blacks out).
 const HDRC = ATMO_REAL ? false : ((typeof window!=='undefined'&&window.__noHDRC) ? false : (ATMO_HDRC || (FAITH_POLICY&&FAITH_POLICY.hdrcScenes&&SCENES_IDX&&SCENES_IDX[sceneIdx]&&FAITH_POLICY.hdrcScenes.indexOf(SCENES_IDX[sceneIdx].scene)>=0)));
 if(ATMO_REAL && hdrFBO && hdrFBO.w===W && hdrFBO.h===H && (typeof window==='undefined'||!window.__noRespec)){
   // ATMO_REAL (bloom-of-display glow) is unstable on some drivers: a stray NaN/Inf in the HALF_FLOAT
   // display FBO is NOT scrubbed by gl.clear/clearBufferfv, nor by re-speccing the color texture - the
   // bloom pyramid then bilinearly spreads it to a full-frame white-out within a few frames (scene 1 etc).
   // Only DESTROYING the whole FBO (color tex + depth renderbuffer) and recreating it yields a clean buffer.
   // Force ensureHDR to rebuild a fresh display FBO each glow frame. Glow scenes only (0,1); negligible cost.
   gl.deleteFramebuffer(hdrFBO.fbo); gl.deleteTexture(hdrFBO.tex); gl.deleteRenderbuffer(hdrFBO.depth); hdrFBO=null;
 }
 const Fd=ensureHDR(W,H), Fb=ensureHDR2(W,H);
 if(INSCAT_GEN){ if(seedCap3(sceneIdx, animT)){ genInscatter(); _ipValid=true; } else { _ipValid=false; } }   // verbatim per-frame tex4/limb generation; falls back to the streamed bin while this scene's seeds load
 // ---- 1) F_disp = col0 earth (LDR) + tonemapped limb ----
 gl.bindFramebuffer(36160,Fd.fbo);
 // clear alpha = 1.0: the display A channel is the HDR-exponent (present dark sky alpha = 255 = 1.0)
 gl.viewport(0,0,W,H);
 if(DISPRETAIN){ gl.clear(256); }   // REAL pipeline: the display is NEVER color-cleared (no clear pass in the draw list) - the sky temporally accumulates (flare lobes = equilibrium); depth-only clear
 else { if(typeof window!=='undefined'&&window.__dbgClear){gl.clearColor(1,0,0,ATMO_REAL?0.0:1.0);} else {gl.clearColor(0,0,0,ATMO_REAL?0.0:1.0);} gl.clear(16640); }   // ATMO_REAL: clear sky alpha=0 so the dst-alpha atmosphere shows in the sky (atmo*(1-0)); the atmo shell then writes alpha->1 (matching the present's sky alpha=255). Legacy=1.
 gl.enable(2929);gl.depthFunc(515);
 if(CULL){gl.enable(2884);gl.cullFace(1029);}else{gl.disable(2884);}
 drawBaseEarth();   // pre-fill the grazing-angle limb notches (before the patches cover the disc)
 gl.useProgram(prog);const U=n=>gl.getUniformLocation(prog,n);
 const fcsrc=curFC||D.fc; const fc=new Float32Array(23*4);for(let i=0;i<23;i++){const v=fcsrc[i];fc[i*4]=v[0];fc[i*4+1]=v[1];fc[i*4+2]=v[2];fc[i*4+3]=v[3];}
 resolveInscat();
 gl.uniform1f(U('uFlipY'),-1.0);gl.uniform1f(U('uDbg'),0.0);gl.uniform1f(U('uPatchExp'),PATCH_EXP);gl.uniform1f(U('uCovAlpha'),covAlphaOn());
 gl.uniform1f(U('uMode'),HDRC?5.0:1.0);   // HDRC: emit LINEAR HDR r2 (deferred single tonemap); else col0 LDR
 gl.uniform1f(U('uSlum'),SLUM);
 gl.uniform1f(U('uLutScale'),1.0/128.0);gl.uniform1f(U('uFeedback'),1.0);   // faithful: 1/128 UN-scale + steady-state feedback
 gl.uniform4fv(U('fc'),fc);
 const surfTex4 = ((INSCAT_GEN&&_ipValid&&_ipC.cur)?_ipC.cur.tex:null) || CAP_LUT || ((INSCAT_PS&&_psSurfTex) ? _psSurfTex : ((INSCAT_ECL&&sharedTex.tex4ecl)?sharedTex.tex4ecl:sharedTex.tex4));
 const surfTex4B=(surfTex4===CAP_LUT&&CAP_LUTB)?CAP_LUTB:surfTex4; const t4mix=(surfTex4===CAP_LUT&&CAP_LUTB)?CAP_MIX:0.0;
 bindT(4,'tex4',surfTex4);bindT(9,'tex4b',surfTex4B);gl.uniform1f(U('uT4Mix'),t4mix);gl.uniform1f(U('uLimbGain2'),limbGainAt());bindT(5,'tex5',(IEFULL&&sharedTex.ieFull)?sharedTex.ieFull:sharedTex.tex5);bindT(6,'tex6',sharedTex.tex6);
 bindT(7,'tex14',CAP_T14||sharedTex.tex14);bindT(8,'tex15',CAP_T15||sharedTex.tex15);bindT(9,'tex13',black0||black);
 gl.uniform1f(U('uTiles'),TILES);
 const bindCube=(unit,name,tex)=>{gl.activeTexture(33984+unit);gl.bindTexture(34067,tex);gl.uniform1i(U(name),unit);};
 bindCube(10,'earthCube',sharedTex.earthCube);bindCube(11,'cloudsCube',sharedTex.cloudsCube);bindCube(12,'maskCube',sharedTex.maskCube);
 const pl=gl.getAttribLocation(prog,'in_pos');gl.bindBuffer(34962,eMesh.pb);gl.enableVertexAttribArray(pl);gl.vertexAttribPointer(pl,4,5126,false,0,0);
 gl.bindBuffer(34963,eMesh.ib);
 const wflip=-1;
 if(!ATMO_ONLY&&!STARSONLY) for(let i=0;i<D.patches.length;i++){
   gl.frontFace(windSign(D.patches[i].corners)*wflip<0?2304:2305);
   const pt=patchTex[D.patches[i].idx];
   if(pt){bindT(0,'tex0',pt[0]);bindT(1,'tex1',pt[1]);bindT(2,'tex2',pt[2]);bindT(3,'tex3',pt[3]);}
   gl.uniform1f(U('uT2bad'),(T2ALL||BADT2.has(D.patches[i].idx))?1.0:0.0);
   gl.uniform1f(U('uBias0'),BIAS0);gl.uniform1f(U('uBias2'),BIAS2);gl.uniform1f(U('uT3Flip'),(FAITH_POLICY&&FAITH_POLICY.t3flip&&SCENES_IDX&&SCENES_IDX[sceneIdx]&&FAITH_POLICY.t3flip.indexOf(SCENES_IDX[sceneIdx].scene)>=0)?1.0:(window.__t3f||0));gl.uniform1f(U('uDiscGain'),discGainAt());gl.uniform1f(U('uLimbSoft'),limbSoftAt());gl.uniform1f(U('uFp16'),FP16);gl.uniform1f(U('uExpFix'),(ATMO_REAL||(typeof window!=='undefined'&&window.__expfix))?1.0:0.0);
   gl.uniform4fv(U('vc'),buildVC(D.patches[i].corners));gl.drawElements(4,eMesh.n,5123,0);}
 gl.disable(2884);
 if((ATMO||ATMO_ONLY)&&aMesh&&scatterTex&&!STARSONLY){ if(ATMO_REAL) drawAtmo(); else if(HDRC) drawAtmoLinear(); else drawAtmo(); }   // ATMO_REAL: the real music-globe fp f566cf05 is a SELF-CONTAINED LDR shader (own dual-LUT tonemap + dst-alpha composite); never route it through the HDR-additive linear path (= blown-out white). HDRC: HDR limb added in LINEAR domain into Fd; else legacy tonemapped LDR limb
 if(FLARESPRE) drawFlares();   // flares INTO the display pre-encode: the real eclipse LOBES = the bloom of this light (test gate)
 // ---- 2) composite F_disp (+BURST) -> canvas. With BURST active the composite goes through a POST
 // texture RT first (the firmware encodes the DISPLAY - earth+limb+burst - into the bloom source, so
 // the corona emerges from blooming the post-burst scene, not the limb-only buffer).
 const C=n=>gl.getUniformLocation(cprog,n);
 if(FAITH_AUTO&&FAITH_POLICY&&SCENES_IDX&&SCENES_IDX[sceneIdx]){   // measurement-driven gating (the fbf-sweep winners)
   const scid=SCENES_IDX[sceneIdx].scene;
   const ww=FAITH_POLICY.bloomWindows&&FAITH_POLICY.bloomWindows[String(scid)];
   const tw=FAITH_POLICY.bloomTertiles&&FAITH_POLICY.bloomTertiles[String(scid)];
   if(ww){ BLOOMDISP=ww.some(w=>animT>=w[0]&&animT<=w[1])?1:0; }  // per-(scene,t-window) winners (clean warmed 12-pt protocol; tertiles damaged scene tails - sc24 t=0.94 was 53 vs 17)
   else if(tw){ BLOOMDISP=tw[Math.min(2,Math.floor(animT*3))]?1:0; }   // per-(scene,t-tertile): restores the sc24 burst corona while keeping early-scene legacy
   else { BLOOMDISP=(FAITH_POLICY.bloomScenes&&FAITH_POLICY.bloomScenes.indexOf(scid)>=0)?1:0; } }
 if(!FAITH_AUTO) BLOOMDISP = ATMO_REAL ? 1 : 0;   // SCENE-0 GLOW gate: bloom-of-display ON for scene 0 (ATMO_REAL), OFF for all others (must RESET to 0 - BLOOMDISP is a persistent global; else scene 0's =1 leaks into the next scene and blows it white)
 const burstRows=(BURST && BURST_FAN && FLARE_SCENES && typeof GlobeBurst!=='undefined' && SCENES_IDX && SCENES_IDX[sceneIdx]) ? (FLARE_SCENES[String(SCENES_IDX[sceneIdx].scene)]||null) : null;
 // live-harvested glare rows can drive the same verbatim fan: vc window captured at c[256..272]
 // (VS FC(0) = c257 -> shift one), fp consts = the 17 glare rows. GLOW2-gated.
 let glareBurst=null;
 if(GLOW2 && BURST_FAN && GLARE_ROWS && typeof GlobeBurst!=='undefined' && SCENES_IDX && SCENES_IDX[sceneIdx]){
   const rows=GLARE_ROWS[String(SCENES_IDX[sceneIdx].scene)];
   if(rows&&rows.length){ let g=rows[0]; for(const e of rows){ if(Math.abs(e.t-animT)<Math.abs(g.t-animT)) g=e; }
     if(g.vc && g.gfc && Math.max(Math.abs(g.gfc[13][0]),Math.abs(g.gfc[13][1]),Math.abs(g.gfc[13][2]))>1e-6) glareBurst=g; } }
 const useBurst=!!((burstRows && burstRows.length) || glareBurst);
 if(typeof window!=='undefined') window.__gbDbg={glow2:GLOW2,bf:!!BURST_FAN,gr:!!GLARE_ROWS,gb:!!glareBurst,br:!!(burstRows&&burstRows.length),useBurst:useBurst,scene:SCENES_IDX&&SCENES_IDX[sceneIdx]?SCENES_IDX[sceneIdx].scene:-1,animT:animT};
 const useFP=useBurst||(BLOOMDISP&&encProg);   // route the composite through the post RT whenever the firmware bloom-of-display path needs to sample it
 let FP=null;
 if(useFP){ FP=ensureColorRT(_postRef,W,H); gl.bindFramebuffer(36160,FP.fbo); }
 else gl.bindFramebuffer(36160,null);
 gl.viewport(0,0,W,H);gl.disable(2929);gl.disable(3042);gl.disable(2884);
 gl.useProgram(cprog);
 gl.activeTexture(33984+0);gl.bindTexture(3553,Fd.tex);gl.uniform1i(C('uEarth'),0);
 gl.activeTexture(33984+1);gl.bindTexture(3553,black);gl.uniform1i(C('uGlow'),1);
 gl.activeTexture(33984+2);gl.bindTexture(3553,glowSprite||black);gl.uniform1i(C('uSprite'),2);
 gl.activeTexture(33984+3);gl.bindTexture(3553,CAP_T15||sharedTex.tex15);gl.uniform1i(C('uLut15'),3);
 gl.activeTexture(33984+4);gl.bindTexture(3553,CAP_T14||sharedTex.tex14);gl.uniform1i(C('uLut14'),4);
 gl.uniform3fv(C('uGlowGain'),new Float32Array([0,0,0]));
 if(HDRC){ // FAITHFUL HDR composite: uEarth=Fd is the LINEAR HDR (surface r2 + atmo HDR). Apply the EXACT surface-fp dual-LUT tonemap ONCE (uLutOn path == col0: hc=r2/128, R=t15.ch1,G=t15.ch0,B=t14.ch1). The limb HDR rolls off through the LUT -> 226, no additive white band.
   gl.uniform1f(C('uPassthru'),0.0);gl.uniform1f(C('uLutOn'),1.0);gl.uniform1f(C('uLutExpo'),1.0/128.0);gl.uniform1f(C('uLutFb'),1.0);
 } else { gl.uniform1f(C('uPassthru'),1.0);gl.uniform1f(C('uDespeckle'),DESPECKLE);gl.uniform1f(C('uLutOn'),0.0); }
 gl.uniform2f(C('uDims'),W,H);
 // sun-glare: the c868fd6a draw is NOT fullscreen - VERTS f014391_d021 decoded it as the 65-vertex
 // TRIANGLE-FAN disc (radius 5/9, model space) positioned by its OWN MVP (row vc[6..9]); at most
 // (scene,t) it transforms to a tiny spot or fully off-screen (fr82800: every vert at ndc ~3.7).
 // Painting its fp over the whole screen (the old uGlow2 fullscreen hack) over-paints by
 // construction - validated kaleidoscope at sc24 t=0.83. The fan path (GlobeBurst) is the
 // correct geometry; keep the composite's fullscreen glare OFF.
 gl.uniform1f(C('uGlow2'),0.0);
 {const sh=D.shared||{};const gv=k=>{const v=sh[k]||[0,0,0,0];return [v[0],v[1],v[2],v[3]];};
  gl.uniform4f(C('c260'),...gv('260'));gl.uniform4f(C('c261'),...gv('261'));gl.uniform4f(C('c262'),...gv('262'));gl.uniform4f(C('c263'),...gv('263'));
  gl.uniform4fv(C('gfc'),glareGfc());
  if(typeof window!=='undefined'){const grow=glareRow();window.__glareDbg={act:false,t:grow?grow.t:null,col:grow&&grow.gfc&&grow.gfc[13]?grow.gfc[13].slice(0,3):null};}}
 gl.bindVertexArray(glowVAO);gl.drawArrays(4,0,3);gl.bindVertexArray(null);
 if(useBurst){
   // verbatim SUN-DISC BURST into the post RT (occlusion sampled from F_disp - no feedback)
   let vc,fc;
   if(glareBurst){
     // VP-UCODE-PROVEN const map for the c868fd6a fan (LE d1>>12 decode, calibrated on the fan vp):
     // FC(0..2)=c256-258 ray rows, FC(3..6)=c260-263 MVP, FC(7)=c465 uv (pos+x)*y, FC(8)=c466,
     // FC(9)=c467 sun point. The old sequential base-254 feed shifted the MVP by 3 rows and fed
     // camera rows as uv/sun (the fan never rendered sanely). vch = c454..c467 (harvest v2).
     const VCH=glareBurst.vch||null;
     const vcr=i=>glareBurst.vc[i-254]||[0,0,0,0];
    const vchr=i=>(VCH&&VCH[i-454])||[0,0,0,0];
     vc=[]; for(let i=0;i<17;i++) vc.push([0,0,0,0]);
     vc[0]=vcr(256);vc[1]=vcr(257);vc[2]=vcr(258);
     vc[3]=vcr(260);vc[4]=vcr(261);vc[5]=vcr(262);vc[6]=vcr(263);
     vc[7]=vchr(465);vc[8]=vchr(466);vc[9]=vchr(467);
     if(!VCH){ vc[7]=[1,0.5,0,0]; }   // until the vch harvest lands: c465 is the (pos+1)*0.5 uv pair at every captured frame
     fc=glareBurst.gfc.slice(0,17);
   } else {
     const s=SCENES_IDX[sceneIdx]; const fr=s.frame0+animT*((s.frame1-s.frame0)||1);
     let best=burstRows[0]; for(const e of burstRows){ if(Math.abs(e.fr-fr)<Math.abs(best.fr-fr)) best=e; }
     vc=[]; for(let i=0;i<17;i++){ vc.push(best[String(254+i)]||[0,0,0,0]); }   // window base 254 (proven vs the present)
     fc=(best.fc||[]).slice(0,17); while(fc.length<17) fc.push([0,0,0,0]);
   }
   if(!GlobeBurst._inited){ try{ GlobeBurst.init(gl); GlobeBurst._inited=true; }catch(e){ errlog+=' burst:'+e.message; BURST=0; } }
   if(GlobeBurst._inited){
     const verts=new Float32Array(BURST_FAN.length*4);
     for(let i=0;i<BURST_FAN.length;i++) for(let j=0;j<4;j++) verts[i*4+j]=BURST_FAN[i][j];
     GlobeBurst.draw(gl,{verts,vc,fc,flipY:1.0,w:W,h:H,lutScale:1/128,dbg:(window.BURSTDBG||0),
       shapeTex:sharedTex.sundisc||black, sceneTex:Fd.tex, lut14:(CAP_T14||sharedTex.tex14), lut15:(CAP_T15||sharedTex.tex15)});
   }
 }
 if(useFP && !(BLOOMDISP&&encProg)){
   // post RT -> canvas passthrough (burst-only mode; the faithful bloom path does its own final composite)
   gl.bindFramebuffer(36160,null);gl.viewport(0,0,W,H);gl.disable(2929);gl.disable(3042);gl.disable(2884);
   gl.useProgram(cprog);
   gl.activeTexture(33984+0);gl.bindTexture(3553,FP.tex);gl.uniform1i(C('uEarth'),0);
   gl.activeTexture(33984+1);gl.bindTexture(3553,black);gl.uniform1i(C('uGlow'),1);
   gl.uniform1f(C('uPassthru'),1.0);gl.uniform1f(C('uDespeckle'),DESPECKLE);
   gl.bindVertexArray(glowVAO);gl.drawArrays(4,0,3);gl.bindVertexArray(null);
 }
 if(BLOOMDISP&&encProg&&FP){
   // ---- FAITHFUL bloom chain: HDR layer -> ENCODE (fp 775efaf5: desat -> exp2 glare -> tone-LUT)
   //      -> pyramid (per-frame blur+combine consts) -> composite FP*(1-FC1)+bloom*FC0 (fp 59b46122).
   //      The encode input is the HDR limb/sun layer (offline sim: encoding the LDR display explodes;
   //      the real encode output is sparse = an HDR layer with isolated hot points).
   let row=null;
   if(BLOOM_SCENES && SCENES_IDX && SCENES_IDX[sceneIdx]){
     const rows=BLOOM_SCENES[String(SCENES_IDX[sceneIdx].scene)];
     if(rows&&rows.length){ const s=SCENES_IDX[sceneIdx]; const fr=s.frame0+animT*((s.frame1-s.frame0)||1);
       row=rows[0]; for(const e of rows){ if(Math.abs(e.fr-fr)<Math.abs(row.fr-fr)) row=e; } }
   }
   const encFC=new Float32Array(8*4);
   const encsrc=(row&&row.enc)?row.enc:[[1,0,0,0],[0.13828,0,0,0],[0.13828,0,0,0],[0.13828,0,0,0],[0.13828,0,0,0],[2,0,0,0],[0.881311,0,0,0],[0.27,0.67,0.06,0]];   // the ENCODE draw's per-frame consts (bd9c5fac family) - NOT enc2 (the star-brightness pass)
   for(let i=0;i<8;i++) for(let j=0;j<4;j++) encFC[i*4+j]=encsrc[i][j];
   // the encode reads THIS frame's PRE-BLOOM display (write-graph proven: d026 tex0 = 0xdc80000,
   // before the composite d062 adds the bloom). NO temporal feedback anywhere in the real chain.
   const ENC=ensureColorRT(_encRef,512,512);
   gl.bindFramebuffer(36160,ENC.fbo);gl.viewport(0,0,512,512);gl.disable(2929);gl.disable(3042);gl.disable(2884);
   gl.useProgram(encProg);
   gl.activeTexture(33984+0);gl.bindTexture(3553,FP.tex);gl.uniform1i(gl.getUniformLocation(encProg,'uDisp'),0);
   gl.uniform4fv(gl.getUniformLocation(encProg,'uEFC'),encFC);
   gl.bindVertexArray(glowVAO);gl.drawArrays(4,0,3);gl.bindVertexArray(null);
   gl.bindFramebuffer(36160,null);
   const blurW=row?row.blur:ENC_BLUR_W, upW=row?row.up:ENC_UP_W;
   const glow=GlobeGlow.buildGlow(gl,ENC.tex,512,512,{blurWeights:blurW,upWeights:upW});_lastGlow=glow;
   // final composite: write-graph proven NET = display*1.0 + bloom*FC0 (d062 adds bloom*FC0
   // - display*FC1; the star tile pass d064+ adds stars + display*FC1 back; no temporal EMA).
   const c0 = ATMO_REAL ? ((row&&row.comp?row.comp[0]:1.0)*0.5)   // SCENE-0 GLOW: firmware composite weight FC0 * 0.5 (reproduces the MEASURED real bloom +3.9, validated limb-profile err 5.4; the 0.5 compensates for the uncaptured ENC_UP_W combine weights, sum 13.25 ~2x). Stable scalar, not per-frame.
              : ((BLOOMC1&&row&&row.comp)?row.comp[1]:(row&&row.comp?row.comp[0]:1.0));   // BLOOMC1: add bloom at FC1 (0.125, display-units) instead of FC0 (1.0) - the two firmware-derived interpretations of the d053 composite, A/B vs presents
   gl.bindFramebuffer(36160,null);gl.viewport(0,0,W,H);gl.disable(2929);gl.disable(2884);gl.disable(3042);
   gl.useProgram(cprog);
   gl.activeTexture(33984+0);gl.bindTexture(3553,FP.tex);gl.uniform1i(C('uEarth'),0);
   gl.activeTexture(33984+1);gl.bindTexture(3553,glow.tex);gl.uniform1i(C('uGlow'),1);
   let cg=c0;
   if(!ATMO_REAL && FAITH_POLICY&&FAITH_POLICY.bloomGain&&SCENES_IDX&&SCENES_IDX[sceneIdx]){   // SCENE-0 GLOW: skip the per-frame bloomGain envelope for scene 0 (the directive's "remove the per-frame bloom-gain flicker hack") - it was fitted to 0 to suppress the OLD broken-alpha encode and would zero the now-correct bloom
     const g=FAITH_POLICY.bloomGain[String(SCENES_IDX[sceneIdx].scene)];
     if(typeof g==='number') cg=c0*g;   // per-scene present-fitted gain (approximation pass, user-approved 2026-06-11)
     else if(Array.isArray(g)&&g.length){   // per-(scene,t) ENVELOPE [[t,gain],...] - piecewise linear (the real bloom animates per frame; fitted per t vs the presents)
       let gv=g[0][1];
       for(let i=0;i<g.length;i++){
         if(animT<=g[i][0]){ if(i===0){gv=g[0][1];} else { const a=g[i-1],b=g[i]; const w=(animT-a[0])/((b[0]-a[0])||1); gv=a[1]+(b[1]-a[1])*w; } break; }
         gv=g[i][1];
       }
       cg=c0*gv;
     }
   }
   gl.uniform3fv(C('uGlowGain'),new Float32Array([cg,cg,cg]));
   gl.uniform1f(C('uPassthru'),1.0);gl.uniform1f(C('uDespeckle'),DESPECKLE);
   gl.bindVertexArray(glowVAO);gl.drawArrays(4,0,3);gl.bindVertexArray(null);
   drawFlares();   // verbatim sun-flare billboards (post-composite, the real draw order)
   if(STARTEX)drawStarsTex();
   return;   // the legacy limb-HDR bloom (steps 3-5) is REPLACED by the real display-encode chain
 }
 // ---- 3) blit F_disp depth -> F_bloom; render HDR limb+sun (bloom source) ----
 gl.bindFramebuffer(36008,Fd.fbo);gl.bindFramebuffer(36009,Fb.fbo);
 gl.blitFramebuffer(0,0,W,H,0,0,W,H,256,9728);   // DEPTH_BUFFER_BIT, NEAREST
 gl.bindFramebuffer(36160,Fb.fbo);gl.viewport(0,0,W,H);
 gl.colorMask(true,true,true,true);gl.clearColor(0,0,0,0);gl.clear(16384);   // clear COLOR only, keep blitted depth
 gl.enable(2929);gl.depthFunc(515);
 if((ATMO||ATMO_ONLY)&&aMesh&&scatterTex&&!STARSONLY) drawAtmoLinear();   // HDR limb
 if(!STARSONLY) drawSunDisc();                                            // sun, occluded by earth depth
 // ---- 4) bright-pass(F_bloom) -> buildGlow ----
 gl.disable(2929);gl.disable(3042);gl.disable(2884);
 gl.bindVertexArray(glowVAO);
 const GR=ensureColorRT(_gsRef,W,H);
 gl.bindFramebuffer(36160,GR.fbo);gl.viewport(0,0,W,H);
 gl.useProgram(gsProg);
 gl.activeTexture(33984+0);gl.bindTexture(3553,Fb.tex);gl.uniform1i(gl.getUniformLocation(gsProg,'uTone'),0);   // legacy HDR limb bloom (validated); the burst corona needs the real encode fp bd9c5fac (decode-then-brightpass of the display) - next port
 gl.uniform1f(gl.getUniformLocation(gsProg,'uSlum'),GLOW_SLUM*0.125);
 gl.uniform1f(gl.getUniformLocation(gsProg,'uThresh'),GLARE_THRESH);
 gl.drawArrays(4,0,3);gl.bindVertexArray(null);
 gl.bindFramebuffer(36160,null);
 const glow=GlobeGlow.buildGlow(gl,GR.tex,W,H);_lastGlow=glow;
 // ---- 5) ADD the bloom onto the canvas (blend ONE,ONE): canvas += clamp(bloom*gain) ----
 gl.bindFramebuffer(36160,null);gl.viewport(0,0,W,H);gl.disable(2929);gl.disable(2884);
 gl.enable(3042);gl.blendFunc(1,1);   // additive
 gl.useProgram(cprog);
 gl.activeTexture(33984+0);gl.bindTexture(3553,black);gl.uniform1i(C('uEarth'),0);
 gl.activeTexture(33984+1);gl.bindTexture(3553,glow.tex);gl.uniform1i(C('uGlow'),1);
 gl.uniform3fv(C('uGlowGain'),new Float32Array(GLOW_GAIN));
 gl.uniform1f(C('uPassthru'),1.0);gl.uniform1f(C('uDespeckle'),DESPECKLE);
 gl.bindVertexArray(glowVAO);gl.drawArrays(4,0,3);gl.bindVertexArray(null);
 gl.disable(3042);
 drawFlares();   // the real pipeline draws the 15 flare billboards EVERY frame (visibility = the FS sun gate)
 if(STARTEX)drawStarsTex();
}
// atmosphere shell with LINEAR-HDR output (uLinear=1), additive into the HDR FBO so it feeds the bloom.
// The atmo shell must share the SURFACE's camera: rows captured at a DIFFERENT camera (scenes 0/1/2/23,
// atmo eye 2-5x off the surface eye) render the limb as a wrong-scale RING across the frame. Until those
// scenes' atmo rows are re-harvested from the live cycle, skip the shell when the eyes disagree.
function atmoCamBad(a,s){
 if(ATMO_REAL) return false;   // the real f566cf05 shell uses the shared surface camera basis (c5-c8) and self-tonemaps via dst-alpha; it does NOT render as the legacy wrong-scale ring this guard suppresses. Always draw it.
 const rel=(av,sv)=>{ if(!av||!sv) return 0;
   let d=0,n=0; for(let i=0;i<3;i++){ d+=Math.abs(av[i]-sv[i]); n+=Math.abs(sv[i]); }
   return d/Math.max(n,1e-6); };
 // eye row AND the projection w-row must both agree with the surface camera: sparse/mis-captured
 // atmo rows can interpolate a plausible eye while the rotation rows are wrong (the sc1 ring).
 const r1=rel(a&&a['460'], s&&s['460']), r2=rel(a&&a['259'], s&&s['263']);
 if(typeof window!=='undefined') window.__atmoDbg={r460:+r1.toFixed(3),r259:+r2.toFixed(3),guard:ATMOGUARD,bad:(r1>0.4||r2>0.25)};
 if(!ATMOGUARD) return false;
 if(r1>0.4) return true;
 if(r2>0.5) return true;   // raised 0.25->0.5: sc00's legit near-match (r259 0.26-0.31) was wrongly blocked = limb 'disappears after a few seconds' (user); mis-captured cams (sc2 r259~2.0) still caught
 return false;
}
// REAL per-(scene,t) atmo fp consts (vp 3f6eeb47 const[0..16], harvested from globecap3 into the
// atmo rows' fc key, present-aligned). Replaces the static default + the fc16~surface-fc[4].y
// approximation: real const[16] spans 0.06 (sc42-44) .. 3.67 (sc31-35), and the scatter terms set
// the limb ALPHA (r0.w) = the encode bright-pass key at the limb (B7 real eclipse limb alpha ~0.02
// vs the old default's overshoot = the sc47/40 bloom blowout seed). Falls back to the legacy
// approximation for rows without harvested fc. ATMOFC-gated for A/B validation.
function limbSoftAt(){
 if(!(FAITH_POLICY&&FAITH_POLICY.limbSoft&&SCENES_IDX&&SCENES_IDX[sceneIdx])) return 0.0;
 const g=FAITH_POLICY.limbSoft[String(SCENES_IDX[sceneIdx].scene)];
 return (typeof g==='number')?g:0.0;
}
function discGainAt(){
 if(!(FAITH_POLICY&&FAITH_POLICY.discGain&&SCENES_IDX&&SCENES_IDX[sceneIdx])) return 1.0;
 const g=FAITH_POLICY.discGain[String(SCENES_IDX[sceneIdx].scene)];
 if(typeof g==='number') return g;
 if(Array.isArray(g)&&g.length){ let gv=g[0][1];
   for(let i=0;i<g.length;i++){ if(animT<=g[i][0]){ if(i===0){gv=g[0][1];} else {const a=g[i-1],b=g[i];const w=(animT-a[0])/((b[0]-a[0])||1);gv=a[1]+(b[1]-a[1])*w;} break;} gv=g[i][1]; }
   return gv; }
 return 1.0;
}
function limbGainAt(){
 if(!(FAITH_POLICY&&FAITH_POLICY.limbGain&&SCENES_IDX&&SCENES_IDX[sceneIdx])) return 1.0;
 const g=FAITH_POLICY.limbGain[String(SCENES_IDX[sceneIdx].scene)];
 if(typeof g==='number') return g;
 if(Array.isArray(g)&&g.length){
   let gv=g[0][1];
   for(let i=0;i<g.length;i++){
     if(animT<=g[i][0]){ if(i===0){gv=g[0][1];} else { const a=g[i-1],b=g[i]; const w=(animT-a[0])/((b[0]-a[0])||1); gv=a[1]+(b[1]-a[1])*w; } break; }
     gv=g[i][1];
   }
   return gv;
 }
 return 1.0;
}
function atmoFcArray(a){
 if(ATMOFC&&a&&a.fc&&a.fc.length>=17){
   const fa=new Float32Array(17*4);
   for(let i=0;i<17;i++){const v=a.fc[i]||[0,0,0,0];fa[i*4]=v[0];fa[i*4+1]=v[1];fa[i*4+2]=v[2];fa[i*4+3]=v[3];}
   if(typeof window!=='undefined'&&window.__c16!==undefined) fa[16*4]=window.__c16;   // f566 RE: test scene-0 c16 (cap2=2.176 vs live D21=1.485)
   if(typeof window!=='undefined'&&window.__fc6){ fa[6*4]=window.__fc6[0];fa[6*4+1]=window.__fc6[1];fa[6*4+2]=window.__fc6[2];fa[6*4+3]=window.__fc6[3]; }   // f566 RE: test the OD-coord scale (cap2=[1,0,0,0] uniform vs {-1,1,0,0} screen-varying)
   return fa;
 }
 if(curFC&&curFC[4]&&!FCATMO_OVR)fcAtmo[16*4]=curFC[4][1];   // legacy per-scene intensity approximation
 return fcAtmo;
}
function drawAtmoLinear(){
 if(!aMesh||!scatterTex||got<want)return; const s=D.shared; if(!s['460']||!s['461']||!s['462'])return;
 const a=(ATMO_SCENE?atmoAt(animT):null)||{};
 if(atmoCamBad(a,s))return;
 const e460=a['460']||s['460'], e461=a['461']||s['461'], e462=a['462']||s['462'];
 const c5=e461.slice(0,3), c7=e462.slice(0,3), c6=_cross(c5,c7), c8=e460.slice(0,3);
 const m0=a['256']||s['256']||s['260'],m1=a['257']||s['257']||s['261'],m2=a['258']||s['258']||s['262'],m3=a['259']||s['259']||s['263'];
 if(!m0||!m1||!m2||!m3)return;
 gl.useProgram(aprog); const U=n=>gl.getUniformLocation(aprog,n);
 gl.uniform4fv(U('mvp0'),m0);gl.uniform4fv(U('mvp1'),m1);gl.uniform4fv(U('mvp2'),m2);gl.uniform4fv(U('mvp3'),m3);
 const eclMode=INSCAT_ECL||(INSCAT_PS&&isEclipseView());   // (retained for callers that read it)
 // VIEWPORT-Y: -1 unconditionally, matching the surface earth's firmware-viewport identity fix (the shell
 // shares the same win-remap; with the surface now at uFlipY=-1 for ALL scenes the limb must follow to stay
 // registered to the earth). ATMO_FLIPY stays the orientation-probe knob (default 1.0 -> shipped -1.0).
 gl.uniform1f(U('uFlipY'),-ATMO_FLIPY);
 gl.uniform1f(U('uLinear'),1.0);
 gl.uniform1f(U('uAtmoReal'),ATMO_REAL?1.0:0.0); gl.uniform1f(U('uWposScale'),1.0); gl.uniform2f(U('uWposBias'),0.0,0.0);
 gl.uniform1f(U('uAtmoHdr'),ATMO_HDR);gl.uniform1f(U('uLimbGain'),limbGainAt());
 gl.uniform3fv(U('c5'),c5);gl.uniform3fv(U('c6'),c6);gl.uniform3fv(U('c7'),c7);gl.uniform3fv(U('c8'),c8);
 gl.uniform4fv(U('fc'),atmoFcArray(a));
 // _AtmSpaceIv (TEXUNIT0 of the atmo shell fp): per-scene -> the picked scene's LIMB lut (ac6e80000); eclipse ->
 // the shipped tex0atmEcl (broad warm scatter); else the daytime scatterTex. NOT the surface tex4 (nearly black).
 const aScat=((INSCAT_GEN&&_ipValid&&_ipA.cur)?_ipA.cur.tex:null) || CAP_LIMB || ((INSCAT_PS&&_psScat) ? _psScat : (INSCAT_ECL ? ((ATMO_SOLID&&sharedTex.tex0atmEclSolid)?sharedTex.tex0atmEclSolid:((ATMO_VFLIP&&sharedTex.tex0atmEclFlip)?sharedTex.tex0atmEclFlip:(sharedTex.tex0atmEcl||sharedTex.tex4ecl||scatterTex))) : scatterTex));
 gl.activeTexture(33984);gl.bindTexture(3553,aScat);gl.uniform1i(U('tex0'),0);
 const aScatB=(aScat===CAP_LIMB&&CAP_LIMBB)?CAP_LIMBB:aScat; const a0mix=(aScat===CAP_LIMB&&CAP_LIMBB)?CAP_MIX:0.0;
 gl.activeTexture(33984+9);gl.bindTexture(3553,aScatB);gl.uniform1i(U('tex0b'),9);gl.uniform1f(U('uA0Mix'),a0mix);
 gl.disable(2884); gl.depthMask(false); gl.enable(3042); gl.blendFunc(1,1);
 let pl=gl.getAttribLocation(aprog,'in_pos');gl.bindBuffer(34962,aMesh.pbuf);gl.enableVertexAttribArray(pl);gl.vertexAttribPointer(pl,4,5126,false,0,0);
 let tl=gl.getAttribLocation(aprog,'in_tc0');gl.bindBuffer(34962,aMesh.tbuf);gl.enableVertexAttribArray(tl);gl.vertexAttribPointer(tl,4,5126,false,0,0);
 gl.bindBuffer(34963,aMesh.ibuf);gl.drawElements(5,aMesh.n,5125,0);
 if(aMesh2&&ATMOBAND){   // firmware's SECOND 3f6eeb47 draw (identical consts; only the geometry differs)
   gl.bindBuffer(34962,aMesh2.pbuf);gl.vertexAttribPointer(pl,4,5126,false,0,0);
   gl.bindBuffer(34962,aMesh2.tbuf);gl.vertexAttribPointer(tl,4,5126,false,0,0);
   gl.bindBuffer(34963,aMesh2.ibuf);gl.drawElements(5,aMesh2.n,5125,0);
 }
 gl.disable(3042); gl.depthMask(true);
}

function draw(){
 if(!gl||!D||!eMesh||got<want)return;
 if(GLOWFAITH && hdrExt && cprog && glowVAO && typeof GlobeGlow!=='undefined' && (!TONELUT_PS || SCENE_HAS_TONE)){ drawGlowFaith(); return; }   // faithful path; per-SCENE gate (not per-frame load state, which flipped pipelines mid-scene = full-frame flicker). While a bin is in flight drawGlowFaith degrades IN-PATH via CAP_T14||sharedTex.tex14.
 if(GLOW && hdrExt && cprog && glowVAO && typeof GlobeGlow!=='undefined'){ drawGlow(); return; }   // gated new path (needs RGBA16F FBO)
 const W=canvas.width,H=canvas.height;
 gl.viewport(0,0,W,H);gl.clearColor(0,0,0,1);gl.clear(16640);gl.enable(2929);gl.depthFunc(515);
 if(!STARTEX)drawStars();             // catalog stars (legacy); texture stars added post-composite (display space)
 if(CULL){gl.enable(2884);gl.cullFace(1029);}else{gl.disable(2884);}   // back-face cull (per-patch frontFace)
 drawBaseEarth();   // pre-fill the grazing-angle limb notches (before the patches cover the disc)
 gl.useProgram(prog);const U=n=>gl.getUniformLocation(prog,n);
 const fcsrc=curFC||D.fc;  // per-scene captured fragment constants when cycling, else baked
 const fc=new Float32Array(23*4); for(let i=0;i<23;i++){const v=fcsrc[i];fc[i*4]=v[0];fc[i*4+1]=v[1];fc[i*4+2]=v[2];fc[i*4+3]=v[3];}
 resolveInscat();
 const eclView=isEclipseView();
 gl.uniform1f(U('uFlipY'),-1.0);gl.uniform1f(U('uPatchExp'),PATCH_EXP);gl.uniform1f(U('uCovAlpha'),covAlphaOn());   // firmware-viewport identity (see the glow path); -1 for ALL scenes
 gl.uniform1f(U('uDbg'),DBG);
 gl.uniform1f(U('uMode'),ENC);
 gl.uniform1f(U('uSlum'),SLUM);
 gl.uniform1f(U('uLutScale'),LUTSCALE); gl.uniform1f(U('uFeedback'),FEEDBACK_PS);
 gl.uniform4fv(U('fc'),fc);
 const surfTex4 = ((INSCAT_GEN&&_ipValid&&_ipC.cur)?_ipC.cur.tex:null) || CAP_LUT || ((INSCAT_PS&&_psSurfTex) ? _psSurfTex : ((INSCAT_ECL&&sharedTex.tex4ecl)?sharedTex.tex4ecl:sharedTex.tex4));
 const surfTex4B=(surfTex4===CAP_LUT&&CAP_LUTB)?CAP_LUTB:surfTex4; const t4mix=(surfTex4===CAP_LUT&&CAP_LUTB)?CAP_MIX:0.0;
 bindT(4,'tex4',surfTex4);bindT(9,'tex4b',surfTex4B);gl.uniform1f(U('uT4Mix'),t4mix);gl.uniform1f(U('uLimbGain2'),limbGainAt());bindT(5,'tex5',(IEFULL&&sharedTex.ieFull)?sharedTex.ieFull:sharedTex.tex5);bindT(6,'tex6',sharedTex.tex6);
 bindT(7,'tex14',CAP_T14||sharedTex.tex14);bindT(8,'tex15',CAP_T15||sharedTex.tex15);bindT(9,'tex13',black0||black);
 gl.uniform1f(U('uTiles'),TILES);
 const bindCube=(unit,name,tex)=>{gl.activeTexture(33984+unit);gl.bindTexture(34067,tex);gl.uniform1i(U(name),unit);};
 bindCube(10,'earthCube',sharedTex.earthCube);bindCube(11,'cloudsCube',sharedTex.cloudsCube);bindCube(12,'maskCube',sharedTex.maskCube);
 const pl=gl.getAttribLocation(prog,'in_pos');gl.bindBuffer(34962,eMesh.pb);gl.enableVertexAttribArray(pl);gl.vertexAttribPointer(pl,4,5126,false,0,0);
 gl.bindBuffer(34963,eMesh.ib);
 const wflip = -1;   // uFlipY=-1 unconditional -> invert frontFace so back-face cull keeps the near hemisphere
 if(!ATMO_ONLY&&!STARSONLY) for(let i=0;i<D.patches.length;i++){
   gl.frontFace(windSign(D.patches[i].corners)*wflip<0?2304:2305);
   const pt=patchTex[D.patches[i].idx];
   if(pt){ bindT(0,'tex0',pt[0]);bindT(1,'tex1',pt[1]);bindT(2,'tex2',pt[2]);bindT(3,'tex3',pt[3]); }
   gl.uniform1f(U('uT2bad'), (T2ALL||BADT2.has(D.patches[i].idx))?1.0:0.0);
   gl.uniform1f(U('uBias0'),BIAS0);gl.uniform1f(U('uBias2'),BIAS2);gl.uniform1f(U('uT3Flip'),(FAITH_POLICY&&FAITH_POLICY.t3flip&&SCENES_IDX&&SCENES_IDX[sceneIdx]&&FAITH_POLICY.t3flip.indexOf(SCENES_IDX[sceneIdx].scene)>=0)?1.0:(window.__t3f||0));gl.uniform1f(U('uDiscGain'),discGainAt());gl.uniform1f(U('uLimbSoft'),limbSoftAt());gl.uniform1f(U('uFp16'),FP16);gl.uniform1f(U('uExpFix'),(ATMO_REAL||(typeof window!=='undefined'&&window.__expfix))?1.0:0.0);
   gl.uniform4fv(U('vc'),buildVC(D.patches[i].corners));gl.drawElements(4,eMesh.n,5123,0);}
 gl.disable(2884);
 if((ATMO||ATMO_ONLY)&&aMesh&&scatterTex)drawAtmo();
}
// VERBATIM atmosphere limb shell (type-B 3f6eeb47 draw): basis c5=c461,c7=c462,c6=cross(c5,c7),c8=eye=c460;
// type-B MVP c256-259 + eye/basis replayed per-frame from the coherent capture (atmoAt). Additive over surface.
function drawAtmo(){
 if(!aMesh||!scatterTex||got<want)return; const s=D.shared; if(!s['460']||!s['461']||!s['462'])return;
 const a=(ATMO_SCENE?atmoAt(animT):null)||{};
 if(atmoCamBad(a,s))return;   // mis-captured atmo camera (scenes 0/1/2/23): shell would render as a wrong-scale ring
 const e460=a['460']||s['460'], e461=a['461']||s['461'], e462=a['462']||s['462'];
 const c5=e461.slice(0,3), c7=e462.slice(0,3), c6=_cross(c5,c7), c8=e460.slice(0,3);
 const m0=a['256']||s['256']||s['260'],m1=a['257']||s['257']||s['261'],m2=a['258']||s['258']||s['262'],m3=a['259']||s['259']||s['263'];
 if(!m0||!m1||!m2||!m3)return;
 gl.useProgram(aprog); const U=n=>gl.getUniformLocation(aprog,n);
 gl.uniform4fv(U('mvp0'),m0);gl.uniform4fv(U('mvp1'),m1);gl.uniform4fv(U('mvp2'),m2);gl.uniform4fv(U('mvp3'),m3);
 const eclMode=INSCAT_ECL||(INSCAT_PS&&isEclipseView());   // (retained for callers that read it)
 // VIEWPORT-Y: -1 unconditionally, matching the surface earth's firmware-viewport identity fix (the shell
 // shares the same win-remap; with the surface now at uFlipY=-1 for ALL scenes the limb must follow to stay
 // registered to the earth). ATMO_FLIPY stays the orientation-probe knob (default 1.0 -> shipped -1.0).
 gl.uniform1f(U('uFlipY'),-ATMO_FLIPY);
 gl.uniform1f(U('uLinear'),0.0);
 // ATMO_REAL = verbatim 63d3246d: the color line's gain must be 1.0 so the dual-LUT tail's *8 is the
 // SINGLE verbatim multiply (uAtmoHdr*8 would double-count -> ~8x blowout). uLimbGain=1.0 (no calib).
 gl.uniform1f(U('uAtmoHdr'),ATMO_REAL?1.0:ATMO_HDR);gl.uniform1f(U('uLimbGain'),ATMO_REAL?1.0:limbGainAt());
 gl.uniform3fv(U('c5'),c5);gl.uniform3fv(U('c6'),c6);gl.uniform3fv(U('c7'),c7);gl.uniform3fv(U('c8'),c8);
 gl.uniform4fv(U('fc'),atmoFcArray(a));
 // _AtmSpaceIv (TEXUNIT0): per-scene -> picked scene's LIMB lut; eclipse -> atmo draw's own tex0 RT (tex0atmEcl).
 const aScat=((INSCAT_GEN&&_ipValid&&_ipA.cur)?_ipA.cur.tex:null) || CAP_LIMB || ((INSCAT_PS&&_psScat) ? _psScat : (INSCAT_ECL ? ((ATMO_SOLID&&sharedTex.tex0atmEclSolid)?sharedTex.tex0atmEclSolid:((ATMO_VFLIP&&sharedTex.tex0atmEclFlip)?sharedTex.tex0atmEclFlip:(sharedTex.tex0atmEcl||sharedTex.tex4ecl||scatterTex))) : scatterTex));
 gl.activeTexture(33984);gl.bindTexture(3553,aScat);gl.uniform1i(U('tex0'),0);
 gl.activeTexture(33984+3);gl.bindTexture(3553,aScat);gl.uniform1i(U('tex1'),3);   // f566cf05 OD LUT == tex0 RT (same dim in-scatter)
 const aScatB=(aScat===CAP_LIMB&&CAP_LIMBB)?CAP_LIMBB:aScat; const a0mix=(aScat===CAP_LIMB&&CAP_LIMBB)?CAP_MIX:0.0;
 gl.activeTexture(33984+9);gl.bindTexture(3553,aScatB);gl.uniform1i(U('tex0b'),9);gl.uniform1f(U('uA0Mix'),a0mix);
 const _t14=CAP_T14||sharedTex.tex14, _t15=CAP_T15||sharedTex.tex15;
 gl.activeTexture(33985);gl.bindTexture(3553,_t14);gl.uniform1i(U('aTex14'),1);
 gl.activeTexture(33986);gl.bindTexture(3553,_t15);gl.uniform1i(U('aTex15'),2);
 gl.uniform1f(U('uALut'),(_t14&&_t15)?1.0:0.0);   // verbatim fp 63d3246d display tail when the per-scene LUTs exist
 gl.uniform1f(U('uAtmoReal'),ATMO_REAL?1.0:0.0); gl.uniform1f(U('uWposScale'),1.0); gl.uniform2f(U('uWposBias'),0.0,0.0);   // real f566cf05 screen-space scatter (wpos defaults match the upright web FB)
 gl.uniform1f(U('uWposH'),canvas?canvas.height:1080.0); gl.uniform1f(U('uRcpZero'),(typeof window!=='undefined'&&window.__rcpZero!==undefined)?window.__rcpZero:1.0);
 gl.uniform1f(U('uF566'),(typeof window!=='undefined'&&window.__f566)?1.0:0.0);   // default OFF: the verbatim f566cf05 still renders a too-thick band; iterate behind this flag, ship 63d3246d
 gl.disable(2884); gl.depthMask(false); if(!ATMODEPTH) gl.disable(2929); gl.enable(3042);
 if(ATMO_REAL||ATMO_DSTA){ gl.blendFuncSeparate(773,772,773,772); }   // REAL music-globe atmo blend (live DRAWCALLS: src=ONE_MINUS_DST_ALPHA 773, dst=DST_ALPHA 772): result = atmo*(1-surfA) + surf*surfA, weighted by the surface's HDR-exponent alpha (col0.w). The real compositing law that replaces my additive band.
 else if(ATMO_OVER){ gl.blendFuncSeparate(770,771,1,0); }   // alpha-OVER (atmo*a + surf*(1-a))
 else gl.blendFuncSeparate(1,1,1,0);   // legacy ONE,ONE additive color (the white band)
 let pl=gl.getAttribLocation(aprog,'in_pos');gl.bindBuffer(34962,aMesh.pbuf);gl.enableVertexAttribArray(pl);gl.vertexAttribPointer(pl,4,5126,false,0,0);
 let tl=gl.getAttribLocation(aprog,'in_tc0');gl.bindBuffer(34962,aMesh.tbuf);gl.enableVertexAttribArray(tl);gl.vertexAttribPointer(tl,4,5126,false,0,0);
 gl.bindBuffer(34963,aMesh.ibuf);gl.drawElements(5,aMesh.n,5125,0);
 if(aMesh2&&ATMOBAND&&!ATMO_REAL){   // firmware's SECOND 3f6eeb47 draw (inner disc-side band). OMITTED for
   // ATMO_REAL: re-enabling it under the web's no-depth shell (clip.z=0) brings back the GIANT BAND (user
   // regression report 2026-06-11) because it glows over the disc un-occluded. The thin dashed seam it would
   // bridge is a separate main-shell artifact to be fixed by the real screen-space f566cf05 port, NOT by
   // re-adding this band. Keep it off until depth-occlusion or the f566cf05 port lands.
   gl.bindBuffer(34962,aMesh2.pbuf);gl.vertexAttribPointer(pl,4,5126,false,0,0);
   gl.bindBuffer(34962,aMesh2.tbuf);gl.vertexAttribPointer(tl,4,5126,false,0,0);
   gl.bindBuffer(34963,aMesh2.ibuf);gl.drawElements(5,aMesh2.n,5125,0);
 }
 gl.disable(3042); gl.depthMask(true); gl.blendFunc(1,1); if(!ATMODEPTH) gl.enable(2929);
}
function atmoAt(t){ const F=ATMO_SCENE; if(!F||!F.length)return null; if(t<=F[0].t)return F[0]; if(t>=F[F.length-1].t)return F[F.length-1];
  for(let i=0;i<F.length-1;i++){const a=F[i],b=F[i+1]; if(t>=a.t&&t<=b.t){const w=(t-a.t)/((b.t-a.t)||1);
    const o={}; for(const k of ATMO_KEYS){const va=a[k],vb=b[k]; o[k]=va&&vb?va.map((x,j)=>x+(vb[j]-x)*w):va;}
    o.fc=(w<0.5?a.fc:b.fc)||a.fc||b.fc;   // real atmo fp consts (per-scene static; nearest row)
    return o;}}
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
let REALDUR=true;    // cap2: play each scene over its REAL captured duration ((frame1-frame0)/30fps) so the camera moves at the firmware's real rate (MPGlobe.realdur=false -> uniform SCENE_SECS)
let SCENE_CAP=240;   // REALDUR playback clamped to [10s, SCENE_CAP s]. MEASURED from the reference recording
                     // (Recording 2026-06-07): real scenes run 79-230s, so 240 keeps every real duration intact
                     // (the earlier 30s cap made the cycle ~5-10x too fast vs the real XMB). Dead static scenes
                     // are skipped (SCENE_SKIP) so long playback can no longer freeze. MPGlobe.sceneCap tunable.
let SCENE_SECS=60;   // wall-seconds per scene before advancing (tunable via MPGlobe.sceneSecs). The within-scene
                     // camera path is the REAL captured motion; the old 18s played it 4-13x too fast vs the real
                     // per-scene durations (~80-236s, un-dumped sequencer) = the "too fast/erratic" the user saw.
                     // 60s is slower/smooth (still an APPROX of the un-dumped duration; flagged, tunable).
let DBG=0;           // debug output selector (MPGlobe.dbg): 1=earth 2=clouds 3=sd-direction
let ENC=3;           // DEFAULT 3=VALIDATED firmware curve composite (also the GLOW-off fallback). 0=interim Reinhard, 1=verbatim ramp-encoded (MPGlobe.enc)
let SLUM=0.30;       // calibration: colored HDR r2 -> tonemap-curve domain (MPGlobe.slum); tuned via CDP vs the real present
                     // NOTE: the GLOW composite path uses its own calibrated SLUM (~0.15) -- set by MPGlobe.glow defaults below.
let ATMO_ONLY=0;     // render only the atmosphere shell over black (MPGlobe.atmoOnly) -- for color validation
let USE_CAP=true;    // 2026-06-09 cap2: coherent full-cycle capture (11 scenes) with REAL per-frame camera + in-scatter + limb LUTs, validated vs presents (per-scene color/camera/limb match). Brightness ~1.5x dim (glint pending). MPGlobe.usecap.
                     // Cameras are real/correct, but the surface fp renders raw captured fc too dark for some scenes (port-correctness gap) -> staged OFF until the fp is fixed + validated vs the captured presents.
let USE_COH=true;    // DEFAULT = coherent set (9 scenes) + aligned atmosphere limb (verified cyan Rayleigh).
                     // QA confirmed BOTH sets overexpose equally at bright moments under the interim Reinhard
                     // tonemap (fc_cap5 scene0=0.21, coherent 0.16-0.27) -- the HDR decode (DRAW 18) is the
                     // shared fix. Since overexposure is identical either way, the coherent set is strictly closer
                     // to 1:1 (it ADDS the atmosphere limb the real globe has). Reverts to fc_cap5 via
                     // MPGlobe.coherent=false. Correct exposure ships when the decode lands (GLOBE_FINISH_PROCEDURE).
function setFC(){ curFC = (SCENE_FC && SCENES_IDX && SCENES_IDX[sceneIdx] && SCENE_FC[String(SCENES_IDX[sceneIdx].scene)]) || null;
 ATMO_SCENE = (ATMO_SCENES && ATMO_SCENES[sceneIdx]) || null;
 SCENE_HAS_TONE = !TONELUT_PS || !!(CAP_SCENE_TONE && SCENES_IDX && SCENES_IDX[sceneIdx] && (CAP_SCENE_TONE[String(SCENES_IDX[sceneIdx].scene)]||[]).length); }
const SCENE_KEYS=['260','261','262','263','264','265','266','267','268','269','270','271','454','455','456','457','458','459','460','461','462','463','464','465','466','467'];   // 266/267 = the REAL zoom rows (were MISSING: scenes framed with the static pose - the intermittent wide-arc bug)
const HOLD_KEYS=new Set(['463','464','465','466','467']);   // STEPPED consts (LOD geomorph vc21 + tile UV transforms): the firmware switches them discretely; LERPING mid-step makes an invalid geomorph/UV for a window = spiky vertices + black tile checkerboard. Hold-previous instead.
function sceneAt(F,t){
  if(t<=F[0].t)return F[0]; if(t>=F[F.length-1].t)return F[F.length-1];
  for(let i=0;i<F.length-1;i++){const a=F[i],b=F[i+1]; if(t>=a.t&&t<=b.t){const w=(t-a.t)/((b.t-a.t)||1);
    const o={}; for(const k of SCENE_KEYS){const va=a[k],vb=b[k]; o[k]=va&&vb?(HOLD_KEYS.has(k)?va:va.map((x,j)=>x+(vb[j]-x)*w)):va;}
    if(a.fr!==undefined&&b.fr!==undefined) o.fr=a.fr+(b.fr-a.fr)*w;   // capture-frame of this playback moment (aligns LUT selection exactly, incl. trimmed rows)
    if(a.fc&&b.fc&&a.fc.length===b.fc.length){   // LERP the per-row surface fp consts: the rows are per-frame samples of CONTINUOUS lighting (sun/HDR); nearest-row snapping made the shadow/terminator STEP visibly (user report idx 6/8)
      o.fc=a.fc.map((va,i)=>{const vb=b.fc[i]; return (va&&vb&&va.length===vb.length)?va.map((x,j)=>x+(vb[j]-x)*w):(va||vb);});
    } else if(a.fc||b.fc) o.fc=(w<0.5?(a.fc||b.fc):(b.fc||a.fc));
    return o;}}
  return F[F.length-1];
}
// Collapse capture-artifact STATIC HOLDS: the firmware globe sat frozen for stretches (inactive
// globe) so consecutive captured rows are bit-identical; played back compressed this looked like
// random FREEZING then a lurch. Dropping rows identical to the previous kept row makes playback
// interpolate smoothly between the real distinct captured states across the hold instead.
function trimStaticRows(F){
  if(!F||F.length<3) return F;
  const same=(a,b)=>{ for(const k of SCENE_KEYS){ const va=a[k],vb=b[k]; if(!va!==!vb) return false;
    if(va&&vb){ if(va.length!==vb.length) return false; for(let j=0;j<va.length;j++) if(Math.abs(va[j]-vb[j])>1e-3) return false; } } return true; };
  const keep=[F[0]];
  for(let i=1;i<F.length-1;i++){ if(!same(keep[keep.length-1],F[i])) keep.push(F[i]); }
  keep.push(F[F.length-1]);
  return keep;
}
function tick(){
  if(!running||!D||!eMesh||got<want) return false;
  if(SCENES&&SCENES.length){            // replay captured scenes (camera + lighting), cycling
    // Each scene plays its captured camera path (t 0..1) over SCENE_SECS wall-seconds, then advances.
    // The real per-scene durations (the un-dumped top-level sequencer) range 80..236s; that is too slow
    // to perceive cycling, so we play each scene over a uniform, visible duration. SCENE_SECS is tunable
    // (MPGlobe.sceneSecs); the WITHIN-scene camera motion is the exact captured path, only its playback
    // speed is normalized.
    // Playback span. REALDUR (default, cap2): play each scene's captured camera path over its REAL
    // duration = (frame1-frame0)/30fps, so the within-scene camera moves at the firmware's real rate
    // (fixes "motion too fast/erratic" - the uniform 60s sped the long cinematic scenes up 3-5x and
    // slowed the short ones). *2 = 30fps-real -> 60fps-web ticks. Falls back to SCENE_SECS otherwise.
    const F=SCENES[sceneIdx];
    const _si=(REALDUR&&SCENES_IDX&&SCENES_IDX[sceneIdx])?SCENES_IDX[sceneIdx]:null;
    const span=_si?Math.min(SCENE_CAP*60,Math.max(600,(_si.frame1-_si.frame0)*2)):SCENE_SECS*60;   // clamp to [10s, SCENE_CAP s] (camera path faithful; only time-scaling normalized so it is never frozen)
    const s=sceneAt(F,animT); for(const k of SCENE_KEYS){ if(s[k]) D.shared[k]=s[k]; }
    if(s.fc) curFC=s.fc;   // per-row captured fp consts override the per-scene mid-row set
    if(USE_CAP){
      // bind this scene's REAL captured in-scatter (surface tex4) + limb (atmo tex0) LUT at the
      // nearest captured frame; draw the limb only where both the LUT and the per-scene atmo consts
      // exist (scenes 0-5). Scenes without captured LUTs -> CAP_LUT/CAP_LIMB null = static + no limb.
      const cl=capSceneLut(sceneIdx,animT,s.fr);
      CAP_LUT = cl?cl.surf:null; CAP_LIMB = cl?cl.limb:null; CAP_LUTB=cl?cl.surfB:null; CAP_LIMBB=cl?cl.limbB:null; CAP_MIX=cl?(cl.mix||0):0;
      ATMO = (CAP_LIMB && ATMO_SCENE) ? 1 : 0;
      if(TONELUT_PS){ const ct=capSceneTone(sceneIdx,animT,s.fr); CAP_T14=ct?ct.t14:null; CAP_T15=ct?ct.t15:null; }
      else { CAP_T14=null; CAP_T15=null; }
    }
    draw();
    const _scN=(SCENES_IDX&&SCENES_IDX[sceneIdx])?SCENES_IDX[sceneIdx].scene:sceneIdx;
    let _fade=fadeFactor(animT, span/60);   // dip-to-black at scene boundaries (fade length = FADE_SECS of THIS scene's real duration)
    if(SCENE0_LOOP && _scN===0 && s0exit) _fade=Math.min(_fade, s0exitF);   // scene-0 exit dip (held lit view fades to black, then we advance)
    drawFade(_fade);
    if(USE_CAP && (animT>0.8 || (SCENE0_LOOP&&_scN===0&&s0exit))){   // prefetch the NEXT scene's first bins during this scene's tail/fade (incl. scene 0's exit dip) so its limb+tonemap are ready at the cut
      let ns=sceneIdx,g=0; do{ ns=(ns+1)%SCENES.length; }while(SCENE_SKIP&&SCENE_SKIP.has(ns)&&++g<SCENES.length);
      capSceneLut(ns,0); if(TONELUT_PS) capSceneTone(ns,0);
    }
    if(SCENE0_LOOP && _scN===0){
      if(!s0exit){
        // PING-PONG over the clean lit range: forward to S0_T1, reverse to S0_T0. After SCENE0_DWELL frames,
        // begin the exit dip at the NEXT calm turnaround (a bound) so the held view never jumps the camera.
        animT += s0dir*(1/span);
        let atBound=false;
        if(animT>=S0_T1){ animT=S0_T1; s0dir=-1; atBound=true; }
        else if(animT<=S0_T0){ animT=S0_T0; s0dir=1; atBound=true; }
        s0frames++;
        if(SCENE0_DWELL>0 && s0frames>=SCENE0_DWELL && atBound){ s0exit=1; }   // hold animT at this bound through the dip
      } else {
        // hold the lit view (already at a bound) and ramp the dip to black over FADE_SECS, then advance to
        // scene 1 (its own fadeFactor fades it IN from black = a smooth dip-to-black cut, the firmware style).
        s0exitF -= 1/Math.max(1,FADE_SECS*60);
        if(s0exitF<=0){ s0exitF=1.0; s0exit=0; s0frames=0;
          let g=0; do{ sceneIdx=(sceneIdx+1)%SCENES.length; }while(SCENE_SKIP&&SCENE_SKIP.has(sceneIdx)&&++g<SCENES.length); setFC(); animT=0; s0dir=1; }
      }
    } else {
      animT += 1/span;
      if(animT>1){ animT=0; let g=0; do{ sceneIdx=(sceneIdx+1)%SCENES.length; }while(SCENE_SKIP&&SCENE_SKIP.has(sceneIdx)&&++g<SCENES.length); setFC();
        if(SCENE0_LOOP && SCENES_IDX&&SCENES_IDX[sceneIdx]&&SCENES_IDX[sceneIdx].scene===0){ animT=S0_T0; s0dir=1; s0frames=0; s0exit=0; s0exitF=1.0; } }   // enter scene 0 already lit (skip the from-black fade-in), reset the dwell timer
    }
    return true;
  }
  if(!PATHS||!preset) return false;     // fallback: firmware camera.path (camera only)
  const kfs=preset.kf, tmax=kfs[kfs.length-1].t;
  const cf=interp(kfs,animT), asp=(canvas.width/canvas.height)||(16/9);
  const m=lookAtMVP(cf.eye,cf.center,cf.up,cf.fovy,asp);
  D.shared['260']=m.c260; D.shared['261']=m.c261; D.shared['262']=m.cw; D.shared['263']=m.cw; D.shared['460']=m.eye;
  draw();
  drawFade(fadeFactor(animT/tmax));
  animT += 0.242;
  if(animT>tmax){ animT=0; presetIdx=(presetIdx+1)%PRESETS.length; preset=pickPreset(presetIdx); }
  return true;
}

async function load(){
 D=await fetch(BASE+'full_surface.json').then(r=>r.json());
 black=blackTex(); black0=black0Tex();
 sharedTex.tex4=texF32(BASE+'full_tex/t04_f32.bin',256,128);
 sharedTex.tex5=texF32(BASE+'full_tex/t05_f32.bin',256,1);
 sharedTex.tex6=texF32(BASE+'full_tex/t06_f32.bin',64,64);
 // Gaia atmospheric-scattering LUTs (REAL firmware, extracted from earth.qrc) for the per-frame in-scatter
 // gloss generation (replaces the static t04). odLut=optical-depth/transmittance 256(sun-elev)x40(shell);
 // ieFull=irradiance-on-earth LUT 256, UNCLAMPED (real HDR night values). Loaded now; wired by the in-scatter pass.
 sharedTex.odLut=texF32(BASE+'gaia_lut/od_lut_256x40_rgba_f32_le.bin',256,40);
 // in-scatter generator inputs: the static BicubicTable (REPEAT set at use) + seeds (per-scene;
 // the tz_* pair = the live-dumped timezone seeds, the generator's validation reference)
 texBicubic=texF32(BASE+'gaia_lut/bicubic_table_128x1_rgba_f32.bin',128,1,1);
 texSeedA=texF32(BASE+'gaia_lut/tz_seedA_40x40_rgba_f32.bin',40,40,1);
 texSeedB=texF32(BASE+'gaia_lut/tz_seedB_40x20_rgba_f32.bin',40,20,1);
 sharedTex.ieFull=texF32(BASE+'gaia_lut/ie_lut_256x1_rgba_f32_le.bin',256,1);
 sharedTex.tex4ecl=texF32(BASE+'gaia_lut/inscatter_eclipse_tex4_256x128_rgba_f32_le.bin',256,128);  // eclipse SURFACE fp tex4 (real RT ac6f80000; mostly black, warm sliver at V=1)
 // eclipse ATMOSPHERE SHELL _AtmSpaceIv = the atmo draw's OWN tex0 RT (ac6e80000), a broad warm+cyan scatter
 // (50.6% nonzero, peak V=0.48). This is a DIFFERENT RT from the surface tex4 (ac6f80000, 6.5% nonzero). The
 // limb shell MUST sample this one (the surface tex4 is nearly black -> limb rendered nothing). Both extracted
 // from /mnt/c/rpcs3dev/xmb_dump2/ecl2 (atmo draw vp=0x3f6eeb47 tex0=0x06e80000 vs surface vp=0x0f331863 tex4=0x06f80000).
 sharedTex.tex0atmEcl=texF32(BASE+'gaia_lut/atmospace_eclipse_atm_tex0_256x128_rgba_f32_le.bin',256,128);
 sharedTex.tex0atmEclFlip=texF32(BASE+'gaia_lut/atmospace_eclipse_atm_tex0_256x128_rgba_f32_le_flip.bin',256,128);  // V-flipped variant (orientation probe)
 sharedTex.tex0atmEclSolid=texF32(BASE+'gaia_lut/atmospace_eclipse_atm_tex0_256x128_rgba_f32_le_SOLID.bin',256,128);  // solid-warm debug LUT (shader-math probe)
 // the captured 128x128 sun-disc/burst shape sprite (RGBA8, real firmware texture) for GlobeBurst tex0
 { const t=gl.createTexture(); gl.bindTexture(3553,t); gl.texImage2D(3553,0,6408,1,1,0,6408,5121,new Uint8Array([0,0,0,255]));
   fetch(BASE+'gaia_lut/sundisc_128_rgba.bin').then(r=>{if(!r.ok)throw 0;return r.arrayBuffer();}).then(ab=>{ if(!gl)return;
     gl.bindTexture(3553,t); gl.texImage2D(3553,0,6408,128,128,0,6408,5121,new Uint8Array(ab));
     gl.texParameteri(3553,10241,9729);gl.texParameteri(3553,10240,9729);gl.texParameteri(3553,10242,33071);gl.texParameteri(3553,10243,33071); t.loaded=true; }).catch(()=>{});
   sharedTex.sundisc=t; }
 // PER-SCENE in-scatter manifest (32 captured scenes). Lazy-load each scene's LUTs on demand (do NOT preload).
 fetch(BASE+'gaia_lut/inscatter/manifest.json').then(r=>r.ok?r.json():null).then(m=>{INSCAT_MANIFEST=m;}).catch(()=>{INSCAT_MANIFEST=null;});
 // REAL fp16 HDR tonemap LUTs (RTDUMP'd ac2b90000/ac2b70000, Y16_X16_FLOAT, max ~7.86) -- replaces
 // the old 8-bit t14/t15.png which clipped the HDR. tex15 row0 .y = the validated tonemap CURVE.
 sharedTex.tex14=texF16(BASE+'lut14_rgba32f_128.bin',128,128);
 glowSprite=texPNG(BASE+'glow_sprite.png');
 sharedTex.tex15=texF16(BASE+'lut15_rgba32f_128.bin',128,128);
 // seamless firmware cube-maps (replace the per-patch tile assembly)
 sharedTex.earthCube=cubeTex('earth');
 sharedTex.cloudsCube=cubeTex('clouds');
 sharedTex.maskCube=cubeTex('mask');
 // FAITHFUL per-patch tiles: each of the 24 patches has its own 4 firmware tiles (t00-t03 = fp tex0-3).
 // This is what the real surface fp samples (TEX2D(0,tc0.xy) etc); replaces the lossy single cube map.
 patchTex={};
 for(const p of D.patches){ const s3=String(p.idx).padStart(3,'0');
   patchTex[p.idx]=[texPNGmip(BASE+'full_tex/p'+s3+'_t00.png',8),texPNGmip(BASE+'full_tex/p'+s3+'_t01.png',8),
                    texPNGmip(BASE+'full_tex/p'+s3+'_t02.png',2),texPNGmip(BASE+'full_tex/p'+s3+'_t03.png',1)]; }
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
 // BASE EARTH LAYER mesh: a continuous unit UV-sphere (notch backfill behind the per-patch tiles).
 { const sU=256,sV=128,dirs=[],bi=[];
   for(let v=0;v<=sV;v++){ const phi=Math.PI*v/sV;
     for(let u=0;u<=sU;u++){ const th=2*Math.PI*u/sU;
       dirs.push(Math.sin(phi)*Math.cos(th), Math.cos(phi), Math.sin(phi)*Math.sin(th)); } }
   for(let v=0;v<sV;v++)for(let u=0;u<sU;u++){ const a=v*(sU+1)+u,b=a+sU+1; bi.push(a,b,a+1, a+1,b,b+1); }
   const bpb=gl.createBuffer();gl.bindBuffer(34962,bpb);gl.bufferData(34962,new Float32Array(dirs),35044);
   const bib=gl.createBuffer();gl.bindBuffer(34963,bib);gl.bufferData(34963,new Uint16Array(bi),35044);
   baseMesh={pb:bpb,ib:bib,n:bi.length}; }
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
   try{
     const [bp,bt,bi]=await Promise.all([
       fetch(BASE+'mesh/c0b_pos.bin').then(r=>r.arrayBuffer()),
       fetch(BASE+'mesh/c0b_tc0.bin').then(r=>r.arrayBuffer()),
       fetch(BASE+'mesh/c0b_idx.bin').then(r=>r.arrayBuffer())]);
     const bpb=gl.createBuffer();gl.bindBuffer(34962,bpb);gl.bufferData(34962,new Float32Array(bp),35044);
     const btb=gl.createBuffer();gl.bindBuffer(34962,btb);gl.bufferData(34962,new Float32Array(bt),35044);
     const bib=gl.createBuffer();gl.bindBuffer(34963,bib);gl.bufferData(34963,new Uint32Array(bi),35044);
     aMesh2={pbuf:bpb,tbuf:btb,ibuf:bib,n:new Uint32Array(bi).length};
   }catch(e){ aMesh2=null; }
   scatterTex=texF32(BASE+'win_tex/t04_f32.bin',256,128);
   const AC=await fetch(BASE+'c3000_consts.json').then(r=>r.json());
   fcAtmo=new Float32Array(17*4);for(let i=0;i<17;i++){const v=(AC.fc_atmo&&AC.fc_atmo[i])||[0,0,0,0];fcAtmo[i*4]=v[0];fcAtmo[i*4+1]=v[1];fcAtmo[i*4+2]=v[2];fcAtmo[i*4+3]=v[3];}
 }catch(e){ aMesh=null; }
 PATHS=await fetch(BASE+'camera_paths.json').then(r=>r.json());
 presetIdx=7; preset=pickPreset(presetIdx); animT=0;
 // Per-scene replays (camera + lighting). DEFAULT = fc_cap5 clean set (scene_NN), no overexposure.
 // USE_COH = coherent set (scene_NN_coh) + ALIGNED atmosphere (atmo_scene_NN_coh) -- the limb shell registers
 // to the earth, but the coherent set's brighter scenes overexpose under the interim tonemap (decode pending).
 const SUF = USE_CAP ? '_cap2' : (USE_COH ? '_coh' : '');
 try{ const idx=(await fetch(BASE+'scenes_index'+SUF+'.json').then(r=>r.json())).filter(s=>!s.skip);
   SCENES_IDX=idx;
   SCENES=await Promise.all(idx.map(s=>fetch(BASE+s.file).then(r=>r.json()))); sceneIdx=0; animT=0;
   SCENES=SCENES.map(trimStaticRows);   // collapse frozen capture stretches (see trimStaticRows)
   // SKIP degenerate scenes: a scene with no perceptible captured motion is a capture artifact (the
   // inactive-globe freeze: shipped scene 0 = 318s whose consts drift ~1e-4 total = renders pixel-
   // identical; real scenes measure 30+) or a 2-row transition fragment - playing one shows a dead
   // globe for up to 30s ("no movement at all").
   const motionOf=F=>{ if(!F) return 0; let m=0;
     for(let i=1;i<F.length;i++){ for(const k of SCENE_KEYS){ const a=F[i-1][k],b=F[i][k];
       if(a&&b) for(let j=0;j<a.length;j++) m+=Math.abs(b[j]-a[j]); } } return m; };
   SCENE_SKIP=new Set(); SCENES.forEach((F,i)=>{ if(!F||F.length<3||motionOf(F)<1.0) SCENE_SKIP.add(i); });
   if(SCENE_SKIP.size>=SCENES.length) SCENE_SKIP.clear();
   while(SCENE_SKIP.has(sceneIdx)) sceneIdx=(sceneIdx+1)%SCENES.length;   // start on the first real scene
   try{ SCENE_FC=await fetch(BASE+'scene_fc'+SUF+'.json').then(r=>r.json()); }catch(e){ SCENE_FC=null; }
   if(USE_COH && !USE_CAP){ ATMO_SCENES=await Promise.all(idx.map(s=>fetch(BASE+'atmo_scene_'+String(s.scene).padStart(2,'0')+'_coh.json').then(r=>r.ok?r.json():null).catch(()=>null))); ATMO=1; }
   else if(USE_CAP){
     // cap2 set (2026-06-09 coherent full-cycle capture): every scene has its REAL per-frame in-scatter
     // (ac6f80000) + limb (ac6e80000) RTs + atmosphere-draw consts (atmo_scene_NN_cap2, vp 3f6eeb47),
     // captured continuously (RT dump works even minimized). The limb draws per-scene where both a limb
     // LUT and atmo consts exist (all scenes here); tick() binds each frame's nearest captured LUT.
     try{
       CAP_SCENE_LUTS=await fetch(BASE+'cap_scene_luts2.json').then(r=>r.ok?r.json():null).catch(()=>null);
       if(CAP_SCENE_LUTS) CAP_LUT_CACHE={};   // lazy: capSceneLut() loads each scene's nearest bin on demand (non-blocking; avoids preloading ~345MB)
     }catch(e){ CAP_SCENE_LUTS=null; }
     // per-scene surface-fp tonemap LUTs (brightness fix); loaded if present, gated by TONELUT_PS. 128x128 rgba32f (ch0/ch1).
     try{
       // per-scene burst rows (vp window consts + fp consts of the sun-disc draw) + the captured fan geometry
       if(typeof window!=='undefined')(window.__ld=window.__ld||[]).push('burst');
       BURST_FAN=await fetch(BASE+'burst_fan65.json').then(r=>r.ok?r.json():null).catch(()=>null);
       if(BURST_FAN&&SCENES_IDX){ FLARE_SCENES={};
         await Promise.all(SCENES_IDX.map(s=>fetch(BASE+'flare_scene_'+String(s.scene).padStart(2,'0')+'_cap2.json')
           .then(r=>r.ok?r.json():null).then(j=>{ if(j) FLARE_SCENES[String(s.scene)]=j; }).catch(()=>null))); }
       if(typeof window!=='undefined')window.__ld.push('seeds');
       SEED_MANIFEST=await fetch(BASE+'gaia_lut/seeds_cap3/seeds_manifest.json').then(r=>r.ok?r.json():null).catch(()=>null);
       FLARE_ROWS=await fetch(lfsURL('flares_gcap3.json')).then(r=>r.ok?r.json():null).catch(()=>null);   // globecap3-aligned flare billboards (LFS on Pages)
       FAITH_POLICY=await fetch(BASE+'faithful_policy.json').then(r=>r.ok?r.json():null).catch(()=>null);
       if(typeof window!=='undefined')window.__ld.push('glare');
       GLARE_ROWS=await fetch(BASE+'glare_gcap3_rows.json').then(r=>r.ok?r.json():null).catch(()=>null);   // globecap3-aligned (same capture as the presents + the proven fan-window layout)
       TRANS_TABLE=await fetch(BASE+'transition_table.json').then(r=>r.ok?r.json():null).catch(()=>null);
       // per-frame bloom-of-display chain rows (encode FC + blur kernel + combine scalars, all animated per frame)
       if(SCENES_IDX){ BLOOM_SCENES={};
         await Promise.all(SCENES_IDX.map(s=>fetch(BASE+'bloom_scene_'+String(s.scene).padStart(2,'0')+'_cap2.json')
           .then(r=>r.ok?r.json():null).then(j=>{ if(j) BLOOM_SCENES[String(s.scene)]=j; }).catch(()=>null))); }
       if(typeof window!=='undefined')window.__ld.push('tone');
       CAP_SCENE_TONE=await fetch(BASE+'cap_scene_tonelut.json').then(r=>r.ok?r.json():null).catch(()=>null);
       if(CAP_SCENE_TONE) CAP_TONE_CACHE={};   // lazy: capSceneTone() loads on demand (non-blocking)
     }catch(e){ CAP_SCENE_TONE=null; if(typeof window!=='undefined')window.__ldErr=''+e; }
     ATMO_SCENES=await Promise.all(idx.map(s=>fetch(BASE+'atmo_scene_'+String(s.scene).padStart(2,'0')+'_cap2.json').then(r=>r.ok?r.json():null).catch(()=>null)));
     ATMO=0;   // per-scene gated in tick() (1 only when the scene has both a limb LUT and atmo consts)
   }
   else { ATMO_SCENES=null; ATMO=0; }
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
   baseProg=gl.createProgram();gl.attachShader(baseProg,sh(35633,BASE_VS));gl.attachShader(baseProg,sh(35632,BASE_FS));gl.linkProgram(baseProg);
   if(!gl.getProgramParameter(baseProg,gl.LINK_STATUS)){errlog+=gl.getProgramInfoLog(baseProg);}
   // GLOW composite program + fullscreen VAO (gated path; harmless if GLOW stays off)
   cprog=gl.createProgram();gl.attachShader(cprog,sh(35633,C_VS));gl.attachShader(cprog,sh(35632,C_FS));gl.linkProgram(cprog);
   if(!gl.getProgramParameter(cprog,gl.LINK_STATUS)){errlog+=' composite link: '+gl.getProgramInfoLog(cprog);}
   else { gl.useProgram(cprog); gl.uniform1f(gl.getUniformLocation(cprog,'uEarthGain'),1.0); }   // display weight default; only the faithful bloom composite changes it (and restores)
   // verbatim GlareSource bright-pass that feeds the bloom (only over-display-range energy blooms)
   gsProg=gl.createProgram();gl.attachShader(gsProg,sh(35633,C_VS));gl.attachShader(gsProg,sh(35632,GS_FS));gl.linkProgram(gsProg);
   if(!gl.getProgramParameter(gsProg,gl.LINK_STATUS)){errlog+=' glaresrc link: '+gl.getProgramInfoLog(gsProg);}
   encProg=gl.createProgram();gl.attachShader(encProg,sh(35633,C_VS));gl.attachShader(encProg,sh(35632,ENC_FS));gl.linkProgram(encProg);
   if(!gl.getProgramParameter(encProg,gl.LINK_STATUS)){errlog+=' encode link: '+gl.getProgramInfoLog(encProg);encProg=null;}
   ipUpProg=gl.createProgram();gl.attachShader(ipUpProg,sh(35633,C_VS));gl.attachShader(ipUpProg,sh(35632,IPUP_FS));gl.linkProgram(ipUpProg);
   if(!gl.getProgramParameter(ipUpProg,gl.LINK_STATUS)){errlog+=' ipup link: '+gl.getProgramInfoLog(ipUpProg);ipUpProg=null;}
   ipCombineProg=gl.createProgram();gl.attachShader(ipCombineProg,sh(35633,C_VS));gl.attachShader(ipCombineProg,sh(35632,IPCOMB_FS));gl.linkProgram(ipCombineProg);
   if(!gl.getProgramParameter(ipCombineProg,gl.LINK_STATUS)){errlog+=' ipcomb link: '+gl.getProgramInfoLog(ipCombineProg);ipCombineProg=null;}
   starProg=gl.createProgram();gl.attachShader(starProg,sh(35633,STAR_VS));gl.attachShader(starProg,sh(35632,STAR_FS));gl.linkProgram(starProg);
   starTexProg=gl.createProgram();gl.attachShader(starTexProg,sh(35633,STARTEX_VS));gl.attachShader(starTexProg,sh(35632,STARTEX_FS));gl.linkProgram(starTexProg);
   // star skybox cube: 6 faces, each a quad (texcoord 0..1, tiled in the VS); inside-out, no cull
   { const F=[ [[1,-1,-1],[1,-1,1],[1,1,1],[1,1,-1]], [[-1,-1,1],[-1,-1,-1],[-1,1,-1],[-1,1,1]],
               [[-1,1,-1],[1,1,-1],[1,1,1],[-1,1,1]], [[-1,-1,1],[1,-1,1],[1,-1,-1],[-1,-1,-1]],
               [[1,-1,1],[-1,-1,1],[-1,1,1],[1,1,1]], [[-1,-1,-1],[1,-1,-1],[1,1,-1],[-1,1,-1]] ];
     const TC=[[0,0],[1,0],[1,1],[0,1]]; const v=[];
     for(const f of F){ for(const i of [0,1,2,0,2,3]){ v.push(f[i][0],f[i][1],f[i][2],TC[i][0],TC[i][1]); } }
     starBoxBuf=gl.createBuffer(); gl.bindBuffer(34962,starBoxBuf); gl.bufferData(34962,new Float32Array(v),35044); }
   starCube=starCubeTex(BASE+'gaia_lut/starfield.png');   // legacy cube (kept for fallback)
   star2D=star2DTex(BASE+'gaia_lut/starfield.png');       // real firmware star texture, REPEAT+mipmap for tiling
   sunDiscProg=gl.createProgram();gl.attachShader(sunDiscProg,sh(35633,SUNDISC_VS));gl.attachShader(sunDiscProg,sh(35632,SUNDISC_FS));gl.linkProgram(sunDiscProg);
   fadeProg=gl.createProgram();gl.attachShader(fadeProg,sh(35633,FADE_VS));gl.attachShader(fadeProg,sh(35632,FADE_FS));gl.linkProgram(fadeProg);
   if(!gl.getProgramParameter(fadeProg,gl.LINK_STATUS)){errlog+=' fade link: '+gl.getProgramInfoLog(fadeProg);}
   if(!gl.getProgramParameter(sunDiscProg,gl.LINK_STATUS)){errlog+=' sundisc link: '+gl.getProgramInfoLog(sunDiscProg);}
   if(!gl.getProgramParameter(starProg,gl.LINK_STATUS)){errlog+=' star link: '+gl.getProgramInfoLog(starProg);}
   glowVAO=gl.createVertexArray();
   if(!D) load().catch(e=>console.warn('MPGlobe load:',e));   // fetch assets once
 },
 tick,                                   // music loop calls this each frame, then drawImage(canvas)
 ready(){ return !!(running && D && eMesh && got>=want); },
 gotwant(){ return got+'/'+want; },
 stop(){ running=false; },
 set sceneSecs(v){ SCENE_SECS=v; }, set realdur(v){ REALDUR=!!v; }, get realdur(){ return REALDUR; },
 set sceneCap(v){ SCENE_CAP=+v; }, get sceneCap(){ return SCENE_CAP; },   // max wall-seconds a scene may take (camera never frozen)
 get sceneSecs(){ return SCENE_SECS; },
 set fadeSecs(v){ FADE_SECS=+v; },
 get fadeSecs(){ return FADE_SECS; },
 _setScene(i){ if(SCENES){ sceneIdx=((i%SCENES.length)+SCENES.length)%SCENES.length; animT=0; setFC(); } },  // diagnostic: force a scene
 nextScene(){ if(!SCENES) return -1; let g=0; do{ sceneIdx=(sceneIdx+1)%SCENES.length; }while(SCENE_SKIP&&SCENE_SKIP.has(sceneIdx)&&++g<SCENES.length); animT=0; setFC(); return SCENES_IDX&&SCENES_IDX[sceneIdx]?SCENES_IDX[sceneIdx].scene:sceneIdx; },   // user F-key: skip to the next scene
 get debugState(){ const si=SCENES_IDX&&SCENES_IDX[sceneIdx]?SCENES_IDX[sceneIdx]:null;
   return { scene: si?si.scene:null, sceneIdx: sceneIdx, t: +animT.toFixed(3),
            frame: si?Math.round(si.frame0+animT*((si.frame1-si.frame0)||1)):null,
            bloom: BLOOMDISP, faithauto: FAITH_AUTO, atmo: ATMO, scenes: SCENES?SCENES.length:0 }; },   // user D-key overlay
 _setT(t){ animT=t; },
 _render(obj){ if(!D)return; running=false;        // inject exact-frame consts + draw (decode/validation)
   for(const k in (obj.shared||{})) D.shared[k]=obj.shared[k];
   if(obj.fc) curFC=obj.fc;
   if(obj.atmo){ const a={t:0}; for(const k in obj.atmo) a[k]=obj.atmo[k]; ATMO_SCENE=[a,Object.assign({},a,{t:1})]; ATMO=1; } else { ATMO=0; }
   animT=0.0; draw(); },
 _redraw(){ if(!D)return; running=false; draw(); return 'ok'; },   // redraw at the CURRENT state (after toggling ATMO etc.) -- isolation validation
 _camKeep(shared){ if(!D)return; running=false;   // override the camera consts (surface AND atmo shell) and redraw, keeping the scene assets (LUT/fc/atmo-scatter) from a prior _frame -- exact-camera 1:1 structural validation
   for(const k in (shared||{})) D.shared[k]=shared[k];
   if(ATMO_SCENE&&ATMO_SCENE.length){ for(const e of ATMO_SCENE){ for(const k in (shared||{})) e[k]=shared[k]; } }   // keep the atmo shell registered to the same camera as the surface
   animT=animT; draw(); return 'ok'; },
 _renderKeep(obj){ if(!D)return;        // inject exact-frame consts + draw WITHOUT running=false (offscreen-CDP safe)
   for(const k in (obj.shared||{})) D.shared[k]=obj.shared[k];
   if(obj.fc) curFC=obj.fc;
   if(obj.atmo){ const a={t:0}; for(const k in obj.atmo) a[k]=obj.atmo[k]; ATMO_SCENE=[a,Object.assign({},a,{t:1})]; ATMO=1; }
   animT=0.0; draw(); return 'ok'; },
 _frame(sid,t){ if(!SCENES||!SCENES.length||!D) return 'no scenes';   // diagnostic: render exactly tick()'s
   running=false;                                                     // path frozen at (sid,t), no fade/advance
   sceneIdx=((sid%SCENES.length)+SCENES.length)%SCENES.length; animT=t;
   setFC();   // per-scene fc + ATMO_SCENE (without this the PREVIOUS scene's atmo shell/sun consts leak in)
   const F=SCENES[sceneIdx]; const s=sceneAt(F,animT); for(const k of SCENE_KEYS){ if(s[k]) D.shared[k]=s[k]; }
    if(s.fc) curFC=s.fc;   // per-row captured fp consts override the per-scene mid-row set
   if(USE_CAP){ const cl=capSceneLut(sceneIdx,animT,s.fr); CAP_LUT=cl?cl.surf:null; CAP_LIMB=cl?cl.limb:null; CAP_LUTB=cl?cl.surfB:null; CAP_LIMBB=cl?cl.limbB:null; CAP_MIX=cl?(cl.mix||0):0; ATMO=(CAP_LIMB&&ATMO_SCENE)?1:0;
     if(TONELUT_PS){ const ct=capSceneTone(sceneIdx,animT,s.fr); CAP_T14=ct?ct.t14:null; CAP_T15=ct?ct.t15:null; } else { CAP_T14=null; CAP_T15=null; } }
   draw();
   { const F2=SCENES[sceneIdx]; const span=(F2&&F2.length?F2[F2.length-1].fr-F2[0].fr:0)||1;
     drawFade(fadeFactor(animT, span/60)); }   // match LIVE playback: the boundary dip applies in tick(); without it edge-frame parity measures unfaded-vs-dipped (sc25-class harness inflation)
   return 'ok'; },
 set stars(v){ STARS_ON=v?1:0; },
 get stars(){ return STARS_ON; },
set cull(v){ CULL=v?1:0; },
 set basefill(v){ BASE_FILL=v?1:0; }, get basefill(){ return BASE_FILL; },
 set basegain(v){ BASE_GAIN=+v||1.0; }, get basegain(){ return BASE_GAIN; },
 set basescale(v){ BASE_SCALE=+v||1.0; }, get basescale(){ return BASE_SCALE; },
 set covalpha(v){ COV_ALPHA=v?1:0; }, get covalpha(){ return COV_ALPHA; },
 set fp16(v){ FP16=v?1:0; }, get fp16(){ return FP16; },   // faithful fp16 half-register truncation in the surface fp
 set scene0loop(v){ SCENE0_LOOP=v?1:0; }, get scene0loop(){ return SCENE0_LOOP; },
 set s0range(v){ if(Array.isArray(v)&&v.length>=2){ S0_T0=+v[0]; S0_T1=+v[1]; } }, get s0range(){ return [S0_T0,S0_T1]; },
 set scene0dwell(v){ SCENE0_DWELL=+v; }, get scene0dwell(){ return SCENE0_DWELL; },
 set patchexp(v){ PATCH_EXP=+v||1.0; }, get patchexp(){ return PATCH_EXP; },
 set despeckle(v){ DESPECKLE=+v||0; }, get despeckle(){ return DESPECKLE; },
 set tiles(v){ TILES=v?1:0; },                 // faithful per-patch tile earth (1) vs legacy cube map (0)
 get tiles(){ return TILES; },
 set t2all(v){ T2ALL=v?1:0; },                 // test: all-patch cloud from the cube (uniform cloud)
 get t2all(){ return T2ALL; },
 set starBri(v){ STAR_BRI=v; },
 set glow2(v){ GLOW2=v?1:0; }, get glow2(){ return GLOW2; },
 get glareinfo(){ try{ const s=GLARE_ROWS?Object.keys(GLARE_ROWS).length:0; const cur=(GLARE_ROWS&&SCENES_IDX&&SCENES_IDX[sceneIdx])?(GLARE_ROWS[String(SCENES_IDX[sceneIdx].scene)]||[]).length:-1; return JSON.stringify({scenes:s,curRows:cur,glow2:GLOW2}); }catch(e){ return ''+e; } },
 set burst(v){ BURST=v?1:0; }, get burst(){ return BURST; },   // verbatim sun-disc burst pass (needs flare_scene data)
 set bloomdisp(v){ BLOOMDISP=v?1:0; }, get bloomdisp(){ return BLOOMDISP; },
 set flares(v){ FLARES=v?1:0; }, get flares(){ return FLARES; },
 set flarespre(v){ FLARESPRE=v?1:0; }, get flarespre(){ return FLARESPRE; },
 set dispretain(v){ DISPRETAIN=v?1:0; }, get dispretain(){ return DISPRETAIN; },
 set inscatgen(v){ INSCAT_GEN=v?1:0; }, get inscatgen(){ return INSCAT_GEN; },
 set stars2(v){ STARS2=v?1:0; }, get stars2(){ return STARS2; },
 set atmofc(v){ ATMOFC=v?1:0; }, get atmofc(){ return ATMOFC; },
 set atmoguard(v){ ATMOGUARD=v?1:0; }, get atmoguard(){ return ATMOGUARD; },
 set atmodepth(v){ ATMODEPTH=v?1:0; }, get atmodepth(){ return ATMODEPTH; },
 set atmoband(v){ ATMOBAND=v?1:0; }, get atmoband(){ return ATMOBAND; },
 set bloomc1(v){ BLOOMC1=v?1:0; }, get bloomc1(){ return BLOOMC1; },
 setBloomGain(sid,g){ if(FAITH_POLICY){ FAITH_POLICY.bloomGain=FAITH_POLICY.bloomGain||{}; FAITH_POLICY.bloomGain[String(sid)]=g; return 1; } return 0; },
 setDiscGain(sid,g){ if(FAITH_POLICY){ FAITH_POLICY.discGain=FAITH_POLICY.discGain||{}; if(g===null)delete FAITH_POLICY.discGain[String(sid)]; else FAITH_POLICY.discGain[String(sid)]=g; return 1; } return 0; },
 setLimbSoft(sid,g){ if(FAITH_POLICY){ FAITH_POLICY.limbSoft=FAITH_POLICY.limbSoft||{}; if(g===null)delete FAITH_POLICY.limbSoft[String(sid)]; else FAITH_POLICY.limbSoft[String(sid)]=g; return 1; } return 0; },
 _discDbg(sid){ return FAITH_POLICY?JSON.stringify(FAITH_POLICY.discGain||{}):'no pol'; },
 set bias0(v){ BIAS0=+v; }, get bias0(){ return BIAS0; },
 set bias2(v){ BIAS2=+v; }, get bias2(){ return BIAS2; },
 set faithauto(v){ FAITH_AUTO=v?1:0; }, get faithauto(){ return FAITH_AUTO; },
 get _seedDiag(){ return {manifest:SEED_MANIFEST?Object.keys(SEED_MANIFEST).length:0, cached:Object.keys(SEED_CACHE).length, cur:!!_seedCur}; },
 _inscatStats(){ if(!_ipA.cur||!_ipC.cur) return 'not generated';
   const rd=(rt)=>{ const px=new Float32Array(256*128*4);
     gl.bindFramebuffer(36160,rt.fbo); gl.readPixels(0,0,256,128,6408,5126,px); gl.bindFramebuffer(36160,null);
     let s=0,mx=0; for(let i=0;i<256*128;i++){ const v=Math.max(px[i*4],px[i*4+1],px[i*4+2]); s+=v; if(v>mx)mx=v; }
     return {mean:+(s/(256*128)).toFixed(5), max:+mx.toFixed(4)}; };
   return {A:rd(_ipA.cur), C:rd(_ipC.cur), seeds:!!(texSeedA&&texSeedA.loaded&&texSeedB&&texSeedB.loaded&&texBicubic&&texBicubic.loaded)}; },
 _glowSample(){ if(!_lastGlow||!_lastGlow.state||!_lastGlow.state.glowRT) return null;
   const rt=_lastGlow.state.glowRT; const px=new Float32Array(rt.w*rt.h*4); const out=[];
   gl.bindFramebuffer(36160,rt.fbo); gl.readPixels(0,0,rt.w,rt.h,6408,5126,px); gl.bindFramebuffer(36160,null);
   const sx=Math.max(1,rt.w>>6), sy=Math.max(1,rt.h>>5);
   for(let y=0;y<rt.h;y+=sy) for(let x=0;x<rt.w;x+=sx){ const i=(y*rt.w+x)*4;
     out.push(+px[i].toFixed(5),+px[i+1].toFixed(5),+px[i+2].toFixed(5)); }
   return {w:Math.ceil(rt.w/sx),h:Math.ceil(rt.h/sy),data:out}; },
 _dispSample(stride){ if(!_postRef.cur) return null;   // the pre-bloom display: [maxRGB, alpha] grid
   stride=stride||8; const W=_postRef.cur.w,H=_postRef.cur.h;
   const px=new Float32Array(W*H*4); const out=[];
   gl.bindFramebuffer(36160,_postRef.cur.fbo); gl.readPixels(0,0,W,H,6408,5126,px); gl.bindFramebuffer(36160,null);
   const sx=Math.max(1,Math.floor(W/160)), sy=Math.max(1,Math.floor(H/90));
   for(let y=0;y<H;y+=sy) for(let x=0;x<W;x+=sx){ const i=(y*W+x)*4;
     out.push(+Math.max(px[i],px[i+1],px[i+2]).toFixed(4),+px[i+3].toFixed(4)); }
   return {w:Math.ceil(W/sx),h:Math.ceil(H/sy),data:out}; },
 _encSample(stride){ if(!_encRef.cur) return null;
   stride=stride||8; const px=new Float32Array(512*512*4); const out=[];
   gl.bindFramebuffer(36160,_encRef.cur.fbo); gl.readPixels(0,0,512,512,6408,5126,px); gl.bindFramebuffer(36160,null);
   for(let y=0;y<512;y+=stride) for(let x=0;x<512;x+=stride){ const i=(y*512+x)*4; out.push(+Math.max(px[i],px[i+1],px[i+2]).toFixed(5)); }
   return out; },
 _inscatSample(which,stride){ const rt=(which==='A'?_ipA:which==='B'?_ipB:_ipC).cur; if(!rt) return null;
   stride=stride||8; const px=new Float32Array(256*128*4); const out=[];
   gl.bindFramebuffer(36160,rt.fbo); gl.readPixels(0,0,256,128,6408,5126,px); gl.bindFramebuffer(36160,null);
   for(let y=0;y<128;y+=stride) for(let x=0;x<256;x+=stride){ const i=(y*256+x)*4; out.push(+px[i].toFixed(5),+px[i+1].toFixed(5),+px[i+2].toFixed(5)); }
   return out; },     // faithful bloom-of-display (encode bd9c5fac -> pyramid -> +0.125)
 set bloompremul(v){ BLOOMPREMUL=v?1:0; }, get bloompremul(){ return BLOOMPREMUL; },
 set bloomalpha(v){ BLOOMALPHA=v?1:0; }, get bloomalpha(){ return BLOOMALPHA; },
 _encStats(){ if(!_encRef.cur) return 'no enc';
   const px=new Float32Array(512*512*4);
   gl.bindFramebuffer(36160,_encRef.cur.fbo); gl.readPixels(0,0,512,512,6408,5126,px); gl.bindFramebuffer(36160,null);
   let mx=0,sum=0,hot=0,asum=0; const hots=[];
   for(let i=0;i<512*512;i++){ const v=Math.max(px[i*4],px[i*4+1],px[i*4+2]); sum+=v; if(v>mx)mx=v;
     if(v>0.5){ hot++; if(hots.length<400) hots.push([i%512,(i/512)|0,+v.toFixed(2)]); } asum+=px[i*4+3]; }
   let cx=0,cy=0; for(const h of hots){cx+=h[0];cy+=h[1];}
   return {mean:+(sum/(512*512)).toFixed(5), max:+mx.toFixed(3), hot:hot, keyMean:+(asum/(512*512)).toFixed(4),
           hotCentroid:hots.length?[Math.round(cx/hots.length),Math.round(cy/hots.length)]:null,
           hotSample:hots.filter((_,j)=>j%40==0)}; },
 _fpAlpha(){ const Fd=hdrFBO; if(!Fd) return 'no fd';   // sample the display RT alpha (the exponent channel)
   const px=new Float32Array(64*64*4);
   gl.bindFramebuffer(36160,(_postRef.cur||Fd).fbo); gl.readPixels((canvas.width>>1)-32,(canvas.height>>1)-32,64,64,6408,5126,px); gl.bindFramebuffer(36160,null);
   let a=0,r=0; for(let i=0;i<64*64;i++){ a+=px[i*4+3]; r+=Math.max(px[i*4],px[i*4+1],px[i*4+2]); }
   return {centerA:+(a/4096).toFixed(4), centerRGB:+(r/4096).toFixed(4)}; },
 get _burstDiag(){ return {flag:BURST, fan:!!BURST_FAN, fanLen:BURST_FAN?BURST_FAN.length:0, scenes:FLARE_SCENES?Object.keys(FLARE_SCENES).length:0, curScene:SCENES_IDX&&SCENES_IDX[sceneIdx]?SCENES_IDX[sceneIdx].scene:null, rowsForCur:(FLARE_SCENES&&SCENES_IDX&&SCENES_IDX[sceneIdx])?((FLARE_SCENES[String(SCENES_IDX[sceneIdx].scene)]||[]).length):0, inited:!!(typeof GlobeBurst!=='undefined'&&GlobeBurst._inited)}; },
 setGlowFC(v){ if(Array.isArray(v)&&v.length>=17) GLOW_FC=v; },
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
 set lutwarm(v){ LUTWARM=v?1:0; }, get lutwarm(){ return LUTWARM; },   // WIP: real LUT tonemap (gold) vs reinhard
 set lutexpo(v){ LUTEXPO=+v; }, get lutexpo(){ return LUTEXPO; },
 set startex(v){ STARTEX=v?1:0; }, get startex(){ return STARTEX; },   // real star-texture cube vs catalog points
 set starwhite(v){ STAR_WHITE=+v; }, get starwhite(){ return STAR_WHITE; },
 set starpow(v){ STAR_POW=+v; }, get starpow(){ return STAR_POW; },
 set startile(v){ STAR_TILE=+v; }, get startile(){ return STAR_TILE; },   // cube tiling factor (minification -> crisp stars)
 set starsonly(v){ STARSONLY=v?1:0; }, get starsonly(){ return STARSONLY; },   // debug: render only the stars (no earth)
 set tonelut(v){ TONELUT_PS=v?1:0; }, get tonelut(){ return TONELUT_PS; },     // per-scene surface-fp tonemap LUT (brightness fix); needs cap_scene_tonelut.json
 set lutscale(v){ LUTSCALE=+v; }, get lutscale(){ return LUTSCALE; },
 set glowfaith(v){ GLOWFAITH=v?1:0; }, get glowfaith(){ return GLOWFAITH; },   // faithful render (col0 earth + separate limb/sun bloom)           // firmware tex14/15 COORD_SCALE2 (UNNORMALIZED -> 1/128)
 set feedback(v){ FEEDBACK_PS=v?1:0; }, get feedback(){ return FEEDBACK_PS; },   // steady-state backbuffer feedback x1/(1-0.125)
 get tonelutinfo(){ try{return JSON.stringify({on:!!TONELUT_PS,manifest:!!CAP_SCENE_TONE,cached:Object.keys(CAP_TONE_CACHE).length,t14:!!CAP_T14,t15:!!CAP_T15});}catch(e){return ''+e;} },
 set sundisc(v){ SUNDISC=v?1:0; }, get sundisc(){ return SUNDISC; },           // eclipse sun-disc burst on/off
 set sunbri(v){ SUN_BRI=+v; }, get sunbri(){ return SUN_BRI; },                // disc HDR intensity (SUN.mnu BRIGHTNESS 3.4)
 set sunsize(v){ SUN_SIZE=+v; }, get sunsize(){ return SUN_SIZE; },            // disc NDC half-size (calibrated to real corona)
 set sunscx(v){ SUN_SCX=+v; }, get sunscx(){ return SUN_SCX; },
 set sunscy(v){ SUN_SCY=+v; }, get sunscy(){ return SUN_SCY; },
 set sunnoocc(v){ SUN_NOOCC=v?1:0; }, get sunnoocc(){ return SUN_NOOCC; },     // debug: ignore earth occlusion
 set inscatecl(v){ INSCAT_ECL=v?1:0; }, get inscatecl(){ return INSCAT_ECL; }, // eclipse _AtmSpaceIv in-scatter LUT (surface tex4 + atmosphere scatterTex)
 set inscatps(v){ INSCAT_PS=v?1:0; }, get inscatps(){ return INSCAT_PS; },     // RUNTIME per-scene in-scatter (nearest-LUT selection from the 32-scene manifest)
 set lutxfade(v){ LUT_XFADE=v?1:0; }, get lutxfade(){ return LUT_XFADE; },       // 1 = within-scene in-scatter crossfade (causes the bright/dim flicker); 0 = nearest bin (stable)
 set caplut(u){ CAP_LUT = u ? texF32(BASE+u,256,128) : null; }, get caplut(){ return !!CAP_LUT; },   // captured per-frame in-scatter LUT override
 set caplimb(u){ CAP_LIMB = u ? texF32(BASE+u,256,128) : null; }, get caplimb(){ return !!CAP_LIMB; }, // captured per-frame limb LUT override
 set surfeclflip(v){ SURF_ECLFLIP=v?1:0; }, get surfeclflip(){ return SURF_ECLFLIP; },  // experiment: invert surface earth viewport-Y for eclipse views (default off; see framing diagnostics)
 get _eclView(){ try{return isEclipseView();}catch(e){return ''+e;} },
 set inscatW(v){ INSCAT_PICK_W=+v; }, get inscatW(){ return INSCAT_PICK_W; },    // pickScene ATTN_ATM penalty weight
 get inscatPick(){ return _psName; },                                            // diagnostic: last picked scene name
 get inscatReady(){ return !!(INSCAT_MANIFEST&&INSCAT_MANIFEST.scenes); },
 get inscatScenes(){ return INSCAT_MANIFEST?INSCAT_MANIFEST.scenes.map(s=>s.name):[]; },
 _pickScene(sun,attn){ const s=pickScene(sun,attn); return s?s.name:null; },      // diagnostic: pure pickScene by explicit sun/attn
 set iefull(v){ IEFULL=v?1:0; }, get iefull(){ return IEFULL; },               // unclamped IE LUT (restores night/dark side)
 set atmovflip(v){ ATMO_VFLIP=v?1:0; }, get atmovflip(){ return ATMO_VFLIP; },  // orientation probe for the atmo shell scatter LUT
 set atmoreal(v){ ATMO_REAL_MASTER=v?1:0; }, get atmoreal(){ return ATMO_REAL_MASTER; },  // master toggle; effective per-scene value (ATMO_REAL) is gated by ATMO_REAL_SCENES in drawGlowFaith
 set atmorealscenes(v){ ATMO_REAL_SCENES=Array.isArray(v)?v.slice():ATMO_REAL_SCENES; }, get atmorealscenes(){ return ATMO_REAL_SCENES.slice(); },
 set atmoover(v){ ATMO_OVER=v?1:0; }, get atmoover(){ return ATMO_OVER; },  // alpha-OVER atmo compositing (faithful) vs additive (white band)
 set atmodsta(v){ ATMO_DSTA=v?1:0; }, get atmodsta(){ return ATMO_DSTA; },  // real dst-alpha atmo blend
 set atmohdrc(v){ ATMO_HDRC=v?1:0; }, get atmohdrc(){ return ATMO_HDRC; },  // faithful HDR-domain composite (surface+atmo linear HDR -> single dual-LUT tonemap)
 set atmosolid(v){ ATMO_SOLID=v?1:0; }, get atmosolid(){ return ATMO_SOLID; },
 set atmoflipy(v){ ATMO_FLIPY=+v; }, get atmoflipy(){ return ATMO_FLIPY; },     // shell uFlipY orientation probe
 set atmohdr(v){ ATMO_HDR=+v; }, get atmohdr(){ return ATMO_HDR; },             // shell pre-bloom HDR scale probe
 set atmoscene(v){ ATMO_SCENE=v; if(v)ATMO=1; }, get atmoscene(){ return ATMO_SCENE; },  // inject a per-scene atmosphere frame list [{t,'256'..'259','460'..'462'}] (its 460-462 override the surface's via atmoAt, no buildVC conflict)
 get atmodbg(){ try{return JSON.stringify({aMesh:!!aMesh,scatterTex:!!scatterTex,got:got,want:want,ATMO:ATMO,ATMO_SCENE:!!ATMO_SCENE,fcAtmo:!!fcAtmo,tex4ecl:!!(sharedTex&&sharedTex.tex4ecl),err:errlog.slice(0,200)});}catch(e){return ''+e;} },
 get _dbgAtmo(){ try{ const a=[]; for(let i=0;i<17;i++)a.push([fcAtmo[i*4],fcAtmo[i*4+1],fcAtmo[i*4+2],fcAtmo[i*4+3]]); return JSON.stringify({FCATMO_OVR:FCATMO_OVR,tex0atmEcl:!!(sharedTex&&sharedTex.tex0atmEcl),fc:a}); }catch(e){return ''+e;} },
 set fcatmo(v){ if(v&&fcAtmo){ FCATMO_OVR=1; for(const k in v){ const i=+k,a=v[k]; fcAtmo[i*4]=a[0];fcAtmo[i*4+1]=a[1];fcAtmo[i*4+2]=a[2];fcAtmo[i*4+3]=a[3]; } } else { FCATMO_OVR=0; } },  // override per-scene atmosphere fp consts (eclipse: _Params/_Asahi/_AsahiIndicator/_AtmFactor)
 set glowGain(v){ if(Array.isArray(v)&&v.length===3) GLOW_GAIN=v.slice(); else if(typeof v==='number') GLOW_GAIN=[v,v,v]; },
 get glowGain(){ return GLOW_GAIN.slice(); },
 set glowWarm(v){ if(Array.isArray(v)&&v.length===3) GLOW_WARM=v.slice(); },
 get glowWarm(){ return GLOW_WARM.slice(); },
 set glowSlum(v){ GLOW_SLUM=v; },                              // GLOW-path earth exposure (separate from ENC=3 SLUM)
 get glowSlum(){ return GLOW_SLUM; },
 set glareThresh(v){ GLARE_THRESH=+v; },                       // GlareSource bright-pass threshold (HDR.mnu GLARE THRESH)
 get glareThresh(){ return GLARE_THRESH; },
 set glowChroma(v){ GLOW_CHROMA=v; },                          // 0=pure luminance earth (golden); small=ocean tint back
 get glowChroma(){ return GLOW_CHROMA; },
 set coherent(v){ USE_COH=!!v; },   // switch to coherent surface set + aligned atmosphere (dev; overexposes until decode lands)
 set usecap(v){ USE_CAP=!!v; },      // switch to the 22-scene fresh-capture set (true per-scene camera paths); must be set BEFORE start()
 set assetBase(v){ BASE = v.endsWith('/')?v:v+'/'; },  // validation: load a rebuilt dataset dir without swapping the ship; set BEFORE start()
 get assetBase(){ return BASE; },
 get coherent(){ return USE_COH; },
 get _info(){ return {scene:sceneIdx, nScenes:SCENES?SCENES.length:0, animT:animT.toFixed(3)}; },
 get _diag(){ return {scene:sceneIdx, t:+animT.toFixed(4), capT14:!!CAP_T14, capLut:!!CAP_LUT, capLimb:!!CAP_LIMB, atmo:ATMO,
   lutCache:Object.keys(CAP_LUT_CACHE||{}).length, toneCache:Object.keys(CAP_TONE_CACHE||{}).length,
   err:errlog, nScenes:SCENES?SCENES.length:0, c260:D&&D.shared?D.shared['260']:null, c262:D&&D.shared?D.shared['262']:null, c460:D&&D.shared?D.shared['460']:null,
   bloomScenes:BLOOM_SCENES?Object.keys(BLOOM_SCENES).length:0,
   faithPath:!!(GLOWFAITH&&hdrExt&&cprog&&(!TONELUT_PS||CAP_T14))}; },
 // DEBUG: capture the EXACT gl_Position the surface VS produces for patch `pi` via transform feedback.
 // flip = the uFlipY to apply (default -1 = the shipped firmware-viewport value). Returns Float32Array[289*4]
 // of final clip-space positions. Used to validate the per-scene earth framing against captured presents.
 _tfClip(pi,flip){ try{
   if(!D||!D.patches||!eMesh) return 'not ready';
   pi=pi||0; flip=(flip===undefined)?-1.0:flip;
   const tfVS = VS.replace('gl_Position=clip;','gl_Position=clip; oClip=clip;')
                  .replace('out vec4 tc0,','out vec4 oClip; out vec4 tc0,');
   const fsStub='#version 300 es\nprecision highp float; out vec4 o; void main(){o=vec4(0.);}';
   const p=gl.createProgram(); const vs=gl.createShader(35633); gl.shaderSource(vs,tfVS); gl.compileShader(vs);
   if(!gl.getShaderParameter(vs,35713)) return 'VScompile:'+gl.getShaderInfoLog(vs);
   const fss=gl.createShader(35632); gl.shaderSource(fss,fsStub); gl.compileShader(fss);
   gl.attachShader(p,vs); gl.attachShader(p,fss);
   gl.transformFeedbackVaryings(p,['oClip'],35980); gl.linkProgram(p);
   if(!gl.getProgramParameter(p,35714)) return 'link:'+gl.getProgramInfoLog(p);
   gl.useProgram(p);
   const U=n=>gl.getUniformLocation(p,n);
   gl.uniform4fv(U('vc'),buildVC(D.patches[pi].corners));
   gl.uniform1f(U('uFlipY'),flip);
   const N=289; const out=gl.createBuffer(); gl.bindBuffer(34962,out); gl.bufferData(34962,N*16,35040);
   const tf=gl.createTransformFeedback(); gl.bindTransformFeedback(36386,tf);
   gl.bindBufferBase(35982,0,out);
   const pl=gl.getAttribLocation(p,'in_pos'); gl.bindBuffer(34962,eMesh.pb);
   gl.enableVertexAttribArray(pl); gl.vertexAttribPointer(pl,4,5126,false,0,0);
   gl.enable(35977); gl.beginTransformFeedback(0); gl.drawArrays(0,0,N); gl.endTransformFeedback(); gl.disable(35977);
   gl.bindBufferBase(35982,0,null);
   const res=new Float32Array(N*4); gl.bindBuffer(34962,out); gl.getBufferSubData(34962,0,res);
   gl.bindTransformFeedback(36386,null); gl.bindBuffer(34962,null);
   return Array.from(res);
 }catch(e){return ''+e;} },
 get _vcDbg(){ try{ if(!D||!D.patches)return 'no D'; const vc=buildVC(D.patches[0].corners);
   const r=k=>[vc[k*4],vc[k*4+1],vc[k*4+2],vc[k*4+3]];
   const c260=r(3),c261=r(4),c263=r(6);
   return JSON.stringify({c260,c261,c263, sphereCenterNDCy: c261[3]/c263[3], eclView:isEclipseView()}); }catch(e){return ''+e;} },
 _pyrStats(){   // per-level bloom pyramid means (vs the real B0 profile 0.036->0.148)
   if(!_lastGlow||!_lastGlow.levels) return 'no glow';
   const out=[];
   for(const L of _lastGlow.levels){
     if(!L||!L.fbo){ out.push(null); continue; }
     const w=L.w||4,h=L.h||2;
     const px=new Float32Array(w*h*4);
     gl.bindFramebuffer(36160,L.fbo); gl.readPixels(0,0,w,h,6408,5126,px); gl.bindFramebuffer(36160,null);
     let s=0; for(let i=0;i<w*h;i++) s+=(px[i*4]+px[i*4+1]+px[i*4+2])/3;
     out.push(+( s/(w*h)).toFixed(5));
   }
   return out; },
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
