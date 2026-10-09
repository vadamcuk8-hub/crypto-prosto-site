// Ринок, частина 3: калькулятор конвертації.
// Потребує market-live.js, core.js (copyText).

// ---------- Калькулятор конвертації ----------
const calcAmt = document.getElementById("calcAmt");
const calcFrom = document.getElementById("calcFrom");
const calcTo = document.getElementById("calcTo");
const calcOut = document.getElementById("calcOut");

// Скільки доларів коштує одна одиниця: монета, долар або гривня (null — ціни ще немає)
function usdValueOf(unit) {
  if (unit === "usd") return 1;
  if (unit === "uah") return usdRate ? 1 / usdRate : null;
  if (unit === "eur") return usdRate && eurRate ? eurRate / usdRate : null;
  return state[unit] ? state[unit].usd : null;
}

const unitSign = { usd: "$", uah: "₴", eur: "€" };

// Показує число: для монет до 8 знаків (без зайвих нулів), для грошей — 2 або 0
function fmtUnit(n, unit) {
  if (unitSign[unit]) {
    const d = n >= 100 ? 0 : 2;
    return n.toLocaleString("uk-UA", { minimumFractionDigits: d, maximumFractionDigits: d }) + " " + unitSign[unit];
  }
  const d = n >= 1000 ? 2 : n >= 1 ? 4 : 8;
  return n.toLocaleString("uk-UA", { maximumFractionDigits: d }) + " " + coinShort(unit);
}

let calcText = "";  // останній результат (для кнопки «Копіювати»)
let calcShown = ""; // що зараз показано в рамці результату (щоб не переписувати однакове щосекунди)

function calcMessage(msg) {
  setText(calcOut, msg);
  calcShown = "";
}

function renderCalc() {
  if (!calcAmt || !calcFrom || !calcTo || !calcOut) return;
  const amount = parseFloat(String(calcAmt.value).replace(/\s/g, "").replace(",", "."));
  const a = usdValueOf(calcFrom.value);
  const b = usdValueOf(calcTo.value);
  if (a === null || b === null) { calcMessage("Чекаємо на ціни…"); return; }
  if (isNaN(amount) || amount < 0) { calcMessage("Введіть кількість, наприклад 0,01"); return; }
  if (calcFrom.value === calcTo.value) { calcMessage("Оберіть різні одиниці"); return; }
  calcText = fmtUnit((amount * a) / b, calcTo.value);
  if (calcShown !== calcText) {
    calcOut.innerHTML = "<b>" + calcText + "</b>";
    calcShown = calcText;
  }
}

if (calcAmt) {
  calcAmt.addEventListener("input", renderCalc);
  calcFrom.addEventListener("change", renderCalc);
  calcTo.addEventListener("change", renderCalc);

  // Кнопка ⇄ міняє місцями «з чого» і «у що»
  document.getElementById("calcSwap").addEventListener("click", function () {
    const f = calcFrom.value;
    calcFrom.value = calcTo.value;
    calcTo.value = f;
    renderCalc();
  });

  // Швидкі суми
  document.querySelectorAll("#calcChips .chip").forEach(function (b) {
    b.addEventListener("click", function () {
      calcAmt.value = b.dataset.v;
      renderCalc();
    });
  });

  // Копіювання результату
  document.getElementById("calcCopy").addEventListener("click", function () {
    const btn = this;
    const old = btn.textContent;
    function flash(t) { btn.textContent = t; setTimeout(function () { btn.textContent = old; }, 1500); }
    if (!calcText) return;
    copyText(calcText).then(function (ok) { flash(ok ? "Скопійовано" : "Не вдалося"); });
  });
}
