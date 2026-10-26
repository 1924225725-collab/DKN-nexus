import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, FormEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { invoke, isTauri } from "@tauri-apps/api/core";
import type { AiClassificationCacheEntry, AppAnnotation, AppCategory, AppClassification, AiUsage, ClipboardEntry, ClipboardFavorite, NexusApp, NexusMode, NexusSettings, NoteRecord, UserAppCategory, WebShortcut } from "./domain";
import { DEFAULT_SETTINGS } from "./domain";
import { launchApp, loadCachedApps, pickApplicationFile, scanAppCatalog, searchApps } from "./services/appCatalog";
import { configureRadialShortcut, loadAiClassificationCache, loadAiUsage, loadAppAnnotations, loadCategoryOverrides, loadClassificationOverrides, loadClipboardFavorites, loadClipboardHistory, loadCustomApps, loadHiddenAppIds, loadModes, loadNotes, loadPinnedIds, loadQuickLaunchIds, loadSettings, loadUserAppCategories, loadWebShortcuts, recordAiUsage, runNexusMode, saveAiClassificationCache, saveAppAnnotations, saveCategoryOverrides, saveClassificationOverrides, saveClipboardFavorites, saveClipboardHistory, saveCustomApps, saveHiddenAppIds, saveModes, saveNotes, savePinnedIds, saveQuickLaunchIds, saveSettings, saveUserAppCategories, saveWebShortcuts, setGlobalShortcut, setLaunchAtStartup } from "./services/preferences";
import { appendClipboardEntry, copyClipboard } from "./services/clipboard";
import { createNote, saveNoteFile, updateNote } from "./services/notes";
import { AppRow } from "./components/AppRow";
import { AppIcon } from "./components/AppIcon";
import { ClipboardPanel } from "./components/ClipboardPanel";
import { QuickLaunchPanel } from "./components/QuickLaunchPanel";
import { WebShortcutPanel } from "./components/WebShortcutPanel";
import { AIPanel } from "./components/AIPanel";
import { ModesPanel } from "./components/ModesPanel";
import { TransitionSwap } from "./components/TransitionSwap";
import { CustomAppPanel } from "./components/CustomAppPanel";
import { MotionPresence } from "./components/MotionPresence";
import { PlaybackDevicesSettings } from "./components/PlaybackDevicesSettings";
import { moveSelectionBubble } from "./components/selectionBubble";
import { CloseIcon, InterfaceIcon, RefreshIcon, SearchIcon, SettingsIcon, SparkIcon } from "./components/Icons";
import type { InterfaceIconName } from "./components/Icons";
import { zhCN as t } from "./locales/zh-CN";
import { loadFavicon, openWebShortcut } from "./services/webShortcuts";
import { loadSecret, saveSecret } from "./services/secrets";
import { classifyApplicationLocally, classifyApplicationWithAI, testDeepSeekConnection } from "./services/ai";

type View = "launcher" | "notes" | "web" | "ai" | "modes" | "settings";
type MotionDirection = "forward" | "backward";
type ContextMenuState = { app: NexusApp; x: number; y: number } | null;
const HIDDEN_CLASSIFICATIONS = new Set<AppClassification>(["uninstaller", "installer"]);
const VIEW_ORDER: View[] = ["launcher", "modes", "web", "notes", "ai", "settings"];
const MAIN_TABS: Array<{ view: View; label: string; icon: InterfaceIconName }> = [
  { view: "launcher", label: "应用", icon: "apps" }, { view: "modes", label: "模式", icon: "modes" },
  { view: "web", label: "网页", icon: "web" }, { view: "notes", label: "记事", icon: "notes" },
  { view: "ai", label: "AI", icon: "ai" },
];
type SettingsCategory = "appearance" | "input" | "agent" | "account" | "storage" | "sound" | "apps" | "about";
const SETTINGS_CATEGORIES: Array<{ id: SettingsCategory; label: string; icon: InterfaceIconName }> = [
  { id: "appearance", label: "外观与窗口", icon: "appearance" },
  { id: "input", label: "快捷键与语音", icon: "input" },
  { id: "agent", label: "Agent", icon: "agent" },
  { id: "account", label: "账户与模型", icon: "account" },
  { id: "storage", label: "存储与隐私", icon: "storage" },
  { id: "sound", label: "声音与设备", icon: "audio" },
  { id: "apps", label: "应用", icon: "apps" },
  { id: "about", label: "关于", icon: "about" },
];
function animateContentEntrance(current: HTMLElement | null | undefined, direction: MotionDirection, distance: number, duration: number): void {
  if (!current) return;
  const activeAnimation = current.getAnimations().find((animation) => animation.playState === "running");
  const currentTransform = getComputedStyle(current).transform;
  const currentX = activeAnimation && currentTransform !== "none" ? new DOMMatrixReadOnly(currentTransform).m41 : (direction === "forward" ? distance : -distance);
  current.getAnimations().forEach((animation) => animation.cancel());
  current.animate([
    { transform: `translate3d(${currentX}px,0,0)` },
    { transform: "translate3d(0,0,0)" },
  ], { duration, easing: "cubic-bezier(.22,.74,.2,1)", fill: "none" });
}
const DANGEROUS_CLASSIFICATIONS = new Set<AppClassification>(["uninstaller", "installer"]);
const UNCONVENTIONAL_CLASSIFICATIONS = new Set<AppClassification>(["runtime", "system-component", "updater", "helper"]);
const APP_CATEGORIES: Array<{ id: "all" | "frequent" | AppCategory; label: string }> = [{ id: "all", label: "全部" }, { id: "frequent", label: "常用" }, { id: "ai", label: "AI" }, { id: "development", label: "开发" }, { id: "game", label: "游戏" }, { id: "office", label: "办公" }, { id: "browser", label: "浏览器" }, { id: "media", label: "音乐 / 视频" }, { id: "social", label: "社交 / 通讯" }, { id: "system-tool", label: "系统工具" }, { id: "other", label: "其他" }];

function effectiveClassification(app: NexusApp, overrides: Record<string, AppClassification>, cache?: Record<string, AiClassificationCacheEntry>): AppClassification { return overrides[app.id] ?? cachedClassification(app, cache ?? {})?.type ?? app.classification ?? "unknown"; }
function applyAppState(app: NexusApp, overrides: Record<string, AppClassification>): NexusApp { return { ...app, classification: effectiveClassification(app, overrides) }; }
function classificationFingerprint(app: NexusApp): string { return [app.name, app.launchTarget, app.shortcutPath, app.publisher, app.productName, app.fileDescription].map((value) => (value ?? "").trim().toLowerCase()).join("\u001f"); }
function cachedClassification(app: NexusApp, cache: Record<string, AiClassificationCacheEntry>): AiClassificationCacheEntry | undefined {
  const fingerprint = classificationFingerprint(app);
  const matchesCurrentInfo = (entry: AiClassificationCacheEntry) => entry.fingerprint === fingerprint;
  const byId = cache[app.id];
  if (byId && matchesCurrentInfo(byId)) return byId;
  return Object.values(cache).find((entry) => entry.launchTarget.toLowerCase() === app.launchTarget.toLowerCase() && matchesCurrentInfo(entry));
}
function mergeCatalogApps(scanned: NexusApp[], custom: NexusApp[], overrides: Record<string, AppClassification>, categories: Record<string, AppCategory>, pinnedIds: string[]): NexusApp[] {
  const merged = new Map<string, NexusApp>();
  scanned.forEach((app) => merged.set(`scanned:${app.id}`, app));
  custom.forEach((app) => {
    const target = app.launchTarget.toLowerCase();
    for (const [key, existing] of merged) if (existing.launchTarget.toLowerCase() === target) merged.delete(key);
    merged.set(`custom:${target}`, app);
  });
  return [...merged.values()].map((app) => ({ ...applyAppState(app, overrides), category: categories[app.id] ?? app.category ?? "other", isPinned: pinnedIds.includes(app.id) }));
}

import { createMainWindowHide } from "./services/mainWindowHide";

// Single, shared main-window hide coordinator. X / Esc and any other caller go
// through `hideNexusWindow`, which reuses the same in-flight promise so repeated
// requests never stack timers or fallback hides.
const mainWindowHide = isTauri()
  ? createMainWindowHide({
      nativeHide: () => invoke<void>("hide_main_window"),
      directHide: () => getCurrentWindow().hide(),
      musicLinkage: () => invoke("hide_owned_music_window"),
      createTimer: (ms, cb) => window.setTimeout(cb, ms),
      clearTimer: (id) => window.clearTimeout(id as number),
      onError: (error, phase) => {
        if (phase === "fallback") {
          console.warn("DKN Nexus native hide did not settle; using direct hide.", error);
        } else if (phase === "music") {
          // The music linkage failed or hung. It must not block the hide, but it
          // is recorded so the failure is observable rather than swallowed.
          console.warn("DKN Nexus music linkage during hide failed.", error);
        }
      },
    })
  : null;

function hideNexusWindow(): Promise<void> {
  if (!isTauri() || !mainWindowHide) return Promise.resolve();
  return mainWindowHide.hide();
}

/**
 * Fire-and-forget hide for the X button and Esc shortcut. The coordinator may
 * legitimately reject (e.g. the direct window API is unavailable); that failure
 * must be observed here rather than escaping as a global unhandled rejection.
 * We do not pretend the window hid — only that the request was attempted.
 */
function requestHideNexusWindow(): void {
  void hideNexusWindow().catch((error) => {
    console.warn("DKN Nexus 主窗隐藏请求失败。", error);
  });
}

function startWindowDragging(event: ReactMouseEvent<HTMLElement>): void {
  if (event.button !== 0 || (event.target as HTMLElement).closest("button, input, textarea, a, nav")) return;
  // Windows requires the native drag request during this mouse-down gesture.
  if (event.detail > 1) { event.preventDefault(); return; }
  if (!isTauri()) return;
  void getCurrentWindow().startDragging().catch((error) => console.warn("DKN Nexus could not start window dragging.", error));
}

const AGENT_PANEL_POSITIONS_KEY = "dkn-nexus:agent-panel-positions";
function requestAgentWorkspace(_windowMode: NexusSettings["agentWindowMode"] = "single", workspaceWidth = 1600, workspaceHeight = 900): void {
  let savedPositions: Record<string, { x: number; y: number }> = {};
  try {
    const stored = JSON.parse(localStorage.getItem(AGENT_PANEL_POSITIONS_KEY) ?? "{}");
    if (stored && typeof stored === "object") {
      for (const label of ["agent", "agent-tools"]) {
        const position = stored[label];
        if (position && Number.isFinite(position.x) && Number.isFinite(position.y)) savedPositions[label] = { x: position.x, y: position.y };
      }
    }
  } catch { /* Open with the default grouped layout if local position data is unavailable. */ }
  void invoke("open_agent_window", { savedPositions, windowMode: "single", workspaceWidth, workspaceHeight }).catch((error) => console.warn("无法打开 Agent 工作台。", error));
}

export default function App() {
  const [apps, setApps] = useState<NexusApp[]>([]);
  const [customApps, setCustomApps] = useState<NexusApp[]>([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [view, setView] = useState<View>("launcher");
  const [requestedSettingsCategory, setRequestedSettingsCategory] = useState<SettingsCategory>("appearance");
  const [visitedViews, setVisitedViews] = useState<View[]>(["launcher"]);
  const [category, setCategory] = useState<string>("all");
  const [visitedCategories, setVisitedCategories] = useState<string[]>(["all"]);
  const viewRef = useRef(view);
  viewRef.current = view;
  const lastAnimatedView = useRef(view);
  const lastAnimatedCategory = useRef(category);
  const lastEnteredView = useRef(view);
  const lastEnteredCategory = useRef(category);
  const viewDeckRef = useRef<HTMLDivElement>(null);
  const lastTrackIndex = useRef(0);
  const categoryDeckRef = useRef<HTMLDivElement>(null);
  const lastCategoryTrackIndex = useRef(0);
  const categoryTabsRef = useRef<HTMLDivElement>(null);
  const categoryIndicatorRef = useRef<HTMLSpanElement>(null);
  const categoryRef = useRef(category);
  const tabsRef = useRef<HTMLElement>(null);
  const tabIndicatorRef = useRef<HTMLSpanElement>(null);
  const [settings, setSettings] = useState<NexusSettings>(DEFAULT_SETTINGS);
  useEffect(() => { document.documentElement.style.setProperty("--nexus-font-scale", settings.textSize === "small" ? "0.92" : settings.textSize === "large" ? "1.12" : "1"); }, [settings.textSize]);
  const [isWindowWaking, setIsWindowWaking] = useState(false);
  const windowWakeTimer = useRef<number | undefined>(undefined);
  const [isColdStart, setIsColdStart] = useState(true);
  const coldStartRef = useRef(true);
  useEffect(() => { const timer = window.setTimeout(() => { coldStartRef.current = false; setIsColdStart(false); }, 1000); return () => window.clearTimeout(timer); }, []);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const refreshSequence = useRef(0);
  const refreshStopTimer = useRef<number | undefined>(undefined);
  const [quickLaunchIds, setQuickLaunchIds] = useState<string[]>([]);
  const [classificationOverrides, setClassificationOverrides] = useState<Record<string, AppClassification>>({});
  const [categoryOverrides, setCategoryOverrides] = useState<Record<string, AppCategory>>({});
  const [aiClassificationCache, setAiClassificationCache] = useState<Record<string, AiClassificationCacheEntry>>({});
  const [appAnnotations, setAppAnnotations] = useState<Record<string, AppAnnotation>>({});
  const [userCategories, setUserCategories] = useState<UserAppCategory[]>([]);
  const [hiddenAppIds, setHiddenAppIds] = useState<string[]>([]);
  const [clipboard, setClipboard] = useState<ClipboardEntry[]>([]);
  const [notes, setNotes] = useState<NoteRecord[]>([]);
  const [activeNoteId, setActiveNoteId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null);
  const [pendingLaunch, setPendingLaunch] = useState<NexusApp | null>(null);
  const [webShortcuts, setWebShortcuts] = useState<WebShortcut[]>([]);
  const [modes, setModes] = useState<NexusMode[]>([]);
  const [aiUsage, setAiUsage] = useState<AiUsage>(() => loadAiUsage());
  const [aiCredentialRevision, setAiCredentialRevision] = useState(0);
  const [classifyingAppId, setClassifyingAppId] = useState<string | null>(null);
  const [customAppEditorOpen, setCustomAppEditorOpen] = useState(false);
  const [annotationEditor, setAnnotationEditor] = useState<NexusApp | null>(null);
  const [annotationDraft, setAnnotationDraft] = useState("");
  const [annotationDisplayMode, setAnnotationDisplayMode] = useState<"original" | "note">("original");
  const [categoryManagerOpen, setCategoryManagerOpen] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState("");
  const [bulkClassifyStatus, setBulkClassifyStatus] = useState("");
  const [bulkClassifyArmed, setBulkClassifyArmed] = useState(false);
  const [contextMenuPosition, setContextMenuPosition] = useState({ left: 12, top: 12 });
  const inputRef = useRef<HTMLInputElement>(null);
  const imeComposingRef = useRef(false);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const internalClipboardWrite = useRef<string | null>(null);
  const settingsRef = useRef<NexusSettings>(DEFAULT_SETTINGS);
  const quickLaunchIdsRef = useRef<string[]>([]);
  const didInitialise = useRef(false);
  const autoClassificationRunning = useRef(false);

  const transitionView = (nextView: View) => {
    if (viewRef.current === nextView) return;
    viewRef.current = nextView;
    setVisitedViews((current) => current.includes(nextView) ? current : [...current, nextView]);
    setView(nextView);
  };

  useLayoutEffect(() => {
    const nav = tabsRef.current;
    if (!nav) return;
    const measure = () => {
      const selected = nav.querySelector<HTMLElement>(`button[data-view="${view}"]`);
      moveSelectionBubble(nav, tabIndicatorRef.current, selected, "x", !settings.reducedMotion && lastAnimatedView.current !== view);
      lastAnimatedView.current = view;
    };
    measure();
    const observer = new ResizeObserver(() => moveSelectionBubble(nav, tabIndicatorRef.current, nav.querySelector<HTMLElement>(`button[data-view="${view}"]`), "x", false));
    observer.observe(nav);
    return () => observer.disconnect();
  }, [view, settings.textSize, settings.reducedMotion]);

  useLayoutEffect(() => {
    if (lastEnteredView.current === view) return;
    lastEnteredView.current = view;
    const deck = viewDeckRef.current;
    const track = deck?.querySelector<HTMLElement>(".view-track");
    if (!deck || !track) return;
    const running = track.getAnimations().find((animation) => animation.playState === "running");
    const currentTransform = getComputedStyle(track).transform;
    const currentX = running && currentTransform !== "none"
      ? new DOMMatrixReadOnly(currentTransform).m41
      : -lastTrackIndex.current * deck.clientWidth;
    track.getAnimations().forEach((animation) => animation.cancel());
    const nextIndex = VIEW_ORDER.indexOf(view);
    lastTrackIndex.current = nextIndex;
    if (settings.reducedMotion) return;
    const targetX = -nextIndex * deck.clientWidth;
    track.animate([
      { transform: `translate3d(${currentX}px,0,0)` },
      { transform: `translate3d(${targetX}px,0,0)` },
    ], { duration: Math.max(240, Math.min(620, 300 + Math.abs(targetX - currentX) * 0.16)), easing: "cubic-bezier(.22,.74,.2,1)", fill: "none" });
  }, [view, settings.reducedMotion]);

  useLayoutEffect(() => {
    const shell = document.querySelector<HTMLElement>(".shell");
    const windowElement = shell?.querySelector<HTMLElement>(".nexus-window");
    if (!shell || !windowElement) return;
    const syncLayout = () => {
      const scale = settings.uiScale / 100;
      shell.style.setProperty("--nexus-shell-width", `${100 / scale}vw`);
      shell.style.setProperty("--nexus-shell-height", `${100 / scale}vh`);
      windowElement.style.setProperty("--nexus-window-width", `${Math.max(320, window.innerWidth / scale - 40)}px`);
      windowElement.style.setProperty("--nexus-window-height", `${Math.max(520, window.innerHeight / scale - 24)}px`);
    };
    syncLayout();
    window.addEventListener("resize", syncLayout);
    return () => window.removeEventListener("resize", syncLayout);
  }, [settings.uiScale, settings.mainWindowWidth, settings.mainWindowHeight]);

  const refreshApps = async (showLoading = false) => {
    const sequence = ++refreshSequence.current;
    const started = performance.now();
    if (refreshStopTimer.current !== undefined) window.clearTimeout(refreshStopTimer.current);
    setIsRefreshing(true); if (showLoading) setIsLoading(true);
    try {
      const nextApps = await scanAppCatalog();
      if (sequence === refreshSequence.current) setApps(mergeCatalogApps(nextApps, customApps, classificationOverrides, categoryOverrides, loadPinnedIds()));
    } catch (error) {
      console.warn("应用列表刷新失败。", error);
    } finally {
      if (sequence === refreshSequence.current) {
        setIsLoading(false);
        const elapsed = performance.now() - started;
        const remaining = Math.max(0, Math.ceil(Math.max(elapsed, 740) / 740) * 740 - elapsed);
        refreshStopTimer.current = window.setTimeout(() => { if (sequence === refreshSequence.current) setIsRefreshing(false); }, remaining);
      }
    }
  };

  useEffect(() => {
    if (didInitialise.current) return; didInitialise.current = true; let active = true;
    const overrides = loadClassificationOverrides(); const categories = loadCategoryOverrides(); const cached = loadCachedApps(); const pinnedIds = loadPinnedIds();
    const loadedQuickLaunchIds = loadQuickLaunchIds();
    const loadedCustomApps = loadCustomApps();
    quickLaunchIdsRef.current = loadedQuickLaunchIds;
    const loadedSettings = loadSettings();
    settingsRef.current = loadedSettings;
    setSettings(loadedSettings); if (isTauri()) void getCurrentWindow().setSize(new LogicalSize(Math.round(loadedSettings.mainWindowWidth * loadedSettings.uiScale / 100), Math.round(loadedSettings.mainWindowHeight * loadedSettings.uiScale / 100))).catch((error) => console.warn("DKN Nexus could not restore the saved window size.", error)); void setGlobalShortcut(loadedSettings.globalShortcut).catch((error) => console.warn("DKN Nexus could not restore the saved global shortcut.", error)); void configureRadialShortcut(loadedSettings.radialShortcut, loadedSettings.radialEnabled).catch((error) => console.warn("DKN Nexus could not restore the radial shortcut.", error));
    setQuickLaunchIds(loadedQuickLaunchIds); setCustomApps(loadedCustomApps); setClassificationOverrides(overrides); setCategoryOverrides(categories); setAiClassificationCache(loadAiClassificationCache()); setAppAnnotations(loadAppAnnotations()); setUserCategories(loadUserAppCategories()); setHiddenAppIds(loadHiddenAppIds()); setClipboard(loadClipboardHistory(loadedSettings.clipboardHistoryLimit)); setWebShortcuts(loadWebShortcuts()); setModes(loadModes());
    const loadedNotes = loadNotes(); setNotes(loadedNotes); setActiveNoteId(loadedNotes[0]?.id ?? null);
    if (cached.length) { setApps(mergeCatalogApps(cached, loadedCustomApps, overrides, categories, pinnedIds)); setIsLoading(false); }
    void scanAppCatalog().then((nextApps) => { if (!active) return; setApps(mergeCatalogApps(nextApps, loadedCustomApps, overrides, categories, loadPinnedIds())); setIsLoading(false); });
    inputRef.current?.focus(); return () => { active = false; };
  }, []);

  useEffect(() => {
    const credentialsSaved = () => setAiCredentialRevision((value) => value + 1);
    window.addEventListener("dkn:ai-credentials-saved", credentialsSaved);
    return () => window.removeEventListener("dkn:ai-credentials-saved", credentialsSaved);
  }, []);

  useEffect(() => {
    let disposed = false; let cleanups: Array<() => void> = [];
    const wakeWindow = () => {
      if (coldStartRef.current) return;
      if (windowWakeTimer.current !== undefined) window.clearTimeout(windowWakeTimer.current);
      setIsWindowWaking(false);
      requestAnimationFrame(() => { if (!disposed) setIsWindowWaking(true); });
      windowWakeTimer.current = window.setTimeout(() => { setIsWindowWaking(false); windowWakeTimer.current = undefined; }, 190);
    };
    void import("@tauri-apps/api/event").then(async ({ listen }) => {
      const open = await listen("dkn://open", () => { if (!disposed) { wakeWindow(); transitionView("launcher"); setQuery(""); requestAnimationFrame(() => inputRef.current?.focus()); } });
      const focus = await listen("dkn://focus", () => { if (!disposed) { wakeWindow(); transitionView("launcher"); requestAnimationFrame(() => inputRef.current?.focus()); } });
      const agentOpen = await listen("dkn://open-agent", () => { if (!disposed) requestAgentWorkspace(settingsRef.current.agentWindowMode, settingsRef.current.agentWindowWidth, settingsRef.current.agentWindowHeight); });
      const settingsEvent = await listen("dkn://settings", () => { if (!disposed) { transitionView("settings"); setQuery(""); } });
      const audioSettingsEvent = await listen("dkn://settings-audio", () => { if (!disposed) { setRequestedSettingsCategory("sound"); transitionView("settings"); setQuery(""); } });
      const clipboardEvent = await listen<string>("dkn://clipboard", (event) => {
        if (disposed || !event.payload?.trim()) return;
        if (internalClipboardWrite.current === event.payload) {
          internalClipboardWrite.current = null;
          return;
        }
        setClipboard((current) => { const limit = settingsRef.current.clipboardHistoryLimit; const next = appendClipboardEntry(current, event.payload, Date.now(), limit); if (next !== current) saveClipboardHistory(next, limit); return next; });
      });
      cleanups = [open, focus, agentOpen, settingsEvent, audioSettingsEvent, clipboardEvent];
    }).catch(() => undefined);
    return () => { disposed = true; if (windowWakeTimer.current !== undefined) window.clearTimeout(windowWakeTimer.current); cleanups.forEach((cleanup) => cleanup()); };
  }, []);

  useEffect(() => { const timer = window.setTimeout(() => saveNotes(notes), 250); return () => window.clearTimeout(timer); }, [notes]);
  useEffect(() => {
    if (!contextMenu) return;
    const close = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (target?.closest(".context-menu")) return;
      setContextMenu(null);
    };
    document.addEventListener("pointerdown", close, true);
    return () => document.removeEventListener("pointerdown", close, true);
  }, [contextMenu]);

  useLayoutEffect(() => {
    if (!contextMenu || !contextMenuRef.current) return;
    const rect = contextMenuRef.current.getBoundingClientRect();
    const margin = 12;
    const maxLeft = Math.max(margin, window.innerWidth - rect.width - margin);
    const left = Math.min(Math.max(margin, contextMenu.x), maxLeft);
    const maxTop = Math.max(margin, window.innerHeight - rect.height - margin);
    const below = contextMenu.y + 8;
    const above = contextMenu.y - rect.height - 8;
    const top = Math.min(Math.max(margin, below + rect.height <= window.innerHeight - margin ? below : above), maxTop);
    setContextMenuPosition((current) => current.left === left && current.top === top ? current : { left, top });
  }, [contextMenu]);

  useEffect(() => {
    if (!settings.aiClassificationEnabled || autoClassificationRunning.current) return;
    const candidates = apps.filter((app) => {
      const cached = cachedClassification(app, aiClassificationCache);
      const needsAiReview = !cached || (cached.source === "local" && cached.confidence < 0.6);
      return !classificationOverrides[app.id] && needsAiReview && classifyApplicationLocally(app).confidence < 0.6;
    });
    if (!candidates.length) return;
    autoClassificationRunning.current = true;
    void (async () => {
      try {
        if (!await loadSecret("deepseek-api-key")) return;
        for (const app of candidates) {
          if (!settingsRef.current.aiClassificationEnabled) break;
          try {
            const result = await classifyApplicationWithAI(app, settingsRef.current);
            const { usage, ...classification } = result;
            const entry = { appId: app.id, launchTarget: app.launchTarget, fingerprint: classificationFingerprint(app), ...classification, source: "ai" as const, analyzedAt: Date.now() };
            setAiClassificationCache((current) => { const next = { ...current, [app.id]: entry }; saveAiClassificationCache(next); return next; });
            setAiUsage(recordAiUsage(usage?.promptTokens ?? 0, usage?.completionTokens ?? 0, false));
          } catch (error) {
            console.info("DKN Nexus automatic classification skipped an app after an AI error.", error);
          }
        }
      } catch (error) {
        console.info("DKN Nexus automatic classification is unavailable.", error);
      } finally { autoClassificationRunning.current = false; }
    })();
  }, [aiClassificationCache, aiCredentialRevision, apps, classificationOverrides, settings.aiClassificationEnabled]);

  const categoryItems = useMemo(() => [...APP_CATEGORIES, ...userCategories.map((item) => ({ id: item.id as AppCategory, label: item.label }))], [userCategories]);
  const changeCategory = (nextCategory: string) => {
    if (categoryRef.current === nextCategory) return;
    categoryRef.current = nextCategory;
    setVisitedCategories((current) => current.includes(nextCategory) ? current : [...current, nextCategory]);
    setCategory(nextCategory);
  };
  useLayoutEffect(() => {
    const tabs = categoryTabsRef.current;
    if (!tabs) return;
    const measure = () => {
      const selected = [...tabs.querySelectorAll<HTMLButtonElement>("button[data-category]")].find((button) => button.dataset.category === category);
      moveSelectionBubble(tabs, categoryIndicatorRef.current, selected ?? null, "x", !settings.reducedMotion && lastAnimatedCategory.current !== category);
      lastAnimatedCategory.current = category;
    };
    measure();
    const observer = new ResizeObserver(() => {
      const selected = [...tabs.querySelectorAll<HTMLButtonElement>("button[data-category]")].find((button) => button.dataset.category === category);
      moveSelectionBubble(tabs, categoryIndicatorRef.current, selected ?? null, "x", false);
    });
    observer.observe(tabs);
    return () => observer.disconnect();
  }, [category, categoryItems, view, settings.textSize, settings.reducedMotion]);

  useLayoutEffect(() => {
    if (lastEnteredCategory.current === category) return;
    lastEnteredCategory.current = category;
    const deck = categoryDeckRef.current;
    const track = deck?.querySelector<HTMLElement>(".category-track");
    if (!deck || !track) return;
    const running = track.getAnimations().find((animation) => animation.playState === "running");
    const currentTransform = getComputedStyle(track).transform;
    const currentX = running && currentTransform !== "none"
      ? new DOMMatrixReadOnly(currentTransform).m41
      : -lastCategoryTrackIndex.current * deck.clientWidth;
    track.getAnimations().forEach((animation) => animation.cancel());
    const nextIndex = categoryItems.findIndex((item) => item.id === category);
    lastCategoryTrackIndex.current = nextIndex;
    if (settings.reducedMotion) return;
    const targetX = -nextIndex * deck.clientWidth;
    track.animate([
      { transform: `translate3d(${currentX}px,0,0)` },
      { transform: `translate3d(${targetX}px,0,0)` },
    ], { duration: Math.max(220, Math.min(560, 280 + Math.abs(targetX - currentX) * 0.14)), easing: "cubic-bezier(.22,.74,.2,1)", fill: "none" });
  }, [category, categoryItems, settings.reducedMotion]);
  const visibleApps = useMemo(() => apps.map((app) => {
    const cached = cachedClassification(app, aiClassificationCache);
    const annotation = appAnnotations[app.id];
    const note = annotation?.note ?? app.note;
    return { ...app, note, displayName: annotation?.displayLabelMode === "note" && note ? note : app.name, classification: classificationOverrides[app.id] ?? cached?.type ?? app.classification ?? "unknown", category: categoryOverrides[app.id] ?? cached?.category ?? app.category ?? "other" };
  }).filter((app) => {
    const manuallyNormal = classificationOverrides[app.id] === "normal-app";
    const cached = cachedClassification(app, aiClassificationCache);
    const classification = app.classification ?? "unknown";
    if (hiddenAppIds.includes(app.id)) return false;
    if (cached?.show === false && !manuallyNormal) return false;
    if (HIDDEN_CLASSIFICATIONS.has(classification) && !manuallyNormal) return false;
    if (settings.filterUnconventionalApps && UNCONVENTIONAL_CLASSIFICATIONS.has(classification) && !manuallyNormal) return false;
    return true;
  }), [aiClassificationCache, appAnnotations, apps, classificationOverrides, categoryOverrides, hiddenAppIds, settings.filterUnconventionalApps]);
  const categoryResults = useMemo(() => Object.fromEntries(categoryItems.map((item) => {
    const appsForCategory = item.id === "all" ? visibleApps : item.id === "frequent" ? visibleApps.filter((app) => app.isPinned || quickLaunchIds.includes(app.id)) : visibleApps.filter((app) => app.category === item.id);
    return [item.id, searchApps(appsForCategory, query)];
  })) as Record<string, NexusApp[]>, [categoryItems, quickLaunchIds, query, visibleApps]);
  const results = categoryResults[category] ?? [];
  const pinned = results.filter((app) => app.isPinned); const unpinned = results.filter((app) => !app.isPinned); const selectedApp = results[selected];
  const quickApps = useMemo(() => quickLaunchIds.map((id) => visibleApps.find((app) => app.id === id)).filter(Boolean) as NexusApp[], [quickLaunchIds, visibleApps]);
  const activeNote = notes.find((note) => note.id === activeNoteId) ?? null;

  useEffect(() => { setSelected(0); }, [query, category]);
  useEffect(() => { if (selected >= results.length) setSelected(Math.max(0, results.length - 1)); }, [results.length, selected]);
  useEffect(() => {
    if (category === "all") return;
    requestAnimationFrame(() => document.querySelector<HTMLElement>(".category-card.is-selected")?.scrollIntoView({ block: "nearest", inline: "nearest" }));
  }, [category, results.length, selected]);

  const togglePin = (id: string) => setApps((current) => { const next = current.map((app) => app.id === id ? { ...app, isPinned: !app.isPinned } : app); savePinnedIds(next.filter((app) => app.isPinned).map((app) => app.id)); return next; });
  const toggleQuickLaunch = (id: string) => {
    const current = quickLaunchIdsRef.current;
    const next = current.includes(id) ? current.filter((value) => value !== id) : [...current, id];
    quickLaunchIdsRef.current = next;
    setQuickLaunchIds(next);
    saveQuickLaunchIds(next);
  };
  const addCustomApp = (app: NexusApp) => { const next = [...customApps, app]; setCustomApps(next); saveCustomApps(next); setApps((current) => [...current.filter((item) => item.launchTarget.toLowerCase() !== app.launchTarget.toLowerCase()), app]); changeCategory("all"); setQuery(""); };
  const removeCustomApp = (id: string) => { const next = customApps.filter((app) => app.id !== id); setCustomApps(next); saveCustomApps(next); setApps((current) => current.filter((app) => app.id !== id)); const nextQuick = quickLaunchIdsRef.current.filter((value) => value !== id); quickLaunchIdsRef.current = nextQuick; setQuickLaunchIds(nextQuick); saveQuickLaunchIds(nextQuick); };
  const removeAppEntry = (app: NexusApp) => {
    if (app.source === "custom") removeCustomApp(app.id); else hideApp(app.id);
    const nextQuick = quickLaunchIdsRef.current.filter((value) => value !== app.id); quickLaunchIdsRef.current = nextQuick; setQuickLaunchIds(nextQuick); saveQuickLaunchIds(nextQuick);
    const nextAnnotations = { ...appAnnotations }; delete nextAnnotations[app.id]; setAppAnnotations(nextAnnotations); saveAppAnnotations(nextAnnotations);
    const nextCache = { ...aiClassificationCache }; delete nextCache[app.id]; setAiClassificationCache(nextCache); saveAiClassificationCache(nextCache);
  };
  const openAnnotationEditor = (app: NexusApp) => {
    const annotation = appAnnotations[app.id];
    setAnnotationEditor(app); setAnnotationDraft(annotation?.note ?? app.note ?? ""); setAnnotationDisplayMode(annotation?.displayLabelMode ?? "original");
  };
  const saveAnnotation = () => {
    if (!annotationEditor) return;
    const next = { ...appAnnotations, [annotationEditor.id]: { note: annotationDraft.trim(), displayLabelMode: annotationDisplayMode, updatedAt: Date.now() } };
    if (!next[annotationEditor.id].note) delete next[annotationEditor.id];
    setAppAnnotations(next); saveAppAnnotations(next); setAnnotationEditor(null);
  };
  const createCategory = () => {
    const label = newCategoryName.trim(); if (!label) return;
    if (categoryItems.some((item) => item.label.toLowerCase() === label.toLowerCase())) return;
    const item = { id: `custom-category-${Date.now()}`, label, createdAt: Date.now() };
    const next = [...userCategories, item]; setUserCategories(next); saveUserAppCategories(next); setNewCategoryName(""); changeCategory(item.id); setCategoryManagerOpen(false);
  };
  const renameCategory = (item: UserAppCategory) => {
    const label = window.prompt("修改分类名称", item.label)?.trim(); if (!label || label === item.label) return;
    const next = userCategories.map((value) => value.id === item.id ? { ...value, label } : value); setUserCategories(next); saveUserAppCategories(next);
  };
  const deleteCategory = (item: UserAppCategory) => {
    const next = userCategories.filter((value) => value.id !== item.id); setUserCategories(next); saveUserAppCategories(next);
    const nextOverrides = Object.fromEntries(Object.entries(categoryOverrides).filter(([, value]) => value !== item.id)); setCategoryOverrides(nextOverrides); saveCategoryOverrides(nextOverrides); if (category === item.id) changeCategory("all");
  };
  const markNormal = (id: string) => setClassificationOverrides((current) => { const next = { ...current, [id]: "normal-app" as const }; saveClassificationOverrides(next); return next; });
  const setCategoryOverride = (id: string, value: AppCategory) => { const next = { ...categoryOverrides, [id]: value }; setCategoryOverrides(next); saveCategoryOverrides(next); };
  const resetCategoryOverride = (id: string) => { const next = { ...categoryOverrides }; delete next[id]; setCategoryOverrides(next); saveCategoryOverrides(next); };
  const reclassifyApp = async (app: NexusApp) => {
    setClassifyingAppId(app.id);
    try {
      let result; let source: "ai" | "local" = "ai";
      try { result = await classifyApplicationWithAI(app, settings); }
      catch (error) { console.info("DKN Nexus AI classification unavailable; using local rules", error); result = { ...classifyApplicationLocally(app), usage: undefined }; source = "local"; }
      const { usage, ...classification } = result;
      const nextCache = { ...aiClassificationCache, [app.id]: { appId: app.id, launchTarget: app.launchTarget, fingerprint: classificationFingerprint(app), ...classification, source, analyzedAt: Date.now() } }; setAiClassificationCache(nextCache); saveAiClassificationCache(nextCache);
      if (source === "ai") setAiUsage(recordAiUsage(usage?.promptTokens ?? 0, usage?.completionTokens ?? 0, false));
    } catch (error) { console.warn("DKN Nexus AI classification failed", error); }
    finally { setClassifyingAppId(null); }
  };
  const reclassifyAllApps = async () => {
    if (bulkClassifyStatus.startsWith("正在")) return;
    const targets = [...apps];
    let nextCache = { ...aiClassificationCache };
    try {
      for (let index = 0; index < targets.length; index += 1) {
        setBulkClassifyStatus(`正在使用 AI 分类 ${index + 1} / ${targets.length}。${targets[index].name}`);
        const result = await classifyApplicationWithAI(targets[index], settings);
        const { usage, ...classification } = result;
        nextCache[targets[index].id] = { appId: targets[index].id, launchTarget: targets[index].launchTarget, fingerprint: classificationFingerprint(targets[index]), ...classification, source: "ai", analyzedAt: Date.now() };
        setAiUsage(recordAiUsage(usage?.promptTokens ?? 0, usage?.completionTokens ?? 0, false));
        saveAiClassificationCache(nextCache);
      }
      setAiClassificationCache(nextCache); saveAiClassificationCache(nextCache);
      setBulkClassifyStatus(`AI 全量分类完成。${targets.length} 个应用`);
    } catch (error) {
      setAiClassificationCache(nextCache); saveAiClassificationCache(nextCache);
      setBulkClassifyStatus(error instanceof Error ? `AI 分类中止。${error.message}` : "AI 分类中止");
    }
  };
  useEffect(() => {
    const run = () => void reclassifyAllApps();
    window.addEventListener("dkn:bulk-classify", run);
    return () => window.removeEventListener("dkn:bulk-classify", run);
  });
  useEffect(() => { window.dispatchEvent(new CustomEvent("dkn:bulk-classify-status", { detail: bulkClassifyStatus })); }, [bulkClassifyStatus]);
  const hideApp = (id: string) => setHiddenAppIds((current) => { const next = [...new Set([...current, id])]; saveHiddenAppIds(next); return next; });
  const handleLaunch = (app: NexusApp) => { if (DANGEROUS_CLASSIFICATIONS.has(effectiveClassification(app, classificationOverrides, aiClassificationCache))) setPendingLaunch(app); else void launchApp(app); };
  const updateSettings = async (next: NexusSettings) => {
    const previous = settings;
    let mainShortcutChanged = false;
    if (next.uiScale !== previous.uiScale && isTauri()) {
      await getCurrentWindow().setSize(new LogicalSize(Math.round(next.mainWindowWidth * next.uiScale / 100), Math.round(next.mainWindowHeight * next.uiScale / 100)));
    }
    if (next.globalShortcut !== previous.globalShortcut) {
      try { await setGlobalShortcut(next.globalShortcut); }
      catch (error) { setSettings(previous); saveSettings(previous); throw error; }
      mainShortcutChanged = true;
    }
    if (next.radialShortcut !== previous.radialShortcut || next.radialEnabled !== previous.radialEnabled) {
      try { await configureRadialShortcut(next.radialShortcut, next.radialEnabled); }
      catch (error) {
        if (mainShortcutChanged) await setGlobalShortcut(previous.globalShortcut).catch(() => undefined);
        setSettings(previous); saveSettings(previous); throw error;
      }
    }
    settingsRef.current = next;
    setSettings(next); saveSettings(next);
    if (next.agentWindowMode !== previous.agentWindowMode && isTauri()) {
      let savedPositions: Record<string, { x: number; y: number }> = {};
      try {
        const stored = JSON.parse(localStorage.getItem(AGENT_PANEL_POSITIONS_KEY) ?? "{}");
        if (stored && typeof stored === "object") for (const label of ["agent", "agent-tools"]) {
          const position = stored[label];
          if (position && Number.isFinite(position.x) && Number.isFinite(position.y)) savedPositions[label] = { x: position.x, y: position.y };
        }
      } catch { /* Keep the default adjacent layout if stored positions are unavailable. */ }
      void invoke("configure_agent_window_mode", { savedPositions, windowMode: next.agentWindowMode, workspaceWidth: next.agentWindowWidth, workspaceHeight: next.agentWindowHeight }).catch((error) => console.warn("Agent 窗口模式将在下次打开时应用。", error));
    }
    if (next.clipboardHistoryLimit !== previous.clipboardHistoryLimit) setClipboard((current) => { const trimmed = current.slice(0, next.clipboardHistoryLimit); saveClipboardHistory(trimmed, next.clipboardHistoryLimit); return trimmed; });
    if (next.launchAtStartup !== previous.launchAtStartup) void setLaunchAtStartup(next.launchAtStartup);
  };
  const applyWindowSize = async (width: number, height: number) => {
    const next = { ...settingsRef.current, mainWindowWidth: Math.max(760, Math.min(1440, Math.round(width))), mainWindowHeight: Math.max(620, Math.min(1000, Math.round(height))) };
    if (isTauri()) await getCurrentWindow().setSize(new LogicalSize(Math.round(next.mainWindowWidth * next.uiScale / 100), Math.round(next.mainWindowHeight * next.uiScale / 100)));
    settingsRef.current = next; setSettings(next); saveSettings(next);
  };
  const updateModes = (next: NexusMode[]) => { setModes(next); saveModes(next); };
  const runMode = async (mode: NexusMode) => {
    const closeTargets = mode.closeAppIds.map((id) => apps.find((app) => app.id === id)?.launchTarget).filter((target): target is string => Boolean(target));
    const launchApps = mode.launchAppIds.map((id) => apps.find((app) => app.id === id)).filter((app): app is NexusApp => Boolean(app));
    await runNexusMode(mode, closeTargets, launchApps.map((app) => app.launchTarget), launchApps.map((app) => app.shortcutPath ?? null));
  };
  const updateWebShortcuts = (next: WebShortcut[]) => {
    setWebShortcuts(next); saveWebShortcuts(next);
    const newest = next.find((item) => !item.icon);
    if (newest) void loadFavicon(newest.url).then((icon) => { if (!icon) return; setWebShortcuts((current) => { const updated = current.map((item) => item.id === newest.id ? { ...item, icon } : item); saveWebShortcuts(updated); return updated; }); });
  };
  const markAiUsage = (inputTokens: number, outputTokens: number, searched: boolean) => setAiUsage(recordAiUsage(inputTokens, outputTokens, searched));
  const createNewNote = () => { const note = createNote(); setNotes((current) => [note, ...current]); setActiveNoteId(note.id); transitionView("notes"); };
  const updateActiveNote = (patch: Partial<NoteRecord>) => { if (!activeNoteId) return; setNotes((current) => updateNote(current, activeNoteId, patch)); };
  const saveActiveNote = async () => { if (!activeNote) return; const filePath = await saveNoteFile(activeNote, settings.notesDirectory); if (filePath) setNotes((current) => current.map((note) => note.id === activeNote.id ? { ...note, filePath, updatedAt: Date.now() } : note)); };
  const deleteActiveNote = () => { if (!activeNote) return; const next = notes.filter((note) => note.id !== activeNote.id); setNotes(next); setActiveNoteId(next[0]?.id ?? null); };

  const handleCopyClipboard = async (text: string) => {
    internalClipboardWrite.current = text;
    await copyClipboard(text);
    window.setTimeout(() => { if (internalClipboardWrite.current === text) internalClipboardWrite.current = null; }, 2200);
  };

  const moveCategorySelection = (direction: "left" | "right" | "up" | "down") => {
    const cards = Array.from(document.querySelectorAll<HTMLElement>(".category-grid .category-card"));
    const selectedCard = cards[selected];
    if (!selectedCard || cards.length === 0) return;
    const rows: Array<{ top: number; cards: HTMLElement[] }> = [];
    cards.forEach((card) => {
      const top = Math.round(card.getBoundingClientRect().top);
      let row = rows.find((candidate) => Math.abs(candidate.top - top) <= 2);
      if (!row) { row = { top, cards: [] }; rows.push(row); }
      row.cards.push(card);
    });
    rows.sort((a, b) => a.top - b.top);
    rows.forEach((row) => row.cards.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left));
    const currentRowIndex = rows.findIndex((row) => row.cards.includes(selectedCard));
    if (currentRowIndex < 0) return;
    const currentRow = rows[currentRowIndex];
    const currentColumn = currentRow.cards.indexOf(selectedCard);
    let targetCard: HTMLElement | undefined;
    if (direction === "left" || direction === "right") {
      targetCard = currentRow.cards[currentColumn + (direction === "left" ? -1 : 1)];
    } else {
      const targetRow = rows[currentRowIndex + (direction === "up" ? -1 : 1)];
      targetCard = targetRow?.cards[Math.min(currentColumn, Math.max(0, targetRow.cards.length - 1))];
    }
    if (targetCard) setSelected(cards.indexOf(targetCard));
  };

  useEffect(() => {
    const hideOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" && event.code !== "Escape") return;
      if (event.repeat) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      imeComposingRef.current = false;
      transitionView("launcher");
      setQuery("");
      requestHideNexusWindow();
    };
    window.addEventListener("keydown", hideOnEscape, true);
    return () => window.removeEventListener("keydown", hideOnEscape, true);
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (imeComposingRef.current || event.isComposing || event.key === "Process" || event.key === "Unidentified") return;
      if (view !== "launcher") return;
      if ((event.target as HTMLElement).closest(".category-card, .quick-launch-button")) return;
      if (category !== "all" && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) { event.preventDefault(); moveCategorySelection(event.key.replace("Arrow", "").toLowerCase() as "left" | "right" | "up" | "down"); }
      if (category === "all" && event.key === "ArrowDown") { event.preventDefault(); setSelected((index) => Math.min(index + 1, Math.max(0, results.length - 1))); }
      if (category === "all" && event.key === "ArrowUp") { event.preventDefault(); setSelected((index) => Math.max(index - 1, 0)); }
      if (event.key === "Enter" && selectedApp && !(event.target as HTMLElement).closest("button")) { event.preventDefault(); handleLaunch(selectedApp); }
    };
    const handleCompositionStart = () => { imeComposingRef.current = true; };
    const handleCompositionEnd = () => { imeComposingRef.current = false; };
    const handleWindowBlur = () => { imeComposingRef.current = false; };
    window.addEventListener("keydown", handleKeyDown, true);
    document.addEventListener("compositionstart", handleCompositionStart, true);
    document.addEventListener("compositionend", handleCompositionEnd, true);
    window.addEventListener("blur", handleWindowBlur);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      document.removeEventListener("compositionstart", handleCompositionStart, true);
      document.removeEventListener("compositionend", handleCompositionEnd, true);
      window.removeEventListener("blur", handleWindowBlur);
    };
  }, [category, results.length, selectedApp, view]);

  const runContextAction = (action: () => void) => (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    action();
    setContextMenu(null);
  };
  const openContextMenu = (app: NexusApp, event: ReactMouseEvent<Element>) => { event.preventDefault(); event.stopPropagation(); setContextMenu({ app, x: event.clientX, y: event.clientY }); };
  const selectedResultId = selectedApp?.id;
  const renderRows = (items: NexusApp[], selectedId = selectedResultId) => items.map((app) => <AppRow key={app.id} app={app} selected={app.id === selectedId} onSelect={() => setSelected(results.findIndex((item) => item.id === app.id))} onLaunch={() => handleLaunch(app)} onPin={() => togglePin(app.id)} onQuickLaunch={() => toggleQuickLaunch(app.id)} isQuickLaunch={quickLaunchIds.includes(app.id)} onReclassify={() => void reclassifyApp(app)} onContextMenu={(event) => openContextMenu(app, event)} />);
  const renderCategoryCards = (items: NexusApp[], selectedId = selectedResultId) => <div className="category-grid" style={{ "--category-icon-size": `${settings.categoryIconSize}px` } as CSSProperties}>{items.map((app) => <button key={app.id} className={`category-card ${app.id === selectedId ? "is-selected" : ""}`} onClick={() => setSelected(results.findIndex((item) => item.id === app.id))} onDoubleClick={() => handleLaunch(app)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); handleLaunch(app); } }} onContextMenu={(event) => openContextMenu(app, event)} title={`双击打开 ${app.displayName ?? app.name}`}><AppIcon app={app} size={settings.categoryIconSize} /><span className="category-card-name" title={app.displayName ?? app.name}>{app.displayName ?? app.name}</span></button>)}</div>;
  const renderCategoryPage = (categoryId: string) => {
    const pageResults = categoryResults[categoryId] ?? [];
    const pagePinned = pageResults.filter((app) => app.isPinned);
    const pageUnpinned = pageResults.filter((app) => !app.isPinned);
    const pageSelectedId = pageResults[Math.min(selected, Math.max(0, pageResults.length - 1))]?.id;
    return <div className="list-area" role="listbox" aria-label={t.settings.applications}>
      {isLoading ? <div className="empty-state">{t.launcher.preparing}<span className="loading-dots">···</span></div> : pageResults.length === 0 ? <div className="empty-state"><SparkIcon size={17} /> {t.launcher.noApps}</div> : categoryId === "all" ? <>{pagePinned.length > 0 && <div className="section-label"><span>{t.launcher.pinned}</span><span className="section-count">{pagePinned.length}</span></div>}{renderRows(pagePinned, pageSelectedId)}{pageUnpinned.length > 0 && <div className="section-label all-apps-label"><span>{query ? t.launcher.matches : t.launcher.allApps}</span><span className="section-count">{pageUnpinned.length}</span></div>}{renderRows(pageUnpinned, pageSelectedId)}</> : renderCategoryCards(pageResults, pageSelectedId)}
    </div>;
  };
  const renderLauncher = () => <div className="launcher-board">
    <ClipboardPanel entries={clipboard} limit={settings.clipboardHistoryLimit} onCopy={(entry) => void handleCopyClipboard(entry.text)} />
    <section className="launcher-core" aria-label="应用主面板">
      <div className="search-wrap"><SearchIcon size={19} /><input ref={inputRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t.launcher.searchPlaceholder} aria-label={t.launcher.searchPlaceholder} autoComplete="off" spellCheck={false} /><span className="shortcut-hint">ALT <kbd>SPACE</kbd></span></div>
      <div className="category-strip"><div className="category-tabs" ref={categoryTabsRef}><span className="category-indicator" ref={categoryIndicatorRef} aria-hidden="true" />{categoryItems.map((item) => <button key={item.id} data-category={item.id} className={category === item.id ? "is-active" : ""} aria-current={category === item.id ? "page" : undefined} onClick={() => changeCategory(item.id)}>{item.label}</button>)}</div><button className="category-manage-button" onClick={() => setCategoryManagerOpen(true)}><SettingsIcon size={14} />分类管理</button><button className="add-app-strip-button" onClick={() => setCustomAppEditorOpen(true)}><InterfaceIcon name="plus" size={14} />添加应用</button></div>
      <div className="application-toolbar"><label className="filter-toggle"><span>过滤非常规软件<small>AI 辅助判断</small></span><button className={`toggle ${settings.filterUnconventionalApps ? "is-on" : ""}`} aria-pressed={settings.filterUnconventionalApps} onClick={() => void updateSettings({ ...settings, filterUnconventionalApps: !settings.filterUnconventionalApps })}><span /></button></label><button className="bulk-classify-button" disabled={bulkClassifyStatus.startsWith("正在")} onClick={() => { if (!bulkClassifyArmed) { setBulkClassifyArmed(true); setBulkClassifyStatus("准备开始 AI 全量分类，请再次点击确认"); return; } setBulkClassifyArmed(false); void reclassifyAllApps(); }}>{bulkClassifyStatus.startsWith("正在") ? "AI 分类中。" : bulkClassifyArmed ? "确认开始" : "全部 AI 分类"}</button>{bulkClassifyStatus && <span className="bulk-inline-status">{bulkClassifyStatus}</span>}</div>
      <div className="category-view-deck" ref={categoryDeckRef}>
        <div className="category-track" style={{ transform: `translate3d(${-Math.max(0, categoryItems.findIndex((item) => item.id === category)) * 100}%,0,0)` }}>
          {categoryItems.map((item) => <div key={item.id} className={`category-page${item.id === category ? " category-page-current" : ""}`} aria-hidden={item.id !== category} inert={item.id !== category}>
            {visitedCategories.includes(item.id) ? renderCategoryPage(item.id) : null}
          </div>)}
        </div>
      </div>
    </section>
    <QuickLaunchPanel apps={quickApps} onLaunch={handleLaunch} onRemove={(app) => toggleQuickLaunch(app.id)} />
    <footer className="launcher-footbar statusbar"><span><span className="status-dot" /> {t.launcher.indexed(visibleApps.length)}</span><span>单击选中 · 双击打开 <span className="status-separator">·</span> <kbd>↑</kbd><kbd>↓</kbd> {t.launcher.navigate} <span className="status-separator">·</span> <kbd>Enter</kbd> {t.launcher.open}</span></footer>
  </div>;
  const renderView = (target: View) => target === "launcher" ? renderLauncher() : target === "modes" ? <ModesPanel apps={visibleApps} modes={modes} onChange={updateModes} onRun={runMode} /> : target === "notes" ? <NotesPanel notes={notes} activeNote={activeNote} onSelect={setActiveNoteId} onNew={createNewNote} onChange={updateActiveNote} onSave={() => void saveActiveNote()} onDelete={deleteActiveNote} /> : target === "web" ? <WebShortcutPanel shortcuts={webShortcuts} onChange={updateWebShortcuts} /> : target === "ai" ? <AIPanel settings={settings} onOpenSettings={() => transitionView("settings")} onUsage={markAiUsage} /> : <SettingsPanel initialCategory={requestedSettingsCategory} settings={settings} onChange={updateSettings} onApplyWindowSize={applyWindowSize} onRefresh={() => void refreshApps()} usage={aiUsage} onTestConnection={() => testDeepSeekConnection(settings)} />;

  return <main className="shell" data-theme={settings.visualTheme} data-reduced-motion={settings.reducedMotion ? "true" : undefined} style={{ "--nexus-ui-scale": settings.uiScale / 100, "--nexus-font-scale": settings.textSize === "small" ? 0.92 : settings.textSize === "large" ? 1.12 : 1 } as CSSProperties} onContextMenu={(event) => event.preventDefault()}><section className={"nexus-window" + (isColdStart ? " is-opening" : "") + (isWindowWaking ? " is-waking" : "")} aria-label="DKN Nexus"><div className="ambient ambient-one" /><div className="ambient ambient-two" />
    <header className="topbar"><div className="window-drag-bar" data-tauri-drag-region onMouseDown={startWindowDragging}><div className="brand-lockup"><img className="brand-icon" src="/dkn-nexus-icon.png" alt="" /><span className="brand-divider" /><span className="brand-product">NEXUS</span></div><div className="topbar-actions" onMouseDown={(event) => event.stopPropagation()} onPointerDown={(event) => { event.stopPropagation(); setContextMenu(null); }}><button className="icon-button music-entry-button" aria-label="打开音乐播放器" title="音乐播放器" onClick={() => void invoke("toggle_music_window").catch((error) => console.warn("无法打开音乐播放器。", error))}><InterfaceIcon name="audio" size={16} /></button><button className={`icon-button ${isRefreshing ? "is-spinning" : ""}`} aria-label={t.launcher.refresh} onClick={() => void refreshApps(true)}><RefreshIcon /></button><button className="icon-button" aria-label={t.launcher.settings} aria-pressed={view === "settings"} onClick={() => transitionView(view === "settings" ? "launcher" : "settings")}><SettingsIcon /></button><button className="icon-button close-button" aria-label={t.launcher.hide} onPointerDown={(event) => { event.stopPropagation(); }} onClick={(event) => { event.preventDefault(); event.stopPropagation(); setContextMenu(null); requestHideNexusWindow(); }}><CloseIcon /></button></div></div><div className="main-nav-row" onMouseDown={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}><button className="agent-entry-button" onClick={() => requestAgentWorkspace(settings.agentWindowMode, settings.agentWindowWidth, settings.agentWindowHeight)}><InterfaceIcon name="agent" size={17} /><span><strong>Agent 工作台</strong><small>独立项目空间</small></span><InterfaceIcon name="arrow" size={14} /></button><nav className="view-tabs" ref={tabsRef} aria-label="主视图"><span className="view-tab-indicator" ref={tabIndicatorRef} aria-hidden="true" />{MAIN_TABS.map((tab) => <button key={tab.view} data-view={tab.view} className={view === tab.view ? "is-active" : ""} aria-current={view === tab.view ? "page" : undefined} onClick={() => transitionView(tab.view)}><InterfaceIcon name={tab.icon} size={16} /><span>{tab.label}</span></button>)}</nav></div></header>
    <div className="view-deck" ref={viewDeckRef}>
      <div className="view-track" style={{ transform: `translate3d(${-VIEW_ORDER.indexOf(view) * 100}%,0,0)` }}>
        {VIEW_ORDER.map((panel) => <div key={panel} className={`view-stage view-${panel}${panel === view ? " view-stage-current" : ""}`} aria-hidden={panel !== view} inert={panel !== view}>
          {visitedViews.includes(panel) ? renderView(panel) : null}
        </div>)}
      </div>
    </div>
    {contextMenu && createPortal(<div ref={contextMenuRef} className="context-menu" style={contextMenuPosition} onPointerDown={(event) => event.stopPropagation()}><button onPointerDown={runContextAction(() => toggleQuickLaunch(contextMenu.app.id))}>{quickLaunchIds.includes(contextMenu.app.id) ? t.launcher.removeQuickLaunch : t.launcher.addQuickLaunch}</button><button onPointerDown={runContextAction(() => openAnnotationEditor(contextMenu.app))}>添加 / 修改备注</button>{effectiveClassification(contextMenu.app, classificationOverrides, aiClassificationCache) !== "normal-app" && <button onPointerDown={runContextAction(() => markNormal(contextMenu.app.id))}>{t.launcher.markNormal}</button>}<button disabled={classifyingAppId === contextMenu.app.id} onPointerDown={runContextAction(() => void reclassifyApp(contextMenu.app))}>{classifyingAppId === contextMenu.app.id ? "AI 分类中。" : "重新 AI 分类"}</button><span className="context-label">修改分类</span>{categoryItems.filter((item) => item.id !== "all" && item.id !== "frequent").map((item) => <button key={item.id} onPointerDown={runContextAction(() => setCategoryOverride(contextMenu.app.id, item.id as AppCategory))}>{item.label}</button>)}{categoryOverrides[contextMenu.app.id] && <button onPointerDown={runContextAction(() => resetCategoryOverride(contextMenu.app.id))}>重新自动分类</button>}<button onPointerDown={runContextAction(() => removeAppEntry(contextMenu.app))}>{contextMenu.app.source === "custom" ? "删除自定义应用" : "从应用列表移除"}</button></div>, document.body)}
    <MotionPresence show={Boolean(pendingLaunch)}>{pendingLaunch && <div className="modal-backdrop"><div className="confirm-modal"><div className="eyebrow">DKN / 安全提示</div><h2>{t.launcher.confirmLaunchTitle}</h2><p>{t.launcher.confirmLaunchDescription}</p><div className="confirm-target"><AppIcon app={pendingLaunch} size={34} /><span>{pendingLaunch.name}</span></div><div className="modal-actions"><button onClick={() => setPendingLaunch(null)}>{t.launcher.cancel}</button><button className="primary-action" onClick={() => { const app = pendingLaunch; setPendingLaunch(null); void launchApp(app); }}>{t.launcher.continue}</button></div></div></div>}</MotionPresence>
    <MotionPresence show={Boolean(annotationEditor)}>{annotationEditor && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setAnnotationEditor(null); }}><section className="annotation-modal" role="dialog" aria-modal="true"><div className="settings-heading"><div><p className="eyebrow">NEXUS / 应用备注</p><h1>{annotationEditor.name}</h1></div><button className="icon-button" onClick={() => setAnnotationEditor(null)} aria-label="关闭">×</button></div><textarea className="annotation-input" autoFocus value={annotationDraft} onChange={(event) => setAnnotationDraft(event.target.value)} placeholder="输入备注，例如：显卡驱动、工作用浏览器…。" /><label className="annotation-display-choice"><input type="radio" checked={annotationDisplayMode === "original"} onChange={() => setAnnotationDisplayMode("original")} /> 显示原应用名</label><label className="annotation-display-choice"><input type="radio" checked={annotationDisplayMode === "note"} onChange={() => setAnnotationDisplayMode("note")} disabled={!annotationDraft.trim()} /> 显示备注名称</label><div className="modal-actions"><button className="quiet-button" onClick={() => setAnnotationEditor(null)}>取消</button><button className="primary-action" onClick={saveAnnotation}>保存备注</button></div></section></div>}</MotionPresence>
    {createPortal(<MotionPresence show={categoryManagerOpen}>{categoryManagerOpen && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setCategoryManagerOpen(false); }}><section className="category-manager-modal" role="dialog" aria-modal="true"><div className="settings-heading"><div><p className="eyebrow">NEXUS / 分类</p><h1>应用分类</h1></div><button className="icon-button" onClick={() => setCategoryManagerOpen(false)} aria-label="关闭">×</button></div><div className="category-create-row"><input value={newCategoryName} onChange={(event) => setNewCategoryName(event.target.value)} onKeyDown={(event) => { if (!event.nativeEvent.isComposing && event.key === "Enter") createCategory(); }} placeholder="新分类名称" /><button className="primary-action" onClick={createCategory}>新建</button></div>{userCategories.length === 0 ? <p className="panel-empty">还没有自定义分类</p> : <div className="user-category-list">{userCategories.map((item) => <div className="user-category-item" key={item.id}><span>{item.label}</span><button className="quiet-button" onClick={() => renameCategory(item)}>重命名</button><button className="quiet-button" onClick={() => deleteCategory(item)}>删除</button></div>)}</div>}</section></div>}</MotionPresence>, document.body)}
    <CustomAppPanel open={customAppEditorOpen} apps={customApps} onClose={() => setCustomAppEditorOpen(false)} onAdd={addCustomApp} onRemove={removeCustomApp} onPickFile={pickApplicationFile} />
  </section></main>;
}

function NotesPanel({ notes, activeNote, onSelect, onNew, onChange, onSave, onDelete }: { notes: NoteRecord[]; activeNote: NoteRecord | null; onSelect: (id: string) => void; onNew: () => void; onChange: (patch: Partial<NoteRecord>) => void; onSave: () => void; onDelete: () => void }) {
  return <div className="notes-panel">
    <aside className="notes-list"><div className="panel-heading"><span>记事本</span><button className="new-note-button" onClick={onNew} aria-label="新建记事"><InterfaceIcon name="plus" size={17} /></button></div>{notes.length === 0 ? <p className="panel-empty">创建一条随手记事</p> : notes.map((note) => <button className={`note-list-item ${note.id === activeNote?.id ? "is-active" : ""}`} key={note.id} onClick={() => onSelect(note.id)}><strong>{note.title || "未命名笔记"}</strong><span>{new Date(note.updatedAt).toLocaleDateString()}</span></button>)}</aside>
    <TransitionSwap transitionKey={activeNote?.id ?? "empty"} variant="selection" className="note-editor-swap">
      <section className="note-editor">{activeNote ? <><input className="note-title" value={activeNote.title} onChange={(event) => onChange({ title: event.target.value })} /><textarea className="note-content" value={activeNote.content} onChange={(event) => onChange({ content: event.target.value })} placeholder="写下此刻的想法…。" /><div className="note-toolbar"><span>{activeNote.filePath ? "已保存为 TXT" : "草稿自动保存"}</span><div><button onClick={onDelete}>删除</button><button className="primary-action" onClick={onSave}>保存 TXT</button></div></div></> : <div className="empty-state"><button className="primary-action" onClick={onNew}>新建记事</button></div>}</section>
    </TransitionSwap>
  </div>;
}

function LegacySettingsPanel({ settings, onChange, onRefresh, usage, onTestConnection }: { settings: NexusSettings; onChange: (settings: NexusSettings) => void | Promise<void>; onRefresh: () => void; usage: AiUsage; onTestConnection: () => Promise<void> }) {
  const [deepSeekKey, setDeepSeekKey] = useState(""); const [bochaKey, setBochaKey] = useState(""); const [shortcutDraft, setShortcutDraft] = useState(settings.globalShortcut); const [saved, setSaved] = useState(false); const [testing, setTesting] = useState(false); const [testResult, setTestResult] = useState("");
  const saveKeys = async () => { if (deepSeekKey.trim()) await saveSecret("deepseek-api-key", deepSeekKey.trim()); if (bochaKey.trim()) await saveSecret("bocha-api-key", bochaKey.trim()); setDeepSeekKey(""); setBochaKey(""); setSaved(true); window.setTimeout(() => setSaved(false), 1800); };
  const testConnection = async () => { setTesting(true); setTestResult(""); try { await onTestConnection(); setTestResult("连接成功"); } catch (error) { setTestResult(error instanceof Error ? error.message : "连接失败"); } finally { setTesting(false); } };
  const applyShortcut = async () => { try { await onChange({ ...settings, globalShortcut: shortcutDraft.trim() }); setTestResult("快捷键已更新"); } catch (error) { setShortcutDraft(settings.globalShortcut); setTestResult(error instanceof Error ? error.message : "快捷键注册失败"); } };
  return <div className="settings-panel"><div className="settings-heading"><div><p className="eyebrow">{t.settings.eyebrow}</p><h1>{t.settings.title}</h1></div><span className="version">v1.6.22</span></div><section className="settings-section"><div className="settings-section-title">{t.settings.general}</div><div className="settings-row"><div><div className="settings-label">{t.settings.launchAtStartup}</div><div className="settings-description">{t.settings.launchAtStartupDescription}</div></div><button className={`toggle ${settings.launchAtStartup ? "is-on" : ""}`} aria-pressed={settings.launchAtStartup} aria-label={t.settings.launchAtStartup} onClick={() => void onChange({ ...settings, launchAtStartup: !settings.launchAtStartup })}><span /></button></div><div className="settings-row"><div><div className="settings-label">{t.settings.globalShortcut}</div><div className="settings-description">输入格式：ALT+SPACE、CTRL+SHIFT+F。</div></div><div className="shortcut-editor"><input className="notes-directory-input" value={shortcutDraft} onChange={(event) => setShortcutDraft(event.target.value)} /><button className="quiet-button" onClick={() => void applyShortcut()}>应用</button></div></div><div className="settings-row"><div><div className="settings-label">AI 自动分类</div><div className="settings-description">开启后仅对本地规则低置信且信息已变化的应用调用 DeepSeek；结果缓存本地，可能消耗API 额度。</div></div><button className={`toggle ${settings.aiClassificationEnabled ? "is-on" : ""}`} aria-pressed={settings.aiClassificationEnabled} onClick={() => void onChange({ ...settings, aiClassificationEnabled: !settings.aiClassificationEnabled })}><span /></button></div><div className="settings-row"><div><div className="settings-label">游戏友好显示</div><div className="settings-description">后续用于不抢占独占全屏游戏焦点。</div></div><button className={`toggle ${settings.gameFriendlyMode ? "is-on" : ""}`} aria-pressed={settings.gameFriendlyMode} onClick={() => void onChange({ ...settings, gameFriendlyMode: !settings.gameFriendlyMode })}><span /></button></div><div className="settings-row notes-directory-row"><div><div className="settings-label">{t.settings.notesDirectory}</div><div className="settings-description">{t.settings.notesDirectoryDescription}</div></div><input className="notes-directory-input" value={settings.notesDirectory} onChange={(event) => void onChange({ ...settings, notesDirectory: event.target.value })} placeholder={t.settings.notesDirectoryPlaceholder} /></div></section><section className="settings-section"><div className="settings-section-title">AI 设置</div><div className="settings-row"><div><div className="settings-label">DeepSeek API Key</div><div className="settings-description">使用 Windows DPAPI 加密保存在本机，不写入项目文件。</div></div><input className="notes-directory-input" type="password" value={deepSeekKey} onChange={(event) => setDeepSeekKey(event.target.value)} placeholder="留空表示不修改" /></div><div className="settings-row"><div><div className="settings-label">博查 Search API Key</div><div className="settings-description">只有联网搜索时才会请求。</div></div><input className="notes-directory-input" type="password" value={bochaKey} onChange={(event) => setBochaKey(event.target.value)} placeholder="留空表示不修改" /></div><div className="settings-row"><div><div className="settings-label">模型 / API Base URL</div><div className="settings-description">DeepSeek 官方兼容 Chat Completions 接口。</div></div><div className="ai-settings-stack"><input className="notes-directory-input" value={settings.deepSeekModel} onChange={(event) => void onChange({ ...settings, deepSeekModel: event.target.value })} /><input className="notes-directory-input" value={settings.deepSeekBaseUrl} onChange={(event) => void onChange({ ...settings, deepSeekBaseUrl: event.target.value })} /></div></div><div className="settings-row"><div><button className="primary-action" onClick={() => void saveKeys()}>保存 AI 密钥</button><button className="quiet-button" disabled={testing} onClick={() => void testConnection()}>{testing ? "测试中" : "测试连接"}</button></div><span className="settings-description">{testResult || (saved ? "已保存" : `本月请求 ${usage.requestsThisMonth} 次 · 搜索 ${usage.searchCount} 次`)}</span></div></section><section className="settings-section"><div className="settings-section-title">{t.settings.applications}</div><button className="settings-action" onClick={onRefresh}><span>{t.settings.refreshApplications}</span><RefreshIcon size={15} /></button></section><section className="settings-section about-section"><div className="settings-section-title">{t.settings.about}</div><div className="about-name">DKN Nexus</div><div className="about-subtitle">Der Klang des rastlosen Nachtregens</div><div className="about-credit">{t.settings.developer}</div></section></div>;
}

function shortcutKeyToken(event: KeyboardEvent): string | null {
  const named: Record<string, string> = { Control: "CTRL", Alt: "ALT", Shift: "SHIFT", Meta: "SUPER", " ": "SPACE", Escape: "ESC", Enter: "ENTER", Tab: "TAB", Backspace: "BACKSPACE", Delete: "DELETE", Insert: "INSERT", Home: "HOME", End: "END", PageUp: "PAGEUP", PageDown: "PAGEDOWN", ArrowUp: "UP", ArrowDown: "DOWN", ArrowLeft: "LEFT", ArrowRight: "RIGHT" };
  if (named[event.key]) return named[event.key];
  if (/^Key[A-Z]$/.test(event.code)) return event.code.slice(3);
  if (/^Digit[0-9]$/.test(event.code)) return event.code.slice(5);
  if (/^F([1-9]|1[0-2])$/.test(event.key)) return event.key;
  if (event.key.length === 1 && /[A-Za-z0-9]/.test(event.key)) return event.key.toUpperCase();
  return null;
}

function shortcutDisplay(value: string): string {
  const labels: Record<string, string> = { CTRL: "Ctrl", ALT: "Alt", SHIFT: "Shift", SUPER: "Win", SPACE: "Space", ESC: "Esc", ENTER: "Enter", TAB: "Tab", BACKSPACE: "Backspace", DELETE: "Delete", INSERT: "Insert", HOME: "Home", END: "End", PAGEUP: "Page Up", PAGEDOWN: "Page Down", UP: "↑", DOWN: "↓", LEFT: "←", RIGHT: "→" };
  return value.split("+").map((part) => part.trim()).filter(Boolean).map((part) => labels[part.toUpperCase()] ?? part.toUpperCase()).join(" + ");
}

async function setNativeShortcutCapture(active: boolean): Promise<void> {
  try { const { invoke } = await import("@tauri-apps/api/core"); await invoke("set_shortcut_capture_active", { active }); } catch { /* Non-Tauri preview */ }
}

function ShortcutRecorder({ value, onSave }: { value: string; onSave: (value: string) => Promise<void> }) {
  const [recording, setRecording] = useState(false);
  const [preview, setPreview] = useState("");
  const [status, setStatus] = useState("");
  const heldKeys = useRef(new Set<string>());
  const capturedKeys = useRef(new Set<string>());
  const baseKey = useRef("");
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;

  useEffect(() => {
    if (!recording) return;
    const clearCapture = () => { heldKeys.current.clear(); capturedKeys.current.clear(); baseKey.current = ""; setPreview(""); };
    const cancel = () => { clearCapture(); setRecording(false); setStatus("录制已取消"); void setNativeShortcutCapture(false); };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && heldKeys.current.size === 0) { event.preventDefault(); cancel(); return; }
      event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation();
      const token = shortcutKeyToken(event);
      if (!token) return;
      heldKeys.current.add(event.code || event.key);
      capturedKeys.current.add(token);
      if (!["CTRL", "ALT", "SHIFT", "SUPER"].includes(token)) baseKey.current = token;
      setPreview([...capturedKeys.current].join(" + "));
    };
    const onKeyUp = (event: KeyboardEvent) => {
      event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation();
      heldKeys.current.delete(event.code || event.key);
      if (heldKeys.current.size !== 0) return;
      const keys = [...capturedKeys.current];
      const modifiers = ["CTRL", "ALT", "SHIFT", "SUPER"].filter((modifier) => keys.includes(modifier));
      if (!baseKey.current) { capturedKeys.current.clear(); setPreview(""); return; }
      if (modifiers.length === 0) { capturedKeys.current.clear(); baseKey.current = ""; setPreview(""); setStatus("快捷键需要包含 Ctrl、Alt、Shift 或 Win"); return; }
      const next = [...modifiers, baseKey.current].join("+");
      clearCapture(); setRecording(false); setStatus("正在保存。"); void setNativeShortcutCapture(false);
      void onSaveRef.current(next).then(() => setStatus("已保存")).catch((error: unknown) => setStatus(error instanceof Error ? error.message : "快捷键保存失败"));
    };
    const onWindowBlur = () => cancel();
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", onWindowBlur);
    return () => { window.removeEventListener("keydown", onKeyDown, true); window.removeEventListener("keyup", onKeyUp, true); window.removeEventListener("blur", onWindowBlur); void setNativeShortcutCapture(false); };
  }, [recording]);

  const beginRecording = async () => { setStatus(""); setPreview(""); await setNativeShortcutCapture(true); setRecording(true); };
  return <div className="shortcut-capture-wrap"><button type="button" className={`shortcut-capture ${recording ? "is-recording" : ""}`} onClick={() => void beginRecording()} aria-label="点击录制快捷键">{recording ? (preview ? `${shortcutDisplay(preview)} · 继续按键` : "按下组合键并全部松开。") : shortcutDisplay(value)}</button>{status && <small className="shortcut-capture-status">{status}</small>}</div>;
}

function SettingsPanel({ initialCategory, settings, onChange, onApplyWindowSize, onRefresh, usage, onTestConnection }: { initialCategory: SettingsCategory; settings: NexusSettings; onChange: (settings: NexusSettings) => void | Promise<void>; onApplyWindowSize: (width: number, height: number) => Promise<void>; onRefresh: () => void; usage: AiUsage; onTestConnection: () => Promise<void> }) {
  const [activeCategory, setActiveCategory] = useState<SettingsCategory>(initialCategory);
  const activeCategoryRef = useRef(activeCategory);
  activeCategoryRef.current = activeCategory;
  const settingsNavRef = useRef<HTMLElement>(null);
  const settingsBubbleRef = useRef<HTMLSpanElement>(null);
  const settingsDirectionRef = useRef<MotionDirection>("forward");
  const previousBubbleCategory = useRef(activeCategory);
  const previousContentCategory = useRef(activeCategory);
  const [systemReducedMotion, setSystemReducedMotion] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setSystemReducedMotion(preference.matches);
    preference.addEventListener("change", update);
    return () => preference.removeEventListener("change", update);
  }, []);
  const settingsContentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (initialCategory === activeCategoryRef.current) return;
    activeCategoryRef.current = initialCategory;
    setActiveCategory(initialCategory);
    settingsContentRef.current?.scrollTo({ top: 0 });
  }, [initialCategory]);
  useLayoutEffect(() => {
    const nav = settingsNavRef.current;
    if (!nav) return;
    const measure = (animate: boolean) => {
      const selected = nav.querySelector<HTMLElement>(`button[data-settings-category="${activeCategory}"]`);
      moveSelectionBubble(nav, settingsBubbleRef.current, selected, "y", animate && !settings.reducedMotion);
      previousBubbleCategory.current = activeCategory;
    };
    measure(previousBubbleCategory.current !== activeCategory);
    const observer = new ResizeObserver(() => measure(false));
    observer.observe(nav);
    return () => observer.disconnect();
  }, [activeCategory, settings.reducedMotion, settings.textSize]);
  useLayoutEffect(() => {
    if (previousContentCategory.current === activeCategory) return;
    previousContentCategory.current = activeCategory;
    if (!settings.reducedMotion) animateContentEntrance(settingsContentRef.current, settingsDirectionRef.current, 38, 350);
  }, [activeCategory, settings.reducedMotion]);
  const selectSettingsCategory = (next: SettingsCategory) => {
    if (next === activeCategoryRef.current) return;
    const direction: MotionDirection = SETTINGS_CATEGORIES.findIndex((item) => item.id === next) > SETTINGS_CATEGORIES.findIndex((item) => item.id === activeCategoryRef.current) ? "forward" : "backward";
    settingsDirectionRef.current = direction;
    settingsContentRef.current?.scrollTo({ top: 0 });
    activeCategoryRef.current = next;
    setActiveCategory(next);
  };
  const [deepSeekKey, setDeepSeekKey] = useState("");
  const [bochaKey, setBochaKey] = useState("");
  const [showDeepSeekKey, setShowDeepSeekKey] = useState(false);
  const [showBochaKey, setShowBochaKey] = useState(false);
  const [storedKeys, setStoredKeys] = useState({ deepSeek: false, bocha: false });
  const [keysLoaded, setKeysLoaded] = useState(false);
  const [quickPhrases, setQuickPhrases] = useState<ClipboardFavorite[]>(() => loadClipboardFavorites());
  const [phraseLabel, setPhraseLabel] = useState("");
  const [phraseCategory, setPhraseCategory] = useState("常用");
  const [phraseText, setPhraseText] = useState("");
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState("");
  const [windowWidthDraft, setWindowWidthDraft] = useState(settings.mainWindowWidth);
  const [windowHeightDraft, setWindowHeightDraft] = useState(settings.mainWindowHeight);
  useEffect(() => { void Promise.all([loadSecret("deepseek-api-key"), loadSecret("bocha-api-key")]).then(([deepSeek, bocha]) => { setDeepSeekKey(deepSeek); setBochaKey(bocha); setStoredKeys({ deepSeek: Boolean(deepSeek), bocha: Boolean(bocha) }); setKeysLoaded(true); }); }, []);
  const saveKeys = async () => {
    const pending: Array<Promise<"native">> = [];
    const names: string[] = [];
    if (deepSeekKey.trim()) { pending.push(saveSecret("deepseek-api-key", deepSeekKey)); names.push("deepSeek"); }
    if (bochaKey.trim()) { pending.push(saveSecret("bocha-api-key", bochaKey)); names.push("bocha"); }
    if (!pending.length) { setTestResult("请至少填写一个 API Key。"); return; }
    setTesting(true); setTestResult("");
    try {
      const results = await Promise.all(pending);
      setStoredKeys((current) => ({ ...current, ...Object.fromEntries(names.map((name, index) => [name, results[index] === "native"])) }));
      setKeysLoaded(true); setSaved(true);
      window.dispatchEvent(new Event("dkn:ai-credentials-saved"));
      setTestResult("已加密保存到本机，并已读回验证。现在退出再打开也会保留。");
      window.setTimeout(() => setSaved(false), 2600);
    } catch (error) {
      setSaved(false); setTestResult(error instanceof Error ? error.message : "API Key 保存失败。");
    } finally { setTesting(false); }
  };
  const testConnection = async () => { setTesting(true); setTestResult(""); try { await onTestConnection(); setTestResult("连接成功"); } catch (error) { setTestResult(error instanceof Error ? error.message : "连接失败"); } finally { setTesting(false); } };
  const applyShortcut = async (shortcut: string) => { try { await onChange({ ...settings, globalShortcut: shortcut }); setTestResult("全局快捷键已保存"); } catch (error) { const message = error instanceof Error ? error.message : "快捷键注册失败"; setTestResult(message); throw error; } };
  const applyRadialShortcut = async (shortcut: string) => { try { await onChange({ ...settings, radialShortcut: shortcut }); setTestResult("轮盘快捷键已保存"); } catch (error) { const message = error instanceof Error ? error.message : "快捷键注册失败"; setTestResult(message); throw error; } };
  const persistQuickPhrases = (next: ClipboardFavorite[]) => { const ordered = next.map((item, index) => ({ ...item, order: index })); setQuickPhrases(ordered); saveClipboardFavorites(ordered); };
  const addQuickPhrase = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = phraseText.trim();
    if (!text) return;
    const label = phraseLabel.trim() || text.replace(/\s+/g, " ").slice(0, 26);
    persistQuickPhrases([{ id: crypto.randomUUID(), text, label, category: phraseCategory.trim() || "常用", order: -1, updatedAt: Date.now() }, ...quickPhrases]);
    setPhraseLabel(""); setPhraseText("");
  };
  const editQuickPhrase = (id: string, patch: Partial<ClipboardFavorite>) => persistQuickPhrases(quickPhrases.map((item) => item.id === id ? { ...item, ...patch, updatedAt: Date.now() } : item));
  return <div className="settings-panel"><div className="settings-heading"><div><p className="eyebrow">{t.settings.eyebrow}</p><h1>{t.settings.title}</h1></div><span className="version">v1.6.22</span></div>
    <div className="settings-layout"><nav className="settings-categories" ref={settingsNavRef} aria-label="设置分类"><span className="settings-category-indicator" ref={settingsBubbleRef} aria-hidden="true" />{SETTINGS_CATEGORIES.map((item) => <button key={item.id} data-settings-category={item.id} className={activeCategory === item.id ? "is-active" : ""} aria-current={activeCategory === item.id ? "page" : undefined} onClick={() => selectSettingsCategory(item.id)}><InterfaceIcon name={item.icon} size={17} /><span>{item.label}</span></button>)}</nav><div className="settings-content-frame"><div className="settings-content" ref={settingsContentRef}>
    <section className={`settings-section ${activeCategory === "appearance" ? "is-current" : ""}`}><div className="settings-section-title"><InterfaceIcon name="appearance" size={17} />外观与窗口</div>
      <div className="settings-row theme-settings-row"><div><div className="settings-label">主题风格</div><div className="settings-description">切换经典黑曜与立体玻璃材质，立即生效并自动保存。</div></div><div className="theme-choices"><button className={`theme-choice ${settings.visualTheme === "dkn" ? "is-active" : ""}`} aria-pressed={settings.visualTheme === "dkn"} onClick={() => void onChange({ ...settings, visualTheme: "dkn" })}><span className="theme-preview theme-preview-dkn"><i /><i /><i /></span><span><strong>黑曜</strong><small>克制纯黑</small></span></button><button className={`theme-choice ${settings.visualTheme === "glass" ? "is-active" : ""}`} aria-pressed={settings.visualTheme === "glass"} onClick={() => void onChange({ ...settings, visualTheme: "glass" })}><span className="theme-preview theme-preview-glass"><i /><i /><i /></span><span><strong>空间玻璃</strong><small>景深 · 3D</small></span></button></div></div>
    </section>
    <section className={`settings-section ${activeCategory === "input" ? "is-current" : ""}`}><div className="settings-section-title"><InterfaceIcon name="input" size={17} />快捷键与语音</div>
      <div className="settings-row"><div><div className="settings-label">{t.settings.globalShortcut}</div><div className="settings-description">点击录制框，按下组合键；所有按键松开后自动保存。</div></div><ShortcutRecorder value={settings.globalShortcut} onSave={applyShortcut} /></div>
      <div className="settings-row"><div><div className="settings-label">快捷轮盘</div><div className="settings-description">按住快捷键打开；Alt 单键与Windows/游戏冲突，默认使用ALT+SHIFT+SPACE。</div></div><button className={`toggle ${settings.radialEnabled ? "is-on" : ""}`} aria-pressed={settings.radialEnabled} onClick={() => void onChange({ ...settings, radialEnabled: !settings.radialEnabled })}><span /></button></div>
      <div className="settings-row"><div><div className="settings-label">轮盘触发键。</div><div className="settings-description">点击录制框后按住组合键；全部松开时自动保存，不能与主快捷键相同。</div></div><ShortcutRecorder value={settings.radialShortcut} onSave={applyRadialShortcut} /></div>
      <div className="settings-row"><div><div className="settings-label">按住时启用本地语音输入。</div><div className="settings-description">开启后按住轮盘键录音，松开后由本地 faster-whisper 转录并粘贴；音频不会上传。模型或运行环境缺失时会显示提示。</div></div><button className={`toggle ${settings.radialVoiceEnabled ? "is-on" : ""}`} aria-pressed={settings.radialVoiceEnabled} onClick={() => void onChange({ ...settings, radialVoiceEnabled: !settings.radialVoiceEnabled })}><span /></button></div>
    </section>
    <section className={`settings-section ${activeCategory === "storage" ? "is-current" : ""}`}><div className="settings-section-title"><InterfaceIcon name="storage" size={17} />存储与隐私</div>
      <div className="settings-row"><div><div className="settings-label">剪贴板历史条数</div><div className="settings-description">仅保存在本机；最多保留 100 条。</div></div><input className="clipboard-limit-input" aria-label="剪贴板历史条数" type="number" min="1" max="100" step="1" value={settings.clipboardHistoryLimit} onChange={(event) => { const value = Number(event.target.value); if (Number.isFinite(value)) void onChange({ ...settings, clipboardHistoryLimit: Math.max(1, Math.min(100, Math.floor(value))) }); }} /></div>
      <div className="settings-row notes-directory-row"><div><div className="settings-label">{t.settings.notesDirectory}</div><div className="settings-description">{t.settings.notesDirectoryDescription}</div></div><input className="notes-directory-input" value={settings.notesDirectory} onChange={(event) => void onChange({ ...settings, notesDirectory: event.target.value })} placeholder={t.settings.notesDirectoryPlaceholder} /></div>
    </section>
    <section className={`settings-section ${activeCategory === "sound" ? "is-current" : ""}`}><div className="settings-section-title"><InterfaceIcon name="audio" size={17} />声音与播放设备</div>
      <PlaybackDevicesSettings />
    </section>
    <section className={`settings-section ${activeCategory === "appearance" ? "is-current" : ""}`}><div className="settings-section-title"><InterfaceIcon name="appearance" size={17} />窗口行为</div>
      <div className="settings-row"><div><div className="settings-label">{t.settings.launchAtStartup}</div><div className="settings-description">{t.settings.launchAtStartupDescription}</div></div><button className={`toggle ${settings.launchAtStartup ? "is-on" : ""}`} aria-pressed={settings.launchAtStartup} onClick={() => void onChange({ ...settings, launchAtStartup: !settings.launchAtStartup })}><span /></button></div>
      <div className="settings-row"><div><div className="settings-label">游戏友好显示</div><div className="settings-description">后续用于不抢占独占全屏游戏焦点。</div></div><button className={`toggle ${settings.gameFriendlyMode ? "is-on" : ""}`} aria-pressed={settings.gameFriendlyMode} onClick={() => void onChange({ ...settings, gameFriendlyMode: !settings.gameFriendlyMode })}><span /></button></div>
    </section>
    <section className={`settings-section display-settings-section ${activeCategory === "appearance" ? "is-current" : ""}`}><div className="settings-section-title"><InterfaceIcon name="appearance" size={17} />显示与尺寸</div>
      <div className="settings-row"><div><div className="settings-label">整体界面缩放</div><div className="settings-description">同步放大或缩小文字、按钮和间距；立即生效并保存。</div></div><div className="range-editor"><input type="range" min="85" max="125" step="5" value={settings.uiScale} onChange={(event) => void onChange({ ...settings, uiScale: Number(event.target.value) })} /><span>{settings.uiScale}%</span></div></div>
      <div className="settings-row text-size-row"><div><div className="settings-label">文字大小</div><div className="settings-description">只调整文字，不改变窗口和控件间距；主界面与Agent 窗口同步生效。</div></div><div className="text-size-options" role="group" aria-label="文字大小">{([{ id: "small", label: "偏小", icon: "A小" }, { id: "standard", label: "标准", icon: "A" }, { id: "large", label: "偏大", icon: "A+" }] as const).map((size) => <button key={size.id} className={`text-size-option ${settings.textSize === size.id ? "is-active" : ""}`} aria-pressed={settings.textSize === size.id} onClick={() => void onChange({ ...settings, textSize: size.id })}><strong>{size.icon}</strong><span>{size.label}</span></button>)}</div></div>
    </section>
    <section className={`settings-section ${activeCategory === "agent" ? "is-current" : ""}`}><div className="settings-section-title"><InterfaceIcon name="agent" size={17} />Agent 窗口</div>
      <div className="settings-row agent-window-mode-row"><div><div className="settings-label">一体式工作台</div><div className="settings-description">项目、对话和模型工具固定在同一窗口内，面板相连；窗口大小仍可调整。</div></div><span className="settings-state">已启用</span></div>
    </section>
    <section className={`settings-section display-settings-section ${activeCategory === "appearance" ? "is-current" : ""}`}><div className="settings-section-title"><InterfaceIcon name="appearance" size={17} />窗口尺寸与动效</div>
      <div className="settings-row display-size-row"><div><div className="settings-label">主窗口大小</div><div className="settings-description">按逻辑像素设置；应用后会记住，下次启动自动恢复。</div></div><div className="window-size-editor"><label>宽<input type="number" min="760" max="1440" step="20" value={windowWidthDraft} onChange={(event) => setWindowWidthDraft(Math.max(760, Math.min(1440, Number(event.target.value) || 760)))} /></label><label>高<input type="number" min="620" max="1000" step="20" value={windowHeightDraft} onChange={(event) => setWindowHeightDraft(Math.max(620, Math.min(1000, Number(event.target.value) || 620)))} /></label><button className="primary-action" onClick={() => void onApplyWindowSize(windowWidthDraft, windowHeightDraft).then(() => setTestResult("主窗口尺寸已应用并保存。")).catch((error) => setTestResult(error instanceof Error ? error.message : "窗口尺寸应用失败"))}>应用</button></div></div>
      <div className="settings-row"><div><div className="settings-label">减少动画</div><div className="settings-description">{systemReducedMotion ? "系统已减少持续和装饰性动效；页面、分类与选中状态仍保留短促操作反馈。开启此应用的减少动画开关可关闭这些过渡。" : "关闭页面、分类、设置切换和选中状态的动效。"}</div></div><button className={"toggle " + (settings.reducedMotion ? "is-on" : "")} aria-pressed={settings.reducedMotion} onClick={() => void onChange({ ...settings, reducedMotion: !settings.reducedMotion })}><span /></button></div>
    </section>
    <section className={`settings-section ${activeCategory === "input" ? "is-current" : ""}`}><div className="settings-section-title"><InterfaceIcon name="input" size={17} />声音反馈</div>
      <div className="settings-row"><div><div className="settings-label">重要事件音效</div><div className="settings-description">仅用于待你确认、任务完成和执行错误；普通点击保持安静。</div></div><button className={"toggle " + (settings.uiSoundsEnabled ? "is-on" : "")} aria-pressed={settings.uiSoundsEnabled} onClick={() => void onChange({ ...settings, uiSoundsEnabled: !settings.uiSoundsEnabled })}><span /></button></div>
      <div className="settings-row"><div><div className="settings-label">音效音量</div><div className="settings-description">本地短音调，不下载音频文件；关闭上面的开关即可完全静音。</div></div><div className="range-editor"><input aria-label="重要事件音效音量" type="range" min="0" max="30" step="1" value={Math.round(settings.uiSoundVolume * 100)} disabled={!settings.uiSoundsEnabled} onChange={(event) => void onChange({ ...settings, uiSoundVolume: Number(event.target.value) / 100 })} /><span>{Math.round(settings.uiSoundVolume * 100)}%</span></div></div>
    </section>
    <section className={`settings-section ${activeCategory === "storage" ? "is-current" : ""}`}><div className="settings-section-title"><InterfaceIcon name="storage" size={17} />常用句</div>
      <p className="settings-description phrase-settings-help">在这里添加可重复使用的短句并设置分类；内容保存在本机，也会出现在剪贴板常用项中。</p>
      <form className="phrase-settings-form" onSubmit={addQuickPhrase}><input value={phraseLabel} onChange={(event) => setPhraseLabel(event.target.value)} placeholder="名称（可选）" /><input value={phraseCategory} onChange={(event) => setPhraseCategory(event.target.value)} placeholder="分类，例如：工作" /><textarea value={phraseText} onChange={(event) => setPhraseText(event.target.value)} placeholder="输入常用句" rows={2} /><button className="primary-action" type="submit" disabled={!phraseText.trim()}>添加常用句</button></form>
      {quickPhrases.length > 0 && <div className="phrase-settings-list">{quickPhrases.map((phrase) => <article className="phrase-settings-item" key={phrase.id}><input aria-label="常用句名称" value={phrase.label} onChange={(event) => editQuickPhrase(phrase.id, { label: event.target.value })} /><input aria-label="常用句分类" value={phrase.category} onChange={(event) => editQuickPhrase(phrase.id, { category: event.target.value || "常用" })} /><textarea aria-label="常用句内容" value={phrase.text} rows={2} onChange={(event) => editQuickPhrase(phrase.id, { text: event.target.value })} /><button className="quiet-button" onClick={() => persistQuickPhrases(quickPhrases.filter((item) => item.id !== phrase.id))}>删除</button></article>)}</div>}
    </section>
    <section className={`settings-section ${activeCategory === "account" ? "is-current" : ""}`}><div className="settings-section-title"><InterfaceIcon name="account" size={17} />账户与模型</div>
      <div className="settings-row"><div><div className="api-label-line"><div className="settings-label">DeepSeek API Key</div><span className="api-help" data-tooltip="登录 DeepSeek 开放平台，到 API Keys 页面创建密钥。密钥只显示一次，请妥善保存。">?</span><button className="api-link" onClick={() => void openWebShortcut("https://platform.deepseek.com/api_keys")}>获取 Key →</button></div><div className="settings-description">{!keysLoaded ? "检查中" : storedKeys.deepSeek ? "已加密保存在本机 · 可直接修改" : deepSeekKey ? "有未保存修改" : "尚未保存"}；仅当前 Windows 用户可解密。</div></div><div className="secret-editor"><input className="notes-directory-input" type={showDeepSeekKey ? "text" : "password"} value={deepSeekKey} onChange={(event) => { setDeepSeekKey(event.target.value); setStoredKeys((current) => ({ ...current, deepSeek: false })); }} placeholder="输入 DeepSeek Key" /><button className="quiet-button" onClick={() => setShowDeepSeekKey((value) => !value)}>{showDeepSeekKey ? "隐藏" : "显示"}</button></div></div>
      <div className="settings-row"><div><div className="api-label-line"><div className="settings-label">博查 Search API Key</div><span className="api-help" data-tooltip="登录博查 AI 开放平台，到 API Keys 页面创建密钥，用于 Nexus AI 联网搜索。">?</span><button className="api-link" onClick={() => void openWebShortcut("https://open.bochaai.com/api-keys")}>获取 Key →</button></div><div className="settings-description">{!keysLoaded ? "检查中" : storedKeys.bocha ? "已加密保存在本机 · 可直接修改" : bochaKey ? "有未保存修改" : "尚未保存"}；仅当前 Windows 用户可解密。</div></div><div className="secret-editor"><input className="notes-directory-input" type={showBochaKey ? "text" : "password"} value={bochaKey} onChange={(event) => { setBochaKey(event.target.value); setStoredKeys((current) => ({ ...current, bocha: false })); }} placeholder="输入博查 Key" /><button className="quiet-button" onClick={() => setShowBochaKey((value) => !value)}>{showBochaKey ? "隐藏" : "显示"}</button></div></div>
      <div className="settings-row"><div><div className="settings-label">模型 / API Base URL</div><div className="settings-description">默认使用 DeepSeek 官方接口。</div></div><div className="ai-settings-stack"><input className="notes-directory-input" value={settings.deepSeekModel} onChange={(event) => void onChange({ ...settings, deepSeekModel: event.target.value })} /><input className="notes-directory-input" value={settings.deepSeekBaseUrl} onChange={(event) => void onChange({ ...settings, deepSeekBaseUrl: event.target.value })} /></div></div>
      <div className="settings-row settings-save-row"><div className="settings-action-group"><button className="primary-action" disabled={testing} onClick={() => void saveKeys()}>{testing ? "正在保存中" : "保存 API Key"}</button><button className="quiet-button" disabled={testing} onClick={() => void testConnection()}>{testing ? "请稍候" : "测试连接"}</button></div><span className="settings-description">{testResult || (saved ? "保存成功：已加密写入并验证" : "填写后点击“保存 API Key”；此按钮保存上方已填写的密钥。")}</span></div>
    </section>
    <section className={`settings-section ${activeCategory === "apps" ? "is-current" : ""}`}><div className="settings-section-title"><InterfaceIcon name="apps" size={17} />{t.settings.applications}</div>
      <div className="settings-row"><div><div className="settings-label">分类图标大小</div><div className="settings-description">调整游戏、开发、办公等分类页的大图标。</div></div><div className="range-editor"><input type="range" min="40" max="88" step="2" value={settings.categoryIconSize} onChange={(event) => void onChange({ ...settings, categoryIconSize: Number(event.target.value) })} /><span>{settings.categoryIconSize}px</span></div></div>
      <button className="settings-action" onClick={onRefresh}><span>{t.settings.refreshApplications}</span><RefreshIcon size={15} /></button>
    </section><section className={`settings-section about-section ${activeCategory === "about" ? "is-current" : ""}`}><div className="settings-section-title"><InterfaceIcon name="about" size={17} />{t.settings.about}</div><div className="about-name">DKN Nexus</div><div className="about-subtitle">Der Klang des rastlosen Nachtregens</div><div className="about-credit">{t.settings.developer}</div></section>
  </div></div></div></div>;
}

