#!/usr/bin/env python3
"""Новинний агент сайту «Крипто простими словами».

Що робить:
  1. ЧИТАЄ стрічки новин із кількох відкритих джерел (RSS і API Federal Register).
  2. РЕДАГУЄ: чистить текст від HTML, скорочує опис, прибирає дублікати
     (одна історія з кількох видань зливається в одну з позначкою «підтверджено N джерелами»).
  3. ФІЛЬТРУЄ: відсіює нерелевантне, рекламу й «хайп» (прогнози ціни, «купи зараз» тощо).
  4. СЛІДКУЄ: запам'ятовує, що вже бачив, і показує, що з'явилось нового.
  5. АНАЛІЗУЄ: темі, тон, згадки монет, активність по годинах, надійність джерел,
     і складає висновки українською.
  Результат пишеться у data/news.json та data/analytics.json, які читає сайт.

Важливо: це правила й словники, а не ШІ. Тон новин визначається за ключовими словами
і може помилятися. Для сайту це «автоматичний огляд», а не оцінка експерта.

Запуск:
  python tools/news_agent.py              один запуск
  python tools/news_agent.py --watch 600  працює постійно, оновлює кожні 600 секунд
"""
import argparse
import hashlib
import html
import json
import os
import re
import sys
import time
import urllib.parse
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


from agents.common import DATA, fetch, log as _log, write_json
from news_config import (COIN_INFO, COINS, CRYPTO, HYPE, IMPACT_TEXT, KEEP_DAYS, MAX_OUT, NEGATIVE, POSITIVE,
                         SOURCES, STOP, TOPIC_LABELS, TOPIC_RULES)


def log(msg):
    _log("news", msg)


def strip_ns(tag):
    return tag.rsplit("}", 1)[-1]


def clean(text):
    text = html.unescape(re.sub(r"<[^>]+>", " ", text or ""))
    return re.sub(r"\s+", " ", text).strip()


def snippet(text, limit=170):
    text = clean(text)
    if len(text) <= limit:
        return text
    cut = text[:limit].rsplit(" ", 1)[0]
    return cut.rstrip(" ,;:.-") + "…"


def parse_date(s):
    if not s:
        return None
    s = s.strip()
    try:
        d = parsedate_to_datetime(s)
    except Exception:
        try:
            d = datetime.fromisoformat(s.replace("Z", "+00:00"))
        except Exception:
            return None
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    return d.astimezone(timezone.utc)


IMG_EXT = re.compile(r"\.(jpe?g|png|webp|gif|avif)(\?|$)", re.I)


def first_img(markup):
    m = re.search(r"<img[^>]+src=[\"']([^\"']+)", markup or "", re.I)
    return m.group(1) if m else ""


def safe_img(url):
    """Беремо лише https-посилання на зображення помірної довжини (без data:, javascript: тощо)."""
    url = html.unescape((url or "").strip())
    if url.startswith("//"):
        url = "https:" + url
    return url if url.startswith("https://") and len(url) <= 600 and " " not in url else ""


def parse_rss(data):
    root = ET.fromstring(data)
    out = []
    for el in root.iter():
        if strip_ns(el.tag) not in ("item", "entry"):
            continue
        d = {"title": "", "link": "", "date": "", "desc": "", "img": ""}
        for ch in el:
            k = strip_ns(ch.tag)
            # Зображення: media:content / media:thumbnail / enclosure / картинка в тексті
            if not d["img"]:
                u = ch.attrib.get("url", "")
                if k == "thumbnail" and u:
                    d["img"] = u
                elif k in ("content", "enclosure") and u and (
                        ch.attrib.get("medium") == "image" or ch.attrib.get("type", "").startswith("image") or IMG_EXT.search(u)):
                    d["img"] = u
                elif k == "encoded":
                    d["img"] = first_img(ch.text or "")
            if k == "title":
                d["title"] = clean(ch.text)
            elif k == "link":
                href = ch.attrib.get("href")
                if href and (ch.attrib.get("rel") in (None, "alternate")):
                    d["link"] = d["link"] or href
                elif ch.text and ch.text.strip():
                    d["link"] = ch.text.strip()
            elif k in ("pubDate", "published", "updated", "date"):
                d["date"] = d["date"] or (ch.text or "")
            elif k in ("description", "summary") and not d["desc"]:
                d["desc"] = ch.text or ""
        if not d["img"]:
            d["img"] = first_img(d["desc"])
        d["img"] = safe_img(d["img"])
        if d["title"] and d["link"]:
            out.append(d)
    return out


def parse_fedreg(data):
    j = json.loads(data.decode("utf-8"))
    return [{"title": clean(r.get("title")), "link": r.get("html_url", ""), "date": r.get("publication_date", ""),
             "desc": r.get("abstract") or ""} for r in j.get("results", [])]


def classify(text):
    low = text.lower()
    topics = [name for name, rx in TOPIC_RULES if re.search(rx, low, re.I)]
    return topics or ["other"]


def tokens(title):
    words = re.findall(r"[a-zа-яіїєґ0-9]{4,}", title.lower())
    return {w for w in words if w not in STOP}


def read_source(s):
    """Читає одне джерело. Повертає (записи, статус). Помилки не викидає: вони потрапляють у статус."""
    st = {"id": s["id"], "name": s["name"], "weight": s["weight"], "ok": False, "count": 0, "error": ""}
    raw = []
    try:
        data = fetch(s["url"])
        entries = parse_fedreg(data) if s.get("kind") == "fedreg" else parse_rss(data)
        for e in entries:
            pub = parse_date(e["date"])
            if not pub:
                continue
            raw.append({
                "id": hashlib.sha1(e["link"].encode("utf-8")).hexdigest()[:12],
                "src": s["id"], "title": e["title"], "link": e["link"],
                "published": pub.isoformat(), "snippet": snippet(e["desc"]), "image": e.get("img", ""),
            })
        st["ok"], st["count"] = True, len(entries)
    except Exception as ex:
        st["error"] = (type(ex).__name__ + ": " + str(ex))[:120]
    return raw, st


def collect():
    """Крок 1: читаємо всі джерела одночасно (замість по черзі). Порядок результатів лишається як у SOURCES."""
    with ThreadPoolExecutor(max_workers=len(SOURCES)) as pool:
        results = list(pool.map(read_source, SOURCES))
    raw, status = [], []
    for s, (items, st) in zip(SOURCES, results):
        raw.extend(items)
        status.append(st)
        log("%-16s %s" % (s["name"], ("ok, записів: %d" % st["count"]) if st["ok"] else "ПОМИЛКА " + st["error"]))
    return raw, status

def load_store():
    p = os.path.join(DATA, "_store.json")
    try:
        with open(p, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def build(store, now):
    """Кроки 2-4: редагуємо, фільтруємо, зливаємо дублікати, оцінюємо."""
    by_src = {s["id"]: s for s in SOURCES}
    stats = {"irrelevant": 0, "hype": 0, "merged": 0}
    kept = []
    for it in store.values():
        s = by_src.get(it["src"])
        if not s:
            continue
        text = it["title"] + " " + it["snippet"]
        if not CRYPTO.search(text):
            stats["irrelevant"] += 1
            continue
        # «Українські» джерела інколи віддають російськомовні матеріали: такі не показуємо
        if s["lang"] == "uk" and re.search(r"[ыэъёЫЭЪЁ]", text):
            stats["irrelevant"] += 1
            continue
        if s.get("strict") and not re.search(
                r"\b(crypto\w*|digital assets?|blockchain|stablecoin\w*|token\w*|bitcoin|ethereum)\b", text, re.I):
            stats["irrelevant"] += 1
            continue
        if HYPE.search(text):
            stats["hype"] += 1
            continue
        topics = classify(text)
        pos = len(re.findall(POSITIVE, text, re.I))
        neg = len(re.findall(NEGATIVE, text, re.I))
        score = pos - neg
        kept.append(dict(it, source=s["name"], lang=s["lang"], weight=s["weight"], official=bool(s.get("official")),
                         topics=topics, topic=topics[0],
                         coins=[c for c, rx in COINS.items() if re.search(rx, text, re.I)],
                         sentiment=score,
                         sent_label="positive" if score >= 1 else "negative" if score <= -1 else "neutral",
                         tok=tokens(it["title"]), also=[]))

    # Злиття дублікатів: схожі заголовки з різних видань = одна історія
    kept.sort(key=lambda x: (-x["weight"], x["published"]))
    clusters = []
    for it in kept:
        placed = False
        for c in clusters:
            inter = len(it["tok"] & c["tok"])
            if inter < 3:
                continue
            union = len(it["tok"]) + len(c["tok"]) - inter
            if inter / union >= 0.5:
                if c["src"] != it["src"] and all(a["src"] != it["src"] for a in c["also"]):
                    c["also"].append({"src": it["src"], "source": it["source"], "link": it["link"]})
                stats["merged"] += 1
                placed = True
                break
        if not placed:
            clusters.append(it)

    out = []
    for c in clusters:
        pub = datetime.fromisoformat(c["published"])
        hours = max((now - pub).total_seconds() / 3600, 0)
        conf = 1 + len(c["also"])
        bonus = {"regulation": 8, "security": 8, "investment": 5, "stablecoins": 4}.get(c["topic"], 0)
        imp = c["weight"] * 8 + min((conf - 1) * 10, 30) + bonus + max(0, 20 - hours * 0.5)
        c["confirmations"] = conf
        c["importance"] = int(max(0, min(100, round(imp))))
        c["new"] = (now - datetime.fromisoformat(c["first_seen"])).total_seconds() < 1800
        c["impact"] = build_impact(c)
        c.pop("tok", None)
        out.append(c)
    out.sort(key=lambda x: x["published"], reverse=True)
    return out, stats


def build_impact(c):
    """Яких монет стосується новина й як вона може вплинути на ринок (правила, а не прогноз)."""
    coins = c["coins"][:4]
    stable_only = coins and all(x in ("USDT", "USDC") for x in coins)
    if not coins:
        names = "ринку загалом"
    else:
        names = ", ".join(coins)   # тикери (BTC, ETH): так не треба відмінювати назви українською
    topic, tone = c["topic"], c["sent_label"]
    text = IMPACT_TEXT[topic][tone].replace("{c}", names)
    if stable_only and topic != "stablecoins":
        text += " Стейблкоїни прив’язані до долара, тому їхня ціна майже не рухається."

    strong = c["importance"] >= 70 or (c["official"] and topic == "regulation")
    medium = c["importance"] >= 50
    level = "високий" if strong else "середній" if medium else "низький"
    direction = {"positive": "радше підтримує ціни", "negative": "радше тисне на ціни", "neutral": "нейтральний"}[tone]
    return {
        "coins": [{"symbol": x, "name": COIN_INFO[x][0]} for x in coins],
        "level": level, "direction": direction, "tone": tone, "text": text,
    }


def fetch_market():
    """Знімок цін основних монет (Binance). Якщо біржа недоступна у вашому регіоні — повертає None."""
    pairs = sorted({p for _, p in COIN_INFO.values() if p})
    q = urllib.parse.quote(json.dumps(pairs, separators=(",", ":")))
    for host in ("https://data-api.binance.vision", "https://api.binance.com"):
        try:
            rows = json.loads(fetch("%s/api/v3/ticker/24hr?symbols=%s" % (host, q), timeout=15).decode("utf-8"))
            by_pair = {r["symbol"]: r for r in rows}
            coins = {}
            for sym, (_, pair) in COIN_INFO.items():
                if pair and pair in by_pair:
                    coins[sym] = {"price": float(by_pair[pair]["lastPrice"]), "change": float(by_pair[pair]["priceChangePercent"])}
            if coins:
                return {"time": datetime.now(timezone.utc).isoformat(), "source": "Binance", "coins": coins}
        except Exception as ex:
            log("  ціни монет (%s) недоступні: %s" % (host.split("//")[1], str(ex)[:60]))
    return None


def pct(n, total):
    return int(round(100.0 * n / total)) if total else 0


def analyze(items, stats, status, now):
    """Крок 5: підсумки й висновки."""
    window = 24
    recent = [i for i in items if (now - datetime.fromisoformat(i["published"])).total_seconds() <= window * 3600]
    if len(recent) < 8:
        window = 72
        recent = [i for i in items if (now - datetime.fromisoformat(i["published"])).total_seconds() <= window * 3600]
    n = len(recent)
    by_topic = Counter(i["topic"] for i in recent)
    by_source = Counter(i["source"] for i in recent)
    sent = Counter(i["sent_label"] for i in recent)
    coins = Counter(c for i in recent for c in i["coins"])
    coin_sent = defaultdict(int)
    for i in recent:
        for c in i["coins"]:
            coin_sent[c] += i["sentiment"]
    hours = [0] * 24
    for i in items:
        age = (now - datetime.fromisoformat(i["published"])).total_seconds() / 3600
        if 0 <= age < 24:
            hours[23 - int(age)] += 1
    confirmed = [i for i in recent if i["confirmations"] >= 2]
    top = sorted(recent, key=lambda x: x["importance"], reverse=True)[:8]
    warn = [i for i in top if i["confirmations"] == 1 and not i["official"] and i["topic"] in ("regulation", "investment", "security")]
    official = [i for i in recent if i["official"]]
    sec_items = [i for i in recent if i["topic"] == "security"]
    ok_sources = [s for s in status if s["ok"]]

    L = []
    win = "останню добу" if window == 24 else "останні 3 доби"
    L.append("За %s агент знайшов %d матеріалів із %d джерел (працюють %d з %d). Відсіяно як реклама чи «хайп»: %d, не за темою: %d, повторів злито: %d."
             % (win, n, len(by_source), len(ok_sources), len(status), stats["hype"], stats["irrelevant"], stats["merged"]))
    if n:
        t, tc = by_topic.most_common(1)[0]
        L.append("Найактивніша тема: «%s» — %d матеріалів (%d%%)." % (TOPIC_LABELS.get(t, t), tc, pct(tc, n)))
        p, ng = sent["positive"], sent["negative"]
        tone = ("переважає негатив" if ng > p * 1.3 else "переважає позитив" if p > ng * 1.3 else "тон змішаний")
        L.append("Тон заголовків: %s (позитивних %d%%, негативних %d%%, нейтральних %d%%). Це оцінка за словником, вона може помилятися."
                 % (tone, pct(p, n), pct(ng, n), pct(sent["neutral"], n)))
    if coins:
        mc = coins.most_common(3)
        L.append("Найчастіше згадують: " + ", ".join("%s (%d)" % (c, k) for c, k in mc) + ".")
        for c, k in mc[:1]:
            if k >= 3:
                L.append("Навколо %s новини загалом %s." % (c, "негативні" if coin_sent[c] < -1 else "позитивні" if coin_sent[c] > 1 else "нейтральні"))
    if confirmed:
        L.append("Історій, які підтвердили щонайменше два видання: %d. Решту (%d) варто перевіряти." % (len(confirmed), n - len(confirmed)))
    if official:
        L.append("Офіційні джерела (SEC, Federal Register) опублікували %d документів про крипто." % len(official))
    if sec_items:
        L.append("Безпека: %d матеріалів про злами чи шахрайство. Остерігайтеся фішингу та «гарантованого прибутку»." % len(sec_items))
    if warn:
        L.append("Важливі історії лише з одного джерела (потребують підтвердження): " + "; ".join(snippet(w["title"], 80) for w in warn[:3]) + ".")
    bad = [s["name"] for s in status if not s["ok"]]
    if bad:
        L.append("Не вдалося прочитати: " + ", ".join(bad) + ". Агент спробує ще раз.")

    return {
        "generated_at": now.isoformat(), "window_hours": window, "total": n,
        "labels": TOPIC_LABELS,
        "by_topic": dict(by_topic), "by_source": dict(by_source), "sentiment": dict(sent),
        "coins": {c: {"count": k, "sentiment": coin_sent[c]} for c, k in coins.most_common()},
        "activity_24h": hours,
        "top": [{k: i[k] for k in ("id", "title", "title_uk", "link", "source", "published", "topic", "importance", "confirmations") if k in i} for i in top],
        "needs_check": [{k: i[k] for k in ("id", "title", "title_uk", "link", "source", "published") if k in i} for i in warn],
        "filters": stats, "sources": status, "conclusions": L,
    }

# ---------- Переклад українською: агент-перекладач (tools/translator.py) ----------
# Він сам вибирає найкращий доступний спосіб: Claude (якщо задано ANTHROPIC_API_KEY), Argos (офлайн) або
# безкоштовний MyMemory. Переклади кешуються; коли з'являється якісніший перекладач, старі переклади оновлюються.
TR_FILE = "_translations.json"


def load_translations():
    try:
        with open(os.path.join(DATA, TR_FILE), encoding="utf-8") as f:
            d = json.load(f)
    except Exception:
        d = {}
    d.setdefault("budget", {"date": "", "used": 0})
    # старий формат (рядок) → новий (словник)
    d.setdefault("items", {})
    return d


def add_translations(items, now):
    """Перекладає заголовки (і короткі описи, якщо перекладач дозволяє) англомовних новин."""
    from translator import Chain, fix_uk, RANK
    tr = load_translations()
    today = now.strftime("%Y-%m-%d")
    if tr["budget"].get("date") != today:
        tr["budget"] = {"date": today, "used": 0}
    if os.environ.get("ARGOS_ENABLED") != "1":
        # переклади слабкого перекладача на сайті не показуємо: хибний переклад гірший за англійський оригінал
        tr["items"] = {k: v for k, v in tr["items"].items() if v.get("by") != "argos"}
    chain = Chain(tr["budget"], log)
    if chain.providers:
        todo = sorted([i for i in items if i["lang"] == "en" and (
            i["id"] not in tr["items"] or RANK.get(tr["items"][i["id"]].get("by"), 0) < chain.best_rank)],
            key=lambda x: x["importance"], reverse=True)[:150]
        with_snippets = chain.best_rank >= 3    # описи перекладаємо лише якісним перекладачем без жорсткого ліміту (Claude)
        texts, index = [], []
        for it in todo:
            texts.append(it["title"])
            index.append((it["id"], "title"))
            if with_snippets and it.get("snippet"):
                texts.append(it["snippet"])
                index.append((it["id"], "snippet"))
        done = 0
        if texts:
            by_id = {}
            for (iid, kind), (out, by) in zip(index, chain.translate(texts)):
                if out:
                    by_id.setdefault(iid, {})[kind] = out
                    by_id[iid]["by"] = by if kind == "title" else by_id[iid].get("by", by)
            for iid, entry in by_id.items():
                if "title" in entry:
                    tr["items"][iid] = entry
                    done += 1
        log("Переклад: нових %d, у кеші %d" % (done, len(tr["items"])))
    alive = {i["id"] for i in items}
    tr["items"] = {k: v for k, v in tr["items"].items() if k in alive}
    write_json(TR_FILE, tr)
    for it in items:
        e = tr["items"].get(it["id"])
        if e:
            it["title_uk"] = fix_uk(e["title"])
            it["translated_by"] = e.get("by")
            if e.get("snippet"):
                it["snippet_uk"] = fix_uk(e["snippet"])
    return len(tr["items"])


def run_once():
    now = datetime.now(timezone.utc)
    store = load_store()
    before = set(store)
    with ThreadPoolExecutor(max_workers=1) as bg:
        market_future = bg.submit(fetch_market)      # ціни монет завантажуються, поки читаються новини
        raw, status = collect()
        market = market_future.result()
    for r in raw:
        old = store.get(r["id"])
        r["first_seen"] = old["first_seen"] if old else now.isoformat()
        store[r["id"]] = r
    cutoff = now - timedelta(days=KEEP_DAYS)
    store = {k: v for k, v in store.items() if datetime.fromisoformat(v["published"]) >= cutoff}
    write_json("_store.json", store)

    items, stats = build(store, now)
    try:
        translated = add_translations(items, now)
    except Exception as ex:
        translated = 0
        log("Переклад недоступний: %s" % ex)
    analytics = analyze(items, stats, status, now)
    analytics["translated_titles"] = translated
    analytics["by_lang"] = dict(Counter(i["lang"] for i in items))
    if analytics["by_lang"].get("uk"):
        analytics["conclusions"].insert(1, "Українськими джерелами опубліковано матеріалів: %d. Англомовні заголовки перекладено автоматично: %d (машинний переклад, може бути неточним)."
                                        % (analytics["by_lang"]["uk"], translated))
    fresh = [i for i in items if i["id"] not in before]
    news = {"generated_at": now.isoformat(), "new_since_last_run": len(fresh), "labels": TOPIC_LABELS,
            "market": market, "sources": status, "items": items[:MAX_OUT]}
    write_json("news.json", news)
    write_json("analytics.json", analytics)
    log("Готово: %d новин у стрічці, нових з минулого запуску: %d" % (len(items), len(fresh)))
    for line in analytics["conclusions"]:
        log("  • " + line)


def main():
    ap = argparse.ArgumentParser(description="Новинний агент")
    ap.add_argument("--watch", type=int, default=0, metavar="СЕК", help="працювати постійно, оновлюючи кожні N секунд")
    args = ap.parse_args()
    if not args.watch:
        run_once()
        return
    log("Агент працює постійно, оновлення кожні %d с. Зупинити: Ctrl+C." % args.watch)
    while True:
        try:
            run_once()
        except Exception as ex:
            log("ПОМИЛКА циклу: %s" % ex)
        time.sleep(args.watch)


if __name__ == "__main__":
    main()
