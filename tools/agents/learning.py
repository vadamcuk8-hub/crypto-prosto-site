"""Самонавчання агента «Картина»: перевіряє власні оцінки на реальних цінах і обережно підлаштовує ваги чинників.

Як це працює:
  1. Кожні log_every_hours годин агент записує по кожній монеті свою оцінку, її чинники й поточну ціну (журнал).
  2. Коли минає horizon_hours, оцінку порівнюють із фактичною зміною ціни: чинник «влучив», якщо його знак збігся зі знаком руху.
  3. Для чинника, який має щонайменше min_samples перевірок, вага зсувається до результату: вищий відсоток збігів, більша вага
     (зсув не більший за max_shift від базової ваги, згладжування smooth, не нижче floor). Менше спостережень, вага не змінюється.
  4. Журнал самоочищується: записи старші за keep_days видаляються.
Це проста статистика, а не штучний інтелект, і ринок шумний: короткі вибірки можуть давати випадкові результати, тому зміни повільні й обмежені."""
from datetime import datetime, timedelta


def sign(v, eps):
    return 1 if v > eps else -1 if v < -eps else 0


def evaluate(log, prices, now, th):
    """Закриває записи, у яких минув горизонт: рахує фактичну зміну ціни. Дуже старі (агент довго не працював) закриває без оцінки."""
    horizon = timedelta(hours=th["horizon_hours"])
    for e in log:
        if e.get("done"):
            continue
        age = now - datetime.fromisoformat(e["t"])
        if age < horizon:
            continue
        p = prices.get(e["s"])
        if p and e["p"] and age < horizon * 2:
            e["fwd"] = round(100 * (p / e["p"] - 1), 2)
        e["done"] = True
    return log


def hit_stats(log, th):
    """По кожному чиннику: скільки перевірок і який відсоток збігів напряму (плоскі рухи й слабкі чинники не рахуємо)."""
    stats = {}
    for e in log:
        if not e.get("done") or e.get("fwd") is None or abs(e["fwd"]) < th["flat_move_pct"]:
            continue
        fs = sign(e["fwd"], 0)
        for name, val in e["c"].items():
            if abs(val) < th["signal_min"]:
                continue
            s = stats.setdefault(name, {"n": 0, "hit": 0})
            s["n"] += 1
            s["hit"] += sign(val, 0) == fs
    for s in stats.values():
        s["pct"] = round(100 * s["hit"] / s["n"]) if s["n"] else None
    return stats


def update_weights(base, prev, stats, th):
    """Нові ваги: зсув до результату чинника в межах ±max_shift від базової, плавно (smooth). Чинники без даних лишаються як були."""
    out = {}
    for name, b in base.items():
        p = prev.get(name, b)
        s = stats.get(name)
        if s and s["n"] >= th["min_samples"]:
            edge = (s["pct"] - 50) / 50.0
            target = b * (1 + max(-th["max_shift"], min(th["max_shift"], edge)))
            p = (1 - th["smooth"]) * p + th["smooth"] * target
        out[name] = round(max(th["floor"], p), 4)
    return out


def append_entries(log, coins, now, th):
    """Нові записи по монетах (не частіше, ніж раз на log_every_hours) і очищення старих."""
    gap = timedelta(hours=th["log_every_hours"])
    last = {}
    for e in log:
        t = datetime.fromisoformat(e["t"])
        if e["s"] not in last or t > last[e["s"]]:
            last[e["s"]] = t
    for c in coins:
        if c["s"] in last and now - last[c["s"]] < gap:
            continue
        log.append({"t": now.isoformat(), "s": c["s"], "p": c["p"], "sc": c["sc"], "c": c["c"]})
    cutoff = now - timedelta(days=th["keep_days"])
    return [e for e in log if datetime.fromisoformat(e["t"]) >= cutoff]
