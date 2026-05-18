'use strict';

const path = require('path');
const express = require('express');
const db = require('../db');
const config = require('../../config');

function computeAggregates(allClosed) {
  let totalPnl = 0, wins = 0, losses = 0, flat = 0, totalVolume = 0;
  let biggestWin = 0, biggestLoss = 0;
  let totalDuration = 0, durSamples = 0;
  let curStreak = 0, curStreakWin = false, bestWinStreak = 0, bestLossStreak = 0;
  let lastWin = null;
  for (const t of allClosed) {
    const pnl = t.pnl ?? 0;
    totalPnl += pnl;
    if (t.entry_price && t.qty) totalVolume += t.entry_price * t.qty;
    if (pnl > 0) {
      wins += 1;
      if (pnl > biggestWin) biggestWin = pnl;
    } else if (pnl < 0) {
      losses += 1;
      if (pnl < biggestLoss) biggestLoss = pnl;
    } else flat += 1;
    if (t.entry_ts && t.exit_ts) {
      totalDuration += (t.exit_ts - t.entry_ts);
      durSamples += 1;
    }
    const w = pnl > 0;
    if (lastWin == null || lastWin === w) curStreak += 1; else curStreak = 1;
    lastWin = w;
    if (w && curStreak > bestWinStreak) bestWinStreak = curStreak;
    if (!w && pnl < 0 && curStreak > bestLossStreak) bestLossStreak = curStreak;
    curStreakWin = w;
  }
  return {
    total_trades: allClosed.length,
    wins, losses, flat,
    biggest_win: biggestWin,
    biggest_loss: biggestLoss,
    total_volume: totalVolume,
    avg_duration_sec: durSamples ? Math.round(totalDuration / durSamples / 1000) : 0,
    cur_streak_count: curStreak,
    cur_streak_win: curStreakWin,
    best_win_streak: bestWinStreak,
    best_loss_streak: bestLossStreak,
    total_realized: totalPnl,
  };
}

function buildState(marketState, risk) {
  const open = db.openTrades().map((t) => {
    const last = marketState.lastPrice(t.pair);
    const unrealized = last ? (last - t.entry_price) * t.qty : null;
    const unrealizedPct = last ? ((last - t.entry_price) / t.entry_price) * 100 : null;
    const ageSec = t.entry_ts ? Math.round((Date.now() - t.entry_ts) / 1000) : null;
    return { ...t, last_price: last, unrealized_pnl: unrealized, unrealized_pnl_pct: unrealizedPct, age_sec: ageSec };
  });
  const totalUnrealized = open.reduce((a, t) => a + (t.unrealized_pnl || 0), 0);
  const realizedToday = db.realizedToday();
  const wr = db.winRate();
  const wrByStrat = db.winRateByStrategy();
  const recent = db.recentTrades(100);
  const allClosed = recent.filter((t) => t.status === 'closed');
  const agg = computeAggregates(allClosed);
  const pnlByPair = db.pnlByPair();
  const equity = (risk.baseEquity || 0) + totalUnrealized;
  return {
    ts: Date.now(),
    pairs: config.pairs,
    status: {
      base_equity: risk.baseEquity,
      equity_now: equity,
      paused: risk.isPaused(),
      quiet_hours: risk.inQuietHours(),
      daily_pnl: realizedToday,
      daily_pnl_pct: risk.dailyPnlPct(),
      daily_trade_count: db.dailyTradeCount(),
      position_size_usd: risk.positionSizeUsd(),
      unrealized_total: totalUnrealized,
      total_realized: agg.total_realized,
      total_roi_pct: risk.baseEquity ? (agg.total_realized / risk.baseEquity) : 0,
    },
    aggregates: agg,
    open_positions: open,
    pnl_by_pair: pnlByPair,
    win_rate: wr,
    win_rate_by_strategy: wrByStrat,
    recent_trades: recent.slice(0, 50),
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

  const port = parseInt(process.env.PORT || config.dashboard.port, 10);
  return new Promise((resolve, reject) => {
    const server = app.listen(port);
    server.on('listening', () => {
      console.log(`[dashboard] listening on http://localhost:${port}`);
      resolve(server);
    });
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`[dashboard] port ${port} is already in use (probably a stale bot from a previous run).`);
        console.error(`[dashboard] fix:  Get-NetTCPConnection -LocalPort ${port} -State Listen | %{ Stop-Process -Id $_.OwningProcess -Force }`);
        console.error(`[dashboard] or:   $env:PORT=3001; node src/index.js`);
        process.exit(1);
      }
      reject(err);
    });
  });
}

module.exports = { start };
