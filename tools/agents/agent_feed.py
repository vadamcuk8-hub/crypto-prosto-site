"""Агент «Жива стрічка подій»: збирає ПІДТВЕРДЖЕНІ торгові події в один журнал data/live_feed.json для стрічки на сайті.

Джерела (нічого не вигадуємо й не рахуємо заново, лише читаємо те, що вже записали інші агенти):
  • журнали рішень рушія симуляції data/paper_events*.json: віртуальні угоди кожного гаманця й бота (підтвердження «за моделлю симулятора»);
  • журнал ордерів Binance Testnet data/_trader_log.json: виконання на тестовій біржі (ненастоящі гроші; підтвердження «від біржі»).
Це ЖУРНАЛ ПОДІЙ, а не повна історія угод: зберігаються останні MAX_EVENTS записів, старіші видаляються (політика записана у файлі).
Агент нічого не торгує, не змінює рішень, балансів і формул: лише читає файли й пише журнал.

Надійність: ID події стабільний (хеш полів події або біржовий orderId), тож повторний запуск, перезапис гілки data чи повторна доставка не створюють дублів;
запис файлу атомарний, поруч лежить попередня копія live_feed.prev.json; пошкоджений журнал замінюється копією, а за її відсутності відновлюється з джерел."""
import hashlib
import json
import os
import re
import shutil
from datetime import datetime, timezone

from .common import DATA, load_knowledge, now_iso, write_json
from .insights import item

NAME = "feed"
TITLE = "Жива стрічка подій"
SOURCE = "Журнал рішень симуляції та Binance Testnet"
INTERVAL = 600
RUNS_LAST = True        # після «Симуляції» й «Тестової біржі», які пишуть джерела
JOURNAL = "live_feed"
SCHEMA = 1
MAX_EVENTS = 1000
REASON_MAX = 160
EXITS = ("stop", "take", "trail", "trend", "signal", "unknown")
POLICY = ("Журнал підтверджених подій, а НЕ повна історія угод: зберігаються останні %d подій, старіші видаляються. "
          "Віртуальні угоди (source=sim) підтверджені моделлю симулятора, але не є біржовими операціями; source=testnet — виконання на Binance Testnet (ненастоящі гроші). "
          "Цінові сповіщення (беззбитковість, перехід PnL) сюди не потрапляють: вони рахуються в браузері за живою ціною." % MAX_EVENTS)


def _read(name):
    try:
        with open(os.path.join(DATA, name + ".json"), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def _num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and v == v and abs(v) != float("inf")


def _ms(iso):
    """ISO-час → мілісекунди; None, якщо рядок нечитабельний."""
    try:
        d = datetime.fromisoformat(str(iso))
        if d.tzinfo is None:
            d = d.replace(tzinfo=timezone.utc)
        return int(d.timestamp() * 1000)
    except (ValueError, TypeError):
        return None


def _hash(parts):
    return hashlib.sha1(json.dumps(parts, ensure_ascii=False, separators=(",", ":"), default=str).encode("utf-8")).hexdigest()[:16]


# ---------- Журнал: читання з перевіркою ----------
def clean_event(e):
    """Перевіряє одну подію з журналу; нечитабельну відкидає (одна погана подія не губить решту)."""
    if not isinstance(e, dict) or not isinstance(e.get("id"), str) or not e["id"] or len(e["id"]) > 80:
        return None
    if not _num(e.get("t")) or e.get("source") not in ("sim", "testnet") or e.get("type") not in ("open", "close"):
        return None
    if not isinstance(e.get("coin"), str) or not isinstance(e.get("bot"), str) or not _num(e.get("price")) or not (isinstance(e.get("wallet"), int) or e.get("wallet") == "testnet"):
        return None
    return e


def valid_journal(d):
    return isinstance(d, dict) and d.get("v") == SCHEMA and isinstance(d.get("events"), list)


def read_journal():
    """(події, головний файл читабельний?, відновлено з копії?). Головний файл → копія → порожній журнал (далі його перебудують джерела)."""
    main = _read(JOURNAL)
    if valid_journal(main):
        return [x for x in map(clean_event, main["events"]) if x], True, False
    prev = _read(JOURNAL + ".prev")
    if valid_journal(prev):
        return [x for x in map(clean_event, prev["events"]) if x], False, True
    return [], False, False


# ---------- Джерела ----------
def wallet_files(prefix, caps):
    """{сума гаманця: ім'я файлу}: без суфікса — середній гаманець, _N — гаманець на N доларів."""
    mid = caps[min(1, len(caps) - 1)]
    out = {}
    try:
        names = os.listdir(DATA)
    except OSError:
        return out
    for n in sorted(names):
        m = re.match(r"^" + re.escape(prefix) + r"(?:_(\d+))?\.json$", n)
        if m:
            out[int(m.group(1)) if m.group(1) else mid] = n[:-5]
    return out


def sim_events(kb, titles):
    out = []
    for cap, name in wallet_files("paper_events", [int(c) for c in kb["accounts"]]).items():
        data = _read(name)
        if not isinstance(data, dict):
            continue
        for rule, lst in data.items():
            if not isinstance(lst, list):
                continue
            seen = {}
            for e in lst:
                if not (isinstance(e, dict) and e.get("side") in ("BUY", "SELL") and isinstance(e.get("coin"), str) and _num(e.get("price")) and _num(e.get("eq")) and _num(e.get("candle")) and _ms(e.get("at")) is not None):
                    continue
                base = _hash(["sim", cap, rule, e["coin"], e["side"], e["candle"], e["at"], e["price"], e["eq"], e.get("cost")])
                n = seen[base] = seen.get(base, 0) + 1                  # справді однакові записи (практично неможливо) все одно отримують різні ID
                ev = {"id": "sim-" + base + ("~%d" % n if n > 1 else ""), "t": _ms(e["at"]), "candle": e["candle"], "source": "sim", "confirmed": "engine",
                      "type": "open" if e["side"] == "BUY" else "close", "coin": e["coin"], "pair": e["coin"] + "/USDT", "wallet": cap, "bot": rule,
                      "bot_title": titles.get(rule, rule), "direction": "LONG", "price": e["price"], "eq": e["eq"],
                      "w": e.get("w") if _num(e.get("w")) else None, "cost": e.get("cost") if _num(e.get("cost")) else None,
                      "reason": str(e.get("reason") or "")[:REASON_MAX]}
                if e["side"] == "BUY" and str(e.get("reason") or "").startswith("Початкова позиція"):
                    ev["initial"] = True                                  # позиція на старті раунду (не рішення посеред раунду): лишається в журналі для пар, але в стрічці не показується
                if e["side"] == "SELL":
                    ev["exit"] = e.get("exit") if e.get("exit") in EXITS else "unknown"        # причину не вгадуємо: немає поля — unknown
                out.append(ev)
    return out


def testnet_events():
    log = _read("_trader_log")
    if not isinstance(log, list):
        return []
    trader_kb = {}
    try:
        trader_kb = load_knowledge("trader")
    except (OSError, ValueError):
        pass
    rule = trader_kb.get("strategy", "testnet")
    out = []
    for o in log:
        if not (isinstance(o, dict) and o.get("side") in ("BUY", "SELL") and isinstance(o.get("coin"), str)):
            continue
        fill = o.get("fill") if isinstance(o.get("fill"), dict) else {}
        qty, quote = fill.get("qty"), fill.get("quote")
        if not (_num(qty) and qty > 0 and _num(quote) and quote > 0) or _ms(o.get("t")) is None:
            continue                                                             # без фактичного виконання (кількість і сума від біржі) подію не створюємо
        oid = o.get("id")
        status = str(o.get("status") or "")
        ev = {"id": ("tn-%s-%s" % (o["coin"], oid)) if oid is not None else "tn-" + _hash([o["coin"], o["side"], o.get("t"), qty, quote]), "t": _ms(o["t"]), "source": "testnet",
              "confirmed": "exchange", "type": "open" if o["side"] == "BUY" else "close", "coin": o["coin"], "pair": o["coin"] + "/USDT", "wallet": "testnet", "bot": rule,
              "bot_title": rule, "direction": "LONG", "price": fill.get("avg") if _num(fill.get("avg")) else o.get("price"), "qty": qty, "quote": quote,
              "order_id": str(oid) if oid is not None else None, "status": status[:20],
              "fees": fill.get("fees") if isinstance(fill.get("fees"), dict) else {}, "reason": str(o.get("reason") or "")[:REASON_MAX]}
        if not _num(ev["price"]):
            continue
        if o["side"] == "SELL":
            ev["exit"] = "unknown"                                               # тестова біржа виконує рішення правила, причину виходу не вгадуємо
            ev["partial"] = status == "PARTIALLY_FILLED"                          # часткове виконання лише за явним статусом біржі
        out.append(ev)
    return out


# ---------- Пари купівля → продаж ----------
def pair_events(events, fee):
    """Дописує до закриттів вхідну ціну й реалізований результат (один раз; готові значення не перераховуються).
    Формули ті самі, що показує сторінка «Симуляція»: pnl_pct = eq_продажу / (eq_купівлі·(1−витрати входу)) − 1, pnl_usd = сума·частка·(eq_продажу − eq_купівлі).
    Testnet: різниця сум у USDT за фактичними виконаннями (комісії в інших активах не конвертуються й лишаються в fees)."""
    groups = {}
    for e in sorted(events, key=lambda x: (x["t"], x["id"])):
        groups.setdefault((e["source"], e["wallet"], e["bot"], e["coin"]), []).append(e)
    for g in groups.values():
        cur = None
        for e in g:
            if e["type"] == "open":
                cur = e
                continue
            if "pos" in e:                                                        # вже оброблено раніше
                if not e.get("partial"):
                    cur = None
                continue
            e["pos"] = cur["id"] if cur else None
            e["result"] = "unknown"
            if cur is not None and not e.get("partial"):
                if e["source"] == "sim" and _num(cur.get("eq")) and _num(e.get("eq")) and cur["eq"] > 0 and _num(cur.get("w")) and isinstance(e["wallet"], int):
                    ce = cur["cost"] if _num(cur.get("cost")) else fee
                    e["entry_price"], e["entry_t"] = cur["price"], cur["t"]
                    e["pnl_pct"] = round((e["eq"] / (cur["eq"] * (1 - ce)) - 1) * 100, 4)
                    e["pnl_usd"] = round(e["wallet"] * cur["w"] * (e["eq"] - cur["eq"]), 4)
                    e["qty"] = round(e["wallet"] * cur["w"] * cur["eq"] * (1 - ce) / cur["price"], 8) if cur["price"] else None
                    e["pnl_basis"] = "model"                         # результат за моделлю симулятора (комісія й проковзання моделі враховані)
                elif e["source"] == "testnet" and _num(cur.get("quote")) and _num(e.get("quote")) and cur["quote"] > 0:
                    e["entry_price"], e["entry_t"] = cur["price"], cur["t"]
                    e["pnl_usd"] = round(e["quote"] - cur["quote"], 6)
                    e["pnl_pct"] = round(e["pnl_usd"] / cur["quote"] * 100, 4)
                    e["pnl_basis"] = "quote_diff"                    # різниця сум у USDT: комісії біржі (часто в BNB чи базовій монеті) повністю не враховано, це НЕ точний чистий PnL
                if _num(e.get("pnl_usd")):
                    e["result"] = "profit" if e["pnl_usd"] > 1e-9 else "loss" if e["pnl_usd"] < -1e-9 else "flat"
            if not e.get("partial"):
                cur = None


def open_positions(kb, events, fee, titles):
    """Відкриті віртуальні позиції з файлів стану рушія (ціна входу — з нього, а не з припущень): для браузерних цінових сповіщень."""
    out = []
    for cap, name in wallet_files("_paper", [int(c) for c in kb["accounts"]]).items():
        st = _read(name)
        if not isinstance(st, dict):
            continue
        rstart = (st.get("round") or {}).get("start")
        for rule, sd in (st.get("strategies") or {}).items():
            for sym, co in ((sd or {}).get("coins") or {}).items():
                if not (isinstance(co, dict) and co.get("pos") and _num(co.get("entry")) and co["entry"] > 0):
                    continue
                buys = [e for e in events if e["source"] == "sim" and e["wallet"] == cap and e["bot"] == rule and e["coin"] == sym and e["type"] == "open"]
                buy = max(buys, key=lambda x: (x["t"], x["id"])) if buys else None
                if buy and abs(buy["price"] / co["entry"] - 1) > 1e-6:
                    buy = None
                w = (sd.get("w") or {}).get(sym)
                out.append({"pos": buy["id"] if buy else "open-%s-%s-%s-%s" % (cap, rule, sym, rstart), "wallet": cap, "bot": rule, "bot_title": titles.get(rule, rule), "coin": sym,
                            "pair": sym + "/USDT", "direction": "LONG", "entry": co["entry"], "entry_t": buy["t"] if buy else None,
                            "entry_cost": buy["cost"] if buy and _num(buy.get("cost")) else fee, "w": w if _num(w) else None})
    return sorted(out, key=lambda x: (x["wallet"], x["bot"], x["coin"]))


def run():
    kb = load_knowledge("simulation")
    titles = {s["id"]: s["title"] for s in kb["strategies"]}
    sim = _read("simulation") or {}
    fee = (sim.get("paper") or {}).get("fee")
    if not _num(fee):
        fee = kb["fee"] + kb.get("slippage", 0.0)

    old, main_ok, recovered = read_journal()
    by_id = {e["id"]: e for e in old}                                            # події з журналу незмінні: нові дані їх не перезаписують
    fresh = [e for e in sim_events(kb, titles) + testnet_events() if e["id"] not in by_id]
    seen = set()
    new = []
    for e in fresh:
        if e["id"] not in seen:
            seen.add(e["id"])
            new.append(e)
            by_id[e["id"]] = e
    events = sorted(by_id.values(), key=lambda x: (x["t"], x["id"]))
    for e in events:                                                              # журнали, створені до появи прапорця initial: дописуємо його за записом рушія (причина стартової позиції)
        if e["source"] == "sim" and e["type"] == "open" and "initial" not in e and str(e.get("reason") or "").startswith("Початкова позиція"):
            e["initial"] = True
    pair_events(events, fee)
    total_before_trim = len(events)
    events = events[-MAX_EVENTS:]
    trimmed = total_before_trim - len(events)
    prev_meta = _read(JOURNAL) if main_ok else None
    dropped = (prev_meta or {}).get("dropped", 0) + trimmed if isinstance(prev_meta, dict) else trimmed
    positions = open_positions(kb, events, fee, titles)

    journal = {"v": SCHEMA, "updated": now_iso(), "policy": POLICY, "max_events": MAX_EVENTS, "dropped": dropped,
               "fee": fee, "events": events, "open": positions}
    live = os.path.join(DATA, JOURNAL + ".json")
    if main_ok and os.path.exists(live):
        try:
            shutil.copyfile(live, os.path.join(DATA, JOURNAL + ".prev.json"))   # попередня справна копія
        except OSError:
            pass
    write_json(JOURNAL + ".json", journal)
    msg = "Журнал: %d подій (нових %d), відкритих віртуальних позицій %d." % (len(events), len(new), len(positions))
    if recovered:
        msg += " Основний файл був пошкоджений: відновлено з попередньої копії."
    elif not main_ok and old == [] and not _read(JOURNAL + ".prev"):
        msg += " Журнал створено заново з наявних записів джерел."
    return {"updated": now_iso(), "events_total": len(events), "new_events": len(new), "open_positions": len(positions), "recovered": recovered, "dropped": dropped,
            "insights": [item("neutral", msg)]}


def summary(r):
    return {"events": r.get("events_total", 0), "new": r.get("new_events", 0)}
