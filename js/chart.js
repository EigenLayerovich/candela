/* Candela — canvas chart engine.
 * Panes, price/time axes, candles/bars/line/area/Heikin Ashi, indicator rendering,
 * crosshair, pan/zoom, pane resizing, drawing tools and alert lines. */
(function () {
  'use strict';

  const THEMES = {
    dark: {
      bg: '#0F1218', grid: 'rgba(120,130,150,0.09)', text: '#9AA3B2', textStrong: '#E3E7EE', border: '#232937',
      cross: 'rgba(170,180,200,0.55)', crossLabel: '#2B3242', up: '#22AB94', down: '#F7525F',
      line: '#3D8BFD', area: 'rgba(61,139,253,0.25)', drawing: '#3D8BFD', handleFill: '#0F1218',
      alert: '#F5A623', level: 'rgba(154,163,178,0.45)', band: 'rgba(156,106,222,0.07)',
    },
    light: {
      bg: '#FFFFFF', grid: 'rgba(30,40,60,0.07)', text: '#5D6675', textStrong: '#131722', border: '#DDE1E8',
      cross: 'rgba(60,70,90,0.5)', crossLabel: '#3B4252', up: '#159A82', down: '#E5404D',
      line: '#2563EB', area: 'rgba(37,99,235,0.18)', drawing: '#2563EB', handleFill: '#FFFFFF',
      alert: '#E08A00', level: 'rgba(93,102,117,0.45)', band: 'rgba(124,77,210,0.07)',
    },
  };

  const DRAW = () => window.CandelaDrawings; // drawing tools (drawings.js)
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  const pad2 = (n) => String(n).padStart(2, '0');

  // ---- time zone for the time axis and dates: 'local' (this computer), 'UTC', or a place ("America/New_York")
  let TZ = 'local';
  const tzCache = new Map();
  let tzFmt = null;
  // milliseconds to add to a UTC time to get the wall-clock time in the chosen zone (cached per hour)
  function tzOffset(t) {
    if (TZ === 'UTC') return 0;
    if (TZ === 'local') return -new Date(t).getTimezoneOffset() * 60e3;
    const hour = Math.floor(t / 3600e3);
    let v = tzCache.get(hour);
    if (v === undefined) {
      const parts = {};
      for (const x of tzFmt.formatToParts(new Date(hour * 3600e3))) parts[x.type] = x.value;
      const wall = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second);
      v = wall - hour * 3600e3;
      if (tzCache.size > 20000) tzCache.clear();
      tzCache.set(hour, v);
    }
    return v;
  }
  function setTimeZone(tz) {
    try {
      if (tz && tz !== 'local' && tz !== 'UTC') tzFmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
      TZ = tz || 'local';
    } catch (e) { TZ = 'local'; }
    tzCache.clear();
  }
  // a Date whose UTC fields read as the wall-clock time in the chosen zone
  const zd = (t) => new Date(t + tzOffset(t));

  // ---- appearance settings for every chart (Chart settings): colors, grid, lines, watermark
  let LOOK = {};
  const setLook = (o) => { LOOK = { ...(o || {}) }; };
  const uid = () => Math.random().toString(36).slice(2, 10);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  function decimalsFor(price) {
    if (!isFinite(price) || price <= 0) return 2;
    return clamp(4 - Math.floor(Math.log10(price)), 2, 8);
  }
  function fmtCompact(v) {
    if (!isFinite(v)) return '—';
    const a = Math.abs(v);
    if (a >= 1e9) return (v / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return (v / 1e6).toFixed(2) + 'M';
    if (a >= 1e4) return (v / 1e3).toFixed(2) + 'K';
    return a >= 100 ? v.toFixed(0) : v.toFixed(2);
  }
  function withAlpha(color, a) {
    if (color.startsWith('#')) {
      let h = color.slice(1);
      if (h.length === 3) h = h.split('').map((c) => c + c).join('');
      const n = parseInt(h.slice(0, 6), 16);
      return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
    }
    return color;
  }
  function distToSeg(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1, len = dx * dx + dy * dy;
    let t = len ? ((px - x1) * dx + (py - y1) * dy) / len : 0;
    t = clamp(t, 0, 1);
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
  }
  // line thickness grades 1-4 (grade 1 is the default thin line) and line types
  const LINE_WIDTHS = { 1: 1.25, 2: 2, 3: 3, 4: 4 };
  const LINE_TYPES = ['line', 'linebr', 'step', 'stepbr', 'stepdia'];

  // Indicator values computed on another timeframe's candles, placed on the chart's bars: each chart bar
  // shows the value of the latest of those candles that started before the chart bar ended. So a daily SMA
  // on a 4H chart steps once a day, and on a weekly chart each week shows the SMA as of its last day.
  function mapToBars(chartBars, srcBars, srcOut) {
    const n = chartBars.length, idx = new Int32Array(n);
    let j = -1;
    for (let i = 0; i < n; i++) {
      const end = i + 1 < n ? chartBars[i + 1].t : Infinity;
      while (j + 1 < srcBars.length && srcBars[j + 1].t < end) j++;
      idx[i] = j;
    }
    const out = {};
    for (const [k, arr] of Object.entries(srcOut)) {
      if (!arr || typeof arr !== 'object' || arr.length !== srcBars.length) { out[k] = arr; continue; }
      const m = new Array(n);
      for (let i = 0; i < n; i++) m[i] = idx[i] >= 0 ? arr[idx[i]] : NaN;
      out[k] = m;
    }
    return out;
  }

  // ---- Renko, Kagi and Point & Figure: built from the closes, ignoring time. Each brick, Kagi line or P&F
  // column becomes one "bar" of the chart, stamped with the time it formed.
  const BRICK_TYPES = new Set(['renko', 'kagi', 'pnf']);
  function niceSize(v) {
    if (!(v > 0)) return 0;
    const e = Math.pow(10, Math.floor(Math.log10(v))), m = v / e;
    return (m < 1.5 ? 1 : m < 2.25 ? 2 : m < 3.5 ? 2.5 : m < 7.5 ? 5 : 10) * e;
  }
  // the "Auto" box size: the latest 14-bar Average True Range, rounded to a round number
  function atrSize(raw, len = 14) {
    const a = window.Indicators.fn.atr(raw, len);
    for (let i = a.length - 1; i >= 0; i--) if (isFinite(a[i]) && a[i] > 0) return niceSize(a[i]);
    return niceSize(raw.length ? raw[raw.length - 1].c * 0.01 : 1);
  }
  // Renko: a new brick each time the close moves a full box beyond the last brick (two boxes to reverse)
  function renko(raw, box) {
    const out = [];
    if (!raw.length || !(box > 0)) return out;
    let top = Math.round(raw[0].c / box) * box, bot = top, vol = 0;
    for (const b of raw) {
      vol += b.v || 0;
      for (let k = 0; k < 500; k++) {
        let o, c;
        if (b.c >= top + box - 1e-9 * box) { o = top; c = top + box; bot = top; top = c; }
        else if (b.c <= bot - box + 1e-9 * box) { o = bot; c = bot - box; top = bot; bot = c; }
        else break;
        out.push({ t: b.t + k, o, c, h: Math.max(o, c), l: Math.min(o, c), v: vol }); // (+k ms keeps times increasing)
        vol = 0;
      }
    }
    return out;
  }
  // Kagi: a line that keeps going while price continues, and turns when it reverses by the reversal amount.
  // Thick (yang) after it rises above the previous high, thin (yin) after it falls below the previous low.
  function kagi(raw, rev, isPct) {
    const out = [];
    if (!raw.length || !(rev > 0)) return out;
    const R = (price) => (isPct ? Math.abs(price) * rev : rev);
    const start = raw[0].c;
    let cur = null;
    for (const b of raw) {
      const c = b.c;
      if (!cur) {
        if (Math.abs(c - start) >= R(start)) { cur = { t: b.t, o: start, c, up: c > start, v: b.v || 0 }; out.push(cur); }
        continue;
      }
      if (cur.up ? c >= cur.c : c <= cur.c) cur.c = c;
      else if (cur.up ? c <= cur.c - R(cur.c) : c >= cur.c + R(cur.c)) { cur = { t: b.t, o: cur.c, c, up: !cur.up, v: 0 }; out.push(cur); }
      cur.v += b.v || 0;
    }
    let yang = out.length ? out[0].up : true, lastHigh = null, lastLow = null;
    return out.map((k) => {
      const s0 = yang;
      let sw = null;
      if (k.up && !yang && lastHigh !== null && k.c > lastHigh) { sw = lastHigh; yang = true; }
      if (!k.up && yang && lastLow !== null && k.c < lastLow) { sw = lastLow; yang = false; }
      if (k.up) lastHigh = k.c; else lastLow = k.c;
      return { t: k.t, o: k.o, c: k.c, h: Math.max(k.o, k.c), l: Math.min(k.o, k.c), v: k.v, kagi: { s0, sw, s1: yang } };
    });
  }
  // Point & Figure: columns of X (rising) and O (falling), one mark per box; a new column needs a move of
  // `rev` boxes the other way
  function pointFigure(raw, box, rev) {
    const out = [];
    if (!raw.length || !(box > 0)) return out;
    const fl = (v) => Math.floor(v / box + 1e-9) * box, ce = (v) => Math.ceil(v / box - 1e-9) * box;
    const p0 = fl(raw[0].c);
    let col = null;
    for (const b of raw) {
      const c = b.c;
      if (!col) {
        if (c >= p0 + box) col = { t: b.t, x: true, lo: p0, hi: fl(c), v: 0 };
        else if (c <= p0 - box) col = { t: b.t, x: false, lo: ce(c), hi: p0, v: 0 };
        if (col) out.push(col); else continue;
      } else if (col.x) {
        if (fl(c) > col.hi) col.hi = fl(c);
        else if (c <= col.hi - rev * box + 1e-9 * box) { col = { t: b.t, x: false, lo: ce(c), hi: col.hi - box, v: 0 }; out.push(col); }
      } else {
        if (ce(c) < col.lo) col.lo = ce(c);
        else if (c >= col.lo + rev * box - 1e-9 * box) { col = { t: b.t, x: true, lo: col.lo + box, hi: fl(c), v: 0 }; out.push(col); }
      }
      col.v += b.v || 0;
    }
    return out.map((k) => ({ t: k.t, o: k.x ? k.lo : k.hi, c: k.x ? k.hi : k.lo, h: k.hi + box / 2, l: k.lo - box / 2, v: k.v, pnf: { x: k.x, lo: k.lo, hi: k.hi, box } }));
  }

  function heikinAshi(bars) {
    const out = new Array(bars.length);
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i], c = (b.o + b.h + b.l + b.c) / 4;
      const o = i ? (out[i - 1].o + out[i - 1].c) / 2 : (b.o + b.c) / 2;
      out[i] = { t: b.t, o, c, h: Math.max(b.h, o, c), l: Math.min(b.l, o, c), v: b.v };
    }
    return out;
  }

  class Chart {
    constructor(el) {
      this.el = el;
      this.canvas = document.createElement('canvas');
      this.canvas.className = 'chart-canvas';
      this.ctx = this.canvas.getContext('2d');
      this.legendLayer = document.createElement('div');
      this.legendLayer.className = 'legend-layer';
      el.appendChild(this.canvas);
      el.appendChild(this.legendLayer);

      this.themeName = 'dark';
      this.theme = THEMES.dark;
      this.bars = [];
      this.ha = null;
      this.interval = 3600e3;
      this.tfKey = null;      // the chart's timeframe ("1h"), set by the app
      this.tfSources = {};    // candles of other timeframes for indicators that use one: tf -> { bars, error }
      this.decimals = 2;
      this.spacing = 8;
      this.rightOffset = 6;
      this.chartType = 'candles';
      this.raw = [];          // the real candles; this.bars is what's shown (the same, or Renko/Kagi/P&F built from them)
      this.rawInterval = 3600e3;
      this.brickOpts = {};    // { renko: { mode: 'atr'|'fixed', size }, kagi: { mode: 'atr'|'pct'|'fixed', value }, pnf: { mode, size, rev } }
      this.brickInfo = '';    // e.g. "Renko · box 250", shown after the title
      this.trades = null;     // strategy trades to mark on the chart (Strategy Tester)
      this.picking = null;    // a function waiting for a click on the chart (Bar Replay: pick the start)
      this.title = '';
      this.info = ''; // a line under the title (funding rate, open interest… on futures)
      this.live = false;
      this.panes = [this._pane('main', 3)];
      this.indicators = [];
      this.compares = [];        // comparison overlays: { id, symbol, color, values (aligned to bars), visible }
      this.percentMode = false;  // percent price scale (always on while comparing)
      this._base = null;         // { i, v }: the bar the percent scale is measured from
      this.drawings = [];
      this.alerts = [];
      this.tool = 'cursor';
      this.magnet = false;
      this.drawingsHidden = false;
      this.selected = null;
      this.creating = null;
      this.drag = null;
      this.hover = null;
      this.axisW = 74;
      this.timeH = 28;
      this.message = 'Loading…';

      // callbacks set by the app
      this.onDrawingsChange = () => {};
      this.onSelect = () => {};
      this.onToolDone = () => {};
      this.onNeedHistory = null;
      this.onContextMenu = () => {};
      this.onLegendAction = () => {};
      this.onCompareAction = () => {};
      this.onLayoutChange = () => {};
      this.askText = (v) => window.prompt('Text:', v);
      this.onCrosshairMove = null; // (time | null) => void, for syncing other charts
      this.onViewChange = null;    // () => void, fired when the user pans or zooms
      this.syncTime = null;        // crosshair time pushed in from another chart

      this._dirty = true;
      this._legendIdx = -2;
      this._bind();
      this._ro = new ResizeObserver(() => this.resize());
      this._ro.observe(el);
      this.resize();
      const loop = () => {
        if (this._dead) return;
        if (this._dirty) { this._dirty = false; try { this._render(); } catch (e) { console.error(e); } }
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    }

    // ------------------------------------------------------------------ setup
    _pane(id, weight) { return { id, weight, auto: true, log: false, min: 0, max: 1, top: 0, h: 0, legendEl: null }; }
    get main() { return this.panes[0]; }
    get plotW() { return this.W - this.axisW; }
    get lastIndex() { return this.bars.length - 1; }
    invalidate() { this._dirty = true; }

    destroy() {
      this._dead = true;
      this._ro.disconnect();
      this.el.innerHTML = '';
    }

    // ------------------------------------------------------------------ multi-chart sync
    setSyncTime(t) {
      if (this.syncTime === t) return;
      this.syncTime = t;
      this._legendIdx = -2;
      this._updateLegendValues();
      this.invalidate();
    }

    _syncIdx() {
      // bar that contains time t (works across different timeframes)
      return Math.floor(this.timeToIndex(this.syncTime) + 1e-6);
    }

    _emitCrosshair(x) {
      if (!this.onCrosshairMove) return;
      const t = x == null || !this.bars.length ? null : this.indexToTime(Math.round(this.idxAt(x)));
      if (t === this._lastEmitT) return;
      this._lastEmitT = t;
      this.onCrosshairMove(t);
    }

    _viewChanged() { if (this.onViewChange) this.onViewChange(); }

    getTimeView() {
      return { tRight: this.indexToTime(this.idxAt(this.plotW)), msPerPx: this.interval / this.spacing };
    }

    setTimeView({ tRight, msPerPx }) {
      if (!this.bars.length || !isFinite(tRight) || !(msPerPx > 0)) return;
      this.spacing = clamp(this.interval / msPerPx, 1, 80);
      this.rightOffset = this.timeToIndex(tRight) - this.lastIndex - 0.5;
      this._clampView();
      this._checkHistory();
      this._legendIdx = -2;
      this._updateLegendValues();
      this.invalidate();
    }

    setTheme(name) {
      this.themeName = name;
      const base = THEMES[name] || THEMES.dark, o = {};
      for (const k of ['up', 'down', 'bg', 'grid', 'cross']) if (LOOK[k]) o[k] = LOOK[k];
      this.theme = { ...base, ...o };
      this.invalidate();
    }

    resize() {
      const r = this.el.getBoundingClientRect(), d = window.devicePixelRatio || 1;
      this.W = Math.max(120, r.width);
      this.H = Math.max(120, r.height);
      this.canvas.width = Math.round(this.W * d);
      this.canvas.height = Math.round(this.H * d);
      this.canvas.style.width = this.W + 'px';
      this.canvas.style.height = this.H + 'px';
      this._layout();
      this.invalidate();
    }

    _layout() {
      const avail = this.H - this.timeH, total = this.panes.reduce((s, p) => s + p.weight, 0);
      let y = 0;
      for (const p of this.panes) {
        p.top = Math.round(y);
        y += (avail * p.weight) / total;
        p.h = Math.round(y) - p.top;
        if (p.legendEl) {
          p.legendEl.style.top = p.top + 6 + 'px';
          p.legendEl.style.maxHeight = Math.max(0, p.h - 8) + 'px'; // small charts: never spill into the next pane
        }
      }
    }

    // ------------------------------------------------------------------ data
    // build what's shown from the real candles (Renko, Kagi, P&F), or show them as they are
    _rebuild() {
      const t = this.chartType, raw = this.raw;
      if (!BRICK_TYPES.has(t)) { this.bars = raw; this.interval = this.rawInterval; this.brickInfo = ''; return; }
      const o = this.brickOpts[t] || {}, fmt = (v) => String(+(+v).toPrecision(6)); // 500, 0.25, 0.0005
      let out;
      if (t === 'renko') {
        const box = o.mode === 'fixed' && o.size > 0 ? o.size : atrSize(raw);
        out = renko(raw, box);
        this.brickSize = box;
        this.brickInfo = `Renko · box ${fmt(box)}${o.mode === 'fixed' ? '' : ' (ATR 14)'}`;
      } else if (t === 'kagi') {
        const pct = o.mode === 'pct', rev = o.mode === 'fixed' && o.value > 0 ? o.value : pct ? (o.value > 0 ? o.value : 1) / 100 : atrSize(raw);
        out = kagi(raw, rev, pct);
        this.brickSize = pct ? null : rev;
        this.brickInfo = `Kagi · reversal ${pct ? (rev * 100).toFixed(2).replace(/\.?0+$/, '') + '%' : fmt(rev) + (o.mode === 'fixed' ? '' : ' (ATR 14)')}`;
      } else {
        const box = o.mode === 'fixed' && o.size > 0 ? o.size : atrSize(raw), rev = Math.max(1, Math.round(o.rev || 3));
        out = pointFigure(raw, box, rev);
        this.brickSize = box;
        this.brickInfo = `Point & Figure · box ${fmt(box)}${o.mode === 'fixed' ? '' : ' (ATR 14)'} · reversal ${rev}`;
      }
      this.bars = out;
      // the average time a brick takes, for the time axis and for drawing beyond the last brick
      this.interval = out.length > 1 ? Math.max(this.rawInterval, (out[out.length - 1].t - out[0].t) / (out.length - 1)) : this.rawInterval;
    }
    get isBrick() { return BRICK_TYPES.has(this.chartType); }

    setData(bars, interval, { resetView = false, decimals } = {}) {
      this.raw = bars;
      this.rawInterval = interval;
      this.decimals = decimals ?? decimalsFor(bars.length ? bars[bars.length - 1].c : 1);
      this._rebuild();
      if (resetView) {
        this.spacing = 8;
        this.rightOffset = 6;
        for (const p of this.panes) p.auto = true;
        this._fitBricks();
      }
      this.message = bars.length ? '' : this.message;
      this.recalc();
    }

    prependBars(older) {
      const first = this.raw.length ? this.raw[0].t : Infinity;
      const add = older.filter((b) => b.t < first);
      if (!add.length) return 0;
      this.raw = add.concat(this.raw); // view is anchored to the right, so nothing moves
      this._rebuild();
      this.recalc();
      return add.length;
    }

    updateBar(bar) {
      const R = this.raw, n = R.length, shown = this.bars.length;
      if (n && R[n - 1].t === bar.t) R[n - 1] = bar;
      else if (!n || bar.t > R[n - 1].t) R.push(bar);
      else {
        // a correction to a recent bar (polled sources resend the last few bars with final values)
        let i = n - 2;
        while (i >= 0 && i >= n - 10 && R[i].t > bar.t) i--;
        if (i < 0 || R[i].t !== bar.t) return;
        const old = R[i];
        if (old.o === bar.o && old.h === bar.h && old.l === bar.l && old.c === bar.c && old.v === bar.v) return;
        R[i] = bar;
      }
      if (this.isBrick) this._rebuild();
      // when the user is looking at history, keep their view still
      if (this.bars.length > shown && this.rightOffset < -1) this.rightOffset -= this.bars.length - shown;
      this.recalc();
    }

    setChartType(t) { this.chartType = t; this._rebuild(); this._fitBricks(); this._clampView(); this.recalc(); }
    setBrickOptions(o) { this.brickOpts = JSON.parse(JSON.stringify(o || {})); if (this.isBrick) { this._rebuild(); this._fitBricks(); this._clampView(); this.recalc(); } }
    // few bricks or columns: zoom in so they fill the chart
    _fitBricks() {
      const n = this.bars.length;
      if (!this.isBrick || !n || n * this.spacing >= this.plotW * 0.7) return;
      this.spacing = clamp((this.plotW * 0.85) / (n + 4), 1, 24);
      this.rightOffset = 3;
    }

    recalc() {
      this.ha = this.chartType === 'heikin' ? heikinAshi(this.bars) : null;
      for (const ind of this.indicators) {
        this._calc(ind);
      }
      this._legendIdx = -2;
      this._updateLegendValues();
      this.invalidate();
    }

    _dispBars() { return this.ha || this.bars; }

    // ------------------------------------------------------------------ indicators
    addIndicator(def, params = {}, opts = {}) {
      const ind = {
        id: opts.id || uid(), def,
        params: { ...window.Indicators.defaults(def), ...params },
        colors: { ...(opts.colors || {}) }, visible: opts.visible !== false, out: {},
        tf: opts.tf || null, // compute on another timeframe's candles (e.g. a daily SMA on a 4H chart)
        styles: { ...(opts.styles || {}) }, // per line: { width: 1-4, type: 'line'|'linebr'|'step'|'stepbr'|'stepdia', priceLine }
      };
      if (def.overlay) ind.pane = this.main;
      else {
        ind.pane = this._pane(ind.id, opts.weight || 1);
        this.panes.push(ind.pane);
      }
      this.indicators.push(ind);
      this._calc(ind);
      this._layout();
      this._buildLegends();
      this.invalidate();
      return ind;
    }

    removeIndicator(id) {
      const ind = this.indicators.find((i) => i.id === id);
      if (!ind) return;
      this.indicators = this.indicators.filter((i) => i !== ind);
      if (ind.pane !== this.main) this.panes = this.panes.filter((p) => p !== ind.pane);
      this._layout();
      this._buildLegends();
      this.invalidate();
    }

    updateIndicator(id, params, colors, styles) {
      const ind = this.indicators.find((i) => i.id === id);
      if (!ind) return;
      if (params) ind.params = { ...ind.params, ...params };
      if (colors) ind.colors = { ...colors };
      if (styles) ind.styles = JSON.parse(JSON.stringify(styles));
      this._calc(ind);
      this._buildLegends();
      this.invalidate();
    }

    // the timeframe an indicator is computed on, when it isn't the chart's own
    indicatorTf(ind) { return ind.tf && ind.tf !== this.tfKey ? ind.tf : null; }
    neededTfs() { return [...new Set(this.indicators.map((i) => this.indicatorTf(i)).filter(Boolean))]; }

    setIndicatorTf(id, tf) {
      const ind = this.indicators.find((i) => i.id === id);
      if (!ind) return;
      ind.tf = tf || null;
      this._calc(ind);
      this._buildLegends();
      this.invalidate();
    }

    // candles for indicators on timeframe tf (bars = null while loading, or with an error message)
    setTfSource(tf, bars, error = null) {
      const had = this.tfSources[tf];
      this.tfSources[tf] = { bars, error };
      let rebuild = !had || !!had.error !== !!error;
      for (const ind of this.indicators) if (this.indicatorTf(ind) === tf) this._calc(ind);
      if (rebuild) this._buildLegends();
      this._legendIdx = -2;
      this._updateLegendValues();
      this.invalidate();
    }
    clearTfSources() { this.tfSources = {}; }

    _calc(ind) {
      try {
        const tf = this.indicatorTf(ind);
        if (tf) {
          const src = this.tfSources[tf];
          ind.out = {};
          ind.error = src && src.error ? src.error : null;
          if (src && src.bars && src.bars.length) ind.out = mapToBars(this.bars, src.bars, ind.def.calc(src.bars, ind.params) || {});
          return;
        }
        ind.out = ind.def.calc(this.bars, ind.params) || {};
        ind.error = null;
      } catch (e) {
        ind.out = {};
        // script errors carry a line number; built-in indicator failures are bugs, so log them
        ind.error = e.line ? `line ${e.line}: ${e.message}` : e.message || String(e);
        if (!e.line) console.error(ind.def.id, e);
      }
    }

    // swap in a new definition (e.g. an edited script) for every indicator using defId, keeping matching inputs
    replaceDef(defId, def) {
      let n = 0;
      for (const ind of this.indicators) {
        if (ind.def.id !== defId) continue;
        const d = window.Indicators.defaults(def), params = {};
        for (const k of Object.keys(d)) params[k] = k in ind.params ? ind.params[k] : d[k];
        const keep = new Set(def.plots.map((pl) => pl.key).concat((def.fills || []).map((f) => f.key), ['band']));
        for (const k of Object.keys(ind.colors)) if (!keep.has(k.split('.')[0])) delete ind.colors[k];
        ind.def = def;
        ind.params = params;
        this._calc(ind);
        n++;
      }
      if (n) { this._buildLegends(); this.invalidate(); }
      return n;
    }

    toggleIndicator(id) {
      const ind = this.indicators.find((i) => i.id === id);
      if (!ind) return;
      ind.visible = !ind.visible;
      this._buildLegends();
      this.invalidate();
    }

    movePane(id, dir) {
      const i = this.panes.findIndex((p) => p.id === id), j = i + dir;
      if (i < 1 || j < 1 || j >= this.panes.length) return;
      [this.panes[i], this.panes[j]] = [this.panes[j], this.panes[i]];
      this._layout();
      this.invalidate();
      this.onLayoutChange();
    }

    setInfo(text) {
      this.info = text || '';
      const el = this.main.legendEl && this.main.legendEl.querySelector('.lg-info');
      if (el) el.textContent = this.info;
    }

    indicatorLabel(ind) {
      const vals = ind.def.inputs.map((inp) => ind.params[inp.key]).filter((v) => v !== 'close');
      const tf = ind.tf ? ' · ' + ind.tf.replace(/h$/, 'H').replace(/d$/, 'D').replace(/w$/, 'W') : '';
      return ind.def.short + (vals.length ? ' ' + vals.join(' ') : '') + tf;
    }

    plotColor(ind, pl) { return ind.colors[pl.key] || pl.color || (pl.palette && pl.palette[0]) || '#888'; }

    // thickness (grades 1-4), line type and price line of one line of an indicator
    plotStyle(ind, pl) {
      const st = (ind.styles && ind.styles[pl.key]) || {};
      return { width: LINE_WIDTHS[st.width] || pl.width || 1.25, grade: st.width || null, type: LINE_TYPES.includes(st.type) ? st.type : pl.lineType || 'line', priceLine: !!st.priceLine };
    }

    // ------------------------------------------------------------------ comparison overlays
    addCompare(c) {
      this.compares.push({ visible: true, values: [], ...c });
      this._buildLegends();
      this.invalidate();
    }

    updateCompare(id, patch) {
      const c = this.compares.find((x) => x.id === id);
      if (!c) return;
      Object.assign(c, patch);
      if (Object.keys(patch).some((k) => k !== 'values')) this._buildLegends();
      else { this._legendIdx = -2; this._updateLegendValues(); }
      this.invalidate();
    }

    removeCompare(id) {
      this.compares = this.compares.filter((c) => c.id !== id);
      this._buildLegends();
      this.invalidate();
    }

    clearCompares() {
      if (!this.compares.length) return;
      this.compares = [];
      this._buildLegends();
      this.invalidate();
    }

    pctActive() { return this.percentMode || this.compares.some((c) => c.visible); }

    // Percent scale is measured from the first visible bar; each compared symbol from its own value there.
    _computeBase(a, b) {
      this._base = null;
      if (!this.pctActive() || !this.bars.length) return;
      const i0 = clamp(a, 0, this.bars.length - 1);
      this._base = { i: i0, v: this.bars[i0].c };
      for (const c of this.compares) {
        c._base = NaN;
        for (let i = i0; i <= b; i++) if (c.values[i] > 0) { c._base = c.values[i]; break; }
      }
    }
    _pct(v) { return (v / this._base.v - 1) * 100; }
    _fmtPct(v, dec = 2) { const q = this._pct(v); return (q >= 0 ? '+' : '') + q.toFixed(dec) + '%'; }
    _cmpY(c, i) { return this._base.v * (c.values[i] / c._base); } // compare value expressed in main-price units

    _drawCompares(p, a, b) {
      const ctx = this.ctx, lo = Math.max(0, a - 1), hi = Math.min(this.bars.length - 1, b + 1);
      ctx.lineWidth = 1.75;
      ctx.lineJoin = 'round';
      for (const c of this.compares) {
        if (!c.visible || !(c._base > 0)) continue;
        ctx.strokeStyle = c.color;
        ctx.beginPath();
        let pen = false;
        for (let i = lo; i <= hi; i++) {
          if (!(c.values[i] > 0)) { pen = false; continue; }
          const x = this.xAt(i), y = this.yOf(p, this._cmpY(c, i));
          if (pen) ctx.lineTo(x, y); else { ctx.moveTo(x, y); pen = true; }
        }
        ctx.stroke();
      }
      ctx.lineWidth = 1;
    }

    // ------------------------------------------------------------------ legends (DOM)
    _buildLegends() {
      this.legendLayer.innerHTML = '';
      for (const p of this.panes) {
        const el = document.createElement('div');
        el.className = 'legend';
        el.style.top = p.top + 6 + 'px';
        if (p === this.main) {
          const head = document.createElement('div');
          head.className = 'lg-head';
          head.innerHTML = '<span class="lg-title"></span><span class="lg-ohlc"></span>';
          el.appendChild(head);
          const info = document.createElement('div');
          info.className = 'lg-info';
          info.textContent = this.info;
          el.appendChild(info);
          for (const c of this.compares) {
            const row = document.createElement('div');
            row.className = 'lg-row cmp' + (c.visible ? '' : ' off');
            row.dataset.id = c.id;
            row.dataset.kind = 'cmp';
            const name = document.createElement('span');
            name.className = 'lg-name';
            name.dataset.act = 'settings';
            name.innerHTML = `<i class="lg-swatch" style="background:${c.color}"></i>`;
            name.append(c.symbol);
            const vals = document.createElement('span');
            vals.className = 'lg-vals';
            const btns = document.createElement('span');
            btns.className = 'lg-btns';
            for (const [act, title, svg] of [
              ['toggle', c.visible ? 'Hide' : 'Show', c.visible ? '<svg viewBox="0 0 24 24"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>' : '<svg viewBox="0 0 24 24"><path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4M6.6 6.6A17 17 0 0 0 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/></svg>'],
              ['settings', 'Color', '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3" fill="currentColor"/></svg>'],
              ['remove', 'Remove comparison', '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>'],
            ]) {
              const bt = document.createElement('button');
              bt.dataset.act = act; bt.title = title; bt.innerHTML = svg;
              btns.appendChild(bt);
            }
            row.append(name, vals, btns);
            el.appendChild(row);
          }
        }
        for (const ind of this.indicators.filter((i) => i.pane === p)) {
          const row = document.createElement('div');
          row.className = 'lg-row' + (ind.visible ? '' : ' off');
          row.dataset.id = ind.id;
          const name = document.createElement('span');
          name.className = 'lg-name';
          name.textContent = this.indicatorLabel(ind);
          name.dataset.act = 'settings';
          const vals = document.createElement('span');
          vals.className = 'lg-vals';
          const btns = document.createElement('span');
          btns.className = 'lg-btns';
          const mk = (act, title, svg) => {
            const b = document.createElement('button');
            b.dataset.act = act; b.title = title; b.innerHTML = svg;
            btns.appendChild(b);
          };
          mk('toggle', ind.visible ? 'Hide' : 'Show', ind.visible
            ? '<svg viewBox="0 0 24 24"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>'
            : '<svg viewBox="0 0 24 24"><path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4M6.6 6.6A17 17 0 0 0 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/></svg>');
          if (ind.def.plots.length) mk('alert', ind.def.plots.some((pl) => pl.style === 'mark') ? 'Alert when a marker appears' : 'Alert on this indicator (crossing a level or another line)', '<svg viewBox="0 0 24 24"><path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 20a2 2 0 0 0 4 0"/></svg>');
          mk('settings', 'Settings', '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>');
          if (p !== this.main) {
            mk('up', 'Move pane up', '<svg viewBox="0 0 24 24"><path d="M6 15l6-6 6 6"/></svg>');
            mk('down', 'Move pane down', '<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>');
          }
          mk('remove', 'Remove', '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>');
          row.append(name, vals, btns);
          el.appendChild(row);
        }
        p.legendEl = el;
        this.legendLayer.appendChild(el);
      }
      this._legendIdx = -2;
      this._updateLegendValues();
      if (!this._legendBound) {
        this._legendBound = true;
        this.legendLayer.addEventListener('click', (e) => {
          const actEl = e.target.closest('[data-act]'), row = e.target.closest('.lg-row');
          if (!actEl || !row) return;
          const act = actEl.dataset.act, id = row.dataset.id;
          if (row.dataset.kind === 'cmp') { this.onCompareAction(act, id); return; }
          if (act === 'up' || act === 'down') { const ind = this.indicators.find((i) => i.id === id); if (ind) this.movePane(ind.pane.id, act === 'up' ? -1 : 1); return; }
          this.onLegendAction(act, id);
        });
      }
    }

    _updateLegendValues() {
      const n = this.bars.length;
      let idx = n - 1;
      if (this.hover && this.hover.x < this.plotW) idx = clamp(Math.round(this.idxAt(this.hover.x)), 0, n - 1);
      else if (this.syncTime != null && n) idx = clamp(this._syncIdx(), 0, n - 1);
      if (idx === this._legendIdx) return;
      this._legendIdx = idx;
      const main = this.main.legendEl;
      if (!main) return;
      const titleEl = main.querySelector('.lg-title');
      if (titleEl) titleEl.textContent = this.title + (this.brickInfo ? ' · ' + this.brickInfo : '');
      const ohlc = main.querySelector('.lg-ohlc');
      const B = this._dispBars();
      if (ohlc) {
        if (idx >= 0 && B[idx]) {
          const b = B[idx], prev = idx ? B[idx - 1].c : b.o, ch = b.c - prev, cls = b.c >= b.o ? 'up' : 'down';
          const f = (v) => this.fmtPrice(v);
          ohlc.innerHTML = `<i>O</i><b class="${cls}">${f(b.o)}</b><i>H</i><b class="${cls}">${f(b.h)}</b><i>L</i><b class="${cls}">${f(b.l)}</b><i>C</i><b class="${cls}">${f(b.c)}</b>` +
            `<b class="${ch >= 0 ? 'up' : 'down'}">${ch >= 0 ? '+' : ''}${f(ch)} (${ch >= 0 ? '+' : ''}${((ch / prev) * 100).toFixed(2)}%)</b>`;
        } else ohlc.innerHTML = '';
      }
      for (const c of this.compares) {
        const row = this.legendLayer.querySelector(`.lg-row[data-id="${c.id}"] .lg-vals`);
        if (!row) continue;
        const v = c.values[idx];
        if (!c.visible || !(v > 0)) { row.innerHTML = c.visible ? '<b>∅</b>' : ''; continue; }
        let html = `<b style="color:${c.color}">${v.toFixed(decimalsFor(v))}</b>`;
        if (c._base > 0) { const q = (v / c._base - 1) * 100; html += `<b style="color:${c.color}">${q >= 0 ? '+' : ''}${q.toFixed(2)}%</b>`; }
        row.innerHTML = html;
      }
      for (const ind of this.indicators) {
        const row = this.legendLayer.querySelector(`.lg-row[data-id="${ind.id}"] .lg-vals`);
        if (!row) continue;
        if (ind.error) { row.innerHTML = ''; const e = document.createElement('b'); e.className = 'lg-err'; e.textContent = '⚠ ' + ind.error; row.appendChild(e); continue; }
        if (!ind.visible || idx < 0) { row.innerHTML = ''; continue; }
        let html = '';
        for (const pl of ind.def.plots) {
          const arr = ind.out[pl.key];
          if (!arr) continue;
          const v = arr[idx];
          let color = this.plotColor(ind, pl);
          if (pl.palette && ind.out[pl.key + '$i']) color = ind.colors[pl.key + '.' + ind.out[pl.key + '$i'][idx]] || pl.palette[ind.out[pl.key + '$i'][idx]] || color;
          else if (!ind.colors[pl.key] && ind.out[pl.key + '$c']) color = ind.out[pl.key + '$c'][idx] || color;
          if (pl.style === 'mark') { if (v) html += `<b style="color:${color}">${pl.text ? pl.text.replace(/[<&]/g, '') : '●'}</b>`; continue; }
          html += `<b style="color:${color}">${this._fmtPlot(ind, pl, v)}</b>`;
        }
        row.innerHTML = html;
      }
    }

    fmtPrice(v) { return isFinite(v) ? v.toFixed(this.decimals) : '—'; }
    _fmtMain(v) { return this._base ? this._fmtPct(v) : this.fmtPrice(v); }

    _fmtPlot(ind, pl, v) {
      if (!isFinite(v)) return '∅';
      if (pl.format === 'volume') return fmtCompact(v);
      if (ind.pane === this.main) return this.fmtPrice(v);
      const a = Math.abs(v);
      if (a >= 1e5) return fmtCompact(v);
      return v.toFixed(a >= 1 || a === 0 ? 2 : a >= 0.01 ? 4 : 6);
    }

    // ------------------------------------------------------------------ coordinates
    xAt(i) { return this.plotW - (this.lastIndex + this.rightOffset - i + 0.5) * this.spacing; }
    idxAt(x) { return this.lastIndex + this.rightOffset + 0.5 - (this.plotW - x) / this.spacing; }
    _f(p, v) { return p.log ? Math.log(Math.max(v, 1e-12)) : v; }
    _fi(p, f) { return p.log ? Math.exp(f) : f; }
    yOf(p, v) { const a = this._f(p, p.min), b = this._f(p, p.max); return p.top + ((b - this._f(p, v)) / (b - a)) * p.h; }
    vOf(p, y) { const a = this._f(p, p.min), b = this._f(p, p.max); return this._fi(p, b - ((y - p.top) / p.h) * (b - a)); }
    paneAt(y) { return this.panes.find((p) => y >= p.top && y < p.top + p.h) || null; }

    timeToIndex(t) {
      const B = this.bars, n = B.length;
      if (!n) return 0;
      if (t >= B[n - 1].t) return n - 1 + (t - B[n - 1].t) / this.interval;
      if (t <= B[0].t) return (t - B[0].t) / this.interval;
      let lo = 0, hi = n - 1;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (B[m].t <= t) lo = m; else hi = m; }
      return lo + (t - B[lo].t) / (B[hi].t - B[lo].t);
    }
    indexToTime(i) {
      const B = this.bars, n = B.length;
      if (!n) return 0;
      if (i >= n - 1) return B[n - 1].t + (i - (n - 1)) * this.interval;
      if (i <= 0) return B[0].t + i * this.interval;
      const lo = Math.floor(i);
      return B[lo].t + (i - lo) * (B[lo + 1].t - B[lo].t);
    }
    _pt(pt) { return { x: this.xAt(this.timeToIndex(pt.t)), y: this.yOf(this.main, pt.p) }; }

    _clampView() {
      const n = this.bars.length, vis = this.plotW / this.spacing;
      this.rightOffset = clamp(this.rightOffset, 2.5 - n, Math.max(5, vis * 0.6));
    }

    resetView() {
      this.spacing = 8;
      this.rightOffset = 6;
      for (const p of this.panes) p.auto = true;
      this.invalidate();
      this._viewChanged();
    }

    _visRange() {
      const n = this.bars.length;
      return [Math.max(0, Math.floor(this.idxAt(0))), Math.min(n - 1, Math.ceil(this.idxAt(this.plotW)))];
    }

    _checkHistory() {
      if (this.onNeedHistory && this.bars.length && this.idxAt(0) < 30) this.onNeedHistory();
    }

    // ------------------------------------------------------------------ scaling
    _autoscale(p, a, b) {
      if (!p.auto) return;
      let lo = Infinity, hi = -Infinity;
      const take = (v) => { if (v === v && v !== Infinity && v !== -Infinity) { if (v < lo) lo = v; if (v > hi) hi = v; } };
      if (p === this.main) {
        const B = this._dispBars(), closeOnly = this.chartType === 'line' || this.chartType === 'area';
        for (let i = a; i <= b; i++) { const x = B[i]; if (closeOnly) take(x.c); else { take(x.h); take(x.l); } }
        if (this._base) for (const c of this.compares) if (c.visible && c._base > 0) for (let i = a; i <= b; i++) if (c.values[i] > 0) take(this._cmpY(c, i));
      }
      for (const ind of this.indicators) {
        if (ind.pane !== p || !ind.visible || ind.def.scale === 'volume') continue;
        for (const pl of ind.def.plots) {
          if (pl.style === 'mark') continue;
          const arr = ind.out[pl.key];
          if (arr) for (let i = a; i <= b; i++) take(arr[i]);
        }
        if (p !== this.main && ind.def.levels) for (const l of ind.def.levels) take(l);
      }
      if (lo === Infinity) { lo = 0; hi = 1; }
      if (p.log && lo <= 0) p.log = false;
      if (hi === lo) { const d = Math.abs(hi) * 0.01 || 1; lo -= d; hi += d; }
      const fl = this._f(p, lo), fh = this._f(p, hi), span = fh - fl;
      const bottomMargin = p === this.main && this.indicators.some((i) => i.pane === p && i.def.scale === 'volume' && i.visible) ? 0.16 : 0.08;
      p.min = this._fi(p, fl - span * bottomMargin);
      p.max = this._fi(p, fh + span * 0.1);
    }

    _priceTicks(p) {
      if (p === this.main && this._base) return this._pctTicks(p);
      const target = Math.max(2, Math.floor(p.h / 42));
      const lo = Math.min(p.min, p.max), hi = Math.max(p.min, p.max);
      const raw = (hi - lo) / target;
      if (!(raw > 0)) return { ticks: [], step: 1 };
      const mag = 10 ** Math.floor(Math.log10(raw)), norm = raw / mag;
      const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
      const ticks = [];
      let lastY = Infinity;
      for (let v = Math.ceil(lo / step) * step; v <= hi && ticks.length < 200; v += step) {
        const y = this.yOf(p, v);
        if (Math.abs(lastY - y) < 18) continue;
        ticks.push(+v.toPrecision(12));
        lastY = y;
      }
      return { ticks, step };
    }

    // ticks at round percentages, positioned in price space
    _pctTicks(p) {
      const target = Math.max(2, Math.floor(p.h / 42));
      const lo = this._pct(Math.min(p.min, p.max)), hi = this._pct(Math.max(p.min, p.max));
      const raw = (hi - lo) / target;
      if (!(raw > 0)) return { ticks: [], step: 1 };
      const mag = 10 ** Math.floor(Math.log10(raw)), norm = raw / mag;
      const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
      const ticks = [];
      let lastY = Infinity;
      for (let q = Math.ceil(lo / step) * step; q <= hi && ticks.length < 200; q += step) {
        const v = this._base.v * (1 + q / 100), y = this.yOf(p, v);
        if (Math.abs(lastY - y) < 18) continue;
        ticks.push(v);
        lastY = y;
      }
      return { ticks, step };
    }

    _timeTicks(a, b) {
      const B = this.bars, iv = this.interval, out = [];
      if (b < a) return out;
      const units = [
        [60e3, 'm'], [300e3, 'm'], [900e3, 'm'], [1800e3, 'm'], [3600e3, 'h'], [7200e3, 'h'], [14400e3, 'h'], [21600e3, 'h'], [43200e3, 'h'],
        [86400e3, 'd'], [172800e3, 'd'], [604800e3, 'w'], [2629800e3, 'M1'], [7889400e3, 'M3'], [31557600e3, 'Y1'], [157788000e3, 'Y5'],
      ];
      let unit = units[units.length - 1];
      for (const u of units) if (u[0] >= iv && (u[0] / iv) * this.spacing >= 52) { unit = u; break; }
      const key = (t) => {
        const w = t + tzOffset(t), d = new Date(w);
        switch (unit[1]) {
          case 'M1': return d.getUTCFullYear() * 12 + d.getUTCMonth();
          case 'M3': return Math.floor((d.getUTCFullYear() * 12 + d.getUTCMonth()) / 3);
          case 'Y1': return d.getUTCFullYear();
          case 'Y5': return Math.floor(d.getUTCFullYear() / 5);
          case 'w': return Math.floor(w / 86400e3 / 7 + 0.43);
          default: return Math.floor(w / unit[0]);
        }
      };
      let prev = a > 0 ? key(B[a - 1].t) : null, lastX = -Infinity;
      for (let i = a; i <= b; i++) {
        const k = key(B[i].t);
        if (prev !== null && k !== prev) {
          const x = this.xAt(i);
          if (x - lastX > 55) { out.push({ i, label: this._tickLabel(B[i].t, unit[1]) }); lastX = x; }
        }
        prev = k;
      }
      return out;
    }

    _tickLabel(t, u) {
      const d = zd(t);
      if (u === 'Y1' || u === 'Y5') return String(d.getUTCFullYear());
      if (u === 'M1' || u === 'M3') return d.getUTCMonth() === 0 ? String(d.getUTCFullYear()) : MONTHS[d.getUTCMonth()];
      if (u === 'd' || u === 'w') {
        if (d.getUTCDate() === 1 || (u === 'w' && d.getUTCDate() <= 7)) return d.getUTCMonth() === 0 && d.getUTCDate() <= 7 && u === 'w' ? String(d.getUTCFullYear()) : MONTHS[d.getUTCMonth()];
        return String(d.getUTCDate());
      }
      if (d.getUTCHours() === 0 && d.getUTCMinutes() === 0) return d.getUTCDate() === 1 ? MONTHS[d.getUTCMonth()] : String(d.getUTCDate());
      return pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes());
    }

    fmtTimeFull(t) {
      const d = zd(t);
      const date = `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} '${String(d.getUTCFullYear()).slice(2)}`;
      return this.interval >= 86400e3 ? date : `${date}  ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
    }

    // ------------------------------------------------------------------ rendering
    _render() {
      const ctx = this.ctx, d = window.devicePixelRatio || 1, T = this.theme;
      ctx.setTransform(d, 0, 0, d, 0, 0);
      ctx.fillStyle = T.bg;
      ctx.fillRect(0, 0, this.W, this.H);
      this._layout();
      ctx.font = '11px ' + getComputedStyle(this.el).fontFamily;
      ctx.textBaseline = 'middle';

      if (!this.bars.length) {
        ctx.fillStyle = T.text;
        ctx.textAlign = 'center';
        ctx.font = '14px ' + getComputedStyle(this.el).fontFamily;
        ctx.fillText(this.message || 'No data', this.plotW / 2, this.H / 2);
        return;
      }
      this._clampView();
      const [a, b] = this._visRange();
      this._computeBase(a, b);
      for (const p of this.panes) this._autoscale(p, a, b);
      const timeTicks = this._timeTicks(a, b);

      for (const p of this.panes) {
        const { ticks, step } = this._priceTicks(p);
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, p.top, this.plotW, p.h);
        ctx.clip();
        // grid
        ctx.strokeStyle = T.grid;
        ctx.lineWidth = 1;
        ctx.beginPath();
        if (LOOK.hgrid !== false) for (const v of ticks) { const y = Math.round(this.yOf(p, v)) + 0.5; ctx.moveTo(0, y); ctx.lineTo(this.plotW, y); }
        if (LOOK.vgrid !== false) for (const tk of timeTicks) { const x = Math.round(this.xAt(tk.i)) + 0.5; ctx.moveTo(x, p.top); ctx.lineTo(x, p.top + p.h); }
        ctx.stroke();
        // watermark: the symbol, large and faint, behind the price chart
        if (p === this.main && LOOK.watermark && this.watermark) {
          ctx.save();
          ctx.fillStyle = withAlpha(T.text.startsWith('#') ? T.text : '#888888', 0.12);
          const size = Math.max(18, Math.min(72, this.plotW / 12));
          ctx.font = `700 ${size}px ` + getComputedStyle(this.el).fontFamily;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(this.watermark, this.plotW / 2, p.top + p.h / 2);
          ctx.restore();
        }

        if (p !== this.main) this._drawLevels(p);
        const inds = this.indicators.filter((i) => i.pane === p && i.visible);
        for (const ind of inds) if (ind.def.scale === 'volume') this._drawIndicator(ind, p, a, b);
        if (p === this.main) {
          this._drawPriceSeries(p, a, b);
          if (this._base) this._drawCompares(p, a, b);
        }
        for (const ind of inds) if (ind.def.scale !== 'volume') this._drawIndicator(ind, p, a, b);
        if (p === this.main) {
          this._drawTrades(p);
          this._drawAlerts(p);
          if (!this.drawingsHidden) for (const dr of this.drawings) if (!dr.hidden) this._drawDrawing(dr, dr === this.selected);
          if (this.creating) this._drawDrawing(this.creating, true);
        }
        ctx.restore();
        this._drawPriceAxis(p, ticks, step);
        // pane separator
        if (p !== this.main) {
          ctx.fillStyle = T.border;
          ctx.fillRect(0, p.top, this.W, 1);
        }
      }
      // axes borders
      ctx.fillStyle = T.border;
      ctx.fillRect(Math.round(this.plotW), 0, 1, this.H);
      ctx.fillRect(0, this.H - this.timeH, this.W, 1);
      this._drawTimeAxis(timeTicks);
      this._drawCrosshair();
      if (this.picking && this.hover && this.hover.x < this.plotW) {
        // Bar Replay: show where the replay would start
        const x = Math.round(this.xAt(Math.round(this.idxAt(this.hover.x)))) + 0.5;
        ctx.save();
        ctx.fillStyle = withAlpha(T.line, 0.08);
        ctx.fillRect(x, 0, this.plotW - x, this.H - this.timeH);
        ctx.strokeStyle = T.line;
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, this.H - this.timeH); ctx.stroke();
        ctx.font = '600 11px ' + getComputedStyle(this.el).fontFamily;
        const label = 'Click to start the replay here', w = ctx.measureText(label).width + 14;
        const lx = Math.min(x + 6, this.plotW - w - 4);
        ctx.fillStyle = T.line;
        ctx.fillRect(lx, 8, w, 20);
        ctx.fillStyle = '#fff';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, lx + 7, 18);
        ctx.restore();
      }
    }

    // ---- strategy trades: entry and exit marks joined by a dotted line, green for a profit, red for a loss
    setTrades(trades) { this.trades = trades && trades.length ? trades : null; this.invalidate(); }
    _drawTrades(p) {
      const list = this.trades;
      if (!list || !this.bars.length) return;
      const ctx = this.ctx, T = this.theme, a = this.idxAt(0) - 2, b = this.idxAt(this.plotW) + 2;
      ctx.save();
      ctx.font = '600 10px ' + getComputedStyle(this.el).fontFamily;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const mark = (x, y, up, color, text) => {
        const s = 5, tip = up ? y + 3 : y - 3, base = up ? tip + s * 1.6 : tip - s * 1.6;
        ctx.fillStyle = color;
        ctx.beginPath(); ctx.moveTo(x, tip); ctx.lineTo(x - s, base); ctx.lineTo(x + s, base); ctx.closePath(); ctx.fill();
        const w = ctx.measureText(text).width + 8, ty = up ? base + 9 : base - 9;
        ctx.fillRect(x - w / 2, ty - 7, w, 14);
        ctx.fillStyle = '#fff';
        ctx.fillText(text, x, ty + 0.5);
      };
      for (const tr of list) {
        const i0 = this.timeToIndex(tr.entryT), i1 = this.timeToIndex(tr.exitT);
        if (i1 < a || i0 > b) continue;
        const x0 = this.xAt(i0), x1 = this.xAt(i1), y0 = this.yOf(p, tr.entryPrice), y1 = this.yOf(p, tr.exitPrice);
        const res = tr.pnl > 0 ? T.up : T.down;
        ctx.strokeStyle = withAlpha(res, 0.8);
        ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
        ctx.setLineDash([]);
        const long = tr.dir > 0;
        mark(x0, y0, long, long ? T.line : '#E040FB', long ? 'Long' : 'Short');
        if (!tr.open) mark(x1, y1, !long, res, `${tr.pnlPct >= 0 ? '+' : ''}${tr.pnlPct.toFixed(1)}%`);
      }
      ctx.restore();
    }

    // show the candles from t0 to t1 (date-range buttons)
    setVisibleRange(t0, t1) {
      if (!this.bars.length) return;
      const i0 = this.timeToIndex(t0), i1 = Math.min(this.timeToIndex(t1), this.lastIndex);
      this.spacing = clamp((this.plotW * 0.94) / Math.max(1, i1 - i0 + 1), 0.5, 80); // (down to 2 candles per pixel, so a day of 1m candles fits)
      this.rightOffset = i1 - this.lastIndex + 2;
      this._clampView();
      this._checkHistory();
      this._viewChanged();
      this._legendIdx = -2;
      this.invalidate();
    }

    // center the chart on a time (Strategy Tester: jump to a trade)
    scrollToTime(t) {
      if (!this.bars.length) return;
      this.rightOffset = this.plotW / (2 * this.spacing) + this.timeToIndex(t) - this.lastIndex - 0.5;
      this._clampView();
      this._checkHistory();
      this._viewChanged();
      this._legendIdx = -2;
      this.invalidate();
    }
    // wait for a click on the chart; cb gets the time of the clicked candle
    pickTime(cb) { this.picking = cb; this.select(null); this.invalidate(); }
    cancelPick() { if (!this.picking) return false; this.picking = null; this.invalidate(); return true; }

    _drawLevels(p) {
      const ctx = this.ctx, T = this.theme;
      for (const ind of this.indicators) {
        if (ind.pane !== p || !ind.visible) continue;
        const def = ind.def;
        if (def.bandFill) {
          const y1 = this.yOf(p, def.bandFill[0]), y2 = this.yOf(p, def.bandFill[1]);
          ctx.fillStyle = ind.colors.band || def.bandColor || T.band;
          ctx.fillRect(0, Math.min(y1, y2), this.plotW, Math.abs(y2 - y1));
        }
        if (def.levels) {
          ctx.strokeStyle = T.level;
          ctx.setLineDash([4, 4]);
          ctx.beginPath();
          for (const l of def.levels) { const y = Math.round(this.yOf(p, l)) + 0.5; ctx.moveTo(0, y); ctx.lineTo(this.plotW, y); }
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }
    }

    _drawPriceSeries(p, a, b) {
      const ctx = this.ctx, T = this.theme, B = this._dispBars(), sp = this.spacing;
      const type = this.chartType;
      const lo = Math.max(0, a - 1), hi = Math.min(B.length - 1, b + 1);
      if (type === 'line' || type === 'area') {
        ctx.beginPath();
        for (let i = lo; i <= hi; i++) { const x = this.xAt(i), y = this.yOf(p, B[i].c); i === lo ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
        if (type === 'area') {
          ctx.save();
          ctx.lineTo(this.xAt(hi), p.top + p.h);
          ctx.lineTo(this.xAt(lo), p.top + p.h);
          ctx.closePath();
          const g = ctx.createLinearGradient(0, p.top, 0, p.top + p.h);
          g.addColorStop(0, T.area);
          g.addColorStop(1, withAlpha(T.line, 0));
          ctx.fillStyle = g;
          ctx.fill();
          ctx.restore();
          ctx.beginPath();
          for (let i = lo; i <= hi; i++) { const x = this.xAt(i), y = this.yOf(p, B[i].c); i === lo ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
        }
        ctx.strokeStyle = T.line;
        ctx.lineWidth = 2;
        ctx.lineJoin = 'round';
        ctx.stroke();
        ctx.lineWidth = 1;
        return;
      }
      if (type === 'renko') {
        // bricks touch each other: full width, no wicks
        const bw2 = Math.max(1, Math.floor(sp * 0.9));
        for (let i = lo; i <= hi; i++) {
          const k = B[i], up = k.c >= k.o, x0 = Math.round(this.xAt(i) - bw2 / 2);
          const top = Math.round(this.yOf(p, k.h)), bot = Math.round(this.yOf(p, k.l));
          ctx.fillStyle = withAlpha(up ? T.up : T.down, 0.85);
          ctx.fillRect(x0, top, bw2, Math.max(1, bot - top));
          if (bw2 >= 4) { ctx.strokeStyle = up ? T.up : T.down; ctx.strokeRect(x0 + 0.5, top + 0.5, bw2 - 1, Math.max(0, bot - top - 1)); }
        }
        return;
      }
      if (type === 'kagi') {
        // vertical lines joined by short horizontals; thick and green while yang, thin and red while yin
        const seg = (x1, y1, x2, y2, yang) => {
          ctx.strokeStyle = yang ? T.up : T.down;
          ctx.lineWidth = yang ? 2.5 : 1.2;
          ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
        };
        ctx.lineCap = 'square';
        for (let i = lo; i <= hi; i++) {
          const k = B[i], s = k.kagi, x = Math.round(this.xAt(i)) + 0.5, yo = this.yOf(p, k.o), yc = this.yOf(p, k.c);
          if (i > 0) seg(Math.round(this.xAt(i - 1)) + 0.5, yo, x, yo, s.s0);
          if (s.sw !== null) { const ys = this.yOf(p, s.sw); seg(x, yo, x, ys, s.s0); seg(x, ys, x, yc, s.s1); }
          else seg(x, yo, x, yc, s.s0);
        }
        ctx.lineCap = 'butt';
        ctx.lineWidth = 1;
        return;
      }
      if (type === 'pnf') {
        // an X or an O for every box of each column
        const w = Math.max(2, sp * 0.8);
        ctx.lineWidth = Math.max(1, Math.min(2, sp / 8));
        for (let i = lo; i <= hi; i++) {
          const k = B[i].pnf, x = this.xAt(i);
          const hBox = Math.abs(this.yOf(p, k.lo) - this.yOf(p, k.lo + k.box));
          const r = Math.max(1, Math.min(w, hBox) / 2 - 1);
          ctx.strokeStyle = k.x ? T.up : T.down;
          const nBoxes = Math.round((k.hi - k.lo) / k.box);
          for (let j = 0; j <= nBoxes && j < 2000; j++) {
            const y = this.yOf(p, k.lo + j * k.box);
            if (y < p.top - r || y > p.top + p.h + r) continue;
            ctx.beginPath();
            if (k.x) { ctx.moveTo(x - r, y - r); ctx.lineTo(x + r, y + r); ctx.moveTo(x + r, y - r); ctx.lineTo(x - r, y + r); }
            else ctx.arc(x, y, r, 0, Math.PI * 2);
            ctx.stroke();
          }
        }
        ctx.lineWidth = 1;
        return;
      }
      let bw = Math.max(1, Math.floor(sp * 0.72));
      if (bw > 2 && bw % 2 === 0) bw -= 1;
      for (const up of [true, false]) {
        ctx.fillStyle = up ? T.up : T.down;
        ctx.strokeStyle = up ? T.up : T.down;
        for (let i = lo; i <= hi; i++) {
          const k = B[i], isUp = k.c >= k.o;
          if (isUp !== up) continue;
          const x0 = Math.round(this.xAt(i) - bw / 2), wx = x0 + (bw >> 1);
          const yh = this.yOf(p, k.h), yl = this.yOf(p, k.l), yo = this.yOf(p, k.o), yc = this.yOf(p, k.c);
          if (type === 'bars') {
            const tick = Math.max(1, bw >> 1);
            ctx.fillRect(wx, Math.round(yh), 1, Math.max(1, Math.round(yl) - Math.round(yh)));
            ctx.fillRect(wx - tick, Math.round(yo), tick, 1);
            ctx.fillRect(wx + 1, Math.round(yc), tick, 1);
            continue;
          }
          const top = Math.round(Math.min(yo, yc)), bot = Math.round(Math.max(yo, yc)), bh = Math.max(1, bot - top);
          if (type === 'hollow' && up && bw >= 3) {
            ctx.fillRect(wx, Math.round(yh), 1, top - Math.round(yh));
            ctx.fillRect(wx, top + bh, 1, Math.round(yl) - top - bh);
            ctx.strokeRect(x0 + 0.5, top + 0.5, bw - 1, Math.max(0, bh - 1));
          } else {
            ctx.fillRect(wx, Math.round(yh), 1, Math.max(1, Math.round(yl) - Math.round(yh)));
            ctx.fillRect(x0, top, bw, bh);
          }
        }
      }
    }

    _drawIndicator(ind, p, a, b) {
      const ctx = this.ctx, out = ind.out, def = ind.def, sp = this.spacing;
      if (!out) return;
      const lo = Math.max(0, a - 1), hi = Math.min(this.bars.length - 1, b + 1);
      let yfn = (v) => this.yOf(p, v);
      let baseY = null;
      if (def.scale === 'volume') {
        let mx = 0;
        for (const pl of def.plots) { const arr = out[pl.key]; if (arr) for (let i = a; i <= b; i++) if (arr[i] > mx) mx = arr[i]; }
        const bottom = p.top + p.h, hh = p.h * 0.18;
        yfn = (v) => bottom - (mx ? (v / mx) * hh : 0);
        baseY = bottom;
      }
      // fills between two plots; the color can change per bar (up/down colors, or a script's per-bar colors)
      for (const f of def.fills || []) {
        const A = out[f.from], Bv = out[f.to];
        if (!A || !Bv) continue;
        const perBar = !ind.colors[f.key] && out[f.key + '$c'];
        const up = ind.colors[f.key] || f.color, down = f.colorDown ? ind.colors[f.key + 'Down'] || f.colorDown : up;
        const colorAt = (k) => (perBar ? perBar[k] || up : A[k] >= Bv[k] ? up : down);
        const ok = (k) => isFinite(A[k]) && isFinite(Bv[k]);
        let i = lo;
        while (i <= hi) {
          while (i <= hi && !ok(i)) i++;
          if (i > hi) break;
          const col = colorAt(i);
          let j = i;
          while (j + 1 <= hi && ok(j + 1) && colorAt(j + 1) === col) j++;
          const end = j + 1 <= hi && ok(j + 1) ? j + 1 : j; // reach into the next run so there is no gap
          ctx.beginPath();
          for (let k = i; k <= end; k++) { const x = this.xAt(k), y = yfn(A[k]); k === i ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
          for (let k = end; k >= i; k--) ctx.lineTo(this.xAt(k), yfn(Bv[k]));
          ctx.closePath();
          ctx.fillStyle = col;
          ctx.fill();
          i = j + 1;
        }
      }
      for (const pl of def.plots) {
        const arr = out[pl.key];
        if (!arr) continue;
        const color = this.plotColor(ind, pl), style = pl.style || 'line';
        // per-bar colors: palette indexes (built-ins) or color strings (scripts); a color picked in settings wins
        const idx = out[pl.key + '$i'], cols = !ind.colors[pl.key] && out[pl.key + '$c'];
        const colorAt = (i) => (idx ? ind.colors[pl.key + '.' + idx[i]] || pl.palette[idx[i]] : cols ? cols[i] || color : color);
        if (style === 'mark') { this._drawMarks(ind, pl, p, lo, hi, arr, colorAt, yfn); continue; }
        if (style === 'histogram') {
          const zero = baseY ?? yfn(0);
          let w = def.scale === 'volume' ? Math.max(1, Math.floor(sp * 0.72)) : Math.max(1, Math.floor(sp * 0.45));
          if (w > 2 && w % 2 === 0) w -= 1;
          for (let i = lo; i <= hi; i++) {
            const v = arr[i];
            if (!isFinite(v)) continue;
            ctx.fillStyle = colorAt(i);
            const y = yfn(v), x0 = Math.round(this.xAt(i) - w / 2);
            ctx.fillRect(x0, Math.round(Math.min(y, zero)), w, Math.max(1, Math.round(Math.abs(zero - y))));
          }
        } else if (style === 'dots') {
          const r = clamp(sp * 0.18, 1, 2.5) * Math.max(1, (pl.width || 1.25) / 1.5);
          for (let i = lo; i <= hi; i++) {
            const v = arr[i];
            if (!isFinite(v)) continue;
            ctx.fillStyle = colorAt(i);
            ctx.beginPath();
            ctx.arc(this.xAt(i), yfn(v), r, 0, Math.PI * 2);
            ctx.fill();
          }
        } else {
          // lines: Line (joins over missing values), Line with breaks, Step line, Step line with breaks,
          // Step line with diamonds (a diamond wherever the value changes)
          const st = this.plotStyle(ind, pl);
          const step = st.type.startsWith('step'), breaks = st.type === 'linebr' || st.type === 'stepbr';
          ctx.lineWidth = st.width;
          ctx.lineJoin = step ? 'miter' : 'round';
          ctx.lineCap = step ? 'square' : 'round';
          let prev = -1, cur = null, open = false;
          const flush = () => { if (open) { ctx.stroke(); open = false; } };
          for (let i = lo; i <= hi; i++) {
            const v = arr[i];
            if (!isFinite(v)) { if (breaks) prev = -1; continue; }
            const x = this.xAt(i), y = yfn(v), c = cols || idx ? colorAt(i) : color;
            if (prev < 0) { flush(); ctx.strokeStyle = cur = c; ctx.beginPath(); ctx.moveTo(x, y); open = true; prev = i; continue; }
            // each segment takes the color of the bar it ends on; same-color segments share a path
            const py = yfn(arr[prev]);
            if (c !== cur) { flush(); ctx.strokeStyle = cur = c; ctx.beginPath(); ctx.moveTo(this.xAt(prev), py); open = true; }
            if (step) ctx.lineTo(x, py);
            ctx.lineTo(x, y);
            prev = i;
          }
          flush();
          if (st.type === 'stepdia') {
            const r = Math.max(2.5, st.width + 1.5);
            for (let i = lo; i <= hi; i++) {
              const v = arr[i];
              if (!isFinite(v) || (i > 0 && arr[i - 1] === v)) continue;
              const x = this.xAt(i), y = yfn(v);
              ctx.fillStyle = cols || idx ? colorAt(i) : color;
              ctx.beginPath();
              ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y);
              ctx.closePath();
              ctx.fill();
            }
          }
          // price line: a dotted line across the pane at the latest value
          if (st.priceLine) {
            let k = arr.length - 1;
            while (k >= 0 && !isFinite(arr[k])) k--;
            if (k >= 0) {
              const y = Math.round(yfn(arr[k])) + 0.5;
              ctx.save();
              ctx.lineWidth = 1;
              ctx.setLineDash([1, 3]);
              ctx.strokeStyle = color;
              ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(this.plotW, y); ctx.stroke();
              ctx.restore();
            }
          }
          ctx.lineWidth = 1;
          ctx.lineCap = 'butt';
        }
      }
    }

    // markers for a true/false series: a triangle above the bar's high or below its low (price chart),
    // or at the top/bottom edge of an indicator pane, with an optional text label
    _drawMarks(ind, pl, p, lo, hi, arr, colorAt) {
      const ctx = this.ctx, B = this._dispBars(), above = pl.position !== 'below', onPrice = p === this.main;
      const size = clamp(this.spacing * 0.45, 3, 6);
      ctx.font = '600 10px ' + getComputedStyle(this.el).fontFamily;
      ctx.textAlign = 'center';
      for (let i = lo; i <= hi; i++) {
        if (!arr[i]) continue;
        const x = this.xAt(i);
        let y;
        if (onPrice) y = above ? this.yOf(p, B[i].h) - 6 : this.yOf(p, B[i].l) + 6;
        else y = above ? p.top + 8 + size : p.top + p.h - 8 - size;
        ctx.fillStyle = colorAt(i);
        ctx.beginPath();
        if (above) { ctx.moveTo(x - size, y - size * 1.6); ctx.lineTo(x + size, y - size * 1.6); ctx.lineTo(x, y); }
        else { ctx.moveTo(x - size, y + size * 1.6); ctx.lineTo(x + size, y + size * 1.6); ctx.lineTo(x, y); }
        ctx.closePath();
        ctx.fill();
        if (pl.text && this.spacing >= 4) ctx.fillText(pl.text, x, above ? y - size * 1.6 - 8 : y + size * 1.6 + 8);
      }
      ctx.font = '11px ' + getComputedStyle(this.el).fontFamily;
    }

    _axisLabel(y, text, bg, fg, p) {
      if (this._labels) { this._labels.push({ y, text, bg, fg, p }); return; }
      const ctx = this.ctx;
      if (p && (y < p.top - 2 || y > p.top + p.h + 2)) return;
      const h = 18, x = this.plotW + 1;
      ctx.fillStyle = bg;
      ctx.fillRect(x, Math.round(y - h / 2), this.axisW - 1, h);
      ctx.fillStyle = fg;
      ctx.textAlign = 'left';
      ctx.fillText(text, x + 7, Math.round(y) + 0.5);
    }

    _fmtAxis(p, v, step, tick) {
      if (p === this.main && this._base) return this._fmtPct(v, tick ? clamp(-Math.floor(Math.log10(step || 1)), 0, 4) : 2);
      if (p === this.main) {
        if (!tick) return this.fmtPrice(v);
        return v.toFixed(Math.min(this.decimals, clamp(-Math.floor(Math.log10(step || 1)), 0, 8)));
      }
      const volOnly = this.indicators.filter((i) => i.pane === p).some((i) => i.def.plots.some((pl) => pl.format === 'volume'));
      if (volOnly || Math.abs(v) >= 1e5) return fmtCompact(v);
      const dec = clamp(-Math.floor(Math.log10(step || 1)), 0, 8);
      return v.toFixed(dec);
    }

    _drawPriceAxis(p, ticks, step) {
      const ctx = this.ctx, T = this.theme;
      ctx.save();
      ctx.beginPath();
      ctx.rect(this.plotW, p.top, this.axisW, p.h);
      ctx.clip();
      ctx.fillStyle = T.bg;
      ctx.fillRect(this.plotW, p.top, this.axisW, p.h);
      ctx.fillStyle = T.text;
      ctx.textAlign = 'left';
      for (const v of ticks) {
        const y = this.yOf(p, v);
        if (y < p.top + 8 || y > p.top + p.h - 8) continue;
        ctx.fillText(this._fmtAxis(p, v, step, true), this.plotW + 8, y);
      }
      // indicator last values (collected, then spread apart so they don't overlap)
      this._labels = [];
      for (const ind of this.indicators) {
        if (ind.pane !== p || !ind.visible || ind.def.scale === 'volume') continue;
        for (const pl of ind.def.plots) {
          if (pl.style === 'histogram' || pl.style === 'mark') continue;
          const arr = ind.out[pl.key];
          if (!arr) continue;
          const v = arr[arr.length - 1];
          if (!isFinite(v)) continue;
          this._axisLabel(this.yOf(p, v), p === this.main && this._base ? this._fmtPct(v) : this._fmtPlot(ind, pl, v), this.plotColor(ind, pl), '#fff', p);
        }
      }
      if (p === this.main && this._base) {
        const last = this.bars.length - 1;
        for (const c of this.compares) {
          if (!c.visible || !(c._base > 0) || !(c.values[last] > 0)) continue;
          const v = this._cmpY(c, last);
          this._axisLabel(this.yOf(p, v), this._fmtPct(v), c.color, '#fff', p);
        }
      }
      const labels = this._labels.filter((l) => l.y >= p.top - 2 && l.y <= p.top + p.h + 2).sort((a, b) => a.y - b.y);
      this._labels = null;
      for (let i = 1; i < labels.length; i++) if (labels[i].y - labels[i - 1].y < 18) labels[i].y = labels[i - 1].y + 18;
      const n = labels.length, bottom = p.top + p.h - 9;
      if (n && labels[n - 1].y > bottom) {
        labels[n - 1].y = bottom;
        for (let i = n - 2; i >= 0; i--) if (labels[i + 1].y - labels[i].y < 18) labels[i].y = labels[i + 1].y - 18;
      }
      for (const l of labels) this._axisLabel(l.y, l.text, l.bg, l.fg, p);
      if (p === this.main) {
        if (!this.drawingsHidden) {
          for (const d of this.drawings) {
            if (!d.hidden && DRAW() && DRAW().TOOLS[d.type] && DRAW().TOOLS[d.type].axis) this._axisLabel(this.yOf(p, d.pts[0].p), this._fmtMain(d.pts[0].p), d.color || T.drawing, '#fff', p);
          }
        }
        for (const al of this.alerts) this._axisLabel(this.yOf(p, al.price), this._fmtMain(al.price), T.alert, '#111', p);
        const B = this._dispBars(), last = B[B.length - 1], real = this.raw[this.raw.length - 1] || last;
        const color = last.c >= last.o ? T.up : T.down, y = this.yOf(p, real.c);
        // dotted last-price line
        ctx.restore();
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, p.top, this.plotW, p.h);
        ctx.clip();
        ctx.strokeStyle = color;
        ctx.setLineDash([1, 2]);
        ctx.beginPath();
        if (LOOK.lastLine !== false) {
          ctx.moveTo(0, Math.round(y) + 0.5);
          ctx.lineTo(this.plotW, Math.round(y) + 0.5);
        }
        ctx.stroke();
        ctx.restore();
        ctx.save();
        ctx.beginPath();
        ctx.rect(this.plotW, p.top, this.axisW, p.h);
        ctx.clip();
        this._axisLabel(y, this._fmtMain(real.c), color, '#fff', p);
        if (this.live && this.countdown !== false && LOOK.countdown !== false && !this.isBrick && this.interval < 7 * 86400e3) {
          const left = Math.max(0, real.t + this.interval - Date.now());
          const s = Math.floor(left / 1000), hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
          const txt = (hh ? hh + ':' + pad2(mm) : pad2(mm)) + ':' + pad2(ss);
          ctx.fillStyle = color;
          ctx.fillRect(this.plotW + 1, Math.round(y + 9), this.axisW - 1, 15);
          ctx.fillStyle = '#fff';
          ctx.globalAlpha = 0.85;
          ctx.fillText(txt, this.plotW + 7, Math.round(y + 16.5));
          ctx.globalAlpha = 1;
        }
      }
      if (this.hover && this.hover.pane === p && !this.drag) {
        this._axisLabel(this.hover.y, this._fmtAxis(p, this.vOf(p, this.hover.y), step), T.crossLabel, '#fff', p);
      }
      ctx.restore();
    }

    _drawTimeAxis(ticks) {
      const ctx = this.ctx, T = this.theme, y = this.H - this.timeH / 2;
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, this.H - this.timeH + 1, this.plotW, this.timeH);
      ctx.clip();
      ctx.fillStyle = T.text;
      ctx.textAlign = 'center';
      for (const tk of ticks) ctx.fillText(tk.label, this.xAt(tk.i), y);
      ctx.restore();
    }

    _drawCrosshair() {
      const own = this.hover && this.hover.x < this.plotW && this.hover.y < this.H - this.timeH;
      const h = own ? this.hover : null;
      if (!h && this.syncTime == null) return;
      if (this.drag && this.drag.kind !== 'drawing' && this.drag.kind !== 'handle') return;
      const ctx = this.ctx, T = this.theme;
      const idx = h ? Math.round(this.idxAt(h.x)) : this._syncIdx(), x = Math.round(this.xAt(idx)) + 0.5;
      if (!h && (x < 0 || x > this.plotW)) return;
      ctx.strokeStyle = T.cross;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, this.H - this.timeH);
      if (h && h.pane) { const y = Math.round(h.y) + 0.5; ctx.moveTo(0, y); ctx.lineTo(this.plotW, y); }
      ctx.stroke();
      ctx.setLineDash([]);
      const txt = this.fmtTimeFull(this.indexToTime(idx));
      const w = ctx.measureText(txt).width + 16;
      const lx = clamp(x - w / 2, 0, this.plotW - w);
      ctx.fillStyle = T.crossLabel;
      ctx.fillRect(lx, this.H - this.timeH + 1, w, this.timeH - 1);
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.fillText(txt, lx + w / 2, this.H - this.timeH / 2);
    }

    _drawAlerts(p) {
      const ctx = this.ctx, T = this.theme;
      ctx.strokeStyle = T.alert;
      ctx.setLineDash([6, 4]);
      for (const al of this.alerts) {
        const y = Math.round(this.yOf(p, al.price)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(this.plotW, y);
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }

    // ------------------------------------------------------------------ drawings
    _edgePoint(x1, y1, x2, y2) {
      // extend from (x1,y1) through (x2,y2) to beyond the plot edge
      const dx = x2 - x1, dy = y2 - y1;
      if (!dx && !dy) return { x: x2, y: y2 };
      const k = (this.plotW + this.H) * 4 / Math.hypot(dx, dy);
      return { x: x1 + dx * k, y: y1 + dy * k };
    }

    // what drawing tools need from the chart (coordinates, bars, formatting)
    _dapi() {
      if (!this._font) this._font = getComputedStyle(this.el).fontFamily;
      return {
        theme: this.theme, font: this._font, plotW: this.plotW, plotH: this.H - this.timeH, spacing: this.spacing, bars: this.bars,
        x: (t) => this.xAt(this.timeToIndex(t)), y: (p) => this.yOf(this.main, p), price: (y) => this.vOf(this.main, y),
        idx: (t) => this.timeToIndex(t), xi: (i) => this.xAt(i), ti: (i) => this.indexToTime(i), idxAtX: (x) => this.idxAt(x),
        fmt: (v) => this.fmtPrice(v), dec: this.decimals, compact: fmtCompact, edge: (a, b) => this._edgePoint(a.x, a.y, b.x, b.y),
      };
    }
    _toolPoints(d) { return d.pts.map((pt) => this._pt(pt)); }
    _handles(d, tool, P, api) { return tool.noHandles ? [] : tool.handles ? tool.handles(P, api, d) : P; }

    _drawDrawing(d, selected) {
      const DR = DRAW(), tool = DR && DR.TOOLS[d.type];
      if (!tool) return;
      const ctx = this.ctx, api = this._dapi(), P = this._toolPoints(d);
      ctx.save();
      const g = DR.pen(ctx, api, d, false);
      const need = tool.n === 'multi' || tool.n === 0 ? 2 : tool.n;
      try {
        if (P.length < need) g.poly(P, { dash: [4, 4] }); // still being placed
        else tool.draw(g, P, d);
      } catch (e) { console.error(d.type, e); }
      ctx.restore();
      ctx.setLineDash([]);
      ctx.lineWidth = 1;
      if (!selected) return;
      const color = d.color || this.theme.drawing;
      for (const pt of this._handles(d, tool, P, api)) {
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, 5, 0, Math.PI * 2);
        ctx.fillStyle = this.theme.handleFill;
        ctx.fill();
        ctx.strokeStyle = DR.alpha(color, 1);
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.lineWidth = 1;
      }
    }

    _hitDrawing(x, y) {
      if (this.drawingsHidden) return null;
      const DR = DRAW();
      if (!DR) return null;
      const api = this._dapi();
      this.ctx.save();
      try {
        for (let k = this.drawings.length - 1; k >= 0; k--) {
          const d = this.drawings[k], tool = DR.TOOLS[d.type];
          if (!tool || d.hidden) continue;
          const P = this._toolPoints(d);
          if (d === this.selected) {
            const H = this._handles(d, tool, P, api);
            for (let h = 0; h < H.length; h++) if (Math.hypot(x - H[h].x, y - H[h].y) < 8) return { d, handle: h };
          }
          const g = DR.pen(this.ctx, api, d, true);
          try { tool.draw(g, P, d); } catch (e) { continue; }
          if (DR.hitTest(g.prims, x, y, Math.max(6, (d.width || 1.5) / 2 + 3))) return { d, handle: -1 };
        }
      } finally { this.ctx.restore(); }
      return null;
    }

    _pointFromMouse(x, y) {
      const n = this.bars.length;
      const idx = Math.round(this.idxAt(x));
      let price = this.vOf(this.main, y);
      if (this.magnet && idx >= 0 && idx < n) {
        const b = this.bars[idx];
        let best = price, bd = Infinity;
        for (const v of [b.o, b.h, b.l, b.c]) { const dy = Math.abs(this.yOf(this.main, v) - y); if (dy < bd) { bd = dy; best = v; } }
        price = best;
      }
      return { t: this.indexToTime(idx), p: price };
    }

    _freePoint(x, y) { return { t: this.indexToTime(this.idxAt(x)), p: this.vOf(this.main, y) }; }

    setTool(t) {
      this.tool = t;
      this.creating = null;
      if (t !== 'cursor') this.select(null);
      this.canvas.style.cursor = 'crosshair';
      this.invalidate();
    }

    select(d) {
      if (this.selected === d) return;
      this.selected = d;
      this.onSelect(d);
      this.invalidate();
    }

    deleteSelected() {
      if (!this.selected) return;
      this.drawings = this.drawings.filter((d) => d !== this.selected);
      this.select(null);
      this.onDrawingsChange();
    }

    _finishCreating() {
      const d = this.creating;
      this.creating = null;
      this.freehand = false;
      if (!d) return;
      const tool = DRAW().TOOLS[d.type];
      // drop repeated points (a double-click places the same point twice)
      const P = this._toolPoints(d), keep = [];
      d.pts.forEach((q, i) => { if (!keep.length || Math.hypot(P[i].x - P[keep[keep.length - 1]].x, P[i].y - P[keep[keep.length - 1]].y) > 3 || tool.n !== 'multi') keep.push(i); });
      d.pts = keep.map((i) => d.pts[i]);
      const need = tool.n === 'multi' || tool.n === 0 ? 2 : tool.n;
      const P2 = this._toolPoints(d);
      const spread = P2.length ? Math.max(...P2.map((q) => Math.hypot(q.x - P2[0].x, q.y - P2[0].y))) : 0;
      if (d.pts.length < need || spread < 3) { this.invalidate(); return; }
      if (tool.normalize) tool.normalize(d);
      this._commitDrawing(d);
    }
    // finish a multi-point drawing (path, polyline, ghost feed) from outside: Enter key
    finishCreating() {
      if (!this.creating) return false;
      const tool = DRAW().TOOLS[this.creating.type];
      if (tool.n === 'multi' && this.creating.pts.length > 2) this.creating.pts.pop(); // the point following the mouse
      this._finishCreating();
      return true;
    }
    _commitDrawing(d) {
      this.drawings.push(d);
      this.tool = 'cursor';
      this.select(d);
      this.onToolDone();
      this.onDrawingsChange();
      this.invalidate();
    }

    // ------------------------------------------------------------------ input
    _region(x, y) {
      if (y >= this.H - this.timeH) return { r: x >= this.plotW ? 'corner' : 'time' };
      for (let i = 1; i < this.panes.length; i++) if (Math.abs(y - this.panes[i].top) <= 3) return { r: 'divider', i };
      const p = this.paneAt(y);
      if (x >= this.plotW) return { r: 'price', p };
      return { r: 'plot', p };
    }

    _bind() {
      const c = this.canvas;
      const pos = (e) => { const r = c.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };

      c.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        const { x, y } = pos(e), reg = this._region(x, y);
        c.setPointerCapture(e.pointerId);
        this.downAt = { x, y };
        if (this.picking && reg.r === 'plot') {
          const cb = this.picking, t = this.indexToTime(Math.round(this.idxAt(x)));
          this.picking = null;
          cb(t);
          this.invalidate();
          return;
        }
        if (reg.r === 'plot' && this.tool !== 'cursor') {
          if (reg.p !== this.main) return;
          const tool = DRAW() && DRAW().TOOLS[this.tool];
          if (!tool) { this.tool = 'cursor'; this.onToolDone(); return; }
          if (this.creating) {
            // the next point of a 3+ point or multi-point drawing, or the last one
            const d = this.creating, pt = this._pointFromMouse(x, y);
            d.pts[d.pts.length - 1] = pt;
            if (tool.n === 'multi' || d.pts.length < tool.n) d.pts.push({ ...pt });
            else this._finishCreating();
            this.invalidate();
            return;
          }
          const pt = this._pointFromMouse(x, y), base = { id: uid(), type: this.tool, color: tool.color || null, width: tool.width || 1.5 };
          if (tool.n === 0) { // freehand: follow the mouse while the button is down
            this.creating = { ...base, pts: [this._freePoint(x, y)] };
            this.freehand = true;
          } else if (tool.n !== 1) {
            this.creating = { ...base, pts: [pt, { ...pt }] };
            this.creatingFromDown = true;
          } else {
            const d = { ...base, pts: [pt] };
            if (tool.init) tool.init(d, this._dapi());
            if (tool.askText) {
              this.tool = 'cursor';
              this.onToolDone();
              Promise.resolve(this.askText('Note')).then((txt) => {
                if (!txt) return;
                d.text = txt;
                this.drawings.push(d);
                this.select(d);
                this.onDrawingsChange();
                this.invalidate();
              });
              return;
            }
            this._commitDrawing(d);
          }
          this.invalidate();
          return;
        }
        if (reg.r === 'divider') {
          const a = this.panes[reg.i - 1], b = this.panes[reg.i];
          this.drag = { kind: 'divider', a, b, y, ha: a.h, hb: b.h, wa: a.weight, wb: b.weight };
          return;
        }
        if (reg.r === 'price' && reg.p) {
          const p = reg.p;
          this.drag = { kind: 'yscale', p, y, fmin: this._f(p, p.min), fmax: this._f(p, p.max) };
          return;
        }
        if (reg.r === 'time') { this.drag = { kind: 'xscale', x, sp: this.spacing }; return; }
        if (reg.r === 'plot') {
          const hit = reg.p === this.main ? this._hitDrawing(x, y) : null;
          if (hit) {
            this.select(hit.d);
            if (hit.d.locked) return;
            this.drag = hit.handle >= 0
              ? { kind: 'handle', d: hit.d, h: hit.handle }
              : { kind: 'drawing', d: hit.d, i0: this.idxAt(x), p0: this.vOf(this.main, y), orig: hit.d.pts.map((q) => ({ ...q })) };
            return;
          }
          this.select(null);
          const p = reg.p;
          this.drag = { kind: 'pan', x, y, ro: this.rightOffset, p, fmin: this._f(p, p.min), fmax: this._f(p, p.max) };
          c.style.cursor = 'grabbing';
        }
      });

      c.addEventListener('pointermove', (e) => {
        const { x, y } = pos(e);
        const reg = this._region(x, y);
        this.hover = { x, y, pane: reg.r === 'plot' || reg.r === 'price' ? reg.p : null };
        const dr = this.drag;
        if (this.creating) {
          const pts = this.creating.pts;
          if (this.freehand) {
            const last = this._pt(pts[pts.length - 1]);
            if (Math.hypot(x - last.x, y - last.y) >= 3) pts.push(this._freePoint(x, y));
          } else pts[pts.length - 1] = this._pointFromMouse(x, y);
        } else if (dr) {
          switch (dr.kind) {
            case 'pan': {
              this.rightOffset = dr.ro - (x - dr.x) / this.spacing;
              if (!dr.p.auto) {
                const span = dr.fmax - dr.fmin, df = ((y - dr.y) / dr.p.h) * span;
                dr.p.min = this._fi(dr.p, dr.fmin + df);
                dr.p.max = this._fi(dr.p, dr.fmax + df);
              }
              this._clampView();
              this._checkHistory();
              break;
            }
            case 'xscale': {
              this.spacing = clamp(dr.sp * Math.exp((x - dr.x) * 0.006), 1, 80);
              this._clampView();
              this._checkHistory();
              break;
            }
            case 'yscale': {
              const p = dr.p, k = Math.exp((y - dr.y) * 0.006), mid = (dr.fmin + dr.fmax) / 2, half = ((dr.fmax - dr.fmin) / 2) * k;
              p.auto = false;
              p.min = this._fi(p, mid - half);
              p.max = this._fi(p, mid + half);
              break;
            }
            case 'divider': {
              const dy = clamp(y - dr.y, 40 - dr.ha, dr.hb - 40), tw = dr.wa + dr.wb;
              dr.a.weight = (tw * (dr.ha + dy)) / (dr.ha + dr.hb);
              dr.b.weight = tw - dr.a.weight;
              this._layout();
              break;
            }
            case 'handle': {
              dr.d.pts[dr.h] = this._pointFromMouse(x, y);
              const tl = DRAW().TOOLS[dr.d.type];
              if (tl && tl.normalize) tl.normalize(dr.d);
              break;
            }
            case 'drawing': {
              const di = Math.round(this.idxAt(x) - dr.i0), dp = this.vOf(this.main, y) - dr.p0;
              dr.d.pts = dr.orig.map((q) => ({ t: this.indexToTime(Math.round(this.timeToIndex(q.t)) + di), p: q.p + dp }));
              break;
            }
          }
        } else {
          // cursor feedback
          let cur = 'crosshair';
          if (reg.r === 'price') cur = 'ns-resize';
          else if (reg.r === 'time') cur = 'ew-resize';
          else if (reg.r === 'divider') cur = 'row-resize';
          else if (reg.r === 'plot' && this.tool === 'cursor' && reg.p === this.main) {
            const hit = this._hitDrawing(x, y);
            if (hit) cur = hit.handle >= 0 ? 'grab' : 'pointer';
          }
          c.style.cursor = cur;
        }
        this._updateLegendValues();
        this._emitCrosshair(reg.r === 'plot' ? x : null);
        if (dr && (dr.kind === 'pan' || dr.kind === 'xscale')) this._viewChanged();
        this.invalidate();
      });

      const end = (e) => {
        const dr = this.drag;
        this.drag = null;
        if (this.creating && this.freehand) this._finishCreating();
        else if (this.creating && this.creatingFromDown && this.downAt) {
          const { x, y } = pos(e);
          this.creatingFromDown = false;
          if (Math.hypot(x - this.downAt.x, y - this.downAt.y) > 8) { // press-drag-release places the second point
            const tl = DRAW().TOOLS[this.creating.type];
            if (tl.n === 2) this._finishCreating();
            else this.creating.pts.push({ ...this.creating.pts[this.creating.pts.length - 1] });
          }
        }
        if (dr && (dr.kind === 'handle' || dr.kind === 'drawing')) this.onDrawingsChange();
        if (dr && dr.kind === 'divider') this.onLayoutChange();
        c.style.cursor = 'crosshair';
        this.invalidate();
      };
      c.addEventListener('pointerup', end);
      c.addEventListener('pointercancel', end);
      c.addEventListener('pointerleave', () => {
        if (this.drag) return;
        this.hover = null;
        this._updateLegendValues();
        this._emitCrosshair(null);
        this.invalidate();
      });

      c.addEventListener('dblclick', (e) => {
        const { x, y } = pos(e), reg = this._region(x, y);
        if (reg.r === 'price' && reg.p) { reg.p.auto = true; this.invalidate(); }
        else if (reg.r === 'time') this.resetView();
        else if (this.creating && DRAW().TOOLS[this.creating.type].n === 'multi') this.finishCreating();
        else if (reg.r === 'plot' && reg.p === this.main) {
          const hit = this._hitDrawing(x, y);
          if (hit && (hit.d.type === 'text' || hit.d.type === 'arrowup' || hit.d.type === 'arrowdown')) {
            Promise.resolve(this.askText(hit.d.text)).then((txt) => {
              if (txt) { hit.d.text = txt; this.onDrawingsChange(); this.invalidate(); }
            });
          }
        }
      });

      c.addEventListener('wheel', (e) => {
        e.preventDefault();
        if (!this.bars.length) return;
        const { x, y } = pos(e), reg = this._region(x, y);
        if (reg.r === 'price' && reg.p) {
          const p = reg.p, k = Math.exp(e.deltaY * 0.002), fmin = this._f(p, p.min), fmax = this._f(p, p.max), mid = (fmin + fmax) / 2, half = ((fmax - fmin) / 2) * k;
          p.auto = false;
          p.min = this._fi(p, mid - half);
          p.max = this._fi(p, mid + half);
        } else if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey) {
          const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
          this.rightOffset += d / this.spacing;
        } else {
          // At the live edge keep the latest bar pinned; when browsing history zoom around the cursor.
          const ax = reg.r === 'plot' && this.rightOffset < 0 ? x : this.plotW, i = this.idxAt(ax);
          const ns = clamp(this.spacing * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0018)), 1, 80);
          const ro = this.rightOffset;
          this.spacing = ns;
          this.rightOffset = ax === this.plotW ? ro : i - this.lastIndex - 0.5 + (this.plotW - ax) / ns;
        }
        this._clampView();
        this._checkHistory();
        this._legendIdx = -2;
        this._updateLegendValues();
        if (reg.r !== 'price') this._viewChanged();
        this.invalidate();
      }, { passive: false });

      c.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const { x, y } = pos(e), reg = this._region(x, y);
        if (this.creating) { this.creating = null; this.invalidate(); return; }
        const hit = reg.r === 'plot' && reg.p === this.main ? this._hitDrawing(x, y) : null;
        if (hit) this.select(hit.d);
        this.onContextMenu({
          clientX: e.clientX, clientY: e.clientY, drawing: hit ? hit.d : null,
          price: reg.p === this.main ? this.vOf(this.main, y) : null,
        });
      });
    }

    cancelCreating() {
      if (this.creating) { this.creating = null; this.invalidate(); return true; }
      return false;
    }

    // ------------------------------------------------------------------ export
    snapshot() { return this.snapshotCanvas().toDataURL('image/png'); }

    snapshotCanvas() {
      const d = window.devicePixelRatio || 1, cv = document.createElement('canvas');
      cv.width = this.canvas.width;
      cv.height = this.canvas.height;
      const ctx = cv.getContext('2d');
      ctx.drawImage(this.canvas, 0, 0);
      ctx.setTransform(d, 0, 0, d, 0, 0);
      ctx.fillStyle = this.theme.textStrong;
      ctx.font = '600 13px ' + getComputedStyle(this.el).fontFamily;
      ctx.textBaseline = 'top';
      const last = this.bars[this.bars.length - 1];
      ctx.fillText(`${this.title}   ${last ? this.fmtPrice(last.c) : ''}`, 10, 10);
      ctx.font = '11px ' + getComputedStyle(this.el).fontFamily;
      ctx.fillStyle = this.theme.text;
      let y = 30;
      for (const c of this.compares) {
        if (!c.visible) continue;
        ctx.fillStyle = c.color;
        ctx.fillText('vs ' + c.symbol, 10, y);
        y += 15;
      }
      ctx.fillStyle = this.theme.text;
      for (const ind of this.indicators) {
        if (ind.pane !== this.main) continue;
        ctx.fillText(this.indicatorLabel(ind), 10, y);
        y += 15;
      }
      for (const p of this.panes.slice(1)) {
        const ind = this.indicators.find((i) => i.pane === p);
        if (ind) ctx.fillText(this.indicatorLabel(ind), 10, p.top + 8);
      }
      return cv;
    }
  }

  window.CandelaChart = { Chart, THEMES, decimalsFor, fmtCompact, setTimeZone, tzOffset, setLook };
})();
