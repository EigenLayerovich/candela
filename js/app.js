/* Candela — application shell: multi-chart layouts, toolbar, symbol search, watchlist, alerts,
 * dialogs, persistence. Each chart in the layout is a "slot" with its own symbol, timeframe,
 * chart type, indicators and live data stream; the top bar always acts on the active slot. */
(function () {
  'use strict';
  const { Chart, decimalsFor } = window.CandelaChart;
  const MD = window.MarketData, IND = window.Indicators;
  const $ = (s, el = document) => el.querySelector(s);
  const h = (tag, attrs = {}, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, '');
      else if (v !== false && v != null) el.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid != null) el.append(kid.nodeType ? kid : document.createTextNode(kid));
    return el;
  };
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  // display name: AAPL, EUR/USD, BTCUSDT, NVDAB (a Binance bStock)
  const bare = (sym) => MD.exDisplay(sym) || (MD.isBStock(sym) ? sym.replace(/USDT$/, '') : sym.replace(/^(CSV|TD):/, '').replace(/@.*$/, ''));
  const isStock = (sym) => sym.startsWith('TD:');
  const exOf = (sym) => MD.exchangeOf(sym); // Bybit, KuCoin, Kraken or Coinbase (null for Binance and the rest)
  // bare name plus the exchange, for lists that mix exchanges: "BTC/USD · Kraken"
  const symLabel = (sym) => (exOf(sym) ? `${bare(sym)} · ${exOf(sym).name}` : bare(sym));
  // "$5.75B", "$812.4M"
  const money = (v) => (v >= 1e9 ? `$${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : `$${Math.round(v / 1e3)}K`);
  function futuresInfo(t, chart) {
    const parts = [];
    if (isFinite(t.funding)) {
      let f = `Funding ${t.funding >= 0 ? '+' : ''}${(t.funding * 100).toFixed(4)}%`;
      const left = t.nextFunding - Date.now();
      if (left > 0) f += ` · next in ${Math.floor(left / 3600e3)}h ${Math.floor((left % 3600e3) / 60e3)}m`;
      parts.push(f);
    }
    if (isFinite(t.mark)) parts.push(`Mark ${chart.fmtPrice(t.mark)}`);
    if (isFinite(t.index)) parts.push(`Index ${chart.fmtPrice(t.index)}`);
    if (isFinite(t.oiValue) && t.oiValue > 0) parts.push(`Open interest ${money(t.oiValue)}`);
    return parts.join('   ');
  }
  const isDemo = (sym) => /^DEMO\d*$/.test(sym);
  const uid = () => Math.random().toString(36).slice(2, 10);
  const CMP_COLORS = ['#F5A623', '#E040FB', '#2EC4B6', '#FF7043', '#9C6ADE'];
  const MAX_COMPARES = 5;

  // Close of the most recent comparison bar at or before each main bar (NaN before its history starts
  // or once its data has ended).
  function alignCloses(main, cb, cbInterval) {
    const out = new Array(main.length);
    let j = -1;
    for (let i = 0; i < main.length; i++) {
      const t = main[i].t;
      while (j + 1 < cb.length && cb[j + 1].t <= t) j++;
      out[i] = j < 0 || (j === cb.length - 1 && t - cb[j].t > 2 * cbInterval) ? NaN : cb[j].c;
    }
    return out;
  }

  // ------------------------------------------------------------------ layouts
  // cells: [col, row, colSpan, rowSpan] on a cols × rows grid, used for both CSS and the menu icons
  const LAYOUTS = {
    '1': { name: 'Single chart', cols: 1, rows: 1, cells: [[0, 0, 1, 1]] },
    '2v': { name: '2 side by side', cols: 2, rows: 1, cells: [[0, 0, 1, 1], [1, 0, 1, 1]] },
    '2h': { name: '2 stacked', cols: 1, rows: 2, cells: [[0, 0, 1, 1], [0, 1, 1, 1]] },
    '3v': { name: '3 side by side', cols: 3, rows: 1, cells: [[0, 0, 1, 1], [1, 0, 1, 1], [2, 0, 1, 1]] },
    '3l': { name: '1 large + 2', cols: 2, rows: 2, cells: [[0, 0, 1, 2], [1, 0, 1, 1], [1, 1, 1, 1]] },
    '3t': { name: '1 wide + 2', cols: 2, rows: 2, cells: [[0, 0, 2, 1], [0, 1, 1, 1], [1, 1, 1, 1]] },
    '4': { name: '2 × 2 grid', cols: 2, rows: 2, cells: [[0, 0, 1, 1], [1, 0, 1, 1], [0, 1, 1, 1], [1, 1, 1, 1]] },
    '4v': { name: '4 side by side', cols: 4, rows: 1, cells: [[0, 0, 1, 1], [1, 0, 1, 1], [2, 0, 1, 1], [3, 0, 1, 1]] },
    '6': { name: '3 × 2 grid', cols: 3, rows: 2, cells: [[0, 0, 1, 1], [1, 0, 1, 1], [2, 0, 1, 1], [0, 1, 1, 1], [1, 1, 1, 1], [2, 1, 1, 1]] },
  };
  const LAYOUT_ORDER = ['1', '2v', '2h', '3v', '3l', '3t', '4', '4v', '6']; // object key order would put '1','4','6' first

  function layoutIcon(key) {
    const L = LAYOUTS[key], W = 22, H = 16, g = 1.6;
    const cw = (W - g * (L.cols - 1)) / L.cols, rh = (H - g * (L.rows - 1)) / L.rows;
    const rects = L.cells.map(([c, r, cs, rs]) =>
      `<rect x="${1 + c * (cw + g)}" y="${4 + r * (rh + g)}" width="${cs * cw + (cs - 1) * g}" height="${rs * rh + (rs - 1) * g}" rx="1.2"/>`).join('');
    return `<svg viewBox="0 0 24 24" class="layout-ico">${rects}</svg>`;
  }

  // ------------------------------------------------------------------ state
  const LS_KEY = 'candela.v1';
  const DEFAULT_INDICATORS = [
    { type: 'vol' }, { type: 'ema', params: { length: 20 } }, { type: 'ema', params: { length: 50 }, colors: { ma: '#F5A623' } },
    { type: 'rsi' }, { type: 'macd' },
  ];
  const DEFAULTS = {
    theme: window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark',
    magnet: false, sideOpen: window.innerWidth > 900,
    layout: '1', active: 0,
    sync: { symbol: false, interval: false, crosshair: true, time: false },
    charts: [{ symbol: 'BTCUSDT', tf: '1h', chartType: 'candles', log: false, indicators: DEFAULT_INDICATORS }],
    drawings: {}, alerts: [],
    scripts: [], scriptDrafts: {}, // custom indicator scripts and unsaved edits
    stocks: { key: '', perMin: 8, perDay: 800 }, // Twelve Data (stocks, ETFs, forex)
    serverDeletes: [], serverScriptDeletes: [], // changes to send to the alert server when it is back
    exNotes: {}, searchSrc: 'ALL', showAcross: true,
    customTfs: [], // your own timeframes: "2d", "3h", "2w"…
    toolGroups: {}, // the tool each toolbar group shows (the last one used)
    favTools: [], // starred drawing tools (the heart menu)
    watchlist: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT', 'ADAUSDT', 'LINKUSDT', 'AVAXUSDT', 'LTCUSDT'],
  };
  function loadState() {
    let s = null;
    try { s = JSON.parse(localStorage.getItem(LS_KEY)); } catch (e) { /* ignore */ }
    const st = { ...clone(DEFAULTS), ...(s && typeof s === 'object' ? s : {}) };
    if (s && !s.charts && s.symbol) {
      // migrate the single-chart format
      st.charts = [{ symbol: s.symbol, tf: s.tf || '1h', chartType: s.chartType || 'candles', log: !!s.log, indicators: s.indicators || DEFAULT_INDICATORS }];
    }
    for (const k of ['symbol', 'tf', 'chartType', 'log', 'indicators']) delete st[k];
    st.sync = { ...DEFAULTS.sync, ...st.sync };
    if (!LAYOUTS[st.layout]) st.layout = '1';
    return st;
  }
  // Set by the single-file preview build, where the sandbox blocks exchange connections.
  const PREVIEW = !!window.CANDELA_PREVIEW;
  const state = loadState();
  if (!state.exNotes || typeof state.exNotes !== 'object') state.exNotes = {};
  if (!Array.isArray(state.customTfs)) state.customTfs = [];
  state.customTfs = state.customTfs.filter((tf) => MD.ensureTf(tf));
  for (const c of state.charts) {
    if (!MD.ensureTf(c.tf)) c.tf = '1h';
    for (const i of c.indicators || []) if (i.tf && !MD.ensureTf(i.tf)) delete i.tf;
  }
  // Opened from Candela's server (the Windows app or `node server.js`): exchanges that don't allow web
  // pages to load their data (KuCoin) go through the server.
  (() => {
    if (PREVIEW || location.protocol === 'file:') return;
    const nav = performance.getEntriesByType && performance.getEntriesByType('navigation')[0];
    if (nav && Array.isArray(nav.serverTiming) && nav.serverTiming.some((e) => e.name === 'candela')) {
      let token = '';
      try { token = localStorage.getItem('candela.serverToken') || ''; } catch (e) { /* ignore */ }
      MD.setProxy('/api/proxy', token);
    }
  })();
  for (const [i, c] of state.charts.entries()) {
    if (PREVIEW) c.symbol = i ? 'DEMO' + (i + 1) : 'DEMO';
    else if (c.symbol.startsWith('CSV:')) c.symbol = 'BTCUSDT'; // CSV data isn't persisted
  }
  if (PREVIEW) state.sideOpen = false;
  let saveTimer;
  const flush = () => { clearTimeout(saveTimer); try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ } };
  const save = () => { clearTimeout(saveTimer); saveTimer = setTimeout(flush, 250); };
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });

  const csvData = {};
  state.stocks = { key: '', perMin: 8, perDay: 800, ...state.stocks };
  MD.stockConfig(state.stocks);
  const quotes = {}, lastPx = {};
  document.documentElement.dataset.theme = state.theme;

  // ------------------------------------------------------------------ custom script registry
  const CS = window.CandelaScript;
  const AL = window.CandelaAlerts;
  const scriptDefs = new Map(); // script id -> compiled indicator definition
  function compileSaved(sc) {
    try { const d = CS.compile(sc.code, sc.id); scriptDefs.set(sc.id, d); return d; } catch (e) { scriptDefs.delete(sc.id); return null; }
  }
  state.scripts.forEach(compileSaved);
  const resolveDef = (type) => (type && type.startsWith('script:') ? scriptDefs.get(type.slice(7)) : IND.BY_ID[type]) || null;

  // ------------------------------------------------------------------ slots
  let slots = [];
  let active = null;
  let syncing = false;

  class Slot {
    constructor(cfg) {
      this.cfg = cfg;
      this.el = h('div', { class: 'slot' });
      this.chartEl = h('div', { class: 'chart' });
      this.drawBar = h('div', { class: 'draw-bar hidden' });
      this.el.append(this.chartEl, this.drawBar);
      $('#charts').appendChild(this.el);
      // any click inside a chart makes it the active one (capture phase, before the chart reacts)
      this.el.addEventListener('pointerdown', () => setActive(this), true);
      this.el.addEventListener('contextmenu', () => setActive(this), true);

      const c = this.chart = new Chart(this.chartEl);
      c.setTheme(state.theme);
      c.magnet = state.magnet;
      c.main.log = !!cfg.log;
      c.chartType = cfg.chartType || 'candles';
      c.brickOpts = clone(cfg.brick || {}); // Renko / Kagi / P&F box size and reversal
      for (const s of cfg.indicators || []) {
        const def = resolveDef(s.type);
        if (def) c.addIndicator(def, s.params || {}, { colors: s.colors, visible: s.visible, weight: s.weight, tf: s.tf, styles: s.styles });
      }
      c.percentMode = !!cfg.percent;
      c.onCompareAction = (act, id) => {
        const cc = (this.cfg.compares || []).find((x) => x.id === id);
        if (!cc) return;
        if (act === 'remove') this.removeCompare(id);
        else if (act === 'toggle') { cc.visible = cc.visible === false; c.updateCompare(id, { visible: cc.visible }); save(); if (this === active) updateHeader(); }
        else if (act === 'settings') openCompareSettings(this, cc);
      };
      c.onLegendAction = (act, id) => {
        if (act === 'remove') { c.removeIndicator(id); this.persistIndicators(); }
        else if (act === 'toggle') { c.toggleIndicator(id); this.persistIndicators(); }
        else if (act === 'settings') openIndicatorSettings(this, id);
        else if (act === 'alert') { setActive(this); const ind = c.indicators.find((i) => i.id === id); if (ind) openAlertDialog(undefined, { ind }); }
      };
      c.onLayoutChange = () => this.persistIndicators();
      c.onDrawingsChange = () => drawingsChanged(this);
      c.onToolDone = () => setActiveTool('cursor');
      c.onSelect = (d) => this.showDrawBar(d);
      c.onNeedHistory = () => this.loadOlder();
      c.onContextMenu = (info) => showContextMenu(this, info);
      c.askText = (v) => askText('Text note', v, 'Type your note');
      c.onCrosshairMove = (t) => {
        if (!state.sync.crosshair) return;
        for (const s of slots) if (s !== this) s.chart.setSyncTime(t);
      };
      c.onViewChange = () => {
        if (!state.sync.time || syncing || slots.length < 2) return;
        syncing = true;
        const v = c.getTimeView();
        for (const s of slots) if (s !== this) s.chart.setTimeView(v);
        syncing = false;
      };

      this.mode = 'live';
      this.gen = 0;
      this.stop = null;
      this.loadingOlder = false;
      this.noMore = false;
      this.status = 'loading';
      this.cmps = new Map(); // compare id -> { c, bars, interval, stop, noMore }
      this.tfFeeds = new Map(); // timeframe -> candles for indicators set to another timeframe
      c.tfKey = cfg.tf;
    }

    get symbol() { return this.cfg.symbol; }
    get tf() { return this.cfg.tf; }

    destroy() {
      this.gen++;
      if (this.stop) this.stop();
      this.stopCompares();
      this.stopTfFeeds();
      this.stopInfo();
      this.chart.destroy();
      this.el.remove();
    }

    setStatus(s, detail) {
      this.status = s;
      this.statusDetail = detail;
      if (this === active) renderStatus();
    }

    persistIndicators() {
      const c = this.chart, order = (i) => c.panes.indexOf(i.pane);
      this.cfg.indicators = [...c.indicators].sort((a, b) => order(a) - order(b)).map((i) => ({
        type: i.def.id, params: i.params, colors: i.colors, visible: i.visible, tf: i.tf || undefined,
        styles: Object.keys(i.styles || {}).length ? i.styles : undefined,
        weight: i.pane === c.main ? undefined : +i.pane.weight.toFixed(3),
      }));
      save();
      if (this.status !== 'loading') this.syncTfFeeds();
    }

    // ---- perpetual futures: funding rate, mark price and open interest under the title, every 15 s
    startInfo() {
      this.stopInfo();
      const ex = exOf(this.symbol);
      if (!ex || !ex.futures || this.mode !== 'live') return;
      const sym = this.symbol, c = this.chart;
      const tick = async () => {
        let t = null;
        try { t = await MD.ticker(sym); } catch (e) { /* keep the last line */ }
        if (this.symbol !== sym || !this.infoTimer) return;
        if (t) c.setInfo(futuresInfo(t, c));
        this.infoTimer = setTimeout(tick, 15000);
      };
      this.infoTimer = setTimeout(tick, 0);
    }
    stopInfo() {
      clearTimeout(this.infoTimer);
      this.infoTimer = null;
      this.chart.setInfo('');
    }

    // ---- indicators set to another timeframe (a daily SMA on a 4H chart…): that timeframe's candles
    stopTfFeeds() {
      for (const f of this.tfFeeds.values()) { f.dead = true; clearTimeout(f.retry); if (f.stop) f.stop(); }
      this.tfFeeds.clear();
    }
    syncTfFeeds() {
      const want = new Set(this.chart.neededTfs());
      for (const [tf, f] of this.tfFeeds) if (!want.has(tf)) { f.dead = true; clearTimeout(f.retry); if (f.stop) f.stop(); this.tfFeeds.delete(tf); }
      for (const tf of want) if (!this.tfFeeds.has(tf)) this.startTfFeed(tf);
    }
    setIndicatorTf(id, tf) {
      this.chart.setIndicatorTf(id, tf);
      this.syncTfFeeds();
    }
    async startTfFeed(tf) {
      const c = this.chart, sym = this.symbol;
      const f = { tf, bars: [], stop: null, dead: false, noMore: false, local: this.mode !== 'live', retry: null };
      this.tfFeeds.set(tf, f);
      const alive = () => !f.dead && this.tfFeeds.get(tf) === f;
      if (f.local) {
        // simulated or imported data: only longer timeframes, built from the chart's own candles
        if (MD.TF[tf] <= c.interval) c.setTfSource(tf, null, `${tfName(tf)} needs live data (this chart's data is ${this.mode === 'csv' ? 'imported' : 'simulated'})`);
        else { f.bars = MD.resample(c.raw, tf); c.setTfSource(tf, f.bars); }
        return;
      }
      if (!MD.supportsTf(sym, tf)) { c.setTfSource(tf, null, `${tfName(tf)} isn't available for ${bare(sym)}`); return; }
      c.setTfSource(tf, null); // loading
      try {
        f.bars = await MD.history(sym, tf, { limit: 1000 });
      } catch (e) {
        if (!alive()) return;
        c.setTfSource(tf, null, e.fatal || e.budget || e.needsKey ? e.message : `couldn't load ${tfName(tf)} candles; retrying`);
        if (!e.fatal) f.retry = setTimeout(() => { if (alive()) { this.tfFeeds.delete(tf); this.syncTfFeeds(); } }, 30000);
        return;
      }
      if (!alive()) return;
      c.setTfSource(tf, f.bars);
      await this.fillTfHistory(f);
      if (!alive()) return;
      f.stop = MD.stream(sym, tf, (b) => {
        if (!alive()) return;
        const n = f.bars.length;
        if (n && f.bars[n - 1].t === b.t) f.bars[n - 1] = b;
        else if (!n || b.t > f.bars[n - 1].t) f.bars.push(b);
        else { const i = f.bars.findIndex((x) => x.t === b.t); if (i < 0) return; f.bars[i] = b; }
        c.setTfSource(tf, f.bars);
      });
    }
    // older candles until they reach well before the chart's first bar (so a 200-day average is ready there)
    async fillTfHistory(f) {
      if (f.local || f.filling) return;
      f.filling = true;
      const stock = isStock(this.symbol);
      try {
        for (let k = 0; k < (stock ? 1 : 12) && !f.noMore && !f.dead && f.bars.length; k++) {
          const main = this.chart.raw;
          if (!main.length || f.bars[0].t <= main[0].t - 300 * MD.TF[f.tf]) break;
          let older;
          try { older = await MD.history(this.symbol, f.tf, { limit: stock ? 5000 : 1000, endTime: f.bars[0].t - 1 }); } catch (e) { break; }
          if (f.dead) return;
          const add = older.filter((b) => b.t < f.bars[0].t);
          if (!add.length) { f.noMore = true; break; }
          f.bars = add.concat(f.bars);
          this.chart.setTfSource(f.tf, f.bars);
        }
      } finally { f.filling = false; }
    }
    refreshLocalTfs() {
      for (const f of this.tfFeeds.values()) if (f.local && f.bars.length) { f.bars = MD.resample(this.chart.raw, f.tf); this.chart.setTfSource(f.tf, f.bars); }
    }

    title() {
      const sym = this.symbol;
      const tfLabel = sym.startsWith('CSV:') ? '' : ' · ' + tfName(this.tf);
      const meta = isStock(sym) && MD.stockMeta(sym);
      const src = isDemo(sym) ? ' · SIMULATED' : this.mode === 'demo' ? ' · DEMO DATA' : sym.startsWith('CSV:') ? ' · CSV'
        : isStock(sym) ? ' · ' + (MD.isForex(sym) ? 'FOREX' : (meta && meta.exchange) || 'STOCKS') : MD.isBStock(sym) ? ' · BINANCE bSTOCK'
        : exOf(sym) ? ' · ' + exOf(sym).name.toUpperCase() : ' · BINANCE';
      return bare(sym) + tfLabel + src;
    }

    async load(sym, tf = this.tf) {
      const gen = ++this.gen, c = this.chart;
      if (!MD.ensureTf(tf)) tf = '1h';
      if (!MD.supportsTf(sym, tf)) {
        const near = MD.nearestTf(sym, tf);
        toast(`${tfName(tf)} isn't available for stocks and forex, showing ${tfName(near)}.`, 'info', 3500);
        tf = near;
      }
      if (this.stop) this.stop();
      this.stop = null;
      c.live = false;
      this.stopCompares();
      this.stopTfFeeds();
      c.clearTfSources();
      this.stopInfo();
      this.cfg.symbol = sym;
      this.cfg.tf = tf;
      c.tfKey = tf;
      // a symbol can't be compared with itself
      if ((this.cfg.compares || []).some((x) => x.symbol === sym)) this.cfg.compares = this.cfg.compares.filter((x) => x.symbol !== sym);
      save();
      if (this === active) updateHeader();
      this.setStatus('loading');
      c.message = `Loading ${bare(sym)}…`;
      c.setData([], MD.TF[tf] || 3600e3);
      this.noMore = false;
      c.select(null);
      c.drawings = state.drawings[sym] || [];
      refreshAlerts();

      let bars, interval = MD.TF[tf];
      if (sym.startsWith('CSV:')) {
        const ds = csvData[sym];
        if (!ds) return this.load('BTCUSDT', '1h');
        bars = ds.bars; interval = ds.interval; this.mode = 'csv'; this.noMore = true;
      } else if (isDemo(sym)) {
        bars = MD.demoBars(tf, 1500, sym); this.mode = 'demo'; this.noMore = true;
      } else if (exOf(sym)) {
        const ex = exOf(sym);
        try {
          bars = await MD.history(sym, tf, { limit: 1000 });
          if (!bars.length) throw Object.assign(new Error(`No ${tfName(tf)} data for ${bare(sym)} on ${ex.name}`), { fatal: true });
          this.mode = 'live';
          // Kraken has no older candles to scroll back to
          if (ex.historyNote && !state.exNotes[ex.id]) { state.exNotes[ex.id] = 1; save(); toast(ex.historyNote, 'info', 6000); }
        } catch (e) {
          if (gen !== this.gen) return;
          c.title = this.title();
          c.message = e.fatal ? e.message : `${bare(sym)}: could not reach ${ex.name}. Check your connection.`;
          this.setStatus('error');
          c.setData([], MD.TF[tf]);
          c.invalidate();
          return;
        }
      } else if (isStock(sym)) {
        try {
          bars = await MD.history(sym, tf, { limit: 1000 });
          if (!bars.length) throw Object.assign(new Error(`No data for ${bare(sym)}`), { fatal: true });
          this.mode = 'live';
        } catch (e) {
          if (gen !== this.gen) return;
          // no silent fallback to fake data for stocks: say what's wrong
          c.title = this.title();
          if (e.needsKey) { c.message = `${bare(sym)}: stock and forex data need a free Twelve Data API key. Click "Needs API key" at the top right.`; this.setStatus('needskey'); if (this === active) openStockSettings(); }
          else if (e.budget) { c.message = e.message; this.setStatus('limit'); }
          else { c.message = `${bare(sym)}: ${e.fatal ? e.message : 'could not reach Twelve Data. Check your connection.'}`; this.setStatus('error'); }
          c.setData([], MD.TF[tf]);
          c.invalidate();
          return;
        }
      } else {
        try {
          bars = await MD.history(sym, tf, { limit: 1000 });
          this.mode = 'live';
          if (!bars.length) throw Object.assign(new Error('No data'), { fatal: true });
        } catch (e) {
          if (gen !== this.gen) return;
          if (e.fatal) {
            toast(`Symbol "${sym}" not found on Binance`, 'error');
            if (sym !== 'BTCUSDT') return this.load('BTCUSDT', tf);
          }
          if (!demoWarned) { demoWarned = true; toast('Could not reach Binance, so charts are showing simulated demo data.', 'warn', 6000); }
          bars = MD.demoBars(tf); this.mode = 'demo'; this.noMore = true;
        }
      }
      if (gen !== this.gen) return;
      c.title = this.title();
      c.countdown = !isStock(sym) && !/M$/.test(tf); // stock bars don't close on the clock (sessions, closed markets)
      c.setData(bars, interval, { resetView: true });
      if (this === active) updateHeader();
      if (this.mode === 'live') {
        c.live = true;
        this.stop = MD.stream(sym, tf, (b) => this.onBar(b), (s, detail) => { if (gen === this.gen) this.setStatus(s, detail); });
      } else if (this.mode === 'demo') {
        c.live = true;
        this.stop = MD.demoStream(tf, () => c.raw[c.raw.length - 1], (b) => this.onBar(b));
        this.setStatus('demo');
      } else this.setStatus('static');
      const last = bars[bars.length - 1];
      if (last) { lastPx[sym] = last.c; if (this === active) updateDocTitle(); }
      this.startCompares();
      this.syncTfFeeds();
      this.startInfo();
      primeChartAlerts(this);
      if (MD.isBStock(sym) && !state.bstockNoteSeen) {
        state.bstockNoteSeen = true;
        save();
        const t = MD.bStockTicker(sym);
        toast(`${bare(sym)} is a Binance bStock: a token backed 1:1 by one ${t} share, with free live data. During US market hours it tracks ${t} closely (within about 0.1–0.5% in our check). It also trades at night and on weekends, when the stock market is closed, so those candles are Binance prices, not ${t}'s. Its volume is only Binance trading, and its history starts at its 2026 listing.`, 'info', 20000);
      }
      // join an existing time-synced layout
      if (state.sync.time && slots.length > 1) {
        const other = slots.find((s) => s !== this && s.chart.bars.length);
        if (other) c.setTimeView(other.chart.getTimeView());
      }
    }

    onBar(bar) {
      const c = this.chart, n = c.raw.length, shown = c.bars.length;
      c.updateBar(bar);
      if (c.bars.length !== shown) this.alignCompares();
      if (this.mode !== 'live') this.refreshLocalTfs();
      markerAlertsOnChartBar(this, c.raw.length !== n);
      checkAlerts(this.symbol, bar.c);
      if (this === active) updateDocTitle();
    }

    async loadOlder() {
      const c = this.chart;
      if (this.loadingOlder || this.noMore || this.mode !== 'live' || !c.raw.length || c.raw.length >= 30000) return;
      this.loadingOlder = true;
      const gen = this.gen;
      try {
        const limit = isStock(this.symbol) ? 5000 : 1000; // stocks: one request costs the same however many bars
        const older = await MD.history(this.symbol, this.tf, { limit, endTime: c.raw[0].t - 1 });
        if (gen !== this.gen) return;
        if (older.length < limit) this.noMore = true;
        if (older.length) {
          c.prependBars(older);
          this.alignCompares(); // bar indexes shifted
          for (const f of this.tfFeeds.values()) this.fillTfHistory(f);
          for (const st of this.cmps.values()) this.fillCompareHistory(st).then(() => this.alignCompare(st));
        }
      } catch (e) { /* try again on next scroll */ } finally { this.loadingOlder = false; }
    }

    // ---- comparison overlays
    async addCompare(sym) {
      if (!sym.startsWith('CSV:') && !isDemo(sym) && !isStock(sym) && !exOf(sym)) {
        let known = null;
        try { known = await MD.allSymbols(); } catch (e) { /* offline: let the data request decide */ }
        if (known && !known.includes(sym)) { toast(`Can't compare ${sym}: not found on Binance`, 'error', 6000); return; }
      }
      const list = this.cfg.compares || (this.cfg.compares = []);
      if (sym === this.symbol) { toast(`${bare(sym)} is already the main symbol of this chart`, 'warn'); return; }
      if (list.some((x) => x.symbol === sym)) { toast(`${bare(sym)} is already being compared`, 'warn'); return; }
      if (list.length >= MAX_COMPARES) { toast(`Up to ${MAX_COMPARES} comparisons per chart`, 'warn'); return; }
      const used = new Set(list.map((x) => x.color));
      const cc = { id: uid(), symbol: sym, color: CMP_COLORS.find((col) => !used.has(col)) || CMP_COLORS[0], visible: true };
      list.push(cc);
      save();
      this.startCompare(cc);
      if (this === active) updateHeader();
    }

    removeCompare(id) {
      const st = this.cmps.get(id);
      if (st && st.stop) st.stop();
      this.cmps.delete(id);
      this.cfg.compares = (this.cfg.compares || []).filter((x) => x.id !== id);
      this.chart.removeCompare(id);
      save();
      if (this === active) updateHeader();
    }

    stopCompares() {
      for (const st of this.cmps.values()) if (st.stop) st.stop();
      this.cmps.clear();
      this.chart.clearCompares();
    }

    startCompares() {
      for (const cc of this.cfg.compares || []) this.startCompare(cc);
    }

    // timeframe for comparison data: the chart's own, or for imported CSV the closest Binance timeframe
    compareTf(sym) {
      let tf = this.tf;
      if (this.symbol.startsWith('CSV:')) {
        const iv = this.chart.interval;
        tf = Object.keys(MD.TF).reduce((best, k) => (Math.abs(Math.log(MD.TF[k] / iv)) < Math.abs(Math.log(MD.TF[best] / iv)) ? k : best), '1d');
      }
      return MD.nearestTf(sym, tf); // stocks don't have every timeframe
    }

    async startCompare(cc) {
      const prev = this.cmps.get(cc.id);
      if (prev && prev.stop) prev.stop();
      const tf = this.compareTf(cc.symbol);
      const st = { c: cc, tf, bars: [], interval: MD.TF[tf] || 3600e3, stop: null, noMore: false };
      this.cmps.set(cc.id, st);
      if (prev) this.chart.updateCompare(cc.id, { values: [] });
      else this.chart.addCompare({ id: cc.id, symbol: symLabel(cc.symbol), color: cc.color, visible: cc.visible !== false, values: [] });
      const alive = () => this.cmps.get(cc.id) === st;
      const sym = cc.symbol;
      try {
        if (sym.startsWith('CSV:')) {
          const ds = csvData[sym];
          if (!ds) throw Object.assign(new Error('That CSV file is no longer loaded'), { fatal: true });
          st.bars = ds.bars; st.interval = ds.interval; st.noMore = true;
        } else if (isDemo(sym)) {
          st.bars = MD.demoBars(tf, 1500, sym); st.noMore = true;
          st.stop = MD.demoStream(tf, () => st.bars[st.bars.length - 1], (b) => this.onCompareBar(st, b));
        } else {
          st.bars = await MD.history(sym, tf, { limit: 1000 });
          if (!st.bars.length) throw Object.assign(new Error('No data'), { fatal: true });
          if (!alive()) return;
          await this.fillCompareHistory(st);
          if (!alive()) return;
          st.stop = MD.stream(sym, tf, (b) => this.onCompareBar(st, b));
        }
      } catch (e) {
        if (!alive()) return;
        const why = sym.startsWith('CSV:') || exOf(sym) ? (e.fatal ? e.message : `could not reach ${exOf(sym) ? exOf(sym).name : 'it'}`) : e.needsKey ? 'stocks and forex need a free Twelve Data API key' : e.budget ? e.message
          : isStock(sym) ? (e.fatal ? e.message : 'could not reach Twelve Data') : e.fatal ? 'not found on Binance' : 'could not reach Binance';
        toast(`Can't compare ${bare(sym)}: ${why}`, 'error', 6000);
        this.removeCompare(cc.id);
        return;
      }
      this.alignCompare(st);
    }

    // fetch older comparison bars until they cover the chart's first bar
    async fillCompareHistory(st) {
      const main = this.chart.raw;
      const stock = isStock(st.c.symbol), limit = stock ? 5000 : 1000;
      for (let k = 0; k < (stock ? 3 : 30) && !st.noMore && st.bars.length && main.length && st.bars[0].t > main[0].t; k++) {
        try {
          const older = await MD.history(st.c.symbol, st.tf, { limit, endTime: st.bars[0].t - 1 });
          if (this.cmps.get(st.c.id) !== st) return;
          if (older.length < limit) st.noMore = true;
          if (!older.length) break;
          st.bars = older.concat(st.bars);
        } catch (e) { return; }
      }
    }

    onCompareBar(st, b) {
      if (this.cmps.get(st.c.id) !== st) return;
      const n = st.bars.length;
      if (n && st.bars[n - 1].t === b.t) st.bars[n - 1] = b;
      else if (!n || b.t > st.bars[n - 1].t) st.bars.push(b);
      else return;
      this.alignCompare(st);
    }

    alignCompare(st) {
      if (this.cmps.get(st.c.id) !== st) return;
      this.chart.updateCompare(st.c.id, { values: alignCloses(this.chart.bars, st.bars, st.interval) });
    }

    alignCompares() { for (const st of this.cmps.values()) this.alignCompare(st); }

    showDrawBar(d) {
      const bar = this.drawBar, c = this.chart;
      if (!d) { bar.classList.add('hidden'); return; }
      bar.innerHTML = '';
      const changed = () => { c.invalidate(); c.onDrawingsChange(); };
      const color = h('input', { type: 'color', title: 'Color', value: toHex(d.color || c.theme.drawing) });
      color.addEventListener('input', () => { d.color = color.value; changed(); });
      const widths = [...new Set([1, 1.5, 2, 3, 4, d.width || 1.5])].sort((a, b) => a - b);
      const width = h('select', { title: 'Line width' }, widths.map((w) => h('option', { value: w, selected: (d.width || 1.5) === w }, w + 'px')));
      width.addEventListener('change', () => { d.width = +width.value; changed(); });
      const dash = h('button', { class: 'db-btn' + (d.dash ? ' active' : ''), title: 'Dashed' }, '- -');
      dash.addEventListener('click', () => { d.dash = !d.dash; dash.classList.toggle('active', d.dash); changed(); });
      const lock = h('button', { class: 'db-btn' + (d.locked ? ' active' : ''), title: 'Lock position' }, d.locked ? 'Locked' : 'Lock');
      lock.addEventListener('click', () => { d.locked = !d.locked; lock.classList.toggle('active', d.locked); lock.textContent = d.locked ? 'Locked' : 'Lock'; changed(); });
      const kids = [color, width, dash, lock];
      if (['hline', 'hray', 'crossline'].includes(d.type)) kids.push(h('button', { class: 'db-btn', title: 'Create a price alert at this line', onclick: () => addAlert(this.symbol, d.pts[0].p) }, 'Alert'));
      if (d.type === 'arrowup' || d.type === 'arrowdown') kids.push(h('button', { class: 'db-btn', onclick: async () => { const t = await askText('Label', d.text || '', 'Optional text'); if (t !== null && t !== undefined) { d.text = t; changed(); } } }, d.text ? 'Edit text' : 'Add text'));
      if (d.type === 'text') kids.push(h('button', { class: 'db-btn', onclick: async () => { const t = await askText('Text note', d.text); if (t) { d.text = t; changed(); } } }, 'Edit'));
      const del = h('button', { class: 'db-btn danger', title: 'Delete (Del)', onclick: () => c.deleteSelected() });
      del.innerHTML = svg('trash');
      kids.push(del);
      bar.append(...kids);
      bar.classList.remove('hidden');
    }
  }
  let demoWarned = false;

  // Drawings belong to a symbol, so every chart showing that symbol shows the same drawings.
  function drawingsChanged(src) {
    state.drawings[src.symbol] = src.chart.drawings;
    for (const s of slots) {
      if (s !== src && s.symbol === src.symbol) { s.chart.drawings = src.chart.drawings; s.chart.invalidate(); }
    }
    save();
  }

  function setActive(slot) {
    if (active === slot) return;
    const prev = active;
    active = slot;
    state.active = slots.indexOf(slot);
    if (prev) {
      // carry an armed drawing tool over to the chart the user just clicked
      const tool = prev.chart.tool;
      prev.chart.cancelCreating();
      prev.chart.select(null);
      if (tool !== 'cursor') { prev.chart.setTool('cursor'); slot.chart.setTool(tool); }
    }
    for (const s of slots) s.el.classList.toggle('active', s === slot);
    updateHeader();
    renderStatus();
    updateDocTitle();
    save();
  }

  // Next symbol for a newly added chart: the next watchlist symbol not already on screen.
  function nextSymbol() {
    if (state.sync.symbol && active) return active.symbol;
    if (PREVIEW) return slots.length ? 'DEMO' + (slots.length + 1) : 'DEMO';
    const shown = new Set(slots.map((s) => s.symbol));
    return state.watchlist.find((s) => !shown.has(s)) || active?.symbol || 'BTCUSDT';
  }

  function applyLayout(key) {
    const L = LAYOUTS[key];
    state.layout = key;
    const grid = $('#charts');
    grid.dataset.layout = key;
    grid.classList.toggle('multi', L.cells.length > 1);
    const n = L.cells.length;
    // remove surplus charts (their settings stay in state.charts so they come back later)
    while (slots.length > n) slots.pop().destroy();
    while (slots.length < n) {
      const i = slots.length;
      let cfg = state.charts[i];
      if (!cfg) {
        const base = active ? active.cfg : state.charts[0];
        cfg = { ...clone(base), symbol: nextSymbol(), compares: [] }; // comparisons aren't copied to new charts
        if (state.sync.interval && active) cfg.tf = active.tf;
        state.charts[i] = cfg;
      } else if (cfg.symbol.startsWith('CSV:') && !csvData[cfg.symbol]) cfg.symbol = 'BTCUSDT';
      const slot = new Slot(cfg);
      slots.push(slot);
      slot.load(cfg.symbol, cfg.tf);
    }
    slots.forEach((s, i) => {
      const [c, r, cs, rs] = L.cells[i];
      s.el.style.gridColumn = `${c + 1} / span ${cs}`;
      s.el.style.gridRow = `${r + 1} / span ${rs}`;
    });
    buildDividers();
    const want = slots[Math.min(state.active || 0, n - 1)];
    if (!slots.includes(active)) active = null;
    setActive(want);
    $('#layoutBtn').innerHTML = layoutIcon(key);
    for (const s of slots) s.chart.setSyncTime(null);
    save();
  }

  // ------------------------------------------------------------------ resizable dividers
  // Sizes are kept per layout as relative track weights: { cols: [..], rows: [..] }.
  const MIN_TRACK = { cols: 160, rows: 110 }; // smallest chart size in px

  function sizesFor(key) {
    const L = LAYOUTS[key], sz = state.layoutSizes && state.layoutSizes[key];
    const ok = (a, n) => Array.isArray(a) && a.length === n && a.every((v) => v > 0 && isFinite(v));
    return sz && ok(sz.cols, L.cols) && ok(sz.rows, L.rows) ? sz : { cols: Array(L.cols).fill(1), rows: Array(L.rows).fill(1) };
  }
  const isEqual = (sz) => [sz.cols, sz.rows].every((t) => t.every((v) => Math.abs(v - t[0]) < 1e-6));

  function setSizes(sz) {
    state.layoutSizes = state.layoutSizes || {};
    if (isEqual(sz)) delete state.layoutSizes[state.layout];
    else state.layoutSizes[state.layout] = sz;
    applyTracks();
  }

  function applyTracks() {
    const grid = $('#charts'), sz = sizesFor(state.layout);
    grid.style.gridTemplateColumns = sz.cols.map((f) => `minmax(0, ${f}fr)`).join(' ');
    grid.style.gridTemplateRows = sz.rows.map((f) => `minmax(0, ${f}fr)`).join(' ');
    positionDividers();
  }

  // Parts of track boundary k (between track k-1 and k) that actually separate two charts:
  // e.g. in "1 large + 2" the row boundary only exists in the right-hand column.
  function boundarySegments(L, axis, k) {
    const n = axis === 'cols' ? L.rows : L.cols, segs = [];
    let start = null;
    for (let i = 0; i < n; i++) {
      const crossed = L.cells.some(([c, r, cs, rs]) => (axis === 'cols'
        ? r <= i && i < r + rs && c < k && c + cs > k
        : c <= i && i < c + cs && r < k && r + rs > k));
      if (!crossed && start === null) start = i;
      if (start !== null && crossed) { segs.push([start, i]); start = null; }
      else if (start !== null && i === n - 1) segs.push([start, n]);
    }
    return segs;
  }

  // Pixel offsets where each track starts (grid has a 1px gap between tracks).
  function trackEdges(tracks, total) {
    const sum = tracks.reduce((a, b) => a + b, 0), avail = total - (tracks.length - 1), edges = [0];
    let acc = 0;
    tracks.forEach((f, i) => { acc += (f / sum) * avail + (i < tracks.length - 1 ? 1 : 0); edges.push(acc); });
    return edges;
  }

  function buildDividers() {
    const layer = $('#dividers'), L = LAYOUTS[state.layout];
    layer.innerHTML = '';
    for (const axis of ['cols', 'rows']) {
      const count = axis === 'cols' ? L.cols : L.rows;
      for (let k = 1; k < count; k++) {
        for (const seg of boundarySegments(L, axis, k)) {
          const el = h('div', {
            class: 'divider ' + (axis === 'cols' ? 'v' : 'h'), role: 'separator', tabindex: '0',
            'aria-orientation': axis === 'cols' ? 'vertical' : 'horizontal',
            'aria-label': 'Resize charts', title: 'Drag to resize · double-click to make equal',
          });
          el._d = { axis, k, seg };
          bindDivider(el);
          layer.appendChild(el);
        }
      }
    }
    applyTracks();
  }

  function positionDividers() {
    const grid = $('#charts'), sz = sizesFor(state.layout);
    const xe = trackEdges(sz.cols, grid.clientWidth), ye = trackEdges(sz.rows, grid.clientHeight);
    for (const el of $('#dividers').children) {
      const { axis, k, seg } = el._d;
      if (axis === 'cols') {
        el.style.left = xe[k] - 0.5 + 'px';
        el.style.top = ye[seg[0]] + 'px';
        el.style.height = ye[seg[1]] - ye[seg[0]] + 'px';
      } else {
        el.style.top = ye[k] - 0.5 + 'px';
        el.style.left = xe[seg[0]] + 'px';
        el.style.width = xe[seg[1]] - xe[seg[0]] + 'px';
      }
    }
  }

  // Move boundary k by `delta` px, keeping both neighbouring charts above the minimum size.
  function resizeBoundary(base, axis, k, delta) {
    const grid = $('#charts'), sz = clone(base), t = sz[axis];
    const total = axis === 'cols' ? grid.clientWidth : grid.clientHeight;
    const sum = t.reduce((a, b) => a + b, 0), avail = total - (t.length - 1);
    const minFr = Math.min((MIN_TRACK[axis] / avail) * sum, (t[k - 1] + t[k]) / 2);
    const d = clamp((delta / avail) * sum, minFr - t[k - 1], t[k] - minFr);
    t[k - 1] += d;
    t[k] -= d;
    setSizes(sz);
  }

  function bindDivider(el) {
    const { axis, k } = el._d;
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      const base = clone(sizesFor(state.layout)), start = axis === 'cols' ? e.clientX : e.clientY;
      el.classList.add('dragging');
      document.body.classList.add(axis === 'cols' ? 'resizing-x' : 'resizing-y');
      const move = (ev) => resizeBoundary(base, axis, k, (axis === 'cols' ? ev.clientX : ev.clientY) - start);
      const up = () => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
        el.classList.remove('dragging');
        document.body.classList.remove('resizing-x', 'resizing-y');
        save();
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    });
    el.addEventListener('dblclick', () => {
      const sz = clone(sizesFor(state.layout)), t = sz[axis], m = (t[k - 1] + t[k]) / 2;
      t[k - 1] = t[k] = m;
      setSizes(sz);
      save();
    });
    el.addEventListener('keydown', (e) => {
      const back = axis === 'cols' ? 'ArrowLeft' : 'ArrowUp', fwd = axis === 'cols' ? 'ArrowRight' : 'ArrowDown';
      if (e.key !== back && e.key !== fwd) return;
      e.preventDefault();
      e.stopPropagation();
      resizeBoundary(sizesFor(state.layout), axis, k, (e.key === fwd ? 1 : -1) * (e.shiftKey ? 80 : 20));
      save();
    });
  }

  // ------------------------------------------------------------------ status / toasts
  function renderStatus() {
    if (!active) return;
    const s = active.status, el = $('#status');
    const mins = (ms) => (ms >= 90e3 ? Math.round(ms / 60e3) + ' min' : '1 min');
    const labels = {
      live: 'Live', connecting: 'Connecting', reconnecting: 'Reconnecting', demo: 'Demo data', static: 'CSV data', loading: 'Loading',
      polling: `Updates every ${mins(active.statusDetail || 60e3)}`, closed: 'Market closed', limit: 'Daily data limit', needskey: 'Needs API key', error: 'No data',
    };
    const tips = {
      polling: 'Stock and forex charts refresh on a schedule that keeps all your charts within the free Twelve Data plan (8 requests a minute, 800 a day).',
      closed: 'The market is closed. The chart checks for updates now and then.',
      limit: 'The free Twelve Data plan allows 800 requests a day. Charts update again after midnight UTC. Click for details.',
      needskey: 'Stocks and forex need a free Twelve Data API key. Click to add it.',
    };
    el.dataset.state = s;
    el.title = tips[s] || 'Data connection';
    el.classList.toggle('clickable', s === 'needskey' || s === 'limit' || s === 'polling');
    $('span', el).textContent = labels[s] || s;
  }

  function toast(msg, kind = 'info', ms = 4000) {
    const el = h('div', { class: 'toast ' + kind }, msg);
    el.addEventListener('click', () => el.remove());
    $('#toasts').appendChild(el);
    if (ms) setTimeout(() => el.remove(), ms);
    // keep the stack short: busy alerts shouldn't bury the screen
    const all = $('#toasts').children;
    while (all.length > 5) all[0].remove();
  }

  function updateDocTitle() {
    if (!active) return;
    const b = active.chart.raw[active.chart.raw.length - 1];
    document.title = b ? `${bare(active.symbol)} ${active.chart.fmtPrice(b.c)} — Candela` : 'Candela Charts';
  }

  // ------------------------------------------------------------------ actions on the active chart (+ synced charts)
  function openSymbol(sym) {
    const targets = state.sync.symbol ? slots : [active];
    for (const s of targets) s.load(sym, s.tf);
  }

  function changeTf(tf) {
    const targets = state.sync.interval ? slots : [active];
    let skipped = false;
    let noStock = false;
    for (const s of targets) {
      if (s.symbol.startsWith('CSV:')) { skipped = true; continue; }
      if (!MD.supportsTf(s.symbol, tf)) { noStock = true; continue; }
      s.load(s.symbol, tf);
    }
    if (skipped) toast('Imported CSV data has a fixed timeframe.', 'warn');
    if (noStock) toast(`${tfName(tf)} isn't available for stocks and forex. They have 1m, 5m, 15m, 30m, 1H, 2H, 4H, 1D, 1W, 1M, and custom timeframes of a day or more (2D, 2W, 3M…).`, 'warn', 6000);
    updateHeader();
  }

  // ------------------------------------------------------------------ header
  const MAIN_TFS = ['1m', '5m', '15m', '1h', '4h', '1d', '1w'];
  const MORE_TFS = ['3m', '30m', '2h', '6h', '8h', '12h', '3d', '1M'];
  const STD_TFS = [...MAIN_TFS, ...MORE_TFS];
  const tfName = (tf) => MD.tfLabel(tf);
  const byLength = (a, b) => MD.TF[a] - MD.TF[b];

  // the ⋯ menu: more timeframes, your own ones, and "Custom…"
  function fillMoreTfs() {
    const more = $('#tfMore');
    more.innerHTML = '';
    more.appendChild(h('option', { value: '' }, '⋯'));
    for (const tf of MORE_TFS) more.appendChild(h('option', { value: tf }, tfName(tf)));
    // custom timeframes, plus any a chart uses that was since removed from the list
    const extra = [...new Set([...state.customTfs, ...slots.map((s) => s.tf)])].filter((tf) => !STD_TFS.includes(tf)).sort(byLength);
    if (extra.length) more.appendChild(h('optgroup', { label: 'Custom' }, extra.map((tf) => h('option', { value: tf }, tfName(tf)))));
    more.appendChild(h('option', { value: '__custom' }, 'Custom…'));
  }
  function addCustomTf(tf) {
    MD.ensureTf(tf);
    if (STD_TFS.includes(tf) || state.customTfs.includes(tf)) return;
    state.customTfs.push(tf);
    state.customTfs.sort(byLength);
    if (state.customTfs.length > 24) state.customTfs.shift();
    save();
    fillMoreTfs();
    updateHeader();
  }
  // "Custom timeframe" dialog. onPick (optional) receives the timeframe instead of switching the chart to it.
  function openCustomTfDialog(prefill = '', onPick = null) {
    const input = h('input', { class: 'search', value: prefill, placeholder: 'e.g. 2D, 3H, 12H, 2W, 45 (minutes), 1M (month)', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Timeframe' });
    const msg = h('p', { class: 'muted tf-help' }, 'A number and a unit: m minutes, H hours, D days, W weeks, M months. A plain number means minutes.');
    const list = h('div', { class: 'tf-chips' });
    const pick = (tf) => { close(); if (onPick) onPick(tf); else changeTf(tf); };
    const renderList = () => {
      list.innerHTML = '';
      if (!state.customTfs.length) { list.appendChild(h('span', { class: 'muted' }, 'None yet.')); return; }
      for (const tf of state.customTfs) {
        list.appendChild(h('span', { class: 'tf-chip' },
          h('button', { class: 'chip', title: onPick ? `Use ${tfName(tf)}` : `Show ${tfName(tf)}`, onclick: () => pick(tf) }, tfName(tf)),
          h('button', { class: 'tf-chip-x', title: 'Remove from the list', onclick: () => {
            state.customTfs = state.customTfs.filter((x) => x !== tf);
            save(); fillMoreTfs(); updateHeader(); renderList();
          } }, '✕')));
      }
    };
    const preview = () => {
      const tf = MD.normalizeTf(input.value);
      msg.classList.toggle('err', !!input.value.trim() && !tf);
      msg.textContent = !input.value.trim() ? 'A number and a unit: m minutes, H hours, D days, W weeks, M months. A plain number means minutes.'
        : tf ? `${tfName(tf)}: ${describeTf(tf)}` : `Candela doesn't understand "${input.value.trim()}". Try 2D, 3H, 2W or 1M (up to 1440m, 168H, 365D, 52W, 12M).`;
    };
    const add = () => {
      const tf = MD.normalizeTf(input.value);
      if (!tf) { preview(); input.focus(); return; }
      addCustomTf(tf);
      pick(tf);
    };
    input.addEventListener('input', preview);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
    renderList();
    const { close } = openModal('Custom timeframe', h('div', {}, input, msg, h('div', { class: 'list-group' }, 'Your timeframes'), list), {
      footer: [h('span', { class: 'spacer' }), h('button', { class: 'btn ghost', onclick: () => close() }, 'Cancel'), h('button', { class: 'btn primary', onclick: add }, onPick ? 'Use' : 'Show chart')],
    });
    preview();
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }
  function describeTf(tf) {
    const p = MD.parseTf(tf), unit = { m: 'minute', h: 'hour', d: 'day', w: 'week', M: 'month' }[p.unit];
    const what = `${p.n} ${unit}${p.n > 1 ? 's' : ''} per candle`;
    if (p.unit === 'M') return what + (p.n === 3 ? ' (quarters)' : '') + ', starting on the 1st';
    if (p.unit === 'w') return what + ', starting on Mondays';
    if (p.unit === 'd' && p.n > 1) return what;
    if (p.unit === 'd') return what + ', midnight to midnight UTC';
    if (86400e3 % p.ms !== 0) return what + ' (the last one each day is shorter: candles restart at midnight UTC)';
    return what;
  }

  function buildHeader() {
    const g = $('#tfGroup');
    for (const tf of MAIN_TFS) g.appendChild(h('button', { class: 'tf', 'data-tf': tf, onclick: () => changeTf(tf) }, tfName(tf)));
    const more = $('#tfMore');
    fillMoreTfs();
    more.addEventListener('change', () => {
      const v = more.value;
      if (v === '__custom') { updateHeader(); openCustomTfDialog(); }
      else if (v) changeTf(v);
      more.blur();
    });

    $('#symbolBtn').addEventListener('click', () => openSymbolSearch());
    $('#status').addEventListener('click', () => { if (['needskey', 'limit', 'polling'].includes(active.status)) openStockSettings(); });
    $('#chartType').addEventListener('change', (e) => {
      active.cfg.chartType = e.target.value;
      active.chart.setChartType(e.target.value);
      save();
      updateHeader();
      e.target.blur();
      if (active.chart.isBrick && !state.brickNoteSeen) {
        state.brickNoteSeen = true;
        save();
        toast('Renko, Kagi and Point & Figure ignore time: a new brick, line or column appears only when price moves enough. Indicators and drawings follow them. "Box…" next to the menu sets the size.', 'info', 9000);
      }
    });
    $('#brickBtn').addEventListener('click', openBrickSettings);
    $('#indBtn').addEventListener('click', openIndicatorPicker);
    $('#scriptBtn').addEventListener('click', () => openScriptEditor());
    $('#compareBtn').addEventListener('click', () => openCompareSearch());
    $('#pctBtn').addEventListener('click', () => {
      if (active.chart.compares.some((c) => c.visible)) { toast('The percent scale stays on while symbols are compared.', 'info', 2500); return; }
      active.cfg.percent = !active.cfg.percent;
      active.chart.percentMode = active.cfg.percent;
      active.chart.main.auto = true;
      active.chart.invalidate();
      updateHeader();
      save();
    });
    $('#alertBtn').addEventListener('click', () => openAlertDialog());
    $('#logBtn').addEventListener('click', () => {
      const c = active.chart;
      active.cfg.log = !active.cfg.log;
      c.main.log = active.cfg.log;
      c.main.auto = true;
      c.invalidate();
      updateHeader();
      save();
    });
    $('#autoBtn').addEventListener('click', () => active.chart.resetView());
    $('#snapBtn').addEventListener('click', snapshot);
    $('#themeBtn').addEventListener('click', () => {
      state.theme = state.theme === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = state.theme;
      for (const s of slots) s.chart.setTheme(state.theme);
      save();
    });
    $('#sideBtn').addEventListener('click', () => { state.sideOpen = !state.sideOpen; updateHeader(); save(); });
    $('#layoutBtn').addEventListener('click', toggleLayoutMenu);
  }

  function updateHeader() {
    if (!active) return;
    const sym = active.symbol, tf = active.tf, csv = sym.startsWith('CSV:');
    $('#symbolName').textContent = bare(sym);
    $('#symbolEx').textContent = exOf(sym) ? exOf(sym).name.toUpperCase() : '';
    for (const b of document.querySelectorAll('#tfGroup .tf')) {
      b.classList.toggle('active', !csv && b.dataset.tf === tf);
      b.classList.toggle('na', !MD.supportsTf(sym, b.dataset.tf));
    }
    const more = $('#tfMore');
    if (!csv && !STD_TFS.includes(tf) && ![...more.options].some((o) => o.value === tf)) fillMoreTfs();
    for (const o of more.options) if (o.value && o.value !== '__custom') o.disabled = !csv && !MD.supportsTf(sym, o.value);
    const inMore = !csv && !MAIN_TFS.includes(tf);
    more.value = inMore ? tf : '';
    more.classList.toggle('active', inMore);
    more.classList.toggle('wide', inMore && tfName(tf).length > 3);
    $('#chartType').value = active.cfg.chartType || 'candles';
    $('#brickBtn').hidden = !active.chart.isBrick;
    $('#logBtn').classList.toggle('active', !!active.cfg.log);
    const comparing = active.chart.compares.some((c) => c.visible);
    $('#pctBtn').classList.toggle('active', comparing || !!active.cfg.percent);
    $('#pctBtn').title = comparing ? 'Percent scale (on while comparing symbols)' : 'Percent scale: change from the first visible bar';
    const nc = (active.cfg.compares || []).length;
    $('#compareBtn span').textContent = nc ? `Compare (${nc})` : 'Compare';
    $('#side').classList.toggle('closed', !state.sideOpen);
    $('#sideBtn').classList.toggle('active', state.sideOpen);
    for (const r of document.querySelectorAll('.wl-row')) r.classList.toggle('active', r.dataset.sym === sym);
    updateAcross();
  }

  // ---- Renko / Kagi / Point & Figure settings: box size (Auto = 14-bar ATR, or fixed), reversal
  function openBrickSettings() {
    const slot = active, c = slot.chart, type = slot.cfg.chartType;
    if (!c.isBrick) return;
    const orig = clone(slot.cfg.brick || {}), all = clone(orig), o = all[type] || (all[type] = {});
    const apply = () => { c.setBrickOptions(all); };
    const auto = c.brickSize;
    const form = h('div', { class: 'form' });
    const num = (value, step) => h('input', { type: 'number', value, min: 0, step: step || 'any' });
    const row = (label, ...ctl) => form.appendChild(h('label', {}, h('span', {}, label), h('span', { class: 'tf-pick' }, ...ctl)));
    if (type === 'renko' || type === 'pnf') {
      const mode = h('select', {}, h('option', { value: 'atr' }, 'Auto (ATR 14)'), h('option', { value: 'fixed' }, 'Fixed'));
      const size = num(o.size || +(auto || 0).toPrecision(4));
      mode.value = o.mode === 'fixed' ? 'fixed' : 'atr';
      const sync = () => { size.disabled = mode.value !== 'fixed'; o.mode = mode.value; if (mode.value === 'fixed') o.size = +size.value; apply(); };
      mode.addEventListener('change', sync);
      size.addEventListener('input', () => { if (+size.value > 0) { o.size = +size.value; apply(); } });
      row('Box size', mode, size);
      size.disabled = mode.value !== 'fixed';
      if (type === 'pnf') {
        const rev = num(o.rev || 3, 1);
        rev.addEventListener('input', () => { if (+rev.value >= 1) { o.rev = Math.round(+rev.value); apply(); } });
        row('Reversal (boxes)', rev);
      }
    } else {
      const mode = h('select', {}, h('option', { value: 'atr' }, 'Auto (ATR 14)'), h('option', { value: 'pct' }, 'Percent'), h('option', { value: 'fixed' }, 'Fixed price'));
      mode.value = o.mode || 'atr';
      const value = num(o.value || (mode.value === 'pct' ? 1 : +(auto || 0).toPrecision(4)));
      const sync = () => {
        o.mode = mode.value;
        value.disabled = mode.value === 'atr';
        if (mode.value === 'pct' && !(o.value > 0 && o.value < 100)) value.value = 1;
        if (mode.value !== 'atr') o.value = +value.value;
        apply();
      };
      mode.addEventListener('change', sync);
      value.addEventListener('input', () => { if (+value.value > 0) { o.value = +value.value; apply(); } });
      value.disabled = mode.value === 'atr';
      row('Reversal', mode, value);
    }
    form.appendChild(h('p', { class: 'muted' }, type === 'renko'
      ? 'A new brick when the close moves one box beyond the last brick; it takes two boxes to turn around.'
      : type === 'kagi' ? 'The line turns when price reverses by this amount. It is thick and green after rising above the previous high, thin and red after falling below the previous low.'
        : 'An X for each box price rises, an O for each box it falls; a new column after the reversal number of boxes.'));
    let ok = false;
    const m = openModal({ renko: 'Renko', kagi: 'Kagi', pnf: 'Point & Figure' }[type] + ' settings', form, {
      footer: [h('span', { class: 'spacer' }), h('button', { class: 'btn ghost', onclick: () => m.close() }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: () => { ok = true; slot.cfg.brick = all; save(); m.close(); } }, 'OK')],
      onClose: () => { if (!ok) c.setBrickOptions(orig); },
    });
  }

  // ---- layout menu
  function toggleLayoutMenu() {
    const menu = $('#layoutMenu');
    if (!menu.classList.contains('hidden')) { menu.classList.add('hidden'); return; }
    menu.innerHTML = '';
    const grid = h('div', { class: 'layout-grid' });
    for (const key of LAYOUT_ORDER) {
      const b = h('button', { class: 'layout-opt' + (key === state.layout ? ' active' : ''), title: LAYOUTS[key].name, onclick: () => { applyLayout(key); menu.classList.add('hidden'); } });
      b.innerHTML = layoutIcon(key) + `<span>${LAYOUTS[key].name}</span>`;
      grid.appendChild(b);
    }
    const syncBox = h('div', { class: 'sync-box' }, h('div', { class: 'menu-label' }, 'Sync across charts'));
    const opts = [
      ['symbol', 'Symbol', 'Changing the symbol changes every chart'],
      ['interval', 'Timeframe', 'Changing the timeframe changes every chart'],
      ['crosshair', 'Crosshair', 'Show the hovered date on every chart'],
      ['time', 'Date range', 'Scrolling or zooming one chart moves the others'],
    ];
    for (const [key, label, hint] of opts) {
      const cb = h('input', { type: 'checkbox', id: 'sync-' + key });
      cb.checked = !!state.sync[key];
      cb.addEventListener('change', () => {
        state.sync[key] = cb.checked;
        save();
        if (key === 'crosshair' && !cb.checked) for (const s of slots) s.chart.setSyncTime(null);
        if (key === 'time' && cb.checked && active.chart.bars.length) active.chart.onViewChange();
        if (key === 'interval' && cb.checked) for (const s of slots) if (s !== active && s.tf !== active.tf && !s.symbol.startsWith('CSV:') && MD.supportsTf(s.symbol, active.tf)) s.load(s.symbol, active.tf);
        if (key === 'symbol' && cb.checked) for (const s of slots) if (s !== active && s.symbol !== active.symbol) s.load(active.symbol, s.tf);
      });
      syncBox.appendChild(h('label', { class: 'sync-opt', for: 'sync-' + key, title: hint }, cb, h('span', {}, label), h('small', {}, hint)));
    }
    const kids = [h('div', { class: 'menu-label' }, 'Layout'), grid];
    if (!isEqual(sizesFor(state.layout))) {
      kids.push(h('button', { class: 'btn ghost equal-btn', onclick: () => {
        const L = LAYOUTS[state.layout];
        setSizes({ cols: Array(L.cols).fill(1), rows: Array(L.rows).fill(1) });
        save();
        menu.classList.add('hidden');
      } }, 'Make all charts equal size'));
    }
    menu.append(...kids, syncBox);
    menu.classList.remove('hidden');
    const r = $('#layoutBtn').getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8)) + 'px';
    menu.style.top = r.bottom + 6 + 'px';
  }

  // ------------------------------------------------------------------ drawing toolbar
  const ICONS = {
    cursor: '<path d="M5 3l14 8-6 1.5L10 19z"/>',
    trend: '<path d="M4 19L20 5"/><circle cx="4" cy="19" r="1.8"/><circle cx="20" cy="5" r="1.8"/>',
    ray: '<path d="M4 19L21 4"/><circle cx="4" cy="19" r="1.8"/><circle cx="12" cy="12" r="1.8"/>',
    extended: '<path d="M2 21L22 3"/><circle cx="8" cy="15.6" r="1.8"/><circle cx="16" cy="8.4" r="1.8"/>',
    arrow: '<path d="M4 20L19 5"/><path d="M11 5h8v8"/>',
    hline: '<path d="M2 12h20"/><circle cx="12" cy="12" r="1.8"/>',
    vline: '<path d="M12 2v20"/><circle cx="12" cy="12" r="1.8"/>',
    rect: '<rect x="4" y="6" width="16" height="12" rx="1"/>',
    fib: '<path d="M3 5h18M3 10h18M3 14h18M3 19h18"/><path d="M5 19L19 5" stroke-dasharray="2 2"/>',
    measure: '<path d="M12 3v18M3 12h18"/><path d="M9 6l3-3 3 3M9 18l3 3 3-3"/>',
    text: '<path d="M5 6V4h14v2M12 4v16M9 20h6"/>',
    magnet: '<path d="M6 4v8a6 6 0 0 0 12 0V4h-4v8a2 2 0 0 1-4 0V4z"/><path d="M6 8h4M14 8h4"/>',
    eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  };
  const svg = (k) => `<svg viewBox="0 0 24 24">${ICONS[k]}</svg>`;
  // Drawing tools come from drawings.js: five groups with fly-out menus, plus Text and favorites.
  const DR = window.CandelaDrawings;
  const toolSvg = (k) => `<svg viewBox="0 0 24 24">${DR.ICONS[k] || ICONS[k] || ''}</svg>`;
  const toolName = (k) => (DR.TOOLS[k] ? DR.TOOLS[k].name : k);
  const groupOf = (k) => DR.GROUPS.find((g) => g.sections.some(([, ids]) => ids.includes(k)));
  const groupTool = (g) => { const k = state.toolGroups[g.id]; return DR.TOOLS[k] && groupOf(k) === g ? k : g.sections[0][1][0]; };
  const HEART = '<path d="M12 20s-7-4.4-9-9.1C1.7 7.6 4 4.5 7.2 4.5c2 0 3.6 1.2 4.8 2.9 1.2-1.7 2.8-2.9 4.8-2.9 3.2 0 5.5 3.1 4.2 6.4C19 15.6 12 20 12 20z"/>';
  let drawingsHidden = false;

  function buildToolbar() {
    const tb = $('#toolbar');
    const cur = h('button', { class: 'tool', 'data-tool': 'cursor', title: 'Cursor (Esc)', onclick: () => setActiveTool('cursor') });
    cur.innerHTML = svg('cursor');
    tb.appendChild(cur);
    for (const g of DR.GROUPS) {
      const k = groupTool(g);
      const b = h('button', { class: 'tool tool-group', 'data-group': g.id, 'data-tool': k, title: toolTitle(k), onclick: (e) => {
        if (e.target.closest('.tool-more')) return;
        setActiveTool(b.dataset.tool);
      }, oncontextmenu: (e) => { e.preventDefault(); openToolMenu(g, b); } });
      b.innerHTML = toolSvg(k);
      const more = h('span', { class: 'tool-more', title: g.title, onclick: (e) => { e.stopPropagation(); openToolMenu(g, b); } });
      b.appendChild(more);
      // touch: press and hold opens the menu
      let hold = null;
      b.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'mouse') hold = setTimeout(() => openToolMenu(g, b), 450); });
      b.addEventListener('pointerup', () => clearTimeout(hold));
      b.addEventListener('pointerleave', () => clearTimeout(hold));
      tb.appendChild(b);
    }
    const txt = h('button', { class: 'tool', 'data-tool': 'text', title: 'Text', onclick: () => setActiveTool('text') });
    txt.innerHTML = toolSvg('text');
    const fav = h('button', { class: 'tool', id: 'favBtn', title: 'Favorite tools (star them in the menus)', onclick: () => openToolMenu(null, fav) });
    fav.innerHTML = `<svg viewBox="0 0 24 24">${HEART}</svg>`;
    tb.append(txt, fav);
    tb.appendChild(h('div', { class: 'tb-sep' }));
    const mag = h('button', { class: 'tool', id: 'magnetBtn', title: 'Magnet: snap to OHLC', onclick: () => {
      state.magnet = !state.magnet;
      for (const s of slots) s.chart.magnet = state.magnet;
      mag.classList.toggle('active', state.magnet);
      save();
    } });
    mag.innerHTML = svg('magnet');
    mag.classList.toggle('active', state.magnet);
    const hide = h('button', { class: 'tool', title: 'Hide / show drawings', onclick: () => {
      drawingsHidden = !drawingsHidden;
      hide.classList.toggle('active', drawingsHidden);
      for (const s of slots) { s.chart.drawingsHidden = drawingsHidden; s.chart.select(null); s.chart.invalidate(); }
    } });
    hide.innerHTML = svg('eye');
    const trash = h('button', { class: 'tool', title: 'Remove all drawings on this symbol', onclick: removeAllDrawings });
    trash.innerHTML = svg('trash');
    tb.append(mag, hide, trash);
  }

  const toolTitle = (k) => toolName(k) + (DR.TOOLS[k] && DR.TOOLS[k].key ? ` (${DR.TOOLS[k].key})` : '') + (DR.TOOLS[k] && DR.TOOLS[k].n === 'multi' ? ': click points, double-click to finish' : '');

  function setActiveTool(k) {
    if (active && active.chart.tool !== k) active.chart.setTool(k);
    // the group button shows the tool picked last
    const g = groupOf(k);
    if (g) {
      if (state.toolGroups[g.id] !== k) { state.toolGroups[g.id] = k; save(); }
      const b = document.querySelector(`#toolbar .tool-group[data-group="${g.id}"]`);
      if (b && b.dataset.tool !== k) {
        b.dataset.tool = k;
        b.title = toolTitle(k);
        b.firstElementChild.outerHTML = toolSvg(k);
      }
    }
    for (const b of document.querySelectorAll('#toolbar .tool[data-tool]')) b.classList.toggle('active', b.dataset.tool === k);
    closeToolMenu();
  }

  // the fly-out menu of a group (or of your favorites when g is null)
  function closeToolMenu() { document.querySelector('.tool-menu')?.remove(); }
  function openToolMenu(g, anchor) {
    const was = document.querySelector('.tool-menu');
    closeToolMenu();
    if (was && was.dataset.for === (g ? g.id : 'fav')) return; // second click closes
    const menu = h('div', { class: 'tool-menu', role: 'menu', 'data-for': g ? g.id : 'fav' });
    const sections = g ? g.sections : [['Favorites', state.favTools.filter((k) => DR.TOOLS[k])]];
    for (const [title, ids] of sections) {
      menu.appendChild(h('div', { class: 'tm-head' }, title));
      if (!ids.length) menu.appendChild(h('div', { class: 'tm-empty muted' }, 'Star a tool in one of the menus to keep it here.'));
      for (const k of ids) {
        const t = DR.TOOLS[k], starred = state.favTools.includes(k);
        const star = h('button', { class: 'tm-star' + (starred ? ' on' : ''), title: starred ? 'Remove from favorites' : 'Add to favorites', onclick: (e) => {
          e.stopPropagation();
          state.favTools = state.favTools.includes(k) ? state.favTools.filter((x) => x !== k) : [...state.favTools, k];
          save();
          star.classList.toggle('on', state.favTools.includes(k));
          if (!g) { closeToolMenu(); openToolMenu(null, anchor); }
        } }, '★');
        const item = h('button', { class: 'tm-item' + (active && active.chart.tool === k ? ' on' : ''), role: 'menuitem', onclick: () => setActiveTool(k) });
        item.innerHTML = toolSvg(k);
        item.append(h('span', { class: 'tm-name' }, t.name), h('span', { class: 'tm-key' }, t.key || ''), star);
        menu.appendChild(item);
      }
    }
    document.body.appendChild(menu);
    const r = anchor.getBoundingClientRect(), mh = menu.offsetHeight;
    menu.style.left = r.right + 6 + 'px';
    menu.style.top = Math.max(8, Math.min(r.top, window.innerHeight - mh - 8)) + 'px';
    const away = (e) => { if (!menu.contains(e.target) && !anchor.contains(e.target)) { closeToolMenu(); document.removeEventListener('mousedown', away, true); } };
    setTimeout(() => document.addEventListener('mousedown', away, true), 0);
  }

  async function removeAllDrawings() {
    const c = active.chart;
    if (!c.drawings.length) return;
    const n = c.drawings.length;
    if (!(await askConfirm('Remove drawings', `Remove all ${n} drawing${n > 1 ? 's' : ''} on ${bare(active.symbol)}?`, 'Remove all'))) return;
    c.drawings = [];
    c.select(null);
    c.onDrawingsChange();
    c.invalidate();
  }

  // ------------------------------------------------------------------ modals
  function openModal(title, body, { wide = false, cls = '', onClose, footer } = {}) {
    closeModal();
    const close = () => { closeModal(); onClose && onClose(); };
    const dlg = h('div', { class: 'modal' + (wide ? ' wide' : '') + (cls ? ' ' + cls : ''), role: 'dialog', 'aria-label': title },
      h('div', { class: 'modal-head' }, h('h2', {}, title), h('button', { class: 'icon-btn', title: 'Close', onclick: close }, '✕')),
      h('div', { class: 'modal-body' }, body),
      footer ? h('div', { class: 'modal-foot' }, footer) : null);
    const back = h('div', { class: 'backdrop', onmousedown: (e) => { if (e.target === back) close(); } }, dlg);
    back._close = close;
    $('#modalRoot').appendChild(back);
    return { close, dlg };
  }
  function closeModal() { $('#modalRoot').innerHTML = ''; }
  const modalOpen = () => !!$('#modalRoot').firstChild;

  function askText(title, value = '', placeholder = '') {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (done) return; done = true; closeModal(); resolve(v); };
      const input = h('input', { class: 'search', value, placeholder, spellcheck: 'false' });
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') finish(input.value.trim() || null); });
      openModal(title, input, {
        onClose: () => { done = true; resolve(null); },
        footer: [h('span', { class: 'spacer' }), h('button', { class: 'btn ghost', onclick: () => finish(null) }, 'Cancel'), h('button', { class: 'btn primary', onclick: () => finish(input.value.trim() || null) }, 'OK')],
      });
      input.focus();
      input.select();
    });
  }

  function askConfirm(title, message, okLabel = 'Confirm') {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (done) return; done = true; closeModal(); resolve(v); };
      openModal(title, h('p', {}, message), {
        onClose: () => { done = true; resolve(false); },
        footer: [h('span', { class: 'spacer' }), h('button', { class: 'btn ghost', onclick: () => finish(false) }, 'Cancel'), h('button', { class: 'btn primary danger', onclick: () => finish(true) }, okLabel)],
      });
    });
  }

  // ---- symbol search
  let csvTarget = 'main'; // what an imported CSV becomes: the chart's symbol or a comparison
  function openCompareSearch(prefill = '') {
    const slot = active;
    openSymbolSearch(prefill, {
      title: `Compare with ${bare(slot.symbol)}`,
      exclude: [slot.symbol, ...(slot.cfg.compares || []).map((c) => c.symbol)],
      onPick: (s) => slot.addCompare(s),
      csv: 'compare',
    });
  }

  const POPULAR_STOCKS = ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'TSLA', 'SPY', 'QQQ', 'EUR/USD', 'GBP/USD', 'USD/JPY'].map((x) => 'TD:' + x);

  async function openSymbolSearch(prefill = '', opts = {}) {
    const input = h('input', { class: 'search', placeholder: 'Search crypto, stocks, ETFs and forex: BTC, AAPL, SPY, EUR/USD…', value: prefill, spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Search symbols' });
    const list = h('div', { class: 'list' });
    // where to search: everything, one crypto exchange, or stocks
    const SOURCES = [['ALL', 'All'], ['BINANCE', 'Binance'], ...Object.values(MD.EXCHANGES).map((ex) => [ex.id, ex.name]), ['STOCKS', 'Stocks & forex']];
    let src = SOURCES.some(([k]) => k === state.searchSrc) && !PREVIEW ? state.searchSrc : 'ALL';
    const chips = h('div', { class: 'src-chips', role: 'tablist' }, SOURCES.map(([k, label]) => h('button', {
      class: 'chip' + (k === src ? ' on' : ''), 'data-src': k, role: 'tab', disabled: PREVIEW && k !== 'ALL' ? '' : null,
      onclick: () => {
        src = k; state.searchSrc = k; save(); sel = 0;
        chips.querySelectorAll('.chip').forEach((b) => b.classList.toggle('on', b.dataset.src === k));
        loadEx(); render(); input.focus();
      },
    }, label)));
    // symbol lists of the other exchanges, loaded when needed
    const exLists = {}, exProblems = {};
    const loadEx = () => {
      if (PREVIEW) return;
      for (const id of Object.keys(MD.EXCHANGES)) {
        if (src !== 'ALL' && src !== id) continue;
        if (exLists[id] || exProblems[id] === 'loading') continue;
        exProblems[id] = 'loading';
        MD.exPairs(id).then((l) => { exLists[id] = l; delete exProblems[id]; render(); }, (e) => { exProblems[id] = e.message; render(); });
      }
    };
    const csvBtn = h('button', { class: 'btn', onclick: () => { csvTarget = opts.csv || 'main'; $('#csvInput').click(); } }, 'Import CSV…');
    const keyBtn = h('button', { class: 'btn', onclick: () => openStockSettings() }, state.stocks.key ? 'Stock data…' : 'Add stock data key…');
    const hint = h('span', { class: 'muted' }, PREVIEW ? 'Preview: simulated data only. Download the app for live crypto, stocks and forex.' : state.stocks.key ? 'Crypto from Binance. Stocks, ETFs and forex from Twelve Data.' : 'Stocks, ETFs and forex need a free Twelve Data API key.');
    if (PREVIEW) keyBtn.hidden = true;
    const title = opts.title || (slots.length > 1 && !state.sync.symbol ? `Symbol search · chart ${slots.indexOf(active) + 1}` : 'Symbol search');
    const { close } = openModal(title, h('div', {}, input, chips, list), { footer: [hint, keyBtn, csvBtn] });
    let symbols = [], stockHits = [], stockQ = null, stockTimer = null, sel = 0, items = [];
    const exclude = (id) => opts.exclude && opts.exclude.includes(id);
    const render = () => {
      const raw = input.value.trim(), q = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
      // crypto (Binance) + local data
      const extras = ['DEMO', ...Object.keys(csvData)];
      const extraHits = extras.filter((x) => !q || bare(x).startsWith(q));
      let crypto = q ? [] : extraHits.slice();
      if (symbols.length) {
        const starts = [], incl = [];
        for (const x of symbols) { if (!q) { if (x.endsWith('USDT')) starts.push(x); continue; } if (x.startsWith(q)) starts.push(x); else if (x.includes(q)) incl.push(x); }
        const rank = (x) => (x.endsWith('USDT') ? 0 : x.endsWith('USDC') ? 1 : x.endsWith('BTC') ? 2 : 3);
        starts.sort((x, y) => rank(x) - rank(y) || x.length - y.length || x.localeCompare(y));
        crypto = crypto.concat(starts, q ? extraHits : [], incl).slice(0, q ? 40 : 30);
      } else if (q) {
        crypto = crypto.concat(extraHits);
      }
      crypto = crypto.filter((x) => !MD.isBStock(x)); // bStocks get their own group
      // Binance bStocks (tokenized stocks: free and live)
      const BPOP = ['NVDA', 'TSLA', 'AAPL', 'SPY', 'QQQ', 'MSFT', 'GOOGL', 'AMZN', 'META', 'COIN'];
      let bpairs = raw ? MD.bStockList().filter((p) => MD.bStockTicker(p).startsWith(q)) : BPOP.map((t) => MD.bStockFor(t)).filter(Boolean);
      if (raw) bpairs.sort((a, b) => (MD.bStockTicker(a) === q ? -1 : MD.bStockTicker(b) === q ? 1 : MD.bStockTicker(a).length - MD.bStockTicker(b).length || a.localeCompare(b)));
      const bRows = bpairs.filter((x) => !exclude(x)).slice(0, raw ? 12 : 10).map((x) => ({ id: x, kind: 'bstock' }));
      // stocks, ETFs, forex (Twelve Data search)
      let stocks;
      if (PREVIEW) stocks = []; // the hosted preview can't reach Twelve Data
      else if (!raw) stocks = POPULAR_STOCKS.map((id) => ({ id, symbol: bare(id), name: null, exchange: MD.isForex(id) ? 'Forex' : '', type: MD.isForex(id) ? 'Forex' : '', us: true }));
      else stocks = stockQ === raw ? stockHits : [];
      const cryptoRows = crypto.filter((x) => !exclude(x)).map((x) => ({ id: x, kind: 'crypto' }));
      const stockRows = stocks.filter((r) => !exclude(r.id)).slice(0, 25).map((r) => ({ id: r.id, kind: 'stock', r }));
      // offline / lists still loading: offer exactly what was typed, as a last resort
      if (q && !symbols.length && !cryptoRows.length && !stockRows.length && stockQ === raw && !raw.includes('/') && !exclude(q)) cryptoRows.push({ id: q, kind: 'crypto' });
      const up = raw.toUpperCase();
      // "ETH" or "SOL" mean the coin (there is an ETHUSDT pair), even though ETH and SOL are also US tickers;
      // "AAPL" or "COIN" mean the stock
      const isCoin = cryptoRows.some((x) => x.id === q || x.id === q + 'USDT' || x.id === q + 'USDC');
      const exactB = bRows.some((x) => MD.bStockTicker(x.id) === q);
      const stocksFirst = !isCoin && (exactB || (stockRows.length && (stockRows.some((x) => x.r.symbol === up) || !cryptoRows.some((x) => x.id.startsWith(q)))));
      const bGroup = ['Stocks · Binance bStocks (free, live)', bRows], tdGroup = ['Stocks, ETFs & forex · Twelve Data', stockRows];
      // with a Twelve Data key the real exchange data comes first; without one, the free bStocks do
      const stockGroups = state.stocks.key ? [tdGroup, bGroup] : [bGroup, tdGroup];
      // Bybit, KuCoin, Kraken, Coinbase
      const exGroups = [];
      for (const ex of Object.values(MD.EXCHANGES)) {
        if (src !== 'ALL' && src !== ex.id) continue;
        if (src === 'ALL' && !q) continue; // "All" lists other exchanges once you type
        const l = exLists[ex.id];
        const rows = l ? MD.searchPairs(l, raw).filter((p) => !exclude(p.id)).slice(0, src === 'ALL' ? 4 : 60).map((p) => ({ id: p.id, kind: 'ex', ex })) : [];
        const gname = ex.futures ? `Perpetual futures · ${ex.name.replace(/ Futures$/, '')}` : `Crypto · ${ex.name}`;
        if (rows.length) exGroups.push([gname, rows]);
        else if (src === ex.id) exGroups.push([gname, [], exProblems[ex.id] === 'loading' || !l ? (exProblems[ex.id] && exProblems[ex.id] !== 'loading' ? exProblems[ex.id] : `Loading ${ex.name} symbols…`) : `Nothing found on ${ex.name} for "${raw}".`]);
      }
      const binGroup = ['Crypto · Binance', cryptoRows];
      let groups;
      if (src === 'BINANCE') groups = [binGroup, bGroup];
      else if (src === 'STOCKS') groups = stockGroups;
      else if (src !== 'ALL') groups = exGroups;
      else groups = stocksFirst ? [...stockGroups, binGroup, ...exGroups] : [binGroup, ...exGroups, ...stockGroups];
      items = [];
      list.innerHTML = '';
      for (const [label, rows, note] of groups) {
        if (!rows.length && !note) continue;
        list.appendChild(h('div', { class: 'list-group' }, label));
        if (note) list.appendChild(h('div', { class: 'muted list-empty' }, note));
        for (const row of rows) {
          const i = items.length;
          items.push(row);
          let detail;
          if (row.kind === 'crypto') detail = isDemo(row.id) ? 'Demo feed' : row.id.startsWith('CSV:') ? 'Imported CSV' : 'Crypto · Binance';
          else if (row.kind === 'ex') detail = row.ex.futures ? `Perpetual future · ${row.ex.name}` : `Crypto · ${row.ex.name}`;
          else if (row.kind === 'bstock') {
            const t = MD.bStockTicker(row.id), named = stockHits.find((r) => r.us && r.symbol.replace(/[^A-Z0-9]/g, '') === t);
            detail = `${named ? named.name : 'Tokenized ' + t} · bStock · free, live`;
          } else {
            const r = row.r;
            detail = [r.name, r.type === 'Physical Currency' ? 'Forex' : r.type === 'Common Stock' ? null : r.type, r.exchange && r.exchange !== 'Forex' ? r.exchange : null].filter(Boolean).join(' · ') || (r.type || 'Stock');
            if (!r.us) detail += ' · may need a paid plan';
          }
          list.appendChild(h('div', { class: 'list-row' + (i === sel ? ' sel' : ''), onclick: () => pick(row.id) },
            h('b', {}, bare(row.id), row.kind === 'ex' ? h('i', { class: 'ex-tag' }, row.ex.tag) : null), h('span', { class: 'muted' }, detail,
              row.kind === 'stock' && !state.stocks.key ? h('i', { class: 'needs-key' }, 'needs free key') : null)));
        }
      }
      if (!items.length && raw && !groups.some((g) => g[2])) list.appendChild(h('div', { class: 'muted list-empty' }, stockQ === raw || !raw ? `Nothing found for "${raw}".` : 'Searching…'));
      sel = Math.min(sel, Math.max(0, items.length - 1));
    };
    const pick = (id) => {
      close();
      const go = () => (opts.onPick || openSymbol)(id);
      if (isStock(id) && !state.stocks.key) openStockSettings(go); else go();
    };
    const queueStockSearch = () => {
      clearTimeout(stockTimer);
      const raw = input.value.trim();
      if (!raw || PREVIEW) { stockQ = raw; return; }
      stockTimer = setTimeout(async () => {
        try {
          const r = await MD.searchStocks(raw);
          if (input.value.trim() === raw) { stockHits = r; stockQ = raw; render(); }
        } catch (e) { if (input.value.trim() === raw) { stockHits = []; stockQ = raw; render(); } }
      }, 250);
    };
    input.addEventListener('input', () => { sel = 0; render(); queueStockSearch(); });
    loadEx();
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { sel = Math.min(items.length - 1, sel + 1); render(); e.preventDefault(); list.querySelector('.sel')?.scrollIntoView({ block: 'nearest' }); }
      else if (e.key === 'ArrowUp') { sel = Math.max(0, sel - 1); render(); e.preventDefault(); list.querySelector('.sel')?.scrollIntoView({ block: 'nearest' }); }
      else if (e.key === 'Enter') { const it = items[sel]; if (it) pick(it.id); }
    });
    render();
    queueStockSearch();
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    try { symbols = await MD.allSymbols(); render(); } catch (e) { /* offline: only demo/csv + typed */ }
  }

  // ---- stock & forex data settings (Twelve Data key, plan limits, usage)
  function openStockSettings(after) {
    const keyInput = h('input', { type: 'password', id: 'tdKey', value: state.stocks.key, placeholder: 'Paste your Twelve Data API key', autocomplete: 'off', spellcheck: 'false' });
    const perMin = h('input', { type: 'number', id: 'tdPerMin', value: state.stocks.perMin, min: 1, step: 1 });
    const perDay = h('input', { type: 'number', id: 'tdPerDay', value: state.stocks.perDay, min: 1, step: 1 });
    const result = h('p', { class: 'td-result', role: 'status' });
    const u = MD.stockUsage();
    const body = h('div', { class: 'form td-dialog' },
      h('p', {}, 'Stocks, ETFs and forex come from Twelve Data. Their free plan needs an API key: sign up (free, about a minute) and copy the key from your dashboard.'),
      h('a', { href: 'https://twelvedata.com/pricing', target: '_blank', rel: 'noopener noreferrer', class: 'td-link' }, 'Get a free Twelve Data key ↗'),
      h('label', { for: 'tdKey' }, h('span', {}, 'API key'), keyInput),
      h('div', { class: 'td-demo' }, h('span', { class: 'muted' }, 'Just trying it out?'),
        h('button', { class: 'btn small-btn', onclick: () => { keyInput.value = 'demo'; result.className = 'td-result muted'; result.textContent = 'The demo key only works for AAPL and EUR/USD.'; } }, 'Use the demo key')),
      h('details', { class: 'td-limits' }, h('summary', {}, 'Plan limits'),
        h('p', { class: 'muted' }, 'Only change these if you have a paid Twelve Data plan. Candela spreads chart updates across the day to stay within them.'),
        h('label', { for: 'tdPerMin' }, h('span', {}, 'Requests per minute'), perMin),
        h('label', { for: 'tdPerDay' }, h('span', {}, 'Requests per day'), perDay)),
      h('p', { class: 'muted' }, `Used today: ${u.used} of ${u.perDay} requests (resets at midnight UTC). Charts of stocks refresh every minute or two while the market is open, and slower when you have many open.`),
      h('p', { class: 'muted' }, 'Your key is kept in this browser and, when the alert server runs, on the server so it can check stock alerts. Twelve Data’s free plan is meant for personal use.'),
      result);
    const apply = () => {
      state.stocks = { key: keyInput.value.trim(), perMin: Math.max(1, +perMin.value || 8), perDay: Math.max(1, +perDay.value || 800) };
      MD.stockConfig(state.stocks);
      save();
      pushStockKeyToServer();
    };
    const m = openModal('Stocks & forex data', body, {
      footer: [
        h('button', { class: 'btn', onclick: async () => {
          if (!keyInput.value.trim()) { result.className = 'td-result bad'; result.textContent = 'Paste a key first.'; return; }
          MD.stockConfig({ key: keyInput.value.trim() });
          result.className = 'td-result muted';
          result.textContent = 'Checking…';
          try {
            const r = await MD.checkStockKey();
            result.className = 'td-result ok';
            result.textContent = `✓ The key works (plan: ${r.plan}).`;
          } catch (e) {
            result.className = 'td-result bad';
            result.textContent = '✗ ' + (e.code === 401 || e.code === 403 ? 'Twelve Data did not accept this key.' : e.message);
          } finally { MD.stockConfig({ key: state.stocks.key }); }
        } }, 'Check key'),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn ghost', onclick: () => m.close() }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: () => {
          apply();
          m.close();
          toast(state.stocks.key ? 'Stock data key saved' : 'Stock data key removed', 'info', 2000);
          for (const sl of slots) if (isStock(sl.symbol) && ['needskey', 'error', 'limit'].includes(sl.status)) sl.load(sl.symbol, sl.tf);
          startTickers();
          syncMarkerFeeds();
          if (after && state.stocks.key) after();
        } }, 'Save'),
      ],
    });
    keyInput.focus();
  }

  $('#csvInput').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const { bars, interval } = MD.parseCSV(await f.text());
      const name = 'CSV:' + f.name.replace(/\.[^.]+$/, '').toUpperCase().replace(/[^A-Z0-9._-]/g, '_');
      csvData[name] = { bars, interval };
      closeModal();
      toast(`Imported ${bars.length} bars from ${f.name}`, 'info');
      if (csvTarget === 'compare') active.addCompare(name); else openSymbol(name);
      csvTarget = 'main';
    } catch (err) { toast('CSV import failed: ' + err.message, 'error', 7000); }
  });

  // ---- indicator picker (adds to the active chart)
  function openIndicatorPicker() {
    const slot = active;
    const input = h('input', { class: 'search', placeholder: 'Search indicators…', spellcheck: 'false' });
    const list = h('div', { class: 'list' });
    const render = () => {
      const q = input.value.trim().toLowerCase();
      list.innerHTML = '';
      const mine = state.scripts.filter((sc) => scriptDefs.get(sc.id) && (!q || (sc.name || '').toLowerCase().includes(q)));
      if (!q || mine.length || 'script custom'.includes(q)) {
        list.appendChild(h('div', { class: 'list-group' }, 'My scripts'));
        for (const sc of mine) {
          const d = scriptDefs.get(sc.id);
          const row = h('div', { class: 'list-row', onclick: () => {
            slot.chart.addIndicator(d);
            slot.persistIndicators();
            row.classList.add('flash');
            setTimeout(() => row.classList.remove('flash'), 500);
            toast(`Added ${d.name}${slots.length > 1 ? ` to ${bare(slot.symbol)}` : ''}`, 'info', 1800);
          } }, h('b', {}, d.name), h('span', { class: 'row-actions' },
            h('span', { class: 'muted' }, d.overlay ? 'Custom · price chart' : 'Custom · own pane'),
            h('button', { class: 'btn small-btn', onclick: (e) => { e.stopPropagation(); openScriptEditor(sc.id); } }, 'Edit')));
          list.appendChild(row);
        }
        list.appendChild(h('div', { class: 'list-row new-script', onclick: () => openScriptEditor(null) },
          h('b', {}, '+ Write a new script…'), h('span', { class: 'muted' }, 'Build your own indicator')));
      }
      for (const [label, overlay] of [['On the price chart', true], ['Oscillators (separate pane)', false]]) {
        const defs = IND.DEFS.filter((d) => d.overlay === overlay && (!q || (d.name + ' ' + d.short + ' ' + d.desc).toLowerCase().includes(q)));
        if (!defs.length) continue;
        list.appendChild(h('div', { class: 'list-group' }, label));
        for (const d of defs) {
          const row = h('div', { class: 'list-row', onclick: () => {
            slot.chart.addIndicator(d);
            slot.persistIndicators();
            row.classList.add('flash');
            setTimeout(() => row.classList.remove('flash'), 500);
            toast(`Added ${d.name}${slots.length > 1 ? ` to ${bare(slot.symbol)}` : ''}`, 'info', 1800);
          } }, h('b', {}, d.name), h('span', { class: 'muted' }, d.desc));
          list.appendChild(row);
        }
      }
    };
    input.addEventListener('input', render);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') list.querySelector('.list-row')?.click(); });
    const title = slots.length > 1 ? `Indicators · ${bare(slot.symbol)} ${tfName(slot.tf)}` : 'Indicators — all free, no limits';
    openModal(title, h('div', {}, input, list), { wide: true });
    render();
    input.focus();
  }

  // ---- indicator settings
  function toHex(c) {
    if (!c) return '#000000';
    if (c.startsWith('#')) return c.length === 4 ? '#' + c.slice(1).split('').map((x) => x + x).join('') : c.slice(0, 7);
    const m = c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    return m ? '#' + [m[1], m[2], m[3]].map((v) => (+v).toString(16).padStart(2, '0')).join('') : '#000000';
  }
  function alphaOf(c) { const m = c && c.match(/rgba\([^)]*,\s*([\d.]+)\)/); return m ? +m[1] : 1; }
  function applyAlpha(hex, a) {
    if (a >= 1) return hex;
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }

  function openCompareSettings(slot, cc) {
    const color = h('input', { type: 'color', value: toHex(cc.color) });
    color.addEventListener('input', () => { cc.color = color.value; slot.chart.updateCompare(cc.id, { color: cc.color }); save(); });
    const body = h('div', { class: 'form' },
      h('label', {}, h('span', {}, 'Line color'), color),
      h('p', { class: 'muted' }, `Shows ${bare(cc.symbol)} as percent change from the first visible bar, on the same scale as ${bare(slot.symbol)}.`));
    const m = openModal(`Compare · ${bare(cc.symbol)}`, body, {
      footer: [
        h('button', { class: 'btn ghost', onclick: () => { m.close(); slot.removeCompare(cc.id); } }, 'Remove'),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn primary', onclick: () => m.close() }, 'Done'),
      ],
    });
  }

  // the line styles of the Style tab, as in other charting apps
  const LINE_TYPE_ICONS = {
    line: '<svg viewBox="0 0 24 24"><path d="M3 16c3-7 6-7 8-3s5 4 10-5"/></svg>',
    linebr: '<svg viewBox="0 0 24 24"><path d="M3 16l4-6M10 13l3 2M16 12l5-6"/></svg>',
    step: '<svg viewBox="0 0 24 24"><path d="M3 19v-6h5V6h5v9h4V9h4"/></svg>',
    stepbr: '<svg viewBox="0 0 24 24"><path d="M3 19v-6h4M10 6h3v5M13 15v0h4V9h4"/></svg>',
    stepdia: '<svg viewBox="0 0 24 24"><path d="M3 19v-6h5V6h5v9h4V9h4"/><path d="M8 4l2 2-2 2-2-2zM13 13l2 2-2 2-2-2zM17 7l2 2-2 2-2-2z" fill="currentColor"/></svg>',
  };
  const LINE_TYPE_NAMES = [['line', 'Line'], ['linebr', 'Line with breaks'], ['step', 'Step line'], ['stepbr', 'Step line with breaks'], ['stepdia', 'Step line with diamonds']];
  // the dropdown: Price line toggle, then the line types
  function openLineTypeMenu(anchor, getStyle, set) {
    document.querySelector('.ltype-menu')?.remove();
    const st = getStyle();
    const menu = h('div', { class: 'ltype-menu', role: 'menu' });
    const toggle = h('button', { class: 'ltype-toggle' + (st.priceLine ? ' on' : ''), role: 'menuitemcheckbox', 'aria-checked': String(st.priceLine), onclick: () => {
      const on = !getStyle().priceLine;
      set('priceLine', on);
      toggle.classList.toggle('on', on);
      toggle.setAttribute('aria-checked', String(on));
    } }, h('span', {}, 'Price line'), h('i', { class: 'switch' }));
    menu.appendChild(toggle);
    menu.appendChild(h('div', { class: 'ltype-sep' }));
    for (const [k, name] of LINE_TYPE_NAMES) {
      const item = h('button', { class: 'ltype-item' + (k === st.type ? ' on' : ''), role: 'menuitemradio', 'aria-checked': String(k === st.type), onclick: () => { set('type', k); close(); } });
      item.innerHTML = LINE_TYPE_ICONS[k];
      item.append(name);
      menu.appendChild(item);
    }
    const r = anchor.getBoundingClientRect();
    menu.style.left = Math.min(r.left, window.innerWidth - 240) + 'px';
    menu.style.top = (r.bottom + 4 + 260 > window.innerHeight ? Math.max(8, r.top - 264) : r.bottom + 4) + 'px';
    document.body.appendChild(menu);
    const away = (e) => { if (!menu.contains(e.target) && e.target !== anchor && !anchor.contains(e.target)) close(); };
    const esc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    function close() { menu.remove(); document.removeEventListener('mousedown', away, true); document.removeEventListener('keydown', esc, true); }
    setTimeout(() => { document.addEventListener('mousedown', away, true); document.addEventListener('keydown', esc, true); }, 0);
  }

  function openIndicatorSettings(slot, id) {
    const chart = slot.chart;
    const ind = chart.indicators.find((i) => i.id === id);
    if (!ind) return;
    const def = ind.def, orig = { params: { ...ind.params }, colors: { ...ind.colors }, styles: clone(ind.styles || {}) };
    const params = { ...ind.params }, colors = { ...ind.colors }, styles = clone(ind.styles || {});
    const apply = () => chart.updateIndicator(id, params, colors, styles);

    const inputsBox = h('div', { class: 'form' });
    // compute on another timeframe (not for volume, which belongs to the chart's own candles, or scripts)
    const tfOrig = ind.tf || null;
    if (!def.script && def.id !== 'vol') {
      const IND_TFS = ['1m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '12h', '1d', '3d', '1w', '1M'];
      const sel = h('select', {});
      const fill = () => {
        sel.innerHTML = '';
        sel.appendChild(h('option', { value: '' }, `Same as chart (${tfName(slot.tf)})`));
        const list = [...new Set([...IND_TFS, ...state.customTfs, ...(ind.tf ? [ind.tf] : [])])].sort(byLength);
        for (const tf of list) sel.appendChild(h('option', { value: tf, disabled: !slot.symbol.startsWith('CSV:') && !isDemo(slot.symbol) && !MD.supportsTf(slot.symbol, tf) }, tfName(tf)));
        sel.appendChild(h('option', { value: '__custom' }, 'Custom…'));
        sel.value = ind.tf || '';
      };
      const custom = h('input', { class: 'tf-custom', placeholder: 'e.g. 2D, 3H, 2W', spellcheck: 'false', hidden: true });
      const note = h('p', { class: 'muted tf-help' });
      const showNote = () => {
        note.textContent = ind.tf && ind.tf !== slot.tf
          ? `Calculated on ${tfName(ind.tf)} candles, whatever timeframe the chart shows. E.g. SMA 200 on 1D is the 200-day average on a 4H or a weekly chart.`
          : 'Calculate on another timeframe: e.g. pick 1D for a 200-day average that stays the same on 4H, weekly or any chart.';
      };
      const setTf = (tf) => { slot.setIndicatorTf(id, tf || null); fill(); showNote(); };
      sel.addEventListener('change', () => {
        if (sel.value === '__custom') { custom.hidden = false; custom.focus(); sel.value = ind.tf || ''; return; }
        custom.hidden = true;
        setTf(sel.value);
      });
      custom.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.stopPropagation();
        const tf = MD.normalizeTf(custom.value);
        if (!tf) { custom.classList.add('bad'); return; }
        custom.classList.remove('bad');
        addCustomTf(tf);
        custom.hidden = true;
        setTf(tf);
      });
      fill();
      showNote();
      inputsBox.appendChild(h('label', {}, h('span', {}, 'Timeframe'), h('span', { class: 'tf-pick' }, sel, custom)));
      inputsBox.appendChild(note);
    }
    for (const inp of def.inputs) {
      let ctl;
      if (inp.type === 'source' || inp.type === 'select') {
        ctl = h('select', {}, (inp.type === 'source' ? IND.SOURCES : inp.options).map((o) => h('option', { value: o, selected: params[inp.key] === o }, o)));
        ctl.addEventListener('change', () => { params[inp.key] = ctl.value; apply(); });
      } else {
        ctl = h('input', { type: 'number', value: params[inp.key], min: inp.min, max: inp.max, step: inp.step || (inp.type === 'int' ? 1 : 'any') });
        ctl.addEventListener('input', () => {
          let v = inp.type === 'int' ? Math.round(+ctl.value) : +ctl.value;
          if (!isFinite(v) || ctl.value === '') return;
          if (inp.min != null) v = Math.max(inp.min, v);
          if (inp.max != null) v = Math.min(inp.max, v);
          params[inp.key] = v;
          apply();
        });
      }
      inputsBox.appendChild(h('label', {}, h('span', {}, inp.label), ctl));
    }
    if (!def.inputs.length) inputsBox.appendChild(h('p', { class: 'muted' }, 'This indicator has no inputs.'));

    const styleBox = h('div', { class: 'form' });
    const colorRow = (label, key, fallback) => {
      const cur = colors[key] || fallback, a = alphaOf(cur);
      const ctl = h('input', { type: 'color', value: toHex(cur) });
      ctl.addEventListener('input', () => { colors[key] = applyAlpha(ctl.value, a); apply(); });
      styleBox.appendChild(h('label', {}, h('span', {}, label), ctl));
    };
    // lines: color, thickness 1-4 and line type (Line, Step line…, with a price line option)
    const lineRow = (pl) => {
      const st = styles[pl.key] || (styles[pl.key] = {});
      const cur = () => chart.plotStyle({ styles, colors }, pl);
      const set = (k, v) => { st[k] = v; apply(); };
      const kids = [];
      if (!pl.dynamic) {
        const c0 = colors[pl.key] || pl.color, a = alphaOf(c0);
        const ctl = h('input', { type: 'color', value: toHex(c0), title: 'Color' });
        ctl.addEventListener('input', () => { colors[pl.key] = applyAlpha(ctl.value, a); apply(); });
        kids.push(ctl);
      }
      const grade = cur().grade || (cur().width <= 1.5 ? 1 : Math.min(4, Math.round(cur().width)));
      const widths = h('span', { class: 'seg', role: 'radiogroup', 'aria-label': 'Thickness' });
      for (const g of [1, 2, 3, 4]) {
        const b = h('button', { class: 'seg-btn' + (g === grade ? ' on' : ''), title: `Thickness ${g}`, 'aria-checked': String(g === grade), role: 'radio', onclick: () => {
          set('width', g);
          for (const x of widths.children) x.classList.toggle('on', x === b);
        } }, h('i', { class: 'seg-line', style: `height:${[1, 2, 3, 4][g - 1]}px` }));
        widths.appendChild(b);
      }
      const typeBtn = h('button', { class: 'ltype-btn', title: 'Line style', 'aria-haspopup': 'menu' });
      const showType = () => { typeBtn.innerHTML = LINE_TYPE_ICONS[cur().type] + '<span class="caret"></span>'; };
      typeBtn.addEventListener('click', (e) => { e.preventDefault(); openLineTypeMenu(typeBtn, () => cur(), (k, v) => { set(k, v); showType(); }); });
      showType();
      kids.push(widths, typeBtn);
      styleBox.appendChild(h('div', { class: 'style-row' }, h('span', {}, pl.name), h('span', { class: 'style-ctl' }, kids)));
    };
    for (const pl of def.plots) {
      if (pl.palette) pl.palette.forEach((c, k) => colorRow(`${pl.name} ${def.id === 'vol' ? (k ? 'down' : 'up') : '#' + (k + 1)}`, `${pl.key}.${k}`, c));
      else if ((pl.style || 'line') === 'line') lineRow(pl);
      else if (!pl.dynamic) colorRow(pl.style === 'mark' ? `${pl.name} marker` : pl.name, pl.key, pl.color);
    }
    for (const f of def.fills || []) {
      if (f.dynamic) continue;
      colorRow(f.colorDown ? 'Fill (up)' : 'Background fill', f.key, f.color);
      if (f.colorDown) colorRow('Fill (down)', f.key + 'Down', f.colorDown);
    }
    if (def.bandFill) colorRow('Band fill', 'band', def.bandColor || chart.theme.band);
    if (def.plots.some((pl) => pl.dynamic) || (def.fills || []).some((f) => f.dynamic)) styleBox.appendChild(h('p', { class: 'muted' }, 'Some colors are set bar by bar by the script.'));

    const tabs = h('div', { class: 'tabs' });
    const panes = [['Inputs', inputsBox], ['Style', styleBox]];
    const body = h('div', {}, tabs, inputsBox, styleBox);
    styleBox.hidden = true;
    for (const [name, box] of panes) {
      const t = h('button', { class: 'tab' + (box === inputsBox ? ' active' : ''), onclick: () => {
        for (const [, b] of panes) b.hidden = b !== box;
        for (const x of tabs.children) x.classList.toggle('active', x === t);
      } }, name);
      tabs.appendChild(t);
    }
    let committed = false;
    const footer = [
      h('button', { class: 'btn ghost', onclick: () => {
        Object.assign(params, IND.defaults(def));
        for (const k of Object.keys(colors)) delete colors[k];
        for (const k of Object.keys(styles)) delete styles[k];
        apply();
        slot.setIndicatorTf(id, null);
        openIndicatorSettings(slot, id);
      } }, 'Defaults'),
      def.script ? h('button', { class: 'btn ghost', onclick: () => { committed = true; slot.persistIndicators(); openScriptEditor(def.scriptId); } }, 'Edit script') : null,
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn ghost', onclick: () => m.close() }, 'Cancel'),
      h('button', { class: 'btn primary', onclick: () => { committed = true; slot.persistIndicators(); closeModal(); } }, 'OK'),
    ];
    const m = openModal(def.name, body, {
      footer,
      onClose: () => { if (!committed) { chart.updateIndicator(id, orig.params, orig.colors, orig.styles); if ((ind.tf || null) !== tfOrig) slot.setIndicatorTf(id, tfOrig); } },
    });
  }

  // ------------------------------------------------------------------ custom scripts: editor
  const NEW_SCRIPT = `// My indicator: edit it, then press Save (Ctrl+S) or Add to chart (Ctrl+Enter)
name "My indicator"
overlay
input length = 20 "Length" min 1

basis = sma(close, length)
plot basis "Average" color blue width 2
`;

  const EXAMPLES = [
    {
      title: 'RSI with signal line', desc: 'Oscillator with a smoothed signal, zones and cross markers',
      code: `// RSI with a smoothed signal line, an overbought/oversold zone,
// and markers where RSI leaves the oversold zone.
name "RSI + Signal"
input length = 14 "RSI length" min 1
input smooth = 9 "Signal length" min 1
input source = close "Source"

r = rsi(source, length)
s = ema(r, smooth)

level 70
level 30
fill 70, 30 color fade(purple, 0.08)
plot r "RSI" color purple width 2
plot s "Signal" color orange
mark crossover(r, 30) "Up" below color green
mark crossunder(r, 70) "Down" above color red
`,
    },
    {
      title: 'Moving average cross', desc: 'Two averages, shaded by trend, with buy/sell markers',
      code: `// Fast/slow moving average cross with a trend-colored band
name "MA Cross"
overlay
input fast = 9 "Fast length" min 1
input slow = 21 "Slow length" min 1

f = ema(close, fast)
s = sma(close, slow)

fill f, s color f > s ? fade(green, 0.15) : fade(red, 0.15)
plot f "Fast" color blue width 2
plot s "Slow" color orange width 2
mark crossover(f, s) "Buy" below color green
mark crossunder(f, s) "Sell" above color red
`,
    },
    {
      title: 'MACD with 4-color histogram', desc: 'Histogram colored by direction and momentum',
      code: `// MACD where the histogram color shows direction (green/red)
// and whether momentum is growing (strong) or fading (light).
name "MACD Pro"
input fast = 12 "Fast length" min 1
input slow = 26 "Slow length" min 1
input signal = 9 "Signal length" min 1

m = ema(close, fast) - ema(close, slow)
s = ema(m, signal)
h = m - s

up = h >= 0
growing = up ? h > h[1] : h < h[1]
plot h "Histogram" style histogram color up ? (growing ? #22AB94 : #9FDCCF) : (growing ? #F7525F : #FAB3B9)
plot m "MACD" color blue width 1.5
plot s "Signal" color orange width 1.5
level 0
`,
    },
    {
      title: 'Bollinger %B', desc: 'Where price sits inside the Bollinger Bands',
      code: `// %B = 0 at the lower band, 1 at the upper band
name "Bollinger %B"
short "%B"
input length = 20 "Length" min 1
input mult = 2.0 "Std dev" min 0.1

basis = sma(close, length)
dev = mult * stdev(close, length)
pb = (close - (basis - dev)) / (2 * dev)

level 1
level 0.5
level 0
fill 1, 0 color fade(teal, 0.06)
plot pb "%B" color pb > 1 ? red : pb < 0 ? green : teal width 2
`,
    },
    {
      title: 'Volume spikes', desc: 'Marks candles with unusually high volume',
      code: `// Flags bars whose volume is far above its recent average
name "Volume Spikes"
overlay
input length = 20 "Average length" min 1
input factor = 2.5 "Spike factor" min 1

spike = volume > sma(volume, length) * factor
mark spike and close >= open "Vol" below color green
mark spike and close < open "Vol" above color red
`,
    },
    {
      title: 'ATR trailing stop', desc: 'Volatility stop line that flips with the trend',
      code: `// A simple volatility channel: price above the line is an uptrend
name "ATR Stop"
overlay
input length = 14 "ATR length" min 1
input mult = 3.0 "Multiplier" min 0.1

a = atr(length) * mult
longStop = highest(close, length) - a
shortStop = lowest(close, length) + a
trend = close > shortStop[1] ? 1 : close < longStop[1] ? -1 : 0
dir = valuewhen(trend != 0, trend)
stopLine = dir > 0 ? longStop : shortStop

plot stopLine "Stop" color dir > 0 ? green : red width 2
mark cross(dir, 0) and dir > 0 "Long" below color green
mark cross(dir, 0) and dir < 0 "Short" above color red
`,
    },
  ];

  const scriptById = (id) => state.scripts.find((s) => s.id === id);

  // Push a saved script to every chart that uses it (moving it between pane and price chart if needed).
  function applyScriptToCharts(id, def) {
    const defId = 'script:' + id;
    for (const s of slots) {
      const c = s.chart;
      let changed = false;
      for (const ind of [...c.indicators]) {
        if (ind.def.id !== defId || (ind.pane === c.main) === !!def.overlay) continue;
        const keep = { params: ind.params, colors: ind.colors, visible: ind.visible, styles: ind.styles, tf: ind.tf };
        c.removeIndicator(ind.id);
        c.addIndicator(def, keep.params, { colors: keep.colors, visible: keep.visible, styles: keep.styles, tf: keep.tf });
        changed = true;
      }
      if (c.replaceDef(defId, def) || changed) s.persistIndicators();
    }
  }

  function removeScriptFromCharts(id) {
    for (const s of slots) {
      const doomed = s.chart.indicators.filter((i) => i.def.id === 'script:' + id);
      for (const ind of doomed) s.chart.removeIndicator(ind.id);
      if (doomed.length) s.persistIndicators();
    }
    // charts not currently shown in the layout
    for (const cfg of state.charts) if (cfg.indicators) cfg.indicators = cfg.indicators.filter((i) => i.type !== 'script:' + id);
  }

  const LINE_H = 20, PAD_TOP = 10;

  function openScriptEditor(startId) {
    let cur = { id: null };
    let result = null; // last check: { ok, def } or { ok: false, error }
    let deleteArmed = false;

    const ta = h('textarea', { class: 'code-input', id: 'scriptCode', spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', wrap: 'off', 'aria-label': 'Script code' });
    const hl = h('pre', { class: 'code-hl', 'aria-hidden': 'true' });
    const gutter = h('div', { class: 'code-gutter', 'aria-hidden': 'true' });
    const errLine = h('div', { class: 'code-errline' });
    errLine.hidden = true;
    const area = h('div', { class: 'code-area' }, hl, errLine, ta);
    const status = h('div', { class: 'se-status', role: 'status' });
    const list = h('div', { class: 'se-list' });

    const saveBtn = h('button', { class: 'btn', title: 'Save (Ctrl+S)', onclick: () => doSave() }, 'Save');
    const addBtn = h('button', { class: 'btn primary', title: 'Add to the active chart (Ctrl+Enter)', onclick: () => addToChart() }, 'Add to chart');
    const delBtn = h('button', { class: 'btn ghost danger-text', onclick: () => doDelete() }, 'Delete');

    // ---- reference panel
    const R = CS.reference();
    const refRow = (code, doc, insert) => {
      const row = h('div', { class: 'ref-row' + (insert ? ' ins' : '') }, h('code', {}, code), h('span', {}, doc));
      if (insert) { row.title = 'Click to insert'; row.addEventListener('click', () => insertText(insert)); }
      return row;
    };
    const section = (title, rows, open = false) => {
      const d = h('details', { class: 'ref-sec' }, h('summary', {}, title), ...rows);
      d.open = open;
      return d;
    };
    const ref = h('div', { class: 'se-ref' },
      h('div', { class: 'se-ref-head' }, 'Reference'),
      section('Statements', R.statements.map(([c, d]) => refRow(c, d)), true),
      section('Operators', R.operators.map(([c, d]) => refRow(c, d))),
      section('Built-in values', R.series.map(([c, d]) => refRow(c, d))),
      ...Object.entries(R.functions).map(([g, fns]) => section(g, fns.map(([sig, d, name]) => refRow(sig, d, name + '(')))),
      section('Colors', [h('div', { class: 'ref-colors' }, R.colors.map(([n, c]) => {
        const b = h('button', { class: 'ref-color', title: c, onclick: () => insertText(n) }, h('i', { style: `background:${c}` }), n);
        return b;
      })), h('p', { class: 'muted' }, 'Also #RRGGBB, rgba(r, g, b, a) and fade(color, opacity).')]));

    const body = h('div', { class: 'se' },
      h('div', { class: 'se-side' }, list),
      h('div', { class: 'se-main' }, h('div', { class: 'code-wrap' }, gutter, area), status),
      ref);
    const m = openModal('Script editor', body, { cls: 'xwide', footer: [delBtn, h('span', { class: 'spacer' }), h('span', { class: 'muted se-hint' }, 'Ctrl+S saves · Ctrl+Enter adds to chart'), saveBtn, addBtn] });

    // ---- editor state
    const savedCode = () => (cur.id ? (scriptById(cur.id) || {}).code : null);
    const isDirty = () => ta.value !== savedCode();
    const draftKey = () => cur.id || '__new__';

    function load(id) {
      cur = { id };
      const sc = id && scriptById(id);
      ta.value = id ? state.scriptDrafts[id] ?? sc.code : state.scriptDrafts.__new__ ?? NEW_SCRIPT;
      deleteArmed = false;
      ta.scrollTop = 0;
      ta.setSelectionRange(0, 0);
      refresh(true);
      renderList();
    }

    function loadExample(ex) {
      cur = { id: null };
      ta.value = ex.code;
      ta.scrollTop = 0;
      refresh(true);
      renderList();
      ta.focus();
      ta.setSelectionRange(0, 0);
    }

    function renderList() {
      list.innerHTML = '';
      list.appendChild(h('button', { class: 'btn se-new', onclick: () => { delete state.scriptDrafts.__new__; save(); load(null); ta.focus(); } }, '+ New script'));
      list.appendChild(h('div', { class: 'menu-label' }, 'My scripts'));
      const items = [];
      if (!cur.id) items.push({ id: null, name: (result && result.ok && result.def.name) || 'Untitled', unsaved: true });
      else if (state.scriptDrafts.__new__) items.push({ id: null, name: 'Untitled', unsaved: true });
      for (const sc of state.scripts) items.push({ id: sc.id, name: sc.name || 'Untitled', unsaved: !!state.scriptDrafts[sc.id] });
      if (!items.length) list.appendChild(h('div', { class: 'muted se-empty' }, 'Nothing saved yet.'));
      for (const it of items) {
        const row = h('button', { class: 'se-item' + (it.id === cur.id ? ' active' : ''), onclick: () => { if (it.id !== cur.id) load(it.id); } },
          h('span', {}, it.name), it.unsaved ? h('i', { class: 'se-dot', title: 'Unsaved changes' }) : null);
        list.appendChild(row);
      }
      list.appendChild(h('div', { class: 'menu-label' }, 'Examples'));
      for (const ex of EXAMPLES) list.appendChild(h('button', { class: 'se-item ex', title: ex.desc, onclick: () => loadExample(ex) }, h('span', {}, ex.title), h('small', {}, ex.desc)));
    }

    let checkTimer = null;
    function refresh(immediate) {
      hl.innerHTML = CS.highlight(ta.value);
      const lines = ta.value.split('\n').length;
      if (gutter.childElementCount !== lines) gutter.innerHTML = Array.from({ length: lines }, (_, i) => `<div>${i + 1}</div>`).join('');
      syncScroll();
      // keep unsaved edits so closing the editor never loses work
      if (isDirty() && !(cur.id === null && ta.value === NEW_SCRIPT)) state.scriptDrafts[draftKey()] = ta.value;
      else delete state.scriptDrafts[draftKey()];
      save();
      clearTimeout(checkTimer);
      if (immediate) check(); else checkTimer = setTimeout(check, 220);
      updateButtons();
    }

    function check() {
      errLine.hidden = true;
      status.innerHTML = '';
      try {
        const def = CS.compile(ta.value, cur.id || 'draft');
        const testBars = active && active.chart.raw.length ? active.chart.raw : MD.demoBars('1h', 500);
        const t0 = performance.now();
        def.calc(testBars, IND.defaults(def));
        const ms = performance.now() - t0;
        result = { ok: true, def };
        const where = def.overlay ? 'on the price chart' : 'in its own pane';
        const what = [
          def.plots.filter((p) => p.style !== 'mark').length && `${def.plots.filter((p) => p.style !== 'mark').length} plot${def.plots.filter((p) => p.style !== 'mark').length > 1 ? 's' : ''}`,
          def.plots.filter((p) => p.style === 'mark').length && `${def.plots.filter((p) => p.style === 'mark').length} marker type${def.plots.filter((p) => p.style === 'mark').length > 1 ? 's' : ''}`,
          def.inputs.length && `${def.inputs.length} input${def.inputs.length > 1 ? 's' : ''}`,
        ].filter(Boolean).join(', ');
        status.className = 'se-status ok';
        status.append(h('b', {}, '✓ Ready'), ` ${def.name} · ${where}${what ? ' · ' + what : ''} · ran on ${testBars.length} bars in ${ms < 1 ? '<1' : Math.round(ms)} ms`);
      } catch (e) {
        const line = e.line || 1, col = e.col || 1;
        result = { ok: false, error: e };
        status.className = 'se-status err';
        const go = h('button', { class: 'linklike', onclick: () => goTo(line, col) }, `Line ${line}, column ${col}`);
        status.append(h('b', {}, '✗ '), go, ': ' + (e instanceof CS.ScriptError ? e.message : 'Unexpected error: ' + e.message));
        if (!(e instanceof CS.ScriptError)) console.error(e);
        errLine.dataset.line = line;
        errLine.hidden = false;
        syncScroll();
      }
      if (!cur.id) renderList();
      updateButtons();
    }

    function updateButtons() {
      const ok = !!(result && result.ok);
      const dirty = isDirty();
      saveBtn.disabled = !ok || !dirty;
      saveBtn.textContent = cur.id && !dirty ? 'Saved' : 'Save';
      addBtn.disabled = !ok;
      addBtn.textContent = dirty ? 'Save & add to chart' : 'Add to chart';
      delBtn.hidden = !cur.id;
      delBtn.textContent = deleteArmed ? 'Click again to delete' : 'Delete';
    }

    function offsetOf(line, col) {
      const lines = ta.value.split('\n');
      let off = 0;
      for (let i = 0; i < line - 1 && i < lines.length; i++) off += lines[i].length + 1;
      return Math.min(ta.value.length, off + col - 1);
    }
    function goTo(line, col) {
      const off = offsetOf(line, col);
      ta.focus();
      ta.setSelectionRange(off, off);
      ta.scrollTop = Math.max(0, (line - 4) * LINE_H);
      syncScroll();
    }

    function syncScroll() {
      hl.scrollTop = ta.scrollTop;
      hl.scrollLeft = ta.scrollLeft;
      gutter.scrollTop = ta.scrollTop;
      if (!errLine.hidden) errLine.style.top = PAD_TOP + (errLine.dataset.line - 1) * LINE_H - ta.scrollTop + 'px';
    }

    function insertText(text) {
      ta.focus();
      ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, 'end');
      refresh();
    }

    function doSave() {
      if (!result || !result.ok) return null;
      let sc = cur.id && scriptById(cur.id);
      if (!sc) {
        sc = { id: uid(), code: '' };
        state.scripts.push(sc);
        delete state.scriptDrafts.__new__;
        cur.id = sc.id;
      }
      sc.code = ta.value;
      sc.name = result.def.name;
      delete state.scriptDrafts[sc.id];
      const def = compileSaved(sc);
      if (def) applyScriptToCharts(sc.id, def);
      recheckMarkerAlerts();
      pushScriptToServer(sc);
      save();
      renderList();
      updateButtons();
      toast(`Saved "${sc.name}"`, 'info', 1800);
      return def;
    }

    function addToChart() {
      const def = isDirty() || !cur.id ? doSave() : scriptDefs.get(cur.id);
      if (!def) return;
      active.chart.addIndicator(def);
      active.persistIndicators();
      toast(`Added "${def.name}" to ${bare(active.symbol)}`, 'info', 2200);
    }

    function doDelete() {
      if (!cur.id) return;
      if (!deleteArmed) { deleteArmed = true; updateButtons(); setTimeout(() => { deleteArmed = false; updateButtons(); }, 3000); return; }
      const sc = scriptById(cur.id);
      removeScriptFromCharts(cur.id);
      state.scripts = state.scripts.filter((s) => s.id !== cur.id);
      delete state.scriptDrafts[cur.id];
      scriptDefs.delete(cur.id);
      recheckMarkerAlerts();
      deleteScriptOnServer(cur.id);
      save();
      toast(`Deleted "${sc ? sc.name : 'script'}"`, 'info', 2000);
      load(state.scripts.length ? state.scripts[0].id : null);
    }

    // ---- editing behavior
    ta.addEventListener('input', () => { deleteArmed = false; refresh(); });
    ta.addEventListener('scroll', syncScroll);
    // shortcuts work while the editor is open, wherever the focus is (saving rebuilds the script
    // list, which can drop focus to the page)
    const onKey = (e) => {
      if (!m.dlg.isConnected) { document.removeEventListener('keydown', onKey, true); return; }
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); e.stopPropagation(); doSave(); }
      else if (mod && e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); addToChart(); }
    };
    document.addEventListener('keydown', onKey, true);
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') return; // closes the editor (drafts are kept)
      const mod = e.ctrlKey || e.metaKey;
      if (mod && (e.key.toLowerCase() === 's' || e.key === 'Enter')) return; // handled above
      e.stopPropagation();
      if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); insertText('  '); return; }
      if (e.key === 'Enter' && !mod) {
        // keep the current line's indentation
        const before = ta.value.slice(0, ta.selectionStart), indent = before.slice(before.lastIndexOf('\n') + 1).match(/^[ \t]*/)[0];
        if (indent) { e.preventDefault(); insertText('\n' + indent); }
      }
    });

    const startWith = startId && scriptById(startId) ? startId : !state.scriptDrafts.__new__ && state.scripts.length && startId !== null ? state.scripts[0].id : null;
    load(startWith);
    ta.focus();
    return m;
  }

  // ------------------------------------------------------------------ watchlist
  let tickStop = null;

  function renderWatchlist() {
    const wl = $('#watchlist');
    wl.innerHTML = '';
    for (const sym of state.watchlist) {
      const q = quotes[sym];
      const row = h('div', { class: 'wl-row' + (active && sym === active.symbol ? ' active' : ''), 'data-sym': sym, onclick: () => openSymbol(sym) },
        h('span', { class: 'wl-sym', title: isStock(sym) ? `${bare(sym)} (${MD.isForex(sym) ? 'forex' : 'stock'}, Twelve Data)` : MD.isBStock(sym) ? `${bare(sym)}: Binance bStock tracking ${MD.bStockTicker(sym)}` : exOf(sym) ? `${bare(sym)} on ${exOf(sym).name}` : `${sym} on Binance` },
          bare(sym), exOf(sym) ? h('i', { class: 'ex-tag' }, exOf(sym).tag) : null),
        h('span', { class: 'wl-last' }, q ? q.c.toFixed(decimalsFor(q.c)) : '—'),
        h('span', { class: 'wl-chg' }, q ? fmtChg(q) : ''),
        h('button', { class: 'wl-x', title: 'Remove', onclick: (e) => {
          e.stopPropagation();
          state.watchlist = state.watchlist.filter((s) => s !== sym);
          save(); renderWatchlist(); startTickers();
        } }, '✕'));
      if (q) row.classList.add(q.c >= q.o ? 'is-up' : 'is-down');
      wl.appendChild(row);
    }
  }
  const fmtChg = (q) => { const p = ((q.c - q.o) / q.o) * 100; return (p >= 0 ? '+' : '') + p.toFixed(2) + '%'; };

  function updateQuote(sym, c, o) {
    const prev = quotes[sym];
    quotes[sym] = { c, o };
    const row = document.querySelector(`.wl-row[data-sym="${sym}"]`);
    if (!row) return;
    $('.wl-last', row).textContent = c.toFixed(decimalsFor(c));
    $('.wl-chg', row).textContent = fmtChg(quotes[sym]);
    row.classList.toggle('is-up', c >= o);
    row.classList.toggle('is-down', c < o);
    if (prev && prev.c !== c) {
      row.classList.remove('tick-up', 'tick-down');
      void row.offsetWidth;
      row.classList.add(c > prev.c ? 'tick-up' : 'tick-down');
    }
  }

  async function startTickers() {
    if (PREVIEW) return;
    if (tickStop) tickStop();
    tickStop = null;
    const syms = [...new Set([...state.watchlist, ...priceAlerts().filter((a) => a.active).map((a) => a.symbol)])]
      .filter((s) => !isDemo(s) && !s.startsWith('CSV:') && !isStock(s) && !exOf(s));
    pollStockQuotes();
    pollExQuotes();
    if (!syms.length) return;
    try { (await MD.tickers24(syms)).forEach((q) => updateQuote(q.s, q.c, q.o)); } catch (e) { /* offline */ }
    tickStop = MD.tickerStream(syms, (q) => {
      updateQuote(q.s, q.c, q.o);
      // charts with a live stream already check alerts for their own symbol
      if (!slots.some((s) => s.symbol === q.s && s.mode === 'live')) checkAlerts(q.s, q.c);
    });
  }

  // Bybit, KuCoin, Kraken, Coinbase prices for the watchlist and for price alerts running in this tab
  let exQuoteTimer = null;
  async function pollExQuotes() {
    clearTimeout(exQuoteTimer);
    exQuoteTimer = null;
    if (PREVIEW) return;
    const alertSyms = priceAlerts().filter((a) => a.active && exOf(a.symbol) && !servedByServer(a)).map((a) => a.symbol);
    const syms = [...new Set([...state.watchlist.filter(exOf), ...alertSyms])];
    if (!syms.length) return;
    await Promise.all(syms.map(async (sym) => {
      let q;
      try { q = await MD.ticker(sym); } catch (e) { return; }
      updateQuote(sym, q.c, q.o);
      if (!slots.some((x) => x.symbol === sym && x.mode === 'live')) checkAlerts(sym, q.c);
    }));
    exQuoteTimer = setTimeout(pollExQuotes, alertSyms.length ? 5000 : 10000);
  }

  // ---- the chart's coin on every exchange (side panel): price, 24h change, and the gap to this chart
  let acrossKey = null, acrossBase = '', acrossRows = [], acrossTimer = null, acrossGen = 0;
  function updateAcross() {
    const sec = $('#acrossSec');
    const bq = active && !PREVIEW ? MD.baseQuote(active.symbol) : null;
    sec.classList.toggle('hidden', !bq);
    sec.classList.toggle('folded', !state.showAcross);
    $('#acrossToggle').setAttribute('aria-expanded', String(!!state.showAcross));
    if (!bq) { clearTimeout(acrossTimer); acrossGen++; acrossKey = null; return; }
    $('#acrossTitle').textContent = `${bq.base} across exchanges`;
    const key = bq.base + '/' + bq.quote;
    if (key === acrossKey) { renderAcross(); return; }
    acrossKey = key; acrossBase = bq.base; acrossRows = [];
    renderAcross();
    const gen = ++acrossGen;
    clearTimeout(acrossTimer);
    MD.samePairs(bq.base, bq.quote).then((rows) => {
      if (gen !== acrossGen) return;
      acrossRows = rows;
      renderAcross();
      refreshAcross(gen);
    });
  }
  async function refreshAcross(gen) {
    clearTimeout(acrossTimer);
    if (gen !== acrossGen) return;
    if (state.showAcross && state.sideOpen && !document.hidden) {
      await Promise.all(acrossRows.filter((r) => r.id).map(async (r) => {
        try { const t = await MD.ticker(r.id); r.c = t.c; r.o = t.o; r.err = null; } catch (e) { r.err = e.message; }
      }));
      if (gen !== acrossGen) return;
      renderAcross();
    }
    acrossTimer = setTimeout(() => refreshAcross(gen), 15000);
  }
  function renderAcross() {
    const box = $('#across');
    box.innerHTML = '';
    if (!acrossRows.length) { box.append(h('div', { class: 'muted list-empty' }, 'Loading prices…')); return; }
    const sym = active.symbol, cur = acrossRows.find((r) => r.id === sym);
    const ref = cur && cur.c != null ? cur.c : lastPx[sym];
    $('#acrossNote').textContent = '';
    box.append(h('div', { class: 'ax-cols' }, h('span', {}, 'Exchange'), h('span', {}, 'Last'), h('span', {}, '24h'), h('span', { title: 'Difference from the price on this chart' }, 'vs chart')));
    for (const r of acrossRows) {
      if (!r.id) {
        const why = r.problem ? (r.problem.geo ? 'blocked in your region' : r.problem.needsServer ? 'needs the Windows app' : 'unavailable') : 'not listed';
        box.append(h('div', { class: 'ax-row na', title: r.problem ? r.problem.message : `${acrossBase} isn't traded on ${r.name}` },
          h('span', { class: 'ax-name' }, r.name), h('span', { class: 'ax-na' }, why)));
        continue;
      }
      const has = r.c != null && isFinite(r.c);
      const chg = has && r.o ? ((r.c - r.o) / r.o) * 100 : null;
      const diff = has && ref && r.id !== sym ? ((r.c - ref) / ref) * 100 : null;
      const pct = (v) => (v == null ? '' : (v >= 0 ? '+' : '') + v.toFixed(Math.abs(v) < 1 ? 2 : 1) + '%');
      box.append(h('div', {
        class: 'ax-row' + (r.id === sym ? ' current' : ''), title: r.err ? r.err : `${acrossBase}/${r.quote} on ${r.name}: click to open`,
        onclick: () => openSymbol(r.id),
      },
      h('span', { class: 'ax-name' }, r.name),
      h('span', { class: 'ax-px' }, has ? r.c.toFixed(decimalsFor(r.c)) : r.err ? '!' : '…'),
      h('span', { class: 'ax-chg ' + (chg == null ? '' : chg >= 0 ? 'up' : 'down') }, pct(chg)),
      h('span', { class: 'ax-diff' }, r.id === sym ? 'this' : pct(diff))));
    }
  }

  function addToWatchlist() {
    openSymbolSearch('', {
      title: 'Add to watchlist',
      exclude: state.watchlist,
      onPick: async (s) => {
        if (state.watchlist.includes(s) || isDemo(s) || s.startsWith('CSV:')) return;
        if (!isStock(s) && !exOf(s)) {
          try {
            const all = await MD.allSymbols();
            if (!all.includes(s)) { toast(`"${s}" is not a Binance symbol`, 'error'); return; }
          } catch (e) { /* offline: accept */ }
        }
        state.watchlist.push(s);
        save(); renderWatchlist(); startTickers();
      },
    });
  }

  // Stock prices for the watchlist and for stock price alerts that run in this tab: one batched request
  // every few minutes while the market is open (background priority, so charts always come first).
  let stockQuoteTimer = null, stockQuotesPrimed = false;
  async function pollStockQuotes() {
    clearTimeout(stockQuoteTimer);
    stockQuoteTimer = null;
    if (PREVIEW || !state.stocks.key) return;
    const alertSyms = priceAlerts().filter((a) => a.active && isStock(a.symbol) && !servedByServer(a)).map((a) => a.symbol);
    const syms = [...new Set([...state.watchlist.filter(isStock), ...alertSyms])];
    if (!syms.length) return;
    const want = stockQuotesPrimed ? syms.filter((x) => MD.marketOpen(x)) : syms; // once at start, then only what trades
    if (want.length) {
      try {
        const qs = await MD.stockQuotes(want, 'background');
        stockQuotesPrimed = true;
        for (const q of qs) {
          updateQuote(q.s, q.c, q.o);
          if (!slots.some((x) => x.symbol === q.s && x.mode === 'live')) checkAlerts(q.s, q.c);
        }
      } catch (e) { /* budget or network: try again later */ }
    }
    stockQuoteTimer = setTimeout(pollStockQuotes, alertSyms.length ? 2 * 60e3 : 10 * 60e3);
  }

  // ------------------------------------------------------------------ alerts
  // Two kinds: price alerts ({ symbol, price }) and marker alerts on a script indicator
  // ({ kind: 'marker', symbol, tf, scriptId, markKey, markName, params, when, repeat }).
  const isMarkerAlert = (a) => a.kind === 'marker';
  const priceAlerts = () => state.alerts.filter((a) => !isMarkerAlert(a));

  function alertTitle(a) {
    return isMarkerAlert(a)
      ? `${symLabel(a.symbol)} ${tfName(a.tf)} · ${a.scriptName}: ${a.markName}`
      : `${symLabel(a.symbol)} crossing ${a.price.toFixed(decimalsFor(a.price))}`;
  }

  function refreshAlerts() {
    for (const s of slots) {
      s.chart.alerts = priceAlerts().filter((a) => a.active && a.symbol === s.symbol);
      s.chart.invalidate();
    }
    renderServerStatus();
    const box = $('#alertList');
    box.innerHTML = '';
    if (!state.alerts.length) { box.appendChild(h('div', { class: 'empty' }, 'No alerts. Right-click a chart, press Alt+A, or use the bell on a script with markers.')); return; }
    for (const a of [...state.alerts].reverse()) {
      let stateText = a.active ? 'active' : 'triggered';
      if (isMarkerAlert(a)) {
        if (a.paused) stateText = 'paused';
        else if (a.active) stateText = a.fires ? `active · fired ${a.fires}×` : 'active';
      }
      if (a.active && !a.paused && srv.connected && !a.server) stateText += ' · this tab only';
      const tip = isMarkerAlert(a)
        ? `${a.when === 'close' ? 'Fires when a bar closes with this marker' : 'Fires as soon as this marker appears'}, ${a.repeat === 'once' ? 'once' : 'every time'}.` +
          (a.lastFired ? `\nLast fired ${new Date(a.lastFired).toLocaleString()}.` : '') + (a.paused ? `\nPaused: ${a.paused}` : '')
        : 'Fires once when the price crosses this level.';
      const where = !a.active ? '' : a.server && srv.connected ? '\nRuns on the alert server, even with the browser closed.'
        : srv.connected ? '\nRuns only while this tab is open (simulated and CSV data stay in the browser).' : '\nRuns while this page is open.';
      const row = h('div', { class: 'al-row' + (a.active && !a.paused ? '' : ' done') + (isMarkerAlert(a) ? ' marker' : ''), title: tip + where, onclick: () => showAlertOnChart(a) },
        h('span', { class: 'al-dot' }),
        h('span', { class: 'al-text' }, h('b', {}, symLabel(a.symbol)),
          isMarkerAlert(a) ? ` ${tfName(a.tf)} · ${a.scriptName}: ${a.markName}` : ` crossing ${a.price.toFixed(decimalsFor(a.price))}`,
          a.paused ? h('small', { class: 'al-why' }, a.paused) : null),
        h('span', { class: 'muted al-state' }, stateText),
        h('button', { class: 'wl-x', title: 'Delete alert', onclick: (e) => {
          e.stopPropagation();
          deleteAlert(a);
        } }, '✕'));
      box.appendChild(row);
    }
  }

  function showAlertOnChart(a) {
    const match = slots.find((s) => s.symbol === a.symbol && (!isMarkerAlert(a) || s.tf === a.tf));
    if (match) { setActive(match); return; }
    if (isMarkerAlert(a)) active.load(a.symbol, a.tf);
    else if (!slots.some((s) => s.symbol === a.symbol)) active.load(a.symbol);
  }

  function askNotificationPermission() {
    if (window.candelaDesktop) return; // the desktop app shows Windows notifications itself
    if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
  }

  function addAlert(symbol, price) {
    if (!isFinite(price)) return;
    const a = { id: uid(), symbol, price: +price, active: true, created: Date.now() };
    if (lastPx[symbol] != null) a.refPrice = lastPx[symbol]; // lets the server spot a crossing before its first price check
    state.alerts.push(a);
    registerAlert(a);
    toast(`Alert set: ${symLabel(symbol)} crossing ${(+price).toFixed(decimalsFor(price))}`, 'info');
    askNotificationPermission();
  }

  // markers available on a chart: [{ ind, pl }] for every script indicator plot drawn as a marker
  const chartMarkers = (chart) => chart.indicators.filter((i) => i.def.script).flatMap((ind) => ind.def.plots.filter((pl) => pl.style === 'mark').map((pl) => ({ ind, pl })));

  function addMarkerAlert(slot, ind, pl, when, repeat) {
    const a = {
      id: uid(), kind: 'marker', symbol: slot.symbol, tf: slot.tf,
      scriptId: ind.def.scriptId, scriptName: ind.def.name, markKey: pl.key, markName: pl.name,
      params: { ...ind.params }, when, repeat, active: true, fires: 0, created: Date.now(),
    };
    state.alerts.push(a);
    // record the markers already on the chart so only new ones fire
    if (slot.chart.raw.length) evaluateMarkerAlert(a, slot.chart.raw, true);
    registerAlert(a);
    toast(`Alert set: ${alertTitle(a)}`, 'info');
    askNotificationPermission();
  }

  // preset: { ind, markKey } to open the dialog on a script's marker (from the legend bell)
  function openAlertDialog(price, preset) {
    const slot = active, chart = slot.chart;
    const last = chart.raw[chart.raw.length - 1];
    const p = price ?? (last ? last.c : 0);
    const markers = chartMarkers(chart);
    const cond = h('select', { id: 'alertCond' },
      h('option', { value: 'price' }, 'Price crossing a level'),
      markers.map((m, i) => h('option', { value: String(i) }, `${chart.indicatorLabel(m.ind)} · ${m.pl.name} marker`)));
    if (preset) {
      const i = markers.findIndex((m) => m.ind.id === preset.ind.id && (!preset.markKey || m.pl.key === preset.markKey));
      if (i >= 0) cond.value = String(i);
    }
    const priceInput = h('input', { type: 'number', step: 'any', id: 'alertPrice', value: (+p).toFixed(chart.decimals) });
    const radio = (name, value, label, hint, checked) => h('label', { class: 'radio' },
      h('input', { type: 'radio', name, value, checked }), h('span', {}, h('b', {}, label), hint ? h('small', {}, hint) : null));
    const whenBox = h('div', { class: 'radio-group' },
      radio('alertWhen', 'close', 'When the bar closes', 'Only confirmed markers. No false alarms.', true),
      radio('alertWhen', 'bar', 'As soon as it appears', 'Faster, but the marker can disappear before the bar closes.', false));
    const repeatBox = h('div', { class: 'radio-group' },
      radio('alertRepeat', 'every', 'Every time', null, true),
      radio('alertRepeat', 'once', 'Only once', null, false));
    const priceRow = h('label', {}, h('span', {}, 'Price'), priceInput);
    const markerRows = h('div', { class: 'form' }, h('div', { class: 'form-block' }, h('span', {}, 'Trigger'), whenBox), h('div', { class: 'form-block' }, h('span', {}, 'Repeat'), repeatBox));
    const note = h('p', { class: 'muted' });
    const csv = slot.symbol.startsWith('CSV:');
    const sync = () => {
      const isPrice = cond.value === 'price';
      priceRow.hidden = !isPrice;
      markerRows.hidden = isPrice;
      note.textContent = isPrice
        ? 'Fires once with a sound, an on-screen message and a desktop notification.'
        : csv ? 'Imported CSV data never updates, so marker alerts can’t fire on it.'
          : `Watches ${bare(slot.symbol)} on the ${tfName(slot.tf)} timeframe with this indicator’s current settings, even if you switch the chart to something else.` +
            (isDemo(slot.symbol) ? ` Simulated data only updates while ${bare(slot.symbol)} ${tfName(slot.tf)} is on a chart.` : '');
      note.textContent += ' Alerts run while this page is open.';
      createBtn.disabled = !isPrice && csv;
    };
    const body = h('div', { class: 'form' },
      h('label', {}, h('span', {}, 'Symbol'), h('b', {}, `${bare(slot.symbol)}${csv ? '' : ' · ' + tfName(slot.tf)}`)),
      h('label', {}, h('span', {}, 'Condition'), cond),
      markers.length ? null : h('p', { class: 'muted hint-line' }, 'Tip: add a custom script with mark lines to get marker alerts.'),
      priceRow, markerRows, note);
    const create = () => {
      if (cond.value === 'price') addAlert(slot.symbol, +priceInput.value);
      else {
        const mk = markers[+cond.value];
        const when = body.querySelector('input[name="alertWhen"]:checked').value, repeat = body.querySelector('input[name="alertRepeat"]:checked').value;
        addMarkerAlert(slot, mk.ind, mk.pl, when, repeat);
      }
      m.close();
    };
    const createBtn = h('button', { class: 'btn primary', onclick: create }, 'Create');
    cond.addEventListener('change', sync);
    priceInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') create(); });
    const m = openModal('Create alert', body, { footer: [h('span', { class: 'spacer' }), h('button', { class: 'btn ghost', onclick: () => m.close() }, 'Cancel'), createBtn] });
    sync();
    setTimeout(() => (cond.value === 'price' ? priceInput.select() : cond.focus()), 0);
  }

  function checkAlerts(sym, price) {
    const prev = lastPx[sym];
    lastPx[sym] = price;
    if (prev == null || prev === price) return;
    for (const a of state.alerts) {
      if (isMarkerAlert(a) || !a.active || a.symbol !== sym || servedByServer(a)) continue;
      if ((prev < a.price && price >= a.price) || (prev > a.price && price <= a.price)) fireAlert(a, price);
    }
  }

  // fromServer: the alert server already announced it (in the desktop app, as a Windows notification)
  function notify(msg, { fromServer = false } = {}) {
    toast(msg, 'alert', 0);
    beep();
    if (window.candelaDesktop) { if (!fromServer) window.candelaDesktop.notify(msg); return; }
    try { if ('Notification' in window && Notification.permission === 'granted') new Notification('Candela alert', { body: msg }); } catch (e) { /* ignore */ }
  }

  function fireAlert(a, price) {
    const msg = AL.applyPriceFire(a, price);
    if (a.server) a.dirty = true; // fired here while the server was away: tell it later
    save();
    refreshAlerts();
    notify(msg);
  }

  // ---- "a new version is available": compare with the latest release on GitHub
  // Only where the version is known: the Windows app, or the page served by node server.js.
  const RELEASES = 'https://github.com/EigenLayerovich/candela/releases/latest';
  const RELEASES_API = 'https://api.github.com/repos/EigenLayerovich/candela/releases/latest';
  const verNum = (v) => String(v || '').replace(/^v/, '').split('.').map((x) => parseInt(x, 10) || 0);
  const newer = (a, b) => { const x = verNum(a), y = verNum(b); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); return false; };
  let updateShown = null;
  async function checkForUpdate() {
    const desktop = window.candelaDesktop && window.candelaDesktop.version;
    const mine = desktop || srv.appVersion;
    if (!mine || PREVIEW) return;
    let rel;
    try {
      const r = await fetch(RELEASES_API, { headers: { accept: 'application/vnd.github+json' } });
      if (!r.ok) return;
      rel = await r.json();
    } catch (e) { return; } // offline: try again later
    const latest = String(rel.tag_name || '').replace(/^v/, '');
    if (!latest || !newer(latest, mine) || lsGet('candela.skipVersion') === latest || updateShown === latest) return;
    updateShown = latest;
    showUpdateNotice(latest, mine, rel, !!desktop);
  }
  function showUpdateNotice(latest, mine, rel, desktop) {
    document.querySelector('.update-note')?.remove();
    const close = () => note.remove();
    // what changed since your version: the release notes' "## New in x.y.z" / "## In x.y.z" sections, as plain text
    const notes = String(rel.body || '').split(/\n(?=## )/).map((sec) => sec.trim())
      .filter((sec) => { const m = /^## (?:New in|In) v?([\d.]+)/i.exec(sec); return m && newer(m[1], mine); })
      .map((sec) => sec.replace(/^## (?:New in|In) v?([\d.]+)/i, '$1:')).join('\n').replace(/\*/g, '').trim();
    const note = h('div', { class: 'update-note', role: 'status' },
      h('div', { class: 'update-head' }, h('b', {}, `Candela ${latest} is available`), h('span', { class: 'muted' }, ` (you have ${mine})`),
        h('button', { class: 'icon-btn', title: 'Later', onclick: close }, '✕')),
      notes ? h('div', { class: 'update-notes' }, notes) : null,
      h('p', { class: 'muted' }, desktop
        ? 'Download it, quit Candela from the tray icon, and run the new file. Your charts and alerts are kept.'
        : 'To update, get the new files (git pull, or download them again) and restart node server.js.'),
      h('div', { class: 'update-btns' },
        h('button', { class: 'btn ghost', onclick: () => { lsSet('candela.skipVersion', latest); close(); } }, 'Skip this version'),
        h('button', { class: 'btn ghost', onclick: close }, 'Later'),
        h('button', { class: 'btn primary', onclick: () => { window.open(rel.html_url || RELEASES, '_blank', 'noopener'); } }, desktop ? 'Download' : 'Open release')));
    document.body.appendChild(note);
  }

  // ---- alert server (server.js): runs alerts with the browser closed
  // When the app is opened from the Candela server, alerts on live symbols are handed to it and this
  // tab stops checking them itself (no double alerts). If the server goes away, this tab takes over
  // until it is back, then reports what happened in the meantime.
  const lsGet = (k) => { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } };
  const lsSet = (k, v) => { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch (e) { /* ignore */ } };
  const srv = { available: false, connected: false, lost: false, needsToken: false, es: null, channels: [], events: [], token: lsGet('candela.serverToken') };
  const servedByServer = (a) => srv.connected && a.server;

  async function srvApi(method, p, body) {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (srv.token) headers.authorization = 'Bearer ' + srv.token;
    const r = await fetch(p, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.error || 'HTTP ' + r.status), { status: r.status });
    return j;
  }

  async function probeServer() {
    if (PREVIEW || location.protocol === 'file:') return renderServerStatus();
    // the alert server marks the page it serves; with any other web server there is nothing to ask
    const nav = performance.getEntriesByType && performance.getEntriesByType('navigation')[0];
    if (nav && Array.isArray(nav.serverTiming) && !nav.serverTiming.some((e) => e.name === 'candela')) return renderServerStatus();
    let r;
    try { r = await fetch('/api/status', { headers: srv.token ? { authorization: 'Bearer ' + srv.token } : {} }); } catch (e) { return renderServerStatus(); }
    if (r.status === 401) { srv.available = true; srv.needsToken = true; return renderServerStatus(); }
    const j = r.ok ? await r.json().catch(() => null) : null;
    if (!j || j.app !== 'candela-alert-server') return renderServerStatus(); // served by a plain web server
    srv.available = true;
    srv.needsToken = false;
    if (j.appVersion) { srv.appVersion = j.appVersion; checkForUpdate(); }
    MD.setProxy('/api/proxy', srv.token);
    openServerEvents();
  }

  function openServerEvents() {
    if (srv.es) srv.es.close();
    const es = (srv.es = new EventSource('/api/events' + (srv.token ? '?token=' + encodeURIComponent(srv.token) : '')));
    es.addEventListener('state', (e) => {
      const d = JSON.parse(e.data);
      if (!srv.connected) onServerConnected(d); else applyServerState(d);
    });
    es.addEventListener('fired', (e) => {
      const ev = JSON.parse(e.data);
      srv.events.unshift(ev);
      notify(ev.message, { fromServer: true });
    });
    es.onerror = () => { if (srv.connected) onServerLost(); };
  }

  const toServer = (a) => {
    const { server, dirty, paused, ...rest } = a;
    return rest;
  };

  let serverSyncing = false;
  async function onServerConnected(d) {
    if (serverSyncing) return;
    serverSyncing = true;
    const wasLost = srv.lost;
    let uploaded = 0;
    try {
      // scripts first, so marker alerts can find them
      await srvApi('PUT', '/api/scripts', { scripts: state.scripts.map(({ id, name, code }) => ({ id, name: name || 'Untitled', code })) });
      if (state.stocks.key) await srvApi('PUT', '/api/settings', { twelveData: state.stocks }).catch(() => {});
      for (const id of state.serverScriptDeletes) await srvApi('DELETE', '/api/scripts/' + id).catch(() => {});
      for (const id of state.serverDeletes) await srvApi('DELETE', '/api/alerts/' + id).catch(() => {});
      state.serverScriptDeletes = [];
      state.serverDeletes = [];
      const remote = new Set(d.alerts.map((a) => a.id));
      for (const a of state.alerts) {
        if (!AL.serverEligible(a)) continue;
        if (!a.server) {
          // created in the browser (before the server ran, or while it was away): hand it over
          try { await srvApi('POST', '/api/alerts', toServer(a)); uploaded++; } catch (e) { /* stays in this tab */ }
        } else if (a.dirty && remote.has(a.id)) {
          await srvApi('PATCH', '/api/alerts/' + a.id, { active: a.active, fires: a.fires, lastBarT: a.lastBarT, lastFired: a.lastFired, triggeredAt: a.triggeredAt }).catch(() => {});
        }
      }
      srv.connected = true;
      srv.lost = false;
      applyServerState(await srvApi('GET', '/api/state'));
      if (uploaded) toast(`${uploaded} alert${uploaded > 1 ? 's' : ''} moved to the alert server: they keep running with the browser closed.`, 'info', 6000);
      else if (wasLost) toast('Alert server is back. It runs your alerts again.', 'info', 3500);
      if (!srv.channels.length && state.alerts.some((a) => a.server && a.active)) toast('Set up phone or chat notifications so you hear about alerts when the browser is closed: Alerts → Server.', 'warn', 8000);
    } catch (e) {
      if (e.status === 401) { srv.needsToken = true; srv.es && srv.es.close(); }
    } finally {
      serverSyncing = false;
      renderServerStatus();
      syncMarkerFeeds();
    }
  }

  function applyServerState(d) {
    srv.channels = d.channels || [];
    srv.events = d.events || srv.events;
    const ids = new Set(d.alerts.map((a) => a.id));
    // keep browser-only alerts (simulated/CSV data, or not accepted by the server), replace the rest
    const local = state.alerts.filter((a) => !a.server && !ids.has(a.id));
    state.alerts = [...local, ...d.alerts.map((a) => ({ ...a, server: true }))].sort((x, y) => (x.created || 0) - (y.created || 0));
    save();
    refreshAlerts();
    syncMarkerFeeds();
    startTickers();
  }

  function onServerLost() {
    srv.connected = false;
    srv.lost = true;
    renderServerStatus();
    refreshAlerts();
    // this tab takes over until the server is back (EventSource reconnects by itself)
    syncMarkerFeeds();
    startTickers();
    toast('Alert server unreachable. Alerts run in this tab until it is back.', 'warn', 6000);
  }

  // new alert: hand it to the server when possible, otherwise it runs in this tab
  async function registerAlert(a) {
    save();
    refreshAlerts();
    if (srv.connected && AL.serverEligible(a)) {
      try {
        const saved = await srvApi('POST', '/api/alerts', toServer(a));
        const i = state.alerts.indexOf(a);
        if (i >= 0 && !state.alerts.some((x) => x !== a && x.id === saved.id)) state.alerts[i] = { ...saved, server: true };
        else if (i >= 0) state.alerts.splice(i, 1); // the server's copy already arrived
      } catch (e) {
        toast(`The alert server did not take this alert (${e.message}). It runs in this tab only.`, 'warn', 6000);
      }
    }
    save();
    refreshAlerts();
    syncMarkerFeeds();
    startTickers();
  }

  function deleteAlert(a) {
    state.alerts = state.alerts.filter((x) => x !== a);
    if (a.server) {
      if (srv.connected) srvApi('DELETE', '/api/alerts/' + a.id).catch(() => state.serverDeletes.push(a.id));
      else state.serverDeletes.push(a.id);
    }
    save();
    refreshAlerts();
    syncMarkerFeeds();
  }

  function pushStockKeyToServer() {
    if (srv.connected) srvApi('PUT', '/api/settings', { twelveData: state.stocks }).catch(() => {});
  }
  function pushScriptToServer(sc) {
    if (srv.connected) srvApi('PUT', '/api/scripts/' + sc.id, { name: sc.name || 'Untitled', code: sc.code }).catch(() => {});
  }
  function deleteScriptOnServer(id) {
    if (srv.connected) srvApi('DELETE', '/api/scripts/' + id).catch(() => state.serverScriptDeletes.push(id));
    else if (srv.available) state.serverScriptDeletes.push(id);
  }

  function renderServerStatus() {
    const btn = $('#serverBtn');
    if (!btn) return;
    let label, cls, title;
    if (srv.connected) {
      label = srv.channels.length ? 'Server' : 'Server · no notifications';
      cls = srv.channels.length ? 'ok' : 'warn';
      title = srv.channels.length ? `Alerts run on the Candela server, even with the browser closed. Notifications: ${srv.channels.join(', ')}.` : 'Alerts run on the server, but no phone/chat notifications are set up yet.';
    } else if (srv.needsToken) { label = 'Server · sign in'; cls = 'warn'; title = 'The alert server needs its access token.'; }
    else if (srv.lost) { label = 'Server offline'; cls = 'bad'; title = 'Cannot reach the alert server. Alerts run in this tab until it is back.'; }
    else { label = 'This tab only'; cls = ''; title = 'Alerts run while this page is open. Run the Candela server to keep them going with the browser closed.'; }
    btn.className = 'srv-pill ' + cls;
    btn.textContent = label;
    btn.title = title;
  }

  function openServerDialog() {
    const body = h('div', { class: 'form srv-dialog' });
    const footer = [h('span', { class: 'spacer' })];
    let m;
    if (srv.needsToken) {
      const input = h('input', { type: 'password', id: 'srvToken', class: 'search', placeholder: 'Access token (CANDELA_TOKEN)', autocomplete: 'off' });
      body.append(h('p', {}, 'This alert server is protected with an access token. Enter the CANDELA_TOKEN it was started with.'), input);
      footer.push(h('button', { class: 'btn primary', onclick: () => { srv.token = input.value.trim(); lsSet('candela.serverToken', srv.token); m.close(); probeServer(); } }, 'Connect'));
      m = openModal('Alert server', body, { footer });
      input.focus();
      return;
    }
    if (!srv.connected) {
      body.append(
        h('p', {}, srv.lost
          ? 'The alert server stopped responding. Your alerts run in this tab for now, and the server takes them back when it returns.'
          : PREVIEW ? 'The hosted preview cannot use the alert server. Download the app to run it on your computer.'
            : 'Right now alerts only run while this page is open. Candela comes with a small server that keeps them running with the browser closed and sends them to your phone (ntfy), Telegram or a webhook (Discord, Slack…).'),
        h('div', { class: 'srv-steps' },
          h('b', {}, 'To start it'),
          h('ol', {},
            h('li', {}, 'Install Node.js 18 or newer (nodejs.org).'),
            h('li', {}, 'In the Candela folder run:  ', h('code', {}, 'node server.js')),
            h('li', {}, 'Open ', h('code', {}, 'http://localhost:8000'), ' (instead of the address you use now).'))),
        h('p', { class: 'muted' }, 'Your existing alerts and scripts move to the server automatically. Keep the server running (it can run in the background or as a service; see the README).'));
      footer.push(h('button', { class: 'btn primary', onclick: () => m.close() }, 'OK'));
      m = openModal('Alert server', body, { footer });
      return;
    }
    // connected: notification settings
    const field = (id, label, value, placeholder, type = 'text') => {
      const input = h('input', { id, type, value: value || '', placeholder, autocomplete: 'off', spellcheck: 'false' });
      return [h('label', { for: id }, h('span', {}, label), input), input];
    };
    const resultBox = h('div', { class: 'srv-results' });
    const evBox = h('div', { class: 'srv-events' });
    m = openModal('Alert server', body, { wide: true, footer });
    body.append(h('p', { class: 'srv-ok' }, '● Connected. Alerts on live symbols run here even with the browser closed.'), h('p', { class: 'muted' }, 'Loading settings…'));
    srvApi('GET', '/api/settings').then((st) => {
      body.innerHTML = '';
      const [ntfyRow, ntfyTopic] = field('ntfyTopic', 'Topic', st.ntfy.topic, 'e.g. candela-7f3k2q9x');
      const gen = h('button', { class: 'btn small-btn', onclick: () => { ntfyTopic.value = 'candela-' + Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join(''); } }, 'Make one up');
      ntfyRow.appendChild(gen);
      const [ntfySrvRow, ntfyServer] = field('ntfyServer', 'Server', st.ntfy.server, 'https://ntfy.sh');
      const [tgTokRow, tgToken] = field('tgToken', 'Bot token', st.telegram.token, '123456:ABC…', 'password');
      const [tgChatRow, tgChat] = field('tgChat', 'Chat ID', st.telegram.chatId, 'e.g. 123456789');
      const [whRow, whUrl] = field('whUrl', 'URL', st.webhook.url, 'https://discord.com/api/webhooks/…');
      const section = (title, hint, ...rows) => h('fieldset', { class: 'srv-sec' }, h('legend', {}, title), h('p', { class: 'muted' }, hint), ...rows);
      body.append(
        h('p', { class: 'srv-ok' }, '● Connected. Alerts on live symbols run on the server even with the browser closed.'),
        section('Phone push: ntfy', 'Free, no account. Install the ntfy app (Android, iPhone) or open ntfy.sh, and subscribe to the same topic. Anyone who knows the topic name can read it, so use something hard to guess.', ntfyRow, ntfySrvRow),
        section('Telegram', 'Create a bot with @BotFather to get its token, send your bot a message, then get your chat ID (e.g. from @userinfobot).', tgTokRow, tgChatRow),
        section('Webhook', 'Discord or Slack incoming-webhook URL, or any URL that accepts a JSON POST.', whRow),
        resultBox,
        h('div', { class: 'menu-label' }, 'Recently fired'), evBox);
      const renderEvents = () => {
        evBox.innerHTML = '';
        if (!srv.events.length) evBox.appendChild(h('p', { class: 'muted' }, 'Nothing yet.'));
        for (const ev of srv.events.slice(0, 12)) evBox.appendChild(h('div', { class: 'srv-ev' }, h('span', { class: 'muted' }, new Date(ev.t).toLocaleString()), ev.message.replace(/^🔔 /, '')));
      };
      renderEvents();
      const payload = () => ({ ntfy: { topic: ntfyTopic.value.trim(), server: ntfyServer.value.trim() || 'https://ntfy.sh' }, telegram: { token: tgToken.value.trim(), chatId: tgChat.value.trim() }, webhook: { url: whUrl.value.trim() } });
      const saveSettings = async () => {
        const res = await srvApi('PUT', '/api/settings', payload());
        srv.channels = res.configured;
        renderServerStatus();
        return res;
      };
      const showResults = (results) => {
        resultBox.innerHTML = '';
        if (!results.length) { resultBox.appendChild(h('p', { class: 'srv-bad' }, 'No channel is set up yet. Fill in at least one section.')); return; }
        for (const r of results) resultBox.appendChild(h('p', { class: r.ok ? 'srv-ok' : 'srv-bad' }, `${r.ok ? '✓' : '✗'} ${r.channel}: ${r.ok ? 'sent' : r.error}`));
      };
      footer.length = 0;
      const foot = m.dlg.querySelector('.modal-foot') || h('div', { class: 'modal-foot' });
      foot.innerHTML = '';
      foot.append(
        h('button', { class: 'btn', onclick: async () => {
          try { await saveSettings(); resultBox.innerHTML = ''; resultBox.appendChild(h('p', { class: 'muted' }, 'Sending a test…')); showResults((await srvApi('POST', '/api/test-notify', {})).results); } catch (e) { showResults([{ channel: 'settings', ok: false, error: e.message }]); }
        } }, 'Save & send test'),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn ghost', onclick: () => m.close() }, 'Close'),
        h('button', { class: 'btn primary', onclick: async () => { try { await saveSettings(); toast('Notification settings saved', 'info', 2000); m.close(); } catch (e) { showResults([{ channel: 'settings', ok: false, error: e.message }]); } } }, 'Save'));
      if (!foot.isConnected) m.dlg.appendChild(foot);
    }).catch((e) => { body.innerHTML = ''; body.appendChild(h('p', { class: 'srv-bad' }, 'Could not load the server settings: ' + e.message)); });
  }

  // ---- marker alert engine
  // Each live (symbol, timeframe) gets one feed shared by its alerts: 1000 bars of history plus the
  // live kline stream. Simulated (DEMO) symbols have no shared feed, so their alerts read the chart.
  const markerFeeds = new Map(); // "SYMBOL|tf" -> { symbol, tf, bars, stop, gen, timer, ready }
  const feedKey = (a) => a.symbol + '|' + a.tf;

  function syncMarkerFeeds() {
    const want = new Set();
    for (const a of state.alerts) if (isMarkerAlert(a) && a.active && !servedByServer(a) && !isDemo(a.symbol) && !a.symbol.startsWith('CSV:')) want.add(feedKey(a));
    for (const [k, f] of markerFeeds) if (!want.has(k)) { f.dead = true; if (f.stop) f.stop(); clearTimeout(f.timer); markerFeeds.delete(k); }
    for (const k of want) if (!markerFeeds.has(k)) startMarkerFeed(k);
  }

  async function startMarkerFeed(key) {
    const [symbol, tf] = key.split('|');
    const f = { symbol, tf, bars: [], stop: null, timer: null, ready: false, dead: false };
    markerFeeds.set(key, f);
    try {
      f.bars = await MD.history(symbol, tf, { limit: 1000, priority: 'background' });
    } catch (e) {
      if (f.dead) return;
      f.timer = setTimeout(() => { if (!f.dead) { markerFeeds.delete(key); startMarkerFeed(key); } }, 30000);
      return;
    }
    if (f.dead) return;
    for (const a of alertsFor(symbol, tf)) evaluateMarkerAlert(a, f.bars, true); // remember existing markers, don't fire
    f.ready = true;
    f.stop = MD.stream(symbol, tf, (bar) => {
      const n = f.bars.length;
      let newBar = false;
      if (n && f.bars[n - 1].t === bar.t) f.bars[n - 1] = bar;
      else if (!n || bar.t > f.bars[n - 1].t) { f.bars.push(bar); newBar = true; if (f.bars.length > 1500) f.bars.splice(0, f.bars.length - 1000); }
      else return;
      scheduleFeedCheck(f, newBar);
    });
  }

  const alertsFor = (symbol, tf) => state.alerts.filter((a) => isMarkerAlert(a) && a.active && !servedByServer(a) && a.symbol === symbol && a.tf === tf);

  // a new bar is checked immediately (bar-close alerts); ticks inside a bar at most once a second
  function scheduleFeedCheck(f, newBar) {
    if (newBar) { clearTimeout(f.timer); f.timer = null; runFeedCheck(f); return; }
    if (f.timer) return;
    f.timer = setTimeout(() => { f.timer = null; runFeedCheck(f); }, 1000);
  }
  function runFeedCheck(f) {
    if (f.dead) return;
    for (const a of alertsFor(f.symbol, f.tf)) evaluateMarkerAlert(a, f.bars, false);
  }

  // simulated symbols: evaluated from a chart that shows them
  const chartChecks = new WeakMap();
  function markerAlertsOnChartBar(slot, newBar) {
    if (!isDemo(slot.symbol)) return;
    const list = alertsFor(slot.symbol, slot.tf);
    if (!list.length) return;
    const run = () => { chartChecks.delete(slot); for (const a of alertsFor(slot.symbol, slot.tf)) evaluateMarkerAlert(a, slot.chart.raw, false); };
    if (newBar) { clearTimeout(chartChecks.get(slot)); run(); }
    else if (!chartChecks.has(slot)) chartChecks.set(slot, setTimeout(run, 1000));
  }
  function primeChartAlerts(slot) {
    if (!isDemo(slot.symbol)) return;
    for (const a of alertsFor(slot.symbol, slot.tf)) evaluateMarkerAlert(a, slot.chart.raw, true);
  }

  // prime = record the markers already present so only new ones fire
  function evaluateMarkerAlert(a, bars, prime) {
    if (!a.active || servedByServer(a)) return;
    const res = AL.evaluateMarker(a, scriptDefs.get(a.scriptId), bars, prime, IND.defaults);
    if (res.type === 'pause') return pauseAlert(a, res.reason);
    if (a.paused) { delete a.paused; save(); refreshAlerts(); }
    if (res.type === 'prime') { a.lastBarT = res.t; save(); return; }
    if (res.type !== 'fire') return;
    const msg = AL.applyMarkerFire(a, res);
    if (a.server) a.dirty = true; // fired here while the server was away: tell it later
    save();
    refreshAlerts();
    if (!a.active) syncMarkerFeeds();
    notify(msg);
  }

  function pauseAlert(a, why) {
    if (a.paused === why) return;
    a.paused = why;
    save();
    refreshAlerts();
  }

  // scripts changed: re-check paused alerts and pause alerts on deleted scripts
  function recheckMarkerAlerts() {
    for (const a of state.alerts) {
      if (!isMarkerAlert(a) || !a.active) continue;
      const f = markerFeeds.get(feedKey(a));
      const bars = f && f.ready ? f.bars : (slots.find((s) => s.symbol === a.symbol && s.tf === a.tf) || {}).chart?.bars;
      if (!scriptDefs.get(a.scriptId)) pauseAlert(a, 'The script was deleted');
      else if (bars && bars.length) evaluateMarkerAlert(a, bars, true);
    }
  }

  function beep() {
    try {
      const ac = new (window.AudioContext || window.webkitAudioContext)();
      [0, 0.18].forEach((t) => {
        const o = ac.createOscillator(), g = ac.createGain();
        o.frequency.value = 880;
        g.gain.setValueAtTime(0.0001, ac.currentTime + t);
        g.gain.exponentialRampToValueAtTime(0.2, ac.currentTime + t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + t + 0.15);
        o.connect(g).connect(ac.destination);
        o.start(ac.currentTime + t);
        o.stop(ac.currentTime + t + 0.16);
      });
    } catch (e) { /* ignore */ }
  }

  // ------------------------------------------------------------------ context menu
  function showContextMenu(slot, info) {
    const chart = slot.chart, menu = $('#ctxMenu');
    menu.innerHTML = '';
    const item = (label, fn, cls = '') => menu.appendChild(h('button', { class: 'ctx-item ' + cls, onclick: () => { hideMenus(); fn(); } }, label));
    if (info.drawing) {
      item('Delete drawing', () => chart.deleteSelected(), 'danger');
      menu.appendChild(h('div', { class: 'ctx-sep' }));
    }
    if (info.price != null) {
      const p = chart.fmtPrice(info.price);
      item(`Add alert at ${p}`, () => addAlert(slot.symbol, +p));
      item(`Horizontal line at ${p}`, () => {
        const d = { id: Math.random().toString(36).slice(2), type: 'hline', pts: [{ t: chart.bars[chart.bars.length - 1]?.t || 0, p: +p }], width: 1.5 };
        chart.drawings.push(d);
        chart.select(d);
        chart.onDrawingsChange();
      });
      menu.appendChild(h('div', { class: 'ctx-sep' }));
    }
    item('Reset chart view', () => chart.resetView());
    item('Add indicator…', openIndicatorPicker);
    item('Compare symbol…', () => openCompareSearch());
    if (slots.length > 1) item('Maximize this chart', () => { state.charts.splice(0, 0, ...state.charts.splice(slots.indexOf(slot), 1)); rebuildSlots('1'); });
    if (!PREVIEW) item('Save snapshot (PNG)', snapshot); // the hosted preview can't download files
    if (chart.drawings.length) item('Remove all drawings', removeAllDrawings, 'danger');
    menu.classList.remove('hidden');
    const r = menu.getBoundingClientRect();
    menu.style.left = Math.min(info.clientX, window.innerWidth - r.width - 8) + 'px';
    menu.style.top = Math.min(info.clientY, window.innerHeight - r.height - 8) + 'px';
  }
  function hideMenus() { $('#ctxMenu').classList.add('hidden'); $('#layoutMenu').classList.add('hidden'); }
  document.addEventListener('mousedown', (e) => {
    if (!e.target.closest('#ctxMenu')) $('#ctxMenu').classList.add('hidden');
    if (!e.target.closest('#layoutMenu, #layoutBtn')) $('#layoutMenu').classList.add('hidden');
  });

  // Re-create all charts (used when the chart order changes, e.g. "maximize").
  function rebuildSlots(layout) {
    while (slots.length) slots.pop().destroy();
    active = null;
    state.active = 0;
    applyLayout(layout);
  }

  // ------------------------------------------------------------------ misc
  function snapshot() {
    // one image of the whole layout
    const grid = $('#charts'), gr = grid.getBoundingClientRect(), d = window.devicePixelRatio || 1;
    const cv = document.createElement('canvas');
    cv.width = Math.round(gr.width * d);
    cv.height = Math.round(gr.height * d);
    const ctx = cv.getContext('2d');
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--border').trim() || '#222';
    ctx.fillRect(0, 0, cv.width, cv.height);
    for (const s of slots) {
      const r = s.el.getBoundingClientRect();
      ctx.drawImage(s.chart.snapshotCanvas(), Math.round((r.left - gr.left) * d), Math.round((r.top - gr.top) * d));
    }
    const a = document.createElement('a');
    const names = slots.map((s) => bare(s.symbol)).filter((v, i, arr) => arr.indexOf(v) === i).join('-');
    a.download = `${names}_${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.png`;
    a.href = cv.toDataURL('image/png');
    a.click();
  }

  document.addEventListener('keydown', (e) => {
    const typing = e.target.matches('input, select, textarea');
    if (e.key === 'Enter' && !typing && !modalOpen() && active.chart.finishCreating()) { e.preventDefault(); return; } // finish a path / polyline
    if (e.key === 'Escape') {
      if (document.querySelector('.tool-menu')) { closeToolMenu(); return; }
      if (modalOpen()) { $('#modalRoot .backdrop')._close(); return; }
      hideMenus();
      if (!active.chart.cancelCreating()) active.chart.select(null);
      setActiveTool('cursor');
      return;
    }
    if (typing || modalOpen()) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && active.chart.selected) { active.chart.deleteSelected(); e.preventDefault(); return; }
    if (e.altKey) {
      const map = { KeyT: 'trend', KeyH: 'hline', KeyV: 'vline', KeyF: 'fib', KeyM: 'measure', KeyJ: 'hray', KeyC: 'crossline' };
      if (e.shiftKey && e.code === 'KeyR') { setActiveTool('rect'); e.preventDefault(); return; }
      if (map[e.code]) { setActiveTool(map[e.code]); e.preventDefault(); return; }
      if (e.code === 'KeyA') { openAlertDialog(); e.preventDefault(); return; }
      if (e.code === 'KeyR') { active.chart.resetView(); e.preventDefault(); return; }
      // Alt+1…6 focuses a chart in the layout
      const n = /^Digit([1-6])$/.exec(e.code);
      if (n && slots[+n[1] - 1]) { setActive(slots[+n[1] - 1]); e.preventDefault(); }
      return;
    }
    if (e.ctrlKey || e.metaKey) return;
    if (e.key === '/') { e.preventDefault(); openIndicatorPicker(); return; }
    if (/^[a-zA-Z]$/.test(e.key)) { e.preventDefault(); openSymbolSearch(e.key.toUpperCase()); return; }
    if (/^[1-9]$/.test(e.key)) { e.preventDefault(); openCustomTfDialog(e.key); } // type a timeframe: 2D, 4H…
  });

  // keep the bar-close countdowns ticking
  setInterval(() => { for (const s of slots) if (s.chart.live) s.chart.invalidate(); }, 1000);

  // ------------------------------------------------------------------ boot
  buildHeader();
  buildToolbar();
  if (PREVIEW) {
    $('#snapBtn').hidden = true;
    toast('Preview: simulated price feed. Download the app for live Binance data. Every tool and indicator works here.', 'info', 9000);
  }
  $('#wlAdd').addEventListener('click', addToWatchlist);
  $('#acrossToggle').addEventListener('click', () => { state.showAcross = !state.showAcross; save(); updateAcross(); refreshAcross(acrossGen); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && acrossKey) refreshAcross(acrossGen); });
  $('#serverBtn').addEventListener('click', () => openServerDialog());
  $('#charts').appendChild(h('div', { id: 'dividers', class: 'dividers' }));
  new ResizeObserver(() => positionDividers()).observe($('#charts'));
  applyLayout(state.layout);
  setActiveTool('cursor');
  renderWatchlist();
  refreshAlerts();
  updateHeader();
  startTickers();
  syncMarkerFeeds();
  probeServer();
  setTimeout(checkForUpdate, 4000);
  setInterval(checkForUpdate, 6 * 3600e3);
  if (!PREVIEW) MD.loadBStocks().then(() => {
    for (const sl of slots) if (MD.isBStock(sl.symbol)) { sl.chart.title = sl.title(); sl.chart._legendIdx = -2; sl.chart._updateLegendValues(); }
    renderWatchlist(); updateHeader(); refreshAlerts();
  }).catch(() => { /* offline: bStocks just show as Binance pairs */ });

  // handy for the devtools console
  window.candela = { markerFeeds, evaluateMarkerAlert, state, get slots() { return slots; }, get active() { return active; }, get chart() { return active.chart; }, applyLayout };
})();
