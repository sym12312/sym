# Stream Study

A local Chrome/Edge extension for collecting the **public live-chat messages loaded in your browser**, including observed Super Chat and Super Sticker purchases. No YouTube API key, Google Cloud project, account connection, server, or AI service is needed.

This is an early browser-only prototype. It has synthetic test fixtures; it has **not yet been verified against a real YouTube livestream**.

The current whole-session exporter can exceed Chrome's internal message-size limit on large datasets. See the measured [stress-test results and outstanding work](STRESS-RESULTS.md) before relying on it for a long stream. The [stress-test guide](STRESS-TEST.md) includes repeatable test commands.

## Install

1. On GitHub, choose **Code → Download ZIP**, then extract it to a folder you will keep on your computer. If using a separately supplied extension ZIP, extract that instead.
2. Open `chrome://extensions` in Chrome, or `edge://extensions` in Edge.
3. Enable **Developer mode**.
4. Click **Load unpacked** and select the folder containing `manifest.json`. For this repository's main-branch download, that folder is `sym-main`. A separately supplied extension ZIP may use the folder name `stream-study`.
5. Pin **Stream Study** from the browser's Extensions menu.
6. Open or refresh a YouTube livestream, expand its chat, and select **Live chat** in YouTube's chat menu.
7. Click the Stream Study extension icon while on that YouTube tab. Its notebook opens in a new tab.
8. Click **Start capture**. Keep the YouTube tab open and your computer awake. The notebook itself can be closed while capture continues.

The same flow works with a YouTube pop-out chat URL containing `v=VIDEO_ID`. Only the desktop `https://www.youtube.com` host is supported in this version.

## Try the notebook without a stream

Open the extension notebook and choose its demo button. This creates an explicitly labeled synthetic session. Demo purchases never mix with a captured session. This checks the notebook, saved sessions, and exports; it does not verify live YouTube access.

## What is captured

- Loaded ordinary chat messages, public display names, displayed timestamps, and capture timestamps.
- Super Chats and Super Stickers, with the original displayed purchase string.
- Membership and gift announcements as separate message categories. The membership counter counts announcements, **not the number of memberships purchased**. Gift purchase and redemption announcements can both be present.
- Monitoring intervals, recent collector heartbeats, and detected interruptions.

Both already-loaded messages and newly loaded messages are observed. `captureOrigin: initial` identifies rows present when monitoring starts or resumes, including rows that may predate that monitoring interval. `observedAt` is the time our collector first saw a row; `displayTimestamp` preserves YouTube's displayed time and may be blank. Do not interpret arrival time as the exact payment time.

## Counting rules

The purchase list includes captured Super Chat and Super Sticker records. **Confirmed totals** include only positive, parseable amounts with an unambiguous currency and a stable YouTube message ID. Every currency gets its own total, calculated with integer arithmetic.

- Stable message IDs prevent the same purchase from being counted again after a re-render or reload. Ticker copies are ignored.
- When YouTube fills an amount into an existing row, that row is updated rather than counted twice.
- A bare `$`, `¥`, or `kr` does not establish a currency. These purchases remain visible and exportable as **needs review**, excluded from confirmed monetary totals.
- A purchase without a stable message ID is also marked for review. Re-created unidentified rows may appear more than once in the review list, but are excluded from confirmed totals.
- Memberships, gifted memberships, and Jewels gifts do not have a reliable cash purchase amount in the rendered message and are not assigned a cash value.
- The results are observed public purchase amounts, not the creator's net earnings, payouts, or a verified full-stream total. Refunds and private financial records are not available.

## Coverage limits

The extension reads the rendered live-chat frame. It cannot recover messages that YouTube never loads, earlier messages that have left the page, hidden/deleted messages, or a full historical chat replay. Start before the part of the stream you want to study and use **Live chat** instead of **Top chat**. The extension does not automatically change YouTube's chat filter.

Leaving the tab open does not guarantee completeness: browser tab discarding, suspension, network interruptions, high chat volume, and YouTube layout changes can still cause missed messages. A recent heartbeat means the collector is running, not that all messages reached your browser. The notebook marks stale heartbeats and detected interruptions. Messages already loaded while paused may be captured on resume and are labeled `initial`.

Navigating to a different video pauses that session to avoid mixing streams. Closing the monitored tab also pauses it. Browser restart and extension update require opening the stream and resuming capture. After installing or updating, refresh any YouTube tabs that were already open.

## Storage and exports

Data stays in this browser profile's IndexedDB. The extension makes no external requests and does not upload data. Export CSV for a spreadsheet, or JSON to preserve both records and session coverage metadata. CSV protects cells beginning with spreadsheet formula characters by prefixing an apostrophe. A CSV has all captured records for the session even if the notebook is filtering or displaying only recent rows.

Use **Delete session** to erase an individual dataset. Uninstalling the extension or clearing its storage removes saved sessions. Local browser storage is finite; export and remove old sessions when necessary. Keep the extracted extension folder because Load unpacked references it.

## Permissions

- YouTube host access: read live-chat frames and recognize the monitored video.
- `activeTab`: identify the tab when you click the extension icon.
- `storage`: retain the tab-to-session mapping across service-worker restarts.

No access to other sites, cookies, passwords, payment accounts, microphone, or camera is requested. Chat collection starts only when you click Start; the content script otherwise remains idle apart from checking whether a session has started.

## Development and verification

No build step or dependencies are required to install the extension. Node.js can run the pure tests:

```sh
node --test tests/*.test.js
```

The browser integration test requires Python Playwright and Chromium:

```sh
python tests/browser_smoke.py --chromium /usr/bin/chromium
```

The browser test fulfills synthetic YouTube pages locally and blocks other HTTP(S) traffic. It exercises the unpacked extension's collector, worker, storage, and exports. It does not contact the example stream or validate the current production YouTube layout.
