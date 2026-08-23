const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("shottapRecorder", {
  onStart: (callback) => ipcRenderer.on("recording:start", (_event, config) => callback(config)),
  onStop: (callback) => ipcRenderer.on("recording:stop", () => callback()),
  started: (info) => ipcRenderer.invoke("recorder:started", info),
  // `data` is an ArrayBuffer moved to the main process and appended to the
  // destination file immediately, so nothing accumulates in the renderer.
  chunk: (seq, data) => ipcRenderer.invoke("recorder:chunk", { seq, data }),
  poster: (dataUrl) => ipcRenderer.invoke("recorder:poster", dataUrl),
  finished: (info) => ipcRenderer.invoke("recorder:finished", info),
  failed: (message) => ipcRenderer.invoke("recorder:failed", String(message))
});
