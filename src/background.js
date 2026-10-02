// Fable background service worker (ES module).
// Decides verdicts: demo overrides -> live API (Jev + DB) -> local heuristics.
// Also builds the smart-follower graph from X data the user already loads.
import {heuristicVerdict, textSignals} from './verdict.js';
import {SMART} from './smart.js';
import './config.js';

/* ---------------- Remote config (data only; src/config.js holds the bundled default) ----------------
   Read from intel every 15 minutes and kept in storage.local, where every tab reads it. A failed read keeps the last
   good copy; no copy at all means the bundled default. */
const CONFIG_URL = 'https://intel.fable.market/v1/config';
let configAt = 0;
async function refreshConfig(force = false) {
  if (!force && Date.now() - configAt < 15 * 60e3) return;
  configAt = Date.now();
  try {
    const r = await fetch(CONFIG_URL, {cache: 'no-store'});
    const got = r.ok ? await r.json() : null;
    if (got?.v !== 1) return;
    const {servedAt, savedAt, ...remote} = got; // serve times change every read; only the config itself is compared
    const merged = globalThis.FableConfig.merge(remote);
    const cur = (await chrome.storage.local.get('fableConfig')).fableConfig;
    if (!cur || cur.rev !== merged.rev || JSON.stringify(cur) !== JSON.stringify(merged)) await chrome.storage.local.set({fableConfig: merged});
  } catch { /* offline: keep the last good copy */ }
}
refreshConfig(true);
chrome.runtime.onStartup?.addListener(() => refreshConfig(true));
chrome.runtime.onInstalled?.addListener(() => refreshConfig(true));

const DEFAULTS = {enabled: true, mode: 'auto', apiUrl: 'https://api.fable.market', demo: false, capture: true};
let DEMO = null;
const demo = async () => (DEMO ||= await fetch(chrome.runtime.getURL('src/demo.json')).then((r) => r.json()));
const settings = async () => {
  const s = await chrome.storage.sync.get(DEFAULTS);
  // the API moved from api.fable.trading to api.fable.market; the old host stays up, but move saved settings over once
  if (/^https:\/\/api\.fable\.trading\/?$/.test(s.apiUrl || '')) {
    s.apiUrl = 'https://api.fable.market';
    chrome.storage.sync.set({apiUrl: s.apiUrl});
  }
  return s;
};

/* ---------------- Smart-follower graph (local, persisted) ----------------
   users:  id -> {handle, name, avatar}      (every account we have seen)
   edges:  followedId -> [smartHandle, ...]  (built when a smart account's Following list is viewed) */
const SMART_BY_HANDLE = Object.fromEntries(SMART.map((s) => [s.handle.toLowerCase(), s]));
let graph = null;
const loadGraph = async () => { if (!graph) { graph = (await chrome.storage.local.get({graph: {users: {}, edges: {}, ids: {}}})).graph; pruneGraph(graph); } return graph; };
// The graph used to grow forever and be rewritten whole 1.5 s after every change: on a heavy scroller (or the crawler's
// browser) that blocked this worker for seconds and held back every card's data. Now: at most GRAPH_MAX accounts (the
// smart accounts and everyone they follow always kept), written at most every 30 s.
const GRAPH_MAX = 8000;
let saveTimer = null;
const pruneGraph = (g) => {
  const ids = Object.keys(g.users);
  if (ids.length <= GRAPH_MAX * 1.1) return;
  const keep = new Set(Object.keys(g.edges));
  for (const h of Object.keys(SMART_BY_HANDLE)) { const id = g.ids[h]; if (id) keep.add(id); }
  const drop = ids.length - GRAPH_MAX;
  let n = 0;
  for (const id of ids) { if (n >= drop) break; if (!keep.has(id)) { delete g.users[id]; n++; } } // oldest first
  g.ids = Object.fromEntries(Object.entries(g.users).filter(([, u]) => u.handle).map(([id, u]) => [u.handle.toLowerCase(), id]));
};
const saveGraph = () => {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; pruneGraph(graph); chrome.storage.local.set({graph}); }, 30000);
};

const varsOf = (url) => {
  try {
    return JSON.parse(new URL(url, 'https://x.com').searchParams.get('variables') || '{}');
  } catch {
    return {};
  }
};

// Local graph only. content.js sends every parsed response here; nothing in this function leaves the browser.
async function ingest({op, url, tweets, users}) {
  const g = await loadGraph();
  const all = [...users, ...tweets.map((t) => t.author).filter(Boolean)];
  for (const u of all) {
    if (!u?.id) continue;
    g.users[u.id] = {handle: u.handle, name: u.name, avatar: u.avatar};
    if (u.handle) g.ids[u.handle.toLowerCase()] = u.id;
  }
  // Viewing a smart account's "Following" page teaches us who they follow.
  if (op === 'Following') {
    const who = g.users[varsOf(url).userId];
    const smart = who && SMART_BY_HANDLE[who.handle?.toLowerCase()];
    if (smart) {
      for (const u of users) {
        if (u.id === varsOf(url).userId) continue;
        const list = (g.edges[u.id] ||= []);
        if (!list.includes(smart.handle)) list.push(smart.handle);
      }
    }
  }
  saveGraph();
}

/* ---------------- Passive capture upload (batched, deduped, capped) ----------------
   capture.js sends whitelisted, viewer-stripped records here as {type: 'capture'}.
   Nothing is queued or sent unless an apiUrl is set, mode is not offline and capture is on. */
const FLUSH_MS = 20_000;
const FLUSH_AT = 200;
const MAX_PER_POST = 400;
const DAILY_CAP = 20000;
const RESEND_MS = 6 * 3600_000; // do not re-upload the same record within 6h
const queue = new Map(); // key -> {kind, item}
const sentAt = new Map(); // key -> ts
let flushTimer = null;
let backoffUntil = 0;
let restored = false;

const sessionStore = chrome.storage.session;
const persistQueue = () => sessionStore?.set({captureQueue: [...queue.entries()]}).catch(() => {});
const restoreQueue = async () => {
  if (restored) return;
  restored = true;
  try {
    const {captureQueue} = (await sessionStore?.get({captureQueue: []})) || {};
    for (const [k, v] of captureQueue || []) if (!queue.has(k)) queue.set(k, v);
  } catch (_) {}
};

const captureEnabled = async () => {
  const s = await settings();
  return !!(s.apiUrl && s.mode !== 'offline' && s.capture !== false);
};

const enqueue = (kind, key, item) => {
  const last = sentAt.get(key);
  if (last && Date.now() - last < RESEND_MS) return;
  queue.set(key, {kind, item}); // later copy of the same id wins (fresher metrics)
};

async function capture({op, ownerId, users = [], tweets = [], rts = []}) {
  if (!(await captureEnabled())) return;
  await restoreQueue();
  const g = await loadGraph();
  for (const u of users) {
    if (!u?.id) continue;
    if (u.handle) {
      g.users[u.id] = {...g.users[u.id], handle: u.handle, name: u.name, avatar: u.avatar};
      g.ids[u.handle.toLowerCase()] = u.id;
    }
    enqueue('users', `u:${u.id}`, u);
  }
  for (const t of tweets) if (t?.id) enqueue('tweets', `t:${t.id}`, t);
  for (const r of rts) if (r?.by && r?.of) enqueue('rts', `r:${r.by}:${r.of}:${r.tweet_id}`, r);
  // edges: only when the list being viewed belongs to a tracked smart account
  // any Following list a user views is offered to the shared graph; the server keeps only lists of accounts on its smart
  // list (smart_accounts), so every user who looks at a smart account's follows makes "followed by N smart" better
  if (op === 'Following' && ownerId) {
    const owner = g.users[ownerId]?.handle;
    if (owner) for (const u of users) if (u?.id && u.id !== ownerId) enqueue('edges', `e:${owner}:${u.id}`, {smart_handle: owner, followed_id: u.id, followed_handle: u.handle || null});
  }
  persistQueue();
  if (queue.size >= FLUSH_AT) flush();
  else if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS);
}

async function takeDailyAllowance(n) {
  const day = new Date().toISOString().slice(0, 10);
  const {captureCap} = await chrome.storage.local.get({captureCap: {day, count: 0}});
  const used = captureCap.day === day ? captureCap.count : 0;
  const allow = Math.max(0, Math.min(n, DAILY_CAP - used));
  await chrome.storage.local.set({captureCap: {day, count: used + allow}});
  return allow;
}

async function flush() {
  clearTimeout(flushTimer);
  flushTimer = null;
  if (!queue.size) return;
  const s = await settings();
  if (!s.apiUrl || s.mode === 'offline' || s.capture === false) {
    queue.clear();
    persistQueue();
    return;
  }
  if (Date.now() < backoffUntil) {
    flushTimer = setTimeout(flush, Math.min(backoffUntil - Date.now(), 15 * 60_000));
    return;
  }
  const allow = await takeDailyAllowance(Math.min(queue.size, MAX_PER_POST));
  if (!allow) {
    queue.clear(); // daily cap reached: drop, do not hoard
    persistQueue();
    return;
  }
  const batch = [...queue.entries()].slice(0, allow);
  for (const [k] of batch) queue.delete(k);
  persistQueue();
  const body = {v: 2, users: [], tweets: [], edges: [], rts: []};
  for (const [, {kind, item}] of batch) body[kind].push(item);
  try {
    const r = await fetch(`${s.apiUrl}/v1/ingest`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)});
    if (r.ok) {
      const now = Date.now();
      for (const [k] of batch) sentAt.set(k, now);
      if (sentAt.size > 20000) for (const k of [...sentAt.keys()].slice(0, 5000)) sentAt.delete(k);
    } else if (r.status === 429) {
      backoffUntil = Date.now() + 30 * 60_000;
    }
    // other 4xx/5xx: drop the batch, never retry-loop against the API
  } catch (_) {
    // network error: put the batch back once, it rides the next flush
    for (const [k, v] of batch) if (!queue.has(k)) queue.set(k, v);
    persistQueue();
  }
  if (queue.size && !flushTimer) flushTimer = setTimeout(flush, FLUSH_MS);
}

async function factsFor(t) {
  const g = await loadGraph();
  const id = t.author?.id || g.ids[t.author?.handle?.toLowerCase()];
  const smart = (g.edges[id] || []).map((h) => {
    const s = SMART_BY_HANDLE[h.toLowerCase()];
    const u = g.users[g.ids[h.toLowerCase()]] || {};
    return {handle: h, name: u.name || h, avatar: u.avatar || '', tag: s?.tag};
  });
  return {smart};
}

/* ---------------- Verdicts ---------------- */

// The live API runs an older bundle of the verdict rules. Rules added since (AI slop scoring, scam patterns) run here on
// every post, and win when they find a flag the API reply does not have. Fable's post reader (intel /v1/reads, a model
// read of the post with a verbatim quote) only ever CONFIRMS a rule that already fired part way; it never flags alone.
const LOCAL_FLAGS = /^(AI slop|Impersonator|Phishing link|Fake giveaway|Seed phrase ask|Fake support|Recovery scam|Fake claim|Drainer link|Scam pattern)$/;
const readsFor = (tweets) => intelGet(`/v1/reads?ids=${tweets.map((t) => t.id).join(',')}`, 30e3, 3000).catch(() => null);
async function sharpen(tweets, api, readsP = null) {
  const byId = new Map((api || []).map((v) => [String(v.id), v]));
  const reads = (await (readsP || readsFor(tweets))) || {};
  const out = [];
  for (const t of tweets) {
    const v = byId.get(String(t.id));
    let local = null;
    try { local = heuristicVerdict(t, await factsFor(t)); } catch { local = null; }
    const rd = reads[String(t.id)];
    let pick = v || local;
    // a newer local rule found a flag the API reply lacks: the local verdict wins (a scam over anything but a rug,
    // slop over a neutral or plain note)
    if (local && LOCAL_FLAGS.test(local.label || '') && v) {
      if (local.tone === 'rug' && v.tone !== 'rug') pick = {...local, card: v.card || local.card, source: 'local+api'};
      else if (local.label === 'AI slop' && (v.tone === 'neutral' || (v.tone === 'kol' && !/promo|shill|paid/i.test(v.label || '')))) pick = {...local, card: v.card || local.card, source: 'local+api'};
    }
    // the reader confirms a slop score that came close on its own
    if (rd && pick && pick.label !== 'AI slop' && (pick.tone === 'neutral' || pick.tone === 'legit' && /builder update/i.test(pick.label || ''))) {
      let sig = null; try { sig = textSignals(t); } catch { sig = null; }
      if (sig && rd.ai >= 0.85 && !rd.unquoted && sig.slopTells >= 2 && sig.slopScore >= sig.slopBar * 0.6 && String(t.text || '').length >= 120) {
        pick = {...pick, tone: 'kol', label: 'AI slop', stat: `${sig.slopTells} AI tells`, confidence: Math.max(0.8, rd.ai), detail: sig.slopWhy ? `Reads like AI-written engagement text: ${sig.slopWhy}` : 'Reads like AI-written engagement text', source: `${pick.source || 'api'}+reader`};
      }
    }
    // the reader confirms a scam pattern the local claim / bait rules saw but did not call
    if (rd && pick && pick.tone !== 'rug' && rd.scam >= 0.9 && rd.scamKind && !rd.unquoted) {
      let sig = null; try { sig = textSignals(t); } catch { sig = null; }
      if (sig && (sig.bait > 0.5 || sig.drainer || /claim|airdrop|giveaway|seed phrase|private key|support/i.test(t.text || ''))) {
        const lbl = {giveaway: 'Fake giveaway', seed: 'Seed phrase ask', support: 'Fake support', claim: 'Fake claim', impersonation: 'Impersonator'}[rd.scamKind] || 'Scam pattern';
        pick = {...pick, tone: 'rug', label: lbl, stat: `"${rd.quote.slice(0, 48)}"`, confidence: 0.9, source: `${pick.source || 'api'}+reader`};
      }
    }
    if (pick) out.push(pick);
  }
  return out;
}

async function verdicts(tweets) {
  const s = await settings();
  const out = [];
  let rest = tweets;

  // Demo mode only scripts the launch-video accounts. Everyone else gets the real verdict:
  // never invent history for a real account.
  if (s.demo) {
    const d = await demo();
    rest = [];
    for (const t of tweets) {
      const o = d[t.author?.handle];
      if (o) out.push({...o, id: t.id, confidence: 0.95, source: 'demo'});
      else rest.push(t);
    }
    if (!rest.length) return out;
  }

  if (rest.length && s.apiUrl && s.mode !== 'offline') {
    // the post reader's answers are asked for alongside the API verdicts, not after them
    const readsP = readsFor(rest);
    try {
      const withFacts = await Promise.all(rest.map(async (t) => ({...t, facts: await factsFor(t)})));
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 10000); // a 6-post batch with Jev answers in ~3s; local rules only if the API is down
      const r = await fetch(`${s.apiUrl}/v1/verdicts`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({tweets: withFacts}), signal: ctl.signal});
      clearTimeout(timer);
      if (r.ok) {
        const j = await r.json();
        out.push(...(await sharpen(rest, j.verdicts, readsP)));
        return out;
      }
    } catch (_) {
      /* fall through to local */
    }
  }

  for (const t of rest) out.push(heuristicVerdict(t, await factsFor(t)));
  return out;
}

const API_CACHE = new Map(); // path -> {at, data}
async function apiGet(path, ttl = 5 * 60e3, timeoutMs = 12000) {
  const s = await settings();
  if (!s.apiUrl || s.mode === 'offline') return null;
  const hit = API_CACHE.get(path);
  if (hit && Date.now() - hit.at < ttl) return hit.data;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(`${s.apiUrl}${path}`, {signal: ctl.signal});
    const data = r.ok ? await r.json() : null;
    if (data) API_CACHE.set(path, {at: Date.now(), data});
    if (API_CACHE.size > 300) API_CACHE.delete(API_CACHE.keys().next().value);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.type === 'verdicts') {
    verdicts(msg.tweets).then((v) => reply({verdicts: v}));
    return true;
  }
  // instant pill: this extension's own rules, no network (the API verdict follows and upgrades it in place)
  if (msg.type === 'quick') {
    refreshConfig(); // piggybacks on scrolling: at most one config read per 15 min
    settings().then(async (s) => {
      if (s.demo) return reply({verdicts: []});
      const out = [];
      for (const t of msg.tweets || []) { try { out.push(heuristicVerdict(t, await factsFor(t))); } catch { /* skip */ } }
      reply({verdicts: out});
    }).catch(() => reply({verdicts: []}));
    return true;
  }
  if (msg.type === 'ingest') {
    ingest(msg.payload);
    return false;
  }
  if (msg.type === 'capture') {
    capture(msg.payload || {}).catch(() => {});
    return false;
  }
  // profile panel and contract scanner: thin, cached proxies to the API
  if (msg.type === 'profile' || msg.type === 'scan') {
    apiGet(msg.type === 'profile' ? `/v1/profile?${new URLSearchParams({handle: msg.handle || '', ...(msg.id ? {id: msg.id} : {})})}` : `/v1/token/scan?${new URLSearchParams(msg.query || {})}`)
      .then((r) => reply(r))
      .catch(() => reply(null));
    return true;
  }
  // trending with smart accounts (popup Home): shared, cached 2 min on the server and 2 min here
  if (msg.type === 'trending') {
    apiGet(`/v1/trending?${new URLSearchParams({window: msg.window || '24h'})}`, 2 * 60e3)
      .then((r) => reply(r))
      .catch(() => reply(null));
    return true;
  }
  // project thesis: generated on the server the first time anyone opens it (can take ~20s), then cached
  if (msg.type === 'thesis') {
    apiGet(`/v1/thesis?${new URLSearchParams(msg.query || {})}`, 30 * 60e3, 45000)
      .then((r) => reply(r))
      .catch(() => reply(null));
    return true;
  }
  if (msg.type === 'stats') {
    loadGraph().then((g) => reply({users: Object.keys(g.users).length, edges: Object.keys(g.edges).length, smart: SMART.length}));
    return true;
  }
});

/* ---------------- Fable intel (intel.fable.market): contracts, account history, candles, live trades ----------------
   Public, read-only for the extension. The server reads missing on-chain facts once and shares them with every user. */
const INTEL_URL = 'https://intel.fable.market';
const INTEL_CACHE = new Map();
const INFLIGHT = new Map(); // one network read per path however many cards ask at once
// Chrome puts this worker to sleep after ~30 s idle and the Map above is lost: cards and histories are also kept in
// storage.session (memory-backed, cleared when the browser closes), so the next scroll after a pause is still warm.
const KEEP = /^\/v1\/(contract|history)\?/;
const SKEY = (path) => `ic:${path}`;
let keepIndex = null;
async function keepPut(path, entry) {
  if (!KEEP.test(path) || !chrome.storage?.session) return;
  try {
    keepIndex = keepIndex || (await chrome.storage.session.get('ic:index'))['ic:index'] || [];
    keepIndex = keepIndex.filter((p) => p !== path).concat(path);
    const drop = keepIndex.length > 80 ? keepIndex.splice(0, keepIndex.length - 80) : [];
    await chrome.storage.session.set({[SKEY(path)]: entry, 'ic:index': keepIndex});
    if (drop.length) await chrome.storage.session.remove(drop.map(SKEY));
  } catch { /* quota: memory cache only */ }
}
async function keepGet(path) {
  if (!KEEP.test(path) || !chrome.storage?.session) return null;
  try { return (await chrome.storage.session.get(SKEY(path)))[SKEY(path)] || null; } catch { return null; }
}
// the post id rides along for the server's sighting log, but one coin is one cache entry whatever post shows it
const cacheKey = (path) => path.replace(/([?&])tweet=\d+&?/, '$1').replace(/[?&]$/, '');
async function intelGet(path, ttl = 20e3, timeoutMs = 15000) {
  const key = cacheKey(path);
  let hit = INTEL_CACHE.get(key);
  if (!hit && ttl) { hit = await keepGet(key); if (hit) INTEL_CACHE.set(key, hit); }
  if (ttl && hit && Date.now() - hit.at < ttl) return hit.data;
  if (INFLIGHT.has(key)) return INFLIGHT.get(key);
  const p = (async () => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetch(`${INTEL_URL}${path}`, {signal: ctl.signal});
      const data = r.ok ? await r.json() : null;
      if (data) { const e = {at: Date.now(), data}; INTEL_CACHE.set(key, e); keepPut(key, e); }
      if (INTEL_CACHE.size > 400) INTEL_CACHE.delete(INTEL_CACHE.keys().next().value);
      return data;
    } catch { return null; } finally { clearTimeout(timer); INFLIGHT.delete(key); }
  })();
  INFLIGHT.set(key, p);
  return p;
}
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.type === 'contract') {
    intelGet(`/v1/contract?${new URLSearchParams({...(msg.address ? {address: String(msg.address)} : {symbol: String(msg.symbol || '')}), ...(msg.chain ? {chain: String(msg.chain)} : {}), ...(msg.tweet ? {tweet: String(msg.tweet)} : {})})}`, msg.fresh ? 0 : 20e3).then(reply);
    return true;
  }
  if (msg.type === 'history') {
    intelGet(`/v1/history?${new URLSearchParams({handle: String(msg.handle || ''), ...(msg.weeks ? {weeks: String(msg.weeks)} : {})})}`, 5 * 60e3).then(reply);
    return true;
  }
  if (msg.type === 'alerts') {
    intelGet('/v1/alerts', 60e3).then(reply);
    return true;
  }
  // the X sidebar's smart money feed: new follows by smart accounts and the coins they just posted
  if (msg.type === 'smartfeed') {
    intelGet(`/v1/smartfeed?${new URLSearchParams({hours: String([1, 6, 24].includes(msg.hours) ? msg.hours : 6)})}`, 60e3).then(reply);
    return true;
  }
  if (msg.type === 'coins') {
    intelGet(`/v1/coins?${new URLSearchParams({window: String(msg.window || '6h')})}`, 60e3).then(reply);
    return true;
  }
  if (msg.type === 'candles') {
    intelGet(`/v1/candles?${new URLSearchParams({address: String(msg.address || ''), tf: String(msg.tf || '5m'), ...(msg.chain ? {chain: String(msg.chain)} : {})})}`, 10e3).then(reply);
    return true;
  }
  return false;
});
// live: one WebSocket per coin, shared by every card showing it; closed as soon as no card is watching
const LIVE = new Map();
function liveOpen(key, e) {
  const ws = new WebSocket(`${INTEL_URL.replace(/^http/, 'ws')}/v1/live?${new URLSearchParams({address: e.msg.address || '', chain: e.msg.chain || ''})}`);
  e.ws = ws;
  ws.onmessage = (ev) => { let d; try { d = JSON.parse(ev.data); } catch { return; } for (const p of e.ports) { try { p.postMessage(d); } catch { /* card gone */ } } };
  ws.onclose = () => { if (LIVE.get(key) === e && e.ports.size) setTimeout(() => LIVE.get(key) === e && e.ports.size && liveOpen(key, e), 3000); };
}
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'live') return;
  let key = null;
  port.onMessage.addListener((m) => {
    if (key || !m?.address) return;
    key = `${m.chain || ''}:${m.address}`;
    let e = LIVE.get(key);
    if (!e) { e = {ports: new Set(), ws: null, msg: m}; LIVE.set(key, e); liveOpen(key, e); }
    e.ports.add(port);
  });
  port.onDisconnect.addListener(() => {
    const e = key && LIVE.get(key);
    if (!e) return;
    e.ports.delete(port);
    if (!e.ports.size) { try { e.ws?.close(); } catch { /* closed */ } LIVE.delete(key); }
  });
});
