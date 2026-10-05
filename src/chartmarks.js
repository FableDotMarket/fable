// Fable chart markers (0.30.1, Push B lane chartintel): the PROVEN bad-actor trades of a coin on its candle chart, the way GMGN marks
// "dev sold" and Axiom marks insider trades. A classic content script loaded after src/i18n.js and before src/chart.js: it exposes
// globalThis.FableChartMarks; src/chart.js calls it (attach at mount, draw inside its draw(), set when the data arrives).
// Data: intel GET /v1/markers?address=&chain=robinhood (src/markers.js on intel; the data API's /v1/inv/markers), asked by the
// background ({type: 'markers'}) only while the remote switch on.chartMarkers is true. Every row is a trade (or a liquidity removal)
// of a wallet one of Fable's engines proved, with its tx:
//   {ev: [[t ms, kind, side 'b'|'s'|'x', n trades, % of supply, ETH, USD, [tx, ...]], ...], txUrl: 'https://<explorer>/tx/'}
//   kind: dev (the creator's own sells), tie (wallets tied to the creator, sells), snp (the operation's own wallets, a self-snipe),
//         bun (linked launch wallets of a bundle), grp (a tied insider group), lp (the creator took liquidity out)
// Look (chart standard: GMGN / Axiom): one small round badge per candle, kind and side (a letter on the kind's colour), a sell above the
// candle's high, a buy under its low, a pull above; several kinds on one candle stack outwards. Rows are put in the candle that holds
// their second, so every timeframe (1s to 1D) shows them on the right candle; zoomed out, badges closer than one badge width merge.
// Hover (or tap) a badge: a tooltip with the fact (who, side, % of supply, ETH, trades), the time, and the tx links.
// Nothing is guessed here: no row, no badge. Words come from FableI18n (keys chartui.mk.*), English fallback per key.
(() => {
  if (globalThis.FableChartMarks) return;
  const KINDS = {
    dev: {letter: 'D', color: '#f5a524', pri: 0},
    tie: {letter: 'D', color: '#f5a524', pri: 1},
    snp: {letter: 'S', color: '#e5489b', pri: 2},
    bun: {letter: 'B', color: '#9b6dff', pri: 3},
    grp: {letter: 'I', color: '#22b8cf', pri: 4},
    lp: {letter: 'L', color: '#f0443a', pri: 5},
  };
  const R = 6.5, GAP = 2.5, MERGE = 2 * R + 1; // badge radius, space between stacked badges, the closest two badges of one lane may be
  const TX = /^0x[0-9a-f]{64}$/;
  const lb = (a, t) => { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m][0] < t) lo = m + 1; else hi = m; } return lo; };
  const I18 = () => globalThis.FableI18n;
  const say = (k, p, en) => { try { const v = I18()?.tx?.(k, p); if (v && v !== k) return v; } catch { /* fallback */ } return en.replace(/\{(\w+)\}/g, (_, x) => (p?.[x] ?? '')); };
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  /** Pure: a /v1/markers answer -> sorted, checked rows [t, kind, side, n, pct, eth, usd, txs] (anything off is dropped) */
  function clean(d) {
    const out = [];
    for (const r of Array.isArray(d?.ev) ? d.ev : []) {
      if (!Array.isArray(r) || r.length < 8 || !KINDS[r[1]] || !['b', 's', 'x'].includes(r[2]) || (r[2] === 'x') !== (r[1] === 'lp')) continue;
      const t = +r[0], txs = (Array.isArray(r[7]) ? r[7] : []).map(String).filter((h) => TX.test(h));
      if (!(t > 1.6e12) || !txs.length) continue;
      out.push([t, r[1], r[2], Math.max(1, +r[3] || 1), Math.max(0, +r[4] || 0), Math.max(0, +r[5] || 0), Math.max(0, +r[6] || 0), txs]);
    }
    return out.sort((a, b) => a[0] - b[0]);
  }

  /**
   * Pure: the rows inside [start, end) put into candles of `step` ms (the chart's own bucket: floor(t / step) * step), one group per
   * (candle, kind, side). -> [{b, kind, side, n, pct, eth, usd, txs: [up to 3], rows}] in time order
   */
  function group(rows, step, start = -Infinity, end = Infinity) {
    const out = [], at = new Map();
    for (let i = Math.max(0, lb(rows, Math.floor(start / step) * step)); i < rows.length && rows[i][0] < end; i++) {
      const r = rows[i], b = Math.floor(r[0] / step) * step, key = `${b}|${r[1]}|${r[2]}`;
      let g = at.get(key);
      if (!g) { g = {b, kind: r[1], side: r[2], n: 0, pct: 0, eth: 0, usd: 0, t0: r[0], t1: r[0], tx: [], rows: 0}; at.set(key, g); out.push(g); }
      g.n += r[3]; g.pct += r[4]; g.eth += r[5]; g.usd += r[6]; g.t1 = r[0]; g.rows++;
      for (const h of r[7]) g.tx.push([h, r[4]]);
    }
    for (const g of out) {
      const seen = new Set();
      g.txs = g.tx.sort((x, y) => y[1] - x[1]).map((x) => x[0]).filter((h) => !seen.has(h) && seen.add(h)).slice(0, 3);
      delete g.tx;
    }
    return out;
  }

  /** Pure: groups of one lane (kind, side) closer than `px` on screen merged into the first (zoomed out, badges never overlap) */
  function merge(groups, xOf, px = MERGE) {
    const lanes = new Map(), out = [];
    for (const g of groups) {
      const lane = `${g.kind}|${g.side}`, x = xOf(g.b), prev = lanes.get(lane);
      if (prev && x - prev.x < px) {
        prev.n += g.n; prev.pct += g.pct; prev.eth += g.eth; prev.usd += g.usd; prev.t1 = g.t1; prev.rows += g.rows; prev.bs.push(g.b);
        prev.txs = [...new Set([...prev.txs, ...g.txs])].slice(0, 3);
        continue;
      }
      const m = {...g, x, bs: [g.b]};
      lanes.set(lane, m);
      out.push(m);
    }
    return out;
  }

  const pctTxt = (p) => (p >= 10 ? `${Math.round(p)}%` : p >= 1 ? `${p.toFixed(1).replace(/\.0$/, '')}%` : p >= 0.01 ? `${p.toFixed(2)}%` : '<0.01%');
  const ethTxt = (e) => (e >= 100 ? Math.round(e).toLocaleString('en-US') : e >= 1 ? e.toFixed(2) : e >= 0.01 ? e.toFixed(3).replace(/0$/, '') : '<0.01');
  // every sentence a literal key (dev/i18n-keys.test.mjs reads tx('...') calls), English as the fallback per key
  const tx = (k, p, en) => say(k, p, en);
  const SAY = {
    'dev|s': (p) => tx('chartui.mk.dev_sold', p, 'Creator sold {pct} of supply'),
    'tie|s': (p) => tx('chartui.mk.tie_sold', p, 'Wallets tied to the creator sold {pct} of supply'),
    'snp|b': (p) => tx('chartui.mk.snp_bought', p, "The operation's wallets bought {pct} of supply"),
    'snp|s': (p) => tx('chartui.mk.snp_sold', p, "The operation's wallets sold {pct} of supply"),
    'bun|b': (p) => tx('chartui.mk.bun_bought', p, 'Bundle wallets bought {pct} of supply'),
    'bun|s': (p) => tx('chartui.mk.bun_sold', p, 'Bundle wallets sold {pct} of supply'),
    'grp|b': (p) => tx('chartui.mk.grp_bought', p, 'Insider wallets bought {pct} of supply'),
    'grp|s': (p) => tx('chartui.mk.grp_sold', p, 'Insider wallets sold {pct} of supply'),
    'lp|x': (p) => (p.eth ? tx('chartui.mk.lp_removed_eth', p, 'Creator removed {eth} ETH of liquidity') : tx('chartui.mk.lp_removed', p, 'Creator removed liquidity')),
  };
  // the full stop and the join of the language: zh, ja end with 。 and a clause that starts with a full-width comma or bracket is not spaced; th has no full stop
  const stop = () => { let l = 'en'; try { l = I18()?.lang?.() || 'en'; } catch { /* en */ } return l === 'zh-CN' || l === 'zh-TW' || l === 'ja' ? '。' : l === 'th' ? '' : '.'; };
  const more = (s, c) => (/^[，（]/.test(c) ? s + c : `${s} ${c}`);
  /** Pure: the tooltip's sentence for a group (house voice: the fact, no hedging) */
  function sentence(g) {
    const k = `${g.kind}|${g.side}`;
    if (!SAY[k]) return '';
    if (k === 'lp|x') return `${SAY[k]({eth: g.eth > 0 ? ethTxt(g.eth) : ''})}${stop()}`;
    let s = SAY[k]({pct: pctTxt(g.pct)});
    if (g.eth > 0) s = more(s, tx('chartui.mk.forEth', {eth: ethTxt(g.eth)}, 'for {eth} ETH'));
    else if (g.usd > 0) s = more(s, tx('chartui.mk.forUsd', {usd: g.usd >= 1000 ? `${(g.usd / 1000).toFixed(1)}K` : String(Math.round(g.usd))}, 'for ${usd}'));
    return `${s}${stop()}`;
  }
  const p2 = (n) => String(n).padStart(2, '0');
  const hms = (t) => { const d = new Date(t); return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`; };

  /**
   * attach(wrap, canvas) -> {set(d), draw(ctx, view), clear(), destroy(), get count()}
   * view = {L (chart.js layout()), X(t), Y(v), a (candles), val(p) (price -> axis value), dark}
   */
  function attach(wrap, cv) {
    let rows = [], txUrl = '', boxes = [], pinned = null, shown = null, key = '', cache = [];
    // inert until a proven row arrives: with the switch off (or a coin with nothing proven) no node is added to the card and no listener is set,
    // so the card is the 0.30.0 card
    let tip = null, ac = null;
    const hitAt = (x, y) => { for (let i = boxes.length - 1; i >= 0; i--) { const b = boxes[i]; if ((x - b.x) ** 2 + (y - b.y) ** 2 <= (R + 3) ** 2) return b; } return null; };
    const pos = (e) => { const r = cv.getBoundingClientRect(); return {x: e.clientX - r.left, y: e.clientY - r.top}; };
    const show = (b) => {
      if (!tip || shown === b?.g) return;
      shown = b?.g || null;
      if (!b) { tip.hidden = true; return; }
      const g = b.g, kc = KINDS[g.kind];
      const when = g.t0 === g.t1 ? hms(g.t0) : `${hms(g.t0)}-${hms(g.t1)}`;
      const trades = g.kind === 'lp' ? tx('chartui.mk.pulls', {n: String(g.n)}, g.n === 1 ? '1 removal' : '{n} removals') : tx('chartui.mk.trades', {n: String(g.n)}, g.n === 1 ? '1 trade' : '{n} trades');
      const links = txUrl ? g.txs.map((h) => `<a href="${esc(txUrl + h)}" target="_blank" rel="noopener">${esc(`${h.slice(0, 6)}…${h.slice(-4)}`)}</a>`).join('') : '';
      tip.innerHTML = `<div class="h"><i style="background:${kc.color}">${kc.letter}</i><b>${esc(sentence(g))}</b></div><div class="m">${esc(when)} · ${esc(trades)}</div>${links ? `<div class="l">${links}</div>` : ''}`;
      tip.hidden = false;
      const W = wrap.clientWidth, H = wrap.clientHeight, tw = tip.offsetWidth, th = tip.offsetHeight;
      let lx = b.x - tw / 2, ly = b.side === 'b' ? b.y - R - 6 - th : b.y + R + 6;
      if (ly < 2) ly = b.y + R + 6;
      if (ly + th > H - 2) ly = Math.max(2, b.y - R - 6 - th);
      tip.style.left = `${Math.round(Math.max(2, Math.min(W - tw - 2, lx)))}px`;
      tip.style.top = `${Math.round(ly)}px`;
    };
    const arm = () => {
      if (tip) return;
      ac = new AbortController();
      const on = {signal: ac.signal};
      tip = document.createElement('div');
      tip.className = 'fc-mk-tip';
      tip.hidden = true;
      wrap.appendChild(tip);
      cv.addEventListener('pointermove', (e) => { if (pinned) return; const p = pos(e); show(hitAt(p.x, p.y)); cv.classList.toggle('fc-mk-hot', !!shown); }, on);
      cv.addEventListener('pointerleave', (e) => { if (!pinned && !tip.contains(e.relatedTarget)) show(null); cv.classList.remove('fc-mk-hot'); }, on);
      // a tap (touch) or a click on a badge keeps its tooltip open (its links can be tapped); a tap anywhere else closes it
      cv.addEventListener('click', (e) => { const p = pos(e), b = hitAt(p.x, p.y); pinned = b ? (pinned?.g === b.g ? null : b) : null; shown = null; show(pinned || b); }, on);
      tip.addEventListener('pointerleave', (e) => { if (!pinned && e.relatedTarget !== cv) show(null); }, on);
      tip.addEventListener('click', (e) => e.stopPropagation(), on);
    };

    function draw(ctx, {L, X, Y, a, val}) {
      boxes = [];
      if (!rows.length || !L || !a?.length) { if (!pinned) show(null); return; }
      const {step, start, end, cw, plotW, top, vy} = L;
      const k = `${rows.length}|${step}|${Math.round(start)}|${Math.round(end)}|${cw}|${a.length}|${a[a.length - 1][2]}|${a[a.length - 1][3]}|${L.lo}|${L.hi}`;
      if (k !== key) {
        key = k;
        const xOf = (b) => X(b) + cw / 2;
        const gs = merge(group(rows, step, start - step, end), xOf, Math.max(MERGE, cw));
        // each badge's anchor: its candle's high (a sell, a pull) or low (a buy); a period with no candle: the last close before it
        cache = [];
        for (const g of gs.sort((p, q) => p.x - q.x || KINDS[p.kind].pri - KINDS[q.kind].pri)) {
          if (g.x < -R || g.x > plotW + R) continue;
          let hi = -Infinity, lo = Infinity;
          for (const b of g.bs) {
            const j = lb(a, b), c = a[j] && a[j][0] === b ? a[j] : a[Math.max(0, j - 1)];
            if (!c) continue;
            const h = c === a[j] ? c[2] : c[4], l = c === a[j] ? c[3] : c[4];
            if (val(h) > hi) hi = val(h);
            if (val(l) < lo) lo = val(l);
          }
          if (!isFinite(hi)) continue;
          // a badge never covers another: one that would touch a badge already placed (another kind, a candle next to it) steps outwards;
          // nothing proven is ever left out (with no free place it takes the first)
          // (a wick past the pane's edge: the badge starts at the edge)
          const up = g.side !== 'b', clamp = (y) => Math.max(top + R - 2, Math.min(vy - R - 4, y)), base = clamp(up ? Y(hi) - R - 4 : Y(lo) + R + 4);
          const D = 2 * R + GAP, free = (y) => !cache.some((c) => Math.abs(c.x - g.x) < 2 * R + 1 && Math.abs(c.y - y) < 2 * R + 1);
          // outwards from the candle first, then (pinned at the pane's edge) back towards it; the 1st free place wins
          const places = [0, 1, 2, 3, 4].map((k) => clamp(up ? base - k * D : base + k * D)).concat([1, 2, 3, 4, 5, 6].map((k) => clamp(up ? base + k * D : base - k * D)));
          const y = places.find(free) ?? places[0];
          cache.push({x: g.x, y, side: g.side, g});
        }
      }
      ctx.save();
      ctx.beginPath(); ctx.rect(0, 0, plotW, vy - 2); ctx.clip();
      ctx.font = '700 8.5px system-ui, -apple-system, "Segoe UI", sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      for (const b of cache) {
        const kc = KINDS[b.g.kind], hot = shown === b.g || pinned?.g === b.g;
        ctx.beginPath(); ctx.arc(b.x, b.y, hot ? R + 1 : R, 0, Math.PI * 2);
        ctx.fillStyle = kc.color; ctx.globalAlpha = 0.95; ctx.fill(); ctx.globalAlpha = 1;
        ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.stroke();
        // the side, as GMGN shows it: a tick pointing at the candle (down from a sell above it, up from a buy below it)
        const d = b.side === 'b' ? -1 : 1;
        ctx.beginPath(); ctx.moveTo(b.x - 2.5, b.y + d * (R - 0.5)); ctx.lineTo(b.x + 2.5, b.y + d * (R - 0.5)); ctx.lineTo(b.x, b.y + d * (R + 2.5)); ctx.closePath(); ctx.fill();
        ctx.fillStyle = '#fff'; ctx.fillText(kc.letter, b.x, b.y + 0.5);
        boxes.push(b);
      }
      ctx.restore();
      if (pinned) { const still = boxes.find((b) => b.g.b === pinned.g.b && b.g.kind === pinned.g.kind && b.g.side === pinned.g.side); if (still) { pinned = still; shown = null; show(still); } else { pinned = null; show(null); } }
    }
    return {
      set(d) { rows = clean(d); if (rows.length) arm(); txUrl = /^https:\/\/[^\s"<>]+\/tx\/$/.test(String(d?.txUrl || '')) ? d.txUrl : ''; key = ''; pinned = null; show(null); },
      clear() { rows = []; key = ''; boxes = []; cache = []; pinned = null; show(null); },
      draw,
      get count() { return boxes.length; },
      get boxes() { return boxes.map((b) => ({x: b.x, y: b.y, kind: b.g.kind, side: b.g.side, b: b.g.b, bs: b.g.bs, n: b.g.n, pct: b.g.pct, eth: b.g.eth, txs: b.g.txs})); },
      hover(x, y) { show(hitAt(x, y)); return tip.hidden ? null : tip.textContent; },
      destroy() { ac?.abort(); tip?.remove(); tip = null; },
    };
  }

  globalThis.FableChartMarks = {attach, clean, group, merge, sentence, KINDS};
})();
