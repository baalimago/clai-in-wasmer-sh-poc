#!/bin/sh
# Runs a wasix program on the fork's wasmer CLI, with the current directory at the guest's
# /work, GOROOT at /go and GOCACHE and TMPDIR under .build/go-toolchain/state.
#   sh research/go-toolchain/run.sh version
#   BIN=$PWD/.build/groot/pkg/tool/wasix_wasm/compile sh research/go-toolchain/run.sh -V=full
#
# BIN is a host path: the CLI loads the module from the host and the volumes only decide what
# the guest sees, with $GROOT at /go.
set -eu

root=$(cd "$(dirname "$0")/../.." && pwd)
work=${WORK:-$root/.build/go-toolchain}
groot=${GROOT:-$root/.build/groot}
wasmer=${WASMER:-$root/.build/wasmer-target/release/wasmer}
bin=${BIN:-$groot/bin/go}
cwd=${CWD:-/work}

mkdir -p "$work/state/home" "$work/state/cache" "$work/state/tmp"
exec "$wasmer" run --no-tty \
  --volume "$groot:/go" --volume "$work/state:/state" --volume "$PWD:/work" --cwd "$cwd" \
  --env GOROOT=/go --env GOCACHE=/state/cache \
  --env GOFLAGS=-buildvcs=false --env GOTOOLCHAIN=local --env CGO_ENABLED=0 \
  --env GOOS=wasix --env GOARCH=wasm --env TMPDIR=/state/tmp \
  "$bin" -- "$@"