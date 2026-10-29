// Runs the WASIX v2 machine off the page's thread: browsers instantiate modules over 8 MB
// synchronously only in workers, and the terminal stays responsive while clai runs. The page's
// first message is the terminal's size; then come commands, keystrokes and new sizes.
import init, { boot, compile } from "./pkg/clai_web.js";

const post = (message) => postMessage(message);

const fetchBytes = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`cannot fetch ${url}: ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
};

const { rows, cols } = await new Promise((resolve) => (onmessage = ({ data }) => resolve(data.size)));
await init();
const certificates = await fetchBytes("./ca-certificates.crt");
const shell = await boot(`ws://${location.host}/`, certificates, rows, cols);
post({ log: "Compiling clai…" });
const clai = await compile(await fetchBytes("./clai.wasm"));
post({ ready: true });

onmessage = async ({ data: { args, env, input, size } }) => {
  if (input) return shell.type_input(input);
  if (size) return shell.resize(size.rows, size.cols);
  const drain = () => {
    const bytes = shell.take_output();
    if (bytes.length > 0) post({ output: bytes });
  };
  const timer = setInterval(drain, 30);
  let status;
  try {
    status = await shell.run(clai, args, env);
  } catch (error) {
    post({ error: String(error) });
    status = 1;
  }
  clearInterval(timer);
  drain();
  post({ status });
};
