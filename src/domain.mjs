import { createHash } from "node:crypto";

export * from "./core.mjs";

export function digest(data) {
  return createHash("sha256").update(data).digest("hex");
}
