require("dotenv").config();
const express = require("express");
const cors    = require("cors");
const http    = require("http");
const WebSocket = require("ws");
const { fetchAllPrices } = require("./exchanges");

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

const PORT         = process.env.PORT || 4000;
const FRONTEND_URL = process.env.FRONTEND_URL || "*";
const REFRESH_MS   = 10000; // fetch every 10 seconds

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors({ origin: FRONTEND_URL }));
app.use(express.json());

// ─── State ────────────────────────────────────────────────────────────────────
let latestData  = null;   // last successful fetch
let lastFetchAt = null;
let fetchCount  = 0;
let errorCount  = 0;

// ─── Core fetch loop ──────────────────────────────────────────────────────────
async function fetchAndBroadcast() {
  try {
    console.log(`[FETCH] Pulling prices from all exchanges...`);
    const coins = await fetchAllPrices();
    fetchCount++;

    const payload = {
      type:      "PRICES_UPDATE",
      coins,
      fetchCount,
      updatedAt: Date.now(),
    };

    latestData  = payload;
    lastFetchAt = Date.now();

    // Broadcast to all connected WebSocket clients
    const msg = JSON.stringify(payload);
    let sent = 0;
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(msg);
        sent++;
      }
    });

    // Log top opportunities
    const sorted = Object.values(coins).sort((a, b) => b.arb.spreadPct - a.arb.spreadPct);
    console.log(`[OK] Fetch #${fetchCount} — ${Object.keys(coins).length} coins — ${sent} clients connected`);
    sorted.slice(0, 3).forEach((c) => {
      console.log(`  ${c.symbol}: ${c.arb.spreadPct.toFixed(3)}% spread | Buy ${c.arb.buyOn} @ $${c.arb.buyPrice.toFixed(4)} | Sell ${c.arb.sellOn} @ $${c.arb.sellPrice.toFixed(4)}`);
    });

  } catch (err) {
    errorCount++;
    console.error(`[ERROR] Fetch failed (${errorCount}):`, err.message);
  }
}

// ─── WebSocket connection handler ─────────────────────────────────────────────
wss.on("connection", (ws, req) => {
  const ip = req.socket.remoteAddress;
  console.log(`[WS] Client connected: ${ip} | Total: ${wss.clients.size}`);

  // Send latest data immediately on connect
  if (latestData) {
    ws.send(JSON.stringify(latestData));
  } else {
    ws.send(JSON.stringify({ type: "LOADING", message: "Fetching prices..." }));
  }

  ws.on("message", (msg) => {
    try {
      const data = JSON.parse(msg);
      // Client can request a manual refresh
      if (data.type === "REQUEST_REFRESH") {
        fetchAndBroadcast();
      }
    } catch (_) {}
  });

  ws.on("close", () => {
    console.log(`[WS] Client disconnected | Total: ${wss.clients.size}`);
  });

  ws.on("error", (err) => {
    console.error(`[WS] Client error:`, err.message);
  });
});

// ─── REST API endpoints ───────────────────────────────────────────────────────

// Health check
app.get("/health", (req, res) => {
  res.json({
    status:     "ok",
    uptime:     process.uptime(),
    fetchCount,
    errorCount,
    lastFetchAt,
    clients:    wss.clients.size,
  });
});

// Latest prices (REST fallback for clients that can't use WebSocket)
app.get("/api/prices", (req, res) => {
  if (!latestData) {
    return res.status(503).json({ error: "Prices not yet loaded, try again in a few seconds." });
  }
  res.json(latestData);
});

// Top opportunities endpoint
app.get("/api/opportunities", (req, res) => {
  if (!latestData) {
    return res.status(503).json({ error: "Prices not yet loaded." });
  }
  const minSpread = parseFloat(req.query.minSpread) || 0;
  const coins = Object.values(latestData.coins)
    .filter((c) => c.arb.spreadPct >= minSpread)
    .sort((a, b) => b.arb.spreadPct - a.arb.spreadPct);

  res.json({ count: coins.length, opportunities: coins });
});

// Single coin detail
app.get("/api/prices/:symbol", (req, res) => {
  if (!latestData) return res.status(503).json({ error: "Not ready." });
  const coin = latestData.coins[req.params.symbol.toUpperCase()];
  if (!coin) return res.status(404).json({ error: "Coin not found." });
  res.json(coin);
});

// ─── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, async () => {
  console.log(`
╔══════════════════════════════════════════╗
║         ARBSCAN BACKEND SERVER           ║
║  Real-Time Crypto Arbitrage Engine       ║
╠══════════════════════════════════════════╣
║  HTTP  →  http://localhost:${PORT}          ║
║  WS    →  ws://localhost:${PORT}            ║
║  Fetch interval: ${REFRESH_MS / 1000}s                    ║
╚══════════════════════════════════════════╝
  `);

  // First fetch immediately
  await fetchAndBroadcast();

  // Then repeat every REFRESH_MS
  setInterval(fetchAndBroadcast, REFRESH_MS);
});

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\n[SHUTDOWN] Closing server...");
  server.close(() => process.exit(0));
});
