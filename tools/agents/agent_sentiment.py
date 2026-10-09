"""Агент «Настрій»: індекс страху й жадібності за 30 днів. Джерело: Alternative.me. Результат: data/sentiment.json."""
from .common import get_json, now_iso

NAME = "sentiment"
TITLE = "Настрій ринку"
SOURCE = "Alternative.me"
INTERVAL = 1800

LABELS = {"Extreme Fear": "Надзвичайний страх", "Fear": "Страх", "Neutral": "Нейтрально",
          "Greed": "Жадібність", "Extreme Greed": "Надзвичайна жадібність"}


def run():
    rows = get_json("https://api.alternative.me/fng/?limit=30")["data"]      # від нових до старих
    history = [{"t": int(r["timestamp"]), "v": int(r["value"])} for r in reversed(rows)]
    values = [h["v"] for h in history]
    now = rows[0]
    return {
        "value": int(now["value"]), "label": LABELS.get(now["value_classification"], now["value_classification"]),
        "history": history,
        "avg30": round(sum(values) / len(values), 1), "min30": min(values), "max30": max(values),
        "yesterday": int(rows[1]["value"]) if len(rows) > 1 else None,
        "week_ago": int(rows[7]["value"]) if len(rows) > 7 else None,
        "updated": now_iso(),
    }
