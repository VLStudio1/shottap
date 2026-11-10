// Preload for the hidden decode workers. Mirrors the shape of the main
// preload: a fixed, named API — never ipcRenderer itself.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("shottapDecoder", {
  onBatch: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("decode:batch", listener);

    return () => ipcRenderer.removeListener("decode:batch", listener);
  },
  postResults: (payload) => ipcRenderer.invoke("decode:result", payload)
});
