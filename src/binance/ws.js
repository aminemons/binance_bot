'use strict';

const WebSocket = require('ws');
const { EventEmitter } = require('events');
const config = require('../../config');

class BinanceWs extends EventEmitter {
  constructor(pairs) {
    super();
    this.pairs = pairs;
    this.ws = null;
    this.reconnectDelay = 1000;
    this.maxReconnectDelay = 30_000;
    this.connected = false;
    this.subscribedCount = 0;
  }

  buildUrl() {
    const streams = [];
    for (const p of this.pairs) {
      const lower = p.toLowerCase();
      streams.push(`${lower}@kline_1m`);
      streams.push(`${lower}@kline_15m`);
      streams.push(`${lower}@depth20@100ms`);
      streams.push(`${lower}@aggTrade`);
    }
    this.subscribedCount = streams.length;
    return `${config.binance.wsBase}?streams=${streams.join('/')}`;
  }

  connect() {
    const url = this.buildUrl();
    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      this.connected = true;
      this.reconnectDelay = 1000;
      console.log(`[ws] connected, ${this.subscribedCount} streams subscribed`);
      this.emit('open');
    });

    this.ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (!msg || !msg.stream || !msg.data) return;
      this.route(msg.stream, msg.data);
    });

    this.ws.on('error', (err) => {
      console.error('[ws] error:', err.message);
    });

    this.ws.on('close', () => {
      this.connected = false;
      console.warn(`[ws] disconnected, reconnecting in ${this.reconnectDelay}ms`);
      setTimeout(() => this.connect(), this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
    });
  }

  route(stream, data) {
    const [lowerPair, kind] = stream.split('@');
    const pair = lowerPair.toUpperCase();
    if (kind === 'kline_1m' || kind === 'kline_15m') {
      const k = data.k;
      const bar = {
        pair,
        interval: k.i,
        openTime: k.t,
        closeTime: k.T,
        open: parseFloat(k.o),
        high: parseFloat(k.h),
        low: parseFloat(k.l),
        close: parseFloat(k.c),
        volume: parseFloat(k.v),
        closed: !!k.x,
      };
      const suffix = kind === 'kline_15m' ? '15m' : '1m';
      if (bar.closed) this.emit(`kline${suffix}Closed`, bar);
      else this.emit(`kline${suffix}Update`, bar);
    } else if (kind === 'depth20' || kind.startsWith('depth20')) {
      this.emit('depth', {
        pair,
        bids: data.bids.map(([p, q]) => [parseFloat(p), parseFloat(q)]),
        asks: data.asks.map(([p, q]) => [parseFloat(p), parseFloat(q)]),
        ts: Date.now(),
      });
    } else if (kind === 'aggTrade') {
      this.emit('aggTrade', {
        pair,
        price: parseFloat(data.p),
        qty: parseFloat(data.q),
        ts: data.T,
        isBuyerMaker: data.m,
      });
    }
  }
}

module.exports = BinanceWs;
