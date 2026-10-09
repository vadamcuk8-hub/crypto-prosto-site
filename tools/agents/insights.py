"""Спільне для аналітичних висновків агентів: форматування чисел українською й тексти з бази знань.

Кожен агент має файл knowledge/<агент>.json з двома розділами:
  thresholds — пороги (наприклад, «сильний рух ринку — від 3%»);
  texts      — шаблони речень із місцями для чисел: {chg}, {dom} тощо.
Так і межі, і формулювання висновків можна змінювати без програмування.
Висновок — це {"tone": "positive" | "negative" | "neutral", "text": "..."}; сайт показує їх на вкладці агента."""
from .common import load_knowledge

NBSP = " "


def num(v, digits=0):
    """1234567.8 → «1 234 568» (пробіл між тисячами, кома для десяткових)."""
    s = ("{:,.%df}" % digits).format(v)
    return s.replace(",", NBSP).replace(".", ",")


def pct(v, digits=1, signed=True):
    """3.456 → «+3,5%»."""
    return ("%s" % ("+" if signed and v > 0 else "")) + num(v, digits) + "%"


def plural(n, one, few, many):
    """Відмінювання за числом: 1 пункт, 2 пункти, 5 пунктів."""
    n = abs(int(round(n)))
    if n % 100 in (11, 12, 13, 14):
        return many
    return one if n % 10 == 1 else few if n % 10 in (2, 3, 4) else many


def usd(v):
    """3.25e12 → «3,25 трлн $», 8.2e9 → «8,2 млрд $», 4.5e6 → «5 млн $»."""
    if v >= 1e12:
        return num(v / 1e12, 2) + " трлн $"
    if v >= 1e9:
        return num(v / 1e9, 1) + " млрд $"
    return num(v / 1e6, 0) + " млн $"


def item(tone, text):
    return {"tone": tone, "text": text}


class Rules:
    """Пороги й тексти одного агента з бази знань."""

    def __init__(self, agent):
        kb = load_knowledge(agent)
        self.thr = kb["thresholds"]
        self.texts = kb["texts"]

    def say(self, tone, key, **v):
        return item(tone, self.texts[key].format(**v))
