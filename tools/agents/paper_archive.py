"""Повний архів ПІДТВЕРДЖЕНИХ подій Paper Trading (віртуальні угоди рушія симуляції) у data/paper_archive/.

Навіщо: журнал рішень рушія paper_events*.json тримає лише останні 40 подій на бота й гаманець, а жива стрічка live_feed.json: до 1000 подій.
Архів не обрізається за кількістю: події лежать у сегментах (місяць за часом події, а за великої кількості: частинами), старі сегменти незмінні.
Що НЕ робить: не вигадує й не відновлює втрачені операції (архів починається з того, що ще було в джерелах); не містить Binance Testnet; нічого не рахує
(лише копіює підтверджені рішення рушія в компактному вигляді; прибуток рахують споживачі за тими самими формулами, що й стрічка).

Файли: paper_archive/index.json (перелік сегментів, лічильники, політика) і paper_archive/<YYYY-MM>[-N].json.
Надійність: ID події той самий, що в живій стрічці (sim-<хеш>), тож повторний запуск, перезапис гілки data чи повторна доставка не створюють дублів;
запис кожного файлу атомарний, сегмент перед перезаписом копіюється в .prev.json, нечитабельний сегмент відкладається в .bad.json (а не перезаписується мовчки),
індекс будується з наявних сегментів, а не береться на віру."""
import json
import os
import re
import shutil
from datetime import datetime, timezone

from .common import DATA, now_iso, write_json

DIR = "paper_archive"
SCHEMA = 1
MAX_EVENTS_PER_SEGMENT = 15000          # ≈ 3 МБ у компактному вигляді: файл не росте безмежно, а нові події йдуть у наступну частину
MAX_TOTAL_MB = 12                       # попередження в індексі (check_data.py має власний ліміт на всю папку data)
KEEP = ("id", "t", "candle", "wallet", "bot", "coin", "type", "price", "eq", "w", "cost", "initial", "exit", "exit_info")
POLICY = ("Повний архів підтверджених віртуальних подій Paper Trading (source=sim). Події не видаляються й не змінюються; старіших за ті, що вже були втрачені "
          "до появи архіву, тут немає. Binance Testnet сюди не потрапляє. Це не біржові операції.")
NAME_RE = re.compile(r"^(\d{4}-\d{2})(?:-(\d+))?\.json$")


def _path(*parts):
    return os.path.join(DATA, DIR, *parts)


def compact(e):
    """Подія живої стрічки → компактний запис архіву (лише підтверджені поля рушія; текст причини не копіюється: він відтворюється з рішення)."""
    return {k: e[k] for k in KEEP if k in e and e[k] is not None}


def _month(t):
    return datetime.fromtimestamp(t / 1000, timezone.utc).strftime("%Y-%m")


def _seg_key(name):
    m = NAME_RE.match(name)
    return (m.group(1), int(m.group(2) or 1)) if m else None


def list_segments():
    try:
        names = os.listdir(_path())
    except OSError:
        return []
    return sorted((n[:-5] for n in names if NAME_RE.match(n)), key=lambda n: _seg_key(n + ".json"))


def _valid(d):
    return isinstance(d, dict) and d.get("v") == SCHEMA and isinstance(d.get("events"), list)


def _clean(e):
    return isinstance(e, dict) and isinstance(e.get("id"), str) and e["id"].startswith("sim-") and isinstance(e.get("t"), (int, float)) and not isinstance(e.get("t"), bool)


def load_segment(name):
    """(події, стан): 'ok' | 'missing' | 'bad'. Нечитабельний файл відкладається в .bad.json, подій із нього не вигадуємо."""
    p = _path(name + ".json")
    try:
        with open(p, encoding="utf-8") as f:
            d = json.load(f)
    except OSError:
        return [], "missing"
    except ValueError:
        d = None
    if not _valid(d):
        try:
            os.replace(p, _path(name + ".bad.json"))
        except OSError:
            pass
        try:                                                              # остання справна копія (.prev.json): відновлюємо з неї, а не губимо підтверджені події
            with open(_path(name + ".prev.json"), encoding="utf-8") as f:
                prev = json.load(f)
        except (OSError, ValueError):
            prev = None
        if _valid(prev):
            shutil.copyfile(_path(name + ".prev.json"), p)
            try:
                os.remove(_path(name + ".bad.json"))                      # нічого не втрачено: зіпсований файл не потрібен і не має вічно червонити перевірку
            except OSError:
                pass
            return [e for e in prev["events"] if _clean(e)], "restored"
        return [], "bad"
    return [e for e in d["events"] if _clean(e)], "ok"


def read_all():
    """Усі події архіву за часом (для споживачів і перевірок)."""
    out = []
    for n in list_segments():
        out.extend(load_segment(n)[0])
    return sorted(out, key=lambda e: (e["t"], e["id"]))


def _write_segment(name, month, events):
    p = _path(name + ".json")
    if os.path.exists(p):
        try:
            shutil.copyfile(p, _path(name + ".prev.json"))                   # попередня справна копія сегмента, що переписується
        except OSError:
            pass
    events = sorted(events, key=lambda e: (e["t"], e["id"]))
    write_json(os.path.join(DIR, name + ".json"), {"v": SCHEMA, "month": month, "count": len(events), "events": events})


def update(feed_events):
    """Дописує нові події (з live-стрічки: джерело sim) в архів. Повертає короткий звіт. Існуючі події не змінюються."""
    segs = {}
    states = {}
    try:                                                                  # залишки перерваного запису (write_json пише через .tmp)
        for n in os.listdir(_path()):
            if n.endswith(".tmp"):
                os.remove(_path(n))
    except OSError:
        pass
    for n in list_segments():
        segs[n], states[n] = load_segment(n)
    known = {e["id"] for evs in segs.values() for e in evs}
    new = []
    for e in feed_events:
        if e.get("source") != "sim" or not _clean(e) or e["id"] in known:
            continue
        known.add(e["id"])
        new.append(compact(e))
    changed = set()
    for e in sorted(new, key=lambda x: (x["t"], x["id"])):
        month = _month(e["t"])
        parts = [n for n in segs if _seg_key(n + ".json")[0] == month]
        parts.sort(key=lambda n: _seg_key(n + ".json")[1])
        target = parts[-1] if parts else None
        if target is None or len(segs[target]) >= MAX_EVENTS_PER_SEGMENT:
            target = month if target is None else "%s-%d" % (month, _seg_key(target + ".json")[1] + 1)
            segs[target] = []
        segs[target].append(e)
        changed.add(target)
    for n in sorted(changed):
        _write_segment(n, _seg_key(n + ".json")[0], segs[n])
    index_keys = sorted(segs, key=lambda n: _seg_key(n + ".json"))
    meta = []
    total_bytes = 0
    for n in index_keys:
        try:
            size = os.path.getsize(_path(n + ".json"))
        except OSError:
            size = 0
        total_bytes += size
        ts = [e["t"] for e in segs[n]]
        meta.append({"name": n, "month": _seg_key(n + ".json")[0], "count": len(segs[n]), "first_t": min(ts) if ts else None, "last_t": max(ts) if ts else None, "bytes": size})
    try:
        with open(_path("index.json"), encoding="utf-8") as f:
            old_idx = json.load(f)
    except (OSError, ValueError):
        old_idx = None
    if changed or not isinstance(old_idx, dict) or old_idx.get("segments") != meta:     # індекс завжди відповідає наявним сегментам (у т.ч. після обриву між записом сегмента й індексу)
        write_json(os.path.join(DIR, "index.json"), {"v": SCHEMA, "updated": now_iso(), "policy": POLICY, "total": sum(m["count"] for m in meta), "bytes": total_bytes,
                                                      "size_warning": total_bytes > MAX_TOTAL_MB * 1e6, "segments": meta})
    for n in list_segments():                                              # .prev лишаємо лише біля останнього сегмента: старі не мають розростатися
        if n != (index_keys[-1] if index_keys else None):
            try:
                os.remove(_path(n + ".prev.json"))
            except OSError:
                pass
    return {"added": len(new), "total": sum(len(v) for v in segs.values()), "segments": len(segs), "bad": sorted(n for n, s in states.items() if s == "bad")}
