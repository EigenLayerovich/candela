/* Candela — more crypto exchanges: Bybit, OKX, Bitget, KuCoin, Gate.io, MEXC, HTX, Kraken, Coinbase and Bitfinex,
 * Hyperliquid (perpetuals and spot), plus Binance and Bybit perpetual futures (Binance spot lives in data.js).
 *
 * Symbols are written EXCHANGE:BASE/QUOTE, e.g. "KRAKEN:BTC/USD", "KUCOIN:ETH/USDT". Every exchange gets
 * the same five operations: symbol list, candle history, live updates, a 24-hour ticker, and the candle
 * intervals it offers. Timeframes an exchange lacks (Coinbase has no 4H, Kraken no 2H…) are built from
 * smaller candles, so every exchange supports every timeframe.
 *
 * Browser access: most exchanges allow web pages to call them. KuCoin, MEXC and Bitfinex don't, so they go through
 * Candela's server (the Windows app and `node server.js` have one); Bybit is tried directly first. */
(function (root) {
  'use strict';
  const MD = root.MarketData;
  const TF = MD.TF;
  const inBrowser = typeof document !== 'undefined';
  let proxyBase = null; // e.g. "/api/proxy" when the page is served by Candela's server
  let proxyToken = '';

  const err = (msg, extra) => Object.assign(new Error(msg), extra || {});

  // ---------------------------------------------------------------- HTTP with the CORS fallback
  async function readJSON(r, ex) {
    if (r.status === 403 || r.status === 451) {
      throw err(`${ex.name} refused the request (HTTP ${r.status}). ${ex.name} blocks some countries, for example the US.`, { fatal: true, geo: true });
    }
    const j = await r.json().catch(() => null);
    if (!j) throw err(`${ex.name}: HTTP ${r.status}`);
    if (!r.ok && !j.data && !j.result) throw err(`${ex.name}: ${j.message || j.msg || j.error || 'HTTP ' + r.status}`, { fatal: r.status === 400 || r.status === 404 });
    return j;
  }
  const viaProxy = (url) => fetch(`${proxyBase}?url=${encodeURIComponent(url)}${proxyToken ? '&token=' + encodeURIComponent(proxyToken) : ''}`);

  async function get(ex, url) {
    if (!inBrowser || ex.cors === true) return readJSON(await fetch(url), ex);
    if (ex.cors === false) {
      if (!proxyBase) throw err(`${ex.name} doesn't let web pages load its data directly. Use the Candela Windows app, or open Candela from node server.js.`, { fatal: true, needsServer: true });
      return readJSON(await viaProxy(url), ex);
    }
    // not sure: try directly, then through the server
    try { return await readJSON(await fetch(url), ex); } catch (e) {
      if (!proxyBase && e instanceof TypeError) throw err(`Couldn't load ${ex.name} data here: it may not allow web pages, or blocks your region. The Candela Windows app can try through its own connection.`, { needsServer: true });
      if (!proxyBase || (e.fatal && !e.geo)) throw e;
      return readJSON(await viaProxy(url), ex);
    }
  }

  // ---------------------------------------------------------------- reconnecting WebSocket
  // gzip: messages arrive compressed (HTX). answer(m) may return a reply to send at once (HTX's pings).
  const gunzip = (buf) => new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
  function socket(url, { onOpen, onMessage, onStatus, ping, gzip, answer }) {
    let ws, closed = false, tries = 0, timer = null, pinger = null;
    const open = () => {
      if (closed) return;
      onStatus && onStatus('connecting');
      try { ws = new WebSocket(url); } catch (e) { return retry(); }
      ws.onopen = () => {
        tries = 0;
        onStatus && onStatus('live');
        onOpen((m) => { try { ws.send(JSON.stringify(m)); } catch (e) { /* closing */ } });
        if (ping) pinger = setInterval(() => { try { ws.send(typeof ping.msg === 'string' ? ping.msg : JSON.stringify(ping.msg)); } catch (e) { /* closing */ } }, ping.every);
      };
      const sock = ws;
      const handle = (txt) => {
        let m;
        try { m = JSON.parse(txt); } catch (e) { return; }
        const reply = answer && answer(m);
        if (reply) { try { sock.send(JSON.stringify(reply)); } catch (e) { /* closing */ } }
        onMessage(m);
      };
      let chain = Promise.resolve(); // decompress in order
      if (gzip) ws.binaryType = 'arraybuffer';
      ws.onmessage = (ev) => {
        if (gzip && typeof ev.data !== 'string') chain = chain.then(() => gunzip(ev.data)).then((txt) => { if (!closed && ws === sock) handle(txt); }, () => {});
        else handle(ev.data);
      };
      ws.onclose = () => { clearInterval(pinger); if (!closed) { onStatus && onStatus('reconnecting'); retry(); } };
      ws.onerror = () => { try { ws.close(); } catch (e) { /* ignore */ } };
    };
    const retry = () => { tries++; timer = setTimeout(open, Math.min(30000, 1000 * 2 ** Math.min(tries, 5))); };
    open();
    return () => {
      closed = true;
      clearTimeout(timer);
      clearInterval(pinger);
      if (!ws) return;
      ws.onclose = null;
      ws.onmessage = null;
      if (ws.readyState === 0) ws.onopen = () => ws.close(); else try { ws.close(); } catch (e) { /* ignore */ }
    };
  }

  // poll the last few candles (KuCoin; also the fallback for others)
  function poller(ex, b, q, tf, onBar, onStatus, every) {
    let stopped = false, timer = null;
    const tick = async () => {
      if (stopped) return;
      try {
        for (const bar of await ex.history(b, q, tf, { limit: 3 })) onBar(bar);
        onStatus && onStatus('live');
      } catch (e) { onStatus && onStatus('reconnecting'); }
      if (!stopped) timer = setTimeout(tick, every);
    };
    onStatus && onStatus('live'); // the chart was just loaded
    timer = setTimeout(tick, every);
    return () => { stopped = true; clearTimeout(timer); };
  }

  // A live WebSocket feed that switches to polling if no candle arrives for 30 seconds (the socket is
  // blocked on this network, or the exchange moved it).
  function liveOrPoll(ex, b, q, tf, onBar, onStatus, openSocket) {
    let last = Date.now(), stopWs = null, stopPoll = null;
    stopWs = openSocket((bar) => { last = Date.now(); onBar(bar); }, (st) => { if (!stopPoll && onStatus) onStatus(st); });
    const watchdog = setInterval(() => {
      if (Date.now() - last < 30000) return;
      clearInterval(watchdog);
      stopWs();
      stopPoll = poller(ex, b, q, tf, onBar, onStatus, 4000);
    }, 5000);
    return () => { clearInterval(watchdog); stopWs(); if (stopPoll) stopPoll(); };
  }

  const sortAsc = (bars) => bars.sort((a, b) => a.t - b.t);
  // fetch `limit` candles ending at `endTime`, `per` at a time, walking backwards
  async function pages({ limit = 1000, endTime } = {}, per, fetchPage) {
    const out = new Map();
    let end = endTime;
    const perPage = (e) => (typeof per === 'function' ? per(e) : per); // may differ for the latest page
    for (let k = 0, max = Math.min(12, Math.ceil(limit / perPage(1)) + 1); out.size < limit && k < max; k++) {
      const n = Math.min(perPage(end), limit - out.size), rows = await fetchPage(n, end);
      let oldest = Infinity;
      for (const r of rows) { if (!endTime || r.t <= endTime) out.set(r.t, r); oldest = Math.min(oldest, r.t); }
      // a short page from the archive means the start of the history (the latest page can be short on some exchanges)
      if (!isFinite(oldest) || (end && rows.length < n - 1)) break;
      end = oldest - 1;
    }
    return sortAsc([...out.values()]).slice(-limit);
  }

  // ---------------------------------------------------------------- Bybit
  // spot and USDT/USDC perpetual futures ("linear") share one API
  function bybit(category) {
    const futures = category === 'linear';
    return {
      id: futures ? 'BYBITF' : 'BYBIT', name: futures ? 'Bybit Futures' : 'Bybit', short: futures ? 'Bybit perp' : 'Bybit',
      tag: futures ? 'BYF' : 'BY', futures, cors: 'unknown', rest: 'https://api.bybit.com',
      tfs: { '1m': '1', '3m': '3', '5m': '5', '15m': '15', '30m': '30', '1h': '60', '2h': '120', '4h': '240', '6h': '360', '12h': '720', '1d': 'D', '1w': 'W', '1M': 'M' },
      symOf: null, // "BTC/USDC" -> "BTCPERP": not every futures symbol is base + quote
      async pairs() {
        const out = [], symOf = {};
        let cursor = '';
        for (let k = 0; k < 5; k++) {
          const j = await get(this, `${this.rest}/v5/market/instruments-info?category=${category}&limit=1000${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`);
          if (j.retCode !== 0) throw err(`${this.name}: ${j.retMsg}`);
          for (const x of j.result.list || []) {
            if (x.status !== 'Trading' || (futures && x.contractType !== 'LinearPerpetual')) continue;
            out.push([x.baseCoin, x.quoteCoin]);
            symOf[`${x.baseCoin}/${x.quoteCoin}`.toUpperCase()] = x.symbol;
          }
          cursor = j.result.nextPageCursor;
          if (!cursor) break;
        }
        this.symOf = symOf;
        return out;
      },
      async symbol(b, q) {
        if (!futures || q === 'USDT') return b + q;
        if (!this.symOf) { try { await pairs(this.id); } catch (e) { /* guess */ } }
        return (this.symOf && this.symOf[`${b}/${q}`]) || b + q;
      },
      history(b, q, tf, opts) {
        return pages(opts, 1000, async (n, end) => {
          let url = `${this.rest}/v5/market/kline?category=${category}&symbol=${await this.symbol(b, q)}&interval=${this.tfs[tf]}&limit=${n}`;
          if (end) url += `&end=${Math.floor(end)}`;
          const j = await get(this, url);
          if (j.retCode !== 0) throw err(`${this.name}: ${j.retMsg}`, { fatal: /symbol|not ?support|invalid/i.test(j.retMsg || '') });
          // [start(ms), open, high, low, close, volume, turnover], newest first
          return (j.result.list || []).map((r) => ({ t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] }));
        });
      },
      stream(b, q, tf, onBar, onStatus) {
        const open = (bar, status) => {
          let stop = null, stopped = false;
          this.symbol(b, q).then((name) => {
            if (stopped) return;
            const topic = `kline.${this.tfs[tf]}.${name}`;
            stop = socket(`wss://stream.bybit.com/v5/public/${category}`, {
              onOpen: (send) => send({ op: 'subscribe', args: [topic] }),
              onMessage: (m) => { if (m.topic === topic) for (const d of m.data || []) bar({ t: +d.start, o: +d.open, h: +d.high, l: +d.low, c: +d.close, v: +d.volume }); },
              onStatus: status, ping: { every: 20000, msg: { op: 'ping' } },
            });
          });
          return () => { stopped = true; if (stop) stop(); };
        };
        return futures ? liveOrPoll(this, b, q, tf, onBar, onStatus, open) : open(onBar, onStatus);
      },
      async ticker(b, q) {
        const r = (await get(this, `${this.rest}/v5/market/tickers?category=${category}&symbol=${await this.symbol(b, q)}`)).result.list[0];
        const t = { c: +r.lastPrice, o: +r.prevPrice24h, vq: +r.turnover24h };
        if (futures) Object.assign(t, { funding: +r.fundingRate, nextFunding: +r.nextFundingTime, mark: +r.markPrice, index: +r.indexPrice, oiValue: +r.openInterestValue });
        return t;
      },
    };
  }
  const BYBIT = bybit('spot');
  const BYBITF = bybit('linear');

  // ---------------------------------------------------------------- Binance USDⓈ-M perpetual futures
  // (Binance spot lives in data.js.) Same candle format as spot.
  const BINANCEF = {
    id: 'BINANCEF', name: 'Binance Futures', short: 'Binance perp', tag: 'BNF', futures: true, cors: 'unknown', rest: 'https://fapi.binance.com',
    tfs: Object.fromEntries(['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d', '3d', '1w', '1M'].map((x) => [x, x])),
    async pairs() {
      const j = await get(this, `${this.rest}/fapi/v1/exchangeInfo`);
      // perpetuals only (crypto, and the stock / commodity "TradFi" perpetuals)
      return (j.symbols || []).filter((x) => x.status === 'TRADING' && /PERPETUAL$/.test(x.contractType) && x.symbol === x.baseAsset + x.quoteAsset)
        .map((x) => [x.baseAsset, x.quoteAsset]);
    },
    history(b, q, tf, opts) {
      return pages(opts, 1500, async (n, end) => {
        let url = `${this.rest}/fapi/v1/klines?symbol=${b}${q}&interval=${tf}&limit=${n}`;
        if (end) url += `&endTime=${Math.floor(end)}`;
        const rows = await get(this, url);
        if (!Array.isArray(rows)) throw err(`Binance Futures: ${rows.msg || 'unexpected reply'}`, { fatal: true });
        return rows.map((r) => ({ t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5], bv: +r[9] }));
      });
    },
    stream(b, q, tf, onBar, onStatus) {
      return liveOrPoll(this, b, q, tf, onBar, onStatus, (bar, status) => socket(`wss://fstream.binance.com/market/ws/${(b + q).toLowerCase()}@kline_${tf}`, { // market streams moved under /market
        onOpen: () => {},
        onMessage: (m) => { const k = m.k; if (k) bar({ t: k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.v, bv: +k.V }); },
        onStatus: status,
      }));
    },
    async ticker(b, q) {
      const [t, p, oi] = await Promise.all([
        get(this, `${this.rest}/fapi/v1/ticker/24hr?symbol=${b}${q}`),
        get(this, `${this.rest}/fapi/v1/premiumIndex?symbol=${b}${q}`).catch(() => null),
        get(this, `${this.rest}/fapi/v1/openInterest?symbol=${b}${q}`).catch(() => null),
      ]);
      const out = { c: +t.lastPrice, o: +t.openPrice, vq: +t.quoteVolume };
      if (p) Object.assign(out, { funding: +p.lastFundingRate, nextFunding: +p.nextFundingTime, mark: +p.markPrice, index: +p.indexPrice });
      if (p && oi) out.oiValue = +oi.openInterest * +p.markPrice;
      return out;
    },
  };

  // ---------------------------------------------------------------- KuCoin
  const KUCOIN = {
    id: 'KUCOIN', name: 'KuCoin', tag: 'KC', cors: false, rest: 'https://api.kucoin.com',
    tfs: { '1m': '1min', '3m': '3min', '5m': '5min', '15m': '15min', '30m': '30min', '1h': '1hour', '2h': '2hour', '4h': '4hour', '6h': '6hour', '12h': '12hour', '1d': '1day', '1w': '1week' },
    ok(j) { if (j.code !== '200000') throw err(`KuCoin: ${j.msg || j.code}`, { fatal: true }); return j.data; },
    async pairs() {
      return this.ok(await get(this, `${this.rest}/api/v2/symbols`)).filter((s) => s.enableTrading).map((s) => [s.baseCurrency, s.quoteCurrency]);
    },
    history(b, q, tf, opts) {
      const iv = TF[tf] / 1000;
      return pages(opts, 1500, async (n, endMs) => {
        const end = endMs ? Math.floor(endMs / 1000) : Math.floor(Date.now() / 1000) + iv;
        const url = `${this.rest}/api/v1/market/candles?type=${this.tfs[tf]}&symbol=${b}-${q}&startAt=${end - n * iv}&endAt=${end}`;
        // [time(s), open, close, high, low, volume, turnover], newest first
        return this.ok(await get(this, url)).map((r) => ({ t: r[0] * 1000, o: +r[1], h: +r[3], l: +r[4], c: +r[2], v: +r[5] }));
      });
    },
    stream(b, q, tf, onBar, onStatus) { return poller(this, b, q, tf, onBar, onStatus, 4000); },
    async ticker(b, q) {
      const d = this.ok(await get(this, `${this.rest}/api/v1/market/stats?symbol=${b}-${q}`));
      return { c: +d.last, o: +d.last / (1 + +d.changeRate), vq: +d.volValue };
    },
  };

  // ---------------------------------------------------------------- Kraken
  // Kraken calls Bitcoin XBT and Dogecoin XDG; Candela uses BTC and DOGE (Kraken's newer API does too).
  const KR_NAMES = { XBT: 'BTC', XDG: 'DOGE' };
  const KRAKEN = {
    id: 'KRAKEN', name: 'Kraken', tag: 'KR', cors: true, quotes: ['USD', 'USDT', 'USDC', 'EUR'], rest: 'https://api.kraken.com',
    // (Kraken's own weekly candles start on Thursdays; Candela builds Monday weeks from daily candles)
    tfs: { '1m': 1, '5m': 5, '15m': 15, '30m': 30, '1h': 60, '4h': 240, '1d': 1440 },
    historyNote: 'Kraken only provides the latest 720 candles for each timeframe.',
    ok(j) { if (j.error && j.error.length) throw err(`Kraken: ${j.error.join(', ')}`, { fatal: /Unknown asset pair|Invalid/i.test(j.error.join(' ')) }); return j.result; },
    async pairs() {
      const r = this.ok(await get(this, `${this.rest}/0/public/AssetPairs`));
      return Object.values(r).filter((p) => p.wsname && (!p.status || p.status === 'online')).map((p) => p.wsname.split('/').map((x) => KR_NAMES[x] || x));
    },
    async history(b, q, tf, { limit = 1000, endTime } = {}) {
      if (endTime) return []; // no older history on Kraken
      const r = this.ok(await get(this, `${this.rest}/0/public/OHLC?pair=${encodeURIComponent(b + '/' + q)}&interval=${this.tfs[tf]}`));
      const rows = r[Object.keys(r).find((k) => k !== 'last')] || [];
      // [time(s), open, high, low, close, vwap, volume, count]
      return rows.slice(-limit).map((x) => ({ t: x[0] * 1000, o: +x[1], h: +x[2], l: +x[3], c: +x[4], v: +x[6] }));
    },
    stream(b, q, tf, onBar, onStatus) {
      const symbol = `${b}/${q}`, interval = this.tfs[tf];
      return socket('wss://ws.kraken.com/v2', {
        onOpen: (send) => send({ method: 'subscribe', params: { channel: 'ohlc', symbol: [symbol], interval, snapshot: false } }),
        onMessage: (m) => {
          if (m.channel !== 'ohlc') return;
          for (const d of m.data || []) if (d.symbol === symbol) onBar({ t: Date.parse(d.interval_begin), o: d.open, h: d.high, l: d.low, c: d.close, v: d.volume });
        },
        onStatus,
      });
    },
    async ticker(b, q) {
      const r = this.ok(await get(this, `${this.rest}/0/public/Ticker?pair=${encodeURIComponent(b + '/' + q)}`));
      const t = r[Object.keys(r)[0]];
      return { c: +t.c[0], o: +t.o, vq: +t.v[1] * +t.p[1] }; // change since Kraken's daily open (midnight UTC)
    },
  };

  // ---------------------------------------------------------------- Coinbase
  const COINBASE = {
    id: 'COINBASE', name: 'Coinbase', tag: 'CB', cors: true, quotes: ['USD', 'USDC', 'USDT', 'EUR'], rest: 'https://api.exchange.coinbase.com',
    tfs: { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '6h': 21600, '1d': 86400 },
    async pairs() {
      const list = await get(this, `${this.rest}/products`);
      return list.filter((p) => p.status === 'online' && !p.trading_disabled).map((p) => [p.base_currency, p.quote_currency]);
    },
    // 300 candles per request: page backwards until `limit` candles or the start of the history
    async history(b, q, tf, { limit = 1000, endTime } = {}) {
      const iv = TF[tf], out = new Map();
      let end = endTime || Date.now() + iv;
      for (let page = 0; out.size < limit && page < Math.ceil(limit / 300) + 1; page++) {
        const start = end - 300 * iv;
        const rows = await get(this, `${this.rest}/products/${b}-${q}/candles?granularity=${this.tfs[tf]}&start=${new Date(start).toISOString()}&end=${new Date(end).toISOString()}`);
        if (!Array.isArray(rows)) throw err(`Coinbase: ${rows.message || 'unexpected reply'}`, { fatal: /NotFound|not found/i.test(rows.message || '') });
        // [time(s), low, high, open, close, volume], newest first
        for (const r of rows) if (r[0] * 1000 <= (endTime || Infinity)) out.set(r[0] * 1000, { t: r[0] * 1000, o: r[3], h: r[2], l: r[1], c: r[4], v: r[5] });
        if (!rows.length) break; // before the product existed
        end = start - 1;
      }
      return sortAsc([...out.values()]).slice(-limit);
    },
    // Coinbase has no live candle feed: build the current candle from live trades, and re-sync each minute
    stream(b, q, tf, onBar, onStatus) {
      const iv = TF[tf], id = `${b}-${q}`;
      let cur = null, stopped = false;
      const sync = async () => {
        try { for (const bar of await this.history(b, q, tf, { limit: 2 })) { if (!cur || bar.t >= cur.t) cur = { ...bar }; onBar({ ...bar }); } } catch (e) { /* next time */ }
      };
      sync();
      const resync = setInterval(sync, 60000);
      const stop = socket('wss://ws-feed.exchange.coinbase.com', {
        onOpen: (send) => send({ type: 'subscribe', product_ids: [id], channels: ['matches'] }),
        onMessage: (m) => {
          if ((m.type !== 'match' && m.type !== 'last_match') || m.product_id !== id || !cur) return;
          const p = +m.price, size = +m.size, t = Math.floor(Date.parse(m.time) / iv) * iv;
          if (t > cur.t) cur = { t, o: p, h: p, l: p, c: p, v: size };
          else if (t === cur.t) { cur.h = Math.max(cur.h, p); cur.l = Math.min(cur.l, p); cur.c = p; cur.v += size; } else return;
          onBar({ ...cur });
        },
        onStatus,
      });
      return () => { stopped = true; clearInterval(resync); stop(); };
    },
    async ticker(b, q) {
      const s = await get(this, `${this.rest}/products/${b}-${q}/stats`);
      return { c: +s.last, o: +s.open, vq: +s.volume * +s.last };
    },
  };

  // ---------------------------------------------------------------- OKX
  const OKX = {
    id: 'OKX', name: 'OKX', tag: 'OK', cors: true, rest: 'https://www.okx.com',
    // the "utc" bars start at midnight UTC (OKX's plain 1D starts at midnight Hong Kong time)
    tfs: { '1m': '1m', '3m': '3m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1H', '2h': '2H', '4h': '4H', '6h': '6Hutc', '12h': '12Hutc', '1d': '1Dutc', '1w': '1Wutc' },
    ok(j) { if (j.code !== '0') throw err(`OKX: ${j.msg || j.code}`, { fatal: j.code === '51001' || /exist|invalid/i.test(j.msg || '') }); return j.data; },
    async pairs() {
      return this.ok(await get(this, `${this.rest}/api/v5/public/instruments?instType=SPOT`)).filter((p) => p.state === 'live').map((p) => [p.baseCcy, p.quoteCcy]);
    },
    // [ts(ms), open, high, low, close, volume, …], newest first; the latest candles, then the archive (300 per request)
    history(b, q, tf, opts) {
      return pages(opts, 300, async (n, end) => {
        const url = end
          ? `${this.rest}/api/v5/market/history-candles?instId=${b}-${q}&bar=${this.tfs[tf]}&limit=${n}&after=${Math.floor(end) + 1}`
          : `${this.rest}/api/v5/market/candles?instId=${b}-${q}&bar=${this.tfs[tf]}&limit=${n}`;
        return this.ok(await get(this, url)).map((r) => ({ t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] }));
      });
    },
    stream(b, q, tf, onBar, onStatus) {
      const arg = { channel: 'candle' + this.tfs[tf], instId: `${b}-${q}` };
      return socket('wss://ws.okx.com/ws/v5/business', {
        onOpen: (send) => send({ op: 'subscribe', args: [arg] }),
        onMessage: (m) => {
          if (!m.arg || m.arg.channel !== arg.channel || m.arg.instId !== arg.instId || !m.data) return;
          for (const r of m.data) onBar({ t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] });
        },
        onStatus, ping: { every: 25000, msg: 'ping' },
      });
    },
    async ticker(b, q) {
      const t = this.ok(await get(this, `${this.rest}/api/v5/market/ticker?instId=${b}-${q}`))[0];
      return { c: +t.last, o: +t.open24h, vq: +t.volCcy24h };
    },
  };

  // ---------------------------------------------------------------- Gate.io
  const GATE = {
    id: 'GATE', name: 'Gate.io', tag: 'GT', cors: true, rest: 'https://api.gateio.ws',
    tfs: { '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1h', '4h': '4h', '1d': '1d' },
    async check(r) {
      if (r && !Array.isArray(r) && r.label) throw err(`Gate.io: ${r.message || r.label}`, { fatal: /INVALID|NOT_FOUND/.test(r.label) });
      return r;
    },
    async pairs() {
      const list = await this.check(await get(this, `${this.rest}/api/v4/spot/currency_pairs`));
      return list.filter((p) => p.trade_status === 'tradable').map((p) => [p.base, p.quote]);
    },
    // [time(s), quote volume, close, high, low, open, volume, closed], oldest first
    history(b, q, tf, opts) {
      return pages(opts, 1000, async (n, end) => {
        let url = `${this.rest}/api/v4/spot/candlesticks?currency_pair=${b}_${q}&interval=${this.tfs[tf]}&limit=${n}`;
        if (end) url += `&to=${Math.floor(end / 1000)}`;
        const rows = await this.check(await get(this, url));
        return rows.map((r) => ({ t: r[0] * 1000, o: +r[5], h: +r[3], l: +r[4], c: +r[2], v: +r[6] }));
      });
    },
    stream(b, q, tf, onBar, onStatus) {
      const name = `${this.tfs[tf]}_${b}_${q}`;
      const now = () => Math.floor(Date.now() / 1000);
      return socket('wss://api.gateio.ws/ws/v4/', {
        onOpen: (send) => send({ time: now(), channel: 'spot.candlesticks', event: 'subscribe', payload: [this.tfs[tf], `${b}_${q}`] }),
        onMessage: (m) => {
          const d = m.result;
          if (m.channel !== 'spot.candlesticks' || m.event !== 'update' || !d || d.n !== name) return;
          onBar({ t: d.t * 1000, o: +d.o, h: +d.h, l: +d.l, c: +d.c, v: +d.a });
        },
        onStatus, ping: { every: 20000, msg: { channel: 'spot.ping' } },
      });
    },
    async ticker(b, q) {
      const t = (await this.check(await get(this, `${this.rest}/api/v4/spot/tickers?currency_pair=${b}_${q}`)))[0];
      return { c: +t.last, o: +t.last / (1 + +t.change_percentage / 100), vq: +t.quote_volume };
    },
  };

  // ---------------------------------------------------------------- Bitget
  const BITGET = {
    id: 'BITGET', name: 'Bitget', tag: 'BG', cors: true, rest: 'https://api.bitget.com',
    // the "utc" candles start at midnight UTC
    tfs: { '1m': '1min', '5m': '5min', '15m': '15min', '30m': '30min', '1h': '1h', '4h': '4h', '6h': '6Hutc', '12h': '12Hutc', '1d': '1Dutc', '1w': '1Wutc' },
    ws: { '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1H', '4h': '4H', '6h': '6Hutc', '12h': '12Hutc', '1d': '1Dutc', '1w': '1Wutc' },
    ok(j) { if (j.code !== '00000') throw err(`Bitget: ${j.msg || j.code}`, { fatal: true }); return j.data; },
    async pairs() {
      return this.ok(await get(this, `${this.rest}/api/v2/spot/public/symbols`)).filter((p) => p.status === 'online').map((p) => [p.baseCoin, p.quoteCoin]);
    },
    // [ts(ms), open, high, low, close, volume, …], oldest first: up to 1000 recent candles, then 200 per request from the archive
    history(b, q, tf, opts) {
      return pages(opts, (end) => (end ? 200 : 1000), async (n, end) => {
        const url = end
          // (the archive leaves out the candle that endTime falls in, so point just past it)
          ? `${this.rest}/api/v2/spot/market/history-candles?symbol=${b}${q}&granularity=${this.tfs[tf]}&limit=${n}&endTime=${bucketOf(end, tf) + TF[tf]}`
          : `${this.rest}/api/v2/spot/market/candles?symbol=${b}${q}&granularity=${this.tfs[tf]}&limit=${n}`;
        return this.ok(await get(this, url)).map((r) => ({ t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] }));
      });
    },
    stream(b, q, tf, onBar, onStatus) {
      const arg = { instType: 'SPOT', channel: 'candle' + this.ws[tf], instId: b + q };
      return socket('wss://ws.bitget.com/v2/ws/public', {
        onOpen: (send) => send({ op: 'subscribe', args: [arg] }),
        onMessage: (m) => {
          if (!m.arg || m.arg.channel !== arg.channel || m.arg.instId !== arg.instId || !Array.isArray(m.data)) return;
          // the first message holds many past candles; the chart already has them
          const rows = m.action === 'snapshot' ? m.data.slice().sort((x, y) => x[0] - y[0]).slice(-2) : m.data;
          for (const r of rows) onBar({ t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] });
        },
        onStatus, ping: { every: 25000, msg: 'ping' },
      });
    },
    async ticker(b, q) {
      const t = this.ok(await get(this, `${this.rest}/api/v2/spot/market/tickers?symbol=${b}${q}`))[0];
      return { c: +t.lastPr, o: +t.open, vq: +t.quoteVolume };
    },
  };

  // ---------------------------------------------------------------- MEXC
  // Its live feed needs a binary decoder, so Candela refreshes the latest candles every 3 seconds instead.
  const MEXC = {
    id: 'MEXC', name: 'MEXC', tag: 'MX', cors: false, rest: 'https://api.mexc.com',
    tfs: { '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '60m', '4h': '4h', '1d': '1d', '1w': '1W' },
    async pairs() {
      const j = await get(this, `${this.rest}/api/v3/exchangeInfo`);
      return (j.symbols || []).filter((p) => p.status === '1' && p.isSpotTradingAllowed !== false).map((p) => [p.baseAsset, p.quoteAsset]);
    },
    // like Binance: [open time, open, high, low, close, volume, …], oldest first, 500 per request.
    // Older candles need both startTime and endTime.
    history(b, q, tf, opts) {
      return pages(opts, 500, async (n, end) => {
        let url = `${this.rest}/api/v3/klines?symbol=${b}${q}&interval=${this.tfs[tf]}&limit=${n}`;
        if (end) url += `&startTime=${Math.floor(end - n * TF[tf]) + 1}&endTime=${Math.floor(end)}`;
        const rows = await get(this, url);
        if (!Array.isArray(rows)) throw err(`MEXC: ${rows.msg || 'unexpected reply'}`, { fatal: true });
        return rows.map((r) => ({ t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] }));
      });
    },
    stream(b, q, tf, onBar, onStatus) { return poller(this, b, q, tf, onBar, onStatus, 3000); },
    async ticker(b, q) {
      const t = await get(this, `${this.rest}/api/v3/ticker/24hr?symbol=${b}${q}`);
      return { c: +t.lastPrice, o: +t.openPrice, vq: +t.quoteVolume };
    },
  };

  // ---------------------------------------------------------------- HTX (Huobi)
  const HTX = {
    id: 'HTX', name: 'HTX', tag: 'HX', cors: true, rest: 'https://api.huobi.pro',
    // HTX's own daily and weekly candles start at midnight in Singapore (16:00 UTC), so Candela builds
    // UTC days and Monday weeks from its 4-hour candles instead
    tfs: { '1m': '1min', '5m': '5min', '15m': '15min', '30m': '30min', '1h': '60min', '4h': '4hour' },
    historyNote: 'HTX only provides the latest 2,000 candles for each timeframe (daily and weekly charts are built from 4-hour candles: about 330 days).',
    ok(j) { if (j.status !== 'ok') throw err(`HTX: ${j['err-msg'] || j['err-code'] || 'error'}`, { fatal: /symbol|invalid/i.test(j['err-msg'] || '') }); return j; },
    async pairs() {
      const j = this.ok(await get(this, `${this.rest}/v1/common/symbols`));
      return j.data.filter((p) => p.state === 'online').map((p) => [p['base-currency'], p['quote-currency']]);
    },
    async history(b, q, tf, { limit = 1000, endTime } = {}) {
      if (endTime) return []; // no older history on HTX
      const j = this.ok(await get(this, `${this.rest}/market/history/kline?symbol=${(b + q).toLowerCase()}&period=${this.tfs[tf]}&size=${Math.min(2000, limit)}`));
      // { id (s), open, close, low, high, amount (volume), vol (quote volume) }, newest first
      return sortAsc(j.data.map((d) => ({ t: d.id * 1000, o: d.open, h: d.high, l: d.low, c: d.close, v: d.amount })));
    },
    stream(b, q, tf, onBar, onStatus) {
      const ch = `market.${(b + q).toLowerCase()}.kline.${this.tfs[tf]}`;
      return socket('wss://api.huobi.pro/ws', {
        gzip: true,
        answer: (m) => (m.ping ? { pong: m.ping } : null),
        onOpen: (send) => send({ sub: ch, id: 'candela' }),
        onMessage: (m) => { const d = m.tick; if (m.ch === ch && d) onBar({ t: d.id * 1000, o: d.open, h: d.high, l: d.low, c: d.close, v: d.amount }); },
        onStatus,
      });
    },
    async ticker(b, q) {
      const t = this.ok(await get(this, `${this.rest}/market/detail?symbol=${(b + q).toLowerCase()}`)).tick;
      return { c: t.close, o: t.open, vq: t.vol };
    },
  };

  // ---------------------------------------------------------------- Bitfinex
  // Bitfinex has its own short names for some coins (UST is Tether's USDT, UDC is USDC…)
  const BFX_NAMES = { UST: 'USDT', UDC: 'USDC', ALG: 'ALGO', DSH: 'DASH', IOT: 'IOTA', OPX: 'OP', WBT: 'WBTC' };
  const BFX_CODES = Object.fromEntries(Object.entries(BFX_NAMES).map(([k, v]) => [v, k]));
  const bfxPair = (b, q) => {
    const B = BFX_CODES[b] || b, Q = BFX_CODES[q] || q;
    return B.length > 3 || Q.length > 3 ? `${B}:${Q}` : B + Q; // "BTCUSD", "AVAX:UST"
  };
  const BITFINEX = {
    id: 'BITFINEX', name: 'Bitfinex', tag: 'BF', cors: false, rest: 'https://api-pub.bitfinex.com', quotes: ['USD', 'USDT', 'USDC', 'EUR'],
    tfs: { '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1h', '6h': '6h', '12h': '12h', '1d': '1D', '1w': '1W' },
    async pairs() {
      const [list] = await get(this, `${this.rest}/v2/conf/pub:list:pair:exchange`);
      return list.filter((p) => !/^TEST/.test(p)).map((p) => {
        const [b, q] = p.includes(':') ? p.split(':') : [p.slice(0, 3), p.slice(3)];
        return [BFX_NAMES[b] || b, BFX_NAMES[q] || q];
      });
    },
    // [time(ms), open, close, high, low, volume], newest first; up to 10,000 per request
    history(b, q, tf, opts) {
      return pages(opts, 10000, async (n, end) => {
        let url = `${this.rest}/v2/candles/trade:${this.tfs[tf]}:t${bfxPair(b, q)}/hist?limit=${n}&sort=-1`;
        if (end) url += `&end=${Math.floor(end)}`;
        const rows = await get(this, url);
        if (!Array.isArray(rows) || rows[0] === 'error') throw err(`Bitfinex: ${rows[2] || 'unexpected reply'}`);
        return rows.map((r) => ({ t: r[0], o: r[1], h: r[3], l: r[4], c: r[2], v: r[5] }));
      });
    },
    stream(b, q, tf, onBar, onStatus) {
      const key = `trade:${this.tfs[tf]}:t${bfxPair(b, q)}`;
      let chan = null;
      const bar = (r) => ({ t: r[0], o: r[1], h: r[3], l: r[4], c: r[2], v: r[5] });
      return socket('wss://api-pub.bitfinex.com/ws/2', {
        onOpen: (send) => { chan = null; send({ event: 'subscribe', channel: 'candles', key }); },
        onMessage: (m) => {
          if (!Array.isArray(m)) { if (m.event === 'subscribed' && m.key === key) chan = m.chanId; return; }
          if (m[0] !== chan || !Array.isArray(m[1])) return; // heartbeats are "hb"
          if (Array.isArray(m[1][0])) { for (const r of m[1].slice().sort((x, y) => x[0] - y[0]).slice(-2)) onBar(bar(r)); } // first message: past candles
          else onBar(bar(m[1]));
        },
        onStatus, ping: { every: 20000, msg: { event: 'ping', cid: 1 } },
      });
    },
    async ticker(b, q) {
      const t = await get(this, `${this.rest}/v2/ticker/t${bfxPair(b, q)}`);
      if (!Array.isArray(t) || t[0] === 'error') throw err('Bitfinex: no price');
      return { c: t[6], o: t[6] - t[4], vq: t[7] * t[6] };
    },
  };

  // ---------------------------------------------------------------- Hyperliquid
  // One POST endpoint for everything ({ type: … }); candles go back 5,000 candles per timeframe. Perpetuals are
  // the main market, plus the HIP-3 markets other teams run on it (stock, index and commodity perps such as
  // xyz:TSLA, written XYZ.TSLA here), and spot (HYPE/USDC…). Coin names in the API differ from what we show
  // (kPEPE, xyz:TSLA, @107 for a spot pair), so each adapter keeps a map.
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  async function hlPost(ex, body, tries = 0) {
    const r = await fetch('https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (r.status === 403 || r.status === 451) throw err(`Hyperliquid refused the request (HTTP ${r.status}).`, { fatal: true, geo: true });
    // a request budget per minute: wait and try again (1.5 s, 3 s, 6 s)
    if (r.status === 429) {
      if (tries < 3) { await sleep(1500 * 2 ** tries); return hlPost(ex, body, tries + 1); }
      throw err('Hyperliquid: too many requests, try again in a moment');
    }
    const j = await r.json().catch(() => undefined);
    if (j === undefined || !r.ok) throw err(`Hyperliquid: HTTP ${r.status}`);
    return j;
  }
  let hlSpotMeta = null; // shared by the spot list and the perps' collateral names
  const spotMeta = (ex) => (hlSpotMeta = hlSpotMeta || hlPost(ex, { type: 'spotMeta' }).catch((e) => { hlSpotMeta = null; throw e; }));
  function hyperliquid(spot) {
    return {
      id: spot ? 'HYPERLIQUIDS' : 'HYPERLIQUID', name: spot ? 'Hyperliquid Spot' : 'Hyperliquid', short: spot ? 'Hyperliquid spot' : 'Hyperliquid perp',
      tag: spot ? 'HLS' : 'HL', futures: !spot, cors: true, quotes: ['USDC', 'USDT0', 'USDH', 'USDE'],
      tfs: Object.fromEntries(['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '8h', '12h', '1d', '3d', '1w', '1M'].map((x) => [x, x])),
      coins: null, // "BTC/USDC" -> API coin name
      dexes: null, // HIP-3 market names: ['xyz', 'flx', …]
      async pairs() {
        const out = [], coins = {};
        if (spot) {
          const m = await spotMeta(this), names = Object.fromEntries(m.tokens.map((t) => [t.index, t.name]));
          for (const u of m.universe) {
            const b = String(names[u.tokens[0]] || '').toUpperCase(), q = String(names[u.tokens[1]] || '').toUpperCase();
            if (!b || !q || coins[`${b}/${q}`]) continue;
            coins[`${b}/${q}`] = u.name;
            out.push([b, q]);
          }
        } else {
          const dexes = ((await hlPost(this, { type: 'perpDexs' })) || []).filter(Boolean).map((d) => d.name);
          this.dexes = dexes;
          const tokenNames = await spotMeta(this).then((m) => Object.fromEntries(m.tokens.map((t) => [t.index, t.name])), () => ({}));
          const metas = await Promise.all([null, ...dexes].map((dex) => hlPost(this, dex ? { type: 'meta', dex } : { type: 'meta' }).catch(() => null)));
          metas.forEach((m, i) => {
            if (!m || !m.universe) return;
            const q = i && m.collateralToken != null && tokenNames[m.collateralToken] ? String(tokenNames[m.collateralToken]).toUpperCase() : 'USDC';
            for (const u of m.universe) {
              if (u.isDelisted) continue;
              const b = u.name.toUpperCase().replace(':', '.'); // kPEPE -> KPEPE, xyz:TSLA -> XYZ.TSLA
              coins[`${b}/${q}`] = u.name;
              out.push([b, q, u.name.includes(':') ? u.name.split(':')[1] : /^k[A-Z]/.test(u.name) ? u.name.slice(1) : null]); // found as TSLA, PEPE
            }
          });
        }
        this.coins = coins;
        return out;
      },
      async coin(b, q) {
        if (!this.coins) { try { await pairs(this.id); } catch (e) { /* guess below */ } }
        const c = this.coins && this.coins[`${b}/${q}`];
        if (c) return c;
        if (spot || this.coins) throw err(`Hyperliquid has no ${b}/${q}${spot ? ' spot' : ''} market`, { fatal: true });
        return b.includes('.') ? b.replace('.', ':').replace(/^[^:]+/, (d) => d.toLowerCase()) : b;
      },
      history(b, q, tf, opts) {
        return pages(opts, 5000, async (n, end) => {
          const coin = await this.coin(b, q), endT = end || Date.now();
          const rows = await hlPost(this, { type: 'candleSnapshot', req: { coin, interval: tf, startTime: Math.floor(endT - n * TF[tf]), endTime: Math.floor(endT) } });
          if (rows === null) throw err(`Hyperliquid has no ${b}/${q} market`, { fatal: true });
          return (rows || []).map((r) => ({ t: r.t, o: +r.o, h: +r.h, l: +r.l, c: +r.c, v: +r.v }));
        });
      },
      stream(b, q, tf, onBar, onStatus) {
        return liveOrPoll(this, b, q, tf, onBar, onStatus, (bar, status) => {
          let stop = null, stopped = false;
          this.coin(b, q).then((coin) => {
            if (stopped) return;
            stop = socket('wss://api.hyperliquid.xyz/ws', {
              onOpen: (send) => send({ method: 'subscribe', subscription: { type: 'candle', coin, interval: tf } }),
              onMessage: (m) => { const d = m.data; if (m.channel === 'candle' && d && d.s === coin && d.i === tf) bar({ t: d.t, o: +d.o, h: +d.h, l: +d.l, c: +d.c, v: +d.v }); },
              onStatus: status, ping: { every: 30000, msg: { method: 'ping' } },
            });
          }, () => status && status('reconnecting'));
          return () => { stopped = true; if (stop) stop(); };
        });
      },
      // ---- live order book and trades (one WebSocket each; reconnects by itself)
      // onBook({ bids: [[px, sz, n]…], asks: […], t }) with up to 20 levels a side, grouped to `sigFigs`
      // significant figures (2–5; 5 = no grouping), optionally `mantissa` 2 or 5 at 5 figures
      book(b, q, { sigFigs = 5, mantissa = null } = {}, onBook, onStatus) {
        let stop = null, stopped = false;
        this.coin(b, q).then((coin) => {
          if (stopped) return;
          const sub = { type: 'l2Book', coin, nSigFigs: sigFigs };
          if (sigFigs === 5 && mantissa) sub.mantissa = mantissa;
          const lv = (arr) => (arr || []).map((x) => [+x.px, +x.sz, x.n]);
          stop = socket('wss://api.hyperliquid.xyz/ws', {
            onOpen: (send) => send({ method: 'subscribe', subscription: sub }),
            onMessage: (m) => { if (m.channel === 'l2Book' && m.data && m.data.coin === coin) onBook({ bids: lv(m.data.levels[0]), asks: lv(m.data.levels[1]), t: m.data.time }); },
            onStatus, ping: { every: 30000, msg: { method: 'ping' } },
          });
        }, (e) => onStatus && onStatus('error', e.message));
        return () => { stopped = true; if (stop) stop(); };
      },
      // onTrades([{ t, px, sz, buy }]) newest last; the first call has the recent trades
      trades(b, q, onTrades, onStatus) {
        let stop = null, stopped = false;
        this.coin(b, q).then(async (coin) => {
          if (stopped) return;
          const map = (x) => ({ t: x.time, px: +x.px, sz: +x.sz, buy: x.side === 'B', id: x.tid });
          try { const r = await hlPost(this, { type: 'recentTrades', coin }); if (!stopped && Array.isArray(r)) onTrades(r.map(map).sort((a, c) => a.t - c.t)); } catch (e) { /* the stream still comes */ }
          if (stopped) return;
          stop = socket('wss://api.hyperliquid.xyz/ws', {
            onOpen: (send) => send({ method: 'subscribe', subscription: { type: 'trades', coin } }),
            onMessage: (m) => { if (m.channel === 'trades' && Array.isArray(m.data)) onTrades(m.data.filter((x) => x.coin === coin).map(map)); },
            onStatus, ping: { every: 30000, msg: { method: 'ping' } },
          });
        }, (e) => onStatus && onStatus('error', e.message));
        return () => { stopped = true; if (stop) stop(); };
      },
      // every market's prices come in one reply; keep it a few seconds for watchlists with many symbols
      ctxCache: {},
      async contexts(dex) {
        const k = dex || '', c = this.ctxCache[k];
        if (c && Date.now() - c.t < 3000) return c.p;
        const p = hlPost(this, spot ? { type: 'spotMetaAndAssetCtxs' } : dex ? { type: 'metaAndAssetCtxs', dex } : { type: 'metaAndAssetCtxs' }).then(([meta, ctxs]) => {
          const by = {};
          if (spot) for (const x of ctxs) by[x.coin] = x;
          else meta.universe.forEach((u, i) => { by[u.name] = ctxs[i]; });
          return by;
        });
        this.ctxCache[k] = { t: Date.now(), p };
        p.catch(() => { delete this.ctxCache[k]; });
        return p;
      },
      async ticker(b, q) {
        const coin = await this.coin(b, q), dex = !spot && coin.includes(':') ? coin.split(':')[0] : null;
        const x = (await this.contexts(dex))[coin];
        if (!x) throw err(`Hyperliquid: no price for ${b}/${q}`);
        const c = +(x.midPx || x.markPx), t = { c, o: +x.prevDayPx || c, vq: +x.dayNtlVlm };
        if (!spot) {
          // funding is paid every hour on Hyperliquid
          const hr = 3600e3;
          Object.assign(t, { funding: +x.funding, fundingHours: 1, nextFunding: Math.ceil(Date.now() / hr) * hr, mark: +x.markPx, index: +x.oraclePx, oiValue: +x.openInterest * +x.markPx });
        }
        return t;
      },
    };
  }
  const HYPERLIQUID = hyperliquid(false);
  const HYPERLIQUIDS = hyperliquid(true);

  const EXCHANGES = { BYBIT, OKX, BITGET, KUCOIN, GATE, MEXC, HTX, KRAKEN, COINBASE, BITFINEX, BINANCEF, BYBITF, HYPERLIQUID, HYPERLIQUIDS };
  const ID_RE = /^(BYBIT|OKX|BITGET|KUCOIN|GATE|MEXC|HTX|KRAKEN|COINBASE|BITFINEX|BINANCEF|BYBITF|HYPERLIQUID|HYPERLIQUIDS):([A-Z0-9.]+)\/([A-Z0-9.]+)$/;
  function parse(sym) {
    const m = ID_RE.exec(sym || '');
    return m ? { ex: EXCHANGES[m[1]], b: m[2], q: m[3] } : null;
  }

  // Timeframes an exchange doesn't offer are built from smaller candles by data.js (history / stream).
  const bucketOf = MD.bucketOf;

  // ---------------------------------------------------------------- symbol lists & search
  const lists = {};
  function pairs(exId) {
    if (!lists[exId]) {
      lists[exId] = EXCHANGES[exId].pairs().then((ps) => {
        const seen = new Set(), out = [];
        for (const [b, q, alias] of ps) {
          const B = String(b).toUpperCase(), Q = String(q).toUpperCase(), id = `${exId}:${B}/${Q}`;
          if (!/^[A-Z0-9.]+$/.test(B) || !/^[A-Z0-9.]+$/.test(Q) || seen.has(id)) continue;
          seen.add(id);
          out.push({ id, base: B, quote: Q, key: B + Q, alt: alias ? String(alias).toUpperCase() : B.replace(/^\d+/, '') }); // alt: PEPE for futures' 1000PEPE (or the exchange's own alias)
        }
        return out;
      }).catch((e) => {
        // blocked here (country, or no server for KuCoin): don't ask again for a while
        setTimeout(() => { delete lists[exId]; }, e.geo || e.needsServer ? 10 * 60e3 : 0);
        throw e;
      });
    }
    return lists[exId];
  }
  // the usual quote currencies first: US dollar on Kraken and Coinbase, USDT elsewhere
  const QUOTE_RANK = ['USDT', 'USD', 'USDC', 'EUR', 'BTC', 'ETH'];
  function searchPairs(list, query) {
    const ex = list.length ? EXCHANGES[list[0].id.split(':')[0]] : null;
    const order = ex && ex.quotes ? [...ex.quotes, 'BTC', 'ETH'] : QUOTE_RANK;
    const qrank = (x) => { const i = order.indexOf(x); return i < 0 ? 99 : i; };
    const q = String(query || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const hits = q ? list.filter((p) => p.key.startsWith(q) || p.base === q || (p.alt !== p.base && p.alt.startsWith(q))) : list.filter((p) => qrank(p.quote) < 3);
    return hits.sort((a, b) => (b.base === q) - (a.base === q) || qrank(a.quote) - qrank(b.quote) || a.key.length - b.key.length || a.key.localeCompare(b.key));
  }

  // ---------------------------------------------------------------- the same coin on every exchange
  // Binance symbols carry no separator, so split them by known quote currencies.
  const BINANCE_QUOTES = ['FDUSD', 'USDT', 'USDC', 'TUSD', 'BUSD', 'USDP', 'AEUR', 'DAI', 'USD', 'EUR', 'TRY', 'BRL', 'JPY', 'GBP', 'AUD', 'BIDR', 'IDR', 'UAH', 'ARS', 'ZAR', 'PLN', 'RON', 'MXN', 'COP', 'CZK', 'BTC', 'ETH', 'BNB', 'SOL', 'XRP', 'DOGE', 'TRX'];
  function splitBinance(sym) {
    for (const q of BINANCE_QUOTES) if (sym.endsWith(q) && sym.length > q.length) return { base: sym.slice(0, -q.length), quote: q };
    return null;
  }
  // base and quote of any crypto symbol (Binance or another exchange), or null for stocks, CSV, demo…
  function baseQuote(sym) {
    const s = parse(sym);
    if (s) return { base: s.b, quote: s.q };
    if (MD.isStock(sym) || MD.isBStock(sym) || /^(CSV:|DEMO)/.test(sym)) return null;
    return splitBinance(sym);
  }
  async function binanceTicker(sym) {
    const r = await MD.tickers24([sym]);
    if (!r.length) throw err('No price');
    return { c: r[0].c, o: r[0].o, vq: r[0].vq };
  }
  // For one coin: the best matching pair on each exchange (same quote if possible, else USDT/USD/USDC).
  async function samePairs(base, quote) {
    const prefs = [quote, 'USDT', 'USD', 'USDC'].filter((x, i, a) => x && a.indexOf(x) === i);
    const out = [];
    let binance = [];
    try { binance = await MD.allSymbols(); } catch (e) { /* offline */ }
    // (Binance's few …USD pairs are leftovers that barely trade)
    const bq = prefs.filter((q) => q !== 'USD').concat('FDUSD').find((q) => binance.includes(base + q));
    out.push({ ex: 'BINANCE', name: 'Binance', id: bq ? base + bq : null, quote: bq || null });
    await Promise.all(Object.keys(EXCHANGES).map(async (exId) => {
      let list = null, problem = null;
      try { list = await pairs(exId); } catch (e) { problem = e; }
      const p = list && prefs.map((q) => list.find((x) => x.base === base && x.quote === q)).find(Boolean);
      out.push({ ex: exId, name: EXCHANGES[exId].short || EXCHANGES[exId].name, id: p ? p.id : null, quote: p ? p.quote : null, problem });
    }));
    const order = ['BINANCE', ...Object.keys(EXCHANGES)];
    return out.sort((a, b) => order.indexOf(a.ex) - order.indexOf(b.ex));
  }
  function ticker(sym) {
    const s = parse(sym);
    return s ? s.ex.ticker(s.b, s.q) : binanceTicker(sym);
  }

  const exchangeOf = (sym) => { const s = parse(sym); return s ? s.ex : null; };
  // "BTC/USD"; perpetual futures: "BTC/USDT PERP"
  const exDisplay = (sym) => { const s = parse(sym); return s ? `${s.b}/${s.q}${s.ex.futures ? ' PERP' : ''}` : null; };
  // name for messages and lists: "BTC/USD (Kraken)", "NVDAB", "AAPL", "BTCUSDT"
  function displayName(sym) {
    const s = parse(sym);
    if (s) return `${exDisplay(sym)} (${s.ex.name})`;
    if (MD.isBStock && MD.isBStock(sym)) return sym.replace(/USDT$/, '');
    return sym.replace(/^(CSV|TD):/, '').replace(/@.*$/, '');
  }
  const setProxy = (base, token = '') => { proxyBase = base; proxyToken = token; };


  // ---------------------------------------------------------------- order books and trades (Binance, Bybit)
  // A book is kept as two price → size maps, built from a snapshot and live changes, and handed out grouped:
  // the price step is the mid price rounded to `sigFigs` significant figures (× `mantissa`), as on Hyperliquid.
  const newBook = () => ({ bids: new Map(), asks: new Map() });
  function setLevels(map, levels) { for (const [p, q] of levels) { const px = +p, sz = +q; if (sz > 0) map.set(px, sz); else map.delete(px); } }
  function groupedBook(st, { sigFigs = 5, mantissa = null } = {}, n = 20) {
    const bids = [...st.bids.entries()].sort((x, y) => y[0] - x[0]), asks = [...st.asks.entries()].sort((x, y) => x[0] - y[0]);
    if (!bids.length || !asks.length) return null;
    const mid = (bids[0][0] + asks[0][0]) / 2, tick = Math.pow(10, Math.floor(Math.log10(mid)) - sigFigs + 1) * (sigFigs === 5 && mantissa ? mantissa : 1);
    const group = (list, down) => {
      const out = [];
      for (const [px, sz] of list) {
        const k = +((down ? Math.floor(px / tick + 1e-9) : Math.ceil(px / tick - 1e-9)) * tick).toPrecision(12), last = out[out.length - 1];
        if (last && last[0] === k) { last[1] += sz; last[2]++; continue; }
        if (out.length >= n) break;
        out.push([k, sz, 1]);
      }
      return out;
    };
    return { bids: group(bids, true), asks: group(asks, false), t: Date.now() };
  }
  // hand the grouped book out at most 5 times a second
  function bookEmitter(st, opts, onBook) {
    let timer = null;
    return {
      emit() { if (!timer) timer = setTimeout(() => { timer = null; const g = groupedBook(st, opts); if (g) onBook(g); }, 200); },
      stop() { clearTimeout(timer); },
    };
  }

  // Binance (spot and USDⓈ-M futures): a 1,000-level snapshot plus the change stream, checked for gaps
  // (a gap means a new snapshot). Where the snapshot is blocked, the 20-level stream is used instead.
  function binanceBook({ wsDiff, wsTop, snapshot, futures, name }, opts, onBook, onStatus) {
    const st = newBook(), out = bookEmitter(st, opts, onBook);
    let stopped = false, ready = false, synced = false, lastU = 0, buffer = [], stopWs = null, loading = false;
    const apply = (ev) => {
      if (ev.u <= lastU) return true;
      const ok = synced ? (futures ? ev.pu === lastU : ev.U === lastU + 1) : futures ? ev.U <= lastU && ev.u >= lastU : ev.U <= lastU + 1 && ev.u >= lastU + 1;
      if (!ok) return false;
      setLevels(st.bids, ev.b);
      setLevels(st.asks, ev.a);
      lastU = ev.u;
      synced = true;
      return true;
    };
    const resync = async () => {
      if (loading || stopped) return;
      loading = true; ready = false; synced = false;
      try {
        const snap = await snapshot();
        if (stopped) return;
        st.bids.clear(); st.asks.clear();
        setLevels(st.bids, snap.bids); setLevels(st.asks, snap.asks);
        lastU = snap.lastUpdateId;
        ready = true;
        const queued = buffer; buffer = [];
        for (const ev of queued) if (!apply(ev)) { loading = false; return resync(); }
        out.emit();
      } catch (e) {
        if (stopped) return;
        // no snapshot here (blocked, or a web page without Candela's server): the top 20 levels, refreshed by the exchange
        if (stopWs) stopWs();
        stopWs = socket(wsTop, {
          onOpen: () => {},
          onMessage: (m) => { const b = m.bids || m.b, a = m.asks || m.a; if (!b || !a) return; st.bids.clear(); st.asks.clear(); setLevels(st.bids, b); setLevels(st.asks, a); out.emit(); },
          onStatus,
        });
      } finally { loading = false; }
    };
    stopWs = socket(wsDiff, {
      onOpen: () => { synced = false; buffer = []; resync(); },
      onMessage: (ev) => {
        if (ev.e !== 'depthUpdate') return;
        if (!ready) { buffer.push(ev); if (buffer.length > 500) buffer.shift(); return; }
        if (!apply(ev)) { buffer = [ev]; resync(); return; }
        out.emit();
      },
      onStatus,
    });
    void name;
    return () => { stopped = true; out.stop(); if (stopWs) stopWs(); };
  }
  // Binance trades: the latest ones first, then each one live (aggregated: one row per taker order and price)
  function binanceTrades({ ws, recent }, onTrades, onStatus) {
    let stopped = false, stop = null;
    const row = (x) => ({ t: x.T, px: +x.p, sz: +x.q, buy: !x.m, id: x.a });
    recent().then((r) => { if (!stopped && Array.isArray(r)) onTrades(r.map(row)); }, () => {});
    stop = socket(ws, { onOpen: () => {}, onMessage: (m) => { if (m.e === 'aggTrade') onTrades([row(m)]); }, onStatus });
    return () => { stopped = true; stop(); };
  }
  const BV_REST = 'https://data-api.binance.vision', BV_WS = 'wss://data-stream.binance.vision/ws/';
  const binanceSpotFlow = (sym) => ({
    book: (opts, onBook, onStatus) => binanceBook({
      wsDiff: `${BV_WS}${sym.toLowerCase()}@depth@100ms`, wsTop: `${BV_WS}${sym.toLowerCase()}@depth20@100ms`,
      snapshot: () => get({ name: 'Binance', cors: true }, `${BV_REST}/api/v3/depth?symbol=${sym}&limit=1000`), futures: false,
    }, opts, onBook, onStatus),
    trades: (onTrades, onStatus) => binanceTrades({ ws: `${BV_WS}${sym.toLowerCase()}@aggTrade`, recent: () => get({ name: 'Binance', cors: true }, `${BV_REST}/api/v3/aggTrades?symbol=${sym}&limit=100`) }, onTrades, onStatus),
  });
  // Bybit (spot and perpetuals): a 200-level snapshot, then changes, on one WebSocket
  function bybitBook(ex, b, q, opts, onBook, onStatus) {
    const st = newBook(), out = bookEmitter(st, opts, onBook);
    let stop = null, stopped = false;
    ex.symbol(b, q).then((name) => {
      if (stopped) return;
      const topic = `orderbook.200.${name}`;
      stop = socket(`wss://stream.bybit.com/v5/public/${ex.futures ? 'linear' : 'spot'}`, {
        onOpen: (send) => send({ op: 'subscribe', args: [topic] }),
        onMessage: (m) => {
          if (m.topic !== topic || !m.data) return;
          if (m.type === 'snapshot') { st.bids.clear(); st.asks.clear(); }
          setLevels(st.bids, m.data.b || []);
          setLevels(st.asks, m.data.a || []);
          out.emit();
        },
        onStatus, ping: { every: 20000, msg: { op: 'ping' } },
      });
    });
    return () => { stopped = true; out.stop(); if (stop) stop(); };
  }
  function bybitTrades(ex, b, q, onTrades, onStatus) {
    let stop = null, stopped = false;
    const cat = ex.futures ? 'linear' : 'spot', row = (x) => ({ t: +(x.T || x.time), px: +(x.p || x.price), sz: +(x.v || x.size), buy: (x.S || x.side) === 'Buy', id: x.i || x.execId });
    ex.symbol(b, q).then(async (name) => {
      if (stopped) return;
      try { const j = await get(ex, `${ex.rest}/v5/market/recent-trade?category=${cat}&symbol=${name}&limit=100`); if (!stopped && j.retCode === 0) onTrades((j.result.list || []).map(row).sort((x, y) => x.t - y.t)); } catch (e) { /* the stream still comes */ }
      if (stopped) return;
      const topic = `publicTrade.${name}`;
      stop = socket(`wss://stream.bybit.com/v5/public/${cat}`, {
        onOpen: (send) => send({ op: 'subscribe', args: [topic] }),
        onMessage: (m) => { if (m.topic === topic && Array.isArray(m.data)) onTrades(m.data.map(row)); },
        onStatus, ping: { every: 20000, msg: { op: 'ping' } },
      });
    });
    return () => { stopped = true; if (stop) stop(); };
  }
  for (const ex of [BYBIT, BYBITF]) {
    ex.book = (b, q, opts, onBook, onStatus) => bybitBook(ex, b, q, opts, onBook, onStatus);
    ex.trades = (b, q, onTrades, onStatus) => bybitTrades(ex, b, q, onTrades, onStatus);
  }
  BINANCEF.book = (b, q, opts, onBook, onStatus) => binanceBook({
    wsDiff: `wss://fstream.binance.com/public/ws/${(b + q).toLowerCase()}@depth@100ms`, wsTop: `wss://fstream.binance.com/public/ws/${(b + q).toLowerCase()}@depth20@100ms`,
    snapshot: () => get(BINANCEF, `${BINANCEF.rest}/fapi/v1/depth?symbol=${b}${q}&limit=1000`), futures: true,
  }, opts, onBook, onStatus);
  BINANCEF.trades = (b, q, onTrades, onStatus) => binanceTrades({
    ws: `wss://fstream.binance.com/market/ws/${(b + q).toLowerCase()}@aggTrade`, recent: () => get(BINANCEF, `${BINANCEF.rest}/fapi/v1/aggTrades?symbol=${b}${q}&limit=100`),
  }, onTrades, onStatus);
  // the order book and trades of any symbol that has them: { unit, book(opts, onBook, onStatus), trades(onTrades, onStatus) }
  function flowFor(sym) {
    const s = parse(sym);
    if (s) return s.ex.book && s.ex.trades ? { unit: s.b.replace(/^[A-Z]+\./, ''), book: (o, cb, st) => s.ex.book(s.b, s.q, o, cb, st), trades: (cb, st) => s.ex.trades(s.b, s.q, cb, st) } : null;
    if (MD.isStock(sym) || /^(CSV:|DEMO)/.test(sym || '')) return null;
    const bq = splitBinance(sym);
    return bq ? { unit: bq.base, ...binanceSpotFlow(sym) } : null;
  }

  // for other modules (derivatives data): a GET with the same CORS fallback, and Hyperliquid's info endpoint
  const getJSON = (url, name, cors = 'unknown') => get({ name, cors }, url);
  const hlInfo = (body) => hlPost(HYPERLIQUID, body);
  Object.assign(MD, { flowFor, EXCHANGES, exchangeOf, exDisplay, displayName, exPairs: pairs, searchPairs, samePairs, baseQuote, ticker, setProxy, getJSON, hlInfo, exSocket: socket });
  MD.registerSource((sym) => !!parse(sym), {
    tfs: (sym) => Object.keys(parse(sym).ex.tfs),
    history: (sym, tf, opts) => { const s = parse(sym); return s.ex.history(s.b, s.q, tf, opts); },
    stream: (sym, tf, onBar, onStatus) => { const s = parse(sym); return s.ex.stream(s.b, s.q, tf, onBar, onStatus); },
  });
})(typeof window !== 'undefined' ? window : globalThis);
