// Runs in x.com's own page context (MAIN world) at document_start.
// Passively copies the GraphQL responses X's web app already fetches. Never makes its own requests,
// never alters requests or responses, and never touches private endpoints (DMs, bookmarks,
// notifications, account settings). Parsing happens in the isolated world (content.js, capture.js).
(() => {
  if (window.__fableHooked) return;
  window.__fableHooked = true;

  const WATCH = /\/i\/api\/graphql\/[^/]+\/(HomeTimeline|HomeLatestTimeline|TweetDetail|UserTweets|UserOriginalsTimeline|UserTweetsAndReplies|SearchTimeline|ListLatestTweetsTimeline|CommunityTweetsTimeline|UserByScreenName|UserByRestId|Followers|Following|BlueVerifiedFollowers|FollowersYouKnow)(?:\?|$)/;

  // The signed-in viewer's numeric id, so the capture layer can strip everything about them.
  // Read from the page's own state or the twid cookie; never sent anywhere by itself.
  const viewer = () => {
    try {
      const s = window.__INITIAL_STATE__?.session?.user_id;
      if (s && /^\d+$/.test(String(s))) return String(s);
    } catch (_) {}
    const m = document.cookie.match(/(?:^|;\s*)twid=(?:u%3D|u=|"u=)(\d+)/);
    return m ? m[1] : null;
  };

  const urlOf = (x) => {
    if (typeof x === 'string') return x;
    if (x instanceof URL) return x.href;
    return x?.url || '';
  };

  const emit = (op, data, url) => {
    try {
      if (!data || typeof data !== 'object' || data.errors && !data.data) return;
      window.postMessage({__fable: true, op, data, url, viewer: viewer()}, location.origin);
    } catch (_) {}
  };

  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await origFetch.apply(this, args);
    try {
      const url = urlOf(args[0]);
      const m = url && url.match(WATCH);
      if (m && res.ok) res.clone().json().then((j) => emit(m[1], j, url)).catch(() => {});
    } catch (_) {}
    return res;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    const u = urlOf(url);
    const m = u && u.match(WATCH);
    if (m) {
      this.addEventListener('load', () => {
        try {
          if (this.status < 200 || this.status >= 300) return;
          const j = this.responseType === 'json' ? this.response : JSON.parse(this.responseText);
          emit(m[1], j, u);
        } catch (_) {}
      });
    }
    return origOpen.call(this, method, url, ...rest);
  };
})();
