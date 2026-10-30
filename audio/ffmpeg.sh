#!/bin/bash
# ffmpeg for the browser machine, in /usr/local/bin before the registry's /bin/ffmpeg. It gives
# that ffmpeg the page's audio inputs as PulseAudio devices, which is how clai's audio_sources
# and audio_record find and open inputs on Linux:
#
#   browser-mic           the microphone (getUserMedia)
#   browser-tab.monitor   the audio of a tab, window or screen the user shares (getDisplayMedia),
#                         the monitor of the sink browser-tab
#
# `-sources pulse` and `-sinks pulse` list them as ffmpeg with libpulse does, and
# `-f pulse -i NAME` reads the input's file in /run/audio, raw 48 kHz mono samples that the page
# writes while the file is open. Everything else goes to ffmpeg as it is.
#
# clai stops a recording with SIGINT to the process it started, on which ffmpeg finishes the file.
# This ffmpeg cannot catch signals, so it runs as the wrapper's child, out of the signal's way, and
# the wrapper, on SIGINT or SIGTERM, ends the inputs it gave ffmpeg instead (a write to an
# input's file ends it): ffmpeg reads to their end and finishes the file as it would on SIGINT.

list=
args=()
inputs=()
while [ $# -gt 0 ]; do
  if [ "$2" = pulse ] && { [ "$1" = -sources ] || [ "$1" = -sinks ]; }; then
    list=${1#-}
    shift 2
    continue
  fi
  if [ "$1" = -f ] && [ "$2" = pulse ] && [ "$3" = -i ]; then
    case $4 in
    browser-mic | default) file=/run/audio/mic ;;
    browser-tab.monitor) file=/run/audio/tab ;;
    *)
      echo "[pulse @ browser] pa_simple_new failed: No such entity" >&2
      echo "$4: Input/output error" >&2
      exit 1
      ;;
    esac
    args+=(-f s16le -ar 48000 -ac 1 -i "$file")
    inputs+=("$file")
    shift 4
    continue
  fi
  args+=("$1")
  shift
done

case $list in
sources)
  echo "Auto-detected sources for pulse:"
  echo "* browser-mic [Microphone (browser)]"
  echo "  browser-tab.monitor [Monitor of Shared tab or screen (browser)]"
  exit 0
  ;;
sinks)
  echo "Auto-detected sinks for pulse:"
  echo "* browser-tab [Shared tab or screen (browser)]"
  exit 0
  ;;
esac

if [ ${#inputs[@]} -eq 0 ]; then
  exec /bin/ffmpeg "${args[@]}"
fi

stop() {
  for file in "${inputs[@]}"; do
    printf end > "$file"
  done
}
trap stop INT TERM
/bin/ffmpeg "${args[@]}" &
ffmpeg=$!
# A trapped signal ends `wait` early; wait again for ffmpeg to finish.
while ! wait $ffmpeg; do
  status=$?
  kill -0 $ffmpeg 2>/dev/null || exit $status
done
