const test = require("node:test");
const assert = require("node:assert/strict");

const geometry = require("../src/main/geometry");

test("crop rect matches the region exactly at 100% scaling", () => {
  const rect = geometry.cropRectForDisplay(
    { x: 100, y: 120, width: 200, height: 150 },
    { x: 0, y: 0, width: 1920, height: 1080 },
    { width: 1920, height: 1080 }
  );

  assert.deepEqual(rect, { x: 100, y: 120, width: 200, height: 150 });
});

test("crop rect scales by the captured image, not by an assumed scale factor", () => {
  // 1920x1080 panel reported as 1280x720 DIP (150% scaling).
  const rect = geometry.cropRectForDisplay(
    { x: 100, y: 100, width: 200, height: 150 },
    { x: 0, y: 0, width: 1280, height: 720 },
    { width: 1920, height: 1080 }
  );

  assert.deepEqual(rect, { x: 150, y: 150, width: 300, height: 225 });
});

test("crop rect follows a capture that is not exactly bounds x scaleFactor", () => {
  // Windows sometimes returns a thumbnail a couple of pixels off the ideal
  // size. Using display.scaleFactor here would shift the crop.
  const imageSize = { width: 1912, height: 1074 };
  const rect = geometry.cropRectForDisplay(
    { x: 0, y: 0, width: 640, height: 360 },
    { x: 0, y: 0, width: 1280, height: 720 },
    imageSize
  );

  assert.deepEqual(rect, { x: 0, y: 0, width: 956, height: 537 });
  assert.equal(rect.width, Math.round(imageSize.width / 2));
});

test("crop rect handles a monitor positioned to the left (negative origin)", () => {
  const rect = geometry.cropRectForDisplay(
    { x: -1820, y: 40, width: 300, height: 200 },
    { x: -1920, y: 0, width: 1920, height: 1080 },
    { width: 1920, height: 1080 }
  );

  assert.deepEqual(rect, { x: 100, y: 40, width: 300, height: 200 });
});

test("crop rect is clamped to the captured image", () => {
  const rect = geometry.cropRectForDisplay(
    { x: 1800, y: 1000, width: 400, height: 400 },
    { x: 0, y: 0, width: 1920, height: 1080 },
    { width: 1920, height: 1080 }
  );

  assert.deepEqual(rect, { x: 1800, y: 1000, width: 120, height: 80 });
});

test("scale factors are derived per axis", () => {
  const { scaleX, scaleY } = geometry.captureScaleFactors(
    { x: 0, y: 0, width: 1280, height: 800 },
    { width: 1600, height: 1200 }
  );

  assert.equal(scaleX, 1.25);
  assert.equal(scaleY, 1.5);
});

test("the display holding most of the selection wins on a mixed-DPI desktop", () => {
  const displays = [
    { id: 1, bounds: { x: 0, y: 0, width: 1280, height: 720 } },
    { id: 2, bounds: { x: 1280, y: 0, width: 1920, height: 1080 } }
  ];

  assert.equal(geometry.displayForRegion({ x: 1200, y: 100, width: 400, height: 200 }, displays).id, 2);
  assert.equal(geometry.displayForRegion({ x: 1100, y: 100, width: 220, height: 200 }, displays).id, 1);
});

test("a selection crossing a monitor edge is reported rather than silently cropped", () => {
  const displays = [
    { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
    { id: 2, bounds: { x: 1920, y: 0, width: 1920, height: 1080 } }
  ];

  assert.equal(geometry.regionSpansMultipleDisplays({ x: 1800, y: 100, width: 400, height: 200 }, displays), true);
  assert.equal(geometry.regionSpansMultipleDisplays({ x: 100, y: 100, width: 400, height: 200 }, displays), false);
});

test("rectangles dragged up and to the left are normalised", () => {
  assert.deepEqual(geometry.normalizeRect({ x: 500, y: 400, width: -200, height: -100 }), {
    x: 300,
    y: 300,
    width: 200,
    height: 100
  });
});

test("clamping keeps a selection inside its own display", () => {
  const clamped = geometry.clampRectToBounds(
    { x: 1700, y: 900, width: 600, height: 400 },
    { x: 0, y: 0, width: 1920, height: 1080 }
  );

  assert.deepEqual(clamped, { x: 1700, y: 900, width: 220, height: 180 });
});
