import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
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
function setup() {
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
  const BUCKET = {
    async put(key, bytes) {
      objects.set(key, new Uint8Array(bytes));
    },
    async delete(key) {
      objects.delete(key);
    },
    async get(key, options) {
      const data = objects.get(key);
      if (!data) return null;
      const range = options?.range;
      return {
        body: range
          ? data.slice(range.offset, range.offset + range.length)
          : data,
      };
    },
  };
  const env = { DB, BUCKET, INGEST_TOKEN: SECRET };
  const worker = createWorker(
    async () => new Response("<title>Provider catalog</title>"),
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
        camera_id: "moscow-entuziastov",
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
  s.sql.prepare("UPDATE rw_evidence SET bytes=?").run(100 * 1024 * 1024);
  assert.equal(
    (
      await s.call("/api/events/" + event.id + "/evidence", {
        method: "POST",
        body: mp4,
      })
    ).status,
    507,
  );
});
test("cloud probes persist reachability without asserting camera or CV access", async () => {
  const s = setup();
  await s.post("/api/ops/init", {});
  const p = await s.post("/api/ops/probe-sources", {});
  assert.equal(p.status, 200);
  const probes = await (await s.call("/api/sources")).json();
  assert.equal(probes.length, 5);
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
