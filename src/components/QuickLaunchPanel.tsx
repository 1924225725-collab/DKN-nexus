import type { NexusApp } from "../domain";
import { AppIcon } from "./AppIcon";

export function QuickLaunchPanel({ apps, onLaunch, onRemove }: { apps: NexusApp[]; onLaunch: (app: NexusApp) => void; onRemove: (app: NexusApp) => void }) {
  return <aside className="side-panel quick-panel" aria-label="快捷应用">
    <div className="panel-heading"><span>快捷应用</span><span className="panel-count">{apps.length}</span></div>
    {apps.length === 0 ? <p className="panel-empty">右键应用后加入快捷区</p> : <div className="quick-list">
      {apps.map((app) => <div className="quick-item" key={app.id} onContextMenu={(event) => { event.preventDefault(); onRemove(app); }}>
        <button className="quick-launch-button" onDoubleClick={() => onLaunch(app)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); onLaunch(app); } }} title={`双击打开 ${app.name}`} aria-label={`双击打开 ${app.name}`}>
          <AppIcon app={app} size={42} />
          <span>{app.displayName ?? app.name}</span>
        </button>
        <button className="quick-remove" onClick={() => onRemove(app)} aria-label={`移除 ${app.name}`}>×</button>
      </div>)}
    </div>}
  </aside>;
}
