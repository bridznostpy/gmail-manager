# Gmail Manager

Desktop app (Electron) for managing Gmail accounts through isolated Chrome
profiles driven over the **DevTools Protocol (CDP)**. It parses leads into a
queue, sends first-messages sequentially per account up to a configurable
limit, and runs an auto-responder the whole time. Left-side navigation with
collapsible panels, light/dark theme, JetBrains Mono typography and inline SVG
icons. The interface ships in **Russian and English** (Russian by default).

> **Gmail login is manual by design.** No Gmail API, no credential handling.
> Each profile opens `gmail.com` in its own Chrome instance and the user signs
> in by hand. The app only *observes* auth status via a DOM scan.

## Run

```bash
cd gmail-manager
npm install          # electron + ws
npm start            # or: npm run dev  (opens devtools)
```

Requires a local **Google Chrome** install. Set its path under **Chrome CDP** if
auto-detect fails.

## Layout

```
src/
  main/                       Electron main process
    main.js                   entry: wires store + engines + window
    store.js                  JSON settings store (userData/settings.json)
    i18n.js                   ru/en strings for logs, errors, Telegram notices
    logger.js                 central log stream → dashboard live logs
    ipc.js                    all IPC handlers (the only privileged surface)
    preload.js                contextBridge → window.api
    cdp/
      chromeManager.js        spawn Chrome, CDP over ws, port allocation
      fingerprint.js          per-profile fingerprint + injection script
    profiles/profileStore.js  persistent profile list (userData/profiles.json)
    parser/
      parserEngine.js         queue filler (batch + refill threshold)
      apis/xproject.js        XProject client   - TODO(docs)
      apis/vvs.js             VVS client        - TODO(docs)
    link/haronRent.js         Haron Rent link generator - TODO(docs)
    sender/senderEngine.js    run orchestration: sequential fill + auto-reply
    telegram/telegram.js      Bot API notifications (no deps)
  renderer/                   UI (vanilla JS, no framework)
    index.html, app.js, icons.js, styles/*.css
    i18n.js                   ru/en strings for the interface
    fonts/                    JetBrains Mono woff2 + OFL license
data/texts.example.json       broadcast-texts template
```

## Modules (UI)

- **Dashboard** - Start/Stop, status pill, uptime, queue size, live logs.
- **Profiles** - stats (total / running / gmail ready / ports open), create a
  profile (auto-launches Chrome at gmail.com for manual login), per-profile
  fingerprint, **Scan** button to detect auth status, readiness dot on each card,
  details in the right panel.
- **Parser** - API key + type (xproject / vvs), AI template swap toggle, enable
  toggle, rotate-key-every-N, platform filter (USA / Poshmark).
- **Chrome CDP** - port range (start/end), Chrome path + detect.
- **Link Generator** - Haron Rent API key, team, link mode, profile ID, country.
- **Telegram** - bot token + id, test button.
- **System Settings** - interface language (RU / EN), mails/account, max
  replies/dialog, check interval, parser batch size, queue refill threshold,
  and the broadcast-texts loader.

## Language and fonts

The interface language lives in `settings.json` as `language` (`ru` by default,
see `DEFAULTS` in `store.js`) and is switched under **System Settings ->
Interface**. Two independent dictionaries back it:

- `src/renderer/i18n.js` - everything drawn in the window (`window.I18N.t`).
- `src/main/i18n.js` - logger messages, thrown error texts and the Telegram
  notice. The renderer only displays strings already formatted by main, so the
  two dictionaries never overlap.

Switching applies immediately. Log entries already in the buffer keep the
language they were written in; new entries use the new one.

**JetBrains Mono** (SIL OFL 1.1) is vendored in `src/renderer/fonts/` as four
woff2 weights, licence text alongside them. No CDN is involved and none is
possible: the page CSP is `default-src 'self'`, so external fonts would be
blocked. Update the font by replacing the woff2 files; the `@font-face` rules
live at the top of `styles/theme.css`.

## Run scenario (implemented in `senderEngine.js`)

1. Start launches a Chrome instance for every **ready** account (one per account).
2. Parser gradually fills the queue (batches, refilled below the threshold).
3. Accounts fill **sequentially**: the current account sends until it hits
   `mailsPerAccount`, then the next account takes over.
4. The auto-responder runs throughout (interval = `checkIntervalSec`), capped at
   `maxRepliesPerDialog`.
5. When every account hits its limit, the user is notified via Telegram and the
   system stays in auto-reply-only mode until stopped.

## External API clients (wired from the provided docs)

Each client keeps its base URL, endpoints and auth in a `CONFIG` block (Rules 4):

| Integration | File | Base / shape |
|---|---|---|
| XProject Parser API | `src/main/parser/apis/xproject.js` | `https://api.xproject.icu`, header `X-API-Key`; task-based (start -> cursor-paged poll) |
| VVS Parser API | `src/main/parser/apis/vvs.js` | `http://vvsproject.xyz`, header `api-key`; one-shot `GET /ads/{platform}` |
| Haron Rent API | `src/main/link/haronRent.js` | `https://haronrent.xyz/api/v1`, `Bearer` token; `POST /createAd` (link mode = serviceCode) |

The parser's platform chips (USA / Poshmark) map onto each API's platform +
country filter via a `platformMap` in `CONFIG`. Link generation fails soft: a
missing key/serviceCode or API error yields a placeholder link so the pipeline
keeps running.

Gmail send and auto-reply over CDP are implemented in
`src/main/cdp/chromeManager.js` (`gmailCompose` / `gmailListUnread` /
`gmailReply`) and wired into `senderEngine.js`. They drive only stable Gmail
mechanisms (compose-in-URL + Ctrl+Enter, DOM read of unread rows) and are marked
`TODO(gmail-dom)`: the selectors still need a final check against a live
logged-in Gmail (use the profile "Test send" button to validate).

Everything else - orchestration, limits, sequencing, queue, fingerprints,
profile lifecycle, CDP launch/scan, theming, persistence - is complete and runs.

## Git / indexing

The repo is initialized locally. To push to GitHub and index via MCP:

```bash
gh repo create gmail-manager --private --source . --push   # needs gh auth
```
