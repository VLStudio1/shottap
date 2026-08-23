const test = require("node:test");
const assert = require("node:assert/strict");

const { UNSATISFIABLE, parseRange } = require("../src/main/range");

const SIZE = 5000;

test("an open-ended range covers the rest of the file", () => {
  assert.deepEqual(parseRange("bytes=0-", SIZE), { start: 0, end: 4999 });
  assert.deepEqual(parseRange("bytes=1200-", SIZE), { start: 1200, end: 4999 });
});

test("a range that runs past the end of the file is clamped", () => {
  // The Content-Length written from this must match the bytes actually sent —
  // an unclamped end is what made short recordings fail to play.
  const parsed = parseRange("bytes=0-524287", SIZE);

  assert.deepEqual(parsed, { start: 0, end: 4999 });
  assert.equal(parsed.end - parsed.start + 1, SIZE);
});

test("a suffix range asks for the last bytes, not the first", () => {
  assert.deepEqual(parseRange("bytes=-500", SIZE), { start: 4500, end: 4999 });
});

test("a suffix longer than the file is the whole file", () => {
  assert.deepEqual(parseRange("bytes=-99999", SIZE), { start: 0, end: 4999 });
});

test("ranges that cannot be served are reported as unsatisfiable", () => {
  assert.equal(parseRange("bytes=6000-7000", SIZE), UNSATISFIABLE);
  assert.equal(parseRange("bytes=5000-", SIZE), UNSATISFIABLE);
  assert.equal(parseRange("bytes=-0", SIZE), UNSATISFIABLE);
  assert.equal(parseRange("bytes=0-", 0), UNSATISFIABLE);
});

test("unparseable and multi-range headers fall back to a full response", () => {
  assert.equal(parseRange("bytes=0-100,200-300", SIZE), null);
  assert.equal(parseRange("bytes=-", SIZE), null);
  assert.equal(parseRange("items=0-10", SIZE), null);
  assert.equal(parseRange("", SIZE), null);
});
