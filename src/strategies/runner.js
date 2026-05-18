'use strict';

const { EventEmitter } = require('events');
const momentum = require('./momentum');
const imbalance = require('./imbalance');
const breakoutRetest = require('./breakoutRetest');
const db = require('../db');

class SignalRouter extends EventEmitter {
  constructor(marketState, executor) {
    super();
    this.state = marketState;
    this.executor = executor;
    this.active = false;
  }

  start() {
    if (this.active) return;
    this.active = true;
    this.state.on('kline1mClosed', (bar) => this.onKline1m(bar));
    this.state.on('depth', (d) => this.onDepth(d));
  }

  pickHighestPriority(signals) {
    if (!signals.length) return null;
    return signals.reduce((best, s) => (best == null || s.priority < best.priority ? s : best), null);
  }

  logSignal(sig) {
    try {
      db.insertSignal({
        ts: sig.ts, pair: sig.pair, strategy: sig.strategy, side: sig.side,
        raw_confidence: null, reason: sig.reason,
      });
    } catch (e) {}
  }

  async dispatch(pair, candidates) {
    const filtered = candidates.filter(Boolean);
    if (!filtered.length) return;
    for (const c of filtered) this.logSignal(c);
    const winner = this.pickHighestPriority(filtered);
    if (filtered.length > 1) {
      const losers = filtered.filter((s) => s !== winner).map((s) => s.strategy).join(',');
      console.log(`[router] ${pair} priority pick=${winner.strategy} skip=${losers}`);
    }
    this.emit('signal', winner);
    try {
      await this.executor.handleSignal(winner);
    } catch (e) {
      console.error(`[router] dispatch error for ${pair}:`, e.message);
    }
  }

  onKline1m(bar) {
    const s = this.state.get(bar.pair);
    if (!s) return;
    const klines1m = s.klines1m;
    const klines15m = s.klines15m;
    const candidates = [
      momentum.evaluate(bar.pair, klines1m),
      breakoutRetest.evaluate(bar.pair, klines1m, klines15m),
    ];
    this.dispatch(bar.pair, candidates);
  }

  onDepth(d) {
    const s = this.state.get(d.pair);
    if (!s) return;
    const sig = imbalance.evaluate(d.pair, s.book, s.lastPrice, s.klines15m);
    if (sig) this.dispatch(d.pair, [sig]);
  }
}

module.exports = SignalRouter;
