// =====================================================================
// PS3 XMB Music Visualizer "Canyon" - 1:1 firmware port (WebGL1)
// Source of truth: /work/ps3/xmb-ref/music_vis/canyon/decomp/
//   - presets.json (57 real presets, transcribed below)
//   - shaders/54__canyon__canyon.fpo.txt  (terrain fragment)
//   - shaders/58__canyon__canyon_layer_blur.fpo.txt (feedback compositor)
//   - canyon_normalmap.png (128x128 tangent-space normal/height map)
//   - CANYON_PORT_SPEC.md
//
// Drop-in replacement for index.html's initCanyon() + mpDrawCanyon(bands).
// Uses the shared `globeGL` WebGL1 context, renders to `globeCanvas`.
// GLSL is ES 1.00, no WebGL2-only syntax.
//
// FAITHFUL: preset float blocks, per-preset camera/fog/colour/feedback,
//   normalmap-driven Y displacement, linear fog to FogColour, ridge LINE
//   highlight, feedback motion-blur warp (scale/rot * FEEDBACK 0.9 + current),
//   57-preset cross-fade cycle.
// INFERRED (flagged): the exact vertex-displacement opcodes (canyon.vpo ARB
//   could not be decompiled - see NOTES.md). Displacement is derived from the
//   TERRAIN MNU params + the normalmap + canyon.fpo, per the spec, NOT raw VP
//   opcodes.
// =====================================================================
(function (global) {
'use strict';

// ---- Preset table (REAL values transcribed from presets.json) ----
// Column order (per row): see CANYON_COLS below.
var CANYON_COLS = [
  'posX','posY','posZ','tarX','tarY','tarZ','speed','timeAhead','zoom',
  'colR','colG','colB','colScale','colBias','lineR','lineG','lineB',
  'fogMin','fogMax','fogR','fogG','fogB',
  'tHeight','tWidth','tSlide','tScaleX','tTexScale','tBump',
  'vHeight','vCentre','vWidth','vSharp',
  'feedback','feedX','feedY','feedRot',
  'focalDepth','focalVar','skyBlur','lod','fadeColour'
];
var CANYON_PRESET_ROWS = [
[0.0,8.0,0.0,0.0,-3.0,156.0,20.0,159.0,65.0,10.0,10.0,10.0,0.0,0.0,0.0,0.0,0.0,30.0,70.0,0.0,0.0,0.0,1.0,1.0,1.0,1.0,10.0,0.0,0.0,0.0,0.0,0.0,0.9,1.0,1.0,0.0,50.0,50.0,0.0,0.0,0.0],
[-40.0,20.0,55.0,25.0,-50.0,200.0,16.0,150.0,55.0,0.9,1.3,4.4,1.5,0.2,1.0,0.4,0.0,-25.0,110.0,0.35,0.05,0.0,20.0,8.0,0.0,1.5,10.0,0.3,0.5,0.0,0.0,0.6,0.8,1.0,0.95,0.0,75.0,70.0,0.5,0.2,1.0],
[30.0,20.0,81.0,-2.0,-52.0,208.0,22.0,150.0,76.0,2.6,5.8,2.3,1.5,0.18,1.0,1.0,0.8,9.0,60.0,0.46,0.45,0.8,35.0,3.0,0.0,1.75,10.0,0.125,0.0,0.0,0.0,0.0,0.4,0.8,1.01,0.3,240.0,600.0,0.5,0.4,1.0],
[0.0,20.0,42.0,0.0,-120.0,210.0,22.0,150.0,124.0,2.8,1.6,1.13,1.5,0.0,0.78,0.44,0.69,-80.0,150.0,0.0,0.2,0.3,40.0,5.0,0.0,2.4,10.0,0.125,0.0,0.0,0.0,0.0,0.8,1.0,1.0,0.0,60.0,75.0,0.6,0.1,1.0],
[0.1,29.0,109.24,0.0,-130.0,342.0,42.8,128.0,132.0,4.5,3.9,1.07,1.6,0.0,0.46,0.0,0.0,-122.0,108.0,0.0,0.0,0.0,22.0,9.7,0.0,2.0,10.0,0.125,0.0,0.0,0.0,0.0,0.6,0.98,0.98,-3.1416,177.0,38.0,0.9,0.08,1.0],
[0.0,13.0,75.5,0.0,-440.0,388.0,17.67,135.7,78.0,7.0,5.0,4.0,1.4,0.04,1.0,0.87,1.0,38.0,170.0,0.0,0.0,0.0,10.0,6.0,0.0,0.69,1.31,0.16,0.2,0.0,0.0,0.1,0.0,1.0,1.0,0.0,10.0,125.0,0.2,0.05,1.0],
[0.0,4.5,90.0,0.0,-25.0,127.0,25.0,153.0,136.0,9.2,7.7,9.49,1.9,0.0,0.94,1.0,1.0,-15.0,94.0,0.08,0.0,0.2,15.0,6.9,5.2,2.35,0.34,0.5,7.3,0.0,0.0,0.2,0.46,1.0,0.96,0.0,5.0,470.0,0.4,0.2,1.0],
[-48.0,15.5,11.48,24.0,-75.0,208.0,36.0,162.0,64.0,4.7,4.0,3.7,1.5,0.18,1.0,0.7,0.4,5.0,240.0,0.0,0.0,0.0,48.0,5.5,3.9,3.3,10.0,0.125,2.5,0.0,0.6,0.18,0.85,1.0,1.0,0.0,70.0,100.0,0.5,0.61,1.0],
[4.0,27.0,55.0,13.0,-25.0,130.0,18.6,128.0,72.0,0.9,1.3,4.4,1.5,0.0,1.0,0.1,1.0,23.0,90.0,0.34,0.1,0.33,40.0,4.0,0.0,2.0,10.0,0.2,1.0,0.0,0.0,0.3,0.0,1.0,0.96,0.0,27.0,100.0,1.0,1.0,1.0],
[0.0,12.0,96.0,-2.0,-44.0,208.0,23.0,150.0,76.0,5.4,3.0,9.7,9.1,0.18,1.0,0.86,0.2,5.0,66.0,0.0,0.11,0.0,15.0,4.0,0.0,0.6,10.0,0.125,1.0,0.0,0.0,0.3,0.85,1.0,0.98,0.0,273.0,100.0,0.0,0.6,1.0],
[77.0,15.0,70.0,-210.0,-52.0,208.0,36.39,179.0,51.0,3.8,4.7,7.8,6.4,0.08,0.7,0.4,0.0,21.0,175.0,0.0,0.0,0.0,15.0,5.0,0.0,2.0,10.0,0.125,1.0,0.0,0.0,0.3,0.84,1.0,1.0,0.0,17.5,107.0,0.7,0.1,1.0],
[47.44,33.0,88.5,13.0,-60.0,168.0,2.4,119.5,68.0,3.2,9.0,6.0,1.14,0.519,1.0,0.514,0.38,68.4,114.1,0.917,0.631,0.44,102.0,1.5,2.5,2.03,3.84,0.215,8.2,0.32,0.0,0.33,0.0,1.0,0.96,0.0,27.0,100.0,0.0,0.559,1.0],
[0.01,31.0,83.5,0.01,83.0,208.0,2.7,28.8,160.0,0.0,0.0,0.0,0.86,0.05,0.87,0.5,0.4,44.3,248.6,0.534,0.532,0.51,19.8,1.73,-0.26,0.89,10.0,0.125,8.2,0.32,0.0,0.33,0.59,0.96,0.98,-3.14,177.8,38.5,0.26,0.0,1.0],
[110.0,9.54,35.301,-356.0,134.0,284.0,6.63,-20.0,94.0,6.6,5.4,4.7,8.7,0.14,1.0,0.5,0.3,41.2,155.7,0.053,0.056,0.11,7.0,24.9001,29.7,11.8201,2.1,1.67,5.2,0.0,0.31,0.06,0.0,0.01,0.5,0.01,45.3,0.8,0.5,0.17,1.0],
[117.92,33.53,94.901,-2.01,-110.0,414.0,33.53,114.2,111.0,6.6,5.4,3.6,2.12,1.78,0.58,0.392,0.37,-154.8,94.3,0.94,1.0,0.91,132.2,8.3,50.4998,4.6101,3.31,1.94,0.5,0.01,0.0,0.06,0.0,0.17,0.01,-0.08,50.3,241.6,0.581,0.12,0.4],
[42.23,17.5,58.31,0.0,-57.0,152.0,49.0,401.0,139.0,7.7,6.4,8.0,0.31,0.615,0.456,0.464,0.444,10.0,147.0,0.0,0.12,0.125,159.6,10.48,3.9,1.9399,0.0,0.0,26.8,0.835,0.31,0.06,0.1,0.06,0.01,25.2801,14.199,238.9,0.009,0.0,1.0],
[5.51,18.03,85.5,6.02,-108.46,363.31,15.4,170.0,122.0,9.4,2.9,2.87,0.31,0.07,0.26,0.58,0.9,39.8,159.0,0.0,0.0,0.08,143.7,1.0399,16.16,0.71,12.56,0.649,0.0,0.0,0.14,3.3799,0.0,2.03,1.4,0.08,43.7,207.0,0.775,0.07,0.7],
[-19.3,84.91,80.5,220.8,-48.15,230.0,21.7,170.0,149.0,3.19,4.9,2.9,1.3,0.0,0.23,0.08,0.34,122.4,370.0,0.0,0.0,0.0,317.4,1.28,1.86,1.23,1.1,0.0,1.1,0.0,0.2,1.559,0.0,0.01,1.1,0.0,108.0,245.0,0.383,0.142,0.9],
[0.03,3.91,108.93,1.1,1.85,72.0,37.8,119.6,113.0,7.7,3.35,3.4,1.0,0.0,0.009,0.162,0.123,122.4,370.0,0.08,0.09,0.079,122.8,-0.09,2.76,0.3,2.7,1.0,0.0,0.0,0.0,0.43,0.06,0.01,0.01,2.78,21.6,945.0,1.0,0.218,0.9],
[5.74,15.0,98.32,328.85,3.0,785.0,32.43,119.6,149.0,9.1,2.3,2.1,1.4,0.12,0.71,0.61,1.0,107.4,158.0,0.0,0.02,0.0,91.9,0.3,19.43,0.93,10.0254,0.44,0.15,0.62,0.54,3.119,0.09,0.06,0.01,-0.4,40.0,245.0,0.31,0.155,0.7],
[1.01,20.0,53.5,0.0,-54.0,208.0,26.3,183.999,100.0,1.6,1.5,0.7,1.5,0.18,1.0,0.0,0.0,342.0,395.0,0.0,0.0,0.0,40.0,4.0,0.0,1.2,10.0,0.0,0.0,0.0,0.0,0.0,0.0,1.0,0.95,0.0,124.8,256.5,0.0,0.0,1.0],
[47.44,33.0,88.5,13.0,-60.0,168.0,2.4,119.5,68.0,3.2,9.0,6.0,1.14,0.519,1.0,0.514,0.38,68.4,114.1,0.917,0.631,0.44,102.0,1.5,2.5,2.03,3.84,0.215,8.2,0.32,0.0,0.33,0.0,1.0,0.96,0.0,27.0,100.0,0.0,0.559,1.0],
[49.44,48.5,100.5,13.0,-60.0,168.0,2.4,119.5,68.0,10.0,10.0,10.0,1.14,0.519,0.99,0.496,0.436,68.4,114.1,0.917,0.631,0.44,102.0,1.5,2.5,2.03,3.84,0.215,8.2,0.32,0.0,0.33,0.0,1.0,0.96,0.0,27.0,100.0,0.0,0.559,1.0],
[16.94,27.5,101.94,9.0,-60.0,396.0,2.4,121.2,137.0,7.8,9.0,8.0,1.14,0.519,1.0,0.519,0.38,68.4,114.1,0.87,0.651,0.65,102.0,1.5,2.5,2.03,3.84,0.215,8.2,0.32,0.0,0.33,0.0,1.0,0.96,0.0,-145.0,45.0,0.08,0.544,1.0],
[47.44,33.0,117.0,58.0,-243.0,168.0,2.4,119.5,68.0,3.2,9.0,6.0,1.14,0.519,1.0,0.514,0.38,68.4,114.1,0.917,0.631,0.44,102.0,1.5,2.5,2.03,3.84,0.215,8.2,0.32,0.0,0.33,0.0,1.0,0.96,0.0,297.0,30.6,0.0,0.669,1.0],
[92.2,55.0,84.73,-94.4,-69.0,133.0,1.12,88.5,52.0,10.0,1.9,4.49,0.12,0.719,0.728,0.737,0.927,68.4,114.1,0.84,0.8,0.79,137.0,1.5,2.5,1.64,8.55,0.226,8.73,0.32,0.008,0.33,0.4,1.0,0.96,0.0,27.0,100.0,0.0,0.559,0.8],
[92.2,55.0,84.73,-94.4,-69.0,249.0,12.62,115.5,52.0,10.0,1.9,4.49,0.12,0.719,0.728,0.737,0.927,68.4,114.1,0.619,0.701,0.816,137.0,1.5,2.5,1.87,8.55,0.226,8.73,0.32,0.008,0.33,0.4,1.0,0.96,0.0,27.0,100.0,0.0,0.559,0.8],
[92.2,55.0,84.73,-94.4,-181.0,249.0,22.42,115.5,39.0,10.0,0.7,6.89,0.12,0.719,0.766,0.782,0.927,68.4,114.1,0.036,0.0,0.136,137.0,1.5,2.5,1.87,8.55,0.226,8.73,0.32,0.008,0.33,0.4,1.0,0.96,0.0,27.0,100.0,0.0,0.559,0.8],
[44.44,31.5,93.0,13.0,-60.0,168.0,2.4,119.5,68.0,0.0,0.0,0.09,0.6,0.546,0.04,0.53,0.67,84.4,114.1,0.0,0.0,0.15,102.0,2.3,2.5,2.03,3.84,0.215,8.2,0.32,0.0,0.33,0.0,1.0,0.96,0.0,27.0,100.0,0.0,0.559,1.0],
[66.44,27.0,74.0,13.0,-60.0,168.0,20.5,119.0,68.0,0.8,2.0,0.0,0.16,0.43,1.0,0.564,0.41,68.4,139.1,0.76,0.87,0.41,102.0,-1.0,1.2,2.0,5.04,0.565,11.7,0.32,0.0,0.33,0.0,1.0,0.96,0.0,37.0,390.0,0.92,0.351,1.0],
[47.44,33.0,88.0,13.0,-60.0,168.0,2.4,119.5,68.0,0.29,0.7,1.1,1.03,0.171,0.909,0.61,0.413,84.4,114.1,0.92,1.0,0.72,102.0,2.3,2.5,2.03,3.84,0.215,8.2,0.32,0.0,0.33,0.0,1.0,0.96,0.0,27.0,100.0,0.0,0.559,1.0],
[30.44,33.0,88.5,13.0,-60.0,168.0,2.4,119.5,68.0,1.5,0.2,2.1,0.07,0.257,0.695,0.395,0.366,68.4,114.1,0.95,0.66,0.49,102.0,1.5,2.5,2.03,3.84,0.215,8.2,0.32,0.0,0.33,0.0,1.0,0.96,0.0,27.0,100.0,0.0,0.559,1.0],
[30.44,54.0,76.5,14.0,-60.0,168.0,2.4,119.5,68.0,8.0,1.11,0.0,0.11,0.654,0.733,0.642,0.702,68.4,114.1,0.92,0.726,0.44,102.0,1.5,2.5,2.03,3.84,0.215,8.2,0.32,0.0,0.33,0.0,1.0,0.96,0.0,27.0,100.0,0.0,0.559,1.0],
[30.0,20.0,81.0,-2.0,-52.0,208.0,22.0,150.0,76.0,2.6,5.8,2.3,1.5,0.18,1.0,1.0,0.8,9.0,60.0,0.46,0.45,0.8,35.0,3.0,0.0,1.75,10.0,0.125,0.0,0.0,0.0,0.0,0.4,0.8,1.01,0.3,240.0,600.0,0.5,0.4,1.0],
[4.0,12.5,90.0,-2.0,-165.0,246.0,22.0,150.0,116.0,1.6,6.2,0.0,0.71,0.54,1.0,1.0,0.8,9.0,60.0,0.41,0.29,0.67,37.0,3.8,1.04,3.15,10.0,0.125,0.0,0.0,0.0,0.0,0.4,0.8,1.01,0.3,240.0,600.0,0.5,0.323,1.0],
[71.0,20.0,81.0,-2.0,-52.0,208.0,22.0,122.3,45.0,0.6,2.6,0.8,1.5,0.18,1.0,1.0,0.8,9.0,60.0,0.5,0.63,0.8,35.0,7.6,8.5,2.45,19.1,0.035,20.5,1.17,0.0,0.0,0.11,0.01,1.51,0.79,709.0,416.0,0.28,0.57,1.0],
[87.0,20.0,90.0,17.0,-90.0,100.0,22.0,150.0,76.0,2.4,3.0,2.1,2.5,0.33,1.0,1.0,0.8,9.0,60.0,0.46,0.45,0.8,35.0,3.0,0.0,1.75,10.0,0.125,0.0,0.0,0.0,0.0,0.4,0.8,1.01,0.3,240.0,600.0,0.5,0.4,1.0],
[-40.0,20.0,55.0,25.0,-50.0,200.0,16.0,150.0,55.0,0.9,1.3,4.4,1.5,0.2,1.0,0.4,0.0,-25.0,110.0,0.35,0.05,0.0,20.0,8.0,0.0,1.5,10.0,0.3,0.5,0.0,0.0,0.6,0.8,1.0,0.95,0.0,75.0,70.0,0.5,0.433,1.0],
[-100.0,56.5,3.0,50.0,-39.0,208.0,36.0,162.0,45.0,1.4,3.4,9.1,1.8,0.0,1.0,0.35,0.0,5.0,240.0,0.05,0.0,0.07,48.0,5.5,3.9,2.7,10.0,0.125,2.5,0.0,0.6,0.18,0.71,1.0,1.0,0.0,330.0,306.0,1.0,0.33,1.0],
[77.0,15.0,70.0,-210.0,-52.0,208.0,36.39,179.0,51.0,3.8,4.7,7.8,6.4,0.08,0.7,0.4,0.0,21.0,175.0,0.0,0.0,0.0,15.0,5.0,0.0,2.0,10.0,0.125,1.0,0.0,0.0,0.3,0.84,1.0,1.0,0.0,17.5,107.0,0.7,0.1,1.0],
[59.5,26.5,58.0,-69.0,-210.0,466.0,36.39,179.0,51.0,3.8,6.8,7.8,6.4,0.08,0.94,0.4,0.0,21.0,175.0,0.0,0.0,0.0,15.0,10.3,0.0,1.9,10.0,0.125,0.0,0.0,0.0,0.3,0.33,1.0,1.0,0.0,17.5,107.0,0.7,0.27,1.0],
[-4.18,26.5,53.86,-1.15,163.0,199.0,1.1,50.6,60.0,6.2,8.6,1.11,0.8,0.4949,0.88,0.619,0.679,92.4,314.2,1.0,1.0,1.0,26.0,-1.1499,126.329,0.9,13.5254,0.46,1.01,2.9,1.0,10.0,0.0,0.01,0.01,10.57,2.1,211.0,0.95,0.29,0.8],
[-4.18,26.5,43.36,17.85,-33.0,86.0,1.1,50.6,60.0,0.28,1.2,5.2,0.8,0.4949,1.0,1.0,0.679,92.4,314.2,1.0,1.0,1.0,26.0,-1.1499,126.329,0.9,13.5254,0.46,1.01,2.9,1.0,10.0,0.0,0.01,0.01,-4.33,2.1,211.0,0.95,0.28,0.8],
[-4.18,26.5,53.86,-1.15,745.0,530.0,1.1,50.6,60.0,4.3,4.8,1.24,0.8,0.4949,1.0,0.589,0.679,92.4,314.2,1.0,1.0,1.0,26.0,-1.1499,126.329,0.9,13.5254,0.46,1.01,2.9,1.0,10.0,0.0,0.01,0.01,10.57,2.1,211.0,0.95,0.29,0.8],
[-1.18,40.58,38.86,17.85,-33.0,110.0,1.1,50.6,60.0,10.0,10.0,10.0,0.0,0.5329,0.93,0.91,1.0,92.4,314.1,0.77,0.89,0.96,26.0,-1.1499,126.329,0.9,13.5254,0.46,1.01,2.9,1.0,10.0,0.09,0.01,0.01,10.57,35.1,229.0,0.95,0.27,0.8],
[-4.18,39.0,79.36,-63.15,-197.17,120.0,2.49,50.6,60.0,4.02,9.0,5.3,2.5,0.88,0.99,0.75,0.66,92.4,317.1,1.0,0.94,0.88,38.1,-1.1499,126.329,0.9,13.5254,0.46,1.01,2.9,1.0,10.0,0.0,0.01,0.01,1.07,72.1,113.0,1.0,0.3,0.7],
[3.24,91.5,109.32,0.85,3.0,77.0,49.0,-38.4,52.0,6.0,1.1,10.0,0.0,1.46,0.92,1.0,1.0,71.4,288.2,0.68,0.94,0.95,118.0,-0.4399,126.329,0.9,13.5254,0.46,0.0,2.9,1.0,10.0,0.0,1.05,3.3,-2.03,-8.9,206.0,0.95,0.0,0.7],
[0.01,19.41,108.93,0.02,1.85,72.0,37.8,119.6,113.0,7.7,2.55,2.7,1.03,0.03,0.459,0.84,0.473,19.4,332.6,0.0,0.0,0.07,167.8,-0.4099,-0.14,0.7,2.7,1.0,0.0,0.0,0.0,0.43,0.06,0.01,0.01,2.78,41.6,146.0,1.0,0.16,0.9],
[0.02,5.38,108.93,-0.05,9.85,72.0,39.3,231.6,113.0,7.7,2.55,2.7,1.43,0.41,0.0,0.88,1.0,19.4,332.6,0.0,0.0,0.07,124.8,0.5401,2.76,0.7,2.7,1.0,0.0,2.64,0.0,0.43,0.0,0.01,0.01,2.78,41.6,146.0,1.0,0.16,0.5],
[5.74,20.0,76.32,328.85,-101.0,785.0,41.53,119.6,149.0,9.1,2.3,2.1,1.4,0.12,0.47,0.61,1.0,107.4,158.0,0.0,0.02,0.0,91.9,0.3,19.43,0.93,10.0254,0.44,0.15,0.62,0.54,3.119,0.09,0.06,0.01,-0.4,40.0,245.0,0.31,0.155,0.7],
[-107.76,20.5,31.82,285.85,24.0,973.03,49.0,306.6,138.0,2.4,2.33,3.03,1.29,0.17,0.72,0.834,0.81,107.4,158.0,0.0,0.02,0.0,78.7999,2.88,76.1293,1.78,13.1254,0.44,0.0,9.2801,0.0,2.454,0.0,0.01,0.01,0.01,180.0,464.0,0.86,0.03,0.7],
[-40.0,13.0,85.82,-34.15,-234.0,653.0,49.0,356.6,153.0,2.3,2.7,5.0,1.06,0.08,0.974,0.994,0.92,-130.6,390.0,0.9,1.0,1.0,44.7999,1.6501,72.2294,1.28,19.7654,0.76,0.0,9.1401,0.58,1.114,0.09,0.06,0.01,0.07,12.1,130.0,0.31,0.1,0.9],
[-60.0,10.0,72.32,-34.15,-234.0,653.0,49.0,131.6,155.0,1.3,0.88,3.5,1.48,0.0,0.86,0.89,0.4,107.4,158.0,0.37,1.0,1.0,79.2999,0.1301,114.729,1.1,13.5254,0.48,0.0,7.87,1.0,3.7199,0.09,0.06,0.01,0.07,14.1,130.0,0.31,0.086,0.5],
[15.03,66.03,40.5,-6.96,-327.46,295.31,49.0,233.0,49.0,5.9,4.4,4.3,2.5,0.29,0.387,0.63,0.9,39.8,159.0,0.0,0.19,0.43,69.7,0.7399,30.6601,1.92,1.8,0.429,0.1,1.43,0.37,0.0,0.0,2.03,1.4,0.08,43.7,207.0,0.775,0.54,0.7],
[0.03,15.53,78.5,34.04,-60.46,300.31,49.0,233.0,145.0,10.0,8.6,2.87,0.46,0.03,0.197,0.63,0.9,39.8,159.0,0.0,0.16,0.37,121.7,0.3399,30.6601,0.82,5.71,0.0,0.1,1.43,0.37,0.0,0.0,2.03,1.4,0.08,43.7,207.0,0.775,0.07,0.8],
[-3.76,16.5,72.32,-2.15,-98.0,539.0,49.0,131.6,160.0,2.83,2.58,2.54,1.23,0.767,0.89,0.9,1.0,71.6,284.0,0.93,1.0,1.0,67.7999,1.0401,58.0299,1.3,15.6254,0.25,0.0,8.28,0.0,5.2999,0.06,1.11,1.9,-2.62,-8.7,201.0,0.93,0.015,0.7],
[6.27,12.5,29.32,-7.15,541.0,601.0,40.1,-5.4,139.0,0.0,0.0,0.0,2.87,0.672,1.0,1.0,1.0,71.4,288.2,0.76,1.0,0.95,116.0,-1.1499,126.329,0.9,13.5254,0.46,0.0,2.9,1.0,10.0,0.2,2.71,5.0,19.67,62.1,-21.0,0.04,0.22,0.8]
];

// Turn each numeric row into a named object.
var PRESETS = CANYON_PRESET_ROWS.map(function (row) {
  var o = {};
  for (var i = 0; i < CANYON_COLS.length; i++) o[CANYON_COLS[i]] = row[i];
  return o;
});

// ---- module state ----
var NORMAL_URL = 'images/canyon_normalmap.png';
var GRID_W = 200;      // X columns (spec: 208 full-res; comparable lattice)
var GRID_D = 256;      // Z rows ahead of camera
var st = null;         // initialised lazily

function compile(gl, type, src) {
  var s = gl.createShader(type);
  gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
    console.error('canyon shader:', gl.getShaderInfoLog(s), src);
  return s;
}
function link(gl, vs, fs) {
  var p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS))
    console.error('canyon link:', gl.getProgramInfoLog(p));
  return p;
}

// ---------------------------------------------------------------
// TERRAIN program.
// Vertex stage samples the normalmap (vertex-texture if available, else a
// JS-precomputed height texture is read in the FS-free path) to displace Y.
// canyon.vpo opcodes were NOT recovered; the displacement below is the
// documented inferred form (TERRAIN HEIGHT * heightFromNormalMap + VALLEY
// carve), per CANYON_PORT_SPEC sections 3/7. Camera builds a standard
// look-at + perspective from the preset.
// ---------------------------------------------------------------
var TERRAIN_VS = [
  'precision highp float;',
  'attribute vec2 aGrid;',          // grid coords: x in [0,1] across, z in [0,1] ahead
  'uniform mat4 uMVP;',
  'uniform vec3 uCamPos;',
  'uniform float uScroll;',         // world Z scroll (camera forward + SLIDE)
  'uniform float uHalfW;',          // half world width of the lattice
  'uniform float uDepth;',          // world depth ahead
  'uniform float uTHeight, uTWidth, uTScaleX, uTexScale, uTSlide;',
  'uniform float uVHeight, uVCentre, uVWidth, uVSharp;',
  'uniform float uFogMin, uFogRange;',
  'uniform sampler2D uNormal;',
  'varying vec2 vUV;',
  'varying float vFog;',
  'varying float vRidge;',
  'varying float vWorldY;',
  // approximate height from the tangent-space normal map: B channel carries
  // surface flatness; we integrate R/G tilt into a height proxy. The map is
  // lavender (B high), R/G centred ~0.5. Height proxy = (1-B) emphasises slopes
  // plus a low-frequency term from R/G offsets.
  // Height from the normalmap. The map is a tangent-space normal of a rolling
  // dune field. Integrate the R/G tilt (bias -0.5) plus the flatness term to
  // get a smooth height field; sum two octaves for visible rolling ridges.
  'float sampleHeight(vec2 uv){',
  '  vec3 n0 = texture2D(uNormal, fract(uv)).rgb;',
  '  vec3 n1 = texture2D(uNormal, fract(uv*0.37 + 0.21)).rgb;',
  '  float h = (n0.r-0.5)+(n0.g-0.5) + (1.0-n0.b)*4.0;',
  '  h += ((n1.r-0.5)+(n1.g-0.5) + (1.0-n1.b)*4.0)*0.5;',
  '  return h;',
  '}',
  'void main(){',
  '  float wx = (aGrid.x - 0.5) * 2.0 * uHalfW * uTWidth;',
  '  float wz = uCamPos.z + aGrid.y * uDepth;',     // ahead of camera
  // sample normalmap; TEXTURE SCALE / SCALE X set UV frequency, SLIDE scrolls Z
  '  vec2 uv = vec2(wx / (uTexScale * uTScaleX * 8.0),',
  '                 (wz + uScroll * uTSlide) / (uTexScale * 8.0));',
  '  float h = sampleHeight(uv) * uTHeight;',
  // VALLEY carve: lower the centre band into a valley
  '  float vc = (wx - uVCentre);',
  '  float vw = max(uVWidth, 0.0001);',
  '  float valley = uVHeight * exp(-pow(abs(vc) / vw, 1.0 + uVSharp * 3.0));',
  '  h -= valley * uTHeight;',
  '  float wy = h;',
  '  vUV = uv;',
  '  vWorldY = wy;',
  // ridge factor: prominence of local crest, used for the LINE highlight
  '  vRidge = clamp(h / max(uTHeight*6.0, 0.5), 0.0, 1.0);',
  // linear fog over FOG MIN..MAX in eye-distance along Z
  '  float dist = wz - uCamPos.z;',
  '  vFog = clamp((dist - uFogMin) / max(uFogRange, 0.001), 0.0, 1.0);',
  '  gl_Position = uMVP * vec4(wx, wy, wz, 1.0);',
  '}'
].join('\n');

// canyon.fpo port: perturbed normal from normalmap (bias -0.5), fresnel rim,
// linear fog -> FogColour, + LineColour ridge highlight, colour from COLOUR.
var TERRAIN_FS = [
  'precision highp float;',
  'uniform sampler2D uNormal;',
  'uniform vec3 uColour;',          // COLOUR R/G/B
  'uniform float uColScale, uColBias;',
  'uniform vec3 uLineColour;',      // LINE R/G/B ridge highlight
  'uniform vec3 uFogColour;',       // FOG R/G/B
  'uniform float uBump;',           // BUMP SCALE
  'varying vec2 vUV;',
  'varying float vFog;',
  'varying float vRidge;',
  'varying float vWorldY;',
  // Synthesized _FresLUT ramp: the captured silver/teal rim. Indexed by |N.z|
  // (facing = low rim, grazing = high rim). Reproduces the luminous teal sheen
  // seen in the reference (FogColour const[5]~={0.561,0.647,0.773}).
  'vec3 fresLUT(float t){',
  '  vec3 lo = vec3(0.04, 0.14, 0.17);',     // near-facing: dim teal
  '  vec3 hi = vec3(0.70, 0.95, 1.05);',     // grazing rim: bright teal-white
  '  return mix(lo, hi, pow(clamp(t,0.0,1.0), 1.3));',
  '}',
  'void main(){',
  '  vec3 n = texture2D(uNormal, fract(vUV)).rgb;',
  '  vec2 t = (n.xy - 0.5) * (1.0 + uBump * 4.0);',   // bias -0.5, * BumpScale
  '  vec3 nrm = normalize(vec3(t.x, max(n.z, 0.05), t.y));',
  // fresnel/grazing term: 1 at silhouette, 0 facing -> drives the rim LUT
  '  float rim = 1.0 - clamp(nrm.y, 0.0, 1.0);',
  '  vec3 sheen = fresLUT(rim);',
  // HDR base colour from the COLOUR block (multiplier * scale + bias)
  '  vec3 base = uColour * uColScale + uColBias;',
  // self-lit terrain: the teal sheen carries the look; base tints/brightens it
  '  vec3 lit = sheen * (0.6 + 0.25*base);',
  '  lit += uLineColour * vRidge * (0.4 + rim);',     // LINE highlight on crests
  '  vec3 col = mix(lit, uFogColour, vFog);',         // linear fog to FogColour
  '  gl_FragColor = vec4(col, 1.0);',
  '}'
].join('\n');

// canyon_layer_blur.fpo port: warp previous feedback RT by scale/rot, * FEEDBACK,
// add current frame. Fullscreen pass.
var BLUR_VS = [
  'precision highp float;',
  'attribute vec2 aPos;',
  'varying vec2 vT;',
  'void main(){ vT = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }'
].join('\n');
var BLUR_FS = [
  'precision highp float;',
  'uniform sampler2D uCurrent;',    // _Screen
  'uniform sampler2D uPrev;',       // _Tex / _Front (previous feedback buffer)
  'uniform float uFeedback;',       // _Feedback persistence (0.9 default)
  'uniform vec2 uFeedScale;',       // _FeedbackScale (FEEDBACK X/Y)
  'uniform float uFeedRot;',        // _FeedbackRot
  'varying vec2 vT;',
  'void main(){',
  '  vec2 p = vT - 0.5;',
  '  float c = cos(uFeedRot), s = sin(uFeedRot);',
  '  p = mat2(c, -s, s, c) * p;',                 // rotate
  '  p /= max(uFeedScale, vec2(0.001));',         // scale (zoom)
  '  vec2 puv = p + 0.5;',
  '  vec3 prev = vec3(0.0);',
  '  if (puv.x > 0.0 && puv.x < 1.0 && puv.y > 0.0 && puv.y < 1.0)',
  '    prev = texture2D(uPrev, puv).rgb;',
  '  vec3 cur = texture2D(uCurrent, vT).rgb;',
  // current frame blended over the warped, persisted previous buffer. Using a
  // normalized mix keeps it from saturating to white while preserving streaks.
  '  vec3 outc = max(cur, prev * uFeedback);',
  '  outc = mix(outc, cur, 0.35);',
  '  gl_FragColor = vec4(outc, 1.0);',
  '}'
].join('\n');

// Tonemap + present (combines bloom-ish softness): simple Reinhard-style finish.
var PRESENT_FS = [
  'precision highp float;',
  'uniform sampler2D uTex;',
  'uniform float uExposure;',
  'varying vec2 vT;',
  'void main(){',
  '  vec3 c = texture2D(uTex, vT).rgb * uExposure;',
  '  c = c / (c + vec3(0.85));',                   // Reinhard-ish tonemap
  '  c = pow(c, vec3(1.0 / 2.2));',                // gamma
  '  gl_FragColor = vec4(c, 1.0);',
  '}'
].join('\n');

// ---- mat4 helpers ----
function mat4Perspective(fovy, aspect, near, far) {
  var f = 1.0 / Math.tan(fovy / 2), nf = 1 / (near - far);
  return [
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, (2 * far * near) * nf, 0
  ];
}
function mat4LookAt(eye, ctr, up) {
  function sub(a, b) { return [a[0]-b[0], a[1]-b[1], a[2]-b[2]]; }
  function norm(a) { var l = Math.hypot(a[0],a[1],a[2])||1; return [a[0]/l,a[1]/l,a[2]/l]; }
  function cross(a, b) { return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]; }
  function dot(a, b) { return a[0]*b[0]+a[1]*b[1]+a[2]*b[2]; }
  var z = norm(sub(eye, ctr));
  var x = norm(cross(up, z));
  var y = cross(z, x);
  return [
    x[0], y[0], z[0], 0,
    x[1], y[1], z[1], 0,
    x[2], y[2], z[2], 0,
    -dot(x, eye), -dot(y, eye), -dot(z, eye), 1
  ];
}
function mat4Mul(a, b) {
  var o = new Array(16);
  for (var c = 0; c < 4; c++) for (var r = 0; r < 4; r++) {
    var s = 0;
    for (var k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
    o[c * 4 + r] = s;
  }
  return o;
}

function buildMesh(gl) {
  // triangle-strip lattice GRID_W x GRID_D with degenerate verts between rows.
  var verts = [];
  for (var z = 0; z < GRID_D - 1; z++) {
    var z0 = z / (GRID_D - 1), z1 = (z + 1) / (GRID_D - 1);
    for (var x = 0; x < GRID_W; x++) {
      var xn = x / (GRID_W - 1);
      verts.push(xn, z0, xn, z1);
    }
    // degenerate to wrap to next row
    var lastx = (GRID_W - 1) / (GRID_W - 1);
    verts.push(lastx, z1, 0, z1);
  }
  var arr = new Float32Array(verts);
  var buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, arr, gl.STATIC_DRAW);
  return { buf: buf, count: arr.length / 2 };
}

function makeRT(gl, w, h, withDepth) {
  var tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  var fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  var depth = null;
  if (withDepth) {
    depth = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, w, h);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { tex: tex, fb: fb, depth: depth, w: w, h: h };
}

function lerp(a, b, t) { return a + (b - a) * t; }
function lerpPreset(a, b, t) {
  var o = {};
  for (var i = 0; i < CANYON_COLS.length; i++) {
    var k = CANYON_COLS[i];
    o[k] = lerp(a[k], b[k], t);
  }
  return o;
}

// Resolve shared host objects. The host's `globeGL`/`globeCanvas`/`xmbCanvas`
// are top-level `const`/`let` (NOT window properties), so we cannot read them
// directly from this IIFE. Instead we grab the same DOM canvases by id and
// re-call getContext (returns the EXISTING context for that canvas) so we share
// the very same WebGL state the host uses. If the host has inlined this module,
// these helpers still resolve correctly.
function getGlobeCanvas() {
  return (typeof globeCanvas !== 'undefined' && globeCanvas) ||
         global.globeCanvas || document.getElementById('globe');
}
function getXmbCanvas() {
  return (typeof xmbCanvas !== 'undefined' && xmbCanvas) ||
         global.xmbCanvas || document.getElementById('xmb') ||
         document.querySelector('canvas');
}
function getGL() {
  if (typeof globeGL !== 'undefined' && globeGL) return globeGL;
  if (global.globeGL) return global.globeGL;
  if (typeof initGlobe === 'function') { try { initGlobe(); } catch (e) {} }
  if (typeof globeGL !== 'undefined' && globeGL) return globeGL;
  if (global.globeGL) return global.globeGL;
  var c = getGlobeCanvas();
  // getContext with the same id returns the already-created context.
  return c && (c.getContext('webgl', { alpha: true, premultipliedAlpha: false,
    antialias: true, preserveDrawingBuffer: true }) ||
    c.getContext('experimental-webgl'));
}

// ---------------------------------------------------------------
// Public API
// ---------------------------------------------------------------
function initCanyon() {
  if (typeof initGlobe === 'function') { try { initGlobe(); } catch (e) {} }
  var gl = getGL();
  if (!gl || st) return;

  st = {
    gl: gl,
    terr: link(gl, TERRAIN_VS, TERRAIN_FS),
    blur: link(gl, BLUR_VS, BLUR_FS),
    present: link(gl, BLUR_VS, PRESENT_FS),
    mesh: buildMesh(gl),
    quad: null,
    normal: gl.createTexture(),
    normalReady: false,
    feedA: null, feedB: null, scene: null,
    rtW: 0, rtH: 0,
    // preset cycle clock
    presetIdx: 0,
    presetT: 0,        // 0..1 within current crossfade
    camZ: 0
  };

  // fullscreen quad
  st.quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, st.quad);
  gl.bufferData(gl.ARRAY_BUFFER,
    new Float32Array([-1,-1, 1,-1, -1,1, -1,1, 1,-1, 1,1]), gl.STATIC_DRAW);

  // placeholder 1x1 normal (lavender) until the PNG loads
  gl.bindTexture(gl.TEXTURE_2D, st.normal);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
    new Uint8Array([128, 128, 255, 255]));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

  var img = new Image();
  img.onload = function () {
    gl.bindTexture(gl.TEXTURE_2D, st.normal);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);  // DDS bottom-up -> flip
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    st.normalReady = true;
  };
  img.src = NORMAL_URL;
}

function ensureRTs(gl, w, h) {
  // half-res feedback buffers (spec: 256x144 / 512x288). Use half of canvas.
  var hw = Math.max(2, w >> 1), hh = Math.max(2, h >> 1);
  if (st.rtW === hw && st.rtH === hh && st.feedA) return;
  if (st.feedA) { gl.deleteFramebuffer(st.feedA.fb); gl.deleteTexture(st.feedA.tex); }
  if (st.feedB) { gl.deleteFramebuffer(st.feedB.fb); gl.deleteTexture(st.feedB.tex); }
  if (st.scene) { gl.deleteFramebuffer(st.scene.fb); gl.deleteTexture(st.scene.tex); if (st.scene.depth) gl.deleteRenderbuffer(st.scene.depth); }
  st.feedA = makeRT(gl, hw, hh);
  st.feedB = makeRT(gl, hw, hh);
  st.scene = makeRT(gl, hw, hh, true);
  st.rtW = hw; st.rtH = hh;
  // clear feedback buffers
  [st.feedA, st.feedB].forEach(function (rt) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, rt.fb);
    gl.viewport(0, 0, rt.w, rt.h);
    gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
  });
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}

function drawQuad(gl, prog) {
  gl.bindBuffer(gl.ARRAY_BUFFER, st.quad);
  var l = gl.getAttribLocation(prog, 'aPos');
  gl.enableVertexAttribArray(l);
  gl.vertexAttribPointer(l, 2, gl.FLOAT, false, 0, 0);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
}

// preset cycle: ~7s per preset, cross-fade over the whole dwell.
var PRESET_DWELL = 7.0;   // seconds per preset

function mpDrawCanyon(bands) {
  initCanyon();
  var gl = getGL();
  if (!gl || !st) return false;

  var xc = getXmbCanvas(), gc = getGlobeCanvas();
  if (!xc || !gc) return false;
  if (gc.width !== xc.width || gc.height !== xc.height) {
    gc.width = xc.width; gc.height = xc.height;
  }
  var W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
  if (!W || !H) return false;
  ensureRTs(gl, W, H);

  var dt = 0.016;
  // advance preset cycle
  st.presetT += dt / PRESET_DWELL;
  while (st.presetT >= 1.0) { st.presetT -= 1.0; st.presetIdx = (st.presetIdx + 1) % PRESETS.length; }
  var a = PRESETS[st.presetIdx];
  var b = PRESETS[(st.presetIdx + 1) % PRESETS.length];
  // smoothstep cross-fade
  var tt = st.presetT * st.presetT * (3.0 - 2.0 * st.presetT);
  var P = lerpPreset(a, b, tt);

  // camera flies forward at POS SPEED (+ bass surge), scrolls terrain via camZ
  var bass = (bands && bands.bass) || 0, mid = (bands && bands.mid) || 0;
  st.camZ += dt * P.speed * (1.0 + bass * 0.5);

  var halfW = 120.0, depth = 260.0;
  var eye = [P.posX, P.posY, st.camZ];
  var tar = [P.tarX, P.tarY, st.camZ + (P.tarZ - P.posZ)];  // target ahead, relative
  var fov = (P.zoom * Math.PI / 180.0);
  var aspect = W / H;
  var proj = mat4Perspective(fov, aspect, 0.5, 2000.0);
  var view = mat4LookAt(eye, tar, [0, 1, 0]);
  var mvp = mat4Mul(proj, view);

  // ---- pass 1: terrain -> scene RT (half-res) ----
  gl.bindFramebuffer(gl.FRAMEBUFFER, st.scene.fb);
  gl.viewport(0, 0, st.scene.w, st.scene.h);
  gl.enable(gl.DEPTH_TEST);
  gl.clearColor(P.fogR, P.fogG, P.fogB, 1.0);   // sky = fog colour
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.useProgram(st.terr);
  gl.bindBuffer(gl.ARRAY_BUFFER, st.mesh.buf);
  var la = gl.getAttribLocation(st.terr, 'aGrid');
  gl.enableVertexAttribArray(la);
  gl.vertexAttribPointer(la, 2, gl.FLOAT, false, 0, 0);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, st.normal);
  function uf(n, v) { gl.uniform1f(gl.getUniformLocation(st.terr, n), v); }
  function u3(n, x, y, z) { gl.uniform3f(gl.getUniformLocation(st.terr, n), x, y, z); }
  gl.uniformMatrix4fv(gl.getUniformLocation(st.terr, 'uMVP'), false, new Float32Array(mvp));
  u3('uCamPos', eye[0], eye[1], eye[2]);
  gl.uniform1i(gl.getUniformLocation(st.terr, 'uNormal'), 0);
  uf('uScroll', st.camZ);
  uf('uHalfW', halfW); uf('uDepth', depth);
  uf('uTHeight', P.tHeight); uf('uTWidth', Math.max(P.tWidth, 0.1));
  uf('uTScaleX', Math.max(P.tScaleX, 0.1)); uf('uTexScale', Math.max(P.tTexScale, 0.1));
  uf('uTSlide', P.tSlide);
  uf('uVHeight', P.vHeight); uf('uVCentre', P.vCentre);
  uf('uVWidth', P.vWidth); uf('uVSharp', P.vSharp);
  uf('uFogMin', P.fogMin); uf('uFogRange', Math.max(P.fogMax - P.fogMin, 0.001));
  // terrain fragment colour / fog / line / bump uniforms (COLOUR + LINE + FOG blocks)
  u3('uColour', P.colR, P.colG, P.colB);
  uf('uColScale', P.colScale); uf('uColBias', P.colBias);
  u3('uLineColour', P.lineR, P.lineG, P.lineB);
  u3('uFogColour', P.fogR, P.fogG, P.fogB);
  uf('uBump', P.tBump);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, st.mesh.count);

  // ---- pass 2: feedback compositor (scene + warped prev) -> feedB ----
  gl.disable(gl.DEPTH_TEST);
  gl.bindFramebuffer(gl.FRAMEBUFFER, st.feedB.fb);
  gl.viewport(0, 0, st.feedB.w, st.feedB.h);
  gl.useProgram(st.blur);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, st.scene.tex);
  gl.uniform1i(gl.getUniformLocation(st.blur, 'uCurrent'), 0);
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, st.feedA.tex);
  gl.uniform1i(gl.getUniformLocation(st.blur, 'uPrev'), 1);
  gl.uniform1f(gl.getUniformLocation(st.blur, 'uFeedback'), P.feedback);
  gl.uniform2f(gl.getUniformLocation(st.blur, 'uFeedScale'), P.feedX, P.feedY);
  gl.uniform1f(gl.getUniformLocation(st.blur, 'uFeedRot'), P.feedRot * Math.PI / 180.0);
  drawQuad(gl, st.blur);

  // swap feedback buffers (B becomes new prev)
  var tmp = st.feedA; st.feedA = st.feedB; st.feedB = tmp;

  // ---- pass 3: tonemap present feedA -> screen ----
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, W, H);
  gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
  gl.useProgram(st.present);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, st.feedA.tex);
  gl.uniform1i(gl.getUniformLocation(st.present, 'uTex'), 0);
  gl.uniform1f(gl.getUniformLocation(st.present, 'uExposure'), 1.0 + mid * 0.3);
  drawQuad(gl, st.present);

  return true;
}

global.initCanyon = initCanyon;
global.mpDrawCanyon = mpDrawCanyon;

})(typeof window !== 'undefined' ? window : this);
