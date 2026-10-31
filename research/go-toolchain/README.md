# The Go toolchain on WASIX v2

Measured on 2026-10-30, third session. **Yes: `go build`, `go test` and `go vet` run inside the
kernel**, standard library and imports included, and what they build runs there too. `mmap` was
the whole problem: the kernel hands out guest pages from the address the Go runtime's own `sbrk`
heap starts at, so a toolchain that maps an imported package's export data scribbles over its
heap. The failures that survived that fix and looked like a second kernel bug were binaries
built before it.

## What runs

| Check, in the guest | Result |
| --- | --- |
| `go version` | `go1.26.10 wasix/wasm` |
| `go build .` of a module importing `fmt` | exit 0, 3 of 3, identical md5; 95 s with an empty `GOCACHE`, 5.8 s warm |
| `go build .` of a module with a local package plus `fmt`, `os`, `sort`, `strings`, `encoding/json` | exit 0; 90 s cold, 6.1 s warm; the module prints the expected JSON |
| `go test ./...` | `ok demo/word 1.765s` cold, 0.22 s warm: the test binary is compiled, linked and run in the guest |
| `go vet ./...` | exit 0, 19.8 s |
| `go build -p 1 std` | exit 0: the whole standard library, 376 s from an empty `GOCACHE`, 7.6 s warm |
| `go list -m`, `go list .`, `go list -deps .`, `go env GOROOT` | all pass |
| the module `go build` produced | runs on the same kernel: `hello from wasix` |
| `HOME` in the environment | no longer fatal |
| `compile` and `link` without `cmd/go` (`direct.sh`) | 60-package module linked and run |
| `ladder.sh` (`version` to `build -p 1`) | every row exit 0 |

## The mmap/sbrk collision

`probe/mmap.go` maps 8 MB, fills it, then allocates a 64 MB heap slice:

| Guest | Result |
| --- | --- |
| `syscall.Mmap(-1, 0, 8<<20, ..., MAP_ANON)` | `[0x370000,0xb70000)` |
| `make([]byte, 64<<20)` after it | `[0x380000,0x4380000)` |
| Bytes of the mapping replaced by heap writes | 8,388,352 of 8,388,608 |

The mapping starts at the memory size the kernel saw, which is the end of the image's data — and
`runtime.mem_wasm.go` sets `bloc` to exactly `memRound(firstmoduledata.end)` and grows from
there, because on wasm the Go runtime is the owner of everything above its data segment. Neither
side can see the other's cursor.

That is the upstream reason `cmd/go/internal/mmap/mmap_other.go` exists for `js/wasm` and
`wasip1`: those platforms have no `mmap`. The wasix port sets the `unix` tag, so it selects every
`mmap` implementation Go has.

## The patch

`patches/wasix-no-mmap.patch` gives each of the five pairs `unix && !wasix` / `!unix || wasix`:
`cmd/compile`'s export-data map, `cmd/link`'s output map, `cmd/internal/bio`'s input map,
`cmd/go`'s module map and the vendored `x/telemetry` map. It also carries one build-tag fix
without which `cmd/go` does not build for wasix at all: `cmd/go/internal/telemetrystats` sends
wasix into `golang.org/x/sys/unix`, which has no wasix files.

## Stale binaries looked like a second bug

Three failures survived the patch, and one cause explains all of them: the binaries in
`pkg/tool/wasix_wasm` predated it. `build.sh` guarded them with `[ ! -x ]`, so a patched source
tree never rebuilt them, and a pre-patch `compile` maps its inputs over its own heap.

| Symptom | Why it looked independent |
| --- | --- |
| `asm` panics with `small map with no empty slot (concurrent map writes?)` only as a child of `cmd/go`, and passes alone 3 of 3 | the `asm` on disk was the pre-patch one, and the standalone runs used the same stale binary but a different heap layout |
| `compile` reports `marked free object in span 0x12b4660` only when `GOCACHE` had content, and passes after `rm -rf` of the cache | the cache only decided the heap layout the stale compiler hit, so the corruption showed on one layout and not the other; the cache was not itself invalid |
| `link` fails 3 of 3 with `HOME` set and passes 3 of 3 without | the same layout sensitivity: one environment value moves the heap |

`build.sh` now rebuilds `go`, `compile`, `link`, `asm`, `vet` and `preprofile` unconditionally
(6 s together when nothing changed) and stamps the 351 standard library archives with the
`compile` that built them, rebuilding them when that changes. The lesson for a session: a
toolchain binary is only as good as the source state it was built from, and `-o` into a path
that does not exist yet silently creates it, so a rebuild can land beside the tree it meant to
replace (it did, at `components/.build`, before this rule).

## Why the kernel is not a cause

`spawn` is a vfork child that `execve`s as the caller, and the exec'd image is a new instance,
so a child does not inherit its parent's linear memory. The kernel is host Rust, so guest and
kernel never share an address space, and `UserMemory::write` faults inside the low guard instead
of writing there.

## The page's package

`bundle.sh` packs what a tab needs as one webc package, `web/www/go/go.webc`, which the page
mounts at `/go` when it is opened with `?go`: `bin/go`, the six tools, the trimmed `GOROOT/src`
and `lib/time`, but no archives, since `cmd/go` compiles from source.

| Piece | Raw | gzip |
| --- | --- | --- |
| `go` | 29 MB | 6.7 MB |
| `compile` | 50 MB | 9.6 MB |
| `link` | 12 MB | 3.1 MB |
| `asm`, `vet`, `preprofile` | 25 MB | 6.9 MB |
| `GOROOT/src` without `cmd/`, `testdata` and `_test.go` (3743 files) | 61 MB | 12.8 MB |
| `lib/time/zoneinfo.zip`, `pkg/include` | 0.4 MB | 0.4 MB |
| the whole package, `go.webc` | 171 MB | 39.5 MB |

The volume needs no atom: `[fs] "/go" = "fs"` mounts the tree, so `go` starts by its path in it
and the 29 MB binary is stored once. The format stores no modes and its reader marks every file
0755, which is what the tools need and GOROOT does not mind, because nothing writes to it.
`web/src/packages.rs` mounts a package volume as a writable overlay, so the toolchain is a
read-only lower layer and the changes a build makes stay in the tab's memory.

`go.sh` is `/usr/local/bin/go`: it sets `GOROOT=/go`, `GOTOOLCHAIN=local` (a toolchain download
would fail) and `GOFLAGS=-buildvcs=false`, then starts `/go/bin/go`.

## Measured in the tab

`make check` opens the page with `?go` in headless Chromium and builds a program that imports
`fmt`, `sort` and a package of the module's own, then runs it. What that run and a longer one
measured:

| Check, in the tab | Result |
| --- | --- |
| the page boots with `?go` | 1.7 s, the package included |
| `go version` | `go1.26.10 wasix/wasm`, 1.3 s (the first start compiles `go`) |
| `go build -o hello .` with an empty `GOCACHE` | exit 0: 77 s and 87 s in two runs |
| `go build` again | 0.7 s: the cache is in the tab's `$HOME/.cache/go-build` |
| `go test ./...` | `ok demo/words 0.176s`, 52 s the first time: the test binary is built and run in the tab |
| `go vet ./...` | exit 0, 9.3 s |
| `./hello` | `HELLO [a b]`, built by the tab and run by the same kernel |
| `go env GOROOT GOPATH GOCACHE` | `/go`, `/home/user/go`, `/home/user/.cache/go-build` |

The native CLI needs 80 s for the same cold build, so the kernel inside the browser costs about
nothing here: the work is the compiler, and it runs the same way in both.

## The browser's i64 boundary

The first `go build` in the tab died with `Cannot convert 408103 to a BigInt` at
`time.preadn`: Go loads the time zone database from `lib/time/zoneinfo.zip` through `Seek`, and
`lseek` returns an i64. A guest's import call crosses JavaScript, and
`lib/api/src/backend/js/utils/convert.rs` handed the host function's i64 arguments to JS with
`JsValue::from_f64`, which is a Number; wasm-bindgen's glue wants a BigInt and throws. So every
`lseek` trapped, and every program that loads a zone or seeks a file with it. The native CLI
was unaffected, because the JS backend is the page's alone.

`wasmer_value_to_js` now gives `Value::I64` a BigInt (`JsValue::from(i64)`), and the same for an
i64 global's value in `entities/global.rs`; `js_value_to_wasmer` already took either. The
`probe/seek.go` program is what shows it: `create`, `seek`, `readat` and `readfile` all pass in
the tab now, and the first three failed before.

The tree keeps everything but the toolchain's own sources, its tests and its test data: the
assembler needs `runtime/asm_wasm.s`'s `go_tls.h`, and `//go:embed` pulls `internal/trace`'s
viewer, so a source-only trim does not build the standard library. A cold `GOCACHE` is what
costs the first build: every action ID hashes the sources, so they cannot be dropped, and every
package a program imports is compiled from source once. `go test` and `go vet` need `vet` beside
the other tools, and `go build cmd/...` needs `preprofile`; without them `cmd/go` stops with
`no such tool`.

The other driver is `direct.sh`'s: `compile` and `link`, the 351 archives and one `importcfg`,
with no `src` and no `cmd/go`. It costs a second or two a program, because the standard library
is compiled already, and 55 MB gzipped, but it resolves no module and runs no test. A page that
wants the whole toolchain takes the 39.5 MB first one.

## Still missing

- **The guest compiler traps on `cmd/compile/internal/ssagen`.** `go build cmd/compile` compiles
  the other ~200 packages and then fails:
  `wasixv2: thread 2 trapped ... RuntimeError: out of bounds memory access` at
  `runtime.mapaccess1` from `cmd/compile/internal/ssa.cse`, 3 of 3 runs at the same PC, with a
  135 MB heap, unchanged by `GOGC=off` and `-l`. `probe/grow.go` rules out the 4 GiB memory cap
  (the guest reaches 3.5 GiB of touched pages and then Go's own out-of-memory throw) and
  `probe/copystack.go` rules out stack copying (a map, a slice, a string and an interface in
  stack slots survive 20000 frames of 4 KiB). The same source and the same compiler build the
  package natively, and every other standard library package builds in the guest, so the next
  step is a wasm-level look at that one compile, with the reproducer below.
  ```sh
  # the failing compile, alone, in about 40 s
  G=$(cd .build/groot && pwd) S=$PWD/.build/go-toolchain/state/v2 H=$PWD/.build/go-toolchain/hello
  .build/wasmer-target/release/wasmer run --no-tty --volume "$G:/go" --volume "$S:/state" \
    --volume "$H:/work" --cwd /work --env GOROOT=/go --env TMPDIR=/state/tmp \
    "$G/pkg/tool/wasix_wasm/compile" -- -o /state/tmp/ssagen.a \
    -p cmd/compile/internal/ssagen -lang=go1.26 -std -complete -dwarf=false \
    -goversion go1.26.10 -nolocalimports -pack /go/src/cmd/compile/internal/ssagen/*.go
  ```
- `go build` of a module that *changes* the runtime (a `GODEBUG` fork, `go:linkname` into
  internals) recompiles the runtime, which is the 95 s again.
- No threads: `GOMAXPROCS` is 1 and `-p 1` is the only sensible build parallelism, because the
  Go wasm backend has no threads.
- Under the CLI, `go` prints `failed to start telemetry sidecar: os.Executable: readlink
  /proc/self/exe: no such file or directory` on every run: `x/telemetry` reads `/proc/self/exe`,
  which exists in the kernel's procfs but has no target, because the CLI starts the module from a
  host path. `GOTELEMETRY=off` does not silence it; only a patched `cmd/go` would. The page does
  not print it, because there `/proc/self/exe` is a target in the guest's own filesystem.
- `go test` of `js/wasm`-style tests that need `wasmexec` will not run; ordinary tests do.
- `cgo` is off; `GOOS=linux` cross builds work (`compile` for `linux/amd64` inside the guest).

## Scripts

| Script | Does |
| --- | --- |
| `build.sh` | kernel, port bootstrap, wasix toolchain, trimmed GOROOT, standard library archives |
| `bundle.sh` | packs the toolchain as the page's package, `web/www/go/go.webc` and its `.gz` |
| `go.sh` | the page's `/usr/local/bin/go`: `GOROOT=/go` and the variables the tab cannot guess |
| `run.sh` | runs one guest program with `GOROOT=/go` and the current directory at `/work` |
| `direct.sh MODULE` | compile and link a module with `compile` and `link` alone, no `cmd/go` |
| `ladder.sh` | `cmd/go`'s subcommands from `version` to `build`, with exit status |
| `probe/*.go` | the kernel measurements: `mmap`, `readat`, `readhigh`, `heap`, `stack`, `deep`, `spawn`, `args`, `readsha`, `churn` |
| `probe/grow.go` | how far linear memory grows: 3.5 GiB of touched pages, then Go's own out-of-memory throw |
| `probe/copystack.go` | a map, a slice, a string and an interface in stack slots across 20000 frames of 4 KiB: every slot intact after the copies |
