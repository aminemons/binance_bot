'use strict';

const { EventEmitter } = require('events');
const db = require('./db');
const { computeRatio } = require('./strategies/imbalance');
const config = require('../config');

function stepFloor(value, step) {
  if (!step || step <= 0) return value;
  const n = Math.floor(value / step) * step;
  const decimals = Math.max(0, Math.min(20, (step.toString().split('.')[1] || '').length));
  return parseFloat(n.toFixed(decimals));
}

function priceTickRound(value, tickSize) {
  if (!tickSize || tickSize <= 0) return value;
  const n = Math.round(value / tickSize) * tickSize;
  const decimals = Math.max(0, Math.min(20, (tickSize.toString().split('.')[1] || '').length));
  return parseFloat(n.toFixed(decimals));
}

class Executor extends EventEmitter {
  constructor({ rest, risk, marketState, symbolFilters }) {
    super();
    this.rest = rest;
    this.risk = risk;
    this.state = marketState;
    this.filters = symbolFilters;
    this.pollTimers = new Map();
    this.imbalanceMonitors = new Map();
  }

  async handleSignal(sig) {
    if (!sig) return;
    try {
      await this.execute(sig);
    } catch (e) {
      console.error(`[exec] ${sig.pair} ${sig.side} ${sig.strategy} failed:`, e.message);
    }
  }

  async execute(sig) {
    const gate = this.risk.check(sig);
    if (!gate.ok) {
      console.log(`[risk] reject ${sig.pair} ${sig.strategy} ${sig.side}: ${gate.reason}`);
      return;
    }

    if (sig.side === 'SELL') {
      await this.closeOpen(sig, 'strategy_sell');
      return;
    }

    const f = this.filters[sig.pair];
    if (!f) {
      console.warn(`[exec] no exchange filters for ${sig.pair}`);
      return;
    }
    const price = this.state.lastPrice(sig.pair) ?? sig.entry;
    if (!price) {
      console.warn(`[exec] no price for ${sig.pair}`);
      return;
    }
    const notional = this.risk.positionSizeUsd();
    let qty = stepFloor(notional / price, f.stepSize);
    if (qty <= 0) {
      console.warn(`[exec] qty too small for ${sig.pair}`);
      return;
    }
    if (f.minNotional && qty * price < f.minNotional) {
      console.warn(`[exec] notional ${(qty * price).toFixed(2)} < minNotional ${f.minNotional} for ${sig.pair}`);
      return;
    }

    const buyResp = await this.rest.marketBuy(sig.pair, qty);
    const fills = buyResp.fills || [];
    const filledQty = fills.reduce((a, f) => a + parseFloat(f.qty), 0) || qty;
    const cost = fills.reduce((a, f) => a + parseFloat(f.price) * parseFloat(f.qty), 0);
    const avgEntry = filledQty > 0 ? cost / filledQty : price;
    const sellableQty = stepFloor(filledQty, f.stepSize);

    const { takeProfitPrice, stopLossPrice } = this.risk.computeLevels(avgEntry, sig);
    const tp = priceTickRound(takeProfitPrice, f.tickSize);
    const sp = priceTickRound(stopLossPrice, f.tickSize);
    const sl = priceTickRound(stopLossPrice * 0.999, f.tickSize);

    let ocoId = null;
    try {
      const oco = await this.rest.ocoSell(sig.pair, sellableQty, tp, sp, sl);
      ocoId = oco.orderListId?.toString() ?? null;
    } catch (e) {
      console.error(`[exec] OCO failed for ${sig.pair}:`, e.message);
    }

    const entryTs = Date.now();
    const tradeRow = db.insertTrade({
      pair: sig.pair,
      strategy: sig.strategy,
      side: 'BUY',
      entry_price: avgEntry,
      qty: sellableQty,
      entry_ts: entryTs,
      binance_entry_order_id: buyResp.orderId?.toString() ?? null,
      binance_oco_id: ocoId,
      entry_reason: sig.reason,
      tp_price: tp,
      sl_price: sp,
    });
    const tradeId = tradeRow.lastInsertRowid;

    this.risk.registerEntry(sig.pair, entryTs);

    console.log(`[exec] BUY ${sig.pair} qty=${sellableQty} avg=${avgEntry.toFixed(4)} TP ${tp} SL ${sp} strat=${sig.strategy}`);

    this.emit('tradeOpened', {
      tradeId, pair: sig.pair, strategy: sig.strategy, side: 'BUY',
      entry_price: avgEntry, qty: sellableQty, tp, sl, entry_ts: entryTs, reason: sig.reason,
    });

    if (ocoId) this.startPolling(tradeId, sig.pair, ocoId);
    if (sig.strategy === 'imbalance' && sig.stateExit) this.startImbalanceMonitor(tradeId, sig.pair, sig.stateExit);
  }

  startPolling(tradeId, pair, ocoId) {
    if (this.pollTimers.has(tradeId)) return;
    const timer = setInterval(async () => {
      try {
        const result = await this.rest.orderList(ocoId);
        const reports = result.orderReports || [];
        const allDone = reports.length > 0 && reports.every((o) => ['FILLED', 'CANCELED', 'EXPIRED', 'REJECTED'].includes(o.status));
        if (!allDone) return;
        const filled = reports.find((o) => o.status === 'FILLED');
        const trade = db.openTrades().find((t) => t.id === tradeId);
        if (filled && trade) {
          const exec = parseFloat(filled.cummulativeQuoteQty || 0);
          const qty = parseFloat(filled.executedQty || 0);
          const exitPrice = qty > 0 ? exec / qty : (parseFloat(filled.price) || parseFloat(filled.stopPrice) || 0);
          const pnl = (exitPrice - trade.entry_price) * trade.qty;
          const pnlPct = (exitPrice - trade.entry_price) / trade.entry_price;
          const exitReason = filled.type === 'LIMIT_MAKER' || filled.type === 'LIMIT' ? 'tp_filled' : 'sl_filled';
          db.closeTrade({ id: tradeId, exit_price: exitPrice, exit_ts: Date.now(), pnl, pnl_pct: pnlPct, exit_reason: exitReason });
          console.log(`[exec] closed ${pair} pnl=${pnl.toFixed(4)} (${(pnlPct * 100).toFixed(3)}%) reason=${exitReason}`);
          this.emit('tradeClosed', { tradeId, pair, exit_price: exitPrice, exit_ts: Date.now(), pnl, pnl_pct: pnlPct, exit_reason: exitReason });
        } else if (trade) {
          db.cancelTrade(tradeId, Date.now(), 'oco_ended');
          console.log(`[exec] ${pair} OCO ${ocoId} ended without fill`);
          this.emit('tradeClosed', { tradeId, pair, exit_reason: 'oco_ended', exit_ts: Date.now() });
        }
        clearInterval(timer);
        this.pollTimers.delete(tradeId);
        this.stopImbalanceMonitor(tradeId);
      } catch (e) {
        console.error(`[exec] poll ${pair} OCO ${ocoId}:`, e.message);
      }
    }, 2000);
    this.pollTimers.set(tradeId, timer);
  }

  startImbalanceMonitor(tradeId, pair, exit) {
    if (this.imbalanceMonitors.has(tradeId)) return;
    let confirms = 0;
    const interval = config.strategies.imbalance.monitorMs;
    const timer = setInterval(async () => {
      const book = this.state.book(pair);
      const ratio = computeRatio(book);
      if (ratio == null) return;
      if (ratio < exit.threshold) {
        confirms += 1;
        if (confirms >= exit.confirmTicks) {
          clearInterval(timer);
          this.imbalanceMonitors.delete(tradeId);
          await this.closeTradeById(tradeId, pair, `imbalance_exit ratio=${ratio.toFixed(2)}`);
        }
      } else {
        confirms = 0;
      }
    }, interval);
    this.imbalanceMonitors.set(tradeId, timer);
  }

  stopImbalanceMonitor(tradeId) {
    const t = this.imbalanceMonitors.get(tradeId);
    if (t) { clearInterval(t); this.imbalanceMonitors.delete(tradeId); }
  }

  async closeTradeById(tradeId, pair, reason) {
    const trade = db.openTrades().find((t) => t.id === tradeId);
    if (!trade) return;
    try {
      if (trade.binance_oco_id) {
        try { await this.rest.cancelOrderList(pair, trade.binance_oco_id); } catch {}
      }
      const sell = await this.rest.marketSell(pair, trade.qty);
      const fills = sell.fills || [];
      const filledQty = fills.reduce((a, f) => a + parseFloat(f.qty), 0) || trade.qty;
      const cost = fills.reduce((a, f) => a + parseFloat(f.price) * parseFloat(f.qty), 0);
      const exitPrice = filledQty > 0 ? cost / filledQty : this.state.lastPrice(pair);
      const pnl = (exitPrice - trade.entry_price) * trade.qty;
      const pnlPct = (exitPrice - trade.entry_price) / trade.entry_price;
      db.closeTrade({ id: tradeId, exit_price: exitPrice, exit_ts: Date.now(), pnl, pnl_pct: pnlPct, exit_reason: reason });
      const t = this.pollTimers.get(tradeId);
      if (t) { clearInterval(t); this.pollTimers.delete(tradeId); }
      console.log(`[exec] forced close ${pair} pnl=${pnl.toFixed(4)} reason=${reason}`);
      this.emit('tradeClosed', { tradeId, pair, exit_price: exitPrice, exit_ts: Date.now(), pnl, pnl_pct: pnlPct, exit_reason: reason });
    } catch (e) {
      console.error(`[exec] forced close ${pair} failed:`, e.message);
    }
  }

  async closeOpen(sig, reason) {
    const open = db.openTradeByPair(sig.pair);
    if (!open) return;
    await this.closeTradeById(open.id, sig.pair, reason);
  }
}

module.exports = Executor;
