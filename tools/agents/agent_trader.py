"""Агент «Тестова біржа»: автоматично купує й продає на тестовій біржі Binance Testnet (ненастоящі гроші) за рішеннями правила,
яке веде агент «Симуляція». Це найближча до реальності перевірка прибутковості без ризику: справжні ордери, стакан, комісії, баланс.

Безпека:
  • Працює ЛИШЕ з адресою testnet.binance.vision: інша адреса в базі знань зупиняє агента (реальна біржа неможлива).
  • Ключі беруться лише зі змінних середовища BINANCE_TESTNET_API_KEY / BINANCE_TESTNET_API_SECRET і ніде не записуються.
    Без ключів агент нічого не робить і лише пояснює, як їх отримати.
  • Торгує ринковими ордерами лише на монетах із бази знань і лише в межах allocation від капіталу.
Результат: data/trader.json (стан, баланс, останні ордери), журнал ордерів у data/_trader_log.json (самоочищується)."""
import hashlib
import hmac
import json
import math
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

from .common import DATA, UA, load_knowledge, now_iso, read_state, write_json, write_state
from .insights import item, num, pct

NAME = "trader"
TITLE = "Тестова біржа"
SOURCE = "Binance Testnet"
INTERVAL = 600
RUNS_LAST = True           # після агента «Симуляція», щоб читати його свіжі рішення
LOG = "_trader_log"
ALLOWED_HOST = "testnet.binance.vision"


class Api:
    """Мінімальний підписаний клієнт тестової біржі (HMAC-SHA256). Лише тестова адреса."""

    def __init__(self, base, key, secret):
        host = urllib.parse.urlparse(base).hostname
        if host != ALLOWED_HOST:
            raise SystemExit("Заборонено: агент торгує лише на %s, а не на %s" % (ALLOWED_HOST, host))
        self.base, self.key, self.secret = base.rstrip("/"), key, secret.encode()

    def call(self, method, path, params=None, signed=False):
        params = dict(params or {})
        if signed:
            params["timestamp"] = int(time.time() * 1000)
            params["recvWindow"] = 10000
        query = urllib.parse.urlencode(params)
        if signed:
            query += "&signature=" + hmac.new(self.secret, query.encode(), hashlib.sha256).hexdigest()
        url = self.base + path + ("?" + query if query else "")
        req = urllib.request.Request(url, method=method, headers={"User-Agent": UA, "X-MBX-APIKEY": self.key})
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:        # біржа відповіла помилкою: показуємо її текст
            raise RuntimeError("біржа: %s" % e.read().decode("utf-8", "replace")[:160])


def load(name):
    try:
        with open(os.path.join(DATA, name + ".json"), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def floor_step(qty, step):
    """Округлення кількості вниз до кроку лота (інакше біржа відхилить ордер)."""
    if step <= 0:
        return qty
    n = math.floor(qty / step + 1e-9)
    decimals = max(0, -int(math.floor(math.log10(step)))) if step < 1 else 0
    return round(n * step, decimals)


def fill_info(o, price):
    """Фактичне виконання ордера: кількість, середня ціна, сума й комісія (з відповіді біржі)."""
    qty, quote = float(o.get("executedQty") or 0), float(o.get("cummulativeQuoteQty") or 0)
    fees = {}
    for f in o.get("fills") or []:
        fees[f.get("commissionAsset", "?")] = fees.get(f.get("commissionAsset", "?"), 0.0) + float(f.get("commission") or 0)
    return {"qty": qty, "avg": round(quote / qty, 8) if qty else price, "quote": round(quote, 4), "fees": {k: round(v, 8) for k, v in fees.items()}}


def why_for(events, rule, coin, side):
    """Останнє рішення правила по цій монеті в журналі агента «Симуляція»: причина, індикатори, контекст."""
    ev = [e for e in (events or {}).get(rule, []) if e["coin"] == coin and e["side"] == side]
    if not ev:
        return {"reason": "Позиція приведена до поточного стану правила (окремого запису про рішення в журналі немає).", "ind": None, "ctx": None, "candle": None}
    e = ev[-1]
    return {"reason": e["reason"], "ind": e["ind"], "ctx": e.get("ctx"), "candle": e["candle"], "decided": e["at"]}


def reconcile(api, kb, wanted, balances, prices, steps, log, events=None):
    """Приводить баланс до бажаних позицій (wanted: монета → у позиції?). Повертає список виконаних ордерів."""
    done = []
    free_usdt = balances.get("USDT", 0.0)
    total = free_usdt + sum(balances.get(c, 0.0) * prices[c] for c in kb["coins"] if c in prices)
    budget = total * kb["allocation"] / max(1, len(kb["coins"]))
    for c in kb["coins"]:
        if c not in prices or c not in wanted:
            continue
        held = balances.get(c, 0.0) * prices[c]
        if wanted[c] and held < kb["min_order_usdt"] * 0.5 and free_usdt >= kb["min_order_usdt"]:        # треба купити
            spend = min(budget, free_usdt)
            if spend >= kb["min_order_usdt"]:
                o = api.call("POST", "/api/v3/order", {"symbol": c + "USDT", "side": "BUY", "type": "MARKET", "quoteOrderQty": "%.2f" % spend}, True)
                done.append(dict({"coin": c, "side": "BUY", "usdt": spend, "price": prices[c], "id": o.get("orderId"), "status": o.get("status"),
                                  "fill": fill_info(o, prices[c])}, **why_for(events, kb["strategy"], c, "BUY")))
                free_usdt -= spend
        elif not wanted[c] and held >= kb["min_order_usdt"] * 0.5:                                      # треба продати все
            qty = floor_step(balances.get(c, 0.0), steps.get(c, 0))
            if qty > 0:
                o = api.call("POST", "/api/v3/order", {"symbol": c + "USDT", "side": "SELL", "type": "MARKET", "quantity": ("%.8f" % qty).rstrip("0").rstrip(".")}, True)
                done.append(dict({"coin": c, "side": "SELL", "usdt": qty * prices[c], "price": prices[c], "id": o.get("orderId"), "status": o.get("status"),
                                  "fill": fill_info(o, prices[c])}, **why_for(events, kb["strategy"], c, "SELL")))
                free_usdt += qty * prices[c]
    return done


def run(api_factory=Api):
    kb = load_knowledge(NAME)
    key, secret = os.environ.get("BINANCE_TESTNET_API_KEY", "").strip(), os.environ.get("BINANCE_TESTNET_API_SECRET", "").strip()
    sim = load("simulation")
    result = {"configured": bool(key and secret), "strategy": kb["strategy"], "coins": kb["coins"], "base": kb["base_url"], "updated": now_iso()}
    if not (key and secret):
        result["insights"] = [item("neutral", "Тестова торгівля вимкнена: немає ключів Binance Testnet. Це ненастоящі гроші: отримайте безкоштовні ключі на testnet.binance.vision і додайте їх секретами BINANCE_TESTNET_API_KEY та BINANCE_TESTNET_API_SECRET.")]
        return result
    if not sim or kb["strategy"] not in sim["paper"]["strategies"]:
        raise RuntimeError("агент «Симуляція» ще не дав рішень для правила «%s»" % kb["strategy"])

    api = api_factory(kb["base_url"], key, secret)
    state = sim["paper"]["strategies"][kb["strategy"]]["state"]
    wanted = {c: bool(state[c][0]) for c in kb["coins"] if c in state}

    acct = api.call("GET", "/api/v3/account", signed=True)
    balances = {b["asset"]: float(b["free"]) + float(b["locked"]) for b in acct["balances"] if float(b["free"]) + float(b["locked"]) > 0}
    prices, steps = {}, {}
    for c in kb["coins"]:
        try:
            prices[c] = float(api.call("GET", "/api/v3/ticker/price", {"symbol": c + "USDT"})["price"])
            info = api.call("GET", "/api/v3/exchangeInfo", {"symbol": c + "USDT"})
            lot = next(f for f in info["symbols"][0]["filters"] if f["filterType"] == "LOT_SIZE")
            steps[c] = float(lot["stepSize"])
        except Exception:      # noqa: BLE001 — монети може не бути на тестовій біржі: пропускаємо її
            continue

    log = load(LOG) or []
    done = reconcile(api, kb, wanted, balances, prices, steps, log, load("paper_events"))
    for d in done:
        d["t"] = now_iso()
    log = (log + done)[-kb["log_size"]:]
    write_json(LOG + ".json", log)

    if done:                                    # баланс після ордерів
        acct = api.call("GET", "/api/v3/account", signed=True)
        balances = {b["asset"]: float(b["free"]) + float(b["locked"]) for b in acct["balances"] if float(b["free"]) + float(b["locked"]) > 0}
    equity = balances.get("USDT", 0.0) + sum(balances.get(c, 0.0) * prices[c] for c in prices)
    st = read_state(NAME) or {}
    if not st.get("start_equity"):
        st = {"start_equity": equity, "since": now_iso()}
    st["last_equity"] = equity
    write_state(NAME, st)
    paper_eq = sim["paper"]["strategies"][kb["strategy"]]["eq"]
    result.update({
        "equity": round(equity, 2), "start_equity": round(st["start_equity"], 2), "since": st["since"],
        "ret": round(100 * (equity / st["start_equity"] - 1), 3), "paper_ret": round(100 * (paper_eq - 1), 3),
        "positions": {c: round(balances.get(c, 0.0) * prices[c], 2) for c in prices if balances.get(c, 0.0) * prices[c] >= 1},
        "usdt": round(balances.get("USDT", 0.0), 2), "wanted": wanted, "holdings": {c: balances[c] for c in prices if balances.get(c, 0.0) > 0},
        "prices": prices, "orders": log[-20:][::-1], "orders_total": len(log),
    })
    result["insights"] = insights(result)
    return result


def insights(r):
    out = [item("positive" if r["ret"] > 0 else "negative" if r["ret"] < 0 else "neutral",
                "Тестовий рахунок: %s $ (старт %s $), результат %s. Віртуальна симуляція того самого правила: %s." %
                (num(r["equity"], 2), num(r["start_equity"], 2), pct(r["ret"], 2), pct(r["paper_ret"], 2)))]
    out.append(item("neutral", "Ордерів із початку: %d. Позиції: %s." % (r["orders_total"], ", ".join(r["positions"]) or "готівка (USDT)")))
    out.append(item("neutral", "Це ненастоящі гроші на тестовій біржі: різниця з віртуальною симуляцією показує вплив комісій, ціни виконання й затримок."))
    return out


def summary(r):
    return {"ret": r.get("ret", 0), "orders": r.get("orders_total", 0)}
