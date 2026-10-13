"""Створення еталонних записів C2.0 (запускати свідомо; перезапис еталонів = нова точка відліку).
  python -m live2.c20_build            створює D3w_initial (якщо немає), проганяє ЕТАЛОН і ТІНЬ для всіх варіантів, перевіряє збіг, пише tests/golden/c20/*.json
  python -m live2.c20_build --check    лише перевіряє, що поточний еталон збігається із записаним (без перезапису)"""
import json
import os
import shutil
import sys
import time

from . import c20, compare, datasets
from . import engine_bridge as eb


def main(check=False, only=None):
    os.makedirs(c20.GOLDEN_DIR, exist_ok=True)
    if not os.path.isdir(os.path.join(datasets.C20_DIR, "D3w_initial")):
        if check:
            raise SystemExit("немає D3w_initial")
        print("створюю D3w_initial (стан чинного рушія після перших 24 год D3)…", flush=True)
        c20.make_initial_d3w()
    summary = {}
    for name in (only or c20.VARIANTS):
        v = c20.VARIANTS[name]
        ds = datasets.load(v["dataset"])
        bad = datasets.verify_integrity(ds)
        if bad:
            raise SystemExit("вхідні дані %s пошкоджені: %s" % (name, bad))
        t0 = time.time()
        out_dir = os.path.join(eb.STATE_DIR, "c20_ref_" + name)
        ref, rdata = c20.run_reference(name, out_dir)
        t1 = time.time()
        shd, sdata = c20.run_shadow(name, ds)
        t2 = time.time()
        eq_steps = sum(1 for a, b in zip(ref["steps"], shd["steps"]) if a["state_sha"] == b["state_sha"] and a["result_sha"] == b["result_sha"])
        d = compare.diff(rdata, sdata)
        rec = c20.record(name, ref, rdata, ds)
        status = "збігається з тінню на %d/%d кроків, розбіжностей станів: %d" % (eq_steps, len(ref["steps"]), len(d))
        if check:
            with open(c20.golden_path(name), encoding="utf-8") as f:
                gold = json.load(f)
            same = all(gold[k] == rec[k] for k in ("step_state_sha256", "step_result_sha256", "final_state_sha256", "accounts_table_sha256", "input_sha256", "kb_effective_sha256", "initial_state_sha256"))
            status += "; з еталонним записом: " + ("ЗБІГАЄТЬСЯ" if same else "РОЗБІЖНІСТЬ")
        else:
            with open(c20.golden_path(name), "w", encoding="utf-8") as f:
                json.dump(rec, f, ensure_ascii=False, indent=1)
        summary[name] = {"steps": len(ref["steps"]), "ref_s": round(t1 - t0, 1), "shadow_s": round(t2 - t1, 1), "equal_steps": eq_steps, "diffs": len(d), "final_state_sha256": rec["final_state_sha256"][:16],
                         "events": sum(r["buys"] + r["sells"] for r in rec["accounts_table"])}
        print(name, status, flush=True)
        shutil.rmtree(out_dir, ignore_errors=True)
    print(json.dumps(summary, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    only = [a for a in sys.argv[1:] if not a.startswith("--")]
    main(check="--check" in sys.argv, only=only or None)
