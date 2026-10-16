// IBM PC (5150, 4.77 MHz 8088, CGA) model sufficient to run the original CAT.EXE headlessly.
// BIOS services are implemented in JS; hardware interrupts IRQ0 (timer) and IRQ1 (keyboard)
// are raised from the cycle counter. Development tool only.
'use strict';
const path = require('path');
const { CPU, IF } = require('./cpu');
const buildImage = require('../image');
const CGA = require('../../js/cga');

const CPU_HZ = 14318180 / 3;           // 4.77 MHz
const PIT_HZ = 14318180 / 12;          // 1.19 MHz: exactly 4 CPU clocks per PIT clock
const TICK_CYCLES = 65536 * 4;         // BIOS timer tick (18.2 Hz)
const FRAME_CYCLES = 262 * 304;        // CGA frame: 262 lines of 304 CPU clocks
const LOAD_SEG = 0x1000;

// Approximate clocks spent inside IBM PC BIOS services beyond the INT instruction itself
// (estimated from the BIOS listing's instruction counts). Shared with the port (js/game.js).
function biosCost(n, ah) {
  switch (n) {
    case 0x08: return 250;               // timer tick handler, including INT 1Ch
    case 0x1a: return 155;               // TIME_OF_DAY
    case 0x11: return 40;
    case 0x10:
      if (ah === 0x0e) return 1900;      // graphics-mode character: 8 expanded rows
      if (ah === 0x00) return 120000;    // mode set clears 16 KB
      return 180;
  }
  return 0;
}

class PC {
  constructor() {
    this.mem = new Uint8Array(0x100000);
    this.cpu = new CPU(this);
    this.keyQueue = [];
    this.scancode = 0;
    this.irqInService = 0;
    this.nextTimer = TICK_CYCLES;
    this.port61 = 0x4c;
    this.pit = [{ count: 0, latch: -1, rl: 3, phase: 0, mode: 3 }, { count: 0 }, { count: 0, wphase: 0, mode: 3 }];
    this.speakerLog = [];              // [cycle, on(0/1/2), divisor]
    this.colorSelect = 0x20;
    this.crtc = new Uint8Array(18);
    this.crtcIndex = 0;
    this.joystick = false;
    this.rebooted = false;
    this.vram = this.mem.subarray(0xb8000, 0xbc000);
    this.load();
  }
  load() {
    const img = buildImage();
    this.image = img;
    const base = LOAD_SEG << 4;
    this.mem.set(img.ds, base + 0x100);
    this.mem.set(img.cs, base + 0x100 + img.ds.length);
    // relocations: add the load segment to the 9 segment words (they hold 0x0010)
    const csBase = base + 0x7230;
    for (const o of [0x0009, 0x0541, 0x1125, 0x13ed, 0x14b8, 0x1501, 0x2ade, 0x3a98, 0x5c9f]) {
      const v = this.mem[csBase + o] | (this.mem[csBase + o + 1] << 8);
      const nv = (v + LOAD_SEG) & 0xffff;
      this.mem[csBase + o] = nv & 0xff; this.mem[csBase + o + 1] = nv >> 8;
    }
    // IVT: every vector points at a BIOS stub F000:(n*4) handled in JS
    for (let n = 0; n < 256; n++) { this.w16(n * 4, n * 4); this.w16(n * 4 + 2, 0xf000); this.mem[0xf0000 + n * 4] = 0xcf; }
    this.mem[0xffffe] = 0xff;          // ROM ID: PC
    this.w16(0x410, 0x0021);           // equipment: 80x25 colour, 1 floppy... (bits 4-5 = 10)
    this.w16(0x413, 640);
    this.mem[0x449] = 3; this.mem[0x44a] = 80;
    this.mem[0x466] = 0x30;
    const cpu = this.cpu;
    cpu.s[0] = cpu.s[3] = LOAD_SEG - 0x10; // PSP
    cpu.s[2] = LOAD_SEG; cpu.r[4] = 0x100;
    cpu.s[1] = LOAD_SEG + 0x723; cpu.ip = 0;
    this.mem[(LOAD_SEG - 0x10) << 4] = 0xcd; this.mem[((LOAD_SEG - 0x10) << 4) + 1] = 0x20;
    this.DS = LOAD_SEG + 0x10;
    this.CS = LOAD_SEG + 0x723;
  }
  w16(a, v) { this.mem[a] = v & 0xff; this.mem[a + 1] = v >> 8; }
  r16(a) { return this.mem[a] | (this.mem[a + 1] << 8); }
  get ds() { return this.mem.subarray(this.DS << 4, (this.DS << 4) + 0x10000); }
  get ticks() { return this.r16(0x46c); }

  // ---- I/O ports
  pitCounter0() {
    // mode 3, reload 65536: the counter steps by 2 and reloads every half period
    const t = Math.floor(this.cpu.cycles / 4);
    return (65536 - 2 * (t % 32768)) & 0xffff;
  }
  in(port, w) {
    port &= 0xffff;
    switch (port) {
      case 0x40: {
        const p = this.pit[0];
        if (p.latch < 0) p.latch = this.pitCounter0();
        let v;
        if (p.phase === 0) { v = p.latch & 0xff; p.phase = 1; } else { v = p.latch >> 8; p.phase = 0; p.latch = -1; }
        return v;
      }
      case 0x42: return 0;
      case 0x60: return this.scancode;
      case 0x61: return this.port61;
      case 0x62: return 0;
      case 0x201: return this.joystick ? 0xf0 : 0xff;
      case 0x3da: {
        const f = this.cpu.cycles % FRAME_CYCLES;
        const line = Math.floor(f / 304);
        const vs = line >= 224 && line < 240 ? 8 : 0;
        const de = line >= 200 || (f % 304) >= 240 ? 1 : 0;
        return vs | de;
      }
      case 0x3d5: return this.crtc[this.crtcIndex];
      case 0x20: return 0;
      case 0x21: return 0;
    }
    return 0xff;
  }
  out(port, v, w) {
    port &= 0xffff;
    switch (port) {
      case 0x43: {
        const ch = v >> 6;
        if (ch === 0 && (v & 0x30) === 0) { this.pit[0].latch = this.pitCounter0(); this.pit[0].phase = 0; }
        else if (ch === 2) { this.pit[2].wphase = 0; this.pit[2].mode = (v >> 1) & 7; }
        return;
      }
      case 0x42: {
        const p = this.pit[2];
        if (p.wphase === 0) { p.count = (p.count & 0xff00) | v; p.wphase = 1; }
        else { p.count = (p.count & 0xff) | (v << 8); p.wphase = 0; this.logSpeaker(); }
        return;
      }
      case 0x61: this.port61 = v; this.logSpeaker(); return;
      case 0x20: if (v === 0x20) this.irqInService = 0; return;
      case 0x3d9: this.colorSelect = v; return;
      case 0x3d4: this.crtcIndex = v & 0x1f; return;
      case 0x3d5: this.crtc[this.crtcIndex] = v; return;
    }
  }
  logSpeaker() {
    const on = this.port61 & 3;
    this.speakerLog.push([this.cpu.cycles, on, this.pit[2].count]);
    if (this.speakerLog.length > 200000) this.speakerLog.splice(0, 100000);
  }

  // ---- BIOS
  int(n, cpu) {
    const vec = this.r16(n * 4 + 2);
    if (vec !== 0xf000) return false;    // game-installed handler: execute it
    const r = cpu.r;
    const ah = r[0] >> 8, al = r[0] & 0xff;
    cpu.cycles += biosCost(n, ah);
    switch (n) {
      case 0x08:
        this.w16(0x46c, (this.r16(0x46c) + 1) & 0xffff);
        if (this.r16(0x46c) === 0) this.w16(0x46e, this.r16(0x46e) + 1);
        return true;
      case 0x09: this.irqInService = 0; return true;
      case 0x10: return this.int10(cpu, ah, al), true;
      case 0x11: r[0] = this.r16(0x410); return true;
      case 0x12: r[0] = 640; return true;
      case 0x16:
        if (ah === 0 || ah === 0x10) { const k = this.keyQueue.shift(); r[0] = k ? k.ascii | (k.code << 8) : 0; }
        else if (ah === 1) { cpu.setf(0x40, true); }
        return true;
      case 0x1a:
        if (ah === 0) { r[1] = this.r16(0x46e); r[2] = this.r16(0x46c); cpu.setf(0x40, false); r[0] &= 0xff00; }
        return true;
      case 0x19: this.rebooted = true; return true;
    }
    return true;
  }
  int10(cpu, ah, al) {
    const r = cpu.r;
    const bl = r[3] & 0xff, bh = r[3] >> 8;
    switch (ah) {
      case 0x00:
        this.mem[0x449] = al & 0x7f;
        if (!(al & 0x80)) this.vram.fill(0);
        this.mem[0x466] = 0x30; this.colorSelect = 0x30;
        CGA.setCursor(0, 0);
        break;
      case 0x02: CGA.setCursor(r[2] >> 8, r[2] & 0xff); break;
      case 0x03: r[2] = (CGA.state.cursorRow << 8) | CGA.state.cursorCol; r[1] = 0x0607; break;
      case 0x09: for (let i = 0; i < r[1]; i++) CGA.writeChar(al, bl, CGA.state.cursorRow, CGA.state.cursorCol + i, this.vram); break;
      case 0x0b: {
        let p = this.mem[0x466];
        if (bh === 0) p = (p & 0xe0) | (bl & 0x1f);
        else p = (p & 0xdf) | ((bl & 1) << 5);
        this.mem[0x466] = p; this.colorSelect = p;
        break;
      }
      case 0x0e: CGA.teletype(al, bl, this.vram); break;
      case 0x0f: r[0] = (40 << 8) | this.mem[0x449]; r[3] &= 0xff; break;
      case 0x10: break;                  // PCjr/EGA palette registers: not present on a CGA
      default: break;
    }
  }

  // ---- keyboard (XT scancodes)
  key(code, down) { this.keyQueue.push({ code: down ? code : code | 0x80, ascii: 0 }); }

  // ---- run for n CPU clocks
  run(cycles) {
    const cpu = this.cpu;
    const end = cpu.cycles + cycles;
    while (cpu.cycles < end && !this.rebooted) {
      if (cpu.cycles >= this.nextTimer) {
        this.nextTimer += TICK_CYCLES;
        if (cpu.flags & IF) cpu.interrupt(8); else this.pendingTimer = true;
      } else if (this.pendingTimer && (cpu.flags & IF)) {
        this.pendingTimer = false; cpu.interrupt(8);
      }
      if (this.keyQueue.length && !this.irqInService && (cpu.flags & IF) && cpu.cycles >= (this.nextKey || 0)) {
        const k = this.keyQueue.shift();
        this.scancode = k.code;
        this.irqInService = 1;
        this.nextKey = cpu.cycles + 20000;
        cpu.interrupt(9);
      }
      cpu.step();
      if (cpu.s[1] === 0xf000 && cpu.ip === 0xe05b) this.rebooted = true;
    }
  }
  // a display snapshot as RGBA 320x200
  screenshot() {
    const data = new Uint8ClampedArray(320 * 200 * 4);
    CGA.render({ data }, this.vram, this.colorSelect);
    return data;
  }
}

module.exports = { PC, CPU_HZ, PIT_HZ, TICK_CYCLES };
