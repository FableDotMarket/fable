// Shared verdict logic, used by the extension (offline mode) and the Worker (live mode).
// A verdict is what the UI renders under a tweet:
// { id, tone: 'legit'|'rug'|'kol'|'neutral', label, stat, confidence, stamp?, fade?, card?, source }
import {scamCheck} from './scam.js';
import {ORGS, OFFICIAL_ALTS, OFFICIAL_TOKENS, PROTECTED_TICKERS} from './officials.js';

// ---------------------------------------------------------------------------
// Jev (TypeSafe System One, jev-1.13) question set. One call per post, every question answered in parallel.
// Question types are the API's own: noul (yes/no probability), choice, score. The question id is never shown to
// the model, so each instruction is a complete question that names the part of the state it reads in backticks.
// Jev is weak at numbers, dates and adversarial text: counts and ages are bucketed in code before they go in, and
// no label that stamps an account is ever decided by Jev alone (see decide()).
// Bump QSET_VERSION whenever a question or the state shape changes: it is part of the answer cache key.
// ---------------------------------------------------------------------------
export const QSET_VERSION = 'post-v4';
export const JEV_QUESTIONS = {
  kind: {
    type: 'choice',
    instructions: 'Which best describes what the `post` is doing?',
    criteria: {
      shill: 'Pushes readers to buy or hold a specific token or project: calls, price targets, "get in now"',
      builder: 'A team or developer sharing real product work: launches, releases, docs, technical progress',
      scam: 'The post itself tries to scam the reader: giveaway or DM bait, money offers, fake support, wallet drainer or "claim" links, impersonation. NOT a post that discusses, jokes about or warns about scams',
      warning: 'Warns readers about a scam, rug, scammer, bad project or bad actor, or calls one out by name',
      news: 'News, market commentary or analysis without telling readers to buy something specific',
      engagement: 'Farms replies or impressions: generic questions, "like if", tag-a-friend, polls about nothing',
      flex: 'Shows off profits, PnL or wealth to attract followers or sell a group, without a new specific call',
      meme: 'A joke, satire, meme or personal post, including jokes about scams or crime, with no real call to action',
    },
  },
  scam_bait: {
    type: 'noul',
    instructions: 'Does the `post` try to get readers to reply, DM, click a link or send funds in exchange for money, tokens or rewards?',
    criteria: {true: 'It offers money, tokens or rewards for a reply, DM, click or payment', false: 'It makes no such offer'},
  },
  fake_support: {
    type: 'noul',
    instructions: 'Does the `post` claim to be official support, an airdrop claim, wallet validation or a token migration, and send readers to a link or DM?',
    criteria: {true: 'It poses as support, a claim, validation or migration and points to a link or DM', false: 'It does not'},
  },
  promo: {
    type: 'noul',
    instructions: 'Does the `post` promote a specific token, referral link, trading bot or paid calls channel?',
    criteria: {true: 'It promotes one of these', false: 'It does not promote any of these'},
  },
  disclosed: {
    type: 'noul',
    instructions: 'Does the `post` openly say it is an ad, sponsored, a paid partnership, or that the author holds or advises the thing it mentions?',
    criteria: {true: 'It openly discloses this', false: 'It does not disclose anything like this'},
  },
  ai_slop: {
    type: 'noul',
    instructions: 'Does the `post` read like generic AI-generated engagement content rather than a person saying something specific?',
    criteria: {
      true: 'Template phrasing and filler ("here\'s the thing", "let that sink in", "not just X, it\'s Y", "game changer"), emoji bullet lists, hashtag walls, vague hype or lessons with no concrete detail',
      false: 'A person writing in their own voice about something specific: a real event, number, product, trade or opinion',
    },
  },
  hype: {
    type: 'score',
    instructions: 'How much financial hype or urgency does the `post` use?',
    criteria: ['Calm and factual', 'Some excitement', 'Strong hype, urgency, price targets or 100x claims'],
  },
};

// numbers and dates go in as coarse buckets: Jev reads words better than it compares numbers
const bucketFollowers = (n) => (n == null ? 'unknown' : n < 1e3 ? 'under 1k' : n < 1e4 ? '1k to 10k' : n < 1e5 ? '10k to 100k' : 'over 100k');
const bucketAge = (created) => {
  const ms = created ? Date.now() - Date.parse(created) : NaN;
  if (!Number.isFinite(ms)) return 'unknown';
  const d = ms / 864e5;
  return d < 30 ? 'under 1 month' : d < 120 ? '1 to 4 months' : d < 365 ? '4 to 12 months' : 'over 1 year';
};
const domainOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return null; } };

export const jevState = (t) => ({
  post: {
    text: String(t.text || '').slice(0, 1200),
    quoted_text: t.quoted?.text ? String(t.quoted.text).slice(0, 600) : null,
    tickers: (t.cashtags || []).slice(0, 8),
    link_domains: [...new Set((t.urls || []).map(domainOf).filter(Boolean))].slice(0, 5),
  },
  author: {
    handle: t.author?.handle || null,
    name: t.author?.name || null,
    bio: t.author?.description ? String(t.author.description).slice(0, 300) : null,
    followers: bucketFollowers(t.author?.followers),
    account_age: bucketAge(t.author?.created_at),
    verified: !!t.author?.verified,
  },
});

// Read one answer defensively: the API returns {type, noul} / {type, choice, confidence, probabilities} / {type, score}.
const noul = (a) => (typeof a === 'number' ? a : typeof a?.noul === 'number' ? a.noul : 0);

// Map Jev answers (+ facts from our DB) to a verdict. Where Jev is unsure about the post kind (confidence < 0.6)
// the regex reading wins. Bait needs the regex to agree before it can stamp (see decide()).
export function verdictFromJev(t, answers, facts = {}) {
  const h = textSignals(t);
  const k = answers?.kind;
  const sure = k?.choice && (k.confidence ?? 0) >= 0.6;
  const s = {
    kind: h.drainer ? 'scam' : h.cta && k?.choice !== 'warning' ? 'cta' : sure ? k.choice : h.kind,
    kindConf: h.drainer ? 0.98 : sure ? k.confidence : h.kindConf,
    bait: h.cta ? Math.min(0.5, noul(answers?.scam_bait)) : Math.max(noul(answers?.scam_bait), noul(answers?.fake_support), h.obfuscated ? h.bait : 0),
    obfuscated: h.obfuscated, drainer: h.drainer,
    promo: noul(answers?.promo),
    disclosed: noul(answers?.disclosed),
    hype: typeof answers?.hype?.score === 'number' ? answers.hype.score : h.hype,
    // AI slop needs Jev and the weighted tells to agree, so a plain post is never called slop by the model alone
    slop: mergeSlop(h, answers?.ai_slop == null ? undefined : noul(answers.ai_slop)),
    slopTells: h.slopTells, slopWhy: h.slopWhy,
    baitRegex: h.baitRegex,
    jev: true,
  };
  return finalize(t, s, facts, 'jev');
}

// ---------------------------------------------------------------------------
// Heuristic fallback. Same output shape so the UI never knows the difference.
// ---------------------------------------------------------------------------
// AI-writing tells, weighted. Each is weak alone: a post reads as AI slop only when the weighted score clears the bar
// (SLOP_BAR, higher for long and non-English posts) after the human-voice guards, so short posts, slang, lowercase CT
// talk and one-off phrases never get there. Fit on 320 hand-labelled real posts, checked on 210 fresh held-back ones.
// [weight, name, pattern]: English phrasing, then Chinese (CT's second language); structure is measured in slopScore().
const SLOP_PHRASES = [
  // chat-model leftovers pasted with the post: decisive on their own
  [4, `pasted chatbot reply`, /\b(?:as an ai(?: language model)?\b|following the direction in your (?:file|prompt|brief)|i dialed back the|here'?s (?:a|the|your) (?:revised|rewritten|polished|updated) (?:version|post|tweet|draft)|certainly[!,] here'?s)/i],
  // stock hooks and reveals
  [1.5, `stock hook`, /\bhere'?s (?:the thing|the kicker|the truth|the deal|the catch|the part that matters|the bit|the math|what (?:matters|scares me|just changed|you need to know|most people miss)|why (?:that|this|it) matters|how it works|(?:the full|my|the exact) (?:setup|breakdown|playbook|strategy|framework))\b/i],
  [1.5, `stock hook`, /\b(?:let that sink in|read that again)\b/i],
  [1.5, `stock hook`, /\b(?:this is where it gets interesting|nobody is (?:ready|talking about)|no one is talking about|(?:most|a lot of) people (?:aren'?t|haven'?t|don'?t) (?:appreciat|realis|realiz|notic)\w*|people aren'?t appreciating|the (?:real|big|biggest) (?:unlock|problem|question|bottleneck|edge) (?:is|here|no one|happens)|(?:that'?s|that is|this is) (?:exactly )?where @?\w+ comes in|this changes everything|in a world where)\b/i],
  [1, `setup question`, /\b(?:the result|the answer|the catch|the twist|why does (?:this|it) matter|what does (?:this|it) mean|(?:their|our|the) (?:mission|goal|secret|edge))\?|\b(?:ever wonder(?:ed)?|tired of|what if i told you)\b|\bonly half the (?:job|picture|story|battle)\b|\b(?:look at the (?:sequence|math|numbers|data)|underneath (?:it all|the \w+)|the bottom line|put simply|simply put|in other words|(?:a few|some|two|three) things worth noting)\s*:/i],
  // "not X, it's Y" contrasts, in one sentence or across two ("It wasn't the list. It was what he did after.")
  [1.5, `"not X, it's Y" contrast`, /\b(?:isn'?t|is not|not|wasn'?t)\s+(?:just\s+)?[^.!?\n,;]{2,40}[,;—–]\s*(?:it'?s|that'?s|this is|it is|they'?re)\s/i],
  [1.5, `"not X, it's Y" contrast`, /\bit'?s not about\b[^.!?]{2,40}\bit'?s about\b|\bmost \w+(?: \w+)? [^.!?\n]{2,40}[.!]\s+this one\b|\bmost people\b[^.!?\n]{3,60}[.!]\s+few\b|\b(?:wasn'?t|isn'?t|is not|was not|we'?re not|i'?m not|it'?s not)\b[^.!?\n]{2,60}[.!]\s+(?:it (?:was|is)|we'?re|we are|i'?m|it'?s)\b/i],
  [1, `"not just" framing`, /\b(?:not just|more than just|isn'?t just|not only)\b|\bnot an? [^,.!?\n]{2,25}, an? \w+/i],
  // model vocabulary
  [1, `model vocabulary`, /\b(?:game[- ]?changer|next[- ]level|a new era|paradigm shift|delve|tapestry|landscape of|navigat(?:e|ing) the|unlock(?:s|ing)? (?:the|new|real)|seamless(?:ly)?|elevat(?:e|ing) (?:your|the)|empower(?:s|ing)?|revolutioniz\w+|harness(?:ing)? the|at the intersection of)\b/i],
  // sponsored-yap, shill and hustle-story phrasing
  [1, `sponsored-post phrasing`, /\b(?:this still doesn'?t feel real|none of this happened overnight|you can do it too|one (?:trade|call|decision|move) can (?:completely )?change (?:your life|your future|everything)|i just came across|i was just scrolling|what i (?:like|love|find interesting|appreciate) (?:about it |most )?is|if you haven'?t (?:tried|checked|heard of|explored)|then i (?:found|discovered)|something shifted|shouldn'?t be giving this away|worth (?:paying attention to|keeping (?:an eye on|on (?:the|your) radar))|(?:flying )?under the radar|quietly (?:building|running|got|became|shipping)|you'?ll be amazed|maybe it'?s time|did you know that|imagine (?:giving|a world|having))\b/i],
  // generic uplift closers
  [1, `uplift closer`, /\b(?:the best is yet to come|stay tuned|buckle up|(?:we'?re|we are|it'?s|is) just getting started|now we scale|one step closer|(?:one \w+|brick by brick|block by block|branch by branch) at a time|now imagine|welcome to the (?:herd|family|future|revolution)|the future (?:of \S+ )?is (?:here|now|bright|onchain|on-chain)|we keep building|let'?s build (?:it )?together|stay (?:disciplined|humble|hungry|focused))\b/i],
  [1, `listicle framing`, /\b(?:key takeaways?|lessons? learned|a (?:quick )?thread)\s*[:🧵👇]/i],
  // Chinese: "not X but Y" contrasts and stock phrasing
  [1.5, `"not X but Y" contrast`, /(?:不是|并非|不只是|不仅是|不仅仅是|并不只是|不单单是|只是)[^。！？\n]{1,30}(?:而是|更是|其实是)|(?:不在|不靠)[^。！？\n]{1,20}(?:而在|而是|靠的是)|并不只是|不再只是/],
  [1, `stock phrasing`, /值得(?:密切|持续)?关注|拭目以待|未来可期|核心理念|这就是全部故事|说白了|换句话说|底层逻辑|关键在于/],
];
// stock model words: three or more distinct ones in a post is a tell of its own
const BUZZ = /\b(?:genuinely|truly|incredibly|remarkabl[ey]|robust|pivotal|crucial|vibrant|thriving|journey|vision|innovative|innovation|cutting[- ]edge|transformative|foundational|holistic|synergy|ultimately|essentially|fundamentally|redefin\w+|reimagin\w+|milestone|frictionless|high[- ]performance|next[- ]gen(?:eration)?|strategic|resilien\w+|unwavering|continued (?:belief|support)|stands? out|showcas\w+|testament)\b/gi;
// human voice: slang, profanity, CT shorthand. Models write clean; people don't.
const HUMAN = /\b(?:lol|lmao|lmfao|ngl|tbh|idk|imo|imho|fr|rn|ser|fren|wen|ngmi|bruh|bro|fuck\w*|shit(?:ty|post\w*|s)?|damn|af|cope|kek|wtf|smh|gonna|wanna|gotta|ya|ur)\b|😂|💀|🤣/gi;
const FANCY = /[\u{1D400}-\u{1D7FF}]/gu; // bold / italic math letters: campaign headline styling
const BULLET = /^\s*(?:\p{Extended_Pictographic}|[➺➤►▸▪→⤷✦◆✔☑]|\d️?⃣|0\d\s*[—–-])/u;
const CJK = /[぀-ヿ㐀-鿿가-힯]/g;
const EN_STOP = /\b(?:the|and|is|are|to|of|you|it|in|for|that|this|with|on|we|i|your|be|not)\b/gi;
const NUMERIC = /[\d$@#]/;
const SLOP_GLOBAL = SLOP_PHRASES.slice(1).map(([w, name, rx]) => [w, name, new RegExp(rx.source, rx.flags + 'g')]);
// the bare phrase patterns, for trace readers that count which ones match (overhaul/logging explainText)
const SLOP = SLOP_PHRASES.map(([, , rx]) => rx);

export const SLOP_BAR = 3;
/** Pure: the weighted AI-slop reading of the author's own text -> {score, tells, why, bar, decisive, short}. */
export function slopScore(raw) {
  const text = String(raw || '').replace(/[’‘]/g, "'").replace(/[“”]/g, '"');
  const cjk = (text.match(CJK) || []).length;
  const words = Math.max((text.match(/\S+/g) || []).length, Math.round(cjk / 2));
  let score = 0, tells = 0;
  const found = new Map(); // tell name -> weight, for the card line
  const add = (w, name) => { score += w; tells++; found.set(name, (found.get(name) || 0) + w); };
  const decisive = SLOP_PHRASES[0][2].test(text);
  if (decisive) add(4, SLOP_PHRASES[0][1]);
  // a group counts once per distinct phrase it finds, at most twice ("I was just scrolling ... maybe it's time")
  for (const [w, name, rx] of SLOP_GLOBAL) {
    const hits = new Set((text.match(rx) || []).map((x) => x.toLowerCase()));
    for (let k = 0; k < Math.min(2, hits.size); k++) add(w, name);
  }
  const buzz = new Set((text.match(BUZZ) || []).map((x) => x.toLowerCase())).size;
  if (buzz >= 3) add(buzz >= 5 ? 2 : 1, 'buzzwords');
  if ((text.match(FANCY) || []).length >= 4) add(2, 'bold-letter headline');
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.filter((l) => BULLET.test(l) && /\p{L}{2,}.*\p{L}{2,}/u.test(l)).length >= 3) add(1, 'emoji bullet list');
  // perfectly parallel triads: three short segments in a row that open with the same word ("Everyone has a new narrative.
  // Everyone has ..."), share a phrase ("Storage can be distributed. Compute can be ..."), or are bare fragments
  // ("Real skin in the game. Real accountability."). Runs of numbers or tickers are call lists, not prose.
  const seg = text.replace(/https?:\/\/\S+/g, ' ').split(/[.!?]+(?=\s|$)|\n+/).map((x) => x.replace(/^[^\p{L}\p{N}$]+/u, '').trim()).filter(Boolean);
  const pairs = (ws) => new Set(ws.slice(1).map((x, k) => `${ws[k]} ${x}`.toLowerCase()));
  for (let i = 0; i + 2 < seg.length; i++) {
    const three = seg.slice(i, i + 3);
    const numeric = three.filter((x) => NUMERIC.test(x)).length;
    if (numeric >= 2) continue;
    const w = three.map((x) => x.split(/\s+/));
    const first = w.map((x) => x[0].toLowerCase());
    const short = w.every((x) => x.length <= 8);
    const [a, b, c] = w.map(pairs);
    const shared = [...a].some((p) => b.has(p) && c.has(p));
    const fragments = !numeric && w.every((x) => x.length >= 2 && x.length <= 3) && !three.some((x) => x.endsWith(':'));
    if ((short && first[0] === first[1] && first[1] === first[2] && first[0].length > 1) || (short && shared) || fragments) { add(1.5, 'parallel triad'); break; }
  }
  const dashes = (text.match(/—+/g) || []).length;
  if (words >= 25 && dashes) add(dashes >= 2 ? 1 : 0.5, 'em dashes');
  if (cjk < 10 && /\p{L}—\p{L}/u.test(text)) add(0.5, 'em dashes'); // "access—or": the unspaced dash models write
  if ((text.match(/(^|\s)#[\p{L}\p{N}_]+/gu) || []).length >= 3) add(0.5, 'hashtag stack');
  // guards: people write short, loose and lowercase
  const human = new Set((text.match(HUMAN) || []).map((x) => x.toLowerCase())).size;
  score -= Math.min(2, human);
  const starts = seg.map((x) => x.match(/\p{L}/u)?.[0]).filter((ch) => ch && /[A-Za-z]/.test(ch));
  if (starts.length >= 3 && starts.filter((ch) => ch >= 'a').length / starts.length >= 0.7) score -= 1;
  if (/(!!|\?\?|\.{4,})/.test(text)) score -= 0.5;
  // the bar rises for long posts (more room for chance hits) and for non-English ones (fewer tells apply to them)
  const english = cjk < 10 && (text.match(EN_STOP) || []).length >= words * 0.08;
  const bar = SLOP_BAR + Math.max(0, (words - 200) / 200) + (english ? 0 : cjk >= 10 ? 0.5 : 1);
  if (decisive) score = Math.max(score, bar);
  else if (words < 12) score = Math.min(score, 0);
  const why = [...found].sort((x, y) => y[1] - x[1]).map(([name]) => name);
  return {score: Math.round(score * 10) / 10, tells, why, bar: Math.round(bar * 10) / 10, decisive, short: words < 12};
}
// score -> the 0..1 slop reading decide() uses (0.8+ shows the note)
const slopProb = (r) => (r.score >= r.bar ? Math.min(0.95, 0.8 + 0.05 * (r.score - r.bar)) : 0);
/** Pure: the regex reading merged with Jev's ai_slop answer. Jev alone never labels a post: it can lift a post that
 * already shows real tells (score 1.5+, not a short post), and a firm "no" from Jev (under 0.2) vetoes a marginal regex call. */
export function mergeSlop(h, j) {
  if (typeof j !== 'number') return h.slop;
  if (j >= 0.85 && h.slopScore >= 1.5 && !h.slopShort) return Math.max(h.slop, j);
  if (j < 0.2 && h.slopScore < h.slopBar + 1.5 && !h.slopDecisive) return 0;
  return h.slop;
}
// bait: money or a reward tied to a reply, a DM, a payment or a wallet connection ("If $10,000 is a lot of money to
// you, reply yes and check your DMs"). Not bait on their own, each of which made real posts red over the 47K captured
// posts: "DM me" (business talk), "claim your" (product copy), "first 100 people" (beta access), a dollar range
// ("$1–$100 orders"), "giveaway" (the CTA farms below), a bare "connect your wallet", "airdrop tokens".
const RX = {
  bait: /((reply|comment) (with )?["“'‘]?(yes|sol|eth)["”'’]?[^.!?\n]{0,40}\b(dms?|winners?|giveaway)\b|(\$\s?\d[\d,.]*k?|money|giveaway)[^!?\n]{0,80}\b(reply|comment) (with )?["“'‘]?(yes|sol|eth)\b|(?<!(someone|somebody|he|she|they|people|just|who|literally|always|guys|fren|friend) )\b(dm me|check (your |ur )?dms?)\b[^.!?\n]{0,60}\b(send|give|pay) (you|u) (\$\s?\d|\d[\d,.]*\s?(sol|eth|usdt|usdc|btc)\b|some (sol|eth|money))|\b(send|give|pay) (you|u) (\$\s?\d|\d[\d,.]*\s?(sol|eth|usdt|usdc|btc)\b)[^.!?\n]{0,60}\bdm me\b|\bdms? (me |us )?(["“']\w+["”'] )?to (enter|receive|win)\b|low on money|paying (a few )?debts|send me (some )?(sol|eth|usdt|usdc)\b|connect (your )?wallet( (at|on|via|here:?) \S+)? (to|and) ((claim|receive|unlock|get) (now|your (airdrop|allocation|rewards?|tokens?|drop|bonus)|the (airdrop|allocation|rewards?|tokens?|drop))|(verify|validate) (your )?wallet))/i,
  hype: /(\b\d{2,4}x\b|gem|moon|send it|next (big|100)|don'?t miss|early|ape|pump|lambo|millionaire|flips?|fullport|1000x|100x|to the moon|🚀)/i,
  promo: /(ref(erral)?\b|\/r\/|use (my )?code|link in bio|sponsored|#ad\b|partner(ed)? with|check:\s*\S+|fomo\.family|t\.me\/)/i,
  money: /((made|making|turned|profit|pnl)\b.{0,25}\$[\d,.]+|\$[\d,.]+\s*(k|m)?\s*(became|turned into|into|to|→|->)\s*\$[\d,.]+|\b\d+(\.\d+)?\s*(million|mil)\b.{0,40}\b(days?|weeks?|hours?)|millionaire|\bflips?\b.{0,30}\$)/i,
  build: /(ship(ped|ping)?|launch(ed|ing)?|testnet|mainnet|release[ds]?|v\d+(\.\d+)?|open[- ]source|we(['’]| a)re (building|bringing|shipping|launching)|now live|audit|devnet|sdk|api)/i,
  ca: /\b(0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})\b/,
};

// A referral / invite link in the post itself, found by code (the same rule as the promotion card in content.js).
const REFLINK = /[?&](ref|referral|refcode|invite|invitecode|code|affiliate|aff|via)=[^&\s]+|\/(ref|r|invite|referral|join)\/[A-Za-z0-9_-]{3,}|t\.me\/[A-Za-z0-9_]+bot\?start=|@[A-Za-z0-9_]+\?ref/i;
export const hasRefLink = (t) => [...(t?.urls || []), t?.text || ''].some((u) => REFLINK.test(String(u)));

// The regex reading of a post. Used on its own when Jev is off, and as the fallback where Jev is unsure.
// Filter evasion: zero-width characters or look-alike Cyrillic/Greek letters inside Latin words ("оpened",
// "claim​"). People don't type these; drainer and fake-airdrop campaigns do, to slip past keyword filters.
const ZW = /[​‌⁠﻿]/g; // not U+200D: emoji sequences use it
const LOOKALIKE = {'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x', 'і': 'i', 'ј': 'j', 'ѕ': 's', 'ԁ': 'd', 'һ': 'h', 'ո': 'n', 'ο': 'o', 'α': 'a', 'ε': 'e', 'ρ': 'p', 'ν': 'v', 'τ': 't',
  'А': 'A', 'В': 'B', 'Е': 'E', 'К': 'K', 'М': 'M', 'Н': 'H', 'О': 'O', 'Р': 'P', 'С': 'C', 'Т': 'T', 'Х': 'X', 'Ο': 'O', 'Α': 'A', 'Ε': 'E'};
// only letters that pass for Latin ones; stylised symbols like Ξ (LAKZONΞ, the ETH sign) are branding, not evasion
const LOOK = `[${Object.keys(LOOKALIKE).join('')}]`;
const MIXED = new RegExp(`[A-Za-z]${LOOK}|${LOOK}[A-Za-z]`, 'g');
export function deobfuscate(raw) {
  const s = String(raw || '');
  // a single zero-width space glued to a Latin word ("team​ just", "claim​") hides it from keyword filters. Not evasion:
  // one at the start of a line or after a space ("​CA:", "/ ​@handle", drafting-tool paste artifacts), a run of them
  // (a signature watermark), word joiners around list numbers ("1.⁠ ⁠"), and the zero-width non-joiner Persian and
  // Arabic script write with
  const zw = (s.match(/(?<=[A-Za-z0-9.,:;!?)'"$])[​﻿](?=[\sA-Za-z.,:;!?])/g) || []).length + (s.match(/(?<=[A-Za-z])[‌⁠](?=[A-Za-z])/g) || []).length;
  const mixed = (s.match(MIXED) || []).length;
  const text = s.replace(ZW, '').replace(new RegExp(LOOK, 'g'), (ch, i, all) => (/[A-Za-z]/.test(all[i - 1] || '') || /[A-Za-z]/.test(all[i + 1] || '') ? LOOKALIKE[ch] || ch : ch));
  return {text, zw, mixed, obfuscated: mixed >= 1 || zw >= 2};
}
// a warning or call-out about someone else ("scammer", "rugged countless projects", "stay away")
const WARN = /\b(scammers?|ruggers?|rugged|rugs|scammed|beware|be careful|stay away|red flags?|avoid (this|him|her|them)|exit liquidity|don'?t (buy|ape|trust)|insider(s)? dumped|psa)\b/i;
// CTA farming: follow / like / RT / drop your wallet for a free mint, whitelist or giveaway spot. Engagement bait,
// not theft: it asks for attention and a public address, never money, keys or a signature.
// "$15 SOL giveaway, max engage the quote, drop addys": the poster pays one winner for engagement, nothing is taken.
const CTA = /(follow\s*(me|us)?\s*[+&,]?\s*(\+|and|&)?\s*like|like\s*[+&,]\s*(rt|retweet|repost)|(rt|retweet|repost)\s*[+&,]\s*(follow|like)|drop your (evm|sol|eth|btc|wallet|address)|comment your (wallet|address)|tag \d+ (friends|frens)|first \d+ (wallets?|people|followers)|whitelist|\bwl\b|free mint|\b(drop|comment|bring me|send me|send) (your |ur |ya |the |some )?(\$?(sol|solana|evm|eth|btc|bnb|base|usdc|usdt) )?(addys?|addies|address(es)?|wallets?)\b|\b(drop|comment)\b[^.!?\n]{0,20}\b(your|ur) (\$?(sol|solana|evm|eth|btc|bnb|base) )(addys?|address|wallet)\b|\bmax engage\b|\bengage (on |with )?(the )?quot(e|ed)\b|\blike\s*(and|&|\+|,)?\s*(rt|retweet|repost)\b|\b(rt|retweet|repost) (and|&|\+) (follow|like)\b|\b(comment|reply) (with )?["“']?done\b|airdrop(ping)? to (the )?(first|every(one)?|all|\d+)\b)/i;
// what actually takes money: sending funds, DMs, claim / connect-wallet links (these still make it a Scam)
const THEFT = /(send (me )?(sol|eth|usdt|usdc|btc)\b(?! ?(address(es)?|addys?|addies|wallets?)\b)|claim (your|now)|connect (your )?wallet|dm me|check (your )?dms?|reply (with )?["“'‘]?yes|seed phrase|private key)/i;
export function ctaAsks(text) {
  const t = String(text || '');
  const asks = [/follow/i.test(t) && 'follows', /\blike/i.test(t) && 'likes', /(\brt\b|retweet|repost)/i.test(t) && 'retweets', /tag \d+/i.test(t) && 'tagged friends', /(max engage|engage (on |with )?(the )?quot)/i.test(t) && 'engagement on another post', /((drop|comment) your (evm|sol|eth|btc|wallet|address)|\b(drop|comment|bring me|send me) (your |ur |ya |the |some )?(\$?(sol|evm|eth|btc|bnb|base|usdc|usdt) )?(addys?|addies|address(es)?|wallets?)\b)/i.test(t) && 'your wallet address'].filter(Boolean);
  const prize = /free mint/i.test(t) ? 'a free mint' : /(whitelist|\bwl\b)/i.test(t) ? 'a whitelist spot' : /giveaway/i.test(t) ? 'a giveaway' : /airdrop/i.test(t) ? 'an airdrop' : 'a spot';
  const list = asks.length > 1 ? asks.slice(0, -1).join(', ') + ' and ' + asks[asks.length - 1] : asks[0] || 'engagement';
  return 'Asks for ' + list + ' in exchange for ' + prize;
}
// wallet-drainer / fake-airdrop wording (only decisive together with hidden characters)
const CLAIM = /(eligib|allocation|claim(ing)?\b|reward (drop|distribution|portal)|airdrop (is )?(live|portal)|check (your )?wallet|verify (your )?wallet|connect (your )?wallet|portal is (officially )?(live|open))/i;

export function textSignals(t) {
  const d = deobfuscate(`${t.text || ''} ${t.quoted?.text || ''}`);
  const text = d.text;
  const hasTicker = (t.cashtags?.length || 0) > 0 || RX.ca.test(text);
  const claimy = CLAIM.test(text);
  const cta = CTA.test(text) && !d.obfuscated && !THEFT.test(text);
  // a CTA farm's "first 300" / giveaway wording is not theft bait
  // hidden characters alone are not a scam (a stray Cyrillic "С" in "Сitizens", a template tool's paste): only with
  // claim wording (the drainer campaigns) or bait
  const bait = d.obfuscated && claimy ? 0.98 : cta ? 0.1 : RX.bait.test(text) ? 0.93 : d.obfuscated ? 0.3 : 0.03;
  const hypeHits = (text.match(new RegExp(RX.hype.source, 'gi')) || []).length;
  const promo = RX.promo.test(text) && (hasTicker || hypeHits || RX.money.test(text)) ? 0.86 : hypeHits >= 2 && hasTicker ? 0.62 : 0.05;
  const money = RX.money.test(text);
  const promoLink = RX.promo.test(text);
  let kind = 'meme';
  if (bait > 0.5) kind = 'scam';
  else if (cta) kind = 'cta';
  else if (WARN.test(text) && !(hasTicker && hypeHits)) kind = 'warning';
  else if (money && promoLink) kind = 'shill';
  else if (hasTicker && hypeHits) kind = 'shill';
  else if (money || (hypeHits >= 2 && !RX.build.test(text))) kind = 'engagement';
  else if (RX.build.test(text)) kind = 'builder';
  else if (hasTicker || /\b(btc|eth|sol|market|fed|etf|price)\b/i.test(text)) kind = 'news';
  else if (/\?\s*$/.test(text.trim()) && text.length < 120) kind = 'engagement';
  // AI slop is read on the author's own words only: quoting a slop post does not make the reply slop
  const sl = slopScore(deobfuscate(t.text).text);
  return {kind, kindConf: 0.7, bait, promo, hype: Math.min(2, hypeHits), baitRegex: bait > 0.5, disclosed: 0,
    slopTells: sl.tells, slopScore: sl.score, slopBar: sl.bar, slopShort: sl.short, slopDecisive: sl.decisive, slopWhy: sl.why, slop: slopProb(sl),
    obfuscated: d.obfuscated, drainer: d.obfuscated && claimy, cta};
}

export function heuristicVerdict(t, facts = {}) {
  return finalize(t, textSignals(t), facts, 'heuristic');
}

// ---------------------------------------------------------------------------
// Signals + facts -> the pill/card/stamp the user sees.
// Facts always win over text signals: numbers come from data, never from a model.
// ---------------------------------------------------------------------------
// Is this post about crypto at all? Fable stays silent on everything else.
const CRYPTO = /(\$[A-Za-z][A-Za-z0-9]{1,11}\b|\b0x[a-fA-F0-9]{40}\b|\b(crypto|token|tokens|coin|coins|memecoins?|shitcoins?|altcoins?|airdrop|degen|aped|apes|aping|pump(ing|ed)?|rug(ged|pull)?|onchain|on-chain|defi|nfts?|mint(ing)?|presale|wallet|dex|liquidity|mcap|market ?cap|\d{2,4}x|gem|staking|yield|web3|dao|blockchain|bitcoin|btc|ethereum|eth|solana|sol|robinhood chain|hyperliquid|perps?|bags|moonshot|pump\.fun|dexscreener|contract address|ca)\b)/i;
export const isCryptoPost = (t) => (t.cashtags?.length || 0) > 0 || CRYPTO.test(`${t.text || ''} ${t.quoted?.text || ''}`);
// Crypto accounts count even when a single post has no crypto words ("Gud luck." from an NFT project).
const ACCT = /(nft|crypto|onchain|web3|defi|dao|token|coin|protocol|swap|dex|wallet|degen|memecoin|\.eth\b|eth\b|sol\b|btc\b)/i;
export const isCryptoAccount = (a) => !!a && (ACCT.test(`${a.handle || ''} ${a.name || ''}`) || CRYPTO.test(a.description || '') || /\bnfts?\b|\.eth\b|\$[A-Za-z]{2,}/i.test(a.description || ''));
export const isCryptoContext = (t, facts = {}) => isCryptoPost(t) || isCryptoAccount(t.author) || (facts.smart?.length || 0) > 0 || !!facts.calls || !!facts.handles || !!facts.rating || !!facts.engaged || !!facts.kolWatch || !!facts.opRoles || !!facts.trusted || facts.kolPush?.n >= 2 || !!facts.curated?.length;
// Verified businesses and governments are never flagged from text guesses, only from hard on-chain evidence.
export const isOrg = (t) => ['Business', 'Government'].includes(t.author?.vtype);
const DAY_MS = 864e5;
export const ageDaysOf = (t, facts = {}) => facts.accountAgeDays ?? facts.project?.ageDays ?? (Date.parse(t.author?.created_at || '') ? Math.floor((Date.now() - Date.parse(t.author.created_at)) / DAY_MS) : null);
// An established organisation (gold tick for a year+, or very large): an official account, not a smart-money call.
// A gold tick alone proves nothing: it can be bought, and plenty of the rugs we traced ran on brand-new ones.
export const establishedOrg = (t, facts = {}) => {
  if (!isOrg(t)) return false;
  const age = ageDaysOf(t, facts);
  const fol = t.author?.followers || facts.project?.followers || 0;
  return (age != null && age >= 365) || (age != null && age >= 180 && fol >= 100000) || (age == null && fol >= 250000);
};

// A post announcing a token ("$GLAZE is now live", "total supply", "CA below"). Gold ticks launch tokens all the time,
// so an org post like this gets the token read, never the plain "Official account" pass.
const LAUNCH = /(\btoken\b|\bcontract\b|\bca\b|now live|is live|live on|launch(ed|ing)?\b|stealth|fair ?launch|liquidity|total supply|tokenomics|airdrop)/i;
export const tokenAnnouncement = (t) => ((t.cashtags?.length || 0) > 0 || RX.ca.test(`${t.text || ''}`)) && LAUNCH.test(`${t.text || ''}`);

// ---------------------------------------------------------------------------
// Official and established coins (owner rule 2026-10-02, after the $PONS and $ZEC false positives).
// Who posted a coin and when (scam-KOL list mentions, promotion rings, co-posting waves) is a fact about the posters,
// never proof about the coin. On a coin that has proven itself those signals are neutral facts, not a verdict:
//   official     a launchpad or protocol token vouched for by hand (officials.js OFFICIAL_TOKENS, exact address): no
//                automated token rule turns it red or amber; what Fable read stays visible as neutral lines
//   established  30+ days old with $1M+ liquidity: promotion signals are neutral; on-chain proof about the exact
//                contract (a bundle, a honeypot, a tracked rug operation, pulled liquidity) still counts
// Young coins are read as before. A copy of a protected ticker on another contract is judged on its own evidence.
// ---------------------------------------------------------------------------
export const ESTABLISHED = {minAgeDays: 30, minLiqUsd: 1e6};
const normAddr = (a) => (/^0x/i.test(String(a)) ? String(a).toLowerCase() : String(a)); // Solana addresses are case-sensitive
const OFFICIAL_BY_ADDRESS = new Map(OFFICIAL_TOKENS.map(([chain, address, symbol, what, handles]) => [address.toLowerCase(), {chain, address: address.toLowerCase(), symbol, what, handles: handles.split(/\s+/).filter(Boolean)}]));
const OFFICIAL_HANDLES = new Set([...OFFICIAL_TOKENS.flatMap((x) => x[4].split(/\s+/)), ...ORGS.map((o) => o[0]), ...OFFICIAL_ALTS].filter(Boolean).map((h) => h.toLowerCase()));
const PROTECTED = new Set(PROTECTED_TICKERS.map((s) => s.toUpperCase()));
/** Pure: the official token record ({chain, address, symbol, what, handles}) for a contract address, or null. */
export const officialToken = (address) => (address ? OFFICIAL_BY_ADDRESS.get(String(address).toLowerCase()) || null : null);
/** Pure: the official token whose own account this is (@ponsdotfamily -> $PONS), or null. */
export const officialTokenOf = (handle) => { const h = String(handle || '').replace(/^@/, '').toLowerCase(); return [...OFFICIAL_BY_ADDRESS.values()].find((x) => x.handles.some((k) => k.toLowerCase() === h)) || null; };
/** Pure: an official account: a protected token's own accounts, or an organisation in officials.js. */
export const officialHandle = (h) => OFFICIAL_HANDLES.has(String(h || '').replace(/^@/, '').toLowerCase());
/** Pure: a ticker that means an established coin when the post names no contract ($ZEC = Zcash). */
export const protectedTicker = (s) => PROTECTED.has(String(s || '').replace(/^\$/, '').toUpperCase());
/** Pure: {address, ageDays, liquidityUsd} -> 'official' | 'established' | null (young or unknown). */
export function tokenStanding({address, ageDays, liquidityUsd} = {}) {
  if (officialToken(address)) return 'official';
  return ageDays >= ESTABLISHED.minAgeDays && liquidityUsd >= ESTABLISHED.minLiqUsd ? 'established' : null;
}
// a token scan's promotion reasons (api scan/token.js judgeScan): who pushed the coin, never what the contract is
export const PROMO_REASON = /^Pushed by \d+ accounts? from (?:known promotion rings|a known scam KOL group)\b|^\d+ of its promoters have mostly dead calls\b/;
const neutralLine = (text) => String(text || '').replace(/\.$/, '')
  .replace(/^Pushed by (\d+) accounts? from known promotion rings/, '$1 of its posters are in promotion rings Fable tracks')
  .replace(/^Pushed by (\d+) accounts? from a known scam KOL group in the last 7 days/, '$1 accounts on public scam-KOL lists posted it this week')
  .replace(/^(\d+) of its promoters have mostly dead calls/, '$1 of its posters have mostly dead calls');

/**
 * Pure: a token scan read with the standing rule above. Official: every automated reason becomes a neutral line (strength
 * 'weak', grey in the card) and the level is 'ok'. Established: the promotion reasons become neutral lines and the level
 * is set again from what is left (strong -> danger, anything else -> caution: the bump judgeScan uses). The scam-KOL
 * mention count moves from promoters.kolPush (drawn as a red line) to promoters.kolMentions. Young coins come back as
 * they were. opts.bySymbol: a $TICKER lookup with no contract in the post, so a protected ticker means the established coin.
 */
export function guardScan(tok, {bySymbol = false} = {}) {
  if (!tok?.found || tok.standing) return tok;
  const standing = tokenStanding({address: tok.address, ageDays: tok.ageHours != null ? tok.ageHours / 24 : null, liquidityUsd: tok.liquidityUsd})
    || (bySymbol && protectedTicker(tok.symbol) ? 'established' : null);
  if (!standing) return tok;
  const official = standing === 'official';
  const reasons = tok.reasons || [];
  const promo = (r) => official || PROMO_REASON.test(String(r?.text || ''));
  const kept = reasons.filter((r) => !promo(r));
  const moved = reasons.filter(promo).map((r) => ({text: neutralLine(r.text), strength: 'weak'}));
  const level = tok.level === 'unknown' || tok.level === 'ok' ? tok.level : kept.some((r) => r.strength === 'strong') ? 'danger' : kept.length ? 'caution' : 'ok';
  const out = {...tok, level, reasons: [...kept, ...moved], standing};
  if (tok.promoters?.kolPush) { const {kolPush, ...p} = tok.promoters; out.promoters = {...p, kolMentions: kolPush}; }
  if (official && tok.launch) {
    out.launch = {...tok.launch, lines: (tok.launch.lines || []).map((l) => ({...l, strength: 'weak'})),
      ...(tok.launch.bundle ? {bundle: {...tok.launch.bundle, flagged: false, strength: null}} : {})};
  }
  return out;
}

/** Pure: a lite token scan -> the small token record verdicts use. pending = new token whose on-chain read is still queued.
 *  The scan is read with guardScan first, so an official or established coin never carries a promotion-only danger. */
export function tokenFacts(raw, opts = {}) {
  if (!raw?.found) return null;
  const tok = guardScan(raw, opts);
  const b = tok.launch?.bundle;
  return {found: true, symbol: tok.symbol || null, address: tok.address ? normAddr(tok.address) : null, level: tok.level, reasons: (tok.reasons || []).slice(0, 3),
    launch: tok.launch ? {lines: (tok.launch.lines || []).slice(0, 3)} : null,
    bundled: !!(b?.flagged && b.strength === 'strong'), bundle: b ? {wallets: b.wallets, supplyPct: b.supplyPct, kind: b.kind || null} : null,
    ...(tok.standing ? {standing: tok.standing} : {}),
    pending: !tok.launch && (!!tok.pending || (tok.ageHours ?? 999) < 24)};
}

/** Pure: is a scam-KOL push (api kol/push.js kolPushFor: {kind, target}) about a protected subject? The author's own
 *  account when it is official, a protected ticker, or a contract that is official or (per its scan) established. */
export function pushOnProtected(t, kp, facts = {}) {
  if (!kp) return false;
  const target = String(kp.target || '');
  if (kp.kind === 'handle') return officialHandle(t?.author?.handle) || officialHandle(target);
  if (kp.kind === 'ticker') return protectedTicker(target);
  if (kp.kind === 'ca') return !!officialToken(target) || [facts.postToken, facts.projectToken].some((x) => x?.standing && x.address && x.address === normAddr(target));
  return false;
}
/** Pure: facts with the push on a protected subject taken out. The push stays a true fact about the posters (their own
 *  posts and profiles still show it); it is just never a verdict on, or a row under, an official or established coin. */
export function guardFacts(t, facts = {}) {
  if (!facts.kolPush || !pushOnProtected(t, facts.kolPush, facts)) return facts;
  const {kolPush, kolPushLines, ...rest} = facts;
  return rest;
}

// --- the live API's verdicts, read again in the extension (background.js sharpen) until the API runs these rules ---
const SOL_CA = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;
/** Pure: the first contract a post names (X's "robinhood:0x..." smart cashtags included), EVM lower-cased. */
export function postAddress(t) {
  const text = `${t?.text || ''} ${t?.quoted?.text || ''}`;
  const evm = text.match(/0x[a-fA-F0-9]{40}/);
  if (evm) return evm[0].toLowerCase();
  return (text.replace(/0x[a-fA-F0-9]+/g, ' ').match(SOL_CA) || []).find((a) => /\d/.test(a) && /[a-z]/.test(a) && /[A-Z]/.test(a)) || null;
}
/** Pure: the push subject a verdict names in its push line ("$ZEC pushed by 2 accounts ...", "0x39db...4571 pushed by ...",
 *  "This account pushed by ...") -> {kind, target} like kolPushFor's, or null. */
export function pushSubject(v, t) {
  const lines = [v?.label === 'Scam KOL push' ? v.detail : null, ...(v?.card?.rows || []).filter((r) => r.kind === 'flags').flatMap((r) => r.lines || [])];
  for (const line of lines) {
    const s = String(line || '');
    if (!/ pushed by \d+ accounts? from a known scam KOL group/.test(s)) continue;
    if (/^This account /.test(s)) return {kind: 'handle', target: String(t?.author?.handle || '').toLowerCase()};
    let m = s.match(/^\$([A-Za-z0-9]{1,15}) /);
    if (m) return {kind: 'ticker', target: m[1].toUpperCase()};
    m = s.match(/^(\w{6})\.\.\.(\w{4}) /);
    if (m) {
      const a = postAddress(t);
      return {kind: 'ca', target: a && a.startsWith(normAddr(m[1])) && a.endsWith(normAddr(m[2])) ? a : `${m[1]}...${m[2]}`};
    }
  }
  return null;
}
// labels the old rules put on a post because of the coin's scan: red "High-risk token", "Token launch" with a danger or
// caution read, a project dossier turned red by its token. A bundled launch ("Scam", "$X bundled") is on-chain proof: never.
const tokenRead = (v) => v?.label === 'High-risk token' || (v?.label === 'Token launch' && /\b(danger|caution flags)\b/.test(v.detail || '')) || (/^(New project|Project)$/.test(v?.label || '') && v.tone === 'rug');
/** Pure: does this API verdict need the standing guard? Cheap, no network: true only for the labels and rows a promotion
 *  signal can produce. */
export const needsGuard = (v, t) => !!v && !v.hidden && (tokenRead(v) || !!pushSubject(v, t));
/**
 * Pure: an API verdict read with the standing guard. t: the post; v: the live API's verdict; scan: the lite scan of the
 * post's contract (or of the author's own official token), or null when there is none or it failed.
 * -> null: keep v as it is
 *    {redo: false, card}: keep the label, drop the push row about a protected subject
 *    {redo: true, card, postToken}: the label came from promotion signals on a protected coin: decide again (locally) with
 *      the guarded postToken, keeping the API's other rows (calls, smart followers, reputation ...)
 */
export function guardApiVerdict(t, v, scan = null) {
  if (!needsGuard(v, t)) return null;
  const ca = postAddress(t);
  // the scan is of the post's contract (the coin the API's postToken read); nothing else is used as the post's token
  const postToken = ca && scan?.found && normAddr(scan.address || '') === ca ? tokenFacts(scan) : null;
  const subj = pushSubject(v, t);
  const pushSafe = !!subj && pushOnProtected(t, subj, {postToken});
  // the guard took the scan's danger (or caution) away: it came from promotion signals on an established coin
  const guarded = !!postToken?.standing && scan.level !== postToken.level;
  // a post naming no contract: only the project dossier of an official token's own account (its bio contract) qualifies
  const coinSafe = ca ? !!officialToken(ca) || guarded : /^(New project|Project)$/.test(v.label) && !!officialTokenOf(t?.author?.handle);
  const redo = (v.label === 'Scam KOL push' && pushSafe) || (tokenRead(v) && coinSafe);
  if (!redo && !pushSafe) return null;
  const rows = (v.card?.rows || []).filter((r, k) => !(r.kind === 'flags' && ((redo && k === 0) || (pushSafe && /scam KOL group|^KOL push$/.test(r.title || '')))));
  // the one-line detail under the pill was the push line itself (finalize takes it from the first flags row): it goes too
  const dropDetail = pushSafe && / pushed by \d+ accounts? from a known scam KOL group/.test(v.detail || '');
  return {redo, card: rows.length ? {...v.card, rows} : null, postToken, dropDetail};
}

// A project talking about itself: a link whose domain names the author (royalty.band from @royaltymsc, apes.app from @Apesdotapp).
const GENERIC = new Set(['app', 'xyz', 'fi', 'io', 'hq', 'labs', 'dao', 'fun', 'dot', 'official', 'the', 'msc', 'co', 'inc', 'finance', 'protocol', 'network']);

/** Pure: a label ("royalty.band" -> "royalty") and whether it names the author. */
const clean = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
export function linkRoots(urls = [], text = '') {
  const hosts = new Set();
  for (const u of urls) { try { hosts.add(new URL(u).hostname.replace(/^www\./, '')); } catch { /* skip */ } }
  for (const m of String(text).match(/\b[a-z0-9-]{3,30}\.(?:app|xyz|fun|io|fi|band|market|finance|money|gg|so|com|ai|net|org|club|world|lol|meme|trade|exchange)\b/gi) || []) hosts.add(m.toLowerCase());
  return [...hosts].filter((h) => !/(^|\.)(x|twitter|t|dexscreener|pump|blockscout|robinhood|youtube|youtu|tiktok|instagram|discord|telegram|linktr)\.[a-z.]+$/.test(h)).map((h) => clean(h.split('.').slice(-2, -1)[0]));
}
/** Pure: is this post the project talking about itself? (royalty.band from @royaltymsc / "Royalty", apes.app from @Apesdotapp) */
export function isOwnProjectPost(t) {
  const who = [clean(t.author?.handle), clean(t.author?.name)].filter(Boolean);
  const stem = (s) => { let x = s; for (const g of GENERIC) if (x.length > g.length + 2 && x.endsWith(g)) x = x.slice(0, -g.length); return x; };
  return linkRoots(t.urls || [], t.text || '').some((root) => root.length >= 3 && !GENERIC.has(root) && who.some((w) => w.includes(root) || (stem(w).length >= 3 && root.includes(stem(w)))));
}



// Smart-list categories (vc, solana_founder, memecoin_trader, onchain_sleuth, nft_culture...) -> 8 display roles.
export const roleOf = (cat) => {
  const c = String(cat || '').toLowerCase();
  if (/sleuth|security/.test(c)) return 'sleuth';
  if (/\bvc\b|^vc|fund|invest/.test(c)) return 'vc';
  if (/trader/.test(c)) return 'trader';
  if (/founder/.test(c)) return 'founder';
  if (/research|analyst/.test(c)) return 'researcher';
  if (/media|news/.test(c)) return 'media';
  if (/kol|nft|culture|creator/.test(c)) return 'creator';
  if (/builder|base|robinhood|hyperliquid|dev/.test(c)) return 'builder';
  return 'smart';
};

// Fable Rep, 0-100: our reading of an account's public reputation record (reviews, vouches, staked backing).
// 800 -> 40, 1600 -> 75 (reputable), 2400+ -> 100. Shown as Fable's own number everywhere in the UI.
export const fableRep = (score) => {
  const s = Number(score);
  if (!Number.isFinite(s)) return null;
  const r = s < 800 ? s / 20 : s < 1600 ? 40 + ((s - 800) * 35) / 800 : 75 + ((s - 1600) * 25) / 800;
  return Math.max(0, Math.min(100, Math.round(r)));
};
// Fable Rep is shown as our own number only: no counts, backers or stakes leave the server
export const REP_SOURCE = "Scored by Fable's private reputation database";

// On-chain / DB evidence strong enough to decide a verdict without reading the text.
export const hardEvidence = (facts = {}) => {
  const d = facts.detect;
  const dStrong = !!(d && (d.network?.label || d.launch?.some((l) => l.strong) || d.project));
  return !!((facts.opRoles?.length > 0) || (facts.trackedRugs?.length > 0) || (facts.kolWatch && facts.kolWatch.tier !== 'C') || (facts.deployer && facts.deployer.rugged >= 2) || facts.projectRugs?.length || !!facts.freshContract || !!facts.postToken?.bundled || (facts.calls && facts.calls.total >= 5) || dStrong);
};

// Is a Jev call worth making for this post? Only when it can change what the user sees.
export function needsJev(t, facts = {}) {
  if (t.profile || establishedOrg(t, facts) || hardEvidence(facts)) return false;
  if (!isCryptoContext(t, facts)) return false;
  const text = `${t.text || ''} ${t.quoted?.text || ''}`;
  const signal = (t.cashtags?.length || 0) > 0 || RX.ca.test(text) || (t.urls?.length || 0) > 0 || RX.hype.test(text) || RX.bait.test(text) || RX.money.test(text) || RX.promo.test(text) || slopScore(t.text).score >= 1.5;
  return signal;
}

const followedLine = (k) => `Followed by ${k.n} accounts from a known scam KOL group: ${k.kols.slice(0, 3).map((h) => `@${h}`).join(', ')}${k.n > 3 ? ` and ${k.n - 3} more` : ''}`;

const n0 = (x) => (x >= 1e6 ? `${(x / 1e6).toFixed(1)}M` : x >= 1e3 ? `${Math.round(x / 1e3)}K` : String(x));
// "Builder: @x (their bio names it) · 12K followers · followed by 4 smart accounts"
const builderLine = (m) => [`Builder: @${m.handle}${m.how ? ` (${m.how})` : ''}`,
  m.followers != null ? `${n0(m.followers)} followers` : null,
  m.onList ? "on Fable's smart list" : m.smart ? `followed by ${m.smart} smart account${m.smart === 1 ? '' : 's'}` : 'no smart followers',
  m.kol ? 'reported shill account' : null,
  m.rugs ? `linked to ${m.rugs} rug${m.rugs === 1 ? '' : 's'}` : null].filter(Boolean).join(' · ');
/** Pure: dossier (+ optional lite token scan) -> the project verdict. Every line is a counted fact. */
export function projectVerdict(P, tok) {
  const fresh = P.ageDays != null && P.ageDays < 30;
  const ageLine = P.ageDays == null ? 'Account age unknown' : P.ageDays === 0 ? 'Account created today' : `Account is ${P.ageDays} day${P.ageDays === 1 ? '' : 's'} old`;
  const lines = [`${ageLine}${P.followers ? ` · ${n0(P.followers)} followers` : ''}${P.vtype === 'Business' ? ' · gold tick' : ''}`];
  lines.push(P.smart ? `Followed by ${P.smart} smart account${P.smart === 1 ? '' : 's'}` : 'No smart accounts follow it yet');
  if (P.kolFollowed) lines.push(`Followed by ${P.kolFollowed} accounts from a known scam KOL group`);
  // who is behind it: builders publicly linked to it, each with what we know about them
  for (const m of P.team || []) lines.push(builderLine(m));
  if (!(P.team || []).length) lines.push(P.timelineRead ? 'No builder publicly linked to it: no founder in its bio, its posts or any bio that names it' : 'No builder publicly linked to it yet');
  // who is pushing it, named
  const TAG = {smart: 'smart', 'scam-kol': 'scam KOL group', 'kol-linked': 'follows the scam KOL group', ring: 'promotion ring'};
  const who = (ps) => ps.slice(0, 4).map((p) => `@${p.handle}${p.tag ? ` (${TAG[p.tag]})` : ''}`).join(', ');
  if (P.posterCount) lines.push(`Posted about by ${who(P.posters || [])}${P.posterCount > 4 ? ` and ${P.posterCount - 4} more` : ''}${P.scamPosters ? ` · ${P.scamPosters} tied to scam KOL groups or promotion rings` : ''}`);
  if ((P.amplifiers || []).length) lines.push(`Reposts ${P.amplifiers.slice(0, 4).map((a) => `@${a.handle}${a.kol ? ' (scam KOL group)' : a.onList ? ' (smart)' : ''}`).join(', ')}`);
  const tokBad = tok?.found && tok.level === 'danger';
  if (tok?.found) {
    const why = (tok.launch?.lines || []).find((l) => l.strength === 'strong')?.text || (tok.reasons || [])[0]?.text;
    lines.push(`$${tok.symbol || 'token'}: ${{danger: 'high risk', caution: 'caution', ok: 'no red flags', unknown: 'not enough data'}[tok.level] || tok.level}${why ? `. ${String(why).replace(/.$/, '')}` : ''}`);
  }
  const teamBad = (P.team || []).some((m) => m.kol || m.rugs);
  // red only on evidence about the project itself; scam-group follows and posts are context (the group follows and
  // pushes legit projects too), so real smart backing outweighs them and they only turn a project amber without it
  const backed = P.smart >= 3 || (P.team || []).some((m) => m.onList || m.smart >= 3);
  const groupHeat = P.scamPosters >= 2 || P.kolFollowed >= 3;
  const tone = tokBad || teamBad ? 'rug' : backed ? 'legit' : groupHeat || (fresh && !P.smart) ? 'kol' : 'neutral';
  const b = (P.team || []).find((m) => m.onList || m.smart >= 3) || (P.team || [])[0];
  const detail = tone === 'rug' ? lines.find((l) => /reported|high risk|linked to \d+ rug/.test(l)) || lines[0]
    : tone === 'legit' ? (P.smart >= 3 ? lines[1] : `Built by @${b.handle}${b.onList ? " · on Fable's smart list" : ` · followed by ${b.smart} smart accounts`}`)
      : groupHeat ? lines.find((l) => /scam KOL/.test(l))
        : `${ageLine}${b ? ` · built by @${b.handle}` : P.timelineRead ? ' · no builder linked' : ''}${P.smart ? '' : ' · no smart followers yet'}`;
  return {tone, label: fresh ? 'New project' : 'Project', stat: fresh ? (P.ageDays === 0 ? 'created today' : `${P.ageDays}d old`) : `${P.smart} smart`, confidence: 0.75,
    detail, card: {type: 'lines', tone: tone === 'legit' ? 'legit' : tone === 'rug' ? 'rug' : 'kol', title: 'Project dossier', lines}};
}

// Fable-confirmed entries: leads people submit at fable.market/submit that Fable reviewed and confirmed
// (CONFIRMED-ENTRIES-SPEC.md). The server attaches them as facts.curated: [{id, kind, label, tag, detail, evidence (a
// count), related, group, on: 'author' | 'post'}]. Stronger than text signals, weaker than on-chain proof: they come after
// the chain checks, never stamp, and a post warning about a confirmed scam token is never flagged for it.
const CURATED_TONE = {scam_account: 'rug', impersonator: 'rug', scam_token: 'rug', shiller: 'kol', kol_group: 'kol', hacked: 'kol'};
const curatedLines = (c) => [c.detail, c.kind === 'impersonator' && c.related ? `Impersonates @${c.related}` : null, c.kind === 'kol_group' && c.group ? `Part of ${c.group}` : null,
  `Reviewed and confirmed by Fable${c.evidence ? ` · ${c.evidence} piece${c.evidence === 1 ? '' : 's'} of evidence` : ''}`].filter(Boolean);
export const curatedVerdict = (base, facts = {}, s = {}) => {
  const list = facts.curated || [];
  const tok = s.kind !== 'warning' && list.find((c) => c.kind === 'scam_token' && c.on === 'post');
  const acct = ['hacked', 'scam_account', 'impersonator', 'shiller', 'kol_group'].map((k) => list.find((c) => c.kind === k && c.on === 'author')).find(Boolean);
  const c = tok || acct;
  if (!c) return null;
  const tone = CURATED_TONE[c.kind];
  return {...base, tone, label: c.label, stat: 'confirmed', confidence: 0.9, fade: tone === 'rug', curated: c.id, detail: c.detail || undefined,
    card: {type: 'lines', tone, title: 'Confirmed by Fable', lines: curatedLines(c)}};
};
export const curatedTrusted = (base, facts = {}) => {
  const c = (facts.curated || []).find((x) => x.kind === 'trusted' && x.on === 'author');
  if (!c) return null;
  return {...base, tone: 'legit', label: c.label || 'Trusted', stat: c.tag || 'confirmed', confidence: 0.88, curated: c.id, detail: c.detail || undefined,
    card: {type: 'lines', tone: 'legit', title: 'Confirmed by Fable', lines: curatedLines(c)}};
};

function decide(t, s, facts, source) {
  const base = {id: t.id, source};
  const pct = (x) => `${Math.round(x * 100)}%`;
  const d = facts.detect;
  const dStrong = !!(d && (d.network?.label || d.launch?.some((l) => l.strong) || d.project));
  const hard = hardEvidence(facts);
  const reportLine = d?.reports ? [`Reported by ${d.reports.sources} community list${d.reports.sources > 1 ? 's' : ''}.`] : [];
  // the scam checks (scam.js) are crypto by construction: a seed phrase ask or a fake MetaMask desk is never hidden
  const sc = establishedOrg(t, facts) ? null : scamCheck(t, facts);
  if (!hard && !sc && !t.profile && !facts.project && !isOwnProjectPost(t) && !isCryptoContext(t, facts)) return {...base, hidden: true};

  // 1. Hard evidence from our DB
  // a big account pushing a contract that launched minutes earlier (outranks Trusted: trusted accounts are the ones that get hacked)
  if (facts.freshContract) {
    const fc = facts.freshContract;
    const what = fc.symbol ? `$${fc.symbol}` : 'This contract';
    return {...base, tone: 'rug', label: 'Possible hacked account', stat: `${fc.minutes}m old token`, confidence: 0.8,
      detail: `${what} started trading ${fc.minutes} minute${fc.minutes === 1 ? '' : 's'} before this post`,
      card: {type: 'lines', tone: 'rug', title: 'Brand-new contract', lines: [`${what} started trading ${fc.minutes} minute${fc.minutes === 1 ? '' : 's'} before this post`, 'Hacked big accounts have pushed brand-new tokens exactly like this', `Contract: ${fc.address}`]}};
  }
  if (facts.deployer && facts.deployer.rugged >= 2) {
    const d = facts.deployer;
    return {...base, tone: 'rug', label: 'Rug history', stat: `${d.rugged}/${d.launched}`, confidence: 0.95, stamp: 'RUG', fade: true,
      card: {type: 'rug', title: 'Deployer history', wallet: d.wallet, stats: [[String(d.launched), 'tokens launched'], [String(d.rugged), 'rugged'], [`${d.avgDrawdown}%`, 'avg drawdown']], tokens: d.tokens || []}};
  }
  // the account IS a project of a published rug operation (its token was the rug the KOL group shilled)
  const pa = (facts.opRoles || []).find((r) => r.role === 'Project account');
  if (pa) {
    const p = facts.projectRugs || [];
    const money = (x) => (x >= 1e6 ? `$${(x / 1e6).toFixed(1)}M` : `$${Math.round(x / 1e3)}K`);
    const syms = [...new Set(p.map((x) => x.symbol).filter(Boolean))];
    const taken = p.reduce((s, x) => s + (x.netUsd || 0), 0);
    const op = p.find((x) => x.opLaunches);
    const lines = [
      `Launch account for the ${pa.name}, a tracked serial bundle-rug operation${op ? ` (${op.opLaunches} launches, ${money(op.opNetUsd)} extracted)` : ''}`,
      ...(syms.length ? [`${syms.map((s) => `$${s}`).join(', ')} launched ${p.length} time${p.length === 1 ? '' : 's'}, bundled at launch${taken > 1000 ? `, ${money(taken)} extracted` : ''}`] : []),
      ...(pa.tracked && !syms.length ? [`${typeof pa.tracked === 'string' ? `$${pa.tracked}` : 'Its token'} was launched with this operation's bundle wallets`] : []),
      ...(pa.kols?.length ? [`Shilled by the operation's KOL group: ${pa.kols.slice(0, 4).map((k) => `@${k}`).join(', ')}${pa.kols.length > 4 ? ` and ${pa.kols.length - 4} more` : ''}`] : []),
    ];
    return {...base, tone: 'rug', label: 'Scam project', stat: syms.length ? `$${syms[0]}${taken > 1000 ? ` · ${money(taken)} extracted` : ''}` : 'tracked operation', confidence: 0.95, stamp: 'SCAM', fade: true,
      detail: lines[0], card: {type: 'lines', tone: 'rug', title: 'Rug operation', lines: [...lines, ...(facts.kolLines || [])]}};
  }
  // named as the promoter group in a published Fable investigation
  const pr = (facts.opRoles || []).find((r) => r.role === 'Promoter');
  if (pr) {
    const lines = [`Named in a Fable investigation: promoter group of the ${pr.name}`, 'Operation: 31 bundled launches, $12.7M extracted'];
    return {...base, tone: 'rug', label: 'Scam KOL network', stat: 'Promoter group', confidence: 0.9, stamp: 'SHILL', fade: true,
      detail: lines[0], card: {type: 'lines', tone: 'rug', title: 'KOL network', lines: [...lines, ...(facts.kolLines || [])]}};
  }

  // promoted tokens from our own rug investigations
  const tr = facts.trackedRugs || [];
  if (tr.length) {
    const lines = [`Promoted ${tr.length} token${tr.length > 1 ? 's' : ''} from a tracked bundle-rug operation`, `Tokens: ${tr.slice(0, 5).map((x) => `$${x.symbol}`).join(', ')}`];
    return {...base, tone: 'rug', label: 'Promoted tracked rugs', stat: `${tr.length} rug${tr.length > 1 ? 's' : ''}`, confidence: 0.9, stamp: tr.length >= 2 ? 'SHILL' : undefined, fade: tr.length >= 2,
      detail: lines[0], card: {type: 'lines', tone: 'rug', title: 'Tracked rugs', lines: [...lines, ...(facts.kolLines || [])]}};
  }

  // researched scam KOL network: evidence per account (public reports + collapsed coins)
  const kw = facts.kolWatch;
  if (kw && kw.tier === 'A') {
    return {...base, tone: 'rug', label: 'Scam KOL network', stat: kw.collapsed ? `${kw.collapsed} collapsed coin${kw.collapsed > 1 ? 's' : ''}` : `${kw.sources} report${kw.sources > 1 ? 's' : ''}`, confidence: 0.92, stamp: 'SHILL', fade: true,
      detail: (facts.kolLines || [])[0] || '', card: {type: 'lines', tone: 'rug', title: 'KOL network', lines: facts.kolLines || []}};
  }
  if (kw && kw.tier === 'B') {
    return {...base, tone: 'kol', label: 'Reported shill account', stat: `${kw.sources} report${kw.sources > 1 ? 's' : ''}`, confidence: 0.8,
      detail: (facts.kolLines || [])[0] || '', card: {type: 'lines', tone: 'kol', title: 'KOL network', lines: facts.kolLines || []}};
  }

  // the account's own project token, verified rugged on-chain
  if (facts.projectRugs && facts.projectRugs.length) {
    const p = facts.projectRugs;
    const dd = (x) => (x.drawdown == null ? 0 : -Math.round(x.drawdown * 100));
    const money = (x) => (x >= 1e6 ? `$${(x / 1e6).toFixed(1)}M` : `$${Math.round(x / 1e3)}K`);
    const pulled = p.some((x) => x.kind === 'rugged');
    const ex = [...p].filter((x) => x.netUsd).sort((a, b) => b.netUsd - a.netUsd)[0];
    return {...base, tone: 'rug', label: pulled ? 'Linked to rugs' : 'Token collapsed', stat: ex ? `$${ex.symbol} · ${money(ex.netUsd)} extracted` : `$${p[0].symbol} ${dd(p[0])}%`, confidence: 0.93, stamp: pulled ? 'RUG' : undefined, fade: true,
      detail: ex?.opLaunches ? `Bundled launch by a serial rug operator: ${ex.opLaunches} launches, ${money(ex.opNetUsd)} extracted` : undefined,
      card: {type: 'rug', title: 'Project token', wallet: p[0].deployer || p[0].address, stats: [[String(p.length), p.length > 1 ? 'tokens' : 'token'], [String(p.filter((x) => x.kind === 'rugged').length), 'liquidity pulled'], [`${dd(p[0])}%`, 'from peak']], tokens: p.map((x) => [`$${x.symbol}`, dd(x)])}};
  }
  // detectors: every line is an observed fact with evidence behind it
  if (d?.network?.label === 'Linked to rugs') {
    const l = d.network.links[0];
    return {...base, tone: 'rug', label: 'Linked to rugs', stat: l?.other?.handle ? `@${l.other.handle}` : 'wallets', confidence: 0.85,
      card: {type: 'lines', tone: 'rug', title: 'Linked accounts', lines: [...d.lines.map((x) => x.text).slice(0, 3), ...reportLine]}};
  }
  const tokenRisk = d?.launch?.find((l) => l.strong);
  if (tokenRisk) {
    const b = tokenRisk.bundle;
    return {...base, tone: 'rug', label: b?.flagged ? 'Bundled launch' : 'Token risk', stat: b?.flagged ? `${Math.round(b.supplyPct)}% bundled` : `$${tokenRisk.symbol}`, confidence: 0.9, fade: true,
      card: {type: 'lines', tone: 'rug', title: `$${tokenRisk.symbol} launch`, lines: [...(tokenRisk.lines || []).map((x) => x.text), ...reportLine]}};
  }
  // The contract in the post, read on-chain: a bundled launch is a Scam on whoever posts it (not on a warning about it)
  const pt = facts.postToken || facts.projectToken;
  const recheck = pt?.pending ? {recheck: true} : {};
  if (pt?.found && s.kind !== 'warning' && (pt.bundled || pt.level === 'danger')) {
    const sym = pt.symbol ? `$${pt.symbol}` : 'This token';
    const strong = (pt.launch?.lines || []).filter((l) => l.strength === 'strong').map((l) => l.text);
    const lines = [...(strong.length ? strong : (pt.reasons || []).map((r) => r.text)), ...reportLine].filter(Boolean);
    return {...base, tone: 'rug', label: pt.bundled ? 'Scam' : 'High-risk token', stat: pt.bundled ? `${sym} bundled` : sym, confidence: 0.9,
      stamp: pt.bundled && !facts.trusted ? 'SCAM' : undefined, fade: true,
      detail: pt.bundled && pt.bundle ? `${sym}: ${pt.bundle.wallets} wallets took ${Math.round(pt.bundle.supplyPct)}% of supply at launch` : lines[0],
      card: {type: 'lines', tone: 'rug', title: `${sym} on-chain`, lines}};
  }
  if (d?.network?.label === 'Promotes with a shill ring') {
    return {...base, tone: 'kol', label: 'Promotion ring', stat: d.ring ? `${d.ring.collapsed}/${d.ring.shared} collapsed` : `${d.waves?.count || 0} waves`, confidence: 0.85,
      card: {type: 'lines', tone: 'kol', title: 'Promotion record', lines: [...d.lines.map((x) => x.text).slice(0, 3), ...reportLine]}};
  }
  if (d?.project) {
    return {...base, tone: 'rug', label: 'New project, high risk', stat: `${d.project.count} red flags`, confidence: 0.75,
      card: {type: 'lines', tone: 'rug', title: 'Launch red flags', lines: [...d.lines.map((x) => x.text).slice(0, 4), ...reportLine]}};
  }

  // Fable-confirmed warnings (fable.market submissions Fable confirmed): after the chain checks, before anything read off text
  const cv = curatedVerdict(base, facts, s);
  if (cv) return cv;

  // Scams read straight off the post (scam.js): an impersonator's copied handle and name, a phishing domain, "send X get
  // 2X", a seed phrase ask, fake support. Each is a fact the card shows, never a model guess, so Jev cannot move it.
  // Established organisations are exempt like every text rule; a warning about a scam never fires the text checks.
  if (sc &&(sc.kind === 'impersonation' || s.kind !== 'warning')) {
    // a trusted or well-followed account posting this was more likely hacked than turned: the label, no stamp
    const vouched = !!facts.trusted || (facts.smart?.length || 0) >= 3;
    return {...base, tone: 'rug', label: sc.label, stat: sc.stat, confidence: sc.confidence, stamp: vouched ? undefined : sc.stamp, fade: true,
      detail: vouched ? `${sc.detail}. Out of character for this account: a sign it was hacked` : sc.detail,
      card: {type: 'lines', tone: 'rug', title: sc.label, lines: sc.lines}};
  }


  // a factual call record, graded against real prices. Payment is not proven, so no "paid" label here.
  if (facts.calls && facts.calls.total >= 5 && (facts.calls.tone === 'bad' || facts.calls.dead / facts.calls.total >= 0.7)) {
    const c = facts.calls;
    // the record is evidence; the SHILL stamp also needs this post to be a confident call on something code can see
    const shilling = s.kind === 'shill' && s.kindConf >= 0.7 && ((t.cashtags?.length || 0) > 0 || RX.ca.test(`${t.text || ''}`));
    return {...base, tone: 'kol', label: 'Poor call record', stat: `${c.dead}/${c.total} dead`, confidence: 0.9, stamp: shilling ? 'SHILL' : undefined, fade: shilling,
      card: {type: 'kol', title: 'Call record', tokens: c.tokens || [], footer: hasRefLink(t) ? 'Referral link in post' : `${c.total} calls tracked`}};
  }

  // a public reputation record that is clearly negative (reviews, not our opinion)
  if (facts.rating && facts.rating.score < 800 && facts.rating.negative >= 5 && facts.rating.negative > facts.rating.positive) {
    return {...base, tone: 'kol', label: 'Poorly rated', byRep: true, stat: `Rep ${fableRep(facts.rating.score)}`, confidence: 0.75,
      card: {type: 'lines', tone: 'kol', title: 'Fable Rep', right: 'Fable Rep', lines: facts.ratingLines || []}};
  }

  // 2. Text signals (never for verified organisations)
  // only an ESTABLISHED organisation is exempt from text guesses; a new gold tick is read like anyone else
  const org = establishedOrg(t, facts);
  const own = isOwnProjectPost(t);
  if (!org && s.kind !== 'warning' && (s.bait > 0.8 || (s.kind === 'scam' && s.kindConf >= 0.9 && s.bait >= 0.5))) {
    const c = Math.max(s.bait, s.kindConf);
    // A model probability alone never stamps: Jev needs 0.95+ AND the bait regex (or a sure scam kind) to agree.
    // A trusted account (or one 3+ smart accounts follow) keeps the label without a stamp: more likely hacked than a scammer.
    const agreed = !s.jev || (c >= 0.95 && (s.baitRegex || (s.kind === 'scam' && s.kindConf >= 0.9)));
    const vouched = !!facts.trusted || (facts.smart?.length || 0) >= 3;
    return {...base, tone: 'rug', label: 'Scam', stat: pct(c), confidence: c, stamp: c > 0.9 && agreed && !vouched ? 'SCAM' : undefined, fade: true,
      ...(vouched ? {detail: 'Unusual for this account: it may be compromised'}
        : s.drainer ? {detail: 'Fake claim post written with hidden characters to slip past filters'}
          : s.obfuscated ? {detail: 'Written with hidden or look-alike characters to slip past filters'}
            : {detail: s.baitRegex ? 'Asks readers to reply, DM or send money' : 'Reads like bait aimed at the reader'})};
  }
  // warnings and call-outs: the author is warning people, never the one being flagged
  if (s.kind === 'warning') {
    const who = [...new Set([...(String(t.text || '').match(/@[A-Za-z0-9_]{2,15}/g) || []), ...(t.cashtags || []).map((c) => `$${c}`)])].slice(0, 3);
    return {...base, tone: 'neutral', label: 'Call-out', stat: 'warning', confidence: s.kindConf, detail: who.length ? `Warns about ${who.join(', ')}` : 'Warns readers about a scam or bad actor'};
  }
  // CTA farming (follow / like / RT / drop your wallet for a mint or whitelist): engagement bait, amber, not a scam
  if (!org && s.kind === 'cta') return {...base, tone: 'kol', label: 'CTA farm', stat: 'engagement bait', confidence: 0.8, detail: ctaAsks(t.text)};
  // Known scam KOLs pushing the account or a coin this post names. The same group also pushes legit projects, so it is
  // context (amber), and the label only when this account IS the pushed project or this post is itself shilling it.
  const kp = facts.kolPush;
  // a reputable or smart-followed author is commenting, not shilling: never the push label (a row at most)
  const credibleAuthor = (facts.rating?.score >= 1600) || (facts.smart?.length || 0) >= 3;
  if (kp && kp.n >= 2 && !facts.trusted && !org && !credibleAuthor && (kp.kind === 'handle' || s.kind === 'shill')) {
    return {...base, tone: 'kol', label: 'Scam KOL push', stat: `${kp.n} KOLs · 7d`, confidence: 0.8,
      detail: (facts.kolPushLines || [])[0], card: {type: 'lines', tone: 'kol', title: 'KOL push', lines: [...(facts.kolPushLines || []), ...(facts.kolFollowed ? [followedLine(facts.kolFollowed)] : [])]}};
  }
  // "Promo post" needs something code can see (ticker, contract or link), and a disclosed ad is never faded
  const promoted = (t.cashtags?.length || 0) > 0 || RX.ca.test(`${t.text || ''}`) || (t.urls?.length || 0) > 0;
  if (!org && !own && s.kind === 'shill' && s.promo > (s.jev ? 0.75 : 0.5) && promoted) {
    // a promotion is not a warning: a plain line saying what it promotes, never a dimmed post
    const host = () => { try { const u = t.urls[0]; return new URL(typeof u === 'string' ? u : u.expanded_url || u.url).hostname.replace(/^www\./, ''); } catch { return 'a link'; } };
    const what = t.cashtags?.length ? `$${String(t.cashtags[0]).replace(/^\$/, '').toUpperCase()}` : RX.ca.test(`${t.text || ''}`) ? 'a contract' : host();
    return {...base, tone: 'kol', label: 'Promo post', stat: pct(s.promo), confidence: s.promo,
      detail: s.disclosed >= 0.7 ? `Disclosed as an ad or holding · promotes ${what}` : `Promotes ${what}`};
  }

  // Official organisations: said plainly, no smart-follower pitch
  if (org) {
    const age = ageDaysOf(t, facts);
    const since = age != null ? new Date(Date.now() - age * DAY_MS).getFullYear() : null;
    // a gold tick launching a token is read as a token launch: the tick says who posted it, not that the coin is safe
    if (tokenAnnouncement(t) || pt?.found) {
      const sym = pt?.symbol ? `$${pt.symbol}` : (t.cashtags?.[0] ? `$${String(t.cashtags[0]).toUpperCase()}` : 'its token');
      const read = !pt?.found ? 'not trading yet, nothing on-chain to read' : pt.pending ? 'on-chain read in progress'
        : {caution: 'caution flags on-chain', ok: 'no red flags on-chain so far', unknown: 'not enough on-chain data yet'}[pt.level] || pt.level;
      const lines = [`Verified organization${since ? ` since ${since}` : ''}`, `${sym}: ${read}`, ...(pt?.reasons || []).map((r) => r.text)].filter(Boolean);
      const clean = pt?.level === 'ok' && !pt.pending;
      return {...base, ...recheck, tone: clean ? 'neutral' : 'kol', label: 'Token launch', stat: sym, confidence: 0.75,
        detail: `Verified org${since ? ` since ${since}` : ''} · ${sym} ${read}`, card: {type: 'lines', tone: clean ? 'legit' : 'kol', title: `${sym} launch`, lines}};
    }
    return {...base, tone: 'neutral', label: 'Official account', stat: 'verified org', confidence: 0.8, detail: `Verified organization${since ? ` · on X since ${since}` : ''}`};
  }
  // A project account (its own post, its profile, a new gold tick): the dossier, not a follower count
  if (facts.project) {
    const pv = projectVerdict(facts.project, facts.projectToken);
    return {...base, ...pv};
  }

  // 3. Positive evidence. A Fable-confirmed trusted account first, then accounts on Fable's own smart list.
  const ct = curatedTrusted(base, facts);
  if (ct) return ct;
  if (facts.trusted) {
    const n = facts.smartCount || facts.smart?.length || 0;
    return {...base, tone: 'legit', label: 'Trusted', role: roleOf(facts.trusted.category), stat: String(n), confidence: 0.9,
      avatars: (facts.smart || []).slice(0, 3).map((p) => p.avatar).filter(Boolean),
      detail: n ? undefined : "On Fable's list of smart accounts",
      card: n ? {type: 'smart', title: `Followed by ${n} smart account${n > 1 ? 's' : ''}`, people: (facts.smart || []).slice(0, 3), score: Math.min(0.99, 0.6 + n * 0.08), scoreLabel: 'Trusted'} : undefined};
  }
  // Fable Rep leads unless the smart-follower signal is strong (3+).
  const ev = facts.rating;
  const smartN = facts.smart?.length || 0;
  if (ev && ev.score >= 1600 && ev.positive >= 3 * Math.max(1, ev.negative) && smartN < 3) {
    const names = (facts.smart || []).slice(0, 2).map((p) => p.name || p.handle).join(' and ');
    const faces = (facts.smart || []).map((p) => p.avatar).filter(Boolean).slice(0, 3);
    return {...base, tone: 'legit', label: 'Well rated', byRep: true, stat: `Rep ${fableRep(ev.score)}`, confidence: 0.82, avatars: faces.length ? faces : undefined,
      card: {type: 'lines', tone: 'legit', title: 'Fable Rep', right: 'Fable Rep', lines: [...(smartN ? [`Followed by ${names}`] : []), ...(facts.ratingLines || [])]}};
  }
  if (facts.smart && facts.smart.length) {
    const n = facts.smart.length;
    return {...base, tone: 'legit', label: s.kind === 'builder' ? 'Legit' : 'Smart followers', stat: s.kind === 'builder' ? `${n} smart follower${n > 1 ? 's' : ''}` : String(n), confidence: 0.8,
      avatars: facts.smart.slice(0, 3).map((p) => p.avatar),
      card: n >= 2 ? {type: 'smart', title: `Followed by ${n} smart account${n > 1 ? 's' : ''}`, people: facts.smart.slice(0, 3), score: Math.min(0.99, 0.55 + n * 0.08), scoreLabel: n >= 5 ? 'Top 3% of accounts' : 'Strong signal'} : undefined};
  }
  // Fable Rep on its own
  const e = facts.rating;
  if (e && e.score >= 1600 && e.positive >= 3 * Math.max(1, e.negative)) {
    return {...base, tone: 'legit', label: 'Well rated', byRep: true, stat: `Rep ${fableRep(e.score)}`, confidence: 0.8,
      card: {type: 'lines', tone: 'legit', title: 'Fable Rep', right: 'Fable Rep', lines: facts.ratingLines || []}};
  }
  // free smart signal from passive capture: smart accounts retweeting this account
  const boosters = facts.engaged?.boosters || [];
  if (boosters.length && !smartN) {
    return {...base, tone: 'legit', label: 'Smart boosts', stat: String(boosters.length), confidence: 0.72, avatars: boosters.map((p) => p.avatar).filter(Boolean).slice(0, 3),
      detail: `Retweeted by ${boosters.slice(0, 2).map((p) => p.name || p.handle).join(', ')}${boosters.length > 2 ? ` and ${boosters.length - 2} other smart account${boosters.length > 3 ? 's' : ''}` : ''}`};
  }
  if (facts.dev && facts.dev.shipped?.length) {
    return {...base, tone: 'legit', label: 'Legit dev', stat: `${facts.dev.shipped.length} shipped`, confidence: 0.85,
      card: {type: 'dev', title: 'Builder history', shipped: facts.dev.shipped, years: facts.dev.years || ''}};
  }
  // AI slop outranks the green builder reading (a templated campaign post is not a builder update); a shill reading
  // keeps its own amber label
  if (s.kind === 'builder' && s.slop >= 0.8) s = {...s, kind: 'meme'};
  if (s.kind === 'builder') return {...base, tone: 'legit', label: 'Builder update', stat: pct(Math.max(0.6, s.kindConf)), confidence: s.kindConf};
  if (s.kind === 'shill' && !own) return {...base, tone: 'kol', label: 'Shill signal', stat: pct(Math.max(0.55, s.kindConf)), confidence: s.kindConf};
  // AI slop: a note, never a stamp, and never over a trusted account's line. The detail names the tells it found.
  if (s.slop >= 0.8) return {...base, tone: 'kol', label: 'AI slop', stat: pct(s.slop), confidence: s.slop,
    detail: s.slopWhy?.length ? `AI writing tells: ${s.slopWhy.slice(0, 3).join(', ')}` : 'Reads like AI-generated engagement content'};
  if (s.kind === 'engagement' || s.kind === 'flex') return {...base, tone: 'kol', label: 'Engagement farm', stat: pct(Math.max(0.6, s.kindConf)), confidence: s.kindConf};
  if (s.kind === 'news') return {...base, tone: 'neutral', label: 'Commentary', stat: 'no calls', confidence: s.kindConf};
  return {...base, tone: 'neutral', label: 'No flags', stat: 'clean', confidence: 0.5};
}

// ---------------------------------------------------------------------------
// Every verdict carries the full Backstory: one tappable row per real signal, each opening the detail sheet.
// ---------------------------------------------------------------------------
const CAT = {vc: 'VC', founder: 'Founder', builder: 'Builder', researcher: 'Researcher', trader: 'Trader', media: 'Media', kol: 'Creator', other: ''};
const pctDrop = (d) => (d == null ? null : Math.round(Math.abs(d) * 100));
const shortW = (w) => (w && w.length > 12 ? `${w.slice(0, 6)}…${w.slice(-4)}` : w || '');
const monthYear = (ms) => (ms ? new Date(ms).toLocaleString('en-US', {month: 'short', year: 'numeric', timeZone: 'UTC'}) : '');

/** ['$A', '$A', '$B'] -> ['$A ×2', '$B']: one operator often relaunches the same ticker on new contracts. */
export function groupTickers(list) {
  const n = new Map();
  for (const t of list) n.set(t, (n.get(t) || 0) + 1);
  return [...n].map(([t, c]) => (c > 1 ? `${t} ×${c}` : t));
}

export function backstoryRows(facts = {}, v = {}) {
  const rows = [];
  // red flags from the detectors come first when they drove the verdict
  if (v.card?.type === 'lines' && (v.tone !== 'legit' || v.card.title === 'Project dossier' || v.curated)) rows.push({kind: 'flags', tone: v.tone, title: v.card.title || v.label, lines: v.card.lines || []});

  const rugs = facts.projectRugs?.length
    ? {n: facts.projectRugs.length, how: facts.projectRugs.some((x) => x.kind === 'rugged') ? 'Liquidity pulled' : 'Collapsed 97%+ from peak', wallet: facts.projectRugs[0].deployer || facts.projectRugs[0].address,
      items: facts.projectRugs.map((x) => ({tk: `$${x.symbol}`, chain: x.chain, drop: pctDrop(x.drawdown), url: x.token?.pairUrl}))}
    : facts.deployer && facts.deployer.rugged
      ? {n: facts.deployer.rugged, how: 'Same deployer wallet', wallet: facts.deployer.wallet,
        items: (facts.deployer.tokens || []).map(([tk, d]) => ({tk, drop: Math.abs(d)}))}
      : null;
  if (rugs) rows.push({kind: 'rugs', ...rugs, walletShort: shortW(rugs.wallet), tokens: groupTickers(rugs.items.map((x) => x.tk)).slice(0, 4)});

  if (facts.calls && facts.calls.total) {
    const c = facts.calls;
    rows.push({kind: 'calls', total: c.total, dead: c.dead, winners: c.winners || 0, list: (c.tokens || []).map(([tk, pct]) => ({tk, pct}))});
  }

  const smart = facts.smart || [];
  if (smart.length) {
    const people = smart.map((p) => ({...p, tag: p.tag || CAT[p.category] || ''}));
    rows.push({kind: 'smart', n: facts.smartCount || people.length, people: people.slice(0, 3), all: people});
  }

  // followed by 3+ scam-group KOLs: context only, never a label on its own
  if (facts.kolPush?.n >= 2 && v.label !== 'Scam KOL push') rows.push({kind: 'flags', tone: 'kol', title: 'Pushed by a known scam KOL group', lines: facts.kolPushLines || []});
  if (facts.kolFollowed && !(facts.kolPush?.n >= 2) && !facts.trusted) rows.push({kind: 'flags', tone: 'kol', title: 'Followed by a flagged KOL group', lines: [followedLine(facts.kolFollowed)]});
  if (facts.kolWatch && facts.kolWatch.tier === 'C' && facts.kolLines?.length) rows.push({kind: 'flags', tone: 'kol', title: 'Linked to a flagged KOL group', lines: facts.kolLines});
  const eg = facts.engaged;
  if (eg && eg.total) rows.push({kind: 'engaged', boosters: eg.boosters.map((p) => ({...p, tag: CAT[p.category] || ''})), discussed: eg.discussed.map((p) => ({...p, tag: CAT[p.category] || ''}))});

  const e = facts.rating;
  if (e && (e.vouches || e.positive || e.negative)) {
    rows.push({kind: 'rep', rep: fableRep(e.score)}); // our number only
  }

  if (facts.handles?.length > 1) {
    const hist = [...facts.handles].sort((a, b) => (b.last_seen || 0) - (a.last_seen || 0));
    rows.push({kind: 'identity', renames: hist.length - 1, last: hist[1]?.handle || '', hist: hist.slice(1).map((h) => ({handle: h.handle, until: monthYear(h.last_seen)}))});
  }
  if (facts.accountAgeDays != null && facts.accountAgeDays < 120) rows.push({kind: 'fresh', days: facts.accountAgeDays});
  for (const c of facts.curated || []) {
    if (c.id === v.curated || c.on !== 'author' || !CURATED_TONE[c.kind]) continue;
    rows.push({kind: 'flags', tone: CURATED_TONE[c.kind], title: c.label, lines: curatedLines(c)});
  }
  return rows;
}

// Fable's own account: our own line and card, never judged as a project
export const FABLE_SELF = new Set(['fabledotmarket']);
const selfVerdict = (t) => ({id: t.id, source: 'fable', tone: 'self', label: 'Fable', badge: 'OFFICIAL', stat: 'official', confidence: 1, self: true});

function finalize(t, s, rawFacts, source) {
  if (FABLE_SELF.has(String(t.author?.handle || '').toLowerCase())) return selfVerdict(t);
  // a scam-KOL push on an official account, a protected ticker or an established coin is a fact about the posters only
  const facts = guardFacts(t, rawFacts || {});
  const v = decide(t, s, facts, source);
  if (v.hidden) return v;
  if (facts.rating && facts.rating.score >= 1600 && v.tone !== 'rug' && v.tone !== 'kol') v.rep = fableRep(facts.rating.score);
  const rows = backstoryRows(facts, v);
  if (rows.length) v.card = {type: 'profile', rows};
  // the one-line summary under the post
  const sm = rows.find((r) => r.kind === 'smart');
  const rep = rows.find((r) => r.kind === 'rep');
  if (!v.detail && v.tone === 'legit') {
    if (sm && (v.label === 'Smart followers' || v.label === 'Legit' || (v.label === 'Trusted' && !v.byRep) || !rep)) {
      const names = sm.all.slice(0, 2).map((p) => p.name || p.handle).join(', ');
      const rest = sm.n - Math.min(2, sm.all.length);
      v.detail = `Followed by ${names}${rest > 0 ? ` and ${rest} other smart account${rest > 1 ? 's' : ''}` : ''}`;
    }
  }
  if (!v.detail && v.card?.type === 'profile' && rows[0]?.kind === 'flags') v.detail = rows[0].lines[0] || '';
  const rg = rows.find((r) => r.kind === 'rugs');
  if (!v.detail && rg && v.tone === 'rug') v.detail = `${rg.items.slice(0, 2).map((x) => `${x.tk}${x.drop != null ? ` -${x.drop}%` : ''}`).join(', ')} · ${rg.how}`;
  if (!v.card?.rows) {
    // keep pill faces for the smart-followers line even without a card
    const smart = facts.smart || [];
    if (smart.length && !v.avatars) v.avatars = smart.slice(0, 3).map((p) => p.avatar).filter(Boolean);
  }
  return v;
}
