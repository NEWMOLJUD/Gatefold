// QR codes, drawn here so that the key of an authenticator app never leaves
// the installation: no outside service sees it, and the page needs no script.
// Text is stored as bytes, with error correction level M (a code survives
// about 15% of damage, plenty for a screen).

// Per version (1 to 40; index 0 is unused), for level M: how many correction
// bytes each block carries, and how many blocks there are. From ISO/IEC 18004.
const ECC_PER_BLOCK = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28];
const BLOCKS = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49];
const MAX_VERSION = 40;
/** The light margin every reader expects around a code, in modules. */
const QUIET = 4;

/** How many modules of a version carry data or correction (the rest are the fixed patterns). */
function rawModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2;
    result -= (25 * align - 10) * align - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

function dataBytes(version: number): number {
  return Math.floor(rawModules(version) / 8) - ECC_PER_BLOCK[version]! * BLOCKS[version]!;
}

// Reed-Solomon over GF(2^8), the error correction of every QR code.
function multiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function divisor(degree: number): number[] {
  const result: number[] = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = multiply(result[j]!, root);
      if (j + 1 < degree) result[j] = result[j]! ^ result[j + 1]!;
    }
    root = multiply(root, 2);
  }
  return result;
}

function remainder(data: number[], by: number[]): number[] {
  const result = by.map(() => 0);
  for (const byte of data) {
    const factor = byte ^ result.shift()!;
    result.push(0);
    by.forEach((coefficient, i) => { result[i] = result[i]! ^ multiply(coefficient, factor); });
  }
  return result;
}

/** The data split into blocks, each with its correction bytes, woven together as the standard asks. */
function withCorrection(data: number[], version: number): number[] {
  const blocks = BLOCKS[version]!;
  const ecc = ECC_PER_BLOCK[version]!;
  const total = Math.floor(rawModules(version) / 8);
  const short = blocks - (total % blocks);
  const shortLength = Math.floor(total / blocks);
  const by = divisor(ecc);
  const parts: number[][] = [];
  for (let i = 0, at = 0; i < blocks; i++) {
    const part = data.slice(at, at + shortLength - ecc + (i < short ? 0 : 1));
    at += part.length;
    const correction = remainder(part, by);
    if (i < short) part.push(0);
    parts.push(part.concat(correction));
  }
  const result: number[] = [];
  for (let i = 0; i < parts[0]!.length; i++) {
    parts.forEach((part, j) => {
      // The padding of the short blocks is not part of the code.
      if (i !== shortLength - ecc || j >= short) result.push(part[i]!);
    });
  }
  return result;
}

/** Where the small alignment squares sit, on both axes. */
function alignmentPositions(version: number, size: number): number[] {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const step = Math.floor((version * 8 + count * 3 + 5) / (count * 4 - 2)) * 2;
  const result = [6];
  for (let position = size - 7; result.length < count; position -= step) result.splice(1, 0, position);
  return result;
}

const MASKS: ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

/**
 * The code for `text` as rows of modules (`true` is dark), without the margin.
 * `null` when the text does not fit in the largest code (about 2300 bytes).
 */
export function qrMatrix(text: string): boolean[][] | null {
  const bytes = new TextEncoder().encode(text);
  let version = 1;
  const lengthBits = (): number => (version < 10 ? 8 : 16);
  while (4 + lengthBits() + bytes.length * 8 > dataBytes(version) * 8) {
    if (++version > MAX_VERSION) return null;
  }

  // The message: "these are bytes", how many, the bytes, then filler up to the capacity.
  const capacity = dataBytes(version) * 8;
  const bits: number[] = [];
  const append = (value: number, length: number): void => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  append(4, 4);
  append(bytes.length, lengthBits());
  for (const byte of bytes) append(byte, 8);
  append(0, Math.min(4, capacity - bits.length));
  append(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) append(pad, 8);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((byte, bit) => (byte << 1) | bit, 0));
  const codewords = withCorrection(data, version);

  const size = version * 4 + 17;
  const dark: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  /** The modules of the fixed patterns, which carry no data and are not masked. */
  const fixed: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const set = (x: number, y: number, on: boolean): void => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    dark[y]![x] = on;
    fixed[y]![x] = true;
  };

  // Timing lines, the three big corner squares, the alignment squares.
  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]] as const) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const distance = Math.max(Math.abs(dx), Math.abs(dy));
        set(cx + dx, cy + dy, distance !== 2 && distance !== 4);
      }
    }
  }
  const align = alignmentPositions(version, size);
  align.forEach((cx, i) => {
    align.forEach((cy, j) => {
      const last = align.length - 1;
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return; // a corner square is there
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    });
  });

  /** The 15 bits beside the corners: the correction level and which mask was used. */
  const drawFormat = (mask: number): void => {
    const value = mask; // level M is 00, so only the mask remains
    let rest = value;
    for (let i = 0; i < 10; i++) rest = (rest << 1) ^ ((rest >>> 9) * 0x537);
    const format = ((value << 10) | rest) ^ 0x5412;
    const bit = (i: number): boolean => ((format >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6));
    set(8, 8, bit(7));
    set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true);
  };
  drawFormat(0);

  // Larger codes also say their version, twice.
  if (version >= 7) {
    let rest = version;
    for (let i = 0; i < 12; i++) rest = (rest << 1) ^ ((rest >>> 11) * 0x1f25);
    const value = (version << 12) | rest;
    for (let i = 0; i < 18; i++) {
      const on = ((value >>> i) & 1) !== 0;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, on);
      set(b, a, on);
    }
  }

  // The data, in the zigzag that goes up and down from the bottom right corner.
  let placed = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vertical = 0; vertical < size; vertical++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vertical : vertical;
        if (!fixed[y]![x] && placed < codewords.length * 8) {
          dark[y]![x] = ((codewords[placed >>> 3]! >>> (7 - (placed & 7))) & 1) !== 0;
          placed++;
        }
      }
    }
  }

  const applyMask = (mask: number): void => {
    const flips = MASKS[mask]!;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (!fixed[y]![x] && flips(x, y)) dark[y]![x] = !dark[y]![x];
      }
    }
  };

  /** How hard the code is to read: long runs, blocks, shapes like a corner square, and imbalance all count. */
  const penalty = (): number => {
    const lines: string[] = [];
    for (let i = 0; i < size; i++) {
      let row = "";
      let column = "";
      for (let j = 0; j < size; j++) {
        row += dark[i]![j] ? "1" : "0";
        column += dark[j]![i] ? "1" : "0";
      }
      lines.push(row, column);
    }
    let result = 0;
    for (const line of lines) {
      for (const run of line.match(/0{5,}|1{5,}/g) ?? []) result += run.length - 2;
      for (const shape of ["10111010000", "00001011101"]) {
        for (let at = line.indexOf(shape); at >= 0; at = line.indexOf(shape, at + 1)) result += 40;
      }
    }
    let count = 0;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const here = dark[y]![x]!;
        if (here) count++;
        if (x + 1 < size && y + 1 < size && here === dark[y]![x + 1] && here === dark[y + 1]![x] && here === dark[y + 1]![x + 1]) result += 3;
      }
    }
    const total = size * size;
    return result + (Math.ceil(Math.abs(count * 20 - total * 10) / total) - 1) * 10;
  };

  // Every mask gives a valid code; the one easiest to read is kept.
  let best = 0;
  let lowest = Infinity;
  for (let mask = 0; mask < MASKS.length; mask++) {
    applyMask(mask);
    drawFormat(mask);
    const found = penalty();
    if (found < lowest) {
      best = mask;
      lowest = found;
    }
    applyMask(mask); // the same mask twice undoes it
  }
  applyMask(best);
  drawFormat(best);
  return dark;
}

/**
 * The code as an SVG picture to place in a page: dark modules on white, with
 * the margin, so it reads in the dark theme too. It carries no text, so
 * nothing in it needs escaping. `null` when `text` is too long for a code.
 */
export function qrSvg(text: string, pixels: number, label: string): string | null {
  const matrix = qrMatrix(text);
  if (matrix === null) return null;
  const side = matrix.length + QUIET * 2;
  let path = "";
  matrix.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (!row[x]) continue;
      let run = 1;
      while (row[x + run]) run++;
      path += `M${x + QUIET},${y + QUIET}h${run}v1h-${run}z`;
      x += run;
    }
  });
  const name = label.replace(/[^\w .,-]/g, "");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${side} ${side}" width="${pixels}" height="${pixels}" role="img" aria-label="${name}" shape-rendering="crispEdges">` +
    `<rect width="${side}" height="${side}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}
