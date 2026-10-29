# Results and outstanding work

These saved measurements describe version 0.1.0 and its 13-column CSV. Version 0.2.0 adds replay metadata and two CSV columns, so current payload sizes will differ. The large-export limitations below remain unresolved.

The target is **10 Super Chats/second for two hours: 72,000 unique paid events**. These completed tests exercise production parsing, arithmetic, and serialization helpers in Node.js. They do not establish DOM collection, IndexedDB persistence, browser messaging, or real-time browser reliability.

## Measured full-volume runs

Both runs generated all 72,000 purchases at USD 1.00 each. Each had 200 Unicode code points per message, repeated deliveries, and some amounts initially missing and later filled in. The reference replay model produced exactly 72,000 unique paid rows and USD 72,000.00. An independent CSV parser checked every exported cell, all 13 columns, and all 72,000 unique IDs.

| Actual 72,000-row workload | CSV size | Internal JSON response size | Relative to Chrome's 64 MiB message limit |
| --- | ---: | ---: | --- |
| Mixed text, quotes, newlines, and occasional Unicode | 27.11 MiB | 38.93 MiB | Below the limit; browser success still unverified |
| Emoji-heavy text | 65.75 MiB | 77.56 MiB | Exceeds the limit used by the current single-message export |

MiB means 1,048,576 bytes. CSV bytes and internal JSON bytes are different. The emoji run passing helper tests does **not** mean its browser export can succeed. The oversized internal response is a concrete compatibility problem for the existing export architecture.

The default mixed-text run took 5.38 seconds in Node, including generation and verification. This is an accelerated offline benchmark representing two hours of events, not a two-hour soak or a browser-throughput measurement. Its process peak RSS was approximately 493 MiB, including benchmark data structures and all phases; this is not the extension's measured browser memory usage.

Reports with exact counts, byte sizes, hashes, timings, and limitations:

- `test-results/stress-offline.json`
- `test-results/stress-offline-emoji.json`

## Additional projections and checks

- Adding 100 ordinary chat messages/second produces 792,000 total unique records over two hours. A representative-schema projection puts the default mixed-text internal export response at approximately **414 MiB**. This is an estimate, not a measured 792,000-row browser run.
- Four controlled-clock tests passed for the synthetic source: the 72,000-event schedule, ordinary-chat counts, bursts without changing totals, and acceleration labels. These validate the test generator, not the collector's actual throughput.
- The browser stress runner was syntax-checked and reviewed, but has **not been executed**. Earlier Chromium launches were blocked by the workspace sandbox's socket restriction. No two-hour browser soak or real YouTube validation is claimed.

## What remains before relying on the target workload

1. **Chunked export:** avoid returning the whole session through one runtime message; page or stream records and split files when appropriate. Ensure exporting does not stall capture writes. This is the first demonstrated capacity issue.
2. **Paid-event protection under mixed traffic:** establish the expected ordinary-chat rate and test bursts. Consider prioritizing paid events or an optional paid-events-only capture mode if ordinary chat overwhelms the shared queue. Version 0.1.0 has neither behavior.
3. **Real-time browser validation:** run the one-minute smoke test, then a full two-hour baseline and mixed-chat run. Require no missing/duplicate paid IDs, exact totals, acceptable persistence lag, complete exports, and stable memory during collection.
4. **Recovery and background operation:** execute the existing browser regression suite and a background-tab run. Test network interruptions, page reloads, tab sleep/discard, and service-worker restarts; gaps must be visible. Tests are prepared for several of these cases, but have not run.
5. **Real YouTube compatibility and currency coverage:** inspect current rendered chat and paid-message formats, including stickers, non-English number formats, and ambiguous currency symbols. Unknown currencies remain visible and exportable but are excluded from confirmed monetary totals. Synthetic USD-only stress totals do not validate those live cases.

Use `STRESS-TEST.md` for the commands and acceptance criteria. The extension itself remains version 0.1.0; the changes in this test kit add tests and reports, not the above production fixes.
