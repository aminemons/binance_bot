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
    tpPctMin: 0.005,
    dailyLossPausePct: 0.05,
    cooldownMs: 180_000,
    quietHoursUtc: { start: 0, end: 4 },
    onePerPair: true,
  },

  strategies: {
    momentum: {
      priority: 1,
      rsiPeriod: 14,
      rsiTrigger: 55,
      volMaPeriod: 20,
      volMultiplier: 2.0,
      emaPeriod: 9,
      tpPct: 0.005,
      slPct: 0.002,
    },
    imbalance: {
      priority: 2,
      levels: 10,
      throttleMs: 500,
      entryRatio: 3.0,
      exitRatio: 1.5,
      exitConfirmTicks: 2,
      monitorMs: 500,
      tpPct: 0.005,
      slPct: 0.0025,
    },
    breakoutRetest: {
      priority: 3,
      resistanceLookback15m: 20,
      retestWindowBars: 10,
      retestProximity: 0.0005,
      confirmCloses: 2,
      tpPctMin: 0.005,
      slPctMax: 0.0025,
    },
  },

  dashboard: { port: 3000, ssePushMs: 1000, chartBars: 200 },
};
