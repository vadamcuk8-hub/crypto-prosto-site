"""C2.1: перевірки R1 (`paper_step`) і R2 (`Costs(kb, cap, books=None)`).
Еталони D7/D8 — НЕЗАЛЕЖНІ реальні набори, зняті з рушія ДО R1/R2 (tests/golden/c21/). Тести C2.0 (tests/test_c20.py) не змінювались і є головною перевіркою сумісності.

  • BehaviourGolden21: еталонний підпроцес (справжній файловий ввід-вивід), тінь і ЧИСТЕ відтворення лише через paper_step збігаються з еталоном на кожному кроці;
  • PaperStepContract: чиста функція нічого не читає/не пише, не змінює вхідні дані, повторювана, обгортка paper_update дає той самий результат;
  • CostsBooksArgument: комісія 0,1 %, проковзання, мінімальний ордер, тонка книга, без книги, старий інтерфейс, новий необов'язковий аргумент.
Запуск (з prototypes/live2):  .venv\\Scripts\\python -m unittest tests.test_c21 -v"""
import builtins
import copy
import inspect
import json
import os
import socket
import sys
import unittest
from datetime import datetime, timezone
from unittest import mock

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)

from live2 import c20, c21, compare, datasets  # noqa: E402
from live2 import engine_bridge as eb  # noqa: E402
from live2.shadow import ShadowEngine  # noqa: E402

HAVE = all(os.path.isdir(os.path.join(c21.C21_DIR, d)) for d in ("D7", "D8")) and os.path.isdir(c21.GOLDEN_DIR)
FILES = ("_paper", "_paper_100", "_paper_10000", "paper_events", "paper_events_100", "paper_events_10000")
_CACHE = {}
PRE_REFACTOR_ENGINE_SHA256 = "840d2a5d7ba14934fe70f468aa3e8f08bb5e675ef545eb84728c0147396f898f"     # tools/agents/agent_simulation.py у 2907f15


def ds_of(name):
    if ("ds", name) not in _CACHE:
        _CACHE[("ds", name)] = c21.load(name)
    return _CACHE[("ds", name)]


def golden(name):
    with open(c21.golden_path(name), encoding="utf-8") as f:
        return json.load(f)


def first_diff(a, b):
    for i, (x, y) in enumerate(zip(a, b)):
        if x != y:
            return i
    return None if len(a) == len(b) else min(len(a), len(b))


def reference(name):
    if ("ref", name) not in _CACHE:
        _CACHE[("ref", name)] = c21.run_reference(name, os.path.join(eb.STATE_DIR, "_test_c21_" + name))
    return _CACHE[("ref", name)]


def shadow(name):
    if ("shd", name) not in _CACHE:
        _CACHE[("shd", name)] = c21.run_shadow(name, ds_of(name))
    return _CACHE[("shd", name)]


def pure_replay(name):
    """Відтворення ТІЛЬКИ через S.paper_step: без файлів, без підміни load/write_json/outlook_context; книги передаються аргументом (R2)."""
    ds = ds_of(name)
    S = eb.engine()
    kb = ds["kb"]
    books = eb.books_from_snapshot({"books": ds["books"]}) if ds["books"] else {}
    wl = kb["wallets"]
    caps = [int(c) for c in kb["accounts"]]
    state, chain = {}, []
    for ms in c21.times_of(ds):
        ptf = eb.ptf_from_rows(ds["klines"], kb, ds["sk"], ms, live=True)
        now = datetime.fromtimestamp(ms / 1000, timezone.utc)
        for cap in caps:
            coins = set(wl.get(str(cap)) or kb["paper_coins"])
            sub = {tf: {s: v for s, v in ser.items() if s in coins} for tf, ser in ptf.items()}
            tag = compare.tag_of(cap)
            st, ev, _res = S.paper_step(state.get("_paper" + tag) or {}, state.get("paper_events" + tag) or {}, {}, sub, dict(kb, accounts=[cap]), now, books)
            state["_paper" + tag] = json.loads(json.dumps(st, ensure_ascii=False))
            state["paper_events" + tag] = json.loads(json.dumps(ev, ensure_ascii=False))
        files = {k: datasets.sha(state[k]) for k in FILES if k in state}
        chain.append(datasets.sha(files))
    return chain, state


@unittest.skipUnless(HAVE, "немає наборів C2.1: fixtures/c21 і tests/golden/c21")
class DataIntegrity21(unittest.TestCase):
    def test_new_datasets_are_intact_real_and_independent_of_c20(self):
        c20_windows = []
        for n in ("D1", "D2", "D3", "D4", "D5", "D6"):
            m = datasets.load(n)["meta"]
            c20_windows.append((m["end_ms"] - int(m["eval_hours"] * 3600000), m["end_ms"]))
        for n in ("D7", "D8"):
            ds = ds_of(n)
            self.assertEqual(datasets.verify_integrity(ds), [], n)
            self.assertEqual(ds["meta"]["gaps"], {}, "реальні дані без дірок: " + n)
            s, e = ds["meta"]["end_ms"] - int(ds["meta"]["eval_hours"] * 3600000), ds["meta"]["end_ms"]
            for a, b in c20_windows:
                self.assertTrue(e <= a or s >= b, "%s перетинається з набором C2.0" % n)
            self.assertEqual(len(ds["kb"]["strategies"]), 16)
        self.assertIsNone(ds_of("D7")["books"])
        self.assertEqual(sorted(ds_of("D8")["books"]), sorted(ds_of("D8")["kb"]["paper_coins"]))

    def test_goldens_were_taken_from_engine_without_r1_r2(self):
        """`engine_file_sha256` в еталоні — SHA-256 agent_simulation.py на момент зняття (коміт 2907f15, до R1/R2)."""
        for n in ("D7", "D8"):
            g = golden(n)
            self.assertEqual(g["input_sha256"], ds_of(n)["meta"]["sha256"])
            self.assertEqual(g["engine_file_sha256"], PRE_REFACTOR_ENGINE_SHA256, n)


@unittest.skipUnless(HAVE, "немає наборів C2.1")
class BehaviourGolden21(unittest.TestCase):
    def test_reference_matches_pre_refactor_golden_at_every_step(self):
        for n in ("D7", "D8"):
            ref, data = reference(n)
            g = golden(n)
            i = first_diff([s["state_sha"] for s in ref["steps"]], g["step_state_sha256"])
            self.assertIsNone(i, "%s: поведінка змінилась, перший крок розбіжності стану: %s" % (n, i))
            j = first_diff([s["result_sha"] for s in ref["steps"]], g["step_result_sha256"])
            self.assertIsNone(j, "%s: змінився результат paper_wallets на кроці %s" % (n, j))
            rec = c21.record(n, ref, data, ds_of(n))
            for key in ("final_files_sha256", "final_state_sha256", "accounts_table_sha256", "input_sha256", "kb_effective_sha256", "step_times_sha256"):
                self.assertEqual(rec[key], g[key], "%s: %s" % (n, key))
            self.assertEqual(rec["accounts_table"], g["accounts_table"], n + ": 48 рахунків: PnL, equity, комісії, угоди, причини виходу, позиції, раунди")
            self.assertEqual(len(rec["accounts_table"]), 48)

    def test_shadow_equals_pre_refactor_golden_at_every_step(self):
        for n in ("D7", "D8"):
            steps, data = shadow(n)
            g = golden(n)
            self.assertIsNone(first_diff([s["state_sha"] for s in steps["steps"]], g["step_state_sha256"]), n)
            self.assertIsNone(first_diff([s["result_sha"] for s in steps["steps"]], g["step_result_sha256"]), n)

    def test_pure_paper_step_replay_equals_golden_with_explicit_books(self):
        """R1+R2 разом: без файлів і без підміни функцій вводу-виводу, книги D8 передаються аргументом, а не через глобальну BOOKS."""
        for n in ("D7", "D8"):
            chain, state = pure_replay(n)
            g = golden(n)
            self.assertIsNone(first_diff(chain, g["step_state_sha256"]), n + ": чисте відтворення розійшлось з еталоном")
            final = {k: datasets.sha(state[k]) for k in FILES if k in state}
            self.assertEqual(final, g["final_files_sha256"], n)

    def test_costs_grid_on_new_real_books_unchanged(self):
        with open(os.path.join(c21.GOLDEN_DIR, "costs_grid.json"), encoding="utf-8") as f:
            gold = json.load(f)
        g = c21.costs_grid_c21()
        self.assertEqual(datasets.sha(g), gold["grid_sha256"])
        self.assertEqual(g, gold["grid"])

    def test_all_sixteen_rules_and_exits_present_in_new_data(self):
        g = golden("D7")
        rules = {r["rule"] for r in g["accounts_table"]}
        self.assertEqual(len(rules), 16)
        self.assertGreater(sum(r["trades"] for r in g["accounts_table"]), 100, "новий набір має містити достатньо угод для порівняння")


def _kit(name="D7", upto=110):
    """Стан після `upto` кроків (отриманий чинним кодом через тінь) і вхід наступного кроку для гаманця 1000."""
    key = ("kit", name, upto)
    if key not in _CACHE:
        ds = ds_of(name)
        kb = ds["kb"]
        store = eb.MemStore()
        sh = ShadowEngine(kb=kb, sk=ds["sk"], store=store, books={})
        times = c21.times_of(ds)
        for ms in times[:upto]:
            sh.step(eb.ptf_from_rows(ds["klines"], kb, ds["sk"], ms, live=True), datetime.fromtimestamp(ms / 1000, timezone.utc))
        ms = times[upto]
        ptf = eb.ptf_from_rows(ds["klines"], kb, ds["sk"], ms, live=True)
        coins = set(kb["wallets"]["1000"])
        sub = {tf: {s: v for s, v in ser.items() if s in coins} for tf, ser in ptf.items()}
        _CACHE[key] = (kb, dict(kb, accounts=[1000]), sub, datetime.fromtimestamp(ms / 1000, timezone.utc), store.data)
    return _CACHE[key]


@unittest.skipUnless(HAVE, "немає наборів C2.1")
class PaperStepContract(unittest.TestCase):
    def test_signature_and_wrapper_are_compatible(self):
        S = eb.engine()
        self.assertEqual(list(inspect.signature(S.paper_step).parameters), ["st", "events", "ctx", "ptf", "kb", "now", "books"])
        self.assertEqual(list(inspect.signature(S.paper_update).parameters), ["ptf", "kb", "now", "tag"], "старий інтерфейс обгортки не змінено")
        self.assertEqual(list(inspect.signature(S.paper_wallets).parameters), ["ptf", "kb", "now"])
        self.assertEqual(inspect.signature(S.paper_update).parameters["tag"].default, "")

    def test_step_does_not_touch_files_network_or_engine_io_functions(self):
        S = eb.engine()
        kb, kb1, sub, now, data = _kit()
        st, ev = data["_paper"], data["paper_events"]

        def boom(*a, **k):
            raise AssertionError("paper_step звернувся до вводу-виводу")
        with mock.patch.object(S, "load", boom), mock.patch.object(S, "write_json", boom), mock.patch.object(S, "outlook_context", boom), \
                mock.patch.object(builtins, "open", boom), mock.patch.object(os, "replace", boom), mock.patch.object(socket.socket, "connect", boom), \
                mock.patch.object(os, "makedirs", boom):
            new_st, new_ev, res = S.paper_step(st, ev, {}, sub, kb1, now)
        self.assertTrue(new_st["strategies"] and res["strategies"])

    def test_step_does_not_mutate_inputs(self):
        S = eb.engine()
        kb, kb1, sub, now, data = _kit()
        st, ev = copy.deepcopy(data["_paper"]), copy.deepcopy(data["paper_events"])
        ctx = {}
        before = datasets.sha({"st": st, "ev": ev, "ptf": sub, "kb": kb1, "ctx": ctx})
        S.paper_step(st, ev, ctx, sub, kb1, now)
        after = datasets.sha({"st": st, "ev": ev, "ptf": sub, "kb": kb1, "ctx": ctx})
        self.assertEqual(before, after, "paper_step змінив вхідні дані")

    def test_step_is_repeatable_and_has_no_hidden_state(self):
        S = eb.engine()
        kb, kb1, sub, now, data = _kit()
        a = S.paper_step(data["_paper"], data["paper_events"], {}, sub, kb1, now)
        b = S.paper_step(data["_paper"], data["paper_events"], {}, sub, kb1, now)
        self.assertEqual(datasets.sha(a), datasets.sha(b))
        # поради кроку не залежить від глобальної BOOKS, якщо книги передано явно
        with mock.patch.dict(S.BOOKS, {"BTC": {"bids": [(1.0, 1.0)], "asks": [(2.0, 1.0)]}}):
            c = S.paper_step(data["_paper"], data["paper_events"], {}, sub, kb1, now, {})
        self.assertEqual(datasets.sha(a), datasets.sha(c), "явні порожні книги мають повністю ігнорувати глобальну BOOKS")

    def test_wrapper_equals_pure_step_and_writes_same_json(self):
        S = eb.engine()
        kb, kb1, sub, now, data = _kit()
        want_st, want_ev, want_res = S.paper_step(data["_paper"], data["paper_events"], {}, sub, kb1, now)
        store = eb.MemStore(copy.deepcopy(data))
        with eb.patched(store, books={}, outlook={}):
            res = S.paper_update(sub, kb1, now)
        self.assertEqual(datasets.sha(json.loads(json.dumps(want_res))), datasets.sha(json.loads(json.dumps(res))))
        self.assertEqual(datasets.sha(json.loads(json.dumps(want_st))), datasets.sha(store.data["_paper"]))
        self.assertEqual(datasets.sha(json.loads(json.dumps(want_ev))), datasets.sha(store.data["paper_events"]))
        self.assertEqual(store.writes, 2, "обгортка пише рівно два файли: стан і журнал")

    def test_wrapper_order_load_state_then_context_then_events_then_write_state_then_events(self):
        S = eb.engine()
        kb, kb1, sub, now, data = _kit()
        log = []
        store = eb.MemStore(copy.deepcopy(data))
        ld, wr = store.load, store.write_json
        with eb.patched(store, books={}, outlook={}):
            S.load = lambda n: (log.append(("load", n)), ld(n))[1]
            S.write_json = lambda n, o: (log.append(("write", n)), wr(n, o))[1]
            S.outlook_context = lambda: (log.append(("ctx",)), {})[1]
            S.paper_update(sub, kb1, now, tag="_100")
        self.assertEqual(log, [("load", "_paper_100"), ("ctx",), ("load", "paper_events_100"), ("write", "_paper_100.json"), ("write", "paper_events_100.json")])

    def test_old_state_version_and_empty_state_paths_match_wrapper(self):
        S = eb.engine()
        kb, kb1, sub, now, data = _kit()
        old = copy.deepcopy(data["_paper"])
        old["v"] = 1
        st, ev, res = S.paper_step(old, copy.deepcopy(data["paper_events"]), {}, sub, kb1, now)
        self.assertEqual(st["v"], S.STATE_V)
        self.assertIn("history", st)
        st0, ev0, res0 = S.paper_step({}, {}, {}, sub, kb1, now)
        self.assertEqual(st0["v"], S.STATE_V)
        self.assertTrue(all(len(v) <= S.EVENTS_PER_RULE for v in ev0.values()))
        self.assertIn("round", res0)


@unittest.skipUnless(HAVE, "немає наборів C2.1")
class CostsBooksArgument(unittest.TestCase):
    def setUp(self):
        self.S = eb.engine()
        self.kb = copy.deepcopy(ds_of("D8")["kb"])
        self.real = eb.books_from_snapshot({"books": ds_of("D8")["books"]})
        self._saved = dict(self.S.BOOKS)
        self.S.BOOKS.clear()

    def tearDown(self):
        self.S.BOOKS.clear()
        self.S.BOOKS.update(self._saved)

    def test_old_interface_still_works_and_reads_global_books(self):
        S = self.S
        self.assertEqual(list(inspect.signature(S.Costs.__init__).parameters), ["self", "kb", "cap", "books"])
        c = S.Costs(self.kb, 1000)
        self.assertEqual(c.slip_of("BTC", "BUY", 1000), self.kb.get("slippage", 0.0), "без книги — фіксоване проковзання")
        S.BOOKS.update(self.real)
        a = c.slip_of("BTC", "BUY", 1000)
        self.assertNotEqual(a, self.kb.get("slippage", 0.0), "книга з глобальної BOOKS (як було), навіть якщо з'явилась після створення Costs")
        self.assertEqual(a, S.Costs(self.kb, 1000, self.real).slip_of("BTC", "BUY", 1000))

    def test_explicit_books_equal_global_books_on_whole_grid(self):
        S = self.S
        explicit = S.Costs(self.kb, 1000, self.real)
        S.BOOKS.update(self.real)
        legacy = S.Costs(self.kb, 1000)
        n = 0
        for sym in sorted(self.real):
            for side in ("BUY", "SELL"):
                for usd in (1, 10, 33.3333, 100, 333.33, 1000, 3333.33, 10000, 100000, 1e6, 1e9):
                    self.assertEqual(explicit.slip_of(sym, side, usd), legacy.slip_of(sym, side, usd))
                    for w, eq in ((1.0, 1.0), (0.25, 1.07), (0.1, 0.93)):
                        self.assertEqual(explicit(sym, side, w, eq), legacy(sym, side, w, eq))
                    n += 1
        self.assertGreater(n, 150)

    def test_explicit_books_do_not_read_global_and_empty_means_no_book(self):
        S = self.S
        S.BOOKS.update(self.real)
        c = S.Costs(self.kb, 1000, {})
        for sym in self.real:
            self.assertEqual(c.slip_of(sym, "BUY", 1000), self.kb.get("slippage", 0.0), "books={} = «книги немає», глобальна BOOKS ігнорується")
        S.BOOKS.clear()
        own = S.Costs(self.kb, 1000, self.real)
        self.assertNotEqual(own.slip_of("BTC", "BUY", 1000), self.kb.get("slippage", 0.0), "явні книги працюють за порожньої глобальної BOOKS")

    def test_fee_is_point_one_percent_plus_slippage(self):
        S = self.S
        self.assertEqual(self.kb["fee"], 0.001, "комісія в конфігурації 0,1 %")
        books = {"BTC": {"bids": [(99.9, 10.0)], "asks": [(100.1, 10.0)]}}
        c = S.Costs(self.kb, 100, books)
        slip = c.slip_of("BTC", "BUY", 100)
        self.assertAlmostEqual(slip, 0.001, places=9, msg="ордер повністю на найкращій ціні: 100.1 проти середньої 100")
        self.assertAlmostEqual(c("BTC", "BUY", 1.0, 1.0), 0.001 + slip, places=12)
        self.assertAlmostEqual(c.slip_of("BTC", "SELL", 100), 0.001, places=9)
        # ордер = cap·w·eq: 100·0.5·2 = 100 $
        self.assertAlmostEqual(c("BTC", "BUY", 0.5, 2.0), 0.001 + slip, places=12)

    def test_slippage_grows_with_size_and_walks_the_book(self):
        S = self.S
        books = {"X": {"bids": [(100.0, 100.0)], "asks": [(100.1, 1.0), (100.5, 1000.0)]}}
        small, big = S.Costs(self.kb, 100, books).slip_of("X", "BUY", 100), S.Costs(self.kb, 10000, books).slip_of("X", "BUY", 10000)
        self.assertGreater(big, small)
        mid = (100.0 + 100.1) / 2
        usd = 10000.0
        take1 = 1.0 * 100.1
        qty = 1.0 + (usd - take1) / 100.5
        self.assertAlmostEqual(big, abs(usd / qty / mid - 1), places=12, msg="ордер «проходить» рівні книги")

    def test_not_enough_depth_gives_one_percent(self):
        S = self.S
        books = {"BTC": {"bids": [(99.9, 10.0)], "asks": [(100.1, 0.5)]}}                 # у книзі ≈ 50 $
        c = S.Costs(self.kb, 100, books)
        self.assertEqual(c.slip_of("BTC", "BUY", 100), 0.01)
        self.assertAlmostEqual(c("BTC", "BUY", 1.0, 1.0), 0.001 + 0.01, places=12)
        self.assertEqual(S.Costs(self.kb, 1000, self.real).slip_of("BTC", "BUY", 1e12), 0.01, "ордер, більший за всю книгу")

    def test_missing_or_empty_book_side_uses_fixed_slippage(self):
        S = self.S
        fixed = dict(self.kb, slippage=0.0005)
        for books in ({}, {"BTC": {"bids": [], "asks": [(1.0, 1.0)]}}, {"BTC": {"bids": [(1.0, 1.0)], "asks": []}}, {"ETH": {"bids": [(1.0, 1.0)], "asks": [(1.1, 1.0)]}}):
            self.assertEqual(S.Costs(fixed, 1000, books).slip_of("BTC", "BUY", 500), 0.0005, str(books))
        self.assertEqual(S.Costs(fixed, 1000).slip_of("BTC", "BUY", 500), 0.0005)

    def test_minimum_order(self):
        S = self.S
        kb = dict(self.kb, min_order_usd=10)
        c = S.Costs(kb, 100, {})
        self.assertTrue(c.can_open(0.1))                  # 10 $ рівно
        self.assertFalse(c.can_open(0.0999))
        self.assertFalse(c.can_open(0.1, 0.99))
        self.assertTrue(c.can_open(0.1, 1.0))
        self.assertTrue(S.Costs(dict(kb, min_order_usd=0), 100, {}).can_open(0.0001), "min_order_usd=0: обмежень немає")
        self.assertEqual(S.Costs(kb, 100, {}).can_open(0.05), S.Costs(kb, 100).can_open(0.05), "книга на мінімальний ордер не впливає")

    def test_books_argument_is_not_mutated_and_not_copied(self):
        S = self.S
        books = copy.deepcopy(self.real)
        before = datasets.sha(books)
        c = S.Costs(self.kb, 10000, books)
        for sym in books:
            c.slip_of(sym, "BUY", 5000)
            c.slip_of(sym, "SELL", 5000)
        self.assertEqual(before, datasets.sha(books))
        self.assertIs(c.books, books)


class EngineSourceTripwire21(unittest.TestCase):
    """Хеші коду після R1/R2: paper_step, обгортка paper_update, Costs. Майбутня зміна (R3–R5) має свідомо оновити tests/golden/c21/engine_hashes.json (UPDATE_GOLDEN=1)
    лише після того, як усі еталонні тести пройшли без змін еталонів."""

    def test_r1_r2_source_hashes(self):
        import hashlib
        S = eb.engine()
        cur = {n: hashlib.sha256(inspect.getsource(getattr(S, n)).encode("utf-8")).hexdigest() for n in ("paper_step", "paper_update", "paper_wallets", "Costs")}
        path = os.path.join(c21.GOLDEN_DIR, "engine_hashes.json")
        if os.environ.get("UPDATE_GOLDEN") == "1" or not os.path.exists(path):
            os.makedirs(c21.GOLDEN_DIR, exist_ok=True)
            with open(path, "w", encoding="utf-8") as f:
                json.dump(cur, f, indent=1, sort_keys=True)
        with open(path, encoding="utf-8") as f:
            gold = json.load(f)
        self.assertEqual(sorted(k for k in cur if gold.get(k) != cur[k]), [], "код paper_step/paper_update/Costs змінено після R1/R2")


if __name__ == "__main__":
    unittest.main()
