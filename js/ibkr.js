// Interactive Brokers in the browser: everything goes through Candela's server, which talks to
// IB Gateway on this computer (see ibkr.js next to server.js). Read-only: charts, quotes and search.
(function (root) {
  'use strict';
  const MD = root.MarketData;
  const TFS = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '1d', '1w', '1M'];
  const RE = /^IB:([A-Z]+):([A-Z0-9.]+):(\d+)$/;
  const isIB = (sym) => RE.test(sym || '');
  const ibParse = (sym) => { const m = RE.exec(sym || ''); return m ? { secType: m[1], label: m[2], conId: +m[3] } : null; };

  const token = () => { try { return localStorage.getItem('candela.serverToken') || ''; } catch (e) { return ''; } };
  // only a page served by Candela's server can reach IB Gateway
  const served = () => {
    if (typeof location === 'undefined' || location.protocol === 'file:') return false;
    const nav = performance.getEntriesByType && performance.getEntriesByType('navigation')[0];
    return !(nav && Array.isArray(nav.serverTiming) && !nav.serverTiming.some((e) => e.name === 'candela'));
  };
  const NEEDS_SERVER = 'Interactive Brokers works in the Candela Windows app, or when Candela is opened from its server (node server.js).';

  async function api(method, path, body) {
    if (!served()) throw Object.assign(new Error(NEEDS_SERVER), { fatal: true, needsServer: true });
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    const t = token();
    if (t) headers.authorization = 'Bearer ' + t;
    let r;
    try { r = await fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined }); } catch (e) { throw new Error('Could not reach Candela’s server'); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.error || 'HTTP ' + r.status), { status: r.status, fatal: !!j.fatal || r.status === 404 });
    return j;
  }

  // last price and previous close, for the watchlist and alerts (shared by everything asking at once)
  const quoteWait = new Map();
  function ibQuote(sym) {
    if (quoteWait.has(sym)) return quoteWait.get(sym);
    const p = api('GET', '/api/ibkr/quote?sym=' + encodeURIComponent(sym)).finally(() => setTimeout(() => quoteWait.delete(sym), 1500));
    quoteWait.set(sym, p);
    return p;
  }

  async function history(sym, tf, opts = {}) {
    const q = `sym=${encodeURIComponent(sym)}&tf=${tf}` + (opts.endTime ? '&end=' + Math.floor(opts.endTime) : '');
    const { bars } = await api('GET', '/api/ibkr/history?' + q);
    return opts.limit ? bars.slice(-opts.limit) : bars;
  }

  // live candles over server-sent events; the browser reconnects by itself if the server restarts
  function stream(sym, tf, onBar, onStatus) {
    if (!served()) { onStatus && onStatus('error', NEEDS_SERVER); return () => {}; }
    const t = token();
    const es = new EventSource(`/api/ibkr/stream?sym=${encodeURIComponent(sym)}&tf=${tf}` + (t ? '&token=' + encodeURIComponent(t) : ''));
    onStatus && onStatus('connecting');
    es.onmessage = (e) => { try { const b = JSON.parse(e.data); if (b && b.t) onBar(b); } catch (err) { /* ignore */ } };
    es.addEventListener('status', (e) => {
      try {
        const { st, msg } = JSON.parse(e.data);
        // IBKR problems (no market data subscription, gateway logged out) keep the chart, with the reason on hover
        onStatus && onStatus(st === 'error' ? 'reconnecting' : st, msg || undefined);
      } catch (err) { /* ignore */ }
    });
    es.onerror = () => { onStatus && onStatus('reconnecting', 'Lost the connection to Candela’s server'); };
    return () => es.close();
  }

  MD.registerSource(isIB, { tfs: () => TFS, history, stream });
  Object.assign(MD, {
    isIB, ibParse, ibQuote,
    ibkr: {
      TFS,
      served,
      status: () => api('GET', '/api/ibkr/status'),
      configure: (cfg) => api('PUT', '/api/ibkr', cfg),
      search: (q) => api('GET', '/api/ibkr/search?q=' + encodeURIComponent(q)).then((j) => j.results),
    },
  });
})(typeof window !== 'undefined' ? window : globalThis);
