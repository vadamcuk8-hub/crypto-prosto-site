# Крипто простими словами: як влаштовано проєкт

Статичний сайт (HTML, CSS, JS) + Python-агент новин. Бекенду немає.

## Файли
| Що | Файли |
|---|---|
| Сторінки | `index.html` (головна: панель із 8 віджетів), `learn.html` (довідка: пояснення, глосарій, запитання), `market.html` (ринок), `news.html` (новини), `analytics.html` (аналітика), `sources.html` (каталог джерел), `news-*.html` (окремі новини) |
| Стилі | `style.css` (змінні — на початку файлу) |
| Скрипти | `core.js` (усі сторінки), `charts.js` (малювання SVG-графіків) і `widgets.js` (панель головної), сторінка «Ринок» розбита на `market-live/charts/calc/heatmap/alerts.js` + `market.js` (запуск), `news.js`, `learn.js` (довідка), `feed.js`, `analytics.js`, `agent-ui.js` (спільне для сторінок з даними агентів), `chartbg.js` (фон головної) |
| Агенти | `tools/run_agents.py` запускає окремих агентів із `tools/agents/` (ринок, настрій, стейблкоїни, мережа біткоїна, регулювання) та `tools/news_agent.py` (новини й аналітика; джерела, теми й словники — у `tools/news_config.py`; спільні `fetch`/`log`/`write_json` — у `tools/agents/common.py`; переклад у `tools/translator.py`); кожен пише власний файл у `data/` |
| Збірка | `tools/build.py`, шаблони шапки й підвалу в `tools/partials/` |

## Щоденна робота
- **Змінити меню чи підвал:** відредагуйте `tools/partials/header.html` або `footer.html` (пункти меню — у `NAV` у `tools/build.py`), потім `python tools/build.py`.
- **Додати скрипт сторінці:** список у `PAGE_SCRIPTS` у `tools/build.py`, потім збірка.
- Збірка також дописує `?v=...` до CSS/JS: після змін браузер завжди бере свіжий файл. Запускайте її після будь-якої правки CSS чи JS.
- `python tools/build.py --check` показує, чи сторінки застаріли.
- Вміст сторінок (усе поза мітками `<!-- @header -->`, `<!-- @footer -->`, `<!-- @scripts -->`) редагується прямо в HTML.

## Запуск
- Сайт: `python -m http.server 8000`, відкрити http://localhost:8000
- Агенти: `start-agents.bat` (кожен оновлюється зі своєю періодичністю: ринок 5 хв, мережа 3 хв, новини 10 хв, настрій і стейблкоїни 30 хв, регулювання 1 год). Один агент окремо: `python tools/run_agents.py market`. Для перекладу якісним Claude задайте змінну середовища `ANTHROPIC_API_KEY` (ключ ніколи не кладіть у файли сайту).

## Публікація й автооновлення (GitHub Pages + Actions)
Ціни йдуть у браузері наживо (Binance). Решту даних щоп'ять–десять хвилин оновлює `.github/workflows/update-data.yml`: запускає `tools/run_agents.py` і комітить `data/*.json`.
1. Створіть репозиторій на GitHub і завантажте в нього проєкт (разом із папкою `.github`).
2. Settings → Pages → Source: «Deploy from a branch», гілка `main`, папка `/ (root)`.
3. Settings → Actions → General → Workflow permissions: «Read and write permissions».
4. Вкладка Actions → «Оновлення даних» → Run workflow (перший запуск вручну), далі працює за розкладом.
5. Необов'язково: Settings → Secrets and variables → Actions → секрет `ANTHROPIC_API_KEY` для якіснішого перекладу.
Обмеження: розклад GitHub інколи запізнюється на кілька хвилин, а найменший інтервал — 5 хвилин. Агент мережі (3 хв) тому оновлюється раз на запуск.
