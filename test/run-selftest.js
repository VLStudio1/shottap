// Launches the real Electron app in self-test mode against a throwaway
// settings/media directory, then prints the report.
//
//   npm run selftest

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const electron = require("electron");

const stamp = Date.now();
const root = path.join(os.tmpdir(), `shottap-selftest-${stamp}`);
const userData = path.join(root, "userdata");
const media = path.join(root, "media");
const output = process.env.SHOTTAP_SELFTEST_OUT || path.join(root, "artifacts");

for (const directory of [userData, media, output]) {
  fs.mkdirSync(directory, { recursive: true });
}

const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;

const child = spawn(
  electron,
  [path.join(__dirname, "..")],
  {
    stdio: "inherit",
    env: {
      ...environment,
      SHOTTAP_SELFTEST: "1",
      SHOTTAP_USERDATA_DIR: userData,
      SHOTTAP_MEDIA_DIR: media,
      SHOTTAP_SELFTEST_OUT: output
    }
  }
);

child.on("exit", (code) => {
  console.log(`\nSelf-test exited with code ${code}. Artifacts: ${output}`);
  process.exit(code === null ? 1 : code);
});
