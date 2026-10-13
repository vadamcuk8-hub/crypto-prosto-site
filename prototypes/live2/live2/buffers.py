"""Потокові свічки для тіньового рушія: буфер на кожну пару (монета, масштаб), складання вхідних даних рушія (ptf) із потоку Binance
і REST-дозавантаження пропусків. Без мережі й без файлів (REST передається ззовні).

Інваріанти, що дзеркалять REST-вхід чинного рушія:
  • рівно останні `cap` свічок (у рушія paper_candles = 1000): рекурентні індикатори (EMA/RSI) залежать від початку вікна;
  • остання свічка — ПОТОЧНА (відкрита), її «закриття» = остання ціна (miniTicker/kline); решта — закриті;
  • закрита свічка вважається підтвердженою лише після kline з x=true або REST: до того вона «непідтверджена» і ринок не вважається придатним для рішень;
  • пропуск свічок, повторні й запізнілі події, некоректні ціни ловляться й рахуються окремо."""
import math
import time

from . import engine_bridge as eb

TF_MS = eb.TF_MS
MAX_JUMP = 0.15                      # різниця між сусідніми цінами понад 15 % вважається збоєм даних, а не рухом ринку


def valid_price(p):
    return isinstance(p, (int, float)) and math.isfinite(p) and p > 0


class CandleBuffer:
    def __init__(self, tf, cap=1000):
        self.tf, self.ms, self.cap = tf, TF_MS[tf], cap
        self.rows = []                   # [[open_ms, close], ...] за зростанням
        self.confirmed_upto = None       # open_ms останньої підтвердженої закритої свічки
        self.gap = None                  # (з_open_ms, до_open_ms): пропущені свічки, що потребують REST
        self.version = 0
        self.dups = self.out_of_order = self.bad_price = 0

    # ---- завантаження з REST ----
    def load_rest(self, rows, now_ms):
        """Зливає свічки з REST (авторитетні для закритих). Після злиття пропуск вважається закритим."""
        by = {r[0]: r[1] for r in self.rows}
        for r in rows:
            by[int(r[0])] = float(r[1])
        merged = [[k, by[k]] for k in sorted(by)]
        self.rows = merged[-self.cap:]
        closed = [r[0] for r in self.rows if r[0] + self.ms <= now_ms]
        self.confirmed_upto = max(closed) if closed else None
        self.gap = None
        self.version += 1

    # ---- події потоку ----
    def on_kline(self, open_ms, close, closed):
        if not valid_price(close):
            self.bad_price += 1
            return False
        if not self.rows:
            self.rows.append([open_ms, close])
            self.version += 1
            if closed:
                self.confirmed_upto = open_ms
            return True
        last = self.rows[-1][0]
        if open_ms == last:
            if closed and self.confirmed_upto is not None and self.confirmed_upto >= open_ms:
                self.dups += 1                                                    # повторна доставка закриття: нічого не змінюємо
                return False
            self.rows[-1][1] = close
            if closed:
                self.confirmed_upto = open_ms
            self.version += 1
            return True
        if open_ms > last:
            if open_ms != last + self.ms:
                self.gap = (last + self.ms, open_ms)                              # пропущено одну чи кілька свічок
            self.rows.append([open_ms, close])
            self.rows = self.rows[-self.cap:]
            if closed:
                self.confirmed_upto = open_ms
            self.version += 1
            return True
        # старіша за поточну: лише закриття може уточнити відому свічку
        for r in reversed(self.rows):
            if r[0] == open_ms:
                if closed:
                    if self.confirmed_upto is not None and self.confirmed_upto >= open_ms and r[1] == close:
                        self.dups += 1
                        return False
                    r[1] = close
                    self.confirmed_upto = max(self.confirmed_upto if self.confirmed_upto is not None else -1, open_ms)
                    self.version += 1
                    return True
                self.out_of_order += 1
                return False
            if r[0] < open_ms:
                break
        self.out_of_order += 1
        return False

    def on_price(self, ts_ms, price):
        """Жива ціна (miniTicker): оновлює закриття поточної свічки; перехід межі свічки без kline створює нову (попередня лишається непідтвердженою)."""
        if not valid_price(price):
            self.bad_price += 1
            return False
        if not self.rows:
            return False
        last = self.rows[-1]
        if ts_ms < last[0]:
            self.out_of_order += 1
            return False
        if abs(price / last[1] - 1) > MAX_JUMP:
            self.bad_price += 1
            return False
        if ts_ms < last[0] + self.ms:
            last[1] = price
        else:
            new_open = ts_ms - ts_ms % self.ms
            if new_open != last[0] + self.ms:
                self.gap = (last[0] + self.ms, new_open)
            self.rows.append([new_open, price])
            self.rows = self.rows[-self.cap:]
        self.version += 1
        return True

    # ---- стан ----
    def unconfirmed(self, now_ms, grace_ms=3000):
        """Є свічка, що вже закрилась за часом (з урахуванням grace), але її підсумкове закриття не підтверджено (kline x / REST).
        Враховуються й останній рядок (якщо після межі не було жодної ціни, нова свічка ще не створена), і попередні."""
        closed = [r[0] for r in self.rows[-3:] if r[0] + self.ms + grace_ms <= now_ms]
        return bool(closed) and (self.confirmed_upto is None or self.confirmed_upto < max(closed))

    def needs_backfill(self, now_ms, grace_ms=3000):
        return self.gap is not None or self.unconfirmed(now_ms, grace_ms)


class StreamMarket:
    def __init__(self, kb, sk, coins=None, stale_ms=120000, feed_ms=10000, tfs=None, cap=None, clock=time.time):
        self.kb, self.sk = kb, sk
        self.coins = list(coins or kb["paper_coins"])
        self.tfs = list(tfs or (eb.needed_tfs(kb) + ["1d"]))
        self.cap = cap or kb["paper_candles"]
        self.stale_ms = stale_ms          # монета без жодного повідомлення довше (дрібні монети можуть мовчати десятки секунд, поки з'єднання живе)
        self.feed_ms = feed_ms            # з'єднання без жодного повідомлення довше вважається мертвим
        self.last_any = 0
        self.clock = clock
        self.buf = {(s, tf): CandleBuffer(tf, self.cap) for s in self.coins for tf in self.tfs}
        self.last_tick = {}              # монета → час отримання останнього повідомлення (локальний годинник, мс)
        self.last_event = {}             # монета → час події біржі останньої ціни
        self.price = {}
        self.msgs = self.rejected = self.dup_ticks = 0
        self._score_cache = {}
        self._unconf_since = None

    # ---- ввід ----
    def seed(self, rows_by_key, now_ms):
        for (sym, tf), b in self.buf.items():
            rows = rows_by_key.get("%s|%s" % (sym, tf))
            if rows:
                b.load_rest(rows, now_ms)

    def apply_backfill(self, sym, tf, rows, now_ms):
        self.buf[(sym, tf)].load_rest(rows, now_ms)

    def on_message(self, stream, data, recv_ms):
        if "@" not in stream:
            return
        sym, kind = stream.split("@", 1)
        sym = sym.replace("usdt", "").upper()
        if sym not in self.coins:
            return
        self.msgs += 1
        self.last_tick[sym] = recv_ms
        self.last_any = max(self.last_any, recv_ms)
        if kind == "miniTicker":
            p, e = data.get("c"), data.get("E")
            try:
                p = float(p)
            except (TypeError, ValueError):
                self.rejected += 1
                return
            if not valid_price(p) or e is None:
                self.rejected += 1
                return
            if e < self.last_event.get(sym, 0):
                self.dup_ticks += 1                                                # запізніла ціна: не перезаписує новішу
                return
            self.last_event[sym], self.price[sym] = e, p
            for tf in self.tfs:
                self.buf[(sym, tf)].on_price(e, p)
        elif kind.startswith("kline_"):
            tf = kind[6:]
            if (sym, tf) not in self.buf:
                return
            k = data.get("k") or {}
            try:
                self.buf[(sym, tf)].on_kline(int(k["t"]), float(k["c"]), bool(k.get("x")))
            except (KeyError, TypeError, ValueError):
                self.rejected += 1

    # ---- стан і придатність для рішень ----
    def health(self, now_ms=None, grace_ms=3000):
        now_ms = now_ms if now_ms is not None else self.clock() * 1000
        feed_dead = now_ms - self.last_any > self.feed_ms
        stale = sorted(self.coins) if feed_dead else sorted(s for s in self.coins if now_ms - self.last_tick.get(s, 0) > self.stale_ms)
        need = sorted("%s|%s" % k for k, b in self.buf.items() if b.needs_backfill(now_ms, grace_ms))
        empty = sorted("%s|%s" % k for k, b in self.buf.items() if len(b.rows) < 260)
        return {"stale": stale, "needs_backfill": need, "short": empty, "ok": not stale and not need and not empty}

    def readiness(self, now_ms, wait_ms=1500):
        """Чи можна запускати крок рушія ЗАРАЗ. Рушій необоротно «запікає» закриті свічки у стан рахунків, тому ухвалювати рішення за
        непідтвердженим закриттям (kline x не прийшов або REST ще не звірено) заборонено:
          ready    — усі закриті свічки підтверджені, монети не застарілі;
          wait     — закриття щойно настало: чекаємо kline x (до wait_ms);
          backfill — x не прийшов за wait_ms (або є пропуск): потрібне REST-дозавантаження вказаних буферів;
          skip     — дані застарілі/короткі: крок пропускається."""
        h = self.health(now_ms, grace_ms=0)
        if h["stale"] or h["short"]:
            self._unconf_since = None
            return {"action": "skip", "keys": [], "health": h}
        keys = h["needs_backfill"]
        gap_keys = [k for k in keys if self.buf[tuple(k.split("|"))].gap is not None]
        if not keys:
            self._unconf_since = None
            return {"action": "ready", "keys": [], "health": h}
        if self._unconf_since is None:
            self._unconf_since = now_ms
        if gap_keys or now_ms - self._unconf_since >= wait_ms:
            return {"action": "backfill", "keys": keys, "health": h}
        return {"action": "wait", "keys": keys, "health": h}

    def ptf(self, now_ms=None):
        """Вхід рушія: {масштаб: {монета: (ціни, час відкриття, оцінки, SMA50)}} з буферів. Оцінки перераховуються лише для змінених буферів."""
        S = eb.engine()
        out = {tf: {} for tf in self.tfs}
        for (sym, tf), b in self.buf.items():
            if len(b.rows) < S.WARMUP + 60:
                continue
            ck = (sym, tf)
            hit = self._score_cache.get(ck)
            if hit and hit[0] == b.version:
                out[tf][sym] = hit[1]
                continue
            c, t = [r[1] for r in b.rows], [r[0] for r in b.rows]
            sc, s50 = S.scores_series(c, self.sk["weights"], self.sk["thresholds"])
            val = (c, t, sc, s50)
            self._score_cache[ck] = (b.version, val)
            out[tf][sym] = val
        return out
