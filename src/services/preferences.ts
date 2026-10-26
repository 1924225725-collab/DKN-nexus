import type { AiChatSession, AiClassificationCacheEntry, AiUsage, AppAnnotation, AppCategory, AppClassification, ClipboardEntry, ClipboardFavorite, NexusApp, NexusMode, NexusSettings, NoteRecord, UserAppCategory, WebShortcut } from "../domain";
import { DEFAULT_SETTINGS } from "../domain";

const PINNED_KEY = "dkn-nexus:pinned";
const SETTINGS_KEY = "dkn-nexus:settings";
const QUICK_LAUNCH_KEY = "dkn-nexus:quick-launch";
const CLASSIFICATION_KEY = "dkn-nexus:classification-overrides";
const HIDDEN_APPS_KEY = "dkn-nexus:hidden-apps";
const CLIPBOARD_KEY = "dkn-nexus:clipboard-history";
const CLIPBOARD_FAVORITES_KEY = "dkn-nexus:clipboard-favorites";
const NOTES_KEY = "dkn-nexus:notes";
const CATEGORY_KEY = "dkn-nexus:category-overrides";
const WEB_SHORTCUTS_KEY = "dkn-nexus:web-shortcuts";
const AI_USAGE_KEY = "dkn-nexus:ai-usage";
const AI_SESSIONS_KEY = "dkn-nexus:ai-sessions";
const MODES_KEY = "dkn-nexus:modes";
const CUSTOM_APPS_KEY = "dkn-nexus:custom-apps";
const FILTER_V13_MIGRATION_KEY = "dkn-nexus:migrated-filter-v1.3";
const AGENT_WINDOW_SIZE_MIGRATION_KEY = "dkn-nexus:migrated-agent-window-size-v1.6.4";
const APP_ANNOTATIONS_KEY = "dkn-nexus:app-annotations";
const AI_CLASSIFICATION_CACHE_KEY = "dkn-nexus:ai-classification-cache";
const USER_CATEGORIES_KEY = "dkn-nexus:user-categories";

function read<T>(key: string, fallback: T): T {
  try { return JSON.parse(localStorage.getItem(key) ?? "null") ?? fallback; } catch { return fallback; }
}

export function loadPinnedIds(): string[] { return read<string[]>(PINNED_KEY, ["chatgpt", "vscode", "workbuddy"]); }
export function savePinnedIds(ids: string[]): void { localStorage.setItem(PINNED_KEY, JSON.stringify(ids)); }
export function loadSettings(): NexusSettings {
  const settings = { ...DEFAULT_SETTINGS, ...read<Partial<NexusSettings>>(SETTINGS_KEY, {}), searchProvider: "bocha" as const };
  settings.agentModels = { ...DEFAULT_SETTINGS.agentModels, ...(settings.agentModels ?? {}) };
  settings.agentRoleProviders = { ...DEFAULT_SETTINGS.agentRoleProviders, ...(settings.agentRoleProviders ?? {}) };
  settings.agentImageProviders = Array.isArray(settings.agentImageProviders) ? settings.agentImageProviders.filter((provider) => provider && /^[a-f0-9]{32}$/.test(provider.id) && typeof provider.name === "string" && typeof provider.endpointUrl === "string" && typeof provider.model === "string").map((provider) => ({ id: provider.id, name: provider.name.slice(0, 80), endpointUrl: provider.endpointUrl.slice(0, 2000), model: provider.model.slice(0, 160), size: typeof provider.size === "string" ? provider.size.slice(0, 80) : "1024x1024" })) : [];
  settings.agentTextProviders = Array.isArray(settings.agentTextProviders) ? settings.agentTextProviders.filter((provider) => provider && /^[a-f0-9]{32}$/.test(provider.id) && typeof provider.name === "string" && typeof provider.baseUrl === "string" && typeof provider.model === "string").map((provider) => ({ id: provider.id, name: provider.name.slice(0, 80), baseUrl: provider.baseUrl.slice(0, 2000), model: provider.model.slice(0, 160) })) : [];
  settings.agentWindowMode = "single";
  settings.textSize = settings.textSize === "small" || settings.textSize === "large" ? settings.textSize : "standard";
  settings.uiScale = Math.max(85, Math.min(125, Math.round(Number(settings.uiScale) || 100)));
  settings.reducedMotion = settings.reducedMotion === true;
  settings.uiSoundsEnabled = settings.uiSoundsEnabled === true;
  settings.uiSoundVolume = Math.max(0, Math.min(.3, Number(settings.uiSoundVolume) || 0));
  settings.mainWindowWidth = Math.max(760, Math.min(1440, Math.round(Number(settings.mainWindowWidth) || 980)));
  settings.mainWindowHeight = Math.max(620, Math.min(1000, Math.round(Number(settings.mainWindowHeight) || 680)));
  if (!localStorage.getItem(AGENT_WINDOW_SIZE_MIGRATION_KEY)) {
    if (Number(settings.agentWindowWidth) <= 1440 && Number(settings.agentWindowHeight) <= 760) {
      settings.agentWindowWidth = 1600;
      settings.agentWindowHeight = 900;
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    }
    localStorage.setItem(AGENT_WINDOW_SIZE_MIGRATION_KEY, "1");
  }
  settings.agentWindowWidth = Math.max(720, Math.round(Number(settings.agentWindowWidth) || 1600));
  settings.agentWindowHeight = Math.max(560, Math.round(Number(settings.agentWindowHeight) || 900));
  settings.clipboardHistoryLimit = Math.max(1, Math.min(100, Math.floor(Number(settings.clipboardHistoryLimit)) || 10));
  if (!localStorage.getItem(FILTER_V13_MIGRATION_KEY)) {
    settings.filterUnconventionalApps = true;
    localStorage.setItem(FILTER_V13_MIGRATION_KEY, "1");
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }
  return settings;
}
export function saveSettings(settings: NexusSettings): void { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); }

export function loadAiChatSessions(): AiChatSession[] { return read<AiChatSession[]>(AI_SESSIONS_KEY, []); }
export function saveAiChatSessions(sessions: AiChatSession[]): void { localStorage.setItem(AI_SESSIONS_KEY, JSON.stringify(sessions.slice(0, 50))); }

export function loadModes(): NexusMode[] { return read<NexusMode[]>(MODES_KEY, []); }
export function saveModes(modes: NexusMode[]): void { localStorage.setItem(MODES_KEY, JSON.stringify(modes)); }

export function loadCustomApps(): NexusApp[] { return read<NexusApp[]>(CUSTOM_APPS_KEY, []); }
export function saveCustomApps(apps: NexusApp[]): void { localStorage.setItem(CUSTOM_APPS_KEY, JSON.stringify(apps)); }

export function loadQuickLaunchIds(): string[] { return read<string[]>(QUICK_LAUNCH_KEY, []); }
export function saveQuickLaunchIds(ids: string[]): void { localStorage.setItem(QUICK_LAUNCH_KEY, JSON.stringify(ids)); }

export function loadClassificationOverrides(): Record<string, AppClassification> { return read<Record<string, AppClassification>>(CLASSIFICATION_KEY, {}); }
export function saveClassificationOverrides(overrides: Record<string, AppClassification>): void { localStorage.setItem(CLASSIFICATION_KEY, JSON.stringify(overrides)); }
export function loadHiddenAppIds(): string[] { return read<string[]>(HIDDEN_APPS_KEY, []); }
export function saveHiddenAppIds(ids: string[]): void { localStorage.setItem(HIDDEN_APPS_KEY, JSON.stringify(ids)); }
export function loadCategoryOverrides(): Record<string, AppCategory> { return read<Record<string, AppCategory>>(CATEGORY_KEY, {}); }
export function saveCategoryOverrides(overrides: Record<string, AppCategory>): void { localStorage.setItem(CATEGORY_KEY, JSON.stringify(overrides)); }
export function loadAppAnnotations(): Record<string, AppAnnotation> { return read<Record<string, AppAnnotation>>(APP_ANNOTATIONS_KEY, {}); }
export function saveAppAnnotations(annotations: Record<string, AppAnnotation>): void { localStorage.setItem(APP_ANNOTATIONS_KEY, JSON.stringify(annotations)); }
export function loadAiClassificationCache(): Record<string, AiClassificationCacheEntry> { return read<Record<string, AiClassificationCacheEntry>>(AI_CLASSIFICATION_CACHE_KEY, {}); }
export function saveAiClassificationCache(cache: Record<string, AiClassificationCacheEntry>): void { localStorage.setItem(AI_CLASSIFICATION_CACHE_KEY, JSON.stringify(cache)); }
export function loadUserAppCategories(): UserAppCategory[] { return read<UserAppCategory[]>(USER_CATEGORIES_KEY, []); }
export function saveUserAppCategories(categories: UserAppCategory[]): void { localStorage.setItem(USER_CATEGORIES_KEY, JSON.stringify(categories)); }

const safeClipboardLimit = (limit: number) => Math.max(1, Math.min(100, Math.floor(limit) || 10));
export function loadClipboardHistory(limit = 10): ClipboardEntry[] { return read<ClipboardEntry[]>(CLIPBOARD_KEY, []).slice(0, safeClipboardLimit(limit)); }
export function saveClipboardHistory(entries: ClipboardEntry[], limit = 10): void { localStorage.setItem(CLIPBOARD_KEY, JSON.stringify(entries.slice(0, safeClipboardLimit(limit)))); }
export function loadClipboardFavorites(): ClipboardFavorite[] { return read<ClipboardFavorite[]>(CLIPBOARD_FAVORITES_KEY, []).sort((a, b) => a.order - b.order || b.updatedAt - a.updatedAt); }
export function saveClipboardFavorites(favorites: ClipboardFavorite[]): void { localStorage.setItem(CLIPBOARD_FAVORITES_KEY, JSON.stringify(favorites)); }

export function loadNotes(): NoteRecord[] { return read<NoteRecord[]>(NOTES_KEY, []); }
export function saveNotes(notes: NoteRecord[]): void { localStorage.setItem(NOTES_KEY, JSON.stringify(notes)); }

export function loadWebShortcuts(): WebShortcut[] { return read<WebShortcut[]>(WEB_SHORTCUTS_KEY, []); }
export function saveWebShortcuts(shortcuts: WebShortcut[]): void { localStorage.setItem(WEB_SHORTCUTS_KEY, JSON.stringify(shortcuts)); }

function currentUsage(): AiUsage {
  const now = new Date();
  return { day: now.toISOString().slice(0, 10), month: now.toISOString().slice(0, 7), requestsToday: 0, requestsThisMonth: 0, inputTokens: 0, outputTokens: 0, searchCount: 0 };
}

export function loadAiUsage(): AiUsage {
  const fallback = currentUsage();
  const stored = read<AiUsage>(AI_USAGE_KEY, fallback);
  const now = new Date(); const day = now.toISOString().slice(0, 10); const month = now.toISOString().slice(0, 7);
  return { ...fallback, ...stored, day, month, requestsToday: stored.day === day ? stored.requestsToday : 0, requestsThisMonth: stored.month === month ? stored.requestsThisMonth : 0 };
}

export function recordAiUsage(inputTokens: number, outputTokens: number, searched: boolean): AiUsage {
  const current = loadAiUsage();
  const next = { ...current, requestsToday: current.requestsToday + 1, requestsThisMonth: current.requestsThisMonth + 1, inputTokens: current.inputTokens + Math.max(0, inputTokens), outputTokens: current.outputTokens + Math.max(0, outputTokens), searchCount: current.searchCount + (searched ? 1 : 0) };
  localStorage.setItem(AI_USAGE_KEY, JSON.stringify(next));
  return next;
}

export async function setLaunchAtStartup(enabled: boolean): Promise<void> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("set_launch_at_startup", { enabled });
  } catch {
    // Browser preview has no Windows startup registry.
  }
}

export async function setGlobalShortcut(shortcut: string): Promise<void> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("set_global_shortcut", { shortcut });
  } catch (error) {
    if (typeof window !== "undefined" && !("__TAURI_INTERNALS__" in window)) return;
    throw error;
  }
}

export async function configureRadialShortcut(shortcut: string, enabled: boolean): Promise<void> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("configure_radial_shortcut", { shortcut, enabled });
  } catch (error) {
    if (typeof window !== "undefined" && !("__TAURI_INTERNALS__" in window)) return;
    throw error;
  }
}

export async function runNexusMode(mode: NexusMode, closeTargets: string[], launchTargets: string[], launchShortcutPaths: Array<string | null>): Promise<void> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("run_nexus_mode", { closeTargets, launchTargets, launchShortcutPaths, closeAllNonSystem: mode.closeAllNonSystem });
  } catch {
    // Browser preview can still exercise the mode editor without launching processes.
  }
}
