import { readdir, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (/\.(mjs|js)$/.test(path)) {
      const r = spawnSync(process.execPath, ["--check", path], {
        stdio: "inherit",
      });
      if (r.status) process.exit(r.status);
    }
  }
}
for (const dir of ["src", "cloud", "web", "tools", "tests"]) await walk(dir);
for (const path of ["config/cameras.json", "config/collector.example.json"])
  JSON.parse(await readFile(path, "utf8"));
console.log("JavaScript syntax and JSON configuration valid");
