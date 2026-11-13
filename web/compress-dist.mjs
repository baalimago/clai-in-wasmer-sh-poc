// Gzips the large files of a built site, in place: `node compress-dist.mjs <public dir>`.
// Each .wasm and .webc becomes <file>.gz, the original goes, and precompressed.json lists the
// originals' paths. The page's worker (www/worker.js) fetches the .gz of a listed file and
// unpacks it, so the site is a quarter of its size on the wire whatever the server does: Edge's
// static server sends these files as they are, uncompressed (measured 2026-11-11).
import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";

const root = process.argv[2];
if (!root) {
  console.error("usage: node compress-dist.mjs <public dir>");
  process.exit(2);
}

// Smaller files are not worth a second request path.
const MIN_BYTES = 256 * 1024;
const WANTED = new Set([".wasm", ".webc"]);

async function* files(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") yield* files(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

const listed = [];
let before = 0;
let after = 0;
for await (const file of files(root)) {
  if (!WANTED.has(path.extname(file)) || (await stat(file)).size < MIN_BYTES) continue;
  const raw = await readFile(file);
  const packed = gzipSync(raw, { level: 9 });
  await writeFile(`${file}.gz`, packed);
  await rm(file);
  before += raw.length;
  after += packed.length;
  listed.push(path.relative(root, file).split(path.sep).join("/"));
}
listed.sort();
await writeFile(path.join(root, "precompressed.json"), `${JSON.stringify(listed, null, 2)}\n`);
const mb = (n) => (n / 1e6).toFixed(1);
console.log(`compressed ${listed.length} files: ${mb(before)} MB -> ${mb(after)} MB`);
