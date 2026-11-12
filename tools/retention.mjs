import { Store } from "../src/store.mjs";
import { resolve, join } from "node:path";
import { unlink } from "node:fs/promises";
const days = Number(process.env.EVIDENCE_RETENTION_DAYS || 7);
if (!Number.isFinite(days) || days < 1)
  throw new Error("EVIDENCE_RETENTION_DAYS must be at least 1");
const dir = resolve(process.env.DATA_DIR || "./data");
const store = new Store(join(dir, "roadwatch.sqlite"), {
  demo: process.env.DEMO_MODE === "true",
});
const cutoff = new Date(Date.now() - days * 86400000).toISOString();
const expired = store.db
  .prepare("SELECT * FROM evidence WHERE created_at<?")
  .all(cutoff);
let deleted = 0;
for (const e of expired) {
  // Mark unavailable before deleting bytes. An interruption leaves an honest status.
  store.db.exec("BEGIN IMMEDIATE");
  try {
    store.db
      .prepare(
        "UPDATE events SET evidence_id=NULL,recording_status='expired',body=json_set(body,'$.expired_evidence_sha256',?) WHERE evidence_id=?",
      )
      .run(e.sha256, e.id);
    store.db.prepare("DELETE FROM evidence WHERE id=?").run(e.id);
    store.db.exec("COMMIT");
  } catch (error) {
    store.db.exec("ROLLBACK");
    throw error;
  }
  try {
    await unlink(join(dir, "evidence", e.id + ".mp4"));
    deleted++;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
store.prune();
store.close();
console.log(
  JSON.stringify({ expired: expired.length, deleted, retention_days: days }),
);
