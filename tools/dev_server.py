#!/usr/bin/env python3
"""Локальний сервер для розробки: віддає сайт із кореня проєкту, а папку /data/ бере з CRYPTO_DATA_DIR, якщо вона задана.
Так пробні запуски агентів не змінюють справжні файли data/, які веде бот на GitHub (інакше при злитті виникають конфлікти).

  set CRYPTO_DATA_DIR=C:\\temp\\crypto-data      (PowerShell: $env:CRYPTO_DATA_DIR = "C:\\temp\\crypto-data")
  python tools/run_agents.py                      агенти пишуть у цю папку
  python tools/dev_server.py [порт]               сайт на http://localhost:8001 (за замовчуванням)
Без змінної CRYPTO_DATA_DIR це звичайний статичний сервер."""
import functools
import http.server
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.environ.get("CRYPTO_DATA_DIR")


class Handler(http.server.SimpleHTTPRequestHandler):
    def translate_path(self, path):
        p = super().translate_path(path)
        if DATA:
            real = os.path.join(ROOT, "data")
            if p == real or p.startswith(real + os.sep):
                return os.path.join(DATA, os.path.relpath(p, real))
        return p

    def log_message(self, *args):       # без шуму в консолі
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8001
    handler = functools.partial(Handler, directory=ROOT)
    print("Сайт: http://localhost:%d%s" % (port, ("  (дані з " + DATA + ")") if DATA else ""))
    http.server.ThreadingHTTPServer(("", port), handler).serve_forever()
