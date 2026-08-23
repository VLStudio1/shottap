// Screen recording orchestration.
//
// The MediaRecorder itself lives in a hidden renderer (only a renderer can call
// getDisplayMedia), but every byte it produces is streamed here immediately and
// appended to the destination file. A ten minute recording therefore costs a
// couple of chunks of memory, not a gigabyte-sized in-memory Blob.

const { desktopCapturer, screen, session } = require("electron");
const fs = require("fs");
const fsp = require("fs/promises");

const geometry = require("./geometry");
const library = require("./library");
const windows = require("./windows");

const STATE = {
  IDLE: "idle",
  PREPARING: "preparing",
  RECORDING: "recording",
  FINALIZING: "finalizing"
};

let state = STATE.IDLE;
let session_ = null;
let listeners = new Set();
let pendingSource = null;

function onChange(listener) {
  listeners.add(listener);
}

function snapshot() {
  return {
    state,
    mode: session_?.mode || null,
    startedAt: session_?.startedAt || null,
    warning: session_?.warning || null
  };
}

function emit() {
  for (const listener of listeners) {
    listener(snapshot());
  }
}

function setState(next) {
  state = next;
  emit();
}

function isBusy() {
  return state !== STATE.IDLE;
}

function isRecording() {
  return state === STATE.RECORDING || state === STATE.PREPARING;
}

// Electron routes getDisplayMedia through this handler, so ShotTap decides
// which screen is recorded rather than letting the picker (or an implicit
// sources[0]) choose.
function installDisplayMediaHandler(targetSession = session.defaultSession) {
  targetSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      if (!pendingSource) {
        callback({});
        return;
      }

      callback({
        video: pendingSource.source,
        audio: pendingSource.systemAudio ? "loopback" : undefined
      });
    },
    { useSystemPicker: false }
  );
}

async function sourceForDisplay(display) {
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width: 0, height: 0 }
  });

  const match = sources.find((item) => item.display_id === String(display.id));

  if (match) {
    return match;
  }

  // Never fall back to an arbitrary sources[0] on a multi-monitor machine: the
  // user would get a recording of the wrong screen with no indication why.
  if (sources.length === 1) {
    return sources[0];
  }

  return null;
}

function targetHeightFor(quality) {
  if (quality === "1080p") {
    return 1080;
  }

  if (quality === "720p") {
    return 720;
  }

  return 0;
}

function writeChunk(buffer) {
  return new Promise((resolve, reject) => {
    if (!session_ || !session_.stream) {
      resolve();
      return;
    }

    session_.stream.write(buffer, (error) => (error ? reject(error) : resolve()));
  });
}

// Chunks are sequenced by the recorder; anything that arrives early waits its
// turn so the WebM container is never interleaved out of order.
async function acceptChunk({ seq, data }) {
  if (!session_) {
    return { ok: false };
  }

  session_.pending.set(seq, Buffer.from(data));

  while (session_.pending.has(session_.nextSeq)) {
    const buffer = session_.pending.get(session_.nextSeq);
    session_.pending.delete(session_.nextSeq);
    session_.nextSeq += 1;
    session_.bytes += buffer.length;
    await writeChunk(buffer);
  }

  return { ok: true, bytes: session_.bytes };
}

function acceptPoster(dataUrl) {
  if (!session_ || typeof dataUrl !== "string") {
    return { ok: false };
  }

  const base64 = dataUrl.split(",")[1] || "";
  session_.poster = Buffer.from(base64, "base64");

  return { ok: true };
}

function acceptStarted(info) {
  if (!session_) {
    return { ok: false };
  }

  session_.width = info.width || 0;
  session_.height = info.height || 0;
  session_.mimeType = info.mimeType || "";
  session_.startedAt = Date.now();
  session_.warning = info.warning || null;
  setState(STATE.RECORDING);

  return { ok: true };
}

// A stream that has already errored never emits 'finish', and a handle stuck on
// a vanished drive never completes at all; either would strand the session in
// FINALIZING and block every later recording.
const STREAM_CLOSE_TIMEOUT_MS = 5000;

function closeStream() {
  const active = session_;
  const stream = active?.stream;

  if (!stream) {
    return Promise.resolve();
  }

  active.stream = null;

  if (stream.destroyed) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      stream.destroy();
      finish();
    }, STREAM_CLOSE_TIMEOUT_MS);

    function finish() {
      clearTimeout(timer);
      stream.removeListener("finish", finish);
      resolve();
    }

    if (active.streamError) {
      stream.destroy();
      finish();
      return;
    }

    stream.once("finish", finish);
    stream.end();
  });
}

async function finalize({ durationMs, width, height, error } = {}) {
  if (!session_) {
    return { ok: false, message: "No recording in progress." };
  }

  const active = session_;
  setState(STATE.FINALIZING);

  await closeStream();

  const elapsed = durationMs || (active.startedAt ? Date.now() - active.startedAt : 0);
  let result;

  // A write that failed part-way leaves a truncated container behind; keeping it
  // would put an unplayable file in the library.
  if (active.streamError) {
    await fsp.rm(active.filePath, { force: true }).catch(() => {});
    session_ = null;
    pendingSource = null;
    setState(STATE.IDLE);

    return { ok: false, message: `Recording could not be written: ${active.streamError.message}` };
  }

  try {
    const stats = await fsp.stat(active.filePath);

    if (stats.size < 1024) {
      await fsp.rm(active.filePath, { force: true });
      result = { ok: false, message: error || "Recording produced no video data." };
    } else {
      const item = await library.addRecording({
        relPath: active.relPath,
        thumbnail: active.poster,
        width: width || active.width,
        height: height || active.height,
        durationMs: elapsed,
        source: active.mode === "area" ? "area" : "fullscreen",
        size: stats.size
      });

      result = {
        ok: true,
        item,
        warning: active.warning,
        message: error ? `Recording saved, but ${error}` : "Recording saved."
      };
    }
  } catch (statError) {
    result = { ok: false, message: `Recording failed: ${statError.message}` };
  }

  session_ = null;
  pendingSource = null;
  setState(STATE.IDLE);

  return result;
}

async function abort(message) {
  if (!session_) {
    return { ok: false, message };
  }

  const filePath = session_.filePath;
  await closeStream();
  await fsp.rm(filePath, { force: true }).catch(() => {});
  session_ = null;
  pendingSource = null;
  setState(STATE.IDLE);

  return { ok: false, message };
}

async function start({ mode, preferences }) {
  if (isBusy()) {
    return { ok: false, message: "A recording is already running." };
  }

  setState(STATE.PREPARING);

  let display = null;
  let region = null;

  if (mode === "area") {
    const selection = await windows.requestSelection("record");

    if (!selection) {
      setState(STATE.IDLE);
      return { ok: false, cancelled: true, message: "Recording cancelled." };
    }

    display = screen.getAllDisplays().find((item) => item.id === selection.displayId) || geometry.displayForRegion(selection, screen.getAllDisplays());
    region = selection;
  } else {
    display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  }

  if (!display) {
    setState(STATE.IDLE);
    return { ok: false, message: "Could not work out which display to record." };
  }

  const source = await sourceForDisplay(display);

  if (!source) {
    setState(STATE.IDLE);
    return { ok: false, message: "Could not match that display to a capture source." };
  }

  const { filePath, relPath } = await library.reserveRecordingPath("webm");
  const stream = fs.createWriteStream(filePath);

  // createWriteStream reports open failures asynchronously. An 'error' event
  // with no listener is fatal to the process, so a destination that went away
  // mid-capture (removed drive, deleted folder) has to be turned into a failed
  // recording instead. Writes after this point are dropped and `finalize`
  // reports the real reason.
  stream.on("error", (error) => {
    if (!session_ || session_.stream !== stream) {
      return;
    }

    session_.streamError = error;
    session_.stream = null;
    stream.destroy();
    requestStop();
  });

  pendingSource = { source, systemAudio: preferences.recordSystemAudio };
  session_ = {
    mode,
    filePath,
    relPath,
    stream,
    pending: new Map(),
    nextSeq: 0,
    bytes: 0,
    poster: null,
    startedAt: null,
    width: 0,
    height: 0,
    warning: null,
    streamError: null
  };

  const crop = region
    ? {
        // Fractions of the display, so the recorder can convert them using the
        // real stream dimensions instead of an assumed scale factor.
        x: (region.x - display.bounds.x) / display.bounds.width,
        y: (region.y - display.bounds.y) / display.bounds.height,
        width: region.width / display.bounds.width,
        height: region.height / display.bounds.height,
        clamped: Boolean(region.clamped)
      }
    : null;

  const recorder = windows.getRecorderWindow();

  const config = {
    mode,
    crop,
    frameRate: preferences.recordingFrameRate,
    targetHeight: targetHeightFor(preferences.recordingQuality),
    systemAudio: preferences.recordSystemAudio,
    microphone: preferences.recordMicrophone,
    chunkMs: 2000
  };

  const dispatch = () => recorder.webContents.send("recording:start", config);

  if (recorder.webContents.isLoading()) {
    recorder.webContents.once("did-finish-load", dispatch);
  } else {
    dispatch();
  }

  return { ok: true, region, display: display.id };
}

function requestStop() {
  if (!isRecording()) {
    return { ok: false, message: "Nothing is recording." };
  }

  const recorder = windows.getRecorderWindow();
  recorder.webContents.send("recording:stop");

  return { ok: true };
}

module.exports = {
  STATE,
  abort,
  acceptChunk,
  acceptPoster,
  acceptStarted,
  finalize,
  installDisplayMediaHandler,
  isBusy,
  isRecording,
  onChange,
  requestStop,
  snapshot,
  start,
  targetHeightFor
};
