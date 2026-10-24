#!/usr/bin/env python3
"""Exercise the unpacked extension against a synthetic YouTube live-chat page.

Run from the project root with Python + Playwright + Chromium installed:
    python tests/browser_smoke.py

No live YouTube request is made. All requests to the synthetic YouTube origin
are fulfilled locally and all other HTTP(S) requests are blocked. This validates
the extension's wiring and counting behavior, not YouTube's current markup.
"""

from __future__ import annotations

import argparse
import json
import tempfile
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError, sync_playwright


PROJECT = Path(__file__).resolve().parents[1]
VIDEO_ID = "E1Q0kFB76VU"
OTHER_VIDEO_ID = "abcdefghijk"
WATCH_URL = f"https://www.youtube.com/watch?v={VIDEO_ID}"

CHAT_HTML = """<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Live chat — local test</title></head><body>
<yt-live-chat-renderer>
  <yt-live-chat-header-renderer>
    <yt-dropdown-menu id="view-selector"><span id="label">Live chat</span></yt-dropdown-menu>
  </yt-live-chat-header-renderer>
  <yt-live-chat-item-list-renderer>
    <div id="item-scroller"><div id="items">
      <yt-live-chat-text-message-renderer id="chat-initial">
        <span id="timestamp">12:00 PM</span><span id="author-name">Viewer</span>
        <span id="message">Initial hello <img alt="🙂"></span>
      </yt-live-chat-text-message-renderer>
      <yt-live-chat-paid-message-renderer id="paid-initial">
        <span id="timestamp">12:01 PM</span><span id="author-name">Supporter</span>
        <span id="purchase-amount">USD 5.00</span><span id="message">Good stream</span>
      </yt-live-chat-paid-message-renderer>
      <yt-live-chat-paid-sticker-renderer id="sticker-initial">
        <span id="timestamp">12:02 PM</span><span id="author-name">Sticker fan</span>
        <span id="purchase-amount">EUR 2.50</span><img id="sticker" alt="Applause">
      </yt-live-chat-paid-sticker-renderer>
      <yt-live-chat-paid-message-renderer id="paid-ambiguous">
        <span id="author-name">Unknown currency</span>
        <span id="purchase-amount">$10.00</span><span id="message">Keep going</span>
      </yt-live-chat-paid-message-renderer>
    </div></div>
  </yt-live-chat-item-list-renderer>
</yt-live-chat-renderer></body></html>"""


def route_fixture(route):
    parsed = urlparse(route.request.url)
    if parsed.hostname != "www.youtube.com":
        route.abort()
        return
    if parsed.path == "/watch":
        video_id = parse_qs(parsed.query).get("v", [VIDEO_ID])[0]
        route.fulfill(
            status=200,
            content_type="text/html",
            body=(
                "<!doctype html><html><head><title>Mock stream — Stream Study test</title>"
                "</head><body><h1>Mock stream</h1><iframe id='chatframe' "
                f"src='/live_chat?v={video_id}'></iframe></body></html>"
            ),
        )
    elif parsed.path in {"/live_chat", "/live_chat_replay"}:
        route.fulfill(status=200, content_type="text/html", body=CHAT_HTML)
    else:
        route.fulfill(status=404, body="Synthetic route not found")


def request(page, message):
    response = page.evaluate("message => chrome.runtime.sendMessage(message)", message)
    assert response and response.get("ok"), f"Request failed: {message} -> {response}"
    return response


def wait_stats(page, session_id, expected, timeout=12000):
    try:
        page.wait_for_function(
            """async ({sessionId, expected}) => {
              const response = await chrome.runtime.sendMessage({type:'GET_SESSION', sessionId});
              if (!response?.ok || !response.session) return false;
              const stats = response.session.stats;
              return Object.entries(expected).every(([key, value]) => key === 'totals'
                ? Object.entries(value).every(([currency, amount]) => stats.totals[currency] === amount)
                : stats[key] === value);
            }""",
            arg={"sessionId": session_id, "expected": expected},
            timeout=timeout,
            polling=100,
        )
    except PlaywrightTimeoutError as error:
        actual = request(page, {"type": "GET_SESSION", "sessionId": session_id})
        raise AssertionError(f"Expected stats {expected}, got session {actual}") from error


def append_row(frame, markup):
    frame.evaluate("html => document.querySelector('#items').insertAdjacentHTML('beforeend', html)", markup)


def run(chromium_path, headed=False):
    artifacts = PROJECT / "test-results"
    artifacts.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="stream-study-browser-") as profile:
        with sync_playwright() as p:
            context = p.chromium.launch_persistent_context(
                profile,
                executable_path=chromium_path,
                headless=not headed,
                args=[
                    f"--disable-extensions-except={PROJECT}",
                    f"--load-extension={PROJECT}",
                    "--no-sandbox",
                ],
                ignore_default_args=["--disable-extensions"],
                viewport={"width": 1440, "height": 1050},
                accept_downloads=True,
            )
            context.route("https://**/*", route_fixture)
            context.route("http://**/*", lambda route: route.abort())
            errors = []
            context.on("page", lambda page: page.on("pageerror", lambda error: errors.append(str(error))))
            worker = context.service_workers[0] if context.service_workers else context.wait_for_event("serviceworker")
            extension_id = worker.url.split("/")[2]
            youtube = context.new_page()
            youtube.goto(WATCH_URL)
            youtube.wait_for_selector("iframe#chatframe")
            frame = youtube.frame(url=lambda url: "/live_chat?" in url)
            assert frame, "Synthetic live-chat iframe failed to load"
            frame.wait_for_selector("yt-live-chat-paid-message-renderer")
            tab_id = worker.evaluate(
                "async url => (await chrome.tabs.query({url}))[0].id", WATCH_URL
            )
            dashboard = context.new_page()
            dashboard.goto(f"chrome-extension://{extension_id}/dashboard.html?tab={tab_id}")
            dashboard.wait_for_load_state()

            session = request(dashboard, {"type": "START_SESSION", "tabId": tab_id})["session"]
            session_id = session["id"]
            wait_stats(dashboard, session_id, {
                "chatCount": 1, "countedPaidCount": 2, "unresolvedPaidCount": 1,
                "totals": {"USD": "5000000", "EUR": "2500000"},
            })
            print("PASS initial chat, Super Chat, sticker and ambiguous currency capture")

            frame.evaluate("""() => {
                const original = document.querySelector('#paid-initial');
                original.parentNode.appendChild(original.cloneNode(true));
            }""")
            dashboard.wait_for_timeout(1600)
            wait_stats(dashboard, session_id, {
                "countedPaidCount": 2, "totals": {"USD": "5000000"},
            })
            print("PASS repeated renderer does not duplicate a purchase")

            append_row(frame, """<yt-live-chat-paid-message-renderer id="paid-hydrate">
              <span id="author-name">Late hydration</span>
              <span id="purchase-amount">USD</span><span id="message">Loading amount</span>
              </yt-live-chat-paid-message-renderer>""")
            wait_stats(dashboard, session_id, {"unresolvedPaidCount": 2})
            frame.locator("#paid-hydrate #purchase-amount").evaluate("node => node.textContent = 'USD 3.25'")
            wait_stats(dashboard, session_id, {
                "countedPaidCount": 3, "unresolvedPaidCount": 1,
                "totals": {"USD": "8250000"},
            })
            print("PASS hydrated amount corrects one existing record")

            append_row(frame, """<yt-live-chat-paid-message-renderer data-test="missing-id">
              <span id="author-name">Identity hydration</span>
              <span id="purchase-amount">USD 1.75</span><span id="message">Waiting for an ID</span>
              </yt-live-chat-paid-message-renderer>""")
            wait_stats(dashboard, session_id, {
                "countedPaidCount": 3, "unresolvedPaidCount": 2,
                "totals": {"USD": "8250000"},
            })
            frame.locator('[data-test="missing-id"]').evaluate("node => node.id = 'paid-late-id'")
            wait_stats(dashboard, session_id, {
                "countedPaidCount": 4, "unresolvedPaidCount": 1,
                "totals": {"USD": "10000000"},
            })
            hydrated = request(dashboard, {"type": "EXPORT_SESSION", "sessionId": session_id})
            assert len([e for e in hydrated["events"] if e["author"] == "Identity hydration"]) == 1
            print("PASS missing stable IDs stay uncounted until hydration replaces the provisional row")

            append_row(frame, """<yt-live-chat-text-message-renderer id="chat-formula">
              <span id="author-name">=CMD()</span><span id="message">=1+1</span>
              </yt-live-chat-text-message-renderer>""")
            wait_stats(dashboard, session_id, {"chatCount": 2})
            exported = request(dashboard, {"type": "EXPORT_SESSION", "sessionId": session_id})
            assert len([e for e in exported["events"] if e["eventId"] == "yt:paid-initial"]) == 1
            assert any("🙂" in e.get("message", "") for e in exported["events"])
            csv = dashboard.evaluate("events => StreamStudyCore.toCsv(events)", exported["events"])
            assert "'=1+1" in csv and "'=CMD()" in csv, "CSV formula-like text was not neutralized"
            print("PASS emoji preservation, export completeness and CSV formula protection")

            # More than one normal collector batch is inserted immediately before
            # pause. PAUSE_SESSION must drain pending DOM records before responding.
            # The row insertion and pause call intentionally have no intervening wait.
            drain_count = 240
            frame.evaluate("""count => {
                const fragment = document.createDocumentFragment();
                for (let index = 0; index < count; index++) {
                    const row = document.createElement('yt-live-chat-text-message-renderer');
                    row.id = `chat-pause-drain-${index}`;
                    const author = document.createElement('span');
                    author.id = 'author-name'; author.textContent = 'Before pause';
                    const message = document.createElement('span');
                    message.id = 'message'; message.textContent = `Pending row ${index}`;
                    row.append(author, message); fragment.append(row);
                }
                document.querySelector('#items').append(fragment);
            }""", drain_count)
            pause_response = request(dashboard, {"type": "PAUSE_SESSION", "sessionId": session_id})
            assert pause_response['session']['status'] == 'paused'
            drained = request(dashboard, {"type": "EXPORT_SESSION", "sessionId": session_id})
            drained_ids = [e['eventId'] for e in drained['events'] if e['eventId'].startswith('yt:chat-pause-drain-')]
            assert len(drained_ids) == drain_count and len(set(drained_ids)) == drain_count, (
                f"Pause lost or duplicated pending records: {len(drained_ids)} of {drain_count} saved"
            )
            assert drained['session']['stats']['chatCount'] == 2 + drain_count
            print("PASS manual pause drains multiple pending batches exactly once")
            append_row(frame, """<yt-live-chat-text-message-renderer id="chat-while-paused">
              <span id="author-name">Paused user</span><span id="message">While paused</span>
              </yt-live-chat-text-message-renderer>""")
            dashboard.wait_for_timeout(1600)
            paused = request(dashboard, {"type": "GET_SESSION", "sessionId": session_id})["session"]
            assert paused["status"] == "paused" and paused["stats"]["chatCount"] == 2 + drain_count
            request(dashboard, {"type": "RESUME_SESSION", "sessionId": session_id, "tabId": tab_id})
            wait_stats(dashboard, session_id, {"chatCount": 3 + drain_count})
            resumed = request(dashboard, {"type": "GET_SESSION", "sessionId": session_id})["session"]
            assert len(resumed["intervals"]) >= 2
            print("PASS pause/resume and collection intervals")

            youtube.reload()
            youtube.wait_for_selector("iframe#chatframe")
            dashboard.reload()
            dashboard.wait_for_load_state()
            wait_stats(dashboard, session_id, {
                "countedPaidCount": 4, "totals": {"USD": "10000000", "EUR": "2500000"},
            })
            print("PASS refresh persistence")

            with dashboard.expect_download() as csv_download:
                dashboard.locator('#csv-button').click()
            csv_download.value.save_as(str(artifacts / 'export.csv'))
            downloaded_csv = (artifacts / 'export.csv').read_text(encoding='utf-8-sig')
            assert "'=1+1" in downloaded_csv
            with dashboard.expect_download() as json_download:
                dashboard.locator('#json-button').click()
            json_download.value.save_as(str(artifacts / 'export.json'))
            downloaded_json = json.loads((artifacts / 'export.json').read_text(encoding='utf-8'))
            assert downloaded_json['session']['id'] == session_id
            assert downloaded_json['session']['stats']['totals']['USD'] == '10000000'
            print("PASS CSV and JSON downloads through dashboard controls")

            # A different video in the same tab must never enter this session.
            youtube.goto(f"https://www.youtube.com/watch?v={OTHER_VIDEO_ID}")
            frame = youtube.frame(url=lambda url: "/live_chat?" in url)
            assert frame
            frame.wait_for_selector("#items")
            append_row(frame, """<yt-live-chat-paid-message-renderer id="paid-wrong-video">
              <span id="author-name">Other stream</span><span id="purchase-amount">USD 999.00</span>
              <span id="message">Must not enter the first stream</span>
              </yt-live-chat-paid-message-renderer>""")
            dashboard.wait_for_timeout(1600)
            unchanged = request(dashboard, {"type": "EXPORT_SESSION", "sessionId": session_id})
            assert not any(e["eventId"] == "yt:paid-wrong-video" for e in unchanged["events"])
            assert unchanged["session"]["stats"]["totals"]["USD"] == "10000000"
            print("PASS video navigation isolation")

            replay_url = f"https://www.youtube.com/live_chat_replay?v={VIDEO_ID}"
            replay_page = context.new_page()
            replay_page.goto(replay_url)
            replay_page.wait_for_selector("#items")
            replay_tab_id = worker.evaluate(
                "async url => (await chrome.tabs.query({url}))[0].id", replay_url
            )
            replay = request(dashboard, {"type": "START_SESSION", "tabId": replay_tab_id})["session"]
            dashboard.wait_for_function(
                """async sessionId => {
                  const result = await chrome.runtime.sendMessage({type:'GET_SESSION', sessionId});
                  return result.ok && result.session.collectorState === 'replay';
                }""", arg=replay["id"], timeout=12000,
            )
            replay_state = request(dashboard, {"type": "GET_SESSION", "sessionId": replay["id"]})["session"]
            assert replay_state["eventCount"] == 0
            request(dashboard, {"type": "PAUSE_SESSION", "sessionId": replay["id"]})
            print("PASS replay is identified and not collected as live data")

            demo = request(dashboard, {"type": "CREATE_DEMO"})["session"]
            assert demo["isDemo"] and demo["id"] != session_id
            assert demo["status"] != "recording"
            print("PASS demo data is separate from captured sessions")
            dashboard.reload()
            dashboard.wait_for_function(
                "id => [...document.querySelector('#session-select').options].some(option => option.value === id)",
                arg=demo['id'],
            )
            dashboard.locator('#session-select').select_option(demo['id'])
            dashboard.wait_for_function(
                """demo => document.querySelector('#session-select').value === demo.id
                    && document.querySelector('#status-text').textContent === 'Sample data'
                    && document.querySelector('#capture-heading').textContent === demo.title
                    && document.querySelector('#event-rows').textContent.includes('Maya')""",
                arg={"id": demo['id'], "title": demo['title']},
            )
            dashboard.screenshot(path=str(artifacts / "dashboard.png"), full_page=True)
            (artifacts / "mock-session.json").write_text(json.dumps(unchanged, indent=2), encoding="utf-8")
            assert not errors, f"Page script errors: {errors}"
            context.close()
            print("PASS browser smoke suite (synthetic YouTube DOM only)")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--chromium", default="/usr/bin/chromium")
    parser.add_argument("--headed", action="store_true")
    options = parser.parse_args()
    run(options.chromium, options.headed)
