"""Агент «Стейблкоїни»: загальна пропозиція, найбільші монети, динаміка за ~3 місяці. Джерело: DefiLlama. Результат: data/stablecoins.json."""
from .common import get_json, downsample, now_iso

NAME = "stablecoins"
TITLE = "Стейблкоїни"
SOURCE = "DefiLlama"
INTERVAL = 1800


def run():
    assets = get_json("https://stablecoins.llama.fi/stablecoins?includePrices=true")["peggedAssets"]
    usd = []
    for a in assets:
        supply = ((a.get("circulating") or {}).get("peggedUSD")) or 0
        if a.get("pegType") == "peggedUSD" and supply > 0:
            usd.append({"symbol": a.get("symbol"), "name": a.get("name"), "supply": supply, "price": a.get("price")})
    usd.sort(key=lambda x: x["supply"], reverse=True)
    total = sum(x["supply"] for x in usd)
    top = [dict(x, share=round(100 * x["supply"] / total, 2)) for x in usd[:6]]

    chart = get_json("https://stablecoins.llama.fi/stablecoincharts/all")
    series = []
    for p in chart[-120:]:
        v = (p.get("totalCirculatingUSD") or {}).get("peggedUSD")
        if v:
            series.append(v)
    change30 = round(100 * (series[-1] / series[-31] - 1), 2) if len(series) > 31 else None
    return {
        "total": total, "count": len(usd), "top": top,
        "history": [round(v) for v in downsample(series, 60)], "change30": change30,
        "updated": now_iso(),
    }
