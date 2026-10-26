import type { NexusApp } from "../domain";

const iconBackgrounds = ["#e8e4df", "#d6e2e8", "#ebe1d2", "#d9d9d9", "#e6ded9", "#dbe4dd"];

export function AppIcon({ app, size = 34 }: { app: NexusApp; size?: number }) {
  const background = iconBackgrounds[app.name.length % iconBackgrounds.length];
  const initials = app.name.split(" ").map((part) => part[0]).slice(0, 2).join("").toUpperCase();
  return app.icon ? <span className="app-icon-wrap" style={{ width: size, height: size }}><img className="app-icon" style={{ width: size, height: size }} src={app.icon} alt="" onError={(event) => { event.currentTarget.style.display = "none"; event.currentTarget.parentElement?.querySelector(".app-icon-fallback")?.removeAttribute("hidden"); }} /><span className="app-icon app-icon-fallback" hidden style={{ width: size, height: size, background }}>{initials}</span></span> : <span className="app-icon app-icon-fallback" style={{ width: size, height: size, background }}>{initials}</span>;
}
