#!/bin/sh
# PC side: build pmzrt on the handheld, push pmzrun.js + run script, run, show the tail of the log.
# Usage: deploy-pmzrun.sh [ENV=VAL ...]   e.g. deploy-pmzrun.sh PMZ_GLDEBUG=1
cd "$(dirname "$0")" || exit 1
H=gkd-rocknix; RD=${PMZ_ROOTDIR:-root24}; R=/storage/pocketmz/beta/$RD   # default root24 = Node 24 overlay; PMZ_ROOTDIR=root = Node 20
./pmzrt/deploy.sh || exit 1
ssh $H "mkdir -p $R/opt/beta/patches" && scp -q pmzrun.js overlay.js effect-lifetimes.json $H:$R/opt/beta/ && { [ ! -f mtest.js ] || scp -q mtest.js $H:$R/opt/beta/; } && scp -q ../patches/PocketMZ_Debug.js $H:$R/opt/beta/patches/ && scp -q run-pmzrun.sh pocketmz-test-beta.sh $H:/storage/pocketmz/beta/ || exit 1
ssh $H "chmod +x /storage/pocketmz/beta/run-pmzrun.sh /storage/pocketmz/beta/pocketmz-test-beta.sh; env PMZ_ROOTDIR=$RD $* /storage/pocketmz/beta/run-pmzrun.sh > /storage/pocketmz/beta/pmzrun.log 2>&1; grep -v '^ *at ' /storage/pocketmz/beta/pmzrun.log | cut -c1-400 | tail -n 70"
