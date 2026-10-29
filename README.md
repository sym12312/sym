# Stream Study

A local Chrome/Edge extension for collecting **public YouTube live chat and chat replay loaded in your browser**, including observed Super Chat and Super Sticker purchases. No YouTube API key, Google Cloud project, account connection, server, or AI service is needed.

This is an early browser-only prototype. It has synthetic test fixtures; it has **not yet been verified against a real YouTube livestream or chat replay**.

The current whole-session exporter can exceed Chrome's internal message-size limit on large datasets. See the measured [stress-test results and outstanding work](STRESS-RESULTS.md) before relying on it for a long stream. The [stress-test guide](STRESS-TEST.md) includes repeatable test commands.

## Install

1. On GitHub, choose **Code → Download ZIP**, then extract it to a folder you will keep on your computer. If using a separately supplied extension ZIP, extract that instead.
2. Open `chrome://extensions` in Chrome, or `edge://extensions` in Edge.
3. Enable **Developer mode**.
4. Click **Load unpacked** and select the folder containing `manifest.json`. For this repository's main-branch download, that folder is `sym-main`. A separately supplied extension ZIP may use the folder name `stream-study`.
5. Pin **Stream Study** from the browser's Extensions menu.
6. Open or refresh a YouTube livestream or recording. Expand **Live chat** or **Chat replay**, choosing the unfiltered chat view if available.
7. Click the Stream Study extension icon while on that YouTube tab. Its notebook opens in a new tab.
8. Click **Start capture**. Keep the YouTube tab open and your computer awake. The notebook itself can be closed while capture continues.

The same flow works with a YouTube pop-out chat URL containing `v=VIDEO_ID`. Only the desktop `https://www.youtube.com` host is supported in this version.

## Study a stream replay

1. Open the recording of a completed YouTube livestream. It must have **Chat replay** available; ordinary comments below the video are not replay chat.
2. Open the chat replay panel and move the video to the beginning, then pause playback while starting the capture.
3. Click the Stream Study extension icon, then **Start capture**. The notebook should show **Recording replay** once connected.
4. Play the video and keep the tab open. Messages are saved as YouTube renders them. Begin at normal speed; faster playback creates more chat traffic and has not been validated for complete capture.
5. Pause capture when finished, then export CSV or JSON for analysis.

Replay rows show their displayed video timestamp separately from the time they were captured on your computer. Click a nonnegative replay timestamp to open the video at that point. If YouTube supplies no recognizable timestamp, the time stays unknown; the extension does not infer it from the capture clock. Replaying or rewinding a section does not count stable message IDs again within the same session. Use **Resume session** to continue the same dataset.

This collects playback as it happens. It does not automatically download the full replay: seeking past a section can omit its messages, and a replay without a chat panel cannot be collected. Deleted, hidden, filtered, or unavailable messages remain unavailable. An interruption-free session is not proof of complete coverage.

## Update an existing installation

Pause capture and export any data you need first. Download the latest ZIP from [the GitHub repository](https://github.com/sym12312/sym), extract it, and replace the files in the folder you previously loaded. On `chrome://extensions` or `edge://extensions`, click **Reload** on Stream Study, then refresh the YouTube and notebook tabs. Check that the extension version is **0.2.0**. Keep the existing extension installed to retain its saved sessions.

## Try the notebook without a stream

Open the extension notebook and choose its demo button. This creates an explicitly labeled synthetic session. Demo purchases never mix with a captured session. This checks the notebook, saved sessions, and exports; it does not verify live YouTube access.

## What is captured

- Loaded ordinary chat messages, public display names, displayed timestamps, and capture timestamps.
- Replay video offsets when YouTube displays a recognizable elapsed timestamp, with live and replay capture labeled separately.
- Super Chats and Super Stickers, with the original displayed purchase string.
- Membership and gift announcements as separate message categories. The membership counter counts announcements, **not the number of memberships purchased**. Gift purchase and redemption announcements can both be present.
- Monitoring intervals, recent collector heartbeats, and detected interruptions.

Both already-loaded messages and newly loaded messages are observed. `captureOrigin: initial` identifies rows present when monitoring starts or resumes, including rows that may predate that monitoring interval. Other rows have origin `live` or `replay`. `observedAt` is the time our collector first saw a row; `displayTimestamp` preserves YouTube's displayed time and may be blank. Do not interpret arrival time as the exact payment time.

`captureMode` identifies a record's source as `live` or `replay`. `replayOffsetSeconds` is the signed video offset parsed from the displayed replay timestamp, or null when unavailable; negative values represent displayed pre-roll timestamps. A session studied both live and as a replay is labeled **Live + replay**, while stable IDs still deduplicate within that session. Older saved records may lack these new fields.

A message first captured live can gain replay timing when encountered again in replay. Its mode then reads `replay`, while its first `observedAt` and `captureOrigin` stay unchanged. This updates one saved record rather than adding another purchase.

## Counting rules

The purchase list includes captured Super Chat and Super Sticker records. **Confirmed totals** include only positive, parseable amounts with an unambiguous currency and a stable YouTube message ID. Every currency gets its own total, calculated with integer arithmetic.

- Stable message IDs prevent the same purchase from being counted again after a re-render, reload, or replay rewind within the same session. Ticker copies are ignored.
- When YouTube fills an amount into an existing row, that row is updated rather than counted twice.
- A bare `$`, `¥`, or `kr` does not establish a currency. These purchases remain visible and exportable as **needs review**, excluded from confirmed monetary totals.
- A purchase without a stable message ID is also marked for review. Re-created unidentified rows may appear more than once in the review list, but are excluded from confirmed totals.
- Memberships, gifted memberships, and Jewels gifts do not have a reliable cash purchase amount in the rendered message and are not assigned a cash value.
- The results are observed public purchase amounts, not the creator's net earnings, payouts, or a verified full-stream total. Refunds and private financial records are not available.

## Coverage limits

The extension reads the rendered live-chat or chat-replay frame. It cannot recover messages that YouTube never loads, earlier messages that have left the page, hidden/deleted messages, or skipped replay sections. Start before the part of the stream you want to study and choose an unfiltered chat view instead of **Top chat** if available. For replay, play through the sections you want to study. The extension does not automatically change YouTube's chat filter or playback position.

Leaving the tab open does not guarantee completeness: browser tab discarding, suspension, network interruptions, high chat volume, and YouTube layout changes can still cause missed messages. A recent heartbeat means the collector is running, not that all messages reached your browser. The notebook marks stale heartbeats and detected interruptions. Messages already loaded while paused may be captured on resume and are labeled `initial`.

Navigating to a different video pauses that session to avoid mixing streams. Closing the monitored tab also pauses it. Browser restart and extension update require opening the stream and resuming capture. After installing or updating, refresh any YouTube tabs that were already open.

## Storage and exports

Data stays in this browser profile's IndexedDB. The extension makes no external requests and does not upload data. Export CSV for a spreadsheet, or JSON to preserve both records and session coverage metadata. CSV protects cells beginning with spreadsheet formula characters by prefixing an apostrophe. A CSV has all captured records for the session even if the notebook is filtering or displaying only recent rows.

The CSV appends `captureMode` and `replayOffsetSeconds` after the original columns. Sort replay rows by the numeric `replayOffsetSeconds` column to study the video timeline; exported records otherwise follow capture order, which can differ after seeking. Blank offsets are unknown. JSON also includes the session's capture mode and capture windows. These windows describe activity on your device, not verified coverage of the video timeline.

Use **Delete session** to erase an individual dataset. Uninstalling the extension or clearing its storage removes saved sessions. Local browser storage is finite; export and remove old sessions when necessary. Keep the extracted extension folder because Load unpacked references it.

## Permissions

- YouTube host access: read live and replay chat frames and recognize the monitored video.
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
