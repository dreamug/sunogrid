# Suno Bridge — Driver

A Manifest V3 Chrome extension that lets the [SunoGrid](https://sunogrid.com) web app generate
loops through **your own logged-in suno.com session**. It drives Suno's real UI to generate, watches
the responses to collect the results, and downloads the finished audio from Suno's CDN.

**Your Suno token never leaves the browser.** The extension only acts inside the suno.com tab you're
already logged into — nothing is sent to any SunoGrid server.

> **For learning & research only.** Driving Suno's private interface may violate its Terms of Service
> and can get your account rate-limited or banned. Your account, your risk.

## How it works

```
SunoGrid app (sunogrid.com / localhost)
  │  window.postMessage {source:'APP_SUNO', cmd, args}
  ▼  bridge.js   — injected into the app site (ISOLATED world)
  │  chrome.runtime
  ▼  background.js — routes app tab ⇄ suno.com tab
  │  tabs.sendMessage
  ▼  relay.js     — injected into suno.com (ISOLATED world)
  │  window.postMessage
  ▼  interceptor.js — injected into suno.com (MAIN world): drives the UI + observes fetch
```

Commands: `status` · `generate({mode, prompt, loop, bpm, key})` · `poll(clipIds)` · `download(url) → base64`.

Generation **drives Suno's own UI** (fills the prompt, sets Type/BPM/Key, clicks Create) rather than
replaying the private API — Suno's anti-bot only trusts genuine UI flows, so a reconstructed request
gets rejected. Clip IDs come from the observed `generate` response; `poll` reads the observed `feed`
cache and actively re-fetches until `complete`; `download` pulls the public `cdn1.suno.ai` mp3.

## Install

1. Open `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and pick this `suno-bridge/` folder.
3. After editing any file, click **Reload** on the extension card.

## Use

1. Open **suno.com**, log in, and leave a tab on the **Create** page (Sounds / Advanced).
2. Open the SunoGrid app (`sunogrid.com`, or `localhost` in dev) and generate from the left panel.

Click the extension icon to check status:
- **suno.com connection** — green when a logged-in suno.com tab is reachable. If it's red right after
  installing/reloading, reload your suno.com tab so the content scripts inject.
- **App sites** — `sunogrid.com` and `localhost` work with no setup. Self-hosting on another domain?
  Open your site, click **Connect**, and approve the permission prompt — no manifest editing needed.

## Files

| File | Role |
|---|---|
| `interceptor.js` | suno.com MAIN world: drives the UI + observes fetch (generate / poll / download) |
| `relay.js` | suno.com ISOLATED world: bridges background ⇄ the MAIN-world driver |
| `bridge.js` | app site ISOLATED world: bridges the app ⇄ background |
| `background.js` | service worker: routes app tab ⇄ suno.com tab, answers popup probes |
| `popup.html` / `popup.js` | toolbar popup: suno.com status + app-site connections |
| `manifest.json` | MV3 configuration |
| `api-map.md` | reverse-engineered notes on Suno's Sound endpoints (dev reference) |
