"""Агент «Мережа біткоїна»: комісії за переказ, черга транзакцій, висота блоку, потужність майнінгу. Джерело: mempool.space. Результат: data/network.json."""
from .common import get_json, downsample, now_iso
from .insights import Rules, num, pct

NAME = "network"
TITLE = "Мережа біткоїна"
SOURCE = "mempool.space"
INTERVAL = 180


def run():
    fees = get_json("https://mempool.space/api/v1/fees/recommended")
    pool = get_json("https://mempool.space/api/mempool")
    height = get_json("https://mempool.space/api/blocks/tip/height")
    hr = get_json("https://mempool.space/api/v1/mining/hashrate/3m")
    rows = [h for h in hr.get("hashrates", []) if h.get("avgHashrate")]
    series = [h["avgHashrate"] / 1e18 for h in rows]                  # екзахеші за секунду (EH/s)
    stamps = [int(h["timestamp"]) for h in rows]
    result = {
        "fees": {k: fees.get(k) for k in ("fastestFee", "halfHourFee", "hourFee", "economyFee", "minimumFee")},
        "mempool": {"count": pool.get("count"), "vsize_mb": round(pool.get("vsize", 0) / 1e6, 1), "total_fee_btc": round(pool.get("total_fee", 0) / 1e8, 4)},
        "height": height,
        "hashrate_ehs": round((hr.get("currentHashrate") or (series[-1] * 1e18 if series else 0)) / 1e18, 1),
        "hashrate_history": [round(v, 1) for v in downsample(series, 40)], "hashrate_t": downsample(stamps, 40),
        "updated": now_iso(),
    }
    result["insights"] = insights(result)
    return result


def insights(r):
    """Висновки про мережу: комісії, черга, динаміка потужності (пороги й тексти — knowledge/network.json)."""
    k = Rules(NAME)
    t, f, out = k.thr, r["fees"], []
    fast, eco = f.get("fastestFee") or 0, f.get("economyFee") or 0
    if fast <= t["fee_low"]:
        out.append(k.say("positive", "fee_low", fast=fast))
    elif fast >= t["fee_high"]:
        out.append(k.say("negative", "fee_high", fast=fast))
    else:
        out.append(k.say("neutral", "fee_mid", fast=fast))
    if fast - eco >= t["fee_spread"]:
        out.append(k.say("neutral", "fee_spread", spread=fast - eco))
    count = r["mempool"]["count"] or 0
    out.append(k.say("negative", "mempool_busy", count=num(count)) if count >= t["mempool_busy"] else k.say("positive", "mempool_small", count=num(count)))
    h = r["hashrate_history"]
    if len(h) >= 2 and h[0]:
        chg = 100 * (h[-1] / h[0] - 1)
        if chg >= t["hashrate_trend"]:
            out.append(k.say("positive", "hash_up", chg=pct(chg, signed=False)))
        elif chg <= -t["hashrate_trend"]:
            out.append(k.say("negative", "hash_down", chg=pct(-chg, signed=False)))
        else:
            out.append(k.say("neutral", "hash_flat", chg=pct(chg)))
    out.append(k.say("neutral", "height", height=num(r["height"])))
    return out


def summary(r):
    return {"fastest_fee": r["fees"].get("fastestFee"), "hashrate_ehs": r["hashrate_ehs"], "mempool": r["mempool"]["count"]}
