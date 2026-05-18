'use strict';

module.exports = {
  pairs: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'DOGEUSDT', 'XRPUSDT'],

  binance: {
    wsBase: 'wss://stream.testnet.binance.vision/stream',
    restBase: 'https://testnet.binance.vision',
    recvWindow: 5000,
  },

  risk: {
    maxOpen: 8,
    perTradePct: 0.10,
    slPct: 0.002,
    tpPctMin: 0.002,
    dailyLossPausePct: 0.05,
    cooldownMs: 30_000,
    quietHoursUtc: { start: 0, end: 4 },
    onePerPair: true,
  },

  strategies: {
    momentum: {
      priority: 1,
      rsiPeriod: 14,
      rsiTrigger: 50,
      volMaPeriod: 20,
      volMultiplier: 1.2,
      emaPeriod: 9,
      tpPct: 0.0025,
      slPct: 0.0015,
    },
    imbalance: {
      priority: 2,
      levels: 10,
      throttleMs: 250,
      entryRatio: 2.0,
      exitRatio: 1.3,
      exitConfirmTicks: 2,
      monitorMs: 500,
      tpPct: 0.0025,
      slPct: 0.0015,
    },
    breakoutRetest: {
      priority: 3,
      resistanceLookback15m: 20,
      retestWindowBars: 10,
      retestProximity: 0.0005,
      confirmCloses: 1,
      tpPctMin: 0.0025,
      slPctMax: 0.002,
    },
  },

  dashboard: { port: 3000, ssePushMs: 1000, chartBars: 200 },
};
