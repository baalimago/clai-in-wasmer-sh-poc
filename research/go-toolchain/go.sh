#!/bin/sh
# /usr/local/bin/go: the Go toolchain, which the page mounts at /go from the package
# research/go-toolchain/bundle.sh packs, when the page is opened with ?go.
[ -x /go/bin/go ] || {
  echo "go: no toolchain in this page; open it with ?go" >&2
  exit 127
}
GOROOT=/go
# No toolchain downloads (a linux/amd64 toolchain cannot run here) and no VCS stamping (no git in
# the module's directory). The cache is in the tab's home, so the second build reuses the first.
GOTOOLCHAIN=local
GOFLAGS=-buildvcs=false
# The port's `go env` carries no defaults for these two, so a module outside the standard library
# fails with "GOPROXY list is not the empty string, but contains no entries". An export wins.
GOPROXY=${GOPROXY:-https://proxy.golang.org}
GOSUMDB=${GOSUMDB:-sum.golang.org}
export GOROOT GOTOOLCHAIN GOFLAGS GOPROXY GOSUMDB
exec /go/bin/go "$@"