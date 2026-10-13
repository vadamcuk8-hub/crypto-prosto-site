"""Статистика затримок і частоти: лише пам'ять, без файлів. Відсотки — за методом найближчого рангу, щоб p99 був реальним виміряним значенням."""
import math
import random


def percentile(sorted_vals, p):
    """p у 0..100; sorted_vals уже відсортований за зростанням. Порожній список → None."""
    if not sorted_vals:
        return None
    k = max(0, min(len(sorted_vals) - 1, math.ceil(p / 100.0 * len(sorted_vals)) - 1))
    return sorted_vals[k]


class Reservoir:
    """Вибірка обмеженого розміру (reservoir sampling): пам'ять не росте безмежно за години роботи, а відсотки лишаються репрезентативними."""

    def __init__(self, cap=100000, seed=1):
        self.cap, self.n, self.vals, self._rnd = cap, 0, [], random.Random(seed)
        self.min = self.max = None
        self.sum = 0.0

    def add(self, v):
        self.n += 1
        self.sum += v
        self.min = v if self.min is None or v < self.min else self.min
        self.max = v if self.max is None or v > self.max else self.max
        if len(self.vals) < self.cap:
            self.vals.append(v)
        else:
            j = self._rnd.randrange(self.n)
            if j < self.cap:
                self.vals[j] = v

    def summary(self, nd=1):
        if not self.n:
            return {"n": 0}
        s = sorted(self.vals)
        r = lambda x: None if x is None else round(x, nd)
        return {"n": self.n, "min": r(self.min), "p50": r(percentile(s, 50)), "p90": r(percentile(s, 90)), "p99": r(percentile(s, 99)), "max": r(self.max), "mean": r(self.sum / self.n)}
