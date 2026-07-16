/*
 PSP Go XMB slide clock - PROCEDURAL 1:1 port. Everything drawn in code (vector
 shapes + glyphs), NO textures/screenshots. Geometry + animation are the values
 decompiled from slide_plugin.prx (see /work/ps3/psp_clock/dis/clock_analysis.json):

 - Layout (OnInit / sub_1D248): 480x272, centre (240,136). Angle convention
   theta = PI/2 - frac*2PI, screen (240 + R*cos theta, 136 - R*sin theta) so
   frac 0 = 12 o'clock up, increasing frac turns clockwise.
     second ring  : 120 dots, R = 126
     hour ticks   : hours {1,2,4,5,7,8,10,11}, R = 131
     numerals     : 12@R116(top) 3@R120(right) 6@R113(bottom) 9@R118(left)
     glass disc   : R ~ 141 ; hub at centre
 - Hand angles (sub_1CDE4), recomputed absolutely each frame:
     hourFrac   = h/12 + m/720
     minuteFrac = m/60 + s/3600
     second     : t=usec/1e6; e=sqrt(1-(t-1)^2); E=e+1.2*e*(1-e); frac=E*(2-E);
                  secFrac=(s+frac)/60      (spring-eased "quartz" snap)
 - Second-hand TRAIL (sub_1D07C): 120-dot ring; the dot at index sec*2 is full
   (and sec*2+1 once usec>50000), every other dot's alpha *= 0.98 each frame ->
   a fading comet tail behind the second hand.
 - Date (sub_1D07C): weekday = sceRtcGetDayOfWeek (0=Sun), day split tens/units.
 - Colours: the plugin's palette tables (0x1B19B0 face / 0x1B1708 ring / 0x1B1460
   ticks / 0x1B4188 metal): white glyphs with a cyan glow, light-blue glass.
*/
(function (global) {
  'use strict';
  var PSP_W = 480, PSP_H = 272, CX = 240, CY = 136;
  var TWO_PI = Math.PI * 2, HALF_PI = Math.PI / 2;

  // The clock face is a CIRCLE. The GE draw list (the plugin's actual draw commands)
  // places the disc, second-dot ring and ticks at a UNIFORM radius in every
  // direction - it is authored round. (The slight horizontal ellipse seen in jpcsp
  // SCREENSHOTS is a viewport/projection artifact of the emulator, not the design;
  // per the project rule we follow the GE/disassembly, not the screenshot.)
  // --- geometry: element-centre radii (px), from the GE draw list + binary ---
  var R_RING = 126, R_HTICK = 131, R_DISC = 141;   // hour-tick centre R131 (disasm f22=131.0 @0x1D8FC), glass disc R141 -> dashes span R122..R140, reaching the disc edge
  var HOUR_TICKS = [1, 2, 4, 5, 7, 8, 10, 11];
  // Per-numeral radius overrides straight from the binary (sub_1D248: 12=r116
  // 0x42E8, 3=r120 0x42F0, 6=r113, 9=r118) - the four numerals have individual
  // design radii, NOT a global squash.
  var NUMERALS = [
    { s: '12', frac: 0 / 12, R: 116 },
    { s: '3',  frac: 3 / 12, R: 120 },
    { s: '6',  frac: 6 / 12, R: 113 },
    { s: '9',  frac: 9 / 12, R: 118 },
  ];
  // Clock hour numerals traced from the plugin's own light display font (NOT New
  // Rodin/ltn0). 3/6/9 come straight from the atlas numeral sprites
  // (assets/wave/gim_034/037/040). The combined "12" atlas sprite (gim_031) is
  // TRUNCATED (the 2 runs off the 71px cell), so "12" is composed from the plugin's
  // individual digit glyphs "1"+"2" (assets/glyphs/digits_thin, the same light face),
  // pasted by their INK bbox (those PNGs carry a stray edge pixel + wide side-bearing
  // that must be ignored). The 1-to-2 GAP = 0.233 of the glyph height, MEASURED from
  // the truncated source sprite gim_031 (its 1-2 gap is intact: 10px @ 43px cap).
  // Each path is normalized to height 100, centred at the origin, y-down (12 ~111 wide).
  var NUM_GLYPHS = {
    '12': { w: 110.91, d: 'M-39.18 -49.6 C-39.31 -49.31 -39.55 -49.16 -39.93 -49.13 C-40.35 -49.09 -40.82 -48.73 -41.82 -47.71 C-42.8 -46.73 -43.31 -46.36 -43.64 -46.36 C-43.96 -46.36 -44.38 -46.07 -45 -45.45 C-45.62 -44.84 -46.04 -44.55 -46.36 -44.55 C-46.69 -44.55 -47.2 -44.16 -48.18 -43.18 C-49.16 -42.2 -49.67 -41.82 -50 -41.82 C-50.33 -41.82 -50.84 -41.44 -51.82 -40.45 C-52.82 -39.45 -53.29 -39.09 -53.65 -39.09 C-53.91 -39.09 -54.31 -38.89 -54.55 -38.64 C-54.78 -38.38 -55.07 -38.18 -55.22 -38.18 C-55.42 -38.18 -55.45 -36.91 -55.45 -31.36 C-55.45 -24.02 -55.45 -24.04 -54.55 -25 C-54.31 -25.25 -53.91 -25.45 -53.65 -25.45 C-53.29 -25.45 -52.82 -25.82 -51.82 -26.82 C-50.84 -27.8 -50.33 -28.18 -50 -28.18 C-49.67 -28.18 -49.16 -28.56 -48.18 -29.55 C-47.2 -30.53 -46.69 -30.91 -46.36 -30.91 C-46.04 -30.91 -45.62 -31.2 -45 -31.82 C-44.38 -32.44 -43.96 -32.73 -43.64 -32.73 C-43.31 -32.73 -42.8 -33.09 -41.82 -34.09 C-40.78 -35.13 -40.42 -35.4 -40.24 -35.24 C-40.04 -35.09 -40 -27.36 -40 7.47 L-40 50 L-34.55 50 L-29.09 50 L-29.09 0 L-29.09 -50 L-34.05 -50 L-39 -50 L-39.18 -49.6 Z M16.27 -49.6 C16.15 -49.31 15.91 -49.16 15.53 -49.13 C15.22 -49.09 14.76 -48.87 14.53 -48.62 C14.2 -48.27 13.95 -48.18 13.18 -48.18 C12.42 -48.18 12.16 -48.09 11.82 -47.73 C11.58 -47.47 11.18 -47.27 10.91 -47.27 C10.58 -47.27 10.16 -47 9.55 -46.36 C8.93 -45.75 8.51 -45.45 8.18 -45.45 C7.51 -45.45 0.91 -38.84 0.91 -38.18 C0.91 -37.85 0.62 -37.42 0 -36.82 C-0.64 -36.2 -0.91 -35.78 -0.91 -35.45 C-0.91 -35.18 -1.11 -34.78 -1.36 -34.55 C-1.62 -34.29 -1.82 -33.91 -1.82 -33.64 C-1.82 -33.36 -2.02 -32.98 -2.27 -32.73 C-2.53 -32.47 -2.73 -32.09 -2.73 -31.82 C-2.73 -31.55 -2.93 -31.16 -3.18 -30.91 C-3.58 -30.53 -3.64 -30.35 -3.64 -29.09 C-3.64 -27.84 -3.69 -27.65 -4.09 -27.27 C-4.55 -26.85 -4.55 -26.8 -4.55 -24.09 C-4.55 -21.38 -4.55 -21.33 -5 -20.91 L-5.45 -20.47 L-4.78 -19.78 L-4.11 -19.09 L0.45 -19.09 L5.02 -19.09 L5.69 -19.78 L6.36 -20.47 L6.36 -22.75 C6.36 -24.95 6.38 -25.04 6.82 -25.45 C7.18 -25.8 7.27 -26.05 7.27 -26.82 C7.27 -27.58 7.36 -27.84 7.73 -28.18 C7.98 -28.44 8.18 -28.82 8.18 -29.09 C8.18 -29.36 8.38 -29.75 8.64 -30 C8.89 -30.24 9.09 -30.64 9.09 -30.89 C9.09 -31.56 13.89 -36.36 14.56 -36.36 C14.87 -36.36 15.31 -36.65 15.91 -37.27 C16.75 -38.13 16.85 -38.18 17.73 -38.18 C18.49 -38.18 18.75 -38.27 19.09 -38.64 C19.47 -39.04 19.65 -39.09 20.91 -39.09 C22.16 -39.09 22.35 -39.15 22.73 -39.55 C23.15 -40 23.2 -40 25.91 -40 C28.62 -40 28.67 -40 29.09 -39.55 C29.47 -39.15 29.65 -39.09 30.91 -39.09 C32.16 -39.09 32.35 -39.04 32.73 -38.64 C32.98 -38.38 33.36 -38.18 33.64 -38.18 C33.91 -38.18 34.29 -37.98 34.55 -37.73 C34.78 -37.47 35.18 -37.27 35.44 -37.27 C36.13 -37.27 41.82 -31.58 41.82 -30.89 C41.82 -30.64 42.02 -30.24 42.27 -30 C42.53 -29.75 42.73 -29.36 42.73 -29.09 C42.73 -28.82 42.93 -28.44 43.18 -28.18 C43.58 -27.8 43.64 -27.62 43.64 -26.36 C43.64 -25.11 43.69 -24.93 44.09 -24.55 L44.55 -24.13 L44.55 -20.45 L44.55 -16.78 L44.09 -16.36 C43.84 -16.11 43.64 -15.73 43.64 -15.45 C43.64 -15.18 43.44 -14.8 43.18 -14.55 C42.93 -14.29 42.73 -13.91 42.73 -13.64 C42.73 -13.36 42.53 -12.98 42.27 -12.73 C42.02 -12.47 41.82 -12.09 41.82 -11.82 C41.82 -11.55 41.62 -11.16 41.36 -10.91 C41.11 -10.67 40.91 -10.27 40.91 -10.02 C40.91 -9.65 40.55 -9.18 39.55 -8.18 C38.56 -7.2 38.18 -6.69 38.18 -6.36 C38.18 -6 37 -4.73 32.73 -0.45 C28.47 3.8 27.27 5.09 27.27 5.45 C27.27 5.82 25.35 7.84 18.18 15 C11.02 22.16 9.09 24.18 9.09 24.55 C9.09 24.91 7.53 26.56 1.82 32.27 L-5.45 39.55 L-5.45 44.76 L-5.45 50 L25 50 L55.45 50 L55.45 45 L55.45 40 L32.93 40 C14.65 40 10.36 39.96 10.22 39.76 C10.05 39.58 10.85 38.69 13.64 35.91 C16.44 33.11 17.27 32.16 17.27 31.82 C17.27 31.45 19.18 29.45 26.36 22.27 C33.53 15.11 35.45 13.09 35.45 12.73 C35.45 12.36 36.75 10.98 41.36 6.36 C46 1.73 47.27 0.36 47.27 0 C47.27 -0.33 47.65 -0.84 48.64 -1.82 C49.64 -2.82 50 -3.29 50 -3.65 C50 -3.91 50.2 -4.31 50.45 -4.55 C50.71 -4.78 50.91 -5.18 50.91 -5.45 C50.91 -5.78 51.18 -6.2 51.82 -6.82 C52.45 -7.44 52.73 -7.85 52.73 -8.18 C52.73 -8.45 52.93 -8.85 53.18 -9.09 C53.55 -9.44 53.64 -9.69 53.64 -10.45 C53.64 -11.22 53.73 -11.47 54.09 -11.82 C54.44 -12.15 54.55 -12.44 54.58 -13.25 C54.64 -14.11 54.71 -14.31 55.05 -14.45 L55.45 -14.64 L55.45 -20.45 L55.45 -26.27 L55.05 -26.45 C54.67 -26.62 54.64 -26.78 54.58 -28.11 C54.55 -29.4 54.47 -29.64 54.09 -30 C53.73 -30.35 53.64 -30.6 53.64 -31.36 C53.64 -32.13 53.55 -32.38 53.18 -32.73 C52.93 -32.98 52.73 -33.36 52.73 -33.64 C52.73 -33.91 52.53 -34.29 52.27 -34.55 C52.02 -34.8 51.82 -35.18 51.82 -35.45 C51.82 -35.73 51.62 -36.11 51.36 -36.36 C51.11 -36.6 50.91 -37 50.91 -37.25 C50.91 -37.95 42.49 -46.36 41.8 -46.36 C41.55 -46.36 41.15 -46.56 40.91 -46.82 C40.65 -47.07 40.27 -47.27 40 -47.27 C39.73 -47.27 39.35 -47.47 39.09 -47.73 C38.84 -47.98 38.45 -48.18 38.18 -48.18 C37.91 -48.18 37.53 -48.36 37.27 -48.64 C36.95 -48.98 36.65 -49.09 35.84 -49.13 C34.98 -49.18 34.78 -49.25 34.64 -49.6 L34.45 -50 L25.45 -50 L16.45 -50 L16.27 -49.6 Z' },
    '3': { w: 58.95, d: 'M-3.68 -49.62 C-4.2 -49.48 -5.32 -49.21 -6.14 -48.96 C-6.96 -48.74 -8.6 -48.44 -9.74 -48.31 C-11.38 -48.12 -12.04 -47.9 -12.69 -47.35 C-13.16 -46.94 -14.06 -46.48 -14.68 -46.32 C-15.31 -46.15 -16.27 -45.61 -16.84 -45.11 C-17.39 -44.62 -18.12 -44.05 -18.48 -43.86 C-18.8 -43.67 -19.84 -42.85 -20.77 -42.06 C-21.94 -41.02 -22.54 -40.26 -22.76 -39.49 C-22.95 -38.92 -23.5 -38.05 -24.02 -37.58 C-24.67 -36.98 -25 -36.41 -25.11 -35.62 C-25.22 -34.99 -25.66 -33.84 -26.09 -33.11 C-27.73 -30.19 -27.51 -28.28 -25.3 -25.96 C-23.77 -24.34 -23.72 -24.32 -21.92 -24.13 C-20.91 -24.04 -19.57 -24.04 -18.91 -24.13 C-17.63 -24.32 -16.24 -24.95 -16.24 -25.3 C-16.24 -25.44 -15.8 -25.79 -15.28 -26.12 C-14.63 -26.5 -14.14 -27.1 -13.78 -27.95 C-13.48 -28.66 -12.94 -29.56 -12.61 -29.97 C-12.25 -30.38 -11.82 -31.09 -11.63 -31.58 C-11.41 -32.04 -11.16 -32.42 -11.03 -32.42 C-10.89 -32.42 -10.29 -32.91 -9.66 -33.54 C-9.06 -34.14 -7.81 -35.02 -6.88 -35.45 C-5.95 -35.89 -4.8 -36.46 -4.37 -36.71 C-3.68 -37.09 -2.84 -37.15 0.27 -37.12 C4.01 -37.06 4.12 -37.04 6.06 -36.11 C7.15 -35.59 8.22 -35.15 8.43 -35.15 C8.82 -35.15 11.68 -32.4 13.07 -30.62 C14.44 -28.96 15.42 -22.76 14.74 -20.28 C14.52 -19.54 14.27 -18.34 14.19 -17.66 C14.08 -16.78 13.73 -16.02 13.02 -15.07 C11.6 -13.24 9.22 -10.86 8.82 -10.86 C8.62 -10.86 8.11 -10.56 7.67 -10.18 C6.71 -9.36 6.55 -9.33 3.19 -8.98 C0.49 -8.68 0.38 -8.65 -2.32 -6.17 C-3.11 -5.49 -3.14 -5.35 -3.14 -3.08 L-3.14 -0.74 L-1.83 0.63 C-0.11 2.46 3 3.77 6.77 4.28 C7.61 4.39 8.38 4.72 8.95 5.21 C9.44 5.65 10.21 6.2 10.7 6.44 C11.19 6.69 11.74 7.15 11.9 7.51 C12.06 7.83 12.61 8.49 13.1 8.95 C13.65 9.47 14.14 10.29 14.33 11 C14.49 11.65 14.98 12.69 15.37 13.26 C16.1 14.33 16.1 14.41 16.18 19.43 L16.29 24.56 L15.45 25.49 C15.01 26.01 14.49 27.02 14.3 27.76 C14.08 28.63 13.62 29.45 12.99 30.08 C12.45 30.62 11.82 31.3 11.57 31.6 C11.3 31.88 10.81 32.37 10.48 32.7 C10.13 33 9.61 33.52 9.36 33.84 C9.12 34.14 8.38 34.55 7.72 34.72 C6.55 35.02 6.25 35.13 4.5 36.11 C3.68 36.54 3 36.63 -0.46 36.63 L-4.45 36.63 L-6.25 35.67 C-7.26 35.15 -8.3 34.72 -8.6 34.72 C-8.9 34.72 -9.61 34.31 -10.15 33.82 C-10.73 33.32 -11.63 32.59 -12.2 32.18 C-13.21 31.44 -15.5 28.38 -16.1 26.99 C-16.65 25.71 -19.05 23.42 -20.85 22.49 C-23.25 21.26 -24.15 21.32 -26.45 22.84 C-27.48 23.53 -28.41 24.07 -28.52 24.07 C-29.04 24.07 -29.48 25.98 -29.45 28.11 C-29.42 30.16 -29.31 30.59 -28.44 32.34 C-27.89 33.43 -27.27 34.77 -27.02 35.34 C-26.8 35.94 -26.34 36.63 -25.96 36.93 C-25.6 37.2 -25.16 37.77 -25 38.21 C-24.81 38.65 -24.37 39.16 -24.02 39.36 C-23.69 39.55 -23.23 39.98 -23.03 40.37 C-22.84 40.72 -22.35 41.21 -21.94 41.46 C-21.53 41.7 -21.04 42.19 -20.85 42.52 C-20.69 42.85 -20.17 43.29 -19.73 43.48 C-19.3 43.64 -18.7 44.1 -18.42 44.49 C-18.09 44.87 -17.22 45.39 -16.32 45.69 C-15.45 45.96 -14.3 46.51 -13.78 46.86 C-12.8 47.54 -10.23 48.06 -7.78 48.09 C-6.25 48.09 -5.21 48.61 -5.1 49.4 C-5.02 49.92 -4.86 50 -3.68 50 C-2.95 50 -2.27 49.86 -2.18 49.73 C-2.1 49.56 -1.53 49.45 -0.96 49.45 C-0.38 49.45 0.19 49.56 0.27 49.73 C0.35 49.86 1.04 50 1.75 50 C2.87 50 3.08 49.92 3.36 49.32 C3.68 48.58 3.79 48.55 7.37 48.09 C10.67 47.65 11.68 47.38 12.53 46.7 C12.94 46.37 13.86 45.96 14.6 45.77 C15.91 45.41 16.59 44.95 19.71 42.28 C20.55 41.57 21.34 40.99 21.45 40.99 C21.81 40.99 24.92 36.98 25.35 36 C25.55 35.48 25.98 34.88 26.26 34.69 C26.99 34.17 27.32 33.49 27.73 31.58 C27.92 30.68 28.38 29.39 28.77 28.71 L29.48 27.48 L29.48 20.25 L29.48 12.99 L28.6 11.11 C28.14 10.04 27.67 8.65 27.57 7.97 C27.43 7.18 27.1 6.52 26.61 6.06 C26.2 5.68 25.6 4.86 25.3 4.26 C25 3.66 24.54 2.97 24.26 2.76 C24.02 2.57 23.53 1.91 23.17 1.36 C22.82 0.79 22.05 0.11 21.45 -0.19 C19.24 -1.34 18.2 -3.63 19.6 -4.34 C19.92 -4.5 20.63 -5.1 21.15 -5.65 C21.7 -6.2 22.38 -6.82 22.65 -7.07 C23.69 -7.94 25 -9.77 25.38 -10.89 C25.6 -11.52 26.15 -12.42 26.58 -12.94 C27.18 -13.62 27.43 -14.22 27.57 -15.42 C27.81 -17.39 28.08 -18.56 28.68 -20.17 C29.12 -21.26 29.12 -21.72 28.88 -23.58 C28.19 -28.41 27.21 -33.16 26.72 -34.01 C26.45 -34.53 25.85 -35.59 25.38 -36.38 C24.07 -38.67 23.06 -40.01 21.12 -41.95 C17.79 -45.28 16.76 -45.96 14.55 -46.45 C14.16 -46.53 13.46 -46.94 12.99 -47.33 C12.31 -47.9 11.63 -48.12 9.47 -48.39 C8.02 -48.58 5.38 -49.02 3.6 -49.32 C0.27 -49.92 -2.02 -50 -3.68 -49.62 Z' },
    '6': { w: 64.35, d: 'M10.62 -49.39 C9.17 -49.06 8.01 -48.57 8.01 -48.32 C8.01 -48.21 7.46 -47.5 6.8 -46.78 C6.14 -46.04 5.34 -44.91 5.04 -44.3 C4.71 -43.67 4.27 -43.09 4.05 -43.01 C3.83 -42.93 3.41 -42.43 3.17 -41.94 C2.92 -41.44 2.39 -40.67 2.04 -40.2 C0.61 -38.41 -0.55 -36.84 -1.35 -35.6 C-1.82 -34.92 -2.37 -34.26 -2.59 -34.17 C-2.81 -34.09 -3.3 -33.4 -3.66 -32.66 C-4.05 -31.92 -4.54 -31.17 -4.76 -31.06 C-4.95 -30.95 -5.45 -30.24 -5.84 -29.47 C-6.22 -28.72 -6.85 -27.79 -7.24 -27.43 C-7.62 -27.04 -7.95 -26.58 -7.95 -26.38 C-7.95 -26.16 -8.45 -25.47 -9.06 -24.87 C-9.66 -24.24 -10.16 -23.6 -10.16 -23.49 C-10.16 -23.38 -10.57 -22.8 -11.09 -22.25 C-11.59 -21.68 -12.28 -20.69 -12.61 -20.02 C-12.94 -19.36 -13.4 -18.76 -13.63 -18.68 C-13.85 -18.59 -14.26 -18.07 -14.53 -17.52 C-14.84 -16.97 -15.33 -16.28 -15.66 -15.98 C-15.99 -15.68 -16.52 -14.93 -16.85 -14.33 C-17.4 -13.2 -18.66 -11.6 -20.26 -9.9 C-20.75 -9.37 -21.17 -8.77 -21.17 -8.55 C-21.17 -8.33 -21.58 -7.67 -22.1 -7.09 C-22.63 -6.51 -23.26 -5.52 -23.51 -4.89 C-23.78 -4.25 -24.22 -3.59 -24.5 -3.43 C-24.77 -3.29 -25.27 -2.68 -25.57 -2.08 C-25.87 -1.5 -26.42 -0.54 -26.81 0.01 C-27.2 0.56 -27.66 1.61 -27.88 2.3 C-28.08 3.01 -28.63 4.17 -29.09 4.89 C-29.53 5.6 -30 6.79 -30.11 7.47 C-30.22 8.19 -30.53 9.4 -30.8 10.17 C-31.71 12.62 -32.18 15.24 -32.18 17.96 C-32.18 20.24 -32.04 21.04 -31.21 23.63 C-30.69 25.25 -30.17 27.24 -30.09 27.98 C-29.95 28.94 -29.64 29.66 -29.01 30.43 C-28.49 31.03 -28.02 31.97 -27.91 32.58 C-27.77 33.35 -27.44 33.93 -26.64 34.61 C-26.07 35.16 -25.57 35.77 -25.57 35.96 C-25.57 36.15 -24.47 37.45 -23.15 38.8 C-19.68 42.32 -18.91 43.01 -17.78 43.48 C-17.23 43.7 -16.65 44.14 -16.49 44.41 C-16.35 44.72 -15.47 45.18 -14.45 45.54 C-13.46 45.84 -12.52 46.31 -12.33 46.53 C-11.73 47.27 -11.09 47.47 -7.84 47.88 C-4.32 48.35 -3.44 48.6 -2.53 49.45 C-1.98 49.97 -1.82 50 -1.18 49.7 C-0.66 49.48 -0.36 49.45 -0.14 49.67 C0 49.81 1.05 49.94 2.12 49.94 C3.77 49.94 4.16 49.86 4.27 49.45 C4.54 48.62 5.42 48.29 8.56 47.88 C11.12 47.55 11.78 47.36 12.77 46.67 C13.4 46.23 14.42 45.73 15.06 45.57 C15.66 45.4 16.41 45.02 16.71 44.69 C16.98 44.36 17.81 43.81 18.52 43.45 C19.9 42.73 20.4 42.32 23.29 39.49 C25.6 37.23 27.28 35.19 27.28 34.67 C27.28 34.48 27.69 33.7 28.21 32.96 C28.71 32.22 29.34 30.92 29.56 30.1 C29.81 29.25 30.28 28.25 30.58 27.87 C31.21 27.04 31.54 25.53 31.9 21.73 C32.18 18.87 32.18 17.49 31.85 12.24 C31.6 8.57 31.35 7.36 30.58 6.37 C30.28 5.99 29.81 4.91 29.51 4 C29.23 3.07 28.6 1.89 28.13 1.36 C27.66 0.81 27.28 0.21 27.28 0.01 C27.28 -0.18 26.95 -0.62 26.56 -1 C26.18 -1.36 25.54 -2.19 25.16 -2.85 C24.53 -3.92 23.64 -4.72 20.45 -7.09 C19.9 -7.5 19.08 -8.22 18.61 -8.66 C18.14 -9.1 17.34 -9.54 16.76 -9.62 C16.21 -9.73 15.25 -10.23 14.64 -10.72 C13.71 -11.52 13.27 -11.66 10.98 -11.96 C9.58 -12.15 7.95 -12.54 7.4 -12.81 C6.06 -13.53 2.37 -13.58 0.94 -12.9 C0 -12.46 -0.06 -12.46 -0.41 -12.95 C-0.63 -13.25 -0.72 -13.75 -0.61 -14.16 C-0.47 -14.82 -0.14 -15.32 1.62 -17.63 C1.95 -18.1 2.61 -19.03 3.08 -19.78 C3.55 -20.49 4.02 -21.07 4.13 -21.07 C4.27 -21.07 4.73 -21.81 5.23 -22.69 C5.7 -23.58 6.28 -24.37 6.47 -24.46 C6.69 -24.54 7.07 -25.03 7.32 -25.53 C7.6 -26.03 8.09 -26.74 8.45 -27.13 C8.84 -27.51 9.5 -28.36 9.94 -29.05 C10.4 -29.74 11.31 -31.03 12 -31.94 C12.69 -32.85 13.46 -33.95 13.71 -34.42 C13.98 -34.86 14.53 -35.55 14.92 -35.93 C15.33 -36.32 15.94 -37.2 16.27 -37.86 C16.6 -38.55 17.23 -39.49 17.64 -39.98 C18.52 -40.97 18.91 -42.9 18.61 -44.96 C18.47 -46.09 18.22 -46.5 17.01 -47.69 C15.11 -49.53 13.32 -50 10.62 -49.39 Z M3.28 -0.32 C5.09 -0.07 6.28 0.23 6.61 0.51 C6.88 0.76 7.73 1.2 8.51 1.47 C9.28 1.75 10.43 2.41 11.07 2.9 C12.94 4.39 15.66 7.34 16.13 8.38 C16.57 9.34 16.65 9.51 17.62 10.97 C18.33 12.01 18.61 15.4 18.39 20.33 C18.22 23.91 18.17 24.21 17.45 25.28 C17.04 25.89 16.49 26.8 16.27 27.26 C15.17 29.36 11.62 32.8 9.28 34.01 C4.95 36.29 4.87 36.32 0.5 36.43 C-3.39 36.51 -3.63 36.48 -5.01 35.82 C-5.78 35.44 -7.05 34.86 -7.76 34.56 C-8.51 34.23 -9.52 33.65 -10.05 33.24 C-11.56 32.03 -14.56 29.05 -14.56 28.75 C-14.56 28.61 -14.97 28.06 -15.5 27.54 C-16.21 26.85 -16.49 26.27 -16.63 25.28 C-16.74 24.54 -17.2 23.27 -17.67 22.45 C-18.44 21.07 -18.52 20.69 -18.55 18.32 C-18.58 15.81 -18.55 15.59 -17.67 13.94 C-17.18 12.98 -16.76 11.85 -16.76 11.46 C-16.76 10.12 -16.27 8.93 -15.41 8.22 C-14.95 7.83 -14.56 7.36 -14.56 7.17 C-14.56 6.81 -11.86 4.03 -10.32 2.79 C-9.77 2.35 -8.67 1.75 -7.9 1.45 C-7.1 1.14 -6 0.65 -5.48 0.32 C-4.6 -0.23 -2.92 -0.56 -0.52 -0.65 C0 -0.67 1.71 -0.51 3.28 -0.32 Z' },
    '9': { w: 64.97, d: 'M-3.49 -49.53 C-3.88 -49.36 -5.69 -48.94 -7.53 -48.58 C-10.18 -48.05 -11.43 -47.63 -13.61 -46.54 C-15.11 -45.79 -16.54 -44.98 -16.82 -44.73 C-17.07 -44.51 -17.68 -44.12 -18.15 -43.89 C-19.02 -43.45 -26.07 -36.56 -26.07 -36.14 C-26.07 -36 -26.52 -35.47 -27.05 -34.94 C-27.58 -34.38 -28.03 -33.71 -28.03 -33.44 C-28.03 -33.16 -28.39 -32.38 -28.83 -31.68 C-29.28 -31.01 -29.87 -29.64 -30.12 -28.64 C-30.37 -27.64 -31.01 -25.43 -31.54 -23.73 C-32.43 -20.8 -32.49 -20.36 -32.49 -16.76 C-32.49 -13.13 -32.46 -12.86 -31.76 -11.68 C-31.26 -10.82 -30.87 -9.48 -30.51 -7.39 C-30.15 -5.13 -29.81 -4.07 -29.34 -3.43 C-28.97 -2.96 -28.42 -2.06 -28.11 -1.45 C-27.77 -0.84 -27.24 -0.08 -26.91 0.22 C-26.58 0.53 -26.05 1.23 -25.77 1.76 C-24.93 3.26 -23.31 5.19 -22.39 5.72 C-21.95 6 -21.53 6.41 -21.42 6.64 C-21.33 6.89 -20.75 7.33 -20.11 7.67 C-19.49 7.98 -18.68 8.53 -18.35 8.87 C-18.01 9.2 -17.23 9.62 -16.62 9.82 C-16.01 9.98 -15.14 10.46 -14.7 10.82 C-13.66 11.68 -12.94 11.96 -11.02 12.21 C-10.18 12.33 -8.98 12.63 -8.37 12.86 C-7.61 13.16 -5.94 13.36 -3.21 13.47 L0.84 13.61 L0.81 14.84 C0.78 15.84 0.64 16.17 0.03 16.62 C-0.39 16.9 -1.03 17.74 -1.39 18.46 C-1.76 19.19 -2.26 19.94 -2.51 20.16 C-2.76 20.36 -3.21 21.03 -3.51 21.61 C-3.82 22.2 -4.35 22.87 -4.71 23.09 C-5.08 23.34 -5.52 23.9 -5.72 24.32 C-5.88 24.76 -6.36 25.43 -6.75 25.79 C-7.14 26.13 -7.72 26.99 -8.09 27.69 C-8.45 28.39 -9.06 29.25 -9.45 29.62 C-9.84 30.01 -10.18 30.48 -10.18 30.67 C-10.18 30.9 -10.68 31.54 -11.29 32.07 C-11.91 32.63 -12.41 33.24 -12.41 33.46 C-12.41 33.66 -12.83 34.3 -13.36 34.86 C-13.86 35.44 -14.5 36.36 -14.78 36.89 C-15.03 37.42 -15.56 38.12 -15.92 38.43 C-16.29 38.73 -16.84 39.6 -17.12 40.38 C-17.43 41.13 -17.88 42.3 -18.15 42.97 C-18.63 44.17 -18.63 44.17 -17.9 45.68 C-17.04 47.43 -15.7 49.02 -14.61 49.61 C-14.11 49.86 -12.99 50 -11.46 50 L-9.06 50 L-7.33 48.19 C-5.02 45.82 -3.96 44.51 -3.35 43.31 C-2.87 42.36 -2.23 41.52 -0.06 39.01 C0.5 38.34 0.98 37.67 0.98 37.53 C0.98 37.4 1.39 36.78 1.92 36.17 C2.43 35.58 3.12 34.55 3.46 33.88 C3.79 33.21 4.27 32.6 4.49 32.52 C4.71 32.43 5.13 31.9 5.41 31.34 C5.72 30.79 6.22 30.09 6.55 29.78 C6.89 29.48 7.47 28.67 7.84 27.97 C8.53 26.72 9.76 25.04 11.32 23.23 C11.8 22.7 12.49 21.81 12.86 21.28 C13.8 19.83 15.34 17.74 16.73 15.84 C17.43 14.92 18.21 13.8 18.49 13.36 C18.74 12.91 19.35 12.1 19.83 11.54 C20.3 10.99 20.97 10.01 21.28 9.4 C21.61 8.76 22.06 8.17 22.28 8.09 C22.5 8 22.95 7.45 23.23 6.86 C23.54 6.27 24.07 5.55 24.4 5.24 C24.76 4.94 25.26 4.13 25.57 3.43 C25.88 2.73 26.46 1.78 26.91 1.34 C27.33 0.86 27.77 0.2 27.89 -0.2 C28 -0.59 28.5 -1.59 29 -2.43 C29.53 -3.26 30.01 -4.52 30.12 -5.21 C30.23 -5.91 30.7 -7.14 31.18 -7.98 C31.96 -9.37 32.04 -9.82 32.32 -13.52 C32.49 -16.26 32.49 -19.07 32.29 -22.36 C32.01 -27.08 31.99 -27.24 31.15 -28.56 C30.67 -29.28 30.2 -30.4 30.09 -31.01 C29.98 -31.68 29.59 -32.4 29.14 -32.82 C28.72 -33.21 28.17 -33.97 27.89 -34.5 C27.61 -35.03 26.97 -35.97 26.46 -36.56 C25.93 -37.17 25.52 -37.79 25.52 -37.93 C25.52 -38.18 22.76 -40.88 20.83 -42.47 C20.27 -42.97 19.33 -43.56 18.74 -43.81 C18.15 -44.03 17.32 -44.62 16.9 -45.06 C16.42 -45.57 15.76 -45.93 14.97 -46.07 C14.33 -46.15 13.36 -46.63 12.8 -47.07 C11.66 -47.96 11.6 -47.99 8.42 -48.41 C7.22 -48.58 5.8 -48.91 5.21 -49.16 C3.93 -49.72 -2.43 -50 -3.49 -49.53 Z M4.63 -36.48 C5.49 -36.34 6.66 -35.89 7.25 -35.5 C7.84 -35.11 8.53 -34.77 8.78 -34.77 C9.98 -34.77 15.48 -29.53 16.37 -27.52 C16.68 -26.83 17.26 -25.93 17.65 -25.52 C18.54 -24.54 18.77 -23.03 18.8 -17.76 C18.8 -12.97 18.57 -11.57 17.62 -10.57 C17.23 -10.15 16.73 -9.29 16.51 -8.64 C16.17 -7.64 13.16 -3.82 12.72 -3.82 C12.6 -3.82 11.94 -3.32 11.21 -2.7 C10.46 -2.09 9.4 -1.48 8.87 -1.34 C8.31 -1.17 7.42 -0.75 6.86 -0.36 C5.41 0.64 1.98 1.03 -1.9 0.7 C-4.21 0.47 -5.05 0.28 -5.61 -0.17 C-6.02 -0.5 -7.03 -0.95 -7.86 -1.2 C-8.7 -1.45 -9.79 -2.04 -10.35 -2.51 C-12.63 -4.63 -14.64 -6.75 -14.64 -7.08 C-14.64 -7.28 -15.06 -7.86 -15.59 -8.37 C-16.26 -9.04 -16.59 -9.68 -16.73 -10.54 C-16.84 -11.21 -17.37 -12.69 -17.9 -13.8 C-18.85 -15.76 -18.91 -15.92 -18.74 -18.13 C-18.63 -19.91 -18.4 -20.8 -17.74 -22.23 C-17.26 -23.23 -16.87 -24.43 -16.84 -24.87 C-16.79 -26.72 -16.48 -27.16 -12.77 -30.93 C-10.46 -33.3 -9.37 -34.1 -7.75 -34.8 C-7.03 -35.11 -6.05 -35.55 -5.63 -35.81 C-5.19 -36.03 -4.49 -36.34 -4.1 -36.45 C-3.04 -36.75 2.73 -36.78 4.63 -36.48 Z' },
  };
  var NUM_PATHS = {};
  for (var _k in NUM_GLYPHS) NUM_PATHS[_k] = new Path2D(NUM_GLYPHS[_k].d);
  // hand lengths (px from centre) + tail overhang + half-widths. Proportional to
  // the decompiled dial; refined against sub_1D248 marker radii.
  // Measured from the GE capture hand textures (32x256): near-UNIFORM width (not
  // tapered). Widths hour 8 / second 4 / minute 2 (texture px); lengths in the
  // ratio 108:175:229 (hour:minute:second) -> hour shortest, second longest.
  // Width ORDER (from the capture, Shot-560): hour thickest bar, minute a medium
  // bar, second a FINE line - hour > minute > second. (Was mis-ordered: second was
  // set thicker than minute.) Half-widths at hub/tip.
  // Widths from perpendicular measurement of the capture (Shot-560, glow-inclusive):
  // hour ~8px hub tapering to ~6px, minute ~5px, second a ~1.6px fine line. Half-
  // widths below; the modest cyan glow (shadowBlur) makes up the rest of the width.
  var HANDS = {
    hour:   { len: 86,  back: 11, wHub: 3.0, wTip: 2.0 },   // thickest, tapers to a point
    minute: { len: 112, back: 13, wHub: 1.3, wTip: 1.0 },   // medium bar
    second: { len: 139, back: 20, wHub: 0.7, wTip: 0.55 },  // fine line, reaches the disc edge (R_DISC-2)
  };
  var DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

  // --- colours (palette tables) ---
  var C_GLYPH = '#ffffff';
  var C_GLOW = 'rgba(150,232,255,0.9)';
  var C_TRAIL = [200, 236, 250];
  var C_DISC = 'rgba(124,217,232,0.16)';
  var C_HUB = '#eaf7ff';

  // --- second-hand trail state (120 dots) ---
  var trail = new Float32Array(120);
  var DECAY = 0.98;

  // --- date label pre-render buffer ---------------------------------------
  // The date ("THU 16") is UI text. Drawing it with fillText each frame under the
  // clock's slowly-changing fractional float translate makes it SNAP to the pixel
  // grid (canvas text is not repositioned sub-pixel-smoothly at small sizes), so it
  // visibly lags/steps while the vector numerals (Path2D fills) glide - it looked
  // like the date was not moving in tandem with the floating disc. Fix: render the
  // text ONCE to an offscreen buffer (only when the string or size bucket changes)
  // and blit it with drawImage, which DOES interpolate at fractional destination
  // coordinates, so the label floats smoothly locked to the face. Kept frosted by
  // baking fill+stroke into the buffer and compositing it with 'lighter'.
  var _dateBuf = null, _dateBufCtx = null, _dateKey = '', _dateSizePx = 0;
  var DATE_FONT = 'PS3, "Arial Narrow", sans-serif';
  function fontsReady(sizePx) {
    try {
      if (typeof document !== 'undefined' && document.fonts && document.fonts.check)
        return document.fonts.check(sizePx + 'px PS3') ? 1 : 0;
    } catch (e) {}
    return 1;
  }
  // Render the date to _dateBuf at ~on-screen device resolution (crisp), returning
  // true on success. The buffer keeps the text CENTRED in it so the blit can centre
  // on (CX, dateY) exactly. Rebuilt only when the cache key (text|size|fontReady)
  // changes, so it is essentially free per frame.
  function renderDateBuf(dtxt, sizePx) {
    if (!_dateBuf) {
      if (typeof document === 'undefined') return false;
      _dateBuf = document.createElement('canvas');
      _dateBufCtx = _dateBuf.getContext('2d');
    }
    if (!_dateBufCtx) return false;
    var key = dtxt + '|' + sizePx + '|' + fontsReady(sizePx);
    if (key === _dateKey && _dateBuf.width) return true;
    var c = _dateBufCtx;
    var pad = Math.ceil(sizePx * 0.5);                 // room for the stroke + antialias
    c.font = sizePx + 'px ' + DATE_FONT;
    var w = Math.ceil(c.measureText(dtxt).width);
    var bw = w + pad * 2, bh = Math.ceil(sizePx * 1.7) + pad * 2;
    _dateBuf.width = bw; _dateBuf.height = bh;          // (resize also clears + resets ctx state)
    c.clearRect(0, 0, bw, bh);
    c.font = sizePx + 'px ' + DATE_FONT;
    c.textAlign = 'center'; c.textBaseline = 'middle';
    var cxp = bw / 2, cyp = bh / 2;
    c.fillStyle = 'rgba(224,237,248,0.32)';            // frosted-glass fill (bg colour reads through)
    c.fillText(dtxt, cxp, cyp);
    c.lineWidth = Math.max(0.7, sizePx * 0.064);       // 0.7px at the 11px logical size
    c.strokeStyle = 'rgba(255,255,255,0.28)';          // faint edge stroke (no glow)
    c.strokeText(dtxt, cxp, cyp);
    _dateKey = key; _dateSizePx = sizePx;
    return true;
  }

  function load() { /* procedural - no external assets */ }

  // The decompiled decay is 0.98 per PLUGIN frame; the plugin updates at the XMB
  // clock's render cadence (~50 ms / ~20 fps per the capture's fan), NOT the web
  // app's 60 fps. So decay per PSP-frame-equivalent of elapsed time to get the
  // same ~9 s / ~18-tick fan regardless of the web frame rate.
  var PSP_FRAME_MS = 50;

  // fill the trail as if it had been running, so the fan is visible in a static
  // validation shot (live, it builds over the same time).
  function warm(date) {
    trail.fill(0);
    var s = date.getSeconds();
    for (var back = 0; back < 12; back++) {
      var sec = (s - back + 60) % 60;
      var v = Math.pow(DECAY, back * 1000 / PSP_FRAME_MS);   // back seconds of decay
      if (v > 0.02) { trail[sec * 2] = v; trail[sec * 2 + 1] = v; }
    }
  }

  function polar(frac, R) {
    var th = HALF_PI - frac * TWO_PI;
    return [CX + R * Math.cos(th), CY - R * Math.sin(th)];
  }

  function secondFrac(date) {
    var s = date.getSeconds(), us = date.getMilliseconds() * 1000;
    var t = Math.min(1, Math.max(0, us / 1e6));
    var e = Math.sqrt(1 - (t - 1) * (t - 1));
    var E = e + 1.2 * e * (1 - e);
    var fr = E * (2 - E);
    return (s + fr) / 60;
  }

  function updateTrail(date, dt) {
    var s = date.getSeconds(), us = date.getMilliseconds() * 1000;
    var i0 = s * 2, i1 = s * 2 + 1;
    var f = Math.pow(DECAY, (dt || 16) / PSP_FRAME_MS);   // frame-rate-independent
    for (var i = 0; i < 120; i++) {
      if (i === i0) trail[i] = 1;
      else if (i === i1) { if (us > 50000) trail[i] = 1; else trail[i] *= f; }
      else trail[i] *= f;
    }
  }

  // a tapered hand: filled quad tip->hub, narrow at tip, wide at hub, with tail.
  // wobRad = welcome-wobble angular offset (radians), 0 at rest.
  function drawHand(ctx, frac, h, wobRad) {
    var th = HALF_PI - frac * TWO_PI + (wobRad || 0);
    var dx = Math.cos(th), dy = -Math.sin(th);        // screen dir (y down)
    var px = -dy, py = dx;                              // perpendicular
    var tipX = CX + dx * h.len, tipY = CY + dy * h.len;
    var backX = CX - dx * h.back, backY = CY - dy * h.back;
    ctx.beginPath();
    ctx.moveTo(tipX + px * h.wTip, tipY + py * h.wTip);
    ctx.lineTo(tipX - px * h.wTip, tipY - py * h.wTip);
    ctx.lineTo(backX - px * h.wHub, backY - py * h.wHub);
    ctx.lineTo(backX + px * h.wHub, backY + py * h.wHub);
    ctx.closePath();
    ctx.fill();
  }

  function draw(ctx, cw, ch, date, reveal, dt, floatY, detailFade, descentFrac) {
    reveal = reveal == null ? 1 : reveal;
    detailFade = detailFade == null ? 1 : detailFade;   // ticks fade in only once settled
    updateTrail(date, dt);
    // Scale so the clock CIRCLE fills the display like the PSP: on wide screens it
    // is height-driven (disc a touch taller than the screen -> top/bottom run off,
    // as on the real 480x272 PSP); on square/narrow screens it is width-capped so
    // the disc fills to just before the left/right would crop. (2*R_DISC+6 leaves a
    // ~3px rim margin.) The clock stays centred at (cw/2, ch/2) either way.
    var sc = Math.min(ch / PSP_H, cw / (2 * R_DISC + 6));
    var ox = (cw - PSP_W * sc) / 2, oy = (ch - PSP_H * sc) / 2;
    ctx.save();
    ctx.setTransform(sc, 0, 0, sc, ox, oy);
    ctx.globalAlpha = Math.max(0, Math.min(1, reveal * 1.6));
    // Clock vertical position, computed by the caller (index.html) so the disc and
    // its glass lens ride together: OPEN = buoyant easeOutBack (overshoot), CLOSE =
    // linear lift (plugin easing type 4 vs 0 on property 0x13). descentFrac is the
    // offset as a fraction of (PSP_H+50): <=0 above the top, 0 at rest, >0 below.
    if (descentFrac == null) {   // fallback: buoyant open (validation renders pass reveal only)
      var u = reveal - 1, c = 1.4;
      descentFrac = (c + 1) * u * u * u + c * u * u;
    }
    if (descentFrac !== 0) ctx.translate(0, descentFrac * (PSP_H + 50));
    // Idle float: the whole clock bobs gently up/down (measured on the real PSP).
    ctx.translate(0, floatY || 0);
    var wobR = 0;

    // 1) glass disc: a very subtle light-blue body that FADES OUT at the edge -
    // NO rim/border (the real XMB clock has no outline). Just a soft glass tint +
    // a faint top-left lens highlight; the wave shows through.
    ctx.save();
    // Substantial, near-UNIFORM translucent glass body so the disc reads as a
    // clearly defined circle ALL the way around (the real XMB clock's glass has
    // real presence, not a faint tint). A gentle glass rim catches light at the
    // very edge, then a 3px fade -> crisp circle, no hard border stroke.
    // NEUTRAL frosted-glass body (near-white, low alpha) so the disc reads as a
    // clearly defined circle but does NOT tint the scene - whatever XMB wallpaper
    // colour is behind shows THROUGH like real glass (no baked-in blue).
    var body = ctx.createRadialGradient(CX, CY, R_DISC * 0.15, CX, CY, R_DISC);
    body.addColorStop(0, 'rgba(238,244,250,0.06)');
    body.addColorStop(0.80, 'rgba(240,246,251,0.06)');
    body.addColorStop((R_DISC - 4) / R_DISC, 'rgba(255,255,255,0.20)');   // glass rim highlight (white)
    body.addColorStop((R_DISC - 3) / R_DISC, 'rgba(250,252,255,0.16)');
    body.addColorStop(1, 'rgba(240,246,251,0)');                          // fade over the last 3px only
    ctx.beginPath(); ctx.arc(CX, CY, R_DISC, 0, TWO_PI); ctx.fillStyle = body; ctx.fill();
    // faint light-catch through the top-left of the glass (specular, white)
    var g = ctx.createRadialGradient(CX - 46, CY - 60, 8, CX, CY, R_DISC);
    g.addColorStop(0, 'rgba(255,255,255,0.10)');
    g.addColorStop(0.55, 'rgba(235,242,248,0.03)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.beginPath(); ctx.arc(CX, CY, R_DISC, 0, TWO_PI); ctx.fillStyle = g; ctx.fill();
    ctx.restore();

    // 2) second-hand trail: 120 radial dashes at the OUTER EDGE of the face
    // (measured R130-141 in the capture - the dashes reach the rim, right under
    // where the second hand tip sweeps). Current second full, the rest decay so a
    // fading fan trails behind the second hand. Gated by detailFade like the ticks:
    // do NOT show these trailing dashes while the clock is still flying in (they
    // were sweeping across the top of the screen during the drop-in).
    if (detailFade > 0.002) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineCap = 'round';
      for (var i = 0; i < 120; i++) {
        var a = trail[i];
        if (a < 0.02) continue;
        var fr = i / 120;
        var pa = polar(fr, R_DISC - 1), pb = polar(fr, R_DISC - 11);   // SHORT radial trail dash (outer tip R140 at the rim, ~10px long) to match the PSP's short second-hand trail ticks
        ctx.globalAlpha = a * 0.9 * detailFade;
        ctx.lineWidth = 1.5 + a * 0.9;
        ctx.strokeStyle = 'rgb(' + C_TRAIL[0] + ',' + C_TRAIL[1] + ',' + C_TRAIL[2] + ')';
        ctx.beginPath(); ctx.moveTo(pa[0], pa[1]); ctx.lineTo(pb[0], pb[1]); ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.restore();
    }

    // 3) hour ticks (8 non-cardinal hours): chunky rounded white bars (the PSP
    // tick sprite is 32x44 -> a stubby rounded rectangle) with a cyan glow.
    // Gated by detailFade: fade in only once the clock has settled, out fast on close.
    if (detailFade > 0.002) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = detailFade;
      ctx.strokeStyle = C_GLYPH; ctx.lineCap = 'round';
      ctx.shadowColor = C_GLOW; ctx.shadowBlur = 6;
      ctx.lineWidth = 6;
      for (var k = 0; k < HOUR_TICKS.length; k++) {
        var fr = HOUR_TICKS[k] / 12;
        // Bigger hour ticks to match the PSP (its tick sprite is a tall 32x44 bar).
        // Outer tip R137 so the round cap + glow stay just inside the rim (R_DISC 141);
        // inner extended to R107 -> a long ~30px chunky bar.
        var pa = polar(fr, R_HTICK + 6), pb = polar(fr, R_HTICK - 24);
        ctx.beginPath(); ctx.moveTo(pa[0], pa[1]); ctx.lineTo(pb[0], pb[1]); ctx.stroke();
      }
      ctx.restore();
    }

    // 4) numerals 12/3/6/9 - filled from the Path2D glyphs traced directly from the
    // plugin's own texture-atlas sprites (NUM_PATHS). This is the EXACT clock display
    // face (a light typeface with a small-bowl, straight-legged 9) - NOT New Rodin
    // (ltn0) nor the PS3 Rodin, both of which have a different 6/9. Each path is
    // height-100, centred at the origin; scale by NUM_H/100 and place at polar(frac,R).
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = C_GLYPH;
    ctx.shadowColor = C_GLOW; ctx.shadowBlur = 8;
    var NUM_H = 41;   // on-screen numeral height (px); tuned to the real dial proportion
    for (var n = 0; n < NUMERALS.length; n++) {
      var nm = NUMERALS[n], pp = polar(nm.frac, nm.R), gp = NUM_PATHS[nm.s];
      if (!gp) continue;
      var s = NUM_H / 100;
      ctx.save();
      ctx.translate(pp[0], pp[1]);   // path is centred at its bbox, so this centres the glyph
      ctx.scale(s, s);
      ctx.fill(gp);
      ctx.restore();
    }
    ctx.restore();

    // 5) date "THU 16" below centre - FROSTED FLAT GLASS text (per user): the letters are
    // the same frosted glass as the face, a soft neutral lift that frosts the magnified
    // background in the letter shapes so the background/wallpaper COLOUR pulls THROUGH
    // them - NOT a solid bright glyph. The old cyan glow is replaced by a faint
    // semi-transparent stroke that just defines the letter edges.
    ctx.save();
    // date is regular UI text -> the PSP system font (New Rodin), NOT the clock's
    // display numerals. Uses the app's 'PS3' Rodin (matches the extracted weekday
    // sprites SUN/THU/WED). Blitted from a pre-rendered buffer (see renderDateBuf)
    // so it floats SMOOTHLY sub-pixel in tandem with the disc instead of snapping to
    // the pixel grid as fillText does under the slow float translate.
    var dtxt = DAYS[date.getDay()] + ' ' + date.getDate();
    var dateY = CY + 33;                                      // slightly further down, per the PSP layout
    var _dpr = (typeof window !== 'undefined' && window.devicePixelRatio) ? window.devicePixelRatio : 1;
    // buffer resolution ~ on-screen device size (11px logical * clock scale * dpr),
    // bucketed to 2px so a stable size does not thrash the cache.
    var sizePx = Math.max(11, Math.round(11 * sc * _dpr / 2) * 2);
    if (renderDateBuf(dtxt, sizePx)) {
      var dw = _dateBuf.width * 11 / sizePx;                  // buffer px -> logical (11px) units
      var dh = _dateBuf.height * 11 / sizePx;
      ctx.globalCompositeOperation = 'lighter';              // frosted-glass lift; bg colour reads through
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(_dateBuf, CX - dw / 2, dateY - dh / 2, dw, dh);
    } else {                                                  // no DOM canvas: draw text directly
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = '11px ' + DATE_FONT;
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = 'rgba(224,237,248,0.32)';
      ctx.fillText(dtxt, CX, dateY);
      ctx.globalCompositeOperation = 'source-over';
      ctx.lineWidth = 0.7;
      ctx.strokeStyle = 'rgba(255,255,255,0.28)';
      ctx.strokeText(dtxt, CX, dateY);
    }
    ctx.restore();

    // 6) hands (hour, minute, second) rotated to the decompiled angles
    var h = date.getHours() % 12, m = date.getMinutes(), s = date.getSeconds();
    var hourFrac = h / 12 + m / 720;
    var minuteFrac = m / 60 + s / 3600;
    var secFrac = secondFrac(date);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.shadowColor = C_GLOW; ctx.shadowBlur = 4;   // modest glow (was 6, inflated the width)
    ctx.fillStyle = C_GLYPH;
    drawHand(ctx, hourFrac, HANDS.hour, wobR * 0.7);
    drawHand(ctx, minuteFrac, HANDS.minute, wobR * 0.8);
    ctx.shadowBlur = 2.5;
    drawHand(ctx, secFrac, HANDS.second, wobR * 1.0);
    ctx.restore();

    // 7) centre hub
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.shadowColor = C_GLOW; ctx.shadowBlur = 6;
    ctx.beginPath(); ctx.arc(CX, CY, 5.5, 0, TWO_PI); ctx.fillStyle = C_HUB; ctx.fill();
    ctx.beginPath(); ctx.arc(CX, CY, 2.5, 0, TWO_PI); ctx.fillStyle = '#ffffff'; ctx.fill();
    ctx.restore();

    ctx.restore();
  }

  global.PSPClock = { load: load, draw: draw, warm: warm, isReady: function () { return true; } };
})(window);
