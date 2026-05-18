'use strict';

const config = require('../../config');

const cfg = config.strategies.imbalance;
const lastEvalAt = {};

function computeRatio(book) {
  if (!book || !book.bids?.length || !book.asks?.length) return null;
  const bidQty = book.bids.slice(0, cfg.levels).reduce((a, [, q]) => a + q, 0);
  const askQty = book.asks.slice(0, cfg.levels).reduce((a, [, q]) => a + q, 0);
  if (bidQty <= 0 || askQty <= 0) return null;
  return bidQty / askQty;
}

function evaluate(pair, book, lastPrice) {
  const now = Date.now();
  if (lastEvalAt[pair] && now - lastEvalAt[pair] < cfg.throttleMs) return null;
  lastEvalAt[pair] = now;

  const ratio = computeRatio(book);
  if (ratio == null) return null;

  if (ratio >= cfg.entryRatio) {
    const entry = lastPrice ?? book.asks[0][0];
    return {
      pair,
      strategy: 'imbalance',
      priority: cfg.priority,
      side: 'BUY',
      entry,
      tpPct: cfg.tpPct,
      slPct: cfg.slPct,
      reason: `imbalance: bid/ask ratio ${ratio.toFixed(2)} (>= ${cfg.entryRatio})`,
      ts: now,
      stateExit: { type: 'imbalance_drop', threshold: cfg.exitRatio, confirmTicks: cfg.exitConfirmTicks },
    };
  }
  return null;
}

module.exports = { evaluate, computeRatio };
