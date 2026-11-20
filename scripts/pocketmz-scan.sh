#!/bin/sh
# Find RPG Maker MV/MZ games and add them to EmulationStation.
# Usage: pocketmz-scan.sh [dir...]        default dirs: /storage/roms/rpgmaker /storage/roms/easyrpg
#        pocketmz-scan.sh --ports [dir...] one entry per game in Ports (default while the ES system is not installed)
#        pocketmz-scan.sh --launchers [dir...] launcher files even if the ES system is not found
#        pocketmz-scan.sh --id <game dir>  print the id of a game (its folder /storage/pocketmz/games/<id>)
#        pocketmz-scan.sh --remove         remove all entries this script made (saves stay)
# With the ES system "RPGMZ" (run by PocketMZ) installed (es_systems_pocketmz.cfg), it lists launcher files
# /storage/roms/rpgmz/<title>.rpgmz (lines dir=<game folder>, id=<id>). Game folders stay where
# they are; ES never has to walk through them. Entries this script made earlier in Ports are moved
# over, launchers whose game folder is gone are removed.
# A game folder has index.html + js/rmmz_core.js (MZ) or www/index.html + www/js/rpg_core.js (MV).
# EasyRPG games (RPG Maker 2000/2003) in the same folders are left alone.
# id: DLsite code in the path (RJ/VJ/BJ + 6-8 digits), else folder name + hash of the path.
PMZ="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"   # program files (pocketmz-run.sh)
PORTS=/storage/roms/ports
LAUNCH=/storage/roms/rpgmz
MARK="# pocketmz:"

game_id() {
  code=$(printf %s "$1" | grep -o '[RVB]J[0-9]\{6,8\}' | tail -1)
  if [ -n "$code" ]; then echo "$code"; return; fi
  name=$(basename "$1" | tr -c 'A-Za-z0-9._-' '_' | tr -s '_' | sed 's/^_//; s/_$//' | cut -c1-32)
  hash=$(printf %s "$1" | md5sum | cut -c1-8)
  echo "${name:+$name-}$hash"
}
reload_es() { curl -s -m 5 http://127.0.0.1:1234/reloadgames >/dev/null 2>&1; }
OLDMARK="# rpgmz-port:"   # entries made before the PocketMZ name (they run /storage/rpgmz/...)
remove_old() {
  for f in "$PORTS"/*.sh; do grep -q "^$OLDMARK" "$f" 2>/dev/null && { rm -f "$f"; echo "removed old entry: $f"; }; done
}
remove_ports() {
  remove_old
  for f in "$PORTS"/*.sh; do grep -q "^$MARK" "$f" 2>/dev/null && { rm -f "$f"; echo "removed from Ports: $f"; }; done
}

# launcher mode only once the ES system is installed (system file or user es_systems_*.cfg);
# without it the games keep their Ports entries
MODE=ports
grep -qs "<name>rpgmz</name>" /storage/.config/emulationstation/es_systems_*.cfg /usr/config/emulationstation/es_systems*.cfg   /etc/emulationstation/es_systems*.cfg && MODE=launch
case "$1" in
  --id) game_id "${2%/}"; exit 0 ;;
  --remove)
    remove_ports
    for f in "$LAUNCH"/*.rpgmz; do [ -f "$f" ] && { rm -f "$f"; echo "removed: $f"; }; done
    reload_es; exit 0 ;;
  --ports) MODE=ports; shift ;;
  --launchers) MODE=launch; shift ;;
esac

[ $# -eq 0 ] && set -- /storage/roms/rpgmaker /storage/roms/easyrpg
mkdir -p /storage/roms/rpgmaker 2>/dev/null
[ $MODE = ports ] && remove_old
if [ $MODE = launch ]; then
  mkdir -p "$LAUNCH"
  remove_ports
  # launchers whose game folder is gone
  for f in "$LAUNCH"/*.rpgmz; do
    [ -f "$f" ] || continue
    d=$(sed -n 's/^dir=//p' "$f" | head -1)
    [ -d "$d" ] || { rm -f "$f"; echo "removed (game folder gone): $f"; }
  done
fi
for top in "$@"; do
  [ -d "$top" ] || continue
  # index.html at most 4 levels down; never descend into asset folders (slow on exFAT)
  find "$top" -maxdepth 4 \( -name img -o -name audio -o -name movies -o -name effects -o -name fonts \
       -o -name save -o -name locales -o -name swiftshader -o -name data -o -name js -o -name css \) -prune \
       -o -name index.html -type f -print 2>/dev/null |
  while IFS= read -r html; do
    d=$(dirname "$html")
    if [ -f "$d/js/rmmz_core.js" ]; then kind=MZ; game="$d"
    elif [ -f "$d/js/rpg_core.js" ] && [ "$(basename "$d")" = www ] && [ -f "$d/../package.json" ]; then kind=MV; game=$(dirname "$d")
    else continue; fi
    if [ $MODE = launch ]; then
      grep -lxF "dir=$game" "$LAUNCH"/*.rpgmz >/dev/null 2>&1 && { echo "exists: $game"; continue; }
    else
      grep -lF "\"$game\"" "$PORTS"/*.sh >/dev/null 2>&1 && { echo "exists: $game"; continue; }
    fi
    id=$(game_id "$game")
    sys="$d/data/System.json"
    title=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1], encoding="utf-8-sig")).get("gameTitle","").split(" | ")[0].strip())' "$sys" 2>/dev/null)
    [ -z "$title" ] && title=$(basename "$game")
    file=$(printf %s "$title" | tr -d '/\\:*?"<>|' | sed "s/^[. ]*//; s/  */ /g" | cut -c1-80)
    [ -z "$file" ] && file="$id"
    if [ $MODE = launch ]; then
      [ -e "$LAUNCH/$file.rpgmz" ] && file="$file ($id)"
      printf '# RPG Maker %s: %s - started by /storage/pocketmz/pocketmz-run.sh. Exit: F2+Start.\ndir=%s\nid=%s\n' \
        "$kind" "$title" "$game" "$id" > "$LAUNCH/$file.rpgmz"
      echo "added: $LAUNCH/$file.rpgmz  [$kind, id $id]"
    else
      [ -e "$PORTS/$file.sh" ] && file="$file ($id)"
      cat > "$PORTS/$file.sh" <<EOF
#!/bin/bash
$MARK $id
# RPG Maker $kind: $title (PocketMZ, $PMZ). Exit: F2+Start.
exec $PMZ/pocketmz-run.sh "$game" "$id"
EOF
      chmod +x "$PORTS/$file.sh"
      echo "added: $PORTS/$file.sh  [$kind, id $id]"
    fi
  done
done
reload_es
exit 0
