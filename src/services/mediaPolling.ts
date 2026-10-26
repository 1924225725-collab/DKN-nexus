/**
 * Visibility-aware single-flight scheduler for the music window's media reads.
 *
 * Why this exists (B-02, `DKN_HANDOVER.md`): the music WebView is pre-created and
 * starts hidden, but its React tree mounts immediately. A plain `setInterval`
 * therefore kept calling `get_current_media` once per second forever, even while
 * the window was invisible — the hidden window drove real WinRT/GSMTC work and a
 * local CDP handshake every tick, and a slow query simply skipped a tick while
 * the pending CDP handshake stayed alive.
 *
 * Contract (deliberately small, no React and no Tauri imports so it is testable):
 *
 * - Reads are single-flight: at most one `read()` is outstanding at any time.
 * - A read is only started while the surface is visible and not disposed.
 * - The next read is scheduled only after the previous one settles, so a slow
 *   query can never queue up a backlog.
 * - `setVisible(false)` / `dispose()` cancel the pending timer immediately and
 *   bump the generation, so any late result from an already-started read is
 *   discarded instead of writing stale data into a hidden UI.
 * - `setVisible(false)` does NOT clear the in-flight fact: the underlying native
 *   call cannot be aborted, so re-showing while it is still running must not
 *   start a second concurrent read.
 * - `refreshNow()` (used after a control command) collapses into the same
 *   single-flight scheduling and never resurrects a hidden or disposed surface.
 * - Focus is not visibility: nothing here reacts to blur, so a visible but
 *   unfocused window keeps refreshing normally.
 */

/** Result of one `read()` call. `null` semantics belong to the caller. */
export type MediaPollReadResult<T> = T;

export interface MediaPollingOptions<T> {
  /** Performs one media read. Rejections are reported through `onError`. */
  read: () => Promise<MediaPollReadResult<T>>;
  /** Applies a fresh result. Never called for a stale generation. */
  apply: (value: MediaPollReadResult<T>) => void;
  /** Receives read failures; suppressed once the surface is hidden/disposed. */
  onError?: (error: unknown) => void;
  /** Normal refresh cadence while visible, in ms. */
  intervalMs?: number;
  /** Injected timer functions so tests can run on virtual time. */
  setTimer?: (handler: () => void, timeoutMs: number) => number;
  clearTimer?: (handle: number) => void;
}

export interface MediaPollingHandle {
  /** Latest requested visibility. */
  isVisible(): boolean;
  /** True while an underlying read is still outstanding. */
  isReadInFlight(): boolean;
  /** True while a next read is scheduled. */
  hasScheduledRead(): boolean;
  /** Current generation; increments on every visibility change and dispose. */
  generation(): number;
  /** Number of reads started so far (diagnostics/tests). */
  readCount(): number;
  /**
   * Sets visibility. Becoming visible reads immediately (unless a read is
   * already in flight); becoming hidden stops scheduling and invalidates
   * late results. Repeated calls with the same value are no-ops.
   */
  setVisible(visible: boolean): void;
  /**
   * Requests an out-of-band refresh (e.g. after a control command) through the
   * same single-flight scheduler. Ignored while hidden, disposed or busy.
   */
  refreshNow(): void;
  /** Cancels any pending timer and makes all late results inert. */
  dispose(): void;
}

const DEFAULT_INTERVAL_MS = 1000;

export function createMediaPolling<T>(options: MediaPollingOptions<T>): MediaPollingHandle {
  const {
    read,
    apply,
    onError,
    intervalMs = DEFAULT_INTERVAL_MS,
    setTimer = (handler, timeoutMs) => globalThis.setTimeout(handler, timeoutMs) as unknown as number,
    clearTimer = (handle) => globalThis.clearTimeout(handle),
  } = options;

  let visible = false;
  let disposed = false;
  let generation = 0;
  let readInFlight = false;
  let timer: number | null = null;
  let readCount = 0;

  function clearScheduledRead(): void {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  }

  /** Schedules the next read. Only ever called while visible and settled. */
  function schedule(): void {
    if (disposed || !visible || timer !== null || readInFlight) return;
    const scheduledGeneration = generation;
    timer = setTimer(() => {
      timer = null;
      // The surface may have been hidden between scheduling and firing.
      if (disposed || !visible || scheduledGeneration !== generation) return;
      startRead();
    }, intervalMs);
  }

  function startRead(): void {
    if (disposed || !visible || readInFlight) return;
    readInFlight = true;
    readCount += 1;
    const readGeneration = generation;

    let pending: Promise<MediaPollReadResult<T>>;
    try {
      pending = Promise.resolve(read());
    } catch (error) {
      pending = Promise.reject(error);
    }

    void pending.then(
      (value) => {
        readInFlight = false;
        // Drop the result when the surface was hidden/disposed (or re-shown,
        // which bumps the generation) while this read was outstanding.
        if (disposed) return;
        if (readGeneration !== generation) {
          // A stale result must not be applied, but its completion is still the
          // event that ends single-flight. If the surface is visible now (the
          // hide/show race), the loop must resume here — returning without
          // rescheduling would leave a visible window permanently stale.
          if (visible) startRead();
          return;
        }
        if (!visible) return;
        apply(value);
        schedule();
      },
      (error) => {
        readInFlight = false;
        if (disposed) return;
        if (readGeneration !== generation) {
          if (visible) startRead();
          return;
        }
        if (!visible) return;
        onError?.(error);
        // Keep the cadence after a failure; native backoff is handled in Rust.
        schedule();
      },
    );
  }

  return {
    isVisible: () => visible,
    isReadInFlight: () => readInFlight,
    hasScheduledRead: () => timer !== null,
    generation: () => generation,
    readCount: () => readCount,
    setVisible(next: boolean) {
      if (disposed || next === visible) return;
      visible = next;
      generation += 1;
      if (next) {
        // Read immediately, but never break single-flight: if the previous
        // read is still running (hide->show race), its completion schedules
        // the next round instead of starting a concurrent one.
        startRead();
      } else {
        clearScheduledRead();
      }
    },
    refreshNow() {
      if (disposed || !visible || readInFlight) return;
      clearScheduledRead();
      startRead();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      visible = false;
      generation += 1;
      clearScheduledRead();
    },
  };
}
