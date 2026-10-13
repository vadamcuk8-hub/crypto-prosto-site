"""Генерує docs/C20_ACCOUNTS_RESULTS.md з еталонних записів tests/golden/c20/*.json (48 рахунків × варіанти)."""
import datetime as dt
import json
import os
import statistics

from . import c20, datasets


def fmt(ms):
    return dt.datetime.fromtimestamp(ms / 1000, dt.timezone.utc).strftime("%Y-%m-%d %H:%M")


def main():
    lines = ["# C2.0 · Результати чинного рушія на еталонних наборах: 48 рахунків", "",
             "Джерело: ЧИННИЙ рушій без змін, відтворення на реальних даних Binance (див. STAGE_C20_REPORT.md). Це еталон поведінки, а НЕ оцінка прибутковості: вікна короткі (36–96 год), "
             "кожен прогін стартує з нового раунду; комісія й проковзання — за правилами рушія (набори без книг використовують фіксоване проковзання 0,05 %, бо історичних книг заявок не існує).",
             "PnL = депозит × (equity − 1) за останньою оцінкою (відкриті позиції за живою ціною). Комісії й реалізований PnL — за збереженим журналом (до 40 подій на правило); "
             "знак «≤» означає, що журнал обрізано (подій збережено менше, ніж угод).", ""]
    summary = []
    for v in c20.VARIANTS:
        g = json.load(open(c20.golden_path(v), encoding="utf-8"))
        ds = datasets.load(g["dataset"])
        ts = c20.times_of(ds, c20.VARIANTS[v])
        tb = g["accounts_table"]
        extra = ""
        if g["kb_override"]:
            extra += "; конфігурація: " + json.dumps(g["kb_override"], ensure_ascii=False)
        if g["initial_state_sha256"]:
            extra += "; початковий стан непорожній (після перших 24 год D3)"
        lines += ["## %s: %s → %s UTC, %d кроків" % (v, fmt(ts[0]), fmt(ts[-1]), len(ts)), "", ds["meta"]["note"] + extra + ".", "",
                  "Відбиток підсумкового стану `%s`, таблиці `%s`." % (g["final_state_sha256"][:16], g["accounts_table_sha256"][:16]), "",
                  "| Гаманець | Стратегія | Equity | PnL, $ | Угод | Подій | Комісії, $ | Реаліз., $ | Макс. просідання | Відкр. поз. | Виходи |", "|---|---|---|---|---|---|---|---|---|---|---|"]
        for r in tb:
            op = sum(1 for p in r["positions"].values() if p["pos"])
            tr = "≤" if r["events_kept"] < (r["trades"] or 0) else ""
            exits = ", ".join("%s %d" % (k, n) for k, n in r["exit_reasons"].items()) or "—"
            lines.append("| %s | %s | %.4f | %+.2f | %s | %s%d | %s%.2f | %s%+.2f | %.2f%% | %d | %s |" % (r["wallet"], r["rule"], r["equity_fraction"], r["pnl_usd"], r["trades"], tr, r["events_kept"], tr, r["fees_usd"], tr, r["realized_usd"], r["max_drawdown"] * 100, op, exits))
        lines.append("")
        eqs = [r["equity_fraction"] for r in tb]
        summary.append("%-4s рахунків %2d | equity мін %.4f, медіана %.4f, макс %.4f | угод %5d | комісії $%8.2f | відкритих позицій %3d" % (
            v, len(tb), min(eqs), statistics.median(eqs), max(eqs), sum(r["trades"] for r in tb), sum(r["fees_usd"] for r in tb), sum(1 for r in tb for p in r["positions"].values() if p["pos"])))
    path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "docs", "C20_ACCOUNTS_RESULTS.md")
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    print("\n".join(summary))


if __name__ == "__main__":
    main()
