"""Порівняння станів двох рушіїв (еталон і тіньовий) по всіх 48 рахунках. Кожна розбіжність повертається з рахунком, полем і значеннями, щоб її можна було пояснити."""
import json
import os

CAPS = (100, 1000, 10000)


def tag_of(cap, mid=1000):
    return "" if cap == mid else "_%d" % cap


def load_dir(directory):
    """Усі *.json папки як словник {ім'я без розширення: об'єкт}."""
    out = {}
    for fn in os.listdir(directory):
        if fn.endswith(".json") and not fn.startswith("_timings"):
            with open(os.path.join(directory, fn), encoding="utf-8") as f:
                out[fn[:-5]] = json.load(f)
    return out


def accounts(data, caps=CAPS, mid=1000):
    """Рядки 48 рахунків {(гаманець, правило): показники} зі стану _paper*.json."""
    rows = {}
    for cap in caps:
        st = data.get("_paper" + tag_of(cap, mid)) or {}
        for rid, sd in (st.get("strategies") or {}).items():
            last = sd.get("last") or [None, None, None]
            rows[(cap, rid)] = {"eq": last[1], "hold": last[2], "ts": last[0], "trades": sd.get("trades"), "curve_n": len(sd.get("curve") or []),
                                "open": sorted(k for k, x in (sd.get("coins") or {}).items() if x.get("pos")),
                                "coins": {k: {kk: x.get(kk) for kk in ("pos", "eq", "hold", "entry", "peak", "px", "t", "cool", "blocked")} for k, x in (sd.get("coins") or {}).items()}}
    return rows


def events_by_account(data, caps=CAPS, mid=1000):
    out = {}
    for cap in caps:
        ev = data.get("paper_events" + tag_of(cap, mid)) or {}
        for rid, lst in ev.items():
            out[(cap, rid)] = lst
    return out


def diff(a, b, caps=CAPS, mid=1000, tol=0.0):
    """Список розбіжностей між двома словниками даних. tol — допустима абсолютна різниця чисел (0 = точний збіг)."""
    diffs = []
    ra, rb = accounts(a, caps, mid), accounts(b, caps, mid)
    for key in sorted(set(ra) | set(rb)):
        x, y = ra.get(key), rb.get(key)
        if x is None or y is None:
            diffs.append({"account": key, "field": "exists", "a": x is not None, "b": y is not None})
            continue
        for f in ("eq", "hold", "ts", "trades", "curve_n", "open"):
            if not _same(x[f], y[f], tol):
                diffs.append({"account": key, "field": f, "a": x[f], "b": y[f]})
        for sym in sorted(set(x["coins"]) | set(y["coins"])):
            cx, cy = x["coins"].get(sym), y["coins"].get(sym)
            if cx is None or cy is None or any(not _same(cx[k], cy[k], tol) for k in cx):
                diffs.append({"account": key, "field": "coin:" + sym, "a": cx, "b": cy})
    ea, eb_ = events_by_account(a, caps, mid), events_by_account(b, caps, mid)
    for key in sorted(set(ea) | set(eb_)):
        la, lb = ea.get(key, []), eb_.get(key, [])
        if len(la) != len(lb) or any(not _same(p, q, tol) for p, q in zip(la, lb)):
            diffs.append({"account": key, "field": "events", "a": len(la), "b": len(lb)})
    return diffs


def curves_equal(a, b, caps=CAPS, mid=1000):
    for cap in caps:
        sa, sb = (a.get("_paper" + tag_of(cap, mid)) or {}).get("strategies", {}), (b.get("_paper" + tag_of(cap, mid)) or {}).get("strategies", {})
        if {k: v.get("curve") for k, v in sa.items()} != {k: v.get("curve") for k, v in sb.items()}:
            return False
    return True


def _same(x, y, tol):
    if isinstance(x, (int, float)) and isinstance(y, (int, float)) and not isinstance(x, bool):
        return abs(x - y) <= tol
    if isinstance(x, dict) and isinstance(y, dict):
        return set(x) == set(y) and all(_same(x[k], y[k], tol) for k in x)
    if isinstance(x, (list, tuple)) and isinstance(y, (list, tuple)):
        return len(x) == len(y) and all(_same(p, q, tol) for p, q in zip(x, y))
    return x == y
