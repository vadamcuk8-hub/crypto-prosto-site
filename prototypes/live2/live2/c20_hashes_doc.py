"""Генерує docs/C20_HASHES.md: контрольні SHA-256 вхідних даних, еталонних результатів і файлів еталонів."""
import hashlib
import json
import os

from . import c20, datasets

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def fsha(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def main():
    L = ["# C2.0 · Контрольні SHA-256", "",
         "Вхідні дані й результати хешуються від КАНОНІЧНОГО JSON (ключі відсортовано, без пробілів), тому хеш не залежить від gzip-мітки часу. Повні значення — у `fixtures/c20/<id>/meta.json` і `tests/golden/c20/*.json`.", "",
         "## Вхідні дані наборів", "", "| Набір | klines (усі ряди) | kb (16 стратегій і параметри) | sk (ваги сигналів) | книги заявок | моменти оцінювання |", "|---|---|---|---|---|---|"]
    for n in ["D1", "D2", "D3", "D4", "D5", "D6"]:
        m = datasets.load(n)["meta"]["sha256"]
        L.append("| %s | `%s` | `%s` | `%s` | %s | `%s` |" % (n, m["klines"], m["kb"], m["sk"], "`%s`" % m["books"] if m["books"] else "немає (історичних книг не існує)", m["step_times"]))
    L += ["", "## Еталонні результати чинного рушія (за варіантами)", "", "| Варіант | Конфігурація (ефективна) | Початковий стан | Підсумковий стан (6 файлів) | Таблиця 48 рахунків | Кроків |", "|---|---|---|---|---|---|"]
    for v in c20.VARIANTS:
        g = json.load(open(c20.golden_path(v), encoding="utf-8"))
        L.append("| %s | `%s` | %s | `%s` | `%s` | %d |" % (v, g["kb_effective_sha256"], "`%s`" % g["initial_state_sha256"] if g["initial_state_sha256"] else "порожній (новий раунд)", g["final_state_sha256"], g["accounts_table_sha256"], g["n_steps"]))
    c = json.load(open(os.path.join(c20.GOLDEN_DIR, "costs_grid.json"), encoding="utf-8"))
    L += ["", "Ланцюжки відбитків стану й результату на кожному кроці — поля `step_state_sha256` і `step_result_sha256` у `tests/golden/c20/<варіант>.json` (перший розбіжний крок вказується в повідомленні тесту).", "",
          "## Інші еталони", "", "- Сітка `Costs` на реальних книгах D4 (%d значень): `%s`" % (c["n"], c["grid_sha256"]),
          "- Хеші вихідного коду 18 ключових функцій: файл `tests/golden/engine_hashes.json`, SHA-256 файла `%s`" % fsha(os.path.join(HERE, "tests", "golden", "engine_hashes.json")), "", "## SHA-256 файлів еталонів (байти)", "", "| Файл | SHA-256 |", "|---|---|"]
    for fn in sorted(os.listdir(c20.GOLDEN_DIR)):
        L.append("| tests/golden/c20/%s | `%s` |" % (fn, fsha(os.path.join(c20.GOLDEN_DIR, fn))))
    for n in ["D1", "D2", "D3", "D4", "D5", "D6"]:
        for fn in sorted(os.listdir(os.path.join(datasets.C20_DIR, n))):
            L.append("| fixtures/c20/%s/%s | `%s` |" % (n, fn, fsha(os.path.join(datasets.C20_DIR, n, fn))))
    L.append("| fixtures/c20/D3w_initial/* (6 файлів, канонічно) | `%s` |" % c20.initial_sha(c20.VARIANTS["D3w"]))
    with open(os.path.join(HERE, "docs", "C20_HASHES.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(L) + "\n")
    print("ok", len(L))


if __name__ == "__main__":
    main()
