const express = require("express");
const path = require("path");
const { fetchCandles } = require("./twelveData");
const { runBacktest } = require("./backtest");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));

app.get("/api/backtest", async (req, res) => {
  const symbol = req.query.symbol || "EUR/USD";
  const interval = "15min";
  const totalCandles = Math.min(
    parseInt(req.query.candles, 10) || 7000,
    7000
  );

  try {
    const candles = await fetchCandles(symbol, interval, totalCandles);
    if (!candles.length) {
      return res.status(502).json({ error: "No candle data returned from Twelve Data" });
    }

    const { setups, stats } = runBacktest(candles);

    res.json({
      symbol,
      interval,
      candleCount: candles.length,
      rangeStart: candles[0].time,
      rangeEnd: candles[candles.length - 1].time,
      stats,
      setups: setups.reverse(), // most recent first
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

