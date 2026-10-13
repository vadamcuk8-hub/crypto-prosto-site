"""ЕТАЛОН C2.0: ЧИННИЙ рушій (agent_simulation.paper_wallets) без жодних підмін і без зміни коду, зі справжнім файловим вводом-виводом, але в ТИМЧАСОВІЙ папці.
Окремий процес, бо рушій читає шлях даних під час імпорту. Будує вхід (ptf) НЕЗАЛЕЖНО від engine_bridge (власна проста реалізація), щоб збіг із тіньовим
шляхом також перевіряв сам конструктор входу.

  python -m live2.reference_c20 --dataset D1 --out <папка> [--kb-override '{"round_days":1}'] [--initial-state <папка>] [--from-step 0] [--to-step N]
Вивід (stdout, JSON): по кроках відбитки стану, результату й файлів; підсумкові файли лишаються в --out. Ніколи не вказуйте --out на справжню data/."""
import argparse
import gzip
import hashlib
import json
import os
import shutil
import sys
import time
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.dirname(os.path.dirname(HERE))
TF_MS = {"1m": 60000, "15m": 900000, "30m": 1800000, "1h": 3600000, "2h": 7200000, "1d": 86400000}
FILES = ("_paper", "_paper_100", "_paper_10000", "paper_events", "paper_events_100", "paper_events_10000")


def canon_sha(obj):
    return hashlib.sha256(json.dumps(obj, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--kb-override", default="")
    ap.add_argument("--initial-state", default="")
    ap.add_argument("--from-step", type=int, default=0)
    ap.add_argument("--to-step", type=int, default=-1)
    ap.add_argument("--base", default=os.path.join(HERE, "fixtures", "c20"))
    ap.add_argument("--costs", action="store_true", help="лише сітка витрат Costs на реальних книгах набору")
    a = ap.parse_args(argv)
    out = os.path.abspath(a.out)
    if os.path.abspath(os.path.join(REPO, "data")) in (out, os.path.dirname(out)) or out.startswith(os.path.abspath(os.path.join(REPO, "data")) + os.sep):
        raise SystemExit("--out не може бути справжньою data/")
    if os.path.exists(out):
        shutil.rmtree(out)
    os.makedirs(out)
    if a.initial_state:
        for fn in os.listdir(a.initial_state):
            if fn.endswith(".json"):
                shutil.copy(os.path.join(a.initial_state, fn), os.path.join(out, fn))
    os.environ["CRYPTO_DATA_DIR"] = out
    sys.path.insert(0, os.path.join(REPO, "tools"))
    sys.dont_write_bytecode = True
    from agents import agent_simulation as S                       # чинний рушій, без змін
    d = os.path.join(a.base, a.dataset)
    with open(os.path.join(d, "meta.json"), encoding="utf-8") as f:
        meta = json.load(f)
    with gzip.open(os.path.join(d, "klines.json.gz"), "rb") as f:
        kl = json.loads(f.read().decode("utf-8"))
    with open(os.path.join(d, "kb.json"), encoding="utf-8") as f:
        kb = json.load(f)
    with open(os.path.join(d, "sk.json"), encoding="utf-8") as f:
        sk = json.load(f)
    if a.kb_override:
        kb.update(json.loads(a.kb_override))
    books_p = os.path.join(d, "books.json")
    if os.path.exists(books_p):
        with open(books_p, encoding="utf-8") as f:
            books = json.load(f)
        S.BOOKS.update({s: {"bids": [tuple(x) for x in b["bids"]], "asks": [tuple(x) for x in b["asks"]]} for s, b in books.items()})
    if a.costs:
        grid = {}
        for cap in (100, 1000, 10000):
            cost = S.Costs(kb, cap)
            for sym in sorted(S.BOOKS):
                for side in ("BUY", "SELL"):
                    for usd in (10, 33.3333, 100, 333.33, 1000, 3333.33, 10000, 100000, 1000000):
                        grid["%d|%s|%s|%s" % (cap, sym, side, usd)] = S.Costs.slip_of(cost, sym, side, usd)
                for w, eq in ((1.0, 1.0), (0.3333, 1.0), (0.25, 0.97), (0.05, 1.0), (0.001, 1.0)):
                    grid["call|%d|%s|%s|%s" % (cap, sym, w, eq)] = [cost(sym, "BUY", w, eq), cost(sym, "SELL", w, eq), cost.can_open(w, eq)]
        print(json.dumps(grid, sort_keys=True, separators=(",", ":")))
        return
    pcoins = list(kb["paper_coins"])
    tfs = sorted(({r["tf"] for r in kb["strategies"]} | {r["confirm_tf"] for r in kb["strategies"] if r.get("confirm_tf")}) - {"1d"}) + ["1d"]
    n = int(meta["eval_hours"] * 60 // meta["step_min"])
    start = meta["end_ms"] - n * meta["step_min"] * 60000
    times = [start + i * meta["step_min"] * 60000 for i in range(n + 1)]
    to = len(times) if a.to_step < 0 else min(len(times), a.to_step)
    steps = []
    for i in range(a.from_step, to):
        now_ms = times[i]
        now = datetime.fromtimestamp(now_ms / 1000, timezone.utc)
        ptf = {tf: {} for tf in tfs}
        for sym in pcoins:
            m1 = kl["%s|1m" % sym]
            live = None
            for r in m1:                                             # остання повністю закрита хвилина ≤ now
                if r[0] + 60000 <= now_ms:
                    live = r[1]
                else:
                    break
            for tf in tfs:
                rows = [list(r) for r in kl["%s|%s" % (sym, tf)] if r[0] <= now_ms][-kb["paper_candles"]:]
                if len(rows) < S.WARMUP + 60:
                    continue
                c, t = [r[1] for r in rows], [r[0] for r in rows]
                if live is not None and now_ms < t[-1] + TF_MS[tf]:
                    c[-1] = live                                     # остання свічка відкрита: її «закриття» — жива ціна
                sc, s50 = S.scores_series(c, sk["weights"], sk["thresholds"])
                ptf[tf][sym] = (c, t, sc, s50)
        t0 = time.perf_counter()
        res = S.paper_wallets(ptf, kb, now)
        dt = time.perf_counter() - t0
        files = {}
        for name in FILES:
            p = os.path.join(out, name + ".json")
            if os.path.exists(p):
                with open(p, encoding="utf-8") as f:
                    files[name] = canon_sha(json.load(f))
        steps.append({"i": i, "now_ms": now_ms, "files": files, "state_sha": canon_sha(files), "result_sha": canon_sha(json.loads(json.dumps(res))), "engine_s": round(dt, 4)})
    written = sorted(fn for fn in os.listdir(out) if fn.endswith(".json"))
    print(json.dumps({"dataset": a.dataset, "steps": steps, "written_files": written}, separators=(",", ":")))


if __name__ == "__main__":
    main()
