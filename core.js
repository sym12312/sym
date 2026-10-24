/* Shared, dependency-free helpers. No page data or network access occurs here. */
(() => {
  'use strict';

  const ISO_CURRENCIES = new Set((
    'AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BHD BIF BMD BND BOB BRL BSD BTN BWP BYN BZD ' +
    'CAD CDF CHF CLP CNY COP CRC CUP CVE CZK DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GNF GTQ GYD ' +
    'HKD HNL HTG HUF IDR ILS INR IQD IRR ISK JMD JOD JPY KES KGS KHR KMF KPW KRW KWD KYD KZT LAK LBP LKR LRD LSL LYD ' +
    'MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MYR MZN NAD NGN NIO NOK NPR NZD OMR PAB PEN PGK PHP PKR PLN PYG ' +
    'QAR RON RSD RUB RWF SAR SBD SCR SDG SEK SGD SHP SLE SLL SOS SRD SSP STN SVC SYP SZL THB TJS TMT TND TOP TRY TTD TWD ' +
    'TZS UAH UGX USD UYU UZS VED VES VND VUV WST XAF XCD XOF XPF YER ZAR ZMW ZWG ZWL'
  ).split(' '));

  const PREFIX_CURRENCIES = [
    ['US$', 'USD'], ['CA$', 'CAD'], ['AU$', 'AUD'], ['A$', 'AUD'],
    ['NZ$', 'NZD'], ['HK$', 'HKD'], ['SG$', 'SGD'], ['NT$', 'TWD'],
    ['MX$', 'MXN'], ['R$', 'BRL'], ['CN¥', 'CNY'], ['JP¥', 'JPY'],
  ];
  const SYMBOL_CURRENCIES = {
    '€': 'EUR', '£': 'GBP', '₹': 'INR', '₽': 'RUB', '₩': 'KRW',
    '₺': 'TRY', '₫': 'VND', '₱': 'PHP', '฿': 'THB', '₴': 'UAH',
    '₦': 'NGN', '₪': 'ILS', '₡': 'CRC', '₲': 'PYG', '₸': 'KZT',
    '₮': 'MNT', '₭': 'LAK', '₾': 'GEL', '₼': 'AZN', '₵': 'GHS',
  };
  const AMBIGUOUS_SYMBOL_CURRENCIES = {
    '$': new Set(('USD CAD AUD NZD HKD SGD TWD ARS CLP COP MXN DOP UYU BSD BBD BMD BND BZD ' +
      'FJD GYD JMD KYD LRD NAD SBD SRD TTD XCD CUP ZWG ZWL').split(' ')),
    '¥': new Set(['JPY', 'CNY']),
    'kr': new Set(['SEK', 'NOK', 'DKK', 'ISK']),
    'lei': new Set(['RON', 'MDL']),
    'bs': new Set(['BOB', 'VES', 'VED']),
  };

  function parseVideoId(value) {
    try {
      const url = new URL(String(value));
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
      const hostname = url.hostname.toLowerCase();
      let id;
      if (hostname === 'youtu.be' || hostname === 'www.youtu.be') {
        const segments = url.pathname.split('/').filter(Boolean);
        if (segments.length !== 1) return null;
        id = segments[0];
      } else if (['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(hostname)) {
        if (['/watch', '/live_chat', '/live_chat_replay'].includes(url.pathname)) {
          id = url.searchParams.get('v');
        } else {
          const match = url.pathname.match(/^\/(?:live|embed|shorts)\/([A-Za-z0-9_-]{11})\/?$/);
          id = match && match[1];
        }
      }
      return typeof id === 'string' && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
    } catch {
      return null;
    }
  }

  function groupedInteger(text) {
    const value = text.trim().replace(/[’]/g, "'").replace(/\s+/g, ' ');
    if (/^\d+$/.test(value)) return value;
    if (!/^[\d.,' ]+$/.test(value)) return null;
    const separators = [...new Set(value.replace(/\d/g, ''))];
    if (separators.length !== 1) return null;
    const groups = value.split(separators[0]);
    if (!groups.every(part => /^\d+$/.test(part))) return null;
    const western = /^\d{1,3}$/.test(groups[0]) && groups.slice(1).every(part => /^\d{3}$/.test(part));
    const indian = groups.length >= 2 && /^\d{1,2}$/.test(groups[0]) &&
      groups.slice(1, -1).every(part => /^\d{2}$/.test(part)) && /^\d{3}$/.test(groups.at(-1));
    return western || indian ? groups.join('') : null;
  }

  function parseNumber(value) {
    const text = value.trim();
    if (!text || !/^[\d\s.,'’]+$/.test(text)) return { issue: 'invalid-amount' };
    const dots = (text.match(/\./g) || []).length;
    const commas = (text.match(/,/g) || []).length;
    let integerPart = text;
    let fraction = '';
    if (dots && commas) {
      const decimal = text.lastIndexOf('.') > text.lastIndexOf(',') ? '.' : ',';
      if ((decimal === '.' ? dots : commas) !== 1) return { issue: 'invalid-amount' };
      const split = text.lastIndexOf(decimal);
      integerPart = text.slice(0, split);
      fraction = text.slice(split + 1);
      if (!/^\d{1,6}$/.test(fraction)) return { issue: 'invalid-amount' };
    } else if (dots + commas === 1) {
      const decimal = dots ? '.' : ',';
      const split = text.indexOf(decimal);
      const tail = text.slice(split + 1);
      if (!/^\d{1,6}$/.test(tail)) return { issue: 'invalid-amount' };
      // 1,234 could mean 1234 or 1.234. Do not choose an interpretation.
      if (tail.length === 3 && !/[\s'’]/.test(text.slice(0, split))) {
        return { issue: 'ambiguous-number-format' };
      }
      integerPart = text.slice(0, split);
      fraction = tail;
    }
    const digits = groupedInteger(integerPart);
    if (digits === null) return { issue: 'invalid-amount' };
    try {
      return { micros: (BigInt(digits) * 1000000n + BigInt((fraction || '0').padEnd(6, '0'))).toString() };
    } catch {
      return { issue: 'invalid-amount' };
    }
  }

  function parseAmount(value) {
    const raw = String(value ?? '');
    // A rendered purchase label is short. Bound work before normalization and BigInt conversion.
    if (raw.length > 256) return { amountMicros: null, currency: null, amountIssue: 'amount-too-long' };
    let text = raw.normalize('NFKC').trim();
    if (!text) return { amountMicros: null, currency: null, amountIssue: 'missing-amount' };
    const currencies = new Set();
    for (const [prefix, currency] of PREFIX_CURRENCIES) {
      const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(`(?<![A-Za-z])${escaped}`, 'gi');
      text = text.replace(pattern, () => { currencies.add(currency); return ''; });
    }
    text = text.replace(/(?<![A-Za-z])([A-Za-z]{3})(?![A-Za-z])/g, (token) => {
      const code = token.toUpperCase();
      if (!ISO_CURRENCIES.has(code)) return token;
      currencies.add(code);
      return '';
    });
    text = text.replace(/[€£₹₽₩₺₫₱฿₴₦₪₡₲₸₮₭₾₼₵]/g, symbol => {
      currencies.add(SYMBOL_CURRENCIES[symbol]);
      return '';
    });
    text = text.replace(/(?<![A-Za-z])(?:zł|Kč|Ft|RM|Rp)(?![A-Za-z])/gi, token => {
      currencies.add({ 'zł': 'PLN', 'kč': 'CZK', 'ft': 'HUF', 'rm': 'MYR', 'rp': 'IDR' }[token.toLowerCase()]);
      return '';
    });
    const ambiguousSymbols = new Set();
    text = text.replace(/[$¥]|(?<![A-Za-z])(?:kr|lei|Bs)(?![A-Za-z])/gi, token => {
      ambiguousSymbols.add(token.toLowerCase());
      return '';
    }).trim();
    let currency = currencies.size === 1 ? [...currencies][0] : null;
    let candidates = currency ? new Set([currency]) : null;
    for (const symbol of ambiguousSymbols) {
      const compatible = AMBIGUOUS_SYMBOL_CURRENCIES[symbol];
      candidates = candidates === null ? new Set(compatible) :
        new Set([...candidates].filter(candidate => compatible.has(candidate)));
    }
    const conflicting = currencies.size > 1 || (candidates !== null && candidates.size === 0);
    if (conflicting) currency = null;
    const number = parseNumber(text);
    let amountIssue = number.issue || null;
    if (!amountIssue && conflicting) amountIssue = 'conflicting-currencies';
    if (!amountIssue && !currency) amountIssue = ambiguousSymbols.size ? 'ambiguous-currency' : 'unknown-currency';
    return { amountMicros: number.micros ?? null, currency, amountIssue };
  }

  function formatMicros(value) {
    try {
      const micros = BigInt(value);
      const negative = micros < 0n;
      const absolute = negative ? -micros : micros;
      const whole = absolute / 1000000n;
      const fractional = (absolute % 1000000n).toString().padStart(6, '0').replace(/0+$/, '');
      return `${negative ? '-' : ''}${whole}${fractional ? `.${fractional}` : ''}`;
    } catch {
      return '';
    }
  }

  function csvEscape(value) {
    let text = value === null || value === undefined ? '' : String(value);
    // Prefix a literal apostrophe when spreadsheets could interpret a formula.
    // Leading whitespace/control characters must not bypass this check.
    if (/^[\s\u0000-\u001f]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  }

  const CSV_COLUMNS = [
    'sessionId', 'eventId', 'idQuality', 'type', 'author', 'message',
    'displayTimestamp', 'observedAt', 'purchaseText', 'currency',
    'amountMicros', 'amountIssue', 'captureOrigin',
  ];

  function toCsv(events) {
    const rows = [CSV_COLUMNS.map(csvEscape).join(',')];
    for (const event of events || []) {
      rows.push(CSV_COLUMNS.map(column => csvEscape(event[column])).join(','));
    }
    return '\uFEFF' + rows.join('\r\n') + '\r\n';
  }

  globalThis.StreamStudyCore = Object.freeze({ parseVideoId, parseAmount, formatMicros, csvEscape, toCsv });
})();
