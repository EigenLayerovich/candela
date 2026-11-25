#!/usr/bin/env node
/* Candela alert server.
 *
 *   node server.js            → open http://localhost:8000
 *
 * Serves the Candela app and runs your alerts around the clock, even with the browser closed:
 * price alerts and alerts on custom-script markers, for crypto (Binance) and for stocks, ETFs and forex
 * (Twelve Data, using the free API key you enter in the app). Fired alerts are sent to ntfy (phone push),
 * Telegram and/or a webhook (Discord, Slack, anything), and shown in any open Candela tab.
 *
 * No dependencies: Node 18 or newer. It reuses the app's own indicator, script and alert code
 * (js/*.js), so alerts behave exactly like they do in the browser.
 *
 * Environment:
 *   PORT=8000               port to listen on
 *   HOST=127.0.0.1          address to listen on (only this computer by default)
 *   CANDELA_TOKEN=…         access token; required when HOST is not a loopback address
 *   CANDELA_DATA=…          where alerts, scripts and settings are stored (default: data/server-state.json)
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

if (typeof fetch !== 'function') {
  console.error('Candela server needs Node.js 18 or newer (for built-in fetch). You have ' + process.version + '.');
  process.exit(1);
}

const ROOT = __dirname;
// settings come from the environment (command line) or from start() options (the desktop app)
let PORT = +process.env.PORT || 8000;
let HOST = process.env.HOST || '127.0.0.1';
let TOKEN = process.env.CANDELA_TOKEN || '';
let DATA_FILE = process.env.CANDELA_DATA || path.join(ROOT, 'data', 'server-state.json');
const VERSION = 1;
// the app's version (package.json), so the page can tell when a newer release is out
let APP_VERSION = '';
try { APP_VERSION = require(path.join(ROOT, 'package.json')).version || ''; } catch (e) { /* not packaged with it */ }
const events = new EventEmitter(); // 'fired' (event) — the desktop app shows these as Windows notifications

// ---------------------------------------------------------------------- shared app code
globalThis.window = globalThis;
for (const f of ['indicators.js', 'script.js', 'alerts-core.js', 'data.js', 'exchanges.js']) require(path.join(ROOT, 'js', f));
const IND = globalThis.Indicators, CS = globalThis.CandelaScript, AL = globalThis.CandelaAlerts, MD = globalThis.MarketData;

const log = (...a) => console.log(new Date().toISOString().replace('T', ' ').slice(0, 19), ...a);

// ---------------------------------------------------------------------- storage
const DEFAULT_SETTINGS = { ntfy: { server: 'https://ntfy.sh', topic: '' }, telegram: { token: '', chatId: '' }, webhook: { url: '' }, discord: { url: '' }, slack: { url: '' }, twelveData: { key: '', perMin: 8, perDay: 800 } };
const CHANNELS = ['ntfy', 'telegram', 'discord', 'slack', 'webhook'];
let db = { version: VERSION, alerts: [], scripts: [], settings: clone(DEFAULT_SETTINGS), events: [] };
function clone(o) { return JSON.parse(JSON.stringify(o)); }

function loadDb() {
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    db = { ...db, ...raw, settings: { ...clone(DEFAULT_SETTINGS), ...raw.settings } };
    for (const k of Object.keys(DEFAULT_SETTINGS)) db.settings[k] = { ...DEFAULT_SETTINGS[k], ...(raw.settings || {})[k] };
  } catch (e) {
    if (e.code !== 'ENOENT') log('Could not read', DATA_FILE, '-', e.message, '(starting empty)');
  }
}
let saveTimer = null;
function saveSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 300); }
function saveNow() {
  clearTimeout(saveTimer);
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 1), { mode: 0o600 }); // holds notification tokens
    fs.renameSync(tmp, DATA_FILE);
  } catch (e) { log('Could not save', DATA_FILE, '-', e.message); }
}

// ---------------------------------------------------------------------- scripts
const scriptDefs = new Map();
function compileScript(sc) {
  try { scriptDefs.set(sc.id, CS.compile(sc.code, sc.id)); } catch (e) { scriptDefs.delete(sc.id); log(`Script "${sc.name}" does not compile: line ${e.line}: ${e.message}`); }
}

// ---------------------------------------------------------------------- notifications
async function notifyAll(settings, message, { title = 'Candela alert', fetchImpl = fetch, channels = null } = {}) {
  const jobs = [];
  const opts = (o) => ({ ...o, signal: AbortSignal.timeout(10000) });
  const want = (c) => !Array.isArray(channels) || channels.includes(c);
  const { ntfy, telegram, webhook, discord = {}, slack = {} } = settings;
  const postJson = (url, body) => fetchImpl(url, opts({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  if (discord.url && want('discord')) jobs.push(['discord', postJson(discord.url, { content: message })]);
  if (slack.url && want('slack')) jobs.push(['slack', postJson(slack.url, { text: message })]);
  if (ntfy.topic && want('ntfy')) {
    jobs.push(['ntfy', fetchImpl(`${(ntfy.server || 'https://ntfy.sh').replace(/\/+$/, '')}/${encodeURIComponent(ntfy.topic)}`,
      opts({ method: 'POST', body: message, headers: { Title: title, Tags: 'bell' } }))]);
  }
  if (telegram.token && telegram.chatId && want('telegram')) {
    jobs.push(['telegram', fetchImpl(`https://api.telegram.org/bot${telegram.token}/sendMessage`,
      opts({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: telegram.chatId, text: message }) }))]);
  }
  if (webhook.url && want('webhook')) {
    const host = new URL(webhook.url).hostname;
    const body = /(^|\.)discord(app)?\.com$/.test(host) ? { content: message }
      : /(^|\.)slack\.com$/.test(host) ? { text: message }
        : { title, message, source: 'candela', time: new Date().toISOString() };
    jobs.push(['webhook', fetchImpl(webhook.url, opts({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))]);
  }
  const settled = await Promise.allSettled(jobs.map((j) => j[1]));
  return jobs.map(([channel], i) => {
    const r = settled[i];
    if (r.status === 'rejected') return { channel, ok: false, error: r.reason && (r.reason.name === 'TimeoutError' ? 'timed out' : r.reason.message) };
    return { channel, ok: r.value.ok, error: r.value.ok ? null : `HTTP ${r.value.status}` };
  });
}
const channelsConfigured = (s = db.settings) => [s.ntfy.topic && 'ntfy', s.telegram.token && s.telegram.chatId && 'telegram', s.discord && s.discord.url && 'discord', s.slack && s.slack.url && 'slack', s.webhook.url && 'webhook'].filter(Boolean);

// ---------------------------------------------------------------------- live updates to open tabs (SSE)
const clients = new Set();
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}
const publicState = () => ({ alerts: db.alerts, events: db.events.slice(0, 50), channels: channelsConfigured() });
let stateTimer = null;
function broadcastState() { clearTimeout(stateTimer); stateTimer = setTimeout(() => broadcast('state', publicState()), 50); }

// ---------------------------------------------------------------------- firing
function fire(a, message) {
  log('FIRED', message.replace(/^🔔 /, ''));
  const ev = { id: crypto.randomUUID(), alertId: a.id, message, t: Date.now() };
  db.events.unshift(ev);
  db.events.length = Math.min(db.events.length, 100);
  saveSoon();
  broadcast('fired', ev);
  events.emit('fired', ev);
  broadcastState();
  if (!a.active) syncFeeds();
  notifyAll(db.settings, message, { channels: a.channels }).then((results) => {
    for (const r of results) if (!r.ok) log(`  ${r.channel} failed: ${r.error}`);
    if (!results.length) log('  (no notification channels set up: open the app → Alerts → server settings)');
  });
}

// an alert whose expiry date passed: switch it off and say so in the log
function expire(a) {
  const title = a.kind === 'rect' ? AL.rectTitle(a) : a.kind === 'line' ? AL.lineTitle(a) : a.kind === 'cond' ? AL.condTitle(a) : a.kind === 'marker' ? AL.markerTitle(a) : `${a.symbol} crossing ${AL.fmt(a.price)}`;
  const message = AL.expiredText(a, title);
  log(message);
  const ev = { id: crypto.randomUUID(), alertId: a.id, message, t: Date.now(), expired: true };
  db.events.unshift(ev);
  db.events.length = Math.min(db.events.length, 100);
  saveSoon();
  broadcast('fired', ev);
  broadcastState();
  syncFeeds();
}
function sweepExpired() {
  const now = Date.now();
  for (const a of db.alerts) if (a.active && a.expires && AL.gate(a, now) === 'expired') expire(a);
}

function setPaused(a, reason) {
  if ((a.paused || null) === (reason || null)) return;
  if (reason) a.paused = reason; else delete a.paused;
  saveSoon();
  broadcastState();
}

// ---------------------------------------------------------------------- marker alerts: one poller per symbol + timeframe
const feeds = new Map(); // "SYMBOL|tf" -> { symbol, tf, bars, timer, ready, errors, dead }
const feedKey = (a) => `${a.symbol}|${a.tf}`;
// alerts checked on candles: script markers and conditions
const activeMarkerAlerts = () => db.alerts.filter((a) => AL.isBar(a) && a.active && AL.serverEligible(a));
const resolveDef = (type) => (type.startsWith('script:') ? scriptDefs.get(type.slice(7)) : IND.BY_ID[type]);
const alertsOnFeed = (f) => activeMarkerAlerts().filter((a) => a.symbol === f.symbol && a.tf === f.tf);

function syncFeeds() {
  for (const a of db.alerts) if (a.tf) MD.ensureTf(a.tf); // custom timeframes
  const want = new Set(activeMarkerAlerts().map(feedKey));
  for (const [k, f] of feeds) if (!want.has(k)) { f.dead = true; clearTimeout(f.timer); feeds.delete(k); }
  for (const k of want) {
    if (feeds.has(k)) continue;
    const [symbol, tf] = k.split('|');
    const f = { symbol, tf, bars: [], timer: null, ready: false, errors: 0, dead: false };
    feeds.set(k, f);
    runFeed(f);
  }
}

function evaluate(a, bars, prime) {
  if (!prime) { const g = AL.gate(a); if (g === 'expired') return expire(a); if (g === 'off') return; }
  const cond = AL.isCond(a);
  const res = cond ? AL.evaluateCondition(a, bars, prime, resolveDef, IND.defaults) : AL.evaluateMarker(a, scriptDefs.get(a.scriptId), bars, prime, IND.defaults);
  if (res.type === 'pause') return setPaused(a, res.reason);
  if (a.paused) setPaused(a, null);
  if (res.type === 'prime') { a.lastBarT = res.t; saveSoon(); }
  if (res.type === 'fire') fire(a, cond ? AL.applyCondFire(a, res) : AL.applyMarkerFire(a, res));
}
// price alerts and line alerts, on a new price
const lastTime = {};
function checkTick(a, sym, cur, now) {
  const prev = lastPrice[sym] ?? a.refPrice, prevT = lastTime[sym] ?? (a.refPrice != null ? a.created : null);
  const g = AL.gate(a, now);
  if (g === 'expired') return expire(a);
  if (g === 'off') return;
  if (AL.isRect(a)) { const res = AL.rectCrossed(a, prev, cur, now); if (res) fire(a, AL.applyRectFire(a, cur, res, now)); }
  else if (AL.isLine(a)) { const res = AL.lineCrossed(a, prev, prevT, cur, now, now); if (res) fire(a, AL.applyLineFire(a, cur, res, now)); }
  else if (AL.priceCrossed(a, prev, cur)) fire(a, AL.applyPriceFire(a, cur));
}

async function runFeed(f) {
  f.timer = null;
  if (f.dead) return;
  const iv = MD.TF[f.tf], stock = MD.isStock(f.symbol);
  // stocks: don't spend requests while the market is closed
  if (stock && f.ready && !MD.marketOpen(f.symbol)) return scheduleFeed(f);
  try {
    const last = f.bars[f.bars.length - 1];
    const gap = stock ? 3 * 86400e3 : 4 * iv; // stocks pause overnight and at weekends; that's not a gap
    if (!f.ready || !last || Date.now() - last.t > Math.max(gap, 4 * iv)) {
      // first load, or we were asleep / offline for a while: reload and only record existing markers
      f.bars = await MD.history(f.symbol, f.tf, { limit: 1000, priority: 'live' });
      if (f.dead) return;
      f.ready = true;
      f.checkedT = f.bars.length > 1 ? f.bars[f.bars.length - 2].t : 0;
      for (const a of alertsOnFeed(f)) evaluate(a, f.bars, true);
    } else {
      const recent = await MD.history(f.symbol, f.tf, { limit: stock ? 30 : 5, priority: 'background' });
      if (f.dead) return;
      for (const b of recent) {
        const n = f.bars.length;
        if (n && f.bars[n - 1].t === b.t) f.bars[n - 1] = b;
        else if (!n || b.t > f.bars[n - 1].t) f.bars.push(b);
        else { const i = f.bars.findIndex((x) => x.t === b.t); if (i >= 0) f.bars[i] = b; }
      }
      if (f.bars.length > 1500) f.bars.splice(0, f.bars.length - 1000);
      // bar-close alerts look at every bar that closed since the last check (polling may skip a bar)
      const n = f.bars.length, closed = [];
      for (let k = n - 2; k >= 0 && f.bars[k].t > (f.checkedT || 0); k--) closed.unshift(k);
      f.checkedT = n > 1 ? f.bars[n - 2].t : f.checkedT;
      for (const a of alertsOnFeed(f)) {
        if (a.when === 'close' && closed.length > 1) for (const k of closed) evaluate(a, f.bars.slice(0, k + 2), false);
        else evaluate(a, f.bars, false);
      }
    }
    if (f.errors) log(`${f.symbol} ${f.tf}: market data is back`);
    f.errors = 0;
  } catch (e) {
    f.errors++;
    if (f.errors === 1 || f.errors % 20 === 0) log(`${f.symbol} ${f.tf}: could not load market data (${e.message}); retrying`);
  }
  scheduleFeed(f);
}

function scheduleFeed(f) {
  if (f.dead) return;
  const list = alertsOnFeed(f);
  if (!list.length) return;
  const iv = MD.TF[f.tf];
  let delay;
  const last = f.bars[f.bars.length - 1];
  if (f.errors) delay = Math.min(60000, 5000 * 2 ** Math.min(f.errors - 1, 4));
  else if (MD.isStock(f.symbol)) {
    // stocks share the free Twelve Data budget (800 requests a day) with your charts
    if (!MD.marketOpen(f.symbol)) delay = 15 * 60e3;
    else if (list.some((a) => a.when === 'bar')) delay = Math.max(5 * 60e3, MD.pollPeriod(f.symbol));
    else delay = Math.max(2 * 60e3, last ? last.t + iv - Date.now() + 5000 : 60e3);
    delay = Math.min(delay, Math.max(iv, 15 * 60e3));
  } else if (list.some((a) => a.when === 'bar')) delay = Math.min(15000, iv);
  else {
    // bar-close alerts: check just after the current bar closes
    delay = last ? last.t + iv - Date.now() + 2500 : 15000;
    delay = Math.max(2000, Math.min(delay, iv));
  }
  clearTimeout(f.timer);
  f.timer = setTimeout(() => runFeed(f), delay);
}

// ---------------------------------------------------------------------- price alerts: one batched request every 5 s
const lastPrice = {};
let symbolSet = null, symbolSetAt = 0;
async function knownSymbols() {
  if (!symbolSet || Date.now() - symbolSetAt > 6 * 3600e3) {
    try { symbolSet = new Set(await MD.allSymbols()); symbolSetAt = Date.now(); } catch (e) { /* keep old list */ }
  }
  return symbolSet;
}
async function pollPrices() {
  const list = db.alerts.filter((a) => AL.isTick(a) && a.active && AL.serverEligible(a) && !MD.isStock(a.symbol) && !MD.exchangeOf(a.symbol));
  const syms = [...new Set(list.map((a) => a.symbol))];
  if (!syms.length) return;
  let rows;
  try {
    const r = await fetch(`https://data-api.binance.vision/api/v3/ticker/price?symbols=${encodeURIComponent(JSON.stringify(syms))}`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    rows = await r.json();
  } catch (e) { return; }
  for (const row of rows) {
    const cur = +row.price;
    if (!isFinite(cur)) continue;
    const now = Date.now();
    for (const a of list) if (a.symbol === row.symbol && a.active) checkTick(a, row.symbol, cur, now);
    lastPrice[row.symbol] = cur;
    lastTime[row.symbol] = now;
  }
}

// Bybit, KuCoin, Kraken, Coinbase: one ticker request per symbol, every 6 s
let exPolling = false;
async function pollExchangePrices() {
  if (exPolling) return;
  exPolling = true;
  try {
    const list = db.alerts.filter((a) => AL.isTick(a) && a.active && MD.exchangeOf(a.symbol));
    await Promise.all([...new Set(list.map((a) => a.symbol))].map(async (sym) => {
      let cur;
      try { cur = (await MD.ticker(sym)).c; } catch (e) { return; }
      if (!isFinite(cur)) return;
      const now = Date.now();
      for (const a of list) if (a.symbol === sym && a.active) checkTick(a, sym, cur, now);
      lastPrice[sym] = cur;
      lastTime[sym] = now;
    }));
  } finally { exPolling = false; }
}

const stockPx = {}; // symbol -> { prev, lastT, lastCheck }
async function pollStockPrices() {
  if (!db.settings.twelveData.key) return;
  const list = db.alerts.filter((a) => AL.isTick(a) && a.active && MD.isStock(a.symbol));
  for (const sym of [...new Set(list.map((a) => a.symbol))]) {
    if (!MD.marketOpen(sym)) continue;
    const st = stockPx[sym] || (stockPx[sym] = { prev: null, lastT: 0, lastCheck: 0 });
    if (Date.now() - st.lastCheck < 2 * 60e3) continue;
    st.lastCheck = Date.now();
    const n = st.lastT ? Math.min(30, Math.ceil((Date.now() - st.lastT) / 60e3) + 1) : 2;
    let bars;
    try { bars = await MD.history(sym, '1m', { limit: n, priority: 'background' }); } catch (e) { continue; }
    for (const b of bars) {
      if (b.t < st.lastT) continue;
      for (const a of list) {
        if (a.symbol !== sym || !a.active) continue;
        const prev = st.prev ?? a.refPrice, g = AL.gate(a, b.t + 60e3);
        if (g === 'expired') { expire(a); continue; }
        if (g === 'off') continue;
        if (AL.isRect(a)) { const res = AL.rectCrossed(a, prev, b.c, b.t + 60e3); if (res) fire(a, AL.applyRectFire(a, b.c, res)); }
        else if (AL.isLine(a)) { const res = AL.lineCrossed(a, prev, st.prevT ?? a.created, b.c, b.t + 60e3); if (res) fire(a, AL.applyLineFire(a, b.c, res)); }
        // touched the level anywhere inside this minute?
        else if (AL.priceTouched(a, prev, b)) fire(a, AL.applyPriceFire(a, b.c));
      }
      st.prev = b.c;
      st.prevT = b.t + 60e3;
      st.lastT = b.t;
    }
  }
}

// After a script change: re-check its alerts (recording existing markers, so an edit never fires old ones).
function recheckScriptAlerts(scriptId) {
  for (const a of activeMarkerAlerts()) {
    if (scriptId && a.scriptId !== scriptId) continue;
    const f = feeds.get(feedKey(a));
    if (f && f.ready) evaluate(a, f.bars, true);
    else if (AL.isMarker(a) && !scriptDefs.get(a.scriptId)) setPaused(a, 'The script was deleted');
  }
}

// ---------------------------------------------------------------------- validation
const ID_RE = /^[A-Za-z0-9_-]{4,40}$/;
const SYMBOL_RE = /^[A-Z0-9]{2,30}$/;
const STOCK_RE = /^TD:[A-Z0-9.\-]{1,15}(\/[A-Z0-9]{2,10})?(@[A-Za-z0-9 ._\-]{1,40})?$/;
const str = (v, max = 120) => typeof v === 'string' && v.length <= max;
class BadRequest extends Error {}
function cleanParams(p) {
  if (p == null) return {};
  if (typeof p !== 'object' || Array.isArray(p) || Object.keys(p).length > 60) throw new BadRequest('params must be an object');
  const out = {};
  for (const [k, v] of Object.entries(p)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,40}$/.test(k)) throw new BadRequest('bad parameter name');
    if (!(typeof v === 'number' && isFinite(v)) && !str(v, 40) && typeof v !== 'boolean') throw new BadRequest('bad parameter value');
    out[k] = v;
  }
  return out;
}
const num = (v) => (typeof v === 'number' && isFinite(v) ? v : undefined);

async function makeAlert(b) {
  if (!b || typeof b !== 'object') throw new BadRequest('Expected an alert');
  const id = ID_RE.test(b.id || '') ? b.id : crypto.randomUUID().slice(0, 12);
  if (db.alerts.some((a) => a.id === id)) throw new BadRequest('An alert with this id already exists');
  if (MD.isStock(b.symbol || '')) {
    if (!STOCK_RE.test(b.symbol)) throw new BadRequest('Unknown symbol');
    if (!db.settings.twelveData.key) throw new BadRequest('The server has no Twelve Data key for stocks yet (open the app from the server to share it)');
    if (b.kind === 'marker' && !MD.supportsTf(b.symbol, b.tf)) throw new BadRequest('That timeframe is not available for stocks');
  } else if (MD.exchangeOf(b.symbol || '')) {
    if ((b.symbol || '').length > 40) throw new BadRequest('Unknown symbol');
  } else {
    if (!SYMBOL_RE.test(b.symbol || '')) throw new BadRequest('Unknown symbol');
    const known = await knownSymbols();
    if (known && !known.has(b.symbol)) throw new BadRequest(`${b.symbol} is not a Binance symbol`);
  }
  const base = { id, symbol: b.symbol, active: b.active !== false, created: num(b.created) || Date.now(), fires: num(b.fires) || 0 };
  if (num(b.expires) > 0) base.expires = b.expires;
  if (b.hours && typeof b.hours === 'object') {
    const H = b.hours;
    if (AL.toMin(H.from) == null || AL.toMin(H.to) == null || !str(H.tz, 64)) throw new BadRequest('Invalid active hours');
    try { new Intl.DateTimeFormat('en-US', { timeZone: H.tz }); } catch (e) { throw new BadRequest('Unknown time zone'); }
    base.hours = { from: H.from, to: H.to, days: H.days === 'weekdays' ? 'weekdays' : 'all', tz: H.tz };
  }
  if (Array.isArray(b.channels)) base.channels = b.channels.filter((c) => CHANNELS.includes(c));
  if (num(b.lastFired)) base.lastFired = b.lastFired;
  if (num(b.triggeredAt)) base.triggeredAt = b.triggeredAt;
  if (b.kind === 'cond') {
    if (typeof b.tf !== 'string' || !MD.ensureTf(b.tf)) throw new BadRequest('Unknown timeframe');
    const side = (s, allowValue) => {
      if (!s || typeof s !== 'object') throw new BadRequest('Incomplete condition');
      if (s.src === 'price') return { src: 'price' };
      if (s.src === 'value' && allowValue && num(s.value) !== undefined) return { src: 'value', value: s.value };
      if (s.src === 'ind' && str(s.type, 60) && /^(script:)?[A-Za-z0-9_-]{1,50}$/.test(s.type) && str(s.key, 20) && str(s.label, 160)) {
        return { src: 'ind', type: s.type, key: s.key, label: s.label, params: cleanParams(s.params) };
      }
      throw new BadRequest('Invalid condition');
    };
    if (!AL.OPS[b.op]) throw new BadRequest('Unknown condition');
    return {
      ...base, kind: 'cond', tf: b.tf, left: side(b.left, false), right: side(b.right, true), op: b.op,
      when: b.when === 'bar' ? 'bar' : 'close', repeat: b.repeat === 'once' ? 'once' : 'every', ...(num(b.lastBarT) ? { lastBarT: b.lastBarT } : {}),
    };
  }
  if (b.kind === 'rect') {
    const bx = b.box;
    if (!bx || !(num(bx.top) > 0) || !(num(bx.bot) > 0) || bx.top < bx.bot) throw new BadRequest('A zone alert needs a top and a bottom price');
    return {
      ...base, kind: 'rect', box: { top: bx.top, bot: bx.bot }, on: ['enter', 'exit'].includes(b.on) ? b.on : 'both', repeat: b.repeat === 'every' ? 'every' : 'once',
      name: str(b.name, 60) ? b.name : 'zone', ...(str(b.drawingId, 40) ? { drawingId: b.drawingId } : {}), ...(num(b.refPrice) ? { refPrice: b.refPrice } : {}),
    };
  }
  if (b.kind === 'line') {
    if (!Array.isArray(b.lines) || !b.lines.length || b.lines.length > 2) throw new BadRequest('A line alert needs one or two lines');
    const lines = b.lines.map((l) => {
      if (!l || !Array.isArray(l.pts) || l.pts.length !== 2 || !l.pts.every((q) => q && num(q.t) !== undefined && num(q.p) !== undefined)) throw new BadRequest('Invalid line');
      return { pts: l.pts.map((q) => ({ t: q.t, p: q.p })), ext: ['segment', 'ray', 'extended'].includes(l.ext) ? l.ext : 'segment' };
    });
    return {
      ...base, kind: 'line', lines, dir: ['up', 'down'].includes(b.dir) ? b.dir : undefined, repeat: b.repeat === 'every' ? 'every' : 'once',
      name: str(b.name, 60) ? b.name : 'line', ...(str(b.drawingId, 40) ? { drawingId: b.drawingId } : {}), ...(num(b.refPrice) ? { refPrice: b.refPrice } : {}),
    };
  }
  if (b.kind === 'marker') {
    if (typeof b.tf !== 'string' || !MD.ensureTf(b.tf)) throw new BadRequest('Unknown timeframe'); // standard or custom (2d, 3h…)
    if (!MD.supportsTf(b.symbol, b.tf)) throw new BadRequest(`The ${b.tf} timeframe is not available for ${b.symbol}`);
    if (!str(b.scriptId, 40) || !str(b.markKey, 20) || !str(b.markName) || !str(b.scriptName)) throw new BadRequest('Incomplete marker alert');
    return {
      ...base, kind: 'marker', tf: b.tf, scriptId: b.scriptId, scriptName: b.scriptName, markKey: b.markKey, markName: b.markName,
      params: cleanParams(b.params), when: b.when === 'bar' ? 'bar' : 'close', repeat: b.repeat === 'once' ? 'once' : 'every',
      ...(num(b.lastBarT) ? { lastBarT: b.lastBarT } : {}),
    };
  }
  if (!(num(b.price) > 0)) throw new BadRequest('A price alert needs a price');
  return { ...base, price: b.price, ...(['up', 'down'].includes(b.dir) ? { dir: b.dir } : {}), ...(num(b.refPrice) ? { refPrice: b.refPrice } : {}) };
}

function upsertScript(s) {
  if (!s || !ID_RE.test(s.id || '') || !str(s.name, 200) || !str(s.code, 100000)) throw new BadRequest('Invalid script');
  const cur = db.scripts.find((x) => x.id === s.id);
  if (cur && cur.code === s.code && cur.name === s.name) return false;
  if (cur) Object.assign(cur, { name: s.name, code: s.code }); else db.scripts.push({ id: s.id, name: s.name, code: s.code });
  compileScript(s);
  return true;
}

const maskSecret = (s) => (s ? '••••' + s.slice(-4) : '');
const publicSettings = () => ({
  ntfy: { ...db.settings.ntfy },
  telegram: { token: maskSecret(db.settings.telegram.token), chatId: db.settings.telegram.chatId },
  webhook: { url: db.settings.webhook.url ? db.settings.webhook.url.replace(/^(https?:\/\/[^/]+\/).+$/, '$1••••') : '' },
  discord: { url: db.settings.discord.url ? db.settings.discord.url.replace(/^(https?:\/\/[^/]+\/).+$/, '$1••••') : '' },
  slack: { url: db.settings.slack.url ? db.settings.slack.url.replace(/^(https?:\/\/[^/]+\/).+$/, '$1••••') : '' },
  twelveData: { key: maskSecret(db.settings.twelveData.key), perMin: db.settings.twelveData.perMin, perDay: db.settings.twelveData.perDay },
  configured: channelsConfigured(),
});

// ---------------------------------------------------------------------- HTTP
const PROXY_ALLOW = [
  ['api.kucoin.com', /^\/api\/v[12]\/(market\/(candles|stats|allTickers|orderbook\/level1)|symbols)$/],
  ['api.bybit.com', /^\/v5\/market\/(kline|tickers|instruments-info)$/],
  ['fapi.binance.com', /^\/fapi\/v1\/(klines|exchangeInfo|ticker\/24hr|premiumIndex|openInterest)$/],
  ['api.mexc.com', /^\/api\/v3\/(klines|ticker\/24hr|exchangeInfo)$/],
  ['api-pub.bitfinex.com', /^\/v2\/(candles\/trade:[0-9a-zA-Z]+:t[A-Z0-9:]+\/hist|ticker\/t[A-Z0-9:]+|conf\/pub:list:pair:exchange)$/],
];
const isLoopback = (h) => ['127.0.0.1', 'localhost', '::1', '0:0:0:0:0:0:0:1'].includes(h) || h.startsWith('127.');
const STATIC_TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };

function send(res, status, data, headers = {}) {
  const body = typeof data === 'string' ? data : JSON.stringify(data);
  res.writeHead(status, { 'content-type': typeof data === 'string' ? 'text/plain; charset=utf-8' : 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 1e6) { reject(new BadRequest('Request too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(new BadRequest('Invalid JSON')); } });
    req.on('error', reject);
  });
}

function tokenOk(req, url) {
  if (!TOKEN) return true;
  const given = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || url.searchParams.get('token') || '';
  const a = Buffer.from(given), b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  // only the app itself: index.html, css/ and js/ (never server.js or the data folder)
  if (!(rel === 'index.html' || /^(css|js)\/[A-Za-z0-9._-]+$/.test(rel))) return send(res, 404, 'Not found');
  const file = path.join(ROOT, rel);
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'Not found');
    // Server-Timing lets the page see that it was served by the alert server (no extra request needed)
    res.writeHead(200, { 'content-type': STATIC_TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff', 'server-timing': 'candela;desc="alert-server"' });
    res.end(req.method === 'HEAD' ? undefined : buf);
  });
}

async function handleApi(req, res, url) {
  const m = req.method, p = url.pathname;
  let mm;
  if (p === '/api/status' && m === 'GET') {
    return send(res, 200, { ok: true, app: 'candela-alert-server', version: VERSION, appVersion: APP_VERSION, alerts: db.alerts.filter((a) => a.active).length, channels: channelsConfigured(), uptime: Math.round(process.uptime()) });
  }
  if (p === '/api/events' && m === 'GET') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write(`retry: 5000\nevent: state\ndata: ${JSON.stringify(publicState())}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  // Market data from exchanges that don't let web pages call them directly (KuCoin; Bybit in some setups).
  // Only public market-data addresses on those exchanges, read-only.
  if (p === '/api/proxy' && m === 'GET') {
    let target;
    try { target = new URL(url.searchParams.get('url') || ''); } catch (e) { throw new BadRequest('Bad url'); }
    if (target.protocol !== 'https:' || target.username || target.password || target.port || !PROXY_ALLOW.some(([host, re]) => target.hostname === host && re.test(target.pathname))) {
      return send(res, 400, { error: 'Not an allowed market-data address' });
    }
    let r;
    try { r = await fetch(target, { headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(15000) }); } catch (e) { return send(res, 502, { error: 'The exchange did not answer' }); }
    const body = Buffer.from(await r.arrayBuffer());
    if (body.length > 8e6) return send(res, 502, { error: 'Reply too large' });
    res.writeHead(r.status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    return res.end(body);
  }
  if (p === '/api/state' && m === 'GET') return send(res, 200, { ...publicState(), scripts: db.scripts.map(({ id, name }) => ({ id, name })) });

  if (p === '/api/alerts' && m === 'POST') {
    const a = await makeAlert(await readJson(req));
    db.alerts.push(a);
    // record markers already on the chart so a new alert only fires on new ones
    if (AL.isBar(a)) { const f = feeds.get(feedKey(a)); if (f && f.ready) evaluate(a, f.bars, true); }
    saveSoon();
    syncFeeds();
    broadcastState();
    log('Alert added:', AL.isMarker(a) ? AL.markerTitle(a) : AL.isCond(a) ? AL.condTitle(a) : AL.isLine(a) ? AL.lineTitle(a) : `${a.symbol} crossing ${a.price}`);
    return send(res, 201, a);
  }
  if ((mm = p.match(/^\/api\/alerts\/([A-Za-z0-9_-]+)$/))) {
    const a = db.alerts.find((x) => x.id === mm[1]);
    if (!a) return send(res, 404, { error: 'No such alert' });
    if (m === 'DELETE') {
      db.alerts = db.alerts.filter((x) => x !== a);
      saveSoon(); syncFeeds(); broadcastState();
      return send(res, 200, { ok: true });
    }
    if (m === 'PUT') {
      // the alert was edited or its line dragged: replace it, keeping its place in the list
      const b = await readJson(req), i = db.alerts.indexOf(a);
      db.alerts.splice(i, 1);
      let fresh;
      try { fresh = await makeAlert({ ...b, id: a.id }); } catch (e) { db.alerts.splice(i, 0, a); throw e; }
      db.alerts.splice(i, 0, fresh);
      if (AL.isBar(fresh)) { const f = feeds.get(feedKey(fresh)); if (f && f.ready) evaluate(fresh, f.bars, true); }
      saveSoon(); syncFeeds(); broadcastState();
      log('Alert changed:', AL.isMarker(fresh) ? AL.markerTitle(fresh) : AL.isCond(fresh) ? AL.condTitle(fresh) : AL.isLine(fresh) ? AL.lineTitle(fresh) : `${fresh.symbol} crossing ${fresh.price}`);
      return send(res, 200, fresh);
    }
    if (m === 'PATCH') {
      // the browser ran this alert while the server was unreachable: take over its progress
      const b = await readJson(req);
      if (typeof b.active === 'boolean') a.active = b.active;
      for (const k of ['fires', 'lastBarT', 'lastFired', 'triggeredAt']) if (num(b[k]) !== undefined && (a[k] == null || b[k] > a[k])) a[k] = b[k];
      saveSoon(); syncFeeds(); broadcastState();
      return send(res, 200, a);
    }
  }
  if (p === '/api/scripts' && m === 'PUT') {
    const b = await readJson(req);
    if (!Array.isArray(b.scripts)) throw new BadRequest('Expected { scripts: [...] }');
    const changed = b.scripts.filter((s) => upsertScript(s)).map((s) => s.id);
    if (changed.length) { saveSoon(); for (const id of changed) recheckScriptAlerts(id); syncFeeds(); }
    return send(res, 200, { ok: true, updated: changed.length });
  }
  if ((mm = p.match(/^\/api\/scripts\/([A-Za-z0-9_-]+)$/))) {
    if (m === 'PUT') {
      const b = await readJson(req);
      if (upsertScript({ ...b, id: mm[1] })) { saveSoon(); recheckScriptAlerts(mm[1]); syncFeeds(); }
      return send(res, 200, { ok: true });
    }
    if (m === 'DELETE') {
      db.scripts = db.scripts.filter((s) => s.id !== mm[1]);
      scriptDefs.delete(mm[1]);
      saveSoon(); recheckScriptAlerts(mm[1]);
      return send(res, 200, { ok: true });
    }
  }
  if (p === '/api/settings' && m === 'GET') return send(res, 200, publicSettings());
  if (p === '/api/settings' && m === 'PUT') {
    const b = await readJson(req), s = db.settings;
    // masked values (••••) mean "keep what is stored"
    const keep = (v) => typeof v === 'string' && v.includes('••••');
    if (b.ntfy) {
      if (str(b.ntfy.topic, 64) && /^[A-Za-z0-9_-]*$/.test(b.ntfy.topic)) s.ntfy.topic = b.ntfy.topic; else if (b.ntfy.topic !== undefined) throw new BadRequest('An ntfy topic may only use letters, digits, - and _');
      if (str(b.ntfy.server, 200) && /^https?:\/\/[^\s]+$/.test(b.ntfy.server || 'https://ntfy.sh')) s.ntfy.server = b.ntfy.server || 'https://ntfy.sh';
    }
    if (b.telegram) {
      if (str(b.telegram.token, 100) && !keep(b.telegram.token)) s.telegram.token = b.telegram.token.trim();
      if (str(b.telegram.chatId, 40)) s.telegram.chatId = b.telegram.chatId.trim();
    }
    if (b.twelveData) {
      const t = b.twelveData;
      if (str(t.key, 100) && !keep(t.key) && /^[A-Za-z0-9_-]*$/.test(t.key)) s.twelveData.key = t.key.trim();
      if (num(t.perMin) > 0) s.twelveData.perMin = Math.round(t.perMin);
      if (num(t.perDay) > 0) s.twelveData.perDay = Math.round(t.perDay);
      MD.stockConfig(s.twelveData);
      syncFeeds();
    }
    for (const [k, re, name] of [['discord', /^https:\/\/(discord|discordapp)\.com\/api\/webhooks\/\S+$/, 'a Discord webhook URL (https://discord.com/api/webhooks/…)'], ['slack', /^https:\/\/hooks\.slack\.com\/\S+$/, 'a Slack webhook URL (https://hooks.slack.com/…)']]) {
      if (!b[k] || !str(b[k].url, 500) || keep(b[k].url)) continue;
      const u = b[k].url.trim();
      if (u && !re.test(u)) throw new BadRequest(`That isn't ${name}`);
      s[k].url = u;
    }
    if (b.webhook && str(b.webhook.url, 500) && !keep(b.webhook.url)) {
      if (b.webhook.url && !/^https?:\/\/[^\s]+$/.test(b.webhook.url)) throw new BadRequest('The webhook must be an http(s) URL');
      s.webhook.url = b.webhook.url.trim();
    }
    saveNow();
    broadcastState();
    return send(res, 200, publicSettings());
  }
  if (p === '/api/test-notify' && m === 'POST') {
    const results = await notifyAll(db.settings, '🔔 Test from Candela: notifications are working.');
    return send(res, 200, { results });
  }
  return send(res, 404, { error: 'Not found' });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    // Refuse requests addressed to another host name (DNS rebinding) when listening locally.
    if (isLoopback(HOST)) {
      const hostname = (req.headers.host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
      if (!isLoopback(hostname)) return send(res, 403, 'Forbidden');
    }
    if (url.pathname.startsWith('/api/')) {
      // Other websites can't use this API from your browser.
      const origin = req.headers.origin;
      if (origin) { let ok = false; try { ok = new URL(origin).host === req.headers.host; } catch (e) { /* bad origin */ } if (!ok) return send(res, 403, { error: 'Cross-origin requests are not allowed' }); }
      if (!tokenOk(req, url)) return send(res, 401, { error: 'Access token required' });
      if (['POST', 'PUT', 'PATCH'].includes(req.method) && !/^application\/json\b/i.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'Send JSON' });
      return await handleApi(req, res, url);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    return serveStatic(req, res, url.pathname);
  } catch (e) {
    if (e instanceof BadRequest) return send(res, 400, { error: e.message });
    log('Request failed:', e);
    if (!res.headersSent) send(res, 500, { error: 'Server error' });
  }
});

// Start serving the app and running alerts. Resolves with the port once listening; rejects (instead of
// exiting) if it can't start, so the desktop app can handle it.
function start(opts = {}) {
  if (opts.port !== undefined) PORT = opts.port;
  if (opts.host) HOST = opts.host;
  if (opts.token !== undefined) TOKEN = opts.token;
  if (opts.dataFile) DATA_FILE = opts.dataFile;
  if (!isLoopback(HOST) && !TOKEN) {
    return Promise.reject(new Error(`Refusing to listen on ${HOST} without an access token. Anyone who can reach it could read your\n` +
      'alert settings. Set CANDELA_TOKEN to a long random value (the app will ask for it), or keep HOST=127.0.0.1.'));
  }
  return new Promise((resolve, reject) => {
    const onError = (e) => reject(e.code === 'EADDRINUSE' ? Object.assign(new Error(`Port ${PORT} is already in use. Try: PORT=8001 node server.js`), { code: e.code }) : e);
    server.once('error', onError);
    server.listen(PORT, HOST, () => {
      server.off('error', onError);
      loadDb();
      MD.stockConfig(db.settings.twelveData);
      MD.loadBStocks().catch(() => {}); // only for nicer names in notifications (NVDAB instead of NVDABUSDT)
      db.scripts.forEach(compileScript);
      syncFeeds();
      timers.push(setInterval(pollPrices, 5000), setInterval(pollExchangePrices, 6000), setInterval(pollStockPrices, 30000), setInterval(sweepExpired, 30000),
        setInterval(() => { for (const res of clients) res.write(': keep-alive\n\n'); }, 25000));
      const port = server.address().port;
      if (!opts.quiet) {
        const shown = HOST === '127.0.0.1' || HOST === '::1' ? 'localhost' : HOST;
        log(`Candela is running at http://${shown}:${port}`);
        log(`${db.alerts.filter((a) => a.active).length} active alert(s); notifications: ${channelsConfigured().join(', ') || 'none set up yet (open the app → Alerts → Server)'}`);
        log('Leave this running to keep alerts working with the browser closed. Ctrl+C to stop.');
      }
      resolve({ port });
    });
  });
}
const timers = [];

function stop() {
  saveNow();
  for (const t of timers) clearInterval(t);
  for (const res of clients) res.end();
  return new Promise((resolve) => {
    server.close(() => resolve());
    // don't wait for idle keep-alive connections (they'd hold the app open for seconds when quitting)
    if (server.closeAllConnections) server.closeAllConnections();
    setTimeout(resolve, 1500).unref();
  });
}

if (require.main === module) {
  start().catch((e) => { console.error(e.message); process.exit(1); });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { saveNow(); log('Stopped.'); process.exit(0); });
}
module.exports = { start, stop, events, notifyAll, makeAlert, BadRequest };
