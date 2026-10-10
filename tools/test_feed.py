#!/usr/bin/env python3
"""Тести агента «Жива стрічка» (tools/agents/agent_feed.py) без мережі й без Node.js.

  python tools/test_feed.py

Працює в тимчасовій папці даних (CRYPTO_DATA_DIR), справжні файли data/ не чіпає."""
import json
import os
import shutil
import sys
import tempfile

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

TMP = tempfile.mkdtemp(prefix="feedtest_")
os.environ["CRYPTO_DATA_DIR"] = TMP
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from agents import agent_feed as F          # noqa: E402
from agents import agent_simulation as S    # noqa: E402

passed = failed = 0


def put(name, obj):
    with open(os.path.join(TMP, name), "w", encoding="utf-8") as f:
        if isinstance(obj, str):
            f.write(obj)
        else:
            json.dump(obj, f, ensure_ascii=False)


def get(name):
    with open(os.path.join(TMP, name), encoding="utf-8") as f:
        return json.load(f)


def reset():
    for n in os.listdir(TMP):
        p = os.path.join(TMP, n)
        shutil.rmtree(p) if os.path.isdir(p) else os.remove(p)


def ev(side, at, price, eq, candle=1, coin="BNB", rule="trend_1h", cost=0.0015, w=0.25, **kw):
    d = {"at": at, "candle": candle, "coin": coin, "side": side, "price": price, "rule": rule, "tf": "1h", "w": w, "eq": eq, "cost": cost, "reason": "тест"}
    d.update(kw)
    return d


def events():
    return get("live_feed.json")["events"]


def test(name):
    def deco(fn):
        global passed, failed
        reset()
        try:
            fn()
            passed += 1
            print("  ok  " + name)
        except Exception as ex:      # noqa: BLE001
            failed += 1
            print("  ПРОВАЛ  %s: %s: %s" % (name, type(ex).__name__, ex))
        return fn
    return deco


T0 = "2026-10-10T10:00+00:00"
T1 = "2026-10-10T10:30+00:00"
SELL_EQ = round(1.0 * (1 - 0.0015) * 1.01 * (1 - 0.0015), 5)


@test("Закриття з прибутком: пара купівля→продаж, результат за формулами сторінки, причина виходу береться з рушія")
def _():
    put("paper_events.json", {"trend_1h": [ev("BUY", T0, 100, 1.0), ev("SELL", T1, 101, SELL_EQ, candle=2, exit="take")]})
    F.run()
    e = events()
    assert [x["type"] for x in e] == ["open", "close"], e
    c = e[1]
    assert c["pnl_basis"] == "model"
    assert c["exit"] == "take" and c["result"] == "profit" and c["source"] == "sim" and c["confirmed"] == "engine" and c["wallet"] == 1000, c
    assert abs(c["pnl_usd"] - round(1000 * 0.25 * (SELL_EQ - 1.0), 4)) < 1e-9, c["pnl_usd"]
    assert abs(c["pnl_pct"] - round((SELL_EQ / (1.0 * (1 - 0.0015)) - 1) * 100, 4)) < 1e-9, c["pnl_pct"]
    assert c["entry_price"] == 100 and c["direction"] == "LONG" and c["pos"] == e[0]["id"]


@test("Стартова позиція раунду позначається initial, але лишається в журналі для пар; закриття її має результат")
def _():
    put("paper_events.json", {"trend_1h": [ev("BUY", T0, 100, 1.0, reason="Початкова позиція на старті раунду. тест"), ev("SELL", T1, 101, SELL_EQ, candle=2, exit="take")]})
    F.run()
    e = events()
    assert e[0].get("initial") is True and "initial" not in e[1] and e[1]["pos"] == e[0]["id"] and e[1]["result"] == "profit", e


@test("Закриття зі збитком і нульовий результат; без запису про причину — unknown, а не вгадування stop/take")
def _():
    put("paper_events.json", {"trend_1h": [ev("BUY", T0, 100, 1.0), ev("SELL", T1, 99, 0.98, candle=2), ev("BUY", "2026-10-10T11:00+00:00", 100, 0.98, candle=3), ev("SELL", "2026-10-10T11:30+00:00", 100, 0.98, candle=4, exit="signal")]})
    F.run()
    c = [x for x in events() if x["type"] == "close"]
    assert c[0]["result"] == "loss" and c[0]["exit"] == "unknown", c[0]
    assert c[1]["exit"] == "signal" and c[1]["result"] in ("flat", "loss", "profit")
    assert not any(x.get("exit") in ("stop", "take") for x in c), "жодних вигаданих SL/TP"


@test("Повторний запуск і повторна доставка не створюють дублів; нова подія додається рівно один раз")
def _():
    base = {"trend_1h": [ev("BUY", T0, 100, 1.0)]}
    put("paper_events.json", base)
    r1 = F.run()
    r2 = F.run()
    assert r1["new_events"] == 1 and r2["new_events"] == 0 and len(events()) == 1
    base["trend_1h"].append(ev("SELL", T1, 101, SELL_EQ, candle=2, exit="take"))
    put("paper_events.json", base)
    r3 = F.run()
    assert r3["new_events"] == 1 and len(events()) == 2
    ids = [x["id"] for x in events()]
    assert len(set(ids)) == len(ids)


@test("Дві різні угоди на одній свічці мають різні ID; повністю однакові записи не зливаються мовчки")
def _():
    a = ev("BUY", "2026-10-10T10:00+00:00", 100, 1.0, candle=5)
    b = ev("BUY", "2026-10-10T10:10+00:00", 100.5, 0.99, candle=5)
    put("paper_events.json", {"trend_1h": [a, b, dict(b)]})
    F.run()
    ids = [x["id"] for x in events()]
    assert len(ids) == 3 and len(set(ids)) == 3, ids
    F.run()
    assert len(events()) == 3, "повторний запуск не додає нічого"


@test("Однакові події в різних гаманцях, ботах і монетах не стикаються")
def _():
    same = ev("BUY", T0, 100, 1.0)
    put("paper_events.json", {"trend_1h": [same], "setup_live": [dict(same, rule="setup_live")]})
    put("paper_events_100.json", {"trend_1h": [dict(same, coin="BTC")]})
    put("paper_events_10000.json", {"trend_1h": [same]})
    F.run()
    e = events()
    assert len(e) == 4 and len({x["id"] for x in e}) == 4, [x["id"] for x in e]
    assert {x["wallet"] for x in e} == {100, 1000, 10000}


@test("Перезапис гілки data: копія папки (як fetch + cp у workflow) дає той самий журнал без дублів")
def _():
    put("paper_events.json", {"trend_1h": [ev("BUY", T0, 100, 1.0), ev("SELL", T1, 101, SELL_EQ, candle=2, exit="take")]})
    F.run()
    before = events()
    snap = tempfile.mkdtemp(prefix="branch_")
    for n in os.listdir(TMP):
        shutil.copy(os.path.join(TMP, n), os.path.join(snap, n))
    reset()
    for n in os.listdir(snap):
        shutil.copy(os.path.join(snap, n), os.path.join(TMP, n))
    F.run()
    assert events() == before
    shutil.rmtree(snap)


@test("Пошкоджений журнал: відновлення з копії; за відсутності копії — перебудова з джерел; порожня історія не ламає агента")
def _():
    put("paper_events.json", {"trend_1h": [ev("BUY", T0, 100, 1.0)]})
    F.run()
    F.run()                                              # з'являється live_feed.prev.json
    put("live_feed.json", "{ це не json")
    r = F.run()
    assert r["recovered"] is True and len(events()) == 1
    os.remove(os.path.join(TMP, "live_feed.prev.json"))
    put("live_feed.json", '{"v":99,"events":"x"}')
    r = F.run()
    assert len(events()) == 1 and r["recovered"] is False
    reset()
    r = F.run()                                          # зовсім порожньо
    assert r["events_total"] == 0 and get("live_feed.json")["events"] == []


@test("Пошкоджена окрема подія в журналі відкидається, решта лишається")
def _():
    put("paper_events.json", {"trend_1h": [ev("BUY", T0, 100, 1.0)]})
    F.run()
    j = get("live_feed.json")
    j["events"].append({"id": "x"})
    j["events"].append("сміття")
    put("live_feed.json", j)
    F.run()
    assert len(events()) == 1


@test("Обмеження журналу: лишаються найновіші MAX_EVENTS, політика й лічильник видалених записані у файлі")
def _():
    old = F.MAX_EVENTS
    F.MAX_EVENTS = 5
    try:
        lst = [ev("BUY", "2026-10-10T%02d:00+00:00" % h, 100 + h, 1.0, candle=h) for h in range(10)]
        put("paper_events.json", {"trend_1h": lst})
        F.run()
        j = get("live_feed.json")
        assert len(j["events"]) == 5 and j["dropped"] == 5 and "НЕ повна історія" in j["policy"], (len(j["events"]), j["dropped"])
        assert [x["price"] for x in j["events"]] == [105, 106, 107, 108, 109]
        F.run()
        assert len(get("live_feed.json")["events"]) == 5
    finally:
        F.MAX_EVENTS = old


@test("Сортування за фактичним часом, а не за порядком джерел")
def _():
    put("paper_events.json", {"b": [ev("BUY", "2026-10-10T12:00+00:00", 3, 1.0, candle=3, rule="b")], "a": [ev("BUY", "2026-10-10T09:00+00:00", 1, 1.0, candle=1, rule="a")]})
    put("paper_events_100.json", {"c": [ev("BUY", "2026-10-10T10:00+00:00", 2, 1.0, candle=2, rule="c", coin="BTC")]})
    F.run()
    assert [x["price"] for x in events()] == [1, 2, 3]


@test("Testnet: окремий джерело й тип підтвердження, біржовий orderId у ID, результат за фактичними виконаннями, невиконані ордери ігноруються")
def _():
    put("_trader_log.json", [
        {"coin": "BNB", "side": "BUY", "usdt": 100, "price": 100, "id": 11, "status": "FILLED", "t": T0, "fill": {"qty": 1.0, "avg": 100.0, "quote": 100.0, "fees": {"BNB": 0.001}}},
        {"coin": "BNB", "side": "SELL", "usdt": 102, "price": 102, "id": 12, "status": "FILLED", "t": T1, "fill": {"qty": 1.0, "avg": 102.0, "quote": 102.0, "fees": {}}},
        {"coin": "ETH", "side": "BUY", "usdt": 50, "price": 5, "id": 13, "status": "REJECTED", "t": T1, "fill": {"qty": 0, "avg": 5, "quote": 0, "fees": {}}},
    ])
    F.run()
    e = events()
    assert [x["id"] for x in e] == ["tn-BNB-11", "tn-BNB-12"], [x["id"] for x in e]
    assert all(x["source"] == "testnet" and x["confirmed"] == "exchange" and x["wallet"] == "testnet" for x in e)
    c = e[1]
    assert c["result"] == "profit" and abs(c["pnl_usd"] - 2.0) < 1e-9 and abs(c["pnl_pct"] - 2.0) < 1e-9 and c["exit"] == "unknown", c
    assert c["pnl_basis"] == "quote_diff", "Testnet-результат не позначається як точний чистий PnL"
    F.run()
    assert len(events()) == 2


@test("Testnet і симуляція в одному журналі не змішуються (різні source, ID, пари)")
def _():
    put("paper_events.json", {"trend_1h": [ev("BUY", T0, 100, 1.0)]})
    put("_trader_log.json", [{"coin": "BNB", "side": "BUY", "id": 1, "status": "FILLED", "t": T0, "fill": {"qty": 1, "avg": 100, "quote": 100, "fees": {}}}])
    F.run()
    e = events()
    assert {x["source"] for x in e} == {"sim", "testnet"} and len({x["id"] for x in e}) == 2


@test("Часткове виконання Testnet — лише за явним статусом біржі, без результату")
def _():
    put("_trader_log.json", [
        {"coin": "BNB", "side": "BUY", "id": 1, "status": "FILLED", "t": T0, "fill": {"qty": 2, "avg": 100, "quote": 200, "fees": {}}},
        {"coin": "BNB", "side": "SELL", "id": 2, "status": "PARTIALLY_FILLED", "t": T1, "fill": {"qty": 1, "avg": 101, "quote": 101, "fees": {}}},
    ])
    F.run()
    c = events()[1]
    assert c["partial"] is True and c["result"] == "unknown" and "pnl_usd" not in c


@test("Відкриті позиції беруться зі стану рушія (ціна входу з файлу), не з припущень; закриті не потрапляють")
def _():
    put("paper_events.json", {"trend_1h": [ev("BUY", T0, 100, 1.0)]})
    put("_paper.json", {"round": {"start": "2026-10-10T00:00+00:00"}, "strategies": {"trend_1h": {"w": {"BNB": 0.25}, "coins": {"BNB": {"pos": True, "entry": 100, "eq": 1.0}, "XRP": {"pos": False, "entry": None}}}}})
    F.run()
    o = get("live_feed.json")["open"]
    assert len(o) == 1 and o[0]["coin"] == "BNB" and o[0]["entry"] == 100 and o[0]["wallet"] == 1000 and o[0]["w"] == 0.25 and o[0]["entry_cost"] == 0.0015, o
    assert o[0]["pos"] == events()[0]["id"]


@test("Журнал не містить секретів і службових ключів; тексти обмежені")
def _():
    os.environ["BINANCE_TESTNET_API_KEY"] = "SECRETKEY123"
    os.environ["TELEGRAM_BOT_TOKEN"] = "TOKEN456"
    put("paper_events.json", {"trend_1h": [ev("BUY", T0, 100, 1.0, reason="я" * 500)]})
    put("_trader_log.json", [{"coin": "BNB", "side": "BUY", "id": 1, "status": "FILLED", "t": T0, "fill": {"qty": 1, "avg": 100, "quote": 100, "fees": {}}, "signature": "SIG", "apiKey": "SECRETKEY123"}])
    F.run()
    raw = open(os.path.join(TMP, "live_feed.json"), encoding="utf-8").read()
    assert "SECRETKEY123" not in raw and "TOKEN456" not in raw and "signature" not in raw.lower()
    assert all(len(x["reason"]) <= F.REASON_MAX for x in events())


@test("Рушій: поле exit у SELL (stop/take/trail/trend/signal) є, у BUY його немає, торгові рішення не змінено")
def _():
    import datetime as dt
    rule = next(x for x in F.load_knowledge("simulation")["strategies"] if x["kind"] == "sma50")
    c = [100.0 + i * 0.01 for i in range(300)]
    t = [i * 3600000 for i in range(300)]
    sc = [0] * 300
    now = dt.datetime(2026, 10, 10, tzinfo=dt.timezone.utc)
    sell = S.make_event(rule, "BTC", "SELL", c, 250, sc, t, {}, now, 1.0, exit_type="take")
    buy = S.make_event(rule, "BTC", "BUY", c, 250, sc, t, {}, now, 1.0)
    unk = S.make_event(rule, "BTC", "SELL", c, 250, sc, t, {}, now, 1.0)
    assert sell["exit"] == "take" and "exit" not in buy and unk["exit"] == "unknown"


print("\nПройдено %d, провалено %d" % (passed, failed))
shutil.rmtree(TMP, ignore_errors=True)
sys.exit(1 if failed else 0)
