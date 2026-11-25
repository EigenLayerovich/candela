/* Candela — alert rules shared by the browser app and the alert server (server.js), so an alert
 * behaves the same wherever it runs. Pure functions only: no I/O, no timers. */
(function (root) {
  'use strict';

  const TF_LABEL = (tf) => tf.replace(/h$/, 'H').replace(/d$/, 'D').replace(/w$/, 'W');
  // TD:AAPL → AAPL, TD:EUR/USD → EUR/USD, NVDABUSDT (Binance bStock) → NVDAB
  const bare = (sym) => {
    const md = root.MarketData;
    if (md && md.exchangeOf && md.exchangeOf(sym)) return md.displayName(sym); // KRAKEN:BTC/USD → BTC/USD (Kraken)
    if (md && md.isBStock && md.isBStock(sym)) return sym.replace(/USDT$/, '');
    return sym.replace(/^(CSV|TD):/, '').replace(/@.*$/, '');
  };
  // Kinds: price (no kind: price crossing a level), 'marker' (a script's marker), 'cond' (price or an
  // indicator against a value or another indicator), 'line' (price crossing a drawn line).
  const isMarker = (a) => a.kind === 'marker';
  const isCond = (a) => a.kind === 'cond';
  const isLine = (a) => a.kind === 'line';
  const isRect = (a) => a.kind === 'rect';
  const isBar = (a) => isMarker(a) || isCond(a); // checked on candles
  const isTick = (a) => !a.kind || isLine(a) || isRect(a); // checked on every price update
  // Live exchange symbols only: simulated (DEMO…) and imported CSV data exist only in the browser.
  const serverEligible = (a) => !/^DEMO\d*$/.test(a.symbol) && !a.symbol.startsWith('CSV:');

  function decimalsFor(price) {
    if (!isFinite(price) || price <= 0) return 2;
    return Math.max(2, Math.min(8, 4 - Math.floor(Math.log10(price))));
  }
  const fmt = (p) => (+p).toFixed(decimalsFor(p));

  function findMarker(def, a) {
    return def.plots.find((x) => x.style === 'mark' && x.key === a.markKey && x.name === a.markName) ||
      def.plots.find((x) => x.style === 'mark' && x.name === a.markName) || null;
  }

  /* What should happen to a marker alert given the latest bars?
   * prime = only record markers that already exist (on creation, startup, or after a script edit).
   * Returns { type: 'ok' | 'pause' | 'prime' | 'fire', reason?, t?, price? }. */
  function evaluateMarker(a, def, bars, prime, defaults) {
    if (!a.active) return { type: 'ok' };
    if (!def) return { type: 'pause', reason: 'The script was deleted' };
    const pl = findMarker(def, a);
    if (!pl) return { type: 'pause', reason: `The script no longer has a "${a.markName}" marker` };
    const n = bars.length;
    const i = a.when === 'close' ? n - 2 : n - 1; // bar-close alerts look at the last finished bar
    if (i < 0) return { type: 'ok' };
    let out;
    try { out = def.calc(bars, { ...defaults(def), ...a.params }); } catch (e) { return { type: 'pause', reason: `Script error: ${e.message}` }; }
    const arr = out[pl.key];
    if (!arr) return { type: 'ok' };
    const t = bars[i].t;
    if (prime) return arr[i] && a.lastBarT !== t ? { type: 'prime', t } : { type: 'ok' };
    if (!arr[i] || a.lastBarT === t) return { type: 'ok' };
    return { type: 'fire', t, price: bars[i].c };
  }

  // Apply a 'fire' result to the alert. Returns the notification text.
  function applyMarkerFire(a, res, now = Date.now()) {
    a.lastBarT = res.t;
    a.fires = (a.fires || 0) + 1;
    a.lastFired = now;
    if (a.repeat === 'once') { a.active = false; a.triggeredAt = now; }
    // name the bar, so several bars reported at once are told apart (UTC, since the server has no time zone of yours)
    const d = new Date(res.t), daily = /[dw]$/.test(a.tf);
    const bar = daily ? d.toISOString().slice(0, 10) : d.toISOString().slice(11, 16) + ' UTC';
    return `🔔 ${markerTitle(a)} · ${a.when === 'close' ? `${bar} bar closed` : 'now'} at ${fmt(res.price)}`;
  }

  const markerTitle = (a) => `${bare(a.symbol)} ${TF_LABEL(a.tf)} · ${a.scriptName}: ${a.markName}`;

  // dir: 'up' (rising through the level), 'down', or either
  function priceCrossed(a, prev, cur) {
    if (prev == null || prev === cur) return false;
    const up = prev < a.price && cur >= a.price, down = prev > a.price && cur <= a.price;
    return a.dir === 'up' ? up : a.dir === 'down' ? down : up || down;
  }
  // a candle went through the level (stock prices are checked once a minute, on 1-minute candles)
  function priceTouched(a, prev, bar) {
    if (prev == null) return false;
    const up = prev < a.price && bar.h >= a.price, down = prev > a.price && bar.l <= a.price;
    return a.dir === 'up' ? up : a.dir === 'down' ? down : up || down;
  }
  function applyPriceFire(a, cur, now = Date.now()) {
    a.active = false;
    a.triggeredAt = now;
    a.fires = (a.fires || 0) + 1;
    a.lastFired = now;
    const how = a.dir === 'up' ? 'crossed up through' : a.dir === 'down' ? 'crossed down through' : 'crossed';
    return `🔔 ${bare(a.symbol)} ${how} ${fmt(a.price)} (now ${fmt(cur)})`;
  }

  // ---- drawn lines: lines = [{ pts: [{ t, p }, { t, p }], ext: 'segment' | 'ray' | 'extended' }]
  function lineAt(l, t) {
    const [p, q] = l.pts;
    if (!p || !q || q.t === p.t) return null;
    if (l.ext === 'segment' && (t < Math.min(p.t, q.t) || t > Math.max(p.t, q.t))) return null;
    if (l.ext === 'ray' && (q.t > p.t ? t < p.t : t > p.t)) return null;
    return p.p + ((q.p - p.p) * (t - p.t)) / (q.t - p.t);
  }
  // { up, value } when the price went through one of the lines between two updates, else null
  function lineCrossed(a, prev, prevT, cur, curT, now = Date.now()) {
    if (prev == null || prevT == null) return null;
    if (a.repeat === 'every' && a.lastFired && now - a.lastFired < 60e3) return null; // at most once a minute
    for (const l of a.lines || []) {
      const v0 = lineAt(l, prevT), v1 = lineAt(l, curT);
      if (v0 == null || v1 == null) continue;
      const up = prev < v0 && cur >= v1, down = prev > v0 && cur <= v1;
      if (a.dir === 'up' ? up : a.dir === 'down' ? down : up || down) return { up, value: v1 };
    }
    return null;
  }
  function applyLineFire(a, cur, res, now = Date.now()) {
    a.fires = (a.fires || 0) + 1;
    a.lastFired = now;
    if (a.repeat !== 'every') { a.active = false; a.triggeredAt = now; }
    return `🔔 ${bare(a.symbol)} crossed ${res.up ? 'above' : 'below'} the ${a.name || 'line'} at ${fmt(res.value)} (now ${fmt(cur)})`;
  }
  const lineTitle = (a) => `${bare(a.symbol)} crossing${a.dir === 'up' ? ' up through' : a.dir === 'down' ? ' down through' : ''} ${a.name || 'line'}`;

  // ---- price zones from a rectangle: box = { top, bot }, on = 'enter' | 'exit' | 'both'
  function rectCrossed(a, prev, cur, now = Date.now()) {
    if (prev == null || !a.box) return null;
    if (a.repeat === 'every' && a.lastFired && now - a.lastFired < 60e3) return null;
    const inside = (p) => p >= a.box.bot && p <= a.box.top, was = inside(prev), is = inside(cur);
    if (!was && is && a.on !== 'exit') return { enter: true, from: prev > a.box.top ? 'above' : 'below' };
    if (was && !is && a.on !== 'enter') return { enter: false, from: cur > a.box.top ? 'above' : 'below' };
    return null;
  }
  function applyRectFire(a, cur, res, now = Date.now()) {
    a.fires = (a.fires || 0) + 1;
    a.lastFired = now;
    if (a.repeat !== 'every') { a.active = false; a.triggeredAt = now; }
    const zone = `${a.name || 'zone'} ${fmt(a.box.bot)}–${fmt(a.box.top)}`;
    return res.enter ? `🔔 ${bare(a.symbol)} entered the ${zone} from ${res.from} (now ${fmt(cur)})` : `🔔 ${bare(a.symbol)} left the ${zone}, ${res.from} it (now ${fmt(cur)})`;
  }
  const rectTitle = (a) => `${bare(a.symbol)} ${a.on === 'enter' ? 'entering' : a.on === 'exit' ? 'leaving' : 'entering or leaving'} the ${a.name || 'zone'} ${fmt(a.box.bot)}–${fmt(a.box.top)}`;

  // ---- when an alert may fire: an expiry date, and active hours ({ from: 'HH:MM', to: 'HH:MM', days: 'all' | 'weekdays', tz })
  const fmtCache = {};
  function localParts(now, tz) {
    const f = fmtCache[tz] || (fmtCache[tz] = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', hour: '2-digit', minute: '2-digit', weekday: 'short' }));
    const P = Object.fromEntries(f.formatToParts(new Date(now)).map((x) => [x.type, x.value]));
    return { min: (+P.hour % 24) * 60 + +P.minute, wd: P.weekday };
  }
  const toMin = (s) => { const m = /^(\d{1,2}):(\d{2})$/.exec(s || ''); return m ? +m[1] * 60 + +m[2] : null; };
  function inHours(h, now) {
    let L;
    try { L = localParts(now, h.tz || 'UTC'); } catch (e) { return true; }
    if (h.days === 'weekdays' && (L.wd === 'Sat' || L.wd === 'Sun')) return false;
    const f = toMin(h.from), t = toMin(h.to);
    if (f == null || t == null || f === t) return true;
    return f < t ? L.min >= f && L.min < t : L.min >= f || L.min < t; // overnight windows wrap
  }
  // 'ok', 'off' (outside its hours: not checked now) or 'expired' (turned off here)
  function gate(a, now = Date.now()) {
    if (a.expires && now >= a.expires) { if (a.active) { a.active = false; a.expiredAt = now; } return 'expired'; }
    if (a.hours && !inHours(a.hours, now)) return 'off';
    return 'ok';
  }
  const expiredText = (a, title) => `⏹ Alert expired: ${title}`;

  // ---- conditions: left / right = { src: 'price' } | { src: 'value', value } | { src: 'ind', type, params, key, label }
  const OPS = { cross: 'crossing', crossup: 'crossing up', crossdown: 'crossing down', gt: 'greater than', lt: 'less than' };
  const sideLabel = (s) => (s.src === 'price' ? 'Price' : s.src === 'value' ? (Number.isInteger(s.value) ? String(s.value) : fmt(s.value)) : s.label);
  const condTitle = (a) => `${bare(a.symbol)} ${TF_LABEL(a.tf)} · ${sideLabel(a.left)} ${OPS[a.op] || a.op} ${sideLabel(a.right)}`;
  function seriesOf(side, bars, resolve, defaults) {
    if (side.src === 'price') return bars.map((b) => b.c);
    if (side.src === 'value') return bars.map(() => side.value);
    const def = resolve(side.type);
    if (!def) throw new Error(side.type.startsWith('script:') ? 'The script was deleted' : 'Unknown indicator');
    const arr = (def.calc(bars, { ...defaults(def), ...side.params }) || {})[side.key];
    if (!arr) throw new Error(`"${side.label}" is no longer part of this indicator`);
    return arr;
  }
  function condHit(op, l0, r0, l1, r1) {
    if (![l1, r1].every(Number.isFinite)) return false;
    if (op === 'gt') return l1 > r1;
    if (op === 'lt') return l1 < r1;
    if (![l0, r0].every(Number.isFinite)) return false;
    const up = l0 <= r0 && l1 > r1, down = l0 >= r0 && l1 < r1;
    return op === 'crossup' ? up : op === 'crossdown' ? down : up || down;
  }
  // Like evaluateMarker. resolve(type) gives the indicator definition (built-in or script).
  function evaluateCondition(a, bars, prime, resolve, defaults) {
    if (!a.active) return { type: 'ok' };
    const n = bars.length, i = a.when === 'close' ? n - 2 : n - 1;
    if (i < 1) return { type: 'ok' };
    let L, R;
    try { L = seriesOf(a.left, bars, resolve, defaults); R = seriesOf(a.right, bars, resolve, defaults); } catch (e) { return { type: 'pause', reason: e.message }; }
    const hit = condHit(a.op, L[i - 1], R[i - 1], L[i], R[i]), t = bars[i].t;
    if (prime) return hit && a.lastBarT !== t ? { type: 'prime', t } : { type: 'ok' };
    if (!hit || a.lastBarT === t) return { type: 'ok' };
    return { type: 'fire', t, price: bars[i].c, value: L[i] };
  }
  function applyCondFire(a, res, now = Date.now()) {
    a.lastBarT = res.t;
    a.fires = (a.fires || 0) + 1;
    a.lastFired = now;
    if (a.repeat === 'once') { a.active = false; a.triggeredAt = now; }
    const d = new Date(res.t), daily = /[dwM]$/.test(a.tf);
    const bar = daily ? d.toISOString().slice(0, 10) : d.toISOString().slice(11, 16) + ' UTC';
    const val = a.left.src === 'ind' ? `, ${a.left.label} ${fmt(res.value)}` : '';
    return `🔔 ${condTitle(a)} · ${a.when === 'close' ? `${bar} bar closed` : 'now'} (price ${fmt(res.price)}${val})`;
  }

  root.CandelaAlerts = {
    isMarker, isCond, isLine, isBar, isTick, serverEligible, evaluateMarker, applyMarkerFire, markerTitle, priceCrossed, priceTouched, applyPriceFire, findMarker, TF_LABEL,
    lineAt, lineCrossed, applyLineFire, lineTitle, OPS, condTitle, evaluateCondition, applyCondFire, fmt,
    isRect, rectCrossed, applyRectFire, rectTitle, gate, inHours, toMin, expiredText,
  };
})(typeof window !== 'undefined' ? window : globalThis);
