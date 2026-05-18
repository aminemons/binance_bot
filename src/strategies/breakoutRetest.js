'use strict';

const config = require('../../config');

const cfg = config.strategies.breakoutRetest;
const pending = {};

function evaluate(pair, klines) {
  if (klines.length < cfg.lookback + 2) return null;
  const window = klines.slice(-cfg.lookback - 1, -1);
  const high = Math.max(...window.map((k) => k.high));
  const low = Math.min(...window.map((k) => k.low));
  const last = klines[klines.length - 1];
  const state = pending[pair] || null;

  if (!state) {
    if (last.close > high) {
      pending[pair] = { dir: 'up', level: high, bars: 0 };
      return null;
    }
    if (last.close < low) {
      pending[pair] = { dir: 'down', level: low, bars: 0 };
      return null;
    }
    return null;
  }

  state.bars += 1;

  if (state.dir === 'up') {
    if (last.low <= state.level * 1.0005 && last.close > state.level) {
      const breakoutPct = (last.close - state.level) / state.level;
      const conf = Math.min(1, 0.55 + Math.min(breakoutPct * 200, 0.4));
      delete pending[pair];
      return {
        pair, strategy: 'breakoutRetest', side: 'BUY',
        confidence: +conf.toFixed(3), entry: last.close,
        reason: `retest of ${state.level.toFixed(4)} held, close ${last.close.toFixed(4)}`,
        ts: Date.now(),
      };
    }
  } else {
    if (last.high >= state.level * 0.9995 && last.close < state.level) {
      const breakoutPct = (state.level - last.close) / state.level;
      const conf = Math.min(1, 0.55 + Math.min(breakoutPct * 200, 0.4));
      delete pending[pair];
      return {
        pair, strategy: 'breakoutRetest', side: 'SELL',
        confidence: +conf.toFixed(3), entry: last.close,
        reason: `retest of ${state.level.toFixed(4)} rejected, close ${last.close.toFixed(4)}`,
        ts: Date.now(),
      };
    }
  }

  if (state.bars >= cfg.retestWindow) delete pending[pair];
  return null;
}

module.exports = { evaluate };
