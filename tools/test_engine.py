#!/usr/bin/env python3
"""Тести торгового рушія (tools/agents/agent_simulation.py) на синтетичних свічках: без мережі, без Node.js, без запису у справжні дані.

  python tools/test_engine.py

Тести ФІКСУЮТЬ ПОТОЧНУ поведінку рушія (вони писалися до будь-яких змін алгоритму й проходять на старій версії), крім блоку «НОВЕ» наприкінці:
вага «просто тримати» для стратегії з розміром позиції за мінливістю та поле exit_info у стоп-виходах.
Незалежний «еталон» нижче рахує рахунок звичайним циклом за формулами з документації рушія й порівнюється з результатом paper_update.

Для порівняння зі старою копією: ENGINE_ROOT=<папка з agents/> python tools/test_engine.py"""
import json
import os
import random
import shutil
import sys
import tempfile
from datetime import datetime, timedelta, timezone

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

TOOLS = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(TOOLS)
TMP = tempfile.mkdtemp(prefix="enginetest_")
os.environ["CRYPTO_DATA_DIR"] = TMP
sys.path.insert(0, os.environ.get("ENGINE_ROOT") or TOOLS)
sys.dont_write_bytecode = True

from agents import agent_simulation as S    # noqa: E402
from agents import common as C              # noqa: E402

with open(os.path.join(ROOT, "knowledge", "signals.json"), encoding="utf-8") as f:
    SK = json.load(f)
with open(os.path.join(ROOT, "knowledge", "simulation.json"), encoding="utf-8") as f:
    SIM_KB = json.load(f)

FEE = 0.001 + 0.0005                      # комісія + запасне проковзання (книги заявок у тестах немає)
BASE_T = 1_700_000_000_000
HOUR = 3600_000
T0 = datetime(2026, 10, 12, 12, 0, tzinfo=timezone.utc)
passed = failed = 0


# ---------- інструменти ----------
def use_dir(path):
    os.makedirs(path, exist_ok=True)
    S.DATA = C.DATA = path
    S.BOOKS.clear()


def reset():
    for n in os.listdir(TMP):
        p = os.path.join(TMP, n)
        shutil.rmtree(p) if os.path.isdir(p) else os.remove(p)
    use_dir(TMP)


def get(name, d=None):
    with open(os.path.join(d or TMP, name), encoding="utf-8") as f:
        return json.load(f)


def series(c, step=HOUR):
    """Ряд монети в форматі рушія: (ціни, час відкриття, оцінки, SMA50). Останній елемент: поточна НЕзакрита свічка."""
    t = [BASE_T + i * step for i in range(len(c))]
    scores, s50 = S.scores_series(c, SK["weights"], SK["thresholds"])
    return (c, t, scores, s50)


def kbase(rules, cap=1000, **kw):
    d = {"fee": 0.001, "slippage": 0.0005, "accounts": [cap], "round_days": 7, "history_rounds": 6, "curve_points": 1100, "strategies": rules, "min_order_usd": 10}
    d.update(kw)
    return d


def rule_trend(**kw):
    d = {"id": "t", "title": "t", "kind": "sma50", "tf": "1h"}
    d.update(kw)
    return d


def call(kb, per_coin, tf="1h", step=HOUR, minutes=0, tag="", extra_tf=None):
    ptf = {tf: {sym: series(c, step) for sym, c in per_coin.items()}}
    if extra_tf:
        ptf.update(extra_tf)
    return S.paper_update(ptf, kb, T0 + timedelta(minutes=minutes), tag=tag)


def events(rid="t", d=None, name="paper_events.json"):
    return get(name, d).get(rid, [])


def sma(P, k, n=50):
    return sum(P[k - n + 1:k + 1]) / n


def walk(seed, n_flat=260, n=140, sigma=0.012):
    r = random.Random(seed)
    P = [100.0] * n_flat
    for _ in range(n):
        P.append(P[-1] * (1 + r.gauss(0, sigma)))
    return P


def reference(P, j1, jl, fee=FEE):
    """Незалежний еталон: перший запуск на довжині ряду j1+1 (останній елемент незакритий), останній: на jl+1. Повертає (eq, [(k, 'BUY'/'SELL')], trades)."""
    s = j1 - 1
    pos = P[s] > sma(P, s)
    eq, ev, trades = (1 - fee if pos else 1.0), [], 1 if pos else 0
    if pos:
        ev.append((s, "BUY"))
    sp = P[j1]
    for k in range(j1, jl):
        eq *= (P[k] / (sp if k == j1 else P[k - 1])) if pos else 1.0
        want = P[k] > sma(P, k)
        if want != pos:
            eq *= 1 - fee
            pos = want
            trades += 1
            ev.append((k, "BUY" if want else "SELL"))
    if pos:
        eq *= P[jl] / P[jl - 1] if jl > j1 else P[jl] / sp
    return eq, ev, trades


def test(name):
    def deco(fn):
        global passed, failed
        reset()
        try:
            fn()
            passed += 1
            print("  ok  " + name)
        except Exception as ex:      # noqa: BLE001
            failed += 1
            import traceback
            print("  ПРОВАЛ  %s: %s: %s" % (name, type(ex).__name__, ex))
            if os.environ.get("TRACE"):
                traceback.print_exc()
        return fn
    return deco


def near(a, b, tol=2e-5):
    assert abs(a - b) <= tol, (a, b)


# =====================================================================
# 1. Купівля, продаж, вартість рахунку: порівняння з еталоном
# =====================================================================
@test("BUY/SELL, комісії й вартість рахунку збігаються з незалежним еталоном (покроково по 3 свічки)")
def _():
    P = walk(42)
    j1, jl = 268, 399
    kb = kbase([rule_trend()])
    m = 0
    prev = []
    for j in list(range(j1, jl + 1, 3)) + ([jl] if (jl - j1) % 3 else []):
        res = call(kb, {"BTC": P[:j + 1]}, minutes=10 * m)
        m += 1
        cur = events()
        assert cur[:len(prev)] == prev, "історія подій змінилась заднім числом"
        prev = cur
    eq_ref, ev_ref, trades_ref = reference(P, j1, jl)
    st = res["strategies"]["t"]
    near(st["eq"], eq_ref, 3e-5)
    assert st["trades"] == trades_ref, (st["trades"], trades_ref)
    got = [((e["candle"] - BASE_T) // HOUR, e["side"]) for e in events()]
    assert got == [(k, s) for k, s in ev_ref if s != "BUY" or k != j1 - 1] or got == ev_ref or [g for g in got if g[0] != j1 - 1] == [r for r in ev_ref if r[0] != j1 - 1], (got, ev_ref)
    assert trades_ref >= 3, "сценарій має містити кілька угод: %d" % trades_ref


@test("немає повторного відкриття: сторони чергуються, BUY−SELL ∈ {0,1}, trades = кількість подій")
def _():
    for seed in (1, 2, 3):
        reset()
        P = walk(seed)
        kb = kbase([rule_trend()])
        for m, j in enumerate(range(268, 400, 4)):
            res = call(kb, {"BTC": P[:j + 1]}, minutes=10 * m)
        ev = events()
        sides = [e["side"] for e in ev]
        assert all(a != b for a, b in zip(sides, sides[1:])), sides
        assert res["strategies"]["t"]["trades"] == len(ev)
        assert (sides.count("BUY") - sides.count("SELL")) in (0, 1)
        assert (sides[-1] == "BUY") == (res["strategies"]["t"]["state"]["BTC"][0] == 1)


@test("повторний виклик з тими самими свічками не додає подій і не змінює рахунок (ідемпотентність)")
def _():
    P = walk(42)
    kb = kbase([rule_trend()])
    for m, j in enumerate(range(268, 380, 6)):
        r1 = call(kb, {"BTC": P[:j + 1]}, minutes=10 * m)
    n1, eq1, tr1 = len(events()), r1["strategies"]["t"]["eq"], r1["strategies"]["t"]["trades"]
    r2 = call(kb, {"BTC": P[:j + 1]}, minutes=10 * (m + 1))
    assert len(events()) == n1 and r2["strategies"]["t"]["trades"] == tr1
    near(r2["strategies"]["t"]["eq"], eq1, 1e-9)


@test("відновлення після перезапуску: пропуск кількох свічок дає ті самі події й рахунок, що й покрокова робота")
def _():
    P = walk(7)
    kb = kbase([rule_trend()])
    a, b = os.path.join(TMP, "a"), os.path.join(TMP, "b")
    use_dir(a)
    for m, j in enumerate(range(268, 400)):
        ra = call(kb, {"BTC": P[:j + 1]}, minutes=10 * m)
    use_dir(b)
    call(kb, {"BTC": P[:269]}, minutes=0)
    rb = call(kb, {"BTC": P[:400]}, minutes=10)                        # «агент спав» 130 свічок
    ea, eb = events(d=a), events(d=b)
    strip = lambda l: [(e["coin"], e["side"], e["candle"], e["price"], e["eq"]) for e in l]
    assert strip(ea) == strip(eb) and ra["strategies"]["t"]["trades"] == rb["strategies"]["t"]["trades"]
    near(ra["strategies"]["t"]["eq"], rb["strategies"]["t"]["eq"], 3e-5)


@test("стан зберігається у файлі: новий процес (свіжий імпорт стану з диска) продовжує, а не починає раунд заново")
def _():
    P = walk(5)
    kb = kbase([rule_trend()])
    call(kb, {"BTC": P[:300]}, minutes=0)
    st1 = get("_paper.json")
    call(kb, {"BTC": P[:320]}, minutes=10)
    st2 = get("_paper.json")
    assert st2["round"] == st1["round"] and st2["strategies"]["t"]["coins"]["BTC"]["t"] > st1["strategies"]["t"]["coins"]["BTC"]["t"]
    assert len(st2["strategies"]["t"]["curve"]) == 2


@test("державний вимір: ваги монет у сумі 1, останній запис кривої = поточна вартість, кожна монета має окремий «рукав»")
def _():
    P = walk(11)
    kb = kbase([rule_trend()])
    res = call(kb, {"BTC": P[:350], "ETH": P[:350], "SOL": P[:350]})
    st = res["strategies"]["t"]
    near(sum(v[4] for v in st["state"].values()), 1.0, 2e-4)
    assert st["curve"][-1][1] == st["eq"] and st["curve"][-1][2] == st["hold"]
    assert set(st["state"]) == {"BTC", "ETH", "SOL"}


# =====================================================================
# 2. Мінімальний ордер, достатність капіталу
# =====================================================================
@test("мінімальний ордер: частка 100 $ / 12 монет < 10 $ — угоди немає навіть при сигналі; 9 монет (11,1 $) — купує")
def _():
    P = [100.0] * 260 + [100.0 + i for i in range(1, 41)]                  # впевнено вище SMA50
    coins12 = {"C%d" % i: P for i in range(12)}
    r = call(kbase([rule_trend()], cap=100), coins12)
    assert r["strategies"]["t"]["trades"] == 0 and r["strategies"]["t"]["open"] == [] and events() == []
    reset()
    coins9 = {"C%d" % i: P for i in range(9)}
    r = call(kbase([rule_trend()], cap=100), coins9)
    assert r["strategies"]["t"]["trades"] == 9 and len(r["strategies"]["t"]["open"]) == 9


@test("Costs.can_open: поріг включно, враховує поточну вартість «рукава» (після збитків менше мінімуму: не відкриває)")
def _():
    c = S.Costs(kbase([]), 100)
    assert c.can_open(0.1, 1.0) and not c.can_open(0.1, 0.99) and c.can_open(1 / 3) and not c.can_open(0.05)
    assert S.Costs(dict(kbase([]), min_order_usd=0), 100).can_open(0.0001)


@test("достатність капіталу: купівля завжди на весь «рукав» (eq_після = eq_до·(1−комісія)), eq завжди > 0, продаж ніколи не збільшує його понад ціну")
def _():
    P = walk(3, sigma=0.03)
    kb = kbase([rule_trend()])
    for m, j in enumerate(range(268, 400, 4)):
        res = call(kb, {"BTC": P[:j + 1]}, minutes=10 * m)
    ev = events()
    assert len(ev) >= 4
    for e in ev:
        assert e["eq"] > 0 and 0 < e["w"] <= 1 and 0 <= e["cost"] < 0.01
    assert res["strategies"]["t"]["eq"] > 0


# =====================================================================
# 3. Комісії й проковзання
# =====================================================================
@test("витрати: без книги = комісія + запасне проковзання; з книгою: комісія + реальне проковзання за середньою ціною проходу ордера")
def _():
    c = S.Costs(kbase([]), 100)
    near(c("BTC", "BUY", 1.0, 1.0), 0.0015, 1e-12)
    S.BOOKS["BTC"] = {"bids": [(99.9, 10.0)], "asks": [(100.1, 10.0)]}
    near(c.slip_of("BTC", "BUY", 100), 0.001, 1e-9)                         # середня ціна 100.1 проти середини 100.0
    near(c.slip_of("BTC", "SELL", 100), 0.001, 1e-9)
    near(c("BTC", "BUY", 1.0, 1.0), 0.001 + 0.001, 1e-9)
    S.BOOKS["BTC"] = {"bids": [(99.9, 10.0)], "asks": [(100.1, 0.5)]}      # у книзі лише ≈ 50 $: 100 $ не вміщається
    assert c.slip_of("BTC", "BUY", 100) == 0.01
    S.BOOKS.clear()


@test("більший ордер проходить глибше по книзі й коштує дорожче; розмір ордера = депозит · вага · вартість «рукава»")
def _():
    S.BOOKS["X"] = {"bids": [(100.0, 100.0)], "asks": [(100.1, 1.0), (100.5, 1000.0)]}
    small, big = S.Costs(kbase([]), 100).slip_of("X", "BUY", 100), S.Costs(kbase([]), 10000).slip_of("X", "BUY", 10000)
    assert big > small > 0
    c = S.Costs(kbase([]), 10000)
    near(c("X", "BUY", 0.5, 0.8), 0.001 + c.slip_of("X", "BUY", 10000 * 0.5 * 0.8), 1e-12)
    S.BOOKS.clear()


@test("комісія списується однаково з обох сторін угоди: еквіті після кола = (1−c)^2 · (ціна_виходу/ціна_входу)")
def _():
    P = [100.0] * 260 + [100.0 + 0.5 * i for i in range(40)] + [120.0] * 2
    kb = kbase([rule_trend()])
    call(kb, {"BTC": P[:301]}, minutes=0)
    P2 = P + [90.0] * 3
    res = call(kb, {"BTC": P2[:len(P2)]}, minutes=10)
    ev = events()
    assert [e["side"] for e in ev] == ["BUY", "SELL"], [e["side"] for e in ev]
    buy_px, sell_px = ev[0]["price"], ev[1]["price"]
    near(ev[1]["eq"], (1 - FEE) * (sell_px / buy_px) * (1 - FEE), 5e-5)


# =====================================================================
# 4. Свічки: майбутнє й незакриті
# =====================================================================
@test("немає використання майбутніх свічок: оцінка й SMA50 на свічці k однакові на повному ряді й на ряді, обрізаному на k")
def _():
    P = walk(1, n=420)
    sc, s50 = S.scores_series(P, SK["weights"], SK["thresholds"])
    for k in range(260, 680, 31):
        sc2, s502 = S.scores_series(P[:k + 1], SK["weights"], SK["thresholds"])
        assert sc2[k] == sc[k] and abs(s502[k] - s50[k]) < 1e-9, k


@test("додавання майбутніх свічок не міняє вже ухвалені рішення (події попередніх запусків — префікс пізніших)")
def _():
    P = walk(42)
    kb = kbase([rule_trend()])
    call(kb, {"BTC": P[:300]}, minutes=0)
    call(kb, {"BTC": P[:330]}, minutes=10)
    ev_mid = events()
    call(kb, {"BTC": P[:399]}, minutes=20)
    assert events()[:len(ev_mid)] == ev_mid


@test("незакрита свічка: різка зміна її ціни не змінює рішень і подій, змінює лише оцінку рахунку «на зараз»")
def _():
    P = walk(42)
    a, b = os.path.join(TMP, "a"), os.path.join(TMP, "b")
    kb = kbase([rule_trend()])
    outs = []
    for d, factor in ((a, 1.0), (b, 1.35)):
        use_dir(d)
        call(kb, {"BTC": P[:300]}, minutes=0)
        c = list(P[:340])
        c[-1] = c[-1] * factor                                           # остання свічка ще не закрита
        outs.append(call(kb, {"BTC": c}, minutes=10)["strategies"]["t"])
    strip = lambda l: [(e["side"], e["candle"], e["price"], e["eq"]) for e in l]
    assert strip(events(d=a)) == strip(events(d=b)), "рішення залежать від незакритої свічки"
    assert outs[0]["trades"] == outs[1]["trades"] and outs[0]["state"]["BTC"][0] == outs[1]["state"]["BTC"][0]
    if outs[0]["state"]["BTC"][0] == 1:
        assert outs[1]["eq"] > outs[0]["eq"]                             # у позиції рахунок рухається разом із живою ціною
    else:
        near(outs[0]["eq"], outs[1]["eq"], 1e-9)


@test("перший запуск раунду: рішення за останньою ЗАКРИТОЮ свічкою (len−2), ціна старту: жива (len−1)")
def _():
    P = [100.0] * 260 + [100.0 + i for i in range(1, 31)]               # закрита свічка вище SMA50 → стартова позиція
    c = P + [200.0]                                                      # жива ціна далеко від закритої
    res = call(kbase([rule_trend()]), {"BTC": c})
    ev = events()
    assert len(ev) == 1 and ev[0]["side"] == "BUY" and ev[0]["price"] == 200.0 and ev[0]["candle"] == BASE_T + (len(c) - 2) * HOUR
    assert "Початкова позиція" in ev[0]["reason"]
    near(res["strategies"]["t"]["state"]["BTC"][1], 1 - FEE, 1e-5)


# =====================================================================
# 5. Правила: пороги, дзеркала, буфер, пауза
# =====================================================================
@test("decide(): SMA50 прямий/дзеркальний/з буфером; оцінка з порогами входу й виходу (гістерезис)")
def _():
    c, s50 = [0, 101.0], [0, 100.0]
    assert S.decide({"kind": "sma50"}, 1, False, None, s50, c) is True
    assert S.decide({"kind": "sma50", "invert": True}, 1, False, None, s50, c) is False
    band = {"kind": "sma50", "band": 0.25}
    c2 = [0, 100.2]
    assert S.decide(band, 1, False, None, s50, c2) is False and S.decide(band, 1, True, None, s50, c2) is True          # вище SMA, але менше за буфер: не входимо, але й не виходимо
    c3 = [0, 99.7]
    assert S.decide(band, 1, True, None, s50, c3) is False and S.decide(band, 1, True, None, s50, [0, 99.8]) is True
    r = {"kind": "score", "enter": 30, "exit": 15}
    assert S.decide(r, 1, False, [0, 30], None, None) and not S.decide(r, 1, False, [0, 29], None, None)
    assert S.decide(r, 1, True, [0, 15], None, None) and not S.decide(r, 1, True, [0, 14], None, None)
    inv = dict(r, invert=True)
    assert S.decide(inv, 1, False, [0, -30], None, None) and not S.decide(inv, 1, False, [0, -29], None, None)
    assert S.decide(inv, 1, True, [0, -15], None, None) and not S.decide(inv, 1, True, [0, -14], None, None)


@test("правило «random»: відтворюване від id правила й ключа свічки, без індикаторів")
def _():
    r = {"id": "rr", "kind": "random", "p_enter": 0.06, "p_exit": 0.1}
    a = [S.decide(r, 0, False, None, None, None, ("BTC", k)) for k in range(500)]
    b = [S.decide(r, 0, False, None, None, None, ("BTC", k)) for k in range(500)]
    assert a == b and 5 <= sum(a) <= 60, sum(a)


@test("пауза після продажу (cooldown): вхід блокується на задану кількість свічок")
def _():
    P = [100.0] * 260 + [100.0 + i for i in range(1, 11)] + [100.0] * 5 + [110.0] * 5
    kb = kbase([rule_trend(cooldown=3)])
    call(kb, {"BTC": P[:271]}, minutes=0)                                # старт: у позиції
    res = call(kb, {"BTC": P}, minutes=10)
    sides = [(e["side"], (e["candle"] - BASE_T) // HOUR) for e in events()]
    sells = [k for s, k in sides if s == "SELL"]
    buys = [k for s, k in sides if s == "BUY" and k > 270]
    assert sells, sides
    if buys:
        assert buys[0] - sells[0] > 3, (sides)


# =====================================================================
# 6. Stop Loss / Take Profit за поточною реалізацією
# =====================================================================
def sl_series(path):
    """260 плоских свічок, розгін до 110 (вище SMA50 ≈ 101) і далі заданий шлях закриттів."""
    return [100.0] * 260 + [100.0 + i for i in range(1, 11)] + list(path)


@test("стоп-лос: спрацьовує на ЗАКРИТТІ свічки, коли рух ≤ −stop і сигнал каже «лишатись»; запис про причину й чекання нового сигналу")
def _():
    rule = rule_trend(id="sl", stop=2, take=4)
    kb = kbase([rule])
    base = sl_series([110.0])
    call(kb, {"BTC": base + [110.0]}, minutes=0)                          # старт у позиції, ціна входу 110
    c2 = base + [109.0, 107.7, 110.0, 110.0]                              # 107.7 = −2.09 % від входу, SMA50 ≈ 101: вище неї
    res = call(kb, {"BTC": c2}, minutes=10)
    ev = events("sl")
    assert [e["side"] for e in ev] == ["BUY", "SELL"], [e["side"] for e in ev]
    assert ev[1]["exit"] == "stop" and ev[1]["price"] == 107.7 and "Стоп-лос" in ev[1]["reason"]
    st = res["strategies"]["sl"]
    assert st["state"]["BTC"][0] == 0, "після стопу позиція закрита"


@test("після стопу немає негайної повторної купівлі: чекаємо, поки сигнал зникне й з'явиться знову")
def _():
    rule = rule_trend(id="sl", stop=2, take=4)
    kb = kbase([rule])
    base = sl_series([110.0])
    call(kb, {"BTC": base + [110.0]}, minutes=0)
    path = [107.7] + [110.0] * 5                                          # стоп і далі ціна знову вище SMA: купувати не можна
    call(kb, {"BTC": base + path + [110.0]}, minutes=10)
    assert [e["side"] for e in events("sl")] == ["BUY", "SELL"]
    path2 = path + [90.0] * 3 + [112.0] * 3                               # сигнал зник (нижче SMA) і з'явився знову → нова купівля
    call(kb, {"BTC": base + path2 + [112.0]}, minutes=20)
    assert [e["side"] for e in events("sl")] == ["BUY", "SELL", "BUY"], [e["side"] for e in events("sl")]


@test("тейк-профіт: спрацьовує на закритті, коли рух ≥ +take")
def _():
    rule = rule_trend(id="sl", stop=2, take=4)
    kb = kbase([rule])
    base = sl_series([110.0])
    call(kb, {"BTC": base + [110.0]}, minutes=0)
    call(kb, {"BTC": base + [112.0, 114.6, 114.6]}, minutes=10)           # +4.18 %
    ev = events("sl")
    assert [e["side"] for e in ev] == ["BUY", "SELL"] and ev[1]["exit"] == "take" and ev[1]["price"] == 114.6


@test("стоп на закритті, а не на порозі: різкий провал вище SMA виконується за ціною закриття (фактичний збиток більший за поріг)")
def _():
    rule = rule_trend(id="sl", stop=2, take=4)
    kb = kbase([rule])
    base = sl_series([110.0])
    call(kb, {"BTC": base + [110.0]}, minutes=0)
    call(kb, {"BTC": base + [103.0, 103.0]}, minutes=10)
    sell = [e for e in events("sl") if e["side"] == "SELL"][0]
    assert sell["exit"] == "stop" and sell["price"] == 103.0               # −6.4 % від входу, поріг 2 %
    near(sell["eq"], (1 - FEE) * (103.0 / 110.0) * (1 - FEE), 5e-5)


@test("різке падіння нижче SMA: вихід за сигналом правила (exit=signal), а не за стопом; рахунок скінченний і додатний")
def _():
    rule = rule_trend(id="sl", stop=2, take=4)
    kb = kbase([rule])
    base = sl_series([110.0])
    call(kb, {"BTC": base + [110.0]}, minutes=0)
    res = call(kb, {"BTC": base + [55.0, 55.0]}, minutes=10)              # −50 % за свічку
    sell = [e for e in events("sl") if e["side"] == "SELL"][0]
    assert sell["exit"] == "signal" and sell["price"] == 55.0
    near(sell["eq"], (1 - FEE) * 0.5 * (1 - FEE), 5e-5)
    assert 0 < res["strategies"]["sl"]["eq"] < 1


@test("різкий стрибок угору й вниз: рахунок скінченний, без NaN, у позиції рухається пропорційно ціні")
def _():
    kb = kbase([rule_trend()])
    P = [100.0] * 260 + [100.0 + i for i in range(1, 11)]
    call(kb, {"BTC": P + [110.0]}, minutes=0)
    res = call(kb, {"BTC": P + [110.0, 220.0, 220.0]}, minutes=10)       # +100 %
    st = res["strategies"]["t"]
    assert st["state"]["BTC"][0] == 1 and st["eq"] == st["eq"] and st["eq"] > 1.9 * (1 - FEE)
    res = call(kb, {"BTC": P + [110.0, 220.0, 11.0, 11.0]}, minutes=20)  # −95 %
    assert 0 < res["strategies"]["t"]["eq"] < 1.0


@test("Stop Loss/Take Profit не діють, якщо у правила їх немає (немає прихованого стопу)")
def _():
    kb = kbase([rule_trend(id="plain")])
    base = sl_series([110.0])
    call(kb, {"BTC": base + [110.0]}, minutes=0)
    call(kb, {"BTC": base + [103.0, 103.0]}, minutes=10)
    assert [e["side"] for e in events("plain")] == ["BUY"]


# =====================================================================
# 7. Правила-«сканери» (setup): окремі умови
# =====================================================================
SETUP = {"id": "s", "kind": "setup", "tf": "15m", "confirm_tf": "1h", "band": 0.1, "rsi_min": 40, "rsi_max": 68, "stop": 1.5, "take": 3, "trail": 1.0, "trail_start": 0.6, "cooldown_min": 30}
DIP = {"id": "d", "kind": "setup", "tf": "15m", "confirm_tf": "1h", "mode": "dip", "dip": 0.15, "rsi_min": 30, "rsi_max": 55, "stop": 1.2, "take": 1.2, "cooldown_min": 30}


def ind(price, sma50, rsi=50.0):
    return {"price": price, "sma50": sma50, "sma200": sma50, "rsi": rsi, "macd": 0.0, "mom30": 0.0}


@test("setup_entry (вхід за трендом): кожна умова окремо блокує вхід; усі разом: дозволяють")
def _():
    P, s15, s1h = 101.0, 100.0, 100.0
    up = [100.0] * 4 + [99.0, 100.0]
    ok = S.setup_entry(SETUP, P, ind(P, s15), ind(P, s1h, 50), [90.0, 95.0, 96.0, 97.0, 98.0, 100.0, P])
    assert ok
    assert S.setup_entry(SETUP, 100.05, ind(100.05, s15), ind(100.05, s1h), [90] * 6 + [100.05]) is None     # менше за 15-хв середню + 0,1 %
    assert S.setup_entry(SETUP, P, ind(P, 100.0), ind(P, 102.0), [90] * 6 + [P]) is None                    # нижче годинної середньої
    assert S.setup_entry(SETUP, P, ind(P, s15), ind(P, s1h, 39), [90] * 6 + [P]) is None                    # RSI нижче 40
    assert S.setup_entry(SETUP, P, ind(P, s15), ind(P, s1h, 69), [90] * 6 + [P]) is None                    # RSI вище 68
    assert S.setup_entry(SETUP, P, ind(P, s15), ind(P, s1h), [102.0] * 7) is None                          # за останню годину ціна не росла
    assert S.setup_entry(SETUP, P, ind(P, s15), ind(P, s1h), [90.0, P]) is None                             # замало свічок


@test("setup_entry (відкат): тренд угору на годині, ціна нижче 15-хв середньої на dip, RSI 30–55")
def _():
    s15, s1h = 100.0, 99.0
    P = 99.8
    assert S.setup_entry(DIP, P, ind(P, s15), ind(P, s1h, 45), [100.0] * 7)
    assert S.setup_entry(DIP, 99.9, ind(99.9, s15), ind(99.9, s1h, 45), [100.0] * 7) is None                 # відкат менший за 0,15 %
    assert S.setup_entry(DIP, 98.5, ind(98.5, s15), ind(98.5, 99.0, 45), [100.0] * 7) is None               # годинний тренд не угору
    assert S.setup_entry(DIP, P, ind(P, s15), ind(P, s1h, 56), [100.0] * 7) is None
    assert S.setup_entry(DIP, P, ind(P, s15), ind(P, s1h, 29), [100.0] * 7) is None


@test("setup_exit: стоп-лос > тейк-профіт > трейлінг > злам тренду (порядок перевірок), поріг включно")
def _():
    co = {"entry": 100.0, "peak": 100.0}
    assert S.setup_exit(SETUP, co, 98.5, 99.0)[1] == "stop"                                                  # рівно −1,5 %
    assert S.setup_exit(SETUP, co, 98.6, None) is None
    assert S.setup_exit(SETUP, co, 103.0, None)[1] == "take"
    assert S.setup_exit(SETUP, {"entry": 100.0, "peak": 100.8}, 99.7, None)[1] == "trail"                    # пік +0,8 %, відкат −1,09 %
    assert S.setup_exit(SETUP, {"entry": 100.0, "peak": 100.5}, 99.4, None) is None                          # пік менший за trail_start
    assert S.setup_exit(SETUP, co, 99.0, 100.5)[1] == "trend"                                                 # нижче 15-хв середньої мінус буфер
    assert S.setup_exit(DIP, co, 99.0, 100.5) is None                                                         # у режимі відкату злам тренду не перевіряється


def setup_call(kb, n_extra, price_last, minutes, patch=True):
    c15 = [100.0] * 300
    c15 = c15[:-5] + [99.0, 99.5, 100.0, 100.5, 101.0]
    c15 = c15 + n_extra
    c15[-1] = price_last
    c1h = [100.0] * 270 + [101.0]
    c1h[-1] = price_last
    return S.paper_update({"15m": {"BTC": series(c15, 900_000)}, "1h": {"BTC": series(c1h, HOUR)}}, kb, T0 + timedelta(minutes=minutes))


@test("сканер: вхід одразу за живою ціною, стоп 1,5 % за закриттям, пауза 30 хв після виходу, потім новий вхід")
def _():
    real = S.indicators
    S.indicators = lambda c: ind(c[-1], c[-1] * 0.99 if len(c) > 290 else c[-1] * 0.985, 50.0)     # завжди «умови зійшлись»
    try:
        kb = kbase([SETUP])
        setup_call(kb, [], 101.0, 0)
        ev = events("s")
        assert [e["side"] for e in ev] == ["BUY"] and ev[0]["price"] == 101.0
        near(get("_paper.json")["strategies"]["s"]["coins"]["BTC"]["eq"], 1 - FEE, 1e-5)
        res = setup_call(kb, [98.4], 98.4, 10)                                                      # −2,57 %: нижче стопу
        ev = events("s")
        assert [e["side"] for e in ev] == ["BUY", "SELL"] and ev[1]["exit"] == "stop"
        setup_call(kb, [98.4, 102.0], 102.0, 20)                                                    # умови входу знову зійшлись, але пауза ще триває (вихід о 10-й хв, пауза до 40-ї)
        assert [e["side"] for e in events("s")] == ["BUY", "SELL"], "вхід під час паузи"
        setup_call(kb, [98.4, 102.0, 103.0], 103.0, 45)
        assert [e["side"] for e in events("s")] == ["BUY", "SELL", "BUY"], [e["side"] for e in events("s")]
    finally:
        S.indicators = real


@test("сканер не відкриває угоду, якщо ордер менший за мінімальний (100 $ / 20 монет)")
def _():
    real = S.indicators
    S.indicators = lambda c: ind(c[-1], c[-1] * 0.99 if len(c) > 290 else c[-1] * 0.985, 50.0)
    try:
        kb = kbase([SETUP], cap=100)
        c15 = [100.0] * 295 + [99.0, 99.5, 100.0, 100.5, 101.0]
        c1h = [100.0] * 270 + [101.0]
        ptf15 = {"C%d" % i: series(c15, 900_000) for i in range(20)}
        ptf1h = {"C%d" % i: series(c1h, HOUR) for i in range(20)}
        res = S.paper_update({"15m": ptf15, "1h": ptf1h}, kb, T0)
        assert res["strategies"]["s"]["trades"] == 0 and events("s") == []
    finally:
        S.indicators = real


# =====================================================================
# 8. Три гаманці, раунди
# =====================================================================
@test("paper_wallets: три незалежні гаманці зі своїми монетами, файлами стану й журналами; середній — у корені")
def _():
    P = walk(42)
    ptf = {"1h": {s: series(P[:350]) for s in ("BTC", "ETH", "BNB", "XRP", "LINK")}}
    kb = kbase([rule_trend()], accounts=[100, 1000, 10000], wallets={"100": ["BTC", "ETH"], "1000": ["BNB", "XRP"], "10000": ["LINK"]})
    res = S.paper_wallets(ptf, kb, T0)
    assert os.path.exists(os.path.join(TMP, "_paper.json")) and os.path.exists(os.path.join(TMP, "_paper_100.json")) and os.path.exists(os.path.join(TMP, "_paper_10000.json"))
    assert set(res["strategies"]["t"]["state"]) == {"BNB", "XRP"} and res["wallet_coins"] == {"100": ["BTC", "ETH"], "1000": ["BNB", "XRP"], "10000": ["LINK"]}
    assert set(res["wallets"]["100"]["strategies"]["t"]["state"]) == {"BTC", "ETH"} and set(res["wallets"]["10000"]["strategies"]["t"]["state"]) == {"LINK"}


@test("раунд завершується: підсумок потрапляє в history, стан скидається, нові позиції відкриваються заново")
def _():
    P = walk(42)
    kb = kbase([rule_trend()], round_days=7)
    call(kb, {"BTC": P[:350]}, minutes=0)
    res = call(kb, {"BTC": P[:360]}, minutes=8 * 24 * 60)
    h = res["history"]
    assert len(h) == 1 and "t" in h[0]["strategies"] and h[0]["capital"] == [1000]
    assert get("_paper.json")["round"]["start"] != h[0]["start"]


# =====================================================================
# 9. НОВЕ (3.3.2): Buy & Hold з тими самими вагами, структуровані дані про стоп
# =====================================================================
def two_coin_paths():
    A = [100.0] * 260 + [100.0 + i for i in range(1, 31)]
    B = [100.0 + (i % 2) * 6 * (1 if i % 3 else -1) for i in range(260)] + [100.0 + i for i in range(1, 31)]      # мінлива монета
    return A, B


@test("НОВЕ: B&H для sizing=vol рахується з тими самими початковими вагами, що й стратегія")
def _():
    A, B = two_coin_paths()
    rule = rule_trend(id="v", sizing="vol")
    kb = kbase([rule])
    res = call(kb, {"A": A + [A[-1]], "B": B + [B[-1]]}, minutes=0)
    w = {s: res["strategies"]["v"]["state"][s][4] for s in ("A", "B")}
    assert abs(w["A"] - 0.5) > 0.05, "ваги мають відрізнятися: %s" % w
    A2, B2 = A + [A[-1] * 1.10] * 2, B + [B[-1] * 0.90] * 2
    res = call(kb, {"A": A2, "B": B2}, minutes=10)
    st = res["strategies"]["v"]
    hold_each = {s: st["state"][s][2] for s in ("A", "B")}
    near(st["hold"], w["A"] * hold_each["A"] + w["B"] * hold_each["B"], 2e-5)
    assert abs(st["hold"] - 0.5 * (hold_each["A"] + hold_each["B"])) > 5e-4, "B&H не відрізняється від рівних ваг"


@test("НОВЕ: для рівних ваг B&H не змінився (формула та сама, що була)")
def _():
    A, B = two_coin_paths()
    kb = kbase([rule_trend(id="eq")])
    call(kb, {"A": A + [A[-1]], "B": B + [B[-1]]}, minutes=0)
    res = call(kb, {"A": A + [A[-1] * 1.1] * 2, "B": B + [B[-1] * 0.9] * 2}, minutes=10)
    st = res["strategies"]["eq"]
    near(st["hold"], 0.5 * (st["state"]["A"][2] + st["state"]["B"][2]), 2e-5)


@test("НОВЕ: рахунок, створений до виправлення (без hold_basis), лишається з рівними вагами до кінця раунду: крива «тримати» не стрибає")
def _():
    A, B = two_coin_paths()
    rule = rule_trend(id="v", sizing="vol")
    kb = kbase([rule])
    call(kb, {"A": A + [A[-1]], "B": B + [B[-1]]}, minutes=0)
    stt = get("_paper.json")
    stt["strategies"]["v"].pop("hold_basis", None)                          # імітація старого файлу стану
    with open(os.path.join(TMP, "_paper.json"), "w", encoding="utf-8") as f:
        json.dump(stt, f)
    res = call(kb, {"A": A + [A[-1] * 1.1] * 2, "B": B + [B[-1] * 0.9] * 2}, minutes=10)
    st = res["strategies"]["v"]
    near(st["hold"], 0.5 * (st["state"]["A"][2] + st["state"]["B"][2]), 2e-5)


@test("НОВЕ: стоп/тейк-вихід містить exit_info: заявлений поріг, ціна виходу, фактичний рух, позначку програмної перевірки")
def _():
    rule = rule_trend(id="sl", stop=2, take=4)
    kb = kbase([rule])
    base = sl_series([110.0])
    call(kb, {"BTC": base + [110.0]}, minutes=0)
    call(kb, {"BTC": base + [103.0, 103.0]}, minutes=10)
    sell = [e for e in events("sl") if e["side"] == "SELL"][0]
    xi = sell["exit_info"]
    assert xi["kind"] == "stop" and xi["threshold_pct"] == 2 and xi["entry"] == 110.0 and xi["exit_price"] == 103.0
    near(xi["move_pct"], -6.364, 1e-3)
    assert xi["check"] == "software" and "не біржовий стоп-ордер" in xi["note"]
    reset()
    call(kb, {"BTC": base + [110.0]}, minutes=0)
    call(kb, {"BTC": base + [55.0, 55.0]}, minutes=10)                      # вихід за сигналом: exit_info немає
    assert "exit_info" not in [e for e in events("sl") if e["side"] == "SELL"][0]


@test("НОВЕ: сканер: exit_info для стопу, тейку й трейлінгу (з піком)")
def _():
    xi = S.exit_info(SETUP, "trail", 100.0, 99.7, peak=100.8)
    assert xi["threshold_pct"] == 1.0 and xi["peak"] == 100.8 and abs(xi["from_peak_pct"] - (-1.0913)) < 1e-3 and xi["check"] == "software"
    assert S.exit_info(SETUP, "trend", 100.0, 99.0) is None and S.exit_info(SETUP, "stop", None, 99.0) is None
    real = S.indicators
    S.indicators = lambda c: ind(c[-1], c[-1] * 0.99 if len(c) > 290 else c[-1] * 0.985, 50.0)
    try:
        kb = kbase([SETUP])
        setup_call(kb, [], 101.0, 0)
        setup_call(kb, [98.4], 98.4, 10)
        sell = [e for e in events("s") if e["side"] == "SELL"][0]
        assert sell["exit_info"]["kind"] == "stop" and sell["exit_info"]["threshold_pct"] == 1.5 and sell["exit_info"]["exit_price"] == 98.4
    finally:
        S.indicators = real


@test("всі 16 правил із knowledge/simulation.json виконуються без помилок на синтетичному ринку (3 монети, 3 гаманці)")
def _():
    r = random.Random(9)
    def path(n, p=100.0):
        out = []
        for _ in range(n):
            p *= 1 + r.gauss(0, 0.004)
            out.append(p)
        return out
    P1, P15, P30, P2, P1d = path(400), path(400), path(400), path(400), path(400)
    ptf = {"1d": {s: series(path(400), 86_400_000) for s in ("BTC", "ETH", "BNB")}}
    for tf, step in (("1h", HOUR), ("2h", 2 * HOUR), ("30m", 1_800_000), ("15m", 900_000)):
        ptf[tf] = {s: series(path(400), step) for s in ("BTC", "ETH", "BNB")}
    kb = dict(SIM_KB, accounts=[100, 1000, 10000], wallets={"100": ["BTC"], "1000": ["ETH"], "10000": ["BNB"]}, first_round_end=None)
    res = S.paper_wallets(ptf, kb, T0)
    ids = {s["id"] for s in SIM_KB["strategies"]}
    assert len(ids) == 16
    for part in (res, res["wallets"]["100"], res["wallets"]["10000"]):
        assert set(part["strategies"]) == ids, ids - set(part["strategies"])
        for sid, st in part["strategies"].items():
            assert st["eq"] > 0 and st["hold"] > 0 and st["trades"] >= 0, (sid, st)


print("\nПройшло: %d, провалів: %d" % (passed, failed))
shutil.rmtree(TMP, ignore_errors=True)
sys.exit(1 if failed else 0)
