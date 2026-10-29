import './core.js';
import {blankStats, getSession, listSessions, putSession, ingestEvents, readEvents, deleteSession, updateCaptureMode} from './storage.js';

const {parseVideoId} = globalThis.StreamStudyCore;
const now = () => new Date().toISOString();
const bindingKey = tabId => `tab:${tabId}`;
let mutationQueue = Promise.resolve();

// Serialize all mutations, including content batches and lifecycle updates, across frames.
function serialize(action) {
  const operation = mutationQueue.then(action, action);
  mutationQueue = operation.catch(() => {});
  return operation;
}

async function bindingFor(tabId) {
  if (!Number.isInteger(tabId)) return null;
  const key = bindingKey(tabId);
  const stored = await chrome.storage.local.get(key);
  return stored[key] ? getSession(stored[key]) : null;
}

async function getTarget(tabId) {
  if (!Number.isInteger(tabId)) return null;
  try {
    const tab = await chrome.tabs.get(tabId);
    const url = new URL(tab.url);
    if (url.origin !== 'https://www.youtube.com') return null;
    const videoId = parseVideoId(tab.url);
    if (!videoId) return null;
    return {tabId, videoId, url: `https://www.youtube.com/watch?v=${videoId}`, title: tab.title || videoId};
  } catch { return null; }
}

async function refreshCollector(tabId) {
  if (!Number.isInteger(tabId)) return;
  try { await chrome.tabs.sendMessage(tabId, {type: 'COLLECTOR_REFRESH'}); } catch { /* Dashboard explains refresh. */ }
}

async function setBadge(session) {
  if (!Number.isInteger(session.tabId)) return;
  try {
    await chrome.action.setBadgeText({tabId: session.tabId, text: session.status === 'recording' ? 'REC' : ''});
    await chrome.action.setBadgeBackgroundColor({tabId: session.tabId, color: '#25684d'});
  } catch { /* Tab may have closed. */ }
}

function appendGap(session, reason) {
  const last = session.gaps.at(-1);
  if (!last || last.reason !== reason || Date.now() - Date.parse(last.at) > 60000) {
    session.gaps.push({at: now(), reason});
    if (session.gaps.length > 1000) session.gaps.shift();
  }
}

async function pause(session, reason = 'Paused by you') {
  if (!session) throw new Error('Session not found.');
  if (session.status === 'recording') {
    session.status = 'paused';
    session.updatedAt = now();
    const interval = session.intervals.at(-1);
    if (interval && !interval.end) interval.end = session.updatedAt;
    appendGap(session, reason);
    session.collectorState = 'paused';
    await putSession(session);
    await setBadge(session);
    // Do not await responses inside the mutation queue: a collector may be waiting on its batch.
    void refreshCollector(session.tabId);
  }
  return session;
}

async function drainBeforePause(session) {
  if (!session || session.status !== 'recording') return session;
  const target = await getTarget(session.tabId);
  if (!target || target.videoId !== session.videoId) return session;
  let timeout;
  try {
    // The collector replies with data directly. It must not send a second worker
    // request here, since this handler holds the serialized mutation queue.
    const drained = await Promise.race([
      chrome.tabs.sendMessage(session.tabId, {type: 'COLLECTOR_DRAIN', sessionId: session.id}),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Collector did not respond')), 2000); })
    ]);
    if (!drained?.ok || drained.sessionId !== session.id || !Array.isArray(drained.events)) {
      throw new Error('Collector could not finish saving its pending records');
    }
    const mode = drained.captureMode === 'replay' ? 'replay' : 'live';
    const events = drained.events.slice(0, 5000).map(event => sanitizeEvent(event, mode)).filter(Boolean);
    if (events.length) await ingestEvents(session.id, events);
    // ingestEvents updates the stored totals; re-read before changing lifecycle state.
    session = await getSession(session.id);
    if (drained.droppedEvents > (session.reportedDroppedEvents || 0)) {
      appendGap(session, 'Collector queue overflowed before pause; some records may be missing');
    }
  } catch {
    appendGap(session, 'Could not flush the chat collector before pausing; recent records may be missing');
  } finally {
    clearTimeout(timeout);
  }
  return session;
}

async function start(tabId, existingId = null) {
  const target = await getTarget(tabId);
  if (!target) throw new Error('Open a YouTube livestream or recording, then click the Stream Study extension icon on that tab.');
  const bound = await bindingFor(tabId);
  let session = existingId ? await getSession(existingId) : bound;
  if (existingId && (!session || session.isDemo || session.videoId !== target.videoId)) {
    throw new Error('Open the same video to resume this session. Demo sessions cannot capture chat.');
  }
  if (bound && bound.id !== session?.id) await pause(bound, 'Another session started in this tab');
  if (session && session.videoId !== target.videoId) {
    await pause(session, 'The tab navigated to another video');
    session = null;
  }
  if (session && session.tabId !== tabId) {
    const previousTab = session.tabId;
    await pause(session, 'Monitoring moved to another tab');
    await chrome.storage.local.remove(bindingKey(previousTab));
    session.tabId = tabId;
  }
  if (!session) {
    const startedAt = now();
    session = {id: crypto.randomUUID(), videoId: target.videoId, tabId, title: target.title,
      url: target.url, status: 'paused', isDemo: false, captureMode: 'unknown', startedAt, updatedAt: startedAt,
      lastHeartbeatAt: null, chatMode: 'unknown', collectorState: 'waiting',
      intervals: [], gaps: [], eventCount: 0, stats: blankStats()};
  }
  if (session.status !== 'recording') {
    session.status = 'recording';
    session.updatedAt = now();
    session.lastHeartbeatAt = null;
    session.collectorState = 'waiting';
    session.intervals.push({start: session.updatedAt, end: null});
    await putSession(session);
  }
  await chrome.storage.local.set({[bindingKey(tabId)]: session.id});
  await setBadge(session);
  void refreshCollector(tabId);
  return session;
}

function collectorUrl(sender) {
  try {
    const url = new URL(sender.url);
    return url.origin === 'https://www.youtube.com' ? url : null;
  } catch { return null; }
}

function collectorMode(sender) {
  const pathname = collectorUrl(sender)?.pathname.replace(/\/$/, '');
  return pathname === '/live_chat_replay' ? 'replay' : pathname === '/live_chat' ? 'live' : null;
}

async function collectorSession(sender, requestedId = null) {
  if (!sender.tab || !collectorMode(sender)) return null;
  const session = await bindingFor(sender.tab.id);
  if (!session || (requestedId && requestedId !== session.id)) return null;
  const target = await getTarget(sender.tab.id);
  if (!target || target.videoId !== session.videoId || session.tabId !== sender.tab.id) return null;
  // An old frame can linger briefly during SPA navigation: check its own video id too.
  const frameVideo = parseVideoId(sender.url);
  if (frameVideo && frameVideo !== session.videoId) return null;
  return session;
}

const text = (value, max = 10000) => typeof value === 'string' ? value.slice(0, max) : '';
function sanitizeEvent(raw, captureMode) {
  if (!raw || !['chat', 'superchat', 'supersticker', 'membership', 'gift'].includes(raw.type)) return null;
  const eventId = text(raw.eventId, 512);
  if (!eventId) return null;
  const amountMicros = /^\d{1,22}$/.test(raw.amountMicros || '') ? String(raw.amountMicros) : null;
  return {eventId, idQuality: raw.idQuality === 'youtube' ? 'youtube' : 'element', type: raw.type,
    author: text(raw.author, 400), message: text(raw.message), displayTimestamp: text(raw.displayTimestamp, 128),
    observedAt: Number.isFinite(Date.parse(raw.observedAt)) ? new Date(raw.observedAt).toISOString() : now(),
    purchaseText: text(raw.purchaseText, 200), currency: /^[A-Z]{3}$/.test(raw.currency || '') ? raw.currency : null,
    amountMicros, amountIssue: text(raw.amountIssue, 300) || null,
    captureOrigin: raw.captureOrigin === 'initial' ? 'initial' : captureMode,
    captureMode,
    replayOffsetSeconds: captureMode === 'replay' ? globalThis.StreamStudyCore.parseReplayTimestamp(raw.displayTimestamp) : null,
    supersedesEventId: text(raw.supersedesEventId, 512) || null};
}

function trustedDashboard(sender) {
  return sender.id === chrome.runtime.id && sender.url?.startsWith(chrome.runtime.getURL('dashboard.html'));
}

async function createDemo() {
  const timestamp = now();
  const session = {id: crypto.randomUUID(), videoId: 'demo', tabId: null, title: 'Demo · A studio work session',
    url: '', status: 'paused', isDemo: true, startedAt: timestamp, updatedAt: timestamp,
    lastHeartbeatAt: null, chatMode: 'Demo data', collectorState: 'demo', intervals: [], gaps: [],
    eventCount: 0, stats: blankStats()};
  await putSession(session);
  const rows = [
    ['chat', 'River', 'That explanation of the lighting really helped.', '', null, null],
    ['superchat', 'Maya', 'Thanks for walking through your process!', 'US$10.00', 'USD', '10000000'],
    ['chat', 'Kai', 'Could you show the setup from the side?', '', null, null],
    ['supersticker', 'Alex', 'Applause sticker', '€5.00', 'EUR', '5000000'],
    ['superchat', 'Sam', 'Love these live sessions.', '$5.00', null, null],
    ['membership', 'Jordan', 'Gifted 5 memberships', '', null, null],
    ['chat', 'Toni', '=1+1 is text, not a spreadsheet formula in the CSV export.', '', null, null],
    ['superchat', 'Noor', 'More of these please!', 'US$2.50', 'USD', '2500000']
  ];
  const events = rows.map((row, i) => ({eventId: `demo:${i}`, idQuality: 'youtube', type: row[0],
    author: row[1], message: row[2], purchaseText: row[3], currency: row[4], amountMicros: row[5],
    amountIssue: i === 4 ? 'The $ symbol does not identify a currency.' : null,
    displayTimestamp: `00:0${i}:00`, observedAt: new Date(Date.now() - (rows.length - i) * 60000).toISOString(),
    captureOrigin: 'live'}));
  const result = await ingestEvents(session.id, events);
  return result.session;
}

async function handle(message, sender) {
  if (!message || typeof message.type !== 'string') throw new Error('Invalid request.');
  if (message.type === 'COLLECTOR_HELLO') return {session: await collectorSession(sender)};
  if (message.type === 'INGEST') {
    const session = await collectorSession(sender, message.sessionId);
    if (!session || session.status !== 'recording') return {accepted: false, reason: 'Session is paused or tab changed.'};
    const mode = collectorMode(sender);
    const events = (Array.isArray(message.events) ? message.events : []).slice(0, 1000)
      .map(event => sanitizeEvent(event, mode)).filter(Boolean);
    const {added} = await ingestEvents(session.id, events);
    return {accepted: true, added};
  }
  if (message.type === 'HEARTBEAT') {
    const session = await collectorSession(sender, message.sessionId);
    if (!session || session.status !== 'recording') return {accepted: false};
    const mode = collectorMode(sender);
    if (session.lastHeartbeatAt && Date.now() - Date.parse(session.lastHeartbeatAt) > 30000) {
      appendGap(session, 'Collector heartbeat interrupted; some messages may be missing');
    }
    const replay = mode === 'replay';
    session.lastHeartbeatAt = now();
    session.chatMode = text(message.chatMode, 120) || 'unknown';
    session.collectorState = message.chatPresent === false ? 'chat-missing' : replay ? 'replay' : 'watching';
    updateCaptureMode(session, mode);
    session.pageVisibility = text(message.pageVisibility, 32);
    if (message.chatPresent === false) appendGap(session, replay ? 'Chat replay panel is not available' : 'Live chat panel is not available');
    const dropped = Math.max(0, Number(message.droppedEvents) || 0);
    if (dropped > (session.reportedDroppedEvents || 0)) appendGap(session, `Collector queue dropped ${dropped} events; capture is incomplete`);
    session.reportedDroppedEvents = dropped;
    const errors = Math.max(0, Number(message.collectorErrors) || 0);
    if (errors > (session.reportedCollectorErrors || 0)) appendGap(session, 'Collector reported an error; check capture coverage');
    session.reportedCollectorErrors = errors;
    await putSession(session);
    return {accepted: true};
  }
  if (!trustedDashboard(sender)) throw new Error('This action must come from the extension dashboard.');
  switch (message.type) {
    case 'GET_STATE': {
      const sessions = await listSessions();
      return {sessions, session: await bindingFor(message.tabId) || sessions[0] || null, target: await getTarget(message.tabId)};
    }
    case 'START_SESSION': return {session: await start(message.tabId)};
    case 'RESUME_SESSION': return {session: await start(message.tabId, message.sessionId)};
    case 'PAUSE_SESSION': return {session: await pause(await drainBeforePause(await getSession(message.sessionId)))};
    case 'GET_SESSION': return {session: await getSession(message.sessionId)};
    case 'GET_EVENTS': return {events: await readEvents(message.sessionId, Math.min(1000, Math.max(1, Number(message.limit) || 200)))};
    case 'EXPORT_SESSION': return {session: await getSession(message.sessionId), events: await readEvents(message.sessionId)};
    case 'DELETE_SESSION': {
      const session = await getSession(message.sessionId);
      if (session) {
        await pause(session, 'Session deleted');
        const bound = await bindingFor(session.tabId);
        if (bound?.id === session.id) await chrome.storage.local.remove(bindingKey(session.tabId));
        await deleteSession(session.id);
      }
      return {};
    }
    case 'CREATE_DEMO': return {session: await createDemo()};
    default: throw new Error('Unknown request.');
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  serialize(() => handle(message, sender)).then(result => sendResponse({ok: true, ...result}), error =>
    sendResponse({ok: false, error: error?.name === 'QuotaExceededError'
      ? 'Local storage is full. Pause capture, export your data, and delete older sessions.' : error.message || 'Operation failed.'}));
  return true;
});

chrome.action.onClicked.addListener(tab => {
  void chrome.tabs.create({url: chrome.runtime.getURL(`dashboard.html?tab=${tab.id}`)});
});

chrome.tabs.onRemoved.addListener(tabId => {
  void serialize(async () => {
    const session = await bindingFor(tabId);
    if (session) await pause(session, 'The monitored tab was closed');
    await chrome.storage.local.remove(bindingKey(tabId));
  });
});

chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (!change.url && change.status !== 'loading') return;
  void serialize(async () => {
    const session = await bindingFor(tabId);
    if (!session || session.status !== 'recording') return;
    const target = await getTarget(tabId);
    if (!target || target.videoId !== session.videoId) {
      await pause(session, 'The monitored tab navigated away from this stream');
    } else if (change.status === 'loading') {
      appendGap(session, 'The monitored tab reloaded; messages during reload may be missing');
      session.collectorState = 'waiting';
      await putSession(session);
    }
  });
});

async function suspendPreviousSessions(reason) {
  for (const session of await listSessions()) if (session.status === 'recording') await pause(session, reason);
  const values = await chrome.storage.local.get(null);
  await chrome.storage.local.remove(Object.keys(values).filter(key => key.startsWith('tab:')));
}
chrome.runtime.onStartup.addListener(() => { void serialize(() => suspendPreviousSessions('Browser restarted; resume capture when ready')); });
chrome.runtime.onInstalled.addListener(details => {
  if (details.reason === 'update') void serialize(() => suspendPreviousSessions('Extension updated; refresh YouTube and resume capture'));
});
