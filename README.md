# fable

The backstory behind every account on your X timeline. Rugs, real devs, paid shills, right under the post.

This repository is the full source of the fable browser extension, so anyone can read exactly what it does before installing it. fable is not on the Chrome Web Store yet, so for now you install it yourself from the download on [fable.market](https://fable.market).

Site: [fable.market](https://fable.market) · X: [@FableDotMarket](https://x.com/FableDotMarket)

## Install (about a minute)

Works in Chrome, Brave, Edge, Arc and any other Chromium browser.

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

## What it can access

From [`manifest.json`](manifest.json):

- **Sites:** only `x.com` and `twitter.com`, plus fable's own servers (`api.fable.market`, `intel.fable.market`).
- **Permissions:** `storage` (your settings). Nothing else. No access to other sites, your tabs, history, cookies or downloads.
- **No keys or wallets.** It never asks for, reads or stores a seed phrase, private key or wallet connection.

## What it sends, and what it never sends

- **To look a post up:** the post's text, $tickers, links and its author's public handle go to `api.fable.market`, which answers with the label and card you see.
- **Coin and chart data:** contract addresses from posts go to `intel.fable.market` for prices, candles and the launch history.
- **The public database (optional):** with "Contribute to the public database" on, public posts and public accounts you scroll past are shared so fable's records stay current. It is on by default and can be switched off in the popup's Settings.
- **Never sent:** your own account, your DMs, bookmarks, notifications or anything private. [`src/inject.js`](src/inject.js) reads X's timeline responses only, never changes a request, and strips everything about the signed-in user before anything leaves the page.

## How it is laid out

| File | What it does |
| --- | --- |
| `manifest.json` | Permissions and which scripts run where |
| `src/inject.js` | Reads the posts X already loaded for your timeline (read only) |
| `src/content.js` | Draws the pills, cards, stamps, underlines and the Smart money sidebar |
| `src/chart.js` | The live candle chart |
| `src/capture.js` | Finds contract addresses and tickers in post text |
| `src/background.js` | Talks to fable's servers, caches answers, applies your settings |
| `src/verdict.js`, `src/scam.js`, `src/fake.js`, `src/officials.js`, `src/smart.js` | The local rules that give an instant first label before the server answers |
| `src/config.js` | Default switches, timings and wording |
| `src/ui.css` | Styles |
| `popup.html`, `popup.js` | The toolbar popup: Home, Scan, Settings |

fable's servers are not part of this repository.

## License

[PolyForm Strict 1.0.0](LICENSE). The source is public so you can read it, check it and run it for yourself. It is not free to reuse: you may not copy it into another product, change it and redistribute it, or publish your own build of it. The only official build is the one on [fable.market](https://fable.market) and in this repo's Releases.
