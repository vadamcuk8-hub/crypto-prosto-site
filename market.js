// Ринок: запуск сторінки та головний цикл (щосекунди). Підключається ПІСЛЯ market-*.js.

// ---------- Графіки на сторінці відкриваються у великому вікні ----------
const openBtn = document.getElementById("openChart");
if (openBtn) {
  openBtn.addEventListener("click", function () { openCoinChart(selectedCoin); });
  ["liveChart", "btcChart"].forEach(function (boxId) {
    const box = document.getElementById(boxId);
    if (box) ChartTool.bind(box, function () {
      const c = coins[selectedCoin];
      return { symbol: c.pair.replace("usdt", "").toUpperCase(), name: c.name };
    }, "Відкрити біржовий графік: свічки наживо, масштаб, лінії, лінійка");
  });
}

// ---------- Запуск ----------
if (document.getElementById("cryptoPrices")) {
  Promise.all([loadFiat(), loadCrypto()]).then(renderPrices); // обидва запити йдуть одночасно
  loadWeekChart(selectedCoin);
  loadFng();
  connectLive();
  setInterval(loadCrypto, 60000); // CoinGecko раз на хвилину: безкоштовний API має ліміти
  setInterval(function () {       // головний цикл: щосекунди
    updateCharts();               // (дописує точку в буфери завжди, а малює лише коли вкладку видно)
    checkAlerts();                // сповіщення працюють і у фоновій вкладці
    if (document.hidden) return;  // у прихованій вкладці не витрачаємо сили на перемальовування
    renderPrices();
    renderAnalysis();
    renderCalc();
    renderHeatmap();
    updateAlertNow();
  }, 1000);
}
