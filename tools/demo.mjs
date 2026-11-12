import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createApp } from "../src/server.mjs";
import { resolve } from "node:path";
const viewerToken = process.env.VIEWER_TOKEN,
  ingestToken = process.env.INGEST_TOKEN;
if (!viewerToken || !ingestToken)
  throw new Error(
    "Set VIEWER_TOKEN and INGEST_TOKEN; tokens are never printed",
  );
const app = await createApp({
  dataDir: resolve(process.env.DATA_DIR || "data", "demo"),
  demo: true,
  viewerToken,
  ingestToken,
  dailyFrameLimit: 5000,
});
const host = process.env.HOST || "127.0.0.1",
  port = Number(process.env.PORT || 8787);
await new Promise((r) => app.server.listen(port, host, r));
console.log(
  `Demo API listening at http://${host}:${port}. Synthetic data only; viewer token comes from environment.`,
);
for (const [id, type] of [
  ["demo-garden", "collision"],
  ["demo-ttk", "smoke"],
  ["demo-mkad", "fire"],
]) {
  const fixture = (n) => ({
    camera_id: id,
    frame_id: randomBytes(12).toString("hex"),
    captured_at: new Date(Date.now() - 2000 + n * 500).toISOString(),
    model: "synthetic-annotations-v1",
    detections: [{ label: type, score: 0.95, box: [0.3, 0.3, 0.25, 0.3] }],
  });
  app.store.ingest(fixture(0));
  const second = fixture(1);
  const event = app.store.ingest(second).events[0];
  const poster = await readFile(
    new URL("../web/clips/" + type + ".jpg", import.meta.url),
  );
  await fetch(`http://${host}:${port}/api/cameras/${id}/frame`, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + ingestToken,
      "Content-Type": "image/jpeg",
      "X-Frame-ID": second.frame_id,
    },
    body: poster,
  });
  if (event) {
    const clip = await readFile(
      new URL("../web/clips/" + type + ".mp4", import.meta.url),
    );
    await fetch(`http://${host}:${port}/api/events/${event.id}/evidence`, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + ingestToken,
        "Content-Type": "video/mp4",
      },
      body: clip,
    });
  }
}
const interval = setInterval(() => app.store.prune(), 3600000);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, async () => {
    clearInterval(interval);
    await app.close();
    process.exit(0);
  });
