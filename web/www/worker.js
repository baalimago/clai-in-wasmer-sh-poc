// Runs the WASIX v2 machine off the page's thread: browsers instantiate modules over 8 MB
// synchronously only in workers, and the terminal stays responsive while clai runs.
import init, { Shell, compile } from "./pkg/clai_web.js";

const post = (message) => postMessage(message);

await init();
const shell = new Shell(`ws://${location.host}/`);
post({ log: "Compiling clai…" });
const clai = await compile(new Uint8Array(await (await fetch("./clai.wasm")).arrayBuffer()));
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
