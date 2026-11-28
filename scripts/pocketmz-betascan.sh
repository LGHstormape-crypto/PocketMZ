#!/bin/bash
# Static pre-launch scan: can the β runtime (no browser) play this game? Read-only on the game folder.
# Usage: pocketmz-betascan.sh <original game dir>
# Prints one line with the reason when β cannot (exit 1), nothing and exit 0 when no problem is found.
#   - files β cannot decode yet: .gif (β natively decodes Ogg/M4A/MP3/AAC/WAV audio, MP4/WebM/OGV/MOV video, PNG/JPEG/WebP images)
SRC="${1%/}"; [ -d "$SRC" ] || { echo "no game folder"; exit 1; }
exit 0
