// DEMO ONLY: invented but consistent backstories for every account, seeded by handle.
// Nothing here is real data. Used when "Demo mode" is on in the popup.
// Each account gets an archetype and several signals; every signal carries the detail shown when it is clicked.
import {SMART} from './smart.js';

const hash = (s) => {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
};
const rng = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const int = (r, a, b) => a + Math.floor(r() * (b - a + 1));
const pickN = (r, a, n) => [...a].sort(() => r() - 0.5).slice(0, n);
const one = (r, a) => a[int(r, 0, a.length - 1)];

const TICKERS = ['FROG', 'MILLI', 'GIGA2', 'PUMPR', 'CATX', 'LAMBO', 'DOGAI', 'SEND', 'RICH', 'MOON', 'BASED', 'CHAD', 'WAGMI', 'PEPE2', 'ZOOM', 'GRIFT', 'NEKO', 'BONKZ', 'TURBO3', 'VIBE', 'MEOW', 'SIGMA'];
const PRODUCTS = ['DEX aggregator', 'Wallet SDK', 'Perps venue', 'Bridge', 'Lending market', 'Launchpad', 'Oracle', 'Indexer', 'Mobile wallet', 'Staking vault', 'Explorer', 'Payments API', 'Agent toolkit', 'Rollup'];
const LINKS = ['Same deployer wallet', 'Funded by the same wallet', 'Promoted every launch', 'Team wallet sold at launch'];
const CHAINS = ['Robinhood Chain', 'Solana', 'Base', 'Ethereum'];
const OLD = ['alphacalls', 'gemhunter', 'nftwhale', 'degenlord', 'cryptoking', 'moonboy', 'shillmaster', 'airdropz', 'signalsvip', '100xcalls'];
const DOX = ['Public founder profile', 'Spoke at Token2049', 'Spoke at ETHDenver', 'Vouched for by 3 smart accounts', 'Former engineer at a major exchange', 'Registered company on the site'];
const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const hex = (h) => `0x${h.toString(16).padStart(8, '0')}${(h * 2654435761 >>> 0).toString(16).padStart(8, '0')}`.slice(0, 18);
const short = (w) => `${w.slice(0, 6)}…${w.slice(-4)}`;
const mcap = (v) => (v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : `$${Math.round(v / 1e3)}K`);

let NAMES = null;
const names = async () => (NAMES ||= await fetch(chrome.runtime.getURL('src/smart-names.json')).then((r) => r.json()).catch(() => ({})));

export async function fakeVerdict(t) {
  const handle = (t.author?.handle || t.id || 'x').toLowerCase();
  const r = rng(hash(handle));
  const roll = r();
  const nm = await names();
  const base = {id: t.id, source: 'demo', confidence: 0.62 + r() * 0.36};
  // never in the future (today is Sep 2026 in demo land)
  const date = (y0 = 2023) => {
    const y = int(r, y0, 2026);
    return `${M[int(r, 0, y === 2026 ? 7 : 11)]} ${int(r, 1, 28)}, ${y}`;
  };
  const recent = () => (r() < 0.3 ? `Aug ${int(r, 24, 31)}, 2026` : `Sep ${int(r, 1, 22)}, 2026`);
  const person = (s) => ({handle: s.handle, name: nm[s.handle] || s.handle, avatar: chrome.runtime.getURL(`icons/smart/${s.handle.toLowerCase()}.jpg`), tag: s.tag, since: `${one(r, M)} ${int(r, 2021, 2025)}`});

  const smart = (a, b) => {
    const n = int(r, a, b);
    const all = pickN(r, SMART, Math.min(n, SMART.length)).map(person);
    return {kind: 'smart', n, people: all.slice(0, 4), all};
  };
  const rugs = (a, b) => {
    const n = int(r, a, b);
    const how = one(r, LINKS);
    const wallet = hex(hash(handle + 'deployer'));
    const items = pickN(r, TICKERS, n).map((x) => {
      const ath = int(r, 400, 9000) * 1e3;
      const drop = int(r, 90, 99);
      return {tk: `$${x}`, chain: one(r, CHAINS), launched: date(2024), ath: mcap(ath), now: mcap(ath * (100 - drop) / 100), drop, life: `${int(r, 6, 70)}h`};
    });
    return {kind: 'rugs', n, how, wallet, walletShort: short(wallet), tokens: items.map((x) => x.tk), items};
  };
  const paid = () => {
    const promos = int(r, 7, 14);
    const list = Array.from({length: promos}, () => {
      const dead = r() < 0.74;
      return {tk: `$${one(r, TICKERS)}`, date: recent(), pct: dead ? -int(r, 86, 99) : int(r, 4, 180), dead, disclosed: r() < 0.12};
    });
    return {kind: 'paid', promos, dead: list.filter((x) => x.dead).length, marks: list.map((x) => x.dead), list};
  };
  const dev = () => {
    const shipped = pickN(r, PRODUCTS, int(r, 2, 4));
    return {kind: 'dev', shipped, years: int(r, 2, 9), commits: int(r, 180, 2400), items: shipped.map((p) => ({name: p, since: `${one(r, M)} ${int(r, 2019, 2025)}`, status: r() < 0.85 ? 'Live' : 'Sunset'}))};
  };
  const doxxed = () => ({kind: 'doxxed', proofs: pickN(r, DOX, 3), role: one(r, ['Founder', 'Lead dev', 'Co-founder'])});
  const anon = () => ({kind: 'anon', note: one(r, ['No public identity for the deployer', 'Team hidden, contract not renounced', 'Dev wallet funded through a mixer'])});
  const renamed = () => {
    const renames = int(r, 2, 5);
    const hist = pickN(r, OLD, renames).map((h) => ({handle: h, until: `${one(r, M)} ${int(r, 2022, 2026)}`}));
    return {kind: 'identity', renames, last: hist[0].handle, hist};
  };
  const fresh = () => ({kind: 'fresh', days: int(r, 6, 60)});
  const since = `${one(r, M)} ${int(r, 2019, 2024)}`;
  const two = (s) => s.people.slice(0, 2).map((p) => p.name).join(', ');
  const card = (rows) => ({type: 'profile', rows, since});

  // 20% builder, half of them doxxed
  if (roll < 0.2) {
    const s = smart(3, 9), d = dev(), dx = r() < 0.55;
    return {...base, tone: 'legit', label: 'Legit', badge: dx ? 'DOXXED' : undefined, detail: `Followed by ${two(s)} and ${s.n - 2} other smart accounts`, faces: s.people.map((p) => p.avatar), card: card(dx ? [doxxed(), s, d] : [s, d])};
  }
  // 12% rising
  if (roll < 0.32) {
    const s = smart(1, 2);
    return {...base, tone: 'legit', label: 'Smart followers', detail: s.n === 1 ? `Followed by ${s.people[0].name}` : `Followed by ${two(s)}`, faces: s.people.map((p) => p.avatar), card: card([s, fresh()])};
  }
  // 14% paid promoter
  if (roll < 0.46) {
    const p = paid();
    const rows = r() < 0.4 ? [p, smart(1, 1), renamed()] : [p, renamed()];
    return {...base, tone: 'kol', label: 'Paid promoter', detail: `${p.promos} paid promos in 30 days · ${p.dead} down 85%+`, stamp: 'SHILL', fade: true, card: card(rows)};
  }
  // 10% linked to rugs, anon team
  if (roll < 0.56) {
    const g = rugs(2, 5);
    return {...base, tone: 'rug', label: 'Linked to rugs', badge: 'ANON DEV', detail: `${g.n} rugged tokens · ${g.how.toLowerCase()}`, stamp: 'RUG', fade: true, card: card([g, anon(), renamed(), fresh()])};
  }
  // 8% mixed
  if (roll < 0.64) {
    const s = smart(2, 4), g = rugs(1, 2);
    return {...base, tone: 'kol', label: 'Mixed signals', detail: `Followed by ${two(s)}, but linked to ${g.n} rug${g.n > 1 ? 's' : ''}`, faces: s.people.map((p) => p.avatar), card: card([s, g])};
  }
  // 6% doxxed memecoin project
  if (roll < 0.7) {
    const dx = doxxed(), s = smart(1, 3);
    return {...base, tone: 'legit', label: 'Doxxed team', badge: 'DOXXED', detail: `${dx.role} publicly identified · ${s.n} smart follower${s.n > 1 ? 's' : ''}`, faces: s.people.map((p) => p.avatar), card: card([dx, s, fresh()])};
  }
  // 6% engagement farm
  if (roll < 0.76) {
    const id = renamed();
    return {...base, tone: 'kol', label: 'Engagement farm', detail: `Renamed ${id.renames} times · recycled money-flex posts`, card: card([id])};
  }
  // 24% nothing known
  return {...base, tone: 'neutral', label: r() < 0.6 ? 'No smart followers' : 'No history yet'};
}
