import { useEffect, useState } from "react";
import type { ClipboardEntry, ClipboardFavorite } from "../domain";
import { loadClipboardFavorites, saveClipboardFavorites } from "../services/preferences";
import { InterfaceIcon } from "./Icons";

function makeId(): string { return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`; }

export function ClipboardPanel({ entries, limit, onCopy }: { entries: ClipboardEntry[]; limit: number; onCopy: (entry: ClipboardEntry) => void }) {
  const [favorites, setFavorites] = useState<ClipboardFavorite[]>([]);
  const [manageOpen, setManageOpen] = useState(false);
  const [editing, setEditing] = useState<ClipboardFavorite | null>(null);
  const [label, setLabel] = useState("");
  const [category, setCategory] = useState("常用");
  const [text, setText] = useState("");

  useEffect(() => setFavorites(loadClipboardFavorites()), []);
  const persist = (next: ClipboardFavorite[]) => { const ordered = next.map((item, index) => ({ ...item, order: index })); setFavorites(ordered); saveClipboardFavorites(ordered); };
  const beginEdit = (favorite?: ClipboardFavorite, entry?: ClipboardEntry) => {
    setEditing(favorite ?? null); setLabel(favorite?.label ?? entry?.text.replace(/\s+/g, " ").slice(0, 28) ?? "");
    setCategory(favorite?.category ?? "常用"); setText(favorite?.text ?? entry?.text ?? ""); setManageOpen(true);
  };
  const save = () => {
    const value = text.trim(); if (!value) return;
    const next = editing
      ? favorites.map((item) => item.id === editing.id ? { ...item, text: value, label: label.trim() || value.slice(0, 28), category: category.trim() || "常用", updatedAt: Date.now() } : item)
      : [{ id: makeId(), text: value, label: label.trim() || value.slice(0, 28), category: category.trim() || "常用", order: -1, updatedAt: Date.now() }, ...favorites];
    persist(next); setEditing(null); setLabel(""); setText(""); setCategory("常用");
  };
  const move = (index: number, direction: -1 | 1) => { const next = [...favorites]; const other = index + direction; if (other < 0 || other >= next.length) return; [next[index], next[other]] = [next[other], next[index]]; persist(next); };
  const isFavorite = (entry: ClipboardEntry) => favorites.some((item) => item.text === entry.text);

  return <aside className="side-panel clipboard-panel" aria-label="剪贴板">
    <div className="panel-heading"><span>剪贴板</span><div className="clipboard-heading-actions"><span className="panel-count">{entries.length}/{limit}</span><button className="clipboard-manage-trigger" onClick={() => { setEditing(null); setLabel(""); setText(""); setCategory("常用"); setManageOpen(true); }} title="管理常用剪贴板"><InterfaceIcon name="star" size={14} /> {favorites.length}</button></div></div>
    {entries.length === 0 ? <p className="panel-empty">复制文本后会自动出现在这里</p> : <div className="clipboard-list">
      {entries.map((entry) => <div className="clipboard-entry-row" key={entry.id}>
        <button className="clipboard-entry" aria-label={`复制：${entry.text.replace(/\s+/g, " ").slice(0, 160)}`} onClick={() => onCopy(entry)}>
          <span className="clipboard-preview">{entry.text.replace(/\s+/g, " ")}</span>
          <time>{new Date(entry.capturedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
        </button>
        <button className={`clipboard-favorite-toggle ${isFavorite(entry) ? "is-active" : ""}`} onClick={() => isFavorite(entry) ? persist(favorites.filter((item) => item.text !== entry.text)) : beginEdit(undefined, entry)} title={isFavorite(entry) ? "移出常用" : "添加到常用"}><InterfaceIcon name="star" size={14} /></button>
      </div>)}
    </div>}
    {manageOpen && <div className="clipboard-manage-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setManageOpen(false); }}><section className="clipboard-manage-dialog" role="dialog" aria-modal="true" aria-label="常用剪贴板管理">
      <div className="clipboard-manage-title"><div><span className="eyebrow">NEXUS / CLIPBOARD</span><h2>常用剪贴板</h2></div><button className="icon-button" onClick={() => setManageOpen(false)} aria-label="关闭">×</button></div>
      <div className="clipboard-favorite-form"><input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="名称" /><input value={category} onChange={(event) => setCategory(event.target.value)} placeholder="分类，例如：工作" /><textarea value={text} onChange={(event) => setText(event.target.value)} placeholder="常用文本内容" rows={3} /><div className="clipboard-manage-actions"><button className="quiet-button" onClick={() => { setEditing(null); setLabel(""); setText(""); setCategory("常用"); }}>新建</button><button className="primary-action" onClick={save}>{editing ? "保存修改" : "添加常用"}</button></div></div>
      <div className="clipboard-favorite-list">{favorites.length === 0 ? <p className="panel-empty">从剪贴板历史添加到常用，或在上方新建。</p> : favorites.map((favorite, index) => <article className="clipboard-favorite-item" key={favorite.id}><button className="clipboard-favorite-select" onClick={() => onCopy({ id: favorite.id, text: favorite.text, capturedAt: Date.now() })}>{favorite.label}<small>{favorite.category}</small></button><div><button className="quiet-button" onClick={() => beginEdit(favorite)}>编辑</button><button className="quiet-button" disabled={index === 0} onClick={() => move(index, -1)}>↑</button><button className="quiet-button" disabled={index === favorites.length - 1} onClick={() => move(index, 1)}>↓</button><button className="quiet-button" onClick={() => persist(favorites.filter((item) => item.id !== favorite.id))}>删除</button></div></article>)}</div>
    </section></div>}
  </aside>;
}
