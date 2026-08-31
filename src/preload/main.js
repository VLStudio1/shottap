// Preload for the main window. Exposes a fixed, named API — never `ipcRenderer`
// itself and never a generic invoke(channel, ...) escape hatch.

const { contextBridge, ipcRenderer } = require("electron");

function subscribe(channel) {
  return (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);

    return () => ipcRenderer.removeListener(channel, listener);
  };
}

contextBridge.exposeInMainWorld("shottap", {
  getState: () => ipcRenderer.invoke("app:get-state"),
  run: (action) => ipcRenderer.invoke("action:run", String(action)),
  stopRecording: () => ipcRenderer.invoke("recording:stop"),
  clearCaptureQueue: () => ipcRenderer.invoke("session:clear-capture-queue"),
  clearClipboard: () => ipcRenderer.invoke("clipboard:clear"),

  library: {
    setFavorite: (id, favorite) => ipcRenderer.invoke("library:favorite", String(id), Boolean(favorite)),
    trash: (id) => ipcRenderer.invoke("library:trash", String(id)),
    trashMany: (ids) => ipcRenderer.invoke("library:trash-many", Array.isArray(ids) ? ids.map(String) : []),
    restore: (id) => ipcRenderer.invoke("library:restore", String(id)),
    deletePermanently: (id) => ipcRenderer.invoke("library:delete", String(id)),
    emptyTrash: () => ipcRenderer.invoke("library:empty-trash"),
    copy: (id) => ipcRenderer.invoke("library:copy", String(id)),
    copyMany: (ids) => ipcRenderer.invoke("library:copy-many", Array.isArray(ids) ? ids.map(String) : []),
    open: (id) => ipcRenderer.invoke("library:open", String(id)),
    reveal: (id) => ipcRenderer.invoke("library:reveal", String(id)),
    saveEdit: (id, buffer) => ipcRenderer.invoke("library:save-edit", String(id), buffer)
  },

  settings: {
    update: (patch) => ipcRenderer.invoke("settings:update", patch),
    setShortcut: (action, accelerator) =>
      ipcRenderer.invoke("settings:set-shortcut", String(action), String(accelerator)),
    beginShortcutCapture: () => ipcRenderer.invoke("settings:begin-shortcut-capture"),
    endShortcutCapture: () => ipcRenderer.invoke("settings:end-shortcut-capture"),
    chooseDirectory: () => ipcRenderer.invoke("settings:choose-directory"),
    openDirectory: () => ipcRenderer.invoke("settings:open-directory")
  },

  onLibrary: subscribe("app:library"),
  onSettings: subscribe("app:settings"),
  onRecording: subscribe("app:recording"),
  onToast: subscribe("app:toast")
});
