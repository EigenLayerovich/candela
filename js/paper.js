/* Candela — paper trading: a practice account with virtual money.
 *
 * One position per symbol (buying while short reduces the short, as on most trading platforms). Orders:
 * market (fills at once at the last price), limit (buy at or below / sell at or above a price) and stop
 * (buy at or above / sell at or below). A position can carry a take profit and a stop loss. Commission is a
 * percentage of each fill. P&L is settled in cash when a position is reduced or closed; equity also counts
 * open positions at the latest price. Pure functions on a plain account object (saved by the app). */
(function (root) {
  'use strict';
  const uid = () => Math.random().toString(36).slice(2, 10);
  const round = (v) => Math.round(v * 1e8) / 1e8;

  function newAccount(name = 'Paper account', balance = 100000) {
    return { id: uid(), name, start: balance, cash: balance, commission: 0.05, positions: {}, orders: [], history: [], notes: [], created: Date.now() };
  }

  // fill a signed quantity (+ buy, − sell) at price; returns the fill record
  function fill(acc, sym, qty, price, t, reason, extra = {}) {
    const pos = acc.positions[sym] || { qty: 0, avg: 0, opened: t };
    const fee = (Math.abs(qty) * price * (acc.commission || 0)) / 100;
    acc.cash -= fee;
    let realized = 0, left = qty;
    if (pos.qty && Math.sign(pos.qty) !== Math.sign(qty)) {
      // reduce (or close) the position first
      const closing = Math.min(Math.abs(qty), Math.abs(pos.qty));
      realized = (price - pos.avg) * closing * Math.sign(pos.qty);
      pos.qty = round(pos.qty + closing * Math.sign(qty));
      left = round(qty - closing * Math.sign(qty));
      acc.cash += realized;
    }
    if (left) {
      // open or add (a reversal opens the rest the other way at this price)
      const q = pos.qty + left;
      pos.avg = pos.qty ? (pos.avg * Math.abs(pos.qty) + price * Math.abs(left)) / Math.abs(q) : price;
      if (!pos.qty) { pos.opened = t; delete pos.sl; delete pos.tp; }
      pos.qty = round(q);
    }
    if (pos.qty) acc.positions[sym] = pos; else delete acc.positions[sym];
    const rec = { id: uid(), t, sym, side: qty > 0 ? 'buy' : 'sell', qty: Math.abs(qty), price, fee, realized, reason, note: '', ...extra };
    acc.history.push(rec);
    if (acc.history.length > 2000) acc.history.shift();
    return rec;
  }

  // an order's brackets apply to the position it opens or adds to
  function applyBrackets(acc, sym, o) {
    const pos = acc.positions[sym];
    if (!pos) return;
    if (o.sl > 0) pos.sl = o.sl;
    if (o.tp > 0) pos.tp = o.tp;
  }

  // o: { sym, side: 'buy' | 'sell', type: 'market' | 'limit' | 'stop', qty, price?, sl?, tp? }
  function placeOrder(acc, o, last, t = Date.now()) {
    if (!(o.qty > 0)) throw new Error('Enter a quantity');
    if (o.type !== 'market' && !(o.price > 0)) throw new Error('Enter a price');
    const q = o.side === 'buy' ? o.qty : -o.qty;
    if (o.type === 'market') {
      if (!(last > 0)) throw new Error('No price yet for this symbol');
      const rec = fill(acc, o.sym, q, last, t, 'Market order');
      applyBrackets(acc, o.sym, o);
      return { filled: rec };
    }
    const order = { id: uid(), sym: o.sym, side: o.side, type: o.type, qty: o.qty, price: o.price, sl: o.sl || null, tp: o.tp || null, created: t };
    acc.orders.push(order);
    return { order };
  }
  function cancelOrder(acc, id) { acc.orders = acc.orders.filter((o) => o.id !== id); }
  function closePosition(acc, sym, price, t = Date.now(), reason = 'Closed') {
    const pos = acc.positions[sym];
    if (!pos || !(price > 0)) return null;
    return fill(acc, sym, -pos.qty, price, t, reason);
  }

  // A new price (live updates). Returns the fills it caused.
  function onPrice(acc, sym, price, t = Date.now()) {
    const fills = [];
    for (const o of acc.orders.filter((x) => x.sym === sym)) {
      const hit = o.type === 'limit' ? (o.side === 'buy' ? price <= o.price : price >= o.price) : (o.side === 'buy' ? price >= o.price : price <= o.price);
      if (!hit) continue;
      acc.orders = acc.orders.filter((x) => x !== o);
      fills.push(fill(acc, sym, o.side === 'buy' ? o.qty : -o.qty, price, t, o.type === 'limit' ? 'Limit order' : 'Stop order', { orderId: o.id }));
      applyBrackets(acc, sym, o);
    }
    const pos = acc.positions[sym];
    if (pos) {
      const long = pos.qty > 0;
      if (pos.sl > 0 && (long ? price <= pos.sl : price >= pos.sl)) fills.push(closePosition(acc, sym, price, t, 'Stop loss'));
      else if (pos.tp > 0 && (long ? price >= pos.tp : price <= pos.tp)) fills.push(closePosition(acc, sym, price, t, 'Take profit'));
    }
    return fills;
  }

  // A whole candle (Bar Replay): orders fill at their price, or at the open if it gapped past it; then
  // stop loss / take profit inside the candle (the stop counts first if both are touched).
  function onBar(acc, sym, bar) {
    const fills = [];
    for (const o of acc.orders.filter((x) => x.sym === sym)) {
      let px = null;
      if (o.type === 'limit') px = o.side === 'buy' ? (bar.l <= o.price ? Math.min(o.price, bar.o) : null) : (bar.h >= o.price ? Math.max(o.price, bar.o) : null);
      else px = o.side === 'buy' ? (bar.h >= o.price ? Math.max(o.price, bar.o) : null) : (bar.l <= o.price ? Math.min(o.price, bar.o) : null);
      if (px == null) continue;
      acc.orders = acc.orders.filter((x) => x !== o);
      fills.push(fill(acc, sym, o.side === 'buy' ? o.qty : -o.qty, px, bar.t, o.type === 'limit' ? 'Limit order' : 'Stop order', { orderId: o.id }));
      applyBrackets(acc, sym, o);
    }
    const pos = acc.positions[sym];
    if (pos) {
      const long = pos.qty > 0;
      const slHit = pos.sl > 0 && (long ? bar.l <= pos.sl : bar.h >= pos.sl), tpHit = pos.tp > 0 && (long ? bar.h >= pos.tp : bar.l <= pos.tp);
      if (slHit) fills.push(closePosition(acc, sym, long ? Math.min(bar.o, pos.sl) : Math.max(bar.o, pos.sl), bar.t, 'Stop loss'));
      else if (tpHit) fills.push(closePosition(acc, sym, long ? Math.max(bar.o, pos.tp) : Math.min(bar.o, pos.tp), bar.t, 'Take profit'));
    }
    return fills;
  }

  const unrealized = (pos, price) => (price > 0 ? (price - pos.avg) * pos.qty : 0);
  // prices: { sym: last price }
  function equity(acc, prices) {
    let u = 0;
    for (const [sym, pos] of Object.entries(acc.positions)) u += unrealized(pos, prices[sym] ?? pos.avg);
    return { equity: acc.cash + u, unrealized: u, realized: acc.cash - acc.start + acc.history.reduce((a, h) => a + h.fee, 0), fees: acc.history.reduce((a, h) => a + h.fee, 0) };
  }
  // closed trades: fills that reduced a position (for win rate and the replay results)
  function summary(acc) {
    const closes = acc.history.filter((h) => h.realized !== 0 || /Stop loss|Take profit|Closed/.test(h.reason));
    const wins = closes.filter((h) => h.realized > 0).length;
    return { trades: closes.length, wins, winRate: closes.length ? (100 * wins) / closes.length : 0, net: acc.cash - acc.start };
  }

  root.CandelaPaper = { newAccount, placeOrder, cancelOrder, closePosition, onPrice, onBar, equity, unrealized, summary, fill };
})(typeof window !== 'undefined' ? window : globalThis);
