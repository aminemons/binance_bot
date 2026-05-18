'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
const DB_PATH = path.join(DB_DIR, 'trades.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pair TEXT NOT NULL,
    strategy TEXT NOT NULL,
    side TEXT NOT NULL,
    entry_price REAL,
    exit_price REAL,
    qty REAL,
    pnl REAL,
    pnl_pct REAL,
    entry_ts INTEGER,
    exit_ts INTEGER,
    status TEXT NOT NULL CHECK(status IN ('open','closed','cancelled')),
    binance_entry_order_id TEXT,
    binance_oco_id TEXT,
    claude_confidence REAL,
    claude_reasoning TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);
  CREATE INDEX IF NOT EXISTS idx_trades_pair ON trades(pair);
  CREATE INDEX IF NOT EXISTS idx_trades_entry_ts ON trades(entry_ts);

  CREATE TABLE IF NOT EXISTS signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    pair TEXT NOT NULL,
    strategy TEXT NOT NULL,
    side TEXT NOT NULL,
    raw_confidence REAL,
    reason TEXT,
    claude_decision TEXT,
    claude_confidence REAL,
    claude_note TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_signals_ts ON signals(ts);

  CREATE TABLE IF NOT EXISTS equity_snapshots (
    ts INTEGER PRIMARY KEY,
    equity REAL NOT NULL,
    daily_pnl_pct REAL
  );
`);

const stmts = {
  insertSignal: db.prepare(`
    INSERT INTO signals (ts, pair, strategy, side, raw_confidence, reason, claude_decision, claude_confidence, claude_note)
    VALUES (@ts, @pair, @strategy, @side, @raw_confidence, @reason, @claude_decision, @claude_confidence, @claude_note)
  `),
  insertTrade: db.prepare(`
    INSERT INTO trades (pair, strategy, side, entry_price, qty, entry_ts, status, binance_entry_order_id, binance_oco_id, claude_confidence, claude_reasoning)
    VALUES (@pair, @strategy, @side, @entry_price, @qty, @entry_ts, 'open', @binance_entry_order_id, @binance_oco_id, @claude_confidence, @claude_reasoning)
  `),
  closeTrade: db.prepare(`
    UPDATE trades SET exit_price = @exit_price, exit_ts = @exit_ts, pnl = @pnl, pnl_pct = @pnl_pct, status = 'closed'
    WHERE id = @id
  `),
  cancelTrade: db.prepare(`UPDATE trades SET status = 'cancelled', exit_ts = @exit_ts WHERE id = @id`),
  openTrades: db.prepare(`SELECT * FROM trades WHERE status = 'open' ORDER BY entry_ts DESC`),
  openTradeByPair: db.prepare(`SELECT * FROM trades WHERE status = 'open' AND pair = ? LIMIT 1`),
  recentTrades: db.prepare(`SELECT * FROM trades ORDER BY id DESC LIMIT ?`),
  closedTradesSince: db.prepare(`SELECT * FROM trades WHERE status = 'closed' AND exit_ts >= ?`),
  insertEquity: db.prepare(`INSERT OR REPLACE INTO equity_snapshots (ts, equity, daily_pnl_pct) VALUES (?, ?, ?)`),
  pnlByPair: db.prepare(`
    SELECT pair,
           SUM(CASE WHEN status='closed' THEN pnl ELSE 0 END) AS realized_pnl,
           SUM(CASE WHEN status='closed' AND exit_ts >= ? THEN pnl ELSE 0 END) AS realized_pnl_today,
           SUM(CASE WHEN status='closed' THEN 1 ELSE 0 END) AS closed_count
    FROM trades GROUP BY pair
  `),
  winRate: db.prepare(`
    SELECT
      SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) AS wins,
      SUM(CASE WHEN pnl <= 0 THEN 1 ELSE 0 END) AS losses,
      COUNT(*) AS total
    FROM trades WHERE status = 'closed'
  `),
  winRateByStrategy: db.prepare(`
    SELECT strategy,
           SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) AS wins,
           SUM(CASE WHEN pnl <= 0 THEN 1 ELSE 0 END) AS losses,
           COUNT(*) AS total
    FROM trades WHERE status = 'closed' GROUP BY strategy
  `),
  realizedSince: db.prepare(`SELECT COALESCE(SUM(pnl), 0) AS pnl FROM trades WHERE status='closed' AND exit_ts >= ?`),
};

function utcDayStart(ts = Date.now()) {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

module.exports = {
  db,
  insertSignal: (row) => stmts.insertSignal.run(row),
  insertTrade: (row) => stmts.insertTrade.run(row),
  closeTrade: (row) => stmts.closeTrade.run(row),
  cancelTrade: (id, exitTs) => stmts.cancelTrade.run({ id, exit_ts: exitTs }),
  openTrades: () => stmts.openTrades.all(),
  openTradeByPair: (pair) => stmts.openTradeByPair.get(pair),
  recentTrades: (n = 50) => stmts.recentTrades.all(n),
  closedTradesSince: (sinceTs) => stmts.closedTradesSince.all(sinceTs),
  insertEquity: (ts, equity, dailyPnlPct) => stmts.insertEquity.run(ts, equity, dailyPnlPct),
  pnlByPair: () => stmts.pnlByPair.all(utcDayStart()),
  winRate: () => stmts.winRate.get(),
  winRateByStrategy: () => stmts.winRateByStrategy.all(),
  realizedToday: () => stmts.realizedSince.get(utcDayStart()).pnl,
  utcDayStart,
};
