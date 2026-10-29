# `make poc` builds the Go port, clai for it, and the page's WASIX v2 machine, then serves the
# page and opens it. See README.md for what each piece is.

GO := $(CURDIR)/components/go/bin/go
WEB := $(CURDIR)/web
WWW := $(WEB)/www
WASM_BINDGEN_VERSION := 0.2.129
WASM_BINDGEN := $(CURDIR)/.tools/bin/wasm-bindgen

.PHONY: poc serve check build submodules clean FORCE

poc: build
	cd $(WEB) && node server.mjs --open

serve: build
	cd $(WEB) && node server.mjs

# Headless: runs `clai h` and `clai help` in the page and checks what they print.
check: build
	cd $(WEB) && npx playwright install chromium && npm test

build: $(WWW)/clai.wasm $(WWW)/ca-certificates.crt $(WWW)/pkg/clai_web.js $(WEB)/node_modules

submodules:
	git submodule update --init --depth 1

$(GO): | submodules
	cd components/go/src && ./make.bash

$(WWW)/clai.wasm: $(GO) FORCE | submodules
	cd components/clai && GOTOOLCHAIN=local GOOS=wasix GOARCH=wasm $(GO) build -o $@ .

# The roots the guest's TLS clients trust: Mozilla's, as the Node.js that serves the page bundles
# them. The machine mounts them at /etc/ssl/certs/ca-certificates.crt.
$(WWW)/ca-certificates.crt:
	node -e 'process.stdout.write(require("tls").rootCertificates.join("\n") + "\n")' > $@

$(WWW)/pkg/clai_web.js: $(WASM_BINDGEN) FORCE | submodules
	cd $(WEB) && cargo build --release --target wasm32-unknown-unknown
	$(WASM_BINDGEN) --target web --out-dir $(WWW)/pkg \
		$(WEB)/target/wasm32-unknown-unknown/release/clai_web.wasm

$(WASM_BINDGEN):
	cargo install wasm-bindgen-cli --version $(WASM_BINDGEN_VERSION) --locked --root $(CURDIR)/.tools

$(WEB)/node_modules: $(WEB)/package-lock.json
	cd $(WEB) && npm ci
	touch $@

clean:
	rm -rf $(WEB)/target $(WWW)/pkg $(WWW)/clai.wasm $(WWW)/ca-certificates.crt $(WEB)/node_modules .tools
	cd components/go/src && ./clean.bash
