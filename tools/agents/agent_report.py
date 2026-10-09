"""Агент «Звіт»: щодня складає зрозумілий звіт по ринку українською з даних інших агентів (без порад «купувати» чи «продавати»).
Читає data/: market, sentiment, stablecoins, network, regulation, analytics, signals, outlook. Результат: data/report.json —
поточний звіт (розділи, застереження, текст для збереження у файл) і архів останніх звітів по днях (самоочищення: archive_days).
Правила, пороги й формулювання — у knowledge/report.json."""
import json
import os
from datetime import datetime, timezone

from .common import DATA, load_knowledge, now_iso
from .insights import Rules, num, pct

NAME = "report"
TITLE = "Звіт по ринку"
SOURCE = "дані інших агентів"
INTERVAL = 900
RUNS_LAST = True        # після агента «Картина» (див. порядок у run_agents.AGENTS)

REPORT_FILE = "report.json"


def load(name, default=None):
    try:
        with open(os.path.join(DATA, name + ".json"), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def section(sid, title, lines, tone="neutral"):
    return {"id": sid, "title": title, "tone": tone, "lines": [x for x in lines if x]}


def run():
    kb = load_knowledge(NAME)
    t, k, titles = kb["thresholds"], Rules(NAME), kb["titles"]
    market, sent, stable = load("market"), load("sentiment"), load("stablecoins")
    network, reg, news = load("network"), load("regulation"), load("analytics")
    outlook = load("outlook")
    if not (market and sent and outlook):
        raise RuntimeError("ще немає даних агентів «Ринок», «Настрій» або «Картина»")

    g = market["global"]
    chg = g.get("change24h") or 0
    coins = outlook["coins"]
    fav = [c for c in coins if c["score"] >= 10]
    unf = [c for c in coins if c["score"] <= -10]
    best, worst = coins[0], coins[-1]

    S = {}
    S["summary"] = section("summary", titles["summary"], [
        k.texts["headline"].format(chg=pct(chg), mood=sent["label"].lower(), value=sent["value"], fav=len(fav), unf=len(unf)),
        k.texts["strongest"].format(sym=best["symbol"], score=best["score"], wsym=worst["symbol"], wscore=worst["score"]),
    ], "positive" if chg >= 1 else "negative" if chg <= -1 else "neutral")
    S["market"] = section("market", titles["market"], [x["text"] for x in market.get("insights", [])[:4]],
                          "positive" if chg >= 1 else "negative" if chg <= -1 else "neutral")
    mood_lines = [x["text"] for x in sent.get("insights", [])[:4]] + ([x["text"] for x in stable.get("insights", [])[:3]] if stable else [])
    S["mood"] = section("mood", titles["mood"], mood_lines)

    def why(c):
        parts = []
        tech = c["components"].get("technical")
        if tech is not None:
            parts.append(k.texts["why_tech"].format(tech=("в плюсі" if tech > 10 else "в мінусі" if tech < -10 else "нейтральні")))
        if "news" in c["components"]:
            nv = c["components"]["news"]
            parts.append(k.texts["why_news"].format(news=("переважно позитивні" if nv > 10 else "переважно негативні" if nv < -10 else "змішані")))
        return ", ".join(parts).capitalize() + "." if parts else ""

    top_n = t["top_coins"]
    coin_lines = [k.texts["coin_line"].format(sym=c["symbol"], label=c["label"].lower(), score=("%+d" % c["score"]), why=why(c)) for c in coins[:top_n]]
    coin_lines += [k.texts["coin_line"].format(sym=c["symbol"], label=c["label"].lower(), score=("%+d" % c["score"]), why=why(c)) for c in coins[-top_n:][::-1]
                   if c not in coins[:top_n]]
    S["coins"] = section("coins", titles["coins"], coin_lines)

    news_lines, neg_share, sec_n = [], 0, 0
    if news:
        total = news.get("total") or 1
        sn = news.get("sentiment", {})
        pos_s, neg_s = round(100 * sn.get("positive", 0) / total), round(100 * sn.get("negative", 0) / total)
        neg_share = neg_s
        sec_n = (news.get("by_topic") or {}).get("security", 0)
        news_lines.append(k.texts["news_tone"].format(pos=pos_s, neg=neg_s, neu=100 - pos_s - neg_s))
        if sec_n:
            news_lines.append(k.texts["security_line"].format(n=sec_n))
        for s in news.get("top", [])[:t["top_stories"]]:
            news_lines.append(k.texts["story"].format(title=s.get("title_uk") or s["title"], source=s["source"], conf=s.get("confirmations", 1)))
        if news.get("needs_check"):
            news_lines.append(k.texts["unconfirmed"].format(n=len(news["needs_check"])))
    S["news"] = section("news", titles["news"], news_lines)
    S["network"] = section("network", titles["network"], [x["text"] for x in (network or {}).get("insights", [])[:4]])
    S["regulation"] = section("regulation", titles["regulation"], [x["text"] for x in (reg or {}).get("insights", [])[:3]])

    # ---- Що варто взяти до уваги: правила з бази знань ----
    w = []
    if abs(chg) >= t["big_market_move"]:
        w.append(k.texts["watch_big_move"].format(chg=pct(chg)))
    if sent["value"] <= t["mood_extreme_low"]:
        w.append(k.texts["watch_extreme_low"].format(value=sent["value"]))
    if sent["value"] >= t["mood_extreme_high"]:
        w.append(k.texts["watch_extreme_high"].format(value=sent["value"]))
    fee = (network or {}).get("fees", {}).get("fastestFee") or 0
    if fee >= t["high_fee"]:
        w.append(k.texts["watch_fee"].format(fee=fee))
    pool = ((network or {}).get("mempool") or {}).get("count") or 0
    if pool >= t["busy_mempool"]:
        w.append(k.texts["watch_mempool"].format(n=num(pool)))
    if sec_n >= t["security_news"]:
        w.append(k.texts["watch_security"].format(n=sec_n))
    if neg_share >= t["negative_news_share"]:
        w.append(k.texts["watch_neg_news"].format(neg=neg_share))
    if reg and reg["stats"]["d30"] - reg["stats"]["prev30"] >= t["regulation_surge"]:
        w.append(k.texts["watch_regulation"].format(n=reg["stats"]["d30"], diff=reg["stats"]["d30"] - reg["stats"]["prev30"]))
    if stable and any(abs((x.get("price") or 1) - 1) > 0.005 for x in stable.get("top", [])):
        w.append(k.texts["watch_peg"])
    dis = [c for c in coins if not c["agree"]]
    if len(dis) >= t["disagree_min"]:
        w.append(k.texts["watch_disagree"].format(n=len(dis)))
    S["watch"] = section("watch", titles["watch"], w or [k.texts["watch_none"]], "negative" if w else "positive")
    learn_text = outlook["insights"][-1]["text"] if outlook.get("insights") else ""
    S["trust"] = section("trust", titles["trust"], [outlook["reliability_text"], learn_text, k.texts["trust_tail"]])

    sections = [S[sid] for sid in kb["sections"] if sid in S and S[sid]["lines"]]
    today = datetime.now(timezone.utc).date().isoformat()
    headline = S["summary"]["lines"][0]
    md = ["# Звіт по ринку, %s" % today, ""]
    for s in sections:
        md.append("## " + s["title"])
        md.extend("- " + x for x in s["lines"])
        md.append("")
    markdown = "\n".join(md)

    # ---- Архів: один запис на день, найновіші archive_days (самоочищення) ----
    old = load("report", {}) or {}
    archive = [a for a in old.get("archive", []) if a["date"] != today]
    archive.append({"date": today, "headline": headline, "avg_score": round(sum(c["score"] for c in coins) / len(coins)), "sections": sections})
    archive = sorted(archive, key=lambda a: a["date"])[-kb["archive_days"]:]

    result = {"date": today, "headline": headline, "sections": sections, "markdown": markdown,
              "archive": [{"date": a["date"], "headline": a["headline"], "avg_score": a["avg_score"], "sections": a["sections"]} for a in archive],
              "updated": now_iso()}
    result["insights"] = insights(result)
    return result


def insights(r):
    """Короткі висновки для вкладки агента: головне речення звіту й застереження."""
    out = [{"tone": r["sections"][0]["tone"], "text": r["headline"]}]
    watch = next((s for s in r["sections"] if s["id"] == "watch"), None)
    if watch:
        out.extend({"tone": watch["tone"], "text": x} for x in watch["lines"][:3])
    out.append({"tone": "neutral", "text": "У архіві звітів днів: %d." % len(r["archive"])})
    return out


def summary(r):
    return {"avg_score": r["archive"][-1]["avg_score"], "watch": len(next((s for s in r["sections"] if s["id"] == "watch"), {"lines": []})["lines"])}
