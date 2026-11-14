// Credentials enter via hidden stdin only; never arguments, files, or logs.
import { readFile,writeFile } from "node:fs/promises";
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
if(input.operation==='tracking-probe') {
  for(let i=0;i<(input.maintain_view?15:6);i++){
    if(input.maintain_view&&i%4===0)await post('/api/cameras/iowa-cbtv51/view',{kind:'tracking'});
    const started=Date.now();
    const r=await fetch(new URL('/api/cameras/iowa-cbtv51/tracking',origin),{headers,redirect:'manual',signal:AbortSignal.timeout(15000)});
    if(!r.ok)console.log(JSON.stringify({status:r.status}));else {
      const d=await r.json();const jpeg=Buffer.from(d.jpeg,'base64');
      await writeFile('/private/tmp/roadwatch-hostrix-frame.jpg',jpeg);
      console.log(JSON.stringify({latency_ms:Date.now()-started,frame_id:d.observation.frame_id,captured_at:d.observation.captured_at,age_ms:Date.now()-Date.parse(d.observation.captured_at),stale:d.stale,tracks:d.observation.detections,jpeg_bytes:jpeg.length}));
    }
    if(i<(input.maintain_view?14:5))await new Promise(r=>setTimeout(r,1000));
  }
} else if(input.operation==='status') {
  const stats=await(await call('/api/stats')).json();
  const cs=await(await call('/api/cameras')).json();
  const camera=cs.find(c=>c.id==='iowa-cbtv51');
  const journal=await(await call('/api/events')).json();
  const demand=await(await call('/api/cameras/iowa-cbtv51/demand')).json();
  const tr=await fetch(new URL('/api/cameras/iowa-cbtv51/tracking',origin),{headers,redirect:'manual',signal:AbortSignal.timeout(15000)});
  const tracking=tr.ok?await tr.json():{http_status:tr.status,error:(await tr.text()).slice(0,120)};
  if(tracking.jpeg)tracking.jpeg_bytes=Buffer.from(tracking.jpeg,'base64').length;
  delete tracking.jpeg;
  let frame=null;
  const r=await fetch(new URL('/api/cameras/iowa-cbtv51/frame',origin),{headers,redirect:'manual',signal:AbortSignal.timeout(15000)});
  if(r.ok){const bytes=Buffer.from(await r.arrayBuffer());frame={bytes:bytes.length,id:r.headers.get('X-Frame-ID'),jpeg:bytes[0]===255&&bytes[1]===216};}
  console.log(JSON.stringify({collectors_online:stats.collectors_online,monitoring:stats.monitoring,collector:camera?.collector,latest_observation:camera?.latest?{frame_id:camera.latest.frame_id,captured_at:camera.latest.captured_at,model:camera.latest.model,detections:camera.latest.detections.length}:null,snapshot:frame,demand,tracking,real_events:journal.length,daily_frames:stats.daily_frames,tracking_quota:stats.tracking_quota}));
} else if(input.operation==='runtime') {
  await post('/api/ops/init',{});
  const cameras=await (await call('/api/cameras')).json();
  const first=cameras.find(c=>c.id==='iowa-cbtv51');
  if(!first?.enabled||!first?.approved)throw Error('Primary source not ready');
  if(cameras.find(c=>c.id==='iowa-wwdtv039')?.enabled)throw Error('Reserve unexpectedly enabled');
  const settings=await (await call('/api/push/settings')).json();
  if(!settings.public_key||!settings.available)throw Error('Push settings missing');
  await post('/api/cameras/iowa-cbtv51/view',{});
  const demand=await (await call('/api/cameras/iowa-cbtv51/demand')).json();
  await call('/api/cameras/iowa-cbtv51/view',{method:'DELETE'});
  if(!demand.active)throw Error('Viewer lease not active');
  const maintenance=await (await post('/api/ops/maintenance',{})).json();
  const stats=await (await call('/api/stats')).json();
  const zip=await call('/downloads/roadwatch-botkeep.zip');
  if(!zip.headers.get('content-type')?.includes('application/zip'))throw Error('ZIP MIME invalid');
  const bytes=Buffer.from(await zip.arrayBuffer());
  if(bytes.readUInt16LE(0)!==0x4b50)throw Error('ZIP header invalid');
  const real=await (await call('/api/events')).json();
  const anonymous=await fetch(new URL('/api/events',origin),{redirect:'manual'});
  if(anonymous.ok&&anonymous.headers.get('content-type')?.includes('application/json'))throw Error('Anonymous journal exposed');
  console.log(JSON.stringify({runtime_api_verified:true,source_enabled:true,reserve_enabled:false,collector_online:stats.collectors_online,real_events:real.length,preview_daily_limit:stats.preview_daily_limit,push_available:settings.available,push_subscriptions:settings.subscriptions,viewer_lease_verified:true,private_boundary:true,download_zip_bytes:bytes.length,download_zip_sha256:createHash('sha256').update(bytes).digest('hex'),maintenance}));
} else if (["browser", "live", "tracking-browser"].includes(input.operation)) {
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch({
    headless: true,
    executablePath: input.chromium,
  });
  const page = await browser.newPage({
    viewport: { width: 1512, height: 1100 },
  });
  const errors = [],trackingSamples=[];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console",m=>{if(input.operation==='tracking-browser'&&m.type()==='error')console.log(JSON.stringify({browser_console_error:m.text().slice(0,500)}));});
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
    const external = new URL(request.url());
    const publicIowa =
      external.protocol === "https:" &&
      /^video[24]\.iowadot\.gov$/.test(external.hostname) &&
      external.port === "8888";
    if (!same && !(input.operation === "live" && publicIowa))
      return route.abort();
    const response = await fetch(request.url(), {
      method: request.method(),
      headers: same ? { ...h, ...headers } : { Accept: "*/*" },
      body: request.postDataBuffer() || undefined,
      redirect: "manual",
    });
    const returned = Object.fromEntries(response.headers);
    delete returned["content-encoding"];
    delete returned["content-length"];
    delete returned["transfer-encoding"];
    const bytes=Buffer.from(await response.arrayBuffer());
    if(input.operation==='tracking-browser'&&same&&new URL(request.url()).pathname.endsWith('/tracking')&&response.ok){
      const data=JSON.parse(bytes.toString());
      trackingSamples.push({frame_id:data.observation.frame_id,captured_at:data.observation.captured_at,model:data.observation.model,stale:data.stale,detections:data.observation.detections});
    }
    return route.fulfill({status:response.status,headers:returned,body:bytes});
  });
  try {
    if(input.operation==='tracking-browser') {
      const documentResponse=await page.goto(origin.href);
      console.log(JSON.stringify({browser_visibility:await page.evaluate(()=>document.visibilityState),content_security_policy:documentResponse.headers()['content-security-policy']||null}));
      await page.waitForFunction(()=>document.querySelectorAll('#camera-picker .camera-choice').length===2);
      await page.locator('[data-camera="iowa-cbtv51"]').click();
      await page.locator('#mode-tracking').click();
      await page.waitForFunction(()=>{const im=document.getElementById('camera-frame');return im.complete&&im.naturalWidth>0&&document.getElementById('video-unavailable').hidden;},null,{timeout:35000});
      const first=await page.locator('#camera-frame').getAttribute('src');
      await page.waitForFunction(src=>document.getElementById('camera-frame').src!==src,first,{timeout:15000});
      const waitUntil=Date.now()+12000;
      while(Date.now()<waitUntil&&!trackingSamples.some(s=>s.detections.length))await page.waitForTimeout(1000);
      if(await page.locator('#overlay').isHidden())throw Error('Tracking overlay hidden');
      if(!(await page.locator('#camera-live').isHidden()))throw Error('Tracking mixed with unmatched HLS');
      const ids=new Set(trackingSamples.map(s=>s.frame_id));
      const trackIds=new Set(trackingSamples.flatMap(s=>s.detections.map(d=>d.track_id)));
      const stats=await(await call('/api/stats')).json();
      if(errors.length)throw Error('UI errors: '+errors.join(', '));
      if(!stats.monitoring)throw Error('Collector no longer online');
      if(ids.size<2||trackingSamples.at(-1)?.stale)throw Error('Tracking frames not advancing');
      await page.screenshot({path:'docs/screenshots/hostrix-tracking.png',fullPage:true});
      console.log(JSON.stringify({production_tracking_verified:true,synthetic_data:false,collectors_online:stats.collectors_online,real_frame_ids:ids.size,samples:trackingSamples.length,max_visible_tracks:Math.max(0,...trackingSamples.map(s=>s.detections.length)),unique_track_ids:trackIds.size,model:trackingSamples.at(-1)?.model,latest_captured_at:trackingSamples.at(-1)?.captured_at,overlay_visible:true,matching_frame_mode:true,uncaught_errors:errors.length}));
    } else if (input.operation === "live") {
      await post("/api/ops/init", {});
      await page.goto(origin.href);
      await page.waitForFunction(
        () =>
          document.querySelectorAll("#camera-picker .camera-choice").length ===
          2,
      );
      const results = [];
      for (const id of ["iowa-cbtv51", "iowa-wwdtv039"]) {
        await page.locator('[data-camera="' + id + '"]').click();
        await page.waitForFunction(
          () => {
            const v = document.getElementById("camera-live");
            return v.readyState >= 2 && v.videoWidth > 0 && !v.paused;
          },
          null,
          { timeout: 45000 },
        );
        const first = await page
          .locator("#camera-live")
          .evaluate((v) => v.currentTime);
        await page.waitForFunction(
          (t) => document.getElementById("camera-live").currentTime > t + 1,
          first,
          { timeout: 15000 },
        );
        const result = await page
          .locator("#camera-live")
          .evaluate((v) => ({
            width: v.videoWidth,
            height: v.videoHeight,
            currentTime: v.currentTime,
            readyState: v.readyState,
          }));
        // Cross the API refresh interval: a refresh must not reload the HLS engine.
        await page.waitForTimeout(6000);
        const after = await page
          .locator("#camera-live")
          .evaluate((v) => v.currentTime);
        if (after < result.currentTime)
          throw Error("Polling reset live player");
        if (!(await page.locator("#overlay").isHidden()))
          throw Error("Unverified boxes overlay real video");
        results.push({ camera: id, ...result, pollingPreservesPlayer: true });
      }
      await page.screenshot({
        path: "docs/screenshots/iowa-live.png",
        fullPage: true,
      });
      if (errors.length) throw Error("Live UI errors: " + errors.join(", "));
      console.log(
        JSON.stringify({
          live: results,
          uncaughtErrors: errors.length,
          transport:
            "Test browser uses Node HTTPS bridge; provider receives no Sites credentials",
          serverCV: false,
        }),
      );
    } else {
      await page.goto(origin.href + "?cloud-demo=1");
      await page.waitForFunction(
        () =>
          document.getElementById("mode-badge").textContent ===
          "Учебный облачный API",
      );
      await page.waitForFunction(
        () =>
          document.querySelectorAll("#camera-picker .camera-choice").length ===
          3,
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
          document.getElementById("mode-badge").textContent ===
          "Облачный журнал",
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
    }
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
  if (input.operation === "final") {
    const retention = await (await post("/api/ops/retention", {})).json();
    const probes = await (await post("/api/ops/probe-sources", {})).json();
    console.log(JSON.stringify({ retention, probes }));
  }
}
