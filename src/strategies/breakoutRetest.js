'use strict';

const { findSwingHighAbove, resistance15m } = require('../indicators/swing');
const config = require('../../config');

const cfg = config.strategies.breakoutRetest;
const state = {};

function getState(pair) {
  if (!state[pair]) state[pair] = { phase: 'IDLE', level: null, brokenAt: 0, retestLow: null, retestAt: 0, confirmCount: 0, secondConfirmLow: null };
  return state[pair];
}

function reset(pair) {
  state[pair] = { phase: 'IDLE', level: null, brokenAt: 0, retestLow: null, retestAt: 0, confirmCount: 0, secondConfirmLow: null };
}

function evaluate(pair, klines1m, klines15m) {
  if (klines1m.length < 2 || klines15m.length < cfg.resistanceLookback15m) return null;
  const last = klines1m[klines1m.length - 1];
  const resistance = resistance15m(klines15m.slice(0, -1), cfg.resistanceLookback15m);
  if (resistance == null) return null;
  const s = getState(pair);
  const now = Date.now();

  if (s.phase === 'IDLE') {
    if (last.close > resistance) {
      s.phase = 'BROKEN';
      s.level = resistance;
      s.brokenAt = now;
      s.confirmCount = 0;
    }
    return null;
  }

  if (s.phase === 'BROKEN') {
    if (klines1m.length - klines1m.findIndex((k) => k.openTime === last.openTime) > cfg.retestWindowBars) {
      reset(pair);
      return null;
    }
    if (last.low <= s.level * (1 + cfg.retestProximity) && last.close >= s.level) {
      s.phase = 'RETESTING';
      s.retestLow = last.low;
      s.retestAt = now;
      s.confirmCount = 0;
      return null;
    }
    return null;
  }

  if (s.phase === 'RETESTING') {
    if (last.close > s.level) {
      s.confirmCount += 1;
      if (s.confirmCount === 1) {
        s.secondConfirmLow = last.low;
        return null;
      }
      if (s.confirmCount >= cfg.confirmCloses) {
        const entry = last.close;
        const swing = findSwingHighAbove(klines15m, cfg.resistanceLookback15m, s.level);
        const tp = swing != null && swing > entry ? swing : entry * (1 + cfg.tpPctMin);
        let sl = Math.min(s.retestLow, s.secondConfirmLow ?? s.retestLow, last.low);
        const slFloor = entry * (1 - cfg.slPctMax);
        if (sl < slFloor) sl = slFloor;
        const reason = `breakout: 15m res ${s.level.toFixed(4)} broken, retest ${s.retestLow.toFixed(4)}, ${cfg.confirmCloses}x confirm`;
        reset(pair);
        return {
          pair,
          strategy: 'breakoutRetest',
          priority: cfg.priority,
          side: 'BUY',
          entry,
          tpAbsolute: tp,
          slAbsolute: sl,
          reason,
          ts: now,
        };
      }
    } else {
      reset(pair);
    }
  }
  return null;
}

module.exports = { evaluate, _state: state, _reset: reset };
