import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createApp } from "../src/server.mjs";

const dir = await mkdtemp(join(tmpdir(), "roadwatch-browser-"));
const viewerToken = randomBytes(32).toString("hex"),
  ingestToken = randomBytes(32).toString("hex");
const app = await createApp({
  dataDir: dir,
  demo: true,
  viewerToken,
  ingestToken,
});
await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
const base = "http://127.0.0.1:" + app.server.address().port;
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
    : {}),
});
const page = await browser.newPage({
  viewport: { width: 1512, height: 1100 },
  deviceScaleFactor: 1,
});
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
try {
  await page.goto(base);
  await page.waitForFunction(
    () => document.getElementById("camera-video").readyState >= 2,
  );
  await page.locator("#camera-video").evaluate((video) => {
    video.currentTime = 7;
    video.pause();
  });
  await page.waitForTimeout(300);
  assert.equal(await page.locator("#camera-picker .camera-choice").count(), 3);
  assert.equal(await page.locator("#event-feed .feed-item").count(), 3);
  await mkdir("docs/screenshots", { recursive: true });
  await page.screenshot({
    path: "docs/screenshots/desktop.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Демо-событие", exact: false })
    .click();
  assert.equal(await page.locator("#event-feed .feed-item").count(), 4);
  await page.locator("#event-feed .feed-item").first().click();
  await page.waitForFunction(
    () => document.getElementById("event-video").readyState >= 1,
  );
  assert.equal(
    await page.locator("#event-video").evaluate((v) => Math.round(v.duration)),
    12,
  );
  await page.getByRole("button", { name: "Подтвердить", exact: true }).click();
  assert.equal(
    await page.locator("#event-dialog").evaluate((d) => d.open),
    false,
  );
  await page.locator('[data-zone="mkad"]').click();
  assert.equal(await page.locator("#camera-picker .camera-choice").count(), 1);
  await page.locator('[data-camera="demo-mkad"]').click();
  assert.match(await page.locator("#camera-name").textContent(), /МКАД/);
  await page.locator('[data-page="capacity"]').click();
  assert.match(await page.locator("#capacity-hours").textContent(), /108/);
  await page.locator("#capacity-fps").fill("0");
  await page.locator("#capacity-fps").dispatchEvent("input");
  assert.match(
    await page.locator("#capacity-verdict").textContent(),
    /укладывается/,
  );
  await page.screenshot({
    path: "docs/screenshots/capacity.png",
    fullPage: true,
  });
  await page.locator('[data-page="cameras"]').click();
  await page.locator("#connect-button").click();
  await page.locator("#api-url").fill(base);
  await page.locator("#api-token").fill(viewerToken);
  await page.getByRole("button", { name: "Подключиться", exact: true }).click();
  await page.waitForFunction(
    () => document.getElementById("mode-badge").textContent === "Демо API",
  );
  assert.equal(await page.locator("#event-feed .feed-item").count(), 0);
  await page.reload();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(200);
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    ),
    false,
  );
  await page.screenshot({
    path: "docs/screenshots/mobile.png",
    fullPage: true,
  });
  await page.locator("#menu-button").click();
  await page.locator('[data-page="events"]').click();
  assert.equal(
    await page
      .locator("#page-events")
      .evaluate((el) => el.classList.contains("active")),
    true,
  );
  assert.deepEqual(errors, []);
  console.log(
    "Browser QA passed: video playback, events/review, zones, capacity, API connection, mobile and no uncaught errors.",
  );
} finally {
  await browser.close();
  await app.close();
  await rm(dir, { recursive: true, force: true });
}
