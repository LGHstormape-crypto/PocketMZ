#!/bin/sh
# Stop a running WPE prototype run (runner loop, cog, WebKit processes, probe server).
for p in $(ps -eo pid,args | awk '$2 == "sh" && $3 ~ /pmz-wpe-run\.sh$/ {print $1} $2 == "python3" && $3 ~ /pmz-wpe-serve\.py$/ {print $1}'); do
  kill "$p" 2>/dev/null
done
killall cog WPEWebProcess WPENetworkProcess 2>/dev/null
sleep 2
killall -9 cog WPEWebProcess WPENetworkProcess 2>/dev/null
exit 0
