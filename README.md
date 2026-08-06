# Gmail Manager

Desktop app (Electron) for managing Gmail accounts through isolated Chrome
profiles driven over the **DevTools Protocol (CDP)**. It parses leads into a
queue, sends first-messages sequentially per account up to a configurable
limit, and runs an auto-responder the whole time. Left-side navigation with
collapsible panels, light/dark theme, modern system fonts and inline SVG icons.

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
    logger.js                 central log stream → dashboard live logs
    ipc.js                    all IPC handlers (the only privileged surface)
    preload.js                contextBridge → window.api
    cdp/
      chromeManager.js        spawn Chrome, CDP over ws, port allocation
      fingerprint.js          per-profile fingerprint + injection script
    profiles/profileStore.js  persistent profile list (userData/profiles.json)
    parser/
      parserEngine.js         queue filler (batch + refill threshold)
      apis/xproject.js        XProject client   — TODO(docs)
      apis/vvs.js             VVS client        — TODO(docs)
    link/haronRent.js         Haron Rent link generator — TODO(docs)
    sender/senderEngine.js    run orchestration: sequential fill + auto-reply
    telegram/telegram.js      Bot API notifications (no deps)
  renderer/                   UI (vanilla JS, no framework)
    index.html, app.js, icons.js, styles/*.css
data/texts.example.json       broadcast-texts template
```

## Modules (UI)

- **Dashboard** — Start/Stop, status pill, uptime, queue size, live logs.
- **Profiles** — stats (total / running / gmail ready / ports open), create a
  profile (auto-launches Chrome at gmail.com for manual login), per-profile
  fingerprint, **Scan** button to detect auth status, readiness dot on each card,
  details in the right panel.
- **Parser** — API key + type (xproject / vvs), AI template swap toggle, enable
  toggle, rotate-key-every-N, platform filter (USA / Poshmark).
- **Chrome CDP** — port range (start/end), Chrome path + detect.
- **Link Generator** — Haron Rent API key, team, link mode, profile ID, country.
- **Telegram** — bot token + id, test button.
- **System Settings** — mails/account, max replies/dialog, check interval,
  parser batch size, queue refill threshold, and the broadcast-texts loader.

## Run scenario (implemented in `senderEngine.js`)

1. Start launches a Chrome instance for every **ready** account (one per account).
2. Parser gradually fills the queue (batches, refilled below the threshold).
3. Accounts fill **sequentially**: the current account sends until it hits
   `mailsPerAccount`, then the next account takes over.
4. The auto-responder runs throughout (interval = `checkIntervalSec`), capped at
   `maxRepliesPerDialog`.
5. When every account hits its limit, the user is notified via Telegram and the
   system stays in auto-reply-only mode until stopped.

## What still needs the attached docs

These arrive from documentation referenced in the brief but not yet provided.
Each is isolated to one file with a `CONFIG` block and `TODO(docs)` markers:

| Integration | File | Needs |
|---|---|---|
| XProject Parser API | `src/main/parser/apis/xproject.js` | endpoints, auth, response schema |
| VVS Parser API | `src/main/parser/apis/vvs.js` | endpoints, auth, response schema |
| Haron Rent API | `src/main/link/haronRent.js` | link/listing/profile/domain endpoints |
| Broadcast texts JSON | `data/texts.example.json` | confirm the real structure |
| Gmail compose / read-replies over CDP | `src/main/sender/senderEngine.js` | `TODO(gmail-dom)` — finalize against a live logged-in Gmail DOM |

Everything else — orchestration, limits, sequencing, queue, fingerprints,
profile lifecycle, CDP launch/scan, theming, persistence — is complete and runs.

## Git / indexing

The repo is initialized locally. To push to GitHub and index via MCP:

```bash
gh repo create gmail-manager --private --source . --push   # needs gh auth
```
