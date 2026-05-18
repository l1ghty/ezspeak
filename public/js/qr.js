// ── Minimal QR Code Generator ───────────────────────────────────────────────
// Generates alphanumeric QR codes (M-level error correction) on a <canvas>.
// No external dependencies.  ~250 lines.

function generateQRCode(text, canvas, size) {
  if (!canvas) return;
  size = size || 250;
  const ver = chooseVersion(text);
  const sizePx = size;
  const modules = 17 + ver * 4;
  const moduleSize = Math.floor(sizePx / (modules + 8));
  const margin = Math.floor((sizePx - moduleSize * modules) / 2);

  canvas.width = sizePx;
  canvas.height = sizePx;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, sizePx, sizePx);

  const matrix = buildMatrix(text, ver);

  ctx.fillStyle = '#000';
  for (let r = 0; r < modules; r++) {
    for (let c = 0; c < modules; c++) {
      if (matrix[r] && matrix[r][c]) {
        ctx.fillRect(margin + c * moduleSize, margin + r * moduleSize, moduleSize, moduleSize);
      }
    }
  }
}

// ── Version selection ───────────────────────────────────────────────────────

function chooseVersion(text) {
  // M-level alphanumeric max char counts (calculated from data codeword capacity)
  const caps = [20, 38, 61, 90, 122, 154, 178, 221, 262, 311];
  for (let v = 0; v < caps.length; v++) {
    if (text.length <= caps[v]) return v + 1;
  }
  throw new Error('Text too long for QR code');
}

// ── Alphanumeric encoding ───────────────────────────────────────────────────

const ALPHA = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

function encodeAlpha(text) {
  const bits = [];
  const pushBits = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >> i) & 1); };
  for (let i = 0; i < text.length; i += 2) {
    const v1 = ALPHA.indexOf(text[i]);
    if (i + 1 < text.length) {
      const v2 = ALPHA.indexOf(text[i + 1]);
      pushBits(v1 * 45 + v2, 11);
    } else {
      pushBits(v1, 6);
    }
  }
  return bits;
}

// ── Build matrix ────────────────────────────────────────────────────────────

function buildMatrix(text, ver) {
  const modules = 17 + ver * 4;

  // ECC block info (M-level): [totalCodewords, ecPerBlock, numBlocks]
  const capInfo = [
    [26, 10, 1],  [44, 16, 1],  [70, 26, 1],  [100, 18, 2], [134, 24, 2],
    [172, 16, 4], [196, 18, 4], [242, 22, 4], [292, 22, 5], [346, 26, 5],
    [404, 30, 5], [466, 34, 5], [532, 30, 8], [581, 30, 9], [655, 36, 9],
    [733, 36, 10],[815, 38, 10],[901, 44, 10],[991, 46, 10],[1085, 50, 10]
  ];
  const totalCW = capInfo[ver - 1][0];
  const ecPerBlock = capInfo[ver - 1][1];
  const numBlocks = capInfo[ver - 1][2];
  const dataCW = totalCW - ecPerBlock * numBlocks;

  // Encode data
  const modeBits = [0, 0, 1, 0]; // alphanumeric
  const lenBits = ver <= 9 ? 9 : 11;
  const len = text.length;
  const lenBitArr = [];
  for (let i = lenBits - 1; i >= 0; i--) lenBitArr.push((len >> i) & 1);

  let dataBits = [...modeBits, ...lenBitArr, ...encodeAlpha(text)];

  // Pad to data capacity in bits
  const dataBitsCap = dataCW * 8;
  if (dataBits.length > dataBitsCap) throw new Error('Data too large');
  // Terminator (up to 4 zeros)
  const termLen = Math.min(4, dataBitsCap - dataBits.length);
  for (let i = 0; i < termLen; i++) dataBits.push(0);
  // Pad to multiple of 8
  while (dataBits.length % 8 !== 0) dataBits.push(0);
  // Pad bytes
  const padBytes = [0xEC, 0x11];
  let pi = 0;
  while (dataBits.length < dataBitsCap) {
    const b = padBytes[pi % 2];
    for (let j = 7; j >= 0; j--) dataBits.push((b >> j) & 1);
    pi++;
  }

  // Convert bits to bytes
  const dataBytes = [];
  for (let i = 0; i < dataBits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | dataBits[i + j];
    dataBytes.push(b);
  }

  // Split data into blocks and compute error correction
  const dataPerBlock = Math.floor(dataBytes.length / numBlocks);
  const rem = dataBytes.length % numBlocks;
  const dataBlocks = [];
  const ecBlocks = [];
  let off = 0;
  for (let i = 0; i < numBlocks; i++) {
    const blockLen = dataPerBlock + (i < rem ? 1 : 0);
    const block = dataBytes.slice(off, off + blockLen);
    off += blockLen;
    dataBlocks.push(block);
    ecBlocks.push(computeEC(block, ecPerBlock));
  }

  // Interleave data blocks then EC blocks
  const finalCodewords = [];
  const maxDataLen = Math.max(...dataBlocks.map(b => b.length));
  for (let j = 0; j < maxDataLen; j++) {
    for (let i = 0; i < numBlocks; i++) {
      if (j < dataBlocks[i].length) finalCodewords.push(dataBlocks[i][j]);
    }
  }
  for (let j = 0; j < ecPerBlock; j++) {
    for (let i = 0; i < numBlocks; i++) {
      finalCodewords.push(ecBlocks[i][j]);
    }
  }

  // Create matrix
  const matrix = Array.from({ length: modules }, () => new Uint8Array(modules));

  // Place finder patterns
  placeFinder(matrix, 0, 0);
  placeFinder(matrix, modules - 7, 0);
  placeFinder(matrix, 0, modules - 7);

  // Timing patterns
  for (let i = 8; i < modules - 8; i++) {
    matrix[6][i] = (i % 2 === 0) ? 2 : 3;
    matrix[i][6] = (i % 2 === 0) ? 2 : 3;
  }

  // Alignment patterns for version >= 2
  if (ver >= 2) {
    const locs = getAlignmentLocs(ver);
    for (const r of locs) {
      for (const c of locs) {
        if ((r === 6 && c === 6) || (r === 6 && c === locs[locs.length - 1]) || (r === locs[locs.length - 1] && c === 6)) continue;
        placeAlignment(matrix, r, c);
      }
    }
  }

  // Reserve format info area
  for (let i = 0; i <= 8; i++) {
    if (matrix[i][8] === 0) matrix[i][8] = 3;
    if (matrix[8][i] === 0) matrix[8][i] = 3;
  }
  for (let i = 0; i <= 7; i++) {
    if (matrix[modules - 1 - i][8] === 0) matrix[modules - 1 - i][8] = 3;
    if (matrix[8][modules - 1 - i] === 0) matrix[8][modules - 1 - i] = 3;
  }
  matrix[modules - 8][8] = 3;

  // Reserve version info area for version >= 7
  if (ver >= 7) {
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 6; j++) {
        if (matrix[i][modules - 11 + j] === 0) matrix[i][modules - 11 + j] = 3;
        if (matrix[modules - 11 + j][i] === 0) matrix[modules - 11 + j][i] = 3;
      }
    }
  }

  // Place data
  const dataBitsFinal = [];
  for (const b of finalCodewords) {
    for (let j = 7; j >= 0; j--) dataBitsFinal.push((b >> j) & 1);
  }

  // Fill data modules in zigzag pattern
  let col = modules - 1;
  let row = 0;
  let dir = -1; // going up
  let bitIdx = 0;
  while (col > 0) {
    if (col === 6) col = 5;
    for (let r = 0; r < modules; r++) {
      const rr = dir === -1 ? modules - 1 - row : row;
      for (let c = col; c > col - 2; c--) {
        if (matrix[rr] && matrix[rr][c] === 0 && bitIdx < dataBitsFinal.length) {
          matrix[rr][c] = dataBitsFinal[bitIdx] ? 3 : 2;
          bitIdx++;
        }
      }
      row++;
    }
    row = 0;
    col -= 2;
    dir = -dir;
  }

  // Apply mask and choose best
  let bestMask = 0;
  let bestPenalty = Infinity;
  let bestMatrix = null;

  for (let mask = 0; mask < 8; mask++) {
    const candidate = applyMask(matrix, mask, modules);
    const penalty = evaluateMask(candidate, modules);
    if (penalty < bestPenalty) {
      bestPenalty = penalty;
      bestMask = mask;
      bestMatrix = candidate;
    }
  }

  // Format info
  const formatBits = getFormatBits(bestMask);
  // Place format info
  const formatCoords = [
    [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
    [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]
  ];
  for (let i = 0; i < 15; i++) {
    const r = formatCoords[i][0], c = formatCoords[i][1];
    bestMatrix[r][c] = formatBits[i];
    bestMatrix[modules - 1 - c][modules - 1 - r + (r === 8 && c === 8 ? 0 : 0)] = formatBits[i];
  }
  // Bottom-left dark module
  bestMatrix[modules - 8][8] = formatBits[14];

  // Convert to boolean matrix (true = dark)
  const result = Array.from({ length: modules }, () => new Uint8Array(modules));
  for (let r = 0; r < modules; r++) {
    for (let c = 0; c < modules; c++) {
      result[r][c] = (bestMatrix[r][c] & 1) ? 1 : 0;
    }
  }
  return result;
}

// ── Finder pattern ──────────────────────────────────────────────────────────

function placeFinder(matrix, row, col) {
  for (let r = -1; r <= 7; r++) {
    for (let c = -1; c <= 7; c++) {
      const rr = row + r, cc = col + c;
      if (rr < 0 || cc < 0 || rr >= matrix.length || cc >= matrix.length) continue;
      if (r >= 0 && r <= 6 && c >= 0 && c <= 6 && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4))) {
        matrix[rr][cc] = 3;
      } else {
        matrix[rr][cc] = 2;
      }
    }
  }
}

// ── Alignment pattern ───────────────────────────────────────────────────────

function placeAlignment(matrix, row, col) {
  for (let r = -2; r <= 2; r++) {
    for (let c = -2; c <= 2; c++) {
      const rr = row + r, cc = col + c;
      if (rr < 0 || cc < 0 || rr >= matrix.length || cc >= matrix.length) continue;
      matrix[rr][cc] = (r === -2 || r === 2 || c === -2 || c === 2 || (r === 0 && c === 0)) ? 3 : 2;
    }
  }
}

function getAlignmentLocs(ver) {
  const table = [
    [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42],
    [6, 26, 46], [6, 28, 50], [6, 30, 54], [6, 32, 58], [6, 34, 62], [6, 26, 46, 66],
    [6, 26, 48, 70], [6, 26, 50, 74], [6, 30, 54, 78], [6, 30, 56, 82], [6, 30, 58, 86],
    [6, 34, 62, 90], [6, 28, 50, 72, 94], [6, 26, 50, 74, 98], [6, 30, 54, 78, 102],
    [6, 28, 54, 80, 106], [6, 32, 58, 84, 110], [6, 30, 58, 86, 114], [6, 34, 62, 90, 118],
    [6, 26, 50, 74, 98, 122], [6, 30, 54, 78, 102, 126], [6, 26, 52, 78, 104, 130],
    [6, 30, 56, 82, 108, 134], [6, 34, 60, 86, 112, 138], [6, 30, 58, 86, 114, 142],
    [6, 34, 62, 90, 118, 146], [6, 30, 54, 78, 102, 126, 150], [6, 24, 50, 76, 102, 128, 154],
    [6, 28, 54, 80, 106, 132, 158], [6, 32, 58, 84, 110, 136, 162], [6, 26, 54, 82, 110, 138, 166],
    [6, 30, 58, 86, 114, 142, 170]
  ];
  return table[ver] || [6];
}

// ── Masking ─────────────────────────────────────────────────────────────────

function applyMask(matrix, mask, modules) {
  const result = matrix.map(row => new Uint8Array(row));
  for (let r = 0; r < modules; r++) {
    for (let c = 0; c < modules; c++) {
      if (result[r][c] <= 2) {
        let invert = false;
        switch (mask) {
          case 0: invert = (r + c) % 2 === 0; break;
          case 1: invert = r % 2 === 0; break;
          case 2: invert = c % 3 === 0; break;
          case 3: invert = (r + c) % 3 === 0; break;
          case 4: invert = (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0; break;
          case 5: invert = (r * c) % 2 + (r * c) % 3 === 0; break;
          case 6: invert = ((r * c) % 2 + (r * c) % 3) % 2 === 0; break;
          case 7: invert = ((r + c) % 2 + (r * c) % 3) % 2 === 0; break;
        }
        if (invert) result[r][c] = result[r][c] === 2 ? 3 : 2;
      }
    }
  }
  return result;
}

function evaluateMask(matrix, modules) {
  let penalty = 0;
  // Adjacent same-color penalty (horizontal + vertical)
  for (let r = 0; r < modules; r++) {
    for (let c = 0; c < modules; c++) {
      if (c < modules - 4) {
        let same = true;
        for (let k = 1; k <= 4; k++) { if ((matrix[r][c + k] & 1) !== (matrix[r][c] & 1)) { same = false; break; } }
        if (same) penalty += 3;
      }
      if (r < modules - 4) {
        let same = true;
        for (let k = 1; k <= 4; k++) { if ((matrix[r + k][c] & 1) !== (matrix[r][c] & 1)) { same = false; break; } }
        if (same) penalty += 3;
      }
    }
  }
  // 2x2 block penalty
  for (let r = 0; r < modules - 1; r++) {
    for (let c = 0; c < modules - 1; c++) {
      const v = matrix[r][c] & 1;
      if ((matrix[r][c+1] & 1) === v && (matrix[r+1][c] & 1) === v && (matrix[r+1][c+1] & 1) === v) {
        penalty += 3;
      }
    }
  }
  return penalty;
}

// ── Format info ─────────────────────────────────────────────────────────────

function getFormatBits(mask) {
  // EC level M (00), mask pattern
  let data = (0 << 2) | mask; // M = 00
  let bits = data << 10;
  const poly = 0x537;
  for (let i = 14; i >= 10; i--) {
    if (bits & (1 << i)) bits ^= poly << (i - 10);
  }
  const ec = bits & 0x3FF;
  const result = ((data << 10) | ec) ^ 0x5412;
  const arr = [];
  for (let i = 14; i >= 0; i--) arr.push((result >> i) & 1);
  return arr;
}

// ── Error correction (Reed-Solomon) ─────────────────────────────────────────

function computeEC(data, ecCount) {
  const gen = getGeneratorPoly(ecCount);
  const msg = new Uint8Array(data.length + ecCount);
  msg.set(data, 0);

  for (let i = 0; i < data.length; i++) {
    const factor = msg[i];
    if (factor !== 0) {
      for (let j = 0; j < gen.length; j++) {
        msg[i + j] ^= gfMul(gen[j], factor);
      }
    }
  }
  return msg.slice(data.length, data.length + ecCount);
}

// GF(256) arithmetic
const EXP_TABLE = new Uint8Array(512);
const LOG_TABLE = new Uint8Array(256);

(function initGF() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP_TABLE[i] = x;
    EXP_TABLE[i + 255] = x;
    LOG_TABLE[x] = i;
    x = (x << 1) ^ ((x & 0x80) ? 0x11D : 0);
    x &= 0xFF;
  }
  // x is 1 again at 255, set LOG_TABLE[1] = 0 (already)
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP_TABLE[(LOG_TABLE[a] + LOG_TABLE[b]) % 255];
}

function getGeneratorPoly(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    poly = polyMul(poly, [1, EXP_TABLE[i]]);
  }
  return new Uint8Array(poly);
}

function polyMul(a, b) {
  const result = new Uint8Array(a.length + b.length - 1);
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      result[i + j] ^= gfMul(a[i], b[j]);
    }
  }
  return result;
}
