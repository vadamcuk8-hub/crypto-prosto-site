"""Зсув годинника відносно сервера Binance (GET /api/v3/time). Затримка = локальний час отримання + зсув − час події біржі.
Точність оцінки обмежена половиною RTT найкращого зразка (error_ms). Щоб RTT був малим, усі зразки йдуть однією постійною HTTPS-сполукою
(без повторного TLS-рукостискання), а береться зразок із мінімальним RTT. Разом зі скоригованою затримкою рекомендується дивитись і «сирий» вимір
(без поправки): якщо годинник ПК синхронізований із NTP, він близький до правди."""
import asyncio
import http.client
import json
import time

REST_HOSTS = ("data-api.binance.vision", "api.binance.com")


def measure_offset_sync(samples=20, hosts=REST_HOSTS, timeout=5):
    """Повертає {offset_ms, rtt_ms, error_ms, host, samples} за зразком із мінімальним RTT або None, якщо REST недоступний."""
    for host in hosts:
        conn = None
        best, got = None, 0
        try:
            conn = http.client.HTTPSConnection(host, timeout=timeout)
            for i in range(samples):
                t0 = time.time() * 1000
                conn.request("GET", "/api/v3/time", headers={"User-Agent": "live2-prototype"})
                resp = conn.getresponse()
                srv = json.loads(resp.read().decode())["serverTime"]
                t1 = time.time() * 1000
                if i == 0:
                    continue                                    # перший запит містить TLS-рукостискання: у вибірку не береться
                got += 1
                rtt = t1 - t0
                off = srv - (t0 + t1) / 2.0
                if best is None or rtt < best[1]:
                    best = (off, rtt)
        except Exception:  # noqa: BLE001 — пробуємо наступний хост
            pass
        finally:
            try:
                conn and conn.close()
            except Exception:  # noqa: BLE001
                pass
        if best:
            return {"offset_ms": best[0], "rtt_ms": best[1], "error_ms": best[1] / 2.0, "host": host, "samples": got}
    return None


async def measure_offset(**kw):
    return await asyncio.to_thread(measure_offset_sync, **kw)
