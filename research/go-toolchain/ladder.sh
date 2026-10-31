#!/bin/sh
# Runs cmd/go's subcommands from the cheapest to `go build`, to show where it stops surviving
# the kernel. Each row is the guest's exit status and the first line it printed.
#   sh research/go-toolchain/ladder.sh
set -eu

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
work=${WORK:-$root/.build/go-toolchain}
mod=$work/hello

sh "$here/build.sh"
mkdir -p "$mod"
[ -f "$mod/go.mod" ] || printf 'module hello\n\ngo 1.26\n' > "$mod/go.mod"
[ -f "$mod/main.go" ] || printf 'package main\n\nimport "fmt"\n\nfunc main() { fmt.Println("hello from wasix") }\n' > "$mod/main.go"
cd "$mod"

run() {
  out=$(timeout 300 sh "$here/run.sh" "$@" 2>&1) || status=$?
  # `cmd/go` looks for the executable it runs, /proc/self/exe, which has no target here.
  out=$(printf '%s\n' "$out" | grep -v 'failed to start telemetry sidecar' || true)
  first=$(printf '%s' "$out" | head -1)
  printf '%-28s exit=%-3s %s\n' "$*" "${status:-0}" "${first:-(no output)}"
  status=
}

run version
run env GOROOT
run list -m
run list .
run list -deps .
run build -p 1 -o hello.wasm .