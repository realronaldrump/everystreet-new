/**
 * The Murano on the home page plate.
 *
 * It drives up the road and parks when the page opens, takes a run up to the
 * pass and back when clicked, and idles with a bob and exhaust puffs while a
 * live trip is in progress. Poses along the lane come from the plate generator
 * (data-lane on .plate-car): [dx, dy, scale, rotate] relative to the parked
 * pose, in plate units and degrees.
 */

const EXHAUSTS = [
  [0.07, 0.8],
  [0.42, 0.87],
];
const ENTRY_MAX_SCALE = 1.45;
const ARRIVE_MS = 1700;
const LEAVE_MS = 4200;
const AWAY_MS = 900;
const SETTLE_MS = 700;
const REV_MS = 380;
const LIVE_PUFF_MS = 2600;

const PUFF_SVG =
  '<svg viewBox="0 0 44 30" focusable="false">' +
  '<path class="plate-puff-cloud" d="M9 24a7 7 0 0 1 0-13a9 9 0 0 1 16-5a8 8 0 0 1 12 7a6 6 0 0 1-2 11Z"/>' +
  '<path class="plate-puff-curl" d="M13 17c2-3 6-3 7 0M24 12c2-2 5-1 6 1M12 22l4-4M17 23l5-5M29 22l4-4"/>' +
  "</svg>";

const easeOutCubic = (t) => 1 - (1 - t) ** 3;
const easeInQuad = (t) => t * t;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function parseNumbers(value) {
  return String(value ?? "")
    .split(",")
    .map(Number);
}

function readLane(car) {
  try {
    const lane = JSON.parse(car.dataset.lane || "[]");
    const rest = Number(car.dataset.rest);
    if (!Array.isArray(lane) || lane.length < 2 || !Number.isInteger(rest)) {
      return null;
    }
    // Ground distance: screen distance divided by the perspective scale, so
    // the car keeps a steady road speed as it recedes.
    const dist = [0];
    for (let i = 1; i < lane.length; i += 1) {
      const [x0, y0, s0] = lane[i - 1];
      const [x1, y1, s1] = lane[i];
      const scale = Math.max((s0 + s1) / 2, 0.02);
      dist.push(dist[i - 1] + Math.hypot(x1 - x0, y1 - y0) / scale);
    }
    const entry = Math.max(
      0,
      lane.findIndex(([, , scale]) => scale <= ENTRY_MAX_SCALE)
    );
    return { lane, dist, rest, entry };
  } catch {
    return null;
  }
}

function poseAt(track, d) {
  const { lane, dist } = track;
  if (d <= dist[0]) {
    return lane[0];
  }
  for (let i = 1; i < lane.length; i += 1) {
    if (d <= dist[i]) {
      const t = (d - dist[i - 1]) / (dist[i] - dist[i - 1] || 1);
      return lane[i - 1].map((value, k) => value + (lane[i][k] - value) * t);
    }
  }
  return lane[lane.length - 1];
}

export default function initHeroCar({ signal } = {}) {
  const car = document.querySelector(".plate-car");
  const stage = car?.closest(".plate-hero-art");
  const track = car ? readLane(car) : null;
  const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;

  const inert = { setLive() {}, destroy() {} };
  if (!car || !stage) {
    return inert;
  }
  if (!track || reduceMotion) {
    car.classList.add("is-ready");
    return inert;
  }

  const [boxX, boxY, boxW, boxH] = parseNumbers(car.dataset.box);
  const [plateW, plateH] = parseNumbers(car.dataset.plate);
  const [anchorX, anchorY] = parseNumbers(car.dataset.anchor);
  const restDist = track.dist[track.rest];
  const endDist = track.dist[track.dist.length - 1];
  const entryDist = track.dist[track.entry];

  let frame = 0;
  let state = "parked";
  let live = false;
  let livePuffTimer = 0;
  let pose = track.lane[track.rest];

  function apply(nextPose, bob = 0, tilt = 0) {
    pose = nextPose;
    const [dx, dy, scale, rotate] = nextPose;
    const tx = (dx / boxW) * 100;
    const ty = (dy / boxH) * 100 + bob;
    car.style.transform = `translate(${tx.toFixed(3)}%, ${ty.toFixed(3)}%) rotate(${(
      rotate + tilt
    ).toFixed(2)}deg) scale(${scale.toFixed(4)})`;
    car.style.opacity = String(clamp((scale - 0.03) / 0.09, 0, 1));
  }

  function park() {
    pose = track.lane[track.rest];
    car.style.transform = "";
    car.style.opacity = "";
  }

  /** Ink puffs of exhaust from one of the tailpipes, left in the scene. */
  function puff(which = 0, size = 1) {
    cloud(which, size, 0);
    cloud(which, size * 0.7, 140);
  }

  function cloud(which, size, delay) {
    const [dx, dy, scale] = pose;
    if (scale < 0.25) {
      return;
    }
    const [ex, ey] = EXHAUSTS[which % EXHAUSTS.length];
    const wx = boxX + anchorX * boxW + dx + (ex - anchorX) * boxW * scale;
    const wy = boxY + anchorY * boxH + dy + (ey - anchorY) * boxH * scale;
    const el = document.createElement("span");
    el.className = "plate-puff";
    el.setAttribute("aria-hidden", "true");
    el.style.left = `${((wx / plateW) * 100).toFixed(2)}%`;
    el.style.top = `${((wy / plateH) * 100).toFixed(2)}%`;
    el.style.setProperty("--puff-size", `${(10 * scale * size).toFixed(2)}%`);
    el.style.animationDelay = `${delay}ms`;
    el.innerHTML = PUFF_SVG;
    el.addEventListener("animationend", () => el.remove(), { once: true });
    stage.appendChild(el);
  }

  /** Run one timed segment of motion, calling step(progress, elapsed) each frame. */
  function run(duration, step) {
    return new Promise((resolve) => {
      const start = performance.now();
      const tick = (now) => {
        if (signal?.aborted) {
          resolve(false);
          return;
        }
        const elapsed = now - start;
        const t = clamp(elapsed / duration, 0, 1);
        step(t, elapsed);
        if (t < 1) {
          frame = requestAnimationFrame(tick);
        } else {
          resolve(true);
        }
      };
      frame = requestAnimationFrame(tick);
    });
  }

  /** Road bumps: a small bob and roll that follow the distance covered. */
  function drive(from, to, duration, ease) {
    return run(duration, (t) => {
      const d = from + (to - from) * ease(t);
      const next = poseAt(track, d);
      const phase = d / 18;
      const bump = Math.sin(phase) * 0.45 + Math.sin(phase * 2.3) * 0.2;
      apply(next, bump, Math.sin(phase * 0.7) * 0.3);
    });
  }

  function settle() {
    return run(SETTLE_MS, (_t, elapsed) => {
      const bob = 1.4 * Math.exp(-elapsed / 160) * Math.sin(elapsed / 55);
      apply(track.lane[track.rest], bob);
    });
  }

  function rev() {
    return run(REV_MS, (t, elapsed) => {
      const shake = Math.sin(elapsed / 18) * (1 - t) * 0.6;
      apply(track.lane[track.rest], shake * 0.5, shake * 0.4);
    });
  }

  async function arrive() {
    state = "arriving";
    car.classList.add("is-moving");
    apply(poseAt(track, entryDist));
    car.classList.add("is-ready");
    const drove = await drive(entryDist, restDist, ARRIVE_MS, easeOutCubic);
    if (!drove) {
      return;
    }
    puff(0, 0.9);
    setTimeout(() => puff(1, 0.8), 180);
    await settle();
    park();
    car.classList.remove("is-moving");
    state = "parked";
    if (live) {
      startIdle();
    }
  }

  async function takeARun() {
    stopIdle();
    if (state !== "parked") {
      return;
    }
    state = "leaving";
    car.classList.add("is-moving");
    puff(0, 1.1);
    setTimeout(() => puff(1, 1), 120);
    if (!(await rev())) {
      return;
    }
    if (!(await drive(restDist, endDist, LEAVE_MS, easeInQuad))) {
      return;
    }
    car.style.opacity = "0";
    state = "away";
    await new Promise((resolve) => setTimeout(resolve, AWAY_MS));
    if (signal?.aborted) {
      return;
    }
    await arrive();
  }

  function idleTick(now) {
    if (signal?.aborted || state !== "idling") {
      return;
    }
    const shiver = Math.sin(now / 45) * 0.18 + Math.sin(now / 23) * 0.08;
    apply(track.lane[track.rest], shiver);
    frame = requestAnimationFrame(idleTick);
  }

  function startIdle() {
    if (state !== "parked") {
      return;
    }
    state = "idling";
    car.classList.add("is-moving");
    frame = requestAnimationFrame(idleTick);
    let which = 0;
    livePuffTimer = setInterval(() => {
      puff(which, 0.75);
      which += 1;
    }, LIVE_PUFF_MS);
  }

  function stopIdle() {
    clearInterval(livePuffTimer);
    livePuffTimer = 0;
    if (state === "idling") {
      cancelAnimationFrame(frame);
      park();
      car.classList.remove("is-moving");
      state = "parked";
    }
  }

  car.classList.add("is-interactive");
  car.addEventListener("click", takeARun, signal ? { signal } : false);
  arrive();

  return {
    setLive(isLive) {
      live = Boolean(isLive);
      if (live) {
        startIdle();
      } else {
        stopIdle();
      }
    },
    destroy() {
      cancelAnimationFrame(frame);
      clearInterval(livePuffTimer);
      stage.querySelectorAll(".plate-puff").forEach((el) => el.remove());
    },
  };
}
