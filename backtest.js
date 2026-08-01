/**
 * Backtest runner.
 * Scans the full candle history (instead of stopping at the first setup,
 * like strategyEngine.evaluateSetup does for live use) and collects every
 * setup found, along with a simulated outcome (win/loss/open) based on
 * which of SL/TP was hit first in the candles that followed.
 */

const {
  getActiveZones,
  findSwingPoints,
  checkFibConfluence,
  CONFIG,
} = require("./strategyEngine");

function isBullish(c) {
  return c.close > c.open;
}
function isBearish(c) {
  return c.close < c.open;
}
function bodySize(c) {
  return Math.abs(c.close - c.open);
}
function bodyTop(c) {
  return Math.max(c.open, c.close);
}
function bodyBottom(c) {
  return Math.min(c.open, c.close);
}

function isRejectionCandle(c, zone) {
  const body = bodySize(c);
  const range = c.high - c.low || 1e-9;
  const isDoji = body / range < 0.3;

  if (zone.type === "demand") {
    const wickBeyond = c.low < zone.bottom && bodyBottom(c) >= zone.bottom;
    return isDoji || wickBeyond;
  } else {
    const wickBeyond = c.high > zone.top && bodyTop(c) <= zone.top;
    return isDoji || wickBeyond;
  }
}

function isEngulfing(prev, current, direction) {
  if (direction === "demand") {
    return isBullish(current) && current.close > prev.open && current.open < prev.close;
  }
  return isBearish(current) && current.close < prev.open && current.open > prev.close;
}

function mostRecentSwing(swings, type, beforeTime) {
  const filtered = swings.filter(
    (s) => s.type === type && new Date(s.time) < new Date(beforeTime)
  );
  return filtered.length ? filtered[filtered.length - 1] : null;
}

function simulateOutcome(candles, entryIndex, setup) {
  for (let j = entryIndex + 1; j < candles.length; j++) {
    const c = candles[j];

    if (setup.direction === "demand") {
      if (c.low <= setup.stopLoss) return { outcome: "loss", closedAt: c.time };
      if (c.high >= setup.takeProfit) return { outcome: "win", closedAt: c.time };
    } else {
      if (c.high >= setup.stopLoss) return { outcome: "loss", closedAt: c.time };
      if (c.low <= setup.takeProfit) return { outcome: "win", closedAt: c.time };
    }
  }
  return { outcome: "open", closedAt: null };
}

/**
 * Walks the full candle set once, collecting every setup found (with a
 * small cooldown after each so we don't re-trigger on the same zone
 * every single candle), and simulates each trade's outcome.
 */
function runBacktest(candles, cooldownCandles = 4) {
  const swings = findSwingPoints(candles);
  const setups = [];

  let i = 2;
  while (i < candles.length) {
    const current = candles[i];
    const prev = candles[i - 1];
    const rejectionCandidate = candles[i - 1];

    const activeZones = getActiveZones(candles, current.time);
    let matched = null;

    for (const zone of activeZones) {
      const touchedZone = current.low <= zone.top && current.high >= zone.bottom;
      if (!touchedZone) continue;

      const rejectionOk = isRejectionCandle(rejectionCandidate, zone);
      const engulfingOk = isEngulfing(prev, current, zone.type);
      if (!(rejectionOk && engulfingOk)) continue;

      const fib = checkFibConfluence(zone, swings);
      const entry = current.close;
      const stopLoss = zone.type === "demand" ? zone.bottom : zone.top;

      let takeProfit;
      let riskPct;

      if (fib) {
        takeProfit = fib.extensionPrice;
        riskPct = CONFIG.riskConfluencePct;
      } else {
        const swingType = zone.type === "demand" ? "high" : "low";
        const opposing = mostRecentSwing(swings, swingType, current.time);
        if (!opposing) continue;
        takeProfit = opposing.price;
        riskPct = CONFIG.riskStandardPct;
      }

      const riskPips = Math.abs(entry - stopLoss) / CONFIG.pip;
      const rewardPips = Math.abs(takeProfit - entry) / CONFIG.pip;
      if (riskPips === 0) continue;
      const rr = rewardPips / riskPips;

      matched = {
        time: current.time,
        direction: zone.type,
        zoneSource: zone.source,
        entry,
        stopLoss,
        takeProfit,
        riskRewardRatio: Number(rr.toFixed(2)),
        riskPct,
        fibConfluence: fib ? { level: fib.level, price: fib.fibPrice } : null,
      };
      break;
    }

    if (matched) {
      const result = simulateOutcome(candles, i, matched);
      setups.push({ ...matched, ...result });
      i += cooldownCandles;
    } else {
      i += 1;
    }
  }

  const wins = setups.filter((s) => s.outcome === "win").length;
  const losses = setups.filter((s) => s.outcome === "loss").length;
  const open = setups.filter((s) => s.outcome === "open").length;
  const decided = wins + losses;

  return {
    setups,
    stats: {
      total: setups.length,
      wins,
      losses,
      open,
      winRate: decided ? Number(((wins / decided) * 100).toFixed(1)) : null,
    },
  };
}

module.exports = { runBacktest };

