#!/bin/bash
# ffmpeg for the browser machine, in /usr/local/bin before the registry's /bin/ffmpeg. It gives
# that ffmpeg the page's audio inputs as PulseAudio devices, which is how clai's audio_sources
# and audio_record find and open inputs on Linux:
#
#   browser-mic           the browser's default microphone (getUserMedia)
#   browser-tab.monitor   the audio of a tab, window or screen the user shares (getDisplayMedia),
#                         the monitor of the sink browser-tab
#   browser-devN          each other audio input of the browser's, by deviceId; on Linux these
#   browser-devN.monitor  include PipeWire's "Monitor of ..." sources, which hold what the
#                         computer plays, a meeting app's audio included (sink browser-devN)
#
# `-sources pulse` and `-sinks pulse` list them as ffmpeg with libpulse does, and
# `-f pulse -i NAME` reads the input's file in /run/audio, raw 48 kHz mono samples that the page
# writes while the file is open. Everything else goes to ffmpeg as it is.
#
# clai stops a recording with SIGINT to the process it started, on which ffmpeg finishes the file.
# This ffmpeg cannot catch signals, so it runs as the wrapper's child, out of the signal's way, and
# the wrapper, on SIGINT or SIGTERM, ends the inputs it gave ffmpeg instead (a write to an
# input's file ends it): ffmpeg reads to their end and finishes the file as it would on SIGINT.

# The page's inputs, from /run/audio/devices: a file name and a label each. One whose label starts
# "Monitor of " (PipeWire's and PulseAudio's name for a sink's monitor, and the shared tab's) is
# the monitor source NAME.monitor of a sink NAME, as on a Linux desktop; the rest are sources.
names=()
labels=()
while IFS=$'\t' read -r name label; do
  names+=("$name")
  labels+=("$label")
done < /run/audio/devices
pulse_name() {
  case $2 in
  "Monitor of "*) echo "browser-$1.monitor" ;;
  *) echo "browser-$1" ;;
  esac
}
# The default sink: the first device's monitor, which plays what the computer plays, or the tab.
default_sink=
for i in "${!names[@]}"; do
  case ${labels[$i]} in "Monitor of "*) [ "${names[$i]}" != tab ] && default_sink=${default_sink:-${names[$i]}} ;; esac
done
default_sink=${default_sink:-tab}

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
    file=
    [ "$4" = default ] && file=/run/audio/mic
    for i in "${!names[@]}"; do
      [ "$(pulse_name "${names[$i]}" "${labels[$i]}")" = "$4" ] && file=/run/audio/${names[$i]}
    done
    if [ -z "$file" ]; then
      echo "[pulse @ browser] pa_simple_new failed: No such entity" >&2
      echo "$4: Input/output error" >&2
      exit 1
    fi
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
  for i in "${!names[@]}"; do
    mark=" "
    [ "${names[$i]}" = mic ] && mark="*"
    echo "$mark $(pulse_name "${names[$i]}" "${labels[$i]}") [${labels[$i]}]"
  done
  exit 0
  ;;
sinks)
  echo "Auto-detected sinks for pulse:"
  for i in "${!names[@]}"; do
    case ${labels[$i]} in
    "Monitor of "*)
      mark=" "
      [ "${names[$i]}" = "$default_sink" ] && mark="*"
      echo "$mark browser-${names[$i]} [${labels[$i]#Monitor of }]"
      ;;
    esac
  done
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
