// Fable candlestick chart (owner: "Axiom level, candles, live"; 0.27.2: "display EXACTLY like Axiom / GMGN").
// A classic content script: exposes globalThis.FableChart. Canvas, device-pixel sharp, theme colours from the card's CSS
// variables (read once per theme). No library, nothing fetched.
// Layout (0.27.2, the GMGN chart in the card's size):
// - top: the live price, LIVE, timeframes 1s 30s 1m 5m 15m 1H 4H 1D, MC / Price
// - on the chart, top left: the candle under the pointer (else the last one) as "O H L C change (pct)"; its volume on
//   the volume pane
// - price pane: candles, auto-scaled on the visible ones, clean round price labels on the right ($520.00M, $0.0₄479), the
//   last price as a tag; a period with no trade is a flat dash at the last close, so the candles run continuously
// - volume pane under it (own scale), buys green / sells red; time axis with round times, the hour (or the day) in bold
// - bottom: range presets 1d 7d 30d 180d All, and who traded in the last 5 minutes
// - default view: the last ~120 candles of the timeframe (all of them, wider, when there are fewer); Ctrl / pinch zoom,
//   drag to pan, double-click back to live, older candles read on demand (opts.onRange)
// Data rules (0.27): 1 s candles; live trades queued and drawn at most once per frame; a late trade lands in its own
// candle; a voided trade leaves; every timeframe seen is kept (capped) and follows the live trades. 0.27.2: a candle
// 10x away from all its neighbours (a bad print) is put back in line before it is drawn, and 1D is rolled up from 4h.
(() => {
  // 0.29 words: every word this chart draws or puts in a tooltip comes from FableI18n (src/i18n.js, loaded before this script; keys
  // chartui.*), read when it is drawn so a language change shows on the next paint. UX plain text (canvas, textContent, title),
  // UT HTML-safe text for innerHTML, UD a date in the active language (month names are never hard-coded).
  const UX = (k, p) => FableI18n.tx(k, p), UT = (k, p) => FableI18n.t(k, p);
  const LANGK = () => (FableI18n.lang ? FableI18n.lang() : 'en');
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const MD = {month: 'short', day: 'numeric'}, MO = {month: 'short'};
  // Intl formatters are costly to make and the axis asks for a handful of labels every frame: one answer per language and local day
  const dmemo = new Map();
  const UD = (t, o) => {
    const d = new Date(t), k = `${FableI18n.lang()}|${o === MO ? 'm' : 'md'}|${d.getFullYear() * 372 + d.getMonth() * 31 + d.getDate()}`;
    let v = dmemo.get(k);
    if (v === undefined) { if (dmemo.size > 400) dmemo.clear(); dmemo.set(k, (v = FableI18n.date(t, o))); }
    return v;
  };
  const SUB = '₀₁₂₃₄₅₆₇₈₉';
  const subz = (n) => String(n).split('').map((d) => SUB[d]).join('');
  // a small price the trench way: 0.0₄479 (sig significant digits)
  const small = (v, sig = 3) => {
    const s = Math.abs(v).toFixed(20).replace(/0+$/, '');
    const m = s.match(/^0\.(0+)(\d+)/);
    if (m && m[1].length >= 3) return `${v < 0 ? '-' : ''}0.0${subz(m[1].length)}${m[2].slice(0, sig)}`;
    return Number(v.toPrecision(sig)).toString();
  };
  const UNITS = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
  const unitOf = (a) => UNITS.find(([u]) => a >= u) || [1, ''];
  // a value: market cap (or anything at or above $1,000) with K / M / B / T, a price with its decimals
  const fmt = (v, mode) => {
    if (v == null || !isFinite(v)) return '';
    const a = Math.abs(v);
    if (a >= 1e15) return `$${v.toExponential(2)}`;
    if (mode === 'mc' || a >= 1000) { const [u, sx] = unitOf(a); return u === 1 ? `$${v.toFixed(0)}` : `$${(v / u).toFixed(2)}${sx}`; }
    return a >= 1 ? `$${v.toFixed(2)}` : a >= 0.01 ? `$${v.toFixed(4)}` : a === 0 ? '$0' : `$${small(v)}`;
  };
  // price axis: each label in its own unit ($1.00B, $750.00M), as many decimals as the label step needs (at least 2)
  const axisFmt = (v, mode, d, top) => {
    const a = Math.abs(top || v);
    if (a >= 1e15) return `$${v.toExponential(2)}`;
    if (mode === 'mc' || a >= 1000) {
      const [u, sx] = unitOf(Math.abs(v));
      const dec = Math.max(u === 1 ? 0 : 2, Math.min(3, Math.ceil(-Math.log10(d / u) - 1e-9)));
      return `$${(v / u).toFixed(Math.max(0, dec))}${sx}`;
    }
    if (a >= 0.001) return `$${v.toFixed(Math.max(2, Math.min(8, Math.ceil(-Math.log10(d) - 1e-9))))}`;
    return v <= 0 ? '$0' : `$${small(v, Math.max(2, Math.min(5, Math.ceil(Math.log10(a / d) - 1e-9) + 1)))}`;
  };
  // the same without the dollar sign, for the O H L C line (GMGN: O498.37M)
  const bare = (v, mode) => fmt(v, mode).replace('$', '');
  const usdK = (v) => (v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(1)}K` : `$${Math.round(v)}`);
  const volK = (v) => { const [u, sx] = unitOf(v); return u === 1 ? v.toFixed(v >= 100 ? 0 : 2) : `${(v / u).toFixed(2)}${sx}`; };
  // a round label step: 1, 2, 2.5 or 5 x 10^k
  const nice = (raw) => { const p = 10 ** Math.floor(Math.log10(raw)), f = raw / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p; };
  const p2 = (n) => String(n).padStart(2, '0');
  // time axis label, and whether it opens a bigger unit (bold: the minute on a seconds axis, the hour, the day, the month)
  const tlabel = (t, iv) => {
    const d = new Date(t), h = d.getHours(), mi = d.getMinutes(), s = d.getSeconds();
    if (iv >= 864e5) return d.getDate() === 1 ? [UD(t, MO), true] : [UD(t, MD), false];
    if (!h && !mi && !s) return [UD(t, MD), true];
    if (iv < 60e3) return s ? [`${p2(h)}:${p2(mi)}:${p2(s)}`, false] : [`${p2(h)}:${p2(mi)}`, true];
    return [`${p2(h)}:${p2(mi)}`, !mi && iv < 3600e3];
  };
  const ttag = (t, step) => { const d = new Date(t), hm = `${p2(d.getHours())}:${p2(d.getMinutes())}`; return step < 60e3 ? `${hm}:${p2(d.getSeconds())}` : step >= 3600e3 ? `${UD(t, MD)}${step < 864e5 ? ` ${hm}` : ''}` : hm; };
  const TFS = ['1s', '30s', '1m', '5m', '15m', '1h', '4h', '1d'];
  const TFL = {'1h': '1H', '4h': '4H', '1d': '1D'};
  const STEP = {'1s': 1e3, '15s': 15e3, '30s': 30e3, '1m': 60e3, '5m': 300e3, '15m': 900e3, '1h': 3600e3, '4h': 144e5, '1d': 864e5};
  // a timeframe the server does not send: asked as this one and rolled up here
  const FETCH = {'1d': '4h'};
  // range presets: the span and the timeframe that shows it in 100-300 candles
  const RANGES = [['1d', 864e5, '5m'], ['7d', 7 * 864e5, '1h'], ['30d', 30 * 864e5, '4h'], ['180d', 180 * 864e5, '1d']];
  // All: the finest candle at which the coin's whole life fits in about 300 candles (400 for 4h)
  const LIFE = [[5 * 60e3, '1s'], [150 * 60e3, '30s'], [5 * 3600e3, '1m'], [25 * 3600e3, '5m'], [3 * 864e5, '15m'], [12 * 864e5, '1h'], [66 * 864e5, '4h']];
  const lifeTf = (age) => (LIFE.find(([a]) => age <= a) || [0, '1d'])[1];
  const FRESH = 5 * 60e3; // younger than this: 1 s candles
  const MAXC = 20000, MAXT = 3000, MAXLOG = 6000, RIGHT = 4; // candles per timeframe, bubbles kept, live trades kept, empty periods right of the last candle
  const TICK = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400, 172800, 604800, 1209600, 2592000].map((s) => s * 1e3);
  const MONO = '10.5px ui-monospace, SFMono-Regular, Consolas, monospace';
  // first index whose time is >= t (candles and trades are sorted by time)
  const lb = (a, t) => { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m][0] < t) lo = m + 1; else hi = m; } return lo; };

  // candle: [t, o, h, l, c, buyUsd (all volume when unsplit), sellUsd | null (unsplit), trades, last trade time, origin]
  // origin: 0 = opened by a live trade, 1 = rolled up or built from a trade list, [o..lastT] = the server's own values.
  // A server candle counts as closed (its last trade at the period's end), except the newest one setData receives: that
  // period is still open, so the next live trade in it moves its close (open() below).
  const norm = (k, step) => { const c = [+k[0], +k[1] || +k[4], +k[2] || +k[4], +k[3] || +k[4], +k[4], +k[5] || 0, k[6] == null ? null : +k[6] || 0, +k[7] || 0, +k[0] + step - 1, 0]; c[9] = c.slice(1, 9); return c; };
  const open = (c) => { if (c && Array.isArray(c[9])) { c[8] = c[0]; c[9][7] = c[0]; } };
  const born = (b, o, [t, p, usd, side]) => [b, o, Math.max(o, p), Math.min(o, p), p, side === 'sell' ? 0 : usd || 0, side === 'sell' ? usd || 0 : 0, 1, t, 0];
  const fold = (c, [t, p, usd, side]) => {
    if (p > c[2]) c[2] = p;
    if (p < c[3]) c[3] = p;
    if (t >= c[8]) { c[4] = p; c[8] = t; }
    if (usd) { if (c[6] == null || side !== 'sell') c[5] += usd; else c[6] += usd; }
    c[7]++;
  };
  // one trade into a candle list: the current candle grows, a new period opens at the last close, a late trade goes into
  // its own period (a candle is inserted when that period had none). Older than the list: the server already has it.
  const land = (a, tr, step) => {
    const b = Math.floor(tr[0] / step) * step;
    let i = a.length - 1;
    if (i < 0 || b > a[i][0]) { a.push(born(b, i >= 0 ? a[i][4] : tr[1], tr)); return; }
    if (b !== a[i][0]) {
      if (b < a[0][0]) return;
      i = lb(a, b);
      if (a[i][0] !== b) { a.splice(i, 0, born(b, a[i - 1][4], tr)); return; }
    }
    fold(a[i], tr);
  };
  const fromTrades = (trs, step) => { const a = []; for (const tr of trs) land(a, tr, step); for (const c of a) c[9] = 1; return a; };
  const rollup = (a, step) => {
    const out = [];
    for (const c of a) {
      const b = Math.floor(c[0] / step) * step, o = out[out.length - 1];
      if (o && o[0] === b) {
        if (c[2] > o[2]) o[2] = c[2];
        if (c[3] < o[3]) o[3] = c[3];
        o[4] = c[4]; o[7] += c[7]; o[8] = c[8];
        if (c[6] == null && o[6] != null) { o[5] += o[6]; o[6] = null; }
        o[5] += c[5] + (o[6] == null && c[6] != null ? c[6] : 0);
        if (o[6] != null) o[6] += c[6];
      } else out.push([b, c[1], c[2], c[3], c[4], c[5], c[6], c[7], c[8], 1]);
    }
    return out;
  };
  // a bad print never reaches the screen: a candle whose close (or open, high, low) is 10x away from the median close of
  // the 8 around it is put back at its neighbours' level (PONS 2026-10-02: one "$445M" print made the All view a flat
  // line with a spike). Real moves stay: the candles after a real jump carry the new level, so the median follows it.
  const sane = (a) => {
    const n = a.length;
    if (n < 5) return a;
    const w = [];
    for (let i = 0; i < n; i++) {
      w.length = 0;
      for (let j = Math.max(0, i - 4); j <= Math.min(n - 1, i + 4); j++) if (j !== i && a[j][4] > 0) w.push(a[j][4]);
      if (w.length < 4) continue;
      w.sort((x, y) => x - y);
      const m = w[w.length >> 1], c = a[i], bad = (x) => !(x > 0) || x / m > 10 || m / x > 10;
      if (!(bad(c[1]) || bad(c[2]) || bad(c[3]) || bad(c[4]))) continue;
      const prev = i > 0 ? a[i - 1][4] : m;
      if (bad(c[4])) c[4] = prev;
      if (bad(c[1])) c[1] = prev;
      if (bad(c[2])) c[2] = Math.max(c[1], c[4]);
      if (bad(c[3])) c[3] = Math.min(c[1], c[4]);
      c[2] = Math.max(c[2], c[1], c[4]); c[3] = Math.min(c[3], c[1], c[4]);
    }
    return a;
  };
  // a voided trade: the period goes back to what the server sent (or its open) and the live trades that still stand
  const unfold = (a, b, rest, tr) => {
    const i = lb(a, b), c = a[i];
    if (!c || c[0] !== b) return;
    if (c[9] === 1) { if (tr[2]) { if (c[6] == null || tr[3] !== 'sell') c[5] = Math.max(0, c[5] - tr[2]); else c[6] = Math.max(0, c[6] - tr[2]); } c[7] = Math.max(0, c[7] - 1); return; }
    if (!c[9] && !rest.length) { a.splice(i, 1); return; }
    if (c[9]) [c[1], c[2], c[3], c[4], c[5], c[6], c[7], c[8]] = c[9];
    else { c[2] = c[3] = c[4] = c[1]; c[5] = 0; c[6] = c[6] == null ? null : 0; c[7] = 0; c[8] = 0; }
    for (const x of rest) fold(c, x);
  };
  const trade = (x) => [+x[0], +x[1], +x[2] || 0, x[3] === 'sell' ? 'sell' : 'buy', x[4] ? String(x[4]) : ''];

  function mount(host, opts = {}) {
    // data state survives a remount (opts.restore = the old chart's save()); view state is per mount
    const st = opts.restore || {series: new Map(), trades: [], log: [], seen: new Set(), srv: new Set(), tv: 0, supply: null, mode: 'mc', userMode: false,
      want: null, auto: true, tf: null, live: false, late: false, firstT: null, flow: null, flow1h: null, waiting: false, lastTick: null};
    if (opts.postTime) st.post = opts.postTime;
    if (opts.born > 0) st.born = +opts.born;
    const launchT = () => Math.min(st.born || Infinity, st.firstT || Infinity);
    const ui = {grow: opts.restore ? 1 : 0, played: !!opts.restore, anim: 0, raf: 0, q: [], cw: null, end: null, span: null, rng: null, vis: true, dirty: false, L: null,
      hover: null, pins: new Map(), drag: null, pinch: null, hint: -1e9, older: 0, failAt: 0, legendKey: '', ohlcKey: '', flowHtml: null, flowAt: 0, flash: 0, bubK: '', bub: [], wheel: false, tick: 0};
    host.innerHTML = `<div class="fc">
      <div class="fc-top"><div class="fc-legend"><b></b><span class="fc-age"></span></div><div class="fc-ctl"><span class="fc-live"><i></i><b>${UT('chartui.live')}</b></span>${TFS.map((t) => `<button data-tf="${t}">${TFL[t] || t}</button>`).join('')}<button data-mode title="${esc(UX('chartui.modeTitle'))}">${UT('chartui.mode.mc')}</button></div></div>
      <div class="fc-wrap"><canvas></canvas><div class="fc-ohlc"></div></div>
      <div class="fc-bot"><div class="fc-rng">${RANGES.map(([k]) => `<button data-rng="${k}">${k}</button>`).join('')}<button data-all title="${esc(UX('chartui.allTitle'))}">${UT('chartui.all')}</button></div><div class="fc-flow"></div></div></div>`;
    const cv = host.querySelector('canvas'), ctx = cv.getContext('2d'), wrap = host.querySelector('.fc-wrap');
    const legend = host.querySelector('.fc-legend'), priceEl = legend.querySelector('b'), ageEl = legend.querySelector('.fc-age'), liveEl = host.querySelector('.fc-live'), liveB = liveEl.querySelector('b'), flowEl = host.querySelector('.fc-flow'), ohlcEl = host.querySelector('.fc-ohlc');
    const ac = new AbortController(), on = {signal: ac.signal};
    // colours: read once per theme (the card's .fable class), not on every draw
    const fab = host.closest?.('.fable') || null;
    let K = null, Kk = null;
    const colors = () => {
      const k = fab ? fab.className : document.documentElement.className;
      if (K && k === Kk) return K;
      Kk = k;
      const cs = getComputedStyle(host), g = (n, d) => cs.getPropertyValue(n).trim() || d;
      return (K = {up: g('--green', '#1fc28a'), dn: g('--red', '#f4497c'), t1: g('--t1', '#e7e9ea'), t2: g('--t2', '#71767b'), line: g('--line', '#2f3336'), bg: g('--bg', '#000'), brand: g('--brand', '#5b7fff'), amber: g('--amber', '#f59e0b')});
    };
    matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => { K = null; schedule(); }, on);
    let W = 0, H = 0, dpr = 1, GB = new Float64Array(9 * 256); // GB: bar geometry, reused every draw
    const size = () => { dpr = window.devicePixelRatio || 1; W = wrap.clientWidth; H = wrap.clientHeight; cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); cv.style.width = `${W}px`; cv.style.height = `${H}px`; K = null; draw(); };
    const val = (p) => (st.mode === 'mc' && st.supply ? p * st.supply : p);
    const mmode = () => (st.mode === 'mc' && st.supply ? 'mc' : 'p');
    const cur = () => (st.tf ? st.series.get(st.tf) : null);

    // one draw per animation frame, whatever the trade rate; trades queued meanwhile land first, in time order
    const frame = () => { ui.raf = 0; flushQ(); if (ui.grow < 1) return; if (ui.vis && W) draw(); else ui.dirty = true; };
    const schedule = () => { if (!ui.raf) ui.raf = requestAnimationFrame(frame); };
    const flushQ = () => {
      if (!ui.q.length) return;
      const q = ui.q;
      ui.q = [];
      if (q.length > 1) q.sort((x, y) => x[0] - y[0]);
      for (const tr of q) take(tr);
      st.waiting = false;
      st.tv++;
      // the first trades on a chart that had nothing to show: drawn on the wanted timeframe (1 s until the server's answer picks)
      if (!st.tf || !st.series.get(st.tf)?.c.length) { const tf = st.want && STEP[st.want] ? st.want : '1s'; if (provisional(tf)) show(tf); }
      // the flow strip at most twice a second, with a trailing paint so the last trades always show
      if (performance.now() - ui.flowAt > 500) paintFlow();
      else if (!ui.flowT) ui.flowT = setTimeout(() => { ui.flowT = 0; paintFlow(); }, 520);
      // the price flashes once per burst
      if (performance.now() - ui.flash > 450) { ui.flash = performance.now(); priceEl.classList.add('flash'); setTimeout(() => priceEl.classList.remove('flash'), 400); }
    };
    const take = (tr) => {
      if (st.srv.has(`${tr[0]}|${tr[1]}`)) return; // already in the server's candles (the room's last trade, sent on connect)
      for (const s of st.series.values()) {
        land(s.c, tr, s.step);
        if (s.c.length > MAXC * 1.1) { s.c.splice(0, s.c.length - MAXC); s.done = false; }
      }
      if (!st.series.has('1s')) st.series.set('1s', {tf: '1s', step: 1e3, c: fromTrades([tr], 1e3), done: false, at: 0, syn: true});
      if (tr[4]) { st.log.push(tr); if (st.log.length > MAXLOG * 1.1) st.log.splice(0, st.log.length - MAXLOG); }
      if (tr[2] > 0) {
        const T = st.trades;
        if (!T.length || tr[0] >= T[T.length - 1][0]) T.push(tr); else T.splice(lb(T, tr[0]), 0, tr);
        if (T.length > MAXT * 1.1) T.splice(0, T.length - MAXT);
      }
    };

    // geometry of one frame: the visible periods, the price and volume scales
    function layout(s) {
      const padR = 62, axisB = 16, top = 19, plotW = Math.max(40, W - padR), step = s.step, a = s.c;
      const volH = Math.max(18, Math.round((H - axisB) * 0.2)), gap = 5, base = H - axisB, vy = base - volH, plotH = vy - gap - top;
      // the live edge: the last candle, or the current period while the stream is live (empty seconds still pass)
      const lastT = a[a.length - 1][0], nowB = st.live ? Math.floor(Date.now() / step) * step : -Infinity;
      const first = a[0][0], liveT = Math.max(lastT, Math.min(nowB, lastT + step * 600)), edge = liveT + step * (1 + RIGHT), slots = (edge - first) / step;
      // default: the last ~120 candles (all of them, wider, up to 14 px, when there are fewer); a range preset: its span
      // (the whole life when the coin is younger); All: the whole life
      const N = Math.max(60, Math.min(150, Math.round(plotW / 4)));
      let cw = ui.cw;
      if (cw == null) {
        if (ui.span === Infinity) cw = plotW / slots;
        else if (ui.span) cw = plotW / Math.min(slots, ui.span / step + RIGHT);
        else cw = slots <= N + RIGHT ? Math.min(14, plotW / slots) : plotW / (N + RIGHT);
        cw = Math.max(0.2, cw);
      }
      const end = ui.end ?? edge, start = end - (plotW / cw) * step;
      const i0 = Math.max(0, lb(a, start - step + 1) - 1), i1 = lb(a, end);
      // the scale follows the visible candles; a wick reaches at most one body range (or 4%) past the bodies, so one bad
      // print cannot flatten the chart (the rest of that wick is clipped at the edge)
      let lo = Infinity, hi = -Infinity, blo = Infinity, bhi = -Infinity, vmax = 0;
      for (let i = i0; i < i1; i++) {
        const c = a[i];
        if (c[0] + step <= start) continue;
        const b0 = c[1] < c[4] ? c[1] : c[4], b1 = c[1] < c[4] ? c[4] : c[1];
        if (c[3] < lo) lo = c[3]; if (c[2] > hi) hi = c[2]; if (b0 < blo) blo = b0; if (b1 > bhi) bhi = b1;
        const v = c[5] + (c[6] || 0); if (v > vmax) vmax = v;
      }
      if (!isFinite(lo)) { const c = a[Math.max(0, Math.min(a.length - 1, i1 - 1))]; lo = hi = blo = bhi = c[4]; }
      else { const room = Math.max(bhi - blo, bhi * 0.04); lo = Math.max(lo, blo - room); hi = Math.min(hi, bhi + room); }
      lo = val(lo); hi = val(hi);
      if (!(hi > lo)) { const m = hi || 1; hi = m * 1.01; lo = m * 0.99; }
      const pad = (hi - lo) * 0.08; lo = Math.max(lo - pad, lo * 0.5); hi += pad;
      return {padR, axisB, top, volH, plotW, plotH, base, vy, cw, step, start, end, edge, first, i0, i1, lo, hi, vmax: vmax || 1, liveT};
    }

    function draw() {
      if (!W || !H) return;
      ui.dirty = false;
      const k = colors();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      const s = cur(), a = s ? s.c : [];
      if (!a.length) {
        ui.L = null;
        ctx.fillStyle = k.t2; ctx.font = '600 12px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(st.waiting ? UX('chartui.waiting') : '', W / 2, H / 2); ctx.textAlign = 'left';
        setLegend(null); return;
      }
      const L = (ui.L = layout(s));
      const {plotW, plotH, top, padR, cw, step, start, end, i0, i1, base, vy, axisB} = L;
      const X = (t) => plotW - ((end - t) / step) * cw; // left edge of the period that starts at t
      const Y = (v) => top + (1 - (v - L.lo) / (L.hi - L.lo)) * plotH;
      const m = mmode();
      // price grid + labels on round values
      const ps = nice((L.hi - L.lo) / Math.max(3, Math.min(7, Math.floor(plotH / 21))));
      const ticks = [];
      for (let v = Math.ceil(L.lo / ps) * ps; v <= L.hi + ps * 1e-9; v += ps) ticks.push(v);
      // time grid on round local times, labels at least 64 px apart (a gap in trading never shifts them)
      let iv = TICK.find((v) => v >= step && (v / step) * cw >= 64);
      if (!iv) iv = TICK[TICK.length - 1] * Math.ceil(64 / ((TICK[TICK.length - 1] / step) * cw));
      const tz = -new Date(end).getTimezoneOffset() * 60e3, al = iv >= 864e5 ? 0 : tz; // day ticks: on local midnights
      const tts = [];
      for (let t = Math.ceil((start + al) / iv) * iv - al; t <= end; t += iv) tts.push(t);
      ctx.lineWidth = 1; ctx.strokeStyle = k.line; ctx.globalAlpha = 0.55; ctx.beginPath();
      for (const v of ticks) { const yy = Math.round(Y(v)) + 0.5; ctx.moveTo(0, yy); ctx.lineTo(plotW, yy); }
      for (const t of tts) { const xx = Math.round(X(t) + cw / 2) + 0.5; if (xx > 0 && xx < plotW) { ctx.moveTo(xx, top); ctx.lineTo(xx, base); } }
      ctx.moveTo(0, Math.round(vy - 2) + 0.5); ctx.lineTo(plotW, Math.round(vy - 2) + 0.5);
      ctx.stroke(); ctx.globalAlpha = 1;
      ctx.font = MONO; ctx.textBaseline = 'middle';
      // (a label the last-price tag would cover is left out)
      const lastY = Math.max(top, Math.min(top + plotH, Y(val(a[a.length - 1][4]))));
      ctx.fillStyle = k.t2;
      for (const v of ticks) { const yy = Math.round(Y(v)) + 0.5; if (yy > top - 6 && yy < top + plotH + 2 && Math.abs(yy - lastY) > 15) ctx.fillText(axisFmt(v, m, ps, ticks[ticks.length - 1]), plotW + 6, yy); }
      // (a label under the crosshair's time tag is left out)
      const hx = ui.hover && !ui.drag && ui.hover.x < plotW ? X(Math.floor((end - ((plotW - ui.hover.x) / cw) * step) / step) * step) + cw / 2 : null;
      ctx.textAlign = 'center';
      for (const t of tts) {
        const xx = X(t) + cw / 2;
        if (xx < 16 || xx > plotW - 16 || (hx != null && Math.abs(xx - hx) < 46)) continue;
        const [txt, bold] = tlabel(t, iv);
        ctx.font = bold ? `700 ${MONO}` : MONO; ctx.fillStyle = bold ? k.t1 : k.t2;
        ctx.fillText(txt, xx, base + axisB / 2);
      }
      ctx.font = MONO; ctx.textAlign = 'left';
      // candles + volume: each bar's geometry goes into one reusable buffer, then one path per colour and part straight on
      // the context (no Path2D or DOM objects made per draw: less garbage, so no collector pauses while trades stream in).
      // Zoomed far out (under 2 px a candle) one bar per pixel column. A period with no trade: a flat dash at the last close.
      const g = Math.min(1, ui.grow), shown = i0 + Math.ceil((i1 - i0) * g), F = 9;
      const vis = Math.ceil(plotW / Math.max(cw, 1)) + 4;
      const need = (cw >= 2 ? Math.max(shown - i0, 0) + vis : Math.min(shown - i0, Math.ceil(plotW))) + 4;
      if (GB.length < need * F) GB = new Float64Array((need + 64) * F);
      let nb = 0;
      const bar = (xc, w, o, h, l, cl, vb, vs) => {
        const k0 = nb++ * F, v = vb + (vs || 0);
        GB[k0] = xc; GB[k0 + 1] = cl >= o ? 1 : 0; GB[k0 + 2] = Math.round(Y(h)); GB[k0 + 3] = Math.round(Y(l)) + (w < 3 ? 1 : 0);
        GB[k0 + 4] = Math.round(Y(Math.max(o, cl))); GB[k0 + 5] = Math.round(Y(Math.min(o, cl)));
        GB[k0 + 6] = v > 0 ? Math.max(1, Math.round((v / L.vmax) * (L.volH - 2) * g)) : 0; GB[k0 + 7] = (vs == null ? cl >= o : vb >= vs) ? 1 : 0; GB[k0 + 8] = w;
      };
      const flats = [];
      if (cw >= 2) {
        let prev = i0 > 0 ? a[i0 - 1] : null;
        for (let i = i0; i < shown; i++) {
          const c = a[i];
          // the empty periods before this candle (a flat dash each, from the last close)
          if (prev) { for (let t = Math.max(prev[0] + step, Math.floor(start / step) * step); t < c[0] && t < end; t += step) flats.push(X(t) + cw / 2, val(prev[4])); }
          bar(X(c[0]) + cw / 2, cw, val(c[1]), val(c[2]), val(c[3]), val(c[4]), c[5], c[6]);
          prev = c;
        }
        // and after the last one, up to the live period
        if (g >= 1 && prev && shown === i1) for (let t = Math.max(prev[0] + step, Math.floor(start / step) * step); t <= L.liveT && t < end; t += step) flats.push(X(t) + cw / 2, val(prev[4]));
      } else {
        let cx = null, co = 0, ch = 0, cl = 0, cc = 0, cb = 0, cs = null;
        for (let i = i0; i < shown; i++) {
          const c = a[i], x = Math.floor(X(c[0]) + cw / 2);
          if (x !== cx) { if (cx != null) bar(cx + 0.5, 1, co, ch, cl, cc, cb, cs); cx = x; co = val(c[1]); ch = val(c[2]); cl = val(c[3]); cc = val(c[4]); cb = c[5]; cs = c[6]; continue; }
          ch = Math.max(ch, val(c[2])); cl = Math.min(cl, val(c[3])); cc = val(c[4]); cb += c[5];
          if (cs == null) { if (c[6] != null) cb += c[6]; } else if (c[6] == null) { cb += cs; cs = null; } else cs += c[6];
        }
        if (cx != null) bar(cx + 0.5, 1, co, ch, cl, cc, cb, cs);
      }
      // volume pane
      ctx.globalAlpha = 0.55;
      for (const u of [1, 0]) {
        ctx.beginPath();
        for (let j = 0; j < nb; j++) { const k0 = j * F; if (GB[k0 + 7] === u && GB[k0 + 6] > 0) { const vw = Math.max(1, Math.round(GB[k0 + 8] * 0.72)); ctx.rect(Math.round(GB[k0] - vw / 2), base - GB[k0 + 6], vw, GB[k0 + 6]); } }
        ctx.fillStyle = u ? k.up : k.dn; ctx.fill();
      }
      ctx.globalAlpha = 1;
      // price pane (clipped above the volume pane)
      ctx.save(); ctx.beginPath(); ctx.rect(0, 0, plotW, vy - 3); ctx.clip();
      if (flats.length) {
        const fw = cw >= 3 ? Math.max(1, Math.round(cw * 0.72)) : cw;
        ctx.beginPath();
        for (let j = 0; j < flats.length; j += 2) { const yy = Math.round(Y(flats[j + 1])); ctx.rect(Math.round(flats[j] - fw / 2), yy, fw, 1); }
        ctx.fillStyle = k.t2; ctx.globalAlpha = 0.75; ctx.fill(); ctx.globalAlpha = 1;
      }
      for (const u of [1, 0]) {
        ctx.beginPath();
        for (let j = 0; j < nb; j++) { const k0 = j * F; if (GB[k0 + 1] === u) { const xx = Math.round(GB[k0]) + 0.5; ctx.moveTo(xx, GB[k0 + 2]); ctx.lineTo(xx, GB[k0 + 3]); } }
        ctx.strokeStyle = u ? k.up : k.dn; ctx.stroke();
        ctx.beginPath();
        for (let j = 0; j < nb; j++) { const k0 = j * F; if (GB[k0 + 1] === u && GB[k0 + 8] >= 3) { const bw = Math.max(1, Math.round(GB[k0 + 8] * 0.72)); ctx.rect(Math.round(GB[k0] - bw / 2), GB[k0 + 4], bw, Math.max(1, GB[k0 + 5] - GB[k0 + 4])); } }
        ctx.fillStyle = u ? k.up : k.dn; ctx.fill();
      }
      // trade bubbles: the biggest visible trades, on their own period
      if (st.trades.length) {
        const key = `${st.tv}|${st.tf}|${Math.round(start)}|${Math.round(end)}`;
        if (ui.bubK !== key) {
          ui.bubK = key;
          const T = st.trades, kmax = cw < 2 ? 6 : 10, best = [];
          for (let j = lb(T, start), j1 = lb(T, end); j < j1; j++) {
            const tr = T[j];
            if (best.length === kmax && tr[2] <= best[kmax - 1][2]) continue;
            let p = best.length;
            while (p > 0 && best[p - 1][2] < tr[2]) p--;
            best.splice(p, 0, tr);
            if (best.length > kmax) best.pop();
          }
          ui.bub = best;
        }
        for (const sell of [false, true]) {
          ctx.beginPath();
          for (const tr of ui.bub) {
            if ((tr[3] === 'sell') !== sell) continue;
            const xx = X(Math.floor(tr[0] / step) * step) + cw / 2, yy = Y(val(tr[1])), r = Math.max(2, Math.min(5.5, Math.sqrt(tr[2]) / 8)) * g;
            if (r <= 0 || yy < top - 4 || yy > top + plotH + 4) continue;
            ctx.moveTo(xx + r, yy); ctx.arc(xx, yy, r, 0, Math.PI * 2);
          }
          const col = sell ? k.dn : k.up;
          ctx.globalAlpha = 0.2; ctx.fillStyle = col; ctx.fill(); ctx.globalAlpha = 0.7; ctx.strokeStyle = col; ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }
      ctx.restore();
      // the post's own time
      if (st.post && st.post >= start && st.post <= end) {
        const xx = Math.round(X(Math.floor(st.post / step) * step) + cw / 2) + 0.5;
        ctx.setLineDash([3, 3]); ctx.strokeStyle = k.brand; ctx.beginPath(); ctx.moveTo(xx, top); ctx.lineTo(xx, base); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = k.brand; ctx.font = '700 9.5px system-ui, sans-serif';
        const ty = top + plotH - 6, pw = UX('chartui.post');
        // (32 px of room for the English word; a longer translation asks for its own width)
        if (xx + Math.max(32, ctx.measureText(pw).width + 6) > plotW) { ctx.textAlign = 'right'; ctx.fillText(pw, xx - 4, ty); ctx.textAlign = 'left'; } else ctx.fillText(pw, xx + 4, ty);
        ctx.font = MONO;
      }
      // All while the coin's past is still being indexed (newest first): the chart starts at its first real candle and says
      // so, it never draws a flat line from the launch
      const lt = launchT();
      if (ui.rng === 'all' && isFinite(lt) && a[0][0] - lt > step * 2 && start <= a[0][0] + step) {
        const msg = UX('chartui.historyLoading', {when: ttag(a[0][0], Math.max(step, 3600e3))});
        ctx.font = '600 10.5px system-ui, sans-serif'; const w = ctx.measureText(msg).width + 12, x0 = Math.max(4, Math.min(plotW - w - 4, X(a[0][0])));
        ctx.globalAlpha = 0.9; ctx.fillStyle = k.bg; ctx.fillRect(x0, top + plotH - 22, w, 17); ctx.globalAlpha = 1;
        ctx.fillStyle = k.amber; ctx.fillText(msg, x0 + 6, top + plotH - 13); ctx.font = MONO;
      }
      // last price line + tag (held at the edge when the price is off the visible range)
      const last = a[a.length - 1];
      {
        const v = val(last[4]), yy = Math.round(Math.max(top, Math.min(top + plotH, Y(v)))) + 0.5, col = last[4] >= last[1] ? k.up : k.dn;
        ctx.setLineDash([2, 3]); ctx.strokeStyle = col; ctx.globalAlpha = 0.8; ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(plotW, yy); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
        ctx.fillStyle = col; ctx.fillRect(plotW + 1, yy - 8, padR - 2, 16);
        ctx.fillStyle = '#fff'; ctx.font = `700 ${MONO}`; ctx.fillText(fmt(v, m), plotW + 5, yy); ctx.font = MONO;
      }
      // crosshair: the period under the pointer, its time on the axis, its candle in the legend (a gap reads as the last close)
      const hv = ui.hover;
      let lc = last;
      if (hv && !ui.drag && hv.x < plotW) {
        const t = end - ((plotW - hv.x) / cw) * step, b = Math.floor(t / step) * step, xx = Math.round(X(b) + cw / 2) + 0.5;
        const j = lb(a, b);
        lc = a[j] && a[j][0] === b ? a[j] : j > 0 ? [b, a[j - 1][4], a[j - 1][4], a[j - 1][4], a[j - 1][4], 0, 0] : null;
        ctx.setLineDash([3, 3]); ctx.strokeStyle = k.t2; ctx.beginPath(); ctx.moveTo(xx, 0); ctx.lineTo(xx, base); ctx.moveTo(0, Math.round(hv.y) + 0.5); ctx.lineTo(plotW, Math.round(hv.y) + 0.5); ctx.stroke(); ctx.setLineDash([]);
        if (hv.y > top && hv.y < top + plotH) { ctx.fillStyle = k.t1; ctx.fillRect(plotW + 1, hv.y - 8, padR - 2, 16); ctx.fillStyle = k.bg; ctx.fillText(fmt(L.lo + (1 - (hv.y - top) / plotH) * (L.hi - L.lo), m), plotW + 5, hv.y); }
        const tag = ttag(b, step), tw = ctx.measureText(tag).width + 10, tx = Math.max(0, Math.min(plotW - tw, xx - tw / 2));
        ctx.fillStyle = k.t1; ctx.fillRect(tx, base, tw, axisB); ctx.fillStyle = k.bg; ctx.textAlign = 'center'; ctx.fillText(tag, tx + tw / 2, base + axisB / 2); ctx.textAlign = 'left';
      }
      // how to zoom, shown for a moment after a plain wheel over the chart
      if (performance.now() - ui.hint < 1600) {
        const msg = UX('chartui.zoomHint', {key: /Mac/.test(navigator.platform || '') ? '⌘' : 'Ctrl'});
        ctx.font = '600 11px system-ui, sans-serif'; const w = ctx.measureText(msg).width + 16;
        ctx.globalAlpha = 0.92; ctx.fillStyle = k.bg; ctx.fillRect(plotW / 2 - w / 2, top + plotH / 2 - 10, w, 20); ctx.globalAlpha = 1;
        ctx.fillStyle = k.t1; ctx.textAlign = 'center'; ctx.fillText(msg, plotW / 2, top + plotH / 2); ctx.textAlign = 'left'; ctx.font = MONO;
      }
      if (lc) { const v = lc[5] + (lc[6] || 0), vw = UX('chartui.vol'); ctx.font = MONO; ctx.fillStyle = k.t2; ctx.fillText(vw, 6, vy + 6); ctx.fillStyle = (lc[6] == null ? lc[4] >= lc[1] : lc[5] >= lc[6]) ? k.up : k.dn; ctx.fillText(volK(v), 6 + ctx.measureText(`${vw} `).width, vy + 6); }
      setLegend(lc);
      // a live chart on seconds keeps moving while nobody trades: the empty periods pass once a second
      if (st.live && step <= 30e3 && !ui.tick) ui.tick = setTimeout(() => { ui.tick = 0; if (ui.vis && !document.hidden) schedule(); }, 1000 - (Date.now() % 1000) + 5);
    }

    // who is trading it right now: buys against sells over the last 5 minutes (at most twice a second while live). Every
    // trade counts: the server's count (all trades, as of its answer) plus the live trades since; once the stream has run
    // 5 minutes, the live trades alone. (0.27.1 counted the chart's bubbles, a sample: "17 buys" for 160.)
    function paintFlow() {
      ui.flowAt = performance.now();
      const now = Date.now(), from = now - 300e3, add = (f, tr) => { if (tr[3] === 'sell') { f.sells++; f.sellUsd += tr[2]; } else { f.buys++; f.buyUsd += tr[2]; } };
      let f = {buys: 0, sells: 0, buyUsd: 0, sellUsd: 0};
      const G = st.log;
      if (st.live && st.liveSince && st.liveSince <= from) { for (let j = G.length - 1; j >= 0 && G[j][0] >= from - 30e3; j--) if (G[j][0] >= from) add(f, G[j]); }
      else if (st.flow && st.flowT > from) { f = {...st.flow}; for (let j = G.length - 1; j >= 0 && G[j][0] >= st.flowT - 30e3; j--) if (G[j][0] > st.flowT) add(f, G[j]); }
      else { const T = st.trades; for (let j = lb(T, from); j < T.length; j++) add(f, T[j]); }
      if (!f.buys && !f.sells && st.flow) f = st.flow;
      const nb = (x) => UT('chartui.buys', {n: String(x)}), ns = (x) => UT('chartui.sells', {n: String(x)}); // (a string count: no thousands comma, as before; the plural still follows it)
      let html;
      if (!f.buys && !f.sells) { const h = st.flow1h; html = h && (h.buys || h.sells) ? `<span>${UT('chartui.lastHour')}</span><b class="u">${nb(h.buys)}</b><i>${usdK(h.buyUsd)}</i><b class="d">${ns(h.sells)}</b><i>${usdK(h.sellUsd)}</i>` : ''; }
      else { const net = f.buyUsd - f.sellUsd; html = `<span>${UT('chartui.last5min')}</span><b class="u">${nb(f.buys)}</b><i>${usdK(f.buyUsd)}</i><b class="d">${ns(f.sells)}</b><i>${usdK(f.sellUsd)}</i><em class="${net >= 0 ? 'u' : 'd'}">${UT('chartui.net', {amount: `${net >= 0 ? '+' : '−'}${usdK(Math.abs(net))}`})}</em>`; }
      if (html !== ui.flowHtml) { ui.flowHtml = html; flowEl.innerHTML = html; }
    }
    // the live price (top) and the O H L C line on the chart; built once, a frame writes only the parts that changed
    let OL = null;
    // the text node itself is updated (setting textContent would make a new node every time)
    const put = (el, v) => { const t = el.firstChild; if (t && t.nodeType === 3) { if (t.data !== v) t.data = v; } else el.textContent = v; };
    function setLegend(c) {
      const m = mmode(), s = cur(), last = s?.c[s.c.length - 1];
      const pk = last ? `${last[4]}|${m}` : '';
      if (pk !== ui.legendKey) { ui.legendKey = pk; put(priceEl, last ? fmt(val(last[4]), m) : ''); }
      // 0.29.2: the price is the last trade's, and a coin nobody has traded for a while (a drained pool, a dead coin) still shows it: say how old it is, and drop LIVE
      const lt = st.trades.length ? st.trades[st.trades.length - 1][0] : 0, localIdle = lt > 0 ? Date.now() - lt : Infinity, serverIdle = st.lastTradeT > 0 ? Math.max(0, (st.asOf || st.gotAt) - st.lastTradeT) + (Date.now() - st.gotAt) : Infinity,
        idle = Math.min(localIdle, serverIdle), old = isFinite(idle) && idle > 15 * 60e3, ak = old ? `${Math.floor(idle / 6e4)}|${LANGK()}` : '';
      if (ak !== ui.ageKey) { ui.ageKey = ak; ageEl.textContent = old ? UX('fact.fact.last_trade', {at: FableI18n.ago(idle)}) : ''; liveEl.classList.toggle('stale', old); }
      const key = c ? `${c[0]}|${c[1]}|${c[2]}|${c[3]}|${c[4]}|${c[5]}|${c[6]}|${m}|${st.tf}` : '';
      if (key === ui.ohlcKey) return;
      ui.ohlcKey = key;
      if (!c) { ohlcEl.innerHTML = ''; OL = null; return; }
      if (!OL) {
        ohlcEl.innerHTML = `<div><span class="tf"></span>${UT('chartui.ohlc.o')}<i></i>${UT('chartui.ohlc.h')}<i></i>${UT('chartui.ohlc.l')}<i></i>${UT('chartui.ohlc.c')}<i></i><em></em></div>`;
        const i = ohlcEl.querySelectorAll('i');
        OL = {tf: ohlcEl.querySelector('.tf'), o: i[0], h: i[1], l: i[2], c: i[3], e: ohlcEl.querySelector('em'), cls: ''};
      }
      const d = val(c[4]) - val(c[1]), ch = c[1] ? c[4] / c[1] - 1 : 0, cls = d >= 0 ? 'u' : 'd';
      if (cls !== OL.cls) { OL.cls = cls; ohlcEl.classList.toggle('u', cls === 'u'); ohlcEl.classList.toggle('d', cls === 'd'); }
      put(OL.tf, `${TFL[st.tf] || st.tf || ''}`);
      put(OL.o, bare(val(c[1]), m)); put(OL.h, bare(val(c[2]), m)); put(OL.l, bare(val(c[3]), m)); put(OL.c, bare(val(c[4]), m));
      const dd = Math.abs(d), dtxt = dd >= 1000 || m === 'mc' ? bare(dd, 'mc') : bare(dd, 'p');
      put(OL.e, `${d >= 0 ? '+' : '−'}${dtxt} (${ch >= 0 ? '+' : ''}${(ch * 100).toFixed(2)}%)`);
    }

    // first paint: candles grow in from the left
    const animateIn = () => {
      ui.played = true;
      if (matchMedia('(prefers-reduced-motion: reduce)').matches || document.hidden || !ui.vis || globalThis.__fableStill) { ui.grow = 1; schedule(); return; }
      const t0 = performance.now();
      const step = (now) => { ui.grow = Math.min(1, (now - t0) / 600); draw(); if (ui.grow < 1) ui.anim = requestAnimationFrame(step); };
      ui.anim = requestAnimationFrame(step);
      // a window the browser treats as hidden pauses animation frames: never leave the chart empty
      setTimeout(() => { if (ui.grow < 1) { cancelAnimationFrame(ui.anim); ui.grow = 1; schedule(); } }, 800);
    };
    const show = (tf) => {
      if (st.tf !== tf) { ui.cw = null; ui.end = null; ui.bubK = ''; }
      st.tf = tf; ui.pend = null;
      paintCtl();
      if (!ui.played) animateIn(); else schedule();
    };
    // a timeframe with no candles of its own yet: rolled up from a finer one (or built from the trades), until the server answers
    const provisional = (tf) => {
      const step = STEP[tf], have = st.series.get(tf);
      if (have?.c.length) return have;
      let best = null;
      for (const s of st.series.values()) if (s.c.length && s.step < step && step % s.step === 0 && (!best || s.c[0][0] < best.c[0][0])) best = s;
      const c = best ? rollup(best.c, step) : st.trades.length ? fromTrades(st.trades, step) : [];
      if (!c.length) return null;
      const s = {tf, step, c, done: false, at: 0, syn: true};
      st.series.set(tf, s);
      return s;
    };
    const pick = (tf, o = {}) => {
      st.auto = false; st.want = tf;
      ui.span = o.span ?? null; ui.rng = o.rng ?? null;
      const s = provisional(tf);
      if (s) show(tf); else { ui.pend = tf; paintCtl(); }
      // a timeframe kept live needs no read; anything else asks the server (its answer replaces the stand-in); 1D is asked
      // as 4h and rolled up
      if (!s || s.syn || !st.live || Date.now() - s.at > 60e3 || o.from) opts.onTf?.(FETCH[tf] || tf, o.from ? {from: o.from} : {});
    };
    // All: the coin's whole life, from launch, at the timeframe that fits it; a range: its span at its timeframe
    const allView = () => {
      const s0 = cur();
      const lt = launchT(), bornT = isFinite(lt) ? lt : s0?.c.length ? s0.c[0][0] : Date.now();
      ui.cw = null; ui.end = null;
      pick(lifeTf(Date.now() - bornT), {span: Infinity, rng: 'all', from: bornT});
    };
    const rangeView = (key) => {
      const r = RANGES.find(([k]) => k === key);
      if (!r) return;
      const lt = launchT(), age = isFinite(lt) ? Date.now() - lt : Infinity;
      if (age < r[1]) { allView(); return; } // younger than the range: its whole life
      ui.cw = null; ui.end = null;
      pick(r[2], {span: r[1], rng: key, from: Math.floor((Date.now() - r[1]) / STEP[r[2]]) * STEP[r[2]]});
    };
    // older candles when the view reaches past the first loaded one (one read at a time; none once the launch is in)
    const needOlder = (start) => {
      const s = cur();
      if (!s || s.done || s.syn || !s.c.length || !opts.onRange || Date.now() - ui.older < 8000 || Date.now() - ui.failAt < 10e3) return;
      const first = s.c[0][0];
      if (start >= first) return;
      ui.older = Date.now();
      // twice the missing span, at least 300 candles, at most 1,500 (one server page), never before the launch
      const lt = launchT(), floor = isFinite(lt) ? Math.floor(lt / s.step) * s.step : 0;
      const from = Math.max(floor, first - s.step * 1500, Math.floor(Math.min(start - (first - start), first - s.step * 300) / s.step) * s.step);
      opts.onRange({tf: s.tf, from, to: first});
    };
    const zoomAt = (x, f) => {
      const L = ui.L;
      if (!L) return;
      const t = L.end - ((L.plotW - x) / L.cw) * L.step, cw = Math.max(0.2, Math.min(40, L.cw * f));
      const end = Math.max(L.first + L.step * 3, t + ((L.plotW - x) / cw) * L.step);
      ui.span = null; ui.rng = null; ui.cw = cw; ui.end = end >= L.edge ? null : end;
      paintCtl(); schedule();
      needOlder(end - (L.plotW / cw) * L.step);
    };
    const panTo = (end0, dx) => {
      const L = ui.L;
      if (!L) return;
      const end = Math.max(L.first + L.step * 3, Math.min(L.edge, end0 - (dx / L.cw) * L.step));
      ui.span = null; ui.rng = null; ui.cw = L.cw; ui.end = end >= L.edge ? null : end;
      paintCtl(); schedule();
      needOlder(end - (L.plotW / L.cw) * L.step);
    };

    // controls
    host.querySelectorAll('[data-tf]').forEach((b) => (b.onclick = (e) => { e.stopPropagation(); ui.cw = null; ui.end = null; pick(b.dataset.tf); }));
    host.querySelectorAll('[data-rng]').forEach((b) => (b.onclick = (e) => { e.stopPropagation(); rangeView(b.dataset.rng); }));
    const allBtn = host.querySelector('[data-all]');
    allBtn.onclick = (e) => { e.stopPropagation(); allView(); };
    const modeBtn = host.querySelector('[data-mode]');
    modeBtn.onclick = (e) => { e.stopPropagation(); st.mode = st.mode === 'mc' ? 'p' : 'mc'; st.userMode = true; ui.ohlcKey = ''; paintCtl(); schedule(); };
    const paintCtl = () => {
      host.querySelectorAll('[data-tf]').forEach((b) => b.classList.toggle('on', b.dataset.tf === (ui.pend || st.tf)));
      host.querySelectorAll('[data-rng]').forEach((b) => {
        b.classList.toggle('on', ui.rng === b.dataset.rng);
        // a range longer than the coin's life is its whole life: All says it
        const lt = launchT(), r = RANGES.find(([k]) => k === b.dataset.rng);
        b.hidden = isFinite(lt) && r && Date.now() - lt < r[1] / 2;
      });
      allBtn.classList.toggle('on', ui.rng === 'all');
      modeBtn.textContent = st.mode === 'mc' ? UX('chartui.mode.mc') : UX('chartui.mode.price'); modeBtn.classList.toggle('on', true);
    };
    const paintLive = () => { liveEl.classList.toggle('on', !!st.live); liveEl.classList.toggle('late', !!(st.live && st.late)); liveB.textContent = st.live && st.late ? UX('chartui.delayed') : UX('chartui.live'); };
    paintCtl(); paintLive();
    // a language change: the words set once at mount are set again; the canvas and the O H L C line follow on the next paint
    const offLang = FableI18n.onChange?.(() => {
      allBtn.textContent = UX('chartui.all'); allBtn.title = UX('chartui.allTitle'); modeBtn.title = UX('chartui.modeTitle');
      paintCtl(); paintLive();
      OL = null; ui.ohlcKey = ''; ui.flowHtml = null;
      paintFlow(); schedule();
    });
    const at =(e) => { const r = cv.getBoundingClientRect(); return {x: e.clientX - r.left, y: e.clientY - r.top}; };
    // the wheel is only taken while the pointer is on the chart (Ctrl / pinch zooms, sideways pans), so the page scrolls freely past it
    const onWheel = (e) => {
      if (e.ctrlKey || e.metaKey) { e.preventDefault(); zoomAt(at(e).x, Math.exp(-e.deltaY * (e.deltaMode ? 0.06 : e.ctrlKey && Math.abs(e.deltaY) < 50 ? 0.01 : 0.002))); return; }
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) { e.preventDefault(); if (ui.L) panTo(ui.end ?? ui.L.edge, -e.deltaX); return; }
      if (performance.now() - ui.hint > 1600) { ui.hint = performance.now(); schedule(); setTimeout(schedule, 1650); }
    };
    cv.addEventListener('pointerenter', () => { if (!ui.wheel) { cv.addEventListener('wheel', onWheel, {passive: false, signal: ac.signal}); ui.wheel = true; } }, on);
    cv.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      ui.pins.set(e.pointerId, at(e));
      try { cv.setPointerCapture(e.pointerId); } catch { /* gone */ }
      if (ui.pins.size === 1 && ui.L) ui.drag = {x: e.clientX, end: ui.end ?? ui.L.edge, moved: false};
      if (ui.pins.size === 2 && ui.L) { const [p, q] = [...ui.pins.values()]; ui.drag = null; ui.pinch = {d: Math.hypot(p.x - q.x, p.y - q.y) || 1, cw: ui.L.cw, x: (p.x + q.x) / 2}; }
    }, on);
    cv.addEventListener('pointermove', (e) => {
      const pt = at(e);
      ui.hover = pt;
      if (ui.pins.has(e.pointerId)) {
        ui.pins.set(e.pointerId, pt);
        if (ui.pinch && ui.pins.size === 2 && ui.L) { const [p, q] = [...ui.pins.values()]; zoomAt(ui.pinch.x, (Math.hypot(p.x - q.x, p.y - q.y) / ui.pinch.d) * (ui.pinch.cw / ui.L.cw)); return; }
        if (ui.drag) { const dx = e.clientX - ui.drag.x; if (Math.abs(dx) > 3) ui.drag.moved = true; if (ui.drag.moved) { cv.classList.add('drag'); panTo(ui.drag.end, dx); return; } }
      }
      schedule();
    }, on);
    const lift = (e) => { ui.pins.delete(e.pointerId); if (ui.pins.size < 2) ui.pinch = null; if (!ui.pins.size) { ui.drag = null; cv.classList.remove('drag'); } schedule(); };
    cv.addEventListener('pointerup', lift, on);
    cv.addEventListener('pointercancel', lift, on);
    cv.addEventListener('pointerleave', () => { ui.hover = null; if (ui.wheel) { cv.removeEventListener('wheel', onWheel); ui.wheel = false; } schedule(); }, on);
    cv.addEventListener('dblclick', (e) => { e.stopPropagation(); ui.cw = null; ui.end = null; ui.span = null; ui.rng = null; paintCtl(); schedule(); }, on);
    cv.addEventListener('click', (e) => e.stopPropagation(), on);
    document.addEventListener('visibilitychange', () => { if (!document.hidden && ui.dirty) schedule(); }, on);
    const ro = new ResizeObserver(size); ro.observe(wrap);
    // off screen: data still lands, drawing waits until the chart is seen again
    const io = typeof IntersectionObserver === 'function' ? new IntersectionObserver(([e]) => { ui.vis = e.isIntersecting; if (ui.vis && ui.dirty) schedule(); }, {rootMargin: '120px'}) : null;
    io?.observe(wrap);
    size();
    if (opts.restore && st.tf) { paintFlow(); schedule(); }

    // a /v1/candles answer: the series for its timeframe (live candles newer than it and older candles already read are kept)
    const setData = (d) => {
      if (!d) return;
      if (d.tf && !STEP[d.tf] && d.step > 0) STEP[d.tf] = +d.step; // a timeframe this build has no button for
      const tf = STEP[d.tf] ? d.tf : st.tf || '1m', step = STEP[tf];
      let c = sane((Array.isArray(d.candles) ? d.candles : []).filter((x) => Array.isArray(x) && isFinite(x[0]) && x[4] > 0).map((x) => norm(x, step)).sort((x, y) => x[0] - y[0]));
      const trs = (Array.isArray(d.trades) ? d.trades : []).filter((x) => Array.isArray(x) && x[1] > 0 && isFinite(x[0])).map(trade).sort((x, y) => x[0] - y[0]);
      if (!c.length && trs.length) c = fromTrades(trs, step);
      open(c[c.length - 1]);
      const prev = st.series.get(tf);
      if (prev?.c.length && c.length && !prev.syn) {
        const f = c[0][0], l = c[c.length - 1][0];
        c = prev.c.filter((x) => x[0] < f).concat(c, prev.c.filter((x) => x[0] > l));
      } else if (prev?.c.length && !c.length) c = prev.c;
      const done = !!(d.firstT && c.length && c[0][0] <= d.firstT) || !!(prev?.done && prev.c.length && c.length && c[0][0] <= prev.c[0][0]);
      st.series.set(tf, {tf, step, c, done, at: Date.now()});
      // bubbles: the server's trades, then the live ones after them; a live trade the server already counted is skipped
      const lastT = trs.length ? trs[trs.length - 1][0] : -Infinity;
      st.srv = new Set(trs.slice(-400).map((x) => `${x[0]}|${x[1]}`));
      for (const x of trs) if (x[4]) st.seen.add(x[4]);
      st.trades = trs.concat(st.trades.filter((x) => x[0] > lastT)).slice(-MAXT);
      st.tv++;
      // the server's own newest trade of the coin (candles `lastTradeT`, any trade including unpriced dust) and its clock (`asOf`): the age of the price is measured on one clock
      if (d.lastTradeT > 0) { st.lastTradeT = +d.lastTradeT; st.asOf = d.asOf > 0 ? +d.asOf : 0; st.gotAt = Date.now(); }
      if (d.supply > 0) { st.supply = +d.supply; if (!st.userMode) st.mode = 'mc'; }
      if (!st.supply && st.mode === 'mc') st.mode = 'p';
      if (d.firstT > 0) st.firstT = +d.firstT;
      if (d.flow) { st.flow = d.flow.m5 || null; st.flow1h = d.flow.h1 || null; st.flowT = +d.asOf || Date.now(); }
      st.waiting = !c.length && !st.trades.length && !!d.live;
      // a coin younger than 5 minutes opens on 1 s candles
      const lt = launchT(), bornT = isFinite(lt) ? lt : c[0]?.[0] || trs[0]?.[0];
      let ask = null;
      if (st.auto && !st.want && bornT && Date.now() - bornT < FRESH && tf !== '1s') { st.want = '1s'; ask = '1s'; }
      if (!st.want) st.want = tf;
      st.auto = false;
      if (st.want !== tf) {
        const ws = STEP[st.want], have = st.series.get(st.want);
        // finer than the server sent (no 1 s candles from it): built from its trades and the live ones
        if (ws < step && (!have || have.syn)) {
          const all = trs.concat(st.log.filter((x) => x[0] > lastT)).sort((x, y) => x[0] - y[0]);
          if (all.length) st.series.set(st.want, {tf: st.want, step: ws, c: fromTrades(all, ws), done: false, at: Date.now(), syn: true});
        } else if (ws > step && ws % step === 0 && (!have || have.syn)) st.series.set(st.want, {tf: st.want, step: ws, c: rollup(c, ws), done, at: Date.now(), syn: true});
      }
      paintFlow();
      show(st.series.get(st.want)?.c.length ? st.want : tf);
      if (ask) opts.onTf?.(ask, {auto: true});
    };
    // an older range (opts.onRange answer): candles before the first one held, in front
    const merge = (d, q = {}) => {
      ui.older = 0;
      const s = st.series.get(q.tf || d?.tf);
      if (!s) return;
      if (!d) { ui.failAt = Date.now(); return; }
      if (d.tf !== s.tf || !Array.isArray(d.candles)) { s.done = true; return; }
      const first = s.c.length ? s.c[0][0] : Infinity;
      const older = d.candles.filter((x) => Array.isArray(x) && x[0] < first && x[4] > 0).map((x) => norm(x, s.step)).sort((x, y) => x[0] - y[0]);
      if (!older.length) { s.done = true; schedule(); return; }
      s.c = older.concat(s.c);
      sane(s.c);
      if (s.c.length > MAXC * 2) s.c.splice(0, s.c.length - MAXC * 2);
      if (d.firstT && older[0][0] <= d.firstT) s.done = true;
      const trs = (Array.isArray(d.trades) ? d.trades : []).filter((x) => Array.isArray(x) && x[1] > 0 && x[0] < (st.trades[0]?.[0] ?? Infinity)).map(trade).sort((x, y) => x[0] - y[0]);
      if (trs.length) { st.trades = trs.concat(st.trades); if (st.trades.length > MAXT * 2) st.trades.splice(0, st.trades.length - MAXT * 2); st.tv++; }
      schedule();
    };
    // a live message: trade / tick ({p, t, usd, side, tx}), {type:'status', live, delayed}, {type:'void', tx}
    const push = (m) => {
      const p = +m?.p, t = +m.t || Date.now();
      if (!(p > 0) || !isFinite(p)) return;
      const tx = m.tx ? String(m.tx) : '';
      if (!tx && Date.now() - t > 120e3) return; // a tick older than 2 minutes is a price somebody kept, not a live one
      if (tx) { if (st.seen.has(tx)) return; st.seen.add(tx); if (st.seen.size > 8000) st.seen = new Set([...st.seen].slice(-4000)); }
      else if (st.lastTick && st.lastTick[0] === t && st.lastTick[1] === p) return; // the same tick again (the 10 s poll)
      const tr = [t, p, +m.usd > 0 ? +m.usd : 0, m.side === 'sell' ? 'sell' : 'buy', tx];
      if (!tx) st.lastTick = tr;
      ui.q.push(tr);
      if (document.hidden || ui.q.length > 1000) { flushQ(); ui.dirty = true; } else schedule();
    };
    const voidTx = (tx) => {
      ui.q = ui.q.filter((x) => x[4] !== tx);
      const n = st.trades.length;
      st.trades = st.trades.filter((x) => x[4] !== tx);
      if (st.trades.length !== n) st.tv++;
      const j = st.log.findIndex((x) => x[4] === tx);
      if (j >= 0) {
        const tr = st.log.splice(j, 1)[0];
        for (const s of st.series.values()) { const b = Math.floor(tr[0] / s.step) * s.step; unfold(s.c, b, st.log.filter((x) => x[0] >= b && x[0] < b + s.step).sort((x, y) => x[0] - y[0]), tr); }
        paintFlow();
      }
      schedule();
    };
    const since = (v) => { if (v && !st.live) st.liveSince = Date.now(); if (!v) st.liveSince = 0; };
    const setLive = (v) => { since(!!v); st.live = !!v; if (!v) st.late = false; paintLive(); schedule(); };
    const live = (m) => {
      if (!m || typeof m !== 'object') return;
      if (m.type === 'batch' && Array.isArray(m.m)) { for (const x of m.m) live(x); return; }
      if (m.type === 'status') { since(!!m.live); st.live = !!m.live; st.late = !!m.delayed; paintLive(); schedule(); return; }
      if (m.type === 'void') { if (m.tx) voidTx(String(m.tx)); return; }
      if (m.type === 'verdict') return; // 0.28: a verdict change is the card's business, not a trade
      push(m);
    };

    return {
      setData, merge, push, live, setLive,
      setStatus: (m) => live({...m, type: 'status'}),
      void: (tx) => voidTx(String(tx)),
      save() { flushQ(); return st; },
      get tf() { return st.tf; },
      destroy() { offLang?.(); ro.disconnect(); io?.disconnect(); ac.abort(); cancelAnimationFrame(ui.anim); cancelAnimationFrame(ui.raf); clearTimeout(ui.tick); ui.raf = 1; ui.tick = 1; },
    };
  }
  globalThis.FableChart = {mount, fmt, axisFmt, lifeTf, STEP, sane};
})();
