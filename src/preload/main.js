// Preload for the main window. Exposes a fixed, named API — never `ipcRenderer`
// itself and never a generic invoke(channel, ...) escape hatch.

const { contextBridge, ipcRenderer, webUtils } = require("electron");

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

  search: {
    findByImage: (buffer, queryPath) =>
      ipcRenderer.invoke("search:by-image", buffer, typeof queryPath === "string" ? queryPath : ""),
    findByItem: (id) => ipcRenderer.invoke("search:by-item", String(id)),
    pickImage: () => ipcRenderer.invoke("search:pick-image"),
    pickFolders: () => ipcRenderer.invoke("search:pick-folders"),
    cancel: () => ipcRenderer.invoke("search:cancel"),
    open: (filePath) => ipcRenderer.invoke("search:open", String(filePath)),
    reveal: (filePath) => ipcRenderer.invoke("search:reveal", String(filePath)),
    // Absolute path of a dragged-in File; sandboxed renderers cannot read
    // File.path directly, which is why this goes through the preload.
    pathForFile: (file) => {
      try {
        return webUtils.getPathForFile(file);
      } catch (_error) {
        return "";
      }
    }
  },

  onLibrary: subscribe("app:library"),
  onSettings: subscribe("app:settings"),
  onRecording: subscribe("app:recording"),
  onSearchProgress: subscribe("app:search-progress"),
  onSearchStarted: subscribe("app:search-started"),
  onToast: subscribe("app:toast")
});
