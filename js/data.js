/* Candela — market data.
 * Live crypto data from Binance's public market-data endpoints (no API key needed), stocks, ETFs and
 * forex from Twelve Data (free API key), a deterministic demo feed for offline use, and a CSV importer. */
(function () {
  'use strict';

  const TF = {
    '1m': 60e3, '3m': 180e3, '5m': 300e3, '15m': 900e3, '30m': 1800e3,
    '1h': 3600e3, '2h': 7200e3, '4h': 14400e3, '6h': 21600e3, '12h': 43200e3,
    '1d': 86400e3, '3d': 259200e3, '1w': 604800e3,
    '8h': 28800e3, '1M': 2592000e3, // (a month counts as 30 days where a length is needed)
  };

  // data-api.binance.vision is Binance's market-data-only mirror and works in more regions.
  const REST = ['https://data-api.binance.vision', 'https://api.binance.com'];
  const WS = ['wss://data-stream.binance.vision', 'wss://stream.binance.com:9443'];
  let restIdx = 0, wsIdx = 0;

  async function getJSON(path) {
    let lastErr;
    for (let k = 0; k < REST.length; k++) {
      const base = REST[(restIdx + k) % REST.length];
      try {
        const r = await fetch(base + path);
        if (r.status === 400) { const j = await r.json().catch(() => ({})); throw Object.assign(new Error(j.msg || 'Bad request'), { fatal: true }); }
        if (!r.ok) throw new Error('HTTP ' + r.status);
        restIdx = (restIdx + k) % REST.length;
        return await r.json();
      } catch (e) { if (e.fatal) throw e; lastErr = e; }
    }
    throw lastErr || new Error('Network error');
  }

  async function klines(symbol, tf, { limit = 1000, endTime } = {}) {
    let q = `/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${tf}&limit=${Math.min(1000, limit)}`;
    if (endTime) q += `&endTime=${Math.floor(endTime)}`;
    let rows;
    try { rows = await getJSON(q); } catch (e) {
      // Binance's "invalid symbol" reply has no CORS headers, so the browser reports it as a network
      // error. If the symbol list loads fine and doesn't contain it, the symbol is the problem.
      if (!e.fatal) {
        let known = null;
        try { known = await allSymbols(); } catch (e2) { /* really offline */ }
        if (known && !known.includes(symbol)) throw Object.assign(new Error('Invalid symbol.'), { fatal: true });
      }
      throw e;
    }
    return rows.map((r) => ({ t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5], bv: +r[9] })); // bv: taker buy volume
  }

  let symbolCache = null;
  async function allSymbols() {
    if (symbolCache) return symbolCache;
    const rows = await getJSON('/api/v3/ticker/price');
    symbolCache = rows.map((r) => r.symbol).sort();
    return symbolCache;
  }

  async function tickers24(symbols) {
    if (!symbols.length) return [];
    const rows = await getJSON(`/api/v3/ticker/24hr?type=MINI&symbols=${encodeURIComponent(JSON.stringify(symbols))}`);
    return rows.map((r) => ({ s: r.symbol, c: +r.lastPrice, o: +r.openPrice }));
  }

  // Resilient WebSocket with reconnect + endpoint fallback.
  function socket(path, onMsg, onStatus) {
    let ws, closed = false, tries = 0, timer;
    const open = () => {
      if (closed) return;
      const base = WS[wsIdx % WS.length];
      onStatus && onStatus('connecting');
      try { ws = new WebSocket(base + path); } catch (e) { schedule(); return; }
      ws.onopen = () => { tries = 0; onStatus && onStatus('live'); };
      ws.onmessage = (ev) => { try { onMsg(JSON.parse(ev.data)); } catch (e) { /* ignore */ } };
      ws.onclose = () => { if (!closed) { onStatus && onStatus('reconnecting'); schedule(); } };
      ws.onerror = () => { try { ws.close(); } catch (e) { /* ignore */ } };
    };
    const schedule = () => {
      tries++;
      if (tries % 2 === 0) wsIdx++; // alternate endpoints after repeated failures
      timer = setTimeout(open, Math.min(30000, 1000 * 2 ** Math.min(tries, 5)));
    };
    open();
    return () => {
      closed = true;
      clearTimeout(timer);
      if (!ws) return;
      ws.onclose = null;
      ws.onmessage = null;
      // closing a socket that is still connecting logs a browser error, so wait for it to open
      if (ws.readyState === WebSocket.CONNECTING) ws.onopen = () => ws.close();
      else try { ws.close(); } catch (e) { /* ignore */ }
    };
  }

  function klineStream(symbol, tf, onBar, onStatus) {
    return socket(`/ws/${symbol.toLowerCase()}@kline_${tf}`, (m) => {
      const k = m.k;
      if (!k) return;
      onBar({ t: k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.v, bv: +k.V });
    }, onStatus);
  }

  function tickerStream(symbols, onTick) {
    if (!symbols.length) return () => {};
    const streams = symbols.map((s) => s.toLowerCase() + '@miniTicker').join('/');
    return socket(`/stream?streams=${streams}`, (m) => {
      const d = m.data;
      if (d && d.s) onTick({ s: d.s, c: +d.c, o: +d.o });
    });
  }

  // ---------- demo feed (works fully offline) ----------
  function rng(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // `key` picks a different simulated market (DEMO, DEMO2, DEMO3…)
  function demoBars(tf, n = 1500, key = 'DEMO') {
    let hash = 0;
    for (const ch of key) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
    const iv = TF[tf], rand = rng(42 + iv / 60000 + (key === 'DEMO' ? 0 : hash));
    const now = Math.floor(Date.now() / iv) * iv;
    const bars = [];
    let price = key === 'DEMO' ? 100 : 20 + (Math.abs(hash) % 400), vol = 0.012 * Math.sqrt(iv / 3600e3), drift = 0;
    for (let i = n - 1; i >= 0; i--) {
      if (rand() < 0.02) drift = (rand() - 0.5) * vol * 0.4;
      const o = price;
      const ch = drift + (rand() - 0.5) * 2 * vol + (rand() < 0.03 ? (rand() - 0.5) * vol * 6 : 0);
      const c = Math.max(1, o * (1 + ch));
      const h = Math.max(o, c) * (1 + rand() * vol * 0.7);
      const l = Math.min(o, c) * (1 - rand() * vol * 0.7);
      bars.push({ t: now - i * iv, o, h, l, c, v: Math.round(500 + rand() * 4000 * (1 + Math.abs(ch) / vol)) });
      price = c;
    }
    return bars;
  }

  function demoStream(tf, getLast, onBar) {
    const iv = TF[tf], rand = rng(Date.now() & 0xffff);
    const id = setInterval(() => {
      const last = getLast();
      if (!last) return;
      const now = Date.now(), slot = Math.floor(now / iv) * iv;
      const step = last.c * 0.0015 * (rand() - 0.5) * 2;
      if (slot > last.t) {
        const o = last.c, c = o + step;
        onBar({ t: slot, o, h: Math.max(o, c), l: Math.min(o, c), c, v: Math.round(rand() * 200) });
      } else {
        const c = Math.max(0.01, last.c + step);
        onBar({ ...last, c, h: Math.max(last.h, c), l: Math.min(last.l, c), v: last.v + Math.round(rand() * 40) });
      }
    }, 1000);
    return () => clearInterval(id);
  }

  // ---------- CSV import ----------
  // Accepts typical exports: Date/Time (ISO, "YYYY-MM-DD HH:MM", or unix s/ms), Open, High, Low, Close, [Volume]
  function parseCSV(text) {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length < 2) throw new Error('CSV has no data rows');
    const delim = (lines[0].match(/;/g) || []).length > (lines[0].match(/,/g) || []).length ? ';' : ',';
    const split = (l) => l.split(delim).map((c) => c.replace(/^"|"$/g, '').trim());
    let header = split(lines[0]).map((h) => h.toLowerCase());
    let start = 1;
    const find = (...names) => header.findIndex((h) => names.some((n) => h === n || h.startsWith(n)));
    let iT = find('date', 'time', 'timestamp', 'datetime', 'open time'), iO = find('open'), iH = find('high'), iL = find('low');
    let iC = header.findIndex((h) => h === 'close' || h === 'adj close' || h === 'price' || h === 'last');
    if (iC < 0) iC = find('close');
    let iV = find('volume', 'vol');
    if (iO < 0 || iH < 0 || iL < 0 || iC < 0) {
      // No recognisable header: assume time,open,high,low,close,volume
      iT = 0; iO = 1; iH = 2; iL = 3; iC = 4; iV = 5; start = 0;
    }
    if (iT < 0) iT = 0;
    const parseTime = (s) => {
      if (/^\d+(\.\d+)?$/.test(s)) { const n = +s; return n < 1e11 ? n * 1000 : n; }
      const t = Date.parse(s.includes('T') || /[zZ+]/.test(s) ? s : s.replace(' ', 'T'));
      return isNaN(t) ? Date.parse(s) : t;
    };
    const num = (s) => +String(s).replace(/[^0-9eE.+-]/g, '');
    const bars = [];
    for (let k = start; k < lines.length; k++) {
      const c = split(lines[k]);
      const b = { t: parseTime(c[iT]), o: num(c[iO]), h: num(c[iH]), l: num(c[iL]), c: num(c[iC]), v: iV >= 0 && c[iV] != null ? num(c[iV]) || 0 : 0 };
      if (isFinite(b.t) && isFinite(b.o) && isFinite(b.h) && isFinite(b.l) && isFinite(b.c)) bars.push(b);
    }
    if (bars.length < 2) throw new Error('Could not find OHLC rows in the CSV');
    bars.sort((a, b) => a.t - b.t);
    // Guess the bar interval from the median spacing
    const gaps = [];
    for (let i = 1; i < bars.length; i++) gaps.push(bars[i].t - bars[i - 1].t);
    gaps.sort((a, b) => a - b);
    return { bars, interval: gaps[Math.floor(gaps.length / 2)] || 86400e3 };
  }

  // ---------- stocks, ETFs and forex: Twelve Data (free API key) ----------
  // Symbols are written "TD:AAPL", "TD:EUR/USD", or "TD:APP@BMV" for a listing on a specific exchange.
  // The free plan allows 8 requests a minute and 800 a day, so every request goes through a budget:
  // chart loads come first, live updates next, background refreshes (watchlist, alerts) last.
  const TD_BASE = 'https://api.twelvedata.com';
  const TD_TF = { '1m': '1min', '5m': '5min', '15m': '15min', '30m': '30min', '1h': '1h', '2h': '2h', '4h': '4h', '1d': '1day', '1w': '1week', '1M': '1month' };
  const isStock = (sym) => typeof sym === 'string' && sym.startsWith('TD:');
  function parseStock(sym) {
    const [symbol, exchange] = sym.slice(3).split('@');
    return { symbol, exchange: exchange || null };
  }
  const isForex = (sym) => isStock(sym) && parseStock(sym).symbol.includes('/');
  const stockLabel = (sym) => parseStock(sym).symbol;

  const td = { key: '', perMin: 8, perDay: 800, minute: [], day: { date: '', used: 0 }, queue: [], pollers: 0, meta: {}, onUsage: null };
  const PRI = { user: 0, live: 1, background: 2 };
  const RESERVE = { user: 0, live: 30, background: 120 }; // daily credits kept back for higher priorities
  const storage = (() => { try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch (e) { return null; } })();

  function stockConfig({ key, perMin, perDay } = {}) {
    if (key !== undefined) td.key = (key || '').trim();
    if (perMin > 0) td.perMin = Math.round(perMin);
    if (perDay > 0) td.perDay = Math.round(perDay);
  }
  function rollDay() {
    const today = new Date().toISOString().slice(0, 10); // the free plan's daily credits reset at midnight UTC
    if (td.day.date === today) return;
    let saved = null;
    try { saved = storage && JSON.parse(storage.getItem('candela.tdUsage') || 'null'); } catch (e) { /* ignore */ }
    td.day = saved && saved.date === today ? saved : { date: today, used: 0 };
  }
  function noteUsage() {
    try { storage && storage.setItem('candela.tdUsage', JSON.stringify(td.day)); } catch (e) { /* ignore */ }
    if (td.onUsage) td.onUsage(stockUsage());
  }
  function stockUsage() { rollDay(); return { used: td.day.used, perDay: td.perDay, perMin: td.perMin, left: Math.max(0, td.perDay - td.day.used) }; }

  let pumpTimer = null;
  function pump() {
    clearTimeout(pumpTimer);
    pumpTimer = null;
    const now = Date.now();
    td.minute = td.minute.filter((t) => now - t < 61000);
    rollDay();
    while (td.queue.length && td.minute.length < td.perMin) {
      const job = td.queue.shift();
      if (td.day.used >= td.perDay - RESERVE[job.priority]) {
        job.reject(Object.assign(new Error(`Daily Twelve Data limit reached (${td.perDay} requests). It resets at midnight UTC.`), { budget: true }));
        continue;
      }
      td.minute.push(now);
      td.day.used++;
      noteUsage();
      job.run().then(job.resolve, job.reject);
    }
    if (td.queue.length) pumpTimer = setTimeout(pump, Math.max(200, td.minute[0] + 61000 - now));
  }
  function schedule(run, priority) {
    return new Promise((resolve, reject) => {
      td.queue.push({ run, priority, resolve, reject });
      td.queue.sort((a, b) => PRI[a.priority] - PRI[b.priority]);
      pump();
    });
  }

  async function tdGet(endpoint, params, priority = 'user', needsKey = true) {
    if (needsKey && !td.key) throw Object.assign(new Error('Add a free Twelve Data API key to load stocks and forex'), { needsKey: true, fatal: true });
    const q = new URLSearchParams(needsKey ? { ...params, apikey: td.key } : params);
    const run = async () => {
      const r = await fetch(`${TD_BASE}/${endpoint}?${q}`);
      const j = await r.json().catch(() => null);
      if (!j) throw new Error('Twelve Data: HTTP ' + r.status);
      if (j.status === 'error') {
        const e = new Error(j.message || 'Twelve Data error');
        e.code = j.code;
        if (j.code === 401 || j.code === 403) { e.needsKey = /api ?key|demo/i.test(j.message || ''); e.fatal = true; }
        if (j.code === 400 || j.code === 404) e.fatal = true;
        if (j.code === 429) { const now = Date.now(); while (td.minute.length < td.perMin) td.minute.push(now); } // pause until the minute is over
        throw e;
      }
      return j;
    };
    return needsKey ? schedule(run, priority) : run();
  }

  // Twelve Data times are requested in UTC: "2026-11-20" (daily+) or "2026-11-20 14:30:00"
  const tdTime = (s) => Date.parse(s.length <= 10 ? s + 'T00:00:00Z' : s.replace(' ', 'T') + 'Z');
  const tdDate = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

  async function stockBars(sym, tf, { limit = 1000, endTime, priority = 'user' } = {}) {
    if (!TD_TF[tf]) throw Object.assign(new Error(`The ${tf} timeframe isn't available for stocks and forex`), { fatal: true, badTf: true });
    const { symbol, exchange } = parseStock(sym);
    const params = { symbol, interval: TD_TF[tf], outputsize: Math.min(5000, Math.max(1, limit)), timezone: 'UTC' };
    if (exchange) params.exchange = exchange;
    if (endTime) params.end_date = tdDate(endTime);
    let j;
    try { j = await tdGet('time_series', params, priority); } catch (e) {
      if (e.code === 400 && /no data|not found|symbol/i.test(e.message) && endTime) return []; // no older history
      throw e;
    }
    if (j.meta) td.meta[sym] = { exchange: j.meta.exchange, type: j.meta.type, currency: j.meta.currency || j.meta.currency_quote };
    return (j.values || []).map((v) => ({ t: tdTime(v.datetime), o: +v.open, h: +v.high, l: +v.low, c: +v.close, v: +(v.volume || 0) })).reverse();
  }

  // ---- trading hours (when to spend requests on updates)
  function nyClock(now) {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(new Date(now));
    const get = (t) => parts.find((p) => p.type === t).value;
    return { day: get('weekday'), mins: +get('hour') * 60 + +get('minute') };
  }
  // ms until the end of the current session, or 0 when closed. Forex: Sun 17:00 – Fri 17:00 New York.
  // US stocks: Mon–Fri 9:30–16:00 New York (plus a few minutes to collect the closing bar). Listings on
  // other exchanges: hours unknown, treated as always open.
  function sessionLeft(sym, now = Date.now()) {
    const { exchange } = parseStock(sym);
    const { day, mins } = nyClock(now);
    if (isForex(sym)) {
      if (day === 'Sat' || (day === 'Fri' && mins >= 17 * 60) || (day === 'Sun' && mins < 17 * 60)) return 0;
      return 86400e3; // effectively the rest of the (UTC) day; credits reset at midnight UTC anyway
    }
    if (exchange && !/^(NASDAQ|NYSE|ARCA|AMEX|BATS|CBOE|OTC)/i.test(exchange)) return 6 * 3600e3;
    if (day === 'Sat' || day === 'Sun') return 0;
    const open = 9 * 60 + 30, close = 16 * 60 + 5;
    return mins >= open && mins < close ? (close - mins) * 60e3 : 0;
  }
  const marketOpen = (sym) => sessionLeft(sym) > 0;

  // How often a live chart may refresh so that all charts together stay within the daily budget.
  function pollPeriod(sym) {
    const left = sessionLeft(sym);
    if (!left) return 15 * 60e3; // closed: an occasional check is enough
    const msToReset = 86400e3 - (Date.now() % 86400e3);
    const credits = Math.max(1, stockUsage().left - RESERVE.background);
    const fair = (Math.min(left, msToReset) * Math.max(1, td.pollers)) / credits;
    return Math.round(Math.min(30 * 60e3, Math.max(60e3, fair)));
  }

  // "Stream" for stocks: poll the last few bars. onStatus gets ('live', periodMs), ('closed'), ('limit') …
  function stockStream(sym, tf, onBar, onStatus) {
    let stopped = false, timer = null;
    td.pollers++;
    const tick = async () => {
      timer = null;
      if (stopped) return;
      try {
        const bars = await stockBars(sym, tf, { limit: 3, priority: 'live' });
        if (stopped) return;
        for (const b of bars) onBar(b);
        onStatus && onStatus(marketOpen(sym) ? 'polling' : 'closed', pollPeriod(sym));
      } catch (e) {
        if (stopped) return;
        onStatus && onStatus(e.budget ? 'limit' : 'reconnecting', pollPeriod(sym));
      }
      if (!stopped) timer = setTimeout(tick, pollPeriod(sym));
    };
    onStatus && onStatus(marketOpen(sym) ? 'polling' : 'closed', pollPeriod(sym));
    timer = setTimeout(tick, pollPeriod(sym));
    return () => { stopped = true; clearTimeout(timer); td.pollers = Math.max(0, td.pollers - 1); };
  }

  // Latest price for several symbols in one request (one credit per symbol).
  async function stockQuotes(syms, priority = 'background') {
    if (!syms.length) return [];
    const plain = syms.filter((s) => !parseStock(s).exchange);
    const out = [];
    if (plain.length) {
      const j = await tdGet('quote', { symbol: plain.map((s) => parseStock(s).symbol).join(',') }, priority);
      const rows = plain.length === 1 ? { [parseStock(plain[0]).symbol]: j } : j;
      for (const s of plain) {
        const r = rows[parseStock(s).symbol];
        if (r && r.close) out.push({ s, c: +r.close, o: +(r.previous_close || r.open), open: !!r.is_market_open });
      }
    }
    return out;
  }

  // Symbol search (free, no key, no credits).
  const SEARCH_TYPES = /^(Common Stock|ETF|Physical Currency|REIT|Depositary Receipt|Preferred Stock|Index)$/;
  async function searchStocks(q) {
    if (!q || q.length < 1) return [];
    const j = await tdGet('symbol_search', { symbol: q, outputsize: 30 }, 'user', false);
    const seen = new Set(), out = [];
    for (const r of j.data || []) {
      if (!SEARCH_TYPES.test(r.instrument_type)) continue;
      const forex = r.instrument_type === 'Physical Currency';
      const us = r.country === 'United States';
      const id = forex || us ? `TD:${r.symbol}` : `TD:${r.symbol}@${r.exchange}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ id, symbol: r.symbol, name: r.instrument_name, exchange: forex ? 'Forex' : r.exchange, country: r.country, type: r.instrument_type, us: us || forex });
    }
    out.sort((a, b) => (b.us - a.us) || (a.symbol === q.toUpperCase() ? -1 : b.symbol === q.toUpperCase() ? 1 : 0));
    // US listings and forex first; only a few foreign listings (most need a paid plan)
    return out.filter((r) => r.us).concat(out.filter((r) => !r.us).slice(0, 5));
  }

  async function checkStockKey() {
    const j = await tdGet('api_usage', {}, 'user');
    return { plan: j.plan_category || 'basic', perMin: j.plan_limit || null };
  }

  // ---------- Binance bStocks: tokenized US stocks and ETFs, traded as ordinary Binance pairs ----------
  // e.g. NVDABUSDT tracks NVDA. They're charted like any Binance pair (free, live, no key); this only
  // recognises them. Binance tags every bStock with one trading-permission group, so a single small
  // request lists them; if that group ever changes, a ticker + "B" + "USDT" name rule is the fallback.
  const BSTOCK_GROUP = 'TRD_GRP_261';
  const OLD_CRYPTO_B = new Set(['ARB', 'BNB', 'CKB', 'DGB', 'SHIB', 'TRB', 'AMB', 'BB', 'BTCB', 'BNBB']); // names that look like ticker+B but are coins
  let bstocks = null, bstocksLoading = null; // pair -> { ticker, base }
  function loadBStocks() {
    if (bstocks) return Promise.resolve(bstocks);
    if (!bstocksLoading) {
      bstocksLoading = getJSON(`/api/v3/exchangeInfo?permissions=${BSTOCK_GROUP}&showPermissionSets=false`)
        .then((j) => {
          const map = {};
          for (const s of j.symbols || []) {
            if (s.quoteAsset !== 'USDT' || !s.baseAsset.endsWith('B') || OLD_CRYPTO_B.has(s.baseAsset)) continue;
            map[s.symbol] = { ticker: s.baseAsset.slice(0, -1), base: s.baseAsset, trading: s.status === 'TRADING' };
          }
          bstocks = map;
          return map;
        })
        .catch((e) => { bstocksLoading = null; throw e; });
    }
    return bstocksLoading;
  }
  const isBStock = (sym) => !!(bstocks && bstocks[sym]);
  const bStockTicker = (sym) => (bstocks && bstocks[sym] ? bstocks[sym].ticker : null);
  // ticker → bStock pair ("BRK.B" → "BRKBBUSDT"), or null
  const bStockFor = (ticker) => { const p = String(ticker).toUpperCase().replace(/[^A-Z0-9]/g, '') + 'BUSDT'; return bstocks && bstocks[p] && bstocks[p].trading ? p : null; };
  const bStockList = () => (bstocks ? Object.keys(bstocks).filter((p) => bstocks[p].trading) : []);

  // ---------- timeframes: the standard ones plus any you make (2D, 3H, 2W, 1M…) ----------
  // Written as a number and a unit: m minutes, h hours, d days, w weeks, M months ("45m", "3h", "2d", "2w", "1M").
  const DAY = 86400e3;
  const UNIT_MS = { m: 60e3, h: 3600e3, d: DAY, w: 7 * DAY, M: 30 * DAY };
  const UNIT_MAX = { m: 1440, h: 168, d: 365, w: 52, M: 12 };
  function parseTf(tf) {
    const m = /^(\d{1,4})(m|h|d|w|M)$/.exec(String(tf || ''));
    if (!m || +m[1] < 1 || +m[1] > UNIT_MAX[m[2]]) return null;
    return { n: +m[1], unit: m[2], ms: +m[1] * UNIT_MS[m[2]] };
  }
  // make sure TF has an entry for tf (custom timeframes are added on first use); false if tf is not valid
  function ensureTf(tf) {
    if (TF[tf]) return true;
    const p = parseTf(tf);
    if (!p) return false;
    TF[tf] = p.ms;
    return true;
  }
  // what someone typed ("2D", "12H", "90", "2 weeks", "1 month") → "2d", "12h", "90m", "2w", "1M"; null if not understood
  function normalizeTf(text) {
    const m = /^\s*(\d{1,4})\s*([a-zA-Z]*)\s*$/.exec(String(text || ''));
    if (!m) return null;
    let n = +m[1];
    const u = m[2], ul = u.toLowerCase();
    let unit;
    if (u === '' || u === 'm' || /^min/.test(ul)) unit = 'm';
    else if (u === 'M' || /^mo/.test(ul)) unit = 'M';
    else if (/^h/.test(ul)) unit = 'h';
    else if (/^d/.test(ul)) unit = 'd';
    else if (/^w/.test(ul)) unit = 'w';
    else return null;
    // the simplest name for the same length: 60m → 1h, 24h → 1d, 14d → 2w
    if (unit === 'm' && n % 60 === 0) { n /= 60; unit = 'h'; }
    if (unit === 'h' && n % 24 === 0) { n /= 24; unit = 'd'; }
    if (unit === 'd' && n % 7 === 0) { n /= 7; unit = 'w'; }
    const tf = n + unit;
    return parseTf(tf) ? tf : null;
  }
  // "3h" → "3H", "2d" → "2D", "1M" → "1M", "45m" → "45m"
  const tfLabel = (tf) => tf.replace(/h$/, 'H').replace(/d$/, 'D').replace(/w$/, 'W');

  // Start of the candle that contains time t. Days and longer start at midnight UTC; weeks on Monday;
  // months on the 1st (3M = quarters). Intraday lengths that don't fit a day evenly (5H, 7H…) restart each day.
  const MONDAY = 4 * DAY; // 1970-01-01 was a Thursday
  function bucketOf(t, tf) {
    const p = parseTf(tf);
    if (!p) return t;
    if (p.unit === 'M') {
      const d = new Date(t), k = d.getUTCFullYear() * 12 + d.getUTCMonth(), s = Math.floor(k / p.n) * p.n;
      return Date.UTC(Math.floor(s / 12), s % 12, 1);
    }
    if (p.unit === 'w') return Math.floor((t - MONDAY) / p.ms) * p.ms + MONDAY;
    if (p.unit === 'd' || p.ms >= DAY || DAY % p.ms === 0) return Math.floor(t / p.ms) * p.ms;
    const day = Math.floor(t / DAY) * DAY;
    return day + Math.floor((t - day) / p.ms) * p.ms;
  }
  // can candles of timeframe s be combined into tf candles (each s candle lies inside one tf candle)?
  function nests(s, tf) {
    const a = parseTf(s), b = parseTf(tf);
    if (!a || !b || a.ms >= b.ms) return false;
    const inDay = DAY % a.ms === 0; // s candles never cross midnight
    if (b.unit === 'M') return inDay || (a.unit === 'M' && b.n % a.n === 0);
    if (b.unit === 'w') return inDay || (a.unit === 'w' && b.n % a.n === 0);
    if (a.unit === 'M' || a.unit === 'w') return false;
    return b.ms % a.ms === 0 && (inDay || a.unit === 'd');
  }
  function resample(bars, tf) {
    const out = [];
    for (const b of bars) {
      const t = bucketOf(b.t, tf), last = out[out.length - 1];
      if (last && last.t === t) { last.h = Math.max(last.h, b.h); last.l = Math.min(last.l, b.l); last.c = b.c; last.v += b.v; if (last.bv >= 0) last.bv = b.bv >= 0 ? last.bv + b.bv : undefined; }
      else out.push(b.bv >= 0 ? { t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, bv: b.bv } : { t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
    }
    return out;
  }

  // ---------- one entry point for every kind of symbol ----------
  // A source offers some timeframes natively ({ tfs, history, stream }); every other timeframe is built
  // from the largest native one that fits. More exchanges register themselves (see exchanges.js).
  const BINANCE_TFS = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d', '3d', '1w', '1M'];
  const sources = [];
  const registerSource = (test, src) => sources.unshift({ test, ...src });
  sources.push(
    { test: isStock, tfs: () => Object.keys(TD_TF), history: stockBars, stream: stockStream, buildMin: DAY }, // stock sessions: only build from daily candles
    { test: () => true, tfs: () => BINANCE_TFS, history: klines, stream: klineStream },
  );
  const sourceOf = (sym) => sources.find((s) => s.test(sym));
  function buildFrom(sym, tf) {
    const src = sourceOf(sym);
    if (!ensureTf(tf)) return null;
    return src.tfs(sym).filter((s) => ensureTf(s) && nests(s, tf) && TF[s] >= (src.buildMin || 0)).sort((a, b) => TF[b] - TF[a])[0] || null;
  }
  const isNative = (sym, tf) => sourceOf(sym).tfs(sym).includes(tf);
  const supportsTf = (sym, tf) => ensureTf(tf) && (isNative(sym, tf) || !!buildFrom(sym, tf));
  // the longest a tf candle can be, in src candles (months have up to 31 days)
  const perBucket = (tf, src) => Math.ceil((parseTf(tf).unit === 'M' ? parseTf(tf).n * 31 * DAY : TF[tf]) / TF[src]);

  async function history(sym, tf, opts = {}) {
    const source = sourceOf(sym);
    if (!ensureTf(tf)) throw Object.assign(new Error(`Unknown timeframe ${tf}`), { fatal: true });
    if (isNative(sym, tf)) return source.history(sym, tf, opts);
    const src = buildFrom(sym, tf);
    if (!src) throw Object.assign(new Error(`${tfLabel(tf)} isn't available for this symbol`), { fatal: true, badTf: true });
    const { limit = 1000, endTime } = opts;
    const want = Math.min(4000, limit * perBucket(tf, src) + perBucket(tf, src));
    // fetch the smaller candles, a page at a time (sources return at most 1000–10000 per request)
    let bars = [], end = endTime;
    for (let k = 0; k < 8 && bars.length < want; k++) {
      const chunk = await source.history(sym, src, { ...opts, limit: want - bars.length, endTime: end });
      const older = bars.length ? chunk.filter((b) => b.t < bars[0].t) : chunk;
      if (!older.length) break;
      bars = older.concat(bars);
      end = bars[0].t - 1;
    }
    const out = resample(bars, tf);
    if (out.length && bars.length && bars[0].t > out[0].t) out.shift(); // the oldest candle would be incomplete
    return out.slice(-limit);
  }

  function stream(sym, tf, onBar, onStatus) {
    const source = sourceOf(sym);
    ensureTf(tf);
    if (isNative(sym, tf)) return source.stream(sym, tf, onBar, onStatus);
    const src = buildFrom(sym, tf);
    if (!src) return () => {};
    // follow the smaller candles of the current (and previous) tf candle and combine them
    const parts = new Map();
    let stopped = false, stop = null;
    const add = (b) => {
      const t = bucketOf(b.t, tf), prev = bucketOf(t - 1, tf);
      for (const k of [...parts.keys()]) if (bucketOf(k, tf) < prev) parts.delete(k);
      parts.set(b.t, b);
      const mine = [...parts.values()].filter((x) => bucketOf(x.t, tf) === t).sort((x, y) => x.t - y.t);
      if (mine.length) onBar(resample(mine, tf)[0]);
    };
    const go = () => { if (!stopped) stop = source.stream(sym, src, add, onStatus); };
    source.history(sym, src, { limit: perBucket(tf, src) + 1, priority: 'live' }).then((seed) => {
      if (stopped) return;
      for (const b of seed) parts.set(b.t, b);
      go();
    }, go);
    return () => { stopped = true; if (stop) stop(); };
  }

  // the supported timeframe closest to tf (for comparing a stock on a crypto chart, say)
  function nearestTf(sym, tf) {
    if (supportsTf(sym, tf)) return tf;
    const want = TF[tf] || 3600e3;
    return Object.keys(TF).filter((k) => supportsTf(sym, k)).reduce((best, k) => (Math.abs(Math.log(TF[k] / want)) < Math.abs(Math.log(TF[best] / want)) ? k : best), '1d');
  }

  window.MarketData = {
    TF, klines, allSymbols, tickers24, klineStream, tickerStream, demoBars, demoStream, parseCSV,
    history, stream, supportsTf, nearestTf, registerSource, isNative,
    parseTf, ensureTf, normalizeTf, tfLabel, bucketOf, resample, nests,
    isStock, isForex, parseStock, stockLabel, stockMeta: (sym) => td.meta[sym] || null, stockConfig, stockUsage,
    stockQuotes, searchStocks, checkStockKey, marketOpen, pollPeriod, onStockUsage: (fn) => { td.onUsage = fn; }, STOCK_TF: TD_TF,
    loadBStocks, isBStock, bStockTicker, bStockFor, bStockList,
  };
})();
