// Launches ShotTap against throwaway data and writes curated README images.
//
//   npm run docs:screenshots

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const electron = require("electron");

const stamp = Date.now();
const root = path.join(os.tmpdir(), `shottap-docs-${stamp}`);
const userData = path.join(root, "userdata");
const media = path.join(root, "media");
const output = path.join(__dirname, "..", "docs", "images");

for (const directory of [userData, media, output]) {
  fs.mkdirSync(directory, { recursive: true });
}

const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, [path.join(__dirname, "..")], {
  stdio: "inherit",
  env: {
    ...environment,
    SHOTTAP_DOCS_SCREENSHOTS: "1",
    SHOTTAP_USERDATA_DIR: userData,
    SHOTTAP_MEDIA_DIR: media,
    SHOTTAP_DOCS_SCREENSHOTS_OUT: output
  }
});

child.on("exit", (code) => {
  console.log(`\nDocs screenshot run exited with code ${code}. Artifacts: ${output}`);
  process.exit(code === null ? 1 : code);
});
