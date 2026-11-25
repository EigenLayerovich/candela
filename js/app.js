/* Candela — application shell: multi-chart layouts, toolbar, symbol search, watchlist, alerts,
 * dialogs, persistence. Each chart in the layout is a "slot" with its own symbol, timeframe,
 * chart type, indicators and live data stream; the top bar always acts on the active slot. */
(function () {
  'use strict';
  const { Chart, decimalsFor } = window.CandelaChart;
  const CC = window.CandelaChart;
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
      let f = `Funding ${t.funding >= 0 ? '+' : ''}${(t.funding * 100).toFixed(4)}%${t.fundingHours === 1 ? ' per hour' : ''}`;
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
  // bigger grids: every cell one chart
  const gridLayout = (cols, rows) => ({ name: `${cols} × ${rows} grid`, cols, rows, cells: Array.from({ length: cols * rows }, (_, i) => [i % cols, Math.floor(i / cols), 1, 1]) });
  Object.assign(LAYOUTS, { '8': gridLayout(4, 2), '9': gridLayout(3, 3), '12': gridLayout(4, 3), '16': gridLayout(4, 4) });
  const LAYOUT_ORDER = ['1', '2v', '2h', '3v', '3l', '3t', '4', '4v', '6', '8', '9', '12', '16']; // object key order would put '1','4','6' first

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
    tester: { open: false, tab: 'overview', height: 280 }, // Strategy Tester panel
    replaySpeed: 2, // Bar Replay: candles per second
    timeZone: 'local', // time axis: 'local', 'UTC' or a place like 'America/New_York'
    look: {}, // Chart settings: colors, grid, price line, countdown, watermark
    savedLayouts: [], // named layouts
    indTemplates: [], // named indicator sets
    objTree: false, // object tree panel open
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
  CC.setTimeZone(state.timeZone || 'local');
  CC.setLook(state.look || {});
  if (!state.exNotes || typeof state.exNotes !== 'object') state.exNotes = {};
  if (state.magnet === true) state.magnet = 'strong';
  state.wl = { tab: 'all', sort: null, ...state.wl };
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
      c.onAlertMove = (a) => alertMoved(a);
      c.onSelect = (d) => this.showDrawBar(d);
      c.onNeedHistory = () => this.loadOlder();
      c.onContextMenu = (info) => showContextMenu(this, info);
      c.onTradeLineMove = (l, price) => paperLineMoved(this, l, price);
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
      this.replay = null; // Bar Replay state
      this._nStrat = c.indicators.filter((i) => i.def.strategy).length;
    }

    get symbol() { return this.cfg.symbol; }
    get tf() { return this.cfg.tf; }

    destroy() {
      this.gen++;
      if (this.stop) this.stop();
      this.stopCompares();
      this.stopTfFeeds();
      this.stopInfo();
      this.exitReplay(false);
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
      // a strategy was just added: open the Strategy Tester, as other charting apps do
      const nStrat = c.indicators.filter((i) => i.def.strategy).length;
      if (nStrat > this._nStrat && this === active && !state.tester.open) openTester();
      this._nStrat = nStrat;
      testerRefreshSoon(this);
      recordHistory(this);
      renderObjTree();
    }

    // ---- Bar Replay: hide what came after a chosen candle, then play the candles back one at a time.
    // Alerts don't fire during a replay, and indicators on other timeframes only see the past.
    startReplayPick() {
      if (!this.chart.raw.length) { toast('Nothing to replay yet: the chart has no data.', 'warn'); return; }
      setActive(this);
      if (this.replay) this.pauseReplay();
      toast('Click the chart where the replay should start (Esc cancels). Scroll left first to start further back.', 'info', 5000);
      this.chart.pickTime((t) => this.beginReplay(t));
      updateHeader();
    }
    beginReplay(t) {
      const c = this.chart;
      if (!this.replay) {
        if (this.stop) this.stop();
        this.stop = null;
        c.live = false;
        this.replay = { full: c.raw.slice(), idx: 0, timer: null, playing: false };
      } else {
        this.pauseReplay();
        // a new start: the practice trades so far end here
        if (this.replay.paper) { replayResults(this, this.replay.paper, this.replay.full[this.replay.idx].c); delete this.replay.paper; }
      }
      const R = this.replay;
      let idx = R.full.length - 1;
      while (idx > 0 && R.full[idx].t > t) idx--;
      R.idx = Math.max(Math.min(20, R.full.length - 1), idx);
      c.setData(R.full.slice(0, R.idx + 1), c.rawInterval);
      c.rightOffset = 12;
      c._clampView();
      this.replayTfSources();
      this.alignCompares();
      this.setStatus('replay');
      this.renderReplayBar();
      testerRefreshSoon(this, 0);
      paperRefresh();
      updateHeader();
    }
    replayStep() {
      const R = this.replay;
      if (!R) return;
      if (R.idx >= R.full.length - 1) { this.pauseReplay(); toast('The replay reached the latest candle. Exit the replay to go back to live data.', 'info', 5000); return; }
      R.idx++;
      this.chart.updateBar(R.full[R.idx]);
      paperReplayBar(this);
      this.replayTfSources();
      this.alignCompares();
      this.renderReplayBar();
      testerRefreshSoon(this);
    }
    playReplay() {
      const R = this.replay;
      if (!R) return;
      if (R.playing) { this.pauseReplay(); return; }
      R.playing = true;
      const go = () => {
        if (this.replay !== R || !R.playing) return;
        this.replayStep();
        if (R.playing) R.timer = setTimeout(go, 1000 / (state.replaySpeed || 2));
      };
      R.timer = setTimeout(go, 1000 / (state.replaySpeed || 2));
      this.renderReplayBar();
    }
    pauseReplay() {
      const R = this.replay;
      if (!R) return;
      R.playing = false;
      clearTimeout(R.timer);
      this.renderReplayBar();
    }
    exitReplay(reload = true) {
      const R = this.replay;
      this.chart.cancelPick();
      if (!R) return;
      clearTimeout(R.timer);
      if (R.paper) replayResults(this, R.paper, R.full[R.idx].c);
      this.replay = null;
      paperRefresh();
      if (this.replayBar) { this.replayBar.remove(); this.replayBar = null; }
      if (reload) this.load(this.symbol, this.tf);
      if (this === active) updateHeader();
    }
    // indicators on another timeframe: only candles up to the replay, with the current one built from the chart
    replayTfSources() {
      const c = this.chart, raw = c.raw;
      if (!this.replay || !raw.length) return;
      const end = raw[raw.length - 1].t + c.rawInterval;
      for (const f of this.tfFeeds.values()) {
        if (!f.bars.length) continue;
        const arr = f.bars.filter((b) => b.t < end), tl = arr[arr.length - 1];
        if (tl && MD.TF[f.tf] > c.rawInterval) {
          const parts = raw.filter((b) => b.t >= tl.t);
          if (parts.length) arr[arr.length - 1] = { ...MD.resample(parts, f.tf)[0], t: tl.t };
        }
        c.setTfSource(f.tf, arr);
      }
    }
    renderReplayBar() {
      const R = this.replay;
      if (!R) return;
      if (!this.replayBar) {
        const btn = (cls, title, svgPath, fn) => { const b = h('button', { class: 'rp-btn ' + cls, title, onclick: fn }); b.innerHTML = `<svg viewBox="0 0 24 24">${svgPath}</svg>`; return b; };
        const speed = h('select', { class: 'rp-speed', title: 'Speed (candles per second)' }, [0.5, 1, 2, 5, 10, 30].map((v) => h('option', { value: v }, v + '×')));
        speed.value = String(state.replaySpeed || 2);
        speed.addEventListener('change', () => { state.replaySpeed = +speed.value; save(); speed.blur(); });
        this.replayBar = h('div', { class: 'replay-bar', role: 'toolbar', 'aria-label': 'Bar Replay' },
          h('span', { class: 'rp-tag' }, 'REPLAY'),
          btn('rp-pick', 'Pick a new start candle', '<path d="M5 4v16M19 5l-9 7 9 7z"/>', () => this.startReplayPick()),
          btn('rp-play', 'Play / pause', '', () => this.playReplay()),
          btn('rp-step', 'Next candle (Shift+→)', '<path d="M5 5l9 7-9 7zM17 4v16"/>', () => { this.pauseReplay(); this.replayStep(); }),
          speed,
          h('span', { class: 'rp-time' }),
          btn('rp-exit', 'Exit the replay and go back to live data', '<path d="M6 6l12 12M18 6L6 18"/>', () => this.exitReplay()));
        this.el.appendChild(this.replayBar);
      }
      const bar = R.full[R.idx];
      this.replayBar.querySelector('.rp-play').innerHTML = `<svg viewBox="0 0 24 24">${R.playing ? '<path d="M7 5v14M17 5v14"/>' : '<path d="M7 4l12 8-12 8z"/>'}</svg>`;
      this.replayBar.querySelector('.rp-time').textContent = `${this.chart.fmtTimeFull(bar.t)} · ${R.full.length - 1 - R.idx} candles left`;
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

    // replace all indicators (undo, templates)
    setIndicators(list) {
      const c = this.chart;
      for (const i of [...c.indicators]) c.removeIndicator(i.id);
      for (const s of list || []) {
        const def = resolveDef(s.type);
        if (def) c.addIndicator(def, s.params || {}, { colors: s.colors, visible: s.visible, weight: s.weight, tf: s.tf, styles: s.styles });
      }
      this.persistIndicators();
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
      if (this.replay) this.replayTfSources(); else c.setTfSource(tf, f.bars);
      await this.fillTfHistory(f);
      if (!alive()) return;
      f.stop = MD.stream(sym, tf, (b) => {
        if (!alive()) return;
        const n = f.bars.length;
        if (n && f.bars[n - 1].t === b.t) f.bars[n - 1] = b;
        else if (!n || b.t > f.bars[n - 1].t) f.bars.push(b);
        else { const i = f.bars.findIndex((x) => x.t === b.t); if (i < 0) return; f.bars[i] = b; }
        if (!this.replay) c.setTfSource(tf, f.bars);
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
          if (this.replay) this.replayTfSources(); else this.chart.setTfSource(f.tf, f.bars);
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
      if (this.replay) this.exitReplay(false);
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
      c.watermark = `${bare(sym)}, ${sym.startsWith('CSV:') ? 'CSV' : tfName(tf)}`;
      c.countdown = !isStock(sym) && !/M$/.test(tf); // stock bars don't close on the clock (sessions, closed markets)
      c.setData(bars, interval, { resetView: true });
      refreshTradeLines();
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
      resetHistory(this);
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
      testerRefreshSoon(this);
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
        if (this.replay) {
          const add = older.filter((b) => b.t < this.replay.full[0].t);
          this.replay.full = add.concat(this.replay.full);
          this.replay.idx += add.length;
        }
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
      if (FIB_TOOLS[d.type]) kids.push(h('button', { class: 'db-btn', title: 'Fibonacci levels', onclick: () => openFibLevels(this, d) }, 'Levels'));
      kids.push(h('button', { class: 'db-btn' + (d.vis && d.vis.length ? ' active' : ''), title: 'Show this drawing only on some timeframes', onclick: () => openVisibility(this, d) }, 'Visibility'));
      if (LINE_ALERT[d.type]) kids.push(h('button', { class: 'db-btn', title: 'Alert when the price crosses this line', onclick: () => openLineAlertDialog(this, d) }, 'Alert'));
      if (d.type === 'rect') kids.push(h('button', { class: 'db-btn', title: 'Alert when the price enters or leaves this zone', onclick: () => openRectAlertDialog(this, d) }, 'Alert'));
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

  // ---- drawing visibility per timeframe family, and Fibonacci level sets
  const TF_GROUPS = [['m', 'Minutes'], ['h', 'Hours'], ['d', 'Days'], ['w', 'Weeks'], ['M', 'Months']];
  function openVisibility(slot, d) {
    const hidden = new Set(d.vis || []);
    const boxes = TF_GROUPS.map(([k, label]) => {
      const cb = h('input', { type: 'checkbox', checked: !hidden.has(k) });
      return [k, cb, h('label', { class: 'check-row' }, cb, h('span', {}, label))];
    });
    const cur = slot.chart.tfGroup();
    const only = h('button', { class: 'btn ghost', onclick: () => { for (const [k, cb] of boxes) cb.checked = k === cur; } }, `Only ${TF_GROUPS.find(([k]) => k === cur)[1].toLowerCase()} (this chart)`);
    const m = openModal('Visibility', h('div', { class: 'form' }, h('p', { class: 'muted' }, 'Show this drawing on charts with these timeframes:'), ...boxes.map((b) => b[2]), h('div', {}, only)), {
      footer: [h('span', { class: 'spacer' }), h('button', { class: 'btn ghost', onclick: () => m.close() }, 'Cancel'), h('button', { class: 'btn primary', onclick: () => {
        const vis = boxes.filter(([, cb]) => !cb.checked).map(([k]) => k);
        if (vis.length === TF_GROUPS.length) { toast('Pick at least one timeframe', 'warn', 2000); return; }
        if (vis.length) d.vis = vis; else delete d.vis;
        m.close();
        if (!slot.chart.shown(d)) { slot.chart.select(null); toast('Hidden on this timeframe; it shows again on the others.', 'info', 3000); }
        slot.chart.invalidate();
        slot.chart.onDrawingsChange();
        slot.showDrawBar(slot.chart.selected);
      } }, 'Save')] });
  }
  const FIB_TOOLS = { fib: 'retracement', fibext: 'trendext', fibchannel: null };
  function openFibLevels(slot, d) {
    const SETS = DR.FIB_SETS, dflt = FIB_TOOLS[d.type] ? SETS[FIB_TOOLS[d.type]].levels : [0, 0.382, 0.618, 1, 1.618, 2.618];
    const cur = d.levels && d.levels.length ? d.levels : dflt;
    const text = h('input', { value: cur.join(', '), spellcheck: 'false' });
    const preset = h('select', {}, h('option', { value: '' }, 'Pick a set…'), Object.entries(SETS).map(([k, v]) => h('option', { value: k }, v.name)));
    preset.addEventListener('change', () => { if (preset.value) text.value = SETS[preset.value].levels.join(', '); });
    const extend = h('input', { type: 'checkbox', checked: !!d.extend }), fill = h('input', { type: 'checkbox', checked: d.fill !== false });
    const err = h('p', { class: 'pt-err' });
    const rows = [h('label', {}, h('span', {}, 'Level set'), preset), h('label', {}, h('span', {}, 'Levels'), text), h('small', { class: 'muted' }, 'Comma-separated ratios, e.g. 0, 0.5, 0.618, 0.705, 0.79, 1 (1.272 and above are extensions)')];
    if (d.type !== 'fibchannel') rows.push(h('label', { class: 'check-row' }, extend, h('span', {}, 'Extend lines to the right')), h('label', { class: 'check-row' }, fill, h('span', {}, 'Shade between levels')));
    const m = openModal('Fibonacci levels', h('div', { class: 'form' }, ...rows, err), {
      footer: [h('button', { class: 'btn ghost', onclick: () => { text.value = dflt.join(', '); } }, 'Defaults'), h('span', { class: 'spacer' }), h('button', { class: 'btn ghost', onclick: () => m.close() }, 'Cancel'), h('button', { class: 'btn primary', onclick: () => {
        const lv = [...new Set(text.value.split(/[,;\s]+/).filter(Boolean).map(Number))];
        if (!lv.length || lv.some((v) => !isFinite(v) || v < -5 || v > 10)) { err.textContent = 'Enter numbers between −5 and 10, separated by commas.'; return; }
        if (lv.length > 24) { err.textContent = 'At most 24 levels.'; return; }
        lv.sort((a, b) => a - b);
        if (lv.join() === dflt.join()) delete d.levels; else d.levels = lv;
        if (d.type !== 'fibchannel') { if (extend.checked) d.extend = true; else delete d.extend; if (fill.checked) delete d.fill; else d.fill = false; }
        m.close();
        slot.chart.invalidate();
        slot.chart.onDrawingsChange();
      } }, 'Save')] });
  }

  // ---- keyboard shortcuts (?)
  function openShortcuts() {
    const rows = [
      ['Chart', [['Symbol search', 'start typing a ticker'], ['Timeframe', 'type a number, e.g. 4 then H'], ['Indicators', '/'], ['Reset view', 'Alt+R or double-click the time axis'], ['Undo / redo', 'Ctrl+Z / Ctrl+Y'], ['Focus chart N', 'Alt+1 … Alt+9'], ['Snapshot', 'camera button'], ['This list', '?']]],
      ['Drawing', [['Trend line', 'Alt+T'], ['Horizontal line / ray', 'Alt+H / Alt+J'], ['Vertical line / cross line', 'Alt+V / Alt+C'], ['Fib retracement', 'Alt+F'], ['Rectangle', 'Alt+Shift+R'], ['Keep a line horizontal, vertical or 45°', 'hold Shift while drawing'], ['Measure', 'Shift + click, or Alt+M'], ['Finish a path', 'double-click or Enter'], ['Delete selected', 'Del'], ['Cancel', 'Esc']]],
      ['Alerts and trading', [['New alert', 'Alt+A'], ['Alert or order at a price', 'right-click the chart'], ['Move an alert, order, stop or target', 'drag its line'], ['Bar Replay: next candle', 'Shift+→']]],
    ];
    const body = h('div', { class: 'shortcuts' }, rows.map(([title, list]) => h('div', { class: 'sc-sec' }, h('div', { class: 'menu-label' }, title),
      h('table', {}, list.map(([what, keys]) => h('tr', {}, h('td', {}, what), h('td', { class: 'sc-keys' }, keys)))))));
    openModal('Keyboard shortcuts', body, { wide: true });
  }

  // ---- layout files: the charts, their drawings and the scripts they use, to back up or move to another computer
  function exportLayoutFile() {
    const n = LAYOUTS[state.layout].cells.length, charts = clone(state.charts.slice(0, n));
    const syms = [...new Set(charts.flatMap((c) => [c.symbol, ...(c.compares || []).map((x) => x.symbol)]))];
    const ids = new Set(charts.flatMap((c) => (c.indicators || []).filter((i) => i.type.startsWith('script:')).map((i) => i.type.slice(7))));
    const file = {
      candela: 'layout', version: 1, exported: new Date().toISOString(), layout: state.layout, charts, sync: clone(state.sync),
      sizes: state.layoutSizes ? clone(state.layoutSizes[state.layout] || null) : null,
      drawings: Object.fromEntries(syms.filter((x) => (state.drawings[x] || []).length).map((x) => [x, clone(state.drawings[x])])),
      scripts: state.scripts.filter((x) => ids.has(x.id)).map(clone),
    };
    const a = document.createElement('a');
    a.download = `candela-layout_${charts.map((c) => bare(c.symbol)).slice(0, 3).join('-')}_${new Date().toISOString().slice(0, 10)}.json`.replace(/[^\w.-]+/g, '_');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(file, null, 1)], { type: 'application/json' }));
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast('Layout file saved', 'info', 2000);
  }
  function importLayoutFile() {
    const inp = h('input', { type: 'file', accept: '.json,application/json' });
    inp.addEventListener('change', async () => {
      const f = inp.files[0];
      if (!f) return;
      let L;
      try { L = JSON.parse(await f.text()); } catch (e) { toast('That file isn\'t a Candela layout (not JSON).', 'warn'); return; }
      if (!L || L.candela !== 'layout' || !LAYOUTS[L.layout] || !Array.isArray(L.charts) || !L.charts.length) { toast('That file isn\'t a Candela layout.', 'warn'); return; }
      const cleanChart = (c) => c && typeof c.symbol === 'string' && typeof c.tf === 'string' && MD.ensureTf(c.tf);
      if (!L.charts.every(cleanChart)) { toast('The layout file is damaged (a chart has no symbol or timeframe).', 'warn'); return; }
      // scripts first, so their indicators load; a script with the same id is kept as it is here
      let addedScripts = 0;
      for (const sc of Array.isArray(L.scripts) ? L.scripts : []) {
        if (!sc || typeof sc.id !== 'string' || typeof sc.code !== 'string' || state.scripts.some((x) => x.id === sc.id)) continue;
        state.scripts.push({ id: sc.id, name: String(sc.name || 'Imported script').slice(0, 80), code: sc.code });
        compileSaved(sc);
        addedScripts++;
      }
      let replaced = 0;
      for (const [sym, list] of Object.entries(L.drawings || {})) {
        if (!Array.isArray(list)) continue;
        const mine = state.drawings[sym] || [], ids = new Set(mine.map((d) => d.id));
        const add = list.filter((d) => d && typeof d.type === 'string' && Array.isArray(d.pts) && !ids.has(d.id));
        if (add.length) { state.drawings[sym] = [...mine, ...add]; replaced += add.length; }
      }
      const name = (f.name.replace(/\.json$/i, '') || 'Imported layout').slice(0, 60);
      const entry = { name, layout: L.layout, charts: L.charts.slice(0, LAYOUTS[L.layout].cells.length), sync: L.sync || {}, sizes: L.sizes || null };
      const i = state.savedLayouts.findIndex((x) => x.name === name);
      if (i >= 0) state.savedLayouts[i] = entry; else state.savedLayouts.push(entry);
      save();
      openSavedLayout(entry);
      toast(`Imported "${name}" (also in Saved layouts)${replaced ? `, ${replaced} drawing${replaced === 1 ? '' : 's'}` : ''}${addedScripts ? `, ${addedScripts} script${addedScripts === 1 ? '' : 's'}` : ''}.`, 'info', 5000);
    });
    inp.click();
  }

  // Drawings belong to a symbol, so every chart showing that symbol shows the same drawings.
  function drawingsChanged(src) {
    state.drawings[src.symbol] = src.chart.drawings;
    updateLineAlerts(src.symbol, src.chart.drawings);
    for (const s of slots) {
      if (s !== src && s.symbol === src.symbol) { s.chart.drawings = src.chart.drawings; s.chart.invalidate(); }
    }
    save();
    recordHistory(src);
    renderObjTree();
  }

  // ---- undo / redo: drawings and indicators of each chart (Ctrl+Z, Ctrl+Y)
  const hist = new WeakMap(); // slot -> { stack: [snapshot json], i }
  let restoring = false;
  const snapOf = (slot) => JSON.stringify({ sym: slot.symbol, drawings: slot.chart.drawings, indicators: slot.cfg.indicators || [] });
  function resetHistory(slot) { hist.set(slot, { stack: [snapOf(slot)], i: 0 }); updateUndoButtons(); }
  function recordHistory(slot) {
    if (restoring) return;
    const H = hist.get(slot);
    if (!H) { resetHistory(slot); return; }
    const snap = snapOf(slot);
    if (H.stack[H.i] === snap) return;
    H.stack.length = H.i + 1; // a new change drops what could be redone
    H.stack.push(snap);
    if (H.stack.length > 100) H.stack.shift();
    H.i = H.stack.length - 1;
    updateUndoButtons();
  }
  function undoRedo(dir) {
    const slot = active, H = hist.get(slot);
    if (!H) return;
    const j = H.i + dir;
    if (j < 0 || j >= H.stack.length) { toast(dir < 0 ? 'Nothing to undo' : 'Nothing to redo', 'info', 1500); return; }
    const snap = JSON.parse(H.stack[j]);
    if (snap.sym !== slot.symbol) return;
    H.i = j;
    restoring = true;
    try {
      const c = slot.chart;
      c.select(null);
      c.drawings = snap.drawings;
      drawingsChanged(slot);
      slot.setIndicators(snap.indicators);
    } finally { restoring = false; }
    c_invalidate(slot);
    updateUndoButtons();
  }
  const c_invalidate = (slot) => { slot.chart.invalidate(); renderObjTree(); };
  function updateUndoButtons() {
    const H = active && hist.get(active);
    $('#undoBtn').disabled = !H || H.i <= 0;
    $('#redoBtn').disabled = !H || H.i >= H.stack.length - 1;
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
    if (state.tester.open) runTester();
    if (state.paper.open) renderTrading();
    updateUndoButtons();
    renderObjTree();
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
      live: 'Live', connecting: 'Connecting', reconnecting: 'Reconnecting', demo: 'Demo data', static: 'CSV data', loading: 'Loading', replay: 'Replay',
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
    $('#undoBtn').addEventListener('click', () => undoRedo(-1));
    $('#redoBtn').addEventListener('click', () => undoRedo(1));
    $('#settingsBtn').addEventListener('click', openChartSettings);
    $('#replayBtn').addEventListener('click', () => { if (active.replay) active.exitReplay(); else if (active.chart.picking) { active.chart.cancelPick(); updateHeader(); } else active.startReplayPick(); });
    $('#testerBtn').addEventListener('click', () => (state.tester.open ? closeTester() : openTester()));
    $('#tradeBtn').addEventListener('click', () => (state.paper.open ? closeTrading() : openTrading()));
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
    $('#replayBtn').classList.toggle('active', !!active.replay || !!active.chart.picking);
    $('#replayBtn span').textContent = active.replay ? 'Exit replay' : 'Replay';
    $('#replayBtn').title = active.replay ? 'Exit the replay and go back to live data' : 'Bar Replay: play history back candle by candle';
    $('#testerBtn').classList.toggle('active', !!state.tester.open);
    $('#tradeBtn').classList.toggle('active', !!state.paper.open);
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
    // named layouts: the charts (symbols, timeframes, indicators, chart types) and the arrangement
    const saved = h('div', { class: 'sync-box' }, h('div', { class: 'menu-label' }, 'Saved layouts'));
    for (const L of state.savedLayouts) {
      saved.appendChild(h('div', { class: 'saved-row' },
        h('button', { class: 'saved-name', title: 'Open this layout', onclick: () => { menu.classList.add('hidden'); openSavedLayout(L); } }, L.name, h('small', { class: 'muted' }, ` · ${LAYOUTS[L.layout] ? LAYOUTS[L.layout].name : ''}`)),
        h('button', { class: 'saved-x', title: 'Delete', onclick: () => { state.savedLayouts = state.savedLayouts.filter((x) => x !== L); save(); menu.classList.add('hidden'); toggleLayoutMenu(); } }, '✕')));
    }
    saved.appendChild(h('button', { class: 'btn ghost equal-btn', onclick: async () => {
      menu.classList.add('hidden');
      const name = await askText('Save layout', '', 'Name, e.g. "BTC multi-timeframe"');
      if (!name) return;
      const entry = { name: name.slice(0, 60), layout: state.layout, charts: clone(state.charts.slice(0, LAYOUTS[state.layout].cells.length)), sync: clone(state.sync), sizes: state.layoutSizes ? clone(state.layoutSizes[state.layout] || null) : null };
      const i = state.savedLayouts.findIndex((x) => x.name === entry.name);
      if (i >= 0) state.savedLayouts[i] = entry; else state.savedLayouts.push(entry);
      save();
      toast(`Layout "${entry.name}" saved`, 'info', 2000);
    } }, 'Save this layout as…'));
    if (!PREVIEW) saved.appendChild(h('div', { class: 'saved-file' },
      h('button', { class: 'btn ghost equal-btn', title: 'Save the charts, their drawings and scripts to a file', onclick: () => { menu.classList.add('hidden'); exportLayoutFile(); } }, 'Export to file'),
      h('button', { class: 'btn ghost equal-btn', title: 'Open a layout file exported from Candela', onclick: () => { menu.classList.add('hidden'); importLayoutFile(); } }, 'Import file…')));
    menu.append(...kids, syncBox, saved);
    menu.classList.remove('hidden');
    const r = $('#layoutBtn').getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8)) + 'px';
    menu.style.top = r.bottom + 6 + 'px';
  }

  function openSavedLayout(L) {
    for (const s of slots) s.exitReplay(false);
    state.charts = clone(L.charts);
    state.sync = { ...state.sync, ...clone(L.sync || {}) };
    if (L.sizes) { state.layoutSizes = state.layoutSizes || {}; state.layoutSizes[L.layout] = clone(L.sizes); }
    rebuildSlots(L.layout);
    toast(`Opened "${L.name}"`, 'info', 1800);
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
    const ruler = h('button', { class: 'tool', 'data-tool': 'ruler', title: 'Measure (or Shift + click on the chart)', onclick: () => setActiveTool(active && active.chart.tool === 'ruler' ? 'cursor' : 'ruler') });
    ruler.innerHTML = '<svg viewBox="0 0 24 24"><path d="M3 17L17 3l4 4L7 21z"/><path d="M7 13l2 2M10 10l2 2M13 7l2 2M16 4l1 1" /></svg>';
    tb.append(ruler);
    const fav = h('button', { class: 'tool', id: 'favBtn', title: 'Favorite tools (star them in the menus)', onclick: () => openToolMenu(null, fav) });
    fav.innerHTML = `<svg viewBox="0 0 24 24">${HEART}</svg>`;
    tb.append(txt, fav);
    tb.appendChild(h('div', { class: 'tb-sep' }));
    const showMagnet = () => {
      mag.classList.toggle('active', !!state.magnet);
      mag.dataset.mode = state.magnet ? (state.magnet === 'weak' ? 'W' : 'S') : '';
      mag.title = state.magnet === 'weak' ? 'Magnet: weak (snaps to open/high/low/close when close to one). Click for strong.'
        : state.magnet ? 'Magnet: strong (always snaps to open/high/low/close). Click to turn off.' : 'Magnet: off. Click for weak, again for strong.';
    };
    const mag = h('button', { class: 'tool', id: 'magnetBtn', onclick: () => {
      state.magnet = !state.magnet ? 'weak' : state.magnet === 'weak' ? 'strong' : false;
      for (const s of slots) s.chart.magnet = state.magnet;
      showMagnet();
      toast(state.magnet ? `Magnet ${state.magnet}` : 'Magnet off', 'info', 1200);
      save();
    } });
    mag.innerHTML = svg('magnet');
    showMagnet();
    const hide = h('button', { class: 'tool', title: 'Hide / show drawings', onclick: () => {
      drawingsHidden = !drawingsHidden;
      hide.classList.toggle('active', drawingsHidden);
      for (const s of slots) { s.chart.drawingsHidden = drawingsHidden; s.chart.select(null); s.chart.invalidate(); }
    } });
    hide.innerHTML = svg('eye');
    const tree = h('button', { class: 'tool', id: 'objTreeBtn', title: 'Object tree: indicators and drawings on this chart', onclick: () => { state.objTree = !state.objTree; save(); renderObjTree(); } });
    tree.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 5h3M4 12h3M4 19h3M10 5h10M10 12h10M10 19h10"/></svg>';
    tb.appendChild(tree);
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
      // indicator templates: a saved set of indicators, applied in one click
      if (!q || 'template'.includes(q) || state.indTemplates.some((t) => t.name.toLowerCase().includes(q))) {
        list.appendChild(h('div', { class: 'list-group' }, 'Templates'));
        for (const t of state.indTemplates.filter((x) => !q || 'template'.includes(q) || x.name.toLowerCase().includes(q))) {
          list.appendChild(h('div', { class: 'list-row', title: 'Replace this chart\'s indicators with the template', onclick: () => {
            slot.setIndicators(clone(t.indicators));
            toast(`Applied template "${t.name}"`, 'info', 1800);
            closeModal();
          } }, h('b', {}, t.name), h('span', { class: 'row-actions' }, h('span', { class: 'muted' }, `${t.indicators.length} indicator${t.indicators.length === 1 ? '' : 's'}`),
            h('button', { class: 'btn small-btn', title: 'Delete template', onclick: (e) => { e.stopPropagation(); state.indTemplates = state.indTemplates.filter((x) => x !== t); save(); render(); } }, '✕'))));
        }
        list.appendChild(h('div', { class: 'list-row new-script', onclick: async () => {
          const name = await askText('Save indicator template', '', 'Name, e.g. "Trend + momentum"');
          if (!name) { openIndicatorPicker(); return; }
          const entry = { name: name.slice(0, 60), indicators: clone(slot.cfg.indicators || []) };
          const i = state.indTemplates.findIndex((x) => x.name === entry.name);
          if (i >= 0) state.indTemplates[i] = entry; else state.indTemplates.push(entry);
          save();
          toast(`Template "${entry.name}" saved (${entry.indicators.length} indicators)`, 'info', 2200);
          openIndicatorPicker();
        } }, h('b', {}, '+ Save this chart\'s indicators as a template…'), h('span', { class: 'muted' }, 'Reuse the same set on any chart')));
      }
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
    // a color with an opacity slider (0% invisible … 100% solid)
    const colorCtl = (key, fallback) => {
      const cur = colors[key] || fallback;
      const ci = h('input', { type: 'color', value: toHex(cur), title: 'Color' });
      const op = h('input', { type: 'range', min: 0, max: 100, step: 1, value: Math.round(alphaOf(cur) * 100), class: 'op-slider', title: 'Opacity' });
      const pct = h('span', { class: 'op-val' }, op.value + '%');
      const upd = () => { colors[key] = applyAlpha(ci.value, +op.value / 100); pct.textContent = op.value + '%'; apply(); };
      ci.addEventListener('input', upd);
      op.addEventListener('input', upd);
      return h('span', { class: 'color-ctl' }, ci, op, pct);
    };
    const colorRow = (label, key, fallback) => {
      styleBox.appendChild(h('label', {}, h('span', {}, label), colorCtl(key, fallback)));
    };
    // lines: color, thickness 1-4 and line type (Line, Step line…, with a price line option)
    const lineRow = (pl) => {
      const st = styles[pl.key] || (styles[pl.key] = {});
      const cur = () => chart.plotStyle({ styles, colors }, pl);
      const set = (k, v) => { st[k] = v; apply(); };
      const kids = [];
      if (!pl.dynamic) kids.push(colorCtl(pl.key, pl.color));
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
    for (const c of def.colors || []) colorRow(c.name, c.key, c.color);
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
      footer, wide: true,
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
      title: 'Strategy: EMA cross', desc: 'Backtest: buy when the fast EMA crosses above the slow one, with a stop loss',
      code: `// A strategy: Candela buys and sells on these signals and shows the result in the
// Strategy Tester (button "Strategy" at the top). Orders fill at the next candle's open.
name "EMA cross strategy"
strategy capital 10000 size 100 commission 0.1 stop 5
input fastLen = 9 "Fast EMA" min 1
input slowLen = 21 "Slow EMA" min 2

fast = ema(close, fastLen)
slow = ema(close, slowLen)

buy crossover(fast, slow)
sell crossunder(fast, slow)

plot fast "Fast" color blue
plot slow "Slow" color orange
`,
    },
    {
      title: 'Strategy: RSI long/short', desc: 'Backtest: long when RSI leaves oversold, short when it leaves overbought',
      code: `// Long when RSI climbs back above 30, short when it falls back below 70.
// Each signal also closes the opposite position.
name "RSI reversal strategy"
strategy capital 10000 size 100 commission 0.1 stop 4 target 8
input length = 14 "RSI length" min 2

r = rsi(close, length)
buy crossover(r, 30)
sellshort crossunder(r, 70)
`,
    },
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

  // what the watchlist shows: All / Gainers / Losers, sorted by a column (click its header) or in your order
  function wlShown() {
    const W = state.wl, chg = (x) => (quotes[x] ? (quotes[x].c - quotes[x].o) / quotes[x].o : null);
    let list = state.watchlist.slice();
    if (W.tab === 'up') list = list.filter((x) => chg(x) > 0);
    if (W.tab === 'down') list = list.filter((x) => chg(x) < 0);
    const S = W.sort || (W.tab === 'up' ? { key: 'chg', dir: -1 } : W.tab === 'down' ? { key: 'chg', dir: 1 } : null);
    if (S) {
      const val = (x) => (S.key === 'sym' ? bare(x) : S.key === 'last' ? quotes[x]?.c : S.key === 'vol' ? quotes[x]?.vq : chg(x));
      list.sort((a, b) => {
        const A = val(a), B = val(b);
        if (A == null || Number.isNaN(A)) return 1;
        if (B == null || Number.isNaN(B)) return -1;
        return (typeof A === 'string' ? A.localeCompare(B) : A - B) * S.dir;
      });
    }
    return list;
  }
  function renderWlHead() {
    let tabs = document.getElementById('wlTabs');
    const cols = $('.wl-cols');
    if (!tabs) {
      tabs = h('div', { id: 'wlTabs', class: 'wl-tabs', role: 'tablist' });
      cols.parentNode.insertBefore(tabs, cols);
    }
    tabs.innerHTML = '';
    for (const [k, label] of [['all', 'All'], ['up', 'Gainers'], ['down', 'Losers']]) {
      tabs.appendChild(h('button', { class: 'wl-tab' + (state.wl.tab === k ? ' on' : ''), role: 'tab', onclick: () => { state.wl.tab = k; save(); renderWatchlist(); } }, label));
    }
    cols.innerHTML = '';
    const S = state.wl.sort;
    for (const [k, label, title] of [['sym', 'Symbol', 'Sort by name'], ['last', 'Last', 'Sort by price'], ['chg', '24h', 'Sort by 24h change'], ['vol', 'Vol', '24h volume in the quote currency (USDT, USD…). Click to sort']]) {
      const on = S && S.key === k;
      cols.appendChild(h('button', { class: 'wl-colbtn' + (on ? ' on' : ''), title: title + (on ? ' (click again to reverse, a third time for your order)' : ''), onclick: () => {
        // click: sort (high to low for numbers), again: reverse, a third time: back to your own order
        if (!on) state.wl.sort = { key: k, dir: k === 'sym' ? 1 : -1 };
        else if (S.dir === (k === 'sym' ? 1 : -1)) state.wl.sort = { key: k, dir: -S.dir };
        else state.wl.sort = null;
        save();
        renderWatchlist();
      } }, label, on ? (S.dir > 0 ? ' ▲' : ' ▼') : ''));
    }
  }
  let wlResortTimer = null;
  function wlResortSoon() {
    if (wlResortTimer || (state.wl.tab === 'all' && !state.wl.sort)) return;
    wlResortTimer = setTimeout(() => {
      wlResortTimer = null;
      const want = wlShown().join(), have = [...document.querySelectorAll('#watchlist .wl-row')].map((r) => r.dataset.sym).join();
      if (want !== have) renderWatchlist();
    }, 3000);
  }
  function renderWatchlist() {
    const wl = $('#watchlist');
    renderWlHead();
    wl.innerHTML = '';
    const shown = wlShown();
    if (!shown.length && state.watchlist.length) wl.appendChild(h('p', { class: 'muted wl-empty' }, state.wl.tab === 'up' ? 'Nothing in your watchlist is up over 24 hours.' : 'Nothing in your watchlist is down over 24 hours.'));
    for (const sym of shown) {
      const q = quotes[sym];
      const row = h('div', { class: 'wl-row' + (active && sym === active.symbol ? ' active' : ''), 'data-sym': sym, onclick: () => openSymbol(sym) },
        h('span', { class: 'wl-sym', title: isStock(sym) ? `${bare(sym)} (${MD.isForex(sym) ? 'forex' : 'stock'}, Twelve Data)` : MD.isBStock(sym) ? `${bare(sym)}: Binance bStock tracking ${MD.bStockTicker(sym)}` : exOf(sym) ? `${bare(sym)} on ${exOf(sym).name}` : `${sym} on Binance` },
          bare(sym), exOf(sym) ? h('i', { class: 'ex-tag' }, exOf(sym).tag) : null),
        h('span', { class: 'wl-last' }, q ? q.c.toFixed(decimalsFor(q.c)) : '—'),
        h('span', { class: 'wl-chg' }, q ? fmtChg(q) : ''),
        h('span', { class: 'wl-vol' }, q && q.vq > 0 ? fmtVol(q.vq) : ''),
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
  const fmtVol = (v) => (v >= 1e9 ? (v / 1e9).toFixed(v >= 1e10 ? 0 : 1) + 'B' : v >= 1e6 ? (v / 1e6).toFixed(v >= 1e7 ? 0 : 1) + 'M' : v >= 1e3 ? (v / 1e3).toFixed(v >= 1e4 ? 0 : 1) + 'K' : v.toFixed(0));

  function updateQuote(sym, c, o, vq) {
    const prev = quotes[sym];
    quotes[sym] = { c, o, vq: vq > 0 ? vq : prev ? prev.vq : undefined };
    wlResortSoon();
    const row = document.querySelector(`.wl-row[data-sym="${sym}"]`);
    if (!row) { if (state.wl.tab !== 'all' && state.watchlist.includes(sym)) wlResortSoon(); return; }
    $('.wl-last', row).textContent = c.toFixed(decimalsFor(c));
    $('.wl-chg', row).textContent = fmtChg(quotes[sym]);
    if (quotes[sym].vq > 0) $('.wl-vol', row).textContent = fmtVol(quotes[sym].vq);
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
    const syms = [...new Set([...state.watchlist, ...priceAlerts().filter((a) => a.active).map((a) => a.symbol), ...paperSyms()])]
      .filter((s) => !isDemo(s) && !s.startsWith('CSV:') && !isStock(s) && !exOf(s));
    pollStockQuotes();
    pollExQuotes();
    if (!syms.length) return;
    try { (await MD.tickers24(syms)).forEach((q) => updateQuote(q.s, q.c, q.o, q.vq)); } catch (e) { /* offline */ }
    tickStop = MD.tickerStream(syms, (q) => {
      updateQuote(q.s, q.c, q.o, q.vq);
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
    const tradeSyms = paperSyms().filter(exOf);
    const syms = [...new Set([...state.watchlist.filter(exOf), ...alertSyms, ...tradeSyms])];
    if (!syms.length) return;
    await Promise.all(syms.map(async (sym) => {
      let q;
      try { q = await MD.ticker(sym); } catch (e) { return; }
      updateQuote(sym, q.c, q.o, q.vq);
      if (!slots.some((x) => x.symbol === sym && x.mode === 'live')) checkAlerts(sym, q.c);
    }));
    exQuoteTimer = setTimeout(pollExQuotes, alertSyms.length || tradeSyms.length ? 5000 : 10000);
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
    const syms = [...new Set([...state.watchlist.filter(isStock), ...alertSyms, ...paperSyms().filter(isStock)])];
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
  // alerts checked on every price update: price levels and drawn lines (the others are checked on candles)
  const priceAlerts = () => state.alerts.filter((a) => AL.isTick(a));
  const dirWord = (a) => (a.dir === 'up' ? ' up through' : a.dir === 'down' ? ' down through' : '');
  // what an alert watches, after the symbol
  function alertText(a) {
    if (AL.isMarker(a)) return ` ${tfName(a.tf)} · ${a.scriptName}: ${a.markName}`;
    if (AL.isCond(a)) return ` ${tfName(a.tf)} · ${AL.condTitle(a).split(' · ').slice(1).join(' · ')}`;
    if (AL.isLine(a)) return ` crossing${dirWord(a)} ${a.name || 'line'}`;
    if (AL.isRect(a)) return ` ${a.on === 'enter' ? 'entering' : a.on === 'exit' ? 'leaving' : 'entering or leaving'} ${a.box.bot.toFixed(decimalsFor(a.box.bot))}–${a.box.top.toFixed(decimalsFor(a.box.top))}`;
    return ` crossing${dirWord(a)} ${a.price.toFixed(decimalsFor(a.price))}`;
  }

  function alertTitle(a) { return symLabel(a.symbol) + alertText(a); }
  function refreshAlerts() {
    for (const s of slots) {
      s.chart.alerts = state.alerts.filter((a) => !a.kind && a.active && a.symbol === s.symbol); // level lines on the chart
      s.chart.invalidate();
    }
    renderServerStatus();
    const box = $('#alertList');
    box.innerHTML = '';
    if (!state.alerts.length) { box.appendChild(h('div', { class: 'empty' }, 'No alerts. Right-click a chart, press Alt+A, or use the bell on a script with markers.')); return; }
    for (const a of [...state.alerts].reverse()) {
      let stateText = a.active ? 'active' : a.expiredAt ? 'expired' : 'triggered';
      if (AL.isBar(a) || AL.isLine(a) || AL.isRect(a)) {
        if (a.paused) stateText = 'paused';
        else if (a.active) stateText = a.fires ? `active · fired ${a.fires}×` : 'active';
      }
      if (a.active && !a.paused && srv.connected && !a.server) stateText += ' · this tab only';
      const tip = AL.isBar(a)
        ? `${a.when === 'close' ? `Fires when a bar closes with ${AL.isMarker(a) ? 'this marker' : 'this condition true'}` : `Fires as soon as ${AL.isMarker(a) ? 'this marker appears' : 'this condition is true'}`}, ${a.repeat === 'once' ? 'once' : 'every time (once per bar)'}.` +
          (a.lastFired ? `\nLast fired ${new Date(a.lastFired).toLocaleString()}.` : '') + (a.paused ? `\nPaused: ${a.paused}` : '')
        : AL.isLine(a) ? `Fires when the price crosses the ${a.name}${a.repeat === 'every' ? ', every time (at most once a minute)' : ', once'}.`
          : 'Fires once when the price crosses this level.';
      const where = !a.active ? '' : a.server && srv.connected ? '\nRuns on the alert server, even with the browser closed.'
        : srv.connected ? '\nRuns only while this tab is open (simulated and CSV data stay in the browser).' : '\nRuns while this page is open.';
      const row = h('div', { class: 'al-row' + (a.active && !a.paused ? '' : ' done') + (AL.isBar(a) ? ' marker' : ''), title: tip + where + '\nRight-click to edit or remove.', onclick: () => showAlertOnChart(a),
        oncontextmenu: (e) => { e.preventDefault(); showAlertMenu(a, e.clientX, e.clientY); } },
        h('span', { class: 'al-dot' }),
        h('span', { class: 'al-text' }, h('b', {}, symLabel(a.symbol)),
          alertText(a),
          a.paused ? h('small', { class: 'al-why' }, a.paused) : null,
          optionsText(a) ? h('small', { class: 'al-opt' }, optionsText(a)) : null),
        h('span', { class: 'muted al-state' }, stateText),
        h('button', { class: 'wl-x', title: 'Delete alert', onclick: (e) => {
          e.stopPropagation();
          deleteAlert(a);
        } }, '✕'));
      box.appendChild(row);
    }
  }

  function showAlertOnChart(a) {
    const match = slots.find((s) => s.symbol === a.symbol && (!AL.isBar(a) || s.tf === a.tf));
    if (match) { setActive(match); return; }
    if (AL.isBar(a)) active.load(a.symbol, a.tf);
    else if (!slots.some((s) => s.symbol === a.symbol)) active.load(a.symbol);
  }

  // right-click on an alert in the list
  function showAlertMenu(a, x, y) {
    const menu = $('#ctxMenu');
    menu.innerHTML = '';
    const item = (label, fn, cls = '') => menu.appendChild(h('button', { class: 'ctx-item ' + cls, onclick: () => { hideMenus(); fn(); } }, label));
    menu.appendChild(h('div', { class: 'ctx-label' }, alertTitle(a)));
    item('Edit alert…', () => editAlertDialog(a));
    item('Show on the chart', () => showAlertOnChart(a));
    item('Remove alert', () => deleteAlert(a), 'danger');
    menu.classList.remove('hidden');
    const r = menu.getBoundingClientRect();
    menu.style.left = Math.min(x, window.innerWidth - r.width - 8) + 'px';
    menu.style.top = Math.min(y, window.innerHeight - r.height - 8) + 'px';
  }
  // after an edit or a drag: save, and replace it on the alert server
  async function resyncAlert(a) {
    save();
    refreshAlerts();
    syncMarkerFeeds();
    startTickers();
    if (!a.server) return; // runs in this tab (it goes to the server when that connects)
    if (srv.connected) {
      try {
        const saved = await srvApi('PUT', '/api/alerts/' + a.id, toServer(a));
        const i = state.alerts.findIndex((x) => x.id === a.id);
        if (i >= 0) state.alerts[i] = { ...saved, server: true };
      } catch (e) { toast(`The alert server did not take the change (${e.message}).`, 'warn', 6000); }
    } else {
      state.serverDeletes.push(a.id); // replace it when the server is back
      a.server = false;
    }
    save();
    refreshAlerts();
  }
  // a price alert's line was dragged on the chart
  function alertMoved(a) {
    if (lastPx[a.symbol] != null) a.refPrice = lastPx[a.symbol];
    toast(`Alert moved: ${alertTitle(a)}`, 'info', 1800);
    resyncAlert(a);
  }
  function editAlertDialog(a) {
    const form = h('div', { class: 'form' }, h('label', {}, h('span', {}, 'Alert'), h('b', {}, alertTitle(a))));
    const sel = (options, value) => { const s = h('select', {}, options.map(([v, l]) => h('option', { value: v }, l))); s.value = value; return s; };
    const row = (label, ctl) => { form.appendChild(h('label', {}, h('span', {}, label), ctl)); return ctl; };
    let price, dir, op, value, when, repeat, on;
    if (AL.isRect(a)) {
      on = row('When the price', sel([['enter', 'Enters the zone'], ['exit', 'Leaves the zone'], ['both', 'Enters or leaves the zone']], a.on || 'both'));
      repeat = row('Repeat', sel([['once', 'Only once'], ['every', 'Every time (at most once a minute)']], a.repeat || 'once'));
    } else if (!a.kind || AL.isLine(a)) {
      if (!a.kind) { price = row('Price', h('input', { type: 'number', step: 'any', value: a.price })); }
      dir = row('Direction', sel([['', 'Crossing either way'], ['up', 'Crossing up'], ['down', 'Crossing down']], a.dir || ''));
      if (AL.isLine(a)) repeat = row('Repeat', sel([['once', 'Only once'], ['every', 'Every time (at most once a minute)']], a.repeat || 'once'));
    } else {
      if (AL.isCond(a)) {
        op = row('Condition', sel(Object.entries(AL.OPS).map(([k, l]) => [k, l[0].toUpperCase() + l.slice(1)]), a.op));
        if (a.right.src === 'value') value = row('Value', h('input', { type: 'number', step: 'any', value: a.right.value }));
      }
      when = row('Trigger', sel([['close', 'When the bar closes'], ['bar', 'As soon as it happens']], a.when || 'close'));
      repeat = row('Repeat', sel([['every', 'Every time (once per bar)'], ['once', 'Only once']], a.repeat || 'every'));
    }
    const opts = alertOptions(a);
    form.appendChild(opts.el);
    if (!a.active) form.appendChild(h('p', { class: 'muted' }, a.expiredAt ? 'This alert expired; saving turns it on again (pick a new expiry).' : 'This alert already fired; saving turns it on again.'));
    const m = openModal('Edit alert', form, {
      footer: [h('button', { class: 'btn ghost danger-text', onclick: () => { m.close(); deleteAlert(a); } }, 'Remove'), h('span', { class: 'spacer' }),
        h('button', { class: 'btn ghost', onclick: () => m.close() }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: () => {
          if (price) { const v = +price.value; if (!isFinite(v) || v <= 0) { price.focus(); return; } a.price = v; }
          if (value) { const v = +value.value; if (!isFinite(v)) { value.focus(); return; } a.right = { src: 'value', value: v }; }
          if (dir) { if (dir.value) a.dir = dir.value; else delete a.dir; }
          if (!opts.applyTo(a)) return;
          if (on) a.on = on.value;
          if (op) a.op = op.value;
          if (when) a.when = when.value;
          if (repeat) a.repeat = repeat.value;
          if (!a.kind && lastPx[a.symbol] != null) a.refPrice = lastPx[a.symbol];
          a.active = true;
          delete a.triggeredAt;
          delete a.paused;
          delete a.lastBarT;
          // conditions already true on the current bar don't fire for it
          if (AL.isBar(a)) { const s = slots.find((x) => x.symbol === a.symbol && x.tf === a.tf); if (s && s.chart.raw.length) evaluateMarkerAlert(a, s.chart.raw, true); }
          m.close();
          toast(`Alert changed: ${alertTitle(a)}`, 'info', 1800);
          resyncAlert(a);
        } }, 'Save')],
    });
  }

  function askNotificationPermission() {
    if (window.candelaDesktop) return; // the desktop app shows Windows notifications itself
    if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
  }

  function addAlert(symbol, price, dir, opts = {}) {
    if (!isFinite(price)) return;
    const a = { id: uid(), symbol, price: +price, active: true, created: Date.now(), ...opts };
    if (dir === 'up' || dir === 'down') a.dir = dir;
    if (lastPx[symbol] != null) a.refPrice = lastPx[symbol]; // lets the server spot a crossing before its first price check
    state.alerts.push(a);
    registerAlert(a);
    toast(`Alert set: ${alertTitle(a)}`, 'info');
    askNotificationPermission();
  }

  // ---- alert options: expiry, active hours, which notification channels (server)
  const myZone = () => (state.timeZone && state.timeZone.includes('/') ? state.timeZone : Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  function alertOptions(a = {}) {
    const EXP = [['', 'Never'], ['1h', 'In 1 hour'], ['4h', 'In 4 hours'], ['1d', 'In 1 day'], ['1w', 'In 1 week'], ['1M', 'In 1 month'], ['date', 'On a date…']];
    const exp = h('select', {}, EXP.map(([v, l]) => h('option', { value: v }, l)));
    const pad = (n) => String(n).padStart(2, '0'), localInput = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
    const date = h('input', { type: 'datetime-local', hidden: true });
    if (a.expires) { exp.value = 'date'; date.value = localInput(a.expires); date.hidden = false; }
    exp.addEventListener('change', () => { date.hidden = exp.value !== 'date'; if (exp.value === 'date' && !date.value) date.value = localInput(Date.now() + 86400e3); });
    const hOn = h('input', { type: 'checkbox', checked: !!a.hours });
    const from = h('input', { type: 'time', value: a.hours ? a.hours.from : '09:00' }), to = h('input', { type: 'time', value: a.hours ? a.hours.to : '17:00' });
    const days = h('select', {}, h('option', { value: 'all' }, 'every day'), h('option', { value: 'weekdays' }, 'Monday to Friday'));
    days.value = a.hours ? a.hours.days : 'all';
    const tz = a.hours ? a.hours.tz : myZone();
    const syncHours = () => { for (const x of [from, to, days]) x.disabled = !hOn.checked; };
    hOn.addEventListener('change', syncHours);
    syncHours();
    const chans = srv.connected ? srv.channels : [];
    const chanBoxes = chans.map((c) => { const cb = h('input', { type: 'checkbox', checked: !a.channels || a.channels.includes(c) }); return [c, cb, h('label', { class: 'check-row inline' }, cb, h('span', {}, c[0].toUpperCase() + c.slice(1)))]; });
    const summary = () => [a.expires ? 'expires' : '', a.hours ? 'active hours' : '', a.channels ? 'some channels' : ''].filter(Boolean).join(', ');
    const el = h('details', { class: 'al-opts', open: !!(a.expires || a.hours || a.channels) },
      h('summary', {}, 'Expiry, active hours', chans.length ? ', notifications' : '', summary() ? h('small', { class: 'muted' }, ` (${summary()})`) : null),
      h('div', { class: 'form' },
        h('label', {}, h('span', {}, 'Expires'), h('span', { class: 'tf-pick' }, exp, date)),
        h('label', {}, h('span', {}, 'Active hours'), h('span', { class: 'al-hours' }, hOn, h('span', {}, 'only'), from, h('span', {}, 'to'), to, days)),
        h('small', { class: 'muted' }, `Times in ${tz}. Outside them the alert waits and doesn't fire.`),
        chans.length ? h('label', {}, h('span', {}, 'Notify via'), h('span', { class: 'al-chans' }, chanBoxes.map((x) => x[2]))) : null));
    const read = () => {
      const o = {};
      if (exp.value === 'date') { const t = new Date(date.value).getTime(); if (!(t > Date.now())) { toast('Pick an expiry date in the future', 'warn', 2500); date.focus(); return null; } o.expires = t; }
      else if (exp.value) o.expires = Date.now() + { '1h': 3600e3, '4h': 4 * 3600e3, '1d': 86400e3, '1w': 7 * 86400e3, '1M': 30 * 86400e3 }[exp.value];
      if (hOn.checked) {
        if (!from.value || !to.value || from.value === to.value) { toast('Pick a start and an end time for the active hours', 'warn', 2500); return null; }
        o.hours = { from: from.value, to: to.value, days: days.value, tz };
      }
      if (chanBoxes.length && chanBoxes.some(([, cb]) => !cb.checked)) o.channels = chanBoxes.filter(([, cb]) => cb.checked).map(([c]) => c);
      return o;
    };
    // for editing: set or clear the options on an alert
    const applyTo = (al) => {
      const o = read();
      if (!o) return false;
      for (const k of ['expires', 'hours', 'channels']) { if (o[k] !== undefined) al[k] = o[k]; else delete al[k]; }
      delete al.expiredAt;
      return true;
    };
    return { el, read, applyTo };
  }
  const fmtWhen = (t) => new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const optionsText = (a) => [a.expires ? (a.active ? `until ${fmtWhen(a.expires)}` : a.expiredAt ? 'expired' : '') : '', a.hours ? `${a.hours.from}–${a.hours.to}${a.hours.days === 'weekdays' ? ' Mon–Fri' : ''}` : '', a.channels ? `via ${a.channels.join(', ') || 'no channel'}` : ''].filter(Boolean).join(' · ');

  // markers available on a chart: [{ ind, pl }] for every script indicator plot drawn as a marker
  const chartMarkers = (chart) => chart.indicators.filter((i) => i.def.script).flatMap((ind) => ind.def.plots.filter((pl) => pl.style === 'mark').map((pl) => ({ ind, pl })));

  function addMarkerAlert(slot, ind, pl, when, repeat, opts = {}) {
    const a = { ...opts,
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

  // a condition alert: price or an indicator line against a value or another line, checked on candles
  function addCondAlert(slot, left, op, right, when, repeat, opts = {}) {
    const a = { ...opts, id: uid(), kind: 'cond', symbol: slot.symbol, tf: slot.tf, left, op, right, when, repeat, active: true, fires: 0, created: Date.now() };
    state.alerts.push(a);
    if (slot.chart.raw.length) evaluateMarkerAlert(a, slot.chart.raw, true); // a condition already true on this bar doesn't fire for it
    registerAlert(a);
    toast(`Alert set: ${alertTitle(a)}`, 'info');
    askNotificationPermission();
  }
  // what a condition can watch on this chart: the price, and every line of every indicator
  function alertSources(chart) {
    const out = [{ id: 'price', label: 'Price', spec: { src: 'price' } }];
    for (const ind of chart.indicators) {
      const lines = ind.def.plots.filter((pl) => pl.style !== 'mark');
      const base = chart.indicatorLabel({ ...ind, tf: null });
      for (const pl of lines) {
        const label = lines.length > 1 ? `${base} · ${pl.name}` : base;
        out.push({ id: `${ind.id}:${pl.key}`, ind, pl, label, spec: { src: 'ind', type: ind.def.id, params: { ...ind.params }, key: pl.key, label } });
      }
    }
    return out;
  }
  // preset: { ind, markKey } to open the dialog on an indicator or a script's marker (from the legend bell)
  function openAlertDialog(price, preset) {
    const slot = active, chart = slot.chart, csv = slot.symbol.startsWith('CSV:');
    const last = chart.raw[chart.raw.length - 1];
    const markers = chartMarkers(chart), sources = alertSources(chart);
    const left = h('select', { id: 'alertCond' },
      sources.map((src) => h('option', { value: 's:' + src.id }, src.label)),
      markers.length ? h('optgroup', { label: 'Script markers' }, markers.map((m, i) => h('option', { value: 'm:' + i }, `${chart.indicatorLabel(m.ind)} · ${m.pl.name} marker`))) : null);
    if (preset) {
      const mi = markers.findIndex((m) => m.ind.id === preset.ind.id && (!preset.markKey || m.pl.key === preset.markKey));
      const si = sources.findIndex((x) => x.ind && x.ind.id === preset.ind.id);
      if (preset.markKey && mi >= 0) left.value = 'm:' + mi;
      else if (si >= 0) left.value = 's:' + sources[si].id;
      else if (mi >= 0) left.value = 'm:' + mi;
    }
    const op = h('select', {}, Object.entries(AL.OPS).map(([k, label]) => h('option', { value: k }, label[0].toUpperCase() + label.slice(1))));
    const right = h('select', {});
    const valueIn = h('input', { type: 'number', step: 'any', id: 'alertPrice' });
    const radio = (name, value, label, hint, checked) => h('label', { class: 'radio' },
      h('input', { type: 'radio', name, value, checked }), h('span', {}, h('b', {}, label), hint ? h('small', {}, hint) : null));
    const whenBox = h('div', { class: 'radio-group' },
      radio('alertWhen', 'close', 'When the bar closes', 'Confirmed only. No false alarms.', true),
      radio('alertWhen', 'bar', 'As soon as it happens', 'Faster, but it can undo itself before the bar closes.', false));
    const repeatBox = h('div', { class: 'radio-group' }, radio('alertRepeat', 'every', 'Every time', 'At most once per bar', true), radio('alertRepeat', 'once', 'Only once', null, false));
    const opRow = h('label', {}, h('span', {}, ''), op);
    const rightRow = h('label', {}, h('span', {}, 'Value'), h('span', { class: 'tf-pick' }, right, valueIn));
    const barRows = h('div', { class: 'form' }, h('div', { class: 'form-block' }, h('span', {}, 'Trigger'), whenBox), h('div', { class: 'form-block' }, h('span', {}, 'Repeat'), repeatBox));
    const note = h('p', { class: 'muted' });
    const leftSrc = () => sources.find((x) => 's:' + x.id === left.value);
    // the latest value of a source, to prefill the level
    const lastValue = (src) => {
      if (!src || src.id === 'price') return last ? last.c : 0;
      const arr = src.ind.out[src.pl.key];
      for (let i = (arr ? arr.length : 0) - 1; i >= 0; i--) if (isFinite(arr[i])) return arr[i];
      return 0;
    };
    let lastLeft = null;
    const sync = () => {
      const isMarker = left.value.startsWith('m:'), src = leftSrc();
      opRow.hidden = isMarker;
      rightRow.hidden = isMarker;
      // the other side: a value, or the price / another line
      if (!isMarker && lastLeft !== left.value) {
        const keep = right.value;
        right.innerHTML = '';
        right.appendChild(h('option', { value: 'value' }, 'Value'));
        for (const x of sources) if (x !== src) right.appendChild(h('option', { value: 's:' + x.id }, x.label));
        right.value = [...right.options].some((o) => o.value === keep) ? keep : 'value';
        const v = price != null && src && src.id === 'price' ? price : lastValue(src);
        valueIn.value = (+v).toFixed(src && src.id !== 'price' ? 2 : chart.decimals);
        lastLeft = left.value;
      }
      valueIn.hidden = right.value !== 'value';
      const simplePrice = !isMarker && src && src.id === 'price' && right.value === 'value' && op.value.startsWith('cross');
      barRows.hidden = simplePrice;
      if (isMarker) note.textContent = csv ? 'Imported CSV data never updates, so this alert can’t fire on it.' : `Watches ${bare(slot.symbol)} on the ${tfName(slot.tf)} timeframe with this script's current settings, even if you switch the chart to something else.`;
      else if (simplePrice) note.textContent = 'A price alert: checked on every price update, fires once.';
      else {
        const htf = [src, leftSrc && sources.find((x) => 's:' + x.id === right.value)].filter((x) => x && x.ind && x.ind.tf && x.ind.tf !== slot.tf);
        note.textContent = `Checked on ${bare(slot.symbol)} ${tfName(slot.tf)} candles with the indicators' current settings.` +
          (htf.length ? ` Note: ${htf.map((x) => x.label).join(', ')} is set to another timeframe on the chart; the alert calculates it on ${tfName(slot.tf)}.` : '');
      }
      if (isDemo(slot.symbol) && !simplePrice) note.textContent += ` Simulated data only updates while ${bare(slot.symbol)} ${tfName(slot.tf)} is on a chart.`;
      note.textContent += srv.connected && !isDemo(slot.symbol) && !csv ? ' Runs on the alert server, even with the browser closed.' : ' Alerts run while this page is open.';
      createBtn.disabled = csv && !simplePrice;
    };
    const opts = alertOptions();
    const body = h('div', { class: 'form' },
      h('label', {}, h('span', {}, 'Symbol'), h('b', {}, `${bare(slot.symbol)}${csv ? '' : ' · ' + tfName(slot.tf)}`)),
      h('label', {}, h('span', {}, 'Condition'), left), opRow, rightRow, barRows, note, opts.el);
    const create = () => {
      const when = body.querySelector('input[name="alertWhen"]:checked').value, repeat = body.querySelector('input[name="alertRepeat"]:checked').value;
      const o = opts.read();
      if (!o) return;
      if (left.value.startsWith('m:')) { const mk = markers[+left.value.slice(2)]; addMarkerAlert(slot, mk.ind, mk.pl, when, repeat, o); m.close(); return; }
      const src = leftSrc(), rightSpec = right.value === 'value' ? { src: 'value', value: +valueIn.value } : sources.find((x) => 's:' + x.id === right.value).spec;
      if (rightSpec.src === 'value' && !isFinite(rightSpec.value)) { valueIn.focus(); return; }
      if (src.id === 'price' && rightSpec.src === 'value' && op.value.startsWith('cross')) addAlert(slot.symbol, rightSpec.value, op.value === 'crossup' ? 'up' : op.value === 'crossdown' ? 'down' : null, o);
      else addCondAlert(slot, src.spec, op.value, rightSpec, when, repeat, o);
      m.close();
    };
    const createBtn = h('button', { class: 'btn primary', onclick: create }, 'Create');
    for (const el of [left, op, right]) el.addEventListener('change', sync);
    valueIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') create(); });
    const m = openModal('Create alert', body, { footer: [h('span', { class: 'spacer' }), h('button', { class: 'btn ghost', onclick: () => m.close() }, 'Cancel'), createBtn] });
    sync();
    setTimeout(() => (left.value === 's:price' ? valueIn.select() : left.focus()), 0);
  }

  // ---- alerts on drawn lines: trend lines, rays, extended lines, parallel channels
  const LINE_ALERT = { trend: ['segment', 'trend line'], infoline: ['segment', 'info line'], trendangle: ['segment', 'trend angle'], ray: ['ray', 'ray'], extended: ['extended', 'extended line'], parallel: ['segment', 'channel'] };
  function linesOfDrawing(d) {
    const [ext] = LINE_ALERT[d.type], [a, b] = d.pts, pt = (q) => ({ t: q.t, p: q.p });
    if (d.type !== 'parallel' || !d.pts[2] || a.t === b.t) return [{ pts: [pt(a), pt(b)], ext }];
    const c = d.pts[2], off = c.p - (a.p + ((b.p - a.p) * (c.t - a.t)) / (b.t - a.t)); // the channel's second line
    return [{ pts: [pt(a), pt(b)], ext }, { pts: [{ t: a.t, p: a.p + off }, { t: b.t, p: b.p + off }], ext }];
  }
  function openLineAlertDialog(slot, d) {
    const name = LINE_ALERT[d.type][1];
    const dir = h('select', {}, h('option', { value: '' }, `Crosses the ${name}`), h('option', { value: 'up' }, `Crosses up through the ${name}`), h('option', { value: 'down' }, `Crosses down through the ${name}`));
    const repeat = h('select', {}, h('option', { value: 'once' }, 'Only once'), h('option', { value: 'every' }, 'Every time (at most once a minute)'));
    const opts = alertOptions();
    const m = openModal('Alert on this line', h('div', { class: 'form' },
      h('label', {}, h('span', {}, 'When the price'), dir), h('label', {}, h('span', {}, 'Repeat'), repeat),
      h('p', { class: 'muted' }, `Checked on every price update${d.type === 'ray' || d.type === 'extended' ? ', along the line as it continues to the right' : ' between the two ends of the line'}. Moving the line later moves the alert with it.`), opts.el), {
      footer: [h('span', { class: 'spacer' }), h('button', { class: 'btn ghost', onclick: () => m.close() }, 'Cancel'), h('button', { class: 'btn primary', onclick: () => {
        const o = opts.read();
        if (!o) return;
        const a = { ...o, id: uid(), kind: 'line', symbol: slot.symbol, lines: linesOfDrawing(d), name, drawingId: d.id, repeat: repeat.value, active: true, fires: 0, created: Date.now() };
        if (dir.value) a.dir = dir.value;
        if (lastPx[slot.symbol] != null) a.refPrice = lastPx[slot.symbol];
        state.alerts.push(a);
        registerAlert(a);
        toast(`Alert set: ${alertTitle(a)}`, 'info');
        askNotificationPermission();
        m.close();
      } }, 'Create')],
    });
  }
  // ---- zone alerts on a rectangle: the price entering and/or leaving its price range
  const boxOf = (d) => ({ top: Math.max(d.pts[0].p, d.pts[1].p), bot: Math.min(d.pts[0].p, d.pts[1].p) });
  function openRectAlertDialog(slot, d) {
    const on = h('select', {}, h('option', { value: 'enter' }, 'Enters the zone'), h('option', { value: 'exit' }, 'Leaves the zone'), h('option', { value: 'both' }, 'Enters or leaves the zone'));
    const repeat = h('select', {}, h('option', { value: 'once' }, 'Only once'), h('option', { value: 'every' }, 'Every time (at most once a minute)'));
    const box = boxOf(d), c = slot.chart, opts = alertOptions();
    const m = openModal('Alert on this zone', h('div', { class: 'form' },
      h('label', {}, h('span', {}, 'Zone'), h('b', {}, `${c.fmtPrice(box.bot)} – ${c.fmtPrice(box.top)}`)),
      h('label', {}, h('span', {}, 'When the price'), on), h('label', {}, h('span', {}, 'Repeat'), repeat),
      h('p', { class: 'muted' }, 'Checked on every price update, on the rectangle\'s price range (its dates don\'t matter). Moving or resizing the rectangle later moves the alert with it.'), opts.el), {
      footer: [h('span', { class: 'spacer' }), h('button', { class: 'btn ghost', onclick: () => m.close() }, 'Cancel'), h('button', { class: 'btn primary', onclick: () => {
        const o = opts.read();
        if (!o) return;
        const a = { ...o, id: uid(), kind: 'rect', symbol: slot.symbol, box, on: on.value, name: 'zone', drawingId: d.id, repeat: repeat.value, active: true, fires: 0, created: Date.now() };
        if (lastPx[slot.symbol] != null) a.refPrice = lastPx[slot.symbol];
        state.alerts.push(a);
        registerAlert(a);
        toast(`Alert set: ${alertTitle(a)}`, 'info');
        askNotificationPermission();
        m.close();
      } }, 'Create')],
    });
  }
  // a line with an alert was moved: move the alert too
  function updateLineAlerts(symbol, drawings) {
    for (const a of state.alerts) {
      if (AL.isRect(a) && a.symbol === symbol && a.drawingId && a.active) {
        const d = drawings.find((x) => x.id === a.drawingId);
        if (!d || d.type !== 'rect' || d.pts.length < 2) continue;
        const box = boxOf(d);
        if (box.top === a.box.top && box.bot === a.box.bot) continue;
        a.box = box;
        resyncAlert(a);
        continue;
      }
      if (!AL.isLine(a) || a.symbol !== symbol || !a.drawingId || !a.active) continue;
      const d = drawings.find((x) => x.id === a.drawingId);
      if (!d || !LINE_ALERT[d.type]) continue;
      const lines = linesOfDrawing(d);
      if (JSON.stringify(lines) === JSON.stringify(a.lines)) continue;
      a.lines = lines;
      resyncAlert(a);
    }
  }

  const lastPxT = {};
  function checkAlerts(sym, price) {
    paperTick(sym, price);
    const prev = lastPx[sym], prevT = lastPxT[sym], now = Date.now();
    lastPx[sym] = price;
    lastPxT[sym] = now;
    if (prev == null || prev === price) return;
    for (const a of state.alerts) {
      if (!AL.isTick(a) || !a.active || a.symbol !== sym || servedByServer(a)) continue;
      const g = AL.gate(a, now);
      if (g === 'expired') { alertExpired(a); continue; }
      if (g === 'off') continue;
      if (AL.isRect(a)) { const res = AL.rectCrossed(a, prev, price, now); if (res) fireAlert(a, price, null, res); }
      else if (AL.isLine(a)) { const res = AL.lineCrossed(a, prev, prevT, price, now, now); if (res) fireAlert(a, price, res); }
      else if (AL.priceCrossed(a, prev, price)) fireAlert(a, price);
    }
  }

  // ---- alert log: every fire (with why) and every expiry, from this tab and from the server
  if (!Array.isArray(state.alertLog)) state.alertLog = [];
  function logAlert(msg, a, key, t = Date.now()) {
    key = key || uid();
    if (state.alertLog.some((x) => x.key === key)) return;
    state.alertLog.unshift({ key, t, msg, id: a ? a.id : null, symbol: a ? a.symbol : null });
    state.alertLog.sort((x, y) => y.t - x.t);
    if (state.alertLog.length > 300) state.alertLog.length = 300;
    save();
    if (document.getElementById('alertLogBox')) renderAlertLog();
  }
  function alertExpired(a) {
    const msg = AL.expiredText(a, alertTitle(a));
    logAlert(msg, a);
    if (a.server) a.dirty = true;
    save();
    refreshAlerts();
    syncMarkerFeeds();
    toast(msg, 'info', 5000);
  }
  // expiry dates pass without a price update too
  setInterval(() => { const now = Date.now(); for (const a of state.alerts) if (a.active && a.expires && !servedByServer(a) && AL.gate(a, now) === 'expired') alertExpired(a); }, 30000);
  function renderAlertLog() {
    const box = document.getElementById('alertLogBox');
    if (!box) return;
    box.innerHTML = '';
    if (!state.alertLog.length) { box.appendChild(h('p', { class: 'muted' }, 'Nothing has fired yet. Every alert that fires (here or on the alert server) is listed here with what happened.')); return; }
    for (const e of state.alertLog) {
      const a = state.alerts.find((x) => x.id === e.id);
      box.appendChild(h('div', { class: 'log-row' + (/^⏹/.test(e.msg) ? ' expired' : '') },
        h('span', { class: 'muted log-t' }, new Date(e.t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })),
        h('span', { class: 'log-msg' }, e.msg.replace(/^🔔 /, '')),
        e.symbol ? h('button', { class: 'btn ghost small', title: 'Open the chart', onclick: () => { closeModal(); if (a) showAlertOnChart(a); else openSymbol(e.symbol); } }, 'Chart') : null));
    }
  }
  function openAlertLog() {
    const m = openModal('Alert log', h('div', { id: 'alertLogBox', class: 'alert-log' }), { wide: true,
      footer: [h('button', { class: 'btn ghost danger-text', onclick: () => { state.alertLog = []; save(); renderAlertLog(); } }, 'Clear log'), h('span', { class: 'spacer' }), h('button', { class: 'btn primary', onclick: () => m.close() }, 'Close')] });
    renderAlertLog();
  }

  // fromServer: the alert server already announced it (in the desktop app, as a Windows notification)
  function notify(msg, { fromServer = false } = {}) {
    toast(msg, 'alert', 0);
    beep();
    if (window.candelaDesktop) { if (!fromServer) window.candelaDesktop.notify(msg); return; }
    try { if ('Notification' in window && Notification.permission === 'granted') new Notification('Candela alert', { body: msg }); } catch (e) { /* ignore */ }
  }

  function fireAlert(a, price, lineRes, rectRes) {
    const msg = rectRes ? AL.applyRectFire(a, price, rectRes) : lineRes ? AL.applyLineFire(a, price, lineRes) : AL.applyPriceFire(a, price);
    logAlert(msg, a);
    if (a.server) a.dirty = true; // fired here while the server was away: tell it later
    save();
    refreshAlerts();
    notify(msg);
  }

  // ---- object tree: the indicators and drawings of the active chart, to show/hide, lock, open or remove
  function renderObjTree() {
    let box = document.getElementById('objTree');
    const btn = document.getElementById('objTreeBtn');
    if (btn) btn.classList.toggle('active', !!state.objTree);
    if (!state.objTree || !active) { if (box) box.remove(); return; }
    if (!box) { box = h('div', { id: 'objTree', class: 'obj-tree', role: 'dialog', 'aria-label': 'Object tree' }); document.body.appendChild(box); }
    const c = active.chart;
    box.innerHTML = '';
    const icon = (path) => { const i = h('span', { class: 'ot-icon' }); i.innerHTML = `<svg viewBox="0 0 24 24">${path}</svg>`; return i; };
    const EYE = '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>', EYE_OFF = '<path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4M6.6 6.6A17 17 0 0 0 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/>';
    const LOCK = '<rect x="5" y="11" width="14" height="9" rx="1.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>', UNLOCK = '<rect x="5" y="11" width="14" height="9" rx="1.5"/><path d="M8 11V8a4 4 0 0 1 7.5-2"/>';
    const btn2 = (path, title, fn, on) => { const b = h('button', { class: 'ot-btn' + (on ? ' on' : ''), title, onclick: (e) => { e.stopPropagation(); fn(); } }); b.innerHTML = `<svg viewBox="0 0 24 24">${path}</svg>`; return b; };
    box.append(h('div', { class: 'ot-head' }, h('b', {}, 'Object tree'), h('span', { class: 'muted' }, `${bare(active.symbol)} · ${tfName(active.tf)}`),
      h('button', { class: 'icon-btn', title: 'Close', onclick: () => { state.objTree = false; save(); renderObjTree(); } }, '✕')));
    const list = h('div', { class: 'ot-list' });
    list.appendChild(h('div', { class: 'ot-group' }, `Indicators (${c.indicators.length})`));
    for (const ind of c.indicators) {
      list.appendChild(h('div', { class: 'ot-row' + (ind.visible ? '' : ' off'), title: 'Open settings', onclick: () => openIndicatorSettings(active, ind.id) },
        icon(ind.def.strategy ? '<path d="M4 19h16M6 16l4-5 3 3 5-7"/>' : '<path d="M3 17l5-6 4 4 9-10"/>'),
        h('span', { class: 'ot-name' }, c.indicatorLabel(ind)),
        btn2(ind.visible ? EYE : EYE_OFF, ind.visible ? 'Hide' : 'Show', () => { c.toggleIndicator(ind.id); active.persistIndicators(); }, !ind.visible),
        btn2('<path d="M6 6l12 12M18 6L6 18"/>', 'Remove', () => { c.removeIndicator(ind.id); active.persistIndicators(); })));
    }
    list.appendChild(h('div', { class: 'ot-group' }, `Drawings (${c.drawings.length})`));
    if (!c.drawings.length) list.appendChild(h('div', { class: 'ot-empty muted' }, 'No drawings on this symbol.'));
    const DRW = window.CandelaDrawings;
    [...c.drawings].reverse().forEach((d) => {
      const name = (DRW.TOOLS[d.type] ? DRW.TOOLS[d.type].name : d.type) + (d.text ? ` “${d.text}”` : DRW.TOOLS[d.type] && DRW.TOOLS[d.type].axis ? ` ${c.fmtPrice(d.pts[0].p)}` : '');
      list.appendChild(h('div', { class: 'ot-row' + (d.hidden ? ' off' : '') + (c.selected === d ? ' sel' : ''), title: 'Select and show on the chart', onclick: () => { if (d.hidden) return; c.select(d); c.scrollToTime(d.pts[0].t); renderObjTree(); } },
        icon(DRW.ICONS[d.type] || ''), h('span', { class: 'ot-name' }, name),
        btn2(d.locked ? LOCK : UNLOCK, d.locked ? 'Unlock' : 'Lock', () => { d.locked = !d.locked; c.onDrawingsChange(); }, d.locked),
        btn2(d.hidden ? EYE_OFF : EYE, d.hidden ? 'Show' : 'Hide', () => { d.hidden = !d.hidden; if (d.hidden && c.selected === d) c.select(null); c.onDrawingsChange(); c.invalidate(); }, d.hidden),
        btn2('<path d="M6 6l12 12M18 6L6 18"/>', 'Delete', () => { c.drawings = c.drawings.filter((x) => x !== d); if (c.selected === d) c.select(null); c.onDrawingsChange(); c.invalidate(); })));
    });
    box.appendChild(list);
  }

  // ---- bottom bar: date ranges, Go to date, time zone and clock
  const RANGES = [['1D', 86400e3, '1m'], ['5D', 5 * 86400e3, '5m'], ['1M', 30 * 86400e3, '30m'], ['3M', 91 * 86400e3, '1h'], ['6M', 182 * 86400e3, '2h'], ['YTD', 'ytd', '1d'], ['1Y', 365 * 86400e3, '1d'], ['5Y', 5 * 365 * 86400e3, '1w'], ['All', 'all', '1M']];
  const ZONES = [['local', 'Your computer'], ['UTC', 'UTC'], ['America/Los_Angeles', 'Los Angeles'], ['America/Chicago', 'Chicago'], ['America/New_York', 'New York'], ['America/Sao_Paulo', 'São Paulo'], ['Europe/London', 'London'], ['Europe/Berlin', 'Berlin / Frankfurt'], ['Europe/Istanbul', 'Istanbul'], ['Europe/Moscow', 'Moscow'], ['Asia/Dubai', 'Dubai'], ['Asia/Kolkata', 'Mumbai'], ['Asia/Singapore', 'Singapore'], ['Asia/Hong_Kong', 'Hong Kong'], ['Asia/Shanghai', 'Shanghai'], ['Asia/Tokyo', 'Tokyo'], ['Asia/Seoul', 'Seoul'], ['Australia/Sydney', 'Sydney']];
  const utcLabel = (t = Date.now()) => { const m = Math.round(CC.tzOffset(t) / 60e3), a = Math.abs(m); return `UTC${m >= 0 ? '+' : '−'}${Math.floor(a / 60)}${a % 60 ? ':' + String(a % 60).padStart(2, '0') : ''}`; };
  function buildRangeBar() {
    const bar = $('#rangeBar');
    bar.innerHTML = '';
    for (const r of RANGES) bar.appendChild(h('button', { class: 'rb-btn', title: `Show ${r[0] === 'All' ? 'all the history' : r[0] === 'YTD' ? 'this year' : 'the last ' + r[0]}`, onclick: () => showRange(r) }, r[0]));
    const go = h('button', { class: 'rb-btn rb-icon', title: 'Go to date…', onclick: goToDateDialog });
    go.innerHTML = '<svg viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="15" rx="1.5"/><path d="M4 10h16M9 3v4M15 3v4M13 15l2 2 3-4"/></svg>';
    bar.append(h('span', { class: 'rb-sep' }), go, h('span', { class: 'spacer' }));
    const clock = h('span', { class: 'rb-clock', title: 'Time zone of the chart' });
    const zone = h('select', { class: 'rb-zone', title: 'Time zone used on the time axis' }, ZONES.map(([v, label]) => h('option', { value: v }, label)));
    zone.value = state.timeZone || 'local';
    zone.addEventListener('change', () => setTimeZone(zone.value));
    const tick = () => { const now = Date.now(), d = new Date(now + CC.tzOffset(now)); clock.textContent = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}:${String(d.getUTCSeconds()).padStart(2, '0')} (${utcLabel(now)})`; };
    tick();
    setInterval(tick, 1000);
    bar.append(clock, zone);
  }
  function setTimeZone(tz) {
    state.timeZone = tz;
    save();
    CC.setTimeZone(tz);
    for (const s of slots) { s.chart._legendIdx = -2; s.chart.invalidate(); }
    const sel = document.querySelector('.rb-zone');
    if (sel) sel.value = tz;
  }
  // load older candles until the chart reaches back to t (a few requests at most)
  async function ensureHistory(slot, t) {
    for (let k = 0; k < 12 && slot.chart.raw.length && slot.chart.raw[0].t > t && !slot.noMore && slot.mode === 'live'; k++) {
      const n = slot.chart.raw.length;
      await slot.loadOlder();
      if (slot.chart.raw.length === n) break;
    }
  }
  async function showRange(r) {
    const slot = active;
    if (slot.replay) { toast('Exit the replay first.', 'warn'); return; }
    const sym = slot.symbol;
    let tf = slot.tf;
    if (!sym.startsWith('CSV:') && !isDemo(sym)) {
      tf = MD.supportsTf(sym, r[2]) ? r[2] : MD.nearestTf(sym, r[2]);
      if (tf !== slot.tf) await slot.load(sym, tf);
    }
    const raw = slot.chart.raw;
    if (!raw.length) return;
    const now = raw[raw.length - 1].t;
    const start = r[1] === 'ytd' ? Date.UTC(new Date(now).getUTCFullYear(), 0, 1) : r[1] === 'all' ? 0 : now - r[1];
    await ensureHistory(slot, start);
    slot.chart.setVisibleRange(Math.max(start, slot.chart.raw[0].t), now);
    updateHeader();
  }
  function goToDateDialog() {
    const slot = active;
    const last = slot.chart.raw.length ? slot.chart.raw[slot.chart.raw.length - 1].t : Date.now();
    const d0 = new Date(last + CC.tzOffset(last) - 30 * 86400e3);
    const input = h('input', { type: 'datetime-local', class: 'search', value: d0.toISOString().slice(0, 16) });
    const go = async () => {
      if (!input.value) return;
      // the typed time is in the chart's time zone
      const wall = Date.parse(input.value + ':00Z');
      if (!isFinite(wall)) return;
      const t = wall - CC.tzOffset(wall);
      m.close();
      await ensureHistory(slot, t - 50 * slot.chart.rawInterval);
      if (slot.chart.raw.length && slot.chart.raw[0].t > t) toast('The chart\'s history doesn\'t go back that far.', 'warn', 4000);
      slot.chart.scrollToTime(t);
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    const m = openModal('Go to date', h('div', {}, input, h('p', { class: 'muted' }, `Time zone: ${ZONES.find((z) => z[0] === (state.timeZone || 'local'))[1]} (${utcLabel()}). Older history loads if needed.`)), {
      footer: [h('span', { class: 'spacer' }), h('button', { class: 'btn ghost', onclick: () => m.close() }, 'Cancel'), h('button', { class: 'btn primary', onclick: go }, 'Go to')],
    });
    setTimeout(() => input.focus(), 0);
  }

  // ---- chart settings: colors, grid, lines, watermark, time zone (for every chart)
  function applyLook() {
    CC.setLook(state.look);
    for (const s of slots) s.chart.setTheme(state.theme);
  }
  function openChartSettings() {
    const orig = clone(state.look || {}), L = (state.look = clone(orig));
    const T = CC.THEMES[state.theme] || CC.THEMES.dark;
    const form = h('div', { class: 'form' });
    const color = (key, label) => {
      const inp = h('input', { type: 'color', value: (L[key] || T[key] || '#000000').slice(0, 7) });
      const reset = h('button', { class: 'btn small-btn', title: 'Theme color', onclick: () => { delete L[key]; inp.value = (T[key] || '#000000').slice(0, 7); applyLook(); } }, 'Reset');
      inp.addEventListener('input', () => { L[key] = inp.value; applyLook(); });
      form.appendChild(h('label', {}, h('span', {}, label), h('span', { class: 'tf-pick' }, inp, reset)));
    };
    const check = (key, label, dflt = true) => {
      const cb = h('input', { type: 'checkbox' });
      cb.checked = L[key] === undefined ? dflt : !!L[key];
      cb.addEventListener('change', () => { L[key] = cb.checked; applyLook(); });
      form.appendChild(h('label', {}, h('span', {}, label), cb));
    };
    form.appendChild(h('div', { class: 'list-group' }, 'Candles'));
    color('up', 'Up color');
    color('down', 'Down color');
    form.appendChild(h('div', { class: 'list-group' }, 'Background'));
    color('bg', 'Background');
    check('hgrid', 'Horizontal grid lines');
    check('vgrid', 'Vertical grid lines');
    check('watermark', 'Symbol watermark', false);
    form.appendChild(h('div', { class: 'list-group' }, 'Price scale'));
    check('lastLine', 'Last price line');
    check('countdown', 'Countdown to the candle close');
    form.appendChild(h('div', { class: 'list-group' }, 'Time'));
    const zone = h('select', {}, ZONES.map(([v, label]) => h('option', { value: v }, label)));
    zone.value = state.timeZone || 'local';
    zone.addEventListener('change', () => setTimeZone(zone.value));
    form.appendChild(h('label', {}, h('span', {}, 'Time zone'), zone));
    let ok = false;
    const m = openModal('Chart settings', form, {
      footer: [h('button', { class: 'btn ghost', onclick: () => { state.look = {}; applyLook(); save(); m.close(); ok = true; openChartSettings(); } }, 'Defaults'), h('span', { class: 'spacer' }),
        h('button', { class: 'btn ghost', onclick: () => m.close() }, 'Cancel'), h('button', { class: 'btn primary', onclick: () => { ok = true; save(); m.close(); } }, 'OK')],
      onClose: () => { if (!ok) { state.look = orig; applyLook(); } },
    });
  }

  // ---- Paper trading: practice accounts with virtual money. Orders fill on the live prices Candela
  // already receives (charts, watchlist, alerts). During a Bar Replay the replaying chart trades on its own
  // temporary account, filled candle by candle, with a results card when the replay ends.
  const PT = window.CandelaPaper;
  if (!state.paper || !Array.isArray(state.paper.accounts) || !state.paper.accounts.length) state.paper = { accounts: [PT.newAccount('Paper account', 100000)] };
  state.paper = { active: 0, open: false, tab: 'positions', lines: true, ...state.paper };
  for (const a of state.paper.accounts) { if (!a.leverage) a.leverage = 1; if (!Array.isArray(a.notes)) a.notes = []; }
  const PAPER_COLORS = { long: '#1f9d6b', short: '#d9465b', buy: '#3b6ff5', sell: '#e2781f', sl: '#d9465b', tp: '#1f9d6b', profit: '#1f9d6b', loss: '#d9465b' };
  const paperMain = () => state.paper.accounts[state.paper.active] || state.paper.accounts[0];
  // the account a chart trades on: its replay account while replaying, else the selected paper account
  function paperAccFor(slot) {
    if (slot && slot.replay) {
      const R = slot.replay;
      if (!R.paper) { const m = paperMain(); R.paper = PT.newAccount('Replay practice', m.start); R.paper.commission = m.commission; R.paper.leverage = m.leverage; R.paper.replay = true; }
      return R.paper;
    }
    return paperMain();
  }
  // latest price of a symbol for an account (a replay account only knows its own chart's candles)
  function paperPrice(acc, sym) {
    if (acc.replay) { const s = slots.find((x) => x.replay && x.replay.paper === acc); return s ? s.replay.full[s.replay.idx].c : null; }
    const s = slots.find((x) => x.symbol === sym && !x.replay && x.chart.raw.length);
    return s ? s.chart.raw[s.chart.raw.length - 1].c : lastPx[sym] ?? null;
  }
  const paperPrices = (acc) => Object.fromEntries([...Object.keys(acc.positions), ...acc.orders.map((o) => o.sym)].map((s) => [s, paperPrice(acc, s)]).filter(([, p]) => p > 0));
  // symbols the selected account needs prices for (open positions and waiting orders)
  const paperSyms = () => { const a = paperMain(); return [...new Set([...Object.keys(a.positions), ...a.orders.map((o) => o.sym)])]; };
  let paperSymsKey = '';
  function paperWatchSyms() {
    const k = paperSyms().sort().join(',');
    if (k !== paperSymsKey) { paperSymsKey = k; startTickers(); }
  }
  const fmtQty = (q) => (+(+q).toPrecision(6)).toLocaleString(undefined, { maximumFractionDigits: 8 });
  const fmtPx = (sym, p) => { const s = slots.find((x) => x.symbol === sym); return p == null ? '–' : s ? s.chart.fmtPrice(p) : (+p.toPrecision(8)).toString(); };

  // a new price for a symbol (from charts, the watchlist feeds and alert feeds)
  function paperTick(sym, price) {
    const acc = paperMain();
    if (!acc.positions[sym] && !acc.orders.some((o) => o.sym === sym)) return;
    const fills = PT.onPrice(acc, sym, price).filter(Boolean);
    if (fills.length) paperFilled(acc, fills, true);
    else paperRefreshSoon();
  }
  function paperFilled(acc, fills, triggered) {
    if (!acc.replay) save();
    for (const f of fills) {
      const verb = f.side === 'buy' ? 'Bought' : 'Sold';
      const pnl = f.realized ? ` · P&L ${f.realized > 0 ? '+' : ''}${fmtMoney(f.realized)}` : '';
      toast(`${f.reason}: ${verb} ${fmtQty(f.qty)} ${bare(f.sym)} at ${fmtPx(f.sym, f.price)}${pnl}${acc.replay ? ' (replay)' : ''}`, f.realized < 0 ? 'warn' : 'info', 6000);
    }
    if (triggered && !acc.replay) beep();
    paperWatchSyms();
    paperRefresh();
  }
  let paperTimer = null;
  function paperRefreshSoon() {
    if (paperTimer) return;
    paperTimer = setTimeout(() => { paperTimer = null; paperRefresh(); }, 700);
  }
  function paperRefresh() {
    clearTimeout(paperTimer);
    paperTimer = null;
    refreshTradeLines();
    if (state.paper.open) renderTrading();
  }

  // position, orders, stop loss and take profit as lines on each chart
  function refreshTradeLines() {
    for (const s of slots) {
      const lines = [];
      if (state.paper.lines !== false) {
        const acc = paperAccFor(s), sym = s.symbol, pos = acc.positions[sym], px = paperPrice(acc, sym);
        if (pos) {
          const pnl = PT.unrealized(pos, px), long = pos.qty > 0;
          lines.push({ id: 'pos', kind: 'pos', price: pos.avg, color: long ? PAPER_COLORS.long : PAPER_COLORS.short, label: `${long ? 'LONG' : 'SHORT'} ${fmtQty(Math.abs(pos.qty))}   ${pnl >= 0 ? '+' : ''}${fmtMoney(pnl)}` });
          if (pos.sl > 0) lines.push({ id: 'sl', kind: 'sl', price: pos.sl, color: PAPER_COLORS.sl, drag: true, label: `SL  ${fmtMoney((pos.sl - pos.avg) * pos.qty)}` });
          if (pos.tp > 0) lines.push({ id: 'tp', kind: 'tp', price: pos.tp, color: PAPER_COLORS.tp, drag: true, label: `TP  +${fmtMoney(Math.abs((pos.tp - pos.avg) * pos.qty))}` });
        }
        for (const o of acc.orders) {
          if (o.sym !== sym) continue;
          lines.push({ id: o.id, kind: 'order', price: o.price, color: o.side === 'buy' ? PAPER_COLORS.buy : PAPER_COLORS.sell, drag: true, label: `${o.side.toUpperCase()} ${o.type.toUpperCase()} ${fmtQty(o.qty)}` });
          if (o.sl > 0) lines.push({ id: o.id + ':sl', kind: 'osl', order: o.id, price: o.sl, color: PAPER_COLORS.sl, drag: true, label: 'SL (order)' });
          if (o.tp > 0) lines.push({ id: o.id + ':tp', kind: 'otp', order: o.id, price: o.tp, color: PAPER_COLORS.tp, drag: true, label: 'TP (order)' });
        }
      }
      s.chart.setTradeLines(lines);
    }
  }
  // a line was dragged to a new price
  function paperLineMoved(slot, l, price) {
    const acc = paperAccFor(slot), pos = acc.positions[slot.symbol];
    const order = acc.orders.find((o) => o.id === (l.order || l.id));
    if (l.kind === 'sl' && pos) pos.sl = price;
    else if (l.kind === 'tp' && pos) pos.tp = price;
    else if (l.kind === 'order' && order) order.price = price;
    else if (l.kind === 'osl' && order) order.sl = price;
    else if (l.kind === 'otp' && order) order.tp = price;
    if (!acc.replay) save();
    toast(`${{ sl: 'Stop loss', tp: 'Take profit', order: 'Order price', osl: 'Order stop loss', otp: 'Order take profit' }[l.kind]} moved to ${slot.chart.fmtPrice(price)}`, 'info', 1800);
    // a stop loss dragged past the price triggers on the next price, like a real platform
    paperRefresh();
  }
  function paperRemoveBracket(slot, l) {
    const acc = paperAccFor(slot), pos = acc.positions[slot.symbol], order = acc.orders.find((o) => o.id === l.order);
    if (l.kind === 'sl' && pos) delete pos.sl;
    if (l.kind === 'tp' && pos) delete pos.tp;
    if (l.kind === 'osl' && order) order.sl = null;
    if (l.kind === 'otp' && order) order.tp = null;
    if (!acc.replay) save();
    paperRefresh();
  }
  function paperCancel(acc, id) {
    PT.cancelOrder(acc, id);
    if (!acc.replay) save();
    toast('Order cancelled', 'info', 1500);
    paperWatchSyms();
    paperRefresh();
  }
  function paperClose(acc, sym) {
    const px = paperPrice(acc, sym);
    if (!(px > 0)) { toast(`No price for ${bare(sym)} yet. Open its chart or add it to the watchlist.`, 'warn'); return; }
    const f = PT.closePosition(acc, sym, px, acc.replay ? replayTime(acc) : Date.now(), 'Closed');
    if (f) paperFilled(acc, [f], false);
  }
  const replayTime = (acc) => { const s = slots.find((x) => x.replay && x.replay.paper === acc); return s ? s.replay.full[s.replay.idx].t : Date.now(); };

  // Order ticket. pre: { side, type, price }
  function openOrderTicket(slot, pre = {}) {
    slot = slot || active;
    const acc = paperAccFor(slot), sym = slot.symbol, c = slot.chart;
    if (sym.startsWith('CSV:')) { toast('Paper trading needs live prices; CSV files have none.', 'warn'); return; }
    const last = paperPrice(acc, sym);
    let side = pre.side || 'buy';
    const sideBtns = ['buy', 'sell'].map((k) => h('button', { type: 'button', class: 'pt-side ' + k, onclick: () => { side = k; sync(); } }, k === 'buy' ? 'Buy' : 'Sell'));
    const type = h('select', {}, [['market', 'Market'], ['limit', 'Limit'], ['stop', 'Stop']].map(([v, l]) => h('option', { value: v }, l)));
    type.value = pre.type || 'market';
    const num = (v, ph = '') => h('input', { type: 'number', step: 'any', min: 0, value: v ?? '', placeholder: ph });
    const price = num(pre.price != null ? +c.fmtPrice(pre.price) : '', last ? c.fmtPrice(last) : '');
    const qty = num('', '0'), usd = num('', '0');
    const tpOn = h('input', { type: 'checkbox' }), slOn = h('input', { type: 'checkbox' });
    const tp = num(''), sl = num('');
    const info = h('p', { class: 'muted pt-info' });
    const err = h('p', { class: 'pt-err' });
    const refPx = () => (type.value === 'market' ? last : +price.value || last);
    // keep quantity and money amount in step
    qty.addEventListener('input', () => { const p = refPx(); usd.value = p && +qty.value ? (+qty.value * p).toFixed(2) : ''; sync(); });
    usd.addEventListener('input', () => { const p = refPx(); qty.value = p && +usd.value ? +(+usd.value / p).toPrecision(6) : ''; sync(); });
    // default brackets about 2% / 4% away when ticked
    tpOn.addEventListener('change', () => { if (tpOn.checked && !tp.value) { const p = refPx(); if (p) tp.value = c.fmtPrice(p * (side === 'buy' ? 1.04 : 0.96)); } sync(); });
    slOn.addEventListener('change', () => { if (slOn.checked && !sl.value) { const p = refPx(); if (p) sl.value = c.fmtPrice(p * (side === 'buy' ? 0.98 : 1.02)); } sync(); });
    type.addEventListener('change', sync);
    price.addEventListener('input', () => { if (+qty.value) { const p = refPx(); usd.value = p ? (+qty.value * p).toFixed(2) : ''; } sync(); });
    tp.addEventListener('input', sync);
    sl.addEventListener('input', sync);
    const pctBtns = h('span', { class: 'pt-pcts' }, [10, 25, 50, 100].map((p) => h('button', { type: 'button', class: 'btn ghost small', onclick: () => {
      const e = PT.equity(acc, paperPrices(acc)).equity * (acc.leverage || 1), px = refPx();
      if (!px) return;
      usd.value = ((e * p) / 100 / (1 + (acc.commission || 0) / 100)).toFixed(2);
      qty.value = +(+usd.value / px).toPrecision(6);
      sync();
    } }, p + '%')));
    const row = (label, ...ctl) => h('label', {}, h('span', {}, label), h('span', { class: 'pt-ctl' }, ...ctl));
    const priceRow = row('Price', price);
    const form = h('div', { class: 'form pt-ticket' },
      h('div', { class: 'pt-sides' }, sideBtns),
      row('Order type', type), priceRow,
      row('Quantity', qty, h('small', { class: 'muted' }, bare(sym))),
      row('Amount', usd, h('small', { class: 'muted' }, 'USD')),
      h('div', { class: 'pt-pctrow' }, h('span', { class: 'muted' }, 'Of equity'), pctBtns),
      row('Take profit', tpOn, tp), row('Stop loss', slOn, sl),
      info, err);
    function sync() {
      for (const b of sideBtns) b.classList.toggle('on', b.classList.contains(side));
      priceRow.classList.toggle('hidden', type.value === 'market');
      tp.disabled = !tpOn.checked;
      sl.disabled = !slOn.checked;
      const p = refPx(), q = +qty.value;
      const what = type.value === 'market' ? 'at the market price' : type.value === 'limit'
        ? (side === 'buy' ? 'when the price falls to the limit or below' : 'when the price rises to the limit or above')
        : (side === 'buy' ? 'when the price rises to the stop or above' : 'when the price falls to the stop or below');
      const risk = [];
      if (q && p && tpOn.checked && +tp.value) risk.push(`reward ${fmtMoney(Math.abs(+tp.value - p) * q)}`);
      if (q && p && slOn.checked && +sl.value) risk.push(`risk ${fmtMoney(Math.abs(+sl.value - p) * q)}`);
      info.textContent = `${side === 'buy' ? 'Buys' : 'Sells'} ${what}. Last price ${last ? c.fmtPrice(last) : '–'} · ${acc.name}: ${fmtMoney(PT.equity(acc, paperPrices(acc)).equity)} equity${risk.length ? ' · ' + risk.join(', ') : ''}.`;
      submit.textContent = `${side === 'buy' ? 'Buy' : 'Sell'} ${q ? fmtQty(q) + ' ' : ''}${bare(sym)}`;
      submit.className = 'btn primary pt-submit ' + side;
      err.textContent = '';
    }
    const submit = h('button', { class: 'btn primary' }, 'Place order');
    submit.addEventListener('click', () => {
      const o = { sym, side, type: type.value, qty: +qty.value, price: type.value === 'market' ? undefined : +price.value,
        tp: tpOn.checked ? +tp.value || null : null, sl: slOn.checked ? +sl.value || null : null };
      const p = o.type === 'market' ? last : o.price;
      // brackets on the right side of the entry
      if (p && o.tp && (side === 'buy' ? o.tp <= p : o.tp >= p)) { err.textContent = `The take profit must be ${side === 'buy' ? 'above' : 'below'} the entry price.`; return; }
      if (p && o.sl && (side === 'buy' ? o.sl >= p : o.sl <= p)) { err.textContent = `The stop loss must be ${side === 'buy' ? 'below' : 'above'} the entry price.`; return; }
      // buying power: the positions after this order can't be worth more than equity × leverage
      if (p && o.qty > 0) {
        const prices = paperPrices(acc), e = PT.equity(acc, prices).equity, cur = acc.positions[sym]?.qty || 0;
        const after = cur + (side === 'buy' ? o.qty : -o.qty);
        let exposure = Math.abs(after) * p;
        for (const [s2, ps] of Object.entries(acc.positions)) if (s2 !== sym) exposure += Math.abs(ps.qty) * (prices[s2] || ps.avg);
        if (Math.abs(after) > Math.abs(cur) && exposure > e * (acc.leverage || 1) * 1.0001) { err.textContent = `Not enough buying power: this needs ${fmtMoney(exposure)} of positions, the account allows ${fmtMoney(e * (acc.leverage || 1))} (equity × leverage ${acc.leverage || 1}). Lower the quantity or raise the leverage in the Account tab.`; return; }
      }
      try {
        const res = PT.placeOrder(acc, o, last, acc.replay ? replayTime(acc) : Date.now());
        m.close();
        if (res.filled) paperFilled(acc, [res.filled], false);
        else { if (!acc.replay) save(); toast(`${side === 'buy' ? 'Buy' : 'Sell'} ${o.type} order placed: ${fmtQty(o.qty)} ${bare(sym)} at ${c.fmtPrice(o.price)}`, 'info', 2500); paperWatchSyms(); paperRefresh(); }
        if (!state.paper.open) openTrading();
      } catch (e) { err.textContent = e.message; }
    });
    const m = openModal(`${bare(sym)} · ${acc.replay ? 'Replay practice' : 'Paper trading'}`, form, { cls: 'pt-modal',
      footer: [h('span', { class: 'spacer' }), h('button', { class: 'btn ghost', onclick: () => m.close() }, 'Cancel'), submit] });
    sync();
    (type.value === 'market' ? qty : price).focus();
  }

  // edit a position's take profit and stop loss
  function editBrackets(slot, sym, acc = paperAccFor(slot)) {
    const pos = acc.positions[sym];
    if (!pos) return;
    const tp = h('input', { type: 'number', step: 'any', min: 0, value: pos.tp || '', placeholder: 'none' });
    const sl = h('input', { type: 'number', step: 'any', min: 0, value: pos.sl || '', placeholder: 'none' });
    const err = h('p', { class: 'pt-err' });
    const form = h('div', { class: 'form' }, h('label', {}, h('span', {}, 'Position'), h('b', {}, `${pos.qty > 0 ? 'Long' : 'Short'} ${fmtQty(Math.abs(pos.qty))} ${bare(sym)} at ${fmtPx(sym, pos.avg)}`)),
      h('label', {}, h('span', {}, 'Take profit'), tp), h('label', {}, h('span', {}, 'Stop loss'), sl), err);
    const m = openModal('Take profit and stop loss', form, { footer: [h('span', { class: 'spacer' }), h('button', { class: 'btn ghost', onclick: () => m.close() }, 'Cancel'),
      h('button', { class: 'btn primary', onclick: () => {
        const px = paperPrice(acc, sym) || pos.avg, long = pos.qty > 0, t = +tp.value, s = +sl.value;
        if (t && (long ? t <= px : t >= px)) { err.textContent = `The take profit must be ${long ? 'above' : 'below'} the current price.`; return; }
        if (s && (long ? s >= px : s <= px)) { err.textContent = `The stop loss must be ${long ? 'below' : 'above'} the current price.`; return; }
        if (t) pos.tp = t; else delete pos.tp;
        if (s) pos.sl = s; else delete pos.sl;
        if (!acc.replay) save();
        m.close();
        paperRefresh();
      } }, 'Save')] });
  }

  // ---- the Trading panel (bottom, in place of the Strategy Tester)
  function openTrading() {
    if (state.tester.open) closeTester();
    state.paper.open = true;
    save();
    $('#trading').classList.remove('hidden');
    $('.chart-wrap').classList.add('with-tester');
    $('.chart-wrap').style.setProperty('--tester-h', state.tester.height + 'px');
    renderTrading();
    updateHeader();
  }
  function closeTrading() {
    state.paper.open = false;
    save();
    $('#trading').classList.add('hidden');
    if (!state.tester.open) $('.chart-wrap').classList.remove('with-tester');
    updateHeader();
  }
  function renderTrading() {
    const box = $('#trading'), slot = active, acc = paperAccFor(slot), prices = paperPrices(acc), eq = PT.equity(acc, prices);
    const keepScroll = box.querySelector('.tt-body')?.scrollTop || 0;
    if (box.contains(document.activeElement) && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return; // don't disturb typing
    box.innerHTML = '';
    const grip = h('div', { class: 'tt-grip', title: 'Drag to resize' });
    grip.addEventListener('pointerdown', (e) => {
      const y0 = e.clientY, h0 = state.tester.height, wrap = $('.chart-wrap');
      grip.setPointerCapture(e.pointerId);
      const move = (ev) => { state.tester.height = Math.max(150, Math.min(wrap.clientHeight * 0.75, h0 + (y0 - ev.clientY))); wrap.style.setProperty('--tester-h', state.tester.height + 'px'); };
      const up = () => { grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', up); save(); positionDividers(); };
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', up);
    });
    const cls = (v) => (v > 0.005 ? 'up' : v < -0.005 ? 'down' : '');
    const pick = acc.replay ? h('span', { class: 'pt-acc replay', title: 'While a chart replays, it trades on its own practice account. It is cleared when the replay ends.' }, 'Replay practice')
      : h('select', { class: 'tt-pick', title: 'Paper account', onchange: (e) => { state.paper.active = +e.target.value; save(); paperWatchSyms(); paperRefresh(); } },
        state.paper.accounts.map((a, i) => h('option', { value: i, selected: i === state.paper.active }, a.name)));
    const stat = (label, v, k = '') => h('span', { class: 'pt-stat' }, h('small', { class: 'muted' }, label), h('b', { class: k }, v));
    const tabs = h('div', { class: 'tt-tabs', role: 'tablist' }, [['positions', `Positions${Object.keys(acc.positions).length ? ' ' + Object.keys(acc.positions).length : ''}`], ['orders', `Orders${acc.orders.length ? ' ' + acc.orders.length : ''}`], ['history', 'History'], ['journal', 'Journal'], ['account', 'Account']].map(([k, label]) =>
      h('button', { class: 'tt-tab' + (state.paper.tab === k ? ' on' : ''), role: 'tab', onclick: () => { state.paper.tab = k; save(); renderTrading(); } }, label)));
    box.append(grip, h('div', { class: 'tt-head pt-head' },
      h('b', {}, 'Paper trading'), pick,
      stat('Equity', fmtMoney(eq.equity)), stat('Cash', fmtMoney(acc.cash)), stat('Open P&L', (eq.unrealized > 0 ? '+' : '') + fmtMoney(eq.unrealized), cls(eq.unrealized)),
      stat('Total P&L', pctTxt(((eq.equity - acc.start) / acc.start) * 100), cls(eq.equity - acc.start)),
      tabs, h('span', { class: 'spacer' }),
      h('button', { class: 'btn pt-buy', title: `Buy ${bare(slot.symbol)}`, onclick: () => openOrderTicket(slot, { side: 'buy' }) }, 'Buy'),
      h('button', { class: 'btn pt-sell', title: `Sell ${bare(slot.symbol)}`, onclick: () => openOrderTicket(slot, { side: 'sell' }) }, 'Sell'),
      h('button', { class: 'icon-btn', title: 'Close', onclick: closeTrading }, '✕')));
    const body = h('div', { class: 'tt-body' });
    box.appendChild(body);
    const table = (head, rows, empty) => {
      if (!rows.length) return h('div', { class: 'tt-empty muted' }, empty);
      return h('div', { class: 'tt-table-wrap' }, h('table', { class: 'tt-table pt-table' }, h('thead', {}, h('tr', {}, head.map((x) => h('th', {}, x)))), h('tbody', {}, rows)));
    };
    const goto = (sym) => () => { if (active.symbol !== sym && !acc.replay) openSymbol(sym); };
    const tab = state.paper.tab;
    if (tab === 'positions') {
      const rows = Object.entries(acc.positions).map(([sym, p]) => {
        const px = prices[sym], u = PT.unrealized(p, px), long = p.qty > 0;
        return h('tr', { onclick: goto(sym), title: 'Open the chart' },
          h('td', {}, h('b', {}, bare(sym))), h('td', { class: long ? 'long' : 'short' }, long ? 'Long' : 'Short'), h('td', {}, fmtQty(Math.abs(p.qty))),
          h('td', {}, fmtPx(sym, p.avg)), h('td', {}, fmtPx(sym, px)), h('td', {}, fmtMoney(Math.abs(p.qty) * (px || p.avg))),
          h('td', { class: cls(u) }, (u > 0 ? '+' : '') + fmtMoney(u)), h('td', { class: cls(u) }, pctTxt(((px - p.avg) / p.avg) * 100 * Math.sign(p.qty))),
          h('td', {}, p.tp ? fmtPx(sym, p.tp) : '–'), h('td', {}, p.sl ? fmtPx(sym, p.sl) : '–'),
          h('td', { class: 'pt-acts' }, h('button', { class: 'btn ghost small', onclick: (e) => { e.stopPropagation(); editBrackets(slot, sym, acc); } }, 'TP / SL'),
            h('button', { class: 'btn ghost small', onclick: (e) => { e.stopPropagation(); paperClose(acc, sym); } }, 'Close')));
      });
      body.append(table(['Symbol', 'Side', 'Quantity', 'Avg price', 'Last', 'Value', 'Open P&L', 'P&L %', 'Take profit', 'Stop loss', ''], rows,
        acc.replay ? 'No open positions. Use Buy / Sell above, or right-click the chart, to trade while the replay plays.' : 'No open positions. Use Buy / Sell above, or right-click the chart at a price to place an order there.'));
    } else if (tab === 'orders') {
      const rows = acc.orders.slice().reverse().map((o) => h('tr', { onclick: goto(o.sym), title: 'Open the chart' },
        h('td', {}, h('b', {}, bare(o.sym))), h('td', { class: o.side === 'buy' ? 'long' : 'short' }, o.side === 'buy' ? 'Buy' : 'Sell'), h('td', {}, o.type === 'limit' ? 'Limit' : 'Stop'),
        h('td', {}, fmtQty(o.qty)), h('td', {}, fmtPx(o.sym, o.price)), h('td', {}, fmtPx(o.sym, prices[o.sym])), h('td', {}, o.tp ? fmtPx(o.sym, o.tp) : '–'), h('td', {}, o.sl ? fmtPx(o.sym, o.sl) : '–'),
        h('td', {}, active.chart.fmtTimeFull(o.created)),
        h('td', { class: 'pt-acts' }, h('button', { class: 'btn ghost small', onclick: (e) => { e.stopPropagation(); paperCancel(acc, o.id); } }, 'Cancel'))));
      body.append(table(['Symbol', 'Side', 'Type', 'Quantity', 'Price', 'Last', 'Take profit', 'Stop loss', 'Placed', ''], rows, 'No waiting orders. Limit and stop orders wait here until the price reaches them; drag their line on the chart to move them.'));
    } else if (tab === 'history') {
      const rows = acc.history.slice().reverse().map((f) => {
        const note = h('input', { class: 'pt-note', value: f.note || '', placeholder: 'Add a note…', onclick: (e) => e.stopPropagation() });
        note.addEventListener('change', () => { f.note = note.value.trim(); if (!acc.replay) save(); });
        return h('tr', { onclick: goto(f.sym), title: 'Open the chart' },
          h('td', {}, active.chart.fmtTimeFull(f.t)), h('td', {}, h('b', {}, bare(f.sym))), h('td', { class: f.side === 'buy' ? 'long' : 'short' }, f.side === 'buy' ? 'Buy' : 'Sell'),
          h('td', {}, fmtQty(f.qty)), h('td', {}, fmtPx(f.sym, f.price)), h('td', {}, fmtMoney(f.fee)),
          h('td', { class: cls(f.realized) }, f.realized ? (f.realized > 0 ? '+' : '') + fmtMoney(f.realized) : ''), h('td', {}, f.reason), h('td', {}, note));
      });
      body.append(table(['Time', 'Symbol', 'Side', 'Quantity', 'Price', 'Fee', 'Realized P&L', 'Reason', 'Note'], rows, 'No fills yet.'));
    } else if (tab === 'journal') {
      const sm = PT.summary(acc), closes = acc.history.filter((f) => f.realized);
      const best = closes.reduce((a, f) => Math.max(a, f.realized), 0), worst = closes.reduce((a, f) => Math.min(a, f.realized), 0);
      const gross = closes.reduce((a, f) => a + Math.max(0, f.realized), 0), lost = closes.reduce((a, f) => a + Math.min(0, f.realized), 0);
      const cell = (label, v, k = '') => h('div', { class: 'tt-stat' }, h('span', { class: 'muted' }, label), h('b', { class: k }, v));
      const text = h('textarea', { class: 'pt-jtext', rows: 3, placeholder: `What did you see on ${bare(slot.symbol)}? Why did you enter or exit? What will you do differently?` });
      const add = h('button', { class: 'btn primary', onclick: () => {
        const v = text.value.trim();
        if (!v) { text.focus(); return; }
        acc.notes.push({ id: Math.random().toString(36).slice(2, 10), t: Date.now(), sym: slot.symbol, text: v });
        if (!acc.replay) save();
        text.value = '';
        text.blur();
        renderTrading();
      } }, 'Add to journal');
      body.append(h('div', { class: 'pt-journal' },
        h('div', { class: 'tt-stats pt-jstats' },
          cell('Closed trades', String(sm.trades)), cell('Win rate', sm.trades ? sm.winRate.toFixed(1) + '%' : '–'),
          cell('Profit factor', lost ? (gross / -lost).toFixed(2) : gross ? '∞' : '–'),
          cell('Best trade', fmtMoney(best), cls(best)), cell('Worst trade', fmtMoney(worst), cls(worst)),
          cell('Fees paid', fmtMoney(eq.fees)), cell('Net P&L', (sm.net > 0 ? '+' : '') + fmtMoney(sm.net), cls(sm.net))),
        h('div', { class: 'pt-jcol' }, h('div', { class: 'pt-jadd' }, text, add),
          h('div', { class: 'pt-jlist' }, acc.notes.length ? acc.notes.slice().reverse().map((n) => h('div', { class: 'pt-jitem' },
            h('div', { class: 'pt-jmeta muted' }, `${active.chart.fmtTimeFull(n.t)} · ${bare(n.sym)}`,
              h('button', { class: 'icon-btn', title: 'Delete this entry', onclick: () => { acc.notes = acc.notes.filter((x) => x !== n); if (!acc.replay) save(); renderTrading(); } }, '✕')),
            h('div', {}, n.text))) : h('p', { class: 'muted' }, 'Your journal is empty. Notes on single fills go in the History tab.')))));
    } else {
      const num = (v, attrs = {}) => h('input', { type: 'number', step: 'any', min: 0, value: v, ...attrs });
      const comm = num(acc.commission), lev = num(acc.leverage || 1, { min: 1, max: 100, step: 1 }), bal = num(acc.start, { min: 100 });
      comm.addEventListener('change', () => { if (+comm.value >= 0 && +comm.value < 5) { acc.commission = +comm.value; if (!acc.replay) save(); } else comm.value = acc.commission; });
      lev.addEventListener('change', () => { const v = Math.round(+lev.value); if (v >= 1 && v <= 100) { acc.leverage = v; if (!acc.replay) save(); } else lev.value = acc.leverage; });
      const showLines = h('input', { type: 'checkbox', checked: state.paper.lines !== false, onchange: (e) => { state.paper.lines = e.target.checked; save(); refreshTradeLines(); } });
      const row = (label, ctl, help) => h('label', {}, h('span', {}, label), h('span', { class: 'tt-in' }, ctl), h('small', { class: 'muted tt-help' }, help));
      const acts = acc.replay ? [] : [
        h('button', { class: 'btn ghost', onclick: async () => { const n = await askText('Rename account', acc.name); if (n) { acc.name = n.slice(0, 40); save(); renderTrading(); } } }, 'Rename'),
        h('button', { class: 'btn ghost', onclick: async () => {
          if (!(await askConfirm('Reset account', `Close everything in "${acc.name}" and start again with ${fmtMoney(+bal.value || acc.start)}? Positions, orders, history and journal are cleared.`, 'Reset'))) return;
          const fresh = PT.newAccount(acc.name, Math.max(100, +bal.value || acc.start));
          Object.assign(fresh, { id: acc.id, commission: acc.commission, leverage: acc.leverage });
          for (const k of Object.keys(acc)) delete acc[k];
          Object.assign(acc, fresh);
          save(); paperWatchSyms(); paperRefresh();
        } }, 'Reset with this balance'),
        state.paper.accounts.length < 5 ? h('button', { class: 'btn ghost', onclick: async () => {
          const n = await askText('New paper account', `Account ${state.paper.accounts.length + 1}`);
          if (!n) return;
          const a = PT.newAccount(n.slice(0, 40), 100000);
          a.leverage = 1;
          state.paper.accounts.push(a);
          state.paper.active = state.paper.accounts.length - 1;
          save(); paperWatchSyms(); paperRefresh();
        } }, 'New account') : null,
        state.paper.accounts.length > 1 ? h('button', { class: 'btn ghost danger-text', onclick: async () => {
          if (!(await askConfirm('Delete account', `Delete "${acc.name}" with all its trades and journal?`, 'Delete'))) return;
          state.paper.accounts.splice(state.paper.active, 1);
          state.paper.active = 0;
          save(); paperWatchSyms(); paperRefresh();
        } }, 'Delete account') : null,
      ];
      body.append(h('div', { class: 'tt-props form' },
        acc.replay ? h('p', { class: 'muted' }, 'This chart is replaying, so it trades on a practice account that only exists until the replay ends. Then you get a summary of the replay\'s trades.') : null,
        row('Starting balance', bal, acc.replay ? '' : 'Used by Reset'),
        row('Commission', comm, '% of each fill'),
        row('Leverage', lev, 'Positions can be worth up to equity × leverage'),
        h('label', {}, h('span', {}, 'Lines on charts'), h('span', { class: 'tt-in' }, showLines), h('small', { class: 'muted tt-help' }, 'Positions, orders, stop loss and take profit')),
        h('div', { class: 'pt-acts-row' }, acts),
        h('p', { class: 'muted' }, 'Paper trading uses virtual money and Candela\'s own prices: market orders fill at the last price, limit and stop orders when a price update reaches them. Real fills can differ (spread, slippage, liquidity). Orders only fill while Candela is open.')));
    }
    const b2 = box.querySelector('.tt-body');
    if (b2) b2.scrollTop = keepScroll;
  }

  // the results of a replay's practice trades, shown when the replay ends
  function replayResults(slot, acc, px) {
    if (!acc || !acc.history.length) return;
    const prices = {};
    for (const s of Object.keys(acc.positions)) prices[s] = px;
    const eq = PT.equity(acc, prices), sm = PT.summary(acc), c = slot.chart;
    const cls = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : '');
    const cell = (label, v, k = '') => h('div', { class: 'tt-stat' }, h('span', { class: 'muted' }, label), h('b', { class: k }, v));
    const body = h('div', {},
      h('div', { class: 'tt-stats pt-results' },
        cell('Result', (eq.equity - acc.start > 0 ? '+' : '') + fmtMoney(eq.equity - acc.start), cls(eq.equity - acc.start)),
        cell('Return', pctTxt(((eq.equity - acc.start) / acc.start) * 100), cls(eq.equity - acc.start)),
        cell('Closed trades', String(sm.trades)), cell('Win rate', sm.trades ? sm.winRate.toFixed(1) + '%' : '–'),
        cell('Fees', fmtMoney(eq.fees)), cell('Still open', Object.keys(acc.positions).length ? `${fmtMoney(eq.unrealized)} unrealized` : 'Nothing', cls(eq.unrealized))),
      h('div', { class: 'tt-table-wrap pt-results-list' }, h('table', { class: 'tt-table' },
        h('thead', {}, h('tr', {}, ['Candle', 'Side', 'Quantity', 'Price', 'Realized P&L', 'Reason'].map((x) => h('th', {}, x)))),
        h('tbody', {}, acc.history.map((f) => h('tr', {}, h('td', {}, c.fmtTimeFull(f.t)), h('td', { class: f.side === 'buy' ? 'long' : 'short' }, f.side === 'buy' ? 'Buy' : 'Sell'),
          h('td', {}, fmtQty(f.qty)), h('td', {}, c.fmtPrice(f.price)), h('td', { class: cls(f.realized) }, f.realized ? fmtMoney(f.realized) : ''), h('td', {}, f.reason)))))));
    const journal = h('button', { class: 'btn ghost', onclick: () => {
      const a = paperMain();
      a.notes.push({ id: Math.random().toString(36).slice(2, 10), t: Date.now(), sym: slot.symbol,
        text: `Replay ${bare(slot.symbol)} ${tfName(slot.tf)}: ${sm.trades} closed trades, win rate ${sm.trades ? sm.winRate.toFixed(0) + '%' : '–'}, result ${fmtMoney(eq.equity - acc.start)} (${pctTxt(((eq.equity - acc.start) / acc.start) * 100)}).` });
      save();
      m.close();
      toast('Saved to the journal of ' + a.name, 'info', 2000);
      paperRefresh();
    } }, 'Save summary to journal');
    const m = openModal(`Replay results · ${bare(slot.symbol)} ${tfName(slot.tf)}`, body, { wide: true, footer: [journal, h('span', { class: 'spacer' }), h('button', { class: 'btn primary', onclick: () => m.close() }, 'Done')] });
  }
  // a replay candle: fill the replay account's orders and brackets on it
  function paperReplayBar(slot) {
    const R = slot.replay;
    if (!R || !R.paper) return;
    const fills = PT.onBar(R.paper, slot.symbol, R.full[R.idx]).filter(Boolean);
    if (fills.length) paperFilled(R.paper, fills, false);
    else paperRefreshSoon();
  }

  // ---- Strategy Tester: backtests a strategy script on the active chart's candles
  const BT = window.CandelaBacktest;
  const tester = { slot: null, scriptId: null, result: null, timer: null, error: null };
  const strategiesOn = (slot) => (slot ? slot.chart.indicators.filter((i) => i.def.strategy) : []);
  const fmtMoney = (v) => (v < 0 ? '−' : '') + Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pctTxt = (v) => (isFinite(v) ? `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}%` : '–');

  function openTester() {
    if (state.paper.open) closeTrading();
    state.tester.open = true;
    save();
    $('#tester').classList.remove('hidden');
    $('.chart-wrap').classList.add('with-tester');
    $('.chart-wrap').style.setProperty('--tester-h', state.tester.height + 'px');
    runTester();
    updateHeader();
  }
  function closeTester() {
    state.tester.open = false;
    save();
    $('#tester').classList.add('hidden');
    if (!state.paper.open) $('.chart-wrap').classList.remove('with-tester');
    for (const s of slots) s.chart.setTrades(null);
    updateHeader();
  }
  function testerRefreshSoon(slot, delay = 800) {
    if (!state.tester.open || slot !== active) return;
    if (tester.timer && delay) return; // already scheduled
    clearTimeout(tester.timer);
    tester.timer = setTimeout(() => { tester.timer = null; runTester(); }, delay);
  }
  function runTester() {
    if (!state.tester.open) return;
    const slot = active;
    for (const s of slots) if (s !== slot) s.chart.setTrades(null);
    const strats = strategiesOn(slot);
    tester.slot = slot;
    tester.result = null;
    tester.error = null;
    if (!strats.length) { slot.chart.setTrades(null); renderTester(); return; }
    const ind = strats.find((i) => i.def.scriptId === tester.scriptId) || strats[0];
    tester.scriptId = ind.def.scriptId;
    const bars = slot.chart.raw;
    try {
      const out = ind.def.calc(bars, ind.params);
      const props = { ...ind.def.strategy, ...((slot.cfg.strategyProps || {})[ind.def.scriptId] || {}) };
      tester.result = BT.backtest(bars, out, props);
      tester.result.name = ind.def.name;
    } catch (e) { tester.error = e.line ? `Script error, line ${e.line}: ${e.message}` : e.message; }
    slot.chart.setTrades(tester.result ? [...tester.result.trades, ...(tester.result.openTrade ? [tester.result.openTrade] : [])] : null);
    renderTester();
  }

  function renderTester() {
    const box = $('#tester'), slot = tester.slot || active, r = tester.result, strats = strategiesOn(slot);
    box.innerHTML = '';
    // resize handle on the top edge
    const grip = h('div', { class: 'tt-grip', title: 'Drag to resize' });
    grip.addEventListener('pointerdown', (e) => {
      const y0 = e.clientY, h0 = state.tester.height, wrap = $('.chart-wrap');
      grip.setPointerCapture(e.pointerId);
      const move = (ev) => { state.tester.height = Math.max(150, Math.min(wrap.clientHeight * 0.75, h0 + (y0 - ev.clientY))); wrap.style.setProperty('--tester-h', state.tester.height + 'px'); };
      const up = () => { grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', up); save(); positionDividers(); };
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', up);
    });
    const tabs = h('div', { class: 'tt-tabs', role: 'tablist' }, [['overview', 'Overview'], ['perf', 'Long / short'], ['periods', 'By day'], ['mc', 'Monte Carlo'], ['trades', 'List of trades'], ['props', 'Properties']].map(([k, label]) =>
      h('button', { class: 'tt-tab' + (state.tester.tab === k ? ' on' : ''), role: 'tab', onclick: () => { state.tester.tab = k; save(); renderTester(); } }, label)));
    const pick = strats.length > 1 ? h('select', { class: 'tt-pick', onchange: (e) => { tester.scriptId = e.target.value; runTester(); } },
      strats.map((i) => h('option', { value: i.def.scriptId, selected: i.def.scriptId === tester.scriptId }, i.def.name))) : null;
    const c = slot.chart, raw = c.raw;
    const range = raw.length ? `${bare(slot.symbol)} · ${tfName(slot.tf)} · ${raw.length} candles, ${c.fmtTimeFull(raw[0].t)} – ${c.fmtTimeFull(raw[raw.length - 1].t)}${slot.replay ? ' (replay)' : ''}` : '';
    box.append(grip, h('div', { class: 'tt-head' },
      h('b', {}, 'Strategy Tester'), pick || (r ? h('span', { class: 'tt-name' }, r.name) : null), tabs,
      h('span', { class: 'tt-range muted' }, range),
      h('button', { class: 'icon-btn', title: 'Close', onclick: closeTester }, '✕')));
    const body = h('div', { class: 'tt-body' });
    box.appendChild(body);
    if (!strats.length) {
      body.append(h('div', { class: 'tt-empty' },
        h('p', {}, 'Add a strategy to this chart to backtest it. A strategy is a Candela Script with buy / sell (and sellshort / cover) rules.'),
        h('button', { class: 'btn primary', onclick: () => openScriptEditor() }, 'Open the script editor'), h('span', { class: 'muted' }, ' then pick "Strategy: EMA cross" in Examples.')));
      return;
    }
    if (tester.error) { body.append(h('div', { class: 'tt-empty err' }, tester.error)); return; }
    if (!r) return;
    const st = r.stats, cls = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : '');
    if (state.tester.tab === 'overview') {
      const cell = (label, value, sub, k = '') => h('div', { class: 'tt-stat' }, h('span', { class: 'muted' }, label), h('b', { class: k }, value), sub ? h('small', { class: k }, sub) : null);
      body.append(h('div', { class: 'tt-overview' },
        h('div', { class: 'tt-stats' },
          cell('Net profit', fmtMoney(st.netProfit), pctTxt(st.netProfitPct), cls(st.netProfit)),
          cell('Closed trades', String(st.trades), `${st.wins} won · ${st.losses} lost`),
          cell('Percent profitable', st.trades ? st.winRate.toFixed(1) + '%' : '–'),
          cell('Profit factor', st.trades ? (isFinite(st.profitFactor) ? st.profitFactor.toFixed(2) : '∞') : '–'),
          cell('Max drawdown', fmtMoney(-st.maxDrawdown), pctTxt(-st.maxDrawdownPct), st.maxDrawdown ? 'down' : ''),
          cell('Avg trade', fmtMoney(st.avgTrade), `${st.avgBars.toFixed(1)} candles on average`, cls(st.avgTrade)),
          cell('Buy & hold', pctTxt(st.buyHoldPct), 'over the same candles', cls(st.buyHoldPct)),
          cell('Commission paid', fmtMoney(st.commission)),
          cell('Open position', r.openTrade ? `${r.openTrade.dir > 0 ? 'Long' : 'Short'} ${fmtMoney(r.openTrade.pnl)}` : 'None', r.openTrade ? pctTxt(r.openTrade.pnlPct) : '', r.openTrade ? cls(r.openTrade.pnl) : '')),
        h('div', { class: 'tt-curve' }, h('canvas', { id: 'ttCanvas' }), h('div', { class: 'tt-legend muted' }, h('i', { class: 'sw eq' }), 'Equity ', h('i', { class: 'sw bh' }), 'Buy & hold'))));
      requestAnimationFrame(drawEquity);
    } else if (state.tester.tab === 'perf') {
      // the same numbers for all trades, long trades only and short trades only
      const S = BT.bySide(r.trades), cols = [['all', 'All trades'], ['long', 'Long'], ['short', 'Short']];
      const pf = (x) => (x.trades ? (isFinite(x.profitFactor) ? x.profitFactor.toFixed(2) : '∞') : '–');
      const rows = [
        ['Net profit', (x) => fmtMoney(x.net), (x) => cls(x.net)], ['Gross profit', (x) => fmtMoney(x.grossProfit)], ['Gross loss', (x) => fmtMoney(-x.grossLoss)],
        ['Closed trades', (x) => String(x.trades)], ['Won / lost', (x) => `${x.wins} / ${x.losses}`], ['Percent profitable', (x) => (x.trades ? x.winRate.toFixed(1) + '%' : '–')],
        ['Profit factor', pf], ['Average trade', (x) => fmtMoney(x.avgTrade), (x) => cls(x.avgTrade)], ['Average win', (x) => fmtMoney(x.avgWin)], ['Average loss', (x) => fmtMoney(x.avgLoss)],
        ['Ratio avg win / avg loss', (x) => (x.avgLoss ? (x.avgWin / -x.avgLoss).toFixed(2) : '–')], ['Largest win', (x) => fmtMoney(x.largestWin)], ['Largest loss', (x) => fmtMoney(x.largestLoss)],
        ['Average candles in trade', (x) => x.avgBars.toFixed(1)],
      ];
      body.append(h('div', { class: 'tt-table-wrap' }, h('table', { class: 'tt-table tt-perf' },
        h('thead', {}, h('tr', {}, h('th', {}, ''), cols.map(([, l]) => h('th', {}, l)))),
        h('tbody', {}, rows.map(([label, f, k]) => h('tr', {}, h('td', { class: 'muted' }, label), cols.map(([key]) => h('td', { class: k ? k(S[key]) : '' }, f(S[key])))))))));
    } else if (state.tester.tab === 'periods') {
      const P = BT.periods(r.trades, CC.tzOffset), WD = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
      const bar = (v, mx) => h('span', { class: 'tt-bar ' + (v >= 0 ? 'up' : 'down'), style: `width:${mx ? Math.max(2, (Math.abs(v) / mx) * 100) : 0}%` });
      const wmx = Math.max(...P.weekdays.map((w) => Math.abs(w.net)), 0), dmx = Math.max(...P.daily.map((d) => Math.abs(d.net)), 0);
      const best = P.daily.reduce((a, d) => (!a || d.net > a.net ? d : a), null), worst = P.daily.reduce((a, d) => (!a || d.net < a.net ? d : a), null);
      const green = P.daily.filter((d) => d.net > 0).length;
      const dayName = (d) => new Date(d.day).toLocaleDateString(undefined, { timeZone: 'UTC', weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
      body.append(h('div', { class: 'tt-periods' },
        h('div', { class: 'tt-col' }, h('div', { class: 'menu-label' }, 'By weekday (when trades closed)'), h('table', { class: 'tt-table' },
          h('thead', {}, h('tr', {}, ['Day', 'Trades', 'Win rate', 'Net profit', ''].map((x) => h('th', {}, x)))),
          h('tbody', {}, P.weekdays.map((w, i) => h('tr', {}, h('td', {}, WD[i]), h('td', {}, String(w.trades)), h('td', {}, w.trades ? ((100 * w.wins) / w.trades).toFixed(0) + '%' : '–'),
            h('td', { class: cls(w.net) }, w.trades ? fmtMoney(w.net) : '–'), h('td', { class: 'tt-barcell' }, w.trades ? bar(w.net, wmx) : null)))))),
        h('div', { class: 'tt-col' }, h('div', { class: 'menu-label' }, `By day: ${P.daily.length} trading days, ${green} profitable` + (best && P.daily.length > 1 ? ` · best ${fmtMoney(best.net)}, worst ${fmtMoney(worst.net)}` : '')),
          P.daily.length ? h('table', { class: 'tt-table' },
            h('thead', {}, h('tr', {}, ['Date', 'Trades', 'Win rate', 'Net profit', ''].map((x) => h('th', {}, x)))),
            h('tbody', {}, P.daily.slice().reverse().map((d) => h('tr', {}, h('td', {}, dayName(d)), h('td', {}, String(d.trades)), h('td', {}, ((100 * d.wins) / d.trades).toFixed(0) + '%'),
              h('td', { class: cls(d.net) }, fmtMoney(d.net)), h('td', { class: 'tt-barcell' }, bar(d.net, dmx)))))) : h('p', { class: 'muted' }, 'No closed trades.'))));
    } else if (state.tester.tab === 'mc') {
      const mc = tester.mc && tester.mc.result === r ? tester.mc.out : (tester.mc = { result: r, out: BT.monteCarlo(r.trades, r.options.capital, 1000) }).out;
      if (!mc) { body.append(h('div', { class: 'tt-empty muted' }, 'Monte Carlo needs at least two closed trades.')); return; }
      const pc = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}%`;
      const row = (label, o, neg) => h('tr', {}, h('td', { class: 'muted' }, label), ['p5', 'p25', 'p50', 'p75', 'p95'].map((k) => h('td', { class: neg ? 'down' : cls(o[k]) }, neg ? '−' + o[k].toFixed(1) + '%' : pc(o[k]))));
      // histogram of the final returns
      const lo = Math.min(...mc.finals), hi = Math.max(...mc.finals), nb = 24, w = (hi - lo) / nb || 1, bins = new Array(nb).fill(0);
      for (const v of mc.finals) bins[Math.min(nb - 1, Math.floor((v - lo) / w))]++;
      const bmx = Math.max(...bins);
      const hist = h('div', { class: 'mc-hist', title: 'How often each end result came up' }, bins.map((c, i) => h('span', { class: 'mc-bin ' + (lo + (i + 0.5) * w >= 0 ? 'up' : 'down'), style: `height:${(c / bmx) * 100}%`, title: `${pc(lo + i * w)} to ${pc(lo + (i + 1) * w)}: ${c} runs` })));
      body.append(h('div', { class: 'tt-mc' },
        h('div', { class: 'tt-col' },
          h('p', { class: 'muted' }, `${mc.runs} made-up histories of ${r.trades.length} trades each, drawn at random from the backtest's ${r.trades.length} closed trades (some repeat, some are left out). Each trade keeps its result as a percentage of the equity it started with. The spread shows how much of the backtest could be luck.`),
          h('table', { class: 'tt-table tt-perf' },
            h('thead', {}, h('tr', {}, ['', 'Worst 5%', '25%', 'Median', '75%', 'Best 5%'].map((x) => h('th', {}, x)))),
            h('tbody', {}, row('Total return', mc.returns), row('Max drawdown', { p5: mc.drawdowns.p95, p25: mc.drawdowns.p75, p50: mc.drawdowns.p50, p75: mc.drawdowns.p25, p95: mc.drawdowns.p5 }, true))),
          h('p', {}, h('b', {}, `${mc.lossChance.toFixed(1)}%`), ` of the histories ended with a loss · the backtest's own drawdown was ${st.maxDrawdownPct.toFixed(1)}%`)),
        h('div', { class: 'tt-col mc-chart' }, h('div', { class: 'menu-label' }, 'End result of each run'), hist, h('div', { class: 'mc-axis muted' }, h('span', {}, pc(lo)), h('span', {}, pc(hi))))));
    } else if (state.tester.tab === 'trades') {
      const all = [...r.trades, ...(r.openTrade ? [r.openTrade] : [])];
      let cum = 0;
      const rows = all.map((t, i) => { cum += t.open ? 0 : t.pnl; return { t, i, cum }; }).reverse();
      body.append(h('div', { class: 'tt-table-wrap' }, h('table', { class: 'tt-table' },
        h('thead', {}, h('tr', {}, ['#', 'Type', 'Entry', 'Entry price', 'Exit', 'Exit price', 'Exit reason', 'Size', 'Profit', 'Profit %', 'Cum. profit', 'Candles'].map((x) => h('th', {}, x)))),
        h('tbody', {}, rows.map(({ t, i, cum }) => h('tr', { class: t.open ? 'open' : '', title: 'Show on the chart', onclick: () => { slot.chart.scrollToTime(t.entryT); } },
          h('td', {}, String(i + 1)), h('td', { class: t.dir > 0 ? 'long' : 'short' }, t.dir > 0 ? 'Long' : 'Short'),
          h('td', {}, c.fmtTimeFull(t.entryT)), h('td', {}, c.fmtPrice(t.entryPrice)),
          h('td', {}, t.open ? 'open' : c.fmtTimeFull(t.exitT)), h('td', {}, c.fmtPrice(t.exitPrice)), h('td', {}, t.reason),
          h('td', {}, (+t.qty.toPrecision(4)).toString()), h('td', { class: cls(t.pnl) }, fmtMoney(t.pnl)), h('td', { class: cls(t.pnl) }, pctTxt(t.pnlPct)),
          h('td', { class: cls(cum) }, t.open ? '' : fmtMoney(cum)), h('td', {}, String(t.bars))))))));
      if (!all.length) body.append(h('div', { class: 'tt-empty muted' }, 'No trades on these candles. Scroll the chart left to load more history.'));
    } else {
      const ind = strategiesOn(slot).find((i) => i.def.scriptId === tester.scriptId), def = ind.def.strategy;
      const props = (slot.cfg.strategyProps || (slot.cfg.strategyProps = {}))[tester.scriptId] || {};
      const field = (key, label, unit, help) => {
        const dflt = def[key] ?? BT.DEFAULTS[key];
        const inp = h('input', { type: 'number', min: 0, step: 'any', value: props[key] ?? '', placeholder: String(dflt) });
        inp.addEventListener('change', () => {
          const all = slot.cfg.strategyProps[tester.scriptId] = { ...(slot.cfg.strategyProps[tester.scriptId] || {}) };
          if (inp.value === '' || !(+inp.value >= 0)) delete all[key]; else all[key] = +inp.value;
          save();
          runTester();
        });
        return h('label', {}, h('span', {}, label), h('span', { class: 'tt-in' }, inp, h('small', { class: 'muted' }, unit)), h('small', { class: 'muted tt-help' }, help));
      };
      body.append(h('div', { class: 'tt-props form' },
        field('capital', 'Initial capital', '', 'Money the strategy starts with'),
        field('size', 'Order size', '% of equity', 'How much of the current equity each trade uses (up to 100)'),
        field('commission', 'Commission', '% per order', 'Paid when entering and when leaving a trade'),
        field('stop', 'Stop loss', '% from entry', '0 or empty: no stop loss'),
        field('target', 'Take profit', '% from entry', '0 or empty: no take profit'),
        field('slippage', 'Slippage', '% per fill', 'Each fill is this much worse: buys higher, sells lower'),
        h('p', { class: 'muted' }, 'Empty fields use the script\'s "strategy" line (shown greyed). Orders fill at the next candle\'s open (plus slippage); if a candle touches both the stop and the target, the stop counts.'),
        h('div', {}, h('button', { class: 'btn ghost', onclick: () => { delete slot.cfg.strategyProps[tester.scriptId]; save(); runTester(); } }, 'Use script defaults'))));
    }
  }
  // equity curve and buy & hold, on the same money scale
  function drawEquity() {
    const cv = document.getElementById('ttCanvas'), r = tester.result;
    if (!cv || !r) return;
    const box = cv.parentElement, d = window.devicePixelRatio || 1, W = box.clientWidth - 16, H = box.clientHeight - 40; // room for the legend
    if (W < 20 || H < 20) return;
    cv.width = W * d; cv.height = H * d; cv.style.width = W + 'px'; cv.style.height = H + 'px';
    const ctx = cv.getContext('2d'), css = getComputedStyle(document.documentElement), col = (v) => css.getPropertyValue(v).trim();
    ctx.scale(d, d);
    const eq = r.equity, bars = (tester.slot || active).chart.raw, cap = r.options.capital, n = eq.length;
    if (!n) return;
    const bh = bars.map((b) => cap * (b.c / bars[0].o));
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < n; i++) { for (const v of [eq[i], bh[i]]) if (isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); } }
    if (!(hi > lo)) { hi = lo + 1; }
    const pad = (hi - lo) * 0.08, x = (i) => (i / Math.max(1, n - 1)) * (W - 4) + 2, y = (v) => H - 4 - ((v - lo + pad) / (hi - lo + 2 * pad)) * (H - 8);
    ctx.strokeStyle = col('--border'); ctx.setLineDash([3, 4]);
    ctx.beginPath(); ctx.moveTo(0, y(cap)); ctx.lineTo(W, y(cap)); ctx.stroke(); ctx.setLineDash([]);
    const path = (arr, color, width, dash) => { ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dash || []); ctx.beginPath(); let on = false; arr.forEach((v, i) => { if (!isFinite(v)) return; on ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v)); on = true; }); ctx.stroke(); ctx.setLineDash([]); };
    path(bh, col('--muted'), 1, [4, 3]);
    // the area under the equity curve, green above the starting capital and red below
    ctx.save();
    ctx.beginPath(); eq.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v)))); ctx.lineTo(x(n - 1), y(cap)); ctx.lineTo(x(0), y(cap)); ctx.closePath();
    ctx.clip();
    ctx.fillStyle = col('--up'); ctx.globalAlpha = 0.15; ctx.fillRect(0, 0, W, y(cap));
    ctx.fillStyle = col('--down'); ctx.fillRect(0, y(cap), W, H);
    ctx.restore();
    path(eq, col('--accent'), 1.8);
  }
  new ResizeObserver(() => { if (state.tester.open && state.tester.tab === 'overview') drawEquity(); }).observe(document.getElementById('tester'));

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
      logAlert(ev.message, state.alerts.find((x) => x.id === ev.alertId) || null, ev.id, ev.t);
      if (ev.expired) { toast(ev.message, 'info', 5000); return; }
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
    for (const ev of d.events || []) logAlert(ev.message, state.alerts.find((x) => x.id === ev.alertId) || null, ev.id, ev.t); // fired while this tab was closed
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
      const [whRow, whUrl] = field('whUrl', 'URL', st.webhook.url, 'https://example.com/hook');
      const [dcRow, dcUrl] = field('dcUrl', 'Webhook URL', (st.discord || {}).url || '', 'https://discord.com/api/webhooks/…');
      const [slRow, slUrl] = field('slUrl', 'Webhook URL', (st.slack || {}).url || '', 'https://hooks.slack.com/services/…');
      const section = (title, hint, ...rows) => h('fieldset', { class: 'srv-sec' }, h('legend', {}, title), h('p', { class: 'muted' }, hint), ...rows);
      body.append(
        h('p', { class: 'srv-ok' }, '● Connected. Alerts on live symbols run on the server even with the browser closed.'),
        section('Phone push: ntfy', 'Free, no account. Install the ntfy app (Android, iPhone) or open ntfy.sh, and subscribe to the same topic. Anyone who knows the topic name can read it, so use something hard to guess.', ntfyRow, ntfySrvRow),
        section('Telegram', 'Create a bot with @BotFather to get its token, send your bot a message, then get your chat ID (e.g. from @userinfobot).', tgTokRow, tgChatRow),
        section('Discord', 'In a Discord channel: Edit channel → Integrations → Webhooks → New webhook → Copy webhook URL.', dcRow),
        section('Slack', 'Create a Slack app with an incoming webhook for a channel (api.slack.com/messaging/webhooks) and paste its URL.', slRow),
        section('Other webhook', 'Any URL that accepts a JSON POST ({ title, message, source, time }). Discord and Slack URLs work here too.', whRow),
        resultBox,
        h('div', { class: 'menu-label' }, 'Recently fired'), evBox);
      const renderEvents = () => {
        evBox.innerHTML = '';
        if (!srv.events.length) evBox.appendChild(h('p', { class: 'muted' }, 'Nothing yet.'));
        for (const ev of srv.events.slice(0, 12)) evBox.appendChild(h('div', { class: 'srv-ev' }, h('span', { class: 'muted' }, new Date(ev.t).toLocaleString()), ev.message.replace(/^🔔 /, '')));
      };
      renderEvents();
      const payload = () => ({ ntfy: { topic: ntfyTopic.value.trim(), server: ntfyServer.value.trim() || 'https://ntfy.sh' }, telegram: { token: tgToken.value.trim(), chatId: tgChat.value.trim() }, webhook: { url: whUrl.value.trim() }, discord: { url: dcUrl.value.trim() }, slack: { url: slUrl.value.trim() } });
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
    for (const a of state.alerts) if (AL.isBar(a) && a.active && !servedByServer(a) && !isDemo(a.symbol) && !a.symbol.startsWith('CSV:')) want.add(feedKey(a));
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

  const alertsFor = (symbol, tf) => state.alerts.filter((a) => AL.isBar(a) && a.active && !servedByServer(a) && a.symbol === symbol && a.tf === tf);

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
    if (!prime) { const g = AL.gate(a); if (g === 'expired') { alertExpired(a); return; } if (g === 'off') return; }
    const cond = AL.isCond(a);
    const res = cond ? AL.evaluateCondition(a, bars, prime, resolveDef, IND.defaults) : AL.evaluateMarker(a, scriptDefs.get(a.scriptId), bars, prime, IND.defaults);
    if (res.type === 'pause') return pauseAlert(a, res.reason);
    if (a.paused) { delete a.paused; save(); refreshAlerts(); }
    if (res.type === 'prime') { a.lastBarT = res.t; save(); return; }
    if (res.type !== 'fire') return;
    const msg = cond ? AL.applyCondFire(a, res) : AL.applyMarkerFire(a, res);
    logAlert(msg, a);
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
      if (!AL.isBar(a) || !a.active) continue;
      const f = markerFeeds.get(feedKey(a));
      const bars = f && f.ready ? f.bars : (slots.find((s) => s.symbol === a.symbol && s.tf === a.tf) || {}).chart?.raw;
      if (AL.isMarker(a) && !scriptDefs.get(a.scriptId)) pauseAlert(a, 'The script was deleted');
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
    if (info.alert) {
      const a = info.alert;
      menu.appendChild(h('div', { class: 'ctx-label' }, alertTitle(a)));
      item('Edit alert…', () => editAlertDialog(a));
      item('Remove alert', () => deleteAlert(a), 'danger');
      menu.appendChild(h('div', { class: 'ctx-sep' }));
    }
    if (info.tradeLine) {
      const l = info.tradeLine, acc = paperAccFor(slot);
      menu.appendChild(h('div', { class: 'ctx-label' }, l.label));
      if (l.kind === 'pos') {
        item('Close position', () => paperClose(acc, slot.symbol), 'danger');
        item('Take profit / stop loss…', () => editBrackets(slot, slot.symbol, acc));
      } else if (l.kind === 'order') item('Cancel order', () => paperCancel(acc, l.id), 'danger');
      else item(l.kind === 'sl' || l.kind === 'osl' ? 'Remove stop loss' : 'Remove take profit', () => paperRemoveBracket(slot, l), 'danger');
      if (l.drag) menu.appendChild(h('div', { class: 'ctx-label muted' }, 'Drag the line to move it'));
      menu.appendChild(h('div', { class: 'ctx-sep' }));
    }
    if (info.drawing) {
      item('Delete drawing', () => chart.deleteSelected(), 'danger');
      menu.appendChild(h('div', { class: 'ctx-sep' }));
    }
    if (info.price != null) {
      const p = chart.fmtPrice(info.price);
      item(`Add alert at ${p}`, () => addAlert(slot.symbol, +p));
      if (!slot.symbol.startsWith('CSV:')) {
        // buy below the price = limit, above = stop (and the reverse for selling)
        const last = paperPrice(paperAccFor(slot), slot.symbol) ?? chart.raw[chart.raw.length - 1]?.c;
        if (last) {
          const bt = +p < last ? 'limit' : 'stop', st = +p > last ? 'limit' : 'stop';
          item(`Buy ${bt} at ${p}…`, () => openOrderTicket(slot, { side: 'buy', type: bt, price: +p }));
          item(`Sell ${st} at ${p}…`, () => openOrderTicket(slot, { side: 'sell', type: st, price: +p }));
        }
      }
      item(`Horizontal line at ${p}`, () => {
        const d = { id: Math.random().toString(36).slice(2), type: 'hline', pts: [{ t: chart.bars[chart.bars.length - 1]?.t || 0, p: +p }], width: 1.5 };
        chart.drawings.push(d);
        chart.select(d);
        chart.onDrawingsChange();
      });
      menu.appendChild(h('div', { class: 'ctx-sep' }));
    }
    item('Reset chart view', () => chart.resetView());
    item('Chart settings… (colors, background)', openChartSettings);
    item('Keyboard shortcuts (?)', openShortcuts);
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
    if ((e.ctrlKey || e.metaKey) && !typing && !modalOpen()) {
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); undoRedo(-1); return; }
      if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); undoRedo(1); return; }
    }
    if (e.key === 'ArrowRight' && e.shiftKey && !typing && !modalOpen() && active.replay) { e.preventDefault(); active.pauseReplay(); active.replayStep(); return; }
    if (e.key === 'Escape' && active && active.chart.cancelPick()) { updateHeader(); return; }
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
      // Alt+1…9 focuses a chart in the layout
      const n = /^Digit([1-9])$/.exec(e.code);
      if (n && slots[+n[1] - 1]) { setActive(slots[+n[1] - 1]); e.preventDefault(); }
      return;
    }
    if (e.ctrlKey || e.metaKey) return;
    if (e.key === '/') { e.preventDefault(); openIndicatorPicker(); return; }
    if (e.key === '?') { e.preventDefault(); openShortcuts(); return; }
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
  $('#alertLogBtn').addEventListener('click', openAlertLog);
  $('#charts').appendChild(h('div', { id: 'dividers', class: 'dividers' }));
  new ResizeObserver(() => positionDividers()).observe($('#charts'));
  applyLayout(state.layout);
  setActiveTool('cursor');
  renderWatchlist();
  refreshAlerts();
  updateHeader();
  paperSymsKey = paperSyms().sort().join(',');
  startTickers();
  syncMarkerFeeds();
  probeServer();
  if (state.tester.open) openTester();
  else if (state.paper.open) openTrading();
  refreshTradeLines();
  buildRangeBar();
  renderObjTree();
  updateUndoButtons();
  setTimeout(checkForUpdate, 4000);
  setInterval(checkForUpdate, 6 * 3600e3);
  if (!PREVIEW) MD.loadBStocks().then(() => {
    for (const sl of slots) if (MD.isBStock(sl.symbol)) { sl.chart.title = sl.title(); sl.chart._legendIdx = -2; sl.chart._updateLegendValues(); }
    renderWatchlist(); updateHeader(); refreshAlerts();
  }).catch(() => { /* offline: bStocks just show as Binance pairs */ });

  // handy for the devtools console
  window.candela = { markerFeeds, evaluateMarkerAlert, state, get slots() { return slots; }, get active() { return active; }, get chart() { return active.chart; }, applyLayout };
})();
