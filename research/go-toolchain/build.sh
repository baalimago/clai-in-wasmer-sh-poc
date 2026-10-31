#!/bin/sh
# Builds what runs Go on the wasixv2 kernel: the fork's wasmer CLI, the Go port's own
# toolchain, a trimmed GOROOT, and the standard library as wasix archives. A second run is a
# no-op.
#
#   .build/wasmer-target/release/wasmer           the kernel
#   .build/go-toolchain/groot/bin/go               cmd/go for wasix/wasm
#   .build/go-toolchain/groot/pkg/tool/wasix_wasm  compile, link, asm for wasix/wasm
#   .build/go-toolchain/groot/pkg/wasix_wasm/*.a   the standard library, precompiled
#
# Needs Go on PATH to bootstrap the port, and Rust 1.96 (rustup reads web/rust-toolchain.toml).
set -eu

root=$(cd "$(dirname "$0")/../.." && pwd)
here=$(cd "$(dirname "$0")" && pwd)
work=${WORK:-$root/.build/go-toolchain}
groot=${GROOT:-$root/.build/groot}
src=${GO_SRC:-$root/components/go}
target=${CARGO_TARGET_DIR:-$root/.build/wasmer-target}
wasmer=${WASMER:-$target/release/wasmer}

# The toolchain's mmap users corrupt the guest's Go heap on this kernel (README), so all of them
# read instead. Applied once; the patch is idempotent by its first hunk.
if ! grep -q 'unix && !wasix' "$src/src/cmd/compile/internal/base/mapfile_mmap.go"; then
  git -C "$src" apply "$here/patches/wasix-no-mmap.patch"
fi
# Everything below depends on the patch: binaries and archives built before it are poisoned, and
# a GOCACHE that holds their entries corrupts builds that reuse them (README, "Stale artefacts").
# The toolchain builds are cache hits once nothing changed, so they always run.

if [ ! -x "$wasmer" ]; then
  mkdir -p "$work"
  [ -d "$work/wasmer" ] || git clone --depth 1 https://github.com/baalimago/wasmer.git "$work/wasmer"
  cd "$work/wasmer"
  git submodule update --init --depth 1 lib/wasixv2/codegen lib/napi
  CARGO_TARGET_DIR=$target cargo build --release -p wasmer-cli --features cranelift
fi

if [ ! -x "$src/bin/go" ]; then
  cd "$src/src" && GOROOT_BOOTSTRAP=$(command -v go) ./make.bash
fi

mkdir -p "$groot/bin" "$groot/pkg/tool/wasix_wasm" "$groot/pkg/include" "$groot/lib/time"
cd "$src/src"
GOOS=wasix GOARCH=wasm GOTOOLCHAIN=local ../bin/go build -o "$groot/bin/go" cmd/go
for tool in compile link asm vet preprofile; do
  GOOS=wasix GOARCH=wasm GOTOOLCHAIN=local ../bin/go build \
    -o "$groot/pkg/tool/wasix_wasm/$tool" "cmd/$tool"
done

if [ "$(cat "$groot/src.trim" 2>/dev/null)" != full-v1 ]; then
  rm -rf "$groot/src"
  # Everything but the toolchain's own sources, its tests and its test data: `//go:embed` pulls
  # data files (`internal/trace`'s viewer) and the assembler includes `.h` files
  # (`runtime/asm_wasm.s`'s `go_tls.h`), so a source-only tree does not build the standard
  # library.
  rsync -a --exclude='cmd/' --exclude='*_test.go' --exclude='testdata/' \
    "$src/src/" "$groot/src/"
  find "$groot/src" -name '*_test.go' -delete
  rm -rf "$groot/src/cmd"
  find "$groot/src" -type d -name testdata -prune -exec rm -rf {} +
  cp "$src/pkg/include/"*.h "$groot/pkg/include/"
  cp "$src/lib/time/zoneinfo.zip" "$groot/lib/time/"
  printf 'full-v1\n' > "$groot/src.trim"
fi

# `go install` copies no libraries since Go 1.18, so take the archives the build wrote to the
# cache, flat, named by import path: packagefile lines in an importcfg map them back. The stamp
# is the compiler they were built with: a rebuilt compiler makes them stale.
stamp=$(md5sum "$groot/pkg/tool/wasix_wasm/compile" | cut -d' ' -f1)
if [ "$(cat "$groot/pkg/wasix_wasm.stamp" 2>/dev/null)" != "$stamp" ]; then
  mkdir -p "$groot/pkg/wasix_wasm"
  rm -f "$groot"/pkg/wasix_wasm/*.a
  cd "$src/src"
  GOOS=wasix GOARCH=wasm GOTOOLCHAIN=local ../bin/go list -export \
    -f '{{.ImportPath}}|{{.Export}}' std > "$work/std.txt"
  while IFS='|' read -r path archive; do
    [ -n "$archive" ] || continue
    cp "$archive" "$groot/pkg/wasix_wasm/$(printf '%s' "$path" | tr / _).a"
  done < "$work/std.txt"
  printf '%s\n' "$stamp" > "$groot/pkg/wasix_wasm.stamp"
fi