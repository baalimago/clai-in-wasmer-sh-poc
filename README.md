# clai in the browser, on WASIX v2

[clai](https://github.com/baalimago/clai), a Go program, compiled for a Go port to WASIX v2 and
run on wasmer's WASIX v2 kernel in a browser tab. The page is a terminal; type `clai h`.

```sh
git clone --recurse-submodules --shallow-submodules https://github.com/baalimago/clai-in-wasmer-sh-poc
cd clai-in-wasmer-sh-poc
make poc
```

`make poc` builds everything, serves the page on http://localhost:5001 and opens it in your
default browser. The first build takes a few minutes (the Go toolchain and the wasm kernel);
later ones take seconds. `make check` runs the same page in headless Chromium and checks that
`clai h` and `clai help` print clai's usage.

## Prerequisites

- Go 1.24.6 or later on `PATH`, to bootstrap the Go port
- [rustup](https://rustup.rs); `web/rust-toolchain.toml` pulls Rust 1.96 and the
  `wasm32-unknown-unknown` target on first use
- Node.js 20 or later
- Chrome or Edge 137 or later, for JavaScript Promise Integration (JSPI)

`wasm-bindgen` is installed into `.tools/` at the version the page's crate needs.

## How it fits together

```
browser tab
├─ index.html: xterm.js and a tiny line editor (clai, export, clear, help)
└─ worker.js: a Web Worker running the WASIX v2 machine (web/src/lib.rs)
   ├─ clai.wasm: clai built with GOOS=wasix GOARCH=wasm
   └─ network: wasixv2-vnet-wisp, one WebSocket to the WISP proxy
                 └─ server.mjs: page, WISP proxy (wisp-js) and real TCP, on 127.0.0.1:5001
```

| Path | What it is |
| --- | --- |
| `components/go` | The Go port: `GOOS=wasix GOARCH=wasm` on go1.26.10 ([baalimago/go](https://github.com/baalimago/go/tree/claude/project-thread-4y27nr)) |
| `components/wasixv2-abi` | The ABI and its code generators, including the Go backend that writes the port's syscall glue. Not needed for the build; it is here to regenerate that glue |
| `components/wasmer` | The WASIX v2 kernel and the WISP network backend for browsers ([baalimago/wasmer](https://github.com/baalimago/wasmer/tree/claude/project-thread-l55h85)) |
| `components/clai` | clai itself, unchanged |
| `web/src/lib.rs` | The machine: boots once per page with the CA bundle mounted, compiles a program once, runs it as often as asked |
| `web/www` | The page, its worker and its line editor |
| `web/server.mjs` | Serves the page and the WISP proxy on one port |
| `web/check.mjs` | The headless check behind `make check` |

The machine runs in a Web Worker because Chrome compiles and instantiates a module over 8 MB
(clai is 29 MB) synchronously only off the page's thread. One machine serves every command,
so what clai writes under `~/.config` stays until the tab closes.

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

## What doesn't work yet

- Starting other programs: the machine has no `/bin`, and there is no shell, so clai's shell
  tools, `-add-shell-context`, glow and anything else that runs a subprocess fail.
- The terminal is not a TTY to clai: its output is a pipe, and stdin is empty, so piping
  into clai and interactive prompts (`clai setup`, `-r` chat) don't work.
- `^C` doesn't stop a running clai; reload the page.
- Files exist only in memory, for the life of the tab.
