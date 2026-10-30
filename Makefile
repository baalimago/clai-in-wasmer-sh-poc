# `make poc` builds the Go port, clai and the MCP server ports for it, slivingdoc with libgit2,
# and the page's WASIX v2 machine, downloads the registry packages the machine's /bin holds, then serves the page and
# opens it. See README.md for what each piece is.

GO := $(CURDIR)/components/go/bin/go
WEB := $(CURDIR)/web
WWW := $(WEB)/www
WASM_BINDGEN_VERSION := 0.2.129
WASM_BINDGEN := $(CURDIR)/.tools/bin/wasm-bindgen
BUILD := $(CURDIR)/.build

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

# The MCP servers, which the machine's npx and uvx (mcp/launcher.sh) start, in /bin with them,
# and the programs they start. index.json lists them for the page's worker.
PROGRAMS := duckduckgo-mcp-server mcp-server-filesystem slivingdoc slivingdoc-git2
LAUNCHERS := npx uvx

$(WWW)/bin/%.wasm: $(GO) FORCE
	@mkdir -p $(@D)
	cd mcp/$* && GOTOOLCHAIN=local GOOS=wasix GOARCH=wasm $(GO) build -o $@ .

# slivingdoc itself, from its release, with mcp/slivingdoc's wasix files laid over it: its
# libgit2 calls go to slivingdoc-git2.
# components/slivingdoc's release tag.
SLIVINGDOC_VERSION := 1.3.1

$(WWW)/bin/slivingdoc.wasm: $(GO) mcp/slivingdoc/wasix.sh FORCE | submodules
	@mkdir -p $(@D)
	mcp/slivingdoc/wasix.sh $(GO) components/slivingdoc $(BUILD)/slivingdoc
	cd components/slivingdoc && GOWORK=$(BUILD)/slivingdoc/go.work GOTOOLCHAIN=local GOOS=wasix GOARCH=wasm \
		$(GO) build -overlay $(BUILD)/slivingdoc/overlay.json \
		-ldflags "-X github.com/baalimago/slivingdoc/internal/app.Version=$(SLIVINGDOC_VERSION)" -o $@ .

# slivingdoc's libgit2 release, compiled to WASI with the wasi-sdk, and the helper that runs it.
WASI_SDK_VERSION := 25
WASI_SDK_HOST := $(subst aarch64,arm64,$(shell uname -m))-$(subst darwin,macos,$(shell uname -s | tr A-Z a-z))
WASI_SDK := $(CURDIR)/.tools/wasi-sdk-$(WASI_SDK_VERSION).0-$(WASI_SDK_HOST)
WASI_COMPAT := $(CURDIR)/mcp/slivingdoc/git2/wasi
WASI_CFLAGS := -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS -D_WASI_EMULATED_GETPID \
	-I$(WASI_COMPAT) -include $(WASI_COMPAT)/compat.h
LIBGIT2 := $(BUILD)/libgit2

$(WASI_SDK):
	@mkdir -p $(@D)
	curl -fsSL https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-$(WASI_SDK_VERSION)/$(notdir $@).tar.gz \
		| tar xz -C $(@D)

$(LIBGIT2)/lib/libgit2.a: $(WASI_SDK) $(wildcard $(WASI_COMPAT)/*.h) | submodules
	cmake -S components/libgit2 -B $(LIBGIT2)/build -DCMAKE_BUILD_TYPE=Release \
		-DCMAKE_TOOLCHAIN_FILE=$(WASI_SDK)/share/cmake/wasi-sdk.cmake -DWASI_SDK_PREFIX=$(WASI_SDK) \
		-DCMAKE_C_FLAGS="-DNO_MMAP $(WASI_CFLAGS)" -DCMAKE_INSTALL_PREFIX=$(LIBGIT2) \
		-DBUILD_SHARED_LIBS=OFF -DBUILD_TESTS=OFF -DBUILD_CLI=OFF -DBUILD_EXAMPLES=OFF -DBUILD_FUZZERS=OFF \
		-DUSE_SSH=OFF -DUSE_HTTPS=OFF -DUSE_NTLMCLIENT=OFF -DUSE_GSSAPI=OFF -DUSE_THREADS=OFF \
		-DUSE_BUNDLED_ZLIB=ON -DREGEX_BACKEND=builtin
	cmake --build $(LIBGIT2)/build --parallel
	cmake --install $(LIBGIT2)/build

$(WWW)/bin/slivingdoc-git2.wasm: mcp/slivingdoc/git2/helper.c $(WASI_COMPAT)/wasi.c $(LIBGIT2)/lib/libgit2.a
	@mkdir -p $(@D)
	$(WASI_SDK)/bin/clang --sysroot=$(WASI_SDK)/share/wasi-sysroot -O2 -Wall $(WASI_CFLAGS) -I$(LIBGIT2)/include \
		mcp/slivingdoc/git2/helper.c $(WASI_COMPAT)/wasi.c -L$(LIBGIT2)/lib -lgit2 \
		-lwasi-emulated-signal -lwasi-emulated-process-clocks -lwasi-emulated-getpid -o $@

$(WWW)/bin/launcher.sh: mcp/launcher.sh
	@mkdir -p $(@D)
	cp $< $@

# Wrappers in /usr/local/bin, which comes before /bin on PATH: ffmpeg gives /bin/ffmpeg the
# page's audio inputs as PulseAudio devices (audio/ffmpeg.sh); play plays sound files in the page
# (audio/play.sh).
WRAPPERS := ffmpeg play

# ffmpeg and ffprobe for wasm32-wasi, built with the wasi-sdk from an ffmpeg release: audio only
# and without threads (audio/ffmpeg/build.sh). Both are in /bin.
FFMPEG_VERSION := 5.1.6
FFMPEG_SHA256 := f4fa066278f7a47feab316fef905f4db0d5e9b589451949740f83972b30901bd
FFMPEG_SRC := $(CURDIR)/.tools/ffmpeg-$(FFMPEG_VERSION)
FFMPEG_BUILD := $(BUILD)/ffmpeg
SHA256 := $(shell command -v sha256sum || echo shasum -a 256)

$(FFMPEG_SRC)/configure:
	mkdir -p $(FFMPEG_SRC)
	curl -fsSL https://ffmpeg.org/releases/ffmpeg-$(FFMPEG_VERSION).tar.xz -o $(FFMPEG_SRC).tar.xz
	echo "$(FFMPEG_SHA256)  $(FFMPEG_SRC).tar.xz" | $(SHA256) -c -
	tar xJf $(FFMPEG_SRC).tar.xz -C $(FFMPEG_SRC) --strip-components 1
	rm $(FFMPEG_SRC).tar.xz

$(FFMPEG_BUILD)/ffmpeg: $(WASI_SDK) $(FFMPEG_SRC)/configure audio/ffmpeg/build.sh audio/ffmpeg/wasi_compat.h
	audio/ffmpeg/build.sh $(WASI_SDK) $(FFMPEG_SRC) $(FFMPEG_BUILD)

$(WWW)/bin/ffmpeg.wasm $(WWW)/bin/ffprobe.wasm: $(FFMPEG_BUILD)/ffmpeg
	@mkdir -p $(@D)
	cp $(FFMPEG_BUILD)/$(basename $(@F)) $@

$(WWW)/bin/%.sh: audio/%.sh
	@mkdir -p $(@D)
	cp $< $@

BUILT := $(PROGRAMS) ffmpeg ffprobe

$(WWW)/bin/index.json: $(BUILT:%=$(WWW)/bin/%.wasm) $(WWW)/bin/launcher.sh $(WRAPPERS:%=$(WWW)/bin/%.sh)
	node -e 'const [built, launchers, wrappers] = process.argv.slice(1).map((s) => s.split(" ")); console.log(JSON.stringify([...built.map((name) => ({ name, file: `bin/$${name}.wasm` })), ...launchers.map((name) => ({ name, file: "bin/launcher.sh" })), ...wrappers.map((name) => ({ name, file: `bin/$${name}.sh`, dir: "/usr/local/bin" }))], null, 2))' \
		"$(BUILT)" "$(LAUNCHERS)" "$(WRAPPERS)" > $@

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
	rm -rf $(WEB)/target $(WWW)/pkg $(WWW)/packages $(WWW)/bin $(WWW)/clai.wasm $(WWW)/ca-certificates.crt $(WEB)/node_modules .tools .build
	cd components/go/src && ./clean.bash
