import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
const content = `VIEWER_TOKEN=${randomBytes(32).toString("hex")}\nINGEST_TOKEN=${randomBytes(32).toString("hex")}\nDEMO_MODE=false\nHOST=127.0.0.1\nPORT=8787\nDATA_DIR=./data\nDAILY_FRAME_LIMIT=500\nMAX_EVIDENCE_BYTES=500000000\nALLOWED_ORIGINS=\n`;
await writeFile(".env", content, { flag: "wx", mode: 0o600 });
console.log(
  "Created private .env with distinct random tokens. Existing files are never overwritten.",
);
