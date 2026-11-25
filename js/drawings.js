/* Candela — drawing tools.
 *
 * Every tool is a small definition: how many points you click (n), and a draw function that uses the
 * helpers below (line, ray, poly, circle, text…). The same draw function is used to paint the drawing and,
 * in "hit" mode, to record its shapes so the chart can tell what is under the mouse, so every tool can be
 * selected, dragged and edited the same way.
 *
 * Drawings are stored as { id, type, pts: [{ t (time), p (price) }…], color, width, dash, locked, text }.
 * n: number of points; 'multi' = click points, double-click (or Enter) to finish; 0 = freehand (press and drag). */
(function () {
  'use strict';
  const TAU = Math.PI * 2, PHI = (1 + Math.sqrt(5)) / 2;

  // ---------------------------------------------------------------- small geometry helpers
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const lerp = (a, b, k) => ({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k });
  const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
  const add = (a, v, k = 1) => ({ x: a.x + v.x * k, y: a.y + v.y * k });
  const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
  const ang = (a, b) => Math.atan2(b.y - a.y, b.x - a.x);
  const polar = (c, r, a) => ({ x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) });
  const pct = (a, b) => (a ? ((b - a) / a) * 100 : 0);
  const sgn = (v, d = 2) => (v >= 0 ? '+' : '') + v.toFixed(d);
  // y of the line a-b at x
  const yAt = (a, b, x) => (b.x === a.x ? a.y : a.y + ((b.y - a.y) * (x - a.x)) / (b.x - a.x));
  function alpha(color, a) {
    if (!color) return color;
    if (color[0] === '#') {
      let h = color.slice(1);
      if (h.length === 3) h = h.split('').map((c) => c + c).join('');
      const n = parseInt(h.slice(0, 6), 16);
      return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
    }
    const m = /^rgba?\(([^)]+)\)/.exec(color);
    if (m) { const p = m[1].split(',').slice(0, 3).join(','); return `rgba(${p},${a})`; }
    return color;
  }
  function distToSeg(px, py, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y, len = dx * dx + dy * dy;
    let t = len ? ((px - a.x) * dx + (py - a.y) * dy) / len : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
  }
  function inPoly(x, y, pts) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const a = pts[i], b = pts[j];
      if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
  }
  // circle through three points (for the Arc tool), or null if they're in a line
  function circleThrough(a, b, c) {
    const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
    if (Math.abs(d) < 1e-6) return null;
    const a2 = a.x * a.x + a.y * a.y, b2 = b.x * b.x + b.y * b.y, c2 = c.x * c.x + c.y * c.y;
    const x = (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d, y = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d;
    return { c: { x, y }, r: Math.hypot(a.x - x, a.y - y) };
  }

  // Fibonacci levels and their colors
  const FIB_COLORS = { 0: '#9AA3B2', 0.236: '#F7525F', 0.382: '#F5A623', 0.5: '#22AB94', 0.618: '#2EC4B6', 0.786: '#3D8BFD', 1: '#9AA3B2', 1.272: '#9C6ADE', 1.414: '#E05CB0', 1.618: '#9C6ADE', 2: '#F5A623', 2.618: '#F7525F', 3: '#3D8BFD', 3.618: '#22AB94', 4.236: '#9C6ADE' };
  const fibColor = (l, fallback) => FIB_COLORS[l] || fallback;
  const RETRACE = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];

  // ---------------------------------------------------------------- the pen: paints, or records shapes for hit testing
  function pen(ctx, api, d, hit) {
    const prims = [];
    const color = d.color || api.theme.drawing, width = d.width || 1.5;
    const stroke = (o) => {
      ctx.strokeStyle = o.color || color;
      ctx.lineWidth = o.width || width;
      const dash = o.dash !== undefined ? o.dash : d.dash;
      ctx.setLineDash(dash === true ? [6, 4] : Array.isArray(dash) ? dash : []);
    };
    const g = {
      color, width, api, prims, hit, ctx,
      line(a, b, o = {}) {
        if (hit) { prims.push({ k: 'seg', a, b }); return; }
        stroke(o);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      },
      ray(a, b, o) { g.line(a, api.edge(a, b), o); },
      xline(a, b, o) { g.line(api.edge(b, a), api.edge(a, b), o); },
      hline(y, o) { g.line({ x: 0, y }, { x: api.plotW, y }, o); },
      vline(x, o) { g.line({ x, y: 0 }, { x, y: api.plotH }, o); },
      // o: close, fill (a color), stroke (false: no outline)
      poly(pts, o = {}) {
        if (pts.length < 2) return;
        if (hit) {
          if (o.fill) prims.push({ k: 'area', pts });
          for (let i = 1; i < pts.length; i++) prims.push({ k: 'seg', a: pts[i - 1], b: pts[i] });
          if (o.close) prims.push({ k: 'seg', a: pts[pts.length - 1], b: pts[0] });
          return;
        }
        ctx.beginPath();
        pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
        if (o.close) ctx.closePath();
        if (o.fill) { ctx.fillStyle = o.fill; ctx.fill(); }
        if (o.stroke !== false) { stroke(o); ctx.stroke(); }
      },
      fill(pts, colorFill) { g.poly(pts, { close: true, fill: colorFill, stroke: false }); },
      rect(a, b, o = {}) { g.poly([a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }], { close: true, ...o }); },
      circle(c, r, o = {}) {
        if (hit) { prims.push({ k: 'circle', c, r, fill: !!o.fill }); return; }
        ctx.beginPath(); ctx.arc(c.x, c.y, Math.max(0, r), 0, TAU);
        if (o.fill) { ctx.fillStyle = o.fill; ctx.fill(); }
        if (o.stroke !== false) { stroke(o); ctx.stroke(); }
      },
      arc(c, r, a0, a1, o = {}) {
        const n = Math.max(8, Math.min(96, Math.ceil(Math.abs(a1 - a0) * r / 6))), pts = [];
        for (let i = 0; i <= n; i++) pts.push(polar(c, r, a0 + ((a1 - a0) * i) / n));
        if (o.wedge) pts.unshift(c), pts.push(c);
        g.poly(pts, o);
      },
      ellipse(c, rx, ry, rot = 0, o = {}) {
        const pts = [];
        for (let i = 0; i < 72; i++) {
          const t = (i / 72) * TAU, x = rx * Math.cos(t), y = ry * Math.sin(t);
          pts.push({ x: c.x + x * Math.cos(rot) - y * Math.sin(rot), y: c.y + x * Math.sin(rot) + y * Math.cos(rot) });
        }
        g.poly(pts, { close: true, ...o });
      },
      bezier(p0, c1, c2, p3, o = {}) {
        const pts = [];
        for (let i = 0; i <= 48; i++) {
          const t = i / 48, u = 1 - t;
          pts.push(c2
            ? { x: u * u * u * p0.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p3.x, y: u * u * u * p0.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p3.y }
            : { x: u * u * p0.x + 2 * u * t * c1.x + t * t * p3.x, y: u * u * p0.y + 2 * u * t * c1.y + t * t * p3.y });
        }
        g.poly(pts, o);
      },
      arrowHead(from, to, o = {}) {
        const a = ang(from, to), L = o.size || 11;
        g.poly([to, polar(to, L, a + Math.PI - 0.42), polar(to, L, a + Math.PI + 0.42)], { close: true, fill: o.color || color, stroke: false });
      },
      // text; o: align (left|center|right), base (middle|top|bottom), color, bg (box color), size, bold
      text(str, x, y, o = {}) {
        str = String(str);
        const size = o.size || 11;
        ctx.font = `${o.bold === false ? '' : '600 '}${size}px ${api.font}`;
        const w = ctx.measureText(str).width, pad = o.bg ? 5 : 1, bw = w + pad * 2, bh = size + (o.bg ? 8 : 2);
        const x0 = o.align === 'center' ? x - bw / 2 : o.align === 'right' ? x - bw : x;
        const y0 = o.base === 'top' ? y : o.base === 'bottom' ? y - bh : y - bh / 2;
        if (hit) { prims.push({ k: 'box', x1: x0, y1: y0, x2: x0 + bw, y2: y0 + bh }); return; }
        if (o.bg) {
          ctx.fillStyle = o.bg;
          ctx.beginPath();
          if (ctx.roundRect) ctx.roundRect(x0, y0, bw, bh, 4); else ctx.rect(x0, y0, bw, bh);
          ctx.fill();
        }
        ctx.fillStyle = o.color || (o.bg ? '#fff' : color);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(str, x0 + pad, y0 + bh / 2 + 0.5);
      },
      // several lines of text in one box
      label(lines, x, y, o = {}) {
        lines = [].concat(lines);
        const size = o.size || 11, lh = size + 4;
        ctx.font = `600 ${size}px ${api.font}`;
        const w = Math.max(...lines.map((s) => ctx.measureText(s).width)) + 12, hgt = lines.length * lh + 8;
        const x0 = o.align === 'left' ? x : o.align === 'right' ? x - w : x - w / 2;
        const y0 = o.base === 'top' ? y : o.base === 'middle' ? y - hgt / 2 : y - hgt;
        if (hit) { prims.push({ k: 'box', x1: x0, y1: y0, x2: x0 + w, y2: y0 + hgt }); return; }
        ctx.fillStyle = o.bg || color;
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(x0, y0, w, hgt, 4); else ctx.rect(x0, y0, w, hgt);
        ctx.fill();
        ctx.fillStyle = o.color || '#fff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        lines.forEach((s, i) => ctx.fillText(s, x0 + w / 2, y0 + 4 + lh * i + lh / 2 + 0.5));
        ctx.textAlign = 'left';
      },
      // a point label like "B" or "(3)" above a high or below a low
      pointLabel(str, pts, i, o = {}) {
        const p = pts[i], ys = [pts[i - 1], pts[i + 1]].filter(Boolean).map((q) => q.y);
        const high = !ys.length || p.y <= ys.reduce((a, b) => a + b, 0) / ys.length; // above the neighbours: label above
        g.text(str, p.x, high ? p.y - 8 : p.y + 8, { align: 'center', base: high ? 'bottom' : 'top', bg: o.bg || color, size: o.size || 11 });
      },
    };
    return g;
  }

  function hitTest(prims, x, y, tol = 6) {
    for (const p of prims) {
      if (p.k === 'seg' && distToSeg(x, y, p.a, p.b) < tol) return true;
      if (p.k === 'area' && inPoly(x, y, p.pts)) return true;
      if (p.k === 'circle') { const r = Math.hypot(x - p.c.x, y - p.c.y); if (p.fill ? r <= p.r + tol : Math.abs(r - p.r) < tol) return true; }
      if (p.k === 'box' && x >= p.x1 - 2 && x <= p.x2 + 2 && y >= p.y1 - 2 && y <= p.y2 + 2) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- the tools
  const TOOLS = {};
  const tool = (id, o) => { TOOLS[id] = { id, n: 2, ...o }; };
  const soft = (g, a = 0.12) => alpha(g.color, a);

  // ---- lines
  tool('trend', { name: 'Trend line', key: 'Alt+T', draw: (g, P) => g.line(P[0], P[1]) });
  tool('ray', { name: 'Ray', draw: (g, P) => g.ray(P[0], P[1]) });
  tool('infoline', {
    name: 'Info line',
    draw(g, P, d) {
      g.line(P[0], P[1]);
      const [a, b] = d.pts, api = g.api, bars = Math.round(api.idx(b.t) - api.idx(a.t));
      const deg = (-ang(P[0], P[1]) * 180) / Math.PI;
      g.label([`${sgn(b.p - a.p, api.dec)} (${sgn(pct(a.p, b.p))}%)`, `${bars} bars · ${deg.toFixed(1)}°`], P[1].x, P[1].y + (P[1].y >= P[0].y ? 10 : -10), { base: P[1].y >= P[0].y ? 'top' : 'bottom', bg: alpha(g.color, 0.9) });
    },
  });
  tool('extended', { name: 'Extended line', draw: (g, P) => g.xline(P[0], P[1]) });
  tool('trendangle', {
    name: 'Trend angle',
    draw(g, P) {
      g.line(P[0], P[1]);
      const r = Math.min(40, dist(P[0], P[1]));
      g.line(P[0], { x: P[0].x + Math.max(r + 20, 60), y: P[0].y }, { dash: [4, 4], width: 1 });
      const a = ang(P[0], P[1]);
      g.arc(P[0], r * 0.7, Math.min(0, a), Math.max(0, a), { width: 1 });
      g.text(`${((-a * 180) / Math.PI).toFixed(1)}°`, P[0].x + r + 24, P[0].y + (a < 0 ? -9 : 9), { size: 11 });
    },
  });
  tool('hline', { name: 'Horizontal line', key: 'Alt+H', n: 1, axis: true, draw: (g, P) => g.hline(P[0].y), handles: (P, api) => [{ x: Math.min(Math.max(P[0].x, 10), api.plotW - 10), y: P[0].y }] });
  tool('hray', { name: 'Horizontal ray', key: 'Alt+J', n: 1, axis: true, draw: (g, P) => g.line(P[0], { x: g.api.plotW, y: P[0].y }) });
  tool('vline', { name: 'Vertical line', key: 'Alt+V', n: 1, draw: (g, P) => g.vline(P[0].x), handles: (P, api) => [{ x: P[0].x, y: Math.min(Math.max(P[0].y, 10), api.plotH - 10) }] });
  tool('crossline', { name: 'Crossline', key: 'Alt+C', n: 1, axis: true, draw: (g, P) => { g.hline(P[0].y); g.vline(P[0].x); } });

  // ---- channels
  // offset of point c from the line a-b, measured vertically
  const vOffset = (a, b, c) => ({ x: 0, y: c.y - yAt(a, b, c.x) });
  tool('parallel', {
    name: 'Parallel channel', n: 3,
    draw(g, P) {
      const off = vOffset(P[0], P[1], P[2]), a2 = add(P[0], off), b2 = add(P[1], off);
      g.fill([P[0], P[1], b2, a2], soft(g, 0.1));
      g.line(P[0], P[1]); g.line(a2, b2);
      g.line(mid(P[0], a2), mid(P[1], b2), { dash: [4, 4], width: 1 });
    },
    handles: (P) => (P.length > 2 ? [P[0], P[1], add(mid(P[0], P[1]), vOffset(P[0], P[1], P[2]))] : P),
  });
  tool('regression', {
    name: 'Regression trend',
    draw(g, P, d) {
      const api = g.api, B = api.bars;
      let i0 = Math.round(api.idx(d.pts[0].t)), i1 = Math.round(api.idx(d.pts[1].t));
      if (i0 > i1) [i0, i1] = [i1, i0];
      i0 = Math.max(0, i0); i1 = Math.min(B.length - 1, i1);
      if (i1 - i0 < 2) { g.line(P[0], P[1], { dash: [4, 4] }); return; }
      let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
      for (let i = i0; i <= i1; i++) { const y = B[i].c; n++; sx += i; sy += y; sxx += i * i; sxy += i * y; }
      const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx || 1), icpt = (sy - slope * sx) / n;
      let ss = 0;
      for (let i = i0; i <= i1; i++) { const r = B[i].c - (icpt + slope * i); ss += r * r; }
      const sd = Math.sqrt(ss / n), pt = (i, k) => ({ x: api.xi(i), y: api.y(icpt + slope * i + k * sd) });
      g.fill([pt(i0, 2), pt(i1, 2), pt(i1, -2), pt(i0, -2)], soft(g, 0.08));
      g.line(pt(i0, 0), pt(i1, 0));
      g.line(pt(i0, 2), pt(i1, 2), { dash: [5, 4], width: 1 });
      g.line(pt(i0, -2), pt(i1, -2), { dash: [5, 4], width: 1 });
    },
  });
  tool('flattop', {
    name: 'Flat top/bottom', n: 3,
    draw(g, P) {
      const f1 = { x: P[0].x, y: P[2].y }, f2 = { x: P[1].x, y: P[2].y };
      g.fill([P[0], P[1], f2, f1], soft(g, 0.1));
      g.line(P[0], P[1]); g.line(f1, f2);
    },
    handles: (P) => (P.length > 2 ? [P[0], P[1], { x: P[1].x, y: P[2].y }] : P),
  });
  tool('disjoint', {
    name: 'Disjoint channel', n: 3,
    draw(g, P) {
      // a second line from the third point with the opposite slope
      const b1 = { x: P[0].x, y: P[2].y }, b2 = { x: P[1].x, y: P[2].y - (P[1].y - P[0].y) };
      g.fill([P[0], P[1], b2, b1], soft(g, 0.1));
      g.line(P[0], P[1]); g.line(b1, b2);
    },
    handles: (P) => (P.length > 2 ? [P[0], P[1], { x: P[0].x, y: P[2].y }] : P),
  });

  // ---- pitchforks: a median line from the pivot through the middle of the other two points, and
  // parallel lines through those two points. The variants move where the median starts.
  function pitchfork(origin, extra) {
    return {
      n: 3,
      draw(g, P) {
        const O = origin(P), m = mid(P[1], P[2]), dir = sub(m, O);
        if (!dir.x && !dir.y) return;
        const far = (p) => g.api.edge(p, add(p, dir));
        g.fill([P[1], far(P[1]), far(P[2]), P[2]], soft(g, 0.08));
        g.line(P[0], O, { dash: [4, 4], width: 1 });
        g.ray(O, m);
        g.ray(P[1], add(P[1], dir)); g.ray(P[2], add(P[2], dir));
        g.line(P[1], P[2]);
        if (extra) for (const k of [0.25, 0.75]) { const s = lerp(P[1], P[2], k); g.ray(s, add(s, dir), { dash: [4, 4], width: 1 }); }
      },
    };
  }
  tool('pitchfork', { name: 'Pitchfork', ...pitchfork((P) => P[0]) });
  tool('schiff', { name: 'Schiff pitchfork', ...pitchfork((P) => ({ x: P[0].x, y: (P[0].y + P[1].y) / 2 })) });
  tool('modschiff', { name: 'Modified Schiff pitchfork', ...pitchfork((P) => mid(P[0], P[1])) });
  tool('insidepitchfork', { name: 'Inside pitchfork', ...pitchfork((P) => mid(P[0], mid(P[1], P[2])), true) });

  // ---- Fibonacci
  function levels(g, prices, x1, x2, fmt) {
    let prev = null;
    for (const [l, price] of prices) {
      const y = g.api.y(price), c = fibColor(l, g.color);
      if (prev !== null) g.fill([{ x: x1, y: prev }, { x: x2, y: prev }, { x: x2, y }, { x: x1, y }], alpha(c, 0.07));
      g.line({ x: x1, y }, { x: x2, y }, { color: c, width: 1, dash: false });
      g.text(`${l} (${fmt(price)})`, x1 - 6, y, { align: 'right', color: c, bold: false });
      prev = y;
    }
  }
  tool('fib', {
    name: 'Fib retracement', key: 'Alt+F',
    draw(g, P, d) {
      const [a, b] = d.pts;
      levels(g, [...RETRACE, 1.618].map((l) => [l, b.p + (a.p - b.p) * l]), Math.min(P[0].x, P[1].x), Math.max(P[0].x, P[1].x), g.api.fmt);
      g.line(P[0], P[1], { dash: [4, 4], width: 1, color: alpha(g.color, 0.6) });
    },
  });
  tool('fibext', {
    name: 'Trend-based fib extension', n: 3,
    draw(g, P, d) {
      const [a, b, c] = d.pts, x1 = P[2].x, x2 = Math.max(P[1].x, P[2].x) + Math.max(40, Math.abs(P[1].x - P[0].x));
      levels(g, [0, 0.382, 0.618, 1, 1.272, 1.618, 2, 2.618].map((l) => [l, c.p + (b.p - a.p) * l]), Math.min(x1, x2), Math.max(x1, x2), g.api.fmt);
      g.poly([P[0], P[1], P[2]], { dash: [4, 4], width: 1 });
    },
  });
  tool('fibchannel', {
    name: 'Fib channel', n: 3,
    draw(g, P) {
      const off = vOffset(P[0], P[1], P[2]);
      for (const l of [0, 0.382, 0.618, 1, 1.618, 2.618]) {
        const c = fibColor(l, g.color), a = add(P[0], off, l), b = add(P[1], off, l);
        g.ray(a, b, { color: c, width: 1, dash: false });
        g.text(String(l), a.x - 4, a.y, { align: 'right', color: c, bold: false });
      }
    },
    handles: (P) => (P.length > 2 ? [P[0], P[1], add(P[0], vOffset(P[0], P[1], P[2]))] : P),
  });
  function timeLines(g, i0, du, ks, labels) {
    const api = g.api;
    if (!du) return;
    ks.forEach((k, j) => {
      const x = api.xi(i0 + du * k);
      if (x < -50 || x > api.plotW + 50) return;
      const c = fibColor(labels ? labels[j] : k, g.color);
      g.vline(x, { color: c, width: 1, dash: false });
      g.text(String(labels ? labels[j] : k), x + 3, 10, { color: c, bold: false });
    });
  }
  tool('fibtime', {
    name: 'Fib time zone',
    draw(g, P, d) {
      const api = g.api, i0 = api.idx(d.pts[0].t), du = api.idx(d.pts[1].t) - i0;
      timeLines(g, i0, du, [0, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144]);
      g.line(P[0], P[1], { dash: [4, 4], width: 1 });
    },
  });
  tool('fibfan', {
    name: 'Fib speed resistance fan',
    draw(g, P) {
      const [a, b] = P, ls = [0, 0.25, 0.382, 0.5, 0.618, 0.75, 1];
      g.rect(a, b, { width: 1, dash: [3, 4], color: alpha(g.color, 0.5) });
      for (const l of ls) {
        const c = fibColor(l, g.color);
        g.ray(a, { x: b.x, y: a.y + (b.y - a.y) * l }, { color: c, width: 1, dash: false });
        if (l > 0 && l < 1) g.ray(a, { x: a.x + (b.x - a.x) * l, y: b.y }, { color: c, width: 1, dash: false });
        g.text(String(l), b.x + 4, a.y + (b.y - a.y) * l, { color: c, bold: false });
      }
    },
  });
  tool('fibtimetrend', {
    name: 'Trend-based fib time', n: 3,
    draw(g, P, d) {
      const api = g.api, du = api.idx(d.pts[1].t) - api.idx(d.pts[0].t);
      timeLines(g, api.idx(d.pts[2].t), du, [0, 0.382, 0.5, 0.618, 1, 1.382, 1.618, 2, 2.382, 2.618, 3]);
      g.poly([P[0], P[1], P[2]], { dash: [4, 4], width: 1 });
    },
  });
  tool('fibcircles', {
    name: 'Fib circles',
    draw(g, P) {
      const R = dist(P[0], P[1]);
      for (const l of [0.382, 0.5, 0.618, 1, 1.618, 2.618]) g.circle(P[0], R * l, { color: fibColor(l, g.color), width: 1, dash: false });
      g.line(P[0], P[1], { dash: [4, 4], width: 1 });
    },
  });
  tool('fibspiral', {
    name: 'Fib spiral',
    draw(g, P) {
      const R = dist(P[0], P[1]), a0 = ang(P[0], P[1]), pts = [];
      if (R < 1) return;
      // golden spiral: the radius grows by φ every quarter turn
      for (let th = -6 * Math.PI; th <= 3 * Math.PI; th += 0.05) {
        const r = R * Math.pow(PHI, (2 * th) / Math.PI);
        if (r > 6000) break;
        pts.push(polar(P[0], r, a0 + th));
      }
      g.poly(pts);
      g.line(P[0], P[1], { dash: [4, 4], width: 1 });
    },
  });
  tool('fibarcs', {
    name: 'Fib speed resistance arcs',
    draw(g, P) {
      const R = dist(P[0], P[1]), a = ang(P[1], P[0]);
      for (const l of [0.236, 0.382, 0.5, 0.618, 0.786, 1]) g.arc(P[1], R * l, a - Math.PI / 2, a + Math.PI / 2, { color: fibColor(l, g.color), width: 1, dash: false });
      g.line(P[0], P[1], { dash: [4, 4], width: 1 });
    },
  });
  tool('fibwedge', {
    name: 'Fib wedge', n: 3,
    draw(g, P) {
      const R = dist(P[0], P[1]);
      let a1 = ang(P[0], P[1]), a2 = ang(P[0], P[2]);
      if (a2 - a1 > Math.PI) a2 -= TAU; else if (a1 - a2 > Math.PI) a2 += TAU;
      g.arc(P[0], R, a1, a2, { wedge: true, fill: soft(g, 0.06), stroke: false });
      for (const l of [0.236, 0.382, 0.5, 0.618, 0.786, 1]) g.arc(P[0], R * l, a1, a2, { color: fibColor(l, g.color), width: 1, dash: false });
      g.line(P[0], P[1]); g.line(P[0], polar(P[0], R, a2));
    },
  });
  tool('pitchfan', {
    name: 'Pitchfan', n: 3,
    draw(g, P) {
      for (const l of [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1]) {
        const c = fibColor(l, g.color), t = lerp(P[1], P[2], l);
        g.ray(P[0], t, { color: c, width: l === 0.5 ? 1.5 : 1, dash: false });
      }
      g.line(P[1], P[2], { dash: [4, 4], width: 1 });
    },
  });

  // ---- Gann
  function gannGrid(g, a, b, ls) {
    g.rect(a, b, { fill: soft(g, 0.05) });
    for (const l of ls) {
      const x = a.x + (b.x - a.x) * l, y = a.y + (b.y - a.y) * l, c = fibColor(l, alpha(g.color, 0.7));
      if (l > 0 && l < 1) {
        g.line({ x, y: a.y }, { x, y: b.y }, { color: c, width: 1, dash: [3, 4] });
        g.line({ x: a.x, y }, { x: b.x, y }, { color: c, width: 1, dash: [3, 4] });
      }
      g.text(String(l), x, Math.min(a.y, b.y) - 4, { align: 'center', base: 'bottom', color: c, bold: false, size: 10 });
      g.text(String(l), Math.min(a.x, b.x) - 4, y, { align: 'right', color: c, bold: false, size: 10 });
    }
  }
  tool('gannbox', {
    name: 'Gann box',
    draw(g, P) { gannGrid(g, P[0], P[1], [0, 0.25, 0.382, 0.5, 0.618, 0.75, 1]); g.line(P[0], P[1], { width: 1 }); g.line({ x: P[0].x, y: P[1].y }, { x: P[1].x, y: P[0].y }, { width: 1 }); },
  });
  function gannSquare(g, a, b) {
    gannGrid(g, a, b, [0, 0.25, 0.5, 0.75, 1]);
    for (const l of [0.25, 0.5, 0.75, 1]) {
      g.line(a, { x: b.x, y: a.y + (b.y - a.y) * l }, { width: 1 });
      g.line(a, { x: a.x + (b.x - a.x) * l, y: b.y }, { width: 1 });
    }
    g.line({ x: a.x, y: b.y }, { x: b.x, y: a.y }, { width: 1 });
  }
  tool('gannsqfixed', {
    name: 'Gann square fixed',
    // always a square on screen
    draw(g, P) { const s = Math.max(Math.abs(P[1].x - P[0].x), Math.abs(P[1].y - P[0].y)); gannSquare(g, P[0], { x: P[0].x + Math.sign(P[1].x - P[0].x || 1) * s, y: P[0].y + Math.sign(P[1].y - P[0].y || 1) * s }); },
  });
  tool('gannsquare', { name: 'Gann square', draw: (g, P) => gannSquare(g, P[0], P[1]) });
  tool('gannfan', {
    name: 'Gann fan',
    draw(g, P) {
      const v = sub(P[1], P[0]);
      for (const r of [8, 4, 3, 2, 1, 1 / 2, 1 / 3, 1 / 4, 1 / 8]) {
        const t = { x: P[0].x + v.x, y: P[0].y + v.y * r }, name = r >= 1 ? `${r}x1` : `1x${Math.round(1 / r)}`;
        const c = r === 1 ? g.color : alpha(g.color, 0.75);
        g.ray(P[0], t, { color: c, width: r === 1 ? 1.5 : 1, dash: false });
        g.text(name, t.x + 4, t.y, { color: c, bold: false, size: 10 });
      }
    },
  });

  // ---- chart patterns
  const ratio = (a, b) => (Math.abs(a) > 1e-12 ? Math.abs(b / a).toFixed(3) : '–');
  function harmonic(names) {
    return {
      n: names.length,
      draw(g, P, d) {
        const p = d.pts;
        if (P.length >= 3) g.fill([P[0], P[1], P[2]], soft(g, 0.12));
        if (P.length >= 5) g.fill([P[2], P[3], P[4]], soft(g, 0.12));
        g.poly(P);
        if (P.length >= 3) { g.line(P[0], P[2], { dash: [4, 4], width: 1 }); g.text(ratio(p[1].p - p[0].p, p[2].p - p[1].p), mid(P[0], P[2]).x, mid(P[0], P[2]).y, { align: 'center', bg: alpha(g.color, 0.85), size: 10 }); }
        if (P.length >= 4) { g.line(P[1], P[3], { dash: [4, 4], width: 1 }); g.text(ratio(p[2].p - p[1].p, p[3].p - p[2].p), mid(P[1], P[3]).x, mid(P[1], P[3]).y, { align: 'center', bg: alpha(g.color, 0.85), size: 10 }); }
        if (P.length >= 5) {
          g.line(P[2], P[4], { dash: [4, 4], width: 1 }); g.text(ratio(p[3].p - p[2].p, p[4].p - p[3].p), mid(P[2], P[4]).x, mid(P[2], P[4]).y, { align: 'center', bg: alpha(g.color, 0.85), size: 10 });
          g.line(P[0], P[4], { dash: [4, 4], width: 1 }); g.text(ratio(p[1].p - p[0].p, p[4].p - p[1].p), mid(P[0], P[4]).x, mid(P[0], P[4]).y, { align: 'center', bg: alpha(g.color, 0.85), size: 10 });
        }
        P.forEach((_, i) => g.pointLabel(names[i], P, i));
      },
    };
  }
  tool('xabcd', { name: 'XABCD pattern', ...harmonic(['X', 'A', 'B', 'C', 'D']) });
  tool('cypher', { name: 'Cypher pattern', ...harmonic(['X', 'A', 'B', 'C', 'D']) });
  tool('abcd', {
    name: 'ABCD pattern', n: 4,
    draw(g, P, d) {
      const p = d.pts;
      g.poly(P);
      g.line(P[0], P[2], { dash: [4, 4], width: 1 }); g.text(ratio(p[1].p - p[0].p, p[2].p - p[1].p), mid(P[0], P[2]).x, mid(P[0], P[2]).y, { align: 'center', bg: alpha(g.color, 0.85), size: 10 });
      g.line(P[1], P[3], { dash: [4, 4], width: 1 }); g.text(ratio(p[2].p - p[1].p, p[3].p - p[2].p), mid(P[1], P[3]).x, mid(P[1], P[3]).y, { align: 'center', bg: alpha(g.color, 0.85), size: 10 });
      ['A', 'B', 'C', 'D'].forEach((s, i) => g.pointLabel(s, P, i));
    },
  });
  tool('headshoulders', {
    name: 'Head and shoulders', n: 7,
    draw(g, P) {
      g.fill([P[0], P[1], P[2]], soft(g, 0.1)); g.fill([P[2], P[3], P[4]], soft(g, 0.1)); g.fill([P[4], P[5], P[6]], soft(g, 0.1));
      g.poly(P);
      // the neckline through the two troughs
      g.line({ x: P[0].x, y: yAt(P[2], P[4], P[0].x) }, { x: P[6].x, y: yAt(P[2], P[4], P[6].x) }, { dash: [5, 4] });
      g.pointLabel('Left shoulder', P, 1); g.pointLabel('Head', P, 3); g.pointLabel('Right shoulder', P, 5);
    },
  });
  tool('trianglepattern', {
    name: 'Triangle pattern', n: 4,
    draw(g, P) {
      g.poly(P);
      // the two sides (A–C and B–D), extended to where they meet
      const s1 = (P[2].y - P[0].y) / (P[2].x - P[0].x || 1), s2 = (P[3].y - P[1].y) / (P[3].x - P[1].x || 1);
      let xe = Math.max(P[2].x, P[3].x) + 40;
      if (Math.abs(s1 - s2) > 1e-9) { const xi = (P[1].y - P[0].y + s1 * P[0].x - s2 * P[1].x) / (s1 - s2); if (xi > Math.max(P[2].x, P[3].x)) xe = Math.min(xi, xe + 2000); }
      const e1 = { x: xe, y: yAt(P[0], P[2], xe) }, e2 = { x: xe, y: yAt(P[1], P[3], xe) };
      g.fill([P[0], e1, e2, P[1]], soft(g, 0.1));
      g.line(P[0], e1, { width: 1 }); g.line(P[1], e2, { width: 1 });
      ['A', 'B', 'C', 'D'].forEach((s, i) => g.pointLabel(s, P, i));
    },
  });
  tool('threedrives', {
    name: 'Three drives pattern', n: 7,
    draw(g, P, d) {
      g.poly(P);
      const p = d.pts;
      g.pointLabel('1', P, 1); g.pointLabel('2', P, 3); g.pointLabel('3', P, 5);
      g.line(P[1], P[3], { dash: [4, 4], width: 1 }); g.line(P[3], P[5], { dash: [4, 4], width: 1 });
      g.text(ratio(p[1].p - p[2].p, p[3].p - p[2].p), mid(P[2], P[3]).x + 6, mid(P[2], P[3]).y, { bg: alpha(g.color, 0.85), size: 10 });
      g.text(ratio(p[3].p - p[4].p, p[5].p - p[4].p), mid(P[4], P[5]).x + 6, mid(P[4], P[5]).y, { bg: alpha(g.color, 0.85), size: 10 });
    },
  });

  // ---- Elliott waves: a line through the points, labelled
  const wave = (name, labels) => ({ name, n: labels.length, draw(g, P) { g.poly(P); labels.forEach((s, i) => s && g.pointLabel(s, P, i, { size: 11 })); } });
  tool('elliott5', wave('Elliott impulse wave (1·2·3·4·5)', ['', '(1)', '(2)', '(3)', '(4)', '(5)']));
  tool('elliott3', wave('Elliott correction wave (A·B·C)', ['', '(A)', '(B)', '(C)']));
  tool('elliott5t', wave('Elliott triangle wave (A·B·C·D·E)', ['', '(A)', '(B)', '(C)', '(D)', '(E)']));
  tool('elliottwxy', wave('Elliott double combo wave (W·X·Y)', ['', '(W)', '(X)', '(Y)']));
  tool('elliottwxyxz', wave('Elliott triple combo wave (W·X·Y·X·Z)', ['', '(W)', '(X)', '(Y)', '(X)', '(Z)']));

  // ---- cycles: repeat the distance between the two points across the chart
  function cycleRange(api, i0, du) {
    const left = api.idxAtX(0), right = api.idxAtX(api.plotW);
    let k0 = Math.floor((left - i0) / du) - 1, k1 = Math.ceil((right - i0) / du) + 1;
    if (k1 - k0 > 300) k0 = k1 - 300;
    return [k0, k1];
  }
  tool('cyclic', {
    name: 'Cyclic lines',
    draw(g, P, d) {
      const api = g.api, i0 = api.idx(d.pts[0].t), du = Math.abs(api.idx(d.pts[1].t) - i0);
      if (du < 0.5) { g.vline(P[0].x); return; }
      const [k0, k1] = cycleRange(api, i0, du);
      for (let k = k0; k <= k1; k++) g.vline(api.xi(i0 + k * du), { width: k === 0 || k === 1 ? g.width : 1 });
    },
  });
  tool('timecycles', {
    name: 'Time cycles',
    draw(g, P, d) {
      const api = g.api, i0 = api.idx(d.pts[0].t), du = Math.abs(api.idx(d.pts[1].t) - i0);
      if (du < 0.5) return;
      const [k0, k1] = cycleRange(api, i0, du), y = P[0].y;
      for (let k = k0; k < k1; k++) {
        const xa = api.xi(i0 + k * du), xb = api.xi(i0 + (k + 1) * du), r = (xb - xa) / 2;
        g.arc({ x: xa + r, y }, r, Math.PI, TAU, { fill: k === 0 ? soft(g, 0.08) : null });
      }
    },
  });
  tool('sine', {
    name: 'Sine line',
    draw(g, P) {
      // half a period from the first point to the second, with the second point at the peak
      const half = P[1].x - P[0].x, amp = P[1].y - P[0].y, pts = [];
      if (Math.abs(half) < 2) { g.line(P[0], P[1]); return; }
      for (let x = -20; x <= g.api.plotW + 20; x += 3) pts.push({ x, y: P[0].y + amp * Math.sin((Math.PI / 2) * ((x - P[0].x) / half)) });
      g.poly(pts);
    },
  });

  // ---- forecasting
  function position(long) {
    return {
      n: 1,
      // one click sets the entry; target, stop and end start at sensible distances and can be dragged
      init(d, api) {
        const e = d.pts[0], y = api.y(e.p), i = api.idx(e.t);
        const up = api.price(y - 70), down = api.price(y + 45);
        d.pts = [e, { t: api.ti(i + 25), p: long ? up : down }, { t: e.t, p: long ? down : up }];
      },
      normalize(d) { if (d.pts[2]) d.pts[2].t = d.pts[0].t; },
      draw(g, P, d) {
        if (P.length < 3) return;
        const api = g.api, [e, tg, st] = d.pts, T = api.theme;
        const x0 = Math.min(P[0].x, P[1].x), x1 = Math.max(P[0].x, P[1].x);
        g.rect({ x: x0, y: P[0].y }, { x: x1, y: P[1].y }, { fill: alpha(T.up, 0.18), stroke: false });
        g.rect({ x: x0, y: P[0].y }, { x: x1, y: P[2].y }, { fill: alpha(T.down, 0.18), stroke: false });
        g.line({ x: x0, y: P[0].y }, { x: x1, y: P[0].y }, { color: '#9AA3B2', width: 1, dash: false });
        const tp = pct(e.p, tg.p), sp = pct(e.p, st.p), rr = Math.abs(tg.p - e.p) / (Math.abs(e.p - st.p) || 1e-12);
        const cx = (x0 + x1) / 2, upT = P[1].y < P[0].y;
        g.text(`Target ${api.fmt(tg.p)} (${sgn(tp)}%)`, cx, P[1].y + (upT ? -4 : 4), { align: 'center', base: upT ? 'bottom' : 'top', bg: T.up, size: 10 });
        g.text(`Stop ${api.fmt(st.p)} (${sgn(sp)}%)`, cx, P[2].y + (upT ? 4 : -4), { align: 'center', base: upT ? 'top' : 'bottom', bg: T.down, size: 10 });
        // what happened since: the first of target or stop reached
        const B = api.bars, i0 = Math.max(0, Math.ceil(api.idx(e.t) + 0.01)), i1 = Math.min(B.length - 1, Math.floor(api.idx(tg.t)));
        let result = 'open';
        for (let i = i0; i <= i1; i++) {
          const hiT = long ? B[i].h >= tg.p : B[i].l <= tg.p, hiS = long ? B[i].l <= st.p : B[i].h >= st.p;
          if (hiS) { result = 'stop'; break; }
          if (hiT) { result = 'target'; break; }
        }
        const status = result === 'target' ? ' · target hit' : result === 'stop' ? ' · stop hit' : '';
        g.text(`${long ? 'Long' : 'Short'} ${api.fmt(e.p)} · R:R ${rr.toFixed(2)}${status}`, cx, P[0].y, { align: 'center', bg: result === 'stop' ? T.down : result === 'target' ? T.up : '#5D6675', size: 10 });
      },
      handles: (P) => P,
    };
  }
  tool('long', { name: 'Long position', ...position(true) });
  tool('short', { name: 'Short position', ...position(false) });
  tool('forecast', {
    name: 'Position forecast',
    draw(g, P, d) {
      const [a, b] = d.pts, api = g.api, up = b.p >= a.p, c = up ? api.theme.up : api.theme.down;
      g.line(P[0], P[1], { color: c, dash: [5, 4] });
      g.arrowHead(P[0], P[1], { color: c });
      g.circle(P[0], 3, { fill: c, stroke: false });
      const bars = Math.round(api.idx(b.t) - api.idx(a.t));
      g.label([`${api.fmt(b.p)} (${sgn(pct(a.p, b.p))}%)`, `in ${bars} bars`], P[1].x, P[1].y + (up ? -8 : 8), { base: up ? 'bottom' : 'top', bg: c });
    },
  });
  // candles of a time range, copied to where the third point is (shapes of moves repeat)
  function ghostCandles(g, list, color) {
    const api = g.api, w = Math.max(1, api.spacing * 0.6);
    for (const b of list) {
      const x = api.xi(b.i), up = b.c >= b.o, c = color || (up ? api.theme.up : api.theme.down);
      g.line({ x, y: api.y(b.h) }, { x, y: api.y(b.l) }, { color: alpha(c, 0.6), width: 1, dash: false });
      const y1 = api.y(Math.max(b.o, b.c)), y2 = api.y(Math.min(b.o, b.c));
      g.rect({ x: x - w / 2, y: y1 }, { x: x + w / 2, y: Math.max(y2, y1 + 1) }, { fill: alpha(c, 0.45), color: alpha(c, 0.8), width: 1, dash: false });
    }
  }
  tool('barspattern', {
    name: 'Bars pattern', n: 3,
    draw(g, P, d) {
      const api = g.api, B = api.bars;
      let i0 = Math.round(api.idx(d.pts[0].t)), i1 = Math.round(api.idx(d.pts[1].t));
      if (i0 > i1) [i0, i1] = [i1, i0];
      i0 = Math.max(0, i0); i1 = Math.min(B.length - 1, i1);
      g.line(P[0], P[1], { dash: [4, 4], width: 1 });
      if (i1 < i0 || P.length < 3) return;
      const start = Math.round(api.idx(d.pts[2].t)), shift = d.pts[2].p - B[i0].o, list = [];
      for (let i = i0; i <= i1 && list.length < 2000; i++) list.push({ i: start + (i - i0), o: B[i].o + shift, h: B[i].h + shift, l: B[i].l + shift, c: B[i].c + shift });
      ghostCandles(g, list);
    },
  });
  tool('ghostfeed', {
    name: 'Ghost feed', n: 'multi',
    draw(g, P, d) {
      const api = g.api, pts = d.pts.map((q) => ({ i: api.idx(q.t), p: q.p })).sort((a, b) => a.i - b.i), list = [];
      g.poly(P, { dash: [3, 4], width: 1, color: alpha(g.color, 0.5) });
      let prev = pts.length ? pts[0].p : 0;
      for (let k = 1; k < pts.length; k++) {
        const a = pts[k - 1], b = pts[k], i0 = Math.round(a.i), i1 = Math.round(b.i);
        for (let i = i0 + 1; i <= i1 && list.length < 2000; i++) {
          const c = a.p + ((b.p - a.p) * (i - a.i)) / (b.i - a.i || 1), o = prev, wick = Math.abs(c - o) * 0.35 + Math.abs(c) * 0.0008;
          list.push({ i, o, c, h: Math.max(o, c) + wick, l: Math.min(o, c) - wick });
          prev = c;
        }
      }
      ghostCandles(g, list);
    },
  });
  tool('sector', {
    name: 'Sector', n: 3,
    draw(g, P, d) {
      const R = dist(P[0], P[1]);
      let a1 = ang(P[0], P[1]), a2 = ang(P[0], P[2]);
      if (a2 - a1 > Math.PI) a2 -= TAU; else if (a1 - a2 > Math.PI) a2 += TAU;
      g.arc(P[0], R, a1, a2, { wedge: true, fill: soft(g, 0.15) });
      if (d.pts[2]) g.text(`${sgn(pct(d.pts[1].p, d.pts[2].p))}%`, polar(P[0], R * 0.6, (a1 + a2) / 2).x, polar(P[0], R * 0.6, (a1 + a2) / 2).y, { align: 'center', size: 10 });
    },
    handles: (P) => (P.length > 2 ? [P[0], P[1], polar(P[0], dist(P[0], P[1]), ang(P[0], P[2]))] : P),
  });

  // ---- volume-based
  tool('avwap', {
    name: 'Anchored VWAP', n: 1,
    draw(g, P, d) {
      const api = g.api, B = api.bars, i0 = Math.max(0, Math.round(api.idx(d.pts[0].t))), pts = [];
      let pv = 0, vol = 0;
      for (let i = i0; i < B.length; i++) {
        const tp = (B[i].h + B[i].l + B[i].c) / 3, v = B[i].v || 1;
        pv += tp * v; vol += v;
        pts.push({ x: api.xi(i), y: api.y(pv / vol) });
      }
      g.poly(pts);
      g.vline(api.xi(i0), { dash: [3, 4], width: 1, color: alpha(g.color, 0.5) });
      if (pts.length) g.text('VWAP', pts[pts.length - 1].x + 4, pts[pts.length - 1].y, { size: 10 });
    },
    handles: (P, api, d) => { const i = Math.round(api.idx(d.pts[0].t)), b = api.bars[i]; return [{ x: P[0].x, y: b ? api.y(b.l) : P[0].y }]; },
  });
  function profile(g, i0, i1, xLeft, xRight) {
    const api = g.api, B = api.bars, T = api.theme;
    i0 = Math.max(0, i0); i1 = Math.min(B.length - 1, i1);
    if (i1 < i0) return;
    let lo = Infinity, hi = -Infinity;
    for (let i = i0; i <= i1; i++) { lo = Math.min(lo, B[i].l); hi = Math.max(hi, B[i].h); }
    if (!(hi > lo)) return;
    const rows = 24, step = (hi - lo) / rows, up = new Array(rows).fill(0), dn = new Array(rows).fill(0);
    for (let i = i0; i <= i1; i++) {
      const b = B[i], v = b.v || 0, r0 = Math.max(0, Math.floor((b.l - lo) / step)), r1 = Math.min(rows - 1, Math.floor((b.h - lo) / step));
      const share = v / (r1 - r0 + 1);
      for (let r = r0; r <= r1; r++) (b.c >= b.o ? up : dn)[r] += share;
    }
    const tot = up.map((u, r) => u + dn[r]), max = Math.max(...tot) || 1, poc = tot.indexOf(max);
    // value area: the rows around the busiest one holding 70% of the volume
    const all = tot.reduce((a, b) => a + b, 0);
    let vaLo = poc, vaHi = poc, acc = tot[poc];
    while (acc < all * 0.7 && (vaLo > 0 || vaHi < rows - 1)) {
      const below = vaLo > 0 ? tot[vaLo - 1] : -1, above = vaHi < rows - 1 ? tot[vaHi + 1] : -1;
      if (above >= below) acc += tot[++vaHi]; else acc += tot[--vaLo];
    }
    const width = Math.max(30, (xRight - xLeft) * 0.35);
    for (let r = 0; r < rows; r++) {
      const yTop = api.y(lo + (r + 1) * step) + 0.5, yBot = api.y(lo + r * step) - 0.5, inVA = r >= vaLo && r <= vaHi;
      const wu = (up[r] / max) * width, wd = (dn[r] / max) * width;
      if (wu > 0) g.rect({ x: xLeft, y: yTop }, { x: xLeft + wu, y: yBot }, { fill: alpha(T.up, inVA ? 0.45 : 0.22), stroke: false });
      if (wd > 0) g.rect({ x: xLeft + wu, y: yTop }, { x: xLeft + wu + wd, y: yBot }, { fill: alpha(T.down, inVA ? 0.45 : 0.22), stroke: false });
    }
    const yPoc = api.y(lo + (poc + 0.5) * step);
    g.line({ x: xLeft, y: yPoc }, { x: xRight, y: yPoc }, { color: '#F5A623', width: 1.5, dash: false });
    g.text('POC', xRight + 4, yPoc, { color: '#F5A623', size: 10 });
    g.rect({ x: xLeft, y: api.y(hi) }, { x: xRight, y: api.y(lo) }, { color: alpha(g.color, 0.4), width: 1, dash: [3, 4], fill: alpha(g.color, 0.03) });
  }
  tool('vpfixed', {
    name: 'Fixed range volume profile',
    draw(g, P, d) {
      const api = g.api;
      let i0 = Math.round(api.idx(d.pts[0].t)), i1 = Math.round(api.idx(d.pts[1].t));
      if (i0 > i1) [i0, i1] = [i1, i0];
      profile(g, i0, i1, Math.min(P[0].x, P[1].x), Math.max(P[0].x, P[1].x));
    },
  });
  tool('vpanchored', {
    name: 'Anchored volume profile', n: 1,
    draw(g, P, d) { const api = g.api; profile(g, Math.round(api.idx(d.pts[0].t)), api.bars.length - 1, P[0].x, api.xi(api.bars.length - 1)); },
  });

  // ---- measurers
  function rangeBox(g, P, c) { g.rect(P[0], P[1], { fill: alpha(c, 0.14), stroke: false }); }
  const duration = (ms) => { ms = Math.abs(ms); const d = Math.floor(ms / 86400e3), h = Math.floor((ms % 86400e3) / 3600e3), m = Math.floor((ms % 3600e3) / 60e3); return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`; };
  tool('pricerange', {
    name: 'Price range',
    draw(g, P, d) {
      const [a, b] = d.pts, api = g.api, up = b.p >= a.p, c = up ? api.theme.up : api.theme.down, xm = (P[0].x + P[1].x) / 2;
      rangeBox(g, P, c);
      g.line({ x: xm, y: P[0].y }, { x: xm, y: P[1].y }, { color: c, width: 1, dash: false });
      g.arrowHead({ x: xm, y: P[0].y }, { x: xm, y: P[1].y }, { color: c, size: 8 });
      g.label(`${sgn(b.p - a.p, api.dec)} (${sgn(pct(a.p, b.p))}%)`, xm, Math.min(P[0].y, P[1].y) + (up ? -6 : Math.abs(P[1].y - P[0].y) + 6), { base: up ? 'bottom' : 'top', bg: c });
    },
  });
  tool('daterange', {
    name: 'Date range',
    draw(g, P, d) {
      const [a, b] = d.pts, api = g.api, ym = (P[0].y + P[1].y) / 2, c = g.color;
      rangeBox(g, P, c);
      g.line({ x: P[0].x, y: ym }, { x: P[1].x, y: ym }, { color: c, width: 1, dash: false });
      g.arrowHead({ x: P[0].x, y: ym }, { x: P[1].x, y: ym }, { color: c, size: 8 });
      let i0 = Math.round(api.idx(a.t)), i1 = Math.round(api.idx(b.t)), vol = 0;
      if (i0 > i1) [i0, i1] = [i1, i0];
      for (let i = Math.max(0, i0); i <= Math.min(api.bars.length - 1, i1); i++) vol += api.bars[i].v || 0;
      g.label([`${Math.abs(i1 - i0)} bars, ${duration(b.t - a.t)}`, vol ? `Vol ${api.compact(vol)}` : ''].filter(Boolean), (P[0].x + P[1].x) / 2, Math.max(P[0].y, P[1].y) + 6, { base: 'top', bg: c });
    },
  });
  tool('measure', {
    name: 'Date and price range', key: 'Alt+M',
    draw(g, P, d) {
      const [a, b] = d.pts, api = g.api, up = b.p >= a.p, c = up ? api.theme.up : api.theme.down;
      rangeBox(g, P, c);
      const xm = (P[0].x + P[1].x) / 2, ym = (P[0].y + P[1].y) / 2;
      g.line({ x: xm, y: P[0].y }, { x: xm, y: P[1].y }, { color: c, width: 1, dash: false });
      g.line({ x: P[0].x, y: ym }, { x: P[1].x, y: ym }, { color: c, width: 1, dash: false });
      const bars = Math.round(api.idx(b.t) - api.idx(a.t));
      g.label([`${sgn(b.p - a.p, api.dec)} (${sgn(pct(a.p, b.p))}%)`, `${bars} bars, ${duration(b.t - a.t)}`], xm, up ? Math.min(P[0].y, P[1].y) - 6 : Math.max(P[0].y, P[1].y) + 6, { base: up ? 'bottom' : 'top', bg: c });
    },
  });

  // ---- brushes (press and drag)
  function smooth(g, P, o) {
    if (P.length < 3) { g.poly(P, o); return; }
    if (g.hit) { g.poly(P, o); return; }
    const ctx = g.ctx;
    ctx.strokeStyle = o.color; ctx.lineWidth = o.width; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(P[0].x, P[0].y);
    for (let i = 1; i < P.length - 1; i++) { const m = mid(P[i], P[i + 1]); ctx.quadraticCurveTo(P[i].x, P[i].y, m.x, m.y); }
    ctx.lineTo(P[P.length - 1].x, P[P.length - 1].y);
    ctx.stroke();
    ctx.lineCap = 'butt';
  }
  tool('brush', { name: 'Brush', n: 0, width: 2, noHandles: true, draw: (g, P) => smooth(g, P, { color: g.color, width: g.width }) });
  tool('highlighter', { name: 'Highlighter', n: 0, width: 14, color: 'rgba(245,166,35,0.35)', noHandles: true, draw: (g, P) => smooth(g, P, { color: g.color, width: g.width }) });

  // ---- arrows
  tool('arrowmarker', {
    name: 'Arrow marker',
    draw(g, P) {
      const L = dist(P[0], P[1]);
      if (L < 2) return;
      const a = ang(P[0], P[1]), head = Math.min(22, L * 0.45), bw = Math.max(3, g.width * 2.5), hw = bw * 2.6;
      const base = polar(P[0], L - head, a), n = a + Math.PI / 2;
      g.poly([polar(P[0], bw / 2, n), polar(base, bw / 2, n), polar(base, hw / 2, n), P[1], polar(base, -hw / 2, n), polar(base, -bw / 2, n), polar(P[0], -bw / 2, n)], { close: true, fill: g.color, stroke: false });
    },
  });
  tool('arrow', { name: 'Arrow', draw: (g, P) => { g.line(P[0], P[1]); g.arrowHead(P[0], P[1], { size: 12 }); } });
  function markGlyph(up) {
    return {
      n: 1,
      draw(g, P, d) {
        const c = d.color || (up ? g.api.theme.up : g.api.theme.down), s = 7 + g.width * 2, p = P[0], dir = up ? 1 : -1;
        const tip = { x: p.x, y: p.y + dir * 4 }, base = tip.y + dir * s;
        g.poly([tip, { x: p.x + s, y: base }, { x: p.x + s * 0.4, y: base }, { x: p.x + s * 0.4, y: base + dir * s }, { x: p.x - s * 0.4, y: base + dir * s }, { x: p.x - s * 0.4, y: base }, { x: p.x - s, y: base }], { close: true, fill: c, stroke: false });
        if (d.text) g.text(d.text, p.x, base + dir * (s + 4), { align: 'center', base: up ? 'top' : 'bottom', color: c });
      },
    };
  }
  tool('arrowup', { name: 'Arrow mark up', ...markGlyph(true) });
  tool('arrowdown', { name: 'Arrow mark down', ...markGlyph(false) });

  // ---- shapes
  tool('rect', { name: 'Rectangle', key: 'Alt+Shift+R', draw: (g, P) => g.rect(P[0], P[1], { fill: soft(g, 0.14) }) });
  tool('rotrect', {
    name: 'Rotated rectangle', n: 3,
    draw(g, P) {
      const v = sub(P[1], P[0]), L = Math.hypot(v.x, v.y) || 1, nrm = { x: -v.y / L, y: v.x / L };
      const h = (P[2].x - P[0].x) * nrm.x + (P[2].y - P[0].y) * nrm.y;
      g.poly([P[0], P[1], add(P[1], nrm, h), add(P[0], nrm, h)], { close: true, fill: soft(g, 0.14) });
    },
    handles: (P) => {
      if (P.length < 3) return P;
      const v = sub(P[1], P[0]), L = Math.hypot(v.x, v.y) || 1, nrm = { x: -v.y / L, y: v.x / L }, h = (P[2].x - P[0].x) * nrm.x + (P[2].y - P[0].y) * nrm.y;
      return [P[0], P[1], add(mid(P[0], P[1]), nrm, h)];
    },
  });
  tool('path', { name: 'Path', n: 'multi', draw: (g, P) => { g.poly(P); if (P.length > 1) g.arrowHead(P[P.length - 2], P[P.length - 1], { size: 11 }); } });
  tool('circle', { name: 'Circle', draw: (g, P) => g.circle(P[0], dist(P[0], P[1]), { fill: soft(g, 0.12) }) });
  tool('ellipse', { name: 'Ellipse', draw: (g, P) => g.ellipse(mid(P[0], P[1]), Math.abs(P[1].x - P[0].x) / 2, Math.abs(P[1].y - P[0].y) / 2, 0, { fill: soft(g, 0.12) }) });
  tool('polyline', { name: 'Polyline', n: 'multi', draw: (g, P) => g.poly(P, { close: P.length > 2, fill: P.length > 2 ? soft(g, 0.12) : null }) });
  tool('triangle', { name: 'Triangle', n: 3, draw: (g, P) => g.poly(P, { close: true, fill: soft(g, 0.14) }) });
  tool('arc', {
    name: 'Arc', n: 3,
    // from the first point to the second, bulging through the third
    draw(g, P) {
      const cc = circleThrough(P[0], P[2], P[1]);
      if (!cc) { g.line(P[0], P[1]); return; }
      const a0 = ang(cc.c, P[0]), a1 = ang(cc.c, P[1]), am = ang(cc.c, P[2]), norm = (a) => ((a % TAU) + TAU) % TAU;
      // go round the way that passes the third point
      const end = norm(am - a0) < norm(a1 - a0) ? a0 + norm(a1 - a0) : a0 - norm(a0 - a1);
      g.arc(cc.c, cc.r, a0, end, { fill: soft(g, 0.1), close: true });
    },
  });
  tool('curve', { name: 'Curve', n: 3, draw: (g, P) => g.bezier(P[0], P[2], null, P[1]) });
  tool('doublecurve', { name: 'Double curve', n: 4, draw: (g, P) => g.bezier(P[0], P[2], P[3], P[1]) });

  // ---- text
  tool('text', {
    name: 'Text', n: 1, askText: true,
    draw(g, P, d) {
      g.text(d.text || 'Text', P[0].x, P[0].y, { size: 13, color: g.color, base: 'middle' });
    },
  });

  // ---------------------------------------------------------------- toolbar groups (menus)
  const GROUPS = [
    { id: 'lines', title: 'Lines, channels & pitchforks', sections: [
      ['Lines', ['trend', 'ray', 'infoline', 'extended', 'trendangle', 'hline', 'hray', 'vline', 'crossline']],
      ['Channels', ['parallel', 'regression', 'flattop', 'disjoint']],
      ['Pitchforks', ['pitchfork', 'schiff', 'modschiff', 'insidepitchfork']],
    ] },
    { id: 'fib', title: 'Fibonacci & Gann', sections: [
      ['Fibonacci', ['fib', 'fibext', 'fibchannel', 'fibtime', 'fibfan', 'fibtimetrend', 'fibcircles', 'fibspiral', 'fibarcs', 'fibwedge', 'pitchfan']],
      ['Gann', ['gannbox', 'gannsqfixed', 'gannsquare', 'gannfan']],
    ] },
    { id: 'patterns', title: 'Patterns, Elliott waves & cycles', sections: [
      ['Chart patterns', ['xabcd', 'cypher', 'headshoulders', 'abcd', 'trianglepattern', 'threedrives']],
      ['Elliott waves', ['elliott5', 'elliott3', 'elliott5t', 'elliottwxy', 'elliottwxyxz']],
      ['Cycles', ['cyclic', 'timecycles', 'sine']],
    ] },
    { id: 'forecast', title: 'Forecasting, volume & measuring', sections: [
      ['Forecasting', ['long', 'short', 'forecast', 'barspattern', 'ghostfeed', 'sector']],
      ['Volume-based', ['avwap', 'vpfixed', 'vpanchored']],
      ['Measurers', ['pricerange', 'daterange', 'measure']],
    ] },
    { id: 'shapes', title: 'Brushes, arrows & shapes', sections: [
      ['Brushes', ['brush', 'highlighter']],
      ['Arrows', ['arrowmarker', 'arrow', 'arrowup', 'arrowdown']],
      ['Shapes', ['rect', 'rotrect', 'path', 'circle', 'ellipse', 'polyline', 'triangle', 'arc', 'curve', 'doublecurve']],
    ] },
  ];

  // ---------------------------------------------------------------- icons (24×24, stroked)
  const dot = (x, y) => `<circle cx="${x}" cy="${y}" r="1.7"/>`;
  const ICONS = {
    trend: `<path d="M5 19L19 5"/>${dot(5, 19)}${dot(19, 5)}`,
    ray: `<path d="M5 19L22 2"/>${dot(5, 19)}${dot(12, 12)}`,
    infoline: `<path d="M4 17L15 6"/>${dot(4, 17)}${dot(15, 6)}<rect x="13" y="13" width="8" height="6" rx="1.5"/>`,
    extended: `<path d="M2 22L22 2"/>${dot(8, 16)}${dot(16, 8)}`,
    trendangle: `<path d="M4 19L18 6M4 19h16"/><path d="M11 19a7 7 0 0 0-2-5"/>${dot(18, 6)}`,
    hline: `<path d="M2 12h20"/>${dot(12, 12)}`,
    hray: `<path d="M6 12h16"/>${dot(6, 12)}`,
    vline: `<path d="M12 2v20"/>${dot(12, 12)}`,
    crossline: `<path d="M2 12h20M12 2v20"/>${dot(12, 12)}`,
    parallel: `<path d="M3 15L15 4M9 21L21 10"/>${dot(3, 15)}${dot(15, 4)}${dot(21, 10)}`,
    regression: `<path d="M3 13L21 5M3 19L21 11" stroke-dasharray="2 2"/><path d="M3 16L21 8"/>`,
    flattop: `<path d="M3 6h18M3 19L21 11"/>${dot(3, 19)}${dot(21, 11)}${dot(21, 6)}`,
    disjoint: `<path d="M3 6L21 11M3 19L21 14"/>${dot(3, 6)}${dot(21, 11)}${dot(3, 19)}`,
    pitchfork: `<path d="M3 20L12 11M12 11L21 6M8 5L21 4M14 18L21 13"/>${dot(3, 20)}${dot(8, 5)}${dot(14, 18)}`,
    schiff: `<path d="M3 13L21 6M8 5L21 3M14 18L21 12" /><path d="M3 20v-7" stroke-dasharray="2 2"/>${dot(3, 20)}${dot(8, 5)}${dot(14, 18)}`,
    modschiff: `<path d="M6 12L21 6M8 4L21 3M14 18L21 13"/><path d="M3 20L6 12" stroke-dasharray="2 2"/>${dot(3, 20)}${dot(8, 4)}${dot(14, 18)}`,
    insidepitchfork: `<path d="M3 20L21 8M8 5L21 3M14 18L21 14"/><path d="M11 11L21 5.5M12 15L21 11" stroke-dasharray="2 2"/>${dot(3, 20)}`,
    fib: `<path d="M3 5h18M3 10h18M3 14h18M3 19h18"/><path d="M5 19L19 5" stroke-dasharray="2 2"/>`,
    fibext: `<path d="M9 5h12M9 9h12M9 13h12"/><path d="M3 19L7 9l3 6" stroke-dasharray="2 2"/>${dot(3, 19)}${dot(7, 9)}${dot(10, 15)}`,
    fibchannel: `<path d="M3 11L13 3M3 16L18 4M3 21L21 7"/>`,
    fibtime: `<path d="M4 3v18M7 3v18M10 3v18M14 3v18M20 3v18"/>`,
    fibfan: `<path d="M3 21L21 3M3 21L21 9M3 21L21 15M3 21L9 3M3 21L15 3"/>`,
    fibtimetrend: `<path d="M8 3v18M13 3v18M20 3v18"/><path d="M3 17L6 8l3 9" stroke-dasharray="2 2"/>`,
    fibcircles: `<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5.5"/><circle cx="12" cy="12" r="2.5"/>`,
    fibspiral: `<path d="M12 12a2 2 0 0 1 2 2 4 4 0 0 1-4 4 6 6 0 0 1-6-6 8 8 0 0 1 8-8 10 10 0 0 1 9 6"/>`,
    fibarcs: `<path d="M3 21a18 18 0 0 1 18-18M3 21a12 12 0 0 1 12-12M3 21a6 6 0 0 1 6-6"/>`,
    fibwedge: `<path d="M3 21L21 13M3 21L13 3"/><path d="M21 13A19 19 0 0 0 13 3M15 16a13 13 0 0 0-5-9M9 18a7 7 0 0 0-3-5"/>`,
    pitchfan: `<path d="M3 21L21 4M3 21L21 10M3 21L21 16M3 21L18 21" /><path d="M21 4v17" stroke-dasharray="2 2"/>`,
    gannbox: `<rect x="3" y="3" width="18" height="18"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/>`,
    gannsqfixed: `<rect x="3" y="3" width="18" height="18"/><path d="M3 21L21 3M3 3l18 18M3 12h18M12 3v18"/>`,
    gannsquare: `<rect x="3" y="3" width="18" height="18"/><path d="M3 21L21 3M3 21L21 12M3 21L12 3"/>`,
    gannfan: `<path d="M3 21L21 3M3 21L21 12M3 21L12 3M3 21L21 17M3 21L7 3"/>`,
    xabcd: `<path d="M3 18L7 5l4 9 5-7 5 11"/><path d="M3 18L11 14M11 14L21 18" stroke-dasharray="2 2"/>${dot(7, 5)}${dot(16, 7)}`,
    cypher: `<path d="M3 17L7 5l4 8 5-9 5 13"/>${dot(3, 17)}${dot(7, 5)}${dot(11, 13)}${dot(16, 4)}${dot(21, 17)}`,
    headshoulders: `<path d="M2 18l4-7 3 4 3-11 3 11 3-4 4 7"/><path d="M2 15h20" stroke-dasharray="2 2"/>`,
    abcd: `<path d="M4 18L9 6l6 8 5-10"/>${dot(4, 18)}${dot(9, 6)}${dot(15, 14)}${dot(20, 4)}`,
    trianglepattern: `<path d="M3 4L21 11L3 19"/><path d="M3 4l5 13 5-10 4 7"/>`,
    threedrives: `<path d="M2 20l4-6 3 3 4-8 3 3 4-9 2 4"/>`,
    elliott5: `<path d="M2 19l4-7 3 3 5-11 3 6 5-6"/><text x="6" y="9" font-size="5" stroke="none" fill="currentColor">1</text><text x="20" y="5" font-size="5" stroke="none" fill="currentColor">5</text>`,
    elliott3: `<path d="M3 5l6 11 5-6 7 10"/><text x="7" y="22" font-size="5" stroke="none" fill="currentColor">A</text><text x="17" y="22" font-size="5" stroke="none" fill="currentColor">C</text>`,
    elliott5t: `<path d="M2 6l4 12 4-10 4 8 4-5 4 3"/>`,
    elliottwxy: `<path d="M3 19l6-12 5 7 7-9"/>${dot(9, 7)}${dot(14, 14)}${dot(21, 5)}`,
    elliottwxyxz: `<path d="M2 19l4-11 3 6 4-9 3 6 6-6"/>`,
    cyclic: `<path d="M4 3v18M9 3v18M14 3v18M19 3v18"/>`,
    timecycles: `<path d="M2 17a5 5 0 0 1 10 0M12 17a5 5 0 0 1 10 0"/>`,
    sine: `<path d="M2 12c2.5-8 5-8 7.5 0s5 8 7.5 0 3.5-4 5-4"/>`,
    long: `<path d="M3 4h18M3 13h18M3 20h18"/><path d="M3 4h18v9H3z" fill="currentColor" fill-opacity=".18" stroke="none"/><text x="9" y="11" font-size="6" stroke="none" fill="currentColor">L</text>`,
    short: `<path d="M3 4h18M3 11h18M3 20h18"/><path d="M3 11h18v9H3z" fill="currentColor" fill-opacity=".18" stroke="none"/><text x="9" y="18" font-size="6" stroke="none" fill="currentColor">S</text>`,
    forecast: `<path d="M4 18L18 6" stroke-dasharray="3 2"/><path d="M12 6h6v6"/>${dot(4, 18)}`,
    barspattern: `<path d="M5 4v16M10 7v10M15 5v12M20 9v8"/><path d="M4 8h2v6H4zM9 9h2v5H9zM14 8h2v7h-2zM19 11h2v4h-2z"/>`,
    ghostfeed: `<path d="M5 6v12M10 8v8M15 5v10M20 9v10" stroke-dasharray="2 2"/><path d="M4 9h2v6H4zM9 10h2v4H9zM14 7h2v5h-2zM19 12h2v5h-2z"/>`,
    sector: `<path d="M4 20V5a15 15 0 0 1 15 15z"/>${dot(4, 20)}`,
    avwap: `<path d="M3 18c4 0 5-9 9-9s5 5 9 3"/><path d="M5 4v16M5 8h-2v6h2" />`,
    vpfixed: `<path d="M3 4v16M3 6h8M3 9h12M3 12h17M3 15h10M3 18h6"/><path d="M21 4v16"/>`,
    vpanchored: `<path d="M4 4v16M4 6h8M4 9h12M4 12h16M4 15h10M4 18h6"/>${dot(4, 12)}`,
    pricerange: `<path d="M12 4v16M8 8l4-4 4 4M5 4h14M5 20h14"/>`,
    daterange: `<path d="M4 12h16M16 8l4 4-4 4M4 5v14M20 5v14"/>`,
    measure: `<path d="M12 3v18M3 12h18"/><path d="M9 6l3-3 3 3M18 9l3 3-3 3"/>`,
    brush: `<path d="M20 4c-3 1-9 7-11 10l2 2c3-2 9-8 10-11z"/><path d="M9 14c-3 0-4 2-5 6 4-1 6-2 6-5"/>`,
    highlighter: `<path d="M14 4l6 6-8 8H6v-6z"/><path d="M4 21h8"/>`,
    arrowmarker: `<path d="M4 20l10-10M9 9h7v7z" /><path d="M9 9h7v7z" fill="currentColor"/>`,
    arrow: `<path d="M4 20L19 5"/><path d="M11 5h8v8"/>`,
    arrowup: `<path d="M12 4l7 8h-4v8H9v-8H5z"/>`,
    arrowdown: `<path d="M12 20l7-8h-4V4H9v8H5z"/>`,
    rect: `<rect x="4" y="6" width="16" height="12" rx="1"/>`,
    rotrect: `<path d="M8 3l13 7-5 10L3 13z"/>`,
    path: `<path d="M3 17l5-7 5 4 6-8"/><path d="M15 6h4v4"/>`,
    circle: `<circle cx="12" cy="12" r="8"/>${dot(12, 12)}`,
    ellipse: `<ellipse cx="12" cy="12" rx="9" ry="6"/>`,
    polyline: `<path d="M4 8l6-4 9 5-2 10-11-2z"/>${dot(4, 8)}${dot(10, 4)}${dot(19, 9)}`,
    triangle: `<path d="M12 4l9 16H3z"/>`,
    arc: `<path d="M3 18a10 10 0 0 1 18 0"/>${dot(3, 18)}${dot(21, 18)}`,
    curve: `<path d="M3 19C6 4 14 4 21 12"/>${dot(3, 19)}${dot(21, 12)}`,
    doublecurve: `<path d="M3 17c3-12 7-12 9-5s6 7 9-5"/>${dot(3, 17)}${dot(21, 7)}`,
    text: `<path d="M5 6V4h14v2M12 4v16M9 20h6"/>`,
  };

  window.CandelaDrawings = { TOOLS, GROUPS, ICONS, pen, hitTest, alpha };
})();
