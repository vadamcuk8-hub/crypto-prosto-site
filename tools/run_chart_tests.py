#!/usr/bin/env python3
"""Запуск tools/test-chart.html у справжньому (видимому для рушія) браузері Edge без Node.js.

Що робить: піднімає локальний сервер сайту, запускає Edge у headless-режимі з портом налагодження, відкриває сторінку тестів,
чекає, поки вона закінчить (window.__testSummary), і друкує результат. Код виходу 0 — усі тести пройдено, 1 — є провали.
Потрібен Microsoft Edge (є в Windows) або Chrome: шлях можна передати змінною CHROME_PATH.

  python tools/run_chart_tests.py
"""
import base64
import http.server
import json
import os
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BROWSERS = [os.environ.get("CHROME_PATH", ""), r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe", r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
            r"C:\Program Files\Google\Chrome\Application\chrome.exe", r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"]


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


class WS:
    """Мінімальний WebSocket-клієнт (лише текстові кадри) для протоколу налагодження Chrome DevTools."""

    def __init__(self, url):
        host, port, path = url[5:].split("/", 1)[0].split(":")[0], int(url[5:].split("/", 1)[0].split(":")[1]), "/" + url[5:].split("/", 1)[1]
        self.sock = socket.create_connection((host, port), timeout=10)
        key = base64.b64encode(os.urandom(16)).decode()
        self.sock.sendall(("GET %s HTTP/1.1\r\nHost: %s:%d\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n" % (path, host, port, key)).encode())
        buf = b""
        while b"\r\n\r\n" not in buf:
            buf += self.sock.recv(4096)
        if b" 101 " not in buf.split(b"\r\n")[0]:
            raise RuntimeError("WebSocket не підключився: " + buf[:80].decode(errors="replace"))
        self.rest = buf.split(b"\r\n\r\n", 1)[1]
        self.id = 0

    def _read(self, n):
        while len(self.rest) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise RuntimeError("з'єднання закрито")
            self.rest += chunk
        out, self.rest = self.rest[:n], self.rest[n:]
        return out

    def send(self, obj):
        data = json.dumps(obj).encode()
        head = bytes([0x81])
        n = len(data)
        mask = os.urandom(4)
        if n < 126:
            head += bytes([0x80 | n])
        elif n < 65536:
            head += bytes([0x80 | 126]) + struct.pack(">H", n)
        else:
            head += bytes([0x80 | 127]) + struct.pack(">Q", n)
        self.sock.sendall(head + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))

    def recv(self):
        while True:
            b1, b2 = self._read(2)
            n = b2 & 0x7F
            if n == 126:
                n = struct.unpack(">H", self._read(2))[0]
            elif n == 127:
                n = struct.unpack(">Q", self._read(8))[0]
            payload = self._read(n)
            if b1 & 0x0F == 1:
                return json.loads(payload.decode())

    def call(self, method, params=None):
        self.id += 1
        i = self.id
        self.send({"id": i, "method": method, "params": params or {}})
        while True:
            m = self.recv()
            if m.get("id") == i:
                return m


def main():
    exe = next((b for b in BROWSERS if b and os.path.exists(b)), None)
    if not exe:
        print("Не знайдено Edge/Chrome. Вкажіть шлях у змінній CHROME_PATH.")
        return 2
    handler_cls = type("Quiet", (http.server.SimpleHTTPRequestHandler,), {"log_message": lambda self, *a: None})
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), lambda *a, **k: handler_cls(*a, directory=ROOT, **k))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    page = sys.argv[1] if len(sys.argv) > 1 else "test-chart.html"                    # python tools/run_chart_tests.py test-feed.html: інша сторінка тестів
    site = "http://127.0.0.1:%d/tools/%s" % (httpd.server_address[1], page)
    port = free_port()
    prof = tempfile.mkdtemp(prefix="chart_tests_")
    proc = subprocess.Popen([exe, "--headless=new", "--remote-debugging-port=%d" % port, "--user-data-dir=" + prof, "--window-size=1100,900", "--no-first-run", "about:blank"],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        ws = None
        for _ in range(60):
            try:
                targets = json.loads(urllib.request.urlopen("http://127.0.0.1:%d/json" % port, timeout=2).read().decode())
                page = next(t for t in targets if t.get("type") == "page")
                ws = WS(page["webSocketDebuggerUrl"])
                break
            except Exception:
                time.sleep(0.5)
        if not ws:
            print("Не вдалось підключитись до браузера.")
            return 2
        ws.call("Page.enable")
        ws.call("Page.navigate", {"url": site})
        res = None
        for _ in range(240):                                   # до 2 хвилин
            time.sleep(0.5)
            r = ws.call("Runtime.evaluate", {"expression": "JSON.stringify({s: window.__testSummary || null, fails: [...document.querySelectorAll('li.fail')].map(l => l.textContent), notes: [...document.querySelectorAll('li.note')].map(l => l.textContent)})", "returnByValue": True})
            val = r.get("result", {}).get("result", {}).get("value")
            if val:
                d = json.loads(val)
                if d["s"]:
                    res = d
                    break
        if not res:
            print("Тести не завершились за 2 хвилини.")
            return 2
        s = res["s"]
        print("Пройдено %d із %d, провалено %d, пропущено %d" % (s["pass"], s["total"], s["fail"], s.get("skipped", 0)))
        for f in res["fails"]:
            print("  ПРОВАЛ:", f)
        for n in res["notes"]:
            print("  ПРОПУЩЕНО:", n)
        return 0 if s["fail"] == 0 else 1
    finally:
        try:
            proc.terminate()
        except Exception:
            pass
        httpd.shutdown()


if __name__ == "__main__":
    sys.exit(main())
