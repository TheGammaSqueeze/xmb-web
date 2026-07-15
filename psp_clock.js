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

  // --- geometry (from disassembly) ---
  var R_RING = 126, R_HTICK = 131, R_DISC = 141;
  var HOUR_TICKS = [1, 2, 4, 5, 7, 8, 10, 11];
  var NUMERALS = [
    { s: '12', frac: 0 / 12, R: 116 },
    { s: '3',  frac: 3 / 12, R: 120 },
    { s: '6',  frac: 6 / 12, R: 113 },
    { s: '9',  frac: 9 / 12, R: 118 },
  ];
  // hand lengths (px from centre) + tail overhang + half-widths. Proportional to
  // the decompiled dial; refined against sub_1D248 marker radii.
  // Measured from the GE capture hand textures (32x256): near-UNIFORM width (not
  // tapered). Widths hour 8 / second 4 / minute 2 (texture px); lengths in the
  // ratio 108:175:229 (hour:minute:second) -> hour shortest, second longest.
  var HANDS = {
    hour:   { len: 72,  back: 11, wHub: 3.0, wTip: 2.7 },   // thickest, shortest
    minute: { len: 106, back: 13, wHub: 1.15, wTip: 1.0 },  // thinnest
    second: { len: 124, back: 20, wHub: 1.7, wTip: 1.5 },   // medium, longest
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

  function load() { /* procedural - no external assets */ }

  // fill the trail as if it had been running, so the comet is visible in a
  // static validation shot (the real trail builds up live over ~2-3 seconds).
  function warm(date) {
    trail.fill(0);
    var s = date.getSeconds();
    for (var back = 0; back < 12; back++) {
      var sec = (s - back + 60) % 60;
      var v = Math.pow(DECAY, back * 60);   // ~60 frames per elapsed second
      if (v > 0.008) { trail[sec * 2] = v; trail[sec * 2 + 1] = v; }
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

  function updateTrail(date) {
    var s = date.getSeconds(), us = date.getMilliseconds() * 1000;
    var i0 = s * 2, i1 = s * 2 + 1;
    for (var i = 0; i < 120; i++) {
      if (i === i0) trail[i] = 1;
      else if (i === i1) { if (us > 50000) trail[i] = 1; else trail[i] *= DECAY; }
      else trail[i] *= DECAY;
    }
  }

  // a tapered hand: filled quad tip->hub, narrow at tip, wide at hub, with tail.
  function drawHand(ctx, frac, h) {
    var th = HALF_PI - frac * TWO_PI;
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

  function draw(ctx, cw, ch, date, reveal) {
    reveal = reveal == null ? 1 : reveal;
    updateTrail(date);
    var sc = Math.min(cw / PSP_W, ch / PSP_H);
    var ox = (cw - PSP_W * sc) / 2, oy = (ch - PSP_H * sc) / 2;
    ctx.save();
    ctx.setTransform(sc, 0, 0, sc, ox, oy);
    ctx.globalAlpha = Math.max(0, Math.min(1, reveal * 1.4));
    // drop-in from top with overshoot + a zoom-in about the clock centre (the
    // "zoom" the real clock does as it settles in). Both keyed to the reveal.
    if (reveal < 1) {
      var c1 = 1.70158, c3 = c1 + 1;
      var eased = 1 + c3 * Math.pow(reveal - 1, 3) + c1 * Math.pow(reveal - 1, 2);
      ctx.translate(0, (eased - 1) * (PSP_H + 40));
      var smooth = reveal * reveal * (3 - 2 * reveal);   // 0..1
      var zoom = 0.84 + 0.16 * smooth;                    // zoom in to full size
      ctx.translate(CX, CY); ctx.scale(zoom, zoom); ctx.translate(-CX, -CY);
    }

    // 1) glass disc: transparent light-blue body + a refractive rim and a lens
    // highlight so it reads as glass (the real disc is subtle; the wave shows
    // through via the DOM backdrop-blur lens under this canvas).
    ctx.save();
    ctx.beginPath(); ctx.arc(CX, CY, R_DISC, 0, TWO_PI);
    ctx.fillStyle = C_DISC; ctx.fill();
    // refractive rim: bright outer edge + a thin inner ring
    ctx.lineWidth = 2.2; ctx.strokeStyle = 'rgba(170,238,255,0.26)'; ctx.stroke();
    ctx.beginPath(); ctx.arc(CX, CY, R_DISC - 3, 0, TWO_PI);
    ctx.lineWidth = 1.0; ctx.strokeStyle = 'rgba(205,246,255,0.12)'; ctx.stroke();
    // lens highlight (light refracting through the top-left of the glass)
    var g = ctx.createRadialGradient(CX - 46, CY - 60, 8, CX, CY, R_DISC);
    g.addColorStop(0, 'rgba(226,248,255,0.13)');
    g.addColorStop(0.55, 'rgba(150,215,240,0.035)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.beginPath(); ctx.arc(CX, CY, R_DISC, 0, TWO_PI); ctx.fillStyle = g; ctx.fill();
    ctx.restore();

    // 2) second-hand trail ring: 120 small radial tick-marks near the rim; the
    // current second is full and the rest decay (x0.98/frame), so a fading fan
    // of ticks trails behind the second hand (the comet the real clock shows).
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    for (var i = 0; i < 120; i++) {
      var a = trail[i];
      if (a < 0.02) continue;
      var fr = i / 120;
      var pa = polar(fr, R_RING + 3.5), pb = polar(fr, R_RING - 3.5);
      ctx.globalAlpha = a * 0.9;
      ctx.lineWidth = 1.5 + a * 0.9;
      ctx.strokeStyle = 'rgb(' + C_TRAIL[0] + ',' + C_TRAIL[1] + ',' + C_TRAIL[2] + ')';
      ctx.beginPath(); ctx.moveTo(pa[0], pa[1]); ctx.lineTo(pb[0], pb[1]); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.restore();

    // 3) hour ticks (8 non-cardinal hours): chunky rounded white bars (the PSP
    // tick sprite is 32x44 -> a stubby rounded rectangle) with a cyan glow.
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = C_GLYPH; ctx.lineCap = 'round';
    ctx.shadowColor = C_GLOW; ctx.shadowBlur = 7;
    ctx.lineWidth = 5.5;
    for (var k = 0; k < HOUR_TICKS.length; k++) {
      var fr = HOUR_TICKS[k] / 12;
      var pa = polar(fr, R_HTICK + 5), pb = polar(fr, R_HTICK - 11);
      ctx.beginPath(); ctx.moveTo(pa[0], pa[1]); ctx.lineTo(pb[0], pb[1]); ctx.stroke();
    }
    ctx.restore();

    // 4) numerals 12/3/6/9 (procedural glyphs)
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = C_GLYPH; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = '700 40px "Arial Narrow", "Helvetica Neue", Arial, sans-serif';
    ctx.shadowColor = C_GLOW; ctx.shadowBlur = 8;
    for (var n = 0; n < NUMERALS.length; n++) {
      var nm = NUMERALS[n], pp = polar(nm.frac, nm.R);
      ctx.fillText(nm.s, pp[0], pp[1] + 1);
    }
    ctx.restore();

    // 5) date "WED 15" below centre
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = '#dff2ff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = '700 13px Arial, sans-serif';
    ctx.shadowColor = C_GLOW; ctx.shadowBlur = 4;
    var dow = DAYS[date.getDay()], dd = date.getDate();
    ctx.fillText(dow + ' ' + dd, CX, CY + 28);
    ctx.restore();

    // 6) hands (hour, minute, second) rotated to the decompiled angles
    var h = date.getHours() % 12, m = date.getMinutes(), s = date.getSeconds();
    var hourFrac = h / 12 + m / 720;
    var minuteFrac = m / 60 + s / 3600;
    var secFrac = secondFrac(date);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.shadowColor = C_GLOW; ctx.shadowBlur = 6;
    ctx.fillStyle = C_GLYPH;
    drawHand(ctx, hourFrac, HANDS.hour);
    drawHand(ctx, minuteFrac, HANDS.minute);
    ctx.shadowBlur = 4;
    drawHand(ctx, secFrac, HANDS.second);
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
