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

test("folders beyond the decode budget are searched newest-first and reported as truncated", async () => {
  const env = await freshSearch();

  try {
    await imagesearch.init({ userDataDir: env.userDataDir, io: env.io, maxFiles: 1 });

    const day = 86400000;
    await fs.writeFile(path.join(env.scanDir, "query.png"), `hash:${ZERO_HASH}`);
    await fs.writeFile(path.join(env.scanDir, "aaa-old.png"), `hash:${ZERO_HASH}`);
    await fs.writeFile(path.join(env.scanDir, "zzz-new.png"), `hash:${ZERO_HASH}`);

    // Explicit distinct ages so the newest-first order is deterministic:
    // zzz-new (now) > query (2 days) > aaa-old (8 days). With a budget of one
    // decode, only zzz-new is hashed; the rest are examined but skipped.
    await fs.utimes(path.join(env.scanDir, "aaa-old.png"), new Date(Date.now() - 8 * day), new Date(Date.now() - 8 * day));
    await fs.utimes(path.join(env.scanDir, "query.png"), new Date(Date.now() - 2 * day), new Date(Date.now() - 2 * day));

    const result = await imagesearch.searchByPath(path.join(env.scanDir, "query.png"), {
      roots: [env.scanDir]
    });

    assert.equal(result.ok, true);
    assert.equal(result.truncated, true);
    assert.equal(result.totalFound, 3);
    assert.equal(result.scanned, 3);
    assert.deepEqual(result.results.map((match) => match.name), ["zzz-new.png"]);
  } finally {
    await env.cleanup();
  }
});

test("already-cached files beyond the budget are still compared", async () => {
  const env = await freshSearch();

  try {
    await fs.writeFile(path.join(env.scanDir, "query.png"), `hash:${ZERO_HASH}`);
    await fs.writeFile(path.join(env.scanDir, "dup-old.png"), `hash:${ZERO_HASH}`);
    await fs.writeFile(path.join(env.scanDir, "dup-new.png"), `hash:${ZERO_HASH}`);

    // First pass with the default budget: everything gets decoded and cached.
    await imagesearch.searchByPath(path.join(env.scanDir, "query.png"), { roots: [env.scanDir] });
    await imagesearch.flush();

    // Restart with a one-decode budget and a cache reloaded from disk — the
    // way a later session would experience it.
    await imagesearch.init({ userDataDir: env.userDataDir, io: fakeIo(), maxFiles: 1 });
    const result = await imagesearch.searchByPath(path.join(env.scanDir, "query.png"), { roots: [env.scanDir] });

    assert.equal(result.ok, true);
    assert.equal(result.truncated, false, "cache hits must not count against the budget");
    assert.equal(result.results.length, 2);
    assert.equal(result.scanned, 3);
  } finally {
    await env.cleanup();
  }
});

test("whole-computer walks skip system directories", async () => {
  const env = await freshSearch();

  try {
    await fs.writeFile(path.join(env.scanDir, "query.png"), `hash:${ZERO_HASH}`);

    const windowsDir = path.join(env.scanDir, "Windows");
    const normalDir = path.join(env.scanDir, "pictures");
    await fs.mkdir(windowsDir);
    await fs.mkdir(normalDir);
    await fs.writeFile(path.join(windowsDir, "wallpaper.png"), `hash:${ZERO_HASH}`);
    await fs.writeFile(path.join(normalDir, "holiday.png"), `hash:${ZERO_HASH}`);

    const excluded = await imagesearch.searchByPath(path.join(env.scanDir, "query.png"), {
      roots: [env.scanDir],
      excludeSystemDirs: true
    });
    assert.ok(!excluded.results.some((match) => match.name === "wallpaper.png"), "system directory was walked");
    assert.ok(excluded.results.some((match) => match.name === "holiday.png"));

    const included = await imagesearch.searchByPath(path.join(env.scanDir, "query.png"), {
      roots: [env.scanDir]
    });
    assert.ok(included.results.some((match) => match.name === "wallpaper.png"), "explicitly picked folders walk everything");
  } finally {
    await env.cleanup();
  }
});

test("the parallel hashFiles farm feeds results back through the cache", async () => {
  const env = await freshSearch();

  try {
    // Shaped like the decode-window farm: batch in, per-file results out.
    // The fake also asserts the entries are farm-shaped — a real farm reads
    // entry.filePath, so a missing field silently nulls every hash.
    env.io.hashFiles = async (entries, { onResult }) => {
      for (const entry of entries) {
        assert.ok(typeof entry.filePath === "string" && entry.filePath === entry.key, "farm entry missing filePath");
        onResult(entry.key, ZERO_HASH);
      }
    };

    await fs.writeFile(path.join(env.scanDir, "query.png"), `hash:${ZERO_HASH}`);
    await fs.writeFile(path.join(env.scanDir, "a.png"), "content does not matter");
    await fs.writeFile(path.join(env.scanDir, "b.png"), "content does not matter");

    const result = await imagesearch.searchByPath(path.join(env.scanDir, "query.png"), { roots: [env.scanDir] });

    assert.equal(result.ok, true);
    assert.deepEqual(result.results.map((match) => match.name).sort(), ["a.png", "b.png"]);
    assert.equal(result.truncated, false);
    assert.equal(env.io.calls.length, 1, "only the query should use the sequential hashFile");
  } finally {
    await env.cleanup();
  }
});

test("isInside tolerates drive roots, trailing separators and case variance", () => {
  assert.equal(imagesearch.isInside("C:\\Users\\tito\\pic.png", "C:\\"), true);
  assert.equal(imagesearch.isInside("c:\\users\\TITO\\pic.png", "C:\\"), true);
  assert.equal(imagesearch.isInside("C:\\pic.png", "C:\\"), true);
  assert.equal(imagesearch.isInside("C:\\Users", "C:\\Users\\"), true);
  assert.equal(imagesearch.isInside("D:\\pic.png", "C:\\"), false);
  // A string prefix that is not a path boundary must not pass.
  assert.equal(imagesearch.isInside("C:\\Users2\\pic.png", "C:\\Users"), false);
});

test("excluded directories and multi-path exclusions keep noise out of results", async () => {
  const env = await freshSearch();

  try {
    await fs.writeFile(path.join(env.scanDir, "query.png"), `hash:${ZERO_HASH}`);
    const thumbs = path.join(env.scanDir, "Thumbnails");
    await fs.mkdir(thumbs);
    await fs.writeFile(path.join(thumbs, "thumb-dup.png"), `hash:${ZERO_HASH}`);
    await fs.writeFile(path.join(env.scanDir, "real-dup.png"), `hash:${ZERO_HASH}`);

    const result = await imagesearch.searchByPath(path.join(env.scanDir, "query.png"), {
      roots: [env.scanDir],
      excludeDirs: [thumbs],
      excludePath: [path.join(env.scanDir, "query.png"), path.join(thumbs, "would-be-self.png")]
    });

    assert.deepEqual(result.results.map((match) => match.name), ["real-dup.png"]);
  } finally {
    await env.cleanup();
  }
});

test("case-variant roots do not walk the same tree twice", async () => {
  const env = await freshSearch();

  try {
    await fs.writeFile(path.join(env.scanDir, "query.png"), `hash:${ZERO_HASH}`);
    const dup = path.join(env.scanDir, "dup.png");
    await fs.writeFile(dup, `hash:${ZERO_HASH}`);

    const variant = env.scanDir.toUpperCase() === env.scanDir
      ? env.scanDir.toLowerCase()
      : env.scanDir.toUpperCase();

    const result = await imagesearch.searchByPath(path.join(env.scanDir, "query.png"), {
      roots: [env.scanDir, variant]
    });

    assert.equal(result.ok, true);
    assert.equal(result.results.length, 1);
    const dupDecodes = env.io.calls.filter((call) => call.toLowerCase() === dup.toLowerCase()).length;
    assert.equal(dupDecodes, 1, "the same file was decoded more than once via case-variant roots");
  } finally {
    await env.cleanup();
  }
});

test("drive roots are probed by letter and only readable ones are kept", async () => {
  const readable = new Set(["C:\\", "D:\\"]);
  const access = async (candidate) => {
    if (!readable.has(candidate)) {
      throw new Error("no media");
    }
  };

  assert.deepEqual(await imagesearch.listDriveRoots(access), ["C:\\", "D:\\"]);
});

test("the hash cache keeps accumulating across searches, capped only at its own limit", async () => {
  const env = await freshSearch();

  try {
    await imagesearch.init({ userDataDir: env.userDataDir, io: env.io, maxFiles: 2, cacheMax: 3 });

    await fs.writeFile(path.join(env.scanDir, "query.png"), `hash:${ZERO_HASH}`);
    const day = 86400000;

    for (const [index, name] of ["oldest.png", "mid-old.png", "mid-new.png", "newest.png"].entries()) {
      await fs.writeFile(path.join(env.scanDir, name), `hash:${ZERO_HASH}`);
      const at = new Date(Date.now() - (4 - index) * day);
      await fs.utimes(path.join(env.scanDir, name), at, at);
    }

    // Two searches at a decode budget of 2 index all four files; the persist
    // step prunes to the cache's own cap (3) — crucially NOT to the decode
    // budget (2), which is the regression this test guards against.
    await imagesearch.searchByPath(path.join(env.scanDir, "query.png"), { roots: [env.scanDir] });
    await imagesearch.searchByPath(path.join(env.scanDir, "query.png"), { roots: [env.scanDir] });
    await imagesearch.flush();

    const written = JSON.parse(await fs.readFile(path.join(env.userDataDir, "search-cache.json"), "utf8"));
    assert.equal(Object.keys(written.entries).length, 3, "cache was pruned to something other than its own cap");

    // A reload keeps the survivors; the cap still prunes after another search.
    await imagesearch.init({ userDataDir: env.userDataDir, io: fakeIo(), maxFiles: 2, cacheMax: 3 });
    const result = await imagesearch.searchByPath(path.join(env.scanDir, "query.png"), { roots: [env.scanDir] });
    assert.equal(result.ok, true);

    await imagesearch.flush();
    const pruned = JSON.parse(await fs.readFile(path.join(env.userDataDir, "search-cache.json"), "utf8"));
    assert.ok(Object.keys(pruned.entries).length <= 3, "the cache cap did not prune");
    assert.ok(Object.keys(pruned.entries).length >= 2, "the cache was pruned below what a single search should keep");
  } finally {
    await env.cleanup();
  }
});

test("the cache cap cannot silently regress to the per-search decode budget", () => {
  const { SEARCH_CACHE_MAX, SEARCH_MAX_FILES } = require("../src/shared/constants");

  assert.ok(
    SEARCH_CACHE_MAX >= SEARCH_MAX_FILES * 10,
    `cache cap ${SEARCH_CACHE_MAX} is too close to the decode budget ${SEARCH_MAX_FILES} — progressive indexing would not survive restarts`
  );
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
