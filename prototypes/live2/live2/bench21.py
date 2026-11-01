"""C2.1: час виконання рушія до/після. Міряє суму часу кроків рушія (48 рахунків) у процесі й тривалість еталонного підпроцесу.
  python -m live2.bench21 OUT.json          # N повторів, повертає мінімум і медіану
"""
import json
import os
import shutil
import statistics
import sys
import time

from . import c20, c21, datasets
from . import engine_bridge as eb

REPS = 3


def main(out):
    res = {"engine_file_sha256": datasets.file_sha(c21.ENGINE_FILE), "python": sys.version.split()[0], "reps": REPS, "shadow": {}, "reference": {}}
    for name, loader, runner in (("D3", lambda: datasets.load("D3"), lambda ds: c20.run_shadow("D3", ds)), ("D7", lambda: c21.load("D7"), lambda ds: c21.run_shadow("D7", ds))):
        ds = loader()
        tot, per = [], []
        for _ in range(REPS):
            rep, _data = runner(ds)
            ts = [s["engine_s"] if "engine_s" in s else None for s in rep["steps"]]
            if None in ts:
                raise SystemExit("немає часу кроків")
            tot.append(sum(ts))
            per.append(statistics.median(ts))
        res["shadow"][name] = {"steps": len(rep["steps"]), "total_s_min": min(tot), "total_s_median": statistics.median(tot), "step_ms_median": statistics.median(per) * 1000}
    tmp = os.path.join(eb.STATE_DIR, "_bench_ref")
    t = []
    for _ in range(REPS):
        shutil.rmtree(tmp, ignore_errors=True)
        t0 = time.perf_counter()
        c20.run_reference("D3", tmp)
        t.append(time.perf_counter() - t0)
    shutil.rmtree(tmp, ignore_errors=True)
    res["reference"]["D3"] = {"wall_s_min": min(t), "wall_s_median": statistics.median(t)}
    with open(out, "w", encoding="utf-8") as f:
        json.dump(res, f, ensure_ascii=False, indent=1)
    print(json.dumps(res, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main(sys.argv[1])
