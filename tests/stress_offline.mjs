#!/usr/bin/env node
/**
 * Offline helper/serialization benchmark. It does NOT run the extension or ingestEvents.
 * Default: node --expose-gc tests/stress_offline.mjs
 * Emoji:  node --expose-gc tests/stress_offline.mjs --message-style emoji --output test-results/stress-offline-emoji.json
 * Full mixed (large memory use): add --chat-rate 100, or --full-mixed.
 */
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {readFile, mkdir, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import '../core.js';
import {blankStats, adjustStats} from '../storage.js';
import {SESSION_ID, START_MS, CSV_COLUMNS, makeEvent, scanCsv, expectedCsvCell} from './stress_workload.mjs';

const core = globalThis.StreamStudyCore;
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const options = {paidRate: 10, durationSeconds: 7200, chatRate: 0, messageLength: 200,
  messageStyle: 'mixed', maxEvents: 1000000, output: 'test-results/stress-offline.json'};
const flags = {'--paid-rate': 'paidRate', '--duration-seconds': 'durationSeconds', '--chat-rate': 'chatRate',
  '--message-length': 'messageLength', '--message-style': 'messageStyle', '--max-events': 'maxEvents', '--output': 'output'};
let fullMixed = false;
for (let i = 2; i < process.argv.length; i += 1) {
  const [flag, inline] = process.argv[i].split(/=(.*)/s);
  if (flag === '--full-mixed') { fullMixed = true; continue; }
  if (flag === '--help') {
    console.log('Offline Stream Study benchmark\n' +
      '--paid-rate 10 --duration-seconds 7200 --chat-rate 0 --message-length 200\n' +
      '--message-style mixed|emoji --max-events 1000000 --output test-results/stress-offline.json\n' +
      '--full-mixed sets ordinary chat rate to 100/sec unless --chat-rate was specified.\n' +
      'Generates the entire requested workload; default reports a labeled mixed-chat size projection.\n' +
      'This is not an IndexedDB, browser messaging, DOM capture, or real-time soak test.');
    process.exit(0);
  }
  if (!flags[flag]) throw new Error(`Unknown argument: ${flag}`);
  const value = inline === undefined ? process.argv[++i] : inline;
  if (value === undefined) throw new Error(`Missing value for ${flag}`);
  const key = flags[flag];
  options[key] = ['messageStyle', 'output'].includes(key) ? value : Number(value);
}
if (fullMixed && !process.argv.some(arg => arg === '--chat-rate' || arg.startsWith('--chat-rate='))) options.chatRate = 100;
for (const key of ['paidRate', 'durationSeconds', 'chatRate', 'messageLength', 'maxEvents']) {
  assert(Number.isSafeInteger(options[key]) && options[key] >= 0, `${key} must be a nonnegative safe integer`);
}
assert(options.durationSeconds > 0 && options.messageLength > 0 && options.messageLength <= 10000);
assert(['mixed', 'emoji'].includes(options.messageStyle), 'message-style must be mixed or emoji');
const paidCount = options.paidRate * options.durationSeconds;
const chatCount = options.chatRate * options.durationSeconds;
const eventCount = paidCount + chatCount;
assert(Number.isSafeInteger(eventCount) && eventCount > 0 && eventCount <= options.maxEvents,
  `Requested ${eventCount} rows; increase --max-events explicitly if intended`);
const expectedMicros = (BigInt(paidCount) * 1000000n).toString();
const phases = {}, memorySamples = [];
const runStart = performance.now();
const bytes = text => Buffer.byteLength(text, 'utf8');
const rounded = value => Math.round(value * 1000) / 1000;
const hash = text => createHash('sha256').update(text).digest('hex');

function memory(label) {
  const usage = process.memoryUsage();
  const sample = {label, elapsedMs: rounded(performance.now() - runStart), rssBytes: usage.rss,
    heapUsedBytes: usage.heapUsed, heapTotalBytes: usage.heapTotal, externalBytes: usage.external,
    processPeakRssBytes: process.resourceUsage().maxRSS * (process.platform === 'darwin' ? 1 : 1024)};
  memorySamples.push(sample);
  return sample;
}
function gc() { if (typeof global.gc === 'function') global.gc(); }
function phase(name, action) {
  const start = performance.now();
  const result = action();
  phases[name] = {durationMs: rounded(performance.now() - start)};
  memory(`after ${name}`);
  return result;
}

// A reference replay model only. It calls production adjustStats, but is NOT
// storage.ingestEvents and does not exercise transactions, cursors, or IndexedDB.
function referenceStore() {
  const events = new Map(), stats = blankStats();
  let deliveries = 0;
  function upsert(raw) {
    deliveries += 1;
    const event = {...raw, sessionId: SESSION_ID};
    if (event.supersedesEventId && event.supersedesEventId !== event.eventId) {
      const provisional = events.get(event.supersedesEventId);
      if (provisional?.idQuality === 'element') {
        adjustStats(stats, provisional, -1);
        events.delete(event.supersedesEventId);
      }
    }
    delete event.supersedesEventId;
    const prior = events.get(event.eventId);
    if (prior) {
      event.observedAt = prior.observedAt;
      event.captureOrigin = prior.captureOrigin;
      event.lastSeenAt = raw.observedAt;
      if (!event.purchaseText && prior.purchaseText) {
        for (const key of ['purchaseText', 'currency', 'amountMicros', 'amountIssue']) event[key] = prior[key];
      }
      adjustStats(stats, prior, -1);
    }
    adjustStats(stats, event, 1);
    events.set(event.eventId, event);
  }
  return {events, stats, upsert, get deliveries() { return deliveries; }};
}

function checkIdentityCases() {
  const store = referenceStore();
  const paid = makeEvent(0, 'superchat', 10, 200, 'mixed', core.parseAmount);
  const partial = {...paid, purchaseText: '', currency: null, amountMicros: null, amountIssue: 'missing-amount'};
  store.upsert(partial);
  assert.equal(store.stats.unresolvedPaidCount, 1);
  store.upsert({...paid, observedAt: new Date(START_MS + 1000).toISOString(), captureOrigin: 'initial'});
  assert.equal(store.events.size, 1);
  assert.equal(store.stats.paidCount, 1);
  assert.equal(store.stats.countedPaidCount, 1);
  assert.equal(store.stats.unresolvedPaidCount, 0);
  assert.equal(store.stats.totals.USD, '1000000');
  assert.equal(store.events.get(paid.eventId).observedAt, paid.observedAt);
  assert.equal(store.events.get(paid.eventId).captureOrigin, 'live');
  assert.equal(store.events.get(paid.eventId).lastSeenAt, new Date(START_MS + 1000).toISOString());
  store.upsert(partial); // blank re-render must retain a complete purchase
  assert.equal(store.stats.totals.USD, '1000000');
  const snapshot = JSON.stringify(store.stats);
  for (let i = 0; i < 100; i += 1) store.upsert(paid);
  assert.equal(JSON.stringify(store.stats), snapshot);
  assert.equal(store.events.size, 1);
  const replacement = referenceStore();
  replacement.upsert({...paid, eventId: 'element:provisional', idQuality: 'element'});
  assert.equal(replacement.stats.unresolvedPaidCount, 1);
  replacement.upsert({...paid, supersedesEventId: 'element:provisional'});
  replacement.upsert({...paid, supersedesEventId: 'element:provisional'});
  assert.equal(replacement.events.size, 1);
  assert.equal(replacement.stats.countedPaidCount, 1);
  assert.equal(replacement.stats.unresolvedPaidCount, 0);
  assert.equal(replacement.stats.totals.USD, '1000000');
  return {passed: true, duplicateReplays: 100, hydration: true, blankRerender: true,
    provisionalIdReplacement: true, firstObservationPreserved: true};
}

function validateCsv(csv, events) {
  const uniqueIds = new Set();
  const count = scanCsv(csv, (row, index) => {
    assert.equal(row.length, CSV_COLUMNS.length, `CSV column count at record ${index}`);
    if (index === 0) { assert.deepEqual(row, CSV_COLUMNS); return; }
    const expected = events[index - 1];
    assert(expected, `Unexpected CSV record ${index}`);
    for (let col = 0; col < CSV_COLUMNS.length; col += 1) {
      assert.equal(row[col], expectedCsvCell(expected[CSV_COLUMNS[col]]), `CSV cell ${index}:${CSV_COLUMNS[col]}`);
    }
    assert(!uniqueIds.has(row[1]), `Duplicate ID in CSV ${row[1]}`);
    uniqueIds.add(row[1]);
  });
  assert.equal(count, events.length + 1);
  assert.equal(uniqueIds.size, events.length);
  return {passed: true, recordsIncludingHeader: count, dataRecords: uniqueIds.size, columns: CSV_COLUMNS.length,
    validator: 'Independent strict CSV state machine; all cells and unique IDs checked'};
}

gc();
const baseline = memory('baseline after optional GC');
const identityChecks = phase('referenceIdentityChecks', checkIdentityCases);
const parserChecks = phase('parseAmount', () => {
  let sum = 0n;
  for (let i = 0; i < paidCount; i += 1) {
    const parsed = core.parseAmount('USD 1.00');
    assert.equal(parsed.currency, 'USD');
    assert.equal(parsed.amountIssue, null);
    sum += BigInt(parsed.amountMicros);
  }
  assert.equal(sum.toString(), expectedMicros);
  return {calls: paidCount, totalMicros: sum.toString()};
});
phases.parseAmount.callsPerSecond = rounded(paidCount / (phases.parseAmount.durationMs / 1000));
phases.parseAmount.note = 'Includes per-result assertions and checksum; accelerated Node helper execution, not browser capture throughput';

const store = referenceStore();
let hydratedDeliveries = 0, duplicateDeliveries = 0;
phase('generateAndReferenceReplay', () => {
  for (const [type, count, rate] of [['superchat', paidCount, options.paidRate], ['chat', chatCount, options.chatRate]]) {
    for (let i = 0; i < count; i += 1) {
      const event = makeEvent(i, type, rate, options.messageLength, options.messageStyle, core.parseAmount);
      if (type === 'superchat' && i % 17 === 0) {
        store.upsert({...event, purchaseText: '', currency: null, amountMicros: null, amountIssue: 'missing-amount'});
        hydratedDeliveries += 1;
      }
      store.upsert(event);
      if (i % 10 === 0) { store.upsert(event); duplicateDeliveries += 1; }
    }
  }
});
assert.equal(store.events.size, eventCount);
assert.equal(store.stats.paidCount, paidCount);
assert.equal(store.stats.countedPaidCount, paidCount);
assert.equal(store.stats.unresolvedPaidCount, 0);
assert.equal(store.stats.chatCount, chatCount);
assert.equal(store.stats.totals.USD || '0', expectedMicros);
const events = phase('materializeOrderedEvents', () => [...store.events.values()]
  .sort((a, b) => a.observedAt.localeCompare(b.observedAt) || a.eventId.localeCompare(b.eventId)));
const end = new Date(START_MS + options.durationSeconds * 1000).toISOString();
const session = {id: SESSION_ID, videoId: 'stress00001', tabId: 42,
  title: 'Synthetic offline volume benchmark', url: 'https://www.youtube.com/watch?v=stress00001',
  status: 'paused', isDemo: true, startedAt: new Date(START_MS).toISOString(), updatedAt: end,
  lastHeartbeatAt: end, chatMode: 'Synthetic data', collectorState: 'paused',
  intervals: [{start: new Date(START_MS).toISOString(), end}], gaps: [], eventCount, stats: store.stats};

let runtimeJson = phase('runtimeResponseJsonSerialize', () => JSON.stringify({ok: true, session, events}));
const runtimeJsonBytes = bytes(runtimeJson);
const runtimeHash = hash(runtimeJson);
runtimeJson = null;
gc(); memory('runtime JSON released; event Map and array retained');

let csv = phase('csvSerialize', () => core.toCsv(events));
const csvBytes = bytes(csv), csvHash = hash(csv);
const csvValidation = phase('csvValidateAllCells', () => validateCsv(csv, events));
csv = null;
gc(); memory('CSV released; event Map and array retained');

let downloadJson = phase('jsonDownloadSerialize', () => JSON.stringify({schemaVersion: 1, exportedAt: end, session, events}, null, 2));
const downloadJsonBytes = bytes(downloadJson), downloadHash = hash(downloadJson);
downloadJson = null;
gc(); memory('JSON download released; event Map and array retained');

// Always exercise quote/newline/Unicode/formula cases, even in --message-style emoji runs.
const edgeEvents = Array.from({length: 8}, (_, i) => makeEvent(i, 'superchat', 10, 200, 'mixed', core.parseAmount));
const edgeCsvChecks = validateCsv(core.toCsv(edgeEvents), edgeEvents);

const mixedProjection = phase('mixedChatSizeProjection', () => {
  const projectionChatRate = 100;
  const projectedChatCount = projectionChatRate * options.durationSeconds;
  const samples = Array.from({length: 400}, (_, i) => {
    const event = makeEvent(i, 'chat', projectionChatRate, options.messageLength, options.messageStyle, core.parseAmount);
    if (i % 10 === 0) event.lastSeenAt = event.observedAt;
    return event;
  });
  const sampleJsonBytes = samples.reduce((total, event) => total + bytes(JSON.stringify(event)), 0);
  const headerBytes = bytes(core.toCsv([]));
  const sampleCsvDataBytes = bytes(core.toCsv(samples)) - headerBytes;
  const perChatJsonBytes = sampleJsonBytes / samples.length;
  const perChatCsvBytes = sampleCsvDataBytes / samples.length;
  const extraRows = Math.max(0, projectedChatCount - chatCount);
  return {
    measurement: 'ESTIMATE: representative ordinary-message serialization; no additional full mixed array or payload allocated',
    chatRatePerSecond: projectionChatRate, paidRows: paidCount, ordinaryRows: projectedChatCount,
    combinedRows: paidCount + projectedChatCount, sampleRows: samples.length,
    estimatedExtraOrdinaryRowsBeyondActualRun: extraRows,
    averageOrdinaryJsonRecordUtf8Bytes: perChatJsonBytes, averageOrdinaryCsvRecordUtf8Bytes: perChatCsvBytes,
    estimatedRuntimeResponseUtf8Bytes: Math.round(runtimeJsonBytes + extraRows * (perChatJsonBytes + 1)),
    estimatedCsvUtf8Bytes: Math.round(csvBytes + extraRows * perChatCsvBytes),
    assumptions: 'Same event schema, fixed-width IDs, cyclic text mix and 10% duplicate-delivery lastSeenAt fields. Projection does not adjust small session-summary digit changes or model browser/IndexedDB memory. If actual chat rate exceeds100/sec, size remains the actual larger run.',
  };
});

const messageSample = events.slice(0, Math.min(400, events.length)).map(event => ({
  codePoints: Array.from(event.message).length, utf16CodeUnits: event.message.length, utf8Bytes: bytes(event.message),
}));
assert(messageSample.every(value => value.codePoints === options.messageLength));
const report = {
  kind: 'offline-helper-and-serialization-benchmark', generatedAt: new Date().toISOString(),
  status: 'passed', nodeVersion: process.version, platform: process.platform, arch: process.arch,
  workload: {...options, output: undefined, paidRows: paidCount, ordinaryRows: chatCount, totalUniqueRows: eventCount,
    simulatedDurationSeconds: options.durationSeconds, elapsedWallTimeMs: rounded(performance.now() - runStart),
    messageLengthUnit: 'Unicode code points', messageUtf8BytesSample: {
      rows: messageSample.length, min: Math.min(...messageSample.map(row => row.utf8Bytes)),
      max: Math.max(...messageSample.map(row => row.utf8Bytes)),
      average: rounded(messageSample.reduce((sum, row) => sum + row.utf8Bytes, 0) / messageSample.length),
      utf16CodeUnitsMin: Math.min(...messageSample.map(row => row.utf16CodeUnits)),
      utf16CodeUnitsMax: Math.max(...messageSample.map(row => row.utf16CodeUnits)),
    }, replayDeliveries: store.deliveries, duplicateDeliveries, incompleteBeforeHydrationDeliveries: hydratedDeliveries},
  expected: {paidCount, countedPaidCount: paidCount, unresolvedPaidCount: 0, chatCount, usdMicros: expectedMicros},
  actual: {uniqueIds: store.events.size, stats: store.stats},
  checks: {identityCases: identityChecks, parser: parserChecks, csv: csvValidation, csvSpecialCharacters: edgeCsvChecks},
  exports: {
    runtimeResponse: {shape: '{ok:true,session,events}', utf8Bytes: runtimeJsonBytes, sha256: runtimeHash,
      wholeStringMaterialized: true, sentThroughChromeRuntime: false},
    csv: {utf8Bytes: csvBytes, sha256: csvHash, wholeStringMaterialized: true, fullIndependentParsePassed: true},
    jsonDownload: {shape: '{schemaVersion:1,exportedAt,session,events}, pretty printed with2spaces',
      utf8Bytes: downloadJsonBytes, sha256: downloadHash, wholeStringMaterialized: true},
  },
  mixedChatProjection: mixedProjection,
  phases,
  memory: {explicitGcAvailable: typeof global.gc === 'function', baseline,
    processPeakRssBytes: process.resourceUsage().maxRSS * (process.platform === 'darwin' ? 1 : 1024),
    peakRssMinusBaselineRssBytes: process.resourceUsage().maxRSS * (process.platform === 'darwin' ? 1 : 1024) - baseline.rssBytes,
    largestObservedHeapUsedBytes: Math.max(...memorySamples.map(sample => sample.heapUsedBytes)),
    note: 'Endpoint heap samples are not a true peak heap measurement. OS process-lifetime peak RSS includes Node and all benchmark phases. Each export string is released before the next export; event Map and array remain retained.',
    samples: memorySamples},
  productionSourceSha256: {
    core: hash(await readFile(resolve(ROOT, 'core.js'))),
    storage: hash(await readFile(resolve(ROOT, 'storage.js'))),
  },
  limitations: [
    'Runs production parseAmount, adjustStats, toCsv and native JSON.stringify in Node; does not call storage.ingestEvents.',
    'Duplicate/hydration checks use an explicitly labeled reference Map model, not IndexedDB.',
    'No real YouTube page, DOM collector, Chrome runtime transport, service-worker lifecycle, disk quota, or dashboard rendering was exercised.',
    'Accelerated generation representing two hours is not a two-hour real-time soak and does not establish live capture throughput.',
    'Mixed-chat projection is an estimate unless the full ordinary-message workload was explicitly generated with --chat-rate100.',
    'UTF8 byte counts do not establish whether a browser can send that message; browser IPC limits and memory behavior require browser testing.',
  ],
};
const output = resolve(ROOT, options.output);
await mkdir(dirname(output), {recursive: true});
await writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({status: report.status, report: output, paidRows: paidCount, ordinaryRows: chatCount,
  usdMicros: store.stats.totals.USD || '0', csvBytes, runtimeJsonBytes, downloadJsonBytes,
  parserCallsPerSecond: phases.parseAmount.callsPerSecond, csvSerializeMs: phases.csvSerialize.durationMs,
  peakRssBytes: report.memory.processPeakRssBytes, elapsedMs: report.workload.elapsedWallTimeMs}, null, 2));
