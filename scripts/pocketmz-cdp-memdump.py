#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Dev: Chromium memory-infra dump of the running game (what the memory is used for, per process).

Needs the game started with --remote-debugging-port=9223 (file /storage/pocketmz/extra-args).
Usage: pocketmz-cdp-memdump.py [port] [top]  -> per process: biggest allocators (MB) and
selected sub-allocators (image caches, canvases, web cache, media, GPU, ...).
Minimal WebSocket client (stdlib only), same as pocketmz-cdp-profile.py.
"""
import base64, json, os, socket, struct, sys, urllib.request

port = int(sys.argv[1]) if len(sys.argv) > 1 else 9223
top = int(sys.argv[2]) if len(sys.argv) > 2 else 14
CRLF = "\r\n"
url = json.load(urllib.request.urlopen("http://127.0.0.1:%d/json/version" % port, timeout=5))["webSocketDebuggerUrl"]
path = url.split(str(port), 1)[1]
sock = socket.create_connection(("127.0.0.1", port), timeout=120)
key = base64.b64encode(os.urandom(16)).decode()
req = CRLF.join(["GET %s HTTP/1.1" % path, "Host: 127.0.0.1:%d" % port, "Upgrade: websocket",
                 "Connection: Upgrade", "Sec-WebSocket-Key: %s" % key, "Sec-WebSocket-Version: 13", "", ""])
sock.sendall(req.encode())
resp = b""
while b"\r\n\r\n" not in resp:
    resp += sock.recv(1024)
if b" 101 " not in resp.split(b"\r\n", 1)[0]:
    sys.exit("handshake failed: %r" % resp[:200])
buf = resp.split(b"\r\n\r\n", 1)[1]


def recv_exact(n):
    global buf
    while len(buf) < n:
        chunk = sock.recv(65536)
        if not chunk:
            raise EOFError
        buf += chunk
    out, buf = buf[:n], buf[n:]
    return out


def send(obj):
    data = json.dumps(obj).encode()
    hdr = bytearray([0x81])
    n = len(data)
    if n < 126:
        hdr.append(0x80 | n)
    elif n < 65536:
        hdr.append(0x80 | 126); hdr += struct.pack(">H", n)
    else:
        hdr.append(0x80 | 127); hdr += struct.pack(">Q", n)
    mask = os.urandom(4)
    sock.sendall(bytes(hdr) + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))


def recv_msg():
    payload = b""
    while True:
        b0, b1 = recv_exact(2)
        n = b1 & 0x7F
        if n == 126:
            n = struct.unpack(">H", recv_exact(2))[0]
        elif n == 127:
            n = struct.unpack(">Q", recv_exact(8))[0]
        payload += recv_exact(n)
        if b0 & 0x80:
            return json.loads(payload.decode("utf-8"))


msg_id = 0
events = []


def call(method, params=None):
    global msg_id
    msg_id += 1
    send({"id": msg_id, "method": method, "params": params or {}})
    while True:
        m = recv_msg()
        if m.get("method") == "Tracing.dataCollected":
            events.extend(m["params"]["value"])
        if m.get("id") == msg_id:
            if "error" in m:
                sys.exit("%s: %s" % (method, m["error"]))
            return m.get("result", {})


call("Tracing.start", {"transferMode": "ReportEvents", "traceConfig": {
    "includedCategories": ["disabled-by-default-memory-infra"], "excludedCategories": ["*"],
    "memoryDumpConfig": {"triggers": []}}})
r = call("Tracing.requestMemoryDump", {"deterministic": True, "levelOfDetail": "detailed"})
call("Tracing.end")
while True:
    m = recv_msg()
    if m.get("method") == "Tracing.dataCollected":
        events.extend(m["params"]["value"])
    elif m.get("method") == "Tracing.tracingComplete":
        break

names = {}
for e in events:
    if e.get("ph") == "M" and e.get("name") == "process_name":
        names[e["pid"]] = e["args"].get("name", "")
SUB = ("skia", "cc", "web_cache", "canvas", "media", "gpu", "partition_alloc/partitions", "blink_gc",
       "discardable", "image", "malloc")


def mb(v):
    return int(v, 16) / 1048576 if isinstance(v, str) else v / 1048576


for e in events:
    if e.get("ph") != "v":
        continue
    alloc = e.get("args", {}).get("dumps", {}).get("allocators", {})
    if not alloc:
        continue
    sizes = {}
    for name, a in alloc.items():
        s = a.get("attrs", {}).get("size")
        if s:
            sizes[name] = mb(s["value"])
    tops = sorted(((v, k) for k, v in sizes.items() if "/" not in k), reverse=True)
    print("== pid %s %s" % (e["pid"], names.get(e["pid"], "")))
    for v, k in tops[:top]:
        if v >= 0.5:
            print("  %8.1f MB  %s" % (v, k))
    subs = sorted(((v, k) for k, v in sizes.items()
                   if k.count("/") in (1, 2) and v >= 2 and any(k.startswith(p) for p in SUB)), reverse=True)
    for v, k in subs[:top]:
        print("           %8.1f MB  %s" % (v, k))
print("dump ok" if r.get("success") else "dump failed: %r" % r)
