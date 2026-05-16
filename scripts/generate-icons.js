// Generate PWA icons as minimal PNGs (no dependencies)
const fs = require('fs');
const zlib = require('zlib');

function png(w, h, r, g, b, a = 255) {
  // Build PNG manually: IHDR + IDAT (raw filtered rows) + IEND
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = chunk('IHDR', (() => {
    const b = Buffer.alloc(13);
    b.writeUInt32BE(w, 0); b.writeUInt32BE(h, 4);
    b[8] = 8;  // bit depth
    b[9] = 6;  // RGBA
    b[10] = 0; b[11] = 0; b[12] = 0;
    return b;
  })());

  // Raw image data: filter byte (0=none) + RGBA per row
  const raw = Buffer.alloc((1 + 4 * w) * h);
  for (let y = 0; y < h; y++) {
    const off = y * (1 + 4 * w);
    raw[off] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      const px = off + 1 + x * 4;
      raw[px] = r; raw[px + 1] = g; raw[px + 2] = b; raw[px + 3] = a;
    }
  }
  const idat = chunk('IDAT', zlib.deflateSync(raw));
  const iend = chunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdr, idat, iend]);
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeB = Buffer.from(type, 'ascii');
  const crc = crc32(Buffer.concat([typeB, data]));
  const crcB = Buffer.alloc(4);
  crcB.writeUInt32BE(crc, 0);
  return Buffer.concat([len, typeB, data, crcB]);
}

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (c & 1 ? 0xEDB88320 : 0);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// Teal (#5eead4) icons
fs.writeFileSync('public/icon-192.png', png(192, 192, 94, 234, 212));
fs.writeFileSync('public/icon-512.png', png(512, 512, 94, 234, 212));
console.log('✅ PWA icons generated');
