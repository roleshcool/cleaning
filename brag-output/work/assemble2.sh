#!/usr/bin/env bash
set -euo pipefail
FF="/c/Users/roles/Documents/dev/ffmpeg"
cd "$(dirname "$0")"

d() { "$FF" -i "trimmed/$1.mp4" 2>&1 | grep -oP "Duration: \K[0-9:.]+" | \
  awk -F: '{print ($1*3600)+($2*60)+$3}'; }

D_HOOK=$(d hook); D_LOGIN=$(d login); D_DASH=$(d dashboard)
D_ALERT=$(d alerts); D_PORTAL=$(d portal); D_OUTRO=$(d outro)
echo "durations: hook=$D_HOOK login=$D_LOGIN dashboard=$D_DASH alerts=$D_ALERT portal=$D_PORTAL outro=$D_OUTRO"

T=0.3
OFF1=$(echo "$D_HOOK - $T" | bc)
LEN1=$(echo "$D_HOOK + $D_LOGIN - $T" | bc)
OFF2=$(echo "$LEN1 - $T" | bc)
LEN2=$(echo "$LEN1 + $D_DASH - $T" | bc)
OFF3=$(echo "$LEN2 - $T" | bc)
LEN3=$(echo "$LEN2 + $D_ALERT - $T" | bc)
OFF4=$(echo "$LEN3 - $T" | bc)
LEN4=$(echo "$LEN3 + $D_PORTAL - $T" | bc)
OFF5=$(echo "$LEN4 - $T" | bc)
LEN5=$(echo "$LEN4 + $D_OUTRO - $T" | bc)
echo "offsets: $OFF1 $OFF2 $OFF3 $OFF4 $OFF5 | final=$LEN5"

"$FF" -y \
  -i trimmed/hook.mp4 -i trimmed/login.mp4 -i trimmed/dashboard.mp4 \
  -i trimmed/alerts.mp4 -i trimmed/portal.mp4 -i trimmed/outro.mp4 \
  -i audio/brag-audio.wav \
  -filter_complex "\
[0:v][1:v]xfade=transition=fadeblack:duration=${T}:offset=${OFF1}[v01]; \
[v01][2:v]xfade=transition=fadewhite:duration=${T}:offset=${OFF2}[v012]; \
[v012][3:v]xfade=transition=fadewhite:duration=${T}:offset=${OFF3}[v0123]; \
[v0123][4:v]xfade=transition=fadewhite:duration=${T}:offset=${OFF4}[v01234]; \
[v01234][5:v]xfade=transition=fadeblack:duration=${T}:offset=${OFF5}[vout]; \
[vout]format=yuv420p[vfinal]" \
  -map "[vfinal]" -map 6:a \
  -c:v libx264 -preset veryfast -crf 18 -r 30 \
  -c:a aac -b:a 192k -shortest \
  brag-raw.mp4 -loglevel warning -stats

echo done
"$FF" -i brag-raw.mp4 2>&1 | grep Duration
