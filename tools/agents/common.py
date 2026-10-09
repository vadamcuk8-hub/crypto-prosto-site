"""Спільні дрібниці для агентів. Кожен агент — окремий файл із однією задачею; тут лише те, що їм усім потрібно."""
import json
import os
import time
import urllib.request
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DATA = os.path.join(ROOT, "data")
UA = "Mozilla/5.0 (compatible; CryptoSimpleAgents/1.0)"


def log(agent, msg):
    print("%s [%-11s] %s" % (time.strftime("%H:%M:%S"), agent, msg), flush=True)


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def fetch(url, timeout=25, accept="*/*"):
    """Завантажує адресу й повертає байти (єдине місце, де агенти ходять у мережу)."""
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": accept})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def get_json(url, timeout=25, retries=1):
    """Завантажує JSON. Одну невдалу спробу повторює (мережа інколи смикається)."""
    last = None
    for attempt in range(retries + 1):
        try:
            return json.loads(fetch(url, timeout, "application/json").decode("utf-8"))
        except Exception as ex:   # noqa: BLE001 — потрібна будь-яка помилка мережі чи розбору
            last = ex
            time.sleep(1.5)
    raise last


def downsample(values, n):
    """Залишає приблизно n рівномірно розкиданих значень (щоб графіки на сайті були легкими)."""
    if len(values) <= n:
        return list(values)
    step = (len(values) - 1) / float(n - 1)
    return [values[int(round(i * step))] for i in range(n)]


def write_json(name, obj):
    """Записує data/<name>.json атомарно: сайт ніколи не прочитає напівзаписаний файл."""
    os.makedirs(DATA, exist_ok=True)
    tmp = os.path.join(DATA, name + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, os.path.join(DATA, name))
