/**
 * Production coordinator for hiding the main Nexus window.
 *
 * This is the single, testable place that owns the X / Esc "hide to tray"
 * contract. The React component only supplies the real Tauri adapters; tests
 * supply controllable Promises and a virtual timer so the exact call order and
 * the 900 ms boundary can be asserted.
 *
 * Contract (see TASK_001 AC-01 / AC-02):
 *  - A successful native hide does NOT fall back and does not touch the direct
 *    window API or the music linkage.
 *  - If the native command fails or does not settle within `timeoutMs`, the
 *    DIRECT window hide is started IMMEDIATELY and INDEPENDENTLY. It must not
 *    wait for the music linkage command to resolve.
 *  - The music linkage is fired as a side observation: its result (success,
 *    rejection, or never-resolving hang) is recorded but never blocks the
 *    direct hide and never becomes an unhandled rejection.
 *  - Repeated hide() calls while one is in flight share the SAME promise; no
 *    extra timers or fallback hides are stacked.
 *  - A Promise timeout here only means "the native call did not report back in
 *    time"; it does NOT cancel an in-flight WinRT/Tauri/window request. That
 *    boundary is reported honestly via onError, not hidden.
 */

export type HidePhase = "native" | "fallback" | "music";

export interface MainWindowHideDeps {
  /** Native hide command (Rust `hide_main_window`). */
  nativeHide: () => Promise<void>;
  /** Direct window hide through the JS window API (fallback only). */
  directHide: () => Promise<void>;
  /** Music-window linkage request used only on the fallback path. */
  musicLinkage: () => Promise<void>;
  /** Returns an opaque timer id; invoked after `timeoutMs` when native is silent. */
  createTimer: (ms: number, cb: () => void) => unknown;
  /** Cancels a timer previously returned by `createTimer`. */
  clearTimer: (id: unknown) => void;
  /** Observability hook for failures / never-settling native requests. */
  onError?: (error: unknown, phase: HidePhase) => void;
  /** Native hide timeout. Defaults to 900 ms. */
  timeoutMs?: number;
}

export interface MainWindowHide {
  /** Hides the window; concurrent calls share one in-flight promise. */
  hide: () => Promise<void>;
  /** Cancels any pending timer and releases references. */
  dispose: () => void;
}

export function createMainWindowHide(deps: MainWindowHideDeps): MainWindowHide {
  const timeoutMs = deps.timeoutMs ?? 900;
  let pending: Promise<void> | null = null;
  let timerId: unknown = undefined;
  let disposed = false;

  const clearTimer = () => {
    if (timerId !== undefined) {
      deps.clearTimer(timerId);
      timerId = undefined;
    }
  };

  // Build a Promise from an adapter call, converting a SYNCHRONOUS throw into a
  // rejection of this Promise. Without this boundary a sync throw escapes the
  // surrounding try/catch entirely (e.g. a throwing musicLinkage would block
  // the direct hide, and a throwing nativeHide would leak the timeout Promise).
  const safeCall = (fn: () => Promise<void>): Promise<void> => {
    try {
      return Promise.resolve(fn());
    } catch (error) {
      return Promise.reject(error);
    }
  };

  const hide = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (pending) return pending;

    pending = (async () => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimer();
      };

      // The timeout reject Promise is created up front. It is ALWAYS observed via
      // a no-op handler so that, regardless of whether the race wins or loses, it
      // can never become an unhandled "Native hide request timed out." rejection.
      const timeout = new Promise<never>((_, reject) => {
        timerId = deps.createTimer(timeoutMs, () =>
          reject(new Error("Native hide request timed out.")),
        );
      });
      timeout.catch(() => undefined);

      // Evaluate nativeHide through the safe boundary so a synchronous throw
      // becomes a rejected Promise instead of an escape from this async function.
      const nativeResult = safeCall(deps.nativeHide);

      try {
        await Promise.race([nativeResult, timeout]);
        finish();
        return; // native success: no fallback, no music linkage
      } catch (error) {
        // H-01: the native race has ended (native settled, rejected, or threw),
        // so the race timer must be cleared HERE — not only after the direct hide
        // settles. Otherwise a pending direct hide leaves an active timer that
        // still fires later, long after the native race is over.
        finish();

        // A dead instance must never start a new fallback after dispose, even if
        // a pending native request resolves or rejects after the timer was cleared.
        if (disposed) {
          return;
        }

        // Native hide failed or did not settle in time. Both the direct window
        // hide and the music linkage are started on the SAME fallback, but each
        // is observed independently: a pending or failing direct hide must not
        // prevent the music linkage from firing, and a pending or failing music
        // linkage must not prevent the direct hide from settling.
        deps.onError?.(error, "fallback");

        // Fire the music linkage FIRST and unconditionally, through the safe
        // boundary so a synchronous throw cannot escape and block the direct
        // hide. It is a side observation only and never affects the result.
        // H-02: the rejection is always CONSUMED, but once disposed the instance
        // is dead, so it must not emit further onError notifications.
        safeCall(deps.musicLinkage)
          .then(() => undefined)
          .catch((musicError) => { if (!disposed) deps.onError?.(musicError, "music"); });

        // The direct hide determines the result the caller awaits.
        try {
          await safeCall(deps.directHide);
        } catch (directError) {
          // H-02: the direct failure is still reported to the caller (the App
          // entry consumes it) — we never swallow it into a fake success. It is
          // only the diagnostic hook that is suppressed after dispose.
          if (!disposed) deps.onError?.(directError, "fallback");
          throw directError;
        } finally {
          finish();
        }
      }
    })().finally(() => {
      pending = null;
    });

    return pending;
  };

  const dispose = () => {
    disposed = true;
    clearTimer();
  };

  return { hide, dispose };
}
