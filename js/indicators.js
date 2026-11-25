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

  const BY_ID = Object.fromEntries(DEFS.map((d) => [d.id, d]));

  function defaults(def) {
    const p = {};
    for (const inp of def.inputs) p[inp.key] = inp.def;
    return p;
  }

  window.Indicators = { DEFS, BY_ID, defaults, SOURCES: ['open', 'high', 'low', 'close', 'hl2', 'hlc3', 'ohlc4'], fn: { sma, ema, rma, wma, stdev, rsiOf, atr, highest, lowest, trueRange, source } };
})();
