/* Synthetic DOM workload only. Loaded by stress_browser.py, never by the extension. */
(() => {
  'use strict';

  const MAX_SAMPLES = 4000;
  let run = null;
  let timer = null;

  function numberOption(config, name, fallback, minimum, integer = false) {
    const value = config[name] === undefined ? fallback : Number(config[name]);
    if (!Number.isFinite(value) || value < minimum || (integer && !Number.isSafeInteger(value))) {
      throw new Error(`Invalid ${name}: expected ${integer ? 'an integer' : 'a finite number'} >= ${minimum}.`);
    }
    return value;
  }

  function settings(config) {
    const durationSeconds = numberOption(config, 'durationSeconds', 7200, Number.MIN_VALUE);
    const paidRate = numberOption(config, 'paidRate', 10, 0);
    const chatRate = numberOption(config, 'chatRate', 0, 0);
    const timeScale = numberOption(config, 'timeScale', 1, Number.MIN_VALUE);
    const expectedPaid = Math.floor(durationSeconds * paidRate);
    const expectedChat = Math.floor(durationSeconds * chatRate);
    const total = expectedPaid + expectedChat;
    if (!Number.isSafeInteger(total) || total < 1) throw new Error('The workload must contain a safe, positive event count.');
    const plannedWallSeconds = durationSeconds / timeScale;
    if (!Number.isFinite(plannedWallSeconds)) throw new Error('The wall-clock duration must be finite.');
    return {
      durationSeconds, paidRate, chatRate, timeScale, expectedPaid, expectedChat, plannedWallSeconds,
      duplicateEvery: numberOption(config, 'duplicateEvery', 20, 0, true),
      domRows: numberOption(config, 'domRows', 200, 1, true),
      maxPerTick: numberOption(config, 'maxPerTick', 500, 1, true),
      messageLength: numberOption(config, 'messageLength', 200, 64, true),
      burstEverySeconds: numberOption(config, 'burstEverySeconds', 0, 0),
      burstFactor: numberOption(config, 'burstFactor', 1, 1),
      // Enforce the sample bound even if callers request every event.
      sampleEvery: Math.max(
        numberOption(config, 'sampleEvery', Math.max(1, Math.ceil(total / 2000)), 1, true),
        Math.ceil(total / MAX_SAMPLES),
      ),
    };
  }

  function compressedTime(logicalTime) {
    const {burstEverySeconds: period, burstFactor: factor} = run.config;
    if (!period || factor === 1) return logicalTime;
    const block = Math.floor(logicalTime / period);
    return block * period + (logicalTime - block * period) / factor;
  }

  function scheduledTime(kind, index) {
    const rate = kind === 'paid' ? run.config.paidRate : run.config.chatRate;
    return rate > 0 ? compressedTime(index / rate) : Infinity;
  }

  // Invert the optional compressed-block schedule to count currently due events.
  function dueCount(kind, logicalNow) {
    const rate = kind === 'paid' ? run.config.paidRate : run.config.chatRate;
    const expected = kind === 'paid' ? run.config.expectedPaid : run.config.expectedChat;
    if (!rate || !expected) return 0;
    const {burstEverySeconds: period, burstFactor: factor} = run.config;
    let originalTime = logicalNow;
    if (period && factor > 1) {
      const block = Math.floor(logicalNow / period);
      originalTime = block * period + Math.min(period, (logicalNow - block * period) * factor);
      // During the idle portion, the first event of the next block is not due yet.
      if (logicalNow - block * period >= period / factor) {
        return Math.min(expected, Math.max(0, Math.ceil(originalTime * rate - 1e-7)));
      }
    }
    return Math.min(expected, Math.max(0, Math.floor(originalTime * rate + 1e-7) + 1));
  }

  function span(id, value) {
    const element = document.createElement('span');
    element.id = id;
    element.textContent = value;
    return element;
  }

  function appendBounded(row) {
    while (run.container.children.length >= run.config.domRows) run.container.firstElementChild.remove();
    run.container.appendChild(row);
    run.maxDomRows = Math.max(run.maxDomRows, run.container.children.length);
  }

  function emit(kind, index, logicalScheduled) {
    const id = `stress-${kind}-${String(index).padStart(9, '0')}`;
    const paid = kind === 'paid';
    const row = document.createElement(paid ? 'yt-live-chat-paid-message-renderer' : 'yt-live-chat-text-message-renderer');
    row.id = id;
    row.appendChild(span('timestamp', `T+${(index / (paid ? run.config.paidRate : run.config.chatRate)).toFixed(3)}s`));
    row.appendChild(span('author-name', paid ? `Supporter ${index % 1000}` : `Viewer ${index % 1000}`));
    if (paid) row.appendChild(span('purchase-amount', 'USD 1.00'));
    row.appendChild(span('message', `Synthetic ${kind} event ${index}`.padEnd(run.config.messageLength, 'x')));
    const generatedAtMs = Date.now();
    const elapsedMs = performance.now() - run.startedPerformanceMs;
    const scheduledOffsetMs = logicalScheduled * 1000 / run.config.timeScale;
    const lateness = Math.max(0, elapsedMs - scheduledOffsetMs);
    run.maxScheduleLatenessMs = Math.max(run.maxScheduleLatenessMs, lateness);
    const ordinal = run.generatedPaid + run.generatedChat;
    if (ordinal % run.config.sampleEvery === 0 && run.samples.length < MAX_SAMPLES) {
      run.samples.push({eventId: `yt:${id}`, generatedAtMs,
        scheduledAtMs: run.startedAtMs + scheduledOffsetMs, kind});
      run.scheduleLatenessSamplesMs.push(lateness);
    }
    appendBounded(row);
    if (paid) {
      run.generatedPaid += 1;
      if (run.config.duplicateEvery && (index + 1) % run.config.duplicateEvery === 0) {
        appendBounded(row.cloneNode(true));
        run.duplicateClones += 1;
      }
    } else run.generatedChat += 1;
  }

  function finish(done, error = null) {
    clearTimeout(timer);
    timer = null;
    run.done = done;
    run.stopped = !done;
    run.error = error;
    run.endedAtMs = Date.now();
    run.endedPerformanceMs = performance.now();
  }

  function tick() {
    if (!run || run.done || run.stopped) return;
    try {
      if (!run.container.isConnected) throw new Error('The synthetic chat container was detached.');
      const elapsedMs = performance.now() - run.startedPerformanceMs;
      const logicalNow = elapsedMs * run.config.timeScale / 1000;
      const backlog = Math.max(0, dueCount('paid', logicalNow) - run.generatedPaid)
        + Math.max(0, dueCount('chat', logicalNow) - run.generatedChat);
      run.maxDueBacklog = Math.max(run.maxDueBacklog, backlog);
      let emitted = 0;
      while (emitted < run.config.maxPerTick) {
        const paidTime = run.generatedPaid < run.config.expectedPaid ? scheduledTime('paid', run.generatedPaid) : Infinity;
        const chatTime = run.generatedChat < run.config.expectedChat ? scheduledTime('chat', run.generatedChat) : Infinity;
        const kind = paidTime <= chatTime ? 'paid' : 'chat';
        const nextTime = Math.min(paidTime, chatTime);
        if (!Number.isFinite(nextTime) || nextTime > logicalNow + 1e-9) break;
        emit(kind, kind === 'paid' ? run.generatedPaid : run.generatedChat, nextTime);
        emitted += 1;
      }
      if (run.generatedPaid === run.config.expectedPaid && run.generatedChat === run.config.expectedChat
          && elapsedMs >= run.config.plannedWallSeconds * 1000) {
        finish(true);
      } else {
        // Yield after bounded work. Catch-up ticks run promptly, but lateness is
        // still measured against the original target schedule rather than reset.
        timer = setTimeout(tick, emitted === run.config.maxPerTick ? 0 : 20);
      }
    } catch (error) {
      finish(false, String(error?.message || error));
    }
  }

  function snapshot() {
    if (!run) return {started: false};
    const elapsedMs = (run.endedPerformanceMs ?? performance.now()) - run.startedPerformanceMs;
    const {config} = run;
    return {
      started: true, startedAtMs: run.startedAtMs, endedAtMs: run.endedAtMs,
      done: run.done, stopped: run.stopped, error: run.error,
      generatedPaid: run.generatedPaid, generatedChat: run.generatedChat,
      duplicateClones: run.duplicateClones, expectedPaid: config.expectedPaid, expectedChat: config.expectedChat,
      elapsedWallSeconds: elapsedMs / 1000,
      logicalSeconds: Math.min(config.durationSeconds, elapsedMs * config.timeScale / 1000),
      plannedWallSeconds: config.plannedWallSeconds,
      durationOverrunMs: Math.max(0, elapsedMs - config.plannedWallSeconds * 1000),
      maxScheduleLatenessMs: run.maxScheduleLatenessMs, maxDueBacklog: run.maxDueBacklog,
      maxDomRows: run.maxDomRows, currentDomRows: run.container.children.length,
      samples: run.samples.map(sample => ({...sample})), sampledCount: run.samples.length,
      scheduleLatenessSamplesMs: [...run.scheduleLatenessSamplesMs],
      config: {...config},
      messageTextProfile: `ASCII only; exactly ${config.messageLength} characters per message.`,
      scheduleDescription: config.burstEverySeconds && config.burstFactor > 1
        ? `Each ${config.burstEverySeconds}s logical block is compressed into its first ${config.burstEverySeconds / config.burstFactor}s; event totals are unchanged.`
        : 'Uniform logical schedule; event zero is due at the start.',
      timingDescription: config.timeScale === 1 ? 'Real-time workload.' : `Accelerated ${config.timeScale}x workload; not a real-time soak.`,
    };
  }

  function start(config = {}) {
    if (run && !run.done && !run.stopped) throw new Error('A workload is already running. Stop it before starting another.');
    const normalized = settings(config);
    const container = document.querySelector('yt-live-chat-item-list-renderer #items');
    if (!container) throw new Error('Synthetic live-chat #items container is missing.');
    if (container.children.length) throw new Error('Start the workload with an empty synthetic chat list.');
    run = {
      config: normalized, container, startedAtMs: Date.now(), startedPerformanceMs: performance.now(),
      endedAtMs: null, endedPerformanceMs: null, done: false, stopped: false, error: null,
      generatedPaid: 0, generatedChat: 0, duplicateClones: 0,
      maxScheduleLatenessMs: 0, maxDueBacklog: 0, maxDomRows: 0,
      samples: [], scheduleLatenessSamplesMs: [],
    };
    tick();
    return snapshot();
  }

  function stop() {
    if (run && !run.done && !run.stopped) finish(false);
    return snapshot();
  }

  globalThis.StreamStudyStress = Object.freeze({start, snapshot, stop});
})();
