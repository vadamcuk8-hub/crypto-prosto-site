"""C2.0: варіанти відтворення, запуск ЕТАЛОНА (чинний рушій окремим процесом) і ТІНІ (той самий рушій у пам'яті), таблиця 48 рахунків, еталонні записи й перевірка.
Ця бібліотека нічого не змінює в рушії: лише викликає його."""
import copy
import json
import os
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone

from . import compare, datasets
from . import engine_bridge as eb
from .shadow import ShadowEngine

HERE = eb.HERE
GOLDEN_DIR = os.path.join(HERE, "tests", "golden", "c20")
SCANNERS = ("setup_live", "setup_dip")
CAPS = (100, 1000, 10000)

# Варіанти відтворення. D2r — та сама історія D2, але раунд 1 доба (ротація раундів); D3w — продовження D3 з непорожнього стану (стан після перших 24 год, отриманий чинним рушієм).
VARIANTS = {
    "D1": {"dataset": "D1"},
    "D2": {"dataset": "D2"},
    "D3": {"dataset": "D3"},
    "D4": {"dataset": "D4"},
    "D5": {"dataset": "D5"},
    "D6": {"dataset": "D6"},
    "D1n": {"dataset": "D1", "kb_override": {"wallets": None}},
    "D2r": {"dataset": "D2", "kb_override": {"round_days": 1, "first_round_end": None}},
    "D3w": {"dataset": "D3", "initial": "D3w_initial", "from_step": 73},
}


def variant_kb(ds, v):
    kb = copy.deepcopy(ds["kb"])
    kb.update(v.get("kb_override") or {})
    return kb


def initial_dir(v):
    return os.path.join(datasets.C20_DIR, v["initial"]) if v.get("initial") else None


def times_of(ds, v):
    return datasets.eval_times(ds["meta"])[v.get("from_step", 0):]


def run_reference(variant, out_dir):
    """Еталон: справжній рушій у підпроцесі, справжній файловий ввід-вивід у out_dir. Повертає (звіт кроків, дані файлів)."""
    v = VARIANTS[variant]
    cmd = [sys.executable, "-B", "-m", "live2.reference_c20", "--dataset", v["dataset"], "--out", out_dir, "--from-step", str(v.get("from_step", 0))]
    if v.get("kb_override"):
        cmd += ["--kb-override", json.dumps(v["kb_override"])]
    if v.get("initial"):
        cmd += ["--initial-state", initial_dir(v)]
    env = dict(os.environ)
    env.pop("PYTHONHASHSEED", None)
    r = subprocess.run(cmd, cwd=HERE, capture_output=True, text=True, timeout=3600, env=env)
    if r.returncode != 0:
        raise RuntimeError("еталон " + variant + ": " + r.stderr[-600:])
    return json.loads(r.stdout.strip().splitlines()[-1]), compare.load_dir(out_dir)


def run_shadow(variant, ds=None):
    """Тінь: той самий рушій у пам'яті через engine_bridge (вхід будується іншою реалізацією, ніж в еталоні). Повертає (кроки, дані)."""
    v = VARIANTS[variant]
    ds = ds or datasets.load(v["dataset"])
    kb = variant_kb(ds, v)
    books = eb.books_from_snapshot({"books": ds["books"]}) if ds["books"] else {}
    store = eb.MemStore()
    if v.get("initial"):
        for fn in os.listdir(initial_dir(v)):
            if fn.endswith(".json"):
                store.data[fn[:-5]] = datasets.read_json(os.path.join(initial_dir(v), fn))
    sh = ShadowEngine(kb=kb, sk=ds["sk"], store=store, books=books)
    steps = []
    for i, now_ms in enumerate(times_of(ds, v), start=v.get("from_step", 0)):
        ptf = eb.ptf_from_rows(ds["klines"], kb, ds["sk"], now_ms, live=True)
        res = sh.step(ptf, datetime.fromtimestamp(now_ms / 1000, timezone.utc))
        files = {k: datasets.sha(sh.store.data[k]) for k in ("_paper", "_paper_100", "_paper_10000", "paper_events", "paper_events_100", "paper_events_10000") if k in sh.store.data}
        steps.append({"i": i, "now_ms": now_ms, "files": files, "state_sha": datasets.sha(files), "result_sha": datasets.sha(json.loads(json.dumps(res))), "engine_s": sh.step_times[-1]})
    return {"dataset": v["dataset"], "steps": steps}, sh.store.data


def account_table(data, kb):
    """48 рядків: PnL, equity, комісії, угоди, причини виходу, стан позицій, раунд. Лише з файлів рушія (нічого не вигадується).
    Комісії/реалізований PnL — за збереженим журналом (до 40 подій на правило): якщо журнал обрізано, події_збережено < trades."""
    rows = []
    caps = CAPS if "_paper_100" in data else (1000,)                      # без kb["wallets"] рушій веде один спільний рахунок
    for cap in caps:
        st = data.get("_paper" + compare.tag_of(cap)) or {}
        evs = data.get("paper_events" + compare.tag_of(cap)) or {}
        rd = st.get("round") or {}
        for rid, sd in sorted((st.get("strategies") or {}).items()):
            last = sd.get("last") or [None, None, None]
            curve = sd.get("curve") or []
            peak, dd = None, 0.0
            for p in curve:
                peak = p[1] if peak is None else max(peak, p[1])
                dd = min(dd, p[1] / peak - 1)
            lst = evs.get(rid, [])
            fee = realized = 0.0
            buy_eq = {}
            exits = {}
            for e in lst:
                w = e.get("w") or 0
                cost = e.get("cost") or 0
                if e["side"] == "BUY":
                    fee += cap * w * e["eq"] * cost
                    buy_eq[e["coin"]] = (e["eq"], w)
                else:
                    fee += cap * w * (e["eq"] / (1 - cost)) * cost if cost < 1 else 0
                    exits[e.get("exit")] = exits.get(e.get("exit"), 0) + 1
                    if e["coin"] in buy_eq:
                        be, bw = buy_eq.pop(e["coin"])
                        realized += cap * bw * (e["eq"] - be)
            coins = sd.get("coins") or {}
            rows.append({"wallet": cap, "rule": rid, "equity_fraction": last[1], "hold_fraction": last[2], "value_usd": None if last[1] is None else round(cap * last[1], 6),
                         "pnl_usd": None if last[1] is None else round(cap * (last[1] - 1), 6), "max_drawdown": round(dd, 8), "trades": sd.get("trades"),
                         "events_kept": len(lst), "buys": sum(1 for e in lst if e["side"] == "BUY"), "sells": sum(1 for e in lst if e["side"] == "SELL"), "exit_reasons": dict(sorted(exits.items(), key=lambda x: str(x[0]))),
                         "fees_usd": round(fee, 6), "realized_usd": round(realized, 6), "curve_points": len(curve), "last_ts": last[0],
                         "positions": {k: {"pos": x.get("pos"), "entry": x.get("entry"), "peak": x.get("peak"), "eq": x.get("eq"), "t": x.get("t"), "cool": x.get("cool"), "blocked": x.get("blocked")} for k, x in sorted(coins.items())},
                         "round_start": rd.get("start"), "round_end": rd.get("end"), "history_rounds": len(st.get("history") or [])})
    return rows


def record(variant, steps_report, data, ds):
    v = VARIANTS[variant]
    kb = variant_kb(ds, v)
    table = account_table(data, kb)
    steps = steps_report["steps"]
    final = {k: datasets.sha(data[k]) for k in ("_paper", "_paper_100", "_paper_10000", "paper_events", "paper_events_100", "paper_events_10000") if k in data}
    return {"variant": variant, "dataset": v["dataset"], "from_step": v.get("from_step", 0), "n_steps": len(steps), "input_sha256": ds["meta"]["sha256"],
            "kb_effective_sha256": datasets.sha(kb), "kb_override": v.get("kb_override"), "initial_state_sha256": initial_sha(v),
            "step_times_sha256": datasets.sha([s["now_ms"] for s in steps]), "step_state_sha256": [s["state_sha"] for s in steps], "step_result_sha256": [s["result_sha"] for s in steps],
            "final_files_sha256": final, "final_state_sha256": datasets.sha(final), "accounts_table_sha256": datasets.sha(table), "accounts_table": table}


def initial_sha(v):
    d = initial_dir(v)
    if not d:
        return None
    return datasets.sha({fn[:-5]: datasets.read_json(os.path.join(d, fn)) for fn in sorted(os.listdir(d)) if fn.endswith(".json")})


def golden_path(variant):
    return os.path.join(GOLDEN_DIR, variant + ".json")


def make_initial_d3w():
    """Стан D3w: результат чинного рушія на перших 73 кроках D3 (24 год). Це ПОХІДНИЙ вихід рушія (не ринкові дані): записується з SHA."""
    tmp = os.path.join(eb.STATE_DIR, "_d3w_build")
    if os.path.exists(tmp):
        shutil.rmtree(tmp)
    cmd = [sys.executable, "-B", "-m", "live2.reference_c20", "--dataset", "D3", "--out", tmp, "--to-step", "73"]
    r = subprocess.run(cmd, cwd=HERE, capture_output=True, text=True, timeout=3600)
    if r.returncode != 0:
        raise RuntimeError(r.stderr[-600:])
    dst = os.path.join(datasets.C20_DIR, "D3w_initial")
    if os.path.exists(dst):
        shutil.rmtree(dst)
    os.makedirs(dst)
    for fn in os.listdir(tmp):
        if fn.endswith(".json"):
            shutil.copy(os.path.join(tmp, fn), os.path.join(dst, fn))
    shutil.rmtree(tmp)
    return dst


def costs_grid():
    """Сітка витрат чинного `Costs` на РЕАЛЬНИХ книгах заявок набору D4 (окремий процес, без підмін)."""
    out = os.path.join(eb.STATE_DIR, "_costs_tmp")
    cmd = [sys.executable, "-B", "-m", "live2.reference_c20", "--dataset", "D4", "--out", out, "--costs"]
    r = subprocess.run(cmd, cwd=HERE, capture_output=True, text=True, timeout=600)
    shutil.rmtree(out, ignore_errors=True)
    if r.returncode != 0:
        raise RuntimeError(r.stderr[-600:])
    return json.loads(r.stdout.strip().splitlines()[-1])
