'use strict';

require('dotenv').config();

const config = require('../config');
const db = require('./db');
const BinanceWs = require('./binance/ws');
const BinanceRest = require('./binance/rest');
const MarketState = require('./state');
const SignalRouter = require('./strategies/runner');
const RiskGate = require('./risk');
const Executor = require('./executor');
const dashboard = require('./dashboard/server');

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`[boot] missing env ${name} (see .env.example)`);
    process.exit(1);
  }
  return v;
}

function parseFilters(info, pairs) {
  const out = {};
  for (const s of info.symbols || []) {
    if (!pairs.includes(s.symbol)) continue;
    const lot = s.filters.find((f) => f.filterType === 'LOT_SIZE');
    const tick = s.filters.find((f) => f.filterType === 'PRICE_FILTER');
    const notional = s.filters.find((f) => f.filterType === 'NOTIONAL' || f.filterType === 'MIN_NOTIONAL');
    out[s.symbol] = {
      stepSize: lot ? parseFloat(lot.stepSize) : 0,
      tickSize: tick ? parseFloat(tick.tickSize) : 0,
      minNotional: notional ? parseFloat(notional.minNotional || notional.notional || 0) : 0,
    };
  }
  return out;
}

async function fetchEquity(rest) {
  const acct = await rest.account();
  let total = 0;
  for (const b of acct.balances) {
    if (b.asset === 'USDT') total += parseFloat(b.free) + parseFloat(b.locked);
  }
  return total;
}

async function snapshotEquity(rest, risk) {
  try {
    const eq = await fetchEquity(rest);
    db.insertEquity(Date.now(), eq, risk.dailyPnlPct());
  } catch (e) {
    console.warn('[equity] snapshot failed:', e.message);
  }
}

function waitForAllPairsReady(marketState, pairs, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    if (marketState.allPairsReady()) return resolve();
    const timer = setTimeout(() => {
      const missing = pairs.filter((p) => !marketState.firstEventByPair[p]);
      reject(new Error(`WS pairs not ready: ${missing.join(', ')}`));
    }, timeoutMs);
    marketState.on('firstEvent', () => {
      if (marketState.allPairsReady()) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}

async function main() {
  const apiKey = requireEnv('BINANCE_TESTNET_API_KEY');
  const apiSecret = requireEnv('BINANCE_TESTNET_SECRET');

  const rest = new BinanceRest({ apiKey, apiSecret });
  const equity = await fetchEquity(rest);
  console.log(`[boot] portfolio balance = ${equity.toFixed(2)} USDT`);

  const info = await rest.exchangeInfo(config.pairs);
  const filters = parseFilters(info, config.pairs);

  const risk = new RiskGate();
  risk.setBaseEquity(equity);

  const marketState = new MarketState(config.pairs);
  const ws = new BinanceWs(config.pairs);
  marketState.attach(ws);
  ws.connect();

  await waitForAllPairsReady(marketState, config.pairs);
  console.log(`[boot] live for ${config.pairs.join(' ')}`);

  const executor = new Executor({ rest, risk, marketState, symbolFilters: filters });
  const router = new SignalRouter(marketState, executor);
  router.start();

  await dashboard.start({ marketState, risk, executor });

  setInterval(() => snapshotEquity(rest, risk), 60_000);
  snapshotEquity(rest, risk);

  const shutdown = () => {
    console.log('[boot] shutting down');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error('[boot] fatal:', e.message);
  process.exit(1);
});
