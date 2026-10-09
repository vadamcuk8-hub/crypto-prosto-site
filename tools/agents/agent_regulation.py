"""Агент «Регулювання»: нові офіційні документи США про криптовалюти. Джерело: Federal Register (відкритий API).
Результат: data/regulation.json (останні документи та кількість документів по тижнях)."""
from datetime import date, timedelta
from .common import get_json, now_iso

NAME = "regulation"
TITLE = "Регулювання"
SOURCE = "Federal Register"
INTERVAL = 3600

URL = ("https://www.federalregister.gov/api/v1/documents.json?conditions[term]=crypto&order=newest&per_page=100"
       "&fields[]=title&fields[]=publication_date&fields[]=html_url&fields[]=agencies&fields[]=type")
TYPES = {"Rule": "Правило", "Proposed Rule": "Проєкт правила", "Notice": "Повідомлення", "Presidential Document": "Президентський документ"}


def run():
    j = get_json(URL)
    docs = j.get("results", [])
    today = date.today()
    weeks = [0] * 12                     # 12 тижнів, останній елемент — поточний
    for d in docs:
        try:
            y, m, dd = map(int, d["publication_date"].split("-"))
        except Exception:                # noqa: BLE001
            continue
        age_weeks = (today - date(y, m, dd)).days // 7
        if 0 <= age_weeks < 12:
            weeks[11 - age_weeks] += 1
    week_start = [(today - timedelta(days=7 * (11 - i))).isoformat() for i in range(12)]
    latest = []
    for d in docs[:6]:
        latest.append({
            "title": d.get("title"), "date": d.get("publication_date"), "url": d.get("html_url"),
            "agency": ", ".join(a.get("name", "") for a in (d.get("agencies") or [])[:2]),
            "type": TYPES.get(d.get("type"), d.get("type")),
        })
    return {"total_all_time": j.get("count"), "weeks": weeks, "week_start": week_start, "latest": latest, "updated": now_iso()}
