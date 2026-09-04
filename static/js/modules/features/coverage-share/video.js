import { FILM_SECONDS } from "./model.js";

export function videoFormat(Recorder = globalThis.MediaRecorder) {
  if (!Recorder?.isTypeSupported) return null;
  for (const mimeType of [
    "video/mp4;codecs=avc1.42E01E",
    "video/mp4",
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
  ]) {
    if (Recorder.isTypeSupported(mimeType)) {
      return { mimeType, extension: mimeType.startsWith("video/mp4") ? "mp4" : "webm" };
    }
  }
  return null;
}

export function recordFilm(renderer, { signal, onProgress = () => {} } = {}) {
  const format = videoFormat();
  if (!format || !renderer.canvas.captureStream) {
    return Promise.reject(new Error("Video export is not supported in this browser."));
  }
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    let stream;
    let recorder;
    let animation;
    let watchdog;
    let settled = false;
    let failure = null;
    const chunks = [];
    const cleanup = () => {
      cancelAnimationFrame(animation);
      clearTimeout(watchdog);
      signal?.removeEventListener("abort", abort);
      document.removeEventListener("visibilitychange", hidden);
      stream?.getTracks().forEach((track) => track.stop());
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      if (failure) reject(failure);
      else if (!chunks.length)
        reject(new Error("The browser produced an empty video. Please try again."));
      else resolve({ blob: new Blob(chunks, { type: recorder.mimeType }), ...format });
    };
    const fail = (error) => {
      failure = error;
      if (recorder?.state === "recording") recorder.stop();
      finish();
    };
    const abort = () =>
      fail(signal.reason || new DOMException("Export cancelled", "AbortError"));
    const hidden = () => {
      if (document.hidden)
        fail(new Error("Keep this tab visible while saving the film, then try again."));
    };
    try {
      renderer.draw(0);
      stream = renderer.canvas.captureStream(30);
      recorder = new MediaRecorder(stream, {
        mimeType: format.mimeType,
        videoBitsPerSecond: 8_000_000,
      });
      recorder.ondataavailable = (event) => {
        if (event.data.size) chunks.push(event.data);
      };
      recorder.onerror = (event) =>
        fail(event.error || new Error("Video export failed. Please try again."));
      recorder.onstop = finish;
      signal?.addEventListener("abort", abort, { once: true });
      document.addEventListener("visibilitychange", hidden);
      recorder.start(1000);
      const start = performance.now();
      let lastFrame = -Infinity;
      const frame = (timestamp) => {
        if (settled) return;
        try {
          const seconds = Math.min(FILM_SECONDS, (timestamp - start) / 1000);
          if (timestamp - lastFrame >= 1000 / 30 || seconds === FILM_SECONDS) {
            renderer.draw(seconds);
            onProgress(seconds / FILM_SECONDS);
            lastFrame = timestamp;
          }
          if (seconds < FILM_SECONDS) animation = requestAnimationFrame(frame);
          else recorder.stop();
        } catch (error) {
          fail(error);
        }
      };
      animation = requestAnimationFrame(frame);
      watchdog = setTimeout(
        () => fail(new Error("Video export timed out. Please try again.")),
        30_000
      );
      hidden();
    } catch (error) {
      fail(error);
    }
  });
}
