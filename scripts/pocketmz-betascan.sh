#!/bin/bash
# Static pre-launch scan: can the β runtime (no browser) play this game? Read-only on the game folder.
# Usage: pocketmz-betascan.sh <original game dir>
# Prints one line with the reason when β cannot (exit 1), nothing and exit 0 when no problem is found.
#   - files β cannot play: .m4a .rpgmvm .mp4 .webm .ogv .mov .aac .mp3 .gif (β decodes Ogg audio and PNG/JPEG/WebP images only)
#   - a movies/ folder with files, event command 261 (play movie) in data/*.json, a js/plugins file calls playVideo / Video.play / creates a <video>
SRC="${1%/}"; [ -d "$SRC" ] || { echo "no game folder"; exit 1; }
W=""; [ ! -f "$SRC/index.html" ] && [ -f "$SRC/www/index.html" ] && W="www/"
f=$(find "$SRC" -type f \( -iname '*.m4a' -o -iname '*.rpgmvm' -o -iname '*.mp4' -o -iname '*.webm' -o -iname '*.ogv' -o -iname '*.mov' -o -iname '*.aac' -o -iname '*.mp3' -o -iname '*.gif' \) -print -quit 2>/dev/null)
[ -n "$f" ] && { echo "unsupported media file: ${f#$SRC/}"; exit 1; }
[ -d "$SRC/${W}movies" ] && [ -n "$(find "$SRC/${W}movies" -type f -print -quit 2>/dev/null)" ] && { echo "movies/ folder has files"; exit 1; }
f=$(grep -lE '"code": ?261[,}]' "$SRC/${W}data/"*.json 2>/dev/null | head -1)
[ -n "$f" ] && { echo "play-movie command (261) in data/$(basename "$f")"; exit 1; }
f=$(grep -rlE '\.playVideo\(|Video\.play\(|createElement\(.video' "$SRC/${W}js/plugins" 2>/dev/null | head -1)   # calls, not hooks (a plugin may only wrap Graphics._playVideo)
[ -n "$f" ] && { echo "plugin plays video: js/plugins/$(basename "$f")"; exit 1; }
exit 0
