"""C2.1: НЕЗАЛЕЖНІ набори D7/D8, яких не було в C2.0, і їхні еталони «до R1/R2».
Еталони знімаються з рушія, у якому R1/R2 ще немає (перевіряє `engine_marker`), і далі лише порівнюються. Бібліотека нічого не змінює в рушії.

  python -m live2.c21 capture            # реальні свічки Binance (REST) у fixtures/c21/
  python -m live2.c21 build              # еталон (рушій окремим процесом) + тінь → tests/golden/c21/*.json
  python -m live2.c21 check              # порівняти поточний рушій із записаними еталонами
"""
import json
import os
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone

from . import c20, compare, datasets
from . import engine_bridge as eb
from .shadow import ShadowEngine

HERE = eb.HERE
C21_DIR = os.path.join(HERE, "fixtures", "c21")
GOLDEN_DIR = os.path.join(HERE, "tests", "golden", "c21")
ENGINE_FILE = os.path.join(eb.TOOLS, "agents", "agent_simulation.py")

VARIANTS = {
    "D7": {"dataset": "D7"},          # 2026-08-10 04:00 → 08-13 04:00 UTC: літо, раніше не використовувався
    "D8": {"dataset": "D8"},          # найсвіжіші години (до моменту зняття) з реальною книгою заявок на кінець вікна
}


def engine_has_r12():
    with open(ENGINE_FILE, encoding="utf-8") as f:
        src = f.read()
    return "def paper_step(" in src


def capture():
    os.makedirs(C21_DIR, exist_ok=True)
    end7 = int(datetime(2026, 8, 13, 4, 0, tzinfo=timezone.utc).timestamp() * 1000)
    m7 = datasets.capture("D7", end7, eval_hours=72, note="C2.1: незалежний набір, літо 2026 (раніше не використовувався)", base_dir=C21_DIR)
    end8 = int(time.time() * 1000) - 5 * 60000
    m8 = datasets.capture("D8", end8, eval_hours=12, with_books=True, note="C2.1: найсвіжіші години, реальна книга заявок на кінець вікна", base_dir=C21_DIR)
    return m7, m8


def load(name):
    return datasets.load(name, base_dir=C21_DIR)


def times_of(ds):
    return datasets.eval_times(ds["meta"])


def run_reference(name, out_dir, engine_src_dir=None):
    """Еталон: справжній рушій у підпроцесі зі справжнім файловим вводом-виводом у out_dir."""
    cmd = [sys.executable, "-B", "-m", "live2.reference_c20", "--dataset", VARIANTS[name]["dataset"], "--out", out_dir, "--base", C21_DIR]
    env = dict(os.environ)
    env.pop("PYTHONHASHSEED", None)
    r = subprocess.run(cmd, cwd=HERE, capture_output=True, text=True, timeout=3600, env=env)
    if r.returncode != 0:
        raise RuntimeError("еталон " + name + ": " + r.stderr[-600:])
    return json.loads(r.stdout.strip().splitlines()[-1]), compare.load_dir(out_dir)


def run_shadow(name, ds=None):
    ds = ds or load(name)
    kb = c20.variant_kb(ds, VARIANTS[name])
    books = eb.books_from_snapshot({"books": ds["books"]}) if ds["books"] else {}
    sh = ShadowEngine(kb=kb, sk=ds["sk"], store=eb.MemStore(), books=books)
    steps = []
    for i, now_ms in enumerate(times_of(ds)):
        ptf = eb.ptf_from_rows(ds["klines"], kb, ds["sk"], now_ms, live=True)
        res = sh.step(ptf, datetime.fromtimestamp(now_ms / 1000, timezone.utc))
        files = {k: datasets.sha(sh.store.data[k]) for k in ("_paper", "_paper_100", "_paper_10000", "paper_events", "paper_events_100", "paper_events_10000") if k in sh.store.data}
        steps.append({"i": i, "now_ms": now_ms, "files": files, "state_sha": datasets.sha(files), "result_sha": datasets.sha(json.loads(json.dumps(res))), "engine_s": sh.step_times[-1]})
    return {"dataset": VARIANTS[name]["dataset"], "steps": steps}, sh.store.data


def record(name, steps_report, data, ds):
    kb = c20.variant_kb(ds, VARIANTS[name])
    table = c20.account_table(data, kb)
    steps = steps_report["steps"]
    final = {k: datasets.sha(data[k]) for k in ("_paper", "_paper_100", "_paper_10000", "paper_events", "paper_events_100", "paper_events_10000") if k in data}
    return {"variant": name, "dataset": name, "n_steps": len(steps), "input_sha256": ds["meta"]["sha256"], "kb_effective_sha256": datasets.sha(kb),
            "step_times_sha256": datasets.sha([s["now_ms"] for s in steps]), "step_state_sha256": [s["state_sha"] for s in steps], "step_result_sha256": [s["result_sha"] for s in steps],
            "final_files_sha256": final, "final_state_sha256": datasets.sha(final), "accounts_table_sha256": datasets.sha(table), "accounts_table": table,
            "engine_file_sha256": datasets.file_sha(ENGINE_FILE)}


def golden_path(name):
    return os.path.join(GOLDEN_DIR, name + ".json")


def costs_grid_c21():
    out = os.path.join(eb.STATE_DIR, "_costs_tmp21")
    cmd = [sys.executable, "-B", "-m", "live2.reference_c20", "--dataset", "D8", "--out", out, "--costs", "--base", C21_DIR]
    r = subprocess.run(cmd, cwd=HERE, capture_output=True, text=True, timeout=600)
    shutil.rmtree(out, ignore_errors=True)
    if r.returncode != 0:
        raise RuntimeError(r.stderr[-600:])
    return json.loads(r.stdout.strip().splitlines()[-1])


def build():
    if engine_has_r12():
        raise SystemExit("відмова: рушій уже містить R1/R2; еталони «до» можна знімати лише з чинного коду")
    os.makedirs(GOLDEN_DIR, exist_ok=True)
    for name in VARIANTS:
        ds = load(name)
        bad = datasets.verify_integrity(ds)
        if bad:
            raise SystemExit("набір %s пошкоджено: %s" % (name, bad))
        tmp = os.path.join(eb.STATE_DIR, "_c21_ref_" + name)
        shutil.rmtree(tmp, ignore_errors=True)
        ref_steps, ref_data = run_reference(name, tmp)
        sh_steps, sh_data = run_shadow(name, ds)
        for a, b in zip(ref_steps["steps"], sh_steps["steps"]):
            if a["state_sha"] != b["state_sha"] or a["result_sha"] != b["result_sha"]:
                raise SystemExit("%s: еталон і тінь розійшлися на кроці %d" % (name, a["i"]))
        rec = record(name, ref_steps, ref_data, ds)
        with open(golden_path(name), "w", encoding="utf-8") as f:
            json.dump(rec, f, ensure_ascii=False, indent=1)
        shutil.rmtree(tmp, ignore_errors=True)
        print(name, rec["n_steps"], "кроків", rec["final_state_sha256"][:16], rec["accounts_table_sha256"][:16])
    g = costs_grid_c21()
    with open(os.path.join(GOLDEN_DIR, "costs_grid.json"), "w", encoding="utf-8") as f:
        json.dump({"n": len(g), "grid_sha256": datasets.sha(g), "grid": g}, f, ensure_ascii=False, indent=1)
    print("costs_grid", len(g), datasets.sha(g)[:16])


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "capture":
        for m in capture():
            print(m["id"], m["eval_hours"], "год", m["sha256"]["klines"][:16], "прогалини:", len(m["gaps"]))
    elif cmd == "build":
        build()
    else:
        print(__doc__)
