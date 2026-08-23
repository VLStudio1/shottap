// Pure geometry helpers shared by screenshot cropping and area recording.
//
// Every conversion from screen coordinates (device independent pixels, what
// Electron's `screen` module reports) to image coordinates is derived from the
// *actual* pixel size of the captured image rather than from
// `display.scaleFactor`. Windows hands back thumbnails that do not always match
// `bounds x scaleFactor` (mixed DPI, scaled desktops, driver rounding), and
// assuming they match is what makes region screenshots land off-target.

function normalizeRect(rect) {
  const x = Math.min(rect.x, rect.x + rect.width);
  const y = Math.min(rect.y, rect.y + rect.height);

  return {
    x,
    y,
    width: Math.abs(rect.width),
    height: Math.abs(rect.height)
  };
}

function intersectRect(a, b) {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);

  if (right <= x || bottom <= y) {
    return null;
  }

  return { x, y, width: right - x, height: bottom - y };
}

function rectArea(rect) {
  return rect ? rect.width * rect.height : 0;
}

function clampRectToBounds(rect, bounds) {
  const normalized = normalizeRect(rect);
  const x = Math.max(bounds.x, Math.min(normalized.x, bounds.x + bounds.width));
  const y = Math.max(bounds.y, Math.min(normalized.y, bounds.y + bounds.height));
  const right = Math.max(bounds.x, Math.min(normalized.x + normalized.width, bounds.x + bounds.width));
  const bottom = Math.max(bounds.y, Math.min(normalized.y + normalized.height, bounds.y + bounds.height));

  return { x, y, width: right - x, height: bottom - y };
}

// Scale factors derived from the captured image instead of display.scaleFactor.
function captureScaleFactors(displayBounds, imageSize) {
  if (!imageSize || !imageSize.width || !imageSize.height || !displayBounds.width || !displayBounds.height) {
    return { scaleX: 1, scaleY: 1 };
  }

  return {
    scaleX: imageSize.width / displayBounds.width,
    scaleY: imageSize.height / displayBounds.height
  };
}

// Convert a screen-space rectangle into pixel coordinates inside the image that
// was captured for `displayBounds`. Edges are rounded independently so a
// selection never drifts by an extra pixel on high-DPI displays.
function cropRectForDisplay(region, displayBounds, imageSize) {
  const { scaleX, scaleY } = captureScaleFactors(displayBounds, imageSize);
  const local = normalizeRect(region);
  const left = Math.round((local.x - displayBounds.x) * scaleX);
  const top = Math.round((local.y - displayBounds.y) * scaleY);
  const right = Math.round((local.x + local.width - displayBounds.x) * scaleX);
  const bottom = Math.round((local.y + local.height - displayBounds.y) * scaleY);

  const x = Math.max(0, Math.min(left, imageSize.width));
  const y = Math.max(0, Math.min(top, imageSize.height));
  const clampedRight = Math.max(x, Math.min(right, imageSize.width));
  const clampedBottom = Math.max(y, Math.min(bottom, imageSize.height));

  return {
    x,
    y,
    width: clampedRight - x,
    height: clampedBottom - y
  };
}

// The display that holds most of the selection wins. Returns null when the
// region touches nothing (which can happen if a monitor is unplugged mid-drag).
function displayForRegion(region, displays) {
  let best = null;
  let bestArea = 0;

  for (const display of displays) {
    const area = rectArea(intersectRect(region, display.bounds));

    if (area > bestArea) {
      best = display;
      bestArea = area;
    }
  }

  return best;
}

// True when the selection reaches outside the display it belongs to, i.e. the
// user dragged across a monitor edge. Callers tell the user instead of silently
// cropping the result.
function regionSpansMultipleDisplays(region, displays) {
  const owner = displayForRegion(region, displays);

  if (!owner) {
    return false;
  }

  const inside = intersectRect(region, owner.bounds);

  return !inside || Math.abs(rectArea(inside) - rectArea(normalizeRect(region))) > 1;
}

module.exports = {
  captureScaleFactors,
  clampRectToBounds,
  cropRectForDisplay,
  displayForRegion,
  intersectRect,
  normalizeRect,
  rectArea,
  regionSpansMultipleDisplays
};
