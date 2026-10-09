"""Агент «Сигнали»: інформаційні сигнали за публічними індикаторами для найпопулярніших монет.
Джерело: денні свічки Binance (запасне: CoinGecko). Результат: data/signals.json.

Що рахує для кожної монети: тренд (середні за 50 і 200 днів), імпульс (MACD), перегрів/розпродаж (RSI), зміну за 30 днів;
з них складає оцінку від -100 до +100 та підпис «перевага покупців / рівновага / перевага продавців».
Також перевіряє себе на минулому: як часто після такого сигналу ціна через 7 днів справді була вищою.
Це НЕ прогноз і НЕ фінансова порада. Монети, ваги й тексти — у knowledge/signals.json."""
import math
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta

from .common import downsample, get_json, load_knowledge, now_iso, read_state, write_state
from .insights import Rules, item, num, pct

NAME = "signals"
TITLE = "Сигнали по монетах"
SOURCE = "Binance"
INTERVAL = 3600

HOSTS = ("https://data-api.binance.vision", "https://api.binance.com")
MIN_CANDLES = 220            # потрібно для середньої за 200 днів і трохи історії для перевірки


# ---------- Індикатори (чисті функції: легко перевірити) ----------
def sma(c, n):
    return sum(c[-n:]) / n


def ema_series(c, n):
    k, out = 2.0 / (n + 1), []
    for i, v in enumerate(c):
        out.append(v if i == 0 else v * k + out[-1] * (1 - k))
    return out


def rsi(c, n=14):
    """RSI за Вайлдером: 0–100, нижче 30 «розпродаж», вище 70 «перегрів»."""
    if len(c) <= n:
        return 50.0
    gains = losses = 0.0
    for i in range(1, n + 1):
        d = c[i] - c[i - 1]
        gains += max(d, 0)
        losses += max(-d, 0)
    avg_g, avg_l = gains / n, losses / n
    for i in range(n + 1, len(c)):
        d = c[i] - c[i - 1]
        avg_g = (avg_g * (n - 1) + max(d, 0)) / n
        avg_l = (avg_l * (n - 1) + max(-d, 0)) / n
    if avg_l == 0:
        return 100.0
    return 100 - 100 / (1 + avg_g / avg_l)


def macd_hist(c):
    macd = [a - b for a, b in zip(ema_series(c, 12), ema_series(c, 26))]
    sig = ema_series(macd, 9)
    return macd[-1] - sig[-1]


def indicators(c):
    price = c[-1]
    return {
        "price": price, "sma50": sma(c, 50), "sma200": sma(c, 200), "rsi": rsi(c), "macd": macd_hist(c),
        "mom30": 100 * (price / c[-31] - 1) if len(c) > 31 else 0.0,
    }


def score_of(ind, w, t):
    """Оцінка -100…+100 і перелік ознак (ключ, знак). Ваги й межі беруться з бази знань."""
    s, why = 0, []
    up = ind["price"] > ind["sma50"]
    s += w["sma50"] if up else -w["sma50"]
    why.append(("sma50_up" if up else "sma50_down", 1 if up else -1))
    up = ind["sma50"] > ind["sma200"]
    s += w["sma_cross"] if up else -w["sma_cross"]
    why.append(("cross_up" if up else "cross_down", 1 if up else -1))
    up = ind["macd"] > 0
    s += w["macd"] if up else -w["macd"]
    why.append(("macd_up" if up else "macd_down", 1 if up else -1))
    if ind["rsi"] <= t["rsi_low"]:
        s += w["rsi"]
        why.append(("rsi_low", 1))
    elif ind["rsi"] >= t["rsi_high"]:
        s -= w["rsi"]
        why.append(("rsi_high", -1))
    else:
        why.append(("rsi_mid", 0))
    if ind["mom30"] >= t["momentum_big"]:
        s += w["momentum30"]
        why.append(("mom_up", 1))
    elif ind["mom30"] <= -t["momentum_big"]:
        s -= w["momentum30"]
        why.append(("mom_down", -1))
    else:
        why.append(("mom_flat", 0))
    return round(100 * s / sum(w.values())), why


def label_of(score, t):
    return "buyers" if score >= t["buyers"] else "sellers" if score <= t["sellers"] else "balance"


def backtest(closes, w, t, horizon):
    """Для кожного минулого дня: який був сигнал і що сталося з ціною через horizon днів."""
    stats = {k: {"n": 0, "up": 0, "sum": 0.0} for k in ("buyers", "balance", "sellers")}
    for i in range(199, len(closes) - horizon):
        s, _ = score_of(indicators(closes[:i + 1]), w, t)
        fwd = 100 * (closes[i + horizon] / closes[i] - 1)
        b = stats[label_of(s, t)]
        b["n"] += 1
        b["up"] += fwd > 0
        b["sum"] += fwd
    return stats


def merge_stats(parts):
    out = {k: {"n": 0, "up": 0, "sum": 0.0} for k in ("buyers", "balance", "sellers")}
    for p in parts:
        for k, v in p.items():
            for f in ("n", "up", "sum"):
                out[k][f] += v[f]
    return out


def finish(stats):
    """Підсумок для сайту: скільки днів, у скількох відсотках ціна зросла, середня зміна."""
    res, tot_n, tot_up = {}, 0, 0
    for k, v in stats.items():
        tot_n += v["n"]
        tot_up += v["up"]
        res[k] = {"n": v["n"], "up_pct": round(100 * v["up"] / v["n"]) if v["n"] else None,
                  "avg": round(v["sum"] / v["n"], 1) if v["n"] else None}
    res["all"] = {"n": tot_n, "up_pct": round(100 * tot_up / tot_n) if tot_n else None}
    return res


def price_range(price, closes, days):
    """Діапазон «±1 стандартне відхилення» за поточною мінливістю: ~2 випадки з 3. Статистика, а не прогноз."""
    rets = [math.log(closes[i] / closes[i - 1]) for i in range(len(closes) - 30, len(closes))]
    mean = sum(rets) / len(rets)
    sd = math.sqrt(sum((r - mean) ** 2 for r in rets) / (len(rets) - 1))
    span = sd * math.sqrt(days)
    return [price * math.exp(-span), price * math.exp(span)]


# ---------- Дані ----------
EXCHANGE = "Binance"                                   # офіційна біржа, з якої беремо ціни й обсяги торгів
GECKO = "CoinGecko (агрегатор, не біржа)"             # запасне джерело лише для цін, без обсягів
used_source = {}                                       # монета → звідки реально взято її дані (для показу на сайті)


def fetch_series(pair):
    """Денні ціни закриття й обсяги торгів (у доларах) з Binance; None, якщо даних замало чи біржа недоступна."""
    for host in HOSTS:
        try:
            rows = get_json("%s/api/v3/klines?symbol=%s&interval=1d&limit=400" % (host, pair), retries=0)
            if len(rows) >= MIN_CANDLES:
                used_source[pair[:-4]] = EXCHANGE
                return [float(r[4]) for r in rows], [float(r[7]) for r in rows]
        except Exception:    # noqa: BLE001 — пробуємо наступне джерело
            pass
    return None


def get_closes(coin):
    """Ціни монети: Binance, а для монет зі списку в базі знань ще й запасний CoinGecko (без обсягів)."""
    s = fetch_series(coin["pair"])
    if s:
        return s
    if not coin.get("gecko"):
        raise RuntimeError("немає даних для " + coin["symbol"])
    time.sleep(1.5)
    j = get_json("https://api.coingecko.com/api/v3/coins/%s/market_chart?vs_currency=usd&days=400&interval=daily" % coin["gecko"])
    closes = [p[1] for p in j["prices"]]
    if len(closes) < MIN_CANDLES:
        raise RuntimeError("замало даних для " + coin["symbol"])
    used_source[coin["symbol"]] = GECKO
    return closes, None


# ---------- Автоматичний добір монет за інтересом ----------
def interest_of(qvols, q24, days=7):
    """Інтерес = обсяг торгів за 24 год / звичайний добовий обсяг за попередні `days` днів (×1 — як зазвичай)."""
    base = qvols[-(days + 1):-1]
    avg = sum(base) / len(base) if base else 0
    return q24 / avg if avg else 0.0


def load_ticker():
    for host in HOSTS:
        try:
            return get_json(host + "/api/v3/ticker/24hr?type=MINI", retries=0)
        except Exception:    # noqa: BLE001
            pass
    raise RuntimeError("біржа не віддала список торгів")


def rotate(kb, cache):
    """Оновлює список монет: слідкує за інтересом і замінює ті, до яких він упав. Повертає (слоти, інформація про вибір).
    cache — словник symbol → (closes, qvols), куди складаємо вже завантажені ряди, щоб не качати двічі."""
    import re
    from datetime import date
    dyn, pinned = kb["dynamic"], kb["pinned"]
    k = Rules(NAME)
    state = read_state(NAME)
    today = date.today().isoformat()
    default = [c["symbol"] for c in kb["coins"] if c["symbol"] not in pinned][:dyn["slots"]]
    slots = [s for s in state.get("slots", default) if s not in pinned][:dyn["slots"]] or default
    since = {s: state.get("since", {}).get(s, today) for s in slots}
    log_ = state.get("log", [])
    info = {"pinned": pinned, "slots": slots, "error": None, "top_interest": [], "changes": log_[-5:]}
    skip = re.compile(dyn["exclude_pattern"])
    try:
        q24 = {}
        for t in load_ticker():
            sym = t["symbol"]
            if sym.endswith("USDT") and not skip.match(sym[:-4]):
                q24[sym[:-4]] = float(t["quoteVolume"])
        ranked = [s for s, v in sorted(q24.items(), key=lambda kv: -kv[1]) if v >= dyn["min_quote_volume_usd"]][:dyn["candidates"]]
        wanted = list(dict.fromkeys(ranked + slots + pinned))
        with ThreadPoolExecutor(max_workers=6) as pool:
            got = list(pool.map(lambda s: (s, fetch_series(s + "USDT")), [s for s in wanted if s in q24]))
        score, usual = {}, {}
        for s, ser in got:
            if ser:
                cache[s] = ser
                score[s] = interest_of(ser[1], q24[s], dyn["baseline_days"])
                base = ser[1][-(dyn["baseline_days"] + 1):-1]
                usual[s] = sum(base) / len(base) if base else 0       # звичайний добовий обсяг: відсіює монети з одноденним сплеском
        eligible = [s for s in score if s not in pinned and q24[s] >= dyn["min_quote_volume_usd"]
                    and usual[s] >= dyn["min_usual_volume_usd"]]
        order = sorted(eligible, key=lambda s: -score[s])
        rank = {s: i + 1 for i, s in enumerate(order)}
        info["top_interest"] = [{"symbol": s, "surge": round(score[s], 2)} for s in order[:8]]
        info["interest"] = {s: {"surge": round(score[s], 2), "volume_usd": round(q24[s]), "rank": rank.get(s)} for s in score}
        new = list(slots)
        for out in sorted(slots, key=lambda s: -rank.get(s, 999)):          # спершу ті, до кого інтерес найнижчий
            days_in = (date.fromisoformat(today) - date.fromisoformat(since[out])).days
            if out in rank and (rank[out] <= dyn["keep_rank"] or days_in < dyn["min_days_in_list"]):
                continue            # цікава монета лишається; нова — ще в «захисному періоді». Непридатну (немає в рейтингу) міняємо одразу
            repl = next((s for s in order if s not in new), None)
            if not repl:
                continue
            new[new.index(out)] = repl
            text = (k.say("neutral", "swap", out=out, inn=repl, o=num(score.get(out, 0), 1), r=rank[out], i=num(score[repl], 1)) if out in rank else
                    k.say("neutral", "swap_gone", out=out, inn=repl, i=num(score[repl], 1)))["text"]
            log_.append({"date": today, "out": out, "in": repl, "text": text})
            since.pop(out, None)
            since[repl] = today
        for s in order:                                                       # вільні місця заповнюємо найцікавішими
            if len(new) >= dyn["slots"]:
                break
            if s not in new:
                new.append(s)
                since[s] = today
                log_.append({"date": today, "out": None, "in": s, "text": k.say("neutral", "added", inn=s, i=num(score[s], 1))["text"]})
        slots = new
    except Exception as ex:      # noqa: BLE001 — без біржі лишаємо попередній список
        info["error"] = str(ex)[:120]
    log_ = log_[-dyn["log_size"]:]
    write_state(NAME, {"slots": slots, "since": {s: since.get(s, today) for s in slots}, "log": log_})
    info.update({"slots": slots, "since": {s: since.get(s, today) for s in slots}, "changes": log_[-5:],
                 "note": k.texts["interest"].format(pinned=", ".join(pinned))})
    return slots, info


def fmt_price(v):
    return num(v, 2 if v >= 100 else 4 if v >= 1 else 5)


def analyze(coin, closes, kb):
    w, t = kb["weights"], kb["thresholds"]
    k = Rules(NAME)
    ind = indicators(closes)
    score, why = score_of(ind, w, t)
    fmt = {"sma50_up": fmt_price(ind["sma50"]), "sma50_down": fmt_price(ind["sma50"]), "rsi_low": num(ind["rsi"], 0),
           "rsi_high": num(ind["rsi"], 0), "rsi_mid": num(ind["rsi"], 0), "mom_up": pct(ind["mom30"]),
           "mom_down": pct(ind["mom30"]), "mom_flat": pct(ind["mom30"])}
    reasons = [{"tone": "positive" if sign > 0 else "negative" if sign < 0 else "neutral", "text": k.texts[key].format(v=fmt.get(key, ""))}
               for key, sign in why]
    p = ind["price"]
    signal = label_of(score, t)
    tilt = None                      # у «рівновазі» показуємо, куди вона нахилена, щоб картки не були однаковими
    if signal == "balance":
        tilt = "buyers" if score >= t["tilt"] else "sellers" if score <= -t["tilt"] else None
    rsi_key = "rsi_word_low" if ind["rsi"] <= t["rsi_low"] else "rsi_word_high" if ind["rsi"] >= t["rsi_high"] else "rsi_word_mid"
    tldr = k.texts["tldr"].format(short=k.texts["dir_up" if ind["price"] > ind["sma50"] else "dir_down"],
                                  long=k.texts["dir_up" if ind["sma50"] > ind["sma200"] else "dir_down"], rsi=k.texts[rsi_key])
    return {
        "tilt": tilt, "tldr": tldr,
        "symbol": coin["symbol"], "name": coin["name"], "price": p,
        "change24h": round(100 * (closes[-1] / closes[-2] - 1), 2), "change7d": round(100 * (closes[-1] / closes[-8] - 1), 2),
        "change30d": round(ind["mom30"], 2), "rsi": round(ind["rsi"], 1), "sma50": ind["sma50"], "sma200": ind["sma200"],
        "macd_up": ind["macd"] > 0, "score": score, "signal": signal, "reasons": reasons,
        "range7": [round(x, 6) for x in price_range(p, closes, 7)], "range30": [round(x, 6) for x in price_range(p, closes, 30)],
        "spark": [round(x, 6) for x in downsample(closes[-90:], 45)],
    }, closes


def run():
    kb = load_knowledge(NAME)
    t, w, h = kb["thresholds"], kb["weights"], kb["thresholds"]["horizon_days"]
    cache = {}
    if kb["dynamic"]["enabled"]:
        slots, selection = rotate(kb, cache)
    else:
        slots = [c["symbol"] for c in kb["coins"] if c["symbol"] not in kb["pinned"]][:kb["dynamic"]["slots"]]
        selection = {"pinned": kb["pinned"], "slots": slots, "changes": [], "error": None, "top_interest": [], "note": ""}
    known = {c["symbol"]: c for c in kb["coins"]}
    names = kb["dynamic"]["names"]
    cfg = [known.get(s) or {"symbol": s, "name": names.get(s, s), "pair": s + "USDT"} for s in kb["pinned"] + slots]
    todo = [c for c in cfg if c["symbol"] not in cache]
    with ThreadPoolExecutor(max_workers=4) as pool:
        for c, ser in zip(todo, pool.map(get_closes, todo)):
            cache[c["symbol"]] = ser
    interest = selection.get("interest", {})
    coins, bts = [], []
    for coin in cfg:
        closes = cache[coin["symbol"]][0]
        c, _ = analyze(coin, closes, kb)
        bt = backtest(closes, w, t, h)
        bts.append(bt)
        c["backtest"] = finish(bt)
        c["interest"] = interest.get(coin["symbol"])
        c["pinned"] = coin["symbol"] in kb["pinned"]
        c["auto"] = coin["symbol"] not in known              # додана автоматично за інтересом, а не вказана в базі знань
        c["source"] = used_source.get(coin["symbol"], EXCHANGE)
        c["in_list_since"] = selection.get("since", {}).get(coin["symbol"])
        coins.append(c)
    total = finish(merge_stats(bts))
    selection.pop("interest", None)
    result = {"coins": coins, "backtest": total, "horizon_days": h, "labels": kb["labels"], "disclaimer": kb["texts"]["disclaimer"],
              "selection": selection, "exchange": {"name": EXCHANGE, "url": "https://www.binance.com", "api": "https://developers.binance.com",
              "note": "Ціни й обсяги торгів: спотові пари до USDT на біржі Binance (офіційний публічний API ринкових даних)."},
              "updated": now_iso()}
    result["insights"] = insights(result, kb)
    return result


def insights(r, kb):
    """Висновки по всьому набору монет і чесна оцінка надійності сигналів (тексти й пороги — knowledge/signals.json)."""
    k = Rules(NAME)
    coins, t, out = r["coins"], kb["thresholds"], []
    n = len(coins)
    cnt = {s: sum(1 for c in coins if c["signal"] == s) for s in ("buyers", "balance", "sellers")}
    tone = "positive" if cnt["buyers"] > cnt["sellers"] else "negative" if cnt["sellers"] > cnt["buyers"] else "neutral"
    out.append(k.say(tone, "market_split", n=n, b=cnt["buyers"], s=cnt["sellers"], e=cnt["balance"]))
    best, worst = max(coins, key=lambda c: c["score"]), min(coins, key=lambda c: c["score"])
    out.append(k.say("neutral", "market_strong", sym=best["symbol"], score=best["score"], wsym=worst["symbol"], wscore=worst["score"]))
    bt = r["backtest"]
    if bt["buyers"]["n"] >= 30 and bt["sellers"]["n"] >= 30 and bt["all"]["up_pct"] is not None:
        out.append(k.say("neutral", "bt_edge", days=bt["all"]["n"] // n, h=r["horizon_days"], pb=bt["buyers"]["up_pct"],
                         ps=bt["sellers"]["up_pct"], pa=bt["all"]["up_pct"]))
        pb, ps, pa = bt["buyers"]["up_pct"], bt["sellers"]["up_pct"], bt["all"]["up_pct"]
        if abs(pb - pa) < t["backtest_same"] and abs(ps - pa) < t["backtest_same"]:
            out.append(k.say("neutral", "bt_same", thr=t["backtest_same"]))
        elif pb > pa and ps < pa:
            out.append(k.say("neutral", "bt_useful"))
        else:
            out.append(k.say("neutral", "bt_mixed"))
    recent = [x for x in r["selection"]["changes"][-2:] if x["date"] >= (date.today() - timedelta(days=3)).isoformat()]
    for x in recent:
        out.append(item("neutral", x["text"]))
    if not recent:
        out.append(k.say("neutral", "no_change"))
    lo, hi = best["range30"]
    out.append(k.say("neutral", "range", sym=best["symbol"], lo="%s $" % fmt_price(lo), hi="%s $" % fmt_price(hi)))
    return out


def summary(r):
    cs = r["coins"]
    return {"avg_score": round(sum(c["score"] for c in cs) / len(cs)), "buyers": sum(1 for c in cs if c["signal"] == "buyers"),
            "sellers": sum(1 for c in cs if c["signal"] == "sellers")}
