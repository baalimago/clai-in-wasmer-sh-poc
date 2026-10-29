// Downloads the Wasmer registry packages that packages.txt lists into www/packages, as webc v3
// files, with an index.json the page's worker loads them from. A package marked optional that
// the registry does not have is left out.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WEB = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(WEB, "www", "packages");
const REGISTRY = process.env.WASMER_REGISTRY ?? "https://registry.wasmer.io/graphql";

const QUERY = `query ($name: String!, $version: String!) {
  getPackageVersion(name: $name, version: $version) {
    version
    distribution(version: V3) { webcDownloadUrl webcSha256Hash }
  }
}`;

async function resolve(name, version) {
  const response = await fetch(REGISTRY, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: QUERY, variables: { name, version } }),
  });
  if (!response.ok) throw new Error(`${REGISTRY}: ${response.status} ${response.statusText}`);
  const { data, errors } = await response.json();
  if (errors?.length) throw new Error(`${name}@${version}: ${errors.map((e) => e.message).join("; ")}`);
  const found = data?.getPackageVersion;
  const url = found?.distribution?.webcDownloadUrl;
  if (!url) return null;
  return { version: found.version, url, sha256: found.distribution.webcSha256Hash };
}

async function sha256(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Buffer.from(digest).toString("hex");
}

// `name[@version] [optional]` per line; `#` starts a comment.
function parse(text) {
  return text
    .split("\n")
    .map((line) => line.replace(/#.*/, "").trim())
    .filter(Boolean)
    .map((line) => {
      const [spec, flag] = line.split(/\s+/);
      const at = spec.lastIndexOf("@");
      const [name, version] = at > 0 ? [spec.slice(0, at), spec.slice(at + 1)] : [spec, "latest"];
      return { name, version, optional: flag === "optional" };
    });
}

const wanted = parse(await readFile(path.join(WEB, "packages.txt"), "utf8"));
await mkdir(OUT, { recursive: true });
const index = [];
for (const { name, version, optional } of wanted) {
  const found = await resolve(name, version);
  if (!found) {
    if (optional) {
      console.log(`skipping ${name}@${version}: not in the registry`);
      continue;
    }
    throw new Error(`${name}@${version} has no webc v3 in the registry`);
  }
  const file = `${name.replace("/", "-")}-${found.version}.webc`;
  const response = await fetch(found.url);
  if (!response.ok) throw new Error(`${found.url}: ${response.status} ${response.statusText}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (found.sha256 && (await sha256(bytes)) !== found.sha256) {
    throw new Error(`${name}@${found.version}: checksum mismatch`);
  }
  await writeFile(path.join(OUT, file), bytes);
  index.push({ name, version: found.version, file });
  console.log(`${name}@${found.version} (${(bytes.length / 1e6).toFixed(1)} MB)`);
}
await writeFile(path.join(OUT, "index.json"), JSON.stringify(index, null, 2) + "\n");
