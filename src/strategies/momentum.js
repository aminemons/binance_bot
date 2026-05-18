'use strict';

const { rsi } = require('../indicators/rsi');
const config = require('../../config');

const cfg = config.strategies.momentum;

function evaluate(pair, klines) {
  if (klines.length < Math.max(cfg.rsiPeriod, cfg.volMaPeriod) + 2) return null;
  const closes = klines.map((k) => k.close);
  const volumes = klines.map((k) => k.volume);

  const rsiNow = rsi(closes, cfg.rsiPeriod);
  const rsiPrev = rsi(closes.slice(0, -1), cfg.rsiPeriod);
  if (rsiNow == null || rsiPrev == null) return null;

  const recentVol = volumes.slice(-cfg.volMaPeriod - 1, -1);
  const volMa = recentVol.reduce((a, b) => a + b, 0) / recentVol.length;
  const curVol = volumes[volumes.length - 1];
  const volRatio = volMa > 0 ? curVol / volMa : 0;

  const last = klines[klines.length - 1];
  if (rsiPrev < cfg.rsiLow && rsiNow >= cfg.rsiLow && volRatio >= cfg.volMultiplier) {
    const distance = Math.min(1, (rsiNow - cfg.rsiLow) / 20);
    const conf = Math.min(1, 0.4 + distance * 0.3 + Math.min(volRatio / 5, 0.3));
    return {
      pair, strategy: 'momentum', side: 'BUY',
      confidence: +conf.toFixed(3), entry: last.close,
      reason: `RSI ${rsiPrev.toFixed(1)}->${rsiNow.toFixed(1)} cross up, vol x${volRatio.toFixed(2)}`,
      ts: Date.now(),
    };
  }
  if (rsiPrev > cfg.rsiHigh && rsiNow <= cfg.rsiHigh && volRatio >= cfg.volMultiplier) {
    const distance = Math.min(1, (cfg.rsiHigh - rsiNow) / 20);
    const conf = Math.min(1, 0.4 + distance * 0.3 + Math.min(volRatio / 5, 0.3));
    return {
      pair, strategy: 'momentum', side: 'SELL',
      confidence: +conf.toFixed(3), entry: last.close,
      reason: `RSI ${rsiPrev.toFixed(1)}->${rsiNow.toFixed(1)} cross down, vol x${volRatio.toFixed(2)}`,
      ts: Date.now(),
    };
  }
  return null;
}

module.exports = { evaluate };
