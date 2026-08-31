// Screenshot markup editor.
//
// Markup is kept as vectors, which makes undo/redo exact and keeps memory flat
// (no stack of full-size bitmaps). Saving writes the real PNG file through the
// main process instead of holding a second copy in the page.

(function () {
  const icons = window.SCIcons;

  const overlay = document.getElementById("editorOverlay");
  const canvas = document.getElementById("editorCanvas");
  const toolsHost = document.getElementById("editorTools");
  const actionsHost = document.getElementById("editorActions");
  const colorInput = document.getElementById("editorColor");
  const sizeInput = document.getElementById("editorSize");
  const sizeOutput = document.getElementById("editorSizevalue");
  const metaElement = document.getElementById("editorMeta");

  const context = canvas.getContext("2d");
  const markup = document.createElement("canvas");
  const markupContext = markup.getContext("2d");

  let baseImage = null;
  let item = null;
  let tool = "pen";
  let strokes = [];
  let redoStack = [];
  let currentStroke = null;
  let onClosed = null;
  let saving = false;

  const DRAW_TOOLS = [
    { id: "pen", icon: "pencil", title: "Pencil" },
    { id: "line", icon: "line", title: "Line" },
    { id: "rectangle", icon: "rectangle", title: "Rectangle" },
    { id: "ellipse", icon: "ellipse", title: "Ellipse" },
    { id: "eraser", icon: "eraser", title: "Eraser" }
  ];

  const isShapeTool = (name) => name === "line" || name === "rectangle" || name === "ellipse";

  function renderChrome() {
    toolsHost.innerHTML = `
      ${DRAW_TOOLS.map(
        (entry) =>
          `<button class="icon-button ${tool === entry.id ? "active" : ""}" data-tool="${entry.id}" type="button" title="${entry.title}" aria-label="${entry.title}" aria-pressed="${tool === entry.id}">${icons.icon(entry.icon)}</button>`
      ).join("")}
      <span style="width:1px;height:22px;background:var(--border);margin:0 4px"></span>
      <button class="icon-button" data-command="undo" type="button" title="Undo (Ctrl+Z)" aria-label="Undo" ${strokes.length === 0 ? "disabled" : ""}>${icons.icon("undo")}</button>
      <button class="icon-button" data-command="redo" type="button" title="Redo (Ctrl+Y)" aria-label="Redo" ${redoStack.length === 0 ? "disabled" : ""}>${icons.icon("redo")}</button>
    `;

    actionsHost.innerHTML = `
      <button class="button" data-command="cancel" type="button">Cancel</button>
      <button class="button primary" data-command="save" type="button" ${saving ? "disabled" : ""}>${icons.icon("save", { size: 16 })} Save</button>
    `;
  }

  function rectFromPoints(start, end, square = false) {
    let width = end.x - start.x;
    let height = end.y - start.y;

    if (square) {
      const size = Math.min(Math.abs(width), Math.abs(height));
      width = Math.sign(width || 1) * size;
      height = Math.sign(height || 1) * size;
    }

    return {
      x: Math.min(start.x, start.x + width),
      y: Math.min(start.y, start.y + height),
      width: Math.abs(width),
      height: Math.abs(height)
    };
  }

  function endPointForShape(start, end, constrain = false) {
    if (!constrain) {
      return end;
    }

    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const length = Math.max(Math.abs(dx), Math.abs(dy));

    if (length === 0) {
      return end;
    }

    return {
      x: start.x + Math.sign(dx || 1) * length,
      y: start.y + Math.sign(dy || 1) * length
    };
  }

  function drawPathTool(target, stroke) {
    if (stroke.points.length === 0) {
      return;
    }

    target.save();
    target.lineCap = "round";
    target.lineJoin = "round";
    target.lineWidth = stroke.size;

    if (stroke.tool === "eraser") {
      target.globalCompositeOperation = "destination-out";
      target.strokeStyle = "rgba(0,0,0,1)";
    } else {
      target.globalCompositeOperation = "source-over";
      target.strokeStyle = stroke.color;
    }

    target.beginPath();
    target.moveTo(stroke.points[0].x, stroke.points[0].y);

    for (const point of stroke.points.slice(1)) {
      target.lineTo(point.x, point.y);
    }

    if (stroke.points.length === 1) {
      target.lineTo(stroke.points[0].x + 0.01, stroke.points[0].y + 0.01);
    }

    target.stroke();
    target.restore();
  }

  function drawShapeTool(target, stroke) {
    if (stroke.points.length < 2) {
      drawPathTool(target, stroke);
      return;
    }

    const start = stroke.points[0];
    const end = stroke.points[stroke.points.length - 1];

    target.save();
    target.globalCompositeOperation = "source-over";
    target.strokeStyle = stroke.color;
    target.lineWidth = stroke.size;
    target.lineCap = "round";
    target.lineJoin = "round";
    target.beginPath();

    if (stroke.tool === "line") {
      const constrained = endPointForShape(start, end, stroke.constrain);
      target.moveTo(start.x, start.y);
      target.lineTo(constrained.x, constrained.y);
    } else {
      const rect = rectFromPoints(start, end, stroke.constrain);

      if (stroke.tool === "ellipse") {
        target.ellipse(
          rect.x + rect.width / 2,
          rect.y + rect.height / 2,
          Math.max(0.5, rect.width / 2),
          Math.max(0.5, rect.height / 2),
          0,
          0,
          Math.PI * 2
        );
      } else {
        target.rect(rect.x, rect.y, rect.width, rect.height);
      }
    }

    target.stroke();
    target.restore();
  }

  function drawMarkupItem(target, stroke) {
    if (isShapeTool(stroke.tool)) {
      drawShapeTool(target, stroke);
      return;
    }

    drawPathTool(target, stroke);
  }

  function renderMarkup() {
    markupContext.clearRect(0, 0, markup.width, markup.height);

    for (const stroke of strokes) {
      drawMarkupItem(markupContext, stroke);
    }

    if (currentStroke) {
      drawMarkupItem(markupContext, currentStroke);
    }
  }

  function composite() {
    context.clearRect(0, 0, canvas.width, canvas.height);

    if (baseImage) {
      context.drawImage(baseImage, 0, 0);
    }

    context.drawImage(markup, 0, 0);
  }

  function redraw() {
    renderMarkup();
    composite();
  }

  function pointFrom(event) {
    const rect = canvas.getBoundingClientRect();

    return {
      x: ((event.clientX - rect.left) * canvas.width) / rect.width,
      y: ((event.clientY - rect.top) * canvas.height) / rect.height
    };
  }

  function loadImage(source) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("The screenshot could not be loaded."));
      image.src = source;
    });
  }

  async function open(mediaItem, options = {}) {
    if (!mediaItem || mediaItem.type !== "image") {
      return false;
    }

    item = mediaItem;
    onClosed = options.onClosed || null;
    strokes = [];
    redoStack = [];
    currentStroke = null;
    saving = false;
    tool = "pen";

    baseImage = await loadImage(window.SCFormat.mediaUrl(mediaItem.relPath, mediaItem.editedAt || mediaItem.createdAt));
    canvas.width = baseImage.naturalWidth;
    canvas.height = baseImage.naturalHeight;
    markup.width = canvas.width;
    markup.height = canvas.height;
    metaElement.textContent = `${mediaItem.name} · ${canvas.width} × ${canvas.height}`;

    redraw();
    renderChrome();
    overlay.hidden = false;
    canvas.focus();

    return true;
  }

  function close() {
    overlay.hidden = true;
    baseImage = null;
    item = null;
    strokes = [];
    redoStack = [];
    currentStroke = null;

    if (onClosed) {
      const callback = onClosed;
      onClosed = null;
      callback();
    }
  }

  function undo() {
    if (strokes.length === 0) {
      return;
    }

    redoStack.push(strokes.pop());
    redraw();
    renderChrome();
  }

  function redo() {
    if (redoStack.length === 0) {
      return;
    }

    strokes.push(redoStack.pop());
    redraw();
    renderChrome();
  }

  async function save() {
    if (!item || saving) {
      return;
    }

    if (strokes.length === 0) {
      close();
      return;
    }

    saving = true;
    renderChrome();

    // Anything that throws between here and the end used to leave `saving`
    // stuck at true, disabling Save for the rest of the editor session with
    // nothing on screen to explain it.
    try {
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));

      if (!blob) {
        throw new Error("The edited image could not be encoded.");
      }

      const result = await window.shottap.library.saveEdit(item.id, await blob.arrayBuffer());

      if (result?.ok) {
        close();
        return;
      }
    } catch (_error) {
      // The main process reports the reason as a toast; the editor stays open
      // so the strokes are not lost.
    } finally {
      saving = false;
    }

    renderChrome();
  }

  canvas.addEventListener("pointerdown", (event) => {
    if (!baseImage || event.button !== 0) {
      return;
    }

    currentStroke = {
      tool,
      color: colorInput.value,
      size: Number(sizeInput.value),
      constrain: event.shiftKey,
      points: [pointFrom(event)]
    };

    try {
      canvas.setPointerCapture(event.pointerId);
    } catch (_error) {
      // Synthetic/self-test events and a few unusual input paths do not create
      // an active browser pointer capture target. Drawing can continue without
      // capture because moves over the canvas still arrive normally.
    }

    redraw();
  });

  canvas.addEventListener("pointermove", (event) => {
    if (!currentStroke) {
      return;
    }

    currentStroke.constrain = event.shiftKey;

    if (isShapeTool(currentStroke.tool)) {
      currentStroke.points[1] = pointFrom(event);
    } else {
      currentStroke.points.push(pointFrom(event));
    }

    redraw();
  });

  function endStroke(event) {
    if (!currentStroke) {
      return;
    }

    if (event?.type === "pointerup") {
      currentStroke.constrain = event.shiftKey;

      if (isShapeTool(currentStroke.tool)) {
        currentStroke.points[1] = pointFrom(event);
      }
    }

    strokes.push(currentStroke);
    redoStack = [];
    currentStroke = null;
    redraw();
    renderChrome();
  }

  canvas.addEventListener("pointerup", endStroke);
  canvas.addEventListener("pointercancel", endStroke);

  toolsHost.addEventListener("click", (event) => {
    const button = event.target.closest("button");

    if (!button) {
      return;
    }

    if (button.dataset.tool) {
      tool = button.dataset.tool;
      renderChrome();
    } else if (button.dataset.command === "undo") {
      undo();
    } else if (button.dataset.command === "redo") {
      redo();
    }
  });

  actionsHost.addEventListener("click", (event) => {
    const button = event.target.closest("button");

    if (!button) {
      return;
    }

    if (button.dataset.command === "save") {
      save();
    } else if (button.dataset.command === "cancel") {
      close();
    }
  });

  sizeInput.addEventListener("input", () => {
    sizeOutput.textContent = sizeInput.value;
  });

  overlay.addEventListener("pointerdown", (event) => {
    if (event.target === overlay) {
      close();
    }
  });

  window.addEventListener("keydown", (event) => {
    if (overlay.hidden) {
      return;
    }

    if (event.key === "Escape") {
      close();
    } else if (event.ctrlKey && event.key.toLowerCase() === "z") {
      event.preventDefault();
      undo();
    } else if (event.ctrlKey && (event.key.toLowerCase() === "y" || (event.shiftKey && event.key.toLowerCase() === "z"))) {
      event.preventDefault();
      redo();
    } else if (event.ctrlKey && event.key.toLowerCase() === "s") {
      event.preventDefault();
      save();
    }
  });

  window.SCEditor = {
    open,
    close,
    isOpen: () => !overlay.hidden,
    currentItemId: () => item?.id || null
  };
})();
