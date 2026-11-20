#!/bin/sh
# Dev (PC side): copy files to the handheld's /storage/pocketmz safely.
# Usage: scripts/deploy.sh <file>... [patches/<file>...]   (paths relative to the PocketMZ folder)
# Refuses while a game runs. Files go to a temp folder first and are then moved over the old
# ones (new inode): a running bash keeps reading its own copy of a script. CR line ends removed.
# patches/* -> /storage/pocketmz/patches/, modules/* -> /storage/pocketmz/modules/, rest -> /storage/pocketmz/.
HOST=gkd-rocknix
cd "$(dirname "$0")/.." || exit 1
[ $# -gt 0 ] || { echo "usage: $0 <file>..." >&2; exit 1; }
if ssh "$HOST" 'pidof nw >/dev/null'; then echo "a game is running on the handheld - not deploying" >&2; exit 1; fi
ssh "$HOST" 'rm -rf /storage/pocketmz/.deploy && mkdir -p /storage/pocketmz/.deploy' || exit 1
for f in "$@"; do
  [ -f "$f" ] || f="scripts/$f"
  [ -f "$f" ] || { echo "no file $f" >&2; exit 1; }
  scp -q "$f" "$HOST:/storage/pocketmz/.deploy/" || exit 1
done
for f in "$@"; do
  [ -f "$f" ] || f="scripts/$f"
  n=$(basename "$f")
  case "$f" in
    patches/*) dst=/storage/pocketmz/patches ;;
    */modules/*|modules/*) dst=/storage/pocketmz/modules ;;
    */launcher/*|launcher/*) dst=/storage/pocketmz/launcher ;;
    */ports/*|ports/*) dst=/storage/pocketmz/ports ;;
    *) dst=/storage/pocketmz ;;
  esac
  ssh "$HOST" "f='/storage/pocketmz/.deploy/$n'; case \"\$f\" in *.sh|*.js|*.py|*.cfg|*.md) sed -i 's/\r\$//' \"\$f\";; esac
    case \"\$f\" in *.sh) chmod +x \"\$f\";; esac; mkdir -p '$dst'; mv -f \"\$f\" '$dst/$n'" || exit 1
  echo "deployed $f -> $dst/$n"
done
ssh "$HOST" 'rmdir /storage/pocketmz/.deploy 2>/dev/null'
