// Automated end-to-end check of the real application.
//
// Loaded only when SHOTTAP_SELFTEST is set (never packaged). It drives the
// actual capture pipeline, the real selection overlay (through synthesised
// mouse input), the real recorder and the real renderer, then writes a JSON
// report and window screenshots for both themes.

const { BrowserWindow, app, clipboard, nativeTheme, screen } = require("electron");
const { execFile } = require("child_process");
const fs = require("fs/promises");
const path = require("path");

const results = [];
const consoleErrors = [];
let outputDir = "";

function record(name, status, detail = "") {
  results.push({ name, status, detail });
  console.log(`[selftest] ${status.padEnd(4)} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function step(name, fn) {
  try {
    const detail = await fn();
    record(name, "PASS", detail || "");
    return true;
  } catch (error) {
    record(name, "FAIL", error.message);
    return false;
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(description, predicate, { timeout = 15000, interval = 120 } = {}) {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const value = await predicate();

    if (value) {
      return value;
    }

    await wait(interval);
  }

  throw new Error(`Timed out waiting for ${description}`);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function selectionWindows() {
  // Matched on the loaded document rather than the title: the window title
  // changes once selection.html finishes loading.
  return BrowserWindow.getAllWindows().filter((window) => window.webContents.getURL().includes("selection.html"));
}

async function cancelStraySelection(windows) {
  if (selectionWindows().length > 0) {
    windows.finishSelection(null);
    await wait(300);
  }
}

// Drives the overlay with synthesised mouse input, so the drag goes through the
// same pointer handling a person would use.
async function dragSelection(from, to, captureAs) {
  const [overlay] = await waitFor("the selection overlay", () => {
    const found = selectionWindows();
    return found.length > 0 ? found : null;
  });

  await waitFor("the overlay to receive its display bounds", () =>
    overlay.webContents.executeJavaScript("document.body.dataset.ready === 'true'")
  );

  const send = (type, x, y) =>
    overlay.webContents.sendInputEvent({
      type,
      x: Math.round(x),
      y: Math.round(y),
      button: "left",
      clickCount: 1,
      buttons: type === "mouseUp" ? 0 : 1
    });

  send("mouseDown", from.x, from.y);
  await wait(120);

  for (let index = 1; index <= 6; index += 1) {
    send("mouseMove", from.x + ((to.x - from.x) * index) / 6, from.y + ((to.y - from.y) * index) / 6);
    await wait(70);
  }

  // Only release once the overlay actually shows the rectangle we asked for,
  // otherwise a dropped move event would silently shrink the capture.
  await waitFor(
    `the overlay to show a ${to.x - from.x}x${to.y - from.y} selection`,
    async () => {
      const size = await overlay.webContents.executeJavaScript(`(() => {
        const box = document.getElementById("selection");
        return { width: parseFloat(box.style.width) || 0, height: parseFloat(box.style.height) || 0 };
      })()`);

      if (Math.abs(size.width - (to.x - from.x)) <= 2 && Math.abs(size.height - (to.y - from.y)) <= 2) {
        return true;
      }

      send("mouseMove", to.x, to.y);
      return false;
    },
    { timeout: 6000, interval: 200 }
  );

  if (captureAs) {
    await captureWindow(overlay, captureAs);
  }

  send("mouseUp", to.x, to.y);
}

// Presses a real key combination through the Windows input queue, so the
// keystroke reaches whatever ShotTap registered with RegisterHotKey exactly
// as it would from a user's keyboard.
function pressKeys(sendKeysCode) {
  return new Promise((resolve, reject) => {
    const script = `
Add-Type -AssemblyName System.Windows.Forms
Start-Sleep -Milliseconds 400
[System.Windows.Forms.SendKeys]::SendWait('${sendKeysCode}')
`;
    execFile(
      "powershell.exe",
      ["-Sta", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      { windowsHide: true, timeout: 15000 },
      (error) => (error ? reject(error) : resolve())
    );
  });
}

// CF_HDROP has no Electron reader, so the file drop list is read back the same
// way any other Windows app would see it.
function readClipboardFileList() {
  return new Promise((resolve, reject) => {
    const script = `
Add-Type -AssemblyName System.Windows.Forms
$files = [System.Windows.Forms.Clipboard]::GetFileDropList()
$names = @()
foreach ($file in $files) { $names += $file }
[Console]::Out.Write((ConvertTo-Json -Compress @($names)))
`;
    execFile(
      "powershell.exe",
      ["-Sta", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      { windowsHide: true, timeout: 15000 },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }

        try {
          const parsed = JSON.parse(stdout.trim() || "[]");
          resolve(Array.isArray(parsed) ? parsed : [parsed]);
        } catch (parseError) {
          reject(parseError);
        }
      }
    );
  });
}

async function captureWindow(window, fileName) {
  const image = await window.webContents.capturePage();
  await fs.writeFile(path.join(outputDir, fileName), image.toPNG());
}

async function run(deps) {
  const { actions, clipboardService, library, recording, settings, shortcuts, windows } = deps;

  outputDir = process.env.SHOTTAP_SELFTEST_OUT || path.join(app.getPath("temp"), "shottap-selftest");
  await fs.mkdir(outputDir, { recursive: true });

  const mainWindow = windows.getMainWindow();

  mainWindow.webContents.on("console-message", (event) => {
    if (event.level === "error" || event.level === 3) {
      consoleErrors.push(event.message);
    }
  });

  if (mainWindow.webContents.isLoading()) {
    await new Promise((resolve) => mainWindow.webContents.once("did-finish-load", resolve));
  }

  await waitFor("the renderer to finish booting", () =>
    mainWindow.webContents.executeJavaScript("document.body.dataset.ready === 'true'")
  );

  const display = screen.getPrimaryDisplay();

  // ---- shortcuts ---------------------------------------------------------
  await step("Global shortcuts register through Electron only", async () => {
    const statuses = shortcuts.getStatuses();
    const failed = Object.entries(statuses).filter(([, value]) => value.status !== "active");

    assert(Object.keys(statuses).length === 7, "expected seven registered actions");
    assert(failed.length === 0, `not active: ${failed.map(([key, value]) => `${key} (${value.status})`).join(", ")}`);

    return Object.entries(statuses)
      .map(([key, value]) => `${key}=${value.accelerator}`)
      .join(", ");
  });

  await step("Suspending shortcut capture releases every accelerator", async () => {
    shortcuts.suspend();
    const suspended = Object.values(shortcuts.getStatuses()).every((value) => value.status === "suspended");
    shortcuts.resume();
    const resumed = Object.values(shortcuts.getStatuses()).every((value) => value.status === "active");

    assert(suspended, "shortcuts stayed registered while capturing a new binding");
    assert(resumed, "shortcuts did not come back after capture");

    return "suspend/resume clean";
  });

  await step("Duplicate accelerators are reported as a conflict", async () => {
    const duplicates = shortcuts.findDuplicates({
      screenshotArea: "Ctrl+Alt+4",
      screenshotFullScreen: "Ctrl+Alt+4",
      recordArea: "Ctrl+Alt+6",
      recordFullScreen: "Ctrl+Alt+7",
      copyAll: "Ctrl+Alt+3",
      clearAll: "Ctrl+Alt+8",
      emptyTrash: "Ctrl+Alt+9"
    });

    assert(duplicates.has("screenshotArea") && duplicates.has("screenshotFullScreen"), "conflict not detected");

    return "conflicting pair detected";
  });

  // ---- screenshots -------------------------------------------------------
  await step("Screenshot Full Screen writes a real file at display resolution", async () => {
    clipboard.clear();
    const before = library.list().length;
    const result = await actions.screenshotFullScreen();

    assert(result.ok, result.message || "capture failed");
    assert(library.list().length === before + 1, "library did not gain an item");

    const item = library.list()[library.list().length - 1];
    const stats = await fs.stat(library.pathFor(item.id));
    const expectedWidth = Math.round(display.size.width * display.scaleFactor);

    assert(stats.size > 5000, `file is only ${stats.size} bytes`);
    assert(item.width === expectedWidth, `expected ${expectedWidth}px wide, got ${item.width}`);
    assert(item.source === "fullscreen", `source recorded as ${item.source}`);

    return `${item.width}x${item.height}, ${Math.round(stats.size / 1024)} KB`;
  });

  await step("Auto copy places the screenshot on the clipboard", async () => {
    assert(settings.get().preferences.autoCopyAfterCapture, "auto copy default is off");

    const image = clipboard.readImage();

    assert(!image.isEmpty(), "clipboard has no image after an auto-copied capture");

    const size = image.getSize();
    const item = library.list()[library.list().length - 1];

    assert(size.width === item.width, `clipboard image is ${size.width}px, file is ${item.width}px`);

    // Even a lone screenshot goes on as a file as well as a bitmap, so it can
    // be pasted into Explorer or a file upload, not just into an image editor.
    const expected = library.pathFor(item.id);
    const files = await waitFor(
      "the screenshot to appear on the clipboard as a file",
      async () => {
        const list = await readClipboardFileList();

        return list.includes(expected) ? list : null;
      },
      { timeout: 10000, interval: 250 }
    );

    assert(files.length === 1, `expected 1 file on the clipboard, got ${files.length}`);
    assert(!clipboard.readImage().isEmpty(), "the bitmap was lost when the file went on");

    return `${size.width}x${size.height} plus the file itself on the clipboard`;
  });

  await step("Screenshot Area crops exactly to the dragged region", async () => {
    const before = library.list().length;
    const pending = actions.screenshotArea();

    try {
      await dragSelection({ x: 200, y: 150 }, { x: 600, y: 450 }, "overlay-screenshot-mode.png");
    } catch (error) {
      await cancelStraySelection(windows);
      await pending;
      throw error;
    }

    const result = await pending;

    assert(result.ok, result.message || "area capture failed");
    assert(library.list().length === before + 1, "library did not gain an item");

    const item = library.list()[library.list().length - 1];
    const expectedWidth = Math.round(400 * display.scaleFactor);
    const expectedHeight = Math.round(300 * display.scaleFactor);

    assert(
      Math.abs(item.width - expectedWidth) <= 1 && Math.abs(item.height - expectedHeight) <= 1,
      `expected ~${expectedWidth}x${expectedHeight}, got ${item.width}x${item.height}`
    );
    assert(item.source === "area", `source recorded as ${item.source}`);

    return `${item.width}x${item.height} from a 400x300 drag`;
  });

  await step("A second screenshot copies the whole session, not just the newest", async () => {
    // Nothing else has run against this throwaway library, so every image in it
    // is part of the session queue.
    const images = library.list().filter((item) => item.type === "image" && !item.trashedAt);

    assert(images.length > 1, `expected more than one screenshot by now, have ${images.length}`);

    const expected = images.map((item) => library.pathFor(item.id));
    const files = await waitFor(
      "the clipboard to hold every session screenshot",
      async () => {
        const list = await readClipboardFileList();

        return list.length >= expected.length ? list : null;
      },
      { timeout: 10000, interval: 250 }
    );

    for (const filePath of expected) {
      assert(files.includes(filePath), `${path.basename(filePath)} is missing from the clipboard`);
    }

    // The multi-file drop must not cost apps that can only take a bitmap.
    const image = clipboard.readImage();
    const newest = images[images.length - 1];

    assert(!image.isEmpty(), "the bitmap flavour was lost when the file list went on");
    assert(
      image.getSize().width === newest.width,
      `bitmap is ${image.getSize().width}px, the newest screenshot is ${newest.width}px`
    );

    return `${files.length} files plus the newest bitmap`;
  });

  await step("Cancelling the overlay with Esc captures nothing", async () => {
    const before = library.list().length;
    const pending = actions.screenshotArea();
    const [overlay] = await waitFor("the selection overlay", () => {
      const found = selectionWindows();
      return found.length > 0 ? found : null;
    });
    await wait(350);
    overlay.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
    overlay.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
    const result = await pending;

    assert(!result.ok && result.cancelled, "cancel was not reported");
    assert(library.list().length === before, "a screenshot was saved despite cancelling");

    return "no file written";
  });

  await step("One physical hotkey press produces exactly one capture", async () => {
    const before = library.list().length;

    try {
      await pressKeys("^%5"); // Ctrl+Alt+5 — Screenshot Full Screen
    } catch (error) {
      throw new Error(`could not synthesise the keypress: ${error.message}`);
    }

    await wait(2600);
    const added = library.list().length - before;

    assert(added > 0, "the global hotkey did not fire at all");
    assert(added === 1, `one keypress produced ${added} captures`);

    return "Ctrl+Alt+5 fired once and captured once";
  });

  await step("With bring-to-front off a capture does not steal focus", async () => {
    await settings.update({ preferences: { bringToFrontAfterCapture: false } });

    const decoy = new BrowserWindow({ width: 520, height: 360, title: "Focus decoy", show: true });
    decoy.loadURL("data:text/html,<title>Focus decoy</title><body style='background:#222'></body>");
    await wait(700);
    decoy.focus();
    await wait(500);

    assert(decoy.isFocused(), "the decoy window never took focus");

    await actions.screenshotFullScreen();
    await wait(700);

    const decoyStillFocused = decoy.isFocused();
    const mainStole = mainWindow.isFocused();
    decoy.destroy();

    assert(!mainStole, "ShotTap pulled itself to the foreground with the preference off");
    assert(decoyStillFocused, "the other window lost focus during the capture");

    return "the foreground window kept focus and the clipboard still received the image";
  });

  await step("With bring-to-front on ShotTap does come forward", async () => {
    await settings.update({ preferences: { bringToFrontAfterCapture: true } });

    const decoy = new BrowserWindow({ width: 520, height: 360, title: "Focus decoy", show: true });
    decoy.loadURL("data:text/html,<title>Focus decoy</title><body style='background:#222'></body>");
    await wait(700);
    decoy.focus();
    await wait(500);

    await actions.screenshotFullScreen();
    await wait(900);

    const mainFocused = mainWindow.isFocused();
    decoy.destroy();
    await settings.update({ preferences: { bringToFrontAfterCapture: false } });

    assert(mainFocused, "ShotTap stayed in the background with the preference on");

    return "ShotTap came to the foreground as configured";
  });

  await step("Copy All copies the whole session queue", async () => {
    const images = library.list().filter((item) => item.type === "image" && !item.trashedAt);
    const expected = images.map((item) => library.pathFor(item.id));
    const result = await actions.copyAll();

    assert(result.ok, result.message);

    const files = await waitFor(
      "Copy All to expose every session image as files",
      async () => {
        const list = await readClipboardFileList();

        return expected.every((filePath) => list.includes(filePath)) ? list : null;
      },
      { timeout: 10000, interval: 250 }
    );

    if (images.length > 1) {
      const newest = images[images.length - 1];
      const size = await waitFor(
        "Copy All to expose a composite bitmap fallback",
        () => {
          const image = clipboard.readImage();

          if (image.isEmpty()) {
            return null;
          }

          const dimensions = image.getSize();

          return dimensions.height > newest.height ? dimensions : null;
        },
        { timeout: 10000, interval: 250 }
      );

      return `${files.length} files plus ${size.width}x${size.height} composite bitmap`;
    }

    return result.message;
  });

  await step("Clearing the clipboard still allows Copy All from Captures", async () => {
    const images = library.list().filter((item) => item.type === "image" && !item.trashedAt);
    const expected = images.map((item) => library.pathFor(item.id));

    assert(expected.length > 0, "no screenshots exist to copy from Captures");

    await mainWindow.webContents.executeJavaScript(`(async () => {
      window.__shottapTest.navigate("captures");
      await window.shottap.clearClipboard();
      document.querySelector('.action-card[data-action="copyAll"]').click();
    })()`);

    const files = await waitFor(
      "Copy All from Captures after clearing the clipboard",
      async () => {
        const list = await readClipboardFileList();

        return expected.every((filePath) => list.includes(filePath)) ? list : null;
      },
      { timeout: 10000, interval: 250 }
    );

    const image = clipboard.readImage();

    assert(!image.isEmpty(), "Copy All from Captures did not leave an image fallback on the clipboard");

    return `${files.length} files copied from the Captures screen after clearing`;
  });

  await step("Copy All falls back to library screenshots when the session queue is empty", async () => {
    const images = library.list().filter((item) => item.type === "image" && !item.trashedAt);
    const expected = images.map((item) => library.pathFor(item.id));

    assert(expected.length > 0, "no screenshots exist to copy after clearing the queue");

    actions.clearAll();
    const result = await actions.copyAll();

    assert(result.ok, result.message);

    const files = await waitFor(
      "Copy All fallback to expose library screenshots",
      async () => {
        const list = await readClipboardFileList();

        return expected.every((filePath) => list.includes(filePath)) ? list : null;
      },
      { timeout: 10000, interval: 250 }
    );

    return `${files.length} library screenshots copied with an empty session queue`;
  });

  await step("Copy All composite fallback stays bounded for large queues", async () => {
    const first = library.list().find((item) => item.type === "image" && !item.trashedAt);

    assert(first, "no screenshot exists for a large Copy All clipboard stress check");

    const filePath = library.pathFor(first.id);
    const filePaths = Array.from({ length: 80 }, () => filePath);
    const result = await clipboardService.copyFiles(filePaths, filePaths, { compositeImages: true });

    assert(result.ok, result.message);

    const image = clipboard.readImage();

    assert(!image.isEmpty(), "large Copy All did not leave an image fallback on the clipboard");

    const size = image.getSize();

    assert(size.width <= 2400, `large composite is too wide: ${size.width}px`);
    assert(size.height <= 16000, `large composite is too tall: ${size.height}px`);

    return `${size.width}x${size.height} bitmap for 80 screenshots`;
  });

  // ---- recording ---------------------------------------------------------
  await step("Record Full Screen writes a playable WebM without buffering it in memory", async () => {
    const before = library.list().filter((item) => item.type === "video").length;
    await actions.recordFullScreen();
    await waitFor("recording to start", () => recording.snapshot().state === "recording", { timeout: 20000 });

    await wait(4000);
    const heapDuringRecording = process.memoryUsage().heapUsed;
    const audioWarning = recording.snapshot().warning;

    await actions.recordFullScreen(); // the same shortcut stops it
    await waitFor("recording to finish", () => recording.snapshot().state === "idle", { timeout: 25000 });

    const videos = library.list().filter((item) => item.type === "video");

    assert(videos.length === before + 1, "no recording was added to the library");

    const item = videos[videos.length - 1];
    const stats = await fs.stat(library.pathFor(item.id));

    assert(stats.size > 20000, `recording is only ${stats.size} bytes`);
    assert(item.durationMs > 2500 && item.durationMs < 9000, `duration recorded as ${item.durationMs}ms`);
    assert(item.width === Math.round(display.size.width * display.scaleFactor), `width is ${item.width}`);
    assert(item.thumb, "no poster frame was captured");

    return `${item.width}x${item.height}, ${Math.round(stats.size / 1024)} KB, ${item.durationMs}ms, heap ${Math.round(heapDuringRecording / 1048576)} MB, audio: ${audioWarning || "system audio captured"}`;
  });

  await step("A recording still completes when the microphone is requested", async () => {
    await settings.update({ preferences: { recordMicrophone: true } });
    const before = library.list().filter((item) => item.type === "video").length;

    await actions.recordFullScreen();
    await waitFor("recording to start", () => recording.snapshot().state === "recording", { timeout: 20000 });
    const warning = recording.snapshot().warning;
    await wait(2500);
    await actions.recordFullScreen();
    await waitFor("recording to finish", () => recording.snapshot().state === "idle", { timeout: 25000 });

    const videos = library.list().filter((item) => item.type === "video");
    await settings.update({ preferences: { recordMicrophone: false } });

    assert(videos.length === before + 1, "the microphone recording produced no file");

    const stats = await fs.stat(library.pathFor(videos[videos.length - 1].id));
    assert(stats.size > 10000, `recording is only ${stats.size} bytes`);

    return warning ? `completed with a warning: ${warning}` : "completed with microphone and system audio mixed in";
  });

  await step("Record Area records only the selected region", async () => {
    const before = library.list().filter((item) => item.type === "video").length;
    const pending = actions.recordArea();
    await dragSelection({ x: 300, y: 200 }, { x: 940, y: 560 }, "overlay-record-mode.png");
    await pending;
    await waitFor("recording to start", () => recording.snapshot().state === "recording", { timeout: 20000 });

    await wait(3000);
    await actions.recordArea();
    await waitFor("recording to finish", () => recording.snapshot().state === "idle", { timeout: 25000 });

    const videos = library.list().filter((item) => item.type === "video");

    assert(videos.length === before + 1, "no recording was added to the library");

    const item = videos[videos.length - 1];
    const stats = await fs.stat(library.pathFor(item.id));
    const expectedWidth = Math.round(640 * display.scaleFactor);

    assert(stats.size > 10000, `recording is only ${stats.size} bytes`);
    assert(Math.abs(item.width - expectedWidth) <= 2, `expected ~${expectedWidth}px wide, got ${item.width}`);
    assert(item.source === "area", `source recorded as ${item.source}`);

    return `${item.width}x${item.height}, ${Math.round(stats.size / 1024)} KB, ${item.durationMs}ms`;
  });

  await step("Saved recordings actually decode and play", async () => {
    const video = library.list().filter((item) => item.type === "video").pop();

    const playback = await mainWindow.webContents.executeJavaScript(`(async () => {
      const element = document.createElement("video");
      element.src = ${JSON.stringify(`shottap://app/media/${library.find(video.id).relPath.split("/").map(encodeURIComponent).join("/")}`)};
      element.muted = true;
      document.body.append(element);

      await new Promise((resolve, reject) => {
        element.onloadeddata = resolve;
        element.onerror = () => reject(new Error("the video could not be decoded"));
        setTimeout(() => reject(new Error("timed out decoding the video")), 12000);
      });

      await element.play();
      await new Promise((resolve) => setTimeout(resolve, 900));
      const advanced = element.currentTime;
      element.pause();
      element.remove();

      return { width: element.videoWidth, height: element.videoHeight, advanced };
    })()`);

    assert(playback.width === video.width, `decoded width ${playback.width}, expected ${video.width}`);
    assert(playback.advanced > 0.2, `playback position only reached ${playback.advanced}s`);

    return `${playback.width}x${playback.height} decoded, played to ${playback.advanced.toFixed(2)}s`;
  });

  // ---- library operations ------------------------------------------------
  await step("Favourite, trash, restore and permanent delete all touch real files", async () => {
    const item = library.list().find((entry) => entry.type === "image");

    library.setFavorite(item.id, true);
    assert(library.find(item.id).favorite, "favourite flag did not stick");

    await library.moveToTrash(item.id);
    assert(library.find(item.id).trashedAt, "item was not trashed");
    await fs.access(library.pathFor(item.id));

    await library.restore(item.id);
    assert(!library.find(item.id).trashedAt, "item was not restored");
    await fs.access(library.pathFor(item.id));

    const doomed = await library.addImage({
      buffer: Buffer.alloc(64, 1),
      width: 8,
      height: 8,
      source: "area"
    });
    const doomedPath = library.pathFor(doomed.id);
    await library.deletePermanently(doomed.id);

    assert(library.find(doomed.id) === null, "index entry survived deletion");

    let stillThere = true;

    try {
      await fs.access(doomedPath);
    } catch (_error) {
      stillThere = false;
    }

    assert(!stillThere, "file survived permanent deletion");

    return "favourite, trash, restore and delete verified on disk";
  });

  // ---- renderer ----------------------------------------------------------
  const views = ["captures", "recordings", "clipboard", "favorites", "trash", "editor", "hotkeys", "general", "appearance", "about"];

  for (const theme of ["light", "dark"]) {
    await step(`Every view renders in ${theme} mode`, async () => {
      nativeTheme.themeSource = theme;
      await settings.update({ appearance: { theme } });
      // Start each pass with the inspector closed so the view captures show the
      // full-width layout.
      await mainWindow.webContents.executeJavaScript(`(() => {
        window.__shottapTest.state.selectedId = null;
      })()`);
      await wait(300);

      for (const view of views) {
        await mainWindow.webContents.executeJavaScript(`window.__shottapTest.navigate(${JSON.stringify(view)})`);
        await wait(260);

        const check = await mainWindow.webContents.executeJavaScript(`(() => {
          const main = document.getElementById("main");
          return {
            html: main.innerHTML.length,
            navActive: document.querySelector('.nav-item[aria-current="page"]')?.dataset.view || null,
            buttons: main.querySelectorAll("button").length
          };
        })()`);

        assert(check.html > 200, `${view} rendered almost nothing`);
        assert(check.navActive === view, `${view} did not become the current nav item`);

        await captureWindow(mainWindow, `${theme}-${view}.png`);
      }

      // The inspector, with a selection, in both themes.
      await mainWindow.webContents.executeJavaScript(`(() => {
        window.__shottapTest.navigate("captures");
        const first = window.__shottapTest.state.items.filter((item) => !item.trashedAt && item.type === "image")[0];
        window.__shottapTest.state.selectedId = null;
        window.__shottapTest.selectItem(first.id);
      })()`);
      await wait(400);

      const inspectorVisible = await mainWindow.webContents.executeJavaScript(
        "!document.getElementById('inspector').hidden && document.querySelectorAll('.inspector-action').length"
      );

      assert(inspectorVisible >= 5, "the inspector did not open with its actions");
      await captureWindow(mainWindow, `${theme}-inspector.png`);

      return `${views.length} views + inspector captured`;
    });
  }

  await step("The editor opens a screenshot at full resolution with working tools", async () => {
    const opened = await mainWindow.webContents.executeJavaScript(`(async () => {
      const item = window.__shottapTest.state.items.find((entry) => entry.type === "image" && !entry.trashedAt);
      await window.SCEditor.open(item);
      const canvas = document.getElementById("editorCanvas");
      return {
        open: window.SCEditor.isOpen(),
        width: canvas.width,
        height: canvas.height,
        expectedWidth: item.width,
        expectedHeight: item.height,
        tools: document.querySelectorAll("#editorTools button").length
      };
    })()`);

    assert(opened.open, "editor did not open");
    assert(
      opened.width === opened.expectedWidth && opened.height === opened.expectedHeight,
      `canvas is ${opened.width}x${opened.height} but the file is ${opened.expectedWidth}x${opened.expectedHeight}`
    );
    assert(opened.tools === 7, `expected drawing tools, eraser, undo and redo, found ${opened.tools}`);

    await wait(400);
    await captureWindow(mainWindow, "editor-open.png");
    await mainWindow.webContents.executeJavaScript("window.SCEditor.close()");

    return `${opened.width}x${opened.height} canvas`;
  });

  await step("Editor markup is written back to the real PNG file", async () => {
    const target = library.list().find((entry) => entry.type === "image" && !entry.trashedAt);
    const before = await fs.stat(library.pathFor(target.id));

    const saved = await mainWindow.webContents.executeJavaScript(`(async () => {
      const item = window.__shottapTest.state.items.find((entry) => entry.id === ${JSON.stringify(target.id)});
      await window.SCEditor.open(item);
      const canvas = document.getElementById("editorCanvas");
      const rect = canvas.getBoundingClientRect();
      const send = (type, x, y) => canvas.dispatchEvent(new PointerEvent(type, {
        clientX: rect.left + x, clientY: rect.top + y, buttons: 1, bubbles: true, pointerId: 1
      }));
      send("pointerdown", 40, 40);
      send("pointermove", 120, 90);
      send("pointermove", 200, 60);
      send("pointerup", 200, 60);
      const undoDisabled = document.querySelector('[data-command="undo"]').disabled;
      document.querySelector('[data-command="save"]').click();
      await new Promise((resolve) => setTimeout(resolve, 2500));
      return { undoEnabled: !undoDisabled, stillOpen: window.SCEditor.isOpen() };
    })()`);

    assert(saved.undoEnabled, "undo stayed disabled after drawing a stroke");
    assert(!saved.stillOpen, "the editor did not close after saving");

    const after = await fs.stat(library.pathFor(target.id));
    const updated = library.find(target.id);

    assert(after.size !== before.size, "the PNG on disk did not change");
    assert(updated.editedAt, "the item was not marked as edited");
    assert(updated.width === target.width && updated.height === target.height, "the edit changed the image size");

    return `${Math.round(before.size / 1024)} KB → ${Math.round(after.size / 1024)} KB, dimensions preserved`;
  });

  await step("Editor shape tools draw and save vector markup", async () => {
    const target = library.list().find((entry) => entry.type === "image" && !entry.trashedAt);
    const before = await fs.stat(library.pathFor(target.id));

    const saved = await mainWindow.webContents.executeJavaScript(`(async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const item = window.__shottapTest.state.items.find((entry) => entry.id === ${JSON.stringify(target.id)});
      await window.SCEditor.open(item);
      const canvas = document.getElementById("editorCanvas");
      const rect = canvas.getBoundingClientRect();
      const send = (type, x, y, shiftKey = false) => canvas.dispatchEvent(new PointerEvent(type, {
        clientX: rect.left + x, clientY: rect.top + y, button: 0, buttons: type === "pointerup" ? 0 : 1, bubbles: true, pointerId: 2, shiftKey
      }));

      document.querySelector('[data-tool="rectangle"]').click();
      send("pointerdown", 260, 120);
      send("pointermove", 480, 260, true);
      send("pointerup", 480, 260, true);

      document.querySelector('[data-tool="ellipse"]').click();
      send("pointerdown", 520, 140);
      send("pointermove", 720, 300);
      send("pointerup", 720, 300);

      document.querySelector('[data-tool="line"]').click();
      send("pointerdown", 300, 360);
      send("pointermove", 720, 420);
      send("pointerup", 720, 420);

      const undoEnabled = !document.querySelector('[data-command="undo"]').disabled;
      document.querySelector('[data-command="save"]').click();
      await wait(2500);

      return { undoEnabled, stillOpen: window.SCEditor.isOpen() };
    })()`);

    assert(saved.undoEnabled, "undo stayed disabled after drawing shapes");
    assert(!saved.stillOpen, "the editor did not close after saving shapes");

    const after = await fs.stat(library.pathFor(target.id));

    assert(after.size !== before.size, "shape markup did not change the PNG on disk");

    return "rectangle, ellipse and line saved";
  });

  await step("Search, sort and filter narrow the library for real", async () => {
    const outcome = await mainWindow.webContents.executeJavaScript(`(async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      window.__shottapTest.navigate("captures");
      await wait(150);
      const total = document.querySelectorAll(".media-card").length;

      const search = document.querySelector('[data-control="search"]');
      search.value = "zzz-no-such-capture";
      search.dispatchEvent(new Event("input", { bubbles: true }));
      await wait(150);
      const noMatches = document.querySelectorAll(".media-card").length;
      const emptyTitle = document.querySelector(".empty-state h3")?.textContent || "";

      const search2 = document.querySelector('[data-control="search"]');
      search2.value = "Screenshot";
      search2.dispatchEvent(new Event("input", { bubbles: true }));
      await wait(150);
      const matches = document.querySelectorAll(".media-card").length;

      const search3 = document.querySelector('[data-control="search"]');
      search3.value = "";
      search3.dispatchEvent(new Event("input", { bubbles: true }));
      await wait(150);

      const filter = document.querySelector('[data-control="filter"]');
      filter.value = "favorites";
      filter.dispatchEvent(new Event("change", { bubbles: true }));
      await wait(150);
      const favorites = document.querySelectorAll(".media-card").length;

      const filter2 = document.querySelector('[data-control="filter"]');
      filter2.value = "all";
      filter2.dispatchEvent(new Event("change", { bubbles: true }));
      await wait(150);

      const sort = document.querySelector('[data-control="sort"]');
      sort.value = "name";
      sort.dispatchEvent(new Event("change", { bubbles: true }));
      await wait(150);
      const names = [...document.querySelectorAll(".media-title")].map((node) => node.textContent);

      document.querySelector('[data-layout="list"]').click();
      await wait(150);
      const rows = document.querySelectorAll(".media-row").length;
      document.querySelector('[data-layout="grid"]').click();

      return { total, noMatches, emptyTitle, matches, favorites, names, rows };
    })()`);

    assert(outcome.total > 0, "no cards to filter");
    assert(outcome.noMatches === 0 && /Nothing matches/.test(outcome.emptyTitle), "a nonsense search still showed cards");
    assert(outcome.matches === outcome.total, "searching for the common prefix hid matching cards");
    assert(outcome.favorites <= outcome.total, "the favourites filter widened the list");
    assert(
      outcome.names.join("|") === [...outcome.names].sort((a, b) => a.localeCompare(b)).join("|"),
      "sorting by name did not sort"
    );
    assert(outcome.rows === outcome.total, "the list layout showed a different number of items");

    return `${outcome.total} cards, search/filter/sort/list all effective`;
  });

  await step("Recording state drives the recording bar in the UI", async () => {
    await actions.recordFullScreen();
    await waitFor("recording to start", () => recording.snapshot().state === "recording", { timeout: 20000 });
    await wait(1200);

    const bar = await mainWindow.webContents.executeJavaScript(`(() => {
      const bar = document.getElementById("recordingBar");
      const card = document.querySelector('.action-card[data-action="recordFullScreen"]');
      return {
        visible: !bar.hidden,
        time: document.getElementById("recordingTime").textContent,
        cardLabel: card ? card.querySelector(".action-name").textContent.trim() : null
      };
    })()`);

    await captureWindow(mainWindow, "recording-state.png");

    // Stop through the visible control rather than the hotkey this time.
    await mainWindow.webContents.executeJavaScript("document.getElementById('stopRecordingButton').click()");
    await waitFor("recording to finish", () => recording.snapshot().state === "idle", { timeout: 25000 });

    assert(bar.visible, "the recording bar stayed hidden while recording");
    assert(/^\d{2}:\d{2}$/.test(bar.time), `timer showed "${bar.time}"`);
    assert(bar.cardLabel === "Stop Recording", `record card said "${bar.cardLabel}"`);

    return `bar visible at ${bar.time}, card switched to Stop Recording, stopped from the Stop button`;
  });

  await step("Shortcut badges in the UI follow the configured accelerator", async () => {
    await settings.update({ shortcuts: { screenshotArea: "Ctrl+Shift+9" } });
    shortcuts.apply(settings.get().shortcuts);
    windows.sendToRenderer("app:settings", {
      shortcuts: settings.get().shortcuts,
      shortcutStatus: shortcuts.getStatuses(),
      preferences: settings.get().preferences,
      appearance: settings.get().appearance,
      saveDirectory: settings.get().saveDirectory,
      directories: library.directories()
    });
    await wait(400);

    const shown = await mainWindow.webContents.executeJavaScript(`(() => {
      window.__shottapTest.navigate("captures");
      const card = document.querySelector('.action-card[data-action="screenshotArea"] kbd');
      return {
        card: card ? card.textContent.trim() : null,
        brand: document.getElementById("brandShortcut").textContent.trim(),
        quick: document.getElementById("quickCaptureShortcut").textContent.trim()
      };
    })()`);

    assert(shown.card === "Ctrl+Shift+9", `action card shows "${shown.card}"`);
    assert(shown.brand === "Ctrl+Shift+9", `brand chip shows "${shown.brand}"`);
    assert(shown.quick === "Ctrl+Shift+9", `quick capture chip shows "${shown.quick}"`);

    await settings.update({ shortcuts: { screenshotArea: "Ctrl+Alt+4" } });
    shortcuts.apply(settings.get().shortcuts);

    return "card, brand chip and quick capture all followed the change";
  });

  await step("The shortcut editor rejects bad bindings and never lies about the result", async () => {
    const outcome = await mainWindow.webContents.executeJavaScript(`(async () => {
      const bare = await window.shottap.settings.setShortcut("screenshotArea", "F5");
      const duplicate = await window.shottap.settings.setShortcut("screenshotArea", "Ctrl+Alt+3");
      // Win+Shift+S belongs to the Windows snipping tool; whichever way this
      // goes, the reported status has to match reality.
      const contested = await window.shottap.settings.setShortcut("screenshotArea", "Super+Shift+S");
      const state = await window.shottap.getState();

      return {
        bare,
        duplicate,
        contested,
        accelerator: state.settings.shortcuts.screenshotArea,
        status: state.settings.shortcutStatus.screenshotArea.status
      };
    })()`);

    assert(!outcome.bare.ok, "a modifier-less key was accepted");
    assert(!outcome.duplicate.ok, "an accelerator already used by Copy All was accepted");
    assert(/another ShotTap action/.test(outcome.duplicate.message), `unclear duplicate message: ${outcome.duplicate.message}`);

    if (outcome.contested.ok) {
      assert(outcome.accelerator === "Super+Shift+S" && outcome.status === "active", "a saved shortcut is not reported active");
    } else {
      assert(outcome.accelerator === "Ctrl+Alt+4", `rollback left the shortcut as ${outcome.accelerator}`);
      assert(outcome.status === "active", "the rolled-back shortcut was left inactive");
    }

    await settings.update({ shortcuts: { screenshotArea: "Ctrl+Alt+4" } });
    shortcuts.apply(settings.get().shortcuts);

    return outcome.contested.ok
      ? "Win+Shift+S was granted by Windows and reported active"
      : `Win+Shift+S refused and rolled back cleanly (${outcome.contested.message})`;
  });

  await step("The layout survives narrow windows without overlapping", async () => {
    const original = mainWindow.getBounds();
    const widths = [1400, 1020, 860, 760];
    const notes = [];

    // Keep a capture selected so the inspector is part of every measurement.
    await mainWindow.webContents.executeJavaScript(`(() => {
      const first = window.__shottapTest.state.items.find((item) => !item.trashedAt);
      window.__shottapTest.state.selectedId = null;
      window.__shottapTest.selectItem(first.id);
    })()`);

    for (const width of widths) {
      mainWindow.setBounds({ ...original, width, height: 760 });
      await wait(500);

      const layout = await mainWindow.webContents.executeJavaScript(`(() => {
        window.__shottapTest.navigate("captures");
        const overflow = document.documentElement.scrollWidth > document.documentElement.clientWidth + 1;
        const cards = [...document.querySelectorAll(".action-card")].map((card) => card.getBoundingClientRect());
        const collisions = cards.some((a, index) =>
          cards.some((b, other) => other > index && a.right > b.left + 1 && a.left < b.right - 1 && a.bottom > b.top + 1 && a.top < b.bottom - 1)
        );
        const sidebar = document.getElementById("sidebar").getBoundingClientRect().width;
        const main = document.getElementById("main").getBoundingClientRect();
        const inspector = document.getElementById("inspector");
        const panel = inspector.hidden ? null : inspector.getBoundingClientRect();
        // Either the inspector sits beside the content, or it covers all of it
        // as a sheet — never half of it.
        const partiallyCovers = panel ? panel.left > main.left + 1 && panel.left < main.right - 1 : false;
        return { overflow, collisions, sidebar, mainWidth: Math.round(main.width), partiallyCovers, hasPanel: Boolean(panel) };
      })()`);

      assert(!layout.overflow, `the page scrolled sideways at ${width}px`);
      assert(!layout.collisions, `action cards overlapped at ${width}px`);
      assert(layout.mainWidth > 300, `the content area collapsed to ${layout.mainWidth}px at ${width}px`);
      assert(layout.hasPanel, `the inspector closed itself at ${width}px`);
      assert(!layout.partiallyCovers, `the inspector covered part of the content at ${width}px`);

      notes.push(`${width}px → rail ${Math.round(layout.sidebar)}px`);
      await captureWindow(mainWindow, `responsive-${width}.png`);
    }

    mainWindow.setBounds(original);
    await wait(400);

    return notes.join(", ");
  });

  await step("Every interactive control has an accessible name", async () => {
    const problems = await mainWindow.webContents.executeJavaScript(`(async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const views = ${JSON.stringify(views)};
      const offenders = [];

      for (const view of views) {
        window.__shottapTest.navigate(view);
        await wait(180);

        for (const node of document.querySelectorAll("button, input, select, [role='button']")) {
          const name = (node.textContent || "").trim() ||
            node.getAttribute("aria-label") ||
            node.getAttribute("title") ||
            (node.labels && node.labels.length ? node.labels[0].textContent.trim() : "");

          if (!name) {
            offenders.push(view + ": " + node.outerHTML.slice(0, 70));
          }
        }
      }

      return offenders;
    })()`);

    assert(problems.length === 0, problems.slice(0, 3).join(" | "));

    return "buttons, switches and selects all named";
  });

  await step("No renderer console errors during the whole run", async () => {
    assert(consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));

    return "clean console";
  });

  const report = {
    finishedAt: new Date().toISOString(),
    display: { bounds: display.bounds, size: display.size, scaleFactor: display.scaleFactor },
    results,
    consoleErrors,
    outputDir
  };

  await fs.writeFile(path.join(outputDir, "report.json"), JSON.stringify(report, null, 2), "utf8");

  const failed = results.filter((entry) => entry.status === "FAIL").length;
  console.log(`[selftest] ${results.length - failed}/${results.length} passed. Artifacts in ${outputDir}`);

  await library.flush();
  app.exit(failed === 0 ? 0 : 1);
}

module.exports = { run };
