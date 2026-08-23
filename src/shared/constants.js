// Values shared by the main process, the preloads and (through IPC) the renderer.

// Defaults are the combinations that reliably register on Windows and do not
// collide with the built-in capture tools. Win+Shift+S and PrintScreen belong
// to the Windows snipping tool: registration is often refused outright, and
// where it succeeds it shadows a shortcut the user already relies on. Users can
// still choose them explicitly in Hotkeys — the status shown there always
// reflects what Windows actually granted.
const CAPTURE_ACTIONS = ["screenshotArea", "screenshotFullScreen", "recordArea", "recordFullScreen", "copyAll"];

const DEFAULT_SHORTCUTS = {
  screenshotArea: "Ctrl+Alt+4",
  screenshotFullScreen: "Ctrl+Alt+5",
  recordArea: "Ctrl+Alt+6",
  recordFullScreen: "Ctrl+Alt+7",
  copyAll: "Ctrl+Alt+3"
};

const DEFAULT_PREFERENCES = {
  autoCopyAfterCapture: true,
  bringToFrontAfterCapture: false,
  recordSystemAudio: true,
  recordMicrophone: false,
  recordingQuality: "native",
  recordingFrameRate: 30
};

const RECORDING_QUALITIES = ["native", "1080p", "720p"];
const RECORDING_FRAME_RATES = [24, 30, 60];
const THEMES = ["system", "light", "dark"];

const SETTINGS_VERSION = 2;
const MIN_REGION_SIZE = 8;
const MEDIA_PROTOCOL = "shottap";

module.exports = {
  CAPTURE_ACTIONS,
  DEFAULT_PREFERENCES,
  DEFAULT_SHORTCUTS,
  MEDIA_PROTOCOL,
  MIN_REGION_SIZE,
  RECORDING_FRAME_RATES,
  RECORDING_QUALITIES,
  SETTINGS_VERSION,
  THEMES
};
