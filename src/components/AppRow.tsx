import type { MouseEvent } from "react";
import type { NexusApp } from "../domain";
import { AppIcon } from "./AppIcon";
import { PinIcon } from "./Icons";

export function AppRow({ app, selected, onSelect, onLaunch, onPin, onQuickLaunch, isQuickLaunch, onReclassify, onContextMenu }: { app: NexusApp; selected: boolean; onSelect: () => void; onLaunch: () => void; onPin: () => void; onQuickLaunch?: () => void; isQuickLaunch?: boolean; onReclassify?: () => void; onContextMenu: (event: MouseEvent) => void }) {
  return <div className={`app-row ${selected ? "is-selected" : ""}`} role="option" aria-selected={selected} aria-label={`${app.displayName ?? app.name}，双击打开`} onClick={onSelect} onDoubleClick={(event) => { if (!(event.target as HTMLElement).closest("button")) onLaunch(); }} onContextMenu={onContextMenu}>
    <AppIcon app={app} />
    <span className="app-name">{app.displayName ?? app.name}</span>
    {onReclassify && <button className="classify-button" aria-label={`AI 分类 ${app.name}`} onClick={(event) => { event.stopPropagation(); onReclassify(); }}>AI</button>}
    {onQuickLaunch && <button className={`quick-add-button ${isQuickLaunch ? "is-active" : ""}`} aria-label={isQuickLaunch ? `移出快捷区 ${app.name}` : `加入快捷区 ${app.name}`} onClick={(event) => { event.stopPropagation(); onQuickLaunch(); }}>{isQuickLaunch ? "Q" : "+"}</button>}
    <button className={`pin-button ${app.isPinned ? "is-pinned" : ""}`} aria-label={app.isPinned ? `取消置顶 ${app.name}` : `置顶 ${app.name}`} onClick={(event) => { event.stopPropagation(); onPin(); }}><PinIcon /></button>
    {selected && <span className="enter-hint">双击打开</span>}
  </div>;
}
