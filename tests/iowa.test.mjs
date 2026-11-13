import test from "node:test";
import assert from "node:assert/strict";
import { iowaBudget } from "../tools/iowa-budget.mjs";
import { publicStream } from "../web/live.js";

test("Iowa resource budget separates resident time from inference and enforces the real bottleneck", () => {
  const b = iowaBudget();
  assert.equal(b.residentRunnerMinutes, 44640);
  assert.equal(b.framesPerDay, 34560);
  assert.equal(b.apiQuotaRatio, 69.12);
  assert.ok(Math.abs(b.videoGBPerDay - 4.2768648) < 1e-9);
  assert.equal(b.githubBaselineIncludedMinutes, 2000);
  assert.equal(b.githubSlimIncludedMinutes, 6000);
  assert.equal(b.hourlyJobMinutesAt2min, 1488);
  assert.ok(b.hourly20sWindowCoveragePercent < 1);
  assert.equal(b.continuousCVReady, false);
});

test("player accepts only published public Iowa HLS locations without credentials or query", () => {
  const u =
    "https://video2.iowadot.gov:8888/councilbluffs/cbtv51lb/playlist.m3u8";
  assert.equal(publicStream(u), u);
  for (const invalid of [
    u + "?token=secret",
    u + "#x",
    u.replace("https:", "http:"),
    u.replace("video2.iowadot.gov", "attacker.test"),
    u.replace("https://", "https://secret@"),
    u.replace("8888", "443"),
    "javascript:alert(1)",
    undefined,
  ])
    assert.equal(publicStream(invalid), null);
});
