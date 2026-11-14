import {
  observation,
  candidates,
  capacity,
  cameraHealth,
  InputError,
} from "../src/core.mjs";

import { createRuntime } from "./runtime.mjs";

// This deployment MUST remain owner-private in Sites. Service requests also
// require Sites dispatch authorization; the application secret adds a narrow role.
const TARGET = 2;
const FRAME_LIMIT = 500;
const STORAGE_LIMIT = 100 * 1024 * 1024;
const PROBE_PAGES = [
  {
    id: "iowa-catalog",
    url: "https://www.arcgis.com/sharing/rest/content/items/c4063f200a7b4da5826e2ac86c677cf5?f=json",
  },
  ...CAMERA_CONFIG.filter((c) => c.source_kind === "public_hls").map((c) => ({
    id: c.id,
    url: c.stream_url,
  })),
];
const json = (value, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
const fail = (message, status = 400) => {
  throw new InputError(message, status);
};
const stmt = (env, sql, ...args) => env.DB.prepare(sql).bind(...args);
const rows = async (env, sql, ...args) =>
  (await stmt(env, sql, ...args).all()).results;
const first = (env, sql, ...args) => stmt(env, sql, ...args).first();
const now = () => new Date().toISOString();
const eventView = (e) => ({
  ...e,
  demo: !!e.demo,
  recording_status: e.evidence_id ? "ready" : "unavailable",
});
const sameOrigin = (r) =>
  !r.headers.get("Origin") || r.headers.get("Origin") === new URL(r.url).origin;

async function bodyBytes(request, limit) {
  if (Number(request.headers.get("Content-Length") || 0) > limit)
    fail("Request too large", 413);
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const parts = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) {
        await reader.cancel();
        fail("Request too large", 413);
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}
async function bodyJSON(request) {
  try {
    return JSON.parse(
      new TextDecoder().decode(await bodyBytes(request, 1024 * 1024)),
    );
  } catch (e) {
    if (e instanceof InputError) throw e;
    fail("Invalid JSON");
  }
}
async function sha256(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}
async function secretMatch(value, expected) {
  if (!expected || expected.length < 32 || !value) return false;
  const a = await sha256(new TextEncoder().encode(value)),
    b = await sha256(new TextEncoder().encode(expected));
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
async function authorize(request, env) {
  const service = await secretMatch(
    request.headers.get("Authorization")?.replace(/^Bearer /, ""),
    env.INGEST_TOKEN,
  );
  const user = request.headers.get("oai-authenticated-user-id");
  if (!service && !user) fail("Authentication required", 401);
  if (
    request.method !== "GET" &&
    !service &&
    (!sameOrigin(request) || request.headers.get("X-Roadwatch-Write") !== "1")
  )
    fail("Same-origin write required", 403);
  return { service, actor: user || "collector" };
}
const runtime = env => createRuntime({env,config:CAMERA_CONFIG,observation,fail,first,rows,stmt,bodyJSON,sha256,now});
async function maintenance(env,fetcher,origin,force=false) {
 const rt=runtime(env),last=await rt.read('maintenance:retention');
 let cleaned=null;
 if(force||!last||Date.now()-Date.parse(last.received_at)>300000) {
   await rt.write('maintenance:retention',{state:'running'});
   try {cleaned=await (await retention(env)).json();await rt.write('maintenance:retention',{state:'ok',...cleaned});}
   catch(error){await rt.write('maintenance:retention',{state:'failed'});throw error;}
 }
 const notifications=await rt.dispatch(fetcher,origin);
 return {retention:cleaned,notifications};
}
async function cameras(env) {
  const cs = await rows(env, "SELECT data FROM rw_cameras");
  return Promise.all(
    cs
      .filter((row) =>
        CAMERA_CONFIG.some((c) => c.id === JSON.parse(row.data).id),
      )
      .map(async (row) => {
        const c = JSON.parse(row.data);
        const o = await first(
          env,
          "SELECT data FROM rw_observations WHERE camera_id=? ORDER BY captured_at DESC LIMIT 1",
          c.id,
        );
        const latest = o ? JSON.parse(o.data) : null;
        return { ...c, health: cameraHealth(c, latest), latest, collector:c.demo?null:await runtime(env).health(c.id) };
      }),
  );
}
async function init(env) {
  await env.DB.batch(
    CAMERA_CONFIG.map((c) =>
      stmt(
        env,
        "INSERT INTO rw_cameras(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
        c.id,
        JSON.stringify(c),
      ),
    ),
  );
  return json({
    initialized: true,
    target: TARGET,
    approved_real: CAMERA_CONFIG.filter(
      (c) => !c.demo && c.approved && c.enabled,
    ).length,
  });
}
async function ingest(request, env, auth) {
  if (!auth.service) fail("Collector role required", 403);
  const raw = await bodyJSON(request);
  const o = observation(raw);
  const day = o.captured_at.slice(0, 10);
  const row = await first(
    env,
    "SELECT data FROM rw_cameras WHERE id=?",
    o.camera_id,
  );
  if (!row) fail("Unknown camera", 404);
  const c = JSON.parse(row.data);
  if (!c.enabled || !c.approved) fail("Camera not approved/enabled", 403);
  if (Boolean(raw.demo) !== Boolean(c.demo))
    fail("Demo provenance mismatch", 403);
  const previousRow = await first(
    env,
    "SELECT data FROM rw_observations WHERE camera_id=? ORDER BY captured_at DESC LIMIT 1",
    c.id,
  );
  const previous = previousRow ? JSON.parse(previousRow.data) : null;
  const duplicate = await first(
    env,
    "SELECT frame_id FROM rw_observations WHERE camera_id=? AND frame_id=?",
    c.id,
    o.frame_id,
  );
  if (duplicate) return json({duplicate:true,events:(await rows(env,"SELECT * FROM rw_events WHERE camera_id=? AND frame_id=?",c.id,o.frame_id)).map(eventView)});
  if (previous && o.captured_at <= previous.captured_at)
    fail("Out-of-order frame", 409);
  const eventTypes = candidates(o, previous);
  const commands = [
    stmt(
      env,
      `INSERT OR IGNORE INTO rw_observations(camera_id,frame_id,captured_at,day,data)
    SELECT ?,?,?,?,? WHERE (SELECT COUNT(*) FROM rw_observations WHERE day=?)<?
    AND COALESCE((SELECT MAX(captured_at) FROM rw_observations WHERE camera_id=?),'')=?`,
      c.id,
      o.frame_id,
      o.captured_at,
      day,
      JSON.stringify(o),
      day,
      FRAME_LIMIT,
      c.id,
      previous?.captured_at || "",
    ),
  ];
  const ids = [];
  for (const type of eventTypes) {
    const id = crypto.randomUUID();
    ids.push(id);
    commands.push(
      stmt(
        env,
        `INSERT OR IGNORE INTO rw_events(id,camera_id,frame_id,type,captured_at,created_at,demo,model,description)
    SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM rw_observations WHERE camera_id=? AND frame_id=?)
    AND NOT EXISTS(SELECT 1 FROM rw_events WHERE camera_id=? AND type=? AND captured_at>?)`,
        id,
        c.id,
        o.frame_id,
        type,
        o.captured_at,
        now(),
        c.demo ? 1 : 0,
        o.model,
        c.demo
          ? "Синтетическая проверка облачного API. Не реальное происшествие."
          : "Признаки на двух кадрах. Требуется проверка человеком.",
        c.id,
        o.frame_id,
        c.id,
        type,
        new Date(Date.parse(o.captured_at) - 120000).toISOString(),
      ),
    );
  }
  for(const id of ids)commands.push(runtime(env).queueStatement(id));
  const result = await env.DB.batch(commands);
  if (!result[0].meta.changes) {
    const count = await first(
      env,
      "SELECT COUNT(*) AS n FROM rw_observations WHERE day=?",
      day,
    );
    fail(
      count.n >= FRAME_LIMIT
        ? "Daily frame quota reached"
        : "Concurrent frame; retry with fresh input",
      count.n >= FRAME_LIMIT ? 429 : 409,
    );
  }
  const created = [];
  for (const id of ids) {
    const event = await first(env, "SELECT * FROM rw_events WHERE id=?", id);
    if (event) created.push(eventView(event));
  }
  return json({ accepted: true, events: created }, 201);
}
async function frame(request, env, id, auth) {
  const current = await first(
    env,
    "SELECT data FROM rw_observations WHERE camera_id=? ORDER BY captured_at DESC LIMIT 1",
    id,
  );
  if (!current) fail("No observation", 404);
  const o = JSON.parse(current.data);
  if (request.method === "POST") {
    if (!auth.service) fail("Collector role required", 403);
    if (request.headers.get("X-Frame-ID") !== o.frame_id)
      fail("Frame ID mismatch", 409);
    const bytes = await bodyBytes(request, 2 * 1024 * 1024);
    if (bytes[0] !== 255 || bytes[1] !== 216 || bytes[2] !== 255)
      fail("JPEG required");
    const key = "frames/" + id + "/" + crypto.randomUUID() + ".jpg";
    await env.BUCKET.put(key, bytes, {
      httpMetadata: { contentType: "image/jpeg" },
    });
    const old = await first(
      env,
      "SELECT object_key FROM rw_snapshots WHERE camera_id=?",
      id,
    );
    try {
      await stmt(
        env,
        `INSERT INTO rw_snapshots(camera_id,frame_id,object_key,captured_at) VALUES(?,?,?,?) ON CONFLICT(camera_id) DO UPDATE SET frame_id=excluded.frame_id,object_key=excluded.object_key,captured_at=excluded.captured_at WHERE excluded.captured_at>=rw_snapshots.captured_at`,
        id,
        o.frame_id,
        key,
        o.captured_at,
      ).run();
    } catch (e) {
      await env.BUCKET.delete(key);
      throw e;
    }
    const stored = await first(
      env,
      "SELECT object_key FROM rw_snapshots WHERE camera_id=?",
      id,
    );
    if (stored.object_key !== key) {
      await env.BUCKET.delete(key);
      fail("Newer snapshot already stored", 409);
    }
    if (old && old.object_key !== key) await env.BUCKET.delete(old.object_key);
    return json({ stored: true, frame_id: o.frame_id });
  }
  const f = await first(
    env,
    "SELECT * FROM rw_snapshots WHERE camera_id=?",
    id,
  );
  if (!f) fail("No snapshot", 404);
  const object = await env.BUCKET.get(f.object_key);
  if (!object) fail("Snapshot unavailable", 404);
  return new Response(object.body, {
    headers: {
      "Content-Type": "image/jpeg",
      "Cache-Control": "no-store",
      "X-Frame-ID": f.frame_id,
      "X-Content-Type-Options": "nosniff",
    },
  });
}
async function uploadEvidence(request, env, eventId, auth) {
  if (!auth.service) fail("Collector role required", 403);
  const event = await first(
    env,
    "SELECT id FROM rw_events WHERE id=?",
    eventId,
  );
  if (!event) fail("Event not found", 404);
  const bytes = await bodyBytes(request, 25 * 1024 * 1024);
  if (new TextDecoder().decode(bytes.slice(4, 8)) !== "ftyp")
    fail("MP4 required");
  const hash = await sha256(bytes),
    id = crypto.randomUUID(),
    key = "evidence/" + id + ".mp4";
  const previous=await first(env,"SELECT * FROM rw_evidence WHERE event_id=? AND state IN ('ready','uploading') ORDER BY created_at DESC LIMIT 1",eventId);
  if(previous) {
    if(previous.state==='ready' && previous.sha256===hash)return json({id:previous.id,sha256:hash,bytes:previous.bytes,duplicate:true});
    fail(previous.state==='uploading'?'Upload pending; retry later':'Event already has different evidence',409);
  }
  const reservation = await stmt(
    env,
    `INSERT INTO rw_evidence(id,event_id,object_key,bytes,sha256,state,created_at)
    SELECT ?,?,?,?,?,'uploading',? WHERE COALESCE((SELECT SUM(bytes) FROM rw_evidence WHERE state IN ('ready','uploading')),0)+?<=? AND NOT EXISTS(SELECT 1 FROM rw_evidence WHERE event_id=? AND state IN ('ready','uploading'))`,
    id,
    eventId,
    key,
    bytes.length,
    hash,
    now(),
    bytes.length,
    STORAGE_LIMIT,
    eventId,
  ).run();
  if (!reservation.meta.changes) {
    const active=await first(env,"SELECT id FROM rw_evidence WHERE event_id=? AND state IN ('ready','uploading')",eventId);
    fail(active?'Upload already reserved':'Evidence storage budget reached',active?409:507);
  }
  try {
    await env.BUCKET.put(key, bytes, {
      httpMetadata: { contentType: "video/mp4" },customMetadata:{sha256:hash,event_id:eventId},
    });
    await env.DB.batch([
      stmt(env, "UPDATE rw_evidence SET state='ready' WHERE id=?", id),
      stmt(env, "UPDATE rw_events SET evidence_id=? WHERE id=?", id, eventId),
    ]);
  } catch (e) {
    // Keep the durable reservation: R2 or D1 may have committed before an
    // ambiguous network error. Maintenance reconciles it; retries are idempotent.
    fail("Evidence upload interrupted; retry later",503);
  }
  return json({ id, sha256: hash, bytes: bytes.length }, 201);
}
async function evidence(request, env, id) {
  const e = await first(
    env,
    "SELECT * FROM rw_evidence WHERE id=? AND state='ready'",
    id,
  );
  if (!e) fail("Evidence unavailable", 404);
  const range = request.headers.get("Range");
  let offset = 0,
    length = e.bytes,
    status = 200;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!m || (!m[1] && !m[2]))
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": "bytes */" + e.bytes },
      });
    if (!m[1]) {
      length = Math.min(Number(m[2]), e.bytes);
      offset = e.bytes - length;
    } else {
      offset = Number(m[1]);
      length =
        (m[2] ? Math.min(Number(m[2]), e.bytes - 1) : e.bytes - 1) - offset + 1;
    }
    if (offset >= e.bytes || length <= 0)
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": "bytes */" + e.bytes },
      });
    status = 206;
  }
  const object = await env.BUCKET.get(
    e.object_key,
    range ? { range: { offset, length } } : undefined,
  );
  if (!object) fail("Evidence file unavailable", 404);
  const headers = {
    "Content-Type": "video/mp4",
    "Accept-Ranges": "bytes",
    "Content-Length": String(length),
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Content-SHA256": e.sha256,
  };
  if (range)
    headers["Content-Range"] =
      `bytes ${offset}-${offset + length - 1}/${e.bytes}`;
  return new Response(object.body, { status, headers });
}
async function probe(env, fetcher) {
  const results = await Promise.all(
    PROBE_PAGES.map(async (source) => {
      const checked_at = now();
      let result;
      try {
        const response = await fetcher(source.url, {
          redirect: "manual",
          signal: AbortSignal.timeout(8000),
          headers: { "User-Agent": "Roadwatch/0.2 source-availability-check" },
        });
        const data = await bodyBytes(response, 256 * 1024);
        const html = new TextDecoder().decode(data);
        result = {
          source_id: source.id,
          url: source.url,
          checked_at,
          http_status: response.status,
          reachable: response.ok,
          bytes: data.length,
          title: (/<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1] || "").slice(
            0,
            120,
          ),
          stream_verified: false,
          analysis_enabled: false,
        };
      } catch (error) {
        result = {
          source_id: source.id,
          url: source.url,
          checked_at,
          reachable: false,
          error: error.name === "TimeoutError" ? "timeout" : "fetch_failed",
          stream_verified: false,
          analysis_enabled: false,
        };
      }
      await stmt(
        env,
        "INSERT INTO rw_probes(source_id,checked_at,data) VALUES(?,?,?) ON CONFLICT(source_id) DO UPDATE SET checked_at=excluded.checked_at,data=excluded.data",
        source.id,
        checked_at,
        JSON.stringify(result),
      ).run();
      return result;
    }),
  );
  return json(results);
}
async function retention(env) {
  let recovered=0,abandoned=0;
  const pending=await rows(env,"SELECT * FROM rw_evidence WHERE state='uploading' AND created_at<? LIMIT 2",new Date(Date.now()-10*60000).toISOString());
  for(const item of pending) {
    const object=await env.BUCKET.head(item.object_key);
    if(object && object.size===item.bytes && object.customMetadata?.sha256===item.sha256 && object.customMetadata?.event_id===item.event_id) {
      const event=await first(env,'SELECT id FROM rw_events WHERE id=?',item.event_id);
      if(event){await env.DB.batch([stmt(env,"UPDATE rw_evidence SET state='ready' WHERE id=?",item.id),stmt(env,'UPDATE rw_events SET evidence_id=? WHERE id=?',item.id,item.event_id)]);recovered++;continue;}
    }
    await env.BUCKET.delete(item.object_key);await stmt(env,"UPDATE rw_evidence SET state='failed' WHERE id=?",item.id).run();abandoned++;
  }
  const cutoff = new Date(Date.now() - 7 * 86400000).toISOString();
  const expired = await rows(
    env,
    "SELECT id,object_key FROM rw_evidence WHERE created_at<? AND state IN ('ready','uploading') ORDER BY created_at LIMIT 5",
    cutoff,
  );
  for (const e of expired) {
    await env.BUCKET.delete(e.object_key);
    await env.DB.batch([
      stmt(
        env,
        "UPDATE rw_events SET evidence_id=NULL WHERE evidence_id=?",
        e.id,
      ),
      stmt(env, "UPDATE rw_evidence SET state='expired' WHERE id=?", e.id),
    ]);
  }
  const old = new Date(Date.now() - 86400000).toISOString();
  const pruned = await stmt(
    env,
    "DELETE FROM rw_observations WHERE rowid IN (SELECT rowid FROM rw_observations WHERE captured_at<? LIMIT 500)",
    old,
  ).run();
  const snapshots = await rows(
    env,
    "SELECT camera_id,object_key FROM rw_snapshots WHERE captured_at<? LIMIT 2",
    old,
  );
  for (const f of snapshots) {
    await env.BUCKET.delete(f.object_key);
    await stmt(
      env,
      "DELETE FROM rw_snapshots WHERE camera_id=? AND object_key=?",
      f.camera_id,
      f.object_key,
    ).run();
  }
  for(const camera of CAMERA_CONFIG.filter(c=>!c.demo)) {
    const object=await env.BUCKET.head('previews/'+camera.id+'.jpg');
    if(object && Date.parse(object.customMetadata?.captured_at||'')<Date.now()-86400000)await env.BUCKET.delete('previews/'+camera.id+'.jpg');
    const track=await env.BUCKET.head('tracking/'+camera.id+'.json');
    if(track && Date.parse(track.customMetadata?.captured_at||'')<Date.now()-86400000)await env.BUCKET.delete('tracking/'+camera.id+'.json');
  }
  await stmt(env,"DELETE FROM rw_probes WHERE checked_at<? AND (source_id LIKE 'pushq:%' OR source_id LIKE 'preview-quota:%' OR source_id LIKE 'tracking-quota:%' OR source_id LIKE 'view:%')",cutoff).run();
  return json({
    expired_clips: expired.length,
    pruned_observations: pruned.meta.changes,
    expired_snapshots: snapshots.length,
    recovered_uploads: recovered, abandoned_uploads: abandoned,
    automatic_schedule: "collector_hourly_and_api_activity",
  });
}
export function createWorker(fetcher = fetch) {
  return {
    async fetch(request, env, ctx) {
      try {
        const u = new URL(request.url),
          path = u.pathname;
        if (!path.startsWith("/api/")) return serveAsset(path, request);
        if (path === "/api/health" && request.method === "GET")
          return json({
            version: "0.2.0",
            mode: "cloud",
            backend: "Sites D1/R2",
            target_cameras: TARGET,
            monitoring: null,monitoring_status:"/api/stats",
          });
        const auth = await authorize(request, env);
        if (!env.DB || !env.BUCKET) fail("Storage bindings unavailable", 503);
        if(ctx?.waitUntil)ctx.waitUntil(maintenance(env,fetcher,u.origin).catch(()=>{}));
        const rt=runtime(env);
        if(path==='/api/ops/maintenance'&&request.method==='POST')return json(await maintenance(env,fetcher,u.origin,true));
        if(path==='/api/push/settings'&&request.method==='GET')return json(await rt.pushSettings());
        if(path==='/api/push/subscription'&&['POST','DELETE'].includes(request.method))return json(await rt.subscribe(request,auth));
        let activeRoute=path.match(/^\/api\/cameras\/([a-z0-9-]{1,80})\/(heartbeat|view|demand|preview|tracking)$/);
        if(activeRoute){
          const [,id,action]=activeRoute;
          if(action==='heartbeat'&&request.method==='POST')return json(await rt.heartbeat(id,request,auth));
          if(action==='view'&&['POST','DELETE'].includes(request.method))return json(await rt.viewing(id,request,auth));
          if(action==='demand'&&request.method==='GET')return json(await rt.demand(id,auth));
          if(action==='tracking'&&['GET','POST'].includes(request.method))return json(await rt.tracking(id,request,auth));
          if(action==='preview'&&['GET','POST'].includes(request.method))return json(await rt.preview(id,request,auth));
        }
        if (path === "/api/ops/init" && request.method === "POST")
          return await init(env);
        if (path === "/api/ops/probe-sources" && request.method === "POST")
          return await probe(env, fetcher);
        if (path === "/api/ops/retention" && request.method === "POST")
          return await retention(env);
        if (path === "/api/ops/source-document" && request.method === "GET") {
          if (!auth.service) fail("Collector role required", 403);
          const source = PROBE_PAGES.find(
            (p) => p.id === u.searchParams.get("source_id"),
          );
          if (!source) fail("Unknown source", 404);
          const response = await fetcher(source.url, {
            redirect: "manual",
            signal: AbortSignal.timeout(8000),
          });
          return json({
            source_id: source.id,
            status: response.status,
            html: new TextDecoder().decode(
              await bodyBytes(response, 256 * 1024),
            ),
          });
        }
        if (path === "/api/sources" && request.method === "GET")
          return json(
            (await rows(env, "SELECT data FROM rw_probes ORDER BY source_id"))
              .map((r) => JSON.parse(r.data))
              .filter((p) => PROBE_PAGES.some((s) => s.id === p.source_id)),
          );
        if (path === "/api/cameras" && request.method === "GET")
          return json(
            (await cameras(env)).filter(
              (c) =>
                c.demo === (u.searchParams.get("demo") === "1") &&
                c.pilot !== false,
            ),
          );
        if (path === "/api/stats" && request.method === "GET") {
          const cs = await cameras(env),
            usage = await first(
              env,
              "SELECT COUNT(*) AS n FROM rw_observations WHERE day=?",
              now().slice(0, 10),
            );
          return json({
            mode: u.searchParams.get("demo") === "1" ? "demo" : "cloud",
            receiving_real: cs.filter(
              (c) => !c.demo && c.health === "receiving",
            ).length,
            target: TARGET,
            daily_frames: usage.n,
            daily_frame_limit: FRAME_LIMIT,
            collectors_online: cs.filter(c=>!c.demo && c.collector?.online).length,
            monitoring: cs.some(c=>!c.demo && c.collector?.online),
            model_ready: cs.some(c=>!c.demo && c.collector?.online),
            preview_quota: (await rt.read('preview-quota:'+now().slice(0,10)))?.count||0,
            preview_daily_limit:6000,tracking_daily_limit:24000,tracking_quota:(await rt.read('tracking-quota:'+now().slice(0,10)))?.count||0,
            maintenance:await rt.read('maintenance:retention'),
          });
        }
        if (path === "/api/capacity" && request.method === "GET")
          return json(capacity({ cameras: TARGET, fps: 0.2 }));
        if (path === "/api/events" && request.method === "GET")
          return json(
            (
              await rows(
                env,
                "SELECT * FROM rw_events WHERE demo=? ORDER BY captured_at DESC LIMIT 100",
                u.searchParams.get("demo") === "1" ? 1 : 0,
              )
            ).map(eventView),
          );
        if (path === "/api/observations" && request.method === "POST")
          return await ingest(request, env, auth);
        let match = path.match(/^\/api\/cameras\/([a-z0-9-]{1,80})\/frame$/);
        if (match && ["GET", "POST"].includes(request.method))
          return await frame(request, env, match[1], auth);
        match = path.match(/^\/api\/events\/([a-zA-Z0-9-]{1,80})\/evidence$/);
        if (match && request.method === "POST")
          return await uploadEvidence(request, env, match[1], auth);
        match = path.match(/^\/api\/evidence\/([a-zA-Z0-9-]{1,80})$/);
        if (match && request.method === "GET")
          return await evidence(request, env, match[1]);
        match = path.match(/^\/api\/events\/([a-zA-Z0-9-]{1,80})\/review$/);
        if (match && request.method === "POST") {
          const { status } = await bodyJSON(request);
          if (!["confirmed", "dismissed", "unreviewed"].includes(status))
            fail("Invalid review status");
          if (
            !(await first(env, "SELECT id FROM rw_events WHERE id=?", match[1]))
          )
            fail("Event not found", 404);
          await env.DB.batch([
            stmt(
              env,
              "INSERT INTO rw_reviews VALUES(?,?,?,?,?)",
              crypto.randomUUID(),
              match[1],
              status,
              auth.actor,
              now(),
            ),
            stmt(
              env,
              "UPDATE rw_events SET status=? WHERE id=?",
              status,
              match[1],
            ),
          ]);
          return json(
            eventView(
              await first(env, "SELECT * FROM rw_events WHERE id=?", match[1]),
            ),
          );
        }
        fail("Not found", 404);
      } catch (error) {
        if(request.method==='POST'&&/^\/api\/cameras\/[a-z0-9-]{1,80}\/tracking$/.test(new URL(request.url).pathname)){
          const codes={
            'Tracking frame too old':'frame_expired','Stale or future frame':'invalid_frame_time',
            'Tracking frames must be chronological':'frame_order','Invalid tracking identity':'track_identity',
            'Tracking frame hash mismatch':'frame_hash','Box must be normalized [x,y,width,height]':'invalid_box',
            'Invalid tracking batch':'batch_shape','Invalid JSON':'invalid_json','Request too large':'body_size',
            'Invalid tracking JPEG':'jpeg_encoding','JPEG required':'jpeg_format',
          };
          // Only fixed codes: never log payloads, credentials or error contents.
          console.warn(JSON.stringify({component:'tracking_ingest',status:error instanceof InputError?error.status:500,code:error instanceof InputError?(codes[error.message]||'validation_rejected'):'storage_error'}));
        }
        return json(
          {
            error:
              error instanceof InputError
                ? error.message
                : "Service operation failed",
          },
          error instanceof InputError ? error.status : 500,
        );
      }
    },
  };
}
export default createWorker();
