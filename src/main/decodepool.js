// A parallel image-decode farm for the reverse image search.
//
// Decoding dominates a first-pass search (~50 ms of CPU per full-resolution
// image, one image at a time on the main process). nativeImage is not
// available in utility processes, so the parallelism comes instead from a few
// hidden renderer windows parented to the main window: the main process sends
// file bytes, Chromium's background decoder threads decode and downscale them
// to 9x8 RGBA, and the main process hashes the tiny pixel buffer (the hash
// algorithm stays in phash.js, exercised by exactly one implementation).
//
// The workers exist only while a search is decoding; dispose() tears them down
// so an idle app carries no extra renderers.

const { ipcMain } = require("electron");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const { MEDIA_PROTOCOL } = require("../shared/constants");
const { dhash } = require("./phash");
const windows = require("./windows");

const RENDERER_ROOT = path.join(__dirname, "..", "renderer");
const WORKER_COUNT = Math.max(1, Math.min(6, os.cpus().length - 1));
const REQUEST_TIMEOUT_MS = 30000;

let workers = [];
let registered = false;
let creating = null;
let disposed = false;
let requestId = 0;
let idleTimer = null;

// Workers linger briefly after a search so back-to-back searches reuse them,
// then tear down so an idle app carries no extra renderers.
const IDLE_TEARDOWN_MS = 20000;

function scheduleIdleTeardown() {
  if (idleTimer) {
    clearTimeout(idleTimer);
  }

  idleTimer = setTimeout(() => {
    idleTimer = null;
    dispose();
  }, IDLE_TEARDOWN_MS);
  idleTimer.unref();
}

function registerResultHandler() {
  if (registered) {
    return;
  }
  registered = true;

  ipcMain.handle("decode:result", (event, payload) => {
    const worker = workers.find((entry) => entry.window.webContents === event.sender);

    if (worker && payload && typeof payload.batchId === "number") {
      worker.pending.get(payload.batchId)?.(payload);
      worker.pending.delete(payload.batchId);
    }

    return { ok: true };
  });
}

async function createWorkers() {
  const { BrowserWindow } = require("electron");

  registerResultHandler();

  const parent = windows.getMainWindow();
  const created = [];

  for (let index = 0; index < WORKER_COUNT; index += 1) {
    const window = new BrowserWindow({
      show: false,
      parent: parent || undefined,
      // The main window is often hidden while a search runs; throttling would
      // starve the decoders exactly when they should be working hardest.
      webPreferences: {
        preload: path.join(RENDERER_ROOT, "..", "preload", "decoder.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false
      }
    });

    await window.loadURL(`${MEDIA_PROTOCOL}://app/decode.html`);
    created.push({ window, pending: new Map() });
  }

  return created;
}

function ensureWorkers() {
  disposed = false;

  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }

  if (workers.length > 0) {
    return Promise.resolve();
  }

  if (!creating) {
    creating = createWorkers()
      .then((created) => {
        workers = created;
      })
      .finally(() => {
        creating = null;
      });
  }

  return creating;
}

function dispose() {
  disposed = true;

  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }

  for (const worker of workers) {
    for (const settle of worker.pending.values()) {
      settle(null);
    }
    worker.pending.clear();
    worker.window.destroy();
  }

  workers = [];
}

// Sends one file to a worker and resolves with 9x8 RGBA pixels (or null).
function requestDecode(worker, buffer) {
  requestId += 1;
  const id = requestId;

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      worker.pending.delete(id);
      resolve(null);
    }, REQUEST_TIMEOUT_MS);

    worker.pending.set(id, (payload) => {
      clearTimeout(timeout);
      const result = payload?.results?.find((entry) => entry.id === id);
      resolve(result && result.ok ? result.pixels : null);
    });

    worker.window.webContents.send("decode:batch", {
      batchId: id,
      files: [{ id, buffer }]
    });
  });
}

// Hashes the given entries in parallel. Each worker pumps its own queue of
// files, so WORKER_COUNT images decode concurrently. Calls onResult(key,
// hashOrNull) per entry; stops early (and cleanly) once isCancelled() turns
// true.
async function hashFiles(entries, { onResult, isCancelled }) {
  await ensureWorkers();

  if (workers.length === 0) {
    return;
  }

  let index = 0;

  const pump = async (worker) => {
    while (index < entries.length) {
      if (disposed || (isCancelled && isCancelled())) {
        return;
      }

      const entry = entries[index];
      index += 1;

      let buffer = null;
      try {
        buffer = await fs.readFile(entry.filePath);
      } catch (_error) {
        buffer = null;
      }

      if (!buffer) {
        onResult(entry.key, null);
        continue;
      }

      let pixels = null;
      try {
        pixels = await requestDecode(worker, buffer);
      } catch (_error) {
        pixels = null;
      }

      if (disposed) {
        return;
      }

      onResult(entry.key, pixels ? dhash({ width: 9, height: 8, data: Buffer.from(pixels) }) : null);
    }
  };

  await Promise.all(workers.map((worker) => pump(worker)));

  if (!disposed && workers.length > 0) {
    scheduleIdleTeardown();
  }
}

// One-shot decode for a buffer already in memory (query images). Resolves to
// null when the farm is unavailable so callers can fall back to nativeImage.
async function hashBuffer(buffer) {
  try {
    await ensureWorkers();

    if (workers.length === 0) {
      return null;
    }

    const pixels = await requestDecode(workers[0], buffer);

    return pixels ? dhash({ width: 9, height: 8, data: Buffer.from(pixels) }) : null;
  } catch (_error) {
    return null;
  }
}

module.exports = {
  dispose,
  hashBuffer,
  hashFiles,
  workerCount: () => WORKER_COUNT
};
