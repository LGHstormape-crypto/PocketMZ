#!/bin/bash
# SPDX-License-Identifier: MIT
# PocketMZ maintenance commands (used by the settings screen, pocketmz-settings.py).
# Usage: pocketmz-maint.sh info                  version, games, sizes (key=value lines)
#        pocketmz-maint.sh export-saves [dir]    copy every game's saves to dir
#                                                (default /storage/roms/pocketmz-saves/<date-time>)
#        pocketmz-maint.sh clean-copies          remove the regenerable parts of the thin copies
#                                                (rebuilt at the next start; saves, backups, menu
#                                                settings and subset fonts stay)
#        pocketmz-maint.sh find-package          newest pocketmz.tar found: "path<TAB>version"
#        pocketmz-maint.sh update [package]      install that package (or the one found)
#        pocketmz-maint.sh delete-game <id> <dir> <keep-saves|delete-all>
#                                                remove original game, .rpgmz launcher, thin copy
#        pocketmz-maint.sh uninstall             pocketmz-uninstall.sh --yes
# Output: plain lines; the last line is "OK <message>" or "ERROR <message>".
PMZ="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
[ -f "$PMZ/pocketmz-env.sh" ] && . "$PMZ/pocketmz-env.sh"
RZ="${POCKETMZ_DATA:-/storage/pocketmz}"
SAVE_BASE="${POCKETMZ_SAVE_BASE:-/storage/roms/savestates/rpgmz}"
ok() { echo "OK $*"; exit 0; }
fail() { echo "ERROR $*"; exit 1; }
# messages in the system language (zh / ja / en)
[ -z "$POCKETMZ_UI_LANG" ] && . /etc/profile >/dev/null 2>&1   # get_setting
UL="${POCKETMZ_UI_LANG:-$(get_setting system.language 2>/dev/null)}"
T() { case "$UL" in zh*) echo "$1" ;; ja*) echo "$2" ;; *) echo "$3" ;; esac; }
running() { pidof nw >/dev/null 2>&1 || pidof node >/dev/null 2>&1; }

# where a downloaded / copied package may be
PKG_PLACES="/storage/roms/ports/PocketMZ/pocketmz.tar /storage/downloads/pocketmz.tar /storage/roms/pocketmz.tar
/storage/roms/rpgmaker/pocketmz.tar /storage/roms/rpgmz/pocketmz.tar /storage/pocketmz.tar"
pkg_version() { tar -xOf "$1" VERSION 2>/dev/null | head -1 | tr -d '\r'; }

title_of() {   # title of a game id from the menu library, else the id
  python3 - "$RZ/launcher/library/library.json" "$1" 2>/dev/null <<'PY' || echo "$1"
import json, sys
try:
    for g in json.load(open(sys.argv[1], encoding="utf-8"))["games"]:
        if g["id"] == sys.argv[2]:
            print(g["title"]); break
    else:
        print(sys.argv[2])
except Exception:
    print(sys.argv[2])
PY
}

case "$1" in
  info)
    echo "version=$(cat "$PMZ/VERSION" 2>/dev/null || echo ?)"
    echo "games=$(ls -1d "$RZ"/games/*/game 2>/dev/null | wc -l)"
    n=$(
      {
        for s in "$SAVE_BASE"/*/save; do
          [ -d "$s" ] && [ -n "$(ls -A "$s" 2>/dev/null)" ] && basename "$(dirname "$s")"
        done
        for g in "$RZ"/games/*/game; do
          id=$(basename "$(dirname "$g")")
          for s in "$g/save" "$g/www/save"; do
            [ -d "$s" ] && [ -n "$(ls -A "$s" 2>/dev/null)" ] && echo "$id"
          done
        done
      } | sort -u | wc -l
    )
    echo "withSaves=$n"
    echo "dataSize=$(du -sh "$RZ/games" 2>/dev/null | cut -f1)"
    echo "free=$(df -h /storage | awk 'NR==2{print $4}')"
    ok info ;;

  export-saves)
    DEST="${2:-/storage/roms/pocketmz-saves/$(date +%Y%m%d-%H%M%S)}"
    n=0
    for s in "$SAVE_BASE"/*/save; do
      [ -d "$s" ] && [ -n "$(ls -A "$s" 2>/dev/null)" ] || continue
      id=$(basename "$(dirname "$s")")
      t=$(title_of "$id" | tr -d '/\\:*?"<>|' | cut -c1-40)
      mkdir -p "$DEST/$id $t" && cp -r "$s/." "$DEST/$id $t/" && n=$((n + 1))
    done
    for g in "$RZ"/games/*/game; do
      id=$(basename "$(dirname "$g")")
      for s in "$g/save" "$g/www/save"; do
        [ -d "$s" ] && [ -n "$(ls -A "$s" 2>/dev/null)" ] || continue
        t=$(title_of "$id" | tr -d '/\\:*?"<>|' | cut -c1-40)
        if [ ! -d "$DEST/$id $t" ]; then
          mkdir -p "$DEST/$id $t" && cp -r "$s/." "$DEST/$id $t/" && n=$((n + 1))
        fi
      done
    done
    [ "$n" -gt 0 ] || ok "$(T "没有可导出的存档" "書き出すセーブがありません" "no saves to export")"
    ok "$(T "已导出 $n 个游戏的存档到 $DEST" "$n 本のセーブを $DEST に書き出しました" "$n games -> $DEST")" ;;

  clean-copies)
    running && fail "$(T "有游戏正在运行，请先退出" "ゲームが実行中です。先に終了してください" "a game is running")"
    n=0
    for g in "$RZ"/games/*/game; do
      [ -d "$g" ] || continue
      case "$g" in "$RZ"/games/*/game) ;; *) continue ;; esac
      for w in "" "www/"; do
        for x in index.html css js data; do
          [ -e "$g/$w$x" ] && rm -rf "${g:?}/$w$x"
        done
        # symlinks to the original game's asset folders
        find "$g/$w" -maxdepth 1 -type l -exec rm -f {} + 2>/dev/null
      done
      n=$((n + 1))
    done
    ok "$(T "已清理 $n 个游戏副本（下次启动时自动重建）" "$n 本のコピーを整理しました（次回起動時に再作成）" "$n copies cleaned (rebuilt at the next start)")" ;;

  find-package)
    best=""; bestv=""
    for p in $PKG_PLACES; do
      [ -f "$p" ] || continue
      v=$(pkg_version "$p"); [ -n "$v" ] || continue
      if [ -z "$best" ] || [ "$v" \> "$bestv" ]; then best="$p"; bestv="$v"; fi
    done
    [ -n "$best" ] || fail "$(T "没有找到安装包：请把 pocketmz.tar 放到 roms/ports/PocketMZ/ 或 downloads/" "パッケージがありません：pocketmz.tar を roms/ports/PocketMZ/ か downloads/ に置いてください" "no package (put pocketmz.tar in roms/ports/PocketMZ/ or downloads/)")"
    printf '%s\t%s\n' "$best" "$bestv"
    ok "found" ;;

  update)
    running && fail "$(T "有游戏正在运行，请先退出" "ゲームが実行中です。先に終了してください" "a game is running")"
    PKG="$2"
    [ -n "$PKG" ] || PKG=$("$0" find-package | head -1 | cut -f1)
    [ -f "$PKG" ] || fail "$(T "没有找到安装包" "パッケージがありません" "no package")"
    v=$(pkg_version "$PKG"); [ -n "$v" ] || fail "$(T "不是 PocketMZ 安装包：$PKG" "PocketMZ のパッケージではありません：$PKG" "not a PocketMZ package: $PKG")"
    NEW=/storage/pocketmz-new
    rm -rf "${NEW:?}"; mkdir -p "$NEW"
    tar -xf "$PKG" -C "$NEW" || { rm -rf "${NEW:?}"; fail "$(T "解压失败：$PKG" "展開に失敗しました：$PKG" "could not unpack $PKG")"; }
    if sh "$NEW/pocketmz-install.sh" --menu > /storage/pocketmz-install.log 2>&1; then
      rm -rf "${NEW:?}"; ok "$(T "已更新到 $v，下次启动生效" "$v に更新しました（次回起動から）" "updated to $v")"
    fi
    rm -rf "${NEW:?}"; fail "$(T "安装失败，详见 /storage/pocketmz-install.log" "インストールに失敗しました。/storage/pocketmz-install.log を参照" "install failed, see /storage/pocketmz-install.log")" ;;

  delete-game)
    running && fail "$(T "有游戏正在运行，请先退出" "ゲームが実行中です。先に終了してください" "a game is running")"
    ID="$2"; GDIR="${3%/}"; SMODE="${4:-keep-saves}"
    [ -n "$ID" ] || fail "$(T "缺少游戏 ID" "ゲーム ID がありません" "missing game id")"
    case "$ID" in */*|*..*) fail "invalid id: $ID" ;; esac
    case "$SMODE" in keep-saves|delete-all) ;; *) fail "invalid mode: $SMODE" ;; esac
    if [ -n "$GDIR" ]; then
      case "$GDIR" in
        *..*) fail "invalid dir: $GDIR" ;;
        /storage/roms/rpgmaker/*|/storage/roms/easyrpg/*) ;;
        *) fail "$(T "拒绝删除非游戏目录：$GDIR" "対象外のフォルダは削除できません：$GDIR" "refusing to delete outside rpgmaker/easyrpg: $GDIR")" ;;
      esac
    fi
    if [ "$SMODE" = keep-saves ]; then
      for s in "$RZ/games/$ID/game/save" "$RZ/games/$ID/game/www/save"; do
        if [ -d "$s" ] && [ -n "$(ls -A "$s" 2>/dev/null)" ]; then
          mkdir -p "$SAVE_BASE/$ID/save"
          for sf in "$s"/* "$s"/.[!.]*; do [ -e "$sf" ] && [ ! -e "$SAVE_BASE/$ID/save/$(basename "$sf")" ] && cp -r "$sf" "$SAVE_BASE/$ID/save/"; done
        fi
      done
    else
      rm -rf "${SAVE_BASE:?}/${ID:?}"
    fi
    if [ -n "$GDIR" ] && [ -d "$GDIR" ]; then
      rm -rf "$GDIR"
      parent=$(dirname "$GDIR")
      case "$parent" in /storage/roms/rpgmaker/*) rmdir "$parent" 2>/dev/null || true ;; esac
    fi
    rm -rf "${RZ:?}/games/${ID:?}"
    rm -f "$RZ/launcher/library/covers/${ID}-"*.png "$RZ/launcher/library/thumbs/${ID}-"*.png 2>/dev/null || true
    if [ "$SMODE" = keep-saves ]; then
      ok "$(T "已删除游戏与副本；存档保留在 roms/savestates/rpgmz/$ID/" "ゲームとコピーを削除しました（セーブは roms/savestates/rpgmz/$ID/ に保持）" "deleted game; saves kept in roms/savestates/rpgmz/$ID/")"
    else
      ok "$(T "已彻底删除游戏、副本与全部存档" "ゲーム・コピー・セーブをすべて削除しました" "deleted game and saves")"
    fi ;;

  uninstall)
    running && fail "$(T "有游戏正在运行，请先退出" "ゲームが実行中です。先に終了してください" "a game is running")"
    "$PMZ/pocketmz-uninstall.sh" --yes > /storage/pocketmz-uninstall.log 2>&1 && ok "$(T "已卸载；存档保留在 $SAVE_BASE" "削除しました。セーブは $SAVE_BASE に残しています" "removed; saves kept in $SAVE_BASE")"
    fail "$(T "卸载失败，详见 /storage/pocketmz-uninstall.log" "削除に失敗しました。/storage/pocketmz-uninstall.log を参照" "see /storage/pocketmz-uninstall.log")" ;;

  *) sed -n '3,12p' "$0"; exit 1 ;;
esac
