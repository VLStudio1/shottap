// Global shortcut manager.
//
// Electron's `globalShortcut` is the single registration path in ShotTap.
// The previous build also ran a `uiohook-napi` keyboard hook alongside it,
// which made one physical keypress fire two captures whenever both systems saw
// the same combination (a 650 ms debounce only papered over it). The hook is
// gone: one accelerator, one owner, one action.

const { globalShortcut } = require("electron");

const { CAPTURE_ACTIONS } = require("../shared/constants");

const STATUS = {
  ACTIVE: "active",
  FAILED: "failed",
  CONFLICT: "conflict",
  SUSPENDED: "suspended"
};

let handlers = {};
let onHandlerError = () => {};
let current = {};
let statuses = {};
let suspended = false;

function setHandlers(nextHandlers, errorReporter) {
  handlers = nextHandlers;

  if (typeof errorReporter === "function") {
    onHandlerError = errorReporter;
  }
}

// Every action is async. A rejected handler here has no caller to catch it —
// unlike the IPC path, where ipcMain.handle forwards the rejection to the
// renderer — so it must be absorbed and reported, not left to become an
// unhandled rejection that terminates the main process.
function runHandler(action) {
  const handler = handlers[action];

  if (!handler) {
    return;
  }

  try {
    Promise.resolve(handler()).catch((error) => onHandlerError(action, error));
  } catch (error) {
    onHandlerError(action, error);
  }
}

// Actions that share an accelerator cannot both be registered; report them
// instead of letting one silently win.
function findDuplicates(shortcuts) {
  const seen = new Map();
  const duplicates = new Set();

  for (const action of CAPTURE_ACTIONS) {
    const accelerator = shortcuts[action];

    if (seen.has(accelerator)) {
      duplicates.add(action);
      duplicates.add(seen.get(accelerator));
    } else {
      seen.set(accelerator, action);
    }
  }

  return duplicates;
}

function apply(shortcuts) {
  current = { ...shortcuts };
  globalShortcut.unregisterAll();
  statuses = {};

  if (suspended) {
    for (const action of CAPTURE_ACTIONS) {
      statuses[action] = { accelerator: current[action], status: STATUS.SUSPENDED };
    }

    return statuses;
  }

  const duplicates = findDuplicates(current);

  for (const action of CAPTURE_ACTIONS) {
    const accelerator = current[action];

    if (duplicates.has(action)) {
      statuses[action] = {
        accelerator,
        status: STATUS.CONFLICT,
        message: "Assigned to more than one action"
      };
      continue;
    }

    let registered = false;

    try {
      registered = globalShortcut.register(accelerator, () => runHandler(action));
    } catch (_error) {
      registered = false;
    }

    // `register()` returning true is the only evidence that the accelerator is
    // really ours; anything else is reported as failed rather than assumed.
    statuses[action] = registered
      ? { accelerator, status: STATUS.ACTIVE }
      : {
          accelerator,
          status: STATUS.FAILED,
          message: "Claimed by Windows or another app"
        };
  }

  return statuses;
}

// While the user is recording a new combination we must not run the old one.
function suspend() {
  suspended = true;
  apply(current);
}

function resume() {
  suspended = false;

  return apply(current);
}

function getStatuses() {
  return statuses;
}

function isSuspended() {
  return suspended;
}

function teardown() {
  globalShortcut.unregisterAll();
}

module.exports = {
  STATUS,
  apply,
  findDuplicates,
  getStatuses,
  isSuspended,
  resume,
  setHandlers,
  suspend,
  teardown
};
