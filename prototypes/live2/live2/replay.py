"""Відтворення історії для тіньового рушія: ті самі вхідні свічки й моменти запуску, що й в еталоні (reference_run)."""
import subprocess
import sys
import time
from datetime import datetime, timezone

from . import engine_bridge as eb
from . import fixture
from .shadow import ShadowEngine


def step_times_ms(snap, hours, step_min, end_ms=0):
    end_ms = end_ms or snap["captured_at_ms"]
    steps = int(hours * 60 // step_min)
    return [end_ms - (steps - i) * step_min * 60000 for i in range(steps + 1)]


def run_shadow(snap, hours=24, step_min=20, end_ms=0, shadow=None, times=None, on_step=None):
    """Проганяє тіньовий рушій по тих самих моментах, що й еталон. Повертає ShadowEngine (стан у shadow.store)."""
    kb, sk = eb.load_kb(), eb.load_signals_kb()
    sh = shadow or ShadowEngine(kb=kb, sk=sk, books=eb.books_from_snapshot(snap))
    for now_ms in (times if times is not None else step_times_ms(snap, hours, step_min, end_ms)):
        ptf = eb.ptf_from_rows(snap["klines"], kb, sk, now_ms)
        sh.step(ptf, datetime.fromtimestamp(now_ms / 1000, timezone.utc))
        if on_step:
            on_step(sh, now_ms)
    return sh


def run_reference(out_dir, hours=24, step_min=20, snap_path=fixture.DEFAULT_PATH, end_ms=0):
    """Еталон окремим процесом (рушій читає DATA під час імпорту). Повертає виведення процесу."""
    cmd = [sys.executable, "-B", "-m", "live2.reference_run", "--snap", snap_path, "--out", out_dir, "--hours", str(hours), "--step", str(step_min)]
    if end_ms:
        cmd += ["--end-ms", str(end_ms)]
    t0 = time.time()
    r = subprocess.run(cmd, cwd=eb.HERE, capture_output=True, text=True, timeout=1800)
    if r.returncode != 0:
        raise RuntimeError("еталон завершився з помилкою: " + r.stderr[-800:])
    return {"stdout": r.stdout.strip(), "seconds": round(time.time() - t0, 1)}
