"""Агент «Мережа біткоїна»: комісії за переказ, черга транзакцій, висота блоку, потужність майнінгу. Джерело: mempool.space. Результат: data/network.json."""
from .common import get_json, downsample, now_iso

NAME = "network"
TITLE = "Мережа біткоїна"
SOURCE = "mempool.space"
INTERVAL = 180


def run():
    fees = get_json("https://mempool.space/api/v1/fees/recommended")
    pool = get_json("https://mempool.space/api/mempool")
    height = get_json("https://mempool.space/api/blocks/tip/height")
    hr = get_json("https://mempool.space/api/v1/mining/hashrate/3m")
    series = [h["avgHashrate"] / 1e18 for h in hr.get("hashrates", []) if h.get("avgHashrate")]    # ексахеші за секунду (EH/s)
    return {
        "fees": {k: fees.get(k) for k in ("fastestFee", "halfHourFee", "hourFee", "economyFee", "minimumFee")},
        "mempool": {"count": pool.get("count"), "vsize_mb": round(pool.get("vsize", 0) / 1e6, 1), "total_fee_btc": round(pool.get("total_fee", 0) / 1e8, 4)},
        "height": height,
        "hashrate_ehs": round((hr.get("currentHashrate") or (series[-1] * 1e18 if series else 0)) / 1e18, 1),
        "hashrate_history": [round(v, 1) for v in downsample(series, 40)],
        "updated": now_iso(),
    }
