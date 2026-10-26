import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

/** Keeps a closing overlay mounted just long enough to play its exit motion. */
export function MotionPresence({ show, duration = 210, children }: { show: boolean; duration?: number; children: ReactNode }) {
  const [mounted, setMounted] = useState(show);
  const [exiting, setExiting] = useState(false);
  const retained = useRef<ReactNode>(show ? children : null);
  const timer = useRef<number | undefined>(undefined);
  if (show) retained.current = children;

  useEffect(() => {
    if (timer.current !== undefined) window.clearTimeout(timer.current);
    if (show) {
      setMounted(true);
      setExiting(false);
    } else if (mounted) {
      setExiting(true);
      timer.current = window.setTimeout(() => {
        setMounted(false);
        setExiting(false);
        retained.current = null;
        timer.current = undefined;
      }, duration);
    }
    return () => { if (timer.current !== undefined) window.clearTimeout(timer.current); };
  }, [duration, mounted, show]);

  if (!mounted) return null;
  return <div className={`motion-presence ${exiting ? "is-exiting" : "is-visible"}`} aria-hidden={exiting || undefined}>
    {show ? children : retained.current}
  </div>;
}
