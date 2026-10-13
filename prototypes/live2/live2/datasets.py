"""C2.0: набори ринкових даних для детермінованого відтворення чинного рушія. Лише РЕАЛЬНІ публічні дані Binance REST (klines з пагінацією за endTime, depth);
жодних вигаданих, інтерпольованих чи «залатаних» значень: якщо свічки немає, вона лишається відсутньою й фіксується в manifest (gaps).

Для кожного моменту оцінювання рушій бачить рівно 1000 останніх свічок кожного масштабу (як у справжньому REST-запиті), тож для вікна оцінювання довжиною H годин
зберігається 1000 + H/TF свічок. «Жива» ціна відкритої свічки береться з реальних 1-хвилинних свічок (остання повністю закрита хвилина ≤ now): без заглядання вперед.
Контрольні суми рахуються від КАНОНІЧНОГО JSON (а не від gzip, у якому є мітка часу), тому відтворювані."""
import gzip
import hashlib
import json
import math
import os
import threading
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor

from . import engine_bridge as eb

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
C20_DIR = os.path.join(ROOT, "fixtures", "c20")
HOST = "https://data-api.binance.vision"
TF_MIN = {"1m": 1, "15m": 15, "30m": 30, "1h": 60, "2h": 120, "1d": 1440}
STEP_MIN = 20


def canon(obj):
    return json.dumps(obj, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def sha(obj):
    return hashlib.sha256(canon(obj)).hexdigest()


def file_sha(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


_lock = threading.Lock()
_last = [0.0]


def _get(url, min_interval=0.25):
    """GET JSON із загальним обмеженням частоти (≈4 запити/с) і повторами."""
    last_err = None
    for attempt in range(5):
        with _lock:
            wait = _last[0] + min_interval - time.time()
            if wait > 0:
                time.sleep(wait)
            _last[0] = time.time()
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "live2-c20"})
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read().decode())
        except Exception as e:  # noqa: BLE001
            last_err = e
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError("REST недоступний: %s (%s)" % (url, last_err))


def fetch_klines(sym, tf, end_ms, count):
    """Рівно `count` останніх свічок із openTime ≤ end_ms (пагінація назад через endTime). Повертає [[openTime, close], ...] за зростанням."""
    rows, end = [], end_ms
    while len(rows) < count:
        need = min(1000, count - len(rows))
        raw = _get("%s/api/v3/klines?symbol=%sUSDT&interval=%s&limit=%d&endTime=%d" % (HOST, sym, tf, need, end))
        if not raw:
            break
        page = [[int(r[0]), float(r[4])] for r in raw]
        rows = page + rows
        end = page[0][0] - 1
        if len(raw) < need:
            break
    return rows


def fetch_depth(sym):
    d = _get("%s/api/v3/depth?symbol=%sUSDT&limit=100" % (HOST, sym))
    return {"bids": [[float(a), float(b)] for a, b in d["bids"]], "asks": [[float(a), float(b)] for a, b in d["asks"]]}


def eval_times(meta):
    n = int(meta["eval_hours"] * 60 // meta["step_min"])
    start = meta["end_ms"] - n * meta["step_min"] * 60000
    return [start + i * meta["step_min"] * 60000 for i in range(n + 1)]


def capture(ds_id, end_ms, eval_hours=72, with_books=False, note="", step_min=STEP_MIN, base_dir=C20_DIR):
    """Збирає набір даних і записує його в fixtures/c20/<id>/. Помилка REST переривається без часткових файлів."""
    kb, sk = eb.load_kb(), eb.load_signals_kb()
    coins = list(kb["paper_coins"])
    tfs = eb.needed_tfs(kb) + ["1d"]
    end_ms = end_ms - end_ms % 60000
    start_eval = end_ms - int(eval_hours * 3600000)
    jobs = []
    for s in coins:
        for tf in tfs:
            jobs.append((s, tf, kb["paper_candles"] + math.ceil(eval_hours * 60 / TF_MIN[tf]) + 3))
        jobs.append((s, "1m", math.ceil(eval_hours * 60) + 3))
    out = {}

    def one(j):
        s, tf, n = j
        return "%s|%s" % (s, tf), fetch_klines(s, tf, end_ms, n)
    with ThreadPoolExecutor(4) as ex:
        for key, rows in ex.map(one, jobs):
            out[key] = rows
    gaps = {}
    for key, rows in out.items():
        tf = key.split("|")[1]
        ms = TF_MIN[tf] * 60000
        holes = [[a[0], b[0]] for a, b in zip(rows, rows[1:]) if b[0] - a[0] != ms]
        if holes:
            gaps[key] = holes[:20]
    books = {s: fetch_depth(s) for s in coins} if with_books else None
    meta = {"id": ds_id, "note": note, "end_ms": end_ms, "eval_hours": eval_hours, "step_min": step_min, "coins": coins, "tfs": tfs, "captured_at_ms": int(time.time() * 1000),
            "source": HOST + "/api/v3/klines (limit ≤ 1000, endTime), /api/v3/depth", "window_candles": kb["paper_candles"], "gaps": gaps,
            "rows": {k: {"n": len(v), "first": v[0][0], "last": v[-1][0]} for k, v in out.items()}, "books_captured_at_ms": int(time.time() * 1000) if with_books else None}
    d = os.path.join(base_dir, ds_id)
    os.makedirs(d, exist_ok=True)
    write_json_gz(os.path.join(d, "klines.json.gz"), out)
    write_json(os.path.join(d, "kb.json"), kb)
    write_json(os.path.join(d, "sk.json"), sk)
    if books:
        write_json(os.path.join(d, "books.json"), books)
    meta["sha256"] = {"klines": sha(out), "kb": sha(kb), "sk": sha(sk), "books": sha(books) if books else None, "step_times": sha(eval_times(meta))}
    write_json(os.path.join(d, "meta.json"), meta)
    return meta


def write_json(path, obj):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))


def write_json_gz(path, obj):
    with gzip.GzipFile(path, "wb", mtime=0) as f:
        f.write(json.dumps(obj, separators=(",", ":")).encode("utf-8"))


def read_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def read_json_gz(path):
    with gzip.open(path, "rb") as f:
        return json.loads(f.read().decode("utf-8"))


def load(ds_id, base_dir=C20_DIR):
    d = os.path.join(base_dir, ds_id)
    meta = read_json(os.path.join(d, "meta.json"))
    ds = {"meta": meta, "klines": read_json_gz(os.path.join(d, "klines.json.gz")), "kb": read_json(os.path.join(d, "kb.json")), "sk": read_json(os.path.join(d, "sk.json")), "dir": d}
    ds["books"] = read_json(os.path.join(d, "books.json")) if os.path.exists(os.path.join(d, "books.json")) else None
    return ds


def verify_integrity(ds):
    """Контрольні суми вхідних даних наборів: повертає список розбіжностей (порожній = цілісно)."""
    m = ds["meta"]["sha256"]
    bad = []
    for name, obj in (("klines", ds["klines"]), ("kb", ds["kb"]), ("sk", ds["sk"])):
        if sha(obj) != m[name]:
            bad.append(name)
    if (m["books"] is None) != (ds["books"] is None) or (ds["books"] is not None and sha(ds["books"]) != m["books"]):
        bad.append("books")
    if sha(eval_times(ds["meta"])) != m["step_times"]:
        bad.append("step_times")
    return bad
