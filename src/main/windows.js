// Window lifecycle: the main window, the per-display selection overlays and the
// hidden recorder window that owns the MediaRecorder pipeline.

const { BrowserWindow, nativeTheme, screen } = require("electron");
const path = require("path");

const { MEDIA_PROTOCOL, MIN_REGION_SIZE } = require("../shared/constants");
const geometry = require("./geometry");

const SELECTION_DIR = path.join(__dirname, "..", "selection");
const RECORDER_DIR = path.join(__dirname, "..", "recorder");
const PRELOAD_DIR = path.join(__dirname, "..", "preload");
const APP_ICON = path.join(__dirname, "..", "renderer", "assets", "shottap-mark.png");

let mainWindow = null;
let recorderWindow = null;
let selectionWindows = [];
let selectionContext = null;
let pendingSelection = null;
// A 'closed' event can arrive after the next selection is already under way.
// The token tells a late event that its session is over.
let selectionToken = 0;

function backgroundFor(theme) {
  const dark = theme === "dark" || (theme === "system" && nativeTheme.shouldUseDarkColors);

  return dark ? "#16181d" : "#f4f6f9";
}

function createMainWindow({ theme }) {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 840,
    minWidth: 780,
    minHeight: 560,
    show: false,
    title: "ShotTap",
    icon: APP_ICON,
    backgroundColor: backgroundFor(theme),
    webPreferences: {
      preload: path.join(PRELOAD_DIR, "main.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  });

  mainWindow.removeMenu();
  // Served through the custom scheme so library media is same-origin.
  mainWindow.loadURL(`${MEDIA_PROTOCOL}://app/index.html`);

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  return mainWindow;
}

function getMainWindow() {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
}

function sendToRenderer(channel, payload) {
  const window = getMainWindow();

  if (window) {
    window.webContents.send(channel, payload);
  }
}

function setMainBackground(theme) {
  const window = getMainWindow();

  if (window) {
    window.setBackgroundColor(backgroundFor(theme));
  }
}

// Shows the window without taking focus away from whatever the user is doing.
function revealMain({ focus }) {
  const window = getMainWindow();

  if (!window) {
    return;
  }

  if (window.isMinimized()) {
    window.restore();
  }

  if (focus) {
    window.show();
    window.focus();
  } else if (!window.isVisible()) {
    window.showInactive();
  }
}

function getRecorderWindow() {
  if (recorderWindow && !recorderWindow.isDestroyed()) {
    return recorderWindow;
  }

  recorderWindow = new BrowserWindow({
    width: 480,
    height: 320,
    show: false,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(PRELOAD_DIR, "recorder.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // A hidden window would otherwise have its timers throttled, which
      // starves the area-recording draw loop.
      backgroundThrottling: false
    }
  });

  recorderWindow.removeMenu();
  recorderWindow.loadFile(path.join(RECORDER_DIR, "recorder.html"));

  recorderWindow.on("closed", () => {
    recorderWindow = null;
  });

  return recorderWindow;
}

function closeRecorderWindow() {
  if (recorderWindow && !recorderWindow.isDestroyed()) {
    recorderWindow.destroy();
  }

  recorderWindow = null;
}

function isRecorderWindow(webContents) {
  return Boolean(recorderWindow && !recorderWindow.isDestroyed() && recorderWindow.webContents === webContents);
}

// The overlay must vanish the instant the drag ends — any delay here reads as
// lag. Both steps were briefly deferred while hunting the post-capture crash;
// that turned out to be a nativeImage being serialised across IPC, nothing to
// do with window teardown, so this is back to immediate.
function closeSelectionWindows() {
  const windows = selectionWindows;
  selectionWindows = [];
  selectionContext = null;

  for (const window of windows) {
    if (!window.isDestroyed()) {
      window.destroy();
    }
  }
}

function finishSelection(rect) {
  const resolve = pendingSelection;
  pendingSelection = null;
  closeSelectionWindows();

  if (resolve) {
    resolve(rect);
  }
}

// `mode` is "screenshot" or "record" and drives the overlay's colour, icon and
// label so the user always knows what releasing the mouse will do.
function requestSelection(mode) {
  if (pendingSelection) {
    return Promise.resolve(null);
  }

  const displays = screen.getAllDisplays();
  const token = ++selectionToken;
  selectionContext = new Map();

  // Claimed before the windows exist so an overlay that closes immediately
  // cannot slip past the resolver.
  const settled = new Promise((resolve) => {
    pendingSelection = resolve;
  });

  for (const display of displays) {
    const window = new BrowserWindow({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      fullscreenable: false,
      hasShadow: false,
      enableLargerThanScreen: true,
      title: mode === "record" ? "Select recording area" : "Select screenshot area",
      webPreferences: {
        preload: path.join(PRELOAD_DIR, "selection.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });

    selectionWindows.push(window);
    selectionContext.set(window.webContents.id, { mode, bounds: display.bounds, displayId: display.id });
    window.setAlwaysOnTop(true, "screen-saver");
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    window.loadFile(path.join(SELECTION_DIR, "selection.html"));

    // An overlay can go away without a finish/cancel round trip — Alt+F4, a
    // page that never loads, a display disconnected mid-drag. Once the last one
    // is gone the capture has to be released, or `pendingSelection` and the
    // caller's in-flight guard both stay set and area capture is dead until the
    // app restarts.
    window.on("closed", () => {
      if (token !== selectionToken) {
        return;
      }

      selectionWindows = selectionWindows.filter((entry) => entry !== window);

      if (selectionWindows.length === 0 && pendingSelection) {
        finishSelection(null);
      }
    });

    window.once("ready-to-show", () => {
      if (window.isDestroyed()) {
        return;
      }

      window.setBounds(display.bounds);
      window.show();
      window.focus();
    });
  }

  if (selectionWindows.length === 0) {
    finishSelection(null);
  }

  return settled;
}

function selectionConfigFor(webContentsId) {
  return selectionContext?.get(webContentsId) || null;
}

function isSelectionWindow(webContents) {
  return selectionWindows.some((window) => !window.isDestroyed() && window.webContents === webContents);
}

// Overlay coordinates arrive in screen space; clamp them to the display that
// produced them so a drag beyond a monitor edge can never crop into a
// neighbouring screen's pixels.
function normalizeSelectionResult(rect, config) {
  if (!rect || !config) {
    return null;
  }

  const clamped = geometry.clampRectToBounds(rect, config.bounds);

  if (clamped.width < MIN_REGION_SIZE || clamped.height < MIN_REGION_SIZE) {
    return null;
  }

  const requested = geometry.normalizeRect(rect);

  return {
    ...clamped,
    displayId: config.displayId,
    clamped: Math.abs(requested.width - clamped.width) > 1 || Math.abs(requested.height - clamped.height) > 1
  };
}

// Hides the main window for the duration of a capture so ShotTap never ends
// up inside its own screenshot, then puts it back exactly as it was.
async function withHiddenMainWindow(work) {
  const window = getMainWindow();
  const wasVisible = Boolean(window && window.isVisible());

  if (wasVisible) {
    window.hide();
    await new Promise((resolve) => setTimeout(resolve, 160));
  }

  try {
    return await work();
  } finally {
    if (wasVisible && getMainWindow()) {
      // showInactive keeps the user's foreground app in front.
      getMainWindow().showInactive();
    }
  }
}

module.exports = {
  backgroundFor,
  closeRecorderWindow,
  closeSelectionWindows,
  createMainWindow,
  finishSelection,
  getMainWindow,
  getRecorderWindow,
  isRecorderWindow,
  isSelectionWindow,
  normalizeSelectionResult,
  requestSelection,
  revealMain,
  selectionConfigFor,
  sendToRenderer,
  setMainBackground,
  withHiddenMainWindow
};
