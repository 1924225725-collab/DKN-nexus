import { useState } from "react";
import type { WebShortcut } from "../domain";
import { createWebShortcut, openWebShortcut } from "../services/webShortcuts";

export function WebShortcutPanel({ shortcuts, onChange }: { shortcuts: WebShortcut[]; onChange: (next: WebShortcut[]) => void }) {
  const [editing, setEditing] = useState<WebShortcut | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const beginEdit = (shortcut?: WebShortcut) => { setEditing(shortcut ?? null); setEditorOpen(true); setName(shortcut?.name ?? ""); setUrl(shortcut?.url ?? ""); setError(""); };
  const submit = () => {
    const created = createWebShortcut(name, url);
    if (!created) { setError("请输入有效的网站名称和 http/https 地址。"); return; }
    const next = editing ? shortcuts.map((item) => item.id === editing.id ? { ...created, id: editing.id, updatedAt: Date.now() } : item) : [created, ...shortcuts];
    onChange(next); setEditing(null); setEditorOpen(false); setName(""); setUrl(""); setError("");
  };
  return <div className="web-panel">
    <div className="page-heading"><div><p className="eyebrow">NEXUS / WEB</p><h1>网页快捷方式</h1><p className="page-description">只保存地址，点击后交给 Windows 默认浏览器打开。</p></div><button className="primary-action" onClick={() => beginEdit()}>新增网页</button></div>
    {shortcuts.length === 0 ? <div className="empty-state web-empty">添加 GitHub、文档或常用服务。</div> : <div className="web-grid">{shortcuts.map((shortcut) => <div className="web-card" key={shortcut.id}><button className="web-open" onClick={() => void openWebShortcut(shortcut.url)}><span className="web-icon">{shortcut.icon ? <img src={shortcut.icon} alt="" /> : <span>↗</span>}</span><span className="web-name">{shortcut.name}</span><span className="web-url">{shortcut.url.replace(/^https?:\/\//, "")}</span></button><div className="web-card-actions"><button onClick={() => beginEdit(shortcut)}>编辑</button><button onClick={() => onChange(shortcuts.filter((item) => item.id !== shortcut.id))}>删除</button></div></div>)}</div>}
    {editorOpen && <section className="web-editor" aria-label={editing ? "编辑网页" : "新增网页"}><div className="editor-heading"><div><p className="eyebrow">NEXUS / 网页</p><h2>{editing ? "编辑网页" : "新增网页"}</h2></div><button className="quiet-button" onClick={() => { setEditing(null); setEditorOpen(false); setName(""); setUrl(""); setError(""); }}>取消</button></div><label className="form-field"><span>名称</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：GitHub" /></label><label className="form-field"><span>网址</span><input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="例如：https://github.com" onKeyDown={(event) => { if (event.key === "Enter") submit(); }} /></label>{error && <p className="form-error">{error}</p>}<div className="editor-actions"><button className="quiet-button" onClick={() => { setEditing(null); setEditorOpen(false); setName(""); setUrl(""); setError(""); }}>取消</button><button className="primary-action" onClick={submit}>保存网页</button></div></section>}
  </div>;
}
