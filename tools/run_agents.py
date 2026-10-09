#!/usr/bin/env python3
"""Запускає агентів сайту. Кожен агент — окремий файл у tools/agents/ з однією задачею:

  market       Ринок: капіталізація, частки BTC/ETH, топ монет, лідери (CoinGecko)           кожні 5 хв
  sentiment    Настрій: індекс страху й жадібності за 30 днів (Alternative.me)                кожні 30 хв
  stablecoins  Стейблкоїни: пропозиція, лідери, динаміка (DefiLlama)                           кожні 30 хв
  network      Мережа біткоїна: комісії, черга, потужність (mempool.space)                     кожні 3 хв
  regulation   Регулювання: нові офіційні документи США про крипто (Federal Register)          щогодини
  news         Новини й аналітика: стрічки видань, фільтрація, переклад, висновки (news_agent)  кожні 10 хв

Кожен агент пише власний файл data/<назва>.json, а загальний стан усіх агентів — data/agents.json.
Якщо один агент зламався, інші працюють далі, а сайт показує, що саме цей віджет застарів.

  python tools/run_agents.py            один запуск усіх агентів
  python tools/run_agents.py --watch    працювати постійно (кожен агент зі своєю періодичністю)
  python tools/run_agents.py market network    лише вказані агенти
"""
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

from agents import agent_market, agent_network, agent_regulation, agent_sentiment, agent_stablecoins
from agents.common import log, now_iso, write_json
import news_agent


class NewsAgent:
    """Обгортка над news_agent.py: він сам пише data/news.json та data/analytics.json."""
    NAME, TITLE, SOURCE, INTERVAL = "news", "Новини й аналітика", "CoinDesk, The Block, Decrypt, SEC та ін.", 600

    @staticmethod
    def run():
        news_agent.run_once()
        return None


AGENTS = [agent_market, agent_network, agent_sentiment, agent_stablecoins, agent_regulation, NewsAgent]
status = {}
lock = threading.Lock()


def run_agent(agent):
    name = agent.NAME
    started = time.time()
    try:
        result = agent.run()
        if result is not None:
            write_json(name + ".json", dict(result, agent=name, title=agent.TITLE, source=agent.SOURCE, generated_at=now_iso()))
        with lock:
            status[name] = {"title": agent.TITLE, "source": agent.SOURCE, "interval": agent.INTERVAL, "ok": True,
                            "last_ok": now_iso(), "error": ""}
        log(name, "готово за %.1f с" % (time.time() - started))
    except Exception as ex:   # noqa: BLE001 — один агент не повинен зупиняти решту
        with lock:
            old = status.get(name, {})
            status[name] = {"title": agent.TITLE, "source": agent.SOURCE, "interval": agent.INTERVAL, "ok": False,
                            "last_ok": old.get("last_ok"), "error": (type(ex).__name__ + ": " + str(ex))[:160]}
        log(name, "ПОМИЛКА: %s" % status[name]["error"])
    with lock:
        write_json("agents.json", {"generated_at": now_iso(), "agents": status})


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    watch = "--watch" in sys.argv
    chosen = [a for a in AGENTS if not args or a.NAME in args]
    if not chosen:
        raise SystemExit("Невідомі агенти: %s. Доступні: %s" % (", ".join(args), ", ".join(a.NAME for a in AGENTS)))

    with ThreadPoolExecutor(max_workers=len(chosen)) as pool:
        if not watch:
            list(pool.map(run_agent, chosen))
            return
        log("керує", "агенти працюють постійно: %s. Зупинити: Ctrl+C." % ", ".join(a.NAME for a in chosen))
        next_run = {a.NAME: 0 for a in chosen}
        running = set()

        def task(agent):
            try:
                run_agent(agent)
            finally:
                running.discard(agent.NAME)

        while True:
            now = time.time()
            for a in chosen:
                if now >= next_run[a.NAME] and a.NAME not in running:
                    running.add(a.NAME)
                    next_run[a.NAME] = now + a.INTERVAL
                    pool.submit(task, a)
            time.sleep(2)


if __name__ == "__main__":
    main()
