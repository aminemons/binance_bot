'use strict';

const config = require('../config');
const db = require('./db');

class RiskGate {
  constructor() {
    this.baseEquity = null;
    this.lastDayStart = db.utcDayStart();
    this.lastEntryByPair = {};
  }

  setBaseEquity(eq) {
    this.baseEquity = eq;
    console.log(`[risk] base equity set to ${eq.toFixed(2)} USDT`);
  }

  registerEntry(pair, ts = Date.now()) {
    this.lastEntryByPair[pair] = ts;
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

  inQuietHours(now = new Date()) {
    const h = now.getUTCHours();
    const { start, end } = config.risk.quietHoursUtc;
    if (start <= end) return h >= start && h < end;
    return h >= start || h < end;
  }

  cooldownRemainingMs(pair) {
    const last = this.lastEntryByPair[pair] ?? db.lastEntryTsForPair(pair);
    if (!last) return 0;
    const elapsed = Date.now() - last;
    return Math.max(0, config.risk.cooldownMs - elapsed);
  }

  positionSizeUsd() {
    if (!this.baseEquity) return 0;
    return this.baseEquity * config.risk.perTradePct;
  }

  check(signal) {
    if (!this.baseEquity) return { ok: false, reason: 'base equity not set' };
    if (this.isPaused()) return { ok: false, reason: `daily loss pause (${(this.dailyPnlPct() * 100).toFixed(2)}%)` };
    if (this.inQuietHours()) return { ok: false, reason: 'quiet hours 00:00-04:00 UTC' };

    const openTrades = db.openTrades();
    if (openTrades.length >= config.risk.maxOpen) {
      return { ok: false, reason: `max open trades (${openTrades.length}/${config.risk.maxOpen})` };
    }

    const cdRemaining = this.cooldownRemainingMs(signal.pair);
    if (cdRemaining > 0) {
      return { ok: false, reason: `cooldown ${Math.ceil(cdRemaining / 1000)}s remaining` };
    }

    if (config.risk.onePerPair && openTrades.find((t) => t.pair === signal.pair)) {
      return { ok: false, reason: `already open on ${signal.pair}` };
    }
    if (signal.side === 'SELL' && !openTrades.find((t) => t.pair === signal.pair)) {
      return { ok: false, reason: 'spot SELL with no open position' };
    }
    return { ok: true };
  }

  computeLevels(entryPrice, signal) {
    if (signal.tpAbsolute != null && signal.slAbsolute != null) {
      const minTp = entryPrice * (1 + config.risk.tpPctMin);
      const maxSl = entryPrice * (1 - config.risk.slPct);
      return {
        takeProfitPrice: Math.max(signal.tpAbsolute, minTp),
        stopLossPrice: Math.max(signal.slAbsolute, maxSl),
      };
    }
    const tpPct = Math.max(signal.tpPct ?? config.risk.tpPctMin, config.risk.tpPctMin);
    const slPct = Math.min(signal.slPct ?? config.risk.slPct, config.risk.slPct);
    return {
      takeProfitPrice: entryPrice * (1 + tpPct),
      stopLossPrice: entryPrice * (1 - slPct),
    };
  }
}

module.exports = RiskGate;
