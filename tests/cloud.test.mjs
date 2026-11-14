import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import {createECDH,randomBytes} from 'node:crypto';
execFileSync(process.execPath, ["tools/build-cloud.mjs"], {
  cwd: new URL("..", import.meta.url),
});
const bundle = readFileSync(
  new URL("../cloud-build/dist/server/index.js", import.meta.url),
  "utf8",
);
const { createWorker } = await import(
  "data:text/javascript;base64," + Buffer.from(bundle).toString("base64")
);
const SECRET = "a".repeat(64);
function setup(fetcher) {
  const sql = new DatabaseSync(":memory:");
  sql.exec(
    readFileSync(new URL("../cloud/schema.sql", import.meta.url), "utf8"),
  );
  const DB = {
    prepare(query) {
      return {
        bind(...args) {
          return {
            async all() {
              return { results: sql.prepare(query).all(...args) };
            },
            async first() {
              return sql.prepare(query).get(...args) || null;
            },
            async run() {
              return {
                meta: {
                  changes: Number(sql.prepare(query).run(...args).changes),
                },
              };
            },
          };
        },
      };
    },
    async batch(commands) {
      sql.exec("BEGIN");
      try {
        const out = [];
        for (const c of commands) out.push(await c.run());
        sql.exec("COMMIT");
        return out;
      } catch (e) {
        sql.exec("ROLLBACK");
        throw e;
      }
    },
  };
  const objects = new Map();
  const metadata = new Map();
  const BUCKET = {
    async put(key, bytes, options={}) {
      objects.set(key, new Uint8Array(bytes));
      metadata.set(key,options.customMetadata||{});
    },
    async delete(key) {
      objects.delete(key); metadata.delete(key);
    },
    async head(key) {return objects.has(key)?{size:objects.get(key).length,customMetadata:metadata.get(key)}:null;},
    async get(key, options) {
      const data = objects.get(key);
      if (!data) return null;
      const range = options?.range;
      return {
        customMetadata:metadata.get(key),
        body: range
          ? data.slice(range.offset, range.offset + range.length)
          : data,
      };
    },
  };
  const env = { DB, BUCKET, INGEST_TOKEN: SECRET };
  const worker = createWorker(
    fetcher || (async () => new Response("<title>Provider catalog</title>")),
  );
  const call = (path, options = {}, user = false) =>
    worker.fetch(
      new Request("https://roadwatch.test" + path, {
        ...options,
        headers: {
          ...(user
            ? { "oai-authenticated-user-id": "owner", "X-Roadwatch-Write": "1" }
            : { Authorization: "Bearer " + SECRET }),
          ...options.headers,
        },
      }),
      env,
    );
  const post = (path, body, user = false) =>
    call(
      path,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      user,
    );
  return { sql, env, worker, call, post, objects };
}
function obs(id, time, label = "fire") {
  return {
    camera_id: "demo-garden",
    frame_id: id,
    captured_at: new Date(time).toISOString(),
    demo: true,
    model: "synthetic-test-v1",
    detections: [{ label, score: 0.95, box: [0.1, 0.1, 0.2, 0.2] }],
  };
}

test("cloud auth rejects anonymous, cross-origin writes and browser ingestion", async () => {
  const s = setup();
  assert.equal(
    (
      await s.worker.fetch(
        new Request("https://roadwatch.test/api/events"),
        s.env,
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await s.call(
        "/api/ops/init",
        { method: "POST", headers: { Origin: "https://wrong.test" } },
        true,
      )
    ).status,
    403,
  );
  assert.equal((await s.post("/api/ops/init", {}, true)).status, 200);
  assert.equal(
    (await s.post("/api/observations", obs("a", Date.now()), true)).status,
    403,
  );
});
test("cloud two-frame events persist separately from real journal and are audited", async () => {
  const s = setup();
  await s.post("/api/ops/init", {});
  const t = Date.now() - 2000;
  assert.equal((await s.post("/api/observations", obs("a", t))).status, 201);
  const res = await s.post("/api/observations", obs("b", t + 1000));
  assert.equal(res.status, 201);
  const event = (await res.json()).events[0];
  assert.equal(event.type, "fire");
  assert.equal(event.recording_status, "unavailable");
  assert.equal((await (await s.call("/api/events")).json()).length, 0);
  assert.equal((await (await s.call("/api/events?demo=1")).json()).length, 1);
  assert.equal(
    (
      await s.post(
        "/api/events/" + event.id + "/review",
        { status: "confirmed" },
        true,
      )
    ).status,
    200,
  );
  assert.equal(
    s.sql.prepare("SELECT COUNT(*) AS n FROM rw_reviews").get().n,
    1,
  );
  assert.equal(
    (await (await s.post("/api/observations", obs("b", t + 1000))).json())
      .duplicate,
    true,
  );
  assert.equal(
    s.sql.prepare("SELECT COUNT(*) AS n FROM rw_observations").get().n,
    2,
  );
  assert.equal(
    (await s.post("/api/observations", { ...obs("c", t + 1200), demo: false }))
      .status,
    403,
  );
});
test("cloud rejects disabled cameras, stale input and exhausted quota", async () => {
  const s = setup();
  await s.post("/api/ops/init", {});
  const t = Date.now();
  assert.equal(
    (
      await s.post("/api/observations", {
        ...obs("a", t),
        camera_id: "iowa-wwdtv039",
        demo: false,
      })
    ).status,
    403,
  );
  assert.equal(
    (await s.post("/api/observations", obs("a", t - 120000))).status,
    400,
  );
  const day = new Date(t).toISOString().slice(0, 10),
    add = s.sql.prepare("INSERT INTO rw_observations VALUES(?,?,?,?,?)");
  for (let i = 0; i < 500; i++)
    add.run("quota-camera", String(i), new Date(t).toISOString(), day, "{}");
  assert.equal((await s.post("/api/observations", obs("a", t))).status, 429);
  assert.equal(s.sql.prepare("SELECT COUNT(*) AS n FROM rw_events").get().n, 0);
});
test("cloud JPEG/frame matching, private MP4 ranges and byte cap", async () => {
  const s = setup();
  await s.post("/api/ops/init", {});
  const t = Date.now() - 2000;
  await s.post("/api/observations", obs("a", t));
  const event = (
    await (await s.post("/api/observations", obs("b", t + 1000))).json()
  ).events[0];
  const jpg = new Uint8Array([255, 216, 255, 224, 1]);
  assert.equal(
    (
      await s.call("/api/cameras/demo-garden/frame", {
        method: "POST",
        headers: { "X-Frame-ID": "wrong" },
        body: jpg,
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await s.call("/api/cameras/demo-garden/frame", {
        method: "POST",
        headers: { "X-Frame-ID": "b" },
        body: jpg,
      })
    ).status,
    200,
  );
  const image = await s.call("/api/cameras/demo-garden/frame");
  assert.equal(image.headers.get("X-Frame-ID"), "b");
  const mp4 = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 1, 2, 3, 4]);
  const upload = await s.call("/api/events/" + event.id + "/evidence", {
    method: "POST",
    body: mp4,
  });
  assert.equal(upload.status, 201);
  const e = await upload.json(),
    range = await s.call("/api/evidence/" + e.id, {
      headers: { Range: "bytes=4-7" },
    });
  assert.equal(range.status, 206);
  assert.equal(await range.text(), "ftyp");
  assert.equal(range.headers.get("Content-Range"), "bytes 4-7/12");
  assert.equal(
    (
      await s.call("/api/evidence/" + e.id, {
        headers: { Range: "bytes=100-" },
      })
    ).status,
    416,
  );
  const duplicate=await s.call('/api/events/'+event.id+'/evidence',{method:'POST',body:mp4});
  assert.equal(duplicate.status,200);
  assert.equal((await duplicate.json()).id,e.id);
  await s.post('/api/observations',obs('c',t+2000,'smoke'));
  const second=(await (await s.post('/api/observations',obs('d',t+3000,'smoke'))).json()).events[0];
  s.sql.prepare("UPDATE rw_evidence SET bytes=?").run(100*1024*1024);
  assert.equal((await s.call('/api/events/'+second.id+'/evidence',{method:'POST',body:mp4})).status,507);
});
test("cloud probes persist reachability without asserting camera or CV access", async () => {
  const s = setup();
  await s.post("/api/ops/init", {});
  const p = await s.post("/api/ops/probe-sources", {});
  assert.equal(p.status, 200);
  const probes = await (await s.call("/api/sources")).json();
  assert.equal(probes.length, 3);
  assert.ok(
    probes.every(
      (x) =>
        x.reachable &&
        x.stream_verified === false &&
        x.analysis_enabled === false,
    ),
  );
});
test("cloud retention removes expired video while keeping its audit hash", async () => {
  const s = setup();
  await s.post("/api/ops/init", {});
  const t = Date.now() - 2000;
  await s.post("/api/observations", obs("a", t));
  const event = (
    await (await s.post("/api/observations", obs("b", t + 1000))).json()
  ).events[0];
  const upload = await s.call("/api/events/" + event.id + "/evidence", {
    method: "POST",
    body: new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 1, 2]),
  });
  const e = await upload.json();
  s.sql
    .prepare("UPDATE rw_evidence SET created_at=? WHERE id=?")
    .run(new Date(Date.now() - 8 * 86400000).toISOString(), e.id);
  const result = await (await s.post("/api/ops/retention", {})).json();
  assert.equal(result.expired_clips, 1);
  assert.equal(s.objects.size, 0);
  assert.equal((await s.call("/api/evidence/" + e.id)).status, 404);
  const meta = s.sql.prepare("SELECT * FROM rw_evidence WHERE id=?").get(e.id);
  assert.equal(meta.state, "expired");
  assert.equal(meta.sha256, e.sha256);
  assert.equal(
    (await (await s.call("/api/events?demo=1")).json())[0].recording_status,
    "unavailable",
  );
});

test("international registry excludes retired cameras and separates playback from CV", async () => {
  const s = setup();
  await s.post("/api/ops/init", {});
  const cs = await (await s.call("/api/cameras")).json();
  assert.equal(cs.length, 2);
  assert.ok(
    cs.every(
      (c) =>
        c.id.startsWith("iowa-") &&
        c.source_kind === "public_hls" &&
        c.latitude &&
        c.longitude,
    ),
  );
  assert.ok(
    cs.every((c) => !c.collector.online),
  );
  assert.equal((await (await s.call("/api/stats")).json()).monitoring, false);
  assert.equal(
    (await s.call("/api/cameras/khimki-mkad74/playback-diagnostics")).status,
    404,
  );
});

test('collector activity is independent of archived frame freshness and expires honestly',async()=>{
 const s=setup();await s.post('/api/ops/init',{});
 const data={state:'running',frames_analyzed:12,cpu_seconds:.8,uptime_seconds:60,fps:.2,last_frame_at:new Date().toISOString(),model:'fire-smoke-test',capabilities:['fire','smoke']};
 assert.equal((await s.post('/api/cameras/iowa-cbtv51/heartbeat',data,true)).status,403);
 assert.equal((await s.post('/api/cameras/iowa-cbtv51/heartbeat',data)).status,200);
 const stats=await (await s.call('/api/stats')).json();assert.equal(stats.monitoring,true);assert.equal(stats.receiving_real,0);assert.equal(stats.collectors_online,1);assert.equal(stats.daily_frames,0);
 s.sql.prepare("UPDATE rw_probes SET checked_at=? WHERE source_id='collector:iowa-cbtv51'").run(new Date(Date.now()-181000).toISOString());
 assert.equal((await (await s.call('/api/stats')).json()).monitoring,false);
 assert.equal((await s.post('/api/cameras/iowa-cbtv51/heartbeat',{...data,last_frame_at:'invalid'})).status,400);
});

test('preview lease expires, JPEG and boxes stay atomic, and writes have an independent quota',async()=>{
 const s=setup();await s.post('/api/ops/init',{});
 const path='/api/cameras/iowa-cbtv51',o={...obs('preview',Date.now()),camera_id:'iowa-cbtv51',demo:false};
 const jpeg=Buffer.from([255,216,255,0,...Array(70000).fill(1)]).toString('base64');
 assert.equal((await (await s.post(path+'/preview',{observation:o,jpeg})).json()).reason,'no_viewer');
 assert.equal((await s.post(path+'/view',{},true)).status,200);
 assert.equal((await (await s.call(path+'/demand')).json()).active,true);
 assert.equal((await s.post(path+'/preview',{observation:o,jpeg},true)).status,403);
 assert.equal((await s.post(path+'/preview',{observation:o,jpeg})).status,200);
 const preview=await (await s.call(path+'/preview')).json();assert.equal(preview.observation.frame_id,o.frame_id);assert.equal(preview.jpeg,jpeg);assert.equal(preview.stale,false);
 assert.equal((await (await s.call('/api/stats')).json()).daily_frames,0);
 assert.equal((await (await s.call('/api/events')).json()).length,0);
 s.sql.prepare("UPDATE rw_probes SET data=json_object('count',6000) WHERE source_id LIKE 'preview-quota:%'").run();
 assert.equal((await s.post(path+'/preview',{observation:o,jpeg})).status,429);
 await s.call(path+'/view',{method:'DELETE'},true);
 assert.equal((await (await s.call(path+'/demand')).json()).active,false);
});

test('interrupted upload recovers from durable reservation and cannot double-spend storage',async()=>{
 const s=setup();await s.post('/api/ops/init',{});const t=Date.now()-2000;
 await s.post('/api/observations',obs('r1',t));const event=(await (await s.post('/api/observations',obs('r2',t+1000))).json()).events[0];
 const mp4=Uint8Array.from([0,0,0,12,102,116,121,112,0,0,0,0]);
 const uploaded=await (await s.call('/api/events/'+event.id+'/evidence',{method:'POST',body:mp4})).json();
 s.sql.prepare("UPDATE rw_evidence SET state='uploading',created_at=? WHERE id=?").run(new Date(Date.now()-11*60000).toISOString(),uploaded.id);
 s.sql.prepare('UPDATE rw_events SET evidence_id=NULL WHERE id=?').run(event.id);
 const recovered=await (await s.post('/api/ops/retention',{})).json();assert.equal(recovered.recovered_uploads,1);
 assert.equal(s.sql.prepare('SELECT evidence_id FROM rw_events WHERE id=?').get(event.id).evidence_id,uploaded.id);
 assert.equal((await s.call('/api/events/'+event.id+'/evidence',{method:'POST',body:mp4})).status,200);
});

test('web push is viewer opt-in, queues only real events, and removes expired subscriptions',async()=>{
 let pushed=0;const s=setup(async(url,options)=>{assert.equal(new URL(url).hostname,'fcm.googleapis.com');assert.equal(options.redirect,'manual');pushed++;return new Response(null,{status:410});});
 await s.post('/api/ops/init',{});
 const client=createECDH('prime256v1');client.generateKeys();const sub={endpoint:'https://fcm.googleapis.com/fcm/send/fixture',keys:{p256dh:client.getPublicKey().toString('base64url'),auth:randomBytes(16).toString('base64url')}};
 assert.equal((await s.post('/api/push/subscription',sub)).status,403);
 assert.equal((await s.post('/api/push/subscription',sub,true)).status,200);
 assert.equal((await (await s.call('/api/push/settings')).json()).subscriptions,1);
 const t=Date.now()-2000;
 await s.post('/api/observations',obs('d1',t));await s.post('/api/observations',obs('d2',t+1000));
 assert.equal(s.sql.prepare("SELECT COUNT(*) n FROM rw_probes WHERE source_id LIKE 'pushq:%'").get().n,0);
 for(const [i,time] of [['real1',t],['real2',t+1000]])await s.post('/api/observations',{...obs(i,time),demo:false,camera_id:'iowa-cbtv51'});
 assert.equal(s.sql.prepare("SELECT COUNT(*) n FROM rw_probes WHERE source_id LIKE 'pushq:%'").get().n,1);
 s.sql.prepare("UPDATE rw_probes SET data=json_set(data,'$.next_attempt',?) WHERE source_id LIKE 'pushq:%'").run(new Date(0).toISOString());
 const result=await (await s.post('/api/ops/maintenance',{})).json();assert.equal(result.notifications.removed,1);assert.equal(pushed,1);
 assert.equal((await (await s.call('/api/push/settings')).json()).subscriptions,0);
});

test('tracking keeps real IDs and atomic JPEG, rejects mismatches, and never creates incidents',async()=>{
 const s=setup();await s.post('/api/ops/init',{});const path='/api/cameras/iowa-cbtv51';
 const bytes=Buffer.from([255,216,255,1,2,3]);
 const hash=await crypto.subtle.digest('SHA-256',bytes);const id=Buffer.from(hash).toString('hex');
 const o={...obs(id,Date.now(),'vehicle'),camera_id:'iowa-cbtv51',demo:false};o.detections[0]={...o.detections[0],track_id:'session-12',tracking_method:'optical_flow'};
 const payload={observation:o,jpeg:bytes.toString('base64')};
 assert.equal((await (await s.post(path+'/tracking',payload)).json()).reason,'no_viewer');
 await s.post(path+'/view',{kind:'tracking'},true);
 assert.equal((await s.post(path+'/tracking',payload,true)).status,403);
 assert.equal((await s.post(path+'/tracking',payload)).status,200);
 const out=await (await s.call(path+'/tracking')).json();assert.equal(out.observation.detections[0].track_id,'session-12');assert.equal(out.jpeg,payload.jpeg);assert.equal(out.stale,false);
 assert.equal((await s.post(path+'/tracking',{...payload,observation:{...o,frame_id:'wrong'}})).status,400);
 assert.equal((await (await s.call('/api/events')).json()).length,0);
 assert.equal((await (await s.call('/api/stats')).json()).daily_frames,0);
 s.sql.prepare("UPDATE rw_probes SET data=json_object('count',24000) WHERE source_id LIKE 'tracking-quota:%'").run();
 assert.equal((await s.post(path+'/tracking',payload)).status,429);
});
