const runBtn = document.getElementById("runBtn");
const statusLine = document.getElementById("statusLine");
const statsEl = document.getElementById("stats");
const emptyState = document.getElementById("emptyState");
const setupList = document.getElementById("setupList");
const resultsCount = document.getElementById("resultsCount");
const rangeLine = document.getElementById("rangeLine");

function formatPrice(v) {
  return typeof v === "number" ? v.toFixed(5) : "—";
}

function formatTime(t) {
  if (!t) return "—";
  const d = new Date(t);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function renderSetups(setups) {
  setupList.innerHTML = "";

  setups.forEach((s) => {
    const li = document.createElement("li");
    li.className = `setup-card ${s.direction}`;

    li.innerHTML = `
      <div class="side-bar"></div>
      <div class="direction">${s.direction === "demand" ? "▲ Buy" : "▼ Sell"}</div>
      <div class="zone-source">${s.zoneSource}</div>
      <div class="figures">
        <div>
          <span class="figure-label">Entry</span>
          <span class="figure-value">${formatPrice(s.entry)}</span>
        </div>
        <div>
          <span class="figure-label">SL</span>
          <span class="figure-value">${formatPrice(s.stopLoss)}</span>
        </div>
        <div>
          <span class="figure-label">TP</span>
          <span class="figure-value">${formatPrice(s.takeProfit)}</span>
        </div>
        <div>
          <span class="figure-label">R:R</span>
          <span class="figure-value">1:${s.riskRewardRatio}</span>
        </div>
        <div>
          <span class="figure-label">Risk</span>
          <span class="figure-value">${s.riskPct}%</span>
        </div>
        ${s.fibConfluence ? `<div><span class="fib-tag">FIB ${(s.fibConfluence.level * 100).toFixed(1)}%</span></div>` : ""}
      </div>
      <div class="meta-col">
        <span class="outcome-tag ${s.outcome}">${s.outcome}</span>
        <span>${formatTime(s.time)}</span>
      </div>
    `;

    setupList.appendChild(li);
  });
}

async function runBacktest() {
  const symbol = document.getElementById("symbol").value;
  const candles = document.getElementById("candleCount").value;

  runBtn.disabled = true;
  runBtn.querySelector(".run-btn-label").textContent = "Running…";
  statusLine.textContent = "Fetching candles and scanning for setups…";
  statusLine.classList.remove("error");

  try {
    const res = await fetch(`/api/backtest?symbol=${encodeURIComponent(symbol)}&candles=${candles}`);
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || "Backtest failed");
    }

    statusLine.textContent = `${data.candleCount} candles scanned.`;

    statsEl.hidden = false;
    document.getElementById("statTotal").textContent = data.stats.total;
    document.getElementById("statWinRate").textContent =
      data.stats.winRate !== null ? `${data.stats.winRate}%` : "—";
    document.getElementById("statWins").textContent = data.stats.wins;
    document.getElementById("statLosses").textContent = data.stats.losses;
    document.getElementById("statOpen").textContent = data.stats.open;

    rangeLine.textContent = `${formatTime(data.rangeStart)} → ${formatTime(data.rangeEnd)}`;

    resultsCount.textContent = `${data.setups.length} found`;

    if (data.setups.length) {
      emptyState.hidden = true;
      setupList.hidden = false;
      renderSetups(data.setups);
    } else {
      emptyState.hidden = false;
      setupList.hidden = true;
      emptyState.querySelector("p").textContent = "No setups found in this range.";
    }
  } catch (err) {
    statusLine.textContent = err.message;
    statusLine.classList.add("error");
  } finally {
    runBtn.disabled = false;
    runBtn.querySelector(".run-btn-label").textContent = "Run backtest";
  }
}

runBtn.addEventListener("click", runBacktest);

