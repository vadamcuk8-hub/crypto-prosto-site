"""Агент «Регулювання»: нові офіційні документи США про криптовалюти. Джерело: Federal Register (відкритий API).
Результат: data/regulation.json — підсумки за 7/30 днів, документи по тижнях, розподіл за типами й відомствами,
останні документи з темою й поясненням простими словами та список документів, яких агент «не зрозумів».
Правила (теми, відомства, виправлення) лежать у knowledge/regulation.json: їх можна поповнювати без програмування."""
import re
from datetime import date, timedelta
from .common import get_json, load_knowledge, now_iso, read_state, write_state
from .insights import Rules as TextRules

NAME = "regulation"
TITLE = "Регулювання"
SOURCE = "Federal Register"
INTERVAL = 3600
STALE_RULE_DAYS = 180     # скільки діб правило може не спрацьовувати, перш ніж його позначать застарілим

URL = ("https://www.federalregister.gov/api/v1/documents.json?conditions[term]=crypto&order=newest&per_page=100"
       "&fields[]=title&fields[]=publication_date&fields[]=html_url&fields[]=agencies&fields[]=type")


class Rules:
    """База знань агента: компілює правила з knowledge/regulation.json."""

    def __init__(self):
        kb = load_knowledge("regulation")
        self.other = kb["other_label"]
        self.other_hint = kb["other_hint"]
        self.noise = re.compile(kb["noise_pattern"], re.I)
        self.types = kb["types"]
        self.type_hints = kb["type_hints"]
        self.agencies = [(re.compile(a["pattern"], re.I), a["short"]) for a in kb["agencies"]]
        self.topics = [(re.compile(t["pattern"], re.I), t["label"], t["hint"]) for t in kb["topics"]]
        self.overrides = [(o["contains"].lower(), o["topic"]) for o in kb.get("overrides", []) if o.get("contains") and o.get("topic")]
        self.hint_of = {t["label"]: t["hint"] for t in kb["topics"]}
        self.used = set()          # які виправлення спрацювали в цьому запуску

    def stale_overrides(self, today):
        """Виправлення, що не спрацьовували понад STALE_RULE_DAYS: їх лише позначаємо (вручну написані правила не видаляємо мовчки).
        Дати останнього збігу зберігаються в data/_kb_state.json; правила, яких уже немає в базі, зі стану прибираються."""
        seen = read_state(NAME)
        out, fresh = [], {}
        for needle, topic in self.overrides:
            last = today.isoformat() if needle in self.used else seen.get(needle, today.isoformat())
            fresh[needle] = last
            if days_ago(last, today) > STALE_RULE_DAYS:
                out.append({"contains": needle, "topic": topic, "last_matched": last})
        write_state(NAME, fresh)
        return out

    def agency(self, raw):
        names = [a.get("name", "") for a in (raw or []) if a.get("name")]
        for n in names:
            for rx, short in self.agencies:
                if rx.search(n):
                    return short
        return names[0] if names else "Не вказано"

    def topic(self, title):
        """Повертає (тема, пояснення, чи_знайшли_правило). Спершу виправлення від людини, потім правила за ключовими словами."""
        low = (title or "").lower()
        for needle, label in self.overrides:
            if needle in low:
                self.used.add(needle)
                return label, self.hint_of.get(label, ""), True
        for rx, label, hint in self.topics:
            if rx.search(title or ""):
                return label, hint, True
        return self.other, self.other_hint, False


def short_title(t, limit=120):
    t = re.sub(r"\s+", " ", t or "").strip()
    return t if len(t) <= limit else t[:limit].rsplit(" ", 1)[0].rstrip(" ,;:.-") + "…"


def days_ago(iso, today):
    try:
        y, m, d = map(int, iso.split("-"))
        return (today - date(y, m, d)).days
    except Exception:  # noqa: BLE001
        return None


def top_counts(counter, n):
    return [{"label": k, "count": v} for k, v in sorted(counter.items(), key=lambda kv: -kv[1])[:n]]


def run():
    rules = Rules()
    j = get_json(URL)
    docs = [d for d in j.get("results", []) if not rules.noise.search(d.get("title") or "")]
    today = date.today()
    weeks = [0] * 12                     # 12 тижнів, останній елемент — поточний
    d7 = d30 = prev30 = 0
    by_type, by_agency, by_topic = {}, {}, {}
    to_teach = []
    for d in docs:
        age = days_ago(d.get("publication_date", ""), today)
        if age is None or age < 0:
            continue
        if age // 7 < 12:
            weeks[11 - age // 7] += 1
        d7 += age < 7
        d30 += age < 30
        prev30 += 30 <= age < 60
        label, _, known = rules.topic(d.get("title"))
        if age < 90:
            t = rules.types.get(d.get("type"), d.get("type") or "Інше")
            by_type[t] = by_type.get(t, 0) + 1
            a = rules.agency(d.get("agencies"))
            by_agency[a] = by_agency.get(a, 0) + 1
            by_topic[label] = by_topic.get(label, 0) + 1
        if not known and len(to_teach) < 5:
            to_teach.append({"title": short_title(d.get("title"), 140), "agency": rules.agency(d.get("agencies")), "date": d.get("publication_date")})
    week_start = [(today - timedelta(days=7 * (11 - i))).isoformat() for i in range(12)]
    latest = []
    for d in docs[:8]:
        tp = rules.types.get(d.get("type"), d.get("type") or "Інше")
        label, hint, _ = rules.topic(d.get("title"))
        latest.append({
            "title": short_title(d.get("title")), "title_full": d.get("title"), "date": d.get("publication_date"),
            "url": d.get("html_url"), "agency": rules.agency(d.get("agencies")), "type": tp, "type_hint": rules.type_hints.get(tp, ""),
            "topic": label, "topic_hint": hint,
        })
    result = {
        "total_all_time": j.get("count"), "stats": {"d7": d7, "d30": d30, "prev30": prev30},
        "weeks": weeks, "week_start": week_start, "by_type": top_counts(by_type, 4),
        "by_agency": top_counts(by_agency, 5), "by_topic": top_counts(by_topic, 6),
        "latest": latest, "to_teach": to_teach, "stale_rules": rules.stale_overrides(today), "updated": now_iso(),
    }
    result["insights"] = insights(result)
    return result


def insights(r):
    """Висновки: активність регуляторів, головне відомство й тема, скільки документів справді обов'язкові (knowledge/regulation.json)."""
    k = TextRules(NAME)
    s, out = r["stats"], []
    diff = s["d30"] - s["prev30"]
    key, tone = (("activity_up", "neutral") if diff >= k.thr["change_notable"] else
                 ("activity_down", "neutral") if diff <= -k.thr["change_notable"] else ("activity_flat", "neutral"))
    out.append(k.say(tone, key, d30=s["d30"], diff=abs(diff)))
    if r["by_agency"]:
        out.append(k.say("neutral", "top_agency", agency=r["by_agency"][0]["label"], n=r["by_agency"][0]["count"]))
    if r["by_topic"]:
        out.append(k.say("neutral", "top_topic", topic=r["by_topic"][0]["label"], n=r["by_topic"][0]["count"]))
    total = sum(x["count"] for x in r["by_type"])
    rules_n = next((x["count"] for x in r["by_type"] if x["label"] == "Правило"), 0)
    if total:
        out.append(k.say("neutral", "binding", n=total, r=rules_n))
    if r["to_teach"]:
        out.append(k.say("neutral", "unknown", u=len(r["to_teach"])))
    return out


def summary(result):
    """Числа для історії (одна точка на день): так видно динаміку за місяці."""
    return {"d7": result["stats"]["d7"], "d30": result["stats"]["d30"], "unknown": len(result["to_teach"])}
