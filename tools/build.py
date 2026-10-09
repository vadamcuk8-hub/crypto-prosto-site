#!/usr/bin/env python3
"""Збірка сайту: спільна шапка, підвал, підключення скриптів і версії файлів (проти застарілого кешу).

Що робить:
  • У кожній сторінці підставляє шапку й підвал із tools/partials/ між мітками
    <!-- @header -->…<!-- @/header -->, <!-- @footer -->…<!-- @/footer -->.
    У меню сама ставить aria-current для поточної сторінки.
  • Між мітками <!-- @scripts -->…<!-- @/scripts --> записує потрібні сторінці скрипти (список нижче, PAGE_SCRIPTS).
  • До локальних style.css / *.js додає ?v=<відбиток вмісту>: коли файл змінився, браузер точно візьме новий.

Коли запускати: після змін у tools/partials/*.html, у PAGE_SCRIPTS, у style.css чи будь-якому *.js.
  python tools/build.py          зібрати
  python tools/build.py --check  лише перевірити (код виходу 1, якщо сторінки застаріли): зручно перед публікацією
Контент самих сторінок (усе поза мітками) збірка не чіпає.
"""
import hashlib
import os
import re
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PARTIALS = os.path.join(ROOT, "tools", "partials")

# Які скрипти потрібні сторінці (порядок важливий: core.js завжди першим)
PAGE_SCRIPTS = {
    "index.html": ["core.js", "agent-ui.js", "charts.js", "widget-defs.js", "widgets.js", "home.js", "chartbg.js"],
    "agents.html": ["core.js", "agent-ui.js", "charts.js", "widget-defs.js", "widgets.js", "agents.js"],
    "learn.html": ["core.js", "learn.js"],
    "market.html": ["core.js", "market-live.js", "market-charts.js", "market-calc.js",
                    "market-heatmap.js", "market-alerts.js", "market.js"],
    "news.html": ["core.js", "news.js", "agent-ui.js", "feed.js"],
    "analytics.html": ["core.js", "agent-ui.js", "charts.js", "analytics.js", "signals.js"],
    "sources.html": ["core.js"],
}
DEFAULT_SCRIPTS = ["core.js"]          # решта сторінок (news-*.html)

# Підрозділ меню: сторінки новин підсвічують пункт «Новини»
NAV = [("index.html", "Головна"), ("market.html", "Ринок"), ("news.html", "Новини"), ("analytics.html", "Аналітика"), ("agents.html", "Агенти"), ("learn.html", "Довідка")]

# Іконки пунктів меню (контури 24×24, колір береться з тексту посилання)
ICONS = {
    "index.html": "M4 11l8-7 8 7v8a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z",
    "market.html": "M4 19V5M4 19h16M8 15l4-5 3 3 4-6",
    "news.html": "M5 5h11v14H7a2 2 0 0 1-2-2zM16 9h3v8a2 2 0 0 1-2 2M8 9h5M8 13h5",
    "analytics.html": "M5 20V10M12 20V4M19 20v-7",
    "agents.html": "M12 3v3M12 18v3M3 12h3M18 12h3M7 7l2 2M15 15l2 2M17 7l-2 2M9 15l-2 2M9 9h6v6H9z",
    "learn.html": "M4 5.5A1.5 1.5 0 0 1 5.5 4H12v15H5.5A1.5 1.5 0 0 0 4 20.5zM20 5.5A1.5 1.5 0 0 0 18.5 4H12v15h6.5a1.5 1.5 0 0 1 1.5 1.5z",
}
ICON_SVG = ('<svg class="nav-ico" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
            'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="%s"/></svg>')
SECTION_OF_PREFIX = {"news-": "news.html"}

ASSET_RX = re.compile(r'(?P<attr>href|src)="(?P<name>[\w.-]+\.(?:css|js))(?:\?v=[0-9a-f]+)?"')


def read(path):
    with open(path, encoding="utf-8", newline=None) as f:
        return f.read()


def write(path, text):
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)


def file_hash(name):
    p = os.path.join(ROOT, name)
    if not os.path.exists(p):
        return None
    with open(p, "rb") as f:
        return hashlib.sha1(f.read().replace(b"\r\n", b"\n")).hexdigest()[:8]


def render_header(page):
    tpl = read(os.path.join(PARTIALS, "header.html")).rstrip("\n")
    section = next((target for prefix, target in SECTION_OF_PREFIX.items() if page.startswith(prefix)), None)
    links = []
    for href, label in NAV:
        mark = ""
        if href == page:
            mark = ' aria-current="page"'
        elif href == section:
            mark = ' aria-current="true"'
        links.append('      <a href="%s"%s>%s<span>%s</span></a>' % (href, mark, ICON_SVG % ICONS[href], label))
    return tpl.replace("{{nav}}", "\n".join(links))


def render_scripts(page):
    names = PAGE_SCRIPTS.get(page, DEFAULT_SCRIPTS)
    return "\n".join('  <script src="%s"></script>' % n for n in names)


def block(text, name, content):
    rx = re.compile(r"<!-- @%s -->.*?<!-- @/%s -->" % (name, name), re.S)
    if not rx.search(text):
        raise SystemExit("У сторінці немає мітки @%s" % name)
    return rx.sub(lambda m: "<!-- @%s -->\n%s\n  <!-- @/%s -->" % (name, content, name), text, count=1)


def version_assets(text):
    def sub(m):
        h = file_hash(m.group("name"))
        return '%s="%s%s"' % (m.group("attr"), m.group("name"), ("?v=" + h) if h else "")
    return ASSET_RX.sub(sub, text)


def build_page(page):
    text = read(os.path.join(ROOT, page))
    footer = read(os.path.join(PARTIALS, "footer.html")).rstrip("\n")
    text = block(text, "header", render_header(page))
    text = block(text, "footer", footer)
    text = block(text, "scripts", render_scripts(page))
    return version_assets(text)


def main():
    check = "--check" in sys.argv
    stale, built = [], 0
    for name in sorted(os.listdir(ROOT)):
        if not name.endswith(".html"):
            continue
        old = read(os.path.join(ROOT, name))
        new = build_page(name)
        built += 1
        if new != old:
            stale.append(name)
            if not check:
                write(os.path.join(ROOT, name), new)
    if check:
        print("Застарілі сторінки: %s" % (", ".join(stale) if stale else "немає"))
        sys.exit(1 if stale else 0)
    print("Перевірено сторінок: %d, оновлено: %d%s" % (built, len(stale), (" (" + ", ".join(stale) + ")") if stale else ""))


if __name__ == "__main__":
    main()
