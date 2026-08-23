// The recording engine.
//
// Runs in a hidden window because getDisplayMedia/MediaRecorder are renderer
// APIs. Every encoded chunk is handed to the main process the moment it
// arrives and is then dropped, so memory use stays flat no matter how long the
// recording runs.

const api = window.shottapRecorder;
const statusElement = document.getElementById("status");

const MIME_CANDIDATES = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm"
];

let active = null;

function setStatus(text) {
  statusElement.textContent = text;
}

function pickMimeType() {
  return MIME_CANDIDATES.find((candidate) => MediaRecorder.isTypeSupported(candidate)) || "";
}

function evenNumber(value) {
  const rounded = Math.max(2, Math.round(value));

  return rounded % 2 === 0 ? rounded : rounded - 1;
}

async function requestDisplayStream(config) {
  const constraints = {
    video: { frameRate: { ideal: config.frameRate, max: config.frameRate } },
    audio: Boolean(config.systemAudio)
  };

  if (!config.systemAudio) {
    return { stream: await navigator.mediaDevices.getDisplayMedia(constraints), warning: null };
  }

  try {
    const stream = await navigator.mediaDevices.getDisplayMedia(constraints);

    if (stream.getAudioTracks().length === 0) {
      return { stream, warning: "system audio was not available" };
    }

    return { stream, warning: null };
  } catch (_error) {
    // Losing loopback audio must not lose the recording.
    const stream = await navigator.mediaDevices.getDisplayMedia({ ...constraints, audio: false });

    return { stream, warning: "system audio was not available" };
  }
}

async function requestMicrophone() {
  try {
    return { stream: await navigator.mediaDevices.getUserMedia({ audio: true }), warning: null };
  } catch (_error) {
    return { stream: null, warning: "the microphone could not be opened" };
  }
}

function buildAudioTracks(sources) {
  const streams = sources.filter(Boolean);

  if (streams.length === 0) {
    return { tracks: [], audioContext: null };
  }

  if (streams.length === 1) {
    return { tracks: streams[0].getAudioTracks(), audioContext: null };
  }

  // Two sources: mix them so neither is dropped by the recorder.
  const audioContext = new AudioContext();
  const destination = audioContext.createMediaStreamDestination();

  for (const stream of streams) {
    audioContext.createMediaStreamSource(stream).connect(destination);
  }

  return { tracks: destination.stream.getAudioTracks(), audioContext };
}

async function attachVideoElement(stream) {
  const video = document.createElement("video");
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;

  await new Promise((resolve, reject) => {
    video.onloadedmetadata = resolve;
    video.onerror = () => reject(new Error("The screen stream could not be opened."));
  });

  await video.play();

  return video;
}

function computeGeometry(config, video) {
  // All crop maths uses the real stream size. The main process sends fractions
  // of the display so nothing here depends on an assumed DPI scale factor.
  const streamWidth = video.videoWidth;
  const streamHeight = video.videoHeight;
  let sx = 0;
  let sy = 0;
  let sw = streamWidth;
  let sh = streamHeight;

  if (config.crop) {
    sx = Math.max(0, Math.round(config.crop.x * streamWidth));
    sy = Math.max(0, Math.round(config.crop.y * streamHeight));
    sw = Math.min(streamWidth - sx, Math.round(config.crop.width * streamWidth));
    sh = Math.min(streamHeight - sy, Math.round(config.crop.height * streamHeight));
  }

  const scale = config.targetHeight && sh > config.targetHeight ? config.targetHeight / sh : 1;

  return {
    streamWidth,
    streamHeight,
    sx,
    sy,
    sw,
    sh,
    outWidth: evenNumber(sw * scale),
    outHeight: evenNumber(sh * scale),
    needsCanvas: Boolean(config.crop) || scale !== 1
  };
}

function startDrawLoop(video, geometry, frameRate) {
  const canvas = document.createElement("canvas");
  canvas.width = geometry.outWidth;
  canvas.height = geometry.outHeight;

  const context = canvas.getContext("2d", { alpha: false, desynchronized: true });
  const stream = canvas.captureStream(0);
  const track = stream.getVideoTracks()[0];
  const canRequestFrame = typeof track.requestFrame === "function";
  const fallbackStream = canRequestFrame ? null : canvas.captureStream(frameRate);

  const draw = () => {
    context.drawImage(
      video,
      geometry.sx,
      geometry.sy,
      geometry.sw,
      geometry.sh,
      0,
      0,
      geometry.outWidth,
      geometry.outHeight
    );

    if (canRequestFrame) {
      track.requestFrame();
    }
  };

  draw();
  // A timer rather than requestAnimationFrame: this window is hidden and rAF
  // does not run reliably for windows the compositor never paints.
  const timer = setInterval(draw, Math.max(8, Math.round(1000 / frameRate)));

  return {
    stream: fallbackStream || stream,
    canvas,
    stop: () => {
      clearInterval(timer);

      // Both streams come off the same canvas; when the fallback is in use the
      // zero-fps one is unused but still live.
      for (const candidate of [stream, fallbackStream]) {
        candidate?.getTracks().forEach((item) => item.stop());
      }
    }
  };
}

function capturePoster(video, geometry) {
  const canvas = document.createElement("canvas");
  const width = Math.min(520, geometry.outWidth);
  const scale = width / geometry.outWidth;
  canvas.width = Math.max(2, Math.round(width));
  canvas.height = Math.max(2, Math.round(geometry.outHeight * scale));
  canvas
    .getContext("2d")
    .drawImage(video, geometry.sx, geometry.sy, geometry.sw, geometry.sh, 0, 0, canvas.width, canvas.height);

  return canvas.toDataURL("image/jpeg", 0.8);
}

async function cleanup() {
  if (!active) {
    return;
  }

  const current = active;
  active = null;

  if (current.posterTimer) {
    clearTimeout(current.posterTimer);
  }

  if (current.drawLoop) {
    current.drawLoop.stop();
  }

  for (const stream of [current.displayStream, current.microphoneStream]) {
    stream?.getTracks().forEach((track) => track.stop());
  }

  current.recordedStream?.getTracks().forEach((track) => track.stop());

  if (current.audioContext) {
    await current.audioContext.close().catch(() => {});
  }

  if (current.video) {
    current.video.pause();
    current.video.srcObject = null;
  }

  return current;
}

async function start(config) {
  if (active) {
    return;
  }

  setStatus("Starting…");

  let displayStream = null;
  let microphoneStream = null;

  try {
    const warnings = [];
    const display = await requestDisplayStream(config);
    displayStream = display.stream;

    if (display.warning) {
      warnings.push(display.warning);
    }

    if (config.microphone) {
      const microphone = await requestMicrophone();
      microphoneStream = microphone.stream;

      if (microphone.warning) {
        warnings.push(microphone.warning);
      }
    }

    const video = await attachVideoElement(displayStream);
    const geometry = computeGeometry(config, video);
    const drawLoop = geometry.needsCanvas ? startDrawLoop(video, geometry, config.frameRate) : null;
    const videoTracks = drawLoop ? drawLoop.stream.getVideoTracks() : displayStream.getVideoTracks();
    const { tracks: audioTracks, audioContext } = buildAudioTracks([
      displayStream.getAudioTracks().length > 0 ? displayStream : null,
      microphoneStream
    ]);

    const recordedStream = new MediaStream([...videoTracks, ...audioTracks]);
    const mimeType = pickMimeType();

    if (!mimeType) {
      throw new Error("This build of Chromium cannot record WebM.");
    }

    const recorder = new MediaRecorder(recordedStream, {
      mimeType,
      videoBitsPerSecond: Math.min(
        14_000_000,
        Math.max(1_200_000, Math.round(geometry.outWidth * geometry.outHeight * config.frameRate * 0.08))
      )
    });

    let sequence = 0;
    let queue = Promise.resolve();

    recorder.ondataavailable = (event) => {
      if (!event.data || event.data.size === 0) {
        return;
      }

      const seq = sequence;
      sequence += 1;
      const blob = event.data;
      // Chained so chunks reach the main process in emission order even though
      // arrayBuffer() resolves asynchronously.
      queue = queue.then(async () => {
        const buffer = await blob.arrayBuffer();
        await api.chunk(seq, buffer);
      });
    };

    recorder.onerror = (event) => {
      stop(event.error?.message || "The recorder stopped unexpectedly.");
    };

    recorder.onstop = async () => {
      const current = active;
      const durationMs = current?.startedAt ? Math.round(performance.now() - current.startedAt) : 0;
      const failure = current?.failure || null;
      await queue;
      await cleanup();
      setStatus("Idle.");

      if (failure) {
        await api.failed(failure);
      } else {
        await api.finished({ durationMs, width: geometry.outWidth, height: geometry.outHeight });
      }
    };

    active = {
      recorder,
      displayStream,
      microphoneStream,
      recordedStream,
      audioContext,
      drawLoop,
      video,
      geometry,
      startedAt: performance.now(),
      posterTimer: null,
      failure: null
    };

    // If the user revokes the share from the OS bar, wrap up cleanly.
    displayStream.getVideoTracks()[0].addEventListener("ended", () => stop());

    recorder.start(config.chunkMs);
    active.posterTimer = setTimeout(() => {
      try {
        api.poster(capturePoster(video, geometry));
      } catch (_error) {
        // A missing poster only costs the tile its thumbnail.
      }
    }, 700);

    setStatus(`Recording ${geometry.outWidth}x${geometry.outHeight}`);
    await api.started({
      width: geometry.outWidth,
      height: geometry.outHeight,
      mimeType,
      warning: warnings.length > 0 ? warnings.join(" and ") : null
    });
  } catch (error) {
    const message = error.message || "Recording could not start.";

    // `active` may already be assigned — this can throw after the recorder is
    // running (a rejected `started` call, for one). Dropping the reference
    // without tearing the session down left the draw loop's interval running
    // for the rest of the session and made `stop()` a no-op, so the main
    // process went on believing a recording was in progress.
    if (active?.recorder && active.recorder.state !== "inactive") {
      stop(message);
      return;
    }

    await cleanup();
    displayStream?.getTracks().forEach((track) => track.stop());
    microphoneStream?.getTracks().forEach((track) => track.stop());
    setStatus("Idle.");
    await api.failed(message);
  }
}

function stop(failure) {
  if (!active) {
    return;
  }

  if (failure) {
    active.failure = failure;
  }

  if (active.recorder.state !== "inactive") {
    active.recorder.requestData();
    active.recorder.stop();
  }
}

api.onStart(start);
api.onStop(() => stop());
