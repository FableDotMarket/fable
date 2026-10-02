// Fable content script (isolated world). Parses X's own GraphQL data, finds tweets on screen,
// asks the background worker for verdicts, and renders pills / cards / stamps under each tweet.
(() => {
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
    if (SHEET) { try { SHEET.replaceSync(themeCss()); } catch { /* keep the old style */ } }
  };
  chrome.storage.local.get('fableConfig', (s) => useConfig(s?.fableConfig));
  chrome.storage.onChanged.addListener((c, area) => { if (area === 'local' && c.fableConfig) useConfig(c.fableConfig.newValue); });

  // styles must be in hand before anything renders, or the first posts get unstyled (giant) icons
  fetch(chrome.runtime.getURL('src/ui.css')).then((r) => r.text()).then((t) => { css = t; scan(); });
  chrome.storage.sync.get(DEFAULTS, (s) => (settings = s));
  const redraw = () => {
    document.querySelectorAll('[data-fable-host], [data-fable-profile], [data-fable-trend]').forEach((n) => n.remove());
    document.querySelectorAll('article[data-fable-id]').forEach((a) => { a.removeAttribute('data-fable-id'); a.removeAttribute('data-fable-done'); a.removeAttribute('data-fable-fade'); });
    profileFor = null;
    scan();
  };
  chrome.storage.onChanged.addListener((c, area) => {
    const shown = Object.keys(DEFAULTS).filter((k) => k !== 'enabled' && c[k]);
    if (area === 'sync' && shown.length) { for (const k of shown) settings[k] = c[k].newValue; redraw(); }
    if (c.enabled) {
      settings.enabled = c.enabled.newValue;
      if (!settings.enabled) document.querySelectorAll('[data-fable-host]').forEach((n) => n.remove());
      document.querySelectorAll('article[data-fable-id]').forEach((a) => { a.removeAttribute('data-fable-id'); a.removeAttribute('data-fable-done'); });
      scan();
    }
    if (c.mode || c.apiUrl || c.demo) {
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
      cashtags: ents('symbols').map((s) => s.text.toUpperCase()),
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
    return {id, text, author: {handle}, cashtags: (text.match(/\$[A-Za-z][A-Za-z0-9]{1,9}\b/g) || []).map((s) => s.slice(1).toUpperCase()), urls: []};
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
    const cas = (globalThis.FableCapture?.extractAddresses?.(tw.text || '', tw.urls || []) || []).slice(0, CFG.limits?.contractsPerPost ?? 3);
    for (const ca of cas) intelGet(`c:${ca.chain}:${ca.address}`, {type: 'contract', address: ca.address, chain: ca.chain, fresh: false, tweet: tw.id});
    if (cas[0]?.address) candlesFor(cas[0].address, cas[0].chain);
    const h = tw.author?.handle;
    if ((withHistory || cas.length) && h && /^[A-Za-z0-9_]{1,15}$/.test(h)) intelGet(`h:${h.toLowerCase()}`, {type: 'history', handle: h});
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
      }
    }
    profilePanel();
    if (on('sidebar')) trendPanel();
    // the pill first, from the rules in this extension (instant); the API verdict follows and upgrades it in place.
    // The API used to gate everything: 0.3 s warm, 11 s cold (2026-09-30), and the card waited behind it.
    if (need.length && on('quickVerdict')) chrome.runtime.sendMessage({type: 'quick', tweets: need}).then((res) => {
      for (const v of res?.verdicts || []) {
        if (VERDICTS.has(v.id)) continue;
        VERDICTS.set(v.id, {...v, provisional: true});
        const a = document.querySelector(`article[data-fable-id="${v.id}"]`);
        if (a) render(a, VERDICTS.get(v.id));
      }
    }).catch(() => {});
    // small batches: each one renders as soon as the API answers instead of waiting for the slowest post
    for (let k = 0; k < need.length; k += 6) {
      const chunk = need.slice(k, k + 6);
      chrome.runtime.sendMessage({type: 'verdicts', tweets: chunk}).then((res) => {
        for (const v of res?.verdicts || []) {
          const prev = VERDICTS.get(v.id);
          VERDICTS.set(v.id, v);
          PENDING.delete(v.id);
          const a = document.querySelector(`article[data-fable-id="${v.id}"]`);
          if (a && prev?.provisional) upgrade(a, prev, v);
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

  new MutationObserver(scan).observe(document.documentElement, {childList: true, subtree: true});

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
  const av = (src, cls = 'av') => (src ? `<img class="${cls}" src="${esc(src)}" alt="">` : `<span class="${cls} ph"></span>`);
  const i = (n) => `style="--i:${n}"`;
  const ofN = (stat) => {
    const m = String(stat || '').match(/(\d+)\s*\/\s*(\d+)/);
    return m ? `${m[1]} of ${m[2]}` : stat;
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
      if (d.length <= 46) return esc(d);
      if (v.stat && String(v.stat).length <= 24) return esc(v.stat);
      const nums = d.match(/\d[\d,.]*%?\s+(?:of\s+)?[a-z]+(?:\s+[a-z]+)?/gi) || [];
      return esc(nums.slice(0, 2).join(' · ') || `${d.slice(0, 44).replace(/\s+\S*$/, '')}…`);
    }
    const people = v.card?.people || [];
    const n = parseInt(v.stat, 10) || people.length;
    if (people.length) {
      const named = people.slice(0, 2).map((p) => `<b>${esc(p.name || p.handle)}</b>`).join(', ');
      const rest = n - Math.min(2, people.length);
      return `Followed by ${named}${rest > 0 ? ` and ${rest} other smart account${rest > 1 ? 's' : ''}` : ''}`;
    }
    if (/smart follower/i.test(v.label) || /smart follower/i.test(v.stat)) return n ? `Followed by ${n} smart account${n > 1 ? 's' : ''}` : '';
    if (/rug history/i.test(v.label)) return `Deployer rugged ${ofN(v.stat)} launches`;
    if (/shill/i.test(v.label)) return /\//.test(v.stat) ? `${ofN(v.stat).replace(' rugged', '')} promoted tokens down 85%+` : 'Reads like an undisclosed promotion';
    if (/scam/i.test(v.label)) return 'Asks for replies or DMs in exchange for money';
    if (/legit dev/i.test(v.label)) return `${parseInt(v.stat, 10) || 'Several'} products shipped`;
    if (/engagement/i.test(v.label)) return 'Recycled money-flex format built for replies';
    if (/builder/i.test(v.label)) return 'Shipping update from a builder';
    return '';
  };

  // One plain line: label, faces, context. Role and reputation live in the card, not on the line.
  const ctxHTML = (v) => {
    if (!on('pills')) return '';
    // a verdict label can be renamed from the remote config (copy.labels)
    if (CFG.copy?.labels?.[v.label]) v = {...v, label: CFG.copy.labels[v.label]};
    const pile = (v.card?.people || []).slice(0, 3).map((p) => p.avatar).filter(Boolean);
    const faces = (v.faces || (pile.length ? pile : v.avatars || [])).slice(0, 3);
    const d = v.tone === 'neutral' && !v.detail ? '' : detail(v);
    return `
      <div class="ctx ${v.tone} ${v.card?.rows ? 'tap' : ''}" data-k="0" ${i(0)}>
        ${fox()}<span class="verdict">${esc(v.label)}</span>${v.badge ? `<span class="badge ${v.badge === 'DOXXED' ? 'g' : v.badge === 'OFFICIAL' ? 'f' : 'a'}">${esc(v.badge)}</span>` : ''}
        ${d ? `<span class="mid">·</span>${faces.length ? `<span class="pile">${faces.map((a) => av(a, 'face')).join('')}</span>` : ''}<span class="detail">${d}</span>` : ''}
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
    request: 'Based on the post as your browser loaded it.',
    client_obs: 'Recorded in Fable users\' browsers. Not independently checked.',
    client_hint: 'Seen by your extension. Fable has not confirmed it.',
    operator: 'From Fable\'s own records.',
    onchain: 'Observed on-chain.',
    thirdparty_list: `From ${row.credited ? `${row.credited}, a third-party source` : 'a public third-party list'}.`,
    thirdparty_self: `Reported by ${row.credited || 'a third party'} about itself.`,
    declared: 'As the account itself states it.',
  })[row.prov?.class] || 'Source recorded with this evidence.';
  const evidenceCard = (row, k) => {
    const [cls] = EV_TONE[row.tone] || ['muted'];
    const more = row.lines.length > 1 ? `<span class="more">+${row.lines.length - 1}</span>` : '';
    return `
      <div class="sig ${cls} tap" data-k="${k}" ${i(2 + k)}>${icon(row.kind)}<div class="txt"><b>${esc(row.title || '')}</b><span>${esc(row.lines[0] || '')}</span></div>${more ? `<div class="aside">${more}</div>` : ''}${CHEV}</div>`;
  };
  const evidenceSheet = (row) => {
    const [, word, dot] = EV_TONE[row.tone] || ['muted', '', ''];
    return `<p class="lead"><b class="${word}">${esc(row.title || '')}</b>. ${esc(evSource(row))}</p>
        ${row.lines.map((x, n) => `<div class="line" style="--i:${n}"><span class="dot ${dot === 'r' ? '' : dot}" style="background:${dot === 'r' ? 'var(--red)' : dot ? '' : 'var(--t2)'}"></span><div class="who"><b style="font-weight:500;white-space:normal">${esc(x)}</b></div></div>`).join('')}`;
  };
  const evTitle = (row, fallback) => (isEvidence(row) && row.title ? row.title : fallback);
  const safeRow = (row, k) => { try { return rowHTML(row, k); } catch (e) { console.warn('fable: card row not shown', row?.kind, e?.message); return ''; } };
  const safeBody = (row) => { try { return sheetBody(row); } catch (e) { console.warn('fable: detail not shown', row?.kind, e?.message); return '<p class="lead">This detail could not be shown.</p>'; } };

  const rowHTML = (row, k) => {
    if (isEvidence(row)) return evidenceCard(row, k);
    const wrap = (tone, title, sub, right) => `
      <div class="sig ${tone} tap" data-k="${k}" ${i(2 + k)}>${icon(row.kind)}<div class="txt"><b>${title}</b><span>${sub}</span></div>${right ? `<div class="aside">${right}</div>` : ''}${CHEV}</div>`;
    if (row.kind === 'doxxed') return wrap('good', `Doxxed ${esc(row.role.toLowerCase())}`, row.proofs.map(esc).join(' · '), '<span class="badge g">DOXXED</span>');
    if (row.kind === 'anon') return wrap('warn', 'Anonymous dev', esc(row.note), '<span class="badge a">ANON</span>');
    if (row.kind === 'smart') {
      const extra = row.n - row.people.length;
      return wrap('good', `Followed by ${row.n} smart account${row.n > 1 ? 's' : ''}`,
        row.people.slice(0, 3).map((p) => `${esc(p.name)}${p.tag ? ` <i>${esc(p.tag)}</i>` : ''}`).join(' · '),
        `<span class="pile lg">${row.people.map((p) => av(p.avatar, 'face')).join('')}${extra > 0 ? `<span class="more">+${extra}</span>` : ''}</span>`);
    }
    if (row.kind === 'rugs')
      return wrap('bad', `Linked to ${row.n} rugged token${row.n > 1 ? 's' : ''}`, `${esc(row.how)} · ${row.tokens.map((x) => `<s>${esc(x)}</s>`).join(' ')}`, `<span class="big red">${num(String(row.n))}</span>`);
    if (row.kind === 'rep') {
      const faces = (row.vouchers || []).filter((p) => p.avatar).slice(0, 3);
      return wrap(row.score >= 1600 ? 'good' : row.score < 800 ? 'bad' : 'muted', `Reputation ${row.rep ?? '?'}/100`,
        `backed by ${row.vouches} ${row.vouches === 1 ? 'person' : 'people'}${row.vouchEth ? ` · ${row.vouchEth.toFixed(2)} ETH staked` : ''} · ${row.positive.toLocaleString('en-US')} positive, ${row.negative} negative`,
        faces.length ? `<span class="pile lg">${faces.map((p) => av(p.avatar, 'face')).join('')}${row.vouches > faces.length ? `<span class="more">+${row.vouches - faces.length}</span>` : ''}</span>` : '');
    }
    if (row.kind === 'engaged') {
      const b = row.boosters, d = row.discussed;
      const faces = [...b, ...d].filter((p) => p.avatar).slice(0, 3);
      const title = b.length ? `Retweeted by ${b.length} smart account${b.length > 1 ? 's' : ''}` : `Discussed by ${d.length} smart account${d.length > 1 ? 's' : ''}`;
      const sub = [...b, ...d].slice(0, 3).map((p) => esc(p.name || p.handle)).join(' · ');
      return wrap(b.length ? 'good' : 'muted', title, sub, faces.length ? `<span class="pile lg">${faces.map((p) => av(p.avatar, 'face')).join('')}</span>` : '');
    }
    if (row.kind === 'calls') {
      const bad = row.dead / Math.max(1, row.total) >= 0.6;
      return wrap(bad ? 'warn' : 'muted', `Call record: ${row.total} call${row.total === 1 ? '' : 's'} graded`, `<em class="${bad ? 'red' : ''}">${row.dead} down 85%+</em> · ${row.winners} went 2x+`,
        `<span class="ticks">${row.list.slice(0, 10).map((x, n) => `<i class="${x.pct < 0 ? 'd' : 'u'}" style="--h:${n}"></i>`).join('')}</span>`);
    }
    if (row.kind === 'flags') return wrap(row.tone === 'legit' ? 'good' : row.tone === 'kol' ? 'warn' : row.tone === 'neutral' ? 'muted' : 'bad', esc(row.title), esc(row.lines[0] || ''), row.lines.length > 1 ? `<span class="more">+${row.lines.length - 1}</span>` : '');
    if (row.kind === 'paid')
      return wrap('warn', 'Known paid promoter', `${row.promos} promos in 30 days · <em class="red">${row.dead} down 85%+</em>`,
        `<span class="ticks">${row.marks.map((d, n) => `<i class="${d ? 'd' : 'u'}" style="--h:${n}"></i>`).join('')}</span>`);
    if (row.kind === 'dev')
      return wrap('good', `Shipped ${row.shipped.length} products`, `${row.shipped.map(esc).join(' · ')}`, `<span class="yrs">${num(String(row.years))} yrs</span>`);
    if (row.kind === 'identity') return wrap('warn', `Renamed ${row.renames} time${row.renames === 1 ? '' : 's'}`, `Previously @${esc(row.last)} · handle changes hide past calls`, '');
    if (row.kind === 'fresh') return wrap('muted', 'New account', `Created ${row.days} days ago`, '');
    return '';
  };

  const cardHTML = (c) => {
    if (!c) return '';
    if (c.type === 'profile') return shell('Backstory', c.since ? `Tracking since ${c.since}` : '', `<div class="sigs">${c.rows.map(safeRow).join('')}</div>`);
    if (c.type === 'smart')
      return shell('Smart followers', '', `
        ${c.people.map((p, k) => `<div class="person" ${i(2 + k)}>${av(p.avatar, 'pav')}<div class="who"><b>${esc(p.name || p.handle)}</b><span>@${esc(p.handle)}</span></div>${p.tag ? `<span class="tag">${esc(p.tag)}</span>` : ''}</div>`).join('')}
        <div class="meter" ${i(6)}><span>Overlap with smart money</span><span class="track"><span class="fill" style="--w:${Math.round((c.score || 0.8) * 100)}%"></span></span><b>${esc(c.scoreLabel || '')}</b></div>`);
    if (c.type === 'kol') {
      const bad = c.tokens.filter((t) => t[1] < 0).length;
      return shell('Promotion history', 'Last 30 days', `
        <div class="toks">${c.tokens.map(([tk, p], k) => `<div class="tok ${p < 0 ? 'down' : 'up'}" ${i(2 + k * 0.6)}><span>${esc(tk)}</span>${num(`${p > 0 ? '+' : ''}${p}%`)}</div>`).join('')}</div>
        <div class="foot" ${i(9)}><b>${bad} of ${c.tokens.length} down 85%+</b><span>${esc(c.footer || '')}</span></div>`);
    }
    if (c.type === 'lines')
      return shell(c.title || 'Backstory', c.right || '', `<div class="sigs">${(c.lines || []).map((t, k) => `<div class="sig ${c.tone === 'self' ? 'self' : c.tone === 'kol' ? 'warn' : c.tone === 'legit' ? 'good' : 'bad'}" ${i(2 + k)}><div class="txt"><span class="line-txt">${esc(t)}</span></div></div>`).join('')}</div>`);
    if (c.type === 'rug')
      return shell(c.title || 'Deployer history', c.wallet, `
        <div class="rugrow">
          <svg class="chart" viewBox="0 0 142 50" ${i(2)}><path d="M2 40 L18 37 L30 30 L40 33 L52 18 L60 22 L70 6 L78 9 L84 5 L90 44 L104 45 L120 46 L140 46" pathLength="1"/></svg>
          ${c.stats.map(([val, k], n) => `<div class="stat ${n ? 'red' : ''}" ${i(3 + n)}><b>${num(val)}</b><span>${esc(k)}</span></div>`).join('')}
        </div>
        <div class="list" ${i(7)}>${(c.tokens || []).map(([tk, dead]) => `<span class="${dead ? 'dead' : ''}">${esc(tk)}</span>`).join('')}</div>`);
    if (c.type === 'dev')
      return shell('Builder history', c.years, `
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
  const play = (host) => {
    const root = host.shadowRoot?.querySelector('.fable');
    if (!root || root.classList.contains('in')) return;
    io.unobserve(host);
    root.classList.add('in');
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
  const onScreen = (el) => {
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.top < innerHeight * 0.92 && r.right > 0 && r.left < innerWidth;
  };
  // Trigger 1: scrolled into view. Trigger 2 (in mountShadow): already on screen when rendered,
  // which IntersectionObserver can miss when a node is swapped in place.
  const io = new IntersectionObserver((entries) => {
    for (const en of entries) if (en.isIntersecting) play(en.target);
  }, {threshold: 0.35});

  // a logo that fails to load (slow IPFS links) disappears instead of showing a broken-image icon
  const hideBroken = (root) => root.querySelectorAll('img').forEach((im) => im.addEventListener('error', () => { if (im.matches('.mv-logo, .tl, .fox')) im.remove(); else im.style.visibility = 'hidden'; }, {once: true}));
  const mountShadow = (host, html, t, played, v) => {
    const root = host.attachShadow({mode: 'open'});
    root.innerHTML = `${styleFor(root)}<div class="fable ${t} ${played ? 'in done' : ''}">${html}</div>`;
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

  const SHEET_TITLES = {history: 'History', contract: 'Contract', engaged: 'Smart engagement', rep: 'Reputation', calls: 'Call record', flags: 'Red flags', smart: 'Smart followers', rugs: 'Linked rugs', paid: 'Promotion record', dev: 'Builder history', identity: 'Handle history', fresh: 'Account age', doxxed: 'Identity', anon: 'Identity', thesis: 'Thesis', token: 'Contract scan'};

  const TONE = {bad: 'red', warn: 'amber', good: 'green', muted: ''};

  // Account history heatmap (owner #236, PRODUCT-PLAN item 2): one cell per day, weeks as columns. A cell shows events Fable
  // observed that day; grey hatching means Fable has no data for that day (unknown, never clean). Colour = event type;
  // a ring marks a day with more than one type. Tap a day for its receipts.
  const HM_ORDER = ['adverse', 'report', 'correction', 'promotion', 'building'];
  const HM_LABEL = {building: 'Building', promotion: 'Promotions', adverse: 'Confirmed bad act', report: 'Reports (unproven)', correction: 'Corrections'};
  const hmDay = (d, i = 0) => {
    const types = HM_ORDER.filter((t) => d.events.some((e) => e.type === t));
    const cls = d.coverage === 'before_account' ? 'pre' : d.coverage !== 'observed' ? 'nodata' : types.length ? `t-${types[0]}` : 'quiet';
    const tip = d.coverage === 'observed' ? `${d.date}: ${d.events.length ? d.events.map((e) => e.label).slice(0, 3).join('; ') : 'observed, nothing notable'}` : `${d.date}: ${d.coverage === 'before_account' ? 'before the account existed' : 'no data (unknown)'}`;
    return `<button class="hx ${cls}${types.length > 1 ? ' mix' : ''}" data-d="${esc(d.date)}" style="--n:${Math.floor(i / 7) + (i % 7)}" aria-label="${esc(tip)}" title="${esc(tip)}"></button>`;
  };
  const historyBody = (row) => {
    if (row.state !== 'done') return `<div class="th-load"><span class="th-spin"></span><div><b>Reading history</b><span>Everything Fable has seen from @${esc(row.handle)}, day by day.</span></div></div>`;
    const d = row.data;
    if (!d || d.error) return `<p class="lead">History is not available right now.</p>`;
    const c = d.coverage || {};
    const legend = HM_ORDER.slice().reverse().map((t) => `<span class="hl"><i class="hx t-${t}"></i>${HM_LABEL[t]} <b>${d.counts?.[t] || 0}</b></span>`).join('');
    const sel = row.sel && d.days.find((x) => x.date === row.sel);
    const detail = sel ? `<div class="hd"><b>${esc(sel.date)}${sel.total > sel.events.length ? ` <span class="hq">${sel.events.length} of ${sel.total} events shown</span>` : ''}</b>${sel.events.length ? sel.events.map((e) => `<div class="he"><i class="hx t-${e.type}"></i><div><b>${esc(e.label)}</b>${e.text ? `<span>${esc(e.text)}</span>` : ''}<em>${esc(e.basis === 'allegation' ? 'Allegation, not proof' : e.basis === 'corroborated' ? 'Corroborated on-chain' : e.basis === 'correction' ? 'Correction' : 'Observed')} · ${esc(e.source)} · ${esc(String(e.at).slice(11, 16))} UTC${e.url ? ` · <a href="${esc(e.url)}" target="_blank" rel="noopener">open</a>` : ''}</em></div></div>`).join('') : `<span class="hq">${sel.coverage === 'observed' ? 'Fable saw activity but nothing notable.' : sel.coverage === 'before_account' ? 'Before the account existed.' : 'No data for this day. Unknown, not clean.'}</span>`}</div>` : `<div class="hd hq">Tap a day to see what Fable saw.</div>`;
    // drop leading weeks with nothing observed (keep at least 8), so a new account is not a wall of hatching
    let days = d.days;
    const firstWk = Math.floor(Math.max(0, days.findIndex((x) => x.coverage === 'observed')) / 7);
    const drop = Math.max(0, Math.min(firstWk, Math.floor(days.length / 7) - 8)) * 7;
    days = days.slice(drop);
    const weeks = Math.ceil(days.length / 7);
    const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const months = Array.from({length: weeks}, (_, w) => { const wk = days.slice(w * 7, w * 7 + 7); const m = wk.find((x) => x.date.endsWith('-01')) || (w === 0 && wk[0]); return `<span>${m ? MON[Number(m.date.slice(5, 7)) - 1] : ''}</span>`; }).join('');
    return `<p class="lead">Seen on <b>${c.observedDays || 0}</b> of ${days.length} days${c.lastObserved ? `, last on ${esc(c.lastObserved)}` : ''}. <span class="hq">Each square is one day, coloured by what happened.</span></p>
      <div class="hmw ${row.waved ? 'still' : ''}" style="--weeks:${weeks}"><div class="hmo">${months}</div><div class="hm">${days.map(hmDay).join('')}</div></div>
      <div class="hleg">${legend}<span class="hl"><i class="hx nodata"></i>No data</span></div>${detail}`;
  };

  const thesisBody = (row) => {
    if (row.state === 'loading') return `<div class="th-load"><span class="th-spin"></span><div><b>Reading the project</b><span>Pulling its posts, listing and on-chain data. The first read takes up to 20 seconds.</span></div></div>`;
    const d = row.data;
    if (!d || d.error) {
      const why = d?.error === 'rate_limited' ? 'Too many new reads from this network. Try again in a bit.' : d?.error === 'not_enough_data' ? 'Not enough public information about this one yet.' : 'Could not read this account right now. Try again in a moment.';
      return `<p class="lead">${why}</p>`;
    }
    const s = d.subject || {}, t = d.thesis || {};
    const src = (x) => (x.kind === 'post' ? `Post${x.time ? ' · ' + new Date(x.time).toLocaleDateString('en-US', {month: 'short', day: 'numeric'}) : ''}` : {website: 'Website', chart: 'Chart'}[x.kind] || 'Source');
    if (t.accountType === 'person' || t.accountType === 'media') {
      const who = s.name || (s.handle ? `@${s.handle}` : 'Account');
      return `<div class="th-top">${s.avatar ? av(s.avatar, 'th-av') : `<span class="th-av th-mono">${esc(who.replace(/^@/, '').slice(0, 1))}</span>`}
        <div class="th-id"><b>${esc(who)}</b><span>${esc(s.handle ? `@${s.handle}` : '')}</span></div>
        <span class="th-tag">${t.accountType === 'media' ? 'News / media' : 'Person'}</span></div>
      <p class="th-one">${esc(t.oneLiner || '')}</p>
      ${(t.topics || []).length ? `<div class="th-sec"><h4>Usually posts about</h4><div class="th-unk th-topics">${t.topics.map((x) => `<span>${esc(x)}</span>`).join('')}</div></div>` : ''}
      ${(t.knownFor || []).length ? `<div class="th-sec"><h4>Known for</h4>${t.knownFor.map((c, n) => `<div class="th-claim" style="--i:${n}">${esc(c)}</div>`).join('')}</div>` : ''}
      ${t.style ? `<div class="th-sec"><h4>How they post</h4><p>${esc(t.style)}</p></div>` : ''}
      ${(t.mentions || []).length ? `<div class="th-sec"><h4>Names often</h4><div class="th-unk th-topics">${t.mentions.map((x) => `<span>${esc(x)}</span>`).join('')}</div></div>` : ''}
      ${(d.facts || []).length ? `<div class="th-sec"><div class="th-facts">${d.facts.map((f, n) => `<div class="th-f" style="--i:${n}"><span>${esc(f.label)}</span><b>${esc(f.value)}</b></div>`).join('')}</div></div>` : ''}
      ${(d.sources || []).length ? `<div class="th-src">${d.sources.map((x) => `<a href="${esc(x.url)}" target="_blank" rel="noopener">${src(x)}</a>`).join('')}</div>` : ''}
      <p class="th-note">AI summary of the account's recent public posts${d.cached ? '' : ', written just now'}. Figures are measured, not generated.</p>`;
    }
    const title = s.symbol ? `$${s.symbol}` : s.name || (s.handle ? `@${s.handle}` : 'Project');
    return `<div class="th-top">${s.avatar ? av(s.avatar, 'th-av') : `<span class="th-av th-mono">${esc(title.replace(/^[$@]/, '').slice(0, 1))}</span>`}
        <div class="th-id"><b>${esc(title)}</b><span>${esc([s.name && s.symbol ? s.name : '', s.handle ? `@${s.handle}` : '', s.chain || ''].filter(Boolean).join(' · '))}</span></div>
        ${t.narrative && t.narrative !== 'Not stated' ? `<span class="th-tag">${esc(t.narrative)}</span>` : ''}</div>
      <p class="th-one">${esc(t.oneLiner || '')}</p>
      <div class="th-sec"><h4>The pitch</h4><p>${esc(t.pitch || 'Not stated')}</p></div>
      ${(t.claims || []).length ? `<div class="th-sec"><h4>What they claim</h4>${t.claims.map((c, n) => `<div class="th-claim" style="--i:${n}">${esc(c)}</div>`).join('')}</div>` : ''}
      ${(t.unknowns || []).length ? `<div class="th-sec"><h4>Not stated anywhere</h4><div class="th-unk">${t.unknowns.map((u) => `<span>${esc(u)}</span>`).join('')}</div></div>` : ''}
      ${(d.facts || []).length ? `<div class="th-sec"><h4>Reality check</h4><div class="th-facts">${d.facts.map((f, n) => `<div class="th-f" style="--i:${n}"><span>${esc(f.label)}</span><b class="${TONE[f.tone] || ''}">${esc(f.value)}</b></div>`).join('')}</div></div>` : ''}
      ${(d.sources || []).length ? `<div class="th-src">${d.sources.map((x) => `<a href="${esc(x.url)}" target="_blank" rel="noopener">${src(x)}</a>`).join('')}</div>` : ''}
      <p class="th-note">AI summary of the project's own posts, listing and on-chain data${d.cached ? '' : ', written just now'}. Reality check figures are measured, not generated. Not financial advice.</p>`;
  };

  const sheetBody = (row) => {
    if (isEvidence(row)) return evidenceSheet(row);
    if (row.kind === 'history') return historyBody(row);
    if (row.kind === 'contract') return contractBody(row);
    if (row.kind === 'thesis') return thesisBody(row);
    if (row.kind === 'token') return tokenBody(row);
    if (row.kind === 'smart')
      return `<p class="lead">Followed by <b>${row.n}</b> account${row.n === 1 ? '' : 's'} Fable tracks as smart money: builders, funds and traders with a strong record.</p>
        ${(row.all || row.people).map((p, n) => `<a class="line" href="https://x.com/${esc(p.handle)}" target="_blank" rel="noopener" style="--i:${n}">${av(p.avatar, 'lav')}<div class="who"><b>${esc(p.name)}</b><span>@${esc(p.handle)}</span></div><div class="meta"><span>${esc(p.tag || '')}</span>${p.since ? `<span class="dim">Following since ${esc(p.since)}</span>` : ''}</div></a>`).join('')}`;
    if (row.kind === 'rugs')
      return `<p class="lead"><b class="red">${row.n} token${row.n > 1 ? 's' : ''}</b> tied to this account went to zero. Link: <b>${esc(row.how)}</b>.</p>
        ${row.wallet ? `<div class="wallet"><span class="dim">Linked wallet</span><code>${esc(row.walletShort)}</code><button class="copy" data-copy="${esc(row.wallet)}">Copy</button></div>` : ''}
        <div class="table"><div class="th"><span>Token</span><span>Launched</span><span>Peak</span><span>Now</span><span>Change</span></div>
        ${(row.items || []).map((x, n) => `<div class="tr" style="--i:${n}"><span><b>${x.url ? `<a href="${esc(x.url)}" target="_blank" rel="noopener" style="color:inherit">${esc(x.tk)}</a>` : esc(x.tk)}</b><em>${esc(x.chain || '')}</em></span><span>${esc(x.launched || '')}</span><span>${esc(x.ath || '')}</span><span>${esc(x.now || '')}</span><span class="red"><b>${x.drop == null ? '' : `-${x.drop}%`}</b>${x.life ? `<em>dead in ${esc(x.life)}</em>` : ''}</span></div>`).join('')}</div>`;
    if (row.kind === 'paid')
      return `<p class="lead"><b>${row.promos}</b> promotions in the last 30 days. <b class="red">${row.dead}</b> are down 85% or more. ${row.list?.filter((x) => x.disclosed).length || 0} were disclosed as paid.</p>
        <div class="table four"><div class="th"><span>Token</span><span>Posted</span><span>Disclosed</span><span>Since post</span></div>
        ${(row.list || []).map((x, n) => `<div class="tr" style="--i:${n}"><span><b>${esc(x.tk)}</b></span><span>${esc(x.date)}</span><span>${x.disclosed ? 'Yes' : '<span class="amber">No</span>'}</span><span class="${x.dead ? 'red' : 'green'}"><b>${x.pct > 0 ? '+' : ''}${x.pct}%</b></span></div>`).join('')}</div>`;
    if (row.kind === 'dev')
      return `<p class="lead">Shipping for <b>${row.years} years</b> · <b>${row.commits}</b> public commits in the last 90 days.</p>
        ${(row.items || row.shipped.map((x) => ({name: x}))).map((x, n) => `<div class="line" style="--i:${n}"><span class="dot g"></span><div class="who"><b>${esc(x.name)}</b><span>Since ${esc(x.since || '')}</span></div><div class="meta"><span class="${x.status === 'Live' ? 'green' : 'dim'}">${esc(x.status || '')}</span></div></div>`).join('')}`;
    if (row.kind === 'doxxed')
      return `<p class="lead">The ${esc(row.role.toLowerCase())} behind this account is <b class="green">publicly identified</b>.</p>
        ${row.proofs.map((x, n) => `<div class="line" style="--i:${n}"><span class="dot g"></span><div class="who"><b>${esc(x)}</b></div></div>`).join('')}`;
    if (row.kind === 'anon') return `<p class="lead"><b class="amber">No public identity.</b> ${esc(row.note)}.</p>`;
    if (row.kind === 'identity')
      return `<p class="lead">Renamed <b class="amber">${row.renames} time${row.renames === 1 ? '' : 's'}</b>. Old handles carry old calls, so a rename can hide a track record.</p>
        ${(row.hist || []).map((x, n) => `<div class="line" style="--i:${n}"><span class="dot a"></span><div class="who"><b>@${esc(x.handle)}</b><span>Used until ${esc(x.until)}</span></div></div>`).join('')}`;
    if (row.kind === 'fresh') return `<p class="lead">Account created <b>${row.days} days ago</b>. New accounts have no history to check yet.</p>`;
    if (row.kind === 'engaged') {
      const verb = (k) => Object.entries(k).map(([kind, n]) => `${{retweet: 'retweeted', quote: 'quoted', reply: 'replied', mention: 'mentioned'}[kind] || kind}${n > 1 ? ` ${n}x` : ''}`).join(' · ');
      const line = (p, n) => `<a class="line" href="https://x.com/${esc(p.handle)}" target="_blank" rel="noopener" style="--i:${n}">${av(p.avatar, 'lav')}<div class="who"><b>${esc(p.name || p.handle)}</b><span>@${esc(p.handle)}</span></div><div class="meta"><span>${esc(p.tag || '')}</span><span class="dim">${esc(verb(p.kinds))}</span></div></a>`;
      return `<p class="lead">Seen on the timeline in the last 6 months. <b class="green">Retweets</b> count as a boost. Replies, quotes and mentions are shown as facts only, since they can be call-outs.</p>
        ${row.boosters.length ? `<p class="lead" style="margin-top:14px"><b>Retweeted by</b></p>${row.boosters.map(line).join('')}` : ''}
        ${row.discussed.length ? `<p class="lead" style="margin-top:14px"><b>Discussed by</b></p>${row.discussed.map(line).join('')}` : ''}`;
    }
    if (row.kind === 'rep')
      return `<p class="lead">Reputation <b>${row.rep ?? '?'}/100</b>${row.human ? ' · <b class="green">verified human</b>' : ''}. <b>${row.positive.toLocaleString('en-US')}</b> positive and <b class="${row.negative ? 'red' : ''}">${row.negative}</b> negative reviews. Backed by <b>${row.vouches}</b> ${row.vouches === 1 ? 'person' : 'people'}${row.vouchEth ? ` staking <b>${row.vouchEth.toFixed(2)} ETH</b>` : ''}.</p>
        ${(row.vouchers || []).map((p, n) => `<a class="line" href="https://x.com/${esc(p.handle)}" target="_blank" rel="noopener" style="--i:${n}">${av(p.avatar, 'lav')}<div class="who"><b>${esc(p.name || p.handle)}</b><span>@${esc(p.handle)}</span></div><div class="meta"><span>Rep ${p.rep ?? '?'}</span><span class="dim">${p.eth ? `${p.eth.toFixed(3)} ETH staked` : 'backs them'}</span></div></a>`).join('')}`;
    if (row.kind === 'calls')
      return `<p class="lead"><b>${row.total}</b> token calls graded against real prices. <b class="red">${row.dead}</b> fell 85% or more, <b class="green">${row.winners}</b> went 2x or more.</p>
        <div class="table four"><div class="th"><span>Token</span><span></span><span></span><span>Best after call</span></div>
        ${(row.list || []).map((x, n) => `<div class="tr" style="--i:${n}"><span><b>${esc(x.tk)}</b></span><span></span><span></span><span class="${x.pct < 0 ? 'red' : 'green'}"><b>${x.pct > 0 ? '+' : ''}${x.pct}%</b></span></div>`).join('')}</div>`;
    if (row.kind === 'flags')
      return `<p class="lead"><b class="${row.tone === 'kol' ? 'amber' : 'red'}">${esc(row.title)}</b>. Everything below was observed on-chain or in public posts.</p>
        ${row.lines.map((x, n) => `<div class="line" style="--i:${n}"><span class="dot ${row.tone === 'kol' ? 'a' : ''}" style="${row.tone === 'kol' ? '' : 'background:var(--red)'}"></span><div class="who"><b style="font-weight:500;white-space:normal">${esc(x)}</b></div></div>`).join('')}`;
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
    // drop null / non-object rows before tabs are drawn (Astra #238), keeping the tapped row selected
    const kept = (v.card?.rows || []).map((r, i) => [r, i]).filter(([r]) => r && typeof r === 'object');
    const rows = kept.map(([r]) => r);
    let cur = Math.max(0, kept.findIndex(([, i]) => i === k));
    // History tab for the post's author (owner #236): fetched once per card, then kept on the verdict
    const handle = v.id && TWEETS.get(v.id)?.author?.handle;
    if (handle && !rows.some((r) => r.kind === 'history')) rows.push(v._hist ||= {kind: 'history', state: 'idle', handle});
    if (!rows.length) return {repaint: () => {}};
    if (k === 'history') cur = Math.max(0, rows.findIndex((r) => r.kind === 'history'));
    sheetHost = document.createElement('div');
    sheetHost.setAttribute('data-fable-sheet', '');
    document.body.appendChild(sheetHost);
    const root = sheetHost.attachShadow({mode: 'open'});
    const paint = () => {
      const row = rows[cur];
      root.innerHTML = `${styleFor(root)}
        <div class="fable ${t} sheetwrap open">
          <div class="scrim"></div>
          <div class="sheet" role="dialog" aria-label="Fable">
            <div class="bar"><button class="x" aria-label="Close"><svg viewBox="0 0 24 24"><path d="M10.6 12 4.9 6.3l1.4-1.4 5.7 5.7 5.7-5.7 1.4 1.4-5.7 5.7 5.7 5.7-1.4 1.4-5.7-5.7-5.7 5.7-1.4-1.4 5.7-5.7Z"/></svg></button>
              ${fox('fox lg')}<b>${esc(row.kind === 'thesis' && ['person', 'media'].includes(row.data?.thesis?.accountType) ? 'Profile' : evTitle(row, SHEET_TITLES[row.kind] || 'Fable'))}</b>${row.kind === 'token' || row.kind === 'contract' || !v.label ? '' : `<span class="vtag ${v.tone}">${esc(v.label)}</span>`}</div>
            ${rows.length > 1 ? `<div class="tabs">${rows.map((r, n) => `<button class="tabb ${n === cur ? 'on' : ''}" data-n="${n}">${icon(r.kind)}${esc(evTitle(r, SHEET_TITLES[r.kind] || r.kind))}</button>`).join('')}</div>` : ''}
            <div class="sbody">${safeBody(row)}</div>
            <div class="sfoot"><a class="xh" href="https://x.com/FableDotMarket" target="_blank" rel="noopener">@FableDotMarket</a> · fable.market${v.source === 'demo' ? ' · demo data, not real findings' : ''}</div>
          </div>
        </div>`;
      root.querySelector('.scrim').onclick = closeSheet;
      root.querySelector('.x').onclick = closeSheet;
      root.querySelectorAll('.tabb').forEach((b) => (b.onclick = () => ((cur = Number(b.dataset.n)), paint())));
      root.querySelectorAll('.copy').forEach((b) => (b.onclick = () => navigator.clipboard.writeText(b.dataset.copy).then(() => (b.textContent = 'Copied'))));
      root.querySelectorAll('[data-thesis]').forEach((b) => (b.onclick = () => {
        const d = row.data || {};
        openThesis(d.address ? {chain: d.chain, address: d.address} : {symbol: d.symbol}, `$${d.symbol || ''}`);
      }));
      root.querySelectorAll('[data-live-scan]').forEach((b) => (b.onclick = () => { const d = row.data?.identity || {}; openToken({label: row.label || 'Contract', q: {address: d.address, ...(d.chains?.length === 1 ? {chain: d.chains[0]} : {})}}); }));
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

  // Contract sheet (owner #242, Astra #244): everything Fable holds on one (chain, address), grouped, each with its source.
  const cxAgo = (ms) => { if (!ms) return ''; const s = Math.max(0, (Date.now() - ms) / 1000); return s < 3600 ? `${Math.max(1, Math.round(s / 60))} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`; };
  const cxUsd = (n) => (n == null || !isFinite(n) ? '' : n >= 1e9 ? `$${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${Math.round(n / 1e3)}K` : n >= 1 ? `$${Math.round(n)}` : `$${Number(n).toPrecision(3)}`);
  const cxShort = (a) => (a ? `${a.slice(0, 6)}...${a.slice(-4)}` : '');
  const CX_CHAIN = {robinhood: 'Robinhood', solana: 'Solana', ethereum: 'Ethereum', base: 'Base', bsc: 'BNB Chain', arbitrum: 'Arbitrum'};
  const cxAddr = (chain, a) => (a ? (EXPLORER[chain] ? `<a href="${esc(EXPLORER[chain].replace('/token/', /^0x/.test(a) ? '/address/' : '/account/'))}${esc(a)}" target="_blank" rel="noopener">${esc(cxShort(a))}</a>` : esc(cxShort(a))) : '');
  const cxRow = (k, v, src) => (v ? `<div class="cx-r"><span>${esc(k)}</span><b>${v}</b>${src ? `<em>${esc(src)}</em>` : ''}</div>` : '');
  const contractBody = (row) => {
    const d = row.data;
    if (!d) return `<div class="th-load"><span class="th-spin"></span><div><b>Reading contract</b><span>Everything Fable has cached for this address.</span></div></div>`;
    if (d.error) return `<p class="lead">Contract context is not available right now.</p>`;
    const id = d.identity || {}, dep = d.deployment || {}, m = d.market || {}, h = d.history || {}, cn = d.connections || {};
    const chain = id.chains?.length === 1 ? id.chains[0] : null;
    const metric = (x, fmt) => (x ? `${fmt(x.value)}` : '');
    const msrc = (x) => (x ? `${x.source}, ${cxAgo(x.at)}${x.stale ? ', stale' : ''}` : '');
    const basis = {post: 'named in the post', records: 'from cached records', conflict: 'records disagree', unconfirmed: 'EVM address', 'address format': 'from the address format'}[id.chainBasis] || '';
    const sec = (title, body) => (body.trim() ? `<div class="cx-sec"><h4>${title}</h4>${body}</div>` : '');
    const days = Object.entries(h.days || {});
    const max = Math.max(1, ...days.map(([, n]) => n));
    const bars = days.length ? `<div class="cx-bars">${Array.from({length: 14}, (_, i) => { const dd = new Date(Date.now() - (13 - i) * 864e5).toISOString().slice(0, 10); const n = h.days[dd] || 0; return `<i style="--h:${Math.round((n / max) * 100)}%;--n:${i}" title="${dd}: ${n} post${n === 1 ? '' : 's'}"></i>`; }).join('')}</div><div class="hq">Captured posts per day, last 14 days</div>` : '';
    return `<p class="lead">${esc(d.headline)}</p>
      ${(d.facts || []).length ? `<div class="chips">${d.facts.map((f) => `<span class="chip ${f.tone}">${esc(f.text)}</span>`).join('')}</div>` : ''}
      ${sec('Identity', cxRow('Address', `<span class="mono">${esc(cxShort(id.address))}</span> <button class="copy" data-copy="${esc(id.address)}">Copy</button>`) + cxRow('Chain', chain ? `${esc(CX_CHAIN[chain] || chain)}` : esc(id.chains?.map((x) => CX_CHAIN[x] || x).join(', ') || 'Unknown'), basis) + (id.symbols || []).map((x) => cxRow('Ticker', `$${esc(x.symbol)}`, x.sources.join(', '))).join(''))}
      ${sec('Launch', cxRow('Launched', dep.launchedAt ? `${new Date(dep.launchedAt).toISOString().slice(0, 10)} (${cxAgo(dep.launchedAt)})` : '', dep.launchSource) + (dep.launchpad ? cxRow('Launchpad', `Pons${dep.launchpad.graduated ? ', graduated to a pool' : ', on its curve'}`, 'launchpad index') + cxRow('Creator', cxAddr('robinhood', dep.launchpad.creator) + (cn.creatorLaunches ? ` made ${cn.creatorLaunches.total} coins, ${cn.creatorLaunches.graduated} graduated` : ''), 'launchpad index') : '') + cxRow('Deployer', cxAddr(chain, dep.deployer) + (cn.deployerTokens ? ` made ${cn.deployerTokens.total} tokens${cn.deployerTokens.rugged ? `, ${cn.deployerTokens.rugged} rugged` : ''}` : ''), 'tokens') + cxRow('Funder', cxAddr(chain, dep.funder), 'tokens') + (dep.launch?.lines || []).map((l) => `<div class="rr ${esc(l.strength || '')}">${esc(l.text)}</div>`).join(''))}
      ${sec('Market', cxRow('Liquidity', metric(m.liquidity, cxUsd), msrc(m.liquidity)) + cxRow('Market cap', metric(m.mcap, cxUsd), msrc(m.mcap)) + cxRow('Price', metric(m.price, cxUsd), msrc(m.price)) + cxRow('Honeypot', m.honeypot ? (m.honeypot.value ? 'Yes, sells fail' : 'No') : '', msrc(m.honeypot)) + cxRow('Sell tax', m.sellTax ? `${m.sellTax.value}%` : '', msrc(m.sellTax)))}
      ${sec('Who posted it', (h.firstCaptured ? cxRow('First captured', `<a href="${esc(h.firstCaptured.url)}" target="_blank" rel="noopener">@${esc(h.firstCaptured.handle)}</a> ${cxAgo(h.firstCaptured.at)}`, 'first Fable saw, not first ever') : '') + cxRow('Posts', h.posts ? `${h.posts} by ${h.authors} account${h.authors === 1 ? '' : 's'}` : '', 'captured posts') + (h.topAuthors || []).map((a) => `<div class="cx-a"><a href="https://x.com/${esc(a.handle)}" target="_blank" rel="noopener">@${esc(a.handle)}</a><span>${a.posts} post${a.posts === 1 ? '' : 's'}</span>${a.smart ? '<i class="chip good">Smart</i>' : ''}${a.listed ? '<i class="chip warn">On a public list</i>' : ''}</div>`).join('') + bars + (h.calls?.captured ? cxRow('Calls', `${h.calls.captured} captured, ${h.calls.measured} with a price${h.calls.best ? `, best ${h.calls.best.toFixed(1)}x` : ''}`, 'captured calls') : ''))}
      ${sec('Connections', (cn.trackedOperation ? cxRow('Operation', esc(cn.trackedOperation.operation), cn.trackedOperation.basis) : '') + (cn.copromotion ? cxRow('Posted together', `${cn.copromotion.accounts} accounts within 6 hours`, 'co-promotion pairs') : ''))}

      <div class="cx-foot"><button class="hc-open" data-live-scan>Run live scan</button><span class="hq">${esc(d.note || '')}</span></div>`;
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
  const tokensIn = (id, article) => {
    const t = TWEETS.get(id);
    const text = t?.text || [...article.querySelectorAll('[data-testid="tweetText"]')].map((e) => e.innerText).join(' ');
    const out = [];
    const seen = new Set();
    const add = (q, label, needle) => { const k = JSON.stringify(q); if (!seen.has(k) && out.length < 3) { seen.add(k); out.push({q, label, needle}); } };
    for (const m of text.match(EVM_RE) || []) add({address: m.toLowerCase()}, `${m.slice(0, 6)}…${m.slice(-4)}`, m);
    for (const m of text.replace(/0x[a-fA-F0-9]+/g, ' ').match(SOL_RE) || []) if (/\d/.test(m) && /[a-z]/.test(m) && /[A-Z]/.test(m)) add({address: m}, `${m.slice(0, 4)}…${m.slice(-4)}`, m);
    const tags = t?.cashtags?.length ? t.cashtags : (text.match(/\$[A-Za-z][A-Za-z0-9]{1,9}\b/g) || []).map((s) => s.slice(1).toUpperCase());
    if (!out.length) for (const c of tags) if (!MAJORS.has(c)) add({symbol: c}, `$${c}`, `$${c}`);
    return out.slice(0, 2);
  };

  // first occurrence of `needle` inside `root` as a Range (case-insensitive, may span text nodes)
  const findRange = (root, needle) => {
    const nodes = [];
    let all = '';
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) { nodes.push({n, at: all.length}); all += n.nodeValue; }
    const i = all.toLowerCase().indexOf(needle.toLowerCase());
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
  const ageTxt = (h) => (h == null ? '' : h < 1 ? `${Math.max(1, Math.round(h * 60))}m old` : h < 48 ? `${Math.round(h)}h old` : `${Math.round(h / 24)}d old`);
  const LEVEL = {danger: 'High risk', caution: 'Caution', ok: 'No red flags', unknown: 'Not enough data', none: 'No market'};
  const strip = (t) => String(t || '').replace(/\.$/, '');
  // launch forensics first (bundle line leads), then the other reasons, no repeats
  const reasonsOf = (d, n = 5) => {
    const launch = (d.launch?.lines || []).filter((l) => l.strength !== 'weak').sort((a, b) => Number(b.rule === 'bundle-v1') - Number(a.rule === 'bundle-v1'));
    const shown = new Set(launch.map((l) => strip(l.text)));
    return [...launch.map((l) => ({text: strip(l.text), strength: l.strength})), ...(d.reasons || []).filter((r) => !shown.has(strip(r.text)))].slice(0, n);
  };
  const EXPLORER = {robinhood: 'https://robinhoodchain.blockscout.com/token/', base: 'https://basescan.org/token/', ethereum: 'https://etherscan.io/token/', solana: 'https://solscan.io/token/', bsc: 'https://bscscan.com/token/'};

  // bundle bar: share of supply the launch bundle took, and what it still holds when known
  const bundleHTML = (b, big) => {
    if (!b || !b.flagged || b.supplyPct == null) return '';
    const took = Math.min(100, Math.round(b.supplyPct));
    const held = b.heldPct != null ? Math.min(took, Math.round(b.heldPct)) : null;
    const how = [
      b.kind === 'declared' ? `${b.declared?.wallets || b.wallets} registered with the launchpad to skip the snipe tax` : '',
      b.declared?.reused >= 3 ? `${b.declared.reused} were bundle buyers in earlier launches` : '',
      b.tooling?.kind === 'bundler' ? 'launched through a known bundler contract' : '',
      b.sameFunder ? `${b.sameFunder} funded by one wallet` : '', b.sameTx ? `${b.sameTx} bought in one transaction` : '',
      b.kind !== 'declared' && b.freshShare != null ? `${Math.round(b.freshShare * 100)}% fresh wallets` : ''].filter(Boolean);
    return `<div class="bnd ${big ? 'big' : ''}">
      <div class="bnd-h"><b>${took}% bundled</b><span>${b.wallets} wallet${b.wallets === 1 ? '' : 's'} at launch${held != null ? ` · ${held}% still held` : ''}</span></div>
      <div class="bnd-bar"><i class="took" style="--w:${took}%"></i>${held != null ? `<i class="held" style="--w:${held}%"></i>` : ''}</div>
      ${big && how.length ? `<div class="bnd-how">${how.map(esc).join(' · ')}</div>` : ''}</div>`;
  };

  const hoverHTML = (tok, d) => {
    if (d === undefined) return `<div class="hc-h"><b>${esc(tok.label)}</b><span class="hc-lv unknown">Scanning</span></div><div class="hc-sk"><i></i><i></i><i></i></div>`;
    if (!d) return `<div class="hc-h"><b>${esc(tok.label)}</b></div><div class="hc-s">Scan unavailable right now.</div>`;
    if (!d.found) return `<div class="hc-h"><b>${esc(tok.label)}</b><span class="hc-lv none">No market</span></div><div class="hc-s">Not trading on a supported chain yet.</div>`;
    const lv = levelOf(d);
    const rows = reasonsOf(d, 3);
    const p = d.promoters || {};
    return `<div class="hc-h"><b>$${esc(d.symbol || '')}</b><span class="hc-chain">${esc(d.chain)}</span><span class="hc-lv ${lv}">${LEVEL[lv]}</span></div>
      <div class="hc-m">${[usd(d.liquidityUsd) && `<span><b>${usd(d.liquidityUsd)}</b> liq</span>`, usd(d.mcapUsd) && `<span><b>${usd(d.mcapUsd)}</b> mcap</span>`, d.ageHours != null && `<span><b>${ageTxt(d.ageHours).replace(' old', '')}</b> old</span>`].filter(Boolean).join('')}</div>
      ${bundleHTML(d.launch?.bundle, false)}
      ${rows.length ? `<div class="hc-r">${rows.map((r, n) => `<div class="rr ${r.strength}" style="--i:${n}">${esc(r.text)}</div>`).join('')}</div>` : `<div class="hc-r"><div class="rr ok">No safety, launch or promotion red flags found</div></div>`}
      ${p.kolPush?.n >= 2 ? `<div class="hc-p warn">Pushed by ${p.kolPush.n} accounts from a known scam KOL group this week</div>` : p.count ? `<div class="hc-p">Posted by ${p.count} account${p.count > 1 ? 's' : ''}${p.first?.length ? `: ${p.first.slice(0, 2).map((x) => `@${esc(x.handle)}`).join(', ')}` : ''}</div>` : ''}
      <div class="hc-f"><button class="hc-open" data-open>Full scan</button>${d.address ? `<button class="hc-ghost" data-copy="${esc(d.address)}">Copy CA</button>` : ''}${!d.launch && d.address ? '<span class="hc-note">Launch check<br>in full scan</span>' : ''}</div>`;
  };

  // the sheet version: everything we know about the token
  const tokenBody = (row) => {
    const d = row.data;
    if (row.state === 'loading' && !d) return `<div class="th-load"><span class="th-spin"></span><div><b>Scanning ${esc(row.label)}</b><span>Market, contract safety, launch bundle and who is pushing it.</span></div></div>`;
    if (!d || !d.found) return `<p class="lead">${!d ? 'Could not scan this token right now. Try again in a moment.' : 'This token is not trading on a supported chain yet.'}</p>`;
    const lv = levelOf(d);
    const b = d.launch?.bundle;
    const p = d.promoters || {};
    const facts = [['Liquidity', usd(d.liquidityUsd)], ['Market cap', usd(d.mcapUsd)], ['Age', ageTxt(d.ageHours).replace(' old', '')], ['From peak', d.fromPeak != null ? `-${Math.round(d.fromPeak * 100)}%` : ''],
      ['Top 10 wallets', d.launch?.top10Pct != null ? `${Math.round(d.launch.top10Pct)}%` : ''], ['Dev sold', d.launch?.devSold ? `${Math.round(d.launch.devSold.pct)}%${d.launch.devSold.minutes != null ? ` in ${d.launch.devSold.minutes}m` : ''}` : '']].filter(([, v]) => v);
    return `<div class="th-top"><span class="th-av th-mono">${esc((d.symbol || '?').slice(0, 1))}</span>
        <div class="th-id"><b>$${esc(d.symbol || '')}</b><span>${esc(d.chain)}${d.address ? ` · ${esc(d.address.slice(0, 6))}…${esc(d.address.slice(-4))}` : ''}</span></div>
        <span class="hc-lv ${lv} lg">${LEVEL[lv]}</span></div>
      ${row.state === 'loading' ? '<div class="tk-pend"><span class="th-spin sm"></span>Running launch forensics…</div>' : ''}
      ${facts.length ? `<div class="th-sec"><div class="th-facts">${facts.map(([k, v], n) => `<div class="th-f" style="--i:${n}"><span>${esc(k)}</span><b class="${k === 'From peak' && d.fromPeak >= 0.85 ? 'red' : ''}">${esc(v)}</b></div>`).join('')}</div></div>` : ''}
      ${b?.flagged ? `<div class="th-sec"><h4>Launch bundle</h4>${bundleHTML({...b, heldPct: d.launch?.bundle?.heldPct}, true)}${b.tx ? `<a class="tk-tx" href="${esc((EXPLORER[d.chain] || '').replace('/token/', '/tx/'))}${esc(b.tx)}" target="_blank" rel="noopener">View the bundle transaction</a>` : ''}</div>` : ''}
      <div class="th-sec"><h4>What we found</h4>${reasonsOf(d, 12).map((r, n) => `<div class="rr ${r.strength}" style="--i:${n}">${esc(r.text)}</div>`).join('') || '<div class="rr ok">No safety, launch or promotion red flags found</div>'}</div>
      ${p.count ? `<div class="th-sec"><h4>Who posted it</h4>${(p.first || []).map((x, n) => `<a class="line" href="https://x.com/${esc(x.handle)}" target="_blank" rel="noopener" style="--i:${n}"><div class="who"><b>@${esc(x.handle)}</b><span>${x.followers != null ? `${Number(x.followers).toLocaleString('en-US')} followers` : ''}</span></div><div class="meta">${x.ring ? '<span class="amber">promotion ring</span>' : ''}${x.poor ? '<span class="red">mostly dead calls</span>' : ''}</div></a>`).join('')}
        ${p.kolPush?.n >= 2 ? `<p class="lead red" style="margin-top:10px">Pushed by ${p.kolPush.n} accounts from a known scam KOL group this week: ${(p.kolPush.kols || []).slice(0, 4).map((h) => `@${esc(h)}`).join(', ')}</p>` : ''}</div>` : ''}
      <div class="tk-acts"><button class="tp-th" data-thesis>What is $${esc(d.symbol || 'this')}?</button>
        ${d.pairUrl ? `<a class="th-srcb" href="${esc(d.pairUrl)}" target="_blank" rel="noopener">Chart</a>` : ''}
        ${d.address && EXPLORER[d.chain] ? `<a class="th-srcb" href="${esc(EXPLORER[d.chain] + d.address)}" target="_blank" rel="noopener">Explorer</a>` : ''}
        ${d.address ? `<button class="copy" data-copy="${esc(d.address)}">Copy CA</button>` : ''}</div>`;
  };

  const openToken = (tok, lite) => {
    const row = {kind: 'token', state: 'loading', label: tok.label, data: lite && lite.found ? lite : null};
    const v = {tone: lite?.level === 'danger' ? 'rug' : lite?.level === 'caution' ? 'kol' : 'neutral', label: lite ? LEVEL[levelOf(lite)] : 'Scanning', card: {rows: [row]}};
    const sheet = openSheet(v, 0, theme());
    let tries = 0;
    const full = (retry) => chrome.runtime.sendMessage({type: 'scan', query: {...tok.q, ...(retry ? {retry: String(retry)} : {})}}).then((d) => {
      // the server finishes a slow launch scan in the background: ask again a few times
      if (d?.pending && tries++ < 3) { Object.assign(row, {data: d}); sheet.repaint(); return setTimeout(() => full(tries), 4000); }
      Object.assign(row, {state: 'done', data: d ? {...d, pending: false} : row.data});
      v.label = LEVEL[levelOf(row.data)];
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
    root.innerHTML = `${styleFor(root)}<div class="fable hcw"><div class="hc"></div></div>`;
    const card = root.querySelector('.hc');
    card.addEventListener('mouseenter', () => clearTimeout(hcHide));
    card.addEventListener('mouseleave', () => hideCard(160));
    card.addEventListener('click', (e) => {
      const c = e.target.closest('[data-copy]');
      if (c) { e.stopPropagation(); navigator.clipboard.writeText(c.dataset.copy).then(() => { c.textContent = 'Copied'; }); return; }
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
    w.className = `fable hcw ${theme()} ${w.classList.contains('show') ? 'show' : ''}`;
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
    root.innerHTML = `${styleFor(root)}<div class="fable tkl ${t}"></div>`;
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
          + `<button class="tk-dot lv-${lv}" data-n="${n}" title="Fable scan" style="left:${last.right - a.left + 1}px;top:${last.top - a.top + 3}px"><i></i></button>`;
      }).join('');
      requestAnimationFrame(() => layer.classList.add('on'));
    };
    paint();
    new ResizeObserver(paint).observe(article);
    host.__fableScan = () => toks.forEach((tok, n) => scanLite(tok.q).then((d) => {
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

  const RESERVED = new Set(['home', 'explore', 'notifications', 'messages', 'i', 'settings', 'search', 'compose', 'jobs', 'communities', 'premium', 'lists', 'bookmarks', 'tos', 'privacy']);
  let profileFor = null;
  const profilePanel = () => {
    if (!settings.profilePanel || !settings.enabled) return document.querySelector('[data-fable-profile]')?.remove();
    const m = (window.__fablePath || location.pathname).match(/^\/([A-Za-z0-9_]{1,15})(?:\/(?:with_replies|media|highlights|articles|likes|superfollows))?\/?$/);
    const handle = m && !RESERVED.has(m[1].toLowerCase()) ? m[1] : null;
    const existing = document.querySelector('[data-fable-profile]');
    if (!handle) { existing?.remove(); profileFor = null; return; }
    if (existing && existing.dataset.fableProfile.toLowerCase() === handle.toLowerCase() && existing.isConnected) return;
    const anchor = document.querySelector('[data-testid="UserProfileHeader_Items"]') || document.querySelector('[data-testid="UserDescription"]');
    if (!anchor || profileFor === `${handle}:pending`) return;
    existing?.remove();
    profileFor = `${handle}:pending`;
    const host = document.createElement('div');
    host.setAttribute('data-fable-profile', handle);
    host.style.margin = '12px 0 4px';
    anchor.insertAdjacentElement('afterend', host);
    const id = USER_IDS.get(handle.toLowerCase()) || null;
    chrome.runtime.sendMessage({type: 'profile', handle, id}).then((res) => {
      profileFor = handle;
      if (!host.isConnected || !res?.verdict) return host.remove();
      const v = {...res.verdict, id: `profile:${handle}`};
      const body = v.self ? ctxHTML(v)
        : v.card?.rows
        ? ctxHTML(v) + cardHTML(v.card)
        : ctxHTML(v) + `<div class="expand"><div><div class="card"><div class="head">${fox('fox lg')}<b>Fable</b><span class="kicker">Backstory</span></div><div class="sigs"><div class="sig muted"><div class="txt"><b>Nothing on record yet</b><span>No flags, reputation or smart followers found for @${esc(handle)}</span></div></div></div></div></div></div>`;
      const bio = document.querySelector('[data-testid="UserDescription"]')?.innerText || '';
      const project = /\$[A-Za-z][A-Za-z0-9]{1,9}\b|0x[a-fA-F0-9]{40}|\b(memecoin|meme coin|token|nfts?|collection|mint|pump\.fun|dexscreener|launchpad|ca:)/i.test(bio);
      const thesisLine = `<button class="thesis-line" data-thesis>${fox('fox')}<span><b>${project ? 'What' : 'Who'} is @${esc(handle)}?</b> ${project ? 'Read the thesis' : 'What they post and are known for'}</span><svg class="chev" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg></button>`;
      const root = mountShadow(host, `<div class="profile-panel">${thesisLine}${body}</div>`, theme(), false, v);
      root?.querySelector?.('[data-thesis]')?.addEventListener('click', () => openThesis({handle}, `@${handle}`));
    }).catch(() => { profileFor = null; host.remove(); });
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
    return m < 1 ? 'now' : m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
  };
  const kShort = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1).replace(/\.0$/, '')}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(/\.0$/, '')}K` : String(Math.round(n)));
  // a picture, or the first letters on a cobalt tile when X or the coin has none
  const avOf = (src, word, n = 4) => {
    if (src) return `<img class="av" src="${esc(src)}" alt="">`;
    const w = String(word || '').replace(/[^A-Za-z0-9]/g, '').slice(0, n).toUpperCase() || '?';
    return `<span class="av mono${w.length > 3 ? ' w4' : ''}">${esc(w)}</span>`;
  };
  const facesOf = (by) => `<span class="faces">${by.slice(0, 4).map((b) => (b.avatar ? `<img src="${esc(b.avatar)}" title="@${esc(b.handle)}" alt="">` : '<i></i>')).join('')}</span>`;
  // one smart account by name, or "3 smart accounts" for a group; the line under it names who
  const whoOf = (it) => (it.n >= 2 ? `<b>${it.n} smart accounts</b>` : `<b>${esc(it.by[0]?.name || it.by[0]?.handle || '')}</b>`);
  const byLine = (it) => {
    const first = it.by[0] || {};
    const names = it.n >= 2 ? `<span class="n2">@${esc(it.by.slice(0, 2).map((b) => b.handle).join(', @'))}${it.n > 2 ? ` +${it.n - 2}` : ''}</span>` : `<span>@${esc(first.handle || '')}</span>`;
    const tag = it.n < 2 && first.tag ? `<span class="tag">${esc(first.tag)}</span>` : '';
    return `<div class="by">${facesOf(it.by)}${names}${tag}<span class="t">${agoShort(it.at)}</span></div>`;
  };
  const feedRow = (it, i) => {
    const delay = `style="animation-delay:${i * 30}ms"`;
    // one smart account that followed several accounts: its face, the accounts' faces, a tap opens its Following list
    if (it.type === 'follows') {
      const who = it.by[0] || {};
      const names = it.targets.slice(0, 2).map((t) => `@${t.handle}`).join(', ') + (it.count > 2 ? ` +${it.count - 2}` : '');
      return `<a class="row" href="/${esc(who.handle)}/following" data-go="/${esc(who.handle)}/following" ${delay}>
        ${avOf(who.avatar, who.name || who.handle, 1)}
        <div class="bd">
          <div class="what"><b>${esc(who.name || who.handle)}</b> followed <b>${it.count} accounts</b></div>
          <div class="sub">${facesOf(it.targets)}<span>${esc(names)}</span></div>
          <div class="by"><span>@${esc(who.handle)}</span>${who.tag ? `<span class="tag">${esc(who.tag)}</span>` : ''}<span class="t">${agoShort(it.at)}</span></div>
        </div>
      </a>`;
    }
    if (it.type === 'follow') {
      const t = it.target;
      return `<a class="row" href="/${esc(t.handle)}" data-go="/${esc(t.handle)}" ${delay}>
        ${avOf(t.avatar, t.name || t.handle, 1)}
        <div class="bd">
          <div class="what">${whoOf(it)} followed <b>@${esc(t.handle)}</b></div>
          <div class="sub">${t.name && t.name !== t.handle ? `<span>${esc(t.name)}</span>` : ''}${t.followers != null ? `<span>${kShort(t.followers)} followers</span>` : ''}${t.smart ? '<span class="sm">SMART</span>' : ''}</div>
          ${byLine(it)}
        </div>
      </a>`;
    }
    const sym = it.symbol ? `$${it.symbol}` : it.ticker ? `$${it.ticker}` : `${it.address.slice(0, 6)}..${it.address.slice(-4)}`;
    const go = it.tweet && it.by[0] ? `/${it.by[0].handle}/status/${it.tweet}` : `/search?q=${encodeURIComponent(it.address || `$${it.ticker}`)}&f=live`;
    return `<a class="row coin" href="${esc(go)}" data-go="${esc(go)}" ${delay}>
        ${avOf(it.image, it.symbol || it.ticker || it.address.slice(0, 3))}
        <div class="bd">
          <div class="what">${whoOf(it)} posted <b>${esc(sym)}</b></div>
          ${it.mcap ? `<div class="sub"><span class="mc">$${kShort(it.mcap)}</span><span>market cap</span></div>` : ''}
          ${byLine(it)}
        </div>
      </a>`;
  };
  const trendHTML = () => {
    const items = trendData?.items || [];
    const shown = trendOpen ? items.slice(0, 15) : items.slice(0, 5);
    const wider = TWINS[TWINS.indexOf(trendWin) + 1];
    const body = !trendData ? '<div class="msg">Loading…</div>'
      : items.length ? shown.map(feedRow).join('') + (items.length > 5 ? `<button class="more" data-more>${trendOpen ? 'Show less' : `Show ${Math.min(items.length, 15) - 5} more`}</button>` : '')
        : `<div class="msg">No smart money moves in the last ${trendWin === '1h' ? 'hour' : trendWin}.${wider ? ` <button data-w="${wider}">See ${wider}</button>` : ''}</div>`;
    const mark = chrome.runtime.getURL(theme() === 'light' ? 'icons/mark.svg' : 'icons/mark-dark.svg');
    return `<div class="hd"><img src="${mark}" alt=""><b>Smart money</b><span class="live"><i></i>live</span><a class="term" href="https://intel.fable.market/" target="_blank" rel="noopener">Terminal</a></div>
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
  setInterval(whoAmI, 60000);

  /* ---------------- Inline card, video style (owner #247 / #254): open on the post as it scrolls in, no click ----------------
     One card per post, picked from what Fable really holds: the contract in the post, the smart accounts behind the author,
     the coins the author called in the last 30 days, their build history, or their activity. Every number is real; a coin
     with no measured price says "pending", never a made-up return. Tap the card for receipts. */
  const INTEL = new Map();
  const intelGet = (key, msg) => { if (!INTEL.has(key)) INTEL.set(key, chrome.runtime.sendMessage(msg).catch(() => null)); return INTEL.get(key); };
  const mvHead = (title, right, mono, logo) => `<div class="mv-head" ${i(1)}>${fox('fox lg')}<b>Fable</b><span class="k">· ${esc(title)}</span>${logo && /^https:\/\//.test(logo) ? `<img class="mv-logo" src="${esc(logo)}" alt="" referrerpolicy="no-referrer">` : ''}<span class="r ${mono ? 'mono' : ''}">${esc(right || 'fable.market')}</span></div>`;
  const mvCard = (kind, head, body, extra = '') => `<div class="expand"><div><div class="mv-card ${extra}" data-mv="${kind}">${head}<div class="mv-body">${body}</div></div></div></div>`;
  // a card's sections in the order the remote config gives (cards.<kind>.order), minus the hidden ones (cards.<kind>.hide)
  const cardBody = (kind, parts) => {
    const L = CFG.cards?.[kind] || {}, hide = new Set(Array.isArray(L.hide) ? L.hide : []);
    const order = Array.isArray(L.order) && L.order.length ? L.order.filter((k) => k in parts) : [];
    const all = [...order, ...Object.keys(parts).filter((k) => !order.includes(k))];
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
  const heatTip = (d) => `${d.date}${d.total ? `: ${(d.events || []).map((e) => e.label).slice(0, 2).join('; ')}${d.total > 2 ? ` +${d.total - 2}` : ''}` : d.posts ? `: ${d.posts} post${d.posts === 1 ? '' : 's'}` : ''}`;
  const mvHeat = (days) => {
    const list = (days || []).slice(-HEAT_ROWS * HEAT_COLS);
    const t = quart(list.filter((d) => d.coverage === 'observed').map((d) => (d.posts || 0) + (d.total || 0)));
    return `<div class="mv-heat v3 v4" style="--rows:${HEAT_ROWS};--cols:${Math.max(1, Math.ceil(list.length / HEAT_ROWS))}">${list.map((d, n) => `<i class="q-${HEAT_TONE(d, t)}" style="--c:${Math.floor(n / HEAT_ROWS)}" title="${esc(heatTip(d))}"></i>`).join('')}</div>`;
  };
  const mvSpark = (days) => {
    const pts = Array.from({length: 14}, (_, k) => days?.[new Date(Date.now() - (13 - k) * 864e5).toISOString().slice(0, 10)] || 0);
    const max = Math.max(1, ...pts);
    const d = pts.map((y, k) => `${k ? 'L' : 'M'}${2 + k * 10} ${46 - (y / max) * 40}`).join(' ');
    return `<div class="mv-spark" ${i(2)}><svg class="chart" viewBox="0 0 134 50"><path d="${d}" pathLength="1"/></svg><span>posts per day, 14 d</span></div>`;
  };
  const mvStat = (val, label, tone, n) => `<div class="stat mv-stat ${tone || ''}" ${i(3 + n)}><b>${/^\$?\d+[KMB%]?$/.test(val) ? num(val) : esc(val)}</b><span>${esc(label)}</span></div>`;
  const mvFacts = (facts, start) => (facts.length ? `<div class="mv-facts">${facts.map((f, n) => `<div class="mv-fact ${f.tone || ''}" ${i(start + n)}>${esc(f.text)}</div>`).join('')}</div>` : '');

  // Price chart, like X's own token widget: log scale (memecoins move in multiples), red when down over the span, green
  // when up, gradient fill, the line draws itself in, a live dot on the latest price. Real points only; under 3, no chart.
  let mvChartN = 0;
  const mvPrice = (v) => (v == null ? '' : v >= 1 ? `$${v.toLocaleString('en-US', {maximumFractionDigits: 2})}` : v >= 0.01 ? `$${v.toFixed(4)}` : `$${Number(v).toPrecision(3)}`);
  const mvSpan = (ms) => (ms < 3600e3 ? `${Math.max(1, Math.round(ms / 60e3))}m` : ms < 864e5 ? `${Math.round(ms / 3600e3)}h` : `${Math.round(ms / 864e5)}d`);
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
    if (rk.reasons?.some((x) => x.key === 'op')) coin.push('tied to a tracked rug operation');
    if (rk.reasons?.some((x) => x.key === 'honeypot')) coin.push('a honeypot');
    if (L?.bundled) coin.push(`bundled at launch (${Math.round(L.pct * 100)}% to ${L.buyers} wallets)`);
    else if (c.facts?.some((f) => f.k === 'launch:bundle-v1' || /bundle/i.test(f.k) && f.tone === 'bad')) coin.push('bundled at launch');
    else if (L && !L.bundled && L.pct < 0.1) coin.push('a clean launch');
    if (d?.rugged >= 2) coin.push(`from a wallet with ${d.rugged} rugs`);
    else if (d?.launched >= 10) coin.push(`from a serial launcher (${d.launched} coins)`);
    const who = [];
    if (c.history?.smartAuthors?.length) { const sa = c.history.smartAuthors; who.push(sa.length <= 2 ? `posted by smart account${sa.length === 1 ? '' : 's'} ${sa.map((x) => `@${x.handle}`).join(' and ')}` : `posted by ${sa.length} smart accounts`); }
    if (hist?.record?.bad >= 2 && hist.record.bad > (hist.record.good || 0)) who.push(`pushed by an account whose last ${hist.record.bad} calls went bad`);
    else if (hist?.record?.good >= 2 && hist.record.good > (hist.record.bad || 0)) who.push(`from an account with ${hist.record.good} calls that held up`);
    const px = sf && Math.abs(sf.change) >= 0.2 ? (sf.change >= 1 ? `now ${(sf.change + 1).toFixed(1)}x since the first call` : `${sf.change > 0 ? 'up' : 'down'} ${Math.round(Math.abs(sf.change) * 100)}% since the first call`) : null;
    const parts = [coin.length ? cap1(coin.join(', ')) : null, who.join(', ') || null, px].filter(Boolean);
    return parts.length >= 2 ? `${parts.join('; ')}.` : null;
  };
  const builderRead = (h) => {
    const bits = [h.ships?.length ? `Builds ${h.ships.slice(0, 2).join(' and ')}` : null, h.github?.total ? `${h.github.total.toLocaleString('en-US')} GitHub commits this year` : null,
      h.smart?.n ? `followed by ${h.smart.n} smart account${h.smart.n === 1 ? '' : 's'}${h.smart.topPct ? ` (top ${h.smart.topPct}%)` : ''}` : null].filter(Boolean);
    return bits.length >= 2 ? `${bits.join(', ')}.` : null;
  };
  const promoRead = (h) => {
    const measured = (h.promos || []).filter((p) => p.sinceCall != null), deep = measured.filter((p) => p.sinceCall <= -0.9).length, up = measured.filter((p) => p.sinceCall >= 0.5).length;
    if (measured.length < 2) return null;
    return `Called ${h.promosTotal} coins in 30 days: ${deep} down 90%+${up ? `, ${up} up 50%+` : ''}${h.positions?.soldAfter ? `; its wallet sold ${h.positions.soldAfter} of them after calling` : ''}.`;
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
  const STRIP_WORD = {t: 'this coin', g: 'graduated', c: 'never graduated', r: 'rugged', d: 'dead', u: 'not read yet'};
  const devSection = (d) => {
    if (!d || d.launched < 2) return '';
    const bits = [`<b class="${d.launched >= 10 ? 'red' : ''}">${num(String(d.launched))}</b> launched`, d.graduated != null && `<b class="green">${num(String(d.graduated))}</b> graduated`,
      d.rugged ? `<b class="red">${num(String(d.rugged))}</b> rugged` : d.dead >= 2 ? `<b class="red">${num(String(d.dead))}</b> dead` : d.alive ? `<b class="green">${num(String(d.alive))}</b> trading` : null].filter(Boolean);
    // the full history when the server sent it (one code per coin), else the detailed latest coins
    const full = d.strip && d.strip.length > Math.min(78, d.cells.length);
    let items;
    if (full) {
      items = [...d.strip].map((k, n) => { const x = d.cells[n]; const tone = /[1-4]/.test(k) ? `g${k}` : STRIP_TONE[k] || 'e';
        const name = x ? (x.symbol ? `$${x.symbol}` : mvShort(x.address)) : `Coin ${d.strip.length - n}`;
        return {tone, tip: `${name}: ${/[1-4]/.test(k) ? 'trading' : STRIP_WORD[k] || ''}${x?.mcap ? ` · ${mvUsd(x.mcap)}` : ''}`}; }).reverse();
    } else {
      const cells = d.cells.slice(0, 78).reverse();
      const t = quart(cells.filter((x) => (x.state === 'alive' || x.state === 'graduated') && x.mcap != null).map((x) => x.mcap));
      items = cells.map((x) => ({tone: devTone(x, t), tip: `${x.symbol ? `$${x.symbol}` : mvShort(x.address)}: ${x.state === 'curve' ? 'never graduated' : x.state === 'unread' ? 'not read yet' : x.state === 'this' ? 'this coin' : x.state}${x.mcap ? ` · ${mvUsd(x.mcap)}` : ''}`}));
    }
    const rows = items.length > 150 ? 7 : items.length > 78 ? 5 : Math.min(3, Math.max(1, Math.ceil(items.length / 26)));
    const dense = items.length > 150 ? ' dense' : items.length > 78 ? ' mid' : '';
    const some = items.length < d.launched ? `1 square = 1 coin, its last ${items.length}, oldest first` : '1 square = 1 coin it launched, oldest first';
    return `<div class="mv-sec" ${i(8)}><div class="mv-sec-h"><span class="t">${esc(CFG.copy?.sections?.launched || 'Who launched it')}${rankBadge(d.rank)}</span><span class="mono">${esc(mvShort(d.wallet))}</span></div>
      <div class="mv-sec-n">${bits.join('<i>·</i>')}</div>
      <div class="mv-heat v3 slim${dense}" style="--rows:${rows};--cols:${Math.max(1, Math.ceil(items.length / rows))}">${items.map((x, n) => `<i class="q-${x.tone}" style="--c:${Math.floor(n / rows)}" title="${esc(x.tip)}"></i>`).join('')}</div>
      <div class="mv-key dev"><span class="cap">${some}</span><span class="k"><i class="q-g1"></i><i class="q-g2"></i><i class="q-g3"></i><i class="q-g4"></i>trading, small to big</span><span class="k"><i class="q-gu"></i>graduated</span><span class="k"><i class="q-r4"></i>rugged or dead</span><span class="k"><i class="q-n"></i>never graduated</span><span class="k"><i class="q-this"></i>this coin</span></div></div>`;
  };
  // a coordinated push (src/shill.js on the server): only when the numbers prove it (level high / medium)
  const shillSection = (w) => {
    if (!w?.level) return '';
    const bits = [`<b>${num(String(w.accounts))}</b> accounts in <b>${num(String(w.windowMin))}</b> min`, w.sameText >= 2 && `<b>${num(String(w.sameText))}</b> used the same text`,
      w.sharedBefore >= 2 && `<b>${num(String(w.sharedBefore))}</b> pushed coins together before`, w.fresh >= 2 && `<b>${num(String(w.fresh))}</b> new accounts`].filter(Boolean);
    const chips = (w.handles || []).slice(0, 6).map((h, n) => `<a class="mv-chip sm ${w.level === 'high' ? 'r' : 'a'}" href="https://x.com/${esc(h)}" target="_blank" rel="noopener" ${i(9 + n * 0.2)}>@${esc(h)}</a>`).join('');
    const q = w.sample ? `<div class="mv-quote">"${esc(String(w.sample).replace(/\s+/g, ' ').slice(0, 140))}${String(w.sample).length > 140 ? '...' : ''}"</div>` : '';
    return `<div class="mv-sec mv-shill ${w.level}" ${i(8.5)}><div class="mv-sec-h"><span class="t">Pushed together<em class="mv-rk ${w.level === 'high' ? 'bad' : 'warn'}">${w.level === 'high' ? 'Shill wave' : 'Coordinated push'}</em></span></div>
      <div class="mv-sec-n">${bits.join('<i>·</i>')}</div>${chips ? `<div class="mv-chips">${chips}</div>` : ''}${q}</div>`;
  };
  // the other contracts in the same post, one line each
  const alsoSection = (list) => (list?.length ? `<div class="mv-also" ${i(10)}>${list.map((x) => {
    const sy = x.identity?.symbols?.length ? `$${x.identity.symbols[0].symbol}` : mvShort(x.identity?.address);
    const pl = x.risk?.devPill?.tone === 'rug' ? x.risk.devPill : x.risk?.pill;
    const mc = x.market?.mcap?.value;
    return `<div class="mv-also-row ${pl?.tone || ''}"><b>${esc(sy)}</b><span>${esc(pl ? `${pl.label}${pl.stat ? ` · ${pl.stat}` : ''}` : x.onchain?.isToken === false || (x.facts || []).some((f) => f.k === 'nottoken') ? 'A contract, not a token' : x.filling ? 'Reading the chain' : 'Checked')}</span><em>${esc(mc ? mvUsd(mc) : '')}</em></div>`;
  }).join('')}</div>` : '');
  const contractCard = (c, seen = new Set(), hist = null, others = []) => {
    const id = c.identity || {}, m = c.market || {}, h = c.history || {}, cn = c.connections || {}, dep = c.deployment || {};
    const sym = id.symbols?.length ? `$${id.symbols[0].symbol}` : null;
    const stats = [];
    const push = (k, v, l, t) => v && stats.push({k, v, l, t});
    const rk = c.risk;
    // card v6 (owner, $LOUIS: "kinda smushed and a lot to take in"): the risk level lives in the pill and the headline,
    // not again as a stat; the numbers row carries what the headline does not say
    const alertOn = !!rk?.alert;
    const L = c.onchain?.launch;
    if (!alertOn && L && L.pct >= 0.1 && L.buyers >= 2) push('bundle', `${Math.round(L.pct * 100)}%`, `bundled by ${L.buyers} wallets`, '');
    if (m.mcap) push('mcap', mvUsd(m.mcap.value), m.mcap.source === 'supply x price' && (c.matchedBy?.alternatives?.length || id.chains?.length > 1) ? 'supply x price on this chain' : 'market cap', '');
    else if (m.price) push('price', m.price.value >= 0.01 ? `$${m.price.value.toFixed(2)}` : `$${Number(m.price.value).toPrecision(2)}`, 'price', '');
    if (m.liquidity) push('liq', mvUsd(m.liquidity.value), 'liquidity', m.liquidity.value < 10000 ? 'red' : '');
    const sf = h.calls?.sinceFirst;
    if (sf && Math.abs(sf.change) >= 0.05 && sf.change <= 49) push('since', sf.change >= 1 ? `${(sf.change + 1).toFixed(1)}x` : `${sf.change > 0 ? '+' : '−'}${Math.round(Math.abs(sf.change) * 100)}%`, 'since first call', sf.change <= -0.5 ? 'red' : sf.change >= 0.5 ? 'green' : '');
    if (!alertOn && rk && rk.level !== 'unknown' && stats.length < 3) push('risk', rk.level === 'high' ? 'HIGH' : rk.level === 'medium' ? 'MED' : 'LOW', 'risk', rk.level === 'high' ? 'red' : rk.level === 'low' ? 'green' : 'amber');
    if (m.holders?.top10WalletPct != null && m.holders.known) push('top10', `${Math.round(m.holders.top10WalletPct * 100)}%`, 'held by top 10 wallets', m.holders.top10WalletPct >= 0.3 ? 'red' : 'green');
    if (cn.creatorLaunches?.total > 1 && !c.devHistory) push('creator', String(cn.creatorLaunches.total), 'coins by its creator', cn.creatorLaunches.total >= 10 ? 'red' : '');
    if (cn.deployerTokens?.total > 1) push('deployer', String(cn.deployerTokens.total), `tokens by deployer${cn.deployerTokens.rugged ? `, ${cn.deployerTokens.rugged} rugged` : ''}`, cn.deployerTokens.rugged ? 'red' : '');
    if (dep.launchedAt) push('age', cxAgo(dep.launchedAt).replace(' ago', ''), 'old', '');
    if (h.smartAuthors?.length) push('smart', String(h.smartAuthors.length), 'smart accounts posted it', 'green');
    if (h.authors) push('authors', String(h.authors), `account${h.authors === 1 ? '' : 's'} posting it`, '');
    const nMax = CFG.limits?.stats ?? 4;
    const shown = new Set(stats.slice(0, nMax).map((x) => x.k));
    const chartOn = !!(globalThis.FableChart && (m.price || m.series));
    // a fact the headline, the numbers row or the chart already shows is not said again below them
    const skip = new Set(['liq', 'launch', 'creator', 'deployer', 'posts', 'smart', 'mcap', ...(shown.has('top10') ? ['holders'] : []), ...(shown.has('since') ? ['calls'] : []),
      ...(chartOn ? ['trades'] : []), ...(alertOn ? ['solbundle'] : [])]);
    let facts = (c.facts || []).filter((f) => !skip.has(f.k) && !(alertOn && /^launch:bundle/.test(f.k))).slice(0, 5);
    const reading = !!c.filling;
    const title = `Launch check${sym ? ` · ${sym}` : ''}${id.name && sym && id.name.toUpperCase() !== sym.slice(1) ? ` · ${id.name}` : ''}`;
    const fresh = (k) => (seen.size && !seen.has(k) ? ' mv-new' : '');
    const statHtml = stats.slice(0, nMax).map((x, n) => `<div class="stat mv-stat ${x.t}${fresh(`s:${x.k}`)}" data-k="${x.k}" ${i(3 + n)}><b>${/^\$?\d+[KMB%]?$/.test(x.v) ? num(x.v) : esc(x.v)}</b><span>${esc(x.l)}</span></div>`).join('');
    if (c.matchedBy?.ticker) facts.unshift({k: 'ticker', tone: '', text: `Matched by the $${c.matchedBy.ticker} ticker${c.matchedBy.alternatives?.length ? `; ${c.matchedBy.alternatives.length} other coin${c.matchedBy.alternatives.length === 1 ? ' uses' : 's use'} it` : ''}`});
    // one headline: the hardest fact, said once in full. The other red facts become lines below (none dropped).
    if (c.connections?.shillWave?.level) facts = facts.filter((f) => f.k !== 'shill');
    // with a red alert the headline is its hardest fact; without one, the strongest high-risk fact (amber); the one-line
    // read only when neither exists
    const hard = alertOn ? rk.reasons.filter((x) => x.w === 'severe' || x.w === 'high') : (rk?.reasons || []).filter((x) => x.w === 'high');
    const lead = hard[0] || null;
    if (lead) {
      const said = new Set([lead.text]);
      facts = facts.filter((f) => !said.has(f.text));
      const more = hard.slice(1).filter((x) => !facts.some((f) => f.text === x.text)).map((x) => ({k: `risk:${x.key}`, tone: 'bad', text: x.text}));
      facts = [...more, ...facts];
    }
    facts = facts.slice(0, CFG.limits?.facts ?? 3);
    const factHtml = facts.map((f, n) => `<div class="mv-fact ${f.tone || ''}${fresh(`f:${f.k}`)}" ${i(6 + n)}><i>${MARK[f.tone || '']}</i>${esc(f.text)}</div>`).join('');
    const readingHtml = reading ? `<div class="mv-reading" ${i(6 + facts.length)}><span class="th-spin"></span>Reading the chain: supply, holders, launch, liquidity, price</div>` : '';
    const onchain = c.onchain?.at ? `on-chain ${cxAgo(c.onchain.at)}` : '';
    const dossier = id.address ? `<a class="mv-dossier" href="https://intel.fable.market/c/${encodeURIComponent(id.address)}?chain=${encodeURIComponent(id.chains?.[0] || '')}" target="_blank" rel="noopener">Dossier</a>` : '';
    const foot = `<div class="mv-foot" ${i(12)}><span>${h.firstCaptured ? `First seen ${esc(cxAgo(h.firstCaptured.at))} by @${esc(h.firstCaptured.handle)}` : 'First time Fable sees it'}</span><span>${esc(onchain)}${dossier}</span></div>`;
    const keys = [...stats.slice(0, nMax).map((x) => `s:${x.k}`), ...facts.map((f) => `f:${f.k}`)];
    const chart = chartOn ? `<div class="mv-fc" ${i(2)}></div>` : mvChart(m.series, m.price?.value);
    // the headline: a red fact when there is one (tagged with what it is), else the one-sentence read of the coin
    const TAG = CFG.copy?.tags || {};
    const headline = lead ? `<div class="mv-alert mv-hl6${alertOn ? '' : ' amber'}" ${i(1)}><b>${esc(TAG[lead.key] || (alertOn ? rk.alertTitle : 'RISK') || 'HIGH RISK')}</b><span>${esc(lead.text)}</span></div>`
      : readHtml(contractRead(c, hist, {noPrice: shown.has('since'), noLauncher: (c.devHistory?.launched || 0) >= 2, noCaller: !!hist?.days}));
    const nStats = Math.min(nMax, stats.length);
    return {keys, html: mvCard('contract', mvHead(sym ? `${sym}${id.name && id.name.toUpperCase() !== sym.slice(1) ? ` · ${id.name}` : ''}` : 'Launch check', mvShort(id.address), true, id.image),
      cardBody('contract', {headline, chart, stats: statHtml ? `<div class="mv-stats n${nStats}">${statHtml}</div>` : '', facts: factHtml || readingHtml ? `<div class="mv-facts">${factHtml}${readingHtml}</div>` : '',
        shill: shillSection(c.connections?.shillWave), also: alsoSection(others), dev: devSection(c.devHistory), track: trackSection(hist), foot}), alertOn ? 'alert' : '')};
  };

  // a referral / invite link in the post itself (the video's "Referral link detected in post")
  const REF = /[?&](ref|referral|refcode|invite|invitecode|code|affiliate|aff|via)=[^&\s]+|\/(ref|r|invite|referral|join)\/[A-Za-z0-9_-]{3,}|t\.me\/[A-Za-z0-9_]+bot\?start=|@[A-Za-z0-9_]+\?ref/i;
  const refLinkIn = (tw) => [...(tw?.urls || []), tw?.text || ''].some((u) => REF.test(String(u)));
  const promoCard = (h, refLink = false) => {
    const tiles = h.promos.slice(0, 9);
    const measured = h.promos.filter((p) => p.sinceCall != null);
    const deep = measured.filter((p) => p.sinceCall <= -0.9).length;
    const tile = (p, n) => {
      const x = p.sinceCall ?? p.fromPeak;
      const cls = x == null ? 'pend' : x < 0 ? 'down' : 'up';
      const res = x == null ? (p.mcap ? mvUsd(p.mcap) : p.chain === 'solana' ? 'SOL' : p.chain ? p.chain.slice(0, 4).toUpperCase() : '·') : `${x < 0 ? '✕' : '✓'} ${mvPct(x)}${p.sinceCall == null ? ' pk' : ''}`;
      return `<a class="mv-tile ${cls}" href="${esc(p.url || '#')}" target="_blank" rel="noopener" ${i(2 + n * 0.8)}>${p.image && /^https:\/\//.test(p.image) ? `<img class="tl" src="${esc(p.image)}" alt="" referrerpolicy="no-referrer">` : `<span class="tl ph">${esc((p.symbol || '?').slice(0, 1))}</span>`}<b>${esc(p.symbol ? `$${p.symbol}` : mvShort(p.address))}</b>${p.bundled ? '<em class="bd">B</em>' : ''}<span class="res">${esc(res)}</span></a>`;
    };
    const left = measured.length ? `<b class="${deep / measured.length >= 0.5 ? 'red' : ''}">${deep} of ${measured.length} called coins down 90%+</b>` : `<b>${h.promosTotal} coins called in 30 days</b>`;
    return mvCard('promo', mvHead('Promotion history · last 30 days'),
      `${readHtml(promoRead(h))}<div class="mv-tiles">${tiles.map(tile).join('')}</div>${mvHeat(h.days).replace('mv-heat v3', 'mv-heat v3 slim')}<div class="mv-foot" ${i(10)}>${left}<span>${refLink ? 'Referral link in post' : `${h.promosTotal} coin${h.promosTotal === 1 ? '' : 's'} called${tiles.some((p) => p.sinceCall == null && p.fromPeak != null) ? ' · pk = from peak' : ''}`}</span></div>`);
  };

  // Track record: the video's builder grid, coloured by what happened after each day's posts
  const recordLine = (h) => {
    const r = h.record || {};
    const bits = [r.builds && `${r.builds} build post${r.builds === 1 ? '' : 's'}`, r.good && `${r.good} call${r.good === 1 ? '' : 's'} held up`, r.bad && `${r.bad} went bad`].filter(Boolean);
    return bits.join(' · ') || `Seen on ${h.coverage.observedDays} days`;
  };
  const GH_LEGEND = `<span class="gh-leg"><span class="ramp"><i class="q-g1"></i><i class="q-g2"></i><i class="q-g3"></i><i class="q-g4"></i></span>more active<i class="q-r4"></i>went bad</span>`;
  const recordChips = (h, start = 9) => {
    const r = h.record || {}, obs = h.coverage?.observedDays || 0;
    const chips = [r.builds && ['g', `✓ ${r.builds} build post${r.builds === 1 ? '' : 's'}`], r.good && ['g', `✓ ${r.good} call${r.good === 1 ? '' : 's'} held up`],
      r.bad && ['r', `✕ ${r.bad} went bad`], h.caHistory?.total >= 2 && [h.caHistory.dead >= 2 ? 'r' : 'n', `${h.caHistory.total} contracts posted`], obs && ['n', `${obs} active day${obs === 1 ? '' : 's'}`]].filter(Boolean).slice(0, 4);
    const yrs = h.profile?.yearsOnX;
    return `<div class="mv-chips">${chips.map(([tone, text], n) => `<span class="mv-chip ${tone}" ${i(start + n * 0.4)}>${esc(text)}</span>`).join('')}${yrs ? `<span class="mv-aside" ${i(start + 1)}>${yrs} yr${yrs === 1 ? '' : 's'} on X</span>` : ''}</div>`;
  };
  const trackLine = (h) => {
    const r = h.record || {}, obs = h.coverage?.observedDays || 0;
    return [r.good && `<b class="green">${r.good}</b> call${r.good === 1 ? '' : 's'} held up`, r.bad && `<b class="red">${r.bad}</b> call${r.bad === 1 ? '' : 's'} went bad`, r.builds && `<b class="green">${r.builds}</b> build posts`,
      h.caHistory?.total >= 2 && `<b>${h.caHistory.total}</b> contracts posted`, obs && `seen on <b>${obs}</b> day${obs === 1 ? '' : 's'}`].filter(Boolean).slice(0, 3).join('<i>·</i>');
  };
  const trackSection = (h) => {
    if (!h?.days) return '';
    // the count line already says how many contracts; a bare "Posted N contracts" fact would repeat it
    const f = authorFacts(h).find((x) => !(x.k === 'cas' && !x.text.includes(':')));
    const line = trackLine(h);
    if (!line && !f) return '';
    return `<div class="mv-sec" ${i(9)}><div class="mv-sec-h"><span class="t">${esc(CFG.copy?.sections?.posted || 'Who posted it')}: <a class="mv-hl" href="https://intel.fable.market/a/${encodeURIComponent(h.handle)}" target="_blank" rel="noopener">@${esc(h.handle)}</a>${rankBadge(h.rank)}</span>${h.profile?.yearsOnX ? `<span class="mono">${h.profile.yearsOnX}y on X</span>` : ''}</div>
      ${line ? `<div class="mv-sec-n">${line}</div>` : ''}${f ? `<div class="mv-fact sm ${f.tone}" ${i(9.5)}><i>${MARK[f.tone || '']}</i>${esc(f.text)}</div>` : ''}</div>`;
  };
  // builder grid from GitHub: one square per week (about 2.5 years), shaded by the builder's own busy / quiet weeks
  const ghHeat = (gh) => {
    const weeks = (gh?.weeks || []).slice(-HEAT_ROWS * HEAT_COLS);
    const t = quart(weeks.map((w) => w.count));
    return `<div class="mv-heat v3 v4" style="--rows:${HEAT_ROWS};--cols:${Math.max(1, Math.ceil(weeks.length / HEAT_ROWS))}">${weeks.map((w, n) => { const lv = lvOf(w.count, t); return `<i class="q-${lv ? `g${lv}` : 'e'}" style="--c:${Math.floor(n / HEAT_ROWS)}" title="Week of ${esc(w.start)}: ${w.count} contribution${w.count === 1 ? '' : 's'}"></i>`; }).join('')}</div>`;
  };
  const ghActive = (gh) => (gh.weeks || []).slice(-HEAT_ROWS * HEAT_COLS).filter((w) => w.count > 0).length;
  const ghKey = `<div class="mv-key gh" ${i(8)}><span>1 square = 1 week on GitHub</span><span class="scale">Less<i class="q-e"></i><i class="q-g1"></i><i class="q-g2"></i><i class="q-g3"></i><i class="q-g4"></i>More</span></div>`;
  const builderCard = (h) => {
    const named = (h.ships || []).slice(0, 4).map((x, n) => `<span class="mv-chip" ${i(2 + n)}>✓ ${esc(x)}</span>`).join('');
    const chips = named || (h.builds || []).slice(0, 4).map((b, n) => `<a class="mv-chip" href="${esc(b.url)}" target="_blank" rel="noopener" ${i(2 + n)}>✓ ${esc(b.name)}</a>`).join('');
    const days = h.counts?.building || 0;
    return mvCard('builder', mvHead('Builder history'),
      `${readHtml(builderRead(h))}<div class="mv-chips">${chips}<span class="mv-aside" ${i(3)}>${h.github?.total ? `${builderRead(h) && h.github.weeks?.length ? `active ${ghActive(h.github)} of ${Math.min(h.github.weeks.length, HEAT_ROWS * HEAT_COLS)} weeks` : `${h.github.total.toLocaleString('en-US')} commits this year`}${h.github.firstActive ? ` · since ${h.github.firstActive.slice(0, 4)}` : ''}` : `${h.profile?.yearsOnX ? `${h.profile.yearsOnX} yrs on X · ` : ''}${days} build day${days === 1 ? '' : 's'}`}</span></div>${h.github?.weeks?.length ? `${ghHeat(h.github)}${ghKey}` : mvHeat(h.days)}${h.smart?.n ? `<div class="mv-foot" ${i(10)}><span class="mv-mini">${(h.smart.people || []).slice(0, 3).map((p) => av(p.avatar, 'face')).join('')}Followed by ${h.smart.n} smart account${h.smart.n === 1 ? '' : 's'}</span><span></span></div>` : ''}`);
  };

  const activityCard = (h) => mvCard('activity', mvHead('Track record'), `${recordChips(h, 2)}${authorFactsHtml(h, 3)}${mvHeat(h.days)}`);

  const smartCard = (row, ships = []) => {
    const people = (row.all || row.people || []).slice(0, 3);
    const shipChips = ships?.length ? `<div class="mv-chips" style="margin-bottom:6px">${ships.slice(0, 4).map((x, n) => `<span class="mv-chip" ${i(1.5 + n * 0.3)}>✓ ${esc(x)}</span>`).join('')}</div>` : '';
    const just = row.recent?.length ? `<div class="mv-just" ${i(2)}><span class="pile">${row.recent.slice(0, 3).map((p) => av(p.avatar, 'face')).join('')}</span>Just followed by ${esc(handleList(row.recent))}</div>` : '';
    const overlap = row.topPct ? `<div class="mv-overlap" ${i(6)}><span>OVERLAP</span><span class="track"><span class="fill" style="--w:${Math.max(8, 100 - row.topPct)}%"></span></span><b>Top ${row.topPct}% of accounts Fable tracks</b></div>` : '';
    return mvCard('smart', mvHead(`Followed by ${row.n || people.length} smart account${(row.n || people.length) === 1 ? '' : 's'}`),
      shipChips + just + people.map((p, n) => `<a class="mv-person" href="https://x.com/${esc(p.handle)}" target="_blank" rel="noopener" ${i(2 + n)}>${av(p.avatar, 'pav')}<b>${esc(p.name || p.handle)}</b>${p.verified ? '<svg class="vbadge" viewBox="0 0 22 22" aria-label="Verified"><path d="M20.4 11c0-1.4-.8-2.6-2-3.2.4-1.3.1-2.8-.9-3.8s-2.5-1.3-3.8-.9C13.1 1.9 11.9 1.1 10.5 1.1S7.9 1.9 7.3 3.1c-1.3-.4-2.8-.1-3.8.9s-1.3 2.5-.9 3.8C1.4 8.4.6 9.6.6 11s.8 2.6 2 3.2c-.4 1.3-.1 2.8.9 3.8s2.5 1.3 3.8.9c.6 1.2 1.8 2 3.2 2s2.6-.8 3.2-2c1.3.4 2.8.1 3.8-.9s1.3-2.5.9-3.8c1.2-.6 2-1.8 2-3.2Z" fill="#1d9bf0"/><path d="m9.4 14.6-3.3-3.3 1.4-1.4 1.9 1.9 5-5 1.4 1.4-6.4 6.4Z" fill="#fff"/></svg>' : ''}<span>@${esc(p.handle)}</span>${(p.tag || p.category) && !/^(other|smart)$/i.test(p.tag || p.category) ? `<em class="mv-tag">${esc(p.tag || p.category)}</em>` : ''}</a>`).join('')
      + overlap + ((row.n || 0) > people.length ? `<div class="mv-foot" ${i(7)}><span>and ${row.n - people.length} more smart account${row.n - people.length === 1 ? '' : 's'}</span><span></span></div>` : ''));
  };

  // one activity clock for the page: live charts only stream while the viewer is actually scrolling or moving
  let lastActive = Date.now();
  for (const ev of ['scroll', 'wheel', 'mousemove', 'keydown', 'touchstart']) window.addEventListener(ev, () => { lastActive = Date.now(); }, {passive: true, capture: true});
  // candles are asked for the moment a contract is seen (in parallel with the card's own data), so the chart paints
  // with the card; the server picks the candle size from the coin's age ('auto': 15 s for a fresh launch)
  // one candles read per coin and timeframe for 8 s: the prefetch and the card's chart share it
  const CANDLES = new Map();
  const candlesFor = (address, chain, tf = 'auto') => {
    const k = `${chain || ''}:${address}:${tf}`, hit = CANDLES.get(k);
    if (hit && performance.now() - hit.at < (CFG.timing?.candlesCacheMs ?? 8000)) return hit.p;
    const p = chrome.runtime.sendMessage({type: 'candles', address, chain, tf}).catch(() => null);
    CANDLES.set(k, {at: performance.now(), p});
    if (CANDLES.size > 200) CANDLES.delete(CANDLES.keys().next().value);
    return p;
  };
  const chartFor = (root, c, tweetTime, first = null) => {
    const st = {api: null, data: null, tf: 'auto', port: null, visible: false};
    const address = c.identity?.address, chain = c.identity?.chains?.[0] || c.identity?.chainBasis || null;
    // the card's market cap follows the chart it sits under: last trade x supply, the number the chart's MC axis shows
    // (the card said $12K under a live chart at $10.9K: the median of 7 prints vs the last one)
    const born = performance.now();
    const setCap = (p) => {
      const sup = st.data?.supply, b = root.querySelector('.mv-stat[data-k="mcap"] b');
      if (!b || !(p > 0) || !(sup > 0)) return;
      const v = mvUsd(p * sup);
      const apply = () => { if (b.textContent !== v) b.textContent = v; };
      const wait = 900 - (performance.now() - born); // after the count-up animation
      if (wait > 0) setTimeout(apply, wait); else apply();
    };
    const load = async (pre = null) => {
      const d = await (pre || candlesFor(address, chain, st.tf));
      if (d?.tf) st.tf = d.tf;
      // a chart as soon as there is anything to draw, or a live coin still waiting for its first trade
      if (d?.candles?.length >= 2 || (d?.live && (d.candles?.length || 0) < 2 && d.stored != null)) { st.data = d; st.api?.setData(d); root.querySelector('.mv-fc')?.classList.remove('empty'); const last = d.candles?.[d.candles.length - 1]; if (last) setCap(last[4]); }
      else root.querySelector('.mv-fc')?.classList.add('empty');
    };
    const mount = () => {
      const el = root.querySelector('.mv-fc');
      if (!el || !globalThis.FableChart) return;
      st.api?.destroy();
      st.api = FableChart.mount(el, {tf: st.tf, postTime: tweetTime, onTf: (tf) => { st.tf = tf; load(); }});
      if (st.data) st.api.setData(st.data); else { load(first); first = null; }
      if (st.port) st.api.setLive(true);
    };
    const hostEl = root.host;
    const sync = () => {
      const want = st.visible && document.visibilityState === 'visible' && Date.now() - lastActive < (CFG.timing?.liveIdleMs ?? 60e3) && hostEl.isConnected && on('liveCharts');
      if (want && !st.port) {
        st.port = chrome.runtime.connect({name: 'live'});
        st.port.postMessage({address, chain});
        st.port.onMessage.addListener((msg) => { if (msg.type === 'status') st.api?.setLive(!!msg.live); else if (msg.p) { st.api?.push(msg); setCap(msg.p); } });
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
    s.className = 'fable-stamp-host';
    article.appendChild(s);
    const place = () => { const a = article.getBoundingClientRect(), r = target.getBoundingClientRect(); s.style.left = `${r.left - a.left + r.width / 2}px`; s.style.top = `${r.top - a.top + r.height / 2}px`; s.style.setProperty('--k', r.height < 60 ? '0.6' : r.height < 140 ? '0.78' : '1'); };
    place();
    requestAnimationFrame(place);
    new ResizeObserver(place).observe(article);
    mountShadow(s, `<div class="stamp ink"><span>${esc(text)}</span><em>${fox('fox')}FABLE</em></div>`, t, played);
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
  const handleList = (xs) => xs.slice(0, 2).map((x) => `@${x.handle}`).join(' and ') + (xs.length > 2 ? ` +${xs.length - 2}` : '');
  // Frontrun's profile signals, as plain facts: just followed by smart accounts, past handles, every contract posted
  // rank badges (src/rank.js on the server): the tier in plain words when the numbers earn one, else the plain position
  const rankTone = (tier) => (/^Top/.test(tier || '') ? 'good' : /^(Bottom|Serial|Push)/.test(tier || '') ? 'bad' : '');
  // only a tier the numbers earn is shown; a bare position means little without its reasons
  const rankBadge = (r) => (r?.tier ? `<em class="mv-rk ${rankTone(r.tier)}" title="${esc(r.rank ? `#${r.rank} of ${r.of}` : r.ring || '')}">${esc(r.tier)}</em>` : '');
  const pctTxt = (x) => `${Math.round((x || 0) * 100)}%`;
  const authorFacts = (h) => {
    const out = [];
    if (!h) return out;
    const rk = h.rank;
    if (rk?.n >= 3) out.push({k: 'rank', tone: rankTone(rk.tier) === 'good' ? 'good' : rankTone(rk.tier) === 'bad' ? 'bad' : '',
      text: `${rk.hits} of ${rk.n} measured calls hit 2x${rk.rugs ? `, ${rk.rugs} went -90% or rugged` : ''}${rk.medNow != null ? `, median call now ${rk.medNow >= 0 ? '+' : ''}${Math.round(rk.medNow * 100)}%` : ''}`});
    if (h.ring?.text) out.push({k: 'ring', tone: 'bad', text: h.ring.text});
    if (h.smart?.recent?.length) out.push({k: 'recent', tone: 'good', text: `Just followed by ${handleList(h.smart.recent)}`});
    if (h.previous?.length) out.push({k: 'renamed', tone: 'warn', text: `Used ${h.previous.length} other handle${h.previous.length === 1 ? '' : 's'}: ${h.previous.slice(0, 3).map((x) => `@${x.handle}`).join(', ')}`});
    const w = (h.wallets || []).find((x) => x.kind === 'wallet') || (h.wallets || []).find((x) => x.kind === 'name');
    const coin = (h.wallets || []).find((x) => x.kind === 'coin');
    if (coin) out.push({k: 'pushes', tone: 'warn', text: `Pushes ${coin.symbol ? `$${coin.symbol}` : mvShort(coin.address)} in its ${coin.source === 'bio' ? 'bio' : 'posts'}`});
    if (h.positions?.called) {
      const p = h.positions;
      out.push({k: 'pnl', tone: p.soldAfter ? 'bad' : p.held ? 'good' : '', text: p.soldAfter ? `Its wallet sold ${p.soldAfter} of the ${p.called} coins it called, after calling them` : p.held ? `Its wallet holds ${p.held} of the ${p.called} coins it called` : `Its wallet never held the ${p.called} coins it called`});
    } else if (w) out.push({k: 'wallet', tone: '', text: `${w.kind === 'name' ? w.address : `Wallet ${mvShort(w.address)}`} in its ${w.source === 'bio' ? 'bio' : 'posts'}`});
    const ca = h.caHistory;
    if (ca?.total >= 2) {
      const bits = [ca.dead && `${ca.dead} dead`, ca.bundled && `${ca.bundled} bundled`, ca.deleted && `${ca.deleted} posts deleted`].filter(Boolean);
      out.push({k: 'cas', tone: ca.read >= 3 && ca.dead / ca.read >= 0.5 ? 'bad' : '', text: `Posted ${ca.total} contracts${bits.length ? `: ${bits.join(', ')}` : ''}`});
    }
    return out;
  };
  const authorFactsHtml = (h, start = 8) => { const f = authorFacts(h); return f.length ? `<div class="mv-facts mv-author">${f.map((x, n) => `<div class="mv-fact ${x.tone}" ${i(start + n)}><i>${MARK[x.tone || '']}</i>${esc(x.text)}</div>`).join('')}</div>` : ''; };
  // pill from the author's server record: the video's "Smart followers [faces] 8" when the post had nothing louder
  const pillFromAuthor = (article, v, h) => {
    const ctx = article.querySelector('[data-fable-host="ui"]')?.shadowRoot?.querySelector('.ctx');
    const sm = h?.smart?.n || 0;
    if (!ctx || sm < 3 || !['neutral', 'legit'].includes(v.tone) || ctx.dataset.chain) return;
    const faces = (h.smart.people || []).map((p) => p.avatar).filter(Boolean).slice(0, 3);
    const lbl = v.tone === 'legit' ? esc(v.label) : 'Smart followers';
    ctx.classList.remove('neutral', 'kol', 'rug');
    ctx.classList.add('legit', 'pill-new');
    ctx.innerHTML = `${fox()}<span class="verdict">${lbl}</span><span class="mid">·</span>${faces.length ? `<span class="pile">${faces.map((a) => av(a, 'face')).join('')}</span>` : ''}<span class="detail">${v.tone === 'legit' && v.label !== 'Smart followers' ? `${sm} smart followers` : sm}</span>`;
  };
  const mountIntel = async (article, after, v, t, played) => {
    const tw = TWEETS.get(v.id);
    const handle = tw?.author?.handle || article.querySelector('[data-testid="User-Name"] a[href^="/"]')?.getAttribute('href')?.slice(1);
    // every contract address in the post (up to 3): the first gets the full card, the rest a line each
    const cas = (globalThis.FableCapture?.extractAddresses?.(tw?.text || '', tw?.urls || []) || []).slice(0, CFG.limits?.contractsPerPost ?? 3);
    // no contract in the post: its first non-major $TICKER, matched server-side to the contract Fable has seen most
    const tick = !cas.length ? (tw?.cashtags || []).map((x) => String(x).toUpperCase()).find((x) => !MAJORS.has(x)) : null;
    if (!handle && !cas.length && !tick) return;
    const list = cas.length ? cas : tick ? [{ticker: tick, chain: globalThis.FableCapture?.chainHintFromText?.(tw?.text || '') || null}] : [];
    const cmsg = (ca, fresh) => ({...(ca.ticker ? {type: 'contract', symbol: ca.ticker} : {type: 'contract', address: ca.address}), chain: ca.chain, fresh, tweet: v.id});
    const ckey = (ca) => (ca.ticker ? `t:${ca.ticker}:${ca.chain || ''}` : `c:${ca.chain}:${ca.address}`);
    const getC = (ca, fresh) => (fresh ? chrome.runtime.sendMessage(cmsg(ca, true)).catch(() => null) : intelGet(ckey(ca), cmsg(ca, false)));
    const ca = list[0] || null;
    const firstCandles = ca?.address ? candlesFor(ca.address, ca.chain) : null;
    const hP = handle ? intelGet(`h:${handle.toLowerCase()}`, {type: 'history', handle}) : Promise.resolve(null);
    let [c, ...rest] = await Promise.all([ca ? getC(ca, false) : null, ...list.slice(1).map((x) => getC(x, false))]);
    // a coin card does not wait on the poster's history (up to 5 s cold): it gets 0.6 s, then the card draws without it
    // and "Who posted it" slides in when it lands
    const coinOk = !!(c && !c.error);
    let h = coinOk ? await Promise.race([hP, new Promise((r) => setTimeout(() => r(undefined), CFG.timing?.historyWaitMs ?? 300))]) : await hP;
    const lateHist = h === undefined;
    if (lateHist) h = null;
    if (!after.isConnected || article.getAttribute('data-fable-done') !== v.id || article.querySelector('[data-fable-host="intel"]')) return;
    let hist = h && !h.error && h.days ? h : null;
    // lead with the coin: when the first address is a plain contract (a pool, a curve, a router) and another is a token
    const notToken = (x) => x && !x.error && (x.onchain?.isToken === false || (x.facts || []).some((f) => f.k === 'nottoken'));
    const lead = (first, more) => { if (notToken(first)) { const k = more.findIndex((x) => x && !x.error && !notToken(x) && x.identity?.symbols?.length); if (k >= 0) { const m = [...more]; [first, m[k]] = [m[k], first]; return [first, m, true]; } } return [first, more, false]; };
    let swapped;
    [c, rest, swapped] = lead(c, rest);
    let others = rest.filter((x) => x && !x.error);
    const smartRow = (v.card?.rows || []).find((r) => r && r.kind === 'smart' && (r.people?.length || r.all?.length));
    const sm = hist?.smart?.n || 0;
    let html = '', keys = [];
    if (c && !c.error && kindOn('contract')) ({html, keys} = contractCard(c, new Set(), hist, others));
    else if (hist?.promosTotal >= 2 && kindOn('promo')) html = promoCard(hist, refLinkIn(tw));
    // builder card when the grid can be as full as the video's: a proven GitHub, or real build history on X
    else if (kindOn('builder') && hist && (hist.github?.weeks?.length || ((hist.counts?.building || hist.builds?.length || hist.ships?.length) && (hist.coverage?.observedDays || 0) >= 15))) html = builderCard(hist);
    else if (kindOn('smart') && sm >= 2) html = smartCard(hist.smart, hist.ships);
    else if (kindOn('smart') && smartRow) html = smartCard(smartRow);
    else if (kindOn('activity') && (hist?.coverage?.observedDays >= 3 || hist?.promosTotal)) html = activityCard(hist);
    if (hist) pillFromAuthor(article, v, hist);
    // a ranked caller on a post with nothing louder: the tier and its numbers on the pill
    if (hist?.rank?.tier && /caller/.test(hist.rank.tier)) {
      const ctx = article.querySelector('[data-fable-host="ui"]')?.shadowRoot?.querySelector('.ctx');
      if (ctx && !ctx.dataset.chain && (v.tone === 'neutral' || /^no flags$/i.test(v.label || ''))) {
        const r = hist.rank, tone = rankTone(r.tier) === 'bad' ? 'rug' : 'legit';
        ctx.classList.remove('neutral', 'legit', 'kol', 'rug'); ctx.classList.add(tone, 'pill-new'); ctx.dataset.rank = '1';
        ctx.innerHTML = `${fox()}<span class="verdict">${esc(r.tier)}</span><span class="mid">·</span><span class="detail">${esc(tone === 'rug' ? `${r.rugs} of ${r.n} calls -90%` : `${r.hits} of ${r.n} calls hit 2x`)}</span>`;
      }
    }
    const pillFromCard = (kind) => {
      const ctx = article.querySelector('[data-fable-host="ui"]')?.shadowRoot?.querySelector('.ctx');
      if (!ctx || ctx.dataset.chain || ctx.dataset.rank || !(v.tone === 'neutral' || /^no flags$/i.test(v.label || ''))) return;
      const measured = (hist?.promos || []).filter((p) => p.sinceCall != null), deep = measured.filter((p) => p.sinceCall <= -0.9).length;
      const pl = kind === 'promo' ? (measured.length >= 3 && deep / measured.length >= 0.5 ? {label: 'Bad caller', stat: `${deep}/${measured.length} down 90%+`, tone: 'rug'} : {label: 'Caller', stat: `${hist.promosTotal} coins in 30 d`, tone: 'kol'})
        : kind === 'builder' ? {label: 'Builder', stat: hist.github?.total ? `${hist.github.total.toLocaleString('en-US')} commits this year` : hist.ships?.[0] || `${hist.builds?.length || hist.counts?.building || 0} shipped`, tone: 'legit'}
        : kind === 'activity' ? {label: 'Track record', stat: `${hist.coverage?.observedDays || 0} active days`, tone: (hist.record?.bad || 0) > (hist.record?.good || 0) ? 'kol' : 'neutral'} : null;
      if (!pl) return;
      ctx.classList.remove('neutral', 'legit', 'kol', 'rug');
      ctx.classList.add(pl.tone, 'pill-new');
      ctx.innerHTML = `${fox()}<span class="verdict">${esc(pl.label)}</span><span class="mid">·</span><span class="detail">${esc(pl.stat)}</span>`;
    };
    // the why line: the hardest fact we hold for this post
    const whyFrom = (cc) => {
      const r = cc?.risk?.reasons?.find((x) => x.w === 'severe') || cc?.risk?.reasons?.find((x) => x.w === 'high');
      if (r) return [r.text, 'bad'];
      const d = cc?.devHistory;
      if (d?.launched >= 3) return [`Its creator launched ${d.launched} coins${d.rugged ? `, ${d.rugged} rugged` : d.graduated != null ? `, ${d.graduated} graduated` : ''}`, d.rugged ? 'bad' : ''];
      const f = (cc?.facts || []).find((x) => x.tone === 'bad') || (cc?.facts || []).find((x) => x.k === 'calls') || (cc?.facts || []).find((x) => x.tone === 'good');
      if (f) return [f.text, f.tone];
      const a = authorFacts(hist)[0];
      return a ? [a.text, a.tone] : [null];
    };
    if (!html) { const a = authorFacts(hist)[0]; if (a) setWhy(article, a.text, a.tone); return; }
    article.querySelector('[data-fable-host="ui"]')?.shadowRoot?.querySelector('.why')?.remove();
    const host = document.createElement('div');
    host.setAttribute('data-fable-host', 'intel');
    after.insertAdjacentElement('afterend', host);
    const root = mountShadow(host, html, t, played);
    pillFromCard(root.querySelector('.mv-card')?.dataset.mv);
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
    const pillFromChain = (cc) => {
      const ctx = article.querySelector('[data-fable-host="ui"]')?.shadowRoot?.querySelector('.ctx');
      // the loudest hard fact wins the pill: a proven severe risk, then a rugging / serial deployer, then the risk level
      const rk = cc.risk || {};
      let pl = rk.level === 'high' ? rk.pill : rk.devPill && (rk.devPill.tone === 'rug' || rk.level !== 'high') ? rk.devPill : rk.pill;
      const wave = cc.connections?.shillWave;
      if (wave?.level === 'high' && !rk.alert && (!pl || pl.tone !== 'rug')) pl = {label: 'Shill wave', stat: `${wave.accounts} accounts in ${wave.windowMin} min`, tone: 'rug'};
      if (pl && !pl.stat) {
        const sf = cc.history?.calls?.sinceFirst, mc = cc.market?.mcap?.value;
        const stat = sf && Math.abs(sf.change) >= 0.05 ? (sf.change >= 1 ? `${(sf.change + 1).toFixed(1)}x since call` : `${sf.change > 0 ? '+' : '−'}${Math.round(Math.abs(sf.change) * 100)}% since call`) : mc ? `${mvUsd(mc)} mcap` : null;
        pl = {...pl, stat};
      }
      if (ctx && pl && (v.tone === 'neutral' || v.tone !== 'rug' || rk.level === 'high')) {
        ctx.classList.remove('neutral', 'legit', 'kol', 'rug');
        ctx.classList.add(pl.tone);
        ctx.dataset.chain = '1';
        ctx.innerHTML = `${fox()}<span class="verdict">${esc(pl.label)}</span>${pl.stat ? `<span class="mid">·</span><span class="detail">${esc(pl.stat)}</span>` : ''}`;
        ctx.classList.add('pill-new');
        return;
      }
      const det = ctx?.querySelector('.detail');
      if (!det || !/no on-chain read|not read yet|on-chain read yet/i.test(det.textContent || '')) return;
      const f = (cc.facts || []).find((x) => x.tone === 'bad') || (cc.facts || []).find((x) => x.tone === 'warn') || (cc.facts || []).find((x) => x.k === 'mcap' || x.k === 'trades');
      const mc = cc.market?.mcap?.value;
      det.textContent = f ? f.text : mc ? `${mvUsd(mc)} market cap` : 'Read on-chain';
    };
    if (c && !c.error) pillFromChain(c);
    const tweetTime = tw?.created_at ? Date.parse(tw.created_at) : null;
    const chartCtl = c && !c.error ? chartFor(root, c, tweetTime, c.identity?.address && String(c.identity.address).toLowerCase() === String(ca?.address || '').toLowerCase() ? firstCandles : null) : null;
    const stampFor = (cc) => {
      if (!settings.stamps || !on('stamps') || article.querySelector('[data-fable-host="stamp"]')) return;
      // the stamp names what the alert is about (it used to say BUNDLED for any red alert, a mint left on included)
      const S = CFG.copy?.stamps || {};
      const sk = cc?.risk?.reasons?.find((x) => x.w === 'severe')?.key;
      if (cc?.risk?.alert) stampPost(article, sk === 'op' ? S.rugOperation || 'RUG' : sk === 'honeypot' ? S.honeypot || 'HONEYPOT' : sk === 'bundle' ? S.bundled || 'BUNDLED' : S[sk] || S.highRisk || 'HIGH RISK', t, played);
      else if (cc?.risk?.devPill?.label === 'Rug history') stampPost(article, S.rugHistory || 'RUG', t, played);
    };
    if (c && !c.error) stampFor(c);
    // the poster's history arrived after the coin card was drawn: add its section in place (no redraw, no chart replay)
    if (lateHist) hP.then((h2) => {
      const hh = h2 && !h2.error && h2.days ? h2 : null;
      if (!hh || !host.isConnected) return;
      hist = hh;
      pillFromAuthor(article, v, hh);
      const body = root.querySelector('.mv-body');
      const sec = trackSection(hh);
      if (!sec || !body || body.querySelector('.mv-track-late')) return;
      const tpl = document.createElement('template');
      tpl.innerHTML = sec.replace('class="mv-sec"', 'class="mv-sec mv-track-late"');
      const foot = body.querySelector(':scope > .mv-foot:last-child');
      if (foot) body.insertBefore(tpl.content, foot); else body.appendChild(tpl.content);
    }).catch(() => {});
    root.addEventListener('click', (e) => {
      if (e.target.closest('a[href]')) return e.stopPropagation(); // receipts open themselves, the post underneath does not
      const card = e.target.closest('.mv-card');
      if (!card) return;
      e.preventDefault();
      e.stopPropagation();
      if (card.dataset.mv === 'contract') openContract(c, c.identity?.symbols?.length === 1 ? `$${c.identity.symbols[0].symbol}` : 'Contract');
      else openSheet(v, 'history', t);
    });
    // live fill: the server is reading the chain for these contracts; poll and update the card in place (no X refresh)
    if (c && !c.error && (c.filling || others.some((x) => x.filling))) {
      let seen = new Set(keys);
      for (let n = 0; n < 12 && host.isConnected; n++) {
        await new Promise((r) => setTimeout(r, n < 4 ? 2500 : 5000));
        let [next, ...more] = await Promise.all([getC(ca, true), ...list.slice(1).map((x) => getC(x, true))]);
        [next, more] = lead(next, more);
        if (!next || next.error) continue;
        const moreOk = more.filter((x) => x && !x.error);
        const done = !next.filling && !moreOk.some((x) => x.filling);
        if (JSON.stringify([next.facts, next.market, next.onchain, next.devHistory, moreOk.map((x) => x.risk)]) !== JSON.stringify([c.facts, c.market, c.onchain, c.devHistory, others.map((x) => x.risk)]) || done) {
          c = next;
          others = moreOk;
          if (!swapped) INTEL.set(ckey(ca), Promise.resolve(next));
          const out = contractCard(next, seen, hist, moreOk);
          const body = root.querySelector('.mv-card');
          if (body) { body.outerHTML = new DOMParser().parseFromString(`<div>${out.html}</div>`, 'text/html').querySelector('.mv-card').outerHTML; hideBroken(root); }
          seen = new Set([...seen, ...out.keys]);
          pillFromChain(next);
          stampFor(next);
          chartCtl?.remount();
        }
        if (done) break;
      }
    }
  };

  // a post Fable's verdict skipped (not about crypto) still gets the author's record when it is worth showing:
  // smart followers, shipped projects or a promotion record. Everything else stays untouched.
  const upgradeHidden = async (article, v) => {
    const tw = TWEETS.get(v.id);
    const handle = tw?.author?.handle || article.querySelector('[data-testid="User-Name"] a[href^="/"]')?.getAttribute('href')?.slice(1);
    if (!handle || !/^[A-Za-z0-9_]{1,15}$/.test(handle)) return;
    const h = await intelGet(`h:${handle.toLowerCase()}`, {type: 'history', handle});
    if (!h || h.error || article.getAttribute('data-fable-done') !== v.id || article.querySelector('[data-fable-host]')) return;
    const sm = h.smart?.n || 0, builds = h.builds?.length || 0;
    if (sm < 3 && !builds && !(h.promosTotal >= 2)) return;
    const faces = (h.smart?.people || []).map((p) => p.avatar).filter(Boolean).slice(0, 3);
    const nv = {...v, hidden: false, tone: 'legit', label: builds ? 'Builder' : 'Smart followers', detail: builds && !sm ? `${builds} project${builds === 1 ? '' : 's'} shipped` : String(sm), faces};
    if (h.promosTotal >= 2 && !sm && !builds) Object.assign(nv, {tone: 'kol', label: 'Promoter', detail: `${h.promosTotal} coins called in 30 days`, faces: []});
    VERDICTS.set(v.id, nv);
    article.setAttribute('data-fable-done', '');
    render(article, nv);
  };

  const important = (v) => !!v.stamp || (v.tone === 'rug' && IMPORTANT.has(v.label)) || (v.tone === 'kol' && IMPORTANT.has(v.label));
  const render = (article, v) => {
    if (!settings.enabled || article.getAttribute('data-fable-done') === v.id || article.querySelector('[data-fable-host]')) return;
    if (v.hidden || (CFG.copy?.hideLabels || []).includes(v.label) || (v.tone === 'neutral' && /^no flags$/i.test(v.label || '') && !v.card?.rows?.length)) { article.setAttribute('data-fable-done', v.id); if (settings.intel) upgradeHidden(article, v); return; } // not a crypto post: only a notable author gets a card
    const toneOn = {rug: settings.showRug, kol: settings.showKol, legit: settings.showLegit}[v.tone] ?? settings.showNeutral;
    if (!toneOn && !v.self) return article.setAttribute('data-fable-done', v.id);
    remember(article, v);
    const t = theme();
    const played = PLAYED.has(v.id) || !!window.__fableStill;
    // Always attach INSIDE the article: under the tweet text, or just above the action bar for media-only posts.
    const textEl = [...article.querySelectorAll('[data-testid="tweetText"]')].find((el) => !el.closest('[role="link"][tabindex]'));
    const bar = [...article.querySelectorAll('[role="group"]')].pop();
    if (!textEl && !bar) return;

    const host = document.createElement('div');
    host.setAttribute('data-fable-host', 'ui');
    if (textEl) textEl.insertAdjacentElement('afterend', host);
    else bar.insertAdjacentElement('beforebegin', host);
    article.setAttribute('data-fable-done', v.id);
    article.removeAttribute('data-fable-fade');
    if (v.fade && settings.fade) article.dataset.fableWantsFade = '1';
    else delete article.dataset.fableWantsFade;
    if (v.fade && settings.fade && played) article.setAttribute('data-fable-fade', '1');
    mountShadow(host, ctxHTML(v) + (settings.cards && important(v) ? cardHTML(v.card) : ''), t, played, v);
    if (settings.intel && on('cards')) mountIntel(article, host, v, t, played).catch((e) => console.error('fable card', e?.message));
    if (textEl && settings.tokenMarks && on('tokenMarks')) markTokens(article, v, textEl, t);
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
    mountShadow(s, `<div class="stamp ink"><span>${esc(v.stamp)}</span><em>${fox('fox')}FABLE</em></div>`, t, played);
  };

  // The API verdict arrived after the instant local one: change only what differs, in place (the card stays put).
  const sameVerdict = (a, b) => a.tone === b.tone && a.label === b.label && (a.stamp || '') === (b.stamp || '') && (a.detail || '') === (b.detail || '') && !!a.hidden === !!b.hidden;
  const upgrade = (article, prev, v) => {
    if (sameVerdict(prev, v) || !settings.enabled) return;
    const ui = article.querySelector('[data-fable-host="ui"]');
    // the local verdict drew nothing (not a crypto post): draw the API verdict now
    if (!ui) {
      if (!article.querySelector('[data-fable-host]')) { article.removeAttribute('data-fable-done'); render(article, v); }
      return;
    }
    if (v.hidden) return; // a post already showing a fact keeps it
    const ctx = ui.shadowRoot?.querySelector('.ctx');
    // a pill set from the chain or a caller rank is a harder fact than a text verdict, except a scam call
    if (ctx && (!(ctx.dataset.chain || ctx.dataset.rank) || v.tone === 'rug')) {
      const tpl = document.createElement('template');
      tpl.innerHTML = ctxHTML(v).trim();
      const next = tpl.content.firstElementChild;
      if (next) { next.classList.add('pill-new'); ctx.replaceWith(next); hideBroken(ui.shadowRoot); }
    }
    article.setAttribute('data-fable-done', v.id);
    if (v.fade && settings.fade && !article.querySelector('[data-fable-host="stamp"]')) article.setAttribute('data-fable-fade', '1');
    if (v.stamp && settings.stamps && on('stamps') && !article.querySelector('[data-fable-host="stamp"]')) stampFromVerdict(article, v, theme(), PLAYED.has(v.id));
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
