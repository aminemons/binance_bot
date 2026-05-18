'use strict';

const config = require('../config');
const db = require('./db');

class RiskGate {
  constructor() {
    this.baseEquity = null;
    this.lastDayStart = db.utcDayStart();
  }

  setBaseEquity(eq) {
    this.baseEquity = eq;
    console.log(`[risk] base equity set to ${eq.toFixed(2)} USDT`);
  }

  rolloverIfNeeded() {
    const today = db.utcDayStart();
    if (today !== this.lastDayStart) {
      this.lastDayStart = today;
      console.log('[risk] UTC day rolled over, daily loss counter reset');
    }
  }

  dailyPnlPct() {
    this.rolloverIfNeeded();
    if (!this.baseEquity) return 0;
    const realized = db.realizedToday();
    return realized / this.baseEquity;
  }

  isPaused() {
    return this.dailyPnlPct() <= -config.risk.dailyLossPausePct;
  }

  positionSizeUsd() {
    if (!this.baseEquity) return 0;
    return this.baseEquity * config.risk.perTradePct;
  }

  check(signal) {
    if (!this.baseEquity) return { ok: false, reason: 'base equity not set' };
    if (this.isPaused()) return { ok: false, reason: `daily loss pause (${(this.dailyPnlPct() * 100).toFixed(2)}%)` };

    const openTrades = db.openTrades();
    if (openTrades.length >= config.risk.maxOpen) {
      return { ok: false, reason: `max open trades reached (${openTrades.length}/${config.risk.maxOpen})` };
    }
    if (config.risk.onePerPair && openTrades.find((t) => t.pair === signal.pair)) {
      return { ok: false, reason: `already open on ${signal.pair}` };
    }
    if (signal.side === 'SELL' && !openTrades.find((t) => t.pair === signal.pair)) {
      return { ok: false, reason: 'spot SELL with no open position (no shorting)' };
    }
    return { ok: true };
  }

  computeLevels(entryPrice, side) {
    if (side === 'BUY') {
      return {
        stopLossPrice: entryPrice * (1 - config.risk.slPct),
        takeProfitPrice: entryPrice * (1 + config.risk.tpPct),
      };
    }
    return {
      stopLossPrice: entryPrice * (1 + config.risk.slPct),
      takeProfitPrice: entryPrice * (1 - config.risk.tpPct),
    };
  }
}

module.exports = RiskGate;
