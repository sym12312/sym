# Stress-testing the 10-Super-Chats/second requirement

The target is **10 × 7,200 = 72,000 Super Chats in two hours**. Use generated purchases; no real payments or live YouTube traffic are needed for these tests.

The benchmark scripts do not modify the production extension. Browser runs use a fresh browser profile, load the unpacked extension, and fulfill synthetic YouTube pages locally. They do not post comments or purchase anything.

## Workloads

| Workload | Paid events/second | Ordinary messages/second | Two-hour paid count | Two-hour total unique records |
| --- | ---: | ---: | ---: | ---: |
| Required baseline | 10 | 0 | 72,000 | 72,000 |
| Busy-chat scenario | 10 | 100 | 72,000 | 792,000 |
| Overload diagnostic | 10 | 500 | 72,000 | 3,672,000 |

The ordinary-chat rates are test assumptions, not measurements of your example stream. Establish the expected ordinary-message rate before treating a paid-event-only pass as sufficient.

Every synthetic Super Chat is **USD 1.00**, so the baseline must produce exactly **72,000 confirmed paid events and USD 72,000.00**. Repeated delivery of an existing message ID must not increase either total.

## 1. Full-volume offline check

With Node.js installed, from this extracted project folder:

```sh
node --expose-gc tests/stress_offline.mjs --duration-seconds 7200 --paid-rate 10 --chat-rate 0 --message-length 200
```

This generates the complete 72,000-event workload and exercises the actual currency parser, total arithmetic, and CSV serializer. It measures export bytes and checks CSV structure. It is a fast volume/serialization check, **not** a test of DOM observation, extension messaging, IndexedDB writes, or two-hour stability. Its in-memory duplicate-delivery model does not validate the actual database's duplicate handling.

The generated report states its message text assumptions, measured metrics, and limitations. Predictions for other workloads must be treated as projections unless that workload was actually generated.

The completed baseline and emoji-heavy run results are in `STRESS-RESULTS.md`. To reproduce the emoji workload:

```sh
node --expose-gc tests/stress_offline.mjs --message-style emoji --output test-results/stress-offline-emoji.json
```

## 2. Browser smoke check

Install Python, Playwright, and its Chromium browser once on your test computer:

```sh
python -m pip install playwright
python -m playwright install chromium
```

Then run a one-minute trial:

```sh
python tests/stress_browser.py --duration-seconds 60 --paid-rate 10 --chat-rate 0
```

It must save **600 paid events and USD 600.00**, with no duplicate paid records. It should also produce a complete export. An existing Chromium executable can be selected with `--chromium /path/to/chromium`. Run `python tests/stress_browser.py --help` for the available options.

The separate regression suite covers pause/resume, amount hydration, missing IDs becoming stable IDs, reload persistence, replay rejection, and navigation to a different video:

```sh
python tests/browser_smoke.py --chromium /path/to/chromium
```

## 3. Full two-hour browser soak

Run on the computer/browser configuration you intend to use for collection:

```sh
python tests/stress_browser.py --duration-seconds 7200 --paid-rate 10 --chat-rate 0
```

Repeat with ordinary chat:

```sh
python tests/stress_browser.py --duration-seconds 7200 --paid-rate 10 --chat-rate 100
```

Keep the computer awake. A real two-hour run is necessary to evaluate long-run behavior; generating two hours' worth of timestamps rapidly does not establish it. For a realistic desktop test, use the runner's headed/background-source options and keep normal browser throttling enabled. Start with the baseline before running the larger mixed scenario.

## Acceptance checklist

- **Generation:** all scheduled source events were generated at the intended wall-clock rate. A generator that falls behind invalidates the throughput test.
- **Paid-event accuracy:** every expected stable message ID is stored once, with zero missing or unexpected paid IDs. Re-deliveries do not change the unique count.
- **Totals:** exactly USD 72,000.00 for the full baseline; ordinary chat does not affect it.
- **Persistence:** sample save lag stays low (default acceptance: 95th percentile at most 2 seconds, with at least 95% of generated lag samples observed), with no growing backlog or reported dropped events. Configure these with `--max-save-lag-ms` and `--min-lag-sample-coverage`. Samples include polling/response delay; sparse latest-record sampling can miss slow events, so inspect coverage too. Lag targets apply during capture, not after a pause flush.
- **Exports:** CSV parses correctly and contains every saved session record, with one header row. Final baseline: 72,000 data rows; mixed scenario: 792,000 data rows. Export during active capture must not cause later capture loss.
- **Memory:** inspect browser heap over time. It should settle during steady collection after the bounded caches warm up; export-time spikes should be reported separately. Node benchmark memory is not browser memory.
- **Recovery:** the smoke suite passes, including duplicate re-renders, pause draining, reload, and video isolation.

Save reports along with the browser version, computer specs, options, and whether the source tab was visible. A real-stream spot check is still needed afterward because synthetic HTML cannot guarantee compatibility with YouTube's current markup or that YouTube loads every message.

## Known limits this test should expose

The current collector attempts batches of at most **200 records every 500 ms**. That is a theoretical ceiling of 400 delivered records/second before processing delays. Ten paid events/second is well below this ceiling, but ordinary chat and duplicate updates share the same queue. The pending queue holds 5,000 event IDs and reports overflow; the collector does not give paid events priority over ordinary chat.

The current exporter returns the whole session in one runtime message and then builds the CSV in memory. Chrome's [message-size limit is 64 MiB](https://developer.chrome.com/docs/extensions/develop/concepts/messaging#message-size-limits), including the JSON metadata. The final CSV size is different. A size benchmark below this limit does not prove a browser export will succeed, because browser memory and other runtime limits also apply.

Large exports also wait in the same serialized worker queue as capture writes. The stress runner checks an export during active capture to expose this interaction. Chunked exports and a paid-events-only capture option are likely improvements for high-volume mixed chat; they are not present in version 0.1.0.

Accelerating the source also raises its rate: running the two-hour workload at 60× speed produces **600 paid events/second**, above the collector's theoretical ceiling even before ordinary chat. Treat that as an intentional overload test, not an equivalent shortcut for the required 10/second soak.
