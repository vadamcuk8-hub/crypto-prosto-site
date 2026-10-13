"""Міст до ЧИННОГО торгового рушія (tools/agents/agent_simulation.py) без жодної його зміни.
Рушій імпортується лише для читання; три його точки вводу-виводу (load, write_json, outlook_context) на час виклику підміняються
сховищем у пам'яті/в prototypes/live2/state/. Тому тіньові рахунки:
  • рахуються тим самим кодом, що й основна симуляція (режим A «сумісність» без дублювання логіки);
  • не читають і не пишуть data/ та гілку data (захист: CRYPTO_DATA_DIR ще до імпорту вказується на тимчасову порожню папку).
Якщо чинний рушій зміниться, тіньовий автоматично отримає зміни; тест дрейфу (tests/test_shadow.py) це фіксує."""
import bisect
import contextlib
import copy
import json
import os
import sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))             # prototypes/live2
REPO = os.path.dirname(os.path.dirname(HERE))
TOOLS = os.path.join(REPO, "tools")
STATE_DIR = os.path.join(HERE, "state")
SANDBOX_DATA = os.path.join(STATE_DIR, "_sandbox_data")                          # порожня папка: навіть випадкове звернення рушія до DATA не торкнеться справжніх даних

_S = None


def engine():
    """Модуль чинного рушія (імпорт один раз)."""
    global _S
    if _S is None:
        os.makedirs(SANDBOX_DATA, exist_ok=True)
        os.environ["CRYPTO_DATA_DIR"] = SANDBOX_DATA                              # до імпорту agents.common
        if TOOLS not in sys.path:
            sys.path.insert(0, TOOLS)
        sys.dont_write_bytecode = True
        from agents import agent_simulation as S  # noqa: PLC0415 — імпорт відкладений навмисно
        from agents import common
        assert os.path.abspath(common.DATA) == os.path.abspath(SANDBOX_DATA), "DATA має бути пісочницею, а не data/"
        _S = S
    return _S


def load_kb():
    engine()
    from agents.common import load_knowledge
    return copy.deepcopy(load_knowledge("simulation"))


def load_signals_kb():
    engine()
    from agents.common import load_knowledge
    return copy.deepcopy(load_knowledge("signals"))


def needed_tfs(kb):
    """Масштаби свічок для паперового рахунку (без 1d, як у agent_simulation.run): основні й підтверджувальні."""
    return sorted(({r["tf"] for r in kb["strategies"]} | {r["confirm_tf"] for r in kb["strategies"] if r.get("confirm_tf")}) - {"1d"})


class MemStore:
    """Сховище файлів рушія в пам'яті. write кладе JSON-копію (як справжній файл: кортежі → списки, ключі → рядки), load віддає нову копію."""

    def __init__(self, data=None):
        self.data = data or {}
        self.writes = 0

    def load(self, name):
        v = self.data.get(name)
        return None if v is None else json.loads(json.dumps(v))

    def write_json(self, name, obj):
        key = name[:-5] if name.endswith(".json") else name
        self.data[key] = json.loads(json.dumps(obj, ensure_ascii=False))
        self.writes += 1

    def dump(self, directory):
        os.makedirs(directory, exist_ok=True)
        for k, v in self.data.items():
            with open(os.path.join(directory, k + ".json"), "w", encoding="utf-8") as f:
                json.dump(v, f, ensure_ascii=False, separators=(",", ":"))

    @classmethod
    def from_dir(cls, directory):
        out = {}
        if os.path.isdir(directory):
            for fn in os.listdir(directory):
                if fn.endswith(".json") and not fn.endswith(".tmp"):
                    with open(os.path.join(directory, fn), encoding="utf-8") as f:
                        out[fn[:-5]] = json.load(f)
        return cls(out)


@contextlib.contextmanager
def patched(store, books=None, outlook=None):
    """На час виклику: рушій читає/пише лише store, контекст «Картини» береться з outlook (за замовчуванням порожній), книга заявок — з books."""
    S = engine()
    saved = (S.load, S.write_json, S.outlook_context, dict(S.BOOKS))
    S.load, S.write_json = store.load, store.write_json
    S.outlook_context = (lambda: outlook) if outlook is not None else (lambda: {})
    if books is not None:
        S.BOOKS.clear()
        S.BOOKS.update(books)
    try:
        yield S
    finally:
        S.load, S.write_json, S.outlook_context = saved[0], saved[1], saved[2]
        S.BOOKS.clear()
        S.BOOKS.update(saved[3])


def books_from_snapshot(snap):
    return {s: {"bids": [tuple(x) for x in b["bids"]], "asks": [tuple(x) for x in b["asks"]]} for s, b in snap["books"].items()}


TF_MS = {"1m": 60000, "15m": 900000, "30m": 1800000, "1h": 3600000, "2h": 7200000, "1d": 86400000}


_OPENS = {}


def _opens(rows):
    hit = _OPENS.get(id(rows))
    if hit is None or hit[0] is not rows:
        hit = (rows, [r[0] for r in rows])
        _OPENS[id(rows)] = hit
    return hit[1]


def live_price(rows_1m, now_ms):
    """Ціна «на зараз» з 1-хвилинних свічок: закриття останньої повністю закритої хвилини (без заглядання в майбутнє). None, якщо даних немає."""
    i = bisect.bisect_right(_opens(rows_1m), now_ms - 60000)
    return rows_1m[i - 1][1] if i else None


def ptf_from_rows(rows_by_key, kb, sk, now_ms, window=None, live=False):
    """Збирає ptf рівно як agent_simulation.run(): для кожного масштабу й монети (ціни закриття, час відкриття, оцінки, SMA50);
    останній елемент — поточна (ще не закрита) свічка. window — скільки останніх свічок брати (у рушія: paper_candles = 1000)."""
    S = engine()
    window = window or kb["paper_candles"]
    pcoins = list(kb["paper_coins"])
    tfs = needed_tfs(kb) + ["1d"]
    ptf = {tf: {} for tf in tfs}
    for sym in pcoins:
        for tf in tfs:
            rows = rows_by_key.get("%s|%s" % (sym, tf))
            if not rows:
                continue
            idx = bisect.bisect_right(_opens(rows), now_ms)
            rows = rows[max(0, idx - window):idx]
            if len(rows) < S.WARMUP + 60:                                         # fetch_tf у рушія відкидає короткі серії
                continue
            c, t = [r[1] for r in rows], [r[0] for r in rows]
            if live and now_ms < t[-1] + TF_MS.get(tf, 0):                       # остання свічка ще відкрита: її «закриття» — це жива ціна на now (а не підсумкове)
                lp = live_price(rows_by_key.get("%s|1m" % sym, []), now_ms)
                if lp is not None:
                    c[-1] = lp
            sc, s50 = S.scores_series(c, sk["weights"], sk["thresholds"])
            ptf[tf][sym] = (c, t, sc, s50)
    return ptf
