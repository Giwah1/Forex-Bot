/**
 * Supply & Demand + Fibonacci Strategy Engine
 * -----------------------------------------------------------------------
 * Replaces the earlier ICT/SMC OB+FVG/NY-session engine.
 * Timeframe: 15-minute candles.
 *
 * Candle shape expected from Twelve Data (after mapping):
 *   { time: <ISO string>, open, high, low, close }
 *
 * DESIGN CALLS MADE HERE (flagged, tunable via CONFIG below):
 *   - "Momentum candle" = body >= 1.5x the average body of the last 14 candles.
 *   - Zone = single origin candle's full high-low range (per the video).
 *   - Stop loss defaults to "below/above the whole zone" (safer option from
 *     the video) rather than "below last higher low" — swap in
 *     evaluateSetup() if you'd rather use the tighter version.
 *   - Consolidation zone = >=5 candles whose combined range is < 2x the
 *     average body size (i.e. genuinely sideways, not just a slow drift).
 *   - Wick-rejection zone = cluster of >=2 candles within a tight price
 *     band, each with a wick >= 2x its own body, on the same side.
 *   - On 15-min candles, noise is higher than 1H/4H, so the momentum and
 *     consolidation thresholds may need retuning once we backtest — flagged
 *     as CONFIG constants specifically so that's easy.
 * -----------------------------------------------------------------------
 */

const CONFIG = {
  pip: 0.0001,
  momentumLookback: 14,
  momentumMultiplier: 1.5,
  minMomentumRun: 3, // at least 3 momentum candles in a row
  consolidationMinCandles: 5,
  consolidationRangeMultiplier: 2, // range must be < 2x avg body to count as sideways
  wickRejectionMultiplier: 2, // wick >= 2x body
  wickClusterMaxCandles: 6, // look within this window for clustered wicks
  fibLevels: [0.382, 0.5, 0.618, 0.786],
  fibTolerancePips: 15, // how close a fib level must be to the zone to count as confluence
  fibExtensionTarget: -0.27,
  riskStandardPct: 1,
  riskConfluencePct: 2,
};

// ---------------------------------------------------------------------
// Basic candle helpers
// ---------------------------------------------------------------------

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
function upperWick(c) {
  return c.high - bodyTop(c);
}
function lowerWick(c) {
  return bodyBottom(c) - c.low;
}
function averageBody(candles, endIndex, lookback) {
  const start = Math.max(0, endIndex - lookback);
  const slice = candles.slice(start, endIndex);
  if (!slice.length) return 0;
  return slice.reduce((sum, c) => sum + bodySize(c), 0) / slice.length;
}

function isMomentumCandle(candles, i) {
  const avg = averageBody(candles, i, CONFIG.momentumLookback);
  if (avg === 0) return false;
  return bodySize(candles[i]) >= avg * CONFIG.momentumMultiplier;
}

// ---------------------------------------------------------------------
// 1. Momentum-candle zones
// ---------------------------------------------------------------------
/**
 * Finds runs of >= minMomentumRun same-direction momentum candles,
 * then boxes the origin candle (last candle before the run began).
 */
function detectMomentumZones(candles) {
  const zones = [];
  let runStart = null;
  let runDirection = null;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const momentum = isMomentumCandle(candles, i);
    const direction = isBullish(c) ? "bullish" : isBearish(c) ? "bearish" : null;

    if (momentum && direction && direction === runDirection) {
      // continue run
    } else if (momentum && direction) {
      runStart = i;
      runDirection = direction;
    } else {
      runStart = null;
      runDirection = null;
    }

    if (runStart !== null && i - runStart + 1 >= CONFIG.minMomentumRun) {
      const originIndex = runStart - 1;
      if (originIndex < 0) continue;
      const origin = candles[originIndex];
      const zoneType = runDirection === "bullish" ? "demand" : "supply";

      zones.push({
        type: zoneType,
        source: "momentum",
        formedAt: origin.time,
        confirmedAt: candles[runStart + CONFIG.minMomentumRun - 1].time,
        top: origin.high,
        bottom: origin.low,
        invalidated: false,
      });

      runStart = null;
      runDirection = null;
    }
  }

  return zones;
}

// ---------------------------------------------------------------------
// 2. Consolidation zones
// ---------------------------------------------------------------------
function detectConsolidationZones(candles) {
  const zones = [];
  const n = CONFIG.consolidationMinCandles;

  for (let i = 0; i <= candles.length - n; i++) {
    const window = candles.slice(i, i + n);
    const avgBody = averageBody(candles, i + n, CONFIG.momentumLookback) || 1e-9;

    const top = Math.max(...window.map((c) => c.high));
    const bottom = Math.min(...window.map((c) => c.low));
    const range = top - bottom;

    if (range < avgBody * CONFIG.consolidationRangeMultiplier) {
      zones.push({
        type: "consolidation",
        source: "consolidation",
        formedAt: window[0].time,
        confirmedAt: window[window.length - 1].time,
        top,
        bottom,
        invalidated: false,
      });
    }
  }

  return zones
    .map((zone) => {
      const endIndex = candles.findIndex((c) => c.time === zone.confirmedAt);
      const breakoutCandle = candles[endIndex + 1];
      if (!breakoutCandle) return null;
      const type = isBullish(breakoutCandle) ? "demand" : isBearish(breakoutCandle) ? "supply" : null;
      if (!type) return null;
      return { ...zone, type };
    })
    .filter(Boolean);
}

// ---------------------------------------------------------------------
// 3. Wick-rejection zones
// ---------------------------------------------------------------------
function detectWickRejectionZones(candles) {
  const zones = [];

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const body = bodySize(c) || 1e-9;
    const upperRejection = upperWick(c) >= body * CONFIG.wickRejectionMultiplier;
    const lowerRejection = lowerWick(c) >= body * CONFIG.wickRejectionMultiplier;

    if (!upperRejection && !lowerRejection) continue;

    const windowEnd = Math.min(candles.length, i + CONFIG.wickClusterMaxCandles);
    const cluster = [c];

    for (let j = i + 1; j < windowEnd; j++) {
      const other = candles[j];
      const otherBody = bodySize(other) || 1e-9;
      const sameSide = upperRejection
        ? upperWick(other) >= otherBody * CONFIG.wickRejectionMultiplier
        : lowerWick(other) >= otherBody * CONFIG.wickRejectionMultiplier;

      if (sameSide) cluster.push(other);
    }

    if (cluster.length < 2) continue;

    const top = upperRejection
      ? Math.max(...cluster.map((cc) => cc.high))
      : Math.max(...cluster.map((cc) => bodyTop(cc)));
    const bottom = upperRejection
      ? Math.min(...cluster.map((cc) => bodyTop(cc)))
      : Math.min(...cluster.map((cc) => cc.low));

    zones.push({
      type: upperRejection ? "supply" : "demand",
      source: "wick-rejection",
      formedAt: cluster[0].time,
      confirmedAt: cluster[cluster.length - 1].time,
      top,
      bottom,
      invalidated: false,
    });
  }

  return zones;
}

// ---------------------------------------------------------------------
// Zone invalidation (shared)
// ---------------------------------------------------------------------
function isZoneInvalidated(zone, candles, uptoTime) {
  return candles.some((c) => {
    if (new Date(c.time) <= new Date(zone.confirmedAt)) return false;
    if (new Date(c.time) >= new Date(uptoTime)) return false;

    if (zone.type === "demand") {
      return bodyBottom(c) < zone.bottom;
    }
    if (zone.type === "supply") {
      return bodyTop(c) > zone.top;
    }
    return false;
  });
}

function getActiveZones(candles, asOfTime) {
  const all = [
    ...detectMomentumZones(candles),
    ...detectConsolidationZones(candles),
    ...detectWickRejectionZones(candles),
  ];

  return all.filter(
    (z) =>
      new Date(z.confirmedAt) < new Date(asOfTime) &&
      !isZoneInvalidated(z, candles, asOfTime)
  );
}

// ---------------------------------------------------------------------
// Swing points (for opposing-zone TP fallback, and Fibonacci)
// ---------------------------------------------------------------------
function findSwingPoints(candles, lookback = 3) {
  const swings = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const window = candles.slice(i - lookback, i + lookback + 1);
    const current = candles[i];
    if (window.every((c) => c.high <= current.high)) {
      swings.push({ type: "high", time: current.time, price: current.high });
    }
    if (window.every((c) => c.low >= current.low)) {
      swings.push({ type: "low", time: current.time, price: current.low });
    }
  }
  return swings;
}

function mostRecentSwing(swings, type, beforeTime) {
  const filtered = swings.filter(
    (s) => s.type === type && new Date(s.time) < new Date(beforeTime)
  );
  return filtered.length ? filtered[filtered.length - 1] : null;
}

// ---------------------------------------------------------------------
// Fibonacci confluence check
// ---------------------------------------------------------------------
function checkFibConfluence(zone, swings) {
  const isDemand = zone.type === "demand";
  const swingLow = mostRecentSwing(swings, "low", zone.formedAt);
  const swingHigh = mostRecentSwing(swings, "high", zone.formedAt);

  if (!swingLow || !swingHigh) return null;

  const rangeTop = Math.max(swingHigh.price, swingLow.price);
  const rangeBottom = Math.min(swingHigh.price, swingLow.price);
  const range = rangeTop - rangeBottom;
  if (range <= 0) return null;

  for (const level of CONFIG.fibLevels) {
    const fibPrice = isDemand ? rangeTop - range * level : rangeBottom + range * level;

    const withinZone =
      Math.abs(fibPrice - zone.top) / CONFIG.pip <= CONFIG.fibTolerancePips ||
      Math.abs(fibPrice - zone.bottom) / CONFIG.pip <= CONFIG.fibTolerancePips ||
      (fibPrice <= zone.top && fibPrice >= zone.bottom);

    if (withinZone) {
      const extensionPrice = isDemand
        ? rangeBottom + range * (1 - CONFIG.fibExtensionTarget)
        : rangeTop - range * (1 - CONFIG.fibExtensionTarget);

      return { level, fibPrice, extensionPrice, swingLow, swingHigh };
    }
  }

  return null;
}

// ---------------------------------------------------------------------
// Confirmation candle logic
// ---------------------------------------------------------------------
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
    return (
      isBullish(current) &&
      current.close > prev.open &&
      current.open < prev.close
    );
  } else {
    return (
      isBearish(current) &&
      current.close < prev.open &&
      current.open > prev.close
    );
  }
}

// ---------------------------------------------------------------------
// Main evaluation — scans forward candle by candle looking for a setup
// ---------------------------------------------------------------------
function evaluateSetup(candles) {
  const swings = findSwingPoints(candles);

  for (let i = 2; i < candles.length; i++) {
    const current = candles[i];
    const prev = candles[i - 1];
    const rejectionCandidate = candles[i - 1];

    const activeZones = getActiveZones(candles, current.time);

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

      return {
        status: "setup_found",
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
    }
  }

  return { status: "no_trade", reason: "no valid zone retest + confirmation found" };
}

module.exports = {
  detectMomentumZones,
  detectConsolidationZones,
  detectWickRejectionZones,
  getActiveZones,
  findSwingPoints,
  checkFibConfluence,
  evaluateSetup,
  CONFIG,
};

