import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import {
  candidates,
  observation,
  InputError,
  cameraHealth,
  TYPES,
} from "./domain.mjs";

export class Store {
  constructor(
    path = ":memory:",
    { demo = false, dailyFrameLimit = 500, now = () => Date.now() } = {},
  ) {
    this.db = new DatabaseSync(path);
    this.demo = demo;
    this.dailyFrameLimit = dailyFrameLimit;
    this.now = now;
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS cameras(id TEXT PRIMARY KEY,name TEXT NOT NULL,zone TEXT NOT NULL,enabled INTEGER NOT NULL,approved INTEGER NOT NULL,demo INTEGER NOT NULL,latitude REAL,longitude REAL,source_page TEXT,location_note TEXT);
      CREATE TABLE IF NOT EXISTS observations(camera_id TEXT NOT NULL REFERENCES cameras(id),frame_id TEXT NOT NULL,captured_at TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(camera_id,frame_id));
      CREATE INDEX IF NOT EXISTS obs_time ON observations(camera_id,captured_at DESC);
      CREATE TABLE IF NOT EXISTS frames(camera_id TEXT PRIMARY KEY REFERENCES cameras(id),frame_id TEXT NOT NULL,jpeg BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,camera_id TEXT NOT NULL REFERENCES cameras(id),type TEXT NOT NULL,captured_at TEXT NOT NULL,created_at TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'unreviewed',demo INTEGER NOT NULL,body TEXT NOT NULL,evidence_id TEXT,recording_status TEXT NOT NULL DEFAULT 'unavailable');
      CREATE INDEX IF NOT EXISTS event_camera_type ON events(camera_id,type,captured_at DESC);
      CREATE TABLE IF NOT EXISTS evidence(id TEXT PRIMARY KEY,event_id TEXT NOT NULL REFERENCES events(id),sha256 TEXT NOT NULL,bytes INTEGER NOT NULL,created_at TEXT NOT NULL,mime TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS quota(day TEXT PRIMARY KEY,frames INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS reviews(id TEXT PRIMARY KEY,event_id TEXT NOT NULL REFERENCES events(id),status TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    `);
    const storedMode = this.db
      .prepare("SELECT value FROM metadata WHERE key='mode'")
      .get()?.value;
    const requestedMode = demo ? "demo" : "real";
    if (storedMode && storedMode !== requestedMode) {
      this.db.close();
      throw new Error(
        "Database mode mismatch: use separate demo and real DATA_DIR",
      );
    }
    this.db
      .prepare("INSERT OR IGNORE INTO metadata VALUES('mode',?)")
      .run(requestedMode);
  }
  seed(cameras) {
    const put = this.db.prepare(
      "INSERT INTO cameras(id,name,zone,enabled,approved,demo,latitude,longitude,source_page,location_note) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,zone=excluded.zone,enabled=excluded.enabled,approved=excluded.approved,latitude=excluded.latitude,longitude=excluded.longitude,source_page=excluded.source_page,location_note=excluded.location_note",
    );
    for (const c of cameras)
      put.run(
        c.id,
        c.name,
        c.zone,
        Number(!!c.enabled),
        Number(!!c.approved),
        Number(!!c.demo),
        c.latitude ?? null,
        c.longitude ?? null,
        c.source_page ?? null,
        c.location_note ?? null,
      );
  }
  camera(id) {
    return this.db.prepare("SELECT * FROM cameras WHERE id=?").get(id);
  }
  latest(id) {
    const row = this.db
      .prepare(
        "SELECT body FROM observations WHERE camera_id=? ORDER BY captured_at DESC LIMIT 1",
      )
      .get(id);
    return row ? JSON.parse(row.body) : null;
  }
  cameras() {
    return this.db
      .prepare("SELECT * FROM cameras ORDER BY demo DESC,name")
      .all()
      .map((c) => ({
        ...c,
        enabled: !!c.enabled,
        approved: !!c.approved,
        demo: !!c.demo,
        health: cameraHealth(c, this.latest(c.id), this.now()),
        latest: this.latest(c.id),
      }));
  }
  ingest(raw) {
    const o = observation(raw, this.now());
    const camera = this.camera(o.camera_id);
    if (!camera || !camera.enabled || !camera.approved)
      throw new InputError("Camera disabled or source not approved", 403);
    if (!!camera.demo !== this.demo)
      throw new InputError("Demo and real observations cannot be mixed", 403);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (
        this.db
          .prepare(
            "SELECT 1 FROM observations WHERE camera_id=? AND frame_id=?",
          )
          .get(o.camera_id, o.frame_id)
      ) {
        this.db.exec("COMMIT");
        return { duplicate: true, events: [] };
      }
      const previous = this.latest(o.camera_id);
      if (
        previous &&
        Date.parse(o.captured_at) <= Date.parse(previous.captured_at)
      )
        throw new InputError("Out of order frame", 409);
      const day = new Date(this.now()).toISOString().slice(0, 10);
      this.db
        .prepare("INSERT OR IGNORE INTO quota(day,frames) VALUES(?,0)")
        .run(day);
      if (
        this.db.prepare("SELECT frames FROM quota WHERE day=?").get(day)
          .frames >= this.dailyFrameLimit
      )
        throw new InputError(
          "Daily frame budget exhausted; monitoring paused",
          429,
        );
      this.db.prepare("UPDATE quota SET frames=frames+1 WHERE day=?").run(day);
      this.db
        .prepare("INSERT INTO observations VALUES(?,?,?,?)")
        .run(o.camera_id, o.frame_id, o.captured_at, JSON.stringify(o));
      const events = [];
      for (const type of candidates(o, previous, this.now())) {
        const last = this.db
          .prepare(
            "SELECT captured_at FROM events WHERE camera_id=? AND type=? ORDER BY captured_at DESC LIMIT 1",
          )
          .get(o.camera_id, type);
        if (
          last &&
          Date.parse(o.captured_at) - Date.parse(last.captured_at) < 120000
        )
          continue;
        const id = randomUUID(),
          created_at = new Date(this.now()).toISOString();
        const boxes = o.detections.filter((d) => d.label === type);
        this.db
          .prepare(
            "INSERT INTO events(id,camera_id,type,captured_at,created_at,demo,body) VALUES(?,?,?,?,?,?,?)",
          )
          .run(
            id,
            o.camera_id,
            type,
            o.captured_at,
            created_at,
            Number(this.demo),
            JSON.stringify({
              boxes,
              model: o.model,
              clock: o.clock,
              confirmation_frames: 2,
            }),
          );
        events.push(this.event(id));
      }
      this.db.exec("COMMIT");
      return { duplicate: false, events };
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  event(id) {
    const e = this.db.prepare("SELECT * FROM events WHERE id=?").get(id);
    return e
      ? { ...e, demo: !!e.demo, ...JSON.parse(e.body), body: undefined }
      : null;
  }
  events({ after = "", type = "", status = "", limit = 200 } = {}) {
    if (type && !TYPES.includes(type))
      throw new InputError("Invalid event type");
    if (status && !["unreviewed", "confirmed", "dismissed"].includes(status))
      throw new InputError("Invalid review status");
    return this.db
      .prepare(
        `SELECT id FROM events WHERE created_at>? AND (?='' OR type=?) AND (?='' OR status=?) ORDER BY created_at DESC LIMIT ?`,
      )
      .all(
        after,
        type,
        type,
        status,
        status,
        Math.min(200, Math.max(1, Number(limit) || 200)),
      )
      .map((e) => this.event(e.id));
  }
  review(id, status) {
    if (!["confirmed", "dismissed", "unreviewed"].includes(status))
      throw new InputError("Invalid review status");
    if (!this.event(id)) throw new InputError("Event not found", 404);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE events SET status=? WHERE id=?").run(status, id);
      this.db
        .prepare("INSERT INTO reviews VALUES(?,?,?,?)")
        .run(randomUUID(), id, status, new Date(this.now()).toISOString());
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return this.event(id);
  }
  attachEvidence(eventId, { id, sha256, bytes, mime }) {
    if (!this.event(eventId)) throw new InputError("Event not found", 404);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("INSERT INTO evidence VALUES(?,?,?,?,?,?)")
        .run(
          id,
          eventId,
          sha256,
          bytes,
          new Date(this.now()).toISOString(),
          mime,
        );
      this.db
        .prepare(
          "UPDATE events SET evidence_id=?,recording_status=? WHERE id=?",
        )
        .run(id, "ready", eventId);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  evidence(id) {
    return this.db.prepare("SELECT * FROM evidence WHERE id=?").get(id);
  }
  stats() {
    const cameras = this.cameras();
    const day = new Date(this.now()).toISOString().slice(0, 10);
    return {
      mode: this.demo ? "demo" : "real",
      target_cameras: 100,
      registered_real: cameras.filter((c) => !c.demo).length,
      receiving_real: cameras.filter((c) => !c.demo && c.health === "receiving")
        .length,
      daily_frames:
        this.db.prepare("SELECT frames FROM quota WHERE day=?").get(day)
          ?.frames ?? 0,
      daily_frame_limit: this.dailyFrameLimit,
      event_count: this.db.prepare("SELECT count(*) AS n FROM events").get().n,
      unreviewed: this.db
        .prepare("SELECT count(*) AS n FROM events WHERE status='unreviewed'")
        .get().n,
      server_time: new Date(this.now()).toISOString(),
    };
  }
  prune(retentionMs = 86400000) {
    this.db
      .prepare("DELETE FROM observations WHERE captured_at<?")
      .run(new Date(this.now() - retentionMs).toISOString());
  }
  close() {
    this.db.close();
  }
}
