'use strict';

const path = require('path');
const express = require('express');
const db = require('../db');
const config = require('../../config');

function buildState(marketState, risk) {
  const open = db.openTrades().map((t) => {
    const last = marketState.lastPrice(t.pair);
    const unrealized = last ? (last - t.entry_price) * t.qty : null;
    const unrealizedPct = last ? ((last - t.entry_price) / t.entry_price) * 100 : null;
    return { ...t, last_price: last, unrealized_pnl: unrealized, unrealized_pnl_pct: unrealizedPct };
  });
  const pnlByPair = db.pnlByPair();
  const wr = db.winRate();
  const wrByStrat = db.winRateByStrategy();
  const recent = db.recentTrades(50);
  return {
    ts: Date.now(),
    pairs: config.pairs,
    risk: {
      base_equity: risk.baseEquity,
      daily_pnl_pct: risk.dailyPnlPct(),
      paused: risk.isPaused(),
      position_size_usd: risk.positionSizeUsd(),
    },
    open_positions: open,
    pnl_by_pair: pnlByPair,
    win_rate: wr,
    win_rate_by_strategy: wrByStrat,
    recent_trades: recent,
    prices: Object.fromEntries(config.pairs.map((p) => [p, marketState.lastPrice(p)])),
  };
}

function start({ marketState, risk }) {
  const app = express();
  app.use(express.static(path.join(__dirname, 'public')));

  app.get('/api/state', (_req, res) => {
    res.json(buildState(marketState, risk));
  });

  app.get('/events', (req, res) => {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.flushHeaders();
    const push = () => {
      const payload = JSON.stringify(buildState(marketState, risk));
      res.write(`data: ${payload}\n\n`);
    };
    push();
    const t = setInterval(push, config.dashboard.ssePushMs);
    req.on('close', () => clearInterval(t));
  });

  return new Promise((resolve) => {
    const server = app.listen(config.dashboard.port, () => {
      console.log(`[dashboard] listening on http://localhost:${config.dashboard.port}`);
      resolve(server);
    });
  });
}

module.exports = { start };
