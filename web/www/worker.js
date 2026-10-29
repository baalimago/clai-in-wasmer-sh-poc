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

await init();
const certificates = await fetchBytes("./ca-certificates.crt");
const clai = await fetchBytes("./clai.wasm");
const list = await packageList();
post({ log: `Loading ${["clai", ...list.map(({ name }) => name)].join(", ")}…` });
const packages = await Promise.all(list.map(({ file }) => fetchBytes(`./packages/${file}`)));
const shell = await boot(`ws://${location.host}/`, certificates, clai, packages, rows, cols);
for (const note of shell.notes()) post({ log: `\x1b[33m${note}\x1b[0m` });
const home = shell.login_env().find((v) => v.startsWith("HOME="))?.slice("HOME=".length) ?? "/";
post({ ready: true, bash: list.some(({ name }) => name === "wasmer/bash"), home });

onmessage = async ({ data: { path, args, env, input, size } }) => {
  if (input) return shell.type_input(input);
  if (size) return shell.resize(size.rows, size.cols);
  const drain = () => {
    const bytes = shell.take_output();
    if (bytes.length > 0) post({ output: bytes });
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
