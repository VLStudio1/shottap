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
// Folders are walked fully (up to SEARCH_MAX_COLLECT entries) newest-first.
// Decoding is the expensive part (a 4K PNG is ~100 MB of decoded pixels), so
// each search decodes at most SEARCH_MAX_FILES uncached images — already-
// cached hashes are compared for free, so repeat searches stay comprehensive
// while the first pass stays bounded.
const SEARCH_IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "bmp"];
const SEARCH_MATCH_THRESHOLD = 10;
const SEARCH_MAX_FILE_BYTES = 50 * 1024 * 1024;
const SEARCH_MAX_COLLECT = 200000;
const SEARCH_MAX_FILES = 5000;
// The persistent hash cache must be allowed to outgrow a single search's
// decode budget — progressive indexing is pointless if every persist throws
// away all but the last 5,000 hashes.
const SEARCH_CACHE_MAX = 200000;
const SEARCH_MAX_RESULTS = 100;
const SEARCH_PREVIEW_WIDTH = 260;
const DEFAULT_SEARCH_FOLDERS = [];

// "Whole computer" walks every fixed drive; these directory names (any depth,
// compared case-insensitively) are skipped there — system trees hold wallpaper
// and installer imagery the user never means to match, and several refuse
// reads outright.
const SEARCH_EXCLUDED_DIR_NAMES = [
  "$recycle.bin",
  "$windows.~bt",
  "$windows.~ws",
  "appdata",
  "intel",
  "perflogs",
  "program files",
  "program files (x86)",
  "programdata",
  "recovery",
  "system volume information",
  "windows",
  "windows.old"
];
const DEFAULT_WHOLE_COMPUTER = false;

const SETTINGS_VERSION = 2;
const MIN_REGION_SIZE = 8;
const MEDIA_PROTOCOL = "shottap";

module.exports = {
  CAPTURE_ACTIONS,
  DEFAULT_PREFERENCES,
  DEFAULT_SEARCH_FOLDERS,
  DEFAULT_SHORTCUTS,
  DEFAULT_WHOLE_COMPUTER,
  MEDIA_PROTOCOL,
  MIN_REGION_SIZE,
  RECORDING_FRAME_RATES,
  RECORDING_QUALITIES,
  SEARCH_CACHE_MAX,
  SEARCH_EXCLUDED_DIR_NAMES,
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
