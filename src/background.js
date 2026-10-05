// Fable background service worker (ES module).
// Decides verdicts: live API (Jev + DB) -> local heuristics.
// Also builds the smart-follower graph from X data the user already loads.
import {heuristicVerdict, textSignals, guardScan, guardApiVerdict, needsGuard, postAddress, postStance, stanceFromVerdict, refineHistory} from './verdict.js';
import {officialPostGuard, scopeVerdict} from './postguard.js';
import {SMART} from './smart.js';
import {softenVerdict} from './soften.js';
import './config.js';
import './callout.js'; // 0.29.1: call-outs never carry a promotion label (src/callout.js, globalThis.FableCallout)

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

const API_URL = 'https://api.fable.market';
const DEFAULTS = {enabled: true, apiUrl: API_URL, capture: true};
const settings = async () => {
  const s = await chrome.storage.sync.get(DEFAULTS);
  // the old Advanced panel (removed in 0.26.4) could switch on launch-video demo labels, set an offline mode or blank the
  // API: none of that applies any more, whatever an older version saved
  delete s.demo;
  s.mode = 'auto';
  if (!/^https:\/\//.test(s.apiUrl || '')) s.apiUrl = API_URL;
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
// The live API also runs the token rules from before the standing guard (verdict.js guardScan / guardFacts): a coin that
// has proven itself (an official token such as $PONS, a protected ticker such as $ZEC, or a coin 30+ days old with $1M+
// liquidity) could get "High-risk token" or "Scam KOL push" from who posted it. Such a verdict is decided again here with
// the guard, keeping the API's other rows. It only ever takes a promotion-only flag away; it never adds one.
async function guardVerdict(t, v) {
  if (!needsGuard(v, t)) return v;
  const ca = postAddress(t);
  // the same lite scan the post's token underline asks for (one cached read per coin), 4 s at most
  const scan = ca ? await apiGet(`/v1/token/scan?${new URLSearchParams({address: ca, lite: '1'})}`, 5 * 60e3, 4000).catch(() => null) : null;
  const g = guardApiVerdict(t, v, scan);
  if (!g) return v;
  if (!g.redo) return {...v, card: g.card || undefined, ...(g.dropDetail ? {detail: undefined} : {})};
  let local = null;
  try { local = heuristicVerdict(t, {...(await factsFor(t)), ...(g.postToken ? {postToken: g.postToken} : {})}); } catch { local = null; }
  if (!local || local.hidden) return {id: v.id, source: `${v.source || 'api'}+guard`, tone: 'neutral', label: 'No flags', stat: 'clean', confidence: 0.5, ...(g.card ? {card: g.card} : {})};
  return {...local, card: g.card || local.card, source: `${v.source || 'api'}+guard`};
}
async function sharpen(tweets, api, readsP = null) {
  const byId = new Map((api || []).map((v) => [String(v.id), v]));
  const reads = (await (readsP || readsFor(tweets))) || {};
  const out = [];
  for (const t of tweets) {
    let v = byId.get(String(t.id));
    try { v = await guardVerdict(t, v); } catch { /* keep the API verdict */ }
    // a post whose every contract is official ($PONS): no verdict about a coin or a launch reaches the pill, from the API or from the local rules
    if (officialPostGuard(t, v)) v = undefined;
    let local = null;
    try { local = heuristicVerdict(t, await factsFor(t)); } catch { local = null; }
    if (officialPostGuard(t, local)) local = null;
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
    if (pick) out.push(finish(t, scopeVerdict(t, softenVerdict(pick)), rd));
  }
  return out;
}

// 0.29.1, the last step of every verdict (the live API's, the kept one and the local one alike):
//  1. a post that warns about a coin or calls something out never carries a promotion label, a SHILL stamp or a bundled-coin "Scam" stamp (FableCallout.guard:
//     the post's own words in eight languages, the post reader's stance, the server's stance in history). It only removes; it never adds a flag.
//  2. a verdict about the AUTHOR (their record, network or followers), or one that carries a promotion label, carries the post's own reading beside it (postOnly: what
//     the same engine says with no author facts), so the page can draw the author once, give every later post of that author what the post itself says, and show
//     what the post says when the judged stance (intel /v1/stance) takes the promotion label off.
function finish(t, v, read = null) {
  if (!v || typeof v !== 'object') return v;
  let out = v;
  // with the judged stance on (on.stanceGate, the default) the guard only marks a call-out (callout: true): the page asks intel /v1/stance and a judged "promotes" outranks these words
  try { out = globalThis.FableCallout.guard(t, v, {read, stance: LOCAL_CALLOUT.has(String(t?.id)) ? 'warning' : null}, {markOnly: CFG_BG?.on?.stanceGate !== false}); } catch { out = v; }
  try {
    if ((globalThis.FableCallout.authorLevel(out) || globalThis.FableCallout.gated(out)) && !out.postOnly) {
      const p = heuristicVerdict(t, {});
      const slim = !p || p.hidden ? {hidden: true} : (({id, tone, label, stat, detail, confidence, stamp, fade, card, callout}) => ({id, tone, label, stat, detail, confidence, stamp, fade, card, callout, source: 'local+post'}))(globalThis.FableCallout.guard(t, p, {read}, {markOnly: CFG_BG?.on?.stanceGate !== false}));
      out = {...out, postOnly: slim};
    }
  } catch { /* the author verdict stands as it was */ }
  return out;
}
// posts this browser saw whose own words call something out (set when X's data arrives, before the page asks for anyone's history)
const LOCAL_CALLOUT = new Set();
function noteCallouts(tweets) {
  for (const t of tweets || []) {
    if (!t?.id || !(t.cashtags?.length || NAMES_COIN.test(t.text || ''))) continue;
    try { if (globalThis.FableCallout.isCallout(t.text).hit) { LOCAL_CALLOUT.add(String(t.id)); if (LOCAL_CALLOUT.size > 6000) LOCAL_CALLOUT.delete(LOCAL_CALLOUT.values().next().value); } } catch { /* skip */ }
  }
}

// API verdicts kept for 6 h across browser restarts (the API itself caches as long), so reopening X shows the right
// pill at once; the API is still asked every time and its answer replaces the kept one in place
const VKEEP_MS = 6 * 3600e3, VKEEP_MAX = 400;
let vkeep = null, vkeepTimer = null;
async function vkeepLoad() {
  // 'vkeep2': only verdicts that went through sharpen()'s 0.27 guard; anything an older build kept is ignored
  if (!vkeep) { try { vkeep = (await chrome.storage.local.get('vkeep2')).vkeep2 || {}; chrome.storage.local.remove('vkeep').catch(() => {}); } catch { vkeep = {}; } }
  return vkeep;
}
function vkeepSave() {
  clearTimeout(vkeepTimer);
  vkeepTimer = setTimeout(() => {
    const now = Date.now();
    vkeep = Object.fromEntries(Object.entries(vkeep || {}).filter(([, x]) => now - x.at < VKEEP_MS).sort((a, b) => b[1].at - a[1].at).slice(0, VKEEP_MAX));
    chrome.storage.local.set({vkeep2: vkeep}).catch(() => {});
  }, 1500);
}
async function vkeepPut(list) {
  const k = await vkeepLoad(), now = Date.now();
  for (const v of list || []) if (v?.id && !v.recheck) k[String(v.id)] = {at: now, v};
  vkeepSave();
}

// Post stances: whether each post this browser read that names a coin is a call or something else (a warning, research,
// a mention). The account history card counts only calls (verdict.js refineHistory). Kept 30 days, the history window.
const STANCE_MS = 30 * 864e5, STANCE_MAX = 4000;
const NAMES_COIN = /\$[A-Za-z][A-Za-z0-9]{1,11}\b|\b0x[a-fA-F0-9]{40}\b|\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/;
let stances = null, stanceTimer = null;
async function stanceLoad() {
  if (!stances) { try { stances = (await chrome.storage.local.get('stance1')).stance1 || {}; } catch { stances = {}; } }
  return stances;
}
async function stancePut(tweets, vs) {
  const k = await stanceLoad(), now = Date.now();
  const byId = new Map((vs || []).map((v) => [String(v?.id), v]));
  let n = 0;
  for (const t of tweets || []) {
    if (!t?.id || !(t.cashtags?.length || NAMES_COIN.test(t.text || ''))) continue;
    k[String(t.id)] = [(globalThis.FableCallout.isCallout(t.text).hit ? 'warning' : null) || stanceFromVerdict(byId.get(String(t.id))) || postStance(t), now];
    n++;
  }
  if (!n) return;
  clearTimeout(stanceTimer);
  stanceTimer = setTimeout(() => {
    stances = Object.fromEntries(Object.entries(stances || {}).filter(([, x]) => now - x[1] < STANCE_MS).sort((a, b) => b[1][1] - a[1][1]).slice(0, STANCE_MAX));
    chrome.storage.local.set({stance1: stances}).catch(() => {});
  }, 1500);
}

async function verdicts(tweets) {
  const out = await verdictsFor(tweets);
  stancePut(tweets, out).catch(() => {});
  return out;
}
async function verdictsFor(tweets) {
  const s = await settings();
  const out = [];
  const rest = tweets;

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
        const api = await sharpen(rest, j.verdicts, readsP);
        vkeepPut(api);
        out.push(...api);
        return out;
      }
    } catch (_) {
      /* fall through to local */
    }
  }

  for (const t of rest) out.push(finish(t, heuristicVerdict(t, await factsFor(t))));
  return out;
}

// 0.29.1: a post in an account's record that this browser read as a call-out (the post's own words: FableCallout.isCallout) is not a call, whatever the server judged
// (the server's text rule reads English only; its model answer needs a confidence the call-out may not reach). Same move as refineHistory, only ever REMOVING a call.
function withLocalCallouts(h, k = {}) {
  if (!h || h.error || !Array.isArray(h.promos) || !h.promos.length) return h;
  const idOf = (u) => String(u || '').match(/\/status\/(\d+)/)?.[1];
  const hit = (p) => { const id = idOf(p.url); return !!id && p.stance !== 'warning' && (LOCAL_CALLOUT.has(id) || k[id]?.[0] === 'warning'); };
  if (!h.promos.some(hit)) return h;
  const promos = h.promos.map((p) => (hit(p) ? {...p, stance: 'warning'} : p));
  const r = refineHistory({...h, promos, stances: undefined}, () => null);
  return {...r, stances: h.stances, notCalls: [...(h.notCalls || []), ...(r.notCalls || []).filter((n) => !(h.notCalls || []).some((x) => x.url === n.url))]};
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
      const out = [], k = await vkeepLoad(), now = Date.now();
      for (const t of msg.tweets || []) {
        const kept = k[String(t.id)];
        if (kept && now - kept.at < VKEEP_MS) { out.push(finish(t, scopeVerdict(t, softenVerdict({...kept.v, kept: true})))); continue; }
        try { const hv = heuristicVerdict(t, await factsFor(t)); if (!officialPostGuard(t, hv)) out.push(finish(t, scopeVerdict(t, softenVerdict(hv)))); } catch { /* skip */ }
      }
      reply({verdicts: out});
    }).catch(() => reply({verdicts: []}));
    return true;
  }
  if (msg.type === 'ingest') {
    noteCallouts(msg.payload?.tweets);
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
      // token scans are read with the standing guard: an official or established coin is never red or amber from who posted it
      .then((r) => reply(msg.type === 'scan' && r ? guardScan(r, {bySymbol: !msg.query?.address}) : msg.type === 'profile' && r?.verdict ? {...r, verdict: softenVerdict(r.verdict)} : r))
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
// storage.local so the first scroll after a pause, or after reopening the browser, is warm. A kept answer older than
// the read's ttl is shown at once and refreshed in the background (contracts for 30 min, histories for 6 h).
const KEEP = /^\/v1\/(contract|history)\?/;
const KEEP_STALE = (path) => (path.startsWith('/v1/history') ? 6 * 3600e3 : 30 * 60e3);
const SKEY = (path) => `ic:${path}`;
let keepIndex = null;
async function keepPut(path, entry) {
  if (!KEEP.test(path) || !chrome.storage?.local) return;
  try {
    keepIndex = keepIndex || (await chrome.storage.local.get('ic:index'))['ic:index'] || [];
    keepIndex = keepIndex.filter((p) => p !== path).concat(path);
    const drop = keepIndex.length > 80 ? keepIndex.splice(0, keepIndex.length - 80) : [];
    await chrome.storage.local.set({[SKEY(path)]: entry, 'ic:index': keepIndex});
    if (drop.length) await chrome.storage.local.remove(drop.map(SKEY));
  } catch { /* quota: memory cache only */ }
}
async function keepGet(path) {
  if (!KEEP.test(path) || !chrome.storage?.local) return null;
  try { return (await chrome.storage.local.get(SKEY(path)))[SKEY(path)] || null; } catch { return null; }
}
// the post id rides along for the server's sighting log, but one coin is one cache entry whatever post shows it
const cacheKey = (path) => path.replace(/([?&])tweet=\d+&?/, '$1').replace(/[?&]$/, '');
async function intelGet(path, ttl = 20e3, timeoutMs = 15000) {
  const key = cacheKey(path);
  let hit = INTEL_CACHE.get(key);
  if (!hit && ttl) { hit = await keepGet(key); if (hit) INTEL_CACHE.set(key, hit); }
  if (ttl && hit && Date.now() - hit.at < ttl) return hit.data;
  const stale = ttl && hit && KEEP.test(key) && Date.now() - hit.at < KEEP_STALE(key) ? hit.data : null;
  if (INFLIGHT.has(key)) return stale || INFLIGHT.get(key);
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
  return stale || p;
}
/* ---------------- 0.29.2: the judged stance of a post (intel /v1/stance) ----------------
   POST /v1/stance {items: [{id, text, symbol?, address?}]} (20 at most): the investigation's own judgment of the post when it has one, else Jev's (only for a post whose text
   names a coin) -> [{id, stance: promotes | warns | neutral | unrelated | none | pending, source, paid?}] in the order asked. "none" = no information (no coin named, nothing could be
   judged, the judged-post budget is spent); "pending" = a judgment is running (the page asks again). 'down' here means intel did not answer at all (the page then keeps the 0.29.1 rules).
   Judged answers are kept 6 h per post id here, "none" 20 minutes; one POST per 20 posts. */
const STANCE_J = new Map(); // tweet id -> {stance, at}
async function judgedStances(items) {
  const out = {}, ask = [], now = Date.now();
  for (const it of items.slice(0, 60)) {
    const id = String(it?.id || '');
    if (!/^\d{5,25}$/.test(id)) continue;
    const c = STANCE_J.get(id);
    if (c && now - c.at < (c.stance === 'none' ? 20 * 60e3 : 6 * 3600e3)) out[id] = c.stance;
    else ask.push({id, text: String(it.text || '').slice(0, 1000), ...(it.symbol ? {symbol: String(it.symbol).slice(0, 20)} : {}), ...(/^(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/.test(String(it.address || '')) ? {address: String(it.address)} : {})});
  }
  for (let k = 0; k < ask.length; k += 20) {
    const chunk = ask.slice(k, k + 20);
    let rows = null;
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 9000);
    try {
      const r = await fetch(`${INTEL_URL}/v1/stance`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({items: chunk}), signal: ctl.signal});
      if (r.ok) { const j = await r.json(); rows = Array.isArray(j) ? j : Array.isArray(j?.items) ? j.items : null; }
    } catch { rows = null; } finally { clearTimeout(timer); }
    if (!rows) { for (const it of chunk) out[it.id] = 'down'; continue; }
    const byId = new Map(rows.filter((x) => x && x.id != null).map((x) => [String(x.id), x]));
    chunk.forEach((it, n) => {
      const st = globalThis.FableCallout.stanceOf(byId.get(it.id) ?? rows[n] ?? null);
      if (st !== 'pending') { STANCE_J.set(it.id, {stance: st, at: now}); if (STANCE_J.size > 4000) STANCE_J.delete(STANCE_J.keys().next().value); }
      out[it.id] = st;
    });
  }
  return out;
}
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.type === 'stance') {
    if (msg.reset) STANCE_J.clear(); // the tests start from an empty cache
    judgedStances(Array.isArray(msg.items) ? msg.items : []).then(reply).catch(() => reply({}));
    return true;
  }
  if (msg.type === 'contract') {
    intelGet(`/v1/contract?${new URLSearchParams({...(msg.address ? {address: String(msg.address)} : {symbol: String(msg.symbol || '')}), ...(msg.chain ? {chain: String(msg.chain)} : {}), ...(msg.tweet ? {tweet: String(msg.tweet)} : {})})}`, msg.fresh ? 0 : 20e3).then(reply);
    return true;
  }
  if (msg.type === 'history') {
    // only real calls count: posts that warn about, research or just mention a coin leave the promotion record
    Promise.all([intelGet(`/v1/history?${new URLSearchParams({handle: String(msg.handle || ''), ...(msg.weeks ? {weeks: String(msg.weeks)} : {})})}`, 5 * 60e3), stanceLoad()])
      .then(([h, k]) => reply(withLocalCallouts(refineHistory(h, (id) => k[id]?.[0] || null), k)))
      .catch(() => reply(null));
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
  // 0.30.1 chart markers: the proven bad-actor trades of a Robinhood coin (intel /v1/markers, edge-cached 60 s; empty unless on.chartMarkers)
  if (msg.type === 'markers') {
    const a = String(msg.address || '').toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(a)) { reply(null); return true; }
    intelGet(`/v1/markers?${new URLSearchParams({address: a, chain: 'robinhood'})}`, 60e3).then(reply);
    return true;
  }
  // candles: tf auto | 1s | 15s | 1m | 5m | 15m | 1h | 4h; from / to (ms) ask for an older range (zoom, pan, All).
  // A closed range never changes (kept 5 minutes); the live end is kept 10 s.
  if (msg.type === 'candles') {
    const tf = /^(auto|1s|15s|30s|1m|5m|15m|1h|4h)$/.test(String(msg.tf || '')) ? String(msg.tf) : '5m';
    const ms = (x) => (Number.isFinite(+x) && +x > 0 ? String(Math.floor(+x)) : null);
    const from = ms(msg.from), to = ms(msg.to);
    // fine=1: this chart draws 1 s candles, so a coin under 5 minutes comes back on them in one read
    const q = {address: String(msg.address || ''), tf, fine: '1', ...(msg.chain ? {chain: String(msg.chain)} : {}), ...(from ? {from} : {}), ...(to ? {to} : {})};
    intelGet(`/v1/candles?${new URLSearchParams(q)}`, to && +to < Date.now() - 120e3 ? 5 * 60e3 : 10e3).then(reply);
    return true;
  }
  return false;
});
/* ---------------- Live trades (0.27.1) ----------------
   Robinhood and Solana coins: Fable's own hub (live.fable.market, fed by Fable's index about 0.2 s after each block),
   ONE WebSocket for the whole browser (/v1/stream: {op:'sub'|'unsub', a:[address]}), shared by every card; "ping" every
   20 s keeps it (and this worker) awake. Other chains: intel's per-coin socket, as before. While the hub cannot be
   reached, or its feed stays delayed longer than timing.liveHubDelayMs, its coins are served by intel's own room
   (/v1/live?via=room) and go back to the hub once it reports live again. Every card gets the same messages either way:
   {type:'trade'|'tick', p, t, usd, side, tx}, {type:'status', live, delayed}, {type:'void', tx}.
   Remote switches (src/config.js): on.liveHub false = intel for everything; on.liveStream false = one hub socket per coin. */
const HUB_WS = 'wss://live.fable.market';
const INTEL_WS = INTEL_URL.replace(/^http/, 'ws');
const EVM_RE = /^0x[0-9a-fA-F]{40}$/, SOL_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
let CFG_BG = globalThis.FableConfig?.DEFAULT || {};
chrome.storage.local.get('fableConfig').then(({fableConfig}) => { if (fableConfig) CFG_BG = fableConfig; }).catch(() => {});
chrome.storage.onChanged?.addListener((ch, area) => { if (area === 'local' && ch.fableConfig?.newValue) CFG_BG = ch.fableConfig.newValue; });
const liveOn = (k) => CFG_BG?.on?.[k] !== false;
// the hub serves Robinhood and Solana; an EVM coin of another (or an unknown) chain keeps intel's room
const hubChain = (address, chain) => {
  const c = String(chain || '').toLowerCase();
  if (EVM_RE.test(address)) return c === 'robinhood' ? 'robinhood' : null;
  if (SOL_RE.test(address)) return !c || c === 'solana' ? 'solana' : null;
  return null;
};
const DELAYED = (note) => ({type: 'status', live: true, delayed: true, note});
const LIVE = new Map(); // key -> {key, a, msg, ports, status, mode: 'stream' | 'coin' | 'intel', parked, ws}
const hub = {ws: null, open: false, fails: 0, downUntil: 0, retry: 0, ping: 0, idle: 0, status: null, lateTimer: 0, late: false};

// 0.28: a card that only watches its coin's verdict ({address, chain, only: 'verdict'}) is sent verdict messages and nothing else:
// no trades, no ticks, no status
const VERDICT_ONLY = new WeakSet();
function deliver(e, d) {
  if (!d || typeof d !== 'object') return;
  if (d.type === 'status') e.status = d;
  // a batch frame (several messages in one) is cut down to its verdicts for a watcher
  const verdicts = d.type === 'batch' && Array.isArray(d.m) ? d.m.filter((x) => x?.type === 'verdict') : null;
  for (const p of e.ports) {
    let out = d;
    if (VERDICT_ONLY.has(p) && d.type !== 'verdict') { if (!verdicts?.length) continue; out = verdicts.length === 1 ? verdicts[0] : {type: 'batch', m: verdicts}; }
    try { p.postMessage(out); } catch { /* card gone */ }
  }
}
const streamed = () => [...LIVE.values()].filter((e) => e.mode === 'stream');

// one coin, one socket: the hub's /v1/live (mode 'coin'), or intel's (mode 'intel'; via=room for a hub coin, so intel does
// not send it straight back to the hub)
function coinOpen(e, mode) {
  try { e.ws?.close(); } catch { /* closed */ }
  e.mode = mode === 'park' ? 'stream' : mode;
  e.parked = mode === 'park';
  const hc = hubChain(e.a, e.msg.chain);
  const q = new URLSearchParams({address: e.a, chain: e.msg.chain || '', ...(mode !== 'coin' && hc ? {via: 'room'} : {})});
  const ws = new WebSocket(`${mode === 'coin' ? HUB_WS : INTEL_WS}/v1/live?${q}`);
  let opened = false;
  e.ws = ws;
  ws.onopen = () => { opened = true; };
  ws.onmessage = (ev) => { if (e.ws !== ws) return; let d; try { d = JSON.parse(ev.data); } catch { return; } deliver(e, d); };
  // a dropped socket: the cards show DELAYED until the next status says the stream is back
  ws.onclose = () => {
    if (e.ws !== ws) return;
    e.ws = null;
    if (LIVE.get(e.key) !== e || !e.ports.size) return;
    deliver(e, DELAYED('reconnecting'));
    if (mode === 'coin' && !opened) hubDown(); // the hub refused or is unreachable: intel's room for a minute
    setTimeout(() => { if (LIVE.get(e.key) === e && e.ports.size && !e.ws && (e.mode !== 'stream' || e.parked)) route(e); }, 3000);
  };
}
function route(e) {
  const hc = liveOn('liveHub') && hubChain(e.a, e.msg.chain);
  if (!hc) return coinOpen(e, 'intel');
  if (Date.now() < hub.downUntil) { if (liveOn('liveStream')) { e.mode = 'stream'; hubEnsure(); } return coinOpen(e, liveOn('liveStream') ? 'park' : 'intel'); }
  if (!liveOn('liveStream')) return coinOpen(e, 'coin');
  e.mode = 'stream';
  hubSend('sub', [e.a]);
  hubEnsure();
  // the hub is up but its feed has been delayed too long: intel's room until it says live again
  if (hub.late) return coinOpen(e, 'park');
  const ws = e.ws;
  e.ws = null; e.parked = false;
  try { ws?.close(); } catch { /* closed */ }
  if (hub.open && hub.status) deliver(e, hub.status);
}
// the hub could not be reached: a minute (doubling to 5) on intel's rooms, then the hub is tried again
function hubDown() {
  hub.fails++;
  hub.downUntil = Date.now() + Math.min(300e3, 60e3 * 2 ** Math.max(0, hub.fails - 2));
  for (const e of streamed()) if (!e.parked) coinOpen(e, 'park');
  clearTimeout(hub.retry);
  hub.retry = setTimeout(hubEnsure, hub.downUntil - Date.now() + 50);
}
function hubSend(op, a) {
  if (!hub.open || !a.length) return;
  try { hub.ws.send(JSON.stringify({op, a})); } catch { /* closing */ }
}
function hubEnsure() {
  clearTimeout(hub.idle);
  if (hub.ws || !streamed().length) return;
  if (Date.now() < hub.downUntil) { clearTimeout(hub.retry); hub.retry = setTimeout(hubEnsure, hub.downUntil - Date.now() + 50); return; }
  const ws = new WebSocket(`${HUB_WS}/v1/stream`);
  hub.ws = ws; hub.open = false; hub.status = null;
  ws.onopen = () => {
    if (hub.ws !== ws) return;
    hub.open = true;
    hubSend('sub', [...new Set(streamed().map((e) => e.a))]);
    clearInterval(hub.ping);
    hub.ping = setInterval(() => { try { ws.send('ping'); } catch { /* closing */ } }, 20e3);
  };
  ws.onmessage = (ev) => {
    if (hub.ws !== ws) return;
    let d; try { d = JSON.parse(ev.data); } catch { return; } // "pong"
    if (d?.type === 'status') return hubStatus(d);
    // {type:'verdict', token, chain, verdict, color, facts_hash}: a coin's verdict or facts changed on the server (on.verdictPush). It names
    // its coin as `token`; everything else names it `a`
    const named = d?.type === 'verdict' ? (d.token || d.a) : d?.a;
    if (d?.type === 'verdict' && !liveOn('verdictPush')) return;
    const a = named && (EVM_RE.test(named) ? String(named).toLowerCase() : named);
    if (a) for (const e of LIVE.values()) if (e.a === a && e.mode === 'stream' && !e.parked) deliver(e, d);
  };
  ws.onclose = () => {
    if (hub.ws !== ws) return;
    const was = hub.open;
    hub.ws = null; hub.open = false; hub.status = null; hub.late = false;
    clearInterval(hub.ping); clearTimeout(hub.lateTimer); hub.lateTimer = 0;
    if (!streamed().length) return;
    // never opened, or dropping again and again: intel's rooms meanwhile; one drop of a working socket: reconnect
    if (!was || hub.fails >= 2) return hubDown();
    hub.fails++;
    for (const e of streamed()) if (!e.parked) deliver(e, DELAYED('reconnecting'));
    clearTimeout(hub.retry);
    hub.retry = setTimeout(hubEnsure, 1500);
  };
}
// the hub's feed: live -> every parked coin comes back to the hub; delayed for longer than timing.liveHubDelayMs (the
// box behind it is down) -> intel's rooms, until the hub says live again
function hubStatus(d) {
  hub.status = d;
  if (!d.delayed) {
    hub.fails = 0; hub.late = false;
    clearTimeout(hub.lateTimer); hub.lateTimer = 0;
    for (const e of streamed()) {
      if (e.parked) { const ws = e.ws; e.ws = null; e.parked = false; try { ws?.close(); } catch { /* closed */ } }
      deliver(e, d);
    }
    return;
  }
  for (const e of streamed()) if (!e.parked) deliver(e, d);
  if (!hub.lateTimer) hub.lateTimer = setTimeout(() => {
    hub.lateTimer = 0;
    if (!hub.status?.delayed) return;
    hub.late = true;
    for (const e of streamed()) if (!e.parked) coinOpen(e, 'park');
  }, CFG_BG?.timing?.liveHubDelayMs ?? 20e3);
}
function liveLeave(e) {
  LIVE.delete(e.key);
  const ws = e.ws;
  e.ws = null;
  try { ws?.close(); } catch { /* closed */ }
  if (e.mode !== 'stream') return;
  if (![...LIVE.values()].some((x) => x.a === e.a && x.mode === 'stream')) hubSend('unsub', [e.a]);
  // the last streamed card gone: the hub socket closes 30 s later unless another card opens (scrolling past charts)
  if (!streamed().length) { clearTimeout(hub.idle); hub.idle = setTimeout(() => { if (!streamed().length && hub.ws) { const w = hub.ws; hub.ws = null; hub.open = false; clearInterval(hub.ping); try { w.close(); } catch { /* closed */ } } }, 30e3); }
}
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'live') return;
  let key = null;
  port.onMessage.addListener((m) => {
    if (key || !m?.address) return;
    if (m.only === 'verdict') VERDICT_ONLY.add(port);
    key = `${m.chain || ''}:${m.address}`;
    let e = LIVE.get(key);
    if (!e) {
      const a = EVM_RE.test(String(m.address)) ? String(m.address).toLowerCase() : String(m.address);
      e = {key, a, msg: m, ports: new Set([port]), status: null, mode: null, parked: false, ws: null};
      LIVE.set(key, e);
      route(e);
      return;
    }
    e.ports.add(port);
    // a second card on the same coin gets the stream's current state at once (LIVE or DELAYED); a verdict watcher has no use for it
    if (e.status && !VERDICT_ONLY.has(port)) { try { port.postMessage(e.status); } catch { /* card gone */ } }
  });
  port.onDisconnect.addListener(() => {
    const e = key && LIVE.get(key);
    if (!e) return;
    e.ports.delete(port);
    if (!e.ports.size) liveLeave(e);
  });
});
