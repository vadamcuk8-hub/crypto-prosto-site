"""Агент «Стейблкоїни»: загальна пропозиція, найбільші монети, динаміка за ~3 місяці. Джерело: DefiLlama. Результат: data/stablecoins.json."""
from .common import get_json, downsample, now_iso
from .insights import Rules, num, pct, usd as usd_fmt

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
    result = {
        "total": total, "count": len(usd), "top": top,
        "history": [round(v) for v in downsample(series, 60)], "change30": change30,
        "updated": now_iso(),
    }
    result["insights"] = insights(result)
    return result


def insights(r):
    """Висновки про стейблкоїни: розмір, динаміка за 30 днів, концентрація, прив'язка до долара (knowledge/stablecoins.json)."""
    k = Rules(NAME)
    t, top, out = k.thr, r["top"], []
    out.append(k.say("neutral", "total", total=usd_fmt(r["total"])))
    c = r["change30"]
    if c is not None:
        if c >= t["growth_strong"]:
            out.append(k.say("positive", "growth_strong_up", chg=pct(c, signed=False)))
        elif c >= t["growth_move"]:
            out.append(k.say("positive", "growth_up", chg=pct(c, signed=False)))
        elif c <= -t["growth_strong"]:
            out.append(k.say("negative", "growth_strong_down", chg=pct(-c, signed=False)))
        elif c <= -t["growth_move"]:
            out.append(k.say("negative", "growth_down", chg=pct(-c, signed=False)))
        else:
            out.append(k.say("neutral", "growth_flat", chg=pct(c)))
    if len(top) >= 2:
        s1, s2 = top[0], top[1]
        if s1["share"] >= t["leader_dominant"]:
            out.append(k.say("neutral", "leader_dominant", s1=s1["symbol"], p1=num(s1["share"], 1)))
        else:
            out.append(k.say("neutral", "leader", s1=s1["symbol"], p1=num(s1["share"], 1), s2=s2["symbol"], p2=num(s2["share"], 1)))
        both = s1["share"] + s2["share"]
        if both >= t["top2_high"]:
            out.append(k.say("neutral", "top2_high", p=num(both, 1)))
    off = [x for x in top if x.get("price") and abs(x["price"] - 1) > t["peg_deviation"]]
    if off:
        out.append(k.say("negative", "peg_bad", list=", ".join("%s (%s $)" % (x["symbol"], num(x["price"], 4)) for x in off)))
    else:
        out.append(k.say("positive", "peg_ok"))
    return out


def summary(r):
    return {"total": r["total"], "top_share": r["top"][0]["share"] if r["top"] else 0}
