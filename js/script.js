/* Candela Script — a small language for custom indicators.
 *
 * Scripts are line-based. Every expression works on whole series at once (one value per bar), so
 * `close - open` is a series and `x[1]` is x one bar ago. There are no loops, so every script finishes,
 * and it runs in this interpreter only: scripts cannot reach the page, the network or your data.
 *
 * A compiled script becomes an ordinary indicator definition (same shape as js/indicators.js), so it
 * gets settings, panes, legends and saving for free. */
(function () {
  'use strict';
  const F = window.Indicators.fn;

  class ScriptError extends Error {
    constructor(message, line, col) { super(message); this.line = line || 1; this.col = col || 1; }
  }
  const fail = (msg, at) => { throw new ScriptError(msg, at && at.line, at && at.col); };

  const KEYWORDS = ['name', 'short', 'overlay', 'pane', 'input', 'plot', 'level', 'fill', 'mark'];
  const WORD_OPS = ['and', 'or', 'not'];
  const SOURCES = ['open', 'high', 'low', 'close', 'volume', 'hl2', 'hlc3', 'ohlc4'];
  const TIME_SERIES = ['time', 'bar_index', 'hour', 'minute', 'dayofweek', 'dayofmonth', 'month', 'year'];
  const CONSTANTS = { na: NaN, true: 1, false: 0, pi: Math.PI };
  const COLORS = {
    red: '#F7525F', green: '#22AB94', blue: '#3D8BFD', orange: '#F5A623', yellow: '#F9D71C', purple: '#9C6ADE',
    teal: '#2EC4B6', aqua: '#2BC6E4', pink: '#E040FB', lime: '#8BC34A', gray: '#8A93A3', white: '#FFFFFF', black: '#000000',
  };
  const PALETTE = ['#3D8BFD', '#F5A623', '#9C6ADE', '#2EC4B6', '#F7525F', '#8BC34A', '#E040FB'];
  const MAX_LEN = 5000;

  // ------------------------------------------------------------------ lexer
  // Token types: num, str, color, ident, punct, nl, comment, ws, bad (bad/ws only in loose mode)
  const TOKEN_RE = /(\r?\n)|([ \t\r]+)|(\/\/[^\n]*)|((?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')|(#[0-9a-fA-F]+)|([A-Za-z_][A-Za-z0-9_]*)|(==|!=|<=|>=|[-+*/%^<>?:()[\],=])|(.)/y;

  function lex(src, loose = false) {
    const toks = [];
    let line = 1, lineStart = 0, depth = 0, m;
    TOKEN_RE.lastIndex = 0;
    while (TOKEN_RE.lastIndex < src.length && (m = TOKEN_RE.exec(src))) {
      const start = m.index, text = m[0], col = start - lineStart + 1;
      const tok = (type, value) => toks.push({ type, value, text, start, end: start + text.length, line, col });
      if (m[1]) {
        if (depth === 0 || loose) tok('nl', '\n');
        line++;
        lineStart = start + text.length;
      } else if (m[2]) { if (loose) tok('ws'); }
      else if (m[3]) tok('comment');
      else if (m[4]) tok('num', parseFloat(text));
      else if (m[5]) {
        if (loose) { tok('str'); continue; }
        tok('str', text.slice(1, -1).replace(/\\(.)/g, '$1'));
      } else if (m[6]) {
        if (![4, 5, 7, 9].includes(text.length) && !loose) fail(`"${text}" is not a valid color. Use #RGB, #RRGGBB or #RRGGBBAA`, { line, col });
        tok('color', text);
      } else if (m[7]) tok('ident', text);
      else if (m[8]) {
        if (text === '(' || text === '[') depth++;
        if (text === ')' || text === ']') depth = Math.max(0, depth - 1);
        tok('punct', text);
      } else {
        if (loose) { tok('bad'); continue; }
        fail(`Unexpected character "${text}"`, { line, col });
      }
    }
    return toks;
  }

  // ------------------------------------------------------------------ parser
  function parse(src) {
    const toks = lex(src).filter((t) => t.type !== 'comment');
    let p = 0;
    const lastLine = toks.length ? toks[toks.length - 1].line : 1;
    const peek = (k = 0) => toks[p + k];
    const at = (type, value) => { const t = toks[p]; return !!t && t.type === type && (value === undefined || t.value === value); };
    const atEnd = () => p >= toks.length || at('nl');
    const here = () => toks[p] || { line: lastLine, col: (toks[toks.length - 1] || { col: 0, text: '' }).col + 1 };
    const describe = (t) => (!t || t.type === 'nl' ? 'the end of the line' : `"${t.text}"`);
    const expect = (type, value, what) => {
      if (!at(type, value)) fail(`Expected ${what} but found ${describe(toks[p])}`, here());
      return toks[p++];
    };

    function parseExpr() { return parseTernary(); }
    function parseTernary() {
      const cond = parseOr();
      if (at('punct', '?')) {
        const q = toks[p++];
        const a = parseTernary();
        expect('punct', ':', '":" (the "else" part of  condition ? a : b)');
        const b = parseTernary();
        return { type: 'tern', cond, a, b, line: q.line, col: q.col };
      }
      return cond;
    }
    function parseOr() {
      let left = parseAnd();
      while (at('ident', 'or')) { const t = toks[p++]; left = { type: 'bin', op: 'or', left, right: parseAnd(), line: t.line, col: t.col }; }
      return left;
    }
    function parseAnd() {
      let left = parseNot();
      while (at('ident', 'and')) { const t = toks[p++]; left = { type: 'bin', op: 'and', left, right: parseNot(), line: t.line, col: t.col }; }
      return left;
    }
    function parseNot() {
      if (at('ident', 'not')) { const t = toks[p++]; return { type: 'un', op: 'not', arg: parseNot(), line: t.line, col: t.col }; }
      return parseCmp();
    }
    function parseCmp() {
      const left = parseAdd();
      const t = peek();
      if (t && t.type === 'punct' && ['<', '<=', '>', '>=', '==', '!='].includes(t.value)) {
        p++;
        return { type: 'bin', op: t.value, left, right: parseAdd(), line: t.line, col: t.col };
      }
      if (at('punct', '=')) fail('Use == to compare two values (a single = assigns a variable)', here());
      return left;
    }
    function parseAdd() {
      let left = parseMul();
      while (at('punct', '+') || at('punct', '-')) { const t = toks[p++]; left = { type: 'bin', op: t.value, left, right: parseMul(), line: t.line, col: t.col }; }
      return left;
    }
    function parseMul() {
      let left = parseUnary();
      while (at('punct', '*') || at('punct', '/') || at('punct', '%')) { const t = toks[p++]; left = { type: 'bin', op: t.value, left, right: parseUnary(), line: t.line, col: t.col }; }
      return left;
    }
    function parseUnary() {
      if (at('punct', '-') || at('punct', '+')) { const t = toks[p++]; const arg = parseUnary(); return t.value === '-' ? { type: 'un', op: '-', arg, line: t.line, col: t.col } : arg; }
      return parsePow();
    }
    function parsePow() {
      const base = parsePostfix();
      if (at('punct', '^')) { const t = toks[p++]; return { type: 'bin', op: '^', left: base, right: parseUnary(), line: t.line, col: t.col }; }
      return base;
    }
    function parsePostfix() {
      let node = parsePrimary();
      while (at('punct', '[')) {
        const t = toks[p++];
        const offset = parseExpr();
        expect('punct', ']', '"]"');
        node = { type: 'hist', target: node, offset, line: t.line, col: t.col };
      }
      return node;
    }
    function parsePrimary() {
      const t = toks[p];
      if (!t || t.type === 'nl') fail('This line ends too early: a value is missing', here());
      if (t.type === 'num') { p++; return { type: 'num', value: t.value, line: t.line, col: t.col }; }
      if (t.type === 'color') { p++; return { type: 'color', value: t.value, line: t.line, col: t.col }; }
      if (t.type === 'str') fail('Text in quotes can only be used as a label, not in a calculation', t);
      if (t.type === 'ident') {
        if (KEYWORDS.includes(t.value)) fail(`"${t.value}" starts a statement, so it can't be used inside a calculation`, t);
        if (WORD_OPS.includes(t.value)) fail(`"${t.value}" needs a value on its left`, t);
        p++;
        if (at('punct', '(')) {
          p++;
          const args = [];
          if (!at('punct', ')')) {
            do { args.push(parseExpr()); } while (at('punct', ',') && ++p);
          }
          expect('punct', ')', `"," or ")" to finish ${t.value}(…)`);
          return { type: 'call', name: t.value, args, line: t.line, col: t.col };
        }
        return { type: 'var', name: t.value, line: t.line, col: t.col };
      }
      if (t.type === 'punct' && t.value === '(') {
        p++;
        const e = parseExpr();
        expect('punct', ')', '")"');
        return e;
      }
      fail(`Unexpected ${describe(t)}`, t);
    }

    // options after a statement: `color red width 2 style histogram` (an "=" after the name is allowed)
    function parseOptions(allowed) {
      const o = {};
      while (at('ident')) {
        const t = toks[p++], kind = allowed[t.value];
        if (!kind) fail(`Unknown option "${t.value}"${Object.keys(allowed).length ? `. Options here: ${Object.keys(allowed).join(', ')}` : ''}`, t);
        if (typeof kind === 'string' && kind.startsWith('flag:')) {
          // shorthand: `mark cond below` means `position below`
          const target = kind.slice(5);
          if (o[target]) fail(`"${target}" is given twice`, t);
          o[target] = { word: t.value, line: t.line, col: t.col };
          continue;
        }
        if (o[t.value]) fail(`"${t.value}" is given twice`, t);
        if (at('punct', '=')) p++;
        if (Array.isArray(kind)) {
          const w = expect('ident', undefined, `one of: ${kind.join(', ')}`);
          if (!kind.includes(w.value)) fail(`"${w.value}" is not valid for ${t.value}. Use one of: ${kind.join(', ')}`, w);
          o[t.value] = { word: w.value, line: w.line, col: w.col };
        } else o[t.value] = parseExpr();
      }
      return o;
    }
    const optLabel = () => (at('str') ? toks[p++].value : null);

    const stmts = [];
    while (p < toks.length) {
      if (at('nl')) { p++; continue; }
      const t = toks[p];
      let st;
      if (t.type === 'ident' && KEYWORDS.includes(t.value) && !(peek(1) && peek(1).type === 'punct' && peek(1).value === '=')) {
        p++;
        const base = { kind: t.value, line: t.line, col: t.col };
        switch (t.value) {
          case 'name': case 'short': st = { ...base, value: expect('str', undefined, 'a name in quotes, e.g. "My indicator"').value }; break;
          case 'overlay': case 'pane': st = base; break;
          case 'input': {
            const id = expect('ident', undefined, 'an input name, e.g.  input length = 14');
            expect('punct', '=', '"=" and a default value');
            let neg = false;
            if (at('punct', '-')) { p++; neg = true; }
            const v = toks[p];
            if (v && v.type === 'num') { p++; st = { ...base, name: id.value, nameTok: id, vtype: /[.eE]/.test(v.text) ? 'float' : 'int', value: neg ? -v.value : v.value }; }
            else if (!neg && v && v.type === 'ident' && SOURCES.includes(v.value)) { p++; st = { ...base, name: id.value, nameTok: id, vtype: 'source', value: v.value }; }
            else if (!neg && v && v.type === 'ident' && (v.value === 'true' || v.value === 'false')) { p++; st = { ...base, name: id.value, nameTok: id, vtype: 'bool', value: v.value === 'true' }; }
            else fail('An input default must be a number, true/false, or a price source (open, high, low, close, volume, hl2, hlc3, ohlc4)', v || here());
            st.label = optLabel();
            st.opts = parseOptions(st.vtype === 'int' || st.vtype === 'float' ? { min: 1, max: 1, step: 1 } : {});
            break;
          }
          case 'plot':
            st = { ...base, expr: parseExpr() };
            st.label = optLabel();
            st.opts = parseOptions({ color: 1, width: 1, style: ['line', 'histogram', 'dots', 'columns'] });
            break;
          case 'level':
            st = { ...base, expr: parseExpr() };
            st.label = optLabel();
            st.opts = parseOptions({});
            break;
          case 'fill':
            st = { ...base, a: parseExpr() };
            expect('punct', ',', '"," between the two values to fill between, e.g.  fill upper, lower');
            st.b = parseExpr();
            st.opts = parseOptions({ color: 1 });
            break;
          case 'mark':
            st = { ...base, expr: parseExpr() };
            st.label = optLabel();
            st.opts = parseOptions({ color: 1, position: ['above', 'below'], above: 'flag:position', below: 'flag:position' });
            break;
        }
      } else if (t.type === 'ident' && peek(1) && peek(1).type === 'punct' && peek(1).value === '=') {
        p += 2;
        st = { kind: 'assign', name: t.value, nameTok: t, expr: parseExpr(), line: t.line, col: t.col };
      } else {
        fail(`A line should be an assignment like  x = sma(close, 20)  or start with plot, input, level, fill, mark, name or overlay. Found ${describe(t)}`, t);
      }
      if (!atEnd()) fail(`Unexpected ${describe(toks[p])}. Each statement goes on its own line`, here());
      stmts.push(st);
    }
    return stmts;
  }

  // ------------------------------------------------------------------ helpers for evaluation
  const isArr = Array.isArray;
  const truthy = (v) => (typeof v === 'string' ? true : v === v && v !== 0);
  function map1(a, f, n) {
    if (!isArr(a)) return f(a);
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = f(a[i]);
    return out;
  }
  function map2(a, b, f, n) {
    const A = isArr(a), B = isArr(b);
    if (!A && !B) return f(a, b);
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = f(A ? a[i] : a, B ? b[i] : b);
    return out;
  }
  function mapN(args, f, n) {
    if (!args.some(isArr)) return f(...args);
    const out = new Array(n), vals = new Array(args.length);
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < args.length; k++) vals[k] = isArr(args[k]) ? args[k][i] : args[k];
      out[i] = f(...vals);
    }
    return out;
  }
  const series = (x, n) => (isArr(x) ? x : new Array(n).fill(x));
  const num = (v) => (typeof v === 'number' ? v : NaN);

  const BINOPS = {
    '+': (x, y) => x + y, '-': (x, y) => x - y, '*': (x, y) => x * y, '/': (x, y) => x / y,
    '%': (x, y) => x % y, '^': (x, y) => Math.pow(x, y),
    '<': (x, y) => (x < y ? 1 : 0), '<=': (x, y) => (x <= y ? 1 : 0), '>': (x, y) => (x > y ? 1 : 0), '>=': (x, y) => (x >= y ? 1 : 0),
    '==': (x, y) => (x === y ? 1 : 0), '!=': (x, y) => (x !== y && !(x !== x && y !== y) ? 1 : 0),
    and: (x, y) => (truthy(x) && truthy(y) ? 1 : 0), or: (x, y) => (truthy(x) || truthy(y) ? 1 : 0),
  };
  const ARITH = new Set(['+', '-', '*', '/', '%', '^', '<', '<=', '>', '>=']);

  function hexToRgb(hex) {
    let h = hex.slice(1);
    if (h.length <= 4) h = h.split('').map((c) => c + c).join('');
    const n = parseInt(h.slice(0, 6), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  // ------------------------------------------------------------------ built-in functions
  // args: [min, max]; fn(ctx, node, ...values)
  const length = (v, ctx, node, fname, what = 'length') => {
    if (isArr(v)) fail(`${fname}(): the ${what} must be a single number, not a series`, node);
    if (typeof v !== 'number' || !(v >= 1)) fail(`${fname}(): the ${what} must be a whole number of 1 or more`, node);
    return Math.min(MAX_LEN, Math.round(v));
  };
  const numSeries = (v, ctx, node, fname) => {
    if (typeof v === 'string' || (isArr(v) && typeof v.find((x) => x != null) === 'string')) fail(`${fname}(): expected numbers, got a color`, node);
    return series(v, ctx.n);
  };

  const FUNCS = {};
  const def = (name, args, sig, doc, fn, group) => { FUNCS[name] = { args, sig, doc, fn, group }; };
  const G_MA = 'Moving averages', G_OSC = 'Oscillators & volatility', G_LOGIC = 'Signals & conditions', G_MATH = 'Math', G_COLOR = 'Colors';

  def('sma', [2, 2], 'sma(source, length)', 'Simple moving average', (c, n, x, l) => F.sma(numSeries(x, c, n, 'sma'), length(l, c, n, 'sma')), G_MA);
  def('ema', [2, 2], 'ema(source, length)', 'Exponential moving average', (c, n, x, l) => F.ema(numSeries(x, c, n, 'ema'), length(l, c, n, 'ema')), G_MA);
  def('wma', [2, 2], 'wma(source, length)', 'Weighted moving average', (c, n, x, l) => F.wma(numSeries(x, c, n, 'wma'), length(l, c, n, 'wma')), G_MA);
  def('rma', [2, 2], 'rma(source, length)', "Wilder's smoothing (used by RSI and ATR)", (c, n, x, l) => F.rma(numSeries(x, c, n, 'rma'), length(l, c, n, 'rma')), G_MA);
  def('hma', [2, 2], 'hma(source, length)', 'Hull moving average', (c, n, x, l) => {
    const s = numSeries(x, c, n, 'hma'), L = length(l, c, n, 'hma');
    const half = F.wma(s, Math.max(1, Math.round(L / 2))), full = F.wma(s, L);
    return F.wma(half.map((v, i) => 2 * v - full[i]), Math.max(1, Math.round(Math.sqrt(L))));
  }, G_MA);
  def('vwma', [2, 2], 'vwma(source, length)', 'Volume-weighted moving average', (c, n, x, l) => {
    const s = numSeries(x, c, n, 'vwma'), L = length(l, c, n, 'vwma'), v = c.get('volume');
    const a = F.sma(s.map((y, i) => y * v[i]), L), b = F.sma(v, L);
    return a.map((y, i) => y / b[i]);
  }, G_MA);
  def('linreg', [2, 2], 'linreg(source, length)', 'End point of a linear regression line over the last length bars', (c, n, x, l) => {
    const s = numSeries(x, c, n, 'linreg'), L = length(l, c, n, 'linreg'), out = new Array(c.n).fill(NaN);
    const sx = (L * (L - 1)) / 2, sxx = ((L - 1) * L * (2 * L - 1)) / 6;
    for (let i = L - 1; i < c.n; i++) {
      let sy = 0, sxy = 0, ok = true;
      for (let k = 0; k < L; k++) { const y = s[i - L + 1 + k]; if (y !== y) { ok = false; break; } sy += y; sxy += k * y; }
      if (!ok) continue;
      const slope = (L * sxy - sx * sy) / (L * sxx - sx * sx || 1), icpt = (sy - slope * sx) / L;
      out[i] = icpt + slope * (L - 1);
    }
    return out;
  }, G_MA);

  def('rsi', [2, 2], 'rsi(source, length)', 'Relative Strength Index, 0 to 100', (c, n, x, l) => F.rsiOf(numSeries(x, c, n, 'rsi'), length(l, c, n, 'rsi')), G_OSC);
  def('stoch', [2, 2], 'stoch(source, length)', 'Stochastic %K: where source sits in the high-low range, 0 to 100', (c, n, x, l) => {
    const s = numSeries(x, c, n, 'stoch'), L = length(l, c, n, 'stoch'), hh = F.highest(c.get('high'), L), ll = F.lowest(c.get('low'), L);
    return s.map((v, i) => (hh[i] - ll[i] === 0 ? 50 : (100 * (v - ll[i])) / (hh[i] - ll[i])));
  }, G_OSC);
  def('cci', [2, 2], 'cci(source, length)', 'Commodity Channel Index', (c, n, x, l) => {
    const s = numSeries(x, c, n, 'cci'), L = length(l, c, n, 'cci'), m = F.sma(s, L), out = new Array(c.n).fill(NaN);
    for (let i = L - 1; i < c.n; i++) {
      let md = 0;
      for (let j = i - L + 1; j <= i; j++) md += Math.abs(s[j] - m[i]);
      md /= L;
      out[i] = md === 0 ? 0 : (s[i] - m[i]) / (0.015 * md);
    }
    return out;
  }, G_OSC);
  def('atr', [1, 1], 'atr(length)', 'Average True Range', (c, n, l) => F.atr(c.bars, length(l, c, n, 'atr')), G_OSC);
  def('tr', [0, 0], 'tr()', 'True range of each bar', (c) => F.trueRange(c.bars), G_OSC);
  def('stdev', [2, 2], 'stdev(source, length)', 'Standard deviation', (c, n, x, l) => F.stdev(numSeries(x, c, n, 'stdev'), length(l, c, n, 'stdev')), G_OSC);
  def('highest', [2, 2], 'highest(source, length)', 'Highest value over the last length bars', (c, n, x, l) => F.highest(numSeries(x, c, n, 'highest'), length(l, c, n, 'highest')), G_OSC);
  def('lowest', [2, 2], 'lowest(source, length)', 'Lowest value over the last length bars', (c, n, x, l) => F.lowest(numSeries(x, c, n, 'lowest'), length(l, c, n, 'lowest')), G_OSC);
  def('change', [1, 2], 'change(source, bars = 1)', 'Difference from bars ago', (c, n, x, l = 1) => { const s = numSeries(x, c, n, 'change'), L = length(l, c, n, 'change', 'bar count'); return s.map((v, i) => (i >= L ? v - s[i - L] : NaN)); }, G_OSC);
  def('roc', [2, 2], 'roc(source, length)', 'Rate of change in percent', (c, n, x, l) => { const s = numSeries(x, c, n, 'roc'), L = length(l, c, n, 'roc'); return s.map((v, i) => (i >= L ? (100 * (v - s[i - L])) / s[i - L] : NaN)); }, G_OSC);
  def('sum', [2, 2], 'sum(source, length)', 'Rolling sum over the last length bars', (c, n, x, l) => { const L = length(l, c, n, 'sum'); return F.sma(numSeries(x, c, n, 'sum'), L).map((v) => v * L); }, G_OSC);
  def('cum', [1, 1], 'cum(source)', 'Running total since the first bar (missing values count as 0)', (c, n, x) => { let acc = 0; return numSeries(x, c, n, 'cum').map((v) => (acc += v === v ? v : 0)); }, G_OSC);

  const crossFn = (kind) => (c, n, a, b) => {
    const A = numSeries(a, c, n, kind), B = numSeries(b, c, n, kind), out = new Array(c.n).fill(0);
    for (let i = 1; i < c.n; i++) {
      const up = A[i] > B[i] && A[i - 1] <= B[i - 1], dn = A[i] < B[i] && A[i - 1] >= B[i - 1];
      out[i] = (kind === 'crossover' ? up : kind === 'crossunder' ? dn : up || dn) ? 1 : 0;
    }
    return out;
  };
  def('crossover', [2, 2], 'crossover(a, b)', 'True on the bar where a moves above b', crossFn('crossover'), G_LOGIC);
  def('crossunder', [2, 2], 'crossunder(a, b)', 'True on the bar where a moves below b', crossFn('crossunder'), G_LOGIC);
  def('cross', [2, 2], 'cross(a, b)', 'True on the bar where a and b cross either way', crossFn('cross'), G_LOGIC);
  const streak = (rise) => (c, n, x, l = 1) => {
    const s = numSeries(x, c, n, rise ? 'rising' : 'falling'), L = length(l, c, n, rise ? 'rising' : 'falling', 'bar count');
    return s.map((v, i) => {
      if (i < L) return 0;
      for (let k = 0; k < L; k++) if (!(rise ? s[i - k] > s[i - k - 1] : s[i - k] < s[i - k - 1])) return 0;
      return 1;
    });
  };
  def('rising', [1, 2], 'rising(source, bars = 1)', 'True if source went up on each of the last bars', streak(true), G_LOGIC);
  def('falling', [1, 2], 'falling(source, bars = 1)', 'True if source went down on each of the last bars', streak(false), G_LOGIC);
  def('barssince', [1, 1], 'barssince(condition)', 'Bars since condition was last true', (c, n, x) => {
    const s = series(x, c.n);
    let last = -1;
    return s.map((v, i) => { if (truthy(v)) last = i; return last < 0 ? NaN : i - last; });
  }, G_LOGIC);
  def('valuewhen', [2, 2], 'valuewhen(condition, source)', 'Value of source on the last bar where condition was true', (c, n, cond, x) => {
    const s = series(cond, c.n), v = series(x, c.n);
    let cur = NaN;
    return s.map((k, i) => { if (truthy(k)) cur = v[i]; return cur; });
  }, G_LOGIC);
  def('if', [3, 3], 'if(condition, a, b)', 'a where condition is true, otherwise b (same as condition ? a : b)', (c, n, k, a, b) => mapN([k, a, b], (x, y, z) => (truthy(x) ? y : z), c.n), G_LOGIC);
  def('nz', [1, 2], 'nz(source, replacement = 0)', 'Replaces missing values', (c, n, x, r = 0) => map2(x, r, (v, w) => (v === v ? v : w), c.n), G_LOGIC);
  def('isna', [1, 1], 'isna(source)', 'True where the value is missing', (c, n, x) => map1(x, (v) => (v !== v ? 1 : 0), c.n), G_LOGIC);

  const m1 = (name, f, doc) => def(name, [1, 1], `${name}(x)`, doc, (c, n, x) => map1(x, (v) => f(num(v)), c.n), G_MATH);
  m1('abs', Math.abs, 'Absolute value');
  m1('sqrt', Math.sqrt, 'Square root');
  m1('log', Math.log, 'Natural logarithm');
  m1('log10', Math.log10, 'Base-10 logarithm');
  m1('exp', Math.exp, 'e to the power x');
  m1('floor', Math.floor, 'Round down');
  m1('ceil', Math.ceil, 'Round up');
  m1('sign', Math.sign, '1, 0 or -1');
  def('round', [1, 2], 'round(x, decimals = 0)', 'Round to a number of decimals', (c, n, x, d = 0) => map2(x, d, (v, k) => { const f = 10 ** k; return Math.round(v * f) / f; }, c.n), G_MATH);
  def('pow', [2, 2], 'pow(x, y)', 'x to the power y (same as x ^ y)', (c, n, x, y) => map2(x, y, Math.pow, c.n), G_MATH);
  def('min', [2, 99], 'min(a, b, …)', 'Smallest of the values, bar by bar', (c, n, ...a) => mapN(a, (...v) => Math.min(...v.map(num)), c.n), G_MATH);
  def('max', [2, 99], 'max(a, b, …)', 'Largest of the values, bar by bar', (c, n, ...a) => mapN(a, (...v) => Math.max(...v.map(num)), c.n), G_MATH);
  def('avg', [2, 99], 'avg(a, b, …)', 'Average of the values, bar by bar', (c, n, ...a) => mapN(a, (...v) => v.reduce((s, y) => s + num(y), 0) / v.length, c.n), G_MATH);
  def('clamp', [3, 3], 'clamp(x, low, high)', 'Limit x to the range low…high', (c, n, x, lo, hi) => mapN([x, lo, hi], (v, a, b) => Math.min(b, Math.max(a, v)), c.n), G_MATH);

  const clampByte = (v) => Math.max(0, Math.min(255, Math.round(v)));
  def('rgba', [4, 4], 'rgba(red, green, blue, alpha)', 'A color from 0–255 channels and 0–1 opacity', (c, n, r, g, b, a) => mapN([r, g, b, a], (R, G, B, A) => `rgba(${clampByte(R)},${clampByte(G)},${clampByte(B)},${Math.max(0, Math.min(1, A))})`, c.n), G_COLOR);
  def('rgb', [3, 3], 'rgb(red, green, blue)', 'A color from 0–255 channels', (c, n, r, g, b) => mapN([r, g, b], (R, G, B) => `rgb(${clampByte(R)},${clampByte(G)},${clampByte(B)})`, c.n), G_COLOR);
  def('fade', [2, 2], 'fade(color, opacity)', 'The same color at an opacity from 0 to 1', (c, n, col, a) => mapN([col, a], (C, A) => {
    if (typeof C !== 'string') fail('fade(): the first argument must be a color', n);
    const [R, G, B] = C.startsWith('#') ? hexToRgb(C) : (C.match(/\d+(\.\d+)?/g) || [0, 0, 0]).map(Number);
    return `rgba(${R},${G},${B},${Math.max(0, Math.min(1, A))})`;
  }, c.n), G_COLOR);

  // ------------------------------------------------------------------ static checks
  function editDistance(a, b) {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    return d[a.length][b.length];
  }
  const suggest = (name, pool) => {
    let best = null, bd = 3;
    for (const c of pool) { const dd = editDistance(name.toLowerCase(), c.toLowerCase()); if (dd < bd) { bd = dd; best = c; } }
    return best ? `. Did you mean "${best}"?` : '';
  };
  const BUILTIN_NAMES = [...SOURCES, ...TIME_SERIES, ...Object.keys(CONSTANTS), ...Object.keys(COLORS)];

  function check(stmts) {
    const defined = new Set();
    const walk = (node) => {
      switch (node.type) {
        case 'var':
          if (!defined.has(node.name) && !BUILTIN_NAMES.includes(node.name)) {
            if (FUNCS[node.name]) fail(`${node.name} is a function: call it like ${FUNCS[node.name].sig}`, node);
            fail(`Unknown name "${node.name}"${suggest(node.name, [...defined, ...BUILTIN_NAMES])}`, node);
          }
          break;
        case 'call': {
          const f = FUNCS[node.name];
          if (!f) fail(`Unknown function "${node.name}"${suggest(node.name, Object.keys(FUNCS))}`, node);
          const [lo, hi] = f.args;
          if (node.args.length < lo || node.args.length > hi) fail(`${node.name}() takes ${lo === hi ? lo : `${lo} to ${hi}`} argument${hi === 1 ? '' : 's'}: ${f.sig}`, node);
          node.args.forEach(walk);
          break;
        }
        case 'bin': walk(node.left); walk(node.right); break;
        case 'un': walk(node.arg); break;
        case 'tern': walk(node.cond); walk(node.a); walk(node.b); break;
        case 'hist': walk(node.target); walk(node.offset); break;
      }
    };
    const claim = (name, tok, isInput) => {
      if (KEYWORDS.includes(name)) fail(`"${name}" starts a statement, so it can't be used as a name`, tok);
      if (BUILTIN_NAMES.includes(name) || WORD_OPS.includes(name)) fail(`"${name}" is a built-in name, so it can't be ${isInput ? 'an input' : 'assigned'}. Pick another name`, tok);
      if (FUNCS[name]) fail(`"${name}" is a built-in function, so it can't be used as a variable name`, tok);
      if (isInput && defined.has(name)) fail(`There is already a variable or input called "${name}"`, tok);
      defined.add(name);
    };
    const seen = {};
    for (const st of stmts) {
      if (['name', 'short', 'overlay', 'pane'].includes(st.kind)) {
        if (seen[st.kind]) fail(`"${st.kind}" is given more than once`, st);
        seen[st.kind] = true;
      }
      if (st.kind === 'input') claim(st.name, st.nameTok, true);
      if (st.kind === 'assign') { walk(st.expr); claim(st.name, st.nameTok, false); }
      if (st.kind === 'plot' || st.kind === 'mark' || st.kind === 'level') walk(st.expr);
      if (st.kind === 'fill') { walk(st.a); walk(st.b); }
      for (const v of Object.values(st.opts || {})) if (v && v.type) walk(v);
    }
    if (seen.overlay && seen.pane) fail('Use either "overlay" or "pane", not both', stmts.find((s) => s.kind === 'pane'));
  }

  // value of an expression that doesn't depend on bars (numbers, colors, simple arithmetic)
  function constValue(node) {
    switch (node.type) {
      case 'num': return node.value;
      case 'color': return node.value;
      case 'var':
        if (node.name in COLORS) return COLORS[node.name];
        if (node.name in CONSTANTS) return CONSTANTS[node.name];
        return undefined;
      case 'un': { const v = constValue(node.arg); return typeof v === 'number' ? (node.op === '-' ? -v : v ? 0 : 1) : undefined; }
      case 'bin': {
        const a = constValue(node.left), b = constValue(node.right);
        return typeof a === 'number' && typeof b === 'number' ? BINOPS[node.op](a, b) : undefined;
      }
      case 'call':
        if (['rgba', 'rgb', 'fade'].includes(node.name)) {
          const args = node.args.map(constValue);
          if (args.every((v) => v !== undefined)) return FUNCS[node.name].fn({ n: 1 }, node, ...args);
        }
        return undefined;
      default: return undefined;
    }
  }

  // ------------------------------------------------------------------ evaluation
  function makeContext(bars) {
    const n = bars.length, cache = {};
    const get = (name) => {
      if (cache[name]) return cache[name];
      let v;
      if (SOURCES.includes(name)) v = name === 'volume' ? bars.map((b) => b.v) : F.source(bars, name);
      else if (name === 'time') v = bars.map((b) => b.t);
      else if (name === 'bar_index') v = bars.map((_, i) => i);
      else {
        const part = { hour: 'getHours', minute: 'getMinutes', dayofweek: 'getDay', dayofmonth: 'getDate', month: 'getMonth', year: 'getFullYear' }[name];
        v = bars.map((b) => { const d = new Date(b.t); const r = d[part](); return name === 'month' ? r + 1 : name === 'dayofweek' ? r + 1 : r; });
      }
      return (cache[name] = v);
    };
    return { bars, n, get, vars: new Map() };
  }

  function ev(node, ctx) {
    switch (node.type) {
      case 'num': return node.value;
      case 'color': return node.value;
      case 'var': {
        if (ctx.vars.has(node.name)) return ctx.vars.get(node.name);
        if (node.name in CONSTANTS) return CONSTANTS[node.name];
        if (node.name in COLORS) return COLORS[node.name];
        return ctx.get(node.name);
      }
      case 'un': {
        const v = ev(node.arg, ctx);
        if (node.op === 'not') return map1(v, (x) => (truthy(x) ? 0 : 1), ctx.n);
        return map1(v, (x) => -num(x), ctx.n);
      }
      case 'bin': {
        const a = ev(node.left, ctx), b = ev(node.right, ctx);
        if (ARITH.has(node.op)) {
          const bad = (v) => typeof v === 'string' || (isArr(v) && typeof v[v.length - 1] === 'string');
          if (bad(a) || bad(b)) fail(`Colors can't be used with "${node.op}"`, node);
        }
        return map2(a, b, BINOPS[node.op], ctx.n);
      }
      case 'tern': {
        const k = ev(node.cond, ctx), a = ev(node.a, ctx), b = ev(node.b, ctx);
        return mapN([k, a, b], (x, y, z) => (truthy(x) ? y : z), ctx.n);
      }
      case 'hist': {
        const v = ev(node.target, ctx), k = ev(node.offset, ctx);
        if (isArr(k) || typeof k !== 'number' || !(k >= 0)) fail('The number in [ ] must be a whole number of bars back, like close[1]', node);
        const off = Math.round(k);
        if (!isArr(v)) return v;
        const out = new Array(ctx.n);
        for (let i = 0; i < ctx.n; i++) out[i] = i >= off ? v[i - off] : typeof v[0] === 'string' ? undefined : NaN;
        return out;
      }
      case 'call': {
        const f = FUNCS[node.name];
        return f.fn(ctx, node, ...node.args.map((a) => ev(a, ctx)));
      }
    }
    fail('Internal error: unknown expression', node);
  }

  function nodeText(src, node) {
    // best-effort label: the source text of the plotted expression on its line
    const line = src.split('\n')[node.line - 1] || '';
    return line.slice(node.col - 1).replace(/\s*(".*)?$/, '').replace(/\s+(color|width|style|position)\b.*$/, '').trim().slice(0, 28) || 'Plot';
  }

  // ------------------------------------------------------------------ compile to an indicator definition
  function compile(code, scriptId = 'draft') {
    const stmts = parse(code);
    check(stmts);
    const meta = { name: 'Custom script', short: null, overlay: false };
    const inputs = [], plots = [], fills = [], levels = [];
    let bandFill = null, plotN = 0, markN = 0, fillN = 0;
    const steps = []; // runtime steps in order

    const colorOpt = (opt, fallback) => {
      if (!opt) return { color: fallback, dyn: null };
      const v = constValue(opt);
      if (typeof v === 'string') return { color: v, dyn: null };
      if (typeof v === 'number') fail('A color must be a color like red, #3D8BFD or rgba(…), not a number', opt);
      return { color: fallback, dyn: opt }; // decided per bar
    };
    const numOpt = (opt, what) => {
      if (!opt) return undefined;
      const v = constValue(opt);
      if (typeof v !== 'number' || !isFinite(v)) fail(`${what} must be a fixed number`, opt);
      return v;
    };

    for (const st of stmts) {
      switch (st.kind) {
        case 'name': meta.name = st.value || meta.name; break;
        case 'short': meta.short = st.value; break;
        case 'overlay': meta.overlay = true; break;
        case 'pane': meta.overlay = false; break;
        case 'input': {
          const inp = { key: st.name, label: st.label || st.name, def: st.value };
          if (st.vtype === 'source') inp.type = 'source';
          else if (st.vtype === 'bool') { inp.type = 'select'; inp.options = ['true', 'false']; inp.def = st.value ? 'true' : 'false'; }
          else {
            inp.type = st.vtype;
            const mn = numOpt(st.opts.min, 'min'), mx = numOpt(st.opts.max, 'max'), sp = numOpt(st.opts.step, 'step');
            if (mn !== undefined) inp.min = mn;
            if (mx !== undefined) inp.max = mx;
            if (sp !== undefined) inp.step = sp;
            if (st.vtype === 'float' && inp.step === undefined) inp.step = 0.1;
          }
          inputs.push(inp);
          steps.push({ kind: 'input', st, inp });
          break;
        }
        case 'assign': steps.push({ kind: 'assign', st }); break;
        case 'plot': {
          const key = 'p' + plotN, style = st.opts.style ? st.opts.style.word : 'line';
          const { color, dyn } = colorOpt(st.opts.color, PALETTE[plotN % PALETTE.length]);
          const width = numOpt(st.opts.width, 'width');
          plots.push({
            key, name: st.label || nodeText(code, st.expr), color, dynamic: !!dyn,
            style: style === 'columns' ? 'histogram' : style, width: width !== undefined ? Math.max(0.5, Math.min(8, width)) : 1.5,
          });
          plotN++;
          steps.push({ kind: 'series', key, expr: st.expr, colorExpr: dyn, st });
          break;
        }
        case 'mark': {
          const key = 'm' + markN++;
          const { color, dyn } = colorOpt(st.opts.color, COLORS.green);
          plots.push({ key, name: st.label || 'Mark', text: st.label || '', color, dynamic: !!dyn, style: 'mark', position: st.opts.position ? st.opts.position.word : 'above' });
          steps.push({ kind: 'series', key, expr: st.expr, colorExpr: dyn, st, bool: true });
          break;
        }
        case 'level': {
          const v = constValue(st.expr);
          if (typeof v !== 'number' || !isFinite(v)) fail('level needs a fixed number, e.g.  level 70', st.expr);
          levels.push(v);
          break;
        }
        case 'fill': {
          const a = constValue(st.a), b = constValue(st.b);
          const { color, dyn } = colorOpt(st.opts.color, 'rgba(61,139,253,0.10)');
          if (typeof a === 'number' && typeof b === 'number' && !dyn && !bandFill) { bandFill = [a, b]; meta.bandColor = color; break; }
          const key = 'f' + fillN++;
          fills.push({ key, from: key + 'a', to: key + 'b', color, dynamic: !!dyn });
          steps.push({ kind: 'fill', key, st, colorExpr: dyn });
          break;
        }
      }
    }
    if (!plots.length && !fills.length && !bandFill) fail('Nothing to draw yet: add a line like  plot sma(close, 20)', { line: (stmts[stmts.length - 1] || {}).line || 1, col: 1 });

    const toNumbers = (v, n, node, what) => {
      if (typeof v === 'string' || (isArr(v) && v.some((x) => typeof x === 'string'))) fail(`${what} needs numbers, but this is a color`, node);
      return series(v, n);
    };
    const toColors = (v, n, node) => {
      if (typeof v === 'number' || (isArr(v) && v.some((x) => typeof x === 'number' && x === x))) fail('A color must be a color like red, #3D8BFD or rgba(…), not a number', node);
      return series(v, n);
    };

    const definition = {
      id: 'script:' + scriptId, script: true, scriptId,
      name: meta.name, short: meta.short || meta.name.split(/\s+/).slice(0, 3).join(' ').slice(0, 18),
      overlay: meta.overlay, desc: 'Custom script',
      inputs, plots, fills, levels: levels.length ? levels : undefined, bandFill: bandFill || undefined,
      calc(bars, params) {
        const ctx = makeContext(bars), out = {}, n = bars.length;
        for (const step of steps) {
          const { st } = step;
          if (step.kind === 'input') {
            const raw = params[st.name] ?? step.inp.def;
            ctx.vars.set(st.name, st.vtype === 'source' ? ctx.get(SOURCES.includes(raw) ? raw : 'close') : st.vtype === 'bool' ? (raw === 'true' || raw === true ? 1 : 0) : +raw);
          } else if (step.kind === 'assign') ctx.vars.set(st.name, ev(st.expr, ctx));
          else if (step.kind === 'series') {
            const v = toNumbers(ev(step.expr, ctx), n, step.expr, step.bool ? 'mark' : 'plot');
            out[step.key] = step.bool ? v.map((x) => (truthy(x) ? 1 : 0)) : v;
            if (step.colorExpr) out[step.key + '$c'] = toColors(ev(step.colorExpr, ctx), n, step.colorExpr);
          } else if (step.kind === 'fill') {
            out[step.key + 'a'] = toNumbers(ev(st.a, ctx), n, st.a, 'fill');
            out[step.key + 'b'] = toNumbers(ev(st.b, ctx), n, st.b, 'fill');
            if (step.colorExpr) out[step.key + '$c'] = toColors(ev(step.colorExpr, ctx), n, step.colorExpr);
          }
        }
        return out;
      },
    };
    if (meta.bandColor) definition.bandColor = meta.bandColor;
    return definition;
  }

  // ------------------------------------------------------------------ editor support
  // Token classes for syntax highlighting (never throws).
  function highlight(code) {
    const toks = lex(code, true);
    let html = '', pos = 0;
    const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const prevSig = [];
    for (const t of toks) {
      if (t.start > pos) html += esc(code.slice(pos, t.start));
      let cls = '';
      if (t.type === 'comment') cls = 'tk-com';
      else if (t.type === 'num') cls = 'tk-num';
      else if (t.type === 'str') cls = 'tk-str';
      else if (t.type === 'color') cls = 'tk-col';
      else if (t.type === 'bad') cls = 'tk-bad';
      else if (t.type === 'ident') {
        const first = !prevSig.length || prevSig[prevSig.length - 1].type === 'nl';
        if (first && KEYWORDS.includes(t.value)) cls = 'tk-kw';
        else if (WORD_OPS.includes(t.value)) cls = 'tk-op';
        else if (FUNCS[t.value]) cls = 'tk-fn';
        else if (BUILTIN_NAMES.includes(t.value)) cls = 'tk-bi';
        else if (['color', 'width', 'style', 'position', 'min', 'max', 'step', 'histogram', 'line', 'dots', 'columns', 'above', 'below'].includes(t.value)) cls = 'tk-opt';
      } else if (t.type === 'punct') cls = 'tk-op';
      if (t.type === 'color') {
        html += `<span class="tk-col"><i class="tk-swatch" style="background:${t.text.length === 4 || t.text.length === 7 || t.text.length === 5 || t.text.length === 9 ? t.text : 'transparent'}"></i>${esc(t.text)}</span>`;
      } else html += cls ? `<span class="${cls}">${esc(t.text)}</span>` : esc(t.text);
      pos = t.end;
      if (t.type !== 'ws' && t.type !== 'comment') prevSig.push(t);
    }
    if (pos < code.length) html += esc(code.slice(pos));
    return html + '\n';
  }

  const STATEMENTS = [
    ['name "Title"', 'Name shown in the legend and indicator list'],
    ['short "Abbr"', 'Short label for the legend (optional)'],
    ['overlay', 'Draw on the price chart instead of a separate pane'],
    ['input x = 14 "Label" min 1 max 200', 'A setting people can change. Defaults: a number, true/false, or a source like close'],
    ['x = expression', 'Name a calculation to reuse it'],
    ['plot x "Label" color red width 2 style line', 'Draw a series. Styles: line, histogram, dots'],
    ['mark condition "Buy" below color green', 'Draw a marker on bars where condition is true (above or below)'],
    ['level 70', 'A dashed horizontal line (pane indicators)'],
    ['fill a, b color fade(blue, 0.1)', 'Shade the area between two series or two levels'],
  ];
  const OPERATORS = [
    ['+ - * / % ^', 'Arithmetic, bar by bar'],
    ['< <= > >= == !=', 'Comparisons: true (1) or false (0)'],
    ['and  or  not', 'Combine conditions'],
    ['cond ? a : b', 'Pick a or b on each bar'],
    ['x[1]', 'Value of x one bar ago (x[2]: two bars ago…)'],
  ];

  function reference() {
    const groups = {};
    for (const [name, f] of Object.entries(FUNCS)) (groups[f.group] = groups[f.group] || []).push([f.sig, f.doc, name]);
    return {
      statements: STATEMENTS, operators: OPERATORS, functions: groups,
      series: [[SOURCES.join(', '), 'Price and volume of each bar'], [TIME_SERIES.join(', '), 'Bar time; dayofweek is 1 (Sunday) to 7'], ['na, true, false, pi', 'Constants']],
      colors: Object.entries(COLORS),
    };
  }

  window.CandelaScript = { compile, parse, lex, highlight, reference, ScriptError, FUNCS, COLORS };
})();
