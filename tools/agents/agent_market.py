"""Агент «Ринок»: загальна капіталізація, частки біткоїна й ефіру, найбільші монети з мініграфіками, лідери зростання й падіння.
Джерело: CoinGecko (безкоштовний публічний API). Результат: data/market.json."""
from .common import get_json, downsample, now_iso
from .insights import Rules, num, pct

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

    result = {
        "global": {
            "market_cap": g["total_market_cap"]["usd"], "volume": g["total_volume"]["usd"],
            "change24h": g.get("market_cap_change_percentage_24h_usd"),
            "btc_dominance": round(btc, 2), "eth_dominance": round(eth, 2), "other_dominance": round(max(0, 100 - btc - eth), 2),
            "active_coins": g.get("active_cryptocurrencies"),
        },
        "top": [c for c in coins if c["symbol"].lower() not in STABLE][:8],
        "gainers": [brief(c) for c in movable[:5]],
        "losers": [brief(c) for c in movable[::-1][:5]],
        "breadth": {"n": len(movable), "up": sum(1 for c in movable if c["change24h"] > 0)},
        "updated": now_iso(),
    }
    result["insights"] = insights(result)
    return result


def insights(r):
    """Висновки за добу: рух ринку, частка біткоїна, ширина росту, лідери (пороги й тексти — knowledge/market.json)."""
    k = Rules(NAME)
    t, g, out = k.thr, r["global"], []
    chg = g.get("change24h") or 0
    if chg >= t["strong_move"]:
        out.append(k.say("positive", "cap_strong_up", chg=pct(chg, signed=False), thr=t["strong_move"]))
    elif chg <= -t["strong_move"]:
        out.append(k.say("negative", "cap_strong_down", chg=pct(-chg, signed=False), thr=t["strong_move"]))
    elif chg >= t["move"]:
        out.append(k.say("positive", "cap_up", chg=pct(chg, signed=False)))
    elif chg <= -t["move"]:
        out.append(k.say("negative", "cap_down", chg=pct(-chg, signed=False)))
    else:
        out.append(k.say("neutral", "cap_flat", chg=pct(chg)))
    dom = g["btc_dominance"]
    key = "dom_high" if dom >= t["dominance_high"] else "dom_low" if dom <= t["dominance_low"] else "dom_mid"
    out.append(k.say("neutral", key, dom=num(dom, 1)))
    b = r["breadth"]
    if b["n"]:
        share = round(100 * b["up"] / b["n"])
        key, tone = (("breadth_high", "positive") if share >= t["breadth_high"] else
                     ("breadth_low", "negative") if share <= t["breadth_low"] else ("breadth_mid", "neutral"))
        out.append(k.say(tone, key, up=b["up"], n=b["n"], share=share))
    if r["gainers"] and r["losers"]:
        gn, ls = r["gainers"][0], r["losers"][0]
        out.append(k.say("neutral", "leaders", gs=gn["symbol"], gc=pct(gn["change24h"]), ls=ls["symbol"], lc=pct(ls["change24h"])))
        if max(abs(gn["change24h"]), abs(ls["change24h"])) >= t["sharp_coin_move"]:
            out.append(k.say("neutral", "sharp", thr=t["sharp_coin_move"]))
    return out


def summary(r):
    b = r["breadth"]
    return {"market_cap": r["global"]["market_cap"], "btc_dominance": r["global"]["btc_dominance"],
            "breadth": round(100 * b["up"] / b["n"]) if b["n"] else 0}
