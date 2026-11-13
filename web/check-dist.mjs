// Runs the static site `make dist` writes, as Edge serves it: dist/public's files and only the
// headers dist/settings/config.toml gives static-web-server, nothing of web/server.mjs's. Checks
// that every file the page asks for is there, that the page is cross-origin isolated, that it
// boots, and that clai and bash run in it. DIST_URL checks a site that is already up instead
// (`wasmer run dist --net`, or the deployed app).
import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
const PUBLIC = path.join(DIST, "public");
const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

// The headers static-web-server adds to every file: the `**` rule's table in its settings.
export function headersFor(config) {
  const headers = {};
  let inTable = false;
  for (const line of config.split("\n").map((l) => l.trim())) {
    if (line.startsWith("[")) inTable = line === "[advanced.headers.headers]";
    else if (inTable) {
      const match = line.match(/^([A-Za-z-]+)\s*=\s*"([^"]*)"$/);
      if (match) headers[match[1]] = match[2];
    }
  }
  return headers;
}

async function serve() {
  const headers = headersFor(await readFile(path.join(DIST, "settings", "config.toml"), "utf8"));
  const server = http.createServer(async (request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    const file = path.join(PUBLIC, pathname === "/" ? "index.html" : pathname);
    if (!file.startsWith(PUBLIC + path.sep)) return response.writeHead(403).end();
    try {
      const body = await readFile(file);
      response.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream", ...headers }).end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

const ROWS = [
  { line: "clai help", status: 0, prints: "Usage: clai" },
  { line: "ls /bin | grep -x slivingdoc", status: 0, prints: "slivingdoc" },
  { line: "echo static | tr a-z A-Z", status: 0, prints: "STATIC" },
];

const server = process.env.DIST_URL ? null : await serve();
const url = process.env.DIST_URL ?? `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch({ args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
try {
  const context = await browser.newContext({ permissions: ["microphone"] });
  const page = await context.newPage();
  const missing = [];
  page.on("response", (response) => {
    if (response.status() >= 400) missing.push(`${response.status()} ${response.url()}`);
  });
  page.on("pageerror", (error) => console.error("page error:", error.message));
  await page.goto(url);
  await page.waitForSelector("body[data-ready]", { timeout: 180_000 });
  if (!(await page.evaluate(() => window.crossOriginIsolated))) {
    console.error("\nFAIL: the page is not cross-origin isolated: check the COOP and COEP headers");
    process.exitCode = 1;
  }
  for (const { line, status: want, prints } of ROWS) {
    const before = await page.evaluate(() => window.terminalText());
    const status = await page.evaluate((line) => window.runCommand(line), line);
    const printed = (await page.evaluate(() => window.terminalText())).slice(before.length);
    console.log(printed.trimEnd());
    if (status !== want || !printed.includes(prints)) {
      console.error(`\nFAIL: ${line} exited with ${status} (want ${want}) or did not print ${prints}`);
      process.exitCode = 1;
    }
  }
  if (missing.length) {
    console.error(`\nFAIL: the site is missing what the page asked for:\n${missing.join("\n")}`);
    process.exitCode = 1;
  }
  if (!process.exitCode) console.log(`\nok: ${url} is cross-origin isolated, boots, and runs clai and bash with nothing missing`);
} finally {
  await browser.close();
  server?.close();
}
