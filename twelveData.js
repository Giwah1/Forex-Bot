/**
 * Twelve Data historical candle fetcher.
 * Pages backward in time (via end_date) to accumulate a large candle
 * history, since Twelve Data caps outputsize at 5000 per request.
 *
 * Requires env var: TWELVE_DATA_API_KEY
 */

const BASE_URL = "https://api.twelvedata.com/time_series";
const MAX_PER_REQUEST = 5000;

async function fetchChunk(symbol, interval, endDate, outputsize) {
  const apiKey = process.env.TWELVE_DATA_API_KEY;
  if (!apiKey) {
    throw new Error("Missing TWELVE_DATA_API_KEY environment variable");
  }

  const params = new URLSearchParams({
    symbol,
    interval,
    outputsize: String(outputsize),
    apikey: apiKey,
    order: "ASC",
  });
  if (endDate) params.set("end_date", endDate);

  const res = await fetch(`${BASE_URL}?${params.toString()}`);
  const data = await res.json();

  if (data.status === "error") {
    throw new Error(`Twelve Data error: ${data.message}`);
  }
  if (!data.values) {
    return [];
  }

  return data.values.map((v) => ({
    time: v.datetime,
    open: parseFloat(v.open),
    high: parseFloat(v.high),
    low: parseFloat(v.low),
    close: parseFloat(v.close),
  }));
}

/**
 * Fetches up to `totalCandles` historical candles for `symbol` at
 * `interval`, returned sorted ascending (oldest first).
 */
async function fetchCandles(symbol, interval = "15min", totalCandles = 7000) {
  let allCandles = [];
  let endDate = undefined;
  let safetyCounter = 0;

  while (allCandles.length < totalCandles && safetyCounter < 20) {
    safetyCounter++;
    const remaining = totalCandles - allCandles.length;
    const requestSize = Math.min(MAX_PER_REQUEST, remaining);

    const chunk = await fetchChunk(symbol, interval, endDate, requestSize);
    if (!chunk.length) break;

    // chunk is ascending; prepend to allCandles (older data goes first)
    allCandles = [...chunk, ...allCandles];

    // next request should end right before this chunk's earliest candle
    const earliest = chunk[0].time;
    endDate = earliest;

    if (chunk.length < requestSize) break; // no more data available
  }

  // dedupe by time (in case of overlap at chunk boundaries) and sort ascending
  const seen = new Set();
  const deduped = allCandles.filter((c) => {
    if (seen.has(c.time)) return false;
    seen.add(c.time);
    return true;
  });

  deduped.sort((a, b) => new Date(a.time) - new Date(b.time));

  return deduped.slice(-totalCandles);
}

module.exports = { fetchCandles };

