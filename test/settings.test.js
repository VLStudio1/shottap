const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const settings = require("../src/main/settings");

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "shottap-settings-"));
}

test("valid accelerators are accepted and bare keys are rejected", () => {
  assert.equal(settings.isValidAccelerator("Ctrl+Alt+4"), true);
  assert.equal(settings.isValidAccelerator("Ctrl+Shift+F5"), true);
  assert.equal(settings.isValidAccelerator("Super+Shift+S"), true);
  assert.equal(settings.isValidAccelerator("Ctrl+Alt+Left"), true);

  assert.equal(settings.isValidAccelerator("S"), false);
  assert.equal(settings.isValidAccelerator("PrintScreen"), false);
  assert.equal(settings.isValidAccelerator("Ctrl+Ctrl+S"), false);
  assert.equal(settings.isValidAccelerator("Ctrl+"), false);
  assert.equal(settings.isValidAccelerator(""), false);
  assert.equal(settings.isValidAccelerator(null), false);
});

test("a v1 settings file keeps its shortcuts and gains the new ones", () => {
  const migrated = settings.migrate({
    shortcuts: { region: "Ctrl+Alt+9", fullScreen: "Ctrl+Alt+8", copyAll: "Ctrl+Alt+7" },
    preferences: { bringToFrontAfterCapture: true, autoCopyAfterCapture: false }
  });

  assert.equal(migrated.shortcuts.screenshotArea, "Ctrl+Alt+9");
  assert.equal(migrated.shortcuts.screenshotFullScreen, "Ctrl+Alt+8");
  assert.equal(migrated.shortcuts.copyAll, "Ctrl+Alt+7");
  assert.equal(migrated.preferences.bringToFrontAfterCapture, true);
});

test("normalising fills in defaults and drops junk", () => {
  const normalized = settings.normalize({
    shortcuts: { region: "not a shortcut", fullScreen: "Ctrl+Alt+8" },
    preferences: { autoCopyAfterCapture: "yes", recordingQuality: "8k", recordingFrameRate: 144 },
    appearance: { theme: "neon" }
  });

  assert.equal(normalized.shortcuts.screenshotArea, "Ctrl+Alt+4");
  assert.equal(normalized.shortcuts.screenshotFullScreen, "Ctrl+Alt+8");
  assert.equal(normalized.preferences.autoCopyAfterCapture, true);
  assert.equal(normalized.preferences.recordingQuality, "native");
  assert.equal(normalized.preferences.recordingFrameRate, 30);
  assert.equal(normalized.appearance.theme, "system");
});

test("settings survive a round trip through disk", async () => {
  const directory = await tempDir();

  try {
    await settings.init({ userDataDir: directory, saveDirectory: path.join(directory, "media") });
    await settings.update({
      preferences: { bringToFrontAfterCapture: true, recordingQuality: "720p" },
      appearance: { theme: "dark" }
    });

    const written = JSON.parse(await fs.readFile(path.join(directory, "settings.json"), "utf8"));
    assert.equal(written.preferences.bringToFrontAfterCapture, true);
    assert.equal(written.preferences.recordingQuality, "720p");
    assert.equal(written.appearance.theme, "dark");

    const reloaded = await settings.init({ userDataDir: directory, saveDirectory: path.join(directory, "media") });
    assert.equal(reloaded.preferences.bringToFrontAfterCapture, true);
    assert.equal(reloaded.appearance.theme, "dark");
    assert.equal(reloaded.preferences.autoCopyAfterCapture, true);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("a v1 file on disk is upgraded in place on next launch", async () => {
  const directory = await tempDir();

  try {
    await fs.writeFile(
      path.join(directory, "settings.json"),
      JSON.stringify({
        shortcuts: { region: "Ctrl+Alt+1", fullScreen: "Ctrl+Alt+2", copyAll: "Ctrl+Alt+3" },
        preferences: { autoCopyAfterCapture: false }
      })
    );

    const state = await settings.init({ userDataDir: directory, saveDirectory: path.join(directory, "media") });

    assert.equal(state.version, 2);
    assert.equal(state.shortcuts.screenshotArea, "Ctrl+Alt+1");
    assert.equal(state.shortcuts.recordArea, "Ctrl+Alt+6");
    assert.equal(state.preferences.autoCopyAfterCapture, false);
    assert.equal(state.saveDirectory, path.join(directory, "media"));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
