/**
 * Generates minimal PNG icons for the Chrome extension
 */
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import zlib from 'zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, '..', '..', 'extension', 'icons');

function crc32(buf) {
  let c = 0xffffffff;
  const table = [];
  for (let n = 0; n < 256; n++) {
    let cr = n;
    for (let k = 0; k < 8; k++) cr = cr & 1 ? 0xedb88320 ^ (cr >>> 1) : cr >>> 1;
    table[n] = cr;
  }
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const chunk = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(chunk));
  return Buffer.concat([len, chunk, crc]);
}

function createPng(size, r, g, b) {
  const raw = [];
  for (let y = 0; y < size; y++) {
    raw.push(0);
    for (let x = 0; x < size; x++) {
      const cx = x - size / 2;
      const cy = y - size / 2;
      const inCircle = cx * cx + cy * cy <= (size * 0.42) ** 2;
      if (inCircle) {
        raw.push(r, g, b, 255);
      } else {
        raw.push(0, 0, 0, 0);
      }
    }
  }
  const compressed = zlib.deflateSync(Buffer.from(raw));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

mkdirSync(outDir, { recursive: true });
for (const size of [16, 48, 128]) {
  writeFileSync(join(outDir, `icon${size}.png`), createPng(size, 46, 125, 50));
}
console.log('Icons written to', outDir);
