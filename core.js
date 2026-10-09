// Спільне для всіх сторінок: тема, меню, «Нагору», поява блоків, «Поділитися», підвал.
// Дані й логіка конкретних сторінок — в окремих файлах: market.js, news.js, home.js, feed.js, analytics.js.

const root = document.documentElement;

// ---------- Тема: сайт сам повторює налаштування системи (світла або темна) ----------
const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

function applyTheme() {
  root.setAttribute("data-theme", darkQuery.matches ? "dark" : "light");
  document.dispatchEvent(new Event("themechange"));   // модулі сторінок (наприклад, теплова карта) можуть оновити свої кольори
}

applyTheme();
if (darkQuery.addEventListener) darkQuery.addEventListener("change", applyTheme);

// ---------- Спільні помічники ----------

// Записує текст, лише якщо він відрізняється від поточного (щоб не змушувати браузер перебудовувати сторінку без потреби)
function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

// Ціна в доларах: «81 671 $» (для дешевих монет більше знаків після коми)
function fmtOnlyUsd(usd) {
  const digits = usd >= 100 ? 0 : usd >= 1 ? 2 : 4;
  return usd.toLocaleString("uk-UA", { minimumFractionDigits: digits, maximumFractionDigits: digits }) + " $";
}

// Зміна у відсотках зі знаком: «+2,35%» / «−4,10%»
function pct(n) {
  return (n >= 0 ? "+" : "−") + Math.abs(n).toFixed(2).replace(".", ",") + "%";
}

// Копіювання в буфер: спершу звичайний спосіб, а якщо браузер не відповідає за 0,8 с — запасний (execCommand)
function fallbackCopy(text) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch (e) {}
  document.body.removeChild(ta);
  return ok;
}

function copyText(text) {
  return new Promise(function (resolve) {
    let settled = false;
    function finish(ok) { if (!settled) { settled = true; resolve(ok); } }
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(function () { finish(true); }, function () { finish(fallbackCopy(text)); });
      setTimeout(function () { finish(fallbackCopy(text)); }, 800);
    } else {
      finish(fallbackCopy(text));
    }
  });
}

// Мобільне меню (гамбургер)
const menuBtn = document.getElementById("menuBtn");
const mainNav = document.getElementById("mainNav");
if (menuBtn && mainNav) {
  menuBtn.addEventListener("click", function () {
    const open = mainNav.classList.toggle("open");
    menuBtn.setAttribute("aria-expanded", open);
  });
  // Після вибору пункту меню закриваємо його
  mainNav.querySelectorAll("a").forEach(function (a) {
    a.addEventListener("click", function () {
      mainNav.classList.remove("open");
      menuBtn.setAttribute("aria-expanded", "false");
    });
  });
}

// ---------- Кнопка «Нагору» (на всіх сторінках) ----------
(function () {
  const up = document.createElement("button");
  up.className = "to-top";
  up.type = "button";
  up.setAttribute("aria-label", "Нагору");
  up.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';
  document.body.appendChild(up);

  window.addEventListener("scroll", function () {
    up.classList.toggle("show", window.scrollY > 500);
  }, { passive: true });

  up.addEventListener("click", function () {
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
})();

// ---------- «Копіювати посилання» і «Поділитися» (на сторінках новин) ----------
(function () {
  const article = document.querySelector("main.article");
  const title = article && article.querySelector("h1");
  if (!title) return;

  const bar = document.createElement("div");
  bar.className = "share-bar";
  bar.innerHTML =
    '<button type="button" class="share-btn" id="copyLink">Копіювати посилання</button>' +
    '<button type="button" class="share-btn" id="shareBtn">Поділитися</button>' +
    '<a class="share-btn" id="shTg" target="_blank" rel="noopener">Telegram</a>' +
    '<a class="share-btn" id="shFb" target="_blank" rel="noopener">Facebook</a>' +
    '<a class="share-btn" id="shMail">Пошта</a>' +
    '<span class="share-msg" id="shareMsg" role="status"></span>';

  // Ставимо панель під заголовком (після дати, якщо вона є)
  const anchor = article.querySelector(".date") || title;
  anchor.insertAdjacentElement("afterend", bar);

  // Прямі посилання: адреса й заголовок додаються у посилання кодуванням (щоб не ламалися пробіли й літери)
  const shareUrl = encodeURIComponent(location.href);
  const shareTitle = encodeURIComponent(title.textContent);
  bar.querySelector("#shTg").href = "https://t.me/share/url?url=" + shareUrl + "&text=" + shareTitle;
  bar.querySelector("#shFb").href = "https://www.facebook.com/sharer/sharer.php?u=" + shareUrl;
  bar.querySelector("#shMail").href = "mailto:?subject=" + shareTitle + "&body=" + shareTitle + "%0A" + shareUrl;

  const msg = bar.querySelector("#shareMsg");
  function say(text) {
    msg.textContent = text;
    setTimeout(function () { msg.textContent = ""; }, 2200);
  }

  bar.querySelector("#copyLink").addEventListener("click", function () {
    copyText(location.href).then(function (ok) {
      say(ok ? "Посилання скопійовано" : "Не вдалося скопіювати. Виділіть адресу в рядку браузера");
    });
  });

  bar.querySelector("#shareBtn").addEventListener("click", function () {
    if (navigator.share) {
      navigator.share({ title: document.title, url: location.href }).catch(function () {});
    } else {
      // На комп'ютерах без меню «Поділитися» просто копіюємо посилання
      bar.querySelector("#copyLink").click();
    }
  });
})();

// ---------- Анімації ----------

(function () {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Індикатор прокрутки зверху сторінки
  const bar = document.createElement("div");
  bar.className = "progress";
  document.body.appendChild(bar);
  window.addEventListener("scroll", function () {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    bar.style.width = max > 0 ? (window.scrollY / max) * 100 + "%" : "0";
  }, { passive: true });

  if (reduce || !("IntersectionObserver" in window)) return;

  // Які елементи з'являються при прокрутці
  const selector = [
    "section:not(.hero) > h2", "section:not(.hero) > p", "section:not(.hero) > h3",
    ".words > div", ".filters", ".card", ".chart", ".prices",
    ".timeline li", "details", ".note", "section > ul",
    ".article > *"
  ].join(",");

  const observer = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (!entry.isIntersecting) return;
      entry.target.classList.add("in");
      observer.unobserve(entry.target);
    });
  }, { threshold: 0.12 });

  document.querySelectorAll(selector).forEach(function (el) {
    // Елементи з однієї групи з'являються по черзі (максимум із затримкою 0,5 с)
    const index = Array.prototype.indexOf.call(el.parentNode.children, el);
    el.style.setProperty("--d", Math.min(index * 0.07, 0.5) + "s");
    el.classList.add("reveal");
    observer.observe(el);
  });
})();

// ---------- Підвал: вкладка «Джерела» розкривається за посиланням #sources ----------
(function () {
  const box = document.getElementById("sources");
  if (!box || box.tagName !== "DETAILS") return;
  function openIfLinked() {
    if (location.hash === "#sources") {
      box.open = true;
      box.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }
  openIfLinked();
  window.addEventListener("hashchange", openIfLinked);
})();
