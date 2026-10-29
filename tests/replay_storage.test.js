import test from 'node:test';
import assert from 'node:assert/strict';
import {mergeObservedEvent, updateCaptureMode, blankStats, adjustStats} from '../storage.js';

const recorded = {
  eventId: 'yt:purchase', idQuality: 'youtube', type: 'superchat',
  observedAt: '2026-10-24T12:00:00.000Z', captureOrigin: 'initial',
  captureMode: 'replay', replayOffsetSeconds: 3723, displayTimestamp: '1:02:03',
  purchaseText: 'USD 5.00', currency: 'USD', amountMicros: '5000000', amountIssue: null,
};
const later = '2026-10-24T13:00:00.000Z';

test('rewound stable records retain first observation and replace their monetary contribution', () => {
  const stats = blankStats();
  adjustStats(stats, recorded, 1);
  const merged = mergeObservedEvent({...recorded, observedAt: later, captureOrigin: 'replay'}, recorded);
  adjustStats(stats, recorded, -1);
  adjustStats(stats, merged, 1);
  assert.equal(stats.countedPaidCount, 1);
  assert.deepEqual(stats.totals, {USD: '5000000'});
  assert.equal(merged.observedAt, recorded.observedAt);
  assert.equal(merged.lastSeenAt, later);
  assert.equal(merged.captureOrigin, 'initial');
  assert.equal(merged.replayOffsetSeconds, 3723);
});

test('temporarily blank replay rows retain known timestamp and purchase data', () => {
  const merged = mergeObservedEvent({...recorded, observedAt: later,
    replayOffsetSeconds: null, displayTimestamp: '', purchaseText: '',
    currency: null, amountMicros: null, amountIssue: 'missing-amount'}, recorded);
  assert.equal(merged.replayOffsetSeconds, 3723);
  assert.equal(merged.displayTimestamp, '1:02:03');
  assert.equal(merged.purchaseText, 'USD 5.00');
  assert.equal(merged.amountMicros, '5000000');
  assert.equal(merged.amountIssue, null);
});

test('replay can add a timeline to a legacy live record without resetting observation time', () => {
  const legacy = {...recorded, captureOrigin: 'live', displayTimestamp: '12:00 PM'};
  delete legacy.captureMode;
  delete legacy.replayOffsetSeconds;
  const merged = mergeObservedEvent({...recorded, observedAt: later}, legacy);
  assert.equal(merged.observedAt, legacy.observedAt);
  assert.equal(merged.captureOrigin, 'live');
  assert.equal(merged.captureMode, 'replay');
  assert.equal(merged.replayOffsetSeconds, 3723);
  const liveAgain = mergeObservedEvent({...recorded, captureMode: 'live',
    replayOffsetSeconds: null, displayTimestamp: '12:00 PM', observedAt: later}, merged);
  assert.equal(liveAgain.captureMode, 'replay');
  assert.equal(liveAgain.replayOffsetSeconds, 3723);
  assert.equal(liveAgain.displayTimestamp, '1:02:03');
});

test('missing replay offsets remain missing and a later zero offset is retained', () => {
  const unknown = {...recorded, replayOffsetSeconds: null, displayTimestamp: 'unknown'};
  const merged = mergeObservedEvent({...unknown, observedAt: later}, unknown);
  assert.equal(merged.replayOffsetSeconds, null);
  const zero = mergeObservedEvent({...recorded, replayOffsetSeconds: 0, displayTimestamp: '0:00'}, unknown);
  assert.equal(zero.replayOffsetSeconds, 0);
  assert.equal(zero.displayTimestamp, '0:00');
  const cleared = mergeObservedEvent({...unknown, displayTimestamp: ''}, zero);
  assert.equal(cleared.replayOffsetSeconds, 0);
});

test('session source modes accumulate and preserve legacy live provenance', () => {
  const fresh = {captureMode: 'unknown', eventCount: 0};
  updateCaptureMode(fresh, 'replay');
  assert.equal(fresh.captureMode, 'replay');
  updateCaptureMode(fresh, 'replay');
  assert.equal(fresh.captureMode, 'replay');
  updateCaptureMode(fresh, 'live');
  assert.equal(fresh.captureMode, 'mixed');
  updateCaptureMode(fresh, 'replay');
  assert.equal(fresh.captureMode, 'mixed');
  const legacy = {eventCount: 1};
  updateCaptureMode(legacy, 'replay');
  assert.equal(legacy.captureMode, 'mixed');
  const empty = {eventCount: 0};
  updateCaptureMode(empty, 'replay');
  assert.equal(empty.captureMode, 'replay');
  updateCaptureMode(empty, 'garbage');
  assert.equal(empty.captureMode, 'replay');
});
