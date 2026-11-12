import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, access, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { Store } from "../src/store.mjs";
test("retention expires evidence while preserving event hash and review", async () => {
  const dir = await mkdtemp(join(tmpdir(), "roadwatch-retention-"));
  const old = Date.now() - 3 * 86400000;
  const path = join(dir, "roadwatch.sqlite");
  let s = new Store(path, { now: () => old });
  s.seed([
    { id: "camera", name: "Test", zone: "ttk", enabled: true, approved: true },
  ]);
  for (const n of [0, 1])
    s.ingest({
      camera_id: "camera",
      frame_id: "f" + n,
      captured_at: new Date(old - 1000 + n * 500).toISOString(),
      model: "test",
      detections: [{ label: "fire", score: 0.9, box: [0, 0, 0.2, 0.2] }],
    });
  const id = s.events()[0].id;
  const evidenceId = "11111111-1111-1111-1111-111111111111";
  s.attachEvidence(id, {
    id: evidenceId,
    sha256: "b".repeat(64),
    bytes: 20,
    mime: "video/mp4",
  });
  s.review(id, "confirmed");
  s.close();
  await mkdir(join(dir, "evidence"));
  const file = join(dir, "evidence", evidenceId + ".mp4");
  await writeFile(file, "synthetic retention fixture");
  const run = spawnSync(process.execPath, ["tools/retention.mjs"], {
    env: {
      ...process.env,
      DATA_DIR: dir,
      DEMO_MODE: "false",
      EVIDENCE_RETENTION_DAYS: "1",
    },
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  s = new Store(path);
  const event = s.event(id);
  assert.equal(event.recording_status, "expired");
  assert.equal(event.expired_evidence_sha256, "b".repeat(64));
  assert.equal(event.status, "confirmed");
  await assert.rejects(access(file));
  s.close();
  await rm(dir, { recursive: true, force: true });
});
