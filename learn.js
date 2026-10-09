// Головна сторінка: глосарій із пошуком і «Розгорнути всі» у запитаннях.

// ---------- Глосарій з пошуком ----------
const glossSearch = document.getElementById("glossSearch");
if (glossSearch) {
  const terms = document.querySelectorAll("#glossList .term");
  const glossInfo = document.getElementById("glossInfo");
  glossSearch.addEventListener("input", function () {
    const q = glossSearch.value.trim().toLowerCase();
    let shown = 0;
    terms.forEach(function (t) {
      const ok = !q || t.textContent.toLowerCase().indexOf(q) > -1;
      t.style.display = ok ? "" : "none";
      if (ok) shown++;
    });
    glossInfo.textContent = !shown ? "Такого слова ще немає. Спробуйте іншу форму слова." : q ? "Знайдено: " + shown + " з " + terms.length : "";
  });
}

// Розгорнути / згорнути всі запитання
const faqToggle = document.getElementById("faqToggle");
if (faqToggle) {
  faqToggle.addEventListener("click", function () {
    const items = document.querySelectorAll("#faq details");
    const open = faqToggle.dataset.open !== "1";
    items.forEach(function (d) { d.open = open; });
    faqToggle.dataset.open = open ? "1" : "0";
    faqToggle.textContent = open ? "Згорнути всі" : "Розгорнути всі";
  });
}
