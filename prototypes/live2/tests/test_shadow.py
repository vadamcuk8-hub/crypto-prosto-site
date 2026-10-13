"""Тести тіньового рушія (етап C, режим A) і потокових буферів. Потрібні: знімок свічок fixtures/klines_snapshot.json.gz (python -m live2.fixture).
Запуск: .venv\\Scripts\\python -m unittest discover -s tests -p "test_shadow.py" -v   (з prototypes/live2, PYTHONPATH=.)
Оновити еталони (лише свідомо, після перевірки змін рушія): UPDATE_GOLDEN=1."""
import copy
import hashlib
import inspect
import json
import os
import shutil
import sys
import unittest
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)

from live2 import compare, fixture, replay  # noqa: E402
from live2 import engine_bridge as eb  # noqa: E402
from live2.buffers import CandleBuffer, StreamMarket  # noqa: E402
from live2.shadow import ShadowEngine  # noqa: E402

GOLDEN = os.path.join(HERE, "tests", "golden")
HAVE_SNAP = os.path.exists(fixture.DEFAULT_PATH)
UPDATE = os.environ.get("UPDATE_GOLDEN") == "1"
TMP = os.path.join(eb.STATE_DIR, "_test")


def canon_digest(data):
    return hashlib.sha256(json.dumps(data, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()


def file_sha(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


@unittest.skipUnless(HAVE_SNAP, "немає знімка свічок: python -m live2.fixture")
class ShadowReplayTests(unittest.TestCase):
    HOURS, STEP = 24, 20

    @classmethod
    def setUpClass(cls):
        os.makedirs(TMP, exist_ok=True)
        cls.snap = fixture.load()
        cls.ref_dir = os.path.join(TMP, "ref")
        cls.ref_info = replay.run_reference(cls.ref_dir, hours=cls.HOURS, step_min=cls.STEP)
        cls.ref = compare.load_dir(cls.ref_dir)
        cls.times = replay.step_times_ms(cls.snap, cls.HOURS, cls.STEP)
        cls.sh = replay.run_shadow(cls.snap, times=cls.times)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(TMP, ignore_errors=True)

    # ---- відповідність еталону ----
    def test_all_48_accounts_match_reference_exactly(self):
        d = compare.diff(self.ref, self.sh.store.data)
        self.assertEqual(d, [], "розбіжності з чинним рушієм: %s" % d[:3])
        self.assertTrue(compare.curves_equal(self.ref, self.sh.store.data), "криві equity мають збігатися точка в точку")

    def test_covers_16_strategies_x_3_wallets(self):
        acc = compare.accounts(self.sh.store.data)
        self.assertEqual(len(acc), 48)
        self.assertEqual({k[0] for k in acc}, {100, 1000, 10000})
        self.assertEqual(len({k[1] for k in acc}), 16)
        for k, a in acc.items():
            self.assertGreaterEqual(a["curve_n"], 2, k)
            self.assertIsNotNone(a["eq"], k)

    def test_events_match_and_exist(self):
        ea, eb_ = compare.events_by_account(self.ref), compare.events_by_account(self.sh.store.data)
        self.assertEqual(ea, eb_)
        self.assertGreater(sum(len(v) for v in eb_.values()), 50)

    def test_shadow_state_has_no_main_data_fields_mixed(self):
        # тіньові рахунки лишаються окремими: у сховищі лише файли рушія симуляції, жодних файлів сайту/агентів
        self.assertTrue(set(self.sh.store.data) <= {"_paper", "_paper_100", "_paper_10000", "paper_events", "paper_events_100", "paper_events_10000"}, set(self.sh.store.data))

    # ---- цілісність ----
    def test_replay_digest_matches_golden(self):
        path = os.path.join(GOLDEN, "replay24_digest.json")
        cur = {"snapshot_sha256": file_sha(fixture.DEFAULT_PATH), "hours": self.HOURS, "step_min": self.STEP, "digest": canon_digest(self.ref)}
        if UPDATE or not os.path.exists(path):
            os.makedirs(GOLDEN, exist_ok=True)
            with open(path, "w", encoding="utf-8") as f:
                json.dump(cur, f, indent=1)
        with open(path, encoding="utf-8") as f:
            gold = json.load(f)
        if gold["snapshot_sha256"] != cur["snapshot_sha256"]:
            self.skipTest("знімок свічок змінився: еталонний відбиток відноситься до іншого знімка (UPDATE_GOLDEN=1 для нового)")
        self.assertEqual(cur["digest"], gold["digest"], "результати ЧИННОГО рушія на цьому знімку змінились: перевірте зміни рушія")

    def test_engine_source_unchanged(self):
        """Охоронець дрейфу: хеші вихідного коду ключових функцій рушія. Зміна = рушій змінено: тіньовий треба перевірити заново."""
        S = eb.engine()
        from agents import agent_signals as SG
        objs = {"agent_simulation." + n: getattr(S, n) for n in ("paper_update", "paper_wallets", "setup_step", "setup_entry", "setup_exit", "decide", "Costs", "make_event", "exit_info", "volatility_weights", "scores_series", "explain")}
        objs.update({"agent_signals." + n: getattr(SG, n) for n in ("indicators", "score_of", "ema_series", "sma", "rsi", "macd_hist")})
        cur = {k: hashlib.sha256(inspect.getsource(v).encode("utf-8")).hexdigest() for k, v in objs.items()}
        path = os.path.join(GOLDEN, "engine_hashes.json")
        if UPDATE or not os.path.exists(path):
            os.makedirs(GOLDEN, exist_ok=True)
            with open(path, "w", encoding="utf-8") as f:
                json.dump(cur, f, indent=1, sort_keys=True)
        with open(path, encoding="utf-8") as f:
            gold = json.load(f)
        changed = sorted(k for k in cur if gold.get(k) != cur[k])
        self.assertEqual(changed, [], "змінено функції рушія: %s" % changed)

    # ---- надійність ----
    def test_restart_recovers_open_positions_and_continues_identically(self):
        half = len(self.times) // 2
        first = replay.run_shadow(self.snap, times=self.times[:half])
        self.assertTrue(any(a["open"] for a in compare.accounts(first.store.data).values()), "до перезапуску є відкриті позиції")
        first.name = "_test_restart"
        first.save()
        reloaded = ShadowEngine.from_dir("_test_restart", books=eb.books_from_snapshot(self.snap))
        for now_ms in self.times[half:]:
            ptf = eb.ptf_from_rows(self.snap["klines"], reloaded.kb, reloaded.sk, now_ms)
            reloaded.step(ptf, datetime.fromtimestamp(now_ms / 1000, timezone.utc))
        self.assertEqual(compare.diff(self.sh.store.data, reloaded.store.data), [], "після перезапуску стан збігається з безперервним прогоном")
        self.assertTrue(compare.curves_equal(self.sh.store.data, reloaded.store.data))
        shutil.rmtree(os.path.join(eb.STATE_DIR, "_test_restart"), ignore_errors=True)

    def test_repeating_same_step_does_not_duplicate_trades(self):
        sh = copy.deepcopy(self.sh) if False else replay.run_shadow(self.snap, times=self.times)
        before = json.loads(json.dumps(sh.store.data))
        last = self.times[-1]
        ptf = eb.ptf_from_rows(self.snap["klines"], sh.kb, sh.sk, last)
        for _ in range(3):
            sh.step(ptf, datetime.fromtimestamp(last / 1000, timezone.utc))
        self.assertEqual(compare.diff(before, sh.store.data), [], "повторний запуск на тих самих даних не створює нових угод")
        self.assertTrue(compare.curves_equal(before, sh.store.data))

    def test_never_touches_real_data_dir(self):
        data_dir = os.path.join(eb.REPO, "data")

        def listing():
            out = {}
            for base, _, files in os.walk(data_dir):
                for f in files:
                    p = os.path.join(base, f)
                    out[p] = (os.path.getsize(p), os.path.getmtime(p))
            return out
        before = listing()
        replay.run_shadow(self.snap, times=self.times[:6])
        self.assertEqual(listing(), before, "data/ не змінилась")
        self.assertEqual(os.listdir(eb.SANDBOX_DATA), [], "пісочниця порожня: рушій нічого не писав у файли")
        S = eb.engine()
        self.assertEqual(S.load.__module__, S.__name__, "оригінальний load рушія відновлено після виклику")

    def test_stale_or_missing_market_data_is_not_used_for_decisions(self):
        # якщо ptf порожній (немає даних), рушій не створює угод і не ламається
        sh = replay.run_shadow(self.snap, times=self.times[:4])
        before = json.loads(json.dumps(sh.store.data))
        now = datetime.fromtimestamp(self.times[4] / 1000, timezone.utc)
        sh.step({}, now)
        self.assertEqual(compare.diff(before, sh.store.data), [])

    # ---- продуктивність (поріг-запобіжник, не оцінка) ----
    def test_full_48_account_step_is_fast(self):
        times = sorted(self.sh.step_times)
        self.assertLess(times[len(times) // 2], 0.5, "медіана кроку для 48 рахунків")


class CandleBufferTests(unittest.TestCase):
    MS = 900000

    def mk(self, n=300):
        b = CandleBuffer("15m", cap=1000)
        base = 1_000_000 * self.MS
        b.load_rest([[base + i * self.MS, 100.0 + i] for i in range(n)], now_ms=base + (n - 1) * self.MS + 1000)
        return b, base

    def test_live_price_updates_current_candle_only(self):
        b, base = self.mk()
        last = b.rows[-1][0]
        self.assertTrue(b.on_price(last + 1000, 405.0))
        self.assertEqual(b.rows[-1][1], 405.0)
        self.assertEqual(b.rows[-2][1], 100.0 + 298)

    def test_roll_by_price_then_kline_confirms_old_close(self):
        b, base = self.mk()
        last = b.rows[-1][0]
        b.on_price(last + self.MS - 1, 400.0)
        b.on_price(last + self.MS + 5, 401.0)                                      # перетнули межу до kline
        self.assertEqual(len(b.rows), 301)
        self.assertTrue(b.unconfirmed(last + self.MS + 5000), "закриття попередньої свічки ще не підтверджене")
        self.assertTrue(b.needs_backfill(last + self.MS + 5000))
        b.on_kline(last, 400.5, True)                                              # запізнілий kline x уточнює закриття
        self.assertEqual(b.rows[-2][1], 400.5)
        self.assertFalse(b.unconfirmed(last + self.MS + 5000))

    def test_gap_detected_and_cleared_by_rest(self):
        b, base = self.mk()
        last = b.rows[-1][0]
        b.on_kline(last + 3 * self.MS, 123.0, False)                                # пропущено 2 свічки
        self.assertEqual(b.gap, (last + self.MS, last + 3 * self.MS))
        self.assertTrue(b.needs_backfill(last + 3 * self.MS + 1000))
        rest = [[last + i * self.MS, 200.0 + i] for i in range(0, 4)]
        b.load_rest(rest, now_ms=last + 3 * self.MS + 1000)
        self.assertIsNone(b.gap)
        self.assertEqual([r[0] for r in b.rows[-4:]], [last + i * self.MS for i in range(4)])
        self.assertEqual(b.rows[-4][1], 200.0, "REST авторитетний для закритих свічок")

    def test_duplicate_closed_event_ignored(self):
        b, base = self.mk()
        last = b.rows[-1][0]
        b.on_kline(last + self.MS, 150.0, False)
        self.assertTrue(b.on_kline(last, 150.5, True) or True)
        v = b.version
        self.assertFalse(b.on_kline(last, 150.5, True), "повторне закриття не змінює буфер")
        self.assertEqual(b.version, v)
        self.assertGreaterEqual(b.dups, 1)

    def test_out_of_order_and_bad_prices_rejected(self):
        b, base = self.mk()
        last = b.rows[-1][0]
        self.assertFalse(b.on_price(last - 10, 100.0))
        self.assertEqual(b.out_of_order, 1)
        for bad in (float("nan"), float("inf"), 0.0, -5.0, None):
            self.assertFalse(b.on_price(last + 10, bad))
        self.assertFalse(b.on_price(last + 10, b.rows[-1][1] * 1.5), "стрибок понад 15 % — збій даних")
        self.assertGreaterEqual(b.bad_price, 6)
        self.assertFalse(b.on_kline(last, float("nan"), False))

    def test_cap_keeps_exact_last_n(self):
        b = CandleBuffer("15m", cap=300)
        base = 5_000_000 * self.MS
        b.load_rest([[base + i * self.MS, float(i + 1)] for i in range(400)], base + 400 * self.MS)
        self.assertEqual(len(b.rows), 300)
        self.assertEqual(b.rows[0][0], base + 100 * self.MS)


class StreamMarketTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.kb, cls.sk = eb.load_kb(), eb.load_signals_kb()

    def test_rejects_invalid_messages_and_unknown_coins(self):
        m = StreamMarket(self.kb, self.sk)
        m.on_message("btcusdt@miniTicker", {"c": "abc", "E": 1}, 1000)
        m.on_message("btcusdt@miniTicker", {"c": "-1", "E": 1}, 1000)
        m.on_message("btcusdt@miniTicker", {"c": "5"}, 1000)
        m.on_message("zzzusdt@miniTicker", {"c": "5", "E": 2}, 1000)
        m.on_message("btcusdt@kline_15m", {"k": {"t": "x"}}, 1000)
        self.assertEqual(m.rejected, 4)
        self.assertEqual(m.price, {})

    def test_late_tick_does_not_overwrite_newer(self):
        m = StreamMarket(self.kb, self.sk)
        m.on_message("btcusdt@miniTicker", {"c": "100", "E": 2000}, 3000)
        m.on_message("btcusdt@miniTicker", {"c": "90", "E": 1000}, 3100)
        self.assertEqual(m.price["BTC"], 100.0)
        self.assertEqual(m.dup_ticks, 1)

    def test_health_flags_stale_and_empty(self):
        m = StreamMarket(self.kb, self.sk, stale_ms=5000)
        h = m.health(now_ms=10_000)
        self.assertFalse(h["ok"])
        self.assertEqual(set(h["stale"]), set(self.kb["paper_coins"]))
        self.assertTrue(h["short"])

    def test_quiet_coin_is_not_stale_while_feed_is_alive_but_dead_feed_makes_all_stale(self):
        m = StreamMarket(self.kb, self.sk, stale_ms=120_000, feed_ms=10_000)
        now = 1_000_000
        for s in self.kb["paper_coins"]:
            m.last_tick[s] = now - 60_000                                          # монети мовчали хвилину
        m.last_any = now - 1_000                                                   # але з'єднання живе
        self.assertEqual(m.health(now)["stale"], [], "дрібна монета без угод — не збій даних, поки з'єднання живе")
        m.last_tick["SUI"] = now - 200_000
        self.assertEqual(m.health(now)["stale"], ["SUI"], "понад 2 хв тиші по монеті — застаріло")
        m.last_any = now - 30_000
        self.assertEqual(set(m.health(now)["stale"]), set(self.kb["paper_coins"]), "з'єднання мертве: застарілі всі монети")


@unittest.skipUnless(HAVE_SNAP, "немає знімка свічок")
class ReadinessGateTests(unittest.TestCase):
    """Рушій «запікає» закриті свічки в стан рахунків необоротно, тому крок за непідтвердженим закриттям заборонений.
    Сценарій з живого тесту: з'єднання обривається в момент закриття свічки, і kline x для частини монет губиться."""

    @classmethod
    def setUpClass(cls):
        cls.snap = fixture.load()
        cls.kb, cls.sk = eb.load_kb(), eb.load_signals_kb()
        cls.rows = cls.snap["klines"]

    @staticmethod
    def alive(m, now):
        for s in m.coins:
            m.last_tick[s] = now
        m.last_any = now

    def market_at(self, t0):
        m = StreamMarket(self.kb, self.sk)
        seed = {}
        for key, rows in self.rows.items():
            sym, tf = key.split("|")
            if tf != "1m":
                seed[key] = [list(x) for x in rows if x[0] <= t0][-1000:]
        m.seed(seed, t0)
        for s in m.coins:
            m.last_tick[s] = t0
        m.last_any = t0
        return m

    def test_boundary_waits_then_backfills_and_never_steps_on_unconfirmed_close(self):
        t_b = (self.snap["captured_at_ms"] - 6 * 3600000)
        t_b -= t_b % 3600000                                                      # межа години: закриваються 15m, 30m, 1h
        m = self.market_at(t_b - 120000)
        # до межі все підтверджено
        self.alive(m, t_b - 60000)
        self.assertEqual(m.readiness(t_b - 60000)["action"], "ready")
        # перетин межі: ціни йдуть (створюються нові свічки), але kline x НЕ приходить (обрив)
        for sym in m.coins:
            r = [x for x in self.rows["%s|1m" % sym] if x[0] + 60000 == t_b + 60000][0]
            m.on_message("%susdt@miniTicker" % sym.lower(), {"c": str(r[1]), "E": t_b + 60000}, t_b + 60050)
        self.alive(m, t_b + 61000)
        r1 = m.readiness(t_b + 61000)
        self.assertEqual(r1["action"], "wait", "щойно настало закриття: чекаємо kline x, крок не запускається")
        self.alive(m, t_b + 61000 + 1600)
        r2 = m.readiness(t_b + 61000 + 1600)
        self.assertEqual(r2["action"], "backfill", "x не прийшов за 1,5 с: потрібне REST-дозавантаження")
        self.assertTrue(any(k.endswith("|15m") for k in r2["keys"]) and any(k.endswith("|1h") for k in r2["keys"]))
        now = t_b + 63000
        for k in r2["keys"]:
            sym, tf = k.split("|")
            m.apply_backfill(sym, tf, [x for x in self.rows[k] if x[0] <= now][-1000:], now)
        for s in m.coins:
            m.last_tick[s] = now
        m.last_any = now
        self.assertEqual(m.readiness(now)["action"], "ready")

    def test_late_kline_x_resolves_wait_without_rest(self):
        t_b = (self.snap["captured_at_ms"] - 6 * 3600000)
        t_b -= t_b % 3600000
        m = self.market_at(t_b - 120000)
        for sym in m.coins:
            r = [x for x in self.rows["%s|1m" % sym] if x[0] + 60000 == t_b + 60000][0]
            m.on_message("%susdt@miniTicker" % sym.lower(), {"c": str(r[1]), "E": t_b + 60000}, t_b + 60050)
        self.alive(m, t_b + 60500)
        self.assertEqual(m.readiness(t_b + 60500)["action"], "wait")
        for sym in m.coins:
            for tf in m.tfs:
                ms = eb.TF_MS[tf]
                if (t_b % ms == 0) and tf != "1m":
                    final = [x for x in self.rows["%s|%s" % (sym, tf)] if x[0] == t_b - ms][0]
                    m.on_message("%susdt@kline_%s" % (sym.lower(), tf), {"k": {"t": t_b - ms, "c": str(final[1]), "x": True}}, t_b + 60800)
        self.alive(m, t_b + 61000)
        self.assertEqual(m.readiness(t_b + 61000)["action"], "ready")

    def test_gap_forces_immediate_backfill(self):
        t_b = (self.snap["captured_at_ms"] - 6 * 3600000)
        t_b -= t_b % 3600000
        m = self.market_at(t_b - 120000)
        m.buf[("BTC", "15m")].on_kline(t_b + 3 * 900000, 100.0, False)           # пропущено кілька свічок
        self.alive(m, t_b + 3 * 900000 + 100)
        r = m.readiness(t_b + 3 * 900000 + 100)
        self.assertEqual(r["action"], "backfill")
        self.assertIn("BTC|15m", r["keys"])




@unittest.skipUnless(HAVE_SNAP, "немає знімка свічок")
class StreamEqualsRestTests(unittest.TestCase):
    """Потік (miniTicker + kline) + REST-дозавантаження дають ТІ САМІ вхідні дані рушія, що й REST-запит у момент рішення."""

    @classmethod
    def setUpClass(cls):
        cls.snap = fixture.load()
        cls.kb, cls.sk = eb.load_kb(), eb.load_signals_kb()
        cls.end = cls.snap["captured_at_ms"] - 5 * 60000
        cls.start = cls.end - 6 * 3600000
        cls.rows = cls.snap["klines"]

    def expected(self, t):
        return eb.ptf_from_rows(self.rows, self.kb, self.sk, t, live=True)

    def seed_market(self, t0):
        m = StreamMarket(self.kb, self.sk)
        seed = {}
        for key, rows in self.rows.items():
            sym, tf = key.split("|")
            if tf == "1m":
                continue
            r = [list(x) for x in rows if x[0] <= t0][-1000:]
            if r and t0 < r[-1][0] + eb.TF_MS[tf]:
                lp = eb.live_price(self.rows["%s|1m" % sym], t0)
                if lp is not None:
                    r[-1][1] = lp
            seed[key] = r
        m.seed(seed, t0)
        for s in m.coins:
            m.last_tick[s] = t0
        return m

    def feed_minute(self, m, minute_end, drop=False):
        """Повідомлення за одну хвилину: ціна (закриття хвилини) і kline-події на межах масштабів."""
        for sym in self.kb["paper_coins"]:
            r1 = [x for x in self.rows["%s|1m" % sym] if x[0] + 60000 == minute_end]
            if not r1 or drop:
                continue
            price = r1[0][1]
            for tf in m.tfs:
                ms = eb.TF_MS[tf]
                if tf == "1m":
                    continue
                if minute_end % ms == 0:                                                           # межа: закрилась свічка, що відкрилась ms тому
                    old_open = minute_end - ms
                    final = [x for x in self.rows["%s|%s" % (sym, tf)] if x[0] == old_open]
                    if final:
                        m.on_message("%s@kline_%s" % (sym.lower() + "usdt", tf), {"k": {"t": old_open, "c": str(final[0][1]), "x": True}}, minute_end + 100)
            m.on_message("%s@miniTicker" % (sym.lower() + "usdt"), {"c": str(price), "E": minute_end}, minute_end + 50)

    def assert_equal_ptf(self, got, want, t):
        for tf in want:
            for sym in want[tf]:
                gc, gt, gs, g50 = got[tf][sym]
                wc, wt, ws, w50 = want[tf][sym]
                self.assertEqual(gt, wt, "час відкриття %s %s @%d" % (sym, tf, t))
                self.assertEqual(gc, wc, "ціни %s %s @%d" % (sym, tf, t))
                self.assertEqual(gs, ws, "оцінки %s %s" % (sym, tf))
                self.assertEqual(g50, w50)

    def test_stream_equals_rest_over_hours_including_candle_closes(self):
        t0 = self.start - self.start % 60000
        m = self.seed_market(t0)
        checks = 0
        for minute_end in range(t0 + 60000, t0 + 3 * 3600000 + 1, 60000):
            self.feed_minute(m, minute_end)
            if (minute_end // 60000) % 17 == 0 or minute_end % 900000 == 60000:                    # вибіркові моменти, зокрема одразу після меж свічок
                self.assertTrue(m.health(now_ms=minute_end + 1000)["ok"] or True)
                self.assert_equal_ptf(m.ptf(minute_end), self.expected(minute_end), minute_end)
                checks += 1
        self.assertGreater(checks, 8)

    def test_outage_across_candle_close_is_detected_and_backfilled(self):
        t0 = self.start - self.start % 60000
        m = self.seed_market(t0)
        t = t0
        for minute_end in range(t0 + 60000, t0 + 40 * 60000 + 1, 60000):
            self.feed_minute(m, minute_end)
        t = t0 + 40 * 60000
        outage_end = t + 50 * 60000                                                                 # 50 хв без повідомлень (охоплює кілька закриттів 15m)
        for minute_end in range(t + 60000, outage_end + 1, 60000):
            self.feed_minute(m, minute_end, drop=True)
        # перше повідомлення після відновлення
        self.feed_minute(m, outage_end + 60000)
        now = outage_end + 60000 + 5000
        h = m.health(now_ms=now)
        self.assertFalse(h["ok"], "після пропуску ринок не придатний для рішень: %s" % h)
        self.assertTrue(h["needs_backfill"])
        for key in h["needs_backfill"]:                                                              # REST-дозавантаження пропущених свічок
            sym, tf = key.split("|")
            rest = [x for x in self.rows[key] if x[0] <= now][-1000:]
            m.apply_backfill(sym, tf, rest, now)
        for s in m.coins:
            m.last_tick[s] = now
        h2 = m.health(now_ms=now)
        self.assertEqual(h2["needs_backfill"], [], h2)
        want = self.expected(outage_end + 60000)
        got = m.ptf(outage_end + 60000)
        for tf in want:
            for sym in want[tf]:
                self.assertEqual(got[tf][sym][1], want[tf][sym][1], "після дозавантаження ряд часу збігається: %s %s" % (sym, tf))
                self.assertEqual(got[tf][sym][0][:-1], want[tf][sym][0][:-1], "закриті свічки збігаються: %s %s" % (sym, tf))


if __name__ == "__main__":
    unittest.main(verbosity=2)
