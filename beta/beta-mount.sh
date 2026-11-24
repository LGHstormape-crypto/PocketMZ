#!/bin/sh
# Device side: make sure a β root is mounted, print its path.
# beta-mount.sh rt      -> /storage/pocketmz/beta/rt      RELEASE root: beta-runtime.sqfs (loop, ro, on beta/rt-img) over the α image (root-sqfs), a read-only overlay
#                          (no upper dir: β writes only to the bind mounts pocketmz-chroot.sh / run-pmzrun.sh add: /tmp, /root, /dev/shm, the shots dir and the game folders)
# beta-mount.sh auto    -> rt when beta-runtime.sqfs is installed, else root24 when the dev overlay exists (the launcher uses this), else exit 1
# beta-mount.sh umount  -> unmount rt (and everything bound below it) and its image; used by pocketmz-install.sh before the image is replaced
# beta-mount.sh root    -> /storage/pocketmz/beta/root    DEV (Debian trixie rootfs dir + β upper: Node 20, gcc, SDL, cairo ...)
# beta-mount.sh root24  -> /storage/pocketmz/beta/root24  DEV (the above + upper24: Node 24 from Debian forky)
RZ=/storage/pocketmz; B=$RZ/beta; N=${1:-root}
IMG=$RZ/beta-runtime.sqfs
case "$N" in
  auto) if [ -f "$IMG" ]; then N=rt; elif [ -d $B/upper24 ]; then N=root24; else echo "no β runtime installed" >&2; exit 1; fi ;;
esac
R=$B/$N
is_mounted() { grep -q " $1 " /proc/mounts; }
rt_umount() {   # everything mounted at or below $B/rt, deepest first, then the image
  for m in $(awk -v p="$B/rt" '$2==p || index($2,p"/")==1 {print $2}' /proc/mounts | sort -r); do umount -l "$m" 2>/dev/null; done
  is_mounted $B/rt-img && umount -l $B/rt-img
  return 0
}
case "$N" in
  umount) rt_umount; exit 0 ;;
  rt)
    [ -f "$IMG" ] || { echo "no $IMG" >&2; exit 1; }
    # standalone β-only mode when neither rootfs.sqfs nor rootfs/ exists: mount beta-runtime.sqfs directly on $R
    if [ ! -f "$RZ/rootfs.sqfs" ] && [ ! -d "$RZ/rootfs" ]; then
      if is_mounted "$R"; then
        LD=$(awk -v m="$R" '$2==m {print $1}' /proc/mounts | head -1); LD=${LD##*/}
        BF=$(cat /sys/block/$LD/loop/backing_file 2>/dev/null)
        [ "$BF" = "$(readlink -f "$IMG")" ] || rt_umount
      fi
      mkdir -p "$R"
      is_mounted "$R" || mount -t squashfs -o loop,ro "$IMG" "$R" || exit 1
      echo "$R"; exit 0
    fi
    # α image: the same mount pocketmz-chroot.sh uses (root-sqfs); without rootfs.sqfs fall back to the maintenance dir
    LOW=$RZ/rootfs
    if [ -f $RZ/rootfs.sqfs ]; then
      LOW=$RZ/root-sqfs; mkdir -p $LOW
      is_mounted $LOW || mount -t squashfs -o loop,ro $RZ/rootfs.sqfs $LOW || exit 1
    fi
    # a replaced image (install / rebuild): the loop device still holds the old file -> remount
    if is_mounted $B/rt-img; then
      LD=$(awk -v m="$B/rt-img" '$2==m {print $1}' /proc/mounts | head -1); LD=${LD##*/}
      BF=$(cat /sys/block/$LD/loop/backing_file 2>/dev/null)
      [ "$BF" = "$(readlink -f $IMG)" ] || rt_umount
    fi
    mkdir -p $B/rt-img $R
    is_mounted $B/rt-img || mount -t squashfs -o loop,ro $IMG $B/rt-img || exit 1
    is_mounted $R || mount -t overlay overlay -o lowerdir=$B/rt-img:$LOW $R || exit 1
    echo "$R"; exit 0 ;;
  root)   O="lowerdir=/storage/pocketmz/rootfs,upperdir=$B/upper,workdir=$B/work" ;;
  root24) O="lowerdir=$B/upper:/storage/pocketmz/rootfs,upperdir=$B/upper24,workdir=$B/work24" ;;
  *) echo "unknown root $N" >&2; exit 1 ;;
esac
grep -q " $R " /proc/mounts || mount -t overlay overlay -o "$O" "$R" || exit 1
grep -q " $R " /proc/mounts || exit 1
echo "$R"
