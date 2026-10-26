/**
 * Regression tests for the music-window lifecycle, now driven by the SAME
 * production helper that `MusicPlayerWindow` uses (`src/services/musicWindowLifecycle.ts`).
 *
 * Earlier versions of this file re-implemented the latch decision rule and the
 * startup handshake as test-local models. That let the component drift from the
 * test without either failing. Here the test imports the real implementation
 * and asserts its observable behaviour through injected adapters, so a broken
 * refactor fails this suite (R-03 / AC-03 / AC-04).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createMusicWindowLifecycle } from "../src/services/musicWindowLifecycle.ts";

/** Builds controllable adapters around the production lifecycle. */
function makeHarness() {
  let eventHandler = null;
  let listenerReleased = false;
  const visibleCalls = [];
  const pollingDisposed = [];
  let visibilityResult = Promise.resolve(false);
  let queryReject = null;

  const listen = (handler) => {
    eventHandler = handler;
    return Promise.resolve(() => {
      listenerReleased = true;
    });
  };
  const getVisibility = () => (queryReject ? Promise.reject(queryReject) : visibilityResult);
  const createPolling = () => ({
    setVisible: (v) => visibleCalls.push(v),
    dispose: () => pollingDisposed.push(true),
  });
  const onError = () => {};

  return {
    listen,
    getVisibility,
    createPolling,
    onError,
    // test controls:
    emit: (v) => eventHandler && eventHandler(v),
    deliverState: (v) => { visibilityResult = Promise.resolve(v); },
    failState: (err) => { queryReject = err; },
    releaseListenerNow: () => listenerReleased,
    visibleCalls,
    pollingDisposed,
    get eventHandler() { return eventHandler; },
  };
}

test("subscribe happens before the state query (so a lost transition is recovered)", async () => {
  const h = makeHarness();
  let queriedBeforeSubscribe = false;
  const subscribeOrder = [];
  const lifecycle = createMusicWindowLifecycle({
    createPolling: h.createPolling,
    listen: (handler) => { subscribeOrder.push("listen"); return h.listen(handler); },
    getVisibility: () => { subscribeOrder.push("query"); return h.getVisibility(); },
    applyVisible: () => {},
    onError: h.onError,
  });
  await lifecycle.start();
  assert.deepEqual(subscribeOrder, ["listen", "query"], "must subscribe before querying");
  lifecycle.dispose();
});

test("a startup visibility answer is dropped once an event arrived first", async () => {
  const h = makeHarness();
  const lifecycle = createMusicWindowLifecycle({
    createPolling: h.createPolling,
    listen: h.listen,
    getVisibility: h.getVisibility,
    applyVisible: () => {},
    onError: h.onError,
  });
  const started = lifecycle.start();
  // Rust shows the window while the read is still outstanding.
  h.emit(true);
  h.deliverState(false); // the (now stale) read would say hidden
  await started;
  // The stale answer must NOT reach the scheduler; the event wins.
  assert.deepEqual(h.visibleCalls, [true], "stale state read must be discarded");
  lifecycle.dispose();
});

test("a lost show transition is recovered by the state read, not an assumption", async () => {
  const h = makeHarness();
  // No event ever arrives; the window really is visible.
  h.deliverState(true);
  const lifecycle = createMusicWindowLifecycle({
    createPolling: h.createPolling,
    listen: h.listen,
    getVisibility: h.getVisibility,
    applyVisible: () => {},
    onError: h.onError,
  });
  await lifecycle.start();
  assert.deepEqual(h.visibleCalls, [true], "the state read must reveal the hidden show");
  lifecycle.dispose();
});

test("hidden really does mean hidden at startup — no blind polling", async () => {
  const h = makeHarness();
  h.deliverState(false);
  const lifecycle = createMusicWindowLifecycle({
    createPolling: h.createPolling,
    listen: h.listen,
    getVisibility: h.getVisibility,
    applyVisible: () => {},
    onError: h.onError,
  });
  await lifecycle.start();
  assert.deepEqual(h.visibleCalls, [false], "default hidden must not start polling");
  lifecycle.dispose();
});

test("a late listener callback is released on dispose and never updates state", async () => {
  const h = makeHarness();
  const lifecycle = createMusicWindowLifecycle({
    createPolling: h.createPolling,
    listen: h.listen,
    getVisibility: h.getVisibility,
    applyVisible: () => {},
    onError: h.onError,
  });
  await lifecycle.start();
  lifecycle.dispose();
  const before = h.visibleCalls.length;
  // A transition that arrives after dispose must be ignored.
  h.emit(true);
  assert.equal(h.visibleCalls.length, before, "post-dispose event must not change state");
  assert.equal(h.releaseListenerNow(), true, "listener must be released on dispose");
  assert.deepEqual(h.pollingDisposed, [true], "polling must be disposed");
});

test("StrictMode-style rebuild: a second lifecycle starts cleanly after dispose", async () => {
  const h = makeHarness();
  h.deliverState(true);
  const first = createMusicWindowLifecycle({
    createPolling: h.createPolling,
    listen: h.listen,
    getVisibility: h.getVisibility,
    applyVisible: () => {},
    onError: h.onError,
  });
  await first.start();
  first.dispose();

  const second = createMusicWindowLifecycle({
    createPolling: h.createPolling,
    listen: h.listen,
    getVisibility: h.getVisibility,
    applyVisible: () => {},
    onError: h.onError,
  });
  await second.start();
  // The rebuild observes the same visible state and does not crash or double-poll.
  assert.ok(h.visibleCalls.includes(true), "rebuild must re-apply current visibility");
  second.dispose();
});

test("subscribe failure does not crash and is reported through onError", async () => {
  const h = makeHarness();
  let reported = null;
  const lifecycle = createMusicWindowLifecycle({
    createPolling: h.createPolling,
    listen: () => Promise.reject(new Error("listen failed")),
    getVisibility: h.getVisibility,
    applyVisible: () => {},
    onError: (e) => { reported = e; },
  });
  await lifecycle.start();
  assert.ok(reported instanceof Error, "subscribe failure must surface via onError");
  assert.deepEqual(h.visibleCalls, [], "no polling starts when subscribe fails");
  lifecycle.dispose();
});

test("query failure leaves the window idle rather than polling blind", async () => {
  const h = makeHarness();
  h.failState(new Error("visibility query failed"));
  const lifecycle = createMusicWindowLifecycle({
    createPolling: h.createPolling,
    listen: h.listen,
    getVisibility: h.getVisibility,
    applyVisible: () => {},
    onError: () => {},
  });
  await lifecycle.start();
  // No setVisible call: stay idle; a later show event will start the loop.
  assert.deepEqual(h.visibleCalls, [], "failed query must not start polling");
  lifecycle.dispose();
});

/**
 * F-01 regression: a subscribe / query failure that arrives AFTER `dispose`
 * (or after a newer visibility event already took over the state) must NOT
 * write to a dead UI instance and must NOT call `onError`. The existing tests
 * above only cover failures that arrive while the instance is alive; these
 * cover the late / superseded failure paths that the r1 review flagged.
 */
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve: (v) => resolve(v), reject: (e) => reject(e) };
}

test("a subscribe failure after dispose is not reported to a dead instance (F-01)", async () => {
  const listenDeferred = deferred();
  const queryDeferred = deferred();
  const visibleCalls = [];
  let onErrorCount = 0;
  const lifecycle = createMusicWindowLifecycle({
    createPolling: () => ({ setVisible: (v) => visibleCalls.push(v), dispose: () => {} }),
    listen: () => listenDeferred.promise,
    getVisibility: () => queryDeferred.promise,
    applyVisible: () => {},
    onError: () => { onErrorCount++; },
  });
  const started = lifecycle.start();
  lifecycle.dispose(); // dispose while the subscription is still pending
  listenDeferred.reject(new Error("listen failed late"));
  await started;
  assert.equal(onErrorCount, 0, "late subscribe failure must not call onError after dispose");
  assert.deepEqual(visibleCalls, [], "no state applied to a disposed instance");
});

test("a visibility query failure after dispose is not reported to a dead instance (F-01)", async () => {
  const listenDeferred = deferred();
  const queryDeferred = deferred();
  const visibleCalls = [];
  let onErrorCount = 0;
  let listenerReleased = false;
  const lifecycle = createMusicWindowLifecycle({
    createPolling: () => ({ setVisible: (v) => visibleCalls.push(v), dispose: () => {} }),
    listen: () => listenDeferred.promise.then(() => () => { listenerReleased = true; }),
    getVisibility: () => queryDeferred.promise,
    applyVisible: () => {},
    onError: () => { onErrorCount++; },
  });
  const started = lifecycle.start();
  await listenDeferred.resolve(); // subscription succeeds
  // Let `start()` advance to the point where it calls getVisibility() (query now pending).
  await new Promise((r) => setTimeout(r, 0));
  lifecycle.dispose(); // dispose while the query is still pending
  queryDeferred.reject(new Error("query failed late"));
  await started;
  assert.equal(onErrorCount, 0, "late query failure must not call onError after dispose");
  assert.equal(listenerReleased, true, "listener must still be released exactly once");
});

test("a stale query failure after a newer event took over is not reported (F-01)", async () => {
  const listenDeferred = deferred();
  const queryDeferred = deferred();
  const visibleCalls = [];
  let onErrorCount = 0;
  let capturedHandler = null;
  const lifecycle = createMusicWindowLifecycle({
    createPolling: () => ({ setVisible: (v) => visibleCalls.push(v), dispose: () => {} }),
    listen: (handler) => { capturedHandler = handler; return listenDeferred.promise.then(() => () => {}); },
    getVisibility: () => queryDeferred.promise,
    applyVisible: () => {},
    onError: () => { onErrorCount++; },
  });
  const started = lifecycle.start();
  await listenDeferred.resolve();
  capturedHandler(true); // a newer event arrives and takes over the state
  queryDeferred.reject(new Error("stale query failed late")); // the now-superseded read fails
  await started;
  assert.equal(onErrorCount, 0, "a stale failure behind a newer event must not be reported");
  assert.deepEqual(visibleCalls, [true], "the newer event's state is what remains");
});

/**
 * r4 / L-01 (生命周期边界): listen pending -> dispose twice -> listen then
 * succeeds and returns an unlisten function. The listener must be released
 * EXACTLY once, polling disposed exactly once, and no query / state must occur.
 */
test("L-01: listen pending, dispose twice, then listen resolves", async () => {
  const listenDeferred = deferred();
  let queryCount = 0;
  let unlistenCalls = 0;
  let pollingDisposeCount = 0;
  let applyCount = 0;
  const lifecycle = createMusicWindowLifecycle({
    createPolling: () => ({ setVisible: () => {}, dispose: () => { pollingDisposeCount++; } }),
    listen: () => listenDeferred.promise.then(() => () => { unlistenCalls++; }),
    getVisibility: () => { queryCount++; return Promise.resolve(true); },
    applyVisible: () => { applyCount++; },
    onError: () => {},
  });
  const started = lifecycle.start();
  lifecycle.dispose();
  lifecycle.dispose(); // second dispose must be idempotent
  listenDeferred.resolve();
  await started;
  assert.equal(unlistenCalls, 1, "unlisten called exactly once");
  assert.equal(pollingDisposeCount, 1, "polling disposed exactly once");
  assert.equal(queryCount, 0, "no query after dispose");
  assert.equal(applyCount, 0, "no state applied after dispose");
});

/**
 * r4 / L-02: query pending -> dispose twice -> query resolves late and succeeds.
 * No state update, listener released exactly once.
 */
test("L-02: query pending, dispose twice, then query resolves late", async () => {
  const queryDeferred = deferred();
  let unlistenCalls = 0;
  let applyCount = 0;
  let setVisibleCount = 0;
  const lifecycle = createMusicWindowLifecycle({
    createPolling: () => ({ setVisible: () => { setVisibleCount++; }, dispose: () => {} }),
    listen: () => Promise.resolve(() => { unlistenCalls++; }),
    getVisibility: () => queryDeferred.promise,
    applyVisible: () => { applyCount++; },
    onError: () => {},
  });
  const started = lifecycle.start();
  await new Promise((r) => setTimeout(r, 0)); // let start() reach getVisibility()
  lifecycle.dispose();
  lifecycle.dispose(); // idempotent
  queryDeferred.resolve(true); // late SUCCESS
  await started;
  assert.equal(applyCount, 0, "late successful query must not apply state after dispose");
  assert.equal(setVisibleCount, 0, "no visible state change after dispose");
  assert.equal(unlistenCalls, 1, "listener released exactly once");
});

/**
 * r4 / L-03: listen/query failures AFTER dispose, and an old query failing after
 * a newer event — none may call onError on a dead / superseded instance.
 * (Guards the r2 F-01 fixes so they cannot regress.)
 */
test("L-03: late listen/query failures and superseded query keep onError silent", async () => {
  // (a) listen fails after dispose
  const listenDeferred = deferred();
  let onErrorCount = 0;
  const a = createMusicWindowLifecycle({
    createPolling: () => ({ setVisible: () => {}, dispose: () => {} }),
    listen: () => listenDeferred.promise,
    getVisibility: () => Promise.resolve(true),
    applyVisible: () => {},
    onError: () => { onErrorCount++; },
  });
  const startedA = a.start();
  a.dispose();
  listenDeferred.reject(new Error("listen failed after dispose"));
  await startedA;
  assert.equal(onErrorCount, 0, "listen failure after dispose is silent");

  // (b) query fails after dispose
  const queryDeferred = deferred();
  const b = createMusicWindowLifecycle({
    createPolling: () => ({ setVisible: () => {}, dispose: () => {} }),
    listen: () => Promise.resolve(() => {}),
    getVisibility: () => queryDeferred.promise,
    applyVisible: () => {},
    onError: () => { onErrorCount++; },
  });
  const startedB = b.start();
  await new Promise((r) => setTimeout(r, 0));
  b.dispose();
  queryDeferred.reject(new Error("query failed after dispose"));
  await startedB;
  assert.equal(onErrorCount, 0, "query failure after dispose is silent");

  // (c) an older query fails after a newer event already took over
  const staleDeferred = deferred();
  let handler = null;
  const c = createMusicWindowLifecycle({
    createPolling: () => ({ setVisible: () => {}, dispose: () => {} }),
    listen: (h) => { handler = h; return Promise.resolve(() => {}); },
    getVisibility: () => staleDeferred.promise,
    applyVisible: () => {},
    onError: () => { onErrorCount++; },
  });
  const startedC = c.start();
  await new Promise((r) => setTimeout(r, 0));
  handler(false); // newer event takes over
  staleDeferred.reject(new Error("superseded query failed"));
  await startedC;
  assert.equal(onErrorCount, 0, "a superseded query failure is silent");
});

/**
 * r4 / L-04: two instances rebuilt (StrictMode-style). The OLD instance must not
 * write state or leave a timer; the NEW instance starts/stops from real state.
 * A disposed instance must not be restarted.
 */
test("L-04: StrictMode-style rebuild leaves the old instance inert", async () => {
  let applyCount = 0;
  let setVisibleCount = 0;
  let pollingDisposeCount = 0;
  const makeInstance = () => createMusicWindowLifecycle({
    createPolling: () => ({ setVisible: () => { setVisibleCount++; }, dispose: () => { pollingDisposeCount++; } }),
    listen: () => Promise.resolve(() => {}),
    getVisibility: () => Promise.resolve(true),
    applyVisible: () => { applyCount++; },
    onError: () => {},
  });

  const first = makeInstance();
  await first.start();
  const afterFirst = applyCount;
  first.dispose();
  assert.equal(afterFirst, 1, "first instance applied the real visible state once");

  const second = makeInstance();
  await second.start();
  assert.equal(applyCount, 2, "second instance also applies state (it is the live one)");

  // Restarting a disposed instance must be a no-op: no further state writes.
  await first.start();
  assert.equal(applyCount, 2, "a disposed instance does not write state when restarted");
  assert.equal(pollingDisposeCount, 1, "only the first dispose released its polling");
});
