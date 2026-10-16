// Builds the documentation's galleries and tables from ASSETS at page load.
'use strict';
const Docs = (() => {
  const $ = ASSETS.sym, D = ASSETS.ds;
  const rb = (a) => D[a];
  const rw = (a) => D[a] | (D[a + 1] << 8);
  const hex = (n, w = 4) => n.toString(16).toUpperCase().padStart(w, '0');
  const rgb = (c) => `rgb(${c >> 16},${(c >> 8) & 255},${c & 255})`;
  const el = (tag, attrs = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) if (k === 'class') e.className = v; else e.setAttribute(k, v);
    for (const k of kids) e.append(k);
    return e;
  };
  const SCREENS = ['Title and menus', 'Alley', 'Room 1: the fishbowl room', 'Room 2: inside the fishbowl',
    'Room 3: the bookcase', 'Room 4: the cheese', 'Room 5: the birdcage', 'Room 6: the sleeping dogs',
    'Room 7: the love scene'];
  // Colour-select value for a screen: palette from cga_palette_table, black background.
  const screenPalette = (s) => (s <= 1 ? 1 : rb($.cga_palette_table + s - 1));

  // A 2-bit-per-pixel bitmap from the data segment, stored row after row (the blitters add the
  // CGA interlace on the way to the screen).
  function sprite(si, cx, kind, pal, scale = 3) {
    const words = cx & 0xff, h = (cx >> 8) || 256, w = words * 8;
    const c = el('canvas', { width: w, height: h, class: 'px' });
    c.style.width = w * scale + 'px';
    c.style.height = h * scale * 1.2 + 'px';
    const g = c.getContext('2d');
    const img = g.createImageData(w, h);
    const colours = CGA.palette(pal ? 0x20 : 0);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const v = (D[si + y * words * 2 + (x >> 2)] >> (6 - (x & 3) * 2)) & 3;
      // Transparent blits let colour 0 through; masked (AND) blits keep the background where
      // the sprite has colour 3.
      const clear = (kind === 'transparent' && v === 0) || (kind === 'masked' && v === 3);
      const o = (y * w + x) * 4, col = colours[v];
      img.data[o] = col >> 16; img.data[o + 1] = (col >> 8) & 255; img.data[o + 2] = col & 255;
      img.data[o + 3] = clear ? 0 : 255;
    }
    g.putImageData(img, 0, 0);
    return c;
  }

  // Sprite groups, in page order. The title screen draws the alley too, so anything the alley
  // draws counts as the alley's.
  const CAT = 'The cat: walking, jumping, climbing, sitting (every screen)';
  const SWIM = 'The cat swimming (room 2)';
  const SHARED = 'Shared by several rooms';
  function groups() {
    const order = [SCREENS[0], SCREENS[1], CAT, ...SCREENS.slice(2, 4), SWIM, ...SCREENS.slice(4), SHARED];
    const out = new Map(order.map((n) => [n, { pal: 1, items: [] }]));
    for (const s of ASSETS.sprites) {
      const [si, , , screens] = s;
      if (si >= 0x6d0 && si < 0x9da) { out.get(SWIM).items.push(s); continue; }
      if (si >= 0x9da && si < 0xf7a) { out.get(CAT).items.push(s); continue; }
      let n = 0; for (let b = screens >> 2; b; b >>= 1) n += b & 1;
      if (n >= 2 && !(screens & 2) || n >= 3) { out.get(SHARED).items.push(s); continue; }
      let first = 0; while (!(screens & (1 << first))) first++;
      if (screens & 2) first = 1;
      const g = out.get(SCREENS[first]);
      g.pal = screenPalette(first);
      g.items.push(s);
    }
    for (const [n, g] of out) if (!g.items.length) out.delete(n);
    return out;
  }

  function gallery(root) {
    const groups_ = groups();
    const sel = root.querySelector('select');
    const body = root.querySelector('.groups');
    const draw = () => {
      body.textContent = '';
      for (const [name, g] of groups_) {
        const pal = sel.value === 'room' ? g.pal : Number(sel.value);
        const box = el('div', { class: 'sprites' });
        for (const [si, cx, kind, , label] of g.items) {
          const w = (cx & 0xff) * 8, h = (cx >> 8) || 256;
          box.append(el('figure', {}, sprite(si, cx, kind, pal),
            el('figcaption', {}, `${hex(si)} · ${w}×${h} · ${kind}`, el('br'), el('code', {}, label))));
        }
        body.append(el('h4', {}, `${name} (${g.items.length})`), box);
      }
    };
    sel.addEventListener('change', draw);
    draw();
  }

  function palettes(root) {
    for (const [cs, name] of [[0x00, 'Palette 0 (rooms 4, 5 and 7)'], [0x20, 'Palette 1 (title, alley, rooms 1, 2, 3 and 6)'],
      [0x10, 'Palette 0, bright (not used)'], [0x30, 'Palette 1, bright (not used)']]) {
      const row = el('div', { class: 'swatches' }, el('span', { class: 'swname' }, name));
      CGA.palette(cs).forEach((c, i) => row.append(el('span', { class: 'swatch', style: `background:${rgb(c)}`, title: rgb(c) }, String(i))));
      root.append(row);
    }
    const all = el('div', { class: 'swatches' }, el('span', { class: 'swname' }, 'The 16 RGBI colours'));
    CGA.RGBI.forEach((c, i) => all.append(el('span', { class: 'swatch', style: `background:${rgb(c)}`, title: rgb(c) }, String(i))));
    root.append(all);
  }

  function font(root) {
    const cols = 32, rows = 3, W = cols * 8, H = rows * 8;
    const c = el('canvas', { width: W, height: H, class: 'px' });
    c.style.width = W * 3 + 'px'; c.style.height = H * 3.6 + 'px';
    const g = c.getContext('2d'), img = g.createImageData(W, H);
    const [bg, , , fg] = CGA.palette(0x20);
    for (let ch = 0x20; ch < 0x80; ch++) {
      const cx = ((ch - 0x20) % cols) * 8, cy = Math.floor((ch - 0x20) / cols) * 8;
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
        const on = CGA.FONT[ch * 8 + y] & (0x80 >> x);
        const col = on ? fg : bg, o = ((cy + y) * W + cx + x) * 4;
        img.data[o] = col >> 16; img.data[o + 1] = (col >> 8) & 255; img.data[o + 2] = col & 255; img.data[o + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    root.append(c);
  }

  // The per-difficulty tables, indexed by difficulty_level 0-7.
  const DIFF = [
    ['throw_delay', 'Washing lines: loop passes between steps (a quarter of this while the cat is up high)'],
    ['throw_chance', 'Washing lines: chance in 256 that a new stretch of line is bare'],
    ['enemy_spawn_chance', 'Dog: chance in 256, per check, that it comes running'],
    ['enemy_chase_chance', 'Dog: chance in 256 that it turns towards the cat'],
    ['obj_chase_table', 'Mice: chance in 256 that a mouse level with the cat runs at it'],
    ['l6_obj_type', 'Room 6: number of sleeping dogs'],
    ['l6_obj_init_y_tbl', 'Room 6: helpings in each dish'],
  ];
  function difficulty(root) {
    const t = el('table');
    const head = el('tr', {}, el('th', {}, 'Table'), el('th', {}, 'Meaning'));
    for (let d = 0; d < 8; d++) head.append(el('th', {}, String(d)));
    t.append(el('thead', {}, head));
    const tb = el('tbody');
    for (const [name, what] of DIFF) {
      const tr = el('tr', {}, el('td', {}, el('code', {}, name)), el('td', {}, what));
      for (let d = 0; d < 8; d++) tr.append(el('td', { class: 'num' }, String(rb($[name] + d))));
      tb.append(tr);
    }
    const mult = el('tr', {}, el('td', {}, el('code', {}, '0x36DC')), el('td', {}, 'Love scene bonus multiplier (doubled when carrying a gift)'));
    for (let d = 0; d < 8; d++) mult.append(el('td', { class: 'num' }, String(rw(0x36dc + d * 2))));
    tb.append(mult);
    t.append(tb);
    root.append(t);
  }

  function pools(root) {
    const t = el('table');
    t.append(el('thead', {}, el('tr', {}, el('th', {}, 'difficulty_level & 3'), el('th', {}, 'level_pool row (3 draws in 4)'), el('th', {}, 'otherwise'))));
    const hard = Array.from(D.slice($.level_pool_hard, $.level_pool_hard + 5)).join(', ');
    const tb = el('tbody');
    for (let r = 0; r < 4; r++) {
      const row = r < 3 ? Array.from(D.slice($.level_pool + r * 4, $.level_pool + r * 4 + 4)).join(', ') : '(never used)';
      tb.append(el('tr', {}, el('td', { class: 'num' }, String(r)), el('td', {}, row), el('td', {}, `level_pool_hard: ${hard}`)));
    }
    t.append(tb);
    root.append(t);
  }

  function bonuses(root) {
    const t = el('table');
    t.append(el('thead', {}, el('tr', {}, el('th', {}, 'Room'), el('th', {}, 'Base bonus'), el('th', {}, 'Time bonus (t = ticks since entering, 18.2 per second)'))));
    const tb = el('tbody');
    for (let l = 2; l <= 7; l++) {
      const p = rw(0x36cc + l * 2);
      const base = Number(Array.from(D.slice(p, p + 7)).join(''));
      const time = l === 7 ? '(10,800 − t) ÷ 2, t counted from the start of the game or the last love scene; then × multiplier'
        : l === 6 ? '2,700 − t' : '2 × (1,350 − t)';
      tb.append(el('tr', {}, el('td', {}, SCREENS[l + 1]), el('td', { class: 'num' }, base.toLocaleString('en')), el('td', {}, time)));
    }
    t.append(tb);
    root.append(t);
  }

  function init() {
    const q = (id) => document.getElementById(id);
    if (q('palettes')) palettes(q('palettes'));
    if (q('font')) font(q('font'));
    if (q('gallery')) gallery(q('gallery'));
    if (q('difficulty')) difficulty(q('difficulty'));
    if (q('pools')) pools(q('pools'));
    if (q('bonuses')) bonuses(q('bonuses'));
  }
  return { init, sprite, groups, screenPalette, SCREENS, DIFF };
})();
if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', Docs.init);
