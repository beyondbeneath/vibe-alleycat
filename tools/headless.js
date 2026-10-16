// Runs the port without a browser, on its virtual clock and as fast as possible.
//   node tools/headless.js "2:shot,3:key=0x1c,5:hold=0x4d/0.5,6:shot"   times in emulated seconds
//   node tools/headless.js random 300 [seed]                             random keys for 300 s
//   ROOMS=1,2,3 node tools/headless.js random 300                         ... sending the cat into those rooms
// Commands: shot[=name], down=sc, up=sc, key=sc (held 0.1 s), hold=sc/seconds.
// Snapshots go to tools/out/port-*.png.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { encodePNG, scale } = require('./png');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });

// patch: optional (file, source) => source, for test instrumentation.
function load(patch) {
  const store = {};
  let seed = Number(process.env.SEED || 12345) >>> 0;
  const math = Object.create(Math);
  math.random = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 4294967296; };
  const ctx = {
    console, atob, setTimeout, clearTimeout, performance: { now: () => 0 }, Math: math,
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  for (const f of ['js/assets.js', 'js/cga.js', 'js/game.js']) {
    let src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    if (patch) src = patch(f, src);
    vm.runInContext(src, ctx, { filename: f });
  }
  vm.runInContext('this.Game = Game; this.CGA = CGA;', ctx);
  return ctx;
}

// setup: optional (ctx) => void, run before the game starts.
function makeRunner(patch, setup) {
  const ctx = load(patch);
  const { Game, CGA } = ctx;
  if (setup) setup(ctx);
  let until = 0, wake = null, error = null;
  Game.sleeper = () => new Promise((r) => {
    if (Game.clock < until) r(); else wake = r;
  });
  const runUntil = (sec) => new Promise((resolve, reject) => {
    until = Math.round(sec * Game.cpuHz);
    const check = () => {
      if (error) return reject(error);
      if (Game.clock >= until) return resolve();
      if (wake) { const w = wake; wake = null; w(); }
      setImmediate(check);
    };
    check();
  });
  const done = Game.start();
  done.catch((e) => { error = e; });
  const img = { data: new Uint8ClampedArray(320 * 200 * 4) };
  const shot = (name) => {
    CGA.render(img);
    const s = scale(320, 200, img.data, 2);
    fs.writeFileSync(path.join(OUT, `port-${name}.png`), encodePNG(s.width, s.height, s.data));
  };
  return { Game, CGA, ctx, runUntil, shot, sec: () => Game.clock / Game.cpuHz };
}

// Test only: makes the next window lead to room n (rewrites the room pools) and ends the alley loop
// the way going in through a window does.
function forceRoom(Game, n) {
  const M = Game.mem, $ = Game.sym;
  for (let i = 0; i < 12; i++) M[$.level_pool + i] = n;
  for (let i = 0; i < 5; i++) M[$.level_pool_hard + i] = n;
  M[$.last_level] = M[$.last_level + 1] = M[$.prev_level] = M[$.prev_level + 1] = 0;
  M[$.force_level7] = n === 7 ? 1 : 0;
  M[$.cat_died] = 1;
}

async function script(text) {
  const r = makeRunner();
  const events = [];
  for (const e of text.split(',').filter(Boolean)) {
    const [t, what] = e.split(':');
    const [cmd, arg = ''] = what.split('=');
    const time = parseFloat(t);
    if (cmd === 'key' || cmd === 'hold') {
      const [sc, dur] = arg.split('/');
      events.push({ t: time, cmd: 'down', arg: sc });
      events.push({ t: time + (dur ? parseFloat(dur) : 0.1), cmd: 'up', arg: sc });
    } else events.push({ t: time, cmd, arg });
  }
  events.sort((a, b) => a.t - b.t);
  let n = 0;
  for (const ev of events) {
    await r.runUntil(ev.t);
    if (ev.cmd === 'shot') r.shot(ev.arg || String(n++).padStart(2, '0') + '-' + ev.t);
    else if (ev.cmd === 'down') r.Game.keyEvent(parseInt(ev.arg), true);
    else if (ev.cmd === 'up') r.Game.keyEvent(parseInt(ev.arg), false);
    else if (ev.cmd === 'room') forceRoom(r.Game, parseInt(ev.arg));
    else if (ev.cmd === 'poke') { const [a, v] = ev.arg.split('/'); r.Game.mem[r.Game.sym[a] ?? parseInt(a)] = parseInt(v); }
    console.log(ev.t.toFixed(2), ev.cmd, ev.arg, 'level', r.Game.mem[r.Game.sym.level_number]);
  }
  r.Game.stop();
}

// Random play: mostly movement and fire, sometimes Enter/Space/menu keys, never the DOS exit.
async function random(seconds, seed) {
  let s = seed >>> 0 || 1;
  const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  const keys = [0x48, 0x50, 0x4b, 0x4d, 0x48, 0x4b, 0x4d, 0x38, 0x1c, 0x39, 0x01, 0x23, 0x14, 0x15, 0x31, 0x25, 0x1e];
  const r = makeRunner();
  const held = new Set();
  // ROOMS=1,2,7: whenever the cat is back in the alley, send it into the next listed room.
  const rooms = (process.env.ROOMS || '').split(',').filter(Boolean).map(Number);
  let t = 0.5, shots = 0, lastShot = 0, nextRoom = 0, lastForce = 0;
  const levels = {};
  while (t < seconds) {
    await r.runUntil(t);
    const lv = r.Game.mem[r.Game.sym.level_number];
    levels[lv] = (levels[lv] || 0) + 1;
    if (rooms.length && lv === 0 && t > 12 && t - lastForce > 3) {
      forceRoom(r.Game, rooms[nextRoom++ % rooms.length]);
      lastForce = t;
    }
    if (held.size && rnd() < 0.5) {
      const k = [...held][Math.floor(rnd() * held.size)];
      r.Game.keyEvent(k, false); held.delete(k);
    } else {
      const k = keys[Math.floor(rnd() * keys.length)];
      if (!held.has(k)) { r.Game.keyEvent(k, true); held.add(k); }
    }
    t += 0.05 + rnd() * 0.4;
    if (t - lastShot > seconds / 12) { r.shot(`rnd-${String(shots++).padStart(2, '0')}-l${lv}`); lastShot = t; }
  }
  r.Game.stop();
  console.log('random session finished at', r.sec().toFixed(1), 's; samples per level', JSON.stringify(levels));
}

if (require.main === module) {
  const a = process.argv.slice(2);
  const p = a[0] === 'random' ? random(parseFloat(a[1] || 120), parseInt(a[2] || 1)) : script(a[0] || '2:shot,4:shot,8:shot');
  p.then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
}
module.exports = { makeRunner, forceRoom };
