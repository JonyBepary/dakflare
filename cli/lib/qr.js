/**
 * A small QR encoder — byte mode, error-correction level L, versions 1–10.
 *
 * Why this exists: `dakflare pair --qr` must work on a machine with no
 * dependencies installed. `qrencode` is used when it is on PATH; this module is
 * the fallback, so the command never needs a network install or npm package.
 *
 * Versions 1–10 cover 274 bytes at level L, which is more than a pairing deep
 * link needs (the production link is ~90 bytes). Longer payloads ask the
 * operator to install `qrencode`; silently truncating a pairing link would be
 * worse than refusing.
 *
 * The implementation follows ISO/IEC 18004: mode indicator + character count,
 * Reed–Solomon blocks, interleaving, function patterns, data placement, the
 * eight masks with the standard penalty score, and BCH format/version words.
 */

const RS_BLOCKS = {
  1: { ec: 7, groups: [[1, 19]] },
  2: { ec: 10, groups: [[1, 34]] },
  3: { ec: 15, groups: [[1, 55]] },
  4: { ec: 20, groups: [[1, 80]] },
  5: { ec: 26, groups: [[1, 108]] },
  6: { ec: 18, groups: [[2, 68]] },
  7: { ec: 20, groups: [[2, 78]] },
  8: { ec: 24, groups: [[2, 97]] },
  9: { ec: 30, groups: [[2, 116]] },
  10: { ec: 18, groups: [[2, 68], [2, 69]] },
};

const ALIGNMENT = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50],
};

/* ───────────────────────── GF(256) arithmetic ───────────────────────── */

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
}

const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

function polyMul(a, b) {
  const out = new Array(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i += 1) {
    for (let j = 0; j < b.length; j += 1) out[i + j] ^= gfMul(a[i], b[j]);
  }
  return out;
}

function generatorPoly(count) {
  let g = [1];
  for (let i = 0; i < count; i += 1) g = polyMul(g, [1, EXP[i]]);
  return g;
}

function reedSolomon(data, ecCount) {
  const gen = generatorPoly(ecCount);
  const buffer = new Array(data.length + ecCount).fill(0);
  data.forEach((value, index) => {
    buffer[index] = value;
  });
  for (let i = 0; i < data.length; i += 1) {
    const factor = buffer[i];
    if (factor === 0) continue;
    for (let j = 0; j < gen.length; j += 1) buffer[i + j] ^= gfMul(gen[j], factor);
  }
  return buffer.slice(data.length);
}

/* ───────────────────────── BCH words ───────────────────────── */

function bchRemainder(value, poly, degree) {
  let v = value;
  for (let bit = 31 - Math.clz32(v); bit >= degree; bit -= 1) {
    if ((v >>> bit) & 1) v ^= poly << (bit - degree);
  }
  return v;
}

function versionWord(version) {
  const remainder = bchRemainder(version << 12, 0x1f25, 12);
  return (version << 12) | remainder;
}

function formatWord(mask) {
  const data = (0b01 << 3) | mask; // 01 = error-correction level L
  const remainder = bchRemainder(data << 10, 0x537, 10);
  return ((data << 10) | remainder) ^ 0x5412;
}

/* ───────────────────────── capacity and version choice ───────────────────────── */

function dataCodewords(version) {
  const spec = RS_BLOCKS[version];
  return spec.groups.reduce((sum, [blocks, count]) => sum + blocks * count, 0);
}

function pickVersion(byteLength) {
  for (let version = 1; version <= 10; version += 1) {
    const countBits = version < 10 ? 8 : 16;
    if (4 + countBits + byteLength * 8 <= dataCodewords(version) * 8) return version;
  }
  return 0;
}

/* ───────────────────────── bit stream ───────────────────────── */

function buildDataCodewords(bytes, version) {
  const total = dataCodewords(version);
  const capacityBits = total * 8;
  const bits = [];

  const push = (value, width) => {
    for (let i = width - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
  };

  push(0b0100, 4); // byte mode
  push(bytes.length, version < 10 ? 8 : 16);
  for (const byte of bytes) push(byte, 8);

  const terminator = Math.min(4, capacityBits - bits.length);
  push(0, terminator);
  while (bits.length % 8 !== 0) bits.push(0);

  const words = [];
  for (let i = 0; i < bits.length; i += 8) {
    let value = 0;
    for (let j = 0; j < 8; j += 1) value = (value << 1) | bits[i + j];
    words.push(value);
  }

  const pad = [0xec, 0x11];
  let padIndex = 0;
  while (words.length < total) {
    words.push(pad[padIndex % 2]);
    padIndex += 1;
  }
  return words;
}

function interleave(words, version) {
  const spec = RS_BLOCKS[version];
  const blocks = [];
  let offset = 0;
  for (const [count, dataLen] of spec.groups) {
    for (let i = 0; i < count; i += 1) {
      const data = words.slice(offset, offset + dataLen);
      offset += dataLen;
      blocks.push({ data, ec: reedSolomon(data, spec.ec) });
    }
  }

  const out = [];
  const maxData = Math.max(...blocks.map((block) => block.data.length));
  for (let i = 0; i < maxData; i += 1) {
    for (const block of blocks) if (i < block.data.length) out.push(block.data[i]);
  }
  for (let i = 0; i < spec.ec; i += 1) {
    for (const block of blocks) out.push(block.ec[i]);
  }
  return out;
}

/* ───────────────────────── matrix construction ───────────────────────── */

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r * c) % 3) + ((r + c) % 2)) % 2 === 0,
];

function makeMatrix(size) {
  return {
    size,
    dark: Array.from({ length: size }, () => new Array(size).fill(false)),
    fn: Array.from({ length: size }, () => new Array(size).fill(false)),
  };
}

function setFunction(matrix, row, col, dark) {
  matrix.dark[row][col] = dark;
  matrix.fn[row][col] = true;
}

function drawFinder(matrix, row, col) {
  for (let i = -1; i <= 7; i += 1) {
    for (let j = -1; j <= 7; j += 1) {
      const r = row + i;
      const c = col + j;
      if (r < 0 || r >= matrix.size || c < 0 || c >= matrix.size) continue;
      const dark =
        (i >= 0 && i <= 6 && (j === 0 || j === 6)) ||
        (j >= 0 && j <= 6 && (i === 0 || i === 6)) ||
        (i >= 2 && i <= 4 && j >= 2 && j <= 4);
      setFunction(matrix, r, c, dark);
    }
  }
}

function drawFunctionPatterns(matrix, version) {
  const { size } = matrix;

  drawFinder(matrix, 0, 0);
  drawFinder(matrix, 0, size - 7);
  drawFinder(matrix, size - 7, 0);

  // Alignment patterns come BEFORE the timing lines. An alignment pattern whose
  // centre sits on row/column 6 is still required; it replaces the timing
  // modules there. Drawing timing first and skipping occupied centres would
  // silently drop two alignment patterns at version 7 (and later versions),
  // shifting every data module and producing a QR that looks plausible and
  // does not scan.
  const positions = ALIGNMENT[version];
  for (const row of positions) {
    for (const col of positions) {
      if (matrix.fn[row][col]) continue; // overlaps a finder
      for (let i = -2; i <= 2; i += 1) {
        for (let j = -2; j <= 2; j += 1) {
          setFunction(matrix, row + i, col + j, Math.max(Math.abs(i), Math.abs(j)) !== 1);
        }
      }
    }
  }

  // Timing lines fill only the cells an alignment pattern has not claimed.
  for (let i = 8; i < size - 8; i += 1) {
    if (!matrix.fn[6][i]) setFunction(matrix, 6, i, i % 2 === 0);
    if (!matrix.fn[i][6]) setFunction(matrix, i, 6, i % 2 === 0);
  }

  // The fixed dark module, always present beside the bottom-left finder.
  setFunction(matrix, size - 8, 8, true);

  if (version >= 7) {
    const bits = versionWord(version);
    for (let i = 0; i < 18; i += 1) {
      const dark = ((bits >>> i) & 1) === 1;
      setFunction(matrix, Math.floor(i / 3), size - 11 + (i % 3), dark);
      setFunction(matrix, size - 11 + (i % 3), Math.floor(i / 3), dark);
    }
  }
}

function drawFormat(matrix, mask) {
  const bits = formatWord(mask);
  const { size } = matrix;
  const bit = (index) => ((bits >>> index) & 1) === 1;

  // Vertical copy beside the top-left finder.
  for (let i = 0; i < 15; i += 1) {
    if (i < 6) setFunction(matrix, i, 8, bit(i));
    else if (i < 8) setFunction(matrix, i + 1, 8, bit(i));
    else setFunction(matrix, size - 15 + i, 8, bit(i));
  }

  // Horizontal copy, split between the two top finders.
  for (let i = 0; i < 15; i += 1) {
    if (i < 8) setFunction(matrix, 8, size - i - 1, bit(i));
    else if (i === 8) setFunction(matrix, 8, 7, bit(i));
    else setFunction(matrix, 8, 15 - i - 1, bit(i));
  }

  setFunction(matrix, size - 8, 8, true);
}

function placeData(matrix, codewords) {
  const { size } = matrix;
  let row = size - 1;
  let direction = -1;
  let byteIndex = 0;
  let bitIndex = 7;

  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col -= 1; // the vertical timing column is not data
    for (;;) {
      for (let c = 0; c < 2; c += 1) {
        const target = col - c;
        if (matrix.fn[row][target]) continue;
        let dark = false;
        if (byteIndex < codewords.length) {
          dark = ((codewords[byteIndex] >>> bitIndex) & 1) === 1;
        }
        matrix.dark[row][target] = dark;
        bitIndex -= 1;
        if (bitIndex < 0) {
          byteIndex += 1;
          bitIndex = 7;
        }
      }
      row += direction;
      if (row < 0 || row >= size) {
        row -= direction;
        direction = -direction;
        break;
      }
    }
  }
}

function applyMask(matrix, mask) {
  const predicate = MASKS[mask];
  for (let r = 0; r < matrix.size; r += 1) {
    for (let c = 0; c < matrix.size; c += 1) {
      if (!matrix.fn[r][c] && predicate(r, c)) matrix.dark[r][c] = !matrix.dark[r][c];
    }
  }
}

function cloneMatrix(matrix) {
  return {
    size: matrix.size,
    dark: matrix.dark.map((row) => row.slice()),
    fn: matrix.fn.map((row) => row.slice()),
  };
}

/* ───────────────────────── mask penalty ───────────────────────── */

function penalty(matrix) {
  const { size, dark } = matrix;
  let score = 0;

  // Rule 1: runs of five or more.
  const scoreLine = (line) => {
    let run = 1;
    for (let i = 1; i < line.length; i += 1) {
      if (line[i] === line[i - 1]) run += 1;
      else {
        if (run >= 5) score += 3 + (run - 5);
        run = 1;
      }
    }
    if (run >= 5) score += 3 + (run - 5);
  };

  for (let r = 0; r < size; r += 1) scoreLine(dark[r]);
  for (let c = 0; c < size; c += 1) scoreLine(dark.map((row) => row[c]));

  // Rule 2: 2×2 blocks.
  for (let r = 0; r < size - 1; r += 1) {
    for (let c = 0; c < size - 1; c += 1) {
      const value = dark[r][c];
      if (value === dark[r][c + 1] && value === dark[r + 1][c] && value === dark[r + 1][c + 1]) {
        score += 3;
      }
    }
  }

  // Rule 3: the finder-like 1:1:3:1:1 pattern with four light modules beside it.
  const pattern = [true, false, true, true, true, false, true];
  const matches = (line, start) => {
    for (let i = 0; i < 7; i += 1) if (line[start + i] !== pattern[i]) return false;
    return true;
  };
  const allLight = (line, start, end) => {
    for (let i = start; i < end; i += 1) if (line[i]) return false;
    return true;
  };
  const scanRule3 = (line) => {
    for (let i = 0; i + 7 <= line.length; i += 1) {
      if (!matches(line, i)) continue;
      const before = i >= 4 && allLight(line, i - 4, i);
      const after = i + 11 <= line.length && allLight(line, i + 7, i + 11);
      if (before || after) score += 40;
    }
  };
  for (let r = 0; r < size; r += 1) scanRule3(dark[r]);
  for (let c = 0; c < size; c += 1) scanRule3(dark.map((row) => row[c]));

  // Rule 4: deviation from a 50% dark ratio.
  let darkCount = 0;
  for (const row of dark) for (const value of row) if (value) darkCount += 1;
  const percent = (darkCount * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;

  return score;
}

/* ───────────────────────── public API ───────────────────────── */

/**
 * Build a QR matrix for `text`.
 *
 * @param {string} text
 * @param {{mask?: number}} [options] force a mask (0–7); by default the lowest
 *   penalty is chosen
 * @returns {{version:number,size:number,modules:boolean[][],functionModules:boolean[][]}}
 */
export function createQr(text, options = {}) {
  const bytes = Buffer.from(text, 'utf8');
  const version = pickVersion(bytes.length);
  if (!version) {
    throw new Error(
      'payload is too long for the built-in QR encoder (maximum 274 bytes at version 10-L); install `qrencode` for larger QR codes'
    );
  }

  const codewords = interleave(buildDataCodewords(bytes, version), version);
  const matrix = makeMatrix(version * 4 + 17);
  drawFunctionPatterns(matrix, version);
  drawFormat(matrix, 0); // reserve the format area before data placement
  placeData(matrix, codewords);

  let bestMask = 0;
  let bestScore = Infinity;
  if (Number.isInteger(options.mask) && options.mask >= 0 && options.mask <= 7) {
    bestMask = options.mask;
  } else {
    for (let mask = 0; mask < 8; mask += 1) {
      const candidate = cloneMatrix(matrix);
      applyMask(candidate, mask);
      drawFormat(candidate, mask);
      const score = penalty(candidate);
      if (score < bestScore) {
        bestScore = score;
        bestMask = mask;
      }
    }
  }

  applyMask(matrix, bestMask);
  drawFormat(matrix, bestMask);

  return { version, size: matrix.size, modules: matrix.dark, functionModules: matrix.fn };
}

/**
 * Render a matrix with half-block characters: one terminal line holds two
 * module rows, and the quiet zone is four modules on every side.
 *
 * @param {{size:number,modules:boolean[][]}} qr
 * @returns {string}
 */
export function renderQr(qr) {
  const quiet = 4;
  const { size, modules } = qr;
  const inBounds = (x, y) => x >= 0 && x < size && y >= 0 && y < size;
  const dark = (x, y) => (inBounds(x, y) ? modules[y][x] : false);

  const lines = [];
  for (let y = -quiet; y < size + quiet; y += 2) {
    let line = '';
    for (let x = -quiet; x < size + quiet; x += 1) {
      const top = dark(x, y);
      const bottom = dark(x, y + 1);
      line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ';
    }
    lines.push(line);
  }
  return lines.join('\n');
}
