#!/bin/sh
# Compiles and links a module with the toolchain alone: compile and link on the kernel, the
# standard library from the precompiled archives, the import graph from the port's own list.
# This is what a page's driver would run, since cmd/go does not survive the kernel yet.
#   sh research/go-toolchain/direct.sh .build/go-toolchain/hello
set -eu

here=$(cd "$(dirname "$0")" && pwd)
mod=$(cd "${1:?usage: direct.sh MODULE_DIR}" && pwd)
root=$(cd "$here/../.." && pwd)
work=${WORK:-$root/.build/go-toolchain}
groot=${GROOT:-$root/.build/groot}
port=${GO_SRC:-$root/components/go}
run="sh $here/run.sh"

sh "$here/build.sh"

cd "$mod"
module=$(sed -n 's/^module //p' go.mod)
GOOS=wasix GOARCH=wasm GOTOOLCHAIN=local "$port/bin/go" list -deps -export \
  -f '{{.ImportPath}}|{{.Export}}' . > "$mod/deps.txt"
: > "$mod/importcfg"
while IFS='|' read -r path archive; do
  [ "$path" = "$module" ] && continue
  file=/go/pkg/wasix_wasm/$(printf '%s' "$path" | tr / _).a
  printf 'packagefile %s=%s\n' "$path" "$file" >> "$mod/importcfg"
done < "$mod/deps.txt"

BIN=$groot/pkg/tool/wasix_wasm/compile sh "$here/run.sh" -o hello.a -p main -complete \
  -buildid= -importcfg importcfg -pack main.go
BIN=$groot/pkg/tool/wasix_wasm/link sh "$here/run.sh" -o hello.wasm -importcfg importcfg \
  -buildmode=exe hello.a
ls -l hello.a hello.wasm