'use strict';

const { EventEmitter } = require('events');
const config = require('../config');

const KLINE_HISTORY = 200;

class MarketState extends EventEmitter {
  constructor(pairs) {
    super();
    this.pairs = pairs;
    this.byPair = {};
    for (const p of pairs) {
      this.byPair[p] = {
        klines: [],
        lastPrice: null,
        book: { bids: [], asks: [], ts: 0 },
        recentTrades: [],
      };
    }
  }

  attach(ws) {
    ws.on('klineClosed', (bar) => this.onKlineClosed(bar));
    ws.on('klineUpdate', (bar) => this.onKlineUpdate(bar));
    ws.on('depth', (d) => this.onDepth(d));
    ws.on('aggTrade', (t) => this.onAggTrade(t));
  }

  onKlineClosed(bar) {
    const s = this.byPair[bar.pair];
    if (!s) return;
    s.klines.push(bar);
    if (s.klines.length > KLINE_HISTORY) s.klines.shift();
    s.lastPrice = bar.close;
    this.emit('klineClosed', bar);
  }

  onKlineUpdate(bar) {
    const s = this.byPair[bar.pair];
    if (!s) return;
    s.lastPrice = bar.close;
    this.emit('klineUpdate', bar);
  }

  onDepth(d) {
    const s = this.byPair[d.pair];
    if (!s) return;
    s.book = { bids: d.bids, asks: d.asks, ts: d.ts };
    if (d.bids.length && d.asks.length) {
      s.lastPrice = (d.bids[0][0] + d.asks[0][0]) / 2;
    }
    this.emit('depth', d);
  }

  onAggTrade(t) {
    const s = this.byPair[t.pair];
    if (!s) return;
    s.lastPrice = t.price;
    s.recentTrades.push(t);
    const cutoff = Date.now() - 60_000;
    while (s.recentTrades.length && s.recentTrades[0].ts < cutoff) s.recentTrades.shift();
    this.emit('aggTrade', t);
  }

  get(pair) { return this.byPair[pair]; }
  lastPrice(pair) { return this.byPair[pair]?.lastPrice ?? null; }

  snapshotForRanker() {
    const out = {};
    for (const p of this.pairs) {
      const s = this.byPair[p];
      const closes = s.klines.map((k) => k.close);
      const last = s.lastPrice;
      const prev = closes.length >= 2 ? closes[closes.length - 2] : last;
      const pct1m = (prev && last) ? ((last - prev) / prev) * 100 : 0;
      out[p] = { lastPrice: last, pct1m: +pct1m.toFixed(4) };
    }
    return out;
  }
}

module.exports = MarketState;
