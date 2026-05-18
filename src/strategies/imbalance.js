'use strict';

const config = require('../../config');

const cfg = config.strategies.imbalance;
const lastEvalAt = {};

function evaluate(pair, book, lastPrice) {
  const now = Date.now();
  if (lastEvalAt[pair] && now - lastEvalAt[pair] < cfg.throttleMs) return null;
  if (!book || !book.bids?.length || !book.asks?.length) return null;
  lastEvalAt[pair] = now;

  const bidQty = book.bids.slice(0, cfg.levels).reduce((a, [, q]) => a + q, 0);
  const askQty = book.asks.slice(0, cfg.levels).reduce((a, [, q]) => a + q, 0);
  if (askQty <= 0 || bidQty <= 0) return null;
  const ratio = bidQty / askQty;

  if (ratio >= cfg.buyRatio) {
    const conf = Math.min(1, 0.45 + Math.log2(ratio) * 0.18);
    return {
      pair, strategy: 'imbalance', side: 'BUY',
      confidence: +conf.toFixed(3), entry: lastPrice ?? book.asks[0][0],
      reason: `book bid/ask ${ratio.toFixed(2)}`,
      ts: now,
    };
  }
  if (ratio <= cfg.sellRatio) {
    const inv = 1 / ratio;
    const conf = Math.min(1, 0.45 + Math.log2(inv) * 0.18);
    return {
      pair, strategy: 'imbalance', side: 'SELL',
      confidence: +conf.toFixed(3), entry: lastPrice ?? book.bids[0][0],
      reason: `book bid/ask ${ratio.toFixed(2)}`,
      ts: now,
    };
  }
  return null;
}

module.exports = { evaluate };
