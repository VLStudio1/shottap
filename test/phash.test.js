const test = require("node:test");
const assert = require("node:assert/strict");

const { dhash, hamming, similarity } = require("../src/main/phash");

const WIDTH = 9;
const HEIGHT = 8;

// Builds an RGBA bitmap where each pixel's value comes from pixel(x, y).
function bitmap(width, height, pixel) {
  const data = Buffer.alloc(width * height * 4);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixel(x, y);
      const offset = (y * width + x) * 4;
      data[offset] = r;
      data[offset + 1] = g;
      data[offset + 2] = b;
      data[offset + 3] = 255;
    }
  }

  return { width, height, data };
}

function gradient(invertedRow = -1) {
  return bitmap(WIDTH, HEIGHT, (x, y) => {
    const value = y === invertedRow ? (WIDTH - 1 - x) * 20 : x * 20;
    return [value, value, value];
  });
}

// Brightness falls left to right, so every comparison (left > right) is true.
function falling() {
  return bitmap(WIDTH, HEIGHT, (x) => {
    const value = (WIDTH - 1 - x) * 20;
    return [value, value, value];
  });
}

test("a falling gradient sets every bit and a flat image sets none", () => {
  assert.equal(dhash(falling()), "f".repeat(16));
  assert.equal(dhash(bitmap(WIDTH, HEIGHT, () => [100, 100, 100])), "0".repeat(16));
});

test("hashes are deterministic and channel order does not matter", () => {
  const rgbOrder = bitmap(WIDTH, HEIGHT, (x) => [x * 20, x * 10, 0]);
  const bgrOrder = bitmap(WIDTH, HEIGHT, (x) => [0, x * 10, x * 20]);

  assert.equal(dhash(rgbOrder), dhash(bgrOrder));
  assert.equal(dhash(rgbOrder), dhash(bitmap(WIDTH, HEIGHT, (x) => [x * 20, x * 10, 0])));
});

test("hamming distance counts differing bits between hashes", () => {
  const base = gradient();
  const oneRowInverted = gradient(4);

  // Inverting one row flips that row's eight comparisons.
  assert.equal(hamming(dhash(base), dhash(oneRowInverted)), 8);
  assert.equal(hamming(dhash(base), dhash(base)), 0);
  assert.equal(hamming(dhash(falling()), "f".repeat(16)), 0);
});

test("hamming rejects malformed or mismatched hashes", () => {
  assert.equal(hamming("", ""), Infinity);
  assert.equal(hamming("abc", "abc"), 0);
  assert.equal(hamming("abcd", "abc"), Infinity);
  assert.equal(hamming("not-a-hash", "not-a-hash"), Infinity);
  assert.equal(hamming(null, dhash(gradient())), Infinity);
});

test("similarity converts distance into a percentage", () => {
  const base = dhash(gradient());
  const oneRowInverted = dhash(gradient(4));

  assert.equal(similarity(base, base), 100);
  assert.equal(similarity(base, oneRowInverted), 88); // 64 - 8 of 64 bits
  assert.equal(similarity(base, "nope"), 0);
});

test("dhash rejects invalid bitmaps", () => {
  assert.equal(dhash(null), null);
  assert.equal(dhash({ width: 1, height: 8, data: Buffer.alloc(32) }), null);
  assert.equal(dhash({ width: 9, height: 8 }), null);
  assert.equal(dhash({ width: 9, height: 8, data: Buffer.alloc(10) }), null);
});
