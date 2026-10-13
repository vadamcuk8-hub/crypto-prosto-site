"""Облік вимірювань: затримка, частота, інтервали між повідомленнями, пропуски закритих свічок. Розрахунки в пам'яті, запис лише в prototypes/live2/logs/."""
import json
import os
import time

from .pricebook import PriceBook
from .stats import Reservoir

INTERVAL_MS = {"1m": 60000, "3m": 180000, "5m": 300000, "15m": 900000, "30m": 1800000, "1h": 3600000, "2h": 7200000, "4h": 14400000, "1d": 86400000}
LOG_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "logs")


class Recorder:
    def __init__(self, offset_ms=0.0, log_path=None, clock=time.time):
        self.offset_ms = offset_ms
        self.clock = clock
        self.book = PriceBook(clock)
        self.lat = {}                 # тип потоку → Reservoir затримок, мс
        self.lat_minute = {}          # те саме, але лише за поточну хвилину
        self.kline_close_delay = {}   # інтервал → Reservoir: затримка закритої свічки відносно її кінця
        self.count = {}               # тип потоку → кількість
        self.count_minute = {}
        self.raw = Reservoir()        # miniTicker: локальний час отримання − час події БЕЗ поправки на годинник (залежить від синхронізації годинника ПК)
        self.error_ms = None          # похибка оцінки зсуву годинника (RTT/2 найкращого зразка)
        self.gap = Reservoir(50000)   # інтервал між повідомленнями miniTicker однієї монети, мс
        self.last_recv = {}           # (потік) → час отримання останнього повідомлення
        self.max_gap = {}             # потік → найбільший інтервал, мс
        self.last_closed = {}         # (монета, інтервал) → T закритої свічки
        self.missed_closes = 0
        self.closes = 0
        self.out_of_order = 0
        self.negative_latency = 0
        self.events = []
        self.start = clock()
        self._log = open(log_path, "a", encoding="utf-8") if log_path else None
        self._minute_started = clock()

    # ---- журнал ----
    def log(self, rec):
        rec = dict(rec, ts=round(self.clock(), 3))
        if self._log:
            self._log.write(json.dumps(rec, ensure_ascii=False) + "\n")
            self._log.flush()

    def on_event(self, e):
        self.events.append(e)
        self.log(e)

    def close(self):
        if self._log:
            self._log.close()
            self._log = None

    # ---- обробка повідомлень ----
    def _lat(self, kind, v):
        if v < 0:
            self.negative_latency += 1        # зсув годинника ±RTT/2 може давати малі від'ємні значення: рахуємо окремо, у статистику беремо як є
        self.lat.setdefault(kind, Reservoir()).add(v)
        self.lat_minute.setdefault(kind, Reservoir(5000)).add(v)
        self.count[kind] = self.count.get(kind, 0) + 1
        self.count_minute[kind] = self.count_minute.get(kind, 0) + 1

    def on_message(self, stream, data, recv_ms):
        srv_now = recv_ms + self.offset_ms
        if "@" not in stream:
            return
        sym, kind = stream.split("@", 1)
        sym = sym.replace("usdt", "").upper()
        prev = self.last_recv.get(stream)
        self.last_recv[stream] = recv_ms
        if prev is not None:
            g = recv_ms - prev
            if g > self.max_gap.get(stream, 0):
                self.max_gap[stream] = g
            if kind == "miniTicker":
                self.gap.add(g)
        if kind == "miniTicker":
            e = data.get("E")
            if e is not None:
                self._lat("miniTicker", srv_now - e)
                self.raw.add(recv_ms - e)
                if not self.book.update(sym, float(data["c"]), e, recv_ms):
                    self.out_of_order += 1
        elif kind.startswith("kline_"):
            k = data.get("k", {})
            e = data.get("E")
            if e is not None:
                self._lat(kind, srv_now - e)
            if k.get("x"):
                itv = k.get("i")
                self.closes += 1
                self.kline_close_delay.setdefault(itv, Reservoir()).add(srv_now - k["T"])
                key = (sym, itv)
                last = self.last_closed.get(key)
                step = INTERVAL_MS.get(itv)
                if last is not None and step:
                    miss = int(round((k["T"] - last) / step)) - 1
                    if miss > 0:
                        self.missed_closes += miss
                        self.log({"kind": "missed_close", "sym": sym, "interval": itv, "missed": miss})
                    elif miss < 0:
                        self.out_of_order += 1
                self.last_closed[key] = k["T"]
        elif kind == "bookTicker":
            self.count[kind] = self.count.get(kind, 0) + 1
            self.count_minute[kind] = self.count_minute.get(kind, 0) + 1
            if "E" in data:
                self._lat("bookTicker_E", srv_now - data["E"])

    # ---- звіти ----
    def minute_report(self):
        now = self.clock()
        dt = max(1e-9, now - self._minute_started)
        rep = {"kind": "minute", "rate_per_s": {k: round(v / dt, 2) for k, v in self.count_minute.items()},
               "latency_ms": {k: r.summary() for k, r in self.lat_minute.items()}}
        self.log(rep)
        self.count_minute, self.lat_minute, self._minute_started = {}, {}, now
        return rep

    def summary(self, feed=None):
        dur = max(1e-9, self.clock() - self.start)
        disc = [e for e in self.events if e.get("kind") == "disconnected"]
        conn = [e for e in self.events if e.get("kind") == "connected"]
        # час простою: від відключення до наступного підключення
        downs, last_dis = [], None
        for e in self.events:
            if e["kind"] == "disconnected":
                last_dis = e["t"]
            elif e["kind"] == "connected" and last_dis is not None:
                downs.append((e["t"] - last_dis, e))
                last_dis = None
        reasons = {}
        for e in disc:
            reasons[e["reason"]] = reasons.get(e["reason"], 0) + 1
        return {
            "duration_s": round(dur, 1), "offset_ms": round(self.offset_ms, 2),
            "messages": sum(self.count.values()), "rate_per_s": {k: round(v / dur, 2) for k, v in self.count.items()},
            "latency_ms": {k: r.summary() for k, r in self.lat.items()},
            "latency_error_bound_ms": self.error_ms, "raw_miniTicker_minus_event_ms": self.raw.summary(),
            "kline_close_delay_ms": {k: r.summary() for k, r in self.kline_close_delay.items()},
            "miniTicker_interval_ms": self.gap.summary(),
            "max_gap_ms_by_stream": {k: round(v) for k, v in sorted(self.max_gap.items(), key=lambda x: -x[1])[:6]},
            "connections": len(conn), "disconnects": len(disc), "disconnect_reasons": reasons,
            "downtime_s_each": [round(d[0], 2) for d in downs], "downtime_s_max": round(max([d[0] for d in downs]), 2) if downs else 0,
            "connect_failures": sum(1 for e in self.events if e["kind"] == "connect_failed"),
            "closed_klines": self.closes, "missed_closed_klines": self.missed_closes, "out_of_order": self.out_of_order, "negative_latency_samples": self.negative_latency,
            "uptime_share": round(1 - sum(d[0] for d in downs) / dur, 5),
        }
