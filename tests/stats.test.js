import test from 'node:test';
import assert from 'node:assert/strict';
import {blankStats, adjustStats, isCountable} from '../storage.js';

const paid = overrides => ({type: 'superchat', idQuality: 'youtube', amountMicros: '10000000', currency: 'USD', amountIssue: null, ...overrides});

test('totals stay exact and currencies never combine', () => {
  const stats = blankStats();
  adjustStats(stats, paid({amountMicros: '900719925474099312345'}), 1);
  adjustStats(stats, paid({amountMicros: '1'}), 1);
  adjustStats(stats, paid({type: 'supersticker', currency: 'EUR', amountMicros: '5000000'}), 1);
  assert.deepEqual(stats.totals, {USD: '900719925474099312346', EUR: '5000000'});
  assert.equal(stats.countedPaidCount, 3);
});

test('ambiguous currency and unstable identity remain unresolved', () => {
  const stats = blankStats();
  adjustStats(stats, paid({currency: null, amountIssue: 'ambiguous-currency'}), 1);
  adjustStats(stats, paid({idQuality: 'element'}), 1);
  adjustStats(stats, paid({amountMicros: null}), 1);
  assert.equal(stats.paidCount, 3);
  assert.equal(stats.unresolvedPaidCount, 3);
  assert.equal(stats.countedPaidCount, 0);
  assert.deepEqual(stats.totals, {});
});

test('hydrating an existing purchase replaces its previous contribution', () => {
  const stats = blankStats();
  const incomplete = paid({amountMicros: null, amountIssue: 'missing-amount'});
  adjustStats(stats, incomplete, 1);
  adjustStats(stats, incomplete, -1);
  adjustStats(stats, paid(), 1);
  assert.equal(stats.paidCount, 1);
  assert.equal(stats.unresolvedPaidCount, 0);
  assert.equal(stats.countedPaidCount, 1);
  assert.deepEqual(stats.totals, {USD: '10000000'});
  adjustStats(stats, paid(), -1);
  assert.deepEqual(stats.totals, {});
});

test('membership messages and gift messages never enter monetary totals', () => {
  const stats = blankStats();
  adjustStats(stats, paid({type: 'membership'}), 1);
  adjustStats(stats, paid({type: 'gift'}), 1);
  adjustStats(stats, {type: 'chat'}, 1);
  assert.equal(stats.membershipCount, 1);
  assert.equal(stats.giftCount, 1);
  assert.equal(stats.chatCount, 1);
  assert.equal(stats.paidCount, 0);
  assert.deepEqual(stats.totals, {});
});

test('invalid and nonpositive values cannot enter a confirmed total', () => {
  for (const amountMicros of ['0', '-1', '1e9', 'NaN', '', undefined]) assert.equal(isCountable(paid({amountMicros})), false);
  assert.equal(isCountable(paid({currency: '__proto__'})), false);
});
