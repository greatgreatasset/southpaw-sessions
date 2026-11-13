// Decoder for Firefox's "mozLz4" container (sessionstore *.jsonlz4 / *.baklz4):
// 8-byte magic "mozLz40\0", 4-byte little-endian decompressed size, then one
// raw LZ4 block. Pure — no dependencies.

const MAGIC = [0x6d, 0x6f, 0x7a, 0x4c, 0x7a, 0x34, 0x30, 0x00]; // "mozLz40\0"

/** @param {Uint8Array} bytes */
export function isMozLz4(bytes) {
  if (bytes.length < 12) return false;
  for (let i = 0; i < MAGIC.length; i++) if (bytes[i] !== MAGIC[i]) return false;
  return true;
}

/**
 * @param {Uint8Array} bytes  whole file contents
 * @returns {Uint8Array}      decompressed payload
 */
export function decodeMozLz4(bytes) {
  if (!isMozLz4(bytes)) throw new Error('not a mozLz4 file');
  const size = (bytes[8] | (bytes[9] << 8) | (bytes[10] << 16) | (bytes[11] << 24)) >>> 0;
  if (size > 1024 * 1024 * 1024) throw new Error('mozLz4: implausible decompressed size');
  return decodeLz4Block(bytes.subarray(12), size);
}

/**
 * Decode a single raw LZ4 block.
 * @param {Uint8Array} src
 * @param {number} outSize  exact decompressed size
 */
export function decodeLz4Block(src, outSize) {
  const out = new Uint8Array(outSize);
  let s = 0;
  let d = 0;
  const n = src.length;
  while (s < n) {
    const token = src[s++];

    // Literals.
    let litLen = token >>> 4;
    if (litLen === 15) {
      let b;
      do {
        if (s >= n) throw new Error('lz4: truncated literal length');
        b = src[s++];
        litLen += b;
      } while (b === 255);
    }
    if (s + litLen > n || d + litLen > outSize) throw new Error('lz4: literal overrun');
    out.set(src.subarray(s, s + litLen), d);
    s += litLen;
    d += litLen;
    if (s >= n) break; // the last sequence is literals only

    // Match.
    if (s + 2 > n) throw new Error('lz4: truncated match offset');
    const offset = src[s] | (src[s + 1] << 8);
    s += 2;
    if (offset === 0 || offset > d) throw new Error('lz4: invalid match offset');
    let matchLen = token & 15;
    if (matchLen === 15) {
      let b;
      do {
        if (s >= n) throw new Error('lz4: truncated match length');
        b = src[s++];
        matchLen += b;
      } while (b === 255);
    }
    matchLen += 4;
    if (d + matchLen > outSize) throw new Error('lz4: match overrun');
    // Byte-wise on purpose: a match may overlap the bytes it is producing.
    let m = d - offset;
    for (let i = 0; i < matchLen; i++) out[d++] = out[m++];
  }
  if (d !== outSize) throw new Error(`lz4: size mismatch (${d} of ${outSize} bytes)`);
  return out;
}
