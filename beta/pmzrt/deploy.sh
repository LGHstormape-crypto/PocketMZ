#!/bin/sh
# PC side: copy sources to the handheld's beta overlay and build there.
H=gkd-rocknix; D=/opt/beta/pmzrt; RD=${PMZ_ROOTDIR:-root24}   # default: the Node 24 overlay; PMZ_ROOTDIR=root = Node 20
cd "$(dirname "$0")" || exit 1
# mount the overlay first (it is gone after a reboot; without it the files land in the bare mount point)
B=/storage/pocketmz/beta
scp -q ../beta-mount.sh $H:$B/beta-mount.sh && R=$(ssh $H "chmod +x $B/beta-mount.sh; $B/beta-mount.sh $RD") && [ -n "$R" ] && ssh $H "mkdir -p $R$D" || { echo "overlay not mounted"; exit 1; }
scp pmzrt.c pmzrt_gl.h pmzrt_canvas.c pmzrt_audio.c pmzrt_video.c webaudio.js test-audio.js test-media.js canvas2d.js webgl.js build.sh test-triangle.js $H:$R$D/ || exit 1
ssh $H "chmod +x $R$D/build.sh; POCKETMZ_ROOT=$R unshare -m sh -c 'mount --make-rprivate / && exec /storage/pocketmz/pocketmz-chroot.sh run sh $D/build.sh'" && echo "build ok"
