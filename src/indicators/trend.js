'use strict';

const { ema } = require('./ema');

function isUptrend(klines, period = 50) {
  if (!klines || klines.length < Math.max(period / 4, 5)) return true;
  const closes = klines.map((k) => k.close);
  const usedPeriod = Math.min(period, closes.length - 1);
  const e = ema(closes, usedPeriod);
  if (e == null) return true;
  return closes[closes.length - 1] >= e;
}

module.exports = { isUptrend };
