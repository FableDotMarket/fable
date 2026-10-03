// Fable call-outs and author records (0.29.1). A classic script like config.js: the content script loads it, the background worker imports it for its
// side effect; both read globalThis.FableCallout. Data and rules only, no network. Not part of verdict.js / scam.js / officials.js (those stay
// byte-identical with intel's copies; this file only reads what a verdict says and what a post says).
//
// 1. Call-outs. A post that warns about a coin or calls a scam out ("$X is a rug, stay away", "跑路 骗局 别买", "먹튀", "lừa đảo", "หลอกลวง",
//    "penipuan") is never a shill, a promotion or a call. isCallout(text) is a multilingual reading of the post's own words (English, zh-CN,
//    zh-TW, ja, ko, vi, th, id). It only ever REMOVES a promotion label (guard), it never adds one and never makes anything red. It is meant to
//    be precise rather than complete: a call-out it misses keeps the label it had; the server's judged stance (history notCalls, the post
//    reader's stance) covers what words cannot.
//      strong  one phrase is enough: "is a scam", "rugged", "stay away", "don't buy", "exit liquidity", 跑路, 骗局, 别买, 먹튀, 詐欺, lừa đảo, หลอกลวง, penipuan ...
//      loose   a generic word ("scam", "rug", "fake", "careful", "avoid") counts only beside a second warning word and when nothing in the post pushes the coin
//      weak    a word that also appears in shills (割韭菜, 砸盘, ラグ, 危険, ⚠️): helps a loose word, or three of them together, and never beside a push
//    Reassurance ("not a scam", "no rug", 不是骗局, 不会跑路), reported speech ("they call it a scam"), FUD rebuttals ("ignore the fud") and product
//    copy ("rug reports", "scam detector") are removed from the reading first.
// 2. Which verdict labels assert a promotion (PROMO_LABELS) and which describe the author, not the post (AUTHOR_LABELS: drawn once per page view).
// 3. (0.29.2) The judged stance. A verdict that carries a promotion label (gated(v)) on a post that names a coin is shown as a promotion only once intel's /v1/stance
//    (the investigation's judgment of the post for posts it knows, Jev's for new ones) says "promotes". settle() is the whole decision, pure: a judged "warns" is a
//    Call-out, any other judged answer takes the label off, and no answer (still to come, 'none', an error, a timeout, a spent budget, intel down) draws the coin facts and a wordless
//    chip, never the label: a false accusation is worse than a miss. on.stanceGate false (a remote switch) is the 0.29.1 rules. An ad (an invite link, a paid-partnership label) is proven
//    by the post itself and is never gated; neither is a post that names no coin (intel judges coin posts only).
(() => {
  const G = globalThis;
  if (G.FableCallout) return;

  /* ---------------- reading the post ---------------- */
  const norm = (raw) => String(raw || '')
    .normalize('NFKC') // full-width ＄ ＠ and letters, half-width kana
    .replace(/[​‌⁠﻿]/g, '')
    .replace(/[’‘`´]/g, "'")
    .replace(/[“”«»]/g, '"')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\b0x[0-9a-f]{40}\b/gi, ' ')
    .replace(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g, ' ')
    .toLowerCase();
  // Latin-script terms need ASCII edges ("冲rug了" still matches rug, "rugby" does not); CJK / Thai / Hangul terms match as substrings
  const L = (src) => new RegExp(`(?<![a-z0-9_])(?:${src})(?![a-z0-9_])`, 'i');
  const S = (src) => new RegExp(src, 'i');

  // ---- reassurance, reported speech, rebuttals and product copy: taken out of the text before anything is counted ----
  const SCRUB = [
    // English: "not a scam", "no rug", "zero red flags", "can't rug", "rug-proof", product copy ("rug reports", "scam detector"), a bot's "Rug: 0%"
    L(String.raw`(?:not|no|never|isn't|aren't|wasn't|won't|can't|cannot|zero|0|without|anti|non|safe from|not another|not an?|green|few|less|nothing)[\s-]+(?:(?:an?|any|another|major|big|real|single)\s+){0,2}(?:\w+\s+)?(?:rugs?|rugged|rugpulls?|rug ?pull(?:ed|ing)?|scams?|scammers?|honeypots?|bundles?|bundled|bundlers?|snipers?|sniping|fraud|ponzi|red flags?|fake(?:\s+\w+)?|blacklist\w*|insiders?)`),
    L(String.raw`rug[\s-]?proof|anti[\s-]?(?:rug|scam)|safu|(?:can't|cannot|won't|will not|wouldn't|never) (?:be )?(?:rug(?:ged)?|rug ?pull(?:ed)?)|(?:rug|scam|honeypot|bundle|bundler|sniper|snipers|sniping)[\s-]?(?:report|reports|check|checks|checker|checkers|detect\w*|scan\w*|alerts?|filters?|protection|protected|shield|radar|score|scores|trackers?|monitor\w*|database|list|lists|resistant|free|risk|proof|blocker|guard|resistance)|(?:rug|scam|honeypot|bundle)s?:\s*\d+(?:\.\d+)?%`),
    // reported speech and questions: "they call it a scam", "people say it's a rug", "accused of rugging", "is it a scam?"
    L(String.raw`(?:call(?:ed|ing|s)?|say(?:s|ing)?|said|think(?:s|ing)?|thought|accus\w+|claim\w*|label\w*|dismiss\w*|brand\w*|ask(?:ed|ing)?|wonder\w*|if|whether)\b[^.!?\n]{0,32}\b(?:scam\w*|rug\w*|fraud\w*|ponzi|honeypot)`),
    L(String.raw`"[^"\n]{0,40}\b(?:scam|rug|rugged|fraud)\b[^"\n]{0,20}"`),
    L(String.raw`[^.!?\n]{0,60}\b(?:scams?|rugs?|rugged|rug ?pull|honeypot|fraud|ponzi)\b[^.!?\n]{0,40}\?`), // a question ("is it a honeypot?") asks, it does not call out
    // zh
    S('(?:不是|不会|不会是|不可能|不要担心|别担心|不用担心|放心|没有|并非|不存在|绝不|绝不会|从不|防止|防|反|拒绝|杜绝|无|非|零|不再|没)[^，。！？!?\\n]{0,3}(?:跑路|骗局|騙局|貔貅|rug|割韭菜|归零|歸零|诈骗|詐騙|骗子|騙子|空气币|空氣幣|出货|出貨|砸盘|砸盤)'),
    S('(?:希望|但愿|祈祷|别|不要|莫|勿|求)[\\s]{0,2}(?:跑路|rug|割韭菜)'),
    S('(?:指控|声称|聲稱|被指|被称|被稱|被认为|被認為|有人说|有人說|有人认为|據稱|据称|传言|傳言|质疑|質疑|疑似|嫌疑|争议|爭議)[^，。！？!?\\n]{0,14}(?:骗局|騙局|跑路|rug|诈骗|詐騙)'),
    S('(?:跑路|骗局|騙局|貔貅|割韭菜|诈骗|詐騙)(?:检测|檢測|扫描|掃描|报告|報告|预警|預警|风险|風險|识别|識別|工具|查询|查詢)'),
    // ja
    S('(?:詐欺|スキャム|ラグプル|ラグ|ハニーポット)(?:ではない|じゃない|ではありません|じゃありません|ありません|ではなく|対策|チェック|検知|検出|防止|リスク)'),
    S('(?:詐欺|スキャム|ラグプル)(?:の心配は?(?:ない|ありません|なし)|なし)'),
    // ko
    S('(?:아니|안|없|무|절대|걱정\\s*마)[^.!?\\n]{0,4}(?:먹튀|사기|러그)'),
    S('(?:먹튀|사기|러그|러그풀|스캠)\\s*(?:걱정\\s*)?(?:없|아님|아니|아닙니다|걱정\\s*마)'),
    // vi / id / th
    L(String.raw`(?:không|chẳng|khong|ko|không phải|chưa|tidak|bukan|tanpa|anti|no)[\s-]+(?:là\s+|phải\s+|ada\s+)?(?:lừa đảo|lua dao|scam|rug|rug ?pull|penipuan|penipu|tipu|honeypot)`),
    S('(?:ไม่|ไม่ใช่|ไม่มี|ปลอดภัยจาก)[^\\s]{0,2}\\s*(?:หลอกลวง|โกง|ดึงพรม|สแกม|rug|scam)'),
  ];

  /* ---------------- the lexicons ---------------- */
  // the two plainest call-outs: they also outrank a post that talks about "fud"
  const STAY_AWAY = L(String.raw`stay (?:far )?away|stay clear|steer clear|keep away`);
  const DONT_BUY = L(String.raw`(?:don't|dont|do not|never|stop|shouldn't|should not|wouldn't|would not|please don't|pls don't)\s+(?:(?:this|it|that|these|any|the|a|an|those|him|her|them|for)\s+)?(?:buy|buying|ape|aping|touch|invest|investing|fall for|click|connect|sign)`);
  // strong: one is enough, even beside the word "buy" ("don't buy" has it)
  const STRONG = [
    // English
    L(String.raw`(?:is|was|it's|this is|that's|looks like|smells like|another|an? obvious|an? total|bundled|exit)\s+(?:an?\s+|the\s+)?(?:\w+\s+){0,2}(?:scam|rug|rugpull|rug ?pull|honeypot|fraud|exit scam)`),
    L(String.raw`rugged|rug ?pulled|got rugged|will rug|gonna rug|going to rug|about to rug|already rugged|rugging (?:you|us|everyone|holders|the)|rugs? (?:you|us|everyone|holders)|rug ?pull alert|rug alert|scam alert|exit scams?|honeypots?|serial (?:rugger|scammer)s?|scammers?|bundled scams?|scam (?:coin|token|project|dev|team|launch)s?`),
    STAY_AWAY,
    DONT_BUY,
    L(String.raw`dump(?:ing|ed)? (?:on|onto) (?:you|us|retail|holders|buyers|bag ?holders)|dev (?:sold|dumped|dumping)|devs? (?:rugged|scammed)|insiders? (?:sold|dumped|dumping)|team (?:sold|dumped|rugged)|drained|siphoned`),
    L(String.raw`avoid (?:this|it|him|her|them|these|that|the|\$\w+|robinhood:\w+)|call: avoid`),
    L(String.raw`fake\s+(?:\w+\s+){0,2}(?:tokens?|coins?|ca|contract|team|dev|github|volume|liquidity|accounts?|projects?|audit|ai|launch|airdrops?|website|site|twitter)|fake\s+(?:robinhood|solana|ethereum|base|bsc|eth):|fraudulent|phishing|impersonat\w+|counterfeit`),
    // PSAs and warnings in the first person: "first scam", "another scam", "I warned you", "wouldn't recommend", "should know before buying"
    L(String.raw`(?:another|first|new|this|that|yet another|latest|biggest)\s+(?:\w+\s+)?scams?|(?:wouldn't|would not|don't|do not|not|never|can't|cannot)\s+(?:\w+\s+)?recommend|should know before|scrubbed (?:his|her|their|the)`),
    // zh-CN / zh-TW ("千万别错过" is a shill's phrase: only 千万别 + a warning verb)
    S('跑路|卷款|捲款|骗局|騙局|骗子|騙子|诈骗|詐騙|貔貅|老鼠仓|老鼠倉|别买|別買|不要买|不要買|千万别买|千萬別買|千万别碰|千萬別碰|千万别信|千萬別信|千万别上当|千萬別上當|千万不要买|千萬不要買|莫买|莫買|别碰|別碰|不要碰|远离|遠離|避雷|避坑|防骗|防騙|假币|假幣|假合约|假合約|钓鱼|釣魚|归零了|歸零了|已经归零|已經歸零|rug了|被rug|被收割|小心被|当心被|當心被|谨防|謹防|小心骗|小心騙|小心跑'),
    // ja
    S('詐欺|スキャム|ラグプル|ラグ・プル|抜き逃げ|持ち逃げ|買うな|買わない方|買わないほう|触るな|近づくな|逃げろ|逃げられ|ハニーポット|ポンジ|出口流動性|偽物|偽トークン|偽コイン|偽アカウント|なりすまし|ご注意|注意喚起|気をつけて|気を付けて'),
    // ko
    S('먹튀|러그풀|러그\\s*당|러그당|스캠|사기꾼|사기\\s*코인|사기코인|사기임|사기다|사기야|사기입니다|사기네|사기성|사기\\s*프로젝트|사기\\s*당|사기당|사기\\s*조심|사지\\s*마|사지마|사지\\s*말|사지말|사면\\s*안|매수\\s*금지|매수하지\\s*마|손대지\\s*마|손대지마|피하세요|피해라|피해야|거르세요|허니팟|폰지|출구\\s*유동성|설거지|털렸|가짜\\s*(?:토큰|코인|계정)'),
    // vi
    L(String.raw`lừa đảo|lua dao|lừa gạt|rug ?pull|bị rug|đừng mua|dung mua|tránh xa|tranh xa|cảnh báo|canh bao|xả hàng|cuỗm|bỏ chạy|chạy mất|dev (?:bán|chạy|dump)|giả mạo|hàng giả|honeypot|ponzi`),
    // th
    S('หลอกลวง|โกง|มิจฉาชีพ|สแกม|ดึงพรม|รักพูล|อย่าซื้อ|ห้ามซื้อ|หลีกเลี่ยง|ฮันนี่พอต|เตือนภัย|ระวังโดน|ระวังโกง|ของปลอม|เหรียญปลอม'),
    // id
    L(String.raw`penipuan|penipu|ditipu|menipu|rug ?pull|di-?rug|kena rug|jangan beli|jangan ape|jauhi|jauh-jauh|hindari|waspada|dev (?:jual|kabur|dump)|palsu|honeypot|ponzi`),
  ];
  // loose: a generic warning word; counts only with a second reason (another warning word) and when the post pushes nothing
  const LOOSE = [
    L(String.raw`scams?|scammed|scamming|rugs?|rugpull|fraud|fake|beware|be careful|careful with|watch out|be aware|heads up|psa|warning|avoid|bundled|bundle|blacklist(?:ed)?|wash trad\w+|fake volume|exploit(?:ed)?|hack(?:ed)?|dev sold|sold (?:their|his|her|the) (?:bag|supply|tokens)|scrub(?:bed)?|red flags?|fresh wallets?|snipers?|bundlers?|warn(?:ed|ing)?\s+(?:you|y'all|u|everyone|people|holders|them)|trying to warn|i warned|ponzi|exit liquidity|dev (?:abandoned|ran)|dump(?:ing|ed)? on everyone|(?:don't|dont|do not|never) (?:send|trust)|insider cluster|clone|unofficial|not affiliated|the only real|only official|official ca|real ca|before (?:buying|aping|you buy|investing)|funded by (?:just |only )?\d+ wallets|same (?:funder|deployer|dev)`),
    S('小心|当心|當心|警惕|警示|风险提示|風險提示|注意风险|注意風險|注意安全|提醒|套路|陷阱|假的|不建议|不建議|不要冲|不要衝|别冲|別衝|盗号|盜號|被盗|被盜|仿盘|仿盤|仿币|仿幣|空气币|空氣幣|出货了|出貨了|砸盘了|砸盤了|被割'),
    S('警告|気をつけ|怪しい|やめた方|やめとき'),
    S('주의|경고|위험|조심|가짜|사기|의심'),
    L(String.raw`cẩn thận|can than|cảnh giác|nguy hiểm|nghi ngờ|đáng ngờ`),
    S('ระวัง|เตือน|อันตราย|น่าสงสัย|ไม่แนะนำ|เหยื่อ'),
    L(String.raw`hati-hati|peringatan|berbahaya|mencurigakan|tidak disarankan|kabur`),
  ];
  // weak: also in shills ("别被割韭菜", "砸盘就是机会", "ラグってる" = lag, risk disclaimers); three of them, and nothing pushing
  const WEAK = [S('割韭菜|收割|韭菜|砸盘|砸盤|出货|出貨|洗盘|洗盤|诈尸|詐屍|阴跌|陰跌|血亏|血虧|被套|套牢'), S('ラグ|危険|リスク|損切|暴落|溶けた'), S('설거지|물렸|손절|폭락|청산'),
    L(String.raw`đu đỉnh|xả|lỗ nặng|cắt lỗ`), S('ขาดทุน|ติดดอย'), L(String.raw`rugi|cut ?loss`), L(String.raw`dump(?:ed|ing)?|bleed(?:ing)?|late entry risk`), S('⚠|🚨|🚩|🛑')];
  // push: the post tells readers to buy or hold the coin (the strong shill words only; "buy" alone is in every warning)
  const PUSH = [
    L(String.raw`lfg|(?:is|now|just|officially)\s+live|live on|launch(?:ed|ing)? (?:on|at|today|now)|fair launch|presale|whitelist|ca:|contract:|send it|sending it|to the moon|moon(?:ing|shot)?|100x|1000x|\d{2,4}x (?:potential|gem|easy|soon)|buy now|buying more|bought more|load(?:ed|ing)? (?:up|more|the bags?)|accumulat\w+|ape (?:in|now)|aping in|get in (?:now|early)|still early|not too late|don't miss|dont miss|gem|bullish|undervalued|early entry|easy 10x|nfa|not financial advice|next (?:big|100x)|huge potential|massive potential|ready to (?:run|fly|pump|explode)|about to (?:run|fly|pump|explode|send|moon)|breakout|pumping|wagmi`),
    S('冲|衝|上车|上車|梭哈|起飞|起飛|暴涨|暴漲|翻倍|百倍|千倍|拉盘|拉盤|必涨|必漲|看涨|看漲|看多|做多|抄底|建仓|建倉|加仓|加倉|潜力|潛力|绝佳|絕佳|千万别错过|千萬別錯過|别错过|別錯過|入场|入場|买入|買入|财富密码|財富密碼'),
    S('買い|ロング|爆上げ|仕込|ガチホ|期待|有望|おすすめ|チャンス'),
    S('매수|존버|떡상|가즈아|추천|급등'),
    L(String.raw`mua ngay|lên mặt trăng|tiềm năng|đáng mua`),
    S('ซื้อเลย|ขึ้นดวง|น่าสะสม'),
    L(String.raw`beli (?:sekarang|aja)|potensi|peluang|ayo beli|cuan`),
    S('🚀|💎'),
  ];
  const any = (list, text) => list.some((re) => re.test(text));
  // the distinct warning words in a post (a list holds many words: two different ones are two reasons, the same one twice is one)
  const terms = (list, text) => { const out = new Set(); for (const re of list) for (const m of text.matchAll(new RegExp(re.source, `${re.flags.replace('g', '')}g`))) out.add(m[0].trim().replace(/(?:s|ed|ing|ers?)$/, '')); return out; };
  const GSCRUB = SCRUB.map((re) => new RegExp(re.source, `${re.flags.replace('g', '')}g`));

  /** Pure: the words of a post -> {hit, why}: hit says the post warns about a coin or calls something out (see the header); why is the phrase that decided it. */
  function isCallout(raw) {
    const text0 = norm(raw);
    if (!text0.trim()) return {hit: false, why: ''};
    let text = text0;
    for (const re of GSCRUB) text = text.replace(re, ' ');
    // a post that talks about "fud" defends the coin, whatever words it quotes (unless it says plainly to stay away / not to buy)
    if (/(?<![a-z0-9_])fud/.test(text0) && !STAY_AWAY.test(text) && !DONT_BUY.test(text)) return {hit: false, why: ''};
    const strong = STRONG.find((re) => re.test(text));
    if (strong) return {hit: true, why: String(text.match(strong)?.[0] || '').trim().slice(0, 40)};
    if (any(PUSH, text)) return {hit: false, why: ''};
    const loose = terms(LOOSE, text), weak = terms(WEAK, text);
    // a generic word alone ("careful", "avoid") needs a second reason: another warning word, or a weak one
    if (loose.size >= 2 || (loose.size >= 1 && weak.size >= 1)) return {hit: true, why: [...loose][0].slice(0, 40)};
    if (weak.size >= 3) return {hit: true, why: 'weak'};
    return {hit: false, why: ''};
  }

  /* ---------------- verdict labels ---------------- */
  // labels that say "this post (or its author) is promoting something". A call-out never carries one.
  const PROMO_LABELS = new Set(['Shill signal', 'Promo post', 'Scam KOL push', 'Poor call record', 'Promoted tracked rugs', 'Scam KOL network', 'KOL network', 'Reported shill account',
    'Promotion ring', 'Promoter', 'Caller', 'Bad caller', 'Shill wave']);
  // labels about the author (their record, their network, their followers), the same on every post they write: drawn once per page view
  const AUTHOR_LABELS = new Set(['Scam KOL network', 'KOL network', 'Reported shill account', 'Promoted tracked rugs', 'Poor call record', 'Poorly rated', 'Well rated', 'Trusted', 'Smart followers',
    'Smart boosts', 'Legit dev', 'Legit', 'Rug history', 'Linked to rugs', 'Token collapsed', 'Scam project', 'Promotion ring', 'New project, high risk', 'New project', 'Project', 'Promoter', 'Builder',
    'Official account']);
  const promoLike = (v) => !!v && !v.hidden && (PROMO_LABELS.has(v.label) || v.stamp === 'SHILL' || (v.label === 'Scam' && /bundled/i.test(v.stat || '')));
  // the labels a judged stance decides: a promotion label, or a SHILL stamp. A bundled-coin "Scam" is on-chain proof about the coin, not a reading of the post's stance.
  const gated = (v) => !!v && !v.hidden && !v.self && (PROMO_LABELS.has(v.label) || v.stamp === 'SHILL');
  const authorLevel = (v) => !!v && !v.hidden && !v.self && !v.otherCoin && AUTHOR_LABELS.has(v.label);

  /** Pure: the verdict of a call-out: neutral, says what it warns about. Never red, never stamped, never faded. */
  function calloutVerdict(t, v) {
    const who = [...new Set([...(String(t?.text || '').match(/@[A-Za-z0-9_]{2,15}/g) || []), ...(t?.cashtags || []).map((c) => `$${String(c).replace(/^\$/, '')}`)])].slice(0, 3);
    return {id: v?.id ?? t?.id, source: `${v?.source || 'local'}+callout`, tone: 'neutral', label: 'Call-out', stat: 'warning', confidence: Math.max(0.7, Number(v?.confidence) || 0),
      detail: who.length ? `Warns about ${who.join(', ')}` : 'Warns readers about a scam or bad actor', callout: true};
  }
  /** Pure: the verdict with call-out rules applied. t: the post; v: its verdict; signals: {read: the post reader's read, stance: 'warning' from history}.
   *  A post that warns never carries a promotion label, a SHILL stamp or a bundled-coin "Scam" stamp; other labels are kept and the verdict is only marked. */
  function guard(t, v, signals = {}, opts = {}) {
    if (!v || v.hidden || v.self) return v;
    const hit = isCallout(t?.text).hit || signals.read?.stance === 'warning' || signals.stance === 'warning' || v.label === 'Call-out' || v.callout === true;
    if (!hit) return v;
    // markOnly: the verdict only carries the signal (callout: true); the page decides with the judged stance (settle), which outranks these words
    if (promoLike(v) && !opts.markOnly) return calloutVerdict(t, v);
    return v.callout ? v : {...v, callout: true};
  }
  const JUDGED = new Set(['promotes', 'warns', 'neutral', 'unrelated']);
  // 'none': intel knows the post but could not judge it (no coin, an engine failure, a judged-post budget spent): no information, never a label and never a reason to take one off
  /** Pure: a stance answer of any shape intel sends ("promotes", {stance: "warns", by: "judged"}, "warning", ...) -> 'promotes' | 'warns' | 'neutral' | 'unrelated' | 'none' | 'pending'. */
  function stanceOf(x) {
    const s = String(x && typeof x === 'object' ? x.stance : x || '').toLowerCase();
    if (s === 'warning') return 'warns';
    if (s === 'promote' || s === 'call' || s === 'buy_call') return 'promotes';
    if (s === 'disputed') return 'neutral';
    return JUDGED.has(s) || s === 'none' ? s : 'pending';
  }
  /**
   * Pure: the decision for one post whose verdict may carry a promotion label.
   *   t       the post;   v the verdict (any source);   stance what is known: 'promotes' | 'warns' | 'neutral' | 'unrelated' | 'pending' (asked, no answer yet) | 'unknown' (asked until it
   *           was given up) | 'down' (intel did not answer) | 'none' (no judgment to give) | undefined (not asked yet);   signals {read, stance} as for guard()
   *   opts    {names: the post names a coin, ad: the post is an ad (invite link, paid-partnership label)}
   * -> {kind, v}   keep: draw v as it is;  callout: v is the Call-out;  strip: the label comes off (draw the post's own reading);  pending: the coin facts first, a wordless chip,
   *    the label only if the answer is "promotes";  chip: no answer will come, the same chip;  guard: not gated (an ad, no coin named, not a promotion label): the 0.29.1 rules.
   */
  function settle(t, v, stance, signals = {}, opts = {}) {
    if (!gated(v) || opts.ad || opts.names === false) return {kind: 'guard', v: guard(t, v, signals)};
    if (stance === 'promotes') return {kind: 'keep', v};
    if (stance === 'warns') return {kind: 'callout', v: calloutVerdict(t, v)};
    if (stance === 'neutral' || stance === 'unrelated') return {kind: 'strip', v};
    // no judgment (asked and not answered yet, 'none', an error, a timeout, a spent budget, an unreachable intel): never the promotion label (a false accusation is worse than a miss).
    // A post that reads as a call-out (its own words, the post reader, the history) is a Call-out, which is a warning and not a promotion label; any other is the coin facts and a
    // wordless chip: 'pending' while an answer may still come, 'chip' when none will. A judged "promotes" that comes later puts the label on.
    const g = guard(t, v, signals);
    if (g.label === 'Call-out') return {kind: 'callout', v: g};
    return {kind: stance === undefined || stance === 'pending' ? 'pending' : 'chip', v};
  }
  /** Pure: how the server (history notCalls / promos) judged one post: 'warning' | 'call' | 'research' | 'mention' | 'other', or null (not in the record). */
  function historyStance(h, id) {
    const tid = String(id || '');
    if (!h || !tid) return null;
    const idOf = (u) => String(u || '').match(/\/status\/(\d+)/)?.[1];
    const n = (h.notCalls || []).find((x) => idOf(x.url) === tid);
    if (n) return n.stance || 'mention';
    const p = (h.promos || []).find((x) => idOf(x.url) === tid);
    return p ? p.stance || 'call' : null;
  }

  G.FableCallout = {isCallout, guard, calloutVerdict, promoLike, gated, authorLevel, historyStance, stanceOf, settle, PROMO_LABELS, AUTHOR_LABELS, norm};
})();
