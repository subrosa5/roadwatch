// Credentials enter via hidden stdin only; never arguments, files, or logs.
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const input = await new Promise((resolve, reject) => {
  let value = "";
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdout.write(
    "Ready for private verification JSON on stdin (hidden).\n",
  );
  process.stdin.on("data", (chunk) => {
    value += chunk.toString();
    if (value.includes("\n")) {
      process.stdin.pause();
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      try {
        resolve(JSON.parse(value.trim()));
      } catch (e) {
        reject(e);
      }
    }
  });
});
const origin = new URL(input.site_url);
if (origin.protocol !== "https:" || !origin.hostname.endsWith(".chatgpt.site"))
  throw Error("Expected private Sites HTTPS origin");
const headers = {
  "OAI-Sites-Authorization": "Bearer " + input.bypass,
  Authorization: "Bearer " + input.ingest,
};
async function call(path, options = {}) {
  const r = await fetch(new URL(path, origin), {
    ...options,
    headers: { ...headers, ...options.headers },
    redirect: "manual",
    signal: AbortSignal.timeout(45000),
  });
  if (!r.ok)
    throw Error(
      path + " returned " + r.status + " " + (await r.text()).slice(0, 100),
    );
  return r;
}
const post = (path, body) =>
  call(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
if (input.operation === "browser") {
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch({
    headless: true,
    executablePath: input.chromium,
  });
  const page = await browser.newPage({
    viewport: { width: 1512, height: 1100 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/*", async (route) => {
    if (
      route.request().url().startsWith("blob:") ||
      route.request().url().startsWith("data:")
    )
      return route.continue();
    const request = route.request();
    const same = new URL(request.url()).origin === origin.origin;
    const h = { ...request.headers() };
    delete h["oai-sites-authorization"];
    delete h.authorization;
    if (!same) return route.abort();
    const response = await fetch(request.url(), {
      method: request.method(),
      headers: { ...h, ...headers },
      body: request.postDataBuffer() || undefined,
      redirect: "manual",
    });
    const returned = Object.fromEntries(response.headers);
    delete returned["content-encoding"];
    delete returned["content-length"];
    delete returned["transfer-encoding"];
    return route.fulfill({
      status: response.status,
      headers: returned,
      body: Buffer.from(await response.arrayBuffer()),
    });
  });
  try {
    await page.goto(origin.href + "?cloud-demo=1");
    await page.waitForFunction(
      () =>
        document.getElementById("mode-badge").textContent ===
        "Учебный облачный API",
    );
    await page.waitForFunction(
      () =>
        document.querySelectorAll("#camera-picker .camera-choice").length === 3,
    );
    await page.locator("#event-feed [data-event]").first().click();
    await page.waitForFunction(
      () => document.getElementById("event-video").readyState >= 1,
    );
    await page.locator("#event-video").evaluate(async (v) => {
      v.muted = true;
      await v.play();
    });
    await page.waitForFunction(
      () => document.getElementById("event-video").currentTime > 0,
    );
    const video = await page
      .locator("#event-video")
      .evaluate((v) => ({ duration: v.duration, width: v.videoWidth }));
    if (video.duration < 10 || video.width < 100)
      throw Error("Cloud clip not playable");
    await page.screenshot({
      path: "docs/screenshots/cloud.png",
      fullPage: true,
    });
    await page.locator("#close-event").click();
    await page.goto(origin.href);
    await page.waitForFunction(
      () =>
        document.getElementById("mode-badge").textContent === "Облачный журнал",
    );
    await page.waitForFunction(
      () => document.getElementById("event-count").textContent === "0",
    );
    if (!(await page.locator("#demo-notice").isHidden()))
      throw Error("Real mode contains demo notice");
    if (errors.length) throw Error("Cloud UI errors: " + errors.join(", "));
    console.log(
      JSON.stringify({
        cloud_ui: true,
        playable_saved_clip: video,
        real_journal_empty: true,
        uncaught_errors: errors.length,
      }),
    );
  } finally {
    await browser.close();
  }
} else if (input.operation === "probe") {
  await call("/api/ops/probe-sources", { method: "POST" });
  console.log(
    JSON.stringify({ probes: await (await call("/api/sources")).json() }),
  );
} else if (input.operation === "source") {
  const data = await (
    await call(
      "/api/ops/source-document?source_id=" +
        encodeURIComponent(input.source_id),
    )
  ).json();
  console.log(
    JSON.stringify({
      source_id: data.source_id,
      status: data.status,
      html: data.html.slice(0, 10000),
    }),
  );
} else {
  const health = await (await call("/api/health")).json();
  if (health.backend !== "Sites D1/R2") throw Error("Cloud backend missing");
  await post("/api/ops/init", {});
  const demos = [
    ["demo-garden", "collision"],
    ["demo-ttk", "smoke"],
    ["demo-mkad", "fire"],
  ];
  let checked = 0;
  const existing = await (await call("/api/events?demo=1")).json();
  for (const [camera_id, label] of demos) {
    let event = existing.find((e) => e.camera_id === camera_id);
    if (!event) {
      const t = Date.now() - 2000;
      for (let i = 0; i < 2; i++) {
        const r = await post("/api/observations", {
          camera_id,
          frame_id: "cloud-fixture-" + crypto.randomUUID(),
          captured_at: new Date(t + i * 1000).toISOString(),
          demo: true,
          model: "synthetic-cloud-fixture-v1",
          detections: [{ label, score: 0.95, box: [0.15, 0.2, 0.25, 0.3] }],
        });
        const data = await r.json();
        if (data.events.length) event = data.events[0];
      }
    }
    if (!event) throw Error("No fixture event");
    if (!event.evidence_id) {
      const clip = await readFile(
        new URL("../web/clips/" + label + ".mp4", import.meta.url),
      );
      const evidence = await (
        await call("/api/events/" + event.id + "/evidence", {
          method: "POST",
          headers: { "Content-Type": "video/mp4" },
          body: clip,
        })
      ).json();
      if (evidence.sha256 !== createHash("sha256").update(clip).digest("hex"))
        throw Error("Evidence hash mismatch");
      event.evidence_id = evidence.id;
    }
    const range = await call("/api/evidence/" + event.evidence_id, {
      headers: { Range: "bytes=4-7" },
    });
    if (range.status !== 206 || (await range.text()) !== "ftyp")
      throw Error("Range playback failed");
    const cameras = await (await call("/api/cameras?demo=1")).json();
    const current = cameras.find((c) => c.id === camera_id)?.latest;
    if (current) {
      await call("/api/cameras/" + camera_id + "/frame", {
        method: "POST",
        headers: {
          "X-Frame-ID": current.frame_id,
          "Content-Type": "image/jpeg",
        },
        body: await readFile(
          new URL("../web/clips/" + label + ".jpg", import.meta.url),
        ),
      });
      const image = await call("/api/cameras/" + camera_id + "/frame");
      if (image.headers.get("X-Frame-ID") !== current.frame_id)
        throw Error("Frame ID mismatch");
      await image.arrayBuffer();
    }
    await post("/api/events/" + event.id + "/review", { status: "confirmed" });
    if (
      !(await (await call("/api/events?demo=1")).json()).some(
        (e) => e.id === event.id && e.status === "confirmed",
      )
    )
      throw Error("Review did not persist");
    await post("/api/events/" + event.id + "/review", { status: "unreviewed" });
    checked++;
  }
  const real = await (await call("/api/events")).json();
  if (real.length) throw Error("Real journal unexpectedly populated");
  const noRole = await fetch(new URL("/api/events", origin), {
    headers: { "OAI-Sites-Authorization": "Bearer " + input.bypass },
    redirect: "manual",
  });
  if (noRole.status !== 401) throw Error("Application role not enforced");
  const anonymous = await fetch(new URL("/api/events", origin), {
    redirect: "manual",
  });
  if (
    anonymous.ok &&
    anonymous.headers.get("Content-Type")?.includes("application/json")
  )
    throw Error("Anonymous API exposed");
  console.log(
    JSON.stringify({
      cloud_backend: health.backend,
      synthetic_events_verified: checked,
      real_events: real.length,
      private_boundary: true,
      review_persisted: true,
      mp4_range_and_hash: true,
      snapshot_frame_match: true,
    }),
  );
  if(input.operation==='final'){
    const retention=await (await post('/api/ops/retention',{})).json();
    const probes=await (await post('/api/ops/probe-sources',{})).json();
    console.log(JSON.stringify({retention,probes}));
  }
}
