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

  // The real PSP clock face is NOT a perfect circle: it is a horizontal ellipse.
  // Measured numeral centroids (jpcsp, native 480x272) are exactly consistent with
  // a CIRCLE squashed vertically about the centre by 0.945 (horizontal numerals at
  // R118.2, vertical at R118.2*0.945=111.7). So everything below is authored on a
  // circle and a single global y-squash (ASPECT) turns the whole face - disc, ticks,
  // numerals, dashes, hands, glyphs - into the correct ellipse in one place.
  var ASPECT = 0.945;

  // --- geometry: element-centre radii on the un-squashed CIRCLE (px) ---
  var R_RING = 126, R_HTICK = 121, R_DISC = 141;   // hour-tick centre R121, glass disc R141 (horizontal)
  var R_NUM = 118.2;                                // all four numerals sit on one ring (measured)
  var HOUR_TICKS = [1, 2, 4, 5, 7, 8, 10, 11];
  var NUMERALS = [
    { s: '12', frac: 0 / 12, R: R_NUM },
    { s: '3',  frac: 3 / 12, R: R_NUM },
    { s: '6',  frac: 6 / 12, R: R_NUM },
    { s: '9',  frac: 9 / 12, R: R_NUM },
  ];
  // hand lengths (px from centre) + tail overhang + half-widths. Proportional to
  // the decompiled dial; refined against sub_1D248 marker radii.
  // Measured from the GE capture hand textures (32x256): near-UNIFORM width (not
  // tapered). Widths hour 8 / second 4 / minute 2 (texture px); lengths in the
  // ratio 108:175:229 (hour:minute:second) -> hour shortest, second longest.
  var HANDS = {
    hour:   { len: 86,  back: 11, wHub: 3.0, wTip: 2.7 },   // thickest, shortest
    minute: { len: 112, back: 13, wHub: 1.15, wTip: 1.0 },  // thinnest
    second: { len: 139, back: 20, wHub: 1.7, wTip: 1.2 },   // thin, reaches the disc edge (R_DISC-2)
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

  function draw(ctx, cw, ch, date, reveal, dt, floatY) {
    reveal = reveal == null ? 1 : reveal;
    updateTrail(date, dt);
    var sc = Math.min(cw / PSP_W, ch / PSP_H);
    var ox = (cw - PSP_W * sc) / 2, oy = (ch - PSP_H * sc) / 2;
    ctx.save();
    ctx.setTransform(sc, 0, 0, sc, ox, oy);
    ctx.globalAlpha = Math.max(0, Math.min(1, reveal * 1.6));
    // Real drop-in (jpcsp capture, frame ~408): the clock is at its NORMAL size
    // but positioned high (centre near the top, 12 off-screen above) and DESCENDS
    // straight down into place. No zoom, no hand wobble (couldn't verify either
    // from the frozen-time capture; not inventing them).
    if (reveal < 1) {
      var eased = 1 - Math.pow(1 - reveal, 3);            // easeOutCubic
      ctx.translate(0, -(1 - eased) * (PSP_H + 50));      // descend from above
    }
    // Idle float: the whole clock bobs gently up/down (measured ~6px peak-to-peak).
    ctx.translate(0, floatY || 0);
    // Horizontal-ellipse: squash the entire face vertically about the centre so a
    // circle becomes the real clock's slightly-wide ellipse (see ASPECT above).
    ctx.translate(CX, CY); ctx.scale(1, ASPECT); ctx.translate(-CX, -CY);
    var wobR = 0;

    // 1) glass disc: a very subtle light-blue body that FADES OUT at the edge -
    // NO rim/border (the real XMB clock has no outline). Just a soft glass tint +
    // a faint top-left lens highlight; the wave shows through.
    ctx.save();
    // Substantial, near-UNIFORM translucent glass body so the disc reads as a
    // clearly defined circle ALL the way around (the real XMB clock's glass has
    // real presence, not a faint tint). A gentle glass rim catches light at the
    // very edge, then a 3px fade -> crisp circle, no hard border stroke.
    var body = ctx.createRadialGradient(CX, CY, R_DISC * 0.15, CX, CY, R_DISC);
    body.addColorStop(0, 'rgba(120,206,226,0.20)');
    body.addColorStop(0.80, 'rgba(126,212,232,0.20)');
    body.addColorStop((R_DISC - 4) / R_DISC, 'rgba(158,226,244,0.26)');   // glass rim highlight
    body.addColorStop((R_DISC - 3) / R_DISC, 'rgba(150,222,242,0.22)');
    body.addColorStop(1, 'rgba(120,206,226,0)');                          // fade over the last 3px only
    ctx.beginPath(); ctx.arc(CX, CY, R_DISC, 0, TWO_PI); ctx.fillStyle = body; ctx.fill();
    // faint light-catch through the top-left of the glass (specular)
    var g = ctx.createRadialGradient(CX - 46, CY - 60, 8, CX, CY, R_DISC);
    g.addColorStop(0, 'rgba(226,248,255,0.10)');
    g.addColorStop(0.55, 'rgba(150,215,240,0.03)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.beginPath(); ctx.arc(CX, CY, R_DISC, 0, TWO_PI); ctx.fillStyle = g; ctx.fill();
    ctx.restore();

    // 2) second-hand trail: 120 radial dashes at the OUTER EDGE of the face
    // (measured R130-141 in the capture - the dashes reach the rim, right under
    // where the second hand tip sweeps). Current second full, the rest decay so a
    // fading fan trails behind the second hand.
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    for (var i = 0; i < 120; i++) {
      var a = trail[i];
      if (a < 0.02) continue;
      var fr = i / 120;
      var pa = polar(fr, R_DISC - 1), pb = polar(fr, R_DISC - 17);   // radial dash reaching the disc EDGE from the inside (outer tip at R140, just inside R_DISC=141 - stays within the circle); centred on the R126 dot-ring, dash size ~16
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
    ctx.lineWidth = 5;
    for (var k = 0; k < HOUR_TICKS.length; k++) {
      var fr = HOUR_TICKS[k] / 12;
      var pa = polar(fr, R_HTICK + 9), pb = polar(fr, R_HTICK - 9);   // centre at R121, len 18
      ctx.beginPath(); ctx.moveTo(pa[0], pa[1]); ctx.lineTo(pb[0], pb[1]); ctx.stroke();
    }
    ctx.restore();

    // 4) numerals 12/3/6/9 - the app's PS3 (Rodin) font, matching the XMB glyphs
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = C_GLYPH; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = 'bold 46px PS3, "Arial Narrow", sans-serif';   // ~45px glyph height (capture)
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
    drawHand(ctx, hourFrac, HANDS.hour, wobR * 0.7);
    drawHand(ctx, minuteFrac, HANDS.minute, wobR * 0.8);
    ctx.shadowBlur = 4;
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
