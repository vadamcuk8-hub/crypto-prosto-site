"""Агент «Аналітик рішень і асистент».
Робить три речі:
  1. Порівнює періоди угод від 1 хвилини до 1 години: яку частку рухів свічки з'їдає комісія за коло «купівля → продаж».
  2. Аналізує рішення бота: що ставалося з ціною через 15 хв / 1 год / 4 год / добу після кожної купівлі й продажу (проти звичайного дрейфу),
     а також швидкі правила на історії годинних і 15-хвилинних свічок (з комісією й проти випадкової торгівлі).
  3. Асистент: перебирає налаштування правил (довжина середньої, поріг входу) на першій частині історії й чесно перевіряє найкраще
     на другій, яку він не бачив. Пропонує зміну лише якщо вона стабільно краща на перевірочній частині; усе пишеться в журнал.
Це міряння й пояснення, а не поради. Результат: data/analyst.json; журнал експериментів: data/_assistant_log.json (самоочищується)."""
import json
import os
import random
import statistics
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

from .agent_simulation import WARMUP, decide, fetch_tf, load, metrics, scores_series, sma_series
from .common import DATA, load_knowledge, now_iso, write_json
from .insights import item, num, pct

NAME = "analyst"
TITLE = "Аналітик рішень"
SOURCE = "Binance"
INTERVAL = 900
RUNS_LAST = True
LOG = "_assistant_log"
TF_MIN = {"1m": 1, "5m": 5, "15m": 15, "30m": 30, "1h": 60, "2h": 120, "1d": 1440}
TF_NAME = {"1m": "1 хвилині", "5m": "5 хвилинах", "15m": "15 хвилинах", "30m": "30 хвилинах", "1h": "1 годині", "2h": "2 годинах", "1d": "1 дню"}


def horizon_study(series, kb, fee, k):
    """Для кожного масштабу: типовий рух свічки проти комісії за коло (2 × fee)."""
    round_trip = 2 * fee
    out = []
    for tf in kb["frames"]:
        moves = []
        for sym in kb["coins"]:
            s = series.get((sym, tf))
            if s:
                c = s[0]
                moves += [abs(c[i] / c[i - 1] - 1) for i in range(1, len(c))]
        if not moves:
            continue
        med = statistics.median(moves)
        share = round(100 * sum(1 for m in moves if m > round_trip) / len(moves))
        tx = k.texts["frame_bad"] if med < round_trip / 2 and share < 20 else k.texts["frame_hard"] if share < 40 else k.texts["frame_ok"]
        out.append({"tf": tf, "median": round(100 * med, 4), "share": share, "fee": round(100 * round_trip, 3), "candles": len(moves),
                    "days": round(len(moves) / (1440 / TF_MIN[tf]) / max(1, len([1 for sym in kb["coins"] if series.get((sym, tf))])), 1),
                    "verdict": tx.format(frame=TF_NAME[tf], fee=pct(100 * round_trip, 1, signed=False) if False else "%s%%" % num(100 * round_trip, 2),
                                         med="%s%%" % num(100 * med, 3), share=share)})
    return out


def fast_rules(series, sim_kb, kb, fee, rnd):
    """Швидкі правила (годинні й 15-хвилинні) на всій доступній історії цих свічок: результат, «просто тримати», проти випадковості, угоди."""
    res = []
    for rule in sim_kb["strategies"]:
        if rule["tf"] == "1d" or rule["kind"] in ("random", "setup"):
            continue
        rows = []
        for sym in kb["coins"]:
            s = series.get((sym, rule["tf"]))
            if not s or len(s[0]) < WARMUP + 80:
                continue
            c = s[0]
            scores, s50 = scores_series(c, load_knowledge("signals")["weights"], load_knowledge("signals")["thresholds"])
            flags, pos = [False] * len(c), False
            for i in range(WARMUP, len(c) - 1):
                pos = bool(decide(rule, i, pos, scores, s50, c))
                flags[i] = pos
            m, _, _, _ = metrics(c, flags, WARMUP, fee, 120, rnd)
            m["days"] = round(m["days"] * TF_MIN[rule["tf"]] / 1440, 1)
            rows.append(m)
        if rows:
            med = lambda key: sorted(r[key] for r in rows)[len(rows) // 2]
            days = rows[0]["days"]
            res.append({"id": rule["id"], "title": rule["title"], "tf": rule["tf"], "invert": bool(rule.get("invert")), "coins": len(rows), "days": days,
                        "ret": med("ret"), "hold": med("hold"), "beat": med("beat"), "trades": med("trades"),
                        "trades_per_day": round(med("trades") / max(days, 0.1), 1), "fee_paid": round(med("trades") * fee * 100, 1)})
    return res


def forward_analysis(events, series, kb):
    """Що було з ціною після рішень бота (по 15-хвилинних свічках) і чи краще це за звичайний дрейф ринку."""
    out = []
    s15 = {sym: series.get((sym, "15m")) for sym in kb["coins"]}
    for h in kb["horizons_min"]:
        for side in ("BUY", "SELL"):
            vals, base = [], []
            for rid, evs in (events or {}).items():
                for e in evs:
                    if e["side"] != side or e["coin"] not in s15 or not s15[e["coin"]]:
                        continue
                    c, t = s15[e["coin"]]
                    target = e["candle"] + h * 60_000
                    if target > t[-1]:
                        continue                                     # ще не минув потрібний час
                    j = next((i for i, x in enumerate(t) if x >= e["candle"]), None)
                    k2 = next((i for i, x in enumerate(t) if x >= target), None)
                    if j is None or k2 is None:
                        continue
                    vals.append(100 * (c[k2] / c[j] - 1))
            for sym in kb["coins"]:                                  # дрейф ринку за такий самий час для порівняння
                if s15[sym]:
                    c, t = s15[sym]
                    step = max(1, h // 15)
                    base += [100 * (c[i + step] / c[i] - 1) for i in range(0, len(c) - step, 8)]
            if vals:
                good = [(-v if side == "SELL" else v) for v in vals]       # для продажу «добре», якщо ціна після нього падає
                out.append({"side": side, "horizon_min": h, "n": len(vals), "avg": round(sum(vals) / len(vals), 3), "good_pct": round(100 * sum(1 for g in good if g > 0) / len(good)),
                            "drift": round(sum(base) / len(base), 3) if base else None})
    return out


def trade_stats(events, fee):
    """Закриті угоди по правилах: прибуткових, середній результат, середній час утримання."""
    out = []
    for rid, evs in (events or {}).items():
        open_, trips = {}, []
        for e in sorted(evs, key=lambda x: x["candle"]):
            if e["side"] == "BUY":
                open_[e["coin"]] = e
            elif e["coin"] in open_:
                b = open_.pop(e["coin"])
                trips.append(((e["eq"] / (b["eq"] * (1 - fee)) - 1) * 100, (e["candle"] - b["candle"]) / 3600_000))
        if trips:
            out.append({"rule": rid, "n": len(trips), "wins": sum(1 for p, _ in trips if p > 0), "avg": round(sum(p for p, _ in trips) / len(trips), 3),
                        "hours": round(sum(h for _, h in trips) / len(trips), 1)})
    return out


def sweep(series, kb, fee, sig):
    """Асистент: перебір налаштувань на навчальній частині й чесна перевірка на решті (walk-forward)."""
    results = []
    for sym in kb["coins"]:
        s = series.get((sym, "1h"))
        if not s or len(s[0]) < WARMUP + 200:
            continue
        c = s[0]
        scores, s50 = scores_series(c, sig["weights"], sig["thresholds"])
        n = len(c)
        split = WARMUP + int((n - 1 - WARMUP) * kb["train_share"])
        cand = {}
        for L in kb["sma_options"]:
            sm = sma_series(c, L)
            cand["Тренд: середня за %d годин" % L] = [bool(sm[i] is not None and c[i] > sm[i]) for i in range(n)]
        for e in kb["score_enter_options"]:
            flags, pos = [False] * n, False
            for i in range(WARMUP, n - 1):
                pos = (scores[i] >= e) if not pos else (scores[i] >= e / 2)
                flags[i] = pos
            cand["Сигнал: вхід від %d" % e] = flags
        rnd = random.Random(3)
        table = {}
        for name, fl in cand.items():
            tr = metrics(c[:split + 1], fl[:split + 1], WARMUP, fee, 30, rnd)[0]["ret"]
            te = metrics(c, fl, split, fee, 30, rnd)[0]["ret"]
            table[name] = (tr, te)
        default = "Тренд: середня за 50 годин"
        best = max(table, key=lambda x: table[x][0])
        results.append({"coin": sym, "default": default, "best_train": best, "train": table[best][0], "test_best": table[best][1],
                        "test_default": table[default][1], "overfit": round(table[best][0] - table[best][1], 1)})
    return results


def run():
    kb = load_knowledge(NAME)
    sim_kb, sig = load_knowledge("simulation"), load_knowledge("signals")
    fee, k, rnd = sim_kb["fee"] + sim_kb.get("slippage", 0.0), Rules(NAME), random.Random(11)
    jobs = [(sym, tf) for sym in kb["coins"] for tf in kb["frames"]]
    with ThreadPoolExecutor(max_workers=6) as pool:
        got = dict(zip(jobs, pool.map(lambda j: fetch_tf(j[0], j[1], kb["candles"]), jobs)))
    series = {j: v for j, v in got.items() if v}
    if not series:
        raise RuntimeError("біржа не віддала свічки")
    events = load("paper_events")

    horizon = horizon_study(series, kb, fee, k)
    fast = fast_rules(series, sim_kb, kb, fee, rnd)
    fwd = forward_analysis(events, series, kb)
    stats = trade_stats(events, fee)
    exp = sweep(series, kb, fee, sig)

    # висновок асистента: пропонуємо лише якщо найкраще на навчанні стабільно краще за поточне на перевірці
    wins = [e for e in exp if e["best_train"] != e["default"] and e["test_best"] > e["test_default"] + kb["margin_pp"]]
    names = {}
    for e in wins:
        names[e["best_train"]] = names.get(e["best_train"], 0) + 1
    pick = max(names, key=names.get) if names else None
    if pick and names[pick] >= kb["need_coins"]:
        advice = k.texts["suggest"].format(param=pick, margin=kb["margin_pp"], n=names[pick], total=len(exp))
        suggestion = {"param": pick, "coins": names[pick], "total": len(exp)}
    else:
        advice, suggestion = k.texts["keep"].format(margin=kb["margin_pp"], need=kb["need_coins"]), None

    log = load(LOG) or []
    log.append({"at": now_iso(), "pick": pick, "wins": len(wins), "total": len(exp),
                "overfit": round(sum(e["overfit"] for e in exp) / len(exp), 1) if exp else None})
    log = log[-kb["log_size"]:]
    write_json(LOG + ".json", log)

    result = {"horizon": horizon, "fast": fast, "forward": fwd, "trades": stats, "assistant": {"experiments": exp, "advice": advice, "suggestion": suggestion,
              "log": log[-12:], "train_share": kb["train_share"], "margin": kb["margin_pp"]}, "fee_round_trip": round(100 * 2 * fee, 3), "updated": now_iso()}
    result["insights"] = insights(result, k, kb)
    return result


def insights(r, k, kb):
    out = []
    ok = [h for h in r["horizon"] if h["share"] >= 40]
    if r["horizon"]:
        worst, best = r["horizon"][0], r["horizon"][-1]
        out.append(item("negative" if worst["share"] < 20 else "neutral", worst["verdict"]))
        out.append(item("neutral", best["verdict"]))
        out.append(item("positive" if ok else "negative", "Періоди, де комісія не з'їдає більшість рухів: %s." % (", ".join(h["tf"] for h in ok) or "жодного з перевірених")))
    if r["forward"]:
        f = r["forward"][0]
        out.append(item("neutral", "Після рішень бота (%s, через %d хв): в середньому %s, «вдалих» %d%% із %d."
                        % ("купівля" if f["side"] == "BUY" else "продаж", f["horizon_min"], pct(f["avg"], 2), f["good_pct"], f["n"])))
    else:
        out.append(item("neutral", k.texts["wait_events"]))
    out.append(item("neutral", r["assistant"]["advice"]))
    return out


class Rules:
    def __init__(self, agent):
        self.texts = load_knowledge(agent)["texts"]


def summary(r):
    best = r["horizon"][-1] if r["horizon"] else {}
    return {"share_1h": best.get("share", 0), "suggest": 1 if r["assistant"]["suggestion"] else 0}
