type BubbleAxis = "x" | "y";

/** Move the same selection surface from its current on-screen position. */
export function moveSelectionBubble(
  container: HTMLElement | null,
  bubble: HTMLElement | null,
  selected: HTMLElement | null,
  axis: BubbleAxis,
  animate: boolean,
): void {
  if (!container || !bubble || !selected) return;

  const containerRect = container.getBoundingClientRect();
  const bubbleRect = bubble.getBoundingClientRect();
  const originX = containerRect.left + container.clientLeft;
  const originY = containerRect.top + container.clientTop;
  const ready = bubble.dataset.ready === "true";
  const from = axis === "x" ? bubbleRect.left - originX : bubbleRect.top - originY;
  const fromSize = axis === "x" ? bubbleRect.width : bubbleRect.height;
  const selectedRect = selected.getBoundingClientRect();
  const to = axis === "x" ? selectedRect.left - originX : selectedRect.top - originY;
  const toSize = axis === "x" ? selectedRect.width : selectedRect.height;

  bubble.getAnimations().forEach((animation) => animation.cancel());
  if (axis === "x") bubble.style.width = `${toSize}px`;
  else bubble.style.height = `${toSize}px`;
  bubble.style.transform = axis === "x" ? `translate3d(${to}px,0,0)` : `translate3d(0,${to}px,0)`;
  bubble.style.opacity = "1";
  bubble.dataset.ready = "true";

  if (!ready || !animate || Math.abs(to - from) < 0.5 || toSize < 1) return;

  const distance = to - from;
  const overshoot = Math.sign(distance) * Math.min(8, Math.abs(distance) * 0.07);
  const stretch = 1 + Math.min(0.24, Math.abs(distance) / 700);
  const scale = (value: number) => axis === "x" ? `scaleX(${value})` : `scaleY(${value})`;
  const translate = (value: number) => axis === "x" ? `translate3d(${value}px,0,0)` : `translate3d(0,${value}px,0)`;
  bubble.animate([
    { transform: `${translate(from)} ${scale(fromSize / toSize)}`, offset: 0 },
    { transform: `${translate(from + distance * 0.58)} ${scale(stretch)}`, offset: 0.58 },
    { transform: `${translate(to + overshoot)} ${scale(0.975)}`, offset: 0.84 },
    { transform: `${translate(to)} ${scale(1)}`, offset: 1 },
  ], { duration: 560, easing: "cubic-bezier(.2,.78,.24,1)", fill: "none" });
}
