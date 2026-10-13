"""Тести прототипу: локальний фейковий WebSocket-сервер, без мережі й без файлів поза tempdir.
Запуск: .venv\\Scripts\\python -m unittest discover -s tests -v   (з папки prototypes/live2)"""
import asyncio
import json
import os
import random
import re
import sys
import tempfile
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from websockets.asyncio.server import serve  # noqa: E402

from live2.feed import Feed  # noqa: E402
from live2.pricebook import PriceBook  # noqa: E402
from live2.recorder import INTERVAL_MS, Recorder  # noqa: E402
from live2.run import build_streams  # noqa: E402
from live2.stats import Reservoir, percentile  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def mini(sym, price, e):
    return json.dumps({"stream": sym.lower() + "usdt@miniTicker", "data": {"e": "24hrMiniTicker", "E": e, "s": sym + "USDT", "c": str(price)}})


def kline(sym, itv, t_close, closed, e):
    return json.dumps({"stream": "%susdt@kline_%s" % (sym.lower(), itv), "data": {"e": "kline", "E": e, "s": sym + "USDT", "k": {"i": itv, "T": t_close, "x": closed, "c": "1"}}})


class Srv:
    """Фейковий сервер: handler(ws) задається тестом; працює на вільному порту."""

    def __init__(self, handler):
        self.handler, self.server, self.connections = handler, None, 0

    async def __aenter__(self):
        async def h(ws):
            self.connections += 1
            await self.handler(ws, self.connections)
        self.server = await serve(h, "127.0.0.1", 0)
        self.port = self.server.sockets[0].getsockname()[1]
        self.host = "ws://127.0.0.1:%d" % self.port
        return self

    async def __aexit__(self, *a):
        self.server.close()
        await self.server.wait_closed()


def run(coro):
    return asyncio.run(coro)


class StatsTests(unittest.TestCase):
    def test_percentile_nearest_rank(self):
        v = list(range(1, 101))
        self.assertEqual(percentile(v, 50), 50)
        self.assertEqual(percentile(v, 90), 90)
        self.assertEqual(percentile(v, 99), 99)
        self.assertEqual(percentile(v, 100), 100)
        self.assertIsNone(percentile([], 50))
        self.assertEqual(percentile([7], 99), 7)

    def test_reservoir_bounded_and_exact_extremes(self):
        r = Reservoir(cap=100)
        for i in range(10000):
            r.add(i)
        self.assertEqual(len(r.vals), 100)
        s = r.summary()
        self.assertEqual((s["n"], s["min"], s["max"]), (10000, 0, 9999))
        self.assertTrue(4000 < s["p50"] < 6000)               # репрезентативна вибірка
        self.assertEqual(Reservoir().summary(), {"n": 0})


class PriceBookTests(unittest.TestCase):
    def test_freshness_and_ordering(self):
        t = [1000.0]
        b = PriceBook(clock=lambda: t[0])
        self.assertTrue(b.update("BTC", 100.0, event_ms=500, recv_ms=1_000_000))
        self.assertFalse(b.update("BTC", 99.0, event_ms=400, recv_ms=1_000_100), "запізніле повідомлення не перезаписує новіше")
        self.assertEqual(b.get("BTC")["price"], 100.0)
        self.assertEqual(b.age_ms("BTC", now_ms=1_002_000), 2000)
        self.assertEqual(b.stale(["BTC", "ETH"], 1500, now_ms=1_002_000), ["BTC", "ETH"], "BTC старіша за поріг, ETH без ціни")
        self.assertEqual(b.stale(["BTC"], 5000, now_ms=1_002_000), [])
        self.assertIsNone(b.age_ms("ETH"))


class RecorderTests(unittest.TestCase):
    def test_latency_uses_offset_and_raw(self):
        r = Recorder(offset_ms=100.0)
        e = 1_000_000
        r.on_message("btcusdt@miniTicker", {"E": e, "c": "10"}, recv_ms=e + 50)             # локально 50 мс після події; зсув +100 → 150 мс
        s = r.summary()
        self.assertEqual(s["latency_ms"]["miniTicker"]["p50"], 150.0)
        self.assertEqual(s["raw_miniTicker_minus_event_ms"]["p50"], 50.0)
        self.assertEqual(r.book.get("BTC")["price"], 10.0)

    def test_missed_closed_klines_detected(self):
        r = Recorder()
        step = INTERVAL_MS["15m"]
        base = 10 * step - 1
        for k in (0, 1, 3, 4):                                                               # свічка 2 пропущена
            r.on_message("btcusdt@kline_15m", {"E": base + k * step + 100, "k": {"i": "15m", "T": base + k * step, "x": True}}, recv_ms=base + k * step + 150)
        self.assertEqual((r.closes, r.missed_closes), (4, 1))
        d = r.summary()["kline_close_delay_ms"]["15m"]
        self.assertEqual(d["p50"], 150.0)

    def test_out_of_order_counted(self):
        r = Recorder()
        r.on_message("btcusdt@miniTicker", {"E": 2000, "c": "1"}, 2100)
        r.on_message("btcusdt@miniTicker", {"E": 1000, "c": "2"}, 2200)
        self.assertEqual(r.out_of_order, 1)
        self.assertEqual(r.book.get("BTC")["price"], 1.0)

    def test_build_streams(self):
        s = build_streams(["BTC", "eth"], ("15m", "1h"), book=True)
        self.assertEqual(len(s), 2 * 4)
        self.assertIn("btcusdt@miniTicker", s)
        self.assertIn("ethusdt@kline_1h", s)
        self.assertIn("ethusdt@bookTicker", s)
        self.assertEqual(len(build_streams(["BTC"])), 3)


class FeedTests(unittest.TestCase):
    def test_receives_messages_and_stops_cleanly(self):
        async def go():
            async def handler(ws, n):
                for i in range(5):
                    await ws.send(mini("BTC", 100 + i, int(time.time() * 1000)))
                    await asyncio.sleep(0.02)
                await asyncio.sleep(5)
            got, events = [], []
            async with Srv(handler) as s:
                f = Feed(["btcusdt@miniTicker"], lambda st, d, t: got.append((st, d)), hosts=[s.host], on_event=events.append)
                task = asyncio.create_task(f.run())
                for _ in range(100):
                    if len(got) >= 5:
                        break
                    await asyncio.sleep(0.05)
                t0 = time.monotonic()
                f.stop()
                await asyncio.wait_for(task, 5)
                return got, events, time.monotonic() - t0
        got, events, stop_time = run(go())
        self.assertEqual(len(got), 5)
        self.assertLess(stop_time, 2.0, "чисте завершення швидке")
        kinds = [e["kind"] for e in events]
        self.assertEqual(kinds[0], "connected")
        self.assertIn("disconnected", kinds)
        self.assertEqual([e for e in events if e["kind"] == "disconnected"][0]["reason"], "stop")
        self.assertEqual(kinds[-1], "stopped")

    def test_reconnects_after_server_closes(self):
        async def go():
            async def handler(ws, n):
                await ws.send(mini("BTC", 100, int(time.time() * 1000)))
                await asyncio.sleep(0.15)
                if n == 1:
                    await ws.close(1011)                                                    # сервер обриває перше з'єднання
                    return
                await asyncio.sleep(5)
            got, events = [], []
            async with Srv(handler) as s:
                f = Feed(["btcusdt@miniTicker"], lambda st, d, t: got.append(t), hosts=[s.host], backoff_min=0.05, backoff_max=0.2, on_event=events.append, rnd=random.Random(1))
                task = asyncio.create_task(f.run())
                for _ in range(100):
                    if s.connections >= 2 and len(got) >= 2:
                        break
                    await asyncio.sleep(0.05)
                f.stop()
                await asyncio.wait_for(task, 5)
                return got, events, s.connections
        got, events, conns = run(go())
        self.assertGreaterEqual(conns, 2)
        self.assertGreaterEqual(len(got), 2, "після обриву дані знову йдуть")
        self.assertEqual([e["kind"] for e in events if e["kind"] in ("connected", "disconnected")][:3], ["connected", "disconnected", "connected"])
        self.assertTrue(events[1]["reason"].startswith("closed:"))

    def test_stale_connection_detected_and_replaced(self):
        async def go():
            async def handler(ws, n):
                if n == 1:
                    await asyncio.sleep(10)                                                 # перше з'єднання «мовчить»
                    return
                await ws.send(mini("ETH", 5, int(time.time() * 1000)))
                await asyncio.sleep(10)
            got, events = [], []
            async with Srv(handler) as s:
                f = Feed(["ethusdt@miniTicker"], lambda st, d, t: got.append(d), hosts=[s.host], stale_s=0.6, backoff_min=0.05, backoff_max=0.1, on_event=events.append, ping_interval=None)
                task = asyncio.create_task(f.run())
                t0 = time.monotonic()
                for _ in range(200):
                    if got:
                        break
                    await asyncio.sleep(0.05)
                took = time.monotonic() - t0
                f.stop()
                await asyncio.wait_for(task, 8)
                return got, events, took
        got, events, took = run(go())
        self.assertEqual(len(got), 1)
        self.assertIn("stale", [e.get("reason") for e in events])
        self.assertLess(took, 4.0, "тишу виявлено й з'єднання замінено швидко")

    def test_chaos_drop_aborts_and_recovers(self):
        async def go():
            async def handler(ws, n):
                while True:
                    await ws.send(mini("BTC", 1, int(time.time() * 1000)))
                    await asyncio.sleep(0.05)
            events, got = [], []
            async with Srv(handler) as s:
                f = Feed(["btcusdt@miniTicker"], lambda st, d, t: got.append(t), hosts=[s.host], backoff_min=0.05, backoff_max=0.1, on_event=events.append)
                task = asyncio.create_task(f.run())
                await asyncio.sleep(0.5)
                n_before = len(got)
                f.chaos_drop("chaos")
                for _ in range(100):
                    if s.connections >= 2 and len(got) > n_before + 3:
                        break
                    await asyncio.sleep(0.05)
                f.stop()
                await asyncio.wait_for(task, 5)
                return events, got, n_before
        events, got, n_before = run(go())
        self.assertIn("chaos", [e.get("reason") for e in events])
        self.assertGreater(len(got), n_before + 3, "дані відновились після грубого обриву")
        rec = Recorder()
        for e in events:
            rec.on_event(e)
        summ = rec.summary()
        self.assertEqual(summ["connections"], 2)
        self.assertEqual(len(summ["downtime_s_each"]), 1)
        self.assertLess(summ["downtime_s_max"], 2.0)

    def test_host_failover_and_backoff_growth(self):
        async def go():
            async def handler(ws, n):
                await ws.send(mini("BTC", 1, int(time.time() * 1000)))
                await asyncio.sleep(5)
            got, events = [], []
            async with Srv(handler) as s:
                dead = "ws://127.0.0.1:1"                                                   # порт без сервера
                f = Feed(["btcusdt@miniTicker"], lambda st, d, t: got.append(d), hosts=[dead, s.host], backoff_min=0.05, backoff_max=0.2, open_timeout=1, on_event=events.append, rnd=random.Random(2))
                task = asyncio.create_task(f.run())
                for _ in range(100):
                    if got:
                        break
                    await asyncio.sleep(0.05)
                f.stop()
                await asyncio.wait_for(task, 5)
                return got, events, f
        got, events, f = run(go())
        self.assertEqual(len(got), 1, "резервний хост підхопив з'єднання")
        self.assertGreaterEqual(f.failures, 1)
        self.assertEqual(events[0]["kind"], "connect_failed")
        f2 = Feed([], lambda *a: None, backoff_min=0.5, backoff_max=30, rnd=random.Random(3))
        b = [f2.next_backoff(a) for a in range(1, 12)]
        self.assertLess(b[0], 0.51)
        self.assertGreater(max(b), 10)
        self.assertLessEqual(max(b), 30.0, "пауза обмежена зверху")
        self.assertTrue(all(b[i] > 0 for i in range(len(b))))

    def test_max_age_rotation_without_backoff(self):
        async def go():
            async def handler(ws, n):
                await ws.send(mini("BTC", 1, int(time.time() * 1000)))
                await asyncio.sleep(10)
            events = []
            async with Srv(handler) as s:
                f = Feed(["btcusdt@miniTicker"], lambda *a: None, hosts=[s.host], max_conn_s=0.4, on_event=events.append)
                task = asyncio.create_task(f.run())
                for _ in range(100):
                    if s.connections >= 2:
                        break
                    await asyncio.sleep(0.05)
                f.stop()
                await asyncio.wait_for(task, 5)
                return events, s.connections
        events, conns = run(go())
        self.assertGreaterEqual(conns, 2)
        self.assertIn("max_age", [e.get("reason") for e in events])
        self.assertNotIn("backoff", [e["kind"] for e in events[:4]], "планова ротація без паузи")

    def test_bad_json_ignored(self):
        async def go():
            async def handler(ws, n):
                await ws.send("це не json")
                await ws.send(json.dumps({"no": "data"}))
                await ws.send(mini("BTC", 7, 1))
                await asyncio.sleep(5)
            got, events = [], []
            async with Srv(handler) as s:
                f = Feed(["x"], lambda st, d, t: got.append(d), hosts=[s.host], on_event=events.append)
                task = asyncio.create_task(f.run())
                for _ in range(60):
                    if got:
                        break
                    await asyncio.sleep(0.05)
                f.stop()
                await asyncio.wait_for(task, 5)
                return got, events
        got, events = run(go())
        self.assertEqual(len(got), 1)
        self.assertIn("bad_json", [e["kind"] for e in events])

    def test_recorder_log_written_only_to_given_path(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "x.jsonl")
            r = Recorder(log_path=p)
            r.on_event({"kind": "connected", "t": 1.0})
            r.minute_report()
            r.close()
            with open(p, encoding="utf-8") as fh:
                lines = [json.loads(x) for x in fh]
            self.assertEqual([x["kind"] for x in lines], ["connected", "minute"])


class IsolationTests(unittest.TestCase):
    """Гарантії етапу B: прототип не торкається рушія, data/, гілки data, Actions і не торгує."""

    def sources(self):
        out = {}
        for base, _, files in os.walk(os.path.join(ROOT, "live2")):
            for f in files:
                if f.endswith(".py"):
                    with open(os.path.join(base, f), encoding="utf-8") as fh:
                        out[os.path.join(base, f)] = fh.read()
        return out

    def test_no_engine_imports_or_data_writes(self):
        importers = []
        for path, src in self.sources().items():
            code = "\n".join(l for l in src.splitlines() if not l.strip().startswith("#"))
            if re.search(r"^\s*(from|import)\s+(tools|agents|agent_)", code, re.M):
                importers.append(os.path.basename(path))
            self.assertIsNotNone(code)
            if os.path.basename(path) not in ("engine_bridge.py", "reference_run.py", "reference_c20.py"):
                self.assertNotIn("CRYPTO_DATA_DIR", code, path)
            self.assertIsNone(re.search(r"""['"]data[/\\]""", code), path + ": звернення до data/")
            self.assertNotIn("api/v3/order", code, path + ": торгові ендпойнти")
            self.assertIsNone(re.search(r"X-MBX-APIKEY|signature|BINANCE_.*KEY", code, re.I), path + ": ключі й підписи")
        self.assertEqual(sorted(importers), ["engine_bridge.py", "reference_c20.py", "reference_run.py"], "код чинного рушія імпортують лише міст engine_bridge і окремий процес-еталон (лише читання): " + str(importers))

    def test_only_logs_dir_is_written(self):
        for path, src in self.sources().items():
            if os.path.basename(path) in ("cadence.py", "fixture.py", "engine_bridge.py", "shadow.py", "driver.py", "reference_run.py", "replay.py", "posthoc.py", "datasets.py", "c20.py", "c20_build.py", "c20_hashes_doc.py", "c20_results_doc.py", "reference_c20.py"):
                continue                                                                  # цілі запису цих модулів (logs/, fixtures/, state/) перевіряються тестами тіньового рушія
            for m in re.finditer(r"open\(([^)]*)\)", src):
                arg = m.group(1)
                if '"a"' in arg or '"w"' in arg or "'a'" in arg or "'w'" in arg:
                    self.assertTrue("log_path" in arg or "out" in arg, path + ": запис поза logs: " + arg)


if __name__ == "__main__":
    unittest.main(verbosity=2)
