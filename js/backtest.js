/* Candela — strategy backtester.
 *
 * Takes the candles and a strategy's signals (from a Candela Script with buy / sell / sellshort / cover) and
 * simulates the trades:
 *   - signals are read when a candle closes, and orders fill at the next candle's open (no peeking ahead);
 *   - stop loss and take profit (percent from the entry) are checked inside each candle: when the candle opens
 *     beyond the level the fill is at the open, and if both are touched in one candle the stop counts
 *     (the cautious assumption, since the order inside a candle isn't known);
 *   - each trade uses a percentage of the current equity, and pays commission on entry and exit.
 * Pure functions, used by the app (and testable in Node). */
(function (root) {
  'use strict';

  const DEFAULTS = { capital: 10000, size: 100, commission: 0.1, stop: 0, target: 0 };

  function backtest(bars, sig, options = {}) {
    const o = { ...DEFAULTS };
    for (const [k, v] of Object.entries(options)) if (typeof v === 'number' && isFinite(v) && v >= 0) o[k] = v;
    const n = bars.length, fee = o.commission / 100;
    const on = (k, i) => !!(sig[k] && sig[k][i]);
    const trades = [], equity = new Array(n).fill(NaN);
    let cash = o.capital, pos = null, pending = null, commissionPaid = 0;

    const open = (dir, i, price) => {
      const eq = cash;
      const notional = (eq * Math.min(o.size, 100)) / 100;
      if (!(notional > 0) || !(price > 0)) return;
      const qty = notional / (price * (1 + fee));
      const cost = qty * price * fee;
      cash -= cost;
      commissionPaid += cost;
      pos = { dir, entryIdx: i, entryT: bars[i].t, entryPrice: price, qty, entryFee: cost, peak: price, trough: price };
      if (o.stop > 0) pos.stopPrice = dir > 0 ? price * (1 - o.stop / 100) : price * (1 + o.stop / 100);
      if (o.target > 0) pos.targetPrice = dir > 0 ? price * (1 + o.target / 100) : price * (1 - o.target / 100);
    };
    const close = (i, price, reason) => {
      const p = pos, gross = (price - p.entryPrice) * p.qty * p.dir, cost = p.qty * price * fee;
      cash += gross - cost;
      commissionPaid += cost;
      const pnl = gross - cost - p.entryFee;
      trades.push({
        dir: p.dir, entryIdx: p.entryIdx, entryT: p.entryT, entryPrice: p.entryPrice, exitIdx: i, exitT: bars[i].t, exitPrice: price,
        qty: p.qty, pnl, pnlPct: (pnl / (p.qty * p.entryPrice)) * 100, reason, bars: i - p.entryIdx,
        runup: p.dir > 0 ? (p.peak / p.entryPrice - 1) * 100 : (1 - p.trough / p.entryPrice) * 100,
        drawdown: p.dir > 0 ? (p.trough / p.entryPrice - 1) * 100 : (1 - p.peak / p.entryPrice) * 100,
      });
      pos = null;
    };

    for (let i = 0; i < n; i++) {
      const b = bars[i];
      // 1. orders from the last close fill at this open
      if (pending) {
        if (pending.exit && pos) close(i, b.o, pending.exit);
        if (pending.enter && !pos) open(pending.enter, i, b.o);
        pending = null;
      }
      // 2. stop loss / take profit inside this candle
      if (pos) {
        pos.peak = Math.max(pos.peak, b.h);
        pos.trough = Math.min(pos.trough, b.l);
        const L = pos.dir > 0;
        const stopHit = pos.stopPrice !== undefined && (L ? b.l <= pos.stopPrice : b.h >= pos.stopPrice);
        const targetHit = pos.targetPrice !== undefined && (L ? b.h >= pos.targetPrice : b.l <= pos.targetPrice);
        if (stopHit) close(i, L ? Math.min(b.o, pos.stopPrice) : Math.max(b.o, pos.stopPrice), 'Stop loss');
        else if (targetHit) close(i, L ? Math.max(b.o, pos.targetPrice) : Math.min(b.o, pos.targetPrice), 'Take profit');
      }
      // 3. equity at this close
      equity[i] = cash + (pos ? (b.c - pos.entryPrice) * pos.qty * pos.dir : 0); // (the entry commission is already paid from cash)
      // 4. signals at this close become orders for the next open
      if (i < n - 1) {
        if (pos && pos.dir > 0 && (on('$sell', i) || on('$sellshort', i))) pending = { exit: on('$sell', i) ? 'Sell signal' : 'Reversed', enter: on('$sellshort', i) ? -1 : 0 };
        else if (pos && pos.dir < 0 && (on('$cover', i) || on('$buy', i))) pending = { exit: on('$cover', i) ? 'Cover signal' : 'Reversed', enter: on('$buy', i) ? 1 : 0 };
        else if (!pos && on('$buy', i) && !on('$sellshort', i)) pending = { enter: 1 };
        else if (!pos && on('$sellshort', i) && !on('$buy', i)) pending = { enter: -1 };
      }
    }
    // a position still open at the end is listed as open, valued at the last close
    let openTrade = null;
    if (pos && n) {
      const last = bars[n - 1], gross = (last.c - pos.entryPrice) * pos.qty * pos.dir;
      openTrade = { dir: pos.dir, entryIdx: pos.entryIdx, entryT: pos.entryT, entryPrice: pos.entryPrice, exitIdx: n - 1, exitT: last.t, exitPrice: last.c, qty: pos.qty, pnl: gross - pos.entryFee, pnlPct: ((gross - pos.entryFee) / (pos.qty * pos.entryPrice)) * 100, reason: 'Open', bars: n - 1 - pos.entryIdx, open: true };
    }
    return { trades, openTrade, equity, stats: stats(bars, trades, equity, o, commissionPaid, openTrade), options: o };
  }

  function stats(bars, trades, equity, o, commissionPaid, openTrade) {
    const wins = trades.filter((t) => t.pnl > 0), losses = trades.filter((t) => t.pnl <= 0);
    const grossProfit = wins.reduce((a, t) => a + t.pnl, 0), grossLoss = -losses.reduce((a, t) => a + t.pnl, 0);
    const net = trades.reduce((a, t) => a + t.pnl, 0);
    // largest peak-to-trough fall of the equity curve
    let peak = -Infinity, maxDD = 0, maxDDPct = 0;
    for (const e of equity) {
      if (!isFinite(e)) continue;
      if (e > peak) peak = e;
      if (peak - e > maxDD) { maxDD = peak - e; maxDDPct = ((peak - e) / peak) * 100; }
    }
    const first = bars.find((b) => b), last = bars[bars.length - 1];
    return {
      netProfit: net, netProfitPct: (net / o.capital) * 100, grossProfit, grossLoss,
      profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
      trades: trades.length, wins: wins.length, losses: losses.length, winRate: trades.length ? (wins.length / trades.length) * 100 : 0,
      avgTrade: trades.length ? net / trades.length : 0, avgWin: wins.length ? grossProfit / wins.length : 0, avgLoss: losses.length ? -grossLoss / losses.length : 0,
      largestWin: wins.length ? Math.max(...wins.map((t) => t.pnl)) : 0, largestLoss: losses.length ? Math.min(...losses.map((t) => t.pnl)) : 0,
      avgBars: trades.length ? trades.reduce((a, t) => a + t.bars, 0) / trades.length : 0,
      maxDrawdown: maxDD, maxDrawdownPct: maxDDPct, commission: commissionPaid,
      buyHoldPct: first && last ? (last.c / first.o - 1) * 100 : 0,
      openPnl: openTrade ? openTrade.pnl : 0,
      finalEquity: equity.length ? equity[equity.length - 1] : o.capital,
    };
  }

  root.CandelaBacktest = { backtest, DEFAULTS };
})(typeof window !== 'undefined' ? window : globalThis);
