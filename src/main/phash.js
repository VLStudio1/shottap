// Perceptual image hashing (dHash) for the reverse image search.
//
// Pure functions over raw decoded pixels so the math is unit-testable from
// plain node without Electron. Callers decode and resize the image themselves
// (see imagesearch.js) and hand over the bitmap; hamming() compares hashes.

// Grayscale from the sum of the three colour channels. The channel order does
// not matter, which keeps the hash identical whether the decoder produced
// RGBA or BGRA data.
function luminance(data, offset) {
  return data[offset] + data[offset + 1] + data[offset + 2];
}

// dHash: compare each pixel with its right neighbour on a 9x8 grid. A 9x8
// bitmap yields exactly 64 bits (one per horizontal pair), returned as a
// lowercase hex string.
function dhash(bitmap) {
  if (!bitmap || typeof bitmap !== "object") {
    return null;
  }

  const { width, height, data } = bitmap;

  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 1) {
    return null;
  }
  if (!Buffer.isBuffer(data) && !(data instanceof Uint8Array)) {
    return null;
  }
  if (data.length < width * height * 4) {
    return null;
  }

  let hash = 0n;
  let bits = 0;

  for (let y = 0; y < height; y += 1) {
    const row = y * width * 4;
    for (let x = 0; x < width - 1; x += 1) {
      const left = luminance(data, row + x * 4);
      const right = luminance(data, row + (x + 1) * 4);
      if (left > right) {
        hash |= 1n << BigInt(63 - bits);
      }
      bits += 1;
    }
  }

  if (bits === 0) {
    return null;
  }

  return hash.toString(16).padStart(Math.ceil(bits / 4), "0");
}

function isHash(value) {
  return typeof value === "string" && /^[0-9a-f]+$/.test(value) && value.length > 0;
}

// Number of differing bits between two hashes. Hashes of different lengths or
// malformed values never match.
function hamming(a, b) {
  if (!isHash(a) || !isHash(b) || a.length !== b.length) {
    return Infinity;
  }

  const difference = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);

  let count = 0;
  for (const character of difference.toString(2)) {
    if (character === "1") {
      count += 1;
    }
  }

  return count;
}

// Match quality as a percentage: 100 for identical hashes, lower as bits differ.
function similarity(a, b) {
  const distance = hamming(a, b);
  if (!Number.isFinite(distance)) {
    return 0;
  }

  const bits = a.length * 4;
  return Math.round((1 - distance / bits) * 100);
}

module.exports = {
  dhash,
  hamming,
  similarity
};
