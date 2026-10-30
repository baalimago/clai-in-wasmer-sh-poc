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

const { rows, cols } = await new Promise((resolve) => (onmessage = ({ data }) => resolve(data.size)));
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
const [programBytes, packages] = await Promise.all([
  Promise.all(programs.map(({ file }) => fetchBytes(`./${file}`))),
  Promise.all(list.map(({ file }) => fetchBytes(`./packages/${file}`))),
]);
const local = programs.map(({ dir }) => dir === "/usr/local/bin");
const pick = (items, wantLocal) => items.filter((_, i) => local[i] === wantLocal);
const names = programs.map(({ name }) => name);
const shell = await boot(
  `ws://${location.host}/`,
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
const home = shell.login_env().find((v) => v.startsWith("HOME="))?.slice("HOME=".length) ?? "/";
post({ events: shell.take_events() });
post({ ready: true, bash: list.some(({ name }) => name === "wasmer/bash"), home });

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
    audio();
  };
  const timer = setInterval(drain, 30);
  let status;
  try {
    status = await shell.run(path, args, env);
  } catch (error) {
    post({ error: String(error) });
    status = 1;
  }
  clearInterval(timer);
  drain();
  post({ status });
};
