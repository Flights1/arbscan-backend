const axios = require("axios");

// ─── Timeout helper ───────────────────────────────────────────────────────────
const http = axios.create({ timeout: 5000 });

// ─── Coin symbol map per exchange ─────────────────────────────────────────────
// Each exchange has its own symbol format
const EXCHANGE_SYMBOLS = {
  binance:  { BTC: "BTCUSDT",  ETH: "ETHUSDT",  SOL: "SOLUSDT",  BNB: "BNBUSDT",  XRP: "XRPUSDT",  ADA: "ADAUSDT",  DOGE: "DOGEUSDT", AVAX: "AVAXUSDT", LINK: "LINKUSDT", DOT: "DOTUSDT"  },
  coinbase: { BTC: "BTC-USD",  ETH: "ETH-USD",  SOL: "SOL-USD",  BNB: "BNB-USD",  XRP: "XRP-USD",  ADA: "ADA-USD",  DOGE: "DOGE-USD", AVAX: "AVAX-USD", LINK: "LINK-USD", DOT: "DOT-USD"  },
  kucoin:   { BTC: "BTC-USDT", ETH: "ETH-USDT", SOL: "SOL-USDT", BNB: "BNB-USDT", XRP: "XRP-USDT", ADA: "ADA-USDT", DOGE: "DOGE-USDT",AVAX: "AVAX-USDT",LINK: "LINK-USDT",DOT: "DOT-USDT" },
  okx:      { BTC: "BTC-USDT", ETH: "ETH-USDT", SOL: "SOL-USDT", BNB: "BNB-USDT", XRP: "XRP-USDT", ADA: "ADA-USDT", DOGE: "DOGE-USDT",AVAX: "AVAX-USDT",LINK: "LINK-USDT",DOT: "DOT-USDT" },
  bybit:    { BTC: "BTCUSDT",  ETH: "ETHUSDT",  SOL: "SOLUSDT",  BNB: "BNBUSDT",  XRP: "XRPUSDT",  ADA: "ADAUSDT",  DOGE: "DOGEUSDT", AVAX: "AVAXUSDT", LINK: "LINKUSDT", DOT: "DOTUSDT"  },
};

const COINS = ["BTC", "ETH", "SOL", "BNB", "XRP", "ADA", "DOGE", "AVAX", "LINK", "DOT"];

// ─── Individual exchange fetchers ─────────────────────────────────────────────

async function fetchBinance() {
  // Binance returns all tickers in one call - very efficient
  const { data } = await http.get("https://api.binance.com/api/v3/ticker/price");
  const map = {};
  data.forEach((t) => { map[t.symbol] = parseFloat(t.price); });
  const result = {};
  COINS.forEach((coin) => {
    const sym = EXCHANGE_SYMBOLS.binance[coin];
    if (map[sym]) result[coin] = map[sym];
  });
  return result;
}

async function fetchCoinbase() {
  // Coinbase requires one request per pair
  const results = await Promise.allSettled(
    COINS.map(async (coin) => {
      const sym = EXCHANGE_SYMBOLS.coinbase[coin];
      const { data } = await http.get(`https://api.coinbase.com/v2/prices/${sym}/spot`);
      return { coin, price: parseFloat(data.data.amount) };
    })
  );
  const result = {};
  results.forEach((r) => {
    if (r.status === "fulfilled") result[r.value.coin] = r.value.price;
  });
  return result;
}

async function fetchKuCoin() {
  const { data } = await http.get("https://api.kucoin.com/api/v1/market/allTickers");
  const map = {};
  data.data.ticker.forEach((t) => { map[t.symbol] = parseFloat(t.last); });
  const result = {};
  COINS.forEach((coin) => {
    const sym = EXCHANGE_SYMBOLS.kucoin[coin];
    if (map[sym]) result[coin] = map[sym];
  });
  return result;
}

async function fetchOKX() {
  // OKX batch ticker endpoint
  const { data } = await http.get("https://www.okx.com/api/v5/market/tickers?instType=SPOT");
  const map = {};
  data.data.forEach((t) => { map[t.instId] = parseFloat(t.last); });
  const result = {};
  COINS.forEach((coin) => {
    const sym = EXCHANGE_SYMBOLS.okx[coin];
    if (map[sym]) result[coin] = map[sym];
  });
  return result;
}

async function fetchBybit() {
  const { data } = await http.get("https://api.bybit.com/v5/market/tickers?category=spot");
  const map = {};
  data.result.list.forEach((t) => { map[t.symbol] = parseFloat(t.lastPrice); });
  const result = {};
  COINS.forEach((coin) => {
    const sym = EXCHANGE_SYMBOLS.bybit[coin];
    if (map[sym]) result[coin] = map[sym];
  });
  return result;
}

// ─── Master fetch: all exchanges in parallel ──────────────────────────────────

async function fetchAllPrices() {
  const [binance, coinbase, kucoin, okx, bybit] = await Promise.allSettled([
    fetchBinance(),
    fetchCoinbase(),
    fetchKuCoin(),
    fetchOKX(),
    fetchBybit(),
  ]);

  const exchangeData = {
    Binance:  binance.status  === "fulfilled" ? binance.value  : null,
    Coinbase: coinbase.status === "fulfilled" ? coinbase.value : null,
    KuCoin:   kucoin.status   === "fulfilled" ? kucoin.value   : null,
    OKX:      okx.status      === "fulfilled" ? okx.value      : null,
    Bybit:    bybit.status    === "fulfilled" ? bybit.value    : null,
  };

  // Log which exchanges succeeded
  Object.entries(exchangeData).forEach(([ex, d]) => {
    if (!d) console.warn(`[WARN] ${ex} fetch failed`);
  });

  // Build per-coin structure
  const coins = {};
  COINS.forEach((coin) => {
    const prices = {};
    Object.entries(exchangeData).forEach(([ex, d]) => {
      if (d && d[coin]) prices[ex] = d[coin];
    });

    if (Object.keys(prices).length < 2) return; // need at least 2 exchanges

    // Calculate arbitrage
    const entries = Object.entries(prices);
    let buyEx = entries[0][0], sellEx = entries[0][0];
    let buyPrice = entries[0][1], sellPrice = entries[0][1];
    entries.forEach(([ex, p]) => {
      if (p < buyPrice)  { buyPrice  = p; buyEx  = ex; }
      if (p > sellPrice) { sellPrice = p; sellEx = ex; }
    });
    const spreadPct = ((sellPrice - buyPrice) / buyPrice) * 100;
    const spreadUSD = sellPrice - buyPrice;

    coins[coin] = {
      symbol: coin,
      prices,          // { Binance: 65000.12, Coinbase: 65040.50, ... }
      arb: {
        buyOn:     buyEx,
        sellOn:    sellEx,
        buyPrice,
        sellPrice,
        spreadPct,
        spreadUSD,
      },
      exchangeCount: Object.keys(prices).length,
      updatedAt: Date.now(),
    };
  });

  return coins;
}

module.exports = { fetchAllPrices, COINS };
