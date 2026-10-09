"""Агент «Ринок»: загальна капіталізація, частки біткоїна й ефіру, найбільші монети з мініграфіками, лідери зростання й падіння.
Джерело: CoinGecko (безкоштовний публічний API). Результат: data/market.json."""
from .common import get_json, downsample, now_iso

NAME = "market"
TITLE = "Ринок"
SOURCE = "CoinGecko"
INTERVAL = 300   # секунд

STABLE = {"usdt", "usdc", "dai", "usds", "fdusd", "tusd", "usde", "pyusd", "usdd", "busd", "usdp"}


def run():
    g = get_json("https://api.coingecko.com/api/v3/global")["data"]
    rows = get_json(
        "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=50&page=1"
        "&sparkline=true&price_change_percentage=24h,7d")

    dom = g.get("market_cap_percentage", {})
    btc, eth = float(dom.get("btc", 0)), float(dom.get("eth", 0))

    def coin(r):
        return {
            "id": r["id"], "symbol": r["symbol"].upper(), "name": r["name"],
            "price": r.get("current_price"), "mcap": r.get("market_cap"),
            "change24h": r.get("price_change_percentage_24h_in_currency"),
            "change7d": r.get("price_change_percentage_7d_in_currency"),
            "spark": [round(x, 6) for x in downsample((r.get("sparkline_in_7d") or {}).get("price") or [], 36)],
        }

    coins = [coin(r) for r in rows]
    movable = [c for c in coins if c["symbol"].lower() not in STABLE and c["change24h"] is not None]
    movable.sort(key=lambda c: c["change24h"], reverse=True)
    brief = lambda c: {k: c[k] for k in ("symbol", "name", "price", "change24h")}   # noqa: E731

    return {
        "global": {
            "market_cap": g["total_market_cap"]["usd"], "volume": g["total_volume"]["usd"],
            "change24h": g.get("market_cap_change_percentage_24h_usd"),
            "btc_dominance": round(btc, 2), "eth_dominance": round(eth, 2), "other_dominance": round(max(0, 100 - btc - eth), 2),
            "active_coins": g.get("active_cryptocurrencies"),
        },
        "top": [c for c in coins if c["symbol"].lower() not in STABLE][:8],
        "gainers": [brief(c) for c in movable[:5]],
        "losers": [brief(c) for c in movable[::-1][:5]],
        "updated": now_iso(),
    }
