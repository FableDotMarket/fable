// Fable i18n (0.29): language support for every user-facing string. Classic script, loaded before the code that draws text
// (content scripts, the popup; the service worker imports it for its side effect). Data only: the string tables are
// src/locales/<lang>.js, plain objects registered on globalThis.FableLocales[<lang>]; nothing here fetches or runs remote code.
//
//   t(key, params)    HTML-safe string for innerHTML (string params are escaped; the template may hold <b> <i> <em> <s> <br>)
//   tx(key, params)   plain text for textContent / title / aria-label (no escaping, tags removed)
//   tr(text)          English text that comes from the server or the config -> the active language, from the `srv.*` entries
//                     (exact sentence or a {param} template); unknown text comes back unchanged
//   fact(f)           a server fact {text, key?, params?}: the `fact.<key>` entry if the language has it, else tr(text), else text
//   raw(html)         marks a param that already is HTML
//   num / date / ago  Intl number, date and compact relative time in the active language
//   set(pref)         'auto' | 'en' | 'zh-CN' | ... (also stored in chrome.storage.sync under `lang`); ready = promise of the stored choice
//   setOverrides(o)   remote config: {"zh-CN": {"<key>": "wording fix"}}, wins over the bundled table (tags other than <b><i><em><s><br> are dropped)
// Every lookup falls back to English per key, never to a blank.
(() => {
  const G = globalThis;
  if (G.FableI18n) return;
  const LANGS = [
    {code: 'en', native: 'English'}, {code: 'zh-CN', native: '简体中文'}, {code: 'zh-TW', native: '繁體中文'}, {code: 'ja', native: '日本語'},
    {code: 'ko', native: '한국어'}, {code: 'vi', native: 'Tiếng Việt'}, {code: 'th', native: 'ไทย'}, {code: 'id', native: 'Bahasa Indonesia'},
  ];
  const CODES = LANGS.map((l) => l.code);
  const BCP = {en: 'en', 'zh-CN': 'zh-Hans-CN', 'zh-TW': 'zh-Hant-TW', ja: 'ja', ko: 'ko', vi: 'vi', th: 'th', id: 'id'};
  const tables = () => (G.FableLocales ||= {});
  let overrides = {}; // lang -> {key: string}
  let pref = 'auto', active = 'en';
  const listeners = new Set();

  /* ---------------- which language ---------------- */
  // X's own language tag (document.documentElement.lang), or a browser tag, to one of our codes (null: not supported)
  const norm = (tag) => {
    const s = String(tag || '').trim().toLowerCase().replace(/_/g, '-');
    if (!s) return null;
    if (/^zh\b/.test(s)) return /hant|-tw\b|-hk\b|-mo\b/.test(s) ? 'zh-TW' : 'zh-CN';
    if (/^ja\b/.test(s)) return 'ja';
    if (/^ko\b/.test(s)) return 'ko';
    if (/^vi\b/.test(s)) return 'vi';
    if (/^th\b/.test(s)) return 'th';
    if (/^(id|in)\b/.test(s)) return 'id';
    if (/^en\b/.test(s)) return 'en';
    return null;
  };
  // the popup and the worker cannot read X's page: they follow the language a content script last saw on X (stored as langAuto)
  const inExt = typeof location !== 'undefined' && /^(chrome|moz)-extension:$/.test(location.protocol);
  let seenAuto = null;
  const autoLang = () => {
    const x = inExt || typeof document === 'undefined' ? seenAuto : norm(document.documentElement?.lang); // X's own UI language first
    if (x) return x;
    const nav = typeof navigator !== 'undefined' ? [...(navigator.languages || []), navigator.language] : [];
    for (const l of nav) { const c = norm(l); if (c) return c; }
    return 'en';
  };
  const resolve = () => (CODES.includes(pref) ? pref : autoLang());
  const rememberAuto = () => { // a content script on X saves X's language for the popup's Auto
    if (inExt || typeof document === 'undefined' || CODES.includes(pref)) return;
    const x = norm(document.documentElement?.lang);
    if (x && x !== seenAuto) { seenAuto = x; try { G.chrome?.storage?.local?.set({langAuto: x}); } catch { /* ignore */ } }
  };
  const refresh = () => {
    rememberAuto();
    const next = resolve();
    if (next === active) return;
    active = next;
    for (const cb of [...listeners]) { try { cb(active); } catch { /* a listener must not break the others */ } }
  };

  /* ---------------- formatting ---------------- */
  const cache = new Map();
  const memo = (k, make) => { let v = cache.get(k); if (!v) cache.set(k, (v = make())); return v; };
  const nf = (lang = active) => memo(`n:${lang}`, () => new Intl.NumberFormat(BCP[lang] || 'en'));
  const num = (n, opts) => {
    const v = Number(n);
    if (!isFinite(v)) return String(n ?? '');
    return opts ? new Intl.NumberFormat(BCP[active] || 'en', opts).format(v) : nf().format(v);
  };
  const date = (ts, opts = {month: 'short', day: 'numeric'}) => {
    const d = ts instanceof Date ? ts : new Date(typeof ts === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(ts) ? `${ts}T12:00:00Z` : ts);
    if (isNaN(d)) return String(ts ?? '');
    return new Intl.DateTimeFormat(BCP[active] || 'en', {timeZone: typeof ts === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(ts) ? 'UTC' : undefined, ...opts}).format(d);
  };
  const plural = (n, lang = active) => memo(`p:${lang}`, () => new Intl.PluralRules(BCP[lang] || 'en')).select(Number(n));

  /* ---------------- lookup ---------------- */
  const SAFE_TAG = /<(?!\/?(?:b|i|em|s|br)\s*\/?>)[^>]*>/gi;
  const cleanOverride = (v) => (typeof v === 'string' ? v.replace(/<(b|i|em|s|br)\b[^>]*>/gi, '<$1>').replace(SAFE_TAG, '') : v);
  const entry = (key, lang) => {
    const o = overrides[lang]?.[key];
    if (o !== undefined && o !== null && o !== '') return o;
    const v = tables()[lang]?.[key];
    return v === undefined || v === null || v === '' ? undefined : v;
  };
  const find = (key) => {
    const v = entry(key, active);
    if (v !== undefined) return {v, lang: active};
    const e = entry(key, 'en');
    return e === undefined ? null : {v: e, lang: 'en'};
  };
  const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
  const raw = (html) => ({__html: String(html ?? '')});
  const pick = (v, params, lang) => {
    if (typeof v === 'string') return v;
    if (!v || typeof v !== 'object') return '';
    const n = params ? (params.n ?? params.count) : undefined;
    const cat = n === undefined ? 'other' : plural(n, lang);
    return v[cat] ?? v.other ?? v.one ?? Object.values(v)[0] ?? '';
  };
  const fill = (tpl, params, html, lang) => tpl.replace(/\{(\w+)\}/g, (m, name) => {
    if (!params || !(name in params)) return m;
    const p = params[name];
    if (p && typeof p === 'object' && '__html' in p) return html ? p.__html : String(p.__html).replace(/<[^>]*>/g, '');
    if (typeof p === 'number') return isFinite(p) ? nf(lang).format(p) : '';
    if (p === null || p === undefined) return '';
    return html ? escHtml(p) : String(p);
  });
  const stripTags = (s) => s.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '');
  const render = (key, params, html) => {
    const hit = find(key);
    if (!hit) return key; // a key nobody has: shows the key, which the tests catch (never a blank)
    const tpl = pick(hit.v, params, hit.lang);
    // plain text: the template's own tags go first, so a value that happens to hold '<' or '>' is never cut
    return fill(html ? tpl : stripTags(tpl), params, html, hit.lang);
  };
  const t = (key, params) => render(key, params, true);
  const tx = (key, params) => render(key, params, false);
  const has = (key) => !!find(key);

  /* ---------------- English text from the server -> the active language ---------------- */
  // Built from the English table's `srv.*` entries: an exact sentence, or a {param} template turned into a regex.
  let idx = null;
  const forms = (v) => (typeof v === 'string' ? [[v, 'other']] : v && typeof v === 'object' ? Object.entries(v).map(([c, s]) => [s, c]) : []);
  const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // a slot that holds a count is a number, so "No smart followers" is not "{n} smart followers" with n = "No"
  const COUNT_PARAM = new Set(['n', 'count', 'pct', 'total', 'accounts', 'launches']);
  const buildIndex = () => {
    const en = tables().en || {};
    const exact = new Map(), pats = [];
    for (const [key, v] of Object.entries(en)) {
      if (!key.startsWith('srv.')) continue;
      for (const [s, cat] of forms(v)) {
        if (typeof s !== 'string' || !s) continue;
        const names = [];
        if (!/\{\w+\}/.test(s)) { if (!exact.has(s)) exact.set(s, {key}); continue; }
        const src = s.split(/(\{\w+\})/).map((part) => { const m = part.match(/^\{(\w+)\}$/); if (m) { names.push(m[1]); return COUNT_PARAM.has(m[1]) ? '(\\d[\\d,]*(?:\\.\\d+)?)' : '(.+?)'; } return reEsc(part); }).join('');
        pats.push({key, names, re: new RegExp(`^${src}$`), len: s.replace(/\{\w+\}/g, '').length, cat});
      }
    }
    pats.sort((a, b) => b.len - a.len);
    return {exact, pats, size: Object.keys(en).length};
  };
  // a captured number keeps the English grouping only when it is a plain en-US number; anything else (years, ids) stays text
  const asParam = (s) => {
    if (/^-?\d{1,3}(,\d{3})*(\.\d+)?$|^-?\d+(\.\d+)?$/.test(s)) { const n = Number(s.replace(/,/g, '')); if (isFinite(n) && new Intl.NumberFormat('en').format(n) === s) return n; }
    return s;
  };
  const SKIP_SUB = new Set(['name', 'handle', 'ticker', 'symbol', 'coin', 'who', 'token', 'wallet', 'address', 'tx', 'title']);
  // the answer for a sentence never changes until the language or a wording override does: memoised (a card translates dozens of lines)
  let trMemo = new Map(), trKey = '';
  const tr = (text, depth = 0) => {
    if (typeof text !== 'string' || !text || active === 'en' && !Object.keys(overrides.en || {}).length) return text;
    if (depth === 0) {
      const k = `${active}|${Object.keys(overrides).length}|${idx ? idx.size : 0}`;
      if (k !== trKey) { trMemo = new Map(); trKey = k; }
      const hit = trMemo.get(text);
      if (hit !== undefined) return hit;
      const out = trRaw(text, 0);
      if (trMemo.size > 3000) trMemo.clear();
      trMemo.set(text, out);
      return out;
    }
    return trRaw(text, depth);
  };
  const trRaw = (text, depth) => {
    const en = tables().en;
    if (!en) return text;
    if (!idx || idx.size !== Object.keys(en).length) idx = buildIndex();
    const hit = idx.exact.get(text);
    if (hit) { const r = entry(hit.key, active) !== undefined ? tx(hit.key) : null; return r ?? text; }
    for (const p of idx.pats) {
      const m = p.re.exec(text);
      if (!m) continue;
      if (entry(p.key, active) === undefined) return text; // no translation yet: the English stays
      const params = {};
      // a param can itself be a catalogued English phrase ('12 linked wallets', '3 days'): translated the same way, never a name or a ticker
      p.names.forEach((name, k) => { const v = asParam(m[k + 1]); params[name] = typeof v === 'string' && !SKIP_SUB.has(name) && /[A-Za-z]{3}/.test(v) && depth < 3 ? tr(v, depth + 1) : v; });
      return tx(p.key, params);
    }
    return text;
  };
  /* ---------------- structured facts: key + params from the server (fact-keys.json) ---------------- */
  // The catalogue's templates are an ICU subset: {name}, {n, plural, =0 {..} one {# x} other {# xs}}, {x, select, a {..} other {..}},
  // {msg, stem} / {msg, clause} for a nested {key, params} message (stem: no final full stop, clause: also first letter lower case).
  // Param types (src/locales/factmeta.js, from the catalogue): number pct eth sol usd duration ago text select msg.
  const ICU = new Map();
  const closeAt = (s, from) => { let d = 0; for (let i = from; i < s.length; i++) { if (s[i] === '{') d++; else if (s[i] === '}') { if (d === 0) return i; d--; } } return -1; };
  const parseICU = (s) => {
    const nodes = []; let i = 0, lit = '';
    const flush = () => { if (lit) { nodes.push({t: 'text', s: lit}); lit = ''; } };
    while (i < s.length) {
      if (s[i] !== '{') { lit += s[i++]; continue; }
      flush();
      const end = closeAt(s, i + 1);
      if (end < 0) throw new Error('unbalanced braces');
      const body = s.slice(i + 1, end); i = end + 1;
      const c1 = body.indexOf(',');
      if (c1 < 0) { nodes.push({t: 'arg', name: body.trim()}); continue; }
      const name = body.slice(0, c1).trim(), rest = body.slice(c1 + 1), c2 = rest.indexOf(',');
      const kind = (c2 < 0 ? rest : rest.slice(0, c2)).trim();
      if (kind === 'stem' || kind === 'clause') { nodes.push({t: 'nested', name, mode: kind}); continue; }
      if (kind !== 'plural' && kind !== 'select') throw new Error(`unknown argument kind ${kind}`);
      const branches = {}, src = rest.slice(c2 + 1);
      let j = 0;
      while (j < src.length) {
        while (j < src.length && /\s/.test(src[j])) j++;
        if (j >= src.length) break;
        let k = j;
        while (k < src.length && src[k] !== '{' && !/\s/.test(src[k])) k++;
        const label = src.slice(j, k);
        while (k < src.length && /\s/.test(src[k])) k++;
        if (src[k] !== '{') throw new Error('bad branch');
        const e2 = closeAt(src, k + 1);
        if (e2 < 0) throw new Error('unbalanced branch');
        branches[label] = parseICU(src.slice(k + 1, e2));
        j = e2 + 1;
      }
      nodes.push({t: kind, name, branches});
    }
    flush();
    return nodes;
  };
  const icu = (tpl) => { let p = ICU.get(tpl); if (!p) ICU.set(tpl, (p = parseICU(tpl))); return p; };
  // the spacing rule of each language around a number and its unit (the glossary): Japanese attaches it ("16時間"), Chinese puts one space ("16 小时")
  const unitSpace = (lang, str) => (lang === 'ja' ? str.replace(/(\d)\s+(?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])/gu, '$1')
    : lang === 'zh-CN' || lang === 'zh-TW' ? str.replace(/(\d)(?=\p{Script=Han})/gu, '$1 ') : str);
  const fmtParam = (type, v, lang) => {
    const loc = BCP[lang] || 'en', n = Number(v);
    switch (type) {
      // 0.30.0: a number under 1 keeps 2 significant digits (0.0001 ETH, a holder's 0.0044%): the 3-decimal default read them as "0"
      case 'number': return n !== 0 && Math.abs(n) < 1 ? new Intl.NumberFormat(loc, {maximumSignificantDigits: 2}).format(n) : nf(lang).format(n);
      case 'pct': return new Intl.NumberFormat(loc, {style: 'percent', maximumFractionDigits: (n > 0 && n < 10) || (n >= 99 && n < 100) ? 1 : 0}).format(n / 100); // 99.7% stays 99.7%, never rounds up to 100%
      case 'eth': case 'sol': return n > 0 && n < 0.01 ? '<0.01' : new Intl.NumberFormat(loc, {maximumFractionDigits: n >= 100 ? 0 : n >= 10 ? 1 : 2}).format(n);
      case 'usd': return n >= 1e9 ? `$${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${Math.round(n / 1e3)}K` : `$${Math.round(n)}`;
      case 'duration': { // seconds
        const [x, unit] = n < 90 ? [Math.max(1, Math.round(n)), 'second'] : n < 5400 ? [Math.round(n / 60), 'minute'] : n < 172800 ? [Math.round(n / 3600), 'hour'] : [Math.round(n / 86400), 'day'];
        return unitSpace(lang, new Intl.NumberFormat(loc, {style: 'unit', unit, unitDisplay: 'long'}).format(x));
      }
      case 'ago': { // epoch ms
        const s = Math.max(0, (Date.now() - n) / 1000);
        const [x, unit] = s < 3600 ? [Math.max(1, Math.round(s / 60)), 'minute'] : s < 86400 ? [Math.round(s / 3600), 'hour'] : [Math.round(s / 86400), 'day'];
        return unitSpace(lang, new Intl.RelativeTimeFormat(loc, {numeric: 'always'}).format(-x, unit));
      }
      default: return trPhrase(String(v)); // a text param: a name stays as it is, a catalogued phrase ('Pons, the Robinhood Chain launchpad') is translated
    }
  };
  // renders one catalogue entry; `lang` picks the entry (active language, else English); a nested {key, params} param renders the same way
  const renderKey = (key, params = {}, lang = active, depth = 0) => {
    const hit = entry(`fact.${key}`, lang) !== undefined ? {v: entry(`fact.${key}`, lang), lang} : (entry(`fact.${key}`, 'en') !== undefined ? {v: entry(`fact.${key}`, 'en'), lang: 'en'} : null);
    if (!hit || typeof hit.v !== 'string' || depth > 4) throw new Error(`no entry for ${key}`);
    const types = (G.FableFactMeta || {})[key] || {};
    const fmt = (name, v) => {
      if (v && typeof v === 'object' && v.key) return renderKey(v.key, v.params, lang, depth + 1);
      if (v === undefined || v === null) return '';
      return fmtParam(types[name] || 'text', v, hit.lang);
    };
    const run = (nodes, numName) => nodes.map((nd) => {
      if (nd.t === 'text') return numName ? nd.s.replace(/#/g, () => fmt(numName, params[numName])) : nd.s;
      if (nd.t === 'arg') return fmt(nd.name, params[nd.name]);
      if (nd.t === 'nested') {
        const v = params[nd.name];
        let s = renderKey(v.key, v.params, lang, depth + 1).replace(/[.。]$/, '');
        if (nd.mode === 'clause') s = s.charAt(0).toLowerCase() + s.slice(1);
        return s;
      }
      if (nd.t === 'plural') {
        const v = Number(params[nd.name]);
        // 0.30.0: a language whose plural rules have no "one" (zh, ja, ko, vi, th, id) still takes a translation's own one-branch for exactly 1 ("One wallet" vs "# wallets paid by one wallet")
        const cat = plural(v, hit.lang);
        const b = nd.branches[`=${v}`] || (v === 1 && cat !== 'one' && nd.branches.one) || nd.branches[cat] || nd.branches.other;
        if (!b) throw new Error(`plural ${nd.name}`);
        return run(b, nd.name);
      }
      const b = nd.branches[String(params[nd.name])] || nd.branches.other;
      if (!b) throw new Error(`select ${nd.name}`);
      return run(b, numName);
    }).join('');
    // 0.30.0: a wording that types its own percent sign after a pct param ("{pct}%", the remote-config strings written for clients without
    // the param types) would read "92%%" now that pct is formatted: one sign, whatever the locale's percent style put next to the number
    const out = run(icu(hit.v), null).replace(/%\s*%/g, '%');
    // an amount and its coin ("612 ETH") never split across two lines, so a sentence does not end with a lone "ETH." on its last line
    return depth === 0 && lang !== 'en' ? out.replace(/(\d) (ETH|SOL|USDC|USDT)(?![A-Za-z])/g, '$1' + String.fromCharCode(160) + '$2') : out;
  };
  // a server fact {text, key?, params?}: its key in the active language when the language has it; else the English text (through the
  // sentence catalogue for an older reply that has no key); the English language shows the server's own text unless a wording fix exists
  // a whole phrase from the sentence catalogue (exact match only, never a template): for the text params of a fact
  const trPhrase = (text) => {
    if (active === 'en' || !text) return text;
    const en = tables().en;
    if (!en) return text;
    if (!idx || idx.size !== Object.keys(en).length) idx = buildIndex();
    const hit = idx.exact.get(text);
    return hit && entry(hit.key, active) !== undefined ? tx(hit.key) : text;
  };
  const fact = (f) => {
    if (!f || typeof f !== 'object') return typeof f === 'string' ? tr(f) : '';
    const key = f.ikey || f.key; // a risk reason keeps its category in `key` and sends the message key as `ikey`
    if (key && typeof key === 'string') {
      const own = active === 'en' ? overrides.en?.[`fact.${key}`] : entry(`fact.${key}`, active);
      if (own !== undefined && (f.params === undefined || typeof f.params === 'object')) { try { return renderKey(key, f.params || {}, active); } catch { /* the English text below */ } }
    }
    return tr(String(f.text ?? ''));
  };
  // a sentence whose key and params travel in separate fields (pill label / stat, alert title, proof label): fx(text, key, params)
  const fx = (text, key, params) => fact({text, key, params});

  /* ---------------- time ---------------- */
  // a compact "5m ago" / "2d ago" from an elapsed time in ms
  const ago = (ms) => {
    const s = Math.max(0, Math.round(Number(ms) / 1000));
    if (!isFinite(s)) return '';
    if (s < 5) return tx('time.now');
    if (s < 60) return tx('time.ago.s', {n: s});
    if (s < 3600) return tx('time.ago.m', {n: Math.floor(s / 60)});
    if (s < 86400) return tx('time.ago.h', {n: Math.floor(s / 3600)});
    if (s < 86400 * 30) return tx('time.ago.d', {n: Math.floor(s / 86400)});
    if (s < 86400 * 365) return tx('time.ago.mo', {n: Math.floor(s / (86400 * 30))});
    return tx('time.ago.y', {n: Math.floor(s / (86400 * 365))});
  };

  /* ---------------- the page / popup ---------------- */
  // fills [data-i18n] (text), [data-i18n-html], and data-i18n-title / -placeholder / -aria-label / -alt, params in data-i18n-params
  const apply = (root = document) => {
    if (!root?.querySelectorAll) return;
    const params = (el) => { try { return JSON.parse(el.getAttribute('data-i18n-params') || 'null') || undefined; } catch { return undefined; } };
    for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = tx(el.getAttribute('data-i18n'), params(el));
    for (const el of root.querySelectorAll('[data-i18n-html]')) el.innerHTML = t(el.getAttribute('data-i18n-html'), params(el));
    for (const a of ['title', 'placeholder', 'aria-label', 'alt'])
      for (const el of root.querySelectorAll(`[data-i18n-${a}]`)) el.setAttribute(a, tx(el.getAttribute(`data-i18n-${a}`), params(el)));
    if (root === document && document.documentElement) document.documentElement.setAttribute('lang', active);
  };

  /* ---------------- state ---------------- */
  const set = (p, {store = true} = {}) => {
    pref = CODES.includes(p) ? p : 'auto';
    if (store) { try { G.chrome?.storage?.sync?.set({lang: pref}); } catch { /* storage unavailable: the choice lasts for this page */ } }
    refresh();
  };
  const setOverrides = (o) => {
    const next = {};
    if (o && typeof o === 'object') for (const [lang, m] of Object.entries(o)) if (m && typeof m === 'object') { next[lang] = {}; for (const [k, v] of Object.entries(m)) if (typeof v === 'string' || (v && typeof v === 'object')) next[lang][k] = typeof v === 'string' ? cleanOverride(v) : Object.fromEntries(Object.entries(v).map(([c, s]) => [c, cleanOverride(s)])); }
    if (JSON.stringify(next) === JSON.stringify(overrides)) return; // the config is re-read every 15 minutes: only a real wording change redraws
    overrides = next;
    idx = null;
    trKey = '';
    for (const cb of [...listeners]) { try { cb(active); } catch { /* ignore */ } }
  };

  let ready = Promise.resolve(pref);
  try {
    const st = G.chrome?.storage;
    if (st?.sync?.get) {
      ready = new Promise((res) => {
        try {
          st.sync.get({lang: 'auto'}, (s) => {
            const done = () => { set(s?.lang, {store: false}); res(active); };
            if (inExt && st.local?.get) st.local.get({langAuto: null}, (l) => { seenAuto = norm(l?.langAuto); done(); }); else done();
          });
        } catch { res(active); }
      });
      st.onChanged?.addListener?.((c, area) => {
        if (area === 'sync' && c.lang) set(c.lang.newValue, {store: false});
        if (area === 'local' && c.langAuto && inExt) { seenAuto = norm(c.langAuto.newValue); refresh(); }
      });
    }
  } catch { /* no extension storage (tests, plain pages): auto */ }
  // X (and the browser) can switch language under us: while the choice is Auto the card follows
  try { if (typeof document !== 'undefined' && document.documentElement && typeof MutationObserver !== 'undefined') new MutationObserver(() => { if (!CODES.includes(pref)) refresh(); }).observe(document.documentElement, {attributes: true, attributeFilter: ['lang']}); } catch { /* ignore */ }
  active = resolve();
  rememberAuto();

  // 0.30.0: a server fact key rendered with its typed params in the active language, English when the language lacks it ('' when no table has it):
  // the card's short labels made from the catalogue's own pill stats ("creator sold 29%", "insider cluster"), with no English text to fall back on
  const factKey = (key, params = {}) => {
    for (const l of [active, 'en']) { if (entry(`fact.${key}`, l) === undefined) continue; try { return renderKey(key, params, l); } catch { /* the next language */ } }
    return '';
  };
  G.FableI18n = {
    t, tx, tr, fact, fx, raw, num, date, ago, apply, has, set, setOverrides, ready, factKey,
    LANGS, CODES, norm, plural, parseICU: icu,
    lang: () => active,
    pref: () => pref,
    onChange: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    overrides: () => overrides,
    keys: (lang = 'en') => Object.keys(tables()[lang] || {}),
  };
})();
