// One icon family for the whole app: 24x24, 2px stroke, round caps, inline SVG.
// Nothing is loaded from the network and no emoji or text glyphs are used as
// icons anywhere in the interface.

(function () {
  const PATHS = {
    screenshotArea:
      '<path d="M3 8V5.5A2.5 2.5 0 0 1 5.5 3H8"/><path d="M16 3h2.5A2.5 2.5 0 0 1 21 5.5V8"/><path d="M21 16v2.5a2.5 2.5 0 0 1-2.5 2.5H16"/><path d="M8 21H5.5A2.5 2.5 0 0 1 3 18.5V16"/><circle cx="12" cy="12" r="3.2"/>',
    screenshotFull:
      '<rect x="2.5" y="4" width="19" height="13.5" rx="2.5"/><path d="M9 21h6"/><path d="M12 17.5V21"/><circle cx="12" cy="10.7" r="2.6"/>',
    recordArea:
      '<path d="M3 8V5.5A2.5 2.5 0 0 1 5.5 3H8"/><path d="M16 3h2.5A2.5 2.5 0 0 1 21 5.5V8"/><path d="M21 16v2.5a2.5 2.5 0 0 1-2.5 2.5H16"/><path d="M8 21H5.5A2.5 2.5 0 0 1 3 18.5V16"/><circle class="fill" cx="12" cy="12" r="3.6"/>',
    recordFull: '<circle cx="12" cy="12" r="8.8"/><circle class="fill" cx="12" cy="12" r="4.4"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="2.5"/>',
    copy:
      '<rect x="9" y="9" width="12" height="12" rx="2.5"/><path d="M6 15H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1"/>',
    image:
      '<rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="8.6" cy="9.6" r="1.6"/><path d="m21 15.5-4.5-4.5L9 18.5"/>',
    video:
      '<rect x="2.5" y="6" width="13" height="12" rx="2.5"/><path d="m15.5 10.2 6-3.2v10l-6-3.2"/>',
    clipboard:
      '<path d="M9 4H6.5A2.5 2.5 0 0 0 4 6.5v12A2.5 2.5 0 0 0 6.5 21h11a2.5 2.5 0 0 0 2.5-2.5v-12A2.5 2.5 0 0 0 17.5 4H15"/><rect x="9" y="2.5" width="6" height="4" rx="1.4"/>',
    star:
      '<path d="m12 3.4 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9L12 3.4Z"/>',
    trash:
      '<path d="M3.8 6.5h16.4"/><path d="M9.6 10.5v6.6"/><path d="M14.4 10.5v6.6"/><path d="M5.8 6.5 6.8 20a1.5 1.5 0 0 0 1.5 1.4h7.4a1.5 1.5 0 0 0 1.5-1.4l1-13.5"/><path d="M9.2 6.5V4.2a1.4 1.4 0 0 1 1.4-1.4h2.8a1.4 1.4 0 0 1 1.4 1.4v2.3"/>',
    pencil:
      '<path d="M4 20.2 8.4 19 19.4 8a2.4 2.4 0 0 0-3.4-3.4L5 15.6 4 20.2Z"/><path d="m15.2 5.6 3.2 3.2"/>',
    keyboard:
      '<rect x="2.5" y="6" width="19" height="12" rx="2.5"/><path d="M6.5 10h.01"/><path d="M10 10h.01"/><path d="M13.5 10h.01"/><path d="M17.5 10h.01"/><path d="M8 14h8"/>',
    sliders:
      '<path d="M4 7h4"/><path d="M12 7h8"/><path d="M4 12h10"/><path d="M18 12h2"/><path d="M4 17h6"/><path d="M14 17h6"/><circle cx="10" cy="7" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="12" cy="17" r="2"/>',
    palette:
      '<path d="M12 3a9 9 0 1 0 0 18h1.4a2.1 2.1 0 0 0 0-4.2H13a2.1 2.1 0 0 1 0-4.2h3.9A4.1 4.1 0 0 0 21 8.5C21 5.4 17 3 12 3Z"/><circle class="fill" cx="7.6" cy="11.4" r="1.15"/><circle class="fill" cx="10.2" cy="7.4" r="1.15"/><circle class="fill" cx="15.3" cy="7.8" r="1.15"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 7.8h.01"/>',
    search: '<circle cx="10.8" cy="10.8" r="6.8"/><path d="m20 20-4.4-4.4"/>',
    grid:
      '<rect x="3.5" y="3.5" width="7" height="7" rx="1.8"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.8"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.8"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.8"/>',
    list: '<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3.5 6h.01"/><path d="M3.5 12h.01"/><path d="M3.5 18h.01"/>',
    filter: '<path d="M3.5 5.5h17l-6.6 7.6v5.7l-3.8 2v-7.7L3.5 5.5Z"/>',
    more: '<circle class="fill" cx="5.5" cy="12" r="1.6"/><circle class="fill" cx="12" cy="12" r="1.6"/><circle class="fill" cx="18.5" cy="12" r="1.6"/>',
    play: '<path class="fill" d="M8 5.2 19 12 8 18.8V5.2Z"/>',
    folder:
      '<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h3.2l2.1 2.4h7.7A2.5 2.5 0 0 1 21 9.9v7.6a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5v-10Z"/>',
    open: '<path d="M13.5 4H19a1 1 0 0 1 1 1v5.5"/><path d="m20 4-8.5 8.5"/><path d="M18.5 14v4.5a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2H10"/>',
    check: '<path d="m4.5 12.5 5 5 10-11"/>',
    close: '<path d="m5.5 5.5 13 13"/><path d="m18.5 5.5-13 13"/>',
    alert: '<path d="M12 4.2 21 19.5H3L12 4.2Z"/><path d="M12 10v4"/><path d="M12 17h.01"/>',
    zap: '<path d="M13.2 2.5 4.5 13.6h6.4l-1.1 7.9 8.7-11.1h-6.4l1.1-7.9Z"/>',
    undo: '<path d="M9.5 14 4.5 9l5-5"/><path d="M4.5 9h9.8a5.2 5.2 0 0 1 0 10.4H10"/>',
    redo: '<path d="M14.5 14l5-5-5-5"/><path d="M19.5 9H9.7a5.2 5.2 0 0 0 0 10.4H14"/>',
    eraser:
      '<path d="M8.6 19.4 3.6 14.4a2 2 0 0 1 0-2.8l7.8-7.8a2 2 0 0 1 2.8 0l5.6 5.6a2 2 0 0 1 0 2.8l-7.2 7.2H8.6Z"/><path d="m8 9 7 7"/><path d="M10.5 21.4H21"/>',
    line: '<path d="M5 19 19 5"/>',
    rectangle: '<rect x="4" y="6" width="16" height="12" rx="1.8"/>',
    ellipse: '<ellipse cx="12" cy="12" rx="8" ry="5.5"/>',
    restore: '<path d="M4 5.5v5h5"/><path d="M4.6 14a8 8 0 1 0 1.5-7"/>',
    chevronRight: '<path d="m9.5 5.5 6.5 6.5-6.5 6.5"/>',
    chevronDown: '<path d="m5.5 9.5 6.5 6.5 6.5-6.5"/>',
    minus: '<path d="M5 12h14"/>',
    dot: '<circle class="fill" cx="12" cy="12" r="4"/>',
    monitor: '<rect x="2.5" y="4" width="19" height="13.5" rx="2.5"/><path d="M9 21h6"/><path d="M12 17.5V21"/>',
    save: '<path d="M5 3.5h11L20.5 8v12.5a1 1 0 0 1-1 1h-14a1 1 0 0 1-1-1v-16a1 1 0 0 1 1-1Z"/><path d="M8 3.5v6h7v-6"/><path d="M8 21.5v-6h8v6"/>'
  };

  function icon(name, options = {}) {
    const path = PATHS[name];

    if (!path) {
      return "";
    }

    const size = options.size || 20;
    const className = options.className ? ` ${options.className}` : "";

    return `<svg class="icon${className}" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${path}</svg>`;
  }

  window.SCIcons = { icon, has: (name) => Boolean(PATHS[name]) };
})();
