// Fable remote config: the bundled default. The background worker reads https://intel.fable.market/v1/config every 15
// minutes and keeps the merge in chrome.storage.local ('fableConfig'); every part of the extension reads the merge.
// Data only (Manifest V3 forbids remote code): switches, timings, limits, card layout, words, rule lists, theme CSS.
// Changed live on the server side (set / rollback / reset). New logic still needs a store update.
(() => {
  const DEFAULT = {
    v: 1,
    rev: 'bundled',
    // kill switches: turn any part off for every user at once
    // liveHub: live trades from Fable's hub (live.fable.market) for Robinhood and Solana coins (false: intel's own rooms, the 0.27.0 path);
    // liveStream: one hub socket for the whole browser (false: one per coin)
    // 0.28 launch investigation, each its own switch (a false drops that section from every card at once): invOp (the operation and
    // its launch grid), invBundle (how they took it), invMoney (where it went), invSnipers, invWash, invPromoters (who pushed it),
    // invProfile (an account's promotion record on its profile); verdictPush: open cards update in place when the hub says a coin's verdict changed
    // 0.29.2 cardCompact: the second and later posts about the same coin on one page view draw a compact card (header, headline, numbers) with a Full card button (false: every post a full card)
    // 0.29.2 stanceGate: a promotion label on a post that names a coin is drawn only once intel's /v1/stance says the post promotes (false: the 0.29.1 rules, call-out words and history only)
    // 0.30.0 invRug: the proven rug facts grouped under "How it was rugged" / "Proven on chain" (false: the 0.29 rows); invActor: the operation and the serial-actor facts under
    // "Who is behind it" (false: "The operation" alone); invXside: bad play on X about the coin (shill campaign, copied ticker, phishing posts) in "Who pushed it";
    // invBadplayProfile: an account's proven bad-play facts (history.badplay) in its profile panel
    on: {pills: true, cards: true, stamps: true, tokenMarks: true, sidebar: true, liveCharts: true, prefetch: true, quickVerdict: true, liveHub: true, liveStream: true,
      invOp: true, invBundle: true, invMoney: true, invSnipers: true, invWash: true, invPromoters: true, invProfile: true, verdictPush: true, stanceGate: true, cardCompact: true, invRug: true, invActor: true, invXside: true, invBadplayProfile: true,
      cardKinds: {contract: true, promo: true, builder: true, smart: true, activity: true}},
    // liveHubDelayMs: how long the hub's feed may stay delayed before its coins move to intel's rooms
    timing: {scanDebounceMs: 60, scanMaxWaitMs: 90, historyWaitMs: 300, candlesCacheMs: 8000, liveIdleMs: 60000, liveHubDelayMs: 20000, stanceBatchMs: 120, stanceRetryMs: [1500, 4000, 9000]},
    limits: {contractsPerPost: 3, stats: 4, facts: 3, rugRows: 4, badplayRows: 4},
    // card layout: section order and hidden sections (ids: headline chart stats facts rug inv shill also dev op pushed track foot;
    // rug = how it was rugged (0.30.0), inv = the how-they-took-it / where-it-went / snipers / wash rows, op = who is behind it (the operation grid), pushed = who pushed it)
    cards: {contract: {order: ['headline', 'chart', 'stats', 'facts', 'rug', 'inv', 'shill', 'also', 'dev', 'op', 'pushed', 'track', 'foot'], hide: []}},
    // 0.30.0: fact key prefix -> card group ('rug' | 'actor' | 'push') for investigation facts this build does not know yet (e.g. {"inv.copycat.": "actor"}); built-in prefixes in content.js INV_GROUPS
    invGroups: {},
    // 0.29: these words stay English here (and in the remote config); the card translates them where it draws them, through FableI18n.tr(),
    // from the srv.cfg.tag.* / srv.cfg.stamp.* / srv.cfg.section.* entries of the English table. A new or reworded word needs its entry there.
    copy: {
      tags: {bundle: 'BUNDLED', op: 'RUG OPERATION', honeypot: 'HONEYPOT', mint: 'MINT ON', devrug: 'RUG HISTORY', network: 'KOL NETWORK', wave: 'SHILL WAVE', posterbundle: 'INSIDER', crew: 'SERIAL BUNDLERS', risk: 'RISK'},
      stamps: {bundled: 'BUNDLED', rugOperation: 'RUG', honeypot: 'HONEYPOT', rugHistory: 'RUG', mint: 'MINT ON', posterbundle: 'INSIDER', highRisk: 'HIGH RISK'},
      sections: {launched: 'Who launched it', posted: 'Who posted it', operation: 'The operation', pushed: 'Who pushed it', invBundle: 'How they took it', invMoney: 'Where it went', invSnipers: 'Snipers', invWash: 'Wash trading', record: 'Promotion record',
        rugged: 'How it was rugged', proven: 'Proven on chain', actor: 'Who is behind it', badplay: 'Proven flags'},
      labels: {}, // verdict label -> label shown on the pill, e.g. {"Commentary": "Take"}
      hideLabels: [], // verdict labels never shown as a pill
    },
    rules: {
      // tickers that mean an established coin or stock when a post names no contract ($ZEC = Zcash, not a Solana copy): never matched to a coin card.
      // The big caps are officials.js PROTECTED_TICKERS; add more from the remote config (rules.majors).
      majors: [
        'BTC', 'ETH', 'SOL', 'USDT', 'USDC', 'BNB', 'XRP', 'DOGE', 'ADA', 'TRX', 'DAI', 'WETH', 'WBTC', 'SPX', 'SPY', 'QQQ', 'NVDA', 'TSLA', 'AAPL', 'HOOD', 'COIN',
        'MSTR', 'ZEC', 'HYPE', 'LINK', 'XMR', 'LEO', 'XLM', 'NEAR', 'BCH', 'UNI', 'LTC', 'SUI', 'USDE', 'AVAX', 'HBAR', 'QNT', 'TAO', 'SHIB', 'CRO', 'XAUT', 'ONDO',
        'ENA', 'PYUSD', 'OKB', 'AAVE', 'MNT', 'DOT', 'WLD', 'ASTER', 'MORPHO', 'WLFI', 'PAXG', 'PEPE', 'ICP', 'ARB', 'ETC', 'BGB', 'KAS', 'POL', 'JUP', 'ALGO', 'RENDER',
        'CAKE', 'ATOM', 'FIL', 'NEXO', 'DASH', 'AERO', 'VET', 'INJ', 'APT', 'XDC', 'PYTH', 'PENGU', 'ZRO', 'RAY', 'CRV', 'PENDLE', 'LDO', 'JTO', 'EIGEN', 'COMP',
        'TON', 'STETH',
      ],
      // Fable's own token contract(s), e.g. $FABLE once it launches: never a bundle line, stamp, risk underline or a red /
      // amber pill from automated reads. Lowercase 0x addresses or Solana mints. Can also be set from the remote config.
      // empty by default: a bundle or rug the chain proves is shown on every coin, $FABLE included. To calm $FABLE's own card, set this from
      // the remote config (rules.ownTokens: ["0x14a64d6f3db9900be9c554d0961f539a16f43f9c"]); no store update needed.
      ownTokens: ['0x14a64d6f3db9900be9c554d0961f539a16f43f9c'], // $FABLE, Fable's official token (owner decision 2026-10-03); the remote config can change it
      ownSymbol: 'FABLE',
    },
    theme: {css: ''}, // extra CSS for every Fable card (colour tokens, spacing), appended to the shared stylesheet
    // 0.29 wording fixes without a store update: {"ja": {"inv.section.launched": "new words"}} (language code, table key, text). Data only: only
    // <b> <i> <em> <s> <br> survive in a string. English: {"en": {...}} changes the English wording of a key the card draws from the table.
    i18n: {},
  };
  // deep merge, key by key: plain objects merge, everything else (arrays, strings, numbers) is replaced
  const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
  const merge = (a, b) => {
    if (!isObj(b)) return a;
    const out = {...a};
    for (const [k, v] of Object.entries(b)) out[k] = isObj(v) && isObj(a?.[k]) ? merge(a[k], v) : v;
    return out;
  };
  globalThis.FableConfig = {DEFAULT, merge: (remote) => (remote?.v === 1 ? merge(DEFAULT, remote) : DEFAULT)};
})();
