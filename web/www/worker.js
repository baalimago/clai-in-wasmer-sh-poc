// Runs the WASIX v2 machine off the page's thread: browsers instantiate modules over 8 MB
// synchronously only in workers, and the terminal stays responsive while clai runs. The page's
// first message is the terminal's size; then come commands, keystrokes and new sizes.
import init, { boot } from "./pkg/clai_web.js";

const post = (message) => postMessage(message);

// What the boot has fetched so far, for its summary and for a failure's report.
const loaded = { files: 0, bytes: 0 };

// The files the site holds gzipped, as <file>.gz (compress-dist.mjs writes the list for a
// deployed site; the one in the tree is empty). Set before the first fetchBytes.
let precompressed = new Set();

// `bytes` unpacked. A server that sent the .gz with Content-Encoding: gzip had the browser
// unpack it already, so bytes without gzip's magic number are returned as they are.
const gunzip = async (bytes) => {
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
};

// A file of the site, whole. A request that the network drops, or that the server answers
// with a 5xx, is tried again: a host under load resets some of twenty large downloads, and one
// lost file would otherwise stop the boot. What fails for good says which file it was.
const fetchBytes = async (url, tries = 4) => {
  const packed = precompressed.has(url.replace(/^\.\//, ""));
  let last;
  for (let attempt = 1; attempt <= tries; attempt++) {
    const started = performance.now();
    // Where the request stopped: before any answer, or while its body came in.
    let stage = "no answer";
    try {
      const response = await fetch(packed ? `${url}.gz` : url);
      stage = `status ${response.status}, body of ${response.headers.get("content-length") ?? "unknown"} bytes cut short`;
      if (response.ok) {
        const bytes = new Uint8Array(await response.arrayBuffer());
        loaded.files++;
        loaded.bytes += bytes.length;
        stage = "unpacking";
        const whole = packed ? await gunzip(bytes) : bytes;
        // The pad writes what arrived (arrival.js), so a long first load shows its progress.
        post({ fetched: { url, bytes: bytes.length } });
        return whole;
      }
      last = new Error(`status ${response.status}`);
      if (response.status < 500) break;
    } catch (error) {
      last = new Error(`${error.message} (${stage}, after ${Math.round(performance.now() - started)} ms${navigator.onLine ? "" : ", the browser is offline"})`);
    }
    if (attempt < tries) {
      post({ log: `\x1b[33m${url}: ${last.message}, trying again (${attempt}/${tries - 1})\x1b[0m` });
      await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)));
    }
  }
  // This error ends the boot, and the page shows its message as it is.
  throw new Error(`cannot fetch ${url} in ${tries} tries: ${last.message}. ` +
    `The boot had ${loaded.files} files (${(loaded.bytes / 1e6).toFixed(1)} MB). Reload to try again`);
};

// The files for `urls`, at most `width` requests at a time, in the order asked for.
const fetchAll = async (urls, width = 4) => {
  const out = new Array(urls.length);
  let next = 0;
  const worker = async () => {
    while (next < urls.length) {
      const i = next++;
      out[i] = await fetchBytes(urls[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, urls.length) }, worker));
  return out;
};

const { size: { rows, cols } } = await new Promise((resolve) => (onmessage = ({ data }) => resolve(data)));
// The registry packages `make` downloaded (fetch-packages.mjs), if it did.
const packageList = async () => {
  const response = await fetch("./packages/index.json");
  return response.ok ? response.json() : [];
};

// clai, then the programs `make` built for /bin: the MCP server ports, and npx and uvx; and the
// wrappers for /usr/local/bin, whose entries name that directory.
const programList = async () => {
  const response = await fetch("./bin/index.json");
  return [{ name: "clai", file: "clai.wasm" }, ...(response.ok ? await response.json() : [])];
};

// A failure of the boot says where it stopped, on the terminal and in the console: a module
// worker's own error event carries only the message.
let phase = "starting";
const bootStarted = performance.now();
addEventListener("unhandledrejection", (event) => {
  const reason = event.reason;
  console.error(`boot failed while ${phase}`, reason);
  post({
    error: `The machine did not start: it stopped while ${phase}, after ${Math.round(performance.now() - bootStarted)} ms and ` +
      `${loaded.files} files (${(loaded.bytes / 1e6).toFixed(1)} MB). ${reason?.message ?? reason}. Reload to try again.`,
  });
});

phase = "reading the site's list of packed files";
try {
  const response = await fetch("./precompressed.json");
  if (response.ok) precompressed = new Set(await response.json());
} catch {
  // No list: every file is fetched as it is.
}
phase = "starting the kernel";
// The kernel's own module, which wasm-bindgen fetches itself unless it is handed the bytes.
const KERNEL = "pkg/clai_web_bg.wasm";
await init(precompressed.has(KERNEL) ? { module_or_path: await fetchBytes(`./${KERNEL}`) } : undefined);
phase = "fetching the certificates";
const certificates = await fetchBytes("./ca-certificates.crt");
phase = "listing the programs";
const [programs, list] = await Promise.all([programList(), packageList()]);
post({ log: `Loading ${[...programs, ...list].map(({ name }) => name).join(", ")}…` });
phase = "downloading the programs";
const files = await fetchAll([
  ...programs.map(({ file }) => `./${file}`),
  ...list.map(({ file }) => `./packages/${file}`),
]);
const programBytes = files.slice(0, programs.length);
const packages = files.slice(programs.length);
post({ log: `\x1b[2mLoaded ${loaded.files} files, ${(loaded.bytes / 1e6).toFixed(1)} MB, in ${((performance.now() - bootStarted) / 1000).toFixed(1)} s.\x1b[0m` });
phase = "booting the machine";
const local = programs.map(({ dir }) => dir === "/usr/local/bin");
const pick = (items, wantLocal) => items.filter((_, i) => local[i] === wantLocal);
const names = programs.map(({ name }) => name);
const shell = await boot(
  certificates,
  pick(names, false),
  pick(programBytes, false),
  pick(names, true),
  pick(programBytes, true),
  packages,
  rows,
  cols,
);
for (const note of shell.notes()) post({ log: `\x1b[33m${note}\x1b[0m` });
// Every run asks the host to carry its HTTP: the page's fetch is the client, with the browser's
// own TLS (WASIX_HTTP=host, components/go/src/net/http/wasix_http.go). A line that sets
// WASIX_HTTP keeps its own value, because bash applies its assignments over the login's.
const HOST = "WASIX_HTTP=host";
const home = shell.login_env().find((v) => v.startsWith("HOME="))?.slice("HOME=".length) ?? "/";
phase = "running";
post({ events: shell.take_events() });
post({ ready: true, bash: list.some(({ name }) => name === "wasmer/bash"), home });
post({ log: "Network: the page's fetch is the client, with the browser's TLS, and only what the browser lets the page reach." });

// The audio inputs whose /run/audio files are open, which the page captures and sends back.
let wanted = "";
const audio = () => {
  const now = shell.audio_wanted();
  if (now.join() !== wanted) post({ audio: now });
  wanted = now.join();
};

onmessage = async ({ data: { path, args, env, input, size, samples, devices } }) => {
  if (samples) return shell.push_audio(samples.name, samples.bytes);
  if (devices) {
    for (const { name, label } of devices) {
      try {
        shell.add_audio_input(name, label);
      } catch (error) {
        post({ log: `\x1b[33mno /run/audio/${name}: ${error}\x1b[0m` });
      }
    }
    return;
  }
  if (input) return shell.type_input(input);
  if (size) return shell.resize(size.rows, size.cols);
  const drain = () => {
    const bytes = shell.take_output();
    if (bytes.length > 0) post({ output: bytes });
    for (const sound of shell.take_played()) post({ play: sound });
    const events = shell.take_events();
    if (events !== "[]") post({ events });
    const outbox = shell.take_outbox();
    if (outbox.length > 0) post({ outbox });
    for (const note of shell.take_network_notes()) post({ log: `\x1b[33m${note}\x1b[0m` });
    audio();
  };
  const timer = setInterval(drain, 30);
  let status;
  try {
    status = await shell.run(path, args, [...(env ?? []), HOST]);
  } catch (error) {
    post({ error: String(error) });
    status = 1;
  }
  clearInterval(timer);
  drain();
  post({ status });
};
