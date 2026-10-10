#!/usr/bin/env python3
"""Перевірка роботи агентів: чи є файли даних, чи в них потрібні поля й чи вони свіжі.

  python tools/check_data.py           таблиця по кожному агенту; код виходу 1, якщо є проблема
  python tools/check_data.py --quiet   лише проблеми

Ту саму перевірку запускає GitHub Actions після кожного оновлення: якщо агент зламався,
запуск позначається червоним, і це видно у вкладці Actions.
"""
import json
import os
import sys
from datetime import datetime, timezone

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.environ.get("CRYPTO_DATA_DIR") or os.path.join(ROOT, "data")
STALE_MIN_S = 2700   # те саме правило, що isStale() у agent-ui.js
MAX_DATA_MB = 20     # якщо папка data виросла більше, щось не прибирає за собою

# агент → які файли він пише і які поля в них обов'язкові (ті, що читає сайт)
CHECKS = {
    "market": {"market": ["global", "top", "gainers", "losers", "insights"]},
    "network": {"network": ["fees", "mempool", "height", "hashrate_ehs", "hashrate_history", "insights"]},
    "sentiment": {"sentiment": ["value", "label", "history", "insights"]},
    "stablecoins": {"stablecoins": ["total", "history", "top", "insights"]},
    "regulation": {"regulation": ["weeks", "latest", "insights"]},
    "signals": {"signals": ["coins", "backtest", "insights"]},
    "outlook": {"outlook": ["coins", "market", "insights"]},
    "report": {"report": ["headline", "sections", "archive", "insights"]},
    "trader": {"trader": ["insights"]},
    "feed": {"feed": ["insights"]},
    "analyst": {"analyst": ["insights"]},
    "notify": {"notify": ["insights"]},
    "simulation": {"simulation": ["paper", "strategies", "insights"], "simulation_history": ["coins"]},
    "news": {"news": ["items"], "analytics": ["top", "activity_24h", "conclusions"]},
}


def load(name):
    with open(os.path.join(DATA, name + ".json"), encoding="utf-8") as f:
        return json.load(f)


def age_seconds(iso):
    return (datetime.now(timezone.utc) - datetime.fromisoformat(iso)).total_seconds()


def check_agent(name, files, status):
    """Повертає список проблем для одного агента (порожній, якщо все гаразд)."""
    problems = []
    if not status:
        problems.append("немає запису в agents.json")
    else:
        if not status.get("ok"):
            problems.append("останній запуск не вдався: " + (status.get("error") or "?"))
        last = status.get("last_ok")
        if not last:
            problems.append("жодного успішного запуску")
        elif age_seconds(last) > max(status.get("interval", 0) * 3, STALE_MIN_S):
            problems.append("дані застаріли (%d хв)" % (age_seconds(last) / 60))
    for fname, keys in files.items():
        try:
            d = load(fname)
        except (OSError, ValueError) as ex:
            problems.append("файл %s.json: %s" % (fname, type(ex).__name__))
            continue
        missing = [k for k in keys if k not in d or d[k] in (None, "", [], {})]
        if missing:
            problems.append("у %s.json порожні поля: %s" % (fname, ", ".join(missing)))
    return problems


def main():
    quiet = "--quiet" in sys.argv
    try:
        status = load("agents").get("agents", {})
    except (OSError, ValueError):
        status = {}
    bad = 0
    for name, files in CHECKS.items():
        problems = check_agent(name, files, status.get(name))
        bad += bool(problems)
        if problems:
            print("ПРОБЛЕМА  %-12s %s" % (name, "; ".join(problems)))
        elif not quiet:
            last = status[name]["last_ok"]
            print("ok        %-12s оновлено %d хв тому" % (name, age_seconds(last) / 60))
    size = sum(os.path.getsize(os.path.join(p, f)) for p, _, fs in os.walk(DATA) for f in fs)
    print("Розмір папки data: %.1f МБ%s" % (size / 1e6, "  (забагато: перевірте історію й _store.json)" if size > MAX_DATA_MB * 1e6 else ""))
    bad += size > MAX_DATA_MB * 1e6
    print("Агентів з проблемами: %d з %d" % (bad, len(CHECKS)))
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
