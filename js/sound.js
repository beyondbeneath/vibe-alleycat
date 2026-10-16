// PC speaker emulation. The game only ever talks to two pieces of hardware for sound:
//   PIT channel 2 (ports 0x42/0x43), a counter clocked at 1.193 MHz that, in mode 3, outputs a
//   square wave of period divisor/1.193 MHz while its gate is high, and stays high while it is low;
//   port 0x61 bit 0 (the channel 2 gate) and bit 1 (speaker data). The cone is driven by
//   bit 1 AND the channel 2 output, so with the gate low the program can click the speaker
//   directly by toggling bit 1, which the game does for its noisier effects.
// Game reports every write with the CPU clock it happened at. This module replays them on the
// audio clock a little behind the game, averaging the speaker level over each output sample.
'use strict';
const Sound = (() => {
  const LATENCY = 0.12;                  // seconds of emulated time kept between game and audio
  let ctx = null, node = null, game = null, muted = false;
  const evT = [], evBits = [], evDiv = [];
  let head = 0, lastT = 0;
  // Speaker state at renderClk.
  let bits = 0, period = 65536 * 4, origin = 0;
  let renderClk = null;
  let dcX = 0, dcY = 0;

  function apply(t, b, div) {
    const p = (div || 65536) * 4;        // in CPU clocks (PIT input = CPU clock / 4)
    if (!(bits & 1) && (b & 1)) origin = t;   // gate rising: counter reloads, output starts high
    else if (p !== period) {                  // new count: keep the phase going
      const u = ((t - origin) % period + period) % period;
      origin = t - (u / period) * p;
    }
    bits = b; period = p;
  }
  // Clocks during which the square wave is high from origin to t.
  function high(t) {
    const u = t - origin, h = period / 2;
    const n = Math.floor(u / period);
    return n * h + Math.min(u - n * period, h);
  }
  function level(a, b) {
    if (!(bits & 2)) return 0;
    if (!(bits & 1)) return b - a;
    return high(b) - high(a);
  }

  function sink(t, b, div) {
    if (!ctx) { apply(t, b, div); lastT = t; return; }
    if (t < lastT - game.cpuHz) { evT.length = evBits.length = evDiv.length = head = 0; renderClk = null; }
    lastT = t;
    evT.push(t); evBits.push(b); evDiv.push(div);
  }

  function render(out) {
    const n = out.length;
    const hz = game.cpuHz * game.speed;
    const want = game.clock - LATENCY * hz;
    if (renderClk === null || Math.abs(want - renderClk) > 0.3 * hz) {
      renderClk = want;
      while (head < evT.length && evT[head] <= renderClk) { apply(evT[head], evBits[head], evDiv[head]); head++; }
    }
    const drift = Math.max(-0.03, Math.min(0.03, (want - renderClk) / hz * 0.5));
    const step = hz / ctx.sampleRate * (1 + drift);
    for (let i = 0; i < n; i++) {
      let a = renderClk;
      const b = a + step;
      let acc = 0;
      while (head < evT.length && evT[head] < b) {
        const t = Math.max(a, evT[head]);
        acc += level(a, t);
        apply(t, evBits[head], evDiv[head]);
        a = t; head++;
      }
      acc += level(a, b);
      renderClk = b;
      const x = acc / step;
      dcY = x - dcX + 0.995 * dcY;       // DC blocker: the cone rests wherever bit 1 was left
      dcX = x;
      out[i] = muted ? 0 : dcY * 0.3;
    }
    if (head > 4096) { evT.splice(0, head); evBits.splice(0, head); evDiv.splice(0, head); head = 0; }
  }

  return {
    attach(g) { game = g; g.speakerSink = sink; },
    // Must be called from a user gesture.
    start() {
      if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      ctx = new AC();
      node = ctx.createScriptProcessor(2048, 0, 1);
      node.onaudioprocess = (e) => render(e.outputBuffer.getChannelData(0));
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 7000; lp.Q.value = 0.5;
      node.connect(lp); lp.connect(ctx.destination);
      renderClk = null;
    },
    set muted(m) { muted = !!m; },
    get muted() { return muted; },
  };
})();
if (typeof module !== 'undefined') module.exports = Sound;
