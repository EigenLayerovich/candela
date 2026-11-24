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

  const BY_ID = Object.fromEntries(DEFS.map((d) => [d.id, d]));

  function defaults(def) {
    const p = {};
    for (const inp of def.inputs) p[inp.key] = inp.def;
    return p;
  }

  window.Indicators = { DEFS, BY_ID, defaults, SOURCES: ['open', 'high', 'low', 'close', 'hl2', 'hlc3', 'ohlc4'], fn: { sma, ema, rma, wma, stdev, rsiOf, atr, highest, lowest, trueRange, source } };
})();
