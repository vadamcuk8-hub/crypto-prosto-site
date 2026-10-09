"""Налаштування новинного агента: джерела, теми, монети, словники та шаблони пояснень.
Змінювати поведінку агента (додати видання, тему, монету) варто тут, а не в news_agent.py."""
import re

KEEP_DAYS = 7          # скільки днів тримати історію
MAX_OUT = 200          # скільки новин віддавати сайту

# Джерела. weight — надійність 1-5 (за каталогом джерел на сайті), strict — суворіший відбір за темою
SOURCES = [
    {"id": "coindesk", "name": "CoinDesk", "url": "https://www.coindesk.com/arc/outboundfeeds/rss", "lang": "en", "weight": 4},
    {"id": "theblock", "name": "The Block", "url": "https://www.theblock.co/rss.xml", "lang": "en", "weight": 4},
    {"id": "decrypt", "name": "Decrypt", "url": "https://decrypt.co/feed", "lang": "en", "weight": 3.5},
    {"id": "cointelegraph", "name": "Cointelegraph", "url": "https://cointelegraph.com/rss", "lang": "en", "weight": 3},
    {"id": "bitcoinmagazine", "name": "Bitcoin Magazine", "url": "https://bitcoinmagazine.com/feed", "lang": "en", "weight": 3},
    {"id": "forklog", "name": "Forklog UA", "url": "https://forklog.com.ua/feed/", "lang": "uk", "weight": 3.5},
    # Загальні українські видання: беремо лише матеріали про крипто (решту відсіює фільтр теми)
    {"id": "itc", "name": "ITC.ua", "url": "https://itc.ua/ua/feed/", "lang": "uk", "weight": 3},
    {"id": "rbc", "name": "РБК-Україна", "url": "https://www.rbc.ua/static/rss/all.ukr.rss.xml", "lang": "uk", "weight": 3},
    {"id": "sec", "name": "SEC (США)", "url": "https://www.sec.gov/news/pressreleases.rss", "lang": "en", "weight": 5,
     "official": True, "strict": True},
    {"id": "fedreg", "name": "Federal Register", "kind": "fedreg", "lang": "en", "weight": 5, "official": True, "strict": True,
     "url": "https://www.federalregister.gov/api/v1/documents.json?conditions[term]=crypto&order=newest&per_page=15"},
]

TOPIC_LABELS = {
    "regulation": "Регулювання",
    "investment": "Інвестиції",
    "market": "Ринок",
    "stablecoins": "Стейблкоїни",
    "institutions": "Інституції",
    "security": "Безпека",
    "tech": "Технології",
    "other": "Інше",
}

# Теми за пріоритетом: перша, що збіглась, стає головною
TOPIC_RULES = [
    ("security", r"\b(hack|hacked|exploit|stolen|theft|scam|phishing|breach|drain|rug ?pull|ransom|fraud)\w*|злам|шахрай|викрад"),
    ("regulation", r"\b(sec|cftc|regulat\w*|lawmaker|senate|congress|bill|law|legislat\w*|court|lawsuit|sues?|ban|licen[sc]e|mica|treasury|central bank|cbdc|imf|fatf|compliance|sanction\w*|tax)\b|регулюв|закон|законопроєкт|суд|ліценз|нбу|санкц|\b(supreme court|scotus|prediction markets?|kalshi|polymarket|lawmakers?)\b"),
    ("stablecoins", r"\b(stablecoin\w*|usdt|usdc|tether|circle|pyusd|genius act)\b|стейблкоїн"),
    ("institutions", r"\b(institution\w*|custody|tokeni[sz]\w*|wall street|jpmorgan|fidelity|standard chartered|blackrock|goldman|morgan stanley|asset manager\w*|banks?|treasur(y|ies) companies|cme|nasdaq)\b|інституц|банк"),
    ("investment", r"\b(raise[sd]? (?:\$|[0-9]|seed|series|funding|capital)|funding|series [a-d]|seed round|valuation|invest\w*|acquir\w*|acquisition|ipo|merger|venture|backed|stake in)\b|інвестиц|раунд|залуч|придба"),
    ("market", r"\b(live updates|trading range|nears|pulls? back|analysts?|forecast\w*|momentum|price|rall(y|ies)|drop\w*|surge\w*|plunge\w*|slump\w*|etf|inflows?|outflows?|futures|liquidat\w*|traders?|bull\w*|bear\w*|all-time high|ath|market cap)\b|ціна|курс|ринок|падінн|зростання"),
    ("tech", r"\b(upgrade|protocol|layer[- ]?2|mainnet|testnet|ethereum|solana|node|fork|developer\w*|wallet|airdrop|launch\w*)\b|оновлення|мережа"),
]

COINS = {
    "BTC": r"\b(bitcoin|btc|microstrategy|saylor|bitfinex)\b|біткоїн",
    "ETH": r"\b(ethereum|ether|eth)\b|ефіріум",
    "SOL": r"\b(solana|sol)\b",
    "XRP": r"\b(xrp|ripple)\b",
    "USDT": r"\b(tether|usdt)\b",
    "USDC": r"\b(usdc|circle)\b",
    "DOGE": r"\b(doge|dogecoin)\b",
    "BNB": r"\b(bnb|binance coin)\b",
    "ADA": r"\b(cardano|ada)\b",
    "SUI": r"\bsui\b",
}

# Назви монет для підказки «Вплив на ринок» і пара на біржі Binance для знімка цін
COIN_INFO = {
    "BTC": ("Біткоїн", "BTCUSDT"), "ETH": ("Ефіріум", "ETHUSDT"), "SOL": ("Solana", "SOLUSDT"),
    "XRP": ("XRP", "XRPUSDT"), "USDT": ("Tether (стейблкоїн)", None), "USDC": ("USDC (стейблкоїн)", None),
    "DOGE": ("Dogecoin", "DOGEUSDT"), "BNB": ("BNB", "BNBUSDT"), "ADA": ("Cardano", "ADAUSDT"), "SUI": ("Sui", "SUIUSDT"),
}

# Шаблони пояснення впливу: тема × тон. {c} — перелік монет. Це правила-орієнтири, а не прогноз.
IMPACT_TEXT = {
    "regulation": {
        "negative": "Жорсткіші правила, судові чи регуляторні ризики зазвичай підвищують невизначеність: ринок може реагувати обережністю або падінням, найбільше для {c}.",
        "positive": "Прозоріші правила або схвалення зазвичай знижують ризики для учасників і можуть підтримати інтерес до {c}.",
        "neutral": "Регуляторна новина: наслідки залежать від остаточних рішень, тому ринок зазвичай чекає на ясність. Стосується {c}.",
    },
    "investment": {
        "negative": "Складнощі з фінансуванням можуть охолоджувати інтерес до галузі, але прямий вплив на ціну {c} зазвичай невеликий.",
        "positive": "Нові гроші в компанії й проєкти показують інтерес інвесторів до галузі. Для ціни {c} прямого впливу зазвичай немає, зате це сигнал для сектору.",
        "neutral": "Новина про інвестиції: це сигнал про настрій у галузі, а не причина для різкого руху ціни {c}.",
    },
    "market": {
        "negative": "Це вже рух цін: падіння провідних монет, особливо біткоїна, часто тягне вниз і решту ринку. Стосується {c}.",
        "positive": "Це вже рух цін: зростання провідних монет часто підтягує й інші. Стосується {c}, але розвороти бувають різкими.",
        "neutral": "Огляд ринкової ситуації для {c}: дивіться зміну цін нижче й не спирайтеся на один заголовок.",
    },
    "stablecoins": {
        "negative": "Проблеми зі стейблкоїнами підривають довіру до всього сектору й можуть призводити до відтоку коштів. Стосується {c}.",
        "positive": "Нові правила й ліцензії для стейблкоїнів зазвичай зміцнюють довіру до платежів у крипто. Стосується {c}.",
        "neutral": "Новина про стейблкоїни: вони потрібні як «міст» між грошима й криптою, тому зміни впливають на обсяги торгів і платежі. Стосується {c}.",
    },
    "security": {
        "negative": "Зломи й шахрайство підривають довіру до постраждалої платформи та можуть тиснути на ціну пов’язаних токенів. Для ринку загалом вплив зазвичай обмежений, якщо суми невеликі. Стосується {c}.",
        "positive": "Новина про посилення безпеки зменшує ризики для користувачів. Стосується {c}.",
        "neutral": "Новина про безпеку: перевірте, чи стосується вона сервісів, якими ви користуєтесь. Стосується {c}.",
    },
    "institutions": {
        "negative": "Відхід чи обережність великих гравців може зменшити приплив грошей на ринок. Стосується {c}.",
        "positive": "Участь великих банків і фондів зазвичай вважають ознакою зрілості ринку; на ціну {c} вплив часто через очікування, а не одразу.",
        "neutral": "Великі фінансові установи розвивають крипто-послуги: це довгостроковий фактор для {c}, а не причина різких рухів.",
    },
    "tech": {
        "negative": "Технічні збої чи затримки можуть знижувати довіру до проєкту. Стосується {c}.",
        "positive": "Технічні покращення працюють насамперед на довгострокову цінність {c}; короткострокова реакція ціни не гарантована.",
        "neutral": "Технічна новина: зазвичай впливає на {c} у довгостроковій перспективі, а не одразу на ціну.",
    },
    "other": {
        "negative": "Новина загального характеру з негативним відтінком: прямого впливу на ціни не видно. Стосується {c}.",
        "positive": "Новина загального характеру з позитивним відтінком: прямого впливу на ціни не видно. Стосується {c}.",
        "neutral": "Новина загального характеру: прямого впливу на ціни не видно. Стосується {c}.",
    },
}

POSITIVE = r"\b(surge\w*|rall(y|ies|ied)|soar\w*|jump\w*|gain\w*|record|approv\w*|adopt\w*|inflows?|growth|bullish|rise[sn]?|rising|upgrade|partnership|launch\w*|wins?|boost\w*|recover\w*)\b|зростан|схвал|рекорд"
NEGATIVE = r"\b(crash\w*|plunge\w*|drop\w*|fall\w*|fell|slump\w*|hack\w*|exploit\w*|stolen|ban\w*|lawsuit|sues?|charge[sd]?|fraud|scam|bearish|outflows?|liquidat\w*|collapse\w*|bankrupt\w*|fine[sd]?|probe|investigat\w*|warn\w*|loss(es)?|down)\b|падінн|злам|шахрай|штраф|втрат"

# Реклама й «хайп»: такі матеріали відсіюються з основної стрічки
HYPE = re.compile(
    r"sponsored|partner content|presented by|advertorial|price prediction|could (soar|explode|skyrocket)|to the moon|"
    r"(top|best) \d* ?(crypto|coins?|altcoins?|tokens?) to (buy|watch|invest)|100x|1000x|next bitcoin|"
    r"buy now|don'?t miss|last chance|guaranteed|airdrop (guide|alert)|presale|"
    r"прогноз ціни|купуй зараз|останній шанс|гарантован",
    re.I,
)

CRYPTO = re.compile(
    r"\b(crypto\w*|bitcoin|btc|ethereum|blockchain|stablecoin\w*|token\w*|defi|nft|altcoin\w*|digital assets?|web3|"
    r"binance|coinbase|solana|xrp|ether|eth|tether|circle|satoshi|cardano|bnb|sui|lightning network|onchain|on-chain|miner\w*|"
    r"dogecoin|kalshi|polymarket|bitfinex|ledger|dao)\b|крипт|біткоїн|блокчейн|стейблкоїн|токен|ефіріум",
    re.I,
)
STOP = set("the a an and or of to in on for with from by at as is are was were be will would new says say after over amid "
           "into its it this that about more than up out how why what who not has have had their his her you your "
           "и в на з із до що як для про від та або це".split())
