// Rebuilds the original CAT.EXE load image from the disassembly, without an assembler.
//   data segment (DS, 0x7130 bytes): the `db` lines of cat.asm and data/*.asm, in include order
//   code segment (CS, 0x62EB bytes): the raw instruction bytes of the Ghidra listing cat.txt
// Exports { ds, cs, dsLabels } and, run directly, cross-checks the two sources.
'use strict';
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'orig-src', 'assembly');
const DS_SIZE = 0x7130, CS_SIZE = 0x62eb;
// CS offsets of the 9 relocated words (the `mov reg,data_segment` sites)
const RELOCS = [0x0009, 0x0541, 0x1125, 0x13ed, 0x14b8, 0x1501, 0x2ade, 0x3a98, 0x5c9f];

function readDataSection() {
  const out = [];
  const labels = {};
  const lines = fs.readFileSync(path.join(SRC, 'cat.asm'), 'latin1').split('\n');
  let inData = false;
  const walk = (lines) => {
    for (const raw of lines) {
      const line = raw.replace(/;.*$/, '').trim();
      if (/^section \.data/.test(line)) { inData = true; continue; }
      if (/^section \.code/.test(line)) { inData = false; continue; }
      if (!inData || !line) continue;
      let m;
      if ((m = /^%include "(.+)"$/.exec(line))) {
        walk(fs.readFileSync(path.join(SRC, m[1]), 'latin1').split('\n'));
      } else if ((m = /^([A-Za-z_][\w]*):$/.exec(line))) {
        labels[m[1]] = out.length;
      } else if ((m = /^db (.+)$/.exec(line))) {
        for (const v of m[1].split(',')) out.push(parseInt(v.trim(), 16) & 0xff);
      } else if (/ equ /.test(line)) {
        const [a, b] = line.split(/\s+equ\s+/);
        labels[a] = b;
      } else {
        throw new Error('unexpected data line: ' + raw);
      }
    }
  };
  walk(lines);
  for (const k in labels) if (typeof labels[k] === 'string') labels[k] = labels[labels[k]];
  return { bytes: Uint8Array.from(out), labels };
}

function readListing() {
  const lines = fs.readFileSync(path.join(SRC, 'cat.txt'), 'latin1').split('\n');
  const ds = new Int16Array(DS_SIZE).fill(-1);
  const cs = new Int16Array(CS_SIZE).fill(-1);
  for (const l of lines) {
    const m = /^CODE_([12]):[0-9a-f]{4}:([0-9a-f]{4})([0-9a-f]*)(\.\.\.)?/.exec(l);
    if (!m) continue;
    const seg = m[1] === '1' ? ds : cs;
    let hex = m[3];
    if (m[4]) hex = hex.slice(0, hex.length & ~1);   // truncated by Ghidra: keep whole bytes only
    let off = parseInt(m[2], 16);
    for (let i = 0; i < hex.length; i += 2) seg[off++] = parseInt(hex.substr(i, 2), 16);
  }
  return { ds, cs };
}

function build() {
  const data = readDataSection();
  const listing = readListing();
  if (data.bytes.length !== DS_SIZE) throw new Error('data section size ' + data.bytes.length);
  const cs = new Uint8Array(CS_SIZE);
  for (let i = 0; i < CS_SIZE; i++) cs[i] = listing.cs[i] & 0xff;
  // The only code line Ghidra truncated: 1723:1462  MOV word ptr ES:[0x120],0x1554 (hardware.asm)
  cs.set([0x26, 0xc7, 0x06, 0x20, 0x01, 0x54, 0x15], 0x1462);
  // Ghidra shows relocated segment words with its load base 0x1000 added; the file holds 0x0010.
  for (const o of RELOCS) { cs[o] = 0x10; cs[o + 1] = 0x00; }
  return { ds: data.bytes, cs, dsLabels: data.labels, listing };
}

module.exports = build;

if (require.main === module) {
  const img = build();
  let dsCmp = 0, dsDiff = 0, csHoles = 0;
  for (let i = 0; i < DS_SIZE; i++) {
    if (img.listing.ds[i] < 0) continue;
    dsCmp++;
    if (img.listing.ds[i] !== img.ds[i]) dsDiff++;
  }
  for (let i = 0; i < CS_SIZE; i++) if (img.listing.cs[i] < 0 && !(i >= 0x1462 && i < 0x1469)) csHoles++;
  console.log(`DS: ${dsCmp} listing bytes compared with cat.asm, ${dsDiff} differ`);
  console.log(`CS: ${csHoles} unknown bytes`);
  // MZ checksum: sum of all words of the file must be 0xFFFF
  const hdr = fs.readFileSync(path.join(SRC, 'cat.asm'), 'latin1');
  const exe = buildExe(img);
  let sum = 0;
  for (let i = 0; i < exe.length; i += 2) sum = (sum + exe[i] + ((exe[i + 1] || 0) << 8)) & 0xffff;
  console.log(`EXE ${exe.length} bytes, word sum ${sum.toString(16)} (ffff = valid MZ checksum)`);
  if (process.argv[2]) {
    const ref = fs.readFileSync(process.argv[2]);
    console.log('compare with', process.argv[2], Buffer.compare(ref, Buffer.from(exe)) === 0 ? 'IDENTICAL' : 'DIFFERENT');
  }
}

function buildExe(img) {
  // MZ header bytes as listed in cat.asm (relocation entries point at the 9 `mov reg,DATA_SEG` sites)
  const relocs = RELOCS;
  const exe = new Uint8Array(0x200 + 0x100 + DS_SIZE + CS_SIZE);
  const w = (o, v) => { exe[o] = v & 0xff; exe[o + 1] = v >> 8; };
  [0x5a4d, 0x011b, 0x006c, 9, 0x20, 0, 0xffff, 0, 0x100, 0x8555, 0, 0x723, 0x20, 0].forEach((v, i) => w(i * 2, v));
  exe.set([0xdc, 0x0b, 0x00, 0x04], 28);
  relocs.forEach((o, i) => { w(0x20 + i * 4, o); w(0x22 + i * 4, 0x723); });
  exe.set(img.ds, 0x300);
  exe.set(img.cs, 0x300 + DS_SIZE);
  return exe;
}
module.exports.buildExe = buildExe;
