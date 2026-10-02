// Fable remote config: the bundled default. The background worker reads https://intel.fable.market/v1/config every 15
// minutes and keeps the merge in chrome.storage.local ('fableConfig'); every part of the extension reads the merge.
// Data only (Manifest V3 forbids remote code): switches, timings, limits, card layout, words, rule lists, theme CSS.
// Change it live with fable-intel/tools/extconfig.mjs (set / rollback / reset). New logic still needs a store update.
(() => {
  const DEFAULT = {
    v: 1,
    rev: 'bundled',
    // kill switches: turn any part off for every user at once
    // liveHub: live trades from Fable's hub (live.fable.market) for Robinhood and Solana coins (false: intel's own rooms, the 0.27.0 path);
    // liveStream: one hub socket for the whole browser (false: one per coin)
    on: {pills: true, cards: true, stamps: true, tokenMarks: true, sidebar: true, liveCharts: true, prefetch: true, quickVerdict: true, liveHub: true, liveStream: true,
      cardKinds: {contract: true, promo: true, builder: true, smart: true, activity: true}},
    // liveHubDelayMs: how long the hub's feed may stay delayed before its coins move to intel's rooms
    timing: {scanDebounceMs: 60, scanMaxWaitMs: 90, historyWaitMs: 300, candlesCacheMs: 8000, liveIdleMs: 60000, liveHubDelayMs: 20000},
    limits: {contractsPerPost: 3, stats: 4, facts: 3},
    // card layout: section order and hidden sections (ids: headline chart stats facts shill also dev track foot)
    cards: {contract: {order: ['headline', 'chart', 'stats', 'facts', 'shill', 'also', 'dev', 'track', 'foot'], hide: []}},
    copy: {
      tags: {bundle: 'BUNDLED', op: 'RUG OPERATION', honeypot: 'HONEYPOT', mint: 'MINT ON', devrug: 'RUG HISTORY', network: 'KOL NETWORK', wave: 'SHILL WAVE', posterbundle: 'INSIDER', crew: 'SERIAL BUNDLERS', risk: 'RISK'},
      stamps: {bundled: 'BUNDLED', rugOperation: 'RUG', honeypot: 'HONEYPOT', rugHistory: 'RUG', mint: 'MINT ON', posterbundle: 'INSIDER', highRisk: 'HIGH RISK'},
      sections: {launched: 'Who launched it', posted: 'Who posted it'},
      labels: {}, // verdict label -> label shown on the pill, e.g. {"Commentary": "Take"}
      hideLabels: [], // verdict labels never shown as a pill
    },
    rules: {
      majors: ['BTC', 'ETH', 'SOL', 'USDT', 'USDC', 'BNB', 'XRP', 'DOGE', 'ADA', 'TRX', 'DAI', 'WETH', 'WBTC', 'SPX', 'SPY', 'QQQ', 'NVDA', 'TSLA', 'AAPL', 'HOOD', 'COIN', 'MSTR'],
    },
    theme: {css: ''}, // extra CSS for every Fable card (colour tokens, spacing), appended to the shared stylesheet
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
