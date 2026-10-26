/**
 * Production music-window lifecycle, extracted from the MusicPlayerWindow effect
 * so the component AND the tests exercise the SAME implementation.
 *
 * Visibility is level-triggered state owned by Rust, delivered as an
 * edge-triggered `emit`. A Tauri emit is fire-and-forget: if Rust shows or
 * hides the window before this WebView registered its listener, the transition
 * is delivered nowhere and never replayed. Therefore the initial answer is
 * reconciled in the safe order: subscribe first, then read the CURRENT native
 * state.
 *
 * The remaining interleaving — an event arriving while the state read is still
 * outstanding, so the read's answer would be OLDER than the event — is guarded
 * by a latch: once any event has been seen, a late query answer is discarded.
 *
 * Contract (TASK_001 AC-03 / AC-04):
 *  - subscribe BEFORE query; a transition lost before listen() registered is
 *    recovered by the state query.
 *  - query answer is discarded if an event arrived while it was outstanding.
 *  - after dispose, a late query must NOT change state and a late listener
 *    callback must release immediately; no React writes, no blind polling.
 *  - subscribe / query failures surface through onError; no unhandled
 *    rejections, no `void start()` swallowing.
 */

export interface MusicWindowLifecycleDeps<T> {
  /** Creates the visibility-aware single-flight scheduler. */
  createPolling: () => {
    setVisible: (visible: boolean) => void;
    dispose: () => void;
  };
  /** Subscribes to the `dkn://music-visibility` event; resolves an unlisten fn. */
  listen: (handler: (visible: boolean) => void) => Promise<() => void>;
  /** Reads the music window's real native visibility. */
  getVisibility: () => Promise<boolean>;
  /** Applies a visibility change to the scheduler (and any UI state). */
  applyVisible: (visible: boolean) => void;
  /** Reports a subscribe / query failure. */
  onError?: (error: unknown) => void;
}

export interface MusicWindowLifecycle {
  start: () => Promise<void>;
  dispose: () => void;
}

export function createMusicWindowLifecycle<T>(
  deps: MusicWindowLifecycleDeps<T>,
): MusicWindowLifecycle {
  let disposed = false;
  let polling: { setVisible: (visible: boolean) => void; dispose: () => void } | null = null;
  let unlisten: (() => void) | null = null;
  let visibilityEventSeen = false;
  let started = false;

  const start = async (): Promise<void> => {
    if (started) return;
    started = true;

    polling = deps.createPolling();

    const handleEvent = (visible: boolean) => {
      if (disposed) return;
      visibilityEventSeen = true;
      polling?.setVisible(visible);
      deps.applyVisible(visible);
    };

    let stopListening: (() => void) | null = null;
    try {
      stopListening = await deps.listen(handleEvent);
    } catch (error) {
      // A subscribe failure after dispose belongs to a dead instance; never
      // surface it to the live UI. While alive, the failure is real and must be
      // reported so the user sees the channel could not be established.
      if (!disposed) deps.onError?.(error);
      // Without a listener we cannot reconcile; stay idle (hidden behaviour).
      return;
    }

    // A fast unmount can resolve the subscription after cleanup already ran.
    if (disposed) {
      stopListening();
      return;
    }
    unlisten = stopListening;

    try {
      const visible = await deps.getVisibility();
      // Discard this answer if an event arrived while it was outstanding: the
      // event is newer than the state this read observed.
      if (disposed || visibilityEventSeen) return;
      polling.setVisible(visible);
      deps.applyVisible(visible);
    } catch (error) {
      // A query failure only matters if this instance is still the live one AND
      // no newer event has already taken over the state. A late failure from a
      // stale read — whether superseded by an event or overtaken by dispose — is
      // not reported, so it cannot write to a dead or already-current instance.
      if (!disposed && !visibilityEventSeen) deps.onError?.(error);
      // Stay idle rather than polling blind; a later show event starts the loop.
    }
  };

  const dispose = () => {
    disposed = true;
    if (unlisten) {
      unlisten();
      unlisten = null;
    }
    if (polling) {
      polling.dispose();
      polling = null;
    }
  };

  return { start, dispose };
}
