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
  const totalUnrealized = open.reduce((a, t) => a + (t.unrealized_pnl || 0), 0);
  const realizedToday = db.realizedToday();
  const wr = db.winRate();
  const wrByStrat = db.winRateByStrategy();
  const recent = db.recentTrades(50);
  const pnlByPair = db.pnlByPair();
  return {
    ts: Date.now(),
    pairs: config.pairs,
    status: {
      base_equity: risk.baseEquity,
      paused: risk.isPaused(),
      quiet_hours: risk.inQuietHours(),
      daily_pnl: realizedToday,
      daily_pnl_pct: risk.dailyPnlPct(),
      daily_trade_count: db.dailyTradeCount(),
      position_size_usd: risk.positionSizeUsd(),
      unrealized_total: totalUnrealized,
    },
    open_positions: open,
    pnl_by_pair: pnlByPair,
    win_rate: wr,
    win_rate_by_strategy: wrByStrat,
    recent_trades: recent,
    prices: Object.fromEntries(config.pairs.map((p) => [p, marketState.lastPrice(p)])),
  };
}

function markerFromTrade(t) {
  if (!t.entry_ts) return null;
  return {
    pair: t.pair,
    time: Math.floor(t.entry_ts / 1000),
    position: 'belowBar',
    color: '#3fb950',
    shape: 'arrowUp',
    text: `${t.strategy.slice(0,3).toUpperCase()} ${t.entry_price?.toFixed(4) ?? ''}`,
  };
}
function exitMarkerFromTrade(t) {
  if (!t.exit_ts) return null;
  const profit = (t.pnl ?? 0) > 0;
  return {
    pair: t.pair,
    time: Math.floor(t.exit_ts / 1000),
    position: 'aboveBar',
    color: profit ? '#3fb950' : '#f85149',
    shape: 'arrowDown',
    text: `${(t.pnl ?? 0).toFixed(2)}`,
  };
}

function start({ marketState, risk, executor }) {
  const app = express();
  app.use(express.static(path.join(__dirname, 'public')));

  app.get('/api/state', (_req, res) => {
    res.json(buildState(marketState, risk));
  });

  app.get('/api/klines/:pair', (req, res) => {
    const pair = req.params.pair.toUpperCase();
    if (!config.pairs.includes(pair)) return res.status(404).json({ error: 'unknown pair' });
    const candles = marketState.chartHistory(pair, config.dashboard.chartBars);
    const since = Date.now() - 24 * 60 * 60 * 1000;
    const trades = db.markersForPair(pair, since);
    const markers = [];
    for (const t of trades) {
      const e = markerFromTrade(t);
      if (e) markers.push(e);
      const x = exitMarkerFromTrade(t);
      if (x) markers.push(x);
    }
    markers.sort((a, b) => a.time - b.time);
    res.json({ pair, candles, markers });
  });

  const sseClients = new Set();
  app.get('/events', (req, res) => {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.flushHeaders();
    sseClients.add(res);
    const push = () => {
      res.write(`event: state\ndata: ${JSON.stringify(buildState(marketState, risk))}\n\n`);
    };
    push();
    const t = setInterval(push, config.dashboard.ssePushMs);
    req.on('close', () => {
      clearInterval(t);
      sseClients.delete(res);
    });
  });

  function broadcast(eventName, data) {
    const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sseClients) {
      try { res.write(payload); } catch {}
    }
  }

  marketState.on('kline1mClosed', (bar) => {
    broadcast('kline', { pair: bar.pair, closed: true, bar: { time: Math.floor(bar.openTime / 1000), open: bar.open, high: bar.high, low: bar.low, close: bar.close } });
  });
  marketState.on('kline1mUpdate', (bar) => {
    broadcast('kline', { pair: bar.pair, closed: false, bar: { time: Math.floor(bar.openTime / 1000), open: bar.open, high: bar.high, low: bar.low, close: bar.close } });
  });

  if (executor) {
    executor.on('tradeOpened', (t) => {
      broadcast('marker', {
        pair: t.pair, time: Math.floor(t.entry_ts / 1000),
        position: 'belowBar', color: '#3fb950', shape: 'arrowUp',
        text: `${t.strategy.slice(0,3).toUpperCase()} ${t.entry_price.toFixed(4)}`,
      });
    });
    executor.on('tradeClosed', (t) => {
      const profit = (t.pnl ?? 0) > 0;
      broadcast('marker', {
        pair: t.pair, time: Math.floor((t.exit_ts || Date.now()) / 1000),
        position: 'aboveBar', color: profit ? '#3fb950' : '#f85149', shape: 'arrowDown',
        text: t.pnl != null ? t.pnl.toFixed(2) : t.exit_reason || 'exit',
      });
    });
  }

  return new Promise((resolve) => {
    const server = app.listen(config.dashboard.port, () => {
      console.log(`[dashboard] listening on http://localhost:${config.dashboard.port}`);
      resolve(server);
    });
  });
}

module.exports = { start };
