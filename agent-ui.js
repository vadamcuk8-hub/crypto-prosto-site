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

const HELP =
  "Дані ще не створено або сторінку відкрито не через сервер. " +
  "Запустіть файл start-agents.bat (він читає новини й створює папку data), " +
  "а сайт відкривайте через локальний сервер (python -m http.server 8000).";
