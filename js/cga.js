// CGA 320x200 4-colour mode: emulated video memory, the colour-select register, the BIOS
// graphics-mode text output, and Alley Cat's own drawing routines (cga.asm) ported line by line.
//
// Video memory layout (B800:0000, 16 KB): even scanlines at 0x0000, odd scanlines at 0x2000,
// 80 bytes per line, 4 pixels per byte, leftmost pixel in bits 7-6.
'use strict';
const CGA = (() => {
  const vram = new Uint8Array(0x4000);

  // 16-colour RGBI palette as shown by an IBM colour monitor (colour 6 is brown).
  const RGBI = [
    0x000000, 0x0000aa, 0x00aa00, 0x00aaaa, 0xaa0000, 0xaa00aa, 0xaa5500, 0xaaaaaa,
    0x555555, 0x5555ff, 0x55ff55, 0x55ffff, 0xff5555, 0xff55ff, 0xffff55, 0xffffff,
  ];

  // Port 0x3D9 colour select: bits 0-3 background, bit 4 bright foreground, bit 5 palette 1.
  const state = { colorSelect: 0x20, cursorRow: 0, cursorCol: 0 };

  function palette(cs = state.colorSelect) {
    const hi = cs & 0x10 ? 8 : 0;
    const p = cs & 0x20 ? [3, 5, 7] : [2, 4, 6];
    return [RGBI[cs & 0x0f], RGBI[p[0] + hi], RGBI[p[1] + hi], RGBI[p[2] + hi]];
  }

  function render(imageData, mem = vram, cs = state.colorSelect) {
    const pal = palette(cs);
    const d = imageData.data;
    let o = 0;
    for (let y = 0; y < 200; y++) {
      const base = (y & 1) * 0x2000 + (y >> 1) * 80;
      for (let xb = 0; xb < 80; xb++) {
        const b = mem[base + xb];
        for (let s = 6; s >= 0; s -= 2) {
          const c = pal[(b >> s) & 3];
          d[o] = c >> 16; d[o + 1] = (c >> 8) & 0xff; d[o + 2] = c & 0xff; d[o + 3] = 255;
          o += 4;
        }
      }
    }
  }

  // ---- BIOS INT 10h text output -------------------------------------------------------------
  // In graphics modes the BIOS draws characters from the 8x8 font in the system ROM. That ROM is
  // not part of the game, so this is a re-entry of the standard IBM PC 8x8 glyphs, 0x20-0x7F.
  const GLYPHS = [
    '0000000000000000', '3078783030003000', '6c6c6c0000000000', '6c6cfe6cfe6c6c00', // space ! " #
    '307cc0780cf83000', '00c6cc183066c600', '386c3876dccc7600', '6060c00000000000', // $ % & '
    '1830606060301800', '6030181818306000', '00663cff3c660000', '003030fc30300000', // ( ) * +
    '0000000000303060', '000000fc00000000', '0000000000303000', '060c183060c08000', // , - . /
    '7cc6cedef6e67c00', '307030303030fc00', '78cc0c3860ccfc00', '78cc0c380ccc7800', // 0 1 2 3
    '1c3c6cccfe0c1e00', 'fcc0f80c0ccc7800', '3860c0f8cccc7800', 'fccc0c1830303000', // 4 5 6 7
    '78cccc78cccc7800', '78cccc7c0c187000', '0030300000303000', '0030300000303060', // 8 9 : ;
    '183060c060301800', '0000fc0000fc0000', '6030180c18306000', '78cc0c1830003000', // < = > ?
    '7cc6dededec07800', '3078ccccfccccc00', 'fc66667c6666fc00', '3c66c0c0c0663c00', // @ A B C
    'f86c6666666cf800', 'fe6268786862fe00', 'fe6268786860f000', '3c66c0c0ce663e00', // D E F G
    'ccccccfccccccc00', '7830303030307800', '1e0c0c0ccccc7800', 'e6666c786c66e600', // H I J K
    'f06060606266fe00', 'c6eefefed6c6c600', 'c6e6f6decec6c600', '386cc6c6c66c3800', // L M N O
    'fc66667c6060f000', '78ccccccdc781c00', 'fc66667c6c66e600', '78cce0701ccc7800', // P Q R S
    'fcb4303030307800', 'ccccccccccccfc00', 'cccccccccc783000', 'c6c6c6d6feeec600', // T U V W
    'c6c66c38386cc600', 'cccccc7830307800', 'fec68c183266fe00', '7860606060607800', // X Y Z [
    'c06030180c060200', '7818181818187800', '10386cc600000000', '00000000000000ff', // \ ] ^ _
    '3030180000000000', '0000780c7ccc7600', 'e060607c6666dc00', '000078ccc0cc7800', // ` a b c
    '1c0c0c7ccccc7600', '000078ccfcc07800', '386c60f06060f000', '000076cccc7c0cf8', // d e f g
    'e0606c766666e600', '3000703030307800', '0c000c0c0ccccc78', 'e060666c786ce600', // h i j k
    '7030303030307800', '0000ccfefed6c600', '0000f8cccccccc00', '000078cccccc7800', // l m n o
    '0000dc66667c60f0', '000076cccc7c0c1e', '0000dc766660f000', '00007cc0780cf800', // p q r s
    '10307c3030341800', '0000cccccccc7600', '0000cccccc783000', '0000c6d6fefe6c00', // t u v w
    '0000c66c386cc600', '0000cccccc7c0cf8', '0000fc983064fc00', '1c3030e030301c00', // x y z {
    '1818180018181800', 'e030301c3030e000', '76dc000000000000', '0010386cc6c6fe00', // | } ~ DEL
  ];
  const FONT = new Uint8Array(128 * 8);
  GLYPHS.forEach((g, i) => { for (let r = 0; r < 8; r++) FONT[(0x20 + i) * 8 + r] = parseInt(g.substr(r * 2, 2), 16); });

  // INT 10h AH=0Eh in a graphics mode: draw the glyph in colour BL (bit 7 = XOR), advance the cursor.
  function teletype(ch, color, mem = vram) {
    ch &= 0xff;
    if (ch === 0x0d) { state.cursorCol = 0; return; }
    if (ch === 0x0a) { if (state.cursorRow < 24) state.cursorRow++; return; }
    if (ch === 0x08) { if (state.cursorCol > 0) state.cursorCol--; return; }
    if (ch === 0x07) return;
    writeChar(ch, color, state.cursorRow, state.cursorCol, mem);
    if (++state.cursorCol >= 40) { state.cursorCol = 0; if (state.cursorRow < 24) state.cursorRow++; }
  }

  function writeChar(ch, color, row, col, mem = vram) {
    const c = color & 3;
    const xor = (color & 0x80) !== 0;
    for (let line = 0; line < 8; line++) {
      const bits = ch < 128 ? FONT[ch * 8 + line] : 0;
      let word = 0;
      for (let b = 0; b < 8; b++) if (bits & (0x80 >> b)) word |= c << (14 - b * 2);
      const y = row * 8 + line;
      const a = (y & 1) * 0x2000 + (y >> 1) * 80 + col * 2;
      if (xor) { mem[a] ^= word >> 8; mem[a + 1] ^= word & 0xff; }
      else { mem[a] = word >> 8; mem[a + 1] = word & 0xff; }
    }
  }

  function setCursor(row, col) { state.cursorRow = row; state.cursorCol = col; }

  // ---- cga.asm --------------------------------------------------------------------------------
  // Addresses into video memory wrap at 16 KB, as the CGA mirrors B800:0000-3FFF.
  const ix = (arr, a) => a & (arr.length === 0x4000 ? 0x3fff : 0xffff);

  // calc_cga_addr: CX = x pixel, DL = y line -> AX = byte offset, CL = (x & 3) * 2.
  // The odd-line constant 0x1FD8 is 0x2000 - 40: odd line y starts at 0x2000 + (y - 1) * 40.
  function calc_cga_addr(cx, dl) {
    let ax = (dl & 0xff) * 0x28;
    if (dl & 1) ax += 0x1fd8;
    ax = (ax + ((cx & 0xffff) >> 2)) & 0xffff;
    return { ax, cl: (cx & 3) << 1 };
  }

  // Moves DI to the next scanline after one row of `wordsPerRow` words.
  function nextLine(di, wordsPerRow) {
    di = (di - wordsPerRow * 2) & 0xffff;
    di ^= 0x2000;
    if (!(di & 0x2000)) di = (di + 0x50) & 0xffff;
    return di;
  }

  // blit_to_cga: CX = rows<<8 | words per row; copies DS:SI to ES:DI with interlaced stepping.
  function blit_to_cga(src, si, dst, di, cx) {
    const w = cx & 0xff;
    let h = (cx >> 8) & 0xff;
    do {
      for (let i = 0; i < w * 2; i++) { dst[ix(dst, di)] = src[ix(src, si)]; di++; si++; }
      di = nextLine(di, w);
      h = (h - 1) & 0xff;
    } while (h);
    return si & 0xffff;
  }

  // save_from_cga: the reverse, interlaced DS:SI to a linear buffer at ES:DI.
  function save_from_cga(src, si, dst, di, cx) {
    const w = cx & 0xff;
    let h = (cx >> 8) & 0xff;
    do {
      for (let i = 0; i < w * 2; i++) { dst[ix(dst, di)] = src[ix(src, si)]; di++; si++; }
      si = nextLine(si, w);
      h = (h - 1) & 0xff;
    } while (h);
    return di & 0xffff;
  }

  // blit_transparent: draws sprite words over the background; colour-0 pixels let the background
  // through. The background words are first saved to DS:BP (a save-under buffer).
  const PIXEL_MASKS = [0x00c0, 0x0030, 0x000c, 0x0003, 0xc000, 0x3000, 0x0c00, 0x0300];
  function blit_transparent(src, si, dst, di, cx, bpArr, bp) {
    const w = cx & 0xff;
    let h = (cx >> 8) & 0xff;
    do {
      for (let i = 0; i < w; i++) {
        const a = ix(dst, di);
        const bg = dst[a] | (dst[ix(dst, di + 1)] << 8);
        bpArr[bp & 0xffff] = bg & 0xff; bpArr[(bp + 1) & 0xffff] = bg >> 8;
        const spr = src[si & 0xffff] | (src[(si + 1) & 0xffff] << 8);
        let mask = spr;
        for (const m of PIXEL_MASKS) if (!(spr & m)) mask |= m;
        const v = (mask & bg) | spr;
        dst[a] = v & 0xff; dst[ix(dst, di + 1)] = v >> 8;
        di += 2; si += 2; bp += 2;
      }
      di = nextLine(di, w);
      h = (h - 1) & 0xff;
    } while (h);
    return { si: si & 0xffff, bp: bp & 0xffff };
  }

  // blit_masked: ANDs the sprite words into the background, saving the background to DS:BP.
  function blit_masked(src, si, dst, di, cx, bpArr, bp) {
    const w = cx & 0xff;
    let h = (cx >> 8) & 0xff;
    do {
      for (let i = 0; i < w * 2; i++) {
        const a = ix(dst, di);
        bpArr[bp & 0xffff] = dst[a];
        dst[a] = src[si & 0xffff] & dst[a];
        di++; si++; bp++;
      }
      di = nextLine(di, w);
      h = (h - 1) & 0xff;
    } while (h);
    return { si: si & 0xffff, bp: bp & 0xffff };
  }

  // copy_with_stride: CX = rows<<8 | words; each row copies `words` words, then the source row
  // pointer advances by AL*2 bytes (not by the row length). The destination is linear.
  function copy_with_stride(src, si, dst, di, cx, al) {
    const w = cx & 0xff;
    let h = (cx >> 8) & 0xff;
    const step = (al << 1) & 0xff;
    let srow = si;
    do {
      si = srow;
      for (let i = 0; i < w * 2; i++) { dst[ix(dst, di)] = src[ix(src, si)]; di++; si++; }
      srow = (srow + step) & 0xffff;
      h = (h - 1) & 0xff;
    } while (h);
    return { si: srow, di: di & 0xffff };
  }

  return { vram, state, RGBI, FONT, palette, render, teletype, writeChar, setCursor,
    calc_cga_addr, nextLine, blit_to_cga, save_from_cga, blit_transparent, blit_masked, copy_with_stride };
})();
if (typeof module !== 'undefined') module.exports = CGA;
