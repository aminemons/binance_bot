'use strict';

const COLOR = !!process.stdout.isTTY;
const c = (code, s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const ts = () => new Date().toISOString().slice(11, 19);

function fmt(money) {
  if (money == null || isNaN(money)) return '       -';
  const s = (money >= 0 ? '+' : '') + money.toFixed(2);
  return s.padStart(8);
}

function entry({ pair, strategy, qty, price, tp, sl, reason }) {
  const head = c('36;1', '↑ ENTRY');
  const body = `${pair.padEnd(8)} ${strategy.padEnd(8)} qty=${String(qty).padEnd(10)} @ ${c('1', price.toFixed(4))} TP ${c('32', tp.toFixed(4))} SL ${c('31', sl.toFixed(4))}`;
  const tag = c('2', `[${ts()}]`);
  console.log(`${tag} ${head} ${body}`);
  if (reason) console.log(`${tag}        ${c('2', reason)}`);
}

function close({ pair, strategy, entry: e, exit: x, pnl, pnlPct, durationSec, reason }) {
  const win = pnl > 0;
  const flat = pnl === 0 || pnl == null;
  const head = win
    ? c('32;1', '✓ WIN  ')
    : flat
      ? c('2', '— FLAT ')
      : c('31;1', '✗ LOSS ');
  const pnlStr = pnl == null ? '       -' : fmt(pnl);
  const pnlColor = win ? c('32;1', pnlStr) : flat ? pnlStr : c('31;1', pnlStr);
  const pctStr = pnlPct == null ? '   -' : (pnlPct >= 0 ? '+' : '') + (pnlPct * 100).toFixed(3) + '%';
  const pctColor = win ? c('32', pctStr) : flat ? pctStr : c('31', pctStr);
  const dur = durationSec != null ? `${durationSec}s` : '';
  const body = `${pair.padEnd(8)} ${strategy.padEnd(8)} ${e?.toFixed(4) || '-'} → ${x?.toFixed(4) || '-'}  ${pnlColor} (${pctColor}) ${c('2', dur)}`;
  const tag = c('2', `[${ts()}]`);
  console.log(`${tag} ${head} ${body}`);
  if (reason) console.log(`${tag}        ${c('2', reason)}`);
}

function skip(msg) { console.log(`${c('2', '[' + ts() + ']')} ${c('33;2', '✗ SKIP ')} ${c('2', msg)}`); }
function info(msg) { console.log(`${c('2', '[' + ts() + ']')} ${c('36', '• INFO ')} ${msg}`); }
function warn(msg) { console.log(`${c('2', '[' + ts() + ']')} ${c('33;1', '! WARN ')} ${c('33', msg)}`); }
function error(msg) { console.error(`${c('2', '[' + ts() + ']')} ${c('31;1', '! ERR  ')} ${c('31', msg)}`); }
function boot(msg) { console.log(`${c('2', '[' + ts() + ']')} ${c('35;1', '> BOOT ')} ${c('1', msg)}`); }

module.exports = { entry, close, skip, info, warn, error, boot };
