#!/usr/bin/env python3
"""Одноразове заповнення історії агентів реальними даними з джерел, щоб графіки були одразу, а не через кілька днів.

  python tools/backfill_history.py

Беруться лише справжні ряди, які джерела вже віддають за минулі дні:
  настрій      — індекс страху й жадібності (Alternative.me), 90 днів
  стейблкоїни  — загальна пропозиція за день (DefiLlama), 90 днів
  мережа       — потужність майнінгу за день (mempool.space), 90 днів
  регулювання  — кількість документів за 7 і 30 днів на кожну дату (за датами публікації у Federal Register)
Ринок і новини такої історії безкоштовно не мають, вони накопичуються самі.
Уже записані дні не чіпаються: справжні записи агента мають перевагу. Скрипт безпечно запускати повторно."""
import os
import sys
from datetime import date, datetime, timedelta, timezone

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from agents import agent_regulation                                      # noqa: E402
from agents.common import DATA, compact_history, get_json, write_json    # noqa: E402
import json                                                              # noqa: E402

DAYS = 90


def day(ts):
    return datetime.fromtimestamp(int(ts), timezone.utc).date()


def sentiment():
    rows = get_json("https://api.alternative.me/fng/?limit=%d" % DAYS)["data"]
    return {day(r["timestamp"]): {"value": int(r["value"])} for r in rows}


def stablecoins():
    chart = get_json("https://stablecoins.llama.fi/stablecoincharts/all")[-DAYS:]
    out = {}
    for p in chart:
        v = (p.get("totalCirculatingUSD") or {}).get("peggedUSD")
        if v:
            out[day(p["date"])] = {"total": round(v)}
    return out


def network():
    hr = get_json("https://mempool.space/api/v1/mining/hashrate/3m").get("hashrates", [])[-DAYS:]
    return {day(h["timestamp"]): {"hashrate_ehs": round(h["avgHashrate"] / 1e18, 1)} for h in hr if h.get("avgHashrate")}


def regulation():
    rules = agent_regulation.Rules()
    docs = [d for d in get_json(agent_regulation.URL).get("results", []) if not rules.noise.search(d.get("title") or "")]
    dates = []
    for d in docs:
        try:
            y, m, dd = map(int, d["publication_date"].split("-"))
            dates.append(date(y, m, dd))
        except Exception:     # noqa: BLE001
            pass
    if not dates:
        return {}
    oldest, today = min(dates), date.today()
    out = {}
    for i in range(DAYS):
        d = today - timedelta(days=i)
        if d - timedelta(days=30) < oldest:       # раніше за межі завантажених документів порахувати чесно не можна
            break
        out[d] = {"d7": sum(1 for x in dates if d - timedelta(days=7) < x <= d),
                  "d30": sum(1 for x in dates if d - timedelta(days=30) < x <= d)}
    return out


SOURCES = {"sentiment": sentiment, "stablecoins": stablecoins, "network": network, "regulation": regulation}


def main():
    today = date.today()
    for name, fn in SOURCES.items():
        try:
            fresh = fn()
        except Exception as ex:      # noqa: BLE001 — одне джерело не повинно зупиняти решту
            print("%-12s ПОМИЛКА: %s" % (name, str(ex)[:100]))
            continue
        path = os.path.join(DATA, "history", name + ".json")
        try:
            with open(path, encoding="utf-8") as f:
                rows = json.load(f)
        except (OSError, ValueError):
            rows = []
        have = {r["date"] for r in rows}
        added = 0
        for d, values in fresh.items():
            if d.isoformat() not in have:
                rows.append({"date": d.isoformat(), "values": values})
                added += 1
        rows.sort(key=lambda r: r["date"])
        write_json(os.path.join("history", name + ".json"), compact_history(rows, today))
        print("%-12s додано днів: %d, усього точок: %d" % (name, added, len(rows)))


if __name__ == "__main__":
    main()
