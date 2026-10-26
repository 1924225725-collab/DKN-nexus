import { useLayoutEffect, useRef } from "react";
import type { ReactNode } from "react";

type TransitionVariant = "page" | "category" | "selection" | "conversation";

/**
 * A single-surface transition. The previous content is removed by React before
 * the new surface moves into place, so two pages can never be painted together.
 */
export function TransitionSwap({ transitionKey, children, className = "", variant = "selection", duration = 220 }: {
  transitionKey: string;
  children: ReactNode;
  className?: string;
  variant?: TransitionVariant;
  duration?: number;
}) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const previousKey = useRef(transitionKey);
  const activeAnimation = useRef<Animation | null>(null);

  useLayoutEffect(() => {
    if (previousKey.current === transitionKey) return;
    previousKey.current = transitionKey;

    const surface = surfaceRef.current;
    if (!surface) return;

    const previous = activeAnimation.current;
    const computedTransform = getComputedStyle(surface).transform;
    const currentX = previous && computedTransform !== "none"
      ? new DOMMatrixReadOnly(computedTransform).m41
      : 24;
    previous?.cancel();

    activeAnimation.current = surface.animate([
      { opacity: 1, transform: `translate3d(${currentX}px,0,0)` },
      { opacity: 1, transform: "translate3d(0,0,0)" },
    ], {
      duration: Math.max(160, duration),
      easing: "cubic-bezier(.22,.74,.2,1)",
      fill: "none",
    });
  }, [transitionKey, duration]);

  useLayoutEffect(() => () => activeAnimation.current?.cancel(), []);

  return <div className={`transition-swap transition-swap-${variant} ${className}`.trim()}>
    <div ref={surfaceRef} className="transition-swap-layer">{children}</div>
  </div>;
}
