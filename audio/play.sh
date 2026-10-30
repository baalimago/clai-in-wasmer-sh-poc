#!/bin/bash
# play FILE...: plays sound files in the page, one player each, by writing them to
# /run/audio/play, which hands what it is given to the page once closed. The browser decodes
# them, so WAV, MP3, Ogg, FLAC and M4A all play.

if [ $# -eq 0 ]; then
  echo "usage: play FILE..." >&2
  exit 2
fi
for file in "$@"; do
  if [ ! -f "$file" ]; then
    echo "play: $file is not a file" >&2
    exit 1
  fi
  cat -- "$file" > /run/audio/play || exit
  echo "play: $file is in the player at the bottom right" >&2
done
