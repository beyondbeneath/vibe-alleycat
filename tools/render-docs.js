// Renders the documentation's engine screenshots into img/ at the native 320x200 (the page
// stretches them to 4:3). Each picture comes from a fresh headless run of the port.
// Run: node tools/render-docs.js
'use strict';
const fs = require('fs');
const path = require('path');
const { makeRunner, forceRoom } = require('./headless');
const { encodePNG } = require('./png');
const IMG = path.join(__dirname, '..', 'img');
fs.mkdirSync(IMG, { recursive: true });

function save(r, name) {
  const img = { data: new Uint8ClampedArray(320 * 200 * 4) };
  r.CGA.render(img);
  fs.writeFileSync(path.join(IMG, name + '.png'), encodePNG(320, 200, img.data));
  console.log('img/' + name + '.png');
}
async function key(r, sc, t, hold = 0.1) {
  await r.runUntil(t); r.Game.keyEvent(sc, true);
  await r.runUntil(t + hold); r.Game.keyEvent(sc, false);
}
async function startGame(r) {
  await key(r, 0x1c, 2);                         // any key: leave the title
  await key(r, 0x31, 4);                         // N: no joystick
  await key(r, 0x25, 6);                         // K: Kitten
  await key(r, 0x39, 8);                         // any key: start
}
async function untilLevel(r, n, from, limit = 20) {
  let t = from;
  while (r.Game.mem[r.Game.sym.level_number] !== n && t < from + limit) { t += 0.05; await r.runUntil(t); }
  return t;
}

const shots = {
  async title(r) { await r.runUntil(1.5); save(r, 'title'); },
  async menu(r) { await key(r, 0x1c, 2); await key(r, 0x31, 4); await r.runUntil(5); save(r, 'menu'); },
  async alley(r) {
    await startGame(r);
    await r.runUntil(13);
    await key(r, 0x4d, 13, 1.2);
    await key(r, 0x48, 15, 0.3);
    await r.runUntil(17); save(r, 'alley');
  },
};
for (let n = 1; n <= 7; n++) {
  shots['room' + n] = async (r) => {
    await startGame(r);
    await r.runUntil(12);
    forceRoom(r.Game, n === 2 ? 1 : n);
    let t = await untilLevel(r, n === 2 ? 1 : n, 12);
    if (n === 2) {
      // The fishbowl is reached from room 1: put the cat straight into it.
      r.Game.mem[r.Game.sym.level_complete] = 1;
      t = await untilLevel(r, 2, t);
    }
    await r.runUntil(t + 3);
    save(r, 'room' + n);
  };
}

(async () => {
  const only = process.argv[2];
  for (const [name, f] of Object.entries(shots)) {
    if (only && name !== only) continue;
    process.env.SEED = '7';
    const r = makeRunner();
    await f(r);
    r.Game.stop();
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
