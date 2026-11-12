import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.mjs";
test("events, reviews and quota survive a process-store reopen", async () => {
  const dir = await mkdtemp(join(tmpdir(), "roadwatch-persistence-"));
  const path = join(dir, "test.sqlite");
  const now = Date.now();
  let s = new Store(path, { now: () => now });
  s.seed([
    {
      id: "camera",
      name: "Test",
      zone: "ttk",
      enabled: true,
      approved: true,
      demo: false,
    },
  ]);
  for (const n of [0, 1])
    s.ingest({
      camera_id: "camera",
      frame_id: "frame-" + n,
      captured_at: new Date(now - 2000 + n * 1000).toISOString(),
      model: "test",
      detections: [{ label: "fire", score: 0.95, box: [0.1, 0.1, 0.2, 0.2] }],
    });
  const id = s.events()[0].id;
  s.review(id, "confirmed");
  s.close();
  s = new Store(path, { now: () => now });
  assert.equal(s.event(id).status, "confirmed");
  assert.equal(s.stats().daily_frames, 2);
  s.close();
  await rm(dir, { recursive: true, force: true });
});
test("demo database cannot silently become production", async () => {
  const dir = await mkdtemp(join(tmpdir(), "roadwatch-mode-"));
  const path = join(dir, "test.sqlite");
  const s = new Store(path, { demo: true });
  s.close();
  assert.throws(() => new Store(path, { demo: false }), /mode mismatch/);
  await rm(dir, { recursive: true, force: true });
});
