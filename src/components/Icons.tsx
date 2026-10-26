type IconProps = { size?: number; stroke?: number };
const base = (size: number, stroke: number) => ({ width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: stroke, strokeLinecap: "round" as const, strokeLinejoin: "round" as const });

export function SearchIcon({ size = 18, stroke = 1.8 }: IconProps) { return <svg {...base(size, stroke)}><circle cx="11" cy="11" r="6.8"/><path d="m16.2 16.2 4.1 4.1"/></svg>; }
export function SettingsIcon({ size = 18, stroke = 1.7 }: IconProps) { return <svg {...base(size, stroke)}><path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z"/><path d="m19.4 15 .1.1a1.7 1.7 0 0 1-2.4 2.4l-.1-.1a1.7 1.7 0 0 0-2.9 1.2v.2a1.7 1.7 0 0 1-3.4 0v-.2a1.7 1.7 0 0 0-2.9-1.2l-.1.1a1.7 1.7 0 1 1-2.4-2.4l.1-.1a1.7 1.7 0 0 0-1.2-2.9H4a1.7 1.7 0 0 1 0-3.4h.2A1.7 1.7 0 0 0 5.4 5.8l-.1-.1a1.7 1.7 0 1 1 2.4-2.4l.1.1a1.7 1.7 0 0 0 2.9-1.2V2a1.7 1.7 0 0 1 3.4 0v.2a1.7 1.7 0 0 0 2.9 1.2l.1-.1a1.7 1.7 0 1 1 2.4 2.4l-.1.1a1.7 1.7 0 0 0 1.2 2.9h.2a1.7 1.7 0 0 1 0 3.4h-.2a1.7 1.7 0 0 0-1.2 2.9Z"/></svg>; }
export function PinIcon({ size = 15 }: IconProps) { return <svg {...base(size, 1.7)}><path d="m15 4 5 5-3 1-4 4v4l-2 2-1-6-3-3-3-1 2-2 4 1 4-4Z"/></svg>; }
export function ChevronIcon({ direction = "down", size = 14 }: IconProps & { direction?: "up" | "down" }) { return <svg {...base(size, 1.8)}>{direction === "down" ? <path d="m4 6 8 8 8-8"/> : <path d="m4 18 8-8 8 8"/>}</svg>; }
export function SparkIcon({ size = 14 }: IconProps) { return <svg {...base(size, 1.6)}><path d="m12 2 1.6 6.4L20 10l-6.4 1.6L12 18l-1.6-6.4L4 10l6.4-1.6L12 2Z"/><path d="m19 16 .7 2.3L22 19l-2.3.7L19 22l-.7-2.3L16 19l2.3-.7L19 16Z"/></svg>; }
export function CloseIcon({ size = 16 }: IconProps) { return <svg {...base(size, 1.7)}><path d="m5 5 14 14M19 5 5 19"/></svg>; }
export function RefreshIcon({ size = 16 }: IconProps) { return <svg {...base(size, 1.7)}><path d="M20 11a8 8 0 0 0-14-5L4 8"/><path d="M4 4v4h4M4 13a8 8 0 0 0 14 5l2-2"/><path d="M20 20v-4h-4"/></svg>; }

export type InterfaceIconName = "apps" | "modes" | "web" | "notes" | "ai" | "appearance" | "agent" | "input" | "storage" | "account" | "about" | "audio" | "arrow" | "plus" | "star";
export function InterfaceIcon({ name, size = 17 }: IconProps & { name: InterfaceIconName }) {
  const paths: Record<InterfaceIconName, React.ReactNode> = {
    apps: <><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></>,
    modes: <><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M8 9h8M8 15h5"/></>,
    web: <><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.8 2.5 4 5.5 4 9s-1.2 6.5-4 9M12 3c-2.8 2.5-4 5.5-4 9s1.2 6.5 4 9"/></>,
    notes: <><path d="M5 3h11l3 3v15H5zM15 3v4h4M8 11h8M8 15h8"/></>,
    ai: <><path d="m12 2 1.8 7.2L21 11l-7.2 1.8L12 20l-1.8-7.2L3 11l7.2-1.8L12 2Z"/></>,
    appearance: <><circle cx="12" cy="12" r="9"/><path d="M12 3v18M12 3a9 9 0 0 1 0 18"/></>,
    agent: <><rect x="4" y="6" width="16" height="14" rx="3"/><path d="M9 6V4h6v2M8 12h.01M16 12h.01M9 16h6"/></>,
    input: <><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M6 11a6 6 0 0 0 12 0M12 17v4M9 21h6"/></>,
    storage: <><rect x="3" y="5" width="18" height="15" rx="2"/><path d="M3 10h18M9 15h6"/></>,
    account: <><circle cx="12" cy="8" r="3"/><path d="M5 20a7 7 0 0 1 14 0M3 3h18v18H3z"/></>,
    about: <><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/></>,
    audio: <><path d="M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4"/></>,
    arrow: <path d="M5 17 18 4M9 4h9v9"/>,
    plus: <path d="M12 4v16M4 12h16"/>,
    star: <path d="m12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.8-6.2-3.3-6.2 3.3L7 14.2 2 9.3l6.9-1L12 2Z"/>,
  };
  return <svg {...base(size, 1.7)} aria-hidden="true">{paths[name]}</svg>;
}
