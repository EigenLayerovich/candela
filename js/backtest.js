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

  const DEFAULTS = { capital: 10000, size: 100, commission: 0.1, stop: 0, target: 0, slippage: 0 };

  function backtest(bars, sig, options = {}) {
    const o = { ...DEFAULTS };
    for (const [k, v] of Object.entries(options)) if (typeof v === 'number' && isFinite(v) && v >= 0) o[k] = v;
    const n = bars.length, fee = o.commission / 100, slip = o.slippage / 100;
    // slippage: every fill is a little worse than the price (buying higher, selling lower)
    const fillAt = (price, buying) => price * (buying ? 1 + slip : 1 - slip);
    const on = (k, i) => !!(sig[k] && sig[k][i]);
    const trades = [], equity = new Array(n).fill(NaN);
    let cash = o.capital, pos = null, pending = null, commissionPaid = 0;

    const open = (dir, i, price) => {
      price = fillAt(price, dir > 0);
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
      price = fillAt(price, pos.dir < 0);
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

  // ---- breakdowns of the closed trades
  function summarize(list) {
    const wins = list.filter((t) => t.pnl > 0), gp = wins.reduce((a, t) => a + t.pnl, 0), gl = -list.filter((t) => t.pnl <= 0).reduce((a, t) => a + t.pnl, 0);
    const net = gp - gl;
    return {
      trades: list.length, wins: wins.length, losses: list.length - wins.length, net, grossProfit: gp, grossLoss: gl,
      winRate: list.length ? (wins.length / list.length) * 100 : 0, profitFactor: gl > 0 ? gp / gl : gp > 0 ? Infinity : 0,
      avgTrade: list.length ? net / list.length : 0, avgWin: wins.length ? gp / wins.length : 0, avgLoss: list.length - wins.length ? -gl / (list.length - wins.length) : 0,
      largestWin: wins.length ? Math.max(...wins.map((t) => t.pnl)) : 0, largestLoss: list.length - wins.length ? Math.min(...list.filter((t) => t.pnl <= 0).map((t) => t.pnl)) : 0,
      avgBars: list.length ? list.reduce((a, t) => a + t.bars, 0) / list.length : 0,
    };
  }
  const bySide = (trades) => ({ all: summarize(trades), long: summarize(trades.filter((t) => t.dir > 0)), short: summarize(trades.filter((t) => t.dir < 0)) });
  // P&L of trades grouped by the day they closed, and by weekday. offsetOf(t) = time zone offset in ms.
  function periods(trades, offsetOf = () => 0) {
    const days = new Map(), wk = Array.from({ length: 7 }, (_, i) => ({ day: i, trades: 0, wins: 0, net: 0 }));
    for (const t of trades) {
      const local = t.exitT + offsetOf(t.exitT), key = Math.floor(local / 86400e3), wd = new Date(local).getUTCDay();
      const d = days.get(key) || { day: key * 86400e3, trades: 0, wins: 0, net: 0 };
      d.trades++; d.net += t.pnl; if (t.pnl > 0) d.wins++;
      days.set(key, d);
      wk[wd].trades++; wk[wd].net += t.pnl; if (t.pnl > 0) wk[wd].wins++;
    }
    return { daily: [...days.values()].sort((a, b) => a.day - b.day), weekdays: [1, 2, 3, 4, 5, 6, 0].map((i) => wk[i]) };
  }
  // Monte Carlo: new histories of the same length, made by drawing the backtest's closed trades at random
  // (with replacement, so some repeat and some are left out). Each trade keeps its result as a return on the
  // equity it started with. The spread shows how much of the result could be luck.
  function monteCarlo(trades, capital, runs = 1000, seed = 7) {
    if (trades.length < 2) return null;
    let eq = capital;
    const rets = trades.map((t) => { const r = t.pnl / eq; eq += t.pnl; return r; });
    let s = seed >>> 0;
    const rnd = () => { s = (s + 0x6d2b79f5) >>> 0; let x = Math.imul(s ^ (s >>> 15), 1 | s); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
    const finals = [], dds = [], n = rets.length;
    for (let k = 0; k < runs; k++) {
      let e = capital, peak = capital, dd = 0;
      for (let i = 0; i < n; i++) {
        e *= 1 + rets[Math.floor(rnd() * n)];
        if (e > peak) peak = e;
        dd = Math.max(dd, (peak - e) / peak);
      }
      finals.push((e / capital - 1) * 100);
      dds.push(dd * 100);
    }
    const q = (arr, p) => { const a = arr.slice().sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.max(0, Math.round((p / 100) * (a.length - 1))))]; };
    const pct = (arr) => ({ p5: q(arr, 5), p25: q(arr, 25), p50: q(arr, 50), p75: q(arr, 75), p95: q(arr, 95) });
    return { runs, returns: pct(finals), drawdowns: pct(dds), lossChance: (finals.filter((v) => v < 0).length / runs) * 100, finals, dds };
  }

  root.CandelaBacktest = { backtest, DEFAULTS, bySide, periods, monteCarlo, summarize };
})(typeof window !== 'undefined' ? window : globalThis);
