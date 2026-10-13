"""Живий тіньовий драйвер (режим A): WebSocket Binance → потокові буфери → тіньовий рушій (48 рахунків) у prototypes/live2/state/<ім'я>/.
Нічого не торгує реально й не торкається data/, гілки data, Actions і Pages.

Крок рушія запускається: (1) після закриття свічки будь-якого масштабу (kline x=true; debounce 0,3 с, щоб дочекатись усіх монет), (2) за каденцією --cadence.
Перед кроком: ринок має бути придатним (немає «мовчазних» монет, пропусків і непідтверджених закриттів); пропуски дозавантажуються з REST;
якщо після цього дані все ще сумнівні, крок ПРОПУСКАЄТЬСЯ з записом причини (торгівля за застарілими даними заборонена).

  python -m live2.driver --duration 1500 --cadence 60 --name live_shadow_A
Вимірює: Binance→отримання (feed), отримання→початок кроку, побудова вхідних даних, крок рушія (рішення+запис віртуальних операцій), запис стану, CPU, RAM."""
import argparse
import asyncio
import ctypes
import ctypes.wintypes
import json
import os
import signal
import time
from datetime import datetime, timezone

from . import clock, fixture
from . import engine_bridge as eb
from .buffers import StreamMarket
from .feed import HOSTS, Feed
from .recorder import LOG_DIR, Recorder
from .run import build_streams
from .shadow import ShadowEngine
from .stats import Reservoir


def rss_mb():
    """Робочий набір процесу в МБ (Windows через psapi; на інших ОС — з /proc)."""
    try:
        if os.name == "nt":
            class PMC(ctypes.Structure):
                _fields_ = [("cb", ctypes.wintypes.DWORD), ("PageFaultCount", ctypes.wintypes.DWORD), ("PeakWorkingSetSize", ctypes.c_size_t), ("WorkingSetSize", ctypes.c_size_t),
                            ("QuotaPeakPagedPoolUsage", ctypes.c_size_t), ("QuotaPagedPoolUsage", ctypes.c_size_t), ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                            ("QuotaNonPagedPoolUsage", ctypes.c_size_t), ("PagefileUsage", ctypes.c_size_t), ("PeakPagefileUsage", ctypes.c_size_t)]
            pmc = PMC()
            pmc.cb = ctypes.sizeof(PMC)
            ctypes.windll.kernel32.GetCurrentProcess.restype = ctypes.c_void_p
            ctypes.windll.psapi.GetProcessMemoryInfo.argtypes = [ctypes.c_void_p, ctypes.POINTER(PMC), ctypes.wintypes.DWORD]
            ctypes.windll.psapi.GetProcessMemoryInfo(ctypes.windll.kernel32.GetCurrentProcess(), ctypes.byref(pmc), pmc.cb)
            return pmc.WorkingSetSize / 1e6, pmc.PeakWorkingSetSize / 1e6
        with open("/proc/self/status") as f:
            for line in f:
                if line.startswith("VmRSS"):
                    v = int(line.split()[1]) / 1024
                    return v, v
    except Exception:  # noqa: BLE001
        pass
    return None, None


class LiveShadow:
    def __init__(self, name, kb, sk, cadence_s=60, stale_ms=120000, log_path=None, workers=6):
        self.kb, self.sk, self.cadence_s, self.workers = kb, sk, cadence_s, workers
        self.market = StreamMarket(kb, sk, stale_ms=stale_ms)
        self.engine = ShadowEngine.from_dir(name, kb=kb, sk=sk)
        self.engine.name = name
        self.recorder = Recorder(log_path=log_path)
        self.offset_ms = 0.0
        self.trigger_recv = None              # час отримання першого закриття свічки, що чекає на крок (мс, локальний годинник)
        self.trigger_tf = set()
        self.last_step = 0.0
        self.lat = {k: Reservoir(20000) for k in ("event_to_start", "ptf_build", "engine_step", "store_write", "event_to_done", "cadence_total")}
        self.steps = self.skipped = 0
        self.skip_reasons = {}
        self.new_events = 0
        self.backfills = 0
        self.rest_seed_s = None
        self.cpu0 = time.process_time()
        self.t0 = time.time()
        self.stop = asyncio.Event()
        self._last_skip_log = {}
        self._boundary_done = 0                # остання межа (мс, час біржі), для якої вже було заплановано крок за таймером

    # ---- REST ----
    async def seed(self):
        t0 = time.time()
        keys = [(s, tf) for s in self.market.coins for tf in self.market.tfs]
        sem = asyncio.Semaphore(self.workers)
        rows = {}

        async def one(sym, tf):
            async with sem:
                for attempt in range(3):
                    try:
                        rows["%s|%s" % (sym, tf)] = await asyncio.to_thread(fixture.rest_klines, sym, tf, self.kb["paper_candles"])
                        return
                    except Exception:  # noqa: BLE001
                        await asyncio.sleep(1.0 + attempt)
        await asyncio.gather(*[one(s, tf) for s, tf in keys])
        now_ms = time.time() * 1000 + self.offset_ms
        self.market.seed(rows, now_ms)
        self.rest_seed_s = round(time.time() - t0, 1)
        books = {}

        async def book(sym):
            async with sem:
                try:
                    d = await asyncio.to_thread(fixture.rest_depth, sym)
                    books[sym] = {"bids": [tuple(x) for x in d["bids"]], "asks": [tuple(x) for x in d["asks"]]}
                except Exception:  # noqa: BLE001
                    pass
        await asyncio.gather(*[book(s) for s in self.market.coins])
        if books:
            self.engine.books = books

    async def backfill(self, keys):
        sem = asyncio.Semaphore(self.workers)

        async def one(key):
            sym, tf = key.split("|")
            async with sem:
                try:
                    rows = await asyncio.to_thread(fixture.rest_klines, sym, tf, self.kb["paper_candles"])
                    self.market.apply_backfill(sym, tf, rows, time.time() * 1000 + self.offset_ms)
                    self.backfills += 1
                except Exception:  # noqa: BLE001
                    pass
        await asyncio.gather(*[one(k) for k in keys])

    # ---- потік ----
    def on_message(self, stream, data, recv_ms):
        self.recorder.on_message(stream, data, recv_ms)
        self.market.on_message(stream, data, recv_ms)
        if "@kline_" in stream and (data.get("k") or {}).get("x"):
            if self.trigger_recv is None:
                self.trigger_recv = recv_ms
            self.trigger_tf.add(stream.split("@kline_")[1])

    # ---- крок ----
    def _skip(self, reason):
        self.skipped += 1
        self.skip_reasons[reason] = self.skip_reasons.get(reason, 0) + 1
        now = time.time()
        if now - self._last_skip_log.get(reason, 0) > 5:                              # не засмічуємо журнал
            self._last_skip_log[reason] = now
            self.recorder.log({"kind": "step_skipped", "reason": reason, "count": self.skip_reasons[reason]})

    async def try_step(self, reason):
        r = self.market.readiness(time.time() * 1000)
        if r["action"] == "wait":
            return None                                                              # щойно закрилась свічка: чекаємо підтвердження kline x (не пропуск)
        if r["action"] == "backfill":
            await self.backfill(r["keys"])
            self.recorder.log({"kind": "backfill", "keys": len(r["keys"]), "reason": reason})
            r = self.market.readiness(time.time() * 1000)
            if r["action"] != "ready":
                return self._skip("after_backfill:" + r["action"])
        if r["action"] == "skip":
            h = r["health"]
            return self._skip("market_not_ok:" + ",".join(k for k in ("stale", "short") if h[k]))
        t_start = time.perf_counter()
        wall_start = time.time() * 1000
        trig, tfs = self.trigger_recv, sorted(self.trigger_tf)
        self.trigger_recv, self.trigger_tf = None, set()
        ptf = self.market.ptf()
        t_ptf = time.perf_counter()
        ev_before = sum(len(v) for v in compare_events(self.engine.store.data))
        now = datetime.fromtimestamp((time.time() * 1000 + self.offset_ms) / 1000, timezone.utc)
        self.engine.step(ptf, now)
        t_step = time.perf_counter()
        self.engine.save()
        t_save = time.perf_counter()
        new = sum(len(v) for v in compare_events(self.engine.store.data)) - ev_before
        self.new_events += max(0, new)
        self.steps += 1
        self.last_step = time.time()
        e2s = (wall_start - trig) if trig else None
        rec = {"kind": "step", "reason": reason, "tfs": tfs, "ptf_ms": round((t_ptf - t_start) * 1000, 1), "engine_ms": round((t_step - t_ptf) * 1000, 1),
               "save_ms": round((t_save - t_step) * 1000, 1), "new_events": max(0, new)}
        self.lat["ptf_build"].add(rec["ptf_ms"])
        self.lat["engine_step"].add(rec["engine_ms"])
        self.lat["store_write"].add(rec["save_ms"])
        self.lat["cadence_total"].add((t_save - t_start) * 1000)
        if trig:
            rec["event_to_start_ms"] = round(e2s, 1)
            rec["event_to_done_ms"] = round(time.time() * 1000 - trig, 1)
            self.lat["event_to_start"].add(e2s)
            self.lat["event_to_done"].add(rec["event_to_done_ms"])
        self.recorder.log(rec)

    # ---- основний цикл ----
    async def run(self, duration, chaos=(), chaos_utc=()):
        off = await clock.measure_offset()
        if off:
            self.offset_ms = off["offset_ms"]
            self.recorder.offset_ms = off["offset_ms"]
            self.recorder.error_ms = round(off["error_ms"], 1)
        await self.seed()
        streams = build_streams(self.market.coins, ("15m", "1h", "30m", "2h", "1d"), False)
        feed = Feed(streams, self.on_message, hosts=HOSTS, stale_s=10, on_event=self.recorder.on_event)
        task = asyncio.create_task(feed.run())
        loop = asyncio.get_running_loop()
        for s in (signal.SIGINT, signal.SIGTERM):
            try:
                signal.signal(s, lambda *_: loop.call_soon_threadsafe(self.stop.set))
            except (ValueError, OSError):
                pass
        t0 = time.monotonic()
        last_min = t0
        chaos = sorted(chaos)
        utc_pending = sorted(chaos_utc)
        first_step_done = False
        samples = []
        while not self.stop.is_set():
            await asyncio.sleep(0.05)
            el = time.monotonic() - t0
            if chaos and el >= chaos[0]:
                chaos.pop(0)
                feed.chaos_drop("chaos")
            if utc_pending:
                nw = datetime.now(timezone.utc)
                sod = nw.hour * 3600 + nw.minute * 60 + nw.second + nw.microsecond / 1e6
                if sod >= utc_pending[0] and sod - utc_pending[0] < 30:
                    self.recorder.log({"kind": "chaos_utc", "at_sod": utc_pending[0]})
                    utc_pending.pop(0)
                    feed.chaos_drop("chaos_utc")
            srv_now = time.time() * 1000 + self.offset_ms
            boundary = srv_now - srv_now % 900000                                    # межа 15-хв свічки (кратна їй і 30m/1h/2h/1d)
            if self.trigger_recv is None and boundary > self._boundary_done and srv_now - boundary >= 2000:
                # Таймер межі: якщо kline x не прийшов (обрив зв'язку саме на закритті), крок усе одно запускається через 2 с після межі:
                # readiness() дочекається підтвердження або дозавантажить REST, а не залишить рішення до наступної каденції.
                self._boundary_done = boundary
                self.trigger_recv = time.time() * 1000 - 300
                self.trigger_tf = {"boundary_timer"}
            if self.trigger_recv is not None and time.time() * 1000 - self.trigger_recv >= 300:
                self._boundary_done = max(self._boundary_done, boundary)                  # цю межу вже обслуговує поточний тригер
                await self.try_step("candle_close")
            elif time.time() - self.last_step >= self.cadence_s and (time.time() - self.t0) > 5:
                await self.try_step("cadence")
            if time.monotonic() - last_min >= 60:
                last_min = time.monotonic()
                rss, peak = rss_mb()
                cpu = (time.process_time() - self.cpu0) / max(1e-9, time.time() - self.t0)
                samples.append((rss, cpu))
                self.recorder.log({"kind": "resources", "rss_mb": rss, "peak_mb": peak, "cpu_share_avg": round(cpu, 4), "steps": self.steps, "skipped": self.skipped})
                print("[%5.0f с] кроків %d, пропущено %d, нових подій %d, RAM %.0f МБ, CPU %.1f%%" % (el, self.steps, self.skipped, self.new_events, rss or 0, cpu * 100), flush=True)
            if duration and el >= duration:
                break
        feed.stop()
        await task
        rss, peak = rss_mb()
        return {"duration_s": round(time.time() - self.t0, 1), "steps": self.steps, "skipped": self.skipped, "skip_reasons": self.skip_reasons, "new_events": self.new_events,
                "backfills": self.backfills, "rest_seed_s": self.rest_seed_s, "latency_ms": {k: r.summary() for k, r in self.lat.items()},
                "binance": self.recorder.summary(feed), "rss_mb": rss, "peak_rss_mb": peak, "cpu_share_avg": round((time.process_time() - self.cpu0) / max(1e-9, time.time() - self.t0), 4),
                "market": {"msgs": self.market.msgs, "rejected": self.market.rejected, "dup_ticks": self.market.dup_ticks,
                           "buffer_dups": sum(b.dups for b in self.market.buf.values()), "buffer_out_of_order": sum(b.out_of_order for b in self.market.buf.values()),
                           "buffer_bad_price": sum(b.bad_price for b in self.market.buf.values())},
                "accounts": len(__import__("live2.compare", fromlist=["x"]).accounts(self.engine.store.data))}


def compare_events(data):
    from .compare import events_by_account
    return events_by_account(data).values()


async def main_async(a):
    os.makedirs(LOG_DIR, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    log_path = os.path.join(LOG_DIR, "driver-%s.jsonl" % stamp)
    kb, sk = eb.load_kb(), eb.load_signals_kb()
    ls = LiveShadow(a.name, kb, sk, cadence_s=a.cadence, log_path=log_path)
    def sod(x):
        h, m, sec = x.split(":")
        return int(h) * 3600 + int(m) * 60 + float(sec)
    summ = await ls.run(a.duration, chaos=[float(x) for x in a.chaos_at.split(",") if x], chaos_utc=[sod(x) for x in a.chaos_utc.split(",") if x])
    ls.recorder.close()
    with open(os.path.join(LOG_DIR, "driver-%s-summary.json" % stamp), "w", encoding="utf-8") as f:
        json.dump(summ, f, ensure_ascii=False, indent=1)
    print(json.dumps(summ, ensure_ascii=False, indent=1))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--duration", type=float, default=900)
    ap.add_argument("--cadence", type=float, default=60, help="секунд між кроками рушія, якщо не було закриття свічки")
    ap.add_argument("--name", default="live_shadow_A")
    ap.add_argument("--chaos-at", default="")
    ap.add_argument("--chaos-utc", default="", help="обрив зв\u0027язку в задані моменти UTC, напр. 02:59:59.8 (щоб загубити подію закриття свічки)")
    asyncio.run(main_async(ap.parse_args(argv)))


if __name__ == "__main__":
    main()
