/* Candela — derivatives data: open interest, funding rates and long/short ratios over time, live
 * liquidations, and funding rates across exchanges.
 *
 * For a perpetual futures chart the data comes from its own exchange where it publishes it; for anything
 * else (a spot chart, say) from the coin's USDT perpetual on Binance, then OKX, then Bybit, whichever
 * answers first. Some of these exchanges block some countries; the next one in line is tried.
 * Hyperliquid publishes funding history (every hour) but no open interest or long/short history. */
(function (root) {
  'use strict';
  const MD = root.MarketData;
  const TF = MD.TF;
  const get = (url, name, cors) => MD.getJSON(url, name, cors);

  // ---- which coin: "BTC" from BTCUSDT, KRAKEN:BTC/USD, HYPERLIQUID:KPEPE/USDC (= kPEPE, 1,000 PEPE)…
  function coinOf(sym) {
    const bq = MD.baseQuote(sym);
    if (!bq) return null;
    let base = bq.base;
    const ex = MD.exchangeOf(sym);
    if (ex && ex.id === 'HYPERLIQUID') {
      const c = ex.coins && ex.coins[`${bq.base}/${bq.quote}`];
      if (c && c.includes(':')) return null; // HIP-3 markets (stocks…) trade only there
      if (c && /^k[A-Z]/.test(c)) base = c.slice(1);
    }
    return base.replace(/^1000+(?=[A-Z])/, '');
  }
  // the futures symbol names on each exchange (some coins trade in thousands: 1000PEPEUSDT)
  async function binanceName(coin) {
    try {
      const list = await MD.exPairs('BINANCEF');
      const hit = list.find((x) => x.base === coin && x.quote === 'USDT') || list.find((x) => x.base === '1000' + coin && x.quote === 'USDT');
      return hit ? hit.base + 'USDT' : null;
    } catch (e) { return coin + 'USDT'; } // list blocked here: try the usual name
  }
  async function bybitName(coin) {
    try {
      const list = await MD.exPairs('BYBITF');
      const hit = list.find((x) => x.base === coin && x.quote === 'USDT') || list.find((x) => x.base === '1000' + coin && x.quote === 'USDT');
      return hit ? hit.base + 'USDT' : null;
    } catch (e) { return coin + 'USDT'; }
  }

  // the largest period an exchange offers that isn't longer than the chart's candles
  function pickPeriod(tf, periods) {
    const ms = TF[tf] || 3600e3;
    let best = periods[0];
    for (const p of periods) if (p[1] <= ms) best = p;
    return best[0];
  }
  const M = 60e3, H = 3600e3, D = 86400e3;

  // ---- sources. Each returns [{ t, v, … }] oldest first, or throws.
  const BN = 'https://fapi.binance.com';
  const BN_P = [['5m', 5 * M], ['15m', 15 * M], ['30m', 30 * M], ['1h', H], ['2h', 2 * H], ['4h', 4 * H], ['6h', 6 * H], ['12h', 12 * H], ['1d', D]];
  const binance = {
    name: 'Binance',
    async oi(coin, tf) {
      const s = await binanceName(coin);
      if (!s) throw new Error('not on Binance Futures');
      const rows = await get(`${BN}/futures/data/openInterestHist?symbol=${s}&period=${pickPeriod(tf, BN_P)}&limit=500`, 'Binance Futures');
      return rows.map((r) => ({ t: +r.timestamp, v: +r.sumOpenInterestValue, coin: +r.sumOpenInterest }));
    },
    async lsr(coin, tf) {
      const s = await binanceName(coin);
      if (!s) throw new Error('not on Binance Futures');
      const rows = await get(`${BN}/futures/data/globalLongShortAccountRatio?symbol=${s}&period=${pickPeriod(tf, BN_P)}&limit=500`, 'Binance Futures');
      return rows.map((r) => ({ t: +r.timestamp, v: +r.longShortRatio, long: +r.longAccount }));
    },
    async funding(coin) {
      const s = await binanceName(coin);
      if (!s) throw new Error('not on Binance Futures');
      const rows = await get(`${BN}/fapi/v1/fundingRate?symbol=${s}&limit=1000`, 'Binance Futures');
      return rows.map((r) => ({ t: +r.fundingTime, v: +r.fundingRate }));
    },
  };
  const OK = 'https://www.okx.com/api/v5';
  const OK_P = [['5m', 5 * M], ['15m', 15 * M], ['30m', 30 * M], ['1H', H], ['2H', 2 * H], ['4H', 4 * H], ['6H', 6 * H], ['12H', 12 * H], ['1D', D]];
  const okData = (j) => { if (j.code !== '0') throw new Error(`OKX: ${j.msg || j.code}`); return j.data; };
  // OKX gives 100 rows a request: walk back a few pages
  async function okPages(url, pages = 3) {
    let out = [], end = '';
    for (let k = 0; k < pages; k++) {
      const d = okData(await get(url + (end ? `&end=${end}` : ''), 'OKX'));
      if (!d.length) break;
      out = out.concat(d);
      end = d[d.length - 1][0];
      if (d.length < 100) break;
    }
    return out;
  }
  const okx = {
    name: 'OKX',
    async oi(coin, tf) {
      const d = await okPages(`${OK}/rubik/stat/contracts/open-interest-history?instId=${coin}-USDT-SWAP&period=${pickPeriod(tf, OK_P)}&limit=100`);
      return d.map((r) => ({ t: +r[0], v: +r[3], coin: +r[2] })).reverse();
    },
    async lsr(coin, tf) {
      const d = await okPages(`${OK}/rubik/stat/contracts/long-short-account-ratio-contract?instId=${coin}-USDT-SWAP&period=${pickPeriod(tf, OK_P)}&limit=100`);
      return d.map((r) => ({ t: +r[0], v: +r[1] })).reverse();
    },
    async funding(coin) {
      let out = [], after = '';
      for (let k = 0; k < 4; k++) {
        const d = okData(await get(`${OK}/public/funding-rate-history?instId=${coin}-USDT-SWAP&limit=100${after ? '&after=' + after : ''}`, 'OKX'));
        if (!d.length) break;
        out = out.concat(d);
        after = d[d.length - 1].fundingTime;
        if (d.length < 100) break;
      }
      return out.map((r) => ({ t: +r.fundingTime, v: +(r.realizedRate || r.fundingRate) })).reverse();
    },
  };
  const BY = 'https://api.bybit.com/v5/market';
  const BY_P = [['5min', 5 * M], ['15min', 15 * M], ['30min', 30 * M], ['1h', H], ['4h', 4 * H], ['1d', D]];
  const byList = (j) => { if (j.retCode !== 0) throw new Error(`Bybit: ${j.retMsg}`); return j.result.list || []; };
  const bybit = {
    name: 'Bybit',
    async oi(coin, tf) {
      const s = await bybitName(coin);
      if (!s) throw new Error('not on Bybit');
      const d = byList(await get(`${BY}/open-interest?category=linear&symbol=${s}&intervalTime=${pickPeriod(tf, BY_P)}&limit=200`, 'Bybit'));
      return d.map((r) => ({ t: +r.timestamp, coin: +r.openInterest })).reverse(); // in coins: valued at each candle's close
    },
    async lsr(coin, tf) {
      const s = await bybitName(coin);
      if (!s) throw new Error('not on Bybit');
      const d = byList(await get(`${BY}/account-ratio?category=linear&symbol=${s}&period=${pickPeriod(tf, BY_P)}&limit=500`, 'Bybit'));
      return d.map((r) => ({ t: +r.timestamp, v: +r.buyRatio / +r.sellRatio, long: +r.buyRatio })).reverse();
    },
    async funding(coin) {
      const s = await bybitName(coin);
      if (!s) throw new Error('not on Bybit');
      const d = byList(await get(`${BY}/funding/history?category=linear&symbol=${s}&limit=200`, 'Bybit'));
      return d.map((r) => ({ t: +r.fundingRateTimestamp, v: +r.fundingRate })).reverse();
    },
  };
  const hyperliquid = {
    name: 'Hyperliquid',
    async funding(coin, tf, sym) {
      const ex = MD.EXCHANGES.HYPERLIQUID;
      let name = coin;
      const bq = sym && MD.baseQuote(sym);
      if (sym && MD.exchangeOf(sym) === ex) name = await ex.coin(bq.base, bq.quote);
      let out = [], start = Date.now() - 60 * D;
      for (let k = 0; k < 4; k++) {
        const d = await MD.hlInfo({ type: 'fundingHistory', coin: name, startTime: start });
        if (!Array.isArray(d) || !d.length) break;
        out = out.concat(d);
        start = d[d.length - 1].time + 1;
        if (d.length < 500) break;
      }
      if (!out.length) throw new Error('no funding history');
      return out.map((r) => ({ t: r.time, v: +r.fundingRate }));
    },
  };

  const OWN = { BINANCEF: binance, BYBITF: bybit, HYPERLIQUID: hyperliquid };
  const LABEL = { oi: 'open interest', funding: 'funding', lsr: 'long/short ratio' };
  // { source, series, perHours (funding) } for a chart's symbol and timeframe
  async function history(sym, kind, tf) {
    const ex = MD.exchangeOf(sym), coin = coinOf(sym);
    const own = ex && OWN[ex.id] && OWN[ex.id][kind] ? [OWN[ex.id]] : [];
    if (!coin && !own.length) throw new Error(`No ${LABEL[kind]} data for this market`);
    const chain = [...own, ...(coin ? [binance, okx, bybit] : [])].filter((x, i, a) => x[kind] && a.indexOf(x) === i);
    const fails = [];
    for (const src of chain) {
      try {
        const series = (await src[kind](coin, tf, sym)).filter((r) => isFinite(r.t)).sort((a, b) => a.t - b.t);
        if (series.length) return { source: src.name, series, perHours: kind === 'funding' ? (src === hyperliquid ? 1 : guessHours(series)) : null };
        fails.push(`${src.name}: no data`);
      } catch (e) { fails.push(`${src.name}: ${e.geo ? 'blocked here' : e.message}`); }
    }
    throw new Error(`No ${LABEL[kind]} data (${fails.join('; ')})`);
  }
  // funding interval from the spacing of the payments (8 h on most exchanges, 4 h or 1 h on some coins)
  function guessHours(series) {
    if (series.length < 3) return 8;
    const gaps = [];
    for (let i = Math.max(1, series.length - 20); i < series.length; i++) gaps.push(series[i].t - series[i - 1].t);
    gaps.sort((a, b) => a - b);
    return Math.max(1, Math.round(gaps[gaps.length >> 1] / H));
  }

  // ---- live liquidations of one coin on Binance, Bybit and OKX. onLiq([{ t, ex, px, qty, usd, long }])
  // (long: a long position was closed by liquidation, i.e. a forced sell)
  function liquidations(sym, onLiq, onStatus) {
    const coin = coinOf(sym);
    if (!coin) return () => {};
    const stops = [];
    let stopped = false;
    (async () => {
      const [bn, by] = await Promise.all([binanceName(coin), bybitName(coin)]);
      if (stopped) return;
      if (bn) stops.push(MD.exSocket(`wss://fstream.binance.com/market/ws/${bn.toLowerCase()}@forceOrder`, {
        onOpen: () => {},
        onMessage: (m) => { const o = m.o; if (o) { const px = +(o.ap || o.p), q = +(o.z || o.q); onLiq([{ t: o.T, ex: 'Binance', px, qty: q, usd: px * q, long: o.S === 'SELL' }]); } },
        onStatus,
      }));
      if (by) stops.push(MD.exSocket('wss://stream.bybit.com/v5/public/linear', {
        onOpen: (send) => send({ op: 'subscribe', args: [`allLiquidation.${by}`] }),
        onMessage: (m) => { if (Array.isArray(m.data) && /^allLiquidation/.test(m.topic || '')) onLiq(m.data.map((d) => ({ t: +d.T, ex: 'Bybit', px: +d.p, qty: +d.v, usd: +d.p * +d.v, long: d.S === 'Buy' }))); },
        ping: { every: 20000, msg: { op: 'ping' } },
      }));
      // OKX sizes are in contracts: get the contract size first; its recent liquidations come first too
      let ctVal = null;
      try { const i = await get(`${OK}/public/instruments?instType=SWAP&instId=${coin}-USDT-SWAP`, 'OKX'); ctVal = +okData(i)[0].ctVal; } catch (e) { /* not on OKX */ }
      if (stopped || !(ctVal > 0)) return;
      const okRow = (d) => ({ t: +d.ts, ex: 'OKX', px: +d.bkPx, qty: +d.sz * ctVal, usd: +d.bkPx * +d.sz * ctVal, long: d.posSide === 'long' });
      try {
        const r = okData(await get(`${OK}/public/liquidation-orders?instType=SWAP&uly=${coin}-USDT&state=filled&limit=100`, 'OKX'));
        if (!stopped && r[0]) onLiq(r[0].details.map(okRow).filter((x) => Date.now() - x.t < 6 * H).sort((a, b) => a.t - b.t));
      } catch (e) { /* the stream still comes */ }
      if (stopped) return;
      stops.push(MD.exSocket('wss://ws.okx.com/ws/v5/public', {
        onOpen: (send) => send({ op: 'subscribe', args: [{ channel: 'liquidation-orders', instType: 'SWAP' }] }),
        onMessage: (m) => { for (const d of m.data || []) if (d.instId === `${coin}-USDT-SWAP`) onLiq(d.details.map(okRow).filter((x) => Date.now() - x.t < 10 * M)); },
        ping: { every: 25000, msg: 'ping' },
      }));
    })();
    return () => { stopped = true; for (const s of stops) s(); };
  }

  // ---- current funding on every exchange: { EX: { COIN: { rate, hours } } }
  const FUNDING_SOURCES = {
    Binance: async () => {
      const rows = await get(`${BN}/fapi/v1/premiumIndex`, 'Binance Futures');
      return rows.filter((r) => /USDT$/.test(r.symbol)).map((r) => [r.symbol.replace(/USDT$/, ''), +r.lastFundingRate, 8]);
    },
    Bybit: async () => byList(await get(`${BY}/tickers?category=linear`, 'Bybit')).filter((r) => /USDT$/.test(r.symbol) && r.fundingRate !== '')
      .map((r) => [r.symbol.replace(/USDT$/, ''), +r.fundingRate, +r.fundingIntervalHour || 8]),
    OKX: async () => okData(await get(`${OK}/public/funding-rate?instId=ANY`, 'OKX')).filter((r) => /-USDT-SWAP$/.test(r.instId))
      .map((r) => [r.instId.replace(/-USDT-SWAP$/, ''), +r.fundingRate, r.fundingTime && r.nextFundingTime ? Math.round((+r.nextFundingTime - +r.fundingTime) / H) || 8 : 8]),
    Bitget: async () => { const j = await get('https://api.bitget.com/api/v2/mix/market/tickers?productType=usdt-futures', 'Bitget'); return (j.data || []).filter((r) => /USDT$/.test(r.symbol)).map((r) => [r.symbol.replace(/USDT$/, ''), +r.fundingRate, 8]); },
    'Gate.io': async () => (await get('https://api.gateio.ws/api/v4/futures/usdt/tickers', 'Gate.io')).map((r) => [r.contract.replace(/_USDT$/, ''), +r.funding_rate, 8]),
    MEXC: async () => { const j = await get('https://contract.mexc.com/api/v1/contract/funding_rate', 'MEXC'); return (j.data || []).filter((r) => /_USDT$/.test(r.symbol)).map((r) => [r.symbol.replace(/_USDT$/, ''), +r.fundingRate, +r.collectCycle || 8]); },
    HTX: async () => { const j = await get('https://api.hbdm.com/linear-swap-api/v1/swap_batch_funding_rate', 'HTX'); return (j.data || []).filter((r) => /-USDT$/.test(r.contract_code)).map((r) => [r.symbol, +r.funding_rate, 8]); },
    KuCoin: async () => { const j = await get('https://api-futures.kucoin.com/api/v1/contracts/active', 'KuCoin'); return (j.data || []).filter((r) => r.quoteCurrency === 'USDT' && r.fundingFeeRate != null).map((r) => [r.baseCurrency === 'XBT' ? 'BTC' : r.baseCurrency, +r.fundingFeeRate, Math.round((+r.fundingRateGranularity || 8 * H) / H)]); },
    Hyperliquid: async () => {
      const [meta, ctx] = await MD.hlInfo({ type: 'metaAndAssetCtxs' });
      return meta.universe.map((u, i) => (u.isDelisted ? null : [u.name.replace(/^k(?=[A-Z])/, ''), +ctx[i].funding, 1])).filter((r) => r && isFinite(r[1]));
    },
  };
  async function fundingTable() {
    const names = Object.keys(FUNDING_SOURCES), out = {}, errors = {};
    await Promise.all(names.map(async (n) => {
      try {
        const m = {};
        for (const [coin, rate, hours] of await FUNDING_SOURCES[n]()) if (isFinite(rate) && coin) m[coin.replace(/^1000+(?=[A-Z])/, '')] = { rate, hours: hours || 8 };
        out[n] = m;
      } catch (e) { errors[n] = e.geo ? 'blocked in your region' : e.needsServer ? 'needs the Windows app or node server.js' : 'unavailable'; }
    }));
    return { exchanges: names, data: out, errors };
  }

  // ---- market overview
  async function fearGreed(days = 90) {
    const j = await get(`https://api.alternative.me/fng/?limit=${days}`, 'alternative.me', true);
    return (j.data || []).map((d) => ({ t: +d.timestamp * 1000, v: +d.value, label: d.value_classification })).reverse();
  }

  root.CandelaDerivs = { history, liquidations, fundingTable, fearGreed, coinOf };
})(typeof window !== 'undefined' ? window : globalThis);
