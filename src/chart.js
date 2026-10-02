// Fable candlestick chart (owner: "Axiom level, candles, live"). A classic content script: exposes globalThis.FableChart.
// Canvas, device-pixel sharp, theme colours from the card's CSS variables. Market cap axis by default (price on toggle),
// small prices written the trench way ($0.0₄479), volume split buy / sell, dashed last-price line with its tag,
// crosshair with an O H L C V legend, trade bubbles sized by dollar value, a marker at the post's own time, and a live
// candle that moves as trades stream in. No library, nothing fetched.
(() => {
  const SUB = '₀₁₂₃₄₅₆₇₈₉';
  const small = (v) => {
    const s = v.toFixed(20).replace(/0+$/, '');
    const m = s.match(/^0\.(0+)(\d{1,4})/);
    return m && m[1].length >= 3 ? `0.0${String(m[1].length).split('').map((d) => SUB[d]).join('')}${m[2]}` : v.toPrecision(3);
  };
  const fmt = (v, mode) => {
    if (v == null || !isFinite(v)) return '';
    const a = Math.abs(v);
    if (mode === 'mc' || a >= 1000) return a >= 1e9 ? `$${(v / 1e9).toFixed(2)}B` : a >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : a >= 1e3 ? `$${(v / 1e3).toFixed(1)}K` : `$${v.toFixed(0)}`;
    return a >= 1 ? `$${v.toFixed(2)}` : a >= 0.01 ? `$${v.toFixed(4)}` : `$${small(v)}`;
  };
  const hhmm = (t, sec) => { const d = new Date(t); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}${sec ? `:${String(d.getSeconds()).padStart(2, '0')}` : ''}`; };
  const usdK = (v) => (v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(1)}K` : `$${Math.round(v)}`);
  const TFS = ['15s', '1m', '5m', '15m', '1h'];
  const STEP = {'15s': 15e3, '1m': 60e3, '5m': 300e3, '15m': 900e3, '1h': 3600e3};

  function mount(host, opts) {
    const st = {candles: [], trades: [], supply: null, mode: 'mc', tf: opts.tf && STEP[opts.tf] ? opts.tf : '1m', hover: null, live: false, grow: 0, post: opts.postTime || null, anim: null, waiting: false, flow: null};
    host.innerHTML = `<div class="fc">
      <div class="fc-top"><div class="fc-legend"></div><div class="fc-ctl"><span class="fc-live"><i></i>LIVE</span>${TFS.map((t) => `<button data-tf="${t}">${t}</button>`).join('')}<button data-mode>MC</button></div></div>
      <div class="fc-wrap"><canvas></canvas></div><div class="fc-flow"></div></div>`;
    const cv = host.querySelector('canvas'), ctx = cv.getContext('2d'), wrap = host.querySelector('.fc-wrap');
    const legend = host.querySelector('.fc-legend'), liveEl = host.querySelector('.fc-live'), flowEl = host.querySelector('.fc-flow');
    const css = (n, d) => getComputedStyle(host).getPropertyValue(n).trim() || d;
    let W = 0, H = 0, dpr = 1;
    const size = () => { dpr = window.devicePixelRatio || 1; W = wrap.clientWidth; H = wrap.clientHeight; cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); cv.style.width = `${W}px`; cv.style.height = `${H}px`; draw(); };
    const val = (p) => (st.mode === 'mc' && st.supply ? p * st.supply : p);

    function layout() {
      const padR = 62, padB = 16, top = 6, volH = Math.round(H * 0.18);
      const plotW = W - padR, plotH = H - padB - top - volH - 4;
      const cw = Math.max(5, Math.min(14, plotW / 70));
      const n = Math.max(10, Math.floor(plotW / cw));
      const vis = st.candles.slice(-n);
      let lo = Infinity, hi = -Infinity, vmax = 1;
      for (const c of vis) { lo = Math.min(lo, val(c[3])); hi = Math.max(hi, val(c[2])); vmax = Math.max(vmax, c[5] + c[6]); }
      if (!isFinite(lo)) { lo = 0; hi = 1; }
      if (hi === lo) { hi *= 1.01; lo *= 0.99; }
      const pad = (hi - lo) * 0.08; lo = Math.max(lo - pad, lo * 0.5); hi += pad;
      const off = plotW - vis.length * cw; // right-aligned, newest candle at the axis
      return {padR, padB, top, volH, plotW, plotH, cw, vis, lo, hi, vmax, off,
        x: (i) => off + (i + 0.5) * cw, y: (v) => top + (1 - (v - lo) / (hi - lo)) * plotH, vy: H - padB - volH};
    }

    function draw() {
      if (!W || !H) return;
      if (!st.candles.length) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
        ctx.fillStyle = css('--t2', '#71767b'); ctx.font = '600 12px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(st.waiting ? 'Live: waiting for the first trade' : '', W / 2, H / 2); ctx.textAlign = 'left';
        setLegend(null); return;
      }
      const up = css('--green', '#1fc28a'), dn = css('--red', '#f4497c'), t2 = css('--t2', '#71767b'), line = css('--line', '#2f3336'), t1 = css('--t1', '#e7e9ea'), bg = css('--bg', '#000');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      const L = layout();
      const {vis, cw, x, y} = L;
      // grid + axis labels
      ctx.font = '10.5px ui-monospace, SFMono-Regular, Consolas, monospace';
      ctx.textBaseline = 'middle';
      for (let k = 0; k <= 4; k++) {
        const v = L.lo + ((L.hi - L.lo) * k) / 4, yy = Math.round(y(v)) + 0.5;
        ctx.strokeStyle = line; ctx.globalAlpha = 0.5; ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(L.plotW, yy); ctx.stroke(); ctx.globalAlpha = 1;
        ctx.fillStyle = t2; ctx.fillText(fmt(v, st.mode === 'mc' && st.supply ? 'mc' : 'p'), L.plotW + 6, yy);
      }
      const every = Math.max(1, Math.round(70 / cw));
      ctx.textAlign = 'center';
      vis.forEach((c, i) => { if ((vis.length - 1 - i) % every === 0) { ctx.fillStyle = t2; ctx.fillText(hhmm(c[0], st.tf === '15s'), x(i), H - L.padB / 2); } });
      ctx.textAlign = 'left';
      // volume
      const g = Math.min(1, st.grow);
      vis.forEach((c, i) => {
        const v = c[5] + c[6]; if (!v) return;
        const h = (v / L.vmax) * L.volH * g;
        ctx.fillStyle = c[5] >= c[6] ? up : dn; ctx.globalAlpha = 0.28;
        ctx.fillRect(Math.round(x(i) - cw * 0.35), Math.round(H - L.padB - h), Math.max(1, Math.round(cw * 0.7)), Math.round(h));
      });
      ctx.globalAlpha = 1;
      // candles: they grow in from the left on first paint
      const shown = Math.ceil(vis.length * g);
      vis.forEach((c, i) => {
        if (i >= shown) return;
        const o = val(c[1]), hi = val(c[2]), lo = val(c[3]), cl = val(c[4]);
        const col = cl >= o ? up : dn;
        ctx.strokeStyle = col; ctx.fillStyle = col;
        const xx = Math.round(x(i)) + 0.5;
        ctx.beginPath(); ctx.moveTo(xx, Math.round(y(hi))); ctx.lineTo(xx, Math.round(y(lo))); ctx.stroke();
        const y1 = Math.round(y(Math.max(o, cl))), y2 = Math.round(y(Math.min(o, cl)));
        ctx.fillRect(Math.round(x(i) - cw * 0.36), y1, Math.max(1, Math.round(cw * 0.72)), Math.max(1, y2 - y1));
      });
      // trade bubbles (the bigger trades only), on their candle
      if (st.trades.length && vis.length) {
        const t0 = vis[0][0], step = vis.length > 1 ? vis[1][0] - vis[0][0] : 60e3;
        const big = st.trades.filter((tr) => tr[0] >= t0).sort((a, b) => b[2] - a[2]).slice(0, 12);
        for (const tr of big) {
          let i = vis.findIndex((cc) => cc[0] > tr[0]) - 1; if (i < 0) i = tr[0] >= vis[vis.length - 1][0] ? vis.length - 1 : 0;
          const r = Math.max(2.5, Math.min(9, Math.sqrt(tr[2]) / 6));
          ctx.beginPath(); ctx.arc(x(i), y(val(tr[1])), r * g, 0, Math.PI * 2);
          ctx.fillStyle = tr[3] === 'sell' ? dn : up; ctx.globalAlpha = 0.35; ctx.fill(); ctx.globalAlpha = 0.9; ctx.strokeStyle = tr[3] === 'sell' ? dn : up; ctx.lineWidth = 1; ctx.stroke(); ctx.globalAlpha = 1;
        }
      }
      // the post's own time
      if (st.post && vis.length) {
        const i = st.post < vis[0][0] ? -1 : Math.max(0, vis.findIndex((cc) => cc[0] > st.post) - 1 < 0 ? vis.length - 1 : vis.findIndex((cc) => cc[0] > st.post) - 1);
        if (i >= 0) {
          const xx = Math.round(x(i)) + 0.5;
          ctx.setLineDash([3, 3]); ctx.strokeStyle = css('--brand', '#5b7fff'); ctx.beginPath(); ctx.moveTo(xx, L.top); ctx.lineTo(xx, L.vy); ctx.stroke(); ctx.setLineDash([]);
          ctx.fillStyle = css('--brand', '#5b7fff'); ctx.font = '700 9.5px system-ui, sans-serif'; ctx.fillText('POST', Math.min(xx + 4, L.plotW - 28), L.top + 8);
          ctx.font = '10.5px ui-monospace, SFMono-Regular, Consolas, monospace';
        }
      }
      // last price line + tag
      const last = vis[vis.length - 1];
      if (last) {
        const v = val(last[4]), yy = Math.round(y(v)) + 0.5, col = last[4] >= last[1] ? up : dn;
        ctx.setLineDash([2, 3]); ctx.strokeStyle = col; ctx.globalAlpha = 0.8; ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(L.plotW, yy); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
        ctx.fillStyle = col; ctx.fillRect(L.plotW + 1, yy - 8, L.padR - 2, 16);
        ctx.fillStyle = bg; ctx.font = '700 10.5px ui-monospace, SFMono-Regular, Consolas, monospace'; ctx.fillText(fmt(v, st.mode === 'mc' && st.supply ? 'mc' : 'p'), L.plotW + 5, yy);
        ctx.font = '10.5px ui-monospace, SFMono-Regular, Consolas, monospace';
      }
      // crosshair
      const hv = st.hover;
      if (hv && vis.length) {
        const i = Math.max(0, Math.min(vis.length - 1, Math.floor((hv.x - L.off) / cw)));
        const xx = Math.round(x(i)) + 0.5;
        ctx.setLineDash([3, 3]); ctx.strokeStyle = t2; ctx.beginPath(); ctx.moveTo(xx, 0); ctx.lineTo(xx, H - L.padB); ctx.moveTo(0, Math.round(hv.y) + 0.5); ctx.lineTo(L.plotW, Math.round(hv.y) + 0.5); ctx.stroke(); ctx.setLineDash([]);
        const v = L.lo + (1 - (hv.y - L.top) / L.plotH) * (L.hi - L.lo);
        if (hv.y > L.top && hv.y < L.vy) { ctx.fillStyle = line; ctx.fillRect(L.plotW + 1, hv.y - 8, L.padR - 2, 16); ctx.fillStyle = t1; ctx.fillText(fmt(v, st.mode === 'mc' && st.supply ? 'mc' : 'p'), L.plotW + 5, hv.y); }
        setLegend(vis[i]);
      } else setLegend(last);
    }

    // who is trading it right now: buys against sells over the last 5 minutes (updated by every live trade)
    function paintFlow() {
      const now = Date.now(), m5 = st.trades.filter((tr) => tr[0] >= now - 300e3);
      const f = m5.length || !st.flow ? m5.reduce((a, tr) => { if (tr[3] === 'sell') { a.sells++; a.sellUsd += tr[2]; } else { a.buys++; a.buyUsd += tr[2]; } return a; }, {buys: 0, sells: 0, buyUsd: 0, sellUsd: 0}) : st.flow;
      const n = (k, w) => `${k} ${w}${k === 1 ? '' : 's'}`;
      if (!f.buys && !f.sells) { const h = st.flow1h; flowEl.innerHTML = h && (h.buys || h.sells) ? `<span>Last hour</span><b class="u">${n(h.buys, 'buy')}</b><i>${usdK(h.buyUsd)}</i><b class="d">${n(h.sells, 'sell')}</b><i>${usdK(h.sellUsd)}</i>` : ''; return; }
      const net = f.buyUsd - f.sellUsd;
      flowEl.innerHTML = `<span>Last 5 min</span><b class="u">${n(f.buys, 'buy')}</b><i>${usdK(f.buyUsd)}</i><b class="d">${n(f.sells, 'sell')}</b><i>${usdK(f.sellUsd)}</i><em class="${net >= 0 ? 'u' : 'd'}">net ${net >= 0 ? '+' : '−'}${usdK(Math.abs(net))}</em>`;
    }
    function setLegend(c) {
      if (!c) { legend.innerHTML = ''; return; }
      const m = st.mode === 'mc' && st.supply ? 'mc' : 'p';
      const ch = c[1] ? c[4] / c[1] - 1 : 0;
      const cls = ch >= 0 ? 'u' : 'd';
      legend.innerHTML = `<b class="${cls}">${fmt(val(c[4]), m)}</b><span>O <i>${fmt(val(c[1]), m)}</i> H <i>${fmt(val(c[2]), m)}</i> L <i>${fmt(val(c[3]), m)}</i></span><span>Vol <i>$${Math.round(c[5] + c[6]).toLocaleString('en-US')}</i></span><em class="${cls}">${ch >= 0 ? '+' : ''}${(ch * 100).toFixed(2)}%</em>`;
    }

    const animateIn = () => {
      const t0 = performance.now();
      const step = (now) => { st.grow = Math.min(1, (now - t0) / 700); draw(); if (st.grow < 1) st.anim = requestAnimationFrame(step); };
      if (matchMedia('(prefers-reduced-motion: reduce)').matches || document.hidden) { st.grow = 1; draw(); return; }
      st.anim = requestAnimationFrame(step);
      // a window the browser treats as hidden pauses animation frames: never leave the chart empty
      setTimeout(() => { if (st.grow < 1) { cancelAnimationFrame(st.anim); st.grow = 1; draw(); } }, 900);
    };

    // controls
    host.querySelectorAll('[data-tf]').forEach((b) => (b.onclick = (e) => { e.stopPropagation(); st.tf = b.dataset.tf; paintCtl(); opts.onTf?.(st.tf); }));
    const modeBtn = host.querySelector('[data-mode]');
    modeBtn.onclick = (e) => { e.stopPropagation(); st.mode = st.mode === 'mc' ? 'p' : 'mc'; paintCtl(); draw(); };
    const paintCtl = () => { host.querySelectorAll('[data-tf]').forEach((b) => b.classList.toggle('on', b.dataset.tf === st.tf)); modeBtn.textContent = st.mode === 'mc' ? 'MC' : 'Price'; modeBtn.classList.toggle('on', true); };
    paintCtl();
    cv.addEventListener('pointermove', (e) => { const r = cv.getBoundingClientRect(); st.hover = {x: e.clientX - r.left, y: e.clientY - r.top}; draw(); });
    cv.addEventListener('pointerleave', () => { st.hover = null; draw(); });
    cv.addEventListener('click', (e) => e.stopPropagation());
    const ro = new ResizeObserver(size); ro.observe(wrap);
    size();

    return {
      setData(d) {
        st.candles = d.candles || []; st.trades = d.trades || []; st.supply = d.supply || null;
        st.flow = d.flow?.m5 || null; st.flow1h = d.flow?.h1 || null;
        st.waiting = !st.candles.length && !!d.live;
        if (d.tf && STEP[d.tf]) st.tf = d.tf;
        if (!st.supply && st.mode === 'mc') st.mode = 'p';
        paintCtl(); paintFlow();
        st.grow = 0; animateIn();
      },
      // a live trade: extend or roll the current candle, add its bubble
      push(tr) {
        if (!tr?.p) return;
        const step = STEP[st.tf] || 60e3;
        st.waiting = false;
        if (st.grow < 1) { st.grow = 1; cancelAnimationFrame(st.anim); }
        const b = Math.floor(tr.t / step) * step;
        const lastC = st.candles[st.candles.length - 1];
        if (lastC && lastC[0] === b) { lastC[2] = Math.max(lastC[2], tr.p); lastC[3] = Math.min(lastC[3], tr.p); lastC[4] = tr.p; if (tr.usd) lastC[tr.side === 'sell' ? 6 : 5] += tr.usd; }
        else st.candles.push([b, lastC ? lastC[4] : tr.p, Math.max(tr.p, lastC ? lastC[4] : tr.p), Math.min(tr.p, lastC ? lastC[4] : tr.p), tr.p, tr.side !== 'sell' && tr.usd ? tr.usd : 0, tr.side === 'sell' && tr.usd ? tr.usd : 0]);
        if (tr.usd) st.trades.push([tr.t, tr.p, tr.usd, tr.side]);
        if (st.trades.length > 400) st.trades.splice(0, st.trades.length - 400);
        draw(); paintFlow();
        host.querySelector('.fc-legend b')?.classList.add('flash');
        setTimeout(() => host.querySelector('.fc-legend b')?.classList.remove('flash'), 400);
      },
      setLive(on) { st.live = on; liveEl.classList.toggle('on', !!on); },
      get tf() { return st.tf; },
      destroy() { ro.disconnect(); cancelAnimationFrame(st.anim); },
    };
  }
  globalThis.FableChart = {mount, fmt};
})();
