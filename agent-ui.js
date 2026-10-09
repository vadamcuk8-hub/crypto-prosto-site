// Спільне для сторінок, що читають дані новинного агента (feed.js — жива стрічка, analytics.js — аналітика).
// Дані готує tools/news_agent.py у файли data/news.json та data/analytics.json.
// Увага: усі тексти з новин вставляються через textContent, а не innerHTML,
// бо вони приходять із зовнішніх сайтів, і вставляти їх як HTML небезпечно.

const REFRESH_MS = 60000;   // перевіряємо нові дані щохвилини
const STALE_HOURS = 2;      // після цього часу попереджаємо, що агент давно не запускався

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function safeUrl(u) {
  return /^https?:\/\//i.test(u || "") ? u : "#";
}

function ago(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 90) return "щойно";
  if (s < 3600) return Math.round(s / 60) + " хв тому";
  if (s < 86400) return Math.round(s / 3600) + " год тому";
  return Math.round(s / 86400) + " дн. тому";
}

// Дані з файлу агента. «no-cache» не вимикає кеш, а змушує браузер спитати сервер, чи файл змінився:
// якщо ні, сервер відповідає коротким «304», і файл не завантажується вдруге.
async function loadJson(path) {
  const r = await fetch(path, { cache: "no-cache" });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}

// Агент вважається застарілим, якщо від його останнього успішного запуску минуло втричі більше за його інтервал,
// але не менше ніж STALE_MIN_S: на GitHub усі агенти запускаються за розкладом раз на ~10 хвилин (з можливими затримками).
const STALE_MIN_S = 2700;

function isStale(st, iso) {
  if (!iso) return true;
  const age = (Date.now() - new Date(iso).getTime()) / 1000;
  return age > Math.max(((st && st.interval) || 0) * 3, STALE_MIN_S);
}

// Стан одного агента за даними data/agents.json: "ok" | "stale" | "failed" | "none"
function agentState(st) {
  if (!st) return "none";
  if (!st.ok) return "failed";
  return isStale(st, st.last_ok) ? "stale" : "ok";
}

// Загальний рядок над панеллю: найстаріше оновлення серед агентів і скільки з них працює
function renderFreshness(node, agents) {
  const list = agents && agents.agents ? Object.keys(agents.agents).map(function (k) { return agents.agents[k]; }) : [];
  node.replaceChildren();
  if (!list.length) {
    node.className = "freshness bad";
    node.textContent = "Дані ще не створено: запустіть агентів (start-agents.bat) або дочекайтеся автооновлення.";
    return;
  }
  const good = list.filter(function (s) { return agentState(s) === "ok"; }).length;
  const times = list.map(function (s) { return s.last_ok; }).filter(Boolean).sort();
  node.className = "freshness" + (good === list.length ? "" : " bad");
  node.appendChild(el("span", "freshness-dot"));
  node.appendChild(document.createTextNode(
    (times.length ? "Дані оновлено " + ago(times[0]) : "Дані ще не оновлювалися") + " · агентів без проблем: " + good + " з " + list.length + " · "));
  const a = el("a", "", "докладно про кожного агента");
  a.href = "agents.html";
  node.appendChild(a);
}

const HELP =
  "Дані ще не створено або сторінку відкрито не через сервер. " +
  "Запустіть файл start-agents.bat (він читає новини й створює папку data), " +
  "а сайт відкривайте через локальний сервер (python -m http.server 8000).";
