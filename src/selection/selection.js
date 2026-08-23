const selectionElement = document.getElementById("selection");
const sizeElement = document.getElementById("selectionSize");
const crosshairX = document.getElementById("crosshairX");
const crosshairY = document.getElementById("crosshairY");
const edgeNote = document.getElementById("edgeNote");
const modeIcon = document.getElementById("modeIcon");
const modeTitle = document.getElementById("modeTitle");
const modeHint = document.getElementById("modeHint");
const banner = document.getElementById("modeBanner");

const ICONS = {
  screenshot:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 8V5a2 2 0 0 1 2-2h3"/><path d="M16 3h3a2 2 0 0 1 2 2v3"/><path d="M21 16v3a2 2 0 0 1-2 2h-3"/><path d="M8 21H5a2 2 0 0 1-2-2v-3"/><circle cx="12" cy="12" r="3.2"/></svg>',
  record:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 8V5a2 2 0 0 1 2-2h3"/><path d="M16 3h3a2 2 0 0 1 2 2v3"/><path d="M21 16v3a2 2 0 0 1-2 2h-3"/><path d="M8 21H5a2 2 0 0 1-2-2v-3"/><circle class="record-dot" cx="12" cy="12" r="4"/></svg>'
};

let config = null;
let origin = null;
let rect = null;
let finished = false;

function clamp(value, min, max) {
  return Math.max(min, Math.min(value, max));
}

function applyMode(mode) {
  const isRecord = mode === "record";
  document.body.dataset.mode = isRecord ? "record" : "screenshot";
  modeIcon.innerHTML = isRecord ? ICONS.record : ICONS.screenshot;
  modeTitle.textContent = isRecord ? "Record Area" : "Screenshot Area";
  modeHint.textContent = isRecord
    ? "Drag to start a video recording · Esc cancels"
    : "Drag to capture a still image · Esc cancels";
  banner.setAttribute("aria-label", isRecord ? "Record area selection" : "Screenshot area selection");
}

function updateCrosshair(event) {
  crosshairX.hidden = false;
  crosshairY.hidden = false;
  crosshairX.style.top = `${event.clientY}px`;
  crosshairY.style.left = `${event.clientX}px`;
}

function drawSelection() {
  selectionElement.hidden = false;
  selectionElement.style.left = `${rect.x}px`;
  selectionElement.style.top = `${rect.y}px`;
  selectionElement.style.width = `${rect.width}px`;
  selectionElement.style.height = `${rect.height}px`;
  sizeElement.textContent = `${Math.round(rect.width)} × ${Math.round(rect.height)}`;
  sizeElement.dataset.flip = String(rect.y + rect.height + 34 > window.innerHeight);
}

function pointerPosition(event) {
  // Clamped to this display, so a drag that runs off the monitor edge visibly
  // stops there rather than silently producing a cropped capture.
  const x = clamp(event.clientX, 0, window.innerWidth);
  const y = clamp(event.clientY, 0, window.innerHeight);

  if (x !== event.clientX || y !== event.clientY) {
    edgeNote.hidden = false;
  }

  return { x, y };
}

window.addEventListener("pointerdown", (event) => {
  // The overlay appears before its configuration arrives; ignore input until
  // the display bounds are known so a fast drag cannot produce a bad rectangle.
  if (!config) {
    return;
  }

  if (event.button !== 0) {
    window.shottapSelection.cancel();
    return;
  }

  origin = pointerPosition(event);
  rect = { x: origin.x, y: origin.y, width: 0, height: 0 };
  // Dimmed a little so it never hides the target, but still readable: the user
  // must be able to tell a screenshot from a recording mid-drag.
  banner.style.opacity = "0.75";
  drawSelection();
});

window.addEventListener("pointermove", (event) => {
  updateCrosshair(event);

  if (!origin) {
    return;
  }

  const point = pointerPosition(event);
  rect = {
    x: Math.min(origin.x, point.x),
    y: Math.min(origin.y, point.y),
    width: Math.abs(point.x - origin.x),
    height: Math.abs(point.y - origin.y)
  };
  drawSelection();
});

window.addEventListener("pointerup", async () => {
  if (!origin || !rect || finished) {
    return;
  }

  finished = true;

  if (rect.width < 4 || rect.height < 4) {
    await window.shottapSelection.cancel();
    return;
  }

  await window.shottapSelection.finish({
    x: rect.x + config.bounds.x,
    y: rect.y + config.bounds.y,
    width: rect.width,
    height: rect.height
  });
});

window.addEventListener("keydown", async (event) => {
  if (event.key === "Escape") {
    finished = true;
    await window.shottapSelection.cancel();
  }
});

window.addEventListener("contextmenu", (event) => event.preventDefault());

window.shottapSelection.getConfig().then((result) => {
  config = result || { mode: "screenshot", bounds: { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight } };
  applyMode(config.mode);
  document.body.dataset.ready = "true";
});
