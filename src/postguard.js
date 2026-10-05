// The standing guard for a post whose every contract is official ($PONS) (ES module, background worker). Not a copy of server code and not part of verdict.js,
// scam.js or officials.js (those stay byte-identical with the server's copies).
// Rule 2026-10-03: a post whose only contract is $PONS once showed a red "Bundled launch" (the API had read the poster's other launch into the pill).
import {officialToken, textSignals} from './verdict.js';
import {PROTECTED_TICKERS, ORGS} from './officials.js';

const SOL_CA = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;
/** Pure: every contract a post names (X's "robinhood:0x..." smart cashtags and the quoted post included): EVM lower-cased, Solana as written. */
export function postAddresses(t) {
  const text = `${t?.text || ''} ${t?.quoted?.text || ''}`;
  const evm = (text.match(/0x[a-fA-F0-9]{40}/g) || []).map((a) => a.toLowerCase());
  const sol = (text.replace(/0x[a-fA-F0-9]+/g, ' ').match(SOL_CA) || []).filter((a) => /\d/.test(a) && /[a-z]/.test(a) && /[A-Z]/.test(a));
  return [...new Set([...evm, ...sol])];
}
/** Pure: a post whose every contract is an official token ($PONS) and that names at least one. */
export const officialOnlyPost = (t) => { const a = postAddresses(t); return a.length > 0 && a.every((x) => !!officialToken(x)); };
// verdict labels that say something about a COIN or a LAUNCH. A text scam keeps its own labels and is never here.
const COIN_VERDICT = /^(Bundled launch|Token risk|High-risk token|Rug operation|Rug history|Linked to rugs|Token collapsed|Scam project|New project, high risk|Serial bundlers?)$/i;
/** Pure: on a post whose every contract is official, no verdict about a coin or a launch, red or amber, is shown: the official token is never flagged, and what a
 *  verdict says about the poster's other coins is not about this post. */
export const officialPostGuard = (t, v) => !!v && !v.hidden && (v.tone === 'rug' || v.tone === 'kol') && (COIN_VERDICT.test(v.label || '') || (v.label === 'Scam' && /bundled/i.test(v.stat || ''))) && officialOnlyPost(t);

// A "Bundled launch" / "Token risk" verdict with a card titled "$SYM launch" is about a launch of the AUTHOR (the API's launch detector reads the poster's own
// launches into the pill of any post they write): a post about one coin could show the bundle figure of the poster's other coin. The pill now names the coin the verdict is about; when the post
// names a different coin, the verdict is marked `otherCoin`, so the card (content.js pillFromChain) sets the pill from the post's own coin instead, and the post is
// not faded for another coin's bundle.
const LAUNCH_TITLE = /^\$([A-Za-z0-9]{1,15}) launch$/;
// A text-bait "Scam" ("Asks readers to reply, DM or send money" / "Reads like bait aimed at the reader") is a read of the post's WORDS. A post walking readers through the
// real Pons launchpad (ponsfamily.com) was once a red Scam though nothing in it asks anyone to DM or send money. Only proven flags: the label stands on a real ask in the words, and never on a post whose
// links all go to an official or known-project site (ponsfamily.com, pons.family, a listed project's own domain, the account's own site).
const BAIT_DETAIL = /^(Asks readers to reply, DM or send money|Reads like bait aimed at the reader)$/;
const OFFICIAL_SITES = new Set([...ORGS.flatMap((o) => String(o[3] || '').split(/\s+/).filter(Boolean)), 'ponsfamily.com', 'pons.family', 'x.com', 'twitter.com', 't.co']);
const hostOk = (h, own) => { h = String(h || '').toLowerCase().replace(/^www\./, ''); return [...OFFICIAL_SITES, ...own].some((d) => h === d || h.endsWith(`.${d}`)); };
const BARE_TLD = 'com|net|org|io|xyz|app|fi|finance|gg|me|co|ai|so|fun|family|world|link|site|online|live|pro|info|biz|cc|top|click|trade|exchange|network|dev|tech|lol|wtf|vip|today|win|shop|store|space|website|cloud|dao|tk|ml|ga|cf|gq|pw|icu|buzz|cfd|sbs|rest|monster|bond|quest|zip|mov';
const BARE_HOST = new RegExp(`(?<![\\w@./-])((?:[a-z0-9-]+\\.)+(?:${BARE_TLD}))(?![\\w-])`, 'gi');
/** Pure: every site a post links (X's expanded links, http(s) links in the text, a bare domain with a path, a bare domain with a known ending). */
export function linkedHosts(t) {
  const text = `${t?.text || ''} ${t?.quoted?.text || ''}`;
  const hosts = new Set();
  const add = (h) => { h = String(h || '').toLowerCase().replace(/^www\./, '').replace(/[.,;:!?)\]…]+$/, ''); if (h && h.includes('.')) hosts.add(h); };
  for (const u of [...(t?.urls || []), ...(t?.quoted?.urls || [])]) { try { add(new URL(String(u)).hostname); } catch { /* not a link */ } }
  for (const m of text.matchAll(/https?:\/\/([^\s/?#]+)/gi)) add(m[1]);
  for (const m of text.matchAll(/(?<![\w@./-])((?:[a-z0-9-]+\.)+[a-z]{2,})\/\S*/gi)) add(m[1]);
  for (const m of text.matchAll(BARE_HOST)) add(m[1]);
  return [...hosts];
}
// a real ask of the reader: a DM, a reply with something, sending funds somewhere, a seed phrase or key, connecting a wallet, a chat to move to (also the common Chinese / Japanese / Korean words)
const REAL_ASK = /\b(dm|dms|d\.m\.?)\s*(me|us)\b|\bdm\b[^.!?\n]{0,30}\b(me|us|to|for|now)\b|\b(check|open) (your |ur )?(dms?|inbox)\b|\b(message|inbox|pm|text|whatsapp|telegram)\s*(me|us)\b|\b(reply|comment)\b[^.!?\n]{0,25}(\byes\b|\bok\b|\binterested\b|\bamen\b|\bwallet\b|\baddress\b|\bme\b|["“‘'])|\b(send|transfer|deposit|pay)\b(?:[^.!?\n]|(?<=\d)\.(?=\d)){0,60}(0x[a-f0-9]{6,}|\b[1-9A-HJ-NP-Za-km-z]{32,44}\b|\bwallet\b|\baddress\b|\b(sol|eth|usdt|usdc|btc|bnb)\b)|seed ?phrase|recovery phrase|secret phrase|private key|connect (your |a |the )?wallet|t\.me\/|私信|私訊|私聊|微信|电报|電報|转账|轉帳|DMください|DMして|메시지|쪽지/i;
const mostlyLatin = (text) => { const l = String(text || '').match(/\p{L}/gu) || []; return l.length >= 20 && l.filter((c) => /[A-Za-z]/.test(c)).length / l.length >= 0.8; };
/** Pure: a text-bait Scam verdict on a post with no real ask in its words (or whose links are all official / known-project sites) is a neutral Commentary. The same object otherwise. */
export function textBaitGuard(t, v) {
  if (!v || v.tone !== 'rug' || v.label !== 'Scam' || !BAIT_DETAIL.test(String(v.detail || '')) || /bundled/i.test(v.stat || '')) return v;
  const own = [t?.author?.url, ...(t?.author?.links || [])].filter(Boolean).map((u) => { try { return new URL(String(u)).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; } }).filter(Boolean);
  const hosts = linkedHosts(t);
  const official = hosts.length > 0 && hosts.every((h) => hostOk(h, own));
  let noAsk = false;
  if (!official) {
    const words = `${t?.text || ''} ${t?.quoted?.text || ''}`;
    let local = null; try { local = textSignals({text: t?.text || '', quoted: t?.quoted, cashtags: t?.cashtags || []}); } catch { local = null; }
    noAsk = !!local && !local.baitRegex && !local.obfuscated && !REAL_ASK.test(words) && mostlyLatin(words);
  }
  if (!official && !noAsk) return v;
  return {id: v.id, source: v.source, tone: 'neutral', label: 'Commentary', stat: 'no calls', confidence: 0.5};
}

/** Pure: the verdict scoped to the coin it is about. Returns the same object when it is not an author-launch verdict. */
export function scopeVerdict(t, v) {
  v = textBaitGuard(t, v);
  if (!v || v.tone !== 'rug' || (v.label !== 'Bundled launch' && v.label !== 'Token risk')) return v;
  const m = [v.card?.title, ...(v.card?.rows || []).filter((r) => r?.kind === 'flags').map((r) => r.title)].map((x) => String(x || '').match(LAUNCH_TITLE)).find(Boolean);
  if (!m) return v;
  const sym = m[1].toUpperCase();
  // 0.29.0: a giveaway post once showed a red "Token risk, $PONS" for the poster's other token, an
  // Ethereum token that is only NAMED PONS. A verdict about a launch whose symbol is an official or protected ticker ($PONS, $ZEC, $ETH ...) is never shown as
  // the post's pill under that symbol: it would read as a flag on the official coin (rule: Pons is never flagged). The post's own coin has its own card.
  if (PROTECTED_TICKERS.includes(sym)) return {...v, hidden: true, otherCoin: sym, fade: false};
  const named = (t?.cashtags || []).map((x) => String(x).toUpperCase());
  const other = postAddresses(t).length > 0 || (named.length > 0 && !named.includes(sym));
  const stat = /^\$/.test(String(v.stat || '')) ? v.stat : `$${m[1]} ${v.stat || ''}`.trim();
  // launchSym: the coin this verdict is about; the page (content.js scopeFor) drops it when X's own data shows the post names another coin (a contract in a link, which the post's text may only
  // show cut off)
  return {...v, stat, ...(other ? {otherCoin: sym, fade: false} : {launchSym: sym})};
}
