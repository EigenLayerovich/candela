/* Candela — screener: every perpetual on one exchange with price, volume, open interest and funding
 * metrics, filters (presets) and a market matrix. Prices, 24h volume, funding and open interest come
 * in one request per exchange; the hourly numbers (1h change, relative volume, RSI, open interest
 * change) from each market's 15-minute candles and hourly open interest, for the busiest markets.
 * Hyperliquid publishes no open-interest history: Candela keeps its own samples (every 5 minutes
 * while the screener is open), so its OI change appears after an hour. */
(function (root) {
  'use strict';
  const MD = root.MarketData;
  const get = (url, name, cors) => MD.getJSON(url, name, cors);
  const H = 3600e3;
  const STABLE = /^(USDC|FDUSD|TUSD|USDP|DAI|BUSD|USDE|PYUSD|USDS|USD1|RLUSD|EUR|AEUR)$/;

  const BN = 'https://fapi.binance.com', BY = 'https://api.bybit.com/v5/market', OK = 'https://www.okx.com/api/v5';
  const okData = (j) => { if (j.code !== '0') throw new Error(`OKX: ${j.msg || j.code}`); return j.data; };
  const byList = (j) => { if (j.retCode !== 0) throw new Error(`Bybit: ${j.retMsg}`); return j.result.list || []; };

  // each venue: bulk() -> [{ id, coin, name, last, chg24, turnover, hi24, lo24, funding, fundHours, oi }]
  // and detail(row) -> { k: 15-minute candles [{ t, o, h, l, c, qv, tbq? }], oi: [{ t, v }] hourly, or null }
  const VENUES = {
    BINANCEF: {
      name: 'Binance Futures', buyData: true,
      async bulk() {
        const [t, f] = await Promise.all([get(`${BN}/fapi/v1/ticker/24hr`, 'Binance Futures'), get(`${BN}/fapi/v1/premiumIndex`, 'Binance Futures').catch(() => [])]);
        const fund = new Map(f.map((r) => [r.symbol, +r.lastFundingRate]));
        return t.filter((r) => /^[A-Z0-9]+USDT$/.test(r.symbol) && +r.lastPrice > 0 && fund.has(r.symbol)).map((r) => {
          const base = r.symbol.replace(/USDT$/, '');
          return { id: `BINANCEF:${base}/USDT`, coin: base.replace(/^1000+(?=[A-Z])/, ''), name: r.symbol, last: +r.lastPrice, chg24: +r.priceChangePercent, turnover: +r.quoteVolume, hi24: +r.highPrice, lo24: +r.lowPrice, funding: fund.get(r.symbol), fundHours: 8, oi: null };
        });
      },
      async detail(r) {
        const [k, oi] = await Promise.all([
          get(`${BN}/fapi/v1/klines?symbol=${r.name}&interval=15m&limit=100`, 'Binance Futures'),
          get(`${BN}/futures/data/openInterestHist?symbol=${r.name}&period=1h&limit=25`, 'Binance Futures').catch(() => null),
        ]);
        return {
          k: k.map((x) => ({ t: +x[0], o: +x[1], h: +x[2], l: +x[3], c: +x[4], qv: +x[7], tbq: +x[10] })),
          oi: oi ? oi.map((x) => ({ t: +x.timestamp, v: +x.sumOpenInterestValue })) : null,
        };
      },
    },
    BYBITF: {
      name: 'Bybit',
      async bulk() {
        return byList(await get(`${BY}/tickers?category=linear`, 'Bybit')).filter((r) => /^[A-Z0-9]+USDT$/.test(r.symbol) && +r.lastPrice > 0 && r.fundingRate !== '').map((r) => {
          const base = r.symbol.replace(/USDT$/, '');
          return { id: `BYBITF:${base}/USDT`, coin: base.replace(/^1000+(?=[A-Z])/, ''), name: r.symbol, last: +r.lastPrice, chg24: +r.price24hPcnt * 100, turnover: +r.turnover24h, hi24: +r.highPrice24h, lo24: +r.lowPrice24h, funding: +r.fundingRate, fundHours: +r.fundingIntervalHour || 8, oi: +r.openInterestValue || null };
        });
      },
      async detail(r) {
        const [k, oi] = await Promise.all([
          get(`${BY}/kline?category=linear&symbol=${r.name}&interval=15&limit=100`, 'Bybit'),
          get(`${BY}/open-interest?category=linear&symbol=${r.name}&intervalTime=1h&limit=25`, 'Bybit').catch(() => null),
        ]);
        return {
          k: byList(k).map((x) => ({ t: +x[0], o: +x[1], h: +x[2], l: +x[3], c: +x[4], qv: +x[6] })).reverse(),
          oi: oi ? byList(oi).map((x) => ({ t: +x.timestamp, v: +x.openInterest })).reverse() : null, // in coins: the % change is what counts
        };
      },
    },
    OKXF: {
      name: 'OKX',
      async bulk() {
        const [t, oi, f] = await Promise.all([
          get(`${OK}/market/tickers?instType=SWAP`, 'OKX'), get(`${OK}/public/open-interest?instType=SWAP`, 'OKX').catch(() => null), get(`${OK}/public/funding-rate?instId=ANY`, 'OKX').catch(() => null),
        ]);
        const ois = new Map(oi ? okData(oi).map((r) => [r.instId, +r.oiUsd]) : []), fund = new Map(f ? okData(f).map((r) => [r.instId, +r.fundingRate]) : []);
        return okData(t).filter((r) => /^[A-Z0-9]+-USDT-SWAP$/.test(r.instId) && +r.last > 0).map((r) => {
          const base = r.instId.split('-')[0], last = +r.last;
          return { id: `OKXF:${base}/USDT`, coin: base, name: r.instId, last, chg24: (last / +r.open24h - 1) * 100, turnover: +r.volCcy24h * last, hi24: +r.high24h, lo24: +r.low24h, funding: fund.has(r.instId) ? fund.get(r.instId) : null, fundHours: 8, oi: ois.get(r.instId) || null };
        });
      },
      async detail(r) {
        const [k, oi] = await Promise.all([
          get(`${OK}/market/candles?instId=${r.name}&bar=15m&limit=100`, 'OKX'),
          get(`${OK}/rubik/stat/contracts/open-interest-history?instId=${r.name}&period=1H&limit=25`, 'OKX').catch(() => null),
        ]);
        return {
          k: okData(k).map((x) => ({ t: +x[0], o: +x[1], h: +x[2], l: +x[3], c: +x[4], qv: +x[7] })).reverse(),
          oi: oi ? okData(oi).map((x) => ({ t: +x[0], v: +x[3] })).reverse() : null,
        };
      },
    },
    HYPERLIQUID: {
      name: 'Hyperliquid', ownOi: true,
      async bulk() {
        const [meta, ctx] = await MD.hlInfo({ type: 'metaAndAssetCtxs' });
        let ids = {};
        try { await MD.exPairs('HYPERLIQUID'); const coins = MD.EXCHANGES.HYPERLIQUID.coins || {}; for (const [k, v] of Object.entries(coins)) ids[v] = 'HYPERLIQUID:' + k; } catch (e) { ids = {}; }
        const out = [];
        meta.universe.forEach((u, i) => {
          const c = ctx[i], last = +c.markPx, prev = +c.prevDayPx;
          if (u.isDelisted || !(last > 0)) return;
          out.push({ id: ids[u.name] || `HYPERLIQUID:${u.name.replace(/^k(?=[A-Z])/, 'K')}/USDC`, coin: u.name.replace(/^k(?=[A-Z])/, ''), name: u.name, last, chg24: prev > 0 ? (last / prev - 1) * 100 : null, turnover: +c.dayNtlVlm, hi24: null, lo24: null, funding: +c.funding, fundHours: 1, oi: +c.openInterest * last });
        });
        return out;
      },
      async detail(r) {
        const k = await MD.hlInfo({ type: 'candleSnapshot', req: { coin: r.name, interval: '15m', startTime: Date.now() - 25 * H } });
        return { k: (k || []).map((x) => ({ t: x.t, o: +x.o, h: +x.h, l: +x.l, c: +x.c, qv: +x.v * ((+x.h + +x.l + +x.c) / 3) })), oi: null };
      },
    },
  };

  // Hyperliquid open interest samples, kept across sessions: { coin: [[t, oi]…] }
  const OI_KEY = 'candela.hlOiSamples';
  function hlSamples(rows) {
    let S = {};
    try { S = JSON.parse(localStorage.getItem(OI_KEY) || '{}'); } catch (e) { S = {}; }
    const now = Date.now();
    for (const r of rows) {
      const l = (S[r.coin] = (S[r.coin] || []).filter((x) => now - x[0] < 26 * H));
      if (!l.length || now - l[l.length - 1][0] >= 5 * 60e3) l.push([now, r.oi]);
    }
    for (const c of Object.keys(S)) if (!rows.some((r) => r.coin === c)) delete S[c];
    try { localStorage.setItem(OI_KEY, JSON.stringify(S)); } catch (e) { /* full: no samples */ }
    return S;
  }
  // the value nearest to `ago` before now, if there is one within a quarter of that
  function valueAgo(series, ago, now = Date.now()) {
    let best = null;
    for (const x of series) if (!best || Math.abs(now - ago - x.t) < Math.abs(now - ago - best.t)) best = x;
    return best && Math.abs(now - ago - best.t) <= Math.max(20 * 60e3, ago * 0.25) ? best.v : null;
  }

  function rsi(closes, n = 14) {
    if (closes.length <= n) return null;
    let g = 0, l = 0;
    for (let i = 1; i <= n; i++) { const d = closes[i] - closes[i - 1]; if (d > 0) g += d; else l -= d; }
    g /= n; l /= n;
    for (let i = n + 1; i < closes.length; i++) { const d = closes[i] - closes[i - 1]; g = (g * (n - 1) + Math.max(0, d)) / n; l = (l * (n - 1) + Math.max(0, -d)) / n; }
    return l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }

  // the hourly numbers from a market's details
  function enrich(r, d, venue, samples) {
    const k = d.k || [], n = k.length;
    if (n >= 6) {
      const last = r.last;
      r.chg1h = (last / k[n - 5].c - 1) * 100;
      if (n >= 17) r.chg4h = (last / k[n - 17].c - 1) * 100;
      // the last full hour (the four completed 15-minute candles) against the average hour before it
      const hr = k.slice(-5, -1), hourVol = hr.reduce((a, x) => a + x.qv, 0), prev = k.slice(0, -5), hours = prev.length / 4;
      r.relvol = hours >= 4 ? hourVol / (prev.reduce((a, x) => a + x.qv, 0) / hours) : null;
      if (venue.buyData) { const tb = hr.reduce((a, x) => a + (x.tbq || 0), 0); r.buy1h = hourVol > 0 ? (tb / hourVol) * 100 : null; }
      // hourly closes for RSI: every 4th 15-minute candle, ending at the newest
      const hc = [];
      for (let i = n - 1; i >= 0; i -= 4) hc.unshift(k[i].c);
      r.rsi = rsi(hc);
      if (!(r.hi24 > 0)) { const day = k.slice(-96); r.hi24 = Math.max(...day.map((x) => x.h)); r.lo24 = Math.min(...day.map((x) => x.l)); }
    }
    let oiSeries = d.oi;
    if (venue.ownOi && samples && samples[r.coin]) oiSeries = samples[r.coin].map(([t, v]) => ({ t, v }));
    if (oiSeries && oiSeries.length > 1) {
      const ref = venue.ownOi ? Date.now() : oiSeries[oiSeries.length - 1].t, cur = oiSeries[oiSeries.length - 1].v;
      const a1 = valueAgo(oiSeries, H, ref), a24 = valueAgo(oiSeries, 24 * H, ref);
      r.oi1h = a1 > 0 ? (cur / a1 - 1) * 100 : null;
      r.oi24h = a24 > 0 ? (cur / a24 - 1) * 100 : null;
      if (!r.oi && venue === VENUES.BINANCEF) r.oi = cur; // (Binance's price list has no open interest)
    }
    signalOf(r);
    r.detailAt = Date.now();
    return r;
  }
  function common(r) {
    r.range24 = r.hi24 > 0 && r.lo24 > 0 ? (r.hi24 / r.lo24 - 1) * 100 : null;
    r.fromHigh = r.hi24 > 0 ? (r.last / r.hi24 - 1) * 100 : null;
    r.fromLow = r.lo24 > 0 ? (r.last / r.lo24 - 1) * 100 : null;
    r.fund8 = r.funding != null && isFinite(r.funding) ? (r.funding * 100 * 8) / (r.fundHours || 8) : null; // % per 8 hours
  }
  // what open interest and price did together over the hour
  function signalOf(r) {
    r.signal = null;
    if (r.chg1h == null || r.oi1h == null) return;
    const p = r.chg1h, o = r.oi1h, T = 0.15;
    if (Math.abs(o) < T || Math.abs(p) < T) return;
    r.signal = p > 0 ? (o > 0 ? 'Longs opening' : 'Shorts covering') : o > 0 ? 'Shorts opening' : 'Longs closing';
  }

  // the busiest `top` markets with every metric; onProgress(rows) as details arrive
  async function scan(venueId, { top = 100, onProgress, isStopped = () => false } = {}) {
    const V = VENUES[venueId];
    let rows = (await V.bulk()).filter((r) => !STABLE.test(r.coin) && r.turnover > 0).sort((a, b) => b.turnover - a.turnover);
    const samples = V.ownOi ? hlSamples(rows) : null;
    rows.forEach(common);
    const busy = rows.slice(0, top);
    if (onProgress) onProgress(rows, 0, busy.length);
    let next = 0, done = 0;
    await Promise.all(Array.from({ length: venueId === 'HYPERLIQUID' ? 3 : 6 }, async () => {
      while (next < busy.length && !isStopped()) {
        const r = busy[next++];
        try { enrich(r, await V.detail(r), V, samples); common(r); } catch (e) { r.detailError = e.message; }
        done++;
        if (onProgress && (done % 6 === 0 || done === busy.length)) onProgress(rows, done, busy.length);
      }
    }));
    return rows;
  }

  // ---- presets: [name, test, sort column, descending]
  const PRESETS = [
    ['All markets', null, 'turnover', true],
    ['Top gainers (1h)', (r) => r.chg1h > 0, 'chg1h', true],
    ['Top losers (1h)', (r) => r.chg1h < 0, 'chg1h', false],
    ['Top gainers (24h)', (r) => r.chg24 > 0, 'chg24', true],
    ['Top losers (24h)', (r) => r.chg24 < 0, 'chg24', false],
    ['Volume spikes', (r) => r.relvol >= 2, 'relvol', true],
    ['OI surges', (r) => r.oi1h >= 2, 'oi1h', true],
    ['OI drops', (r) => r.oi1h <= -2, 'oi1h', false],
    ['Negative funding', (r) => r.fund8 < 0, 'fund8', false],
    ['High funding', (r) => r.fund8 >= 0.03, 'fund8', true],
    ['Longs opening', (r) => r.signal === 'Longs opening', 'oi1h', true],
    ['Shorts opening', (r) => r.signal === 'Shorts opening', 'oi1h', true],
    ['Shorts covering', (r) => r.signal === 'Shorts covering', 'chg1h', true],
    ['Longs closing', (r) => r.signal === 'Longs closing', 'chg1h', false],
    ['Stacked buying', (r) => r.buy1h >= 58 && r.relvol >= 1.3, 'buy1h', true],
    ['Stacked selling', (r) => r.buy1h <= 42 && r.relvol >= 1.3, 'buy1h', false],
    ['Overbought (RSI 1h ≥ 70)', (r) => r.rsi >= 70, 'rsi', true],
    ['Oversold (RSI 1h ≤ 30)', (r) => r.rsi <= 30, 'rsi', false],
    ['Near 24h high', (r) => r.fromHigh >= -1, 'fromHigh', true],
    ['Near 24h low', (r) => r.fromLow <= 1, 'fromLow', false],
    ['Most volatile (24h)', (r) => r.range24 != null, 'range24', true],
    ['Largest open interest', (r) => r.oi > 0, 'oi', true],
  ];

  // ---- squarified treemap: items [{ w }] into a w×h box -> [{ x, y, w, h, item }]
  function treemap(items, W, Hh) {
    const total = items.reduce((a, x) => a + x.w, 0), out = [];
    if (!total) return out;
    const scale = (W * Hh) / total, list = items.map((it) => ({ it, a: it.w * scale })).sort((a, b) => b.a - a.a);
    let x = 0, y = 0, w = W, h = Hh, row = [];
    const worst = (r, side) => { const s = r.reduce((a, q) => a + q.a, 0), mx = Math.max(...r.map((q) => q.a)), mn = Math.min(...r.map((q) => q.a)); return Math.max((side * side * mx) / (s * s), (s * s) / (side * side * mn)); };
    const lay = (r) => {
      const s = r.reduce((a, q) => a + q.a, 0);
      if (w >= h) { const cw = s / h; let yy = y; for (const q of r) { const qh = q.a / cw; out.push({ x, y: yy, w: cw, h: qh, item: q.it }); yy += qh; } x += cw; w -= cw; }
      else { const rh = s / w; let xx = x; for (const q of r) { const qw = q.a / rh; out.push({ x: xx, y, w: qw, h: rh, item: q.it }); xx += qw; } y += rh; h -= rh; }
    };
    for (const q of list) {
      const side = Math.min(w, h);
      if (!row.length || worst([...row, q], side) <= worst(row, side)) row.push(q);
      else { lay(row); row = [q]; }
    }
    if (row.length) lay(row);
    return out;
  }

  root.CandelaScreener = { VENUES, scan, PRESETS, treemap };
})(typeof window !== 'undefined' ? window : globalThis);
