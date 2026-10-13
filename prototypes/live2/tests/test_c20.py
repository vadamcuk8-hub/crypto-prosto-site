"""C2.0: еталонні тести ПЕРЕД рефакторингом R1/R2. Мета: після будь-якої зміни `agent_simulation.py` автоматично виявити зміну поведінки.

Що перевіряється (усі еталони отримані з ЧИННОГО рушія без зміни його коду, в окремому процесі й тимчасовій папці):
  • цілісність вхідних даних (SHA-256 канонічного JSON) і покриття (≥ 7 діб, незалежні вікна);
  • ланцюжок відбитків стану й результату на КОЖНОМУ кроці відтворення для кожного варіанта (локалізує перший крок розбіжності);
  • підсумкові файли, таблиця 48 рахунків, сітка витрат Costs на реальних книгах;
  • збіг тіні (той самий рушій у пам'яті, вхід зібраний іншою реалізацією) з еталоном на кожному кроці;
  • інваріанти по всіх 48 рахунках; окремо setup_live, setup_dip, random_1h; поведінка останньої (відкритої) свічки;
  • детермінізм між процесами (PYTHONHASHSEED), продовження з непорожнього стану, ротація раундів, гілка одиночного рахунку.

Запуск (з prototypes/live2):  PYTHONPATH=. .venv\\Scripts\\python -m unittest tests.test_c20 -v
Швидкий режим: C20_FAST=1 (лише D1, D2r, D1n).
Тест хешів коду рушія (EngineSourceTripwire) ОЧІКУВАНО падає після R1/R2: коміт рефакторингу має свідомо оновити tests/golden/engine_hashes.json (UPDATE_GOLDEN=1);
усі тести групи BehaviourGolden після R1/R2 мають пройти БЕЗ жодних змін еталонів."""
import copy
import inspect
import json
import os
import random
import sys
import unittest
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)

from live2 import c20, compare, datasets  # noqa: E402
from live2 import engine_bridge as eb  # noqa: E402
from live2.shadow import ShadowEngine  # noqa: E402

FAST = os.environ.get("C20_FAST") == "1"
DATASETS = ["D1", "D2", "D3", "D4", "D5", "D6"]
VARIANTS = ["D1", "D2r", "D1n"] if FAST else list(c20.VARIANTS)
HAVE = os.path.isdir(datasets.C20_DIR) and all(os.path.isdir(os.path.join(datasets.C20_DIR, d)) for d in DATASETS)
SCANNERS = ("setup_live", "setup_dip")
ALL_RULES = ["strong", "lean", "trend", "trend_1h", "score_1h", "trend_inv", "strong_inv", "trend_1h_inv", "trend_1h_sl", "trend_1h_vol", "random_1h", "trend_2h", "trend_1h_band", "trend_30m_band", "setup_live", "setup_dip"]
_REF, _SHD, _DS = {}, {}, {}


def ds_of(name):
    if name not in _DS:
        _DS[name] = datasets.load(name)
    return _DS[name]


def golden(variant):
    with open(c20.golden_path(variant), encoding="utf-8") as f:
        return json.load(f)


def reference(variant):
    if variant not in _REF:
        out = os.path.join(eb.STATE_DIR, "_test_c20_" + variant)
        _REF[variant] = c20.run_reference(variant, out)
    return _REF[variant]


def shadow(variant):
    if variant not in _SHD:
        _SHD[variant] = c20.run_shadow(variant, ds_of(c20.VARIANTS[variant]["dataset"]))
    return _SHD[variant]


def first_diff(a, b):
    for i, (x, y) in enumerate(zip(a, b)):
        if x != y:
            return i
    return None if len(a) == len(b) else min(len(a), len(b))


@unittest.skipUnless(HAVE, "немає наборів даних C2.0: fixtures/c20 (live2.datasets.capture)")
class DataIntegrityTests(unittest.TestCase):
    def test_input_checksums_match_manifest(self):
        for name in DATASETS:
            self.assertEqual(datasets.verify_integrity(ds_of(name)), [], "вхідні дані %s змінені" % name)

    def test_coverage_at_least_seven_days_in_independent_windows(self):
        wins = sorted((ds_of(n)["meta"]["end_ms"] - int(ds_of(n)["meta"]["eval_hours"] * 3600000), ds_of(n)["meta"]["end_ms"], n) for n in DATASETS)
        # об'єднане покриття (перекриття, напр. D4 із D3, рахується один раз)
        union, cur_s, cur_e = 0, None, None
        for s_, e_, _ in wins:
            if cur_e is None or s_ > cur_e:
                if cur_e is not None:
                    union += cur_e - cur_s
                cur_s, cur_e = s_, e_
            else:
                cur_e = max(cur_e, e_)
        union += cur_e - cur_s
        self.assertGreaterEqual(union / 3600000.0, 7 * 24, "об'єднане покриття, годин")
        # не менше трьох попарно незалежних (непересічних) наборів
        disjoint, last_end = [], None
        for s_, e_, n in wins:
            if last_end is None or s_ >= last_end:
                disjoint.append(n)
                last_end = e_
        self.assertGreaterEqual(len(disjoint), 3, "попарно непересічні набори: %s" % disjoint)

    def test_real_data_only_no_holes_and_full_windows(self):
        for name in DATASETS:
            ds = ds_of(name)
            self.assertEqual(ds["meta"]["gaps"], {}, "у %s є пропуски свічок (реальні дірки мали б бути зафіксовані)" % name)
            t0 = datasets.eval_times(ds["meta"])[0]
            for key, rows in ds["klines"].items():
                ts = [r[0] for r in rows]
                self.assertEqual(ts, sorted(set(ts)), key)
                self.assertTrue(all(isinstance(r[1], float) and r[1] > 0 for r in rows), key)
                tf = key.split("|")[1]
                if tf != "1m":
                    self.assertGreaterEqual(sum(1 for t in ts if t <= t0), min(1000, 259 + 60), "достатня історія на початок оцінювання: " + key)
            self.assertGreaterEqual(sum(1 for r in ds["klines"]["BTC|15m"] if r[0] <= t0), 1000, "не менше 1000 свічок 15m на перший момент оцінювання: рушій бере рівно останні 1000, як справжній REST-запит")

    def test_config_and_books_are_frozen_in_dataset(self):
        ds = ds_of("D4")
        self.assertIsNotNone(ds["books"])
        self.assertEqual(sorted(ds["books"]), sorted(ds["kb"]["paper_coins"]))
        self.assertEqual(len(ds["kb"]["strategies"]), 16)
        self.assertEqual(ds_of("D1")["books"], None, "історичних книг заявок не існує: набори без книг не вигадують їх")

    def test_step_times_are_deterministic(self):
        for name in DATASETS:
            ts = datasets.eval_times(ds_of(name)["meta"])
            self.assertTrue(all(b - a == 20 * 60000 for a, b in zip(ts, ts[1:])))


@unittest.skipUnless(HAVE, "немає наборів даних C2.0")
class BehaviourGolden(unittest.TestCase):
    """ГРУПА, ЩО МАЄ ПРОХОДИТИ БЕЗ ЗМІН ПІСЛЯ R1/R2."""

    def test_reference_chain_matches_golden_at_every_step(self):
        for v in VARIANTS:
            ref, data = reference(v)
            g = golden(v)
            sh = [s["state_sha"] for s in ref["steps"]]
            rs = [s["result_sha"] for s in ref["steps"]]
            i = first_diff(sh, g["step_state_sha256"])
            self.assertIsNone(i, "%s: поведінка рушія змінилась, перший крок розбіжності стану: %s (час %s)" % (v, i, ref["steps"][i]["now_ms"] if i is not None and i < len(ref["steps"]) else "?"))
            j = first_diff(rs, g["step_result_sha256"])
            self.assertIsNone(j, "%s: змінився результат paper_wallets на кроці %s" % (v, j))
            self.assertEqual(len(sh), g["n_steps"])
            rec = c20.record(v, ref, data, ds_of(c20.VARIANTS[v]["dataset"]))
            self.assertEqual(rec["final_state_sha256"], g["final_state_sha256"], v + ": підсумковий стан")
            self.assertEqual(rec["final_files_sha256"], g["final_files_sha256"], v + ": файли")
            self.assertEqual(rec["accounts_table_sha256"], g["accounts_table_sha256"], v + ": таблиця 48 рахунків")
            self.assertEqual(rec["input_sha256"], g["input_sha256"], v + ": вхідні дані")
            self.assertEqual(rec["kb_effective_sha256"], g["kb_effective_sha256"], v + ": конфігурація")
            self.assertEqual(rec["initial_state_sha256"], g["initial_state_sha256"], v + ": початковий стан")

    def test_accounts_table_values_unchanged(self):
        for v in VARIANTS:
            ref, data = reference(v)
            t = c20.account_table(data, variant_kb(v))
            self.assertEqual(t, golden(v)["accounts_table"], v)
            self.assertEqual(len(t), 48 if v != "D1n" else 16, v)

    def test_engine_writes_exactly_the_expected_files(self):
        for v in VARIANTS:
            ref, data = reference(v)
            want = ["_paper.json", "paper_events.json"] if v == "D1n" else ["_paper.json", "_paper_100.json", "_paper_10000.json", "paper_events.json", "paper_events_100.json", "paper_events_10000.json"]
            self.assertEqual(sorted(ref["written_files"]), sorted(want), v)

    def test_costs_grid_on_real_books_unchanged(self):
        g = c20.costs_grid()
        with open(os.path.join(c20.GOLDEN_DIR, "costs_grid.json"), encoding="utf-8") as f:
            gold = json.load(f)
        self.assertEqual(datasets.sha(g), gold["grid_sha256"])
        self.assertEqual(g, gold["grid"], "Costs(kb, cap): комісія, проковзання з книги (у т. ч. «тонка книга» 1 %), мінімальний ордер")

    def test_costs_contract_survives_optional_books_argument(self):
        """R2 додає необов'язковий аргумент: старий виклик Costs(kb, cap) і методи мають працювати так само."""
        S = eb.engine()
        sig = inspect.signature(S.Costs.__init__)
        params = list(sig.parameters)
        self.assertEqual(params[:3], ["self", "kb", "cap"])
        for extra in params[3:]:
            self.assertIsNot(sig.parameters[extra].default, inspect.Parameter.empty, "додатковий параметр %s має бути необов'язковим" % extra)
        for name in ("slip_of", "can_open", "__call__"):
            self.assertTrue(hasattr(S.Costs, name))
        self.assertEqual(list(inspect.signature(S.paper_update).parameters), ["ptf", "kb", "now", "tag"], "контракт paper_update")
        self.assertEqual(list(inspect.signature(S.paper_wallets).parameters), ["ptf", "kb", "now"], "контракт paper_wallets")

    def test_shadow_equals_reference_at_every_step(self):
        for v in VARIANTS:
            ref, rdata = reference(v)
            shd, sdata = shadow(v)
            self.assertEqual([s["state_sha"] for s in shd["steps"]], [s["state_sha"] for s in ref["steps"]], v)
            self.assertEqual([s["result_sha"] for s in shd["steps"]], [s["result_sha"] for s in ref["steps"]], v)
            self.assertEqual(compare.diff(rdata, sdata, caps=compare.CAPS if v != "D1n" else (1000,)), [], v)

    def test_continuation_from_saved_state_equals_uninterrupted_run(self):
        if "D3w" not in VARIANTS:
            self.skipTest("швидкий режим")
        self.assertEqual(golden("D3w")["final_state_sha256"], golden("D3")["final_state_sha256"], "продовження з непорожнього стану (стан після 24 год) дає той самий підсумок, що й безперервний прогін")

    def test_round_rollover_is_covered(self):
        g = golden("D2r")
        self.assertEqual({r["history_rounds"] for r in g["accounts_table"]}, {3}, "три завершені раунди в архіві рушія")
        self.assertTrue(all(r["round_start"] and r["round_end"] for r in g["accounts_table"]))


@unittest.skipUnless(HAVE, "немає наборів даних C2.0")
class StrategyCoverageTests(unittest.TestCase):
    def collect(self):
        cov, exits = {r: 0 for r in ALL_RULES}, {r: {} for r in ALL_RULES}
        buys, sells = {r: 0 for r in ALL_RULES}, {r: 0 for r in ALL_RULES}
        for v in [x for x in VARIANTS if x not in ("D1n", "D2r", "D3w")] or VARIANTS:
            for row in golden(v)["accounts_table"]:
                r = row["rule"]
                cov[r] += row["buys"] + row["sells"]
                buys[r] += row["buys"]
                sells[r] += row["sells"]
                for k, n in row["exit_reasons"].items():
                    exits[r][k] = exits[r].get(k, 0) + n
        return cov, exits, buys, sells

    def test_all_16_strategies_and_48_accounts_present(self):
        for v in VARIANTS:
            rows = golden(v)["accounts_table"]
            if v == "D1n":
                self.assertEqual(sorted({r["rule"] for r in rows}), sorted(ALL_RULES))
                continue
            self.assertEqual(len(rows), 48)
            self.assertEqual({(r["wallet"], r["rule"]) for r in rows}, {(w, r) for w in compare.CAPS for r in ALL_RULES})

    def test_every_strategy_trades_somewhere_in_the_datasets(self):
        if FAST:
            self.skipTest("швидкий режим")
        cov, exits, buys, sells = self.collect()
        for r in ALL_RULES:
            self.assertGreater(buys[r], 0, "%s: немає жодної купівлі в наборах" % r)
            self.assertGreater(sells[r], 0, "%s: немає жодного продажу в наборах" % r)

    def test_exit_reasons_covered(self):
        if FAST:
            self.skipTest("швидкий режим")
        cov, exits, buys, sells = self.collect()
        self.assertTrue({"stop", "take"} <= set(exits["trend_1h_sl"]), exits["trend_1h_sl"])
        self.assertTrue({"stop", "take", "trail", "trend"} <= set(exits["setup_live"]), exits["setup_live"])
        self.assertTrue({"stop", "take"} <= set(exits["setup_dip"]), exits["setup_dip"])
        self.assertIn("signal", exits["random_1h"])
        for r in ALL_RULES:
            if r not in SCANNERS and r != "trend_1h_sl":
                self.assertEqual(set(exits[r]) - {"signal"}, set(), "%s: сторонні причини виходу %s" % (r, exits[r]))
        for r in ("setup_live",):
            self.assertNotIn("signal", exits[r])


@unittest.skipUnless(HAVE, "немає наборів даних C2.0")
class InvariantTests(unittest.TestCase):
    def test_account_invariants_in_every_variant(self):
        for v in VARIANTS:
            ref, data = reference(v)
            ds = ds_of(c20.VARIANTS[v]["dataset"])
            caps = compare.CAPS if v != "D1n" else (1000,)
            for cap in caps:
                st = data["_paper" + compare.tag_of(cap)]
                evs = data["paper_events" + compare.tag_of(cap)]
                for rid, sd in st["strategies"].items():
                    ts = [p[0] for p in sd["curve"]]
                    self.assertEqual(ts, sorted(set(ts)), "%s %s %s: крива строго за зростанням часу" % (v, cap, rid))
                    self.assertTrue(all(p[1] > 0 and p[2] > 0 for p in sd["curve"]), "equity і hold додатні")
                    self.assertGreaterEqual(sd["trades"], len(evs.get(rid, [])) - 0 if sd["trades"] >= len(evs.get(rid, [])) else 0)
                    last_by_coin = {}
                    seen = set()
                    rstart = st["round"]["start"]                                       # BUY/SELL чергуються лише в межах поточного раунду (новий раунд скидає позиції)
                    for e in [x for x in evs.get(rid, []) if x["at"] >= rstart]:
                        key = (e["coin"], e["side"], e["candle"], e["at"], e["price"])
                        self.assertNotIn(key, seen, "%s %s %s: дубль події" % (v, cap, rid))
                        seen.add(key)
                        prev = last_by_coin.get(e["coin"])
                        if prev is not None:
                            self.assertNotEqual(prev, e["side"], "%s %s %s %s: BUY/SELL чергуються" % (v, cap, rid, e["coin"]))
                        last_by_coin[e["coin"]] = e["side"]
                        self.assertGreater(e["eq"], 0)
                        self.assertGreater(e["price"], 0)
                        self.assertIn(e["side"], ("BUY", "SELL"))
                        if e["side"] == "SELL":
                            self.assertIn(e["exit"], ("signal", "stop", "take", "trail", "trend"))
                    for coin, x in sd["coins"].items():                                # позиція збігається з останньою подією (якщо журнал не обрізано)
                        if len(evs.get(rid, [])) < 40 and coin in last_by_coin:
                            self.assertEqual(bool(x["pos"]), last_by_coin[coin] == "BUY", "%s %s %s %s" % (v, cap, rid, coin))
                    last = sd["last"]
                    self.assertEqual(last[0], ts[-1])
                    # equity рахунку = Σ w·eq за монетами (формула рушія): перевірка
                    s = round(sum(sd["w"].get(sym, 0) * x["eq"] * 1.0 for sym, x in sd["coins"].items()), 5)
                    self.assertAlmostEqual(last[1], s, delta=0.08, msg="%s %s %s: eq рахунку ≈ Σ w·eq (оцінка за живою ціною може відрізнятися)" % (v, cap, rid))

    def test_fees_and_fractions_are_consistent(self):
        for v in VARIANTS:
            for r in golden(v)["accounts_table"]:
                self.assertGreaterEqual(r["fees_usd"], 0)
                self.assertGreater(r["equity_fraction"], 0)
                self.assertLessEqual(r["max_drawdown"], 0)


@unittest.skipUnless(HAVE, "немає наборів даних C2.0")
class ScannerAndRandomTests(unittest.TestCase):
    def test_scanner_cooldown_and_exit_info(self):
        for v in [x for x in VARIANTS if x in ("D1", "D2", "D3", "D4", "D5", "D6")] or ["D1"]:
            ref, data = reference(v)
            for cap in compare.CAPS:
                evs = data["paper_events" + compare.tag_of(cap)]
                for rid in SCANNERS:
                    by_coin = {}
                    for e in evs.get(rid, []):
                        by_coin.setdefault(e["coin"], []).append(e)
                    for coin, lst in by_coin.items():
                        for a, b in zip(lst, lst[1:]):
                            if a["side"] == "SELL" and b["side"] == "BUY":
                                ta = datetime.fromisoformat(a["at"])
                                tb = datetime.fromisoformat(b["at"])
                                self.assertGreaterEqual((tb - ta).total_seconds(), 30 * 60, "%s %s %s %s: пауза 30 хв після виходу" % (v, cap, rid, coin))
                        for e in lst:
                            if e["side"] == "SELL" and e["exit"] in ("stop", "take", "trail"):
                                info = e.get("exit_info")
                                self.assertIsNotNone(info, "exit_info для стоп-виходу")
                                self.assertEqual(info["kind"], e["exit"])
                                self.assertEqual(info["check"], "software")

    def test_random_rule_is_deterministic_and_independent_of_global_rng(self):
        S = eb.engine()
        rule = next(r for r in ds_of("D1")["kb"]["strategies"] if r["id"] == "random_1h")
        keys = [("BTC", 1790000000000 + i * 3600000) for i in range(400)]
        base = [(S.decide(rule, 1, False, None, None, None, k), S.decide(rule, 1, True, None, None, None, k)) for k in keys]
        random.seed(12345)
        random.random()
        random.shuffle(keys)
        again = {k: (S.decide(rule, 1, False, None, None, None, k), S.decide(rule, 1, True, None, None, None, k)) for k in keys}
        self.assertEqual(again, dict(zip([("BTC", 1790000000000 + i * 3600000) for i in range(400)], base)))
        enter = sum(1 for a, b in base if a)
        self.assertTrue(5 <= enter <= 50, "частота входу ≈ 6%% (%d з 400)" % enter)

    def test_determinism_across_processes_and_hash_seeds(self):
        """Той самий набір, інший PYTHONHASHSEED → ті самі відбитки (random_1h не залежить від хеш-рандомізації процесу)."""
        import subprocess
        g = golden("D1")
        for seed in ("1", "424242"):
            env = dict(os.environ, PYTHONHASHSEED=seed)
            out = os.path.join(eb.STATE_DIR, "_test_c20_seed" + seed)
            cmd = [sys.executable, "-B", "-m", "live2.reference_c20", "--dataset", "D1", "--out", out, "--to-step", "60"]
            r = subprocess.run(cmd, cwd=HERE, capture_output=True, text=True, env=env, timeout=900)
            self.assertEqual(r.returncode, 0, r.stderr[-300:])
            steps = json.loads(r.stdout.strip().splitlines()[-1])["steps"]
            self.assertEqual([s["state_sha"] for s in steps], g["step_state_sha256"][:60], "PYTHONHASHSEED=" + seed)


def variant_kb(v):
    return c20.variant_kb(ds_of(c20.VARIANTS[v]["dataset"]), c20.VARIANTS[v])


@unittest.skipUnless(HAVE, "немає наборів даних C2.0")
class UnclosedCandleTests(unittest.TestCase):
    """Остання свічка кожного ряду — ПОТОЧНА (відкрита): її «закриття» — жива ціна. Рушій приймає свічкові рішення лише за закритими (len−2),
    а останній елемент використовує для оцінки рахунку й для сканерів."""

    def test_last_row_of_every_series_is_open_and_closed_candles_are_before_it(self):
        ds = ds_of("D2")
        kb, sk = ds["kb"], ds["sk"]
        for now_ms in datasets.eval_times(ds["meta"])[::37]:
            ptf = eb.ptf_from_rows(ds["klines"], kb, sk, now_ms, live=True)
            for tf, by in ptf.items():
                for sym, (c, t, sc, s50) in by.items():
                    self.assertLess(now_ms - t[-1], eb.TF_MS[tf], "%s %s: остання свічка відкрита на момент оцінювання" % (sym, tf))
                    self.assertGreaterEqual(now_ms, t[-1])
                    self.assertEqual(len(c), 1000 if len(ds["klines"]["%s|%s" % (sym, tf)]) >= 1000 and tf != "1d" else len(c))
                    self.assertEqual(len(c), len(t))
                    m1 = ds["klines"]["%s|1m" % sym]
                    live = [r[1] for r in m1 if r[0] + 60000 <= now_ms][-1]
                    self.assertEqual(c[-1], live, "закриття відкритої свічки = жива ціна (остання закрита хвилина ≤ now): без заглядання вперед")

    def perturbed(self, ptf, delta):
        S = eb.engine()
        sk = ds_of("D2")["sk"]
        out = {}
        for tf, by in ptf.items():
            out[tf] = {}
            for sym, (c, t, sc, s50) in by.items():
                c2 = list(c)
                c2[-1] = c2[-1] * (1 + delta)
                sc2, s502 = S.scores_series(c2, sk["weights"], sk["thresholds"])
                out[tf][sym] = (c2, t, sc2, s502)
        return out

    def test_closed_candle_rules_ignore_live_price_for_decisions_but_scanners_do_not(self):
        ds = ds_of("D2")
        kb, sk = ds["kb"], ds["sk"]
        times = datasets.eval_times(ds["meta"])
        main = ShadowEngine(kb=kb, sk=sk, books={})
        scanner_changed = {+0.03: 0, -0.03: 0}
        valued_changed = 0
        checked = 0
        for i, now_ms in enumerate(times[:121]):
            ptf = eb.ptf_from_rows(ds["klines"], kb, sk, now_ms, live=True)
            if i >= 6 and i % 6 == 0:
                before = json.loads(json.dumps(main.store.data))
                base = ShadowEngine(kb=kb, sk=sk, store=eb.MemStore(json.loads(json.dumps(before))), books={})
                base.step(ptf, datetime.fromtimestamp(now_ms / 1000, timezone.utc))
                for delta in (+0.03, -0.03):
                    alt = ShadowEngine(kb=kb, sk=sk, store=eb.MemStore(json.loads(json.dumps(before))), books={})
                    alt.step(self.perturbed(ptf, delta), datetime.fromtimestamp(now_ms / 1000, timezone.utc))
                    for cap in compare.CAPS:
                        tag = compare.tag_of(cap)
                        sa, sb = base.store.data["_paper" + tag]["strategies"], alt.store.data["_paper" + tag]["strategies"]
                        ea, eb_ = base.store.data["paper_events" + tag], alt.store.data["paper_events" + tag]
                        for rid in sa:
                            pos_a = {k: (x["pos"], x.get("entry"), x.get("blocked"), x.get("t")) for k, x in sa[rid]["coins"].items()}
                            pos_b = {k: (x["pos"], x.get("entry"), x.get("blocked"), x.get("t")) for k, x in sb[rid]["coins"].items()}
                            if rid in SCANNERS:
                                if pos_a != pos_b or ea.get(rid) != eb_.get(rid):
                                    scanner_changed[delta] += 1
                            else:
                                self.assertEqual(pos_a, pos_b, "крок %d %s %s: рішення за закритою свічкою не залежать від живої ціни" % (i, cap, rid))
                                self.assertEqual(ea.get(rid), eb_.get(rid), "крок %d %s %s: події не залежать від живої ціни" % (i, cap, rid))
                                if sa[rid]["last"][1] != sb[rid]["last"][1]:
                                    valued_changed += 1
                    checked += 1
            main.step(ptf, datetime.fromtimestamp(now_ms / 1000, timezone.utc))
        self.assertGreater(checked, 15)
        self.assertGreater(valued_changed, 0, "оцінка рахунку (equity) залежить від живої ціни")
        self.assertGreater(scanner_changed[+0.03] + scanner_changed[-0.03], 0, "сканери реагують на живу ціну")

    def test_initial_position_entry_uses_live_price_of_open_candle(self):
        ds = ds_of("D1")
        kb, sk = ds["kb"], ds["sk"]
        t0 = datasets.eval_times(ds["meta"])[0]
        ptf = eb.ptf_from_rows(ds["klines"], kb, sk, t0, live=True)
        sh = ShadowEngine(kb=kb, sk=sk, books={})
        sh.step(ptf, datetime.fromtimestamp(t0 / 1000, timezone.utc))
        found = 0
        for cap in compare.CAPS:
            evs = sh.store.data["paper_events" + compare.tag_of(cap)]
            st = sh.store.data["_paper" + compare.tag_of(cap)]["strategies"]
            for rid, lst in evs.items():
                for e in lst:
                    if "Початкова позиція" in e["reason"]:
                        tf = {r["id"]: r["tf"] for r in kb["strategies"]}[rid]
                        live = ptf[tf][e["coin"]][0][-1]
                        self.assertEqual(e["price"], live, "%s %s %s: стартова ціна = жива ціна відкритої свічки" % (cap, rid, e["coin"]))
                        found += 1
        self.assertGreater(found, 5)


class EngineSourceTripwire(unittest.TestCase):
    """ОЧІКУВАНО падає після R1/R2: свідомо оновіть tests/golden/engine_hashes.json (UPDATE_GOLDEN=1) у коміті рефакторингу,
    але лише ПІСЛЯ того, як усі тести BehaviourGolden пройшли без змін еталонів."""

    def test_engine_source_hashes(self):
        import hashlib
        S = eb.engine()
        from agents import agent_signals as SG
        objs = {"agent_simulation." + n: getattr(S, n) for n in ("paper_update", "paper_wallets", "setup_step", "setup_entry", "setup_exit", "decide", "Costs", "make_event", "exit_info", "volatility_weights", "scores_series", "explain")}
        objs.update({"agent_signals." + n: getattr(SG, n) for n in ("indicators", "score_of", "ema_series", "sma", "rsi", "macd_hist")})
        cur = {k: hashlib.sha256(inspect.getsource(v).encode("utf-8")).hexdigest() for k, v in objs.items()}
        with open(os.path.join(HERE, "tests", "golden", "engine_hashes.json"), encoding="utf-8") as f:
            gold = json.load(f)
        self.assertEqual(sorted(k for k in cur if gold.get(k) != cur[k]), [], "код рушія змінено: спершу перевірте BehaviourGolden")


if __name__ == "__main__":
    unittest.main(verbosity=2)
