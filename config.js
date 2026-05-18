'use strict';

module.exports = {
  pairs: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'DOGEUSDT', 'XRPUSDT'],

  binance: {
    wsBase: 'wss://stream.testnet.binance.vision/stream',
    restBase: 'https://testnet.binance.vision',
    recvWindow: 5000,
  },

  risk: {
    maxOpen: 5,
    perTradePct: 0.10,
    slPct: 0.0025,
    tpPct: 0.005,
    dailyLossPausePct: 0.05,
    onePerPair: true,
  },

  ranker: {
    intervalMs: 30_000,
    model: 'claude-sonnet-4-6',
    minConfidence: 0.6,
    maxTokens: 1024,
  },

  strategies: {
    momentum: { rsiPeriod: 14, rsiLow: 30, rsiHigh: 70, volMaPeriod: 20, volMultiplier: 1.5 },
    imbalance: { levels: 10, throttleMs: 500, buyRatio: 2.0, sellRatio: 0.5 },
    breakoutRetest: { lookback: 20, retestWindow: 3 },
  },

  dashboard: { port: 3000, ssePushMs: 1000 },

  signalBufferTtlMs: 60_000,
};
