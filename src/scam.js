// Scam checks read straight off the post: no model, no network, same answer in the extension and the worker.
// Each check fires only on a fact the card can show (a handle, a display name, a link's domain, the words of the ask),
// and each one stays quiet on warnings about scams. A wrong red on a real project is worse than a miss, so every rule
// needs two independent tells before it speaks.
//
//   impersonation   the author copies an official account's name and handle but is a different, small account
//   phishing link   a link whose domain dresses up as a project's (unlswap-claim.xyz, uniswap.claim-drop.top), a
//                   claim link on a throwaway TLD, or a claim link hidden behind a shortener
//   fake giveaway   "send 0.5 ETH, get 1 ETH back" with an address to send to
//   seed phrase ask asks the reader to hand over a seed phrase or private key
//   fake support    "your wallet has been flagged", "wallet validation / rectification", "DM our support on Telegram",
//                   and fund-recovery offers
import {ORGS, PEOPLE, OFFICIAL_ALTS} from './officials.js';

/* ---------------- normalising ---------------- */
// look-alike letters (Cyrillic, Greek, Latin extensions) and the digit swaps handles use
const CONFUSE = {'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x', 'і': 'i', 'ј': 'j', 'ѕ': 's', 'ԁ': 'd', 'һ': 'h', 'ո': 'n', 'ԛ': 'q', 'ԝ': 'w',
  'ο': 'o', 'α': 'a', 'ε': 'e', 'ρ': 'p', 'ν': 'v', 'τ': 't', 'κ': 'k', 'ι': 'i', 'υ': 'u', 'ı': 'i', 'ł': 'l', 'ɑ': 'a', 'ɡ': 'g', 'ʏ': 'y', 'ᴜ': 'u', 'ⅼ': 'l'};
const deconfuse = (s) => s.replace(/[Ͱ-ϿЀ-ԯıłɑɡʏᴜⅼ]/g, (c) => CONFUSE[c] || CONFUSE[c.toLowerCase()] || c);
/** Pure: "𝐔𝐧𝐢𝐬𝐰𝐚𝐩 ✅" -> "uniswap": fancy letters, accents, emoji, spaces and punctuation folded away. */
export const fold = (s) => deconfuse(String(s || '').normalize('NFKC').toLowerCase()).normalize('NFD').replace(/\p{M}/gu, '').replace(/[^a-z0-9]/g, '');
/** Pure: the shape a reader sees: 0/o, 1/l/i, rn/m, vv/w read the same. */
export const skeleton = (s) => fold(s).replace(/rn/g, 'm').replace(/vv/g, 'w').replace(/[0]/g, 'o').replace(/[1il|]/g, 'l').replace(/3/g, 'e').replace(/5/g, 's').replace(/4/g, 'a').replace(/7/g, 't');
const lev = (a, b, max = 2) => {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({length: b.length + 1}, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, cur[j]);
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
};
const n0 = (x) => (x >= 1e6 ? `${(x / 1e6).toFixed(1)}M` : x >= 1e3 ? `${Math.round(x / 1e3)}K` : String(x));

/* ---------------- the protected list ---------------- */
// words that dress a copy up as the brand's support / claim desk
// Not here on purpose: app, hq, labs, live, global, alerts, updates, news, daily (real brands run @sanctumapp-style
// accounts, and trackers call themselves "PumpFun Alerts" without pretending to be the brand)
const AFFIX = 'support|supports|help|helpdesk|helpline|helpcenter|care|customercare|desk|service|services|assist|assistance|claim|claims|airdrop|airdrops|drop|drops|reward|rewards|giveaway|giveaways|gift|gifts|bonus|promo|verify|verification|validate|rectify|fix|recover|recovery|refund|refunds|admin|admins|mod|mods|team|official|offical|officiel|offcl';
const AFFIX_RX = new RegExp(`^(?:${AFFIX})+$`);
// a display name may also carry the brand's own company words ("Uniswap Labs", "Phantom Wallet"): names only, a handle
// with them is often the brand's real second account
const COMPANY = 'labs|wallet|app|hq|foundation|global|exchange|protocol|finance|network|dao|io|xyz|fi';
const NAME_AFFIX_RX = new RegExp(`^(?:${AFFIX}|${COMPANY})+$`);
// in a handle the company words count only next to a desk word ("UniswapLabsHelp"; "sanctumapp" alone is Sanctum's own)
const HANDLE_REST_RX = new RegExp(`^(?:${AFFIX}|${COMPANY})*(?:${AFFIX})(?:${AFFIX}|${COMPANY})*$`);
// plain words a brand key can collide with in someone's own handle or domain
const GENERIC_KEYS = new Set(['crypto', 'wallet', 'chain', 'exchange', 'finance', 'network', 'protocol', 'labs', 'official', 'trade', 'swap', 'money', 'markets', 'app']);
const org = (r) => {
  const [handle, name, k, domains = '', flags = ''] = r;
  const doms = domains.split(/\s+/).filter(Boolean);
  const keys = new Set([fold(name), ...doms.map((d) => fold(d.split('.').slice(-2, -1)[0]))].filter((x) => x.length >= 4 && !GENERIC_KEYS.has(x)));
  // "okx", "gmx": three-letter brands only ever match as a whole label
  if (fold(name).length === 3) keys.add(fold(name));
  return {handle, name, followers: k * 1000, domains: doms, keys: [...keys], word: flags.includes('w'), org: true};
};
const OFF = [...ORGS.map(org), ...PEOPLE.map(([handle, name, k]) => ({handle, name, followers: k * 1000, domains: [], keys: [], word: false, org: false}))];
const OFFICIAL_HANDLES = new Set([...OFF.map((o) => o.handle.toLowerCase()), ...OFFICIAL_ALTS.map((h) => h.toLowerCase())]);
for (const o of OFF) {
  o.h = fold(o.handle); o.hs = skeleton(o.handle); o.n = fold(o.name);
  o.core = o.h.replace(/^(?:the|real|0x)/, '').replace(/(?:official|offcl|hq|app|global|xyz|io|so|fi|finance|protocol|exchange|network|labs|dotfun|fun|_)+$/g, '') || o.h;
  o.cores = [...new Set([o.h, o.core])].map((c) => [c, skeleton(c)]);
}
// official domains: never a lookalike of anything
const ALLOW = new Set([...OFF.flatMap((o) => o.domains),
  'x.com', 'twitter.com', 't.co', 't.me', 'telegram.me', 'telegram.org', 'discord.gg', 'discord.com', 'youtube.com', 'youtu.be', 'github.com', 'medium.com',
  'mirror.xyz', 'paragraph.com', 'substack.com', 'notion.so', 'notion.site', 'gitbook.io', 'google.com', 'forms.gle', 'linktr.ee', 'dextools.io', 'birdeye.so',
  'solscan.io', 'basescan.org', 'bscscan.com', 'arbiscan.io', 'blockscout.com', 'debank.com', 'defillama.com', 'zapper.xyz', 'layer3.xyz', 'zealy.io',
  'tensor.trade', 'photon-sol.tinyastro.io', 'blockchain.com', 'coinbase.com', 'luma.com', 'lu.ma', 'apple.com', 'instagram.com', 'tiktok.com', 'twitch.tv', 'kick.com', 'reddit.com', 'wikipedia.org']);
export const OFFICIAL_COUNT = OFF.length;
const KEYS = new Set(OFF.flatMap((o) => o.keys));

/** Pure: registrable domain ("app.unlswap-claim.xyz" -> "unlswap-claim.xyz"; free hosts keep the site's own label). */
const HOSTED = /\.(?:eth\.limo|eth\.link|vercel\.app|netlify\.app|pages\.dev|web\.app|firebaseapp\.com|github\.io|gitbook\.io|webflow\.io|framer\.(?:website|app|ai|media)|glitch\.me|repl\.co|replit\.app|herokuapp\.com|surge\.sh|onrender\.com|workers\.dev|r2\.dev|fleek\.co|on-fleek\.app|4everland\.app|wixsite\.com|carrd\.co|notion\.site|super\.site|blogspot\.com|wordpress\.com|weebly\.com|square\.site|azurewebsites\.net|appspot\.com|000webhostapp\.com|(?:co|com|org|net|gov|ac|edu)\.[a-z]{2})$/;
export const regDomain = (host) => {
  const h = String(host || '').toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  const m = h.match(HOSTED);
  const keep = m ? m[0].split('.').length : 1;
  return h.split('.').slice(-(keep + 1)).join('.');
};
const hostOf = (u) => { try { return new URL(/^[a-z]+:\/\//i.test(u) ? u : `https://${u}`).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; } };
const TLDS = 'com|net|org|io|xyz|app|fi|finance|top|click|icu|buzz|cfd|sbs|rest|monster|cyou|quest|bond|site|online|live|pro|info|biz|cc|co|me|gg|so|ai|fun|lol|world|website|space|store|shop|link|network|exchange|trade|dev|page|vip|tech|cloud|digital|zone|ltd|us|ws|tk|ml|ga|cf|gq|pw|to|limo|money|cash|gift|win|bet|ink|one|global|foundation|group|events?|support|help|center|services?|claims?|wallet|claim|rewards?|airdrop|finance|family|market|markets|capital|fund|run|now|today|club|sh|ly|ag|am|ci|lat|beauty|hair|skin|makeup|autos|boats|yachts|homes|motorcycles';
const TEXT_DOMAIN = new RegExp(`(?:^|[^\\w@.-])((?:[a-z0-9](?:[a-z0-9-]{0,40}[a-z0-9])?\\.){1,4}(?:${TLDS}))(?![\\w-])`, 'gi');
// a link shortener hides where it goes; X already expands its own t.co links
const SHORTENER = /^(?:bit\.ly|tinyurl\.com|cutt\.ly|rb\.gy|is\.gd|t\.ly|shorturl\.at|rebrand\.ly|ow\.ly|s\.id|v\.gd|tiny\.cc|bit\.do|goo\.su|clck\.ru|u\.to|shorturl\.gg|tiny\.one|rebrandly\.com|short\.io|t2m\.io|urlz\.fr|lnkd\.in|bl\.ink)$/;
// throwaway TLDs drainer kits register in bulk; rare on real crypto sites
const BAD_TLD = /\.(?:top|click|icu|buzz|cfd|sbs|rest|monster|cyou|quest|bond|lat|tk|ml|ga|cf|gq|pw|beauty|hair|skin|makeup|autos|boats|yachts|homes|motorcycles|zip|mov)$/;
// words a fake claim / support site puts in its domain. STRONG ones count anywhere (claim.x.com, x-claim.com); the
// weak ones only as part of the site's own name (uniswap-app.xyz), never as a subdomain (app.weex.tech is everyone's)
const CLAIM_STRONG = /^(?:claims?|airdrops?|rewards?|bonus|gifts?|giveaways?|eligib\w*|allocations?|verify|verification|validat\w*|synchroni[sz]e|restore|recover\w*|rectif\w*|migrat\w*|redeem|refunds?|compensation|claimdrop|airdropclaim)$/;
const CLAIM_WEAK = /^(?:drops?|sync|unlock|connect|dapps?|portal|snapshot|checker|distribution|whitelist|support|helpdesk|help|fix|secure|login|auth|app|web3?|official|free)$/;
const CLAIM_WORD = {test: (w) => CLAIM_STRONG.test(w) || CLAIM_WEAK.test(w)};

/* ---------------- text patterns ---------------- */
// the post is a warning or a report about a scam, not the scam itself
const WARNS = /\b(?:phish\w*|scam\w*|fake|fraud\w*|drainers?|impersonat\w*|beware|be careful|warning|psa|heads up|do not (?:click|connect|sign|interact|share|send|trust|fall)|don'?t (?:click|connect|sign|interact|share|send|trust|fall)|never (?:share|send|give|enter|type|connect|click|sign)|avoid|report(?:ed|ing)?|not (?:affiliated|official|real|legit)|malicious|stay safe|be safe|lost \$?[\d,.]+\s*[km]?|got (?:drained|scammed|hacked)|was (?:drained|scammed|hacked))\b/i;
// claim language in the post
const CLAIM_TEXT = /\b(?:claim (?:your|now|here|it|them|free|the (?:airdrop|drop|tokens?|rewards?))|claim(?:ing)? (?:is|now) (?:live|open)|airdrop (?:is |now )?(?:live|open)|(?:check|verify|see) (?:your )?(?:eligibility|allocation)|eligible (?:wallets|users|addresses|holders)|connect (?:your )?wallet (?:to|and) (?:claim|receive|check|verify|get|unlock)|(?:receive|get|grab) your (?:airdrop|allocation|rewards?|tokens)|claim (?:portal|page|link|site)|allocations? (?:is |are )?(?:live|ready|open))\b/i;
// who the post is for: a reply ("@user ...") is where reply-guy scams live
const isReply = (t) => !!(t.inReplyTo || t.in_reply_to || /^\s*@\w{1,15}\b/.test(String(t.text || '')));
const ADDRESS = /\b(?:0x[a-fA-F0-9]{40}|bc1[a-z0-9]{25,60}|[13][a-km-zA-HJ-NP-Z1-9]{25,34}|T[1-9A-HJ-NP-Za-km-z]{33}|[1-9A-HJ-NP-Za-km-z]{32,44})\b/;
const COINS = 'eth|btc|sol|bnb|usdt|usdc|xrp|doge|trx|ton|matic|pol|avax|ada|ltc|sui|bitcoin|ethereum|solana';

// Fake giveaway: send funds, get more back 
// what comes back must be the reader's own money doubled ("2x back", "double the amount"), never points, XP or a boost
const DOUBLE = [
  new RegExp(`\\b(?:send|deposit|transfer)\\b[^.!?\\n]{0,80}?\\b(?:double|2x|x2|3x|twice|triple)\\b[^.!?\\n]{0,25}?\\b(?:back|in return|the amount|what you (?:sent|send|deposit(?:ed)?))\\b`, 'i'),
  new RegExp(`\\b(?:send|deposit|transfer)\\b[^.!?\\n]{0,80}?\\b(?:get|receive|send|sent)\\b[^.!?\\n]{0,10}?\\bback\\b[^.!?\\n]{0,15}?\\b(?:double|2x|x2|twice|triple|3x)\\b`, 'i'),
  new RegExp(`\\bdoubl(?:e|ing)\\b[^.!?\\n]{0,30}?\\b(?:every|all|any|each)\\b[^.!?\\n]{0,20}?\\b(?:deposits?|transactions?|payments?|transfers?|${COINS})\\b[^.!?\\n]{0,30}?\\b(?:sent|received|to (?:this|the|our|my) (?:address|wallet))\\b`, 'i'),
  new RegExp(`\\bdoubl(?:e|ing)\\b[^.!?\\n]{0,30}?\\b(?:every|all|any|each)\\b[^.!?\\n]{0,20}?\\b(?:deposits?|transactions?|payments?|transfers?)\\b`, 'i'),
];
// "send 0.5 ETH ... get 1 ETH back": both amounts named, the second one bigger
const SEND_GET = new RegExp(`\\b(?:send|deposit|transfer)\\s+(\\d+(?:[.,]\\d+)?)\\s*\\$?(${COINS})\\b[^.!?\\n]{0,80}?\\b(?:get|receive|return)\\s+(\\d+(?:[.,]\\d+)?)\\s*\\$?(${COINS})\\b`, 'i');

// Seed phrase / private key ask
const SEED = '(?:seed ?phrase|secret (?:recovery )?phrase|recovery (?:phrase|words|seed)|mnemonic(?: phrase)?|private ?keys?|(?:12|24|twelve|twenty[- ]four)[- ]words?(?: (?:seed|phrase|recovery (?:phrase|words)))?|wallet (?:phrase|key)|pass ?phrase|keystore(?: file| json)?)';
// the seed words must be the direct object: "DM us the 12 word seed phrase", "send your private key to support".
// Only a recipient and a determiner may sit between the verb and the words ("Post-mortem: private key ..." is no ask).
const RECIP = '(?:it|them|us|me|him|her|over|to (?:us|me|him|her|the \\w+|our \\w+)|with (?:us|me|the \\w+|our \\w+)|our (?:team|support|admins?|agents?|moderators?|mods?)|the (?:team|support|admins?|agents?|moderators?|mods?|bot|form))';
const DET = "(?:your|ur|the|a|this|that|my|full|complete|entire|wallet'?s?|(?:12|24)[- ]word|recovery)";
// verbs that hand the words to someone else
const GIVE = new RegExp(`\\b(send|share|dm|message|submit|provide|give|drop|forward|tell|reply with|text|email|whatsapp)(?:\\s+${RECIP}){0,2}\\s+(?:${DET}\\s+){0,3}${SEED}`, 'i');
// verbs that type the words into something: only a scam when it is a form / site / link, or it is "to claim / verify"
// (importing a key into a wallet app or a trading bot is how those products work, not a scam by itself)
const TYPE_IN = new RegExp(`\\b(enter|input|type|paste|fill in|upload)\\s+(?:${DET}\\s+){0,3}${SEED}\\b[^.!?\\n]{0,40}?\\b(?:(?:on|in|into|at|via|through|using) (?:the|our|this|that) (?:form|site|website|link|page|portal|dapp)|(?:here|below)\\b|to (?:claim|verify|validate|sync|synchroni[sz]e|restore access|unlock|receive|fix|rectify|recover|continue|withdraw|activate|whitelist))`, 'i');
// "never share ...", "anyone who asks for ...": a warning, not an ask
const NEGATED = /(?:\bnever\b|\bdon'?t\b|\bdo not\b|\bwon'?t\b|\bwill not\b|\bno one\b|\bnobody\b|\bnot\b|\bshouldn'?t\b|\bnor\b|\bcan'?t\b|\bcannot\b|\bwithout\b|\bno need\b|\bno (?:legit|real|official)\b|\b(?:anyone|anybody|someone|somebody|whoever|if (?:someone|anyone|they|a (?:site|dm|bot|person)))\b[^.!?\n]{0,40}\b(?:asks?|tells?|requests?|wants?)\b|\bask(?:s|ed|ing)? (?:you )?(?:for|to)\b)[^.!?\n]{0,50}$/i;

// Fake support
const FLAGGED = /\byour (?:wallet|account|funds|assets|address|tokens|nft|metamask|phantom|trust ?wallet|ledger|coinbase|binance)\b[^.!?\n]{0,25}?\b(?:has|have|was|were|is|are|got|been)\b[^.!?\n]{0,15}?\b(?:flagged|compromised|suspended|restricted|blacklisted|locked|frozen|blocked|disabled|deactivated|at risk|under review|marked)\b/i;
// drainer-kit wording. Not here on purpose: "sync your wallet" (portfolio apps), "wallet verification" (whitelist bots),
// "wallet migration" (real token migrations), "dapp portal" (a real product name)
const DRAIN_VOCAB = /\b(?:rectif(?:y|ication) (?:of )?(?:your|ur) (?:wallet|account|transactions?|tokens|assets)|wallet (?:validation|rectification|synchroni[sz]ation)|validate (?:your )?wallet|(?:sync|synchroni[sz]e|validate|rectify|restore) (?:your )?wallet (?:via|at|on|using|through|with) (?:the |this |our )?(?:link|dapp|portal|site|bot|form)|decentrali[sz]ed (?:dapp|portal) to (?:fix|resolve|rectify|sync|validate)|(?:resolve|fix) (?:your )?(?:wallet|transaction|pending transaction|stuck transaction|glitch|issue|problem) (?:via|at|using|through|on|with) (?:the |this |our )?(?:link|dapp|portal|site|bot|form))\b/i;
// real responders a victim may be pointed to: never a recovery scam
const RESPONDERS = /\b(?:seal[\s_-]?911|security alliance|ic3(?:\.gov)?|police|law enforcement|chainabuse|zachxbt|fbi|report (?:it|this) to)\b/i;
const SUPPORT_DM = /\b(?:dm|message|contact|reach(?: out)?(?: to)?|write to|chat with|talk to|text|email|open a ticket(?: with)?|file a (?:ticket|complaint)(?: with| at)?|submit a (?:ticket|request)(?: to| at)?)\s+(?:our|the|their|official|live|a)?\s*(?:support|help ?desk|help ?cent(?:er|re)|customer (?:care|service|support)|support (?:team|agent|desk|line|portal|center)|technical (?:team|support)|tech (?:team|support)|admins?|live agent|live chat|recovery (?:team|agent|expert))\b/i;
const OFF_CHANNEL = /\b(?:t\.me\/\w+|telegram|whatsapp|wa\.me|signal app|\+\d[\d\s-]{7,})\b|@[A-Za-z0-9_]{3,15}|\b[a-z0-9._%+-]+@(?:gmail|outlook|proton(?:mail)?|yahoo|hotmail)\.[a-z]+\b/i;
// recovery offers 
const RECOVER = /\b(?:recover(?:ed|y|s|ing)?|retriev(?:e|ed|al|ing)|got (?:all |every(?:thing| cent) )?(?:of )?(?:it|them|my \w+(?: \w+)?|everything) back|get (?:it|them|your \w+(?: \w+)?) back|trace (?:your|the|my) (?:funds|crypto|coins|money|assets))\b/i;
const LOSS = /\b(?:lost|stolen|scammed|hacked|drained|swindled|rugged|missing)\b/i;
const HIRE = /\b(?:fee|upfront|expert|specialist|hacker|agent|recovery (?:team|service|pro|expert|agent|firm)|legit|trusted|reliable|helped me|did it for me|100%|guaranteed)\b/i;
const CONTACT = /\b(?:dm|contact|reach(?: out)?|message|inbox|hit (?:up|them up)|write to|whatsapp|telegram|t\.me|email)\b/i;
const RECOVERY_BIO = /\b(?:(?:fund|funds|asset|crypto|bitcoin|btc|wallet|scam|money) recovery|recover(?:y|ing)? (?:of )?(?:lost|stolen|scammed) (?:funds|crypto|assets|money|coins|wallets?)|(?:recovery|forensic) (?:expert|specialist|agent)|hack(?:er)?s? for hire|ethical hacker)\b/i;
const PARODY = /\b(?:parody|fan ?(?:account|page|club)|fanpage|not affiliated|unofficial|satire|commentary account|impersonat\w*)\b/i;

/* ---------------- 1. impersonation ---------------- */
// h = {hf: fold(handle), hs: skeleton(handle), bare: hf without leading / trailing digits}
function handleMatch({hf, hs, bare}, o) {
  // the exact handle never gets here (OFFICIAL_HANDLES): same letters with other underscores or look-alike letters do
  if (hf === o.h || hs === o.hs) return 'lookalike';
  if (bare === o.h && bare !== hf) return 'digits';
  for (const [core, coreS] of o.cores) {
    if (core.length < 3) continue;
    const i = hf.indexOf(core);
    if (i >= 0) {
      const rest = (hf.slice(0, i) + hf.slice(i + core.length)).replace(/\d+/g, '');
      if (rest && (AFFIX_RX.test(rest) || HANDLE_REST_RX.test(rest))) return 'affix';
      if (!rest && bare !== hf) return 'digits';
    }
    const i2 = core.length >= 5 ? hs.indexOf(coreS) : -1;
    if (i2 >= 0) {
      const rest = (hs.slice(0, i2) + hs.slice(i2 + coreS.length)).replace(/\d+/g, '');
      if (!rest || AFFIX_RX.test(rest)) return 'lookalike';
    }
  }
  // one letter off (a doubled or dropped letter), long handles only
  if (o.hs.length >= 7 && !o.word && lev(hs, o.hs, 1) === 1 && hs.replace(/s$/, '') !== o.hs) return 'typo';
  return null;
}
const nameMatch = (n, o) => {
  if (!n) return null;
  if (n === o.n || n === o.h) return 'same';
  for (const key of new Set([o.n, o.h, o.core])) {
    if (key.length < 4) continue;
    if (n.startsWith(key) && NAME_AFFIX_RX.test(n.slice(key.length).replace(/\d+/g, ''))) return 'affix';
    if (n.endsWith(key) && NAME_AFFIX_RX.test(n.slice(0, -key.length).replace(/\d+/g, ''))) return 'affix';
  }
  return null;
};
const ageDays = (a, facts) => facts?.accountAgeDays ?? (Date.parse(a?.created_at || '') ? Math.floor((Date.now() - Date.parse(a.created_at)) / 864e5) : null);

/** Pure: the official account this author copies, or null. */
export function impersonation(t, facts = {}) {
  const a = t.author || {};
  if (!a.handle || t.profile && !a.name) return null;
  const hl = String(a.handle).toLowerCase();
  if (OFFICIAL_HANDLES.has(hl) || facts.trusted) return null;
  if (['Business', 'Government'].includes(a.vtype)) return null; // X checked the organisation
  if (PARODY.test(`${a.description || ''} ${a.name || ''}`)) return null;
  const n = fold(a.name);
  const fol = typeof a.followers === 'number' ? a.followers : null;
  const age = ageDays(a, facts);
  const text = String(t.text || '');
  const intent = CLAIM_TEXT.test(text) || /\b(?:claim|airdrop|support|dm|connect|wallet|giveaway|reward|eligib|allocation|verify|validate|link|click|visit)\b/i.test(text) || (t.urls?.length || 0) > 0;
  let best = null;
  const hf = fold(a.handle);
  const who = {hf, hs: skeleton(a.handle), bare: hf.replace(/^\d+|\d+$/g, '')};
  for (const o of OFF) {
    // a real secondary account is usually far bigger than a copy: the copy has a sliver of the original's reach
    const cap = Math.min(Math.max(2000, o.followers * 0.01), 50000);
    if (fol != null && fol >= cap) continue;
    const hm = handleMatch(who, o);
    const nm = nameMatch(n, o);
    let how = null;
    // A. handle and display name both copy it
    if (hm && nm) how = hm;
    // B. same display name as a brand, a small new account, and the post is a claim / support / link post
    else if (!hm && o.org && !o.word && nm && fol != null && fol < 1000 && age != null && age < 90 && intent) how = 'name';
    // B'. a support-desk name ("MetaMask Support") on a handle that is not the brand's
    else if (!hm && o.org && !o.word && nm === 'affix' && /(?:support|help|care|desk|service|assist|claim|airdrop|reward|recover|refund|validat|rectif)/.test(n) && (fol == null || fol < 5000)) how = 'support-name';
    if (!how) continue;
    const score = (how === 'name' ? 1 : how === 'support-name' ? 2 : 3) + (nm === 'same' ? 1 : 0);
    if (!best || score > best.score) best = {o, how, nm, score};
  }
  if (!best) return null;
  const {o, how} = best;
  const lines = [
    how === 'name' || how === 'support-name' ? `Uses the name "${a.name}" but the account is @${a.handle}, not @${o.handle}` : `Handle @${a.handle} copies @${o.handle} and the name "${String(a.name || '').trim()}" copies "${o.name}"`,
    fol != null ? `${n0(fol)} follower${fol === 1 ? '' : 's'}${o.followers ? ` vs ${n0(o.followers)} for the real @${o.handle}` : ''}` : null,
    age != null ? (age === 0 ? 'Account created today' : `Account created ${age} day${age === 1 ? '' : 's'} ago`) : null,
    o.domains[0] ? `The real ${o.name} site is ${o.domains[0]}` : null,
  ].filter(Boolean);
  // stamp only the clearest copies: handle + name both copied, and a small or new account doing claim / link / support talk
  const clear = how !== 'name' && best.nm && (intent || isReply(t) || (age != null && age < 90));
  return {kind: 'impersonation', label: 'Impersonator', stat: `mimics @${o.handle}`, detail: lines[0], lines, stamp: clear ? 'FAKE' : undefined, confidence: how === 'name' ? 0.85 : 0.95, target: o.handle};
}

/* ---------------- 2. phishing links ---------------- */
function linkHosts(t) {
  const hosts = new Map(); // host -> shown form
  for (const u of t.urls || []) { const h = hostOf(u); if (h) hosts.set(h, h); }
  const text = String(t.text || '').replace(/https?:\/\/\S+/g, (u) => { const h = hostOf(u); if (h) hosts.set(h, h); return ' '; });
  for (const m of text.matchAll(TEXT_DOMAIN)) { const h = hostOf(m[1]); if (h && !/^\d/.test(h) && h.includes('.')) hosts.set(h, h); }
  return [...hosts.keys()];
}
// which official brand a domain dresses up as, and how
// a claim word glued to the brand inside one label: "uniswapclaim", "evalponsclaim", "claimmetamask"
const GLUED = /(?:claims?|airdrops?|rewards?|giveaways?|eligib\w*|allocations?|verify|validat\w*|rectif\w*|restore|recover\w*|refunds?|migrat\w*|support|helpdesk|bonus|redeem|drops?)/;
const glued = (label, key) => {
  const i = label.indexOf(key);
  if (i < 0 || label === key) return false;
  const after = label.slice(i + key.length), before = label.slice(0, i);
  return new RegExp(`^${GLUED.source}`).test(after) || new RegExp(`${GLUED.source}$`).test(before);
};
function lookalike(host) {
  const reg = regDomain(host);
  if (ALLOW.has(reg) || ALLOW.has(host)) return null;
  // the site's own labels, subdomains included: never the TLD or a free host's suffix (vercel.app, eth.limo)
  const site = reg.split('.')[0];
  const labels = (host.slice(0, host.length - reg.length) + site).split('.').filter(Boolean);
  const parts = labels.flatMap((l) => l.split('-')).filter(Boolean);
  const siteParts = site.split('-').filter(Boolean);
  let best = null;
  for (const o of OFF) {
    if (!o.org) continue;
    for (const key of o.keys) {
      for (const p of parts) {
        const pf = fold(p);
        let how = null;
        if (pf === key) how = 'brand';
        else if (key.length >= 5 && skeleton(pf) === skeleton(key)) how = 'homoglyph';
        else if (key.length >= 4 && glued(pf, key)) how = 'brand';
        // one letter off a long brand name, as a whole label (uniswapp.org, metamsk.io); two letters off is a different
        // word (genlayer, bubblewars), and one word of a longer name is just a word ("doppler-finance" is not binance)
        else if (key.length >= 7 && !o.word && !p.includes('-') && labels.includes(p) && lev(pf, key, 1) === 1 && pf.replace(/s$/, '') !== key && !KEYS.has(pf)) how = 'typo';
        if (how && (!best || (how === 'homoglyph' && best.how !== 'homoglyph'))) best = {o, key, how, part: pf};
      }
    }
  }
  if (!best) return null;
  const claimy = parts.some((p) => CLAIM_STRONG.test(fold(p))) || (siteParts.length > 1 && siteParts.some((p) => CLAIM_WEAK.test(fold(p)))) || glued(best.part, best.key);
  // brand.other-tld (weex.tech, binance.info): often the brand's own second domain, so only a claim subdomain counts
  const sameName = fold(site) === best.key;
  return {...best, reg, claimy: sameName ? parts.some((p) => CLAIM_STRONG.test(fold(p))) : claimy};
}

/** Pure: a phishing link in the post, or null. */
export function phishing(t, facts = {}) {
  const text = String(t.text || '');
  if (WARNS.test(text)) return null;
  const hosts = linkHosts(t);
  if (!hosts.length) return null;
  const authorKey = fold(t.author?.handle);
  const claimText = CLAIM_TEXT.test(text);
  const walletText = /\b(?:connect (?:your )?wallet|wallet|airdrop|claim|reward|allocation|eligib\w*|mint|token)\b/i.test(text);
  for (const host of hosts) {
    const reg = regDomain(host);
    if (ALLOW.has(reg) || ALLOW.has(host)) continue;
    const lk = lookalike(host);
    if (lk) {
      const {o, how} = lk;
      // the brand's own account never phishes itself (a new domain of theirs is theirs)
      if (fold(o.handle) === authorKey || OFFICIAL_HANDLES.has(String(t.author?.handle || '').toLowerCase())) continue;
      // proof: a look-alike spelling (unlswap, rnetamask) is enough; the brand's own word (phantom-claim.app) needs a
      // claim word in the domain; a one-letter typo also needs claim or wallet talk in the post
      const mentioned = new RegExp(`(?<![\\w@])(?:@${o.handle}|${o.name.replace(/[^A-Za-z0-9 ]/g, '').replace(/ /g, '\\s?')}|${o.keys[0] || o.h})(?!\\w)`, 'i').test(text);
      const ok = how === 'homoglyph' ? (!o.word || lk.claimy || claimText)
        : how === 'brand' ? lk.claimy && (!o.word || mentioned || claimText || BAD_TLD.test(reg))
          : how === 'typo' ? (lk.claimy || claimText) : false;
      if (!ok) continue;
      const real = o.domains[0];
      return {kind: 'phishing', label: 'Phishing link', stat: `${reg} is not ${real}`, confidence: how === 'homoglyph' ? 0.97 : 0.93, stamp: 'SCAM',
        detail: `The link goes to ${reg}, which ${how === 'homoglyph' ? `fakes ${o.name}'s name with look-alike letters` : how === 'typo' ? `misspells ${o.name}'s name` : `puts ${o.name}'s name on a domain ${o.name} does not own`}. The real ${o.name} site is ${real}`,
        lines: [`Link: ${host}`, how === 'homoglyph' ? `Look-alike spelling of ${o.name}` : how === 'typo' ? `One letter off ${o.name}` : `Uses the name ${o.name} on a domain ${o.name} does not own`, `The real ${o.name} site is ${real}`, ...(lk.claimy ? ['The domain is dressed up as a claim / support page'] : [])]};
    }
    // a claim page on a throwaway TLD ("claim-rewards.top") with claim talk in the post
    const labels = host.split('.').slice(0, -1).join('-').split('-');
    if (BAD_TLD.test(reg) && labels.some((p) => CLAIM_STRONG.test(fold(p))) && (claimText || walletText)) {
      return {kind: 'phishing', label: 'Phishing link', stat: `${reg} claim page`, confidence: 0.9,
        detail: `Sends readers to claim on ${reg}, a throwaway .${reg.split('.').pop()} domain`,
        lines: [`Link: ${host}`, `.${reg.split('.').pop()} is a throwaway domain drainer kits register in bulk`, 'The post asks readers to claim or connect a wallet there']};
    }
    // a claim link hidden behind a shortener
    if (SHORTENER.test(host) && claimText && !isOwnish(t)) {
      return {kind: 'phishing', label: 'Phishing link', stat: `claim link hidden by ${host}`, confidence: 0.85,
        detail: `The claim link is hidden behind ${host}, so the real site is not shown`,
        lines: [`Link: ${host} (a link shortener)`, 'The post asks readers to claim or connect a wallet through it', 'Real claims link to the project\'s own site']};
    }
  }
  // "Uniswap airdrop is live, claim here: some-site.xyz" from someone who is not Uniswap, in a reply or from a new account
  const brand = claimText && brandNamed(text);
  if (brand && !isOwnish(t)) {
    const a = t.author || {};
    const age = ageDays(a, facts);
    const small = (typeof a.followers === 'number' && a.followers < 1000) || (age != null && age < 60);
    for (const host of hosts) {
      const reg = regDomain(host);
      if (ALLOW.has(reg) || ALLOW.has(host) || SHORTENER.test(host) || brand.domains.some((d) => reg === regDomain(d))) continue;
      if (fold(brand.handle) === fold(a.handle) || OFFICIAL_HANDLES.has(String(a.handle || '').toLowerCase())) break;
      if (!(isReply(t) && small)) continue;
      return {kind: 'phishing', label: 'Phishing link', stat: `${reg} is not ${brand.domains[0]}`, confidence: 0.88,
        detail: `Says the ${brand.name} claim is live but links to ${reg}. The real ${brand.name} site is ${brand.domains[0]}`,
        lines: [`Link: ${host}`, `${brand.name}'s own site is ${brand.domains[0]}`, `Posted as a reply by a ${typeof a.followers === 'number' ? `${n0(a.followers)}-follower` : 'new'} account that is not @${brand.handle}`]};
    }
  }
  return null;
}
// the post links the author's own site (royalty.band from @royaltymsc): a project talking about itself
const isOwnish = (t) => {
  const who = [fold(t.author?.handle), fold(t.author?.name)].filter((x) => x.length >= 3);
  return linkHosts(t).some((h) => { const root = fold(regDomain(h).split('.')[0]); return root.length >= 3 && who.some((w) => w.includes(root) || root.includes(w)); });
};
// the brand is the one whose claim the post announces ("Uniswap airdrop is live", "claim for @Uniswap holders"), not a
// chain it runs on ("a launchpad on Robinhood Chain ... $TESS airdrop is open")
const brandNamed = (text) => {
  for (const o of OFF) {
    if (!o.org || o.word || !o.domains.length) continue;
    const b = `(?:@${o.handle}|${o.name.replace(/[^A-Za-z0-9 ]/g, '').replace(/ /g, '\\s?')})`;
    if (new RegExp(`(?<![\\w@])${b}(?!\\w)(?:'s)?\\s+(?:\\$[A-Za-z]{2,10}\\s+|season \\d+\\s+|s\\d\\s+|token\\s+)?(?:airdrop|claim|allocation|rewards?|drop)\\b|\\b(?:airdrops?|claims?|allocations?|rewards?) (?:for|of|from) ${b}(?!\\w)`, 'i').test(text)) return o;
  }
  return null;
};

/* ---------------- 3. classic scam posts ---------------- */
/** Pure: "send X, get 2X back" with somewhere to send it. */
export function fakeGiveaway(t) {
  const text = String(t.text || '');
  if (WARNS.test(text) || /\b(?:real|legit|official) giveaways? never\b/i.test(text)) return null;
  const sg = text.match(SEND_GET);
  const numeric = sg && sg[2].toLowerCase() === sg[4].toLowerCase() && parseFloat(sg[3].replace(',', '.')) > parseFloat(sg[1].replace(',', '.'));
  if (!numeric && !DOUBLE.some((rx) => rx.test(text))) return null;
  // somewhere to send it: an address in the post, or "the address below / in bio". A link alone is not enough (casino and
  // exchange deposit bonuses link to their sites)
  const where = ADDRESS.test(text) || /\b(?:address|wallet) (?:below|above|in (?:my |the |our )?bio|pinned|in (?:the )?(?:replies|comments))\b/i.test(text);
  if (!where) return null;
  if (/\b(?:points?|xp|boost(?:ed)?|multiplier|leverage|odds|tickets?|entries|spins?|miles|apy|apr)\b/i.test(text)) return null;
  return {kind: 'giveaway', label: 'Fake giveaway', stat: numeric ? `send ${sg[1]} ${sg[2].toUpperCase()}, get ${sg[3]} back` : 'send crypto, get 2x back', confidence: 0.97, stamp: 'SCAM',
    detail: 'Asks readers to send crypto to get more back. Real giveaways never ask for funds first',
    lines: ['Asks readers to send crypto first and promises more back', ADDRESS.test(text) ? 'Gives an address to send it to' : 'Points to an address to send it to', 'Nothing sent to a "doubling" address comes back']};
}

/** Pure: an ask for the reader's seed phrase or private key. */
export function seedAsk(t) {
  const text = String(t.text || '').replace(/[’‘]/g, "'");
  for (const rx of [GIVE, TYPE_IN]) {
    const m = rx.exec(text);
    if (!m) continue;
    const before = text.slice(Math.max(0, m.index - 80), m.index + (m[1] ? m[0].indexOf(m[1]) : 0));
    if (NEGATED.test(before) || NEGATED.test(m[0].slice(0, m[0].search(new RegExp(SEED, 'i'))))) continue;
    if (/\b(?:scam\w*|phish\w*|fake|beware|warning|psa|drain\w*|stole\w*|leak\w*)\b/i.test(text) && !/\b(?:support|validate|verify|claim|sync|rectif)/i.test(text)) continue;
    const what = /private ?key|keystore/i.test(m[0]) ? 'private key' : 'seed phrase';
    return {kind: 'seed', label: 'Seed phrase ask', stat: `asks for your ${what}`, confidence: 0.98, stamp: 'SCAM',
      detail: `Asks for your ${what}. Anyone who has it can empty the wallet, and no real team or support ever asks for it`,
      lines: [`Asks readers to hand over a ${what}`, 'Whoever holds it controls every coin in the wallet', 'Real teams, wallets and support desks never ask for it']};
  }
  return null;
}

/** Pure: fake support desks, "wallet validation" drainers and fund-recovery offers. */
export function fakeSupport(t) {
  const text = String(t.text || '').replace(/[’‘]/g, "'");
  const a = t.author || {};
  const official = OFFICIAL_HANDLES.has(String(a.handle || '').toLowerCase());
  const small = !(typeof a.followers === 'number' && a.followers >= 5000);
  const link = (t.urls?.length || 0) > 0 || /\b[a-z0-9-]+\.(?:com|io|xyz|app|net|org|top|click|site|live|online|pro)\b/i.test(text);
  const warn = /\b(?:scam\w*|phish\w*|fake|beware|psa|never (?:dm|click|share)|won'?t (?:dm|ask)|will never|don'?t (?:click|trust|dm)|do not (?:click|trust|dm)|impersonat\w*)\b/i.test(text);
  const channel = OFF_CHANNEL.test(text.replace(/^\s*(?:@\w{1,15}\s+)+/, '')) || link;
  // an established account (20K+ followers, or a verified business) announcing a recovery or security feature is not a
  // support desk scam: those come from small, new accounts
  const established = (typeof a.followers === 'number' && a.followers >= 20000) || a.vtype === 'Business' || (a.verified && typeof a.followers === 'number' && a.followers >= 5000);
  if (!warn && !official && !established) {
    if (FLAGGED.test(text) && (channel || CONTACT.test(text) || /\b(?:click|visit|go to|verify|validate|rectify|sync|restore|resolve|fix)\b/i.test(text))) {
      return {kind: 'support', label: 'Fake support', stat: 'says your wallet is flagged', confidence: 0.95, stamp: 'SCAM',
        detail: 'Claims your wallet or account has a problem and sends you somewhere to fix it: the classic drainer opening',
        lines: ['Says the reader\'s wallet or account is flagged, locked or compromised', 'Then points to a link, DM or chat to "fix" it', 'Real support never contacts you first']};
    }
    if (DRAIN_VOCAB.test(text) && (channel || CONTACT.test(text))) {
      return {kind: 'support', label: 'Fake support', stat: 'wallet "validation" link', confidence: 0.95, stamp: 'SCAM',
        detail: 'Sends readers to "validate", "sync" or "rectify" their wallet: wording drainer sites use to get a signature',
        lines: ['Asks readers to validate, sync or rectify a wallet', 'No real wallet or dapp needs that: it is how drainers get a signature', 'Points to a link or DM to do it']};
    }
    const dest = text.replace(/^\s*(?:@\w{1,15}\s+)+/, '');
    if (SUPPORT_DM.test(text) && OFF_CHANNEL.test(dest) && isReply(t) && small) {
      const named = dest.match(/@([A-Za-z0-9_]{3,15})/);
      const tg = dest.match(/t\.me\/(\w+)/i);
      const via = /t\.me|telegram/i.test(dest) ? 'Telegram' : /whatsapp|wa\.me/i.test(dest) ? 'WhatsApp' : named ? `@${named[1]}` : 'a private chat';
      // a project sending its own users to its own chat is support, not a fake desk
      const own = [named?.[1], tg?.[1]].filter(Boolean).some((x) => { const f = fold(x), h = fold(a.handle); return f.length >= 3 && h.length >= 3 && (f.includes(h) || h.includes(f)); });
      if (!own && !(named && OFFICIAL_HANDLES.has(named[1].toLowerCase()))) {
        return {kind: 'support', label: 'Fake support', stat: `support via ${via}`, confidence: 0.9, stamp: undefined,
          detail: `Replies with "support" that runs through ${via}. Real support desks answer from their own account and never move you to a private chat`,
          lines: [`Sends the reader to support through ${via}`, 'Posted as a reply, the way fake support desks find people asking for help', 'Real support answers from its own verified account']};
      }
    }
  }
  // fund recovery offers: "@x got all of it back, dm them, small fee" (never a warning about recovery scams)
  if (!/\brecovery scam|\b(?:no|never)\b[^.!?\n]{0,30}\brecover/i.test(text) && !warn && !official && !RESPONDERS.test(text)) {
    const offer = RECOVER.test(text) && LOSS.test(text) && CONTACT.test(text) && HIRE.test(text) && /@[A-Za-z0-9_]{3,15}|t\.me|telegram|whatsapp|\b(?:dm|message|contact) (?:me|us|them|him|her)\b/i.test(text.replace(/^\s*(?:@\w{1,15}\s+)+/, ''));
    // a "fund recovery" seller working the replies
    const bio = RECOVERY_BIO.test(a.description || '') && isReply(t) && small;
    if (offer || bio) {
      return {kind: 'recovery', label: 'Recovery scam', stat: 'offers to recover stolen funds', confidence: 0.92, stamp: offer && bio ? 'SCAM' : undefined,
        detail: 'Offers to get stolen crypto back for a fee. Stolen crypto cannot be pulled back by a hacker, and real investigators never charge upfront (FBI IC3)',
        lines: [bio ? 'The account sells "fund recovery" in its bio' : 'Points people who lost funds to a "recovery" contact', 'Recovery offers take an upfront fee and disappear', 'Law enforcement never charges to recover funds (FBI IC3)']};
    }
  }
  return null;
}

/** Pure: the strongest scam finding for a post, or null. What the post asks for leads (seed phrase, send funds, a
 * phishing link, fake support); an impersonator doing it adds its own lines to the card. */
export function scamCheck(t, facts = {}) {
  const imp = impersonation(t, facts);
  const post = seedAsk(t) || fakeGiveaway(t) || phishing(t, facts) || fakeSupport(t);
  if (!post) return imp;
  if (!imp) return post;
  return {...post, stamp: post.stamp || imp.stamp, confidence: Math.max(post.confidence, imp.confidence), target: imp.target,
    detail: `${post.detail}. Posted by a copy of @${imp.target}`, lines: [...post.lines, ...imp.lines.slice(0, 2)]};
}
