const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const library = require("../src/main/library");

async function freshLibrary() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "shottap-library-"));
  await library.init(directory);

  return directory;
}

function fakePng(size = 64) {
  return Buffer.alloc(size, 7);
}

test("a screenshot is written to disk and indexed", async () => {
  const root = await freshLibrary();

  try {
    const item = await library.addImage({
      buffer: fakePng(128),
      thumbnail: fakePng(32),
      width: 1920,
      height: 1080,
      source: "fullscreen"
    });

    assert.equal(item.type, "image");
    assert.equal(item.width, 1920);
    assert.equal(item.size, 128);
    assert.match(item.relPath, /^Screenshots\//);

    const written = await fs.readFile(path.join(root, ...item.relPath.split("/")));
    assert.equal(written.length, 128);
    assert.ok(item.thumb);
    await fs.access(path.join(root, ...item.thumb.split("/")));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("trash moves the file aside and restore puts it back", async () => {
  const root = await freshLibrary();

  try {
    const item = await library.addImage({ buffer: fakePng(), width: 10, height: 10, source: "area" });
    const originalPath = path.join(root, ...item.relPath.split("/"));

    await library.moveToTrash(item.id);
    const trashed = library.find(item.id);

    assert.ok(trashed.trashedAt);
    assert.match(trashed.relPath, /^Trash\//);
    await assert.rejects(() => fs.access(originalPath));
    await fs.access(path.join(root, ...trashed.relPath.split("/")));

    await library.restore(item.id);
    const restored = library.find(item.id);

    assert.equal(restored.trashedAt, null);
    assert.match(restored.relPath, /^Screenshots\//);
    await fs.access(path.join(root, ...restored.relPath.split("/")));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("emptying the trash removes files and index entries but keeps live items", async () => {
  const root = await freshLibrary();

  try {
    const keep = await library.addImage({ buffer: fakePng(), width: 10, height: 10, source: "area" });
    const drop = await library.addImage({ buffer: fakePng(), width: 10, height: 10, source: "area" });

    await library.moveToTrash(drop.id);
    const trashedPath = path.join(root, ...library.find(drop.id).relPath.split("/"));

    const removed = await library.emptyTrash();

    assert.equal(removed, 1);
    assert.equal(library.find(drop.id), null);
    assert.ok(library.find(keep.id));
    await assert.rejects(() => fs.access(trashedPath));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("favourites and edits are persisted in the index", async () => {
  const root = await freshLibrary();

  try {
    const item = await library.addImage({ buffer: fakePng(), width: 10, height: 10, source: "area" });
    library.setFavorite(item.id, true);
    await library.replaceImageContents(item.id, { buffer: fakePng(256), width: 20, height: 20 });
    await library.flush();

    const index = JSON.parse(await fs.readFile(path.join(root, "library.json"), "utf8"));
    const stored = index.items.find((entry) => entry.id === item.id);

    assert.equal(stored.favorite, true);
    assert.equal(stored.size, 256);
    assert.equal(stored.width, 20);
    assert.ok(stored.editedAt);

    await library.init(root);
    assert.equal(library.find(item.id).favorite, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("index entries whose files vanished are dropped on load", async () => {
  const root = await freshLibrary();

  try {
    const item = await library.addImage({ buffer: fakePng(), width: 10, height: 10, source: "area" });
    await library.flush();
    await fs.rm(path.join(root, ...item.relPath.split("/")));

    await library.init(root);

    assert.equal(library.find(item.id), null);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("media files with no index entry are adopted on load", async () => {
  const root = await freshLibrary();

  try {
    const kept = await library.addImage({ buffer: fakePng(), width: 10, height: 10, source: "area" });
    await library.flush();

    // Exactly what a crash between the file write and the index write leaves.
    const orphan = path.join(root, "Screenshots", "Screenshot 2026-01-01 120000.png");
    await fs.writeFile(orphan, fakePng(4096));

    await library.init(root);

    const adopted = library.list().find((item) => item.name === "Screenshot 2026-01-01 120000.png");

    assert.ok(adopted, "the orphaned file should be adopted into the library");
    assert.equal(adopted.type, "image");
    assert.equal(adopted.size, 4096);
    assert.equal(adopted.relPath, "Screenshots/Screenshot 2026-01-01 120000.png");
    assert.ok(library.find(kept.id), "existing entries must survive adoption");

    // Adoption is persisted, so it happens once rather than on every launch.
    await library.flush();
    const index = JSON.parse(await fs.readFile(path.join(root, "library.json"), "utf8"));
    assert.equal(index.items.filter((entry) => entry.relPath === adopted.relPath).length, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a capture is written through to the index immediately, not on a debounce", async () => {
  const root = await freshLibrary();

  try {
    const item = await library.addImage({ buffer: fakePng(), width: 10, height: 10, source: "area" });

    // No flush() call: addImage must already be durable, so a crash straight
    // after a capture cannot lose it.
    const index = JSON.parse(await fs.readFile(path.join(root, "library.json"), "utf8"));

    assert.ok(index.items.some((entry) => entry.id === item.id));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("the media protocol cannot be walked out of the library folder", async () => {
  const root = await freshLibrary();

  try {
    assert.equal(library.resolveInsideRoot("../../../Windows/System32/config/SAM"), null);
    assert.equal(library.resolveInsideRoot("Screenshots/../../secret.txt"), null);
    assert.ok(library.resolveInsideRoot("Screenshots/shot.png"));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("recording paths land in the Recordings folder with a timestamped name", async () => {
  const root = await freshLibrary();

  try {
    const reserved = await library.reserveRecordingPath("webm");

    assert.match(reserved.relPath, /^Recordings\/Recording \d{4}-\d{2}-\d{2} \d{6}\.webm$/);
    assert.equal(path.dirname(reserved.filePath), path.join(root, "Recordings"));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a reserved recording path never collides with a file already on disk", async () => {
  const root = await freshLibrary();

  try {
    const first = await library.reserveRecordingPath("webm");
    await fs.writeFile(first.filePath, Buffer.alloc(2048, 1));

    // Same second, so the timestamp alone would hand back the same name and the
    // write stream would truncate the recording that is already there.
    const second = await library.reserveRecordingPath("webm");

    assert.notEqual(second.filePath, first.filePath);
    assert.match(second.relPath, /^Recordings\/Recording .* \(2\)\.webm$/);

    const untouched = await fs.readFile(first.filePath);
    assert.equal(untouched.length, 2048);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a failed init leaves the previous root and items untouched", async () => {
  const root = await freshLibrary();

  try {
    const item = await library.addImage({ buffer: fakePng(), width: 10, height: 10, source: "area" });

    // A file where the new root should be: every mkdir inside it fails.
    const blocked = path.join(root, "not-a-directory");
    await fs.writeFile(blocked, "x");

    await assert.rejects(() => library.init(blocked));

    assert.equal(library.getRoot(), root);
    assert.ok(library.find(item.id), "the previous index must survive a failed switch");
    assert.equal(library.pathFor(item.id), path.join(root, ...item.relPath.split("/")));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
