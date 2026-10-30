# clai in the browser, on WASIX v2

[clai](https://github.com/baalimago/clai), a Go program, compiled for a Go port to WASIX v2 and
run on wasmer's WASIX v2 kernel in a browser tab. The page is a terminal over a small Linux-like
machine whose `/bin` has clai, bash, coreutils, grep, sed, find, rg, fd and git from the Wasmer
registry, and an `npx` and `uvx` that start the MCP servers clai profiles ask for; type `ls /bin`
or `clai h`.

```sh
git clone --recurse-submodules --shallow-submodules https://github.com/baalimago/clai-in-wasmer-sh-poc
cd clai-in-wasmer-sh-poc
make poc
```

`make poc` builds everything, downloads the registry packages that `web/packages.txt` lists
(`make packages`, from registry.wasmer.io), serves the page on http://localhost:5001 and opens it
in your default browser. The first build takes a few minutes (the Go toolchain and the wasm kernel);
later ones take seconds. `make check` runs the same page in headless Chromium and checks that
`clai h` and `clai help` print clai's usage, that clai reads its terminal, that lines run
in bash, that clai calls an MCP server that `uvx` starts, that its async commands run, and that
slivingdoc serves with libgit2 behind it.

## Prerequisites

- Go 1.24.6 or later on `PATH`, to bootstrap the Go port
- [rustup](https://rustup.rs); `web/rust-toolchain.toml` pulls Rust 1.96 and the
  `wasm32-unknown-unknown` target on first use
- Node.js 20 or later
- CMake 3.16 or later and curl, for libgit2: the build downloads the
  [wasi-sdk](https://github.com/WebAssembly/wasi-sdk) 25 into `.tools/` to compile it
- Chrome or Edge 137 or later, for JavaScript Promise Integration (JSPI)

`wasm-bindgen` is installed into `.tools/` at the version the page's crate needs.

## How it fits together

```
browser tab
├─ index.html: xterm.js and a tiny line editor (each line runs as `bash -c`; cd, export, clear, help)
└─ worker.js: a Web Worker running the WASIX v2 machine (web/src/lib.rs)
   ├─ console: the terminal, as the machine's /dev/hvc0, while a line runs
   ├─ /bin/clai: clai built with GOOS=wasix GOARCH=wasm
   ├─ /bin/npx, /bin/uvx: mcp/launcher.sh, which starts the MCP server ports below
   ├─ /bin/duckduckgo-mcp-server: mcp/duckduckgo-mcp-server, built like clai
   ├─ /bin/slivingdoc: slivingdoc's release, built like clai with mcp/slivingdoc laid over it
   ├─ /bin/slivingdoc-git2: libgit2 compiled to WASI, which slivingdoc runs its git operations in
   ├─ /bin/bash, /bin/ls, ...: registry packages (WASIX v1), on the kernel's v1 compatibility ABI
   └─ network: wasixv2-vnet-wisp, one WebSocket to the WISP proxy
                 └─ server.mjs: page, WISP proxy (wisp-js) and real TCP, on 127.0.0.1:5001
```

| Path | What it is |
| --- | --- |
| `components/go` | The Go port: `GOOS=wasix GOARCH=wasm` on go1.26.10 ([baalimago/go](https://github.com/baalimago/go/tree/claude/project-thread-q0c41s)) |
| `components/wasixv2-abi` | The ABI and its code generators, including the Go backend that writes the port's syscall glue. Not needed for the build; it is here to regenerate that glue |
| `components/wasmer` | The WASIX v2 kernel and the WISP network backend for browsers ([baalimago/wasmer](https://github.com/baalimago/wasmer/tree/claude/project-thread-1nkwvt)) |
| `components/clai` | clai itself, unchanged |
| `components/slivingdoc`, `components/libgit2` | slivingdoc v1.3.1 and the libgit2 v1.9.6 it pins, unchanged |
| `mcp/duckduckgo-mcp-server` | A Go port of [duckduckgo-mcp-server](https://github.com/nickclyde/duckduckgo-mcp-server) 0.7.0: its tools, arguments, output and `DDG_*` settings |
| `mcp/slivingdoc` | What slivingdoc needs on wasix: its libgit2 helper and the Go files and `x/sys` that build it for the port (see [slivingdoc and libgit2](#slivingdoc-and-libgit2)) |
| `mcp/launcher.sh` | `npx` and `uvx`: run the packages that have a port in `/bin`, and say so for the others |
| `web/src/lib.rs` | The machine: boots once per page with the CA bundle mounted and clai and the packages in `/bin`, compiles each program once, runs a file as often as asked |
| `web/src/packages.rs` | Installs webc packages as `wasmer run` does: commands in `/bin`, with their `wasi` annotations for v1 programs, and volumes where the package says |
| `web/packages.txt`, `web/fetch-packages.mjs` | The registry packages, and the script that downloads them to `web/www/packages` |
| `web/www` | The page, its worker and its line editor |
| `web/server.mjs` | Serves the page and the WISP proxy on one port |
| `web/check.mjs` | The headless check behind `make check` |

Each line runs as a new `bash -c` in the directory the page's `cd` last chose, with what
`export` set, so `cd` and `export` are the page's own. While a line runs, what you type goes to
the machine's console, a terminal whose line discipline
is the kernel's, as on Linux: clai's descriptors 0, 1 and 2 and its `/dev/tty` are that
terminal, the kernel echoes and edits what you type, `^C` is SIGINT, and the window's size
reaches the program as the terminal's. Between commands the page's own line editor reads the prompt.

The machine runs in a Web Worker because Chrome compiles and instantiates a module over 8 MB
(clai is 30 MB) synchronously only off the page's thread. One machine serves every command,
so what clai writes under `~/.config` stays until the tab closes. Each program compiles once,
on its first start. Processes take turns on the worker's one thread: one that computes holds
the others up.

## What works

- `clai h`, `clai help`, `clai version`, `clai confdir` and anything else that only prints.
- Name lookups, TCP and HTTPS: the guest resolves names through the WISP proxy, and its
  connections go out through the proxy's host. TLS clients trust Mozilla's roots, which
  `make` writes to `web/www/ca-certificates.crt` from the Node.js running the build, and the
  machine mounts at `/etc/ssl/certs/ca-certificates.crt`. So
  `export OPENAI_API_KEY=sk-...` then `clai -cm gpt-4o q hello` makes a live query. Where this
  was built, every outbound connection went through a proxy that re-signs TLS, so the check
  there was with the proxy's CA appended to the bundle: `clai -cm claude-sonnet-5-5 q hello`
  with a made-up key got Anthropic's `401 invalid x-api-key` back.
- Interactive prompts: `clai setup`, `clai chat list` and the like read from the terminal, with
  the kernel editing the line as you type it, and `^C` stops clai.
- Starting programs: Go's `os/exec` starts them through wasixv2's `spawn` (`posix_spawn` in one
  call), with pipes, `Dir` and `Env`, and WASIX v1 programs start others as on wasmer's v1
  runtime, so clai's shell tools and `-add-shell-context` can run `sh -c`, rg, find and git.
  `make check`'s bash rows (pipes, `ls /bin`, `cd`) pass in headless Chromium with the
  registry's packages, and so do clai's `cmd` tool and `-add-shell-context`, each running
  `sh -c`. A shell context's first variable starts bash, which compiles first, so give it a
  `timeout_ms` of some seconds rather than the 100 ms default.

## MCP servers

clai profiles start MCP servers with `npx` (Node.js) and `uvx` (Python), and the machine has
neither runtime that could run them:

- Python: the registry's `python/python` 3.13 runs, but MCP servers need the `mcp` package,
  whose dependencies (`pydantic-core`, `rpds-py`, `cryptography`) are native extensions. The
  [WASIX index](https://python-registry.wasix.org/) has them as shared libraries, and the
  kernel's WASIX v1 layer refuses `dlopen`.
- Node.js: the registry's `wasmer/edgejs` has `node`, `npm` and `npx`, but no JavaScript
  engine of its own: it imports N-API from its host (wasmerio/napi has a browser backend for
  wasmer-js), which the WASIX v2 machine does not provide yet.

So `npx` and `uvx` are `mcp/launcher.sh`, which accepts their usual forms (`npx -y pkg@1.2.3
args`, `uvx pkg==1.2.3 args`, `--from`) and runs the package's port from `/bin`, ignoring the
version. `cchub:clai/researcher` starts:

| Server | Command | Here |
| --- | --- | --- |
| ddg | `uvx duckduckgo-mcp-server==0.7.0` | Runs the Go port: `search`, `fetch_content` and `expand_link` give the Python server's output, and a live search answers from the page |
| slivingdoc | `npx -y slivingdoc@1.3.1 serve ...` | Runs slivingdoc 1.3.1 itself, with libgit2 1.9.6 in a helper process (below) |

The Go port has no threads, so a blocking read stops every goroutine. An MCP server reading
its requests from a pipe on stdin would stop the goroutine answering the request it just
read, so the ddg port puts stdin in the netpoller (`mcp/duckduckgo-mcp-server/stdin_unix.go`).
Any other Go MCP server built for the machine needs the same.

### slivingdoc and libgit2

slivingdoc (`components/slivingdoc`, at its v1.3.1 tag) is Go, and its git engine is libgit2
through cgo, which the Go port does not have. Its `internal/git2` package is the only libgit2
boundary: twenty seam functions, one per libgit2 operation. So the machine runs libgit2 in a
process of its own:

- `mcp/slivingdoc/git2/helper.c` is `/bin/slivingdoc-git2`: libgit2 1.9.6
  (`components/libgit2`), compiled to WASI with the wasi-sdk and linked into a small program
  that runs one operation per request on stdin and answers on stdout. It runs on the kernel's
  WASIX v1 layer, like bash. `mcp/slivingdoc/git2/wasi/` has the few POSIX headers and calls
  libgit2 names that WASI leaves out, for paths slivingdoc never takes (network transports,
  child processes); they fail as a host without them would.
- `mcp/slivingdoc/native_wasix.go` takes the place of slivingdoc's cgo file on wasix: the same
  seam functions, each one request to the helper, which it starts at libgit2's init.
- `mcp/slivingdoc/stdin_wasix.go` puts slivingdoc's stdin in the netpoller, as above.
- `mcp/slivingdoc/wasix.sh` lays those files over the checkout with `go build -overlay`, so it
  stays at the release, and gives the build a copy of `golang.org/x/sys` that builds for wasix
  (its `unix` package is linux's, and the port is linux/loong64's types with riscv32's
  system call numbers, so the loong64 files serve, renumbered).

slivingdoc's own `internal/git2` tests pass through the helper, natively and in the page,
except two that cannot: libgit2 here is built without threads, and a test that reads the
source tree for `os/exec` finds the helper's. To run them natively, build the helper with the
host's compiler against a native libgit2 and run
`CGO_ENABLED=0 go test -tags git2helper ./internal/git2/` in a checkout with
`native_wasix.go` copied in and the helper on `PATH`.

slivingdoc keeps the notebook in its hosted storage or an S3 bucket. Without a credential,
`serve` signs in on the first tool call: it prints an approval link on its stderr and waits.
`slivingdoc login` in the page does the same up front, and the login it stores serves the
servers clai starts afterwards. With a credential, pull, commit, log and slivingdoc's three-way
merges, conflict markers included, run in the page: two writers in it, against slivingdoc's
reference storage server (`internal/httpstore/gatewaytest`) also in it, pull, commit and
conflict as they do natively.

## What doesn't work yet

- Each line is a new bash, so shell variables, functions and jobs do not outlive it; `cd` and
  `export` are the page's. An interactive bash is the next step.
- Guest threads run on the worker's one thread, so rg and fd search with one core.
- `^C` kills clai rather than letting it clean up: the Go port cannot deliver signals to Go
  code yet, so `os/signal` never hears of SIGINT and its default action ends the process.
- Files exist only in memory, for the life of the tab.
- `npx` and `uvx` run only the ports in `/bin`: there is no Node.js or Python package
  installation (see [MCP servers](#mcp-servers)).
- slivingdoc's login lives in the machine's memory like every other file, so a reloaded page
  signs in again.
- `fetch_content` refuses addresses that are not public, as the Python server does, so a
  network whose DNS answers with private addresses (a VPN's fake IPs in 198.18.0.0/15, say)
  needs `DDG_ALLOW_PRIVATE_URLS=1`.
