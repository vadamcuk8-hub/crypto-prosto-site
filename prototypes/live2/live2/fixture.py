"""Знімок реальних свічок і книг заявок Binance для відтворення чинного рушія (регресійні й порівняльні тести). Лише публічні REST-запити.
Зберігається тільки те, що читає рушій: час відкриття й ціна закриття свічки та книга заявок (глибина 100). Формат: fixtures/klines_snapshot.json.gz."""
import gzip
import json
import os
import time
import urllib.request

HOST = "https://data-api.binance.vision"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIXTURE_DIR = os.path.join(ROOT, "fixtures")
DEFAULT_PATH = os.path.join(FIXTURE_DIR, "klines_snapshot.json.gz")


def _get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "live2-prototype"})
    with urllib.request.urlopen(req, timeout=25) as r:
        return json.loads(r.read().decode())


def rest_klines(sym, tf, limit=1000):
    """[[openTime_ms, close], ...] — рівно те, що використовує рушій."""
    rows = _get("%s/api/v3/klines?symbol=%sUSDT&interval=%s&limit=%d" % (HOST, sym, tf, limit))
    return [[int(r[0]), float(r[4])] for r in rows]


def rest_depth(sym, limit=100):
    d = _get("%s/api/v3/depth?symbol=%sUSDT&limit=%d" % (HOST, sym, limit))
    return {"bids": [[float(a), float(b)] for a, b in d["bids"]], "asks": [[float(a), float(b)] for a, b in d["asks"]]}


def capture(path=DEFAULT_PATH, coins=None, tfs=None):
    from . import engine_bridge as eb
    kb = eb.load_kb()
    coins = coins or list(kb["paper_coins"])
    tfs = tfs or eb.needed_tfs(kb)
    t0 = time.time()
    snap = {"captured_at_ms": int(time.time() * 1000), "coins": coins, "tfs": tfs, "klines": {}, "books": {}}
    for s in coins:
        for tf in tfs:
            snap["klines"]["%s|%s" % (s, tf)] = rest_klines(s, tf, kb["paper_candles"])
        snap["books"][s] = rest_depth(s)
    snap["captured_at_end_ms"] = int(time.time() * 1000)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with gzip.open(path, "wt", encoding="utf-8") as f:
        json.dump(snap, f, separators=(",", ":"))
    return {"path": path, "seconds": round(time.time() - t0, 1), "bytes": os.path.getsize(path)}


def capture_1m(path=DEFAULT_PATH):
    """Додає до знімка 1-хвилинні свічки (≈16,7 год): жива ціна між закриттями старших свічок для експериментів із частотою запусків."""
    snap = load(path)
    for s in snap["coins"]:
        snap["klines"]["%s|1m" % s] = rest_klines(s, "1m", 1000)
    snap["captured_1m_at_ms"] = int(time.time() * 1000)
    with gzip.open(path, "wt", encoding="utf-8") as f:
        json.dump(snap, f, separators=(",", ":"))
    return {"path": path, "bytes": os.path.getsize(path)}


def load(path=DEFAULT_PATH):
    with gzip.open(path, "rt", encoding="utf-8") as f:
        return json.load(f)


if __name__ == "__main__":
    print(capture())
