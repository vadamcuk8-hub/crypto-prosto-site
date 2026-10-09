"""Агент «Сповіщення Telegram»: надсилає в Telegram рішення віртуальної симуляції (купівлі й продажі вибраних правил), ордери бота
на тестовій біржі та підсумок 7-денного раунду. Це сповіщення про СИМУЛЯЦІЮ, а не поради: у кожному повідомленні є застереження.

Налаштування: створіть бота через @BotFather (отримаєте токен), напишіть йому будь-що й дізнайтесь свій chat id (наприклад, через @userinfobot).
Токен і chat id вставте ЛИШЕ в секрети GitHub TELEGRAM_BOT_TOKEN і TELEGRAM_CHAT_ID: не пишіть їх у чат і файли сайту.
Без секретів агент нічого не надсилає. Перший запуск лише надсилає привітання й запам'ятовує поточні рішення (стару історію не повторює).
Результат: data/notify.json (стан, без токена); пам'ять про надіслане: data/_kb_state.json."""
import html
import json
import os
import urllib.parse
import urllib.request
from datetime import datetime, timezone

from .common import DATA, UA, load_knowledge, now_iso, read_state, write_state
from .insights import item, num

NAME = "notify"
TITLE = "Сповіщення Telegram"
SOURCE = "Telegram Bot API"
INTERVAL = 300
RUNS_LAST = True        # після агента тестової біржі
FOOT = "⚠️ Це віртуальна симуляція, а не фінансова порада й не прогноз."


def load(name):
    try:
        with open(os.path.join(DATA, name + ".json"), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def tg_send(token, chat, text):
    """Надсилає повідомлення; повертає None або текст помилки (без токена)."""
    data = urllib.parse.urlencode({"chat_id": chat, "text": text, "parse_mode": "HTML", "disable_web_page_preview": "true"}).encode()
    req = urllib.request.Request("https://api.telegram.org/bot%s/sendMessage" % token, data=data, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            j = json.loads(r.read().decode("utf-8"))
            return None if j.get("ok") else str(j.get("description", "помилка"))[:120]
    except Exception as ex:      # noqa: BLE001 — мережа чи Telegram недоступні: не зупиняємо решту агентів
        return str(ex).replace(token, "***")[:120]


def esc(v):
    return html.escape(str(v), quote=False)


def px(v):
    return num(v, 2 if v >= 100 else 4) + " $"


def event_text(e, titles):
    buy = e["side"] == "BUY"
    ind = e.get("ind") or {}
    ctx = e.get("ctx") or {}
    lines = ["%s <b>%s</b> (віртуально) %s · %s" % ("🟢" if buy else "🔴", "КУПІВЛЯ" if buy else "ПРОДАЖ", esc(e["coin"]), px(e["price"])),
             "Правило: %s" % esc(titles.get(e["rule"], e["rule"])), "Чому: %s" % esc(e["reason"])]
    if ind:
        lines.append("Спирався: ціна %s, середня 50: %s, RSI %s" % (px(ind["price"]), px(ind["sma50"]), num(ind["rsi"], 0)))
    if ctx.get("label"):
        lines.append("Для довідки (правило цього не враховує): фон %s — %s" % (esc(e["coin"]), esc(ctx["label"].lower())))
    return "\n".join(lines + ["", FOOT])


def order_text(o):
    buy = o["side"] == "BUY"
    f = o.get("fill") or {}
    lines = ["%s <b>ТЕСТОВА БІРЖА: %s</b> %s" % ("🟢" if buy else "🔴", "купівля" if buy else "продаж", esc(o["coin"]))]
    if f.get("qty"):
        lines.append("Виконано: %s %s за середньою ціною %s, сума %s" % (num(f["qty"], 6), esc(o["coin"]), px(f["avg"]), num(f["quote"], 2) + " $"))
    lines.append("Чому: %s" % esc(o.get("reason") or "—"))
    return "\n".join(lines + ["", "⚠️ Ненастоящі гроші тестової біржі, це не фінансова порада."])


def round_text(h, titles):
    rows = sorted(h["strategies"].items(), key=lambda kv: -kv[1]["eq"])
    lines = ["🏁 <b>Підсумок раунду</b> %s → %s" % (esc(h["start"][:10]), esc(h["end"][:10]))]
    for rid, v in rows[:3]:
        lines.append("%s: %s%% (просто тримати: %s%%, угод %d)" % (esc(titles.get(rid, rid)), num((v["eq"] - 1) * 100, 2), num((v["hold"] - 1) * 100, 2), v["trades"]))
    if len(rows) > 3:
        lines.append("Найгірше: %s: %s%%" % (esc(titles.get(rows[-1][0], rows[-1][0])), num((rows[-1][1]["eq"] - 1) * 100, 2)))
    return "\n".join(lines + ["", FOOT])


def run(sender=tg_send):
    kb = load_knowledge(NAME)
    token, chat = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip(), os.environ.get("TELEGRAM_CHAT_ID", "").strip()
    base = {"configured": bool(token and chat), "rules": kb["rules"], "updated": now_iso()}
    if not (token and chat):
        base.update(sent_total=0, last_sent=None, last_error=None,
                    insights=[item("neutral", "Сповіщення Telegram вимкнено: немає TELEGRAM_BOT_TOKEN і TELEGRAM_CHAT_ID (секрети GitHub). Створіть бота через @BotFather і додайте токен та chat id в Settings → Secrets → Actions.")])
        return base

    sim = load("simulation") or {}
    titles = {s["id"]: s["title"] for s in sim.get("strategies", [])}
    events = load("paper_events") or {}
    trader = load("trader") or {}
    st = read_state(NAME) or {}
    sent_ev = st.get("sent", {})
    errors, count = None, 0

    if not st.get("init"):                                           # перший запуск: привітання й «запам'ятати теперішнє»
        err = sender(token, chat, "✅ <b>Сповіщення підключено.</b>\nТут з'являтимуться рішення віртуальної симуляції (купівлі й продажі вибраних правил).\n\n" + FOOT)
        if not err:
            st = {"init": True, "sent": {r: max([e["candle"] for e in events.get(r, [])] or [0]) for r in kb["rules"]},
                  "orders": [o.get("id") for o in (trader.get("orders") or [])], "rounds": len((sim.get("paper") or {}).get("history", [])), "total": 1, "last": now_iso()}
            write_state(NAME, st)
        base.update(sent_total=st.get("total", 0), last_sent=st.get("last"), last_error=err,
                    insights=[item("neutral", "Привітання надіслано: далі приходитимуть нові рішення." if not err else "Не вдалося надіслати привітання: %s" % err)])
        return base

    queue = []
    for r in kb["rules"]:
        for e in sorted(events.get(r, []), key=lambda x: x["candle"]):
            if e["candle"] > sent_ev.get(r, 0) and e["side"] in kb["sides"]:
                queue.append((r, e["candle"], event_text(e, titles)))
    seen_orders = set(st.get("orders", []))
    if kb["include_testnet"]:
        for o in reversed(trader.get("orders") or []):
            if o.get("id") not in seen_orders:
                queue.append(("order", o.get("id"), order_text(o)))
    hist = (sim.get("paper") or {}).get("history", [])
    if kb["round_summary"] and len(hist) > st.get("rounds", 0):
        queue.append(("round", len(hist), round_text(hist[-1], titles)))

    for kind, mark, text in queue[:kb["max_per_run"]]:
        err = sender(token, chat, text)
        if err:
            errors = err
            break
        count += 1
        if kind == "order":
            st.setdefault("orders", []).append(mark)
        elif kind == "round":
            st["rounds"] = mark
        else:
            sent_ev[kind] = max(sent_ev.get(kind, 0), mark)
    st["sent"], st["orders"] = sent_ev, st.get("orders", [])[-200:]
    if count:
        st["total"], st["last"] = st.get("total", 0) + count, now_iso()
    write_state(NAME, st)
    base.update(sent_total=st.get("total", 0), last_sent=st.get("last"), last_error=errors, queued=max(0, len(queue) - kb["max_per_run"]))
    base["insights"] = [item("negative" if errors else "positive", ("Помилка Telegram: %s" % errors) if errors else "Сповіщення працюють: надіслано з початку %d, у цьому запуску %d." % (st.get("total", 0), count))]
    return base


def summary(r):
    return {"sent": r.get("sent_total", 0)}
