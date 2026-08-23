// Persisted application settings.
//
// Deliberately free of any `electron` import so the migration/validation logic
// can be unit tested with plain node. Paths are injected by `init()`.

const { EventEmitter } = require("events");
const fs = require("fs/promises");
const path = require("path");

const {
  CAPTURE_ACTIONS,
  DEFAULT_PREFERENCES,
  DEFAULT_SHORTCUTS,
  RECORDING_FRAME_RATES,
  RECORDING_QUALITIES,
  SETTINGS_VERSION,
  THEMES
} = require("../shared/constants");

const MODIFIERS = new Set(["ctrl", "control", "alt", "option", "altgr", "shift", "super", "meta", "cmd", "command", "commandorcontrol", "cmdorctrl"]);
const NAMED_KEYS = new Set([
  "space", "tab", "enter", "return", "backspace", "delete", "insert", "esc", "escape",
  "home", "end", "pageup", "pagedown", "up", "down", "left", "right",
  "plus", "printscreen", "capslock", "numlock", "scrolllock", "pause",
  "medianexttrack", "mediaprevioustrack", "mediastop", "mediaplaypause",
  "volumeup", "volumedown", "volumemute"
]);

const emitter = new EventEmitter();

let settingsFile = "";
let defaultSaveDirectory = "";
let state = null;
let writeQueue = Promise.resolve();

function isValidAccelerator(accelerator) {
  if (typeof accelerator !== "string" || accelerator.trim() === "") {
    return false;
  }

  const parts = accelerator.split("+").map((part) => part.trim()).filter(Boolean);

  if (parts.length < 2) {
    return false;
  }

  const key = parts[parts.length - 1].toLowerCase();
  const modifiers = parts.slice(0, -1).map((part) => part.toLowerCase());

  if (modifiers.length === 0 || !modifiers.every((modifier) => MODIFIERS.has(modifier))) {
    return false;
  }

  if (new Set(modifiers).size !== modifiers.length) {
    return false;
  }

  return (
    /^[a-z0-9]$/.test(key) ||
    /^f([1-9]|1[0-9]|2[0-4])$/.test(key) ||
    NAMED_KEYS.has(key) ||
    ["`", "-", "=", "[", "]", "\\", ";", "'", ",", ".", "/"].includes(key)
  );
}

function normalizeShortcuts(raw, previous = DEFAULT_SHORTCUTS) {
  const shortcuts = {};

  for (const action of CAPTURE_ACTIONS) {
    const candidate = raw?.[action];
    shortcuts[action] = isValidAccelerator(candidate) ? candidate : previous[action] || DEFAULT_SHORTCUTS[action];
  }

  return shortcuts;
}

function normalizePreferences(raw) {
  const preferences = { ...DEFAULT_PREFERENCES };

  for (const key of ["autoCopyAfterCapture", "bringToFrontAfterCapture", "recordSystemAudio", "recordMicrophone"]) {
    if (typeof raw?.[key] === "boolean") {
      preferences[key] = raw[key];
    }
  }

  if (RECORDING_QUALITIES.includes(raw?.recordingQuality)) {
    preferences.recordingQuality = raw.recordingQuality;
  }

  if (RECORDING_FRAME_RATES.includes(Number(raw?.recordingFrameRate))) {
    preferences.recordingFrameRate = Number(raw.recordingFrameRate);
  }

  return preferences;
}

function normalizeTheme(raw) {
  return THEMES.includes(raw) ? raw : "system";
}

// v1 files used { shortcuts: { region, fullScreen, copyAll } } and had no
// recording shortcuts, theme or save directory.
function migrate(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  if (raw.version === SETTINGS_VERSION) {
    return raw;
  }

  const legacy = raw.shortcuts || {};

  return {
    version: SETTINGS_VERSION,
    shortcuts: {
      screenshotArea: legacy.screenshotArea || legacy.region,
      screenshotFullScreen: legacy.screenshotFullScreen || legacy.fullScreen,
      recordArea: legacy.recordArea,
      recordFullScreen: legacy.recordFullScreen,
      copyAll: legacy.copyAll
    },
    preferences: raw.preferences,
    appearance: raw.appearance,
    saveDirectory: raw.saveDirectory
  };
}

function normalize(raw) {
  const migrated = migrate(raw) || {};

  return {
    version: SETTINGS_VERSION,
    shortcuts: normalizeShortcuts(migrated.shortcuts),
    preferences: normalizePreferences(migrated.preferences),
    appearance: { theme: normalizeTheme(migrated.appearance?.theme) },
    saveDirectory:
      typeof migrated.saveDirectory === "string" && migrated.saveDirectory.trim()
        ? migrated.saveDirectory
        : defaultSaveDirectory
  };
}

async function init({ userDataDir, saveDirectory }) {
  settingsFile = path.join(userDataDir, "settings.json");
  defaultSaveDirectory = saveDirectory;

  let raw = null;

  try {
    raw = JSON.parse(await fs.readFile(settingsFile, "utf8"));
  } catch (_error) {
    raw = null;
  }

  state = normalize(raw);

  return state;
}

function get() {
  return state;
}

function persist() {
  const snapshot = JSON.stringify(state, null, 2);

  writeQueue = writeQueue
    .then(async () => {
      await fs.mkdir(path.dirname(settingsFile), { recursive: true });
      await fs.writeFile(`${settingsFile}.tmp`, snapshot, "utf8");
      await fs.rename(`${settingsFile}.tmp`, settingsFile);
    })
    .catch(() => {
      // A failed settings write must never take the app down; the in-memory
      // state stays authoritative for this session.
    });

  return writeQueue;
}

async function update(patch) {
  const next = { ...state };

  if (patch.shortcuts) {
    next.shortcuts = normalizeShortcuts({ ...state.shortcuts, ...patch.shortcuts }, state.shortcuts);
  }

  if (patch.preferences) {
    next.preferences = normalizePreferences({ ...state.preferences, ...patch.preferences });
  }

  if (patch.appearance) {
    next.appearance = { theme: normalizeTheme(patch.appearance.theme) };
  }

  if (typeof patch.saveDirectory === "string" && patch.saveDirectory.trim()) {
    next.saveDirectory = patch.saveDirectory;
  }

  state = next;
  await persist();
  emitter.emit("change", state);

  return state;
}

module.exports = {
  emitter,
  get,
  init,
  isValidAccelerator,
  migrate,
  normalize,
  normalizePreferences,
  normalizeShortcuts,
  update
};
