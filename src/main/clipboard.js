// Clipboard integration.
//
// Two paths, chosen by what has to land on the clipboard:
//
//   * A single bitmap goes straight through Electron's native API. Nothing to
//     spawn, nothing to clean up, and it is fast enough to run inside the
//     capture itself.
//   * A multi-file drop (CF_HDROP) has no Electron API at all, so it still goes
//     through Windows. What changed is that it no longer pays for a new
//     powershell.exe on every copy: one STA helper starts when the app boots,
//     keeps System.Windows.Forms loaded, and answers newline-delimited JSON
//     requests on stdin. Process start plus assembly load was the whole reason
//     Copy All took a second or more; warm, a copy is a pipe write and a
//     clipboard call.
//
// If the helper cannot start or stops answering, each copy falls back to the
// old one-shot invocation so a copy never simply fails.

const { clipboard, nativeImage } = require("electron");
const { execFile, spawn } = require("child_process");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");

const REQUEST_TIMEOUT_MS = 10000;
const MAX_CONSECUTIVE_SPAWN_FAILURES = 3;

const POWERSHELL_ARGS = ["-Sta", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand"];

let worker = null;
let nextRequestId = 1;
let spawnFailures = 0;

function copyImageFile(filePath) {
  const image = nativeImage.createFromPath(filePath);

  if (image.isEmpty()) {
    return false;
  }

  clipboard.writeImage(image);

  return true;
}

function copyImage(image) {
  if (!image || image.isEmpty()) {
    return false;
  }

  clipboard.writeImage(image);

  return true;
}

function clear() {
  clipboard.clear();

  return true;
}

function fileUrl(filePath) {
  return pathToFileURL(filePath).href;
}

function buildClipboardHtml(imagePaths) {
  const fragment = imagePaths
    .map((filePath, index) => `<img alt="Capture ${index + 1}" src="${fileUrl(filePath)}" style="display:block;max-width:100%;height:auto;margin:0 0 12px 0;" />`)
    .join("");
  const before = "<!DOCTYPE html><html><body><!--StartFragment-->";
  const after = "<!--EndFragment--></body></html>";
  const html = `${before}${fragment}${after}`;
  const headerTemplate =
    "Version:0.9\r\n" +
    "StartHTML:0000000000\r\n" +
    "EndHTML:0000000000\r\n" +
    "StartFragment:0000000000\r\n" +
    "EndFragment:0000000000\r\n";
  const startHtml = Buffer.byteLength(headerTemplate, "utf8");
  const startFragment = startHtml + Buffer.byteLength(before, "utf8");
  const endFragment = startFragment + Buffer.byteLength(fragment, "utf8");
  const endHtml = startHtml + Buffer.byteLength(html, "utf8");

  return (
    headerTemplate
      .replace("StartHTML:0000000000", `StartHTML:${String(startHtml).padStart(10, "0")}`)
      .replace("EndHTML:0000000000", `EndHTML:${String(endHtml).padStart(10, "0")}`)
      .replace("StartFragment:0000000000", `StartFragment:${String(startFragment).padStart(10, "0")}`)
      .replace("EndFragment:0000000000", `EndFragment:${String(endFragment).padStart(10, "0")}`) + html
  );
}

// ---------------------------------------------------------------------------
// PowerShell side.
//
// The bitmap is read into memory before it becomes a Bitmap: Image.FromFile
// holds the file open for the lifetime of the object, which in a long-lived
// helper would keep every copied screenshot locked against trashing.
// ---------------------------------------------------------------------------
const PS_PRELUDE = [
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  "Add-Type -AssemblyName System.Windows.Forms",
  "Add-Type -AssemblyName System.Drawing",
  "",
  "function Set-ClipboardPayload($request) {",
  "  $data = New-Object System.Windows.Forms.DataObject",
  "",
  "  if ($request.files) {",
  "    $files = New-Object System.Collections.Specialized.StringCollection",
  "    foreach ($file in @($request.files)) {",
  "      if ($file) { [void]$files.Add([string]$file) }",
  "    }",
  "    if ($files.Count -gt 0) { $data.SetFileDropList($files) }",
  "  }",
  "",
  "  if ($request.text) {",
  "    $data.SetText([string]$request.text, [System.Windows.Forms.TextDataFormat]::UnicodeText)",
  "  }",
  "",
  "  if ($request.html) {",
  "    $data.SetData([System.Windows.Forms.DataFormats]::Html, [string]$request.html)",
  "  }",
  "",
  "  function New-CompositeBitmap($paths) {",
  "    $loaded = New-Object System.Collections.Generic.List[object]",
  "    $graphics = $null",
  "    $borderPen = $null",
  "",
  "    try {",
  "      foreach ($path in @($paths)) {",
  "        if (-not $path) { continue }",
  "        $bytes = [System.IO.File]::ReadAllBytes([string]$path)",
  "        $stream = New-Object System.IO.MemoryStream(,$bytes)",
  "        $bitmap = New-Object System.Drawing.Bitmap($stream)",
  "        $loaded.Add([pscustomobject]@{ Bitmap = $bitmap; Stream = $stream })",
  "      }",
  "",
  "      if ($loaded.Count -eq 0) { return $null }",
  "",
  "      $count = $loaded.Count",
  "      $columns = 1",
  "      if ($count -gt 120) { $columns = 6 }",
  "      elseif ($count -gt 60) { $columns = 5 }",
  "      elseif ($count -gt 30) { $columns = 4 }",
  "      elseif ($count -gt 12) { $columns = 3 }",
  "      elseif ($count -gt 6) { $columns = 2 }",
  "",
  "      $maxCanvasWidth = 2400",
  "      $maxCanvasHeight = 16000",
  "      $maxPixels = 32000000",
  "      $padding = 24",
  "      $gap = 14",
  "      $cellWidth = [Math]::Max(120, [int][Math]::Floor(($maxCanvasWidth - ($padding * 2) - ($gap * ($columns - 1))) / $columns))",
  "",
  "      function Measure-Composite($baseCellWidth) {",
  "        $rowHeights = @{}",
  "        $index = 0",
  "",
  "        foreach ($entry in $loaded) {",
  "          $row = [int][Math]::Floor($index / $columns)",
  "          $scale = [Math]::Min(1.0, $baseCellWidth / [double]$entry.Bitmap.Width)",
  "          $drawWidth = [Math]::Max(1, [int][Math]::Round($entry.Bitmap.Width * $scale))",
  "          $drawHeight = [Math]::Max(1, [int][Math]::Round($entry.Bitmap.Height * $scale))",
  "",
  "          $entry | Add-Member -Force -NotePropertyName DrawWidth -NotePropertyValue $drawWidth",
  "          $entry | Add-Member -Force -NotePropertyName DrawHeight -NotePropertyValue $drawHeight",
  "          $entry | Add-Member -Force -NotePropertyName Row -NotePropertyValue $row",
  "          $entry | Add-Member -Force -NotePropertyName Column -NotePropertyValue ($index % $columns)",
  "",
  "          if (-not $rowHeights.ContainsKey($row)) { $rowHeights[$row] = 0 }",
  "          $rowHeights[$row] = [Math]::Max([int]$rowHeights[$row], $drawHeight)",
  "          $index += 1",
  "        }",
  "",
  "        $rowCount = [int][Math]::Ceiling($loaded.Count / [double]$columns)",
  "        $totalHeight = $padding * 2",
  "",
  "        for ($row = 0; $row -lt $rowCount; $row += 1) {",
  "          $totalHeight += [int]$rowHeights[$row]",
  "        }",
  "",
  "        $totalHeight += $gap * [Math]::Max(0, $rowCount - 1)",
  "",
  "        return [pscustomobject]@{ RowHeights = $rowHeights; RowCount = $rowCount; TotalHeight = $totalHeight }",
  "      }",
  "",
  "      $measure = Measure-Composite $cellWidth",
  "",
  "      if ($measure.TotalHeight -gt $maxCanvasHeight) {",
  "        $available = [Math]::Max(200, $maxCanvasHeight - ($padding * 2) - ($gap * [Math]::Max(0, $measure.RowCount - 1)))",
  "        $content = [Math]::Max(1, $measure.TotalHeight - ($padding * 2) - ($gap * [Math]::Max(0, $measure.RowCount - 1)))",
  "        $cellWidth = [Math]::Max(80, [int][Math]::Floor($cellWidth * ($available / [double]$content)))",
  "        $measure = Measure-Composite $cellWidth",
  "      }",
  "",
  "      $canvasWidth = ($padding * 2) + ($cellWidth * $columns) + ($gap * ($columns - 1))",
  "      $pixels = $canvasWidth * $measure.TotalHeight",
  "",
  "      if ($pixels -gt $maxPixels) {",
  "        $factor = [Math]::Sqrt($maxPixels / [double]$pixels)",
  "        $cellWidth = [Math]::Max(80, [int][Math]::Floor($cellWidth * $factor))",
  "        $measure = Measure-Composite $cellWidth",
  "        $canvasWidth = ($padding * 2) + ($cellWidth * $columns) + ($gap * ($columns - 1))",
  "      }",
  "",
  "      $canvas = New-Object System.Drawing.Bitmap($canvasWidth, $measure.TotalHeight)",
  "      $graphics = [System.Drawing.Graphics]::FromImage($canvas)",
  "      $graphics.Clear([System.Drawing.Color]::FromArgb(248, 250, 252))",
  "      $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic",
  "      $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality",
  "      $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality",
  "",
  "      $borderPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(203, 213, 225), 1)",
  "      $rowOffsets = @{}",
  "      $rowY = $padding",
  "",
  "      for ($row = 0; $row -lt $measure.RowCount; $row += 1) {",
  "        $rowOffsets[$row] = $rowY",
  "        $rowY += [int]$measure.RowHeights[$row] + $gap",
  "      }",
  "",
  "      foreach ($entry in $loaded) {",
  "        $cellX = $padding + ($entry.Column * ($cellWidth + $gap))",
  "        $x = $cellX + [int][Math]::Floor(($cellWidth - $entry.DrawWidth) / 2)",
  "        $y = [int]$rowOffsets[$entry.Row]",
  "        $rect = New-Object System.Drawing.Rectangle($x, $y, $entry.DrawWidth, $entry.DrawHeight)",
  "        $graphics.FillRectangle([System.Drawing.Brushes]::White, $rect)",
  "        $graphics.DrawImage($entry.Bitmap, $rect)",
  "        $graphics.DrawRectangle($borderPen, $rect)",
  "      }",
  "",
  "      return $canvas",
  "    } finally {",
  "      if ($borderPen) { $borderPen.Dispose() }",
  "      if ($graphics) { $graphics.Dispose() }",
  "      foreach ($entry in $loaded) {",
  "        if ($entry.Bitmap) { $entry.Bitmap.Dispose() }",
  "        if ($entry.Stream) { $entry.Stream.Dispose() }",
  "      }",
  "    }",
  "  }",
  "",
  "  $bitmap = $null",
  "  $stream = $null",
  "",
  "  try {",
  "    if ($request.compositeImages -and @($request.compositeImages).Count -gt 1) {",
  "      try {",
  "        $bitmap = New-CompositeBitmap @($request.compositeImages)",
  "      } catch {",
  "        $bitmap = $null",
  "      }",
  "    }",
  "",
  "    if ((-not $bitmap) -and $request.image) {",
  "      $bytes = [System.IO.File]::ReadAllBytes([string]$request.image)",
  "      $stream = New-Object System.IO.MemoryStream(,$bytes)",
  "      $bitmap = New-Object System.Drawing.Bitmap($stream)",
  "    }",
  "",
  "    if ($bitmap) {",
  "      $data.SetImage($bitmap)",
  "    }",
  "",
  "    # SetDataObject renders every flavour before it returns, so the bitmap",
  "    # can be released as soon as it comes back. The retries matter: another",
  "    # app holding the clipboard open (a clipboard manager ingesting the last",
  "    # copy) makes the first attempts fail outright.",
  "    [System.Windows.Forms.Clipboard]::SetDataObject($data, $true, 10, 50)",
  "  } finally {",
  "    if ($bitmap) { $bitmap.Dispose() }",
  "    if ($stream) { $stream.Dispose() }",
  "  }",
  "}",
  "",
  "# Runs every call the real copy makes except the clipboard write itself, so",
  "# the first copy of the session is not the one paying to JIT all of it.",
  "function Initialize-ClipboardPayload {",
  "  $data = New-Object System.Windows.Forms.DataObject",
  "  $files = New-Object System.Collections.Specialized.StringCollection",
  "  [void]$files.Add((Get-Location).Path)",
  "  $data.SetFileDropList($files)",
  "  $data.SetText('warm', [System.Windows.Forms.TextDataFormat]::UnicodeText)",
  "  $data.SetData([System.Windows.Forms.DataFormats]::Html, 'warm')",
  "",
  "  $seed = New-Object System.Drawing.Bitmap(2, 2)",
  "  $buffer = New-Object System.IO.MemoryStream",
  "",
  "  try {",
  "    $seed.Save($buffer, [System.Drawing.Imaging.ImageFormat]::Png)",
  "    $decoded = New-Object System.Drawing.Bitmap((New-Object System.IO.MemoryStream(,$buffer.ToArray())))",
  "    $data.SetImage($decoded)",
  "    $decoded.Dispose()",
  "  } finally {",
  "    $seed.Dispose()",
  "    $buffer.Dispose()",
  "  }",
  "}",
  ""
].join("\n");

// Whichever process last wrote the clipboard owns it, and Windows expects that
// owner to answer window messages — the next app to write sends the owner a
// WM_DESTROYCLIPBOARD and waits on the reply. A helper parked in a blocking
// stdin read never answers, which cost the *app's own* next capture a five
// second stall before its bitmap reached the clipboard. So the read is async
// and the wait pumps the message queue.
const WORKER_SCRIPT = [
  PS_PRELUDE,
  "$stdin = [Console]::OpenStandardInput()",
  "$writer = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), (New-Object System.Text.UTF8Encoding($false)))",
  "$writer.AutoFlush = $true",
  "",
  "$decoder = (New-Object System.Text.UTF8Encoding($false)).GetDecoder()",
  "$bytes = New-Object byte[] 65536",
  "$chars = New-Object char[] 65536",
  "$pending = New-Object System.Text.StringBuilder",
  "$read = $null",
  "",
  "function Invoke-Request($line) {",
  "  $id = ''",
  "",
  "  try {",
  "    $request = $line | ConvertFrom-Json",
  "    $id = [string]$request.id",
  "",
  "    switch ([string]$request.op) {",
  "      'copy'  { Set-ClipboardPayload $request }",
  "      'warm'  { Initialize-ClipboardPayload }",
  "      'clear' { [System.Windows.Forms.Clipboard]::Clear() }",
  "      default { }",
  "    }",
  "",
  "    $writer.WriteLine((ConvertTo-Json -Compress @{ id = $id; ok = $true }))",
  "  } catch {",
  "    $writer.WriteLine((ConvertTo-Json -Compress @{ id = $id; ok = $false; error = $_.Exception.Message }))",
  "  }",
  "}",
  "",
  "while ($true) {",
  "  if ($null -eq $read) { $read = $stdin.ReadAsync($bytes, 0, $bytes.Length) }",
  "",
  "  while (-not $read.Wait(15)) {",
  "    [System.Windows.Forms.Application]::DoEvents()",
  "  }",
  "",
  "  $count = $read.Result",
  "  $read = $null",
  "  if ($count -le 0) { break }",
  "",
  "  $charCount = $decoder.GetChars($bytes, 0, $count, $chars, 0)",
  "  [void]$pending.Append($chars, 0, $charCount)",
  "",
  "  while ($true) {",
  "    $text = $pending.ToString()",
  "    $index = $text.IndexOf(\"`n\")",
  "    if ($index -lt 0) { break }",
  "    $line = $text.Substring(0, $index).Trim()",
  "    [void]$pending.Remove(0, $index + 1)",
  "    if ($line -ne '') { Invoke-Request $line }",
  "  }",
  "",
  "  # Anything the clipboard write queued up is answered before going idle.",
  "  [System.Windows.Forms.Application]::DoEvents()",
  "}",
  ""
].join("\n");

function encodeScript(script) {
  return Buffer.from(script, "utf16le").toString("base64");
}

function settle(entry, error) {
  clearTimeout(entry.timer);

  if (error) {
    entry.reject(error);
  } else {
    entry.resolve();
  }
}

function retireWorker(state, reason) {
  if (state.retired) {
    return;
  }

  state.retired = true;

  for (const entry of state.pending.values()) {
    settle(entry, new Error(reason));
  }

  state.pending.clear();

  if (worker === state) {
    worker = null;
  }

  try {
    state.child.kill();
  } catch (_error) {
    // Already gone.
  }
}

function handleLine(state, line) {
  const trimmed = line.trim();

  if (!trimmed) {
    return;
  }

  let response;

  try {
    response = JSON.parse(trimmed);
  } catch (_error) {
    // Anything that is not one of our replies (a stray warning) is ignored
    // rather than being matched against a pending request.
    return;
  }

  const id = String(response.id);
  const entry = state.pending.get(id);

  if (!entry) {
    return;
  }

  state.pending.delete(id);

  if (response.ok) {
    settle(entry, null);

    return;
  }

  // The helper ran and Windows refused. Retrying the whole thing in a fresh
  // powershell would hit the same refusal a second and a half later, so this
  // failure is reported rather than fallen back on.
  const error = new Error(response.error || "Clipboard helper failed.");
  error.reachedWindows = true;
  settle(entry, error);
}

function startWorker() {
  let child;

  try {
    child = spawn("powershell.exe", [...POWERSHELL_ARGS, encodeScript(WORKER_SCRIPT)], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
  } catch (_error) {
    spawnFailures += 1;

    return null;
  }

  const state = { child, pending: new Map(), buffer: "", retired: false };

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    state.buffer += chunk;

    let index = state.buffer.indexOf("\n");

    while (index !== -1) {
      const line = state.buffer.slice(0, index);
      state.buffer = state.buffer.slice(index + 1);
      handleLine(state, line);
      index = state.buffer.indexOf("\n");
    }
  });

  // Left unread, a helper that writes to stderr would eventually block on a
  // full pipe.
  child.stderr.resume();

  child.on("error", () => {
    spawnFailures += 1;
    retireWorker(state, "Clipboard helper could not start.");
  });

  child.on("exit", () => {
    retireWorker(state, "Clipboard helper stopped.");
  });

  child.stdin.on("error", () => {
    retireWorker(state, "Clipboard helper stopped.");
  });

  return state;
}

function ensureWorker() {
  if (worker && !worker.retired) {
    return worker;
  }

  if (process.platform !== "win32" || spawnFailures >= MAX_CONSECUTIVE_SPAWN_FAILURES) {
    return null;
  }

  worker = startWorker();

  return worker;
}

function request(payload) {
  const state = ensureWorker();

  if (!state) {
    return Promise.reject(new Error("Clipboard helper unavailable."));
  }

  const id = String(nextRequestId++);

  return new Promise((resolve, reject) => {
    const entry = {
      resolve,
      reject,
      timer: setTimeout(() => {
        state.pending.delete(id);
        // A helper that has stopped answering will not start again on its own;
        // the next copy gets a fresh one.
        retireWorker(state, "Clipboard helper timed out.");
        reject(new Error("Clipboard helper timed out."));
      }, REQUEST_TIMEOUT_MS)
    };

    state.pending.set(id, entry);

    try {
      state.child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`);
    } catch (error) {
      state.pending.delete(id);
      clearTimeout(entry.timer);
      reject(error);
    }
  });
}

// The pre-warm: PowerShell start-up, the two Add-Type calls and the JIT of the
// copy path together are roughly a second, and this is what moves all of it off
// the first copy the user makes. The clipboard itself is never written to here —
// warming must not disturb whatever the user already had on it.
function warmUp() {
  if (!ensureWorker()) {
    return Promise.resolve(false);
  }

  return request({ op: "warm" }).then(
    () => {
      spawnFailures = 0;

      return true;
    },
    () => false
  );
}

function shutdown() {
  if (worker) {
    retireWorker(worker, "Clipboard helper stopped.");
  }
}

// Fallback for the rare case where the helper is unavailable: one powershell
// per copy, reading the same payload from a temp file so no path or HTML can
// break the quoting.
async function copyViaOneShot(payload) {
  const payloadPath = path.join(os.tmpdir(), `shottap-clipboard-${Date.now()}-${process.pid}.json`);
  await fs.writeFile(payloadPath, JSON.stringify(payload), "utf8");

  const script = [
    PS_PRELUDE,
    `$request = Get-Content -LiteralPath '${payloadPath.replace(/'/g, "''")}' -Raw -Encoding UTF8 | ConvertFrom-Json`,
    "Set-ClipboardPayload $request",
    ""
  ].join("\n");

  try {
    await new Promise((resolve, reject) => {
      execFile(
        "powershell.exe",
        [...POWERSHELL_ARGS, encodeScript(script)],
        { windowsHide: true, timeout: 20000 },
        (error, _stdout, stderr) => {
          if (error) {
            reject(new Error(stderr || error.message));
            return;
          }

          resolve();
        }
      );
    });
  } finally {
    await fs.rm(payloadPath, { force: true }).catch(() => {});
  }
}

function buildPayload(filePaths, imagePaths, options = {}) {
  const files = filePaths.filter(Boolean);
  const images = imagePaths.filter(Boolean);
  const useCompositeImage = options.compositeImages && images.length > 1;

  return {
    op: "copy",
    files,
    text: files.join("\r\n"),
    // Explicit Copy All uses a composite bitmap fallback so apps that ignore
    // multi-file clipboard data still receive every image in one paste. The
    // newest bitmap is still sent as a fallback if composition cannot decode an
    // image for any reason.
    image: images.length > 0 ? images[images.length - 1] : null,
    compositeImages: useCompositeImage ? images : null,
    // Only worth offering for a set: with one image the HTML flavour just gives
    // apps that prefer it a file:// <img> where the bitmap would have pasted
    // properly.
    html: images.length > 1 ? buildClipboardHtml(images) : null
  };
}

async function copyFiles(filePaths, imagePaths = [], options = {}) {
  const payload = buildPayload(filePaths, imagePaths, options);

  if (payload.files.length === 0) {
    return { ok: false, message: "Nothing to copy." };
  }

  const count = payload.files.length;
  const message = `Copied ${count} file${count === 1 ? "" : "s"} to the clipboard.`;

  try {
    await request(payload);

    return { ok: true, message };
  } catch (helperError) {
    if (helperError.reachedWindows) {
      return { ok: false, message: `Could not copy files: ${helperError.message}` };
    }

    try {
      await copyViaOneShot(payload);

      return { ok: true, message };
    } catch (error) {
      return { ok: false, message: `Could not copy files: ${error.message || helperError.message}` };
    }
  }
}

module.exports = {
  buildClipboardHtml,
  clear,
  copyFiles,
  copyImage,
  copyImageFile,
  shutdown,
  warmUp
};
