'use strict';

const crypto = require('crypto');
const { request } = require('undici');
const config = require('../../config');

class BinanceRest {
  constructor({ apiKey, apiSecret }) {
    if (!apiKey || !apiSecret) throw new Error('BinanceRest: missing apiKey/apiSecret');
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.base = config.binance.restBase;
    this.recvWindow = config.binance.recvWindow;
  }

  sign(query) {
    return crypto.createHmac('sha256', this.apiSecret).update(query).digest('hex');
  }

  qs(params) {
    return Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
  }

  async public(path, params = {}) {
    const url = `${this.base}${path}${Object.keys(params).length ? '?' + this.qs(params) : ''}`;
    const { statusCode, body } = await request(url, { method: 'GET' });
    const text = await body.text();
    if (statusCode >= 400) throw new Error(`[rest:public] ${statusCode} ${path}: ${text}`);
    return JSON.parse(text);
  }

  async signed(method, path, params = {}) {
    const merged = { ...params, timestamp: Date.now(), recvWindow: this.recvWindow };
    const query = this.qs(merged);
    const signature = this.sign(query);
    const url = `${this.base}${path}?${query}&signature=${signature}`;
    const { statusCode, body } = await request(url, {
      method,
      headers: { 'X-MBX-APIKEY': this.apiKey },
    });
    const text = await body.text();
    if (statusCode >= 400) throw new Error(`[rest:signed] ${statusCode} ${method} ${path}: ${text}`);
    return JSON.parse(text);
  }

  account() { return this.signed('GET', '/api/v3/account'); }

  exchangeInfo(symbols) {
    const params = symbols ? { symbols: JSON.stringify(symbols) } : {};
    return this.public('/api/v3/exchangeInfo', params);
  }

  marketBuy(symbol, quantity) {
    return this.signed('POST', '/api/v3/order', {
      symbol, side: 'BUY', type: 'MARKET', quantity,
    });
  }

  marketSell(symbol, quantity) {
    return this.signed('POST', '/api/v3/order', {
      symbol, side: 'SELL', type: 'MARKET', quantity,
    });
  }

  ocoSell(symbol, quantity, takePrice, stopPrice, stopLimitPrice) {
    return this.signed('POST', '/api/v3/order/oco', {
      symbol,
      side: 'SELL',
      quantity,
      price: takePrice,
      stopPrice,
      stopLimitPrice,
      stopLimitTimeInForce: 'GTC',
    });
  }

  orderList(orderListId) {
    return this.signed('GET', '/api/v3/orderList', { orderListId });
  }

  order(symbol, orderId) {
    return this.signed('GET', '/api/v3/order', { symbol, orderId });
  }

  cancelOrderList(symbol, orderListId) {
    return this.signed('DELETE', '/api/v3/orderList', { symbol, orderListId });
  }

  async serverTime() {
    return this.public('/api/v3/time');
  }
}

module.exports = BinanceRest;
