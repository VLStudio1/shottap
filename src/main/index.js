const { app, BrowserWindow, dialog, ipcMain, nativeImage, nativeTheme, net, protocol, session, shell } = require("electron");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { Readable } = require("stream");
const { fileURLToPath, pathToFileURL } = require("url");

const { CAPTURE_ACTIONS, MEDIA_PROTOCOL } = require("../shared/constants");
const capture = require("./capture");
const clipboardService = require("./clipboard");
const library = require("./library");
const { UNSATISFIABLE, parseRange } = require("./range");
const recording = require("./recording");
const settings = require("./settings");
const shortcuts = require("./shortcuts");
const windows = require("./windows");

// Intentional backward compatibility from the pre-ShotTap names. ScreenCap was
// the original app name; Shottap existed in local builds during the rename.
const LEGACY_APP_NAMES = ["Shottap", "ScreenCap"];

// Test seam: the self-test runs the real app against throwaway directories so
// it never touches the user's settings or Pictures folder.
if (process.env.SHOTTAP_USERDATA_DIR) {
  app.setPath("userData", process.env.SHOTTAP_USERDATA_DIR);
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
}

// Captures made during this session. Both Copy All and Auto Copy work from this
// queue: one screenshot goes on the clipboard as a bitmap, several go on
// together as a multi-file drop.
let sessionItemIds = [];
let lastCopy = null;
let captureInFlight = null;

protocol.registerSchemesAsPrivileged([
  {
    scheme: MEDIA_PROTOCOL,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: false }
  }
]);

function toast(message, tone = "info") {
  if (!message) {
    return;
  }

  windows.sendToRenderer("app:toast", { message, tone, at: Date.now() });
}

function sendLibrary() {
  windows.sendToRenderer("app:library", { items: library.list(), sessionItemIds, lastCopy });
}

function sendSettings() {
  windows.sendToRenderer("app:settings", settingsPayload());
}

function sendRecording() {
  windows.sendToRenderer("app:recording", recording.snapshot());
}

function settingsPayload() {
  const state = settings.get();

  return {
    shortcuts: state.shortcuts,
    shortcutStatus: shortcuts.getStatuses(),
    preferences: state.preferences,
    appearance: state.appearance,
    saveDirectory: state.saveDirectory,
    directories: library.directories()
  };
}

function appInfo() {
  return {
    name: "ShotTap",
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: `${process.platform} ${process.arch}`
  };
}

async function pathExists(filePath) {
  try {
    await fsp.access(filePath);
    return true;
  } catch (_error) {
    return false;
  }
}

async function migrateLegacySettings() {
  if (process.env.SHOTTAP_USERDATA_DIR) {
    return;
  }

  const currentSettings = path.join(app.getPath("userData"), "settings.json");

  if (await pathExists(currentSettings)) {
    return;
  }

  for (const legacyName of LEGACY_APP_NAMES) {
    const legacySettings = path.join(app.getPath("appData"), legacyName, "settings.json");

    if (await pathExists(legacySettings)) {
      await fsp.mkdir(path.dirname(currentSettings), { recursive: true });
      await fsp.copyFile(legacySettings, currentSettings);
      return;
    }
  }
}

async function directoryHasLibrary(directory) {
  if (await pathExists(path.join(directory, "library.json"))) {
    return true;
  }

  for (const folder of ["Screenshots", "Recordings"]) {
    try {
      const names = await fsp.readdir(path.join(directory, folder));

      if (names.length > 0) {
        return true;
      }
    } catch (_error) {
      // Missing folders just mean this is not an existing library.
    }
  }

  return false;
}

async function defaultMediaDirectory() {
  if (process.env.SHOTTAP_MEDIA_DIR) {
    return process.env.SHOTTAP_MEDIA_DIR;
  }

  const pictures = app.getPath("pictures");
  const current = path.join(pictures, "ShotTap");

  if (!(await pathExists(current))) {
    for (const legacyName of LEGACY_APP_NAMES) {
      const legacy = path.join(pictures, legacyName);

      if (await directoryHasLibrary(legacy)) {
        return legacy;
      }
    }
  }

  return current;
}

// ---------------------------------------------------------------------------
// App + media protocol.
//
// The window is served from shottap://app rather than file:// so that library
// media (shottap://app/media/...) is same-origin: the renderer never receives
// base64 image payloads, thumbnails stream from disk, and the editor canvas
// stays exportable. Only two directories are reachable — the bundled renderer
// and the library root.
// ---------------------------------------------------------------------------
const RENDERER_ROOT = path.join(__dirname, "..", "renderer");

function resolveRendererAsset(relativePath) {
  const resolved = path.resolve(RENDERER_ROOT, relativePath);

  return resolved.startsWith(path.resolve(RENDERER_ROOT) + path.sep) ? resolved : null;
}

function registerMediaProtocol() {
  protocol.handle(MEDIA_PROTOCOL, async (request) => {
    const url = new URL(request.url);
    const pathname = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    const isMedia = pathname.startsWith("media/");
    const filePath = isMedia
      ? library.resolveInsideRoot(pathname.slice("media/".length))
      : resolveRendererAsset(pathname || "index.html");

    if (!filePath) {
      return new Response("Not found", { status: 404 });
    }

    let stats;

    try {
      stats = await fsp.stat(filePath);
    } catch (_error) {
      return new Response("Not found", { status: 404 });
    }

    const range = request.headers.get("Range");

    // Range support keeps video scrubbing working in the inspector preview.
    if (range) {
      const parsed = parseRange(range, stats.size);

      if (parsed === UNSATISFIABLE) {
        return new Response("Range not satisfiable", {
          status: 416,
          headers: {
            "Content-Range": `bytes */${stats.size}`,
            "Accept-Ranges": "bytes",
            "Access-Control-Allow-Origin": "*"
          }
        });
      }

      if (parsed) {
        const { start, end } = parsed;
        const stream = fs.createReadStream(filePath, { start, end });

        return new Response(Readable.toWeb(stream), {
          status: 206,
          headers: {
            "Content-Type": contentTypeFor(filePath),
            "Content-Length": String(end - start + 1),
            "Content-Range": `bytes ${start}-${end}/${stats.size}`,
            "Accept-Ranges": "bytes",
            "Cache-Control": "no-cache",
            // Without this the editor canvas is tainted and cannot export the
            // edited PNG.
            "Access-Control-Allow-Origin": "*"
          }
        });
      }
    }

    const response = await net.fetch(pathToFileURL(filePath).toString());
    const headers = new Headers(response.headers);
    headers.set("Content-Type", contentTypeFor(filePath));
    headers.set("Accept-Ranges", "bytes");
    headers.set("Cache-Control", "no-cache");
    headers.set("Access-Control-Allow-Origin", "*");

    return new Response(response.body, { status: 200, headers });
  });
}

function contentTypeFor(filePath) {
  const extension = path.extname(filePath).toLowerCase();

  return (
    {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".webm": "video/webm",
      ".mp4": "video/mp4",
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8"
    }[extension] || "application/octet-stream"
  );
}

// ---------------------------------------------------------------------------
// Capture actions
// ---------------------------------------------------------------------------
function rememberSessionItem(item) {
  if (item && !sessionItemIds.includes(item.id)) {
    sessionItemIds.push(item.id);
  }
}

function publicActionResult(result) {
  if (!result || typeof result !== "object") {
    return result;
  }

  const { image: _image, ...safeResult } = result;

  return safeResult;
}

// Session captures on the clipboard.
//
// Auto copy writes the newest bitmap natively the moment the shot exists — that
// is the path the user feels, and it costs a fraction of a millisecond. Once
// the session holds more than one screenshot the clipboard is then upgraded, in
// the background, to a real multi-file drop carrying every one of them, so a
// second capture never quietly drops the first.
let copyGeneration = 0;
let copyDepth = 0;
let copyTail = null;

function sessionItems({ imagesOnly = false } = {}) {
  return sessionItemIds
    .map((id) => library.find(id))
    .filter((item) => item && !item.trashedAt && (!imagesOnly || item.type === "image"));
}

function clipboardPathsFor(items) {
  const filePaths = [];
  const imagePaths = [];

  for (const item of items) {
    const filePath = library.pathFor(item.id);

    if (!filePath) {
      continue;
    }

    filePaths.push(filePath);

    if (item.type === "image") {
      imagePaths.push(filePath);
    }
  }

  return { filePaths, imagePaths };
}

// Anything already queued describes a clipboard state that is no longer wanted
// — the queue was cleared, or an item in it was thrown away.
function invalidatePendingCopies() {
  copyGeneration += 1;
}

// Copies are serialised and coalesced: back-to-back captures would otherwise
// race for the clipboard and could leave the older set on it.
//
// When nothing else is copying the work starts in this very turn rather than
// behind a promise continuation. In the main process a microtask only runs when
// the message pump comes round, and with ShotTap in the background that was
// measured at ~3 s of doing nothing before the clipboard call was even made —
// the whole of the delay Copy All used to show. Once the request is written to
// the helper the reply is real I/O, which wakes the loop on its own.
function scheduleClipboardCopy(items, kind) {
  const generation = ++copyGeneration;
  const { filePaths, imagePaths } = clipboardPathsFor(items);

  const attempt = async () => {
    try {
      if (generation !== copyGeneration) {
        return { ok: false, superseded: true, message: "Superseded by a newer copy." };
      }

      const result = await clipboardService.copyFiles(filePaths, imagePaths);

      if (generation !== copyGeneration) {
        return { ...result, superseded: true };
      }

      if (result.ok) {
        lastCopy = { at: Date.now(), count: filePaths.length, kind };
        sendLibrary();
      }

      return result;
    } finally {
      copyDepth -= 1;

      if (copyDepth === 0) {
        copyTail = null;
      }
    }
  };

  copyDepth += 1;

  const run = copyTail ? copyTail.then(attempt, attempt) : attempt();
  const settled = run.then(
    () => {},
    () => {}
  );

  // Only leave a tail behind while a copy is genuinely outstanding, so the next
  // one is not made to wait on an already-finished promise.
  copyTail = copyDepth > 0 ? settled : null;

  return run;
}

async function runScreenshot(task) {
  if (captureInFlight) {
    return captureInFlight;
  }

  const preferences = settings.get().preferences;
  const autoCopy = preferences.autoCopyAfterCapture;
  let copiedInstantly = false;

  captureInFlight = (async () => {
    const result = await task({
      // Runs before the PNG encode, the thumbnail and the index write, so the
      // shot is pasteable roughly as soon as it is taken.
      onImage: (image) => {
        if (!autoCopy) {
          return;
        }

        copiedInstantly = clipboardService.copyImage(image);
      }
    });

    if (!result.ok) {
      if (!result.cancelled) {
        toast(result.message || "Capture failed.", "error");
      } else if (result.message) {
        toast(result.message, "info");
      }

      return result;
    }

    rememberSessionItem(result.item);

    let message = result.message || "Screenshot saved.";

    if (autoCopy) {
      const screenshots = sessionItems({ imagesOnly: true });

      if (screenshots.length > 0) {
        lastCopy = { at: Date.now(), count: screenshots.length, kind: "auto" };
        message =
          result.message ||
          (screenshots.length === 1
            ? "Screenshot copied to the clipboard."
            : `Copied ${screenshots.length} screenshots to the clipboard.`);

        // Every screenshot of the session goes on, every time — a single one
        // included, so it can be pasted as a file and not only as a bitmap.
        // The bitmap is already on the clipboard from `onImage`; this only adds
        // the flavours Electron cannot write, and costs a few ms off to one
        // side of the capture.
        scheduleClipboardCopy(screenshots, "auto").then(
          (copyResult) => {
            if (!copyResult.ok && !copyResult.superseded) {
              toast(copyResult.message, "error");
            }
          },
          () => {}
        );
      } else if (copiedInstantly) {
        lastCopy = { at: Date.now(), count: 1, kind: "auto" };
        message = result.message || "Screenshot copied to the clipboard.";
      }
    }

    sendLibrary();
    toast(message, "success");
    windows.revealMain({ focus: preferences.bringToFrontAfterCapture });

    return result;
  })().finally(() => {
    captureInFlight = null;
  });

  return captureInFlight;
}

async function toggleRecording(mode) {
  if (recording.isRecording()) {
    return recording.requestStop();
  }

  const result = await recording.start({ mode, preferences: settings.get().preferences });

  if (!result.ok && result.message) {
    toast(result.message, result.cancelled ? "info" : "error");
  }

  return result;
}

async function copyAllCaptures() {
  const items = sessionItems();

  if (items.length === 0) {
    toast("Nothing captured this session yet.", "info");
    return { ok: false, message: "Nothing captured this session yet." };
  }

  const result = await scheduleClipboardCopy(items, "copyAll");

  // A capture taken while this copy was queued already owns the clipboard, and
  // it holds the newer set — saying so would only be noise.
  if (result.superseded) {
    return { ok: true, message: result.message };
  }

  toast(result.message, result.ok ? "success" : "error");

  return result;
}

function clearCaptureQueue() {
  const count = sessionItemIds.length;
  sessionItemIds = [];
  lastCopy = null;
  invalidatePendingCopies();
  sendLibrary();
  toast(count > 0 ? "Capture queue cleared." : "Capture queue is already empty.", "info");

  return { ok: true, count };
}

function clearClipboard() {
  invalidatePendingCopies();
  clipboardService.clear();
  lastCopy = null;
  sendLibrary();
  toast("Clipboard cleared.", "success");

  return { ok: true };
}

async function trashItems(ids, emptyMessage, movedMessage) {
  const requested = Array.isArray(ids) ? ids.map(requireString).filter(Boolean) : [];
  const uniqueIds = [...new Set(requested)];
  const queued = new Set(sessionItemIds);
  let count = 0;

  for (const id of uniqueIds) {
    const item = library.find(id);

    if (!item || item.trashedAt) {
      continue;
    }

    await library.moveToTrash(item.id);
    count += 1;
  }

  if (count > 0) {
    sessionItemIds = sessionItemIds.filter((id) => !uniqueIds.includes(id));

    if (uniqueIds.some((id) => queued.has(id))) {
      lastCopy = null;
      // A queued copy would be pointing at files that have just moved to Trash.
      invalidatePendingCopies();
    }
  }

  sendLibrary();
  toast(count > 0 ? movedMessage(count) : emptyMessage, "info");

  return { ok: true, count };
}

const actions = {
  screenshotArea: () => runScreenshot((hooks) => capture.captureArea(hooks)),
  screenshotFullScreen: () => runScreenshot((hooks) => capture.captureFullScreen(hooks)),
  recordArea: () => toggleRecording("area"),
  recordFullScreen: () => toggleRecording("fullscreen"),
  copyAll: () => copyAllCaptures(),
  clearAll: () => clearCaptureQueue(),
  emptyTrash: async () => {
    const count = await library.emptyTrash();
    sendLibrary();
    toast(count > 0 ? `Emptied Trash (${count} item${count === 1 ? "" : "s"}).` : "Trash is already empty.", "info");

    return { ok: true, count };
  }
};

// ShotTap's own leftovers from earlier versions and from interrupted copies.
// The old screencap/shottap prefixes are intentional pre-ShotTap compatibility;
// only files this app created are touched, never anything the user saved.
async function cleanupTemporaryFiles() {
  const temp = app.getPath("temp");

  try {
    // Pre-0.5 builds wrote a new folder of PNG copies on every Copy All.
    await Promise.all(
      ["shottap-clipboard", "screencap-clipboard"].map((name) =>
        fsp.rm(path.join(temp, name), { recursive: true, force: true })
      )
    );
  } catch (_error) {
    // Nothing to clean.
  }

  try {
    const entries = await fsp.readdir(temp);
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;

    for (const entry of entries) {
      // .html is the pre-0.6 fallback payload, .json the current one.
      if (!/^(shottap|screencap)-clipboard-[\d-]+\.(html|json)$/.test(entry)) {
        continue;
      }

      const target = path.join(temp, entry);
      const stats = await fsp.stat(target).catch(() => null);

      if (stats && stats.mtimeMs < cutoff) {
        await fsp.rm(target, { force: true }).catch(() => {});
      }
    }
  } catch (_error) {
    // A temp directory we cannot read is not a reason to fail startup.
  }
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
function requireString(value) {
  return typeof value === "string" && value.length > 0 && value.length < 512 ? value : null;
}

function itemFromId(value) {
  const id = requireString(value);

  return id ? library.find(id) : null;
}

function registerIpc() {
  ipcMain.handle("app:get-state", () => ({
    settings: settingsPayload(),
    library: { items: library.list(), sessionItemIds, lastCopy },
    recording: recording.snapshot(),
    info: appInfo()
  }));

  ipcMain.handle("action:run", (_event, action) => {
    if (!CAPTURE_ACTIONS.includes(action)) {
      return { ok: false, message: "Unknown action." };
    }

    return Promise.resolve(actions[action]()).then(publicActionResult);
  });

  ipcMain.handle("recording:stop", () => recording.requestStop());

  ipcMain.handle("session:clear-capture-queue", () => clearCaptureQueue());

  ipcMain.handle("clipboard:clear", () => clearClipboard());

  ipcMain.handle("library:trash-many", (_event, ids) =>
    trashItems(
      ids,
      "Nothing to move to Trash.",
      (count) => `Moved ${count} item${count === 1 ? "" : "s"} to Trash.`
    )
  );

  ipcMain.handle("library:favorite", (_event, id, favorite) => {
    const item = itemFromId(id);

    if (!item) {
      return { ok: false };
    }

    library.setFavorite(item.id, Boolean(favorite));
    sendLibrary();

    return { ok: true };
  });

  ipcMain.handle("library:trash", async (_event, id) => {
    const item = itemFromId(id);

    if (!item) {
      return { ok: false };
    }

    await library.moveToTrash(item.id);
    sendLibrary();
    toast(`${item.type === "video" ? "Recording" : "Screenshot"} moved to Trash.`, "info");

    return { ok: true };
  });

  ipcMain.handle("library:restore", async (_event, id) => {
    const item = itemFromId(id);

    if (!item) {
      return { ok: false };
    }

    await library.restore(item.id);
    sendLibrary();
    toast("Restored from Trash.", "success");

    return { ok: true };
  });

  ipcMain.handle("library:delete", async (_event, id) => {
    const item = itemFromId(id);

    if (!item) {
      return { ok: false };
    }

    sessionItemIds = sessionItemIds.filter((entry) => entry !== item.id);
    await library.deletePermanently(item.id);
    sendLibrary();
    toast("Deleted permanently.", "info");

    return { ok: true };
  });

  ipcMain.handle("library:empty-trash", async () => {
    return actions.emptyTrash();
  });

  ipcMain.handle("library:copy", async (_event, id) => {
    const item = itemFromId(id);

    if (!item) {
      return { ok: false };
    }

    const filePath = library.pathFor(item.id);

    if (item.type === "image" && clipboardService.copyImageFile(filePath)) {
      lastCopy = { at: Date.now(), count: 1, kind: "manual" };
      sendLibrary();
      toast("Screenshot copied to the clipboard.", "success");

      return { ok: true };
    }

    const result = await clipboardService.copyFiles([filePath], item.type === "image" ? [filePath] : []);

    if (result.ok) {
      lastCopy = { at: Date.now(), count: 1, kind: "manual" };
      sendLibrary();
    }

    toast(result.message, result.ok ? "success" : "error");

    return result;
  });

  ipcMain.handle("library:open", async (_event, id) => {
    const item = itemFromId(id);

    if (!item) {
      return { ok: false };
    }

    const error = await shell.openPath(library.pathFor(item.id));

    if (error) {
      toast(error, "error");
    }

    return { ok: !error };
  });

  ipcMain.handle("library:reveal", (_event, id) => {
    const item = itemFromId(id);

    if (!item) {
      return { ok: false };
    }

    shell.showItemInFolder(library.pathFor(item.id));

    return { ok: true };
  });

  ipcMain.handle("library:save-edit", async (_event, id, buffer) => {
    const item = itemFromId(id);

    if (!item || item.type !== "image" || !(buffer instanceof ArrayBuffer || ArrayBuffer.isView(buffer))) {
      return { ok: false, message: "Nothing to save." };
    }

    // A typed-array view may cover only part of its backing ArrayBuffer, so the
    // offset and length have to be carried across rather than copying the whole
    // buffer.
    const png = Buffer.from(
      buffer instanceof ArrayBuffer
        ? new Uint8Array(buffer)
        : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
    );
    const image = nativeImage.createFromBuffer(png);

    if (image.isEmpty()) {
      return { ok: false, message: "Edited image could not be read." };
    }

    const size = image.getSize();
    await library.replaceImageContents(item.id, {
      buffer: png,
      thumbnail: capture.makeThumbnail(image),
      width: size.width,
      height: size.height
    });

    sendLibrary();
    toast("Edits saved.", "success");

    return { ok: true };
  });

  ipcMain.handle("settings:update", async (_event, patch) => {
    if (!patch || typeof patch !== "object") {
      return settingsPayload();
    }

    const before = settings.get();
    const next = await settings.update({
      preferences: patch.preferences,
      appearance: patch.appearance
    });

    if (patch.appearance?.theme && patch.appearance.theme !== before.appearance.theme) {
      nativeTheme.themeSource = next.appearance.theme;
      windows.setMainBackground(next.appearance.theme);
    }

    sendSettings();

    return settingsPayload();
  });

  ipcMain.handle("settings:set-shortcut", async (_event, action, accelerator) => {
    if (!CAPTURE_ACTIONS.includes(action) || !settings.isValidAccelerator(accelerator)) {
      return { ok: false, message: "That is not a usable shortcut.", settings: settingsPayload() };
    }

    const duplicateOwner = CAPTURE_ACTIONS.find(
      (other) => other !== action && settings.get().shortcuts[other] === accelerator
    );

    if (duplicateOwner) {
      return {
        ok: false,
        message: `${accelerator} is already used by another ShotTap action.`,
        settings: settingsPayload()
      };
    }

    const previous = settings.get().shortcuts[action];
    await settings.update({ shortcuts: { [action]: accelerator } });
    shortcuts.resume();
    const status = shortcuts.getStatuses()[action];

    if (status?.status !== shortcuts.STATUS.ACTIVE) {
      // Registration is the only proof; roll back rather than showing a
      // shortcut that will never fire.
      await settings.update({ shortcuts: { [action]: previous } });
      shortcuts.apply(settings.get().shortcuts);
      sendSettings();

      return {
        ok: false,
        message: `${accelerator} could not be registered — Windows or another app owns it.`,
        settings: settingsPayload()
      };
    }

    sendSettings();
    toast("Shortcut updated.", "success");

    return { ok: true, message: "Shortcut updated.", settings: settingsPayload() };
  });

  // While the user is pressing keys for a new binding, every global shortcut is
  // unregistered so the old combination cannot fire a capture.
  ipcMain.handle("settings:begin-shortcut-capture", () => {
    shortcuts.suspend();
    sendSettings();

    return { ok: true };
  });

  ipcMain.handle("settings:end-shortcut-capture", () => {
    shortcuts.resume();
    sendSettings();

    return { ok: true };
  });

  ipcMain.handle("settings:choose-directory", async () => {
    const window = windows.getMainWindow();
    const result = await dialog.showOpenDialog(window, {
      title: "Choose where ShotTap saves captures",
      defaultPath: settings.get().saveDirectory,
      properties: ["openDirectory", "createDirectory"]
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false, settings: settingsPayload() };
    }

    const directory = path.join(result.filePaths[0], path.basename(result.filePaths[0]) === "ShotTap" ? "" : "ShotTap");

    // Pending index writes belong to the directory we are leaving, so they have
    // to land before the root moves.
    await library.flush();

    // The move is only committed to settings once the new directory has proved
    // itself writable — otherwise an unusable folder (read-only volume, a
    // disconnected drive) would be remembered across restarts.
    try {
      await library.init(directory);
    } catch (error) {
      toast(`Could not use that folder: ${error.message}`, "error");

      return { ok: false, settings: settingsPayload() };
    }

    await settings.update({ saveDirectory: directory });
    sendSettings();
    sendLibrary();
    toast("Save location updated.", "success");

    return { ok: true, settings: settingsPayload() };
  });

  ipcMain.handle("settings:open-directory", async () => {
    await shell.openPath(library.getRoot());

    return { ok: true };
  });

  // ---- recorder window channels -------------------------------------------
  ipcMain.handle("recorder:started", (event, info) => {
    if (!windows.isRecorderWindow(event.sender)) {
      return { ok: false };
    }

    recording.acceptStarted(info || {});
    sendRecording();
    toast(info?.warning ? `Recording started — ${info.warning}` : "Recording started.", info?.warning ? "info" : "success");

    return { ok: true };
  });

  ipcMain.handle("recorder:chunk", (event, payload) => {
    if (!windows.isRecorderWindow(event.sender) || !payload || typeof payload.seq !== "number") {
      return { ok: false };
    }

    return recording.acceptChunk(payload);
  });

  ipcMain.handle("recorder:poster", (event, dataUrl) => {
    if (!windows.isRecorderWindow(event.sender)) {
      return { ok: false };
    }

    return recording.acceptPoster(dataUrl);
  });

  ipcMain.handle("recorder:finished", async (event, info) => {
    if (!windows.isRecorderWindow(event.sender)) {
      return { ok: false };
    }

    const result = await recording.finalize(info || {});
    sendRecording();

    if (result.ok) {
      rememberSessionItem(result.item);
      sendLibrary();
      toast(result.message, "success");
      windows.revealMain({ focus: false });
    } else {
      toast(result.message, "error");
    }

    // A recording started before the window was closed keeps the app alive;
    // once it is saved there is nothing left to stay open for.
    if (!windows.getMainWindow()) {
      windows.closeRecorderWindow();
    }

    return { ok: result.ok };
  });

  ipcMain.handle("recorder:failed", async (event, message) => {
    if (!windows.isRecorderWindow(event.sender)) {
      return { ok: false };
    }

    const result = await recording.abort(typeof message === "string" ? message : "Recording failed.");
    sendRecording();
    toast(result.message, "error");

    return { ok: false };
  });

  // ---- selection overlay channels -----------------------------------------
  ipcMain.handle("selection:config", (event) => windows.selectionConfigFor(event.sender.id));

  ipcMain.handle("selection:finish", (event, rect) => {
    if (!windows.isSelectionWindow(event.sender) || !rect) {
      return { ok: false };
    }

    const config = windows.selectionConfigFor(event.sender.id);
    windows.finishSelection(windows.normalizeSelectionResult(rect, config));

    return { ok: true };
  });

  ipcMain.handle("selection:cancel", (event) => {
    if (!windows.isSelectionWindow(event.sender)) {
      return { ok: false };
    }

    windows.finishSelection(null);

    return { ok: true };
  });
}

// ---------------------------------------------------------------------------
// Security hardening
// ---------------------------------------------------------------------------
function hardenSession(targetSession) {
  targetSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(permission === "media" && windows.isRecorderWindow(webContents));
  });

  targetSession.setPermissionCheckHandler((webContents, permission) =>
    permission === "media" && windows.isRecorderWindow(webContents)
  );
}

// The renderer lives at shottap://app and the overlay/recorder pages are
// loaded from disk — but only the ones ShotTap ships. Allowing file:// as a
// whole would have let a compromised renderer walk the local filesystem.
const APP_ROOT = path.resolve(__dirname, "..");

function isAllowedNavigation(url) {
  if (url.startsWith(`${MEDIA_PROTOCOL}://app/`)) {
    return true;
  }

  if (!url.startsWith("file://")) {
    return false;
  }

  try {
    const resolved = path.resolve(fileURLToPath(url));

    return resolved.startsWith(APP_ROOT + path.sep);
  } catch (_error) {
    return false;
  }
}

function hardenWebContents() {
  app.on("web-contents-created", (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: "deny" }));

    contents.on("will-navigate", (event, url) => {
      if (!isAllowedNavigation(url)) {
        event.preventDefault();
      }
    });

    contents.on("will-attach-webview", (event) => {
      event.preventDefault();
    });
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot() {
  await migrateLegacySettings();

  const defaultSaveDirectory = await defaultMediaDirectory();
  const state = await settings.init({
    userDataDir: app.getPath("userData"),
    saveDirectory: defaultSaveDirectory
  });

  try {
    await library.init(state.saveDirectory);
  } catch (_error) {
    // A missing or unwritable custom directory falls back to the default so the
    // app still starts.
    await settings.update({ saveDirectory: defaultSaveDirectory });
    await library.init(defaultSaveDirectory);
  }

  nativeTheme.themeSource = state.appearance.theme;
  registerMediaProtocol();
  hardenSession(session.defaultSession);
  recording.installDisplayMediaHandler();

  // A hotkey handler that rejects has nowhere to report to — without this the
  // rejection is unhandled and Node ends the process, so a full disk during a
  // hotkey capture would take the whole app down while the same failure from
  // the UI button (which goes through ipcMain.handle) merely showed an error.
  shortcuts.setHandlers(actions, (action, error) => {
    toast(`${action} failed: ${error?.message || error}`, "error");
  });
  shortcuts.apply(state.shortcuts);

  recording.onChange(() => sendRecording());

  const mainWindow = windows.createMainWindow({ theme: state.appearance.theme });
  registerIpc();

  // The hidden recorder window would otherwise keep the process alive after the
  // user closes ShotTap. It is kept only while a recording is running.
  mainWindow.on("closed", () => {
    if (!recording.isRecording()) {
      windows.closeRecorderWindow();
    }
  });

  nativeTheme.on("updated", () => {
    windows.setMainBackground(settings.get().appearance.theme);
  });

  cleanupTemporaryFiles();

  // Starting the clipboard helper now means the first Copy All of the session
  // does not pay for powershell.exe starting and loading two assemblies.
  clipboardService.warmUp();

  if (process.env.SHOTTAP_SELFTEST) {
    require("../../test/selftest").run({
      actions,
      capture,
      library,
      recording,
      settings,
      shortcuts,
      windows,
      clipboardService
    });
  }

  if (process.env.SHOTTAP_DOCS_SCREENSHOTS) {
    require("../../test/docs-screenshots").run({
      capture,
      library,
      recording,
      settings,
      windows
    });
  }
}

if (gotSingleInstanceLock) {
  app.on("second-instance", () => {
    windows.revealMain({ focus: true });
  });

  hardenWebContents();

  app.whenReady()
    .then(boot)
    .catch((error) => {
      // Without this the failure surfaces only as an unhandled rejection and a
      // silently dead app.
      dialog.showErrorBox("ShotTap could not start", String(error?.stack || error));
      app.quit();
    });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      windows.createMainWindow({ theme: settings.get().appearance.theme });
    }
  });

  // Electron does not await async `will-quit` listeners, so the debounced
  // library index has to be held open explicitly: quitting straight after a
  // favourite or a trash action would otherwise drop it. The timeout keeps a
  // stalled write (a disconnected drive) from making the app unquittable.
  let flushingBeforeQuit = false;

  app.on("will-quit", (event) => {
    shortcuts.teardown();
    clipboardService.shutdown();

    if (flushingBeforeQuit) {
      return;
    }

    flushingBeforeQuit = true;
    event.preventDefault();

    Promise.race([
      library.flush().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 2000))
    ]).then(() => app.quit());
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });
}
