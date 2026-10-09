"""Агент «Настрій»: індекс страху й жадібності за 30 днів. Джерело: Alternative.me. Результат: data/sentiment.json."""
from .common import get_json, now_iso
from .insights import Rules, num, plural

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
    result = {
        "value": int(now["value"]), "label": LABELS.get(now["value_classification"], now["value_classification"]),
        "history": history,
        "avg30": round(sum(values) / len(values), 1), "min30": min(values), "max30": max(values),
        "yesterday": int(rows[1]["value"]) if len(rows) > 1 else None,
        "week_ago": int(rows[7]["value"]) if len(rows) > 7 else None,
        "updated": now_iso(),
    }
    result["insights"] = insights(result)
    return result


def pts(n):
    return plural(n, "пункт", "пункти", "пунктів")


def insights(r):
    """Висновки про настрій: рівень, зміна за добу й тиждень, відхилення від середнього (пороги й тексти — knowledge/sentiment.json)."""
    k = Rules(NAME)
    t, v, out = k.thr, r["value"], []
    out.append(k.say("neutral", "level", value=v, label=r["label"]))
    if v <= t["extreme_low"]:
        out.append(k.say("negative", "extreme_fear", thr=t["extreme_low"]))
    elif v >= t["extreme_high"]:
        out.append(k.say("neutral", "extreme_greed", thr=t["extreme_high"]))
    y = r["yesterday"]
    if y is not None:
        d = v - y
        out.append(k.say("positive", "day_up", d=d, pt=pts(d), y=y) if d > 0 else k.say("negative", "day_down", d=-d, pt=pts(d), y=y) if d < 0
                    else k.say("neutral", "day_flat", y=y))
    w = r["week_ago"]
    if w is not None:
        d = v - w
        if d >= t["big_move"]:
            out.append(k.say("positive", "week_sharp_up", w=d, pt=pts(d)))
        elif d <= -t["big_move"]:
            out.append(k.say("negative", "week_sharp_down", w=-d, pt=pts(d)))
        else:
            out.append(k.say("neutral", "week_calm", w=("+" if d > 0 else "") + str(d), x=w))
    d = int(round(v - r["avg30"]))
    if d >= t["vs_average"]:
        out.append(k.say("positive", "above_average", avg=num(r["avg30"], 1), d=d, pt=pts(d)))
    elif d <= -t["vs_average"]:
        out.append(k.say("negative", "below_average", avg=num(r["avg30"], 1), d=-d, pt=pts(d)))
    else:
        out.append(k.say("neutral", "near_average", avg=num(r["avg30"], 1)))
    out.append(k.say("neutral", "range", mn=r["min30"], mx=r["max30"], r=r["max30"] - r["min30"], pt=pts(r["max30"] - r["min30"])))
    return out


def summary(r):
    return {"value": r["value"]}
