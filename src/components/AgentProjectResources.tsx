import { useState } from "react";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import { chooseAgentResourceFile, chooseProjectDirectory, copyAgentImageToProject, createAgentId } from "../services/agentWorkflow";
import type { AgentProjectResource, AgentProjectResourceKind } from "../services/agentWorkflow";

const RESOURCE_TYPES: Array<{ kind: AgentProjectResourceKind; label: string }> = [
  { kind: "link", label: "网址" },
  { kind: "image", label: "图片" },
  { kind: "text", label: "文本" },
  { kind: "directory", label: "目录" },
  { kind: "package", label: "安装包" },
];

function ResourceIcon({ kind }: { kind: AgentProjectResourceKind }) {
  return <span className={`agent-resource-icon kind-${kind}`} aria-hidden="true"><svg viewBox="0 0 20 20">{
    kind === "link" ? <><path d="M8 12 12 8" /><path d="M7 7 5.7 5.7a3 3 0 0 0-4.2 4.2L4 12.4a3 3 0 0 0 4.2 0l1.2-1.2M13 13l1.3 1.3a3 3 0 0 0 4.2-4.2L16 7.6a3 3 0 0 0-4.2 0l-1.2 1.2" /></> :
    kind === "image" ? <><rect x="2.5" y="3" width="15" height="14" rx="2" /><circle cx="7" cy="7.5" r="1.3" /><path d="m3.5 14 4.4-4 3 2.6 2.4-2 3.2 2.9" /></> :
    kind === "text" ? <><path d="M4 3h8l4 4v10H4z" /><path d="M12 3v4h4M7 11h6M7 14h6" /></> :
    kind === "directory" ? <><path d="M2.5 5.5h6l1.5 2h7.5v8.8a1.2 1.2 0 0 1-1.2 1.2H3.7a1.2 1.2 0 0 1-1.2-1.2z" /><path d="M2.5 8h15" /></> :
    <><path d="M4 2.5h8l4 4v11H4z" /><path d="M12 2.5v4h4M7 10h6M7 13h6M7 16h4" /></>
  }</svg></span>;
}

function resourceValueLabel(resource: AgentProjectResource): string {
  if (resource.kind === "text") return resource.value.slice(0, 130).replace(/\s+/g, " ") || "空文本";
  return resource.value;
}

export function AgentProjectResources({ projectPath, resources, onChange, onError, onClose }: {
  projectPath: string;
  resources: AgentProjectResource[];
  onChange: (resources: AgentProjectResource[]) => void;
  onError: (message: string) => void;
  onClose: () => void;
}) {
  const [addingKind, setAddingKind] = useState<AgentProjectResourceKind | null>(null);
  const [title, setTitle] = useState("");
  const [value, setValue] = useState("");
  const [working, setWorking] = useState(false);

  const closeForm = () => { setAddingKind(null); setTitle(""); setValue(""); onError(""); };
  const beginAdd = (kind: AgentProjectResourceKind) => { setAddingKind(kind); setTitle(""); setValue(""); onError(""); };

  const chooseLocation = async () => {
    if (!addingKind) return;
    onError("");
    try {
      let selected: string | null = null;
      if (addingKind === "directory") selected = await chooseProjectDirectory();
      else if (addingKind === "image" || addingKind === "package") selected = await chooseAgentResourceFile(addingKind);
      if (selected) {
        setValue(selected);
        if (!title.trim()) setTitle(selected.split(/[\\/]/).filter(Boolean).at(-1) ?? RESOURCE_TYPES.find((item) => item.kind === addingKind)?.label ?? "项目资料");
      }
    } catch (cause) { onError(cause instanceof Error ? cause.message : "选择项目资料失败。"); }
    finally { setWorking(false); }
  };

  const saveResource = async () => {
    if (!addingKind) return;
    const resourceTitle = title.trim();
    const resourceValue = value.trim();
    if (!resourceTitle || !resourceValue) { onError("请填写名称和内容，或先选择一个文件 / 目录。"); return; }
    if (addingKind === "link") {
      try {
        const parsed = new URL(resourceValue);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error();
      } catch { onError("网址需以 http:// 或 https:// 开头。"); return; }
    }
    if (addingKind === "text" && resourceValue.length > 20_000) { onError("单条项目文本最多 20,000 个字符。"); return; }
    if (resources.length >= 60) { onError("每个项目最多保存 60 条资料。"); return; }
    setWorking(true);
    try {
      const storedValue = addingKind === "image" ? await copyAgentImageToProject(projectPath, resourceValue) : resourceValue;
      onChange([{ id: createAgentId(), kind: addingKind, title: resourceTitle, value: storedValue, createdAt: Date.now() }, ...resources]);
      closeForm();
    } catch (cause) { onError(cause instanceof Error ? cause.message : "保存项目资料失败。"); }
    finally { setWorking(false); }
  };

  const openResource = async (resource: AgentProjectResource) => {
    try {
      if (resource.kind === "link") await openUrl(resource.value);
      else if (resource.kind !== "text") await openPath(resource.value);
    } catch (cause) { onError(cause instanceof Error ? cause.message : "无法打开这条项目资料。"); }
  };

  return <aside className="agents-project-resources" aria-label="项目资料">
    <header className="agents-project-resources-heading"><div><span className="eyebrow">PROJECT / LIBRARY</span><strong>项目资料</strong><small>{resources.length} 条关联内容</small></div><button type="button" className="agents-project-resources-close" aria-label="收起项目资料" onClick={onClose}>×</button></header>
    <div className="agents-resource-add-grid" aria-label="添加项目资料">{RESOURCE_TYPES.map(({ kind, label }) => <button key={kind} type="button" className={addingKind === kind ? "is-active" : ""} onClick={() => addingKind === kind ? closeForm() : beginAdd(kind)}><ResourceIcon kind={kind} /><span>{label}</span></button>)}</div>
    {addingKind && <section className="agents-resource-form" aria-label={`添加${RESOURCE_TYPES.find((item) => item.kind === addingKind)?.label}`}>
      <label>名称<input value={title} onChange={(event) => setTitle(event.target.value)} placeholder={`${RESOURCE_TYPES.find((item) => item.kind === addingKind)?.label}名称`} maxLength={100} /></label>
      {addingKind === "text" ? <label>内容<textarea value={value} onChange={(event) => setValue(event.target.value)} placeholder="记录项目说明、需求或参考文字…" maxLength={20_000} /> </label> : <label>{addingKind === "link" ? "网址" : addingKind === "image" ? "项目内图片" : addingKind === "directory" ? "本地目录" : "本地安装包"}<div className="agents-resource-location"><input value={value} onChange={(event) => setValue(event.target.value)} placeholder={addingKind === "link" ? "https://…" : "选择本地位置"} readOnly={addingKind !== "link"} /><button type="button" className="quiet-button" disabled={working} onClick={() => void chooseLocation()}>{working ? "处理中…" : "选择"}</button></div></label>}
      {addingKind === "image" && <small>图片会复制到项目的 assets/user-provided 目录，供后续编码步骤使用。</small>}
      {addingKind === "package" && <small>只保存安装包位置，不复制大文件。</small>}
      <div className="agents-resource-form-actions"><button type="button" className="quiet-button" disabled={working} onClick={closeForm}>取消</button><button type="button" className="primary-action" disabled={working} onClick={() => void saveResource()}>{working ? "保存中…" : "保存资料"}</button></div>
    </section>}
    <div className="agents-project-resource-list">{resources.length === 0 ? <div className="agents-project-resource-empty"><span aria-hidden="true">＋</span><strong>这个项目还没有关联资料</strong><p>把参考网址、图片、文字、工具目录或安装包放在这里，方便任务持续复用。</p></div> : resources.map((resource) => <article className="agents-project-resource-item" key={resource.id}>
      <ResourceIcon kind={resource.kind} /><div className="agents-project-resource-copy"><strong title={resource.title}>{resource.title}</strong><small title={resource.value}>{resourceValueLabel(resource)}</small>{resource.kind === "text" && <details><summary>查看文本</summary><p>{resource.value}</p></details>}</div>
      {resource.kind !== "text" && <button type="button" className="agents-resource-open" aria-label={`打开 ${resource.title}`} title="打开" onClick={() => void openResource(resource)}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3h7v7M13 3 6.5 9.5M11 9v4H3V5h4" /></svg></button>}
      <button type="button" className="agents-resource-remove" aria-label={`移除 ${resource.title}`} title="从项目资料列表移除" onClick={() => onChange(resources.filter((item) => item.id !== resource.id))}>×</button>
    </article>)}</div>
  </aside>;
}
