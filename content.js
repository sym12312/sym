(() => {
  'use strict';

  // This script reads the rendered chat DOM only. It never calls a YouTube API.
  const isLiveChat = /^\/live_chat\/?$/.test(location.pathname);
  const isReplay = /^\/live_chat_replay\/?$/.test(location.pathname);
  if ((!isLiveChat && !isReplay) || !globalThis.StreamStudyCore) return;

  const core = globalThis.StreamStudyCore;
  const captureMode = isReplay ? 'replay' : 'live';
  const ROW_TYPES = {
    'YT-LIVE-CHAT-TEXT-MESSAGE-RENDERER': 'chat',
    'YT-LIVE-CHAT-PAID-MESSAGE-RENDERER': 'superchat',
    'YT-LIVE-CHAT-PAID-STICKER-RENDERER': 'supersticker',
    'YT-LIVE-CHAT-MEMBERSHIP-ITEM-RENDERER': 'membership',
    'YT-LIVE-CHAT-SPONSORSHIPS-GIFT-PURCHASE-ANNOUNCEMENT-RENDERER': 'membership',
    'YT-LIVE-CHAT-SPONSORSHIPS-GIFT-REDEMPTION-ANNOUNCEMENT-RENDERER': 'membership',
    'YT-LIVE-CHAT-GIFT-MESSAGE-RENDERER': 'gift',
    'YT-LIVE-CHAT-GIFT-RENDERER': 'gift',
  };
  const ROW_SELECTOR = Object.keys(ROW_TYPES).map(name => name.toLowerCase()).join(',');
  const TICKER_SELECTOR = [
    'yt-live-chat-ticker-renderer',
    'yt-live-chat-ticker-paid-message-item-renderer',
    'yt-live-chat-ticker-paid-sticker-item-renderer',
  ].join(',');
  const MAX_PENDING = 5000;
  const MAX_CANDIDATES = 3000;
  const MAX_SEEN = 15000;
  const BATCH_SIZE = 200;

  let session = null;
  let observer = null;
  let generation = 0;
  let refreshing = false;
  let refreshRequested = false;
  let flushing = false;
  let disabled = false;
  let processTimer = null;
  let droppedEvents = 0;
  let collectorErrors = 0;
  let lastError = '';
  let localSequence = 0;
  const elementIds = new WeakMap();
  const candidates = new Map();
  const pending = new Map();
  const seen = new Map();

  // textContent omits the useful text of YouTube's emoji images.
  function readableText(node) {
    if (!node) return '';
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || '';
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    if (node.tagName === 'IMG') return node.getAttribute('alt') || node.getAttribute('aria-label') || '';
    if (node.tagName === 'BR') return '\n';
    if (['SCRIPT', 'STYLE', 'SVG'].includes(node.tagName)) return '';
    return Array.from(node.childNodes, readableText).join('');
  }

  function textWithin(node, selector) {
    return readableText(node.querySelector(selector)).replace(/\s+/g, ' ').trim();
  }

  function recordError(error) {
    collectorErrors += 1;
    lastError = String(error?.message || error || 'Collector error').slice(0, 200);
    if (/Extension context invalidated/i.test(lastError)) {
      disabled = true;
      stopObserver();
    }
  }

  async function send(message) {
    if (disabled) throw new Error('Extension context invalidated; reload this YouTube page.');
    return chrome.runtime.sendMessage(message);
  }

  function stableElementId(row) {
    const nativeId = (row.getAttribute('id') || '').trim();
    const existingElementId = elementIds.get(row);
    if (nativeId && !['message', 'items', 'contents', 'renderer', 'chat'].includes(nativeId)) {
      return {
        eventId: `yt:${nativeId}`,
        idQuality: 'youtube',
        ...(existingElementId ? { supersedesEventId: existingElementId } : {}),
      };
    }
    if (!existingElementId) {
      const token = typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now()}-${++localSequence}-${Math.random().toString(36).slice(2)}`;
      elementIds.set(row, `element:${token}`);
    }
    return { eventId: elementIds.get(row), idQuality: 'element' };
  }

  function parseRow(row, captureOrigin, allowDetached = false) {
    if ((!row.isConnected && !allowDetached) || (row.isConnected && !row.closest('yt-live-chat-item-list-renderer')) || row.closest(TICKER_SELECTOR)) return null;
    const type = ROW_TYPES[row.tagName];
    if (!type) return null;
    const identity = stableElementId(row);
    const previous = seen.get(identity.eventId) || (identity.supersedesEventId && seen.get(identity.supersedesEventId));
    const author = textWithin(row, '#author-name');
    let message = textWithin(row, '#message');
    if (!message && type === 'supersticker') {
      message = textWithin(row, '#sticker') || textWithin(row, '#sticker-container');
      if (!message) message = row.querySelector('#sticker')?.getAttribute('alt') || '';
    }
    if (!message && (type === 'membership' || type === 'gift')) {
      message = textWithin(row, '#header-subtext') || textWithin(row, '#header-primary-text') || textWithin(row, '#primary-text');
    }
    const purchaseText = type === 'superchat' || type === 'supersticker'
      ? textWithin(row, '#purchase-amount') || textWithin(row, '#purchase-amount-chip')
      : '';
    const money = type === 'superchat' || type === 'supersticker'
      ? core.parseAmount(purchaseText)
      : { amountMicros: null, currency: null, amountIssue: null };
    // Empty rows often appear briefly before Polymer renders their contents.
    if (!author && !message && !purchaseText) return null;
    const renderedTimestamp = textWithin(row, '#timestamp');
    // YouTube may temporarily clear a row while hydrating or seeking. Keep an
    // already observed replay timestamp; observation time is never a substitute.
    const displayTimestamp = renderedTimestamp || (isReplay ? previous?.displayTimestamp || '' : '');
    return {
      ...identity,
      type,
      author,
      message,
      displayTimestamp,
      captureMode,
      replayOffsetSeconds: isReplay ? core.parseReplayTimestamp(displayTimestamp) : null,
      observedAt: previous?.observedAt || new Date().toISOString(),
      purchaseText,
      ...money,
      captureOrigin: previous?.captureOrigin || captureOrigin,
    };
  }

  function fingerprint(event) {
    const { observedAt, captureOrigin, ...content } = event;
    return JSON.stringify(content);
  }

  function queueRow(row, origin, allowDetached = false) {
    try {
      const event = parseRow(row, origin, allowDetached);
      if (!event) return;
      const signature = fingerprint(event);
      if (seen.get(event.eventId)?.signature === signature) return;
      if (!pending.has(event.eventId) && pending.size >= MAX_PENDING) {
        droppedEvents += 1;
        return;
      }
      if (event.supersedesEventId) {
        pending.delete(event.supersedesEventId);
        seen.delete(event.supersedesEventId);
      }
      pending.set(event.eventId, event);
      seen.set(event.eventId, {
        signature,
        observedAt: event.observedAt,
        captureOrigin: event.captureOrigin,
        displayTimestamp: event.displayTimestamp,
      });
      while (seen.size > MAX_SEEN) seen.delete(seen.keys().next().value);
    } catch (error) {
      recordError(error);
    }
  }

  function addCandidate(row, origin, detachedFromMainList = false) {
    if (!row || !ROW_TYPES[row.tagName]) return;
    if (row.closest(TICKER_SELECTOR) || (!detachedFromMainList && !row.closest('yt-live-chat-item-list-renderer'))) return;
    if (!candidates.has(row) && candidates.size >= MAX_CANDIDATES) {
      droppedEvents += 1;
      return;
    }
    // Preserve the initial-load label when a row is hydrated during the first scan.
    if (!candidates.has(row)) candidates.set(row, { origin, allowDetached: true });
  }

  function collectCandidates(node, origin = captureMode, detachedFromMainList = false) {
    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    if (!element) return;
    addCandidate(element.closest(ROW_SELECTOR), origin, detachedFromMainList);
    if (element.querySelectorAll) {
      for (const row of element.querySelectorAll(ROW_SELECTOR)) addCandidate(row, origin, detachedFromMainList);
    }
  }

  function processCandidates() {
    clearTimeout(processTimer);
    processTimer = null;
    if (!session || session.status !== 'recording') {
      candidates.clear();
      return;
    }
    for (const [row, { origin, allowDetached }] of candidates) queueRow(row, origin, allowDetached);
    candidates.clear();
  }

  function scheduleProcessing() {
    if (!processTimer) processTimer = setTimeout(processCandidates, 0);
  }

  function processMutations(records) {
    for (const record of records) {
      if (record.type === 'childList') {
        const target = record.target.nodeType === Node.ELEMENT_NODE ? record.target : record.target.parentElement;
        const fromMainList = Boolean(target?.closest('yt-live-chat-item-list-renderer')) && !target?.closest(TICKER_SELECTOR);
        // The target is also needed when an existing text span is emptied.
        addCandidate(target?.closest(ROW_SELECTOR), captureMode);
        for (const node of record.addedNodes) collectCandidates(node, captureMode, fromMainList);
        // Fast chats can remove a row before the observer callback runs. The
        // mutation's parent establishes that it came from the main chat list.
        if (fromMainList) {
          for (const node of record.removedNodes) collectCandidates(node, captureMode, true);
        }
      } else {
        const element = record.target.nodeType === Node.ELEMENT_NODE ? record.target : record.target.parentElement;
        addCandidate(element?.closest(ROW_SELECTOR), captureMode);
      }
    }
    processCandidates();
  }

  function startObserver() {
    if (observer || !document.documentElement) return;
    observer = new MutationObserver(processMutations);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['id', 'alt', 'aria-label'],
    });
    collectCandidates(document.documentElement, 'initial');
    scheduleProcessing();
  }

  function stopObserver() {
    observer?.disconnect();
    observer = null;
    clearTimeout(processTimer);
    processTimer = null;
    candidates.clear();
  }

  function chatMode() {
    const selectors = [
      'yt-live-chat-header-renderer #view-selector #label',
      '#view-selector [slot="dropdown-trigger"]',
      '#view-selector #button',
    ];
    for (const selector of selectors) {
      const value = readableText(document.querySelector(selector)).replace(/\s+/g, ' ').trim();
      if (value) return value.slice(0, 100);
    }
    return 'unknown';
  }

  async function heartbeat(extra = {}) {
    if (!session || disabled) return;
    try {
      await send({
        type: 'HEARTBEAT',
        sessionId: session.id,
        chatMode: chatMode(),
        isReplay,
        pageVisibility: document.visibilityState,
        documentUrl: location.href,
        chatPresent: Boolean(document.querySelector('yt-live-chat-item-list-renderer')),
        online: navigator.onLine,
        pendingEvents: pending.size,
        droppedEvents,
        collectorErrors,
        lastError,
        ...extra,
      });
    } catch (error) {
      recordError(error);
    }
  }

  async function refreshSession() {
    if (disabled) return;
    if (refreshing) {
      refreshRequested = true;
      return;
    }
    refreshing = true;
    const requestGeneration = generation;
    try {
      const result = await send({ type: 'COLLECTOR_HELLO' });
      // A synchronous drain supersedes any earlier HELLO response.
      if (requestGeneration !== generation) return;
      if (!result?.ok) throw new Error(result?.error || 'The extension worker did not answer.');
      const next = result.session || null;
      const changedSession = session?.id !== next?.id;
      if (changedSession || next?.status !== 'recording') {
        generation += 1;
        stopObserver();
        if (!changedSession) droppedEvents += pending.size;
        pending.clear();
        // Unsaved rows may still be on screen at resume. The database handles
        // stable-ID deduplication after that rescan.
        seen.clear();
        if (changedSession) {
          droppedEvents = 0;
          collectorErrors = 0;
          lastError = '';
        }
      }
      session = next;
      if (session?.status === 'recording') startObserver();
      await heartbeat();
    } catch (error) {
      recordError(error);
    } finally {
      refreshing = false;
      if (refreshRequested && !disabled) {
        refreshRequested = false;
        queueMicrotask(() => { void refreshSession(); });
      }
    }
  }

  async function flush() {
    if (flushing || !session || session.status !== 'recording' || disabled || !pending.size) return;
    flushing = true;
    const currentGeneration = generation;
    const batch = Array.from(pending.values()).slice(0, BATCH_SIZE);
    const sessionId = session.id;
    try {
      const result = await send({ type: 'INGEST', sessionId, events: batch });
      if (!result?.ok) throw new Error(result?.error || 'The extension could not save a chat batch.');
      if (result.accepted === false) {
        await refreshSession();
        return;
      }
      if (currentGeneration !== generation) return;
      for (const event of batch) {
        if (pending.get(event.eventId) === event) pending.delete(event.eventId);
      }
      lastError = '';
    } catch (error) {
      recordError(error);
      // Recheck after a pause, navigation, or a service-worker restart.
      void refreshSession();
    } finally {
      flushing = false;
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message?.type === 'COLLECTOR_DRAIN') {
      if (!session || message.sessionId !== session.id) {
        respond({ ok: false, error: 'No collector for the requested session.' });
        return false;
      }
      // Reply with the final batch directly. Sending an INGEST message here
      // could deadlock a worker that serializes pause and ingestion operations.
      if (observer) processMutations(observer.takeRecords());
      processCandidates();
      stopObserver();
      generation += 1;
      session = { ...session, status: 'paused' };
      const events = Array.from(pending.values()).slice(0, MAX_PENDING);
      const result = {
        ok: true,
        sessionId: session.id,
        captureMode,
        events,
        droppedEvents,
        collectorErrors,
      };
      pending.clear();
      seen.clear();
      respond(result);
      return false;
    }
    if (message?.type !== 'COLLECTOR_REFRESH') return false;
    refreshSession().then(() => respond({ ok: true }), () => respond({ ok: false }));
    return true;
  });

  setInterval(() => {
    processCandidates();
    void flush();
  }, 500);
  setInterval(() => { void refreshSession(); }, 10000);
  document.addEventListener('visibilitychange', () => { void heartbeat(); });
  window.addEventListener('online', () => { void refreshSession(); });
  window.addEventListener('offline', () => { void heartbeat(); });
  window.addEventListener('pagehide', () => {
    processCandidates();
    void flush();
    void heartbeat({ pageVisibility: 'unloading' });
  });
  void refreshSession();
})();
