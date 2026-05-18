'use strict';

const { rsi } = require('../indicators/rsi');
const { ema } = require('../indicators/ema');
const config = require('../../config');

const cfg = config.strategies.momentum;

function evaluate(pair, klines1m) {
  const need = Math.max(cfg.rsiPeriod, cfg.volMaPeriod, cfg.emaPeriod) + 2;
  if (klines1m.length < need) return null;

  const closes = klines1m.map((k) => k.close);
  const volumes = klines1m.map((k) => k.volume);

  const rsiNow = rsi(closes, cfg.rsiPeriod);
  const rsiPrev = rsi(closes.slice(0, -1), cfg.rsiPeriod);
  if (rsiNow == null || rsiPrev == null) return null;

  const ema9 = ema(closes, cfg.emaPeriod);
  if (ema9 == null) return null;

  const volPriorWindow = volumes.slice(-cfg.volMaPeriod - 1, -1);
  if (volPriorWindow.length < cfg.volMaPeriod) return null;
  const volMa = volPriorWindow.reduce((a, b) => a + b, 0) / volPriorWindow.length;
  const curVol = volumes[volumes.length - 1];
  const volRatio = volMa > 0 ? curVol / volMa : 0;

  const last = klines1m[klines1m.length - 1];
  const trigger = cfg.rsiTrigger;

  if (rsiPrev < trigger && rsiNow >= trigger && volRatio >= cfg.volMultiplier && last.close > ema9) {
    return {
      pair,
      strategy: 'momentum',
      priority: cfg.priority,
      side: 'BUY',
      entry: last.close,
      tpPct: cfg.tpPct,
      slPct: cfg.slPct,
      reason: `momentum: RSI ${rsiPrev.toFixed(2)}->${rsiNow.toFixed(2)}, vol x${volRatio.toFixed(2)}, close ${last.close.toFixed(4)}>EMA9 ${ema9.toFixed(4)}`,
      ts: Date.now(),
    };
  }
  return null;
}

module.exports = { evaluate };
