// Fable content script (isolated world). Parses X's own GraphQL data, finds tweets on screen,
// asks the background worker for verdicts, and renders pills / cards / stamps under each tweet.
(() => {
  const {t: TT, tx: TX, tr: TR, fact: FX, raw: RAW, num: NUM, date: DATE, ago: AGO, lang: LANG} = FableI18n; // src/i18n.js (loaded before this file)
  const FC = globalThis.FableCallout || null; // src/callout.js (loaded before this file): call-outs, and which verdict labels describe the author
  // tickers: X's cashtag entities, plus those in the text of a non-ASCII post (capture.js); a page without capture.js keeps X's list
  const cashtagsOf = (text, symbols = []) => globalThis.FableCapture?.cashtagsFrom?.(text, symbols) ?? symbols.map((x) => String(x?.text || '').toUpperCase());
  const foldW = (x) => globalThis.FableCapture?.foldWidth?.(x) ?? x;
  // a date the server wrote in English ("Jul 2, 2026", "Mar 2022") in the active language's own format; anything else stays as it came
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const trDate = (v) => {
    const m = String(v ?? '').match(/^([A-Z][a-z]{2}) (?:(\d{1,2}), )?(\d{4})$/), mon = m ? MONTHS.indexOf(m[1]) : -1;
    return mon < 0 ? String(v ?? '') : DATE(Date.UTC(+m[3], mon, +(m[2] || 1), 12), {timeZone: 'UTC', year: 'numeric', month: 'short', ...(m[2] ? {day: 'numeric'} : {})});
  };
  const TWEETS = new Map(); // id -> parsed tweet
  const VERDICTS = new Map(); // id -> verdict
  const PENDING = new Set();
  const RECHECKS = new Map(); // id -> times asked again (a new contract still being read on-chain)
  const USER_IDS = new Map(); // lowercase handle -> rest id (for the profile panel)
  // every switch in the popup's Settings tab lands here (chrome.storage.sync); DEFAULTS mirrors popup.js
  const DEFAULTS = {enabled: true, showRug: true, showKol: true, showLegit: true, showNeutral: true, fade: true, stamps: true, cards: true, tokenMarks: true, profilePanel: true, trendingPanel: true, intel: true};
  let settings = {...DEFAULTS};
  let css = '';
  // one parsed stylesheet shared by every Fable shadow root (was the full 77 KB ui.css re-parsed per pill, card, stamp
  // and token row, up to 4 times a post); a plain <style> only where constructable sheets are refused
  let SHEET = null, sheetOk = true;
  // remote config (src/config.js default, merged with intel's /v1/config by the background worker): data only
  let CFG = globalThis.FableConfig?.DEFAULT || {};
  const on = (k) => CFG.on?.[k] !== false;
  const themeCss = () => `${css}\n${typeof CFG.theme?.css === 'string' ? CFG.theme.css : ''}`;
  const styleFor = (root) => {
    if (sheetOk && css) {
      try {
        if (!SHEET) { SHEET = new CSSStyleSheet(); SHEET.replaceSync(themeCss()); }
        if (root.adoptedStyleSheets[0] !== SHEET) root.adoptedStyleSheets = [SHEET];
        return '';
      } catch { sheetOk = false; }
    }
    return `<style>${themeCss()}</style>`;
  };
  // a new config restyles every card already on screen at once (they all share the one sheet)
  const useConfig = (c) => {
    if (c?.v !== 1 || !globalThis.FableConfig) return;
    CFG = globalThis.FableConfig.merge(c);
    FableI18n.setOverrides(CFG.i18n);
    if (SHEET) { try { SHEET.replaceSync(themeCss()); } catch { /* keep the old style */ } }
  };
  chrome.storage.local.get('fableConfig', (s) => useConfig(s?.fableConfig));
  chrome.storage.onChanged.addListener((c, area) => { if (area === 'local' && c.fableConfig) useConfig(c.fableConfig.newValue); });

  // styles must be in hand before anything renders, or the first posts get unstyled (giant) icons
  fetch(chrome.runtime.getURL('src/ui.css')).then((r) => r.text()).then((t) => { css = t; chipPass(); scan(); });
  chrome.storage.sync.get(DEFAULTS, (s) => (settings = s));
  const redraw = () => {
    document.querySelectorAll('[data-fable-host], [data-fable-profile], [data-fable-trend]').forEach((n) => n.remove());
    document.querySelectorAll('article[data-fable-id]').forEach((a) => { a.removeAttribute('data-fable-id'); a.removeAttribute('data-fable-done'); a.removeAttribute('data-fable-fade'); });
    profileFor = null;
    OWNERS.clear();
    COINS.clear();
    EXPANDED.clear();
    KEEP.clear();
    scan();
  };
  FableI18n.onChange(() => { if (css) redraw(); });
  chrome.storage.onChanged.addListener((c, area) => {
    const shown = Object.keys(DEFAULTS).filter((k) => k !== 'enabled' && c[k]);
    if (area === 'sync' && shown.length) { for (const k of shown) settings[k] = c[k].newValue; redraw(); }
    if (c.enabled) {
      settings.enabled = c.enabled.newValue;
      if (!settings.enabled) document.querySelectorAll('[data-fable-host]').forEach((n) => n.remove());
      document.querySelectorAll('article[data-fable-id]').forEach((a) => { a.removeAttribute('data-fable-id'); a.removeAttribute('data-fable-done'); });
      scan();
    }
    if (c.apiUrl) {
      VERDICTS.clear();
      document.querySelectorAll('[data-fable-host]').forEach((n) => n.remove());
      document.querySelectorAll('article[data-fable-id]').forEach((a) => { a.removeAttribute('data-fable-id'); a.removeAttribute('data-fable-done'); });
      scan();
    }
  });

  /* ---------------- 1. Parse X's GraphQL (schema-tolerant walker) ---------------- */

  const userFrom = (u) => {
    if (!u || !u.rest_id) return null;
    const l = u.legacy || {};
    const core = u.core || {};
    return {
      id: u.rest_id,
      handle: core.screen_name || l.screen_name,
      name: core.name || l.name,
      avatar: (u.avatar?.image_url || l.profile_image_url_https || '').replace('_normal', '_bigger'),
      followers: u.relationship_counts?.followers ?? l.followers_count,
      following: u.relationship_counts?.following ?? l.friends_count,
      verified: !!(u.is_blue_verified || u.verification?.verified || l.verified),
      vtype: u.verification?.verified_type || l.verified_type || null,
      created_at: core.created_at || l.created_at,
      description: (u.profile_bio?.description ?? l.description ?? '').slice(0, 300),
    };
  };

  const tweetFrom = (t) => {
    if (t.__typename === 'TweetWithVisibilityResults') t = t.tweet;
    if (!t || !t.rest_id || !t.legacy) return null;
    const l = t.legacy;
    const author = userFrom(t.core?.user_results?.result);
    // a long post (note tweet) carries its own full text and entities; legacy.entities cover only the first 280 characters
    const note = t.note_tweet?.note_tweet_results?.result;
    const ents = (k) => note?.entity_set?.[k] || l.entities?.[k] || [];
    const text = note?.text || l.full_text || '';
    const q = t.quoted_status_result?.result;
    return {
      id: t.rest_id,
      text: text.replace(/https:\/\/t\.co\/\S+$/g, '').trim(),
      author,
      created_at: l.created_at,
      cashtags: cashtagsOf(text, ents('symbols')),
      urls: ents('urls').map((u) => u.expanded_url),
      mentions: ents('user_mentions').map((m) => m.screen_name),
      metrics: {likes: l.favorite_count, retweets: l.retweet_count, replies: l.reply_count, views: t.views?.count},
      quoted: q ? tweetFrom(q) : null,
    };
  };

  const walk = (node, out, depth = 0) => {
    if (!node || typeof node !== 'object' || depth > 40) return;
    if (Array.isArray(node)) {
      for (const n of node) walk(n, out, depth + 1);
      return;
    }
    if ((node.__typename === 'Tweet' || node.__typename === 'TweetWithVisibilityResults') && (node.rest_id || node.tweet)) {
      const t = tweetFrom(node);
      if (t) out.tweets.push(t);
    } else if (node.__typename === 'User' && node.rest_id) {
      const u = userFrom(node);
      if (u) { out.users.push(u); if (u.handle) USER_IDS.set(u.handle.toLowerCase(), u.id); }
    }
    for (const k in node) if (node[k] && typeof node[k] === 'object') walk(node[k], out, depth + 1);
  };

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || !e.data.__fable) return;
    const out = {tweets: [], users: []};
    walk(e.data.data, out);
    for (const t of out.tweets) {
      TWEETS.set(t.id, t);
      if (t.quoted) TWEETS.set(t.quoted.id, t.quoted);
    }
    // posts with a contract get their card data read before they reach the screen
    for (const t of out.tweets) if (/0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44}/.test(t.text || '')) prefetch(t, false);
    const payload = {op: e.data.op, url: e.data.url, tweets: out.tweets, users: out.users};
    if (out.tweets.length || out.users.length) chrome.runtime.sendMessage({type: 'ingest', payload}).catch(() => {});
    scan();
  });

  /* ---------------- 2. Find tweets on screen ---------------- */

  const idOf = (article) => {
    const a = [...article.querySelectorAll('a[href*="/status/"]')].find((x) => x.querySelector('time'));
    const m = a && a.getAttribute('href').match(/\/status\/(\d+)/);
    return m ? m[1] : null;
  };

  // Fallback when X served the tweet from cache and we never saw its JSON.
  const domTweet = (article, id) => {
    const text = article.querySelector('[data-testid="tweetText"]')?.innerText || '';
    const userLink = article.querySelector('[data-testid="User-Name"] a[href^="/"]');
    const handle = userLink?.getAttribute('href').slice(1);
    return {id, text, author: {handle}, cashtags: cashtagsOf(text, []), urls: []};
  };

  // debounced, but never starved: X changes the page every few ms while scrolling, and a pure 60 ms trailing debounce
  // kept pushing the scan back until the scroll stopped. Now a post is picked up within ~150 ms even mid-scroll.
  let scanTimer = null, scanSince = 0;
  const scan = () => {
    const now = performance.now();
    if (!scanTimer) scanSince = now;
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => { scanTimer = null; doScan(); }, now - scanSince >= (CFG.timing?.scanMaxWaitMs ?? 90) ? 0 : (CFG.timing?.scanDebounceMs ?? 60));
  };

  // start the card's reads the moment a post is known (X's data usually arrives before the post is on screen), not
  // after its verdict: the contract, the author's history and the first coin's candles, shared with mountIntel by key
  const PREFETCHED = new Set();
  const prefetch = (tw, withHistory = true) => {
    if (!settings.intel || !on('prefetch') || !on('cards') || !tw?.id || PREFETCHED.has(tw.id)) return;
    PREFETCHED.add(tw.id);
    const cas = fableOfficialPost(tw) ? [] : (globalThis.FableCapture?.extractAddresses?.(tw.text || '', tw.urls || []) || []).slice(0, CFG.limits?.contractsPerPost ?? 3); // ($FABLE: no coin card, nothing to fetch for one)
    for (const ca of cas) intelGet(`c:${ca.chain}:${ca.address}`, {type: 'contract', address: ca.address, chain: ca.chain, fresh: false, tweet: tw.id});
    // 0.30.0 (a post that names its coin by $TICKER only waited for the post's verdict before the coin was even looked up): the ticker's coin is read
    // now too, under the same key mountIntel asks for (its first non-major cashtag, the chain the text hints at)
    if (!cas.length && !fableOfficialPost(tw)) {
      const tick = (tw.cashtags || []).map((x) => String(x).toUpperCase()).find((x) => !MAJORS.has(x));
      if (tick) { const chain = globalThis.FableCapture?.chainHintFromText?.(tw.text || '') || null; intelGet(`t:${tick}:${chain || ''}`, {type: 'contract', symbol: tick, chain, fresh: false, tweet: tw.id}); }
    }
    if (cas[0]?.address) candlesFor(cas[0].address, cas[0].chain);
    const h = tw.author?.handle;
    if ((withHistory || cas.length) && h && /^[A-Za-z0-9_]{1,15}$/.test(h)) intelGet(`h:${h.toLowerCase()}`, {type: 'history', handle: h});
  };

  // Fable Rep shows our own number only: lines about backers, ratings or stakes that an older API still sends are
  // dropped, and a rep verdict keeps only smart-account faces (never the backers')
  const REP_TRACE = /backed by|rate[sd]? them|people rate|positive|negative review|vouch|ETH staked|staking|verified human/i;
  const cleanRep = (v) => {
    if (!v || typeof v !== 'object') return v;
    const out = {...v};
    if (out.detail && REP_TRACE.test(out.detail)) delete out.detail;
    if (out.byRep && !(out.card?.people?.length)) delete out.avatars;
    if (out.card?.type === 'lines' && Array.isArray(out.card.lines)) out.card = {...out.card, lines: out.card.lines.filter((l) => !REP_TRACE.test(String(l)))};
    if (Array.isArray(out.card?.rows)) out.card = {...out.card, rows: out.card.rows.map((r) => (r && r.kind === 'rep' ? {kind: 'rep', rep: r.rep, ...(r.handle ? {handle: r.handle} : {})} : r))};
    return out;
  };

  const doScan = () => {
    if (!settings.enabled || !css) return;
    for (const n of document.querySelectorAll('[data-fable-host]')) if (!n.closest('article[data-testid="tweet"]')) n.remove();
    const need = [];
    for (const article of document.querySelectorAll('article[data-testid="tweet"]')) {
      const id = idOf(article);
      if (!id) continue;
      if (article.getAttribute('data-fable-id') === id && article.querySelector('[data-fable-host]')) continue;
      article.setAttribute('data-fable-id', id);
      article.removeAttribute('data-fable-done');
      article.querySelectorAll('[data-fable-host]').forEach((n) => n.remove());
      const v = VERDICTS.get(id);
      if (v) render(article, v);
      else if (!PENDING.has(id)) {
        PENDING.add(id);
        const tw = TWEETS.get(id) || domTweet(article, id);
        need.push(tw);
        prefetch(tw);
        stubChip(article, tw);
      }
    }
    profilePanel();
    if (on('sidebar')) trendPanel();
    // the pill first, from the rules in this extension (instant); the API verdict follows and upgrades it in place.
    // The API used to gate everything: 0.3 s warm, 11 s cold (2026-09-30), and the card waited behind it.
    if (need.length && on('quickVerdict')) chrome.runtime.sendMessage({type: 'quick', tweets: need}).then((res) => {
      for (const v of res?.verdicts || []) {
        if (VERDICTS.has(v.id)) continue;
        VERDICTS.set(v.id, {...calmOwn(cleanRep(v)), provisional: true});
        // a verdict the API gave before (kept across restarts) shows at once; a fresh local guess waits a moment for the
        // API's answer, so the pill says the right thing the first time instead of changing its words after showing
        const show = () => {
          const cur = VERDICTS.get(v.id);
          const a = cur?.provisional && document.querySelector(`article[data-fable-id="${v.id}"]`);
          if (!a) return;
          // the card has been mounting since the first scan (below): the words go onto the chip, in place
          if (a.getAttribute('data-fable-done') === cur.id && a.querySelector('[data-fable-host="ui"]:not([data-stub])')) { const sv = scopeFor(a, cur); if (!sv.hidden) paintVerdict(a, sv); } else { a.removeAttribute('data-fable-done'); render(a, cur); }
        };
        // a kept verdict, and a local call-out (strong words, neutral: nothing for the API to turn the other way), draw at once; any other local guess waits a moment for the API's answer
        if (v.kept || v.label === 'Call-out') show();
        else {
          // 0.29.2: the card never waits behind the pill's words. The post is drawn now with a wordless chip, which starts
          // the card (the contract, the account's history, the chart) from this guess, exactly when 0.27.2 did; the words follow when the API has answered or the grace is over.
          if (!v.hidden) {
            const a = document.querySelector(`article[data-fable-id="${v.id}"]`);
            if (a && !a.querySelector('[data-fable-host]:not([data-stub])')) {
              // the guess as the page will read it (the author's record placed, another coin's verdict dropped, a promotion label held for the judged stance), without its words: the card
              // and the pill rules see the same tone and rows as before, the pill is a wordless chip
              const sv = scopeFor(a, VERDICTS.get(v.id));
              if (!sv.hidden) render(a, sv.pending ? sv : {...sv, label: '', stat: '', detail: undefined, stamp: undefined, fade: false, pending: true});
            }
          }
          setTimeout(show, CFG.timing?.quickGraceMs ?? 600);
        }
      }
    }).catch(() => {});
    // small batches: each one renders as soon as the API answers instead of waiting for the slowest post
    for (let k = 0; k < need.length; k += 6) {
      const chunk = need.slice(k, k + 6);
      chrome.runtime.sendMessage({type: 'verdicts', tweets: chunk}).then((res) => {
        for (const raw of res?.verdicts || []) {
          const v = calmOwn(cleanRep(raw));
          const prev = VERDICTS.get(v.id);
          VERDICTS.set(v.id, v);
          PENDING.delete(v.id);
          const a = document.querySelector(`article[data-fable-id="${v.id}"]`);
          if (a && prev?.provisional) apiVerdict(a, v);
          else if (a) render(a, v);
          // the contract in this post was too new to have its on-chain read: ask again, up to 3 times
          const tries = RECHECKS.get(v.id) || 0;
          if (v.recheck && tries < 3) {
            RECHECKS.set(v.id, tries + 1);
            setTimeout(() => { VERDICTS.delete(v.id); document.querySelector(`article[data-fable-id="${v.id}"]`)?.removeAttribute('data-fable-id'); scan(); }, 25000 + tries * 20000);
          }
        }
      }).catch(() => chunk.forEach((t) => PENDING.delete(t.id)));
    }
  };

  // 0.29.2, pill first paint: the chip goes onto a post that names a coin in the first frame after the post is in the page, not after the
  // scan debounce (60 ms), the verdict round trip or X's own data. It reads the post's text from the page (textContent, no layout) when X's data is not here yet.
  let chipRaf = 0;
  const chipSoon = () => { if (!chipRaf) chipRaf = requestAnimationFrame(() => { chipRaf = 0; chipPass(); }); };
  const chipPass = () => {
    if (!css || !settings.enabled || !on('pills') || !on('quickVerdict')) return;
    for (const article of document.querySelectorAll('article[data-testid="tweet"]')) {
      const id = idOf(article);
      if (!id || article.getAttribute('data-fable-chip') === id) continue;
      if (VERDICTS.has(id) || article.querySelector('[data-fable-host]')) { article.setAttribute('data-fable-chip', id); continue; }
      let tw = TWEETS.get(id);
      if (!tw) {
        const el = [...article.querySelectorAll('[data-testid="tweetText"]')].find((x) => !x.closest('[role="link"][tabindex]'));
        if (!el) continue; // the text is not in the page yet: the next pass
        const text = el.textContent || '';
        tw = {id, text, author: {}, cashtags: (text.match(/[$＄][A-Za-z][A-Za-z0-9]{1,11}\b/g) || []).map((x) => x.slice(1).toUpperCase()), urls: []};
      }
      article.setAttribute('data-fable-chip', id);
      stubChip(article, tw);
    }
  };
  // 0.29.2 (owner: fast scrolling is choppy and the scrollbar jumps, especially going up): X throws away the posts that scroll out of its list and draws them again from scratch when the
  // reader comes back, at the height it remembers (with our pill and card in it). Our nodes were gone from the new post, then came back a moment later: the post shrank and grew again
  // above the reader, and X moved everything. The hosts last drawn on a post are kept (KEEP, the newest 160 posts) and put back in the very task X draws the post in (this observer's
  // callback runs before the next frame): the post is as tall as X remembers on its first frame, nothing is fetched, nothing plays again.
  const KEEP = new Map(); // post id -> {ui, intel, v, bg, stamps: [(article) => ...]} the nodes drawn on the post last time
  let STAMP_RESTORE = false; // true while restoreHosts puts the stamps back: they are already in KEEP
  const keepOf = (id) => {
    id = String(id);
    let k = KEEP.get(id);
    if (k) { KEEP.delete(id); KEEP.set(id, k); } else { k = {stamps: []}; KEEP.set(id, k); if (KEEP.size > 160) KEEP.delete(KEEP.keys().next().value); }
    return k;
  };
  const restoreHosts = (article) => {
    if (!KEEP.size || !settings.enabled || !css) return false;
    const id = idOf(article);
    const k = id && KEEP.get(id);
    if (!k || !k.ui || k.ui.isConnected || article.querySelector('[data-fable-host="ui"]')) return false;
    if (k.bg !== document.body.style.backgroundColor) { KEEP.delete(id); return false; } // another theme since: drawn again, not put back
    if (k.view !== pageView()) { KEEP.delete(id); return false; } // 0.30.0: another page view since (the whole card / compact card and the author record start again there)
    const textEl = [...article.querySelectorAll('[data-testid="tweetText"]')].find((el) => !el.closest('[role="link"][tabindex]'));
    const bar = [...article.querySelectorAll('[role="group"]')].pop();
    if (!textEl && !bar) return false;
    if (textEl) textEl.insertAdjacentElement('afterend', k.ui); else bar.insertAdjacentElement('beforebegin', k.ui);
    if (k.intel && !k.intel.isConnected) k.ui.insertAdjacentElement('afterend', k.intel);
    article.setAttribute('data-fable-id', id);
    article.setAttribute('data-fable-done', k.v.id);
    if (k.v.fade && settings.fade) { article.dataset.fableWantsFade = '1'; article.setAttribute('data-fable-fade', '1'); }
    // what takes no room (the stamp, the underlines) follows on the next frame; a verdict that changed while the post was away is painted in place
    requestAnimationFrame(() => {
      if (!article.isConnected) return;
      if (textEl && textEl.isConnected && settings.tokenMarks && on('tokenMarks')) markTokens(article, k.v, textEl, k.t);
      // 0.30.0 (ext030-scroll: the tab froze scrolling back up to a stamped post): a stamp put back must not register itself again while the list is being walked
      // (it pushed a new closure onto k.stamps on every call, so the loop never ended); one stamp of each kind per post, the list copied before the walk
      if (!article.querySelector('[data-fable-host="stamp"]')) { STAMP_RESTORE = true; try { for (const st of [...k.stamps]) st(article); } finally { STAMP_RESTORE = false; } }
      const cur = VERDICTS.get(id);
      if (cur && cur !== k.v && !sameVerdict(cur, k.v)) apiVerdict(article, cur);
    });
    return true;
  };
  const restoreFrom = (muts) => {
    if (!KEEP.size) return;
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.matches?.('article[data-testid="tweet"]')) restoreHosts(n);
        else if (n.firstElementChild) for (const a of n.querySelectorAll('article[data-testid="tweet"]')) restoreHosts(a);
      }
    }
  };
  new MutationObserver((muts) => { restoreFrom(muts); chipSoon(); scan(); }).observe(document.documentElement, {childList: true, subtree: true});

  /* ---------------- 3. Render (X-native look, animates when scrolled into view) ---------------- */

  const PLAYED = new Set(); // tweet ids whose entrance already played

  const theme = () => {
    if (window.__fableTheme) return window.__fableTheme; // lets the website demo pick a theme
    const bg = getComputedStyle(document.body).backgroundColor;
    if (bg === 'rgb(0, 0, 0)') return 'dark';
    if (bg === 'rgb(21, 32, 43)') return 'dim';
    return 'light';
  };

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
  // English text that comes from the server or the verdict engine (a label, a detail, a row title, a card line) in the reader's
  // language: the translation when Fable has one, else the same text. A line built from parts joined by " · " is looked up
  // whole first, then part by part. Plain text: callers esc() it. Never feed the result back into logic that reads English.
  const TRS = (s) => {
    if (typeof s !== 'string' || !s) return s;
    const w = TR(s);
    if (w !== s || !s.includes(' · ')) return w;
    return s.split(' · ').map((p) => TR(p)).join(' · ');
  };
  // Fable mark (the rounded "f"); a brighter cobalt reads better on X's dark themes.
  const fox = (cls = 'fox') => `<img class="${cls}" src="${chrome.runtime.getURL(document.body && getComputedStyle(document.body).backgroundColor !== 'rgb(255, 255, 255)' ? 'icons/mark-dark.svg' : 'icons/mark.svg')}" alt="">`;
  const ICON = {
    smart: '<path d="M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5l-8-3Zm-1.2 13.6-3.5-3.5 1.4-1.4 2.1 2.1 4.6-4.6 1.4 1.4-6 6Z"/>',
    rugs: '<path d="M10.6 13.4a1 1 0 0 1 0-1.4l3-3a3 3 0 0 1 4.2 4.2l-2 2-1.4-1.4 2-2a1 1 0 0 0-1.4-1.4l-3 3a1 1 0 0 1-1.4 0ZM13.4 10.6a1 1 0 0 1 0 1.4l-3 3a3 3 0 0 1-4.2-4.2l2-2 1.4 1.4-2 2a1 1 0 0 0 1.4 1.4l3-3a1 1 0 0 1 1.4 0ZM3 4.4 4.4 3 21 19.6 19.6 21Z"/>',
    paid: '<path d="M4 9v6h3l6 4V5L7 9H4Zm12.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4ZM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6Z"/>',
    dev: '<path d="m8.6 16.6-4.6-4.6 4.6-4.6L7.2 6 1.2 12l6 6 1.4-1.4Zm6.8 0 4.6-4.6-4.6-4.6L16.8 6l6 6-6 6-1.4-1.4Z"/>',
    identity: '<path d="M13 3a9 9 0 0 0-9 9H1l4 4 4-4H6a7 7 0 1 1 2.1 5l-1.4 1.4A9 9 0 1 0 13 3Zm-1 5v5l4.3 2.5.7-1.2-3.5-2.1V8H12Z"/>',
    fresh: '<path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm1 15h-2v-2h2v2Zm0-4h-2V7h2v6Z"/>',
  };
  ICON.rep = '<path d="m12 2 2.9 6.3 6.9.7-5.2 4.6 1.5 6.8L12 17l-6.1 3.4 1.5-6.8L2.2 9l6.9-.7L12 2Z"/>';
  ICON.engaged = '<path d="M4.5 3.9 9 8l-1.4 1.5-2.1-1.9V16c0 1.1.9 2 2 2H13v2H7.5a4 4 0 0 1-4-4V7.6L1.4 9.5 0 8l4.5-4.1Zm12 2.1H11V4h5.5a4 4 0 0 1 4 4v8.4l2.1-1.9L24 16l-4.5 4.1L15 16l1.4-1.5 2.1 1.9V8c0-1.1-.9-2-2-2Z"/>';
  ICON.history = '<path d="M3 3h4v4H3V3Zm7 0h4v4h-4V3Zm7 0h4v4h-4V3ZM3 10h4v4H3v-4Zm7 0h4v4h-4v-4Zm7 0h4v4h-4v-4ZM3 17h4v4H3v-4Zm7 0h4v4h-4v-4Zm7 0h4v4h-4v-4Z"/>';
  ICON.calls = '<path d="M3 3h2v16h16v2H3V3Zm4 11 4-5 3 3 5-6 1.5 1.3L14.2 15l-3-3-2.7 3.4L7 14Z"/>';
  ICON.flags = '<path d="M12 2 1 21h22L12 2Zm1 16h-2v-2h2v2Zm0-4h-2V9h2v5Z"/>';
  ICON.doxxed = '<path d="M3 5h18v14H3V5Zm2 2v10h14V7H5Zm2 2h4v4H7V9Zm0 5h6v1.5H7V14Zm7-5h3v1.5h-3V9Zm0 3h3v1.5h-3V12Z"/>';
  ICON.anon = '<path d="M12 5C6 5 2 12 2 12s4 7 10 7 10-7 10-7-4-7-10-7Zm0 11a4 4 0 1 1 0-8 4 4 0 0 1 0 8ZM3.3 2 22 20.7 20.7 22 2 3.3 3.3 2Z"/>';
  const CHEV = '<svg viewBox="0 0 24 24" class="chev"><path d="M9.3 5.3 7.9 6.7l5.3 5.3-5.3 5.3 1.4 1.4 6.7-6.7-6.7-6.7Z"/></svg>';
  const icon = (k) => `<svg viewBox="0 0 24 24" class="ic">${ICON[k] || ''}</svg>`;
  // 0.29.3: a face is the picture, or (no URL / it fails to load) a coloured circle with the handle's first letter, never a blank circle
  const AVH = new Map(); // avatar url -> handle, so a face that fails to load can still draw its letter
  const faceUrl = (u) => { u = typeof u === 'string' ? u : (u && (u.avatar || u.image || u.pfp || u.profile_image_url_https || u.url)); u = String(u || '').trim().replace(/^\/\//, 'https://').replace(/^http:\/\//, 'https://'); return /^https:\/\//.test(u) ? u : ''; };
  const faceLtr = (h, cls = 'face') => { const s = String(h || '?').replace(/^@/, ''); let n = 0; for (const c of s) n = (n * 31 + c.charCodeAt(0)) % 360; return `<span class="${cls} ltr" style="background:hsl(${n} 55% 42%)">${esc(s.slice(0, 1).toUpperCase() || '?')}</span>`; };
  const face = (a, handle) => { const u = faceUrl(a), h = handle || a?.handle || AVH.get(u) || ''; if (u && h) AVH.set(u, h); return u ? `<img class="face" src="${esc(u)}" data-h="${esc(h)}" alt="" referrerpolicy="no-referrer">` : faceLtr(h); };
  const av = (src, cls = 'av') => (cls === 'face' ? face(src) : src ? `<img class="${cls}" src="${esc(src)}" alt="">` : `<span class="${cls} ph"></span>`);
  // Fable Rep shows our own number only; the full account check lives on fable.market
  const REP_SOURCE = "Scored by Fable's private reputation database";
  const rateLink = (h) => (h ? `https://fable.market/check?q=${encodeURIComponent(h)}` : 'https://fable.market/check');
  const i = (n) => `style="--i:${n}"`;
  // "3/5" -> {a: 3, b: 5}; the sentence around the two numbers is written by the caller (word order differs per language)
  const ofParts = (stat) => {
    const m = String(stat || '').match(/(\d+)\s*\/\s*(\d+)/);
    return m ? {a: Number(m[1]), b: Number(m[2])} : null;
  };
  const num = (v) => {
    const m = String(v).match(/^([^\d-]*)(-?\d+(?:\.\d+)?)(.*)$/);
    return m ? `<span class="num" data-count="${m[2]}" data-pre="${esc(m[1])}" data-suf="${esc(m[3])}">${esc(v)}</span>` : esc(v);
  };

  // One sentence of context under the tweet, the way X writes "Followed by ..." on profiles.
  // hard facts only: the old server line carries absence clauses ("no builder linked", "no smart followers"); drop them
  const loud = (s) => String(s || '').split(/\s+·\s+/).filter((p) => p && !/^(no|not|never|none|unknown|unconfirmed|pending)\b|\bnot (read|measured|linked|confirmed)\b|\bno (on-chain|price|cached|builder|smart|history|data)\b/i.test(p.trim())).join(' · ');
  const detail = (v) => {
    if (v.detail) {
      const d = loud(v.detail);
      if (d.length <= 46) return esc(TRS(d));
      if (v.stat && String(v.stat).length <= 24) return esc(TRS(v.stat));
      // a long line is cut to its numbers; read in the reader's language the whole line is cut instead (the numbers are English fragments)
      const td = TRS(d);
      if (td !== d) return esc(td.length <= 44 ? td : `${td.slice(0, 44).replace(/\s+\S*$/, '')}…`);
      const nums = d.match(/\d[\d,.]*%?\s+(?:of\s+)?[a-z]+(?:\s+[a-z]+)?/gi) || [];
      return esc(nums.slice(0, 2).join(' · ') || `${d.slice(0, 44).replace(/\s+\S*$/, '')}…`);
    }
    const people = v.card?.people || [];
    const n = parseInt(v.stat, 10) || people.length;
    if (people.length) {
      const named = people.slice(0, 2).map((p) => `<b>${esc(p.name || p.handle)}</b>`).join(', ');
      const rest = n - Math.min(2, people.length);
      return rest > 0 ? TT('pill.followedByNamedMore', {names: RAW(named), n: rest}) : TT('pill.followedByNamed', {names: RAW(named)});
    }
    if (/smart follower/i.test(v.label) || /smart follower/i.test(v.stat)) return n ? TT('pill.followedBy', {n}) : '';
    if (/rug history/i.test(v.label)) {
      const p = ofParts(v.stat);
      return p ? TT('pill.deployerRuggedOf', p) : TT('pill.deployerRugged', {x: v.stat});
    }
    if (/shill/i.test(v.label)) {
      if (!/\//.test(v.stat)) return TT('pill.shillReads');
      const p = ofParts(v.stat);
      return p ? TT('pill.shillDownOf', p) : TT('pill.shillDown', {x: String(v.stat).replace(' rugged', '')});
    }
    if (/scam/i.test(v.label)) return TT('pill.scamAsks');
    if (/legit dev/i.test(v.label)) {
      const k = parseInt(v.stat, 10);
      return k ? TT('pill.productsShipped', {n: k}) : TT('pill.severalShipped');
    }
    if (/engagement/i.test(v.label)) return TT('pill.engagement');
    if (/builder/i.test(v.label)) return TT('pill.builderUpdate');
    return '';
  };

  // One plain line: label, faces, context. Role and reputation live in the card, not on the line.
  const ctxHTML = (v) => {
    if (!on('pills')) return '';
    // a verdict label can be renamed from the remote config (copy.labels)
    if (CFG.copy?.labels?.[v.label]) v = {...v, label: CFG.copy.labels[v.label]};
    if (v.pending) return `<div class="ctx neutral stub" data-k="0" data-pending="1" data-vkey="|neutral||1" ${i(0)}>${fox()}</div>`; // 0.29.2: the judged stance is still to come: the chip, no words
    const pile = (v.card?.people || []).filter((p) => p && (p.avatar || p.handle)).slice(0, 3);
    const faces = (v.faces || (pile.length ? pile : v.avatars || [])).filter(Boolean).slice(0, 3); // no picture on file = a letter circle, never a blank one
    const d = v.tone === 'neutral' && !v.detail ? '' : detail(v);
    return `
      <div class="ctx ${v.tone} ${v.card?.rows ? 'tap' : ''}" data-k="0"${FC?.authorLevel(v) ? ' data-author="pill"' : ''}${v.callout ? ' data-callout="1"' : ''} data-vkey="${esc(`${v.label}|${v.tone}|${v.detail || ''}|0`)}" ${i(0)}>
        ${fox()}<span class="verdict">${esc(TRS(v.label))}</span>${v.badge ? `<span class="badge ${v.badge === 'DOXXED' ? 'g' : v.badge === 'OFFICIAL' ? 'f' : 'a'}">${esc(TRS(v.badge))}</span>` : ''}
        ${d ? `<span class="mid">·</span>${faces.length ? `<span class="pile">${faces.map((a) => face(a)).join('')}</span>` : ''}<span class="detail">${d}</span>` : ''}
        ${v.card?.rows ? `<svg viewBox="0 0 24 24" class="chev ctx-chev"><path d="M9.3 5.3 7.9 6.7l5.3 5.3-5.3 5.3 1.4 1.4 6.7-6.7-6.7-6.7Z"/></svg>` : ''}
      </div>`;
  };

  const shell = (kicker, right, body) => `
    <div class="expand"><div>
      <div class="card">
        <div class="head" ${i(1)}>${fox('fox lg')}<b>Fable</b><span class="kicker">${esc(kicker)}</span><span class="right">${right ? esc(right) : '<a class="xh" href="https://x.com/FableDotMarket" target="_blank" rel="noopener">@FableDotMarket</a>'}</span></div>
        ${body}
      </div>
    </div></div>`;

  // One row per signal. Title says what, sub-line says why, the right side shows the evidence at a glance.
  // new-engine evidence rows: {kind, tone, title, lines, prov}; old measured rows carry these fields instead
  const LEGACY_FIELDS = {rep: ['positive', 'negative'], calls: ['total', 'dead', 'winners', 'list'], identity: ['renames'], rugs: ['n', 'tokens'],
    paid: ['promos', 'dead', 'marks'], dev: ['shipped'], engaged: ['boosters', 'discussed'], fresh: ['days'], smart: ['n', 'people']};
  const isEvidence = (row) => !!row?.prov && Array.isArray(row.lines) && (row.kind === 'flags' || !LEGACY_FIELDS[row.kind] || LEGACY_FIELDS[row.kind].some((f) => row[f] === undefined));
  const EV_TONE = {legit: ['good', 'green', 'g'], kol: ['warn', 'amber', 'a'], rug: ['bad', 'red', 'r']};
  // where the evidence comes from, in the reader's words (prov.class); never a blanket "observed on-chain"
  const evSource = (row) => ({
    request: TX('ev.srcRequest'),
    client_obs: TX('ev.srcClientObs'),
    client_hint: TX('ev.srcClientHint'),
    operator: TX('ev.srcOperator'),
    onchain: TX('ev.srcOnchain'),
    thirdparty_list: row.credited ? TX('ev.srcListNamed', {name: row.credited}) : TX('ev.srcListPublic'),
    thirdparty_self: row.credited ? TX('ev.srcSelfNamed', {name: row.credited}) : TX('ev.srcSelfThird'),
    declared: TX('ev.srcDeclared'),
  })[row.prov?.class] || TX('ev.srcDefault');
  const evidenceCard = (row, k) => {
    const [cls] = EV_TONE[row.tone] || ['muted'];
    const more = row.lines.length > 1 ? `<span class="more">+${row.lines.length - 1}</span>` : '';
    return `
      <div class="sig ${cls} tap" data-k="${k}" ${i(2 + k)}>${icon(row.kind)}<div class="txt"><b>${esc(TRS(row.title || ''))}</b><span>${esc(TRS(row.lines[0] || ''))}</span></div>${more ? `<div class="aside">${more}</div>` : ''}${CHEV}</div>`;
  };
  const evidenceSheet = (row) => {
    const [, word, dot] = EV_TONE[row.tone] || ['muted', '', ''];
    return `<p class="lead"><b class="${word}">${esc(TRS(row.title || ''))}</b>. ${esc(evSource(row))}</p>
        ${row.lines.map((x, n) => `<div class="line" style="--i:${n}"><span class="dot ${dot === 'r' ? '' : dot}" style="background:${dot === 'r' ? 'var(--red)' : dot ? '' : 'var(--t2)'}"></span><div class="who"><b style="font-weight:500;white-space:normal">${esc(TRS(x))}</b></div></div>`).join('')}`;
  };
  // an evidence row's own title (server English, read in the reader's language) or the caller's fallback, which the caller translates
  const evTitle = (row, fallback) => (isEvidence(row) && row.title ? TRS(row.title) : fallback);
  const safeRow = (row, k) => { try { return rowHTML(row, k); } catch (e) { console.warn('fable: card row not shown', row?.kind, e?.message); return ''; } };
  const safeBody = (row) => { try { return sheetBody(row); } catch (e) { console.warn('fable: detail not shown', row?.kind, e?.message); return `<p class="lead">${TT('ev.detailError')}</p>`; } };

  const rowHTML = (row, k) => {
    if (isEvidence(row)) return evidenceCard(row, k);
    const wrap = (tone, title, sub, right) => `
      <div class="sig ${tone} tap" data-k="${k}" ${i(2 + k)}>${icon(row.kind)}<div class="txt"><b>${title}</b><span>${sub}</span></div>${right ? `<div class="aside">${right}</div>` : ''}${CHEV}</div>`;
    if (row.kind === 'doxxed') return wrap('good', TT('row.doxxed', {role: TRS(row.role.toLowerCase())}), row.proofs.map((p) => esc(TRS(p))).join(' · '), `<span class="badge g">${TT('row.badgeDoxxed')}</span>`);
    if (row.kind === 'anon') return wrap('warn', TT('row.anonDev'), esc(TRS(row.note)), `<span class="badge a">${TT('row.badgeAnon')}</span>`);
    if (row.kind === 'smart') {
      const extra = row.n - row.people.length;
      return wrap('good', TT('pill.followedBy', {n: row.n}),
        row.people.slice(0, 3).map((p) => `${esc(p.name)}${p.tag ? ` <i>${esc(TRS(p.tag))}</i>` : ''}`).join(' · '),
        `<span class="pile lg">${row.people.filter((p) => p.avatar).map((p) => face(p.avatar, p.handle)).join('')}${extra > 0 ? `<span class="more">+${extra}</span>` : ''}</span>`);
    }
    if (row.kind === 'rugs')
      return wrap('bad', TT('row.linkedRugs', {n: row.n}), `${esc(TRS(row.how))} · ${row.tokens.map((x) => `<s>${esc(x)}</s>`).join(' ')}`, `<span class="big red">${num(String(row.n))}</span>`);
    if (row.kind === 'rep')
      return wrap(row.rep >= 75 ? 'good' : row.rep < 40 ? 'bad' : 'muted', TT('row.repTitle', {rep: row.rep ?? '?'}), esc(TRS(REP_SOURCE)), '');
    if (row.kind === 'engaged') {
      const b = row.boosters, d = row.discussed;
      const faces = [...b, ...d].filter((p) => p.avatar).slice(0, 3);
      const title = b.length ? TT('row.retweetedBy', {n: b.length}) : TT('row.discussedBy', {n: d.length});
      const sub = [...b, ...d].slice(0, 3).map((p) => esc(p.name || p.handle)).join(' · ');
      return wrap(b.length ? 'good' : 'muted', title, sub, faces.length ? `<span class="pile lg">${faces.map((p) => face(p.avatar, p.handle)).join('')}</span>` : '');
    }
    if (row.kind === 'calls') {
      const bad = row.dead / Math.max(1, row.total) >= 0.6;
      return wrap(bad ? 'warn' : 'muted', TT('row.callRecord', {n: row.total}), `<em class="${bad ? 'red' : ''}">${TT('row.down85', {n: row.dead})}</em> · ${TT('row.wentUp', {n: row.winners})}`,
        `<span class="ticks">${row.list.slice(0, 10).map((x, n) => `<i class="${x.pct < 0 ? 'd' : 'u'}" style="--h:${n}"></i>`).join('')}</span>`);
    }
    if (row.kind === 'flags') return wrap(row.tone === 'legit' ? 'good' : row.tone === 'kol' ? 'warn' : row.tone === 'neutral' ? 'muted' : 'bad', esc(TRS(row.title)), esc(TRS(row.lines[0] || '')), row.lines.length > 1 ? `<span class="more">+${row.lines.length - 1}</span>` : '');
    if (row.kind === 'paid')
      return wrap('warn', TT('row.knownPaid'), `${TT('row.promos30', {n: row.promos})} · <em class="red">${TT('row.down85', {n: row.dead})}</em>`,
        `<span class="ticks">${row.marks.map((d, n) => `<i class="${d ? 'd' : 'u'}" style="--h:${n}"></i>`).join('')}</span>`);
    if (row.kind === 'dev')
      return wrap('good', TT('row.shipped', {n: row.shipped.length}), `${row.shipped.map(esc).join(' · ')}`, `<span class="yrs">${TT('row.yrs', {years: RAW(num(String(row.years)))})}</span>`);
    if (row.kind === 'identity') return wrap('warn', TT('row.renamed', {n: row.renames}), TT('row.previously', {handle: row.last}), '');
    if (row.kind === 'fresh') return wrap('muted', TT('row.newAccount'), TT('row.created', {n: row.days}), '');
    return '';
  };

  const cardHTML = (c) => {
    if (!c) return '';
    if (c.type === 'profile') return shell(TX('card.backstory'), c.since ? TX('card.trackingSince', {since: trDate(c.since)}) : '', `<div class="sigs">${c.rows.map(safeRow).join('')}</div>`);
    if (c.type === 'smart')
      return shell(TX('card.smartFollowers'), '', `
        ${c.people.map((p, k) => `<div class="person" ${i(2 + k)}>${av(p.avatar, 'pav')}<div class="who"><b>${esc(p.name || p.handle)}</b><span>@${esc(p.handle)}</span></div>${p.tag ? `<span class="tag">${esc(TRS(p.tag))}</span>` : ''}</div>`).join('')}
        <div class="meter" ${i(6)}><span>${TT('card.overlap')}</span><span class="track"><span class="fill" style="--w:${Math.round((c.score || 0.8) * 100)}%"></span></span><b>${esc(TRS(c.scoreLabel || ''))}</b></div>`);
    if (c.type === 'kol') {
      const bad = c.tokens.filter((t) => t[1] < 0).length;
      return shell(TX('card.promoHistory'), TX('card.last30'), `
        <div class="toks">${c.tokens.map(([tk, p], k) => `<div class="tok ${p < 0 ? 'down' : 'up'}" ${i(2 + k * 0.6)}><span>${esc(tk)}</span>${num(`${p > 0 ? '+' : ''}${p}%`)}</div>`).join('')}</div>
        <div class="foot" ${i(9)}><b>${TT('card.downOf', {a: bad, b: c.tokens.length})}</b><span>${esc(TRS(c.footer || ''))}</span></div>`);
    }
    if (c.type === 'lines')
      return shell(TRS(c.title) || TX('card.backstory'), TRS(c.right || ''), `<div class="sigs">${(c.lines || []).map((t, k) => `<div class="sig ${c.tone === 'self' ? 'self' : c.tone === 'kol' ? 'warn' : c.tone === 'legit' ? 'good' : 'bad'}" ${i(2 + k)}><div class="txt"><span class="line-txt">${esc(TRS(t))}</span></div></div>`).join('')}</div>`);
    if (c.type === 'rug')
      return shell(TRS(c.title) || TX('card.deployerHistory'), c.wallet, `
        <div class="rugrow">
          <svg class="chart" viewBox="0 0 142 50" ${i(2)}><path d="M2 40 L18 37 L30 30 L40 33 L52 18 L60 22 L70 6 L78 9 L84 5 L90 44 L104 45 L120 46 L140 46" pathLength="1"/></svg>
          ${c.stats.map(([val, k], n) => `<div class="stat ${n ? 'red' : ''}" ${i(3 + n)}><b>${num(val)}</b><span>${esc(TRS(k))}</span></div>`).join('')}
        </div>
        <div class="list" ${i(7)}>${(c.tokens || []).map(([tk, dead]) => `<span class="${dead ? 'dead' : ''}">${esc(tk)}</span>`).join('')}</div>`);
    if (c.type === 'dev')
      return shell(TX('card.builderHistory'), TRS(c.years), `
        <div class="list ok" ${i(2)}>${c.shipped.map((x) => `<span><em>✓</em>${esc(x)}</span>`).join('')}</div>
        <div class="heat" ${i(3)}>${Array.from({length: 130}, (_, n) => `<i style="--o:${[0.1, 0.3, 0.55, 0.8, 1][(n * 7919 + (n >> 3) * 31) % 5]};--h:${n}"></i>`).join('')}</div>`);
    return '';
  };

  const countUp = (root) => {
    for (const el of root.querySelectorAll('[data-count]')) {
      const to = parseFloat(el.dataset.count);
      const t0 = performance.now();
      const step = (now) => {
        const p = Math.min(1, (now - t0) / 700);
        const e = 1 - Math.pow(1 - p, 3);
        el.textContent = `${el.dataset.pre}${Math.round(to * e)}${el.dataset.suf}`;
        if (p < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }
  };

  // Plays each entrance once, the first time it is actually on screen.
  // Plays a host's entrance once. Idempotent, so both triggers below can call it.
  // 0.30.0 (ext030-scroll, measured: 86 to 96% of what moved on a fast scroll was the card's 0.5 s unfold, most of it in posts already above the screen, and X
  // remembered the half-open height): while the reader scrolls fast the pill and card open at once, with no height transition; at reading speed they unfold as before
  let scrollY0 = scrollY, scrollT0 = 0, scrollV = 0;
  addEventListener('scroll', () => { const now = performance.now(), dt = now - scrollT0; if (dt > 0) scrollV = dt > 250 ? 0 : Math.abs(scrollY - scrollY0) / dt; scrollY0 = scrollY; scrollT0 = now; }, {passive: true, capture: true});
  const scrollingFast = () => performance.now() - scrollT0 < 160 && scrollV > 1.2; // px per ms: 1,200 px a second and up
  const play = (host) => {
    const root = host.shadowRoot?.querySelector('.fable');
    if (!root || root.classList.contains('in')) return;
    io.unobserve(host);
    if (scrollingFast()) root.classList.add('done', 'open');
    root.classList.add('in');
    setTimeout(() => root.classList.add('open'), 600); // fold finished: stop clipping shadows and popovers
    countUp(root);
    const article = host.closest('article');
    if (host.dataset.fableHost === 'stamp' && article) {
      article.setAttribute('data-fable-fade', '1');
      setTimeout(() => article.classList.add('fable-thud'), 170);
      setTimeout(() => article.classList.remove('fable-thud'), 520);
    }
    if (host.dataset.fableHost === 'ui' && article?.dataset.fableWantsFade && !article.querySelector('[data-fable-host="stamp"]')) article.setAttribute('data-fable-fade', '1');
    if (article?.dataset.fableId) PLAYED.add(article.dataset.fableId);
  };
  // the reveal line: an entrance plays once its top passes 78% down the screen, so it unfolds where the eye is, not
  // below the fold (it used to fire at the very bottom edge and was already open by the time the post was read)
  const REVEAL = 0.78;
  const onScreen = (el) => {
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.top < innerHeight * REVEAL && r.right > 0 && r.left < innerWidth;
  };
  // Trigger 1: scrolled into view. Trigger 2 (in mountShadow): already on screen when rendered,
  // which IntersectionObserver can miss when a node is swapped in place.
  const io = new IntersectionObserver((entries) => {
    for (const en of entries) if (en.isIntersecting) play(en.target);
  }, {rootMargin: `0px 0px -${Math.round((1 - REVEAL) * 100)}% 0px`, threshold: 0});

  // a logo that fails to load (slow IPFS links) disappears instead of showing a broken-image icon
  const faceFix = (im) => { const t = document.createElement('template'); t.innerHTML = faceLtr(im.dataset.h); if (im.isConnected && t.content.firstElementChild) im.replaceWith(t.content.firstElementChild); };
  const hideBroken = (root) => root.querySelectorAll('img').forEach((im) => {
    if (im.matches('.face')) { if (im.complete && !im.naturalWidth) faceFix(im); else im.addEventListener('error', () => faceFix(im), {once: true}); return; }
    im.addEventListener('error', () => { if (im.matches('.mv-logo, .tl, .fox')) im.remove(); else im.style.visibility = 'hidden'; }, {once: true});
  });
  const mountShadow = (host, html, t, played, v) => {
    const root = host.attachShadow({mode: 'open'});
    // the pill and the card take no room until they play, then slide down out from under the post text
    // (hidden but laid out, they left a blank band under the text)
    const fold = host.dataset.fableHost === 'ui' || host.dataset.fableHost === 'intel';
    // 0.30.0: a pill or card whose post is already above the screen when its data lands (the reader scrolled past it) opens at once: it never unfolds out of sight,
    // half-open when X measures it
    if (!played && fold && host.isConnected && host.getBoundingClientRect().bottom < 0) played = true;
    root.innerHTML = `${styleFor(root)}<div lang="${LANG()}" class="fable ${t} ${played ? 'in done open' : ''}">${fold ? `<div class="fold"><div>${html}</div></div>` : html}</div>`;
    hideBroken(root);
    if (!played) {
      io.observe(host);
      setTimeout(() => onScreen(host) && play(host), 140);
    }
    // the verdict can be upgraded in place after mount (local rules first, then the API): read the current one on click
    if (v)
      root.addEventListener('click', (e) => {
        const cur = VERDICTS.get(v.id) || v;
        const el = e.target.closest('.tap');
        if (!el || !cur?.card?.rows) return;
        e.preventDefault();
        e.stopPropagation(); // don't open the tweet underneath
        openSheet(cur, Number(el.dataset.k || 0), t);
      });
    return root;
  };

  /* ---------------- Detail sheet (X-style dialog) ---------------- */

  // sheet and tab titles by row kind, in the active language (a function, so a language change shows on the next paint)
  const sheetTitle = (kind) => ({history: TX('sheet.title.history'), contract: TX('sheet.title.contract'), engaged: TX('sheet.title.engaged'), rep: TX('sheet.title.rep'), calls: TX('sheet.title.calls'), flags: TX('sheet.title.flags'), smart: TX('sheet.title.smart'), rugs: TX('sheet.title.rugs'), paid: TX('sheet.title.paid'), dev: TX('sheet.title.dev'), identity: TX('sheet.title.handleHistory'), fresh: TX('sheet.title.fresh'), doxxed: TX('sheet.title.identity'), anon: TX('sheet.title.identity'), thesis: TX('sheet.title.thesis'), token: TX('sheet.title.token')})[kind];
  // an evidence row carries its own title (server English); every other row is named by its kind
  const titleOf = (row, fallback) => { const own = evTitle(row, null); return own != null ? TRS(own) : sheetTitle(row.kind) || fallback; };

  const TONE = {bad: 'red', warn: 'amber', good: 'green', muted: ''};

  // Account history heatmap: one cell per day, weeks as columns. A cell shows events Fable
  // observed that day; grey hatching means Fable has no data for that day (unknown, never clean). Colour = event type;
  // a ring marks a day with more than one type. Tap a day for its receipts.
  const HM_ORDER = ['adverse', 'report', 'correction', 'promotion', 'building'];
  const hmLabel = (t) => ({building: TX('sheet.hm.building'), promotion: TX('sheet.hm.promotion'), adverse: TX('sheet.hm.adverse'), report: TX('sheet.hm.report'), correction: TX('sheet.hm.correction')})[t];
  // history event text from the server: labels and sources are whole sentences; a result line can join two clauses with "; ".
  // A "Build post" event's text is the post itself and stays as written.
  const histMemo = new Map();
  const histTR = (s) => {
    const t = String(s ?? '');
    const k = `${LANG()}|${t}`;
    let v = histMemo.get(k);
    if (v === undefined) { if (histMemo.size > 2000) histMemo.clear(); histMemo.set(k, (v = TR(t))); }
    return v;
  };
  const histText = (e) => (e.type === 'building' ? String(e.text ?? '') : e.textKey ? FX({text: e.text, key: e.textKey, params: e.textParams}) : String(e.text ?? '').split('; ').map((x) => TR(x)).join('; '));
  // an event's label: its key and params when the server sent them, else the English label through the phrase table
  const evLabel = (e) => (e.labelKey ? FX({text: e.label, key: e.labelKey, params: e.labelParams}) : histTR(e.label));
  const hmDay = (d, i = 0) => {
    const types = HM_ORDER.filter((t) => d.events.some((e) => e.type === t));
    const cls = d.coverage === 'before_account' ? 'pre' : d.coverage !== 'observed' ? 'nodata' : types.length ? `t-${types[0]}` : 'quiet';
    const tip = d.coverage === 'observed' ? (d.events.length ? TX('sheet.hm.tipEvents', {date: d.date, events: d.events.map(evLabel).slice(0, 3).join('; ')}) : TX('sheet.hm.tipQuiet', {date: d.date})) : TX(d.coverage === 'before_account' ? 'sheet.hm.tipBefore' : 'sheet.hm.tipNoData', {date: d.date});
    return `<button class="hx ${cls}${types.length > 1 ? ' mix' : ''}" data-d="${esc(d.date)}" style="--n:${Math.floor(i / 7) + (i % 7)}" aria-label="${esc(tip)}" title="${esc(tip)}"></button>`;
  };
  const historyBody = (row) => {
    if (row.state !== 'done') return `<div class="th-load"><span class="th-spin"></span><div><b>${TT('sheet.hist.loadingTitle')}</b><span>${TT('sheet.hist.loadingBody', {handle: row.handle})}</span></div></div>`;
    const d = row.data;
    if (!d || d.error) return `<p class="lead">${TT('sheet.hist.unavailable')}</p>`;
    const c = d.coverage || {};
    const legend = HM_ORDER.slice().reverse().map((t) => `<span class="hl"><i class="hx t-${t}"></i>${esc(hmLabel(t))} <b>${d.counts?.[t] || 0}</b></span>`).join('');
    const sel = row.sel && d.days.find((x) => x.date === row.sel);
    const basisOf = (b) => (b === 'allegation' ? TX('sheet.hist.basis.allegation') : b === 'corroborated' ? TX('sheet.hist.basis.corroborated') : b === 'correction' ? TX('sheet.hist.basis.correction') : TX('sheet.hist.basis.observed'));
    const detail = sel ? `<div class="hd"><b>${esc(sel.date)}${sel.total > sel.events.length ? ` <span class="hq">${TT('sheet.hist.shown', {n: String(sel.events.length), total: String(sel.total)})}</span>` : ''}</b>${sel.events.length ? sel.events.map((e) => `<div class="he"><i class="hx t-${e.type}"></i><div><b>${esc(evLabel(e))}</b>${e.text ? `<span>${esc(histText(e))}</span>` : ''}<em>${esc(basisOf(e.basis))} · ${esc(histTR(e.source))} · ${esc(String(e.at).slice(11, 16))} UTC${e.url ? ` · <a href="${esc(e.url)}" target="_blank" rel="noopener">${TT('sheet.hist.open')}</a>` : ''}</em></div></div>`).join('') : `<span class="hq">${sel.coverage === 'observed' ? TT('sheet.hist.quiet') : sel.coverage === 'before_account' ? TT('sheet.hist.before') : TT('sheet.hist.noDataDay')}</span>`}</div>` : `<div class="hd hq">${TT('sheet.hist.tap')}</div>`;
    // drop leading weeks with nothing observed (keep at least 8), so a new account is not a wall of hatching
    let days = d.days;
    const firstWk = Math.floor(Math.max(0, days.findIndex((x) => x.coverage === 'observed')) / 7);
    const drop = Math.max(0, Math.min(firstWk, Math.floor(days.length / 7) - 8)) * 7;
    days = days.slice(drop);
    const weeks = Math.ceil(days.length / 7);
    const months = Array.from({length: weeks}, (_, w) => { const wk = days.slice(w * 7, w * 7 + 7); const m = wk.find((x) => x.date.endsWith('-01')) || (w === 0 && wk[0]); return `<span>${m ? esc(DATE(m.date, {month: 'short'})) : ''}</span>`; }).join('');
    return `<p class="lead">${TT(c.lastObserved ? 'sheet.hist.seenLast' : 'sheet.hist.seen', {n: c.observedDays || 0, total: days.length, last: c.lastObserved})} <span class="hq">${TT('sheet.hist.hint')}</span></p>
      <div class="hmw ${row.waved ? 'still' : ''}" style="--weeks:${weeks}"><div class="hmo">${months}</div><div class="hm">${days.map(hmDay).join('')}</div></div>
      <div class="hleg">${legend}<span class="hl"><i class="hx nodata"></i>${TT('sheet.hm.noData')}</span></div>${detail}`;
  };

  // the facts a thesis card measures: the labels that are also on the token scan reuse those keys, the rest are server English
  const thesisFact = (label) => {
    const own = {Age: TX('token.fact.age'), 'Market cap': TX('token.fact.mcap'), Liquidity: TX('token.fact.liquidity'), 'From peak': TX('token.fact.fromPeak'), 'Top 10 wallets': TX('token.fact.top10')};
    return Object.prototype.hasOwnProperty.call(own, label) ? own[label] : TR(String(label ?? ''));
  };

  const thesisBody = (row) => {
    if (row.state === 'loading') return `<div class="th-load"><span class="th-spin"></span><div><b>${TT('thesis.loadingTitle')}</b><span>${TT('thesis.loadingBody')}</span></div></div>`;
    const d = row.data;
    if (!d || d.error) {
      const why = d?.error === 'rate_limited' ? TT('thesis.err.rateLimited') : d?.error === 'not_enough_data' ? TT('thesis.err.notEnough') : TT('thesis.err.failed');
      return `<p class="lead">${why}</p>`;
    }
    const s = d.subject || {}, t = d.thesis || {};
    const src = (x) => (x.kind === 'post' ? (x.time ? TX('thesis.src.postDate', {date: DATE(x.time, {month: 'short', day: 'numeric'})}) : TX('thesis.src.post')) : x.kind === 'website' ? TX('thesis.src.website') : x.kind === 'chart' ? TX('sheet.chart') : TX('thesis.src.other'));
    if (t.accountType === 'person' || t.accountType === 'media') {
      const who = s.name || (s.handle ? `@${s.handle}` : TX('thesis.account'));
      return `<div class="th-top">${s.avatar ? av(s.avatar, 'th-av') : `<span class="th-av th-mono">${esc(who.replace(/^@/, '').slice(0, 1))}</span>`}
        <div class="th-id"><b>${esc(who)}</b><span>${esc(s.handle ? `@${s.handle}` : '')}</span></div>
        <span class="th-tag">${t.accountType === 'media' ? TT('thesis.tag.media') : TT('thesis.tag.person')}</span></div>
      <p class="th-one">${esc(TR(t.oneLiner || ''))}</p>
      ${(t.topics || []).length ? `<div class="th-sec"><h4>${TT('thesis.h.topics')}</h4><div class="th-unk th-topics">${t.topics.map((x) => `<span>${esc(x)}</span>`).join('')}</div></div>` : ''}
      ${(t.knownFor || []).length ? `<div class="th-sec"><h4>${TT('thesis.h.knownFor')}</h4>${t.knownFor.map((c, n) => `<div class="th-claim" style="--i:${n}">${esc(c)}</div>`).join('')}</div>` : ''}
      ${t.style ? `<div class="th-sec"><h4>${TT('thesis.h.style')}</h4><p>${esc(t.style)}</p></div>` : ''}
      ${(t.mentions || []).length ? `<div class="th-sec"><h4>${TT('thesis.h.mentions')}</h4><div class="th-unk th-topics">${t.mentions.map((x) => `<span>${esc(x)}</span>`).join('')}</div></div>` : ''}
      ${(d.facts || []).length ? `<div class="th-sec"><div class="th-facts">${d.facts.map((f, n) => `<div class="th-f" style="--i:${n}"><span>${esc(thesisFact(f.label))}</span><b>${esc(TR(String(f.value ?? '')))}</b></div>`).join('')}</div></div>` : ''}
      ${(d.sources || []).length ? `<div class="th-src">${d.sources.map((x) => `<a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(src(x))}</a>`).join('')}</div>` : ''}
      <p class="th-note">${TT(d.cached ? 'thesis.notePerson' : 'thesis.notePersonFresh')}</p>`;
    }
    const title = s.symbol ? `$${s.symbol}` : s.name || (s.handle ? `@${s.handle}` : TX('thesis.project'));
    return `<div class="th-top">${s.avatar ? av(s.avatar, 'th-av') : `<span class="th-av th-mono">${esc(title.replace(/^[$@]/, '').slice(0, 1))}</span>`}
        <div class="th-id"><b>${esc(title)}</b><span>${esc([s.name && s.symbol ? s.name : '', s.handle ? `@${s.handle}` : '', s.chain || ''].filter(Boolean).join(' · '))}</span></div>
        ${t.narrative && t.narrative !== 'Not stated' ? `<span class="th-tag">${esc(t.narrative)}</span>` : ''}</div>
      <p class="th-one">${esc(TR(t.oneLiner || ''))}</p>
      <div class="th-sec"><h4>${TT('thesis.h.pitch')}</h4><p>${esc(TR(t.pitch || 'Not stated'))}</p></div>
      ${(t.claims || []).length ? `<div class="th-sec"><h4>${TT('thesis.h.claims')}</h4>${t.claims.map((c, n) => `<div class="th-claim" style="--i:${n}">${esc(c)}</div>`).join('')}</div>` : ''}
      ${(t.unknowns || []).length ? `<div class="th-sec"><h4>${TT('thesis.h.unknowns')}</h4><div class="th-unk">${t.unknowns.map((u) => `<span>${esc(u)}</span>`).join('')}</div></div>` : ''}
      ${(d.facts || []).length ? `<div class="th-sec"><h4>${TT('thesis.h.reality')}</h4><div class="th-facts">${d.facts.map((f, n) => `<div class="th-f" style="--i:${n}"><span>${esc(thesisFact(f.label))}</span><b class="${TONE[f.tone] || ''}">${esc(TR(String(f.value ?? '')))}</b></div>`).join('')}</div></div>` : ''}
      ${(d.sources || []).length ? `<div class="th-src">${d.sources.map((x) => `<a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(src(x))}</a>`).join('')}</div>` : ''}
      <p class="th-note">${TT(d.cached ? 'thesis.noteProject' : 'thesis.noteProjectFresh')}</p>`;
  };

  const sheetBody = (row) => {
    if (isEvidence(row)) return evidenceSheet(row);
    if (row.kind === 'history') return historyBody(row);
    if (row.kind === 'contract') return contractBody(row);
    if (row.kind === 'thesis') return thesisBody(row);
    if (row.kind === 'token') return tokenBody(row);
    if (row.kind === 'smart')
      return `<p class="lead">${TT('sheet.smart.lead', {n: row.n})}</p>
        ${(row.all || row.people).map((p, n) => `<a class="line" href="https://x.com/${esc(p.handle)}" target="_blank" rel="noopener" style="--i:${n}">${av(p.avatar, 'lav')}<div class="who"><b>${esc(p.name)}</b><span>@${esc(p.handle)}</span></div><div class="meta"><span>${esc(TRS(p.tag || ''))}</span>${p.since ? `<span class="dim">${TT('sheet.smart.since', {since: trDate(p.since)})}</span>` : ''}</div></a>`).join('')}`;
    if (row.kind === 'rugs')
      return `<p class="lead">${TT('sheet.rugs.lead', {count: RAW(`<b class="red">${TT('sheet.rugs.count', {n: row.n})}</b>`), how: TRS(row.how)})}</p>
        ${row.wallet ? `<div class="wallet"><span class="dim">${TT('sheet.rugs.linkedWallet')}</span><code>${esc(row.walletShort)}</code><button class="copy" data-copy="${esc(row.wallet)}">${TT('common.copy')}</button></div>` : ''}
        <div class="table"><div class="th"><span>${TT('sheet.th.token')}</span><span>${TT('sheet.th.launched')}</span><span>${TT('sheet.th.peak')}</span><span>${TT('sheet.th.now')}</span><span>${TT('sheet.th.change')}</span></div>
        ${(row.items || []).map((x, n) => `<div class="tr" style="--i:${n}"><span><b>${x.url ? `<a href="${esc(x.url)}" target="_blank" rel="noopener" style="color:inherit">${esc(x.tk)}</a>` : esc(x.tk)}</b><em>${esc(x.chain || '')}</em></span><span>${esc(trDate(x.launched))}</span><span>${esc(x.ath || '')}</span><span>${esc(x.now || '')}</span><span class="red"><b>${x.drop == null ? '' : `-${x.drop}%`}</b>${x.life ? `<em>${TT('sheet.rugs.deadIn', {life: String(x.life)})}</em>` : ''}</span></div>`).join('')}</div>`;
    if (row.kind === 'paid')
      return `<p class="lead">${TT('sheet.paid.lead', {promos: row.promos, dead: RAW(`<b class="red">${esc(NUM(row.dead))}</b>`), disclosed: row.list?.filter((x) => x.disclosed).length || 0})}</p>
        <div class="table four"><div class="th"><span>${TT('sheet.th.token')}</span><span>${TT('sheet.th.posted')}</span><span>${TT('sheet.th.disclosed')}</span><span>${TT('sheet.th.sincePost')}</span></div>
        ${(row.list || []).map((x, n) => `<div class="tr" style="--i:${n}"><span><b>${esc(x.tk)}</b></span><span>${esc(x.date)}</span><span>${x.disclosed ? TT('common.yes') : `<span class="amber">${TT('common.no')}</span>`}</span><span class="${x.dead ? 'red' : 'green'}"><b>${x.pct > 0 ? '+' : ''}${x.pct}%</b></span></div>`).join('')}</div>`;
    if (row.kind === 'dev')
      return `<p class="lead">${TT('sheet.dev.lead', {years: String(row.years), commits: String(row.commits)})}</p>
        ${(row.items || row.shipped.map((x) => ({name: x}))).map((x, n) => `<div class="line" style="--i:${n}"><span class="dot g"></span><div class="who"><b>${esc(x.name)}</b><span>${TT('sheet.dev.since', {since: trDate(x.since)})}</span></div><div class="meta"><span class="${x.status === 'Live' ? 'green' : 'dim'}">${esc(TRS(x.status || ''))}</span></div></div>`).join('')}`;
    if (row.kind === 'doxxed')
      return `<p class="lead">${TT('sheet.doxxed.lead', {role: TRS(row.role).toLowerCase(), state: RAW(`<b class="green">${TT('sheet.doxxed.identified')}</b>`)})}</p>
        ${row.proofs.map((x, n) => `<div class="line" style="--i:${n}"><span class="dot g"></span><div class="who"><b>${esc(TRS(x))}</b></div></div>`).join('')}`;
    if (row.kind === 'anon') return `<p class="lead">${TT('sheet.anon.lead', {label: RAW(`<b class="amber">${TT('sheet.anon.label')}</b>`), note: TRS(row.note)})}</p>`;
    if (row.kind === 'identity')
      return `<p class="lead">${TT('sheet.identity.lead', {times: RAW(`<b class="amber">${TT('sheet.identity.times', {n: row.renames})}</b>`)})}</p>
        ${(row.hist || []).map((x, n) => `<div class="line" style="--i:${n}"><span class="dot a"></span><div class="who"><b>@${esc(x.handle)}</b><span>${TT('sheet.identity.until', {until: String(x.until ?? '')})}</span></div></div>`).join('')}`;
    if (row.kind === 'fresh') return `<p class="lead">${TT('sheet.fresh.lead', {n: row.days})}</p>`;
    if (row.kind === 'engaged') {
      const verb = (k) => Object.entries(k).map(([kind, n]) => { const w = {retweet: TX('sheet.engaged.retweet'), quote: TX('sheet.engaged.quote'), reply: TX('sheet.engaged.reply'), mention: TX('sheet.engaged.mention')}[kind] || kind; return n > 1 ? TX('sheet.engaged.verbN', {verb: w, n}) : w; }).join(' · ');
      const line = (p, n) => `<a class="line" href="https://x.com/${esc(p.handle)}" target="_blank" rel="noopener" style="--i:${n}">${av(p.avatar, 'lav')}<div class="who"><b>${esc(p.name || p.handle)}</b><span>@${esc(p.handle)}</span></div><div class="meta"><span>${esc(TRS(p.tag || ''))}</span><span class="dim">${esc(verb(p.kinds))}</span></div></a>`;
      return `<p class="lead">${TT('sheet.engaged.lead', {retweets: RAW(`<b class="green">${TT('sheet.engaged.retweets')}</b>`)})}</p>
        ${row.boosters.length ? `<p class="lead" style="margin-top:14px"><b>${TT('sheet.engaged.retweetedBy')}</b></p>${row.boosters.map(line).join('')}` : ''}
        ${row.discussed.length ? `<p class="lead" style="margin-top:14px"><b>${TT('sheet.engaged.discussedBy')}</b></p>${row.discussed.map(line).join('')}` : ''}`;
    }
    if (row.kind === 'rep')
      return `<p class="lead">${TT('sheet.rep.lead', {rep: row.rep ?? '?', source: RAW(String(TRS(REP_SOURCE)).replace(/[&<>]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;'}[c])))})}</p>
        <div class="tk-acts"><a class="th-srcb" href="${esc(rateLink(row.handle))}" target="_blank" rel="noopener">${row.handle ? TT('sheet.rep.checkHandle', {handle: row.handle}) : TT('sheet.rep.checkAny')}</a></div>`;
    if (row.kind === 'calls')
      return `<p class="lead">${TT('sheet.calls.lead', {total: String(row.total), dead: RAW(`<b class="red">${esc(NUM(row.dead))}</b>`), winners: RAW(`<b class="green">${esc(NUM(row.winners))}</b>`)})}</p>
        <div class="table four"><div class="th"><span>${TT('sheet.th.token')}</span><span></span><span></span><span>${TT('sheet.th.bestAfterCall')}</span></div>
        ${(row.list || []).map((x, n) => `<div class="tr" style="--i:${n}"><span><b>${esc(x.tk)}</b></span><span></span><span></span><span class="${x.pct < 0 ? 'red' : 'green'}"><b>${x.pct > 0 ? '+' : ''}${x.pct}%</b></span></div>`).join('')}</div>`;
    if (row.kind === 'flags') {
      // a Fable-confirmed entry (fable.market submission Fable reviewed) says so; everything else is chain or public posts
      const confirmed = row.lines.some((x) => /^Reviewed and confirmed by Fable/.test(x));
      const cls = row.tone === 'kol' ? 'amber' : row.tone === 'legit' ? 'green' : 'red';
      const dot = row.tone === 'kol' ? 'var(--amber)' : row.tone === 'legit' ? 'var(--green)' : 'var(--red)';
      return `<p class="lead">${TT(confirmed ? 'sheet.flags.leadConfirmed' : 'sheet.flags.leadObserved', {title: RAW(`<b class="${cls}">${esc(TRS(row.title))}</b>`)})}</p>
        ${row.lines.map((x, n) => `<div class="line" style="--i:${n}"><span class="dot" style="background:${dot}"></span><div class="who"><b style="font-weight:500;white-space:normal">${esc(TRS(x))}</b></div></div>`).join('')}`;
    }
    return '';
  };

  let sheetHost = null;
  const closeSheet = () => {
    const root = sheetHost?.shadowRoot?.querySelector('.fable');
    if (!root) return;
    root.classList.remove('open');
    setTimeout(() => sheetHost?.remove(), 180);
    document.removeEventListener('keydown', escKey, true);
  };
  const escKey = (e) => e.key === 'Escape' && (e.stopPropagation(), closeSheet());

  const openSheet = (v, k, t) => {
    sheetHost?.remove();
    // drop null / non-object rows before tabs are drawn, keeping the tapped row selected
    const kept = (v.card?.rows || []).map((r, i) => [r, i]).filter(([r]) => r && typeof r === 'object');
    const rows = kept.map(([r]) => r);
    let cur = Math.max(0, kept.findIndex(([, i]) => i === k));
    // History tab for the post's author: fetched once per card, then kept on the verdict
    const handle = v.id && TWEETS.get(v.id)?.author?.handle;
    if (handle && !rows.some((r) => r.kind === 'history')) rows.push(v._hist ||= {kind: 'history', state: 'idle', handle});
    const who = handle || (String(v.id || '').startsWith('profile:') ? String(v.id).slice(8) : null);
    for (const r of rows) if (r.kind === 'rep' && !r.handle && who) r.handle = who;
    if (!rows.length) return {repaint: () => {}};
    if (k === 'history') cur = Math.max(0, rows.findIndex((r) => r.kind === 'history'));
    sheetHost = document.createElement('div');
    sheetHost.setAttribute('data-fable-sheet', '');
    document.body.appendChild(sheetHost);
    const root = sheetHost.attachShadow({mode: 'open'});
    const paint = () => {
      const row = rows[cur];
      root.innerHTML = `${styleFor(root)}
        <div lang="${LANG()}" class="fable ${t} sheetwrap open">
          <div class="scrim"></div>
          <div class="sheet" role="dialog" aria-label="Fable">
            <div class="bar"><button class="x" aria-label="${esc(TX('common.close'))}"><svg viewBox="0 0 24 24"><path d="M10.6 12 4.9 6.3l1.4-1.4 5.7 5.7 5.7-5.7 1.4 1.4-5.7 5.7 5.7 5.7-1.4 1.4-5.7-5.7-5.7 5.7-1.4-1.4 5.7-5.7Z"/></svg></button>
              ${fox('fox lg')}<b>${esc(row.kind === 'thesis' && ['person', 'media'].includes(row.data?.thesis?.accountType) ? TX('sheet.title.profile') : titleOf(row, 'Fable'))}</b>${row.kind === 'token' || row.kind === 'contract' || !v.label ? '' : `<span class="vtag ${v.tone}">${esc(TRS(v.label))}</span>`}</div>
            ${rows.length > 1 ? `<div class="tabs">${rows.map((r, n) => `<button class="tabb ${n === cur ? 'on' : ''}" data-n="${n}">${icon(r.kind)}${esc(titleOf(r, r.kind))}</button>`).join('')}</div>` : ''}
            <div class="sbody">${safeBody(row)}</div>
            <div class="sfoot"><a class="xh" href="https://x.com/FableDotMarket" target="_blank" rel="noopener">@FableDotMarket</a> · fable.market${v.source === 'demo' ? ` · ${TT('sheet.demo')}` : ''}</div>
          </div>
        </div>`;
      root.querySelector('.scrim').onclick = closeSheet;
      root.querySelector('.x').onclick = closeSheet;
      root.querySelectorAll('.tabb').forEach((b) => (b.onclick = () => ((cur = Number(b.dataset.n)), paint())));
      root.querySelectorAll('.copy').forEach((b) => (b.onclick = () => navigator.clipboard.writeText(b.dataset.copy).then(() => (b.textContent = TX('common.copied')))));
      root.querySelectorAll('[data-thesis]').forEach((b) => (b.onclick = () => {
        const d = row.data || {};
        openThesis(d.address ? {chain: d.chain, address: d.address} : {symbol: d.symbol}, `$${d.symbol || ''}`);
      }));
      root.querySelectorAll('[data-live-scan]').forEach((b) => (b.onclick = () => { const d = row.data?.identity || {}; openToken({label: row.label || TX('sheet.title.contract'), q: {address: d.address, ...(d.chains?.length === 1 ? {chain: d.chains[0]} : {})}}); }));
      if (row.kind === 'history' && row.state === 'done') row.waved = true;
      root.querySelectorAll('.hm .hx').forEach((b) => (b.onclick = () => ((row.sel = b.dataset.d), paint(), root.querySelector(`.hx[data-d="${row.sel}"]`)?.focus())));
      if (row.kind === 'history' && row.state === 'idle') {
        row.state = 'loading';
        chrome.runtime.sendMessage({type: 'history', handle: row.handle})
          .then((d) => Object.assign(row, {state: 'done', data: d || {error: 'failed'}}))
          .catch(() => Object.assign(row, {state: 'done', data: {error: 'failed'}}))
          .finally(() => sheetHost?.isConnected && paint());
      }
    };
    paint();
    root.querySelector('.fable').classList.remove('open');
    requestAnimationFrame(() => requestAnimationFrame(() => root.querySelector('.fable')?.classList.add('open')));
    document.addEventListener('keydown', escKey, true);
    return {repaint: () => sheetHost?.isConnected && paint()};
  };

  // Contract sheet: everything Fable holds on one (chain, address), grouped, each with its source.
  // "5 min ago" / "2 h ago" / "3 d ago" in the active language (the server writes the same three forms in its headline)
  const cxAgo = (ms) => { if (!ms) return ''; const s = Math.max(0, (Date.now() - ms) / 1000); return TR(s < 3600 ? `${Math.max(1, Math.round(s / 60))} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`); };
  // a server sentence that embeds one of those relative times: each time is turned into the active language first, then the
  // sentence is looked up (a sentence with no translation comes back as the server wrote it, time and all)
  const trAgo = (s) => {
    const was = String(s ?? '');
    const prepped = was.replace(/d+ (?:min|h|d) ago/g, (m) => TR(m));
    const out = TR(prepped);
    return out === prepped ? was : out;
  };
  const cxUsd = (n) => (n == null || !isFinite(n) ? '' : n >= 1e9 ? `$${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${Math.round(n / 1e3)}K` : n >= 1 ? `$${Math.round(n)}` : `$${Number(n).toPrecision(3)}`);
  const cxShort = (a) => (a ? `${a.slice(0, 6)}...${a.slice(-4)}` : '');
  const CX_CHAIN = {robinhood: 'Robinhood', solana: 'Solana', ethereum: 'Ethereum', base: 'Base', bsc: 'BNB Chain', arbitrum: 'Arbitrum'};
  const cxAddr = (chain, a) => (a ? (EXPLORER[chain] ? `<a href="${esc(EXPLORER[chain].replace('/token/', /^0x/.test(a) ? '/address/' : '/account/'))}${esc(a)}" target="_blank" rel="noopener">${esc(cxShort(a))}</a>` : esc(cxShort(a))) : '');
  const cxRow = (k, v, src) => (v ? `<div class="cx-r"><span>${esc(k)}</span><b>${v}</b>${src ? `<em>${esc(src)}</em>` : ''}</div>` : '');
  // the sheet's fact chips: with the investigation block present, the forensics group's "tied to N launches" claim is not shown (its operation replaces it)
  const chipFacts = (d) => (d.facts || []).filter((f) => !(invOf(d) && /^fx:more/.test(f.k || '')));
  const contractBody = (row) => {
    const d = row.data;
    if (!d) return `<div class="th-load"><span class="th-spin"></span><div><b>${TT('contract.loadingTitle')}</b><span>${TT('contract.loadingBody')}</span></div></div>`;
    if (d.error) return `<p class="lead">${TT('contract.unavailable')}</p>`;
    const id = d.identity || {}, dep = d.deployment || {}, m = d.market || {}, h = d.history || {}, cn = d.connections || {};
    const chain = id.chains?.length === 1 ? id.chains[0] : null;
    const metric = (x, fmt) => (x ? `${fmt(x.value)}` : '');
    const msrc = (x) => (x ? TX(x.stale ? 'contract.srcAgeStale' : 'contract.srcAge', {source: TR(x.source), ago: cxAgo(x.at)}) : '');
    const basis = {post: TX('contract.basis.post'), records: TX('contract.basis.records'), conflict: TX('contract.basis.conflict'), unconfirmed: TX('contract.basis.unconfirmed'), 'address format': TX('contract.basis.addressFormat')}[id.chainBasis] || '';
    const sec = (title, body) => (body.trim() ? `<div class="cx-sec"><h4>${title}</h4>${body}</div>` : '');
    const days = Object.entries(h.days || {});
    const max = Math.max(1, ...days.map(([, n]) => n));
    const bars = days.length ? `<div class="cx-bars">${Array.from({length: 14}, (_, i) => { const dd = new Date(Date.now() - (13 - i) * 864e5).toISOString().slice(0, 10); const n = h.days[dd] || 0; return `<i style="--h:${Math.round((n / max) * 100)}%;--n:${i}" title="${esc(TX('contract.barTitle', {date: dd, n}))}"></i>`; }).join('')}</div><div class="hq">${TT('contract.barsCaption')}</div>` : '';
    return `<p class="lead">${esc(d.headlineKey ? FX({text: d.headline, key: d.headlineKey, params: d.headlineParams}) : trAgo(d.headline))}</p>
      ${chipFacts(d).length ? `<div class="chips">${chipFacts(d).map((f) => `<span class="chip ${f.tone}">${esc(FX(f))}</span>`).join('')}</div>` : ''}
      ${sec(TT('sheet.title.identity'), cxRow(TX('contract.row.address'), `<span class="mono">${esc(cxShort(id.address))}</span> <button class="copy" data-copy="${esc(id.address)}">${TT('common.copy')}</button>`) + cxRow(TX('contract.row.chain'), chain ? `${esc(CX_CHAIN[chain] || chain)}` : esc(id.chains?.map((x) => CX_CHAIN[x] || x).join(', ') || TX('contract.unknown')), basis) + (id.symbols || []).map((x) => cxRow(TX('contract.row.ticker'), `$${esc(x.symbol)}`, x.sources.map((s) => TR(s)).join(', '))).join(''))}
      ${sec(TT('contract.sec.launch'), cxRow(TX('contract.row.launched'), dep.launchedAt ? esc(TX('contract.launchedAt', {date: new Date(dep.launchedAt).toISOString().slice(0, 10), ago: cxAgo(dep.launchedAt)})) : '', TR(dep.launchSource)) + (dep.launchpad ? cxRow(TX('contract.row.launchpad'), esc(TX(dep.launchpad.graduated ? 'contract.pons.graduated' : 'contract.pons.curve')), TR('launchpad index')) + cxRow(TX('contract.row.creator'), cxAddr('robinhood', dep.launchpad.creator) + (cn.creatorLaunches ? ` ${esc(TX('contract.creatorMade', {total: String(cn.creatorLaunches.total), graduated: String(cn.creatorLaunches.graduated)}))}` : ''), TR('launchpad index')) : '') + cxRow(TX('contract.row.deployer'), cxAddr(chain, dep.deployer) + (cn.deployerTokens ? ` ${esc(cn.deployerTokens.rugged ? TX('contract.deployerMadeRugged', {total: String(cn.deployerTokens.total), rugged: String(cn.deployerTokens.rugged)}) : TX('contract.deployerMade', {total: String(cn.deployerTokens.total)}))}` : ''), TR('tokens')) + cxRow(TX('contract.row.funder'), cxAddr(chain, dep.funder), TR('tokens')) + (dep.launch?.lines || []).filter((l) => !(invOf(d) && /same threat actors are tied to/i.test(l.text || ''))).map((l) => `<div class="rr ${esc(l.strength || '')}">${esc(FX(l))}</div>`).join(''))}
      ${sec(TT('contract.sec.market'), cxRow(TX('token.fact.liquidity'), metric(m.liquidity, cxUsd), msrc(m.liquidity)) + cxRow(TX('token.fact.mcap'), metric(m.mcap, cxUsd), msrc(m.mcap)) + cxRow(TX('contract.row.price'), metric(m.price, cxUsd), msrc(m.price)) + cxRow(TX('contract.row.honeypot'), m.honeypot ? (m.honeypot.value ? esc(TX('contract.honeypotYes')) : TT('common.no')) : '', msrc(m.honeypot)) + cxRow(TX('contract.row.sellTax'), m.sellTax ? `${m.sellTax.value}%` : '', msrc(m.sellTax)))}
      ${sec(TT('sheet.whoPosted'), (h.firstCaptured ? cxRow(TX('contract.row.firstCaptured'), TT('contract.firstCaptured', {who: RAW(`<a href="${esc(h.firstCaptured.url)}" target="_blank" rel="noopener">@${esc(h.firstCaptured.handle)}</a>`), ago: cxAgo(h.firstCaptured.at)}), TX('contract.src.firstSeen')) : '') + cxRow(TX('contract.row.posts'), h.posts ? esc(TX('contract.postsBy', {posts: String(h.posts), n: h.authors})) : '', TR('captured posts')) + (h.topAuthors || []).map((a) => `<div class="cx-a"><a href="https://x.com/${esc(a.handle)}" target="_blank" rel="noopener">@${esc(a.handle)}</a><span>${TT('contract.postCount', {n: a.posts})}</span>${a.smart ? `<i class="chip good">${TT('contract.chip.smart')}</i>` : ''}${a.listed ? `<i class="chip warn">${TT('contract.chip.listed')}</i>` : ''}</div>`).join('') + bars + (h.calls?.captured ? cxRow(TX('contract.row.calls'), esc(h.calls.best ? TX('contract.callsLineBest', {captured: String(h.calls.captured), measured: String(h.calls.measured), best: h.calls.best.toFixed(1)}) : TX('contract.callsLine', {captured: String(h.calls.captured), measured: String(h.calls.measured)})), TR('captured calls')) : ''))}
      ${sec(TT('contract.sec.connections'), (cn.trackedOperation ? cxRow(TX('contract.row.operation'), esc(FX({text: cn.trackedOperation.operation, key: cn.trackedOperation.key, params: cn.trackedOperation.params})), TR(cn.trackedOperation.basis)) : '') + (cn.copromotion ? cxRow(TX('contract.row.postedTogether'), esc(TX('contract.togetherLine', {n: String(cn.copromotion.accounts)})), TX('contract.src.coPromo')) : ''))}

      ${invSheet(d)}

      <div class="cx-foot"><button class="hc-open" data-live-scan>${TT('contract.runScan')}</button><span class="hq">${esc(d.noteKey ? FX({text: d.note, key: d.noteKey, params: d.noteParams}) : TR(d.note || ''))}</span></div>`;
  };
  const openContract = (ctx, label) => openSheet({tone: 'neutral', label: '', card: {rows: [{kind: 'contract', label, data: ctx}]}}, 0, theme());

  // Thesis sheet: opens instantly with a loading state, fills in when the server answers.
  const openThesis = (query, label) => {
    const row = {kind: 'thesis', state: 'loading'};
    const v = {tone: 'neutral', label, card: {rows: [row]}};
    const sheet = openSheet(v, 0, theme());
    chrome.runtime.sendMessage({type: 'thesis', query}).then((d) => {
      Object.assign(row, {state: 'done', data: d || {error: 'failed'}});
      sheet.repaint();
    }).catch(() => { Object.assign(row, {state: 'done', data: {error: 'failed'}}); sheet.repaint(); });
  };


  /* ---------------- Contract scanner: a risk underline on the $TICKER / CA in the post itself ---------------- */
  // Nothing is added to X's text: marks are drawn in an overlay positioned from the text's own layout (Range rects),
  // so selecting and copying a contract still works. Posts are scanned "lite" (no fresh launch forensics) as they
  // scroll in; hovering shows a floating card; the dot opens the full scan in the sheet.

  // tickers never matched to a coin card (majors, stocks): from the remote config's rules.majors
  let majorsFor = null, majorsSet = new Set();
  const MAJORS = {has: (x) => { if (majorsFor !== CFG.rules?.majors) { majorsFor = CFG.rules?.majors; majorsSet = new Set((majorsFor || []).map((m) => String(m).toUpperCase())); } return majorsSet.has(x); }};
  const EVM_RE = /0x[a-fA-F0-9]{40}/g;
  const SOL_RE = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;
  // Fable's own token (rules.ownTokens, empty until $FABLE launches): treated like an official token. No bundle line,
  // stamp, risk underline or red / amber pill from automated reads; the card keeps its chart and plain numbers.
  const OWN_TRACE = /bundl|linked wallets|of supply within|sniper|insider|threat actors|rug operation/i;
  const ownList = () => (Array.isArray(CFG.rules?.ownTokens) ? CFG.rules.ownTokens : []).map((a) => String(a).toLowerCase()).filter(Boolean);
  const ownToken = (addr) => !!addr && ownList().includes(String(addr).toLowerCase());
  const ownIn = (text) => { const t = String(text || '').toLowerCase(); return ownList().find((a) => t.includes(a)) || null; };
  // 0.29.3 (owner decision: $FABLE is Fable's official token): a post that names it, by the $FABLE ticker or by its contract anywhere in the post (text or a link), gets the OFFICIAL pill
  // and the account's dev / builder history and smart followers: no coin card (no chart, no bundle line, no investigation sections), no risk pill or red from any source, no stamp
  const FABLE_TOKEN = '0x14a64d6f3db9900be9c554d0961f539a16f43f9c';
  const fableOfficialPost = (tw) => !!tw && ownList().includes(FABLE_TOKEN) && ((tw.cashtags || []).some((x) => String(x).toUpperCase() === 'FABLE') || `${tw.text || ''} ${(tw.urls || []).join(' ')}`.toLowerCase().includes(FABLE_TOKEN));
  const OFFICIAL_PILL = (id) => ({id, source: 'fable', tone: 'legit', label: 'Fable', badge: 'OFFICIAL', stat: 'official', confidence: 1, official: true});
  const calmContract = (c) => {
    if (!c || c.error) return c;
    const facts = (c.facts || []).filter((f) => !OWN_TRACE.test(`${f.k || ''} ${f.text || ''}`)).map((f) => (f.tone === 'bad' || f.tone === 'warn' ? {...f, tone: ''} : f));
    return {...c, own: true, risk: null, facts, investigation: null, onchain: c.onchain ? {...c.onchain, launch: undefined} : c.onchain,
      connections: c.connections ? {...c.connections, shillWave: null} : c.connections};
  };
  // a pill about the coin itself becomes the official line; a pill about the poster stays (minus any bundle wording)
  const TOKEN_LABEL = /bundl|token|launch|of supply|rug operation|scam project|new project|honeypot/i;
  const calmOwn = (v) => {
    if (!v || v.self || v.curated || !ownList().length) return v;
    const tw = TWEETS.get(v.id);
    if (!ownIn(`${tw?.text || ''} ${(tw?.urls || []).join(' ')}`)) return v;
    const rows = (v.card?.rows || []).filter((r) => !(r?.kind === 'flags' && OWN_TRACE.test(`${r.title || ''} ${(r.lines || []).join(' ')}`)));
    if ((v.tone === 'rug' || v.tone === 'kol') && (TOKEN_LABEL.test(`${v.label || ''} ${v.stat || ''} ${v.detail || ''}`) || /BUNDLED|RUG|HONEYPOT|INSIDER/.test(v.stamp || ''))) {
      return {id: v.id, source: v.source, tone: 'self', label: `$${CFG.rules?.ownSymbol || 'FABLE'}`, badge: 'OFFICIAL', stat: 'official', confidence: 1, own: true,
        card: rows.length ? {...v.card, rows} : undefined};
    }
    const out = {...v, card: v.card?.rows ? {...v.card, rows} : v.card};
    if (/BUNDLED|INSIDER/.test(out.stamp || '')) delete out.stamp;
    if (out.detail && OWN_TRACE.test(out.detail)) delete out.detail;
    return out;
  };
  const tokensIn = (id, article) => {
    const t = TWEETS.get(id);
    const text = t?.text || [...article.querySelectorAll('[data-testid="tweetText"]')].map((e) => e.innerText).join(' ');
    const out = [];
    const seen = new Set();
    const add = (q, label, needle) => { const k = JSON.stringify(q); if (!seen.has(k) && out.length < 3) { seen.add(k); out.push({q, label, needle}); } };
    for (const m of text.match(EVM_RE) || []) add({address: m.toLowerCase()}, `${m.slice(0, 6)}…${m.slice(-4)}`, m);
    for (const m of text.replace(/0x[a-fA-F0-9]+/g, ' ').match(SOL_RE) || []) if (/\d/.test(m) && /[a-z]/.test(m) && /[A-Z]/.test(m)) add({address: m}, `${m.slice(0, 4)}…${m.slice(-4)}`, m);
    const tags = t?.cashtags?.length ? t.cashtags : cashtagsOf(text, []);
    if (!out.length) for (const c of tags) if (!MAJORS.has(c)) add({symbol: c}, `$${c}`, `$${c}`);
    return out.slice(0, 2);
  };

  // first occurrence of `needle` inside `root` as a Range (case-insensitive, may span text nodes)
  const findRange = (root, needle) => {
    const nodes = [];
    let all = '';
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) { nodes.push({n, at: all.length}); all += n.nodeValue; }
    const i = foldW(all).toLowerCase().indexOf(needle.toLowerCase()); // a full-width dollar sign on screen still matches (same length)
    if (i < 0) return null;
    const at = (pos) => { let k = nodes.length - 1; while (k > 0 && nodes[k].at > pos) k--; return {node: nodes[k].n, off: pos - nodes[k].at}; };
    const a = at(i), b = at(i + needle.length - 1);
    const r = document.createRange();
    r.setStart(a.node, a.off);
    r.setEnd(b.node, b.off + 1);
    return r;
  };

  // lite scans: at most 2 in flight, one per token per page
  const SCANS = new Map();
  const scanQ = [];
  let scanning = 0;
  const pump = () => {
    while (scanning < 2 && scanQ.length) {
      const {q, res} = scanQ.shift();
      scanning++;
      chrome.runtime.sendMessage({type: 'scan', query: {...q, lite: '1'}}).then(res).catch(() => res(null)).finally(() => { scanning--; pump(); });
    }
  };
  const scanLite = (q) => {
    const k = JSON.stringify(q);
    if (!SCANS.has(k)) SCANS.set(k, new Promise((res) => { scanQ.push({q, res}); pump(); }));
    return SCANS.get(k);
  };
  const levelOf = (d) => (!d ? 'unknown' : !d.found ? 'none' : d.level || 'unknown');

  const usd = (x) => (x == null ? '' : x >= 1e9 ? `$${(x / 1e9).toFixed(1)}B` : x >= 1e6 ? `$${(x / 1e6).toFixed(1)}M` : x >= 1e3 ? `$${Math.round(x / 1e3)}K` : `$${Math.round(x)}`);
  // a coin's age as "5m" / "3h" / "10d" in the active language (callers add the word "old" or leave it out)
  const ageDur = (h) => (h == null ? '' : h < 1 ? TX('time.dur.m', {n: String(Math.max(1, Math.round(h * 60)))}) : h < 48 ? TX('time.dur.h', {n: String(Math.round(h))}) : TX('time.dur.d', {n: String(Math.round(h / 24))}));
  const levelText = (lv) => ({danger: TX('token.level.danger'), caution: TX('token.level.caution'), ok: TX('token.level.ok'), unknown: TX('token.level.unknown'), none: TX('token.level.none')})[lv];
  const strip = (t) => String(t || '').replace(/\.$/, '');
  // launch forensics first (bundle line leads), then the other reasons, no repeats. `text` stays the server's English (the
  // repeat check compares it); `show` is the sentence in the active language (a fact's key + params when intel sent them)
  const reasonsOf = (d, n = 5) => {
    const launch = (d.launch?.lines || []).filter((l) => l.strength !== 'weak').sort((a, b) => Number(b.rule === 'bundle-v1') - Number(a.rule === 'bundle-v1'));
    const shown = new Set(launch.map((l) => strip(l.text)));
    return [...launch.map((l) => ({text: strip(l.text), show: strip(FX(l)), strength: l.strength})), ...(d.reasons || []).filter((r) => !shown.has(strip(r.text))).map((r) => ({...r, show: FX(r)}))].slice(0, n);
  };
  const EXPLORER = {robinhood: 'https://robinhoodchain.blockscout.com/token/', base: 'https://basescan.org/token/', ethereum: 'https://etherscan.io/token/', solana: 'https://solscan.io/token/', bsc: 'https://bscscan.com/token/'};

  // bundle bar: share of supply the launch bundle took, and what it still holds when known
  const bundleHTML = (b, big) => {
    if (!b || !b.flagged || b.supplyPct == null) return '';
    const took = Math.min(100, Math.round(b.supplyPct));
    const held = b.heldPct != null ? Math.min(took, Math.round(b.heldPct)) : null;
    const how = [
      b.kind === 'declared' ? TX('token.how.registered', {n: String(b.declared?.wallets || b.wallets)}) : '',
      b.declared?.reused >= 3 ? TX('token.how.reused', {n: String(b.declared.reused)}) : '',
      b.tooling?.kind === 'bundler' ? TX('token.how.bundler') : '',
      b.sameFunder ? TX('token.how.funder', {n: String(b.sameFunder)}) : '', b.sameTx ? TX('token.how.sameTx', {n: String(b.sameTx)}) : '',
      b.kind !== 'declared' && b.freshShare != null ? TX('token.how.fresh', {pct: String(Math.round(b.freshShare * 100))}) : ''].filter(Boolean);
    return `<div class="bnd ${big ? 'big' : ''}">
      <div class="bnd-h"><b>${TT('token.bundle.took', {pct: String(took)})}</b><span>${held != null ? TT('token.bundle.walletsHeld', {n: b.wallets, held: String(held)}) : TT('token.bundle.wallets', {n: b.wallets})}</span></div>
      <div class="bnd-bar"><i class="took" style="--w:${took}%"></i>${held != null ? `<i class="held" style="--w:${held}%"></i>` : ''}</div>
      ${big && how.length ? `<div class="bnd-how">${how.map(esc).join(' · ')}</div>` : ''}</div>`;
  };

  const hoverHTML = (tok, d) => {
    if (d?.own) return `<div class="hc-h"><b>$${esc(CFG.rules?.ownSymbol || 'FABLE')}</b><span class="hc-lv ok">${TT('hover.official')}</span></div><div class="hc-s">${TT('hover.own')}</div>`;
    if (d === undefined) return `<div class="hc-h"><b>${esc(tok.label)}</b><span class="hc-lv unknown">${TT('hover.scanning')}</span></div><div class="hc-sk"><i></i><i></i><i></i></div>`;
    if (!d) return `<div class="hc-h"><b>${esc(tok.label)}</b></div><div class="hc-s">${TT('hover.unavailable')}</div>`;
    if (!d.found) return `<div class="hc-h"><b>${esc(tok.label)}</b><span class="hc-lv none">${TT('token.level.none')}</span></div><div class="hc-s">${TT('hover.noMarket')}</div>`;
    const lv = levelOf(d);
    const rows = reasonsOf(d, 3);
    const p = d.promoters || {};
    return `<div class="hc-h"><b>$${esc(d.symbol || '')}</b><span class="hc-chain">${esc(d.chain)}</span><span class="hc-lv ${lv}">${esc(levelText(lv))}</span></div>
      <div class="hc-m">${[usd(d.liquidityUsd) && `<span>${TT('hover.liq', {v: usd(d.liquidityUsd)})}</span>`, usd(d.mcapUsd) && `<span>${TT('hover.mcap', {v: usd(d.mcapUsd)})}</span>`, d.ageHours != null && `<span>${TT('hover.old', {age: ageDur(d.ageHours)})}</span>`].filter(Boolean).join('')}</div>
      ${bundleHTML(d.launch?.bundle, false)}
      ${rows.length ? `<div class="hc-r">${rows.map((r, n) => `<div class="rr ${r.strength}" style="--i:${n}">${esc(r.show)}</div>`).join('')}</div>` : `<div class="hc-r"><div class="rr ok">${TT('token.noFlags')}</div></div>`}
      ${p.kolPush?.n >= 2 ? `<div class="hc-p warn">${TT('hover.kolPush', {n: p.kolPush.n})}</div>` : p.count ? `<div class="hc-p">${p.first?.length ? TT('hover.postedByWho', {n: p.count, who: p.first.slice(0, 2).map((x) => `@${x.handle}`).join(', ')}) : TT('hover.postedBy', {n: p.count})}</div>` : ''}
      <div class="hc-f"><button class="hc-open" data-open>${TT('hover.fullScan')}</button>${d.address ? `<button class="hc-ghost" data-copy="${esc(d.address)}">${TT('token.copyCa')}</button>` : ''}${!d.launch && d.address ? `<span class="hc-note">${TT('hover.launchNote')}</span>` : ''}</div>`;
  };

  // the sheet version: everything we know about the token
  const tokenBody = (row) => {
    const d = row.data;
    if (row.state === 'loading' && !d) return `<div class="th-load"><span class="th-spin"></span><div><b>${TT('token.scanningTitle', {label: row.label})}</b><span>${TT('token.scanningBody')}</span></div></div>`;
    if (!d || !d.found) return `<p class="lead">${!d ? TT('token.err.failed') : TT('token.err.noMarket')}</p>`;
    const lv = levelOf(d);
    const b = d.launch?.bundle;
    const p = d.promoters || {};
    // [label, value, red]: only the drop from the peak turns red, at 85% or more
    const facts = [[TX('token.fact.liquidity'), usd(d.liquidityUsd)], [TX('token.fact.mcap'), usd(d.mcapUsd)], [TX('token.fact.age'), ageDur(d.ageHours)], [TX('token.fact.fromPeak'), d.fromPeak != null ? `-${Math.round(d.fromPeak * 100)}%` : '', d.fromPeak >= 0.85],
      [TX('token.fact.top10'), d.launch?.top10Pct != null ? `${Math.round(d.launch.top10Pct)}%` : ''], [TX('token.fact.devSold'), d.launch?.devSold ? (d.launch.devSold.minutes != null ? TX('token.devSoldIn', {pct: String(Math.round(d.launch.devSold.pct)), dur: TX('time.dur.m', {n: String(d.launch.devSold.minutes)})}) : `${Math.round(d.launch.devSold.pct)}%`) : '']].filter(([, v]) => v);
    return `<div class="th-top"><span class="th-av th-mono">${esc((d.symbol || '?').slice(0, 1))}</span>
        <div class="th-id"><b>$${esc(d.symbol || '')}</b><span>${esc(d.chain)}${d.address ? ` · ${esc(d.address.slice(0, 6))}…${esc(d.address.slice(-4))}` : ''}</span></div>
        <span class="hc-lv ${lv} lg">${esc(levelText(lv))}</span></div>
      ${row.state === 'loading' ? `<div class="tk-pend"><span class="th-spin sm"></span>${TT('token.forensics')}</div>` : ''}
      ${facts.length ? `<div class="th-sec"><div class="th-facts">${facts.map(([k, v, red], n) => `<div class="th-f" style="--i:${n}"><span>${esc(k)}</span><b class="${red ? 'red' : ''}">${esc(v)}</b></div>`).join('')}</div></div>` : ''}
      ${b?.flagged ? `<div class="th-sec"><h4>${TT('token.h.bundle')}</h4>${bundleHTML({...b, heldPct: d.launch?.bundle?.heldPct}, true)}${b.tx ? `<a class="tk-tx" href="${esc((EXPLORER[d.chain] || '').replace('/token/', '/tx/'))}${esc(b.tx)}" target="_blank" rel="noopener">${TT('token.viewBundleTx')}</a>` : ''}</div>` : ''}
      <div class="th-sec"><h4>${TT('token.h.found')}</h4>${reasonsOf(d, 12).map((r, n) => `<div class="rr ${r.strength}" style="--i:${n}">${esc(r.show)}</div>`).join('') || `<div class="rr ok">${TT('token.noFlags')}</div>`}</div>
      ${p.count ? `<div class="th-sec"><h4>${TT('sheet.whoPosted')}</h4>${(p.first || []).map((x, n) => `<a class="line" href="https://x.com/${esc(x.handle)}" target="_blank" rel="noopener" style="--i:${n}"><div class="who"><b>@${esc(x.handle)}</b><span>${x.followers != null ? TT('token.followers', {n: Number(x.followers)}) : ''}</span></div><div class="meta">${x.ring ? `<span class="amber">${TT('token.tag.ring')}</span>` : ''}${x.poor ? `<span class="red">${TT('token.tag.dead')}</span>` : ''}</div></a>`).join('')}
        ${p.kolPush?.n >= 2 ? `<p class="lead red" style="margin-top:10px">${TT('token.kolPushWho', {n: p.kolPush.n, kols: (p.kolPush.kols || []).slice(0, 4).map((h) => `@${h}`).join(', ')})}</p>` : ''}</div>` : ''}
      <div class="tk-acts"><button class="tp-th" data-thesis>${TT('token.whatIs', {sym: `$${d.symbol || 'this'}`})}</button>
        ${d.pairUrl ? `<a class="th-srcb" href="${esc(d.pairUrl)}" target="_blank" rel="noopener">${TT('sheet.chart')}</a>` : ''}
        ${d.address && EXPLORER[d.chain] ? `<a class="th-srcb" href="${esc(EXPLORER[d.chain] + d.address)}" target="_blank" rel="noopener">${TT('token.explorer')}</a>` : ''}
        ${d.address ? `<button class="copy" data-copy="${esc(d.address)}">${TT('token.copyCa')}</button>` : ''}</div>`;
  };

  const openToken = (tok, lite) => {
    const row = {kind: 'token', state: 'loading', label: tok.label, data: lite && lite.found ? lite : null};
    const v = {tone: lite?.level === 'danger' ? 'rug' : lite?.level === 'caution' ? 'kol' : 'neutral', label: lite ? levelText(levelOf(lite)) : TX('hover.scanning'), card: {rows: [row]}};
    const sheet = openSheet(v, 0, theme());
    let tries = 0;
    const full = (retry) => chrome.runtime.sendMessage({type: 'scan', query: {...tok.q, ...(retry ? {retry: String(retry)} : {})}}).then((d) => {
      // the server finishes a slow launch scan in the background: ask again a few times
      if (d?.pending && tries++ < 3) { Object.assign(row, {data: d}); sheet.repaint(); return setTimeout(() => full(tries), 4000); }
      Object.assign(row, {state: 'done', data: d ? {...d, pending: false} : row.data});
      v.label = levelText(levelOf(row.data));
      v.tone = row.data?.level === 'danger' ? 'rug' : row.data?.level === 'caution' ? 'kol' : 'neutral';
      sheet.repaint();
    }).catch(() => { Object.assign(row, {state: 'done'}); sheet.repaint(); });
    full(0);
  };

  // one floating card for the whole page (a card inside the post gets clipped by X's feed cells)
  let hc = null, hcTok = null, hcHide = null;
  const hoverCard = () => {
    if (hc?.isConnected) return hc;
    hc = document.createElement('div');
    hc.setAttribute('data-fable-hover', '');
    // its own top layer: stamps and X's sticky headers must never paint over the card
    hc.style.cssText = 'position:fixed;inset:0;z-index:2147483000;pointer-events:none;';
    document.body.appendChild(hc);
    const root = hc.attachShadow({mode: 'open'});
    root.innerHTML = `${styleFor(root)}<div lang="${LANG()}" class="fable hcw"><div class="hc"></div></div>`;
    const card = root.querySelector('.hc');
    card.addEventListener('mouseenter', () => clearTimeout(hcHide));
    card.addEventListener('mouseleave', () => hideCard(160));
    card.addEventListener('click', (e) => {
      const c = e.target.closest('[data-copy]');
      if (c) { e.stopPropagation(); navigator.clipboard.writeText(c.dataset.copy).then(() => { c.textContent = TX('common.copied'); }); return; }
      if (e.target.closest('[data-open]') && hcTok) { const {tok, d} = hcTok; hideCard(0); openToken(tok, d); }
    });
    return hc;
  };
  const hideCard = (ms) => {
    clearTimeout(hcHide);
    hcHide = setTimeout(() => {
      const w = hc?.shadowRoot?.querySelector('.hcw');
      if (w) w.classList.remove('show');
      hcTok = null;
    }, ms);
  };
  const showCard = (tok, rect, d) => {
    clearTimeout(hcHide);
    const host = hoverCard();
    const w = host.shadowRoot.querySelector('.hcw');
    w.lang = LANG(); w.className = `fable hcw ${theme()} ${w.classList.contains('show') ? 'show' : ''}`;
    const card = w.querySelector('.hc');
    card.innerHTML = hoverHTML(tok, d);
    hcTok = {tok, d};
    const W = 320, gap = 8;
    const h = card.offsetHeight || 180;
    const below = rect.bottom + gap + h < innerHeight - 8;
    card.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - W - 8))}px`;
    card.style.top = `${below ? rect.bottom + gap : Math.max(8, rect.top - gap - h)}px`;
    card.dataset.side = below ? 'b' : 't';
    requestAnimationFrame(() => w.classList.add('show'));
  };
  addEventListener('scroll', () => hc && hideCard(0), {passive: true});

  const tkIO = new IntersectionObserver((entries) => {
    for (const en of entries) if (en.isIntersecting) { tkIO.unobserve(en.target); en.target.__fableScan?.(); }
  }, {rootMargin: '200px 0px'});

  const markTokens = (article, v, textEl, t) => {
    const toks = tokensIn(v.id, article).map((tok) => ({...tok, range: findRange(textEl, tok.needle)})).filter((x) => x.range);
    if (!toks.length) return;
    const host = document.createElement('div');
    host.setAttribute('data-fable-host', 'tokens');
    host.className = 'fable-tk-host';
    article.appendChild(host);
    const root = host.attachShadow({mode: 'open'});
    root.innerHTML = `${styleFor(root)}<div lang="${LANG()}" class="fable tkl ${t}"></div>`;
    const layer = root.querySelector('.tkl');
    const data = toks.map(() => undefined);
    const level = (n) => (data[n] === undefined ? 'loading' : levelOf(data[n]));
    const paint = () => {
      const a = article.getBoundingClientRect();
      layer.innerHTML = toks.map((tok, n) => {
        // X re-renders post text ("Show more", edits): find the token again in the live text
        if (!tok.range.startContainer.isConnected) {
          const te = [...article.querySelectorAll('[data-testid="tweetText"]')].find((el) => !el.closest('[role="link"][tabindex]'));
          tok.range = (te && findRange(te, tok.needle)) || tok.range;
        }
        const rs = [...tok.range.getClientRects()].filter((r) => r.width > 0);
        if (!rs.length) return '';
        const lv = level(n);
        const last = rs[rs.length - 1];
        return rs.map((r) => `<i class="tk-u lv-${lv}" style="left:${r.left - a.left}px;top:${r.bottom - a.top - 2}px;width:${r.width}px"></i>`).join('')
          + `<button class="tk-dot lv-${lv}" data-n="${n}" title="${esc(TX('token.dotTitle'))}" style="left:${last.right - a.left + 1}px;top:${last.top - a.top + 3}px"><i></i></button>`;
      }).join('');
      requestAnimationFrame(() => layer.classList.add('on'));
    };
    paint();
    new ResizeObserver(paint).observe(article);
    host.__fableScan = () => toks.forEach((tok, n) => (ownToken(tok.q.address) ? Promise.resolve({found: true, level: 'ok', own: true, reasons: []}) : scanLite(tok.q)).then((d) => {
      data[n] = d;
      paint();
      if (hcTok?.tok === tok) showCard(tok, tok.range.getBoundingClientRect(), d);
    }));
    tkIO.observe(host);
    layer.addEventListener('click', (e) => {
      const b = e.target.closest('.tk-dot');
      if (!b) return;
      e.preventDefault(); e.stopPropagation(); // don't open the tweet underneath
      const n = Number(b.dataset.n);
      hideCard(0);
      if (data[n]?.own) return; // Fable's own token: no scan sheet
      openToken(toks[n], data[n]);
    });
    // hover: hit-test the token's own text rects, so the post text keeps working normally
    let over = -1;
    article.addEventListener('mousemove', (e) => {
      let hit = -1;
      toks.forEach((tok, n) => {
        for (const r of tok.range.getClientRects()) if (e.clientX >= r.left - 2 && e.clientX <= r.right + 12 && e.clientY >= r.top - 2 && e.clientY <= r.bottom + 2) hit = n;
      });
      if (hit === over) return;
      over = hit;
      if (hit < 0) return hideCard(200);
      const tok = toks[hit];
      host.__fableScan?.();
      clearTimeout(hcHide);
      hcHide = setTimeout(() => showCard(tok, tok.range.getBoundingClientRect(), data[hit]), 160);
    }, {passive: true});
    article.addEventListener('mouseleave', () => { over = -1; hideCard(200); });
  };

  /* ---------------- Profile page: the full Backstory under the bio ---------------- */

  const PROFILE_PATH = /^\/([A-Za-z0-9_]{1,15})(?:\/(?:with_replies|media|highlights|articles|likes|superfollows))?\/?$/;
  const RESERVED = new Set(['home', 'explore', 'notifications', 'messages', 'i', 'settings', 'search', 'compose', 'jobs', 'communities', 'premium', 'lists', 'bookmarks', 'tos', 'privacy']);
  let profileFor = null;
  const PANEL_KNOWN = new Set(); // handles whose panel had something to show on this page load
  const PANEL_NONE = new Map(); // handle -> when the API had no verdict and intel no record: not asked again for 20 s (every scan used to ask the API again)
  const profilePanel = () => {
    if (!settings.profilePanel || !settings.enabled) return document.querySelector('[data-fable-profile]')?.remove();
    const m = (window.__fablePath || location.pathname).match(PROFILE_PATH);
    const handle = m && !RESERVED.has(m[1].toLowerCase()) ? m[1] : null;
    const existing = document.querySelector('[data-fable-profile]');
    if (!handle) { existing?.remove(); profileFor = null; return; }
    intelGet(`h:${handle.toLowerCase()}`, {type: 'history', handle}); // the record is asked for the moment the page is a profile, before X has drawn the header
    if (existing && existing.dataset.fableProfile.toLowerCase() === handle.toLowerCase() && existing.isConnected) return;
    if (performance.now() - (PANEL_NONE.get(handle.toLowerCase()) ?? -1e9) < 20e3) return;
    const anchor = document.querySelector('[data-testid="UserProfileHeader_Items"]') || document.querySelector('[data-testid="UserDescription"]');
    if (!anchor || profileFor === `${handle}:pending`) return;
    existing?.remove();
    profileFor = `${handle}:pending`;
    const host = document.createElement('div');
    host.setAttribute('data-fable-profile', handle);
    host.style.margin = '12px 0 4px';
    anchor.insertAdjacentElement('afterend', host);
    const id = USER_IDS.get(handle.toLowerCase()) || null;
    // 0.29.2: the panel no longer waits for api.fable.market /v1/profile: the account's record (intel /v1/history, 30 to 80 ms) draws the moment intel answers, with the panel's frame, whatever the API does; the API's verdict joins
    // the panel, above the record, when it comes. A profile with neither (the API has no verdict, intel no record) has no panel, as before: the frame is never drawn for nothing.
    // 0.28: the account's promotion record (intel /v1/history `promo`, judged calls only) joins the panel when it arrives
    const histP = intelGet(`h:${handle.toLowerCase()}`, {type: 'history', handle}).catch(() => null);
    const recordOf = (h) => (h && !h.error && h.promo ? promoRecord(h.promo, handle) : '');
    // 0.29.1: the account's own posts do not draw its history again (authorSlot), so the panel carries it once: the judged promotion record, else the history card
    // the first post would have drawn (promotion history, build history or activity)
    const historyOf = (h) => (h && !h.error && h.days && on('cards') ? authorCardFor(h) : '');
    const recOrHist = (h) => `${badplayCard(h, handle)}${recordOf(h) || historyOf(h)}`; // 0.30.0: the proven flags first, then the record
    let root = null, pv = null, gotRecord = false;
    const mount = () => {
      if (root || !host.isConnected) return root;
      const bio = document.querySelector('[data-testid="UserDescription"]')?.innerText || '';
      const project = /\$[A-Za-z][A-Za-z0-9]{1,9}\b|0x[a-fA-F0-9]{40}|\b(memecoin|meme coin|token|nfts?|collection|mint|pump\.fun|dexscreener|launchpad|ca:)/i.test(bio);
      const thesisLine = `<button class="thesis-line" data-thesis>${fox('fox')}<span>${project ? TT('profile.thesisProject', {handle}) : TT('profile.thesisPerson', {handle})}</span><svg class="chev" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg></button>`;
      root = mountShadow(host, `<div class="profile-panel">${thesisLine}<div data-pslot="v"></div><div data-pslot="r"></div></div>`, theme(), false, null);
      root?.querySelector?.('[data-thesis]')?.addEventListener('click', () => openThesis({handle}, `@${handle}`));
      // a tap on the verdict's card opens its sheet (the verdict arrives after the frame: read it at the click)
      root?.addEventListener('click', (e) => {
        const el = e.target.closest('.tap');
        if (!el || !pv?.card?.rows) return;
        e.preventDefault();
        e.stopPropagation(); // don't open the post underneath
        openSheet(pv, Number(el.dataset.k || 0), theme());
      });
      return root;
    };
    const fill = (slot, html) => {
      const r = mount(), el = r?.querySelector(`[data-pslot="${slot}"]`);
      if (!el || !html) return;
      const tpl = document.createElement('template');
      tpl.innerHTML = html;
      el.replaceChildren(tpl.content);
      hideBroken(r);
      PANEL_KNOWN.add(handle.toLowerCase());
    };
    // a profile whose panel had something to show earlier on this page load: the frame is up at once
    if (PANEL_KNOWN.has(handle.toLowerCase())) mount();
    // the record: the moment intel answers
    const recordDone = histP.then((h) => {
      if (!host.isConnected) return;
      const rec = recOrHist(h);
      if (!rec) return;
      gotRecord = true;
      fill('r', rec);
    });
    chrome.runtime.sendMessage({type: 'profile', handle, id}).catch(() => null).then(async (res) => {
      profileFor = handle;
      if (!host.isConnected) return;
      // 0.29.2: a profile verdict "Promoted tracked rugs" stands only on the account's judged promotion record (promotes only); without it the panel is as if the API had no verdict
      let verdict = res?.verdict;
      if (verdict && needsProof(verdict) && !trackedProof(await histP)) verdict = null;
      await recordDone;
      if (!host.isConnected) return;
      // no verdict from the API: the panel is there only when there is a record
      if (!verdict) { if (!gotRecord) { root = null; host.remove(); PANEL_NONE.set(handle.toLowerCase(), performance.now()); } return; }
      const v = {...verdict, id: `profile:${handle}`};
      pv = v;
      // 0.30.0: the empty "Nothing on record yet / No flags ... found" card is not drawn next to a record or proven flags the panel already shows (it contradicted them)
      const body = v.self ? ctxHTML(v)
        : v.card?.rows
        ? ctxHTML(v) + cardHTML(v.card)
        : gotRecord ? ctxHTML(v)
        : ctxHTML(v) + `<div class="expand"><div><div class="card"><div class="head">${fox('fox lg')}<b>Fable</b><span class="kicker">${TT('profile.kicker')}</span></div><div class="sigs"><div class="sig muted"><div class="txt"><b>${TT('profile.empty.title')}</b><span>${TT('profile.empty.body', {handle})}</span></div></div></div></div></div></div>`;
      fill('v', body);
    }).catch(() => { profileFor = null; if (!gotRecord) { host.remove(); PANEL_NONE.set(handle.toLowerCase(), performance.now()); } });
  };

  // The full card unfolds in the feed only for warnings worth interrupting a scroll for. Everything else is one tappable line.
  const IMPORTANT = new Set(['Promoted tracked rugs', 'Scam KOL network', 'Reported shill account', 'Rug history', 'Linked to rugs', 'Token collapsed', 'Bundled launch', 'Token risk', 'Scam', 'New project, high risk', 'Promotion ring', 'Poor call record', 'New project', 'Project', 'Scam KOL push', 'Possible hacked account', 'Scam project', 'Impersonator', 'Phishing link', 'Fake giveaway', 'Seed phrase ask', 'Fake support', 'Recovery scam', 'Fake claim', 'Scam pattern']);
  /* ---------------- Smart money feed in X's right sidebar (owner, 2026-09-30): what the smart accounts are doing right now ----------------
     Two kinds of row from intel /v1/smartfeed: smart accounts that just followed someone, and coins smart accounts just posted.
     A coin only shows up here when smart money touched it. Several smart accounts on the same thing rank first. */
  const TWINS = ['1h', '6h', '24h'];
  let trendWin = '6h', trendData = null, trendAt = 0, trendBusy = false, trendOpen = false;
  try { const w = localStorage.getItem('fable-feed-window'); if (TWINS.includes(w)) trendWin = w; } catch {}
  const TREND_CSS = `
    :host { all: initial; display: block; margin-bottom: 16px; }
    .p { --t1: #0f1419; --t2: #536471; --t3: #8b98a5; --line: #eff3f4; --bg: #fff; --chip: #eff3f4; --hover: rgba(0,0,0,.03); --green: #00a36c; --blue: #1d9bf0;
      font: 15px/20px TwitterChirp, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: var(--t1); background: var(--bg);
      border: 1px solid var(--line); border-radius: 16px; overflow: hidden; -webkit-font-smoothing: antialiased; }
    .p.dim { --t1: #f7f9f9; --t2: #8b98a5; --t3: #6e7c8a; --line: #38444d; --bg: #15202b; --chip: #273340; --hover: rgba(255,255,255,.03); --green: #1fc28a; }
    .p.dark { --t1: #e7e9ea; --t2: #71767b; --t3: #5b6066; --line: #2f3336; --bg: #000; --chip: #202327; --hover: rgba(255,255,255,.03); --green: #1fc28a; }
    .hd { display: flex; align-items: center; gap: 8px; padding: 12px 16px 6px; }
    .hd img { width: 16px; height: 16px; }
    .hd b { font-size: 20px; line-height: 24px; font-weight: 800; letter-spacing: -.01em; }
    .live { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; font-weight: 700; color: var(--green); }
    .live i { width: 6px; height: 6px; border-radius: 50%; background: var(--green); animation: pulse 2s ease-in-out infinite; }
    @keyframes pulse { 0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--green) 45%, transparent); } 50% { box-shadow: 0 0 0 4px transparent; } }
    .hd .term { margin-left: auto; font-size: 12.5px; font-weight: 700; color: #5b7fff; padding: 3px 9px; border-radius: 999px; background: color-mix(in srgb, #5b7fff 12%, transparent); text-decoration: none; }
    .hd .term:hover { background: color-mix(in srgb, #5b7fff 20%, transparent); }
    .win { display: flex; gap: 2px; padding: 0 16px 6px; }
    .win button { all: unset; cursor: pointer; font-size: 12px; font-weight: 700; color: var(--t2); padding: 3px 9px; border-radius: 999px; transition: background .15s, color .15s; }
    .win button:hover { background: var(--hover); }
    .win button.on { background: var(--chip); color: var(--t1); }
    .row { display: flex; gap: 10px; padding: 10px 16px; cursor: pointer; text-decoration: none; color: inherit; transition: background .15s; animation: up .3s cubic-bezier(.2,0,0,1) both; }
    .row:hover { background: var(--hover); }
    @keyframes up { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: none; } }
    .av { width: 40px; height: 40px; border-radius: 50%; flex-shrink: 0; background: var(--chip); object-fit: cover; display: block; }
    .coin .av { border-radius: 10px; }
    .av.mono { display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 800; letter-spacing: -.02em; color: #5b7fff; background: color-mix(in srgb, #5b7fff 14%, var(--bg)); }
    .av.mono.w4 { font-size: 11px; }
    .bd { min-width: 0; flex: 1; }
    .what { font-size: 14px; line-height: 18px; color: var(--t2); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .what b { color: var(--t1); font-weight: 700; }
    .sub { display: flex; align-items: center; gap: 6px; margin-top: 3px; font-size: 13px; line-height: 16px; color: var(--t2); min-width: 0; white-space: nowrap; overflow: hidden; }
    .sub span { overflow: hidden; text-overflow: ellipsis; }
    .sub .mc { font-weight: 700; color: var(--t1); flex-shrink: 0; }
    .sub .sm { font-size: 11px; font-weight: 800; letter-spacing: .04em; color: var(--green); flex-shrink: 0; }
    .by { display: flex; align-items: center; gap: 6px; margin-top: 6px; font-size: 12px; line-height: 16px; color: var(--t3); min-width: 0; white-space: nowrap; }
    .by > span:not(.faces):not(.t) { overflow: hidden; text-overflow: ellipsis; min-width: 0; }
    .faces { display: flex; flex-shrink: 0; }
    .faces img, .faces i { width: 18px; height: 18px; border-radius: 50%; margin-left: -5px; box-shadow: 0 0 0 1.5px var(--bg); background: var(--chip); display: block; object-fit: cover; }
    .faces :first-child { margin-left: 0; }
    .tag { font-size: 11px; font-weight: 700; letter-spacing: .03em; color: var(--t2); background: var(--chip); padding: 1px 6px; border-radius: 4px; }
    .t { margin-left: auto; flex-shrink: 0; padding-left: 4px; }
    .n2 { font-weight: 700; color: var(--t2); }
    .more { all: unset; display: block; cursor: pointer; padding: 12px 16px; color: var(--blue); font-size: 15px; transition: background .15s; }
    .more:hover { background: var(--hover); }
    .msg { padding: 10px 16px 16px; font-size: 13px; line-height: 18px; color: var(--t2); }
    .msg button { all: unset; cursor: pointer; color: var(--blue); font-weight: 700; }
  `;
  const agoShort = (at) => {
    const m = Math.max(0, Math.round((Date.now() - at) / 60e3));
    return m < 1 ? TX('time.now') : m < 60 ? TX('time.dur.m', {n: m}) : m < 1440 ? TX('time.dur.h', {n: Math.round(m / 60)}) : TX('time.dur.d', {n: Math.round(m / 1440)});
  };
  // the server's tag is "VC" or "VC · DRAGONFLY": the category is translated, the organisation (a name) stays as is
  const tagTx = (tag) => { const [cat, ...org] = String(tag).split(' · '); return [TR(cat), ...org].join(' · '); };
  const kShort = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1).replace(/\.0$/, '')}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(/\.0$/, '')}K` : String(Math.round(n)));
  // a picture, or the first letters on a cobalt tile when X or the coin has none
  const avOf = (src, word, n = 4) => {
    if (src) return `<img class="av" src="${esc(src)}" alt="">`;
    const w = String(word || '').replace(/[^A-Za-z0-9]/g, '').slice(0, n).toUpperCase() || '?';
    return `<span class="av mono${w.length > 3 ? ' w4' : ''}">${esc(w)}</span>`;
  };
  const facesOf = (by) => `<span class="faces">${by.slice(0, 4).map((b) => (b.avatar ? `<img src="${esc(b.avatar)}" title="@${esc(b.handle)}" alt="">` : '<i></i>')).join('')}</span>`;
  // one smart account by name, or "3 smart accounts" for a group; one whole sentence per case; the line under it names who
  const whoSay = (it, oneKey, groupKey, p) => (it.n >= 2 ? TT(groupKey, {...p, n: it.n}) : TT(oneKey, {...p, name: it.by[0]?.name || it.by[0]?.handle || ''}));
  const byLine = (it) => {
    const first = it.by[0] || {};
    const names = it.n >= 2 ? `<span class="n2">@${esc(it.by.slice(0, 2).map((b) => b.handle).join(', @'))}${it.n > 2 ? ` +${NUM(it.n - 2)}` : ''}</span>` : `<span>@${esc(first.handle || '')}</span>`;
    const tag = it.n < 2 && first.tag ? `<span class="tag">${esc(tagTx(first.tag))}</span>` : '';
    return `<div class="by">${facesOf(it.by)}${names}${tag}<span class="t">${esc(agoShort(it.at))}</span></div>`;
  };
  const feedRow = (it, i) => {
    const delay = `style="animation-delay:${i * 30}ms"`;
    // one smart account that followed several accounts: its face, the accounts' faces, a tap opens its Following list
    if (it.type === 'follows') {
      const who = it.by[0] || {};
      const names = it.targets.slice(0, 2).map((t) => `@${t.handle}`).join(', ') + (it.count > 2 ? ` +${NUM(it.count - 2)}` : '');
      return `<a class="row" href="/${esc(who.handle)}/following" data-go="/${esc(who.handle)}/following" ${delay}>
        ${avOf(who.avatar, who.name || who.handle, 1)}
        <div class="bd">
          <div class="what">${TT('feed.followedMany', {name: who.name || who.handle, n: it.count})}</div>
          <div class="sub">${facesOf(it.targets)}<span>${esc(names)}</span></div>
          <div class="by"><span>@${esc(who.handle)}</span>${who.tag ? `<span class="tag">${esc(tagTx(who.tag))}</span>` : ''}<span class="t">${esc(agoShort(it.at))}</span></div>
        </div>
      </a>`;
    }
    if (it.type === 'follow') {
      const t = it.target;
      return `<a class="row" href="/${esc(t.handle)}" data-go="/${esc(t.handle)}" ${delay}>
        ${avOf(t.avatar, t.name || t.handle, 1)}
        <div class="bd">
          <div class="what">${whoSay(it, 'feed.followed', 'feed.followedGroup', {handle: t.handle})}</div>
          <div class="sub">${t.name && t.name !== t.handle ? `<span>${esc(t.name)}</span>` : ''}${t.followers != null ? `<span>${TT('feed.followers', {n: kShort(t.followers)})}</span>` : ''}${t.smart ? `<span class="sm">${TT('feed.smart')}</span>` : ''}</div>
          ${byLine(it)}
        </div>
      </a>`;
    }
    const sym = it.symbol ? `$${it.symbol}` : it.ticker ? `$${it.ticker}` : `${it.address.slice(0, 6)}..${it.address.slice(-4)}`;
    const go = it.tweet && it.by[0] ? `/${it.by[0].handle}/status/${it.tweet}` : `/search?q=${encodeURIComponent(it.address || `$${it.ticker}`)}&f=live`;
    return `<a class="row coin" href="${esc(go)}" data-go="${esc(go)}" ${delay}>
        ${avOf(it.image, it.symbol || it.ticker || it.address.slice(0, 3))}
        <div class="bd">
          <div class="what">${whoSay(it, 'feed.posted', 'feed.postedGroup', {coin: sym})}</div>
          ${it.mcap ? `<div class="sub"><span class="mc">$${kShort(it.mcap)}</span><span>${TT('feed.marketCap')}</span></div>` : ''}
          ${byLine(it)}
        </div>
      </a>`;
  };
  const trendHTML = () => {
    const items = trendData?.items || [];
    const shown = trendOpen ? items.slice(0, 15) : items.slice(0, 5);
    const wider = TWINS[TWINS.indexOf(trendWin) + 1];
    const body = !trendData ? `<div class="msg">${TT('trend.loading')}</div>`
      : items.length ? shown.map(feedRow).join('') + (items.length > 5 ? `<button class="more" data-more>${trendOpen ? TT('trend.showLess') : TT('trend.showMore', {n: Math.min(items.length, 15) - 5})}</button>` : '')
        : `<div class="msg">${trendWin === '1h' ? TT('trend.emptyHour') : TT('trend.empty', {win: trendWin})}${wider ? ` <button data-w="${wider}">${TT('trend.seeWindow', {win: wider})}</button>` : ''}</div>`;
    const mark = chrome.runtime.getURL(theme() === 'light' ? 'icons/mark.svg' : 'icons/mark-dark.svg');
    return `<div class="hd"><img src="${mark}" alt=""><b>${TT('trend.title')}</b><span class="live"><i></i>${TT('trend.live')}</span></div>
      <div class="win">${TWINS.map((w) => `<button data-w="${w}" class="${w === trendWin ? 'on' : ''}">${w}</button>`).join('')}</div>${body}`;
  };
  const paintTrend = () => {
    const box = document.querySelector('[data-fable-trend]')?.shadowRoot?.querySelector('.p');
    if (!box) return;
    box.className = `p ${theme()}`;
    box.innerHTML = trendHTML();
    hideBroken(box);
  };
  // refreshed every minute while the sidebar is up (the server caches a minute too); a switch of window drops the older answer
  const loadTrend = (force) => {
    if (trendBusy || (!force && trendData && Date.now() - trendAt < 60e3)) return;
    trendBusy = true;
    const win = trendWin;
    chrome.runtime.sendMessage({type: 'smartfeed', hours: parseInt(win, 10)})
      .then((r) => { if (win !== trendWin) return; if (r?.items || !trendData) { trendData = {items: r?.items || []}; trendAt = Date.now(); paintTrend(); } })
      .catch(() => {})
      .finally(() => { trendBusy = false; });
  };
  const trendPanel = () => {
    const existing = document.querySelector('[data-fable-trend]');
    if (!settings.enabled || !settings.trendingPanel) return existing?.remove();
    const col = document.querySelector('[data-testid="sidebarColumn"]');
    const section = col?.querySelector('section');
    if (!section) return;
    if (existing?.isConnected && col.contains(existing)) return loadTrend(false);
    existing?.remove();
    const host = document.createElement('div');
    host.setAttribute('data-fable-trend', '1');
    section.parentElement.insertAdjacentElement('beforebegin', host);
    const root = host.attachShadow({mode: 'open'});
    root.innerHTML = `<style>${TREND_CSS}</style><div class="p ${theme()}"></div>`;
    root.addEventListener('click', (e) => {
      const w = e.target.closest('[data-w]');
      if (w) {
        e.preventDefault();
        trendWin = w.dataset.w;
        try { localStorage.setItem('fable-feed-window', trendWin); } catch {}
        trendData = null; trendOpen = false; trendBusy = false;
        paintTrend();
        return loadTrend(true);
      }
      if (e.target.closest('[data-more]')) { e.preventDefault(); trendOpen = !trendOpen; return paintTrend(); }
      const row = e.target.closest('[data-go]');
      // open it the way X's own links do (client-side), unless the user asked for a new tab
      if (row && !e.metaKey && !e.ctrlKey) { e.preventDefault(); history.pushState({}, '', row.dataset.go); window.dispatchEvent(new PopStateEvent('popstate')); }
    });
    paintTrend();
    loadTrend(false);
  };

  // What the popup shows: today's counts, the last flagged posts, and which X account is signed in on this browser.
  const SEEN = new Set();
  let memo = null, memoTimer = null;
  const remember = (article, v) => {
    if (SEEN.has(v.id) || String(v.id).startsWith('profile:')) return;
    SEEN.add(v.id);
    const day = new Date().toISOString().slice(0, 10);
    const t = TWEETS.get(v.id);
    const link = [...article.querySelectorAll('a[href*="/status/"]')].map((a) => a.getAttribute('href')).find((h) => h.includes(`/status/${v.id}`));
    const flagged = v.tone === 'rug' || v.tone === 'kol';
    chrome.storage.local.get({activity: {day, checked: 0, flagged: 0, scams: 0}, recent: []}).then(({activity, recent}) => {
      memo ||= {activity: activity.day === day ? activity : {day, checked: 0, flagged: 0, scams: 0}, recent};
      memo.activity.checked++;
      if (flagged) memo.activity.flagged++;
      if (v.tone === 'rug') memo.activity.scams++;
      if (flagged) memo.recent = [{id: v.id, handle: t?.author?.handle || null, avatar: t?.author?.avatar || null, label: v.label, tone: v.tone, detail: v.detail || null, url: link ? `https://x.com${link}` : null, at: Date.now()}, ...memo.recent.filter((x) => x.id !== v.id)].slice(0, 40);
      clearTimeout(memoTimer);
      memoTimer = setTimeout(() => { chrome.storage.local.set(memo); memo = null; }, 800);
    }).catch(() => {});
  };
  const whoAmI = () => {
    if (!chrome.runtime?.id) return clearInterval(whoAmITimer); // extension reloaded under this tab: this copy is orphaned
    const a = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
    const handle = a?.getAttribute('href')?.replace('/', '');
    if (!handle) return;
    const avatar = document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"] img')?.src || null;
    const name = document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"] [dir="ltr"] span')?.textContent || null;
    chrome.storage.local.get({xAccount: null}).then(({xAccount}) => {
      if (xAccount?.handle === handle && xAccount?.avatar === avatar) return;
      chrome.storage.local.set({xAccount: {handle, avatar, name, seenAt: Date.now()}});
    }).catch(() => {});
  };
  setTimeout(whoAmI, 4000);
  const whoAmITimer = setInterval(whoAmI, 60000);

  /* ---------------- Inline card, video style: open on the post as it scrolls in, no click ----------------
     One card per post, picked from what Fable really holds: the contract in the post, the smart accounts behind the author,
     the coins the author called in the last 30 days, their build history, or their activity. Every number is real; a coin
     with no measured price says "pending", never a made-up return. Tap the card for receipts. */
  const INTEL = new Map();
  const HISTS = new Map(); // lowercase handle -> the account's history once it has arrived (read at once by scopeFor: what the server judged each of its posts to be)
  const intelGet = (key, msg) => {
    if (!INTEL.has(key)) {
      const p = chrome.runtime.sendMessage(msg).catch(() => null);
      INTEL.set(key, p);
      if (key.startsWith('h:')) p.then((h) => { if (h && !h.error) { HISTS.set(key.slice(2), h); onHist(key.slice(2)); } });
    }
    return INTEL.get(key);
  };
  const mvHead = (title, right, mono, logo) => `<div class="mv-head" ${i(1)}>${fox('fox lg')}<b>Fable</b><span class="k">· ${esc(title)}</span>${logo && /^https:\/\//.test(logo) ? `<img class="mv-logo" src="${esc(logo)}" alt="" referrerpolicy="no-referrer">` : ''}<span class="r ${mono ? 'mono' : ''}">${esc(right || 'fable.market')}</span></div>`;
  // the cards that are an ACCOUNT's record (data-author: drawn once per page view, src/callout.js AUTHOR_LABELS and authorSlot) as against a coin's
  const AUTHOR_CARDS = new Set(['promo', 'builder', 'smart', 'activity', 'record', 'badplay']);
  const mvCard = (kind, head, body, extra = '') => `<div class="expand"><div><div class="mv-card ${extra}" data-mv="${kind}"${AUTHOR_CARDS.has(kind) ? ' data-author="card"' : ''}>${head}<div class="mv-body">${body}</div></div></div></div>`;
  // a card's sections in the order the remote config gives (cards.<kind>.order), minus the hidden ones (cards.<kind>.hide)
  const cardBody = (kind, parts) => {
    const L = CFG.cards?.[kind] || {}, hide = new Set(Array.isArray(L.hide) ? L.hide : []);
    const order = Array.isArray(L.order) && L.order.length ? L.order.filter((k) => k in parts) : [];
    // sections a (remote) order does not name yet, e.g. the 0.28 investigation ones, go before the footer, never after it
    const rest = Object.keys(parts).filter((k) => !order.includes(k)), at = order.indexOf('foot');
    const all = at >= 0 && rest.length ? [...order.slice(0, at), ...rest.filter((k) => k !== 'foot'), ...order.slice(at)] : [...order, ...rest];
    return all.filter((k) => !hide.has(k)).map((k) => parts[k] || '').join('');
  };
  const kindOn = (k) => CFG.on?.cardKinds?.[k] !== false;
  const mvShort = (a) => (a ? `${a.slice(0, 6)}..${a.slice(-4)}` : '');
  // one decimal under 10 of a unit, the way the live chart prints it ($8.5K next to a chart saying $8.5K, not $9K)
  const d1 = (x) => (x < 9.95 ? (Math.round(x * 10) / 10).toFixed(1).replace(/\.0$/, '') : String(Math.round(x)));
  const mvUsd = (n) => (n == null || !isFinite(n) ? null : n >= 1e9 ? `$${d1(n / 1e9)}B` : n >= 1e6 ? `$${d1(n / 1e6)}M` : n >= 1e3 ? `$${d1(n / 1e3)}K` : `$${Math.round(n)}`);
  const mvPct = (x) => `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(Math.round(x * 100))}%`;
  // day colour: green = built or calls that held, red = calls that dumped / bundled / rug ties, amber = both,
  // violet = allegations, pale = calls still being priced, faint = seen, nothing notable; near-empty = no data
  const quart = (vals) => { const nz = vals.filter((v) => v > 0).sort((a, b) => a - b); const q = (p) => (nz.length ? nz[Math.min(nz.length - 1, Math.floor(p * nz.length))] : 1); return [q(0.25), q(0.5), q(0.8)]; };
  const lvOf = (v, [a, b, c]) => (!v ? 0 : v <= a ? 1 : v <= b ? 2 : v <= c ? 3 : 4);
  const HEAT_TONE = (d, t = [1, 2, 4]) => {
    if (d.coverage === 'before_account') return 'x';
    if (d.coverage !== 'observed') return 'e';
    const act = (d.posts || 0) + (d.total || 0);
    const lv = Math.max(1, lvOf(act, t));
    const g = d.grade;
    const hue = g === 'bad' ? 'r' : g === 'mixed' || g === 'warn' ? 'a' : 'g';
    return `${hue}${g === 'bad' ? Math.max(3, lv) : lv}`;
  };
  // the video's grid: 5 rows of wide rounded cells filling the card, oldest (left) to newest (right), coloured by risk;
  // cells fill in column by column as the card opens
  const HEAT_ROWS = 5, HEAT_COLS = 26;
  // a list joined with a locale-owned separator template ({a}, {b}), so each language keeps its own punctuation
  const mvJoin = (key, arr) => (arr.length ? arr.reduce((a, b) => TX(key, {a, b})) : '');
  const heatTip = (d) => {
    const ts = Date.parse(d.date), date = isFinite(ts) ? DATE(ts, {timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric'}) : String(d.date || '');
    if (d.total) {
      const labels = mvJoin('mv.sep.semi', (d.events || []).map((e) => (e.labelKey ? FX({text: e.label, key: e.labelKey, params: e.labelParams}) : TR(e.label || ''))).slice(0, 2));
      return d.total > 2 ? TX('mv.heat.tipMore', {date, labels, more: d.total - 2}) : TX('mv.heat.tipEvents', {date, labels});
    }
    return d.posts ? TX('mv.heat.tipPosts', {date, n: d.posts}) : date;
  };
  const mvHeat = (days) => {
    const list = (days || []).slice(-HEAT_ROWS * HEAT_COLS);
    const t = quart(list.filter((d) => d.coverage === 'observed').map((d) => (d.posts || 0) + (d.total || 0)));
    return `<div class="mv-heat v3 v4" style="--rows:${HEAT_ROWS};--cols:${Math.max(1, Math.ceil(list.length / HEAT_ROWS))}">${list.map((d, n) => `<i class="q-${HEAT_TONE(d, t)}" style="--c:${Math.floor(n / HEAT_ROWS)}" title="${esc(heatTip(d))}"></i>`).join('')}</div>`;
  };
  const mvSpark = (days) => {
    const pts = Array.from({length: 14}, (_, k) => days?.[new Date(Date.now() - (13 - k) * 864e5).toISOString().slice(0, 10)] || 0);
    const max = Math.max(1, ...pts);
    const d = pts.map((y, k) => `${k ? 'L' : 'M'}${2 + k * 10} ${46 - (y / max) * 40}`).join(' ');
    return `<div class="mv-spark" ${i(2)}><svg class="chart" viewBox="0 0 134 50"><path d="${d}" pathLength="1"/></svg><span>${TT('mv.spark.caption')}</span></div>`;
  };
  const mvStat = (val, label, tone, n) => `<div class="stat mv-stat ${tone || ''}" ${i(3 + n)}><b>${/^\$?\d+[KMB%]?$/.test(val) ? num(val) : esc(val)}</b><span>${esc(label)}</span></div>`;
  const mvFacts = (facts, start) => (facts.length ? `<div class="mv-facts">${facts.map((f, n) => `<div class="mv-fact ${f.tone || ''}" ${i(start + n)}>${esc(FX(f))}</div>`).join('')}</div>` : '');

  // Price chart, like X's own token widget: log scale (memecoins move in multiples), red when down over the span, green
  // when up, gradient fill, the line draws itself in, a live dot on the latest price. Real points only; under 3, no chart.
  let mvChartN = 0;
  // 2 decimals rounded on the printed decimal (1.005 -> 1.01), the way Intl rounds, so the grouped number reads the same as before
  const mvR2 = (v) => (/e/i.test(String(v)) ? v : Number(`${Math.round(Number(`${v}e2`))}e-2`));
  const mvPrice = (v) => (v == null ? '' : v >= 1 ? `$${NUM(mvR2(v))}` : v >= 0.01 ? `$${v.toFixed(4)}` : `$${Number(v).toPrecision(3)}`);
  const mvSpan = (ms) => (ms < 3600e3 ? TX('time.dur.m', {n: Math.max(1, Math.round(ms / 60e3))}) : ms < 864e5 ? TX('time.dur.h', {n: Math.round(ms / 3600e3)}) : TX('time.dur.d', {n: Math.round(ms / 864e5)}));
  const mvChart = (ser, priceUsd) => {
    const pts = ser?.points || [];
    if (pts.length < 3) return '';
    const W = 520, H = 96, id = `g${++mvChartN}`;
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => Math.log(p[1]));
    const x0 = Math.min(...xs), x1 = Math.max(...xs), lo = Math.min(...ys), hi = Math.max(...ys);
    const X = (t) => 2 + ((t - x0) / Math.max(1, x1 - x0)) * (W - 10);
    const Y = (v) => 10 + (1 - (v - lo) / Math.max(1e-9, hi - lo)) * (H - 20);
    const d = pts.map((p, k) => `${k ? 'L' : 'M'}${X(p[0]).toFixed(1)} ${Y(Math.log(p[1])).toFixed(1)}`).join(' ');
    const up = ser.change >= 0;
    const last = pts[pts.length - 1];
    const pct = Math.abs(ser.change) >= 1 ? `${(ser.change + 1).toFixed(1)}x` : `${up ? '+' : '−'}${Math.abs(ser.change * 100).toFixed(Math.abs(ser.change) < 0.1 ? 1 : 0)}%`;
    return `<div class="mv-chart ${up ? 'up' : 'down'}" ${i(2)}>
      <div class="mv-ch-h"><b>${esc(mvPrice(priceUsd ?? last[1]))}</b><span class="chg">${esc(pct)}</span><em>${esc(mvSpan(x1 - x0))}</em></div>
      <div class="mv-plot"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"><defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="currentColor" stop-opacity=".32"/><stop offset="1" stop-color="currentColor" stop-opacity="0"/></linearGradient></defs>
        <path class="area" d="${d} L${X(x1).toFixed(1)} ${H} L${X(x0).toFixed(1)} ${H} Z" fill="url(#${id})"/>
        <path class="line" d="${d}" pathLength="1" vector-effect="non-scaling-stroke"/></svg>
      <i class="dot" style="left:${((X(last[0]) / W) * 100).toFixed(2)}%;top:${((Y(Math.log(last[1])) / H) * 100).toFixed(2)}%"></i></div></div>`;
  };

  // Contract card: the hardest facts first, said plainly. Stats are the numbers that matter most for this coin; the
  // fact lines carry their sign (✕ bad, ✓ good, ! watch). While the chain is being read the card says so and fills in live.
  const MARK = {bad: '✕', good: '✓', warn: '!', '': '•'};
  // the Fable read: one sentence that connects the signals (coin + who launched it + who pushed it + what the price did),
  // built only from facts on the card. Nothing is inferred beyond them.
  const cap1 = (x) => (x ? x[0].toUpperCase() + x.slice(1) : x);
  // opts: leave out what the card already shows elsewhere (the since-call number, the launcher and poster sections)
  const contractRead = (c, hist, {noPrice = false, noLauncher = false, noCaller = false} = {}) => {
    const L = c.onchain?.launch, rk = c.risk || {};
    const d = noLauncher ? null : c.devHistory, sf = noPrice ? null : c.history?.calls?.sinceFirst;
    if (noCaller) hist = null;
    const coin = [];
    if (rk.reasons?.some((x) => x.key === 'op')) coin.push(TX('mv.read.op'));
    if (rk.reasons?.some((x) => x.key === 'honeypot')) coin.push(TX('mv.read.honeypot'));
    if (L?.bundled) coin.push(TX('mv.read.bundledPct', {pct: Math.round(L.pct * 100), n: L.buyers}));
    else if (c.facts?.some((f) => f.k === 'launch:bundle-v1' || /bundle/i.test(f.k) && f.tone === 'bad')) coin.push(TX('mv.read.bundled'));
    else if (L && !L.bundled && L.pct < 0.1) coin.push(TX('mv.read.clean'));
    if (d?.rugged >= 2) coin.push(TX('mv.read.devRugs', {n: d.rugged}));
    else if (d?.launched >= 10) coin.push(TX('mv.read.devSerial', {n: d.launched}));
    const who = [];
    if (c.history?.smartAuthors?.length) { const sa = c.history.smartAuthors; who.push(sa.length === 1 ? TX('mv.read.smartOne', {a: `@${sa[0].handle}`}) : sa.length === 2 ? TX('mv.read.smartTwo', {a: `@${sa[0].handle}`, b: `@${sa[1].handle}`}) : TX('mv.read.smartMany', {n: sa.length})); }
    if (hist?.record?.bad >= 2 && hist.record.bad > (hist.record.good || 0)) who.push(TX('mv.read.pushedBad', {n: hist.record.bad}));
    else if (hist?.record?.good >= 2 && hist.record.good > (hist.record.bad || 0)) who.push(TX('mv.read.callsHeld', {n: hist.record.good}));
    const px = sf && Math.abs(sf.change) >= 0.2 ? (sf.change >= 1 ? TX('mv.read.pxMult', {x: (sf.change + 1).toFixed(1)}) : TX(sf.change > 0 ? 'mv.read.pxUp' : 'mv.read.pxDown', {pct: Math.round(Math.abs(sf.change) * 100)})) : null;
    const parts = [coin.length ? cap1(mvJoin('mv.sep.comma', coin)) : null, mvJoin('mv.sep.comma', who) || null, px].filter(Boolean);
    return parts.length >= 2 ? TX('mv.sep.end', {text: mvJoin('mv.sep.semi', parts)}) : null;
  };
  const builderRead = (h) => {
    const bits = [h.ships?.length ? (h.ships.length > 1 ? TX('mv.builder.buildsTwo', {a: h.ships[0], b: h.ships[1]}) : TX('mv.builder.buildsOne', {a: h.ships[0]})) : null, h.github?.total ? TX('mv.builder.commits', {n: h.github.total}) : null,
      h.smart?.n ? TX(h.smart.topPct ? 'mv.builder.followedTop' : 'mv.builder.followed', {n: h.smart.n, pct: h.smart.topPct}) : null].filter(Boolean);
    return bits.length >= 2 ? TX('mv.sep.end', {text: mvJoin('mv.sep.comma', bits)}) : null;
  };
  const promoRead = (h) => {
    const measured = (h.promos || []).filter((p) => p.sinceCall != null), deep = measured.filter((p) => p.sinceCall <= -0.9).length, up = measured.filter((p) => p.sinceCall >= 0.5).length;
    if (measured.length < 2) return null;
    const sold = h.positions?.soldAfter;
    return TX(up ? (sold ? 'mv.promo.readUpSold' : 'mv.promo.readUp') : (sold ? 'mv.promo.readSold' : 'mv.promo.read'), {total: h.promosTotal, deep, up, sold});
  };
  const readHtml = (text) => (text ? `<div class="mv-read" ${i(1.5)}>${esc(text)}</div>` : '');
  // deployer history (video: "Fable · Deployer history"): big stats plus one cell per coin the same wallet launched,
  // oldest to newest, coloured by what happened to it
  const DEV_TONE = {rug: 'r4', dead: 'r3', alive: 'g3', this: 'this', graduated: 'gu', curve: 'n', unread: 'e'};
  // winners shaded by size against the dev's own other coins (darker = bigger market cap), losers red, the rest neutral
  const devTone = (x, t) => {
    if ((x.state === 'alive' || x.state === 'graduated') && x.mcap != null) return `g${Math.max(1, lvOf(x.mcap, t))}`;
    return DEV_TONE[x.state] || 'e';
  };
  const STRIP_TONE = {t: 'this', g: 'gu', c: 'n', r: 'r4', d: 'r3', u: 'e'};
  const STRIP_WORD = {t: 'dev.state.this', g: 'dev.state.graduated', c: 'dev.state.curve', r: 'dev.state.rugged', d: 'dev.state.dead', u: 'dev.state.unread'};
  // the plain-English state of a coin in the detailed (no strip) path; anything unknown prints as the server sent it
  const DEV_STATE_KEY = {curve: 'dev.state.curve', unread: 'dev.state.unread', this: 'dev.state.this', alive: 'dev.state.alive', rug: 'dev.state.rug', graduated: 'dev.state.graduated', dead: 'dev.state.dead'};
  const devTip = (name, word, mcap) => (mcap ? TX('dev.tipMcap', {name, word, mcap: mvUsd(mcap)}) : TX('dev.tip', {name, word}));
  const devSection = (d) => {
    if (!d || d.launched < 2) return '';
    const big = (cls, v) => RAW(`<b class="${cls}">${num(String(v))}</b>`);
    const bits = [TT('dev.stat.launched', {count: big(d.launched >= 10 ? 'red' : '', d.launched)}), d.graduated != null && TT('dev.stat.graduated', {count: big('green', d.graduated)}),
      d.rugged ? TT('dev.stat.rugged', {count: big('red', d.rugged)}) : d.dead >= 2 ? TT('dev.stat.dead', {count: big('red', d.dead)}) : d.alive ? TT('dev.stat.trading', {count: big('green', d.alive)}) : null].filter(Boolean);
    // the full history when the server sent it (one code per coin), else the detailed latest coins
    const full = d.strip && d.strip.length > Math.min(78, d.cells.length);
    let items;
    if (full) {
      items = [...d.strip].map((k, n) => { const x = d.cells[n]; const tone = /[1-4]/.test(k) ? `g${k}` : STRIP_TONE[k] || 'e';
        const name = x ? (x.symbol ? `$${x.symbol}` : mvShort(x.address)) : TX('dev.coinN', {n: String(d.strip.length - n)});
        return {tone, tip: devTip(name, /[1-4]/.test(k) ? TX('dev.state.trading') : STRIP_WORD[k] ? TX(STRIP_WORD[k]) : '', x?.mcap)}; }).reverse();
    } else {
      const cells = d.cells.slice(0, 78).reverse();
      const t = quart(cells.filter((x) => (x.state === 'alive' || x.state === 'graduated') && x.mcap != null).map((x) => x.mcap));
      items = cells.map((x) => ({tone: devTone(x, t), tip: devTip(x.symbol ? `$${x.symbol}` : mvShort(x.address), DEV_STATE_KEY[x.state] ? TX(DEV_STATE_KEY[x.state]) : x.state, x.mcap)}));
    }
    const rows = items.length > 150 ? 7 : items.length > 78 ? 5 : Math.min(3, Math.max(1, Math.ceil(items.length / 26)));
    const dense = items.length > 150 ? ' dense' : items.length > 78 ? ' mid' : '';
    const some = items.length < d.launched ? TT('dev.capSome', {n: String(items.length)}) : TT('dev.capAll');
    return `<div class="mv-sec" ${i(8)}><div class="mv-sec-h"><span class="t">${esc(secCopy('launched'))}${rankBadge(d.rank)}</span><span class="mono">${esc(mvShort(d.wallet))}</span></div>
      <div class="mv-sec-n">${bits.join('<i>·</i>')}</div>
      <div class="mv-heat v3 slim${dense}" style="--rows:${rows};--cols:${Math.max(1, Math.ceil(items.length / rows))}">${items.map((x, n) => `<i class="q-${x.tone}" style="--c:${Math.floor(n / rows)}" title="${esc(x.tip)}"></i>`).join('')}</div>
      <div class="mv-key dev"><span class="cap">${some}</span><span class="k"><i class="q-g1"></i><i class="q-g2"></i><i class="q-g3"></i><i class="q-g4"></i>${TT('dev.key.trading')}</span><span class="k"><i class="q-gu"></i>${TT('dev.state.graduated')}</span><span class="k"><i class="q-r4"></i>${TT('dev.key.ruggedOrDead')}</span><span class="k"><i class="q-n"></i>${TT('dev.state.curve')}</span><span class="k"><i class="q-this"></i>${TT('dev.state.this')}</span></div></div>`;
  };
  // a coordinated push (src/shill.js on the server): only when the numbers prove it (level high / medium)
  const shillSection = (w, listed = new Set()) => {
    if (!w?.level) return '';
    const nm = (v) => RAW(num(String(v)));
    const bits = [TT('shill.accountsIn', {accounts: nm(w.accounts), min: nm(w.windowMin)}), w.sameText >= 2 && TT('shill.sameText', {n: nm(w.sameText)}),
      w.sharedBefore >= 2 && TT('shill.sharedBefore', {n: nm(w.sharedBefore)}), w.fresh >= 2 && TT('shill.fresh', {n: nm(w.fresh)})].filter(Boolean);
    const chips = (w.handles || []).filter((h) => !listed.has(String(h).toLowerCase())).slice(0, 6).map((h, n) => `<a class="mv-chip sm ${w.level === 'high' ? 'r' : 'a'}" href="https://x.com/${esc(h)}" target="_blank" rel="noopener" ${i(9 + n * 0.2)}>@${esc(h)}</a>`).join('');
    const q = w.sample ? `<div class="mv-quote">"${esc(String(w.sample).replace(/\s+/g, ' ').slice(0, 140))}${String(w.sample).length > 140 ? '...' : ''}"</div>` : '';
    return `<div class="mv-sec mv-shill ${w.level}" ${i(8.5)}><div class="mv-sec-h"><span class="t">${TT('shill.title')}<em class="mv-rk ${w.level === 'high' ? 'bad' : 'warn'}">${w.level === 'high' ? TT('shill.wave') : TT('shill.push')}</em></span></div>
      <div class="mv-sec-n">${bits.join('<i>·</i>')}</div>${chips ? `<div class="mv-chips">${chips}</div>` : ''}${q}</div>`;
  };
  // the other contracts in the same post, one line each
  const alsoSection = (list) => (list?.length ? `<div class="mv-also" ${i(10)}>${list.map((x) => {
    const sy = x.identity?.symbols?.length ? `$${x.identity.symbols[0].symbol}` : mvShort(x.identity?.address);
    const pl = x.risk?.devPill?.tone === 'rug' ? x.risk.devPill : x.risk?.pill;
    const mc = x.market?.mcap?.value;
    return `<div class="mv-also-row ${pl?.tone || ''}"><b>${esc(sy)}</b><span>${esc(pl ? `${FX({text: pl.label, key: pl.key, params: pl.params})}${pl.stat ? ` · ${FX({text: pl.stat, key: pl.statKey, params: pl.statParams})}` : ''}` : x.onchain?.isToken === false || (x.facts || []).some((f) => f.k === 'nottoken') ? TX('also.notToken') : x.filling ? TX('also.filling') : TX('also.checked'))}</span><em>${esc(mc ? mvUsd(mc) : '')}</em></div>`;
  }).join('')}</div>` : '');
  /* ---------------- 0.28 The investigation inside the card ----------------
     intel's /v1/contract carries `investigation`: {facts: [{id, kind, tone, text, proof: [{label, url}]}], operation: {id, launches, rugged,
     eth_taken, deployers, grid: [{token, symbol, ts, outcome, eth_taken}]}, promoters: [{handle, post_id, post_ts, secs_after_launch,
     secs_after_insider_sell, paid}], coverage}. The server writes every sentence (hard facts, house voice), so the copy changes without a
     store update; the card lays them out and links the proof (explorer tx / wallet / the post itself). Every section has its own remote
     switch: on.invOp, invBundle, invMoney, invSnipers, invWash, invPromoters. */
  const INV_SWITCH = {op: 'invOp', bundle: 'invBundle', money: 'invMoney', snipers: 'invSnipers', wash: 'invWash', promoter: 'invPromoters'};
  const INV_TONE = {red: 'bad', amber: 'warn', neutral: '', bad: 'bad', warn: 'warn', good: 'good'};
  const invOn = (kind) => on(INV_SWITCH[kind]);
  // section titles: the config's copy (English: config.js or the remote config) through TR, else the registered default
  const SEC_KEY = {launched: 'inv.section.launched', posted: 'inv.section.posted', operation: 'inv.section.operation', pushed: 'inv.section.pushed', invBundle: 'inv.section.invBundle', invMoney: 'inv.section.invMoney',
    invSnipers: 'inv.section.invSnipers', invWash: 'inv.section.invWash', record: 'inv.section.record', rugged: 'inv.section.rugged', proven: 'inv.section.proven', actor: 'inv.section.actor',
    badplay: 'inv.section.badplay'};
  // a config word that still is the bundled English default is drawn from the string table (so a language, or an i18n.<lang>.<key> wording fix, applies);
  // a different English word set from the remote config goes through the sentence catalogue
  const cfgWord = (group, k) => { const c = CFG.copy?.[group]?.[k], d = globalThis.FableConfig?.DEFAULT?.copy?.[group]?.[k]; return typeof c === 'string' && c && c !== d ? TR(c) : null; };
  const secCopy = (k) => cfgWord('sections', k) ?? TX(SEC_KEY[k]);
  const httpsUrl = (u) => (/^https:\/\/[^\s"'<>]+$/i.test(String(u || '')) ? String(u) : null);
  const EXT_ARROW = '<svg viewBox="0 0 24 24" class="ex" aria-hidden="true"><path d="M7 7h10v10h-2V10.4L6.4 19 5 17.6 13.6 9H7V7Z"/></svg>';
  // the proof links of one fact: an explorer tx or wallet, or the post. Only https links are ever drawn.
  const proofList = (proof) => (Array.isArray(proof) ? proof : []).map((p) => ({label: String(p?.label || '').trim() || TX('inv.proof.label'), key: p?.key, params: p?.params, url: httpsUrl(p?.url)})).filter((p) => p.url);
  // a pill says what the link is: the explorer's tx / wallet / token page, the post; anything else keeps the first words of its label
  const proofWord = (p) => {
    if (/\/tx\//.test(p.url)) return TX('inv.proof.tx');
    if (/\/address\//.test(p.url)) return TX('inv.proof.wallet');
    if (/\/token\//.test(p.url)) return TX('inv.proof.token');
    if (/\/status\//.test(p.url)) return TX('inv.proof.post');
    const l = FX({text: p.label, key: p.key, params: p.params});
    return l.length > 14 ? `${l.slice(0, 13)}\u2026` : l;
  };
  const proofLinks = (proof, max = 2) => {
    const n = {};
    return proofList(proof).slice(0, max).map((p) => {
      const w = proofWord(p);
      n[w] = (n[w] || 0) + 1;
      return `<a class="mv-proof" href="${esc(p.url)}" target="_blank" rel="noopener" title="${esc(FX({text: p.label, key: p.key, params: p.params}))}">${esc(n[w] > 1 ? `${w} ${n[w]}` : w)}${EXT_ARROW}</a>`;
    }).join('');
  };
  const pfHtml = (proof, max = 2) => { const l = proofLinks(proof, max); return l ? `<span class="pf">${l}</span>` : ''; };
  const invOf = (c) => (c?.investigation && typeof c.investigation === 'object' ? c.investigation : null);
  const invFacts = (inv, kind) => (Array.isArray(inv?.facts) ? inv.facts : []).filter((f) => f && f.kind === kind && typeof f.text === 'string' && f.text.trim());
  /* 0.30.0 (RUG-v3 and the bad-play facts): the proven rug facts (creator dump, liquidity pull, operation self-snipe, insider cluster, coordinated
     exit, wash then dump) under one heading, "How it was rugged" (a red fact or a red alert) or "Proven on chain" (amber: a front-running bot or sniper wallets are not insiders), one line each with its
     proof chips, worst first; the facts about who runs it (the operation, a serial actor) under "Who is behind it". A fact's group: the server's own
     `group`, else the remote config's invGroups (fact key prefix -> 'rug' | 'actor', so a new bad-play kind is placed with no store update), else the
     built-in prefixes. A fact with no group is not drawn on the card (the detail sheet lists every fact). Switches on.invRug, on.invActor. */
  // (bad-play v4: the honeypot facts and linked wallets holding supply join the rug group; the facts about posts on X (a shill campaign, a copied ticker,
  // phishing posts naming the coin) are drawn in "Who pushed it", group 'push', with their posts as proof)
  const INV_GROUPS = {'inv.dump.': 'rug', 'inv.exit.': 'rug', 'inv.pull.': 'rug', 'inv.lppull.': 'rug', 'inv.snipe.': 'rug', 'inv.cluster.': 'rug', 'inv.cexit.': 'rug', 'inv.washdump.': 'rug',
    'inv.honeypot.': 'rug', 'inv.manip.': 'rug', 'inv.op.': 'actor', 'inv.serial.': 'actor', 'inv.x.': 'push',
    // the Solana rug facts (src/solfacts.js; the server sends group 'rug' on each, these are the fallback), proof = Solscan txs
    'inv.sol.dump.': 'rug', 'inv.sol.snipe': 'rug', 'inv.sol.cexit': 'rug', 'inv.sol.serial.': 'rug'};
  const GROUPS = new Set(['rug', 'actor', 'push']);
  const RUG_IDS = ['operation_snipe', 'sol_bundle_snipe', 'liquidity_pull', 'pool_pull', 'creator_dump', 'sol_creator_dump', 'creator_exit', 'insider_cluster', 'coordinated_exit', 'sol_coordinated_exit',
    'wash_then_dump', 'sol_serial_deployer'];
  const TONE_RANK = {red: 0, bad: 0, amber: 1, warn: 1, neutral: 2, '': 2, good: 3};
  const groupOf = (f) => {
    if (!f || f.kind === 'op' || f.kind === 'promoter') return null; // drawn by their own sections
    if (GROUPS.has(f.group)) return f.group;
    const g = {...INV_GROUPS, ...(CFG.invGroups && typeof CFG.invGroups === 'object' ? CFG.invGroups : {})}, k = String(f.key || '');
    let best = '';
    for (const p of Object.keys(g)) if (p && k.startsWith(p) && p.length > best.length) best = p;
    if (best) return GROUPS.has(g[best]) ? g[best] : null;
    return RUG_IDS.includes(f.id) ? 'rug' : f.id === 'serial_actor' ? 'actor' : null;
  };
  // the facts of one group, once each (same sentence or same first proof tx: one line), worst tone first, then the order above
  const invGroup = (c, g) => {
    const inv = invOf(c);
    if (!inv || !on(g === 'rug' ? 'invRug' : g === 'actor' ? 'invActor' : 'invXside')) return [];
    const texts = new Set(), txs = new Set();
    return (Array.isArray(inv.facts) ? inv.facts : []).filter((f) => f && typeof f.text === 'string' && f.text.trim() && groupOf(f) === g).filter((f) => {
      const t = f.text.trim(), p = proofList(f.proof)[0]?.url;
      if (texts.has(t) || (p && txs.has(p))) return false;
      texts.add(t); if (p) txs.add(p);
      return true;
    }).sort((a, b) => (TONE_RANK[a.tone] ?? 2) - (TONE_RANK[b.tone] ?? 2) || (RUG_IDS.indexOf(a.id) >>> 0) - (RUG_IDS.indexOf(b.id) >>> 0));
  };
  // a fact's mark never says more than the pill does (the pill is the verdict): a red mark only on a red pill, amber at most on an amber one
  const pillCap = (c) => (c?.risk?.alert || c?.risk?.level === 'high' ? 'bad' : c?.risk?.level === 'medium' ? 'warn' : '');
  const capTone = (tone, cap) => ((TONE_RANK[tone] ?? 2) < (TONE_RANK[cap] ?? 2) ? cap : tone);
  // the headline tag of a rug reason: the catalogue's own pill stat ("creator sold 29%", "insider cluster"), in the reader's language
  const RUG_TAG = {creator_dump: 'stat.creator_sold', creator_exit: 'stat.creator_sold', devdump: 'stat.creator_sold', liquidity_pull: 'stat.liquidity_pulled', pool_pull: 'stat.liquidity_pulled',
    operation_snipe: 'stat.self_snipe', insider_cluster: 'stat.insider_cluster', insider_cluster2: 'stat.insider_cluster', coordinated_exit: 'stat.coordinated_exit', coordinated_exit2: 'stat.coordinated_exit',
    wash_then_dump: 'stat.wash_then_dump', wash_then_dump2: 'stat.wash_then_dump', serial_actor: 'stat.serial_actor',
    // bad-play v4 reason keys (bpship): a blocked sell keeps the existing 'honeypot' reason (tag HONEYPOT)
    selltax: 'stat.sell_tax', ownerpowers: 'stat.owner_powers', hidden_concentration: 'stat.linked_hold', shillcamp: 'stat.shill_campaign', impersonation: 'stat.ticker_copy',
    // Solana reason keys
    sol_creator_dump: 'stat.creator_sold', sol_coordinated_exit: 'stat.coordinated_exit', sol_serial_deployer: 'stat.serial_actor'};
  // (the stat's own params come from the reason's: "creator sold {pct}", "linked wallets hold {pct}"; a stat that needs a param the reason lacks is left out)
  const rugTag = (r) => { const k = RUG_TAG[r?.key]; if (!k || Object.keys(globalThis.FableFactMeta?.[k] || {}).some((n) => r.params?.[n] == null)) return ''; const s = globalThis.FableI18n?.factKey?.(k, r.params || {}) || ''; return !s || /\{|\}|undefined|NaN/.test(s) ? '' : s.toLocaleUpperCase(LANG()); };
  // the same fact said by the risk reason (text, or key + params) and by the investigation block
  const sameFact = (r, f) => !!r && !!f && (r.text === f.text || (!!r.ikey && r.ikey === f.key && JSON.stringify(r.params || {}) === JSON.stringify(f.params || {})));
  // a coin with a proven rug fact: its whole launch story under one heading (the 0.29 labelled rows are not drawn then): the bundle (how the launch was
  // taken), the rug facts worst first, where the money went, the snipers, the wash share (not when a wash-then-dump fact says it for the time before the sell-off)
  const washSaid = (c) => invGroup(c, 'rug').some((f) => f.kind === 'washdump' || f.id === 'wash_then_dump');
  const rugSection = (c, fresh = () => '', skip = new Set()) => {
    const proven = invGroup(c, 'rug');
    if (!proven.length) return '';
    const rugs = proven.filter((f) => !skip.has(f.text)); // the one the headline says (with its proof) is not said again
    const inv = invOf(c), cap = pillCap(c);
    const one = (kind) => (invOn(kind) ? invFacts(inv, kind).find((f) => !groupOf(f)) : null);
    const bundle = skip.has('bundle') ? null : one('bundle');
    const all = [bundle, ...rugs, one('money'), one('snipers'), washSaid(c) ? null : one('wash')].filter(Boolean);
    if (!all.length) return '';
    const max = Math.max(2, CFG.limits?.rugRows ?? 4), shown = all.slice(0, max), rest = all.length - shown.length;
    const rugged = !!c.risk?.alert || proven.some((f) => INV_TONE[f.tone] === 'bad');
    const rows = shown.map((f, n) => {
      const tone = capTone(INV_TONE[f.tone] ?? '', cap), kind = groupOf(f) ? f.id || f.kind : f.kind;
      return `<div class="mv-fact sm ${tone}${fresh(`i:${f.kind}:${f.text}`)}" data-inv="${esc(kind)}" ${i(7.2 + n * 0.3)}><i>${MARK[tone]}</i><span class="tx">${esc(FX(f))}${pfHtml(f.proof)}</span></div>`;
    }).join('');
    return `<div class="mv-sec mv-rug" data-inv="rug" ${i(7)}><div class="mv-sec-h"><span class="t"><i class="dot ${cap}"></i>${esc(secCopy(rugged ? 'rugged' : 'proven'))}</span></div>${rows}${rest > 0 ? `<div class="mv-inv-more" ${i(7.2 + shown.length * 0.3)}>${TT('inv.more', {n: rest})}</div>` : ''}</div>`;
  };
  const INV_ROWS = [['bundle', 'invBundle'], ['money', 'invMoney'], ['snipers', 'invSnipers'], ['wash', 'invWash']];
  // facts that carry a switch are the ones the card can show; the keys let a refreshed card mark what is new
  const invKeys = (c) => (Array.isArray(invOf(c)?.facts) ? invOf(c).facts : []).filter((f) => f && f.text && INV_SWITCH[f.kind]).map((f) => `i:${f.kind}:${f.text}`);
  // how they took it / where it went / snipers / wash: one labelled line each, a proof link at its end
  const invRows = (c, fresh = () => '', skip = []) => {
    const inv = invOf(c);
    if (!inv) return '';
    const grouped = new Set([...invGroup(c, 'rug'), ...invGroup(c, 'actor'), ...invGroup(c, 'push')]); // 0.30.0: a rug fact sent with the bundle kind (no bundle story) is drawn in its group, never here too
    const rows = INV_ROWS.map(([kind, key], n) => {
      const f = !skip.includes(kind) && invOn(kind) && invFacts(inv, kind).find((x) => !grouped.has(x));
      if (!f) return '';
      const tone = capTone(INV_TONE[f.tone] ?? '', pillCap(c)); // 0.30.0: never a redder mark than the pill
      return `<div class="mv-inv-r ${tone}${fresh(`i:${kind}:${f.text}`)}" data-inv="${kind}" ${i(7 + n * 0.4)}><span class="k">${esc(secCopy(key))}</span><span class="v"><i>${MARK[tone]}</i><span class="tx">${esc(FX(f))}${pfHtml(f.proof)}</span></span></div>`;
    }).filter(Boolean);
    return rows.length ? `<div class="mv-sec mv-inv" ${i(7)}>${rows.join('')}</div>` : '';
  };
  // the operation: one square per launch of the same threat actors, coloured by what happened to it
  const OUTCOME = {rugged: 'rugged', rug: 'rugged', died: 'dead', dead: 'dead', bonded: 'graduated', graduated: 'graduated', live: 'trading', alive: 'trading', trading: 'trading'};
  const OUT_TONE = {rugged: 'r4', dead: 'r3', graduated: 'gu', trading: 'g3'};
  const OUT_KEY = {rugged: ['r4', 'inv.out.rugged'], dead: ['r3', 'inv.out.dead'], trading: ['g3', 'inv.out.trading'], graduated: ['gu', 'inv.out.graduated'], here: ['this', 'inv.out.here']};
  const tsMs = (t) => { const n = Number(t); return !isFinite(n) || n <= 0 ? null : n < 1e12 ? n * 1000 : n; };
  const ethTxt = (n) => (n == null || !isFinite(+n) ? '' : +n >= 100 ? `${NUM(Math.round(+n))} ETH` : +n >= 10 ? `${(+n).toFixed(1)} ETH` : +n >= 0.01 ? `${(+n).toFixed(2)} ETH` : `${Number(+n).toPrecision(2)} ETH`);
  const opSection = (c, fresh = () => '', skip = new Set()) => {
    const inv = invOf(c);
    if (!inv) return '';
    // 0.30.0: "Who is behind it": the operation (its sentence and its grid) and the serial-actor facts, one section
    const serial = invGroup(c, 'actor').filter((x) => !skip.has(x.text));
    const opOn = invOn('op');
    const op = opOn && inv.operation && typeof inv.operation === 'object' ? inv.operation : null;
    const f = opOn ? invFacts(inv, 'op')[0] : null;
    if (!op && !f && !serial.length) return '';
    const cap = pillCap(c);
    const here = String(c.identity?.address || '').toLowerCase();
    const chain = c.identity?.chains?.[0] || 'robinhood';
    const base = EXPLORER[chain] || EXPLORER.robinhood;
    const grid = (Array.isArray(op?.grid) ? op.grid : []).filter((x) => x && x.token).slice(0, 60).reverse(); // the server sends newest first; the grid reads oldest to newest
    const seen = new Set();
    const cells = grid.map((x) => {
      const me = !!x.self || String(x.token).toLowerCase() === here;
      const out = OUTCOME[String(x.outcome || '').toLowerCase()] || null;
      seen.add(me ? 'here' : out || 'e');
      const when = tsMs(x.ts) ? new Date(tsMs(x.ts)).toISOString().slice(0, 10) : '';
      const sym = x.symbol ? `$${x.symbol}` : mvShort(x.token), state = TX(me ? OUT_KEY.here[1] : out ? OUT_KEY[out][1] : 'inv.out.unread'), taken = x.eth_taken > 0 ? ethTxt(x.eth_taken) : '';
      const tip = TX(taken ? (when ? 'inv.op.tipTakenDate' : 'inv.op.tipTaken') : (when ? 'inv.op.tipDate' : 'inv.op.tip'), {sym, state, eth: taken, date: when});
      return {tone: me ? 'this' : out ? OUT_TONE[out] : 'e', tip, href: /^0x[a-fA-F0-9]{40}$/.test(String(x.token)) ? `${base}${x.token}` : null};
    });
    const rows = cells.length > 30 ? 2 : 1;
    const cols = Math.max(12, Math.ceil(cells.length / rows));
    const total = Number(op?.launches) || 0;
    const some = total > cells.length ? TX('inv.op.legendLatest', {n: cells.length}) : TX('inv.op.legend');
    const key = ['rugged', 'dead', 'trading', 'graduated', 'here'].filter((k) => seen.has(k)).map((k) => `<span class="k"><i class="q-${OUT_KEY[k][0]}"></i>${TT(OUT_KEY[k][1])}</span>`).join('');
    const tone = INV_TONE[f?.tone] ?? (op?.rugged > 0 ? 'bad' : '');
    const cell = (x, n) => { const t = x.href ? 'a' : 'i'; return `<${t} class="q-${x.tone}" style="--c:${Math.floor(n / rows)}" title="${esc(x.tip)}"${x.href ? ` href="${esc(x.href)}" target="_blank" rel="noopener"` : ''}></${t}>`; };
    const grids = cells.length ? `<div class="mv-heat v3 slim op" style="--rows:${rows};--cols:${cols}">${cells.map(cell).join('')}</div>
      <div class="mv-key dev op"><span class="cap">${esc(some)}</span>${key}</div>` : '';
    const serialHtml = serial.map((x, n) => { const t = capTone(INV_TONE[x.tone] ?? '', cap); return `<div class="mv-fact sm ${t}${fresh(`i:${x.kind}:${x.text}`)}" data-inv="${esc(x.id || x.kind)}" ${i(8.6 + n * 0.3)}><i>${MARK[t]}</i><span class="tx">${esc(FX(x))}${pfHtml(x.proof)}</span></div>`; }).join('');
    const ft = capTone(tone, cap);
    return `<div class="mv-sec mv-op${fresh(f ? `i:op:${f.text}` : '')}" data-inv="op" ${i(8)}><div class="mv-sec-h"><span class="t">${on('invActor') ? `<i class="dot ${cap}"></i>` : ''}${esc(secCopy(on('invActor') ? 'actor' : 'operation'))}</span>${op?.deployers > 1 ? `<span class="mono">${TT('inv.op.deployers', {n: op.deployers})}</span>` : ''}</div>
      ${f ? `<div class="mv-fact sm ${ft}" ${i(8.4)}><i>${MARK[ft]}</i><span class="tx">${esc(FX(f))}${pfHtml(f.proof)}</span></div>` : ''}${serialHtml}${grids}</div>`;
  };
  // who pushed it: the accounts that posted the contract while the launch was being worked, earliest first
  const avatarOf = (handle) => { const h = String(handle || '').toLowerCase(); for (const t of TWEETS.values()) if (t.author?.handle?.toLowerCase() === h && t.author.avatar) return t.author.avatar; return null; };
  const secTxt = (s) => { const a = Math.abs(Math.round(Number(s))); return a < 90 ? TX('inv.dur.s', {n: a}) : a < 5400 ? TX('inv.dur.min', {n: Math.round(a / 60)}) : a < 172800 ? TX('inv.dur.h', {n: Math.round(a / 3600)}) : TX('inv.dur.d', {n: Math.round(a / 86400)}); };
  const linkHandles = (text) => esc(text).replace(/@([A-Za-z0-9_]{1,15})\b/g, (m, h) => `<a class="mv-hl" href="https://x.com/${h}" target="_blank" rel="noopener">@${h}</a>`);
  const pushedList = (c, excl = null) => {
    const inv = invOf(c);
    if (!inv || !invOn('promoter')) return [];
    const ps = Array.isArray(inv.promoters) ? inv.promoters : [];
    return invFacts(inv, 'promoter').slice(0, 5).map((f) => {
      const h = f.text.match(/@([A-Za-z0-9_]{1,15})\b/)?.[1] || null;
      const p = h && ps.find((x) => String(x?.handle || '').toLowerCase() === h.toLowerCase());
      const post = p && /^\d+$/.test(String(p.post_id || '')) ? [{label: TX('inv.proof.post'), url: `https://x.com/${p.handle}/status/${p.post_id}`}] : [];
      const have = new Set((f.proof || []).map((x) => x?.url));
      return {handle: h, text: f.text, shown: FX(f), tone: INV_TONE[f.tone] ?? '', proof: [...(f.proof || []), ...post.filter((x) => !have.has(x.url))], avatar: httpsUrl(p?.avatar) || (h ? avatarOf(h) : null)};
    }).filter((r) => !excl || String(r.handle || '').toLowerCase() !== String(excl).toLowerCase()); // a post that calls the coin out is not listed among those who pushed it
  };
  const pushedSection = (c, fresh = () => '', excl = null, skip = new Set()) => {
    const rows = pushedList(c, excl);
    // 0.30.0 bad play on X about this coin (a shill campaign, a copied ticker, phishing posts naming it): a line each with its posts as proof, above the accounts
    const xs = invGroup(c, 'push').filter((f) => !skip.has(f.text)), cap = pillCap(c);
    if (!rows.length && !xs.length) return '';
    const xHtml = xs.slice(0, 3).map((f, n) => { const t = capTone(INV_TONE[f.tone] ?? '', cap); return `<div class="mv-fact sm ${t}${fresh(`i:${f.kind}:${f.text}`)}" data-inv="${esc(f.id || f.kind)}" ${i(9.2 + n * 0.3)}><i>${MARK[t]}</i><span class="tx">${linkHandles(FX(f))}${pfHtml(f.proof)}</span></div>`; }).join('');
    return `<div class="mv-sec mv-pushed" data-inv="pushed" ${i(9)}><div class="mv-sec-h"><span class="t">${esc(secCopy('pushed'))}</span></div>
      ${xHtml}${rows.map((r, n) => `<div class="mv-push ${r.tone}${fresh(`i:promoter:${r.text}`)}" ${i(9.4 + n * 0.3)}>${r.avatar ? `<img class="pu" src="${esc(r.avatar)}" alt="" referrerpolicy="no-referrer">` : `<span class="pu ph">${esc((r.handle || '?').slice(0, 1).toUpperCase())}</span>`}<span class="tx">${linkHandles(r.shown)}${pfHtml(r.proof, 2)}</span></div>`).join('')}</div>`;
  };
  // the contract sheet's version: every fact, every proof link, and the operation's own numbers
  const invSheet = (c) => {
    const inv = invOf(c);
    if (!inv) return '';
    const label = {op: secCopy('operation'), bundle: secCopy('invBundle'), money: secCopy('invMoney'), snipers: secCopy('invSnipers'), wash: secCopy('invWash'), promoter: secCopy('pushed')};
    // 0.30.0: the rug and actor groups too, every fact of them (the card shows the worst four); a grouped fact is listed once, under its group
    const rugs = invGroup(c, 'rug'), actors = invGroup(c, 'actor'), xs = invGroup(c, 'push'), grouped = new Set([...rugs, ...actors, ...xs]);
    const rugLabel = secCopy(c.risk?.alert || rugs.some((f) => INV_TONE[f.tone] === 'bad') ? 'rugged' : 'proven');
    const rows = [...actors.map((f) => cxRow(secCopy('actor'), `${esc(FX(f))}${pfHtml(f.proof, 8)}`)), ...rugs.map((f) => cxRow(rugLabel, `${esc(FX(f))}${pfHtml(f.proof, 8)}`)), ...xs.map((f) => cxRow(secCopy('pushed'), `${esc(FX(f))}${pfHtml(f.proof, 8)}`)),
      ...['op', 'bundle', 'money', 'snipers', 'wash', 'promoter'].filter(invOn).flatMap((k) => invFacts(inv, k).filter((f) => !grouped.has(f)).map((f) => cxRow(label[k], `${esc(FX(f))}${pfHtml(f.proof, 8)}`)))];
    const op = invOn('op') && inv.operation;
    if (op?.launches) {
      const span = [tsMs(op.first_ts), tsMs(op.last_ts)].filter(Boolean).map((t) => new Date(t).toISOString().slice(0, 10));
      rows.push(cxRow(TX('inv.sheet.sizeLabel'), [TT('inv.sheet.size', {n: op.deployers || 1, launches: op.launches}), op.rugged != null && TT('inv.sheet.rugged', {n: op.rugged}), op.eth_taken && TT('inv.sheet.taken', {eth: ethTxt(op.eth_taken)}),
        span.length === 2 && TT('inv.sheet.span', {from: span[0], to: span[1]})].filter(Boolean).join(TT('inv.sheet.sep'))));
    }
    if (!rows.length) return '';
    return `<div class="cx-sec"><h4>${TT('inv.sheet.title')}</h4>${rows.join('')}${inv.coverage === 'partial' ? cxRow(TX('inv.sheet.coverage'), TT('inv.coverage.partial')) : ''}</div>`;
  };
  // how old, in the card's own short words ("22 d"): what cxAgo says without its "ago"
  const ageSince = (ms) => { const s = Math.max(0, (Date.now() - ms) / 1000); return s < 3600 ? TX('inv.dur.min', {n: Math.max(1, Math.round(s / 60))}) : s < 86400 ? TX('inv.dur.h', {n: Math.round(s / 3600)}) : TX('inv.dur.d', {n: Math.round(s / 86400)}); };
  // the headline tag: the config's copy.tags through TR, else the registered default
  const TAG_KEY = {bundle: 'inv.tag.bundle', op: 'inv.tag.op', honeypot: 'inv.tag.honeypot', mint: 'inv.tag.mint', devrug: 'inv.tag.devrug', network: 'inv.tag.network', wave: 'inv.tag.wave', posterbundle: 'inv.tag.posterbundle',
    crew: 'inv.tag.crew', risk: 'inv.tag.risk'};
  const contractCard = (c, seen = new Set(), hist = null, others = [], excl = null, compact = false) => {
    const id = c.identity || {}, m = c.market || {}, h = c.history || {}, cn = c.connections || {}, dep = c.deployment || {};
    const sym = id.symbols?.length ? `$${id.symbols[0].symbol}` : null;
    const stats = [];
    // Fable's own token (owner): no market numbers, only smart followers
    const push = (k, v, l, t) => v && (!c.own || k === 'smart') && stats.push({k, v, l, t});
    const rk = c.risk;
    // card v6 (owner, $LOUIS: "kinda smushed and a lot to take in"): the risk level lives in the pill and the headline,
    // not again as a stat; the numbers row carries what the headline does not say
    const alertOn = !!rk?.alert;
    const L = c.onchain?.launch;
    if (!alertOn && L && L.pct >= 0.1 && L.buyers >= 2) push('bundle', `${Math.round(L.pct * 100)}%`, TX('inv.card.bundledBy', {n: L.buyers}), '');
    if (m.mcap) push('mcap', mvUsd(m.mcap.value), m.mcap.source === 'supply x price' && (c.matchedBy?.alternatives?.length || id.chains?.length > 1) ? TX('inv.card.mcapSupplyPrice') : TX('inv.card.mcap'), '');
    else if (m.price) push('price', m.price.value >= 0.01 ? `$${m.price.value.toFixed(2)}` : `$${Number(m.price.value).toPrecision(2)}`, TX('inv.card.price'), '');
    if (m.liquidity) push('liq', mvUsd(m.liquidity.value), TX('inv.card.liquidity'), m.liquidity.value < 10000 ? 'red' : '');
    const sf = h.calls?.sinceFirst;
    if (sf && Math.abs(sf.change) >= 0.05 && sf.change <= 49) push('since', sf.change >= 1 ? `${(sf.change + 1).toFixed(1)}x` : `${sf.change > 0 ? '+' : '−'}${Math.round(Math.abs(sf.change) * 100)}%`, TX('inv.card.sinceFirst'), sf.change <= -0.5 ? 'red' : sf.change >= 0.5 ? 'green' : '');
    if (!alertOn && rk && rk.level !== 'unknown' && stats.length < 3) push('risk', rk.level === 'high' ? TX('inv.card.riskHigh') : rk.level === 'medium' ? TX('inv.card.riskMed') : TX('inv.card.riskLow'), TX('inv.card.risk'), rk.level === 'high' ? 'red' : rk.level === 'low' ? 'green' : 'amber');
    if (m.holders?.top10WalletPct != null && m.holders.known) push('top10', `${Math.round(m.holders.top10WalletPct * 100)}%`, TX('inv.card.top10'), m.holders.top10WalletPct >= 0.3 ? 'red' : 'green');
    if (cn.creatorLaunches?.total > 1 && !c.devHistory) push('creator', String(cn.creatorLaunches.total), TX('inv.card.creator'), cn.creatorLaunches.total >= 10 ? 'red' : '');
    if (cn.deployerTokens?.total > 1) push('deployer', String(cn.deployerTokens.total), cn.deployerTokens.rugged ? TX('inv.card.deployerRugged', {rugged: cn.deployerTokens.rugged}) : TX('inv.card.deployer'), cn.deployerTokens.rugged ? 'red' : '');
    if (dep.launchedAt) push('age', ageSince(dep.launchedAt), TX('inv.card.old'), '');
    if (h.smartAuthors?.length) push('smart', String(h.smartAuthors.length), TX('inv.card.smart'), 'green');
    if (h.authors) push('authors', String(h.authors), TX('inv.card.authors', {n: h.authors}), '');
    const nMax = CFG.limits?.stats ?? 4;
    const shown = new Set(stats.slice(0, nMax).map((x) => x.k));
    const chartOn = !c.own && !!(globalThis.FableChart && (m.price || m.series));
    // a fact the headline, the numbers row or the chart already shows is not said again below them
    const skip = new Set(['liq', 'launch', 'creator', 'deployer', 'posts', 'smart', 'mcap', ...(shown.has('top10') ? ['holders'] : []), ...(shown.has('since') ? ['calls'] : []),
      ...(chartOn ? ['trades'] : []), ...(alertOn ? ['solbundle'] : [])]);
    // the investigation's "How they took it" says it all: the older one-line bundle fact is not repeated under it
    const invHas = (kind) => !!invOf(c) && invOn(kind) && invFacts(invOf(c), kind).length > 0;
    // only the lines that say the same thing again: the older first bundle sentence, and the forensics group's launch count ("the same threat actors are tied to N launches": the investigation's operation replaces it, and a group the operation table does not back is not claimed). Details the investigation does not say (how the wallets were funded, what the creator took) stay.
    const invSaid = [invHas('bundle') && /^(launch:bundle|fx:bundle0$)/, !!invOf(c) && /^fx:more/,
      // 0.30.0 Solana: the snipe fact (inv.sol.snipe) says who bought at launch, how they are linked to the creator, what they sold and took out, with its Solscan
      // proof: the forensics bundle lines that say the same are not drawn again
      invGroup(c, 'rug').some((f) => /^inv\.sol\.snipe/.test(String(f.key || ''))) && /^fx:bundle\d+$/].filter(Boolean);
    let facts = (c.facts || []).filter((f) => !skip.has(f.k) && !(alertOn && /^launch:bundle/.test(f.k)) && !invSaid.some((re) => re.test(f.k))).slice(0, 5);
    // 0.30.0: a forensics line that opens with the bundle's size ("13 of 14 linked wallets held 12% ...") and goes on with how they were set up: with the investigation's
    // bundle sentence on the card, only the part it does not say stays ("The creator registered all 14 to skip the snipe tax, ...")
    if (invHas('bundle')) facts = facts.map((f) => (f.key === 'join.sentences' && /^fx\.linked_/.test(String(f.params?.a?.key || '')) && f.params?.b?.key
      ? {...f, text: String(f.text || '').split(/(?<=\.)\s+/).slice(1).join(' ') || f.text, key: f.params.b.key, params: f.params.b.params} : f));
    const reading = !!c.filling;
    const title = `${TX('inv.card.launchCheck')}${sym ? ` · ${sym}` : ''}${id.name && sym && id.name.toUpperCase() !== sym.slice(1) ? ` · ${id.name}` : ''}`;
    const fresh = (k) => (seen.size && !seen.has(k) ? ' mv-new' : '');
    const statHtml = stats.slice(0, nMax).map((x, n) => `<div class="stat mv-stat ${x.t}${fresh(`s:${x.k}`)}" data-k="${x.k}" ${i(3 + n)}><b>${/^\$?\d+[KMB%]?$/.test(x.v) ? num(x.v) : esc(x.v)}</b><span>${esc(x.l)}</span></div>`).join('');
    if (c.matchedBy?.ticker) facts.unshift({k: 'ticker', tone: '', text: c.matchedBy.alternatives?.length ? TX('inv.card.matchedAlt', {sym: `$${c.matchedBy.ticker}`, n: c.matchedBy.alternatives.length}) : TX('inv.card.matched', {sym: `$${c.matchedBy.ticker}`})});
    // one headline: the hardest fact, said once in full. The other red facts become lines below (none dropped).
    if (c.connections?.shillWave?.level) facts = facts.filter((f) => f.k !== 'shill');
    // with a red alert the headline is its hardest fact; without one, the strongest high-risk fact (amber); the one-line
    // read only when neither exists
    const hard = alertOn ? rk.reasons.filter((x) => x.w === 'severe' || x.w === 'high') : (rk?.reasons || []).filter((x) => x.w === 'high');
    const lead = hard[0] || null;
    if (lead) {
      const said = new Set([lead.text]);
      facts = facts.filter((f) => !said.has(f.text));
      const grouped = compact ? [] : [...invGroup(c, 'rug'), ...invGroup(c, 'actor'), ...invGroup(c, 'push')];
      const more = hard.slice(1).filter((x) => !facts.some((f) => f.text === x.text) && !(x.key === 'bundle' && invHas('bundle')) && !grouped.some((f) => sameFact(x, f))).map((x) => ({k: `risk:${x.key}`, tone: 'bad', text: x.text, ikey: x.ikey, params: x.params}));
      facts = [...more, ...facts];
    }
    const invN = invOf(c) ? ['bundle', 'money', 'snipers', 'wash', 'op', 'promoter'].filter((k) => invOn(k) && invFacts(invOf(c), k).length).length + (invGroup(c, 'rug').length ? 1 : 0) + (invGroup(c, 'actor').length && !invFacts(invOf(c), 'op').length ? 1 : 0) + (invGroup(c, 'push').length && !invFacts(invOf(c), 'promoter').length ? 1 : 0) : 0;
    facts = facts.slice(0, invN >= 4 ? Math.min(2, CFG.limits?.facts ?? 3) : (CFG.limits?.facts ?? 3));
    const factHtml = facts.map((f, n) => `<div class="mv-fact ${f.tone || ''}${fresh(`f:${f.k}`)}" ${i(6 + n)}><i>${MARK[f.tone || '']}</i>${esc(FX(f))}</div>`).join('');
    const readingHtml = reading ? `<div class="mv-reading" ${i(6 + facts.length)}><span class="th-spin"></span>${TT('inv.card.reading')}</div>` : '';
    const onchain = c.onchain?.at ? TX('inv.card.onchain', {ago: cxAgo(c.onchain.at)}) : '';
    const dossier = '';
    const foot = `<div class="mv-foot" ${i(12)}><span>${h.firstCaptured ? esc(TX('inv.card.firstSeen', {ago: cxAgo(h.firstCaptured.at), handle: h.firstCaptured.handle})) : TT('inv.card.firstTime')}</span><span>${esc(onchain)}${dossier}</span></div>`;
    const keys = [...stats.slice(0, nMax).map((x) => `s:${x.k}`), ...facts.map((f) => `f:${f.k}`), ...invKeys(c)];
    const chart = c.own ? '' : chartOn ? `<div class="mv-fc" ${i(2)}></div>` : mvChart(m.series, m.price?.value);
    // the headline: a red fact when there is one (tagged with what it is), else the one-sentence read of the coin
    const TAG = CFG.copy?.tags || {};
    const tagWord = (k) => (typeof TAG[k] === 'string' && TAG[k] ? (cfgWord('tags', k) ?? (Object.hasOwn(TAG_KEY, k) ? TX(TAG_KEY[k]) : TR(TAG[k]))) : Object.hasOwn(TAG_KEY, k) ? TX(TAG_KEY[k]) : '');
    // when the headline is the bundle, the investigation's sentence (who took it, what they did with it, its proof) is the headline: the
    // card does not say the same bundle twice, the second time longer
    const invB = lead?.key === 'bundle' && invHas('bundle') ? (invFacts(invOf(c), 'bundle').find((f) => !groupOf(f)) || invFacts(invOf(c), 'bundle')[0]) : null;
    // 0.30.0: a rug reason the investigation proves (the same sentence, or the same key and params) is the headline with its proof chips, and is not said again below
    const invL = !invB && lead ? [...invGroup(c, 'rug'), ...invGroup(c, 'actor'), ...invGroup(c, 'push')].find((f) => sameFact(lead, f)) || null : null;
    const invH = invB || invL;
    const headline = lead ? `<div class="mv-alert mv-hl6${alertOn || pillCap(c) === 'bad' ? '' : ' amber'}" ${invH ? `data-inv="${esc(invB ? 'bundle' : invL.id || invL.kind)}"` : ''} ${i(1)}><b>${esc(tagWord(lead.key) || rugTag(lead) || (alertOn ? (rk.alertTitle ? FX({text: rk.alertTitle, key: rk.alertTitleKey, params: rk.alertTitleParams}) : TX('inv.tag.highRisk')) : TX('inv.tag.risk')))}</b><span>${invH ? `${esc(FX(invH))}${pfHtml(invH.proof)}` : esc(FX(lead))}</span></div>`
      : readHtml(contractRead(c, hist, {noPrice: shown.has('since'), noLauncher: (c.devHistory?.launched || 0) >= 2, noCaller: !!hist?.days}));
    const nStats = Math.min(nMax, stats.length);
    // the compact card (built before the investigation's sections, the costly part, are): the coin's header, its hardest fact (the headline), the numbers, the Full card button; everything else is one tap away (the button, or the detail sheet)
    if (compact) {
      const cfoot = `<div class="mv-foot" ${i(4)}><span>${esc(onchain)}</span><button class="mv-more" type="button" data-more aria-expanded="false">${TT('inv.card.full')}</button></div>`;
      return {keys, html: mvCard('contract', mvHead(sym ? `${sym}${id.name && id.name.toUpperCase() !== sym.slice(1) ? ` · ${id.name}` : ''}` : TX('inv.card.launchCheck'), mvShort(id.address), true, id.image),
        cardBody('contract', {headline, stats: statHtml ? `<div class="mv-stats n${nStats}">${statHtml}</div>` : '', foot: cfoot}), `${alertOn ? 'alert' : ''} compact`)};
    }
    // coverage 'partial' (the linking history is still growing): the counts are lower bounds, said in small print under the last section
    const said = new Set([...(invB ? ['bundle'] : []), ...(invL ? [invL.text] : [])]);
    const rug = rugSection(c, fresh, said);
    // with the rug section drawn, the bundle and the money trail are in it; a wash-then-dump fact says the wash share before the sell-off, the plain wash row is not said again
    const skipRows = rug ? ['bundle', 'money', 'snipers', 'wash'] : invB ? ['bundle'] : [];
    const invParts = {rug, inv: invRows(c, fresh, skipRows), op: opSection(c, fresh, said), pushed: pushedSection(c, fresh, excl, said)};
    if (invOf(c)?.coverage === 'partial') {
      const last = ['pushed', 'op', 'inv', 'rug'].find((k) => invParts[k]);
      if (last) invParts[last] = invParts[last].replace(/<\/div>\s*$/, () => `<div class="mv-inv-note" ${i(9.8)}>${TT('inv.coverage.note')}</div></div>`);
    }
    return {keys, html: mvCard('contract', mvHead(sym ? `${sym}${id.name && id.name.toUpperCase() !== sym.slice(1) ? ` · ${id.name}` : ''}` : TX('inv.card.launchCheck'), mvShort(id.address), true, id.image),
      cardBody('contract', {headline, chart, stats: statHtml ? `<div class="mv-stats n${nStats}">${statHtml}</div>` : '', facts: factHtml || readingHtml ? `<div class="mv-facts">${factHtml}${readingHtml}</div>` : '',
        rug: invParts.rug, inv: invParts.inv, shill: shillSection(c.connections?.shillWave, new Set([...pushedList(c, excl).map((r) => String(r.handle || '').toLowerCase()), ...(excl ? [String(excl).toLowerCase()] : [])])), also: alsoSection(others), dev: devSection(c.devHistory), op: invParts.op, pushed: invParts.pushed, track: trackSection(hist), foot}), alertOn ? 'alert' : '')};
  };

  // a referral / invite link in the post itself (the video's "Referral link detected in post")
  const REF = /[?&](ref|referral|refcode|invite|invitecode|code|affiliate|aff|via)=[^&\s]+|\/(ref|r|invite|referral|join)\/[A-Za-z0-9_-]{3,}|t\.me\/[A-Za-z0-9_]+bot\?start=|@[A-Za-z0-9_]+\?ref/i;
  // an invite link of a trading tool (proxima.tools/@code, axiom.trade/@code, padre.gg/@code ...) or a referral parameter: the post is an ad. A project's
  // Discord or Telegram invite is not (rule: a paid partnership reads as promotion, never positive; a legit project is not flagged for its Discord)
  const AD_LINK = /\b(proxima\.tools|axiom\.trade|padre\.gg|tinyastro\.io|bullx\.io|photon-sol\.[a-z.]+|fomo\.family)\/(@|r\/|rk\/|ref\/)[A-Za-z0-9_-]{3,}|[?&](ref|referral|refcode|aff|affiliate)=[^&\s]+/i;
  const adLinkIn = (tw) => [...(tw?.urls || []), tw?.text || ''].some((u) => AD_LINK.test(String(u)));
  // the post is an ad: an invite link of a trading tool, or X's own "Paid partnership" label (a link to its paid-partnerships policy inside the article, or the label as the last line)
  const adIn = (article, tw) => adLinkIn(tw) || !!article?.querySelector?.('a[href*="paid-partnerships"]') || /(^|\n)\s*(paid partnership|#ad)\s*$/i.test(String(tw?.text || ''));
  const refLinkIn = (tw) => [...(tw?.urls || []), tw?.text || ''].some((u) => REF.test(String(u)));
  const promoCard = (h, refLink = false) => {
    const tiles = h.promos.slice(0, 9);
    const measured = h.promos.filter((p) => p.sinceCall != null);
    const deep = measured.filter((p) => p.sinceCall <= -0.9).length;
    const tile = (p, n) => {
      const x = p.sinceCall ?? p.fromPeak;
      const cls = x == null ? 'pend' : x < 0 ? 'down' : 'up';
      const res = x == null ? (p.mcap ? mvUsd(p.mcap) : p.chain === 'solana' ? 'SOL' : p.chain ? p.chain.slice(0, 4).toUpperCase() : '·') : TX(p.sinceCall == null ? 'promo.tile.resultPeak' : 'promo.tile.result', {mark: x < 0 ? '✕' : '✓', pct: mvPct(x)});
      return `<a class="mv-tile ${cls}" href="${esc(p.url || '#')}" target="_blank" rel="noopener" ${i(2 + n * 0.8)}>${p.image && /^https:\/\//.test(p.image) ? `<img class="tl" src="${esc(p.image)}" alt="" referrerpolicy="no-referrer">` : `<span class="tl ph">${esc((p.symbol || '?').slice(0, 1))}</span>`}<b>${esc(p.symbol ? `$${p.symbol}` : mvShort(p.address))}</b>${p.bundled ? `<em class="bd">${TT('promo.tile.bundled')}</em>` : ''}<span class="res">${esc(res)}</span></a>`;
    };
    const left = measured.length ? `<b class="${deep / measured.length >= 0.5 ? 'red' : ''}">${TT('promo.card.deepDown', {deep, n: measured.length})}</b>` : `<b>${TT('promo.card.called30', {n: h.promosTotal})}</b>`;
    return mvCard('promo', mvHead(TX('promo.card.title')),
      `${readHtml(promoRead(h))}<div class="mv-tiles">${tiles.map(tile).join('')}</div>${mvHeat(h.days).replace('mv-heat v3', 'mv-heat v3 slim')}<div class="mv-foot" ${i(10)}>${left}<span>${refLink ? TT('promo.card.refLink') : TT(tiles.some((p) => p.sinceCall == null && p.fromPeak != null) ? 'promo.card.calledPeak' : 'promo.card.calledCount', {n: h.promosTotal})}</span></div>`);
  };

  // 0.28 profile panel: an account's promotion record, from intel /v1/history `promo` (calls only: a post that warns about a coin or just
  // mentions it never counts). Plain counts, each recent launch a tile that opens the post.
  const REC_OUT = {rugged: ['down', '✕', 'inv.out.rugged'], rug: ['down', '✕', 'inv.out.rugged'], died: ['down', '✕', 'inv.out.dead'], dead: ['down', '✕', 'inv.out.dead'], bonded: ['up', '✓', 'inv.out.graduated'], graduated: ['up', '✓', 'inv.out.graduated'],
    live: ['up', '', 'inv.out.trading'], alive: ['up', '', 'inv.out.trading'], trading: ['up', '', 'inv.out.trading']};
  const humanKind = (k) => { const t = String(k || '').replace(/[_-]+/g, ' ').trim(); return t ? t[0].toUpperCase() + t.slice(1) : ''; };
  const promoRecord = (p, handle) => {
    const n = Number(p?.promoted_launches);
    if (!p || !(n >= 1) || !on('invProfile')) return '';
    const rug = Math.max(0, Number(p.rugged) || 0), paid = Number(p.paid_disclosures) || 0, med = p.median_secs_after_insider_sell;
    const stats = [
      {v: String(n), l: TX('promo.rec.launches', {n}), t: ''},
      {v: String(rug), l: TX('promo.rec.rugged'), t: rug && n >= 3 && rug / n >= 0.5 ? 'red' : ''},
      med != null && isFinite(Number(med)) ? {v: secTxt(med), l: TX(Number(med) >= 0 ? 'promo.rec.medianAfter' : 'promo.rec.medianBefore'), t: '', m: 1} : null,
      paid ? {v: String(paid), l: TX('promo.rec.paid', {n: paid}), t: ''} : null].filter(Boolean);
    const recent = (Array.isArray(p.recent) ? p.recent : []).filter((x) => x && (x.symbol || x.token)).slice(0, 9);
    const tile = (x, k) => {
      const [cls, mark, wordKey] = REC_OUT[String(x.outcome || '').toLowerCase()] || ['pend', '', ''];
      const word = wordKey ? TX(wordKey) : '', res = word ? `${mark ? `${mark} ` : ''}${word}` : '';
      const sym = x.symbol ? `$${x.symbol}` : mvShort(x.token), date = tsMs(x.post_ts) ? new Date(tsMs(x.post_ts)).toISOString().slice(0, 10) : '';
      const tip = word ? TX(date ? 'promo.rec.tipOutDate' : 'promo.rec.tipOut', {sym, out: word, date}) : date ? TX('promo.rec.tipDate', {sym, date}) : sym;
      const href = httpsUrl(x.url) || (/^\d+$/.test(String(x.post_id || '')) ? `https://x.com/${encodeURIComponent(handle)}/status/${x.post_id}` : '#');
      return `<a class="mv-tile ${cls}" href="${esc(href)}" target="_blank" rel="noopener" title="${esc(tip)}" ${i(2 + k * 0.5)}><span class="tl ph">${esc((x.symbol || '?').slice(0, 1))}</span><b>${esc(sym)}</b>${res ? `<span class="res">${esc(res)}</span>` : ''}</a>`;
    };
    const nets = (Array.isArray(p.networks) ? p.networks : []).filter((x) => x && (x.kind || x.text) && Number(x.accounts) >= 2).slice(0, 2)
      .map((x, k) => `<span class="mv-chip sm a" ${i(4 + k * 0.3)}>${esc(typeof x.text === 'string' && x.text.trim() ? FX({text: x.text.trim(), key: x.key, params: x.params}) : TX('promo.rec.network', {kind: humanKind(x.kind), n: x.accounts}))}</span>`).join('');
    return mvCard('record', mvHead(secCopy('record'), `@${handle}`, true),
      `<div class="mv-stats n${stats.length}">${stats.map((x, k) => `<div class="stat mv-stat ${x.t}" ${i(1 + k * 0.3)}><b>${esc(x.v)}</b><span>${esc(x.l)}</span></div>`).join('')}</div>${recent.length ? `<div class="mv-tiles">${recent.map(tile).join('')}</div>` : ''}${nets ? `<div class="mv-chips mv-nets">${nets}</div>` : ''}<div class="mv-foot" ${i(6)}><span>${TT(stats.some((x) => x.m) ? 'promo.rec.footMedian' : 'promo.rec.foot')}</span><span></span></div>`, 'rec');
  };

  // 0.30.0 profile panel: an account's proven bad play (intel /v1/history `badplay`: shill campaigns, impersonation, phishing links, promoted then dumped), one line per
  // fact with its proof chips (the post, the tx), worst first, at most limits.badplayRows. The server writes every sentence; an allegation says so in its own words.
  // Switch on.invBadplayProfile.
  const badplayCard = (h, handle) => {
    const b = h && !h.error ? h.badplay : null;
    const facts = (Array.isArray(b?.facts) ? b.facts : Array.isArray(b) ? b : []).filter((f) => f && typeof f.text === 'string' && f.text.trim());
    if (!facts.length || !on('invBadplayProfile')) return '';
    const seen = new Set();
    const list = facts.filter((f) => !seen.has(f.text.trim()) && seen.add(f.text.trim())).sort((x, y) => (TONE_RANK[x.tone] ?? 2) - (TONE_RANK[y.tone] ?? 2)).slice(0, Math.max(1, CFG.limits?.badplayRows ?? 4));
    const rows = list.map((f, n) => { const t = INV_TONE[f.tone] ?? ''; return `<div class="mv-fact sm ${t}" data-bp="${esc(String(f.kind || ''))}" ${i(1.4 + n * 0.3)}><i>${MARK[t]}</i><span class="tx">${linkHandles(FX(f))}${pfHtml(f.proof)}</span></div>`; }).join('');
    return mvCard('badplay', mvHead(secCopy('badplay'), `@${handle}`, true), `<div class="mv-bp">${rows}</div>`, INV_TONE[list[0].tone] === 'bad' ? 'bp-bad' : '');
  };

  // Track record: the video's builder grid, coloured by what happened after each day's posts
  const recordLine = (h) => {
    const r = h.record || {};
    const bits = [r.builds && TX('track.chip.builds', {n: r.builds}), r.good && TX('track.chip.good', {n: r.good}), r.bad && TX('track.chip.bad', {n: r.bad})].filter(Boolean);
    return bits.join(' · ') || TX('track.seenDays', {n: h.coverage.observedDays});
  };
  const GH_LEGEND = () => `<span class="gh-leg"><span class="ramp"><i class="q-g1"></i><i class="q-g2"></i><i class="q-g3"></i><i class="q-g4"></i></span>${TT('track.legend.more')}<i class="q-r4"></i>${TT('track.legend.bad')}</span>`;
  const recordChips = (h, start = 9) => {
    const r = h.record || {}, obs = h.coverage?.observedDays || 0;
    const chips = [r.builds && ['g', `✓ ${TX('track.chip.builds', {n: r.builds})}`], r.good && ['g', `✓ ${TX('track.chip.good', {n: r.good})}`],
      r.bad && ['r', `✕ ${TX('track.chip.bad', {n: r.bad})}`], h.caHistory?.total >= 2 && [h.caHistory.dead >= 2 ? 'r' : 'n', TX('track.chip.contracts', {n: h.caHistory.total})], obs && ['n', TX('track.chip.days', {n: obs})]].filter(Boolean).slice(0, 4);
    const yrs = h.profile?.yearsOnX;
    return `<div class="mv-chips">${chips.map(([tone, text], n) => `<span class="mv-chip ${tone}" ${i(start + n * 0.4)}>${esc(text)}</span>`).join('')}${yrs ? `<span class="mv-aside" ${i(start + 1)}>${TT('track.yearsOnX', {n: yrs})}</span>` : ''}</div>`;
  };
  const trackLine = (h) => {
    const r = h.record || {}, obs = h.coverage?.observedDays || 0;
    const b = (cls, v) => RAW(`<b${cls ? ` class="${cls}"` : ''}>${v}</b>`);
    return [r.good && TT('track.line.heldUp', {n: r.good, count: b('green', r.good)}), r.bad && TT('track.line.wentBad', {n: r.bad, count: b('red', r.bad)}), r.builds && TT('track.line.builds', {count: b('green', r.builds)}),
      h.caHistory?.total >= 2 && TT('track.line.contracts', {count: b('', h.caHistory.total)}), obs && TT('track.line.seenOn', {n: obs, count: b('', obs)})].filter(Boolean).slice(0, 3).join('<i>·</i>');
  };
  const trackSection = (h) => {
    if (!h?.days) return '';
    // the count line already says how many contracts; a bare "Posted N contracts" fact would repeat it
    // (decided on the numbers, not on the sentence: the sentence is in the viewer's language, and "Posted N contracts: ..." has its colon only when it names dead / bundled / deleted ones)
    const ca = h.caHistory, bare = !(ca?.dead || ca?.bundled || ca?.deleted);
    const f = authorFacts(h).find((x) => !(x.k === 'cas' && bare));
    const line = trackLine(h);
    if (!line && !f) return '';
    return `<div class="mv-sec" data-author="track" ${i(9)}><div class="mv-sec-h"><span class="t">${TT('track.heading', {title: secCopy('posted'), who: RAW(`<a class="mv-hl" href="https://x.com/${encodeURIComponent(h.handle)}" target="_blank" rel="noopener">@${esc(h.handle)}</a>`)})}${rankBadge(h.rank)}</span>${h.profile?.yearsOnX ? `<span class="mono">${TT('track.yearsShort', {n: h.profile.yearsOnX})}</span>` : ''}</div>
      ${line ? `<div class="mv-sec-n">${line}</div>` : ''}${f ? `<div class="mv-fact sm ${f.tone}" ${i(9.5)}><i>${MARK[f.tone || '']}</i>${esc(f.text)}</div>` : ''}</div>`;
  };
  // builder grid from GitHub: one square per week (about 2.5 years), shaded by the builder's own busy / quiet weeks
  const ghHeat = (gh) => {
    const weeks = (gh?.weeks || []).slice(-HEAT_ROWS * HEAT_COLS);
    const t = quart(weeks.map((w) => w.count));
    return `<div class="mv-heat v3 v4" style="--rows:${HEAT_ROWS};--cols:${Math.max(1, Math.ceil(weeks.length / HEAT_ROWS))}">${weeks.map((w, n) => { const lv = lvOf(w.count, t); return `<i class="q-${lv ? `g${lv}` : 'e'}" style="--c:${Math.floor(n / HEAT_ROWS)}" title="${esc(TX('builder.weekTip', {start: w.start, n: w.count}))}"></i>`; }).join('')}</div>`;
  };
  const ghActive = (gh) => (gh.weeks || []).slice(-HEAT_ROWS * HEAT_COLS).filter((w) => w.count > 0).length;
  const ghKey = () => `<div class="mv-key gh" ${i(8)}><span>${TT('builder.key.week')}</span><span class="scale">${TT('builder.key.less')}<i class="q-e"></i><i class="q-g1"></i><i class="q-g2"></i><i class="q-g3"></i><i class="q-g4"></i>${TT('builder.key.more')}</span></div>`;
  // the one short line at the end of the builder chips: what the grid below it is made of
  const builderAside = (h, days) => {
    const gh = h.github;
    if (gh?.total) {
      const since = gh.firstActive ? String(gh.firstActive).slice(0, 4) : '';
      return builderRead(h) && gh.weeks?.length ? TX(since ? 'builder.activeWeeksSince' : 'builder.activeWeeks', {n: ghActive(gh), total: Math.min(gh.weeks.length, HEAT_ROWS * HEAT_COLS), year: since})
        : TX(since ? 'builder.commitsSince' : 'builder.commits', {n: gh.total, year: since});
    }
    return h.profile?.yearsOnX ? TX('builder.yearsDays', {y: h.profile.yearsOnX, n: days}) : TX('builder.days', {n: days});
  };
  const builderCard = (h) => {
    const named = (h.ships || []).slice(0, 4).map((x, n) => `<span class="mv-chip" ${i(2 + n)}>✓ ${esc(x)}</span>`).join('');
    const chips = named || (h.builds || []).slice(0, 4).map((b, n) => `<a class="mv-chip" href="${esc(b.url)}" target="_blank" rel="noopener" ${i(2 + n)}>✓ ${esc(b.name)}</a>`).join('');
    const days = h.counts?.building || 0;
    return mvCard('builder', mvHead(TX('builder.title')),
      `${readHtml(builderRead(h))}<div class="mv-chips">${chips}<span class="mv-aside" ${i(3)}>${esc(builderAside(h, days))}</span></div>${h.github?.weeks?.length ? `${ghHeat(h.github)}${ghKey()}` : mvHeat(h.days)}${h.smart?.n ? `<div class="mv-foot" ${i(10)}><span class="mv-mini">${(h.smart.people || []).filter((p) => p.avatar).slice(0, 3).map((p) => face(p.avatar, p.handle)).join('')}${TT('smartcard.followedBy', {n: h.smart.n})}</span><span></span></div>` : ''}`);
  };

  const activityCard = (h) => mvCard('activity', mvHead(TX('track.title')), `${recordChips(h, 2)}${authorFactsHtml(h, 3)}${mvHeat(h.days)}`);
  // the card an account's history makes when there is no coin card: promotion history, build history, or activity (the smart-followers card is the Backstory row on a profile)
  const authorCardFor = (hist) => {
    if (hist?.promosTotal >= 2 && kindOn('promo')) return promoCard(hist, false);
    if (kindOn('builder') && hist && (hist.github?.weeks?.length || ((hist.counts?.building || hist.builds?.length || hist.ships?.length) && (hist.coverage?.observedDays || 0) >= 15))) return builderCard(hist);
    if (kindOn('activity') && (hist?.coverage?.observedDays >= 3 || hist?.promosTotal)) return activityCard(hist);
    return '';
  };

  // a smart account's category tag (src/smart.js: "Trader", "Founder · Solana"): registered words, the organisation after the dot stays as it is
  const SMART_TAG = {Trader: 'smartcard.tag.trader', Researcher: 'smartcard.tag.researcher', 'Onchain analytics': 'smartcard.tag.onchainAnalytics', News: 'smartcard.tag.news', Media: 'smartcard.tag.media', Investor: 'smartcard.tag.investor',
    Investigator: 'smartcard.tag.investigator', Founder: 'smartcard.tag.founder', 'Early caller': 'smartcard.tag.earlyCaller', Collector: 'smartcard.tag.collector', Builder: 'smartcard.tag.builder', VC: 'smartcard.tag.vc'};
  const SMART_TAG_ORG = {VC: 'smartcard.tag.vcOrg', Media: 'smartcard.tag.mediaOrg', Founder: 'smartcard.tag.founderOrg', Builder: 'smartcard.tag.builderOrg'};
  const smartTag = (t) => { const s = String(t), m = s.match(/^(VC|Media|Founder|Builder) · (.+)$/); return m ? TX(SMART_TAG_ORG[m[1]], {org: m[2]}) : Object.hasOwn(SMART_TAG, s) ? TX(SMART_TAG[s]) : TR(s); };
  const smartCard = (row, ships = []) => {
    const people = (row.all || row.people || []).slice(0, 3);
    const shipChips = ships?.length ? `<div class="mv-chips" style="margin-bottom:6px">${ships.slice(0, 4).map((x, n) => `<span class="mv-chip" ${i(1.5 + n * 0.3)}>✓ ${esc(x)}</span>`).join('')}</div>` : '';
    const just = row.recent?.length ? `<div class="mv-just" ${i(2)}><span class="pile">${row.recent.filter((p) => p.avatar).slice(0, 3).map((p) => face(p.avatar, p.handle)).join('')}</span>${TT('smartcard.justFollowed', {list: handleList(row.recent)})}</div>` : '';
    const overlap = row.topPct ? `<div class="mv-overlap" ${i(6)}><span>${TT('smartcard.overlap')}</span><span class="track"><span class="fill" style="--w:${Math.max(8, 100 - row.topPct)}%"></span></span><b>${TT('smartcard.topPct', {pct: row.topPct})}</b></div>` : '';
    return mvCard('smart', mvHead(TX('smartcard.followedBy', {n: row.n || people.length})),
      shipChips + just + people.map((p, n) => `<a class="mv-person" href="https://x.com/${esc(p.handle)}" target="_blank" rel="noopener" ${i(2 + n)}>${av(p.avatar, 'pav')}<b>${esc(p.name || p.handle)}</b>${p.verified ? `<svg class="vbadge" viewBox="0 0 22 22" aria-label="${esc(TX('smartcard.verified'))}"><path d="M20.4 11c0-1.4-.8-2.6-2-3.2.4-1.3.1-2.8-.9-3.8s-2.5-1.3-3.8-.9C13.1 1.9 11.9 1.1 10.5 1.1S7.9 1.9 7.3 3.1c-1.3-.4-2.8-.1-3.8.9s-1.3 2.5-.9 3.8C1.4 8.4.6 9.6.6 11s.8 2.6 2 3.2c-.4 1.3-.1 2.8.9 3.8s2.5 1.3 3.8.9c.6 1.2 1.8 2 3.2 2s2.6-.8 3.2-2c1.3.4 2.8.1 3.8-.9s1.3-2.5.9-3.8c1.2-.6 2-1.8 2-3.2Z" fill="#1d9bf0"/><path d="m9.4 14.6-3.3-3.3 1.4-1.4 1.9 1.9 5-5 1.4 1.4-6.4 6.4Z" fill="#fff"/></svg>` : ''}<span>@${esc(p.handle)}</span>${(p.tag || p.category) && !/^(other|smart)$/i.test(p.tag || p.category) ? `<em class="mv-tag">${esc(smartTag(p.tag || p.category))}</em>` : ''}</a>`).join('')
      + overlap + ((row.n || 0) > people.length ? `<div class="mv-foot" ${i(7)}><span>${TT('smartcard.more', {n: row.n - people.length})}</span><span></span></div>` : ''));
  };

  // one activity clock for the page: live charts only stream while the viewer is actually scrolling or moving
  let lastActive = Date.now();
  for (const ev of ['scroll', 'wheel', 'mousemove', 'keydown', 'touchstart']) window.addEventListener(ev, () => { lastActive = Date.now(); }, {passive: true, capture: true});
  // candles are asked for the moment a contract is seen (in parallel with the card's own data), so the chart paints
  // with the card; the server picks the candle size from the coin's age ('auto'), and the chart opens a coin younger than
  // 5 minutes on 1 s candles
  // one candles read per coin and timeframe for 8 s: the prefetch and the card's chart share it
  const CANDLES = new Map();
  const candlesFor = (address, chain, tf = 'auto', from = null) => {
    const k = `${chain || ''}:${address}:${tf}:${from || ''}`, hit = CANDLES.get(k);
    if (hit && performance.now() - hit.at < (CFG.timing?.candlesCacheMs ?? 8000)) return hit.p;
    const p = chrome.runtime.sendMessage({type: 'candles', address, chain, tf, ...(from ? {from} : {})}).catch(() => null);
    CANDLES.set(k, {at: performance.now(), p});
    if (CANDLES.size > 200) CANDLES.delete(CANDLES.keys().next().value);
    return p;
  };
  const chartFor = (root, c, tweetTime, first = null) => {
    const st = {api: null, data: null, tf: 'auto', port: null, visible: false};
    const address = c.identity?.address, chain = c.identity?.chains?.[0] || c.identity?.chainBasis || null;
    // the card's market cap follows the chart it sits under: last trade x supply, the number the chart's MC axis shows
    // (the card said $12K under a live chart at $10.9K: the median of 7 prints vs the last one). Once a frame at most.
    const born = performance.now();
    let capP = 0, capRaf = 0;
    const applyCap = (p) => {
      const sup = st.data?.supply, b = root.querySelector('.mv-stat[data-k="mcap"] b');
      if (!b || !(p > 0) || !(sup > 0)) return;
      const v = mvUsd(p * sup);
      const apply = () => { if (b.textContent !== v) b.textContent = v; };
      const wait = 900 - (performance.now() - born); // after the count-up animation
      if (wait > 0) setTimeout(apply, wait); else apply();
    };
    const setCap = (p) => { capP = p; if (!capRaf) capRaf = requestAnimationFrame(() => { capRaf = 0; applyCap(capP); }); };
    const box = () => root.querySelector('.mv-fc');
    // a chart as soon as there is anything to draw: one candle, one trade (its bubble), or a live coin waiting for its first trade
    const has = (d) => !!(d && (d.candles?.length || d.trades?.length || (d.live && d.stored != null)));
    const load = async (pre = null, tf = st.tf, from = null) => {
      const d = await (pre || candlesFor(address, chain, tf, from));
      if (has(d)) {
        if (d.tf) st.tf = d.tf;
        st.data = d; st.api?.setData(d); box()?.classList.remove('empty');
        const lc = d.candles?.[d.candles.length - 1], lt = d.trades?.[d.trades.length - 1];
        if (lc || lt) setCap(lc ? lc[4] : lt[1]);
      } else if (!st.data) box()?.classList.add('empty');
    };
    // older candles for zoom / pan / All (from, to in ms); the chart puts them in front of what it holds
    const range = async (q) => {
      const d = await chrome.runtime.sendMessage({type: 'candles', address, chain, tf: q.tf, from: q.from, to: q.to}).catch(() => null);
      st.api?.merge(d, q);
    };
    const mount = () => {
      const el = box();
      if (!el || !globalThis.FableChart) return;
      // a remount (the card redrawn while the chain is read) keeps the chart's candles, live trades and timeframe
      const keep = st.api?.save?.();
      st.api?.destroy();
      const la = c.deployment?.launchedAt, born = typeof la === 'number' ? la : Date.parse(la || '') || null; // launch time: 1 s candles for a fresh coin, the floor of All
      st.api = FableChart.mount(el, {tf: st.tf, postTime: tweetTime, born, restore: keep, onTf: (tf, o) => load(null, tf, o?.from || null), onRange: range});
      if (keep && st.data) { /* restored */ } else if (st.data) st.api.setData(st.data); else { load(first); first = null; }
      // 0.30.1 chart markers: Robinhood coins only, and only while the remote switch on.chartMarkers is true (default off); one read per card
      // ($PONS and $FABLE are never marked: the server sends none for them, and the card does not ask)
      if (!keep?.marks && CFG.on?.chartMarkers === true && /^0x[0-9a-f]{40}$/i.test(address || '') && (!chain || chain === 'robinhood') && !st.marksAsked
        && !c.own && !["0x39dbed3a2bd333467115de45665cc57f813c4571", ...(CFG.rules?.ownTokens || [])].some((x) => String(x).toLowerCase() === String(address).toLowerCase())) {
        st.marksAsked = true;
        chrome.runtime.sendMessage({type: 'markers', address}).then((d) => { if (d && Array.isArray(d.ev) && d.ev.length) st.api?.setMarks?.(d); }).catch(() => null);
      }
      if (st.port) st.api.setLive(true);
    };
    const hostEl = root.host;
    const sync = () => {
      const want = st.visible && document.visibilityState === 'visible' && Date.now() - lastActive < (CFG.timing?.liveIdleMs ?? 60e3) && hostEl.isConnected && on('liveCharts');
      if (want && !st.port) {
        st.port = chrome.runtime.connect({name: 'live'});
        st.port.postMessage({address, chain});
        // trades and ticks ({p}), {type:'status', live, delayed} and {type:'void', tx}: the chart batches them per frame
        st.port.onMessage.addListener((msg) => {
          // a tick the server kept and handed to a new viewer (old t) is not a live price: not for the chart, not for
          // the card's market cap. The hub no longer sends them (fable-live fbc45e0e); intel's old per-coin room still can.
          if (msg?.type === 'tick' && +msg.t > 0 && Date.now() - (+msg.t < 1e12 ? +msg.t * 1000 : +msg.t) > 120e3) return;
          st.api?.live(msg);
          if (msg?.p > 0 && msg.type !== 'void') { setCap(msg.p); const el = box(); if (el?.classList.contains('empty')) el.classList.remove('empty'); }
        });
        st.port.onDisconnect.addListener(() => { st.port = null; st.api?.setLive(false); });
      } else if (!want && st.port) { st.port.disconnect(); st.port = null; st.api?.setLive(false); }
    };
    const io = new IntersectionObserver(([e]) => { st.visible = e.isIntersecting; sync(); }, {threshold: 0.2});
    io.observe(hostEl);
    document.addEventListener('visibilitychange', sync);
    const timer = setInterval(() => { if (!hostEl.isConnected) { clearInterval(timer); io.disconnect(); st.port?.disconnect(); st.api?.destroy(); return; } sync(); }, 5000);
    mount();
    return {remount: mount};
  };

  const stampPost = (article, text, t, played) => {
    const target = article.querySelector('[data-testid="tweetPhoto"], [data-testid="videoComponent"], [data-testid="card.wrapper"]') || [...article.querySelectorAll('[data-testid="tweetText"]')].find((el) => !el.closest('[role="link"][tabindex]'));
    if (!target) return;
    const s = document.createElement('div');
    s.setAttribute('data-fable-host', 'stamp');
    s.setAttribute('data-by', 'chain');
    s.className = 'fable-stamp-host';
    article.appendChild(s);
    const place = () => { const a = article.getBoundingClientRect(), r = target.getBoundingClientRect(); s.style.left = `${r.left - a.left + r.width / 2}px`; s.style.top = `${r.top - a.top + r.height / 2}px`; s.style.setProperty('--k', r.height < 60 ? '0.6' : r.height < 140 ? '0.78' : '1'); };
    place();
    requestAnimationFrame(place);
    new ResizeObserver(place).observe(article);
    // a stamp word in CJK / Thai is wider per character than a Latin capital: more than 4 characters step the size down so it stays on one line
    const cps = [...String(text)], wide = cps.some((c) => c.codePointAt(0) > 0x2e7f), fs = wide && cps.length > 4 ? Math.max(24, Math.floor(216 / cps.length)) : 0;
    mountShadow(s, `<div class="stamp ink"><span${fs ? ` style="font-size:${fs}px;line-height:${Math.round(fs * 1.2)}px"` : ''}>${esc(text)}</span><em>${fox('fox')}FABLE</em></div>`, t, played);
    { const k = !STAMP_RESTORE && KEEP.get(String(idOf(article))); if (k && k.stamps.length < 4) k.stamps.push((a) => stampPost(a, text, t, true)); }
  };
  // the one hardest fact behind the pill, in a line that fades in under it
  const setWhy = (article, text, tone = '') => {
    const root = article.querySelector('[data-fable-host="ui"]')?.shadowRoot;
    const ctx = root?.querySelector('.ctx');
    if (!ctx || !text) return;
    let w = root.querySelector('.why');
    if (!w) { w = document.createElement('div'); ctx.insertAdjacentElement('afterend', w); }
    w.className = `why ${tone}`;
    w.textContent = text;
  };
  const handleList = (xs) => (xs.length > 2 ? TX('author.handles.more', {a: `@${xs[0].handle}`, b: `@${xs[1].handle}`, n: xs.length - 2})
    : xs.length === 2 ? TX('author.handles.two', {a: `@${xs[0].handle}`, b: `@${xs[1].handle}`}) : xs.length ? `@${xs[0].handle}` : '');
  // Frontrun's profile signals, as plain facts: just followed by smart accounts, past handles, every contract posted
  // rank badges (src/rank.js on the server): the tier in plain words when the numbers earn one, else the plain position
  const rankTone = (tier) => (/^Top/.test(tier || '') ? 'good' : /^(Bottom|Serial|Push)/.test(tier || '') ? 'bad' : '');
  // only a tier the numbers earn is shown; a bare position means little without its reasons
  const rankBadge = (r) => (r?.tier ? `<em class="mv-rk ${rankTone(r.tier)}" title="${esc(r.rank ? TX('author.rankOf', {rank: r.rank, of: r.of}) : TR(r.ring || ''))}">${esc(TR(r.tier))}</em>` : '');
  const pctTxt = (x) => `${Math.round((x || 0) * 100)}%`;
  const authorFacts = (h) => {
    const out = [];
    if (!h) return out;
    const rk = h.rank;
    if (rk?.n >= 3) {
      const med = rk.medNow != null ? `${rk.medNow >= 0 ? '+' : ''}${Math.round(rk.medNow * 100)}%` : null;
      out.push({k: 'rank', tone: rankTone(rk.tier) === 'good' ? 'good' : rankTone(rk.tier) === 'bad' ? 'bad' : '',
        text: TX(rk.rugs ? (med ? 'author.rank.hitsRugsMed' : 'author.rank.hitsRugs') : med ? 'author.rank.hitsMed' : 'author.rank.hits', {hits: rk.hits, n: rk.n, rugs: rk.rugs, med})});
    }
    if (h.ring?.text) out.push({k: 'ring', tone: 'bad', text: TR(h.ring.text)});
    if (h.smart?.recent?.length) out.push({k: 'recent', tone: 'good', text: TX('author.recent', {list: handleList(h.smart.recent)})});
    if (h.previous?.length) out.push({k: 'renamed', tone: 'warn', text: TX('author.renamed', {n: h.previous.length, list: h.previous.slice(0, 3).map((x) => `@${x.handle}`).join(', ')})});
    const w = (h.wallets || []).find((x) => x.kind === 'wallet') || (h.wallets || []).find((x) => x.kind === 'name');
    const coin = (h.wallets || []).find((x) => x.kind === 'coin');
    if (coin) out.push({k: 'pushes', tone: 'warn', text: TX(coin.source === 'bio' ? 'author.pushes.bio' : 'author.pushes.posts', {coin: coin.symbol ? `$${coin.symbol}` : mvShort(coin.address)})});
    if (h.positions?.called) {
      const p = h.positions;
      out.push({k: 'pnl', tone: p.soldAfter ? 'bad' : p.held ? 'good' : '', text: p.soldAfter ? TX('author.pnl.sold', {sold: p.soldAfter, called: p.called}) : p.held ? TX('author.pnl.held', {held: p.held, called: p.called}) : TX('author.pnl.never', {called: p.called})});
    } else if (w) out.push({k: 'wallet', tone: '', text: w.kind === 'name' ? TX(w.source === 'bio' ? 'author.wallet.nameBio' : 'author.wallet.namePosts', {name: w.address}) : TX(w.source === 'bio' ? 'author.wallet.addrBio' : 'author.wallet.addrPosts', {addr: mvShort(w.address)})});
    const ca = h.caHistory;
    if (ca?.total >= 2) {
      const bits = [ca.dead && TX('author.cas.dead', {n: ca.dead}), ca.bundled && TX('author.cas.bundled', {n: ca.bundled}), ca.deleted && TX('author.cas.deleted', {n: ca.deleted})].filter(Boolean);
      // bare: the plain "Posted N contracts" line with no list after it (callers must not test the translated text for a colon)
      out.push({k: 'cas', tone: ca.read >= 3 && ca.dead / ca.read >= 0.5 ? 'bad' : '', text: bits.length ? TX('author.cas.withList', {n: ca.total, list: bits.join(', ')}) : TX('author.cas.plain', {n: ca.total}), bare: !bits.length});
    }
    return out;
  };
  const authorFactsHtml = (h, start = 8) => { const f = authorFacts(h); return f.length ? `<div class="mv-facts mv-author">${f.map((x, n) => `<div class="mv-fact ${x.tone}" ${i(start + n)}><i>${MARK[x.tone || '']}</i>${esc(x.text)}</div>`).join('')}</div>` : ''; };
  // the hub (live.fable.market) serves Robinhood and Solana coins: only those can be pushed a verdict
  const hubCoin = (a, chain) => (/^0x[a-fA-F0-9]{40}$/.test(String(a || '')) ? chain === 'robinhood' : /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(a || '')) && (!chain || chain === 'solana'));
  /* ---------------- 0.29.1: an author's record is drawn once per page view ----------------
     Everything about WHO posted (their promotion history, call record, KOL network, rug history, smart followers, "Who posted it") is the same on every post they
     write. It is drawn on the first post of that author on this page; later posts of the same author get what the post itself says and the coin facts (the
     contract card, the chart, the investigation). On a profile page (x.com/<handle> and its tabs) the profile panel carries the record of the profile's own
     account, so none of that account's posts draws it again. Another path or search starts the count again. */
  const OWNERS = new Map(); // lowercase handle -> id of the post that carries the author's record
  let ownersView = '';
  const pageView = () => (window.__fablePath || location.pathname) + (window.__fablePath ? '' : location.search);
  const profileHandleNow = () => { const m = (window.__fablePath || location.pathname).match(PROFILE_PATH); return m && !RESERVED.has(m[1].toLowerCase()) ? m[1].toLowerCase() : null; };
  const handleOfPost = (id, article) => String(TWEETS.get(id)?.author?.handle || article?.querySelector?.('[data-testid="User-Name"] a[href^="/"]')?.getAttribute('href')?.slice(1) || '').toLowerCase();
  // 0.29.2 (the same whole card repeated on every post about one coin): on one page view the first post of a coin draws the whole card and the later
  // posts of the same coin the compact one (header, headline, numbers) with a Full card button that opens the rest in place; a tap on the compact card opens the coin's detail sheet.
  const COINS = new Map(); // lowercase contract address -> id of the post that carries the full card
  const EXPANDED = new Set(); // posts whose compact card the viewer opened (a redrawn post keeps it open)
  const syncView = () => { const view = pageView(); if (view !== ownersView) { ownersView = view; OWNERS.clear(); COINS.clear(); EXPANDED.clear(); } }; // (KEEP: restoreHosts skips an entry of another page view)
  const coinSlot = (addr, id) => {
    if (!addr) return true;
    syncView();
    const cur = COINS.get(addr);
    if (cur === undefined) { COINS.set(addr, String(id)); return true; }
    return cur === String(id);
  };
  const authorSlot = (handle, id) => {
    const h = String(handle || '').toLowerCase();
    if (!h) return true; // 0.29.3: no FC test here (nothing below needs it): a missing callout.js drew the author's record under every post
    syncView();
    // the profile panel carries the profile account's record (when the page has the profile header the panel is built under)
    if (settings.profilePanel && settings.enabled && profileHandleNow() === h && (document.querySelector('[data-fable-profile]') || document.querySelector('[data-testid="UserProfileHeader_Items"], [data-testid="UserDescription"]'))) return false;
    const cur = OWNERS.get(h);
    if (cur === undefined) { OWNERS.set(h, String(id)); return true; }
    return cur === String(id);
  };
  // the verdict a post draws: one about its author is drawn on the author's first post of the page; the others get the post's own reading (background.js finish():
  // postOnly), or a plain Commentary pill when the post names a coin (the host of its coin card), or nothing
  const trackedProof = (h) => !!h && !h.error && Number(h.promo?.promoted_launches) >= 1 && Number(h.promo?.rugged) >= 1;
  const needsProof = (v) => stanceOn() && !!v && v.label === 'Promoted tracked rugs';
  const namesCoin = (tw) => !!tw && ((tw.cashtags || []).length > 0 || (globalThis.FableCapture?.extractAddresses?.(tw.text || '', tw.urls || []) || []).length > 0);
  // a contract in the post's text or in any link of it (any host: the coin-card finder only trusts the known ones); only ever used to take a red off a post, never to put one on
  const linksContract = (tw) => /0x[0-9a-fA-F]{40}/.test(`${tw?.text || ''} ${(tw?.urls || []).join(' ')}`);
  const scopeFor = (article, v) => {
    if (!FC || !v) return v;
    const tw = TWEETS.get(v.id) || domTweet(article, v.id);
    if (v.official || fableOfficialPost(tw)) return v.official ? v : OFFICIAL_PILL(v.id); // $FABLE: the OFFICIAL pill, whatever any source said
    // 0.29.2: a verdict about the poster's OTHER coin is not this post's pill, red or any other tone;
    // the post's own coin read sets the pill, and the other coin has its own posts
    // (the same when the verdict is about the poster's launch of $SYM and X's own data shows the post names another coin: a contract in a link the post's text shows cut off, a cashtag other than $SYM)
    const otherLaunch = !v.otherCoin && !!v.launchSym && !!tw && (namesCoin(tw) || linksContract(tw)) && !(tw.cashtags || []).some((x) => String(x).toUpperCase() === v.launchSym);
    if (v.otherCoin || otherLaunch) return otherLaunch || namesCoin(tw) ? {id: v.id, source: v.source, tone: 'neutral', label: 'Commentary', stat: 'no calls', confidence: 0.5} : {id: v.id, source: v.source, hidden: true};
    // 0.29.2: "Promoted tracked rugs" is about the ACCOUNT (it promoted coins of tracked rug operations). The API builds it from every post that names such a coin, a warning included
    // (it turned accounts that expose rugs red). It is shown only when the account's judged promotion record (history.promo: stance promotes only) has a promoted
    // launch that rugged. While the history is on its way: the coin facts and the wordless chip.
    if (needsProof(v)) {
      const hd = handleOfPost(v.id, article), hh = hd ? HISTS.get(hd) : null;
      if (!hh && hd) { intelGet(`h:${handleOfPost(v.id, article)}`, {type: 'history', handle: handleOfPost(v.id, article)}); return namesCoin(tw) ? {id: v.id, source: v.source, tone: 'neutral', label: '', stat: '', pending: true} : {id: v.id, source: v.source, hidden: true}; }
      if (!trackedProof(hh)) { const p = v.postOnly; return p && !p.hidden && !FC.authorLevel(p) && !FC.gated(p) ? {...p, id: v.id} : namesCoin(tw) ? {id: v.id, source: v.source, tone: 'neutral', label: 'Commentary', stat: 'no calls', confidence: 0.5} : {id: v.id, source: v.source, hidden: true}; }
    }
    // 0.29.2: a promotion label on a post that names a coin is a promotion only once /v1/stance says the post promotes (see the block below); an ad is proven by its own link
    if (stanceOn() && FC.gated(v) && namesCoin(tw) && !adIn(article, tw) && !refLinkIn(tw)) {
      if (!STANCE.has(String(v.id))) askStance(v.id, tw);
      const st = stanceNow(v.id) ?? 'pending';
      const hs = FC.historyStance(HISTS.get(handleOfPost(v.id, article)), v.id);
      const r = FC.settle(tw, v, st, {stance: hs === 'warning' ? 'warning' : null}, {names: true});
      if (r.kind === 'callout') return r.v;
      if (r.kind === 'pending' || r.kind === 'chip') return {id: v.id, source: v.source, tone: 'neutral', label: '', stat: '', pending: true};
      if (r.kind === 'strip') { const p = v.postOnly; return p && !p.hidden && !FC.authorLevel(p) && !FC.gated(p) ? {...p, id: v.id} : {id: v.id, source: v.source, tone: 'neutral', label: 'Commentary', stat: 'no calls', confidence: 0.5}; }
      // keep (judged "promotes"): the author's record is placed below; guard: not gated, the 0.29.1 rules below
    }
    // a promotion label on a post that turns out to warn (the server's stance for the post is in the account's history by now, or the post's own words say so): a Call-out instead
    if (!v.callout && FC.promoLike(v) && !(stanceOn() && FC.gated(v) && stanceNow(v.id) === 'promotes') && isCalloutPost(tw, v, HISTS.get(handleOfPost(v.id, article)))) return FC.calloutVerdict(tw, v);
    if (v.callout || !FC.authorLevel(v)) return v;
    if (authorSlot(handleOfPost(v.id, article), v.id)) return v;
    const p = v.postOnly;
    // the post's own reading goes through the same gate (its words may read as a shill: that needs the judged stance too)
    if (p) return p.hidden || FC.authorLevel(p) ? {id: v.id, source: v.source, hidden: true} : scopeFor(article, {...p, id: v.id});
    return namesCoin(tw) ? {id: v.id, source: v.source, tone: 'neutral', label: 'Commentary', stat: 'no calls', confidence: 0.5} : {id: v.id, source: v.source, hidden: true};
  };
  /* ---------------- 0.29.2: a promotion label only once the post is judged to promote ----------------
     intel /v1/stance says what the investigation (posts it knows) or Jev (new posts that name a coin) judged a post to be. A verdict with a promotion label on such a
     post is drawn without it: the coin facts and a wordless chip first, the label only when the answer is "promotes". "warns" is a Call-out; neutral / unrelated take
     the label off; no answer (none, an error, a timeout, a spent budget, intel down, 4 asks over 15 s) leaves the chip wordless, never the label; on.stanceGate false is the 0.29.1 rules.
     A failed ask is tried again later (the chip gets its label if intel comes back). */
  const STANCE = new Map(); // tweet id -> 'promotes' | 'warns' | 'neutral' | 'unrelated' | 'none' | 'pending' | 'unknown' | 'down'
  const STANCE_TRIES = new Map();
  const STANCE_LATER = new Map(); // tweet id -> how many times a failed ask was tried again
  const CALLER_HOOKS = new Map(); // tweet id -> what to add when the post turns out to promote (the caller pills)
  let stanceQ = new Set(), stanceTimer = null, stanceFails = 0, stanceDownUntil = 0;
  const stanceOn = () => !!FC && on('stanceGate');
  const stanceNow = (id) => (Date.now() < stanceDownUntil && STANCE.get(String(id)) !== 'promotes' && STANCE.get(String(id)) !== 'warns' ? 'down' : STANCE.get(String(id)));
  // an ask that failed (intel down, 'none', a spent budget) is tried again later, so the chip gets its label when intel is back
  const askAgain = (id, afterMs, max) => { const n = (STANCE_LATER.get(id) || 0) + 1; STANCE_LATER.set(id, n); if (n > max) return; setTimeout(() => { if (STANCE.get(id) === 'promotes' || STANCE.get(id) === 'warns') return; STANCE.delete(id); askStance(id); }, afterMs); };
  const STANCE_ITEMS = new Map(); // tweet id -> {id, text, symbol?, address?}: what intel is asked (the text on screen, so a post it has not captured yet can be judged)
  const askStance = (id, tw = null) => {
    id = String(id);
    const cur = STANCE.get(id);
    if (cur && cur !== 'pending') return;
    if (!STANCE_ITEMS.has(id)) { const t = tw || TWEETS.get(id); const ca = (globalThis.FableCapture?.extractAddresses?.(t?.text || '', t?.urls || []) || [])[0]; STANCE_ITEMS.set(id, {id, text: String(t?.text || ''), ...((t?.cashtags || [])[0] ? {symbol: String((t.cashtags)[0]).replace(/^\$/, '')} : {}), ...(ca?.address ? {address: ca.address} : {})}); }
    if (!cur) STANCE.set(id, 'pending');
    stanceQ.add(id);
    if (!stanceTimer) stanceTimer = setTimeout(flushStance, CFG.timing?.stanceBatchMs ?? 120);
  };
  const flushStance = () => {
    stanceTimer = null;
    const ids = [...stanceQ].slice(0, 40);
    ids.forEach((id) => stanceQ.delete(id));
    if (stanceQ.size) stanceTimer = setTimeout(flushStance, 0);
    if (!ids.length) return;
    // intel was just found unreachable: no request until the pause is over, the chips wait
    if (Date.now() < stanceDownUntil) { for (const id of ids) { STANCE.set(id, 'down'); askAgain(id, 35e3, 4); } return; }
    const retry = CFG.timing?.stanceRetryMs ?? [1500, 4000, 9000];
    chrome.runtime.sendMessage({type: 'stance', items: ids.map((id) => STANCE_ITEMS.get(id) || {id, text: ''})}).catch(() => null).then((res) => {
      const bad = !res || typeof res !== 'object';
      for (const id of ids) {
        const st = bad ? 'down' : String(res[id] ?? 'pending');
        if (st === 'down') { stanceFails++; if (stanceFails >= 2) stanceDownUntil = Date.now() + 30e3; STANCE.set(id, 'down'); askAgain(id, 35e3, 4); onStance(id); continue; }
        if (st === 'none') { stanceFails = 0; STANCE.set(id, 'none'); askAgain(id, 300e3, 1); onStance(id); continue; }
        if (st === 'pending') {
          const n = (STANCE_TRIES.get(id) || 0) + 1;
          STANCE_TRIES.set(id, n);
          if (n > retry.length) { STANCE.set(id, 'unknown'); askAgain(id, 120e3, 1); onStance(id); } else setTimeout(() => { stanceQ.add(id); if (!stanceTimer) stanceTimer = setTimeout(flushStance, 0); }, retry[n - 1]);
          continue;
        }
        stanceFails = 0;
        STANCE.set(id, st);
        onStance(id);
      }
    });
  };
  // the answer arrived: the pill, the stamp, the dimming and the card are brought to what the answer says, in place (the coin card and its chart are not touched)
  const reapply = (article, raw) => {
    if (!article.querySelector('[data-fable-host]')) { article.removeAttribute('data-fable-done'); render(article, raw); return; }
    paintVerdict(article, scopeFor(article, raw));
  };
  const onStance = (id) => {
    const article = document.querySelector(`article[data-fable-id="${id}"]`), raw = VERDICTS.get(id);
    if (!article || !raw) return;
    if (STANCE.get(id) === 'promotes') CALLER_HOOKS.get(id)?.();
    if (!FC.gated(raw)) return;
    reapply(article, raw);
  };
  // an account's history arrived: its posts whose label needs the account's judged record are brought to what the record says
  const onHist = (handle) => {
    for (const article of document.querySelectorAll('article[data-fable-id]')) {
      const id = article.getAttribute('data-fable-id'), raw = VERDICTS.get(id);
      if (raw && needsProof(raw) && handleOfPost(id, article) === handle) reapply(article, raw);
    }
  };
  const paintVerdict = (article, v) => {
    const ui = article.querySelector('[data-fable-host="ui"]');
    if (!ui) return;
    if (!v.pending && !v.hidden) remember(article, v);
    if (v.hidden) { ui.remove(); article.querySelectorAll('[data-fable-host="stamp"]:not([data-by="chain"])').forEach((n) => n.remove()); article.removeAttribute('data-fable-fade'); return; }
    const ctx = ui.shadowRoot?.querySelector('.ctx');
    // a pill the post's own coin read set (ctx.dataset.chain), or the account's record
    // (author, rank), or an ad, is not overwritten by a late API verdict; only a scam read off the post's own text ("Fake giveaway", "Seed phrase ask" ...) is harder than those
    const textScam = v.tone === 'rug' && !v.otherCoin && /^(Scam|Impersonator|Phishing link|Fake giveaway|Seed phrase ask|Fake support|Recovery scam|Fake claim|Drainer link|Scam pattern)$/.test(v.label || '') && !/bundled/i.test(v.stat || '');
    if (ctx && (!(ctx.dataset.chain || ctx.dataset.rank || ctx.dataset.ad || (ctx.dataset.author && v.tone === 'neutral')) || textScam) && ctx.dataset.vkey !== `${v.label}|${v.tone}|${v.detail || ''}|${v.pending ? 1 : 0}`) {
      const tpl = document.createElement('template');
      tpl.innerHTML = ctxHTML(v).trim();
      const next = tpl.content.firstElementChild;
      if (next) { next.classList.add('pill-new'); ctx.replaceWith(next); hideBroken(ui.shadowRoot); }
    }
    article.setAttribute('data-fable-done', v.id);
    if (!v.stamp) article.querySelectorAll('[data-fable-host="stamp"]:not([data-by="chain"])').forEach((n) => n.remove());
    if (v.fade && settings.fade && !article.querySelector('[data-fable-host="stamp"]')) article.setAttribute('data-fable-fade', '1');
    if (!v.fade && !article.querySelector('[data-fable-host="stamp"]')) { article.removeAttribute('data-fable-fade'); delete article.dataset.fableWantsFade; }
    if (v.stamp && settings.stamps && on('stamps') && !article.querySelector('[data-fable-host="stamp"]')) stampFromVerdict(article, v, theme(), PLAYED.has(v.id));
    // 0.30.0 (ext030-scroll: a kept pill came back and got its verdict's card painted in again, +241 to 291 px under the reader): the host now shows this verdict
    { const k = KEEP.get(String(v.id)); if (k && k.ui === ui && !v.pending) k.v = v; }
    // the card a promotion verdict draws (its own record), when the verdict arrived without it
    if (settings.cards && important(v) && v.card && !ui.shadowRoot?.querySelector('.expand')) { ui.shadowRoot?.querySelector('.fold > div')?.insertAdjacentHTML('beforeend', cardHTML(v.card)); hideBroken(ui.shadowRoot); }
    else if (!(settings.cards && important(v))) ui.shadowRoot?.querySelector('.expand')?.remove();
  };
  // does this post warn about a coin or call something out: its own words, the verdict, or the server's judged stance of the post (history notCalls)
  const isCalloutPost = (tw, v, hist) => !!(FC && !(stanceOn() && stanceNow(v?.id) === 'promotes') && (stanceOn() && stanceNow(v?.id) === 'warns' || v?.callout || v?.label === 'Call-out' || (tw && FC.isCallout(tw.text).hit) || (hist && FC.historyStance(hist, v?.id) === 'warning')));
  // a post already drawn with a promotion label that turns out to be a call-out (the server's stance arrived after the pill): the pill, the stamp and the dimming are redone in place
  const calloutInPlace = (article, v, tw) => {
    const cur = VERDICTS.get(v.id) || v; // the verdict as it is now (the API's may have replaced the one this card was mounted with)
    if (!FC || !FC.promoLike(cur)) return;
    const nv = FC.calloutVerdict(tw || {id: v.id}, cur);
    VERDICTS.set(v.id, nv);
    const ui = article.querySelector('[data-fable-host="ui"]');
    const ctx = ui?.shadowRoot?.querySelector('.ctx');
    if (ctx?.dataset.callout) return; // the pill on screen already is the call-out (scopeFor drew it)
    if (ctx && !ctx.dataset.chain && !ctx.dataset.ad) {
      const tpl = document.createElement('template');
      tpl.innerHTML = ctxHTML(nv).trim();
      const next = tpl.content.firstElementChild;
      if (next) { next.classList.add('pill-new'); ctx.replaceWith(next); hideBroken(ui.shadowRoot); }
    }
    ui?.shadowRoot?.querySelector('.expand')?.remove(); // the card the old verdict drew (its own record), the contract card stays
    article.querySelectorAll('[data-fable-host="stamp"]:not([data-by="chain"])').forEach((n) => n.remove());
    article.removeAttribute('data-fable-fade');
    delete article.dataset.fableWantsFade;
  };
  // pill from the author's server record: the video's "Smart followers [faces] 8" when the post had nothing louder
  const pillFromAuthor = (article, v, h) => {
    const ctx = article.querySelector('[data-fable-host="ui"]')?.shadowRoot?.querySelector('.ctx');
    const sm = h?.smart?.n || 0;
    if (!ctx || sm < 3 || !['neutral', 'legit'].includes(v.tone) || ctx.dataset.chain) return;
    const faces = (h.smart.people || []).filter((p) => p && (p.avatar || p.handle)).slice(0, 3);
    const lbl = v.tone === 'legit' ? esc(TR(v.label)) : TT('srv.author.smartFollowers');
    ctx.classList.remove('neutral', 'kol', 'rug');
    ctx.classList.add('legit', 'pill-new');
    ctx.dataset.author = 'pill';
    ctx.innerHTML = `${fox()}<span class="verdict">${lbl}</span><span class="mid">·</span>${faces.length ? `<span class="pile">${faces.map((a) => face(a)).join('')}</span>` : ''}<span class="detail">${v.tone === 'legit' && v.label !== 'Smart followers' ? TT('author.smartFollowersN', {n: sm}) : sm}</span>`;
    hideBroken(ctx.getRootNode());
  };
  const mountIntel = async (article, after, v, t, played) => {
    const tw = TWEETS.get(v.id);
    const handle = tw?.author?.handle || article.querySelector('[data-testid="User-Name"] a[href^="/"]')?.getAttribute('href')?.slice(1);
    // every contract address in the post (up to 3): the first gets the full card, the rest a line each
    const fableTok = fableOfficialPost(tw); // $FABLE: no coin card
    const cas = fableTok ? [] : (globalThis.FableCapture?.extractAddresses?.(tw?.text || '', tw?.urls || []) || []).slice(0, CFG.limits?.contractsPerPost ?? 3);
    // no contract in the post: its first non-major $TICKER, matched server-side to the contract Fable has seen most
    const tick = !cas.length && !fableTok ? (tw?.cashtags || []).map((x) => String(x).toUpperCase()).find((x) => !MAJORS.has(x)) : null;
    if (!handle && !cas.length && !tick) return;
    if (/^fabledotmarket$/i.test(handle || '')) return; // our own account never gets a card (verdict.js FABLE_SELF)
    const list = cas.length ? cas : tick ? [{ticker: tick, chain: globalThis.FableCapture?.chainHintFromText?.(tw?.text || '') || null}] : [];
    const cmsg = (ca, fresh) => ({...(ca.ticker ? {type: 'contract', symbol: ca.ticker} : {type: 'contract', address: ca.address}), chain: ca.chain, fresh, tweet: v.id});
    const ckey = (ca) => (ca.ticker ? `t:${ca.ticker}:${ca.chain || ''}` : `c:${ca.chain}:${ca.address}`);
    const getC = (ca, fresh) => (fresh ? chrome.runtime.sendMessage(cmsg(ca, true)).catch(() => null) : intelGet(ckey(ca), cmsg(ca, false)));
    const ca = list[0] || null;
    const firstCandles = ca?.address ? candlesFor(ca.address, ca.chain) : null;
    const ad = adIn(article, tw); // an invite link of a trading tool or X's Paid partnership label on the post (the Proxima ad): promotion, never a positive read
    const hP = handle ? intelGet(`h:${handle.toLowerCase()}`, {type: 'history', handle}) : Promise.resolve(null);
    // 0.30.0 (cold cards over 1 s): the history's grace period runs from now, alongside the coin's read, not after it: a coin read that took 0.6 s
    // no longer waits another 0.3 s for a history that is still cold; a fast coin read still gives the history its 0.3 s
    const hRace = Promise.race([hP, new Promise((r) => setTimeout(() => r(undefined), CFG.timing?.historyWaitMs ?? 300))]);
    let [c, ...rest] = await Promise.all([ca ? getC(ca, false) : null, ...list.slice(1).map((x) => getC(x, false))]);
    // 0.30.0 (ext030-speed: 2 of 8 identical ticker reads answered "no contract for this ticker" in 77 ms, a lookup that failed on the server, and the card never drew):
    // a ticker with no answer (not an ambiguous one) is asked once more, fresh, 0.5 s later
    if (ca?.ticker && c?.error && !c.ambiguous && /no contract/i.test(String(c.error))) { await new Promise((r) => setTimeout(r, 500)); const again = await getC(ca, true); if (again && !again.error) { c = again; INTEL.set(ckey(ca), Promise.resolve(again)); } }
    // a coin card does not wait on the poster's history (up to 5 s cold): the card draws without it and "Who posted it" slides in when it lands
    const coinOk = !!(c && !c.error);
    let h = coinOk ? await hRace : await hP;
    const lateHist = h === undefined;
    if (lateHist) h = null;
    if (!after.isConnected || article.getAttribute('data-fable-done') !== v.id || article.querySelector('[data-fable-host="intel"]')) return;
    let hist = h && !h.error && h.days ? h : null;
    // 0.29.1: a post that warns about a coin or calls something out (its own words, the verdict, the server's judged stance in this account's history) draws no promotion
    // label, caller pill or call history; and the author's record (history cards, "Who posted it", pills from it) is drawn on the author's first post of the page only
    let calloutPost = isCalloutPost(tw, v, h && !h.error ? h : null);
    if (calloutPost) calloutInPlace(article, v, tw);
    if (hist && (calloutPost || !authorSlot(handle, v.id))) hist = null;
    // 0.29.3 (owner: the "Builder history" grid under every post of a profile): belt and braces on top of authorSlot, the page itself is asked too: a record already drawn for this author
    // on another post of the page (the host carries data-fable-author) is never drawn again, whatever the bookkeeping says
    if (hist && handle && [...document.querySelectorAll('[data-fable-host="intel"][data-fable-author]')].some((n) => n.getAttribute('data-fable-author') === String(handle).toLowerCase() && !article.contains(n))) hist = null;
    // lead with the coin: when the first address is a plain contract (a pool, a curve, a router) and another is a token
    const notToken = (x) => x && !x.error && (x.onchain?.isToken === false || (x.facts || []).some((f) => f.k === 'nottoken'));
    const lead = (first, more) => { if (notToken(first)) { const k = more.findIndex((x) => x && !x.error && !notToken(x) && x.identity?.symbols?.length); if (k >= 0) { const m = [...more]; [first, m[k]] = [m[k], first]; return [first, m, true]; } } return [first, more, false]; };
    let swapped;
    [c, rest, swapped] = lead(c, rest);
    if (c && !c.error && ownToken(c.identity?.address)) c = calmContract(c);
    rest = rest.map((x) => (x && !x.error && ownToken(x.identity?.address) ? calmContract(x) : x));
    let others = rest.filter((x) => x && !x.error);
    const smartRow = calloutPost ? null : (v.card?.rows || []).find((r) => r && r.kind === 'smart' && (r.people?.length || r.all?.length));
    const sm = hist?.smart?.n || 0;
    let html = '', keys = [];
    // the full card for the first post of a coin on this page view, the compact one for the later ones
    let compact = !!(c && !c.error && kindOn('contract') && c.identity?.address && on('cardCompact') && !EXPANDED.has(String(v.id)) && !coinSlot(String(c.identity.address).toLowerCase(), v.id));
    if (c && !c.error && kindOn('contract')) ({html, keys} = contractCard(c, new Set(), hist, others, calloutPost ? handle : null, compact));
    else if (!fableTok && hist?.promosTotal >= 2 && kindOn('promo')) html = promoCard(hist, refLinkIn(tw));
    // builder card when the grid can be as full as the video's: a proven GitHub, or real build history on X
    else if (!ad && kindOn('builder') && hist && (hist.github?.weeks?.length || ((hist.counts?.building || hist.builds?.length || hist.ships?.length) && (hist.coverage?.observedDays || 0) >= 15))) html = builderCard(hist);
    else if (!ad && kindOn('smart') && sm >= 2) html = smartCard(hist.smart, hist.ships);
    else if (!ad && kindOn('smart') && smartRow) html = smartCard(smartRow);
    else if (!fableTok && kindOn('activity') && (hist?.coverage?.observedDays >= 3 || hist?.promosTotal)) html = activityCard(hist);
    if (hist && !ad) pillFromAuthor(article, v, hist);
    else if (ad && (v.tone === 'neutral' || v.tone === 'legit')) {
      const ctx = article.querySelector('[data-fable-host="ui"]')?.shadowRoot?.querySelector('.ctx');
      if (ctx && !ctx.dataset.chain) {
        ctx.classList.remove('neutral', 'legit', 'kol', 'rug'); ctx.classList.add('kol', 'pill-new'); ctx.dataset.ad = '1';
        ctx.innerHTML = `${fox()}<span class="verdict">${TT('srv.intel.label.promoPost')}</span><span class="mid">·</span><span class="detail">${adLinkIn(tw) ? TT('srv.intel.detail.inviteLink') : TT('srv.intel.detail.paidPartnership')}</span>`;
      }
    }
    // 0.29.2: a caller pill ("Caller", "Bad caller", the rank tier) says this post is a call: only for a post judged to promote (or when the judgment cannot be had)
    const callerNow = () => {
      if (!stanceOn()) return true;
      if (!STANCE.has(String(v.id))) askStance(v.id, tw);
      return stanceNow(v.id) === 'promotes';
    };
    // a ranked caller on a post with nothing louder: the tier and its numbers on the pill
    const rankPill = () => {
      if (!(hist?.rank?.tier && /caller/.test(hist.rank.tier)) || !callerNow()) return;
      {
      const ctx = article.querySelector('[data-fable-host="ui"]')?.shadowRoot?.querySelector('.ctx');
      if (ctx && !ctx.dataset.chain && ctx.classList.contains('neutral') && (v.tone === 'neutral' || /^no flags$/i.test(v.label || ''))) {
        const r = hist.rank, tone = rankTone(r.tier) === 'bad' ? 'rug' : 'legit';
        ctx.classList.remove('neutral', 'legit', 'kol', 'rug'); ctx.classList.add(tone, 'pill-new'); ctx.dataset.rank = '1'; ctx.dataset.author = 'pill';
        ctx.innerHTML = `${fox()}<span class="verdict">${esc(TR(r.tier))}</span><span class="mid">·</span><span class="detail">${tone === 'rug' ? TT('author.pill.rugs', {rugs: r.rugs, n: r.n}) : TT('author.pill.hits', {hits: r.hits, n: r.n})}</span>`;
      }
    }
    };
    rankPill();
    const pillFromCard = (kind) => {
      if (kind === 'promo' && !callerNow()) return;
      const ctx = article.querySelector('[data-fable-host="ui"]')?.shadowRoot?.querySelector('.ctx');
      if (!ctx || ctx.dataset.chain || ctx.dataset.rank || ctx.dataset.ad || !ctx.classList.contains('neutral') || !(v.tone === 'neutral' || /^no flags$/i.test(v.label || ''))) return;
      const measured = (hist?.promos || []).filter((p) => p.sinceCall != null), deep = measured.filter((p) => p.sinceCall <= -0.9).length;
      const pl = kind === 'promo' ? (measured.length >= 3 && deep / measured.length >= 0.5 ? {label: TX('author.pill.badCaller'), stat: TX('author.pill.downDeep', {deep, total: measured.length}), tone: 'rug'} : {label: TX('author.pill.caller'), stat: TX('author.pill.coins30', {n: hist.promosTotal}), tone: 'kol'})
        : kind === 'builder' ? {label: TX('srv.author.builder'), stat: hist.github?.total ? TX('author.pill.commits', {n: hist.github.total}) : hist.ships?.[0] || TX('author.pill.shipped', {n: hist.builds?.length || hist.counts?.building || 0}), tone: 'legit'}
        : kind === 'activity' ? {label: TX('author.pill.trackRecord'), stat: TX('author.pill.activeDays', {n: hist.coverage?.observedDays || 0}), tone: (hist.record?.bad || 0) > (hist.record?.good || 0) ? 'kol' : 'neutral'} : null;
      if (!pl) return;
      ctx.classList.remove('neutral', 'legit', 'kol', 'rug');
      ctx.classList.add(pl.tone, 'pill-new');
      ctx.dataset.author = 'pill';
      ctx.innerHTML = `${fox()}<span class="verdict">${esc(pl.label)}</span><span class="mid">·</span><span class="detail">${esc(pl.stat)}</span>`;
    };
    // the why line: the hardest fact we hold for this post
    const whyFrom = (cc) => {
      const r = cc?.risk?.reasons?.find((x) => x.w === 'severe') || cc?.risk?.reasons?.find((x) => x.w === 'high');
      if (r) return [TR(r.text), 'bad'];
      const d = cc?.devHistory;
      if (d?.launched >= 3) return [d.rugged ? TX('why.creatorRugged', {launched: d.launched, rugged: d.rugged}) : d.graduated != null ? TX('why.creatorGraduated', {launched: d.launched, graduated: d.graduated}) : TX('why.creator', {launched: d.launched}), d.rugged ? 'bad' : ''];
      const f = (cc?.facts || []).find((x) => x.tone === 'bad') || (cc?.facts || []).find((x) => x.k === 'calls') || (cc?.facts || []).find((x) => x.tone === 'good');
      if (f) return [FX(f), f.tone];
      const a = authorFacts(hist)[0];
      return a ? [a.text, a.tone] : [null];
    };
    if (!html) { const a = authorFacts(hist)[0]; if (a) setWhy(article, a.text, a.tone); return; }
    article.querySelector('[data-fable-host="ui"]')?.shadowRoot?.querySelector('.why')?.remove();
    const host = document.createElement('div');
    host.setAttribute('data-fable-host', 'intel');
    if (hist && handle) host.setAttribute('data-fable-author', String(handle).toLowerCase()); // 0.29.3: this post carries the author's record (see the page check above)
    host.style.contain = 'layout paint';
    after.insertAdjacentElement('afterend', host);
    const root = mountShadow(host, html, t, played);
    { const k = KEEP.get(String(v.id)); if (k && k.ui === after) k.intel = host; }
    const cardKind = root.querySelector('.mv-card')?.dataset.mv;
    pillFromCard(cardKind);
    CALLER_HOOKS.set(v.id, () => { rankPill(); pillFromCard(cardKind); if (c && !c.error) pillFromChain(c); }); // the judged stance arrives later: a post that turns out to promote may get its caller pill then
    // one card per post: the older Backstory card's rows move inside this card as "About @handle", the old card goes
    const legacy = after.shadowRoot?.querySelector('.expand');
    const rowsHtml = legacy?.querySelector('.sigs')?.innerHTML;
    if (legacy && rowsHtml) {
      const about = document.createElement('div');
      about.className = 'mv-about';
      const tmp = document.createElement('div');
      tmp.innerHTML = rowsHtml;
      const chips = [...tmp.querySelectorAll('.sig')].slice(0, 3).map((el) => {
        const tone = el.classList.contains('bad') ? 'r' : el.classList.contains('good') ? 'g' : el.classList.contains('warn') ? 'a' : 'n';
        const title = el.querySelector('.txt b')?.textContent || '';
        return title ? `<span class="mv-chip sm ${tone}">${esc(title)}</span>` : '';
      }).join('');
      about.innerHTML = chips ? `<div class="mv-chips">${chips}</div>` : '';
      const body = root.querySelector('.mv-body');
      const foot = body?.querySelector(':scope > .mv-foot:last-child');
      if (body) (foot ? body.insertBefore(about, foot) : body.appendChild(about));
      legacy.remove();
    }
    // a coin Fable guessed from a ticker (the post names no contract and the server says other coins use the ticker too) is not the post's coin:
    // its risk never becomes the post's pill or stamp (a ticker guess can land on another chain's coin of the same name)
    const guessed = (cc) => !!cc?.matchedBy?.ticker && (cc.matchedBy.alternatives?.length || 0) > 0;
    const pillFromChain = (cc) => {
      if (guessed(cc)) return;
      const ctx = article.querySelector('[data-fable-host="ui"]')?.shadowRoot?.querySelector('.ctx');
      // the loudest hard fact wins the pill: a proven severe risk, then a rugging / serial deployer, then the risk level
      const rk = cc.risk || {};
      let pl = rk.level === 'high' ? rk.pill : rk.devPill && (rk.devPill.tone === 'rug' || rk.level !== 'high') ? rk.devPill : rk.pill;
      // the pill's words: the server's English (label, stat) goes through TR, the ones built here are already in the active language
      let plLabel = pl ? FX({text: pl.label, key: pl.key, params: pl.params}) : '', plStat = pl?.stat ? FX({text: pl.stat, key: pl.statKey, params: pl.statParams}) : null;
      const wave = cc.connections?.shillWave;
      if (wave?.level === 'high' && !rk.alert && !calloutPost && callerNow() && (!pl || pl.tone !== 'rug')) { pl = {tone: 'rug'}; plLabel = TX('intel.pill.shillWave'); plStat = TX('intel.pill.shillWaveStat', {accounts: wave.accounts, min: wave.windowMin}); }
      if (pl && !plStat) {
        const sf = cc.history?.calls?.sinceFirst, mc = cc.market?.mcap?.value;
        plStat = sf && Math.abs(sf.change) >= 0.05 ? (sf.change >= 1 ? TX('intel.pill.multSince', {x: (sf.change + 1).toFixed(1)}) : TX(sf.change > 0 ? 'intel.pill.upSince' : 'intel.pill.downSince', {pct: Math.round(Math.abs(sf.change) * 100)})) : mc ? TX('intel.pill.mcap', {usd: mvUsd(mc)}) : null;
      }
      if (ctx && pl && (v.tone === 'neutral' || v.tone !== 'rug' || rk.level === 'high' || v.otherCoin)) {
        ctx.classList.remove('neutral', 'legit', 'kol', 'rug');
        ctx.classList.add(pl.tone);
        ctx.dataset.chain = '1';
        ctx.innerHTML = `${fox()}<span class="verdict">${esc(plLabel)}</span>${plStat ? `<span class="mid">·</span><span class="detail">${esc(plStat)}</span>` : ''}`;
        ctx.classList.add('pill-new');
        return;
      }
      const det = ctx?.querySelector('.detail');
      // the logic reads the English: the drawn detail is translated, so outside English the verdict's own English detail stands in while the pill is still the one the verdict drew
      const noRead = /no on-chain read|not read yet|on-chain read yet/i;
      if (!det || !(noRead.test(det.textContent || '') || (LANG() !== 'en' && !ctx.classList.contains('pill-new') && noRead.test(v.detail || '')))) return;
      const f = (cc.facts || []).find((x) => x.tone === 'bad') || (cc.facts || []).find((x) => x.tone === 'warn') || (cc.facts || []).find((x) => x.k === 'mcap' || x.k === 'trades');
      const mc = cc.market?.mcap?.value;
      det.textContent = f ? FX(f) : mc ? TX('intel.pill.marketCap', {usd: mvUsd(mc)}) : TX('intel.pill.readOnchain');
    };
    if (c && !c.error) pillFromChain(c);
    const tweetTime = tw?.created_at ? Date.parse(tw.created_at) : null;
    let chartCtl = c && !c.error && !compact ? chartFor(root, c, tweetTime, c.identity?.address && String(c.identity.address).toLowerCase() === String(ca?.address || '').toLowerCase() ? firstCandles : null) : null;
    const stampFor = (cc) => {
      if (guessed(cc)) return;
      if (!settings.stamps || !on('stamps') || article.querySelector('[data-fable-host="stamp"]')) return;
      // the stamp names what the alert is about (it used to say BUNDLED for any red alert, a mint left on included)
      const S = CFG.copy?.stamps || {};
      const sk = cc?.risk?.reasons?.find((x) => x.w === 'severe')?.key;
      // the word comes from the config copy (English, translated here) or, when the config has none, from the bundled stamp words
      const word = (fromCfg, key) => (fromCfg && !Object.values(globalThis.FableConfig?.DEFAULT?.copy?.stamps || {}).includes(fromCfg) ? TR(fromCfg) : TX(key));
      if (cc?.risk?.alert) stampPost(article, sk === 'op' ? word(S.rugOperation, 'stamp.rug') : sk === 'honeypot' ? word(S.honeypot, 'stamp.honeypot') : sk === 'bundle' ? word(S.bundled, 'stamp.bundled') : word(S[sk] || S.highRisk, 'stamp.highRisk'), t, played);
      else if (cc?.risk?.devPill?.label === 'Rug history') stampPost(article, word(S.rugHistory, 'stamp.rug'), t, played);
    };
    if (c && !c.error) stampFor(c);
    // the poster's history arrived after the coin card was drawn: add its section in place (no redraw, no chart replay)
    if (lateHist) hP.then((h2) => {
      const hh0 = h2 && !h2.error && h2.days ? h2 : null;
      if (!host.isConnected) return;
      if (!calloutPost && isCalloutPost(tw, v, h2 && !h2.error ? h2 : null)) { calloutPost = true; calloutInPlace(article, v, tw); }
      const hh = hh0 && !calloutPost && authorSlot(handle, v.id) && !(handle && [...document.querySelectorAll('[data-fable-host="intel"][data-fable-author]')].some((n) => n.getAttribute('data-fable-author') === String(handle).toLowerCase() && n !== host)) ? hh0 : null;
      if (!hh) return;
      hist = hh;
      if (handle) host.setAttribute('data-fable-author', String(handle).toLowerCase());
      if (!ad) pillFromAuthor(article, v, hh);
      const body = root.querySelector('.mv-body');
      const sec = compact ? '' : trackSection(hh);
      if (!sec || !body || body.querySelector('.mv-track-late')) return;
      const tpl = document.createElement('template');
      tpl.innerHTML = sec.replace('class="mv-sec"', 'class="mv-sec mv-track-late"');
      const foot = body.querySelector(':scope > .mv-foot:last-child');
      if (foot) body.insertBefore(tpl.content, foot); else body.appendChild(tpl.content);
    }).catch(() => {});
    root.addEventListener('click', (e) => {
      if (e.target.closest('a[href]')) return e.stopPropagation(); // receipts open themselves, the post underneath does not
      if (e.target.closest('[data-more]')) { e.preventDefault(); e.stopPropagation(); expandCard(); return; } // the Full card button: the rest of the card opens in place
      const card = e.target.closest('.mv-card');
      if (!card) return;
      e.preventDefault();
      e.stopPropagation();
      if (card.dataset.mv === 'contract') openContract(c, c.identity?.symbols?.length === 1 ? `$${c.identity.symbols[0].symbol}` : TX('intel.contract'));
      else openSheet(v, 'history', t);
    });
    // one redraw in place (no X refresh, no chart replay) for both the chain read finishing and the hub's verdict push
    let seen = new Set(keys);
    const redraw = (next, moreOk) => {
      c = next;
      others = moreOk;
      if (!swapped) INTEL.set(ckey(ca), Promise.resolve(next));
      const out = contractCard(next, seen, hist, moreOk, calloutPost ? handle : null, compact);
      const old = root.querySelector('.mv-card');
      let remount = true;
      if (old) {
        const neu = document.importNode(new DOMParser().parseFromString(`<div>${out.html}</div>`, 'text/html').querySelector('.mv-card'), true);
        // the live chart keeps its node (candles, trades, timeframe, crosshair) when the redrawn card still has one: no flash, no reset
        const keep = old.querySelector('.mv-fc'), slot = neu.querySelector('.mv-fc');
        if (keep && slot && keep.querySelector('canvas')) { slot.replaceWith(keep); remount = false; }
        old.replaceWith(neu);
        hideBroken(root);
      }
      seen = new Set([...seen, ...out.keys]);
      pillFromChain(next);
      // a verdict that came down: the stamp the chain read put on the post goes with it
      if (!next.risk?.alert && next.risk?.devPill?.label !== 'Rug history') article.querySelectorAll('[data-fable-host="stamp"][data-by="chain"]').forEach((n) => n.remove());
      stampFor(next);
      if (remount) chartCtl?.remount();
    };
    // the Full card button: the same card, every section, its chart (the coin's own whole card), in place
    const expandCard = () => {
      if (!compact) return;
      compact = false;
      EXPANDED.add(String(v.id));
      redraw(c, others);
      chartCtl = c && !c.error ? chartFor(root, c, tweetTime, null) : null;
    };
    // 0.28 live verdicts (on.verdictPush): the hub says this coin's verdict or facts changed. The card reads the coin fresh and
    // redraws only what differs, in place. A watch is a port that wants verdict messages only; it is open while the card is on
    // screen and the viewer is active, and a change missed while it was closed is caught by one fresh read when it opens again.
    const wAddr = c && !c.error && kindOn('contract') ? c.identity?.address : null, wChain = c?.identity?.chains?.[0] || c?.identity?.chainBasis || null;
    if (wAddr && hubCoin(wAddr, wChain) && html) {
      let checking = false, checkedAt = Date.now(), lastHash = c.investigation?.hash || c.investigation?.facts_hash || c.facts_hash || null;
      const sig = (x) => JSON.stringify([x.risk?.level, x.risk?.alert, x.risk?.pill, x.risk?.devPill, x.risk?.reasons, x.facts, x.investigation]);
      // intel's edge cache can still hold the old answer for up to ~15 s after the hub saw a change, and the hub says it only once:
      // a push whose fresh read shows nothing new is read again after 8 s and 20 s
      let retry = 0;
      const refresh = async (hash, attempt = 0) => {
        if (checking || !host.isConnected || !on('verdictPush')) return;
        if (hash && lastHash && hash === lastHash) return; // the card already shows this state
        checking = true;
        try {
          let [next, ...more] = await Promise.all([getC(ca, true), ...list.slice(1).map((x) => getC(x, true))]);
          [next, more] = lead(next, more);
          checkedAt = Date.now();
          if (!next || next.error) return;
          if (ownToken(next.identity?.address)) next = calmContract(next);
          const moreOk = more.filter((x) => x && !x.error).map((x) => (ownToken(x.identity?.address) ? calmContract(x) : x));
          if (sig(next) === sig(c)) { // nothing the card shows has changed (yet)
            clearTimeout(retry);
            if (hash && attempt < 2) retry = setTimeout(() => refresh(hash, attempt + 1), attempt ? 12e3 : 8e3);
            return;
          }
          clearTimeout(retry);
          lastHash = hash || next.investigation?.hash || next.investigation?.facts_hash || next.facts_hash || lastHash;
          redraw(next, moreOk);
        } catch { /* the next push or a revisit tries again */ } finally { checking = false; }
      };
      const vw = {port: null, visible: false};
      const vsync = () => {
        const want = vw.visible && document.visibilityState === 'visible' && Date.now() - lastActive < (CFG.timing?.liveIdleMs ?? 60e3) && host.isConnected && on('verdictPush');
        if (want && !vw.port) {
          const port = chrome.runtime.connect({name: 'live'});
          vw.port = port;
          port.postMessage({address: wAddr, chain: wChain, only: 'verdict'});
          port.onMessage.addListener((m) => {
            for (const x of m?.type === 'batch' && Array.isArray(m.m) ? m.m : [m]) {
              if (x?.type !== 'verdict') continue;
              const t = String(x.token || x.a || '').toLowerCase();
              if (t && t !== String(wAddr).toLowerCase()) continue;
              refresh(x.facts_hash || x.hash || null);
            }
          });
          port.onDisconnect.addListener(() => { if (vw.port === port) vw.port = null; });
          if (Date.now() - checkedAt > (CFG.timing?.verdictRecheckMs ?? 90e3)) refresh(null);
        } else if (!want && vw.port) { vw.port.disconnect(); vw.port = null; }
      };
      const vio = new IntersectionObserver(([e]) => { vw.visible = e.isIntersecting; vsync(); }, {threshold: 0.2});
      vio.observe(host);
      document.addEventListener('visibilitychange', vsync);
      const vtimer = setInterval(() => { if (!host.isConnected) { clearTimeout(retry); clearInterval(vtimer); vio.disconnect(); document.removeEventListener('visibilitychange', vsync); vw.port?.disconnect(); vw.port = null; return; } vsync(); }, 5000);
      host.__fableRefresh = refresh; // dev harness hook: drives a verdict push without a socket
    }
    // live fill: the server is reading the chain for these contracts; poll and update the card in place
    if (c && !c.error && (c.filling || others.some((x) => x.filling))) {
      for (let n = 0; n < 12 && host.isConnected; n++) {
        await new Promise((r) => setTimeout(r, n < 4 ? 2500 : 5000));
        let [next, ...more] = await Promise.all([getC(ca, true), ...list.slice(1).map((x) => getC(x, true))]);
        [next, more] = lead(next, more);
        if (!next || next.error) continue;
        const moreOk = more.filter((x) => x && !x.error);
        const done = !next.filling && !moreOk.some((x) => x.filling);
        if (JSON.stringify([next.facts, next.market, next.onchain, next.devHistory, next.investigation, moreOk.map((x) => x.risk)]) !== JSON.stringify([c.facts, c.market, c.onchain, c.devHistory, c.investigation, others.map((x) => x.risk)]) || done) redraw(next, moreOk);
        if (done) break;
      }
    }
  };

  // a post Fable's verdict skipped (not about crypto) still gets the author's record when it is worth showing:
  // smart followers, shipped projects or a promotion record. Everything else stays untouched.
  const upgradeHidden = async (article, v) => {
    const tw = TWEETS.get(v.id);
    const handle = tw?.author?.handle || article.querySelector('[data-testid="User-Name"] a[href^="/"]')?.getAttribute('href')?.slice(1);
    if (!handle || !/^[A-Za-z0-9_]{1,15}$/.test(handle) || /^fabledotmarket$/i.test(handle)) return;
    // an ad with a trading tool's invite link is promotion, whoever posts it: an amber "Promo post", never smart followers or a builder
    if (adIn(article, tw)) {
      // the verdict's label and detail stay English on purpose (other code compares them); the pill translates them where it draws (srv.intel.*, srv.author.*)
      const nv = {...v, hidden: false, tone: 'kol', label: 'Promo post', detail: adLinkIn(tw) ? 'Invite link in post' : 'Paid partnership', faces: []};
      VERDICTS.set(v.id, nv);
      article.setAttribute('data-fable-done', '');
      return render(article, nv);
    }
    // a post that names a Solana contract with no cue word and no ticker ("7Qy2...  买入", common in Chinese posts) is not a crypto post to the verdict engine, so its
    // verdict is hidden. The contract read decides: only a token intel KNOWS (known, a token, with a name or a symbol) gets a pill and a card; a string that merely looks
    // like an address stays silent. The read is the one prefetch() already started for the post (same cache key): no extra request, never one for a string the address
    // check (mixed case, a digit, 12 distinct characters) rejects.
    const bare = tw && !(tw.cashtags || []).length ? (globalThis.FableCapture?.extractAddresses?.(tw.text || '', []) || []).find((x) => x.chain === 'solana') : null;
    if (bare) {
      const c = await intelGet(`c:${bare.chain}:${bare.address}`, {type: 'contract', address: bare.address, chain: bare.chain, fresh: false, tweet: tw.id});
      const known = c && !c.error && c.known === true && c.identity?.isToken === true && (c.identity.name || c.identity.symbols?.length);
      if (known && article.getAttribute('data-fable-done') === v.id && !article.querySelector('[data-fable-host]')) {
        const nv = {...v, hidden: false, tone: 'neutral', label: TX('intel.pill.readOnchain'), detail: '', stat: '', faces: [], bareContract: true};
        VERDICTS.set(v.id, nv);
        article.setAttribute('data-fable-done', '');
        return render(article, nv);
      }
    }
    const h = await intelGet(`h:${handle.toLowerCase()}`, {type: 'history', handle});
    if (!h || h.error || article.getAttribute('data-fable-done') !== v.id || article.querySelector('[data-fable-host]')) return;
    const sm = h.smart?.n || 0, builds = h.builds?.length || 0;
    if (sm < 3 && !builds && !(h.promosTotal >= 2)) return;
    if (isCalloutPost(tw, v, h) || !authorSlot(handle, v.id)) return; // 0.29.1: the author's record on their first post of the page only, and never on a post that warns
    const faces = (h.smart?.people || []).filter((p) => p && (p.avatar || p.handle)).slice(0, 3);
    const nv = {...v, hidden: false, tone: 'legit', label: builds ? 'Builder' : 'Smart followers', detail: builds && !sm ? `${builds} project${builds === 1 ? '' : 's'} shipped` : String(sm), faces};
    if (h.promosTotal >= 2 && !sm && !builds) Object.assign(nv, {tone: 'kol', label: 'Promoter', detail: `${h.promosTotal} coins called in 30 days`, faces: []});
    VERDICTS.set(v.id, nv);
    article.setAttribute('data-fable-done', '');
    render(article, nv);
  };

  const important = (v) => !!v.stamp || (v.tone === 'rug' && IMPORTANT.has(v.label)) || (v.tone === 'kol' && IMPORTANT.has(v.label));
  // 0.29.1, pill first paint (a local guess waits 600 ms for the API's answer so the words never change after they are drawn): the chip is on the post at once, the Fable mark in a neutral box with no words, and the words fill it when the verdict lands. Only for a post that names a
  // coin (those are the posts that get a pill: any other would flash a chip and lose it).
  const stubChip = (article, tw) => {
    if (!settings.enabled || !on('pills') || !on('quickVerdict') || article.querySelector('[data-fable-host]')) return;
    const names = (tw?.cashtags || []).length || (globalThis.FableCapture?.extractAddresses?.(tw?.text || '', tw?.urls || []) || []).length;
    if (!names) return;
    const textEl = [...article.querySelectorAll('[data-testid="tweetText"]')].find((el) => !el.closest('[role="link"][tabindex]'));
    const bar = [...article.querySelectorAll('[role="group"]')].pop();
    if (!textEl && !bar) return;
    const host = document.createElement('div');
    host.setAttribute('data-fable-host', 'ui');
    host.setAttribute('data-stub', '1');
    if (textEl) textEl.insertAdjacentElement('afterend', host);
    else bar.insertAdjacentElement('beforebegin', host);
    // (0.30.0: the chip has the pill's height, ui.css .ctx.stub::after, so the words fill it without the post growing: 43 px against 50 measured)
    mountShadow(host, `<div class="ctx neutral stub" data-k="0">${fox()}</div>`, theme(), true);
    setTimeout(() => { if (host.isConnected && host.dataset.stub) host.remove(); }, 8000); // no verdict ever came: the chip does not stay
  };
  const render = (article, v) => {
    if (!settings.enabled || article.getAttribute('data-fable-done') === v.id || article.querySelector('[data-fable-host]:not([data-stub])')) return;
    const stub = article.querySelector('[data-fable-host][data-stub]');
    stub?.remove(); // the chip drawn at once gives way to the pill with its words
    v = scopeFor(article, v); // 0.29.1: a verdict about the author is drawn on the author's first post of the page only
    if (v.hidden || (CFG.copy?.hideLabels || []).includes(v.label) || (v.tone === 'neutral' && /^no flags$/i.test(v.label || '') && !v.card?.rows?.length)) { article.setAttribute('data-fable-done', v.id); if (settings.intel) upgradeHidden(article, v); return; } // not a crypto post: only a notable author gets a card
    const toneOn = {rug: settings.showRug, kol: settings.showKol, legit: settings.showLegit}[v.tone] ?? settings.showNeutral;
    if (!toneOn && !v.self) return article.setAttribute('data-fable-done', v.id);
    if (!v.pending) remember(article, v);
    const t = theme();
    const played = PLAYED.has(v.id) || !!window.__fableStill;
    // Always attach INSIDE the article: under the tweet text, or just above the action bar for media-only posts.
    const textEl = [...article.querySelectorAll('[data-testid="tweetText"]')].find((el) => !el.closest('[role="link"][tabindex]'));
    const bar = [...article.querySelectorAll('[role="group"]')].pop();
    if (!textEl && !bar) return;

    const host = document.createElement('div');
    host.setAttribute('data-fable-host', 'ui');
    host.style.contain = 'layout paint';
    if (textEl) textEl.insertAdjacentElement('afterend', host);
    else bar.insertAdjacentElement('beforebegin', host);
    article.setAttribute('data-fable-done', v.id);
    article.removeAttribute('data-fable-fade');
    if (v.fade && settings.fade) article.dataset.fableWantsFade = '1';
    else delete article.dataset.fableWantsFade;
    if (v.fade && settings.fade && played) article.setAttribute('data-fable-fade', '1');
    // a pill that takes the place of a chip already on screen does not slide in again (a card under it still unfolds)
    const instant = !!stub && !(settings.cards && important(v));
    mountShadow(host, ctxHTML(v) + (settings.cards && important(v) ? cardHTML(v.card) : ''), t, played || instant, v);
    // 0.30.0 (scroll, measured): a post first drawn with the wordless chip (a pending verdict, most coin posts since 0.29.2) is kept too; it was not, so on the way
    // back up it was drawn again from nothing and grew under the reader. The host holds the words painted into it since; a verdict that changed meanwhile is painted on restore.
    { const k = keepOf(v.id); k.ui = host; k.intel = null; k.v = v; k.t = t; k.bg = document.body.style.backgroundColor; k.view = pageView(); k.stamps = []; }
    // what play() does for a pill that slid in: the post is dimmed when no stamp will do it (the stamp dims the post as it lands)
    if (instant && !played) { PLAYED.add(v.id); if (v.fade && settings.fade) setTimeout(() => { if (article.dataset.fableWantsFade && !article.querySelector('[data-fable-host="stamp"]')) article.setAttribute('data-fable-fade', '1'); }, 200); }
    // Fable's own posts get the OFFICIAL line and nothing else: no card, underlines or stamp (the coins we name when
    // exposing a rug read as "coins called" in a promotion card)
    if (v.self) return;
    if (settings.intel && on('cards')) mountIntel(article, host, v, t, played).catch((e) => console.error('fable card', e?.message));
    if (v.official) host.shadowRoot?.querySelector('.ctx')?.setAttribute('data-chain', '1'); // nothing later overwrites the OFFICIAL pill
    if (textEl && settings.tokenMarks && on('tokenMarks') && !v.official) markTokens(article, v, textEl, t);
    if (v.stamp && settings.stamps && on('stamps')) stampFromVerdict(article, v, t, played, textEl, host);
  };

  // Stamp the post itself (its media, else its text), never Fable's own card.
  const stampFromVerdict = (article, v, t, played, textEl = null, host = null) => {
    textEl = textEl || [...article.querySelectorAll('[data-testid="tweetText"]')].find((el) => !el.closest('[role="link"][tabindex]')) || null;
    const target = article.querySelector('[data-testid="tweetPhoto"], [data-testid="videoComponent"], [data-testid="card.wrapper"]') || textEl || host || article.querySelector('[data-fable-host="ui"]');
    if (!target) return;
    const s = document.createElement('div');
    s.setAttribute('data-fable-host', 'stamp');
    s.className = 'fable-stamp-host';
    article.appendChild(s);
    const place = () => {
      const a = article.getBoundingClientRect();
      const r = target.getBoundingClientRect();
      s.style.left = `${r.left - a.left + r.width / 2}px`;
      s.style.top = `${r.top - a.top + r.height / 2}px`;
      s.style.setProperty('--k', target === textEl && r.height < 60 ? '0.6' : r.height < 140 ? '0.78' : '1');
    };
    place();
    requestAnimationFrame(place);
    new ResizeObserver(place).observe(article); // the card unfolding pushes media down, so follow it
    mountShadow(s, `<div class="stamp ink"><span>${esc(TR(v.stamp))}</span><em>${fox('fox')}FABLE</em></div>`, t, played);
    { const k = !STAMP_RESTORE && KEEP.get(String(v.id)); if (k && k.stamps.length < 4) k.stamps.push((a) => stampFromVerdict(a, v, t, true)); }
  };

  // The API verdict arrived after the instant local one: change only what differs, in place (the card stays put).
  const sameVerdict = (a, b) => a.tone === b.tone && a.label === b.label && (a.stamp || '') === (b.stamp || '') && (a.detail || '') === (b.detail || '') && !!a.hidden === !!b.hidden;
  // The API verdict arrived after the instant local one: only what differs is changed, in place (the card stays put; what the chain read or the account's record already
  // said on the pill is not overwritten, see paintVerdict)
  const apiVerdict = (article, v) => {
    if (!settings.enabled) return;
    const sv = scopeFor(article, v);
    if (!article.querySelector('[data-fable-host]:not([data-stub])')) { article.removeAttribute('data-fable-done'); render(article, v); return; } // nothing drawn yet: draw it now
    if (sv.hidden) return; // a post already showing a fact keeps it
    paintVerdict(article, sv);
  };

  // Light-DOM styles: dim flagged tweets, place the stamp, a tiny thud when it lands.
  const style = document.createElement('style');
  style.textContent = `
    article[data-fable-id] [data-testid="tweetText"], article[data-fable-id] [data-testid="tweetPhoto"],
    article[data-fable-id] [data-testid="videoComponent"], article[data-fable-id] [data-testid="card.wrapper"] { transition: opacity .35s cubic-bezier(.2,0,0,1), filter .35s cubic-bezier(.2,0,0,1); }
    article[data-fable-fade] [data-testid="tweetText"], article[data-fable-fade] [data-testid="tweetPhoto"],
    article[data-fable-fade] [data-testid="videoComponent"], article[data-fable-fade] [data-testid="card.wrapper"] { opacity: .35; filter: grayscale(.6); }
    article[data-fable-id] { position: relative; }
    [data-fable-host]:not(article [data-fable-host]) { display: none !important; }
    .fable-tk-host { position: absolute; left: 0; top: 0; width: 0; height: 0; z-index: 1; pointer-events: none; }
    .fable-stamp-host { position: absolute; transform: translate(-50%,-50%) scale(var(--k, 1)); z-index: 2; pointer-events: none; }
    @keyframes fable-thud { 0% { transform: translate(0,0); } 25% { transform: translate(0,2px); } 50% { transform: translate(-1px,-1px); } 75% { transform: translate(1px,0); } 100% { transform: translate(0,0); } }
    article.fable-thud { animation: fable-thud .28s ease-out; }
  `;
  (document.head || document.documentElement).appendChild(style);

  scan();
})();
