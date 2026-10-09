// Ринок: запуск сторінки та головний цикл (щосекунди). Підключається ПІСЛЯ market-*.js.

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
