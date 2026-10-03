// Wording the extension puts on the live API's author-level verdicts (ES module, background worker). Not a copy of server code: verdict.js, scam.js and
// officials.js stay byte-identical with the server's; this file only reads what the API sent. 0.28.0.
//
// 1. "Scam KOL network" is red and stamped SHILL for an ACCOUNT. What makes it red: not the post and not $PONS, but the author. The API found the author named as a promoter in one of Fable's published investigations
//    (api worker opRoles -> verdict.js "Promoter group"), and its card adds "Named in 3 public scam lists". Neither is a proven fact about the person's wallets:
//    a published investigation names accounts that posted the operation's coins, and a public list is an allegation. Owner rules: allegations from public lists
//    read "allegation" and are never a proven red; never call a person a scammer unless the chain proves their own wallet did it. So the pill is amber, reads
//    "KOL network" with its basis ("named in a Fable investigation", or "N public scam lists, allegation"), and loses the SHILL stamp. Red stays for on-chain
//    proof: a bundled launch, a rug operation, wallets tied to rugs, tokens from a tracked operation the account promoted.
// 2. "Promoted tracked rugs, 2 rugs" and the profile's promotion record ("63 launches promoted, 8 rugged") count different things: the first the tokens of
//    Fable's tracked bundle-rug operations the account promoted (CRUMBS, LEGS), the second every promoted launch whose outcome is rugged. The pill says what it counts.

const ALLEGED = /public scam lists?\b|known scam KOL group/i;
const allege = (line) => (typeof line === 'string' && ALLEGED.test(line) && !/allegation/i.test(line) ? `${line.replace(/\.$/, '')} (allegation)` : line);
const softRows = (card) => (card && Array.isArray(card.rows) ? {...card, rows: card.rows.map((r) => (r && r.kind === 'flags' && Array.isArray(r.lines) ? {...r, lines: r.lines.map(allege)} : r))} : card);
const flagLines = (card) => (card?.rows || []).flatMap((r) => (r?.kind === 'flags' && Array.isArray(r.lines) ? r.lines : []));

/** Pure: the verdict as the pill should read it. Returns the same object when nothing applies; applying it twice changes nothing more. */
export function softenVerdict(v) {
  if (!v || typeof v !== 'object') return v;
  if (v.label === 'Scam KOL network' || v.label === 'Reported shill account') {
    const lists = flagLines(v.card).map((l) => String(l).match(/^Named in (\d+) public scam lists?\b/)).find(Boolean);
    const reports = String(v.stat || '').match(/^(\d+) reports?$/);
    // the pill shows the stat when it is 24 characters or fewer (content.js detail()): short, and "allegation" is in it
    const stat = v.stat === 'Promoter group' ? 'in a Fable investigation'
      : lists ? `${lists[1]} list${lists[1] === '1' ? '' : 's'}, allegation`
      : reports ? `${v.stat}, allegation` : v.stat;
    const net = v.label === 'Scam KOL network';
    return {...v, ...(net ? {tone: 'kol', label: 'KOL network', stamp: undefined, fade: false} : {}), stat, card: softRows(v.card), ...(v.detail ? {detail: allege(v.detail)} : {})};
  }
  if (v.label === 'Promoted tracked rugs') {
    const m = String(v.stat || '').match(/^(\d+) rugs?$/);
    if (m) return {...v, stat: `${m[1]} in tracked operations`};
  }
  return v;
}
