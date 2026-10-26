import { useState } from "react";
import { createPortal } from "react-dom";
import type { NexusApp } from "../domain";
import { AppIcon } from "./AppIcon";
import { MotionPresence } from "./MotionPresence";

export function CustomAppPanel({ open, apps, onClose, onAdd, onRemove, onPickFile }: { open: boolean; apps: NexusApp[]; onClose: () => void; onAdd: (app: NexusApp) => void; onRemove: (id: string) => void; onPickFile: () => Promise<string | null> }) {
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");
  const [aliases, setAliases] = useState("");
  const [error, setError] = useState("");
  const submit = () => {
    const launchTarget = target.trim();
    if (!launchTarget) { setError("请输入应用程序路径或启动命令"); return; }
    if (apps.some((app) => app.launchTarget.toLowerCase() === launchTarget.toLowerCase())) { setError("这个应用已经存在"); return; }
    const fallbackName = launchTarget.split(/[\\/]/).pop()?.replace(/\.exe$/i, "") || "自定义应用";
    onAdd({
      id: `custom-${Date.now()}`,
      name: name.trim() || fallbackName,
      launchTarget,
      source: "custom",
      isPinned: false,
      aliases: aliases.split(",").map((item) => item.trim()).filter(Boolean),
      classification: "normal-app",
      category: "other",
    });
    setName(""); setTarget(""); setAliases(""); setError(""); onClose();
  };

  return createPortal(<MotionPresence show={open}>{open && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="custom-app-modal" role="dialog" aria-modal="true" aria-label="添加自定义应用">
      <div className="settings-heading"><div><p className="eyebrow">NEXUS / 应用</p><h1>添加自定义应用</h1></div><button className="icon-button" onClick={onClose} aria-label="关闭">×</button></div>
      <p className="custom-app-help">扫描不到的程序可以手动加入。支持 .exe 路径或 Windows 可识别的启动命令。</p>
      <label className="custom-app-field"><span>应用名称</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：我的工具" /></label>
      <label className="custom-app-field"><span>程序路径 / 启动命令</span><div className="custom-app-path"><input value={target} onChange={(event) => setTarget(event.target.value)} placeholder={String.raw`C:\Program Files\App\App.exe`} /><button type="button" className="quiet-button" onClick={() => void onPickFile().then((path) => { if (!path) return; setTarget(path); if (!name.trim()) setName(path.split(/[\\/]/).pop()?.replace(/\.(exe|lnk)$/i, "") ?? ""); setError(""); })}>选择文件</button></div></label>
      <label className="custom-app-field"><span>中文搜索别名（可选）</span><input value={aliases} onChange={(event) => setAliases(event.target.value)} placeholder="用逗号分隔，例如：驱动, 显卡工具" /></label>
      {error && <p className="form-error">{error}</p>}
      <div className="modal-actions"><button className="quiet-button" onClick={onClose}>取消</button><button className="primary-action" onClick={submit}>添加应用</button></div>
      <div className="custom-app-list"><div className="context-label">已添加的自定义应用</div>{apps.length === 0 ? <p className="panel-empty">还没有手动添加的应用</p> : apps.map((app) => <div className="custom-app-item" key={app.id}><AppIcon app={app} size={28} /><span title={app.launchTarget}>{app.name}</span><button className="quiet-button" onClick={() => onRemove(app.id)}>移除</button></div>)}</div>
    </section>
  </div>}</MotionPresence>, document.body);
}
