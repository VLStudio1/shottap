// Decode worker body: receives file bytes from the main process, decodes them
// with Chromium's off-main-thread image decoders, and returns 9x8 RGBA pixels
// for hashing. The hash itself is computed in the main process so the
// algorithm lives in exactly one place (src/main/phash.js).

(function () {
  const DECODE_WIDTH = 9;
  const DECODE_HEIGHT = 8;

  // Shrinking a 4K image straight to 9x8 samples only a handful of pixels;
  // a two-step shrink keeps the averaging sane at negligible cost. Both
  // resizes happen inside createImageBitmap, which runs on Chromium's
  // per-process decoder threads — a canvas drawImage of the full bitmap
  // would instead serialize every worker through the single GPU process
  // (measured: 1.1x; decoder-thread resizes: parallel).
  const STAGE_WIDTH = 144;
  const STAGE_HEIGHT = 128;

  const tiny = new OffscreenCanvas(DECODE_WIDTH, DECODE_HEIGHT);
  const tinyContext = tiny.getContext("2d", { willReadFrequently: true });

  const PREVIEW_MAX = 260;

  async function toPixels(buffer) {
    const stage = await createImageBitmap(new Blob([buffer]), {
      resizeWidth: STAGE_WIDTH,
      resizeHeight: STAGE_HEIGHT,
      resizeQuality: "medium"
    });

    try {
      const bitmap = await createImageBitmap(stage, {
        resizeWidth: DECODE_WIDTH,
        resizeHeight: DECODE_HEIGHT,
        resizeQuality: "medium"
      });
      tinyContext.drawImage(bitmap, 0, 0);
      bitmap.close();
      return tinyContext.getImageData(0, 0, DECODE_WIDTH, DECODE_HEIGHT).data.buffer;
    } finally {
      stage.close();
    }
  }

  // Result-card previews are decoded here too: generating them on the main
  // process with nativeImage blocks captures for seconds when a search has
  // many matches.
  async function toPreview(buffer) {
    const source = await createImageBitmap(new Blob([buffer]));
    const scale = Math.min(1, PREVIEW_MAX / Math.max(source.width, source.height));
    const width = Math.max(1, Math.round(source.width * scale));
    const height = Math.max(1, Math.round(source.height * scale));

    try {
      const small = await createImageBitmap(source, {
        resizeWidth: width,
        resizeHeight: height,
        resizeQuality: "medium"
      });
      const canvas = new OffscreenCanvas(width, height);
      canvas.getContext("2d").drawImage(small, 0, 0);
      small.close();
      const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.6 });
      return blob.arrayBuffer();
    } finally {
      source.close();
    }
  }

  window.shottapDecoder.onBatch(async (payload) => {
    const results = [];

    for (const file of payload.files) {
      try {
        if (file.mode === "preview") {
          results.push({ id: file.id, ok: true, jpeg: await toPreview(file.buffer) });
        } else {
          results.push({ id: file.id, ok: true, pixels: await toPixels(file.buffer) });
        }
      } catch (_error) {
        results.push({ id: file.id, ok: false });
      }
    }

    window.shottapDecoder.postResults({ batchId: payload.batchId, results });
  });
})();
