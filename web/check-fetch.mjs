// The machine's network: the page's own fetch calls carry its traffic, so a copy of the page
// served as files alone still runs a live query. Checks that the host call streams a model's
// answer, that the socket backend still carries one, and that the socket backend says why an
// https request is out of its reach (WASIX_HTTP, components/go/src/net/http/wasix_http.go).
import { chromium } from "playwright";

import { startServer } from "./server.mjs";

const server = await startServer();
const port = server.address().port;
const model = (url) => JSON.stringify({ model: "gpt-4.1-mini", url });
const write = (name, url) =>
  `mkdir -p "$(clai confdir)" && printf '%s' '${model(url)}' > "$(clai confdir)/openai_gpt_${name}.json"`;

// The guest reaches the page's model by name, as it reaches any host: the browser's resolver maps
// that name to this machine's loopback, and the model answers with the CORS headers a trial's
// gateway needs. A guest's own loopback is the kernel's, which is why the name is not localhost.
const HOST = "fetch.test";

const ROWS = [
  // The host call: the guest hands the request to the page, whose fetch makes it, and streams the
  // answer's body back. The model is on the page's own origin.
  { line: write("gpt-host", `http://${HOST}:${port}/test/v1/chat/completions`), status: 0, prints: "" },
  { line: "OPENAI_API_KEY=test clai -cm gpt-host query hello 2>&1 | cat", status: 0, prints: "fetched" },
  // The socket backend, which stays for a page that opens a socket: the same model over it.
  { line: write("gpt-socket", `http://${HOST}:${port}/test/v1/chat/completions`), status: 0, prints: "" },
  {
    line: "WASIX_HTTP=socket OPENAI_API_KEY=test clai -cm gpt-socket query hello 2>&1 | cat",
    status: 0,
    prints: "fetched",
  },
  // An https URL over a socket: the guest writes a ClientHello, which no fetch call can carry,
  // and the terminal says what the backend made of it instead of printing an answer.
  { line: write("gpt-tls", `https://${HOST}:${port}/test/v1/chat/completions`), status: 0, prints: "" },
  {
    line: "WASIX_HTTP=socket OPENAI_API_KEY=test clai -cm gpt-tls query hello 2>&1 | cat",
    prints: "the connection carries TLS",
  },
];

const browser = await chromium.launch({ args: [`--host-resolver-rules=MAP ${HOST} 127.0.0.1`] });
try {
  const page = await browser.newPage();
  page.on("pageerror", (error) => console.error("page error:", error.message));
  await page.goto(`http://localhost:${port}/`);
  await page.waitForSelector("body[data-ready]", { timeout: 120_000 });
  const bash = await page.evaluate(() => document.body.dataset.bash === "true");
  if (!bash) {
    console.error("\nFAIL: no bash in the machine, so the rows cannot run (make packages)");
    process.exitCode = 1;
  }
  // Each row's marker is unique to it, so the whole screen answers "did this run print it": a
  // reply is written over clai's spinner, which makes an offset into the screen unreliable.
  for (const { line, status: want, prints } of bash ? ROWS : []) {
    const status = await page.evaluate((line) => window.runCommand(line), line);
    const printed = prints
      ? await page
          .waitForFunction((marker) => window.terminalText().includes(marker), prints, { timeout: 30_000 })
          .then(() => true, () => false)
      : true;
    console.log((await page.evaluate(() => window.terminalText())).trimEnd().split("\n").slice(-4).join("\n"));
    if ((want !== undefined && status !== want) || !printed) {
      console.error(`\nFAIL: ${line} exited with ${status} (want ${want}) or did not print ${prints}`);
      process.exitCode = 1;
    }
  }
  if (!process.exitCode) {
    console.log("\nok: with no proxy, the host call and the socket backend each carried a live query, and the socket backend said why TLS is out of its reach");
  }
} finally {
  await browser.close();
  server.close();
}