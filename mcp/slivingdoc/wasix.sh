#!/bin/bash
# Prepares slivingdoc's build for the wasix Go port without changing its checkout:
#   wasix.sh <go> <slivingdoc checkout> <output dir>
# writes into the output dir
#   - xsys: golang.org/x/sys with wasix support. wasix is linux/loong64's types and asm-generic
#     system calls with the riscv32 numbers (see the port's syscall package), so x/sys's loong64
#     files serve, renamed and renumbered;
#   - go.work, which builds the checkout with that xsys;
#   - overlay.json, for `go build -overlay`, which adds this directory's wasix files to it.
set -euo pipefail
go=$1 mod=$(cd "$2" && pwd) out=$3
here=$(cd "$(dirname "$0")" && pwd)

orig=$(cd "$mod" && GOTOOLCHAIN=local "$go" list -m -f '{{.Dir}}' golang.org/x/sys)
portsys=$("$go" env GOROOT)/src/syscall
rm -rf "$out"
mkdir -p "$out"
out=$(cd "$out" && pwd)
cp -r "$orig" "$out/xsys"
chmod -R u+w "$out/xsys"
x=$out/xsys

for f in zerrors ztypes zsyscall syscall; do
  sed 's/^\/\/go:build .*$/\/\/go:build linux \&\& wasm/' "$x/unix/${f}_linux_loong64.go" >"$x/unix/${f}_linux_wasm.go"
done

# The port's numbers, under loong64's names where riscv32 has only the 64-bit-time or
# 64-bit-offset variant.
{
  printf '//go:build wasm && linux\n\npackage unix\n\nconst (\n'
  grep -oE 'SYS_[A-Z0-9_]+ += [0-9]+' "$x/unix/zsysnum_linux_loong64.go" | while read -r name _ _; do
    for alias in "$name" "${name}64" "${name}_TIME64" "${name}_64" "SYS_${name#SYS_NEW}"; do
      n=$(grep -oE "^\s*$alias += [0-9]+" "$portsys/zsysnum_wasix_wasm.go" | grep -oE '[0-9]+$' || true)
      if [ -n "$n" ]; then
        printf '\t%s = %s\n' "$name" "$n"
        break
      fi
    done
  done
  printf ')\n'
} >"$x/unix/zsysnum_linux_wasm.go"

cp "$here/xsys/syscall_linux_wasm_gc.go" "$x/unix/"

# Build constraints that leave wasm out, or take it in twice.
retag() { sed -i "s/^\/\/go:build .*$/\/\/go:build $2/" "$x/$1"; }
retag unix/endian_little.go '386 || amd64 || amd64p32 || alpha || arm || arm64 || loong64 || mipsle || mips64le || mips64p32le || nios2 || ppc64le || riscv || riscv64 || sh || wasm'
retag unix/syscall_unix_gc.go '(darwin || dragonfly || freebsd || (linux \&\& !ppc64 \&\& !ppc64le \&\& !wasm) || netbsd || openbsd || solaris) \&\& gc'
retag unix/syscall_linux_gc.go 'linux \&\& gc \&\& !wasm'
retag cpu/cpu_linux.go '!386 \&\& !amd64 \&\& !amd64p32 \&\& !arm64 \&\& !wasm'
retag cpu/cpu_linux_noinit.go 'linux \&\& !arm \&\& !arm64 \&\& !loong64 \&\& !mips64 \&\& !mips64le \&\& !ppc64 \&\& !ppc64le \&\& !s390x \&\& !riscv64 \&\& !wasm'

goversion=$(sed -n 's/^go //p' "$mod/go.mod")
printf 'go %s\n\nuse %s\n\nreplace golang.org/x/sys => ./xsys\n' "$goversion" "$mod" >"$out/go.work"

cat >"$out/overlay.json" <<JSON
{"Replace": {
  "$mod/internal/git2/native_wasix.go": "$here/native_wasix.go",
  "$mod/stdin_wasix.go": "$here/stdin_wasix.go"
}}
JSON
