// File backed media library.
//
// Everything the UI shows is derived from real files on disk plus a small JSON
// index that stores the metadata the filesystem cannot (favourite flag, capture
// method, video duration, trash state). No `electron` import, so the store can
// be exercised from plain node in tests.

const { EventEmitter } = require("events");
const fs = require("fs/promises");
const fsSync = require("fs");
const path = require("path");

const SCREENSHOT_DIR = "Screenshots";
const RECORDING_DIR = "Recordings";
const THUMBNAIL_DIR = "Thumbnails";
const TRASH_DIR = "Trash";
const INDEX_FILE = "library.json";

const emitter = new EventEmitter();

let root = "";
let items = [];
let writeQueue = Promise.resolve();
let writeTimer = null;

function createId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function timestampName(prefix, extension, date = new Date()) {
  const stamp = [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  ].join("-");
  const time = [pad(date.getHours()), pad(date.getMinutes()), pad(date.getSeconds())].join("");

  return `${prefix} ${stamp} ${time}.${extension}`;
}

function toPosix(relativePath) {
  return relativePath.split(path.sep).join("/");
}

function absolutePath(relativePath) {
  return path.join(root, ...relativePath.split("/"));
}

// Guards the custom media:// protocol against path traversal.
function resolveInsideRoot(relativePath) {
  const resolved = path.resolve(root, ...String(relativePath).split("/"));
  const rootWithSep = path.resolve(root) + path.sep;

  if (!resolved.startsWith(rootWithSep)) {
    return null;
  }

  return resolved;
}

async function uniquePath(directory, fileName) {
  const extension = path.extname(fileName);
  const base = path.basename(fileName, extension);
  let candidate = path.join(directory, fileName);
  let counter = 2;

  while (true) {
    try {
      await fs.access(candidate);
      candidate = path.join(directory, `${base} (${counter})${extension}`);
      counter += 1;
    } catch (_error) {
      return candidate;
    }
  }
}

function schedulePersist() {
  if (writeTimer) {
    clearTimeout(writeTimer);
  }

  writeTimer = setTimeout(() => {
    writeTimer = null;
    persist();
  }, 150);
}

function persist() {
  const snapshot = JSON.stringify({ version: 1, items }, null, 2);
  const indexPath = path.join(root, INDEX_FILE);

  writeQueue = writeQueue
    .then(async () => {
      await fs.mkdir(root, { recursive: true });
      await fs.writeFile(`${indexPath}.tmp`, snapshot, "utf8");
      await fs.rename(`${indexPath}.tmp`, indexPath);
    })
    .catch(() => {
      // Index writes are best-effort; the media files themselves are the
      // source of truth and are already on disk at this point.
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

function normalizeItem(raw) {
  if (!raw || typeof raw !== "object" || !raw.id || !raw.relPath) {
    return null;
  }

  return {
    id: String(raw.id),
    type: raw.type === "video" ? "video" : "image",
    name: String(raw.name || path.basename(raw.relPath)),
    relPath: String(raw.relPath),
    thumb: raw.thumb ? String(raw.thumb) : null,
    width: Number(raw.width) || 0,
    height: Number(raw.height) || 0,
    size: Number(raw.size) || 0,
    createdAt: raw.createdAt || new Date().toISOString(),
    source: raw.source || "unknown",
    format: raw.format || path.extname(raw.relPath).replace(".", "").toUpperCase(),
    favorite: Boolean(raw.favorite),
    durationMs: Number(raw.durationMs) || 0,
    trashedAt: raw.trashedAt || null,
    trashOrigin: raw.trashOrigin || null,
    editedAt: raw.editedAt || null
  };
}

// Media files sitting in the library folder with no index entry — left by a
// crash between writing the file and writing the index, or dropped in by hand —
// are adopted rather than ignored. Without this they exist on disk but can never
// appear in the app again. Dimensions are unknown here (decoding would mean
// pulling `electron` into this module), so they stay 0 and the grid falls back
// to the full image in place of a thumbnail.
async function adoptOrphans(directory, indexed) {
  const known = new Set(indexed.map((item) => item.relPath));
  const adopted = [];

  for (const [folder, type] of [[SCREENSHOT_DIR, "image"], [RECORDING_DIR, "video"]]) {
    let names = [];

    try {
      names = await fs.readdir(path.join(directory, folder));
    } catch (_error) {
      continue;
    }

    for (const name of names) {
      const relPath = `${folder}/${name}`;

      if (known.has(relPath)) {
        continue;
      }

      let stats;

      try {
        stats = await fs.stat(path.join(directory, folder, name));
      } catch (_error) {
        continue;
      }

      if (!stats.isFile()) {
        continue;
      }

      adopted.push(
        normalizeItem({
          id: createId(),
          type,
          name,
          relPath,
          size: stats.size,
          createdAt: new Date(stats.mtimeMs).toISOString(),
          source: "unknown"
        })
      );
    }
  }

  return adopted;
}

// Atomic: `root` and `items` are only replaced once the new directory has been
// read successfully. A half-applied switch (mkdir refused on a read-only volume)
// would otherwise leave the root pointing somewhere unusable while the entries
// still described the old one — every thumbnail broken, every path wrong.
async function init(directory) {
  await Promise.all(
    [SCREENSHOT_DIR, RECORDING_DIR, THUMBNAIL_DIR, TRASH_DIR].map((name) =>
      fs.mkdir(path.join(directory, name), { recursive: true })
    )
  );

  let loaded = [];

  try {
    const raw = JSON.parse(await fsSync.promises.readFile(path.join(directory, INDEX_FILE), "utf8"));
    loaded = (raw.items || []).map(normalizeItem).filter(Boolean);
  } catch (_error) {
    loaded = [];
  }

  // Drop entries whose files were removed behind our back (manual cleanup,
  // moved folders). Keeps the grid free of broken tiles.
  const alive = [];

  for (const item of loaded) {
    try {
      await fs.access(path.join(directory, ...item.relPath.split("/")));
      alive.push(item);
    } catch (_error) {
      // File is gone; the entry goes with it.
    }
  }

  const adopted = await adoptOrphans(directory, alive);

  root = directory;
  items = [...alive, ...adopted];

  if (alive.length !== loaded.length || adopted.length > 0) {
    schedulePersist();
  }

  return items;
}

function getRoot() {
  return root;
}

function directories() {
  return {
    root,
    screenshots: path.join(root, SCREENSHOT_DIR),
    recordings: path.join(root, RECORDING_DIR),
    thumbnails: path.join(root, THUMBNAIL_DIR),
    trash: path.join(root, TRASH_DIR)
  };
}

function list() {
  return items;
}

function find(id) {
  return items.find((item) => item.id === id) || null;
}

function pathFor(id) {
  const item = find(id);

  return item ? absolutePath(item.relPath) : null;
}

function changed(reason) {
  schedulePersist();
  emitter.emit("change", { reason, items });
}

async function writeThumbnail(id, buffer) {
  if (!buffer) {
    return null;
  }

  const relative = `${THUMBNAIL_DIR}/${id}.jpg`;
  await fs.writeFile(absolutePath(relative), buffer);

  return relative;
}

async function addImage({ buffer, thumbnail, width, height, source, extension = "png", name }) {
  const fileName = name || timestampName("Screenshot", extension);
  const target = await uniquePath(path.join(root, SCREENSHOT_DIR), fileName);
  await fs.writeFile(target, buffer);

  const id = createId();
  const item = normalizeItem({
    id,
    type: "image",
    name: path.basename(target),
    relPath: `${SCREENSHOT_DIR}/${path.basename(target)}`,
    thumb: await writeThumbnail(id, thumbnail),
    width,
    height,
    size: buffer.length,
    createdAt: new Date().toISOString(),
    source,
    format: extension.toUpperCase()
  });

  items.push(item);
  changed("add");
  // A new capture is written through immediately rather than on the 150 ms
  // debounce. A crash inside that window used to leave the PNG and its
  // thumbnail on disk with no index entry — the file was never lost, but the
  // app could never show it again, because load only prunes dead entries and
  // never adopts files that have none.
  await flush();

  return item;
}

// Recordings are streamed straight to disk, so the file already exists by the
// time it is registered. Only the metadata is added here.
//
// The name is uniqued like a screenshot's: the timestamp only resolves to the
// second, and a collision would have had createWriteStream truncate the earlier
// recording while its library entry still pointed at the file.
async function reserveRecordingPath(extension = "webm") {
  const target = await uniquePath(path.join(root, RECORDING_DIR), timestampName("Recording", extension));
  const fileName = path.basename(target);

  return {
    fileName,
    filePath: target,
    relPath: `${RECORDING_DIR}/${fileName}`
  };
}

async function addRecording({ relPath, thumbnail, width, height, durationMs, source, size }) {
  const id = createId();
  const stats = await fs.stat(absolutePath(relPath));
  const item = normalizeItem({
    id,
    type: "video",
    name: path.basename(relPath),
    relPath,
    thumb: await writeThumbnail(id, thumbnail),
    width,
    height,
    size: size || stats.size,
    createdAt: new Date().toISOString(),
    source,
    format: "WEBM",
    durationMs
  });

  items.push(item);
  changed("add");
  await flush();

  return item;
}

async function replaceImageContents(id, { buffer, thumbnail, width, height }) {
  const item = find(id);

  if (!item || item.type !== "image") {
    return null;
  }

  await fs.writeFile(absolutePath(item.relPath), buffer);
  item.size = buffer.length;
  item.width = width || item.width;
  item.height = height || item.height;
  item.editedAt = new Date().toISOString();

  if (thumbnail) {
    item.thumb = await writeThumbnail(id, thumbnail);
  }

  changed("update");

  return item;
}

function setFavorite(id, favorite) {
  const item = find(id);

  if (!item) {
    return null;
  }

  item.favorite = Boolean(favorite);
  changed("favorite");

  return item;
}

async function moveToTrash(id) {
  const item = find(id);

  if (!item || item.trashedAt) {
    return null;
  }

  const target = await uniquePath(path.join(root, TRASH_DIR), `${item.id}-${item.name}`);
  await fs.rename(absolutePath(item.relPath), target);

  item.trashOrigin = item.relPath;
  item.relPath = `${TRASH_DIR}/${path.basename(target)}`;
  item.trashedAt = new Date().toISOString();
  changed("trash");

  return item;
}

async function restore(id) {
  const item = find(id);

  if (!item || !item.trashedAt) {
    return null;
  }

  const originalDir = item.trashOrigin ? path.dirname(item.trashOrigin) : item.type === "video" ? RECORDING_DIR : SCREENSHOT_DIR;
  const target = await uniquePath(path.join(root, originalDir), item.name);
  await fs.rename(absolutePath(item.relPath), target);

  item.relPath = toPosix(path.relative(root, target));
  item.name = path.basename(target);
  item.trashedAt = null;
  item.trashOrigin = null;
  changed("restore");

  return item;
}

async function removeFiles(item) {
  await fs.rm(absolutePath(item.relPath), { force: true });

  if (item.thumb) {
    await fs.rm(absolutePath(item.thumb), { force: true });
  }
}

async function deletePermanently(id) {
  const item = find(id);

  if (!item) {
    return false;
  }

  await removeFiles(item);
  items = items.filter((entry) => entry.id !== id);
  changed("delete");

  return true;
}

async function emptyTrash() {
  const trashed = items.filter((item) => item.trashedAt);

  for (const item of trashed) {
    await removeFiles(item);
  }

  items = items.filter((item) => !item.trashedAt);
  changed("delete");

  return trashed.length;
}

module.exports = {
  addImage,
  addRecording,
  deletePermanently,
  directories,
  emitter,
  emptyTrash,
  find,
  flush,
  getRoot,
  init,
  list,
  moveToTrash,
  pathFor,
  replaceImageContents,
  reserveRecordingPath,
  resolveInsideRoot,
  restore,
  setFavorite,
  timestampName
};
