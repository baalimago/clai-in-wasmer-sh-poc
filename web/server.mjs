// Serves the page and a WISP server on one port. `--open` opens the page in the default browser.
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { server as wisp, logging } from "@mercuryworkshop/wisp-js/server";

const WEB = path.dirname(fileURLToPath(import.meta.url));
const WWW = path.join(WEB, "www");
// The packages the page loads from node_modules: the terminal, the fonts and marked.
const PACKAGES = ["@xterm", "@fontsource", "marked"];
const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".wasm": "application/wasm",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
};

function resolve(pathname) {
  const scope = PACKAGES.find((p) => pathname.startsWith(`/node_modules/${p}/`));
  const [root, rest] = scope
    ? [path.join(WEB, "node_modules", scope), pathname.slice(`/node_modules/${scope}/`.length)]
    : [WWW, pathname === "/" ? "index.html" : pathname];
  const file = path.join(root, rest);
  return file.startsWith(root + path.sep) ? file : null;
}

export function startServer(port = Number(process.env.PORT ?? 5001)) {
  logging.set_level(logging.WARN);
  const server = http.createServer(async (request, response) => {
    const file = resolve(new URL(request.url, "http://localhost").pathname);
    if (file === null) {
      response.writeHead(403).end();
      return;
    }
    try {
      const body = await readFile(file);
      const type = TYPES[path.extname(file)] ?? "text/plain";
      // Cross-origin isolated, so guest memory can be a SharedArrayBuffer that a process's
      // threads share (ffmpeg and rg start threads).
      response.writeHead(200, {
        "content-type": type,
        "cross-origin-opener-policy": "same-origin",
        "cross-origin-embedder-policy": "require-corp",
      }).end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  server.on("upgrade", (request, socket, head) => wisp.routeRequest(request, socket, head));
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

function openBrowser(url) {
  const [command, args] =
    process.platform === "darwin" ? ["open", [url]]
    : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
    : ["xdg-open", [url]];
  spawn(command, args, { stdio: "ignore", detached: true })
    .on("error", () => console.log(`could not open a browser; open ${url} yourself`))
    .unref();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = await startServer();
  const url = `http://localhost:${server.address().port}/`;
  console.log(`serving ${url} (Chrome or Edge 137+, for JSPI). Ctrl-C stops it.`);
  if (process.argv.includes("--open")) openBrowser(url);
}
