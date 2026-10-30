#!/bin/sh
# Builds ffmpeg and ffprobe for wasm32-wasi with the wasi-sdk: audio only, and without threads,
# so they need no shared memory and run on the machine's one thread. ffmpeg 5.1 is the last
# whose CLI builds without threads.
#
#   build.sh WASI_SDK SOURCE BUILD
#
# WASI_SDK is an unpacked wasi-sdk, SOURCE an unpacked ffmpeg release, BUILD the directory to
# build in; ffmpeg and ffprobe end up there.
set -eu
sdk=$(cd "$1" && pwd)
src=$(cd "$2" && pwd)
mkdir -p "$3"
build=$(cd "$3" && pwd)
here=$(cd "$(dirname "$0")" && pwd)

# configure wants the compiler as one command.
printf '#!/bin/sh\nexec "%s/bin/clang" --target=wasm32-wasi --sysroot="%s/share/wasi-sysroot" "$@"\n' \
  "$sdk" "$sdk" > "$build/wasi-cc"
chmod +x "$build/wasi-cc"

cd "$build"
"$src/configure" --enable-cross-compile --target-os=none --arch=wasm32 \
  --cc="$build/wasi-cc" --ar="$sdk/bin/llvm-ar" --ranlib="$sdk/bin/llvm-ranlib" --nm="$sdk/bin/llvm-nm" \
  --disable-stripping --disable-asm --disable-pthreads --disable-w32threads --disable-os2threads \
  --disable-network --disable-debug --disable-doc --disable-ffplay --disable-autodetect \
  --disable-runtime-cpudetect --disable-swscale --disable-avdevice --disable-postproc \
  --disable-everything \
  --enable-protocol=file,pipe \
  --enable-demuxer=pcm_s16le,pcm_f32le,wav,mp3,ogg,flac,mov,matroska,aac \
  --enable-muxer=wav,segment,null,pcm_s16le,ogg,flac,matroska,mp4 \
  --enable-decoder=pcm_s16le,pcm_f32le,pcm_s24le,pcm_s32le,mp3,mp3float,aac,opus,vorbis,flac \
  --enable-encoder=pcm_s16le,flac \
  --enable-parser=aac,mpegaudio,flac,opus,vorbis \
  --enable-filter=amix,silencedetect,astats,ametadata,aresample,aformat,anull,atrim,volume,anullsrc,apad,concat,adelay,amerge,pan,asplit,aevalsrc,sine \
  --extra-cflags="-O2 -include $here/wasi_compat.h -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS -D_WASI_EMULATED_MMAN" \
  --extra-ldflags="-lwasi-emulated-signal -lwasi-emulated-process-clocks -lwasi-emulated-mman -Wl,-z,stack-size=1048576"
# wasi-libc has termios.h, but not tcgetattr or tcsetattr.
sed 's/#define HAVE_TERMIOS_H 1/#define HAVE_TERMIOS_H 0/' config.h > config.h.new
mv config.h.new config.h
make -j"$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)" ffmpeg ffprobe
