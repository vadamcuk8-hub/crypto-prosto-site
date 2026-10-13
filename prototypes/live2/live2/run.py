"""Командний рядок прототипу: збирає публічні потоки Binance, міряє затримку/частоту/стабільність і пише ТІЛЬКИ в prototypes/live2/logs/.

  python -m live2.run --duration 600
  python -m live2.run --duration 900 --chaos-at 120,300      (грубий обрив зв'язку для вимірювання відновлення)
  python -m live2.run --duration 0                           (працювати до Ctrl+C / SIGTERM)

Нічого не торгує, не читає й не пише data/, не імпортує код рушія."""
import argparse
import asyncio
import json
import os
import signal
import sys
import time

from . import clock
from .feed import HOSTS, Feed
from .recorder import LOG_DIR, Recorder

DEFAULT_COINS = ["BTC", "ETH", "BNB", "SOL", "XRP", "DOGE", "ADA", "LINK", "AVAX", "SUI"]      # паперові монети трьох гаманців


def build_streams(coins, klines=("15m", "1h"), book=False):
    out = []
    for c in coins:
        s = c.lower() + "usdt"
        out.append(s + "@miniTicker")
        out += [s + "@kline_" + k for k in klines]
        if book:
            out.append(s + "@bookTicker")
    return out


async def main_async(args):
    os.makedirs(LOG_DIR, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    log_path = os.path.join(LOG_DIR, "run-%s.jsonl" % stamp)
    off = await clock.measure_offset()
    rec = Recorder(offset_ms=(off or {}).get("offset_ms", 0.0), log_path=log_path)
    rec.error_ms = round((off or {}).get("error_ms", 0) or 0, 1)
    rec.log({"kind": "start", "args": vars(args), "clock": off})
    if not off:
        print("УВАГА: час біржі недоступний через REST: затримки рахуються без поправки на годинник")
    else:
        print("Зсув годинника: %+.1f мс (RTT REST %.0f мс, похибка оцінки ±%.0f мс)" % (off["offset_ms"], off["rtt_ms"], off["error_ms"]))
    streams = build_streams(args.coins, args.klines.split(","), args.book)
    feed = Feed(streams, rec.on_message, hosts=args.hosts or HOSTS, stale_s=args.stale, on_event=rec.on_event)
    loop = asyncio.get_running_loop()

    def _stop(*_):
        loop.call_soon_threadsafe(feed.stop)
    for s in (signal.SIGINT, signal.SIGTERM):
        try:
            signal.signal(s, _stop)
        except (ValueError, OSError):
            pass
    task = asyncio.create_task(feed.run())
    chaos = sorted(float(x) for x in args.chaos_at.split(",") if x) if args.chaos_at else []
    t0 = time.monotonic()
    last_min = t0
    last_clock = t0
    while not task.done():
        await asyncio.sleep(0.5)
        el = time.monotonic() - t0
        if chaos and el >= chaos[0]:
            chaos.pop(0)
            print("[%5.0f с] ПРИМУСОВИЙ ОБРИВ ЗВ'ЯЗКУ" % el)
            feed.chaos_drop("chaos")
        if time.monotonic() - last_min >= 60:
            last_min = time.monotonic()
            m = rec.minute_report()
            mt = m["latency_ms"].get("miniTicker", {})
            print("[%5.0f с] miniTicker %s/с  затримка p50=%s p99=%s мс  свічок закрито: %d" % (el, m["rate_per_s"].get("miniTicker"), mt.get("p50"), mt.get("p99"), rec.closes))
        if time.monotonic() - last_clock >= 600:                      # дрейф годинника: переміряємо раз на 10 хв
            last_clock = time.monotonic()
            o2 = await clock.measure_offset(samples=4)
            if o2:
                rec.offset_ms = o2["offset_ms"]; rec.error_ms = round(o2["error_ms"], 1)
                rec.log({"kind": "clock", **o2})
        if args.duration and el >= args.duration:
            feed.stop()
            break
    await task
    rec.minute_report()
    summ = rec.summary(feed)
    summ["streams"] = len(streams)
    summ["coins"] = args.coins
    rec.log({"kind": "summary", **summ})
    rec.close()
    out = os.path.join(LOG_DIR, "run-%s-summary.json" % stamp)
    with open(out, "w", encoding="utf-8") as f:
        json.dump(summ, f, ensure_ascii=False, indent=1)
    print(json.dumps(summ, ensure_ascii=False, indent=1))
    print("Журнал:", log_path, "\nПідсумок:", out)
    return summ


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--duration", type=float, default=600, help="секунд роботи (0 = до зупинки)")
    ap.add_argument("--coins", default=",".join(DEFAULT_COINS), type=lambda s: [x.strip().upper() for x in s.split(",") if x.strip()])
    ap.add_argument("--klines", default="15m,1h", help="інтервали kline через кому")
    ap.add_argument("--book", action="store_true", help="додати bookTicker (найкращі ціни книги; без часу події)")
    ap.add_argument("--stale", type=float, default=10.0, help="тиша в секундах, після якої з'єднання вважається мертвим")
    ap.add_argument("--hosts", default=None, type=lambda s: [x.strip() for x in s.split(",")], help="WebSocket-хости через кому")
    ap.add_argument("--chaos-at", default="", help="секунди від старту, коли примусово обірвати з'єднання (через кому)")
    args = ap.parse_args(argv)
    try:
        asyncio.run(main_async(args))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
