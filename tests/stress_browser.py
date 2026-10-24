#!/usr/bin/env python3
"""Measure the real unpacked extension against a local synthetic chat workload.

This script does NOT contact live YouTube. It does launch Chromium when invoked.
It never installs packages, changes browser permissions, or edits the extension.

Examples (run from the project directory):
  python tests/stress_browser.py --duration-seconds 60
  python tests/stress_browser.py --duration-seconds 7200 --paid-rate 10
  python tests/stress_browser.py --duration-seconds 7200 --paid-rate 10 --chat-rate 100
  python tests/stress_browser.py --duration-seconds 7200 --time-scale 6

The last example compresses 72,000 purchases into 20 minutes at 60 purchases/sec;
it is a volume test, NOT a two-hour soak. Scale 60 produces 600 purchases/sec and
is an overload experiment. Accelerating also multiplies the ordinary-chat rate.

Install Python Playwright and a full Chromium separately before running. Pass
--chromium /path/to/chromium, or this script selects a system/bundled Chromium.
Results, downloaded CSVs, and progress are written beneath --output-dir.
"""

from __future__ import annotations

import argparse
import asyncio
import csv
import json
import math
import platform
import re
import shutil
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from playwright.async_api import async_playwright


PROJECT = Path(__file__).resolve().parents[1]
VIDEO_ID = "E1Q0kFB76VU"
WATCH_URL = f"https://www.youtube.com/watch?v={VIDEO_ID}"
EVENT_ID = re.compile(r"^yt:stress-(paid|chat)-(\d{9})$")
THROTTLING_OVERRIDES = [
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
]
CHAT_HTML = """<!doctype html><html lang="en"><meta charset="utf-8">
<title>Synthetic live chat</title><body><yt-live-chat-renderer>
<yt-live-chat-header-renderer><yt-dropdown-menu id="view-selector">
<span id="label">Live chat</span></yt-dropdown-menu></yt-live-chat-header-renderer>
<yt-live-chat-item-list-renderer><div id="item-scroller"><div id="items"></div></div>
</yt-live-chat-item-list-renderer></yt-live-chat-renderer></body></html>"""

IDB_PAGE = """async ({sessionId, after, limit}) => {
  const db = await new Promise((resolve, reject) => {
    const open = indexedDB.open('stream-study-v1');
    open.onupgradeneeded = () => { open.transaction.abort(); reject(new Error('Capture database does not exist')); };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('events', 'readonly');
      const rows = [];
      let last = null;
      const range = IDBKeyRange.bound([sessionId, after || ''], [sessionId, '\\uffff'], Boolean(after), false);
      const request = tx.objectStore('events').openCursor(range);
      request.onerror = () => reject(request.error);
      tx.onabort = () => reject(tx.error || new Error('Read-only audit interrupted'));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || rows.length >= limit) { resolve({rows, next: cursor ? last : null}); return; }
        const event = cursor.value;
        rows.push({eventId:event.eventId, type:event.type, idQuality:event.idQuality,
          currency:event.currency, amountMicros:event.amountMicros, amountIssue:event.amountIssue});
        last = event.eventId;
        cursor.continue();
      };
    });
  } finally { db.close(); }
}"""

IDB_SESSION = """async sessionId => {
  const db = await new Promise((resolve, reject) => {
    const open = indexedDB.open('stream-study-v1');
    open.onupgradeneeded = () => { open.transaction.abort(); reject(new Error('Capture database does not exist')); };
    open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error);
  });
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction('sessions', 'readonly').objectStore('sessions').get(sessionId);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
  } finally { db.close(); }
}"""


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def percentile(values, fraction):
    if not values:
        return None
    ordered = sorted(values)
    return round(ordered[max(0, math.ceil(len(ordered) * fraction) - 1)], 3)


def distribution(values):
    return {"samples": len(values), "p50": percentile(values, 0.50),
            "p95": percentile(values, 0.95), "max": max(values, default=None)}


class EventAudit:
    """Bounded-memory exact-ID verification, independent of the app's counters."""

    def __init__(self, paid, chat):
        self.expected = {"paid": paid, "chat": chat}
        self.seen = {"paid": bytearray(paid), "chat": bytearray(chat)}
        self.rows = 0
        self.duplicates = 0
        self.extras = 0
        self.invalid = 0
        self.usd_micros = 0
        self.examples = []

    def add(self, event):
        self.rows += 1
        identity = str(event.get("eventId", ""))
        match = EVENT_ID.fullmatch(identity)
        if not match or int(match[2]) >= self.expected[match[1]]:
            self.extras += 1
            if len(self.examples) < 20:
                self.examples.append({"eventId": identity, "issue": "unexpected-id"})
            return
        kind, index = match[1], int(match[2])
        if self.seen[kind][index]:
            self.duplicates += 1
        self.seen[kind][index] = 1
        valid = event.get("idQuality") == "youtube"
        if kind == "paid":
            valid = (valid and event.get("type") == "superchat" and event.get("currency") == "USD"
                     and str(event.get("amountMicros")) == "1000000" and not event.get("amountIssue"))
            if valid:
                self.usd_micros += 1000000
        else:
            valid = valid and event.get("type") == "chat"
        if not valid:
            self.invalid += 1
            if len(self.examples) < 20:
                self.examples.append({"eventId": identity, "issue": "unexpected-record-fields"})

    def summary(self):
        unique = {kind: sum(bitmap) for kind, bitmap in self.seen.items()}
        missing = {kind: self.expected[kind] - unique[kind] for kind in self.expected}
        examples = []
        for kind, bitmap in self.seen.items():
            for index, present in enumerate(bitmap):
                if not present:
                    examples.append(f"yt:stress-{kind}-{index:09d}")
                    if len(examples) >= 20:
                        break
            if len(examples) >= 20:
                break
        return {"saved_rows": self.rows, "unique_paid": unique["paid"], "unique_chat": unique["chat"],
                "missing_paid": missing["paid"], "missing_chat": missing["chat"],
                "duplicate_ids": self.duplicates, "extra_ids": self.extras, "invalid_records": self.invalid,
                "usd_micros": str(self.usd_micros), "missing_examples": examples,
                "problem_examples": self.examples}


def audit_csv(path, paid, chat):
    audit = EventAudit(paid, chat)
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        required = {"eventId", "type", "idQuality", "currency", "amountMicros", "amountIssue"}
        if not required.issubset(reader.fieldnames or []):
            raise AssertionError(f"CSV columns are missing: {required - set(reader.fieldnames or [])}")
        for row in reader:
            audit.add(row)
    return {**audit.summary(), "file_bytes": path.stat().st_size, "path": str(path)}


async def bounded(coroutine, seconds=20):
    return await asyncio.wait_for(coroutine, timeout=seconds)


async def app_request(page, message, timeout=10):
    result = await bounded(page.evaluate("""async ({message, timeoutMs}) => {
      let timer;
      try {
        return await Promise.race([
          chrome.runtime.sendMessage(message),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('App message timed out')), timeoutMs); })
        ]);
      } finally { clearTimeout(timer); }
    }""", {"message": message, "timeoutMs": int(timeout * 1000)}), timeout + 2)
    if not result or not result.get("ok"):
        raise RuntimeError(f"{message.get('type')} failed: {result}")
    return result


async def direct_session(page, session_id):
    return await bounded(page.evaluate(IDB_SESSION, session_id), 30)


async def audit_database(page, session_id, paid, chat):
    audit = EventAudit(paid, chat)
    after = None
    while True:
        result = await bounded(page.evaluate(IDB_PAGE, {"sessionId": session_id, "after": after, "limit": 5000}), 30)
        for event in result["rows"]:
            audit.add(event)
        after = result["next"]
        if after is None:
            return audit.summary()


def write_report(path, report):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    temporary.replace(path)


async def run(options):
    paid = math.floor(options.duration_seconds * options.paid_rate)
    chat = math.floor(options.duration_seconds * options.chat_rate)
    total = paid + chat
    output = options.output_dir.resolve()
    output.mkdir(parents=True, exist_ok=True)
    report_path = output / "report.json"
    start_clock = time.monotonic()
    report = {
        "schema_version": 1, "status": "running", "started_at": utc_now(),
        "test_host": {"platform": platform.platform(), "python": sys.version, "architecture": platform.machine()},
        "scope": "Real unpacked extension; synthetic local YouTube DOM; not live YouTube validation.",
        "run_kind": "accelerated volume/overload test; NOT a duration soak" if options.time_scale != 1 else "real-time workload",
        "configuration": {**vars(options), "output_dir": str(output), "chromium": options.chromium},
        "expected": {"paid_events": paid, "chat_events": chat, "total_events": total,
                     "usd_micros": str(paid * 1000000), "usd_amount": str(paid),
                     "planned_wall_seconds": options.duration_seconds / options.time_scale,
                     "effective_paid_per_wall_second": options.paid_rate * options.time_scale,
                     "effective_chat_per_wall_second": options.chat_rate * options.time_scale},
        "notes": [
            "Duplicate clones reuse native IDs and must not add rows or money.",
            "Messages are deterministic ASCII text of the configured message length.",
            "Persistence lag is an upper bound observed through GET_EVENTS, including poll/response delay.",
            "Sparse latest-event sampling can miss slow records; coverage is reported with the lag distribution.",
            "Independent final storage audit uses read-only paged IndexedDB access, even if normal export fails.",
            "Heap diagnostics use Runtime.getHeapUsage, not retained-object heap snapshots.",
            "Headless Chromium and synthetic DOM cannot reproduce every live YouTube workload.",
        ],
        "progress": [], "exports": [], "heap_measurements": [], "errors": [], "page_errors": [],
        "blocked_off_origin_requests": 0, "checks": [],
    }
    write_report(report_path, report)
    print(json.dumps({"status": "starting", "report": str(report_path), "expected": report["expected"],
                      "run_kind": report["run_kind"]}), flush=True)
    samples = {}
    observed_samples = {}
    recently_seen = {}
    last_snapshot = {}
    last_session = None
    max_backlog = 0
    context = None
    dashboard = None
    frame = None
    session_id = None
    active_export = None
    downloads = []
    heap_clients = {}
    interrupted = False

    def record_error(stage, error):
        entry = {"at": utc_now(), "stage": stage, "error": str(error)[:2000]}
        report["errors"].append(entry)
        print(json.dumps({"status": "diagnostic", **entry}), flush=True)

    async def fixture(route):
        parsed = urlparse(route.request.url)
        if parsed.scheme != "https" or parsed.hostname != "www.youtube.com":
            report["blocked_off_origin_requests"] += 1
            await route.abort()
        elif parsed.path == "/watch":
            video_id = parse_qs(parsed.query).get("v", [VIDEO_ID])[0]
            await route.fulfill(status=200, content_type="text/html", body=(
                "<!doctype html><html><meta charset='utf-8'><title>Stream Study synthetic stress test</title>"
                "<body><h1>Synthetic stream workload</h1><iframe id='chatframe' style='width:90vw;height:80vh' "
                f"src='/live_chat?v={video_id}'></iframe></body></html>"))
        elif parsed.path == "/live_chat":
            await route.fulfill(status=200, content_type="text/html", body=CHAT_HTML)
        else:
            await route.fulfill(status=404, body="Synthetic fixture route not found")

    async def snapshot():
        nonlocal last_snapshot
        result = await bounded(frame.evaluate("""offset => {
          const state = StreamStudyStress.snapshot();
          state.samples = (state.samples || []).slice(offset);
          return state;
        }""", len(samples)), 15)
        for sample in result.pop("samples", []):
            samples[sample["eventId"]] = sample
            if sample["eventId"] in recently_seen and sample["eventId"] not in observed_samples:
                observed_samples[sample["eventId"]] = max(0, recently_seen[sample["eventId"]] - sample["generatedAtMs"])
        last_snapshot = result
        return result

    async def heaps(label):
        for name, client in heap_clients.items():
            try:
                heap = await bounded(client.send("Runtime.getHeapUsage"), 5)
                dom = await bounded(client.send("Memory.getDOMCounters"), 5)
                report["heap_measurements"].append({"at": utc_now(), "label": label, "page": name,
                                                    "heap": heap, "dom": dom})
            except Exception as error:
                report["heap_measurements"].append({"at": utc_now(), "label": label, "page": name,
                                                    "unavailable": str(error)[:500]})

    async def begin_export(label):
        nonlocal active_export
        generated = last_snapshot.get("generatedPaid", 0) + last_snapshot.get("generatedChat", 0)
        entry = {"label": label, "status": "pending", "started_at": utc_now(),
                 "generated_at_start": generated, "generator_done_at_start": last_snapshot.get("done", False)}
        report["exports"].append(entry)
        active_export = {"entry": entry, "started_clock": time.monotonic()}
        try:
            persisted = await direct_session(dashboard, session_id)
            entry["minimum_saved_at_start"] = persisted.get("eventCount", 0)
            current_source = await snapshot()
            entry["generated_at_start"] = current_source.get("generatedPaid", 0) + current_source.get("generatedChat", 0)
            entry["generator_done_at_start"] = current_source.get("done", False)
            await dashboard.locator("#csv-button").click(timeout=10000)
            if not options.background_source:
                await youtube.bring_to_front()
        except Exception as error:
            entry.update(status="failed", error=str(error)[:2000])
            active_export = None

    def downloaded(download):
        downloads.append({"download": download, "entry": active_export["entry"] if active_export else None})

    async def collect_downloads():
        nonlocal active_export
        while downloads:
            item = downloads.pop(0)
            entry = item["entry"]
            if entry is None:
                entry = {"label": "late-unmatched", "status": "pending"}
                report["exports"].append(entry)
            try:
                path = output / f"{entry['label']}.csv"
                await bounded(item["download"].save_as(str(path)), options.export_timeout_seconds)
                result = await asyncio.to_thread(audit_csv, path, paid, chat)
                entry.update(status="downloaded", completed_at=utc_now(), **result)
            except Exception as error:
                entry.update(status="failed", error=str(error)[:2000])
            if active_export and active_export["entry"] is entry:
                active_export = None
        if active_export:
            try:
                notice = dashboard.locator("#error-notice")
                error_text = (await notice.text_content(timeout=1000) or "").strip() if await notice.is_visible() else ""
            except Exception:
                error_text = ""
            if error_text or time.monotonic() - active_export["started_clock"] > options.export_timeout_seconds:
                active_export["entry"].update(status="failed", error=error_text or "No download before export timeout")
                active_export = None

    def progress():
        nonlocal max_backlog
        generated = last_snapshot.get("generatedPaid", 0) + last_snapshot.get("generatedChat", 0)
        saved = (last_session or {}).get("eventCount", 0)
        backlog = max(0, generated - saved)
        max_backlog = max(max_backlog, backlog)
        entry = {"at": utc_now(), "elapsed_seconds": round(time.monotonic() - start_clock, 2),
                 "generated_paid": last_snapshot.get("generatedPaid", 0),
                 "generated_chat": last_snapshot.get("generatedChat", 0), "saved_events": saved,
                 "generated_minus_saved": backlog, "max_generator_lateness_ms": last_snapshot.get("maxScheduleLatenessMs"),
                 "heartbeat_at": (last_session or {}).get("lastHeartbeatAt"),
                 "collector_state": (last_session or {}).get("collectorState"),
                 "reported_drops": (last_session or {}).get("reportedDroppedEvents", 0),
                 "reported_errors": (last_session or {}).get("reportedCollectorErrors", 0)}
        report["progress"].append(entry)
        report["generator"] = last_snapshot
        report["last_session"] = last_session
        write_report(report_path, report)
        print(json.dumps({"status": "progress", **entry}), flush=True)

    try:
        with tempfile.TemporaryDirectory(prefix="stream-study-stress-") as profile:
            async with async_playwright() as playwright:
                chromium = options.chromium or shutil.which("chromium") or shutil.which("chromium-browser")
                if not chromium:
                    chromium = playwright.chromium.executable_path
                report["chromium_executable"] = chromium
                ignored = ["--disable-extensions"]
                if not options.disable_background_throttling:
                    ignored += THROTTLING_OVERRIDES
                context = await bounded(playwright.chromium.launch_persistent_context(
                    profile, executable_path=chromium, headless=not options.headed,
                    args=[f"--disable-extensions-except={PROJECT}", f"--load-extension={PROJECT}", "--no-sandbox"],
                    ignore_default_args=ignored, viewport={"width": 1440, "height": 1000}, accept_downloads=True,
                ), 45)
                report["browser_version"] = context.browser.version if context.browser else "unavailable"
                context.set_default_timeout(15000)
                await context.route("https://**/*", fixture)
                await context.route("http://**/*", fixture)
                if hasattr(context, "route_web_socket"):
                    await context.route_web_socket("**/*", lambda socket: socket.close())
                context.on("page", lambda page: page.on("pageerror", lambda error: report["page_errors"].append(str(error))))
                worker = context.service_workers[0] if context.service_workers else await context.wait_for_event("serviceworker", timeout=20000)
                extension_id = worker.url.split("/")[2]
                youtube = await context.new_page()
                await youtube.goto(WATCH_URL)
                await youtube.wait_for_selector("#chatframe")
                frame = youtube.frame(url=lambda value: "/live_chat?" in value)
                if not frame:
                    raise RuntimeError("Synthetic chat iframe did not load")
                await frame.wait_for_selector("#items", state="attached")
                tab_id = await bounded(worker.evaluate("async url => (await chrome.tabs.query({url}))[0].id", WATCH_URL))
                dashboard = await context.new_page()
                dashboard.on("download", downloaded)
                await dashboard.goto(f"chrome-extension://{extension_id}/dashboard.html?tab={tab_id}")
                session = (await app_request(dashboard, {"type": "START_SESSION", "tabId": tab_id}))["session"]
                session_id = session["id"]
                # Do not start the timing workload before the real collector is attached.
                await bounded(dashboard.wait_for_function("""async sessionId => {
                  const result = await chrome.runtime.sendMessage({type:'GET_SESSION',sessionId});
                  return result.ok && result.session?.collectorState === 'watching';
                }""", arg=session_id, polling=200, timeout=20000), 22)
                await dashboard.wait_for_function("document.querySelector('#csv-button').disabled === false")
                for name, page in [("source", youtube), ("dashboard", dashboard)]:
                    try:
                        heap_clients[name] = await context.new_cdp_session(page)
                    except Exception as error:
                        report["heap_measurements"].append({"page": name, "unavailable": str(error)[:500]})
                await heaps("before-generation")
                if options.background_source:
                    await dashboard.bring_to_front()
                else:
                    await youtube.bring_to_front()
                report["source_visibility_at_start"] = await frame.evaluate("document.visibilityState")
                await frame.evaluate((PROJECT / "tests/stress_fixture.js").read_text(encoding="utf-8"))
                generator_config = {"durationSeconds": options.duration_seconds, "paidRate": options.paid_rate,
                    "chatRate": options.chat_rate, "timeScale": options.time_scale, "duplicateEvery": options.duplicate_every,
                    "domRows": options.dom_rows, "maxPerTick": options.max_per_tick,
                    "burstEverySeconds": options.burst_every_seconds, "burstFactor": options.burst_factor,
                    "messageLength": options.message_length, "sampleEvery": max(1, math.ceil(total / 2000))}
                await frame.evaluate("config => StreamStudyStress.start(config)", generator_config)
                generation_start = time.monotonic()
                next_progress = generation_start
                next_heap = generation_start + 60
                mid_started = False
                deadline = generation_start + options.duration_seconds / options.time_scale + options.generation_grace_seconds
                while True:
                    await snapshot()
                    if time.monotonic() > deadline and not last_snapshot.get("done"):
                        await frame.evaluate("StreamStudyStress.stop()")
                        await snapshot()
                        record_error("generator", "Generator exceeded planned duration plus grace period")
                        break
                    try:
                        last_session = (await app_request(dashboard, {"type": "GET_SESSION", "sessionId": session_id}, timeout=5))["session"]
                        events = (await app_request(dashboard, {"type": "GET_EVENTS", "sessionId": session_id,
                                                              "limit": options.event_window}, timeout=5))["events"]
                        acknowledged = time.time() * 1000
                        for event in events:
                            identity = event["eventId"]
                            recently_seen.setdefault(identity, acknowledged)
                            if identity in samples and identity not in observed_samples:
                                observed_samples[identity] = max(0, acknowledged - samples[identity]["generatedAtMs"])
                        while len(recently_seen) > options.event_window * 3:
                            recently_seen.pop(next(iter(recently_seen)))
                    except Exception as error:
                        record_error("capture-poll", error)
                    generated = last_snapshot.get("generatedPaid", 0) + last_snapshot.get("generatedChat", 0)
                    if not mid_started and generated > 0 and not last_snapshot.get("done") and (
                        last_snapshot.get("logicalSeconds", 0) >= options.duration_seconds / 2
                    ):
                        mid_started = True
                        await begin_export("during-capture")
                    await collect_downloads()
                    current = time.monotonic()
                    if current >= next_progress:
                        progress()
                        next_progress = current + 10
                    if current >= next_heap:
                        await heaps("during-generation")
                        next_heap = current + 60
                    if last_snapshot.get("done") or last_snapshot.get("stopped"):
                        break
                    await asyncio.sleep(options.poll_seconds)

                if not mid_started:
                    report["exports"].append({"label": "during-capture", "status": "failed",
                                              "error": "No export was triggered before generation finished; workload was too short or delayed"})
                # Let normal batches catch up before manual pause drains the final batch.
                settle_deadline = time.monotonic() + options.settle_seconds
                while time.monotonic() < settle_deadline:
                    try:
                        last_session = await direct_session(dashboard, session_id)
                        if last_session.get("eventCount", 0) >= total:
                            break
                    except Exception as error:
                        record_error("settle-read", error)
                        break
                    await collect_downloads()
                    await asyncio.sleep(min(1, options.poll_seconds))
                await collect_downloads()
                # A stuck export can leave the dashboard button busy. Reloading only
                # the dashboard resets its UI and does not stop the source collector.
                if active_export:
                    remaining = max(0, options.export_timeout_seconds - (time.monotonic() - active_export["started_clock"]))
                    expiry = time.monotonic() + remaining
                    while active_export and time.monotonic() < expiry:
                        await collect_downloads()
                        await asyncio.sleep(0.25)
                    await collect_downloads()
                try:
                    last_session = (await app_request(dashboard, {"type": "PAUSE_SESSION", "sessionId": session_id}, timeout=30))["session"]
                except Exception as error:
                    record_error("pause", error)
                    last_session = await direct_session(dashboard, session_id)
                report["storage_audit"] = await audit_database(dashboard, session_id, paid, chat)
                report["last_session"] = last_session
                await dashboard.reload()
                await dashboard.wait_for_function("document.querySelector('#csv-button').disabled === false")
                await begin_export("final")
                export_deadline = time.monotonic() + options.export_timeout_seconds + 2
                while active_export and time.monotonic() < export_deadline:
                    await collect_downloads()
                    await asyncio.sleep(0.25)
                await collect_downloads()
                if active_export:
                    active_export["entry"].update(status="failed", error="Final export timed out")
                    active_export = None
                await heaps("after-final-export")
                await snapshot()
                progress()
                await context.close()
                context = None
    except (KeyboardInterrupt, asyncio.CancelledError):
        interrupted = True
        report["errors"].append({"stage": "run", "error": "Interrupted; this is not a completed workload"})
    except Exception as error:
        record_error("run", error)
    finally:
        if context is not None:
            try:
                await bounded(context.close(), 10)
            except Exception:
                pass

    report["generator"] = last_snapshot
    report["last_session"] = last_session
    report["elapsed_total_seconds"] = round(time.monotonic() - start_clock, 3)
    report["max_generated_minus_saved_events_observed"] = max_backlog
    report["collector_pending_queue"] = "Not exposed by current session schema; generated-minus-saved backlog is reported separately."
    report["persistence_lag_get_events_ms"] = {
        **distribution(list(observed_samples.values())), "generated_sample_count": len(samples),
        "unobserved_sample_count": len(samples) - len(observed_samples),
        "sample_coverage": len(observed_samples) / len(samples) if samples else None,
        "poll_seconds": options.poll_seconds, "latest_event_window": options.event_window,
    }
    report["generator_schedule_lateness_ms"] = distribution(last_snapshot.get("scheduleLatenessSamplesMs", []))

    def check(name, passed, actual=None, expected=None):
        report["checks"].append({"name": name, "passed": bool(passed), "actual": actual, "expected": expected})

    check("generator completed full configured schedule", last_snapshot.get("done") and
          last_snapshot.get("generatedPaid") == paid and last_snapshot.get("generatedChat") == chat,
          {"paid": last_snapshot.get("generatedPaid"), "chat": last_snapshot.get("generatedChat")}, {"paid": paid, "chat": chat})
    check("generator sustained target schedule within tolerance", bool(last_snapshot) and
          last_snapshot.get("maxScheduleLatenessMs", math.inf) <= options.max_generator_lateness_ms,
          last_snapshot.get("maxScheduleLatenessMs"), options.max_generator_lateness_ms)
    check("bounded DOM", bool(last_snapshot) and last_snapshot.get("maxDomRows", math.inf) <= options.dom_rows,
          last_snapshot.get("maxDomRows"), options.dom_rows)
    audit = report.get("storage_audit", {})
    check("exact stored identities and fields", bool(audit) and audit.get("saved_rows") == total and
          not any(audit.get(key, 1) for key in ["missing_paid", "missing_chat", "extra_ids", "duplicate_ids", "invalid_records"]), audit)
    check("exact stored money total", audit.get("usd_micros") == str(paid * 1000000), audit.get("usd_micros"), str(paid * 1000000))
    stats = (last_session or {}).get("stats", {})
    check("session counters match independent audit", stats.get("chatCount") == chat and
          stats.get("paidCount") == paid and stats.get("countedPaidCount") == paid and
          stats.get("unresolvedPaidCount") == 0 and stats.get("totals", {}).get("USD", "0") == str(paid * 1000000), stats)
    check("no reported collector drops/errors", bool(last_session) and not last_session.get("reportedDroppedEvents", 0)
          and not last_session.get("reportedCollectorErrors", 0),
          {"drops": (last_session or {}).get("reportedDroppedEvents"), "errors": (last_session or {}).get("reportedCollectorErrors")})
    lag = report["persistence_lag_get_events_ms"]
    check("persistence lag samples meet coverage target", lag["sample_coverage"] is not None and
          lag["sample_coverage"] >= options.min_lag_sample_coverage,
          lag["sample_coverage"], options.min_lag_sample_coverage)
    check("sampled persistence lag meets p95 target", lag["p95"] is not None and
          lag["p95"] <= options.max_save_lag_ms, lag["p95"], options.max_save_lag_ms)
    for label in ["during-capture", "final"]:
        export = next((item for item in report["exports"] if item["label"] == label), {})
        successful = export.get("status") == "downloaded" and not any(export.get(key, 1) for key in ["duplicate_ids", "extra_ids", "invalid_records"])
        if label == "final":
            successful = successful and export.get("saved_rows") == total and export.get("usd_micros") == str(paid * 1000000)
        else:
            successful = (successful and 0 < export.get("generated_at_start", 0) < total
                          and not export.get("generator_done_at_start")
                          and 0 < export.get("minimum_saved_at_start", 0) <= export.get("saved_rows", 0) < total)
        check(f"{label} CSV export", successful, export)
    check("no browser page script errors", not report["page_errors"], report["page_errors"])
    check("no harness/runtime failures", not report["errors"], report["errors"])
    report["completed_two_hour_realtime_schedule"] = bool(options.time_scale == 1 and options.duration_seconds >= 7200 and
        last_snapshot.get("done") and last_snapshot.get("elapsedWallSeconds", 0) >= 7200 and
        last_snapshot.get("maxScheduleLatenessMs", math.inf) <= options.max_generator_lateness_ms)
    report["status"] = "interrupted" if interrupted else "passed" if all(item["passed"] for item in report["checks"]) else "failed"
    report["valid_two_hour_realtime_soak"] = report["completed_two_hour_realtime_schedule"] and report["status"] == "passed"
    report["completed_at"] = utc_now()
    write_report(report_path, report)
    print(json.dumps({"status": report["status"], "report": str(report_path), "run_kind": report["run_kind"],
                      "valid_two_hour_realtime_soak": report["valid_two_hour_realtime_soak"],
                      "storage_audit": audit, "persistence_lag_get_events_ms": report["persistence_lag_get_events_ms"]}), flush=True)
    return 0 if report["status"] == "passed" else 1


def parse_options(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--duration-seconds", type=float, default=7200)
    parser.add_argument("--paid-rate", type=float, default=10)
    parser.add_argument("--chat-rate", type=float, default=0)
    parser.add_argument("--time-scale", type=float, default=1)
    parser.add_argument("--duplicate-every", type=int, default=20, help="Duplicate every Nth paid DOM row with the same ID; 0 disables")
    parser.add_argument("--dom-rows", type=int, default=200)
    parser.add_argument("--message-length", type=int, default=200, help="ASCII characters per synthetic message (minimum 64)")
    parser.add_argument("--max-per-tick", type=int, default=500)
    parser.add_argument("--burst-every-seconds", type=float, default=0, help="Logical block length; 0 disables burst scheduling")
    parser.add_argument("--burst-factor", type=float, default=1, help="Compress each block's events into its first 1/factor duration; preserves totals")
    parser.add_argument("--poll-seconds", type=float, default=1)
    parser.add_argument("--event-window", type=int, default=200, help="Latest rows queried for lag sampling; 1–1000")
    parser.add_argument("--max-save-lag-ms", type=float, default=2000, help="Maximum allowed p95 sampled persistence lag, including polling delay")
    parser.add_argument("--min-lag-sample-coverage", type=float, default=0.95, help="Minimum fraction of generated lag samples observed as saved (0–1)")
    parser.add_argument("--max-generator-lateness-ms", type=float, default=2000)
    parser.add_argument("--generation-grace-seconds", type=float, default=120)
    parser.add_argument("--settle-seconds", type=float, default=30)
    parser.add_argument("--export-timeout-seconds", type=float, default=120)
    parser.add_argument("--chromium", default=None, help="Optional path to full Chromium; otherwise system or Playwright Chromium is selected")
    parser.add_argument("--headed", action="store_true")
    parser.add_argument("--background-source", action="store_true", help="Keep dashboard foreground and synthetic source hidden")
    parser.add_argument("--disable-background-throttling", action="store_true", help="Diagnostic only: keep Playwright's timer/background overrides")
    parser.add_argument("--output-dir", type=Path, default=PROJECT / "test-results" / ("stress-" + datetime.now().strftime("%Y%m%d-%H%M%S")))
    options = parser.parse_args(argv)
    positive = ["duration_seconds", "time_scale", "poll_seconds", "export_timeout_seconds", "max_save_lag_ms", "min_lag_sample_coverage"]
    nonnegative = ["paid_rate", "chat_rate", "burst_every_seconds", "max_generator_lateness_ms", "generation_grace_seconds", "settle_seconds"]
    for name in positive + nonnegative:
        value = getattr(options, name)
        if not math.isfinite(value) or value < 0 or (name in positive and value == 0):
            parser.error(f"--{name.replace('_', '-')} must be finite and {'positive' if name in positive else 'nonnegative'}")
    if not math.isfinite(options.burst_factor) or options.burst_factor < 1:
        parser.error("--burst-factor must be finite and >= 1")
    if options.duplicate_every < 0 or options.dom_rows < 1 or options.max_per_tick < 1 or options.message_length < 64:
        parser.error("duplicate-every must be nonnegative; dom-rows/max-per-tick positive; message-length >= 64")
    if not 1 <= options.event_window <= 1000:
        parser.error("--event-window must be between 1 and 1000")
    if options.min_lag_sample_coverage > 1:
        parser.error("--min-lag-sample-coverage must be <= 1")
    expected = math.floor(options.duration_seconds * options.paid_rate) + math.floor(options.duration_seconds * options.chat_rate)
    if expected < 1 or expected > 100_000_000:
        parser.error("Choose a workload containing 1 to 100,000,000 events")
    return options


if __name__ == "__main__":
    try:
        sys.exit(asyncio.run(run(parse_options())))
    except KeyboardInterrupt:
        sys.exit(130)
