import {
  geoCentroid,
  geoMercator,
  geoPath,
} from "https://cdn.jsdelivr.net/npm/d3-geo@3.1.1/+esm";
import { ease, FILM_SECONDS, frameAt } from "./model.js";

export const FILM_WIDTH = 1080;
export const FILM_HEIGHT = 1350;

// Fixed export art direction, documented in docs/design-language.md.
// Canvas colors do not inherit the application's light/dark UI theme.
const C = {
  background: "#0b1119",
  paper: "#f3ebdb",
  brass: "#eac88d",
  muted: "#a5acb8",
  road: "#38444f",
  edge: "#303c49",
  halo: "#bb8851",
};
const DISPLAY = '"Source Serif 4", Georgia, serif';
const TEXT = '"Source Sans 3", sans-serif';
const MONTH = new Intl.DateTimeFormat("en-US", {
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});
const NUMBER = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

function surface() {
  const canvas = document.createElement("canvas");
  canvas.width = FILM_WIDTH;
  canvas.height = FILM_HEIGHT;
  return canvas;
}

function fitText(ctx, text, width, size, min, family = DISPLAY) {
  let fitted = text;
  while (size > min) {
    ctx.font = `400 ${size}px ${family}`;
    if (ctx.measureText(text).width <= width) return text;
    size -= 2;
  }
  ctx.font = `400 ${min}px ${family}`;
  while (fitted.length && ctx.measureText(fitted + "…").width > width)
    fitted = fitted.slice(0, -1);
  return fitted === text ? text : fitted + "…";
}

function illuminate(ctx, path) {
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = C.halo;
  ctx.globalAlpha = 0.11;
  ctx.lineWidth = 7;
  ctx.stroke(path);
  ctx.strokeStyle = C.brass;
  ctx.globalAlpha = 0.24;
  ctx.lineWidth = 3;
  ctx.stroke(path);
  ctx.globalAlpha = 0.94;
  ctx.lineWidth = 1.2;
  ctx.stroke(path);
  ctx.globalAlpha = 1;
}

export async function createShareRenderer(canvas, model) {
  await Promise.all([
    document.fonts.load(`400 120px ${DISPLAY}`),
    document.fonts.load(`500 90px ${TEXT}`),
  ]);
  canvas.width = FILM_WIDTH;
  canvas.height = FILM_HEIGHT;
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("This browser could not create the film canvas.");
  const geo = {
    type: "FeatureCollection",
    features: model.roads.map((r) => r.feature),
  };
  const center = geoCentroid(geo);
  const projection = geoMercator()
    .rotate([-center[0], 0])
    .fitExtent(
      [
        [70, 260],
        [1010, 1030],
      ],
      geo
    );
  const path = geoPath(projection);
  const paths = new Map(
    model.roads.map((road) => [road.id, new Path2D(path(road.feature))])
  );
  const base = surface();
  const baseCtx = base.getContext("2d");
  const network = new Path2D();
  for (const road of model.roads) network.addPath(paths.get(road.id));
  baseCtx.strokeStyle = C.road;
  baseCtx.lineWidth = 0.85;
  baseCtx.globalAlpha = 0.7;
  baseCtx.stroke(network);

  const accumulated = surface();
  const accumulatedCtx = accumulated.getContext("2d");
  let completed = 0;
  const traces = model.driven.map((road) => {
    let length = 0;
    const lines = road.lines.map((line) =>
      line.map((coord, index, coords) => {
        const point = projection(coord);
        if (index) {
          const previous = projection(coords[index - 1]);
          length += Math.hypot(point[0] - previous[0], point[1] - previous[1]);
        }
        return { point, at: length };
      })
    );
    return { lines, length };
  });

  function draw(seconds = FILM_SECONDS) {
    const frame = frameAt(model, seconds);
    if (frame.completed < completed) {
      accumulatedCtx.clearRect(0, 0, FILM_WIDTH, FILM_HEIGHT);
      completed = 0;
    }
    if (frame.completed > completed) {
      const batch = new Path2D();
      for (; completed < frame.completed; completed++)
        batch.addPath(paths.get(model.driven[completed].id));
      illuminate(accumulatedCtx, batch);
    }
    ctx.fillStyle = C.background;
    ctx.fillRect(0, 0, FILM_WIDTH, FILM_HEIGHT);
    const atmosphere = ctx.createRadialGradient(540, 650, 0, 540, 650, 650);
    atmosphere.addColorStop(0, C.halo + "16");
    atmosphere.addColorStop(1, C.background + "00");
    ctx.fillStyle = atmosphere;
    ctx.fillRect(0, 0, FILM_WIDTH, FILM_HEIGHT);
    const travel = ease(frame.time / 10);
    const zoom = 1 + (1 - travel) * 1.45;
    ctx.save();
    ctx.translate(540, 650);
    ctx.rotate((1 - travel) * 0.11 - 0.025);
    ctx.scale(zoom, zoom * (0.84 + 0.16 * travel));
    ctx.translate(-540, -650);
    ctx.drawImage(base, 0, 0);
    ctx.drawImage(accumulated, 0, 0);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = C.paper;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    const tips = [];
    for (const { index, progress } of frame.active) {
      const trace = traces[index];
      const end = trace.length * progress;
      for (const line of trace.lines) {
        if (line[0].at > end) break;
        ctx.moveTo(...line[0].point);
        for (let i = 1; i < line.length; i++) {
          if (line[i].at <= end) ctx.lineTo(...line[i].point);
          else {
            const a = line[i - 1];
            const b = line[i];
            const t = b.at === a.at ? 0 : (end - a.at) / (b.at - a.at);
            const tip = a.point.map(
              (value, axis) => value + t * (b.point[axis] - value)
            );
            ctx.lineTo(...tip);
            if (index % 9 === 0 && tips.length < 80) tips.push(tip);
            break;
          }
        }
      }
    }
    ctx.stroke();
    for (const tip of tips) {
      const glow = ctx.createRadialGradient(...tip, 0, ...tip, 9);
      glow.addColorStop(0, C.paper + "dd");
      glow.addColorStop(0.3, C.brass + "70");
      glow.addColorStop(1, C.brass + "00");
      ctx.fillStyle = glow;
      ctx.fillRect(tip[0] - 9, tip[1] - 9, 18, 18);
    }
    ctx.restore();

    const top = ctx.createLinearGradient(0, 0, 0, 405);
    top.addColorStop(0, C.background);
    top.addColorStop(0.67, C.background + "ec");
    top.addColorStop(1, C.background + "00");
    ctx.fillStyle = top;
    ctx.fillRect(0, 0, FILM_WIDTH, 405);
    const bottom = ctx.createLinearGradient(0, 790, 0, 1120);
    bottom.addColorStop(0, C.background + "00");
    bottom.addColorStop(0.62, C.background + "eb");
    bottom.addColorStop(1, C.background);
    ctx.fillStyle = bottom;
    ctx.fillRect(0, 790, FILM_WIDTH, 560);

    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = C.brass;
    ctx.beginPath();
    ctx.arc(69, 65, 5, 0, 2 * Math.PI);
    ctx.fill();
    ctx.fillStyle = C.paper;
    ctx.font = `600 24px ${TEXT}`;
    ctx.fillText("EVERY STREET", 87, 73);
    ctx.textAlign = "right";
    ctx.fillStyle = C.muted;
    ctx.font = `400 23px ${TEXT}`;
    ctx.fillText("CITY OF LIGHT", 1016, 73);
    ctx.textAlign = "left";
    ctx.fillStyle = C.paper;
    const heading = fitText(ctx, model.name, 952, 154, 64);
    ctx.fillText(heading, 60, 245);
    ctx.fillStyle = C.muted;
    const subtitle = fitText(ctx, model.subtitle, 952, 25, 24, TEXT);
    ctx.fillText(subtitle, 65, 291);

    ctx.fillStyle = C.brass;
    ctx.font = `400 24px ${TEXT}`;
    const closing = frame.time >= 9.4;
    const chapter = closing
      ? model.driven.length
        ? "A CITY, DISCOVERED."
        : "A CITY WAITING TO BE DISCOVERED."
      : frame.date
        ? MONTH.format(frame.date).toUpperCase()
        : model.undatedCount
          ? "EARLIER COVERAGE"
          : "IT STARTS WITH ONE STREET.";
    ctx.fillText(chapter, 65, 945);
    ctx.fillStyle = C.paper;
    ctx.font = `400 66px ${DISPLAY}`;
    ctx.fillText("One street at a time.", 62, 1026);
    ctx.font = `500 96px ${TEXT}`;
    ctx.fillText(NUMBER.format(frame.percent) + "%", 62, 1142);
    ctx.font = `400 58px ${TEXT}`;
    ctx.fillText(NUMBER.format(frame.miles) + " mi", 518, 1142);
    ctx.fillStyle = C.muted;
    ctx.font = `400 25px ${TEXT}`;
    ctx.fillText("streets explored", 65, 1180);
    ctx.fillText("unique street miles", 520, 1180);
    ctx.strokeStyle = C.edge;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(65, 1230);
    ctx.lineTo(1015, 1230);
    ctx.stroke();
    ctx.fillStyle = C.paper;
    ctx.font = `400 30px ${DISPLAY}`;
    ctx.fillText("Every street has a story.", 65, 1280);
    ctx.textAlign = "right";
    ctx.fillStyle = C.muted;
    ctx.font = `400 24px ${TEXT}`;
    ctx.fillText("everystreet.me", 1015, 1280);
    ctx.font = `400 20px ${TEXT}`;
    ctx.fillText("Map data © OpenStreetMap contributors", 1015, 1320);
    ctx.textAlign = "left";
    return frame;
  }

  return {
    canvas,
    draw,
    poster: () => {
      draw(FILM_SECONDS);
      return new Promise((resolve, reject) =>
        canvas.toBlob(
          (blob) =>
            blob ? resolve(blob) : reject(new Error("The image could not be saved.")),
          "image/png"
        )
      );
    },
  };
}
