import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";

const viewer = "test-viewer-token-32-characters-or-more",
  ingest = "test-ingest-token-32-characters-or-more";
test("authenticated API persists events, enforces roles and serves evidence ranges", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "roadwatch-test-"));
  const app = await createApp({
    dataDir: dir,
    demo: true,
    viewerToken: viewer,
    ingestToken: ingest,
    dailyFrameLimit: 20,
  });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + app.server.address().port;
  t.after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  const call = (path, role = viewer, options = {}) =>
    fetch(base + path, {
      ...options,
      headers: { Authorization: "Bearer " + role, ...options.headers },
    });
  assert.equal((await fetch(base + "/api/events")).status, 401);
  assert.equal((await call("/api/cameras", ingest)).status, 403);
  assert.equal(
    (await call("/api/observations", viewer, { method: "POST", body: "{}" }))
      .status,
    403,
  );
  const frame = (n) => ({
    camera_id: "demo-garden",
    frame_id: "frame-" + n,
    captured_at: new Date(Date.now() - 2000 + n * 500).toISOString(),
    model: "synthetic-test-v1",
    detections: [
      { label: "collision", score: 0.93, box: [0.1, 0.2, 0.3, 0.4] },
    ],
  });
  await call("/api/observations", ingest, {
    method: "POST",
    body: JSON.stringify(frame(0)),
  });
  const response = await call("/api/observations", ingest, {
    method: "POST",
    body: JSON.stringify(frame(1)),
  });
  assert.equal(response.status, 201);
  const e = (await response.json()).events[0];
  assert.ok(e.id);
  assert.equal(
    (
      await call("/api/events/" + e.id + "/evidence", ingest, {
        method: "POST",
        headers: { "Content-Type": "video/mp4" },
        body: Buffer.from("not an mp4 video"),
      })
    ).status,
    400,
  );
  const video = await readFile(
    new URL("../web/clips/collision.mp4", import.meta.url),
  );
  const attached = await call("/api/events/" + e.id + "/evidence", ingest, {
    method: "POST",
    headers: { "Content-Type": "video/mp4" },
    body: video,
  });
  assert.equal(attached.status, 201);
  const saved = await attached.json();
  assert.equal(saved.recording_status, "ready");
  const clip = await call("/api/evidence/" + saved.evidence_id, viewer, {
    headers: { Range: "bytes=0-31" },
  });
  assert.equal(clip.status, 206);
  assert.equal((await clip.arrayBuffer()).byteLength, 32);
  assert.equal(
    (
      await call("/api/evidence/" + saved.evidence_id, viewer, {
        headers: { Range: "bytes=999999999-" },
      })
    ).status,
    416,
  );
  assert.equal(
    (
      await call("/api/events/" + e.id + "/review", viewer, {
        method: "POST",
        body: JSON.stringify({ status: "confirmed" }),
      })
    ).status,
    200,
  );
  assert.equal(
    (await (await call("/api/events")).json())[0].status,
    "confirmed",
  );
  const poster = await readFile(
    new URL("../web/clips/collision.jpg", import.meta.url),
  );
  assert.equal(
    (
      await call("/api/cameras/demo-garden/frame", ingest, {
        method: "POST",
        headers: { "Content-Type": "image/jpeg", "X-Frame-ID": "wrong-frame" },
        body: poster,
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await call("/api/cameras/demo-garden/frame", ingest, {
        method: "POST",
        headers: { "Content-Type": "image/jpeg", "X-Frame-ID": "frame-1" },
        body: poster,
      })
    ).status,
    200,
  );
  const frameResponse = await call("/api/cameras/demo-garden/frame");
  assert.equal(frameResponse.headers.get("X-Frame-ID"), "frame-1");
  assert.equal((await frameResponse.arrayBuffer()).byteLength, poster.length);
  assert.equal((await call("/api/cameras/unknown/frame")).status, 404);
  assert.equal((await fetch(base + "/%2e%2e%2fpackage.json")).status, 404);
});

test("requires distinct non-default credentials", async () => {
  await assert.rejects(
    createApp({ viewerToken: "short", ingestToken: "short" }),
    /distinct/,
  );
  await assert.rejects(
    createApp({ viewerToken: viewer, ingestToken: viewer }),
    /distinct/,
  );
});
