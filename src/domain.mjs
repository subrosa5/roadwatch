import { createHash } from "node:crypto";

export const TYPES = ["collision", "smoke", "fire"];
export const LABELS = [...TYPES, "vehicle"];
export const LIMITS = {
  confirmationFrames: 2,
  maxGapMs: 6000,
  cooldownMs: 120000,
  maxAgeMs: 60000,
  futureSkewMs: 5000,
};
export class InputError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}
export function observation(input, now = Date.now()) {
  if (!input || typeof input !== "object")
    throw new InputError("Observation required");
  if (
    typeof input.camera_id !== "string" ||
    !/^[a-z0-9-]{1,80}$/.test(input.camera_id)
  )
    throw new InputError("Invalid camera_id");
  if (
    typeof input.frame_id !== "string" ||
    !/^[a-zA-Z0-9:_-]{1,120}$/.test(input.frame_id)
  )
    throw new InputError("Invalid frame_id");
  const time = Date.parse(input.captured_at);
  if (
    !Number.isFinite(time) ||
    time > now + LIMITS.futureSkewMs ||
    time < now - LIMITS.maxAgeMs
  )
    throw new InputError("Stale or future frame");
  if (!Array.isArray(input.detections) || input.detections.length > 100)
    throw new InputError("Invalid detections");
  const detections = input.detections.map((d) => {
    if (
      !LABELS.includes(d.label) ||
      !Number.isFinite(d.score) ||
      d.score < 0 ||
      d.score > 1
    )
      throw new InputError("Invalid detection");
    const b = d.box;
    if (
      !Array.isArray(b) ||
      b.length !== 4 ||
      b.some((x) => !Number.isFinite(x) || x < 0 || x > 1) ||
      b[2] <= 0 ||
      b[3] <= 0 ||
      b[0] + b[2] > 1.00001 ||
      b[1] + b[3] > 1.00001
    )
      throw new InputError("Box must be normalized [x,y,width,height]");
    return { label: d.label, score: d.score, box: b };
  });
  if (
    typeof input.model !== "string" ||
    input.model.length < 1 ||
    input.model.length > 120
  )
    throw new InputError("Model provenance required");
  return {
    camera_id: input.camera_id,
    frame_id: input.frame_id,
    captured_at: new Date(time).toISOString(),
    detections,
    model: input.model,
    clock: input.clock === "source" ? "source" : "collector_arrival",
  };
}
export function candidates(current, previous, now = Date.now()) {
  if (!previous || current.frame_id === previous.frame_id) return [];
  const gap =
    Date.parse(current.captured_at) - Date.parse(previous.captured_at);
  if (gap <= 0 || gap > LIMITS.maxGapMs) return [];
  return TYPES.filter((type) =>
    [current, previous].every((o) =>
      o.detections.some(
        (d) => d.label === type && d.score >= (type === "smoke" ? 0.85 : 0.8),
      ),
    ),
  );
}
export function digest(data) {
  return createHash("sha256").update(data).digest("hex");
}
export function cameraHealth(camera, latest, now = Date.now()) {
  if (!camera.enabled) return "disabled";
  if (!latest) return "no_data";
  return now - Date.parse(latest.captured_at) < 15000 ? "receiving" : "stale";
}
export function capacity({
  cameras = 100,
  fps = 1,
  bitrateMbps = 1,
  cpuMs = 50,
  eventCount = 10,
  clipSeconds = 30,
  retentionDays = 7,
} = {}) {
  for (const [name, value] of Object.entries({
    cameras,
    fps,
    bitrateMbps,
    cpuMs,
    eventCount,
    clipSeconds,
    retentionDays,
  }))
    if (!Number.isFinite(value) || value < 0)
      throw new InputError(`Invalid ${name}`);
  const framesPerDay = cameras * fps * 86400;
  const cpuHoursMonth = (framesPerDay * 30 * cpuMs) / 3600000;
  const ingestGBDay = (cameras * bitrateMbps * 1e6 * 86400) / 8 / 1e9;
  const clipsGB =
    ((eventCount * clipSeconds * bitrateMbps * 1e6) / 8 / 1e9) * retentionDays;
  return {
    cameras,
    fps,
    framesPerDay,
    cpuHoursMonth,
    ingestGBDay,
    archiveGBDay: ingestGBDay,
    ringBufferGB60s: (((cameras * bitrateMbps * 1e6) / 8) * 60) / 1e9,
    clipsGB,
    theoreticalVercelCPUFit: cpuHoursMonth <= 4,
    note: "Planning estimate; excludes decode, models, retries, memory, API and UI. No hardware benchmark.",
  };
}
