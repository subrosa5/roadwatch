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
  await page.locator('[data-zone="reserve"]').click();
  assert.equal(await page.locator("#camera-picker .camera-choice").count(), 1);
  await page.locator('[data-camera="demo-mkad"]').click();
  assert.match(await page.locator("#camera-name").textContent(), /огонь/);
  await page.locator('[data-page="capacity"]').click();
  assert.match(await page.locator("#capacity-hours").textContent(), /72/);
  await page.locator("#capacity-fps").fill("0");
  await page.locator("#capacity-fps").dispatchEvent("input");
  assert.match(
    await page.locator("#capacity-verdict").textContent(),
    /укладываются/,
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
  await page.setViewportSize({ width: 1512, height: 1100 });
  let playerLoads = 0,
    checks = 0;
  await page.route("https://open.ivideon.com/**", (route) => {
    playerLoads++;
    return route.fulfill({
      contentType: "text/html",
      body: "<p>Fixture public player</p>",
    });
  });
  await page.route("**/api/**", async (route) => {
    const p = new URL(route.request().url()).pathname;
    if (p === "/api/health")
      return route.fulfill({ json: { backend: "Sites D1/R2" } });
    if (p === "/api/cameras")
      return route.fulfill({
        json: [
          {
            id: "khimki-mkad74",
            name: "МКАД · проверка недоступного плеера",
            zone: "mkad",
            demo: false,
            health: "disabled",
            embed_url:
              "https://open.ivideon.com/embed/v3/?server=fixture&camera=0&lang=ru",
          },
        ],
      });
    if (p === "/api/stats")
      return route.fulfill({
        json: {
          mode: "cloud",
          receiving_real: 0,
          daily_frames: 0,
          daily_frame_limit: 500,
        },
      });
    if (p.endsWith("/playback-check")) {
      checks++;
      return route.fulfill({
        json: {
          status: "unavailable",
          reason: "api_timeout",
          video_verified: false,
        },
      });
    }
    if (p === "/api/events" || p === "/api/sources")
      return route.fulfill({ json: [] });
    return route.continue();
  });
  await page.goto(base);
  await page.waitForFunction(
    () => !document.getElementById("embed-unavailable").hidden,
  );
  assert.equal(await page.locator("#camera-embed").isHidden(), true);
  assert.equal(await page.locator(".camera-controls").isHidden(), true);
  assert.equal(await page.locator(".viewport-top").isHidden(), true);
  assert.match(
    await page.locator("#open-embed-owner").getAttribute("href"),
    /^https:\/\/open\.ivideon\.com\//,
  );
  await page.waitForTimeout(5500);
  assert.equal(checks, 1, "polling must not restart failed playback checks");
  await page.locator("#show-embed").click();
  await page.waitForFunction(
    () => !document.getElementById("camera-embed").hidden,
  );
  const loads = playerLoads;
  await page.waitForTimeout(5500);
  assert.equal(playerLoads, loads, "polling must preserve the public player");
  await page.locator("#retry-embed").click();
  await page.waitForFunction(
    () => !document.getElementById("embed-unavailable").hidden,
  );
  assert.equal(checks, 2);
  await page.screenshot({
    path: "docs/screenshots/playback-error.png",
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  console.log(
    "Browser QA passed: video/events/review, mobile, cloud playback timeout/retry, player preservation during polling and no uncaught errors.",
  );
} finally {
  await browser.close();
  await app.close();
  await rm(dir, { recursive: true, force: true });
}
