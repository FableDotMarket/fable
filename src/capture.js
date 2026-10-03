// Fable passive capture (isolated world content script, also loadable in plain node for tests).
//
// inject.js (MAIN world) copies the GraphQL responses X's web app already received and posts them
// to this window. This file turns them into a small whitelisted record set and relays it to the
// background worker, which batches and uploads only when an API url is configured.
//
// Privacy rules enforced here:
//   - read only responses the browser already got, never request anything from X
//   - whitelist fields: nothing about the viewer's relationships, DMs, bookmarks, notifications, ads
//   - drop the viewer entirely: their user object, their tweets, replies to them, tweets mentioning
//     them, and their own Followers/Following lists
//   - if the viewer cannot be identified, capture nothing
(() => {
  const CAPTURE_OPS = new Set([
    'HomeTimeline', 'HomeLatestTimeline', 'TweetDetail', 'UserTweets', 'UserOriginalsTimeline', 'UserTweetsAndReplies',
    'SearchTimeline', 'ListLatestTweetsTimeline', 'CommunityTweetsTimeline',
    'UserByScreenName', 'UserByRestId', 'Followers', 'Following', 'BlueVerifiedFollowers',
  ]);
  const GRAPH_OPS = new Set(['Followers', 'Following', 'BlueVerifiedFollowers']);

  /* ---------------- contract addresses ---------------- */

  const B58 = '1-9A-HJ-NP-Za-km-z';
  const EVM_RE = /(?<![0-9A-Za-z])0x[0-9a-fA-F]{40}(?![0-9A-Za-z])/g;
  const SOL_RE = new RegExp(`(?<![${B58}])[${B58}]{32,44}(?![${B58}])`, 'g');
  const EVM_JUNK = new Set(['0x0000000000000000000000000000000000000000', '0x000000000000000000000000000000000000dead', '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee']);

  const saneSolana = (s) => {
    if (!/[1-9]/.test(s) || !/[A-HJ-NP-Z]/.test(s) || !/[a-km-z]/.test(s)) return false;
    if (new Set(s).size < 12) return false; // repeated-char junk
    if (/(.)\1{5,}/.test(s)) return false;
    // well-known program / system ids are not tokens
    if (/^(1111111111111111111111111111111|So11111111111111111111111111111111111111112|TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA|ComputeBudget111111111111111111111111111111)/.test(s)) return false;
    return true;
  };

  const HOST_CHAIN = [
    [/(^|\.)pump\.fun$/, 'solana'], [/(^|\.)solscan\.io$/, 'solana'], [/(^|\.)bonk\.fun$/, 'solana'], [/(^|\.)jup\.ag$/, 'solana'], [/(^|\.)raydium\.io$/, 'solana'],
    [/(^|\.)etherscan\.io$/, 'ethereum'], [/(^|\.)basescan\.org$/, 'base'], [/(^|\.)bscscan\.com$/, 'bsc'], [/(^|\.)arbiscan\.io$/, 'arbitrum'],
  ];
  const PATH_CHAIN = /\/(solana|ethereum|base|bsc|arbitrum|polygon|avalanche|optimism|blast|robinhood|sol|eth)\//i;
  const PATH_ALIAS = {sol: 'solana', eth: 'ethereum'};
  const ADDRESS_HOSTS = /(^|\.)(dexscreener\.com|dextools\.io|birdeye\.so|gmgn\.ai|pump\.fun|bonk\.fun|solscan\.io|jup\.ag|raydium\.io|photon-sol\.tinyastro\.io|bullx\.io|etherscan\.io|basescan\.org|bscscan\.com|arbiscan\.io|geckoterminal\.com|defined\.fi|uniswap\.org|app\.uniswap\.org)$/i;

  const chainHintFromUrl = (u) => {
    try {
      const x = new URL(u);
      for (const [re, c] of HOST_CHAIN) if (re.test(x.hostname)) return c;
      const m = x.pathname.match(PATH_CHAIN);
      if (m) return PATH_ALIAS[m[1].toLowerCase()] || m[1].toLowerCase();
      const q = x.searchParams.get('chain');
      if (q) return PATH_ALIAS[q.toLowerCase()] || q.toLowerCase();
    } catch (_) {}
    return null;
  };

  const chainHintFromText = (text) => {
    const t = ` ${String(text || '').toLowerCase()} `;
    if (/robinhood chain/.test(t)) return 'robinhood';
    if (/\bon base\b|\bbase chain\b|#base\b/.test(t)) return 'base';
    if (/\bbsc\b|\bbnb chain\b/.test(t)) return 'bsc';
    if (/\bon eth\b|\bethereum\b|\beth mainnet\b/.test(t)) return 'ethereum';
    return null;
  };

  // text: tweet text with t.co links still present or removed; urls: expanded urls
  const extractAddresses = (text, urls = []) => {
    const out = new Map();
    const textHint = chainHintFromText(text);
    const add = (chain, address) => {
      const key = chain === 'solana' ? address : address.toLowerCase();
      if (!out.has(key)) out.set(key, {chain, address: key});
    };
    const scan = (s, hint) => {
      for (const m of String(s || '').matchAll(EVM_RE)) if (!EVM_JUNK.has(m[0].toLowerCase())) add(hint && hint !== 'solana' ? hint : 'evm', m[0]);
      // blank out every 0x-hex run first so the tail of an EVM address or tx hash is never read as base58
      for (const m of String(s || '').replace(/0x[0-9a-fA-F]+/g, ' ').matchAll(SOL_RE)) if (saneSolana(m[0])) add('solana', m[0]);
    };
    scan(String(text || '').replace(/https?:\/\/\S+/g, ' '), textHint);
    for (const u of urls || []) {
      let host = '';
      try { host = new URL(u).hostname; } catch (_) { continue; }
      if (!ADDRESS_HOSTS.test(host)) continue; // random url paths are not contract addresses
      scan(decodeURIComponent(String(u).replace(/^https?:\/\/[^/]+/, ' ').replace(/[/?=&#]/g, ' ')), chainHintFromUrl(u) || textHint);
    }
    return [...out.values()].slice(0, 5);
  };

  /* ---------------- Asian posts (0.29) ---------------- */
  // Chinese, Japanese, Thai and Korean posts are written without spaces and often in full-width forms: "冲$PONS了", "合约0x...", "＄PONS".
  // JS word boundaries and the address lookarounds already treat CJK/Thai letters as non-word, so a ticker or contract touching them is found;
  // what is not found is the full-width dollar sign and full-width letters. foldWidth maps the full-width block to ASCII one character for one
  // (the length never changes, so offsets still line up with the text on screen).
  const foldWidth = (s) => String(s || '').replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/\u3000/g, ' ');
  const NON_ASCII = /[^\x00-\x7F]/;
  const CASHTAG_RE = /\$[A-Za-z][A-Za-z0-9]{1,9}\b/g;
  // X's own cashtag entities first; for a post with non-ASCII text, also the tickers found in the text itself (X does not always
  // link a cashtag with no space around it). English-only posts keep exactly X's list.
  const cashtagsFrom = (text, symbols = []) => {
    const out = (symbols || []).map((s) => String(s?.text ?? s ?? '').toUpperCase()).filter(Boolean);
    const t = String(text || '');
    if (NON_ASCII.test(t)) for (const m of foldWidth(t).replace(/https?:\/\/\S+/g, ' ').matchAll(CASHTAG_RE)) out.push(m[0].slice(1).toUpperCase());
    return [...new Set(out)];
  };

  /* ---------------- GraphQL extraction ---------------- */

  const clip = (s, n) => (typeof s === 'string' ? s.slice(0, n) : null);
  const num = (v) => {
    const n = typeof v === 'string' ? Number(v) : v;
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
  };
  const iso = (s) => {
    if (!s) return null;
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  };
  const expand = (text, urls) => {
    let s = String(text || '');
    for (const u of urls || []) if (u?.url && u?.expanded_url) s = s.split(u.url).join(u.expanded_url);
    return s;
  };

  const userFrom = (u) => {
    if (!u || u.__typename === 'UserUnavailable' || !/^\d{1,20}$/.test(String(u.rest_id || ''))) return null;
    const l = u.legacy || {};
    const core = u.core || {};
    const handle = core.screen_name || l.screen_name;
    if (!handle) return null;
    const descUrls = l.entities?.description?.urls || [];
    const linkUrls = (l.entities?.url?.urls || []).map((x) => x.expanded_url).filter(Boolean);
    const description = expand(u.profile_bio?.description ?? l.description, descUrls);
    return {
      id: String(u.rest_id),
      handle,
      name: clip(core.name || l.name, 100),
      avatar: clip((u.avatar?.image_url || l.profile_image_url_https || '').replace('_normal', '_bigger'), 300),
      // X moved the counts out of legacy (2026): relationship_counts / tweet_counts, legacy kept as fallback
      followers: num(u.relationship_counts?.followers ?? l.followers_count),
      following: num(u.relationship_counts?.following ?? l.friends_count),
      statuses: num(u.tweet_counts?.tweets ?? l.statuses_count),
      media_count: num(u.tweet_counts?.media_tweets ?? l.media_count),
      vtype: clip(u.verification?.verified_type || l.verified_type || null, 20),
      verified: !!(u.is_blue_verified || u.verification?.verified || l.verified),
      created_at: iso(core.created_at || l.created_at),
      description: clip(description, 400),
      url: clip(linkUrls[0] || null, 300),
      links: [...new Set([...linkUrls, ...descUrls.map((x) => x.expanded_url).filter(Boolean)])].slice(0, 6),
    };
  };

  const tweetFrom = (t) => {
    if (t?.__typename === 'TweetWithVisibilityResults') t = t.tweet;
    if (!t || !t.legacy || !/^\d{1,20}$/.test(String(t.rest_id || ''))) return null;
    const l = t.legacy;
    const author = userFrom(t.core?.user_results?.result);
    if (l.retweeted_status_result) {
      // a retweet is not the retweeter's words (the original is walked separately), but it is an endorsement
      const o = l.retweeted_status_result.result?.tweet || l.retweeted_status_result.result;
      const of = o?.core?.user_results?.result?.rest_id;
      return author?.id && of ? {rt: {by: author.id, of: String(of), tweet_id: String(o.rest_id || '')}, author} : null;
    }
    const note = t.note_tweet?.note_tweet_results?.result;
    const ents = note?.entity_set || l.entities || {};
    const urlEnts = ents.urls || [];
    const raw = note?.text || l.full_text || '';
    const urls = [...new Set(urlEnts.map((u) => u.expanded_url).filter(Boolean))].slice(0, 10);
    const text = raw.replace(/https:\/\/t\.co\/\S+/g, (m) => urlEnts.find((u) => u.url === m)?.expanded_url || '').replace(/\s+$/, '');
    return {
      tweet: {
        id: String(t.rest_id),
        author_id: author?.id || String(l.user_id_str || ''),
        text: text.slice(0, 4000),
        created_at: iso(l.created_at),
        lang: clip(l.lang, 8),
        cashtags: cashtagsFrom(text, ents.symbols || l.entities?.symbols).slice(0, 10),
        addresses: extractAddresses(text, urls),
        urls,
        mentions: (ents.user_mentions || []).map((m) => String(m.id_str || '')).filter(Boolean),
        in_reply_to_user_id: l.in_reply_to_user_id_str || null,
        in_reply_to_status_id: l.in_reply_to_status_id_str || null,
        quoted_id: t.quoted_status_result?.result?.rest_id || l.quoted_status_id_str || null,
        metrics: {likes: num(l.favorite_count), retweets: num(l.retweet_count), replies: num(l.reply_count), quotes: num(l.quote_count), views: num(t.views?.count)},
        media: (l.extended_entities?.media || l.entities?.media || []).slice(0, 4).map((m) => ({type: clip(m.type, 16), ms: num(m.video_info?.duration_millis)})),
        reply_limited: !!(l.limited_actions || t.limitedActionResults || l.conversation_control),
      },
      author,
    };
  };

  const walk = (node, out, depth = 0) => {
    if (!node || typeof node !== 'object' || depth > 60) return;
    if (Array.isArray(node)) {
      for (const n of node) walk(n, out, depth + 1);
      return;
    }
    if (node.promotedMetadata) return; // ads are targeted at the viewer, skip the whole entry
    const tn = node.__typename;
    if ((tn === 'Tweet' || tn === 'TweetWithVisibilityResults') && (node.rest_id || node.tweet)) {
      const r = tweetFrom(node);
      if (r?.rt) { (out.rts ||= []).push(r.rt); if (r.author) out.users.push(r.author); }
      else if (r) {
        out.tweets.push(r.tweet);
        if (r.author) out.users.push(r.author);
      }
    } else if (tn === 'User' && node.rest_id) {
      const u = userFrom(node);
      if (u) out.users.push(u);
    }
    for (const k in node) {
      if (k === 'core' && tn === 'Tweet') continue; // author already taken via userFrom
      if (node[k] && typeof node[k] === 'object') walk(node[k], out, depth + 1);
    }
  };

  const varsOf = (url) => {
    try {
      return JSON.parse(new URL(url, 'https://x.com').searchParams.get('variables') || '{}');
    } catch (_) {
      return {};
    }
  };

  const viewerFromCookie = (cookie) => {
    const m = String(cookie || '').match(/(?:^|;\s*)twid=(?:u%3D|u=|"u=)(\d+)/);
    return m ? m[1] : null;
  };

  // Pure: raw GraphQL message -> whitelisted capture payload, or null if nothing may be captured.
  const extractCapture = ({op, data, url, viewer}) => {
    if (!CAPTURE_OPS.has(op) || !viewer) return null;
    const vars = varsOf(url);
    const ownerId = vars.userId ? String(vars.userId) : null;
    if (GRAPH_OPS.has(op) && (!ownerId || ownerId === viewer)) return null; // never the viewer's own graph
    const out = {tweets: [], users: []};
    walk(data, out);
    const users = new Map();
    for (const u of out.users) if (u.id !== viewer) users.set(u.id, u);
    const tweets = new Map();
    for (const t of out.tweets) {
      if (!t.author_id || t.author_id === viewer) continue;
      if (t.in_reply_to_user_id === viewer || t.mentions.includes(viewer)) continue;
      tweets.set(t.id, {...t, mentions: t.mentions.slice(0, 10)}); // public mention ids feed the smart-engagement graph
    }
    const rts = (out.rts || []).filter((r) => r.by !== viewer && r.of !== viewer).slice(0, 200);
    if (!users.size && !tweets.size && !rts.length) return null;
    return {op, ownerId: GRAPH_OPS.has(op) ? ownerId : null, users: [...users.values()], tweets: [...tweets.values()], rts};
  };

  const api = {CAPTURE_OPS, foldWidth, cashtagsFrom, extractAddresses, extractCapture, userFrom, tweetFrom, viewerFromCookie, chainHintFromUrl, chainHintFromText};
  globalThis.FableCapture = api;

  /* ---------------- relay (only inside the extension's isolated world) ---------------- */
  const inExtension = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id && typeof window !== 'undefined';
  if (!inExtension || window.__fableCaptureRelay) return;
  window.__fableCaptureRelay = true;
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || !e.data.__fable || !CAPTURE_OPS.has(e.data.op)) return;
    try {
      const viewer = (/^\d{1,20}$/.test(String(e.data.viewer || '')) && String(e.data.viewer)) || viewerFromCookie(document.cookie);
      const payload = extractCapture({op: e.data.op, data: e.data.data, url: e.data.url, viewer});
      if (payload) chrome.runtime.sendMessage({type: 'capture', payload}).catch(() => {});
    } catch (_) {}
  });
})();
