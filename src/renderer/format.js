(function () {
  const timeFormatter = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
  const dateFormatter = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
  const fullFormatter = new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });

  function startOfDay(date) {
    const copy = new Date(date);
    copy.setHours(0, 0, 0, 0);

    return copy;
  }

  function relativeDate(value) {
    const date = new Date(value);
    const days = Math.round((startOfDay(new Date()) - startOfDay(date)) / 86400000);

    if (days === 0) {
      return `Today, ${timeFormatter.format(date)}`;
    }

    if (days === 1) {
      return `Yesterday, ${timeFormatter.format(date)}`;
    }

    if (days < 7) {
      return `${dateFormatter.format(date)}, ${timeFormatter.format(date)}`;
    }

    return fullFormatter.format(date);
  }

  function shortDate(value) {
    const date = new Date(value);
    const days = Math.round((startOfDay(new Date()) - startOfDay(date)) / 86400000);

    if (days === 0) {
      return `Today, ${timeFormatter.format(date)}`;
    }

    if (days === 1) {
      return `Yesterday, ${timeFormatter.format(date)}`;
    }

    return `${dateFormatter.format(date)}, ${timeFormatter.format(date)}`;
  }

  function fileSize(bytes) {
    if (!bytes) {
      return "—";
    }

    if (bytes < 1024) {
      return `${bytes} B`;
    }

    if (bytes < 1024 * 1024) {
      return `${Math.round(bytes / 1024)} KB`;
    }

    return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  }

  function duration(milliseconds) {
    const total = Math.max(0, Math.round((milliseconds || 0) / 1000));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    const pad = (value) => String(value).padStart(2, "0");

    return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
  }

  // "Ctrl+Alt+4" reads better as "Ctrl + Alt + 4" in the UI, but the value that
  // travels to the main process is always the raw accelerator.
  function accelerator(value) {
    return typeof value === "string" ? value.split("+").join(" + ") : "";
  }

  function sourceLabel(source) {
    return { area: "Selected area", fullscreen: "Full screen" }[source] || "Unknown";
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]
    );
  }

  // Media is served by the main process from the library folder only. The
  // cache buster keeps an edited screenshot from showing its stale pixels.
  function mediaUrl(relativePath, version) {
    if (!relativePath) {
      return "";
    }

    const encoded = relativePath.split("/").map(encodeURIComponent).join("/");

    return `shottap://app/media/${encoded}${version ? `?v=${encodeURIComponent(version)}` : ""}`;
  }

  window.SCFormat = {
    accelerator,
    duration,
    escapeHtml,
    fileSize,
    mediaUrl,
    relativeDate,
    shortDate,
    sourceLabel
  };
})();
