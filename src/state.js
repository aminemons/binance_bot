'use strict';

const { EventEmitter } = require('events');

const KLINE_HISTORY_1M = 300;
const KLINE_HISTORY_15M = 200;

class MarketState extends EventEmitter {
  constructor(pairs) {
    super();
    this.pairs = pairs;
    this.byPair = {};
    this.firstEventByPair = {};
    for (const p of pairs) {
      this.byPair[p] = {
        klines1m: [],
        klines15m: [],
        currentBar1m: null,
        currentBar15m: null,
        lastPrice: null,
        book: { bids: [], asks: [], ts: 0 },
        recentTrades: [],
      };
      this.firstEventByPair[p] = false;
    }
  }

  attach(ws) {
    ws.on('kline1mClosed', (bar) => this.onKlineClosed(bar, '1m'));
    ws.on('kline1mUpdate', (bar) => this.onKlineUpdate(bar, '1m'));
    ws.on('kline15mClosed', (bar) => this.onKlineClosed(bar, '15m'));
    ws.on('kline15mUpdate', (bar) => this.onKlineUpdate(bar, '15m'));
    ws.on('depth', (d) => this.onDepth(d));
    ws.on('aggTrade', (t) => this.onAggTrade(t));
  }

  markFirstEvent(pair) {
    if (!this.firstEventByPair[pair]) {
      this.firstEventByPair[pair] = true;
      this.emit('firstEvent', pair);
    }
  }

  allPairsReady() {
    return this.pairs.every((p) => this.firstEventByPair[p]);
  }

  onKlineClosed(bar, interval) {
    const s = this.byPair[bar.pair];
    if (!s) return;
    if (interval === '1m') {
      s.klines1m.push(bar);
      if (s.klines1m.length > KLINE_HISTORY_1M) s.klines1m.shift();
      s.currentBar1m = null;
      s.lastPrice = bar.close;
      this.markFirstEvent(bar.pair);
      this.emit('kline1mClosed', bar);
    } else {
      s.klines15m.push(bar);
      if (s.klines15m.length > KLINE_HISTORY_15M) s.klines15m.shift();
      s.currentBar15m = null;
      this.emit('kline15mClosed', bar);
    }
  }

  onKlineUpdate(bar, interval) {
    const s = this.byPair[bar.pair];
    if (!s) return;
    if (interval === '1m') {
      s.currentBar1m = bar;
      s.lastPrice = bar.close;
      this.markFirstEvent(bar.pair);
      this.emit('kline1mUpdate', bar);
    } else {
      s.currentBar15m = bar;
      this.emit('kline15mUpdate', bar);
    }
  }

  onDepth(d) {
    const s = this.byPair[d.pair];
    if (!s) return;
    s.book = { bids: d.bids, asks: d.asks, ts: d.ts };
    if (d.bids.length && d.asks.length) {
      s.lastPrice = (d.bids[0][0] + d.asks[0][0]) / 2;
    }
    this.markFirstEvent(d.pair);
    this.emit('depth', d);
  }

  onAggTrade(t) {
    const s = this.byPair[t.pair];
    if (!s) return;
    s.lastPrice = t.price;
    s.recentTrades.push(t);
    const cutoff = Date.now() - 60_000;
    while (s.recentTrades.length && s.recentTrades[0].ts < cutoff) s.recentTrades.shift();
    this.markFirstEvent(t.pair);
    this.emit('aggTrade', t);
  }

  get(pair) { return this.byPair[pair]; }
  lastPrice(pair) { return this.byPair[pair]?.lastPrice ?? null; }
  klines1m(pair) { return this.byPair[pair]?.klines1m || []; }
  klines15m(pair) { return this.byPair[pair]?.klines15m || []; }
  book(pair) { return this.byPair[pair]?.book; }

  chartHistory(pair, n = 200) {
    const s = this.byPair[pair];
    if (!s) return [];
    const closed = s.klines1m.slice(-n);
    if (s.currentBar1m) closed.push(s.currentBar1m);
    return closed.map((k) => ({
      time: Math.floor(k.openTime / 1000),
      open: k.open, high: k.high, low: k.low, close: k.close,
    }));
  }
}

module.exports = MarketState;
