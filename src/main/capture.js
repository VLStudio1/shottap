// Screenshot capture.
//
// Displays are grabbed before the selection overlay opens, so the overlay can
// never appear inside the shot and the picture the user selects from is exactly
// the picture that gets cropped.

const { desktopCapturer, screen } = require("electron");

const { MIN_REGION_SIZE } = require("../shared/constants");
const geometry = require("./geometry");
const library = require("./library");
const windows = require("./windows");

const THUMBNAIL_WIDTH = 520;

function makeThumbnail(image) {
  try {
    const size = image.getSize();

    if (!size.width || !size.height) {
      return null;
    }

    const width = Math.min(THUMBNAIL_WIDTH, size.width);

    return image.resize({ width, quality: "good" }).toJPEG(80);
  } catch (_error) {
    return null;
  }
}

// One desktopCapturer round trip covering every display. The requested
// thumbnail size is the display's full pixel size, but the returned image is
// measured afterwards and that measurement is what drives all crop maths.
async function grabDisplays(displays) {
  const maxRequest = displays.reduce(
    (accumulator, display) => ({
      width: Math.max(accumulator.width, Math.round(display.size.width * (display.scaleFactor || 1))),
      height: Math.max(accumulator.height, Math.round(display.size.height * (display.scaleFactor || 1)))
    }),
    { width: 0, height: 0 }
  );

  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: maxRequest,
    fetchWindowIcons: false
  });

  const captures = [];

  for (const display of displays) {
    const source = sources.find((item) => item.display_id === String(display.id));

    if (!source || source.thumbnail.isEmpty()) {
      continue;
    }

    captures.push({
      display,
      image: source.thumbnail,
      imageSize: source.thumbnail.getSize()
    });
  }

  return captures;
}

async function grabDisplay(display) {
  const [capture] = await grabDisplays([display]);

  if (capture) {
    return capture;
  }

  // Single-monitor machines occasionally report a display_id that does not
  // match any source; fall back to the only screen there is rather than
  // returning nothing.
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: {
      width: Math.round(display.size.width * (display.scaleFactor || 1)),
      height: Math.round(display.size.height * (display.scaleFactor || 1))
    }
  });

  const source = sources.find((item) => !item.thumbnail.isEmpty());

  return source ? { display, image: source.thumbnail, imageSize: source.thumbnail.getSize() } : null;
}

function displayUnderCursor() {
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
}

async function storeImage(image, source) {
  const size = image.getSize();
  const item = await library.addImage({
    buffer: image.toPNG(),
    thumbnail: makeThumbnail(image),
    width: size.width,
    height: size.height,
    source
  });

  return { item, image };
}

// `onImage` is handed the finished bitmap before anything is written to disk.
// Auto copy uses it so the clipboard is ready the instant the shot exists,
// instead of after the PNG encode, the thumbnail and the index write.
function announce(options, image) {
  if (typeof options.onImage === "function") {
    try {
      options.onImage(image);
    } catch (_error) {
      // A failing hook must not lose the capture itself.
    }
  }
}

async function captureFullScreen(options = {}) {
  return windows.withHiddenMainWindow(async () => {
    const capture = await grabDisplay(displayUnderCursor());

    if (!capture) {
      return { ok: false, message: "Could not read the screen." };
    }

    announce(options, capture.image);

    const stored = await storeImage(capture.image, "fullscreen");

    return { ok: true, ...stored };
  });
}

// ShotTap stays hidden for the whole area capture, not just the grab. The
// overlay is transparent, so the user is drawing over the live desktop while the
// crop comes from the frozen grab taken moments earlier — restoring the window
// before the overlay opened meant ShotTap was visible on screen but absent
// from the saved image, with whatever it covered showing through instead.
async function captureArea(options = {}) {
  const displays = screen.getAllDisplays();

  return windows.withHiddenMainWindow(async () => {
    const captures = await grabDisplays(displays);

    if (captures.length === 0) {
      return { ok: false, message: "Could not read the screen." };
    }

    const selection = await windows.requestSelection("screenshot");

    if (!selection) {
      return { ok: false, cancelled: true, message: "Selection cancelled." };
    }

    const capture =
      captures.find((item) => item.display.id === selection.displayId) ||
      captures.find((item) => item.display === geometry.displayForRegion(selection, displays));

    if (!capture) {
      return { ok: false, message: "That selection is not on a display ShotTap can read." };
    }

    const cropRect = geometry.cropRectForDisplay(selection, capture.display.bounds, capture.imageSize);

    if (cropRect.width < MIN_REGION_SIZE || cropRect.height < MIN_REGION_SIZE) {
      return { ok: false, cancelled: true, message: "Selection was too small." };
    }

    const cropped = capture.image.crop(cropRect);

    announce(options, cropped);

    const stored = await storeImage(cropped, "area");

    return {
      ok: true,
      ...stored,
      message: selection.clamped ? "Screenshot saved — selection was limited to one display." : undefined
    };
  });
}

module.exports = {
  captureArea,
  captureFullScreen,
  displayUnderCursor,
  grabDisplay,
  grabDisplays,
  makeThumbnail
};
