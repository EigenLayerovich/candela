/* Candela — technical indicators.
 * Every indicator is a pure function of the bar array; outputs are arrays aligned
 * with the bars (NaN where the value is undefined). */
(function () {
  'use strict';

  // ---------- primitives ----------
  const nanArr = (n) => new Array(n).fill(NaN);

  function source(bars, s) {
    const n = bars.length, out = new Array(n);
    for (let i = 0; i < n; i++) {
      const b = bars[i];
      switch (s) {
        case 'open': out[i] = b.o; break;
        case 'high': out[i] = b.h; break;
        case 'low': out[i] = b.l; break;
        case 'hl2': out[i] = (b.h + b.l) / 2; break;
        case 'hlc3': out[i] = (b.h + b.l + b.c) / 3; break;
        case 'ohlc4': out[i] = (b.o + b.h + b.l + b.c) / 4; break;
        default: out[i] = b.c;
      }
    }
    return out;
  }

  function sma(a, n) {
    const out = nanArr(a.length);
    let sum = 0, cnt = 0;
    for (let i = 0; i < a.length; i++) {
      const v = a[i];
      if (v !== v) { sum = 0; cnt = 0; continue; }
      sum += v; cnt++;
      if (cnt > n) { sum -= a[i - n]; cnt = n; }
      if (cnt === n) out[i] = sum / n;
    }
    return out;
  }

  // Exponential smoothing seeded with an SMA (alpha = 2/(n+1) for EMA, 1/n for Wilder's RMA)
  function smooth(a, n, alpha) {
    const out = nanArr(a.length);
    let prev = NaN, sum = 0, cnt = 0;
    for (let i = 0; i < a.length; i++) {
      const v = a[i];
      if (v !== v) continue;
      if (prev !== prev) {
        sum += v; cnt++;
        if (cnt === n) { prev = sum / n; out[i] = prev; }
      } else {
        prev = alpha * v + (1 - alpha) * prev;
        out[i] = prev;
      }
    }
    return out;
  }
  const ema = (a, n) => smooth(a, n, 2 / (n + 1));
  const rma = (a, n) => smooth(a, n, 1 / n);

  function wma(a, n) {
    const out = nanArr(a.length), denom = (n * (n + 1)) / 2;
    for (let i = n - 1; i < a.length; i++) {
      let s = 0, ok = true;
      for (let j = 0; j < n; j++) {
        const v = a[i - n + 1 + j];
        if (v !== v) { ok = false; break; }
        s += v * (j + 1);
      }
      if (ok) out[i] = s / denom;
    }
    return out;
  }

  function stdev(a, n) {
    const out = nanArr(a.length);
    for (let i = n - 1; i < a.length; i++) {
      let s = 0, s2 = 0, ok = true;
      for (let j = i - n + 1; j <= i; j++) {
        const v = a[j];
        if (v !== v) { ok = false; break; }
        s += v; s2 += v * v;
      }
      if (ok) { const m = s / n; out[i] = Math.sqrt(Math.max(0, s2 / n - m * m)); }
    }
    return out;
  }

  function highest(a, n) {
    const out = nanArr(a.length);
    for (let i = n - 1; i < a.length; i++) {
      let m = -Infinity;
      for (let j = i - n + 1; j <= i; j++) if (a[j] > m) m = a[j];
      out[i] = m;
    }
    return out;
  }
  function lowest(a, n) {
    const out = nanArr(a.length);
    for (let i = n - 1; i < a.length; i++) {
      let m = Infinity;
      for (let j = i - n + 1; j <= i; j++) if (a[j] < m) m = a[j];
      out[i] = m;
    }
    return out;
  }

  function trueRange(bars) {
    return bars.map((b, i) => i === 0 ? b.h - b.l
      : Math.max(b.h - b.l, Math.abs(b.h - bars[i - 1].c), Math.abs(b.l - bars[i - 1].c)));
  }
  const atr = (bars, n) => rma(trueRange(bars), n);

  function maOf(type, a, n) {
    switch (type) {
      case 'EMA': return ema(a, n);
      case 'WMA': return wma(a, n);
      case 'RMA': return rma(a, n);
      default: return sma(a, n);
    }
  }

  function rsiOf(a, n) {
    const up = a.map((v, i) => i === 0 ? NaN : Math.max(v - a[i - 1], 0));
    const dn = a.map((v, i) => i === 0 ? NaN : Math.max(a[i - 1] - v, 0));
    const ru = rma(up, n), rd = rma(dn, n);
    return ru.map((u, i) => {
      const d = rd[i];
      if (u !== u || d !== d) return NaN;
      if (d === 0) return 100;
      if (u === 0) return 0;
      return 100 - 100 / (1 + u / d);
    });
  }

  // ---------- definitions ----------
  const SRC = { key: 'source', label: 'Source', type: 'source', def: 'close' };
  const LEN = (d) => ({ key: 'length', label: 'Length', type: 'int', def: d, min: 1, max: 2000 });
  const MA_TYPES = ['SMA', 'EMA', 'WMA', 'RMA'];

  const DEFS = [
    {
      id: 'vol', name: 'Volume', short: 'Vol', overlay: true, scale: 'volume',
      desc: 'Traded volume, colored by candle direction',
      inputs: [{ key: 'maLength', label: 'MA length (0 = off)', type: 'int', def: 20, min: 0, max: 500 }],
      plots: [
        { key: 'vol', name: 'Volume', style: 'histogram', palette: ['rgba(34,171,148,0.45)', 'rgba(247,82,95,0.45)'], format: 'volume' },
        { key: 'ma', name: 'Volume MA', color: '#3D8BFD', format: 'volume' },
      ],
      calc(bars, p) {
        const vol = bars.map((b) => b.v);
        return {
          vol, vol$i: bars.map((b) => (b.c >= b.o ? 0 : 1)),
          ma: p.maLength > 0 ? sma(vol, p.maLength) : nanArr(bars.length),
        };
      },
    },
    {
      id: 'sma', name: 'Moving Average (SMA)', short: 'SMA', overlay: true,
      desc: 'Simple moving average',
      inputs: [LEN(20), SRC],
      plots: [{ key: 'ma', name: 'SMA', color: '#F5A623' }],
      calc: (bars, p) => ({ ma: sma(source(bars, p.source), p.length) }),
    },
    {
      id: 'ema', name: 'Exponential Moving Average (EMA)', short: 'EMA', overlay: true,
      desc: 'Exponentially weighted moving average',
      inputs: [LEN(20), SRC],
      plots: [{ key: 'ma', name: 'EMA', color: '#3D8BFD' }],
      calc: (bars, p) => ({ ma: ema(source(bars, p.source), p.length) }),
    },
    {
      id: 'wma', name: 'Weighted Moving Average (WMA)', short: 'WMA', overlay: true,
      desc: 'Linearly weighted moving average',
      inputs: [LEN(20), SRC],
      plots: [{ key: 'ma', name: 'WMA', color: '#E040FB' }],
      calc: (bars, p) => ({ ma: wma(source(bars, p.source), p.length) }),
    },
    {
      id: 'ma_ribbon', name: 'Moving Average Ribbon', short: 'MA Ribbon', overlay: true,
      desc: 'Four moving averages at once (20/50/100/200 by default)',
      inputs: [
        { key: 'type', label: 'MA type', type: 'select', options: MA_TYPES, def: 'EMA' },
        { key: 'l1', label: 'Length 1', type: 'int', def: 20, min: 1 },
        { key: 'l2', label: 'Length 2', type: 'int', def: 50, min: 1 },
        { key: 'l3', label: 'Length 3', type: 'int', def: 100, min: 1 },
        { key: 'l4', label: 'Length 4', type: 'int', def: 200, min: 1 },
        SRC,
      ],
      plots: [
        { key: 'm1', name: 'MA 1', color: '#F9D71C' }, { key: 'm2', name: 'MA 2', color: '#F5A623' },
        { key: 'm3', name: 'MA 3', color: '#F7525F' }, { key: 'm4', name: 'MA 4', color: '#B455D9' },
      ],
      calc(bars, p) {
        const s = source(bars, p.source);
        return { m1: maOf(p.type, s, p.l1), m2: maOf(p.type, s, p.l2), m3: maOf(p.type, s, p.l3), m4: maOf(p.type, s, p.l4) };
      },
    },
    {
      id: 'bb', name: 'Bollinger Bands', short: 'BB', overlay: true,
      desc: 'SMA with bands at N standard deviations',
      inputs: [LEN(20), { key: 'mult', label: 'StdDev', type: 'float', def: 2, min: 0.1, step: 0.1 }, SRC],
      plots: [
        { key: 'basis', name: 'Basis', color: '#F5A623' },
        { key: 'upper', name: 'Upper', color: '#3D8BFD' },
        { key: 'lower', name: 'Lower', color: '#3D8BFD' },
      ],
      fills: [{ key: 'bg', from: 'upper', to: 'lower', color: 'rgba(61,139,253,0.08)' }],
      calc(bars, p) {
        const s = source(bars, p.source), m = sma(s, p.length), sd = stdev(s, p.length);
        return { basis: m, upper: m.map((v, i) => v + p.mult * sd[i]), lower: m.map((v, i) => v - p.mult * sd[i]) };
      },
    },
    {
      id: 'kc', name: 'Keltner Channels', short: 'KC', overlay: true,
      desc: 'EMA with ATR-based envelope',
      inputs: [LEN(20), { key: 'mult', label: 'Multiplier', type: 'float', def: 2, min: 0.1, step: 0.1 }, { key: 'atrLength', label: 'ATR length', type: 'int', def: 10, min: 1 }],
      plots: [
        { key: 'basis', name: 'Basis', color: '#3D8BFD' },
        { key: 'upper', name: 'Upper', color: '#3D8BFD' },
        { key: 'lower', name: 'Lower', color: '#3D8BFD' },
      ],
      fills: [{ key: 'bg', from: 'upper', to: 'lower', color: 'rgba(61,139,253,0.06)' }],
      calc(bars, p) {
        const m = ema(source(bars, 'close'), p.length), a = atr(bars, p.atrLength);
        return { basis: m, upper: m.map((v, i) => v + p.mult * a[i]), lower: m.map((v, i) => v - p.mult * a[i]) };
      },
    },
    {
      id: 'donchian', name: 'Donchian Channels', short: 'DC', overlay: true,
      desc: 'Highest high / lowest low channel',
      inputs: [LEN(20)],
      plots: [
        { key: 'upper', name: 'Upper', color: '#3D8BFD' },
        { key: 'basis', name: 'Basis', color: '#F5A623' },
        { key: 'lower', name: 'Lower', color: '#3D8BFD' },
      ],
      fills: [{ key: 'bg', from: 'upper', to: 'lower', color: 'rgba(61,139,253,0.06)' }],
      calc(bars, p) {
        const u = highest(bars.map((b) => b.h), p.length), l = lowest(bars.map((b) => b.l), p.length);
        return { upper: u, lower: l, basis: u.map((v, i) => (v + l[i]) / 2) };
      },
    },
    {
      id: 'vwap', name: 'VWAP', short: 'VWAP', overlay: true,
      desc: 'Volume-weighted average price, anchored to a session',
      inputs: [{ key: 'anchor', label: 'Anchor', type: 'select', options: ['Session', 'Week', 'Month'], def: 'Session' }],
      plots: [{ key: 'vwap', name: 'VWAP', color: '#2EC4B6', width: 2 }],
      calc(bars, p) {
        const out = nanArr(bars.length);
        let pv = 0, vv = 0, key = null;
        for (let i = 0; i < bars.length; i++) {
          const b = bars[i], d = new Date(b.t);
          let k;
          if (p.anchor === 'Month') k = d.getUTCFullYear() * 12 + d.getUTCMonth();
          else if (p.anchor === 'Week') k = Math.floor((b.t / 86400000 + 3) / 7); // weeks start Monday
          else k = Math.floor(b.t / 86400000);
          if (k !== key) { pv = 0; vv = 0; key = k; }
          const tp = (b.h + b.l + b.c) / 3;
          pv += tp * b.v; vv += b.v;
          out[i] = vv > 0 ? pv / vv : tp;
        }
        return { vwap: out };
      },
    },
    {
      id: 'supertrend', name: 'Supertrend', short: 'Supertrend', overlay: true,
      desc: 'ATR trailing stop that flips with the trend',
      inputs: [{ key: 'atrLength', label: 'ATR length', type: 'int', def: 10, min: 1 }, { key: 'factor', label: 'Factor', type: 'float', def: 3, min: 0.1, step: 0.1 }],
      plots: [
        { key: 'up', name: 'Up trend', color: '#22AB94', width: 2 },
        { key: 'down', name: 'Down trend', color: '#F7525F', width: 2 },
      ],
      calc(bars, p) {
        const n = bars.length, a = atr(bars, p.atrLength), up = nanArr(n), down = nanArr(n);
        let fu = NaN, fl = NaN, dir = 1;
        for (let i = 0; i < n; i++) {
          if (a[i] !== a[i]) continue;
          const b = bars[i], hl2 = (b.h + b.l) / 2, prevC = i ? bars[i - 1].c : b.c;
          let bu = hl2 + p.factor * a[i], bl = hl2 - p.factor * a[i];
          if (fu === fu && !(bu < fu || prevC > fu)) bu = fu;
          if (fl === fl && !(bl > fl || prevC < fl)) bl = fl;
          if (fu === fu) {
            if (dir === 1 && b.c < bl) dir = -1;
            else if (dir === -1 && b.c > bu) dir = 1;
          }
          fu = bu; fl = bl;
          if (dir === 1) up[i] = bl; else down[i] = bu;
        }
        return { up, down };
      },
    },
    {
      id: 'psar', name: 'Parabolic SAR', short: 'SAR', overlay: true,
      desc: 'Stop-and-reverse trailing dots',
      inputs: [
        { key: 'start', label: 'Start', type: 'float', def: 0.02, min: 0.001, step: 0.01 },
        { key: 'inc', label: 'Increment', type: 'float', def: 0.02, min: 0.001, step: 0.01 },
        { key: 'max', label: 'Max', type: 'float', def: 0.2, min: 0.01, step: 0.01 },
      ],
      plots: [{ key: 'sar', name: 'SAR', color: '#3D8BFD', style: 'dots' }],
      calc(bars, p) {
        const n = bars.length, out = nanArr(n);
        if (n < 2) return { sar: out };
        let long = bars[1].c >= bars[0].c, af = p.start;
        let ep = long ? Math.max(bars[0].h, bars[1].h) : Math.min(bars[0].l, bars[1].l);
        let sar = long ? Math.min(bars[0].l, bars[1].l) : Math.max(bars[0].h, bars[1].h);
        for (let i = 2; i < n; i++) {
          const b = bars[i];
          sar = sar + af * (ep - sar);
          if (long) {
            sar = Math.min(sar, bars[i - 1].l, bars[i - 2].l);
            if (b.l < sar) { long = false; sar = ep; ep = b.l; af = p.start; }
            else if (b.h > ep) { ep = b.h; af = Math.min(af + p.inc, p.max); }
          } else {
            sar = Math.max(sar, bars[i - 1].h, bars[i - 2].h);
            if (b.h > sar) { long = true; sar = ep; ep = b.h; af = p.start; }
            else if (b.l < ep) { ep = b.l; af = Math.min(af + p.inc, p.max); }
          }
          out[i] = sar;
        }
        return { sar: out };
      },
    },
    {
      id: 'ichimoku', name: 'Ichimoku Cloud (lines)', short: 'Ichimoku', overlay: true,
      desc: 'Conversion, base and displaced leading spans with cloud',
      inputs: [
        { key: 'conv', label: 'Conversion', type: 'int', def: 9, min: 1 },
        { key: 'base', label: 'Base', type: 'int', def: 26, min: 1 },
        { key: 'spanB', label: 'Leading span B', type: 'int', def: 52, min: 1 },
        { key: 'disp', label: 'Displacement', type: 'int', def: 26, min: 0 },
      ],
      plots: [
        { key: 'conv', name: 'Conversion', color: '#3D8BFD' },
        { key: 'base', name: 'Base', color: '#B23A48' },
        { key: 'a', name: 'Lead A', color: '#22AB94' },
        { key: 'b', name: 'Lead B', color: '#F7525F' },
      ],
      fills: [{ key: 'cloud', from: 'a', to: 'b', color: 'rgba(34,171,148,0.12)', colorDown: 'rgba(247,82,95,0.12)' }],
      calc(bars, p) {
        const H = bars.map((b) => b.h), L = bars.map((b) => b.l);
        const mid = (n) => { const h = highest(H, n), l = lowest(L, n); return h.map((v, i) => (v + l[i]) / 2); };
        const conv = mid(p.conv), base = mid(p.base), sb = mid(p.spanB);
        const sa = conv.map((v, i) => (v + base[i]) / 2);
        // Spans are projected forward by `disp` bars: value shown at bar i was computed at i - disp.
        const shift = (arr) => arr.map((_, i) => (i - p.disp >= 0 ? arr[i - p.disp] : NaN));
        return { conv, base, a: shift(sa), b: shift(sb) };
      },
    },
    // ---------------- oscillators (own pane) ----------------
    {
      id: 'rsi', name: 'Relative Strength Index', short: 'RSI', overlay: false,
      desc: 'Momentum oscillator (0–100), overbought 70 / oversold 30',
      inputs: [LEN(14), SRC, { key: 'maLength', label: 'Signal MA (0 = off)', type: 'int', def: 14, min: 0 }],
      plots: [{ key: 'rsi', name: 'RSI', color: '#9C6ADE', width: 1.5 }, { key: 'ma', name: 'MA', color: '#F5A623' }],
      levels: [70, 50, 30], bandFill: [70, 30], range: [0, 100],
      calc(bars, p) {
        const r = rsiOf(source(bars, p.source), p.length);
        return { rsi: r, ma: p.maLength > 0 ? sma(r, p.maLength) : nanArr(bars.length) };
      },
    },
    {
      id: 'macd', name: 'MACD', short: 'MACD', overlay: false,
      desc: 'Moving Average Convergence Divergence',
      inputs: [
        { key: 'fast', label: 'Fast length', type: 'int', def: 12, min: 1 },
        { key: 'slow', label: 'Slow length', type: 'int', def: 26, min: 1 },
        { key: 'signal', label: 'Signal length', type: 'int', def: 9, min: 1 },
        SRC,
      ],
      plots: [
        { key: 'hist', name: 'Histogram', style: 'histogram', palette: ['#22AB94', '#9FDCCF', '#FAB3B9', '#F7525F'] },
        { key: 'macd', name: 'MACD', color: '#3D8BFD', width: 1.5 },
        { key: 'signal', name: 'Signal', color: '#F5A623', width: 1.5 },
      ],
      levels: [0],
      calc(bars, p) {
        const s = source(bars, p.source), f = ema(s, p.fast), sl = ema(s, p.slow);
        const macd = f.map((v, i) => v - sl[i]);
        const sig = ema(macd, p.signal);
        const hist = macd.map((v, i) => v - sig[i]);
        const idx = hist.map((h, i) => {
          const prev = i ? hist[i - 1] : NaN;
          if (h >= 0) return prev === prev && h < prev ? 1 : 0;
          return prev === prev && h > prev ? 2 : 3;
        });
        return { macd, signal: sig, hist, hist$i: idx };
      },
    },
    {
      id: 'stoch', name: 'Stochastic', short: 'Stoch', overlay: false,
      desc: '%K / %D stochastic oscillator',
      inputs: [
        { key: 'k', label: '%K length', type: 'int', def: 14, min: 1 },
        { key: 'smoothK', label: '%K smoothing', type: 'int', def: 1, min: 1 },
        { key: 'd', label: '%D smoothing', type: 'int', def: 3, min: 1 },
      ],
      plots: [{ key: 'k', name: '%K', color: '#3D8BFD' }, { key: 'd', name: '%D', color: '#F5A623' }],
      levels: [80, 50, 20], bandFill: [80, 20], range: [0, 100],
      calc(bars, p) {
        const hh = highest(bars.map((b) => b.h), p.k), ll = lowest(bars.map((b) => b.l), p.k);
        const raw = bars.map((b, i) => (hh[i] - ll[i] === 0 ? 50 : (100 * (b.c - ll[i])) / (hh[i] - ll[i])));
        for (let i = 0; i < p.k - 1 && i < raw.length; i++) raw[i] = NaN;
        const k = sma(raw, p.smoothK);
        return { k, d: sma(k, p.d) };
      },
    },
    {
      id: 'stochrsi', name: 'Stochastic RSI', short: 'Stoch RSI', overlay: false,
      desc: 'Stochastic applied to RSI',
      inputs: [
        { key: 'k', label: 'K', type: 'int', def: 3, min: 1 }, { key: 'd', label: 'D', type: 'int', def: 3, min: 1 },
        { key: 'rsiLength', label: 'RSI length', type: 'int', def: 14, min: 1 },
        { key: 'stochLength', label: 'Stochastic length', type: 'int', def: 14, min: 1 }, SRC,
      ],
      plots: [{ key: 'k', name: 'K', color: '#3D8BFD' }, { key: 'd', name: 'D', color: '#F5A623' }],
      levels: [80, 50, 20], bandFill: [80, 20], range: [0, 100],
      calc(bars, p) {
        const r = rsiOf(source(bars, p.source), p.rsiLength);
        const n = p.stochLength, raw = nanArr(r.length);
        for (let i = n - 1; i < r.length; i++) {
          let hi = -Infinity, lo = Infinity, ok = true;
          for (let j = i - n + 1; j <= i; j++) { if (r[j] !== r[j]) { ok = false; break; } hi = Math.max(hi, r[j]); lo = Math.min(lo, r[j]); }
          if (ok) raw[i] = hi === lo ? 50 : (100 * (r[i] - lo)) / (hi - lo);
        }
        const k = sma(raw, p.k);
        return { k, d: sma(k, p.d) };
      },
    },
    {
      id: 'cci', name: 'Commodity Channel Index', short: 'CCI', overlay: false,
      desc: 'Deviation of typical price from its mean',
      inputs: [LEN(20), { ...SRC, def: 'hlc3' }],
      plots: [{ key: 'cci', name: 'CCI', color: '#2EC4B6' }],
      levels: [100, 0, -100], bandFill: [100, -100],
      calc(bars, p) {
        const s = source(bars, p.source), m = sma(s, p.length), n = p.length, out = nanArr(s.length);
        for (let i = n - 1; i < s.length; i++) {
          let md = 0;
          for (let j = i - n + 1; j <= i; j++) md += Math.abs(s[j] - m[i]);
          md /= n;
          out[i] = md === 0 ? 0 : (s[i] - m[i]) / (0.015 * md);
        }
        return { cci: out };
      },
    },
    {
      id: 'willr', name: 'Williams %R', short: '%R', overlay: false,
      desc: 'Close relative to the high-low range (−100…0)',
      inputs: [LEN(14)],
      plots: [{ key: 'r', name: '%R', color: '#9C6ADE' }],
      levels: [-20, -50, -80], bandFill: [-20, -80], range: [-100, 0],
      calc(bars, p) {
        const hh = highest(bars.map((b) => b.h), p.length), ll = lowest(bars.map((b) => b.l), p.length);
        return { r: bars.map((b, i) => (hh[i] - ll[i] === 0 ? -50 : (-100 * (hh[i] - b.c)) / (hh[i] - ll[i]))) };
      },
    },
    {
      id: 'mfi', name: 'Money Flow Index', short: 'MFI', overlay: false,
      desc: 'Volume-weighted RSI',
      inputs: [LEN(14)],
      plots: [{ key: 'mfi', name: 'MFI', color: '#9C6ADE' }],
      levels: [80, 50, 20], bandFill: [80, 20], range: [0, 100],
      calc(bars, p) {
        const tp = source(bars, 'hlc3'), n = p.length, out = nanArr(bars.length);
        for (let i = n; i < bars.length; i++) {
          let pos = 0, neg = 0;
          for (let j = i - n + 1; j <= i; j++) {
            const mf = tp[j] * bars[j].v;
            if (tp[j] > tp[j - 1]) pos += mf; else if (tp[j] < tp[j - 1]) neg += mf;
          }
          out[i] = neg === 0 ? 100 : 100 - 100 / (1 + pos / neg);
        }
        return { mfi: out };
      },
    },
    {
      id: 'adx', name: 'ADX / DMI', short: 'DMI', overlay: false,
      desc: 'Average Directional Index with +DI / −DI',
      inputs: [{ key: 'diLength', label: 'DI length', type: 'int', def: 14, min: 1 }, { key: 'adxSmoothing', label: 'ADX smoothing', type: 'int', def: 14, min: 1 }],
      plots: [
        { key: 'adx', name: 'ADX', color: '#F7525F', width: 1.5 },
        { key: 'plus', name: '+DI', color: '#3D8BFD' },
        { key: 'minus', name: '−DI', color: '#F5A623' },
      ],
      levels: [25],
      calc(bars, p) {
        const n = bars.length, pdm = nanArr(n), mdm = nanArr(n);
        for (let i = 1; i < n; i++) {
          const up = bars[i].h - bars[i - 1].h, dn = bars[i - 1].l - bars[i].l;
          pdm[i] = up > dn && up > 0 ? up : 0;
          mdm[i] = dn > up && dn > 0 ? dn : 0;
        }
        const tr = trueRange(bars); tr[0] = NaN;
        const str = rma(tr, p.diLength), sp = rma(pdm, p.diLength), sm = rma(mdm, p.diLength);
        const plus = sp.map((v, i) => (100 * v) / str[i]), minus = sm.map((v, i) => (100 * v) / str[i]);
        const dx = plus.map((v, i) => { const s = v + minus[i]; return s === 0 ? 0 : (100 * Math.abs(v - minus[i])) / s; });
        return { plus, minus, adx: rma(dx, p.adxSmoothing) };
      },
    },
    {
      id: 'atr', name: 'Average True Range', short: 'ATR', overlay: false,
      desc: 'Volatility (Wilder smoothing)',
      inputs: [LEN(14)],
      plots: [{ key: 'atr', name: 'ATR', color: '#F7525F' }],
      calc: (bars, p) => ({ atr: atr(bars, p.length) }),
    },
    {
      id: 'obv', name: 'On Balance Volume', short: 'OBV', overlay: false,
      desc: 'Cumulative volume by close direction',
      inputs: [],
      plots: [{ key: 'obv', name: 'OBV', color: '#3D8BFD', format: 'volume' }],
      calc(bars) {
        let acc = 0;
        return { obv: bars.map((b, i) => { if (i) { if (b.c > bars[i - 1].c) acc += b.v; else if (b.c < bars[i - 1].c) acc -= b.v; } return acc; }) };
      },
    },
    {
      id: 'roc', name: 'Rate of Change', short: 'ROC', overlay: false,
      desc: 'Percent change over N bars',
      inputs: [LEN(9), SRC],
      plots: [{ key: 'roc', name: 'ROC', color: '#2EC4B6' }],
      levels: [0],
      calc(bars, p) {
        const s = source(bars, p.source);
        return { roc: s.map((v, i) => (i >= p.length ? (100 * (v - s[i - p.length])) / s[i - p.length] : NaN)) };
      },
    },
  ];

  // ================================================================ more indicators
  // ---------- helpers ----------
  function rsum(a, n) {
    const out = nanArr(a.length);
    let s = 0, cnt = 0;
    for (let i = 0; i < a.length; i++) {
      const v = a[i];
      if (v !== v) { s = 0; cnt = 0; continue; }
      s += v; cnt++;
      if (cnt > n) { s -= a[i - n]; cnt = n; }
      if (cnt === n) out[i] = s;
    }
    return out;
  }
  const change = (a, n = 1) => a.map((v, i) => (i >= n ? v - a[i - n] : NaN));
  const rocOf = (a, n) => a.map((v, i) => (i >= n && a[i - n] ? (100 * (v - a[i - n])) / a[i - n] : NaN));
  const shiftFwd = (a, k) => a.map((_, i) => (i - k >= 0 ? a[i - k] : NaN));
  const sub = (a, b) => a.map((v, i) => v - b[i]);
  const HL2 = (bars) => bars.map((b) => (b.h + b.l) / 2);
  const C = (bars) => bars.map((b) => b.c);
  const V = (bars) => bars.map((b) => b.v || 0);
  // the bars' interval in ms (median gap)
  function intervalOf(bars) {
    const g = [];
    for (let i = Math.max(1, bars.length - 200); i < bars.length; i++) g.push(bars[i].t - bars[i - 1].t);
    g.sort((x, y) => x - y);
    return g.length ? g[g.length >> 1] : 86400e3;
  }
  function linreg(a, n) {
    const out = nanArr(a.length), sx = (n * (n - 1)) / 2, sxx = ((n - 1) * n * (2 * n - 1)) / 6, den = n * sxx - sx * sx;
    for (let i = n - 1; i < a.length; i++) {
      let sy = 0, sxy = 0, ok = true;
      for (let j = 0; j < n; j++) { const v = a[i - n + 1 + j]; if (v !== v) { ok = false; break; } sy += v; sxy += j * v; }
      if (!ok) continue;
      const slope = den ? (n * sxy - sx * sy) / den : 0, icpt = (sy - slope * sx) / n;
      out[i] = icpt + slope * (n - 1);
    }
    return out;
  }
  const UPDN = ['#22AB94', '#F7525F'];
  const dirIdx = (a) => a.map((v, i) => (i && v < a[i - 1] ? 1 : 0)); // 0 rising (green), 1 falling (red)
  const MA_IN = (d, label = 'Length') => ({ key: 'length', label, type: 'int', def: d, min: 1, max: 2000 });

  const MORE = [
    // ---------------- moving averages and overlays ----------------
    {
      id: 'hma', name: 'Hull Moving Average', short: 'HMA', overlay: true, desc: 'Fast, smooth moving average with little lag',
      inputs: [LEN(9), SRC], plots: [{ key: 'ma', name: 'HMA', color: '#2EC4B6' }],
      calc(bars, p) { const s = source(bars, p.source), n = p.length; return { ma: wma(sub(wma(s, Math.max(1, Math.round(n / 2))).map((v) => 2 * v), wma(s, n)), Math.max(1, Math.round(Math.sqrt(n)))) }; },
    },
    {
      id: 'dema', name: 'Double EMA', short: 'DEMA', overlay: true, desc: 'Double exponential moving average (less lag)',
      inputs: [LEN(9), SRC], plots: [{ key: 'ma', name: 'DEMA', color: '#9C6ADE' }],
      calc(bars, p) { const e1 = ema(source(bars, p.source), p.length), e2 = ema(e1, p.length); return { ma: e1.map((v, i) => 2 * v - e2[i]) }; },
    },
    {
      id: 'tema', name: 'Triple EMA', short: 'TEMA', overlay: true, desc: 'Triple exponential moving average (even less lag)',
      inputs: [LEN(9), SRC], plots: [{ key: 'ma', name: 'TEMA', color: '#E040FB' }],
      calc(bars, p) { const e1 = ema(source(bars, p.source), p.length), e2 = ema(e1, p.length), e3 = ema(e2, p.length); return { ma: e1.map((v, i) => 3 * v - 3 * e2[i] + e3[i]) }; },
    },
    {
      id: 'vwma', name: 'Volume-Weighted Moving Average', short: 'VWMA', overlay: true, desc: 'Moving average weighted by volume',
      inputs: [LEN(20), SRC], plots: [{ key: 'ma', name: 'VWMA', color: '#3D8BFD' }],
      calc(bars, p) { const s = source(bars, p.source), v = V(bars), pv = rsum(s.map((x, i) => x * v[i]), p.length), vv = rsum(v, p.length); return { ma: pv.map((x, i) => (vv[i] ? x / vv[i] : NaN)) }; },
    },
    {
      id: 'alma', name: 'Arnaud Legoux Moving Average', short: 'ALMA', overlay: true, desc: 'Gaussian-weighted moving average',
      inputs: [LEN(9), { key: 'offset', label: 'Offset', type: 'float', def: 0.85, min: 0, max: 1, step: 0.05 }, { key: 'sigma', label: 'Sigma', type: 'float', def: 6, min: 0.1, step: 0.5 }, SRC],
      plots: [{ key: 'ma', name: 'ALMA', color: '#F5A623' }],
      calc(bars, p) {
        const s = source(bars, p.source), n = p.length, m = p.offset * (n - 1), sg = n / p.sigma, w = [];
        for (let j = 0; j < n; j++) w.push(Math.exp(-((j - m) ** 2) / (2 * sg * sg)));
        const ws = w.reduce((a, b) => a + b, 0), out = nanArr(s.length);
        for (let i = n - 1; i < s.length; i++) { let t = 0; for (let j = 0; j < n; j++) t += w[j] * s[i - n + 1 + j]; out[i] = t / ws; }
        return { ma: out };
      },
    },
    {
      id: 'smma', name: 'Smoothed Moving Average', short: 'SMMA', overlay: true, desc: 'Wilder\'s smoothed moving average (RMA)',
      inputs: [LEN(7), SRC], plots: [{ key: 'ma', name: 'SMMA', color: '#8BC34A' }],
      calc: (bars, p) => ({ ma: rma(source(bars, p.source), p.length) }),
    },
    {
      id: 'kama', name: 'Kaufman Adaptive Moving Average', short: 'KAMA', overlay: true, desc: 'Speeds up in trends, slows down in noise',
      inputs: [LEN(10), { key: 'fast', label: 'Fast length', type: 'int', def: 2, min: 1 }, { key: 'slow', label: 'Slow length', type: 'int', def: 30, min: 2 }, SRC],
      plots: [{ key: 'ma', name: 'KAMA', color: '#2EC4B6' }],
      calc(bars, p) {
        const s = source(bars, p.source), n = p.length, out = nanArr(s.length), f = 2 / (p.fast + 1), sl = 2 / (p.slow + 1);
        let k = NaN;
        for (let i = n; i < s.length; i++) {
          let vol = 0;
          for (let j = i - n + 1; j <= i; j++) vol += Math.abs(s[j] - s[j - 1]);
          const er = vol ? Math.abs(s[i] - s[i - n]) / vol : 0, sc = (er * (f - sl) + sl) ** 2;
          k = k !== k ? s[i - 1] : k;
          k += sc * (s[i] - k);
          out[i] = k;
        }
        return { ma: out };
      },
    },
    {
      id: 'lsma', name: 'Least Squares Moving Average', short: 'LSMA', overlay: true, desc: 'End point of a linear regression (linear regression curve)',
      inputs: [LEN(25), SRC], plots: [{ key: 'ma', name: 'LSMA', color: '#3D8BFD' }],
      calc: (bars, p) => ({ ma: linreg(source(bars, p.source), p.length) }),
    },
    {
      id: 'mcginley', name: 'McGinley Dynamic', short: 'McGinley', overlay: true, desc: 'Moving average that adjusts to the market\'s speed',
      inputs: [LEN(14), SRC], plots: [{ key: 'ma', name: 'McGinley', color: '#F7525F' }],
      calc(bars, p) {
        const s = source(bars, p.source), out = nanArr(s.length), e = ema(s, p.length);
        let md = NaN;
        for (let i = 0; i < s.length; i++) {
          if (md !== md) { md = e[i]; out[i] = md; continue; }
          md = md + (s[i] - md) / (p.length * Math.pow(s[i] / md, 4));
          out[i] = md;
        }
        return { ma: out };
      },
    },
    {
      id: 'env', name: 'Envelopes', short: 'Env', overlay: true, desc: 'A moving average with bands a fixed percentage above and below',
      inputs: [LEN(20), { key: 'pct', label: 'Percent', type: 'float', def: 10, min: 0.01, step: 0.5 }, { key: 'type', label: 'MA type', type: 'select', options: MA_TYPES, def: 'SMA' }, SRC],
      plots: [{ key: 'upper', name: 'Upper', color: '#F7525F' }, { key: 'basis', name: 'Basis', color: '#F5A623' }, { key: 'lower', name: 'Lower', color: '#22AB94' }],
      fills: [{ key: 'bg', from: 'upper', to: 'lower', color: 'rgba(61,139,253,0.05)' }],
      calc(bars, p) { const m = maOf(p.type, source(bars, p.source), p.length), k = p.pct / 100; return { basis: m, upper: m.map((v) => v * (1 + k)), lower: m.map((v) => v * (1 - k)) }; },
    },
    {
      id: 'pivots', name: 'Pivot Points Standard', short: 'Pivots', overlay: true, desc: 'Support and resistance levels from the previous day, week, month or year',
      inputs: [
        { key: 'type', label: 'Type', type: 'select', options: ['Traditional', 'Fibonacci', 'Woodie', 'Camarilla'], def: 'Traditional' },
        { key: 'period', label: 'Pivots timeframe', type: 'select', options: ['Auto', 'Day', 'Week', 'Month', 'Year'], def: 'Auto' },
      ],
      plots: [
        { key: 'r3', name: 'R3', color: '#F7525F', lineType: 'linebr' }, { key: 'r2', name: 'R2', color: '#F7525F', lineType: 'linebr' }, { key: 'r1', name: 'R1', color: '#F7525F', lineType: 'linebr' },
        { key: 'p', name: 'P', color: '#F5A623', lineType: 'linebr', width: 1.5 },
        { key: 's1', name: 'S1', color: '#22AB94', lineType: 'linebr' }, { key: 's2', name: 'S2', color: '#22AB94', lineType: 'linebr' }, { key: 's3', name: 'S3', color: '#22AB94', lineType: 'linebr' },
      ],
      calc(bars, p) {
        const iv = intervalOf(bars), D = 86400e3;
        let per = p.period;
        if (per === 'Auto') per = iv <= 15 * 60e3 ? 'Day' : iv < D ? 'Week' : iv <= D ? 'Month' : 'Year';
        const key = (t) => { const d = new Date(t); return per === 'Day' ? Math.floor(t / D) : per === 'Week' ? Math.floor((t / D + 3) / 7) : per === 'Month' ? d.getUTCFullYear() * 12 + d.getUTCMonth() : d.getUTCFullYear(); };
        const n = bars.length, out = { r3: nanArr(n), r2: nanArr(n), r1: nanArr(n), p: nanArr(n), s1: nanArr(n), s2: nanArr(n), s3: nanArr(n) };
        // the high, low and close of each period
        const per2 = [];
        for (let i = 0; i < n; i++) {
          const b = bars[i], kk = key(b.t), last = per2[per2.length - 1];
          if (last && last.k === kk) { last.H = Math.max(last.H, b.h); last.L = Math.min(last.L, b.l); last.C = b.c; last.end = i; }
          else per2.push({ k: kk, H: b.h, L: b.l, C: b.c, start: i, end: i });
        }
        for (let j = 1; j < per2.length; j++) {
          const { H, L, C: Cl } = per2[j - 1], R = H - L, P = p.type === 'Woodie' ? (H + L + 2 * Cl) / 4 : (H + L + Cl) / 3;
          let lv;
          if (p.type === 'Fibonacci') lv = { p: P, r1: P + 0.382 * R, r2: P + 0.618 * R, r3: P + R, s1: P - 0.382 * R, s2: P - 0.618 * R, s3: P - R };
          else if (p.type === 'Camarilla') lv = { p: P, r1: Cl + (R * 1.1) / 12, r2: Cl + (R * 1.1) / 6, r3: Cl + (R * 1.1) / 4, s1: Cl - (R * 1.1) / 12, s2: Cl - (R * 1.1) / 6, s3: Cl - (R * 1.1) / 4 };
          else lv = { p: P, r1: 2 * P - L, r2: P + R, r3: H + 2 * (P - L), s1: 2 * P - H, s2: P - R, s3: L - 2 * (H - P) }; // Traditional and Woodie
          // periods of several candles get a gap on their first candle, so each period's levels stand apart
          const from = per2[j].end - per2[j].start >= 2 ? per2[j].start + 1 : per2[j].start;
          for (let i = from; i <= per2[j].end; i++) for (const x of Object.keys(out)) out[x][i] = lv[x];
        }
        return out;
      },
    },
    {
      id: 'zigzag', name: 'Zig Zag', short: 'ZigZag', overlay: true, desc: 'Joins the swing highs and lows that moved at least the deviation',
      inputs: [{ key: 'dev', label: 'Deviation %', type: 'float', def: 5, min: 0.1, step: 0.5 }],
      plots: [{ key: 'zz', name: 'Zig Zag', color: '#F5A623', width: 1.5 }],
      calc(bars, p) {
        const n = bars.length, out = nanArr(n), d = p.dev / 100;
        if (!n) return { zz: out };
        let dir = 0, pi = 0, pp = bars[0].c, hiI = 0, loI = 0;
        out[0] = bars[0].c;
        for (let i = 1; i < n; i++) {
          const b = bars[i];
          if (dir >= 0 && b.h >= pp && dir === 1) { pi = i; pp = b.h; }
          else if (dir <= 0 && b.l <= pp && dir === -1) { pi = i; pp = b.l; }
          if (dir === 0) {
            if (b.h > bars[hiI].h) hiI = i;
            if (b.l < bars[loI].l) loI = i;
            if (bars[hiI].h >= bars[0].c * (1 + d)) { dir = 1; pi = hiI; pp = bars[hiI].h; }
            else if (bars[loI].l <= bars[0].c * (1 - d)) { dir = -1; pi = loI; pp = bars[loI].l; }
            continue;
          }
          if (dir === 1 && b.l <= pp * (1 - d)) { out[pi] = pp; dir = -1; pi = i; pp = b.l; }
          else if (dir === -1 && b.h >= pp * (1 + d)) { out[pi] = pp; dir = 1; pi = i; pp = b.h; }
        }
        if (dir) out[pi] = pp; // the swing still in progress
        return { zz: out };
      },
    },
    {
      id: 'alligator', name: 'Williams Alligator', short: 'Alligator', overlay: true, desc: 'Three smoothed averages shifted forward: jaw, teeth and lips',
      inputs: [
        { key: 'jaw', label: 'Jaw length', type: 'int', def: 13, min: 1 }, { key: 'teeth', label: 'Teeth length', type: 'int', def: 8, min: 1 }, { key: 'lips', label: 'Lips length', type: 'int', def: 5, min: 1 },
        { key: 'jawOff', label: 'Jaw offset', type: 'int', def: 8, min: 0 }, { key: 'teethOff', label: 'Teeth offset', type: 'int', def: 5, min: 0 }, { key: 'lipsOff', label: 'Lips offset', type: 'int', def: 3, min: 0 },
      ],
      plots: [{ key: 'jaw', name: 'Jaw', color: '#2962FF' }, { key: 'teeth', name: 'Teeth', color: '#E91E63' }, { key: 'lips', name: 'Lips', color: '#66BB6A' }],
      calc(bars, p) { const s = HL2(bars); return { jaw: shiftFwd(rma(s, p.jaw), p.jawOff), teeth: shiftFwd(rma(s, p.teeth), p.teethOff), lips: shiftFwd(rma(s, p.lips), p.lipsOff) }; },
    },
    {
      id: 'fractals', name: 'Williams Fractals', short: 'Fractals', overlay: true, desc: 'Marks a high (or low) with lower highs (higher lows) on both sides',
      inputs: [{ key: 'n', label: 'Bars on each side', type: 'int', def: 2, min: 1, max: 10 }],
      plots: [{ key: 'up', name: 'Up fractal', style: 'mark', position: 'above', color: '#22AB94' }, { key: 'dn', name: 'Down fractal', style: 'mark', position: 'below', color: '#F7525F' }],
      calc(bars, p) {
        const n = bars.length, k = p.n, up = new Array(n).fill(0), dn = new Array(n).fill(0);
        for (let i = k; i < n - k; i++) {
          let u = true, d = true;
          for (let j = 1; j <= k; j++) {
            if (!(bars[i].h > bars[i - j].h && bars[i].h > bars[i + j].h)) u = false;
            if (!(bars[i].l < bars[i - j].l && bars[i].l < bars[i + j].l)) d = false;
          }
          up[i] = u ? 1 : 0; dn[i] = d ? 1 : 0;
        }
        return { up, dn };
      },
    },
    {
      id: 'macross', name: 'Moving Average Cross', short: 'MA Cross', overlay: true, desc: 'Two moving averages with markers where they cross',
      inputs: [
        { key: 'fast', label: 'Fast length', type: 'int', def: 9, min: 1 }, { key: 'slow', label: 'Slow length', type: 'int', def: 21, min: 1 },
        { key: 'type', label: 'MA type', type: 'select', options: MA_TYPES, def: 'EMA' }, SRC,
      ],
      plots: [
        { key: 'fast', name: 'Fast', color: '#3D8BFD' }, { key: 'slow', name: 'Slow', color: '#F5A623' },
        { key: 'up', name: 'Cross up', style: 'mark', position: 'below', color: '#22AB94' }, { key: 'dn', name: 'Cross down', style: 'mark', position: 'above', color: '#F7525F' },
      ],
      calc(bars, p) {
        const s = source(bars, p.source), f = maOf(p.type, s, p.fast), sl = maOf(p.type, s, p.slow);
        const up = f.map((v, i) => (i && f[i - 1] <= sl[i - 1] && v > sl[i] ? 1 : 0)), dn = f.map((v, i) => (i && f[i - 1] >= sl[i - 1] && v < sl[i] ? 1 : 0));
        return { fast: f, slow: sl, up, dn };
      },
    },
    {
      id: 'chandelier', name: 'Chandelier Exit', short: 'Chandelier', overlay: true, desc: 'Trailing stop a multiple of ATR from the highest high / lowest low',
      inputs: [{ key: 'length', label: 'ATR period', type: 'int', def: 22, min: 1 }, { key: 'mult', label: 'ATR multiplier', type: 'float', def: 3, min: 0.1, step: 0.1 }],
      plots: [
        { key: 'long', name: 'Long stop', color: '#22AB94', lineType: 'linebr' }, { key: 'short', name: 'Short stop', color: '#F7525F', lineType: 'linebr' },
        { key: 'buy', name: 'Buy', style: 'mark', position: 'below', color: '#22AB94' }, { key: 'sell', name: 'Sell', style: 'mark', position: 'above', color: '#F7525F' },
      ],
      calc(bars, p) {
        const n = bars.length, a = atr(bars, p.length), hh = highest(C(bars), p.length), ll = lowest(C(bars), p.length);
        const L = nanArr(n), S = nanArr(n), buy = new Array(n).fill(0), sell = new Array(n).fill(0);
        let ls = NaN, ss = NaN, dir = 1;
        for (let i = 0; i < n; i++) {
          if (!isFinite(a[i]) || !isFinite(hh[i])) continue;
          let l = hh[i] - p.mult * a[i], s = ll[i] + p.mult * a[i];
          if (isFinite(ls) && bars[i - 1].c > ls) l = Math.max(l, ls);
          if (isFinite(ss) && bars[i - 1].c < ss) s = Math.min(s, ss);
          const nd = bars[i].c > ss ? 1 : bars[i].c < ls ? -1 : dir;
          if (nd !== dir) { if (nd === 1) buy[i] = 1; else sell[i] = 1; }
          dir = nd; ls = l; ss = s;
          if (dir === 1) L[i] = l; else S[i] = s;
        }
        return { long: L, short: S, buy, sell };
      },
    },

    // ---------------- oscillators ----------------
    {
      id: 'ao', name: 'Awesome Oscillator', short: 'AO', overlay: false, desc: 'Momentum: 5-bar minus 34-bar average of the midpoint',
      inputs: [], plots: [{ key: 'ao', name: 'AO', style: 'histogram', palette: UPDN }], levels: [0],
      calc(bars) { const m = HL2(bars), ao = sub(sma(m, 5), sma(m, 34)); return { ao, ao$i: dirIdx(ao) }; },
    },
    {
      id: 'ac', name: 'Accelerator Oscillator', short: 'AC', overlay: false, desc: 'Awesome Oscillator minus its 5-bar average',
      inputs: [], plots: [{ key: 'ac', name: 'AC', style: 'histogram', palette: UPDN }], levels: [0],
      calc(bars) { const m = HL2(bars), ao = sub(sma(m, 5), sma(m, 34)), ac = sub(ao, sma(ao, 5)); return { ac, ac$i: dirIdx(ac) }; },
    },
    {
      id: 'aroon', name: 'Aroon', short: 'Aroon', overlay: false, desc: 'How recently the highest high and lowest low happened (0–100)',
      inputs: [LEN(14)], plots: [{ key: 'up', name: 'Aroon Up', color: '#F5A623' }, { key: 'dn', name: 'Aroon Down', color: '#3D8BFD' }], range: [0, 100], levels: [70, 30],
      calc(bars, p) {
        const n = p.length, up = nanArr(bars.length), dn = nanArr(bars.length);
        for (let i = n; i < bars.length; i++) {
          let hi = i, lo = i;
          for (let j = i - n; j <= i; j++) { if (bars[j].h >= bars[hi].h) hi = j; if (bars[j].l <= bars[lo].l) lo = j; }
          up[i] = (100 * (n - (i - hi))) / n; dn[i] = (100 * (n - (i - lo))) / n;
        }
        return { up, dn };
      },
    },
    {
      id: 'cmf', name: 'Chaikin Money Flow', short: 'CMF', overlay: false, desc: 'Buying vs selling pressure over N bars (−1 to 1)',
      inputs: [LEN(20)], plots: [{ key: 'cmf', name: 'CMF', color: '#2EC4B6' }], levels: [0],
      calc(bars, p) {
        const mfv = bars.map((b) => (b.h === b.l ? 0 : ((b.c - b.l - (b.h - b.c)) / (b.h - b.l)) * (b.v || 0)));
        const a = rsum(mfv, p.length), v = rsum(V(bars), p.length);
        return { cmf: a.map((x, i) => (v[i] ? x / v[i] : NaN)) };
      },
    },
    {
      id: 'adl', name: 'Accumulation/Distribution', short: 'Accum/Dist', overlay: false, desc: 'Running total of money flow volume',
      inputs: [], plots: [{ key: 'adl', name: 'A/D', color: '#9C6ADE', format: 'volume' }],
      calc(bars) { let s = 0; return { adl: bars.map((b) => (s += b.h === b.l ? 0 : ((b.c - b.l - (b.h - b.c)) / (b.h - b.l)) * (b.v || 0))) }; },
    },
    {
      id: 'chaikinosc', name: 'Chaikin Oscillator', short: 'Chaikin Osc', overlay: false, desc: 'Fast minus slow EMA of Accumulation/Distribution',
      inputs: [{ key: 'fast', label: 'Fast length', type: 'int', def: 3, min: 1 }, { key: 'slow', label: 'Slow length', type: 'int', def: 10, min: 1 }],
      plots: [{ key: 'co', name: 'Chaikin Osc', color: '#F7525F', format: 'volume' }], levels: [0],
      calc(bars, p) { let s = 0; const adl = bars.map((b) => (s += b.h === b.l ? 0 : ((b.c - b.l - (b.h - b.c)) / (b.h - b.l)) * (b.v || 0))); return { co: sub(ema(adl, p.fast), ema(adl, p.slow)) }; },
    },
    {
      id: 'uo', name: 'Ultimate Oscillator', short: 'UO', overlay: false, desc: 'Buying pressure over three timeframes (0–100)',
      inputs: [{ key: 'a', label: 'Fast length', type: 'int', def: 7, min: 1 }, { key: 'b', label: 'Middle length', type: 'int', def: 14, min: 1 }, { key: 'c', label: 'Slow length', type: 'int', def: 28, min: 1 }],
      plots: [{ key: 'uo', name: 'UO', color: '#F7525F' }], levels: [70, 30], range: [0, 100],
      calc(bars, p) {
        const bp = bars.map((b, i) => (i ? b.c - Math.min(b.l, bars[i - 1].c) : NaN)), tr = bars.map((b, i) => (i ? Math.max(b.h, bars[i - 1].c) - Math.min(b.l, bars[i - 1].c) : NaN));
        const avg = (n) => { const x = rsum(bp, n), y = rsum(tr, n); return x.map((v, i) => (y[i] ? v / y[i] : NaN)); };
        const a = avg(p.a), b = avg(p.b), c = avg(p.c);
        return { uo: a.map((v, i) => (100 * (4 * v + 2 * b[i] + c[i])) / 7) };
      },
    },
    {
      id: 'trix', name: 'TRIX', short: 'TRIX', overlay: false, desc: 'Rate of change of a triple-smoothed EMA',
      inputs: [LEN(18)], plots: [{ key: 'trix', name: 'TRIX', color: '#F7525F' }], levels: [0],
      calc(bars, p) { const lc = C(bars).map(Math.log), e = ema(ema(ema(lc, p.length), p.length), p.length); return { trix: change(e).map((v) => v * 10000) }; },
    },
    {
      id: 'kst', name: 'Know Sure Thing', short: 'KST', overlay: false, desc: 'Weighted sum of four smoothed rates of change',
      inputs: [{ key: 'signal', label: 'Signal length', type: 'int', def: 9, min: 1 }],
      plots: [{ key: 'kst', name: 'KST', color: '#22AB94' }, { key: 'sig', name: 'Signal', color: '#F7525F' }], levels: [0],
      calc(bars, p) {
        const c = C(bars), r = (a, b) => sma(rocOf(c, a), b);
        const r1 = r(10, 10), r2 = r(15, 10), r3 = r(20, 10), r4 = r(30, 15), kst = r1.map((v, i) => v + 2 * r2[i] + 3 * r3[i] + 4 * r4[i]);
        return { kst, sig: sma(kst, p.signal) };
      },
    },
    {
      id: 'fisher', name: 'Fisher Transform', short: 'Fisher', overlay: false, desc: 'Turns prices into a clearer turning-point signal',
      inputs: [LEN(9)], plots: [{ key: 'fish', name: 'Fisher', color: '#3D8BFD' }, { key: 'trig', name: 'Trigger', color: '#F5A623' }], levels: [1.5, 0.75, 0, -0.75, -1.5],
      calc(bars, p) {
        const m = HL2(bars), hh = highest(m, p.length), ll = lowest(m, p.length), n = bars.length, fish = nanArr(n), trig = nanArr(n);
        let v = 0, f = 0;
        for (let i = 0; i < n; i++) {
          if (!isFinite(hh[i])) continue;
          const r = hh[i] - ll[i];
          v = 0.66 * ((r ? (m[i] - ll[i]) / r : 0.5) - 0.5) + 0.67 * v;
          v = Math.max(-0.999, Math.min(0.999, v));
          trig[i] = f;
          f = 0.5 * Math.log((1 + v) / (1 - v)) + 0.5 * f;
          fish[i] = f;
        }
        return { fish, trig };
      },
    },
    {
      id: 'mom', name: 'Momentum', short: 'Mom', overlay: false, desc: 'Price now minus price N bars ago',
      inputs: [LEN(10), SRC], plots: [{ key: 'mom', name: 'Momentum', color: '#3D8BFD' }], levels: [0],
      calc: (bars, p) => ({ mom: change(source(bars, p.source), p.length) }),
    },
    {
      id: 'ppo', name: 'Percentage Price Oscillator', short: 'PPO', overlay: false, desc: 'MACD as a percentage of the slow average',
      inputs: [{ key: 'fast', label: 'Fast length', type: 'int', def: 12, min: 1 }, { key: 'slow', label: 'Slow length', type: 'int', def: 26, min: 1 }, { key: 'signal', label: 'Signal length', type: 'int', def: 9, min: 1 }, SRC],
      plots: [{ key: 'hist', name: 'Histogram', style: 'histogram', palette: UPDN }, { key: 'ppo', name: 'PPO', color: '#3D8BFD' }, { key: 'sig', name: 'Signal', color: '#F5A623' }], levels: [0],
      calc(bars, p) {
        const s = source(bars, p.source), f = ema(s, p.fast), sl = ema(s, p.slow), ppo = f.map((v, i) => (100 * (v - sl[i])) / sl[i]), sig = ema(ppo, p.signal), hist = sub(ppo, sig);
        return { ppo, sig, hist, hist$i: hist.map((v) => (v >= 0 ? 0 : 1)) };
      },
    },
    {
      id: 'dpo', name: 'Detrended Price Oscillator', short: 'DPO', overlay: false, desc: 'Price minus an earlier moving average, to show cycles',
      inputs: [LEN(21)], plots: [{ key: 'dpo', name: 'DPO', color: '#2EC4B6' }], levels: [0],
      calc(bars, p) { const c = C(bars), ma = sma(c, p.length), k = Math.floor(p.length / 2) + 1; return { dpo: c.map((v, i) => (i >= k ? v - ma[i - k] : NaN)) }; },
    },
    {
      id: 'efi', name: 'Elder Force Index', short: 'EFI', overlay: false, desc: 'Price change times volume, smoothed',
      inputs: [LEN(13)], plots: [{ key: 'efi', name: 'EFI', color: '#F7525F', format: 'volume' }], levels: [0],
      calc(bars, p) { const c = C(bars); return { efi: ema(c.map((v, i) => (i ? (v - c[i - 1]) * (bars[i].v || 0) : NaN)), p.length) }; },
    },
    {
      id: 'eom', name: 'Ease of Movement', short: 'EOM', overlay: false, desc: 'How easily price moves for the volume traded',
      inputs: [LEN(14), { key: 'div', label: 'Divisor', type: 'int', def: 10000, min: 1 }], plots: [{ key: 'eom', name: 'EOM', color: '#22AB94' }], levels: [0],
      calc(bars, p) { const m = HL2(bars); return { eom: sma(bars.map((b, i) => (i && b.v ? (p.div * (m[i] - m[i - 1]) * (b.h - b.l)) / b.v : NaN)), p.length) }; },
    },
    {
      id: 'chop', name: 'Choppiness Index', short: 'CHOP', overlay: false, desc: 'Trending (low) or sideways (high), 0–100',
      inputs: [LEN(14)], plots: [{ key: 'chop', name: 'CHOP', color: '#3D8BFD' }], levels: [61.8, 38.2], bandFill: [61.8, 38.2], range: [0, 100],
      calc(bars, p) {
        const n = p.length, s = rsum(trueRange(bars), n), hh = highest(bars.map((b) => b.h), n), ll = lowest(bars.map((b) => b.l), n);
        return { chop: s.map((v, i) => (hh[i] - ll[i] > 0 ? (100 * Math.log10(v / (hh[i] - ll[i]))) / Math.log10(n) : NaN)) };
      },
    },
    {
      id: 'hv', name: 'Historical Volatility', short: 'HV', overlay: false, desc: 'Annualized standard deviation of returns, in %',
      inputs: [LEN(10)], plots: [{ key: 'hv', name: 'HV', color: '#3D8BFD' }],
      calc(bars, p) {
        const c = C(bars), r = c.map((v, i) => (i ? Math.log(v / c[i - 1]) : NaN)), perYear = (365 * 86400e3) / intervalOf(bars);
        return { hv: stdev(r, p.length).map((v) => 100 * v * Math.sqrt(perYear)) };
      },
    },
    {
      id: 'bbpct', name: 'Bollinger Bands %B', short: '%B', overlay: false, desc: 'Where price sits inside the Bollinger Bands (0 = lower, 1 = upper)',
      inputs: [LEN(20), { key: 'mult', label: 'StdDev', type: 'float', def: 2, min: 0.1, step: 0.1 }, SRC],
      plots: [{ key: 'b', name: '%B', color: '#2EC4B6' }], levels: [1, 0.5, 0], bandFill: [1, 0],
      calc(bars, p) { const s = source(bars, p.source), m = sma(s, p.length), d = stdev(s, p.length); return { b: s.map((v, i) => (d[i] ? (v - (m[i] - p.mult * d[i])) / (2 * p.mult * d[i]) : NaN)) }; },
    },
    {
      id: 'bbw', name: 'Bollinger BandWidth', short: 'BBW', overlay: false, desc: 'Width of the Bollinger Bands relative to the middle (squeezes)',
      inputs: [LEN(20), { key: 'mult', label: 'StdDev', type: 'float', def: 2, min: 0.1, step: 0.1 }, SRC],
      plots: [{ key: 'w', name: 'BBW', color: '#F5A623' }],
      calc(bars, p) { const s = source(bars, p.source), m = sma(s, p.length), d = stdev(s, p.length); return { w: m.map((v, i) => (v ? (2 * p.mult * d[i]) / v : NaN)) }; },
    },
    {
      id: 'crsi', name: 'Connors RSI', short: 'CRSI', overlay: false, desc: 'Average of a short RSI, the RSI of up/down streaks, and the rank of the last change',
      inputs: [{ key: 'rsi', label: 'RSI length', type: 'int', def: 3, min: 1 }, { key: 'streak', label: 'Up/down length', type: 'int', def: 2, min: 1 }, { key: 'rank', label: 'Rank length', type: 'int', def: 100, min: 1 }],
      plots: [{ key: 'crsi', name: 'CRSI', color: '#3D8BFD' }], levels: [70, 30], bandFill: [70, 30], range: [0, 100],
      calc(bars, p) {
        const c = C(bars), n = c.length, st = new Array(n).fill(0);
        for (let i = 1; i < n; i++) st[i] = c[i] > c[i - 1] ? (st[i - 1] > 0 ? st[i - 1] + 1 : 1) : c[i] < c[i - 1] ? (st[i - 1] < 0 ? st[i - 1] - 1 : -1) : 0;
        const r1 = rsiOf(c, p.rsi), r2 = rsiOf(st, p.streak), ch = rocOf(c, 1), rank = nanArr(n);
        for (let i = p.rank; i < n; i++) { let k = 0; for (let j = i - p.rank; j < i; j++) if (ch[j] < ch[i]) k++; rank[i] = (100 * k) / p.rank; }
        return { crsi: r1.map((v, i) => (v + r2[i] + rank[i]) / 3) };
      },
    },
    {
      id: 'coppock', name: 'Coppock Curve', short: 'Coppock', overlay: false, desc: 'Long-term momentum: weighted average of two rates of change',
      inputs: [{ key: 'wma', label: 'WMA length', type: 'int', def: 10, min: 1 }, { key: 'long', label: 'Long ROC', type: 'int', def: 14, min: 1 }, { key: 'short', label: 'Short ROC', type: 'int', def: 11, min: 1 }],
      plots: [{ key: 'cc', name: 'Coppock', color: '#3D8BFD' }], levels: [0],
      calc(bars, p) { const c = C(bars), a = rocOf(c, p.long), b = rocOf(c, p.short); return { cc: wma(a.map((v, i) => v + b[i]), p.wma) }; },
    },
    {
      id: 'vortex', name: 'Vortex Indicator', short: 'VI', overlay: false, desc: 'Upward vs downward movement: VI+ above VI− means an uptrend',
      inputs: [LEN(14)], plots: [{ key: 'plus', name: 'VI+', color: '#3D8BFD' }, { key: 'minus', name: 'VI−', color: '#F7525F' }], levels: [1],
      calc(bars, p) {
        const vp = bars.map((b, i) => (i ? Math.abs(b.h - bars[i - 1].l) : NaN)), vm = bars.map((b, i) => (i ? Math.abs(b.l - bars[i - 1].h) : NaN));
        const tr = rsum(trueRange(bars).map((v, i) => (i ? v : NaN)), p.length), a = rsum(vp, p.length), b = rsum(vm, p.length);
        return { plus: a.map((v, i) => v / tr[i]), minus: b.map((v, i) => v / tr[i]) };
      },
    },
    {
      id: 'tsi', name: 'True Strength Index', short: 'TSI', overlay: false, desc: 'Double-smoothed momentum, with a signal line',
      inputs: [{ key: 'long', label: 'Long length', type: 'int', def: 25, min: 1 }, { key: 'short', label: 'Short length', type: 'int', def: 13, min: 1 }, { key: 'signal', label: 'Signal length', type: 'int', def: 13, min: 1 }],
      plots: [{ key: 'tsi', name: 'TSI', color: '#3D8BFD' }, { key: 'sig', name: 'Signal', color: '#F7525F' }], levels: [0],
      calc(bars, p) {
        const d = change(C(bars)), a = ema(ema(d, p.long), p.short), b = ema(ema(d.map(Math.abs), p.long), p.short);
        const tsi = a.map((v, i) => (b[i] ? (100 * v) / b[i] : NaN));
        return { tsi, sig: ema(tsi, p.signal) };
      },
    },
    {
      id: 'pvt', name: 'Price Volume Trend', short: 'PVT', overlay: false, desc: 'Running total of volume times percentage price change',
      inputs: [], plots: [{ key: 'pvt', name: 'PVT', color: '#3D8BFD', format: 'volume' }],
      calc(bars) { let s = 0; return { pvt: bars.map((b, i) => (i ? (s += ((b.c - bars[i - 1].c) / bars[i - 1].c) * (b.v || 0)) : (s = 0))) }; },
    },
    {
      id: 'bop', name: 'Balance of Power', short: 'BOP', overlay: false, desc: 'Who controls the bar: (close − open) / (high − low), smoothed',
      inputs: [LEN(14)], plots: [{ key: 'bop', name: 'BOP', color: '#F7525F' }], levels: [0],
      calc: (bars, p) => ({ bop: sma(bars.map((b) => (b.h === b.l ? 0 : (b.c - b.o) / (b.h - b.l))), p.length) }),
    },
    {
      id: 'stdev', name: 'Standard Deviation', short: 'StdDev', overlay: false, desc: 'Standard deviation of the price over N bars',
      inputs: [LEN(20), SRC], plots: [{ key: 'sd', name: 'StdDev', color: '#9C6ADE' }],
      calc: (bars, p) => ({ sd: stdev(source(bars, p.source), p.length) }),
    },
    {
      id: 'volosc', name: 'Volume Oscillator', short: 'Vol Osc', overlay: false, desc: 'Fast vs slow volume average, in %',
      inputs: [{ key: 'fast', label: 'Fast length', type: 'int', def: 5, min: 1 }, { key: 'slow', label: 'Slow length', type: 'int', def: 10, min: 1 }],
      plots: [{ key: 'vo', name: 'Vol Osc', color: '#3D8BFD' }], levels: [0],
      calc(bars, p) { const v = V(bars), f = ema(v, p.fast), s = ema(v, p.slow); return { vo: f.map((x, i) => (s[i] ? (100 * (x - s[i])) / s[i] : NaN)) }; },
    },
    {
      id: 'mass', name: 'Mass Index', short: 'Mass', overlay: false, desc: 'Range expansion: a bulge above 27 can come before a reversal',
      inputs: [LEN(10)], plots: [{ key: 'mi', name: 'Mass Index', color: '#3D8BFD' }], levels: [27, 26.5],
      calc(bars, p) { const r = bars.map((b) => b.h - b.l), e1 = ema(r, 9), e2 = ema(e1, 9); return { mi: rsum(e1.map((v, i) => v / e2[i]), p.length) }; },
    },
    {
      id: 'cmo', name: 'Chande Momentum Oscillator', short: 'CMO', overlay: false, desc: 'Sum of gains minus sum of losses, −100 to 100',
      inputs: [LEN(9), SRC], plots: [{ key: 'cmo', name: 'CMO', color: '#3D8BFD' }], levels: [50, 0, -50], range: [-100, 100],
      calc(bars, p) {
        const d = change(source(bars, p.source)), up = rsum(d.map((v) => (v > 0 ? v : v === v ? 0 : NaN)), p.length), dn = rsum(d.map((v) => (v < 0 ? -v : v === v ? 0 : NaN)), p.length);
        return { cmo: up.map((u, i) => (u + dn[i] ? (100 * (u - dn[i])) / (u + dn[i]) : 0)) };
      },
    },
  ];
  // overlays go with the other overlays, oscillators at the end
  for (const d of MORE) DEFS.push(d);

  // ================================================================ order flow and smart-money concepts
  // Buy volume of a candle: the exchange's taker-buy volume where it reports it (Binance spot and futures),
  // otherwise an estimate from where the candle closed in its range (close at the high = all buying).
  const buyVol = (b) => (b.bv >= 0 ? b.bv : b.h > b.l ? (b.v * (b.c - b.l)) / (b.h - b.l) : b.v / 2);
  const YES_NO = (key, label, def) => ({ key, label, type: 'select', options: ['Yes', 'No'], def });

  // swing highs and lows: a bar whose high (low) is the highest (lowest) of len bars on each side.
  // Confirmed len bars later, so `at` is the bar where it becomes known.
  function swings(bars, len) {
    const out = [];
    for (let i = len; i < bars.length - len; i++) {
      let hi = true, lo = true;
      for (let k = i - len; k <= i + len && (hi || lo); k++) {
        if (k === i) continue;
        if (bars[k].h >= bars[i].h && (k > i || bars[k].h > bars[i].h)) hi = false;
        if (bars[k].l <= bars[i].l && (k > i || bars[k].l < bars[i].l)) lo = false;
      }
      if (hi) out.push({ i, at: i + len, high: true, p: bars[i].h });
      if (lo) out.push({ i, at: i + len, high: false, p: bars[i].l });
    }
    return out;
  }
  // a parameter-free box list for the chart: { list: [{ t1, t2 (null: up to now), top, bot, color, label, line, dash }] }
  const zoneOut = (list) => ({ $zones: { list } });

  // draws $zones: boxes (or lines) from t1 to t2, labelled
  function paintZones(api) {
    const z = api.out.$zones;
    if (!z || !z.list.length) return;
    const { ctx } = api;
    ctx.save();
    ctx.font = '600 10px ' + api.font;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    for (const zn of z.list) {
      const x1 = api.xOfTime(zn.t1), x2 = zn.t2 == null ? api.right : api.xOfTime(zn.t2);
      if (x2 < 0 || x1 > api.right) continue;
      const col = api.color(zn.color);
      const yt = api.yOf(zn.top), yb = api.yOf(zn.bot);
      if (zn.line) {
        ctx.strokeStyle = col;
        ctx.lineWidth = 1;
        ctx.setLineDash(zn.dash ? [4, 3] : []);
        ctx.beginPath(); ctx.moveTo(x1, Math.round(yt) + 0.5); ctx.lineTo(x2, Math.round(yt) + 0.5); ctx.stroke();
        ctx.setLineDash([]);
        if (zn.label) {
          ctx.fillStyle = col;
          ctx.textAlign = zn.labelAt === 'mid' ? 'center' : zn.labelAt === 'end' ? 'right' : 'left';
          ctx.fillText(zn.label, zn.labelAt === 'mid' ? (x1 + x2) / 2 : zn.labelAt === 'end' ? Math.min(x2, api.right) - 3 : x1 + 2, yt + (zn.below ? 3 : -12));
          ctx.textAlign = 'left';
        }
        continue;
      }
      ctx.fillStyle = col;
      ctx.fillRect(x1, Math.min(yt, yb), Math.max(1, x2 - x1), Math.max(1, Math.abs(yb - yt)));
      ctx.strokeStyle = col;
      ctx.lineWidth = 1;
      ctx.strokeRect(Math.round(x1) + 0.5, Math.round(Math.min(yt, yb)) + 0.5, Math.max(1, Math.round(x2 - x1)), Math.max(1, Math.round(Math.abs(yb - yt))));
      if (zn.label && Math.abs(yb - yt) >= 9 && x2 - x1 > 24) { ctx.fillStyle = api.textColor; ctx.globalAlpha = 0.8; ctx.fillText(zn.label, Math.max(x1, 0) + 4, Math.min(yt, yb) + 2); ctx.globalAlpha = 1; }
    }
    ctx.restore();
  }

  const FLOW = [
    {
      id: 'vdelta', name: 'Volume Delta', short: 'Delta', overlay: false,
      desc: 'Buy volume minus sell volume of each candle (Binance: real taker volume; other exchanges: estimated)',
      inputs: [],
      plots: [{ key: 'd', name: 'Delta', style: 'histogram', palette: ['rgba(34,171,148,0.8)', 'rgba(247,82,95,0.8)'], format: 'volume' }],
      levels: [0],
      calc(bars) {
        const d = bars.map((b) => 2 * buyVol(b) - b.v);
        return { d, d$i: d.map((v) => (v >= 0 ? 0 : 1)) };
      },
    },
    {
      id: 'cvd', name: 'Cumulative Volume Delta', short: 'CVD', overlay: false,
      desc: 'Running total of buy minus sell volume; can restart each day, week or month (Binance: real taker volume; others: estimated)',
      inputs: [{ key: 'anchor', label: 'Restart every', type: 'select', options: ['Never', 'Day', 'Week', 'Month'], def: 'Never' }],
      plots: [{ key: 'cvd', name: 'CVD', color: '#3D8BFD', format: 'volume' }],
      levels: [0],
      calc(bars, p) {
        const D = 86400e3;
        const key = (t) => (p.anchor === 'Day' ? Math.floor(t / D) : p.anchor === 'Week' ? Math.floor((t / D + 3) / 7) : p.anchor === 'Month' ? new Date(t).getUTCFullYear() * 12 + new Date(t).getUTCMonth() : 0);
        let acc = 0, k0 = null;
        const cvd = bars.map((b) => { const k = key(b.t); if (k !== k0) { acc = 0; k0 = k; } acc += 2 * buyVol(b) - b.v; return acc; });
        return { cvd };
      },
    },
    {
      id: 'vrvp', name: 'Volume Profile (Visible Range)', short: 'VRVP', overlay: true,
      desc: 'Volume traded at each price over the candles on screen, with the point of control and value area',
      inputs: [
        { key: 'rows', label: 'Rows', type: 'int', def: 24, min: 6, max: 200 },
        { key: 'width', label: 'Width (% of chart)', type: 'int', def: 25, min: 5, max: 60 },
        { key: 'va', label: 'Value area (%)', type: 'int', def: 70, min: 10, max: 100 },
        { key: 'side', label: 'Placement', type: 'select', options: ['Right', 'Left'], def: 'Right' },
      ],
      plots: [],
      colors: [
        { key: 'up', name: 'Buy volume', color: 'rgba(34,171,148,0.45)' }, { key: 'down', name: 'Sell volume', color: 'rgba(247,82,95,0.45)' },
        { key: 'poc', name: 'Point of control', color: '#F5A623' }, { key: 'vah', name: 'Value area lines', color: 'rgba(120,123,134,0.8)' },
      ],
      calc: () => ({}),
      paint(api) {
        const { ctx, bars, params: p } = api, a = Math.max(0, api.a), b = Math.min(bars.length - 1, api.b);
        if (b - a < 1) return;
        let lo = Infinity, hi = -Infinity;
        for (let i = a; i <= b; i++) { if (bars[i].l < lo) lo = bars[i].l; if (bars[i].h > hi) hi = bars[i].h; }
        if (!(hi > lo)) return;
        const n = p.rows, step = (hi - lo) / n, up = new Float64Array(n), dn = new Float64Array(n);
        for (let i = a; i <= b; i++) {
          const B = bars[i], v = B.v || 0;
          if (!v) continue;
          const buy = B.bv >= 0 ? B.bv : B.c >= B.o ? v : 0, sell = v - buy;
          const r0 = Math.min(n - 1, Math.floor((B.l - lo) / step)), r1 = Math.min(n - 1, Math.floor((B.h - lo) / step));
          const span = B.h - B.l;
          for (let r = r0; r <= r1; r++) {
            // the share of the candle's range inside this row
            const f = span > 0 ? (Math.min(B.h, lo + (r + 1) * step) - Math.max(B.l, lo + r * step)) / span : 1 / (r1 - r0 + 1);
            up[r] += buy * f; dn[r] += sell * f;
          }
        }
        const tot = Array.from(up, (u, r) => u + dn[r]), all = tot.reduce((x, y) => x + y, 0);
        if (!all) return;
        let poc = 0;
        for (let r = 1; r < n; r++) if (tot[r] > tot[poc]) poc = r;
        // value area: grow from the point of control toward the bigger neighbour
        let vaLo = poc, vaHi = poc, inVa = tot[poc];
        while (inVa < (all * p.va) / 100 && (vaLo > 0 || vaHi < n - 1)) {
          const below = vaLo > 0 ? tot[vaLo - 1] : -1, above = vaHi < n - 1 ? tot[vaHi + 1] : -1;
          if (above >= below) inVa += tot[++vaHi]; else inVa += tot[--vaLo];
        }
        const W = (api.right * p.width) / 100, mx = tot[poc], right = p.side === 'Left';
        ctx.save();
        for (let r = 0; r < n; r++) {
          const y1 = api.yOf(lo + (r + 1) * step), y2 = api.yOf(lo + r * step), hh = Math.max(1, Math.abs(y2 - y1) - 1);
          const wu = (up[r] / mx) * W, wd = (dn[r] / mx) * W;
          ctx.globalAlpha = r >= vaLo && r <= vaHi ? 1 : 0.5;
          const x0 = right ? 0 : api.right - wu - wd;
          ctx.fillStyle = api.color('up'); ctx.fillRect(x0, Math.min(y1, y2), wu, hh);
          ctx.fillStyle = api.color('down'); ctx.fillRect(x0 + wu, Math.min(y1, y2), wd, hh);
        }
        ctx.globalAlpha = 1;
        const line = (price, col, w, dash) => { const y = Math.round(api.yOf(price)) + 0.5; ctx.strokeStyle = col; ctx.lineWidth = w; ctx.setLineDash(dash); ctx.beginPath(); ctx.moveTo(api.xAt(a), y); ctx.lineTo(api.right, y); ctx.stroke(); };
        line(lo + (poc + 0.5) * step, api.color('poc'), 1.5, []);
        line(lo + (vaHi + 1) * step, api.color('vah'), 1, [4, 3]);
        line(lo + vaLo * step, api.color('vah'), 1, [4, 3]);
        ctx.setLineDash([]);
        ctx.restore();
      },
    },
    {
      id: 'fvg', name: 'Fair Value Gaps', short: 'FVG', overlay: true,
      desc: 'Three-candle price gaps (imbalances), shown until the price fills them',
      inputs: [
        { key: 'minPct', label: 'Minimum gap (% of price)', type: 'float', def: 0, min: 0, max: 10, step: 0.05 },
        { key: 'max', label: 'Gaps to show (each side)', type: 'int', def: 10, min: 1, max: 100 },
        YES_NO('filled', 'Show filled gaps', 'No'),
        { key: 'fill', label: 'Filled when the price reaches', type: 'select', options: ['The far edge', 'The middle', 'The near edge'], def: 'The far edge' },
      ],
      plots: [],
      colors: [{ key: 'bull', name: 'Bullish gap', color: 'rgba(34,171,148,0.22)' }, { key: 'bear', name: 'Bearish gap', color: 'rgba(247,82,95,0.22)' }],
      calc(bars, p) {
        const gaps = [];
        for (let i = 2; i < bars.length; i++) {
          const a = bars[i - 2], c = bars[i];
          if (c.l > a.h && (c.l - a.h) / c.c >= p.minPct / 100) gaps.push({ i, bull: true, top: c.l, bot: a.h });
          else if (c.h < a.l && (a.l - c.h) / c.c >= p.minPct / 100) gaps.push({ i, bull: false, top: a.l, bot: c.h });
        }
        const lvl = (g) => (p.fill === 'The middle' ? (g.top + g.bot) / 2 : (p.fill === 'The near edge') === g.bull ? g.top : g.bot);
        const list = [];
        for (const side of [true, false]) {
          const mine = [];
          for (const g of gaps) {
            if (g.bull !== side) continue;
            const L = lvl(g);
            let end = null;
            for (let k = g.i + 1; k < bars.length; k++) if (g.bull ? bars[k].l <= L : bars[k].h >= L) { end = k; break; }
            if (end != null && p.filled !== 'Yes') continue;
            mine.push({ t1: bars[g.i - 1].t, t2: end == null ? null : bars[end].t, top: g.top, bot: g.bot, color: g.bull ? 'bull' : 'bear', label: 'FVG' });
          }
          list.push(...mine.slice(-p.max));
        }
        return zoneOut(list);
      },
      paint: paintZones,
    },
    {
      id: 'obs', name: 'Order Blocks', short: 'OB', overlay: true,
      desc: 'The last opposite candle before a move that broke a swing high or low; shown until the price closes through it',
      inputs: [
        { key: 'len', label: 'Swing length', type: 'int', def: 5, min: 2, max: 50 },
        { key: 'max', label: 'Blocks to show (each side)', type: 'int', def: 3, min: 1, max: 50 },
        YES_NO('broken', 'Show broken blocks', 'No'),
        { key: 'body', label: 'Zone', type: 'select', options: ['Whole candle', 'Candle body'], def: 'Whole candle' },
      ],
      plots: [],
      colors: [{ key: 'bull', name: 'Bullish block', color: 'rgba(61,139,253,0.22)' }, { key: 'bear', name: 'Bearish block', color: 'rgba(245,166,35,0.22)' }],
      calc(bars, p) {
        const sw = swings(bars, p.len).sort((x, y) => x.at - y.at), blocks = [];
        let lastHi = null, lastLo = null, s = 0;
        for (let i = 0; i < bars.length; i++) {
          while (s < sw.length && sw[s].at <= i) { if (sw[s].high) lastHi = sw[s]; else lastLo = sw[s]; s++; }
          const c = bars[i].c;
          // close above the last swing high: the bullish block is the lowest down candle since that swing
          if (lastHi && c > lastHi.p) {
            let k = -1;
            for (let j = lastHi.i; j < i; j++) if (bars[j].c < bars[j].o && (k < 0 || bars[j].l < bars[k].l)) k = j;
            if (k >= 0) blocks.push({ i: k, from: i, bull: true });
            lastHi = null;
          }
          if (lastLo && c < lastLo.p) {
            let k = -1;
            for (let j = lastLo.i; j < i; j++) if (bars[j].c > bars[j].o && (k < 0 || bars[j].h > bars[k].h)) k = j;
            if (k >= 0) blocks.push({ i: k, from: i, bull: false });
            lastLo = null;
          }
        }
        const list = [];
        for (const side of [true, false]) {
          const mine = [];
          for (const b of blocks) {
            if (b.bull !== side) continue;
            const B = bars[b.i], body = p.body === 'Candle body';
            const top = body ? Math.max(B.o, B.c) : B.h, bot = body ? Math.min(B.o, B.c) : B.l;
            let end = null;
            for (let k = b.from + 1; k < bars.length; k++) if (side ? bars[k].c < bot : bars[k].c > top) { end = k; break; }
            if (end != null && p.broken !== 'Yes') continue;
            mine.push({ t1: B.t, t2: end == null ? null : bars[end].t, top, bot, color: side ? 'bull' : 'bear', label: side ? 'Bull OB' : 'Bear OB' });
          }
          list.push(...mine.slice(-p.max));
        }
        return zoneOut(list);
      },
      paint: paintZones,
    },
    {
      id: 'liq', name: 'Liquidity Levels', short: 'Liquidity', overlay: true,
      desc: 'Swing highs and lows where stops tend to sit, marked as swept once the price trades through them; equal highs and lows highlighted',
      inputs: [
        { key: 'len', label: 'Swing length', type: 'int', def: 5, min: 2, max: 50 },
        { key: 'max', label: 'Levels to show (each side)', type: 'int', def: 6, min: 1, max: 50 },
        { key: 'eq', label: 'Equal highs/lows within (% of price)', type: 'float', def: 0.1, min: 0, max: 2, step: 0.01 },
        YES_NO('swept', 'Show swept levels', 'Yes'),
      ],
      plots: [],
      colors: [{ key: 'buy', name: 'Above (buy-side)', color: '#F7525F' }, { key: 'sell', name: 'Below (sell-side)', color: '#22AB94' }, { key: 'swept', name: 'Swept', color: 'rgba(120,123,134,0.7)' }],
      calc(bars, p) {
        const sw = swings(bars, p.len), list = [];
        for (const side of [true, false]) {
          const mine = [], pts = sw.filter((x) => x.high === side);
          for (const s of pts) {
            s.end = null;
            for (let k = s.i + 1; k < bars.length; k++) if (side ? bars[k].h > s.p : bars[k].l < s.p) { s.end = k; break; }
          }
          const alive = (s, i) => i > s.i && (s.end == null || i < s.end);
          for (const s of pts) {
            const end = s.end;
            if (end != null && p.swept !== 'Yes') continue;
            // equal highs/lows: two swings at nearly the same price, both standing at the same time
            const eq = pts.some((o) => o !== s && Math.abs(o.p - s.p) <= (s.p * p.eq) / 100 && (alive(s, o.i) || alive(o, s.i)));
            const label = (eq ? (side ? 'EQH' : 'EQL') : side ? 'BSL' : 'SSL') + (end != null ? ' ✓' : '');
            mine.push({ t1: bars[s.i].t, t2: end == null ? null : bars[end].t, top: s.p, bot: s.p, line: true, dash: end != null, color: end != null ? 'swept' : side ? 'buy' : 'sell', label, below: !side, labelAt: 'end' });
          }
          list.push(...mine.slice(-p.max));
        }
        return zoneOut(list);
      },
      paint: paintZones,
    },
    {
      id: 'structure', name: 'Market Structure (BOS / CHoCH)', short: 'Structure', overlay: true,
      desc: 'Breaks of structure in the trend\'s direction (BOS) and changes of character against it (CHoCH), from swing highs and lows',
      inputs: [{ key: 'len', label: 'Swing length', type: 'int', def: 5, min: 2, max: 50 }, { key: 'max', label: 'Breaks to show', type: 'int', def: 20, min: 1, max: 200 }],
      plots: [],
      colors: [{ key: 'bull', name: 'Bullish break', color: '#22AB94' }, { key: 'bear', name: 'Bearish break', color: '#F7525F' }],
      calc(bars, p) {
        const sw = swings(bars, p.len).sort((x, y) => x.at - y.at), list = [];
        let lastHi = null, lastLo = null, s = 0, trend = 0;
        for (let i = 0; i < bars.length; i++) {
          while (s < sw.length && sw[s].at <= i) { if (sw[s].high) lastHi = sw[s]; else lastLo = sw[s]; s++; }
          const c = bars[i].c;
          if (lastHi && c > lastHi.p) {
            list.push({ t1: bars[lastHi.i].t, t2: bars[i].t, top: lastHi.p, bot: lastHi.p, line: true, color: 'bull', label: trend < 0 ? 'CHoCH' : 'BOS', labelAt: 'mid' });
            trend = 1; lastHi = null;
          }
          if (lastLo && c < lastLo.p) {
            list.push({ t1: bars[lastLo.i].t, t2: bars[i].t, top: lastLo.p, bot: lastLo.p, line: true, color: 'bear', label: trend > 0 ? 'CHoCH' : 'BOS', labelAt: 'mid', below: true });
            trend = -1; lastLo = null;
          }
        }
        return zoneOut(list.slice(-p.max));
      },
      paint: paintZones,
    },
  ];
  for (const d of FLOW) DEFS.push(d);

  // ================================================================ derivatives (data from the exchanges, see derivs.js)
  // ext = { source, series: [{ t, v, … }], perHours }: each candle takes the latest value known by its close
  function mapExt(bars, ext, val) {
    const n = bars.length, out = nanArr(n), S = ext.series;
    let j = -1;
    for (let i = 0; i < n; i++) {
      const end = i + 1 < n ? bars[i + 1].t : Infinity;
      while (j + 1 < S.length && S[j + 1].t < end) j++;
      if (j >= 0 && (i + 1 < n || S[j].t >= bars[i].t - 7 * 86400e3)) out[i] = val(S[j], bars[i]);
    }
    // nothing before the data starts
    for (let i = 0; i < n && S.length && bars[i].t + (i + 1 < n ? bars[i + 1].t - bars[i].t : 0) <= S[0].t; i++) out[i] = NaN;
    return out;
  }
  // ---- heatmaps: a grid of values -> a small image in the chosen palette
  const HEAT_PALETTE = { key: 'palette', label: 'Colors', type: 'select', options: ['Thermal', 'Ice', 'Gold', 'Viridis', 'Ember', 'Mono'], def: 'Thermal' };
  const HEAT_CONTRAST = { key: 'contrast', label: 'Brightness', type: 'int', def: 5, min: 1, max: 10 };
  const HEAT_CELL = { key: 'cell', label: 'Row height (px)', type: 'int', def: 3, min: 1, max: 12 };
  function heap(before) {
    const h = [];
    const up = (i) => { while (i > 0) { const q = (i - 1) >> 1; if (!before(h[i], h[q])) break; [h[i], h[q]] = [h[q], h[i]]; i = q; } };
    const down = (i) => { for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < h.length && before(h[l], h[m])) m = l; if (r < h.length && before(h[r], h[m])) m = r; if (m === i) break; [h[i], h[m]] = [h[m], h[i]]; i = m; } };
    return { size: () => h.length, peek: () => h[0], push: (x) => { h.push(x); up(h.length - 1); }, pop: () => { const t = h[0], e = h.pop(); if (h.length) { h[0] = e; down(0); } return t; } };
  }
  // robust: scale to a high percentile so one huge cell doesn't hide the rest
  function heatImage(grid, cols, rows, p, heatRGB, percentile) {
    const nz = [];
    for (let i = 0; i < grid.length; i++) if (grid[i] > 0) nz.push(grid[i]);
    const cv = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(Math.max(1, cols), Math.max(1, rows)) : Object.assign(document.createElement('canvas'), { width: Math.max(1, cols), height: Math.max(1, rows) });
    if (!nz.length) return cv;
    let top;
    if (percentile) { nz.sort((x, y) => x - y); top = nz[Math.min(nz.length - 1, Math.floor(nz.length * 0.985))]; } else top = nz.reduce((m, v) => (v > m ? v : m), 0);
    const g = 1.2 - 0.09 * p.contrast, img = new ImageData(Math.max(1, cols), Math.max(1, rows)), d = img.data;
    for (let i = 0; i < grid.length; i++) {
      if (!(grid[i] > 0)) continue;
      const t = Math.pow(Math.min(1, grid[i] / top), g);
      if (t < 0.02) continue;
      const [r, gg, b] = heatRGB(p.palette, t);
      d[i * 4] = r; d[i * 4 + 1] = gg; d[i * 4 + 2] = b; d[i * 4 + 3] = Math.round(255 * Math.min(1, 0.2 + t));
    }
    cv.getContext('2d').putImageData(img, 0, 0);
    return cv;
  }
  function drawHeat(api, img, a0, b0, h) {
    const x0 = api.xAt(a0) - api.spacing / 2, x1 = api.xAt(b0) + api.spacing / 2;
    api.ctx.save();
    api.ctx.imageSmoothingEnabled = false;
    api.ctx.drawImage(img, x0, api.top, x1 - x0, h);
    api.ctx.restore();
  }
  // (UPDN: the up/down histogram colors defined above)
  const DERIVS = [
    {
      id: 'oi', name: 'Open Interest', short: 'OI', overlay: false, ext: 'oi',
      desc: 'Value of all open futures positions on the coin, in dollars (Binance, OKX or Bybit; the chart\'s own exchange for futures)',
      inputs: [{ key: 'show', label: 'Show', type: 'select', options: ['Open interest', 'Change per candle'], def: 'Open interest' }],
      plots: [{ key: 'oi', name: 'Open interest', color: '#F5A623', format: 'volume' }, { key: 'chg', name: 'Change', style: 'histogram', palette: UPDN, format: 'volume' }],
      calc(bars, p, ext) {
        const oi = mapExt(bars, ext, (r, b) => (r.v > 0 ? r.v : r.coin * b.c));
        if (p.show === 'Open interest') return { oi, $label: ext.source }; // (only the line shown, so the legend has one value)
        const chg = oi.map((v, i) => (i && isFinite(v) && isFinite(oi[i - 1]) ? v - oi[i - 1] : NaN));
        return { chg, chg$i: chg.map((v) => (v >= 0 ? 0 : 1)), $label: ext.source };
      },
    },
    {
      id: 'funding', name: 'Funding Rate', short: 'Funding', overlay: false, ext: 'funding',
      desc: 'What longs pay shorts (positive) or shorts pay longs (negative) on the perpetual, at each funding time',
      inputs: [{ key: 'show', label: 'Show as', type: 'select', options: ['% per payment', '% per 8 hours', '% per year'], def: '% per payment' }],
      plots: [{ key: 'f', name: 'Funding', style: 'histogram', palette: UPDN }],
      levels: [0],
      calc(bars, p, ext) {
        const k = p.show === '% per 8 hours' ? 8 / (ext.perHours || 8) : p.show === '% per year' ? (365 * 24) / (ext.perHours || 8) : 1;
        const f = mapExt(bars, ext, (r) => r.v * 100 * k);
        return { f, f$i: f.map((v) => (v >= 0 ? 0 : 1)), $label: `${ext.source}${ext.perHours ? `, every ${ext.perHours}h` : ''}` };
      },
    },
    {
      id: 'lsr', name: 'Long/Short Ratio', short: 'L/S', overlay: false, ext: 'lsr',
      desc: 'Accounts with long positions divided by accounts with short positions on the perpetual (above 1: more longs)',
      inputs: [],
      plots: [{ key: 'r', name: 'Long/short', color: '#9C6ADE' }],
      levels: [1],
      calc(bars, p, ext) { return { r: mapExt(bars, ext, (x) => x.v), $label: ext.source }; },
    },
    {
      id: 'liqheat', name: 'Liquidation Heatmap (estimated)', short: 'Liq heatmap', overlay: true, ext: 'oi', underlay: true,
      desc: 'Where leveraged positions would be liquidated, estimated from open interest: each rise in open interest is spread over typical leverage above and below its price, and removed once the price trades through it. Brighter: more positions would be closed there.',
      inputs: [
        { key: 'lev', label: 'Leverage mix', type: 'select', options: ['Mixed (5–100×)', 'High (25–100×)', 'Low (3–25×)'], def: 'Mixed (5–100×)' },
        { key: 'side', label: 'Longs vs shorts', type: 'select', options: ['From buying and selling', 'Half and half'], def: 'From buying and selling' },
        HEAT_PALETTE, HEAT_CONTRAST, HEAT_CELL,
        { key: 'map', label: 'Levels now (right edge)', type: 'select', options: ['Show', 'Hide'], def: 'Show' },
      ],
      plots: [],
      colors: [{ key: 'long', name: 'Long liquidations (now)', color: 'rgba(247,82,95,0.55)' }, { key: 'short', name: 'Short liquidations (now)', color: 'rgba(34,171,148,0.55)' }],
      calc(bars, p, ext) {
        const n = bars.length, oi = mapExt(bars, ext, (r, b) => (r.v > 0 ? r.v : r.coin * b.c));
        const TIERS = { 'High (25–100×)': [[25, 0.35], [50, 0.35], [100, 0.3]], 'Low (3–25×)': [[3, 0.2], [5, 0.3], [10, 0.3], [25, 0.2]] }[p.lev] || [[5, 0.1], [10, 0.25], [25, 0.3], [50, 0.2], [100, 0.15]];
        // G: how much of the positions opened earlier are still open (falling open interest closes some of everyone's)
        const G = new Float64Array(n).fill(1), levels = [];
        const longs = heap((x, y) => x.px > y.px), shorts = heap((x, y) => x.px < y.px); // next to be hit first
        for (let i = 1; i < n; i++) {
          const b = bars[i], o0 = oi[i - 1], o1 = oi[i];
          G[i] = G[i - 1];
          // the price reached these: liquidated
          while (longs.size() && longs.peek().px >= b.l) longs.pop().end = i;
          while (shorts.size() && shorts.peek().px <= b.h) shorts.pop().end = i;
          if (!(o0 > 0 && o1 > 0)) continue;
          if (o1 < o0) { G[i] = G[i - 1] * (o1 / o0); continue; }
          const d = o1 - o0, entry = (b.h + b.l + b.c) / 3;
          let ls = 0.5;
          if (p.side !== 'Half and half') ls = b.bv >= 0 && b.v > 0 ? 0.25 + 0.5 * (b.bv / b.v) : b.c >= b.o ? 0.6 : 0.4;
          for (const [lev, w] of TIERS) {
            const L = { px: entry * (1 - 1 / lev + 0.004), usd: d * ls * w, start: i, end: n, long: true }, S = { px: entry * (1 + 1 / lev - 0.004), usd: d * (1 - ls) * w, start: i, end: n, long: false };
            levels.push(L, S); longs.push(L); shorts.push(S);
          }
        }
        return { $heat: { levels, G }, $label: `${ext.source} open interest, est.` };
      },
      paint(api) {
        const H = api.out.$heat;
        if (!H || !H.levels.length) return;
        const { ctx, a, b, top, height, params: p } = api, n = api.bars.length, cell = Math.max(1, p.cell), rows = Math.ceil(height / cell);
        const a0 = Math.max(0, a), b0 = Math.min(n - 1, b), cols = b0 - a0 + 1;
        if (cols < 1) return;
        const key = [a0, b0, top, height, api.vOf(top), api.vOf(top + height), p.palette, p.contrast, cell].join('|');
        if (!H.cache || H.cache.key !== key) {
          const grid = new Float32Array(rows * cols);
          for (const L of H.levels) {
            if (L.end < a0 || L.start >= b0) continue;
            const r = Math.floor((api.yOf(L.px) - top) / cell);
            if (r < 0 || r >= rows) continue;
            const g0 = H.G[L.start];
            for (let j = Math.max(a0, L.start + 1); j <= Math.min(b0, L.end); j++) grid[r * cols + (j - a0)] += (L.usd * H.G[j]) / g0;
          }
          H.cache = { key, img: heatImage(grid, cols, rows, p, api.heatRGB) };
        }
        drawHeat(api, H.cache.img, a0, b0, rows * cell);
        // levels still open now, as bars at the right edge (a liquidation map)
        if (p.map === 'Show') {
          const now = new Map();
          for (const L of H.levels) {
            if (L.end !== n) continue;
            const r = Math.floor((api.yOf(L.px) - top) / cell);
            if (r < 0 || r >= rows) continue;
            const k = r * 2 + (L.long ? 0 : 1);
            now.set(k, (now.get(k) || 0) + L.usd * (H.G[n - 1] / H.G[L.start]));
          }
          let mx = 0;
          for (const v of now.values()) mx = Math.max(mx, v);
          const W = Math.min(110, api.right * 0.12);
          for (const [k, v] of now) {
            ctx.fillStyle = api.color(k % 2 ? 'short' : 'long');
            const w = Math.max(1, (v / mx) * W);
            ctx.fillRect(api.right - w, top + (k >> 1) * cell, w, Math.max(1, cell - (cell > 2 ? 0.5 : 0)));
          }
        }
      },
    },
    {
      id: 'bookheat', name: 'Liquidity Heatmap (order book)', short: 'Book heatmap', overlay: true, underlay: true, live: 'book',
      desc: 'Resting limit orders at each price over time, recorded from the live order book while the chart is open (Binance, Bybit and Hyperliquid markets). Bright bands are large orders waiting; watch whether the price is pulled to them, bounces or eats through.',
      inputs: [HEAT_PALETTE, HEAT_CONTRAST, HEAT_CELL],
      plots: [],
      calc: () => ({ $label: 'recorded live' }),
      paint(api) {
        const R = api.chart.bookHeat;
        if (!R || !R.snaps.length) return;
        const { top, height, params: p } = api, cell = Math.max(1, p.cell), rows = Math.ceil(height / cell), colPx = 2, cols = Math.ceil(api.right / colPx);
        const key = [R.version, top, height, api.vOf(top), api.vOf(top + height), api.xOfTime(R.snaps[0].t), api.spacing, p.palette, p.contrast, cell].join('|');
        if (!R.cache || R.cache.key !== key) {
          const grid = new Float32Array(rows * cols), S = R.snaps;
          for (let k = 0; k < S.length; k++) {
            const x0 = api.xOfTime(S[k].t) - api.spacing / 2, x1 = (k + 1 < S.length ? api.xOfTime(S[k + 1].t) : api.xOfTime(Date.now())) - api.spacing / 2;
            if (x1 < 0 || x0 > api.right) continue;
            const c0 = Math.max(0, Math.floor(x0 / colPx)), c1 = Math.min(cols - 1, Math.max(c0, Math.ceil(x1 / colPx) - 1));
            for (const side of [S[k].bids, S[k].asks]) {
              for (let m = 0; m < side.length; m += 2) {
                const r = Math.floor((api.yOf(side[m]) - top) / cell);
                if (r < 0 || r >= rows) continue;
                const v = side[m] * side[m + 1];
                for (let c = c0; c <= c1; c++) { const q = r * cols + c; if (v > grid[q]) grid[q] = v; }
              }
            }
          }
          R.cache = { key, img: heatImage(grid, cols, rows, p, api.heatRGB, true) };
        }
        const { ctx } = api;
        ctx.save();
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(R.cache.img, 0, top, cols * colPx, rows * cell);
        ctx.restore();
      },
    },
  ];
  for (const d of DERIVS) DEFS.push(d);

  // ================================================================ 1.23: classic, community-style and session indicators
  const INT = (key, label, def, min = 1, max = 2000) => ({ key, label, type: 'int', def, min, max });
  const FLT = (key, label, def, step = 0.1, min = 0) => ({ key, label, type: 'float', def, min, step });
  const SEL = (key, label, options, def) => ({ key, label, type: 'select', options, def: def || options[0] });
  const H_ = (bars) => bars.map((b) => b.h), L_ = (bars) => bars.map((b) => b.l), O_ = (bars) => bars.map((b) => b.o);
  const HLC3 = (bars) => bars.map((b) => (b.h + b.l + b.c) / 3);
  const zip = (a, b, f) => a.map((v, i) => f(v, b[i], i));
  const div = (a, b, k = 1) => a.map((v, i) => (b[i] ? (k * v) / b[i] : NaN));
  const median = (arr) => { const s = arr.slice().sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  function rollMedian(a, n) { return a.map((_, i) => (i >= n - 1 ? median(a.slice(i - n + 1, i + 1)) : NaN)); }
  // swing highs / lows confirmed `r` bars later: [index, value] lists
  function pivotsOf(arr, l, r, high) {
    const out = [];
    for (let i = l; i < arr.length - r; i++) {
      let ok = true;
      for (let k = i - l; k <= i + r && ok; k++) if (k !== i && (high ? arr[k] > arr[i] || (k > i && arr[k] === arr[i]) : arr[k] < arr[i] || (k > i && arr[k] === arr[i]))) ok = false;
      if (ok) out.push(i);
    }
    return out;
  }
  const PAL4 = ['#22AB94', '#A5D6CF', '#F7525F', '#F4B5BA']; // strong up, weak up, strong down, weak down

  const MORE2 = [
    // ---------------- trend and overlays ----------------
    {
      id: 'bbi', name: 'Bull Bear Index', short: 'BBI', overlay: true, desc: 'Average of the 3, 6, 12 and 24 period moving averages',
      inputs: [INT('a', 'MA 1', 3), INT('b', 'MA 2', 6), INT('c', 'MA 3', 12), INT('d', 'MA 4', 24)],
      plots: [{ key: 'bbi', name: 'BBI', color: '#E040FB' }],
      calc(bars, p) { const s = C(bars), m = [p.a, p.b, p.c, p.d].map((n) => sma(s, n)); return { bbi: s.map((_, i) => (m[0][i] + m[1][i] + m[2][i] + m[3][i]) / 4) }; },
    },
    {
      id: 'dma', name: 'Different of Moving Average', short: 'DMA', overlay: false, desc: 'Fast moving average minus slow moving average, with its own average',
      inputs: [INT('fast', 'Fast', 10), INT('slow', 'Slow', 50), INT('ama', 'Signal', 10)],
      plots: [{ key: 'dma', name: 'DMA', color: '#3D8BFD' }, { key: 'ama', name: 'AMA', color: '#F5A623' }], levels: [0],
      calc(bars, p) { const s = C(bars), d = sub(sma(s, p.fast), sma(s, p.slow)); return { dma: d, ama: sma(d, p.ama) }; },
    },
    {
      id: 'cks', name: 'Chande Kroll Stop', short: 'CKS', overlay: true, desc: 'Stops for longs and shorts from the highest high / lowest low minus a multiple of ATR',
      inputs: [INT('p', 'ATR length', 10), FLT('x', 'ATR multiplier', 1), INT('q', 'Stop length', 9)],
      plots: [{ key: 'sl', name: 'Stop long', color: '#22AB94' }, { key: 'ss', name: 'Stop short', color: '#F7525F' }],
      calc(bars, p) {
        const a = atr(bars, p.p), fh = zip(highest(H_(bars), p.p), a, (h, v) => h - p.x * v), fl = zip(lowest(L_(bars), p.p), a, (l, v) => l + p.x * v);
        return { ss: highest(fh, p.q), sl: lowest(fl, p.q) };
      },
    },
    {
      id: 'vstop', name: 'Volatility Stop', short: 'VStop', overlay: true, desc: 'A trailing stop at a multiple of ATR from the close; flips when the close crosses it',
      inputs: [INT('length', 'ATR length', 20), FLT('mult', 'Multiplier', 2)],
      plots: [{ key: 'v', name: 'Stop', palette: UPDN, lineType: 'linebr' }],
      calc(bars, p) {
        const a = atr(bars, p.length), n = bars.length, v = nanArr(n), idx = new Array(n).fill(0);
        let up = true, maxC = NaN, minC = NaN, stop = NaN;
        for (let i = 0; i < n; i++) {
          const c = bars[i].c;
          if (!isFinite(a[i])) { maxC = c; minC = c; continue; }
          maxC = Math.max(maxC, c); minC = Math.min(minC, c);
          const s = up ? maxC - p.mult * a[i] : minC + p.mult * a[i];
          stop = isFinite(stop) ? (up ? Math.max(stop, s) : Math.min(stop, s)) : s;
          if (up ? c < stop : c > stop) { up = !up; maxC = c; minC = c; stop = up ? c - p.mult * a[i] : c + p.mult * a[i]; }
          v[i] = stop; idx[i] = up ? 0 : 1;
        }
        return { v, v$i: idx };
      },
    },
    {
      id: 'median', name: 'Median', short: 'Median', overlay: true, desc: 'Rolling median of the price, with ATR bands',
      inputs: [INT('length', 'Length', 3), INT('atr', 'ATR length', 14), FLT('mult', 'ATR multiplier', 2), { ...SRC, def: 'hl2' }],
      plots: [{ key: 'm', name: 'Median', color: '#F5A623' }, { key: 'u', name: 'Upper', color: '#22AB94' }, { key: 'l', name: 'Lower', color: '#F7525F' }],
      calc(bars, p) { const m = rollMedian(source(bars, p.source), p.length), a = atr(bars, p.atr); return { m, u: zip(m, a, (x, y) => x + p.mult * y), l: zip(m, a, (x, y) => x - p.mult * y) }; },
    },
    {
      id: 'twap', name: 'Time-Weighted Average Price', short: 'TWAP', overlay: true, desc: 'Average price of the session so far (every candle counts the same), restarting each day',
      inputs: [SEL('anchor', 'Restart every', ['Day', 'Week', 'Month'])],
      plots: [{ key: 't', name: 'TWAP', color: '#9C6ADE', lineType: 'linebr' }],
      calc(bars, p) {
        const D = 86400e3, key = (t) => (p.anchor === 'Day' ? Math.floor(t / D) : p.anchor === 'Week' ? Math.floor((t / D + 3) / 7) : new Date(t).getUTCFullYear() * 12 + new Date(t).getUTCMonth());
        let k0 = null, s = 0, n = 0;
        return { t: bars.map((b) => { const k = key(b.t); if (k !== k0) { k0 = k; s = 0; n = 0; } s += (b.o + b.h + b.l + b.c) / 4; n++; return s / n; }) };
      },
    },
    {
      id: 'lrc', name: 'Linear Regression Channel', short: 'LR Channel', overlay: true, desc: 'Best-fit line through the last N closes, with standard deviation bands',
      inputs: [INT('length', 'Length', 100, 2), FLT('dev', 'Deviations', 2)],
      plots: [{ key: 'm', name: 'Regression', color: '#3D8BFD' }, { key: 'u', name: 'Upper', color: '#F7525F' }, { key: 'l', name: 'Lower', color: '#22AB94' }],
      calc(bars, p) {
        const n = bars.length, L = Math.min(p.length, n), m = nanArr(n), u = nanArr(n), l = nanArr(n);
        if (L < 2) return { m, u, l };
        let sx = 0, sy = 0, sxx = 0, sxy = 0;
        for (let j = 0; j < L; j++) { const y = bars[n - L + j].c; sx += j; sy += y; sxx += j * j; sxy += j * y; }
        const slope = (L * sxy - sx * sy) / (L * sxx - sx * sx), b0 = (sy - slope * sx) / L;
        let se = 0;
        for (let j = 0; j < L; j++) se += (bars[n - L + j].c - (b0 + slope * j)) ** 2;
        const sd = Math.sqrt(se / L);
        for (let j = 0; j < L; j++) { const v = b0 + slope * j; m[n - L + j] = v; u[n - L + j] = v + p.dev * sd; l[n - L + j] = v - p.dev * sd; }
        return { m, u, l };
      },
    },
    {
      id: 'pivhl', name: 'Pivot Points High Low', short: 'Pivots HL', overlay: true, desc: 'Marks swing highs and lows (a high with lower highs on both sides)',
      inputs: [INT('left', 'Bars to the left', 10), INT('right', 'Bars to the right', 10)],
      plots: [{ key: 'ph', name: 'Pivot high', style: 'mark', position: 'above', color: '#F7525F', text: 'H' }, { key: 'pl', name: 'Pivot low', style: 'mark', position: 'below', color: '#22AB94', text: 'L' }],
      calc(bars, p) {
        const n = bars.length, ph = new Array(n).fill(0), pl = new Array(n).fill(0);
        for (const i of pivotsOf(H_(bars), p.left, p.right, true)) ph[i] = 1;
        for (const i of pivotsOf(L_(bars), p.left, p.right, false)) pl[i] = 1;
        return { ph, pl };
      },
    },
    {
      id: 'gaps', name: 'Gaps', short: 'Gaps', overlay: true, desc: 'Price gaps between one candle and the next, shown until the price fills them',
      inputs: [FLT('minPct', 'Minimum gap (%)', 0.1, 0.05), INT('max', 'Gaps to show', 10), YES_NO('filled', 'Show filled gaps', 'No')],
      plots: [], colors: [{ key: 'up', name: 'Gap up', color: 'rgba(34,171,148,0.22)' }, { key: 'dn', name: 'Gap down', color: 'rgba(247,82,95,0.22)' }],
      calc(bars, p) {
        const list = [];
        for (let i = 1; i < bars.length; i++) {
          const a = bars[i - 1], b = bars[i], up = b.l > a.h, dn = b.h < a.l;
          if (!up && !dn) continue;
          const top = up ? b.l : a.l, bot = up ? a.h : b.h;
          if ((top - bot) / a.c < p.minPct / 100) continue;
          let end = null;
          for (let k = i + 1; k < bars.length; k++) if (up ? bars[k].l <= bot : bars[k].h >= top) { end = k; break; }
          if (end != null && p.filled !== 'Yes') continue;
          list.push({ t1: a.t, t2: end == null ? null : bars[end].t, top, bot, color: up ? 'up' : 'dn', label: up ? 'Gap up' : 'Gap down' });
        }
        return zoneOut(list.slice(-p.max));
      },
      paint: paintZones,
    },
    {
      id: 'hulltrend', name: 'Hull Trend', short: 'Hull trend', overlay: true, desc: 'A Hull moving average colored by its direction, with the band to its value two candles ago',
      inputs: [INT('length', 'Length', 55), SEL('type', 'Kind', ['HMA', 'EHMA', 'THMA'])],
      plots: [{ key: 'h', name: 'Hull', palette: UPDN, width: 2 }, { key: 'h2', name: 'Two candles ago', palette: UPDN }],
      fills: [{ from: 'h', to: 'h2', key: 'f', color: 'rgba(34,171,148,0.15)', colorDown: 'rgba(247,82,95,0.15)' }],
      calc(bars, p) {
        const s = C(bars), n = p.length, half = Math.max(1, Math.round(n / 2)), sq = Math.max(1, Math.round(Math.sqrt(n)));
        let hm;
        if (p.type === 'EHMA') hm = ema(sub(ema(s, half).map((v) => 2 * v), ema(s, n)), sq);
        else if (p.type === 'THMA') { const k = Math.max(1, Math.round(n / 2)), a = wma(s, Math.max(1, Math.round(k / 3))), b = wma(s, Math.max(1, Math.round(k / 2))), c = wma(s, k); hm = wma(a.map((v, i) => 3 * v - b[i] - c[i]), k); }
        else hm = wma(sub(wma(s, half).map((v) => 2 * v), wma(s, n)), sq);
        const h2 = shiftFwd(hm, 2), idx = hm.map((v, i) => (v >= h2[i] ? 0 : 1));
        return { h: hm, h2, h$i: idx, h2$i: idx };
      },
    },
    {
      id: 'nwe', name: 'Kernel Regression Envelope', short: 'Kernel env', overlay: true, desc: 'Gaussian kernel smoothing of the price (Nadaraya–Watson, only past candles, so it never repaints) with a band at a multiple of the average distance',
      inputs: [FLT('h', 'Bandwidth', 8, 0.5, 0.5), FLT('mult', 'Band multiplier', 3), INT('look', 'Window', 100, 10, 500), SRC],
      plots: [{ key: 'm', name: 'Kernel', palette: UPDN }, { key: 'u', name: 'Upper', color: '#F7525F' }, { key: 'l', name: 'Lower', color: '#22AB94' }],
      calc(bars, p) {
        const s = source(bars, p.source), n = s.length, W = Math.min(p.look, 500), w = Array.from({ length: W }, (_, j) => Math.exp(-(j * j) / (2 * p.h * p.h)));
        const m = nanArr(n);
        for (let i = 0; i < n; i++) { let a = 0, b = 0; for (let j = 0; j < W && i - j >= 0; j++) { a += s[i - j] * w[j]; b += w[j]; } if (i >= W - 1) m[i] = a / b; }
        const mae = sma(s.map((v, i) => Math.abs(v - m[i])), W).map((v) => v * p.mult);
        return { m, m$i: dirIdx(m), u: zip(m, mae, (x, d) => x + d), l: zip(m, mae, (x, d) => x - d) };
      },
    },
    {
      id: 'rangefilter', name: 'Range Filter', short: 'Range filter', overlay: true, desc: 'A line that only moves when the price moves more than its smoothed average range; buy and sell marks when it turns',
      inputs: [INT('length', 'Sampling period', 100), FLT('mult', 'Range multiplier', 3)],
      plots: [{ key: 'f', name: 'Filter', palette: UPDN, width: 2 }, { key: 'buy', name: 'Buy', style: 'mark', position: 'below', color: '#22AB94', text: 'Buy' }, { key: 'sell', name: 'Sell', style: 'mark', position: 'above', color: '#F7525F', text: 'Sell' }],
      calc(bars, p) {
        const s = C(bars), n = s.length, rng = ema(ema(s.map((v, i) => (i ? Math.abs(v - s[i - 1]) : NaN)), p.length), 2 * p.length - 1).map((v) => v * p.mult);
        const f = nanArr(n), idx = new Array(n).fill(0), buy = new Array(n).fill(0), sell = new Array(n).fill(0);
        let prev = NaN, dir = 0, lastDir = 0;
        for (let i = 0; i < n; i++) {
          if (!isFinite(rng[i])) { prev = s[i]; continue; }
          const x = s[i], r = rng[i];
          const v = x > prev ? Math.max(prev, x - r) : Math.min(prev, x + r);
          dir = v > prev ? 1 : v < prev ? -1 : dir;
          f[i] = v; idx[i] = dir < 0 ? 1 : 0;
          if (dir && dir !== lastDir && lastDir !== 0) { if (dir > 0) buy[i] = 1; else sell[i] = 1; }
          if (dir) lastDir = dir;
          prev = v;
        }
        return { f, f$i: idx, buy, sell };
      },
    },
    {
      id: 'halftrend', name: 'HalfTrend', short: 'HalfTrend', overlay: true, desc: 'A trend line that changes side when the price closes beyond the recent highs or lows; ATR bands',
      inputs: [INT('amp', 'Amplitude', 2), FLT('dev', 'Channel deviation', 2)],
      plots: [{ key: 'ht', name: 'HalfTrend', palette: ['#3D8BFD', '#F7525F'], width: 2 }, { key: 'buy', name: 'Buy', style: 'mark', position: 'below', color: '#3D8BFD' }, { key: 'sell', name: 'Sell', style: 'mark', position: 'above', color: '#F7525F' }],
      calc(bars, p) {
        const n = bars.length, a2 = atr(bars, 100).map((v) => v / 2), hh = highest(H_(bars), p.amp), ll = lowest(L_(bars), p.amp), hma = sma(H_(bars), p.amp), lma = sma(L_(bars), p.amp);
        const ht = nanArr(n), idx = new Array(n).fill(0), buy = new Array(n).fill(0), sell = new Array(n).fill(0);
        let trend = 0, next = 0, maxLow = n ? bars[0].l : 0, minHigh = n ? bars[0].h : 0, up = NaN, down = NaN, prevTrend = 0;
        for (let i = 1; i < n; i++) {
          if (!isFinite(hh[i]) || !isFinite(a2[i])) continue;
          if (next === 1) { maxLow = Math.max(ll[i], maxLow); if (hma[i] < maxLow && bars[i].c < bars[i - 1].l) { trend = 1; next = 0; minHigh = hh[i]; } }
          else { minHigh = Math.min(hh[i], minHigh); if (lma[i] > minHigh && bars[i].c > bars[i - 1].h) { trend = 0; next = 1; maxLow = ll[i]; } }
          if (trend === 0) { up = prevTrend !== 0 ? (isFinite(down) ? down : maxLow) : isFinite(up) ? Math.max(maxLow, up) : maxLow; if (prevTrend !== 0) buy[i] = 1; }
          else { down = prevTrend !== 1 ? (isFinite(up) ? up : minHigh) : isFinite(down) ? Math.min(minHigh, down) : minHigh; if (prevTrend !== 1) sell[i] = 1; }
          ht[i] = trend === 0 ? up : down; idx[i] = trend;
          prevTrend = trend;
        }
        return { ht, ht$i: idx, buy, sell };
      },
    },
    {
      id: 'atrtrail', name: 'ATR Trailing Stop', short: 'ATR trail', overlay: true, desc: 'A stop that trails the close by a multiple of ATR; buy and sell marks when the close crosses it',
      inputs: [INT('length', 'ATR length', 10), FLT('key', 'Sensitivity (multiplier)', 1)],
      plots: [{ key: 's', name: 'Stop', palette: UPDN }, { key: 'buy', name: 'Buy', style: 'mark', position: 'below', color: '#22AB94', text: 'Buy' }, { key: 'sell', name: 'Sell', style: 'mark', position: 'above', color: '#F7525F', text: 'Sell' }],
      calc(bars, p) {
        const a = atr(bars, p.length), n = bars.length, s = nanArr(n), idx = new Array(n).fill(0), buy = new Array(n).fill(0), sell = new Array(n).fill(0);
        let st = NaN;
        for (let i = 1; i < n; i++) {
          if (!isFinite(a[i])) continue;
          const c = bars[i].c, c1 = bars[i - 1].c, loss = p.key * a[i];
          if (!isFinite(st)) st = c - loss;
          else if (c > st && c1 > st) st = Math.max(st, c - loss);
          else if (c < st && c1 < st) st = Math.min(st, c + loss);
          else st = c > st ? c - loss : c + loss;
          s[i] = st; idx[i] = c >= st ? 0 : 1;
          if (isFinite(s[i - 1])) { if (c1 <= s[i - 1] && c > st) buy[i] = 1; if (c1 >= s[i - 1] && c < st) sell[i] = 1; }
        }
        return { s, s$i: idx, buy, sell };
      },
    },
    {
      id: 'sessions', name: 'Trading Sessions', short: 'Sessions', overlay: true, desc: 'Shades the Asia, London and New York sessions (or the ICT killzones) on intraday charts, in each market\'s local time',
      inputs: [SEL('mode', 'Show', ['Markets', 'Killzones'])],
      plots: [], colors: [{ key: 'asia', name: 'Asia', color: 'rgba(156,106,222,0.10)' }, { key: 'london', name: 'London', color: 'rgba(61,139,253,0.10)' }, { key: 'ny', name: 'New York', color: 'rgba(245,166,35,0.10)' }, { key: 'lc', name: 'London close', color: 'rgba(34,171,148,0.10)' }],
      calc: () => ({}),
      paint(api) {
        const { ctx, bars, params: p } = api;
        if (bars.length < 2 || bars[1].t - bars[0].t >= 4 * 3600e3) return;
        // [color key, label, zone, from hour, to hour] in that zone's local time (daylight saving included)
        const S = p.mode === 'Killzones'
          ? [['asia', 'Asia KZ', 'America/New_York', 20, 24], ['london', 'London open KZ', 'America/New_York', 2, 5], ['ny', 'New York open KZ', 'America/New_York', 7, 10], ['lc', 'London close KZ', 'America/New_York', 10, 12]]
          : [['asia', 'Tokyo', 'Asia/Tokyo', 9, 15], ['london', 'London', 'Europe/London', 8, 16.5], ['ny', 'New York', 'America/New_York', 9.5, 16]];
        const fm = {}, hourIn = (t, z) => { const f = fm[z] || (fm[z] = new Intl.DateTimeFormat('en-US', { timeZone: z, hourCycle: 'h23', hour: '2-digit', minute: '2-digit', weekday: 'short' })); const P = Object.fromEntries(f.formatToParts(new Date(t)).map((x) => [x.type, x.value])); return { h: (+P.hour % 24) + +P.minute / 60, wd: P.weekday }; };
        const a = Math.max(0, api.a), b = Math.min(bars.length - 1, api.b), sp = (api.xAt(1) - api.xAt(0)) || 1;
        ctx.save();
        ctx.font = '600 10px ' + api.font;
        ctx.textBaseline = 'top';
        S.forEach(([key, label, zone, from, to], row) => {
          let start = -1;
          const inside = (i) => { const q = hourIn(bars[i].t, zone); return q.wd !== 'Sat' && q.wd !== 'Sun' && q.h >= from && q.h < to; };
          for (let i = a; i <= b + 1; i++) {
            const on = i <= b && inside(i);
            if (on && start < 0) start = i;
            if (!on && start >= 0) {
              const x1 = api.xAt(start) - sp / 2, x2 = api.xAt(i - 1) + sp / 2;
              ctx.fillStyle = api.color(key);
              ctx.fillRect(x1, api.top, x2 - x1, api.height);
              if (x2 - x1 > 40) { ctx.fillStyle = api.textColor; ctx.globalAlpha = 0.65; ctx.fillText(label, x1 + 3, api.top + api.height - 16 - row * 12); ctx.globalAlpha = 1; } // (at the bottom, clear of the legend)
              start = -1;
            }
          }
        });
        ctx.restore();
      },
    },
    {
      id: 'pvp', name: 'Volume Profile (Sessions)', short: 'Session VP', overlay: true, desc: 'A volume profile for each day (or week, or month), with its point of control and value area',
      inputs: [SEL('period', 'Each', ['Day', 'Week', 'Month']), INT('rows', 'Rows', 24, 6, 100), INT('va', 'Value area (%)', 70, 10, 100)],
      plots: [], colors: [{ key: 'up', name: 'Buy volume', color: 'rgba(34,171,148,0.35)' }, { key: 'down', name: 'Sell volume', color: 'rgba(247,82,95,0.35)' }, { key: 'poc', name: 'Point of control', color: '#F5A623' }],
      calc: () => ({}),
      paint(api) {
        const { ctx, bars, params: p } = api, D = 86400e3;
        const key = (t) => (p.period === 'Day' ? Math.floor(t / D) : p.period === 'Week' ? Math.floor((t / D + 3) / 7) : new Date(t).getUTCFullYear() * 12 + new Date(t).getUTCMonth());
        const a = Math.max(0, api.a), b = Math.min(bars.length - 1, api.b);
        let i = a;
        while (i > 0 && key(bars[i - 1].t) === key(bars[a].t)) i--;
        ctx.save();
        while (i <= b) {
          let j = i;
          while (j + 1 < bars.length && key(bars[j + 1].t) === key(bars[i].t)) j++;
          if (j - i >= 2) {
            let lo = Infinity, hi = -Infinity;
            for (let k = i; k <= j; k++) { lo = Math.min(lo, bars[k].l); hi = Math.max(hi, bars[k].h); }
            const n = p.rows, step = (hi - lo) / n || 1, up = new Float64Array(n), dn = new Float64Array(n);
            for (let k = i; k <= j; k++) {
              const B = bars[k], v = B.v || 0, buy = B.bv >= 0 ? B.bv : B.c >= B.o ? v : 0, span = B.h - B.l;
              const r0 = Math.min(n - 1, Math.floor((B.l - lo) / step)), r1 = Math.min(n - 1, Math.floor((B.h - lo) / step));
              for (let r = r0; r <= r1; r++) { const f = span > 0 ? (Math.min(B.h, lo + (r + 1) * step) - Math.max(B.l, lo + r * step)) / span : 1 / (r1 - r0 + 1); up[r] += buy * f; dn[r] += (v - buy) * f; }
            }
            const tot = Array.from(up, (u, r) => u + dn[r]);
            let poc = 0;
            for (let r = 1; r < n; r++) if (tot[r] > tot[poc]) poc = r;
            const all = tot.reduce((x, y) => x + y, 0);
            let vaLo = poc, vaHi = poc, inVa = tot[poc];
            while (all && inVa < (all * p.va) / 100 && (vaLo > 0 || vaHi < n - 1)) { const lo2 = vaLo > 0 ? tot[vaLo - 1] : -1, hi2 = vaHi < n - 1 ? tot[vaHi + 1] : -1; if (hi2 >= lo2) inVa += tot[++vaHi]; else inVa += tot[--vaLo]; }
            const x0 = api.xAt(i) - 2, W = Math.max(4, api.xAt(j) - x0) * 0.9, mx = tot[poc] || 1;
            for (let r = 0; r < n; r++) {
              const y1 = api.yOf(lo + (r + 1) * step), y2 = api.yOf(lo + r * step), hh = Math.max(1, Math.abs(y2 - y1) - 1), wu = (up[r] / mx) * W, wd = (dn[r] / mx) * W;
              ctx.globalAlpha = r >= vaLo && r <= vaHi ? 1 : 0.45;
              ctx.fillStyle = api.color('up'); ctx.fillRect(x0, Math.min(y1, y2), wu, hh);
              ctx.fillStyle = api.color('down'); ctx.fillRect(x0 + wu, Math.min(y1, y2), wd, hh);
            }
            ctx.globalAlpha = 1;
            const yp = Math.round(api.yOf(lo + (poc + 0.5) * step)) + 0.5;
            ctx.strokeStyle = api.color('poc'); ctx.lineWidth = 1.5;
            ctx.beginPath(); ctx.moveTo(x0, yp); ctx.lineTo(api.xAt(j), yp); ctx.stroke();
          }
          i = j + 1;
        }
        ctx.restore();
      },
    },
    // ---------------- oscillators ----------------
    {
      id: 'aroonosc', name: 'Aroon Oscillator', short: 'Aroon Osc', overlay: false, desc: 'Aroon Up minus Aroon Down',
      inputs: [LEN(14)], plots: [{ key: 'o', name: 'Aroon Osc', color: '#3D8BFD' }], levels: [50, 0, -50], range: [-100, 100],
      calc(bars, p) {
        const n = p.length, h = H_(bars), l = L_(bars);
        return { o: bars.map((_, i) => { if (i < n) return NaN; let hi = i, lo = i; for (let k = i - n; k <= i; k++) { if (h[k] >= h[hi]) hi = k; if (l[k] <= l[lo]) lo = k; } return (100 * (n - (i - hi))) / n - (100 * (n - (i - lo))) / n; }) };
      },
    },
    {
      id: 'kdj', name: 'KDJ', short: 'KDJ', overlay: false, desc: 'Stochastic K and D with J = 3K − 2D',
      inputs: [INT('n', 'Period', 9), INT('m1', 'K smoothing', 3), INT('m2', 'D smoothing', 3)],
      plots: [{ key: 'k', name: 'K', color: '#F5A623' }, { key: 'd', name: 'D', color: '#3D8BFD' }, { key: 'j', name: 'J', color: '#E040FB' }], levels: [80, 50, 20],
      calc(bars, p) {
        const hh = highest(H_(bars), p.n), ll = lowest(L_(bars), p.n), n = bars.length, k = nanArr(n), d = nanArr(n), j = nanArr(n);
        let K = 50, D = 50;
        for (let i = 0; i < n; i++) {
          if (!isFinite(hh[i])) continue;
          const rsv = hh[i] > ll[i] ? ((bars[i].c - ll[i]) / (hh[i] - ll[i])) * 100 : 50;
          K = ((p.m1 - 1) * K + rsv) / p.m1; D = ((p.m2 - 1) * D + K) / p.m2;
          k[i] = K; d[i] = D; j[i] = 3 * K - 2 * D;
        }
        return { k, d, j };
      },
    },
    {
      id: 'bias', name: 'Bias', short: 'BIAS', overlay: false, desc: 'How far the close is from its moving averages, in percent',
      inputs: [INT('a', 'Length 1', 6), INT('b', 'Length 2', 12), INT('c', 'Length 3', 24)],
      plots: [{ key: 'a', name: 'BIAS 1', color: '#F5A623' }, { key: 'b', name: 'BIAS 2', color: '#3D8BFD' }, { key: 'c', name: 'BIAS 3', color: '#E040FB' }], levels: [0],
      calc(bars, p) { const s = C(bars), f = (n) => { const m = sma(s, n); return s.map((v, i) => (m[i] ? ((v - m[i]) / m[i]) * 100 : NaN)); }; return { a: f(p.a), b: f(p.b), c: f(p.c) }; },
    },
    {
      id: 'brar', name: 'BRAR', short: 'BRAR', overlay: false, desc: 'AR: strength of highs vs lows from the open; BR: from the previous close',
      inputs: [LEN(26)], plots: [{ key: 'ar', name: 'AR', color: '#F5A623' }, { key: 'br', name: 'BR', color: '#3D8BFD' }], levels: [100],
      calc(bars, p) {
        const n = p.length, hoS = rsum(bars.map((b) => b.h - b.o), n), olS = rsum(bars.map((b) => b.o - b.l), n);
        const hc = rsum(bars.map((b, i) => (i ? Math.max(0, b.h - bars[i - 1].c) : NaN)), n), cl = rsum(bars.map((b, i) => (i ? Math.max(0, bars[i - 1].c - b.l) : NaN)), n);
        return { ar: div(hoS, olS, 100), br: div(hc, cl, 100) };
      },
    },
    {
      id: 'cr', name: 'CR (Energy Index)', short: 'CR', overlay: false, desc: 'Buying vs selling pressure measured from the previous candle\'s middle price',
      inputs: [LEN(26), INT('ma', 'MA length', 10)], plots: [{ key: 'cr', name: 'CR', color: '#3D8BFD' }, { key: 'm', name: 'MA', color: '#F5A623' }], levels: [100],
      calc(bars, p) {
        const mid = bars.map((b) => (b.h + b.l) / 2), u = rsum(bars.map((b, i) => (i ? Math.max(0, b.h - mid[i - 1]) : NaN)), p.length), d = rsum(bars.map((b, i) => (i ? Math.max(0, mid[i - 1] - b.l) : NaN)), p.length);
        const cr = div(u, d, 100);
        return { cr, m: sma(cr, p.ma) };
      },
    },
    {
      id: 'psy', name: 'Psychological Line', short: 'PSY', overlay: false, desc: 'Share of candles that closed higher over the period, in percent',
      inputs: [LEN(12), INT('ma', 'MA length', 6)], plots: [{ key: 'psy', name: 'PSY', color: '#3D8BFD' }, { key: 'm', name: 'MA', color: '#F5A623' }], levels: [75, 50, 25], range: [0, 100],
      calc(bars, p) { const u = rsum(bars.map((b, i) => (i ? (b.c > bars[i - 1].c ? 1 : 0) : NaN)), p.length).map((v) => (v * 100) / p.length); return { psy: u, m: sma(u, p.ma) }; },
    },
    {
      id: 'bbp', name: 'Bull Bear Power', short: 'BBP', overlay: false, desc: 'High minus the EMA plus low minus the EMA: who is pushing the price away from its average',
      inputs: [LEN(13)], plots: [{ key: 'b', name: 'BBP', style: 'histogram', palette: UPDN }], levels: [0],
      calc(bars, p) { const e = ema(C(bars), p.length), b = bars.map((x, i) => x.h - e[i] + (x.l - e[i])); return { b, b$i: b.map((v) => (v >= 0 ? 0 : 1)) }; },
    },
    {
      id: 'rvgi', name: 'Relative Vigor Index', short: 'RVGI', overlay: false, desc: 'Close minus open relative to the candle range, smoothed, with a signal line',
      inputs: [LEN(10)], plots: [{ key: 'r', name: 'RVGI', color: '#22AB94' }, { key: 's', name: 'Signal', color: '#F7525F' }], levels: [0],
      calc(bars, p) {
        const sw = (a) => a.map((v, i) => (i >= 3 ? (a[i] + 2 * a[i - 1] + 2 * a[i - 2] + a[i - 3]) / 6 : NaN));
        const num = sw(bars.map((b) => b.c - b.o)), den = sw(bars.map((b) => b.h - b.l));
        const r = div(rsum(num, p.length), rsum(den, p.length));
        return { r, s: sw(r) };
      },
    },
    {
      id: 'smiergo', name: 'SMI Ergodic', short: 'SMI Ergodic', overlay: false, desc: 'True Strength Index (fast settings) with a signal line and their difference as a histogram',
      inputs: [INT('long', 'Long length', 20), INT('short', 'Short length', 5), INT('sig', 'Signal length', 5)],
      plots: [{ key: 'osc', name: 'Oscillator', style: 'histogram', palette: UPDN }, { key: 'smi', name: 'SMI', color: '#3D8BFD' }, { key: 's', name: 'Signal', color: '#F5A623' }], levels: [0],
      calc(bars, p) {
        const d = change(C(bars)), a = ema(ema(d, p.long), p.short), b = ema(ema(d.map(Math.abs), p.long), p.short), smi = div(a, b), s = ema(smi, p.sig), osc = sub(smi, s);
        return { smi, s, osc, osc$i: osc.map((v) => (v >= 0 ? 0 : 1)) };
      },
    },
    {
      id: 'wcci', name: 'Woodies CCI', short: 'Woodies CCI', overlay: false, desc: 'CCI 14 as a histogram (green after six candles above zero, red after six below) with a fast "turbo" CCI 6',
      inputs: [INT('cci', 'CCI length', 14), INT('turbo', 'Turbo length', 6)],
      plots: [{ key: 'h', name: 'CCI', style: 'histogram', palette: ['#22AB94', '#F7525F', '#9AA3B2'] }, { key: 't', name: 'Turbo', color: '#F5A623' }], levels: [200, 100, 0, -100, -200],
      calc(bars, p) {
        const cciOf = (n) => { const tp = HLC3(bars), m = sma(tp, n); return tp.map((v, i) => { if (!isFinite(m[i])) return NaN; let md = 0; for (let k = i - n + 1; k <= i; k++) md += Math.abs(tp[k] - m[i]); md /= n; return md ? (v - m[i]) / (0.015 * md) : 0; }); };
        const c = cciOf(p.cci), idx = c.map((_, i) => { if (i < 5) return 2; let up = true, dn = true; for (let k = i - 5; k <= i; k++) { if (!(c[k] > 0)) up = false; if (!(c[k] < 0)) dn = false; } return up ? 0 : dn ? 1 : 2; });
        return { h: c, h$i: idx, t: cciOf(p.turbo) };
      },
    },
    {
      id: 'rci', name: 'Rank Correlation Index (ribbon)', short: 'RCI', overlay: false, desc: 'Spearman rank correlation between time and price, for three lengths (−100 to 100)',
      inputs: [INT('a', 'Short', 9, 2), INT('b', 'Middle', 26, 2), INT('c', 'Long', 52, 2)],
      plots: [{ key: 'a', name: 'RCI short', color: '#F7525F' }, { key: 'b', name: 'RCI middle', color: '#3D8BFD' }, { key: 'c', name: 'RCI long', color: '#22AB94' }], levels: [80, 0, -80], range: [-100, 100],
      calc(bars, p) {
        const s = C(bars), f = (n) => s.map((_, i) => {
          if (i < n - 1) return NaN;
          const w = s.slice(i - n + 1, i + 1), order = w.map((v, k) => [v, k]).sort((x, y) => y[0] - x[0]), rank = new Array(n);
          for (let r = 0; r < n;) { let e = r; while (e + 1 < n && order[e + 1][0] === order[r][0]) e++; for (let q = r; q <= e; q++) rank[order[q][1]] = (r + e) / 2 + 1; r = e + 1; }
          let d = 0;
          for (let k = 0; k < n; k++) d += (n - k - rank[k]) ** 2;
          return (1 - (6 * d) / (n * (n * n - 1))) * 100;
        });
        return { a: f(p.a), b: f(p.b), c: f(p.c) };
      },
    },
    {
      id: 'chopzone', name: 'Chop Zone', short: 'Chop Zone', overlay: false, desc: 'Columns colored by the angle of the 34 EMA: greens trending up, reds down, yellow choppy',
      inputs: [INT('ema', 'EMA length', 34)],
      range: [0, 1], plots: [{ key: 'z', name: 'Chop zone', style: 'histogram', palette: ['#26C6DA', '#43A047', '#A5D6A7', '#009688', '#D50000', '#E91E63', '#FF6D00', '#FFB74D', '#FDD835'] }],
      calc(bars, p) {
        const e = ema(C(bars), p.ema), hh = highest(H_(bars), 30), ll = lowest(L_(bars), 30);
        const idx = bars.map((b, i) => {
          if (!isFinite(e[i - 1]) || !(hh[i] > ll[i])) return 8;
          const span = 25 / (hh[i] - ll[i]) * ll[i], y2 = ((e[i - 1] - e[i]) / ((b.h + b.l + b.c) / 3)) * span, ang = Math.round((180 * Math.atan2(y2, 1)) / Math.PI) * -1;
          return ang >= 5 ? 0 : ang >= 3.57 ? 1 : ang >= 2.14 ? 2 : ang >= 0.71 ? 3 : ang <= -5 ? 4 : ang <= -3.57 ? 5 : ang <= -2.14 ? 6 : ang <= -0.71 ? 7 : 8;
        });
        return { z: bars.map(() => 1), z$i: idx };
      },
    },
    {
      id: 'smi', name: 'Stochastic Momentum Index', short: 'SMI', overlay: false, desc: 'Where the close sits relative to the middle of the recent range, double smoothed (−100 to 100)',
      inputs: [INT('k', '%K length', 10), INT('d', '%D length', 3), INT('ema', 'EMA length', 3)],
      plots: [{ key: 's', name: 'SMI', color: '#3D8BFD' }, { key: 'sig', name: 'Signal', color: '#F5A623' }], levels: [40, 0, -40], range: [-100, 100],
      calc(bars, p) {
        const hh = highest(H_(bars), p.k), ll = lowest(L_(bars), p.k), rel = bars.map((b, i) => b.c - (hh[i] + ll[i]) / 2), rng = hh.map((h, i) => h - ll[i]);
        const ds = ema(ema(rel, p.d), p.d), dr = ema(ema(rng, p.d), p.d), s = ds.map((v, i) => (isFinite(v) && isFinite(dr[i]) ? (dr[i] ? (200 * v) / dr[i] : 0) : NaN));
        return { s, sig: ema(s, p.ema) };
      },
    },
    {
      id: 'pmo', name: 'Price Momentum Oscillator', short: 'PMO', overlay: false, desc: 'Double-smoothed rate of change, with a signal line',
      inputs: [INT('a', 'First smoothing', 35), INT('b', 'Second smoothing', 20), INT('sig', 'Signal', 10)],
      plots: [{ key: 'pmo', name: 'PMO', color: '#3D8BFD' }, { key: 's', name: 'Signal', color: '#F5A623' }], levels: [0],
      calc(bars, p) {
        const cs = (a, n) => smooth(a, n, 2 / n); // its own smoothing constant (2 / n)
        const roc = rocOf(C(bars), 1), pmo = cs(cs(roc, p.a).map((v) => v * 10), p.b);
        return { pmo, s: ema(pmo, p.sig) };
      },
    },
    {
      id: 'specialk', name: "Pring's Special K", short: 'Special K', overlay: false, desc: 'A weighted sum of short, medium and long rates of change, with a signal line',
      inputs: [INT('sig', 'Signal', 100)], plots: [{ key: 'k', name: 'Special K', color: '#3D8BFD' }, { key: 's', name: 'Signal', color: '#F5A623' }], levels: [0],
      calc(bars, p) {
        const s = C(bars), P = [[10, 10, 1], [15, 10, 2], [20, 10, 3], [30, 15, 4], [40, 50, 1], [65, 65, 2], [75, 75, 3], [100, 100, 4], [195, 130, 1], [265, 130, 2], [390, 130, 3], [530, 195, 4]];
        const parts = P.map(([r, m, w]) => sma(rocOf(s, r), m).map((v) => v * w)), k = s.map((_, i) => parts.reduce((a, x) => a + x[i], 0));
        return { k, s: sma(k, p.sig) };
      },
    },
    {
      id: 'rsidiv', name: 'RSI Divergence', short: 'RSI Div', overlay: false, desc: 'RSI with marks where price and RSI disagree: a lower low in price with a higher low in RSI (bullish), and the reverse (bearish)',
      inputs: [LEN(14), INT('l', 'Pivot bars left', 5), INT('r', 'Pivot bars right', 5), INT('range', 'Max bars between pivots', 60)],
      plots: [{ key: 'rsi', name: 'RSI', color: '#9C6ADE' }, { key: 'bull', name: 'Bullish divergence', style: 'mark', position: 'below', color: '#22AB94', text: 'Bull' }, { key: 'bear', name: 'Bearish divergence', style: 'mark', position: 'above', color: '#F7525F', text: 'Bear' }],
      levels: [70, 50, 30], bandFill: [70, 30], range: [0, 100],
      calc(bars, p) {
        const rsi = rsiOf(C(bars), p.length), n = bars.length, bull = new Array(n).fill(0), bear = new Array(n).fill(0);
        const lows = pivotsOf(rsi.map((v) => (isFinite(v) ? v : 1e9)), p.l, p.r, false), highs = pivotsOf(rsi.map((v) => (isFinite(v) ? v : -1e9)), p.l, p.r, true);
        for (let k = 1; k < lows.length; k++) { const a = lows[k - 1], b = lows[k]; if (b - a <= p.range && rsi[b] > rsi[a] && bars[b].l < bars[a].l) bull[b + p.r] = 1; }
        for (let k = 1; k < highs.length; k++) { const a = highs[k - 1], b = highs[k]; if (b - a <= p.range && rsi[b] < rsi[a] && bars[b].h > bars[a].h) bear[b + p.r] = 1; }
        return { rsi, bull, bear };
      },
    },
    {
      id: 'rvi', name: 'Relative Volatility Index', short: 'RVI', overlay: false, desc: 'Like RSI, but with the standard deviation of up and down closes instead of their size',
      inputs: [INT('sd', 'Std dev length', 10), LEN(14)], plots: [{ key: 'r', name: 'RVI', color: '#3D8BFD' }], levels: [80, 50, 20], range: [0, 100],
      calc(bars, p) {
        const s = C(bars), sd = stdev(s, p.sd), u = s.map((v, i) => (i && isFinite(sd[i]) ? (v > s[i - 1] ? sd[i] : 0) : NaN)), d = s.map((v, i) => (i && isFinite(sd[i]) ? (v < s[i - 1] ? sd[i] : 0) : NaN));
        const eu = ema(u, p.length), ed = ema(d, p.length);
        return { r: eu.map((v, i) => (isFinite(v) && isFinite(ed[i]) ? (v + ed[i] ? (100 * v) / (v + ed[i]) : 50) : NaN)) };
      },
    },
    {
      id: 'squeeze', name: 'Squeeze Momentum', short: 'Squeeze', overlay: false, desc: 'Momentum histogram; dots on the zero line show when Bollinger Bands are inside the Keltner Channel (a squeeze, dark) or not (gray)',
      inputs: [INT('bb', 'BB length', 20), FLT('bbm', 'BB multiplier', 2), INT('kc', 'KC length', 20), FLT('kcm', 'KC multiplier', 1.5)],
      plots: [{ key: 'm', name: 'Momentum', style: 'histogram', palette: PAL4 }, { key: 'sq', name: 'Squeeze', style: 'dots', palette: ['#F5A623', '#9AA3B2', '#3D8BFD'] }], levels: [0],
      calc(bars, p) {
        const s = C(bars), bm = sma(s, p.bb), sd = stdev(s, p.bb), km = sma(s, p.kc), rng = sma(trueRange(bars), p.kc);
        const sqi = s.map((_, i) => { const ub = bm[i] + p.bbm * sd[i], lb = bm[i] - p.bbm * sd[i], uk = km[i] + p.kcm * rng[i], lk = km[i] - p.kcm * rng[i]; return lb > lk && ub < uk ? 0 : lb < lk && ub > uk ? 1 : 2; });
        const hh = highest(H_(bars), p.kc), ll = lowest(L_(bars), p.kc), m = linreg(s.map((v, i) => v - ((hh[i] + ll[i]) / 2 + km[i]) / 2), p.kc);
        return { m, m$i: m.map((v, i) => (v >= 0 ? (i && v > m[i - 1] ? 0 : 1) : i && v < m[i - 1] ? 2 : 3)), sq: s.map((v, i) => (isFinite(m[i]) ? 0 : NaN)), sq$i: sqi };
      },
    },
    {
      id: 'wavetrend', name: 'WaveTrend', short: 'WaveTrend', overlay: false, desc: 'A channel-index oscillator with a fast and a slow line; overbought / oversold at ±60',
      inputs: [INT('n1', 'Channel length', 10), INT('n2', 'Average length', 21)],
      plots: [{ key: 'w1', name: 'WT 1', color: '#22AB94' }, { key: 'w2', name: 'WT 2', color: '#F7525F' }, { key: 'd', name: 'Difference', style: 'histogram', palette: ['rgba(61,139,253,0.45)', 'rgba(61,139,253,0.45)'] }],
      levels: [60, 53, 0, -53, -60],
      calc(bars, p) {
        const ap = HLC3(bars), esa = ema(ap, p.n1), d = ema(ap.map((v, i) => Math.abs(v - esa[i])), p.n1), ci = ap.map((v, i) => (d[i] ? (v - esa[i]) / (0.015 * d[i]) : 0)), w1 = ema(ci, p.n2), w2 = sma(w1, 4);
        return { w1, w2, d: sub(w1, w2) };
      },
    },
    {
      id: 'qqe', name: 'QQE', short: 'QQE', overlay: false, desc: 'Smoothed RSI with a trailing line from its own volatility (Quantitative Qualitative Estimation)',
      inputs: [LEN(14), INT('sf', 'RSI smoothing', 5), FLT('q', 'Factor', 4.238, 0.1)],
      plots: [{ key: 'r', name: 'Smoothed RSI', color: '#3D8BFD', width: 2 }, { key: 't', name: 'Trailing line', color: '#F5A623' }], levels: [70, 50, 30], range: [0, 100],
      calc(bars, p) {
        const r = ema(rsiOf(C(bars), p.length), p.sf), W = p.length * 2 - 1, dar = ema(ema(r.map((v, i) => (i ? Math.abs(v - r[i - 1]) : NaN)), W), W).map((v) => v * p.q);
        const n = r.length, t = nanArr(n);
        let tr = NaN;
        for (let i = 1; i < n; i++) {
          if (!isFinite(r[i]) || !isFinite(dar[i])) continue;
          const lo = r[i] - dar[i], hi = r[i] + dar[i];
          if (!isFinite(tr)) tr = lo;
          else if (r[i - 1] > tr && r[i] > tr) tr = Math.max(tr, lo);
          else if (r[i - 1] < tr && r[i] < tr) tr = Math.min(tr, hi);
          else tr = r[i] > tr ? lo : hi;
          t[i] = tr;
        }
        return { r, t };
      },
    },
    {
      id: 'vixfix', name: 'Williams Vix Fix', short: 'Vix Fix', overlay: false, desc: 'A VIX-like fear gauge from how far the low is below the recent highest close; bright columns mark spikes (often near bottoms)',
      inputs: [INT('pd', 'Lookback', 22), INT('bbl', 'Band length', 20), FLT('mult', 'Band multiplier', 2), INT('lb', 'Percentile lookback', 50), FLT('ph', 'Percentile', 0.85, 0.01)],
      plots: [{ key: 'w', name: 'Vix Fix', style: 'histogram', palette: ['#22AB94', '#9AA3B2'] }, { key: 'u', name: 'Upper band', color: '#3D8BFD' }],
      calc(bars, p) {
        const hc = highest(C(bars), p.pd), w = bars.map((b, i) => (hc[i] ? ((hc[i] - b.l) / hc[i]) * 100 : NaN)), m = sma(w, p.bbl), sd = stdev(w, p.bbl), u = m.map((v, i) => v + p.mult * sd[i]), rh = highest(w, p.lb).map((v) => v * p.ph);
        return { w, w$i: w.map((v, i) => (v >= u[i] || v >= rh[i] ? 0 : 1)), u };
      },
    },
    // ---------------- volatility and volume ----------------
    {
      id: 'adr', name: 'Average Daily Range', short: 'ADR', overlay: false, desc: 'Average high-to-low range of the last days (whatever the chart\'s timeframe), in price and percent',
      inputs: [INT('days', 'Days', 14)], plots: [{ key: 'a', name: 'ADR', color: '#3D8BFD' }, { key: 'pct', name: 'ADR %', color: '#F5A623' }],
      calc(bars, p) {
        const D = 86400e3, days = [];
        for (const b of bars) { const k = Math.floor(b.t / D), d = days[days.length - 1]; if (d && d.k === k) { d.h = Math.max(d.h, b.h); d.l = Math.min(d.l, b.l); } else days.push({ k, h: b.h, l: b.l }); }
        const avg = {};
        for (let i = 1; i <= days.length; i++) if (i - 1 >= p.days) { let s = 0; for (let k = i - 1 - p.days; k < i - 1; k++) s += days[k].h - days[k].l; avg[days[i - 1].k] = s / p.days; } // completed days before this one
        const a = bars.map((b) => avg[Math.floor(b.t / D)] ?? NaN);
        return { a, pct: a.map((v, i) => (v / bars[i].c) * 100) };
      },
    },
    {
      id: 'bbtrend', name: 'BBTrend', short: 'BBTrend', overlay: false, desc: 'Compares a short and a long Bollinger Band: positive when they widen upward (uptrend), negative downward',
      inputs: [INT('s', 'Short BB length', 20), INT('l', 'Long BB length', 50), FLT('mult', 'Multiplier', 2)],
      plots: [{ key: 't', name: 'BBTrend', style: 'histogram', palette: PAL4 }], levels: [0],
      calc(bars, p) {
        const s = C(bars), bb = (n) => { const m = sma(s, n), d = stdev(s, n); return [m, m.map((v, i) => v + p.mult * d[i]), m.map((v, i) => v - p.mult * d[i])]; };
        const [m1, u1, l1] = bb(p.s), [, u2, l2] = bb(p.l), t = m1.map((m, i) => ((Math.abs(l1[i] - l2[i]) - Math.abs(u1[i] - u2[i])) / m) * 100);
        return { t, t$i: t.map((v, i) => (v >= 0 ? (i && v > t[i - 1] ? 0 : 1) : i && v < t[i - 1] ? 2 : 3)) };
      },
    },
    {
      id: 'ulcer', name: 'Ulcer Index', short: 'Ulcer', overlay: false, desc: 'Depth and length of drawdowns from the recent high (higher = more painful)',
      inputs: [LEN(14)], plots: [{ key: 'u', name: 'Ulcer index', color: '#F7525F' }],
      calc(bars, p) { const s = C(bars), hc = highest(s, p.length), sq = s.map((v, i) => (hc[i] ? (100 * (v - hc[i]) / hc[i]) ** 2 : NaN)); return { u: sma(sq, p.length).map(Math.sqrt) }; },
    },
    {
      id: 'vr', name: 'Volume Ratio', short: 'VR', overlay: false, desc: 'Volume on up candles vs down candles (100 = balanced)',
      inputs: [LEN(26)], plots: [{ key: 'vr', name: 'VR', color: '#3D8BFD' }], levels: [100],
      calc(bars, p) {
        const k = (f) => rsum(bars.map((b, i) => (i ? (f(b.c, bars[i - 1].c) ? b.v || 0 : 0) : NaN)), p.length);
        const u = k((a, b) => a > b), d = k((a, b) => a < b), e = k((a, b) => a === b);
        return { vr: u.map((v, i) => (d[i] + e[i] / 2 ? (100 * (v + e[i] / 2)) / (d[i] + e[i] / 2) : NaN)) };
      },
    },
    {
      id: 'klinger', name: 'Klinger Oscillator', short: 'Klinger', overlay: false, desc: 'Difference of two averages of volume signed by the direction of the typical price, with a signal line',
      inputs: [INT('fast', 'Fast', 34), INT('slow', 'Slow', 55), INT('sig', 'Signal', 13)],
      plots: [{ key: 'k', name: 'KO', color: '#3D8BFD', format: 'volume' }, { key: 's', name: 'Signal', color: '#22AB94', format: 'volume' }], levels: [0],
      calc(bars, p) { const tp = HLC3(bars), sv = bars.map((b, i) => (i ? (tp[i] - tp[i - 1] >= 0 ? b.v || 0 : -(b.v || 0)) : 0)), k = sub(ema(sv, p.fast), ema(sv, p.slow)); return { k, s: ema(k, p.sig) }; },
    },
    {
      id: 'pvo', name: 'Percentage Volume Oscillator', short: 'PVO', overlay: false, desc: 'Difference of a fast and a slow volume EMA in percent, with a signal line and histogram',
      inputs: [INT('fast', 'Fast', 12), INT('slow', 'Slow', 26), INT('sig', 'Signal', 9)],
      plots: [{ key: 'h', name: 'Histogram', style: 'histogram', palette: UPDN }, { key: 'pvo', name: 'PVO', color: '#3D8BFD' }, { key: 's', name: 'Signal', color: '#F5A623' }], levels: [0],
      calc(bars, p) { const v = V(bars), f = ema(v, p.fast), sl = ema(v, p.slow), pvo = f.map((x, i) => (sl[i] ? ((x - sl[i]) / sl[i]) * 100 : NaN)), s = ema(pvo, p.sig), h = sub(pvo, s); return { pvo, s, h, h$i: h.map((x) => (x >= 0 ? 0 : 1)) }; },
    },
    {
      id: 'nvi', name: 'Negative Volume Index', short: 'NVI', overlay: false, desc: 'Moves with price only on days volume falls (where "smart money" is said to trade), with a long EMA',
      inputs: [INT('ema', 'EMA length', 255)], plots: [{ key: 'n', name: 'NVI', color: '#3D8BFD' }, { key: 'e', name: 'EMA', color: '#F5A623' }],
      calc(bars, p) { let x = 1000; const n = bars.map((b, i) => { if (i && (b.v || 0) < (bars[i - 1].v || 0) && bars[i - 1].c) x *= b.c / bars[i - 1].c; return x; }); return { n, e: ema(n, p.ema) }; },
    },
    {
      id: 'pvi', name: 'Positive Volume Index', short: 'PVI', overlay: false, desc: 'Moves with price only on days volume rises, with a long EMA',
      inputs: [INT('ema', 'EMA length', 255)], plots: [{ key: 'n', name: 'PVI', color: '#3D8BFD' }, { key: 'e', name: 'EMA', color: '#F5A623' }],
      calc(bars, p) { let x = 1000; const n = bars.map((b, i) => { if (i && (b.v || 0) > (bars[i - 1].v || 0) && bars[i - 1].c) x *= b.c / bars[i - 1].c; return x; }); return { n, e: ema(n, p.ema) }; },
    },
    {
      id: 'rvol', name: 'Relative Volume at Time', short: 'RVOL', overlay: false, desc: 'Volume compared with the average volume at the same time of day over the past days (1 = normal)',
      inputs: [INT('days', 'Days', 10)], plots: [{ key: 'r', name: 'Relative volume', style: 'histogram', palette: ['#22AB94', '#9AA3B2'] }], levels: [1],
      calc(bars, p) {
        const iv = intervalOf(bars), D = 86400e3, intraday = iv < D, hist = new Map();
        const r = bars.map((b, i) => {
          const key = intraday ? b.t % D : 0, h = hist.get(key) || [];
          const avg = intraday ? (h.length >= Math.min(3, p.days) ? h.reduce((a, x) => a + x, 0) / h.length : NaN) : (() => { let s = 0, c = 0; for (let k = Math.max(0, i - p.days); k < i; k++) { s += bars[k].v || 0; c++; } return c ? s / c : NaN; })();
          h.push(b.v || 0);
          if (h.length > p.days) h.shift();
          hist.set(key, h);
          return avg ? (b.v || 0) / avg : NaN;
        });
        return { r, r$i: r.map((v) => (v >= 1 ? 0 : 1)) };
      },
    },
  ];
  for (const d of MORE2) DEFS.push(d);

  const BY_ID = Object.fromEntries(DEFS.map((d) => [d.id, d]));

  function defaults(def) {
    const p = {};
    for (const inp of def.inputs) p[inp.key] = inp.def;
    return p;
  }

  window.Indicators = { DEFS, BY_ID, defaults, SOURCES: ['open', 'high', 'low', 'close', 'hl2', 'hlc3', 'ohlc4'], fn: { sma, ema, rma, wma, stdev, rsiOf, atr, highest, lowest, trueRange, source } };
})();
