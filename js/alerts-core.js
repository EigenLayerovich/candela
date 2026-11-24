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
  const isMarker = (a) => a.kind === 'marker';
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

  function priceCrossed(a, prev, cur) {
    return prev != null && prev !== cur && ((prev < a.price && cur >= a.price) || (prev > a.price && cur <= a.price));
  }
  function applyPriceFire(a, cur, now = Date.now()) {
    a.active = false;
    a.triggeredAt = now;
    a.fires = (a.fires || 0) + 1;
    a.lastFired = now;
    return `🔔 ${bare(a.symbol)} crossed ${fmt(a.price)} (now ${fmt(cur)})`;
  }

  root.CandelaAlerts = { isMarker, serverEligible, evaluateMarker, applyMarkerFire, markerTitle, priceCrossed, applyPriceFire, findMarker, TF_LABEL };
})(typeof window !== 'undefined' ? window : globalThis);
