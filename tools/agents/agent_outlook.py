"""Агент «Картина»: зводить дані інших агентів у загальну картину по кожній монеті (без порад «купувати» чи «продавати»).
Читає готові файли data/: signals (технічні сигнали), news й analytics (новини по монетах), sentiment (індекс страху й жадібності),
market (ширина ринку), stablecoins (потоки грошей). Результат: data/outlook.json.

Загальна оцінка від -100 до +100 — зважене середнє чинників (ваги в knowledge/outlook.json); чинник без достатніх даних
(наприклад, мало новин про монету) в оцінку не входить. Є захист: за екстремального настрою ринку оцінка зменшується,
а за новин про злами навколо монети — знижується. Довіра до картини береться з історичної перевірки сигналів,
тож за випадкових сигналів вона завжди «низька»."""
import json
import os
from datetime import datetime, timedelta, timezone

from . import learning
from .common import DATA, load_knowledge, now_iso, read_state, write_json, write_state
from .insights import Rules, item, num, pct

NAME = "outlook"
TITLE = "Картина по монетах"
SOURCE = "дані інших агентів"
INTERVAL = 600
RUNS_LAST = True        # run_agents запускає цього агента після решти, щоб читати їхні свіжі файли
LOG_NAME = "_outlook_log"     # журнал власних оцінок для самонавчання (самоочищується)


def load(name, default=None):
    """Читає data/<name>.json. Якщо файлу немає: повертає default (або кидає помилку, коли default не задано)."""
    try:
        with open(os.path.join(DATA, name + ".json"), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        if default is None:
            raise
        return default


def clamp(v, lo=-100, hi=100):
    return max(lo, min(hi, v))


def label_key(score, t):
    return ("favorable" if score >= t["favorable"] else "lean_favorable" if score >= t["lean_favorable"] else
            "unfavorable" if score <= t["unfavorable"] else "lean_unfavorable" if score <= t["lean_unfavorable"] else "neutral")


def tone_of(score):
    return "positive" if score > 10 else "negative" if score < -10 else "neutral"


def run():
    kb = load_knowledge(NAME)
    t, base_w, k, L = kb["thresholds"], kb["weights"], Rules(NAME), kb["learning"]
    signals, news, sent = load("signals"), load("news"), load("sentiment")
    market, stable = load("market"), load("stablecoins")

    # ---- Самонавчання: перевіряємо власні минулі оцінки на реальних цінах і оновлюємо ваги чинників ----
    now = datetime.now(timezone.utc)
    log = load(LOG_NAME, []) or []
    prices = {c["symbol"]: c["price"] for c in signals["coins"]}
    log = learning.evaluate(log, prices, now, L)
    stats = learning.hit_stats(log, L)
    prev = (read_state(NAME) or {}).get("weights") or base_w
    w = learning.update_weights(base_w, prev, stats, L)

    # ---- Спільні чинники ринку (однакові для всіх монет) ----
    shared, shared_f = {}, []
    v = sent["value"]
    shared["mood"] = clamp((v - 50) * 2)
    extreme = v <= t["extreme_low"] or v >= t["extreme_high"]
    key = "mood_extreme_low" if v <= t["extreme_low"] else "mood_extreme_high" if v >= t["extreme_high"] else "mood_calm"
    shared_f.append(k.say("negative" if extreme else tone_of(shared["mood"]), key, v=v, label=sent["label"].lower()))
    b = market["breadth"]
    share = round(100 * b["up"] / b["n"]) if b["n"] else 50
    shared["breadth"] = clamp((share - 50) * 4)
    key = "breadth_up" if share >= t["breadth_high"] else "breadth_down" if share <= t["breadth_low"] else "breadth_mid"
    shared_f.append(k.say("positive" if share >= t["breadth_high"] else "negative" if share <= t["breadth_low"] else "neutral", key, up=b["up"], n=b["n"]))
    ch = stable.get("change30")
    if ch is not None:
        shared["flows"] = clamp(ch / t["flow_strong"] * 100)
        key = "flows_up" if ch >= t["flow_strong"] / 4 else "flows_down" if ch <= -t["flow_strong"] / 4 else "flows_flat"
        shared_f.append(k.say("positive" if key == "flows_up" else "negative" if key == "flows_down" else "neutral", key, chg=pct(abs(ch), signed=False) if key != "flows_flat" else pct(ch)))

    # ---- Надійність: чи справджувались сигнали в минулому ----
    bt = signals["backtest"]
    pa, pb, ps = bt["all"]["up_pct"], bt["buyers"]["up_pct"], bt["sellers"]["up_pct"]
    edge = pa is not None and pb is not None and ps is not None and pb - pa >= t["edge_gap"] and pa - ps >= t["edge_gap"]
    reliability = "mid" if edge else "low"

    # ---- Новини по монетах за вікно ----
    since = datetime.now(timezone.utc) - timedelta(hours=t["news_window_hours"])
    recent = [i for i in news["items"] if datetime.fromisoformat(i["published"]) >= since]

    coins = []
    for c in signals["coins"]:
        sym, parts, factors = c["symbol"], {}, []
        items = [i for i in recent if sym in (i.get("coins") or [])]
        pos = sum(1 for i in items if i.get("sent_label") == "positive")
        neg = sum(1 for i in items if i.get("sent_label") == "negative")
        n = len(items)

        parts["technical"] = c["score"]
        factors.append(k.say("positive" if c["score"] >= 15 else "negative" if c["score"] <= -15 else "neutral",
                             "tech_up" if c["score"] >= 15 else "tech_down" if c["score"] <= -15 else "tech_flat", score=c["score"], tldr=c["tldr"]))
        if n >= t["news_min_items"]:
            parts["news"] = clamp(100 * (pos - neg) / n)
            key, tone = ("news_pos", "positive") if pos - neg >= max(1, n * 0.2) else ("news_neg", "negative") if neg - pos >= max(1, n * 0.2) else ("news_mix", "neutral")
            factors.append(k.say(tone, key, sym=sym, h=t["news_window_hours"], pos=pos, neg=neg, n=n))
        else:
            factors.append(k.say("neutral", "news_few", sym=sym, h=t["news_window_hours"], n=n))
        sec = [i for i in items if i.get("topic") == "security"]
        if len(sec) >= t["security_min"]:
            factors.append(k.say("negative", "security", sym=sym, n=len(sec)))
        off = [i for i in items if i.get("official")]
        if off:
            factors.append(k.say("neutral", "official", sym=sym, n=len(off)))
        for f in shared_f:
            factors.append(f)
        parts.update(shared)

        used = {name: val for name, val in parts.items() if name in w}
        total_w = sum(w[name] for name in used)
        score = sum(w[name] * val for name, val in used.items()) / total_w if total_w else 0
        if extreme:
            score *= t["extreme_damp"]
        if len(sec) >= t["security_min"]:
            score -= t["security_penalty"]
        score = round(clamp(score))

        signs = [1 if val > 10 else -1 if val < -10 else 0 for val in used.values()]
        nz = [s for s in signs if s]
        agree = bool(nz) and max(nz.count(1), nz.count(-1)) / len(nz) >= t["agree_share"]

        heads = sorted(items, key=lambda i: i["importance"], reverse=True)[:t["headlines"]]
        coins.append({
            "symbol": sym, "name": c["name"], "score": score, "label_key": label_key(score, t), "label": kb["labels"][label_key(score, t)],
            "agree": agree, "components": {name: round(val) for name, val in used.items()},
            "news": {"n": n, "pos": pos, "neg": neg, "security": len(sec), "official": len(off)},
            "factors": factors,
            "headlines": [{"title": i.get("title_uk") or i["title"], "link": i["link"], "source": i["source"], "published": i["published"],
                           "tone": i.get("sent_label", "neutral"), "confirmations": i.get("confirmations", 1)} for i in heads],
        })
    coins.sort(key=lambda x: -x["score"])

    # ---- Записуємо поточні оцінки в журнал (їх перевіримо через horizon_hours) і зберігаємо навчені ваги ----
    entries = [{"s": c["symbol"], "p": prices.get(c["symbol"]), "sc": c["score"], "c": c["components"]} for c in coins]
    log = learning.append_entries(log, entries, now, L)
    write_json(LOG_NAME + ".json", log)
    evaluated = sum(1 for e in log if e.get("done") and e.get("fwd") is not None)
    pending = sum(1 for e in log if not e.get("done"))
    write_state(NAME, {"weights": w, "updated": now.isoformat(), "evaluated": evaluated})
    learn = {"weights": w, "base": base_w, "stats": stats, "evaluated": evaluated, "pending": pending, "horizon_hours": L["horizon_hours"],
             "min_samples": L["min_samples"]}

    result = {
        "coins": coins, "market": {"mood": v, "mood_label": sent["label"], "breadth_share": share, "stable_change30": ch, "extreme": extreme,
                                   "news_total": len(recent)},
        "learning": learn, "reliability": reliability, "reliability_text": k.texts["reliability_" + reliability], "weights": w, "labels": kb["labels"],
        "disclaimer": k.texts["disclaimer"], "window_hours": t["news_window_hours"], "updated": now_iso(),
    }
    result["insights"] = insights(result, k)
    return result


def insights(r, k):
    """Висновки агента про загальну картину: скільки монет із яким фоном, що найсильніше, чому довіра така."""
    out, coins = [], r["coins"]
    fav = [c for c in coins if c["label_key"] in ("favorable", "lean_favorable")]
    unf = [c for c in coins if c["label_key"] in ("unfavorable", "lean_unfavorable")]
    tone = "positive" if len(fav) > len(unf) else "negative" if len(unf) > len(fav) else "neutral"
    out.append(item(tone, "Із %d монет сприятливіший фон у %d, несприятливіший у %d, нейтральний у %d." % (len(coins), len(fav), len(unf), len(coins) - len(fav) - len(unf))))
    best, worst = coins[0], coins[-1]
    out.append(item("neutral", "Найкраща картина в %s (%+d), найслабша в %s (%+d)." % (best["symbol"], best["score"], worst["symbol"], worst["score"])))
    out.append(item("neutral", "Спільний фон: настрій ринку %d (%s), зростає %d%% топ-монет, новин за %d год: %d." %
                    (r["market"]["mood"], r["market"]["mood_label"].lower(), r["market"]["breadth_share"], r["window_hours"], r["market"]["news_total"])))
    out.append(item("neutral", r["reliability_text"]))
    out.append(item("neutral", learn_line(r, k)))
    return out


def learn_line(r, k):
    """Речення про самонавчання: скільки оцінок перевірено і який чинник влучає найчастіше."""
    L, names = r["learning"], {"technical": "технічні сигнали", "news": "новини", "mood": "настрій", "breadth": "ширина ринку", "flows": "потоки грошей"}
    ready = {n: s for n, s in L["stats"].items() if s["n"] >= L["min_samples"]}
    if ready:
        best = max(ready, key=lambda n: ready[n]["pct"]); worst = min(ready, key=lambda n: ready[n]["pct"])
        return k.texts["learn_best"].format(done=L["evaluated"], h=L["horizon_hours"], best=names.get(best, best), pct=ready[best]["pct"],
                                            worst=names.get(worst, worst), wpct=ready[worst]["pct"])
    if L["evaluated"]:
        return k.texts["learn_none"].format(done=L["evaluated"], min=L["min_samples"])
    return k.texts["learn_wait"].format(pending=L["pending"], h=L["horizon_hours"], done=L["evaluated"], min=L["min_samples"])


def summary(r):
    cs = r["coins"]
    return {"avg_score": round(sum(c["score"] for c in cs) / len(cs)), "favorable": sum(1 for c in cs if c["score"] >= 10), "unfavorable": sum(1 for c in cs if c["score"] <= -10)}
