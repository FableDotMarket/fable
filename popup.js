// Fable popup: Home (today + recent flags + trending), Scan, Settings, Account, and the first-run setup.
// Settings live in chrome.storage.sync (content.js and background.js read the same keys);
// activity, recent flags and the signed-in X account are written to chrome.storage.local by content.js.
const DEFAULTS = {enabled: true, showRug: true, showKol: true, showLegit: true, showNeutral: true, fade: true, stamps: true, cards: true,
  tokenMarks: true, profilePanel: true, trendingPanel: true, capture: true, demo: false, apiUrl: 'https://api.fable.market'};
const PRESETS = {
  all: {showRug: true, showKol: true, showLegit: true, showNeutral: true},
  warn: {showRug: true, showKol: true, showLegit: false, showNeutral: false},
  scam: {showRug: true, showKol: false, showLegit: false, showNeutral: false},
};
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const n0 = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}K` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n ?? 0));
const ago = (ms) => { const m = Math.round((Date.now() - ms) / 60e3); return m < 1 ? 'now' : m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`; };
const send = (msg) => new Promise((ok) => chrome.runtime.sendMessage(msg, (r) => ok(chrome.runtime.lastError ? null : r)));
const face = (src, cls = '') => (src ? `<img class="${cls}" src="${esc(src)}" alt="">` : `<span class="ph ${cls}"></span>`);

let S = {...DEFAULTS};
const save = (patch) => { Object.assign(S, patch); chrome.storage.sync.set(patch); paintSettings(); };

/* ---------------- tabs ---------------- */
const show = (tab) => {
  $$('nav button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  $$('.view').forEach((v) => v.classList.toggle('on', v.id === `v-${tab}`));
  if (tab === 'scan') setTimeout(() => $('#q').focus(), 50);
  try { localStorage.setItem('fable.tab', tab); } catch {}
};
$$('nav button').forEach((b) => b.addEventListener('click', () => show(b.dataset.tab)));
$$('[data-go]').forEach((b) => b.addEventListener('click', () => show(b.dataset.go)));

/* ---------------- header power switch ---------------- */
const paintPower = () => { $('#power').classList.toggle('off', !S.enabled); $('#power span').textContent = S.enabled ? 'On' : 'Paused'; };
$('#power').addEventListener('click', () => { save({enabled: !S.enabled}); paintPower(); });

/* ---------------- settings ---------------- */
const presetOf = () => Object.entries(PRESETS).find(([, p]) => Object.entries(p).every(([k, v]) => S[k] === v))?.[0] || null;
function paintSettings() {
  $$('[data-k]').forEach((el) => { el.checked = !!S[el.dataset.k]; });
  const p = presetOf();
  $$('#preset button').forEach((b) => b.classList.toggle('on', b.dataset.p === p));
  if (document.activeElement !== $('#apiUrl')) $('#apiUrl').value = S.apiUrl || '';
}
$$('[data-k]').forEach((el) => el.addEventListener('change', () => save({[el.dataset.k]: el.checked})));
$$('#preset button').forEach((b) => b.addEventListener('click', () => save(PRESETS[b.dataset.p])));
$('#apiUrl').addEventListener('change', (e) => save({apiUrl: e.target.value.trim().replace(/\/$/, '')}));

/* ---------------- home ---------------- */
async function paintHome() {
  const day = new Date().toISOString().slice(0, 10);
  const {activity, recent} = await chrome.storage.local.get({activity: null, recent: []});
  const a = activity?.day === day ? activity : {checked: 0, flagged: 0, scams: 0};
  $('#n-checked').textContent = n0(a.checked);
  $('#n-flagged').textContent = n0(a.flagged);
  $('#n-scams').textContent = n0(a.scams);
  const feed = $('#feed');
  if (!recent.length) {
    feed.innerHTML = `<div class="empty card"><b>Nothing flagged yet</b>Scroll X with Fable on and every scam, shill and bundled launch you pass lands here.</div>`;
    return;
  }
  feed.innerHTML = recent.slice(0, 25).map((r) => `
    <a class="item" ${r.url ? `href="${esc(r.url)}" target="_blank"` : ''}>
      ${face(r.avatar)}
      <div class="body">
        <div class="top"><b>${r.handle ? `@${esc(r.handle)}` : 'A post'}</b><span class="tag ${esc(r.tone)}">${esc(r.label)}</span><em>${ago(r.at)}</em></div>
        ${r.detail ? `<div class="d">${esc(r.detail)}</div>` : ''}
      </div>
    </a>`).join('');
}

/* ---------------- trending (smart accounts talking about / following them) ---------------- */
let trendWin = '6h';
async function paintTrending() {
  const box = $('#trend');
  if (!box) return;
  $$('#trend-win button').forEach((b) => b.classList.toggle('on', b.dataset.w === trendWin));
  box.innerHTML = `<div class="empty"><div class="spin" style="margin:0 auto"></div></div>`;
  const r = await send({type: 'trending', window: trendWin});
  const list = r?.accounts || [];
  if (!list.length) { box.innerHTML = `<div class="empty">No trending accounts in this window yet.</div>`; return; }
  box.innerHTML = list.slice(0, 5).map((x, i) => `
    <a class="item" href="https://x.com/${esc(x.handle)}" target="_blank">
      ${face(x.avatar)}
      <div class="body">
        <div class="top"><b>${esc(x.name || x.handle)}</b>${x.role ? `<span class="role">${esc(x.role)}</span>` : ''}<em>${i + 1}</em></div>
        <div class="d">${esc(x.line || `@${x.handle}`)}</div>
        <div class="why"><span class="faces">${(x.by || []).map((b) => (b.avatar ? `<img src="${esc(b.avatar)}" alt="">` : '<i></i>')).join('')}</span><span>${x.early ? '<span class="early">Early</span> · ' : ''}${esc(x.why || '')}</span></div>
        ${x.risk ? `<div class="risk">${esc(x.risk)}</div>` : ''}
      </div>
    </a>`).join('');
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
$('#q').addEventListener('input', () => { $('#go').disabled = !kindOf($('#q').value); });
$('#scan-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const k = kindOf($('#q').value);
  if (!k) return;
  const out = $('#scan-out');
  out.innerHTML = `<div class="card result" style="display:flex;gap:10px;align-items:center"><div class="spin"></div><span class="muted">${k.type === 'scan' ? 'Reading the chain' : 'Reading the account'}</span></div>`;
  let r = await send(k);
  // a first-time contract scan can finish in the background: ask again a few times
  for (let i = 0; k.type === 'scan' && r?.pending && i < 4; i++) { await new Promise((ok) => setTimeout(ok, 4000)); r = await send({type: 'scan', query: {...k.query, retry: String(i + 1)}}); }
  out.innerHTML = k.type === 'scan' ? tokenHTML(r) : profileHTML(k.handle, r);
  // the full dossier on the Fable Terminal: live chart, launcher history, posters (coins) or rank, calls, smart followers (accounts)
  const addr = k.query?.address || r?.address || r?.token?.address || null;
  const href = k.type === 'scan' ? (addr ? `https://intel.fable.market/c/${encodeURIComponent(addr)}` : null) : k.handle ? `https://intel.fable.market/a/${encodeURIComponent(k.handle)}` : null;
  if (href) out.insertAdjacentHTML('beforeend', `<a class="dossier-link" href="${href}" target="_blank" rel="noopener">Open the full dossier</a>`);
});
const LEVEL = {danger: ['rug', 'High risk'], caution: ['kol', 'Caution'], ok: ['legit', 'No red flags'], unknown: ['', 'Not enough data']};
function tokenHTML(r) {
  if (!r) return `<div class="card result"><span class="muted">Could not reach Fable. Try again in a moment.</span></div>`;
  if (!r.found) return `<div class="card result"><b>Not found</b><p class="muted" style="margin:6px 0 0">No live market for this contract or ticker.</p></div>`;
  const [tone, word] = LEVEL[r.level] || ['', r.level];
  const lines = [...(r.launch?.lines || []).map((l) => l.text), ...(r.reasons || []).map((x) => x.text)].filter((v, i, a) => v && a.indexOf(v) === i).slice(0, 6);
  const usd = (v) => (v == null ? 'n/a' : `$${n0(Math.round(v))}`);
  return `<div class="card result">
    <div class="head"><b>${r.symbol ? `$${esc(r.symbol)}` : 'Token'}</b><span class="pill ${tone}"><span class="${tone}">${esc(word)}</span></span></div>
    <div class="meta"><div><span>Liquidity</span><b>${usd(r.liquidityUsd)}</b></div><div><span>Market cap</span><b>${usd(r.mcapUsd)}</b></div><div><span>Age</span><b>${r.ageHours == null ? 'n/a' : r.ageHours < 48 ? `${Math.round(r.ageHours)}h` : `${Math.round(r.ageHours / 24)}d`}</b></div></div>
    ${lines.length ? `<ul class="facts ${tone}">${lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : ''}
    ${r.pending ? '<p class="hint">On-chain read still running. Scan again in a minute for the full result.</p>' : ''}
    ${r.pairUrl ? `<a class="btn ghost" style="display:inline-flex;align-items:center;margin-top:12px" href="${esc(r.pairUrl)}" target="_blank">Open chart</a>` : ''}
  </div>`;
}
function profileHTML(handle, r) {
  const v = r?.verdict;
  if (!v) return `<div class="card result"><span class="muted">Could not read @${esc(handle)}.</span></div>`;
  const rows = (v.card?.rows || []).flatMap((row) => row.lines || []).concat(v.card?.lines || []);
  const lines = [v.detail, ...rows].filter((x, i, a) => x && a.indexOf(x) === i).slice(0, 7);
  return `<div class="card result">
    <div class="head"><b>@${esc(handle)}</b><span class="pill ${esc(v.tone)}"><span class="${esc(v.tone)}">${esc(v.label || 'No flags')}</span></span></div>
    ${lines.length ? `<ul class="facts ${esc(v.tone)}">${lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : '<p class="muted" style="margin:10px 0 0">Nothing on record for this account.</p>'}
    <a class="btn ghost" style="display:inline-flex;align-items:center;margin-top:12px" href="https://x.com/${esc(handle)}" target="_blank">Open profile</a>
  </div>`;
}

/* ---------------- account ---------------- */
async function paintAccount() {
  const {xAccount, activity, lifetime} = await chrome.storage.local.get({xAccount: null, activity: null, lifetime: null});
  $('#me').innerHTML = xAccount
    ? `${face(xAccount.avatar)}<div><b>${esc(xAccount.name || xAccount.handle)}</b><span class="muted">@${esc(xAccount.handle)} · linked from x.com</span></div>`
    : `<span class="ph"></span><div><b>No X account yet</b><span class="muted">Open x.com while signed in to link it</span></div>`;
  $('#a-checked').textContent = n0(activity?.checked || 0);
  $('#a-flagged').textContent = n0(activity?.flagged || 0);
  const st = await send({type: 'stats'});
  $('#a-graph').textContent = n0(st?.users || 0);
  $('#ver').textContent = `Fable ${chrome.runtime.getManifest().version}`;
}
$('#redo').addEventListener('click', () => openSetup());
$('#clear').addEventListener('click', async () => {
  const b = $('#clear span');
  if (b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = 'Tap again to clear'; return; }
  await chrome.storage.local.remove(['activity', 'recent', 'graph', 'xAccount']);
  b.dataset.sure = ''; b.textContent = 'Cleared';
  paintHome(); paintAccount();
});

/* ---------------- first-run setup ---------------- */
let step = 0, pick = 'all';
const paintStep = () => {
  $$('#setup .step').forEach((s) => s.classList.toggle('on', Number(s.dataset.s) === step));
  $$('#setup .steps i').forEach((d, i) => d.classList.toggle('on', i <= step));
};
async function paintSetupX() {
  const {xAccount} = await chrome.storage.local.get({xAccount: null});
  $('#setup-x').innerHTML = xAccount
    ? `${face(xAccount.avatar)}<div><b>@${esc(xAccount.handle)}</b><span>Linked</span></div>`
    : `<span class="ph"></span><div><b>Waiting for X</b><span>Open x.com in this browser</span></div>`;
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

/* ---------------- boot ---------------- */
chrome.storage.sync.get(DEFAULTS, async (s) => {
  S = s;
  paintPower(); paintSettings(); paintHome(); paintAccount(); paintTrending();
  let tab = 'home';
  try { tab = localStorage.getItem('fable.tab') || 'home'; } catch {}
  show(tab);
  const {onboarded} = await chrome.storage.local.get({onboarded: null});
  if (!onboarded) openSetup();
});
chrome.storage.onChanged.addListener((c, area) => {
  if (area === 'local' && (c.activity || c.recent)) paintHome();
  if (area === 'local' && c.xAccount) { paintAccount(); paintSetupX(); }
});
