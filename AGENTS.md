# AGENTS.md: porting a classic game's source code to the browser

These instructions are for an agent given the original source code of an old game (typically DOS-era C, Pascal, BASIC
and/or assembler). They assume the user owns the source or has the right to port it. The source normally sits
read-only in a folder like `<orig-src>/` in the workspace.

## The goal

Produce a **faithful, playable browser port** plus a **write-up of how the game works**, published as a static site
(GitHub Pages) with **no dependencies and no build step**.

1. **A 1:1 functional port.** The game should play, look, sound and score like the original. Keep the original's
   rules, timings, AI, randomness, data and even its bugs and quirks (and document them). Restructure only where the
   platform forces it (blocking loops, interrupts, direct hardware access). Simplify code only when the behaviour
   stays identical.
2. **One web page** (`index.html`) with:
   - the game at the top, scaled crisply, with a click-to-start overlay (browsers need a user gesture for audio);
   - short player-facing copy: what the game is, how to play, a **keys table**, scoring;
   - underneath, a long **"How it works"** section documenting everything interesting learned from the source,
     illustrated with assets **extracted from the original data** (sprites, fonts, level maps, palettes).
3. **A README.md** that copies the page text ("How to play" downward) and starts with a prominent link to the
   GitHub Pages build, `https://<USER>.github.io/<REPO>/`. Leave the placeholder if the user hasn't given the repo yet.

Never modify the original source folder.

## Workflow

### 1. Read everything first

- Read the whole codebase before writing code: every module, header, data file and assembler routine, plus build
  scripts, notes and readme files. Note the **build configuration** too, because `#ifdef` flags (demo/shareware
  builds, debug, hardware variants) change behaviour. Port the full game build unless told otherwise.
- Write down, as you go, every constant, formula, table and state machine. These notes become the documentation.
- Watch for **compiler/toolchain quirks** that change meaning. Examples: identifiers significant only to N
  characters (so two differently-spelled names are the same symbol), `int` being 16 bits (overflow and wraparound),
  signed/unsigned char, integer division and shifts, uninitialised statics being zero.
- Identify the hardware model the game relies on: video mode and memory layout, palette registers, timer/PIT
  programming, keyboard scan codes and interrupt handlers, speaker or sound-chip writes, BIOS calls, disk access.

### 2. Extract the assets with a script, not by hand

- Write `tools/extract.js` (Node.js, no npm packages). It parses the original source/data files and writes a single
  `js/assets.js` (`const ASSETS = {...}`): sprites (with masks), fonts, title screens (decode any compression),
  level maps, music/sound tables, random tables, palettes.
- Keep the original names/keys of assets (e.g. the sprite file's suffix), so code and docs can refer to them.
- The extractor must be re-runnable and deterministic.

### 3. Emulate the hardware layer, then port the game logic on top

Recommended module split (classic scripts, no ES modules, so `file://` works too):

| File | Contents |
| --- | --- |
| `js/assets.js` | Generated data. Never hand-edit. |
| `js/<video>.js` | An emulated framebuffer in the original's **native memory format** (e.g. interlaced, packed bits per pixel), the original drawing/sprite routines ported line by line, and a `render(imageData)` that converts to RGBA. |
| `js/sound.js` | The sound code plus an emulation of the sound hardware (e.g. PIT square wave and speaker gate), generated sample by sample. |
| `js/game.js` | The game modules, using the **same function and variable names as the original**, so the two can be read side by side. Exposes a small API: `start()`, `keyEvent(scancode, down)`, `setSpeed(f)`, `onState(cb)`. |
| `js/main.js` | Page glue: canvas and `requestAnimationFrame`, key mapping, overlay, on-page controls. |
| `js/docs.js` | Builds the documentation's galleries and tables at runtime from `ASSETS`. |
| `css/style.css` | Styles. |
| `tools/*.js` | Node tools: extractor, headless test harness, image renderers, PNG encoder. |
| `img/`, `readme-img/` | Pre-rendered PNGs for the page and README respectively. |

Porting rules:

- **Emulate memory, not just pixels.** If the original reads video memory back (collision checks, "is this pixel
  dirt?"), the port must too. Porting the drawing routines against an emulated framebuffer is the easiest way to get
  sprite overlap, erase artefacts and pixel-based collisions exactly right.
- **Blocking code becomes `async`/`await`.** Busy-wait delays, "wait for key" loops and the main loop become awaits on
  timers. Keep the loop structure and counters identical, including any bugs in how loop variables are reused.
- **Timing.** Pick a frame duration matching the original machine's speed and make it a single tunable
  (`setSpeed(factor)`). Browsers clamp chained `setTimeout` to about 4 ms, so many tiny sleeps in a row must be
  merged into one deadline-based wait.
- **Interrupt-driven code** (timer ticks, sound) runs on its own clock: drive it from the audio callback when audio
  is running, with a `setInterval` fallback when it isn't.
- **Keyboard.** Map `KeyboardEvent.code` to the original's scan codes (key up = code | 0x80 on PC). Feed both down
  and up events, since many old games poll "last key" state. Add alternative keys where browsers steal the
  original ones (e.g. F1), call `preventDefault` only for game keys and only while the game is visible, and release
  held keys on window blur.
- **Randomness.** Port the original RNG and its tables exactly. Only seed from time if the original did.
- **Persistence.** Replace disk/high-score files with `localStorage`, keeping the original record format.
- **Audio.** Start the `AudioContext` from the click-to-start gesture. A `ScriptProcessorNode` is acceptable and
  simplest without a build step. A gentle low-pass filter and a DC blocker make emulated speaker squares less harsh.
- **Defend only where the original's data runs out** (e.g. an unused player slot with level 0). Note each such
  guard in a comment, since it's a deviation.
- Keep comments sparse and factual. Explain hardware facts and deliberate deviations, not the diff.

### 4. Test headlessly, then in a real browser

- Write `tools/headless.js`. It stubs `window`/`localStorage`, loads the scripts with `vm`, runs the game at high
  speed, drives scripted and random input (hold keys for real durations, since a same-tick down/up can be
  swallowed exactly as on the original), and dumps PNG snapshots (`tools/out/`, gitignored).
  Look at the snapshots: title screen, first level, mid-game, death, game over, high-score entry.
- Run long random sessions to catch exceptions and stuck states.
- Then serve the folder (`python3 -m http.server`) and check it in a real browser: overlay, title, start, movement,
  firing/actions, pause, sound toggles, docs rendering, no console errors, no broken images.

### 5. Write the page and the documentation

**Player-facing copy** (top of page, under the game):
- one-paragraph pitch of the goal, a keys table (with `<kbd>`), a scoring table, tips;
- quote the original in-game instructions/credits text where it exists (it's part of the provided source).

**"How it works" section.** This is the main deliverable after the game itself. Cover whatever applies, with a
numbered table of contents:
- program structure (modules/tasks and the main loop order);
- display hardware model, palettes and fonts, with swatches and a glyph sheet;
- the sprite format and a **full sprite gallery** grouped and captioned (use the original source comments for
  captions), optionally switchable between palettes;
- the sprite/drawing engine: draw order, save-under, masks, collision method and bitmasks;
- the playfield grid, coordinates and movement step sizes;
- **level structure**: map format and legend, each level rendered by the real engine next to its raw map data, and
  the level progression after the last unique level;
- per-object behaviour: enemy AI step by step, physics, weapons, power-ups, death sequences;
- a **difficulty table** computed from the original formulas for each level;
- scoring, lives and multiplayer rules;
- timing and speed control;
- sound hardware technique, described technically only. Do **not** name, identify or write out any music
  melodies or lyrics, even if the game's data contains them;
- title screen / compression formats;
- **quirks and curiosities**: bugs, typos that still compile, toolchain artefacts, copy protection, dead code,
  unused assets, demo-build differences;
- "about this port": file map, and an explicit list of every deviation from the original.

Documentation rules:
- **Every claim must be checked against the source.** Before publishing, grep for each number, formula and
  behaviour you state. Remove or soften anything you can't confirm, and don't guess at history or intent.
- Short code quotes from the provided source are good evidence (formulas, the main loop, a quirky line).
- Use the extracted assets for illustrations. Pre-render engine screenshots (level previews, alternate palettes,
  title screen) with a Node tool (`tools/render-docs.js`) into `img/`, so the docs never fight the live game for the
  framebuffer.
- Pixel art must stay crisp: `image-rendering: pixelated`, and correct the aspect ratio where the original pixels
  weren't square (e.g. 320×200 shown at 4:3).
- Write in plain, complete sentences for a curious reader who isn't a programmer. Use tables for enumerable facts
  and prose for explanations.

### 6. The README

- First lines: the title, a one-line description, then a prominent **play link** as a heading
  (`## ▶ [Play <GAME> in your browser](https://<USER>.github.io/<REPO>/)`), followed by a screenshot that
  links to the same URL.
- Then copy the page text from "How to play" downward. GitHub can't run scripts or scale images crisply, so:
  - write `tools/render-readme.js` to export everything the page draws at runtime (sprite groups with labels,
    font sheet, palette swatches) as PNGs into **`readme-img/`**, and nearest-neighbour upscale the `img/`
    screenshots there too;
  - turn generated tables (e.g. difficulty) into static Markdown tables, and level maps into `<pre>` blocks
    beside their images in an HTML `<table>`;
  - reword page-only phrases ("the control above").
- After writing it, check that every image link resolves, and that copied data (maps, tables) matches `ASSETS`.
- End with how to regenerate the images (`node tools/render-docs.js && node tools/render-readme.js`).

## Conventions

- No dependencies: no npm packages at runtime or in tools, no CDNs, no frameworks, no bundler. Node built-ins only
  (`fs`, `path`, `vm`, `zlib`). Write a tiny PNG encoder (`tools/png.js`) and share it.
- Classic `<script>` tags in dependency order: assets, video, sound, game, main, docs. Each module is an IIFE exposing
  one global.
- Keep generated files (`js/assets.js`, `img/`, `readme-img/`) reproducible from tools, and commit them, because
  Pages serves the repo as is.
- `.gitignore`: `tools/out/`, `.DS_Store`. Ask the user whether the original source folder should be published.
- Don't create other docs or files beyond those listed here unless asked.

## Definition of done

- [ ] The game is playable from `index.html` via `file://` and a static server, with no console errors.
- [ ] Title/attract mode, every level, scoring, lives, game over, high scores, pause and sound toggles work.
- [ ] A headless run of a few hundred random steps finishes without exceptions.
- [ ] The page has the game, the keys table, scoring, and the full "How it works" section with extracted-asset
      illustrations; every factual claim has been checked against the source.
- [ ] Deviations from the original are listed on the page.
- [ ] `README.md` mirrors the page, starts with the Pages play link, and all its images load from `readme-img/` and `img/`.
- [ ] The final summary to the user explains how to enable GitHub Pages (Settings → Pages → deploy from branch,
      root) and the git commands to push.
