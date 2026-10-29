// Runs the WASIX v2 machine off the page's thread: browsers instantiate modules over 8 MB
// synchronously only in workers, and the terminal stays responsive while clai runs.
import init, { boot, compile } from "./pkg/clai_web.js";

const post = (message) => postMessage(message);

const fetchBytes = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`cannot fetch ${url}: ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
};

await init();
const shell = await boot(`ws://${location.host}/`, await fetchBytes("./ca-certificates.crt"));
post({ log: "Compiling clai…" });
const clai = await compile(await fetchBytes("./clai.wasm"));
post({ ready: true });

onmessage = async ({ data: { args, env } }) => {
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
