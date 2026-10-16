// Per-routine cycle profile of the original running in the reference emulator. Tracks near
// CALL/RET pairs and reports exclusive (self) clocks per call, which the port uses as costs.
//   node tools/emu/profile.js [seconds] [level]   (level: force every room pick to this level)
'use strict';
const fs = require('fs');
const path = require('path');
const { PC, CPU_HZ } = require('./pc');

const syms = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'out', 'code_syms.json'), 'utf8'));
const byOff = {};
for (const [k, v] of Object.entries(syms)) if (!(v in byOff) || !/^lab_/.test(k)) byOff[v] = k;

function profile(seconds, level) {
  const pc = new PC();
  const cpu = pc.cpu;
  const stats = {};
  const stack = [];
  const mem = pc.mem;
  const csBase = () => cpu.s[1] << 4;
  let rng = 12345;
  const rand = () => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng / 0x7fffffff; };
  const keys = [0x48, 0x4d, 0x50, 0x4b, 0x38, 0x49, 0x47];
  const script = [[4, 0x39], [6, 0x31], [8, 0x25], [10, 0x39]];
  let held = null, nextInput = 11 * CPU_HZ;
  const end = seconds * CPU_HZ;
  const dsb = pc.DS << 4;
  if (level !== undefined) {
    for (let i = 0; i < 12; i++) mem[dsb + 0x421 + i] = level;
    for (let i = 0; i < 5; i++) mem[dsb + 0x42d + i] = level;
  }
  const origStep = cpu.step.bind(cpu);
  cpu.step = function () {
    if (cpu.s[1] === pc.CS) {
      const a = csBase() + cpu.ip;
      const op = mem[a];
      if (op === 0xe8) {
        const d = mem[a + 1] | (mem[a + 2] << 8);
        const t = (cpu.ip + 3 + d) & 0xffff;
        stack.push({ fn: t, start: cpu.cycles, child: 0, sp: (cpu.r[4] - 2) & 0xffff });
      } else if ((op === 0xc3 || op === 0xc2) && stack.length && stack[stack.length - 1].sp === cpu.r[4]) {
        const f = stack.pop();
        origStep();
        const total = cpu.cycles - f.start;
        const self = total - f.child;
        const s = stats[f.fn] || (stats[f.fn] = { calls: 0, self: 0, total: 0, min: 1e12, max: 0 });
        s.calls++; s.self += self; s.total += total; s.min = Math.min(s.min, self); s.max = Math.max(s.max, self);
        if (stack.length) stack[stack.length - 1].child += total;
        return;
      }
    }
    origStep();
  };
  for (const [t, k] of script) { pc.run(t * CPU_HZ - cpu.cycles); pc.key(k, true); pc.key(k, false); }
  while (cpu.cycles < end) {
    pc.run(Math.min(nextInput, end) - cpu.cycles);
    if (cpu.cycles >= nextInput) {
      if (held !== null) pc.key(held, false);
      held = rand() < 0.8 ? keys[Math.floor(rand() * keys.length)] : null;
      if (held !== null) pc.key(held, true);
      nextInput = cpu.cycles + Math.floor((0.1 + rand() * 0.6) * CPU_HZ);
    }
    if (level !== undefined && mem[dsb + 0x4] === 0 && mem[dsb + 0x551] === 0 && rand() < 0.002) mem[dsb + 0x551] = 1;
  }
  return { pc, stats };
}

if (require.main === module) {
  const seconds = parseFloat(process.argv[2] || '60');
  const level = process.argv[3] !== undefined ? parseInt(process.argv[3]) : undefined;
  const { stats } = profile(seconds, level);
  const rows = Object.entries(stats).map(([fn, s]) => ({ name: byOff[fn] || ('sub_' + (+fn).toString(16)), ...s }));
  rows.sort((a, b) => b.self - a.self);
  for (const r of rows) {
    console.log(r.name.padEnd(28), String(r.calls).padStart(8), 'avg self', String(Math.round(r.self / r.calls)).padStart(8),
      'min', String(r.min).padStart(7), 'max', String(r.max).padStart(9), 'avg total', Math.round(r.total / r.calls));
  }
}
module.exports = { profile };
