"""Тіньовий рушій, режим A («сумісність»): ті самі 16 стратегій і 3 незалежні гаманці (48 рахунків), що й основна симуляція,
але стан і журнал у власному сховищі prototypes/live2/state/<ім'я>/ (або в пам'яті). Основні файли, гілка data, баланси, позиції й раунди не чіпаються.

Логіка рішень НЕ дублюється: викликається чинний agent_simulation.paper_wallets (через engine_bridge, зі сховищем замість файлів).
Режим B (прискорені стопи, потокові сканери) — окремий модуль; статистика режимів не змішується (поле mode у кожному сховищі)."""
import copy
import json
import os
import time

from . import engine_bridge as eb


class ShadowEngine:
    def __init__(self, kb=None, sk=None, store=None, books=None, name=None, mode="A"):
        self.kb = kb or eb.load_kb()
        self.sk = sk or eb.load_signals_kb()
        self.store = store or eb.MemStore()
        self.books = books if books is not None else {}
        self.mode = mode
        self.name = name
        self.last_result = None
        self.step_times = []

    # ---- життєвий цикл ----
    @classmethod
    def from_dir(cls, name, **kw):
        d = os.path.join(eb.STATE_DIR, name)
        eng = cls(store=eb.MemStore.from_dir(d), name=name, **kw)
        meta = os.path.join(d, "_shadow_meta.json")
        if os.path.exists(meta):
            with open(meta, encoding="utf-8") as f:
                eng.mode = json.load(f).get("mode", eng.mode)
        return eng

    def save(self):
        if not self.name:
            raise ValueError("для збереження потрібне ім'я")
        d = os.path.join(eb.STATE_DIR, self.name)
        self.store.dump(d)
        with open(os.path.join(d, "_shadow_meta.json"), "w", encoding="utf-8") as f:
            json.dump({"mode": self.mode, "saved_at": time.time()}, f)

    # ---- крок ----
    def step(self, ptf, now):
        """Один «запуск» рушія за вхідними свічками ptf у момент now (UTC, aware). Повертає результат paper_wallets; час кроку в step_times."""
        t0 = time.perf_counter()
        with eb.patched(self.store, books=self.books) as S:
            res = S.paper_wallets(copy.copy(ptf), self.kb, now)
        self.step_times.append(time.perf_counter() - t0)
        self.last_result = res
        return res
