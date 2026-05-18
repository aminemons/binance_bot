'use strict';

function findSwingHighAbove(klines, lookback, level) {
  if (!klines || klines.length < 3) return null;
  const slice = klines.slice(-lookback);
  const highs = slice.map((k) => k.high);
  let best = null;
  for (let i = 1; i < highs.length - 1; i++) {
    if (highs[i] > highs[i - 1] && highs[i] > highs[i + 1] && highs[i] > level) {
      if (best == null || highs[i] < best) best = highs[i];
    }
  }
  return best;
}

function resistance15m(klines, lookback) {
  if (!klines || klines.length === 0) return null;
  const slice = klines.slice(-lookback);
  let h = -Infinity;
  for (const k of slice) if (k.high > h) h = k.high;
  return Number.isFinite(h) ? h : null;
}

module.exports = { findSwingHighAbove, resistance15m };
