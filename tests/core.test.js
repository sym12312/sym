import test from 'node:test';
import assert from 'node:assert/strict';
import '../core.js';

const { parseVideoId, parseAmount, formatMicros, csvEscape, toCsv } = globalThis.StreamStudyCore;

test('accepts only supported YouTube URL shapes and exact video IDs', () => {
  for (const url of [
    'https://www.youtube.com/watch?v=E1Q0kFB76VU&feature=shared',
    'https://www.youtube.com/live/E1Q0kFB76VU?is=AZrUzVZWeamJdPqa',
    'https://youtu.be/E1Q0kFB76VU?t=30',
    'https://m.youtube.com/shorts/E1Q0kFB76VU',
    'https://www.youtube.com/live_chat?v=E1Q0kFB76VU&is_popout=1',
  ]) assert.equal(parseVideoId(url), 'E1Q0kFB76VU');
  for (const url of [
    'https://youtube.com.evil.test/watch?v=E1Q0kFB76VU',
    'https://evil.test/watch?v=E1Q0kFB76VU',
    'https://www.youtube.com/watch?v=too-short',
    'https://www.youtube.com/channel/E1Q0kFB76VU',
    'https://youtu.be/E1Q0kFB76VU/extra',
    'https://name@youtube.com/watch?v=E1Q0kFB76VU',
    'javascript:alert(1)', null,
  ]) assert.equal(parseVideoId(url), null, String(url));
});

test('parses exact amounts and explicitly identified currencies', () => {
  const cases = [
    ['US$4.99', 'USD', '4990000'],
    ['CA$5.00', 'CAD', '5000000'],
    ['AU$10', 'AUD', '10000000'],
    ['A$10.50', 'AUD', '10500000'],
    ['HK$25.00', 'HKD', '25000000'],
    ['R$ 12,34', 'BRL', '12340000'],
    ['USD $5.00', 'USD', '5000000'],
    ['JPY ¥500', 'JPY', '500000000'],
    ['NT$50', 'TWD', '50000000'],
    ['€1.234,56', 'EUR', '1234560000'],
    ['USD 1,234.56', 'USD', '1234560000'],
    ['₹1,23,456.78', 'INR', '123456780000'],
    ['CHF 1\u202f234,50', 'CHF', '1234500000'],
    ["CHF 1'234.50", 'CHF', '1234500000'],
    ['GBP1.234567', 'GBP', '1234567'],
    ['1000 ₩', 'KRW', '1000000000'],
    ['Rp 1.000.000', 'IDR', '1000000000000'],
    ['5,00 zł', 'PLN', '5000000'],
    ['USD 9007199254740993.01', 'USD', '9007199254740993010000'],
  ];
  for (const [label, currency, micros] of cases) {
    assert.deepEqual(parseAmount(label), { amountMicros: micros, currency, amountIssue: null }, label);
  }
});

test('ambiguous symbols do not silently become USD, JPY, or a krona currency', () => {
  for (const label of ['$5.00', '¥500', '25 kr', '25 lei', 'Bs 25']) {
    const result = parseAmount(label);
    assert.equal(result.currency, null, label);
    assert.equal(result.amountIssue, 'ambiguous-currency', label);
    assert.notEqual(result.amountMicros, null, label);
  }
  assert.deepEqual(parseAmount('5.00'), { amountMicros: '5000000', currency: null, amountIssue: 'unknown-currency' });
});

test('refuses ambiguous separators, malformed grouping, negatives, exponents, and conflicting currency labels', () => {
  for (const label of ['USD 1,234', 'EUR 1.234']) {
    assert.equal(parseAmount(label).amountIssue, 'ambiguous-number-format', label);
    assert.equal(parseAmount(label).amountMicros, null, label);
  }
  for (const label of ['USD -5.00', 'USD 1e3', 'USD 1,2,3.45', 'USD 1,234 567.89', 'USD 1.2345678', 'ABC 5.00', 'USD NaN']) {
    assert.equal(parseAmount(label).amountMicros, null, label);
    assert.equal(parseAmount(label).amountIssue, 'invalid-amount', label);
  }
  assert.deepEqual(parseAmount('USD EUR 5.00'), { amountMicros: '5000000', currency: null, amountIssue: 'conflicting-currencies' });
  assert.deepEqual(parseAmount(''), { amountMicros: null, currency: null, amountIssue: 'missing-amount' });
});

test('only combines a currency code with compatible ambiguous symbols', () => {
  for (const [label, currency] of [
    ['USD $5', 'USD'], ['CAD $5', 'CAD'], ['AUD $5', 'AUD'], ['MXN $5', 'MXN'],
    ['JPY ¥5', 'JPY'], ['CNY ¥5', 'CNY'], ['SEK 5 kr', 'SEK'], ['ISK 5 kr', 'ISK'],
    ['RON 5 lei', 'RON'], ['MDL 5 lei', 'MDL'], ['BOB Bs 5', 'BOB'], ['VES Bs 5', 'VES'],
  ]) {
    assert.deepEqual(parseAmount(label), { amountMicros: '5000000', currency, amountIssue: null }, label);
  }
  for (const label of ['EUR $5', 'USD ¥5', 'CAD 5 kr', 'EUR 5 lei', 'USD Bs 5', '$¥5']) {
    assert.deepEqual(parseAmount(label), {
      amountMicros: '5000000', currency: null, amountIssue: 'conflicting-currencies',
    }, label);
  }
});

test('rejects oversized page labels before numeric processing', () => {
  assert.deepEqual(parseAmount('USD ' + '9'.repeat(10000)), {
    amountMicros: null, currency: null, amountIssue: 'amount-too-long',
  });
});

test('formats micros without floating point rounding', () => {
  assert.equal(formatMicros('1234567'), '1.234567');
  assert.equal(formatMicros('1000000'), '1');
  assert.equal(formatMicros('0'), '0');
  assert.equal(formatMicros('-1'), '-0.000001');
  assert.equal(formatMicros('9007199254740993010000'), '9007199254740993.01');
  assert.equal(formatMicros('not a number'), '');
});

test('CSV preserves quotes/newlines and guards against spreadsheet formulas', () => {
  assert.equal(csvEscape('Hello, "friend"\nNext line'), '"Hello, ""friend""\nNext line"');
  for (const input of ['=HYPERLINK("https://example.test")', '+1+1', '-1+1', '@SUM(A1)', '  =1+1', '\t=1+1', '\ntext']) {
    assert.ok(csvEscape(input).startsWith('"\''), JSON.stringify(input));
  }
  assert.equal(csvEscape(null), '""');
  const output = toCsv([{ eventId: 'yt:one', type: 'chat', author: '=1+1', message: 'Hi, all', observedAt: '2026-10-20T01:00:00Z' }]);
  assert.ok(output.startsWith('\uFEFF"sessionId","eventId"'));
  assert.ok(output.includes('"\'=1+1"'));
  assert.ok(output.includes('"Hi, all"'));
  assert.ok(output.endsWith('\r\n'));
});
