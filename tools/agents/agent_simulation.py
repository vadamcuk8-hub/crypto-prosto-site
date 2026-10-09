"""Агент «Симуляція»: що було б, якби торгувати за сигналами на реальній історії цін Binance (щоденні свічки, до ~1000 днів).
Для кожної монети й правила (knowledge/simulation.json) рахує результат за періоди 180 / 365 днів і всю історію: підсумок, порівняння з «купив і
тримав», максимальне просідання, угоди й порівняння з випадковою торгівлею з такою самою часткою часу в ринку. Комісія враховується.
Це не прогноз і не порада: показує, як правила працювали в минулому. Результат: data/simulation.json (оновлюється раз на cache_hours)."""
import json
import os
import random
import statistics
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone

from .agent_signals import HOSTS, ema_series, indicators, score_of
from .common import get_json
from .common import DATA, load_knowledge, now_iso, write_json
from .insights import item, num, pct

NAME = "simulation"
TITLE = "Симуляція торгівлі"
SOURCE = "Binance"
INTERVAL = 120
RUNS_LAST = True        # після «Картини» і «Звіту», перед агентом тестової біржі, який читає його рішення
WARMUP = 199            # перший день, для якого вже є середня за 200 днів
PAPER = "_paper"        # стан паперового рахунку (віртуальна торгівля вперед у часі)
CURVE_DAYS = 400


def fetch_tf(sym, tf, limit):
    """Свічки монети на Binance: (ціни закриття, час відкриття в мс) або None. tf: 15m, 1h, 1d."""
    for host in HOSTS:
        try:
            rows = get_json("%s/api/v3/klines?symbol=%sUSDT&interval=%s&limit=%d" % (host, sym, tf, limit), retries=0)
            if len(rows) >= WARMUP + 60:
                return [float(r[4]) for r in rows], [int(r[0]) for r in rows]
        except Exception:    # noqa: BLE001 — пробуємо наступне джерело
            pass
    return None


# ---------- Індикатори рядами (за один прохід замість перерахунку на кожен день) ----------
def rsi_series(c, n=14):
    out = [50.0] * len(c)
    if len(c) <= n:
        return out
    gains = sum(max(c[i] - c[i - 1], 0) for i in range(1, n + 1))
    losses = sum(max(c[i - 1] - c[i], 0) for i in range(1, n + 1))
    ag, al = gains / n, losses / n
    out[n] = 100.0 if al == 0 else 100 - 100 / (1 + ag / al)
    for i in range(n + 1, len(c)):
        d = c[i] - c[i - 1]
        ag = (ag * (n - 1) + max(d, 0)) / n
        al = (al * (n - 1) + max(-d, 0)) / n
        out[i] = 100.0 if al == 0 else 100 - 100 / (1 + ag / al)
    return out


def sma_series(c, n):
    out, s = [None] * len(c), 0.0
    for i, v in enumerate(c):
        s += v
        if i >= n:
            s -= c[i - n]
        if i >= n - 1:
            out[i] = s / n
    return out


def scores_series(c, w, t):
    """Оцінка сигналу (як в агенті «Сигнали») для кожного дня, де вже є середня за 200 днів."""
    s50, s200, rsi = sma_series(c, 50), sma_series(c, 200), rsi_series(c)
    macd = [a - b for a, b in zip(ema_series(c, 12), ema_series(c, 26))]
    sig = ema_series(macd, 9)
    out = [None] * len(c)
    for i in range(WARMUP, len(c)):
        ind = {"price": c[i], "sma50": s50[i], "sma200": s200[i], "rsi": rsi[i], "macd": macd[i] - sig[i],
               "mom30": 100 * (c[i] / c[i - 30] - 1) if i > 30 else 0.0}
        out[i] = score_of(ind, w, t)[0]
    return out, s50


# ---------- Симуляція ----------
def decide(rule, i, pos, score, s50, c, key=None):
    """Чи бути в монеті після закриття свічки i. Обернене правило (invert) робить протилежне: контроль, чи несе сигнал інформацію.
    Правило «random» ухвалює рішення навмання (але відтворювано: від id правила й ключа свічки): це контроль без жодних індикаторів."""
    if rule["kind"] == "random":
        r = random.Random("%s|%s" % (rule["id"], key)).random()
        return (r < rule["p_enter"]) if not pos else (r >= rule["p_exit"])
    inv = rule.get("invert")
    if rule["kind"] == "sma50":
        return (c[i] < s50[i]) if inv else (c[i] > s50[i])
    sc = score[i]
    if inv:
        return (sc <= -rule["enter"]) if not pos else (sc <= -rule["exit"])
    return (sc >= rule["enter"]) if not pos else (sc >= rule["exit"])


def run_flags(c, flags, d0, fee):
    """Крива капіталу за готовими позиціями (flags[i] — у монеті з закриття дня i до закриття дня i+1). Повертає (крива, угоди)."""
    eq, e, pos, trades = [1.0], 1.0, False, []
    for i in range(d0, len(c) - 1):
        want = flags[i]
        if want != pos:
            e *= 1 - fee
            trades.append((i - d0, 1 if want else -1, c[i]))
            pos = want
        if pos:
            e *= c[i + 1] / c[i]
        eq.append(e)
    return eq, trades


def max_drawdown(eq):
    peak, dd = eq[0], 0.0
    for v in eq:
        peak = max(peak, v)
        dd = min(dd, v / peak - 1)
    return dd


def metrics(c, flags, d0, fee, runs, rnd):
    eq, trades = run_flags(c, flags, d0, fee)
    days = len(c) - 1 - d0
    inm = [flags[i] for i in range(d0, len(c) - 1)]
    tim = sum(inm) / max(1, len(inm))
    pairs, wins, buy = 0, 0, None
    for _, side, price in trades:
        if side == 1:
            buy = price
        elif buy:
            pairs += 1
            wins += price / buy - 1 > 2 * fee
            buy = None
    hold = [(c[d0 + k] / c[d0]) * (1 - fee) for k in range(days + 1)]
    # випадкова торгівля: ті самі відрізки «в ринку» і «в готівці» (а отже, та сама кількість угод і комісій), але в випадковому порядку
    rl = []
    for v in inm:
        if rl and rl[-1][0] == v:
            rl[-1][1] += 1
        else:
            rl.append([v, 1])
    rets = []
    for _ in range(runs):
        order = rl[:]
        rnd.shuffle(order)
        shuffled = [v for v, ln in order for _ in range(ln)]
        e, pos = 1.0, False
        for k, want in enumerate(shuffled):
            if want != pos:
                e *= 1 - fee
                pos = want
            if pos:
                e *= c[d0 + k + 1] / c[d0 + k]
        rets.append(e - 1)
    rets.sort()
    beat = round(100 * sum(1 for r in rets if r < eq[-1] - 1) / len(rets))
    return {"ret": round(100 * (eq[-1] - 1), 1), "hold": round(100 * (hold[-1] - 1), 1), "dd": round(100 * max_drawdown(eq), 1),
            "hold_dd": round(100 * max_drawdown(hold), 1), "trades": len(trades), "rounds": pairs, "wins": wins,
            "time": round(100 * tim), "rnd_med": round(100 * rets[len(rets) // 2], 1), "beat": beat, "days": days}, eq, hold, trades



# ---------- Журнал рішень: коли, чому й на що спирався бот ----------
EVENTS = "paper_events"
EVENTS_PER_RULE = 40
UNIT = {"1d": "днів", "2h": "свічок по 2 години", "1h": "годин", "30m": "свічок по 30 хвилин", "15m": "свічок по 15 хвилин"}


def explain(rule, side, ind, score, why=None):
    """Пояснення рішення людською мовою: яка умова правила спрацювала й з якими числами."""
    u = UNIT.get(rule["tf"], "свічок")
    if why and why[0] in ("stop", "take"):
        move = num(abs(why[2]), 2)
        return ("Стоп-лос: ціна %s на %s%% нижча за ціну купівлі %s (поріг %s%%): виходимо, щоб обмежити збиток." % (num(ind["price"], 2 if ind["price"] >= 100 else 4), move, num(why[1], 2 if why[1] >= 100 else 4), rule["stop"])) \
            if why[0] == "stop" else ("Тейк-профіт: ціна %s на %s%% вища за ціну купівлі %s (поріг %s%%): фіксуємо прибуток." % (num(ind["price"], 2 if ind["price"] >= 100 else 4), move, num(why[1], 2 if why[1] >= 100 else 4), rule["take"]))
    if rule["kind"] == "random":
        return "Випадкове рішення контрольного бота (без індикаторів): %s." % ("купує" if side == "BUY" else "виходить у готівку")
    p, s50 = num(ind["price"], 2 if ind["price"] >= 100 else 4), num(ind["sma50"], 2 if ind["sma50"] >= 100 else 4)
    inv, buy = bool(rule.get("invert")), side == "BUY"
    if rule["kind"] == "sma50":
        if not inv:
            return ("Ціна %s піднялась вище середньої за 50 %s (%s): тренд угору, правило купує." % (p, u, s50)) if buy else \
                   ("Ціна %s опустилась нижче середньої за 50 %s (%s): тренд зламано, правило виходить у готівку." % (p, u, s50))
        return ("Ціна %s нижче середньої за 50 %s (%s): обернене правило купує падіння." % (p, u, s50)) if buy else \
               ("Ціна %s піднялась вище середньої за 50 %s (%s): обернене правило виходить." % (p, u, s50))
    parts = "RSI %s, імпульс MACD %s, зміна за 30 свічок %s%%" % (num(ind["rsi"], 0), "вгору" if ind["macd"] > 0 else "вниз", num(ind["mom30"], 1))
    if not inv:
        return ("Оцінка сигналу %d досягла порогу входу %d (%s)." % (score, rule["enter"], parts)) if buy else \
               ("Оцінка сигналу впала до %d, нижче порогу виходу %d (%s)." % (score, rule["exit"], parts))
    return ("Оцінка сигналу %d нижча за −%d («перевага продавців»): обернене правило купує слабкість (%s)." % (score, rule["enter"], parts)) if buy else \
           ("Оцінка сигналу піднялась до %d, вище −%d: обернене правило виходить (%s)." % (score, rule["exit"], parts))


def make_event(rule, sym, side, c, k, scores, tstamp, ctx, now, eq, initial=False, w=None, why_info=None):
    ind = indicators(c[:k + 1])
    sc = scores[k] if scores[k] is not None else 0
    why = explain(rule, side, ind, sc, why_info)
    if initial:
        why = "Початкова позиція на старті раунду. " + why
    return {"at": now.isoformat(timespec="minutes"), "candle": tstamp[k], "coin": sym, "side": side, "price": c[k], "rule": rule["id"], "tf": rule["tf"],
            "w": w,
            "eq": round(eq, 5),                      # скільки було на рахунку цієї монети (1.0 = стартова частка): звідси кількість і прибуток угоди
            "reason": why, "ind": {"price": ind["price"], "sma50": ind["sma50"], "sma200": ind["sma200"], "rsi": round(ind["rsi"], 1),
                                   "macd": round(ind["macd"], 6), "mom30": round(ind["mom30"], 2), "score": sc},
            "ctx": ctx.get(sym)}


def outlook_context():
    """Контекст із агента «Картина» на момент рішення: правило його не використовує, але це показує, що було навколо."""
    o = load("outlook") or {}
    out = {}
    for c in o.get("coins", []):
        h = (c.get("headlines") or [None])[0]
        out[c["symbol"]] = {"label": c["label"], "score": c["score"], "headline": h["title"] if h else None, "link": h["link"] if h else None,
                            "tone": h["tone"] if h else None}
    return out


# ---------- Паперовий рахунок: ті самі правила, але вперед у часі, на віртуальних грошах ----------
def volatility_weights(series):
    """Ваги монет обернено до мінливості (спокійніші отримують більше): від стандартного відхилення останніх 200 змін ціни."""
    inv = {}
    for sym, (c, t, scores, s50) in series.items():
        rets = [c[i] / c[i - 1] - 1 for i in range(max(1, len(c) - 200), len(c) - 1)]
        sd = statistics.pstdev(rets) if len(rets) > 5 else 0
        inv[sym] = 1 / sd if sd > 0 else 0
    tot = sum(inv.values())
    return {sym: (v / tot if tot else 1.0 / len(series)) for sym, v in inv.items()}


def paper_wallets(ptf, kb, now):
    """Три гаманці торгують ОКРЕМО й різними монетами (kb["wallets"]: {"100": [...], ...}): у кожного свій стан, журнал і раунд.
    Гаманець середньої суми пишеться в основні файли (_paper.json, paper_events.json), решта: з суфіксом суми.
    Без kb["wallets"] працює один спільний паперовий рахунок."""
    wl = kb.get("wallets")
    if not wl:
        return paper_update(ptf, kb, now)
    caps = [int(c) for c in kb["accounts"]]
    mid = caps[min(1, len(caps) - 1)]
    res = {}
    for cap in caps:
        coins = set(wl.get(str(cap)) or kb["paper_coins"])
        sub = {tf: {s: v for s, v in ser.items() if s in coins} for tf, ser in ptf.items()}
        res[cap] = paper_update(sub, dict(kb, accounts=[cap]), now, tag="" if cap == mid else "_%d" % cap)
        res[cap]["cap"] = cap
        res[cap]["accounts"] = caps
    main = res[mid]
    main["wallets"] = {str(c): r for c, r in res.items() if c != mid}
    main["wallet_coins"] = {str(c): r["coins"] for c, r in res.items()}
    return main


def paper_update(ptf, kb, now, tag=""):
    """Цілодобова перевірка вперед у часі на віртуальних грошах.
    ptf: {масштаб свічок: {монета: (ціни, час відкриття, оцінки, SMA50)}}. Рішення ухвалюються за ЗАКРИТИМИ свічками масштабу правила,
    а вартість рахунку оцінюється при кожному запуску за поточною ціною (точка на кривій). Раунд триває round_days днів (або до
    first_round_end), потім іде в архів. Витрати на угоду = комісія + ковзання. Правила можуть мати стоп-лос/тейк-профіт (stop/take у %)
    і розмір позиції за мінливістю (sizing: vol). Відсотки однакові для будь-якої суми; долари множить сайт.
    Стан у data/_paper.json, журнал рішень у data/paper_events.json; крива й архів обмежені (самоочищення)."""
    fee = kb["fee"] + kb.get("slippage", 0.0)
    st = load(PAPER + tag) or {}
    ctx, events = outlook_context(), load(EVENTS + tag) or {}
    rd = st.get("round")
    if rd and now >= datetime.fromisoformat(rd["end"]):                      # раунд завершено: архівуємо
        st.setdefault("history", []).append({"start": rd["start"], "end": rd["end"], "capital": kb["accounts"],
                                             "strategies": {k: {"eq": v["last"][1], "hold": v["last"][2], "trades": v["trades"]}
                                                            for k, v in st.get("strategies", {}).items() if v.get("last")}})
        st["history"] = st["history"][-kb["history_rounds"]:]
        rd, st["strategies"] = None, {}
    if not rd:
        end = now + timedelta(days=kb["round_days"])
        fixed = kb.get("first_round_end")
        if fixed and not st.get("history"):                    # перший раунд триває до заданої дати, а далі: по round_days
            fixed_dt = datetime.fromisoformat(fixed)
            if fixed_dt > now:
                end = fixed_dt.astimezone(timezone.utc)
        rd = st["round"] = {"start": now.isoformat(timespec="minutes"), "end": end.isoformat(timespec="minutes")}
        st["strategies"] = {}
    out = {}
    for rule in kb["strategies"]:
        series = ptf.get(rule["tf"], {})
        if not series:
            continue
        sd = st["strategies"].setdefault(rule["id"], {"coins": {}, "curve": [], "trades": 0, "last": None})
        if "w" not in sd:                                       # ваги монет фіксуємо на старті раунду (інакше рахунок «стрибав» би)
            sd["w"] = volatility_weights(series) if rule.get("sizing") == "vol" else {sym: 1.0 / len(series) for sym in series}
        marks = []
        for sym, (c, t, scores, s50) in series.items():
            n, closed = len(c), len(c) - 2                       # останній елемент: поточна незакрита свічка
            w = sd["w"].get(sym, 1.0 / len(series))
            co = sd["coins"].get(sym)
            if co is None:
                pos = bool(decide(rule, closed, False, scores, s50, c, (sym, t[closed])))
                co = {"pos": pos, "eq": (1 - fee) if pos else 1.0, "hold": 1 - fee, "t": t[closed], "entry": c[closed] if pos else None, "blocked": False}
                sd["trades"] += 1 if pos else 0
                if pos:
                    events.setdefault(rule["id"], []).append(make_event(rule, sym, "BUY", c, closed, scores, t, ctx, now, 1.0, initial=True, w=round(w, 4)))
            else:
                for k in range(1, closed + 1):
                    if t[k] <= co["t"]:
                        continue
                    r = c[k] / c[k - 1]
                    if co["pos"]:
                        co["eq"] *= r
                    co["hold"] *= r
                    raw = bool(decide(rule, k, co["pos"], scores, s50, c, (sym, t[k])))
                    want, info = raw, None
                    if co.get("blocked"):                                # після стопу чи тейку чекаємо нового сигналу, а не купуємо одразу знову
                        if not raw:
                            co["blocked"] = False
                        want = False
                    elif co["pos"] and want and co.get("entry"):
                        chg = c[k] / co["entry"] - 1
                        if rule.get("stop") and chg <= -rule["stop"] / 100:
                            want, info, co["blocked"] = False, ("stop", co["entry"], 100 * chg), True
                        elif rule.get("take") and chg >= rule["take"] / 100:
                            want, info, co["blocked"] = False, ("take", co["entry"], 100 * chg), True
                    if want != co["pos"]:
                        eq_before = co["eq"]
                        co["eq"] *= 1 - fee
                        co["pos"] = want
                        co["entry"] = c[k] if want else None
                        sd["trades"] += 1
                        events.setdefault(rule["id"], []).append(make_event(rule, sym, "BUY" if want else "SELL", c, k, scores, t, ctx, now,
                                                                            eq_before if want else co["eq"], w=round(w, 4), why_info=info))
                    co["t"] = t[k]
            sd["coins"][sym] = co
            live = c[-1] / c[closed]                              # поточна ціна відносно останнього закриття: оцінка «на зараз»
            marks.append((w * co["eq"] * (live if co["pos"] else 1.0), co["hold"] * live / len(series)))
        if marks:
            eq = round(sum(m[0] for m in marks), 5)
            hold = round(sum(m[1] for m in marks), 5)
            ts = now.isoformat(timespec="minutes")
            sd["last"] = [ts, eq, hold]
            sd["curve"] = ([r for r in sd["curve"] if r[0] != ts] + [sd["last"]])[-kb["curve_points"]:]
            state = {sym: [1 if x["pos"] else 0, round(x["eq"], 5), round(x["hold"], 5), series[sym][0][len(series[sym][0]) - 2], round(sd["w"].get(sym, 0), 4)]
                     for sym, x in sd["coins"].items() if sym in series}
            out[rule["id"]] = {"curve": sd["curve"], "eq": eq, "hold": hold, "trades": sd["trades"], "state": state, "tf": rule["tf"],
                               "open": sorted(k for k, x in sd["coins"].items() if x["pos"]), "coins": len(sd["coins"])}
    write_json(PAPER + tag + ".json", st)
    write_json(EVENTS + tag + ".json",{k: v[-EVENTS_PER_RULE:] for k, v in events.items()})     # журнал рішень (самоочищується)
    return {"round": rd, "accounts": kb["accounts"], "coins": sorted({s for tf in ptf.values() for s in tf}), "fee": fee, "strategies": out,
            "history": st.get("history", [])}


def thin(arr, n):
    if len(arr) <= n:
        return [round(v, 3) for v in arr], 1
    step = (len(arr) - 1) / float(n - 1)
    return [round(arr[int(round(i * step))], 3) for i in range(n)], step


def load(name):
    try:
        with open(os.path.join(DATA, name + ".json"), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def run():
    kb = load_knowledge(NAME)
    sk = load_knowledge("signals")
    syms = [c["symbol"] for c in (load("signals") or {}).get("coins", [])] or [c["symbol"] for c in sk["coins"]]
    prev = load(NAME)
    fresh = bool(prev and "paper" in prev and set(prev.get("symbols", [])) == set(syms) and prev.get("computed_at") and
                 (datetime.now(timezone.utc) - datetime.fromisoformat(prev["computed_at"])).total_seconds() < kb["cache_hours"] * 3600)

    fee, rnd = kb["fee"] + kb.get("slippage", 0.0), random.Random(kb["seed"])
    coins, series = {}, {}
    pcoins = list(kb["paper_coins"])
    daily_syms = sorted(set(syms) | set(pcoins))
    tfs = sorted({r["tf"] for r in kb["strategies"]} - {"1d"})
    jobs = [(sym, "1d", kb["candles"]) for sym in daily_syms] + [(sym, tf, kb["paper_candles"]) for sym in pcoins for tf in tfs]
    with ThreadPoolExecutor(max_workers=6) as pool:                     # свічки качаємо паралельно
        fetched = dict(zip(jobs, pool.map(lambda j: fetch_tf(*j), jobs)))
    ptf = {tf: {} for tf in tfs}
    for sym in daily_syms:
        ser = fetched[(sym, "1d", kb["candles"])]
        if not ser:
            continue
        c = ser[0]
        scores, s50 = scores_series(c, sk["weights"], sk["thresholds"])
        series[sym] = (c, ser[1], scores, s50)
        if fresh or sym not in syms:
            continue                                                  # історичний розрахунок свіжий: лише паперовий рахунок нижче
        entry = {"days": len(c) - 1 - WARMUP, "last": c[-1], "strategies": {}, "hold": {}}
        for rule in [r for r in kb["strategies"] if r["tf"] == "1d"]:
            flags, pos = [False] * len(c), False
            for i in range(WARMUP, len(c) - 1):
                pos = decide(rule, i, pos, scores, s50, c)
                flags[i] = pos
            per = {}
            for p in kb["periods"]:
                d0 = WARMUP if p == 0 else max(WARMUP, len(c) - 1 - p)
                m, eq, hold, trades = metrics(c, flags, d0, fee, kb["random_runs"], rnd)
                eqs, step = thin(eq, kb["points"])
                hs, _ = thin(hold, kb["points"])
                m["eq"], m["marks"] = eqs, [[int(t[0] / step), t[1]] for t in trades]
                if rule is kb["strategies"][0]:
                    entry["hold"][str(p)] = hs
                per[str(p)] = m
            entry["strategies"][rule["id"]] = per
        coins[sym] = entry
    if not series:
        raise RuntimeError("біржа не віддала історію цін")
    ptf["1d"] = {sym: series[sym] for sym in pcoins if sym in series}
    for tf in tfs:
        for sym in pcoins:
            ser = fetched.get((sym, tf, kb["paper_candles"]))
            if ser:
                sc, s50x = scores_series(ser[0], sk["weights"], sk["thresholds"])
                ptf[tf][sym] = (ser[0], ser[1], sc, s50x)
    paper = paper_wallets(ptf, kb, datetime.now(timezone.utc))
    if fresh:
        # історичну частину не чіпаємо: вона оновлюється раз на cache_hours; у «живому» файлі лише паперовий рахунок
        result = {k: v for k, v in prev.items() if k not in ("agent", "title", "source", "generated_at")}
        result["paper"], result["updated"] = paper, now_iso()
        return result
    strategies = [{"id": r["id"], "title": r["title"], "help": r["help"], "tf": r["tf"], "invert": bool(r.get("invert")), "pair": r.get("pair"),
                   "kind": r["kind"], "enter": r.get("enter"), "exit": r.get("exit"),
                   "stop": r.get("stop"), "take": r.get("take"), "sizing": r.get("sizing"), "p_exit": r.get("p_exit")}
                  for r in kb["strategies"]]
    computed = now_iso()
    # важка історична частина (≈150 КБ) лежить в окремому файлі й змінюється рідко: так репозиторій не розростається від кожного запуску
    write_json("simulation_history.json", {"coins": coins, "fee": fee, "periods": kb["periods"], "points": kb["points"], "strategies": strategies,
                                           "computed_at": computed})
    full = {"coins": coins, "strategies": strategies, "fee": fee}
    first = [s for s in strategies if s["tf"] == "1d" and not s["invert"]][0]["id"]
    rows = [v["strategies"][first]["365"] for v in coins.values()]
    result = {"symbols": sorted(coins), "paper": paper, "fee": fee, "capital": kb["capital"], "periods": kb["periods"], "strategies": strategies,
              "disclaimer": kb["texts"]["disclaimer"], "computed_at": computed, "updated": computed,
              "medians": {"median_ret": sorted(m["ret"] for m in rows)[len(rows) // 2], "median_hold": sorted(m["hold"] for m in rows)[len(rows) // 2]}}
    result["insights"] = insights(full)
    return result


def insights(r):
    """Висновки: чи кращі правила за «просто тримати» й за випадковість на річному періоді (за всіма монетами)."""
    out = []
    daily = [s for s in r["strategies"] if s["tf"] == "1d"]
    for s in [x for x in daily if not x["invert"]]:
        rows = [v["strategies"][s["id"]]["365"] for v in r["coins"].values()]
        n = len(rows)
        better = sum(1 for m in rows if m["ret"] > m["hold"])
        beat = round(sum(m["beat"] for m in rows) / n)
        med = sorted(m["ret"] for m in rows)[n // 2]
        hmed = sorted(m["hold"] for m in rows)[n // 2]
        out.append(item("neutral", "«%s», 365 днів: краще за «просто тримати» у %d з %d монет; медіанний результат %s проти %s; обходить у середньому %d%% випадкових симуляцій."
                        % (s["title"], better, n, pct(med), pct(hmed), beat)))
    # контроль: правило за сигналом проти його дзеркала (купувати там, де сигнал каже продавати)
    for s in [x for x in daily if x.get("pair")]:
        base = next((x for x in daily if x["id"] == s["pair"]), None)
        if not base:
            continue
        a = sorted(v["strategies"][base["id"]]["365"]["ret"] for v in r["coins"].values())[len(r["coins"]) // 2]
        b = sorted(v["strategies"][s["id"]]["365"]["ret"] for v in r["coins"].values())[len(r["coins"]) // 2]
        gap = a - b
        verdict = ("сигнал не додає нічого корисного (різниця менш як 5 п.п.)" if abs(gap) < 5 else
                   "за сигналом вийшло краще на %s п.п." % num(gap, 1) if gap > 0 else "дзеркало вийшло краще на %s п.п.: сигнал у цей період не допоміг" % num(-gap, 1))
        out.append(item("neutral", "Контроль «%s»: за сигналом %s, навпаки %s за 365 днів: %s." % (base["title"], pct(a), pct(b), verdict)))
    first = [x for x in daily if not x.get("invert")][0]["id"]
    rows = [v["strategies"][first]["365"] for v in r["coins"].values()]
    hold_med = sorted(m["hold"] for m in rows)[len(rows) // 2]
    plus = {s["id"]: sum(1 for v in r["coins"].values() if v["strategies"][s["id"]]["365"]["ret"] > 0) for s in daily}
    out.append(item("negative" if hold_med < 0 else "neutral",
                    "У плюсі за 365 днів закінчили: %s з %d монет. %s" % (", ".join("«%s»: %d" % (s["title"], plus[s["id"]]) for s in daily), len(rows),
                    "Ринок за цей період падав (медіана «просто тримати» %s): правила виглядають кращими переважно тому, що частину часу сиділи в готівці, а не тому, що заробляли." % pct(hold_med) if hold_med < 0 else "")))
    out.append(item("neutral", "Комісія %s за угоду враховано. Це симуляція на минулому, а не прогноз." % ("%s%%" % num(r["fee"] * 100, 1))))
    return out


def summary(r):
    return dict(r["medians"])
