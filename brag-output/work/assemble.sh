#!/usr/bin/env bash
set -euo pipefail
FF="/c/Users/roles/Documents/dev/ffmpeg"
cd "$(dirname "$0")"

TRIM=trimmed
rm -rf "$TRIM"
mkdir -p "$TRIM"

# name offset duration (must match manifest.json produced by capture.js)
declare -a NAMES=(hook login dashboard alerts portal outro)
declare -A OFFSET
declare -A DUR

# Read manifest.json via node (no jq dependency assumed).
node -e '
const m = require("./manifest.json");
for (const s of m) console.log(s.name + " " + s.offsetSec + " " + s.durationSec);
' > /tmp/manifest.txt 2>/dev/null || node -e '
const m = require("./manifest.json");
for (const s of m) console.log(s.name + " " + s.offsetSec + " " + s.durationSec);
' > manifest.txt

MFILE="manifest.txt"
if [ -f /tmp/manifest.txt ]; then MFILE=/tmp/manifest.txt; fi

while read -r name off dur; do
  OFFSET[$name]=$off
  DUR[$name]=$dur
done < "$MFILE"

for name in "${NAMES[@]}"; do
  src=$(ls captured/$name/*.webm)
  off=${OFFSET[$name]}
  dur=${DUR[$name]}
  echo "Trimming $name: offset=$off dur=$dur src=$src"
  "$FF" -y -ss "$off" -i "$src" -t "$dur" \
    -vf "fps=30,scale=1920:1080:flags=lanczos,format=yuv420p" \
    -an -c:v libx264 -preset veryfast -crf 18 \
    "$TRIM/$name.mp4" -loglevel error
done

echo "Trimmed clips:"
for name in "${NAMES[@]}"; do
  "$FF" -i "$TRIM/$name.mp4" 2>&1 | grep Duration | sed "s/^/  $name: /"
done
