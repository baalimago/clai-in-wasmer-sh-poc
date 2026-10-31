# clai in the browser, on WASIX v2

[clai](https://github.com/baalimago/clai), a Go program, compiled for a Go port to WASIX v2 and
run on wasmer's WASIX v2 kernel in a browser tab. The page is a terminal over a small Linux-like
machine whose `/bin` has clai, bash, coreutils, grep, sed, find, rg, fd and git from the Wasmer
registry, ffmpeg, which records the browser's microphone and shared tab audio, and an `npx` and
`uvx` that start the MCP servers clai profiles ask for; type `ls /bin` or `clai h`.

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
slivingdoc serves with libgit2 behind it, that clai calls the filesystem MCP server that `npx`
starts, and that ffmpeg records Chromium's fake microphone and
clai's meeting-transcriber profile records and transcribes with it (with clai's test models).
It also checks that the under-the-hood view sees what a line does, and runs the Minutes app's
Record button through to the agent's reply. `web/units.test.mjs` covers the page's logic that
needs no browser.

The Go toolchain is its own package: `make go-package` packs it (about two minutes, 171 MB),
`make poc` and `make check` do that first, and only a page opened with `?go` fetches it. See
[Go in the tab](#what-works) below.

## Minutes, and under the hood

The page is **Minutes**, a meeting-notes app. **Peek under the hood** opens the machine it runs
on below it: what each click started, opened and connected to, and the machine's terminal.
Nothing the app does needs the peek; its buttons run programs on the machine directly:

| Button | Runs |
| --- | --- |
| Start recording | `clai -reply-only -profile-path cchub:baalimago/meeting-transcriber@13 query '<notebook format>\n\nMeeting: <title>. <details>'`, in `~/notebook` |
| Stop and summarize | types Enter on the console, which ends clai's `audio_record` |
| Share a tab | asks the browser for the tab whose audio the recording takes (shown while the agent records a tab) |
| Send (answer the agent) | the same `clai`, with `-re` and the answer as the query |
| A meeting | `cat` of its summary and transcript, rendered as markdown |
| history | `slivingdoc log` |

The agent is the whole transcriber: it records (its `audio_record` tool starts ffmpeg), transcribes
with speaker labels (`gpt-4o-transcribe-diarize`, so the app asks for `OPENAI_API_KEY`), and files
the notes. The app only puts the notebook's layout (`meetings/summaries/<start>_<slug>.md` and
`meetings/transcripts/...`) at the top of the query, so the profile stays as it is. Without a
slivingdoc token the notes stay in `~/notebook` in the tab; with one (from slivingdoc.dev, under
Connect slivingdoc), every run gets `SLIVINGDOC_TOKEN`, so the agent's slivingdoc server writes to
the hosted notebook and the list pulls it first. When the agent is done, the meeting it filed opens
as Summary and Transcript cards; what it says shows as markdown (`marked`, with raw HTML shown as
text and links to the notebook's files opening them in the app).

Programs send what the app reads to `/run/page/out`, a write-only file whose every write, once
closed, reaches the page as one message whose first line names it (`reply`, `meetings`,
`meeting`, `history`).

The peek is built from the kernel itself: the WASIX v2 trace layer
(`components/wasmer/lib/wasixv2/trace`) reports each `execve`, exit, open, `connect`, `dup`,
close, rename, mkdir and unlink that succeeds, and the bytes through each descriptor, for every
process, WASIX v1 programs such as bash and ffmpeg included. `web/src/observe.rs` keeps them
until the page takes them, as JSON, adding up the bytes a descriptor moves between two other
events and naming the host behind each address the WISP network handed out. Each line runs as
`bash -c LINE TAG`, so a process's tag, from its `$0` and inherited by what it starts, says which
click or terminal line it belongs to. The view (`web/www/hood.js`) shows the last click's line
and its process tree (each process labelled: the agent, an MCP server, libgit2, the recording ffmpeg), the event log, the connections by host and the files written, with the
bytes moved through redirections and inherited descriptors counted for the file or connection
behind them. The app's progress steps come from the same events: the ffmpeg with an input is the
recording, a connection to api.openai.com after it the transcription, one from slivingdoc the
save.

## Prerequisites

- Go 1.24.6 or later on `PATH`, to bootstrap the Go port
- [rustup](https://rustup.rs); `web/rust-toolchain.toml` pulls Rust 1.96 and the
  `wasm32-unknown-unknown` target on first use
- Node.js 20 or later
- CMake 3.16 or later and curl, for libgit2 and ffmpeg: the build downloads the
  [wasi-sdk](https://github.com/WebAssembly/wasi-sdk) 25 into `.tools/` to compile them
- Chrome or Edge 137 or later, for JavaScript Promise Integration (JSPI)

`wasm-bindgen` is installed into `.tools/` at the version the page's crate needs, and the ffmpeg
5.1.6 release, checked against its SHA-256, is downloaded there.

## How it fits together

```
browser tab
├─ index.html: xterm.js and a tiny line editor (each line runs as `bash -c`; cd, export, clear, help)
└─ worker.js: a Web Worker running the WASIX v2 machine (web/src/lib.rs)
   ├─ console: the terminal, as the machine's /dev/hvc0, while a line runs
   ├─ /bin/clai: clai built with GOOS=wasix GOARCH=wasm
   ├─ /go: the Go toolchain, a package the page mounts when it is opened with ?go
   ├─ /bin/npx, /bin/uvx: mcp/launcher.sh, which starts the MCP server ports below
   ├─ /bin/duckduckgo-mcp-server: mcp/duckduckgo-mcp-server, built like clai
   ├─ /bin/mcp-server-filesystem: mcp/mcp-server-filesystem, built like clai
   ├─ /bin/slivingdoc: slivingdoc's release, built like clai with mcp/slivingdoc laid over it
   ├─ /bin/slivingdoc-git2: libgit2 compiled to WASI, which slivingdoc runs its git operations in
   ├─ /bin/ffmpeg, /bin/ffprobe: ffmpeg 5.1.6 for wasm32-wasi (audio/ffmpeg)
   ├─ /usr/local/bin/ffmpeg: audio/ffmpeg.sh, which gives ffmpeg the page's audio as pulse devices
   ├─ /usr/local/bin/play: audio/play.sh, which plays a sound file in the page
   ├─ /run/audio/mic, /run/audio/tab: the page's microphone and shared tab audio (web/src/audio.rs)
   ├─ /bin/bash, /bin/ls, ...: registry packages (WASIX v1), on the kernel's v1 compatibility ABI
   └─ network: wasixv2-vnet-wisp, one WebSocket to the WISP proxy
                 └─ server.mjs: page, WISP proxy (wisp-js) and real TCP, on 127.0.0.1:5001
```

| Path | What it is |
| --- | --- |
| `components/go` | The Go port: `GOOS=wasix GOARCH=wasm` on go1.26.10 ([baalimago/go](https://github.com/baalimago/go/tree/claude/project-thread-77lz17)) |
| `components/wasixv2-abi` | The ABI and its code generators, including the Go backend that writes the port's syscall glue. Not needed for the build; it is here to regenerate that glue |
| `components/wasmer` | The WASIX v2 kernel and the WISP network backend for browsers ([baalimago/wasmer](https://github.com/baalimago/wasmer/tree/claude/project-thread-1nkwvt)) |
| `components/clai` | clai itself, unchanged |
| `components/slivingdoc`, `components/libgit2` | slivingdoc v1.3.1 and the libgit2 v1.9.6 it pins, unchanged |
| `mcp/mcpserver` | The MCP stdio server (JSON-RPC, initialize, tools) the Go ports share |
| `mcp/mcp-server-filesystem` | A Go port of [@modelcontextprotocol/server-filesystem](https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem) 2.1.0: its 14 tools, arguments and output, confined to the directories it is given |
| `mcp/duckduckgo-mcp-server` | A Go port of [duckduckgo-mcp-server](https://github.com/nickclyde/duckduckgo-mcp-server) 0.7.0: its tools, arguments, output and `DDG_*` settings |
| `mcp/slivingdoc` | What slivingdoc needs on wasix: its libgit2 helper and the Go files and `x/sys` that build it for the port (see [slivingdoc and libgit2](#slivingdoc-and-libgit2)) |
| `mcp/launcher.sh` | `npx` and `uvx`: run the packages that have a port in `/bin`, and say so for the others |
| `audio/ffmpeg/build.sh` | Builds ffmpeg and ffprobe for wasm32-wasi with the wasi-sdk: audio only, without threads |
| `audio/play.sh` | `play FILE`: writes the file to `/run/audio/play`, and the page plays it in a player at the bottom right |
| `audio/ffmpeg.sh` | The `ffmpeg` in `/usr/local/bin`: lists and opens the page's audio inputs as PulseAudio devices, and stops a recording cleanly |
| `web/src/audio.rs` | `/run/audio`: the page's audio inputs as files that stream while they are open |
| `web/www/audio.js` | Captures the microphone and a shared tab's audio for those files |
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
  connections go out through the proxy's host. If the page's WebSocket to the proxy closes (the
  server restarted, the laptop slept), connections fail until it reopens, which it does on
  its own within half a second to 30 seconds. TLS clients trust Mozilla's roots, which
  `make` writes to `web/www/ca-certificates.crt` from the Node.js running the build, and the
  machine mounts at `/etc/ssl/certs/ca-certificates.crt`. So
  `export OPENAI_API_KEY=sk-...` then `clai -cm gpt-4o q hello` makes a live query. Where this
  was built, every outbound connection went through a proxy that re-signs TLS, so the check
  there was with the proxy's CA appended to the bundle: `clai -cm claude-sonnet-5-5 q hello`
  with a made-up key got Anthropic's `401 invalid x-api-key` back.
- Interactive prompts: `clai setup`, `clai chat list` and the like read from the terminal, with
  the kernel editing the line as you type it, and `^C` stops clai.
- Go in the tab: open the page with `?go` and the machine mounts the Go toolchain at `/go`
  (171 MB, 39.5 MB gzipped, from [research/go-toolchain](research/go-toolchain)). `go build`,
  `go test` and `go vet` then run in the tab, the standard library and the module's own packages
  included, and what they build runs on the same kernel:
  `mkdir -p ~/hello && cd ~/hello && go mod init hello && printf 'package main\n\nimport "fmt"\n\nfunc main() { fmt.Println("hello from the tab") }\n' > main.go && go build -o hello . && ./hello`.
  The first build compiles every package the program imports, in the tab: 77 to 87 s for a
  program that imports `fmt`, `sort` and a package of its own. The cache is in the tab's home, so
  the next build takes 0.7 s. The package is fetched on every page load, so `?go` is opt-in.
  The page writes four examples into `~/examples` (from `web/www/examples`): `hello` (one file),
  `words` (a module with its own package and a test), `report` (`encoding/json` and `sort`) and
  `ticker` (goroutines). `cd ~/examples/hello && go run .` prints `hello from the tab`;
  `cd ~/examples/words && go test ./...` prints `ok words/text`.
  Modules outside the standard library work too: `go get rsc.io/quote` downloads three modules
  through the page's WISP network in 15 s, then `go build` compiles them, 88 s cold. The port's
  `go env` carries no `GOPROXY` or `GOSUMDB`, so `/usr/local/bin/go` sets both
  (research/go-toolchain/go.sh); an `export` wins.
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
version. `cchub:clai/researcher` and `cchub:baalimago/meeting-transcriber` start:

| Server | Command | Here |
| --- | --- | --- |
| ddg | `uvx duckduckgo-mcp-server==0.7.0` | Runs the Go port: `search`, `fetch_content` and `expand_link` give the Python server's output, and a live search answers from the page |
| slivingdoc | `npx -y slivingdoc@1.3.1 serve ...` | Runs slivingdoc 1.3.1 itself, with libgit2 1.9.6 in a helper process (below) |
| Filesystem | `npx -y @modelcontextprotocol/server-filesystem ./` | Runs the Go port: the tools give the Node server's text, diffs included, and refuse paths, symlinks too, outside the directories given. It takes its directories only from its arguments, not from MCP Roots |

The Go port has no threads, so a read that blocks in the kernel would stop every goroutine. The
port polls a descriptor outside the netpoller (a terminal, a pipe) until it is readable, sleeping
the goroutine in between, and only then reads it. The ddg port, which predates that, also puts
stdin in the netpoller (`mcp/duckduckgo-mcp-server/stdin_unix.go`).

## Recording meetings

clai's `audio_sources`, `audio_record` and `audio_transcribe` tools, which the
[meeting-transcriber](https://www.clai.chat/hub/baalimago/meeting-transcriber/) profile uses,
find inputs with `ffmpeg -sources pulse`, record with `ffmpeg -f pulse -i NAME`, and stop ffmpeg
with SIGINT. In the page:

| Input | pulse name | What it records |
| --- | --- | --- |
| `/run/audio/mic` | `browser-mic` | The browser's default microphone |
| `/run/audio/tab` | `browser-tab.monitor` | The audio of a tab, window or screen: a button asks you to pick one (a meeting's tab, say). Until you do, it records silence |
| `/run/audio/devN` | `browser-devN`, or `browser-devN.monitor` | Each other audio input of the browser's. On Linux, PipeWire and PulseAudio offer each output's "Monitor of ..." as one, which holds what the computer plays, a meeting app's audio included: it is a sink's monitor here too, and the first is the default sink |

The page asks for the microphone when it loads, which is what lets the browser name its audio
inputs, and adds each to `/run/audio`; `/run/audio/devices` lists them, a `name<TAB>label` line
each. clai's `audio_sources` then sees them all, and its agent picks which to record: by default
the default microphone and the default sink's monitor, mixed into one recording. Chrome and Chromium leave monitor sources out of their inputs on Linux, by design. A remapped copy of
the monitor, which is not one, is listed; named "Monitor of ...", it is a monitor here:

```sh
pactl load-module module-remap-source master="$(pactl get-default-sink).monitor" \
  source_name=meeting_audio source_properties='device.description="Monitor of System Audio"'
```

The page adds it when it appears, with no reload. Firefox lists monitors as they are.

The page captures an input only while ffmpeg has its file open, at 48 kHz on one `AudioContext`,
so a mic and tab recording stay in step. `/usr/local/bin/ffmpeg` (`audio/ffmpeg.sh`) answers
`-sources pulse` and `-sinks pulse` with those names and labels and turns `-f pulse -i NAME` into the raw
file. On SIGINT it writes to the input files, which ends them, so ffmpeg reads to the end and
finishes the WAV as it would on SIGINT: this ffmpeg is plain WASI and cannot catch signals.

`play /tmp/t.wav` plays a recording back: whatever is written to `/run/audio/play` goes, once the
file is closed, to a player in the page, and the browser decodes it.

ffmpeg is 5.1.6 built with the wasi-sdk for wasm32-wasi, without threads and audio only (WAV, MP3,
AAC/M4A, Ogg/Opus/Vorbis, FLAC, Matroska in; WAV and FLAC out; the filters clai uses). The
registry's `wasmer/ffmpeg` is a threaded build of a 2023 development snapshot, which deadlocks on
the v2 kernel once its decoder threads start, and ffmpeg 6.0 and later need threads.

So, with an OpenAI key for the transcription (`audioConfig.json` in `clai confdir` picks the
model):

```sh
export OPENAI_API_KEY=sk-...
mkdir -p ~/meetings && cd ~/meetings
clai -profile-path cchub:baalimago/meeting-transcriber@11 -query-summary query "Daily sync"
```

clai asks you to trust the profile first (or `clai profiles trust cchub:baalimago/meeting-transcriber@11`),
starts slivingdoc and the filesystem server (on the directory you run it in) for the notes, and
Enter stops the recording. The recording and the files clai
writes are in the tab's memory only.

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

## The Go toolchain on the same kernel

The same machine runs the Go toolchain: `go build`, `go test` and `go vet` compile, link and run
a module's standard library dependencies inside the kernel, and what they build runs there.
`research/go-toolchain/` holds the measurement, the patch and the scripts
([README](./research/go-toolchain/README.md)). The one root cause was `mmap`: the kernel hands
out guest pages at the address the Go runtime's own `sbrk` heap starts at, which upstream avoids
by having no `mmap` on `js/wasm` and `wasip1`. With the toolchain's six `mmap` users building
without it:

| Check, in the guest | Result |
| --- | --- |
| `go build .` (imports `fmt`, `os`, `sort`, `encoding/json`, a local package) | exit 0; 95 s with an empty `GOCACHE`, 6 s warm |
| `go build -p 1 std` | exit 0; 376 s cold, 7.6 s warm |
| `go test ./...` | `ok demo/word 1.765s`, test binary built and run in the guest |
| `go vet ./...` | exit 0 |
| `go build cmd/compile` | sees the module through `cmd/go` and stops in `cmd/compile/internal/ssagen`, where the guest compiler traps |

The page mounts this toolchain at `/go` when it is opened with `?go`: 39.5 MB gzipped, paid on
every page load, and the first build of a module costs the standard library's 80 s in the tab.

## What doesn't work yet

- Each line is a new bash, so shell variables, functions and jobs do not outlive it; `cd` and
  `export` are the page's. An interactive bash is the next step.
- Guest threads run on the worker's one thread, so rg and fd search with one core.
- `^C` kills clai rather than letting it clean up: the Go port cannot deliver signals to Go
  code yet, so `os/signal` never hears of SIGINT and its default action ends the process.
- Files exist only in memory, for the life of the tab, recordings too.
- Live transcription with a real key is untested here: this sandbox's proxy re-signs TLS. The
  test transcription model runs in `make check`.
- ffmpeg has no MP3 encoder, which clai's calibrated diarization path uses for recordings over
  25 MB with a `*diarize*` model.
- `npx` and `uvx` run only the ports in `/bin`: there is no Node.js or Python package
  installation (see [MCP servers](#mcp-servers)).
- slivingdoc's login lives in the machine's memory like every other file, so a reloaded page
  signs in again.
- `fetch_content` refuses addresses that are not public, as the Python server does, so a
  network whose DNS answers with private addresses (a VPN's fake IPs in 198.18.0.0/15, say)
  needs `DDG_ALLOW_PRIVATE_URLS=1`.
