// Fable popup: Home (today + recent flags + trending), Scan, Settings, Account, and the first-run setup.
// Settings live in chrome.storage.sync (content.js and background.js read the same keys);
// activity, recent flags and the signed-in X account are written to chrome.storage.local by content.js.
// Text: static labels are [data-i18n] in popup.html (FableI18n.apply fills them); everything drawn here reads the string tables.
const {t: TT, tx: TX, tr: TR} = FableI18n;
const DEFAULTS = {enabled: true, showRug: true, showKol: true, showLegit: true, showNeutral: true, fade: true, stamps: true, cards: true,
  tokenMarks: true, profilePanel: true, trendingPanel: true, capture: true, lang: 'auto'};
const PRESETS = {
  all: {showRug: true, showKol: true, showLegit: true, showNeutral: true},
  warn: {showRug: true, showKol: true, showLegit: false, showNeutral: false},
  scam: {showRug: true, showKol: false, showLegit: false, showNeutral: false},
};
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const n0 = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}K` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n ?? 0));
// compact elapsed time ("now", "5m", "3h", "2d"); counts go in as text so they never get a thousands separator
const ago = (ms) => {
  const m = Math.round((Date.now() - ms) / 60e3);
  return m < 1 ? TX('time.now') : m < 60 ? TX('time.dur.m', {n: String(m)}) : m < 1440 ? TX('time.dur.h', {n: String(Math.round(m / 60))}) : TX('time.dur.d', {n: String(Math.round(m / 1440))});
};
const send = (msg) => new Promise((ok) => chrome.runtime.sendMessage(msg, (r) => ok(chrome.runtime.lastError ? null : r)));
// no picture on file: the fable mark, never an empty circle
const face = (src, cls = '') => (src ? `<img class="${cls}" src="${esc(src)}" alt="">` : `<span class="ph ${cls}"><svg><use href="#f"/></svg></span>`);

// English text from the server (scan reasons, launch lines, profile lines) in the active language. A line the tables do not know as a
// whole is read sentence by sentence; a scan "reason" is a launch line with its last period removed, so both spellings are tried.
const fullStop = () => (/^(zh|ja)/.test(FableI18n.lang()) ? '。' : '.');
const trOne = (p) => {
  const r = TR(p);
  if (r !== p) return r;
  if (p.endsWith('.')) { const b = p.slice(0, -1), q = TR(b); return q !== b ? q + fullStop() : p; }
  const q = TR(`${p}.`);
  return q !== `${p}.` ? q.replace(/[.。]$/, '') : p;
};
const TL = (text) => {
  const s = String(text ?? '');
  const whole = trOne(s);
  if (whole !== s) return whole;
  const parts = s.split(/(?<=[.!?])\s+/);
  if (parts.length < 2) return s;
  const out = parts.map(trOne);
  return out.some((p, i) => p !== parts[i]) ? out.join(' ') : s;
};

let S = {...DEFAULTS};
let booted = false;

/* ---------------- motion (fable.market: blur-up reveal, count-up numbers) ---------------- */
const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
// replays the staggered entrance on a container's direct children
const enter = (el) => {
  if (!el || still) return;
  [...el.children].forEach((c, i) => c.style.setProperty('--i', i));
  el.classList.remove('enter'); void el.offsetWidth; el.classList.add('enter');
};
// numbers count up from where they are to the new value
const countTo = (el, n) => {
  const to = Number(n) || 0, from = Number(el.dataset.n || 0);
  el.dataset.n = to;
  if (still || to === from || to > 1e4) { el.textContent = n0(to); return; }
  const t0 = performance.now(), dur = 700;
  const step = (t) => { const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3); el.textContent = n0(Math.round(from + (to - from) * e)); if (k < 1) requestAnimationFrame(step); };
  requestAnimationFrame(step);
};
const save = (patch) => { Object.assign(S, patch); chrome.storage.sync.set(patch); paintSettings(); };

/* ---------------- tabs ---------------- */
const show = (tab) => {
  const btns = $$('nav button');
  btns.forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  $('nav .ind').style.transform = `translateX(${Math.max(0, btns.findIndex((b) => b.dataset.tab === tab)) * 100}%)`;
  $$('.view').forEach((v) => v.classList.toggle('on', v.id === `v-${tab}`));
  $('main').scrollTop = 0;
  enter($(`#v-${tab}`));
  if (tab === 'scan') setTimeout(() => $('#q').focus(), 50);
  try { localStorage.setItem('fable.tab', tab); } catch {}
};
$$('nav button').forEach((b) => b.addEventListener('click', () => show(b.dataset.tab)));
$$('[data-go]').forEach((b) => b.addEventListener('click', () => show(b.dataset.go)));

/* ---------------- header power switch ---------------- */
const paintPower = () => { $('#power').classList.toggle('off', !S.enabled); $('#power span').textContent = S.enabled ? TX('popup.power.on') : TX('popup.power.paused'); };
$('#power').addEventListener('click', () => { save({enabled: !S.enabled}); paintPower(); });

/* ---------------- settings ---------------- */
const presetOf = () => Object.entries(PRESETS).find(([, p]) => Object.entries(p).every(([k, v]) => S[k] === v))?.[0] || null;
function paintSettings() {
  $$('[data-k]').forEach((el) => { el.checked = !!S[el.dataset.k]; });
  const p = presetOf();
  $$('#preset button').forEach((b) => b.classList.toggle('on', b.dataset.p === p));
  const sel = $('#lang');
  sel.value = [...sel.options].some((o) => o.value === S.lang) ? S.lang : 'auto';
}
$$('[data-k]').forEach((el) => el.addEventListener('change', () => save({[el.dataset.k]: el.checked})));
$$('#preset button').forEach((b) => b.addEventListener('click', () => save(PRESETS[b.dataset.p])));

/* ---------------- language ---------------- */
// the list lives in FableI18n.LANGS (native names are never translated); "Auto" is the row already in popup.html
function buildLang() {
  const sel = $('#lang');
  for (const l of FableI18n.LANGS || []) if (!$$('option', sel).some((o) => o.value === l.code)) sel.append(new Option(l.native, l.code));
}
$('#lang').addEventListener('change', (e) => {
  const v = e.target.value;
  S.lang = v;
  // FableI18n.set stores the choice (chrome.storage.sync `lang`) and applies it live. Auto reads the page's own lang attribute first,
  // and this page's attribute mirrors the language in use, so it is cleared for Auto and set again from the result.
  if (v === 'auto') document.documentElement.removeAttribute('lang');
  FableI18n.set(v);
  document.documentElement.setAttribute('lang', FableI18n.lang());
});

/* ---------------- home ---------------- */
async function paintHome(quiet) {
  const day = new Date().toISOString().slice(0, 10);
  const {activity, recent} = await chrome.storage.local.get({activity: null, recent: []});
  const a = activity?.day === day ? activity : {checked: 0, flagged: 0, scams: 0};
  countTo($('#n-checked'), a.checked);
  countTo($('#n-flagged'), a.flagged);
  countTo($('#n-scams'), a.scams);
  const feed = $('#feed');
  if (!recent.length) {
    feed.innerHTML = `<div class="empty card"><b>${TT('popup.home.emptyTitle')}</b>${TT('popup.home.emptyBody')}</div>`;
    return;
  }
  feed.innerHTML = recent.slice(0, 25).map((r) => `
    <a class="item" ${r.url ? `href="${esc(r.url)}" target="_blank"` : ''}>
      ${face(r.avatar)}
      <div class="body">
        <div class="top"><b>${r.handle ? `@${esc(r.handle)}` : TT('popup.home.aPost')}</b><span class="tag ${esc(r.tone)}">${esc(TR(r.label))}</span><em>${esc(ago(r.at))}</em></div>
        ${r.detail ? `<div class="d">${esc(TL(r.detail))}</div>` : ''}
      </div>
    </a>`).join('');
  if (!quiet) enter(feed);
}

/* ---------------- trending (smart accounts talking about / following them) ---------------- */
let trendWin = '6h';
let trendList = null; // the last reply, kept so a language switch redraws without asking again
// the server's "why" line joins its parts with " · " ("3 new smart follows · 2 engaging"): each part is read and drawn from its own key
const whyText = (w) => String(w || '').split(' · ').map((p) => {
  const f = p.match(/^(\d+) new smart follows?$/), e = p.match(/^(\d+) engaging$/);
  return f ? TX('popup.trend.why.follows', {n: f[1]}) : e ? TX('popup.trend.why.engaging', {n: e[1]}) : p;
}).join(' · ');
function renderTrending(list, quiet) {
  const box = $('#trend');
  if (!list.length) { box.innerHTML = `<div class="empty">${TT('popup.trend.empty')}</div>`; return; }
  box.innerHTML = list.slice(0, 5).map((x, i) => `
    <a class="item" href="https://x.com/${esc(x.handle)}" target="_blank">
      ${face(x.avatar)}
      <div class="body">
        <div class="top"><b>${esc(x.name || x.handle)}</b>${x.role ? `<span class="role">${esc(TR(x.role))}</span>` : ''}<em>${i + 1}</em></div>
        <div class="d">${esc(TR(x.line || `@${x.handle}`))}</div>
        <div class="why">${(x.by || []).some((b) => b.avatar) ? `<span class="faces">${(x.by || []).filter((b) => b.avatar).slice(0, 3).map((b) => `<img src="${esc(b.avatar)}" alt="">`).join('')}</span>` : ''}<span>${x.early ? `<span class="early">${TT('popup.trend.early')}</span> · ` : ''}${esc(whyText(x.why))}</span></div>
        ${x.risk ? `<div class="risk">${esc(TR(x.risk))}</div>` : ''}
      </div>
    </a>`).join('');
  if (!quiet) enter(box);
}
async function paintTrending() {
  const box = $('#trend');
  if (!box) return;
  $$('#trend-win button').forEach((b) => b.classList.toggle('on', b.dataset.w === trendWin));
  box.innerHTML = `<div class="empty"><div class="spin" style="margin:0 auto"></div></div>`;
  trendList = null;
  const r = await send({type: 'trending', window: trendWin});
  trendList = r?.accounts || [];
  renderTrending(trendList);
}
$$('#trend-win button').forEach((b) => b.addEventListener('click', () => { trendWin = b.dataset.w; paintTrending(); }));

/* ---------------- scan ---------------- */
const kindOf = (q) => {
  const s = q.trim();
  if (/^0x[a-fA-F0-9]{40}$/.test(s) || /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return {type: 'scan', query: {address: s}};
  if (/^\$[A-Za-z][A-Za-z0-9]{0,11}$/.test(s)) return {type: 'scan', query: {symbol: s.slice(1).toUpperCase()}};
  const h = s.replace(/^https?:\/\/(x|twitter)\.com\//i, '').replace(/^@/, '').split(/[/?]/)[0];
  if (/^[A-Za-z0-9_]{1,15}$/.test(h)) return {type: 'profile', handle: h};
  return null;
};
let lastScan = null; // {k, r}: the result on screen, kept so a language switch redraws it
// the community database (fable.market/submit) is coming soon: shown, not linked, until the update ships
function paintScan() {
  if (!lastScan) return;
  const {k, r} = lastScan;
  $('#scan-out').innerHTML = (k.type === 'scan' ? tokenHTML(r) : profileHTML(k.handle, r)) + `<div class="report-link soon">${TT('popup.scan.communityDb')}</div>`;
}
$('#q').addEventListener('input', () => { $('#go').disabled = !kindOf($('#q').value); });
$('#scan-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const k = kindOf($('#q').value);
  if (!k) return;
  const out = $('#scan-out');
  lastScan = null;
  out.innerHTML = `<div class="card result" style="display:flex;gap:10px;align-items:center"><div class="spin"></div><span class="muted">${k.type === 'scan' ? TT('popup.scan.readingChain') : TT('popup.scan.readingAccount')}</span></div>`;
  let r = await send(k);
  // a first-time contract scan can finish in the background: ask again a few times
  for (let i = 0; k.type === 'scan' && r?.pending && i < 4; i++) { await new Promise((ok) => setTimeout(ok, 4000)); r = await send({type: 'scan', query: {...k.query, retry: String(i + 1)}}); }
  lastScan = {k, r};
  paintScan();
});
// the level word is drawn from its key; the logic keys (danger, caution, ok, unknown) are the API's
const LEVEL = {danger: ['rug', 'popup.scan.level.danger'], caution: ['kol', 'popup.common.caution'], ok: ['legit', 'popup.scan.level.ok'], unknown: ['', 'popup.scan.level.unknown']};
// Fable's own token (rules.ownTokens in the config, plus the remote config): an official badge, never a bundle line
let OWN = (globalThis.FableConfig?.DEFAULT?.rules?.ownTokens || []).map((a) => String(a).toLowerCase());
chrome.storage.local.get('fableConfig', (s) => { const r = s?.fableConfig?.rules?.ownTokens; if (Array.isArray(r)) OWN = [...new Set([...OWN, ...r.map((a) => String(a).toLowerCase())])]; });
const OWN_TRACE = /bundl|linked wallets|of supply|sniper|insider|threat actors|rug operation/i;
function tokenHTML(r) {
  if (!r) return `<div class="card result"><span class="muted">${TT('popup.scan.noReach')}</span></div>`;
  if (!r.found) return `<div class="card result"><b>${TT('popup.scan.notFound')}</b><p class="muted" style="margin:6px 0 0">${TT('popup.scan.notFoundBody')}</p></div>`;
  const own = OWN.includes(String(r.address || '').toLowerCase());
  const lv = LEVEL[r.level];
  const [tone, word] = own ? ['legit', TX('popup.scan.official')] : lv ? [lv[0], TX(lv[1])] : ['', r.level];
  // the lines are chosen and de-duplicated on the English the API sends; each is translated where it is drawn
  const lines = [...(r.launch?.lines || []).map((l) => l.text), ...(r.reasons || []).map((x) => x.text)].filter((v, i, a) => v && a.indexOf(v) === i && !(own && OWN_TRACE.test(v))).slice(0, 6);
  const usd = (v) => (v == null ? TX('popup.scan.na') : `$${n0(Math.round(v))}`);
  const age = r.ageHours == null ? TX('popup.scan.na') : r.ageHours < 48 ? TX('time.dur.h', {n: String(Math.round(r.ageHours))}) : TX('time.dur.d', {n: String(Math.round(r.ageHours / 24))});
  return `<div class="card result">
    <div class="head"><b>${r.symbol ? `$${esc(r.symbol)}` : TT('popup.scan.token')}</b><span class="pill ${tone}"><span class="${tone}">${esc(word)}</span></span></div>
    <div class="meta"><div><span>${TT('popup.scan.liquidity')}</span><b>${esc(usd(r.liquidityUsd))}</b></div><div><span>${TT('popup.scan.mcap')}</span><b>${esc(usd(r.mcapUsd))}</b></div><div><span>${TT('popup.scan.age')}</span><b>${esc(age)}</b></div></div>
    ${lines.length ? `<ul class="facts ${tone}">${lines.map((l) => `<li>${esc(TL(l))}</li>`).join('')}</ul>` : ''}
    ${r.pending ? `<p class="hint">${TT('popup.scan.pending')}</p>` : ''}
    ${r.pairUrl ? `<a class="btn ghost" style="display:inline-flex;align-items:center;margin-top:12px" href="${esc(r.pairUrl)}" target="_blank">${TT('popup.scan.openChart')}</a>` : ''}
  </div>`;
}
function profileHTML(handle, r) {
  const v = r?.verdict;
  if (!v) return `<div class="card result"><span class="muted">${TT('popup.profile.noRead', {handle})}</span></div>`;
  const rows = (v.card?.rows || []).flatMap((row) => row.lines || []).concat(v.card?.lines || []);
  const lines = [v.detail, ...rows].filter((x, i, a) => x && a.indexOf(x) === i).slice(0, 7);
  return `<div class="card result">
    <div class="head"><b>@${esc(handle)}</b><span class="pill ${esc(v.tone)}"><span class="${esc(v.tone)}">${esc(TR(v.label || 'No flags'))}</span></span></div>
    ${lines.length ? `<ul class="facts ${esc(v.tone)}">${lines.map((l) => `<li>${esc(TL(l))}</li>`).join('')}</ul>` : `<p class="muted" style="margin:10px 0 0">${TT('popup.profile.nothing')}</p>`}
    <a class="btn ghost" style="display:inline-flex;align-items:center;margin-top:12px" href="https://x.com/${esc(handle)}" target="_blank">${TT('popup.profile.openProfile')}</a>
  </div>`;
}

/* ---------------- account ---------------- */
async function paintAccount() {
  const {xAccount, activity, lifetime} = await chrome.storage.local.get({xAccount: null, activity: null, lifetime: null});
  $('#me').innerHTML = xAccount
    ? `${face(xAccount.avatar)}<div><b>${esc(xAccount.name || xAccount.handle)}</b><span class="muted">${TT('popup.account.linked', {handle: xAccount.handle})}</span></div>`
    : `<span class="ph"></span><div><b>${TT('popup.account.noAccount')}</b><span class="muted">${TT('popup.account.noAccountHint')}</span></div>`;
  countTo($('#a-checked'), activity?.checked || 0);
  countTo($('#a-flagged'), activity?.flagged || 0);
  const st = await send({type: 'stats'});
  countTo($('#a-graph'), st?.users || 0);
  $('#ver').textContent = `Fable ${chrome.runtime.getManifest().version}`;
}
// the clear button asks twice: 0 idle, 1 "tap again", 2 cleared (the label is drawn here so it follows the language)
let clearState = 0;
const paintClear = () => { $('#clear span').textContent = TX(['popup.account.clear', 'popup.account.clearSure', 'popup.account.cleared'][clearState]); };
$('#redo').addEventListener('click', () => openSetup());
$('#clear').addEventListener('click', async () => {
  if (clearState !== 1) { clearState = 1; paintClear(); return; }
  await chrome.storage.local.remove(['activity', 'recent', 'graph', 'xAccount']);
  clearState = 2; paintClear();
  paintHome(); paintAccount();
});

/* ---------------- first-run setup ---------------- */
let step = 0, pick = 'all';
const paintStep = () => {
  $('#setup').dataset.step = step;
  $$('#setup .step').forEach((s) => { s.classList.toggle('on', Number(s.dataset.s) === step); [...s.children].forEach((c, i) => c.style.setProperty('--i', i)); });
  $$('#setup .steps i').forEach((d, i) => d.classList.toggle('on', i <= step));
};
async function paintSetupX() {
  const {xAccount} = await chrome.storage.local.get({xAccount: null});
  $('#setup-x').innerHTML = xAccount
    ? `${face(xAccount.avatar)}<div><b>@${esc(xAccount.handle)}</b><span>${TT('popup.setup.linked')}</span></div>`
    : `<span class="ph"></span><div><b>${TT('popup.setup.waiting')}</b><span>${TT('popup.setup.waitingHint')}</span></div>`;
  $('#open-x').style.display = xAccount ? 'none' : '';
}
function openSetup() { step = 0; pick = presetOf() || 'all'; $('#setup').classList.add('on'); paintStep(); paintSetupX(); paintPick(); }
const paintPick = () => $$('#setup-pick button').forEach((b) => b.classList.toggle('on', b.dataset.p === pick));
$$('#setup [data-next]').forEach((b) => b.addEventListener('click', () => { step = Math.min(2, step + 1); paintStep(); }));
$$('#setup-pick button').forEach((b) => b.addEventListener('click', () => { pick = b.dataset.p; paintPick(); }));
$('#finish').addEventListener('click', async () => {
  save({...PRESETS[pick], enabled: true});
  await chrome.storage.local.set({onboarded: Date.now()});
  $('#setup').classList.remove('on');
  paintPower(); paintHome();
});

/* ---------------- language switch: static text from the tables, then everything drawn here ---------------- */
FableI18n.onChange(() => {
  if (!booted) return; // the first paint below runs after the stored choice is known
  FableI18n.apply(document);
  paintPower(); paintClear(); paintHome(true); paintAccount(); paintSetupX(); paintScan();
  if (trendList) renderTrending(trendList, true);
});

/* ---------------- boot ---------------- */
requestAnimationFrame(() => $('#hero')?.classList.add('lit'));
FableI18n.ready.then(() => FableI18n.apply(document)); // the static labels switch as soon as the language is known, before the settings are read
// the old Advanced panel is gone: clear what an older version may have saved (demo labels, offline mode, a custom API)
chrome.storage.sync.get(['demo', 'mode', 'apiUrl'], (o) => {
  const junk = ['demo', 'mode'].filter((k) => k in o);
  if (o.apiUrl && o.apiUrl !== 'https://api.fable.market') junk.push('apiUrl');
  if (junk.length) chrome.storage.sync.remove(junk);
});
// wording fixes from the remote config (i18n.<lang>.<key>) apply here too
chrome.storage.local.get('fableConfig', (c) => FableI18n.setOverrides(c?.fableConfig?.i18n));
chrome.storage.sync.get(DEFAULTS, async (s) => {
  S = s;
  await FableI18n.ready; // the stored language (and Auto) is resolved before the first text is drawn
  buildLang();
  FableI18n.apply(document);
  booted = true;
  paintPower(); paintSettings(); paintClear(); paintHome(); paintAccount(); paintTrending();
  let tab = 'home';
  try { tab = localStorage.getItem('fable.tab') || 'home'; } catch {}
  show(tab);
  const {onboarded} = await chrome.storage.local.get({onboarded: null});
  if (!onboarded) openSetup();
});
chrome.storage.onChanged.addListener((c, area) => {
  if (area === 'local' && (c.activity || c.recent)) paintHome();
  if (area === 'local' && c.fableConfig) FableI18n.setOverrides(c.fableConfig.newValue?.i18n);
  if (area === 'local' && c.xAccount) { paintAccount(); paintSetupX(); }
  if (area === 'sync' && c.lang) { S.lang = c.lang.newValue || 'auto'; paintSettings(); }
});
