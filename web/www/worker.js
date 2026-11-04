// Runs the WASIX v2 machine off the page's thread: browsers instantiate modules over 8 MB
// synchronously only in workers, and the terminal stays responsive while clai runs. The page's
// first message is the terminal's size; then come commands, keystrokes and new sizes.
import init, { boot } from "./pkg/clai_web.js";

const post = (message) => postMessage(message);

const fetchBytes = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`cannot fetch ${url}: ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
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

await init();
const certificates = await fetchBytes("./ca-certificates.crt");
const [programs, list] = await Promise.all([programList(), packageList()]);
post({ log: `Loading ${[...programs, ...list].map(({ name }) => name).join(", ")}…` });
post({ log: "Fetching the Go toolchain for /go…" });
const [programBytes, packages, toolchain] = await Promise.all([
  Promise.all(programs.map(({ file }) => fetchBytes(`./${file}`))),
  Promise.all(list.map(({ file }) => fetchBytes(`./packages/${file}`))),
  // `make go-package` packs it; a page without it still boots, and says so.
  fetchBytes("./go/go.webc").catch(() => {
    post({ log: "\x1b[33mNo Go toolchain in this page: run make go-package, then reload.\x1b[0m" });
    return null;
  }),
]);
const local = programs.map(({ dir }) => dir === "/usr/local/bin");
const pick = (items, wantLocal) => items.filter((_, i) => local[i] === wantLocal);
const names = programs.map(({ name }) => name);
const shell = await boot(
  certificates,
  pick(names, false),
  pick(programBytes, false),
  pick(names, true),
  pick(programBytes, true),
  toolchain ? [...packages, toolchain] : packages,
  rows,
  cols,
);
for (const note of shell.notes()) post({ log: `\x1b[33m${note}\x1b[0m` });
// Every run asks the host to carry its HTTP: the page's fetch is the client, with the browser's
// own TLS (WASIX_HTTP=host, components/go/src/net/http/wasix_http.go). A line that sets
// WASIX_HTTP keeps its own value, because bash applies its assignments over the login's.
const HOST = "WASIX_HTTP=host";
const home = shell.login_env().find((v) => v.startsWith("HOME="))?.slice("HOME=".length) ?? "/";
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
