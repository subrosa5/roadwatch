import http from "node:http";
import {
  readFile,
  mkdir,
  writeFile,
  rename,
  unlink,
  stat,
} from "node:fs/promises";
import { resolve, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, timingSafeEqual, createHash } from "node:crypto";
import { Store } from "./store.mjs";
import { InputError, digest, capacity } from "./domain.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".jpg": "image/jpeg",
};
const UUID = /^[a-f0-9-]{36}$/;
const same = (a, b) =>
  timingSafeEqual(
    createHash("sha256")
      .update(a || "")
      .digest(),
    createHash("sha256")
      .update(b || "")
      .digest(),
  );

async function bytes(req, max) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw new InputError("Body too large", 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function json(req) {
  try {
    return JSON.parse((await bytes(req, 1024 * 1024)).toString());
  } catch (e) {
    if (e instanceof InputError) throw e;
    throw new InputError("Invalid JSON");
  }
}
function send(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(data));
}

export async function createApp({
  dataDir = resolve(process.env.DATA_DIR || join(ROOT, "data")),
  demo = process.env.DEMO_MODE === "true",
  viewerToken = process.env.VIEWER_TOKEN,
  ingestToken = process.env.INGEST_TOKEN,
  dailyFrameLimit = Number(process.env.DAILY_FRAME_LIMIT || 500),
  allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .filter(Boolean),
} = {}) {
  if (
    !viewerToken ||
    viewerToken.length < 32 ||
    !ingestToken ||
    ingestToken.length < 32 ||
    viewerToken === ingestToken
  )
    throw new Error(
      "Set distinct VIEWER_TOKEN and INGEST_TOKEN (32+ characters); no default passwords",
    );
  if (
    !Number.isInteger(dailyFrameLimit) ||
    dailyFrameLimit < 1 ||
    dailyFrameLimit > 50000000
  )
    throw new Error("Invalid DAILY_FRAME_LIMIT");
  await mkdir(join(dataDir, "evidence"), { recursive: true });
  await mkdir(join(dataDir, "frames"), { recursive: true });
  const store = new Store(join(dataDir, "roadwatch.sqlite"), {
    demo,
    dailyFrameLimit,
  });
  const seed = JSON.parse(
    await readFile(join(ROOT, "config/cameras.json"), "utf8"),
  );
  store.seed(seed.filter((c) => demo || !c.demo));
  const limits = new Map();
  function rate(req, role = "unauthenticated") {
    const key = req.socket.remoteAddress + ":" + role;
    const maximum =
      role === "collector"
        ? Number(process.env.INGEST_RPM || 15000)
        : role === "viewer"
          ? 600
          : 60;
    const t = Date.now();
    let entry = limits.get(key);
    if (!entry || entry.until < t) {
      entry = { count: 0, until: t + 60000 };
      limits.set(key, entry);
    }
    if (++entry.count > maximum) throw new InputError("Rate limit", 429);
    if (limits.size > 10000)
      for (const [k, v] of limits) if (v.until < t) limits.delete(k);
  }
  async function handler(req, res) {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob: https://video2.iowadot.gov:8888 https://video4.iowadot.gov:8888; connect-src 'self' https: http://127.0.0.1:* http://localhost:*; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
    const origin = req.headers.origin;
    if (origin && allowedOrigins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Authorization,Content-Type,X-Frame-ID",
      );
      res.setHeader("Access-Control-Expose-Headers", "X-Frame-ID");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    }
    try {
      const url = new URL(req.url, "http://localhost");
      const p = url.pathname;
      if (req.method === "OPTIONS") {
        if (!origin || !allowedOrigins.includes(origin))
          throw new InputError("Origin denied", 403);
        res.writeHead(204);
        res.end();
        return;
      }
      if (p === "/api/health") {
        send(res, 200, {
          service: "roadwatch",
          version: "0.1.0",
          mode: demo ? "demo" : "real",
        });
        return;
      }
      if (p.startsWith("/api/")) {
        const bearer =
          /^Bearer (.+)$/.exec(req.headers.authorization || "")?.[1] || "";
        const viewer = same(bearer, viewerToken),
          ingest = same(bearer, ingestToken);
        rate(req, ingest ? "collector" : viewer ? "viewer" : "unauthenticated");
        if (!viewer && !ingest)
          throw new InputError("Authentication required", 401);
        if (
          origin &&
          !allowedOrigins.includes(origin) &&
          origin !== `http://${req.headers.host}` &&
          origin !== `https://${req.headers.host}`
        )
          throw new InputError("Origin denied", 403);
        const id = p.split("/")[3];
        if (req.method === "POST" && p === "/api/observations") {
          if (!ingest) throw new InputError("Collector role required", 403);
          send(res, 201, store.ingest(await json(req)));
          return;
        }
        if (
          req.method === "POST" &&
          /^\/api\/events\/[^/]+\/evidence$/.test(p)
        ) {
          if (!ingest) throw new InputError("Collector role required", 403);
          if (!UUID.test(id) || !store.event(id))
            throw new InputError("Event not found", 404);
          if (req.headers["content-type"] !== "video/mp4")
            throw new InputError("Expected video/mp4");
          if (store.event(id).evidence_id)
            throw new InputError("Evidence already attached", 409);
          const buffer = await bytes(req, 25 * 1024 * 1024);
          if (buffer.length < 12 || buffer.toString("ascii", 4, 8) !== "ftyp")
            throw new InputError("Invalid MP4 container");
          const all = store.db
            .prepare("SELECT coalesce(sum(bytes),0) AS n FROM evidence")
            .get().n;
          if (
            all + buffer.length >
            Number(process.env.MAX_EVIDENCE_BYTES || 500000000)
          )
            throw new InputError("Evidence storage budget exhausted", 507);
          const evidenceId = randomUUID(),
            path = join(dataDir, "evidence", evidenceId + ".mp4");
          await writeFile(path + ".tmp", buffer, { flag: "wx", mode: 0o600 });
          await rename(path + ".tmp", path);
          try {
            store.attachEvidence(id, {
              id: evidenceId,
              sha256: digest(buffer),
              bytes: buffer.length,
              mime: "video/mp4",
            });
          } catch (e) {
            await unlink(path);
            throw e;
          }
          send(res, 201, store.event(id));
          return;
        }
        if (
          req.method === "POST" &&
          /^\/api\/cameras\/[a-z0-9-]+\/frame$/.test(p)
        ) {
          if (!ingest) throw new InputError("Collector role required", 403);
          const c = store.camera(id);
          if (!c?.enabled || !c.approved)
            throw new InputError("Camera disabled", 403);
          const b = await bytes(req, 2 * 1024 * 1024);
          if (b[0] !== 255 || b[1] !== 216)
            throw new InputError("Expected JPEG");
          const frameId = req.headers["x-frame-id"];
          if (!frameId || store.latest(id)?.frame_id !== frameId)
            throw new InputError(
              "Frame ID must match current observation",
              409,
            );
          store.db
            .prepare(
              "INSERT INTO frames VALUES(?,?,?) ON CONFLICT(camera_id) DO UPDATE SET frame_id=excluded.frame_id,jpeg=excluded.jpeg",
            )
            .run(id, frameId, b);
          send(res, 200, { ok: true });
          return;
        }
        if (!viewer) throw new InputError("Viewer role required", 403);
        if (req.method === "GET" && p === "/api/cameras") {
          send(res, 200, store.cameras());
          return;
        }
        if (req.method === "GET" && p === "/api/stats") {
          send(res, 200, store.stats());
          return;
        }
        if (req.method === "GET" && p === "/api/events") {
          send(res, 200, store.events(Object.fromEntries(url.searchParams)));
          return;
        }
        if (req.method === "GET" && p === "/api/capacity") {
          send(
            res,
            200,
            capacity(
              Object.fromEntries(
                [...url.searchParams].map(([k, v]) => [k, Number(v)]),
              ),
            ),
          );
          return;
        }
        if (req.method === "POST" && /^\/api\/events\/[^/]+\/review$/.test(p)) {
          send(res, 200, store.review(id, (await json(req)).status));
          return;
        }
        if (
          req.method === "GET" &&
          /^\/api\/cameras\/[a-z0-9-]+\/frame$/.test(p)
        ) {
          if (!store.camera(id)) throw new InputError("Camera not found", 404);
          const frame = store.db
            .prepare("SELECT frame_id,jpeg FROM frames WHERE camera_id=?")
            .get(id);
          if (!frame) throw new InputError("No frame received", 404);
          res.writeHead(200, {
            "Content-Type": "image/jpeg",
            "Cache-Control": "no-store",
            "X-Frame-ID": frame.frame_id,
          });
          res.end(frame.jpeg);
          return;
        }
        if (req.method === "GET" && /^\/api\/evidence\/[a-f0-9-]+$/.test(p)) {
          if (!UUID.test(id)) throw new InputError("Evidence not found", 404);
          const e = store.evidence(id);
          if (!e) throw new InputError("Evidence not found", 404);
          let buffer;
          try {
            buffer = await readFile(join(dataDir, "evidence", id + ".mp4"));
          } catch {
            throw new InputError("Evidence file missing", 410);
          }
          res.setHeader("ETag", '"' + e.sha256 + '"');
          res.setHeader("Cache-Control", "private, no-store");
          res.setHeader("Content-Type", "video/mp4");
          res.setHeader("Accept-Ranges", "bytes");
          const range = req.headers.range;
          if (range) {
            const m = /^bytes=(\d+)-(\d*)$/.exec(range);
            if (!m) throw new InputError("Unsupported range", 416);
            const start = Number(m[1]),
              end = m[2]
                ? Math.min(Number(m[2]), buffer.length - 1)
                : buffer.length - 1;
            if (start > end || start >= buffer.length)
              throw new InputError("Invalid range", 416);
            res.writeHead(206, {
              "Content-Range": `bytes ${start}-${end}/${buffer.length}`,
              "Content-Length": end - start + 1,
            });
            res.end(buffer.subarray(start, end + 1));
          } else {
            res.writeHead(200, { "Content-Length": buffer.length });
            res.end(buffer);
          }
          return;
        }
        throw new InputError("API endpoint not found", 404);
      }
      if (!["GET", "HEAD"].includes(req.method))
        throw new InputError("Method not allowed", 405);
      const relative =
        p === "/" ? "index.html" : decodeURIComponent(p).slice(1);
      const webRoot = resolve(ROOT, "web"),
        path = resolve(webRoot, relative);
      if (!path.startsWith(webRoot + "/"))
        throw new InputError("Not found", 404);
      try {
        const data = await readFile(path);
        res.writeHead(200, {
          "Content-Type": MIME[extname(path)] || "application/octet-stream",
          "Cache-Control": "no-cache",
        });
        res.end(req.method === "HEAD" ? undefined : data);
      } catch {
        throw new InputError("Not found", 404);
      }
    } catch (e) {
      if (!res.headersSent)
        send(res, e instanceof InputError ? e.status : 500, {
          error: e instanceof InputError ? e.message : "Internal error",
        });
      else res.end();
    }
  }
  const server = http.createServer(handler);
  return {
    server,
    store,
    close: () =>
      new Promise((resolve) => {
        server.close(() => {
          store.close();
          resolve();
        });
        server.closeIdleConnections();
      }),
  };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const app = await createApp();
  app.server.listen(
    Number(process.env.PORT || 8787),
    process.env.HOST || "127.0.0.1",
    () =>
      console.log(
        `Roadwatch listening on port ${process.env.PORT || 8787}; mode=${process.env.DEMO_MODE === "true" ? "demo" : "real"}`,
      ),
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, async () => {
      await app.close();
      process.exit(0);
    });
}
