// Synthetic deterministic data only. These helpers never touch IndexedDB or a browser.
export const SESSION_ID = '00000000-0000-4000-8000-000000000001';
export const START_MS = Date.parse('2026-01-01T00:00:00.000Z');
export const CSV_COLUMNS = ['sessionId', 'eventId', 'idQuality', 'type', 'author', 'message',
  'displayTimestamp', 'observedAt', 'purchaseText', 'currency', 'amountMicros', 'amountIssue', 'captureOrigin',
  'captureMode', 'replayOffsetSeconds'];

const TEMPLATES = [
  'Thanks for explaining your process. This is a useful session for taking research notes. ',
  'A "quoted" remark, with commas, asks for another example of the lighting setup. ',
  'First line of a viewer question\nSecond line keeps its own line break. ',
  'café 日本語 👋 — Thank you for explaining that clearly. ',
  '=1+1 is a literal chat message that needs spreadsheet formula protection. ',
  '\t=SUM(1,2) is another literal viewer message, starting with a tab. ',
  '@SUM(1,2) is text from a viewer, not an instruction to a spreadsheet. ',
  '+SUM(1,2) asks about the setup; this text must be exported literally. ',
];

export function makeMessage(index, length = 200, style = 'mixed') {
  const suffix = ` #${String(index).padStart(8, '0')}`;
  const prefix = style === 'emoji' ? '👋🌟🎉😊💬💡🎥👏' : TEMPLATES[index % TEMPLATES.length];
  const body = Array.from(prefix.repeat(Math.ceil(length / Array.from(prefix).length) + 1));
  if (length <= suffix.length) return body.slice(0, length).join('');
  return body.slice(0, length - suffix.length).join('') + suffix;
}

export function makeEvent(index, type, rate, messageLength, messageStyle, parseAmount) {
  const elapsedMs = Math.floor(index * 1000 / rate);
  const seconds = Math.floor(elapsedMs / 1000);
  const displayTimestamp = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
    .map(value => String(value).padStart(2, '0')).join(':');
  const paid = type === 'superchat';
  return {
    sessionId: SESSION_ID,
    eventId: `yt:stress-${paid ? 'paid' : 'chat'}-${String(index).padStart(8, '0')}`,
    idQuality: 'youtube', type,
    author: index % 8 === 7 ? '=LiteralViewer' : `ResearchViewer${String(index % 10000).padStart(5, '0')}`,
    message: makeMessage(index, messageLength, messageStyle),
    displayTimestamp,
    observedAt: new Date(START_MS + elapsedMs).toISOString(),
    purchaseText: paid ? 'USD 1.00' : '',
    ...(paid ? parseAmount('USD 1.00') : { currency: null, amountMicros: null, amountIssue: null }),
    captureOrigin: 'live',
    captureMode: 'live', replayOffsetSeconds: null,
  };
}

// Independent RFC-style CSV reader. It does not call the production CSV helpers.
// Rows are delivered individually so validation does not retain a second dataset.
export function scanCsv(source, onRow) {
  let cursor = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  let row = [], field = '', state = 'start', recordCount = 0;
  function finishField() { row.push(field); field = ''; state = 'start'; }
  function finishRow() { finishField(); onRow(row, recordCount++); row = []; }
  for (; cursor < source.length; cursor += 1) {
    const char = source[cursor];
    if (state === 'quoted') {
      if (char === '"') {
        if (source[cursor + 1] === '"') { field += '"'; cursor += 1; }
        else state = 'closed';
      } else field += char;
      continue;
    }
    if (char === ',') { finishField(); continue; }
    if (char === '\r' || char === '\n') {
      if (char === '\r' && source[cursor + 1] === '\n') cursor += 1;
      finishRow();
      continue;
    }
    if (state === 'closed') throw new Error(`Unexpected character after CSV quote at ${cursor}`);
    if (char === '"') {
      if (state !== 'start') throw new Error(`Unexpected CSV quote at ${cursor}`);
      state = 'quoted';
    } else { field += char; state = 'unquoted'; }
  }
  if (state === 'quoted') throw new Error('Unclosed quoted CSV field');
  if (state !== 'start' || field || row.length) finishRow();
  return recordCount;
}

export function expectedCsvCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  const first = text.trimStart()[0];
  const protect = ['=', '+', '-', '@'].includes(first) || ['\t', '\r', '\n'].includes(text[0]);
  return protect ? `'${text}` : text;
}
