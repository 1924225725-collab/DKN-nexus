import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, PhysicalPosition } from "@tauri-apps/api/window";
import type { NexusSettings } from "./domain";
import { DEFAULT_SETTINGS } from "./domain";
import { AgentWorkspace, type AgentWorkspacePanel } from "./components/AgentWorkspace";
import { loadAiUsage, loadSettings, recordAiUsage, saveSettings } from "./services/preferences";

const PANEL_POSITIONS_KEY = "dkn-nexus:agent-panel-positions";
const PANEL_LOCKS_KEY = "dkn-nexus:agent-panel-locks";
function savedPanelPositions(): Record<string, { x: number; y: number }> {
  try { return JSON.parse(localStorage.getItem(PANEL_POSITIONS_KEY) ?? "{}"); } catch { return {}; }
}

function savedPanelLocks(): Record<string, boolean> {
  try { return JSON.parse(localStorage.getItem(PANEL_LOCKS_KEY) ?? "{}"); } catch { return {}; }
}

function savePanelPosition(label: string, x: number, y: number) {
  const positions = savedPanelPositions();
  positions[label] = { x, y };
  try { localStorage.setItem(PANEL_POSITIONS_KEY, JSON.stringify(positions)); } catch { /* The current session remains movable without saved positions. */ }
}

function resolvePanel(value: string | null): AgentWorkspacePanel {
  return value === "tools" ? "tools" : "workspace";
}

export function AgentWindow() {
  const requestedPanel = resolvePanel(new URLSearchParams(window.location.search).get("panel"));
  const [settings, setSettings] = useState<NexusSettings>(() => ({ ...DEFAULT_SETTINGS, ...loadSettings() }));
  const panel: AgentWorkspacePanel = requestedPanel === "tools" ? "tools" : "combined";
  useEffect(() => { document.documentElement.style.setProperty("--nexus-font-scale", settings.textSize === "small" ? "0.92" : settings.textSize === "large" ? "1.12" : "1"); }, [settings.textSize]);
  const [usage, setUsage] = useState(loadAiUsage());
  const [isOpening, setIsOpening] = useState(false);
  const [isWaking, setIsWaking] = useState(false);
  const [hasBeenOpened, setHasBeenOpened] = useState(!isTauri());
  const [positionLocked, setPositionLocked] = useState(() => isTauri() && Boolean(savedPanelLocks()[getCurrentWindow().label]));
  const settingsRef = useRef(settings);
  const resizeSaveTimer = useRef<number | undefined>(undefined);
  const openAnimationTimer = useRef<number | undefined>(undefined);
  settingsRef.current = settings;

  useEffect(() => {
    if (!isTauri()) return;
    const current = getCurrentWindow();
    const restored = savedPanelPositions()[current.label];
    if (restored && Number.isFinite(restored.x) && Number.isFinite(restored.y)) {
      void current.setPosition(new PhysicalPosition(restored.x, restored.y)).catch(() => undefined);
    }
    let unlisten: (() => void) | undefined;
    let unlistenMoved: (() => void) | undefined;
    let alive = true;
    const movedSubscription = current.onMoved(({ payload }) => savePanelPosition(current.label, payload.x, payload.y));
    void movedSubscription.then((cleanup) => { if (alive) unlistenMoved = cleanup; else cleanup(); }).catch(() => undefined);
    if (panel !== "combined") {
      return () => { alive = false; unlistenMoved?.(); };
    }
    const subscription = current.onResized(({ payload }) => {
      if (resizeSaveTimer.current !== undefined) window.clearTimeout(resizeSaveTimer.current);
      resizeSaveTimer.current = window.setTimeout(() => {
        void current.scaleFactor().then((scale) => {
          const width = Math.max(820, Math.round(payload.width / scale));
          const height = Math.max(560, Math.round(payload.height / scale));
          if (!alive) return;
          settingsRef.current = { ...settingsRef.current, agentWindowWidth: width, agentWindowHeight: height };
          setSettings(settingsRef.current);
          saveSettings(settingsRef.current);
        }).catch(() => undefined);
      }, 350);
    });
    void subscription.then((cleanup) => { if (alive) unlisten = cleanup; else cleanup(); });
    return () => {
      alive = false;
      if (resizeSaveTimer.current !== undefined) window.clearTimeout(resizeSaveTimer.current);
      unlisten?.();
      unlistenMoved?.();
    };
  }, [panel]);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== "dkn-nexus:settings") return;
      const next = loadSettings();
      setSettings((current) => ({ ...next, agentWindowWidth: current.agentWindowWidth, agentWindowHeight: current.agentWindowHeight }));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useEffect(() => {
    const preventBrowserMenu = (event: MouseEvent) => event.preventDefault();
    window.addEventListener("contextmenu", preventBrowserMenu, true);
    return () => window.removeEventListener("contextmenu", preventBrowserMenu, true);
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    const updateLocks = (value?: string | null) => {
      try {
        const locks = value ? JSON.parse(value) as Record<string, boolean> : savedPanelLocks();
        setPositionLocked(Boolean(locks[getCurrentWindow().label]));
      } catch { setPositionLocked(false); }
    };
    const onStorage = (event: StorageEvent) => { if (event.key === PANEL_LOCKS_KEY) updateLocks(event.newValue); };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    let alive = true;
    let unlistenFocus: (() => void) | undefined;
    let unlistenOpen: (() => void) | undefined;
    const current = getCurrentWindow();
    const focusSubscription = current.onFocusChanged(({ payload }) => {
      if (payload && alive) setHasBeenOpened(true);
    });
    void focusSubscription.then((cleanup) => { if (alive) unlistenFocus = cleanup; else cleanup(); }).catch(() => undefined);
    const openSubscription = listen("dkn://agent-open", () => {
      if (alive) setHasBeenOpened(true);
    });
    void openSubscription.then((cleanup) => { if (alive) unlistenOpen = cleanup; else cleanup(); }).catch(() => undefined);
    void Promise.all([current.isVisible(), current.isFocused()]).then(([visible, focused]) => {
      if (alive && (visible || focused)) setHasBeenOpened(true);
    }).catch(() => undefined);
    return () => { alive = false; unlistenFocus?.(); unlistenOpen?.(); };
  }, []);

  useEffect(() => {
    if (hasBeenOpened && isTauri()) void invoke("agent_window_ui_ready").catch(() => undefined);
  }, [hasBeenOpened]);

  useEffect(() => {
    if (!isTauri()) return;
    let alive = true;
    let unlisten: (() => void) | undefined;
    const current = getCurrentWindow();
    const enterWindow = () => {
      if (!alive || openAnimationTimer.current !== undefined) return;
      setIsOpening(false);
      setIsWaking(true);
      openAnimationTimer.current = window.setTimeout(() => {
        setIsOpening(false);
        setIsWaking(false);
        openAnimationTimer.current = undefined;
      }, 190);
    };
    const subscription = listen("dkn://agent-open", enterWindow);
    void subscription.then((cleanup) => { if (alive) unlisten = cleanup; else cleanup(); });
    void Promise.all([current.isVisible(), current.isFocused()]).then(([visible, focused]) => { if (visible || focused) enterWindow(); }).catch(() => undefined);
    return () => { alive = false; if (openAnimationTimer.current !== undefined) window.clearTimeout(openAnimationTimer.current); openAnimationTimer.current = undefined; unlisten?.(); };
  }, []);

  const updateSettings = (next: NexusSettings) => {
    settingsRef.current = next;
    setSettings(next);
    saveSettings(next);
  };

  const togglePositionLock = () => {
    const locks = savedPanelLocks();
    const next = !positionLocked;
    locks[isTauri() ? getCurrentWindow().label : "agent"] = next;
    try { localStorage.setItem(PANEL_LOCKS_KEY, JSON.stringify(locks)); } catch { /* The lock is still active for this session. */ }
    setPositionLocked(next);
  };

  const panelHeading = panel === "tools" ? "模型与账户" : "工作对话";

  return <main className="shell agent-shell" data-theme={settings.visualTheme} data-waking={isWaking ? "true" : undefined} data-reduced-motion={settings.reducedMotion ? "true" : undefined} style={{ "--nexus-font-scale": settings.textSize === "small" ? 0.92 : settings.textSize === "large" ? 1.12 : 1 } as CSSProperties} onContextMenu={(event) => event.preventDefault()}>
    <section className={`nexus-window agent-window agent-window-${panel} ${isOpening ? "is-opening" : ""}`} aria-label={`DKN Nexus Agent ${panelHeading}`}>
      <header className={`agent-window-bar ${positionLocked ? "is-position-locked" : ""}`} data-tauri-drag-region={!positionLocked} onMouseDown={(event) => {
        if (event.button !== 0 || (event.target as HTMLElement).closest("button, input, textarea, a")) return;
        if (positionLocked) return;
        if (event.detail > 1) { event.preventDefault(); return; }
        void getCurrentWindow().startDragging().catch((error) => console.warn("Agent 窗口拖动失败。", error));
      }}>
        <div className="agent-window-brand" data-tauri-drag-region={!positionLocked}><img className="brand-icon" src="/dkn-nexus-icon.png" alt="" /><span className="brand-divider" /><span>DKN NEXUS <i>/</i> {panelHeading}</span></div>
        <div className="agent-window-controls" onMouseDown={(event) => event.stopPropagation()}>
          <button className={`agent-size-choice agent-lock-choice ${positionLocked ? "is-active" : ""}`} aria-label={positionLocked ? "解除固定位置" : "固定当前位置"} onClick={togglePositionLock}>{positionLocked ? "已固定" : "固定"}</button>
          <button className="agent-window-close" aria-label="隐藏 Agent 窗口" onClick={() => void invoke("hide_agent_window").catch((error) => console.warn("Agent 窗口隐藏失败。", error))}>×</button>
        </div>
      </header>
      {hasBeenOpened ? <AgentWorkspace
          panel={panel}
          settings={settings}
          onSettingsChange={updateSettings}
          onOpenSettings={() => { void invoke("open_main_settings").catch((error) => console.warn("无法打开主窗口设置。", error)); }}
          onUsage={(inputTokens, outputTokens, searched) => setUsage(recordAiUsage(inputTokens, outputTokens, searched))}
        /> : <div className="agent-startup-placeholder">Agent 工作台将在打开时初始化</div>}
    </section>
  </main>;
}
