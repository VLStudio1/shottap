// Range header parsing for the media protocol.
//
// No `electron` import, so the arithmetic can be exercised from plain node —
// which matters, because getting it wrong is silent: an end that is not clamped
// to the file makes Content-Length promise more bytes than the body carries,
// and Chromium fails the response rather than playing what it was sent.

const UNSATISFIABLE = Symbol("unsatisfiable range");

// Returns { start, end } (both inclusive, both inside the file), UNSATISFIABLE
// for a range that cannot be served, or null for anything unparseable —
// multi-range requests included, since answering those with a complete 200 is
// always legal.
function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());

  if (!match || (!match[1] && !match[2])) {
    return null;
  }

  let start;
  let end;

  if (match[1]) {
    start = Number(match[1]);
    end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  } else {
    // A suffix range ("bytes=-500") asks for the *last* 500 bytes.
    const suffixLength = Number(match[2]);

    if (suffixLength === 0) {
      return UNSATISFIABLE;
    }

    start = Math.max(0, size - suffixLength);
    end = size - 1;
  }

  if (size === 0 || start >= size || end < start) {
    return UNSATISFIABLE;
  }

  return { start, end };
}

module.exports = { UNSATISFIABLE, parseRange };
