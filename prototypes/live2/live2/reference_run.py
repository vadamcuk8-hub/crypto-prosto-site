"""ЕТАЛОН: чинний рушій без жодних підмін (справжній файловий ввід-вивід), але в ТИМЧАСОВІЙ папці даних (CRYPTO_DATA_DIR), на знімку реальних свічок.
Запускається окремим процесом, бо рушій читає шлях даних під час імпорту. Результат: файли _paper*.json і paper_events*.json у --out.

  python -m live2.reference_run --snap fixtures/klines_snapshot.json.gz --out <папка> --hours 24 --step 20
Ніколи не вказуйте --out на справжню data/."""
import argparse
import gzip
import json
import os
import shutil
import sys
import time
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.dirname(os.path.dirname(HERE))


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--snap", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--hours", type=float, default=24)
    ap.add_argument("--step", type=int, default=20, help="хвилин між запусками (як каденція Actions)")
    ap.add_argument("--end-ms", type=int, default=0, help="кінець відтворення (мс); за замовчуванням — момент знімка")
    a = ap.parse_args(argv)
    out = os.path.abspath(a.out)
    forbidden = os.path.abspath(os.path.join(REPO, "data"))
    if out == forbidden or out.startswith(forbidden + os.sep):
        raise SystemExit("--out не може бути справжньою data/")
    if os.path.exists(out):
        shutil.rmtree(out)
    os.makedirs(out)
    os.environ["CRYPTO_DATA_DIR"] = out
    sys.path.insert(0, os.path.join(REPO, "tools"))
    sys.dont_write_bytecode = True
    from agents import agent_simulation as S
    from agents.common import load_knowledge
    with gzip.open(a.snap, "rt", encoding="utf-8") as f:
        snap = json.load(f)
    kb, sk = load_knowledge("simulation"), load_knowledge("signals")
    pcoins = list(kb["paper_coins"])
    tfs = sorted(({r["tf"] for r in kb["strategies"]} | {r["confirm_tf"] for r in kb["strategies"] if r.get("confirm_tf")}) - {"1d"}) + ["1d"]
    S.BOOKS.update({s: {"bids": [tuple(x) for x in b["bids"]], "asks": [tuple(x) for x in b["asks"]]} for s, b in snap["books"].items() if s in pcoins})
    end_ms = a.end_ms or snap["captured_at_ms"]
    steps = int(a.hours * 60 // a.step)
    timings = []
    for i in range(steps + 1):
        now_ms = end_ms - (steps - i) * a.step * 60000
        now = datetime.fromtimestamp(now_ms / 1000, timezone.utc)
        ptf = {tf: {} for tf in tfs}
        for sym in pcoins:
            for tf in tfs:
                rows = [r for r in snap["klines"].get("%s|%s" % (sym, tf), []) if r[0] <= now_ms][-kb["paper_candles"]:]
                if len(rows) < S.WARMUP + 60:
                    continue
                c, t = [r[1] for r in rows], [r[0] for r in rows]
                sc, s50 = S.scores_series(c, sk["weights"], sk["thresholds"])
                ptf[tf][sym] = (c, t, sc, s50)
        t0 = time.perf_counter()
        S.paper_wallets(ptf, kb, now)
        timings.append(time.perf_counter() - t0)
    with open(os.path.join(out, "_timings.json"), "w", encoding="utf-8") as f:
        json.dump({"engine_step_s": timings}, f)
    print(json.dumps({"steps": steps + 1, "mean_s": round(sum(timings) / len(timings), 3), "max_s": round(max(timings), 3)}))


if __name__ == "__main__":
    main()
