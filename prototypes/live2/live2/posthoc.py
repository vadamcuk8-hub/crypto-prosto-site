"""Післяпрогінна перевірка живого тіньового прогону: ті самі моменти кроків відтворюються на «остаточних» REST-свічках (після завершення прогону),
і рішення живого драйвера (на потоці + дозавантаженні) порівнюються з рішеннями на повних даних.
Очікування: усі стратегії, що діють за закритими свічками, дають ті самі угоди (рахунок/монета/сторона/свічка); різниця можлива лише в сканерів
(жива ціна: тік потоку проти 1-хвилинної свічки) і в дрібних відхиленнях капіталу (проковзання з книги в різний час, жива ціна для оцінки відкритих позицій).

  python -m live2.posthoc --log logs/driver-<час>.jsonl --name live_shadow_C"""
import argparse
import json
import os
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

from . import compare, fixture
from . import engine_bridge as eb
from .shadow import ShadowEngine

SCANNERS = ("setup_live", "setup_dip")


def read_log(path):
    recs = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            try:
                recs.append(json.loads(line))
            except ValueError:
                pass
    return recs


def fetch_rows(kb, tfs):
    rows = {}
    jobs = [(s, tf) for s in kb["paper_coins"] for tf in tfs + ["1m"]]

    def one(j):
        for attempt in range(3):
            try:
                return j, fixture.rest_klines(j[0], j[1], kb["paper_candles"])
            except Exception:  # noqa: BLE001
                time.sleep(1 + attempt)
        return j, None
    with ThreadPoolExecutor(6) as ex:
        for (s, tf), r in ex.map(one, jobs):
            if r:
                rows["%s|%s" % (s, tf)] = r
    books = {}
    for s in kb["paper_coins"]:
        try:
            d = fixture.rest_depth(s)
            books[s] = {"bids": [tuple(x) for x in d["bids"]], "asks": [tuple(x) for x in d["asks"]]}
        except Exception:  # noqa: BLE001
            pass
    return rows, books


def event_keys(data):
    out = {}
    for (cap, rid), lst in compare.events_by_account(data).items():
        out[(cap, rid)] = sorted((e["coin"], e["side"], e["candle"], e.get("exit")) for e in lst)
    return out


def run(log_path, name):
    recs = read_log(log_path)
    summ_path = log_path[:-6] + "-summary.json"
    off = 0.0
    if os.path.exists(summ_path):
        with open(summ_path, encoding="utf-8") as f:
            off = json.load(f).get("binance", {}).get("offset_ms", 0.0)
    steps = [r for r in recs if r.get("kind") == "step"]
    if not steps:
        raise SystemExit("у журналі немає кроків")
    kb, sk = eb.load_kb(), eb.load_signals_kb()
    tfs = eb.needed_tfs(kb) + ["1d"]
    rows, books = fetch_rows(kb, tfs)
    times = [int(r["ts"] * 1000 + off - (r["ptf_ms"] + r["engine_ms"] + r["save_ms"])) for r in steps]
    sh = ShadowEngine(kb=kb, sk=sk, books=books)
    for t in times:
        ptf = eb.ptf_from_rows(rows, kb, sk, t, live=True)
        sh.step(ptf, datetime.fromtimestamp(t / 1000, timezone.utc))
    live = ShadowEngine.from_dir(name)
    ek_live, ek_re = event_keys(live.store.data), event_keys(sh.store.data)
    al, ar = compare.accounts(live.store.data), compare.accounts(sh.store.data)
    res = {"steps_replayed": len(times), "accounts_live": len(al), "accounts_replay": len(ar), "groups": {}}
    for label, pred in (("non_scanners", lambda k: k[1] not in SCANNERS), ("scanners", lambda k: k[1] in SCANNERS)):
        keys = [k for k in al if pred(k)]
        same_ev = sum(1 for k in keys if ek_live.get(k, []) == ek_re.get(k, []))
        d_eq = sorted(abs(al[k]["eq"] - ar[k]["eq"]) for k in keys if k in ar and al[k]["eq"] is not None and ar[k]["eq"] is not None)
        trades_same = sum(1 for k in keys if k in ar and al[k]["trades"] == ar[k]["trades"])
        res["groups"][label] = {"accounts": len(keys), "events_identical": same_ev, "trades_identical": trades_same,
                                "eq_abs_diff_median": d_eq[len(d_eq) // 2] if d_eq else None, "eq_abs_diff_max": d_eq[-1] if d_eq else None,
                                "events_live": sum(len(ek_live.get(k, [])) for k in keys), "events_replay": sum(len(ek_re.get(k, [])) for k in keys)}
    res["mismatch_examples"] = [{"account": list(k), "live": ek_live.get(k, [])[:4], "replay": ek_re.get(k, [])[:4]} for k in al if ek_live.get(k, []) != ek_re.get(k, [])][:4]
    return res


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--log", required=True)
    ap.add_argument("--name", required=True)
    a = ap.parse_args()
    out = run(a.log, a.name)
    p = os.path.join(eb.HERE, "logs", "posthoc-%s.json" % a.name)
    with open(p, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    print(json.dumps(out, ensure_ascii=False, indent=1))
