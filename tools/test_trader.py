#!/usr/bin/env python3
"""Тести агента «Тестова біржа» (tools/agents/agent_trader.py): вибір гаманця, перевірка конфігурації, відсутність ордерів при помилці.
Без мережі й без справжніх ключів: біржа замінена фальшивим API (клас Fake). Ключі в тестах: вигадані рядки.

  python tools/test_trader.py

Працює в тимчасовій папці даних (CRYPTO_DATA_DIR), справжні файли data/ і knowledge/ не чіпає."""
import json
import os
import shutil
import sys
import tempfile

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

TMP = tempfile.mkdtemp(prefix="tradertest_")
os.environ["CRYPTO_DATA_DIR"] = TMP
os.environ["BINANCE_TESTNET_API_KEY"] = "test-key-not-real"
os.environ["BINANCE_TESTNET_API_SECRET"] = "test-secret-not-real"
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from agents import agent_trader as T      # noqa: E402

passed = failed = 0
PRICES = {"BTC": 60000.0, "ETH": 3000.0, "SOL": 150.0, "BNB": 600.0, "XRP": 0.5, "ADA": 0.4, "DOGE": 0.1, "LINK": 15.0, "AVAX": 30.0, "SUI": 2.0}


def put(name, obj):
    with open(os.path.join(TMP, name), "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False)


def reset():
    for n in os.listdir(TMP):
        p = os.path.join(TMP, n)
        shutil.rmtree(p) if os.path.isdir(p) else os.remove(p)


def strat(state, eq=1.0):
    return {"trend_1h": {"state": {c: [pos, 1.0, 1.0, PRICES[c], 0.25] for c, pos in state.items()}, "eq": eq, "hold": 1.0, "trades": 0, "tf": "1h", "open": [], "coins": len(state)}}


def sim_data(btc_pos=1):
    """Три гаманці: 100 $ (BTC, ETH, SOL), 1000 $ (BNB, XRP, ADA, DOGE; корінь paper), 10000 $ (LINK, AVAX, SUI)."""
    mid = {"accounts": [100, 1000, 10000], "cap": 1000, "strategies": strat({"BNB": 0, "XRP": 0, "ADA": 0, "DOGE": 1}, 1.01),
           "wallet_coins": {"100": ["BTC", "ETH", "SOL"], "1000": ["BNB", "XRP", "ADA", "DOGE"], "10000": ["LINK", "AVAX", "SUI"]},
           "wallets": {"100": {"cap": 100, "strategies": strat({"BTC": btc_pos, "ETH": 0, "SOL": 0}, 1.02)},
                       "10000": {"cap": 10000, "strategies": strat({"LINK": 0, "AVAX": 0, "SUI": 0}, 0.99)}}}
    return {"paper": mid, "strategies": []}


def kb(**kw):
    d = {"base_url": "https://testnet.binance.vision", "wallet": 100, "strategy": "trend_1h", "coins": ["BTC", "ETH", "SOL"], "allocation": 0.95, "min_order_usdt": 10, "log_size": 200}
    d.update(kw)
    return d


class Fake:
    """Фальшива тестова біржа: нічого не виходить за межі пам'яті. Усі виклики записуються."""
    created = []
    orders = []
    balances = {"USDT": 1000.0}

    def __init__(self, base, key, secret):
        Fake.created.append((base, key))
        self.n = 0

    def call(self, method, path, params=None, signed=False):
        params = params or {}
        if path == "/api/v3/account":
            return {"balances": [{"asset": a, "free": str(v), "locked": "0"} for a, v in Fake.balances.items()]}
        if path == "/api/v3/ticker/price":
            return {"price": str(PRICES[params["symbol"][:-4]])}
        if path == "/api/v3/exchangeInfo":
            return {"symbols": [{"filters": [{"filterType": "LOT_SIZE", "stepSize": "0.00001"}]}]}
        if path == "/api/v3/order":
            Fake.orders.append(dict(params))
            c = params["symbol"][:-4]
            qty = float(params["quantity"]) if "quantity" in params else float(params["quoteOrderQty"]) / PRICES[c]
            self.n += 1
            return {"orderId": 1000 + len(Fake.orders), "status": "FILLED", "executedQty": str(qty), "cummulativeQuoteQty": str(qty * PRICES[c]), "fills": []}
        raise AssertionError("неочікуваний виклик API: " + path)


def run_case(cfg, sim, balances=None, keys=True):
    """Запускає агента з підставленими налаштуваннями; повертає результат. Повертає також, чи створювався API-клієнт."""
    Fake.created, Fake.orders = [], []
    Fake.balances = dict(balances or {"USDT": 1000.0})
    put("simulation.json", sim)
    old_kb, T.load_knowledge = T.load_knowledge, (lambda name: cfg)
    saved = {k: os.environ.get(k) for k in ("BINANCE_TESTNET_API_KEY", "BINANCE_TESTNET_API_SECRET")}
    if not keys:
        os.environ["BINANCE_TESTNET_API_KEY"] = os.environ["BINANCE_TESTNET_API_SECRET"] = ""
    try:
        return T.run(Fake)
    finally:
        T.load_knowledge = old_kb
        for k, v in saved.items():
            os.environ[k] = v if v is not None else ""


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


@test("реальний файл knowledge/trader.json: вибраний гаманець і монети узгоджені з симуляцією")
def _():
    path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "knowledge", "trader.json")
    with open(path, encoding="utf-8") as f:
        real = json.load(f)
    assert real["wallet"] == 100 and set(real["coins"]) <= {"BTC", "ETH", "SOL"}, real
    put("simulation.json", sim_data())
    assert T.validate_config(real, sim_data()) == []


@test("правильна конфігурація: купує лише монету, яку хоче правило вибраного гаманця (100 $), а не стан гаманця 1000 $")
def _():
    r = run_case(kb(), sim_data(btc_pos=1))
    assert "config_error" not in r, r
    assert [(o["symbol"], o["side"]) for o in Fake.orders] == [("BTCUSDT", "BUY")], Fake.orders
    assert r["wallet"] == 100 and r["wanted"] == {"BTC": True, "ETH": False, "SOL": False}, r["wanted"]
    assert abs(r["paper_ret"] - 2.0) < 1e-9, r["paper_ret"]            # еквіті правила гаманця 100 $ (1.02), а не 1000 $ (1.01)


@test("правило не хоче позиції: ордерів немає; позиція в портфелі й правило каже вийти: лише продаж цієї монети")
def _():
    run_case(kb(), sim_data(btc_pos=0))
    assert Fake.orders == [], Fake.orders
    run_case(kb(), sim_data(btc_pos=0), balances={"USDT": 500.0, "BTC": 0.01})        # 0.01 BTC = 600 $
    assert [(o["symbol"], o["side"]) for o in Fake.orders] == [("BTCUSDT", "SELL")], Fake.orders


@test("старий дефект: монети 100 $ при гаманці 1000 $: помилка конфігурації, API-клієнт не створюється, ордерів немає")
def _():
    r = run_case(kb(wallet=1000), sim_data())
    assert r["config_error"] and "BTC" in r["config_error"][0] and "1000" in r["config_error"][0], r.get("config_error")
    assert Fake.created == [] and Fake.orders == [], (Fake.created, Fake.orders)
    assert "orders" not in r and r["insights"][0]["tone"] == "negative"


@test("неправильна конфігурація: жодних мережевих викликів, жодного ордера, файли стану й журналу ордерів не створюються й не змінюються")
def _():
    import urllib.request
    real_open = urllib.request.urlopen
    calls = []
    urllib.request.urlopen = lambda *a, **k: calls.append(a) or (_ for _ in ()).throw(AssertionError("мережевий виклик при помилці конфігурації"))
    put("_trader_log.json", [{"coin": "BTC", "side": "BUY", "id": 1}])
    put("_kb_state.json", {"trader": {"start_equity": 1000.0, "since": "x"}})
    snap = {n: open(os.path.join(TMP, n), "rb").read() for n in ("_trader_log.json", "_kb_state.json")}
    try:
        for cfg in (kb(wallet=1000), kb(wallet=5000), kb(strategy="nope"), kb(coins=["BTC", "BNB"]), kb(base_url="https://api.binance.com"), kb(allocation=2)):
            r = run_case(cfg, sim_data())
            assert r["config_error"] and not r.get("orders") and "equity" not in r
    finally:
        urllib.request.urlopen = real_open
    assert calls == [] and Fake.created == [] and Fake.orders == []
    for n, data in snap.items():
        assert open(os.path.join(TMP, n), "rb").read() == data, n + " змінено"


@test("гаманець 1000 $ зі своїми монетами працює (журнал рішень: paper_events у корені)")
def _():
    r = run_case(kb(wallet=1000, coins=["BNB", "DOGE"]), sim_data(), balances={"USDT": 1000.0})
    assert "config_error" not in r, r
    assert [(o["symbol"], o["side"]) for o in Fake.orders] == [("DOGEUSDT", "BUY")], Fake.orders
    assert T.wallet_view(sim_data()["paper"], 1000)[1] == "paper_events" and T.wallet_view(sim_data()["paper"], 100)[1] == "paper_events_100"


@test("гаманця немає, правила немає, монети чужі або без стану: зрозумілі помилки, ордерів немає")
def _():
    for cfg, word in ((kb(wallet=5000), "5000"), (kb(strategy="nope"), "nope"), (kb(coins=["BTC", "BNB"]), "BNB")):
        r = run_case(cfg, sim_data())
        assert r["config_error"] and word in " ".join(r["config_error"]), (cfg, r.get("config_error"))
        assert Fake.created == [] and Fake.orders == []
    s = sim_data()
    del s["paper"]["wallets"]["100"]["strategies"]["trend_1h"]["state"]["SOL"]
    assert any("SOL" in m for m in T.validate_config(kb(), s)), T.validate_config(kb(), s)


@test("некоректні поля: не-testnet адреса, allocation, повтори монет, порожній список, немає поля, не ціле wallet")
def _():
    s = sim_data()
    cases = [kb(base_url="https://api.binance.com"), kb(allocation=1.5), kb(allocation=0), kb(coins=["BTC", "BTC"]), kb(coins=[]), kb(wallet="100"), kb(wallet=True),
             kb(min_order_usdt=0), kb(strategy="")]
    for cfg in cases:
        assert T.validate_config(cfg, s), cfg
    bad = kb()
    del bad["wallet"]
    assert any("wallet" in m for m in T.validate_config(bad, s))
    r = run_case(kb(base_url="https://api.binance.com"), s)
    assert r["config_error"] and Fake.created == [] and Fake.orders == []


@test("без ключів: ордерів немає; помилка конфігурації все одно показується (без мережі)")
def _():
    r = run_case(kb(), sim_data(), keys=False)
    assert r["configured"] is False and "config_error" not in r and "вимкнена" in r["insights"][0]["text"]
    r = run_case(kb(wallet=1000), sim_data(), keys=False)
    assert r["config_error"] and Fake.created == []


@test("до появи даних симуляції: без помилки конфігурації й без ключів: нічого не торгує; з ключами: зрозумілий збій")
def _():
    reset()
    old, T.load_knowledge = T.load_knowledge, (lambda name: kb())
    try:
        os.environ["BINANCE_TESTNET_API_KEY"] = os.environ["BINANCE_TESTNET_API_SECRET"] = ""
        assert T.run(Fake)["configured"] is False
        os.environ["BINANCE_TESTNET_API_KEY"], os.environ["BINANCE_TESTNET_API_SECRET"] = "test-key-not-real", "test-secret-not-real"
        try:
            T.run(Fake)
            raise AssertionError("очікували RuntimeError")
        except RuntimeError as ex:
            assert "Симуляція" in str(ex)
    finally:
        T.load_knowledge = old


@test("API-клієнт відмовляється працювати з не-testnet адресою (захист від реальної біржі)")
def _():
    try:
        T.Api("https://api.binance.com", "k", "s")
        raise AssertionError("мало бути SystemExit")
    except SystemExit:
        pass
    T.Api("https://testnet.binance.vision", "k", "s")


@test("секрети не потрапляють у результат агента й у файли даних")
def _():
    r = run_case(kb(), sim_data(btc_pos=1))
    blob = json.dumps(r, ensure_ascii=False)
    for secret in ("test-key-not-real", "test-secret-not-real"):
        assert secret not in blob
        for n in os.listdir(TMP):
            with open(os.path.join(TMP, n), encoding="utf-8", errors="replace") as f:
                assert secret not in f.read(), n


@test("Paper і Testnet не змішуються: журнал ордерів і стан Testnet у своїх файлах, рахунок гаманця не змінюється")
def _():
    sim = sim_data(btc_pos=1)
    before = json.dumps(sim, sort_keys=True)
    run_case(kb(), sim)
    with open(os.path.join(TMP, "simulation.json"), encoding="utf-8") as f:
        assert json.dumps(json.load(f), sort_keys=True) == before
    assert os.path.exists(os.path.join(TMP, "_trader_log.json")) and not os.path.exists(os.path.join(TMP, "paper_events.json"))


print("\nПройшло: %d, провалів: %d" % (passed, failed))
shutil.rmtree(TMP, ignore_errors=True)
sys.exit(1 if failed else 0)
