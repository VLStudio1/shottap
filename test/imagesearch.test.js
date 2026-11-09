const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const imagesearch = require("../src/main/imagesearch");

const ZERO_HASH = "0".repeat(16);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Fake decoder: a file whose content is "hash:<hex>" hashes to that hex string,
// giving tests exact control over Hamming distances. Anything else hashes to
// itself padded, so equal contents produce equal hashes.
function fakeIo() {
  const calls = [];

  function hashOf(content) {
    const match = /^hash:([0-9a-f]+)$/.exec(content);
    return match ? match[1] : BigInt(`0x${Buffer.from(content).toString("hex").slice(0, 16)}`).toString(16).padStart(16, "0");
  }

  return {
    calls,
    hashFile: async (filePath) => {
      calls.push(filePath);
      const content = await fs.readFile(filePath, "utf8").catch(() => null);
      return content === null ? null : hashOf(content);
    },
    hashBuffer: async (buffer) => hashOf(Buffer.from(buffer).toString("utf8")),
    previewFor: async () => "data:image/jpeg;base64,VEVTVA=="
  };
}

async function freshSearch() {
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "shottap-search-"));
  const scanDir = await fs.mkdtemp(path.join(os.tmpdir(), "shottap-scan-"));
  const io = fakeIo();
  await imagesearch.init({ userDataDir, io });

  return { userDataDir, scanDir, io, cleanup: async () => {
    await imagesearch.flush();
    await fs.rm(userDataDir, { recursive: true, force: true });
    await fs.rm(scanDir, { recursive: true, force: true });
  } };
}

test("finds near-duplicate images in picked folders and the library", async () => {
  const env = await freshSearch();

  try {
    await fs.writeFile(path.join(env.scanDir, "query.png"), `hash:${ZERO_HASH}`);
    await fs.writeFile(path.join(env.scanDir, "near-dup.png"), `hash:${"0".repeat(15)}1`); // distance 1
    await fs.writeFile(path.join(env.scanDir, "different.png"), `hash:${"f".repeat(16)}`); // distance 64
    await fs.writeFile(path.join(env.scanDir, "notes.txt"), "not an image");
    const nested = path.join(env.scanDir, "sub");
    await fs.mkdir(nested);
    await fs.writeFile(path.join(nested, "nested-dup.png"), `hash:${ZERO_HASH}`); // distance 0

    const libraryDir = await fs.mkdtemp(path.join(os.tmpdir(), "shottap-lib-"));
    const libraryFile = path.join(libraryDir, "capture.png");
    await fs.writeFile(libraryFile, `hash:${ZERO_HASH}`);

    const result = await imagesearch.searchByPath(path.join(env.scanDir, "query.png"), {
      roots: [env.scanDir],
      libraryCandidates: [{ id: "lib-1", path: libraryFile }]
    });

    assert.equal(result.ok, true);
    // Ordered by distance; the library entry wins the distance-0 tie.
    const names = result.results.map((match) => match.name);
    assert.deepEqual(names, ["capture.png", "nested-dup.png", "near-dup.png"]);
    assert.ok(!names.includes("query.png"), "the query file must not match itself");

    const near = result.results.find((match) => match.name === "near-dup.png");
    assert.equal(near.distance, 1);
    assert.equal(near.similarity, 98);
    assert.ok(near.preview.startsWith("data:image/jpeg;base64,"));

    const fromLibrary = result.results.find((match) => match.name === "capture.png");
    assert.equal(fromLibrary.libraryItemId, "lib-1");
    assert.equal(fromLibrary.similarity, 100);

    // Closest first.
    assert.ok(result.results[0].distance <= result.results[result.results.length - 1].distance);

    await fs.rm(libraryDir, { recursive: true, force: true });
  } finally {
    await env.cleanup();
  }
});

test("missing roots are skipped and reported, not fatal", async () => {
  const env = await freshSearch();

  try {
    await fs.writeFile(path.join(env.scanDir, "query.png"), `hash:${ZERO_HASH}`);
    await fs.writeFile(path.join(env.scanDir, "dup.png"), `hash:${ZERO_HASH}`);
    const missing = path.join(env.scanDir, "does-not-exist");

    const result = await imagesearch.searchByPath(path.join(env.scanDir, "query.png"), {
      roots: [missing, env.scanDir]
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.skippedFolders, [missing]);
    assert.equal(result.results.length, 1);
  } finally {
    await env.cleanup();
  }
});

test("hashes are cached in memory and reloaded from disk", async () => {
  const env = await freshSearch();

  try {
    await fs.writeFile(path.join(env.scanDir, "query.png"), `hash:${ZERO_HASH}`);
    const dup = path.join(env.scanDir, "dup.png");
    await fs.writeFile(dup, `hash:${ZERO_HASH}`);

    await imagesearch.searchByPath(path.join(env.scanDir, "query.png"), { roots: [env.scanDir] });
    const callsAfterFirst = env.io.calls.filter((call) => call === dup).length;
    assert.equal(callsAfterFirst, 1);

    await imagesearch.searchByPath(path.join(env.scanDir, "query.png"), { roots: [env.scanDir] });
    assert.equal(
      env.io.calls.filter((call) => call === dup).length,
      callsAfterFirst,
      "an unchanged file must not be re-hashed"
    );

    // Persist, then rebuild from the on-disk cache the way a restart would.
    await imagesearch.flush();
    await imagesearch.init({ userDataDir: env.userDataDir, io: fakeIo() });

    const result = await imagesearch.searchByPath(path.join(env.scanDir, "query.png"), { roots: [env.scanDir] });
    assert.equal(result.ok, true);
    assert.equal(result.results.length, 1);
  } finally {
    await env.cleanup();
  }
});

test("starting a new search supersedes the in-flight one", async () => {
  const env = await freshSearch();

  try {
    await fs.writeFile(path.join(env.scanDir, "slow-query.png"), `hash:${ZERO_HASH}`);
    await fs.writeFile(path.join(env.scanDir, "dup.png"), `hash:${ZERO_HASH}`);
    await fs.writeFile(path.join(env.scanDir, "fast-query.png"), `hash:${"0".repeat(15)}1`);

    // The first search stalls while hashing its first candidate.
    const originalHashFile = env.io.hashFile;
    env.io.hashFile = async (filePath, ...rest) => {
      if (filePath.endsWith("dup.png")) {
        await sleep(120);
      }
      return originalHashFile(filePath, ...rest);
    };

    const slow = imagesearch.searchByPath(path.join(env.scanDir, "slow-query.png"), { roots: [env.scanDir] });
    await sleep(10);
    const fast = imagesearch.searchByPath(path.join(env.scanDir, "fast-query.png"), { roots: [env.scanDir] });

    const [slowResult, fastResult] = await Promise.all([slow, fast]);
    assert.deepEqual(slowResult, { ok: false, superseded: true });
    assert.equal(fastResult.ok, true);
  } finally {
    await env.cleanup();
  }
});

test("an undecodable query fails cleanly", async () => {
  const env = await freshSearch();

  try {
    env.io.hashBuffer = async () => null;
    const result = await imagesearch.searchByBuffer(Buffer.from("junk"), { roots: [] });
    assert.deepEqual(result, { ok: false, reason: "undecodable" });
  } finally {
    await env.cleanup();
  }
});

test("folders beyond the cap are searched newest-first and reported as truncated", async () => {
  const env = await freshSearch();

  try {
    await imagesearch.init({ userDataDir: env.userDataDir, io: env.io, maxFiles: 1 });

    await fs.writeFile(path.join(env.scanDir, "query.png"), `hash:${ZERO_HASH}`);
    const oldDup = path.join(env.scanDir, "aaa-old-dup.png");
    const newDup = path.join(env.scanDir, "zzz-new-dup.png");
    await fs.writeFile(oldDup, `hash:${ZERO_HASH}`);
    await fs.writeFile(newDup, `hash:${ZERO_HASH}`);

    // The alphabetically-first file is the older one, so only the sort order
    // can decide which single file the capped search hashes.
    const past = new Date(Date.now() - 86400000);
    await fs.utimes(oldDup, past, past);

    const result = await imagesearch.searchByPath(path.join(env.scanDir, "query.png"), {
      roots: [env.scanDir]
    });

    assert.equal(result.ok, true);
    assert.equal(result.truncated, true);
    assert.equal(result.totalFound, 3);
    assert.equal(result.scanned, 1);
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].name, "zzz-new-dup.png");
  } finally {
    await env.cleanup();
  }
});

test("library candidates hash from their thumbnail when one exists", async () => {
  const env = await freshSearch();

  try {
    await fs.writeFile(path.join(env.scanDir, "query.png"), `hash:${ZERO_HASH}`);

    const libDir = await fs.mkdtemp(path.join(os.tmpdir(), "shottap-lib-"));
    const full = path.join(libDir, "capture.png");
    const thumb = path.join(libDir, "thumb.jpg");
    await fs.writeFile(full, `hash:${"f".repeat(16)}`); // nothing like the query
    await fs.writeFile(thumb, `hash:${ZERO_HASH}`); // the actual dHash source

    const result = await imagesearch.searchByPath(path.join(env.scanDir, "query.png"), {
      roots: [env.scanDir],
      libraryCandidates: [{ id: "lib-9", path: full, thumbPath: thumb }]
    });

    assert.equal(result.ok, true);
    assert.ok(env.io.calls.includes(thumb), "the thumbnail was never hashed");
    assert.ok(!env.io.calls.includes(full), "the full capture was hashed despite a thumbnail");

    const match = result.results.find((entry) => entry.libraryItemId === "lib-9");
    assert.ok(match, "the library item did not match via its thumbnail");
    assert.equal(match.path, full);
    assert.equal(match.similarity, 100);

    await fs.rm(libDir, { recursive: true, force: true });
  } finally {
    await env.cleanup();
  }
});

test("helpers: image extensions and path equality", () => {
  assert.equal(imagesearch.hasImageExtension("photo.PNG"), true);
  assert.equal(imagesearch.hasImageExtension("clip.webm"), false);
  assert.equal(imagesearch.samePath("C:/Users/a/pic.png", "c:\\users\\A\\pic.png"), true);
  assert.equal(imagesearch.samePath("C:/a/pic.png", "C:/a/other.png"), false);
});
