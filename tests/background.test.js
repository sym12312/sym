import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {blankStats, updateCaptureMode} from '../storage.js';

// This harness executes the production message listener. Storage and browser
// boundaries are explicit fakes; it does not claim to exercise IndexedDB or DOM.
const coreSource = readFileSync(new URL('../core.js', import.meta.url), 'utf8');
const workerSource = readFileSync(new URL('../background.js', import.meta.url), 'utf8')
  .replace(/^import .+;\n/gm, '');
const VIDEO = 'E1Q0kFB76VU';
const OTHER = 'abcdefghijk';
const TAB = 7;
const ID = 'test-session';
const clone = value => value === undefined ? undefined : structuredClone(value);
const collector = (path = '/live_chat_replay', video = VIDEO) => ({
  id: 'test-extension', tab: {id: TAB}, url: `https://www.youtube.com${path}?v=${video}`,
});
const dashboard = {id: 'test-extension', url: 'chrome-extension://test-extension/dashboard.html?tab=7'};
const rawEvent = overrides => ({
  eventId: 'yt:paid', idQuality: 'youtube', type: 'superchat', author: 'Viewer', message: 'Thank you',
  displayTimestamp: '1:02:03', observedAt: '2026-10-24T12:00:00.000Z', purchaseText: 'USD 5.00',
  currency: 'USD', amountMicros: '5000000', amountIssue: null, captureOrigin: 'live',
  captureMode: 'live', replayOffsetSeconds: 99999, ...overrides,
});

function harness({drain = null, tabUrl = `https://www.youtube.com/watch?v=${VIDEO}`} = {}) {
  let session = {
    id: ID, videoId: VIDEO, tabId: TAB, status: 'recording', isDemo: false, captureMode: 'unknown',
    startedAt: '2026-10-24T12:00:00.000Z', updatedAt: '2026-10-24T12:00:00.000Z',
    lastHeartbeatAt: null, chatMode: 'unknown', collectorState: 'waiting',
    intervals: [{start: '2026-10-24T12:00:00.000Z', end: null}], gaps: [], eventCount: 0, stats: blankStats(),
  };
  let listener;
  const batches = [];
  const sent = [];
  const noListener = {addListener() {}};
  const bindings = {[`tab:${TAB}`]: ID};
  const context = vm.createContext({
    URL, Date, Math, Number, Promise, crypto: globalThis.crypto, setTimeout, clearTimeout,
    blankStats, updateCaptureMode,
    getSession: async id => id === ID ? clone(session) : undefined,
    listSessions: async () => [clone(session)],
    putSession: async value => { session = clone(value); return clone(session); },
    ingestEvents: async (sessionId, events) => {
      assert.equal(sessionId, ID);
      batches.push(clone(events));
      session.eventCount += events.length;
      for (const event of events) updateCaptureMode(session, event.captureMode);
      return {added: events.length, session: clone(session)};
    },
    readEvents: async () => batches.flat(),
    deleteSession: async () => {},
    chrome: {
      runtime: {
        id: 'test-extension', getURL: path => `chrome-extension://test-extension/${path}`,
        onMessage: {addListener(callback) { listener = callback; }},
        onStartup: noListener, onInstalled: noListener,
      },
      storage: {local: {
        get: async key => key === null ? clone(bindings) : {[key]: bindings[key]},
        set: async value => Object.assign(bindings, clone(value)),
        remove: async keys => { for (const key of [].concat(keys)) delete bindings[key]; },
      }},
      tabs: {
        get: async tabId => { assert.equal(tabId, TAB); return {id: TAB, url: tabUrl, title: 'Test stream'}; },
        sendMessage: async (tabId, message) => {
          sent.push({tabId, message: clone(message)});
          return message.type === 'COLLECTOR_DRAIN' ? clone(drain) : {ok: true};
        },
        create: async () => {}, onRemoved: noListener, onUpdated: noListener,
      },
      action: {setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, onClicked: noListener},
    },
  });
  vm.runInContext(coreSource, context, {filename: 'core.js'});
  vm.runInContext(workerSource, context, {filename: 'background.js'});
  return {
    batches, sent,
    session: () => clone(session),
    request: (message, sender = collector()) => new Promise(resolve => {
      assert.equal(listener(message, sender, response => resolve(clone(response))), true);
    }),
  };
}

test('replay ingestion derives source and timeline from frame path and rendered timestamp', async () => {
  const worker = harness();
  const response = await worker.request({type: 'INGEST', sessionId: ID, events: [rawEvent()]});
  assert.deepEqual(response, {ok: true, accepted: true, added: 1});
  assert.equal(worker.batches[0][0].captureMode, 'replay');
  assert.equal(worker.batches[0][0].captureOrigin, 'replay');
  assert.equal(worker.batches[0][0].replayOffsetSeconds, 3723);
  assert.equal(worker.batches[0][0].observedAt, '2026-10-24T12:00:00.000Z');
  const offsets = ['0:00', '-0:05', '12:07 PM', '', '1:99'];
  await worker.request({type: 'INGEST', sessionId: ID,
    events: offsets.map((displayTimestamp, i) => rawEvent({eventId: `yt:${i}`, displayTimestamp, captureOrigin: 'initial'}))});
  assert.deepEqual(worker.batches[1].map(event => event.replayOffsetSeconds), [0, -5, null, null, null]);
  assert.ok(worker.batches[1].every(event => event.captureOrigin === 'initial'));
});

test('live ingestion ignores claimed replay source and offset', async () => {
  const worker = harness();
  const response = await worker.request({type: 'INGEST', sessionId: ID,
    events: [rawEvent({captureMode: 'replay', captureOrigin: 'replay', replayOffsetSeconds: 100})]}, collector('/live_chat'));
  assert.equal(response.accepted, true);
  assert.equal(worker.batches[0][0].captureMode, 'live');
  assert.equal(worker.batches[0][0].captureOrigin, 'live');
  assert.equal(worker.batches[0][0].replayOffsetSeconds, null);
});

test('collector messages reject watch, foreign, wrong-tab and wrong-video frames', async () => {
  const worker = harness();
  const senders = [
    collector('/watch'),
    {...collector(), url: `https://example.test/live_chat_replay?v=${VIDEO}`},
    {...collector(), tab: {id: 8}},
    collector('/live_chat_replay', OTHER),
    collector('/live_chat', OTHER),
    collector('/live_chat_replay/', OTHER),
  ];
  for (const sender of senders) {
    const ingested = await worker.request({type: 'INGEST', sessionId: ID, events: [rawEvent()]}, sender);
    assert.equal(ingested.accepted, false, sender.url);
    const hello = await worker.request({type: 'COLLECTOR_HELLO'}, sender);
    assert.equal(hello.session, null, sender.url);
  }
  assert.equal(worker.batches.length, 0);
});

test('a navigated main tab cannot ingest from a lingering replay frame', async () => {
  const worker = harness({tabUrl: `https://www.youtube.com/watch?v=${OTHER}`});
  const response = await worker.request({type: 'INGEST', sessionId: ID, events: [rawEvent()]});
  assert.equal(response.accepted, false);
  assert.equal(worker.batches.length, 0);
});

test('replay heartbeat indicates active capture and does not record a disabled-capture gap', async () => {
  const worker = harness();
  const response = await worker.request({type: 'HEARTBEAT', sessionId: ID,
    chatMode: 'Live chat replay', isReplay: false, chatPresent: true, pageVisibility: 'visible'});
  assert.equal(response.accepted, true);
  const session = worker.session();
  assert.equal(session.collectorState, 'replay');
  assert.equal(session.captureMode, 'replay');
  assert.equal(session.chatMode, 'Live chat replay');
  assert.equal(session.gaps.length, 0);
  assert.ok(Number.isFinite(Date.parse(session.lastHeartbeatAt)));
  await worker.request({type: 'HEARTBEAT', sessionId: ID, isReplay: true, chatPresent: true}, collector('/live_chat'));
  assert.equal(worker.session().collectorState, 'watching');
  assert.equal(worker.session().captureMode, 'mixed');
});

test('missing replay chat panel produces a missing-panel state and coverage gap', async () => {
  const worker = harness();
  await worker.request({type: 'HEARTBEAT', sessionId: ID, chatPresent: false});
  const session = worker.session();
  assert.equal(session.collectorState, 'chat-missing');
  assert.equal(session.captureMode, 'replay');
  assert.equal(session.gaps.length, 1);
  assert.equal(session.gaps[0].reason, 'Chat replay panel is not available');
});

test('manual pause drains replay records with original timeline before pausing', async () => {
  const worker = harness({drain: {ok: true, sessionId: ID, captureMode: 'replay', events: [rawEvent()], droppedEvents: 0}});
  const response = await worker.request({type: 'PAUSE_SESSION', sessionId: ID}, dashboard);
  assert.equal(response.ok, true);
  assert.equal(response.session.status, 'paused');
  assert.equal(response.session.captureMode, 'replay');
  assert.equal(response.session.eventCount, 1);
  assert.ok(response.session.intervals[0].end);
  assert.equal(worker.batches[0][0].captureMode, 'replay');
  assert.equal(worker.batches[0][0].replayOffsetSeconds, 3723);
  assert.equal(worker.sent[0].message.type, 'COLLECTOR_DRAIN');
  const rejected = await worker.request({type: 'INGEST', sessionId: ID, events: [rawEvent()]});
  assert.equal(rejected.accepted, false);
  assert.equal(worker.batches.length, 1);
});
