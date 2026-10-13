"""Керування з'єднанням із публічним WebSocket Binance: перепідключення з експоненційною паузою й джитером, ротація хостів,
контроль «тиші» (stale), планова ротація до 24-годинного ліміту Binance, чисте завершення. Нічого не знає про торгівлю й файли."""
import asyncio
import json
import random
import time

import websockets

HOSTS = ("wss://stream.binance.com:9443", "wss://stream.binance.com:443", "wss://data-stream.binance.vision")


class Feed:
    def __init__(self, streams, on_message, hosts=HOSTS, stale_s=10.0, max_conn_s=23 * 3600, open_timeout=10.0, backoff_min=0.5, backoff_max=30.0,
                 on_event=None, ping_interval=20, ping_timeout=20, rnd=None):
        self.streams, self.on_message, self.hosts = list(streams), on_message, list(hosts)
        self.stale_s, self.max_conn_s, self.open_timeout = stale_s, max_conn_s, open_timeout
        self.backoff_min, self.backoff_max = backoff_min, backoff_max
        self.on_event = on_event or (lambda e: None)
        self.ping_interval, self.ping_timeout = ping_interval, ping_timeout
        self._rnd = rnd or random.Random()
        self._stop = asyncio.Event()
        self._chaos = None            # причина примусового обриву (для вимірювання поведінки після втрати зв'язку)
        self.host_i = 0
        self.connects = 0
        self.failures = 0
        self.messages = 0
        self.ws = None

    # ---- керування ----
    def stop(self):
        self._stop.set()

    def chaos_drop(self, reason="chaos"):
        """Грубий обрив без закриття протоколу (імітація втрати мережі): транспорт скидається."""
        self._chaos = reason

    def _emit(self, kind, **kw):
        kw.update(kind=kind, t=time.time())
        try:
            self.on_event(kw)
        except Exception:  # noqa: BLE001 — журнал не повинен ламати з'єднання
            pass

    def url(self, host):
        return host + "/stream?streams=" + "/".join(self.streams)

    def next_backoff(self, attempt):
        base = min(self.backoff_max, self.backoff_min * (2 ** max(0, attempt - 1)))
        return base * (0.5 + self._rnd.random() * 0.5)          # джитер: 50..100 % від бази, щоб не «бити» біржу синхронно

    async def _sleep(self, s):
        try:
            await asyncio.wait_for(self._stop.wait(), timeout=s)
        except asyncio.TimeoutError:
            pass

    async def _reader(self, ws, state):
        async for raw in ws:
            recv_ms = time.time() * 1000
            state["last"] = time.monotonic()
            state["n"] += 1
            self.messages += 1
            try:
                env = json.loads(raw)
            except ValueError:
                self._emit("bad_json")
                continue
            data = env.get("data") if isinstance(env, dict) else None
            if data is None:
                continue
            self.on_message(env.get("stream", ""), data, recv_ms)

    async def run(self):
        attempt = 0
        while not self._stop.is_set():
            host = self.hosts[self.host_i % len(self.hosts)]
            t_try = time.monotonic()
            reason, got = "unknown", 0
            try:
                async with websockets.connect(self.url(host), open_timeout=self.open_timeout, ping_interval=self.ping_interval, ping_timeout=self.ping_timeout,
                                              close_timeout=3, compression=None, max_size=2 ** 20) as ws:
                    self.ws = ws
                    self.connects += 1
                    t_conn = time.monotonic()
                    state = {"last": t_conn, "n": 0}
                    self._emit("connected", host=host, connect_ms=round((t_conn - t_try) * 1000), attempt=attempt)
                    reader = asyncio.create_task(self._reader(ws, state))
                    stop_wait = asyncio.create_task(self._stop.wait())
                    try:
                        while True:
                            if reader.done():
                                exc = reader.exception() if not reader.cancelled() else None
                                reason = "closed:" + (type(exc).__name__ if exc else "eof")
                                break
                            if self._stop.is_set():
                                reason = "stop"
                                break
                            now = time.monotonic()
                            if self._chaos:
                                reason = self._chaos
                                self._chaos = None
                                ws.transport.abort()
                                break
                            if now - state["last"] > self.stale_s:
                                reason = "stale"
                                break
                            if now - t_conn > self.max_conn_s:
                                reason = "max_age"
                                break
                            await asyncio.wait({reader, stop_wait}, timeout=0.25, return_when=asyncio.FIRST_COMPLETED)
                    finally:
                        stop_wait.cancel()
                        if not reader.done():
                            reader.cancel()
                        await asyncio.gather(reader, stop_wait, return_exceptions=True)
                    got = state["n"]
                    life = time.monotonic() - t_conn
                    if reason == "stop":
                        try:
                            await ws.close(1000)
                        except Exception:  # noqa: BLE001
                            pass
                    self._emit("disconnected", host=host, reason=reason, messages=got, lifetime_s=round(life, 1))
                    self.ws = None
                    if got > 0 and life > 30:
                        attempt = 0                                          # з'єднання було здоровим: паузу скидаємо
                    if reason == "max_age":
                        attempt = 0
                        continue                                             # планова ротація без паузи
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001 — будь-яка помилка підключення: пауза й спроба на іншому хості
                self.failures += 1
                reason = "connect_failed:" + type(e).__name__
                self._emit("connect_failed", host=host, error=(type(e).__name__ + ": " + str(e))[:160])
            if self._stop.is_set():
                break
            attempt += 1
            if reason.startswith("connect_failed") or got == 0:
                self.host_i += 1                                             # хост не віддає даних: пробуємо наступний
            wait = self.next_backoff(attempt)
            self._emit("backoff", seconds=round(wait, 2), attempt=attempt)
            await self._sleep(wait)
        self._emit("stopped", connects=self.connects, messages=self.messages)
