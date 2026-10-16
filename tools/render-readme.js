// Exports everything the page draws at runtime as PNGs into readme-img/, since GitHub can't run
// the page's scripts: palette swatches, the font sheet, one labelled sheet per sprite group, and
// the img/ screenshots upscaled. Also prints the page's data tables as Markdown for README.md.
// CGA pixels are 1.2 times taller than wide, so pictures are scaled 5x6 (exactly 4:3 for 320x200).
// Run: node tools/render-readme.js  (after node tools/render-docs.js)
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { encodePNG, decodePNG, scale } = require('./png');
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'readme-img');
fs.mkdirSync(OUT, { recursive: true });

const ctx = { atob };
vm.createContext(ctx);
for (const f of ['js/assets.js', 'js/cga.js', 'js/docs.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
}
vm.runInContext('this.ASSETS = ASSETS; this.CGA = CGA; this.Docs = Docs;', ctx);
const { ASSETS, CGA, Docs } = ctx;
const D = ASSETS.ds, $ = ASSETS.sym;
const hex = (n, w = 4) => n.toString(16).toUpperCase().padStart(w, '0');

// ---- a tiny RGBA canvas ------------------------------------------------------------------------
function canvas(w, h, bg = 0x202020) {
  const c = { w, h, data: new Uint8ClampedArray(w * h * 4) };
  fill(c, 0, 0, w, h, bg);
  return c;
}
function px(c, x, y, col) {
  if (x < 0 || y < 0 || x >= c.w || y >= c.h) return;
  const o = (y * c.w + x) * 4;
  c.data[o] = col >> 16; c.data[o + 1] = (col >> 8) & 255; c.data[o + 2] = col & 255; c.data[o + 3] = 255;
}
function fill(c, x0, y0, w, h, col) { for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) px(c, x, y, col); }
function text(c, x, y, s, col) {
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    for (let r = 0; r < 8; r++) for (let b = 0; b < 8; b++) {
      if (CGA.FONT[ch * 8 + r] & (0x80 >> b)) px(c, x + i * 8 + b, y + r, col);
    }
  }
}
function save(c, name, sx = 5, sy = 6) {
  const s = scale(c.w, c.h, c.data, sx, sy);
  fs.writeFileSync(path.join(OUT, name), encodePNG(s.width, s.height, s.data));
  return name;
}
const written = [];

// ---- palettes -----------------------------------------------------------------------------------
function swatches(colours, name) {
  const W = 20, H = 14, c = canvas(colours.length * (W + 2) - 2, H);
  colours.forEach((col, i) => {
    fill(c, i * (W + 2), 0, W, H, col);
    const lum = 0.3 * (col >> 16) + 0.59 * ((col >> 8) & 255) + 0.11 * (col & 255);
    const s = String(i);
    text(c, i * (W + 2) + (W - s.length * 8) / 2, 3, s, lum > 110 ? 0x000000 : 0xffffff);
  });
  written.push(save(c, name, 3, 3));
}
swatches(CGA.palette(0x00), 'palette-0.png');
swatches(CGA.palette(0x20), 'palette-1.png');
swatches(CGA.palette(0x10), 'palette-0-bright.png');
swatches(CGA.palette(0x30), 'palette-1-bright.png');
swatches(CGA.RGBI, 'rgbi.png');

// ---- font ---------------------------------------------------------------------------------------
{
  const cols = 32, c = canvas(cols * 8, 3 * 8);
  const [bg, , , fg] = CGA.palette(0x20);
  fill(c, 0, 0, c.w, c.h, bg);
  for (let ch = 0x20; ch < 0x80; ch++) text(c, ((ch - 0x20) % cols) * 8, Math.floor((ch - 0x20) / cols) * 8, String.fromCharCode(ch), fg);
  written.push(save(c, 'font.png'));
}

// ---- sprite groups: a contact sheet each, captioned with the data-segment offset -------------
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const groupList = [];
for (const [name, g] of Docs.groups()) {
  const colours = CGA.palette(g.pal ? 0x20 : 0);
  const items = g.items.map(([si, cx, kind, , label]) => ({ si, cx, kind, label, w: (cx & 0xff) * 8, h: (cx >> 8) || 256 }));
  const PAD = 6, LABEL = 10;
  const maxW = Math.max(176, ...items.map((s) => Math.max(s.w, 32)));
  // Shelf packing in data-segment order.
  const rows = [];
  let row = null;
  for (const s of items) {
    const cw = Math.max(s.w, 32);
    if (!row || row.w + PAD + cw > maxW) rows.push(row = { w: -PAD, h: 0, items: [] });
    s.x = row.w + PAD; row.w += PAD + cw; row.h = Math.max(row.h, s.h + LABEL); row.items.push(s);
  }
  const W = Math.max(...rows.map((r) => r.w)) + 2 * PAD;
  const H = rows.reduce((a, r) => a + r.h + PAD, PAD);
  const c = canvas(W, H);
  let y = PAD;
  for (const r of rows) {
    for (const s of r.items) {
      const x0 = PAD + s.x, words = s.cx & 0xff;
      for (let yy = 0; yy < s.h; yy++) for (let xx = 0; xx < s.w; xx++) {
        const v = (D[s.si + yy * words * 2 + (xx >> 2)] >> (6 - (xx & 3) * 2)) & 3;
        const clear = (s.kind === 'transparent' && v === 0) || (s.kind === 'masked' && v === 3);
        px(c, x0 + xx, y + yy, clear ? (((xx >> 2) + (yy >> 2)) & 1 ? 0x707070 : 0x909090) : colours[v]);
      }
      text(c, x0, y + s.h + 2, hex(s.si), 0xc0c0c0);
    }
    y += r.h + PAD;
  }
  const file = save(c, 'sprites-' + slug(name.split(':')[0].replace(/\(.*\)/, '')) + '.png');
  written.push(file);
  groupList.push({ name, file, items });
}

// ---- screenshots from img/ ---------------------------------------------------------------------
for (const f of fs.readdirSync(path.join(ROOT, 'img')).filter((f) => f.endsWith('.png')).sort()) {
  const p = decodePNG(fs.readFileSync(path.join(ROOT, 'img', f)));
  const s = scale(p.width, p.height, p.data, 5, 6);
  fs.writeFileSync(path.join(OUT, f), encodePNG(s.width, s.height, s.data));
  written.push(f);
}
console.log('readme-img/: ' + written.join(', '));

// ---- Markdown for README.md ---------------------------------------------------------------------
const md = [];
md.push('<!-- sprite groups -->');
for (const g of groupList) {
  md.push(`#### ${g.name} (${g.items.length})`, '', `![${g.name}](readme-img/${g.file})`, '',
    '<details><summary>Offsets, sizes, drawing routine and nearest label</summary>', '',
    '| Offset | Size | Drawn with | Nearest label |', '| --- | --- | --- | --- |');
  for (const s of g.items) md.push(`| \`${hex(s.si)}\` | ${s.w}×${s.h} | ${s.kind} | \`${s.label}\` |`);
  md.push('', '</details>', '');
}
md.push('<!-- difficulty -->', '| Table | Meaning | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 |', '| --- | --- |' + ' ---: |'.repeat(8));
const rw = (a) => D[a] | (D[a + 1] << 8);
for (const [name, what] of Docs.DIFF) md.push(`| \`${name}\` | ${what} | ` + [...Array(8)].map((_, d) => D[$[name] + d]).join(' | ') + ' |');
md.push('| `0x36DC` | Love scene bonus multiplier (doubled when carrying a gift) | ' + [...Array(8)].map((_, d) => rw(0x36dc + d * 2)).join(' | ') + ' |', '');
md.push('<!-- pools -->', '| `difficulty_level & 3` | `level_pool` row (3 draws in 4) | otherwise |', '| ---: | --- | --- |');
const hard = Array.from(D.slice($.level_pool_hard, $.level_pool_hard + 5)).join(', ');
for (let r = 0; r < 4; r++) {
  const row = r < 3 ? Array.from(D.slice($.level_pool + r * 4, $.level_pool + r * 4 + 4)).join(', ') : '(never used)';
  md.push(`| ${r} | ${row} | \`level_pool_hard\`: ${hard} |`);
}
md.push('', '<!-- bonuses -->', '| Room | Base bonus | Time bonus (t = ticks since entering, 18.2 per second) |', '| --- | ---: | --- |');
for (let l = 2; l <= 7; l++) {
  const p = rw(0x36cc + l * 2);
  const base = Number(Array.from(D.slice(p, p + 7)).join(''));
  const time = l === 7 ? '(10,800 − t) ÷ 2, t counted from the start of the game or the last love scene; then × multiplier'
    : l === 6 ? '2,700 − t' : '2 × (1,350 − t)';
  md.push(`| ${Docs.SCREENS[l + 1]} | ${base.toLocaleString('en')} | ${time} |`);
}
fs.mkdirSync(path.join(__dirname, 'out'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'out', 'readme-tables.md'), md.join('\n') + '\n');
console.log('tables: tools/out/readme-tables.md');
