/**
 * Contract tests for `src/services/mediaPolling.ts`.
 *
 * These cover the frontend half of the B-02 patch: hidden surfaces must not
 * read, reads are single-flight, late results from a hidden or disposed surface
 * are inert, and a failing read cannot spin. Everything runs on virtual time
 * with controlled promises — no Windows APIs, no network, no real sleeping.
 *
 * Run with: npm run test:media
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createMediaPolling } from "../src/services/mediaPolling.ts";

/**
 * Deterministic timer queue.
 *
 * `setTimer`/`clearTimer`/`advance` are synchronous on purpose: a test may hold
 * a read's promise open forever, so an `async advance` would hang waiting on a
 * read it is deliberately not settling. Tests that need reads to settle either
 * call `resolveAt`/`rejectAt`, or use `runHealthyCadence`.
 */
function createClock() {
  let now = 0;
  let nextHandle = 1;
  const timers = new Map();

  const setTimer = (handler, timeoutMs) => {
    const handle = nextHandle++;
    timers.set(handle, { at: now + timeoutMs, handler });
    return handle;
  };
  const clearTimer = (handle) => {
    timers.delete(handle);
  };
  /** Fires due timers in order. `onTick` runs after each one. */
  const advance = (ms, onTick) => {
    const target = now + ms;
    for (;;) {
      let due = null;
      for (const [handle, timer] of timers) {
        if (timer.at <= target && (due === null || timer.at < due.timer.at)) due = { handle, timer };
      }
      if (!due) break;
      timers.delete(due.handle);
      now = due.timer.at;
      due.timer.handler();
      onTick?.();
    }
    now = target;
  };

  return { setTimer, clearTimer, advance, pendingTimers: () => timers.size };
}

/** Flushes the microtask queue so settled reads are observed by the scheduler. */
function drainMicrotasks() {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Records every `read()` call. Each entry keeps a `settled` flag so cadence
 * helpers can resolve exactly the reads that are still outstanding.
 */
function createReadLog() {
  const entries = [];
  const read = () => new Promise((resolve, reject) => entries.push({ resolve, reject, settled: false }));
  const settle = (entry, value) => {
    entry.settled = true;
    entry.resolve(value);
  };
  const fail = (entry, error) => {
    entry.settled = true;
    entry.reject(error);
  };
  return {
    read,
    entries,
    started: () => entries.length,
    outstanding: () => entries.filter((entry) => !entry.settled),
    resolveAt: async (index, value) => {
      settle(entries[index], value);
      await drainMicrotasks();
    },
    rejectAt: async (index, error) => {
      fail(entries[index], error);
      await drainMicrotasks();
    },
    /** Resolves every outstanding read (used by the healthy-cadence helper). */
    settleOutstanding: (value) => {
      for (const entry of entries) if (!entry.settled) settle(entry, value);
    },
  };
}

function createHarness({ intervalMs = 1000 } = {}) {
  const clock = createClock();
  const reads = createReadLog();
  const applied = [];
  const errors = [];
  const polling = createMediaPolling({
    read: reads.read,
    apply: (value) => applied.push(value),
    onError: (error) => errors.push(error),
    intervalMs,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return { clock, reads, applied, errors, polling, intervalMs };
}

/**
 * Advances `ms` of virtual time, auto-settling each read the scheduler starts.
 *
 * The scheduler re-arms its timer from a promise callback (single-flight: the
 * next read is only scheduled once the previous one settles), and promise
 * callbacks run on the microtask queue. A synchronous timer loop would therefore
 * fire one tick and stall, never seeing the next scheduled timer. This helper
 * steps in one interval at a time and drains the microtask queue in between, so
 * the cadence is observed exactly as it runs in the browser.
 *
 * Returns the number of reads started during the window.
 */
async function runHealthyCadence(harness, ms) {
  const { clock, reads } = harness;
  const before = reads.started();
  for (let elapsed = 0; elapsed < ms; elapsed += harness.intervalMs) {
    clock.advance(harness.intervalMs, () => reads.settleOutstanding({ title: "tick" }));
    await drainMicrotasks();
  }
  return reads.started() - before;
}

/**
 * Like `runHealthyCadence`, but every read the scheduler starts is rejected.
 * Returns the number of reads started during the window.
 */
async function runFailingCadence(harness, ms, error = new Error("media session unavailable")) {
  const { clock, reads } = harness;
  const before = reads.started();
  for (let elapsed = 0; elapsed < ms; elapsed += harness.intervalMs) {
    clock.advance(harness.intervalMs, () => {
      for (const entry of reads.outstanding()) {
        entry.settled = true;
        entry.reject(error);
      }
    });
    await drainMicrotasks();
  }
  return reads.started() - before;
}

test("a hidden surface never reads, and resuming visibility restarts cleanly", async () => {
  // Pins the timer path that actually protects against hidden polling: the
  // follow-up read armed while visible must not fire after the surface hides.
  //
  // Note on `startRead`'s own `!visible` guard: every call site already
  // establishes `visible === true` before calling, so that term is unreachable
  // and cannot be detected by any black-box test (verified by enumerating the
  // call sites in work/media-stability-1.6.18/check-guard-reachability.mjs). It
  // is deliberately kept as defence-in-depth. The behaviour below is the
  // observable guarantee; the guard is not.
  const harness = createHarness();
  const { clock, reads, polling } = harness;

  polling.setVisible(true);
  await reads.resolveAt(0, { title: "first" });
  assert.equal(polling.hasScheduledRead(), true, "a follow-up read is armed");
  const startedBefore = reads.started();

  // Hide, then advance past the armed timer. `setVisible(false)` clears the
  // timer, so this also confirms the timer cannot outlive the hide.
  polling.setVisible(false);
  assert.equal(polling.hasScheduledRead(), false, "hide must disarm the timer");
  clock.advance(10_000);
  await drainMicrotasks();

  assert.equal(reads.started(), startedBefore, "no read may start while hidden");
  assert.equal(polling.isReadInFlight(), false);

  // And the guarantee is not vacuous: once visible again, reads resume.
  polling.setVisible(true);
  assert.equal(reads.started(), startedBefore + 1);
  polling.dispose();
});

test("initial hidden state never reads, even over a long stretch of virtual time", async () => {
  const { clock, reads, applied, polling } = createHarness();

  clock.advance(30_000);
  await drainMicrotasks();

  assert.equal(reads.started(), 0);
  assert.equal(applied.length, 0);
  assert.equal(polling.hasScheduledRead(), false);
  assert.equal(polling.isVisible(), false);
  polling.dispose();
});

test("show reads immediately, then keeps a ~1s cadence", async () => {
  const harness = createHarness();
  const { reads, applied, polling } = harness;

  polling.setVisible(true);
  assert.equal(reads.started(), 1, "show must trigger one immediate read");

  await reads.resolveAt(0, { title: "first" });
  assert.deepEqual(applied, [{ title: "first" }]);
  assert.equal(polling.hasScheduledRead(), true);

  const started = await runHealthyCadence(harness, 3000);
  assert.equal(started, 3, "one read per interval while visible");
  polling.dispose();
});

test("repeated show calls are idempotent and do not stack loops", async () => {
  const harness = createHarness();
  const { reads, polling } = harness;

  polling.setVisible(true);
  polling.setVisible(true);
  polling.setVisible(true);
  assert.equal(reads.started(), 1, "repeated show must not start extra reads");

  // Settle the immediate read, then observe one read per interval window —
  // not one per show call.
  await reads.resolveAt(0, { title: "first" });
  const started = await runHealthyCadence(harness, 3000);
  assert.equal(started, 3, "expected exactly one read per interval window");
  polling.dispose();
});

test("a slow read never exceeds one concurrent call across many intervals", async () => {
  const harness = createHarness();
  const { clock, reads, polling } = harness;

  polling.setVisible(true);
  assert.equal(reads.started(), 1);

  // Advance well past several refresh windows without settling the read.
  clock.advance(5000);
  await drainMicrotasks();

  assert.equal(reads.started(), 1, "slow read must not queue a backlog");
  assert.equal(polling.isReadInFlight(), true);
  assert.equal(clock.pendingTimers(), 0, "no next read is scheduled while one is in flight");
  reads.settleOutstanding({ title: "slow" });

  assert.equal(reads.started(), 1, "still nothing started before the microtask drain");
  await drainMicrotasks();

  // The settled read re-arms the cadence, so exactly one more read starts.
  const started = await runHealthyCadence(harness, 1000);
  assert.equal(started, 1, "cadence resumes after the slow read settles");
  polling.dispose();
});

test("hide during an in-flight read cancels the timer and discards the late result", async () => {
  const { clock, reads, applied, polling } = createHarness();

  polling.setVisible(true);
  const generationBeforeHide = polling.generation();

  polling.setVisible(false);
  assert.equal(polling.hasScheduledRead(), false, "hide must clear the pending timer");
  assert.equal(polling.generation() > generationBeforeHide, true);

  // The underlying native call cannot be aborted, so its result arrives late.
  await reads.resolveAt(0, { title: "stale" });
  assert.equal(applied.length, 0, "late result from a hidden surface must not be applied");
  assert.equal(polling.hasScheduledRead(), false, "hide must not reschedule");

  clock.advance(10_000);
  await drainMicrotasks();
  assert.equal(reads.started(), 1, "hidden surface must not start new reads");
  polling.dispose();
});

test("hide then immediate show does not create a concurrent read and recovers after the old one settles", async () => {
  const harness = createHarness();
  const { reads, applied, polling } = harness;

  polling.setVisible(true);
  assert.equal(reads.started(), 1);
  const staleGeneration = polling.generation();

  // Fast toggle while the first native read is still outstanding.
  polling.setVisible(false);
  polling.setVisible(true);

  assert.equal(reads.started(), 1, "re-show must not break single-flight");
  assert.equal(polling.isReadInFlight(), true);
  assert.equal(polling.generation() > staleGeneration, true);
  assert.equal(polling.hasScheduledRead(), false, "still waiting on the outstanding read");

  // The pre-hide read settles: its value is stale and must be dropped. Its
  // completion is also what ends single-flight, so a fresh read starts right
  // away rather than waiting for the next interval.
  await reads.resolveAt(0, { title: "stale" });
  assert.equal(applied.length, 0, "a read started before the hide must not be applied");
  assert.equal(reads.started(), 2, "a fresh read must resume as soon as single-flight ends");
  assert.equal(polling.isReadInFlight(), true);

  // The fresh read carries the current generation, so its result is applied and
  // the normal cadence continues.
  await reads.resolveAt(1, { title: "fresh" });
  assert.deepEqual(applied, [{ title: "fresh" }], "the fresh result becomes the current state");

  const started = await runHealthyCadence(harness, 1000);
  assert.equal(started, 1, "the normal cadence is back");
  polling.dispose();
});

test("focus is not visibility: only setVisible changes the schedule", async () => {
  const harness = createHarness();
  const { reads, polling } = harness;

  polling.setVisible(true);
  await reads.resolveAt(0, { title: "a" });

  // Blur/focus is not modelled here at all: the module exposes no focus input.
  // A visible surface must therefore keep ticking regardless of focus.
  const started = await runHealthyCadence(harness, 2000);
  assert.equal(started, 2, "a visible window keeps refreshing while unfocused");
  assert.equal(polling.isVisible(), true);
  polling.dispose();
});

test("dispose cancels timers, invalidates late results and is idempotent", async () => {
  const { clock, reads, applied, polling } = createHarness();

  polling.setVisible(true);
  const generationBeforeDispose = polling.generation();

  polling.dispose();
  assert.equal(polling.hasScheduledRead(), false);
  assert.equal(polling.generation() > generationBeforeDispose, true);
  assert.equal(polling.isVisible(), false);
  polling.dispose();

  await reads.resolveAt(0, { title: "late" });
  assert.equal(applied.length, 0, "no state update after dispose");

  clock.advance(10_000);
  await drainMicrotasks();
  assert.equal(reads.started(), 1, "a disposed scheduler must stay silent");
});

test("StrictMode-style remount leaves no residual timer from the unmounted instance", async () => {
  const first = createHarness();
  const second = createHarness();

  // First mount: visible, one read started, then immediately torn down.
  first.polling.setVisible(true);
  assert.equal(first.reads.started(), 1);
  first.polling.dispose();

  // Second mount of the same effect body, in a fresh instance.
  second.polling.setVisible(true);

  first.clock.advance(30_000);
  await drainMicrotasks();

  assert.equal(first.reads.started(), 1, "the disposed instance must not keep polling");
  assert.equal(first.applied.length, 0, "the disposed instance must not apply results");
  assert.equal(second.reads.started(), 1, "the live instance is the one that polls");

  second.polling.dispose();
});

test("refreshNow after a control command respects visibility and single-flight", async () => {
  const harness = createHarness();
  const { clock, reads, polling } = harness;

  // Hidden: a command's post-refresh must not resurrect the poll loop.
  polling.refreshNow();
  assert.equal(reads.started(), 0);
  clock.advance(5000);
  await drainMicrotasks();
  assert.equal(reads.started(), 0);

  // Visible: refreshNow pulls the next read forward instead of adding a timer.
  polling.setVisible(true);
  assert.equal(reads.started(), 1, "initial show read");
  await reads.resolveAt(0, { title: "a" });
  assert.equal(polling.hasScheduledRead(), true);

  polling.refreshNow();
  assert.equal(reads.started(), 2, "refreshNow reads immediately");
  assert.equal(polling.hasScheduledRead(), false, "the deferred timer was replaced");

  // Busy: while a read is outstanding, refreshNow must not add a second one.
  polling.refreshNow();
  assert.equal(reads.started(), 2);

  await reads.resolveAt(1, { title: "b" });
  const started = await runHealthyCadence(harness, 1000);
  assert.equal(started, 1, "cadence continues after the refresh");
  polling.dispose();
});

test("a control refresh racing a hide does not revive the hidden surface", async () => {
  const { clock, reads, polling } = createHarness();

  polling.setVisible(true);
  await reads.resolveAt(0, { title: "a" });

  // The command's post-control refresh is requested, then the window hides.
  polling.setVisible(false);
  polling.refreshNow();

  clock.advance(5000);
  await drainMicrotasks();

  assert.equal(reads.started(), 1, "no read may start after the hide");
  assert.equal(polling.hasScheduledRead(), false);
  polling.dispose();
});

test("failures keep a bounded cadence and recover on success", async () => {
  const harness = createHarness();
  const { reads, applied, errors, polling } = harness;

  polling.setVisible(true);
  await reads.rejectAt(0, new Error("media session unavailable"));
  assert.equal(errors.length, 1);

  // Failures must not hot-loop: still one read per interval, not per microtask.
  const failuresDuringWindow = await runFailingCadence(harness, 3000);

  assert.equal(failuresDuringWindow, 3, "one failure per interval window");
  assert.equal(errors.length, 4, "one failure report per interval, not a storm");
  assert.equal(polling.isVisible(), true);

  const started = await runHealthyCadence(harness, 1000);
  assert.equal(started, 1, "cadence continues after recovery");
  assert.deepEqual(applied, [{ title: "tick" }], "a healthy read is applied again");
  polling.dispose();
});

test("a rejection arriving after hide is not reported to the UI", async () => {
  const { clock, reads, errors, polling } = createHarness();

  polling.setVisible(true);
  polling.setVisible(false);
  await reads.rejectAt(0, new Error("late failure"));

  assert.equal(errors.length, 0, "hidden surfaces must not surface read failures");

  clock.advance(10_000);
  await drainMicrotasks();
  assert.equal(reads.started(), 1);
  polling.dispose();
});

test("setVisible is last-write-wins: a stale visibility answer must not be replayed", async () => {
  // Documents the boundary of this module's guarantee. The scheduler cannot
  // tell a fresh visibility decision from a stale one — both arrive as
  // setVisible(bool) — so callers that query visibility asynchronously must
  // discard an answer that an event overtook. MusicPlayerWindow does that with
  // its `visibilityEventSeen` latch; this test pins the scheduler-side contract
  // so the responsibility stays explicit rather than assumed.
  const harness = createHarness();
  const { reads, polling } = harness;

  // 1. Rust hides the window and emits the event; the scheduler is told false.
  polling.setVisible(false);
  assert.equal(polling.isVisible(), false);
  assert.equal(reads.started(), 0);

  // 2. A late startup isVisible() query resolves with the pre-hide value.
  polling.setVisible(true);

  // The scheduler obeys it. This is why the component must not forward a stale
  // answer: without the latch, a hidden window would resume polling here.
  assert.equal(polling.isVisible(), true);
  assert.equal(reads.started(), 1, "the scheduler reads because it was told it is visible");

  polling.dispose();
});
