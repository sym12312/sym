const DATABASE = 'stream-study-v1';
let databasePromise;

export function openDatabase() {
  if (!databasePromise) databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      const sessions = db.createObjectStore('sessions', {keyPath: 'id'});
      sessions.createIndex('startedAt', 'startedAt');
      const events = db.createObjectStore('events', {keyPath: ['sessionId', 'eventId']});
      events.createIndex('sessionId', 'sessionId');
      events.createIndex('sessionTime', ['sessionId', 'observedAt']);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return databasePromise;
}

const requestResult = request => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

async function transact(stores, mode, action) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(stores, mode);
    let result;
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error('Storage operation was interrupted.'));
    Promise.resolve(action(transaction)).then(value => { result = value; }).catch(error => {
      try { transaction.abort(); } catch { /* Already finished. */ }
      reject(error);
    });
  });
}

export function blankStats() {
  return {chatCount: 0, paidCount: 0, countedPaidCount: 0, unresolvedPaidCount: 0,
    membershipCount: 0, giftCount: 0, totals: {}};
}

export function isCountable(event) {
  return ['superchat', 'supersticker'].includes(event.type) && event.idQuality === 'youtube'
    && /^[A-Z]{3}$/.test(event.currency || '') && /^\d+$/.test(event.amountMicros || '')
    && BigInt(event.amountMicros) > 0n && !event.amountIssue;
}

export function adjustStats(stats, event, direction) {
  if (event.type === 'chat') stats.chatCount += direction;
  else if (event.type === 'membership') stats.membershipCount += direction;
  else if (event.type === 'gift') stats.giftCount += direction;
  else if (['superchat', 'supersticker'].includes(event.type)) {
    stats.paidCount += direction;
    if (isCountable(event)) {
      stats.countedPaidCount += direction;
      const previous = BigInt(stats.totals[event.currency] || '0');
      const amount = previous + BigInt(direction) * BigInt(event.amountMicros);
      if (amount === 0n) delete stats.totals[event.currency];
      else stats.totals[event.currency] = amount.toString();
    } else stats.unresolvedPaidCount += direction;
  }
  return stats;
}

export const getSession = id => transact(['sessions'], 'readonly', tx =>
  requestResult(tx.objectStore('sessions').get(id)));

export const listSessions = () => transact(['sessions'], 'readonly', async tx => {
  const sessions = await requestResult(tx.objectStore('sessions').getAll());
  return sessions.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
});

export const putSession = session => transact(['sessions'], 'readwrite', async tx => {
  await requestResult(tx.objectStore('sessions').put(session));
  return session;
});

export async function ingestEvents(sessionId, incoming) {
  return transact(['sessions', 'events'], 'readwrite', async tx => {
    const sessionStore = tx.objectStore('sessions');
    const store = tx.objectStore('events');
    const session = await requestResult(sessionStore.get(sessionId));
    if (!session) throw new Error('This session no longer exists.');
    let added = 0;
    for (const raw of incoming) {
      const event = {...raw, sessionId};
      if (event.supersedesEventId && event.supersedesEventId !== event.eventId) {
        const previousElement = await requestResult(store.get([sessionId, event.supersedesEventId]));
        if (previousElement?.idQuality === 'element') {
          adjustStats(session.stats, previousElement, -1);
          session.eventCount -= 1;
          await requestResult(store.delete([sessionId, event.supersedesEventId]));
        }
      }
      delete event.supersedesEventId;
      const previous = await requestResult(store.get([sessionId, event.eventId]));
      if (previous) {
        // A re-render may fill in an amount or edit/remove a comment. Keep first observation time.
        event.observedAt = previous.observedAt;
        event.captureOrigin = previous.captureOrigin;
        event.lastSeenAt = raw.observedAt;
        // Do not erase complete purchase data when an element is temporarily empty during re-render.
        if (!event.purchaseText && previous.purchaseText) {
          for (const key of ['purchaseText', 'currency', 'amountMicros', 'amountIssue']) event[key] = previous[key];
        }
        adjustStats(session.stats, previous, -1);
      } else {
        added += 1;
        session.eventCount += 1;
      }
      adjustStats(session.stats, event, 1);
      await requestResult(store.put(event));
    }
    session.updatedAt = new Date().toISOString();
    await requestResult(sessionStore.put(session));
    return {session, added};
  });
}

export const readEvents = (sessionId, limit = null) => transact(['events'], 'readonly', tx =>
  new Promise((resolve, reject) => {
    const index = tx.objectStore('events').index('sessionTime');
    const range = IDBKeyRange.bound([sessionId, ''], [sessionId, '\uffff']);
    const request = index.openCursor(range, limit ? 'prev' : 'next');
    const events = [];
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || (limit && events.length >= limit)) { resolve(events); return; }
      events.push(cursor.value);
      cursor.continue();
    };
  }));

export const deleteSession = sessionId => transact(['sessions', 'events'], 'readwrite', async tx => {
  await requestResult(tx.objectStore('sessions').delete(sessionId));
  const store = tx.objectStore('events');
  const keys = await requestResult(store.index('sessionId').getAllKeys(sessionId));
  for (const key of keys) await requestResult(store.delete(key));
});
