const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("shottapSelection", {
  getConfig: () => ipcRenderer.invoke("selection:config"),
  finish: (rect) =>
    ipcRenderer.invoke("selection:finish", {
      x: Number(rect.x),
      y: Number(rect.y),
      width: Number(rect.width),
      height: Number(rect.height)
    }),
  cancel: () => ipcRenderer.invoke("selection:cancel")
});
