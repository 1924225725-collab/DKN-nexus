import { useEffect, useState } from "react";
import type { NexusApp, NexusMode } from "../domain";
import { AppIcon } from "./AppIcon";
import { TransitionSwap } from "./TransitionSwap";

function makeId(): string { return `${Date.now()}-${Math.random().toString(16).slice(2)}`; }

export function ModesPanel({ apps, modes, onChange, onRun }: { apps: NexusApp[]; modes: NexusMode[]; onChange: (modes: NexusMode[]) => void; onRun: (mode: NexusMode) => Promise<void> }) {
  const [activeId, setActiveId] = useState(modes[0]?.id ?? null);
  const active = modes.find((mode) => mode.id === activeId) ?? null;
  useEffect(() => {
    if (!activeId || !modes.some((mode) => mode.id === activeId)) setActiveId(modes[0]?.id ?? null);
  }, [activeId, modes]);
  const update = (patch: Partial<NexusMode>) => { if (!active) return; onChange(modes.map((mode) => mode.id === active.id ? { ...mode, ...patch } : mode)); };
  const addMode = () => { const mode: NexusMode = { id: makeId(), name: "新模式", closeAppIds: [], launchAppIds: [], closeAllNonSystem: false }; onChange([mode, ...modes]); setActiveId(mode.id); };
  const removeMode = () => { if (!active) return; const next = modes.filter((mode) => mode.id !== active.id); onChange(next); setActiveId(next[0]?.id ?? null); };
  const toggleApp = (field: "closeAppIds" | "launchAppIds", id: string) => { if (!active) return; const values = active[field].includes(id) ? active[field].filter((value) => value !== id) : [...active[field], id]; update({ [field]: values }); };
  const runActive = async () => {
    if (!active) return;
    if (active.closeAllNonSystem && !window.confirm("该模式会尝试关闭所有带窗口的非系统程序，是否继续？")) return;
    await onRun(active);
  };
  return <div className="modes-panel"><div className="page-heading"><div><p className="eyebrow">NEXUS / 模式</p><h1>自动化模式</h1><p className="page-description">把常用的打开 / 关闭动作保存成一个可确认执行的模式。</p></div><button className="primary-action" onClick={addMode}>新建模式</button></div><div className="modes-layout"><aside className="modes-list">{modes.length === 0 ? <p className="panel-empty">还没有模式</p> : modes.map((mode) => <button className={`mode-list-item ${mode.id === activeId ? "is-active" : ""}`} key={mode.id} onClick={() => setActiveId(mode.id)}>{mode.name || "未命名模式"}</button>)}</aside>{active ? <TransitionSwap transitionKey={active.id} variant="selection" className="mode-editor-swap"><section className="mode-editor"><label className="mode-name-field"><span>模式名称</span><input className="mode-name-input" value={active.name} onChange={(event) => update({ name: event.target.value })} placeholder="例如：游戏模式" /></label><label className="mode-danger-option"><input type="checkbox" checked={active.closeAllNonSystem} onChange={(event) => update({ closeAllNonSystem: event.target.checked })} /> 执行前关闭所有非系统程序（需要二次确认）</label><div className="mode-columns"><div><h3>进入时打开</h3>{apps.map((app) => <label className="mode-app-option" key={`open-${app.id}`}><input type="checkbox" checked={active.launchAppIds.includes(app.id)} onChange={() => toggleApp("launchAppIds", app.id)} /><AppIcon app={app} size={22} /><span>{app.displayName ?? app.name}</span></label>)}</div><div><h3>进入时关闭</h3>{apps.map((app) => <label className="mode-app-option" key={`close-${app.id}`}><input type="checkbox" checked={active.closeAppIds.includes(app.id)} onChange={() => toggleApp("closeAppIds", app.id)} /><AppIcon app={app} size={22} /><span>{app.displayName ?? app.name}</span></label>)}</div></div><div className="mode-actions"><button className="quiet-button" onClick={removeMode}>删除模式</button><button className="primary-action" onClick={() => void runActive()}>执行模式</button></div></section></TransitionSwap> : <div className="empty-state">创建一个模式开始配置</div>}</div></div>;
}
