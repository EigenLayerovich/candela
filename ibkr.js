/* Candela — Interactive Brokers market data, through IB Gateway (or Trader Workstation) on this computer.
 *
 * Candela's server connects to IB Gateway's API port (live 4001, paper 4002; TWS 7496 / 7497) with the
 * @stoqey/ib client, read-only: it asks for contract details, historical bars (kept up to date for live
 * charts) and quotes, never for orders. What you can see depends on your IBKR market data permissions:
 * without a subscription IBKR sends delayed data where it can.
 *
 * Symbols are written IB:<secType>:<label>:<conId>, e.g. "IB:STK:AAPL:265598", "IB:CASH:EUR.USD:12087792",
 * "IB:FUT:ESZ6:...". IBKR limits how often history can be requested, so requests are queued, spaced out and
 * cached. */
'use strict';

let IBM = null; // the @stoqey/ib module, loaded on first use (it isn't needed when IBKR is off)
function lib() {
  if (!IBM) {
    try { IBM = require('@stoqey/ib'); } catch (e) {
      const missing = e.code === 'MODULE_NOT_FOUND' && /'@stoqey\/ib'/.test(e.message);
      throw Object.assign(new Error(missing ? 'The Interactive Brokers module is missing. In the Candela folder run: npm install --omit=dev'
        : `Could not load the Interactive Brokers library (${String(e.message).split('\n')[0]}). Update Candela, or with node server.js run: npm install --omit=dev`), { fatal: true });
    }
  }
  return IBM;
}
let available = true;
try { require.resolve('@stoqey/ib'); } catch (e) { available = false; }

const BAR = { '1m': '1 min', '3m': '3 mins', '5m': '5 mins', '15m': '15 mins', '30m': '30 mins', '1h': '1 hour', '2h': '2 hours', '4h': '4 hours', '1d': '1 day', '1w': '1 week', '1M': '1 month' };
// how far back one request reaches (IBKR refuses long spans of small bars)
const SPAN = { '1m': '2 D', '3m': '1 W', '5m': '1 W', '15m': '2 W', '30m': '1 M', '1h': '1 M', '2h': '2 M', '4h': '4 M', '1d': '3 Y', '1w': '10 Y', '1M': '20 Y' };
// the live request only needs the last few bars
const LIVE_SPAN = { '1m': '1 D', '3m': '1 D', '5m': '2 D', '15m': '2 D', '30m': '1 W', '1h': '1 W', '2h': '2 W', '4h': '1 M', '1d': '3 M' };
const TFS = Object.keys(BAR);
// messages from IB Gateway that are news, not errors (data farm connected, delayed data shown…)
const INFO_CODES = new Set([2103, 2104, 2105, 2106, 2107, 2108, 2119, 2157, 2158, 2176, 10167, 10197, 2100, 2150]);

const S = {
  cfg: { enabled: false, host: '127.0.0.1', port: 4001, clientId: 77 },
  ib: null, connected: false, status: 'off', message: '', accounts: '', serverVersion: 0,
  nextId: 1000, pending: new Map(), queue: [], running: 0, lastStart: 0, timer: null, retry: null,
  details: new Map(), cache: new Map(), streams: new Map(), quotes: new Map(), log: () => {},
};

const parse = (sym) => {
  const m = /^IB:([A-Z]+):([A-Z0-9.]+):(\d+)$/.exec(sym || '');
  return m ? { secType: m[1], label: m[2], conId: +m[3] } : null;
};
const isIB = (sym) => !!parse(sym);
const err = (msg, extra) => Object.assign(new Error(msg), extra || {});

// ---- connection
function setStatus(st, msg = '') { S.status = st; S.message = msg; }
function configure(cfg, log) {
  if (log) S.log = log;
  const prev = JSON.stringify(S.cfg);
  S.cfg = { ...S.cfg, ...cfg };
  if (JSON.stringify(S.cfg) === prev && (S.ib || !S.cfg.enabled)) return;
  disconnect();
  if (S.cfg.enabled) connect();
  else setStatus('off');
}
function disconnect() {
  clearTimeout(S.retry);
  S.retry = null;
  if (S.ib) { try { S.ib.removeAllListeners(); S.ib.disconnect(); } catch (e) { /* closing */ } }
  S.ib = null;
  S.connected = false;
  for (const p of S.pending.values()) p.reject(err('Disconnected from IB Gateway'));
  S.pending.clear();
}
function scheduleRetry() {
  if (!S.cfg.enabled || S.retry) return;
  S.retry = setTimeout(() => { S.retry = null; if (S.cfg.enabled && !S.connected) { disconnect(); connect(); } }, 15000);
}
function connect() {
  let M;
  try { M = lib(); } catch (e) { setStatus('error', e.message); return; }
  const { IBApi, EventName } = M;
  setStatus('connecting', `Connecting to IB Gateway at ${S.cfg.host}:${S.cfg.port}…`);
  const ib = (S.ib = new IBApi({ host: S.cfg.host, port: S.cfg.port, clientId: S.cfg.clientId }));
  ib.on(EventName.connected, () => {
    S.connected = true;
    S.serverVersion = ib.serverVersion;
    setStatus('connected', 'Connected');
    S.log(`IBKR: connected to IB Gateway at ${S.cfg.host}:${S.cfg.port}`);
    // live data where you have a subscription, delayed data where you don't
    try { ib.reqMarketDataType(3); } catch (e) { /* older versions */ }
    for (const st of S.streams.values()) startStream(st);
    for (const q of S.quotes.values()) startQuote(q);
    pump();
  });
  ib.on(EventName.disconnected, () => {
    const was = S.connected;
    S.connected = false;
    for (const p of S.pending.values()) p.reject(err('Disconnected from IB Gateway'));
    S.pending.clear();
    for (const st of S.streams.values()) { st.reqId = null; for (const l of st.listeners) l.status && l.status('reconnecting'); }
    for (const q of S.quotes.values()) q.reqId = null;
    if (S.status !== 'error') setStatus('disconnected', was ? 'IB Gateway closed the connection. Retrying every 15 seconds…' : `Could not reach IB Gateway at ${S.cfg.host}:${S.cfg.port}. Is it running and logged in, with the API enabled?`);
    if (was) S.log('IBKR: disconnected from IB Gateway');
    scheduleRetry();
  });
  ib.on(EventName.managedAccounts, (accts) => { S.accounts = String(accts || '').replace(/,$/, ''); });
  ib.on(EventName.error, (e, code, reqId) => {
    const msg = (e && e.message) || String(e);
    if (INFO_CODES.has(code)) return;
    if (code === 502 || code === 504) { setStatus('disconnected', `Could not reach IB Gateway at ${S.cfg.host}:${S.cfg.port}. Is it running and logged in, with "Enable ActiveX and Socket Clients" on?`); scheduleRetry(); return; }
    if (code === 326) { setStatus('error', `Client ID ${S.cfg.clientId} is already in use in IB Gateway. Pick another number in Candela's IBKR settings.`); return; }
    if (code === 1100) { setStatus('connected', 'IB Gateway lost its connection to IBKR; waiting for it to come back…'); return; }
    if (code === 1101 || code === 1102) { setStatus('connected', 'Connected'); for (const st of S.streams.values()) startStream(st); return; }
    const p = S.pending.get(reqId);
    if (p) { S.pending.delete(reqId); p.reject(err(friendly(code, msg), { code, fatal: [200, 162, 321, 354, 10089, 10090].includes(code) })); return; }
    for (const st of S.streams.values()) if (st.reqId === reqId) { for (const l of st.listeners) l.status && l.status('error', friendly(code, msg)); return; }
    for (const q of S.quotes.values()) if (q.reqId === reqId) { q.error = friendly(code, msg); for (const w of q.waiters.splice(0)) w(); return; }
    if (reqId < 0 && code >= 500) S.log(`IBKR: ${msg} (${code})`);
  });
  ib.on(EventName.historicalData, (reqId, date, o, h, l, c, v) => {
    const st = streamOf(reqId);
    if (st) {
      if (String(date).startsWith('finished')) return;
      st.last = bar(date, o, h, l, c, v);
      return;
    }
    const p = S.pending.get(reqId);
    if (!p) return;
    if (String(date).startsWith('finished')) { S.pending.delete(reqId); p.resolve(p.rows); return; }
    const b = bar(date, o, h, l, c, v);
    if (b) p.rows.push(b);
  });
  ib.on(EventName.historicalDataUpdate, (reqId, date, o, h, l, c, v) => {
    const st = streamOf(reqId), b = st && bar(date, o, h, l, c, v);
    if (!b) return;
    st.last = b;
    for (const l2 of st.listeners) l2.bar(b);
  });
  ib.on(EventName.symbolSamples, (reqId, list) => { const p = S.pending.get(reqId); if (p) { S.pending.delete(reqId); p.resolve(list || []); } });
  ib.on(EventName.contractDetails, (reqId, d) => { const p = S.pending.get(reqId); if (p) p.rows.push(d); });
  ib.on(EventName.contractDetailsEnd, (reqId) => { const p = S.pending.get(reqId); if (p) { S.pending.delete(reqId); p.resolve(p.rows); } });
  ib.on(EventName.tickPrice, (reqId, field, value) => {
    for (const q of S.quotes.values()) {
      if (q.reqId !== reqId || !(value > 0)) continue;
      // live and delayed tick types: bid, ask, last, close
      if (field === 1 || field === 66) q.bid = value;
      else if (field === 2 || field === 67) q.ask = value;
      else if (field === 4 || field === 68) q.last = value;
      else if (field === 9 || field === 75) q.close = value;
      q.t = Date.now();
      for (const w of q.waiters.splice(0)) w();
    }
  });
  try { ib.connect(S.cfg.clientId); } catch (e) { setStatus('error', e.message); scheduleRetry(); }
}
function friendly(code, msg) {
  if (code === 162 && /pacing/i.test(msg)) return 'IBKR is limiting history requests right now (pacing). Try again in a minute.';
  if (code === 162 || code === 10089 || code === 354 || code === 10090) return `No market data permission for this in your IBKR account (${code}): ${msg}`;
  if (code === 200) return 'IBKR does not know this contract (it may have expired).';
  return `${msg} (IBKR ${code})`;
}
// IBKR times: seconds since 1970 (intraday, formatDate 2) or yyyyMMdd (daily and longer)
function bar(date, o, h, l, c, v) {
  const s = String(date).trim();
  let t;
  if (/^\d{8}$/.test(s)) t = Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
  else if (/^\d{9,11}$/.test(s)) t = +s * 1000;
  else if (/^\d{8}\s+\d{2}:\d{2}:\d{2}/.test(s)) t = Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(9, 11), +s.slice(12, 14), +s.slice(15, 17));
  if (!isFinite(t) || !(o > 0)) return null;
  const vol = Number(v);
  return { t, o: +o, h: +h, l: +l, c: +c, v: vol > 0 ? vol : 0 };
}

// ---- requests: one queue, spaced out (IBKR counts history requests and refuses bursts)
function request(kind, send, timeout = 30000) {
  return new Promise((resolve, reject) => {
    S.queue.push({ kind, send, resolve, reject, timeout });
    pump();
  });
}
function pump() {
  clearTimeout(S.timer);
  if (!S.connected || !S.queue.length) return;
  const gap = Date.now() - S.lastStart, wait = Math.max(0, 350 - gap);
  if (wait || S.running >= 3) { S.timer = setTimeout(pump, Math.max(wait, 200)); return; }
  const job = S.queue.shift(), reqId = S.nextId++;
  S.lastStart = Date.now();
  S.running++;
  let done = false;
  const finish = () => { if (!done) { done = true; S.running--; pump(); } };
  const to = setTimeout(() => { if (S.pending.has(reqId)) { S.pending.delete(reqId); finish(); job.reject(err('IB Gateway did not answer in time')); } }, job.timeout);
  S.pending.set(reqId, {
    rows: [],
    resolve: (x) => { clearTimeout(to); finish(); job.resolve(x); },
    reject: (e) => { clearTimeout(to); finish(); job.reject(e); },
  });
  try { job.send(S.ib, reqId); } catch (e) { S.pending.get(reqId).reject(e); S.pending.delete(reqId); }
  if (S.queue.length) S.timer = setTimeout(pump, 350);
}
function needConnection() {
  if (!S.cfg.enabled) throw err('Interactive Brokers is off. Turn it on in Candela: symbol search → Interactive Brokers…', { fatal: true, needsSetup: true });
  if (!S.connected) throw err(S.message || 'Not connected to IB Gateway yet', { offline: true });
}

// ---- contracts
async function details(conId) {
  if (S.details.has(conId)) return S.details.get(conId);
  needConnection();
  const rows = await request('details', (ib, id) => ib.reqContractDetails(id, { conId }));
  if (!rows.length) throw err('IBKR does not know this contract', { fatal: true });
  S.details.set(conId, rows[0]);
  return rows[0];
}
async function contractOf(sym) {
  const s = parse(sym);
  if (!s) throw err('Not an IBKR symbol', { fatal: true });
  const d = await details(s.conId), c = d.contract || {};
  // stocks and metals route SMART; the rest go to their own exchange
  const exchange = c.secType === 'STK' || c.secType === 'CMDTY' ? 'SMART' : c.exchange || c.primaryExch || 'SMART';
  return { contract: { conId: s.conId, exchange }, secType: c.secType || s.secType, details: d };
}
const whatToShow = (secType) => (secType === 'CASH' || secType === 'CMDTY' ? 'MIDPOINT' : secType === 'CRYPTO' ? 'AGGTRADES' : 'TRADES');
const ibTime = (ms) => { const d = new Date(ms), p = (n) => String(n).padStart(2, '0'); return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`; };

// ---- history: one chunk of bars ending at endTime (or now); older chunks by asking again with an earlier end
async function history(sym, tf, { endTime } = {}) {
  if (!BAR[tf]) throw err('IBKR has no such timeframe', { fatal: true });
  needConnection();
  const key = `${sym}|${tf}|${endTime || 'now'}`, hit = S.cache.get(key);
  if (hit && Date.now() - hit.at < (endTime ? 600e3 : 20e3)) return hit.bars.slice();
  const { contract, secType } = await contractOf(sym);
  const rows = await request('history', (ib, id) => ib.reqHistoricalData(id, contract, endTime ? ibTime(endTime) : '', SPAN[tf], BAR[tf], whatToShow(secType), 0, 2, false), 60000);
  const bars = rows.filter((b) => !endTime || b.t < endTime).sort((a, b) => a.t - b.t);
  S.cache.set(key, { at: Date.now(), bars });
  if (S.cache.size > 300) S.cache.delete(S.cache.keys().next().value);
  return bars.slice();
}

// ---- live bars: IBKR's "keep up to date" history request, shared by everyone watching the same symbol and timeframe
const streamOf = (reqId) => { for (const st of S.streams.values()) if (st.reqId === reqId) return st; return null; };
async function startStream(st) {
  if (!S.connected) return;
  if (!LIVE_SPAN[st.tf]) return; // weeks and months: refreshed from history instead (see stream)
  try {
    const { contract, secType } = await contractOf(st.sym);
    if (!S.connected || !S.streams.has(st.key)) return;
    const id = S.nextId++;
    st.reqId = id;
    S.ib.reqHistoricalData(id, contract, '', LIVE_SPAN[st.tf], BAR[st.tf], whatToShow(secType), 0, 2, true);
    for (const l of st.listeners) l.status && l.status('live');
  } catch (e) { for (const l of st.listeners) l.status && l.status('error', e.message); }
}
function stream(sym, tf, onBar, onStatus) {
  const key = `${sym}|${tf}`, listener = { bar: onBar, status: onStatus };
  let st = S.streams.get(key);
  if (!st) {
    st = { key, sym, tf, reqId: null, listeners: new Set(), last: null, poll: null };
    S.streams.set(key, st);
    if (LIVE_SPAN[tf]) startStream(st);
    else {
      // weekly and monthly bars: the latest bars every minute
      const tick = async () => { try { const b = await history(sym, tf); const last = b[b.length - 1]; if (last) for (const l of st.listeners) l.bar(last); } catch (e) { /* next time */ } };
      st.poll = setInterval(tick, 60e3);
      setTimeout(tick, 5000);
    }
  }
  st.listeners.add(listener);
  if (onStatus) onStatus(S.connected ? 'live' : 'reconnecting');
  return () => {
    st.listeners.delete(listener);
    if (st.listeners.size) return;
    S.streams.delete(key);
    clearInterval(st.poll);
    if (st.reqId != null && S.connected) { try { S.ib.cancelHistoricalData(st.reqId); } catch (e) { /* gone */ } }
  };
}

// ---- quotes (watchlist, alerts, paper trading): a streaming subscription per symbol, dropped when unused
async function startQuote(q) {
  if (!S.connected) return;
  try {
    const { contract } = await contractOf(q.sym);
    if (!S.connected || !S.quotes.has(q.sym)) return;
    q.reqId = S.nextId++;
    S.ib.reqMktData(q.reqId, contract, '', false, false);
  } catch (e) { q.error = e.message; for (const w of q.waiters.splice(0)) w(); }
}
async function quote(sym) {
  needConnection();
  let q = S.quotes.get(sym);
  if (!q) { q = { sym, reqId: null, waiters: [], used: 0 }; S.quotes.set(sym, q); startQuote(q); }
  q.used = Date.now();
  if (!(q.last || q.close || q.bid)) await new Promise((res) => { q.waiters.push(res); setTimeout(res, 6000); });
  if (q.error) throw err(q.error);
  const mid = q.bid > 0 && q.ask > 0 ? (q.bid + q.ask) / 2 : null, c = q.last || mid || q.close;
  if (!(c > 0)) throw err('No price from IBKR yet');
  return { c, o: q.close || c };
}
// drop quote subscriptions nobody asked about for 3 minutes (IBKR allows about 100 at once)
setInterval(() => {
  for (const [sym, q] of S.quotes) {
    if (Date.now() - q.used < 180e3) continue;
    S.quotes.delete(sym);
    if (q.reqId != null && S.connected) { try { S.ib.cancelMktData(q.reqId); } catch (e) { /* gone */ } }
  }
}, 60e3).unref();

// ---- symbol search: stocks, ETFs, indices, forex, metals, crypto, and the front-month future of an underlying
const SEC_OK = new Set(['STK', 'IND', 'CASH', 'CMDTY', 'CRYPTO']);
const label = (c) => {
  if (c.secType === 'CASH') return `${c.symbol}.${c.currency}`;
  if (c.secType === 'FUT') return (c.localSymbol || c.symbol).replace(/\s+/g, '');
  return String(c.symbol || '').replace(/\s+/g, '.');
};
const idOf = (c) => `IB:${c.secType}:${label(c).toUpperCase().replace(/[^A-Z0-9.]/g, '')}:${c.conId}`;
async function search(q) {
  needConnection();
  const list = await request('search', (ib, id) => ib.reqMatchingSymbols(id, q), 15000);
  const out = [], futs = [];
  for (const d of list) {
    const c = d.contract || {};
    if (SEC_OK.has(c.secType) && c.conId) out.push({ id: idOf(c), secType: c.secType, symbol: label(c), name: c.description || '', exchange: c.primaryExch || '', currency: c.currency || '' });
    if ((d.derivativeSecTypes || []).includes('FUT') && futs.length < 2) futs.push(c);
  }
  // futures: the nearest contract month that hasn't expired
  for (const c of futs) {
    try {
      const rows = await request('details', (ib, id) => ib.reqContractDetails(id, { symbol: c.symbol, secType: 'FUT', currency: c.currency || 'USD' }), 20000);
      const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const live = rows.filter((r) => r.contract && String(r.contract.lastTradeDateOrContractMonth || '').slice(0, 8) >= today)
        .sort((a, b) => String(a.contract.lastTradeDateOrContractMonth).localeCompare(String(b.contract.lastTradeDateOrContractMonth)));
      const f = live[0];
      if (f) {
        S.details.set(f.contract.conId, f);
        out.push({ id: idOf(f.contract), secType: 'FUT', symbol: label(f.contract), name: `${f.longName || c.description || c.symbol} · front month (${String(f.contract.lastTradeDateOrContractMonth).slice(0, 6)})`, exchange: f.contract.exchange || '', currency: f.contract.currency || '' });
      }
    } catch (e) { /* no futures permission: skip */ }
  }
  return out;
}

function status() {
  return { available, enabled: !!S.cfg.enabled, host: S.cfg.host, port: S.cfg.port, clientId: S.cfg.clientId, status: S.status, message: S.message, accounts: S.accounts, connected: S.connected };
}

module.exports = { configure, status, search, history, stream, quote, isIB, parse, TFS, enabled: () => !!S.cfg.enabled && S.connected, _state: S, _bar: bar, _test: { setLib: (m) => { IBM = m; available = true; } } };
