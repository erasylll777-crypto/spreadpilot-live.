import express from "express";
import ccxt from "ccxt";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "32kb" }));
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

const PORT = Number(process.env.PORT || 3000);
const CACHE_MS = Math.max(1500, Number(process.env.CACHE_MS || 5000));
const REQUEST_TIMEOUT_MS = Math.max(3000, Number(process.env.REQUEST_TIMEOUT_MS || 8000));
const MAX_EXCHANGES = 12;
const EXCHANGE_IDS = [
  "binance", "bybit", "okx", "kucoin", "gateio", "bitget",
  "kraken", "coinbase", "mexc", "htx", "bingx", "whitebit"
];
const exchangeInstances = new Map();
const cache = new Map();
const inflight = new Map();

function getExchange(id) {
  if (!EXCHANGE_IDS.includes(id)) throw new Error("Exchange is not enabled");
  if (!exchangeInstances.has(id)) {
    const Klass = ccxt[id];
    if (!Klass) throw new Error(`Exchange adapter unavailable: ${id}`);
    exchangeInstances.set(id, new Klass({
      enableRateLimit: true,
      timeout: REQUEST_TIMEOUT_MS,
      options: { defaultType: "spot" }
    }));
  }
  return exchangeInstances.get(id);
}
function cleanSymbol(s) {
  if (typeof s !== "string" || !/^[A-Z0-9]{2,15}\/[A-Z0-9]{2,15}$/.test(s)) {
    throw new Error("Use a spot symbol like BTC/USDT");
  }
  return s;
}
function finitePositive(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}
async function getTicker(exchangeId, symbol) {
  const key = `${exchangeId}:${symbol}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  if (inflight.has(key)) return inflight.get(key);
  const promise = (async () => {
    try {
      const ex = getExchange(exchangeId);
      // Load markets once per adapter; CCXT handles market symbol differences.
      if (!ex.markets) await ex.loadMarkets();
      if (!ex.markets[symbol]) {
        return { exchange: exchangeId, symbol, ok: false, error: "Пара не поддерживается" };
      }
      const t = await ex.fetchTicker(symbol);
      const bid = finitePositive(t.bid);
      const ask = finitePositive(t.ask);
      const last = finitePositive(t.last);
      const result = {
        exchange: exchangeId, symbol, ok: Boolean(bid && ask),
        bid, ask, last,
        quoteVolume: finitePositive(t.quoteVolume),
        timestamp: t.timestamp || Date.now(),
        datetime: t.datetime || new Date(t.timestamp || Date.now()).toISOString(),
        source: "CCXT public ticker",
        error: bid && ask ? null : "Биржа не вернула bid/ask"
      };
      cache.set(key, { at: Date.now(), value: result });
      return result;
    } catch (e) {
      return { exchange: exchangeId, symbol, ok: false, error: String(e.message || "API error").slice(0, 180) };
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, promise);
  return promise;
}

app.get("/api/health", (_req, res) => res.json({
  ok: true, mode: "read-only-public-market-data", now: new Date().toISOString()
}));
app.get("/api/exchanges", (_req, res) => res.json({
  exchanges: EXCHANGE_IDS.map(id => ({ id, name: id === "gateio" ? "Gate.io" : id === "htx" ? "HTX" : id[0].toUpperCase() + id.slice(1) }))
}));

app.get("/api/scan", async (req, res) => {
  try {
    const symbol = cleanSymbol(String(req.query.symbol || "BTC/USDT").toUpperCase());
    const amount = Number(req.query.amount || 1000);
    const feePct = Number(req.query.tradeFeePct ?? 0.1);
    const minSpreadPct = Number(req.query.minSpreadPct ?? 0);
    const withdrawalFee = Number(req.query.withdrawalFee ?? 1);
    const selectedRaw = String(req.query.exchanges || EXCHANGE_IDS.join(",")).split(",");
    const selected = [...new Set(selectedRaw)].filter(id => EXCHANGE_IDS.includes(id)).slice(0, MAX_EXCHANGES);
    if (selected.length < 2) return res.status(400).json({ error: "Выбери минимум две поддерживаемые биржи" });
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000_000) return res.status(400).json({ error: "Некорректная сумма" });
    if (![feePct, minSpreadPct, withdrawalFee].every(v => Number.isFinite(v) && v >= 0)) return res.status(400).json({ error: "Комиссии и минимальный спред должны быть неотрицательными числами" });

    const tickers = await Promise.all(selected.map(id => getTicker(id, symbol)));
    const usable = tickers.filter(t => t.ok && t.bid && t.ask);
    const routes = [];
    for (const buy of usable) for (const sell of usable) {
      if (buy.exchange === sell.exchange) continue;
      // Buy at ask, sell at bid: more realistic than comparing last prices.
      const spreadPct = (sell.bid - buy.ask) / buy.ask * 100;
      const quantity = amount / buy.ask;
      const grossProfit = quantity * (sell.bid - buy.ask);
      const tradeFees = amount * (feePct / 100) + (quantity * sell.bid) * (feePct / 100);
      const netEstimate = grossProfit - tradeFees - withdrawalFee;
      if (spreadPct >= minSpreadPct) routes.push({
        buyExchange: buy.exchange, sellExchange: sell.exchange,
        buyAsk: buy.ask, sellBid: sell.bid, spreadPct,
        quantity, notional: amount, grossProfit,
        estimatedTradeFees: tradeFees, withdrawalFee,
        estimatedNet: netEstimate,
        buyTimestamp: buy.timestamp, sellTimestamp: sell.timestamp,
        // This is only a quote-level screen; no claim that the full size is executable.
        liquidityCheck: "Not checked: order-book depth not yet included"
      });
    }
    routes.sort((a, b) => b.estimatedNet - a.estimatedNet);
    res.set("Cache-Control", "no-store");
    res.json({
      symbol, amount, currency: "USDT-equivalent (input notional)",
      fetchedAt: new Date().toISOString(),
      dataMode: "LIVE_PUBLIC_TICKERS",
      disclaimer: "Live public quotes; estimated result only. Not a guarantee or executable arbitrage. Check depth, fees, network availability and transfer risk.",
      tickers, routes: routes.slice(0, 50),
      meta: { exchangesRequested: selected.length, exchangesResponded: tickers.filter(t => t.ok).length, cacheMs: CACHE_MS }
    });
  } catch (e) {
    res.status(400).json({ error: String(e.message || "Bad request").slice(0, 180) });
  }
});

app.use((err, _req, res, _next) => {
  console.error("Unhandled request error:", err?.message || err);
  res.status(500).json({ error: "Внутренняя ошибка сервера" });
});
app.listen(PORT, "0.0.0.0", () => console.log(`SpreadPilot running on port ${PORT}`));
