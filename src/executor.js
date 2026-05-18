'use strict';

const db = require('./db');

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

class Executor {
  constructor({ rest, risk, marketState, symbolFilters }) {
    this.rest = rest;
    this.risk = risk;
    this.state = marketState;
    this.filters = symbolFilters;
    this.pollTimers = new Map();
  }

  async handleApproved(signals) {
    for (const sig of signals) {
      try {
        await this.execute(sig);
      } catch (e) {
        console.error(`[exec] ${sig.pair} ${sig.side} failed:`, e.message);
      }
    }
  }

  async execute(sig) {
    const gate = this.risk.check(sig);
    if (!gate.ok) {
      console.log(`[risk] reject ${sig.pair} ${sig.side}: ${gate.reason}`);
      return;
    }

    if (sig.side === 'SELL') {
      await this.closeOpen(sig);
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

    const { takeProfitPrice, stopLossPrice } = this.risk.computeLevels(avgEntry, 'BUY');
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

    const tradeRow = db.insertTrade({
      pair: sig.pair,
      strategy: sig.strategy,
      side: 'BUY',
      entry_price: avgEntry,
      qty: sellableQty,
      entry_ts: Date.now(),
      binance_entry_order_id: buyResp.orderId?.toString() ?? null,
      binance_oco_id: ocoId,
      claude_confidence: sig.claude?.confidence ?? null,
      claude_reasoning: sig.claude?.note ?? null,
    });

    console.log(`[exec] MARKET BUY ${sig.pair} qty=${sellableQty} avg=${avgEntry.toFixed(4)} -> TP ${tp} SL ${sp} (oco=${ocoId})`);

    if (ocoId) this.startPolling(tradeRow.lastInsertRowid, sig.pair, ocoId);
  }

  startPolling(tradeId, pair, ocoId) {
    if (this.pollTimers.has(tradeId)) return;
    const timer = setInterval(async () => {
      try {
        const result = await this.rest.orderList(ocoId);
        const orders = result.orders || [];
        const reports = result.orderReports || [];
        const allDone = reports.length > 0 && reports.every((o) => ['FILLED', 'CANCELED', 'EXPIRED', 'REJECTED'].includes(o.status));
        if (!allDone) return;
        const filled = reports.find((o) => o.status === 'FILLED');
        if (filled) {
          const exitPrice = parseFloat(filled.price) || parseFloat(filled.stopPrice) || 0;
          const exec = parseFloat(filled.cummulativeQuoteQty || 0);
          const qty = parseFloat(filled.executedQty || 0);
          const realizedExit = qty > 0 ? exec / qty : exitPrice;
          const trade = db.openTrades().find((t) => t.id === tradeId);
          if (trade) {
            const pnl = (realizedExit - trade.entry_price) * trade.qty;
            const pnlPct = (realizedExit - trade.entry_price) / trade.entry_price;
            db.closeTrade({ id: tradeId, exit_price: realizedExit, exit_ts: Date.now(), pnl, pnl_pct: pnlPct });
            console.log(`[exec] closed ${pair} pnl=${pnl.toFixed(4)} (${(pnlPct * 100).toFixed(3)}%)`);
          }
        } else {
          db.cancelTrade(tradeId, Date.now());
          console.log(`[exec] ${pair} OCO ${ocoId} ended without fill`);
        }
        clearInterval(timer);
        this.pollTimers.delete(tradeId);
      } catch (e) {
        console.error(`[exec] poll ${pair} OCO ${ocoId}:`, e.message);
      }
    }, 2000);
    this.pollTimers.set(tradeId, timer);
  }

  async closeOpen(sig) {
    const open = db.openTradeByPair(sig.pair);
    if (!open) return;
    try {
      if (open.binance_oco_id) {
        try { await this.rest.cancelOrderList(sig.pair, open.binance_oco_id); } catch {}
      }
      const sell = await this.rest.marketSell(sig.pair, open.qty);
      const fills = sell.fills || [];
      const filledQty = fills.reduce((a, f) => a + parseFloat(f.qty), 0) || open.qty;
      const cost = fills.reduce((a, f) => a + parseFloat(f.price) * parseFloat(f.qty), 0);
      const exitPrice = filledQty > 0 ? cost / filledQty : this.state.lastPrice(sig.pair);
      const pnl = (exitPrice - open.entry_price) * open.qty;
      const pnlPct = (exitPrice - open.entry_price) / open.entry_price;
      db.closeTrade({ id: open.id, exit_price: exitPrice, exit_ts: Date.now(), pnl, pnl_pct: pnlPct });
      const t = this.pollTimers.get(open.id);
      if (t) { clearInterval(t); this.pollTimers.delete(open.id); }
      console.log(`[exec] manual close ${sig.pair} pnl=${pnl.toFixed(4)}`);
    } catch (e) {
      console.error(`[exec] manual close ${sig.pair} failed:`, e.message);
    }
  }
}

module.exports = Executor;
