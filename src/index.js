'use strict';

require('dotenv').config();

const config = require('../config');
const db = require('./db');
const BinanceWs = require('./binance/ws');
const BinanceRest = require('./binance/rest');
const MarketState = require('./state');
const StrategyRunner = require('./strategies/runner');
const Ranker = require('./ranker');
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
    const free = parseFloat(b.free);
    const locked = parseFloat(b.locked);
    if (b.asset === 'USDT') total += free + locked;
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

async function main() {
  const apiKey = requireEnv('BINANCE_API_KEY');
  const apiSecret = requireEnv('BINANCE_API_SECRET');
  const anthropicKey = requireEnv('ANTHROPIC_API_KEY');

  const rest = new BinanceRest({ apiKey, apiSecret });
  const equity = await fetchEquity(rest);
  console.log(`[rest] account fetched, USDT balance = ${equity.toFixed(2)}`);

  const info = await rest.exchangeInfo(config.pairs);
  const filters = parseFilters(info, config.pairs);

  const risk = new RiskGate();
  risk.setBaseEquity(equity);

  const marketState = new MarketState(config.pairs);
  const ws = new BinanceWs(config.pairs);
  marketState.attach(ws);
  ws.connect();

  const runner = new StrategyRunner(marketState);
  runner.attach();
  runner.on('signal', (sig) => {
    db.insertSignal({
      ts: sig.ts, pair: sig.pair, strategy: sig.strategy, side: sig.side,
      raw_confidence: sig.confidence, reason: sig.reason,
      claude_decision: null, claude_confidence: null, claude_note: null,
    });
  });

  const executor = new Executor({ rest, risk, marketState, symbolFilters: filters });

  const ranker = new Ranker({
    apiKey: anthropicKey,
    runner,
    openPositionsFn: () => db.openTrades(),
    stateSnapshotFn: () => marketState.snapshotForRanker(),
  });
  ranker.start(async (approved, allDecided) => {
    for (const sig of allDecided) {
      if (sig.claude) {
        db.insertSignal({
          ts: Date.now(), pair: sig.pair, strategy: sig.strategy, side: sig.side,
          raw_confidence: sig.confidence, reason: 'ranked: ' + (sig.reason || ''),
          claude_decision: sig.claude.decision,
          claude_confidence: sig.claude.confidence,
          claude_note: sig.claude.note,
        });
      }
    }
    await executor.handleApproved(approved);
  });

  await dashboard.start({ marketState, risk });

  setInterval(() => snapshotEquity(rest, risk), 60_000);
  snapshotEquity(rest, risk);

  const shutdown = () => {
    console.log('[boot] shutting down');
    ranker.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error('[boot] fatal:', e);
  process.exit(1);
});
