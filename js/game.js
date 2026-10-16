// Alley Cat (IBM, 1984) game logic, ported from the disassembly of CAT.EXE.
//
// Routine and variable names follow the disassembly (orig-src/assembly), so each JS function can
// be read next to its assembler original. All game state lives where the original kept it: in a
// copy of the program's 64 KB data segment (M), addressed through the same offsets ($.name).
// Video memory is CGA.vram. Registers that carry values between routines become arguments and
// return values; routines that return a result in the carry flag return true/false.
//
// Timing: the original has no fixed frame rate. It polls the BIOS tick count, the PIT counter and
// the CGA retrace bit, and some effects depend on how fast its loops spin. The port keeps a
// virtual 4.77 MHz CPU clock (clk): each routine adds the cycles it took on the original (measured
// in a reference emulator), busy-waits advance the clock instead of spinning, and the tick count,
// PIT counter and retrace bit are derived from clk. The game runs as an async function that
// sleeps whenever clk gets ahead of real time.
'use strict';
const Game = (() => {
  const $ = ASSETS.sym;
  const M = new Uint8Array(0x10000);
  const V = CGA.vram;
  const rb = (a) => M[a & 0xffff];
  const rw = (a) => M[a & 0xffff] | (M[(a + 1) & 0xffff] << 8);
  const wb = (a, v) => { M[a & 0xffff] = v; };
  const ww = (a, v) => { M[a & 0xffff] = v; M[(a + 1) & 0xffff] = v >> 8; };
  const incb = (a) => { M[a & 0xffff]++; return M[a & 0xffff]; };
  const decb = (a) => { M[a & 0xffff]--; return M[a & 0xffff]; };
  const incw = (a) => { ww(a, rw(a) + 1); return rw(a); };
  const decw = (a) => { ww(a, rw(a) - 1); return rw(a); };
  const lvl = () => rw($.level_number);

  // ---- clock ------------------------------------------------------------------------------------
  const CPU_HZ = 14318180 / 3;           // 4.77 MHz 8088
  const TICK_CYCLES = 65536 * 4;         // BIOS tick: PIT channel 0 period (18.2 Hz)
  const FRAME_CYCLES = 262 * 304;        // CGA frame: 262 scanlines of 304 CPU clocks
  const LOOP = 17;                       // one taken LOOP instruction
  let clk = 0;
  let tickBase = 0;
  const cyc = (n) => { clk += n; };

  // INT 1Ah AH=0: DX = low word of the tick count.
  const bios_ticks = () => (tickBase + Math.floor(clk / TICK_CYCLES)) & 0xffff;
  // INT 1Ah AH=1: set the tick count.
  const bios_set_ticks = (dx) => { tickBase = dx - Math.floor(clk / TICK_CYCLES); };
  // PIT channel 0, latched: mode 3 with a 65536 reload counts down by 2 twice per period.
  const pit_counter0 = () => (65536 - 2 * (Math.floor(clk / 4) % 32768)) & 0xffff;
  // CGA status port 0x3DA bit 3: vertical retrace (scanlines 224-239 of each frame).
  const in_vsync = () => { const line = Math.floor((clk % FRAME_CYCLES) / 304); return line >= 224 && line < 240; };

  // Real-time pacing.
  let speed = 1, realBase = 0, clkBase = 0, lastYield = 0;
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const target = () => clkBase + (now() - realBase) * CPU_HZ / 1000 * speed;
  let sleeper = (ms) => new Promise((r) => setTimeout(r, ms));
  class Reboot extends Error {}
  let rebootRequested = false;
  let stopped = false;
  function resetPace() { realBase = now(); clkBase = clk; }
  async function pace() {
    if (rebootRequested || stopped) throw new Reboot();
    let ahead = clk - target();
    if (ahead < -CPU_HZ / 10) { resetPace(); ahead = 0; }   // far behind (tab hidden, slow machine): drop the backlog
    if (ahead > 0) await sleeper(ahead / CPU_HZ * 1000 / speed);
    else await sleeper(0);
    lastYield = now();
    if (rebootRequested || stopped) throw new Reboot();
  }
  // Yields when the virtual clock is ahead of real time, or every 15 ms so the page stays responsive.
  const sync = () => (clk - target() > CPU_HZ / 500 || now() - lastYield > 15 || rebootRequested) ? pace() : null;

  // ---- speaker: PIT channel 2 and port 0x61 ------------------------------------------------------
  let port61 = 0x4c, pit2 = 0, pit2Write = 0;
  let speakerSink = null;
  const speaker = () => { if (speakerSink) speakerSink(clk, port61 & 3, pit2); };
  const out43 = (v) => { if ((v >> 6) === 2) pit2Write = 0; };
  const out42 = (v) => {
    if (pit2Write === 0) { pit2 = (pit2 & 0xff00) | (v & 0xff); pit2Write = 1; }
    else { pit2 = (pit2 & 0xff) | ((v & 0xff) << 8); pit2Write = 0; speaker(); }
  };
  const in61 = () => port61;
  const out61 = (v) => { port61 = v & 0xff; speaker(); };
  // Programs channel 2 as a square wave of divisor ax (mov al,0xb6 / out 0x43 / out 0x42 x2).
  const pit2_divisor = (ax) => { out43(0xb6); out42(ax & 0xff); out42((ax >> 8) & 0xff); };

  // ---- video BIOS ---------------------------------------------------------------------------------
  let biosPal = 0x30;                    // BIOS copy of the colour-select register (0040:0066)
  let crtcHsync = 0x2d;                  // CRTC register 2 (horizontal sync position)
  function bios_set_mode() {
    V.fill(0); biosPal = 0x30; CGA.state.colorSelect = 0x30; CGA.setCursor(0, 0);
  }
  // INT 10h AH=0Bh: BH=0 sets background/intensity (bits 0-4), BH=1 selects the palette (bit 5).
  function bios_set_palette(bh, bl) {
    let p = biosPal;
    if (bh === 0) p = (p & 0xe0) | (bl & 0x1f); else p = (p & 0xdf) | ((bl & 1) << 5);
    biosPal = p; CGA.state.colorSelect = p;
  }
  const out_3d9 = (v) => { CGA.state.colorSelect = v & 0xff; };
  const bios_set_cursor = (row, col) => CGA.setCursor(row & 0xff, col & 0xff);
  const bios_teletype = (al, bl) => CGA.teletype(al, bl);

  const calc_cga_addr = (cx, dl) => { cyc(192); return CGA.calc_cga_addr(cx, dl).ax; };
  const blit_to_cga = (si, di, cx) => { cyc(blitCost(cx, 69, 174, 41)); return CGA.blit_to_cga(M, si, V, di, cx); };
  const blit_ds = (si, di, cx) => { cyc(blitCost(cx, 69, 174, 41)); return CGA.blit_to_cga(M, si, M, di, cx); };
  const save_from_cga = (si, di, cx) => { cyc(blitCost(cx, 59, 191, 41)); return CGA.save_from_cga(V, si, M, di, cx); };
  const blit_transparent = (si, di, cx, bp) => { cyc(blitCost(cx, 76, 155, 467)); return CGA.blit_transparent(M, si, V, di, cx, M, bp); };
  const blit_masked = (si, di, cx, bp) => { cyc(blitCost(cx, 76, 153, 139)); return CGA.blit_masked(M, si, V, di, cx, M, bp); };
  const copy_with_stride = (si, di, cx, al) => { cyc(blitCost(cx, 116, 158, 41)); return CGA.copy_with_stride(M, si, M, di, cx, al); };
  // 8088 clocks per call, row and word, fitted to the original's calls in the reference emulator.
  function blitCost(cx, call, row, word) { const w = cx & 0xff, h = (cx >> 8) || 256; return call + h * (row + w * word); }
  // rep stosw: 9 + 23 clocks per word (8088 bus: 15 + 2 byte transfers).
  const fillw = (mem, di, ax, n) => {
    cyc(9 + n * 23);
    const m = mem.length - 1;
    for (let i = 0; i < n; i++) { mem[(di + i * 2) & m] = ax; mem[(di + i * 2 + 1) & m] = ax >> 8; }
  };

  // ---- keyboard: the game's own INT 9 handler -------------------------------------------------
  // keyboard_handler_xt: a make code increments keyboard_counter; any code found in the 22-entry
  // scan-code table at 0x6A1 sets its state byte at 0x6B7+index to 0x00 (down) or 0x80 (up).
  function keyboard_handler_xt(code) {
    const ah = code & 0xff, al = ah & 0x7f;
    if (!(ah & 0x80)) ww($.keyboard_counter, rw($.keyboard_counter) + 1);
    for (let i = 0; i < 0x16; i++) if (M[0x6a1 + i] === al) { M[0x6b7 + i] = ah & 0x80; break; }
    check_special_keys();
  }
  // Ctrl+Alt+Del reboots; Ctrl+Alt+Left/Right move the picture by reprogramming CRTC register 2.
  function check_special_keys() {
    if ((M[0x6c9] | M[0x6b7]) !== 0) return;
    if (!(M[0x6ca] & 0x80)) { rebootRequested = true; return; }
    if (!(M[0x6b9] & 0x80)) {
      if (M[$.video_mode] < 1) return;
      M[$.video_mode]--;
    } else if (!(M[0x6bb] & 0x80)) {
      if (M[$.video_mode] >= 7) return;
      M[$.video_mode]++;
    } else return;
    crtcHsync = (M[$.video_mode] + 0x27) & 0xff;
  }

  // ---- hardware.asm -----------------------------------------------------------------------------
  function read_rom_id() { wb($.rom_id, 0xff); }          // F000:FFFE = 0xFF: IBM PC
  function read_pit_timer() { cyc(117); const v = pit_counter0(); return v; }
  function check_vsync() { cyc(79); return in_vsync() ? 8 : 0; }
  function init_bios_data() {
    for (let i = 0; i < 0x16; i++) M[0x6b7 + i] = 0x80;
    ww($.keyboard_prev, rw($.keyboard_counter) - 0x70);
  }
  function install_handlers() {}
  function restore_handlers() {}
  // Waits for the start of the next vertical retrace (check_vsync / jnz, check_vsync / jz).
  function wait_vsync_start() {
    while (check_vsync()) cyc(16);
    while (!check_vsync()) cyc(16);
  }

  // ---- cga.asm: random / read_pit_counter ------------------------------------------------------
  // 16-bit LFSR: the new top bit is bit 1 of (low byte XOR high byte).
  function random() {
    cyc(160);
    const s = rw($.rng_seed);
    const fb = (((s & 0xff) ^ (s >> 8)) >> 1) & 1;
    ww($.rng_seed, (s >> 1) | (fb << 15));
    return rw($.rng_seed);
  }
  // The two reads of the latched counter are stored low byte in AH, high byte in AL: the seed
  // is the PIT count with its bytes swapped.
  function read_pit_counter() {
    const c = pit_counter0();
    let ax = ((c & 0xff) << 8) | (c >> 8);
    if (ax === 0) ax = 0xfa59;
    ww($.rng_seed, ax);
  }

  // check_rect_collision: rectangle A at (AX, DL) of size (SI, CL) against B at (BX, DH) of size
  // (DI, CH). Returns true (carry) when they overlap.
  function check_rect_collision(ax, dl, si, cl, bx, dh, di, ch) {
    cyc(117);
    ax &= 0xffff; bx &= 0xffff; si &= 0xffff; di &= 0xffff; dl &= 0xff; dh &= 0xff; cl &= 0xff; ch &= 0xff;
    if (((ax + si) & 0xffff) < bx) return false;
    let a = ax - di; if (a < 0) a = 0;
    if (a > bx) return false;
    if (((dl + cl) & 0xff) < dh) return false;
    let d = dl - ch; if (d < 0) d = 0;
    if (d > dh) return false;
    return true;
  }
  const rect = (ax, dl, si, cx_cl, bx, dh, di) => check_rect_collision(ax, dl, si, cx_cl & 0xff, bx, dh, di, cx_cl >> 8);

  // ---- throw.asm: the washing lines ---------------------------------------------------------------
  // Three washing lines scroll sideways one byte at a time; new laundry is generated into a
  // 4-byte-wide column buffer (throw_obj_buf) and fed in at the line's edge. Bits in
  // throw_col_data record which columns carry laundry the cat can stand on.
  function update_thrown_objects() {
    cyc(90);
    if (decb($.throw_timer) !== 0) return;
    incb($.throw_timer);
    if (check_vsync()) return;
    if (rb($.transitioning)) return;
    if (rb($.gravity_y)) return;
    const dx = bios_ticks();
    if (dx === rw($.throw_last_tick)) return;
    ww($.throw_last_tick, dx);
    cyc(300);
    let al = rb(rw($.difficulty_level) + $.throw_delay);
    if (rb($.cat_y) <= 0x60) al >>= 2;
    wb($.throw_timer, al);
    let bx = rw($.current_floor);
    let generate = false;
    if (!check_throw_range(bx)) {
      // The cat is on this line's level but not standing on it: switch to another line.
      al = (rb($.window_column) + rb(bx + $.throw_col_step)) & 0xff;
      if (al < 4) return;
      let dl;
      do { dl = random() & 3; } while (dl === rb($.current_floor) || dl === 3);
      bx = dl;
      ww($.current_floor, bx);
      generate = true;
    } else {
      wb($.window_column, rb($.window_column) + rb(bx + $.throw_col_step));
      if (rb($.window_column) >= 4) {
        if ((random() & 0xff) <= 0x40) {
          let dl;
          do { do { dl = random() & 3; } while (dl === 3); } while (!check_throw_range(dl));
          bx = dl;
          ww($.current_floor, bx);
        }
        generate = true;
      }
    }
    if (generate) {                                // lab_0539
      wb($.window_column, rb(bx + $.throw_col_init));
      const ah = rb(bx + $.throw_y_param);
      generate_throw_object($.throw_obj_buf, rb(rw($.difficulty_level) + $.throw_chance), ah);
      let bits = rb($.throw_bits);
      if (rw($.current_floor) === 1) {
        rotate_throw_bits((bits >> 1) & 1);
        wb($.throw_bits, bits >> 1);
        rotate_throw_bits(bits & 1);
      } else {
        wb($.throw_bits, bits >> 1);
        rotate_throw_bits(bits & 1);
        bits = rb($.throw_bits);
        wb($.throw_bits, bits >> 1);
        rotate_throw_bits(bits & 1);
      }
      bx = rw($.current_floor);
    }
    // lab_0583: a cat standing on the moving line is carried along, and falls off the end.
    if (rb($.in_throw_range)) {
      let ax = rw($.cat_x);
      let fall;
      if ((bx & 0xff) === 1) { decw($.cat_draw_pos); ax -= 4; fall = ax < 8; }
      else { incw($.cat_draw_pos); ax += 4; fall = ax >= 0x123; }
      if (fall) {
        wb($.transition_timer, 0x11);
        wb($.in_level_mode, 1);
        wb($.anim_counter, 1);
        wb($.anim_step, 0x18);
        wb($.scroll_speed, 1);
        wb($.at_platform, 0);
      } else ww($.cat_x, ax);
    }
    // lab_05d0: scroll both interlace banks of the line's 8-line band by one byte.
    bx <<= 1;
    ww($.throw_draw_tmp, rw(bx + $.throw_draw_col));
    const si = rw(bx + $.throw_scroll_src);
    const fwd = bx === 2;
    const movsb = (s, d, n) => {
      cyc(9 + n * 25);
      if (fwd) for (let i = 0; i < n; i++) V[(d + i) & 0x3fff] = V[(s + i) & 0x3fff];
      else for (let i = 0; i < n; i++) V[(d - i) & 0x3fff] = V[(s - i) & 0x3fff];
    };
    const di = fwd ? si - 1 : si + 1;
    movsb(si, di, 0x27f);
    movsb(si + $.cga_bank1_base, di + $.cga_bank1_base, 0x280);
    // Feed the next column of laundry in at the edge.
    let d = rw($.throw_draw_tmp);
    let b = rb($.window_column) + $.throw_obj_buf;
    for (let i = 0; i < 0x10; i++) {
      V[d & 0x3fff] = rb(b);
      b += 4;
      d ^= 0x2000;
      if (!(d & 0x2000)) d += 0x50;
    }
    cyc(16 * 40);
  }

  // Shifts one bit (the carry) through 5 bytes of throw_col_data, upwards or downwards.
  function rotate_throw_bits(cf) {
    cyc(430);
    let bx = rb(rw($.current_floor) + $.throw_rotate_dir);
    const down = bx === 9;
    for (let i = 0; i < 5; i++) {
      const a = bx + $.throw_col_data;
      const v = rb(a);
      if (down) { wb(a, (v << 1) | cf); cf = v >> 7; bx--; }
      else { wb(a, (v >> 1) | (cf << 7)); cf = v & 1; bx++; }
    }
  }

  // Returns true (ZF) unless the cat's feet are at this line's height while it is not standing
  // on something; sets in_throw_range when it is standing on the line.
  function check_throw_range(bx) {
    cyc(167);
    wb($.in_throw_range, 0);
    const al = rb($.cat_y_bottom);
    if (al < rb(bx + $.floor_y_top)) return true;
    if (al >= rb(bx + $.floor_y_bottom)) return true;
    if (rb($.at_platform) < 1) return false;
    wb($.in_throw_range, 1);
    return true;
  }

  // Fills a 4x16-byte column buffer with background, a dotted line in row 1, and, by chance,
  // a shirt or two random garments.
  function generate_throw_object(di, bl, bh) {
    cyc(600);
    wb($.throw_bits, 0);
    for (let i = 0; i < 0x40; i += 2) ww(di + i, 0xaaaa);
    ww(di + 4, 0x4444);
    ww(di + 6, 0x4444);
    const dx = random();
    if ((dx & 0xff) < bl) return;
    if ((dx >> 8) <= bh) return;
    const r = random() & 0xff;
    if (r < 0x18) { for (let i = 0; i < 0x40; i++) wb(di + i, rb($.throw_sprite_large + i)); wb($.throw_bits, 3); }
    else if (r < 0x60) { for (let i = 0; i < 0x20; i++) wb(di + i, rb($.throw_sprite_small + i)); wb($.throw_bits, 3); }
    else {
      const a = generate_throw_pattern(di);
      wb($.throw_bits, a << 1);
      wb($.throw_bits, rb($.throw_bits) | generate_throw_pattern(di + 2));
    }
  }
  function generate_throw_pattern(di) {
    cyc(200);
    const dx = random() & 6;
    if (dx === 6) return 0;
    let si = rw(dx + $.throw_pattern_ptrs);
    for (let i = 0; i < 8; i++) { ww(di, rw(si)); si += 2; di += 4; }
    return 1;
  }

  function reset_window_state() {
    ww($.anim_last_tick, 0);
    ww($.pcjr_delay, 0);
  }

  // ---- alley.asm --------------------------------------------------------------------------------
  // Entering from the screen edge: show only the visible columns of the walking sprite.
  function update_viewport(al, ah) {
    cyc(315);
    const cx = (0xb00 | ((3 - al) & 0xff));
    ww($.cat_sprite_dims, cx);
    if (ah !== 0xff) {
      ww($.cat_sprite_data, rw($.cat_sprite_data) + ((al << 1) & 0xff));
      ww($.cat_x, 0);
    } else {
      ww($.cat_x, ((al << 3) & 0xff) + 0x128);
    }
    copy_with_stride(rw($.cat_sprite_data), 0xe, cx, 3);
    ww($.cat_sprite_data, 0xe);
  }

  // Moves the cat sideways by scroll_speed; returns true (carry) when it hits an edge.
  function update_scroll() {
    cyc(278);
    ww($.scroll_left_bound, 8);
    ww($.scroll_right_bound, 0x123);
    if (lvl() === 7) { ww($.scroll_left_bound, 0x24); ww($.scroll_right_bound, 0x10f); }
    let ax = rw($.cat_x);
    const d = rb($.scroll_direction);
    if (d === 0) return false;
    if (d === 1) {
      ax = (ax + rw($.scroll_speed)) & 0xffff;
      if (ax < rw($.scroll_right_bound)) { ww($.cat_x, ax); return false; }
      ww($.cat_x, rw($.scroll_right_bound) - 1);
      return true;
    }
    ax -= rw($.scroll_speed);
    if (ax < 0 || ax < rw($.scroll_left_bound)) { ww($.cat_x, rw($.scroll_left_bound)); return true; }
    ww($.cat_x, ax);
    return false;
  }

  // Walking: accelerate up to speed 8, and step through the 6 walking frames.
  function update_walk_frame() {
    cyc(300);
    if (rb($.scroll_direction) !== rb($.prev_scroll_dir)) ww($.scroll_speed, 2);
    if (rw($.scroll_speed) < 8) {
      if ((decb($.anim_accumulator) & 3) === 0) incw($.scroll_speed);
    }
    let bl = rb($.walk_anim_frame) + 1;
    if (bl >= 6) bl = 0;
    wb($.walk_anim_frame, bl);
    if (rb($.scroll_direction) === 0xff) bl += 6;
    return rw(((bl << 1) & 0xff) + $.walk_frame_table);
  }

  // Standing still: every 8th call draws a random sitting / tail-swishing pose.
  async function spawn_window_event() {
    cyc(208);
    ww($.scroll_speed, 2);
    wb($.anim_accumulator, 8);
    if (rw($.buffer_size) === 0xc02) {
      if (incb($.window_event_count) & 7) return;
    }
    restore_alley_buffer();
    if (await check_dog_collision()) return;
    if (check_enemy_activate()) return;
    let bx = random() & 0xe;
    ww($.buffer_size, 0xc02);
    blit_masked(rw(bx + $.window_sprite_top), rw($.cat_draw_pos), 0x602, $.alley_save_buf);
    bx = random() & 6;
    blit_masked(rw(bx + $.window_sprite_bot), rw($.cat_draw_pos) + 0xf0, 0x602, 0x612);
    wb($.sprite_hidden, 0);
  }

  function enter_building() {
    cyc(150);
    wb($.at_platform, 0);
    wb($.in_level_mode, 1);
    wb($.anim_counter, 2);
    wb($.anim_step, 1);
    wb($.anim_accumulator, 0xff);
    wb($.scroll_direction, 0);
    wb($.transitioning, 1);
    ww($.vert_sprite_data, rw($.enter_sprite_data));
    ww($.vert_sprite_dims, rw($.enter_sprite_dims));
    wb($.game_mode, 2);
  }

  function save_cat_background() {
    ww($.cat_draw_pos, calc_cga_addr(rw($.cat_x), rb($.cat_y)));
    save_alley_buffer();
  }

  function save_alley_buffer() {
    cyc(60);
    save_from_cga(rw($.cat_draw_pos), $.alley_save_buf, rw($.buffer_size));
    wb($.sprite_hidden, 0);
  }

  function draw_alley_foreground() {
    cyc(203);
    const cx = rw($.cat_sprite_dims);
    ww($.buffer_size, cx);
    wb($.sprite_hidden, 0);
    blit_masked(rw($.cat_sprite_data), rw($.cat_draw_pos), cx, $.alley_save_buf);
  }

  // Hit by something thrown from a window: the dazed cat, and a falling whistle for 10 ticks.
  async function handle_cat_death() {
    cyc(300);
    const dl = rb($.cat_y);
    let cx = rw($.cat_x) - 0xc;
    if (cx < 0) cx = 0;
    if (cx >= 0x10f) cx = 0x10e;
    const di = calc_cga_addr(cx, dl);
    ww($.death_draw_pos, di);
    blit_transparent($.death_sprite, di, 0x1205, 0xe);
    ww($.anim_tick_delay, bios_ticks());
    ww($.fall_sound_x, 0);
    ww($.fall_sound_y, 0);
    do {
      play_falling_sound();
      cyc(40);
      await sync();
    } while (((bios_ticks() - rw($.anim_tick_delay)) & 0xffff) < 0xa);
    silence_speaker();
    wb($.sprite_hidden, 0);
    blit_to_cga(0xe, rw($.death_draw_pos), 0x1205);
    if (rb($.deduct_life) && rb($.lives_count)) decb($.lives_count);
  }

  function restore_alley_buffer() {
    cyc(131);
    blit_to_cga($.alley_save_buf, rw($.cat_draw_pos), rw($.buffer_size));
  }

  // ---- input.asm ----------------------------------------------------------------------------------
  function poll_joystick() {
    cyc(333);
    const dx = bios_ticks();
    if (((dx - rw($.joy_last_tick)) & 0xffff) < 2) return;
    ww($.joy_last_tick, dx);
    if (!rb($.use_joystick)) {
      read_keyboard_dirs();
      // Meant as a short delay, but the loop ends as soon as the PIT counter has moved at all.
      const t = read_pit_timer();
      while (((read_pit_timer() - t) & 0xffff) < 0xf8ed) cyc(10);
      return;
    }
    // Joystick: not present on this machine (the menu refuses to select it).
  }

  // Cursor keys, plus keypad 7/9/1/3 for diagonals; Alt is the action key.
  function read_keyboard_dirs() {
    cyc(600);
    const pcjr = rb($.rom_id) === 0xfd;
    let al = rb($.key_down);
    if (!pcjr) al &= rb($.key_mod2) & rb($.key_mod3);
    wb($.input_vertical, (al ^ 0x80) ? 1 : 0);
    al = rb($.key_up);
    if (!pcjr) al &= rb($.key_mod1) & rb($.key_mod4);
    if (al ^ 0x80) wb($.input_vertical, 0xff);
    al = rb($.key_right);
    if (!pcjr) al &= rb($.key_mod1) & rb($.key_mod2);
    wb($.input_horizontal, (al ^ 0x80) ? 1 : 0);
    al = rb($.key_left);
    if (!pcjr) al &= rb($.key_mod3) & rb($.key_mod4);
    if (al ^ 0x80) wb($.input_horizontal, 0xff);
    wb($.joy_button, rb($.key_fire) >> 3);
  }

  // Esc pauses; Ctrl+9 sets 9 lives; Ctrl+Y quits to DOS; Ctrl+M back to the options menu;
  // Ctrl+R restarts; Ctrl+S toggles the sound. (The disassembly's key_ctrl is Esc, key_pause
  // is Ctrl, key_fn is Y.)
  async function process_keyboard() {
    cyc(111);
    const ax = rw($.keyboard_counter);
    if (ax === rw($.keyboard_prev)) return;
    ww($.keyboard_prev, ax);
    if (!(rb($.key_ctrl) & 0x80)) {
      if (rw($.keyboard_counter) !== rw($.pause_counter)) await show_pause_menu();
      return;
    }
    if (rb($.key_pause) & 0x80) return;
    if (!(rb($.key_cheat) & 0x80)) { wb($.lives_count, 9); return; }
    if (!(rb($.key_fn) & 0x80)) { restore_handlers(); await exit_to_dos(); return; }
    if (!(rb($.key_demo) & 0x80)) { wb($.show_attract, 0xff); return; }
    if (!(rb($.key_restart) & 0x80)) { wb($.restart_game, 0xff); return; }
    if (!(rb($.key_sound) & 0x80)) {
      wb($.sound_enabled, ~rb($.sound_enabled));
      if (!rb($.sound_enabled)) silence_speaker();
    }
  }

  // Ctrl+Y returns to DOS. The port shows the DOS prompt the way the BIOS would leave the
  // screen (still in graphics mode) and restarts the program on the next key.
  async function exit_to_dos() {
    silence_speaker();
    bios_set_mode();
    for (const ch of 'A>') bios_teletype(ch.charCodeAt(0), 3);
    const k = rw($.keyboard_counter);
    while (rw($.keyboard_counter) === k) { cyc(10000); await sync(); }
    rebootRequested = true;
    await pace();
  }

  // ---- level_physics.asm --------------------------------------------------------------------------
  // Picks a random bin (not the same as last time) for the next lid to pop off.
  function pick_random_target() {
    cyc(330);
    const bx = rw($.difficulty_level);
    const cl = rb(bx + $.floor_door_count);
    let dl;
    do {
      do { dl = random() & 7; } while (dl > cl);
      dl = (dl + rb(bx + $.floor_first_door)) & 0xff;
    } while (dl === rb($.last_target_door));
    wb($.last_target_door, dl);
    const c = rb(((bx & 0xff00) | dl) + $.door_position_table);
    return { cx: (c & 0x7f) << 2, dl: (c & 0x80) ? 0x88 : 0x90 };
  }

  // Is there something to stand on under the falling cat? Returns true (carry) when it landed.
  function check_level_collision() {
    cyc(203);
    if (lvl() === 7) return check_stairs_collision();
    if (lvl() !== 0) return check_level_platform();
    let al = rb($.cat_y) & 0xf8;
    if (al !== 0x60) {
      if (check_door_position()) return true;
      return check_window_landing();
    }
    // The top of the fence.
    if (rb($.game_mode) >= 2) return false;
    wb($.cat_y, al);
    wb($.cat_y_bottom, al + 0x32);
    if (rb($.game_mode) !== 1) {
      wb($.game_mode, 1);
      ww(0x556, bios_ticks());                     // when the cat got onto the fence
    }
    return true;
  }

  // Landing on a dustbin (the disassembly calls them doors): two heights, bit 7 of the table.
  function check_door_position() {
    cyc(500);
    const cl = (rb($.cat_y) + 2) & 0xf8;
    let bx = rw($.difficulty_level);
    bx = (bx & 0xff00) | rb(bx + $.floor_first_door);
    for (;;) {
      const al = rb(bx + $.door_position_table);
      if (al === 0) { wb($.door_contact, 0); return false; }
      bx++;
      const ch = (al & 0x80) ? 0x88 : 0x90;
      if (cl !== ch) continue;
      const ax = (al & 0x7f) << 2;
      if ((rw($.cat_x) & 0xfff8) < ax) continue;
      if (((rw($.cat_x) - 0xf) & 0xfff8) > ax) continue;
      wb($.cat_y, ch - 2);
      wb($.cat_y_bottom, ch + 0x30);
      if (!rb($.door_contact)) { wb($.door_contact, 1); play_hit_sound(); }
      return true;
    }
  }

  // Indoors: falling back into the window you came in by leaves the room (cat_died = 1).
  function check_level_platform() {
    cyc(400);
    wb($.l3_platform_id, 0);
    if (rb($.in_level_mode) === 1) {
      if (rect(rw($.entrance_x) - 4, rb($.entrance_y) - 8, 0xc, 0xe10, rw($.cat_x), rb($.cat_y), 0x18)) {
        wb($.cat_died, 1);
        return false;
      }
    }
    if (lvl() === 3 && check_fence_collision()) { wb($.at_platform, 1); return true; }
    const cl = rb($.cat_y) & 0xf8;
    let bx = rw(((lvl() << 1) & 0xffff) + $.level_platform_index);
    for (;;) {
      const ch = rb(bx + $.platform_y_table);
      if (ch === 0) return false;
      wb($.platform_cur_type, rb(bx + $.platform_type_table));
      const b2 = (bx & 0xff00) | ((bx << 1) & 0xff);
      ww($.platform_cur_width, rw(b2 + $.platform_width_table));
      const ax = rw(b2 + $.platform_x_left);
      bx = ((b2 & 0xff00) | ((b2 & 0xff) >> 1)) + 1;
      cyc(60);
      if (cl !== ch) continue;
      if ((rw($.cat_x) & 0xfff8) < ax) continue;
      let dx = rw($.cat_x) - rw($.platform_cur_width);
      if (dx < 0) dx = 0;
      if ((dx & 0xfffc) > ax) continue;
      wb($.cat_y, ch);
      wb($.cat_y_bottom, ch + 0x32);
      const t = rb($.platform_cur_type);
      wb($.at_platform, t);
      if (t) ww($.cat_x, rw($.cat_x) & 0xfffc);
      if (lvl() === 4) {
        const b = bx - 1 - 0x27;
        if (b >= 0 && b < 0x10) wb($.l3_platform_id, b + 1);
      }
      return true;
    }
  }

  function pixel_to_bitmask(bx) {
    bx >>= 3;
    const ch = bx & 0xff;
    bx >>= 3;
    return { bx, ch: 0x80 >> (ch & 7) };
  }

  // Landing on a washing line: only where the line's column bits say there is laundry.
  function check_window_landing() {
    cyc(179);
    let dl = rb($.cat_y) & 0xf8;
    let bx;
    if (dl === 0x8) bx = 0; else if (dl === 0x28) bx = 1; else if (dl === 0x48) bx = 2; else return false;
    let ax = rw($.cat_x);
    if (bx === rw($.current_floor) && rb($.window_column) <= 3) {
      if (bx !== 1) ax += ((4 - rb($.window_column)) << 2) & 0xff;
      else ax -= ((rb($.window_column) + 1) << 2) & 0xff;
      ax &= 0xffff;
    }
    const si = rb(bx + $.window_row_offset);
    const m = pixel_to_bitmask((ax + 0xa) & 0xffff);
    if (!(rb(m.bx + si + 0x1016) & m.ch)) return false;
    wb($.cat_y, dl);
    wb($.cat_y_bottom, dl + 0x32);
    ww($.cat_x, rw($.cat_x) & 0xfff8);
    wb($.at_platform, 1);
    return true;
  }

  function init_player() {
    wb($.jump_anim_counter, 0);
    wb($.gravity_y, 0);
    wb($.idle_aggro_flag, 0);
    wb($.deduct_life, 0);
    ww($.jump_toss_delay, 9);
  }

  // Objects thrown from the windows fall, drifting sideways, until they reach their height.
  async function apply_cat_gravity() {
    cyc(92);
    if (!rb($.gravity_y)) return;
    const dx = bios_ticks();
    if (dx === rw($.gravity_last_tick)) return;
    ww($.gravity_last_tick, dx);
    cyc(400);
    if (rb($.idle_aggro_flag) && (rw($.gravity_x) & 0xfff8) === (rw($.cat_x) & 0xfff8)) wb($.gravity_drift_dir, 0);
    incb($.gravity_frame);
    // The speed only decrements once it is already 1 or less, so the drift stays at 0x20/8.
    if (rw($.gravity_h_speed) <= 1) decw($.gravity_h_speed);
    let ax = rw($.gravity_x);
    const sp = rw($.gravity_h_speed);
    const d = (sp & 0xff00) | ((sp & 0xff) >> 3);
    const dir = rb($.gravity_drift_dir);
    if (dir === 1) { ax += d; if (ax >= 0x12f) ax = 0x12e; }
    else if (dir !== 0) { ax -= d; if (ax < 0) ax = 0; }
    ww($.gravity_x, ax);
    let bx = rw($.gravity_cur_dims);
    const dl = ((rb($.gravity_frame) >> 1) + rb($.gravity_y)) & 0xff;
    const al = dl - rb($.gravity_target_height);
    if (al >= 0) {
      const bh = (bx >> 8) - al;
      if (bh <= 0) {
        wb($.gravity_y, 0);
        wb($.deduct_life, 0);
        restore_gravity_bg();
        return;
      }
      bx = (bh << 8) | (bx & 0xff);
    }
    wb($.gravity_y, dl);
    ww($.gravity_save_dims, bx);
    ww($.gravity_cga_addr, calc_cga_addr(rw($.gravity_x), dl));
    if (rb($.gravity_frame) !== 2) restore_gravity_bg();
    if (await check_dog_collision()) return;
    const di = rw($.gravity_cga_addr);
    ww($.gravity_prev_cga, di);
    const cx = rw($.gravity_save_dims);
    ww($.gravity_restore_dims, cx);
    blit_transparent(rw($.gravity_cur_sprite), di, cx, $.gravity_save_buf);
  }

  function restore_gravity_bg() {
    blit_to_cga($.gravity_save_buf, rw($.gravity_prev_cga), rw($.gravity_restore_dims));
  }

  // A window opens (drawn one scanline per step), someone leans out and throws something at the
  // cat while it is on the fence or the lines.
  async function update_cat_jump() {
    cyc(100);
    if (decb($.jump_tick_delay) !== 0) return;
    wb($.jump_tick_delay, 0xd);
    if (check_vsync()) return;
    cyc(200);
    if (rb($.jump_anim_counter)) check_fish_collision();
    if (rb($.gravity_y)) return;
    if (!rb($.jump_anim_counter)) {
      if (rb($.cat_y) > 0x60) return;
      wb($.idle_aggro_flag, 0);
      // On the fence for more than 0x48 ticks: the throwers aim at the cat.
      if (rb($.game_mode) === 1 && !rb($.force_level7)) {
        if (((bios_ticks() - rw(0x556)) & 0xffff) >= 0x48) incb($.idle_aggro_flag);
      }
      for (;;) {
        let dl = random() & 0xff;
        if (rb($.idle_aggro_flag)) dl &= 3;
        else { dl &= 0xf; if (dl >= 0xc) return; }
        wb($.jump_spawn_param, dl);
        const p = decode_enemy_params(dl);
        ww($.jump_x, p.cx);
        wb($.jump_y, p.dl);
        if (!check_fish_collision()) break;
      }
      wb($.jump_anim_counter, 0x1d);
      const d = rw($.difficulty_level);
      ww($.jump_toss_delay, rw(((d & 0xff00) | ((d << 1) & 0xff)) + $.jump_pause_by_diff));
      wb($.jump_toss_remaining, 1);
    }
    // lab_19cd
    if (check_fish_collision()) return;
    wb($.cycle_active, 0);
    if (check_trashcan_near()) { incb($.cycle_active); return; }
    if (rb($.jump_anim_counter) === 0x10) ww($.jump_toss_tick, bios_ticks());
    if (rb($.jump_anim_counter) === 0xf && ((bios_ticks() - rw($.jump_toss_tick)) & 0xffff) < rw($.jump_toss_delay)) {
      if (rb($.jump_toss_remaining) && !rb($.gravity_y) && !rb($.force_level7)) {
        decb($.jump_toss_remaining);
        wb($.deduct_life, 1);
        wb($.gravity_y, rb($.jump_y));
        const x = (random() & 0xf) + rw($.jump_x);
        ww($.gravity_x, x);
        wb($.gravity_drift_dir, (x & 0xffff) < rw($.cat_x) ? 1 : 0xff);
        const bx = random() & 6;
        ww($.gravity_cur_sprite, rw(bx + $.gravity_sprite_ptrs));
        ww($.gravity_cur_dims, rw(bx + $.gravity_sprite_dims_tbl));
        wb($.gravity_target_height, rb((bx >> 1) + $.gravity_height_table));
        ww($.gravity_h_speed, 0x20);
        wb($.gravity_frame, 1);
        wb($.dog_catch_flag, 0);
      }
      return;
    }
    // lab_1a76: open or close the window by one scanline.
    const c = decb($.jump_anim_counter);
    let dl = rb($.jump_y);
    dl = c > 0xe ? (dl + c - 0xe) & 0xff : (dl + 0xe - c) & 0xff;
    wb($.jump_draw_y, dl);
    const di = calc_cga_addr(rw($.jump_x), dl);
    cyc(150);
    const row = (dl - rb($.jump_y)) & 0xff;
    if (c > 0xe) {
      if (rb($.force_level7)) for (let i = 0; i < 8; i++) V[(di + i) & 0x3fff] = rb($.jump_land_sprite_data + (row << 3) + i);
      else for (let i = 0; i < 8; i++) V[(di + i) & 0x3fff] = 0;
    } else {
      for (let i = 0; i < 8; i++) V[(di + i) & 0x3fff] = rb(row * 0xa + $.jump_land_sprites + i);
    }
  }

  // ---- enemy.asm ----------------------------------------------------------------------------------
  // Spawn parameter dl: bits 0-1 pick one of 4 window columns, bits 2-3 one of 4 rows.
  function decode_enemy_params(dl) {
    cyc(90);
    return { cx: rw(((dl & 3) << 1) + $.jump_spawn_x_table), dl: rb(((dl >> 2) & 3) + $.jump_spawn_y_table) };
  }

  // Is the cat at the open window? Jumping into it while it is open enters the building.
  function check_fish_collision() {
    cyc(140);
    if (!rect(rw($.jump_x), rb($.jump_y), 0x20, 0xe0f, rw($.cat_x), rb($.cat_y), 0x18)) return false;
    if (rb($.in_level_mode) === 1 && !rb($.transitioning) && rb($.cat_y) < 0x60 &&
        rb($.jump_anim_counter) >= 5 && rb($.jump_anim_counter) < 0x19) wb($.cat_died, 1);
    return true;
  }

  // Bottom-row windows next to a dustbin with a lid off don't open.
  function check_trashcan_near() {
    cyc(100);
    const al = rb($.jump_spawn_param);
    if (al >= 8) return false;
    const bx = (al & 4) ? 4 : 2;
    let ax = (rw(bx + $.obj_x) + 0x10) & 0xffff;
    if (ax < rw($.jump_x)) return false;
    ax -= 0x30;
    if (ax < 0) ax = 0;
    return ax <= rw($.jump_x);
  }

  // Hit by the thing thrown from a window: knocked off and dazed, the object bounces away.
  async function check_dog_collision() {
    cyc(91);
    if (lvl() !== 0) return false;
    const dl = rb($.gravity_y);
    if (!dl) return false;
    const dims = rw($.gravity_cur_dims);
    if (!check_rect_collision(rw($.gravity_x), dl, 0x10, dims >> 8, rw($.cat_x), rb($.cat_y), 0x18, 0xe)) return false;
    restore_alley_buffer();
    restore_gravity_bg();
    enter_building();
    if (!rb($.dog_catch_flag)) {
      wb($.dog_catch_flag, 1);
      await handle_cat_death();
      wb($.gravity_drift_dir, rb($.gravity_drift_dir) === 0xff ? 1 : 0xff);
      ww($.gravity_h_speed, 0x60);
      wb($.gravity_frame, 1);
      wb($.at_platform, 0);
    }
    return true;
  }

  // Between scenes: a rectangle of solid colour grows out from the cat, then the next scene is
  // drawn and a second wipe (in the new scene's colour) clears it.
  async function level_transition() {
    bios_set_palette(0, 0);
    if (rw($.level_state) === 7 && rb($.cat_caught)) {
      await run_victory_sequence();
      ww($.cat_x, 0x98);
      wb($.cat_y, 0x5f);
    }
    ww($.wipe_fill_pattern, 0);
    await animate_screen_wipe();
    silence_speaker();
    set_palette();
    if (lvl() === 0) {
      if (!rb($.cat_caught)) await show_level_result();
      else if (rw($.level_state) === 7) await play_victory_march();
      else await handle_level_complete();
    }
    ww($.wipe_fill_pattern, (lvl() === 7 || lvl() === 2) ? 0x5555 : 0xaaaa);
    await animate_screen_wipe();
    silence_speaker();
  }

  async function animate_screen_wipe() {
    wipe_sound_start();
    ww($.wipe_width, 1);
    wb($.wipe_height, 8);
    let cx = (rw($.cat_x) + 0xc) & 0xfff0;
    let dl = (rb($.cat_y) + 8) & 0xff;
    wb($.wipe_edge_flags, 0);
    for (;;) {
      play_wipe_note();
      ww($.wipe_rect_x, cx);
      wb($.wipe_rect_y, dl);
      let di = calc_cga_addr(cx, dl);
      let bl = rb($.wipe_height);
      const ax = rw($.wipe_fill_pattern);
      do {
        const n = rw($.wipe_width) >> 3;
        cyc(220 + n * 23);
        for (let i = 0; i < n; i++) { V[di & 0x3fff] = ax; V[(di + 1) & 0x3fff] = ax >> 8; di += 2; }
        di -= (rw($.wipe_width) >> 2) & 0xfe;
        di ^= 0x2000;
        if (!(di & 0x2000)) di += 0x50;
        di &= 0xffff;
        bl = (bl - 1) & 0xff;
      } while (bl);
      if (rb($.wipe_edge_flags) === 0xf) return;
      cyc(450);
      ww($.wipe_width, rw($.wipe_width) + 0x20);
      wb($.wipe_height, rb($.wipe_height) + 0x10);
      cx = rw($.wipe_rect_x) - 0x10;
      dl = rb($.wipe_rect_y);
      if (cx < 0) { cx = 0; wb($.wipe_edge_flags, rb($.wipe_edge_flags) | 1); }
      if (rw($.wipe_width) + cx >= 0x140) { ww($.wipe_width, 0x140 - cx); wb($.wipe_edge_flags, rb($.wipe_edge_flags) | 2); }
      dl -= 8;
      if (dl < 0) { dl = 0; wb($.wipe_edge_flags, rb($.wipe_edge_flags) | 4); }
      const al = rb($.wipe_height) + dl;
      if (al > 0xff || al >= 0xc8) { wb($.wipe_height, 0xc8 - dl); wb($.wipe_edge_flags, rb($.wipe_edge_flags) | 8); }
      await sync();
    }
  }

  // Each room has its own CGA palette (0 or 1); the background is always black.
  function set_palette() {
    cyc(400);
    bios_set_palette(1, rb(lvl() + $.cga_palette_table));
    bios_set_palette(0, 0);
  }

  // Back in the alley after a room: a picture of what happened, dissolved in and out.
  async function show_level_result() {
    if (rw($.level_state) === 7) { await love_scene_outro(); return; }
    init_result_melody();
    let ax = 0x185b;
    if (rb($.object_hit)) {
      const bx = rw($.game_timer);
      ww($.game_timer, bx + 2);
      ax = rw((bx & 6) + $.result_sprite_table);
      if (rb($.lives_count)) decb($.lives_count);
      if (rb($.object_hit) === 0xdd && rw($.difficulty_level) !== 0 && rb($.lives_count) >= 1) {
        await show_extra_life();
        silence_speaker();
        return;
      }
    }
    ww($.result_sprite_ptr, ax);
    ww($.result_dissolve_mask, 0x8080);
    wb($.result_frame_counter, 0x1c);
    do {
      draw_result_frame();
      ww($.result_last_tick, bios_ticks());
      while (bios_ticks() === rw($.result_last_tick)) { play_result_note(); cyc(170); await sync(); }
      let m;
      if (rb($.result_frame_counter) <= 0x14) m = rw((rb($.result_frame_counter) & 6) + $.result_mask_table);
      else { const al = ((rw($.result_dissolve_mask) & 0xff) >> 1) | 0x80; m = (al << 8) | al; }
      ww($.result_dissolve_mask, m);
    } while (decb($.result_frame_counter) !== 0);
    silence_speaker();
  }

  function draw_result_frame() {
    cyc(0x60 * 40);
    let si = rw($.result_sprite_ptr);
    const m = rw($.result_dissolve_mask);
    for (let i = 0; i < 0x60; i++) { ww(0xe + i * 2, rw(si) & m); si += 2; }
    blit_to_cga(0xe, 0xed0, 0xc08);
  }

  function init_sound() {
    wb($.enemy_chasing, 0);
    ww($.enemy_tick_counter, 0);
    wb($.enemy_approach_timer, 0);
    wb($.enemy_exit_timer, 0);
    wb($.enemy_active, 0);
    wb($.enemy_y_pos, 0xb1);
    init_chase_sound();
  }

  // The dog: runs in from the side opposite the cat, chases it along the ground, and leaves
  // again. If it reaches the cat (enemy_active) they fight in a cloud.
  function update_enemies() {
    cyc(373);
    const cx = bios_ticks();
    if (((cx - rw($.enemy_last_tick)) & 0xffff) < (rw($.enemy_tick_counter) & 1) + 1) return;
    if (!check_vsync()) return;
    ww($.enemy_last_tick, cx);
    incw($.enemy_tick_counter);
    let ax;
    let move = true;
    if (rb($.enemy_exit_timer)) {
      if (decb($.enemy_exit_timer) === 0) {
        silence_speaker();
        if (rb($.enemy_active)) {
          if (lvl() !== 0) {
            wb($.object_hit, 0xdd);
            ww($.cat_x, 0xa0);
            wb($.cat_y, 0x60);
            return;
          }
          if (rb($.lives_count)) decb($.lives_count);
        }
        erase_enemy();
        init_sound();
        return;
      }
      update_enemy_sprite();
      update_enemy_viewport((4 - rb($.enemy_exit_timer)) & 0xff, rb($.enemy_dir) === 0xff ? 1 : 0xff);
      move = false;
    } else if (rb($.enemy_active)) {
      let dl = rb($.enemy_active);
      if (rw($.enemy_chase_delay)) {
        decw($.enemy_chase_delay);
        dl = random() & 1;
        if (!dl) dl = 0xff;
      }
      wb($.enemy_dir, dl);
      ax = rw($.enemy_x);
    } else {
      let chase = true;
      if (!rb($.enemy_chasing)) {
        if (!rb($.enemy_approach_timer)) {
          if (!rb($.fall_hit)) {
            if (rb($.cat_y) < 0xb4 || rb($.entry_steps)) return;
            if ((random() & 0xff) >= rb(rw($.difficulty_level) + $.enemy_spawn_chance)) return;
          }
          ww($.walk_note_index, 0);
          wb($.enemy_dir, rw($.cat_x) >= 0xa0 ? 1 : 0xff);
          wb($.enemy_approach_timer, 4);
        }
        if (decb($.enemy_approach_timer) !== 0) {
          update_enemy_sprite();
          update_enemy_viewport(rb($.enemy_approach_timer), rb($.enemy_dir));
          move = false;
          chase = false;
        } else wb($.enemy_chasing, 1);
      }
      if (chase) {                                 // lab_1f75
        wb($.fall_hit, 0);
        ax = rw($.enemy_x);
        if (rb($.cat_y) >= 0xb4 && !rb($.entry_steps)) {
          if ((random() & 0xff) <= rb(rw($.difficulty_level) + $.enemy_chase_chance)) {
            wb($.enemy_dir, ax > rw($.cat_x) ? 0xff : 1);
          }
        }
      }
    }
    if (move) {                                    // lab_1fab
      const d = rb($.enemy_dir);
      let edge = false;
      if (d === 1) { ax += 8; if (ax >= 0x11e) { ax = 0x11e; edge = true; } }
      else if (d !== 0) { ax -= 8; if (ax < 0) { ax = 0; edge = true; } }
      if (edge) {                                  // lab_1fbb: at the edge, leave unless still chasing
        let leave;
        if (rb($.enemy_active)) leave = rw($.enemy_chase_delay) === 0;
        else leave = rb($.cat_y) < 0xb4 || rb($.entry_steps) !== 0;
        if (leave) wb($.enemy_exit_timer, 4);
      }
      ww($.enemy_x, ax);
      update_enemy_sprite();
      ww($.enemy_sprite_dims, 0xf04);
    }
    // lab_1ffb
    ww($.enemy_next_addr, calc_cga_addr(rw($.enemy_x), rb($.enemy_y_pos)));
    if (rb($.enemy_approach_timer) !== 3) erase_enemy();
    if (check_enemy_activate()) return;
    ww($.enemy_draw_addr, rw($.enemy_next_addr));
    draw_enemy();
  }

  function update_enemy_sprite() {
    cyc(239);
    let bl;
    if (rb($.enemy_active)) bl = (incb($.enemy_anim_frame) & 6) | 8;
    else {
      wb($.enemy_anim_frame, rb($.enemy_anim_frame) + 2);
      bl = rb($.enemy_anim_frame) & 2;
      if (rb($.enemy_dir) === 1) bl |= 4;
    }
    ww($.enemy_sprite_ptr, rw(bl + $.enemy_sprite_table));
  }

  function update_enemy_viewport(al, ah) {
    cyc(300);
    const cx = 0xf00 | ((4 - al) & 0xff);
    ww($.enemy_sprite_dims, cx);
    if (ah !== 0xff) {
      ww($.enemy_sprite_ptr, rw($.enemy_sprite_ptr) + ((al << 1) & 0xff));
      ww($.enemy_x, 0);
    } else {
      ww($.enemy_x, ((al << 3) & 0xff) + 0x120);
    }
    copy_with_stride(rw($.enemy_sprite_ptr), 0xe, cx, 4);
    ww($.enemy_sprite_ptr, 0xe);
  }

  function draw_enemy() {
    cyc(60);
    const cx = rw($.enemy_sprite_dims);
    ww($.enemy_erase_dims, cx);
    if (!rb($.enemy_active)) {
      blit_transparent(rw($.enemy_sprite_ptr), rw($.enemy_draw_addr), cx, $.enemy_save_buf);
      return;
    }
    save_from_cga(rw(0x1cbd), $.enemy_save_buf, cx);
    blit_to_cga(rw($.enemy_sprite_ptr), rw($.enemy_draw_addr), rw($.enemy_sprite_dims));
  }

  function erase_enemy() {
    blit_to_cga($.enemy_save_buf, rw($.enemy_draw_addr), rw($.enemy_erase_dims));
  }

  function check_enemy_activate() {
    cyc(87);
    if (rb($.enemy_active)) return false;
    if (!(rb($.enemy_chasing) | rb($.enemy_approach_timer) | rb($.enemy_exit_timer))) return false;
    if (rb($.cat_y) < 0xa3 || rb($.entry_steps)) return false;
    let ax = (rw($.enemy_x) + 0x20) & 0xffff;
    if (ax < rw($.cat_x)) return false;
    ax -= 0x38;
    if (ax < 0) ax = 0;
    if (ax > rw($.cat_x)) return false;
    return activate_enemy_chase();
  }

  // The dog has reached the cat: a fight cloud halfway between them; the cat reappears at the
  // far edge of the screen.
  function activate_enemy_chase() {
    cyc(400);
    if (lvl() === 6) { wb($.enemy_y_pos, rb($.cat_y)); ww($.enemy_x, rw($.cat_x)); }
    let ax = ((rw($.enemy_x) + rw($.cat_x)) & 0xffff) >> 1;
    if (ax >= 0x118) ax = 0x117;
    ww($.enemy_x, ax);
    let bl = 1, dx;
    if (ax <= 0xa0) { bl = 0xff; dx = 0xa1 - ax; } else dx = ax - 0x9f;
    wb($.enemy_active, bl);
    wb($.enemy_chasing, 1);
    wb($.enemy_exit_timer, 0);
    ww($.enemy_chase_delay, dx >> 3);
    if (lvl() === 6) {
      restore_alley_buffer();
      const al = rb($.enemy_active);
      wb($.enemy_active, 0);
      ww($.enemy_sprite_dims, 0xf04);
      ww($.enemy_sprite_ptr, rw($.enemy_sprite_table));
      ww($.enemy_draw_addr, calc_cga_addr(rw($.enemy_x), rb($.enemy_y_pos)));
      draw_enemy();
      wb($.enemy_active, al);
    }
    erase_enemy();
    restore_alley_buffer();
    ww($.cat_x, rw($.cat_x) >= 0xa0 ? 0 : 0x122);
    if (lvl() === 0) setup_alley();
    return true;
  }

  function check_enemy_object_hit() {
    cyc(150);
    if (!(rb($.enemy_chasing) | rb($.enemy_approach_timer) | rb($.enemy_exit_timer))) return false;
    return rect(rw($.thrown_obj_x), rb($.thrown_obj_y), 0x10, 0xf1e, rw($.enemy_x), rb($.enemy_y_pos), 0x20);
  }

  // ---- objects.asm --------------------------------------------------------------------------------
  function reset_jump() { wb($.fall_counter, 0); }

  // A dustbin lid flies up in an arc and drops back. If it touches the cat, the dog comes.
  function animate_falling() {
    cyc(313);
    const dx = bios_ticks();
    if (dx === rw($.fall_last_tick)) return;
    if (!check_vsync()) return;
    ww($.fall_last_tick, dx);
    if (check_jump_collision()) return;
    if (!rb($.fall_counter)) {
      if (rb($.cat_y) !== 0x86 && rb($.cat_y) !== 0x8e) {
        if ((random() & 0xff) > 5) return;
      }
      const t = pick_random_target();
      wb($.fall_target_y, t.dl + 3);
      ww($.fall_target_x, t.cx + (random() & 7) + 6);
      wb($.fall_counter, 0x1b);
    }
    const c = decb($.fall_counter);
    const cx = rw($.fall_target_x);
    let dl = rb($.fall_target_y), bx;
    // Rising, the lid shows ever more rows; coming down, ever fewer (dat_1b02 is used as 0x1B02).
    if (c > 0xd) { dl = (dl + c - 0xf) & 0xff; bx = (((0x1b - c) & 0xff) << 8) | 2; }
    else { dl = (dl + 0xc - c) & 0xff; bx = (c << 8) | 2; }
    ww($.fall_sprite_dims, bx);
    wb($.fall_cur_y, dl);
    ww($.fall_cga_addr, calc_cga_addr(cx, dl));
    erase_jump_sprite();
    if (check_jump_collision()) return;
    if (!rb($.fall_counter)) return;
    const di = rw($.fall_cga_addr);
    ww($.fall_draw_pos, di);
    ww($.fall_save_dims, rw($.fall_sprite_dims));
    blit_transparent($.fall_sprite, di, rw($.fall_sprite_dims), $.fall_save_buf);
  }

  function erase_jump_sprite() {
    cyc(83);
    if (rb($.fall_counter) === 0x1a) return;
    blit_to_cga($.fall_save_buf, rw($.fall_draw_pos), rw($.fall_save_dims));
  }

  function check_jump_collision() {
    cyc(60);
    if (!rb($.fall_counter)) return false;
    const rows = rw($.fall_sprite_dims) >> 8;
    if (!check_rect_collision(rw($.fall_target_x), rb($.fall_cur_y), 0x10, rows, rw($.cat_x), rb($.cat_y), 0x18, 0xe)) return false;
    wb($.fall_hit, 1);
    return true;
  }

  // Three mice, each at its own fixed height (obj_y), all starting on the side away from the cat.
  function init_objects() {
    ww($.obj_slot, 0);
    let ax = 0, dl = 1;
    if (rw($.cat_x) <= 0xa0) { ax = 0x12c; dl = 0xff; }
    for (let i = 0; i < 3; i++) {
      ww($.obj_x + i * 2, ax);
      wb($.obj_dir + i, dl);
      wb($.obj_hidden + i, 1);
      wb($.obj_hit + i, 0);
    }
  }

  // One mouse per BIOS tick, in turn.
  async function cycle_animations() {
    cyc(313);
    const dx = bios_ticks();
    if (dx === rw($.obj_last_tick)) return;
    ww($.obj_last_tick, dx);
    if (rb($.transitioning)) return;
    let bx = rw($.obj_slot) + 1;
    if (bx >= 3) bx = 0;
    ww($.obj_slot, bx);
    if (check_cycle_gravity_hit()) return;
    if (await check_cycle_cat_collision()) return;
    bx = rw($.obj_slot);
    if (rb(bx + $.obj_hit)) {
      // A caught mouse comes back from the far side 0x36 ticks later.
      if (((bios_ticks() - rw(bx * 2 + $.obj_hit_tick)) & 0xffff) < 0x36) return;
      let ax = 0, dl = 1;
      if (rw($.cat_x) <= 0xa0) { ax = 0x12c; dl = 0xff; }
      ww(bx * 2 + $.obj_x, ax);
      wb(bx + $.obj_hit, 0);
      wb(bx + $.obj_dir, dl);
    }
    wb(bx + $.obj_prev_dir, rb(bx + $.obj_dir));
    let path;
    if (rb($.cycle_active)) { ww($.obj_speed, 0xc); path = 2418; }
    else {
      ww($.obj_speed, rb($.cat_y) <= 0x60 ? 8 : 4);
      path = bx === rw($.current_floor) ? 2418 : 2425;
    }
    let al = null, dl;
    if (path === 2418) {
      if (rb(bx + $.obj_dir) === 0) { dl = random() & 0xff; al = (dl & 1) ? 1 : 0xff; }
      else path = 2425;
    }
    if (path === 2425) {
      path = 2466;
      const oy = rb(bx + $.obj_y);
      if (rb($.at_platform) && oy <= rb($.cat_y) && ((oy + 0x10) & 0xff) >= rb($.cat_y)) {
        // Same height as the cat: run towards it.
        dl = random() & 0xff;
        if (dl <= rb(rw($.difficulty_level) + $.obj_chase_table)) {
          ww($.obj_speed, 0xc);
          al = rw(bx * 2 + $.obj_x) < rw($.cat_x) ? 1 : 0xff;
          path = 0;
        }
      }
    }
    if (path === 2466) {
      let cl = 0x18;
      if (rb($.cat_y) > 0x60) { cl = 0x28; if (rb(bx + $.obj_dir) === 0) cl = 0x10; }
      dl = random() & 0xff;
      if (dl <= cl) {
        if (rb(bx + $.obj_dir) !== 0) al = 0;
        else al = (dl & 1) ? 1 : 0xff;
      }
    }
    if (al !== null) wb(bx + $.obj_dir, al);
    // lab_2496
    dl = rb(bx + $.obj_dir);
    let ax = rw(bx * 2 + $.obj_x);
    if (dl === 1) { ax += rw($.obj_speed); if (ax >= 0x12f) { ax = 0x12e; dl = 0xff; } }
    else if (dl !== 0) { ax -= rw($.obj_speed); if (ax < 0) { ax = 0; dl = 1; } }
    ww(bx * 2 + $.obj_x, ax);
    wb(bx + $.obj_dir, dl);
    ww($.obj_cga_tmp, calc_cga_addr(ax, rb(bx + $.obj_y)));
    bx = rw($.obj_slot);
    if (!rb(bx + $.obj_hidden) && (rb(bx + $.obj_dir) | rb(bx + $.obj_prev_dir))) erase_cycle_sprite();
    if (check_cycle_gravity_hit()) return;
    if (await check_cycle_cat_collision()) return;
    bx = rw($.obj_slot);
    wb(bx + $.obj_hidden, 0);
    let si;
    if (rb(bx + $.obj_dir) === 0) {
      if (rb(bx + $.obj_prev_dir) === 0) return;
      si = $.cycle_idle_sprite;
    } else {
      si = $.cycle_walk_sprite;
      if (!(incb(bx + $.obj_anim_toggle) & 1)) si += 0x20;
      if (rb(bx + $.obj_dir) !== 1) si += 0x40;
    }
    const di = rw($.obj_cga_tmp);
    ww(bx * 2 + $.obj_draw_pos, di);
    blit_masked(si, di, 0x802, rw(bx * 2 + $.obj_save_buf));
  }

  function erase_cycle_sprite() {
    cyc(165);
    const bx = rw($.obj_slot) * 2;
    blit_to_cga(rw(bx + $.obj_save_buf), rw(bx + $.obj_draw_pos), 0x802);
  }

  // A mouse running into a cat standing on something knocks it off; a leaping cat catches it.
  async function check_cycle_cat_collision() {
    cyc(232);
    const bx = rw($.obj_slot);
    if (!rect(rw(bx * 2 + $.obj_x), rb(bx + $.obj_y), 0x10, 0xe08, rw($.cat_x), rb($.cat_y), 0x18)) return false;
    if (rb(bx + $.obj_hit) || rb($.cat_y_bottom) < 0x26) return true;
    if (rb($.at_platform)) {
      wb($.at_platform, 0);
      wb($.transition_timer, 0x11);
      wb($.in_level_mode, 1);
      wb($.scroll_direction, 0);
      let di = rw(bx * 2 + $.obj_draw_pos);
      if (rw(bx * 2 + $.obj_x) >= 0x10) di -= 4;
      ww($.obj_collision_pos, di);
      blit_transparent($.collision_sprite, di, 0x806, 0xe);
      ww($.obj_last_tick, bios_ticks());
      do { play_random_noise(); cyc(170); await sync(); }
      while (((bios_ticks() - rw($.obj_last_tick)) & 0xffff) < 8);
      silence_speaker();
      blit_to_cga(0xe, rw($.obj_collision_pos), 0x806);
      return true;
    }
    wb(bx + $.obj_hit, 1);
    wb(bx + $.obj_dir, 1);
    ww(bx * 2 + $.obj_hit_tick, bios_ticks());
    restore_alley_buffer();
    blit_transparent(rw(bx * 2 + $.obj_hit_sprite), rw(bx * 2 + $.obj_draw_pos), 0x802, 0xe);
    save_alley_buffer();
    add_score(rb(rw($.obj_slot) + $.obj_score));
    start_tone(0x3e8, 0x2ee);
    return true;
  }

  function check_cycle_gravity_hit() {
    cyc(60);
    if (!rb($.gravity_y)) return false;
    const bx = rw($.obj_slot);
    return rect(rw(bx * 2 + $.obj_x), rb(bx + $.obj_y), 0x10, 0xc08, rw($.gravity_x), rb($.gravity_y), 0x10);
  }

  // ---- score.asm ----------------------------------------------------------------------------------
  // Scores are 7 unpacked BCD digits, most significant first: current at 0x1F82, high at 0x1F89.
  const SCORE = 0x1f82, HIGH = 0x1f89;
  function update_high_score() {
    cyc(200);
    for (let i = 0; i < 7; i++) {
      const a = rb(SCORE + i), b = rb(HIGH + i);
      if (a === b) continue;
      if (a > b) for (let j = 0; j < 7; j++) wb(HIGH + j, rb(SCORE + j));
      return;
    }
  }

  function draw_lives() {
    cyc(95);
    const al = rb($.lives_count);
    if (al === rb($.lives_display)) return;
    wb($.lives_display, al);
    blit_to_cga(((al << 4) + $.digit_sprites) & 0xffff, $.lives_cga_pos, 0x801);
  }

  function clear_score() { for (let i = 0; i < 7; i++) wb(SCORE + i, 0); }
  function clear_high_score() { for (let i = 0; i < 7; i++) wb(HIGH + i, 0); }

  // The two names are swapped in the disassembly: draw_score draws the high score.
  function draw_score() { render_score_digits(HIGH, $.high_score_cga_pos); }
  function draw_high_score() { render_score_digits(SCORE, $.current_score_cga_pos); }

  // 8086 AAA: returns [al, ah, cf].
  function aaa(al, ah, af) {
    let cf = 0;
    if ((al & 0xf) > 9 || af) { al = (al + 6) & 0xff; ah = (ah + 1) & 0xff; cf = 1; }
    return [al & 0xf, ah, cf];
  }

  // Adds AL at the second-last digit and carries upwards through the first six digits only,
  // so the last digit of the score is always 0.
  function add_score(al) {
    cyc(600);
    for (let cx = 6; cx >= 1; cx--) {
      const a = rb(cx + $.lives_display);
      const s = al + a;
      const af = ((al ^ a ^ s) & 0x10) !== 0;
      const r = aaa(s & 0xff, 0, af);
      wb(cx + $.lives_display, r[0]);
      al = r[1];
    }
    draw_high_score();
  }

  // [di] += [si], 7 BCD digits.
  function add_bcd_scores(di, si) {
    cyc(500);
    let cf = 0;
    for (let bx = 6; bx >= 0; bx--) {
      const a = rb(di + bx), b = rb(si + bx);
      const s = a + b + cf;
      const af = ((a ^ b ^ s) & 0x10) !== 0;
      const r = aaa(s & 0xff, 0, af);
      wb(di + bx, r[0]);
      cf = r[2];
    }
  }

  // Seven 8x8 digits, with a gap after the third.
  function render_score_digits(bx, di) {
    for (let i = 0; i < 7; i++) {
      cyc(80);
      blit_to_cga(((rb(bx + i) << 4) + $.digit_sprites) & 0xffff, di, 0x801);
      di += 2;
      if (i === 2) di += 2;
    }
  }

  // Each room is assembled from block lists; the fishbowl (level 2) gets a row of random
  // pebbles along the top.
  function draw_level_background() {
    const n = lvl();
    if (n === 2) {
      fillw(V, 0, 0xaaaa, 0x50);
      fillw(V, $.cga_bank1_base, 0xaaaa, 0x50);
      ww($.block_count, 0);
      do {
        let dl;
        do { dl = random() & 0x18; } while (dl === rb($.block_prev));
        wb($.block_prev, dl);
        const bx = rw($.block_count);
        wb(bx + $.level2_block_types, dl);
        blit_to_cga(dl + 0x2020, ((bx << 1) + 0xa0) & 0xffff, 0x401);
        incw($.block_count);
      } while (rw($.block_count) < 0x28);
      return;
    }
    if (n === 7) { draw_love_scene_bg(); return; }
    if (n === 6) {
      draw_level_border(0);
      draw_block_list($.level_bg_block_list, 0x64a);
      ww($.entrance_x, 0x48);
      wb($.entrance_y, 0x38);
      draw_door_frame(0xdd2);
      draw_platform(0xdf6);
      blit_to_cga($.level6_door_sprite, 0x67e, 0x1002);
      draw_block_list($.level_tile_list_a, 0xb84);
      init_level6_objects();
      return;
    }
    if (n === 5) {
      draw_level_border(0x640);
      draw_block_list($.level_bg_block_list, 0xcb6);
      ww($.entrance_x, 0xf8);
      wb($.entrance_y, 0x60);
      draw_door_frame(0x140e);
      draw_platform(0x1434);
      draw_platform(0x143e);
      draw_ledge(0x16a0);
      draw_block_list($.level_tile_list_a, 0x1184);
      blit_to_cga($.level5_door_sprite, 0xdd6, 0x1002);
      return;
    }
    if (n === 4) {
      draw_level_border(0x640);
      draw_block_list($.level_bg_block_list, 0xcba);
      ww($.entrance_x, 0x108);
      wb($.entrance_y, 0x60);
      draw_door_frame(0x1439);
      draw_block_pair(0x16c0);
      init_level4_bg();
      return;
    }
    if (n === 3) {
      draw_level_border(0x640);
      draw_block_list($.level_bg_block_list, 0xc90);
      ww($.entrance_x, 0x60);
      wb($.entrance_y, 0x60);
      draw_door_frame(0x140c);
      draw_platform(0x1418);
      draw_block_list($.level_tile_list_a, 0x1184);
      draw_block_list($.level_tile_list_a, 0x11a2);
      draw_block_list($.level3_extra_blocks, 0);
      draw_level3_bg();
      return;
    }
    draw_level_border(0x640);
    draw_block_list($.level_bg_block_list, 0xca0);
    ww($.entrance_x, 0xa0);
    wb($.entrance_y, 0x60);
    draw_door_frame(0x1406);
    draw_block_list($.level_tile_list_a, 0x11c4);
    draw_platform(0x1422);
    draw_ledge(0x1690);
    draw_block_pair(0x16b6);
  }

  function draw_block_pair(ax) {
    ww($.draw_temp, ax);
    draw_block_list($.block_pair_list_a, ax);
    draw_block_list($.block_pair_list_b, rw($.draw_temp));
  }
  // The four block lists of the window frame are pointed to from the words after draw_temp.
  function draw_door_frame(ax) {
    ww($.draw_temp, ax);
    for (let si = 8; si; si -= 2) draw_block_list(rw(si + $.draw_temp), rw($.draw_temp));
  }
  function draw_platform(ax) {
    ww($.draw_temp, ax);
    for (let si = 0xa; si; si -= 2) draw_block_list(rw(si + $.platform_sprite_list), rw($.draw_temp));
  }
  function draw_ledge(ax) {
    ww($.draw_temp, ax);
    for (let si = 8; si; si -= 2) draw_block_list(rw(si + $.ledge_sprite_list), rw($.draw_temp));
  }
  function draw_level_border(ax) {
    ww($.bar_base, ax);
    draw_block_list($.border_block_list, ax);
    fillw(V, rw($.bar_base) + 0x284, 0, 0x24);
    fillw(V, rw($.bar_base) + $.level_block_data, 0, 0x24);
    draw_vertical_line(rw($.bar_base) + $.dat_2284, 0x2a);
    draw_vertical_line(rw($.bar_base) + $.dat_22cb, 0xa8);
  }
  function draw_vertical_line(di, al) {
    cyc(0x5f * 40);
    for (let i = 0; i < 0x5f; i++) {
      V[di & 0x3fff] = al;
      di ^= 0x2000;
      if (!(di & 0x2000)) di += 0x50;
    }
  }

  // ---- alley_drawing.asm --------------------------------------------------------------------------
  function clear_screen() {
    fillw(V, 0, 0xaaaa, 0xfa0);
    fillw(V, $.cga_bank1_base, 0xaaaa, 0xfa0);
    draw_alley_details();
    draw_block_list($.alley_base_block_list, 0);
    draw_difficulty_icon();
    draw_all_buildings();
    draw_all_windows();
    init_alley_objects();
  }

  // The alley as a backdrop (title screen and menu), with the bins of difficulty level 1.
  function draw_alley_scene() {
    fillw(V, 0, 0xaaaa, 0xfa0);
    fillw(V, $.cga_bank1_base, 0xaaaa, 0xfa0);
    draw_alley_details();
    draw_block_list($.alley_base_block_list, 0);
    draw_difficulty_icon();
    const ax = rw($.difficulty_level);
    ww($.difficulty_level, 1);
    draw_all_buildings();
    ww($.difficulty_level, ax);
  }

  function draw_difficulty_icon() {
    const bx = (rw($.diff_icon_idx) & 3) << 1;
    blit_to_cga(rw(bx + $.diff_icon_table), $.diff_icon_cga_pos, 0x801);
  }

  // Fills the three washing lines with laundry. The loop starts at index 0xF and stops before
  // 0, so it clears throw_col_data (alley_obj_state+1 onwards) but never alley_obj_state itself.
  function init_alley_objects() {
    for (let bx = 0xf; bx; bx--) wb(bx + $.alley_obj_state, 0);
    ww($.draw_row_offset, 0);
    draw_object_row(0x140, 0x80);
    ww($.draw_row_offset, 5);
    draw_object_row(0x640, 0x30);
    ww($.draw_row_offset, 0xa);
    draw_object_row(0xb40, 0);
    wb($.window_column, 0x10);
    ww($.current_floor, 0);
    wb($.throw_timer, 1);
  }

  function draw_object_row(di, bh) {
    wb($.draw_row_param, bh);
    wb($.draw_loop_count, 0);
    do {
      generate_throw_object($.throw_obj_buf, rb(rw($.difficulty_level) + $.throw_chance), rb($.draw_row_param));
      blit_to_cga($.throw_obj_buf, di, 0x1002);
      const n = rb($.draw_loop_count);
      const cl = ((~n) & 3) << 1;
      const a = (n >> 2) + rw($.draw_row_offset) + $.throw_col_data;
      wb(a, rb(a) | ((rb($.throw_bits) << cl) & 0xff));
      di += 4;
    } while (incb($.draw_loop_count) < 0x14);
  }

  // A block list: one dims word (rows:bytes), then (source, destination) word pairs until 0xFFFF.
  function draw_block_list(bx, ax) {
    const cx = rw(bx);
    ww($.draw_block_dims, cx);
    ww($.draw_block_base, ax);
    bx += 2;
    for (;;) {
      let si = rw(bx);
      if (si === 0xffff) return;
      let di = (rw(bx + 2) + rw($.draw_block_base)) & 0xffff;
      let rows = cx >> 8;
      const cols = cx & 0xff;
      ww($.draw_block_cols, cols);
      do {
        cyc(130 + cols * 25);
        for (let i = 0; i < cols; i++) V[(di + i) & 0x3fff] = rb(si++);
        di ^= 0x2000;
        if (!(di & 0x2000)) di += 0x50;
        rows = (rows - 1) & 0xff;
      } while (rows);
      bx += 4;
    }
  }

  function draw_window_strip(di) {
    for (let i = 0; i < 4; i++) { blit_to_cga($.window_sprite_data, di, 0x1005); di += 0x14; }
  }
  function draw_all_windows() {
    draw_window_strip(0x3c5);
    draw_window_strip(0x8c5);
    draw_window_strip(0xdc5);
  }

  // A row of random 8x8 tiles, the pavement fill, then randomly placed small detail sprites.
  function draw_alley_details() {
    for (let di = 0x1040; di < 0x1090; di += 2) {
      let dl;
      do { dl = random() & 0x30; } while (dl === rb($.draw_loop_count));
      wb($.draw_loop_count, dl);
      blit_to_cga(dl + 0x2904, di, 0x801);
    }
    fillw(V, $.sidewalk_fill_pos, 0x5655, 0x500);
    fillw(V, $.dat_3180, 0x5655, 0x500);
    for (let si = 0x2944; si < 0x296c; si += 0xa) {
      for (let i = 0; i < 9; i++) blit_to_cga(si, ((random() & 0x776) + 0x12c0) & 0xffff, 0x501);
    }
    for (let i = 0; i < 5; i++) blit_to_cga($.ground_extra_sprite, (random() & 0x3e) + 0x3a98, 0x501);
  }

  // A top, three middle sections (two from offset 0x1720 down), and a bottom.
  function draw_building(di) {
    ww($.draw_pos_tmp, di);
    wb($.draw_loop_count, di < 0x1720 ? 3 : 2);
    ww($.draw_pos_tmp, rw($.draw_pos_tmp) + 0x1e0);
    blit_to_cga($.building_top_sprite, di, 0xc05);
    do {
      const d = rw($.draw_pos_tmp);
      ww($.draw_pos_tmp, d + 0x140);
      blit_to_cga($.building_mid_sprite, d, 0x804);
    } while (decb($.draw_loop_count));
    blit_to_cga($.building_bottom_sprite, rw($.draw_pos_tmp), 0xb04);
  }

  function draw_all_buildings() {
    const d = rw($.difficulty_level);
    let bx = (d & 0xff00) | rb(d + $.building_offsets);
    for (;;) {
      ww($.draw_bx_save, bx);
      const di = rw(bx + $.building_pos_table);
      if (di === 0) return;
      draw_building(di);
      bx = rw($.draw_bx_save) + 2;
    }
  }

  // ---- sound.asm ----------------------------------------------------------------------------------
  // Everything is PC speaker: PIT channel 2 square waves gated through port 0x61, and noise made
  // by toggling the speaker bits directly. [0] is sound_enabled.
  const INT1A = 240;                     // sub ah,ah / int 1Ah, including the BIOS routine
  const snd = () => rb($.sound_enabled);
  function set_speaker_freq(ax) {
    cyc(107);
    out42(ax & 0xff);
    out42((ax >> 8) & 0xff);
    out61(in61() | 3);
  }
  function silence_speaker() { cyc(79); out61(in61() & 0xfc); }

  function play_music_note() {
    cyc(120);
    if (!snd()) return;
    const dx = bios_ticks();
    if (dx === rw($.title_music_tick)) return;
    ww($.title_music_tick, dx);
    const bx = rb(rw($.title_music_pos) + $.title_music_seq);
    if (bx === 0x66) { silence_speaker(); return; }
    incw($.title_music_pos);
    if (bx === 0) { silence_speaker(); return; }
    cyc(100);
    out43(0xb6);
    const ax = rw(bx + $.title_music_freqs);
    out42(ax & 0xff);
    out42(ax >> 8);
    out61(in61() | 3);
  }

  // Random variants of the alley's fence and wall decorations, from a per-difficulty list.
  function render_sprites() {
    const bx0 = (rw($.difficulty_level) & 7) << 1;
    let bx = rw(bx0 + $.sprite_list_ptrs);
    ww($.sprite_variant_base, (bx0 << 3) & 0xffff);
    for (;;) {
      const di = rw(bx);
      if (di === 0xffff) return;
      let si = rw(((random() & 0xe) + rw($.sprite_variant_base)) + $.sprite_variant_table);
      blit_to_cga(rw(si + $.sprite_data_ptrs), di, rw(si + $.sprite_dims_table));
      bx += 2;
    }
  }

  function init_chase_sound() {
    wb($.chase_intro_ticks, 0xc);
    ww($.chase_toggle, 1);
    ww($.chase_sweep_freq, 0x1ff);
    ww($.chase_freq_mask, 0xf);
    wb($.chase_tick_div, 1);
  }

  // Called every pass of the main loops: the fight noise, a short tone, or the next note of the
  // background music, which is generated on the fly (see init_music).
  function play_sound() {
    cyc(417);
    if (!snd()) return;
    if (rb($.enemy_active)) {
      const dx = bios_ticks();
      if (rb($.chase_intro_ticks) === 0) {
        if (dx === rw($.chase_last_tick)) return;
        ww($.chase_last_tick, dx);
        out43(0xb6);
        set_speaker_freq((rw($.chase_sweep_freq) & 0x1ff) + 0xc8);
        ww($.chase_sweep_freq, rw($.chase_sweep_freq) - 0x4b);
        return;
      }
      if (dx !== rw($.chase_last_tick)) { ww($.chase_last_tick, dx); decb($.chase_intro_ticks); }
      if (decb($.chase_tick_div) !== 0) return;
      wb($.chase_tick_div, rb($.rom_id) === 0xfd ? 1 : 2);
      if ((random() & 0xff) <= 4) incw($.chase_toggle);
      if (rw($.chase_toggle) & 1) ww($.chase_freq_mask, rw($.chase_freq_mask) + 7);
      out43(0xb6);
      set_speaker_freq(((random() & rw($.chase_freq_mask)) & 0x1ff) + 0x190);
      return;
    }
    const dx = bios_ticks();
    if (rb($.tone_duration)) {
      if (dx === rw($.tone_last_tick)) return;
      ww($.tone_last_tick, dx);
      if (decb($.tone_duration) === 0) { silence_speaker(); return; }
      out43(0xb6);
      set_speaker_freq(rw($.tone_freq));
      return;
    }
    if (dx === rw($.ambient_last_tick)) return;
    cyc(150);
    // Tune selector si: 0 alley, 1 rooms, 2 something falling at the cat, 3 dog about.
    let si = 3;
    if (!(rb($.enemy_chasing) | rb($.post_explode_ticks))) {
      si = 1;
      if (lvl() === 0) si = rb($.gravity_y) ? 2 : 0;
    }
    const di = si << 1;
    if (!(rb($.auto_walk) | rb($.post_explode_ticks))) {
      if (((dx - rw($.ambient_last_tick)) & 0xffff) < rw(di + $.ambient_tempo_table)) return;
    }
    ww($.ambient_last_tick, dx);
    cyc(200);
    let walk = rb($.enemy_chasing) !== 0;
    if (!walk && rb($.post_explode_ticks)) { decb($.post_explode_ticks); walk = true; }
    if (walk) {                                    // lab_5579: the dog's running notes
      ww($.ambient_duration, 0x1200);
      let bx = rw($.walk_note_index);
      if (bx >= 6) { bx = 0; ww($.walk_note_index, 0); }
      ww($.walk_note_index, rw($.walk_note_index) + 2);
      ww($.ambient_freq, rw(bx + $.walk_note_table));
      play_timed_tone();
      return;
    }
    if (si === 2) {
      ww($.ambient_freq, (rb($.gravity_y) << 4) + 0x200);
      ww($.ambient_duration, 0x1800);
      play_timed_tone();
      return;
    }
    ww($.ambient_duration, rw(di + $.ambient_base_dur));
    const r = rb($.ambient_rhythm);
    wb($.ambient_rhythm, r >> 1);
    if (r & 1) {
      ww($.ambient_duration, 0x1000);
      wb($.ambient_rhythm, 0x80);
      const al = incb($.ambient_note_pos) & rb(si + $.ambient_note_mask);
      if (al === 0) {
        wb($.ambient_pitch_acc, rb($.ambient_pitch_acc) + rb(si + $.ambient_pitch_step));
        const dl = random() & 0xff;
        if (dl <= rb(si + $.ambient_rand_thresh)) wb($.ambient_ornament, dl & 7);
        let d = (random() & 0xff) << 1;
        let cl = 1;
        if (d & 2) { cl = 0xff; d += 0x300; }
        ww($.ambient_freq, d);
        wb($.ambient_direction, cl);
      }
      wb($.ambient_note_pos, al | (rb($.ambient_pitch_acc) & rb(si + $.ambient_octave_mask)));
    }
    // lab_5623
    if (rb($.ambient_direction) !== 0xff) {
      ww($.walk_seq_index, rw($.walk_seq_index) + 2);
      ww($.ambient_freq, rw((rw($.walk_seq_index) & 0xe) + $.walk_note_table));
    } else {
      if (rw($.ambient_freq) <= 0xc8) ww($.ambient_freq, 0x500);
      ww($.ambient_freq, rw($.ambient_freq) - 0x19);
    }
    if (rb($.auto_walk)) {
      ww($.ambient_duration, 0x2000);
      wb($.ambient_direction, 0xff);
      play_timed_tone();
      return;
    }
    const bx = rb($.ambient_note_pos) + rw(di + $.ambient_rhythm_base);
    if (rb(bx + $.ambient_rhythm_pattern) & rb($.ambient_rhythm)) { play_timed_tone(); return; }
    if (!rb($.ambient_ornament)) return;
    decb($.ambient_ornament);
    ww($.ambient_duration, rw(di + $.ambient_accent_dur));
    play_timed_tone();
  }

  // Background flashes red (colour 4) for two ticks while the speaker bits are toggled with a
  // 32-entry pattern.
  async function play_explosion_effect() {
    silence_speaker();
    bios_set_palette(0, 4);
    ww($.explode_start_tick, bios_ticks());
    ww($.explode_counter, 0);
    wb($.explode_speed_shift, rb($.rom_id) === 0xfd ? 1 : 2);
    do {
      cyc(30);
      if (snd()) {
        cyc(110);
        incw($.explode_counter);
        const bx = (rw($.explode_counter) >> rb($.explode_speed_shift)) & 0x1f;
        out61(in61() ^ rb(bx + $.explode_pattern));
      }
      cyc(INT1A + 30);
      await sync();
    } while (((bios_ticks() - rw($.explode_start_tick)) & 0xffff) < 2);
    bios_set_palette(0, 0);
    wb($.post_explode_ticks, 0xc);
    silence_speaker();
  }

  function init_buzz_sound() { ww($.buzz_phase, rb($.rom_id) === 0xfd ? 0x400 : 0x200); }
  function update_buzz_sound() {
    cyc(150);
    const bx = incw($.buzz_phase);
    const cl = (bx >> 9) & 0xf;
    const dl = rb(((bx >> cl) & 0xf) + $.buzz_pattern) & rb(0);
    out61((in61() & 0xfc) | dl);
  }

  async function play_swoop_sound() {
    ww($.swoop_freq, 0x1f4);
    do { play_delayed_tone(); ww($.swoop_freq, rw($.swoop_freq) - 0x1e); await sync(); } while (rw($.swoop_freq) > 0xc8);
    ww($.swoop_freq, 0x1f4);
    do { play_delayed_tone(); ww($.swoop_freq, rw($.swoop_freq) - 0x14); await sync(); } while (rw($.swoop_freq) > 0x12c);
    do { play_delayed_tone(); ww($.swoop_freq, rw($.swoop_freq) + 0x1e); await sync(); } while (rw($.swoop_freq) < 0x320);
    silence_speaker();
  }
  function play_delayed_tone() {
    cyc((rb($.rom_id) === 0xfd ? 0x800 : 0x1000) * LOOP);
    if (!snd()) return;
    out43(0xb6);
    const ax = rw($.swoop_freq);
    out42(ax & 0xff);
    out42(ax >> 8);
    out61(in61() | 3);
  }

  function reset_noise() {
    silence_speaker();
    wb($.noise_counter, 0);
    ww($.noise_period, 8);
  }
  // Pulse-width noise: speaker bit 1 is on for part of every 64 calls, a part that shrinks as
  // noise_period grows.
  function update_noise() {
    cyc(120);
    const al = incb($.noise_counter) & 0x3f;
    if (!al) incw($.noise_period);
    const bl = (rw($.noise_period) >> 2) & 0x1f;
    const dl = (al >= bl ? 2 : 0) & snd();
    out61((in61() & 0xfd) | dl);
  }

  function init_result_melody() {
    ww($.result_melody_pos, 0);
    ww($.result_melody_tick, bios_ticks());
  }
  function play_result_note() {
    cyc(60);
    if (!snd()) return;
    const dx = bios_ticks();
    cyc(INT1A);
    if (((dx - rw($.result_melody_tick)) & 0xffff) < 2) return;
    ww($.result_melody_tick, dx);
    const bx = rw($.result_melody_pos);
    ww($.result_melody_pos, bx + 2);
    let ax;
    if (rb($.object_hit)) {
      ax = rw(bx + $.result_melody_bonus);
      if (!ax) { silence_speaker(); return; }
    } else ax = rw(bx + $.result_melody_normal);
    out43(0xb6);
    set_speaker_freq(ax);
  }

  function init_level_melody() {
    ww($.level_melody_pos, 0);
    wb($.level_note_toggle, 0);
  }
  function play_level_note() {
    cyc(60);
    if (!snd()) return;
    const dx = bios_ticks();
    cyc(INT1A);
    if (dx === rw($.level_note_tick)) return;
    ww($.level_note_tick, dx);
    incb($.level_note_toggle);
    out43(0xb6);
    let bx = rw($.level_melody_pos);
    if (!(rb($.level_note_toggle) & 1)) bx += 2;
    set_speaker_freq(rw(bx + $.level_melody_notes));
  }
  function play_melody_step() {
    cyc(60);
    if (!snd()) return;
    out43(0xb6);
    const bx = rw($.level_melody_pos);
    ww($.level_melody_pos, bx + 2);
    set_speaker_freq(rw(bx + $.level_melody_notes));
  }

  function wipe_sound_start() {}
  function play_wipe_note() {
    cyc(60);
    if (!snd()) return;
    out43(0xb6);
    const bx = rw($.wipe_note_index) & 6;
    ww($.wipe_note_index, rw($.wipe_note_index) + 2);
    set_speaker_freq(rw(bx + $.wipe_note_table));
  }

  function init_music() {
    wb($.ambient_rhythm, 0x80);
    wb($.ambient_note_pos, 0);
    wb($.ambient_pitch_acc, 0);
    ww($.ambient_freq, 0x500);
    wb($.ambient_direction, 0xff);
    wb($.ambient_ornament, 0);
    wb($.tone_duration, 0);
    wb($.post_explode_ticks, 0);
    ww($.meow_pitch_offset, 0);
    ww($.chase_toggle, 1);
    wb($.chase_tick_div, 1);
  }

  function play_catch_sound() {
    if (!rb($.enemy_chasing)) play_tone(0x390, 0x1800);
    wb($.door_contact, 0);
  }
  function play_hit_sound() {
    if (!rb($.enemy_chasing)) play_tone(0x400, 0x1800);
  }
  function play_death_melody() {
    play_tone(0x7d0, 0x1800);
    play_tone(0xa6e, 0x1800);
    play_tone(0xdec, 0x1800);
  }

  // Starts a tone of divisor ax that switches to divisor bx on the next tick and stops on the
  // one after (play_sound counts tone_duration down).
  function start_tone(ax, bx) {
    cyc(438);
    if (!snd()) return;
    ww($.tone_freq, bx);
    out43(0xb6);
    set_speaker_freq(ax);
    wb($.tone_duration, 2);
    ww($.tone_last_tick, bios_ticks());
  }
  function play_random_chirp() {
    cyc(40);
    if (!snd() || rb($.tone_duration)) return;
    const ax = (random() & 0x7f) + 0xaa;
    start_tone(ax + 0x1e, ax);
  }
  // Each call is pitched lower than the last (meow_pitch_offset grows by 0x15E).
  function play_meow_sound() {
    if (!snd()) return;
    const off = rw($.meow_pitch_offset);
    ww($.meow_pitch_offset, off + 0x15e);
    start_tone((0x1200 + off) & 0xffff, ($.meow_sound_data + off) & 0xffff);
    wb($.post_explode_ticks, 0x18);
  }

  // A tone held for a LOOP delay of cx iterations: the CPU does nothing else meanwhile.
  function play_tone(bx, cx) {
    cyc(60);
    if (!snd()) return;
    out43(0xb6);
    out42(bx & 0xff);
    out42(bx >> 8);
    out61(in61() | 3);
    if (rb($.rom_id) === 0xfd) cx >>= 1;
    cyc((cx || 0x10000) * LOOP);
    silence_speaker();
  }

  // Seven ticks: two of silence, then the speaker bit is flipped at random at a rate that slows
  // down as hiss_phase grows.
  async function play_hiss_sound() {
    out61(in61() & 0xfe);
    ww($.hiss_start_tick, bios_ticks());
    ww($.hiss_phase, 0);
    for (;;) {
      let cx = rw($.hiss_phase) >> 6;
      if (!cx) cx = 1;
      for (;;) {
        cyc(INT1A + 50);
        const dx = (bios_ticks() - rw($.hiss_start_tick)) & 0xffff;
        if (dx < 2) { await sync(); continue; }
        if (dx >= 7) { silence_speaker(); return; }
        cyc(LOOP);
        if (--cx === 0) break;
      }
      const dl = random() & 2 & snd();
      out61(in61() ^ dl);
      ww($.hiss_phase, rw($.hiss_phase) + 7);
      cyc(120);
      await sync();
    }
  }

  // Each call that comes more than 0x260 PIT counts after the last sets a new pitch: a slow
  // rise (fall_sound_y) plus a wobble from a table.
  function play_falling_sound() {
    cyc(40);
    if (!snd()) return;
    const ax = read_pit_timer();
    const bx = rw($.fall_snd_pit_prev) - ax;
    if (bx >= 0 && bx <= 0x260) return;
    cyc(300);
    ww($.fall_snd_pit_prev, ax);
    out43(0xb6);
    const b = incw($.fall_snd_wobble_idx) & 0x1e;
    let a = rw($.fall_sound_x) & 0x3ff;
    if (a >= 0x180) a = (0x180 - a) & 0xffff;
    a = ((a >> 2) + rw(b + $.fall_snd_wobble)) & 0xffff;
    const inc = rb($.rom_id) === 0xfd ? 2 : 1;
    ww($.fall_sound_y, rw($.fall_sound_y) + inc);
    ww($.fall_sound_x, rw($.fall_sound_x) + (inc << 2));
    a = (a + (rw($.fall_sound_y) >> 3)) & 0xffff;
    out42(a & 0xff);
    out42(a >> 8);
    out61(in61() | 3);
  }

  function play_random_noise() {
    cyc(60);
    if (!snd()) return;
    const dx = bios_ticks();
    cyc(INT1A);
    if (dx === rw($.rand_noise_tick)) return;
    ww($.rand_noise_tick, dx);
    out43(0xb6);
    const ax = (random() & 0x70) + 0x200;
    out42(ax & 0xff);
    out42(ax >> 8);
    out61(in61() | 3);
  }

  // Two ticks of random pitches, a new one whenever the PIT counter has moved at all.
  async function play_crash_sound() {
    ww($.crash_base_freq, 0x338);
    ww($.crash_start_tick, bios_ticks());
    ww($.crash_pit_prev, read_pit_timer());
    do {
      const ax = read_pit_timer();
      cyc(40);
      if (((ax - rw($.crash_pit_prev)) & 0xffff) >= 0x9c40) {
        ww($.crash_pit_prev, ax);
        if (snd()) {
          cyc(250);
          out43(0xb6);
          const f = ((random() & 0x7ff) + rw($.crash_base_freq)) & 0xffff;
          ww($.crash_base_freq, rw($.crash_base_freq) - 2);
          out42(f & 0xff);
          out42(f >> 8);
          out61(in61() | 3);
        }
      }
      cyc(INT1A + 30);
      await sync();
    } while (((bios_ticks() - rw($.crash_start_tick)) & 0xffff) < 2);
    silence_speaker();
  }

  // A note held for ambient_duration PIT counts (two counts per 1.19 MHz clock).
  function play_timed_tone() {
    cyc(150);
    out43(0xb6);
    const ax = rw($.ambient_freq);
    out42(ax & 0xff);
    out42(ax >> 8);
    out61(in61() | 3);
    const cx = read_pit_timer();
    while (((cx - read_pit_timer()) & 0xffff) < rw($.ambient_duration)) cyc(40);
    out61(in61() & 0xfc);
  }

  function init_victory_melody() {
    ww($.victory_melody_pos, 0);
    ww($.victory_last_tick, bios_ticks());
  }
  function play_victory_note() {
    cyc(60);
    if (!snd()) return;
    const dx = bios_ticks();
    cyc(INT1A);
    if (((dx - rw($.victory_last_tick)) & 0xffff) < 2) return;
    ww($.victory_last_tick, dx);
    let bx = rw($.victory_melody_pos) & 0xfe;
    if (bx >= 0x86) { bx = 0; ww($.victory_melody_pos, 0); }
    ww($.victory_melody_pos, rw($.victory_melody_pos) + 2);
    const ax = rw(bx + $.victory_melody);
    const cx = rw($.victory_prev_freq);
    ww($.victory_prev_freq, ax);
    if (ax === cx) { silence_speaker(); return; }
    out43(0xb6);
    out42(ax & 0xff);
    out42(ax >> 8);
    out61(in61() | 3);
  }
  async function play_full_victory() {
    while (snd()) {
      play_victory_note();
      cyc(40);
      await sync();
      if (rw($.victory_melody_pos) >= 0x7c) break;
    }
  }

  // An animation in two frames, every 4 ticks, with the result melody playing; a picture is
  // added at step 4, and the text sprite is drawn at three positions from step 8.
  async function show_extra_life() {
    ww($.extralife_tick, bios_ticks());
    ww($.extralife_anim_step, 0);
    do {
      const bx = rw($.extralife_anim_step);
      ww($.extralife_anim_step, bx + 2);
      blit_to_cga(rw((bx & 2) + $.extralife_sprites), 0xa74, 0x4404);
      let dx;
      do { play_result_note(); cyc(INT1A + 30); await sync(); dx = bios_ticks(); }
      while (((dx - rw($.extralife_tick)) & 0xffff) < 4);
      ww($.extralife_tick, dx);
      if (rw($.extralife_anim_step) === 4) blit_to_cga($.extralife_icon_data, 0x668, 0x1004);
      const b = rw($.extralife_anim_step) - 8;
      if (b >= 0 && b < 6) blit_to_cga($.extralife_text_data, rw(b + $.extralife_text_pos), 0x1506);
    } while (rw($.extralife_anim_step) < 0x10);
    silence_speaker();
  }

  // ---- ui.asm -------------------------------------------------------------------------------------
  // On a colour adapter (equipment bits 4-5 = 0x20) detect_video does nothing.
  function detect_video() { cyc(100); }

  // Busy-waits until keyboard_counter changes (a key went down).
  async function wait_key_counter() {
    const ax = rw($.keyboard_counter);
    while (ax === rw($.keyboard_counter)) { cyc(1000); await sync(); }
  }

  // The title: logo, credits and a cat walking about on the fence, with the title music.
  // The first time, it moves on to the options menu shortly after the music; after that it
  // repeats the music until a key is pressed.
  async function show_title_screen() {
    ww($.level_number, 0);
    init_player();
    init_objects();
    draw_alley_scene();
    blit_to_cga(0x6152, 0xbd, 0x1d0b);
    blit_to_cga(0x63d0, 0x69e, 0x160e);
    blit_to_cga(0x6638, 0xa78, 0xc03);
    blit_to_cga(0x6680, 0xca8, 0x80e);
    blit_to_cga(0x6760, 0x1d6e, 0xb0c);
    blit_to_cga(0x6868, 0x1dec, 0x804);
    ww($.attract_anim_idx, 0);
    animate_title_icon();
    ww($.cat_x, 0);
    setup_alley();
    wb($.cat_y, 0x60);
    wb($.cat_y_bottom, 0x92);
    draw_score();
    draw_high_score();
    wb($.lives_count, 9);
    wb($.lives_display, 0xff);
    draw_lives();
    init_sound();
    wb($.input_horizontal, 0);
    wb($.input_vertical, 0);
    wb($.attract_key_pressed, 0);
    ww($.attract_save_int, rw($.keyboard_counter));
    for (;;) {                                     // lab_5d54
      let dx = bios_ticks();
      ww($.attract_last_tick, dx);
      ww($.title_music_tick, dx);
      ww($.attract_frame_tick, dx);
      ww($.attract_start_tick, dx - 0x30);
      ww($.title_music_pos, 0);
      for (;;) {                                   // lab_5d71
        cyc(INT1A + 60);
        dx = bios_ticks();
        if (((dx - rw($.attract_frame_tick)) & 0xffff) >= 0x24) {
          ww($.attract_frame_tick, dx);
          animate_title_icon();
        }
        const d = (dx - rw($.attract_last_tick)) & 0xffff;
        if (rb($.attract_shown)) { if (d >= rw($.attract_timing) + 0x48) break; }
        else if (d > rw($.attract_timing) + 6) return;
        play_music_note();
        await move_title_cat();
        if (rw($.attract_save_int) !== rw($.keyboard_counter)) return;
        await sync();
      }
    }
  }

  // The title cat walks between x=0x20 and 0x120, changing its mind every 0x12 ticks.
  async function move_title_cat() {
    cyc(80);
    if (rw($.cat_x) <= 0x20) wb($.input_horizontal, 1);
    else if (rw($.cat_x) >= 0x120) wb($.input_horizontal, 0xff);
    else {
      const dx = bios_ticks();
      cyc(INT1A);
      if (((dx - rw($.attract_start_tick)) & 0xffff) >= 0x12) {
        ww($.attract_start_tick, dx);
        const dl = random() & 0xff;
        wb($.input_horizontal, 0);
        if (dl <= 0xa0) wb($.input_horizontal, (dl & 1) ? 1 : 0xff);
      }
    }
    if (check_vsync()) {
      ww($.scroll_speed, 4);
      await update_animation();
    }
  }

  // INT 10h teletype in colour 2, up to a 0 byte.
  function print_string(si) {
    for (;;) {
      const al = rb(si++);
      if (!al) return si;
      cyc(1900 + 60);
      bios_teletype(al, 2);
    }
  }

  function animate_title_icon() {
    ww($.attract_anim_idx, rw($.attract_anim_idx) + 2);
    blit_to_cga(rw((rw($.attract_anim_idx) & 2) + $.attract_icon_ptrs), 0x1d38, 0xc0a);
  }

  function set_cursor(dh) { cyc(200); bios_set_cursor(dh, 0); }

  // Esc: the "PAWS" box. The tick count is put back afterwards, so tick-based timers ignore
  // the pause.
  async function show_pause_menu() {
    silence_speaker();
    const t = bios_ticks();
    ww($.title_saved_cx, t);
    save_from_cga(0xdca, 0xe, 0x1020);
    cyc(200);
    bios_set_cursor(0xb, 5);
    print_string($.str_paws_game);
    cyc(200);
    bios_set_cursor(0xc, 5);
    print_string(rb($.use_joystick) ? $.str_button_continue : $.str_key_continue);
    await wait_for_input();
    blit_to_cga(0xe, 0xdca, 0x1020);
    bios_set_ticks(rw($.title_saved_cx));
    ww($.pause_counter, rw($.keyboard_counter));
  }

  // The options screens: keyboard or joystick (Y/N), then the difficulty (K, H, T or A), then
  // the controls.
  async function show_attract_mode() {
    silence_speaker();
    outer: for (;;) {                              // lab_5ee8
      clear_cga();
      ww($.title_joy_offset, 0);
      display_text_line();
      for (;;) {
        await wait_key_counter();
        if (!(rb(0x6c1) & 0x80)) {                 // Y
          if (await detect_joystick()) continue outer;
          wb($.use_joystick, 1);
          break outer;
        }
        if (!(rb(0x6c2) & 0x80)) {                 // N
          wb($.use_joystick, 0);
          break outer;
        }
      }
    }
    for (let i = 0; i < 5; i++) display_text_line();
    let ax;
    for (;;) {
      await wait_key_counter();
      if (!(rb(0x6c3) & 0x80)) { ax = 0; break; }  // K
      if (!(rb(0x6c4) & 0x80)) { ax = 1; break; }  // H
      if (!(rb(0x6c5) & 0x80)) { ax = 2; break; }  // T
      if (!(rb(0x6c6) & 0x80)) { ax = 3; break; }  // A
    }
    ww($.difficulty_counter, ax);
    for (let i = 0; i < 5; i++) display_text_line();
    if (rb($.use_joystick)) {
      ww($.title_joy_offset, 0x20);
      display_text_line();
      display_text_line();
      ww($.title_joy_offset, 0x18);
      display_text_line();
      display_text_line();
    } else {
      ww($.title_joy_offset, 0x1c);
      display_text_line();
      display_text_line();
      ww($.title_joy_offset, 0x16);
      display_text_line();
    }
    await wait_for_input();
  }

  async function wait_for_input() {
    // The joystick branch (wait for button 1 on port 0x201) is unreachable without one.
    await wait_key_counter();
  }

  // One line of the options text: row from one table (column forced to 0), string from another.
  function display_text_line() {
    const bx = rw($.title_joy_offset);
    set_cursor(rw(bx + $.attract_icon_sprite_b) >> 8);
    ww($.title_joy_offset, bx + 2);
    print_string(rw(bx + $.attract_icon_sprite_a));
  }

  function clear_cga() {
    fillw(V, 0, 0, 0xfa0);
    fillw(V, $.cga_bank1_base, 0, 0xfa0);
  }

  // INT 11h equipment bit 12 (game port) is clear on the emulated machine, so this always
  // shows the "no joystick" lines and waits for a key.
  async function detect_joystick() {
    cyc(200);
    ww($.title_joy_offset, 0x24);
    for (let i = 0; i < 4; i++) display_text_line();
    await wait_key_counter();
    return true;
  }

  // Back in the alley after the love scene: a sprite slides down the screen with a falling
  // tone, then a final picture and an alternating two-note signal for the rest of 0x12 ticks.
  async function love_scene_outro() {
    for (let i = 0; i < 0x48; i++) wb(0xe + i, 0);
    ww($.title_scroll_pos, 0x25);
    do {
      while (!check_vsync()) { cyc(20); await sync(); }
      blit_to_cga(0xe, rw($.title_scroll_pos), 0xc03);
      ww($.title_scroll_pos, rw($.title_scroll_pos) + 0x1e0);
      blit_to_cga(0x6e10, rw($.title_scroll_pos), 0xc03);
      let dx;
      do { cyc(INT1A + 30); dx = bios_ticks(); await sync(); } while (dx === rw($.title_scroll_tick_1));
      ww($.title_scroll_tick_1, dx);
      if (snd()) {
        out43(0xb6);
        const ax = rw($.title_scroll_pos) >> 1;
        out42(ax & 0xff);
        out42(ax >> 8);
        out61(in61() | 3);
      }
    } while (rw($.title_scroll_pos) < 0x1a40);
    blit_to_cga(0x6e58, rw($.title_scroll_pos), 0x1106);
    let dx;
    do {
      do { cyc(INT1A + 30); dx = bios_ticks(); await sync(); } while (dx === rw($.title_scroll_tick_2));
      ww($.title_scroll_tick_2, dx);
      if (snd()) {
        out43(0xb6);
        const ax = (dx & 1) ? 0xb54 : 0xc00;
        out42(ax & 0xff);
        out42(ax >> 8);
      }
    } while (((dx - rw($.title_scroll_tick_1)) & 0xffff) < 0x12);
    silence_speaker();
  }

  // ---- ui.asm: the love scene's falling cupid -------------------------------------------------
  function reset_cupid() { wb($.cupid_active, 0); }

  // One step per tick: enters from a side at one of 8 heights, or from the top at one of 10
  // columns, and moves diagonally down 2 and across 5 pixels. Passing a window opens or
  // closes it; touching the cat knocks it down.
  function update_cupid() {
    cyc(313);
    const dx = bios_ticks();
    if (dx === rw($.cupid_anim_tick)) return;
    ww($.cupid_anim_tick, dx);
    if (check_cupid_collision()) {
      restore_alley_buffer();
      erase_cupid();
      draw_alley_foreground();
      wb($.cupid_active, 0);
      return;
    }
    if (!rb($.cupid_active)) {
      for (;;) {
        let bx = random() & 0x1f;
        if (bx < 0x10) {
          let ax = 0xc, dl = 1;
          if (bx & 8) { ax = 0x120; dl = 0xff; }
          ww($.cupid_x, ax);
          wb($.cupid_dir, dl);
          wb($.cupid_y, rb((bx & 7) + 0x70b0) + 8);
          break;
        }
        bx -= 0x10;
        if (bx > 9) continue;
        wb($.cupid_dir, bx < 5 ? 1 : 0xff);
        wb($.cupid_y, 6);
        ww($.cupid_x, rw((bx << 1) + 0x70b8) + 4);
        break;
      }
      wb($.cupid_active, 1);
      wb($.cupid_drawn, 1);
      ww($.cupid_arrow_x, 0);
      ww($.cupid_prev_x, 0xffff);
    }
    if (rw($.cupid_arrow_x) < 0xa0) ww($.cupid_arrow_x, rw($.cupid_arrow_x) + 4);
    wb($.cupid_y, rb($.cupid_y) + 2);
    let gone = rb($.cupid_y) > 0xbf;
    if (!gone) {
      if (rb($.cupid_dir) === 1) { ww($.cupid_x, rw($.cupid_x) + 5); gone = rw($.cupid_x) >= 0x12c; }
      else { const x = rw($.cupid_x) - 5; ww($.cupid_x, x); gone = x < 0; }
    }
    if (!gone) {
      ww($.cupid_draw_addr, calc_cga_addr(rw($.cupid_x), rb($.cupid_y)));
      gone = check_cupid_collision();
    }
    if (gone) { wb($.cupid_active, 0); erase_cupid(); return; }
    cupid_toggle_window();
    erase_cupid();
    draw_cupid();
  }

  function draw_cupid() {
    wb($.cupid_drawn, 0);
    let ax = (rw($.cupid_arrow_x) & 0x1e0) + 0x6f30;
    if (rb($.cupid_dir) !== 0xff) ax += 0xc0;
    const di = rw($.cupid_draw_addr);
    ww($.cupid_erase_addr, di);
    blit_transparent(ax, di, 0x802, 0x70cc);
  }

  function erase_cupid() {
    cyc(83);
    if (rb($.cupid_drawn)) return;
    blit_to_cga(0x70cc, rw($.cupid_erase_addr), 0x802);
  }

  function cupid_toggle_window() {
    cyc(300);
    const al = (rb($.cupid_y) - 8) & 0xf8;
    let bx = -1;
    for (let cx = 7; cx >= 1; cx--) if (al === rb(cx - 1 + $.window_row_y_table)) { bx = cx - 1; break; }
    if (bx < 0) return;
    let ax = (rw($.cupid_x) >> 4) - 2;
    if (ax < 0 || ax >= 0x10) return;
    const di = ax;
    ax += rb(bx + $.window_row_col_offset);
    if (ax === rw($.cupid_prev_x)) return;
    ww($.cupid_prev_x, ax);
    wb(ax + $.window_open_state, rb(ax + $.window_open_state) ^ 2);
    const state = rb(ax + $.window_open_state);
    const cx = rw((di << 1) + $.cupid_sprite_offset);
    const dl = rb(bx + $.cupid_sprite_end);
    erase_cupid();
    draw_bg_tile(state, cx, dl);
    draw_cupid();
  }

  function check_cupid_collision() {
    cyc(79);
    if (!rb($.cupid_active)) return false;
    if (!rect(rw($.cupid_x), rb($.cupid_y), 0x10, 0xe08, rw($.cat_x), rb($.cat_y), 0x18)) return false;
    wb($.in_level_mode, 1);
    wb($.anim_counter, 2);
    wb($.anim_step, 0x20);
    wb($.transition_timer, 8);
    start_tone(0x91d, 0xce4);
    return true;
  }

  // ---- level_objects.asm: level 7, the love scene ---------------------------------------------
  // Fire puts down the carried object (see tick_level_thrown_objects) at the cat's x, on the
  // window row nearest the cat's y, unless it would overlap another one.
  function spawn_thrown_object() {
    cyc(100);
    if (rw($.l7_obj_spawn_slot) >= 8) return;
    if (rb($.joy_button)) return;
    ww($.l7_obj_closest_row, 0xffff);
    wb($.l7_obj_closest_dist, 0xff);
    for (let cx = 7; cx >= 1; cx--) {
      const bx = cx - 1;
      let al = rb($.cat_y) - rb(bx + $.window_row_y_table);
      if (al < 0) al = ~al & 0xff;
      cyc(60);
      if (al <= rb($.l7_obj_closest_dist)) { wb($.l7_obj_closest_dist, al); ww($.l7_obj_closest_row, bx); }
    }
    if (rw(0x2e92) === 0xffff) ww($.l7_obj_closest_row, 0);
    const slot = rw($.l7_obj_spawn_slot);
    const y = rb(rw($.l7_obj_closest_row) + $.window_row_y_table);
    wb(slot + $.l7_obj_y, y);
    wb($.l7_obj_cur_y, y);
    let ax = rw($.cat_x);
    if (ax >= 0x108) ax = 0x107;
    ax &= 0xffc;
    ww(((slot << 1) & 0xff) + $.l7_obj_x, ax);
    ww($.l7_obj_cur_x, ax);
    for (let cx = 8; cx >= 1; cx--) {
      const b = cx - 1;
      if (b === rw($.l7_obj_spawn_slot) || !rb(b + $.l7_obj_active)) continue;
      if (rect(rw(b * 2 + $.l7_obj_x), rb(b + $.l7_obj_y), 0x18, 0xf0f, rw($.l7_obj_cur_x), rb($.l7_obj_cur_y), 0x18)) return;
    }
    restore_alley_buffer();
    if (rb($.cupid_active)) erase_cupid();
    const bx = rw($.l7_obj_spawn_slot);
    ww($.l7_obj_last_picked, bx);
    wb(bx + $.l7_obj_active, 1);
    blit_to_cga($.l7_obj_sprite, calc_cga_addr(rw(bx * 2 + $.l7_obj_x), rb(bx + $.l7_obj_y)), 0xf03);
    ww($.l7_obj_spawn_slot, 0xffff);
    bios_set_palette(0, 0);
    check_l7_all_objects();
    if (rb($.cupid_active)) draw_cupid();
    draw_alley_foreground();
    start_tone(0x3e8, 0x4a5);
  }

  // Walking into one of the 8 objects picks it up (the background is colour 1 while carrying).
  function tick_level_thrown_objects() {
    cyc(313);
    const dx = bios_ticks();
    if (dx === rw($.l7_obj_last_tick)) return;
    ww($.l7_obj_last_tick, dx);
    if (rw($.l7_obj_spawn_slot) >= 8) {
      for (let cx = 8; cx >= 1; cx--) {
        const b = cx - 1;
        if (!rb(b + $.l7_obj_active)) continue;
        if (!rect(rw(b * 2 + $.l7_obj_x), rb(b + $.l7_obj_y), 0x18, 0xe0f, rw($.cat_x), rb($.cat_y), 0x18)) continue;
        if (b === rw($.l7_obj_last_picked)) return;
        restore_alley_buffer();
        if (rb($.cupid_active)) erase_cupid();
        wb(b + $.l7_obj_active, 0);
        ww($.l7_obj_spawn_slot, b);
        blit_to_cga($.l7_obj_erase_sprite, calc_cga_addr(rw(b * 2 + $.l7_obj_x), rb(b + $.l7_obj_y)), 0xf03);
        if (rb($.cupid_active)) draw_cupid();
        draw_alley_foreground();
        bios_set_palette(0, 1);
        start_tone(0x3e8, 0x349);
        return;
      }
    }
    ww($.l7_obj_last_picked, 0xffff);
  }

  // Seven rows of 16 tiles, each state 0 or 2 at random (all 0 on the bottom row), and as many
  // objects on the floor as rooms won so far (elapsed_ticks, at least 1, at most 8).
  function draw_love_scene_bg() {
    draw_block_list($.l7_bg_block_list, 0);
    wb($.l7_obj_draw_y, 0xbf);
    ww($.l7_obj_row_index, 0);
    do {
      ww($.l7_obj_draw_x, 0x20);
      do {
        let bx = 0;
        if (rb($.l7_obj_draw_y) !== 0xbf) bx = random() & 2;
        draw_bg_tile(bx, rw($.l7_obj_draw_x), rb($.l7_obj_draw_y));
        let ax = (rw($.l7_obj_draw_x) >> 4) - 2;
        if (ax < 0) ax = 0;
        if (ax >= 0x12) ax = 0x11;
        ax += rb(rw($.l7_obj_row_index) + $.window_row_col_offset);
        wb(ax + $.window_open_state, bx);
        ww($.l7_obj_draw_x, rw($.l7_obj_draw_x) + 0x10);
      } while (rw($.l7_obj_draw_x) < 0x111);
      incw($.l7_obj_row_index);
      wb($.l7_obj_draw_y, rb($.l7_obj_draw_y) - 0x18);
    } while (rb($.l7_obj_draw_y) >= 0x2f);
    ww($.l7_obj_spawn_slot, 0xffff);
    ww($.l7_obj_last_picked, 0xffff);
    for (let i = 0; i < 8; i++) wb($.l7_obj_active + i, 0);
    let cx = rw($.elapsed_ticks);
    if (cx === 0) { cx = 1; ww($.elapsed_ticks, 1); }
    if (cx > 8) cx = 8;
    for (; cx >= 1; cx--) {
      const b = cx - 1;
      wb(b + $.l7_obj_active, 1);
      wb(b + $.l7_obj_y, 0xb0);
      const x = rw(b * 2 + $.l7_obj_init_x_table);
      ww(b * 2 + $.l7_obj_x, x);
      blit_to_cga($.l7_obj_sprite, calc_cga_addr(x, 0xb0), 0xf03);
    }
  }

  function draw_bg_tile(bx, cx, dl) {
    blit_to_cga(rw(bx + $.l7_bg_tile_ptrs), calc_cga_addr(cx, dl), 0x802);
  }

  // Level 7 floors: the cat can stand on a tile whose window_open_state is 0.
  function check_stairs_collision() {
    cyc(510);
    const al = (rb($.cat_y) - 5) & 0xf8;
    let bx = -1;
    for (let cx = 7; cx >= 1; cx--) if (al === rb(cx - 1 + $.window_row_y_table)) { bx = cx - 1; break; }
    if (bx < 0) return false;
    let ax = (((rw($.cat_x) + 7) & 0xffff) >> 4) - 2;
    if (ax < 0) ax = 0;
    if (ax >= 0x12) ax = 0x11;
    ax += rb(bx + $.window_row_col_offset);
    if (rb(ax + $.window_open_state)) return false;
    wb($.cat_y, al + 5);
    wb($.cat_y_bottom, al + 5 + 0x32);
    return true;
  }

  // ---- level_objects.asm: the broom (rooms 1 and 3-6) -------------------------------------------
  // The broom wanders, homes in on the cat now and then, and sweeps away footprints
  // (l1_bg_sprite, one counter per 8-pixel column) at floor level.
  function tick_thrown_objects() {
    cyc(386);
    const dx = bios_ticks();
    if (((dx - rw(0x328c)) & 0xffff) < rw(((lvl() << 1) & 0xff) + 0x32f2)) return;
    ww(0x328c, dx);
    if (check_thrown_cat_hit()) return;
    if (check_enemy_object_hit()) return;
    cyc(300);
    incb(0x32ea);
    const r = random() & 0xff;
    wb(0x32eb, rb(0x32eb) ^ (rb(0x32ea) & r));
    let ax = rw($.thrown_obj_x) - rw($.cat_x), d = 0xff;
    if (ax < 0) { ax = ~ax & 0xffff; d = 1; }
    wb(0x32ed, d);
    let b = ((rb($.thrown_obj_y) + 0x14) & 0xff) - rb($.cat_y);
    d = 0xff;
    if (b < 0) { b = ~b & 0xff; d = 1; }
    wb(0x32ee, d);
    wb(0x32ec, ((ax >> 2) + (b >> 1)) & 0xff);
    let bx = rw(0x328a);
    if (bx >= 0x27) { bx = 0x26; ww(0x328a, bx); }
    if (rb(bx + $.l1_bg_sprite) === 0) {
      decw(0x328a);
      const t = (((bios_ticks() - rw($.game_tick)) & 0xffff) >> 3) & 0xff;
      let al = rb(0x32ec) - t;
      if (al < 0) al = 0;
      if (al >= rb(0x32eb)) {
        wb(0x3281, 1);
        const dl = random() & 0xff;
        if (dl === 0) wb(0x3280, 0);
        else if (dl <= 7) wb(0x3280, (dl & 1) ? 1 : 0xff);
      } else {
        const a = rb(0x32eb) & 0x2f;
        if (a === 0) {
          wb(0x3280, (random() & 1) ? 1 : 0xff);
          wb(0x3281, (random() & 1) ? 1 : 0xff);
        } else if ((a & 7) === 0) {
          wb(0x3280, rb(0x32ed));
          wb(0x3281, rb(0x32ee));
        }
      }
    } else {
      wb(0x3281, 1);
      const fx = (bx << 3) & 0xffff;
      if (rw($.thrown_obj_x) !== fx) wb(0x3280, rw($.thrown_obj_x) < fx ? 1 : 0xff);
      else {
        wb(0x3280, 0);
        if (rb($.thrown_obj_y) === 0xa5) {
          wb(0x3281, 0);
          if (rw(0x327a) === 6 || rw(0x327a) === 0x12) {
            blit_to_cga($.l1_sprite_data, rw(0x3282), 0x1e02);
            decb(bx + $.l1_bg_sprite);
            draw_footprint_tile(bx, rb(bx + $.l1_bg_sprite));
            wb(0x3286, 1);
          }
        }
      }
    }
    // lab_32ac
    let cx = rw($.thrown_obj_x);
    let dl = rb($.thrown_obj_y);
    ww(0x32ef, cx);
    wb(0x32f1, dl);
    const hx = rb(0x3280);
    if (hx === 1) { cx += 8; if (cx >= 0x131) cx = 0x130; }
    else if (hx !== 0) { cx -= 8; if (cx < 0) cx = 0; }
    cx &= 0xfff8;
    ww($.thrown_obj_x, cx);
    const hy = rb(0x3281);
    if (hy === 1) { dl += 2; if (dl >= 0xa6) dl = 0xa5; }
    else if (hy !== 0) { dl -= 2; if (dl < 0) dl = 0; }
    wb($.thrown_obj_y, dl);
    ww(0x3284, calc_cga_addr(cx, dl));
    if (check_thrown_cat_hit() || check_enemy_object_hit()) {
      wb(0x3280, 0);
      wb(0x3281, 0);
      ww($.thrown_obj_x, rw(0x32ef));
      wb($.thrown_obj_y, rb(0x32f1));
      return;
    }
    erase_thrown_sprite();
    ww(0x327a, rw(0x327a) + 2);
    draw_thrown_sprite();
  }

  // OR-draws the broom frame (a 0-terminated list at 0x3260), saving what was underneath.
  function draw_thrown_sprite() {
    let si;
    for (;;) {
      si = rw(rw(0x327a) + 0x3260);
      if (si) break;
      ww(0x327a, 0);
    }
    let di = rw(0x3284);
    ww(0x3282, di);
    let bp = $.l1_sprite_data;
    wb(0x3286, 0);
    wb(0x3289, 0x1e);
    ww(0x3287, 2);
    do {
      cyc(445);
      for (let i = 0; i < 2; i++) {
        const lo = V[di & 0x3fff], hi = V[(di + 1) & 0x3fff];
        wb(bp, lo); wb(bp + 1, hi);
        V[di & 0x3fff] = rb(si) | lo;
        V[(di + 1) & 0x3fff] = rb(si + 1) | hi;
        si += 2; di += 2; bp += 2;
      }
      di -= 4;
      di ^= 0x2000;
      if (!(di & 0x2000)) di += 0x50;
    } while (decb(0x3289));
  }

  function erase_thrown_sprite() {
    cyc(83);
    if (rb(0x3286)) return;
    blit_to_cga($.l1_sprite_data, rw(0x3282), 0x1e02);
  }

  // The broom hits the cat: knocked back (except on level 4 while a mouse-hole door animates).
  function check_thrown_cat_hit() {
    cyc(87);
    if (rb($.enemy_active)) return false;
    if (lvl() === 6 && rb($.dat_44bd)) return check_thrown_near_cat();
    if (!rect(rw($.thrown_obj_x), rb($.thrown_obj_y), 0x10, 0xe1e, rw($.cat_x), rb($.cat_y), 0x18)) return false;
    if (!(lvl() === 4 && rb($.l3_door_anim_frame))) start_auto_walk();
    return true;
  }

  function init_thrown_objects() {
    for (let i = 0; i < 0x28; i++) wb($.l1_bg_sprite + i, 0);
    ww(0x32b6, 0xff);
    ww(0x327a, 0);
    ww($.thrown_obj_x, 0);
    wb($.thrown_obj_y, 0xa0);
    wb(0x3286, 1);
    wb(0x3280, 0);
    wb(0x3281, 0);
    wb(0x32eb, random() & 0xff);
    wb(0x32ea, 0x6c);
  }

  // Walking on the floor leaves footprints, up to 4 deep per column.
  function update_footprint() {
    cyc(100);
    if (rb($.cat_y) < 0xb4 || !rb($.scroll_direction)) return;
    const ax = ((rw($.cat_x) + 0xc) & 0xffff) >> 3;
    if (ax > 0x27 || ax === rw(0x32b6)) return;
    ww(0x32b6, ax);
    let al = rb(ax + $.l1_bg_sprite);
    if (al >= 4) return;
    al++;
    wb(ax + $.l1_bg_sprite, al);
    draw_footprint_tile(ax, al);
  }

  function draw_footprint_tile(bx, al) {
    blit_to_cga(((al * 0xa) & 0xffff) + $.l1_obj_sprites, ((bx << 1) + 0x1e00) & 0xffff, 0x501);
  }

  // ---- level_objects.asm: level 2, the fishbowl -------------------------------------------------
  // Objects 0-11 are fish to catch (all 12 wins the level); 12-23 are eels.
  async function check_level_objects() {
    ww(0x3511, 0);
    wb(0x351b, 0);
    do {
      const bx = rw(0x3511);
      cyc(80);
      if (!rb(bx + $.l2_obj_active)) {
        const di = bx < 0xc ? 0 : 2;
        if (check_rect_collision(rw(bx * 2 + $.l2_obj_x), rb(bx + $.l2_obj_y), rw(di + 0x3513), rw(di + 0x3517) & 0xff,
            rw($.cat_x), rb($.cat_y), 0x18, 0xe)) {
          if (bx >= 0xc && !rb($.cat_caught) && !rb($.immune_flag)) {
            // An eel: the cat is shocked, flashing blue and white for 13 ticks.
            wb($.object_hit, 1);
            let cx = rw($.cat_x) - 8;
            if (cx < 0) cx = 0;
            if (cx >= 0x117) cx = 0x116;
            let dl = rb($.cat_y);
            if (dl >= 0xb5) dl = 0xb4;
            blit_to_cga($.l1_anim_sprite_c, calc_cga_addr(cx, dl), 0x1205);
            reset_noise();
            let dx = bios_ticks();
            ww(0x3509, dx);
            do {
              do { update_noise(); await sync(); } while (!check_vsync());
              update_noise();
              cyc(400);
              bios_set_palette(0, (dx & 1) ? 1 : 0xf);
              update_noise();
              cyc(INT1A);
              dx = (bios_ticks() - rw(0x3509)) & 0xffff;
            } while (dx < 0xd);
            return false;
          }
          incb(0x351b);
          start_tone(0x5dc, 0x425);
          if (rb(0x351b) === 1) restore_alley_buffer();
          erase_level_object(rw(0x3511));
          const b = rw(0x3511);
          wb(b + $.l2_obj_active, 1);
          if (b < 0xc && decb(0x3410) === 0 && !rb($.immune_flag)) wb($.cat_caught, 1);
        }
      }
    } while (incw(0x3511) < 0x18);
    if (rb(0x351b)) { reset_caught_objects(); return true; }
    return false;
  }

  function init_level2_objects() {
    ww($.l2_anim_toggle, 0);
    ww(0x3415, 0);
    wb(0x3410, 0xc);
    for (let cx = 0x18; cx >= 1; cx--) {
      const bx = cx - 1;
      wb(bx + $.l2_obj_hit, 1);
      wb(bx + $.l2_obj_active, 0);
      wb(bx + $.l2_obj_y, rb(bx + $.l2_obj_init_y));
      wb(bx + 0x342f, 1);
      wb(bx + 0x3417, (random() & 1) ? 1 : 0xff);
      ww(bx * 2 + $.l2_obj_x, random() & 0xff);
    }
    // A per-difficulty number of eels starts out absent.
    let cx = rb(rw($.difficulty_level) + 0x351c);
    do {
      let bx;
      do {
        let dl;
        do { dl = random() & 0xf; } while (dl >= 0xc);
        bx = dl + 0xc;
      } while (rb(bx + $.l2_obj_active));
      wb(bx + $.l2_obj_active, 1);
      cx = (cx - 1) & 0xffff;                      // LOOP
    } while (cx);
  }

  // For each object caught this pass, one absent eel comes back in from the far side.
  function reset_caught_objects() {
    cyc(375);
    outer: for (;;) {
      for (let cx = 0xc; cx >= 1; cx--) {
        const bx = cx + 0xb;
        if (!rb(bx + $.l2_obj_active)) continue;
        let ax = 0, dl = 1;
        wb(bx + $.l2_obj_active, 0);
        if (rw($.cat_x) <= 0xa0) { ax = 0x12e; dl = 0xff; }
        wb(bx + 0x3417, dl);
        ww(((bx << 1) & 0xff) + $.l2_obj_x, ax);
        if (decb(0x351b)) continue outer;
        return;
      }
      return;
    }
  }

  // One object per call; a tick has to pass before each half of the 24 starts again.
  function update_level2_objects() {
    cyc(313);
    const dx = bios_ticks();
    if (dx === rw(0x3509)) return;
    ww(0x350b, dx);
    let bx = incw(0x3415);
    if (bx >= 0x18) {
      bx = 0;
      ww(0x3415, 0);
      ww(0x3411, rw(0x3411) ^ 0xc);
      ww(0x3413, rw(0x3413) + 8);
      ww(0x3509, rw(0x350b));
    } else if (bx === 0xc) {
      if (rb($.rom_id) !== 0xfd || rb($.cat_y) >= 0x30) ww(0x3509, rw(0x350b));
    }
    const si = bx << 1;
    if (rb(bx + $.l2_obj_active)) return;
    cyc(300);
    const r = random() & 0xff;
    if (r <= 0x10) {
      wb(bx + 0x3417, (r & 1) ? 1 : 0xff);
      wb(bx + 0x342f, (random() & 1) ? 1 : 0xff);
    }
    const cx = bx < 0xc ? 4 : 2;
    let ax = rw(si + $.l2_obj_x);
    if (rb(bx + 0x3417) === 1) { ax += cx; if (ax >= 0x12f) { ax = 0x12e; wb(bx + 0x3417, 0xff); } }
    else { ax -= cx; if (ax < 0) { ax = 0; wb(bx + 0x3417, 1); } }
    ww(si + $.l2_obj_x, ax);
    let al = rb(bx + $.l2_obj_y);
    if (rb(bx + 0x342f) === 1) {
      al = (al + 1) & 0xff;
      const dl = (rb(bx + $.l2_obj_init_y) + 0x18) & 0xff;
      if (al > dl) { al = dl; wb(bx + 0x342f, 0xff); }
    } else {
      al = (al - 1) & 0xff;
      if (al < rb(bx + $.l2_obj_init_y)) { al = rb(bx + $.l2_obj_init_y); wb(bx + 0x342f, 1); }
    }
    wb(bx + $.l2_obj_y, al);
    ww($.l2_obj_cur_addr, calc_cga_addr(rw(si + $.l2_obj_x), al));
    erase_level_object(rw(0x3415));
    bx = rw(0x3415);
    const di = rw($.l2_obj_cur_addr);
    ww(bx * 2 + $.l2_obj_cga_addr, di);
    wb(bx + $.l2_obj_hit, 0);
    if (bx >= 0xc) {
      blit_to_cga((((bx << 3) + rw(0x3413)) & 0x18) + $.l1_anim_sprite_b, di, 0x202);
      return;
    }
    let s = rw($.l2_anim_toggle);
    if (!(bx & 1)) s ^= 0xc;
    if (rb(bx + 0x3417) !== 1) s += 0x18;
    blit_to_cga((s + $.l1_anim_sprite_a) & 0xffff, di, 0x601);
  }

  function erase_level_object(bx) {
    cyc(83);
    if (rb(bx + $.l2_obj_hit)) return;
    const b2 = bx << 1;
    blit_to_cga(0x3404, rw(b2 + $.l2_obj_cga_addr), b2 >= 0x18 ? 0x202 : 0x601);
  }

  // The pebbles along the top change one at a time, every 8 ticks per round, except next to
  // the cat when it is at the surface.
  function animate_level2_blocks() {
    cyc(341);
    const dx = bios_ticks();
    if (((dx - rw(0x350f)) & 0xffff) < 8) return;
    let bx = incw(0x350d);
    if (bx >= 0x28) { bx = 0; ww(0x350d, 0); ww(0x350f, dx); }
    let di = bx << 1;
    if (rb($.cat_y) <= 7) {
      let ax = (rw($.cat_x) >> 2) + 1 - di;
      if (ax < 0) ax = ~ax & 0xffff;
      if (ax < 4) return;
    }
    di += 0xa0;
    const al = (rb(bx + $.level2_block_types) + 8) & 0xff;
    wb(bx + $.level2_block_types, al);
    blit_to_cga((al & 0x18) + $.level2_bar_sprites, di, 0x401);
  }

  // Room 1: an animated object at (0xE4, 0x8A); touching it sets level_complete, and the
  // dispatcher continues with room 2.
  function update_entrance_anim() {
    cyc(333);
    const dx = bios_ticks();
    if (((dx - rw(0x35da)) & 0xffff) < 6) return;
    ww(0x35da, dx);
    ww(0x35d8, rw(0x35d8) + 2);
    blit_to_cga(rw((rw(0x35d8) & 6) + 0x35d0), $.enemy_sprite_table_hi, 0xa02);
    if (rect(0xe4, 0x8a, 0x10, 0xe0a, rw($.cat_x), rb($.cat_y), 0x18)) wb($.level_complete, 1);
  }

  // ---- level_objects.asm: the bonus after a room is won ----------------------------------------
  // A time bonus counts down from the moment the cat went in (game_tick); the next window
  // leads to the love scene (force_level7).
  async function handle_level_complete() {
    const ls = rw($.level_state);
    if (ls !== 7) {
      incw($.elapsed_ticks);
      wb($.force_level7, 1);
      mask_score_tiles(0xaaaa);
      wb(0x369f, 0);
      await animate_score_bar(0);
    }
    let dx = bios_ticks(), ax;
    if (ls === 7) {
      dx = (dx - rw($.start_tick)) & 0xffff;
      ax = 0x2a30 - dx;
      if (ax < 0) ax = 0;
      ax >>= 1;
    } else {
      dx = (dx - rw($.game_tick)) & 0xffff;
      ax = 0x546;
      if (ls === 6) ax <<= 1;
      ax -= dx;
      if (ax < 0) ax = 0;
      if (ls !== 6) ax <<= 1;
    }
    ww(0x3697, ax);
    binary_to_bcd(ax);
    add_bcd_scores(0x368d, rw(((ls << 1) & 0xff) + 0x36cc));
    if (ls === 7) {
      const b = (rw($.difficulty_level) << 1) & 0xff;
      let a = b, cx = rw(b + 0x36dc);
      if (rw($.l7_obj_spawn_slot) < 8) { cx = (cx << 1) & 0xffff; a += 0x10; }
      ww(0x370c, a);
      cx = cx || 0x10000;
      do add_bcd_scores(SCORE, 0x368d); while (--cx);
      save_score_regions();
      wb(0x369e, 0x38);
      wb(0x3699, 1);
      ww(0x3722, 0x44);
      print_bonus_score();
      print_level7_bonus();
    } else {
      add_bcd_scores(SCORE, 0x368d);
      wb(0x3699, 2);
      ww(0x3722, 0x1e);
      mask_score_tiles(0xffff);
      const al = (((0xa8c - rw(0x3697)) & 0xffff) >> 4) & 0xf0;
      wb(0x369e, al);
      wb(0x369f, 1);
      await animate_score_bar(al * 0x28);
      print_bonus_score();
    }
    ww(0x3695, bios_ticks());
    do {
      if (ls === 7) play_victory_note(); else play_level_note();
      dx = await flash_score_color();
    } while (((dx - rw(0x3695)) & 0xffff) < rw(0x3722));
    bios_set_palette(0, 0);
    if (ls !== 7) { silence_speaker(); return; }
    blit_to_cga(0xe, 0x8e4, 0x804);
    blit_to_cga(0x4e, 0xc94, 0x814);
  }

  function save_score_regions() {
    save_from_cga(0x8e4, 0xe, 0x804);
    save_from_cga(0xc94, 0x4e, 0x814);
  }

  // Waits for the retrace, then sets the background: every other 4 ticks colour [0x3699].
  async function flash_score_color() {
    const dx = bios_ticks();
    cyc(INT1A);
    while (!check_vsync()) { cyc(20); await sync(); }
    bios_set_palette(0, (dx & 4) ? 0 : rb(0x3699));
    cyc(180);
    return dx;
  }

  // The bonus's last four digits, by teletype in colour 3.
  function print_bonus_score() {
    bios_set_cursor(rb(0x369e) >> 3, 0x12);
    cyc(200);
    for (let i = 3; i < 7; i++) { cyc(1960); bios_teletype((rb(i + 0x368d) + 0x30) & 0xff, 3); }
  }

  // A 20-character line whose last two characters are patched with a multiplier string.
  function print_level7_bonus() {
    bios_set_cursor(0xa, 0xa);
    cyc(200);
    ww(0x3720, rw(rw(0x370c) + 0x36ec));
    for (let bx = 0; bx < 0x14; bx++) { cyc(1960); bios_teletype(rb(bx + 0x370e), 3); }
  }

  function mask_score_tiles(dx) {
    cyc(0x1e * 30);
    for (let i = 0; i < 0x1e; i++) ww(0xe + i * 2, rw(0x35e0 + i * 2) & dx);
  }

  // A bar of tiles drawn upwards from the bottom of the screen, a row every 2 ticks (with a note)
  // when [0x369F] is set, otherwise at full speed.
  async function animate_score_bar(ax) {
    ww(0x369a, ax);
    init_level_melody();
    let a = 0x1b80;
    for (;;) {
      ww(0x369c, a);
      draw_block_list(0x361c, a);
      if (rb(0x369f)) {
        play_melody_step();
        ww(0x3695, bios_ticks());
        do { cyc(INT1A + 30); await sync(); } while (((bios_ticks() - rw(0x3695)) & 0xffff) < 2);
      }
      a = rw(0x369c) - 0x280;
      if (a < 0 || a < rw(0x369a)) break;
      await sync();
    }
    silence_speaker();
  }

  // Binary to 7-digit BCD at 0x368D by adding powers of two from a table (bit 12 down to bit 0).
  function binary_to_bcd(ax) {
    ww(0x368b, ax);
    for (let i = 0; i < 8; i++) wb(0x368d + i, 0);
    let bx = 0x3684, dx = 0x1000;
    for (;;) {
      if (rw(0x368b) & dx) add_bcd_scores(0x368d, bx);
      bx -= 7;
      const cf = dx & 1;
      dx >>= 1;
      if (cf) break;
    }
  }

  // ---- level_objects.asm: level 3 ---------------------------------------------------------------
  // Three targets at y=0x18 (dat_37A3); touching each one closes it, and closing all three
  // (without having been caught) wins the room.
  function init_level3_doors() {
    wb(0x37af, 3);
    ww(0x37b0, 1);
    ww(0x37b2, 1);
    ww(0x37b4, 1);
  }

  function update_level3_doors() {
    cyc(313);
    const dx = bios_ticks();
    if (dx === rw(0x37b8)) return;
    ww(0x37b8, dx);
    for (let b = 4; b >= 0; b -= 2) {
      ww(0x37b6, b);
      if (rw(b + 0x37b0) === 0) continue;
      if (!rect(rw(b + 0x37a3), 0x18, 0x10, 0xe10, rw($.cat_x), rb($.cat_y), 0x18)) continue;
      start_tone(0xc00, 0x8fd);
      restore_alley_buffer();
      erase_level3_enemy();
      close_level3_door(rw(0x37b6));
      save_alley_buffer();
      draw_level3_enemy();
      return;
    }
  }

  function close_level3_door(bx) {
    ww(bx + 0x37b0, 0);
    for (let i = 0; i < 0x20; i++) ww(0xe + i * 2, 0xaaaa);
    blit_to_cga(0xe, rw(bx + 0x37a9), 0x1002);
    if (decb(0x37af) === 0 && !rb($.object_hit)) wb($.cat_caught, 1);
  }

  // A 16-row wall of random 8x8 bricks.
  function draw_level3_bg() {
    ww(0x37a0, 0x66a);
    for (let cx = 0x10; cx >= 1; cx--) {
      let bx = 0, al = 0;
      for (;;) {
        wb(0x37a2, al);
        blit_to_cga(al + 0x3730, (rw(0x37a0) + bx) & 0xffff, 0x801);
        bx += 2;
        if (bx < 0x1e) {
          if (rb(0x37a2) !== 0x50 && !(cx & 1) && (random() & 0xff) >= 0x40) { al = 0x10; continue; }
          al = ((((random() & 0xff) - bx) & 0x30) + 0x30) & 0xff;
          continue;
        }
        if (bx === 0x1e) { al = 0x20; continue; }
        break;
      }
      ww(0x37a0, rw(0x37a0) + 0x140);
    }
  }

  // Level 3's climbable area: x 0xA4-0x118, at heights 0x28-0xA0 where bit 3 of y is set.
  function check_fence_collision() {
    cyc(107);
    const ax = rw($.cat_x) & 0xfffc;
    if (ax < 0xa4 || ax > 0x118) return false;
    const dl = (rb($.cat_y) - 2) & 0xf8;
    if (!(dl & 8) || dl < 0x28 || dl > 0xa0) return false;
    ww($.cat_x, ax);
    wb($.cat_y, dl + 2);
    wb($.cat_y_bottom, dl + 2 + 0x32);
    return true;
  }

  function init_level3_enemy() {
    wb(0x3966, 8);
    wb(0x396a, 1);
    wb(0x3967, 0);
    wb(0x396d, 2);
    ww(0x3964, 0x118);
    ww($.l3_door_toggle, 0);
  }

  // The enemy moves along the top (y=8) until it is above the cat, then drops towards it,
  // going back up when it passes the cat or strays more than 0x30 pixels from it. It is
  // blocked by the broom. Touching the cat zaps it for 9 ticks and loses the room.
  async function update_level3_enemy() {
    cyc(333);
    const dx = bios_ticks();
    if (((dx - rw(0x39c8)) & 0xffff) < 2) return;
    ww(0x39c8, dx);
    if (check_l3_enemy_thrown()) return;
    let caught = check_l3_enemy_cat();
    if (!caught) {
      cyc(300);
      ww(0x39c6, rw(((rw($.difficulty_level) << 1) & 0xff) + 0x39cc));
      ww(0x39c3, rw(0x3964));
      wb(0x39c5, rb(0x3966));
      let moved = false;
      if (rb(0x3966) === 8) {
        const ax = rw(0x3964) & 0xfff8, cx = rw($.cat_x) & 0xfff8;
        if (ax === cx) { wb(0x3967, 1); wb(0x396e, 1); }
        else {
          let a = rw(0x3964);
          if (ax < cx) a += rw(0x39c6);
          else { a -= rw(0x39c6); if (a < 0) a = 0; }
          ww(0x3964, a);
          moved = true;
        }
      }
      if (!moved) {                                // lab_3d25
        let al = rb(0x3966);
        const dl = ((incb(0x396e) >> 2) & 3) + 2;
        if (rb(0x3967) !== 1) {
          al -= dl;
          if (al < 9) { al = 8; wb(0x3967, 0); }
        } else {
          al = (al + dl) & 0xff;
          let up = false;
          if (al > rb($.cat_y)) up = true;
          else {
            let b = rw(0x3964) - rw($.cat_x);
            if (b < 0) b = ~b & 0xffff;
            if (b > 0x30) up = true;
            else if (al >= 0xa0) { al = 0x9f; up = true; }
          }
          if (up) wb(0x3967, 0xff);
        }
        wb(0x3966, al);
      }
      if (check_l3_enemy_thrown()) {               // lab_3d79
        ww(0x3964, rw(0x39c3));
        wb(0x3966, rb(0x39c5));
        return;
      }
      caught = check_l3_enemy_cat();
      if (!caught) {                               // lab_3dee
        ww(0x39ca, calc_cga_addr(rw(0x3964), rb(0x3966)));
        erase_level3_enemy();
        if (decb(0x396d) === 0) { wb(0x396d, 2); ww(0x396b, rw(0x396b) ^ 0x54); }
        draw_level3_enemy();
        return;
      }
    }
    // lab_3d90
    if (rb($.cat_caught)) return;
    let cx = rw($.cat_x) - 0xc;
    if (cx < 0) cx = 0;
    if (cx >= 0x10f) cx = 0x10e;
    let dl = rb($.cat_y) - 4;
    if (dl < 0) dl = 0;
    blit_transparent(0x37c0, calc_cga_addr(cx, dl), 0x1506, 0xe);
    init_buzz_sound();
    ww(0x39c8, bios_ticks());
    do { update_buzz_sound(); cyc(INT1A + 30); await sync(); }
    while (((bios_ticks() - rw(0x39c8)) & 0xffff) < 9);
    wb($.object_hit, 1);
  }

  function draw_level3_enemy() {
    const di = rw(0x39ca);
    ww(0x3968, di);
    wb(0x396a, 0);
    blit_transparent((rw($.l3_door_toggle) + 0x38bc) & 0xffff, di, 0xe03, 0x396f);
  }
  function erase_level3_enemy() {
    if (rb(0x396a)) return;
    blit_to_cga(0x396f, rw(0x3968), 0xe03);
  }
  function check_l3_enemy_thrown() {
    cyc(181);
    return rect(rw(0x3964), rb(0x3966), 0x18, 0x1e0e, rw($.thrown_obj_x), rb($.thrown_obj_y), 0x10);
  }
  function check_l3_enemy_cat() {
    cyc(177);
    return rect(rw(0x3964), rb(0x3966), 0x18, 0xe0e, rw($.cat_x), rb($.cat_y), 0x18);
  }

  // ---- level_objects.asm: level 4 ---------------------------------------------------------------
  // Pressing fire while standing on a numbered platform (l3_platform_id) plays a 7-frame
  // animation at that hole, then at its partner hole (dat_3CE3), where the cat reappears.
  function update_level4_state() {
    cyc(100);
    if (rb($.l3_door_anim_frame)) {
      if (bios_ticks() === rw($.l4_last_tick)) return;
    } else {
      if (rb($.auto_walk) || rb($.joy_button) || !rb($.l3_platform_id)) return;
      if (check_l4_thrown_collision()) return;
      const dx = bios_ticks();
      if (((dx - rw(0x3d18)) & 0xffff) < 0xc) return;
      ww(0x3d18, dx);
      wb($.at_platform, 0);
      let bx = (rb($.l3_platform_id) - 1) & 0xff;
      ww($.l3_door_cga_1, rw((bx << 2) + 0x3c5a));
      ww($.l3_door_cga_2, bx < 3 ? 0x80 : 0);
      bx = rb(bx + 0x3ce3);
      ww($.l3_door_cga_3, rw((bx << 2) + 0x3c5a));
      ww($.l3_door_sprite_base, bx < 3 ? 0x80 : 0);
      wb($.l4_obj_cur_y, rb(bx + $.l4_platform_offset));
      ww($.l4_obj_cur_x, rw(((bx << 1) & 0xff) + $.l4_obj_x_table) + 8);
      restore_alley_buffer();
      wb($.l3_door_anim_frame, 0xe);
      wb($.joy_button, 0x10);
    }
    // lab_3f35
    if (!rb($.enemy_chasing)) erase_thrown_sprite();
    const f = (rb($.l3_door_anim_frame) - 2) & 0xff;
    wb($.l3_door_anim_frame, f);
    let di, ax;
    if (f >= 8) { di = rw($.l3_door_cga_1); ax = rw($.l3_door_cga_2); }
    else {
      di = rw($.l3_door_cga_3);
      wb($.cat_y, rb($.l4_obj_cur_y));
      wb($.cat_y_bottom, rb($.l4_obj_cur_y) + 0x32);
      ww($.cat_x, rw($.l4_obj_cur_x));
      ax = rw($.l3_door_sprite_base);
    }
    blit_to_cga((ax + rw(f + $.l4_anim_offset_table)) & 0xffff, di, 0x1002);
    if (!rb($.enemy_chasing)) draw_thrown_sprite();
    ww($.l4_last_tick, bios_ticks());
    if (!rb($.l3_door_anim_frame)) save_cat_background();
  }

  // 17 rows of random wall tiles, the room's furniture, and the hole pairing for this
  // difficulty: each byte of dat_3CC3 holds two partner indices (high and low nibble).
  function init_level4_bg() {
    wb($.l3_platform_id, 0);
    wb($.l3_door_anim_frame, 0);
    ww(0x3cbf, 0x506);
    ww(0x3cc1, 0);
    do {
      let cx = rb(rw(0x3cc1) + 0x3cae) || 0x10000;
      let bx = 0;
      for (; cx; cx--) {
        cyc(250);
        let si = 0x3aea;
        const dl = random() & 0xff;
        if (dl <= 0x30) si = (dl & 4) ? 0x3af8 : 0x3b02;
        blit_to_cga(si, (rw(0x3cbf) + bx) & 0xffff, 0x801);
        bx += 2;
      }
      ww(0x3cbf, rw(0x3cbf) + 0x140);
    } while (incw(0x3cc1) < 0x11);
    draw_block_list(0x3c22, 0);
    draw_block_list(0x3c3e, 0);
    draw_block_list(0x3c9a, 0);
    draw_block_list(0x3c56, 0);
    blit_masked(0x3caa, 0x8ec, 0x102, 0xe);
    let si = 0;
    let bx = ((rw($.difficulty_level) & 3) << 3) & 0xff;
    do {
      const al = rb(bx + 0x3cc3);
      wb(si + 0x3ce3, al >> 4);
      wb(si + 0x3cf3, 0);
      wb(si + 0x3ce4, al & 0xf);
      wb(si + 0x3cf4, 0);
      si += 2;
      bx++;
    } while (si < 0x10);
  }

  function check_l4_thrown_collision() {
    return rect(rw($.thrown_obj_x), rb($.thrown_obj_y), 0x10, 0xe1e, rw($.cat_x), rb($.cat_y), 0x18);
  }

  // Four mice, each in one of the 16 holes (l5_obj_frame, never two in the same hole).
  function init_level4_objects() {
    for (let cx = 4; cx >= 1; cx--) {
      const bx = cx - 1, si = bx << 1;
      wb(bx + $.l5_obj_active, 1);
      wb(bx + $.l5_obj_hit, 0);
      randomize_l4_pos(bx, si);
      wb(bx + $.l5_obj_anim, (random() & 0xf) + 0x14);
    }
    ww($.l5_obj_index, 0);
    wb($.l5_obj_count, 4);
  }

  // Per mouse: l5_obj_anim counts down from 0x14-0x1B; it peeks out (anim 0x12-0x13), sits
  // (2-0x11, two alternating frames), and ducks back (0-1), sooner if the cat comes within a
  // per-difficulty distance. Touching a visible mouse catches it; all four win the room.
  function update_level4_anim() {
    cyc(313);
    const dx = bios_ticks();
    if (dx === rw($.l5_last_tick)) return;
    let bx = incw($.l5_obj_index);
    if (bx <= 2) ww($.l5_last_tick, dx);
    else if (bx >= 4) { bx = 0; ww($.l5_obj_index, 0); ww($.l5_last_tick, dx); }
    let si = bx << 1;
    if (rb(bx + $.l5_obj_hit)) return;
    let caught;
    if (check_l4_obj_cat(bx, si)) caught = true;
    else {
      if (check_l4_obj_thrown(bx, si)) return;
      if (!rb(bx + $.l5_obj_anim)) {
        randomize_l4_pos(bx, si);
        wb(bx + $.l5_obj_anim, (random() & 7) + 0x14);
      }
      decb(bx + $.l5_obj_anim);
      caught = check_l4_obj_cat(bx, si);
    }
    if (caught) {                                  // lab_4124
      if (rb(bx + $.l5_obj_active) || rb(bx + $.l5_obj_anim) >= 0x14) return;
      restore_alley_buffer();
      erase_level4_sprite();
      bx = rw($.l5_obj_index);
      wb(bx + $.l5_obj_hit, 1);
      save_alley_buffer();
      wb($.at_platform, 0);
      if (decb($.l5_obj_count) === 0) wb($.cat_caught, 1);
      blit_masked(0x3d20, (((4 - rb($.l5_obj_count)) << 2) & 0xff) + 0x51, 0xc02, 0xe);
      start_tone(0x3e8, 0x2ee);
      return;
    }
    // lab_4181
    calc_l4_obj_pos(bx, si);
    const bp = rw(((rw($.difficulty_level) << 1) & 0xffff) + $.l5_save_buf_ptrs);
    if (check_l4_proximity(bx, si, bp) && rb(bx + $.l5_obj_anim) >= 2) {
      const a = rb(bx + $.l5_obj_anim);
      if (a <= 0x11) wb(bx + $.l5_obj_anim, 1);
      else if (a < 0x14) wb(bx + $.l5_obj_anim, 0);
    }
    const al = rb(bx + $.l5_obj_anim);
    const step = rw(si + $.l5_obj_frame) >= 3 ? 1 : 3;
    let ax;
    if (al <= 1) {
      wb(bx + $.l5_obj_y_pos, rb(bx + $.l5_obj_y_pos) + step);
      ax = rb(bx + $.l5_obj_anim) >= 1 ? 0x3d80 : 0x3db0;
    } else if (al < 0x12) {
      ax = rw(((al & 1) << 1) + 0x3de0);
    } else {
      wb(bx + $.l5_obj_y_pos, rb(bx + $.l5_obj_y_pos) + step);
      const a = rb(bx + $.l5_obj_anim);
      ax = a < 0x13 ? 0x3d80 : a === 0x13 ? 0x3db0 : 0;
    }
    ww($.l5_obj_sprite_ptr, ax);
    ww(0x3de4, calc_cga_addr(rw(si + $.l5_obj_dims), rb(bx + $.l5_obj_y_pos)));
    erase_level4_sprite();
    bx = rw($.l5_obj_index);
    si = bx << 1;
    if (check_l4_obj_thrown(bx, si)) return;
    if (!rw($.l5_obj_sprite_ptr)) { wb(bx + $.l5_obj_active, 1); return; }
    wb(bx + $.l5_obj_active, 0);
    const di = rw(0x3de4);
    ww(si + $.l5_obj_cga_addr, di);
    blit_masked(rw($.l5_obj_sprite_ptr), di, 0xc02, rw(si + $.l5_obj_save_buf));
  }

  function erase_level4_sprite() {
    cyc(123);
    const bx = rw($.l5_obj_index), si = bx << 1;
    if (rb(bx + $.l5_obj_active)) return;
    blit_to_cga(rw(si + $.l5_obj_save_buf), rw(si + $.l5_obj_cga_addr), 0xc02);
  }

  // A free hole, retried up to 0x20 times while it is within 0x32 of the cat.
  function randomize_l4_pos(bx, si) {
    wb($.l5_anim_delay, 0x20);
    for (;;) {
      let dx;
      for (;;) {
        dx = random() & 0xf;
        let used = false;
        for (let di = 0; di < 8; di += 2) if (di !== si && dx === rw(di + $.l5_obj_frame)) { used = true; break; }
        if (!used) break;
      }
      ww(si + $.l5_obj_frame, dx);
      calc_l4_obj_pos(bx, si);
      if (!rb($.l5_anim_delay)) return;
      if (!check_l4_proximity(bx, si, 0x32)) return;
      decb($.l5_anim_delay);
    }
  }

  function calc_l4_obj_pos(bx, si) {
    cyc(234);
    const di = rw(si + $.l5_obj_frame);
    wb(bx + $.l5_obj_y_pos, (rb(di + $.l4_platform_offset) - (di >= 3 ? 0xa : 0) + 3) & 0xff);
    ww(si + $.l5_obj_dims, rw(((di << 1) & 0xffff) + $.l4_obj_x_table) + 8);
  }
  function check_l4_obj_cat(bx, si) {
    cyc(209);
    return rect(rw(si + $.l5_obj_dims), rb(bx + $.l5_obj_y_pos), 0x10, 0xe0c, rw($.cat_x), rb($.cat_y), 0x18);
  }
  function check_l4_obj_thrown(bx, si) {
    cyc(205);
    return rect(rw(si + $.l5_obj_dims), rb(bx + $.l5_obj_y_pos), 0x10, 0x1e0c, rw($.thrown_obj_x), rb($.thrown_obj_y), 0x10);
  }
  // |dx| + |dy| < bp, with the 8086's NOT-based "absolute value" (one less than the true one).
  function check_l4_proximity(bx, si, bp) {
    cyc(201);
    let ax = rw(si + $.l5_obj_dims) - rw($.cat_x);
    if (ax < 0) ax = ~ax & 0xffff;
    let dl = rb(bx + $.l5_obj_y_pos) - rb($.cat_y);
    if (dl < 0) dl = ~dl & 0xff;
    return ((ax + dl) & 0xffff) < bp;
  }

  // ---- level_objects.asm: level 5 ---------------------------------------------------------------
  // The flying object (dat_40B2/40B4): active once the perch object has dropped to y >= 0xA4.
  // It flies at random, to waypoints (dat_40DE/40F4), or away from the cat when the cat comes
  // within a per-difficulty distance (with a chirp). Touching it wins the room.
  function update_level5_anim() {
    cyc(313);
    const dx = bios_ticks();
    if (dx === rw(0x40b5)) return;
    if (incb(0x40ff) & 3) ww(0x40b5, dx);
    if (rb(0x40aa) < 0xa4) return;
    check_l5_cat_catch();
    if (check_l5_thrown()) return;
    cyc(300);
    let target = 0;
    if ((random() & 0xff) <= 0x30) {
      calc_l5_direction();
      if (rw(0x40cc) <= rw(((rw($.difficulty_level) << 1) & 0xffff) + 0x40ce)) {
        play_random_chirp();
        ww(0x40c8, 0xff);
        wb(0x40b7, rb(0x40ca));
        wb(0x40b8, rb(0x40cb));
        target = 0x442e;
      }
    }
    if (!target) {                                 // lab_439c
      if (rw(0x40c8) > 0xa) target = 0x4402;
      else if ((random() & 0xff) <= 6) { ww(0x40c8, 0xff); target = 0x4402; }
      else {
        const bx = rw(0x40c8);
        let dl = 0;
        const ax = rw(0x40b2) & 0xffc, tx = rw((bx << 1) + 0x40de);
        if (ax !== tx) dl = ax < tx ? 1 : 0xff;
        wb(0x40b7, dl);
        dl = 0;
        const al = rb(0x40b4) & 0xfe, ty = rb(bx + 0x40f4);
        if (al !== ty) dl = al < ty ? 1 : 0xff;
        wb(0x40b8, dl);
        if (dl | rb(0x40b7)) target = 0x442e;
        else if ((random() & 0xff) > 0x10) target = 0x442e;
        else { ww(0x40c8, 0xff); play_random_chirp(); target = 0x4402; }
      }
    }
    if (target === 0x4402) {
      const dl = random() & 0xff;
      if (dl <= 0x30) {
        wb(0x40b7, (dl & 1) ? 1 : 0xff);
        wb(0x40b8, (random() & 1) ? 1 : 0xff);
      }
      ww(0x40c8, random() & 0xff);
    }
    // lab_442e
    const vy = rb(0x40b8);
    if (vy) {
      let al = rb(0x40b4);
      if (vy === 1) { al += 2; if (al >= 0xa8) { al = 0xa7; wb(0x40b8, 0xff); } }
      else { al -= 2; if (al < 0x30) { al = 0x30; wb(0x40b8, 1); } }
      wb(0x40b4, al);
    }
    const vx = rb(0x40b7);
    if (vx) {
      let ax = rw(0x40b2);
      if (vx === 1) { ax += 4; if (ax >= 0x136) { ax = 0x135; wb(0x40b7, 0xff); } }
      else { ax -= 4; if (ax < 0) { ax = 0; wb(0x40b7, 1); } }
      ww(0x40b2, ax);
    }
    check_l5_cat_catch();
    ww(0x40bc, calc_cga_addr(rw(0x40b2), rb(0x40b4)));
    if (!rb(0x40b9)) blit_to_cga(0x3f2c, rw(0x40ba), 0x501);
    if (check_l5_thrown()) return;
    wb(0x40b9, 0);
    ww(0x40be, rw(0x40be) + 2);
    let si = rw((rw(0x40be) & 6) + 0x40c0);
    if (rb(0x40b7) === 0xff) si += 0x1e;
    const di = rw(0x40bc);
    ww(0x40ba, di);
    blit_transparent(si, di, 0x501, 0x3f2c);
  }

  function check_l5_landing() {
    return rb($.in_level_mode) === 0 && (rb($.cat_y) & 0xf8) === 0x88;
  }

  // Direction away from the cat on each axis, and |dx| + 2|dy| (NOT-based absolute values).
  function calc_l5_direction() {
    cyc(120);
    let ax = rw(0x40b2) - rw($.cat_x), dl = 1;
    if (ax < 0) { ax = ~ax & 0xffff; dl = 0xff; }
    wb(0x40ca, dl);
    ww(0x40cc, ax);
    let al = rb(0x40b4) - rb($.cat_y);
    dl = 1;
    if (al < 0) { al = ~al & 0xff; dl = 0xff; }
    wb(0x40cb, dl);
    ww(0x40cc, rw(0x40cc) + (al << 1));
  }

  function check_l5_cat_catch() {
    if (rect(rw(0x40b2), rb(0x40b4), 8, 0xe05, rw($.cat_x), rb($.cat_y), 0x18) && !rb($.object_hit)) wb($.cat_caught, 1);
  }
  function check_l5_thrown() {
    if (!rect(rw(0x40b2), rb(0x40b4), 8, 0x1e05, rw($.thrown_obj_x), rb($.thrown_obj_y), 0x10)) return false;
    wb(0x40b8, 0xff);
    return true;
  }

  function init_level5_objects() {
    ww(0x40a8, 0x90);
    wb(0x40aa, 0x86);
    ww(0x40ab, calc_cga_addr(0x90, 0x86));
    draw_l5_perch();
    wb(0x40af, 0);
    wb(0x40b1, 0);
    wb(0x40b9, 1);
    wb(0x40b8, 0);
    ww(0x40c8, 0xff);
  }

  // The perch object (dat_40A8/40AA) sits at y=0x86. The cat pushes it 8 pixels per tick;
  // once outside x 0x78-0xA8 it drops 5 pixels per tick to y >= 0xA4 (a falling tone), with
  // the game loop held up meanwhile, and the flying object starts from where it landed.
  async function update_level5_objects() {
    cyc(313);
    const dx = bios_ticks();
    if (dx === rw(0x40ad)) return;
    ww(0x40ad, dx);
    if (rb(0x40aa) >= 0xa4) return;
    if (check_l5_thrown_near()) {
      if (!check_l5_landing()) return;
      wb($.in_level_mode, 1);
      wb($.transition_timer, 0x10);
      return;
    }
    if (check_l5_perch_hit()) {
      if (!rb(0x40af)) {
        let al = rb($.scroll_direction);
        if (al === 0) al = rw(0x40a8) > rw($.cat_x) ? 1 : 0xff;
        wb(0x40b0, al);
      }
      wb(0x40af, 1);
      for (let cx = 0x20; cx; cx--) {
        let ax = rw($.cat_x), dl = 1;
        if (rb(0x40b0) === 1) { ax -= 8; dl = 0xff; } else ax += 8;
        ww($.cat_x, ax);
        wb($.scroll_direction, dl);
        const m = rb($.in_level_mode);
        if (m) {
          const al = (rb($.cat_y) + (m === 1 ? -3 : 3)) & 0xff;
          wb($.cat_y, al);
          wb($.cat_y_bottom, al + 0x32);
        }
        cyc(150);
        if (!check_l5_perch_hit()) break;
      }
      restore_alley_buffer();
      save_cat_background();
      return;
    }
    if (!rb(0x40b1)) {                             // lab_4649
      if (!rb(0x40af)) return;
      ww(0x40a8, rb(0x40b0) === 1 ? rw(0x40a8) + 8 : rw(0x40a8) - 8);
      if (check_l5_perch_hit()) return;
      start_tone(0xc00, 0xb54);
      wb(0x40af, 0);
      ww(0x40ab, calc_cga_addr(rw(0x40a8), rb(0x40aa)));
      erase_l5_perch();
      draw_l5_perch();
      const ax = rw(0x40a8);
      if (ax >= 0x78 && ax <= 0xa8) return;
    }
    for (;;) {                                     // lab_46a2
      wb(0x40b1, 1);
      if (rb($.enemy_chasing)) {
        if (check_l5_landing()) { wb($.in_level_mode, 1); wb($.transition_timer, 0x10); }
        return;
      }
      cyc(INT1A + 40);
      const d = bios_ticks();
      if (d === rw(0x40ad)) { await sync(); continue; }
      ww(0x40ad, d);
      if (snd()) {
        out43(0xb6);
        const a = (rb(0x40aa) << 2) & 0xffff;
        out42(a & 0xff);
        out42(a >> 8);
        out61(in61() | 3);
      }
      let dl = rb(0x40aa);
      if (dl >= 0xa4) break;
      dl += 5;
      wb(0x40aa, dl);
      ww(0x40ab, calc_cga_addr(rw(0x40a8), dl));
      erase_l5_perch();
      draw_l5_perch();
    }
    silence_speaker();
    erase_l5_perch();
    blit_masked(0x3f36, decw(0x40a6), 0x1104, 0x401e);
    ww(0x40b2, rw(0x40a8));
    wb(0x40b4, rb(0x40aa));
    calc_l5_direction();
    wb(0x40b7, rb(0x40ca));
  }

  function check_l5_perch_hit() {
    cyc(129);
    return rect(rw(0x40a8), rb(0x40aa), 0x18, 0xe10, rw($.cat_x), rb($.cat_y), 0x18);
  }
  function draw_l5_perch() {
    const di = rw(0x40ab);
    ww(0x40a6, di);
    blit_masked(0x3fbe, di, 0x1003, 0x401e);
  }
  function erase_l5_perch() { blit_to_cga(0x401e, rw(0x40a6), 0x1003); }
  function check_l5_thrown_near() {
    cyc(151);
    if (rb($.thrown_obj_y) < 0x66) return false;
    let ax = (rw(0x40a8) - 0x14) & 0xffff;
    if (ax > rw($.thrown_obj_x)) return false;
    ax = (ax + 0x30) & 0xffff;
    return ax >= rw($.thrown_obj_x);
  }

  // Level 6 broom test while the cat is eating (dat_44BD): a wider box around the cat.
  function check_thrown_near_cat() {
    let bx = rw($.cat_x) - 8;
    if (bx < 0) bx = 0;
    return rect(rw($.thrown_obj_x), rb($.thrown_obj_y), 0x10, 0xe1e, bx, (rb($.cat_y) + 3) & 0xff, 0x28);
  }

  // ---- level_objects.asm: level 6 ---------------------------------------------------------------
  // Twelve dishes (dat_44C4 = helpings left, dat_44D6 = dishes left) and a per-difficulty number
  // of sleepers in 12 places (dat_4441). Every few ticks a sleeper on the cat's row within a
  // per-difficulty distance stirs (l6_obj_state 0-2); one already at 2 wakes and gives chase.
  async function update_level6_timing() {
    cyc(INT1A + 139);
    const dx = bios_ticks();
    const si = (rw($.difficulty_level) << 1) & 0xffff;
    if (((dx - rw(0x44d7)) & 0xffff) <= rw(si + 0x44dc)) return;
    ww(0x44d7, dx);
    if (rb($.enemy_active)) return;
    wb(0x44fc, 0);
    for (let cx = 0xc; cx; cx--) {
      const bx = ((cx - 1) << 1) & 0xff;
      cyc(60);
      if (!rw(bx + 0x4441)) continue;
      let near = false;
      if (rb(bx + 0x43f9) === rb($.cat_y)) {
        let ax = rw(bx + 0x43e1) - rw($.cat_x);
        if (ax < 0) ax = ~ax & 0xffff;
        near = ax <= rw(si + 0x44ec);
      }
      if (near) {
        if (rw(bx + $.l6_obj_state) >= 2) {
          ww(0x44da, rw(bx + $.l6_obj_x));
          prepare_l6_erase();
          clear_l6_object();
          draw_thrown_sprite();
          draw_alley_foreground();
          activate_enemy_chase();
          return;
        }
        incw(bx + $.l6_obj_state);
        if (rw(bx + $.l6_obj_state) >= 2) incb(0x44fc);
      } else {
        if (!rw(bx + $.l6_obj_state)) continue;
        if ((random() & 0xff) <= 0x38) decw(bx + $.l6_obj_state);
      }
      await check_l6_proximity(bx);
      draw_l6_alert(bx);
      refresh_l6_display();
    }
    if (rb(0x44fc)) await play_explosion_effect();
  }

  function prepare_l6_erase() {
    if (rb(0x44bd)) { erase_l6_tracker(); wb(0x44bd, 0); }
    else restore_alley_buffer();
  }
  function clear_l6_object() {
    for (let i = 0; i < 0x41; i++) ww(0xe + 2 * i, 0xaaaa);
    blit_to_cga(0xe, rw(0x44da), 0xd05);
  }
  function refresh_l6_display() {
    cyc(83);
    if (!rb(0x44d9)) return;
    if (rb(0x44bd)) draw_l6_tracker();
    else draw_alley_foreground();
  }
  // If the cat overlaps this sleeper's alert marker, it is erased (at vertical retrace) and
  // redrawn by refresh_l6_display.
  async function check_l6_proximity(bx) {
    cyc(195);
    wb(0x44d9, 0);
    if (!rect((rw(bx + 0x43e1) - 0x14) & 0xffff, rb(bx + 0x43f9), 0x28, 0xe06, rw($.cat_x), rb($.cat_y), 0x18)) return;
    wb(0x44d9, 1);
    while (!check_vsync()) { cyc(20); await sync(); }
    if (rb(0x44bd)) erase_l6_tracker();
    else restore_alley_buffer();
  }
  function draw_l6_alert(bx) {
    cyc(257);
    let ax = rw(bx + $.l6_obj_x) + 0xa7;
    let si = ((rw(bx + $.l6_obj_state) << 1) & 0xffff) + 0x4100;
    if (rw(bx + $.l6_obj_sprite_ptr) !== 0x429c) { ax -= 6; si += 6; }
    blit_to_cga(si, ax & 0xffff, 0x101);
  }

  // Holding fire (joy_button = 0) walks the cat to the nearest dish on its row (dat_44C1); within
  // 4 pixels it eats: the tracker sprite (dat_44D1, two frames) is drawn beside it and every
  // overflow of dat_44D0 += 0x30 takes one helping.
  async function update_level6_movement() {
    cyc(115);
    if (rb($.enemy_active)) return;
    if (rb(0x44be)) { wb(0x698, rb(0x44be)); wb(0x699, 0); }
    cyc(INT1A + 30);
    const dx = bios_ticks();
    if (dx === rw(0x44d3)) return;
    ww(0x44d3, dx);
    if (rb($.auto_walk)) {
      if (rb(0x44bd)) {
        erase_l6_tracker();
        erase_thrown_sprite();
        save_alley_buffer();
        draw_thrown_sprite();
        wb(0x44bd, 0);
        wb(0x43e0, 1);
        wb(0x44be, 0);
      }
      return;
    }
    let eat = false;
    if (!rb($.joy_button)) {
      ww(0x44c1, 0xffff);
      ww(0x44bf, 0xffff);
      const si = rw($.cat_x), dl = (rb($.cat_y) + 8) & 0xff;
      for (let cx = 0xc; cx; cx--) {
        let bx = cx - 1;
        cyc(50);
        if (rb(bx + 0x44c4) < 1 || dl !== rb(bx + $.l6_obj_y)) continue;
        bx <<= 1;
        let dh = 0xff, ax = si - rw(bx + $.l6_obj_dims);
        if (ax < 0) { ax = ~ax & 0xffff; dh = 1; }
        if (ax > rw(0x44bf)) continue;
        ww(0x44bf, ax);
        ww(0x44d1, rw(bx + 0x44a5));
        ww(0x44c1, bx >> 1);
        wb(0x44c3, dh);
      }
      if (rw(0x44c1) < 0xc) {
        const d = rw(0x44bf);
        if (d < 4) eat = true;
        else {
          if (d <= 8) wb(0x572, 4);
          const al = rb(0x44c3);
          wb(0x698, al);
          wb($.scroll_direction, al);
          wb(0x44be, al);
          wb(0x699, 0);
          wb($.in_level_mode, 0);
        }
      }
    }
    if (!eat) {                                    // lab_49f9
      if (rb(0x44bd)) { erase_l6_tracker(); draw_alley_foreground(); wb($.joy_button, 0x10); }
      wb(0x44bd, 0);
      wb(0x43e0, 1);
      wb(0x44d0, 0);
      wb(0x44be, 0);
      return;
    }
    wb(0x44be, 0);                                 // lab_4a4b
    if (!rb(0x44bd)) { restore_alley_buffer(); save_alley_buffer(); }
    wb(0x44bd, 1);
    const s = rb(0x44d0) + 0x30;
    wb(0x44d0, s);
    wb(0x44d5, s > 0xff ? 1 : 0);
    let cx = rw($.cat_x) & 0xffc;
    const dl = (rb($.cat_y) + 3) & 0xff;
    if (rw(0x44d1) === 0x410c) { cx -= 8; if (cx < 0) cx = 0; }
    else { cx += 8; if (cx >= 0x127) cx = 0x126; }
    ww(0x43dc, calc_cga_addr(cx, dl));
    while (!check_vsync()) { cyc(20); await sync(); }
    erase_l6_tracker();
    if (rb(0x44d5)) {
      const bx = rw(0x44c1);
      if (rb(bx + 0x44c4)) {
        if (decb(bx + 0x44c4) === 0) {
          start_tone(0x8fd, 0x723);
          wb(0x698, 0);
          wb(0x44be, 0);
          wb($.joy_button, 0x10);
          if (decb(0x44d6) === 0) wb($.cat_caught, 1);
        }
        if (check_thrown_near_cat()) {
          erase_thrown_sprite();
          draw_l6_tile(bx);
          draw_thrown_sprite();
        } else draw_l6_tile(bx);
      }
    }
    draw_l6_tracker();
  }

  function erase_l6_tracker() {
    if (rb(0x43e0)) return;
    blit_to_cga(0x43a0, rw(0x43de), 0xa03);
  }
  function draw_l6_tracker() {
    wb(0x43e0, 0);
    const di = rw(0x43dc);
    ww(0x43de, di);
    let si = rw(0x44d1);
    if (rb(0x44d0) >= 0x80) si += 0x3c;
    blit_masked(si, di, 0xa03, 0x43a0);
  }

  function init_level6_objects() {
    for (let i = 0; i < 0xc; i++) ww(0x4441 + 2 * i, 0);
    for (let cx = rb(rw($.difficulty_level) + $.l6_obj_type); cx; cx--) {
      let bx;
      do bx = random() & 0x1e; while (bx >= 0x18 || rw(bx + 0x4441));
      ww(bx + $.l6_obj_state, 0);
      ww(bx + 0x4441, 1);
      blit_to_cga(rw(bx + $.l6_obj_sprite_ptr), rw(bx + $.l6_obj_x), 0xd05);
    }
    for (let cx = 0xc; cx; cx--) {
      const bx = cx - 1;
      wb(bx + 0x44c4, rb(rw($.difficulty_level) + $.l6_obj_init_y_tbl));
      draw_l6_tile(bx);
    }
    wb(0x44d0, 0);
    wb(0x44bd, 0);
    wb(0x43e0, 1);
    wb(0x44d6, 0xc);
    wb(0x44be, 0);
  }
  function draw_l6_tile(bx) {
    blit_to_cga((rb(bx + 0x44c4) << 5) + $.l5_sprite_table_base, calc_l6_addr(bx), 0x802);
  }
  function calc_l6_addr(bx) {
    return calc_cga_addr(rw(((bx << 1) & 0xff) + $.l6_obj_dims), rb(bx + $.l6_obj_y));
  }
  function level6_stubs() {}

  // ---- level_objects.asm: level 7 ---------------------------------------------------------------
  // Seven rivals, one per window row (slot 6 on the top row), each a 12-byte record swapped in
  // and out of l7_cat_x... by load_l7_slot/save_l7_slot. One slot is processed per tick.
  // A rival touching the cat knocks it down (slot 6 wins the room instead); a rival touching one
  // of the 8 objects on the ledges knocks it off and stays away for a per-difficulty time.
  function update_level7_objects() {
    cyc(INT1A + 40);
    const dx = bios_ticks();
    if (dx === rw($.l7_heart_tick)) return;
    let bx = incw($.l7_heart_index);
    if (bx === 1 || bx === 4) ww($.l7_heart_tick, dx);
    else if (bx >= 7) { bx = 0; ww($.l7_heart_index, 0); ww($.l7_heart_tick, dx); }
    load_l7_slot(bx);
    if (check_l7_cupid()) return;
    if (rw($.l7_cat_last_tick)) {
      cyc(INT1A);
      const d = (bios_ticks() - rw($.l7_cat_last_tick)) & 0xffff;
      let ax = rw(((rw($.difficulty_level) << 1) & 0xff) + $.l7_heart_sprite_table);
      if (!rw($.l7_heart_index)) ax = (ax << 1) & 0xffff;
      if (d < ax) return;
      ww($.l7_cat_last_tick, 0);
      wb($.l7_cat_moving, 1);
      ww($.l7_cat_x, rw($.cat_x) > 0xa0 ? 0x24 : 0x108);
      wb($.l7_cat_dir, 0);
    }
    if (check_l7_cat_hit()) { save_l7_slot(rw($.l7_heart_index)); return; }
    if (rb($.l7_cat_delay)) {
      if (decb($.l7_cat_delay) === 0) wb($.l7_cat_dir, rb($.l7_cat_dir) === 0xff ? 1 : 0xff);
    } else if (rb($.l7_cat_y) <= rb($.cat_y)) {   // lab_4cb8
      const top = rw($.l7_heart_index) === 6;
      if ((top && rb($.cat_y) < 0x28) || (random() & 0xff) <= rb(rw($.difficulty_level) + $.l7_heart_y_table)) {
        let dl = 0;
        const ax = rw($.l7_cat_x) & 0xff8, cx = rw($.cat_x) & 0xff8;
        if (ax !== cx) dl = ax < cx ? 1 : 0xff;
        wb($.l7_cat_dir, dl);
        if (rb($.cat_y) >= 0x28 && rw($.l7_heart_index) === 6) wb($.l7_cat_dir, dl === 0xff ? 1 : 0xff);
      }
    }
    // lab_4d14
    ww($.l7_heart_speed, rb($.l7_cat_delay) ? 4 : 8);
    let ax = rw($.l7_cat_x);
    const dir = rb($.l7_cat_dir);
    if (dir < 1) {
      const dl = random() & 0xff;
      if (dl <= 0x10) wb($.l7_cat_dir, (dl & 1) ? 1 : 0xff);
    } else {
      if (dir === 1) {
        ax += rw($.l7_heart_speed);
        if (ax >= 0x10b) { ax = 0x10a; wb($.l7_cat_dir, 0xff); wb($.l7_cat_delay, 0); }
      } else {
        ax -= rw($.l7_heart_speed);
        if (ax <= 0x24) { ax = 0x25; wb($.l7_cat_dir, 1); wb($.l7_cat_delay, 0); }
      }
      ww($.l7_cat_x, ax);
      ww($.l7_cat_anim_idx, rw($.l7_cat_anim_idx) + 2);
      if (rw($.l7_cat_anim_idx) >= 0xc) ww($.l7_cat_anim_idx, 0);
      if (!rb($.l7_cat_delay) && (random() & 0xff) <= 8) wb($.l7_cat_dir, 0);
    }
    // lab_4da1
    ww($.l7_heart_cga_addr, calc_cga_addr(rw($.l7_cat_x), rb($.l7_cat_y)));
    if (check_l7_cupid()) return;
    if (!check_l7_cat_hit()) {
      erase_l7_sprite();
      setup_l7_sprite();
      wb($.l7_heart_caught, 0);
      check_l7_object_overlap();
    }
    save_l7_slot(rw($.l7_heart_index));
  }

  function check_l7_cat_hit() {
    cyc(145);
    if (!rect(rw($.cat_x), rb($.cat_y), 0x18, 0xc0e, rw($.l7_cat_x), rb($.l7_cat_y), 0x18)) return false;
    if (rw($.l7_heart_index) === 6) {
      wb($.cat_caught, 1);
      restore_alley_buffer();
      erase_l7_sprite();
      return true;
    }
    restore_alley_buffer();
    erase_l7_sprite();
    draw_alley_foreground();
    wb($.transition_timer, 4);
    wb($.in_level_mode, 1);
    wb($.anim_counter, 4);
    wb($.anim_step, 8);
    wb($.l7_cat_delay, 4);
    wb($.l7_cat_dir, rw($.l7_cat_x) > rw($.cat_x) ? 1 : 0xff);
    start_tone(0xce4, $.l5_sprite_ptr);
    return true;
  }

  // Run by the cupid code: each present rival checks the objects without the screen restore.
  function check_l7_all_objects() {
    wb($.l7_heart_caught, 1);
    const saved = rw($.l7_heart_index);
    ww($.l7_heart_index, 0);
    do {
      load_l7_slot(rw($.l7_heart_index));
      if (!rw($.l7_cat_last_tick)) {
        check_l7_object_overlap();
        save_l7_slot(rw($.l7_heart_index));
      }
    } while (incw($.l7_heart_index) < 7);
    ww($.l7_heart_index, saved);
  }

  function check_l7_object_overlap() {
    cyc(118);
    for (let cx = 8; cx; cx--) {
      const bx = cx - 1;
      cyc(60);
      if (!rb(bx + $.l7_obj_active)) continue;
      const x = rw(((bx << 1) & 0xff) + $.l7_obj_x), y = rb(bx + $.l7_obj_y);
      if (!rect(x, y, 0x18, 0xc0f, rw($.l7_cat_x), rb($.l7_cat_y), 0x18)) continue;
      const own = !rb($.l7_heart_caught);
      if (own) { restore_alley_buffer(); if (rb($.cupid_active)) erase_cupid(); }
      erase_l7_sprite();
      wb(bx + $.l7_obj_active, 0);
      blit_to_cga($.l7_obj_erase_sprite, calc_cga_addr(x, y), 0xf03);
      if (own) { if (rb($.cupid_active)) draw_cupid(); draw_alley_foreground(); }
      let dx = 0;
      if (rw($.l7_heart_index) !== 6) { cyc(INT1A); dx = bios_ticks() || 0xffff; }
      ww($.l7_cat_last_tick, dx);
      return;
    }
  }

  function setup_l7_sprite() {
    wb($.l7_cat_moving, 0);
    let si = 0x4500;
    if (rb($.l7_cat_dir)) {
      let bx = rw($.l7_cat_anim_idx);
      if (rb($.l7_cat_delay)) bx = (bx & 0xff00) | (((bx & 2) + 0xc) & 0xff);
      if (rb($.l7_cat_dir) === 0xff) bx += 0x10;
      si = rw(bx + 0x4a60);
    }
    const di = rw($.l7_heart_cga_addr);
    ww($.l7_cat_save_addr, di);
    draw_l7_sprite(si, di);
  }
  function erase_l7_sprite() {
    if (!rb($.l7_cat_moving)) clear_l7_sprite(rw($.l7_cat_save_addr));
  }

  function init_level7_objects() {
    ww($.l7_heart_index, 0);
    do {
      ww($.l7_cat_x, (random() & 0x7f) + 0x60);
      wb($.l7_cat_dir, 0);
      wb($.l7_cat_moving, 1);
      ww($.l7_cat_anim_idx, 0);
      wb($.l7_cat_delay, 0);
      let dx = 0;
      if (!rw($.l7_heart_index)) dx = bios_ticks() || 0xffff;
      ww($.l7_cat_last_tick, dx);
      const bx = rw($.l7_heart_index);
      wb($.l7_cat_y, rb(bx + $.window_row_y_table) + 3);
      save_l7_slot(bx);
    } while (incw($.l7_heart_index) < 7);
    ww($.l7_heart_index, 0);
  }

  function save_l7_slot(bx) {
    cyc(449);
    const di = rw(((bx << 1) & 0xff) + $.l7_save_buf_ptrs);
    for (let i = 0; i < 0xc; i++) wb(di + i, rb($.l7_cat_x + i));
  }
  function load_l7_slot(bx) {
    cyc(449);
    const si = rw(((bx << 1) & 0xff) + $.l7_save_buf_ptrs);
    for (let i = 0; i < 0xc; i++) wb($.l7_cat_x + i, rb(si + i));
  }

  // 12 rows of 3 words ORed onto the screen, and cleared to colour 1 (0x5555).
  function draw_l7_sprite(si, di) {
    cyc(12 * (60 + 3 * 100));
    for (let dh = 0xc; dh; dh--) {
      for (let i = 0; i < 3; i++) {
        V[di & 0x3fff] |= rb(si);
        V[(di + 1) & 0x3fff] |= rb(si + 1);
        si += 2; di += 2;
      }
      di -= 6;
      di ^= 0x2000;
      if (!(di & 0x2000)) di += 0x50;
    }
  }
  function clear_l7_sprite(di) {
    cyc(12 * 150);
    for (let dh = 0xc; dh; dh--) {
      for (let i = 0; i < 6; i++) V[(di + i) & 0x3fff] = 0x55;
      di ^= 0x2000;
      if (!(di & 0x2000)) di += 0x50;
    }
  }
  function check_l7_cupid() {
    if (!rb($.cupid_active)) return false;
    return rect(rw($.cupid_x), rb($.cupid_y), 0x10, 0xc08, rw($.l7_cat_x), rb($.l7_cat_y), 0x18);
  }

  // The win: the cat is carried to the top and lowered 8 pixels per step towards the middle,
  // then three waves of 8 sprites bounce across the screen. Extra life (to 9), next difficulty
  // (to 7), and the room counter restarts.
  async function position_victory_cat() {
    let ax = rw($.cat_x);
    if (ax >= 0x117) ax = 0x116;
    ax -= 0x10;
    if (ax < 0) ax = 0;
    ax &= 0xff0;
    ww($.cat_x, ax);
    wb($.cat_y, 0x14);
    ax -= 0x80;
    if (ax < 0) ax = ~ax & 0xffff;
    ax >>= 3;
    if (ax > 0xd) ax = 0xd;
    ww($.l7_cupid_dx, ax + 2);
    ww($.l7_cupid_tick, 0xa);
    for (;;) {
      if (rw($.l7_cupid_tick) !== 0xa) play_victory_note();
      cyc(INT1A);
      ww(0x4a80, bios_ticks());
      let x = rw($.cat_x);
      const cx = x & 0xff0;
      if (cx === 0x80) x = cx;
      else if (cx > 0x80) x -= rw($.l7_cupid_dx);
      else x += rw($.l7_cupid_dx);
      ww($.cat_x, x & 0xffff);
      if (rb($.cat_y) >= 0x54) return;
      wb($.cat_y, rb($.cat_y) + 8);
      const di = calc_cga_addr(rw($.cat_x) + 4, rb($.cat_y));
      ww($.l7_cupid_cga_addr, di);
      blit_transparent(0x4b8a, di, 0x2007, 0xe);
      blit_to_cga(0x4a82, (rw($.l7_cupid_cga_addr) + 0xf3) & 0xffff, 0xd04);
      if (rw($.l7_cupid_tick) === 0xa) { await play_swoop_sound(); init_victory_melody(); }
      do { play_victory_note(); cyc(INT1A + 30); await sync(); }
      while (((bios_ticks() - rw(0x4a80)) & 0xffff) < rw($.l7_cupid_tick));
      if (rw($.l7_cupid_tick) === 0xa) {
        await handle_level_complete();
        bios_set_palette(0, 0);
      }
      ww($.l7_cupid_tick, 2);
    }
  }

  async function animate_victory_pairs() {
    for (let cx = 3; cx; cx--) {
      const bx = (3 - cx) << 1;
      ww($.l7_cupid_dx, rw(bx + $.l7_cupid_dx_tbl));
      ww($.l7_cupid_dy, rw(bx + $.l7_cupid_dy_tbl));
      ww($.l7_cupid_x_init, rw(bx + $.l7_cupid_x_init_tbl));
      ww($.l7_cupid_y_init, rw(bx + $.l7_cupid_y_init_tbl));
      ww($.l7_cupid_x_max, rw(bx + $.l7_cupid_x_max_tbl));
      ww($.l7_cupid_y_max, rw(bx + $.l7_cupid_y_max_tbl));
      ww($.l7_cupid_dims, rw(bx + $.l7_cupid_dims_tbl));
      ww($.l7_cupid_sprite_ptr, rw(bx + $.l7_cupid_sprite_tbl));
      ww($.l7_cupid_save_ptr, rw(bx + $.l7_cupid_save_tbl));
      await init_victory_wave();
    }
  }

  // l7_cupid_save_ptr is the wave's step time in ticks. On the first step only sprite 8 is
  // drawn; nothing is erased, so the sprites leave trails until one reaches an edge.
  async function init_victory_wave() {
    wb($.l7_cupid_active, 1);
    for (let cx = 8; cx; cx--) {
      play_victory_note();
      const bx = (cx - 1) << 1;
      ww(bx + $.l7_cupid_x, rw($.l7_cupid_x_init));
      ww(bx + $.l7_cupid_y, rw($.l7_cupid_y_init));
    }
    wb($.l7_cupid_bounce_cnt, 0);
    do {
      cyc(INT1A);
      ww(0x4a80, bios_ticks());
      for (let cx = 8; cx; cx--) {
        play_victory_note();
        const bx = (cx - 1) << 1;
        if (!rb($.l7_cupid_active) || cx === 8) {
          const di = calc_cga_addr(rw(bx + $.l7_cupid_x), rw(bx + $.l7_cupid_y) & 0xff);
          blit_transparent(rw($.l7_cupid_sprite_ptr), di, rw($.l7_cupid_dims), 0xe);
        }
        move_victory_object(bx);
      }
      do { play_victory_note(); cyc(INT1A + 30); await sync(); }
      while (((bios_ticks() - rw(0x4a80)) & 0xffff) < rw($.l7_cupid_save_ptr));
      wb($.l7_cupid_active, 0);
    } while (!rb($.l7_cupid_bounce_cnt));
  }

  function move_victory_object(bx) {
    const step = (pos, dir, d, max) => {
      let ax = rw(bx + pos);
      const dr = rw(bx + dir);
      if (dr < 1) return;
      if (dr === 1) {
        ax = (ax + rw(d)) & 0xffff;
        if (ax > rw(max)) { ax = rw(max); incb($.l7_cupid_bounce_cnt); }
      } else {
        ax -= rw(d);
        if (ax < 0) { ax = 0; incb($.l7_cupid_bounce_cnt); }
      }
      ww(bx + pos, ax);
    };
    step($.l7_cupid_x, $.l7_cupid_x_dir, $.l7_cupid_dx, $.l7_cupid_x_max);
    step($.l7_cupid_y, $.l7_cupid_y_dir, $.l7_cupid_dy, $.l7_cupid_y_max);
  }

  async function run_victory_sequence() {
    init_victory_melody();
    if (rb($.rom_id) !== 0xfd) bios_set_palette(1, 1);
    await position_victory_cat();
    await animate_victory_pairs();
    await play_full_victory();
    if (rb($.lives_count) < 9) incb($.lives_count);
    if (rw($.difficulty_level) < 7) incw($.difficulty_level);
    ww($.elapsed_ticks, 0);
    cyc(INT1A);
    ww($.start_tick, bios_ticks());
    silence_speaker();
  }

  function play_march_note() {
    cyc(40);
    if (!snd()) return;
    cyc(INT1A);
    const dx = bios_ticks();
    if (dx === rw($.l7_bg_anim_tick)) return;
    ww($.l7_bg_anim_tick, dx);
    const bx = rw($.l7_bg_anim_idx);
    ww($.l7_bg_anim_idx, bx + 2);
    const ax = rw(bx + $.l7_bg_sprite_seq);
    if (ax === rw($.l7_bg_cur_sprite)) { silence_speaker(); return; }
    ww($.l7_bg_cur_sprite, ax);
    out43(0xb6);
    out42(ax & 0xff);
    out42(ax >> 8);
    out61(in61() | 3);
  }

  // After a love-scene visit from difficulty 2 up: two frames alternating every 5 ticks for
  // 0x28 ticks, with a tune.
  async function play_victory_march() {
    if (rw($.difficulty_level) < 2) return;
    ww($.l7_bg_xor_flag, 0);
    cyc(INT1A);
    const dx = bios_ticks();
    ww($.l7_bg_last_tick_1, dx);
    ww($.l7_bg_last_tick_2, dx);
    ww($.l7_bg_anim_tick, dx);
    ww($.l7_bg_anim_idx, 0);
    ww($.l7_bg_cur_sprite, 0);
    for (;;) {
      draw_march_frame();
      ww(0x5016, rw(0x5016) ^ 2);
      let d;
      do { play_march_note(); cyc(INT1A + 20); await sync(); d = bios_ticks(); }
      while (((d - rw($.l7_bg_last_tick_1)) & 0xffff) < 5);
      ww($.l7_bg_last_tick_1, d);
      if (((d - rw($.l7_bg_last_tick_2)) & 0xffff) >= 0x28) break;
    }
    silence_speaker();
  }

  function draw_march_frame() {
    ww($.l7_bg_sprite_idx, rw(((rw($.difficulty_level) << 1) & 0xffff) + $.l7_bg_pattern_tbl));
    for (;;) {
      const bx = rw($.l7_bg_sprite_idx);
      const di = rw(bx);
      if (!di) return;
      const b = (rw(bx + 2) ^ rw($.l7_bg_xor_flag)) & 2;
      blit_to_cga(rw(b + $.l7_bg_sprite_ptrs), di, 0x2304);
      play_march_note();
      ww($.l7_bg_sprite_idx, bx + 4);
    }
  }

  // ---- entry.asm ----------------------------------------------------------------------------------
  async function entry() {
    detect_video();
    read_rom_id();
    wb($.video_mode, 4);
    ww($.difficulty_counter, 0);
    wb($.use_joystick, 0);
    install_handlers();
    init_bios_data();
    ww($.pause_screen_addr, rw($.keyboard_counter) + 0x240);
    bios_set_mode();
    wb($.video_mode, rb($.rom_id) === 0xfd ? 4 : 6);
    bios_set_palette(1, 1);
    ww($.round_counter, 0);
    ww($.level_number, 0);
    set_palette();
    if (rb($.rom_id) !== 0xfd) out_3d9(0x20);
    read_pit_counter();
    clear_high_score();
    clear_score();
    wb($.attract_shown, 0);
    ww($.last_level, 0xffff);
    ww($.prev_level, 0xffff);
    wb($.sound_enabled, 0xff);
    let at = 'lab_0081';
    for (;;) {
      if (at === 'lab_0081') {                     // title screen / game over
        update_high_score();
        ww($.difficulty_level, 0);
        ww($.level_number, 0);
        set_palette();
        silence_speaker();
        await show_title_screen();
        silence_speaker();
        at = rb($.attract_shown) ? 'lab_00ae' : 'lab_00a3';
      } else if (at === 'lab_00a3') {              // options menu
        silence_speaker();
        await show_attract_mode();
        wb($.attract_shown, 1);
        at = 'lab_00ae';
      } else if (at === 'lab_00ae') {              // new game
        ww($.difficulty_level, rw($.difficulty_counter));
        wb($.lives_count, 3);
        clear_score();
        ww($.level_number, 0);
        set_palette();
        silence_speaker();
        ww($.game_timer, 0);
        ww($.start_tick, bios_ticks());
        ww($.elapsed_ticks, 0);
        wb($.force_level7, 0);
        wb($.start_in_level, 0);
        wb($.show_attract, 0);
        wb($.restart_game, 0);
        silence_speaker();
        at = 'lab_00f3';
      } else {
        at = await alley_and_rooms();
      }
    }
  }

  // lab_00f3: the alley, then the room the cat enters, then back here.
  async function alley_and_rooms() {
    if (rb($.lives_count) === 0) return 'lab_0081';
    if (rb($.restart_game)) return 'lab_00ae';
    if (rb($.show_attract)) return 'lab_00a3';
    await clear_screen();
    render_sprites();
    wb($.lives_display, 0xff);
    silence_speaker();
    ww($.level_number, 0);
    if (rb($.start_in_level)) {
      setup_level();
      wb($.game_mode, 2);
      wb($.anim_counter, 1);
      wb($.anim_step, 0x20);
    } else {
      ww($.cat_x, 0);
      setup_alley();
    }
    init_sound();
    init_player();
    reset_jump();
    init_objects();
    draw_score();
    draw_high_score();
    init_music();
    for (;;) {                                     // lab_0155: alley loop
      if (rb($.lives_count) === 0) return 'lab_0081';
      cyc(340);
      await process_keyboard();
      if (rb($.show_attract)) return 'lab_00a3';
      if (rb($.restart_game)) return 'lab_00ae';
      poll_joystick();
      await update_animation();
      await update_enemies();
      if (!rb($.enemy_active)) {
        incb($.frame_counter);                     // no dog: the rest runs every 4th pass
        if (rb($.frame_counter) & 3) { await sync(); continue; }
      }
      await play_sound();
      update_thrown_objects();
      await update_cat_jump();
      await apply_cat_gravity();
      await animate_falling();
      await cycle_animations();
      draw_lives();
      await sync();
      if (!rb($.cat_died)) continue;
      if (rb($.lives_count) === 0) return 'lab_0081';
      break;
    }
    // lab_01b7: the cat went in through a window. Remember where, and pick the room.
    ww($.game_tick, bios_ticks());
    ww($.saved_cat_x, rw($.cat_x));
    wb($.saved_cat_y, rb($.cat_y));
    wb($.start_in_level, 1);
    if (rb($.force_level7)) {
      wb($.force_level7, 0);
      ww($.level_number, 7);
    } else {
      let ax;
      for (;;) {                                   // lab_01e5
        let dx = random();
        let bx = rw($.difficulty_level) & 3;
        if ((dx & 0xa0) && bx !== 3) {
          ax = rb(bx * 4 + (dx & 3) + $.level_pool);
        } else {
          do { dx = random() & 7; } while (dx >= 5);
          ax = rb(dx + $.level_pool_hard);
        }
        if (ax !== rw($.last_level) || ax !== rw($.prev_level)) break;
      }
      ww($.level_number, ax);
      ww($.prev_level, rw($.last_level));
      ww($.last_level, ax);
    }
    // lab_0238: dispatch through the jump table at cs:0x250
    ww($.level_state, 0);
    let bx = lvl();
    if (bx > 7) bx = 0;
    let next = [1, 1, 2, 3, 4, 5, 6, 7][bx];
    for (;;) {
      await room(next);
      if (next === 1 && rb($.level_complete)) { next = 2; continue; }   // fell into the fishbowl
      break;
    }
    // lab_0427: level exit
    if (rb($.restart_game)) return 'lab_00ae';
    if (rb($.show_attract)) return 'lab_00a3';
    if (rb($.object_hit)) wb($.start_in_level, 0);
    ww($.level_state, lvl());
    ww($.level_number, 0);
    await level_transition();
    return 'lab_00f3';
  }

  const exitFlags = (...a) => a.reduce((s, x) => s | rb(x), 0);

  async function room(n) {
    ww($.level_number, n);
    await level_transition();
    draw_level_background();
    switch (n) {
      case 7:                                      // lab_0260: the love scene
        setup_level(); init_sound(); init_thrown_objects(); reset_cupid(); init_level7_objects(); init_music();
        do {
          cyc(380);
          await process_keyboard(); poll_joystick(); await play_sound(); await update_animation();
          await update_cupid(); await tick_level_thrown_objects(); spawn_thrown_object(); await update_level7_objects();
          await sync();
        } while (!exitFlags($.cat_died, $.cat_caught, $.show_attract, $.restart_game));
        return;
      case 6:                                      // lab_02aa
        level6_stubs(); setup_level(); init_thrown_objects(); init_sound(); init_music();
        do {
          cyc(380);
          await process_keyboard(); poll_joystick(); await play_sound();
          await update_level6_movement(); await update_level6_timing(); await update_animation();
          if (rb($.enemy_active)) await update_enemies(); else await tick_thrown_objects();
          await sync();
        } while (!exitFlags($.cat_died, $.object_hit, $.cat_caught, $.restart_game, $.show_attract));
        return;
      case 5:                                      // lab_02fe
        init_level5_objects(); setup_level(); init_thrown_objects(); init_sound(); init_music();
        do {
          cyc(380);
          await process_keyboard(); poll_joystick(); await play_sound();
          await update_level5_objects(); update_level5_anim(); await update_animation();
          await tick_thrown_objects(); await update_enemies();
          await sync();
        } while (!exitFlags($.object_hit, $.cat_caught, $.cat_died, $.show_attract, $.restart_game));
        return;
      case 4:                                      // lab_0349
        setup_level(); init_thrown_objects(); init_sound(); init_level4_objects(); init_music();
        do {
          cyc(380);
          await process_keyboard(); poll_joystick(); await play_sound(); await update_animation();
          update_level4_state(); update_level4_anim(); await tick_thrown_objects(); await update_enemies();
          await sync();
        } while (!exitFlags($.object_hit, $.cat_caught, $.cat_died, $.show_attract, $.restart_game));
        return;
      case 3:                                      // lab_0394
        setup_level(); init_thrown_objects(); init_sound(); init_level3_doors(); init_level3_enemy(); init_music();
        do {
          cyc(380);
          await process_keyboard(); poll_joystick(); await play_sound(); await update_animation();
          await update_level3_enemy(); update_level3_doors(); await tick_thrown_objects(); await update_enemies();
          await sync();
        } while (!exitFlags($.object_hit, $.cat_caught, $.cat_died, $.show_attract, $.restart_game));
        return;
      case 1:                                      // lab_03e2
        setup_level(); init_thrown_objects(); init_sound(); init_music();
        for (;;) {
          cyc(380);
          await process_keyboard(); poll_joystick(); await play_sound(); await update_animation();
          await tick_thrown_objects(); await update_enemies(); update_entrance_anim();
          await sync();
          if (rb($.level_complete)) return;
          if (exitFlags($.object_hit, $.cat_died, $.restart_game, $.show_attract)) return;
        }
      case 2:                                      // lab_0459
        init_level2_objects(); setup_level();
        wb($.enemy_chasing, 0); wb($.enemy_active, 0);
        init_music();
        do {
          cyc(380);
          await process_keyboard(); poll_joystick(); await play_sound(); await update_animation();
          await update_level2_objects(); animate_level2_blocks();
          await sync();
        } while (!exitFlags($.object_hit, $.cat_caught, $.show_attract, $.restart_game));
        return;
    }
  }

  // ---- game_loop.asm -----------------------------------------------------------------------------
  function setup_alley() {
    cyc(720);
    let cx = 0, ah = 1;
    if (rw($.cat_x) >= 0xa0) { cx = 0x128; ah = 0xff; }
    wb($.scroll_direction, ah);
    wb($.entry_steps, 3);
    wb($.entry_delay, 0xc);
    const dl = 0xb4;
    ww($.cat_x, cx);
    wb($.cat_y, dl);
    wb($.cat_y_bottom, 0xe6);
    ww($.cat_draw_pos, calc_cga_addr(cx, dl));
    ww($.buffer_size, 0xb03);
    save_alley_buffer();
    wb($.in_level_mode, 0);
    ww($.scroll_speed, 2);
    wb($.anim_counter, 1);
    wb($.transition_timer, 0);
    wb($.game_mode, 0);
    wb($.at_platform, 0);
    wb($.transitioning, 0);
    wb($.sprite_hidden, 0);
    wb($.input_horizontal, 0);
    wb($.input_vertical, 0);
    wb($.cat_died, 0);
    wb($.auto_walk, 0);
    wb($.object_hit, 0);
    ww($.level_complete, 0);
    wb($.cat_caught, 0);
    wb($.door_contact, 0);
    reset_window_state();
  }

  function setup_level() {
    cyc(700);
    const bx = lvl();
    let cx, dl;
    if (bx === 0) { cx = rw($.saved_cat_x); dl = rb($.saved_cat_y); }
    else { dl = rb(bx + $.level_start_y_table); cx = rw(((bx << 1) & 0xff) + $.level_start_x_table); }
    ww($.cat_x, cx);
    wb($.cat_y, dl);
    wb($.cat_y_bottom, dl + 0x32);
    ww($.cat_draw_pos, calc_cga_addr(cx, dl));
    ww($.vert_sprite_data, rw(0xfb2));
    ww($.vert_sprite_dims, rw(0xfbe));
    ww($.buffer_size, rw(0xfbe));
    save_alley_buffer();
    wb($.in_level_mode, 1);
    wb($.scroll_direction, 0);
    wb($.anim_counter, 1);
    wb($.anim_step, 0x40);
    wb($.transition_timer, lvl() === 7 ? 0 : 0xa);
    wb($.game_mode, 0);
    wb($.at_platform, 0);
    wb($.transitioning, 0);
    wb($.sprite_hidden, 0);
    wb($.input_horizontal, 0);
    wb($.input_vertical, 0);
    wb($.cat_died, 0);
    wb($.auto_walk, 0);
    wb($.object_hit, 0);
    ww($.level_complete, 0);
    wb($.cat_caught, 0);
    wb($.door_contact, 0);
    reset_window_state();
    if (lvl() === 2) {
      wb($.anim_counter, 0x10);
      ww($.speed_ramp, 0x10);
      ww($.level2_tick, bios_ticks());
      wb($.immune_flag, 0);
      wb($.level2_rise, 5);
      wb($.meow_timer, 1);
    }
  }

  // The cat is knocked away from whatever hit it and walks itself back towards the entrance.
  function start_auto_walk() {
    cyc(107);
    ww($.ambient_freq, 0x400);
    if (rb($.auto_walk)) return;
    wb($.anim_counter, 8);
    wb($.in_level_mode, rb($.cat_y) >= rb($.entrance_y) ? 0xff : 1);
    let ax = rw($.cat_x) - rw($.entrance_x);
    let dl = 0xff;
    if (ax <= 0) { dl = 1; ax = ~ax; }
    ax &= 0xffff;
    wb($.scroll_direction, dl);
    if (ax >> 8) ax = 0xff;
    let al = ~ax & 0xff;
    if (al < 0x30) al = 0x30;
    al = (al - (al >> 2)) & 0xff;
    wb($.anim_step, al);
    ww($.scroll_speed, al >> 5);
    wb($.at_platform, 0);
    wb($.l3_platform_id, 0);
    wb($.anim_accumulator, 1);
    wb($.transition_timer, 0x10);
    wb($.auto_walk, 1);
  }

  async function update_animation() {
    cyc(357);
    const dx = bios_ticks();
    let ax = 0;
    if (dx === rw($.anim_last_tick)) {
      // One more step 0x20 main-loop passes after the tick (0x10 on a PCjr).
      if (rw($.pcjr_delay) === 0) return;
      if (decw($.pcjr_delay) !== 0) return;
    } else {
      ax = rb($.rom_id) === 0xfd ? 0x10 : 0x20;
      ww($.pcjr_delay, ax);
    }
    if (lvl() === 2 || !(rb($.in_level_mode) | rb($.scroll_direction))) {
      if (!check_vsync()) return;
    }
    ww($.anim_last_tick, dx);
    ww($.anim_tick_delay, ax);
    if (lvl() === 4 && rb($.l3_door_anim_frame)) return;
    if (lvl() === 6 && rb($.dat_44bd)) return;
    if (lvl() !== 2) return update_animation_0bac();

    // Level 2: the cat swims in the fishbowl.
    let si = rw($.difficulty_level) << 1;
    const t = (rw($.anim_last_tick) - rw($.level2_tick)) & 0xffff;
    if (t >= rw(si + $.level2_phase1_ticks)) {
      // Out of air: the cat floats up, with a bubble every 6 steps.
      if (t >= rw(si + $.level2_death_ticks)) wb($.object_hit, 1);
      if (decb($.meow_timer) === 0) {
        play_meow_sound();
        wb($.meow_timer, 6);
        let al = rb($.level2_rise);
        if (rb($.cat_y) >= 0xb3 && al < 0xc8) { al = (al + 0x1e) & 0xff; wb($.level2_rise, al); }
        let dl = rb($.cat_y) - al;
        if (dl < 0) dl = 0;
        const di = calc_cga_addr(rw($.cat_x), dl & 0xf8);
        blit_masked(0x64e, di, 0x503, 0xe);
      }
      wb($.scroll_direction, 0);
      wb($.in_level_mode, 1);
      wb($.immune_flag, 1);
      wb($.anim_counter, 0x20);
      bios_set_palette(0, 0);
    } else {
      // The background colour warns that air is running out.
      si = rw($.difficulty_level) << 1;
      let bl = 0;
      if (t >= rw(si + $.level2_color1_ticks)) {
        bl = 1;
        if (t >= rw(si + $.level2_color2_ticks)) { bl = 5; if (t >= rw(si + $.level2_color3_ticks)) bl = 4; }
      }
      bios_set_palette(0, bl);
      wb($.prev_scroll_dir, rb($.scroll_direction));
      wb($.prev_vert_dir, rb($.in_level_mode));
      let al = rb($.input_horizontal);
      if (al === 0 ? rw($.speed_ramp) < 0x10 : al !== rb($.scroll_direction)) {
        wb($.scroll_direction, al);
        ww($.speed_ramp, 0x20);
      } else if (al === 0) {
        decw($.speed_ramp);
      } else if (rw($.speed_ramp) < 0x30) {
        ww($.speed_ramp, rw($.speed_ramp) + 3);
      }
      let sp = rw($.speed_ramp) >> 3;
      const bx = (rw($.difficulty_level) & 0xff00) | ((rw($.difficulty_level) << 1) & 0xff);
      if (sp > rw(bx + $.max_swim_speed)) sp = rw(bx + $.max_swim_speed);
      ww($.scroll_speed, sp);
      update_scroll();
      al = rb($.input_vertical);
      if (al === 0) {
        al = 0xff;                                 // no key: the cat floats upwards
        if (rb($.anim_counter) < 0x10) { wb($.in_level_mode, al); wb($.anim_counter, 0x20); }
        else decb($.anim_counter);
      } else if (al !== rb($.in_level_mode)) {
        wb($.in_level_mode, al); wb($.anim_counter, 0x20);
      } else if (rb($.anim_counter) < 0x40) {
        wb($.anim_counter, rb($.anim_counter) + 4);
      }
    }
    // lab_0a86
    si = rw($.difficulty_level);
    let dl = rb($.cat_y);
    let bl = rb($.anim_counter) >> 4;
    if (bl > rb(si + $.max_dive_depth)) bl = rb(si + $.max_dive_depth);
    const mode = rb($.in_level_mode);
    if (mode === 1) {
      dl += bl;
      if (dl >= 0xb4) dl = 0xb3;
    } else if (mode !== 0) {
      dl -= bl;
      if (dl < 0 || dl <= 3) {
        // At the surface with the breathing sprite: the air supply is refilled.
        if (rw(0x9b8) === rw($.cat_sprite_data)) ww($.level2_tick, rw($.anim_last_tick));
        dl = 2;
      }
    }
    wb($.cat_y, dl);
    ww($.cat_screen_pos, calc_cga_addr(rw($.cat_x), dl));
    let bx;
    if (rb($.immune_flag)) bx = 0x10;
    else if (rb($.scroll_direction) !== rb($.prev_scroll_dir) || rb($.in_level_mode) !== rb($.prev_vert_dir)) bx = 0x18;
    else {
      bx = incw($.walk_frame);
      if (!(rb($.input_horizontal) | rb($.input_vertical))) bx = (bx & 0xff00) | ((bx & 0xff) >> 1);
      let toB53;
      if (rb($.cat_y) >= 0xb3 && rb($.in_level_mode) === 1) toB53 = false;
      else if (rb($.cat_y) <= 4 && rb($.input_vertical) !== 0) toB53 = true;
      else toB53 = (rb($.anim_counter) >> 1) >= rw($.speed_ramp);
      if (!toB53 && rb($.scroll_direction) === 0) toB53 = true;
      if (!toB53) {
        bx &= 6;
        if (rb($.scroll_direction) !== 1) bx |= 8;
      } else {
        bx = (bx & 2) | 0x10;
        if (rb($.in_level_mode) === 1) bx += 4;
      }
    }
    ww($.cat_sprite_data, rw(bx + $.walk_sprite_ptrs));
    ww($.cat_sprite_dims, rw(bx + $.walk_sprite_dims));
    // Near the top of the screen, wait for the retrace and a little more so the beam has passed.
    const rom = rb($.rom_id);
    if (rom >= 0xfd) {
      let al = 0x30, cx = 0x2bc;
      if (rom !== 0xfd) { al = 8; cx = 0x3e8; }
      if (rb($.cat_y) <= al) { wait_vsync_start(); cyc(cx * LOOP); }
    }
    restore_alley_buffer();
    ww($.cat_draw_pos, rw($.cat_screen_pos));
    draw_alley_foreground();
    if (await check_level_objects()) draw_alley_foreground();
  }

  // lab_0bac: walking, climbing, jumping and falling everywhere except the fishbowl.
  async function update_animation_0bac() {
    if (await check_dog_collision()) return;
    if (rb($.enemy_active)) return;
    if (rb($.entry_steps)) {
      // Entering the alley: a few steps in from the edge before the player takes over.
      if (rb($.entry_delay)) { if (!rb($.enemy_chasing)) decb($.entry_delay); return; }
      if (decb($.entry_steps) === 0) {
        ww($.scroll_speed, 8);
        update_scroll();
      } else {
        ww($.cat_sprite_data, update_walk_frame());
        update_viewport(rb($.entry_steps), rb($.scroll_direction));
        if (rb($.entry_steps) !== 2) restore_alley_buffer();
        if (await check_dog_collision()) return;
        if (check_enemy_activate()) return;
        ww($.cat_draw_pos, calc_cga_addr(rw($.cat_x), rb($.cat_y)));
        draw_alley_foreground();
        return;
      }
    }
    // lab_0c1c
    const ap = rb($.at_platform);
    if (ap >= 1) {
      if (ap === 1) {
        incb($.at_platform);
        ww($.scroll_speed, 6);
        ww($.cat_screen_pos, calc_cga_addr(rw($.cat_x), rb($.cat_y)));
        restore_alley_buffer();
        if (await check_dog_collision()) return;
        if (check_enemy_activate()) return;
        ww($.cat_draw_pos, rw($.cat_screen_pos));
        ww($.cat_sprite_dims, 0xe03);
        ww($.cat_sprite_data, 0x9da);
        draw_alley_foreground();
      }
      if (!rb($.input_vertical)) return;
      return update_animation_0e78();
    }
    if (!rb($.in_level_mode)) return update_animation_0e23();
    if (update_scroll()) {
      wb($.scroll_direction, 0);
      wb($.anim_counter, 2);
      wb($.in_level_mode, 1);
      wb($.transition_timer, 0);
    } else {
      const acc = rb($.anim_accumulator) - rb($.anim_step);
      wb($.anim_accumulator, acc);
      if (acc < 0) {
        if (rb($.in_level_mode) === 1) { if (rb($.anim_counter) < 4) incb($.anim_counter); }
        else if (rb($.anim_counter) > 1) decb($.anim_counter);
        else wb($.in_level_mode, 1);
      }
    }
    // lab_0cc1: rising (in_level_mode 0xFF) or falling (1)
    let landed = false;
    if (!rb($.transitioning)) {
      let check = true;
      if (rb($.transition_timer)) check = decb($.transition_timer) === 0;
      if (check && rb($.in_level_mode) === 1 && check_level_collision()) landed = true;
    }
    let al = rb($.cat_y_bottom);
    let stop = landed;
    if (!landed) {
      if (rb($.in_level_mode) !== 1) {
        al -= rb($.anim_counter);
        if (al < 0) { al = 0; wb($.in_level_mode, 1); wb($.anim_counter, 1); }
      } else {
        al = (al + rb($.anim_counter)) & 0xff;
        if (al > 0xe6) {
          if (lvl() === 7) {
            if (al >= 0xf8) { al = 0xf8; wb($.cat_died, 1); }
          } else {
            al = 0xe6;
            wb($.game_mode, 0);
            stop = true;
          }
        }
      }
    }
    if (stop) {                                    // lab_0d29: landed
      wb($.in_level_mode, 0);
      wb($.auto_walk, 0);
      ww($.scroll_speed, 2);
      wb($.transition_timer, 0);
      wb($.transitioning, 0);
      if (rb($.at_platform)) await play_crash_sound();
    }
    // lab_0d4f
    wb($.cat_y_bottom, al);
    wb($.cat_y, Math.max(0, al - 0x32));
    ww($.cat_screen_pos, calc_cga_addr(rw($.cat_x), rb($.cat_y)));
    if (!rb($.sprite_hidden)) restore_alley_buffer();
    if (await check_dog_collision()) { wb($.sprite_hidden, 1); return; }
    if (check_enemy_activate()) { wb($.sprite_hidden, 1); return; }
    ww($.cat_draw_pos, rw($.cat_screen_pos));
    let data, bx;
    if (rb($.auto_walk)) {
      ww($.recoil_frame, rw($.recoil_frame) + 2);
      const i = rw($.recoil_frame) & 0xe;
      data = rw(i + $.recoil_sprite_ptrs);
      bx = rw(i + $.recoil_sprite_dims_tbl);
    } else {
      data = rw($.vert_sprite_data);
      bx = rw($.vert_sprite_dims);
    }
    ww($.cat_sprite_data, data);
    ww($.cat_sprite_dims, bx);
    const above = 0x32 - rb($.cat_y_bottom);
    if (above > 0) {
      // Off the top of the screen: clip the sprite's top rows (from vert_sprite_data even
      // during the recoil walk).
      cyc(0x168 * LOOP);
      const bh = (bx >> 8) - above;
      if (bh <= 0) { wb($.sprite_hidden, 1); return; }
      ww($.cat_sprite_dims, (bh << 8) | (bx & 0xff));
      ww($.cat_sprite_data, above * ((bx << 1) & 0xff) + rw($.vert_sprite_data));
    } else {
      let c = -1;
      if (lvl() === 7) c = rb($.cat_y) - 0xbb;
      else if (rb($.game_mode) === 2) c = rb($.cat_y) - 0x5e;
      if (c >= 0) {
        // Dropping below the floor of the love scene, or back out of a room's window.
        const bh = (bx >> 8) - c;
        if (bh <= 0) {
          if (lvl() === 7) { wb($.cat_died, 1); return; }
          setup_alley();
          await play_hiss_sound();
          return;
        }
        ww($.cat_sprite_dims, (bh << 8) | (bx & 0xff));
        wb($.anim_counter, 2);
      }
    }
    draw_alley_foreground();
  }

  // lab_0e23: on the ground or a platform.
  async function update_animation_0e23() {
    if (lvl() === 7 || rb($.cat_y) < 0xb4) {
      if (!check_level_collision()) {
        // Nothing underfoot: start falling.
        wb($.scroll_direction, 0);
        wb($.in_level_mode, 1);
        return update_animation_0ef1(1, 0x20, true);
      }
      if (lvl() === 0) {
        if (!check_jump_collision()) wb($.jump_hit, 0);
        else {
          // Standing on a fence top that a bin lid knocks away: the cat is thrown off.
          if (!rb($.jump_hit)) await play_death_melody();
          wb($.input_vertical, 1);
          wb($.jump_hit, 1);
          const dl = random() & 1;
          wb($.input_horizontal, dl ? dl : 0xff);
        }
      }
    }
    return update_animation_0e78();
  }

  // lab_0e78: take the joystick/keyboard direction.
  async function update_animation_0e78() {
    wb($.prev_scroll_dir, rb($.scroll_direction));
    wb($.scroll_direction, rb($.input_horizontal));
    wb($.in_level_mode, rb($.input_vertical));
    const v = rb($.in_level_mode);
    if (v !== 0) {
      if (v === 1) {
        if (rb($.cat_y) < 0xb4) return update_animation_0ef1(1, 0x20, true);
        wb($.in_level_mode, 0);
        wb($.auto_walk, 0);
        wb($.input_vertical, 0);
      } else {
        // Jump: the higher the walking speed, the flatter the jump.
        wb($.transition_timer, 0);
        const sp = rw($.scroll_speed);
        const bl = sp & 0xff;
        let al = bl;
        if (al > 2) al -= 2;
        ww($.scroll_speed, (sp & 0xff00) | al);
        al = ((bl ^ 0xf) << 4) & 0xff;
        if (rb($.game_mode) === 1) incb($.game_mode);
        return update_animation_0ef1(8, al, false);
      }
    }
    // lab_0f34: walking
    if (lvl() !== 0 && lvl() !== 7) update_footprint();
    update_scroll();
    ww($.cat_screen_pos, calc_cga_addr(rw($.cat_x), rb($.cat_y)));
    if (!(rb($.scroll_direction) | rb($.in_level_mode))) { await spawn_window_event(); return; }
    ww($.cat_sprite_data, update_walk_frame());
    restore_alley_buffer();
    if (await check_dog_collision()) return;
    if (check_enemy_activate()) return;
    ww($.cat_draw_pos, rw($.cat_screen_pos));
    ww($.cat_sprite_dims, 0xb03);
    draw_alley_foreground();
  }

  // lab_0eb1 / lab_0ec9 -> lab_0ef1: start a fall (ah=1, al=0x20) or a jump.
  async function update_animation_0ef1(ah, al, falling) {
    if (falling) {
      wb($.transition_timer, 8);
      if (rb($.game_mode) === 1) wb($.game_mode, 0);
    }
    wb($.anim_step, al);
    wb($.anim_counter, ah);
    wb($.anim_accumulator, 1);
    wb($.at_platform, 0);
    let bl = ((rb($.scroll_direction) + 1) << 1) & 0xff;
    if (rb($.in_level_mode) !== 0xff) bl += 6;
    ww($.vert_sprite_data, rw(bl + $.climb_sprite_ptrs));
    ww($.vert_sprite_dims, rw(bl + $.climb_sprite_dims));
    wb($.l3_platform_id, 0);
    if (rb($.door_contact)) await play_catch_sound();
  }

  // ---- public API -------------------------------------------------------------------------------
  let running = null;
  function boot() {
    M.fill(0);
    M.set(ASSETS.ds, 0);
    M.set(ASSETS.cs, ASSETS.ds.length);
    // The BIOS tick count is the time since midnight; the PIT phase is arbitrary at start-up.
    const d = new Date();
    const secs = d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
    clk = Math.floor(Math.random() * TICK_CYCLES);
    bios_set_ticks(Math.floor(secs * 18.2065) & 0xffff);
    port61 = 0x4c; pit2 = 0; crtcHsync = 0x2d;
    speaker();
    rebootRequested = false;
    resetPace();
  }
  async function run() {
    for (;;) {
      boot();
      try { await entry(); } catch (e) {
        if (!(e instanceof Reboot)) throw e;
        if (stopped) return;
      }
    }
  }
  return {
    start() { if (!running) { stopped = false; running = run().catch((e) => { console.error(e); throw e; }); } return running; },
    stop() { stopped = true; },
    keyEvent(code, down) { keyboard_handler_xt(down ? code : code | 0x80); },
    setSpeed(f) { resetPace(); speed = f; resetPace(); },
    get speed() { return speed; },
    get clock() { return clk; },
    get cpuHz() { return CPU_HZ; },
    get hsyncShift() { return (0x2d - crtcHsync) * 8; },
    set speakerSink(f) { speakerSink = f; speaker(); },
    set sleeper(f) { sleeper = f; },
    mem: M,
    sym: $,
  };
})();
if (typeof module !== 'undefined') module.exports = Game;
