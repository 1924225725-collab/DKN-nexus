import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { ClipboardEntry, ClipboardFavorite, NoteRecord, NexusSettings, WebShortcut, ChatMessage } from "../domain";
import { askNexus } from "../services/ai";
import { createNote, saveNoteFile } from "../services/notes";
import { loadClipboardFavorites, loadClipboardHistory, loadNotes, loadSettings, loadWebShortcuts } from "../services/preferences";
import { loadSecret } from "../services/secrets";
import { loadAiChatSessions, recordAiUsage, saveAiChatSessions, saveNotes } from "../services/preferences";
import { openWebShortcut } from "../services/webShortcuts";
import { TransitionSwap } from "../components/TransitionSwap";
import { RADIAL_ACTIONS, radialNodePosition } from "./RadialAction";
import { VoiceInputService } from "./VoiceInputService";
import { localWhisperProvider } from "../providers/localWhisper";

type RadialPage = "home" | "clipboard" | "clipboard-category" | "notes" | "note-editor" | "web" | "ai" | "tools";
interface RadialNode { id: string; label: string; detail?: string; kind: "action" | "recent" | "favorite" | "category" | "note" | "new-note" | "web"; value?: string; }
interface RadialAnchor { x: number; y: number; }
const voiceInput = new VoiceInputService();
const short = (value: string, size = 18) => value.replace(/\s+/g, " ").trim().slice(0, size) || "空白文本";
const makeId = () => typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

export function RadialOverlayApp() {
  const [page, setPage] = useState<RadialPage>("home");
  const [selectedId, setSelectedId] = useState("");
  const [anchor, setAnchor] = useState<RadialAnchor>({ x: 260, y: 260 });
  const [clipboard, setClipboard] = useState<ClipboardEntry[]>([]);
  const [favorites, setFavorites] = useState<ClipboardFavorite[]>([]);
  const [notes, setNotes] = useState<NoteRecord[]>([]);
  const [activeNote, setActiveNote] = useState<NoteRecord | null>(null);
  const [websites, setWebsites] = useState<WebShortcut[]>([]);
  const [settings, setSettings] = useState<NexusSettings>(() => loadSettings());
  useEffect(() => { document.documentElement.style.setProperty("--nexus-font-scale", settings.textSize === "small" ? "0.92" : settings.textSize === "large" ? "1.12" : "1"); }, [settings.textSize]);
  const [clipCategory, setClipCategory] = useState("");
  const [voiceStatus, setVoiceStatus] = useState("");
  const [aiInput, setAiInput] = useState("");
  const [aiAnswer, setAiAnswer] = useState("");
  const [aiError, setAiError] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiSearch, setAiSearch] = useState(false);
  const commitRef = useRef<(nodeId?: string) => void>(() => undefined);
  const releaseRef = useRef<() => void>(() => undefined);
  const pendingVoiceRef = useRef(false);
  const keepOpenOnReleaseRef = useRef(false);
  const clickConsumedRef = useRef(false);
  const closingRef = useRef(false);

  const refreshLocalData = () => {
    setClipboard(loadClipboardHistory(settings.clipboardHistoryLimit));
    setFavorites(loadClipboardFavorites());
    setNotes(loadNotes());
    setWebsites(loadWebShortcuts());
    setSettings(loadSettings());
  };

  useEffect(() => {
    let disposed = false;
    let cleanupOpen: (() => void) | undefined;
    let cleanupRelease: (() => void) | undefined;
    void import("@tauri-apps/api/event").then(async ({ listen }) => {
      const open = await listen<RadialAnchor>("dkn://radial/open", async (event) => {
        if (disposed) return;
        closingRef.current = false;
        refreshLocalData();
        setPage("home");
        setAnchor(event.payload ?? { x: 260, y: 260 });
        setSelectedId("");
        keepOpenOnReleaseRef.current = false;
        clickConsumedRef.current = false;
        setActiveNote(null);
        setVoiceStatus("");
        if (loadSettings().radialVoiceEnabled) {
          pendingVoiceRef.current = true;
          try { await voiceInput.startCapture(); setVoiceStatus("正在本地采集 · 松开快捷键停止"); }
          catch (error) { setVoiceStatus(error instanceof Error ? error.message : "无法开启麦克风"); }
        }
      });
      const release = await listen("dkn://radial/release", async () => {
        if (pendingVoiceRef.current) {
          pendingVoiceRef.current = false;
          try {
            await voiceInput.stopCapture();
            setVoiceStatus("录音完成 · 正在本地转录…");
            const transcript = await voiceInput.transcribe(localWhisperProvider);
            if (!transcript) throw new Error("没有识别到清晰语音。");
            setVoiceStatus("转录完成 · 正在粘贴…");
            await pasteText(transcript);
            return;
          } catch (error) {
            setVoiceStatus(error instanceof Error ? error.message : "本地语音转录失败。");
            keepOpenOnReleaseRef.current = true;
            return;
          }
        }
        if (clickConsumedRef.current) {
          clickConsumedRef.current = false;
          return;
        }
        if (keepOpenOnReleaseRef.current) {
          keepOpenOnReleaseRef.current = false;
          return;
        }
        releaseRef.current();
      });
      cleanupOpen = open; cleanupRelease = release;
    }).catch(() => undefined);
    return () => { disposed = true; cleanupOpen?.(); cleanupRelease?.(); voiceInput.cancel(); };
  }, []);

  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" && event.code !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void close();
    };
    window.addEventListener("keydown", escape, true);
    return () => window.removeEventListener("keydown", escape, true);
  }, []);

  const categoryOptions = useMemo(() => [...new Set(favorites.map((item) => item.category.trim()).filter(Boolean))], [favorites]);
  const nodes: RadialNode[] = useMemo(() => {
    if (page === "home") {
      const recent = clipboard.slice(0, 3).map((entry) => ({ id: `recent:${entry.id}`, label: short(entry.text, 16), detail: "最近复制", kind: "recent" as const, value: entry.id }));
      const frequent = favorites.slice(0, 3).map((item) => ({ id: `favorite:${item.id}`, label: short(item.label, 15), detail: item.category || "常用", kind: "favorite" as const, value: item.id }));
      const actions = RADIAL_ACTIONS.filter((action) => action.id !== "clipboard").map((action) => ({ id: `action:${action.id}`, label: action.label, detail: action.hint, kind: "action" as const, value: action.id }));
      return [...recent, ...frequent, { id: "action:clipboard", label: "全部记录", detail: "打开剪贴板", kind: "action" as const, value: "clipboard" }, ...actions];
    }
    if (page === "clipboard") {
      const recent = clipboard.slice(0, 3).map((entry) => ({ id: `recent:${entry.id}`, label: short(entry.text), detail: "最近", kind: "recent" as const, value: entry.id }));
      const frequent = favorites.slice(0, Math.max(0, 6 - recent.length)).map((item) => ({ id: `favorite:${item.id}`, label: short(item.label, 16), detail: item.category, kind: "favorite" as const, value: item.id }));
      return [...recent, ...frequent];
    }
    if (page === "clipboard-category") return favorites.filter((item) => item.category === clipCategory).slice(0, 8).map((item) => ({ id: `favorite:${item.id}`, label: short(item.label, 16), detail: short(item.text, 24), kind: "favorite" as const, value: item.id }));
    if (page === "notes") return [{ id: "note:new", label: "快速新建", detail: "本地草稿", kind: "new-note" as const }, ...notes.slice(0, 5).map((note) => ({ id: `note:${note.id}`, label: short(note.title || "未命名笔记", 16), detail: new Date(note.updatedAt).toLocaleDateString(), kind: "note" as const, value: note.id }))];
    if (page === "web") return websites.slice(0, 8).map((site) => ({ id: `web:${site.id}`, label: short(site.name, 16), detail: site.url.replace(/^https?:\/\//, ""), kind: "web" as const, value: site.id }));
    return [];
  }, [page, clipboard, favorites, clipCategory, notes, websites]);

  const close = async () => {
    if (closingRef.current) return;
    closingRef.current = true;
    voiceInput.cancel(); pendingVoiceRef.current = false;
    setPage("home"); setSelectedId(""); setActiveNote(null);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("hide_radial_overlay");
    } catch {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        await getCurrentWindow().hide();
      } catch {
        closingRef.current = false;
      }
    }
  };

  const returnHome = () => {
    setPage("home");
    setSelectedId("");
    setActiveNote(null);
  };

  const pasteText = async (text: string) => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const pasted = await invoke<boolean>("radial_quick_paste", { text });
      if (!pasted) { setVoiceStatus("已复制到剪贴板；目标应用未确认自动粘贴"); await close(); }
    } catch {
      try { await navigator.clipboard.writeText(text); setVoiceStatus("已复制到剪贴板，请手动按 Ctrl+V"); }
      catch { setVoiceStatus("无法写入剪贴板"); }
      await close();
    }
  };

  const enterNote = (note: NoteRecord) => { const all = [note, ...loadNotes().filter((item) => item.id !== note.id)].sort((a, b) => b.updatedAt - a.updatedAt); saveNotes(all); setNotes(all); setActiveNote(note); setPage("note-editor"); setSelectedId(""); };
  const changeNote = (patch: Partial<NoteRecord>) => {
    if (!activeNote) return;
    const next = { ...activeNote, ...patch, updatedAt: Date.now() };
    setActiveNote(next);
    const all = [next, ...loadNotes().filter((item) => item.id !== next.id)].sort((a, b) => b.updatedAt - a.updatedAt);
    setNotes(all); saveNotes(all);
  };

  const commit = async (nodeId = selectedId) => {
    const node = nodes.find((item) => item.id === nodeId);
    if (!node) return;
    if (page === "home" && node.kind === "recent") {
      const entry = clipboard.find((item) => item.id === node.value);
      if (entry) await pasteText(entry.text);
      return;
    }
    if (page === "home" && node.kind === "favorite") {
      const favorite = favorites.find((item) => item.id === node.value);
      if (favorite) await pasteText(favorite.text);
      return;
    }
    if (page === "home" && node.kind === "action") {
      setSelectedId("");
      if (node.value === "clipboard") { setPage("clipboard"); return; }
      if (node.value === "notes") { setPage("notes"); return; }
      if (node.value === "web") { setPage("web"); return; }
      if (node.value === "ai") { setPage("ai"); setAiError(""); return; }
      setPage("tools"); return;
    }
    if (page === "clipboard" && node.kind === "recent") {
      const entry = clipboard.find((item) => item.id === node.value);
      if (entry) await pasteText(entry.text);
      return;
    }
    if ((page === "clipboard" || page === "clipboard-category") && node.kind === "favorite") {
      const favorite = favorites.find((item) => item.id === node.value);
      if (favorite) await pasteText(favorite.text);
      return;
    }
    if (page === "notes" && node.kind === "new-note") { enterNote(createNote()); return; }
    if (page === "notes" && node.kind === "note") { const note = notes.find((item) => item.id === node.value); if (note) enterNote(note); return; }
    if (page === "web" && node.kind === "web") {
      const site = websites.find((item) => item.id === node.value);
      if (site) { try { await openWebShortcut(site.url); } catch (error) { setVoiceStatus(error instanceof Error ? error.message : "网页打开失败"); return; } await close(); }
    }
  };
  commitRef.current = (nodeId) => { void commit(nodeId); };
  releaseRef.current = () => {
    const node = nodes.find((item) => item.id === selectedId);
    if (page === "home" && node && (node.kind === "recent" || node.kind === "favorite")) {
      void commit();
      return;
    }
    void close();
  };

  const sendAi = async () => {
    const content = aiInput.trim(); if (!content || aiBusy) return;
    setAiBusy(true); setAiError(""); setAiAnswer("");
    try {
      const existing = loadAiChatSessions();
      const current = existing[0];
      const messages: ChatMessage[] = [...(current?.messages ?? []), { role: "user" as const, content }].slice(-16);
      const result = await askNexus(messages, settings, aiSearch);
      const now = Date.now();
      const session = { id: current?.id ?? makeId(), title: current?.title ?? content.slice(0, 24), createdAt: current?.createdAt ?? now, updatedAt: now, messages: [...messages, { role: "assistant" as const, content: result.content }] };
      saveAiChatSessions([session, ...existing.filter((item) => item.id !== session.id)]);
      recordAiUsage(result.usage?.promptTokens ?? 0, result.usage?.completionTokens ?? 0, result.searched);
      setAiAnswer(result.content);
    } catch (error) { setAiError(error instanceof Error ? error.message : "Nexus AI 请求失败"); }
    finally { setAiBusy(false); }
  };

  const saveTextNote = async () => {
    if (!activeNote) return;
    const filePath = await saveNoteFile(activeNote, settings.notesDirectory);
    if (filePath) changeNote({ filePath });
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-radial-id]");
    const nextId = target?.dataset.radialId ?? "";
    setSelectedId((current) => current === nextId ? current : nextId);
  };

  const heading = page === "home" ? "NEXUS" : page === "clipboard" || page === "clipboard-category" ? "CLIPBOARD" : page === "notes" || page === "note-editor" ? "NOTES" : page === "web" ? "WEB" : page === "ai" ? "NEXUS AI" : "TOOLS";

  return <main className="radial-overlay-root" data-theme={settings.visualTheme} data-reduced-motion={settings.reducedMotion ? "true" : undefined} style={{ "--nexus-font-scale": settings.textSize === "small" ? 0.92 : settings.textSize === "large" ? 1.12 : 1 } as CSSProperties} onPointerMove={onPointerMove} onContextMenu={(event) => event.preventDefault()}>
    <div className="radial-anchor" style={{ left: anchor.x, top: anchor.y }}>
      <div className="radial-glow" />
      <div className="radial-ring radial-ring-outer" />
      <div className="radial-ring radial-ring-inner" />
      <div key={page} className="radial-heading">{heading}</div>
      <button className="radial-center" onClick={() => { if (page === "home") void close(); else returnHome(); }} aria-label={page === "home" ? "关闭轮盘" : "返回轮盘"}><img src="/dkn-nexus-icon.png" alt="" /><span>{page === "home" ? "DKN" : "返回"}</span></button>
      <TransitionSwap transitionKey={page} variant="selection" duration={180} className="radial-page-deck">
      <div className={`radial-page radial-page-${page}`}>
      {page === "home" && <>
        <div className="radial-column-label radial-recent-label">最近复制</div>
        <div className="radial-column-label radial-favorite-label">常用片段</div>
        <div className="radial-column-label radial-action-label">快捷入口</div>
      </>}
      {page !== "ai" && page !== "note-editor" && page !== "tools" && nodes.map((node, index) => {
        const position = page === "home"
          ? node.kind === "recent" ? { left: "16%", top: `${34 + clipboard.findIndex((item) => item.id === node.value) * 16}%` }
            : node.kind === "favorite" ? { left: "39%", top: `${34 + favorites.findIndex((item) => item.id === node.value) * 16}%` }
              : node.value === "clipboard" ? { left: "27.5%", top: "82%" }
                : { left: "81%", top: `${27 + ["notes", "ai", "web", "tools"].indexOf(String(node.value)) * 15}%` }
          : radialNodePosition(index, nodes.length, 160);
        return <button key={node.id} data-radial-id={node.id} className={`radial-node ${page === "home" ? `radial-home-node radial-${node.kind}` : ""} ${selectedId === node.id ? "is-selected" : ""}`} style={{ ...position, animationDelay: `${Math.min(index, 7) * 24}ms` }} onPointerEnter={() => setSelectedId(node.id)} onClick={() => { setSelectedId(node.id); if (node.kind === "recent" || node.kind === "favorite") clickConsumedRef.current = true; if (page === "home" && node.kind === "action") keepOpenOnReleaseRef.current = true; commitRef.current(node.id); }} title={node.detail}>
          <span className="radial-node-label">{node.label}</span><small>{node.detail}</small>
        </button>;
      })}
      {page === "clipboard" && categoryOptions.length > 0 && <div className="radial-category-tray">{categoryOptions.slice(0, 5).map((name) => <button key={name} onClick={() => { setClipCategory(name); setPage("clipboard-category"); setSelectedId(""); }}>{name}</button>)}</div>}
      {page === "clipboard-category" && <div className="radial-category-tray"><button onClick={() => { setPage("clipboard"); setSelectedId(""); }}>全部常用</button>{categoryOptions.slice(0, 4).filter((name) => name !== clipCategory).map((name) => <button key={name} onClick={() => { setClipCategory(name); setSelectedId(""); }}>{name}</button>)}</div>}
      {page === "ai" && <section className="radial-sheet radial-ai-sheet"><label>Nexus AI</label><textarea autoFocus value={aiInput} onChange={(event) => setAiInput(event.target.value)} placeholder="输入问题，Enter 发送" onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void sendAi(); } }} /><div className="radial-ai-options"><label><input type="checkbox" checked={aiSearch} onChange={(event) => setAiSearch(event.target.checked)} /> 联网搜索</label><button onClick={() => void sendAi()} disabled={aiBusy}>{aiBusy ? "请求中…" : "发送"}</button></div>{aiError && <p className="radial-error">{aiError}</p>}{aiAnswer && <p className="radial-answer">{aiAnswer}</p>}</section>}
      {page === "note-editor" && activeNote && <section className="radial-sheet radial-note-sheet"><input value={activeNote.title} onChange={(event) => changeNote({ title: event.target.value })} /><textarea autoFocus value={activeNote.content} onChange={(event) => changeNote({ content: event.target.value })} placeholder="写下此刻的想法……" /><div><span>草稿保存在本机</span><button onClick={() => void saveTextNote()}>保存 TXT</button></div></section>}
      {page === "tools" && <section className="radial-sheet radial-tool-sheet"><p>更多工具将在这里扩展</p><button onClick={returnHome}>返回轮盘</button></section>}
      {page === "home" && <div className="radial-hold-hint">按住 Alt + Shift + Space · 指向剪贴片段后松开粘贴 · 点击其他入口</div>}
      {voiceStatus && <div className="radial-voice-status">{voiceStatus}</div>}
      <button className="radial-close" onClick={() => void close()} aria-label="关闭">×</button>
      </div>
      </TransitionSwap>
    </div>
  </main>;
}
