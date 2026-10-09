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


def load_knowledge(name):
    """База знань агента: knowledge/<name>.json (правила, словники, виправлення; редагуються вручну)."""
    with open(os.path.join(ROOT, "knowledge", name + ".json"), encoding="utf-8") as f:
        return json.load(f)


DAILY_DAYS = 90      # свіжу історію тримаємо щодня
MAX_DAYS = 730       # усе, що старше за ~2 роки, видаляється


def compact_history(rows, today):
    """Самоочищення: останні 90 діб — щодня, старіші — одна точка на тиждень, давніші за 2 роки — видаляються.
    Так файл ніколи не росте безмежно (максимум близько 90 + 90 точок)."""
    keep, weekly = [], {}
    for r in rows:
        try:
            d = datetime.fromisoformat(r["date"]).date()
        except (KeyError, ValueError):
            continue
        age = (today - d).days
        if age > MAX_DAYS:
            continue
        if age <= DAILY_DAYS:
            keep.append(r)
        else:
            weekly[d.isocalendar()[:2]] = r      # з тижня лишається остання точка
    return sorted(weekly.values(), key=lambda r: r["date"]) + keep


def record_history(name, values):
    """Історія агента: data/history/<name>.json, одна точка на добу (повторний запуск за день оновлює точку), з автоочищенням."""
    path = os.path.join("history", name + ".json")
    try:
        with open(os.path.join(DATA, path), encoding="utf-8") as f:
            rows = json.load(f)
    except (OSError, ValueError):
        rows = []
    today = datetime.now(timezone.utc).date()
    if rows and rows[-1].get("date") == today.isoformat():
        rows[-1]["values"] = values
    else:
        rows.append({"date": today.isoformat(), "values": values})
    write_json(path, compact_history(rows, today))


STATE_FILE = "_kb_state.json"


def read_state(name):
    """Службовий стан агента (наприклад, коли востаннє спрацювало кожне правило бази знань)."""
    try:
        with open(os.path.join(DATA, STATE_FILE), encoding="utf-8") as f:
            return json.load(f).get(name, {})
    except (OSError, ValueError):
        return {}


def write_state(name, state):
    try:
        with open(os.path.join(DATA, STATE_FILE), encoding="utf-8") as f:
            all_state = json.load(f)
    except (OSError, ValueError):
        all_state = {}
    all_state[name] = state
    write_json(STATE_FILE, all_state)


def write_json(name, obj):
    """Записує data/<name>.json атомарно: сайт ніколи не прочитає напівзаписаний файл."""
    target = os.path.join(DATA, name)
    os.makedirs(os.path.dirname(target), exist_ok=True)
    tmp = target + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, target)
