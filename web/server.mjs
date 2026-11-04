// Serves the page. `--open` opens it in the default browser.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
  ".webc": "application/octet-stream",
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

// A site's CLI login routes, on the page's own origin, so the check signs a guest in and out
// with no cloud account and no cross-origin request (components/slivingdoc, architecture/login.md).
// Every approval is approved at once: there is no person in a headless check.
const ACCOUNT = "ada@example.test";
const SPACE = "check-notes";
const CODE = "BCDF-GHJK";
const approvals = new Set();
const keys = new Set();

async function json(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

// site answers one CLI login request; false is a path it does not serve.
async function site(request, response) {
  const { pathname } = new URL(request.url, "http://localhost");
  if (!pathname.startsWith("/cli/v1/")) return false;
  const origin = `http://${request.headers.host}`;
  const bearer = (request.headers.authorization ?? "").replace(/^Bearer /, "");
  const answer = (status, body) => {
    response.writeHead(status, body === undefined ? undefined : { "content-type": "application/json" });
    response.end(body === undefined ? undefined : JSON.stringify(body));
  };
  switch (pathname) {
    case "/cli/v1/start": {
      const deviceCode = randomUUID();
      approvals.add(deviceCode);
      answer(200, {
        deviceCode,
        userCode: CODE,
        verificationUri: `${origin}/cli/login`,
        verificationUriComplete: `${origin}/cli/login#${CODE}`,
        interval: 1,
        expiresIn: 120,
      });
      return true;
    }
    case "/cli/v1/token": {
      const { deviceCode } = await json(request);
      if (!approvals.delete(deviceCode)) {
        answer(400, { error: "expired_token" });
        return true;
      }
      const key = `sld_check_${randomUUID().replaceAll("-", "")}`;
      keys.add(key);
      answer(200, {
        key,
        access: "write",
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        endpoint: origin,
        account: ACCOUNT,
      });
      return true;
    }
    case "/cli/v1/spaces": {
      if (!keys.has(bearer)) {
        answer(401, { error: "invalid_token" });
        return true;
      }
      answer(200, { spaces: [{ name: SPACE, owner: ACCOUNT, access: "write" }] });
      return true;
    }
    case "/cli/v1/revoke": {
      // A key the site does not know counts as revoked, as sitelogin.Revoke does.
      keys.delete(bearer);
      answer(204);
      return true;
    }
  }
  answer(404, { error: "no_route" });
  return true;
}

export function startServer(port = Number(process.env.PORT ?? 5001)) {
  const server = http.createServer(async (request, response) => {
    const { pathname } = new URL(request.url, "http://localhost");
    if (await site(request, response)) return;
    // The check's model: an OpenAI-shaped streamed completion, so `make check` drives a real
    // query through the page's network without a provider. Its CORS headers are the ones a
    // trial's gateway needs, because the guest reaches it as the page's fetch.
    if (pathname === "/test/v1/chat/completions") {
      response.writeHead(request.method === "OPTIONS" ? 204 : 200, {
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "authorization,content-type",
        "access-control-allow-methods": "POST,OPTIONS",
        "content-type": "text/event-stream",
        "cache-control": "no-store",
      });
      response.end(request.method === "OPTIONS" ? undefined : [
        `data: ${JSON.stringify({ choices: [{ delta: { content: "fetched" } }] })}\n\n`,
        "data: [DONE]\n\n",
      ].join(""));
      return;
    }
    const file = resolve(pathname);
    if (file === null) {
      response.writeHead(403).end();
      return;
    }
    try {
      const type = TYPES[path.extname(file)] ?? "text/plain";
      // The Go toolchain's package is 171 MB; bundle.sh gzips it, and the browser decodes it.
      const gz = file.endsWith(".webc") ? await readFile(`${file}.gz`).catch(() => null) : null;
      const body = gz ?? (await readFile(file));
      // Cross-origin isolated, so guest memory can be a SharedArrayBuffer that a process's
      // threads share (ffmpeg and rg start threads).
      response.writeHead(200, {
        "content-type": type,
        ...(gz ? { "content-encoding": "gzip" } : {}),
        "cross-origin-opener-policy": "same-origin",
        "cross-origin-embedder-policy": "require-corp",
      }).end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
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
