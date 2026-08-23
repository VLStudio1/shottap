// ShotTap renderer.
//
// Plain DOM, no framework: state lives in one object, each region of the UI has
// a render function, and every control is wired to a real main-process action.

(function () {
  const icons = window.SCIcons;
  const format = window.SCFormat;
  const api = window.shottap;

  const VIEWS = {
    captures: { label: "Captures", icon: "image", group: "library" },
    recordings: { label: "Recordings", icon: "video", group: "library" },
    clipboard: { label: "Clipboard", icon: "clipboard", group: "library" },
    favorites: { label: "Favorites", icon: "star", group: "library" },
    trash: { label: "Trash", icon: "trash", group: "library" },
    editor: { label: "Editor", icon: "pencil", group: "tools" },
    hotkeys: { label: "Hotkeys", icon: "keyboard", group: "settings" },
    general: { label: "General", icon: "sliders", group: "settings" },
    appearance: { label: "Appearance", icon: "palette", group: "settings" },
    about: { label: "About ShotTap", icon: "info", group: "settings" }
  };

  const GROUPS = [
    { id: "library", title: "Capture library" },
    { id: "tools", title: "Tools" },
    { id: "settings", title: "Settings" }
  ];

  const ACTIONS = [
    {
      id: "screenshotArea",
      label: "Screenshot Area",
      kind: "screenshot",
      icon: "screenshotArea",
      description: "Drag a region and save it as an image"
    },
    {
      id: "screenshotFullScreen",
      label: "Screenshot Full Screen",
      kind: "screenshot",
      icon: "screenshotFull",
      description: "Capture the display under the pointer"
    },
    {
      id: "recordArea",
      label: "Record Area",
      kind: "record",
      icon: "recordArea",
      description: "Record a region as video — press again to stop"
    },
    {
      id: "recordFullScreen",
      label: "Record Full Screen",
      kind: "record",
      icon: "recordFull",
      description: "Record a whole display — press again to stop"
    },
    {
      id: "copyAll",
      label: "Copy All",
      kind: "utility",
      icon: "copy",
      description: "Put every capture from this session on the clipboard"
    }
  ];

  const ACTION_GROUPS = [
    { kind: "screenshot", title: "Screenshot", ids: ["screenshotArea", "screenshotFullScreen"] },
    { kind: "record", title: "Record", ids: ["recordArea", "recordFullScreen"] },
    { kind: "utility", title: "Utility", ids: ["copyAll"] }
  ];

  const state = {
    view: "captures",
    settings: null,
    info: null,
    items: [],
    sessionItemIds: [],
    lastCopy: null,
    recording: { state: "idle" },
    selectedId: null,
    layout: "grid",
    sort: "newest",
    filter: "all",
    search: "",
    listeningAction: null
  };

  const elements = {
    nav: document.getElementById("nav"),
    main: document.getElementById("main"),
    inspector: document.getElementById("inspector"),
    toastHost: document.getElementById("toastHost"),
    recordingBar: document.getElementById("recordingBar"),
    recordingTime: document.getElementById("recordingTime"),
    stopRecordingButton: document.getElementById("stopRecordingButton"),
    stopRecordingIcon: document.getElementById("stopRecordingIcon"),
    brandShortcut: document.getElementById("brandShortcut"),
    quickCapture: document.getElementById("quickCapture"),
    quickCaptureIcon: document.getElementById("quickCaptureIcon"),
    quickCaptureShortcut: document.getElementById("quickCaptureShortcut"),
    storageCard: document.getElementById("storageCard"),
    storageIcon: document.getElementById("storageIcon"),
    storagePath: document.getElementById("storagePath")
  };

  let recordingTimer = null;
  let openMenu = null;

  // -------------------------------------------------------------------------
  // Derived data
  // -------------------------------------------------------------------------
  const isLive = (item) => !item.trashedAt;

  function itemsForView(view) {
    const items = state.items;

    switch (view) {
      case "captures":
        return items.filter((item) => isLive(item) && item.type === "image");
      case "recordings":
        return items.filter((item) => isLive(item) && item.type === "video");
      case "favorites":
        return items.filter((item) => isLive(item) && item.favorite);
      case "trash":
        return items.filter((item) => item.trashedAt);
      case "clipboard":
        return state.sessionItemIds
          .map((id) => items.find((item) => item.id === id))
          .filter((item) => item && isLive(item));
      case "editor":
        return items.filter((item) => isLive(item) && item.type === "image");
      default:
        return [];
    }
  }

  function counts() {
    return {
      captures: itemsForView("captures").length,
      recordings: itemsForView("recordings").length,
      clipboard: itemsForView("clipboard").length,
      favorites: itemsForView("favorites").length,
      trash: itemsForView("trash").length
    };
  }

  function applyFilters(items) {
    const search = state.search.trim().toLowerCase();

    let result = items.filter((item) => {
      if (state.filter === "favorites" && !item.favorite) {
        return false;
      }

      if (state.filter === "area" && item.source !== "area") {
        return false;
      }

      if (state.filter === "fullscreen" && item.source !== "fullscreen") {
        return false;
      }

      if (!search) {
        return true;
      }

      return [item.name, item.format, format.sourceLabel(item.source), format.shortDate(item.createdAt)]
        .join(" ")
        .toLowerCase()
        .includes(search);
    });

    const sorters = {
      newest: (a, b) => new Date(b.createdAt) - new Date(a.createdAt),
      oldest: (a, b) => new Date(a.createdAt) - new Date(b.createdAt),
      name: (a, b) => a.name.localeCompare(b.name),
      size: (a, b) => b.size - a.size
    };

    return result.sort(sorters[state.sort] || sorters.newest);
  }

  function selectedItem() {
    return state.items.find((item) => item.id === state.selectedId) || null;
  }

  function shortcutFor(action) {
    return state.settings?.shortcuts?.[action] || "";
  }

  function shortcutStatusFor(action) {
    return state.settings?.shortcutStatus?.[action]?.status || "failed";
  }

  const isRecording = () => state.recording.state === "recording" || state.recording.state === "preparing";

  // -------------------------------------------------------------------------
  // Chrome
  // -------------------------------------------------------------------------
  function renderStaticChrome() {
    elements.quickCaptureIcon.innerHTML = icons.icon("screenshotArea", { size: 18 });
    elements.storageIcon.innerHTML = icons.icon("folder", { size: 15 });
    elements.stopRecordingIcon.innerHTML = icons.icon("stop", { size: 14 });
  }

  function renderNav() {
    const count = counts();

    elements.nav.innerHTML = GROUPS.map((group) => {
      const items = Object.entries(VIEWS)
        .filter(([, view]) => view.group === group.id)
        .map(([id, view]) => {
          const badge =
            count[id] !== undefined ? `<span class="nav-count">${count[id].toLocaleString()}</span>` : "";

          return `
            <button class="nav-item" type="button" data-view="${id}" ${state.view === id ? 'aria-current="page"' : ""} title="${view.label}">
              ${icons.icon(view.icon, { size: 17 })}
              <span class="nav-label">${view.label}</span>
              ${badge}
            </button>`;
        })
        .join("");

      return `<div class="nav-heading">${group.title}</div>${items}`;
    }).join("");
  }

  function renderSidebarShortcut() {
    const accelerator = shortcutFor("screenshotArea");
    const active = shortcutStatusFor("screenshotArea") === "active";
    elements.brandShortcut.textContent = active ? accelerator : "Shortcut off";
    elements.brandShortcut.title = active
      ? `Screenshot Area: ${format.accelerator(accelerator)}`
      : "The Screenshot Area shortcut is not registered — open Hotkeys";
    elements.quickCaptureShortcut.textContent = active ? accelerator : "—";
    elements.storagePath.textContent = state.settings?.saveDirectory || "—";
    elements.storageCard.title = `Open ${state.settings?.saveDirectory || "the ShotTap folder"}`;
  }

  function renderRecordingBar() {
    const active = isRecording();
    elements.recordingBar.hidden = !active;

    if (recordingTimer) {
      clearInterval(recordingTimer);
      recordingTimer = null;
    }

    if (!active) {
      return;
    }

    const tick = () => {
      const startedAt = state.recording.startedAt;
      elements.recordingTime.textContent = startedAt ? format.duration(Date.now() - startedAt) : "00:00";
    };

    tick();
    recordingTimer = setInterval(tick, 500);
  }

  // -------------------------------------------------------------------------
  // Quick capture panel
  // -------------------------------------------------------------------------
  function actionCard(action) {
    const status = shortcutStatusFor(action.id);
    const accelerator = shortcutFor(action.id);
    const recordingNow = isRecording() && action.kind === "record";
    const label = recordingNow ? "Stop Recording" : action.label;
    const iconName = recordingNow ? "stop" : action.icon;
    const disabled = isRecording() && action.kind !== "record" && action.id !== "copyAll";

    const shortcutLine =
      status === "active"
        ? `<kbd>${format.escapeHtml(accelerator)}</kbd>`
        : `<span class="shortcut-warning">${status === "conflict" ? "Shortcut conflict" : "Shortcut inactive"}</span>`;

    return `
      <button class="action-card ${recordingNow ? "recording" : ""}" type="button" data-action="${action.id}" data-kind="${action.kind}" ${disabled ? "disabled" : ""} title="${format.escapeHtml(action.description)}">
        <span class="action-icon">${icons.icon(iconName, { size: 21 })}</span>
        <span class="action-name">${format.escapeHtml(label)}</span>
        ${shortcutLine}
      </button>`;
  }

  function renderQuickPanel() {
    return `
      <section class="panel hotkey-panel">
        <div class="hotkey-head">
          <span class="hotkey-head-icon">${icons.icon("zap", { size: 19 })}</span>
          <div class="hotkey-head-text">
            <h2>Capture faster with hotkeys</h2>
            <p>ShotTap runs in the background — every action below has a global shortcut that works from any application.</p>
          </div>
          <button class="button" type="button" data-navigate="hotkeys">${icons.icon("keyboard", { size: 16 })} Customize Hotkeys</button>
        </div>
        <div class="action-groups">
          ${ACTION_GROUPS.map(
            (group) => `
            <div class="action-group" data-kind="${group.kind}">
              <div class="action-group-title">
                ${icons.icon(group.kind === "screenshot" ? "image" : group.kind === "record" ? "recordFull" : "copy", { size: 13 })}
                ${group.title}
              </div>
              <div class="action-list">
                ${group.ids.map((id) => actionCard(ACTIONS.find((action) => action.id === id))).join("")}
              </div>
            </div>`
          ).join("")}
        </div>
      </section>`;
  }

  // -------------------------------------------------------------------------
  // Library views
  // -------------------------------------------------------------------------
  function thumbFor(item) {
    if (item.thumb) {
      return `<img src="${format.mediaUrl(item.thumb, item.editedAt || item.createdAt)}" alt="" loading="lazy" />`;
    }

    if (item.type === "image") {
      return `<img src="${format.mediaUrl(item.relPath, item.editedAt || item.createdAt)}" alt="" loading="lazy" />`;
    }

    return `<span class="thumb-fallback">${icons.icon("video", { size: 26 })}</span>`;
  }

  function mediaCard(item) {
    const selected = item.id === state.selectedId;

    return `
      <article class="media-card" data-id="${item.id}" aria-selected="${selected}" tabindex="0" role="button">
        <div class="media-thumb">
          ${thumbFor(item)}
          <span class="thumb-badge">${format.escapeHtml(item.format || (item.type === "video" ? "WEBM" : "PNG"))}</span>
          ${item.type === "video" ? `<span class="thumb-duration">${format.duration(item.durationMs)}</span><span class="thumb-play"><span>${icons.icon("play", { size: 16 })}</span></span>` : ""}
          ${selected ? `<span class="select-mark">${icons.icon("check", { size: 13 })}</span>` : ""}
        </div>
        <div class="media-body">
          <div class="media-title-row">
            <span class="media-title" title="${format.escapeHtml(item.name)}">${format.escapeHtml(item.name)}</span>
            <button class="star-button" type="button" data-star="${item.id}" aria-pressed="${item.favorite}" aria-label="${item.favorite ? "Remove from favorites" : "Add to favorites"}" title="${item.favorite ? "Remove from favorites" : "Add to favorites"}">${icons.icon("star", { size: 15 })}</button>
            <button class="star-button" type="button" data-menu="${item.id}" aria-label="More actions" title="More actions">${icons.icon("more", { size: 15 })}</button>
          </div>
          <div class="media-meta">
            <span>${format.shortDate(item.createdAt)}</span>
            <span class="dot-sep">${format.fileSize(item.size)}</span>
          </div>
        </div>
      </article>`;
  }

  function mediaRow(item) {
    return `
      <button class="media-row" type="button" data-id="${item.id}" aria-selected="${item.id === state.selectedId}">
        <img class="row-thumb" src="${format.mediaUrl(item.thumb || item.relPath, item.editedAt || item.createdAt)}" alt="" loading="lazy" />
        <span class="row-name">${format.escapeHtml(item.name)}</span>
        <span class="row-meta">${format.escapeHtml(item.format)}${item.type === "video" ? ` · ${format.duration(item.durationMs)}` : ""}</span>
        <span class="row-meta hide-narrow">${item.width} × ${item.height} · ${format.sourceLabel(item.source)}</span>
        <span class="row-meta">${format.fileSize(item.size)}</span>
        <span class="row-actions">
          <span class="star-button" data-star="${item.id}" role="button" aria-pressed="${item.favorite}" aria-label="Toggle favorite" title="Toggle favorite">${icons.icon("star", { size: 15 })}</span>
          <span class="star-button" data-menu="${item.id}" role="button" aria-label="More actions" title="More actions">${icons.icon("more", { size: 15 })}</span>
        </span>
      </button>`;
  }

  const EMPTY_STATES = {
    captures: {
      icon: "image",
      title: "No screenshots yet",
      body: "Use Screenshot Area or Screenshot Full Screen above — or press the hotkey from any application without opening ShotTap.",
      action: "screenshotArea"
    },
    recordings: {
      icon: "video",
      title: "No recordings yet",
      body: "Start a screen or area recording using the controls above, or press your recording hotkey from anywhere.",
      action: "recordFullScreen"
    },
    clipboard: {
      icon: "clipboard",
      title: "Nothing captured this session",
      body: "Everything you capture while ShotTap is running is queued here, ready for Copy All.",
      action: "screenshotArea"
    },
    favorites: {
      icon: "star",
      title: "No favorites yet",
      body: "Star a screenshot or recording and it will show up here for quick access.",
      action: null
    },
    trash: {
      icon: "trash",
      title: "Trash is empty",
      body: "Deleted captures wait here until you restore them or delete them permanently.",
      action: null
    },
    editor: {
      icon: "pencil",
      title: "Nothing to edit yet",
      body: "Take a screenshot and it will appear here, ready for pencil and eraser markup.",
      action: "screenshotArea"
    },
    filtered: {
      icon: "search",
      title: "Nothing matches",
      body: "No capture matches the current search or filter. Clear them to see everything again.",
      action: null
    }
  };

  function emptyState(key) {
    const config = EMPTY_STATES[key] || EMPTY_STATES.captures;
    const action = config.action ? ACTIONS.find((entry) => entry.id === config.action) : null;
    const status = action ? shortcutStatusFor(action.id) : null;

    return `
      <div class="empty-state">
        <span class="empty-icon">${icons.icon(config.icon, { size: 24 })}</span>
        <h3>${config.title}</h3>
        <p>${config.body}</p>
        ${
          action
            ? `<div class="empty-hint">
                 <button class="button primary" type="button" data-action="${action.id}">${icons.icon(action.icon, { size: 15 })} ${action.label}</button>
                 ${status === "active" ? `<span>or press <kbd>${format.escapeHtml(shortcutFor(action.id))}</kbd> anywhere</span>` : ""}
               </div>`
            : ""
        }
      </div>`;
  }

  function libraryToolbar(view, total, shown) {
    const showTrashTools = view === "trash";
    const showCaptureTools = view === "captures";
    const showClipboardTools = view === "clipboard";
    const trashCount = counts().trash;

    return `
      <div class="view-head">
        <div class="view-title">
          <h1>${VIEWS[view].label}</h1>
          <p>${shown === total ? `${total} item${total === 1 ? "" : "s"}` : `${shown} of ${total} items`}</p>
        </div>
        <div class="view-tools">
          ${
            showTrashTools
              ? `<button class="button" type="button" data-command="empty-trash" ${total === 0 ? "disabled" : ""}>${icons.icon("trash", { size: 15 })} Empty Trash</button>`
              : ""
          }
          ${
            showCaptureTools
              ? `<button class="button danger" type="button" data-command="trash-captures" ${total === 0 ? "disabled" : ""}>${icons.icon("trash", { size: 15 })} Clear Captures</button>
                 <button class="button" type="button" data-command="empty-trash" ${trashCount === 0 ? "disabled" : ""}>${icons.icon("trash", { size: 15 })} Empty Trash</button>`
              : ""
          }
          ${
            showClipboardTools
              ? `<button class="button danger" type="button" data-command="trash-clipboard" ${total === 0 ? "disabled" : ""}>${icons.icon("trash", { size: 15 })} Move Queue to Trash</button>
                 <button class="button" type="button" data-command="clear-capture-queue" ${total === 0 ? "disabled" : ""}>${icons.icon("close", { size: 15 })} Clear Queue</button>
                 <button class="button" type="button" data-command="empty-trash" ${trashCount === 0 ? "disabled" : ""}>${icons.icon("trash", { size: 15 })} Empty Trash</button>`
              : ""
          }
          <div class="segmented" role="group" aria-label="Layout">
            <button type="button" data-layout="grid" aria-pressed="${state.layout === "grid"}" aria-label="Grid view" title="Grid view">${icons.icon("grid", { size: 15 })}</button>
            <button type="button" data-layout="list" aria-pressed="${state.layout === "list"}" aria-label="List view" title="List view">${icons.icon("list", { size: 15 })}</button>
          </div>
          <select class="field" data-control="sort" aria-label="Sort by">
            <option value="newest" ${state.sort === "newest" ? "selected" : ""}>Sort: Newest</option>
            <option value="oldest" ${state.sort === "oldest" ? "selected" : ""}>Sort: Oldest</option>
            <option value="name" ${state.sort === "name" ? "selected" : ""}>Sort: Name</option>
            <option value="size" ${state.sort === "size" ? "selected" : ""}>Sort: File size</option>
          </select>
          <select class="field" data-control="filter" aria-label="Filter">
            <option value="all" ${state.filter === "all" ? "selected" : ""}>All captures</option>
            <option value="favorites" ${state.filter === "favorites" ? "selected" : ""}>Favorites only</option>
            <option value="area" ${state.filter === "area" ? "selected" : ""}>Selected area</option>
            <option value="fullscreen" ${state.filter === "fullscreen" ? "selected" : ""}>Full screen</option>
          </select>
          <div class="search-box">
            ${icons.icon("search", { size: 15 })}
            <input class="field" type="search" data-control="search" placeholder="Search captures" aria-label="Search captures" value="${format.escapeHtml(state.search)}" />
          </div>
        </div>
      </div>`;
  }

  function renderLibraryView(view) {
    const all = itemsForView(view);
    const visible = applyFilters(all);
    const showQuickPanel = view === "captures" || view === "recordings";
    const body =
      visible.length === 0
        ? emptyState(all.length === 0 ? view : "filtered")
        : state.layout === "grid"
          ? `<div class="media-grid">${visible.map(mediaCard).join("")}</div>`
          : `<div class="media-list">${visible.map(mediaRow).join("")}</div>`;

    const clipboardNote =
      view === "clipboard"
        ? `<div class="note" style="margin-bottom:16px">
             ${icons.icon("info", { size: 16 })}
             <span>
               This is the capture queue for the current ShotTap session — the exact set that
                <strong>Copy All</strong>, and every new screenshot while Auto copy is on, puts on the clipboard.
                ${state.lastCopy ? `Last copy: ${format.shortDate(state.lastCopy.at)} (${state.lastCopy.count} item${state.lastCopy.count === 1 ? "" : "s"}).` : "Nothing has been copied yet."}
              </span>
              <div class="note-actions">
                <button class="button small primary" type="button" data-action="copyAll" ${all.length === 0 ? "disabled" : ""}>${icons.icon("copy", { size: 14 })} Copy All</button>
                <button class="button small" type="button" data-command="clear-clipboard">${icons.icon("close", { size: 14 })} Clear Clipboard</button>
              </div>
            </div>`
        : "";

    return `${showQuickPanel ? renderQuickPanel() : ""}${libraryToolbar(view, all.length, visible.length)}${clipboardNote}${body}`;
  }

  function renderEditorView() {
    const images = applyFilters(itemsForView("editor"));

    return `
      <div class="view-head">
        <div class="view-title">
          <h1>Editor</h1>
          <p>Pick a screenshot to mark up with the pencil and eraser. Recordings cannot be edited.</p>
        </div>
      </div>
      ${
        images.length === 0
          ? emptyState("editor")
          : `<div class="media-grid">${images.map((item) => mediaCard(item)).join("")}</div>`
      }`;
  }

  // -------------------------------------------------------------------------
  // Settings views
  // -------------------------------------------------------------------------
  function statusPill(action) {
    const status = shortcutStatusFor(action);
    const info = state.settings?.shortcutStatus?.[action] || {};
    const config = {
      active: { icon: "check", label: "Active" },
      failed: { icon: "alert", label: "Not registered" },
      conflict: { icon: "alert", label: "Conflict" },
      suspended: { icon: "minus", label: "Paused" }
    }[status] || { icon: "alert", label: "Unknown" };

    return `<span class="status-pill" data-status="${status}" title="${format.escapeHtml(info.message || config.label)}">${icons.icon(config.icon, { size: 13 })}${config.label}</span>`;
  }

  function renderHotkeysView() {
    return `
      <div class="view-head">
        <div class="view-title">
          <h1>Hotkeys</h1>
          <p>Global shortcuts work while ShotTap is in the background. A shortcut is only shown as Active once Windows has actually granted it.</p>
        </div>
      </div>
      <div class="settings-stack">
        <section class="panel setting-card">
          ${ACTIONS.map(
            (action) => `
            <div class="hotkey-row" data-kind="${action.kind}">
              <span class="hotkey-icon">${icons.icon(action.icon, { size: 18 })}</span>
              <div class="hotkey-info">
                <strong>${action.label}</strong>
                <span>${action.description}</span>
              </div>
              <div class="hotkey-binding">
                ${statusPill(action.id)}
                <button class="shortcut-button ${state.listeningAction === action.id ? "listening" : ""}" type="button" data-shortcut="${action.id}">
                  ${state.listeningAction === action.id ? "Press keys…" : format.escapeHtml(format.accelerator(shortcutFor(action.id)))}
                </button>
              </div>
            </div>`
          ).join("")}
        </section>
        <div class="note">
          ${icons.icon("info", { size: 16 })}
          <span>
            Click a shortcut and press the new combination — every other ShotTap shortcut is paused while you do, so the
            old binding cannot fire. If Windows or another application already owns the combination, registration fails and
            the change is rolled back rather than leaving a shortcut that never fires. Press Esc to cancel.
          </span>
        </div>
        <div class="note">
          ${icons.icon("recordFull", { size: 16 })}
          <span>The recording shortcuts are toggles: the same keys that start a recording stop it, so a recording started while ShotTap is hidden can always be stopped from the keyboard.</span>
        </div>
      </div>`;
  }

  function settingRow({ title, description, control }) {
    return `
      <div class="setting-row">
        <div class="setting-text">
          <strong>${title}</strong>
          <span>${description}</span>
        </div>
        <div class="setting-control">${control}</div>
      </div>`;
  }

  function toggleControl(name, checked, label) {
    return `<input class="switch" type="checkbox" data-preference="${name}" ${checked ? "checked" : ""} aria-label="${format.escapeHtml(label)}" />`;
  }

  function renderGeneralView() {
    const preferences = state.settings.preferences;

    return `
      <div class="view-head">
        <div class="view-title">
          <h1>General</h1>
          <p>Capture behaviour, recording quality and where ShotTap keeps your files.</p>
        </div>
      </div>
      <div class="settings-stack">
        <section class="panel setting-card">
          <div class="card-header">${icons.icon("image", { size: 16 })}<h2>After a screenshot</h2></div>
          ${settingRow({
            title: "Auto copy screenshots to clipboard",
            description: "Every screenshot is placed on the clipboard the moment it is taken. Once the session queue holds more than one, all of them go on together so a single paste drops the whole set.",
            control: toggleControl("autoCopyAfterCapture", preferences.autoCopyAfterCapture, "Auto copy screenshots to clipboard")
          })}
          ${settingRow({
            title: "Bring ShotTap forward after screenshot",
            description: "Off keeps the app in the background so the window you were working in stays active and Ctrl+V pastes straight away.",
            control: toggleControl("bringToFrontAfterCapture", preferences.bringToFrontAfterCapture, "Bring ShotTap forward after screenshot")
          })}
        </section>

        <section class="panel setting-card">
          <div class="card-header">${icons.icon("recordFull", { size: 16 })}<h2>Recording</h2></div>
          ${settingRow({
            title: "Record system audio",
            description: "Captures what the computer is playing. If Windows refuses the loopback stream the recording continues without audio and says so.",
            control: toggleControl("recordSystemAudio", preferences.recordSystemAudio, "Record system audio")
          })}
          ${settingRow({
            title: "Record microphone",
            description: "Mixes your microphone into the recording alongside system audio.",
            control: toggleControl("recordMicrophone", preferences.recordMicrophone, "Record microphone")
          })}
          ${settingRow({
            title: "Recording quality",
            description: "Native records at the display's own resolution. The other options scale the video down before encoding.",
            control: `<select class="field" data-preference-select="recordingQuality" aria-label="Recording quality">
                ${["native", "1080p", "720p"]
                  .map(
                    (value) =>
                      `<option value="${value}" ${preferences.recordingQuality === value ? "selected" : ""}>${value === "native" ? "Native resolution" : value}</option>`
                  )
                  .join("")}
              </select>`
          })}
          ${settingRow({
            title: "Frame rate",
            description: "Frames per second requested from the display stream.",
            control: `<select class="field" data-preference-select="recordingFrameRate" aria-label="Frame rate">
                ${[24, 30, 60]
                  .map(
                    (value) =>
                      `<option value="${value}" ${Number(preferences.recordingFrameRate) === value ? "selected" : ""}>${value} FPS</option>`
                  )
                  .join("")}
              </select>`
          })}
          ${settingRow({
            title: "Recording format",
            description: "Recordings are written as WebM (VP9 when the encoder supports it, otherwise VP8) with Opus audio.",
            control: `<span class="badge">WEBM</span>`
          })}
        </section>

        <section class="panel setting-card">
          <div class="card-header">${icons.icon("folder", { size: 16 })}<h2>Save location</h2></div>
          ${settingRow({
            title: "ShotTap folder",
            description: `Screenshots go to <code>Screenshots</code>, recordings to <code>Recordings</code>, deleted items to <code>Trash</code>.<br />${format.escapeHtml(state.settings.saveDirectory)}`,
            control: `<button class="button" type="button" data-command="open-folder">${icons.icon("open", { size: 15 })} Open</button>
                      <button class="button" type="button" data-command="choose-folder">${icons.icon("folder", { size: 15 })} Change…</button>`
          })}
        </section>
      </div>`;
  }

  function renderAppearanceView() {
    const theme = state.settings.appearance.theme;
    const options = [
      { id: "system", title: "System", description: "Follow the Windows theme" },
      { id: "light", title: "Light", description: "Always light" },
      { id: "dark", title: "Dark", description: "Always dark" }
    ];

    return `
      <div class="view-head">
        <div class="view-title">
          <h1>Appearance</h1>
          <p>The theme applies immediately and is remembered between launches.</p>
        </div>
      </div>
      <div class="settings-stack">
        <section class="panel setting-card">
          <div class="card-header">${icons.icon("palette", { size: 16 })}<h2>Theme</h2></div>
          <div class="theme-options">
            ${options
              .map(
                (option) => `
              <button class="theme-option" type="button" data-theme="${option.id}" aria-pressed="${theme === option.id}">
                <span class="theme-swatch" data-variant="${option.id}">
                  <span class="swatch-nav"></span>
                  <span class="swatch-body">
                    <span class="swatch-line accent" style="width:60%"></span>
                    <span class="swatch-line" style="width:85%"></span>
                    <span class="swatch-line" style="width:70%"></span>
                  </span>
                </span>
                <strong>${option.title}</strong>
                <span>${option.description}</span>
              </button>`
              )
              .join("")}
          </div>
        </section>
      </div>`;
  }

  function renderAboutView() {
    const info = state.info || {};

    return `
      <div class="view-head">
        <div class="view-title">
          <h1>About ShotTap</h1>
          <p>Version and runtime information for this installation.</p>
        </div>
      </div>
      <div class="settings-stack">
        <section class="panel setting-card">
          <div class="about-head">
            <span class="about-mark"><img src="./assets/shottap-mark.png" alt="" /></span>
            <div>
              <h1>ShotTap</h1>
              <p>Fast screenshots and screen recordings driven by global hotkeys.</p>
            </div>
          </div>
          ${settingRow({ title: "Version", description: "Installed ShotTap build", control: `<span class="badge">${format.escapeHtml(info.version || "—")}</span>` })}
          ${settingRow({ title: "Electron", description: "Application runtime", control: `<span class="badge">${format.escapeHtml(info.electron || "—")}</span>` })}
          ${settingRow({ title: "Chromium", description: "Rendering and capture engine", control: `<span class="badge">${format.escapeHtml(info.chrome || "—")}</span>` })}
          ${settingRow({ title: "Node", description: "Main process runtime", control: `<span class="badge">${format.escapeHtml(info.node || "—")}</span>` })}
          ${settingRow({ title: "Platform", description: "Operating system and architecture", control: `<span class="badge">${format.escapeHtml(info.platform || "—")}</span>` })}
        </section>
      </div>`;
  }

  // -------------------------------------------------------------------------
  // Inspector
  // -------------------------------------------------------------------------
  function inspectorAction(command, iconName, label, options = {}) {
    return `<button class="inspector-action ${options.destructive ? "destructive" : ""}" type="button" data-item-command="${command}" title="${label}" aria-label="${label}">${icons.icon(iconName, { size: 17 })}<span>${label}</span></button>`;
  }

  function renderInspector() {
    const item = selectedItem();

    if (!item) {
      elements.inspector.hidden = true;
      elements.inspector.innerHTML = "";
      return;
    }

    const preferences = state.settings.preferences;
    const isVideo = item.type === "video";
    const version = item.editedAt || item.createdAt;
    const inTrash = Boolean(item.trashedAt);
    const fullPath = `${state.settings.saveDirectory}\\${item.relPath.replace(/\//g, "\\")}`;

    const preview = isVideo
      ? `<video src="${format.mediaUrl(item.relPath, version)}" controls preload="metadata" ${item.thumb ? `poster="${format.mediaUrl(item.thumb, version)}"` : ""}></video>`
      : `<img src="${format.mediaUrl(item.relPath, version)}" alt="${format.escapeHtml(item.name)}" />`;

    const actions = inTrash
      ? [inspectorAction("restore", "restore", "Restore"), inspectorAction("delete", "trash", "Delete", { destructive: true })]
      : [
          inspectorAction("open", "open", isVideo ? "Play" : "Open"),
          !isVideo ? inspectorAction("copy", "copy", "Copy") : "",
          !isVideo ? inspectorAction("edit", "pencil", "Edit") : "",
          inspectorAction("reveal", "folder", "Folder"),
          inspectorAction("favorite", "star", item.favorite ? "Unstar" : "Star"),
          inspectorAction("trash", "trash", "Delete", { destructive: true })
        ];

    elements.inspector.hidden = false;
    elements.inspector.innerHTML = `
      <div class="inspector-head">
        <button class="icon-button" type="button" data-command="close-inspector" aria-label="Close details" title="Close details">${icons.icon("close", { size: 16 })}</button>
      </div>
      <div class="inspector-preview">${preview}</div>
      <div class="inspector-title">
        <h2>${format.escapeHtml(item.name)}</h2>
        <button class="star-button" type="button" data-star="${item.id}" aria-pressed="${item.favorite}" aria-label="${item.favorite ? "Remove from favorites" : "Add to favorites"}" title="${item.favorite ? "Remove from favorites" : "Add to favorites"}">${icons.icon("star", { size: 17 })}</button>
      </div>
      <p class="inspector-sub">
        ${format.escapeHtml(item.format)} ${isVideo ? "video" : "image"} · ${format.fileSize(item.size)} · ${item.width} × ${item.height}
        ${inTrash ? " · in Trash" : ""}
      </p>
      <div class="inspector-actions">${actions.join("")}</div>

      <div class="section-title">Details</div>
      <dl class="detail-list">
        <div class="detail-row"><dt>Captured</dt><dd>${format.relativeDate(item.createdAt)}</dd></div>
        ${isVideo ? `<div class="detail-row"><dt>Duration</dt><dd>${format.duration(item.durationMs)}</dd></div>` : ""}
        <div class="detail-row"><dt>Method</dt><dd>${format.sourceLabel(item.source)}</dd></div>
        <div class="detail-row"><dt>Dimensions</dt><dd>${item.width} × ${item.height}</dd></div>
        <div class="detail-row"><dt>File size</dt><dd>${format.fileSize(item.size)}</dd></div>
        ${item.editedAt ? `<div class="detail-row"><dt>Edited</dt><dd>${format.relativeDate(item.editedAt)}</dd></div>` : ""}
        <div class="detail-row"><dt>Saved to</dt><dd class="path" title="${format.escapeHtml(fullPath)}">${format.escapeHtml(fullPath)}</dd></div>
      </dl>

      <div class="section-title">Capture preferences</div>
      <div class="pref-row">
        <label for="inspectorAutoCopy">Auto copy to clipboard</label>
        <input class="switch" id="inspectorAutoCopy" type="checkbox" data-preference="autoCopyAfterCapture" ${preferences.autoCopyAfterCapture ? "checked" : ""} />
      </div>
      <div class="pref-row">
        <label for="inspectorBringToFront">Bring to front after capture</label>
        <input class="switch" id="inspectorBringToFront" type="checkbox" data-preference="bringToFrontAfterCapture" ${preferences.bringToFrontAfterCapture ? "checked" : ""} />
      </div>`;
  }

  // -------------------------------------------------------------------------
  // Render entry points
  // -------------------------------------------------------------------------
  function renderMain() {
    if (!state.settings) {
      return;
    }

    const renderers = {
      hotkeys: renderHotkeysView,
      general: renderGeneralView,
      appearance: renderAppearanceView,
      about: renderAboutView,
      editor: renderEditorView
    };

    elements.main.innerHTML = renderers[state.view] ? renderers[state.view]() : renderLibraryView(state.view);
  }

  function render() {
    renderNav();
    renderSidebarShortcut();
    renderMain();
    renderInspector();
    renderRecordingBar();
  }

  function navigate(view) {
    if (!VIEWS[view]) {
      return;
    }

    state.view = view;
    closeMenu();
    render();
    elements.main.scrollTop = 0;
  }

  // -------------------------------------------------------------------------
  // Toasts
  // -------------------------------------------------------------------------
  function showToast({ message, tone }) {
    const element = document.createElement("div");
    element.className = "toast";
    element.dataset.tone = tone || "info";
    element.innerHTML = `${icons.icon(tone === "error" ? "alert" : tone === "success" ? "check" : "info", { size: 16 })}<span>${format.escapeHtml(message)}</span>`;
    elements.toastHost.append(element);

    setTimeout(() => {
      element.style.transition = "opacity 200ms ease";
      element.style.opacity = "0";
      setTimeout(() => element.remove(), 220);
    }, 3400);

    while (elements.toastHost.children.length > 4) {
      elements.toastHost.firstElementChild.remove();
    }
  }

  // -------------------------------------------------------------------------
  // Item commands
  // -------------------------------------------------------------------------
  async function runItemCommand(command, id) {
    const item = state.items.find((entry) => entry.id === id);

    if (!item) {
      return;
    }

    switch (command) {
      case "open":
        await api.library.open(id);
        break;
      case "copy":
        await api.library.copy(id);
        break;
      case "edit":
        await window.SCEditor.open(item);
        break;
      case "reveal":
        await api.library.reveal(id);
        break;
      case "favorite":
        await api.library.setFavorite(id, !item.favorite);
        break;
      case "trash":
        await api.library.trash(id);

        if (state.selectedId === id) {
          state.selectedId = null;
        }

        break;
      case "restore":
        await api.library.restore(id);
        break;
      case "delete":
        await api.library.deletePermanently(id);

        if (state.selectedId === id) {
          state.selectedId = null;
        }

        break;
      default:
        break;
    }
  }

  function closeMenu() {
    if (openMenu) {
      openMenu.remove();
      openMenu = null;
    }
  }

  function openContextMenu(id, x, y) {
    closeMenu();

    const item = state.items.find((entry) => entry.id === id);

    if (!item) {
      return;
    }

    const entries = item.trashedAt
      ? [
          { command: "restore", icon: "restore", label: "Restore" },
          { command: "delete", icon: "trash", label: "Delete permanently", destructive: true }
        ]
      : [
          { command: "open", icon: "open", label: item.type === "video" ? "Play video" : "Open" },
          ...(item.type === "image"
            ? [
                { command: "edit", icon: "pencil", label: "Edit image" },
                { command: "copy", icon: "copy", label: "Copy" }
              ]
            : []),
          { command: "reveal", icon: "folder", label: "Show in folder" },
          { command: "favorite", icon: "star", label: item.favorite ? "Remove from favorites" : "Add to favorites" },
          { separator: true },
          { command: "trash", icon: "trash", label: "Move to Trash", destructive: true }
        ];

    const menu = document.createElement("div");
    menu.className = "context-menu";
    menu.innerHTML = entries
      .map((entry) =>
        entry.separator
          ? "<hr />"
          : `<button type="button" data-item-command="${entry.command}" data-id="${id}" class="${entry.destructive ? "destructive" : ""}">${icons.icon(entry.icon, { size: 15 })}${entry.label}</button>`
      )
      .join("");

    document.body.append(menu);
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.min(x, window.innerWidth - rect.width - 8)}px`;
    menu.style.top = `${Math.min(y, window.innerHeight - rect.height - 8)}px`;
    openMenu = menu;
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------
  function selectItem(id) {
    state.selectedId = state.selectedId === id ? null : id;
    render();
  }

  async function trashItemsFromView(view) {
    const ids = itemsForView(view).map((item) => item.id);

    if (ids.length === 0) {
      return;
    }

    await api.library.trashMany(ids);

    if (ids.includes(state.selectedId)) {
      state.selectedId = null;
      render();
    }
  }

  document.addEventListener("click", async (event) => {
    const target = event.target;

    const menuButton = target.closest("[data-menu]");

    if (menuButton) {
      event.stopPropagation();
      const rect = menuButton.getBoundingClientRect();
      openContextMenu(menuButton.dataset.menu, rect.left, rect.bottom + 4);
      return;
    }

    closeMenu();

    const star = target.closest("[data-star]");

    if (star) {
      event.stopPropagation();
      const item = state.items.find((entry) => entry.id === star.dataset.star);
      await api.library.setFavorite(star.dataset.star, !item?.favorite);
      return;
    }

    const itemCommand = target.closest("[data-item-command]");

    if (itemCommand) {
      event.stopPropagation();
      await runItemCommand(itemCommand.dataset.itemCommand, itemCommand.dataset.id || state.selectedId);
      return;
    }

    const actionButton = target.closest("[data-action]");

    if (actionButton) {
      const action = actionButton.dataset.action;

      if (isRecording() && (action === "recordArea" || action === "recordFullScreen")) {
        await api.stopRecording();
      } else {
        await api.run(action);
      }

      return;
    }

    const navButton = target.closest("[data-view]");

    if (navButton) {
      navigate(navButton.dataset.view);
      return;
    }

    const navigateButton = target.closest("[data-navigate]");

    if (navigateButton) {
      navigate(navigateButton.dataset.navigate);
      return;
    }

    const layoutButton = target.closest("[data-layout]");

    if (layoutButton) {
      state.layout = layoutButton.dataset.layout;
      render();
      return;
    }

    const themeButton = target.closest("[data-theme]");

    if (themeButton) {
      const payload = await api.settings.update({ appearance: { theme: themeButton.dataset.theme } });
      state.settings = payload;
      render();
      return;
    }

    const shortcutButton = target.closest("[data-shortcut]");

    if (shortcutButton) {
      startShortcutCapture(shortcutButton.dataset.shortcut);
      return;
    }

    const commandButton = target.closest("[data-command]");

    if (commandButton) {
      const command = commandButton.dataset.command;

      if (command === "close-inspector") {
        state.selectedId = null;
        render();
      } else if (command === "empty-trash") {
        await api.library.emptyTrash();
      } else if (command === "trash-captures") {
        await trashItemsFromView("captures");
      } else if (command === "trash-clipboard") {
        await trashItemsFromView("clipboard");
      } else if (command === "clear-capture-queue") {
        await api.clearCaptureQueue();
      } else if (command === "clear-clipboard") {
        await api.clearClipboard();
      } else if (command === "open-folder") {
        await api.settings.openDirectory();
      } else if (command === "choose-folder") {
        const result = await api.settings.chooseDirectory();

        if (result?.settings) {
          state.settings = result.settings;
          render();
        }
      }

      return;
    }

    const card = target.closest("[data-id]");

    if (card) {
      if (state.view === "editor") {
        const item = state.items.find((entry) => entry.id === card.dataset.id);

        if (item) {
          await window.SCEditor.open(item);
        }

        return;
      }

      selectItem(card.dataset.id);
    }
  });

  document.addEventListener("contextmenu", (event) => {
    const card = event.target.closest("[data-id]");

    if (card) {
      event.preventDefault();
      openContextMenu(card.dataset.id, event.clientX, event.clientY);
    }
  });

  document.addEventListener("dblclick", async (event) => {
    const card = event.target.closest("[data-id]");

    if (card) {
      const item = state.items.find((entry) => entry.id === card.dataset.id);

      if (item && !item.trashedAt) {
        await api.library.open(item.id);
      }
    }
  });

  elements.main.addEventListener("change", async (event) => {
    const control = event.target;

    if (control.dataset.control === "sort") {
      state.sort = control.value;
      renderMain();
    } else if (control.dataset.control === "filter") {
      state.filter = control.value;
      renderMain();
    } else if (control.dataset.preferenceSelect) {
      const value =
        control.dataset.preferenceSelect === "recordingFrameRate" ? Number(control.value) : control.value;
      state.settings = await api.settings.update({ preferences: { [control.dataset.preferenceSelect]: value } });
    }
  });

  elements.main.addEventListener("input", (event) => {
    if (event.target.dataset.control === "search") {
      state.search = event.target.value;
      const selectionStart = event.target.selectionStart;
      renderMain();
      const nextInput = elements.main.querySelector('[data-control="search"]');

      if (nextInput) {
        nextInput.focus();
        nextInput.setSelectionRange(selectionStart, selectionStart);
      }
    }
  });

  // Preference switches exist in both Settings and the inspector; both write the
  // same setting and every copy re-renders from the returned state.
  document.addEventListener("change", async (event) => {
    const control = event.target;

    if (!control.dataset.preference) {
      return;
    }

    state.settings = await api.settings.update({
      preferences: { [control.dataset.preference]: control.checked }
    });
    render();
  });

  elements.quickCapture.addEventListener("click", () => api.run("screenshotArea"));
  elements.storageCard.addEventListener("click", () => api.settings.openDirectory());
  elements.stopRecordingButton.addEventListener("click", () => api.stopRecording());

  // -------------------------------------------------------------------------
  // Shortcut capture
  // -------------------------------------------------------------------------
  const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta"]);

  function acceleratorFromEvent(event) {
    if (MODIFIER_KEYS.has(event.key)) {
      return "";
    }

    const parts = [];

    if (event.ctrlKey) {
      parts.push("Ctrl");
    }

    if (event.altKey) {
      parts.push("Alt");
    }

    if (event.shiftKey) {
      parts.push("Shift");
    }

    if (event.metaKey) {
      parts.push("Super");
    }

    let key = "";

    if (event.code.startsWith("Key")) {
      key = event.code.slice(3);
    } else if (event.code.startsWith("Digit")) {
      key = event.code.slice(5);
    } else if (event.code.startsWith("Numpad")) {
      key = `num${event.code.slice(6).toLowerCase()}`;
    } else if (/^F\d{1,2}$/.test(event.code)) {
      key = event.code;
    } else {
      key = {
        Space: "Space",
        Enter: "Return",
        Tab: "Tab",
        Backspace: "Backspace",
        Delete: "Delete",
        Insert: "Insert",
        Home: "Home",
        End: "End",
        PageUp: "PageUp",
        PageDown: "PageDown",
        ArrowUp: "Up",
        ArrowDown: "Down",
        ArrowLeft: "Left",
        ArrowRight: "Right",
        Backquote: "`",
        Minus: "-",
        Equal: "=",
        BracketLeft: "[",
        BracketRight: "]",
        Backslash: "\\",
        Semicolon: ";",
        Quote: "'",
        Comma: ",",
        Period: ".",
        Slash: "/",
        PrintScreen: "PrintScreen"
      }[event.code] || "";
    }

    if (!key || parts.length === 0) {
      return "";
    }

    return [...parts, key].join("+");
  }

  async function startShortcutCapture(action) {
    if (state.listeningAction) {
      await stopShortcutCapture();
    }

    state.listeningAction = action;
    await api.settings.beginShortcutCapture();
    render();
  }

  async function stopShortcutCapture() {
    state.listeningAction = null;
    const result = await api.settings.endShortcutCapture();
    return result;
  }

  window.addEventListener("keydown", async (event) => {
    if (state.listeningAction) {
      event.preventDefault();
      event.stopPropagation();

      if (event.key === "Escape") {
        await stopShortcutCapture();
        render();
        return;
      }

      const accelerator = acceleratorFromEvent(event);

      if (!accelerator) {
        return;
      }

      const action = state.listeningAction;
      state.listeningAction = null;
      const result = await api.settings.setShortcut(action, accelerator);

      if (result?.settings) {
        state.settings = result.settings;
      }

      if (!result?.ok) {
        showToast({ message: result?.message || "That shortcut could not be used.", tone: "error" });
        await api.settings.endShortcutCapture();
      }

      render();
      return;
    }

    if (event.key === "Escape") {
      if (openMenu) {
        closeMenu();
      } else if (state.selectedId && !window.SCEditor.isOpen()) {
        state.selectedId = null;
        render();
      }
    }
  });

  window.addEventListener("blur", () => closeMenu());
  window.addEventListener("resize", () => closeMenu());

  // -------------------------------------------------------------------------
  // Main process events
  // -------------------------------------------------------------------------
  api.onLibrary((payload) => {
    state.items = payload.items;
    state.sessionItemIds = payload.sessionItemIds;
    state.lastCopy = payload.lastCopy;

    if (state.selectedId && !state.items.some((item) => item.id === state.selectedId)) {
      state.selectedId = null;
    }

    render();
  });

  api.onSettings((payload) => {
    state.settings = payload;
    render();
  });

  api.onRecording((payload) => {
    state.recording = payload;
    render();
  });

  api.onToast((payload) => showToast(payload));

  // -------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------
  async function boot() {
    const initial = await api.getState();
    state.settings = initial.settings;
    state.items = initial.library.items;
    state.sessionItemIds = initial.library.sessionItemIds;
    state.lastCopy = initial.library.lastCopy;
    state.recording = initial.recording;
    state.info = initial.info;

    renderStaticChrome();
    render();
    document.body.dataset.ready = "true";
  }

  boot();

  // Exposed for the automated self-test, which drives the real UI rather than a
  // mock of it.
  window.__shottapTest = {
    navigate,
    state,
    selectItem,
    runItemCommand
  };
})();
