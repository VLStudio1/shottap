// Curated public documentation screenshots.
//
// This intentionally uses temporary app data and synthetic fixture media. The
// ShotTap UI is real; the captured content is not the developer's desktop.
// Final images are composited onto an AI-generated presentation backdrop.

const { BrowserWindow, app, nativeTheme, screen } = require("electron");
const fs = require("fs/promises");
const path = require("path");

const FIXTURE_SIZE = { width: 1440, height: 900 };
const MAIN_SIZE = { width: 1600, height: 900 };
const PRESENTATION_SIZE = { width: 2000, height: 1250 };
const SOCIAL_SIZE = { width: 1280, height: 640 };

let outputDir = "";

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(description, predicate, { timeout = 12000, interval = 120 } = {}) {
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

function dataUrl(html) {
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function fixtureHtml(kind, title, accent, body) {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      width: 100vw;
      height: 100vh;
      overflow: hidden;
      color: #142033;
      background: #eef3f8;
      font: 18px/1.45 "Segoe UI", Arial, sans-serif;
    }
    .page {
      width: 100%;
      height: 100%;
      padding: 54px;
      background:
        radial-gradient(circle at 12% 12%, rgba(47,123,246,.14), transparent 28%),
        linear-gradient(135deg, #f8fbff 0%, #e7eef8 100%);
    }
    .chrome {
      height: 48px;
      border-radius: 14px 14px 0 0;
      background: #1d2531;
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 0 18px;
      color: #98a6b8;
    }
    .dot { width: 11px; height: 11px; border-radius: 50%; background: #536070; }
    .dot:nth-child(1) { background: #f06565; }
    .dot:nth-child(2) { background: #f4b942; }
    .dot:nth-child(3) { background: #4fc37b; }
    .window {
      height: calc(100% - 6px);
      border-radius: 16px;
      box-shadow: 0 24px 70px rgba(35, 49, 71, .22);
      background: #fff;
      overflow: hidden;
    }
    .content { padding: 44px; height: calc(100% - 48px); }
    .eyebrow {
      color: ${accent};
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: .08em;
      font-size: 13px;
    }
    h1 { margin: 10px 0 10px; font-size: 46px; line-height: 1.05; letter-spacing: 0; }
    p { margin: 0; color: #607086; max-width: 760px; }
    .grid { display: grid; grid-template-columns: 1.2fr .8fr; gap: 28px; margin-top: 36px; height: 440px; }
    .panel {
      border: 1px solid #dbe4f0;
      border-radius: 14px;
      background: #f8fbff;
      padding: 24px;
      overflow: hidden;
    }
    .bars { display: grid; gap: 16px; margin-top: 20px; }
    .bar { height: 18px; border-radius: 999px; background: linear-gradient(90deg, ${accent}, #7fd4ff); }
    .bar:nth-child(2) { width: 76%; }
    .bar:nth-child(3) { width: 58%; }
    .cards { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
    .card { min-height: 112px; border-radius: 12px; background: #fff; border: 1px solid #dbe4f0; padding: 18px; }
    .metric { font-size: 34px; font-weight: 800; color: #0f1b2f; }
    .tiny { color: #75869d; font-size: 14px; margin-top: 8px; }
    .editor {
      display: grid;
      grid-template-columns: 190px 1fr;
      gap: 22px;
      height: 100%;
    }
    .code {
      font: 17px/1.6 Consolas, "SFMono-Regular", monospace;
      color: #dbe7ff;
      background: #101826;
      border-radius: 14px;
      padding: 24px;
    }
    .line { height: 14px; margin: 12px 0; border-radius: 8px; background: #314059; }
    .line:nth-child(2n) { width: 76%; background: #435575; }
    .chart {
      height: 100%;
      border-radius: 14px;
      background: linear-gradient(180deg, #fff, #f3f7fc);
      border: 1px solid #dbe4f0;
      display: flex;
      align-items: end;
      gap: 18px;
      padding: 28px;
    }
    .col { flex: 1; border-radius: 12px 12px 0 0; background: linear-gradient(180deg, ${accent}, #7bdcff); }
  </style>
</head>
<body>
  <div class="page">
    <div class="window">
      <div class="chrome"><span class="dot"></span><span class="dot"></span><span class="dot"></span><span>${kind}</span></div>
      <div class="content">
        <div class="eyebrow">ShotTap demo fixture</div>
        <h1>${title}</h1>
        <p>${body}</p>
        ${kind === "Editor"
          ? `<div class="grid editor"><div class="panel"><div class="metric">42</div><div class="tiny">safe sample files</div><div class="bars"><span class="bar"></span><span class="bar"></span><span class="bar"></span></div></div><div class="code"><div class="line"></div><div class="line"></div><div class="line"></div><div class="line"></div><div class="line"></div><div class="line"></div><div class="line"></div></div></div>`
          : `<div class="grid"><div class="panel"><div class="cards"><div class="card"><div class="metric">98%</div><div class="tiny">workflow clarity</div></div><div class="card"><div class="metric">24</div><div class="tiny">captures today</div></div><div class="card"><div class="metric">06</div><div class="tiny">saved clips</div></div><div class="card"><div class="metric">0</div><div class="tiny">cloud uploads</div></div></div><div class="bars"><span class="bar"></span><span class="bar"></span><span class="bar"></span></div></div><div class="chart"><span class="col" style="height:54%"></span><span class="col" style="height:82%"></span><span class="col" style="height:68%"></span><span class="col" style="height:92%"></span><span class="col" style="height:73%"></span></div></div>`}
      </div>
    </div>
  </div>
</body>
</html>`;
}

async function captureHtmlImage(html, size = FIXTURE_SIZE) {
  const tempDir = await fs.mkdtemp(path.join(app.getPath("temp"), "shottap-docs-html-"));
  const htmlPath = path.join(tempDir, "capture.html");
  await fs.writeFile(htmlPath, html, "utf8");

  const window = new BrowserWindow({
    width: size.width,
    height: size.height,
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
  });

  try {
    await window.loadFile(htmlPath);
    await wait(220);
    return await window.webContents.capturePage();
  } finally {
    window.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function writeImage(fileName, image) {
  await fs.writeFile(path.join(outputDir, fileName), image.toPNG());
}

async function readImageDataUrl(filePath) {
  const extension = path.extname(filePath).toLowerCase() === ".jpg" ? "jpeg" : "png";
  return `data:image/${extension};base64,${(await fs.readFile(filePath)).toString("base64")}`;
}

async function presentationBackdropStyle() {
  const backdrop = path.join(outputDir, "github-media-backdrop.png");

  try {
    const dataUrl = await readImageDataUrl(backdrop);
    return `background: #08111d url("${dataUrl}") center / cover no-repeat;`;
  } catch {
    return `background:
      radial-gradient(circle at 50% 55%, rgba(57, 110, 145, .34), transparent 36%),
      linear-gradient(135deg, #06101c 0%, #132230 52%, #050a12 100%);`;
  }
}

function presentationPreset(fileName, rawSize) {
  const presets = {
    "hero-dark.png": { width: 1660, top: 172 },
    "capture-library.png": { width: 1620, top: 188 },
    "inspector.png": { width: 1620, top: 188 },
    "editor.png": { width: 1620, top: 188 },
    "recording.png": { width: 1620, top: 188 },
    "hotkeys.png": { width: 1620, top: 188 },
    "light-mode.png": { width: 1620, top: 188 },
    "area-selection.png": { width: 1640, top: 168 }
  };

  const preset = presets[fileName] || { width: 1620, top: 188 };
  const height = Math.round((preset.width * rawSize.height) / rawSize.width);
  return { ...preset, height };
}

async function writePresentedScreenshot(fileName, image) {
  const rawSize = image.getSize();
  const rawData = `data:image/png;base64,${image.toPNG().toString("base64")}`;
  const preset = presentationPreset(fileName, rawSize);
  const backdrop = await presentationBackdropStyle();
  const frameRadius = fileName === "area-selection.png" ? 24 : 22;
  const imageRadius = frameRadius - 6;
  const rendered = await captureHtmlImage(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    * { box-sizing: border-box; }
    html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; }
    body {
      ${backdrop}
      display: grid;
      place-items: center;
      font-family: "Segoe UI", Arial, sans-serif;
    }
    .stage {
      position: relative;
      width: 100vw;
      height: 100vh;
      overflow: hidden;
    }
    .stage::before {
      content: "";
      position: absolute;
      inset: 0;
      background:
        radial-gradient(circle at 50% 47%, rgba(255,255,255,.12), transparent 34%),
        radial-gradient(circle at 50% 104%, rgba(14,165,233,.18), transparent 38%),
        linear-gradient(180deg, rgba(0,0,0,.18), rgba(0,0,0,.44));
      pointer-events: none;
    }
    .frame {
      position: absolute;
      left: 50%;
      top: ${preset.top}px;
      width: ${preset.width}px;
      height: ${preset.height}px;
      transform: translateX(-50%);
      padding: 8px;
      border-radius: ${frameRadius}px;
      background: linear-gradient(135deg, rgba(255,255,255,.28), rgba(255,255,255,.08));
      border: 1px solid rgba(255,255,255,.22);
      box-shadow:
        0 54px 110px rgba(0,0,0,.54),
        0 18px 42px rgba(0,0,0,.36),
        inset 0 1px 0 rgba(255,255,255,.26);
    }
    .frame::after {
      content: "";
      position: absolute;
      inset: 8px;
      border-radius: ${imageRadius}px;
      box-shadow: inset 0 0 0 1px rgba(255,255,255,.08);
      pointer-events: none;
    }
    img {
      display: block;
      width: 100%;
      height: 100%;
      object-fit: cover;
      border-radius: ${imageRadius}px;
    }
  </style>
</head>
<body>
  <main class="stage">
    <div class="frame"><img src="${rawData}" alt="" /></div>
  </main>
</body>
</html>`, PRESENTATION_SIZE);

  await writeImage(fileName, rendered);
}

async function captureMain(window, fileName) {
  await wait(450);
  await writePresentedScreenshot(fileName, await window.webContents.capturePage());
}

async function setMainSize(window) {
  window.setSize(MAIN_SIZE.width, MAIN_SIZE.height);
  window.center();
  window.show();
  window.focus();
  await wait(300);
}

async function syncRenderer(window, library, sessionItemIds = []) {
  const items = library.list();
  await window.webContents.executeJavaScript(`(() => {
    window.__shottapTest.state.items = ${JSON.stringify(items)};
    window.__shottapTest.state.sessionItemIds = ${JSON.stringify(sessionItemIds)};
    window.__shottapTest.state.lastCopy = ${JSON.stringify({ at: Date.now(), count: Math.min(items.length, 4), kind: "docs" })};
  })()`);
}

async function navigate(window, view) {
  await window.webContents.executeJavaScript(`window.__shottapTest.navigate(${JSON.stringify(view)})`);
  await wait(350);
}

async function setTheme(window, settings, windows, theme) {
  nativeTheme.themeSource = theme;
  await settings.update({ appearance: { theme } });
  windows.setMainBackground(theme);
  await window.webContents.executeJavaScript(`window.__shottapTest.state.settings.appearance.theme = ${JSON.stringify(theme)}`);
  await wait(300);
}

async function seedLibrary({ capture, library }) {
  const fixtures = [
    ["demo-dashboard.png", "Dashboard", "Capture the exact metric you need", "#2f7bf6", "A neutral dashboard-style fixture with charts, cards, and safe synthetic content.", "fullscreen"],
    ["demo-editor.png", "Editor", "Save the code review note", "#12a071", "A generic development workspace fixture with no private repository names or real files.", "area"],
    ["demo-report.png", "Report", "Keep a visual record", "#7255e0", "A simple report-style fixture for capture library thumbnails and inspector examples.", "fullscreen"],
    ["demo-planning.png", "Planning", "Grab the next step", "#e0a12c", "A clean planning-board style sample used only for public documentation screenshots.", "area"],
    ["demo-light-page.png", "Web page", "Share a page state quickly", "#e0484d", "A synthetic web page fixture that makes the README screenshots feel realistic.", "fullscreen"],
    ["demo-desktop.png", "Desktop", "Capture without the clutter", "#0ea5e9", "A dedicated safe desktop-style image used to avoid exposing personal content.", "area"]
  ];

  const items = [];

  for (const [name, kind, title, accent, body, source] of fixtures) {
    const image = await captureHtmlImage(fixtureHtml(kind, title, accent, body));
    const size = image.getSize();
    const item = await library.addImage({
      buffer: image.toPNG(),
      thumbnail: capture.makeThumbnail(image),
      width: size.width,
      height: size.height,
      source,
      name
    });
    items.push(item);
  }

  library.setFavorite(items[1].id, true);
  library.setFavorite(items[3].id, true);
  await library.flush();

  return items;
}

async function drawEditorMarkup(window, itemId) {
  const rect = await window.webContents.executeJavaScript(`(async () => {
    const item = window.__shottapTest.state.items.find((entry) => entry.id === ${JSON.stringify(itemId)});
    await window.SCEditor.open(item);
    const canvas = document.getElementById("editorCanvas");
    const color = document.getElementById("editorColor");
    const size = document.getElementById("editorSize");
    color.value = "#2f7bf6";
    size.value = "14";
    size.dispatchEvent(new Event("input", { bubbles: true }));
    const rect = canvas.getBoundingClientRect();
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  })()`);

  const send = (type, x, y) =>
    window.webContents.sendInputEvent({
      type,
      x: Math.round(rect.left + x),
      y: Math.round(rect.top + y),
      button: "left",
      clickCount: 1,
      buttons: type === "mouseUp" ? 0 : 1
    });

  send("mouseDown", rect.width * 0.2, rect.height * 0.26);
  await wait(80);
  send("mouseMove", rect.width * 0.36, rect.height * 0.32);
  await wait(80);
  send("mouseMove", rect.width * 0.52, rect.height * 0.28);
  await wait(80);
  send("mouseUp", rect.width * 0.52, rect.height * 0.28);

  await wait(120);
  send("mouseDown", rect.width * 0.62, rect.height * 0.62);
  await wait(80);
  send("mouseMove", rect.width * 0.78, rect.height * 0.72);
  await wait(80);
  send("mouseUp", rect.width * 0.78, rect.height * 0.72);
  await wait(500);
}

async function captureAreaSelection({ capture, windows }) {
  const display = screen.getPrimaryDisplay();
  const background = await captureHtmlImage(
    fixtureHtml("Desktop", "Select only what matters", "#2f7bf6", "This full-screen synthetic desktop is used only for the public area-selection screenshot."),
    { width: display.bounds.width, height: display.bounds.height }
  );
  const demo = new BrowserWindow({
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
    frame: false,
    show: false,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    backgroundColor: "#eef3f8",
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
  });

  try {
    await demo.loadURL(dataUrl(fixtureHtml("Desktop", "Select only what matters", "#2f7bf6", "This full-screen synthetic desktop is used only for the public area-selection screenshot.")));
    demo.setAlwaysOnTop(true, "floating");
    demo.show();
    demo.focus();
    await wait(350);

    const pending = windows.requestSelection("screenshot");
    const [overlay] = await waitFor("selection overlay", () => {
      const found = BrowserWindow.getAllWindows().filter((entry) => entry.webContents.getURL().includes("selection.html"));
      return found.length ? found : null;
    });

    await waitFor("overlay ready", () =>
      overlay.webContents.executeJavaScript("document.body.dataset.ready === 'true'")
    );

    const send = (type, x, y) =>
      overlay.webContents.sendInputEvent({
        type,
        x,
        y,
        button: "left",
        clickCount: 1,
        buttons: type === "mouseUp" ? 0 : 1
      });

    const from = { x: Math.round(display.bounds.width * 0.2), y: Math.round(display.bounds.height * 0.2) };
    const to = { x: Math.round(display.bounds.width * 0.74), y: Math.round(display.bounds.height * 0.68) };

    send("mouseDown", from.x, from.y);
    await wait(120);
    for (let index = 1; index <= 8; index += 1) {
      send("mouseMove", Math.round(from.x + ((to.x - from.x) * index) / 8), Math.round(from.y + ((to.y - from.y) * index) / 8));
      await wait(50);
    }
    await wait(300);

    const overlayImage = await overlay.webContents.capturePage();
    const backgroundData = `data:image/png;base64,${background.toPNG().toString("base64")}`;
    const overlayData = `data:image/png;base64,${overlayImage.toPNG().toString("base64")}`;
    const composite = await captureHtmlImage(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: #eef3f8; }
    img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: fill; }
  </style>
</head>
<body>
  <img src="${backgroundData}" alt="" />
  <img src="${overlayData}" alt="" />
</body>
</html>`, { width: display.bounds.width, height: display.bounds.height });

    await writePresentedScreenshot("area-selection.png", composite);
    send("mouseUp", to.x, to.y);
    await pending.catch(() => null);
  } finally {
    windows.closeSelectionWindows();
    if (!demo.isDestroyed()) {
      demo.close();
    }
  }
}

async function captureRecordingState({ recording, settings, windows }, mainWindow) {
  const display = screen.getPrimaryDisplay();
  const demo = new BrowserWindow({
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
    frame: false,
    show: false,
    skipTaskbar: true,
    backgroundColor: "#101826",
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
  });

  try {
    await demo.loadURL(dataUrl(fixtureHtml("Recording", "Safe recording source", "#12a071", "ShotTap is recording this synthetic full-screen fixture, not the developer desktop.")));
    demo.setAlwaysOnTop(true, "floating");
    demo.show();
    demo.focus();
    await wait(350);

    const preferences = { ...settings.get().preferences, recordSystemAudio: false, recordMicrophone: false };
    const result = await recording.start({ mode: "fullscreen", preferences });

    if (!result.ok) {
      throw new Error(result.message || "Recording did not start.");
    }

    await waitFor("recording state", () => recording.snapshot().state === "recording", { timeout: 20000 });
    windows.revealMain({ focus: true });
    mainWindow.moveTop();
    await wait(900);
    await captureMain(mainWindow, "recording.png");
  } finally {
    if (recording.isRecording()) {
      recording.requestStop();
      await waitFor("recording stop", () => recording.snapshot().state === "idle", { timeout: 25000 }).catch(() => null);
    }

    if (!demo.isDestroyed()) {
      demo.close();
    }
  }
}

async function writeSocialPreview() {
  const mark = path.join(__dirname, "..", "src", "renderer", "assets", "shottap-mark.png");
  const markData = await readImageDataUrl(mark);
  const backdrop = await presentationBackdropStyle();
  const image = await captureHtmlImage(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    body {
      margin: 0;
      width: 100vw;
      height: 100vh;
      display: grid;
      place-items: center;
      color: white;
      ${backdrop}
      font-family: "Segoe UI", Arial, sans-serif;
    }
    body::before {
      content: "";
      position: fixed;
      inset: 0;
      background:
        radial-gradient(circle at 22% 34%, rgba(29,165,255,.28), transparent 28%),
        linear-gradient(90deg, rgba(0,0,0,.42), rgba(0,0,0,.08));
    }
    .wrap { display: flex; align-items: center; gap: 42px; }
    .wrap { position: relative; z-index: 1; }
    img { width: 196px; height: 196px; object-fit: contain; filter: drop-shadow(0 28px 42px rgba(0,0,0,.35)); }
    h1 { margin: 0; font-size: 96px; line-height: 1; letter-spacing: 0; }
    p { margin: 22px 0 0; font-size: 34px; color: #b9c8dc; }
    span { color: #1da5ff; }
  </style>
</head>
<body>
  <div class="wrap">
    <img src="${markData}" alt="" />
    <div>
      <h1>Shot<span>Tap</span></h1>
      <p>Keyboard-first screen capture for Windows</p>
    </div>
  </div>
</body>
</html>`, SOCIAL_SIZE);

  await writeImage("github-social-preview.png", image);
}

async function copyLogoAssets() {
  const assets = path.join(__dirname, "..", "src", "renderer", "assets");
  await fs.copyFile(path.join(assets, "shottap-mark.png"), path.join(outputDir, "shottap-icon.png"));
  await fs.copyFile(path.join(assets, "shottap-wordmark-light-ui.png"), path.join(outputDir, "shottap-logo-light.png"));
  await fs.copyFile(path.join(assets, "shottap-wordmark-dark-ui.png"), path.join(outputDir, "shottap-logo-dark.png"));
}

async function run(deps) {
  const { capture, library, recording, settings, windows } = deps;
  outputDir = process.env.SHOTTAP_DOCS_SCREENSHOTS_OUT || path.join(__dirname, "..", "docs", "images");
  await fs.mkdir(outputDir, { recursive: true });

  const mainWindow = windows.getMainWindow();

  if (mainWindow.webContents.isLoading()) {
    await new Promise((resolve) => mainWindow.webContents.once("did-finish-load", resolve));
  }

  await waitFor("renderer boot", () =>
    mainWindow.webContents.executeJavaScript("document.body.dataset.ready === 'true'")
  );

  await setMainSize(mainWindow);
  const seeded = await seedLibrary({ capture, library });
  await syncRenderer(mainWindow, library, seeded.slice(0, 4).map((item) => item.id));

  await setTheme(mainWindow, settings, windows, "dark");
  await navigate(mainWindow, "captures");
  await captureMain(mainWindow, "hero-dark.png");

  await mainWindow.webContents.executeJavaScript("document.querySelector('[data-layout=\"list\"]').click()");
  await wait(250);
  await captureMain(mainWindow, "capture-library.png");

  await mainWindow.webContents.executeJavaScript(`(() => {
    window.__shottapTest.navigate("captures");
    window.__shottapTest.selectItem(${JSON.stringify(seeded[0].id)});
  })()`);
  await wait(450);
  await captureMain(mainWindow, "inspector.png");

  await navigate(mainWindow, "editor");
  await drawEditorMarkup(mainWindow, seeded[1].id);
  await captureMain(mainWindow, "editor.png");
  await mainWindow.webContents.executeJavaScript("window.SCEditor.close()");

  await captureRecordingState({ recording, settings, windows }, mainWindow);
  await wait(4300);
  await mainWindow.webContents.executeJavaScript(`(() => {
    window.__shottapTest.state.selectedId = null;
    document.getElementById("toastHost").innerHTML = "";
  })()`);

  await setTheme(mainWindow, settings, windows, "dark");
  await navigate(mainWindow, "hotkeys");
  await captureMain(mainWindow, "hotkeys.png");

  await setTheme(mainWindow, settings, windows, "light");
  await navigate(mainWindow, "captures");
  await mainWindow.webContents.executeJavaScript(`window.__shottapTest.state.selectedId = null`);
  await mainWindow.webContents.executeJavaScript("document.querySelector('[data-layout=\"grid\"]').click()");
  await wait(250);
  await captureMain(mainWindow, "light-mode.png");

  await captureAreaSelection({ capture, windows });
  await writeSocialPreview();
  await copyLogoAssets();

  await library.flush();
  console.log(`Documentation screenshots written to ${outputDir}`);
  app.exit(0);
}

module.exports = { run };
