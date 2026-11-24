/* Candela — more crypto exchanges: Bybit, OKX, Bitget, KuCoin, Gate.io, MEXC, Kraken and Coinbase (Binance lives in data.js).
 *
 * Symbols are written EXCHANGE:BASE/QUOTE, e.g. "KRAKEN:BTC/USD", "KUCOIN:ETH/USDT". Every exchange gets
 * the same five operations: symbol list, candle history, live updates, a 24-hour ticker, and the candle
 * intervals it offers. Timeframes an exchange lacks (Coinbase has no 4H, Kraken no 2H…) are built from
 * smaller candles, so every exchange supports every timeframe.
 *
 * Browser access: most exchanges allow web pages to call them. KuCoin and MEXC don't, so they go through
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
  function socket(url, { onOpen, onMessage, onStatus, ping }) {
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
      ws.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch (e) { return; } onMessage(m); };
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
  const BYBIT = {
    id: 'BYBIT', name: 'Bybit', tag: 'BY', cors: 'unknown', rest: 'https://api.bybit.com',
    tfs: { '1m': '1', '3m': '3', '5m': '5', '15m': '15', '30m': '30', '1h': '60', '2h': '120', '4h': '240', '6h': '360', '12h': '720', '1d': 'D', '1w': 'W' },
    async pairs() {
      const j = await get(this, `${this.rest}/v5/market/instruments-info?category=spot`);
      return (j.result.list || []).filter((s) => s.status === 'Trading').map((s) => [s.baseCoin, s.quoteCoin]);
    },
    history(b, q, tf, opts) {
      return pages(opts, 1000, async (n, end) => {
        let url = `${this.rest}/v5/market/kline?category=spot&symbol=${b}${q}&interval=${this.tfs[tf]}&limit=${n}`;
        if (end) url += `&end=${Math.floor(end)}`;
        const j = await get(this, url);
        if (j.retCode !== 0) throw err(`Bybit: ${j.retMsg}`, { fatal: /symbol|not ?support|invalid/i.test(j.retMsg || '') });
        // [start(ms), open, high, low, close, volume, turnover], newest first
        return (j.result.list || []).map((r) => ({ t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] }));
      });
    },
    stream(b, q, tf, onBar, onStatus) {
      const topic = `kline.${this.tfs[tf]}.${b}${q}`;
      return socket('wss://stream.bybit.com/v5/public/spot', {
        onOpen: (send) => send({ op: 'subscribe', args: [topic] }),
        onMessage: (m) => { if (m.topic === topic) for (const d of m.data || []) onBar({ t: +d.start, o: +d.open, h: +d.high, l: +d.low, c: +d.close, v: +d.volume }); },
        onStatus, ping: { every: 20000, msg: { op: 'ping' } },
      });
    },
    async ticker(b, q) {
      const r = (await get(this, `${this.rest}/v5/market/tickers?category=spot&symbol=${b}${q}`)).result.list[0];
      return { c: +r.lastPrice, o: +r.prevPrice24h, vq: +r.turnover24h };
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

  const EXCHANGES = { BYBIT, OKX, BITGET, KUCOIN, GATE, MEXC, KRAKEN, COINBASE };
  const ID_RE = /^(BYBIT|OKX|BITGET|KUCOIN|GATE|MEXC|KRAKEN|COINBASE):([A-Z0-9.]+)\/([A-Z0-9.]+)$/;
  function parse(sym) {
    const m = ID_RE.exec(sym || '');
    return m ? { ex: EXCHANGES[m[1]], b: m[2], q: m[3] } : null;
  }

  // ---------------------------------------------------------------- building missing timeframes
  const WEEK_OFFSET = 4 * 86400e3; // 1970-01-01 was a Thursday; weeks start on Monday, as on Binance
  const bucketOf = (t, tf) => (tf === '1w' ? Math.floor((t - WEEK_OFFSET) / TF[tf]) * TF[tf] + WEEK_OFFSET : Math.floor(t / TF[tf]) * TF[tf]);
  // the largest offered timeframe that divides the wanted one
  function sourceTf(ex, tf) {
    return Object.keys(ex.tfs).filter((s) => TF[s] < TF[tf] && TF[tf] % TF[s] === 0 && (tf !== '1w' || TF[s] <= 86400e3))
      .sort((a, b) => TF[b] - TF[a])[0] || null;
  }
  function resample(bars, tf) {
    const out = [];
    for (const b of bars) {
      const t = bucketOf(b.t, tf), last = out[out.length - 1];
      if (last && last.t === t) { last.h = Math.max(last.h, b.h); last.l = Math.min(last.l, b.l); last.c = b.c; last.v += b.v; }
      else out.push({ t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
    }
    return out;
  }

  async function history(sym, tf, { limit = 1000, endTime } = {}) {
    const s = parse(sym);
    if (s.ex.tfs[tf]) return s.ex.history(s.b, s.q, tf, { limit, endTime });
    const src = sourceTf(s.ex, tf);
    if (!src) throw err(`${tfLabel(tf)} isn't available on ${s.ex.name}`, { fatal: true });
    const factor = TF[tf] / TF[src];
    const bars = await s.ex.history(s.b, s.q, src, { limit: Math.min(limit * factor, 3000), endTime });
    const out = resample(bars, tf);
    if (endTime) return out.filter((b) => b.t + TF[tf] <= endTime + 1); // only whole buckets before the chart's first bar
    return out.slice(-limit);
  }

  function stream(sym, tf, onBar, onStatus) {
    const s = parse(sym);
    if (s.ex.tfs[tf]) return s.ex.stream(s.b, s.q, tf, onBar, onStatus);
    // live updates for a built timeframe: follow the source candles of the current bucket
    const src = sourceTf(s.ex, tf), bucket = new Map();
    let stopped = false, stop = null;
    const emit = (t) => {
      const parts = [...bucket.values()].filter((b) => bucketOf(b.t, tf) === t).sort((a, b) => a.t - b.t);
      if (parts.length) onBar(resample(parts, tf)[0]);
    };
    const add = (b) => {
      const t = bucketOf(b.t, tf);
      for (const k of [...bucket.keys()]) if (bucketOf(k, tf) < t - TF[tf]) bucket.delete(k); // keep this and the previous bucket
      bucket.set(b.t, b);
      emit(t);
    };
    s.ex.history(s.b, s.q, src, { limit: TF[tf] / TF[src] + 1 }).then((seed) => {
      if (stopped) return;
      for (const b of seed) bucket.set(b.t, b);
      stop = s.ex.stream(s.b, s.q, src, add, onStatus);
    }).catch(() => { if (!stopped) stop = s.ex.stream(s.b, s.q, src, add, onStatus); });
    return () => { stopped = true; if (stop) stop(); };
  }

  // ---------------------------------------------------------------- symbol lists & search
  const lists = {};
  function pairs(exId) {
    if (!lists[exId]) {
      lists[exId] = EXCHANGES[exId].pairs().then((ps) => {
        const seen = new Set(), out = [];
        for (const [b, q] of ps) {
          const B = String(b).toUpperCase(), Q = String(q).toUpperCase(), id = `${exId}:${B}/${Q}`;
          if (!/^[A-Z0-9.]+$/.test(B) || !/^[A-Z0-9.]+$/.test(Q) || seen.has(id)) continue;
          seen.add(id);
          out.push({ id, base: B, quote: Q, key: B + Q });
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
    const hits = q ? list.filter((p) => p.key.startsWith(q) || p.base === q) : list.filter((p) => qrank(p.quote) < 3);
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
      out.push({ ex: exId, name: EXCHANGES[exId].name, id: p ? p.id : null, quote: p ? p.quote : null, problem });
    }));
    const order = ['BINANCE', ...Object.keys(EXCHANGES)];
    return out.sort((a, b) => order.indexOf(a.ex) - order.indexOf(b.ex));
  }
  function ticker(sym) {
    const s = parse(sym);
    return s ? s.ex.ticker(s.b, s.q) : binanceTicker(sym);
  }

  const tfLabel = (tf) => tf.replace(/h$/, 'H').replace(/d$/, 'D').replace(/w$/, 'W');
  const exchangeOf = (sym) => { const s = parse(sym); return s ? s.ex : null; };
  const exDisplay = (sym) => { const s = parse(sym); return s ? `${s.b}/${s.q}` : null; };
  // name for messages and lists: "BTC/USD (Kraken)", "NVDAB", "AAPL", "BTCUSDT"
  function displayName(sym) {
    const s = parse(sym);
    if (s) return `${s.b}/${s.q} (${s.ex.name})`;
    if (MD.isBStock && MD.isBStock(sym)) return sym.replace(/USDT$/, '');
    return sym.replace(/^(CSV|TD):/, '').replace(/@.*$/, '');
  }
  const setProxy = (base, token = '') => { proxyBase = base; proxyToken = token; };

  Object.assign(MD, {
    EXCHANGES, exchangeOf, exDisplay, displayName, exPairs: pairs, searchPairs, samePairs, baseQuote, ticker, setProxy,
    _exHistory: history, _exStream: stream, _resample: resample, _bucketOf: bucketOf,
  });
  MD.registerSource((sym) => !!parse(sym), { history, stream, supportsTf: (sym, tf) => !!(parse(sym).ex.tfs[tf] || sourceTf(parse(sym).ex, tf)) });
})(typeof window !== 'undefined' ? window : globalThis);
