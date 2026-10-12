#!/usr/bin/env python3
"""Тести повного архіву подій Paper Trading (tools/agents/paper_archive.py) і його підключення до агента «Жива стрічка».
Без мережі й без Node.js; працює в тимчасовій папці (CRYPTO_DATA_DIR), справжні дані не чіпає.

  python tools/test_archive.py"""
import json
import os
import shutil
import sys
import tempfile
from datetime import datetime, timezone

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

TMP = tempfile.mkdtemp(prefix="archivetest_")
os.environ["CRYPTO_DATA_DIR"] = TMP
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.dont_write_bytecode = True

from agents import agent_feed as F          # noqa: E402
from agents import paper_archive as A       # noqa: E402

passed = failed = 0


def ms(y, m, d, h=12, mi=0):
    return int(datetime(y, m, d, h, mi, tzinfo=timezone.utc).timestamp() * 1000)


def reset():
    for n in os.listdir(TMP):
        p = os.path.join(TMP, n)
        shutil.rmtree(p) if os.path.isdir(p) else os.remove(p)
    A.MAX_EVENTS_PER_SEGMENT = 15000


def put(name, obj):
    with open(os.path.join(TMP, name), "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False)


def get(name):
    with open(os.path.join(TMP, name), encoding="utf-8") as f:
        return json.load(f)


def fe(i, t, source="sim", **kw):
    """Подія в форматі живої стрічки (те, що віддає sim_events)."""
    d = {"id": "sim-%016x" % i, "t": t, "candle": t - 5000, "source": source, "confirmed": "engine", "type": "open" if i % 2 == 0 else "close", "coin": "BTC", "pair": "BTC/USDT",
         "wallet": 100, "bot": "trend_1h", "bot_title": "x", "direction": "LONG", "price": 100.0 + i, "eq": 1.0, "w": 0.33, "cost": 0.0011, "reason": "довгий текст причини " * 5}
    d.update(kw)
    return d


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
            print("  ПРОВАЛ  %s: %s: %s" % (name, type(ex).__name__, ex))
        return fn
    return deco


@test("перший запис: сегмент місяця, індекс, компактні події без тексту причини й службових полів стрічки")
def _():
    r = A.update([fe(i, ms(2026, 10, 10, 10, i)) for i in range(5)])
    assert r["added"] == 5 and r["total"] == 5 and r["segments"] == 1
    seg = get("paper_archive/2026-10.json")
    assert seg["v"] == 1 and seg["count"] == 5 and len(seg["events"]) == 5
    e = seg["events"][0]
    assert "reason" not in e and "bot_title" not in e and "pair" not in e and "confirmed" not in e and e["id"].startswith("sim-")
    idx = get("paper_archive/index.json")
    assert idx["total"] == 5 and idx["segments"][0]["name"] == "2026-10" and idx["segments"][0]["count"] == 5 and "policy" in idx and idx["size_warning"] is False


@test("повторний запуск (перезапуск агента, перезапис гілки data) не створює дублів і не переписує файли")
def _():
    evs = [fe(i, ms(2026, 10, 10, 10, i)) for i in range(5)]
    A.update(evs)
    before = open(os.path.join(TMP, "paper_archive", "2026-10.json"), "rb").read()
    mt = os.path.getmtime(os.path.join(TMP, "paper_archive", "2026-10.json"))
    r = A.update(evs + evs)
    assert r["added"] == 0 and r["total"] == 5
    assert open(os.path.join(TMP, "paper_archive", "2026-10.json"), "rb").read() == before and os.path.getmtime(os.path.join(TMP, "paper_archive", "2026-10.json")) == mt


@test("нові події дописуються до наявних; наявні не змінюються, навіть якщо те саме id прийшло зі зміненими полями")
def _():
    A.update([fe(1, ms(2026, 10, 10), price=111.0)])
    r = A.update([fe(1, ms(2026, 10, 10), price=999.0), fe(2, ms(2026, 10, 11))])
    assert r["added"] == 1 and r["total"] == 2
    prices = {e["id"]: e["price"] for e in get("paper_archive/2026-10.json")["events"]}
    assert prices["sim-%016x" % 1] == 111.0


@test("події різних місяців: окремі сегменти; старий сегмент не переписується, коли нові події йдуть у новий місяць")
def _():
    A.update([fe(1, ms(2026, 9, 30, 23, 59)), fe(2, ms(2026, 10, 1, 0, 1))])
    assert sorted(A.list_segments()) == ["2026-09", "2026-10"]
    p = os.path.join(TMP, "paper_archive", "2026-09.json")
    mt = os.path.getmtime(p)
    A.update([fe(3, ms(2026, 10, 2))])
    assert os.path.getmtime(p) == mt
    assert get("paper_archive/index.json")["total"] == 3


@test("контроль розміру: сегмент має ліміт подій, надлишок іде у наступну частину (2026-10, 2026-10-2, ...)")
def _():
    A.MAX_EVENTS_PER_SEGMENT = 3
    A.update([fe(i, ms(2026, 10, 10, 10, i)) for i in range(8)])
    assert A.list_segments() == ["2026-10", "2026-10-2", "2026-10-3"], A.list_segments()
    assert [len(A.load_segment(n)[0]) for n in A.list_segments()] == [3, 3, 2]
    r = A.update([fe(i, ms(2026, 10, 10, 10, i)) for i in range(8)] + [fe(100, ms(2026, 10, 11))])
    assert r["added"] == 1 and r["total"] == 9
    assert len(A.read_all()) == 9 and len({e["id"] for e in A.read_all()}) == 9


@test("Testnet і чужі записи не потрапляють в архів: лише source=sim з ідентифікатором sim-…")
def _():
    r = A.update([fe(1, ms(2026, 10, 10)), fe(2, ms(2026, 10, 10), source="testnet", id="tn-BTC-1"), fe(3, ms(2026, 10, 10), id="evil-1"), fe(4, ms(2026, 10, 10), id=None), {"x": 1}])
    assert r["added"] == 1 and [e["id"] for e in A.read_all()] == ["sim-%016x" % 1]


@test("пошкоджений сегмент відкладається в .bad.json, а не перезаписується мовчки; інші сегменти цілі; події з джерел додаються знову")
def _():
    A.update([fe(1, ms(2026, 9, 10)), fe(2, ms(2026, 10, 10))])
    with open(os.path.join(TMP, "paper_archive", "2026-10.json"), "w", encoding="utf-8") as f:
        f.write("{обірваний json")
    r = A.update([fe(2, ms(2026, 10, 10)), fe(3, ms(2026, 10, 11))])
    assert r["bad"] == ["2026-10"], r
    assert os.path.exists(os.path.join(TMP, "paper_archive", "2026-10.bad.json"))
    ids = [e["id"] for e in A.read_all()]
    assert ids == ["sim-%016x" % 1, "sim-%016x" % 2, "sim-%016x" % 3], ids


@test("сегмент зі старою/чужою схемою не читається як дані, але й не губиться")
def _():
    os.makedirs(os.path.join(TMP, "paper_archive"))
    put("paper_archive/2026-10.json", {"v": 99, "events": [fe(1, ms(2026, 10, 10))]})
    r = A.update([fe(5, ms(2026, 10, 10))])
    assert r["bad"] == ["2026-10"] and os.path.exists(os.path.join(TMP, "paper_archive", "2026-10.bad.json"))


@test("перед перезаписом сегмента лишається .prev.json (останній справний стан); біля старих сегментів .prev не накопичується")
def _():
    A.update([fe(1, ms(2026, 9, 10))])
    A.update([fe(2, ms(2026, 9, 11))])
    assert os.path.exists(os.path.join(TMP, "paper_archive", "2026-09.prev.json"))
    A.update([fe(3, ms(2026, 10, 10))])                                    # з'явився новіший сегмент: у 2026-09 .prev прибирається
    assert not os.path.exists(os.path.join(TMP, "paper_archive", "2026-09.prev.json"))
    assert A.load_segment("2026-09")[1] == "ok"


@test("пошкодження сегмента, що має справну копію .prev.json: події відновлюються з копії, .bad.json не лишається")
def _():
    A.update([fe(i, ms(2026, 10, 10, 10, i)) for i in (1, 2, 3)])
    A.update([fe(4, ms(2026, 10, 10, 11))])                                # переписав сегмент: у .prev лежить стан із подіями 1–3
    seg = os.path.join(TMP, "paper_archive", "2026-10.json")
    with open(seg, "w", encoding="utf-8") as f:
        f.write('{"v":1,"events":[{"id":"sim-0000')                         # обірваний запис
    r = A.update([])
    ids = [e["id"] for e in A.read_all()]
    assert ids == ["sim-%016x" % i for i in (1, 2, 3)], ids
    assert not os.path.exists(os.path.join(TMP, "paper_archive", "2026-10.bad.json")) and r["bad"] == []
    assert A.load_segment("2026-10")[1] == "ok"
    A.update([fe(4, ms(2026, 10, 10, 11))])                                # подія 4 з джерела повертається
    assert len(A.read_all()) == 4


@test("перезапуск після часткового запису: залишки .tmp прибираються, застарілий індекс виправляється, події не губляться")
def _():
    A.update([fe(i, ms(2026, 10, 10, 10, i)) for i in range(4)])
    d = os.path.join(TMP, "paper_archive")
    with open(os.path.join(d, "2026-10.json.tmp"), "w", encoding="utf-8") as f:
        f.write('{"v":1,"eve')                                              # агент зупинили посеред запису
    stale = get("paper_archive/index.json")
    stale["segments"][0]["count"] = 1
    stale["total"] = 1
    put("paper_archive/index.json", stale)                                  # сегмент записано, індекс не оновлено
    r = A.update([])
    assert not os.path.exists(os.path.join(d, "2026-10.json.tmp"))
    idx = get("paper_archive/index.json")
    assert idx["total"] == 4 and idx["segments"][0]["count"] == 4 and r["total"] == 4
    os.remove(os.path.join(d, "index.json"))                                # індекс зник зовсім
    A.update([])
    assert get("paper_archive/index.json")["total"] == 4


@test("перший запуск на порожній папці й без подій: індекс усе одно створюється (check_data його знайде)")
def _():
    r = A.update([])
    assert r["total"] == 0 and os.path.exists(os.path.join(TMP, "paper_archive", "index.json"))
    import check_data                                                       # noqa: E402
    saved, check_data.DATA = check_data.DATA, TMP
    try:
        assert check_data.check_archive() == []
    finally:
        check_data.DATA = saved


@test("порядок у workflow: run_agents.py іде раніше за check_data.py, а агент стрічки (власник архіву) запускається в «останній» черзі")
def _():
    wf = open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".github", "workflows", "update-data.yml"), encoding="utf-8").read()
    assert wf.index("python tools/run_agents.py") < wf.index("python tools/check_data.py") < wf.index("Зберегти дані в гілку data")
    assert F.RUNS_LAST is True
    import run_agents                                                       # noqa: E402
    names = [a.NAME for a in run_agents.AGENTS]
    assert "feed" in names and names.index("simulation") < names.index("trader") < names.index("feed")


@test("збірка Pages: у публічну копію не потрапляють *.prev.json, *.bad.json, *.tmp, а сегменти, index.json і робочі файли даних лишаються (виключення береться з workflow)")
def _():
    import fnmatch
    import re
    wf = open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".github", "workflows", "update-data.yml"), encoding="utf-8").read()
    line = [l for l in wf.splitlines() if l.strip().startswith("rsync ")][0]
    ex = re.findall(r"--exclude '([^']+)'", line)
    for pat in ("*.prev.json", "*.bad.json", "*.tmp"):
        assert pat in ex, pat
    # збереження в гілку data (git add -A) нічого не виключає: резервні файли мають лишатися там
    save = wf[wf.index("Зберегти дані в гілку data"):wf.index("Зібрати сайт")]
    assert "--exclude" not in save and "git add -A" in save
    A.update([fe(1, ms(2026, 9, 10)), fe(2, ms(2026, 10, 10))])
    A.update([fe(3, ms(2026, 10, 11))])                                     # з'явився .prev
    d = os.path.join(TMP, "paper_archive")
    for n in ("2026-10.bad.json", "2026-10.json.tmp"):
        open(os.path.join(d, n), "w").write("x")
    put("simulation.json", {"x": 1}); put("live_feed.prev.json", {"v": 1}); put("live_feed.json", {"v": 1})
    kept = []
    for root, dirs, files in os.walk(TMP):                                  # як rsync: шаблон без «/» зіставляється з ім'ям кожного файлу й папки
        dirs[:] = [x for x in dirs if not any(fnmatch.fnmatch(x, p) for p in ex)]
        kept += [os.path.relpath(os.path.join(root, f), TMP).replace(os.sep, "/") for f in files if not any(fnmatch.fnmatch(f, p) for p in ex)]
    assert "paper_archive/index.json" in kept and "paper_archive/2026-09.json" in kept and "paper_archive/2026-10.json" in kept and "simulation.json" in kept and "live_feed.json" in kept, kept
    assert not [k for k in kept if k.endswith((".prev.json", ".bad.json", ".tmp"))], kept
    assert os.path.exists(os.path.join(d, "2026-10.prev.json")) and os.path.exists(os.path.join(d, "2026-10.bad.json"))     # на диску (а отже, у гілці data) вони є


@test("не вигадує втрачене: події, що вже зникли з джерел, лишаються в архіві; відсутні не відновлюються")
def _():
    A.update([fe(i, ms(2026, 10, 10, 10, i)) for i in range(5)])
    r = A.update([fe(i, ms(2026, 10, 10, 10, i)) for i in range(3, 5)])      # у джерелі лишилися лише 2 останні
    assert r["added"] == 0 and r["total"] == 5
    assert len(A.read_all()) == 5


@test("компактність: подія до 520 байтів (із повним exit_info); оцінка росту за місяць при 170 подіях на добу")
def _():
    A.update([fe(i, ms(2026, 10, 10, 10, i % 60), exit="stop", exit_info={"kind": "stop", "threshold_pct": 2, "entry": 110.0, "exit_price": 103.0, "move_pct": -6.364, "check": "software"}) for i in range(100)])
    size = os.path.getsize(os.path.join(TMP, "paper_archive", "2026-10.json"))
    per = size / 100
    print("      (%.0f байт на подію; ≈ %.2f МБ на 30 діб при 170 подіях/добу)" % (per, per * 170 * 30 / 1e6))
    assert per < 520


@test("інтеграція з агентом стрічки: архів збігається з журналом за ID, Testnet не змішується, перезапуск стрічки не дублює")
def _():
    def sevent(side, at, price, eq, candle, coin="BNB", rule="trend_1h", cost=0.0015, w=0.25, **kw):
        d = {"at": at, "candle": candle, "coin": coin, "side": side, "price": price, "rule": rule, "tf": "1h", "w": w, "eq": eq, "cost": cost, "reason": "тест"}
        d.update(kw)
        return d
    put("simulation.json", {"paper": {"fee": 0.0015}})
    put("paper_events.json", {"trend_1h": [sevent("BUY", "2026-10-10T11:50+00:00", 100, 1.0, 1000, reason="Початкова позиція на старті раунду."), sevent("SELL", "2026-10-10T14:00+00:00", 103, 1.02, 2000, exit="stop",
                                                                                                                          exit_info={"kind": "stop", "threshold_pct": 2, "entry": 110.0, "exit_price": 103.0, "move_pct": -6.364, "check": "software", "note": "довгий текст"})]})
    put("paper_events_100.json", {"trend_1h": [sevent("BUY", "2026-10-10T12:50+00:00", 50000, 1.0, 1500, coin="BTC", w=0.33)]})
    put("_trader_log.json", [{"coin": "BTC", "side": "BUY", "usdt": 100, "price": 60000, "id": 7, "status": "FILLED", "t": "2026-10-10T13:00:00+00:00", "fill": {"qty": 0.001, "quote": 60.0, "avg": 60000.0, "fees": {}}, "reason": "x"}])
    F.run()
    feed = get("live_feed.json")["events"]
    sim_ids = sorted(e["id"] for e in feed if e["source"] == "sim")
    arch = A.read_all()
    assert sorted(e["id"] for e in arch) == sim_ids and len(sim_ids) == 3, (sim_ids, [e["id"] for e in arch])
    assert any(e["source"] == "testnet" for e in feed) and not any(e["id"].startswith("tn-") for e in arch)
    stop = [e for e in arch if e.get("exit") == "stop"][0]
    assert stop["exit_info"]["threshold_pct"] == 2 and "note" not in stop["exit_info"]
    fstop = [e for e in feed if e.get("exit") == "stop"][0]
    assert fstop["exit_info"]["move_pct"] == -6.364 and fstop["pnl_pct"] is not None                  # у живій стрічці exit_info є поряд із результатом
    # «перезапуск»: журнал стрічки втрачено, архів лишається й не дублюється
    os.remove(os.path.join(TMP, "live_feed.json"))
    os.remove(os.path.join(TMP, "live_feed.prev.json")) if os.path.exists(os.path.join(TMP, "live_feed.prev.json")) else None
    F.run()
    assert sorted(e["id"] for e in A.read_all()) == sim_ids
    # в джерелі лишилась одна подія: архів зберіг усі три
    put("paper_events.json", {"trend_1h": [sevent("SELL", "2026-10-10T14:00+00:00", 103, 1.02, 2000, exit="stop")]})
    put("paper_events_100.json", {})
    F.run()
    assert len(A.read_all()) == 3


@test("збій архіву не ламає живу стрічку: виняток перехоплюється, у підсумок потрапляє повідомлення")
def _():
    real = A.update
    A.update = lambda evs: (_ for _ in ()).throw(OSError("диск повний"))
    try:
        put("simulation.json", {"paper": {"fee": 0.0015}})
        put("paper_events.json", {"trend_1h": [{"at": "2026-10-10T11:50+00:00", "candle": 1000, "coin": "BNB", "side": "BUY", "price": 100, "rule": "trend_1h", "tf": "1h", "w": 0.25, "eq": 1.0, "cost": 0.0015, "reason": "т"}]})
        r = F.run()
    finally:
        A.update = real
    assert "Архів подій: помилка" in r["insights"][0]["text"] and get("live_feed.json")["events"]


print("\nПройшло: %d, провалів: %d" % (passed, failed))
shutil.rmtree(TMP, ignore_errors=True)
sys.exit(1 if failed else 0)
