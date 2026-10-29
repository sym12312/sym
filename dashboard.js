(() => {
  'use strict';

  const byId = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const requestedTab = Number(params.get('tab'));
  const initialTabId = params.has('tab') && Number.isInteger(requestedTab) && requestedTab >= 0 ? requestedTab : null;
  const state = { target: null, sessions: [], selectedId: null, session: null, events: [], busy: false, loading: false, revision: 0 };
  const paidTypes = new Set(['superchat', 'supersticker']);
  const eventNames = { chat: 'Comment', superchat: 'Super Chat', supersticker: 'Super Sticker', membership: 'Membership', gift: 'Gift' };
  const dateFormatter = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const timeFormatter = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  async function request(message) {
    if (!globalThis.chrome?.runtime?.sendMessage) throw new Error('Open this page from the installed Stream Study extension. To install it, open chrome://extensions, enable Developer mode, and choose Load unpacked.');
    const response = await chrome.runtime.sendMessage(message);
    if (!response?.ok) throw new Error(response?.error || 'The extension could not complete this request. Try refreshing this notebook.');
    return response;
  }

  function text(id, value) { byId(id).textContent = value; }
  function readableDate(value, timeOnly = false) {
    const date = new Date(value);
    if (!value || !Number.isFinite(date.getTime())) return '—';
    return (timeOnly ? timeFormatter : dateFormatter).format(date);
  }
  function count(value) { return Number.isFinite(Number(value)) ? Number(value).toLocaleString() : '0'; }
  function captureModeLabel(session) {
    if (session?.isDemo) return 'Sample data';
    if (session?.captureMode === 'mixed') return 'Live + replay';
    if (session?.captureMode === 'replay' || session?.collectorState === 'replay') return 'Replay';
    if (session?.captureMode === 'live' || session?.collectorState === 'watching') return 'Live';
    return 'Browser capture';
  }
  function reviewNeeded(event) {
    // Keep this predicate aligned with storage.isCountable so the review filter
    // and the monetary-total exclusions describe the same records.
    const countable = event.idQuality === 'youtube'
      && /^[A-Z]{3}$/.test(event.currency || '')
      && /^\d+$/.test(event.amountMicros || '')
      && BigInt(event.amountMicros) > 0n
      && !event.amountIssue;
    return paidTypes.has(event.type) && !countable;
  }
  function create(tag, className, value) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (value != null) el.textContent = value;
    return el;
  }
  function error(message) {
    text('error-notice', message || '');
    byId('error-notice').hidden = !message;
  }

  async function refresh(selectedId = undefined) {
    const revision = ++state.revision;
    state.loading = true;
    try {
      const result = await request({ type: 'GET_STATE', tabId: initialTabId });
      if (revision !== state.revision) return;
      state.target = result.target || null;
      state.sessions = result.sessions || [];
      if (selectedId !== undefined) state.selectedId = selectedId;
      if (!state.sessions.some((session) => session.id === state.selectedId)) state.selectedId = result.session?.id || state.sessions[0]?.id || null;
      if (state.selectedId) {
        const [detail, eventResult] = await Promise.all([
          request({ type: 'GET_SESSION', sessionId: state.selectedId }),
          request({ type: 'GET_EVENTS', sessionId: state.selectedId, limit: 200 }),
        ]);
        if (revision !== state.revision) return;
        state.session = detail.session || null;
        state.events = eventResult.events || [];
      } else {
        state.session = null;
        state.events = [];
      }
      render();
    } catch (problem) {
      if (revision === state.revision) error(problem.message || String(problem));
    } finally {
      if (revision === state.revision) state.loading = false;
    }
  }

  async function act(operation) {
    if (state.busy) return;
    state.busy = true;
    error('');
    renderButtons();
    try { await operation(); }
    catch (problem) { error(problem.message || String(problem)); }
    finally { state.busy = false; renderButtons(); }
  }

  function renderButtons() {
    const session = state.session;
    byId('start-button').disabled = state.busy || !Number.isInteger(state.target?.tabId) || !state.target?.videoId;
    byId('start-button').lastChild.textContent = session ? ' Capture current video' : ' Start capture';
    byId('pause-button').hidden = !session || session.status !== 'recording' || session.isDemo;
    byId('pause-button').disabled = state.busy;
    byId('resume-button').hidden = !session || session.status === 'recording' || session.isDemo;
    byId('resume-button').disabled = state.busy;
    byId('demo-button').disabled = state.busy;
    byId('csv-button').disabled = state.busy || !session;
    byId('json-button').disabled = state.busy || !session;
    byId('delete-button').hidden = !session;
    byId('delete-button').disabled = state.busy;
    byId('session-select').disabled = state.busy || state.sessions.length === 0;
  }

  function renderSessions() {
    const select = byId('session-select');
    const focused = document.activeElement === select;
    // Keep the native picker stable while the user is choosing a session.
    if (!focused) {
      select.replaceChildren();
      if (!state.sessions.length) select.append(new Option('No sessions yet', ''));
      for (const session of state.sessions) {
        const prefix = session.isDemo ? '[Sample] ' : session.captureMode === 'replay' ? '[Replay] ' : session.captureMode === 'mixed' ? '[Live + replay] ' : '';
        const option = new Option(`${prefix}${session.title || session.videoId || 'Untitled stream'}`, session.id);
        option.selected = session.id === state.selectedId;
        select.append(option);
      }
    }
    text('session-count', state.sessions.length ? `${count(state.sessions.length)} saved ${state.sessions.length === 1 ? 'session' : 'sessions'}` : 'Your captures will appear here.');
    const history = byId('session-history');
    history.replaceChildren();
    for (const session of state.sessions.slice(0, 5)) {
      const button = create('button', `session-item${session.id === state.selectedId ? ' active' : ''}`);
      button.type = 'button';
      button.setAttribute('aria-pressed', String(session.id === state.selectedId));
      button.append(create('strong', '', `${session.isDemo ? '◇ ' : ''}${session.title || session.videoId || 'Untitled stream'}`));
      button.append(create('span', '', `${readableDate(session.startedAt)} · ${captureModeLabel(session)}${session.isDemo ? '' : session.status === 'recording' ? ' · Recording' : ' · Paused'}`));
      button.addEventListener('click', () => { if (!state.busy) refresh(session.id); });
      history.append(button);
    }
  }

  function renderCapture() {
    const session = state.session;
    const target = state.target;
    const badge = byId('status-badge');
    const notice = byId('capture-notice');
    badge.className = 'status-badge neutral';
    notice.className = 'capture-notice';
    let status = 'Ready when you are';
    let message = 'Only messages loaded into the YouTube chat panel can be captured. Keep the stream tab open.';
    text('source-mode', `YouTube · ${captureModeLabel(session)}`);
    text('capture-heading', session?.title || target?.title || 'Your next stream study starts here.');
    text('capture-description', session ? `${session.isDemo ? 'SAMPLE SESSION · ' : ''}${session.videoId || 'Research session'}${target?.videoId && target.videoId !== session.videoId ? ` · New capture will use: ${target.title || target.videoId}` : ''}` : target ? `${target.videoId} · Ready to collect the chat loaded in this tab.` : 'Open a livestream or recording and launch this notebook from the extension icon.');
    text('started-at', readableDate(session?.startedAt));
    text('last-seen', readableDate(session?.lastHeartbeatAt, true));
    text('chat-mode', session?.chatMode || (session ? 'Unknown' : 'Not connected'));
    text('gap-count', session ? count(session.gaps?.length || 0) : '—');
    if (session?.isDemo) {
      status = 'Sample data';
      badge.className = 'status-badge demo';
      notice.className = 'capture-notice demo';
      message = 'This is a sample dataset for exploring the notebook. It contains no captured YouTube activity.';
    } else if (session?.status === 'recording') {
      const last = Date.parse(session.lastHeartbeatAt || session.intervals?.at(-1)?.start || session.updatedAt || session.startedAt || '');
      const stale = !Number.isFinite(last) || Date.now() - last > 25000;
      const collectorState = String(session.collectorState || '').toLowerCase();
      const replay = collectorState === 'replay' || (session.captureMode === 'replay' && collectorState !== 'watching');
      const topChat = /top\s*chat/i.test(session.chatMode || '');
      const unavailable = /missing|unavailable|disabled|no.chat|not.found/.test(collectorState);
      if (stale) {
        status = 'Check connection';
        message = 'No recent collector check-in. The YouTube tab may be closed, asleep, or disconnected. Refresh it and confirm its chat panel is open; capture may have gaps.';
      } else if (!session.lastHeartbeatAt || unavailable) {
        status = 'Waiting for chat';
        message = 'Waiting for the chat panel. Refresh YouTube after installing, then open Live chat or Chat replay. Some recordings do not have chat replay.';
      } else if (topChat) {
        status = 'Recording · filtered chat';
        message = `Top chat filters messages. Choose the unfiltered ${replay ? 'chat replay' : 'Live chat'} view if available.${replay ? ' Keep the video playing to load messages.' : ''}`;
      } else if (replay) {
        status = 'Recording replay';
        message = 'Play the video to collect its chat replay. Start at the beginning for broader coverage; skipped sections are not collected. Higher playback speeds may miss messages. Repeated stable message IDs are counted once.';
      } else {
        status = 'Recording';
        badge.className = 'status-badge live';
        message = 'Capture continues when you close this notebook. Keep the YouTube tab open. Only messages loaded by YouTube can be observed.';
      }
      if (status === 'Recording' || status === 'Recording replay') badge.className = 'status-badge live';
      else { badge.className = 'status-badge warning'; notice.className = 'capture-notice warning'; }
    } else if (session) {
      status = 'Paused';
      message = 'Capture is paused. Saved records stay on this device. Resume to collect newly loaded chat messages.';
    }
    text('status-text', status);
    text('capture-notice', message);
    renderCoverage();
  }

  function renderMetrics() {
    const stats = state.session?.stats || {};
    text('chat-count', count(stats.chatCount));
    text('paid-count', count(stats.paidCount));
    text('review-count', count(stats.unresolvedPaidCount));
    const totals = byId('currency-totals');
    totals.replaceChildren();
    const entries = Object.entries(stats.totals || {}).sort(([a], [b]) => a.localeCompare(b));
    for (const [currency, amount] of entries) {
      const label = create('span', 'currency-total');
      label.append(create('small', '', currency));
      label.append(document.createTextNode(globalThis.StreamStudyCore?.formatMicros ? StreamStudyCore.formatMicros(amount) : 'Unavailable'));
      totals.append(label);
    }
    if (!entries.length) totals.append(create('span', 'empty-total', 'No purchases counted yet'));
    text('totals-caption', stats.countedPaidCount ? `${count(stats.countedPaidCount)} events with a stable ID and readable currency` : 'Each currency stays separate');
  }

  function renderEvents() {
    const query = byId('event-search').value.trim().toLocaleLowerCase();
    const filter = byId('event-type').value;
    const events = state.events.filter((event) => {
      if (filter === 'paid' && !paidTypes.has(event.type)) return false;
      if (filter === 'chat' && event.type !== 'chat') return false;
      if (filter === 'membership' && !['membership', 'gift'].includes(event.type)) return false;
      if (filter === 'review' && !reviewNeeded(event)) return false;
      return !query || [event.author, event.message, event.purchaseText, event.currency, eventNames[event.type]].filter(Boolean).join(' ').toLocaleLowerCase().includes(query);
    });
    const body = byId('event-rows');
    body.replaceChildren();
    for (const event of events) {
      const row = create('tr');
      const time = create('td');
      if (event.captureMode === 'replay') {
        const offset = event.replayOffsetSeconds;
        const formatted = typeof offset === 'number' && Number.isFinite(offset)
          ? StreamStudyCore.formatReplayOffset(offset) : '';
        if (formatted && offset >= 0 && /^[A-Za-z0-9_-]{11}$/.test(state.session?.videoId || '')) {
          const link = create('a', 'replay-time', `Replay ${formatted}`);
          link.href = `https://www.youtube.com/watch?v=${state.session.videoId}&t=${Math.floor(offset)}s`;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          link.title = 'Open the video at this replay timestamp';
          time.append(link);
        } else {
          time.append(document.createTextNode(formatted ? `Replay ${formatted}` : 'Replay time unavailable'));
        }
        if (!formatted && event.displayTimestamp) time.append(create('span', 'row-note', `Chat label: ${event.displayTimestamp}`));
        const captured = create('span', 'row-note', `Captured ${readableDate(event.observedAt, true)}`);
        captured.title = event.observedAt || '';
        time.append(captured);
      } else {
        time.append(document.createTextNode(readableDate(event.observedAt, true)));
        time.title = event.observedAt || '';
        time.append(create('span', 'row-note', 'Capture time'));
        if (event.displayTimestamp) time.append(create('span', 'row-note', `Chat: ${event.displayTimestamp}`));
      }
      if (event.captureOrigin === 'initial') time.append(create('span', 'initial-note', 'Loaded at start'));
      const author = create('td', '', event.author || 'Name unavailable');
      const type = create('td');
      const category = paidTypes.has(event.type) ? 'paid' : ['membership', 'gift'].includes(event.type) ? 'membership' : '';
      type.append(create('span', `event-label ${category}`, eventNames[event.type] || event.type || 'Event'));
      const message = create('td', 'event-message', event.message || (event.type === 'supersticker' ? 'Sticker' : '—'));
      const amount = create('td', '', event.purchaseText || '—');
      if (reviewNeeded(event)) {
        const note = create('span', 'row-note review', 'Needs review');
        note.title = event.amountIssue || (event.idQuality !== 'youtube' ? 'No stable YouTube message ID. Excluded from monetary totals.' : 'Amount or currency could not be read confidently.');
        amount.append(note);
      }
      row.append(time, author, type, message, amount);
      body.append(row);
    }
    byId('event-table').hidden = events.length === 0;
    byId('empty-state').hidden = events.length !== 0;
    if (!events.length) {
      if (state.events.length) {
        text('empty-title', 'No matching events.');
        text('empty-description', 'Try another name, phrase, or event filter. Search covers the latest 200 loaded records; exports contain the full session.');
      } else if (state.session) {
        text('empty-title', state.session.status === 'recording' ? 'Listening for the conversation.' : 'No records in this session yet.');
        text('empty-description', state.session.status === 'recording' ? 'Messages appear when YouTube loads chat. Keep the tab open; for a recording, open Chat replay and play the video.' : 'Resume capture on a livestream or recording with chat replay to add comments and paid events.');
      } else {
        text('empty-title', 'A little observation goes a long way.');
        text('empty-description', 'Start a capture to see the conversation take shape, or explore the notebook with sample data.');
      }
    }
    const total = state.session?.eventCount || 0;
    text('events-caption', state.session?.isDemo ? 'Sample records · Explore filtering and exports.' : state.session ? `${count(total)} saved events · Latest captured first.${['replay', 'mixed'].includes(state.session.captureMode) ? ' Replay times refer to the video.' : ''}` : 'Captured comments and paid events, in one place.');
    text('display-count', state.session ? `${count(events.length)} shown from the latest ${count(state.events.length)} records · Exports include all ${count(total)}` : 'No events captured');
  }

  function renderCoverage() {
    const session = state.session;
    const details = byId('coverage-details');
    const log = byId('coverage-log');
    details.hidden = !session;
    log.replaceChildren();
    if (!session) return;
    if (['replay', 'mixed'].includes(session.captureMode)) {
      log.append(create('p', '', 'These windows show when capture ran on this device. They do not establish which parts of the video were played. Skipped sections may be missing; replay timestamps are preserved where YouTube displays them.'));
    }
    log.append(create('h3', '', 'Requested recording windows'));
    const intervals = create('ul');
    for (const interval of session.intervals || []) intervals.append(create('li', '', `${readableDate(interval.start)} → ${interval.end ? readableDate(interval.end) : 'Still recording'}`));
    if (!intervals.children.length) intervals.append(create('li', '', 'No recording windows recorded.'));
    log.append(intervals);
    log.append(create('h3', '', 'Reported interruptions'));
    const gaps = create('ul');
    for (const gap of session.gaps || []) gaps.append(create('li', '', `${readableDate(gap.at)} — ${gap.reason || 'Collection interrupted'}`));
    if (!gaps.children.length) gaps.append(create('li', '', 'None reported. This does not establish complete chat coverage.'));
    log.append(gaps);
  }

  function render() { renderSessions(); renderCapture(); renderMetrics(); renderEvents(); renderButtons(); }

  async function exportSession(format) {
    if (!state.session) return;
    const result = await request({ type: 'EXPORT_SESSION', sessionId: state.session.id });
    let contents;
    if (format === 'csv') {
      if (!globalThis.StreamStudyCore?.toCsv) throw new Error('The CSV exporter did not load. Reload the extension and this notebook.');
      contents = StreamStudyCore.toCsv(result.events || []);
    } else {
      contents = JSON.stringify({ schemaVersion: 1, exportedAt: new Date().toISOString(), session: result.session, events: result.events || [] }, null, 2);
    }
    const blob = new Blob([contents], { type: format === 'csv' ? 'text/csv;charset=utf-8' : 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = create('a');
    const name = `${result.session?.isDemo ? 'sample-' : ''}stream-study-${result.session?.videoId || 'session'}-${new Date().toISOString().slice(0, 10)}`.replace(/[^a-zA-Z0-9_-]/g, '_');
    anchor.href = url;
    anchor.download = `${name}.${format}`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  byId('start-button').addEventListener('click', () => act(async () => {
    const result = await request({ type: 'START_SESSION', tabId: state.target?.tabId });
    await refresh(result.session?.id);
  }));
  byId('pause-button').addEventListener('click', () => act(async () => {
    await request({ type: 'PAUSE_SESSION', sessionId: state.session.id });
    await refresh();
  }));
  byId('resume-button').addEventListener('click', () => act(async () => {
    const tabId = state.target?.videoId === state.session.videoId ? state.target.tabId : state.session.tabId;
    await request({ type: 'RESUME_SESSION', sessionId: state.session.id, tabId });
    await refresh();
  }));
  byId('demo-button').addEventListener('click', () => act(async () => {
    const result = await request({ type: 'CREATE_DEMO' });
    await refresh(result.session?.id);
  }));
  byId('csv-button').addEventListener('click', () => act(() => exportSession('csv')));
  byId('json-button').addEventListener('click', () => act(() => exportSession('json')));
  byId('delete-button').addEventListener('click', () => {
    if (!state.session || state.busy) return;
    if (!confirm(`Delete “${state.session.title || state.session.videoId || 'this session'}” and all its captured records from this device? This cannot be undone.`)) return;
    act(async () => {
      await request({ type: 'DELETE_SESSION', sessionId: state.session.id });
      state.selectedId = null;
      await refresh();
    });
  });
  byId('session-select').addEventListener('change', (event) => refresh(event.target.value));
  byId('event-search').addEventListener('input', renderEvents);
  byId('event-type').addEventListener('change', renderEvents);
  document.querySelector('.brand').href = location.href;
  text('time-zone', `Capture times · ${Intl.DateTimeFormat().resolvedOptions().timeZone || 'Local time'}`);
  render();
  refresh();
  setInterval(() => { if (!state.busy && !state.loading && !document.hidden) refresh(); }, 3000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !state.busy) refresh(); });
})();
