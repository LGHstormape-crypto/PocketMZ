#!/usr/bin/env python3
"""Dev: V8 CPU profile of the running game through Chromium's DevTools protocol.

Needs the game started with --remote-debugging-port=9223 (file /storage/pocketmz/extra-args).
Usage: pocketmz-cdp-profile.py [seconds] [port]  -> top functions by self time, and per script.
Minimal WebSocket client (stdlib only).
"""
import base64, json, os, socket, struct, sys, time, urllib.request
from collections import Counter

secs = float(sys.argv[1]) if len(sys.argv) > 1 else 8
port = int(sys.argv[2]) if len(sys.argv) > 2 else 9223

targets = json.load(urllib.request.urlopen("http://127.0.0.1:%d/json" % port, timeout=5))
page = next(t for t in targets if t.get("type") in ("page", "app") and "webSocketDebuggerUrl" in t)
url = page["webSocketDebuggerUrl"]
path = url.split(str(port), 1)[1]

sock = socket.create_connection(("127.0.0.1", port), timeout=60)
key = base64.b64encode(os.urandom(16)).decode()
sock.sendall(("GET %s HTTP/1.1\r\nHost: 127.0.0.1:%d\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
              "Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n" % (path, port, key)).encode())
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


def call(method, params=None):
    global msg_id
    msg_id += 1
    send({"id": msg_id, "method": method, "params": params or {}})
    while True:
        m = recv_msg()
        if m.get("id") == msg_id:
            if "error" in m:
                raise RuntimeError(m["error"])
            return m.get("result", {})


call("Profiler.enable")
call("Profiler.setSamplingInterval", {"interval": 1000})
call("Profiler.start")
time.sleep(secs)
prof = call("Profiler.stop")["profile"]

nodes = {n["id"]: n for n in prof["nodes"]}
samples = prof.get("samples", [])
deltas = prof.get("timeDeltas", [])
self_time, script_time = Counter(), Counter()
for sid, dt in zip(samples, deltas):
    f = nodes[sid]["callFrame"]
    script = (f.get("url") or "").rsplit("/", 1)[-1] or "(%s)" % (f.get("functionName") or "native")
    name = "%s @%s:%d" % (f.get("functionName") or "(anon)", script, f.get("lineNumber", 0) + 1)
    self_time[name] += dt
    script_time[script] += dt
total = sum(deltas) or 1
print("profile %.1fs, samples %d" % (total / 1e6, len(samples)))
print("-- by script (self time)")
for k, v in script_time.most_common(15):
    print("%5.1f%% %s" % (100 * v / total, k))
print("-- top functions (self time)")
for k, v in self_time.most_common(35):
    print("%5.1f%% %s" % (100 * v / total, k))
