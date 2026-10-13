"""Експеримент: як частота запусків рушія (режим A, та сама модель виконання) змінює результати 48 рахунків.
Усі каденції дивляться на ТІ САМІ дані (1-хвилинні свічки як жива ціна між закриттями) й закінчуються в той самий момент.
Очікування: 14 стратегій приймають рішення за закритими свічками й від каденції не залежать (лише час фіксації);
два «сканери» (setup_live, setup_dip) діють за живою ціною при кожному запуску, тому швидший запуск може змінити самі сигнали.
Результати режимів A (різні каденції) НЕ змішуються: кожна каденція має власне сховище."""
import json
import os
import time
from datetime import datetime, timezone

from . import compare, fixture
from . import engine_bridge as eb
from .shadow import ShadowEngine

SCANNERS = ("setup_live", "setup_dip")


def run_cadence(snap, kb, sk, start_ms, end_ms, step_min):
    sh = ShadowEngine(kb=kb, sk=sk, books=eb.books_from_snapshot(snap))
    t = start_ms
    n = 0
    t_ptf = 0.0
    while t <= end_ms:
        t0 = time.perf_counter()
        ptf = eb.ptf_from_rows(snap["klines"], kb, sk, t, live=True)
        t_ptf += time.perf_counter() - t0
        sh.step(ptf, datetime.fromtimestamp(t / 1000, timezone.utc))
        n += 1
        t += step_min * 60000
    if t - step_min * 60000 != end_ms:                                         # усі каденції закінчуються в один момент
        ptf = eb.ptf_from_rows(snap["klines"], kb, sk, end_ms, live=True)
        sh.step(ptf, datetime.fromtimestamp(end_ms / 1000, timezone.utc))
        n += 1
    return sh, {"steps": n, "step_mean_ms": round(1000 * sum(sh.step_times) / len(sh.step_times), 1), "ptf_build_mean_ms": round(1000 * t_ptf / max(1, n), 1)}


def summarize(sh):
    """Показники 48 рахунків і подій для порівняння каденцій."""
    acc = compare.accounts(sh.store.data)
    ev = compare.events_by_account(sh.store.data)
    out = {}
    for key, a in acc.items():
        evs = ev.get(key, [])
        out[key] = {"eq": a["eq"], "trades": a["trades"], "buys": sum(1 for e in evs if e["side"] == "BUY"), "sells": sum(1 for e in evs if e["side"] == "SELL"),
                    "exits": sorted({e.get("exit") for e in evs if e["side"] == "SELL"}), "open": a["open"], "curve_n": a["curve_n"]}
    return out


def experiment(snap=None, hours=14.0, cadences=(20, 10, 5, 1), end_margin_min=5):
    snap = snap or fixture.load()
    kb, sk = eb.load_kb(), eb.load_signals_kb()
    end_ms = snap["captured_at_ms"] - end_margin_min * 60000
    start_ms = end_ms - int(hours * 3600000)
    runs, meta = {}, {}
    for c in cadences:
        sh, m = run_cadence(snap, kb, sk, start_ms, end_ms, c)
        runs[c], meta[c] = summarize(sh), m
    base = cadences[0]
    rows = []
    for c in cadences[1:]:
        for key in sorted(runs[base]):
            a, b = runs[base][key], runs[c][key]
            rows.append({"cadence_min": c, "wallet": key[0], "rule": key[1], "scanner": key[1] in SCANNERS, "d_eq": round(b["eq"] - a["eq"], 6), "d_trades": b["trades"] - a["trades"],
                         "d_buys": b["buys"] - a["buys"], "d_sells": b["sells"] - a["sells"], "same_exits": a["exits"] == b["exits"]})
    return {"start_ms": start_ms, "end_ms": end_ms, "hours": hours, "baseline_min": base, "meta": meta, "rows": rows, "runs": {str(c): {"%d|%s" % k: v for k, v in r.items()} for c, r in runs.items()}}


def digest(res):
    """Підсумок по каденціях: у скількох рахунках змінилися угоди/капітал окремо для сканерів і решти."""
    out = {}
    for c in sorted({r["cadence_min"] for r in res["rows"]}):
        rs = [r for r in res["rows"] if r["cadence_min"] == c]
        for name, sel in (("scanners", [r for r in rs if r["scanner"]]), ("others", [r for r in rs if not r["scanner"]])):
            out["%d|%s" % (c, name)] = {"accounts": len(sel), "trades_changed": sum(1 for r in sel if r["d_trades"] != 0), "eq_changed": sum(1 for r in sel if abs(r["d_eq"]) > 1e-9),
                                        "max_abs_d_eq": max([abs(r["d_eq"]) for r in sel] or [0]), "d_trades_total": sum(r["d_trades"] for r in sel)}
    return out


if __name__ == "__main__":
    res = experiment()
    os.makedirs(os.path.join(eb.HERE, "logs"), exist_ok=True)
    path = os.path.join(eb.HERE, "logs", "cadence-experiment.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(res, f, ensure_ascii=False, indent=1)
    print(json.dumps({"meta": res["meta"], "digest": digest(res)}, ensure_ascii=False, indent=1))
