# Vid-Edi Pro

A Premiere Pro–style non-linear video editor that runs entirely in the browser. You don't need to install anything or upload media to a server: decoding, GPU compositing, audio mixing and encoding all run locally.

The layout, panels, tools, effect names, keyboard shortcuts and editing behavior all follow Adobe Premiere Pro, so Premiere users should feel at home.

## Running it

It is a static site with no build step. Serve the folder over HTTP (ES modules don't load from `file://`):

```bash
node test/server.mjs 8080        # or: npm start  /  npx http-server .
# open http://localhost:8080/
```

Use a recent Chromium-based browser (Chrome or Edge) for the full feature set (WebGL 2, WebCodecs export, File System Access). Firefox and Safari also run the editor. Export there uses the real-time MediaRecorder fallback when WebCodecs isn't available.

On the start screen, choose **Open Sample Project** to try it without your own media. It contains bars and tone, color mattes, titles, transitions, an adjustment layer with a Lumetri look, markers and captions.

## Features

### Workspaces and panels
- Docking workspace with resizable frames, tabbed panel groups, drag-to-dock tabs, and maximize with `` ` ``.
- Workspaces: **Assembly, Editing, Color, Effects, Audio, Graphics, Captions** (`Alt+Shift+1…7`).
- Panels: Project, Media Browser, Source Monitor, Program Monitor, Timeline, Tools, Effects, Effect Controls, Lumetri Color, Lumetri Scopes, Essential Graphics, Essential Sound, Audio Track Mixer, Audio Clip Mixer, Audio Meters, History, Info, Markers, Text (Captions).

### Project
- Import video, audio, images, `.srt`/`.vtt` captions and `.cube` LUTs by menu, drag-and-drop or the Media Browser.
- Bins, list and icon views with hover-scrub thumbnails, sortable columns, labels, rename and search.
- New items: Sequence (presets including HD, UHD, vertical and square), Adjustment Layer, Bars and Tone, Black Video, Color Matte, Universal Counting Leader, Transparent Video.
- Automate to Sequence, New Sequence From Clip, Link Media / Make Offline, Properties.

### Timeline
- Multiple sequences in tabs, unlimited video and audio tracks, and a Mix track.
- Track controls: source patching, track targeting, sync lock, lock, track output, mute/solo, voice-over record, and resizable track heights.
- Tools: Selection (V), Track Select Forward/Backward (A / Shift+A), Ripple Edit (B), Rolling Edit (N), Rate Stretch (R), Razor (C), Slip (Y), Slide (U), Pen (P), Rectangle, Ellipse, Hand (H), Zoom (Z) and Type (T).
- Editing:
  - Insert and overwrite drags (hold Ctrl to insert), Alt-drag to duplicate, linked selection, grouping.
  - Snapping (S), trimming and ripple trimming with Ctrl.
  - Ripple delete, gap selection, lift/extract, Add Edit, and Q/W ripple trims.
  - Nudge, nesting, Speed/Duration with reverse, Time Remapping speed ramps, frame hold.
  - Scene Edit Detection, Scale/Set to Frame Size, Paste/Remove Attributes.
- Display: video thumbnails, audio waveforms, opacity and volume rubber bands (Ctrl+click adds keyframes), fx badges, a render bar, markers, an in/out range and a caption track.

### Monitors
- Source Monitor with In/Out marks, markers, Insert (,) and Overwrite (.), and drag video-only or audio-only.
- Program Monitor:
  - Lift/Extract, Export Frame, Play In to Out, loop, safe margins and a transparency grid.
  - Zoom and playback resolution (Full, 1/2, 1/4, 1/8).
- Direct manipulation in the Program Monitor:
  - Move, scale and rotate clips with handles.
  - Edit graphic layers, and type text inline with the Type tool.
  - Draw rectangles and ellipses, and edit mask vertices or add Pen-tool points.
- Playback: J/K/L shuttle, frame stepping, edit-point navigation, Play Around, and audio scrubbing.

### Effects (GPU, WebGL 2)
- **75 video effects** in Premiere's categories:
  - Adjust: Extract, Levels, Lighting Effects, ProcAmp, Channel Mixer.
  - Blur & Sharpen: Gaussian, Camera and Directional Blur, Sharpen, Unsharp Mask.
  - Color Correction: Lumetri Color, Brightness & Contrast, Color Balance, Change Color, Change to Color, Leave Color, Tint, Video Limiter.
  - Distort: Transform, Corner Pin, Lens Distortion, Magnify, Mirror, Offset, Spherize, Twirl, Wave Warp, Turbulent Displace.
  - Generate: 4-Color Gradient, Ramp, Circle, Ellipse, Checkerboard, Grid, Lens Flare.
  - Keying: Ultra Key, Color Key, Luma Key, Track Matte Key, Alpha Adjust.
  - Perspective: Basic 3D, Drop Shadow, Bevel Alpha, Bevel Edges.
  - Stylize: Alpha Glow, Brush Strokes, Emboss, Find Edges, Mosaic, Posterize, Replicate, Roughen Edges, Solarize, Strobe Light, Threshold.
  - Also: Noise & Grain, Image Control, Channel, Time (Posterize Time), Transform (Crop, flips, Edge Feather), Transition effects (Linear, Radial, Block, Venetian) and Video (Clip Name, Timecode).
- **38 video transitions**:
  - Dissolve: Cross, Additive, Film, Non-Additive, Dip to Black/White.
  - Iris: Box, Cross, Diamond, Round.
  - Wipe: 17 variants.
  - Slide: Push, Slide, Split, Center Split, Band Slide, Whip.
  - Zoom: Cross Zoom.
  - 3D Motion: Cube Spin, Flip Over.
  - Page Peel: Page Peel, Page Turn.
- **25 audio effects** (EQs, filters, compressors, limiter, DeHummer, delay, chorus/flanger, studio reverb, channel tools, distortion) and three crossfades: Constant Power, Constant Gain and Exponential Fade.
- Fixed effects:
  - Motion: position, scale, rotation, anchor.
  - Opacity: all 27 Premiere blend modes, plus ellipse, 4-point and bezier masks with feather, expansion, inversion and mask modes.
  - Time Remapping.
  - Volume, Channel Volume and Panner.
- Effect Controls:
  - Hot-text scrubbing, stopwatch keyframing and keyframe navigation.
  - A keyframe lane with drag, multi-select and Linear/Bezier/Hold/Ease interpolation.
  - Effect reorder, copy/paste and saved presets.
- Presets: PiPs, Blur/Mosaic/Twirl/Solarize In and Out, Ken Burns, fades, Telephone and Radio voice, and Lumetri looks.
- Adjustment layers, nested sequences and Track Matte Key.

### Color
- **Lumetri Color**:
  - Basic Correction (Input LUT `.cube`, white balance, tone, saturation, Auto) and Creative (Looks, faded film, sharpen, vibrance, tint wheels).
  - RGB Curves, Hue Saturation curves and three-way Color Wheels.
  - HSL Secondary and Vignette.
  - With no clip selected, the panel targets the topmost clip under the playhead.
- **Lumetri Scopes**: Waveform (Luma or RGB), RGB Parade, Vectorscope YUV and Histogram.

### Graphics and captions
- Essential Graphics with Browse templates (titles, lower thirds, social, rolling credits) and Edit for text and shape layers.
- Text and shape layer controls: fonts (system and Google Fonts), size, tracking, leading, alignment, fill, stroke, background, shadow, alignment tools and keyframeable transforms.
- Captions track and Text panel: add and edit captions, import and export SRT/VTT, caption styling, and optional burn-in on export.

### Audio
- Web Audio mixing with per-clip gain, volume keyframes, track volume and pan, mute/solo, master volume and live meters.
- Audio Gain (G) with normalize, Essential Sound (Dialogue/Music/SFX/Ambience with repair, clarity, loudness auto-match and **auto ducking**), and voice-over recording.

### Export (Ctrl+M)
- WebCodecs encoding to **H.264, HEVC or AV1 (MP4)** and **VP9 or VP8 (WebM)** with AAC or Opus audio, using the bundled `mp4-muxer` and `webm-muxer`.
- WAV audio, PNG frame, and a real-time MediaRecorder fallback.
- Presets (YouTube, Vimeo, social formats), custom frame size and bitrate, In/Out range, an estimated file size and a preview scrubber.

### Saving
- Autosave to IndexedDB, including imported media, so projects reopen after a reload.
- Open Project lists projects stored in the browser.
- **Save As** downloads a `.vproj` project file, and **Save a Copy (with media)** downloads a single bundle file containing the project and all media.
- Unlimited undo/redo with a History panel.

## Keyboard shortcuts (Premiere Pro defaults)

| Action | Shortcut | Action | Shortcut |
|---|---|---|---|
| Play/Stop | Space | Shuttle | J / K / L |
| Step frame | ← / → (Shift: 5) | Previous/next edit | ↑ / ↓ |
| Mark In/Out | I / O | Go to In/Out | Shift+I / Shift+O |
| Clear In and Out | Ctrl+Shift+X | Mark Clip | X |
| Insert / Overwrite | , / . | Lift / Extract | ; / ' |
| Add Edit / All Tracks | Ctrl+K / Ctrl+Shift+K | Ripple Trim Prev/Next | Q / W |
| Ripple Delete | Shift+Delete | Clear | Delete |
| Default video/audio transition | Ctrl+D / Ctrl+Shift+D | Transitions to selection | Shift+D |
| Speed/Duration | Ctrl+R | Audio Gain | G |
| Link/Unlink | Ctrl+L | Group / Ungroup | Ctrl+G / Ctrl+Shift+G |
| Enable/Disable clip | Shift+E | Match Frame | F |
| Add Marker | M | Next/Prev Marker | Shift+M / Ctrl+Shift+M |
| Snap | S | Zoom in/out/fit | = / - / \ |
| Undo / Redo | Ctrl+Z / Ctrl+Shift+Z | Export Media | Ctrl+M |
| New Sequence | Ctrl+N | Import | Ctrl+I |
| New Text Layer | Ctrl+T | Keyboard Shortcuts | Ctrl+Alt+K |
| Panels | Shift+1…9 | Maximize frame | ` |

The tool keys are listed in the Timeline section above. On macOS, Ctrl is ⌘. All shortcuts can be remapped in **Edit › Keyboard Shortcuts**, which shows a visual keyboard like Premiere's.

## Architecture

```
index.html, css/          UI shell and the Premiere-style dark theme
src/core/                 data model, undo history, keyframes, timecode, edit operations,
                          actions, commands and shortcuts, media import, persistence, captions, presets
src/engine/               WebGL2 compositor, video effects, Lumetri, transitions, graphics renderer,
                          video source pool, Web Audio engine and effects, playback clock, exporter
src/ui/                   docking layout, menus, dialogs, widgets, icons, preferences
src/ui/panels/            the individual panels
vendor/                   mp4-muxer and webm-muxer (MIT)
test/                     static server, fixtures, Playwright smoke and UI tests
```

- The project is plain JSON. Undo and redo store snapshots, and every edit runs through `app.edit(label, fn)`.
- Each clip renders in its own space at an adaptive resolution with padding for effects that extend past the frame, such as drop shadows and blurs. The pipeline is:
  1. Source.
  2. Standard effects, each with optional masks.
  3. Opacity masks.
  4. Motion transform into sequence space.
  5. Blending onto the sequence.
- Transitions combine two sequence-space layers in a shader.
- During playback the audio clock drives the playhead. While paused or exporting, video is seeked frame-accurately.

## Tests

```bash
node scripts/check.mjs      # static import/export consistency check
node test/smoke.mjs         # end-to-end: import, edit, every effect/transition, mix, export, persistence
node test/ui.mjs            # real mouse/keyboard interactions with the panels
```

The tests use Playwright with headless Chromium (SwiftShader WebGL).
