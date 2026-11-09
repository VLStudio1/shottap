// Values shared by the main process, the preloads and (through IPC) the renderer.

// Defaults are the combinations that reliably register on Windows and do not
// collide with the built-in capture tools. Win+Shift+S and PrintScreen belong
// to the Windows snipping tool: registration is often refused outright, and
// where it succeeds it shadows a shortcut the user already relies on. Users can
// still choose them explicitly in Hotkeys — the status shown there always
// reflects what Windows actually granted.
const CAPTURE_ACTIONS = [
  "screenshotArea",
  "screenshotFullScreen",
  "recordArea",
  "recordFullScreen",
  "copyAll",
  "clearAll",
  "emptyTrash"
];

const DEFAULT_SHORTCUTS = {
  screenshotArea: "Ctrl+Alt+4",
  screenshotFullScreen: "Ctrl+Alt+5",
  recordArea: "Ctrl+Alt+6",
  recordFullScreen: "Ctrl+Alt+7",
  copyAll: "Ctrl+Alt+3",
  clearAll: "Ctrl+Alt+8",
  emptyTrash: "Ctrl+Alt+9"
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

// Reverse image search. dHash runs on a 9x8 grid (64 bits, see phash.js); the
// threshold is the largest Hamming distance still counted as a match — exact
// copies sit near 0, resized/re-compressed versions around 2-8.
//
// Folders are walked fully (up to SEARCH_MAX_COLLECT entries) but only the
// NEWEST SEARCH_MAX_FILES images are decoded per search: full-resolution
// decoding is expensive (a 4K PNG is ~100 MB of decoded pixels), and a folder
// such as a video project with tens of thousands of frames would otherwise
// pin the CPU and gigabytes of memory for hours.
const SEARCH_IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "bmp"];
const SEARCH_MATCH_THRESHOLD = 10;
const SEARCH_MAX_FILE_BYTES = 50 * 1024 * 1024;
const SEARCH_MAX_COLLECT = 200000;
const SEARCH_MAX_FILES = 5000;
const SEARCH_MAX_RESULTS = 100;
const SEARCH_PREVIEW_WIDTH = 260;
const DEFAULT_SEARCH_FOLDERS = [];

const SETTINGS_VERSION = 2;
const MIN_REGION_SIZE = 8;
const MEDIA_PROTOCOL = "shottap";

module.exports = {
  CAPTURE_ACTIONS,
  DEFAULT_PREFERENCES,
  DEFAULT_SEARCH_FOLDERS,
  DEFAULT_SHORTCUTS,
  MEDIA_PROTOCOL,
  MIN_REGION_SIZE,
  RECORDING_FRAME_RATES,
  RECORDING_QUALITIES,
  SEARCH_IMAGE_EXTENSIONS,
  SEARCH_MATCH_THRESHOLD,
  SEARCH_MAX_COLLECT,
  SEARCH_MAX_FILE_BYTES,
  SEARCH_MAX_FILES,
  SEARCH_MAX_RESULTS,
  SEARCH_PREVIEW_WIDTH,
  SETTINGS_VERSION,
  THEMES
};
