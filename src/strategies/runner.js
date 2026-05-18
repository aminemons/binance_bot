'use strict';

const { EventEmitter } = require('events');
const momentum = require('./momentum');
const imbalance = require('./imbalance');
const breakoutRetest = require('./breakoutRetest');
const config = require('../../config');

class StrategyRunner extends EventEmitter {
  constructor(marketState) {
    super();
    this.state = marketState;
    this.buffer = [];
    this.seq = 0;
  }

  attach() {
    this.state.on('klineClosed', (bar) => this.onKline(bar));
    this.state.on('depth', (d) => this.onDepth(d));
  }

  push(sig) {
    if (!sig) return;
    sig.id = ++this.seq;
    this.buffer.push(sig);
    this.evictOld();
    this.emit('signal', sig);
  }

  evictOld() {
    const cutoff = Date.now() - config.signalBufferTtlMs;
    this.buffer = this.buffer.filter((s) => s.ts >= cutoff);
  }

  drain() {
    this.evictOld();
    const out = this.buffer.slice();
    this.buffer = [];
    return out;
  }

  onKline(bar) {
    const s = this.state.get(bar.pair);
    if (!s) return;
    this.push(momentum.evaluate(bar.pair, s.klines));
    this.push(breakoutRetest.evaluate(bar.pair, s.klines));
  }

  onDepth(d) {
    const s = this.state.get(d.pair);
    if (!s) return;
    this.push(imbalance.evaluate(d.pair, s.book, s.lastPrice));
  }
}

module.exports = StrategyRunner;
