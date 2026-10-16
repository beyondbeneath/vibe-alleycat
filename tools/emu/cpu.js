// Minimal 8086/8088 interpreter used as a reference to run the original CAT.EXE headlessly.
// It is a development tool only (timing studies, screenshots, differential tests of the JS port).
// Cycle counts are approximations of 8088 timings: execution cycles from the Intel tables plus a
// simple bus model (4 clocks per byte of instruction fetch / data transfer, whichever is larger).
'use strict';

const CF = 0x001, PF = 0x004, AF = 0x010, ZF = 0x040, SF = 0x080, TF = 0x100, IF = 0x200, DF = 0x400, OF = 0x800;
const parity = new Uint8Array(256);
for (let i = 0; i < 256; i++) { let p = 0; for (let b = 0; b < 8; b++) p ^= (i >> b) & 1; parity[i] = p ? 0 : PF; }

class CPU {
  constructor(bus) {
    this.bus = bus;           // { mem: Uint8Array(1MB), in(port, w), out(port, val, w), int(n) -> bool handled }
    this.mem = bus.mem;
    this.r = new Uint16Array(8);   // AX CX DX BX SP BP SI DI
    this.s = new Uint16Array(4);   // ES CS SS DS
    this.ip = 0;
    this.flags = 0xf002;
    this.cycles = 0;
    this.halted = false;
    this.seg = -1;          // segment override
    this.rep = 0;           // 0, 0xf2, 0xf3
  }
  // ---- memory
  rb(seg, off) { return this.mem[((seg << 4) + (off & 0xffff)) & 0xfffff]; }
  rw(seg, off) { return this.rb(seg, off) | (this.rb(seg, off + 1) << 8); }
  wb(seg, off, v) { const a = ((seg << 4) + (off & 0xffff)) & 0xfffff; if (a < 0xf0000) this.mem[a] = v; if (this.bus.onWrite && a >= 0xb8000 && a < 0xbc000) this.bus.onWrite(a); }
  ww(seg, off, v) { this.wb(seg, off, v & 0xff); this.wb(seg, off + 1, (v >> 8) & 0xff); }
  fetchb() { const v = this.rb(this.s[1], this.ip); this.ip = (this.ip + 1) & 0xffff; this.ilen++; return v; }
  fetchw() { const v = this.fetchb(); return v | (this.fetchb() << 8); }
  push(v) { this.r[4] = (this.r[4] - 2) & 0xffff; this.ww(this.s[2], this.r[4], v); }
  pop() { const v = this.rw(this.s[2], this.r[4]); this.r[4] = (this.r[4] + 2) & 0xffff; return v; }
  // ---- 8-bit register access: 0 AL 1 CL 2 DL 3 BL 4 AH 5 CH 6 DH 7 BH
  getr8(i) { return i < 4 ? this.r[i] & 0xff : this.r[i - 4] >> 8; }
  setr8(i, v) { if (i < 4) this.r[i] = (this.r[i] & 0xff00) | (v & 0xff); else this.r[i - 4] = (this.r[i - 4] & 0xff) | ((v & 0xff) << 8); }
  // ---- ModR/M
  modrm() {
    const b = this.fetchb();
    const mod = b >> 6, reg = (b >> 3) & 7, rm = b & 7;
    this.m_mod = mod; this.m_reg = reg; this.m_rm = rm;
    if (mod === 3) { this.ea = -1; return; }
    let off = 0, seg = 3, ec = 0;
    const r = this.r;
    switch (rm) {
      case 0: off = r[3] + r[6]; ec = 7; break;
      case 1: off = r[3] + r[7]; ec = 8; break;
      case 2: off = r[5] + r[6]; seg = 2; ec = 8; break;
      case 3: off = r[5] + r[7]; seg = 2; ec = 7; break;
      case 4: off = r[6]; ec = 5; break;
      case 5: off = r[7]; ec = 5; break;
      case 6: if (mod === 0) { off = this.fetchw(); ec = 6; } else { off = r[5]; seg = 2; ec = 5; } break;
      case 7: off = r[3]; ec = 5; break;
    }
    if (mod === 1) { const d = this.fetchb(); off += (d << 24) >> 24; ec += 4; }
    else if (mod === 2) { off += this.fetchw(); ec += 4; }
    this.ea = off & 0xffff;
    this.easeg = this.seg >= 0 ? this.s[this.seg] : this.s[seg];
    this.ecyc = ec + (this.seg >= 0 ? 2 : 0);
  }
  rmb() { if (this.ea < 0) return this.getr8(this.m_rm); this.mb += 1; return this.rb(this.easeg, this.ea); }
  rmw() { if (this.ea < 0) return this.r[this.m_rm]; this.mb += 2; return this.rw(this.easeg, this.ea); }
  wrmb(v) { if (this.ea < 0) this.setr8(this.m_rm, v); else { this.mb += 1; this.wb(this.easeg, this.ea, v); } }
  wrmw(v) { if (this.ea < 0) this.r[this.m_rm] = v & 0xffff; else { this.mb += 2; this.ww(this.easeg, this.ea, v); } }
  dseg() { return this.seg >= 0 ? this.s[this.seg] : this.s[3]; }
  // ---- flags
  setf(mask, on) { if (on) this.flags |= mask; else this.flags &= ~mask; }
  szp(v, w) {
    let f = this.flags & ~(ZF | SF | PF);
    const m = w ? 0xffff : 0xff;
    v &= m;
    if (!v) f |= ZF;
    if (v & (w ? 0x8000 : 0x80)) f |= SF;
    f |= parity[v & 0xff];
    this.flags = f;
  }
  alu(op, a, b, w) {
    const m = w ? 0xffff : 0xff, sb = w ? 0x8000 : 0x80;
    let r, c = this.flags & CF;
    switch (op) {
      case 0: case 2: { // ADD ADC
        const ci = op === 2 ? c : 0;
        r = a + b + ci;
        this.setf(CF, r > m);
        this.setf(AF, ((a ^ b ^ r) & 0x10) !== 0);
        this.setf(OF, ((a ^ r) & (b ^ r) & sb) !== 0);
        r &= m; this.szp(r, w); return r;
      }
      case 5: case 3: case 7: { // SUB SBB CMP
        const ci = op === 3 ? c : 0;
        r = a - b - ci;
        this.setf(CF, r < 0);
        this.setf(AF, ((a ^ b ^ r) & 0x10) !== 0);
        this.setf(OF, ((a ^ b) & (a ^ r) & sb) !== 0);
        r &= m; this.szp(r, w); return op === 7 ? a : r;
      }
      case 1: r = a | b; break;
      case 4: r = a & b; break;
      case 6: r = a ^ b; break;
    }
    this.flags &= ~(CF | OF | AF);
    this.szp(r, w);
    return r & m;
  }
  incdec(v, dec, w) {
    const m = w ? 0xffff : 0xff, sb = w ? 0x8000 : 0x80;
    const r = (dec ? v - 1 : v + 1) & m;
    this.setf(OF, dec ? v === sb : r === sb);
    this.setf(AF, dec ? (v & 0xf) === 0 : (r & 0xf) === 0);
    this.szp(r, w);
    return r;
  }
  shift(op, v, cnt, w) {
    const bits = w ? 16 : 8, m = w ? 0xffff : 0xff, sb = w ? 0x8000 : 0x80;
    if (cnt === 0) return v;
    let cf = this.flags & CF ? 1 : 0;
    for (let i = 0; i < cnt; i++) {
      switch (op) {
        case 0: cf = (v & sb) ? 1 : 0; v = ((v << 1) | cf) & m; break;              // ROL
        case 1: cf = v & 1; v = (v >> 1) | (cf ? sb : 0); break;                    // ROR
        case 2: { const n = (v & sb) ? 1 : 0; v = ((v << 1) | cf) & m; cf = n; break; } // RCL
        case 3: { const n = v & 1; v = (v >> 1) | (cf ? sb : 0); cf = n; break; }   // RCR
        case 4: case 6: cf = (v & sb) ? 1 : 0; v = (v << 1) & m; break;             // SHL/SAL
        case 5: cf = v & 1; v = v >> 1; break;                                      // SHR
        case 7: cf = v & 1; v = (v >> 1) | (v & sb); break;                         // SAR
      }
    }
    this.setf(CF, cf);
    const msb = (v & sb) !== 0;
    switch (op) {
      case 0: case 2: case 4: case 6: this.setf(OF, msb !== !!cf); break;
      case 1: case 3: this.setf(OF, msb !== !!(v & (sb >> 1))); break;
      case 5: this.setf(OF, cnt === 1 ? false : (this.flags & OF) !== 0); break;
      case 7: this.setf(OF, false); break;
    }
    if (op >= 4) this.szp(v, w);
    return v;
  }
  cond(c) {
    const f = this.flags;
    let r;
    switch (c >> 1) {
      case 0: r = f & OF; break;
      case 1: r = f & CF; break;
      case 2: r = f & ZF; break;
      case 3: r = f & (CF | ZF); break;
      case 4: r = f & SF; break;
      case 5: r = f & PF; break;
      case 6: r = !(f & SF) !== !(f & OF); break;
      case 7: r = (f & ZF) || (!(f & SF) !== !(f & OF)); break;
    }
    r = !!r;
    return c & 1 ? !r : r;
  }
  interrupt(n) {
    if (this.bus.int && this.bus.int(n, this)) return;
    this.push(this.flags);
    this.push(this.s[1]);
    this.push(this.ip);
    this.flags &= ~(IF | TF);
    this.ip = this.rw(0, n * 4);
    this.s[1] = this.rw(0, n * 4 + 2);
  }
  // ---- one instruction; returns clocks used
  step() {
    this.seg = -1; this.rep = 0; this.ilen = 0; this.mb = 0;
    this.startIp = this.ip;
    let c = 0;
    let op;
    for (;;) {
      op = this.fetchb();
      if (op === 0x26 || op === 0x2e || op === 0x36 || op === 0x3e) { this.seg = (op >> 3) & 3; c += 2; continue; }
      if (op === 0xf2 || op === 0xf3) { this.rep = op; c += 2; continue; }
      if (op === 0xf0) continue;
      break;
    }
    c += this.exec(op);
    const busc = 4 * (this.ilen + this.mb);
    c = Math.max(c + 4 * this.mb, busc);
    this.cycles += c;
    return c;
  }
  exec(op) {
    const r = this.r, s = this.s;
    let v, w, t;
    if (op < 0x40 && (op & 7) < 6) {             // ALU ops
      const aop = op >> 3;
      w = op & 1;
      switch (op & 7) {
        case 0: case 1: this.modrm(); {
          const a = w ? this.rmw() : this.rmb(), b = w ? r[this.m_reg] : this.getr8(this.m_reg);
          v = this.alu(aop, a, b, w);
          if (aop !== 7) { w ? this.wrmw(v) : this.wrmb(v); }
          return this.ea < 0 ? 3 : (aop === 7 ? 9 : 16) + this.ecyc;
        }
        case 2: case 3: this.modrm(); {
          const a = w ? r[this.m_reg] : this.getr8(this.m_reg), b = w ? this.rmw() : this.rmb();
          v = this.alu(aop, a, b, w);
          if (aop !== 7) { w ? (r[this.m_reg] = v) : this.setr8(this.m_reg, v); }
          return this.ea < 0 ? 3 : 9 + this.ecyc;
        }
        case 4: v = this.alu(aop, r[0] & 0xff, this.fetchb(), 0); if (aop !== 7) this.setr8(0, v); return 4;
        case 5: v = this.alu(aop, r[0], this.fetchw(), 1); if (aop !== 7) r[0] = v; return 4;
      }
    }
    switch (op) {
      case 0x06: case 0x0e: case 0x16: case 0x1e: this.push(s[op >> 3]); this.mb += 2; return 10;
      case 0x07: case 0x17: case 0x1f: s[op >> 3] = this.pop(); this.mb += 2; return 8;
      case 0x27: { // DAA
        let al = r[0] & 0xff; const oc = this.flags & CF;
        if ((al & 0xf) > 9 || (this.flags & AF)) { al += 6; this.flags |= AF; } else this.flags &= ~AF;
        if (al > 0x9f || oc || (r[0] & 0xff) > 0x99) { al += 0x60; this.flags |= CF; } else this.flags &= ~CF;
        this.setr8(0, al); this.szp(al, 0); return 4;
      }
      case 0x2f: { // DAS
        let al = r[0] & 0xff; const oal = al, oc = this.flags & CF;
        if ((al & 0xf) > 9 || (this.flags & AF)) { al -= 6; this.flags |= AF; } else this.flags &= ~AF;
        if (oal > 0x99 || oc) { al -= 0x60; this.flags |= CF; } else this.flags &= ~CF;
        this.setr8(0, al); this.szp(al, 0); return 4;
      }
      case 0x37: { // AAA
        let al = r[0] & 0xff, ah = r[0] >> 8;
        if ((al & 0xf) > 9 || (this.flags & AF)) { al += 6; ah++; this.flags |= AF | CF; } else this.flags &= ~(AF | CF);
        r[0] = ((ah & 0xff) << 8) | (al & 0xf); return 8;
      }
      case 0x3f: { // AAS
        let al = r[0] & 0xff, ah = r[0] >> 8;
        if ((al & 0xf) > 9 || (this.flags & AF)) { al -= 6; ah--; this.flags |= AF | CF; } else this.flags &= ~(AF | CF);
        r[0] = ((ah & 0xff) << 8) | (al & 0xf); return 8;
      }
    }
    if (op >= 0x40 && op < 0x50) { const i = op & 7; r[i] = this.incdec(r[i], op >= 0x48, 1); return 3; }
    if (op >= 0x50 && op < 0x58) { const i = op & 7; this.push(i === 4 ? (r[4] - 2) & 0xffff : r[i]); this.mb += 2; return 11; }
    if (op >= 0x58 && op < 0x60) { r[op & 7] = this.pop(); this.mb += 2; return 8; }
    if (op >= 0x70 && op < 0x80) { const d = (this.fetchb() << 24) >> 24; if (this.cond(op & 0xf)) { this.ip = (this.ip + d) & 0xffff; return 16; } return 4; }
    if (op >= 0x91 && op < 0x98) { const i = op & 7; t = r[0]; r[0] = r[i]; r[i] = t; return 3; }
    if (op >= 0xb0 && op < 0xb8) { this.setr8(op & 7, this.fetchb()); return 4; }
    if (op >= 0xb8 && op < 0xc0) { r[op & 7] = this.fetchw(); return 4; }
    switch (op) {
      case 0x80: case 0x81: case 0x82: case 0x83: {
        this.modrm(); w = op & 1;
        const a = w ? this.rmw() : this.rmb();
        let b = op === 0x81 ? this.fetchw() : this.fetchb();
        if (op === 0x83) b = ((b << 24) >> 24) & 0xffff;
        v = this.alu(this.m_reg, a, b, w);
        if (this.m_reg !== 7) { w ? this.wrmw(v) : this.wrmb(v); }
        return this.ea < 0 ? 4 : (this.m_reg === 7 ? 10 : 17) + this.ecyc;
      }
      case 0x84: case 0x85: this.modrm(); w = op & 1;
        this.alu(4, w ? this.rmw() : this.rmb(), w ? r[this.m_reg] : this.getr8(this.m_reg), w);
        return this.ea < 0 ? 3 : 9 + this.ecyc;
      case 0x86: case 0x87: this.modrm(); w = op & 1;
        if (w) { t = this.rmw(); this.wrmw(r[this.m_reg]); r[this.m_reg] = t; }
        else { t = this.rmb(); this.wrmb(this.getr8(this.m_reg)); this.setr8(this.m_reg, t); }
        return this.ea < 0 ? 4 : 17 + this.ecyc;
      case 0x88: this.modrm(); this.wrmb(this.getr8(this.m_reg)); return this.ea < 0 ? 2 : 9 + this.ecyc;
      case 0x89: this.modrm(); this.wrmw(r[this.m_reg]); return this.ea < 0 ? 2 : 9 + this.ecyc;
      case 0x8a: this.modrm(); this.setr8(this.m_reg, this.rmb()); return this.ea < 0 ? 2 : 8 + this.ecyc;
      case 0x8b: this.modrm(); r[this.m_reg] = this.rmw(); return this.ea < 0 ? 2 : 8 + this.ecyc;
      case 0x8c: this.modrm(); this.wrmw(s[this.m_reg & 3]); return this.ea < 0 ? 2 : 9 + this.ecyc;
      case 0x8d: this.modrm(); r[this.m_reg] = this.ea; return 2 + this.ecyc;
      case 0x8e: this.modrm(); s[this.m_reg & 3] = this.rmw(); return this.ea < 0 ? 2 : 8 + this.ecyc;
      case 0x8f: this.modrm(); this.wrmw(this.pop()); return 17 + (this.ecyc || 0);
      case 0x90: return 3;
      case 0x98: r[0] = ((r[0] & 0xff) << 24 >> 24) & 0xffff; return 2;
      case 0x99: r[2] = r[0] & 0x8000 ? 0xffff : 0; return 5;
      case 0x9a: { const o = this.fetchw(), sg = this.fetchw(); this.push(s[1]); this.push(this.ip); s[1] = sg; this.ip = o; this.mb += 4; return 28; }
      case 0x9b: return 3;
      case 0x9c: this.push(this.flags | 0xf002); this.mb += 2; return 10;
      case 0x9d: this.flags = (this.pop() & 0x0fd5) | 0xf002; this.mb += 2; return 8;
      case 0x9e: this.flags = (this.flags & 0xff00) | ((r[0] >> 8) & 0xd5) | 2; return 4;
      case 0x9f: this.setr8(4, this.flags & 0xff); return 4;
      case 0xa0: this.setr8(0, this.rb(this.dseg(), this.fetchw())); this.mb += 1; return 10;
      case 0xa1: r[0] = this.rw(this.dseg(), this.fetchw()); this.mb += 2; return 10;
      case 0xa2: this.wb(this.dseg(), this.fetchw(), r[0] & 0xff); this.mb += 1; return 10;
      case 0xa3: this.ww(this.dseg(), this.fetchw(), r[0]); this.mb += 2; return 10;
      case 0xa4: case 0xa5: case 0xa6: case 0xa7: case 0xaa: case 0xab: case 0xac: case 0xad: case 0xae: case 0xaf:
        return this.string(op);
      case 0xa8: this.alu(4, r[0] & 0xff, this.fetchb(), 0); return 4;
      case 0xa9: this.alu(4, r[0], this.fetchw(), 1); return 4;
      case 0xc2: { const n = this.fetchw(); this.ip = this.pop(); r[4] = (r[4] + n) & 0xffff; this.mb += 2; return 20; }
      case 0xc3: this.ip = this.pop(); this.mb += 2; return 16;
      case 0xc4: case 0xc5: this.modrm();
        r[this.m_reg] = this.rw(this.easeg, this.ea); s[op === 0xc4 ? 0 : 3] = this.rw(this.easeg, this.ea + 2); this.mb += 4;
        return 16 + this.ecyc;
      case 0xc6: this.modrm(); this.wrmb(this.fetchb()); return this.ea < 0 ? 4 : 10 + this.ecyc;
      case 0xc7: this.modrm(); this.wrmw(this.fetchw()); return this.ea < 0 ? 4 : 10 + this.ecyc;
      case 0xca: { const n = this.fetchw(); this.ip = this.pop(); s[1] = this.pop(); r[4] = (r[4] + n) & 0xffff; this.mb += 4; return 25; }
      case 0xcb: this.ip = this.pop(); s[1] = this.pop(); this.mb += 4; return 26;
      case 0xcc: this.interrupt(3); return 52;
      case 0xcd: this.interrupt(this.fetchb()); this.mb += 6; return 51;
      case 0xce: if (this.flags & OF) { this.interrupt(4); return 53; } return 4;
      case 0xcf: this.ip = this.pop(); s[1] = this.pop(); this.flags = (this.pop() & 0x0fd5) | 0xf002; this.mb += 6; return 24;
      case 0xd0: case 0xd1: case 0xd2: case 0xd3: {
        this.modrm(); w = op & 1;
        const cnt = op & 2 ? r[1] & 0xff : 1;
        v = this.shift(this.m_reg, w ? this.rmw() : this.rmb(), cnt, w);
        w ? this.wrmw(v) : this.wrmb(v);
        return (op & 2 ? 8 + 4 * cnt : 2) + (this.ea < 0 ? 0 : 13 + this.ecyc);
      }
      case 0xd4: { const b = this.fetchb(); const al = r[0] & 0xff; r[0] = ((Math.floor(al / b) & 0xff) << 8) | (al % b); this.szp(r[0] & 0xff, 0); return 83; }
      case 0xd5: { const b = this.fetchb(); const v2 = ((r[0] & 0xff) + (r[0] >> 8) * b) & 0xff; r[0] = v2; this.szp(v2, 0); return 60; }
      case 0xd7: this.setr8(0, this.rb(this.dseg(), r[3] + (r[0] & 0xff))); this.mb += 1; return 11;
      case 0xe0: case 0xe1: case 0xe2: case 0xe3: {
        const d = (this.fetchb() << 24) >> 24;
        let jump;
        if (op === 0xe3) jump = r[1] === 0;
        else {
          r[1] = (r[1] - 1) & 0xffff;
          jump = r[1] !== 0 && (op === 0xe2 || (op === 0xe1 ? (this.flags & ZF) : !(this.flags & ZF)));
        }
        if (jump) { this.ip = (this.ip + d) & 0xffff; return 17; }
        return 5;
      }
      case 0xe4: this.setr8(0, this.bus.in(this.fetchb(), 0, this)); return 10;
      case 0xe5: r[0] = this.bus.in(this.fetchb(), 1, this); return 10;
      case 0xe6: this.bus.out(this.fetchb(), r[0] & 0xff, 0, this); return 10;
      case 0xe7: this.bus.out(this.fetchb(), r[0], 1, this); return 10;
      case 0xe8: { const d = this.fetchw(); this.push(this.ip); this.ip = (this.ip + d) & 0xffff; this.mb += 2; return 19; }
      case 0xe9: { const d = this.fetchw(); this.ip = (this.ip + d) & 0xffff; return 15; }
      case 0xea: { const o = this.fetchw(), sg = this.fetchw(); this.ip = o; s[1] = sg; return 15; }
      case 0xeb: { const d = (this.fetchb() << 24) >> 24; this.ip = (this.ip + d) & 0xffff; return 15; }
      case 0xec: this.setr8(0, this.bus.in(r[2], 0, this)); return 8;
      case 0xed: r[0] = this.bus.in(r[2], 1, this); return 8;
      case 0xee: this.bus.out(r[2], r[0] & 0xff, 0, this); return 8;
      case 0xef: this.bus.out(r[2], r[0], 1, this); return 8;
      case 0xf4: this.halted = true; return 2;
      case 0xf5: this.flags ^= CF; return 2;
      case 0xf6: case 0xf7: return this.grp3(op & 1);
      case 0xf8: this.flags &= ~CF; return 2;
      case 0xf9: this.flags |= CF; return 2;
      case 0xfa: this.flags &= ~IF; return 2;
      case 0xfb: this.flags |= IF; return 2;
      case 0xfc: this.flags &= ~DF; return 2;
      case 0xfd: this.flags |= DF; return 2;
      case 0xfe: case 0xff: return this.grp45(op & 1);
    }
    throw new Error(`unimplemented opcode ${op.toString(16)} at ${this.s[1].toString(16)}:${this.startIp.toString(16)}`);
  }
  grp3(w) {
    const r = this.r;
    this.modrm();
    const v = w ? this.rmw() : this.rmb();
    const mc = this.ea < 0 ? 0 : this.ecyc + 6;
    switch (this.m_reg) {
      case 0: case 1: this.alu(4, v, w ? this.fetchw() : this.fetchb(), w); return 5 + mc;
      case 2: w ? this.wrmw(~v) : this.wrmb(~v); return 3 + mc;
      case 3: { const res = this.alu(5, 0, v, w); w ? this.wrmw(res) : this.wrmb(res); this.setf(CF, v !== 0); return 3 + mc; }
      case 4: case 5: { // MUL IMUL
        let a, b, res;
        if (this.m_reg === 4) { a = w ? r[0] : r[0] & 0xff; b = v; res = a * b; }
        else { a = w ? (r[0] << 16 >> 16) : (r[0] << 24 >> 24); b = w ? (v << 16 >> 16) : (v << 24 >> 24); res = a * b; }
        if (w) { r[0] = res & 0xffff; r[2] = (res >>> 16) & 0xffff; const hi = this.m_reg === 4 ? r[2] !== 0 : (res < -32768 || res > 32767); this.setf(CF | OF, hi); }
        else { r[0] = res & 0xffff; const hi = this.m_reg === 4 ? (r[0] >> 8) !== 0 : (res < -128 || res > 127); this.setf(CF | OF, hi); }
        return (w ? 118 : 70) + mc;
      }
      case 6: case 7: { // DIV IDIV
        if (w) {
          let num, den = v, q, rem;
          if (this.m_reg === 6) { num = r[2] * 65536 + r[0]; if (!den) { this.interrupt(0); return 150; } q = Math.floor(num / den); rem = num % den; if (q > 0xffff) { this.interrupt(0); return 150; } }
          else { num = (r[2] << 16) | r[0]; den = den << 16 >> 16; if (!den) { this.interrupt(0); return 150; } q = Math.trunc(num / den); rem = num % den; if (q > 32767 || q < -32768) { this.interrupt(0); return 150; } }
          r[0] = q & 0xffff; r[2] = rem & 0xffff;
        } else {
          let num, den = v, q, rem;
          if (this.m_reg === 6) { num = r[0]; if (!den) { this.interrupt(0); return 80; } q = Math.floor(num / den); rem = num % den; if (q > 0xff) { this.interrupt(0); return 80; } }
          else { num = r[0] << 16 >> 16; den = den << 24 >> 24; if (!den) { this.interrupt(0); return 80; } q = Math.trunc(num / den); rem = num % den; if (q > 127 || q < -128) { this.interrupt(0); return 80; } }
          r[0] = ((rem & 0xff) << 8) | (q & 0xff);
        }
        return (w ? 144 : 80) + mc;
      }
    }
  }
  grp45(w) {
    const r = this.r, s = this.s;
    this.modrm();
    const mc = this.ea < 0 ? 0 : this.ecyc;
    switch (this.m_reg) {
      case 0: case 1: { const v = w ? this.rmw() : this.rmb(); const res = this.incdec(v, this.m_reg === 1, w); w ? this.wrmw(res) : this.wrmb(res); return this.ea < 0 ? 3 : 15 + mc; }
      case 2: { const t = this.rmw(); this.push(this.ip); this.ip = t; this.mb += 2; return this.ea < 0 ? 16 : 21 + mc; }
      case 3: { const o = this.rw(this.easeg, this.ea), sg = this.rw(this.easeg, this.ea + 2); this.push(s[1]); this.push(this.ip); this.ip = o; s[1] = sg; this.mb += 8; return 37 + mc; }
      case 4: this.ip = this.rmw(); return this.ea < 0 ? 11 : 18 + mc;
      case 5: { const o = this.rw(this.easeg, this.ea), sg = this.rw(this.easeg, this.ea + 2); this.ip = o; s[1] = sg; this.mb += 4; return 24 + mc; }
      case 6: this.push(this.rmw()); this.mb += 2; return this.ea < 0 ? 11 : 16 + mc;
    }
    throw new Error('bad grp5');
  }
  string(op) {
    const r = this.r, s = this.s;
    const w = op & 1, d = this.flags & DF ? -(w + 1) : (w + 1);
    const srcSeg = this.dseg();
    let n = 0;
    const once = () => {
      switch (op) {
        case 0xa4: this.wb(s[0], r[7], this.rb(srcSeg, r[6])); r[6] += d; r[7] += d; this.mb += 2; return 18;
        case 0xa5: this.ww(s[0], r[7], this.rw(srcSeg, r[6])); r[6] += d; r[7] += d; this.mb += 4; return 26;
        case 0xa6: this.alu(7, this.rb(srcSeg, r[6]), this.rb(s[0], r[7]), 0); r[6] += d; r[7] += d; this.mb += 2; return 22;
        case 0xa7: this.alu(7, this.rw(srcSeg, r[6]), this.rw(s[0], r[7]), 1); r[6] += d; r[7] += d; this.mb += 4; return 30;
        case 0xaa: this.wb(s[0], r[7], r[0] & 0xff); r[7] += d; this.mb += 1; return 11;
        case 0xab: this.ww(s[0], r[7], r[0]); r[7] += d; this.mb += 2; return 15;
        case 0xac: this.setr8(0, this.rb(srcSeg, r[6])); r[6] += d; this.mb += 1; return 12;
        case 0xad: r[0] = this.rw(srcSeg, r[6]); r[6] += d; this.mb += 2; return 16;
        case 0xae: this.alu(7, r[0] & 0xff, this.rb(s[0], r[7]), 0); r[7] += d; this.mb += 1; return 15;
        case 0xaf: this.alu(7, r[0], this.rw(s[0], r[7]), 1); r[7] += d; this.mb += 2; return 19;
      }
    };
    if (!this.rep) return once();
    let c = 9;
    const cmp = op === 0xa6 || op === 0xa7 || op === 0xae || op === 0xaf;
    while (r[1] !== 0) {
      c += once() - (op === 0xa4 || op === 0xa5 ? 1 : 0);
      r[1]--;
      n++;
      if (cmp) { const z = (this.flags & ZF) !== 0; if (this.rep === 0xf3 ? !z : z) break; }
    }
    return c;
  }
}

module.exports = { CPU, CF, PF, AF, ZF, SF, IF, DF, OF };
