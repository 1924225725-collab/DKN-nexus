import { useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { AiChatSession, ChatMessage, NexusSettings } from "../domain";
import { askNexus } from "../services/ai";
import { copyClipboard } from "../services/clipboard";
import { loadAiChatSessions, saveAiChatSessions } from "../services/preferences";
import { TransitionSwap } from "./TransitionSwap";
import { InterfaceIcon } from "./Icons";

function createId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function titleFor(messages: ChatMessage[]): string {
  return messages.find((message) => message.role === "user")?.content.slice(0, 24) || "新对话";
}

function boundedContext(messages: ChatMessage[]): ChatMessage[] {
  let remaining = 16_000;
  const context: ChatMessage[] = [];
  for (const message of messages.slice(-16).reverse()) {
    if (remaining <= 0) break;
    const content = message.content.length > remaining ? message.content.slice(-remaining) : message.content;
    context.push({ ...message, content });
    remaining -= content.length;
  }
  return context.reverse();
}

export function AIPanel({ settings, onOpenSettings, onUsage }: { settings: NexusSettings; onOpenSettings: () => void; onUsage: (inputTokens: number, outputTokens: number, searched: boolean) => void }) {
  const initialSessions = useRef(loadAiChatSessions()).current;
  const [sessions, setSessions] = useState<AiChatSession[]>(initialSessions);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(initialSessions[0]?.id ?? null);
  const [messages, setMessages] = useState<ChatMessage[]>(initialSessions[0]?.messages ?? []);
  const [input, setInput] = useState("");
  const [search, setSearch] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sources, setSources] = useState<Record<number, ReadonlyArray<{ title: string; url: string }>>>({});
  const controller = useRef<AbortController | null>(null);

  const persistMessages = (sessionId: string, nextMessages: ChatMessage[]) => {
    setMessages(nextMessages);
    setSessions((current) => {
      const now = Date.now();
      const existing = current.find((session) => session.id === sessionId);
      const next = existing
        ? current.map((session) => session.id === sessionId ? { ...session, title: titleFor(nextMessages), messages: nextMessages, updatedAt: now } : session)
        : [{ id: sessionId, title: titleFor(nextMessages), messages: nextMessages, createdAt: now, updatedAt: now }, ...current];
      saveAiChatSessions(next);
      return next;
    });
  };

  const newChat = () => { setActiveSessionId(null); setMessages([]); setSources({}); setError(""); };
  const selectSession = (session: AiChatSession) => { setActiveSessionId(session.id); setMessages(session.messages); setSources({}); setError(""); };
  const deleteSession = (id: string) => {
    const next = sessions.filter((session) => session.id !== id);
    setSessions(next); saveAiChatSessions(next);
    if (activeSessionId === id) { const replacement = next[0]; setActiveSessionId(replacement?.id ?? null); setMessages(replacement?.messages ?? []); setSources({}); }
  };

  const send = async () => {
    const content = input.trim(); if (!content || busy) return;
    const sessionId = activeSessionId ?? createId();
    if (!activeSessionId) setActiveSessionId(sessionId);
    const next = [...messages, { role: "user" as const, content }];
    persistMessages(sessionId, next); setInput(""); setError(""); setBusy(true); controller.current = new AbortController();
    try {
      const result = await askNexus(boundedContext(next), settings, search, controller.current.signal);
      const assistantMessages = [...next, { role: "assistant" as const, content: result.content }];
      setSources((current) => ({ ...current, [assistantMessages.length - 1]: result.sources }));
      persistMessages(sessionId, assistantMessages);
      onUsage(result.usage?.promptTokens ?? 0, result.usage?.completionTokens ?? 0, result.searched);
    } catch (cause) { if ((cause as Error)?.name !== "AbortError") setError(cause instanceof Error ? cause.message : "AI 请求失败"); }
    finally { setBusy(false); controller.current = null; }
  };

  return <div className="ai-layout"><aside className="ai-history"><div className="panel-heading"><span>历史对话</span><button className="new-note-button" onClick={newChat} aria-label="新建对话"><InterfaceIcon name="plus" size={17} /></button></div>{sessions.length === 0 ? <p className="panel-empty">发送消息后会自动保存</p> : sessions.map((session) => <div className={`ai-history-item ${session.id === activeSessionId ? "is-active" : ""}`} key={session.id}><button onClick={() => selectSession(session)}><strong>{session.title}</strong><span>{new Date(session.updatedAt).toLocaleDateString()}</span></button><button className="ai-history-delete" onClick={() => deleteSession(session.id)} aria-label={`删除${session.title}`}>×</button></div>)}</aside><div className="ai-panel"><div className="page-heading"><div><p className="eyebrow">NEXUS / AI</p><h1>Nexus AI</h1><p className="page-description">对话保存在本机。没有配置密钥时不会发起请求。</p></div><button className="quiet-button" onClick={onOpenSettings}>AI 设置</button></div><TransitionSwap transitionKey={activeSessionId ?? "new-chat"} variant="conversation" className="ai-conversation-swap"><div className="ai-messages">{messages.length === 0 ? <div className="ai-empty"><span className="ai-orb">N</span><p>输入一个问题，开始与 Nexus 对话。</p></div> : messages.map((message, index) => <article className={`ai-message ${message.role}`} key={`${message.role}-${index}`} style={{ "--message-index": index } as CSSProperties}><span className="ai-role">{message.role === "user" ? "你" : "NEXUS"}</span><p>{message.content}</p>{message.role === "assistant" && <>{sources[index]?.length > 0 && <div className="ai-sources">来源：{sources[index].map((source) => <a key={source.url} href={source.url} target="_blank" rel="noreferrer">{source.title}</a>)}</div>}<button className="copy-answer" onClick={() => void copyClipboard(message.content)}>复制回答</button></>}</article>)}{busy && <div className="ai-message assistant"><span className="ai-role">NEXUS</span><p className="ai-thinking">正在思考……</p></div>}</div></TransitionSwap>{error && <div className="ai-error">{error}</div>}<div className="ai-composer"><textarea value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if ((event.nativeEvent?.isComposing || event.key === "Process" || event.key === "Unidentified") || (event.key === "Enter" && event.shiftKey)) return; if (event.key === "Enter") { event.preventDefault(); void send(); } }} placeholder="输入问题……" disabled={busy} /><div className="ai-composer-actions"><label><input type="checkbox" checked={search} onChange={(event) => setSearch(event.target.checked)} /> 联网搜索</label>{busy ? <button className="quiet-button" onClick={() => controller.current?.abort()}>中止</button> : <button className="primary-action" onClick={() => void send()}>发送</button>}</div></div></div></div>;
}
