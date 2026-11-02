#!/bin/sh
# /usr/local/bin/go: the Go toolchain, which the page mounts at /go from the package
# research/go-toolchain/bundle.sh packs, when the page is opened with ?go.
[ -x /go/bin/go ] || {
  echo "go: no toolchain in this page; open it with ?go" >&2
  exit 127
}
GOROOT=/go
# No toolchain downloads (a linux/amd64 toolchain cannot run here) and no VCS stamping (no git in
# the module's directory).
GOTOOLCHAIN=local
GOFLAGS=-buildvcs=false
# The port's `go env` carries no defaults for these two, so a module outside the standard library
# fails with "GOPROXY list is not the empty string, but contains no entries". An export wins.
GOPROXY=${GOPROXY:-https://proxy.golang.org}
GOSUMDB=${GOSUMDB:-sum.golang.org}
# The cache starts with the standard library compiled (bundle.sh), so a first build compiles only
# the module's own packages. /go is a copy-on-write layer, so builds add to it in the tab.
GOCACHE=${GOCACHE:-/go/cache}
# The compiler spends a fifth of its time collecting garbage on wasm, where no other core runs the
# collector: collect only near 1 GiB. A clai build takes 26% less (125 s to 93 s). Programs that
# `go run` and `go test` start inherit both; an export wins.
GOGC=${GOGC:-off}
GOMEMLIMIT=${GOMEMLIMIT:-1GiB}
export GOROOT GOTOOLCHAIN GOFLAGS GOPROXY GOSUMDB GOCACHE GOGC GOMEMLIMIT
exec /go/bin/go "$@"