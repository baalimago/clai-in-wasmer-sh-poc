#!/bin/sh
# Builds a one-file module with the wasix toolchain under the kernel, and shows the heap
# corruption that `go build` hits: `fatal error: found bad pointer in Go heap` or one of the
# variants the README lists. `compile` alone on a file with no imports succeeds, so this is the
# first command that breaks.
#   sh research/go-toolchain/reproduce.sh
set -eu

here=$(cd "$(dirname "$0")" && pwd)
dir=${WORK:-/tmp/go-toolchain}/hello

mkdir -p "$dir"
cd "$dir"
printf 'module hello\n\ngo 1.26\n' > go.mod
printf 'package main\n\nimport "fmt"\n\nfunc main() { fmt.Println("hello from wasix") }\n' > main.go

sh "$here/run.sh" build -p 1 -o hello.wasm .