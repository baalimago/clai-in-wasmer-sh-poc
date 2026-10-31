#!/bin/sh
# Packs the toolchain as a webc package the page mounts at /go: `bin/go`, the tools it starts,
# a trimmed GOROOT and the time zone database, in the volume format the page's packages use.
# A `[fs]` volume needs no atom, so `go` is started by its path in the volume, and the tree
# costs one copy, not two.
#
#   web/www/go/go.webc     the package, which the page fetches when it is opened with ?go
#   web/www/go/go.webc.gz  the same, for the server to send with `content-encoding: gzip`
#
# The volume is read-only and every file in it is 0755 (the format stores no modes); GOROOT
# takes no writes, so only the tool's executable bit matters.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
work=${WORK:-$root/.build/go-toolchain}
groot=${GROOT:-$root/.build/groot}
wasmer=${WASMER:-$root/.build/wasmer-target/release/wasmer}
out=${OUT:-$root/web/www/go}
stage=$work/bundle

sh "$here/build.sh"

# The tools and the trimmed tree are what the package holds: when they are the ones it was
# built from, there is nothing to pack.
stamp=$( (md5sum "$groot/bin/go"; md5sum "$groot"/pkg/tool/wasix_wasm/*; cat "$groot/src.trim") \
  | md5sum | cut -d' ' -f1)
if [ -f "$out/go.stamp" ] && [ "$(cat "$out/go.stamp")" = "$stamp" ] && [ -f "$out/go.webc.gz" ]; then
  echo "$out/go.webc.gz is current"
  exit 0
fi

rm -rf "$stage"
mkdir -p "$stage/fs/bin" "$stage/fs/pkg/tool/wasix_wasm" "$stage/fs/pkg/include" \
  "$stage/fs/lib/time" "$out"
cp "$groot/bin/go" "$stage/fs/bin/go"
for tool in compile link asm vet preprofile; do
  cp "$groot/pkg/tool/wasix_wasm/$tool" "$stage/fs/pkg/tool/wasix_wasm/$tool"
done
cp "$groot/pkg/include/"*.h "$stage/fs/pkg/include/"
cp "$groot/lib/time/zoneinfo.zip" "$stage/fs/lib/time/"
cp -a "$groot/src" "$stage/fs/src"

cat > "$stage/wasmer.toml" <<'EOF'
[package]
name = "clai/go"
version = "1.26.10"

[fs]
"/go" = "fs"
EOF

rm -f "$out/go.webc" "$out/go.webc.gz"
"$wasmer" package build "$stage" --out "$out/go.webc" >/dev/null
gzip -9 "$out/go.webc"
printf '%s\n' "$stamp" > "$out/go.stamp"
ls -l "$out/go.webc.gz"