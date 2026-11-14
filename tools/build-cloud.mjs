import { readFile, writeFile, mkdir, readdir, rm } from "node:fs/promises";
import { resolve, dirname, extname } from "node:path";
import {build} from "esbuild";
const root = resolve(import.meta.dirname, "..");
const destination = resolve(process.argv[2] || resolve(root, "cloud-build"));
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".jpg": "image/jpeg",
  ".mp4": "video/mp4",
  ".json":"application/json; charset=utf-8",
  ".zip": "application/zip",
  ".svg":"image/svg+xml",
  ".webmanifest":"application/manifest+json",
};
const assets = {};
async function visit(directory, prefix = "") {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = prefix + "/" + entry.name,
      path = resolve(directory, entry.name);
    if (entry.isDirectory()) await visit(path, name);
    else {
      let bytes = await readFile(path);
      if (name === "/index.html")
        bytes = Buffer.from(
          bytes
            .toString()
            .replace(
              '<script type="module" src="./app.js"></script>',
              '<script>globalThis.ROADWATCH_CLOUD_HOSTED=true;</script><script type="module" src="./app.js"></script>',
            ),
        );
      assets[name] = {
        type: types[extname(name)] || "application/octet-stream",
        base64: bytes.toString("base64"),
      };
    }
  }
}
await visit(resolve(root, "web"));
const core = await readFile(resolve(root, "src/core.mjs"), "utf8");
const worker = (
  await readFile(resolve(root, "cloud/worker.mjs"), "utf8")
).replace(/^import\s+\{[\s\S]*?\}\s+from\s+['"]\.\.\/src\/core\.mjs['"];\s*/, "");
if (/from\s+['"]\.\.\/src\/core\.mjs/.test(worker)) throw Error('Could not inline shared core import');
const cameras = JSON.parse(
  await readFile(resolve(root, "config/cameras.json"), "utf8"),
);
const staticHandler = `function serveAsset(path,request){const asset=STATIC_ASSETS[path==='/'?'/index.html':path];if(!asset)return new Response('Not found',{status:404});if(!['GET','HEAD'].includes(request.method))return new Response('Method not allowed',{status:405});const bytes=Uint8Array.from(atob(asset.base64),c=>c.charCodeAt(0));return new Response(request.method==='HEAD'?null:bytes,{headers:{'Content-Type':asset.type,'Cache-Control':'private, max-age=60','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'}});}`;
await rm(resolve(destination, "dist"), { recursive: true, force: true });
await mkdir(resolve(destination, "dist/server"), { recursive: true });
await mkdir(resolve(destination, "dist/.openai"), { recursive: true });
await mkdir(resolve(destination, "drizzle/meta"), { recursive: true });
const manifest = {
  project_id: "appgprj_6af5b45611ac8191a889d862ff5a8e6f",
  d1: "DB",
  r2: "BUCKET",
};
await mkdir(resolve(destination, ".openai"), { recursive: true });
await writeFile(
  resolve(destination, ".openai/hosting.json"),
  JSON.stringify(manifest, null, 2) + "\n",
);
await writeFile(
  resolve(destination, "dist/.openai/hosting.json"),
  JSON.stringify(manifest, null, 2) + "\n",
);
const entry =
  "const STATIC_ASSETS=" +
  JSON.stringify(assets) +
  ";\nconst CAMERA_CONFIG=" +
  JSON.stringify(cameras) +
  ";\n" +
  core +
  "\n" +
  staticHandler +
  "\n" +
  worker;
const built=await build({stdin:{contents:entry,sourcefile:'worker.mjs',resolveDir:resolve(root,'cloud')},bundle:true,platform:'browser',format:'esm',target:'es2022',write:false});
const bundle=built.outputFiles[0].text;
await writeFile(resolve(destination, "dist/server/index.js"), bundle);
await writeFile(
  resolve(destination, "drizzle/0000_roadwatch.sql"),
  (await readFile(resolve(root, "cloud/schema.sql"), "utf8"))
    .trim()
    .split(";")
    .filter((s) => s.trim())
    .map((s) => s.trim() + ";")
    .join("\n--> statement-breakpoint\n") + "\n",
);
await writeFile(
  resolve(destination, "drizzle/meta/_journal.json"),
  JSON.stringify(
    {
      version: "7",
      dialect: "sqlite",
      entries: [
        {
          idx: 0,
          version: "6",
          when: 1794560000000,
          tag: "0000_roadwatch",
          breakpoints: true,
        },
      ],
    },
    null,
    2,
  ) + "\n",
);
let module;
try {module=await import("data:text/javascript;base64,"+Buffer.from(bundle).toString("base64"));}
catch(error){throw Error('Generated Worker failed validation: '+error.message);}
if (typeof module.default.fetch !== "function")
  throw Error("Worker fetch missing");
console.log(
  JSON.stringify({
    destination,
    worker_bytes: Buffer.byteLength(bundle),
    assets: Object.keys(assets).length,
    bindings: ["DB", "BUCKET"],
  }),
);
