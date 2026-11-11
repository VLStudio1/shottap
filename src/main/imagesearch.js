// Reverse image search across the capture library and user-picked folders.
//
// The hash math lives in phash.js (electron-free); this module owns image
// decoding (nativeImage, lazily required so tests can inject fakes), folder
// scanning, the persisted hash cache and search cancellation. Only one search
// runs at a time — starting a new one (or cancel()) supersedes the in-flight
// search, which resolves with { ok: false, superseded: true }.

const { EventEmitter } = require("events");
const fs = require("fs/promises");
const path = require("path");

const { dhash, hamming, similarity } = require("./phash");
const {
  SEARCH_CACHE_MAX,
  SEARCH_EXCLUDED_DIR_NAMES,
  SEARCH_IMAGE_EXTENSIONS,
  SEARCH_MATCH_THRESHOLD,
  SEARCH_MAX_FILE_BYTES,
  SEARCH_MAX_COLLECT,
  SEARCH_MAX_FILES,
  SEARCH_MAX_RESULTS,
  SEARCH_PREVIEW_WIDTH
} = require("../shared/constants");

const CACHE_FILE = "search-cache.json";
const IMAGE_EXTENSIONS = new Set(SEARCH_IMAGE_EXTENSIONS);
const PERSIST_DELAY_MS = 150;
// How often the folder walk reports progress while enumerating.
const SCAN_REPORT_EVERY = 1000;

const emitter = new EventEmitter();

let cacheFile = "";
let cache = new Map(); // absolute path -> { hash, size, mtimeMs }
let writeQueue = Promise.resolve();
let writeTimer = null;
let generation = 0;
let io = null;
let maxFiles = SEARCH_MAX_FILES;
let cacheMax = SEARCH_CACHE_MAX;

function hashFromImage(image) {
  if (!image || image.isEmpty()) {
    return null;
  }

  // Both dimensions are supplied on purpose: every image is squashed to the
  // same 9x8 grid regardless of aspect ratio, which is what makes hashes
  // comparable.
  const small = image.resize({ width: 9, height: 8, quality: "good" });
  const size = small.getSize();

  return dhash({ width: size.width, height: size.height, data: small.toBitmap() });
}

function defaultIo() {
  return {
    // Every hash goes through the decode farm so query and candidates share
    // one resampling pipeline — mixing pipelines costs a few Hamming bits of
    // systematic divergence on every comparison. nativeImage remains as the
    // fallback when the farm cannot start.
    hashFile: async (filePath) => {
      try {
        const buffer = await fs.readFile(filePath);
        const farmed = await require("./decodepool").hashBuffer(buffer);

        if (farmed) {
          return farmed;
        }
      } catch (_error) {
        // Falls through to nativeImage below.
      }

      return hashFromImage(require("electron").nativeImage.createFromPath(filePath));
    },
    hashBuffer: async (buffer) => {
      const farmed = await require("./decodepool").hashBuffer(buffer);

      if (farmed) {
        return farmed;
      }

      return hashFromImage(require("electron").nativeImage.createFromBuffer(buffer));
    },
    // Parallel decode through the hidden renderers (see decodepool.js).
    // Tests inject their own io without this and get the sequential fallback.
    hashFiles: async (entries, callbacks) => {
      await require("./decodepool").hashFiles(entries, callbacks);
    },
    previewFor: async (filePath) => {
      const farmed = await require("./decodepool").previewFile(filePath);

      if (farmed) {
        return farmed;
      }

      const image = require("electron").nativeImage.createFromPath(filePath);
      if (image.isEmpty()) {
        return null;
      }

      const width = image.getSize().width;
      const small = image.resize({ width: Math.min(SEARCH_PREVIEW_WIDTH, width), quality: "good" });

      return `data:image/jpeg;base64,${small.toJPEG(60).toString("base64")}`;
    }
  };
}

async function init({ userDataDir, io: injectedIo, maxFiles: maxFilesOption, cacheMax: cacheMaxOption } = {}) {
  io = injectedIo || defaultIo();
  cacheFile = userDataDir ? path.join(userDataDir, CACHE_FILE) : "";
  cache = new Map();
  // Not destructured bare: the parameters would shadow the module-level
  // variables and the caps would silently stay at their defaults.
  maxFiles = Number.isInteger(maxFilesOption) && maxFilesOption > 0 ? maxFilesOption : SEARCH_MAX_FILES;
  cacheMax = Number.isInteger(cacheMaxOption) && cacheMaxOption > 0 ? cacheMaxOption : SEARCH_CACHE_MAX;

  if (!cacheFile) {
    return;
  }

  let raw = null;
  try {
    raw = JSON.parse(await fs.readFile(cacheFile, "utf8"));
  } catch (_error) {
    raw = null;
  }

  if (!raw || typeof raw !== "object") {
    return;
  }

  for (const [key, value] of Object.entries(raw.entries || {})) {
    if (typeof value?.hash === "string" && typeof value.size === "number" && typeof value.mtimeMs === "number") {
      cache.set(key, value);
    }
  }
}

function schedulePersist() {
  if (!cacheFile) {
    return;
  }

  if (writeTimer) {
    clearTimeout(writeTimer);
  }

  writeTimer = setTimeout(() => {
    writeTimer = null;
    persist();
  }, PERSIST_DELAY_MS);
}

function persist() {
  // Cap the cache so a one-off scan of a huge folder cannot grow it forever;
  // Map iteration order makes this a drop-the-oldest policy. The cap is far
  // above the per-search decode budget so coverage accumulates across runs.
  while (cache.size > cacheMax) {
    cache.delete(cache.keys().next().value);
  }

  const snapshot = JSON.stringify({ version: 1, entries: Object.fromEntries(cache) }, null, 2);

  writeQueue = writeQueue
    .then(async () => {
      await fs.mkdir(path.dirname(cacheFile), { recursive: true });
      await fs.writeFile(`${cacheFile}.tmp`, snapshot, "utf8");
      await fs.rename(`${cacheFile}.tmp`, cacheFile);
    })
    .catch(() => {
      // Cache writes are best-effort; a stale cache only costs re-hashing.
    });

  return writeQueue;
}

async function flush() {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
    persist();
  }

  await writeQueue;
}

function hasImageExtension(fileName) {
  return IMAGE_EXTENSIONS.has(path.extname(fileName).slice(1).toLowerCase());
}

function samePath(a, b) {
  const left = path.resolve(String(a));
  const right = path.resolve(String(b));

  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

// Whether childPath sits inside rootPath, tolerating drive roots ("C:\"),
// trailing separators and Windows case variance. A naive
// startsWith(resolve(root) + sep) fails for drive roots: "C:\" + "\" is a
// double backslash no real path contains.
function isInside(childPath, rootPath) {
  const fold = (value) => (process.platform === "win32" ? value.toLowerCase() : value);
  const target = fold(path.resolve(String(childPath)));
  const root = fold(path.resolve(String(rootPath)).replace(/[\\/]+$/, ""));

  return target === root || target.startsWith(root + path.sep);
}

// Drive letters are probed with a stat rather than listed through WMI or
// PowerShell: it is dependency-free, and an empty DVD drive simply fails it.
async function listDriveRoots(access = fs.access) {
  const roots = [];

  for (const letter of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
    const root = `${letter}:\\`;

    try {
      await access(root);
      roots.push(root);
    } catch (_error) {
      // No such drive, or no media in it.
    }
  }

  return roots;
}

// Walks the given folders breadth-first, collecting image files within the
// size cap, newest-first. The walk itself is cheap (names + stats) and always
// completes; the decode stage in hashCandidates is where the budget applies.
//
// Read failures are split by meaning: a root the caller explicitly named that
// cannot be read matters to the user, while unreadable sub-directories are
// routine on broad scans (system folders, junctions) and stay silent.
async function collectImageFiles(rootDirectories, { excludeSystemDirs = false, isCancelled } = {}) {
  const files = [];
  const skippedRoots = [];
  let skippedNested = 0;
  const roots = [...rootDirectories];
  const excluded = excludeSystemDirs ? new Set(SEARCH_EXCLUDED_DIR_NAMES) : null;
  const queue = [...roots];
  const seen = new Set();
  // Windows paths are case-insensitive: the same tree reached through a
  // case-variant root spelling must not be walked twice.
  const seenKey = (directory) => (process.platform === "win32" ? directory.toLowerCase() : directory);

  while (queue.length > 0 && files.length < SEARCH_MAX_COLLECT) {
    if (isCancelled && isCancelled()) {
      // Cancelled or superseded: stop enumerating rather than churning the
      // disk for a result nobody is waiting for.
      break;
    }

    const directory = queue.shift();
    const key = seenKey(directory);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (_error) {
      if (roots.some((root) => samePath(root, directory))) {
        skippedRoots.push(directory);
      } else {
        skippedNested += 1;
      }
      continue;
    }

    const imageEntries = [];

    for (const entry of entries) {
      const full = path.join(directory, entry.name);

      // Symlinked directories are skipped: they can loop and reach outside
      // the folder the user actually picked. Whole-computer walks also skip
      // system trees — wallpaper and installer imagery are noise, and several
      // of those directories refuse reads anyway.
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        if (!excluded || !excluded.has(entry.name.toLowerCase())) {
          queue.push(full);
        }
      } else if (entry.isFile() && hasImageExtension(entry.name)) {
        imageEntries.push(entry);
      }
    }

    // Stats run in small chunks: sequential awaited stats made walking a
    // 45k-file folder take seconds; chunked concurrency cuts that to a
    // fraction while keeping the event loop breathing.
    for (let offset = 0; offset < imageEntries.length; offset += 16) {
      const chunk = imageEntries.slice(offset, offset + 16);
      const stats = await Promise.all(
        chunk.map(async (entry) => {
          const full = path.join(directory, entry.name);
          try {
            const stat = await fs.stat(full);
            if (stat.size > 0 && stat.size <= SEARCH_MAX_FILE_BYTES) {
              return { path: full, size: stat.size, mtimeMs: Math.round(stat.mtimeMs) };
            }
          } catch (_error) {
            // The file vanished mid-scan; nothing to keep.
          }
          return null;
        })
      );

      for (const file of stats) {
        if (file) {
          files.push(file);
        }
      }
    }

    if (files.length % SCAN_REPORT_EVERY < entries.length) {
      emitter.emit("progress", { phase: "scan", scanned: files.length, total: 0, matched: -1 });
    }
  }

  const totalFound = files.length;
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);

  return { files, skippedRoots, skippedNested, totalFound };
}

// Stats the library's image files so they hash through the same cache path as
// folder files. Library items carry a ready-made 520px thumbnail; hashing that
// instead of the full capture is dramatically cheaper (a thumbnail decodes in
// a fraction of the memory) and dHash resolution differences are within the
// match threshold.
async function statLibraryCandidates(libraryCandidates, myGeneration) {
  const files = [];

  for (const candidate of libraryCandidates) {
    if (myGeneration !== generation) {
      return null;
    }

    const statTarget = candidate.thumbPath || candidate.path;

    try {
      const stat = await fs.stat(statTarget);
      if (stat.size > 0 && stat.size <= SEARCH_MAX_FILE_BYTES) {
        // The hash is keyed by the hash source's stat, but the result card
        // must show the capture's real size — when hashing from a thumbnail
        // those are different files by an order of magnitude.
        let displaySize = stat.size;

        if (candidate.thumbPath) {
          try {
            const original = await fs.stat(candidate.path);
            displaySize = original.size;
          } catch (_error) {
            // Original missing; the hash-source size is the best available.
          }
        }

        files.push({
          path: candidate.path,
          hashSourcePath: statTarget,
          size: displaySize,
          hashSize: stat.size,
          hashMtimeMs: Math.round(stat.mtimeMs),
          libraryItemId: candidate.id
        });
      }
    } catch (_error) {
      // Indexed but missing on disk (e.g. deleted outside ShotTap), or a
      // dangling thumbnail reference — fall back to nothing for this item.
    }
  }

  return files;
}

// Decoding is the expensive stage, so it runs under a budget: at most
// `maxFiles` images are DECODED per search, while files whose hash is already
// cached are compared for free — repeat searches cover the whole scope and
// each one indexes another newest-first slice. When the io provides a parallel
// hashFiles farm the decodes run across hidden renderers; otherwise (tests,
// fallback) they run one at a time with a yield after each.
async function hashCandidates(candidates, myGeneration) {
  const cancelled = () => myGeneration !== generation;
  const hashed = [];
  const toDecode = [];
  let processed = 0;
  let decoded = 0;
  let budgetExhausted = false;

  for (const candidate of candidates) {
    if (cancelled()) {
      return { superseded: true, hashed: [], processed, budgetExhausted: false };
    }

    const hashSource = candidate.hashSourcePath || candidate.path;
    const hashSize = candidate.hashSize ?? candidate.size;
    const hashMtime = candidate.hashMtimeMs ?? candidate.mtimeMs;
    const cached = cache.get(hashSource);

    if (cached && cached.size === hashSize && cached.mtimeMs === hashMtime) {
      hashed.push({ ...candidate, hash: cached.hash });
      processed += 1;
      emitter.emit("progress", { phase: "hash", scanned: processed, total: candidates.length, matched: -1 });
    } else if (decoded >= maxFiles) {
      // Out of decode budget: examined, but skipped this pass.
      budgetExhausted = true;
      processed += 1;
    } else {
      // `key` identifies the result; `filePath` is what the decode farm reads;
      // the hash* fields carry the cache identity of the hash source.
      toDecode.push({ key: hashSource, filePath: hashSource, candidate, hashSize, hashMtimeMs: hashMtime });
      decoded += 1;
    }
  }

  const pendingByKey = new Map(toDecode.map((entry) => [entry.key, entry]));

  const applyDecoded = (entry, hash) => {
    if (hash) {
      cache.set(entry.key, { hash, size: entry.hashSize, mtimeMs: entry.hashMtimeMs });
      schedulePersist();
      hashed.push({ ...entry.candidate, hash });
    }

    processed += 1;

    // A superseded search's in-flight farm results still land in the cache
    // (the work is done and useful) but must not corrupt the live search's
    // progress display.
    if (!cancelled()) {
      emitter.emit("progress", { phase: "hash", scanned: processed, total: candidates.length, matched: -1 });
    }
  };

  if (toDecode.length > 0 && !cancelled()) {
    let farmed = false;

    if (typeof io.hashFiles === "function") {
      try {
        await io.hashFiles(toDecode, {
          onResult: (key, hash) => {
            const entry = pendingByKey.get(key);
            if (entry) {
              applyDecoded(entry, hash);
            }
          },
          isCancelled: cancelled
        });
        farmed = true;
      } catch (_error) {
        // The decode farm failed mid-flight; fall back to sequential so the
        // search completes instead of erroring out.
      }
    }

    if (!farmed) {
      for (const entry of toDecode) {
        if (cancelled()) {
          break;
        }

        // Entries the farm already hashed landed in the cache; skip those.
        const cached = cache.get(entry.key);
        if (cached && cached.size === entry.hashSize && cached.mtimeMs === entry.hashMtimeMs) {
          continue;
        }

        let hash = null;
        try {
          hash = await io.hashFile(entry.key);
        } catch (_error) {
          hash = null;
        }

        applyDecoded(entry, hash);
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
  }

  if (cancelled()) {
    return { superseded: true, hashed: [], processed, budgetExhausted: false };
  }

  return { hashed, processed, budgetExhausted };
}

async function runSearch({ queryHash, roots, excludeSystemDirs, excludeDirs = [], libraryCandidates, excludePath }) {
  const myGeneration = ++generation;
  const cancelled = () => myGeneration !== generation;
  const excluded = Array.isArray(excludePath) ? excludePath.filter(Boolean) : excludePath ? [excludePath] : [];

  emitter.emit("progress", { phase: "scan", scanned: 0, total: 0, matched: -1 });

  const folderScan = await collectImageFiles(roots, {
    excludeSystemDirs: Boolean(excludeSystemDirs),
    isCancelled: cancelled
  });
  const libraryFiles = await statLibraryCandidates(libraryCandidates, myGeneration);
  if (libraryFiles === null) {
    return { ok: false, superseded: true };
  }

  // The same file can appear twice (a picked folder containing the library,
  // or case-variant root spellings on Windows); the library entry wins so
  // results keep their libraryItemId. Keys fold case on Windows for the same
  // reason.
  const pathKey = (value) => (process.platform === "win32" ? value.toLowerCase() : value);
  const byPath = new Map();
  for (const file of libraryFiles) {
    byPath.set(pathKey(file.path), file);
  }
  for (const file of folderScan.files) {
    // Derived library data (the Thumbnails folder) is pure noise: every
    // capture would appear twice at 100% once the library is inside scope.
    if (excludeDirs.some((dir) => isInside(file.path, dir))) {
      continue;
    }

    const key = pathKey(file.path);
    if (!byPath.has(key)) {
      byPath.set(key, file);
    }
  }
  const candidates = [...byPath.values()];

  emitter.emit("progress", { phase: "hash", scanned: 0, total: candidates.length, matched: -1 });
  const outcome = await hashCandidates(candidates, myGeneration);
  if (outcome.superseded) {
    return { ok: false, superseded: true };
  }

  const { hashed, processed, budgetExhausted } = outcome;
  const matches = [];

  for (const candidate of hashed) {
    if (excluded.some((candidatePath) => samePath(candidate.path, candidatePath))) {
      continue;
    }

    const distance = hamming(queryHash, candidate.hash);
    if (distance <= SEARCH_MATCH_THRESHOLD) {
      matches.push({ ...candidate, distance });
    }
  }

  matches.sort((a, b) => a.distance - b.distance);
  const limited = matches.slice(0, SEARCH_MAX_RESULTS);

  emitter.emit("progress", { phase: "hash", scanned: processed, total: candidates.length, matched: limited.length });

  // Previews are built only for the final matches, so cache hits never
  // re-decode images.
  const results = [];
  for (const match of limited) {
    if (myGeneration !== generation) {
      return { ok: false, superseded: true };
    }

    let preview = null;
    try {
      preview = await io.previewFor(match.path);
    } catch (_error) {
      preview = null;
    }

    results.push({
      path: match.path,
      name: path.basename(match.path),
      size: match.size,
      distance: match.distance,
      similarity: similarity(queryHash, match.hash),
      preview,
      libraryItemId: match.libraryItemId || null
    });
  }

  return {
    ok: true,
    results,
    scanned: processed,
    totalFound: folderScan.totalFound + libraryFiles.length,
    truncated: budgetExhausted,
    skippedFolders: folderScan.skippedRoots
  };
}

async function searchByBuffer(buffer, { roots = [], excludeSystemDirs = false, excludeDirs = [], libraryCandidates = [], excludePath } = {}) {
  let queryHash = null;
  try {
    queryHash = await io.hashBuffer(buffer);
  } catch (_error) {
    queryHash = null;
  }

  if (!queryHash) {
    return { ok: false, reason: "undecodable" };
  }

  return runSearch({ queryHash, roots, excludeSystemDirs, excludeDirs, libraryCandidates, excludePath });
}

async function searchByPath(filePath, { roots = [], excludeSystemDirs = false, excludeDirs = [], libraryCandidates = [], excludePath } = {}) {
  let queryHash = null;
  try {
    queryHash = await io.hashFile(filePath);
  } catch (_error) {
    queryHash = null;
  }

  if (!queryHash) {
    return { ok: false, reason: "undecodable" };
  }

  return runSearch({ queryHash, roots, excludeSystemDirs, excludeDirs, libraryCandidates, excludePath: excludePath || filePath });
}

function cancel() {
  generation += 1;
}

// Small preview for a single file (used for the query image when it comes from
// a dialog or the library rather than a renderer drop).
async function previewFor(filePath) {
  try {
    return await io.previewFor(filePath);
  } catch (_error) {
    return null;
  }
}

module.exports = {
  emitter,
  cancel,
  flush,
  hasImageExtension,
  init,
  isInside,
  listDriveRoots,
  previewFor,
  samePath,
  searchByBuffer,
  searchByPath
};
