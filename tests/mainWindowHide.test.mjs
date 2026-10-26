/**
 * Tests for the production main-window hide coordinator (`src/services/mainWindowHide.ts`).
 *
 * These assert the exact call order and the 900 ms boundary that TASK_001 AC-01 /
 * AC-02 require, using controllable Promises and a virtual timer. The component
 * supplies the real Tauri adapters; this suite supplies fakes so the contract is
 * enforced regardless of the OS window API.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createMainWindowHide } from "../src/services/mainWindowHide.ts";

/** A virtual timer: the test advances time manually, so no real waits. */
function makeVirtualClock() {
  let now = 0;
  const timers = new Map();
  let nextId = 1;
  let firedCount = 0;
  let clearedCount = 0;
  return {
    createTimer: (ms, cb) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, cb });
      return id;
    },
    clearTimer: (id) => {
      if (timers.delete(id)) clearedCount++;
    },
    /** Advance time past `ms` and fire any due timers. */
    advance: (ms) => {
      const target = now + ms;
      // Fire due timers in time order.
      let fired = true;
      while (fired) {
        fired = false;
        const due = [...timers.entries()]
          .filter(([, t]) => t.at <= target)
          .sort((a, b) => a[1].at - b[1].at);
        if (due.length) {
          const [id, t] = due[0];
          now = t.at;
          timers.delete(id);
          firedCount++;
          t.cb();
          fired = true;
        }
      }
      now = target;
    },
    get now() { return now; },
    /** Active (not fired, not cleared) timers — used to assert cleanup. */
    get active() { return timers.size; },
    get fired() { return firedCount; },
    get cleared() { return clearedCount; },
  };
}

/** A Promise that the test can resolve/reject externally. */
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve: (v) => resolve(v), reject: (e) => reject(e) };
}

function makeDeps(clock, overrides = {}) {
  const calls = { nativeHide: 0, directHide: 0, musicLinkage: 0 };
  const native = deferred();
  const direct = deferred();
  const music = deferred();
  const errors = [];
  const deps = {
    nativeHide: () => { calls.nativeHide++; return native.promise; },
    directHide: () => { calls.directHide++; return direct.promise; },
    musicLinkage: () => { calls.musicLinkage++; return music.promise; },
    createTimer: clock.createTimer,
    clearTimer: clock.clearTimer,
    onError: (e, phase) => errors.push({ e, phase }),
    timeoutMs: 900,
  };
  return {
    deps,
    calls,
    native, direct, music,
    errors,
    resolveNative: () => native.resolve(),
    rejectNative: (e) => native.reject(e ?? new Error("native failed")),
    resolveDirect: () => direct.resolve(),
    rejectDirect: (e) => direct.reject(e ?? new Error("direct failed")),
    resolveMusic: () => music.resolve(),
    rejectMusic: (e) => music.reject(e ?? new Error("music failed")),
  };
}

test("native success resolves without fallback or music linkage", async () => {
  const clock = makeVirtualClock();
  const ctx = makeDeps(clock);
  const coord = createMainWindowHide(ctx.deps);
  const p = coord.hide();
  ctx.resolveNative();
  await p;
  assert.equal(ctx.calls.nativeHide, 1);
  assert.equal(ctx.calls.directHide, 0, "no direct hide on native success");
  assert.equal(ctx.calls.musicLinkage, 0, "no music linkage on native success");
  assert.equal(ctx.errors.length, 0);
});

test("native timeout starts the direct hide independently of the music linkage", async () => {
  const clock = makeVirtualClock();
  const ctx = makeDeps(clock);
  const coord = createMainWindowHide(ctx.deps);
  const p = coord.hide();
  // Native never replies; advance past the 900 ms boundary.
  clock.advance(900);
  // The direct hide must be fired even though the music linkage has not resolved.
  ctx.resolveDirect();
  await p;
  assert.equal(ctx.calls.directHide, 1, "direct hide must fire on timeout");
  assert.equal(ctx.calls.musicLinkage, 1, "music linkage is observed on the fallback path");
  assert.equal(ctx.calls.directHide, 1, "direct hide is single-shot on the fallback path");
});

test("the music linkage never blocks the resolved direct hide", async () => {
  const clock = makeVirtualClock();
  const ctx = makeDeps(clock);
  const coord = createMainWindowHide(ctx.deps);
  const p = coord.hide();
  clock.advance(900);
  ctx.resolveDirect();
  await p; // must settle even though musicLinkage is still pending
  assert.equal(ctx.calls.directHide, 1);
  // Now the music command fails late — the hide must already be done, and the
  // failure is observed but not turned into an unhandled rejection.
  ctx.rejectMusic();
  // Let the music linkage's rejection propagate to its .catch handler.
  await new Promise((r) => setTimeout(r, 0));
  const musicErrors = ctx.errors.filter((e) => e.phase === "music");
  assert.equal(musicErrors.length, 1, "late music failure is recorded, not dropped");
});

test("repeated hide() calls share one in-flight promise (no stacked timers/hides)", async () => {
  const clock = makeVirtualClock();
  const ctx = makeDeps(clock);
  const coord = createMainWindowHide(ctx.deps);
  const a = coord.hide();
  const b = coord.hide();
  const c = coord.hide();
  assert.equal(a, b, "concurrent calls return the same promise");
  assert.equal(b, c);
  clock.advance(900);
  ctx.resolveDirect();
  await Promise.all([a, b, c]);
  assert.equal(ctx.calls.nativeHide, 1, "native requested once");
  assert.equal(ctx.calls.directHide, 1, "direct hide once");
  assert.equal(ctx.calls.musicLinkage, 1, "music linkage once");
});

test("a never-resolving native request still falls back and settles", async () => {
  const clock = makeVirtualClock();
  const ctx = makeDeps(clock);
  const coord = createMainWindowHide(ctx.deps);
  const p = coord.hide();
  clock.advance(900);
  ctx.resolveDirect();
  await p; // settles despite native() never resolving
  assert.equal(ctx.calls.directHide, 1);
  const fallbackErrors = ctx.errors.filter((e) => e.phase === "fallback");
  assert.equal(fallbackErrors.length, 1, "the timeout is recorded honestly");
});

test("dispose clears a pending timer so a dangling native never fires fallback", async () => {
  const clock = makeVirtualClock();
  const ctx = makeDeps(clock);
  const coord = createMainWindowHide(ctx.deps);
  const p = coord.hide();
  coord.dispose();
  // Even advancing far past the timeout must not start a fallback hide.
  clock.advance(5000);
  await Promise.resolve();
  assert.equal(ctx.calls.directHide, 0, "disposed coordinator does not fall back");
  assert.equal(ctx.errors.length, 0);
  // A dangling native request is not cancelled by dispose (that boundary is
  // reported honestly elsewhere); we therefore do not await the unsettled hide.
  assert.equal(p instanceof Promise, true);
});

/**
 * F-02 regression: when the fallback path is taken, the direct hide and the
 * music linkage must be started INDEPENDENTLY. A pending or rejecting direct
 * hide must not prevent the music linkage from firing, and a pending or
 * rejecting music linkage must not prevent the direct hide from settling.
 */

test("F-02: music linkage still fires when directHide is still pending (timeout fallback)", async () => {
  const clock = makeVirtualClock();
  const ctx = makeDeps(clock);
  const coord = createMainWindowHide(ctx.deps);
  const p = coord.hide();
  clock.advance(900); // native times out -> the catch runs on the next microtask
  // Let the fallback microtask run so musicLinkage is requested.
  await new Promise((r) => setTimeout(r, 0));
  // Do NOT resolve directHide yet; the music linkage must still have been fired.
  assert.equal(ctx.calls.musicLinkage, 1, "music linkage fires even while directHide is pending");
  ctx.resolveDirect();
  await p;
  assert.equal(ctx.calls.directHide, 1);
});

test("F-02: music linkage still fires when directHide rejects", async () => {
  const clock = makeVirtualClock();
  const ctx = makeDeps(clock);
  // A deferred that resolves when the music linkage has actually been requested.
  let musicRequestedResolve;
  const musicRequested = new Promise((r) => { musicRequestedResolve = r; });
  const wiredDeps = {
    ...ctx.deps,
    musicLinkage: () => { ctx.calls.musicLinkage++; musicRequestedResolve(); return ctx.music.promise; },
  };
  const coord = createMainWindowHide(wiredDeps);
  const p = coord.hide();
  const outcome = p.then(() => null, (e) => e); // observe result immediately, no unhandled rejection
  clock.advance(900);
  // Let the fallback catch run (it requests the music linkage) before we await
  // the linkage signal; node:test schedules microtasks tightly.
  await Promise.resolve();
  await Promise.resolve();
  // Wait until the fallback catch has demonstrably requested the music linkage.
  await musicRequested;
  assert.equal(ctx.calls.musicLinkage, 1, "music linkage requested before directHide settles");
  ctx.rejectDirect(new Error("direct failed"));
  ctx.resolveMusic();
  const err = await outcome;
  assert.ok(err instanceof Error && /direct failed/.test(err.message), "the hide rejects with the real direct failure");
});

test("F-02: a rejecting music linkage does not block the resolved direct hide (no unhandled rejection)", async () => {
  const clock = makeVirtualClock();
  const ctx = makeDeps(clock);
  let unhandled = false;
  const onUnhandled = (e) => { unhandled = true; };
  process.once("unhandledRejection", onUnhandled);
  const coord = createMainWindowHide(ctx.deps);
  const p = coord.hide();
  const outcome = p.then(() => null, (e) => e);
  clock.advance(900);
  await new Promise((r) => setTimeout(r, 0));
  ctx.resolveDirect();
  await outcome; // hide settles on the direct path
  ctx.rejectMusic(new Error("music failed"));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(unhandled, false, "a late music rejection must not leak as unhandledRejection");
  const musicErrors = ctx.errors.filter((e) => e.phase === "music");
  assert.equal(musicErrors.length, 1, "music failure is recorded through onError, phase=music");
  process.removeListener("unhandledRejection", onUnhandled);
});

test("F-02: a synchronous throw in directHide is observed and music still fires", async () => {
  const clock = makeVirtualClock();
  const ctx = makeDeps(clock);
  const syncDeps = {
    ...ctx.deps,
    directHide: () => { ctx.calls.directHide++; throw new Error("direct threw"); },
  };
  const coord = createMainWindowHide(syncDeps);
  const p = coord.hide();
  const outcome = p.then(() => null, (e) => e); // observe result immediately, no unhandled rejection
  clock.advance(900);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(ctx.calls.musicLinkage, 1, "music linkage still fires after a synchronous directHide throw");
  ctx.resolveMusic();
  const err = await outcome;
  assert.ok(err instanceof Error && /direct threw/.test(err.message), "the hide rejects with the direct throw");
});

/**
 * r3 / G-01 regression: a SYNCHRONOUS throw from `musicLinkage()` must not
 * escape the fallback catch and block the direct hide. Both sides are observed
 * through a controlled Promise boundary, so a sync throw on one side can never
 * prevent the other side from running.
 */
test("C-01/G-01: a synchronous throw in musicLinkage does not block the direct hide", async () => {
  const clock = makeVirtualClock();
  const ctx = makeDeps(clock);
  const syncDeps = {
    ...ctx.deps,
    musicLinkage: () => { ctx.calls.musicLinkage++; throw new Error("music threw sync"); },
  };
  const coord = createMainWindowHide(syncDeps);
  const p = coord.hide();
  clock.advance(900);
  // Let the fallback catch run (it must request the direct hide even though
  // musicLinkage throws synchronously).
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(ctx.calls.directHide, 1, "direct hide still fires when musicLinkage throws synchronously");
  ctx.resolveDirect();
  // The hide must settle on the direct result; the music sync throw is recorded
  // but never blocks or rejects the caller.
  await p;
  const fallbackErrors = ctx.errors.filter((e) => e.phase === "fallback");
  assert.equal(fallbackErrors.length, 1, "the native timeout is recorded once");
});

/**
 * r3 / G-02 regression: a SYNCHRONOUS throw from `nativeHide()` used to leave
 * the independently-created `timeout` Promise with no consumer, so when the
 * timer fired it became an unhandled "Native hide request timed out." rejection.
 * The native result is now built through a controlled boundary and the timeout
 * is always observed, so no leaked rejection survives the fallback.
 */
test("C-02/G-02: native synchronous throw does not leak a timeout rejection", async () => {
  const clock = makeVirtualClock();
  const ctx = makeDeps(clock);
  const syncDeps = {
    ...ctx.deps,
    nativeHide: () => { ctx.calls.nativeHide++; throw new Error("native threw sync"); },
  };
  const coord = createMainWindowHide(syncDeps);
  let unhandled = false;
  const onUnhandled = (e) => { unhandled = true; };
  process.once("unhandledRejection", onUnhandled);
  const p = coord.hide();
  // native threw synchronously -> catch runs -> fallback fires music + direct.
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(ctx.calls.musicLinkage, 1, "music linkage fires on native sync-throw fallback");
  assert.equal(ctx.calls.directHide, 1, "direct hide fires on native sync-throw fallback");
  // Advance past the timeout; the timeout promise must be observed, not leaked.
  clock.advance(900);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(unhandled, false, "no leaked timeout rejection when the timer fires after native settled");
  ctx.resolveDirect();
  await p; // the hide settles on the direct result
  const fallbackErrors = ctx.errors.filter((e) => e.phase === "fallback");
  assert.equal(fallbackErrors.length, 1, "the real native sync error is recorded once");
  process.removeListener("unhandledRejection", onUnhandled);
});

/**
 * r3 / G-03 regression: once the coordinator is disposed, a LATE native
 * rejection must NOT start a new fallback (music + direct). The catch checks
 * `disposed` and bails before issuing any new work.
 */
/**
 * r4 / C-09: the fallback has already been issued, then the coordinator is
 * disposed, and music + direct each settle late (reject / resolve). No extra
 * onError, no new calls, no unhandled rejection, no timer residue.
 */
test("C-09: dispose during fallback, then late music/direct settle", async () => {
  const clock = makeVirtualClock();
  const ctx = makeDeps(clock);
  const coord = createMainWindowHide(ctx.deps);
  let unhandled = false;
  const onUnhandled = () => { unhandled = true; };
  process.once("unhandledRejection", onUnhandled);
  try {
    const p = coord.hide();
    const outcome = p.then(() => null, (e) => e); // observe: direct failure is still returned
    clock.advance(900); // fallback issued
    await Promise.resolve();
    await Promise.resolve();
    const callsAfterFallback = { ...ctx.calls };
    const errorsAfterFallback = ctx.errors.length;

    coord.dispose();
    // music rejects late, direct resolves late
    ctx.rejectMusic(new Error("music late"));
    ctx.resolveDirect();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    assert.equal(ctx.calls.musicLinkage, callsAfterFallback.musicLinkage, "no new music call after dispose");
    assert.equal(ctx.calls.directHide, callsAfterFallback.directHide, "no new direct call after dispose");
    assert.equal(ctx.errors.length, errorsAfterFallback, "no extra onError after dispose");
    assert.equal(unhandled, false, "late rejections consumed, no unhandled rejection");
    assert.equal(clock.active, 0, "no timer residue");
    assert.equal(await outcome, null, "a late-resolving direct hide settles the hide cleanly");
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
  }
});

/**
 * r5 / C-02 (fixed matrix): native fails IMMEDIATELY + musicLinkage throws
 * SYNCHRONOUSLY + directHide FAILS. Both sides must be attempted, the music
 * throw must be contained, and the REAL direct error must propagate to the
 * caller (never replaced by the music failure).
 */
test("C-02: native immediate failure + music sync throw + direct failure", async () => {
  const clock = makeVirtualClock();
  const ctx = makeDeps(clock);
  const deps = {
    ...ctx.deps,
    musicLinkage: () => { ctx.calls.musicLinkage++; throw new Error("music threw sync"); },
  };
  const coord = createMainWindowHide(deps);
  let unhandled = false;
  const onUnhandled = () => { unhandled = true; };
  process.on("unhandledRejection", onUnhandled);
  try {
    const p = coord.hide();
    const outcome = p.then(() => null, (e) => e);
    ctx.rejectNative(new Error("native failed immediately"));
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(ctx.calls.musicLinkage, 1, "music linkage is attempted despite its sync throw");
    assert.equal(ctx.calls.directHide, 1, "direct hide is attempted independently");
    ctx.rejectDirect(new Error("direct failed"));
    const err = await outcome;
    assert.ok(err instanceof Error && /direct failed/.test(err.message),
      "the caller receives the REAL direct failure, not the music throw");
    assert.equal(unhandled, false, "no unhandled rejection from either side");
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
  }
});

/**
 * r5 / C-05 (fixed matrix): native pending -> dispose TWICE -> native then
 * SUCCEEDS. No fallback, no dead-instance hook, and cleanup must be idempotent.
 * (dispose does NOT cancel the underlying native request — that boundary stays.)
 */
test("C-05: native pending, dispose twice, then native succeeds", async () => {
  const clock = makeVirtualClock();
  const ctx = makeDeps(clock);
  const coord = createMainWindowHide(ctx.deps);
  const p = coord.hide();
  coord.dispose();
  coord.dispose(); // must be idempotent
  ctx.resolveNative(); // late SUCCESS, not failure
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(ctx.calls.musicLinkage, 0, "no fallback after dispose, even on late native success");
  assert.equal(ctx.calls.directHide, 0, "no direct hide after dispose");
  assert.equal(ctx.errors.length, 0, "a dead instance emits no hook");
  assert.equal(clock.active, 0, "timer cleaned up");
  await p; // settles cleanly on the native success
});

/**
 * r5 / C-07 (fixed matrix): the 899/900 ms boundary, repeated hide() sharing one
 * in-flight promise, native success, and a LATE native result — verified with
 * real timer/fallback counts rather than text assertions.
 */
test("C-07: 899/900ms boundary, repeated hide, and late native result", async () => {
  // (a) 899 ms: no fallback yet.
  const clockA = makeVirtualClock();
  const ctxA = makeDeps(clockA);
  const coordA = createMainWindowHide(ctxA.deps);
  const pa = coordA.hide();
  clockA.advance(899);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(ctxA.calls.directHide, 0, "no fallback at 899 ms");
  assert.equal(ctxA.calls.musicLinkage, 0, "no music linkage at 899 ms");
  // (b) 900 ms: fallback fires exactly once.
  clockA.advance(1);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(ctxA.calls.directHide, 1, "fallback fires at 900 ms");
  assert.equal(ctxA.calls.musicLinkage, 1, "music linkage fires once with the fallback");
  ctxA.resolveDirect();
  ctxA.resolveMusic();
  await pa;

  // (c) repeated hide() shares ONE in-flight promise: one native, one fallback.
  const clockB = makeVirtualClock();
  const ctxB = makeDeps(clockB);
  const coordB = createMainWindowHide(ctxB.deps);
  const b1 = coordB.hide();
  const b2 = coordB.hide();
  const b3 = coordB.hide();
  assert.equal(b1, b2, "concurrent calls share one promise");
  assert.equal(b2, b3, "concurrent calls share one promise");
  clockB.advance(900);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(ctxB.calls.nativeHide, 1, "native requested once");
  assert.equal(ctxB.calls.directHide, 1, "single fallback, not stacked");
  assert.equal(ctxB.calls.musicLinkage, 1, "music linkage once");
  ctxB.resolveDirect();
  ctxB.resolveMusic();
  await Promise.all([b1, b2, b3]);

  // (d) native success: no fallback at all, and the timer is cleared.
  const clockC = makeVirtualClock();
  const ctxC = makeDeps(clockC);
  const coordC = createMainWindowHide(ctxC.deps);
  const pc = coordC.hide();
  ctxC.resolveNative();
  await pc;
  assert.equal(ctxC.calls.directHide, 0, "native success performs no fallback");
  assert.equal(ctxC.calls.musicLinkage, 0, "native success touches no music linkage");
  assert.equal(clockC.active, 0, "timer cleared after native success");
});

/**
 * r6 / C-07-L1..L4 (H-04, 5/10 测试／验证): the REAL late-native interleavings.
 *
 * r5's C-07 only covered the 899/900 ms boundary, promise sharing and an
 * IMMEDIATE native success. The regression matrix nevertheless claimed a "late
 * native result" was covered (that mismatch is r6's H-04B). These four cases
 * drive the production `createMainWindowHide` with a native request that is
 * still pending when the 900 ms fallback fires, and then settle native AFTER
 * the fallback has already been issued.
 *
 * Production contract under test (`src/services/mainWindowHide.ts`):
 *  - the fallback (music + direct) is started once when the native race ends;
 *  - the caller's result is decided by `directHide` alone; a late native
 *    settle must never complete, replace or re-trigger that result;
 *  - the native race timer is already cleared at race end;
 *  - a late native rejection must not leak as an unhandled rejection.
 *
 * Every scenario asserts the same invariants: one native / one direct / one
 * music call, no active timer, no extra timer fire after the late settle, and
 * no unexpected `onError` hook growth across the late settle.
 */

/** Shared invariant checks for the four C-07 late-native scenarios. */
function assertSingleShotInvariants(ctx, clock, label) {
  assert.equal(ctx.calls.nativeHide, 1, `${label}: native requested exactly once`);
  assert.equal(ctx.calls.directHide, 1, `${label}: direct hide issued exactly once`);
  assert.equal(ctx.calls.musicLinkage, 1, `${label}: music linkage issued exactly once`);
  assert.equal(clock.active, 0, `${label}: no active race timer`);
}

/** Let pending microtasks and timers drain across a real event-loop turn. */
const drain = () => new Promise((r) => setTimeout(r, 0));

test("C-07-L1: late native SUCCESS after the fallback must not complete the hide before direct", async () => {
  const clock = makeVirtualClock();
  const ctx = makeDeps(clock);
  const coord = createMainWindowHide(ctx.deps);

  let settled = false;
  const p = coord.hide();
  p.then(() => { settled = true; }, () => { settled = true; });

  // Native is still pending: advance exactly to the 900 ms boundary.
  clock.advance(900);
  await drain();
  assert.equal(ctx.calls.directHide, 1, "L1: fallback direct hide fires at 900 ms while native is pending");
  assert.equal(ctx.calls.musicLinkage, 1, "L1: music linkage fires with the fallback");
  assert.equal(settled, false, "L1: hide is NOT settled while direct is still pending");

  const errorsBefore = ctx.errors.length;
  const firedBefore = clock.fired;
  const activeBeforeLate = clock.active;

  // Native reports SUCCESS late — after the fallback already started.
  ctx.resolveNative();
  await drain();
  await drain();

  assert.equal(settled, false, "L1: a late native success must NOT complete the hide while direct is pending");
  assert.equal(ctx.calls.directHide, 1, "L1: late native success must not start a second fallback");
  assert.equal(ctx.calls.musicLinkage, 1, "L1: late native success must not re-fire the music linkage");
  assert.equal(clock.fired, firedBefore, "L1: no extra timer fire after the late native success");

  // The direct hide is still the result the caller waits on.
  ctx.resolveDirect();
  ctx.resolveMusic();
  await p;
  assert.equal(settled, true, "L1: hide settles once direct succeeds");

  assertSingleShotInvariants(ctx, clock, "L1");
  assert.equal(clock.active, activeBeforeLate, "L1: late native success does not resurrect the timer");
  assert.equal(ctx.errors.length, errorsBefore, "L1: a late native success adds no error hook");
});

test("C-07-L2: late native FAILURE after the fallback must not replace the direct error object", async () => {
  const clock = makeVirtualClock();
  const ctx = makeDeps(clock);
  const coord = createMainWindowHide(ctx.deps);

  let unhandled = false;
  const onUnhandled = () => { unhandled = true; };
  process.on("unhandledRejection", onUnhandled);
  try {
    const p = coord.hide();
    // Observe the hide result immediately so the direct failure is never
    // reported as an unhandled rejection.
    const outcome = p.then(() => null, (e) => e);

    clock.advance(900);
    await drain();
    assert.equal(ctx.calls.directHide, 1, "L2: fallback direct hide fires at 900 ms");
    assert.equal(ctx.calls.musicLinkage, 1, "L2: music linkage fires once");

    const errorsBefore = ctx.errors.length;
    const firedBefore = clock.fired;

    // Native FAILS late, after the fallback was already issued.
    const nativeError = new Error("native failed late");
    ctx.rejectNative(nativeError);
    await drain();
    await drain();

    assert.equal(ctx.calls.directHide, 1, "L2: late native failure must not start a second fallback");
    assert.equal(ctx.calls.musicLinkage, 1, "L2: late native failure must not re-fire the music linkage");
    assert.equal(clock.fired, firedBefore, "L2: no extra timer fire after the late native failure");

    // Direct fails too: the caller must receive the DIRECT error object itself.
    const directError = new Error("direct failed");
    ctx.rejectDirect(directError);
    ctx.resolveMusic();

    const err = await outcome;
    assert.equal(err, directError, "L2: the caller receives the identical direct Error object, not the native error");
    assert.notEqual(err, nativeError, "L2: the late native error must not replace the direct error");

    await drain();
    assert.equal(unhandled, false, "L2: the late native rejection is observed, not leaked as unhandled");

    assertSingleShotInvariants(ctx, clock, "L2");
    const fallbackErrors = ctx.errors.filter((e) => e.phase === "fallback");
    assert.ok(fallbackErrors.length >= 1, "L2: the timeout fallback was recorded");
    assert.equal(ctx.errors.length, errorsBefore + 1, "L2: only the direct failure adds one hook after the late native failure");
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
  }
});

test("C-07-L3: late native FAILURE after direct already succeeded must not revoke the success", async () => {
  const clock = makeVirtualClock();
  const ctx = makeDeps(clock);
  const coord = createMainWindowHide(ctx.deps);

  let unhandled = false;
  const onUnhandled = () => { unhandled = true; };
  process.on("unhandledRejection", onUnhandled);
  try {
    const p = coord.hide();

    clock.advance(900);
    await drain();
    assert.equal(ctx.calls.directHide, 1, "L3: fallback direct hide fires at 900 ms");

    // Direct settles successfully BEFORE the native request reports back.
    ctx.resolveDirect();
    ctx.resolveMusic();
    await p; // the hide is complete and successful here

    const errorsAfterSuccess = ctx.errors.length;
    const firedBefore = clock.fired;

    // The native request now rejects, long after the hide already succeeded.
    ctx.rejectNative(new Error("native rejected after success"));
    await drain();
    await drain();

    assert.equal(ctx.calls.directHide, 1, "L3: no second fallback after the hide already succeeded");
    assert.equal(ctx.calls.musicLinkage, 1, "L3: no second music linkage after success");
    assert.equal(clock.fired, firedBefore, "L3: no extra timer fire after the late native rejection");
    assert.equal(unhandled, false, "L3: the late native rejection after success is observed, not unhandled");
    assert.equal(ctx.errors.length, errorsAfterSuccess, "L3: a late native rejection after success adds no hook");

    assertSingleShotInvariants(ctx, clock, "L3");
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
  }
});

test("C-07-L4: late native SUCCESS after direct already failed must not cover the real error", async () => {
  const clock = makeVirtualClock();
  const ctx = makeDeps(clock);
  const coord = createMainWindowHide(ctx.deps);

  let unhandled = false;
  const onUnhandled = () => { unhandled = true; };
  process.on("unhandledRejection", onUnhandled);
  try {
    const p = coord.hide();
    const outcome = p.then(() => null, (e) => e);

    clock.advance(900);
    await drain();
    assert.equal(ctx.calls.directHide, 1, "L4: fallback direct hide fires at 900 ms");

    // Direct FAILS and settles before the native request reports back.
    const directError = new Error("direct failed first");
    ctx.rejectDirect(directError);
    ctx.resolveMusic();

    const err = await outcome;
    assert.equal(err, directError, "L4: the caller receives the real direct error");

    const errorsAfterFailure = ctx.errors.length;
    const firedBefore = clock.fired;

    // The native request now SUCCEEDS, long after the hide already failed.
    ctx.resolveNative();
    await drain();
    await drain();

    assert.equal(ctx.calls.directHide, 1, "L4: no second fallback after the direct failure settled");
    assert.equal(ctx.calls.musicLinkage, 1, "L4: no second music linkage after the direct failure settled");
    assert.equal(clock.fired, firedBefore, "L4: no extra timer fire after the late native success");
    assert.equal(unhandled, false, "L4: no unhandled rejection across the late native success");
    assert.equal(ctx.errors.length, errorsAfterFailure, "L4: a late native success adds no hook");

    // The recorded outcome is unchanged: the late success did not flip it.
    assert.equal(await outcome, directError, "L4: the late native success must not overwrite the direct failure");

    assertSingleShotInvariants(ctx, clock, "L4");
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
  }
});

test("C-03/G-03: dispose after a pending native suppresses the late fallback", async () => {
  const clock = makeVirtualClock();
  const ctx = makeDeps(clock);
  const coord = createMainWindowHide(ctx.deps);
  const p = coord.hide();
  coord.dispose(); // native is still pending here
  ctx.rejectNative(new Error("native rejected late"));
  // Let the late native rejection reach the catch, then assert no new work.
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(ctx.calls.musicLinkage, 0, "no music linkage after dispose");
  assert.equal(ctx.calls.directHide, 0, "no direct hide after dispose");
  assert.equal(ctx.errors.length, 0, "a dead instance reports no error");
  // The hide promise is unsettled (native was never observed); do not await it.
  assert.equal(p instanceof Promise, true);
});

/**
 * r4 / H-01 (3/10, 生命周期/异步: timer清理): when the native race has ended
 * (native settled/rejected/sync-threw) but the direct hide is still PENDING,
 * the race timer must already be cleared. It must not stay active and fire later.
 */
test("H-01: the race timer is cleared at native-race end even while direct is pending", async () => {
  const clock = makeVirtualClock();
  const ctx = makeDeps(clock);
  const coord = createMainWindowHide(ctx.deps);
  const p = coord.hide();
  // Native FAILS IMMEDIATELY (not a timeout): the race ends without the timer
  // ever firing, so the timer must be cleared explicitly at race end.
  ctx.rejectNative(new Error("native failed"));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(ctx.calls.directHide, 1, "fallback issued the direct hide");
  // The native race is over; the timer must already be cleared (active === 0),
  // even though directHide is still pending (finish() runs only after it settles).
  assert.equal(clock.active, 0, "race timer cleared at native-race end, not only after direct settles");
  // Advancing well past the timeout must not fire the stale timer.
  const firedBefore = clock.fired;
  clock.advance(901);
  await Promise.resolve();
  assert.equal(clock.fired, firedBefore, "no extra timer fire after the native race ended");
  ctx.resolveDirect();
  ctx.resolveMusic();
  await p;
});

/**
 * r4 / H-02 (3/10, 生命周期/异步: 失效错误回调): after the fallback has been
 * issued and the coordinator is DISPOSED, late music/direct rejections must
 * still be consumed (no unhandled rejection) but must NOT call onError again.
 */
test("H-02: after dispose, late music/direct failures add no onError hooks", async () => {
  const clock = makeVirtualClock();
  const ctx = makeDeps(clock);
  const coord = createMainWindowHide(ctx.deps);
  let unhandled = false;
  const onUnhandled = () => { unhandled = true; };
  process.once("unhandledRejection", onUnhandled);
  try {
    const p = coord.hide();
    // Observe the hide result immediately: the direct failure is still returned
    // to the caller (never swallowed into a fake success), so it must be handled.
    const outcome = p.then(() => null, (e) => e);
    clock.advance(900); // fallback issued: music + direct requested
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(ctx.calls.musicLinkage, 1);
    assert.equal(ctx.calls.directHide, 1);
    const errorsAfterFallback = ctx.errors.length;
    // Now dispose mid-fallback, then let both late results reject.
    coord.dispose();
    ctx.rejectMusic(new Error("music failed late"));
    ctx.rejectDirect(new Error("direct failed late"));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(ctx.errors.length, errorsAfterFallback, "disposed instance reports no extra onError");
    assert.equal(unhandled, false, "late rejections are still consumed, no unhandled rejection");
    // The real direct failure is still surfaced to the caller.
    const err = await outcome;
    assert.ok(err instanceof Error && /direct failed late/.test(err.message), "the real direct failure is preserved for the caller");
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
  }
});
