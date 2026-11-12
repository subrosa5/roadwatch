import test from "node:test";
import assert from "node:assert/strict";
import {
  observation,
  candidates,
  capacity,
  cameraHealth,
} from "../src/domain.mjs";
import { Store } from "../src/store.mjs";

const NOW = Date.parse("2026-11-12T12:00:00Z");
const fixture = (id = "f1", offset = -2000, label = "fire", score = 0.95) => ({
  camera_id: "test-camera",
  frame_id: id,
  captured_at: new Date(NOW + offset).toISOString(),
  model: "test-model-sha",
  detections: [{ label, score, box: [0.1, 0.2, 0.3, 0.4] }],
});
function setup(options = {}) {
  const s = new Store(":memory:", { now: () => NOW, ...options });
  s.seed([
    {
      id: "test-camera",
      name: "Test",
      zone: "mkad",
      enabled: true,
      approved: true,
      demo: false,
    },
  ]);
  return s;
}
test("rejects stale, future, malformed and nonfinite detections", () => {
  for (const input of [
    fixture("x", -61000),
    fixture("x", 6000),
    {
      ...fixture(),
      detections: [{ label: "fire", score: NaN, box: [0, 0, 1, 1] }],
    },
    {
      ...fixture(),
      detections: [{ label: "fire", score: 0.9, box: [0.8, 0, 0.4, 0.2] }],
    },
  ])
    assert.throws(() => observation(input, NOW));
});
test("requires two distinct consecutive frames within temporal window", () => {
  const a = observation(fixture(), NOW),
    b = observation(fixture("f2", -1000), NOW);
  assert.deepEqual(candidates(b, a), ["fire"]);
  assert.deepEqual(candidates(a, a), []);
  assert.deepEqual(
    candidates({ ...b, captured_at: new Date(NOW + 9000).toISOString() }, a),
    [],
  );
  assert.deepEqual(candidates({ ...b, detections: [] }, a), []);
});
test("vehicle boxes never become incident events", () => {
  const s = setup();
  s.ingest(fixture("a", -2000, "vehicle"));
  assert.equal(s.ingest(fixture("b", -1000, "vehicle")).events.length, 0);
  s.close();
});
test("confirmed candidate persists with missing evidence honestly marked", () => {
  const s = setup();
  assert.equal(s.ingest(fixture()).events.length, 0);
  const e = s.ingest(fixture("f2", -1000)).events[0];
  assert.equal(e.type, "fire");
  assert.equal(e.recording_status, "unavailable");
  assert.equal(e.status, "unreviewed");
  assert.equal(e.confirmation_frames, 2);
  s.close();
});
test("duplicate frame is idempotent and does not spend budget twice", () => {
  const s = setup();
  s.ingest(fixture());
  assert.equal(s.ingest(fixture()).duplicate, true);
  assert.equal(s.stats().daily_frames, 1);
  s.close();
});
test("out-of-order frame cannot replace current annotations", () => {
  const s = setup();
  s.ingest(fixture("new", -1000));
  assert.throws(() => s.ingest(fixture("old", -3000)), /Out of order/);
  assert.equal(s.latest("test-camera").frame_id, "new");
  assert.equal(s.stats().daily_frames, 1);
  s.close();
});
test("daily budget fails closed and transaction rolls back", () => {
  const s = setup({ dailyFrameLimit: 1 });
  s.ingest(fixture());
  assert.throws(() => s.ingest(fixture("f2", -1000)), /budget exhausted/);
  assert.equal(s.stats().daily_frames, 1);
  assert.equal(s.latest("test-camera").frame_id, "f1");
  s.close();
});
test("unapproved or disabled camera cannot ingest", () => {
  const s = new Store(":memory:", { now: () => NOW });
  s.seed([
    {
      id: "test-camera",
      name: "Test",
      zone: "mkad",
      enabled: true,
      approved: false,
    },
  ]);
  assert.throws(() => s.ingest(fixture()), /not approved/);
  s.close();
});
test("demo and real provenance cannot be mixed", () => {
  const s = setup({ demo: true });
  assert.throws(() => s.ingest(fixture()), /cannot be mixed/);
  s.close();
});
test("cooldown suppresses repeated alerts for same incident", () => {
  const s = setup();
  s.ingest(fixture());
  s.ingest(fixture("f2", -1000));
  assert.equal(s.ingest(fixture("f3", 0)).events.length, 0);
  assert.equal(s.events().length, 1);
  s.close();
});
test("review is explicit, validated and audited", () => {
  const s = setup();
  s.ingest(fixture());
  const e = s.ingest(fixture("f2", -1000)).events[0];
  assert.equal(s.review(e.id, "dismissed").status, "dismissed");
  assert.equal(s.db.prepare("SELECT count(*) AS n FROM reviews").get().n, 1);
  assert.throws(() => s.review(e.id, "fake"), /Invalid/);
  s.close();
});
test("stale frames never count as receiving", () => {
  assert.equal(
    cameraHealth(
      { enabled: true },
      { captured_at: new Date(NOW - 16000).toISOString() },
      NOW,
    ),
    "stale",
  );
  assert.equal(cameraHealth({ enabled: false }, null, NOW), "disabled");
});
test("capacity distinguishes ingest, recording and inference", () => {
  const c = capacity({ cameras: 100, fps: 1, bitrateMbps: 1, cpuMs: 50 });
  assert.equal(c.framesPerDay, 8640000);
  assert.equal(c.cpuHoursMonth, 3600);
  assert.equal(c.ingestGBDay, 1080);
  assert.equal(c.ringBufferGB60s, 0.75);
  assert.equal(c.theoreticalVercelCPUFit, false);
});
