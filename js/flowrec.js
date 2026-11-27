/* Candela — trades and order books recorded for the chart:
 *  - footprint candles: buy and sell volume at each price of each candle, from the live trades, plus
 *    Binance's recent trade history (other exchanges only publish their latest trades, so their
 *    footprint fills in from when the chart is opened);
 *  - the liquidity heatmap: snapshots of the order book every 2 seconds while the chart is open.
 * Data is kept for a while after a chart closes, so switching back shows it again. */
(function (root) {
  'use strict';
  const MD = root.MarketData;
  const nice = (v) => { const p = Math.pow(10, Math.floor(Math.log10(v))), m = v / p; return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p; };
  const KEEP_CANDLES = 600, KEEP_MS = 30 * 60e3;

  // ---- footprint
  const fpStore = new Map(); // "sym|tf" -> { data: { fine, bars: Map }, users, stop, timer, listeners: Set, note }
  function footprint(sym, tf, lastPrice, onUpdate) {
    const src = MD.flowFor(sym);
    if (!src) return null;
    const key = sym + '|' + tf;
    let st = fpStore.get(key);
    if (!st) {
      st = { data: { fine: nice(Math.max(1e-12, lastPrice * 0.00002)), bars: new Map(), note: '' }, users: 0, stop: null, timer: null, listeners: new Set(), dirty: null };
      fpStore.set(key, st);
    }
    clearTimeout(st.timer);
    st.users++;
    st.listeners.add(onUpdate);
    const D = st.data;
    const notify = () => {
      if (st.dirty) return;
      st.dirty = setTimeout(() => { st.dirty = null; for (const f of st.listeners) f(D); }, 250);
    };
    const add = (list) => {
      for (const x of list) {
        if (!(x.sz > 0) || !(x.px > 0)) continue;
        const t = MD.bucketOf(x.t, tf);
        let m = D.bars.get(t);
        if (!m) { D.bars.set(t, (m = new Map())); if (D.bars.size > KEEP_CANDLES) D.bars.delete(Math.min(...D.bars.keys())); }
        const k = Math.round(x.px / D.fine);
        let c = m.get(k);
        if (!c) m.set(k, (c = [0, 0]));
        c[x.buy ? 0 : 1] += x.sz;
      }
      notify();
    };
    if (!st.stop) {
      let stopped = false, stopLive = null, stopHist = null, histMax = -Infinity;
      const live = () => {
        if (stopped) return;
        stopLive = src.trades((list) => add(histMax > -Infinity ? list.filter((x) => !(x.id <= histMax)) : list));
      };
      if (src.tradeHistory) {
        // the recent past from Binance: about 30,000–60,000 trades, newest first
        const since = Date.now() - 300 * MD.TF[tf];
        let first = true;
        D.note = 'Loading recent trades…';
        stopHist = src.tradeHistory(since, MD.TF[tf] <= 60e3 ? 30 : 50, (chunk) => {
          if (first) { first = false; histMax = chunk.length ? chunk[chunk.length - 1].id : -Infinity; live(); }
          add(chunk.filter((x) => x.t >= since));
        }, (err) => {
          if (first) live(); // no history here (blocked): live only
          const oldest = D.bars.size ? Math.min(...D.bars.keys()) : null;
          D.note = err && !D.bars.size ? 'Trade history unavailable here: footprints fill in from now on.' : oldest ? `Footprints from ${new Date(oldest).toLocaleString(undefined, { hour12: false, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} on` : '';
          notify();
        });
      } else {
        D.note = 'Footprints fill in from now on (this exchange only publishes its latest trades).';
        live();
      }
      st.stop = () => { stopped = true; if (stopLive) stopLive(); if (stopHist) stopHist(); };
    }
    setTimeout(() => onUpdate(D), 0);
    return () => {
      st.listeners.delete(onUpdate);
      if (--st.users > 0) return;
      // keep the data a while: switching back shows it, and recording resumes
      st.timer = setTimeout(() => { if (st.users <= 0) { if (st.stop) st.stop(); fpStore.delete(key); } }, KEEP_MS);
    };
  }

  // ---- order book snapshots
  const bookStore = new Map(); // sym -> { R: { snaps, version, source }, users, stop, timer, listeners }
  const MAX_SNAPS = 5400, EVERY = 2000; // 3 hours
  function bookHeat(sym, onUpdate) {
    const src = MD.flowFor(sym);
    if (!src) return null;
    let st = bookStore.get(sym);
    if (!st) { st = { R: { snaps: [], version: 0, source: src.ex }, users: 0, stop: null, timer: null, listeners: new Set() }; bookStore.set(sym, st); }
    clearTimeout(st.timer);
    st.users++;
    st.listeners.add(onUpdate);
    const R = st.R;
    if (!st.stop) {
      // the latest book, sampled every 2 seconds (an unchanged book still means the same orders waiting)
      let latest = null, at = 0;
      // Hyperliquid sends 20 levels a side: group them more so they reach further from the price
      const opts = src.ex === 'HYPERLIQUID' ? { sigFigs: 4, levels: 20 } : { sigFigs: 5, levels: 150 };
      const stopBook = src.book(opts, (bk) => { latest = bk; at = Date.now(); }, () => {});
      const pack = (lv) => { const a = new Float32Array(lv.length * 2); lv.forEach(([p, s], i) => { a[2 * i] = p; a[2 * i + 1] = s; }); return a; };
      const timer = setInterval(() => {
        if (!latest || Date.now() - at > 60e3) return; // nothing new for a minute: the feed is down
        R.snaps.push({ t: Date.now(), bids: pack(latest.bids), asks: pack(latest.asks) });
        if (R.snaps.length > MAX_SNAPS) R.snaps.splice(0, R.snaps.length - MAX_SNAPS);
        R.version++;
        for (const f of st.listeners) f(R);
      }, EVERY);
      st.stop = () => { clearInterval(timer); stopBook(); };
    }
    setTimeout(() => onUpdate(R), 0);
    return () => {
      st.listeners.delete(onUpdate);
      if (--st.users > 0) return;
      st.timer = setTimeout(() => { if (st.users <= 0) { if (st.stop) st.stop(); st.stop = null; bookStore.delete(sym); } }, KEEP_MS);
    };
  }

  root.CandelaFlowRec = { footprint, bookHeat };
})(typeof window !== 'undefined' ? window : globalThis);
