// Сторінка «Новини»: добірка сюжетів (картки, фільтри за темою, пошук, сортування).
// Жива стрічка з агента — окремо, у feed.js.

// ---------- Новини: тема, «Читати далі» і фільтр ----------

// Яка сторінка до якої теми належить
const topics = {
  "news-sec.html": "us",
  "news-genius.html": "us",
  "news-mica.html": "eu",
  "news-jeeves.html": "invest",
  "news-noah.html": "invest",
  "news-startups.html": "invest",
  "news-q3.html": "invest",
  "news-okx.html": "invest",
  "news-bitcoin.html": "market",
  "news-salvador.html": "market",
};

const cards = document.querySelectorAll(".card");

cards.forEach(function (card) {
  const link = card.querySelector("h3 a");
  if (!link) return;

  // Записуємо тему картки в атрибут data-topic
  card.dataset.topic = topics[link.getAttribute("href")] || "market";

  // Додаємо посилання «Читати далі →» в кінець картки
  const more = document.createElement("a");
  more.href = link.getAttribute("href");
  more.className = "read-more";
  more.textContent = "Читати далі →";
  card.appendChild(more);
});

const filterButtons = document.querySelectorAll(".filter");
const searchInput = document.getElementById("newsSearch");
const searchInfo = document.getElementById("searchInfo");
let chosenTopic = "all";

// Показує лише картки, що підходять і за темою, і за словами з пошуку
function applyNewsFilters() {
  const q = searchInput ? searchInput.value.trim().toLowerCase() : "";
  let shown = 0;

  cards.forEach(function (card) {
    const topicOk = chosenTopic === "all" || card.dataset.topic === chosenTopic;
    const textOk = !q || card.textContent.toLowerCase().indexOf(q) > -1;
    const show = topicOk && textOk;
    card.style.display = show ? "" : "none";
    if (show) shown++;
  });

  if (searchInfo) {
    searchInfo.textContent = shown === 0
      ? "Нічого не знайдено. Спробуйте інше слово або оберіть «Усі»."
      : q ? "Знайдено: " + shown + " з " + cards.length : "";
  }
}

filterButtons.forEach(function (btn) {
  btn.addEventListener("click", function () {
    chosenTopic = btn.dataset.filter;

    // Підсвічуємо лише натиснуту кнопку
    filterButtons.forEach(function (b) {
      b.classList.toggle("active", b === btn);
    });
    applyNewsFilters();
  });
});

if (searchInput) searchInput.addEventListener("input", applyNewsFilters);

// Приблизні дати подій для сортування (за змістом новин; точні дати дивіться на сторінках)
const eventDates = {
  "news-bitcoin.html": "2026-10-08",
  "news-okx.html": "2026-10-05",
  "news-jeeves.html": "2026-10-02",
  "news-salvador.html": "2026-10-02",
  "news-q3.html": "2026-10-02",
  "news-noah.html": "2026-10-01",
  "news-startups.html": "2026-10-01",
  "news-sec.html": "2026-09-17",
  "news-genius.html": "2026-08-17",
  "news-mica.html": "2026-07-31",
};

const cardsBox = document.querySelector(".cards");
const sortSelect = document.getElementById("newsSort");
const originalOrder = Array.prototype.slice.call(cards); // порядок «як на сайті»

function cardDate(card) {
  const link = card.querySelector("h3 a");
  return (link && eventDates[link.getAttribute("href")]) || "";
}

function applySort() {
  if (!cardsBox || !sortSelect) return;
  const list = originalOrder.slice();
  if (sortSelect.value === "new") list.sort(function (a, b) { return cardDate(b).localeCompare(cardDate(a)); });
  if (sortSelect.value === "old") list.sort(function (a, b) { return cardDate(a).localeCompare(cardDate(b)); });
  list.forEach(function (c) { cardsBox.appendChild(c); }); // перекладаємо картки у новому порядку
}

if (sortSelect) sortSelect.addEventListener("change", applySort);

// Кнопка «Скинути»: прибирає пошук, тему й сортування
const resetBtn = document.getElementById("newsReset");
if (resetBtn) {
  resetBtn.addEventListener("click", function () {
    if (searchInput) searchInput.value = "";
    chosenTopic = "all";
    filterButtons.forEach(function (b) { b.classList.toggle("active", b.dataset.filter === "all"); });
    if (sortSelect) sortSelect.value = "default";
    applySort();
    applyNewsFilters();
  });
}
