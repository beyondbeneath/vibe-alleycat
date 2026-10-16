// Page glue: canvas, keyboard, overlay and the controls under the game.
'use strict';
(() => {
  const canvas = document.getElementById('screen');
  const frame = document.getElementById('frame');
  const overlay = document.getElementById('overlay');
  const g = canvas.getContext('2d');
  const src = document.createElement('canvas');
  src.width = 320; src.height = 200;
  const sg = src.getContext('2d');
  const img = sg.createImageData(320, 200);
  Sound.attach(Game);

  // ---- display: 320x200 shown at 4:3, nearest neighbour, inside the CGA border colour ----------
  function fit() {
    const r = canvas.getBoundingClientRect();
    const w = Math.max(320, Math.round(r.width * (window.devicePixelRatio || 1)));
    if (canvas.width !== w) { canvas.width = w; canvas.height = Math.round(w * 3 / 4); }
  }
  let lastBorder = '';
  function draw() {
    fit();
    CGA.render(img);
    sg.putImageData(img, 0, 0);
    const c = CGA.RGBI[CGA.state.colorSelect & 0x0f];
    const border = `rgb(${c >> 16},${(c >> 8) & 255},${c & 255})`;
    if (border !== lastBorder) { frame.style.background = border; lastBorder = border; }
    g.imageSmoothingEnabled = false;
    g.fillStyle = border;
    g.fillRect(0, 0, canvas.width, canvas.height);
    // Ctrl+Alt+Left/Right move the picture by reprogramming the CRTC's horizontal sync.
    const dx = Game.hsyncShift / 320 * canvas.width;
    g.drawImage(src, dx, 0, canvas.width, canvas.height);
    requestAnimationFrame(draw);
  }

  // ---- keyboard: KeyboardEvent.code to PC/XT scan codes -----------------------------------------
  const SCAN = {
    Escape: 0x01, Digit1: 0x02, Digit2: 0x03, Digit3: 0x04, Digit4: 0x05, Digit5: 0x06, Digit6: 0x07,
    Digit7: 0x08, Digit8: 0x09, Digit9: 0x0a, Digit0: 0x0b, Minus: 0x0c, Equal: 0x0d, Backspace: 0x0e,
    Tab: 0x0f, KeyQ: 0x10, KeyW: 0x11, KeyE: 0x12, KeyR: 0x13, KeyT: 0x14, KeyY: 0x15, KeyU: 0x16,
    KeyI: 0x17, KeyO: 0x18, KeyP: 0x19, BracketLeft: 0x1a, BracketRight: 0x1b, Enter: 0x1c,
    ControlLeft: 0x1d, ControlRight: 0x1d, KeyA: 0x1e, KeyS: 0x1f, KeyD: 0x20, KeyF: 0x21, KeyG: 0x22,
    KeyH: 0x23, KeyJ: 0x24, KeyK: 0x25, KeyL: 0x26, Semicolon: 0x27, Quote: 0x28, Backquote: 0x29,
    ShiftLeft: 0x2a, Backslash: 0x2b, KeyZ: 0x2c, KeyX: 0x2d, KeyC: 0x2e, KeyV: 0x2f, KeyB: 0x30,
    KeyN: 0x31, KeyM: 0x32, Comma: 0x33, Period: 0x34, Slash: 0x35, ShiftRight: 0x36,
    NumpadMultiply: 0x37, AltLeft: 0x38, AltRight: 0x38, Space: 0x39, CapsLock: 0x3a,
    F1: 0x3b, F2: 0x3c, F3: 0x3d, F4: 0x3e, F5: 0x3f, F6: 0x40, F7: 0x41, F8: 0x42, F9: 0x43, F10: 0x44,
    NumLock: 0x45, ScrollLock: 0x46,
    Home: 0x47, ArrowUp: 0x48, PageUp: 0x49, NumpadSubtract: 0x4a, ArrowLeft: 0x4b, Numpad5: 0x4c,
    ArrowRight: 0x4d, NumpadAdd: 0x4e, End: 0x4f, ArrowDown: 0x50, PageDown: 0x51, Insert: 0x52, Delete: 0x53,
    Numpad7: 0x47, Numpad8: 0x48, Numpad9: 0x49, Numpad4: 0x4b, Numpad6: 0x4d, Numpad1: 0x4f,
    Numpad2: 0x50, Numpad3: 0x51, Numpad0: 0x52, NumpadDecimal: 0x53, NumpadEnter: 0x1c,
  };
  // Extra key, not in the original: X also works as Alt, for browsers and systems that keep Alt.
  const ALIAS = { KeyX: 0x38 };
  const held = new Map();
  let started = false, visible = true;
  new IntersectionObserver((e) => { visible = e[0].isIntersecting; }).observe(canvas);

  function typing(e) {
    const t = e.target;
    return t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
  }
  function onKey(e, down) {
    if (!started || !visible || typing(e)) return;
    if (e.metaKey) return;                     // leave Cmd shortcuts to the browser
    const sc = ALIAS[e.code] ?? SCAN[e.code];
    if (sc === undefined) return;
    e.preventDefault();
    if (down) { held.set(e.code, sc); Game.keyEvent(sc, true); }
    else if (held.has(e.code)) { held.delete(e.code); Game.keyEvent(sc, false); }
    else Game.keyEvent(sc, false);
  }
  window.addEventListener('keydown', (e) => onKey(e, true));
  window.addEventListener('keyup', (e) => onKey(e, false));
  function releaseAll() { for (const sc of held.values()) Game.keyEvent(sc, false); held.clear(); }
  window.addEventListener('blur', releaseAll);
  document.addEventListener('visibilitychange', () => { if (document.hidden) releaseAll(); });

  // On-page buttons for the Ctrl combinations that browsers tend to take for themselves.
  function chord(keys) {
    if (!started) return;
    for (const k of keys) Game.keyEvent(k, true);
    setTimeout(() => { for (const k of keys.slice().reverse()) Game.keyEvent(k, false); }, 120);
    canvas.focus();
  }
  for (const b of document.querySelectorAll('[data-chord]')) {
    b.addEventListener('click', () => chord(b.dataset.chord.split(',').map((x) => parseInt(x, 16))));
  }

  // ---- overlay and controls ----------------------------------------------------------------------
  function begin() {
    if (started) return;
    started = true;
    overlay.hidden = true;
    Sound.start();
    Game.start();
    canvas.focus();
  }
  overlay.addEventListener('click', begin);
  canvas.addEventListener('click', () => { Sound.start(); canvas.focus(); });

  const speedSel = document.getElementById('speed');
  if (speedSel) speedSel.addEventListener('change', () => { Game.setSpeed(parseFloat(speedSel.value)); speedSel.blur(); });
  const mute = document.getElementById('mute');
  if (mute) mute.addEventListener('change', () => { Sound.muted = mute.checked; mute.blur(); });

  CGA.render(img);
  requestAnimationFrame(draw);
})();
