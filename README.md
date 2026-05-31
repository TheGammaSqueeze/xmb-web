# xmb-web

A pixel-accurate, browser-based recreation of the **PlayStation 3 XMB**
(XrossMediaBar) — the wave, the per-month gradient, the cold-boot intro, the
3D-rendered icons, the menus, dialogs and side-panel choosers — running entirely
in a single HTML file with no build step and no dependencies.

**Live:** https://thegammasqueeze.github.io/xmb-web/

Everything visual is reconstructed from **decrypted PS3 firmware** and verified
against an **instrumented RPCS3** emulator capturing the real RSX shader state,
not approximated from videos. The wave geometry, fragment shaders, gradient
hues, animation timings and layout constants are ported or measured from the
firmware; comments throughout `index.html` cite the originating firmware vaddr
or capture wherever a value came from.

---

## Table of contents

- [Quick start](#quick-start)
- [Controls](#controls)
- [URL parameters](#url-parameters)
- [Screen scenarios](#screen-scenarios) ← aspect ratios, portrait, resolution
  simulation, integer scaling, HiDPI
- [How the rendering works](#how-the-rendering-works)
- [The responsive layout model](#the-responsive-layout-model)
- [Repository layout](#repository-layout)
- [Provenance & accuracy](#provenance--accuracy)
- [License & disclaimer](#license--disclaimer)

---

## Quick start

There is no build step. Serve the folder over HTTP (a `file://` URL will not
work because the app loads textures, fonts and audio via `fetch`/`Image`):

```bash
# from the repo root
python3 -m http.server 8080
# then open http://localhost:8080/
```

Any static host works (the live copy is GitHub Pages). The entire app is
`index.html` plus the asset folders next to it.

---

## Controls

The XMB is driven like a real PS3 — a cursor that moves across a horizontal
**category bar** with a vertical **item list** dropping out of the active
category.

### Keyboard

| Key | Action |
|-----|--------|
| **← / →** | Move between categories (or go back / into a submenu when one is open) |
| **↑ / ↓** | Move the item cursor up / down |
| **Enter** / **X** | Confirm — open the selected item / submenu / dialog |
| **Esc** / **Backspace** / **Z** | Back — close a dialog or pop out of a submenu |
| **Tab** | Cycle the **aspect ratio** (Shift+Tab goes backwards) |
| **O** | Toggle **portrait / landscape** orientation |
| **N** | Toggle **true-1×** vs **normal** rendering for a simulated resolution |

Holding a direction auto-repeats with the firmware's exact cadence (300 ms
initial delay, accelerating from 200 ms toward a 50 ms floor).

Pressing any key during the boot intro skips straight to the XMB.

### Gamepad

If a controller is connected it is polled automatically: D-pad / left stick for
navigation, the bottom face button for **X (enter)** and the right face button
for **O (back)** — matching the PS3's button layout.

---

## URL parameters

All of these can be combined, e.g.
`?res=480x800&portrait&aspect=16:9`.

| Parameter | Values | Meaning |
|-----------|--------|---------|
| `aspect` | `1:1`, `4:3`, `3:2`, `16:9`, `21:9` (or a number like `1.333`) | Target display aspect ratio. Default `16:9`. |
| `orientation` / `portrait` | `portrait` / `landscape` (`?portrait` is shorthand) | Rotate the layout (e.g. `16:9` → `9:16`). |
| `res` / `resolution` | `1280x720`, or a preset: `480p`, `576p`, `720p`, `1080p`, `1440p`, `4k`, … | Simulate a fixed screen resolution regardless of the real window. |
| `dpr` | a number | Override the device pixel ratio (super/sub-sample the backing). |
| `scale` / `native` | `1x` / `native` (`?native` is shorthand) | Start in **true-1×** mode (see below). |
| `noboot` | (flag) | Skip the cold-boot intro and land straight on the XMB. |

Two debug hooks are also available from the JS console:

- `window.PIN_TIME = new Date('2026-08-16T14:56:00').getTime()` — pin the clock
  to a fixed instant (the clock and the day/night + per-month gradient follow it).
- `window._monthOverride = 7` — force the gradient's month (0 = January … 11 =
  December) independently of the date.

---

## Screen scenarios

The XMB is natively a 16:9 design (an internal `1920 × 1080` virtual canvas).
Everything else is re-laid-out responsively rather than stretched. The behaviour
differs by scenario; here is exactly what each one does.

### 1. 16:9 — native

The reference case. The virtual `1920 × 1080` design fills the frame uniformly.
No compression, no offsets — what the real PS3 outputs over HDMI.

### 2. Narrower than 16:9 (4:3, 3:2, 1:1) — landscape

The PS3 does **not** squash the picture into a narrower frame; it performs a
**native re-layout**. We reproduce this with a two-factor model:

- Element **sizes** never change (icons stay square, text keeps its size).
- Element **positions** are compressed horizontally so the full-size layout fits
  the narrower frame, and right-anchored things (the clock, item values) re-anchor
  to the new right edge.
- 4:3 is tuned to match the real PS3 exactly; the others are derived from the
  same model.

`1:1` always uses this fill-the-square layout (its portrait and landscape frames
are identical, and filling the height makes the best use of a square).
For frames **narrower than 4:3** (1:1 and portrait) the whole layout also shifts
slightly left so long item names and subtitles get more room on the right.

Try: `?aspect=4:3`, `?aspect=1:1`.

### 3. Wider than 16:9 (21:9) — landscape

The frame is wider than the design, so the layout **expands** to fill it: the
category bar spreads out, the background/wave and any full-screen card cover the
extra width (cover-cropped, never stretched), and the clock sits at the true
right edge.

Try: `?aspect=21:9`.

### 4. Portrait (any ratio)

Press **O** or add `?portrait`. The ratio inverts (16:9 → 9:16) so the frame is
taller than wide. Here we:

- **Zoom in** (the UI is larger so it reads well on a tall, narrow screen).
- Scale to **fill the width** (uniform, never squashed); right-anchored content
  re-flows to the narrower right edge.
- Park the focus row ~44 % down the frame and let the **item list run far down
  it** — so portrait shows a long vertical list instead of a short centred band.
- Fill the rest of the tall frame with the wave and gradient.

Dialogs, side-panel choosers and full-screen cards are **centred in the visible
frame** (not stuck at the top of the tall frame), and the side-panel wash fills
the full height.

Try: `?portrait`, `?aspect=4:3&portrait`.

### 5. Low-resolution / small frames

On small frames (e.g. `640×480`, `480×800`, `720×720`) the whole UI is **zoomed
in for legibility**, vertically centred, and the **item subtitle font is
enlarged** so secondary text stays readable. The subtitle also wraps to the full
available width instead of scrunching into a narrow column.

Try: `?res=640x480&aspect=4:3`, `?res=720x720&aspect=1:1`.

### 6. Resolution simulation + integer scaling

`?res=WxH` (or a preset) renders the app as if the screen were exactly that
size, **independent of your actual window**. For display it is scaled by the
**largest whole-number factor** that fits the window (1×, 2×, 3× …), centred,
with **pillar/letterboxing** around it, using nearest-neighbour filtering — so
each rendered pixel becomes a clean N×N block instead of the browser's blurry
fractional resample. It is recomputed on every resize, so it stays responsive.

By default the backing is rendered at your **device pixel ratio**, so on a
HiDPI/Retina screen the simulated frame is crisp and high-detail (not a soft
half-resolution image). `?dpr=N` overrides this for explicit super/sub-sampling.

Try: `?res=720p`, `?res=1080p`, `?res=480x800&portrait`.

### 7. True-1× — the literal target screen

Press **N** (or start with `?scale=1x`). This shows a `?res` frame at its
**exact native pixel size with no magnification at all**: each native pixel maps
to exactly **one physical device pixel**, centred and letterboxed. It is the
pixel-for-pixel preview of what a real `480×800` panel would output.

This is implemented with the canonical pixel-perfect canvas mapping — the CSS
box is sized to `native ÷ devicePixelRatio` with a native-size backing and **no
transform** — so even on a Windows/Chrome display-scaled (HiDPI) setup there is
no intermediate 2× upscale or blur. Press **N** again to return to the normal
integer-scaled, device-resolution rendering.

Try: `?res=480x800&portrait&scale=1x`.

---

## How the rendering works

Each frame composites **three stacked canvases** inside a centred `#scr` box:

| Layer | id | Tech | Contents |
|-------|----|------|----------|
| 0 | `#bg` | WebGL (2D fallback) | Per-month "Original" gradient + HDR tonemap |
| 1 | `#wave` | WebGL | The XMB wave (firmware-exact captured geometry + silk shader, HDR glare/bloom chain) |
| 2 | `#xmb` | Canvas 2D | Category bar, item lists, clock, dialogs, side panels, landing cards |

A fourth offscreen `bootCanvas` (z-index 3) draws the cold-boot logo, footer and
the epilepsy-warning text on top during the intro.

The main loop is `frame()` near the bottom of `index.html`:

1. `drawBootIntro()` runs the firmware-derived cold-boot sequence (black hold →
   logo bloom → epilepsy warning → wave swell → hand-off) and gates the XMB UI
   in/out. After boot it does nothing.
2. `drawBG()` renders the gradient and the wave through the WebGL pipeline
   (scene FBO → HDR glare/bloom → tonemap), driven by the time of day, the
   calendar month, and a spring-physics impulse system that reacts to navigation.
3. `drawXMB()` paints the 2D UI: the category bar, the active item list (with the
   submenu breadcrumb collapse, descriptions and values), the clock, and any open
   dialog / side panel / landing card.

The wave is **not** an approximation: `wave_geo.bin` / `wave_seq*.bin` hold the
real clip-space cloth geometry captured from RPCS3, and the silk lighting is a
port of the firmware's `lines.qrc` fragment shaders. Icons are PS3 normal-map
textures re-lit at runtime through a ported "icon glass" WebGL shader.

---

## The responsive layout model

All UI is authored in a fixed virtual space (`V.W = 1920`, `V.H = 1080`) and
mapped to the real canvas by `resize()`. The mapping is described by a handful of
globals, so individual draw calls never worry about the device:

| Global | Meaning |
|--------|---------|
| `scale` | virtual → CSS pixel scale (uniform; never anamorphic) |
| `dpr` | canvas backing multiplier (device pixel ratio, or the `?dpr` override) |
| `LAYOUT_FIT` | frame width ÷ `V.W` — where the right edge sits. `XCF(x)` maps right-anchored / centred / frame-spanning x by it |
| `LAYOUT_XC` | horizontal **position** compression for left-anchored content. `XCP(x)` / `XCL(centre,halfW)` apply it (sizes are never compressed) |
| `LAYOUT_XSHIFT` | extra left shift on frames narrower than 4:3 (folded into `XCP`/`XCL`) |
| `LAYOUT_VFIT` / `LAYOUT_VOFF` | vertical analogues for the portrait branch; `frameTopV()` / `frameHV()` give the full visible frame bounds |
| `frameCenterTY()` | device-space translate that centres the 1080-tall design in the frame (used by dialogs / cards in portrait) |
| `DESC_BOOST` | subtitle font multiplier on small frames |

In plain 16:9 every factor is the identity (`LAYOUT_FIT = LAYOUT_XC = 1`,
offsets `0`), so the model is a no-op and the reference layout is exact. Each
scenario above is just a different set of these values computed in `resize()`.

The display scaling for `?res` (integer factor, letterboxing, pixelated vs
smooth, true-1× CSS sizing) is also all in `resize()`, which is the single source
of truth and is re-run on every `window.resize`.

---

## Repository layout

```
index.html            The entire application (markup, CSS, JS, shaders).
.nojekyll             Tell GitHub Pages to serve files as-is.

assets/               Environment / ambient-occlusion maps for icon lighting.
normalmaps/           PS3 XMB icon normal-map textures (re-lit at runtime).
icons/                Flat icon/thumbnail PNGs used directly by the UI.
backgrounds/          PSN / Store / content-info card backgrounds.
boot/                 Cold-boot logo, footer and bloom plates (HD + SD, v2).
dialogs/              Dialog illustration assets.
month_bg_00..23.png   Per-month "Original" gradient source textures.
ps3-rodin-*.ttf       The PS3 UI font (Rodin) in light / regular / bold.
wave_geo.bin          Captured clip-space cloth geometry for the wave.
wave_seq*.bin/.json   Captured wave keyframe sequences (idle + boot).
texture_*.png, noise.png, starfield.png, …  Wave / particle textures.
snd_*.mp3             Navigation sounds (disabled by default).
```

Inside `index.html` the code is organised into clearly headered sections — search
for the `====` banners: layout constants, theme/gradient system, menu data,
state, icon cache, the WebGL wave + shaders, the icon-glass context, XMB
rendering, dialogs / side panels / landing, navigation, input handling, and the
boot intro.

---

## Provenance & accuracy

- **Firmware is the source of truth.** Geometry, shaders, gradients, timings and
  layout constants are extracted from decrypted PS3 firmware (`vsh`,
  `explore_plugin.prx`, `xmb_plugin.prx`, `lines.qrc`) or measured from an
  instrumented RPCS3 build that logs RSX draw-call state. Videos are used only to
  validate, never as an implementation source.
- Comments cite their origin: a firmware virtual address (`vaddr 0x…`) for ported
  constants, or the specific RPCS3 capture for measured values.

This makes the reproduction faithful at the level of the actual shader math and
UI metrics rather than an eyeballed lookalike.

---

## License & disclaimer

This is an independent, non-commercial recreation for preservation and
educational purposes. "PlayStation", "PS3" and "XMB" are trademarks of Sony
Interactive Entertainment; this project is **not affiliated with or endorsed by
Sony**. No firmware, BIOS or copyrighted system code is redistributed here — only
an original reimplementation. The bundled Rodin font and any extracted assets
remain the property of their respective owners and are included for authenticity;
remove them if you fork this for any purpose where that is not appropriate.
