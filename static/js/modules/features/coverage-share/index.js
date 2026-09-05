import { createFeatureApi } from "../../core/feature-api.js";
import { downloadBlob } from "../../utils/dom.js";
import { buildShareModel, FILM_SECONDS } from "./model.js";
import { recordFilm, videoFormat } from "./video.js";

export function openCoverageShare({ area, signal }) {
  if (signal?.aborted) return;
  const existing = document.querySelector(".coverage-share-dialog");
  if (existing) {
    existing.focus();
    return;
  }
  const controller = new AbortController();
  const dialog = document.createElement("dialog");
  dialog.className = "coverage-share-dialog";
  dialog.setAttribute("aria-labelledby", "coverage-share-title");
  dialog.innerHTML = `
    <header class="coverage-share-header">
      <div><p class="text-muted">Share your exploration</p><h2 id="coverage-share-title">City of Light</h2></div>
      <button type="button" class="btn btn-ghost" data-close aria-label="Close share preview">Close</button>
    </header>
    <p class="coverage-share-area"></p>
    <p class="coverage-share-status" role="status" aria-live="polite">Preparing your film…</p>
    <button type="button" class="btn btn-secondary" data-retry hidden>Try again</button>
    <div class="coverage-share-layout" hidden>
      <div class="coverage-share-stage">
        <canvas role="img"></canvas>
        <div class="coverage-share-player">
          <button type="button" class="btn btn-secondary" data-play>Play film</button>
          <div><label for="coverage-share-time">Film position <span data-time>0:12 / 0:12</span></label><input id="coverage-share-time" type="range" min="0" max="12" step="0.01" value="12"></div>
        </div>
      </div>
      <aside class="coverage-share-actions">
        <p>Your streets light up as your recorded discoveries unfold.</p>
        <p class="text-muted" data-format></p>
        <button type="button" class="btn btn-primary" data-video>Save video</button>
        <button type="button" class="btn btn-secondary" data-image>Save image</button>
        <button type="button" class="btn btn-secondary" data-native hidden>Share video</button>
        <button type="button" class="btn btn-ghost" data-cancel hidden>Cancel export</button>
        <progress aria-label="Video export progress" max="1" value="0" hidden></progress>
        <p class="text-muted" data-undated hidden>Streets without a recorded discovery date appear from the start.</p>
        <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">© OpenStreetMap contributors</a>
      </aside>
    </div>`;
  dialog.querySelector(".coverage-share-area").textContent = area.display_name;
  const canvas = dialog.querySelector("canvas");
  canvas.setAttribute(
    "aria-label",
    `Animated street coverage history for ${area.display_name}`
  );
  const status = dialog.querySelector(".coverage-share-status");
  const play = dialog.querySelector("[data-play]");
  const slider = dialog.querySelector("input");
  const video = dialog.querySelector("[data-video]");
  const image = dialog.querySelector("[data-image]");
  const native = dialog.querySelector("[data-native]");
  const progress = dialog.querySelector("progress");
  const cancel = dialog.querySelector("[data-cancel]");
  const retry = dialog.querySelector("[data-retry]");
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let renderer;
  let model;
  let animation;
  let playing = false;
  let seconds = FILM_SECONDS;
  let exporting = null;
  let savedVideo = null;
  let closed = false;
  const format = videoFormat();

  function stop() {
    cancelAnimationFrame(animation);
    playing = false;
    play.textContent = seconds >= FILM_SECONDS ? "Replay film" : "Play film";
  }
  function updateClock(time) {
    seconds = time;
    slider.value = String(time);
    slider.setAttribute("aria-valuetext", `${time.toFixed(1)} seconds of 12`);
    dialog.querySelector("[data-time]").textContent =
      `0:${String(Math.floor(time)).padStart(2, "0")} / 0:12`;
  }
  function draw(time) {
    renderer.draw(time);
    updateClock(time);
  }
  function start() {
    if (!renderer || exporting) return;
    if (playing) {
      stop();
      return;
    }
    if (seconds >= FILM_SECONDS) seconds = 0;
    const initial = seconds;
    const started = performance.now();
    playing = true;
    play.textContent = "Pause film";
    const tick = (timestamp) => {
      draw(Math.min(FILM_SECONDS, initial + (timestamp - started) / 1000));
      if (seconds < FILM_SECONDS) animation = requestAnimationFrame(tick);
      else stop();
    };
    animation = requestAnimationFrame(tick);
  }
  function close() {
    if (closed) return;
    closed = true;
    stop();
    exporting?.abort();
    controller.abort();
    signal?.removeEventListener("abort", close);
    document.removeEventListener("visibilitychange", onVisibility);
    savedVideo = null;
    dialog.close();
    dialog.remove();
  }
  function onVisibility() {
    if (document.hidden) stop();
  }
  function busy(value) {
    play.disabled = value;
    slider.disabled = value;
    video.disabled = value || !format || !canvas.captureStream;
    image.disabled = value;
    native.disabled = value;
    cancel.hidden = !value;
    progress.hidden = !value;
    dialog.setAttribute("aria-busy", String(value));
  }
  async function prepare() {
    retry.hidden = true;
    status.textContent = "Preparing your film…";
    const timeout = AbortSignal.timeout(30_000);
    const api = createFeatureApi({
      signal: AbortSignal.any([controller.signal, timeout]),
    });
    try {
      const [streets, { createShareRenderer }] = await Promise.all([
        api.rawJson(`/api/coverage/areas/${encodeURIComponent(area.id)}/streets/all?render_parts=true`, {
          cache: "no-store",
          retry: false,
        }),
        import("./renderer.js"),
      ]);
      if (closed) return;
      model = buildShareModel(area, streets);
      renderer = await createShareRenderer(canvas, model);
      if (closed) return;
      draw(FILM_SECONDS);
      dialog.querySelector(".coverage-share-layout").hidden = false;
      dialog.querySelector("[data-undated]").hidden = model.undatedCount === 0;
      dialog.querySelector("[data-format]").textContent = format
        ? `12 seconds · ${format.extension.toUpperCase()} · 1080 × 1350`
        : "Video export is not supported in this browser. You can save the image.";
      status.textContent = reducedMotion.matches
        ? "Ready. Press Play to watch the film."
        : "Ready to share.";
      busy(false);
      if (!reducedMotion.matches) start();
    } catch (error) {
      if (closed) return;
      status.textContent =
        error.name === "TimeoutError"
          ? "Loading the streets timed out. Please try again."
          : error.message;
      retry.hidden = false;
    }
  }
  play.addEventListener("click", start);
  slider.addEventListener("input", () => {
    stop();
    draw(Number(slider.value));
  });
  image.addEventListener("click", async () => {
    stop();
    busy(true);
    cancel.hidden = true;
    progress.hidden = true;
    try {
      const blob = await renderer.poster();
      if (!closed) {
        downloadBlob(blob, `everystreet-${model.filename}.png`);
        draw(FILM_SECONDS);
        status.textContent = "Image saved.";
      }
    } catch (error) {
      if (!closed) status.textContent = error.message;
    } finally {
      if (!closed) busy(false);
    }
  });
  video.addEventListener("click", async () => {
    stop();
    busy(true);
    cancel.focus();
    exporting = new AbortController();
    progress.value = 0;
    status.textContent = "Saving your film… Keep this tab visible for 12 seconds.";
    try {
      const result =
        savedVideo ||
        (await recordFilm(renderer, {
          signal: exporting.signal,
          onProgress: (value) => {
            progress.value = value;
            updateClock(value * FILM_SECONDS);
          },
        }));
      if (closed) return;
      savedVideo = result;
      downloadBlob(result.blob, `everystreet-${model.filename}.${result.extension}`);
      const file = new File(
        [result.blob],
        `everystreet-${model.filename}.${result.extension}`,
        { type: result.blob.type }
      );
      native.hidden = !navigator.canShare?.({ files: [file] });
      status.textContent = "Film saved.";
    } catch (error) {
      if (!closed)
        status.textContent =
          error.name === "AbortError" ? "Export cancelled." : error.message;
    } finally {
      exporting = null;
      if (!closed) {
        busy(false);
        draw(FILM_SECONDS);
        stop();
      }
    }
  });
  native.addEventListener("click", async () => {
    const file = new File(
      [savedVideo.blob],
      `everystreet-${model.filename}.${savedVideo.extension}`,
      { type: savedVideo.blob.type }
    );
    try {
      await navigator.share({ files: [file], title: `${model.name} · Every Street` });
    } catch (error) {
      if (error.name !== "AbortError")
        status.textContent =
          "The film could not be shared. Use Save video to download it.";
    }
  });
  cancel.addEventListener("click", () => exporting?.abort());
  retry.addEventListener("click", prepare);
  dialog.querySelector("[data-close]").addEventListener("click", close);
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    close();
  });
  // Keep map/list shortcuts outside the modal, including the page's Escape handler.
  dialog.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
  });
  dialog.addEventListener("close", close);
  signal?.addEventListener("abort", close, { once: true });
  document.addEventListener("visibilitychange", onVisibility);
  document.body.appendChild(dialog);
  dialog.showModal();
  prepare();
}
