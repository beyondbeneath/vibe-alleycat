// Runs the original game in the reference emulator with a scripted input list and writes
// screenshots to tools/out/emu-*.png.
//   node tools/emu/run.js "5:shot,6:key=0x31,8:shot"   (times in emulated seconds)
'use strict';
const fs = require('fs');
const path = require('path');
const { PC, CPU_HZ } = require('./pc');
const { encodePNG, scale } = require('../png');

const OUT = path.join(__dirname, '..', 'out');
fs.mkdirSync(OUT, { recursive: true });

function shot(pc, name) {
  const s = scale(320, 200, pc.screenshot(), 2);
  fs.writeFileSync(path.join(OUT, `emu-${name}.png`), encodePNG(s.width, s.height, s.data));
}

function runScript(script) {
  const pc = new PC();
  const events = script.split(',').filter(Boolean).map((e) => {
    const [t, what] = e.split(':');
    return { t: parseFloat(t), what };
  }).sort((a, b) => a.t - b.t);
  let n = 0;
  for (const ev of events) {
    const target = Math.round(ev.t * CPU_HZ);
    if (target > pc.cpu.cycles) pc.run(target - pc.cpu.cycles);
    if (pc.rebooted) { console.log('rebooted at', ev.t); break; }
    const [cmd, arg] = ev.what.split('=');
    if (cmd === 'shot') shot(pc, arg || String(n++).padStart(2, '0') + '-' + ev.t);
    else if (cmd === 'down') pc.key(parseInt(arg), true);
    else if (cmd === 'up') pc.key(parseInt(arg), false);
    else if (cmd === 'key') { pc.key(parseInt(arg), true); pc.key(parseInt(arg), false); }
    console.log(ev.t.toFixed(2), ev.what, 'cs:ip', pc.cpu.s[1].toString(16) + ':' + pc.cpu.ip.toString(16), 'ticks', pc.ticks);
  }
  return pc;
}

module.exports = { runScript, shot };
if (require.main === module) runScript(process.argv[2] || '1:shot,3:shot,6:shot');
