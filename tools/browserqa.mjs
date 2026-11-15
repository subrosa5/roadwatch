import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
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
  await page.unroute('**/api/**');
  let viewRequests=0, releasedViews=0, previewRequests=0, trackingRequests=0, staleTracking=false;
  const previewObservation={camera_id:'iowa-cbtv51',frame_id:'qa-synthetic-frame',captured_at:new Date().toISOString(),model:'QA SYNTHETIC ANNOTATIONS',detections:[{label:'fire',score:.95,box:[.54,.27,.18,.34]}]};
  const jpeg=(await readFile('web/clips/fire.jpg')).toString('base64');
  await page.route('https://video2.iowadot.gov:8888/**',route=>route.abort());
  await page.route('**/api/**',async route=>{
    const p=new URL(route.request().url()).pathname;
    if(p==='/api/health')return route.fulfill({json:{backend:'Sites D1/R2'}});
    if(p==='/api/cameras')return route.fulfill({json:[{id:'iowa-cbtv51',name:'QA · синтетический кадр аналитики',zone:'interstate29',enabled:true,approved:true,demo:false,health:'no_data',stream_url:'https://video2.iowadot.gov:8888/councilbluffs/cbtv51lb/playlist.m3u8',source_page:'https://iowadot.gov',collector:{online:true,state:'running',frames_analyzed:12}}]});
    if(p==='/api/stats')return route.fulfill({json:{collectors_online:1,receiving_real:0,daily_frames:1,daily_frame_limit:500,preview_quota:2,preview_daily_limit:6000}});
    if(p.endsWith('/view')){if(route.request().method()==='DELETE')releasedViews++;else viewRequests++;return route.fulfill({json:{active:true}});}
    if(p.endsWith('/watch')){trackingRequests++;return route.fulfill({status:404,json:{error:'Video relay is waiting for the collector'}});}
    if(p.endsWith('/preview')){previewRequests++;return route.fulfill({json:{observation:previewObservation,jpeg,stale:false}});}
    if(p==='/api/events'||p==='/api/sources')return route.fulfill({json:[]});
    return route.continue();
  });
  await page.addInitScript(()=>{window.__notificationRequests=0;if('Notification' in window)Notification.requestPermission=async()=>{window.__notificationRequests++;return 'denied';};});
  await page.goto(base);
  await page.waitForFunction(()=>document.getElementById('connected-count').textContent==='1');
  assert.equal(await page.evaluate(()=>window.__notificationRequests),0,'permission must not be requested automatically');
  await page.locator('#mode-analysis').click();
  await page.waitForFunction(()=>{const im=document.getElementById('camera-frame');return im.complete&&im.naturalWidth>0&&document.getElementById('analysis-tags').textContent.includes('95');});
  assert.equal(await page.locator('#camera-live').isHidden(),true);
  assert.equal(await page.locator('#overlay').isHidden(),false);
  assert.equal(viewRequests,1);
  await page.waitForTimeout(5500);
  assert.ok(previewRequests>=2);
  assert.equal(viewRequests,1,'5-second polling must not renew the viewer lease too often');
  await page.screenshot({path:'docs/screenshots/analysis.png',fullPage:true});
  await page.locator('#mode-tracking').click();
  await page.waitForFunction(()=>document.getElementById('scene-tag').textContent.includes('ТРЕКИНГ НЕ ПОСТУПАЕТ'));
  assert.equal(await page.locator('#camera-live').isHidden(),false);
  assert.equal(await page.locator('#camera-frame').isHidden(),true,'a stale analysis image must never replace live video');
  assert.equal(await page.locator('#video-unavailable').isHidden(),true);
  assert.ok(trackingRequests>=1);
  assert.equal((await page.locator('#video-time').textContent()).includes('задержка ~'),false);
  await page.locator('#mode-live').click();
  await page.waitForFunction(()=>getComputedStyle(document.getElementById('overlay')).display==='none');
  assert.ok(releasedViews>=1);
  await page.locator('#push-button').click();
  await page.waitForFunction(()=>document.getElementById('push-state').textContent.includes('не выдано'));
  assert.equal(await page.evaluate(()=>window.__notificationRequests),1);
  assert.deepEqual(errors, []);
  console.log(
    "Browser QA passed: video/events/review, mobile, cloud playback timeout/retry, player preservation, preview lease/frame matching, voluntary notification consent and no uncaught errors.",
  );
} finally {
  await browser.close();
  await app.close();
  await rm(dir, { recursive: true, force: true });
}
