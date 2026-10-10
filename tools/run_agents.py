#!/usr/bin/env python3
"""Запускає агентів сайту. Кожен агент — окремий файл у tools/agents/ з однією задачею:

  market       Ринок: капіталізація, частки BTC/ETH, топ монет, лідери (CoinGecko)           кожні 5 хв
  sentiment    Настрій: індекс страху й жадібності за 30 днів (Alternative.me)                кожні 30 хв
  stablecoins  Стейблкоїни: пропозиція, лідери, динаміка (DefiLlama)                           кожні 30 хв
  network      Мережа біткоїна: комісії, черга, потужність (mempool.space)                     кожні 3 хв
  trader       Тестова біржа: автоматично купує й продає на Binance Testnet (ненастоящі гроші) за правилом із «Симуляції»
  feed         Жива стрічка: журнал підтверджених подій (симуляція й Testnet) для панелі на сайті  після «Тестової біржі»
  simulation   Симуляція: 7-денний паперовий рахунок на 100, 1000, 10000 $ і перевірка правил на історії цін (щоразу)
  report       Звіт: щоденний звіт по ринку з розділами, застереженнями й архівом (після «Картини»)
  outlook      Картина: зводить сигнали, новини, настрій і потоки грошей у фон по кожній монеті (без порад)  після решти
  signals      Сигнали: тренд, RSI, MACD по 8 популярних монетах і перевірка на минулому (Binance) кожну годину
  regulation   Регулювання: нові офіційні документи США про крипто (Federal Register)          щогодини
  news         Новини й аналітика: стрічки видань, фільтрація, переклад, висновки (news_agent)  кожні 10 хв

Кожен агент пише власний файл data/<назва>.json, а загальний стан усіх агентів — data/agents.json.
Якщо один агент зламався, інші працюють далі, а сайт показує, що саме цей віджет застарів.

  python tools/run_agents.py            один запуск усіх агентів
  python tools/run_agents.py --watch    працювати постійно (кожен агент зі своєю періодичністю)
  python tools/run_agents.py market network    лише вказані агенти
"""
import json
import os
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

from agents import agent_outlook, agent_report, agent_signals, agent_simulation, agent_trader, agent_feed, agent_analyst, agent_notify, ai_summary, agent_market, agent_network, agent_regulation, agent_sentiment, agent_stablecoins
from agents.common import DATA, log, now_iso, record_history, write_json
import news_agent


class NewsAgent:
    """Обгортка над news_agent.py: він сам пише data/news.json та data/analytics.json."""
    NAME, TITLE, SOURCE, INTERVAL = "news", "Новини й аналітика", "CoinDesk, The Block, Decrypt, SEC та ін.", 600

    @staticmethod
    def run():
        news_agent.run_once()
        return None

    @staticmethod
    def summary(_result):
        """Числа для історії: скільки матеріалів і яка частка негативних/позитивних заголовків (з data/analytics.json)."""
        with open(os.path.join(DATA, "analytics.json"), encoding="utf-8") as f:
            a = json.load(f)
        n = a.get("total") or 1
        s = a.get("sentiment", {})
        return {"total": a.get("total", 0), "negative_share": round(100 * s.get("negative", 0) / n),
                "positive_share": round(100 * s.get("positive", 0) / n)}


AGENTS = [agent_market, agent_network, agent_sentiment, agent_stablecoins, agent_regulation, agent_signals, NewsAgent, agent_outlook, agent_report, agent_simulation, agent_trader, agent_feed, agent_analyst, agent_notify]
lock = threading.Lock()


def load_status():
    """Попередній стан із data/agents.json: запуск окремих агентів не стирає інших, а збій не губить час останнього успіху."""
    try:
        with open(os.path.join(DATA, "agents.json"), encoding="utf-8") as f:
            old = json.load(f).get("agents", {})
    except (OSError, ValueError):
        return {}
    return {k: v for k, v in old.items() if k in {a.NAME for a in AGENTS}}


status = load_status()


def run_agent(agent):
    name = agent.NAME
    started = time.time()
    try:
        result = agent.run()
        if result is not None:
            ai = ai_summary.summarize(name, result.get("insights"))      # None без ключа ANTHROPIC_API_KEY
            if ai:
                result["ai_summary"] = ai
            write_json(name + ".json", dict(result, agent=name, title=agent.TITLE, source=agent.SOURCE, generated_at=now_iso()))
        if hasattr(agent, "summary"):           # агент, що веде історію, віддає числа для щоденної точки
            record_history(name, agent.summary(result))
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
            # агент «Картина» читає файли решти, тому в разовому запуску іде останнім
            list(pool.map(run_agent, [a for a in chosen if not getattr(a, "RUNS_LAST", False)]))
            for a in chosen:
                if getattr(a, "RUNS_LAST", False):
                    run_agent(a)
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
