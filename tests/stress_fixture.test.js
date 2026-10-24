// Tests the synthetic source's schedule using a controlled clock. This does not
// simulate the extension or measure real browser performance.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('./stress_fixture.js', import.meta.url), 'utf8');

function runGenerator(config) {
  let time = 0;
  let nextTimer = 0;
  const timers = new Map();
  class Element {
    constructor(tagName) { this.tagName = tagName; this.children = []; this.parent = null; this.id = ''; this.textContent = ''; }
    appendChild(child) { child.remove(); this.children.push(child); child.parent = this; return child; }
    remove() {
      if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);
      this.parent = null;
    }
    cloneNode(deep) {
      const clone = new Element(this.tagName);
      clone.id = this.id;
      clone.textContent = this.textContent;
      if (deep) for (const child of this.children) clone.appendChild(child.cloneNode(true));
      return clone;
    }
    get firstElementChild() { return this.children[0] || null; }
    get isConnected() { return true; }
  }
  const container = new Element('div');
  const sandbox = {
    document: {querySelector: () => container, createElement: name => new Element(name)},
    performance: {now: () => time},
    Date: {now: () => 1800000000000 + time},
    setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, {fn, at: time + delay}); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  sandbox.StreamStudyStress.start(config);
  let ticks = 0;
  while (timers.size) {
    assert.ok(++ticks < 1_000_000, 'Generator must terminate');
    const [id, next] = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    timers.delete(id);
    time = next.at;
    next.fn();
  }
  return {result: sandbox.StreamStudyStress.snapshot(), container};
}

test('stress source schedules exactly 72,000 paid events in two logical hours', () => {
  const {result, container} = runGenerator({durationSeconds: 7200, paidRate: 10, chatRate: 0});
  assert.equal(result.done, true);
  assert.equal(result.generatedPaid, 72000);
  assert.equal(result.generatedChat, 0);
  assert.equal(result.duplicateClones, 3600);
  assert.ok(result.maxDomRows <= 200);
  assert.ok(container.children.length <= 200);
  assert.equal(result.elapsedWallSeconds, 7200);
  assert.ok(result.samples.length <= 4000);
});

test('mixed workload preserves independent paid and ordinary-message counts', () => {
  const {result} = runGenerator({durationSeconds: 60, paidRate: 10, chatRate: 100});
  assert.equal(result.done, true);
  assert.equal(result.generatedPaid, 600);
  assert.equal(result.generatedChat, 6000);
  assert.equal(result.duplicateClones, 30);
  assert.ok(result.maxDomRows <= 200);
});

test('burst scheduling changes arrival pattern without changing totals', () => {
  const {result} = runGenerator({durationSeconds: 120, paidRate: 10, chatRate: 10,
    burstEverySeconds: 60, burstFactor: 5});
  assert.equal(result.done, true);
  assert.equal(result.generatedPaid, 1200);
  assert.equal(result.generatedChat, 1200);
  assert.ok(result.scheduleDescription.includes('compressed'));
});

test('accelerated source changes wall duration and labels itself accordingly', () => {
  const {result} = runGenerator({durationSeconds: 60, paidRate: 10, chatRate: 0, timeScale: 6});
  assert.equal(result.done, true);
  assert.equal(result.generatedPaid, 600);
  assert.equal(result.elapsedWallSeconds, 10);
  assert.ok(result.timingDescription.includes('not a real-time soak'));
});
