#!/usr/bin/env python3
# PocketMZ WPE prototype: serve a game folder over HTTP for cog (WPE WebKit).
# Usage: pmz-wpe-serve.py <game dir> [port]
# - index.html gets <script src="/__probe.js"> injected (frame/scene/text-speed probe + REPL client)
# - GET /__log?<text> prints "<unix ms> <text>" to stdout (probe output)
# - dev REPL on 127.0.0.1:9333 like PocketMZ_Debug in NW.js: POST JavaScript, get the JSON result
#   back (a Promise is awaited). The page long-polls /__cmd and posts results to /__res/<id>.
# - /js/plugins.js without Node-only plugins (PMZ_WPE_DROP), /js/plugins/PocketMZ_* from the current
#   patches (PMZ_WPE_PATCHES), missing files (thin-copy links to /gamesrc) from PMZ_WPE_SRC.
import http.server, json, os, queue, socketserver, sys, threading, time, urllib.parse

ROOT = os.path.abspath(sys.argv[1])
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 8765
REPL_PORT = int(os.environ.get("PMZ_WPE_REPL", "9333"))
DROP = [d.encode() for d in os.environ.get("PMZ_WPE_DROP", "PocketMZ_Debug,PocketMZ_Menu").split(",") if d]
SRC = os.environ.get("PMZ_WPE_SRC", "")
PATCHES = os.environ.get("PMZ_WPE_PATCHES", "/storage/pocketmz/patches")
TOOLS = os.path.dirname(os.path.abspath(__file__))
EXTRA = {  # extra scripts the page can load: /__<name>
    "/__probe.js": os.path.join(TOOLS, "pmz-wpe-probe.js"),
    "/__autotest.js": os.environ.get("PMZ_WPE_AUTOTEST", "/storage/pocketmz/pocketmz-autotest.js"),
}

CMDS = queue.Queue()          # (id, code) waiting for the page
RESULTS = {}                  # id -> result text
RES_LOCK = threading.Condition()
NEXT_ID = [0]


def log(*a):
    print(int(time.time() * 1000), *a, flush=True)


class Base(http.server.SimpleHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def _send(self, code, body, ctype, cache="no-store"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        self.end_headers()
        if body:
            self.wfile.write(body)


class H(Base):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    def translate_path(self, path):
        p = super().translate_path(path)
        if SRC and not os.path.exists(p):
            rel = os.path.relpath(p, ROOT)
            if not rel.startswith(".."):
                q = os.path.join(SRC, rel)
                if os.path.exists(q):
                    return q
        return p

    def end_headers(self):
        if b"Cache-Control" not in b"".join(getattr(self, "_headers_buffer", []) or []):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def do_POST(self):
        u = urllib.parse.urlsplit(self.path)
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n) if n else b""
        if u.path.startswith("/__res/"):
            with RES_LOCK:
                RESULTS[u.path[7:]] = body
                RES_LOCK.notify_all()
            return self._send(204, b"", "text/plain")
        if u.path == "/__log":
            log(body.decode("utf-8", "replace"))
            return self._send(204, b"", "text/plain")
        return self._send(404, b"", "text/plain")

    def do_GET(self):
        u = urllib.parse.urlsplit(self.path)
        if u.path == "/__log":
            log(urllib.parse.unquote(u.query))
            return self._send(204, b"", "text/plain")
        if u.path == "/__cmd":
            try:
                cid, code = CMDS.get(timeout=20)
            except queue.Empty:
                return self._send(204, b"", "text/plain")
            return self._send(200, json.dumps({"id": cid, "code": code}).encode(), "application/json")
        if u.path in EXTRA:
            with open(EXTRA[u.path], "rb") as f:
                return self._send(200, f.read(), "text/javascript")
        if u.path == "/js/plugins.js" and DROP:
            # drop Node-only plugins (they throw "require" and stop the boot in a plain browser)
            with open(os.path.join(ROOT, "js", "plugins.js"), "rb") as f:
                lines = f.read().split(b"\n")
            keep = [l for l in lines if not any((b'"name":"%s"' % d) in l for d in DROP)]
            return self._send(200, b"\n".join(keep), "text/javascript")
        if u.path.startswith("/js/plugins/PocketMZ_") and os.path.isdir(PATCHES):
            f = os.path.join(PATCHES, os.path.basename(u.path))
            if os.path.isfile(f):
                with open(f, "rb") as fh:
                    return self._send(200, fh.read(), "text/javascript")
        if u.path in ("/", "/index.html"):
            with open(os.path.join(ROOT, "index.html"), "rb") as f:
                html = f.read()
            html = html.replace(b"<head>", b'<head><script src="/__probe.js"></script>', 1)
            return self._send(200, html, "text/html")
        return super().do_GET()


class Repl(Base):
    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        code = self.rfile.read(n).decode("utf-8", "replace") if n else ""
        with RES_LOCK:
            NEXT_ID[0] += 1
            cid = str(NEXT_ID[0])
        CMDS.put((cid, code))
        end = time.time() + 60
        with RES_LOCK:
            while cid not in RESULTS and time.time() < end:
                RES_LOCK.wait(end - time.time())
            res = RESULTS.pop(cid, None)
        if res is None:
            return self._send(504, b"timeout", "text/plain")
        return self._send(200, res, "application/json")


class S(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


log("serve", ROOT, PORT, "repl", REPL_PORT)
threading.Thread(target=S(("127.0.0.1", REPL_PORT), Repl).serve_forever, daemon=True).start()
S(("127.0.0.1", PORT), H).serve_forever()
