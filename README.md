# fable

The backstory behind every account on your X timeline. Rugs, real devs, paid shills, right under the post.

This repository is the full source of the fable browser extension, so anyone can read exactly what it does before installing it.

**fable is on the Chrome Web Store:** [Add to Chrome](https://chromewebstore.google.com/detail/fable/ccopghdmgdpckelbbceococlbkocjgmo). That is the easiest way to install it, and it updates by itself.

Current version: **0.30.1** · Languages: English, 简体中文, 繁體中文, 日本語, 한국어, Tiếng Việt, ไทย, Bahasa Indonesia · Site: [fable.market](https://fable.market) · X: [@FableDotMarket](https://x.com/FableDotMarket)

## Install

**One click:** [Add to Chrome on the Chrome Web Store](https://chromewebstore.google.com/detail/fable/ccopghdmgdpckelbbceococlbkocjgmo). Works in Chrome, Brave, Edge, Arc and any other Chromium browser that installs from the Chrome Web Store. Updates arrive automatically.

### Or install from this source (about a minute)

1. **Download** `fable-extension.zip` from [fable.market/install](https://fable.market/install) or from this repo's [Releases](../../releases).
2. **Unzip it.** You get a folder called `fable`. Put it somewhere you will keep it, like your Documents folder. If you delete or move it later, the extension stops working.
3. **Open your extensions page.** Paste this into the address bar:
   - Chrome: `chrome://extensions`
   - Brave: `brave://extensions`
   - Edge: `edge://extensions`
4. **Turn on Developer mode** with the switch in the top right corner.
5. **Click "Load unpacked"** and select the `fable` folder (the one that has `manifest.json` inside).
6. **Pin it.** Click the puzzle icon in the toolbar and pin fable.
7. **Open [x.com](https://x.com).** fable starts reading your timeline right away. No account needed.

Chrome may show a "Disable developer mode extensions" notice when it starts. That appears for every extension installed this way. Click the X to close it, and fable keeps running.

### Updating

Download the new zip, unzip it over your old `fable` folder (replace the files), then click the reload arrow on fable's card in your extensions page.

## Check the download matches this code

Every release lists the SHA-256 of its zip. To check yours:

- Windows (PowerShell): `Get-FileHash fable-extension.zip -Algorithm SHA256`
- macOS / Linux: `shasum -a 256 fable-extension.zip`

The zip is this repository's files, unchanged. You can also skip the zip entirely: clone this repo and load the folder with "Load unpacked".

## Is it safe? Check it yourself in five minutes

You do not have to trust us. Each check below points at the exact file and line.

1. **What it is allowed to touch.** Open [`manifest.json`](manifest.json). The only permission is `storage` (your settings). It only runs on `x.com` and `twitter.com`. There is no access to other sites, tabs, history, cookies, downloads, your clipboard or your files, and Chrome enforces that list, not us.
2. **Where it sends anything.** Search the code for `fetch(` and `WebSocket(`. Every network call is in [`src/background.js`](src/background.js) and goes to fable's own servers (`api.fable.market`, `intel.fable.market`, and `live.fable.market` for live chart trades). The one other `fetch` call, in `content.js`, only reads the stylesheet bundled inside the extension. Fonts and artwork are bundled too, so the popup loads nothing from anywhere else.
3. **No hidden code.** Search for `eval(`, `new Function` and `importScripts`: there are none. Chrome extensions on Manifest V3 cannot download and run code after install. The settings fable fetches from its server ([`src/config.js`](src/config.js)) are switches, timings and wording, never code. Wording fixes for the translations keep only plain text and the tags `<b> <i> <em> <s> <br>` ([`src/i18n.js`](src/i18n.js)).
4. **How it reads X.** [`src/inject.js`](src/inject.js) wraps the page's `fetch` and `XMLHttpRequest` so it can copy X's answers for public timelines, posts and profiles (the list is the `WATCH` line). Every request and answer passes through unchanged, and it never makes a request of its own. DMs, bookmarks, notifications and account settings are not on the list.
5. **The one cookie line.** `inject.js` and `capture.js` look at the page's cookie string and keep only `twid`: your public numeric X user id. Nothing else in it is kept or sent. fable uses that id to remove everything about you before anything leaves the page ([`src/capture.js`](src/capture.js), "drop the viewer entirely"). X's login session cookie (`auth_token`) is HttpOnly, so no page or extension script can read it at all.
6. **The download matches this code.** Compare the zip's SHA-256 with the one on the release (see below). The zip is built straight from the tagged commit with `git archive`.

What the code cannot show is what fable's servers do with what they receive. That is covered by the [privacy policy](https://fable.market/privacy).

## What it can access

From [`manifest.json`](manifest.json):

- **Sites:** only `x.com` and `twitter.com`, plus fable's own servers (`api.fable.market`, `intel.fable.market`, and `api.fable.trading`, our old domain, kept so older settings still work). The live chart feed is a WebSocket to `live.fable.market`.
- **Permissions:** `storage` (your settings). Nothing else. No access to other sites, your tabs, history, cookies or downloads.
- **No keys or wallets.** It never asks for, reads or stores a seed phrase, private key or wallet connection.

## What it sends, and what it never sends

- **To look a post up:** the post's text, $tickers, links and its author's public handle go to `api.fable.market`, which answers with the label and card you see.
- **Coin and chart data:** contract addresses from posts go to `intel.fable.market` for prices, candles and the launch history, and the open chart streams live trades from `live.fable.market`.
- **Promotion check:** before a post that names a coin gets a promotion label, its id, its text (up to 1,000 characters) and the coin it names go to `intel.fable.market`, which answers whether the post promotes, warns about or just mentions the coin. Without a clear answer the label is not shown.
- **Settings from fable:** every 15 minutes the extension reads its switches and wording from `intel.fable.market/v1/config`. Nothing is sent with that read.
- **Help improve Fable (optional):** with this setting on, public posts and public accounts you scroll past are shared so checks get faster for everyone. It is on by default, capped at 20,000 items a day, and can be switched off in the popup's Settings.
- **Never sent:** your own account, your DMs, bookmarks, notifications or anything private. [`src/inject.js`](src/inject.js) reads X's timeline responses only, never changes a request, and strips everything about the signed-in user before anything leaves the page.

## What it keeps on your device

Everything below stays in your browser's extension storage and is never uploaded:

- your settings (including your language), today's counts and the list of recently flagged posts
- a local copy of follow lists you have viewed, and the X account you are signed in to (used only to leave you out of everything fable shares)
- copies of fable's answers so scrolling stays fast: verdicts for up to 6 hours ([`src/background.js`](src/background.js), `VKEEP_MS`), the last 80 contract and account lookups, and for up to 30 days whether a post you saw that names a coin was a call or a warning (`STANCE_MS`)

The **Clear** button in the popup's Account tab removes your counts, the flagged list, the follow-list copy and the linked account. Removing the extension deletes everything it stored.

## How it is laid out

| File | What it does |
| --- | --- |
| `manifest.json` | Permissions and which scripts run where |
| `src/inject.js` | Reads the posts X already loaded for your timeline (read only) |
| `src/content.js` | Draws the pills, cards, stamps, underlines and the Smart money sidebar |
| `src/chart.js` | The live candle chart |
| `src/capture.js` | Finds contract addresses and tickers in post text |
| `src/callout.js` | Recognises posts that warn about a coin (in eight languages), so a warning is never labelled as a promotion |
| `src/postguard.js`, `src/soften.js` | Keep official tokens like $PONS from being flagged, keep a label on the coin it is about, and mark list-based claims as allegations |
| `src/i18n.js`, `src/locales/`, `_locales/` | The eight languages |
| `src/background.js` | Talks to fable's servers, caches answers, applies your settings |
| `src/verdict.js`, `src/scam.js`, `src/officials.js`, `src/smart.js` | The local rules that give an instant first label before the server answers |
| `src/config.js` | Default switches, timings and wording |
| `src/ui.css` | Styles |
| `src/smart-names.json` | Display names for the smart accounts |
| `popup.html`, `popup.js` | The toolbar popup: Home, Scan, Settings, Account |
| `art/`, `fonts/` | The popup's artwork and fonts, bundled so nothing loads from outside |

fable's servers are not part of this repository.

## License

[PolyForm Strict 1.0.0](LICENSE). The source is public so you can read it, check it and run it for yourself. It is not free to reuse: you may not copy it into another product, change it and redistribute it, or publish your own build of it. The only official build is the one on [fable.market](https://fable.market) and in this repo's Releases.
