"""Книга останніх цін у пам'яті з перевіркою актуальності: майбутній рушій не повинен діяти за застарілою ціною."""
import time


class PriceBook:
    def __init__(self, clock=time.time):
        self._p = {}
        self._clock = clock

    def update(self, sym, price, event_ms, recv_ms):
        cur = self._p.get(sym)
        if cur and event_ms < cur["event_ms"]:
            return False                      # запізніле повідомлення не перезаписує новіше
        self._p[sym] = {"price": price, "event_ms": event_ms, "recv_ms": recv_ms}
        return True

    def get(self, sym):
        return self._p.get(sym)

    def age_ms(self, sym, now_ms=None):
        """Вік останнього повідомлення за ЛОКАЛЬНИМ годинником (час отримання): не залежить від зсуву годинника біржі."""
        cur = self._p.get(sym)
        if not cur:
            return None
        return (self._clock() * 1000 if now_ms is None else now_ms) - cur["recv_ms"]

    def stale(self, syms, max_age_ms, now_ms=None):
        """Монети без ціни або з ціною старшою за max_age_ms."""
        out = []
        for s in syms:
            a = self.age_ms(s, now_ms)
            if a is None or a > max_age_ms:
                out.append(s)
        return out

    def snapshot(self):
        return {s: dict(v) for s, v in self._p.items()}
