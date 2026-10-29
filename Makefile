# `make poc` builds the Go port, clai and the MCP server ports for it, and the page's WASIX v2
# machine, downloads the registry packages the machine's /bin holds, then serves the page and
# opens it. See README.md for what each piece is.

GO := $(CURDIR)/components/go/bin/go
WEB := $(CURDIR)/web
WWW := $(WEB)/www
WASM_BINDGEN_VERSION := 0.2.129
WASM_BINDGEN := $(CURDIR)/.tools/bin/wasm-bindgen

.PHONY: poc serve check build packages submodules clean FORCE

poc: build
	cd $(WEB) && node server.mjs --open

serve: build
	cd $(WEB) && node server.mjs

# Headless: runs `clai h`, `clai help`, shell lines and an MCP server in the page and checks what
# they print.
check: build
	cd $(WEB) && npx playwright install chromium && npm test

build: $(WWW)/clai.wasm $(WWW)/bin/index.json $(WWW)/ca-certificates.crt $(WWW)/pkg/clai_web.js \
	$(WWW)/packages/index.json $(WEB)/node_modules

submodules:
	git submodule update --init --depth 1

$(GO): | submodules
	cd components/go/src && ./make.bash

$(WWW)/clai.wasm: $(GO) FORCE | submodules
	cd components/clai && GOTOOLCHAIN=local GOOS=wasix GOARCH=wasm $(GO) build -o $@ .

# The MCP servers' ports, which the machine's npx and uvx (mcp/launcher.sh) start, in /bin with
# them. index.json lists them for the page's worker.
MCP_PORTS := duckduckgo-mcp-server
LAUNCHERS := npx uvx

$(WWW)/bin/%.wasm: $(GO) FORCE
	@mkdir -p $(@D)
	cd mcp/$* && GOTOOLCHAIN=local GOOS=wasix GOARCH=wasm $(GO) build -o $@ .

$(WWW)/bin/launcher.sh: mcp/launcher.sh
	@mkdir -p $(@D)
	cp $< $@

$(WWW)/bin/index.json: $(MCP_PORTS:%=$(WWW)/bin/%.wasm) $(WWW)/bin/launcher.sh
	node -e 'const [ports, launchers] = process.argv.slice(1).map((s) => s.split(" ")); console.log(JSON.stringify([...ports.map((name) => ({ name, file: `bin/$${name}.wasm` })), ...launchers.map((name) => ({ name, file: "bin/launcher.sh" }))], null, 2))' \
		"$(MCP_PORTS)" "$(LAUNCHERS)" > $@

# The roots the guest's TLS clients trust: Mozilla's, as the Node.js that serves the page bundles
# them. The machine mounts them at /etc/ssl/certs/ca-certificates.crt.
$(WWW)/ca-certificates.crt:
	node -e 'process.stdout.write(require("tls").rootCertificates.join("\n") + "\n")' > $@

# bash, coreutils and the rest, from registry.wasmer.io: web/packages.txt lists them.
packages: $(WWW)/packages/index.json

$(WWW)/packages/index.json: $(WEB)/packages.txt $(WEB)/fetch-packages.mjs
	cd $(WEB) && node fetch-packages.mjs

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
	rm -rf $(WEB)/target $(WWW)/pkg $(WWW)/packages $(WWW)/bin $(WWW)/clai.wasm $(WWW)/ca-certificates.crt $(WEB)/node_modules .tools
	cd components/go/src && ./clean.bash
